/**
 * VOXELIA — G-buffer targets and the terrain geometry pass.
 *
 * This module owns
 *
 * * the four deferred render targets plus the sampleable depth texture
 *   (ARCHITECTURE.md 3.2),
 * * the terrain geometry programs (opaque + cutout) that consume the 32-byte
 *   terrain vertex layout of 3.1 and fill the G-buffer,
 * * the depth-only shadow variants of those programs, used by
 *   `render/shadows.js` while it renders a cascade.
 *
 * Everything the shaders need beyond the vertex stream comes from the `Frame`
 * UBO (binding 0) and three uniforms: `u_chunkOrigin` (per section),
 * `u_parallaxScale` and `u_wave` (per pass). Nothing here ever throws during a
 * frame: program builds and draw loops are wrapped, failures are logged once and
 * the pass degrades to a no-op.
 *
 * ### Texture units used
 * `0` albedo array, `1` normal+height array, `2` MRAE array (read), and
 * `3..7` for {@link GBuffer#bindForReading} (write side of the contract).
 *
 * @module render/gbuffer
 */

/**
 * Texture units the G-buffer is read from, in the order of ARCHITECTURE.md 3.5.
 * @type {Readonly<{ALBEDO:number, NORMAL:number, LIGHT:number, EXTRA:number, DEPTH:number}>}
 */
export const GBUFFER_UNITS = Object.freeze({
  ALBEDO: 3,
  NORMAL: 4,
  LIGHT: 5,
  EXTRA: 6,
  DEPTH: 7,
});

/**
 * Sampler uniform names of the five G-buffer attachments, in attachment order.
 * @type {ReadonlyArray<string>}
 */
export const GBUFFER_SAMPLERS = Object.freeze([
  'u_gAlbedo', 'u_gNormal', 'u_gLight', 'u_gExtra', 'u_gDepth',
]);

/** Texture unit of the albedo texture array (ARCHITECTURE.md 3.5). @type {number} */
const UNIT_ALBEDO_ARRAY = 0;
/** Texture unit of the normal+height texture array. @type {number} */
const UNIT_NORMAL_ARRAY = 1;
/** Texture unit of the metallic/roughness/AO/emissive texture array. @type {number} */
const UNIT_MRAE_ARRAY = 2;

/** Frame UBO binding point (ARCHITECTURE.md 3.3). @type {number} */
const FRAME_BINDING = 0;

/** Default tangent-space depth of the parallax height field, in UV units. @type {number} */
const DEFAULT_PARALLAX_SCALE = 0.045;

/**
 * Clear colour for the G-buffer: nothing lit, no material, no light.
 * @type {ReadonlyArray<number>}
 */
const GBUFFER_CLEAR_COLOR = Object.freeze([0, 0, 0, 0]);

/* ========================================================================== */
/* Shared GLSL                                                                */
/* ========================================================================== */

/**
 * Per-face orthonormal basis, indexed by the face direction byte of 3.1
 * (`0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z`).
 *
 * `VOX_FACE_T` is the world direction of increasing `a_uv.x` and `VOX_FACE_B`
 * the world direction of increasing `a_uv.y`, exactly as `world/mesher.js`
 * emits them: side faces get a downward V (`q_v = (1 - dv) * h`), the two
 * horizontal faces get `+Z` (`q_v = dv * h`). Matching the mesher here is what
 * makes both the normal maps and the parallax march come out the right way up.
 *
 * @type {string}
 */
const FACE_BASIS_GLSL = `
const vec3 VOX_FACE_N[6] = vec3[6](
  vec3( 1.0,  0.0,  0.0), vec3(-1.0,  0.0,  0.0),
  vec3( 0.0,  1.0,  0.0), vec3( 0.0, -1.0,  0.0),
  vec3( 0.0,  0.0,  1.0), vec3( 0.0,  0.0, -1.0));

const vec3 VOX_FACE_T[6] = vec3[6](
  vec3( 0.0,  0.0,  1.0), vec3( 0.0,  0.0,  1.0),
  vec3( 1.0,  0.0,  0.0), vec3( 1.0,  0.0,  0.0),
  vec3( 1.0,  0.0,  0.0), vec3( 1.0,  0.0,  0.0));

const vec3 VOX_FACE_B[6] = vec3[6](
  vec3( 0.0, -1.0,  0.0), vec3( 0.0, -1.0,  0.0),
  vec3( 0.0,  0.0,  1.0), vec3( 0.0,  0.0,  1.0),
  vec3( 0.0, -1.0,  0.0), vec3( 0.0, -1.0,  0.0));
`;

/**
 * Material flag bits of ARCHITECTURE.md 3.1 plus the foliage sway function.
 *
 * The sway displacement is a pure function of the *world* position of the
 * vertex, so two quads that share an edge always displace identically and the
 * mesh can never crack. Only the sway *weight* is per-vertex, and it is only
 * varied for cross-model plants (`WAVES` set, `PARALLAX` clear — the block
 * registry gives `RENDER.CROSS` blocks no parallax), whose quads are
 * self-contained. Leaves (`WAVES` + `PARALLAX`) translate rigidly instead.
 *
 * @type {string}
 */
const WAVE_GLSL = `
#define VOX_FLAG_WAVES    1
#define VOX_FLAG_EMISSIVE 2
#define VOX_FLAG_WET      4
#define VOX_FLAG_PARALLAX 8

/**
 * World-space wind displacement for foliage.
 * amount: 0 = pinned, 1 = full sway. rain: u_time.w.
 */
vec3 voxFoliageSway(vec3 wp, float t, float amount, float rain) {
  if (amount <= 0.0) return vec3(0.0);
  float gust = 0.66 + 0.34 * sin(t * 0.27 + (wp.x + wp.z) * 0.035);
  float strength = amount * 0.062 * gust * (1.0 + rain * 1.3);
  float phase = wp.x * 0.62 + wp.z * 0.47 + wp.y * 0.21;
  float sx = sin(t * 1.85 + phase) + 0.35 * sin(t * 4.10 + phase * 2.3);
  float sz = cos(t * 1.55 + phase * 1.27) + 0.35 * cos(t * 3.55 + phase * 1.9);
  float sy = 0.30 * sin(t * 2.90 + phase * 1.70);
  return vec3(sx, sy, sz) * strength;
}

/**
 * Sway weight of one vertex.
 * The mesher orients V downward on every vertical face and on plant planes
 * (v = 1 at the base of the block, v = 0 at its top), so 1 - v is the height of
 * this vertex inside its own block.
 */
float voxSwayWeight(int flags, vec2 uv) {
  if ((flags & VOX_FLAG_WAVES) == 0) return 0.0;
  bool plant = (flags & VOX_FLAG_PARALLAX) == 0;
  if (!plant) return 0.55;
  return clamp(1.0 - uv.y, 0.0, 1.0);
}
`;

/**
 * The terrain vertex attribute block (ARCHITECTURE.md 3.1, locations 0..5).
 * @type {string}
 */
const TERRAIN_ATTRIBUTES_GLSL = `
layout(location = 0) in vec3  a_position;
layout(location = 1) in vec2  a_uv;
layout(location = 2) in uint  a_texLayer;
layout(location = 3) in uvec2 a_faceAO;
layout(location = 4) in vec4  a_light;
layout(location = 5) in vec4  a_tint;
`;

/* -------------------------------------------------------------------------- */
/* Terrain vertex shader                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Terrain G-buffer vertex shader.
 *
 * Rebuilds the world position from `u_chunkOrigin` + the section-local
 * position, applies the foliage sway and the TAA jitter, and forwards a flat
 * face index instead of a tangent frame (the frame is rebuilt in the fragment
 * stage from the same constant table, which is exact and saves two varyings).
 *
 * @type {string}
 */
const TERRAIN_VS = `
#include <frame>
#include <math>

${TERRAIN_ATTRIBUTES_GLSL}
${WAVE_GLSL}

uniform vec3 u_chunkOrigin;
uniform float u_wave;

out vec2 v_uv;
out vec3 v_worldPos;
out vec4 v_light;
out vec4 v_tint;
flat out int v_face;
flat out int v_layer;
flat out int v_flags;

void main() {
  int flags = int(a_tint.a * 255.0 + 0.5);
  vec3 world = u_chunkOrigin + a_position;

  float weight = voxSwayWeight(flags, a_uv) * clamp(u_wave, 0.0, 4.0);
  world += voxFoliageSway(world, u_time.x, weight, u_time.w);

  v_uv = a_uv;
  v_worldPos = world;
  v_light = a_light;
  v_tint = vec4(a_tint.rgb, float(a_faceAO.y) * (1.0 / 255.0));
  v_face = int(a_faceAO.x);
  v_layer = int(a_texLayer);
  v_flags = flags;

  vec4 clip = u_viewProj * vec4(world, 1.0);
  clip.xy += u_jitter.xy * clip.w;
  gl_Position = clip;
}
`;

/* -------------------------------------------------------------------------- */
/* Terrain fragment shader                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Terrain G-buffer fragment shader.
 *
 * Defines: `OPAQUE` or `CUTOUT` (exactly one), optional `PARALLAX`.
 * Writes the four attachments of ARCHITECTURE.md 3.2 and nothing else.
 *
 * @type {string}
 */
const TERRAIN_FS = `
#include <frame>
#include <math>

${FACE_BASIS_GLSL}
${WAVE_GLSL}

uniform sampler2DArray u_albedoArray;
uniform sampler2DArray u_normalArray;
uniform sampler2DArray u_mraeArray;
uniform float u_parallaxScale;

in vec2 v_uv;
in vec3 v_worldPos;
in vec4 v_light;
in vec4 v_tint;
flat in int v_face;
flat in int v_layer;
flat in int v_flags;

layout(location = 0) out vec4 o_albedo;
layout(location = 1) out vec4 o_normal;
layout(location = 2) out vec4 o_light;
layout(location = 3) out vec4 o_extra;

// Minecraft-like falloff: every light level below 15 multiplies by 0.8. The
// curve is renormalised so level 0 lands exactly on 0 instead of 0.0352.
const float VOX_LIGHT_FLOOR = 0.035184372088832;   // pow(0.8, 15.0)
const float VOX_LIGHT_NORM  = 1.0 / (1.0 - VOX_LIGHT_FLOOR);

/** Convert normalized light levels (0..1 == level 0..15) to linear intensity. */
vec3 voxLightCurve(vec3 level01) {
  vec3 lv = clamp(level01, 0.0, 1.0) * 15.0;
  vec3 t = pow(vec3(0.8), vec3(15.0) - lv);
  return max((t - vec3(VOX_LIGHT_FLOOR)) * VOX_LIGHT_NORM, vec3(0.0));
}

/** Scalar overload of {@link voxLightCurve}, used for the sky channel. */
float voxLightCurve(float level01) {
  float lv = clamp(level01, 0.0, 1.0) * 15.0;
  float t = pow(0.8, 15.0 - lv);
  return max((t - VOX_LIGHT_FLOOR) * VOX_LIGHT_NORM, 0.0);
}

#ifdef PARALLAX
const int POM_MAX_STEPS = 24;
const int POM_MIN_STEPS = 8;
const int POM_REFINE_STEPS = 5;
const float POM_FADE_NEAR = 20.0;
const float POM_FADE_FAR = 40.0;
// Guard band that keeps a marched UV inside its own tile of a greedy quad.
const float POM_TILE_EPS = 0.001953125;   // 1/512 of a tile
const float POM_MAX_OFFSET = 0.25;

/** Height (0 at the top of the height field, 1 at the bottom) of one texel. */
float pomDepth(vec2 uv, float layer, vec2 dX, vec2 dY) {
  return 1.0 - textureGrad(u_normalArray, vec3(uv, layer), dX, dY).a;
}

/**
 * Steep parallax occlusion mapping with a binary refinement pass.
 * viewTS is the tangent-space vector from the surface toward the camera and
 * must have a positive z. Returns the displaced UV (unclamped).
 */
vec2 pomMarch(vec2 uv, vec3 viewTS, float layer, float scale, vec2 dX, vec2 dY) {
  float grazing = 1.0 - clamp(viewTS.z, 0.0, 1.0);
  int steps = int(mix(float(POM_MIN_STEPS), float(POM_MAX_STEPS), grazing) + 0.5);
  steps = clamp(steps, POM_MIN_STEPS, POM_MAX_STEPS);

  float invSteps = 1.0 / float(steps);
  vec2 total = (viewTS.xy / max(viewTS.z, 0.06)) * scale;
  vec2 stepUV = total * invSteps;

  vec2 curUV = uv;
  float curDepth = 0.0;
  float curH = pomDepth(curUV, layer, dX, dY);

  vec2 prevUV = curUV;
  float prevDepth = 0.0;

  for (int i = 0; i < POM_MAX_STEPS; ++i) {
    if (i >= steps) break;
    if (curDepth >= curH) break;
    prevUV = curUV;
    prevDepth = curDepth;
    curUV -= stepUV;
    curDepth += invSteps;
    curH = pomDepth(curUV, layer, dX, dY);
  }

  // Binary refinement between the last "above" and the first "below" sample.
  vec2 loUV = prevUV;
  vec2 hiUV = curUV;
  float loDepth = prevDepth;
  float hiDepth = curDepth;
  for (int i = 0; i < POM_REFINE_STEPS; ++i) {
    vec2 midUV = (loUV + hiUV) * 0.5;
    float midDepth = (loDepth + hiDepth) * 0.5;
    float midH = pomDepth(midUV, layer, dX, dY);
    if (midDepth < midH) {
      loUV = midUV;
      loDepth = midDepth;
    } else {
      hiUV = midUV;
      hiDepth = midDepth;
    }
  }
  return (loUV + hiUV) * 0.5;
}
#endif

void main() {
  // Derivatives of the *interpolated* UV, taken in uniform control flow so they
  // stay valid for every textureGrad below (including the parallax march).
  vec2 dX = dFdx(v_uv);
  vec2 dY = dFdy(v_uv);

  int flags = v_flags;
  bool fWaves = (flags & VOX_FLAG_WAVES) != 0;
  bool fEmissive = (flags & VOX_FLAG_EMISSIVE) != 0;
  bool fWet = (flags & VOX_FLAG_WET) != 0;
  bool fParallax = (flags & VOX_FLAG_PARALLAX) != 0;
  bool isPlant = fWaves && !fParallax;

  int face = clamp(v_face, 0, 5);
  vec3 Ng = VOX_FACE_N[face];
  vec3 T = VOX_FACE_T[face];
  vec3 B = VOX_FACE_B[face];

  vec3 toEye = u_camPos.xyz - v_worldPos;
  float viewDist = length(toEye);
  vec3 V = viewDist > 1.0e-5 ? toEye / viewDist : Ng;

  float layer = float(v_layer);
  vec2 uv = v_uv;

#ifdef PARALLAX
  if (fParallax) {
    vec3 viewTS = vec3(dot(V, T), dot(V, B), dot(V, Ng));
    float fade = 1.0 - smoothstep(POM_FADE_NEAR, POM_FADE_FAR, viewDist);
    float scale = max(u_parallaxScale, 0.0) * fade;
    if (viewTS.z > 0.06 && scale > 0.0005) {
      vec2 marched = pomMarch(v_uv, viewTS, layer, scale, dX, dY);
      vec2 offset = clamp(marched - v_uv, vec2(-POM_MAX_OFFSET), vec2(POM_MAX_OFFSET));
      // Greedy quads repeat the tile, so keep the march inside the tile the
      // fragment started in — it can never bleed into a neighbouring block.
      vec2 tile = floor(v_uv);
      uv = clamp(v_uv + offset, tile + vec2(POM_TILE_EPS), tile + vec2(1.0 - POM_TILE_EPS));
    }
  }
#endif

  vec4 alb = textureGrad(u_albedoArray, vec3(uv, layer), dX, dY);
#ifdef CUTOUT
  if (alb.a < 0.5) discard;
#endif

  vec4 nrm = textureGrad(u_normalArray, vec3(uv, layer), dX, dY);
  vec4 mrae = textureGrad(u_mraeArray, vec3(uv, layer), dX, dY);

  // Cross planes are drawn twice with opposite winding and keep their +Y face
  // normal on purpose; every other quad flips with the rasterizer.
  if (!isPlant && !gl_FrontFacing) {
    Ng = -Ng;
    B = -B;
  }

  vec3 nTS = nrm.xyz * 2.0 - 1.0;
  vec3 nWorld = T * nTS.x + B * nTS.y + Ng * nTS.z;
  vec3 N = dot(nWorld, nWorld) > 1.0e-8 ? normalize(nWorld) : Ng;

  float vertexAO = clamp(v_tint.a, 0.0, 1.0);
  float materialAO = clamp(mrae.b, 0.0, 1.0);
  float metallic = clamp(mrae.r, 0.0, 1.0);
  float roughness = clamp(mrae.g, 0.02, 1.0);

  vec3 albedo = alb.rgb * v_tint.rgb * vertexAO;

  // Wet-capable surfaces darken and smooth out while it rains, but only where
  // the sky can actually reach them.
  float rain = clamp(u_time.w, 0.0, 1.0);
  if (fWet && rain > 0.0) {
    float exposed = smoothstep(0.55, 0.95, clamp(v_light.a, 0.0, 1.0));
    float upward = clamp(Ng.y, 0.0, 1.0);
    float wet = rain * exposed * mix(0.18, 1.0, upward);
    albedo *= mix(1.0, 0.74, wet);
    roughness = mix(roughness, 0.09, wet * 0.85);
  }

  float emissive = clamp(mrae.a, 0.0, 1.0) * (fEmissive ? 1.0 : 0.35);
  float subsurface = fWaves ? (isPlant ? 1.0 : 0.7) : 0.0;

  vec3 blockLight = voxLightCurve(v_light.rgb);
  float skyLight = voxLightCurve(v_light.a);

  o_albedo = vec4(clamp(albedo, vec3(0.0), vec3(1.0)), metallic);
  o_normal = vec4(N * 0.5 + 0.5, roughness);
  o_light = vec4(blockLight, skyLight);
  o_extra = vec4(clamp(vertexAO * materialAO, 0.0, 1.0),
                 float(flags) * (1.0 / 255.0),
                 emissive,
                 subsurface);
}
`;

/* -------------------------------------------------------------------------- */
/* Shadow depth shaders                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Depth-only terrain vertex shader for the cascaded shadow pass.
 *
 * Same vertex layout and the exact same sway as {@link TERRAIN_VS}, so shadows
 * follow the swaying geometry instead of the rest pose. No TAA jitter.
 *
 * @type {string}
 */
const SHADOW_VS = `
#include <frame>
#include <math>

${TERRAIN_ATTRIBUTES_GLSL}
${WAVE_GLSL}

uniform vec3 u_chunkOrigin;
uniform mat4 u_lightViewProj;
uniform float u_wave;

out vec2 v_uv;
flat out int v_layer;

void main() {
  int flags = int(a_tint.a * 255.0 + 0.5);
  vec3 world = u_chunkOrigin + a_position;

  float weight = voxSwayWeight(flags, a_uv) * clamp(u_wave, 0.0, 4.0);
  world += voxFoliageSway(world, u_time.x, weight, u_time.w);

  v_uv = a_uv;
  v_layer = int(a_texLayer);
  gl_Position = u_lightViewProj * vec4(world, 1.0);
}
`;

/**
 * Depth-only fragment shader. The `CUTOUT` variant discards transparent texels,
 * the `OPAQUE` variant writes nothing at all.
 * @type {string}
 */
const SHADOW_FS = `
#ifdef CUTOUT
uniform sampler2DArray u_albedoArray;

in vec2 v_uv;
flat in int v_layer;

void main() {
  if (texture(u_albedoArray, vec3(v_uv, float(v_layer))).a < 0.5) discard;
}
#else
void main() {}
#endif
`;

/* ========================================================================== */
/* GBuffer                                                                    */
/* ========================================================================== */

/**
 * The deferred G-buffer plus the terrain geometry pass that fills it.
 *
 * ```js
 * const gbuffer = new GBuffer(gl, settings, textureManager);
 * gbuffer.resize(width, height);
 * gbuffer.bindForWriting();
 * gl.clear([0, 0, 0, 0], true);
 * gbuffer.renderTerrain(world, frame, { pass: 'opaque' });
 * gbuffer.renderTerrain(world, frame, { pass: 'cutout' });
 * gbuffer.bindForReading();               // units 3..7
 * ```
 */
export class GBuffer {
  /**
   * @param {import('../core/gl.js').GL} gl VOXELIA WebGL2 device.
   * @param {{get:function(string):*, on?:function(string, Function):*}} settings Live settings.
   * @param {{bindArrays:function(Object):void}|null} [textures=null] Texture
   *        manager whose arrays feed units 0/1/2. May also be supplied later
   *        with {@link GBuffer#setTextures}.
   */
  constructor(gl, settings, textures = null) {
    /** @type {import('../core/gl.js').GL} Owning device. */
    this.device = gl;
    /** @type {WebGL2RenderingContext} Raw context. */
    this.raw = gl.gl;
    /** @type {{get:function(string):*}|null} Settings source. */
    this.settings = settings || null;
    /** @type {{bindArrays:function(Object):void}|null} Procedural texture arrays. */
    this.textures = textures || null;

    /** @type {number} Current width in pixels. */
    this.width = 0;
    /** @type {number} Current height in pixels. */
    this.height = 0;

    /**
     * The four color attachments in attachment order:
     * `[albedo RGBA8, normal RGBA16F, light RGBA8, extra RGBA8]`.
     * @type {WebGLTexture[]}
     */
    this.targets = [];
    /** @type {WebGLTexture|null} `DEPTH_COMPONENT32F` depth texture (unit 7). */
    this.depth = null;
    /** @type {?Object} Framebuffer wrapper from `GL#createFramebuffer`. */
    this.framebuffer = null;

    /** @type {WebGLTexture|null} RT0 — rgb albedo, a metallic. */
    this.albedo = null;
    /** @type {WebGLTexture|null} RT1 — rgb world normal*0.5+0.5, a roughness. */
    this.normal = null;
    /** @type {WebGLTexture|null} RT2 — rgb baked voxel light, a sky light. */
    this.light = null;
    /** @type {WebGLTexture|null} RT3 — r AO, g matFlags/255, b emissive, a subsurface. */
    this.extra = null;

    /** @type {boolean} False when the framebuffer could not be completed. */
    this.ok = false;

    /**
     * Live pass statistics. Terrain counters reset automatically when a new
     * `frame.frameIndex` is seen; shadow counters reset on cascade 0.
     * @type {{drawCalls:number, triangles:number, sections:number,
     *   opaqueDrawCalls:number, cutoutDrawCalls:number,
     *   shadowDrawCalls:number, shadowTriangles:number}}
     */
    this.stats = {
      drawCalls: 0,
      triangles: 0,
      sections: 0,
      opaqueDrawCalls: 0,
      cutoutDrawCalls: 0,
      shadowDrawCalls: 0,
      shadowTriangles: 0,
    };

    /** @type {number} Tangent-space depth of the parallax height field. */
    this.parallaxScale = DEFAULT_PARALLAX_SCALE;

    /** @type {{opaque:?Object, cutout:?Object, shadowOpaque:?Object, shadowCutout:?Object}} */
    this.programs = { opaque: null, cutout: null, shadowOpaque: null, shadowCutout: null };

    /** @type {?boolean} `parallax` setting the current programs were built with. */
    this._parallaxBuilt = null;
    /** @type {boolean} True once a program build failure has been reported. */
    this._programError = false;
    /** @type {boolean} True once a draw-loop failure has been reported. */
    this._drawError = false;
    /** @type {boolean} True once a target allocation failure has been reported. */
    this._targetError = false;
    /** @type {number} Last `frame.frameIndex` the terrain counters were reset for. */
    this._statsFrame = -1;

    /** @type {number[]} Reusable draw-buffer enum list. @private */
    this._drawBuffers = [
      this.raw.COLOR_ATTACHMENT0,
      this.raw.COLOR_ATTACHMENT1,
      this.raw.COLOR_ATTACHMENT2,
      this.raw.COLOR_ATTACHMENT3,
    ];

    // ---- reusable per-draw state (no per-frame allocation) -----------------
    /** @type {?Object} Program used by the active draw callback. @private */
    this._drawProgram = null;
    /** @type {string} Mesh bucket used by the active draw callback. @private */
    this._drawBucket = 'opaque';
    /** @type {number} Draw calls issued by the active callback. @private */
    this._drawCalls = 0;
    /** @type {number} Triangles issued by the active callback. @private */
    this._drawTris = 0;

    /**
     * Reusable render-list callback; reads `_drawProgram` / `_drawBucket`.
     * @type {function(Object):void}
     * @private
     */
    this._onSection = (mesh) => this._drawSection(mesh);

    /** @type {?function(string, *, *):void} `change` listener. @private */
    this._onSettingChange = null;
    /** @type {?function():void} `preset`/`reset`/`load` listener. @private */
    this._onSettingBulk = null;
    if (this.settings && typeof this.settings.on === 'function') {
      // Never compile from inside an event: just invalidate, the next pass
      // rebuilds lazily inside its own try/catch.
      this._onSettingChange = (key) => {
        if (key === 'parallax') this._parallaxBuilt = null;
      };
      this._onSettingBulk = () => { this._parallaxBuilt = null; };
      try {
        this.settings.on('change', this._onSettingChange);
        // Presets, resets and reloads change many keys at once.
        this.settings.on('preset', this._onSettingBulk);
        this.settings.on('reset', this._onSettingBulk);
        this.settings.on('load', this._onSettingBulk);
      } catch (err) {
        console.warn('[VOXELIA] gbuffer: could not subscribe to settings changes.', err);
      }
    }

    const w = Math.max(1, this.raw.drawingBufferWidth | 0);
    const h = Math.max(1, this.raw.drawingBufferHeight | 0);
    this._createTargets(w, h);
  }

  // =========================================================================
  // Targets
  // =========================================================================

  /**
   * Allocate the four color attachments plus the depth texture.
   * @param {number} width Width in pixels.
   * @param {number} height Height in pixels.
   * @returns {boolean} `true` when the framebuffer is complete.
   * @private
   */
  _createTargets(width, height) {
    const device = this.device;
    const gl = this.raw;
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);

    this._destroyTargets();

    try {
      // RT1 needs float blending-free RGBA16F. Degrade to RGBA8 when the
      // extension is missing so the pipeline still renders (lower precision
      // normals, visible banding on smooth surfaces, but never a black screen).
      const normalFormat = device.caps.colorBufferFloat ? gl.RGBA16F : gl.RGBA8;
      if (!device.caps.colorBufferFloat && !this._targetError) {
        this._targetError = true;
        console.warn('[VOXELIA] gbuffer: EXT_color_buffer_float missing — normal target falls back to RGBA8.');
      }

      const common = { width: w, height: h, min: 'nearest', mag: 'nearest', wrap: 'clamp', mips: false };
      this.albedo = device.createTexture({ ...common, internalFormat: gl.RGBA8 });
      this.normal = device.createTexture({ ...common, internalFormat: normalFormat });
      this.light = device.createTexture({ ...common, internalFormat: gl.RGBA8 });
      this.extra = device.createTexture({ ...common, internalFormat: gl.RGBA8 });
      this.depth = device.createTexture({ ...common, internalFormat: gl.DEPTH_COMPONENT32F });

      this.targets = [this.albedo, this.normal, this.light, this.extra];
      this.framebuffer = device.createFramebuffer({
        name: 'gbuffer',
        color: this.targets,
        depth: this.depth,
        width: w,
        height: h,
        ownTextures: true,
      });
      this.width = w;
      this.height = h;
      this.ok = !!this.framebuffer && this.framebuffer.complete !== false;
      return this.ok;
    } catch (err) {
      this.ok = false;
      if (!this._targetError) {
        this._targetError = true;
        console.error('[VOXELIA] gbuffer: failed to allocate render targets.', err);
      }
      return false;
    }
  }

  /**
   * Delete the framebuffer and every texture it owns.
   * @returns {void}
   * @private
   */
  _destroyTargets() {
    if (this.framebuffer && typeof this.framebuffer.dispose === 'function') {
      try { this.framebuffer.dispose(); } catch (err) { /* already gone */ }
    }
    this.framebuffer = null;
    this.targets = [];
    this.albedo = null;
    this.normal = null;
    this.light = null;
    this.extra = null;
    this.depth = null;
    this.ok = false;
  }

  /**
   * Reallocate every attachment at a new size. Cheap no-op when unchanged.
   * @param {number} width New width in pixels.
   * @param {number} height New height in pixels.
   * @returns {boolean} `true` when a reallocation happened.
   */
  resize(width, height) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    if (w === this.width && h === this.height && this.ok) return false;
    if (!this.framebuffer) return this._createTargets(w, h);
    try {
      const changed = this.framebuffer.resize(w, h);
      this.width = this.framebuffer.width;
      this.height = this.framebuffer.height;
      this.ok = this.framebuffer.complete !== false;
      return changed;
    } catch (err) {
      if (!this._targetError) {
        this._targetError = true;
        console.error('[VOXELIA] gbuffer: resize failed, rebuilding targets.', err);
      }
      return this._createTargets(w, h);
    }
  }

  /**
   * Bind the G-buffer for rendering: framebuffer, full viewport and all four
   * draw buffers.
   * @returns {boolean} `false` when the G-buffer is unusable.
   */
  bindForWriting() {
    if (!this.framebuffer) return false;
    this.device.bindFramebuffer(this.framebuffer);
    this.raw.drawBuffers(this._drawBuffers);
    return this.ok;
  }

  /**
   * Clear the G-buffer. Colour clears to fully transparent black, depth to 1.
   * @param {boolean} [color=true] Clear the colour attachments.
   * @param {boolean} [depth=true] Clear the depth attachment.
   * @returns {void}
   */
  clear(color = true, depth = true) {
    if (!this.framebuffer) return;
    this.device.clear(color ? GBUFFER_CLEAR_COLOR : false, depth ? 1 : false);
  }

  /**
   * Bind the five attachments to consecutive texture units, in the documented
   * order `albedo, normal, light, extra, depth`.
   * @param {number} [startUnit=3] First texture unit (3 per ARCHITECTURE.md 3.5).
   * @returns {number} The unit the depth texture ended up on.
   */
  bindForReading(startUnit = 3) {
    const device = this.device;
    const target = this.raw.TEXTURE_2D;
    const base = startUnit | 0;
    device.bindTexture(base + 0, target, this.albedo);
    device.bindTexture(base + 1, target, this.normal);
    device.bindTexture(base + 2, target, this.light);
    device.bindTexture(base + 3, target, this.extra);
    device.bindTexture(base + 4, target, this.depth);
    return base + 4;
  }

  /**
   * Point a consuming program's `u_gAlbedo` … `u_gDepth` samplers at the units
   * {@link GBuffer#bindForReading} uses, binding the textures on the way.
   * @param {{setTexture:function(string, WebGLTexture, number, number=):void}} program Target program.
   * @param {number} [startUnit=3] First texture unit.
   * @returns {void}
   */
  bindSamplers(program, startUnit = 3) {
    if (!program || typeof program.setTexture !== 'function') return;
    const target = this.raw.TEXTURE_2D;
    const base = startUnit | 0;
    const texs = [this.albedo, this.normal, this.light, this.extra, this.depth];
    for (let i = 0; i < GBUFFER_SAMPLERS.length; i++) {
      program.setTexture(GBUFFER_SAMPLERS[i], texs[i], base + i, target);
    }
  }

  /**
   * Attach (or replace) the procedural texture manager whose arrays feed units
   * 0, 1 and 2.
   * @param {{bindArrays:function(Object):void}|null} textures Texture manager.
   * @returns {void}
   */
  setTextures(textures) {
    this.textures = textures || null;
  }

  // =========================================================================
  // Programs
  // =========================================================================

  /**
   * Whether parallax occlusion mapping is enabled in the settings.
   * @returns {boolean} `true` when the `parallax` setting is on.
   * @private
   */
  _wantParallax() {
    if (!this.settings || typeof this.settings.get !== 'function') return true;
    try {
      return this.settings.get('parallax') !== false;
    } catch (err) {
      return true;
    }
  }

  /**
   * Wave animation multiplier from the `waveAnimation` setting.
   * @returns {number} `1` when foliage should sway, `0` otherwise.
   * @private
   */
  _waveAmount() {
    if (!this.settings || typeof this.settings.get !== 'function') return 1;
    try {
      return this.settings.get('waveAnimation') === false ? 0 : 1;
    } catch (err) {
      return 1;
    }
  }

  /**
   * Build the four programs when they are missing or the `parallax` setting
   * changed since the last build.
   * @returns {boolean} `true` when the terrain programs are usable.
   * @private
   */
  _ensurePrograms() {
    const parallax = this._wantParallax();
    if (this.programs.opaque && this._parallaxBuilt === parallax) return true;

    this._disposePrograms();
    const device = this.device;
    try {
      this.programs.opaque = device.createProgram('terrain.opaque', TERRAIN_VS, TERRAIN_FS,
        { defines: { OPAQUE: true, PARALLAX: parallax } });
      this.programs.cutout = device.createProgram('terrain.cutout', TERRAIN_VS, TERRAIN_FS,
        { defines: { CUTOUT: true, PARALLAX: parallax } });
      this.programs.shadowOpaque = device.createProgram('terrain.shadow.opaque', SHADOW_VS, SHADOW_FS,
        { defines: { SHADOW: true, OPAQUE: true } });
      this.programs.shadowCutout = device.createProgram('terrain.shadow.cutout', SHADOW_VS, SHADOW_FS,
        { defines: { SHADOW: true, CUTOUT: true } });

      for (const key of Object.keys(this.programs)) {
        const program = this.programs[key];
        if (!program) continue;
        program.bindUBO('Frame', FRAME_BINDING);
        program.setInt('u_albedoArray', UNIT_ALBEDO_ARRAY);
        program.setInt('u_normalArray', UNIT_NORMAL_ARRAY);
        program.setInt('u_mraeArray', UNIT_MRAE_ARRAY);
      }
      this._parallaxBuilt = parallax;
      this._programError = false;
      return !!(this.programs.opaque && this.programs.opaque.program);
    } catch (err) {
      if (!this._programError) {
        this._programError = true;
        console.error('[VOXELIA] gbuffer: terrain program build failed — terrain pass disabled.', err);
      }
      this._parallaxBuilt = parallax;
      return false;
    }
  }

  /**
   * Delete every program this pass owns.
   * @returns {void}
   * @private
   */
  _disposePrograms() {
    for (const key of Object.keys(this.programs)) {
      const program = this.programs[key];
      if (program && typeof program.dispose === 'function') {
        try { program.dispose(); } catch (err) { /* already gone */ }
      }
      this.programs[key] = null;
    }
    this._parallaxBuilt = null;
  }

  // =========================================================================
  // Terrain pass
  // =========================================================================

  /**
   * Reset every statistics counter.
   * @returns {void}
   */
  resetStats() {
    const s = this.stats;
    s.drawCalls = 0;
    s.triangles = 0;
    s.sections = 0;
    s.opaqueDrawCalls = 0;
    s.cutoutDrawCalls = 0;
    s.shadowDrawCalls = 0;
    s.shadowTriangles = 0;
  }

  /**
   * Draw one bucket of one visible section mesh. Reused as the render-list
   * callback so the hot loop never allocates.
   * @param {Object} mesh Section mesh handed over by `world.iterateRenderList`.
   * @returns {void}
   * @private
   */
  _drawSection(mesh) {
    if (!mesh) return;
    const bucket = mesh[this._drawBucket];
    if (!bucket || !bucket.vao || !(bucket.indexCount > 0)) return;
    const program = this._drawProgram;
    if (!program) return;
    const gl = this.raw;
    program.setVec3('u_chunkOrigin', mesh.originX, mesh.originY, mesh.originZ);
    this.device.bindVertexArray(bucket.vao);
    gl.drawElements(gl.TRIANGLES, bucket.indexCount, gl.UNSIGNED_INT, 0);
    this._drawCalls++;
    this._drawTris += bucket.indexCount / 3;
  }

  /**
   * Render the visible terrain of one bucket into the currently bound target.
   *
   * The G-buffer must already be bound ({@link GBuffer#bindForWriting}); this
   * method only touches the depth/cull/blend state it needs.
   *
   * @param {{iterateRenderList:function(Object, Function, string=):number}} world Chunk manager.
   * @param {{camera?:{frustum?:Object}, frustum?:Object, frameIndex?:number}} frame Frame descriptor (see 5.26).
   * @param {{pass?:'opaque'|'cutout'}} [options={}] Which bucket to draw.
   * @returns {number} Draw calls issued.
   */
  renderTerrain(world, frame, options = {}) {
    const pass = options.pass === 'cutout' ? 'cutout' : 'opaque';
    if (!world || typeof world.iterateRenderList !== 'function') return 0;
    if (!this._ensurePrograms()) return 0;

    const frameIndex = frame && Number.isFinite(frame.frameIndex) ? frame.frameIndex : -1;
    if (frameIndex >= 0 && frameIndex !== this._statsFrame) {
      this._statsFrame = frameIndex;
      this.stats.drawCalls = 0;
      this.stats.triangles = 0;
      this.stats.sections = 0;
      this.stats.opaqueDrawCalls = 0;
      this.stats.cutoutDrawCalls = 0;
    }

    const program = pass === 'cutout' ? this.programs.cutout : this.programs.opaque;
    if (!program || !program.use()) return 0;

    const device = this.device;
    let drawn = 0;
    try {
      if (this.textures && typeof this.textures.bindArrays === 'function') {
        this.textures.bindArrays(program);
      }
      program.bindUBO('Frame', FRAME_BINDING);
      program.setFloat('u_parallaxScale', this.parallaxScale);
      program.setFloat('u_wave', this._waveAmount());

      device.setDepthTest(true);
      device.setDepthFunc(this.raw.LEQUAL);
      device.setDepthWrite(true);
      device.setBlend('none');
      device.setColorMask(true, true, true, true);
      // Cross models are double sided, so the cutout bucket never culls.
      device.setCull(pass === 'cutout' ? 'none' : 'back');

      this._drawProgram = program;
      this._drawBucket = pass;
      this._drawCalls = 0;
      this._drawTris = 0;

      const frustum = (frame && frame.camera && frame.camera.frustum)
        || (frame && frame.frustum) || null;
      const visible = world.iterateRenderList(frustum, this._onSection, pass);

      drawn = this._drawCalls;
      this.stats.drawCalls += drawn;
      this.stats.triangles += this._drawTris;
      this.stats.sections += Number.isFinite(visible) ? visible : 0;
      if (pass === 'cutout') this.stats.cutoutDrawCalls += drawn;
      else this.stats.opaqueDrawCalls += drawn;
    } catch (err) {
      if (!this._drawError) {
        this._drawError = true;
        console.error('[VOXELIA] gbuffer: terrain pass failed.', err);
      }
    } finally {
      this._drawProgram = null;
      this.device.bindVertexArray(null);
    }
    return drawn;
  }

  // =========================================================================
  // Shadow depth pass
  // =========================================================================

  /**
   * Resolve the light-space view-projection matrix out of whatever shape the
   * shadow mapper hands over.
   * @param {*} lightFrame Light frame descriptor or a raw 16-float matrix.
   * @param {number} cascadeIndex Cascade being rendered.
   * @returns {?ArrayLike<number>} Column-major matrix, or null when unavailable.
   * @private
   */
  _resolveLightMatrix(lightFrame, cascadeIndex) {
    if (!lightFrame) return null;
    if (lightFrame.length === 16) return lightFrame;
    const i = cascadeIndex | 0;
    const lists = [lightFrame.matrices, lightFrame.csmMatrices, lightFrame.viewProjs];
    for (const list of lists) {
      if (list && list.length > i && list[i] && list[i].length === 16) return list[i];
    }
    const singles = [lightFrame.lightViewProj, lightFrame.viewProj, lightFrame.matrix, lightFrame.csmMatrix];
    for (const m of singles) {
      if (m && m.length === 16) return m;
    }
    if (lightFrame.camera && lightFrame.camera.viewProj && lightFrame.camera.viewProj.length === 16) {
      return lightFrame.camera.viewProj;
    }
    return null;
  }

  /**
   * Resolve the culling frustum for one cascade.
   * @param {*} lightFrame Light frame descriptor.
   * @param {number} cascadeIndex Cascade being rendered.
   * @returns {?Object} Frustum with `containsAABB`, or null for "draw all".
   * @private
   */
  _resolveLightFrustum(lightFrame, cascadeIndex) {
    if (!lightFrame) return null;
    const i = cascadeIndex | 0;
    const list = lightFrame.frustums;
    if (list && list.length > i && list[i] && typeof list[i].containsAABB === 'function') return list[i];
    if (lightFrame.frustum && typeof lightFrame.frustum.containsAABB === 'function') return lightFrame.frustum;
    if (lightFrame.camera && lightFrame.camera.frustum
        && typeof lightFrame.camera.frustum.containsAABB === 'function') {
      return lightFrame.camera.frustum;
    }
    return null;
  }

  /**
   * Render terrain depth for one shadow cascade.
   *
   * The caller (`render/shadows.js`) owns the framebuffer, the cascade layer and
   * the viewport; this method only issues the geometry with colour writes off.
   * Both the opaque and the cutout bucket are drawn, the latter with the alpha
   * test so leaves and plants cast the right silhouette.
   *
   * @param {{iterateRenderList:function(Object, Function, string=):number}} world Chunk manager.
   * @param {*} lightFrame Light frame: a 16-float matrix, or an object carrying
   *        `matrices[cascadeIndex]` / `matrix` / `viewProj` plus an optional
   *        `frustums[cascadeIndex]` / `frustum`.
   * @param {number} [cascadeIndex=0] Cascade being rendered.
   * @returns {number} Draw calls issued.
   */
  renderShadowDepth(world, lightFrame, cascadeIndex = 0) {
    if (!world || typeof world.iterateRenderList !== 'function') return 0;
    if (!this._ensurePrograms()) return 0;

    const matrix = this._resolveLightMatrix(lightFrame, cascadeIndex);
    if (!matrix) return 0;

    if ((cascadeIndex | 0) <= 0) {
      this.stats.shadowDrawCalls = 0;
      this.stats.shadowTriangles = 0;
    }

    const device = this.device;
    const frustum = this._resolveLightFrustum(lightFrame, cascadeIndex);
    const wave = this._waveAmount();
    let drawn = 0;

    try {
      device.setDepthTest(true);
      device.setDepthFunc(this.raw.LEQUAL);
      device.setDepthWrite(true);
      device.setBlend('none');
      device.setColorMask(false, false, false, false);

      const buckets = [
        { name: 'opaque', program: this.programs.shadowOpaque, cull: 'back' },
        { name: 'cutout', program: this.programs.shadowCutout, cull: 'none' },
      ];

      for (const entry of buckets) {
        const program = entry.program;
        if (!program || !program.use()) continue;
        if (entry.name === 'cutout' && this.textures && typeof this.textures.bindArrays === 'function') {
          this.textures.bindArrays(program);
        }
        program.bindUBO('Frame', FRAME_BINDING);
        program.setMat4('u_lightViewProj', matrix);
        program.setFloat('u_wave', wave);
        device.setCull(entry.cull);

        this._drawProgram = program;
        this._drawBucket = entry.name;
        this._drawCalls = 0;
        this._drawTris = 0;
        world.iterateRenderList(frustum, this._onSection, 'shadow');
        drawn += this._drawCalls;
        this.stats.shadowDrawCalls += this._drawCalls;
        this.stats.shadowTriangles += this._drawTris;
      }
    } catch (err) {
      if (!this._drawError) {
        this._drawError = true;
        console.error('[VOXELIA] gbuffer: shadow depth pass failed.', err);
      }
    } finally {
      this._drawProgram = null;
      device.bindVertexArray(null);
      device.setColorMask(true, true, true, true);
    }
    return drawn;
  }

  // =========================================================================
  // Teardown
  // =========================================================================

  /**
   * Release every GPU resource and unsubscribe from the settings bus.
   * @returns {void}
   */
  dispose() {
    this._disposePrograms();
    this._destroyTargets();
    if (this.settings && typeof this.settings.off === 'function') {
      try {
        if (this._onSettingChange) this.settings.off('change', this._onSettingChange);
        if (this._onSettingBulk) {
          this.settings.off('preset', this._onSettingBulk);
          this.settings.off('reset', this._onSettingBulk);
          this.settings.off('load', this._onSettingBulk);
        }
      } catch (err) { /* bus already torn down */ }
    }
    this._onSettingChange = null;
    this._onSettingBulk = null;
    this.textures = null;
    this.width = 0;
    this.height = 0;
  }
}

export default GBuffer;
