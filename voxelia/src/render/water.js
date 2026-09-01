/**
 * VOXELIA — water surface, screen-space reflections, refraction, caustics and
 * the underwater / lava overlay (ARCHITECTURE.md 5.22).
 *
 * This is the **forward transparent pass**. It runs after the deferred
 * composite has produced the HDR scene colour and draws the `water` bucket of
 * every visible section back-to-front with the depth test on, depth writes off,
 * alpha blending on and face culling off.
 *
 * ### What the surface shader does
 *
 * * **Waves** — five summed Gerstner waves plus a value-noise FBM detail layer.
 *   The Gerstner sum displaces the *top* surface vertices (detected from the
 *   face direction byte of ARCHITECTURE.md 3.1) and provides the analytic
 *   normal; the FBM layer only perturbs the normal. Amplitude scales with wind
 *   and rain.
 * * **Refraction** — the copied scene colour (unit 14) is sampled with a UV
 *   offset derived from the surface normal and scaled by the water depth, so
 *   shallow water barely distorts. When the offset lands on a pixel that is in
 *   *front* of the water surface the offset is dropped, which removes the
 *   classic silhouette bleed.
 * * **Absorption** — the refracted colour is attenuated by
 *   `exp(-extinction * depth)` using the biome water colour carried in the
 *   vertex tint, so deep water turns dark blue-green while shallow water stays
 *   clear.
 * * **Reflection** — a screen-space raymarch against the scene depth (unit 7)
 *   with binary refinement, distance and screen-edge fades, falling back to the
 *   analytic sky (`<sky>`) refined by the sky LUT (unit 10) wherever the ray
 *   misses. Gated on `settings.ssr`.
 * * **Fresnel** — Schlick with `F0 = 0.02` blends refraction and reflection, and
 *   a sharp GGX sun highlight is added on top.
 * * **Foam** — a noisy white band where the scene depth is very close to the
 *   surface depth (shorelines, objects in the water) plus wave-crest foam.
 * * **Caustics** — an animated two-octave voronoi pattern projected onto
 *   whatever is under the water, modulated by sun visibility and depth.
 * * **Glass / ice** — everything else in the same bucket (glass, panes, ice,
 *   slime, honey, portals) branches on the material flag byte and renders as a
 *   smooth transparent surface with its own roughness instead of as water.
 *
 * ### The scene copy
 *
 * Refraction cannot read the render target it is drawing into, so this module
 * owns a **scene copy**: {@link WaterRenderer#captureScene} blits the HDR scene
 * colour *and* the scene depth into private textures. The depth is copied as
 * well so the pass never samples a texture that is still attached to the bound
 * framebuffer (a WebGL feedback loop). The copy is half resolution when
 * `settings.waterQuality` is `'low'`.
 *
 * ### Texture units (ARCHITECTURE.md 3.5)
 *
 * ```
 * 0  u_albedoArray  (optional, glass/ice)   8  u_sceneColor (copy pass source)
 * 1  u_normalArray  (optional, glass/ice)  10  u_skyLUT     (optional)
 * 2  u_mraeArray    (optional, glass/ice)  14  u_sceneCopy  (own copy)
 * 7  u_gDepth       (own depth copy)
 * ```
 *
 * Nothing in this file throws during a frame: program builds, target allocation
 * and the draw loops are wrapped, a failure is logged once and the pass turns
 * itself into a no-op.
 *
 * @module render/water
 */

/**
 * Texture units this pass uses, in the order of ARCHITECTURE.md 3.5.
 * @type {Readonly<{ALBEDO_ARRAY:number, NORMAL_ARRAY:number, MRAE_ARRAY:number,
 *   G_DEPTH:number, SCENE_COLOR:number, SKY_LUT:number, SCENE_COPY:number}>}
 */
export const WATER_UNITS = Object.freeze({
  ALBEDO_ARRAY: 0,
  NORMAL_ARRAY: 1,
  MRAE_ARRAY: 2,
  G_DEPTH: 7,
  SCENE_COLOR: 8,
  SKY_LUT: 10,
  SCENE_COPY: 14,
});

/** Frame UBO binding point (ARCHITECTURE.md 3.3). @type {number} */
export const FRAME_UBO_BINDING = 0;

/**
 * Screen-space reflection raymarch steps per `waterQuality` step.
 * `'low'` disables SSR entirely.
 * @type {Readonly<Object<string, number>>}
 */
export const SSR_STEPS = Object.freeze({ low: 0, medium: 16, high: 26, ultra: 40 });

/**
 * FBM detail octaves of the wave normal per `waterQuality` step.
 * @type {Readonly<Object<string, number>>}
 */
export const DETAIL_OCTAVES = Object.freeze({ low: 1, medium: 2, high: 3, ultra: 4 });

/**
 * Underwater god-ray raymarch steps per `waterQuality` step.
 * @type {Readonly<Object<string, number>>}
 */
export const GODRAY_STEPS = Object.freeze({ low: 0, medium: 10, high: 18, ultra: 26 });

/** Sea level fallback when the frame carries no environment (ARCHITECTURE.md 2). @type {number} */
const SEA_LEVEL = 62;

/* ========================================================================== */
/* Shared GLSL                                                                */
/* ========================================================================== */

/**
 * Vertex shader for the two fullscreen passes.
 *
 * Kept as a local copy of `core/gl.js`'s `FULLSCREEN_VS` (identical source) so
 * this module has no import-time dependency on the device module — the renderer
 * may construct `WaterRenderer` before anything else is wired up.
 * @type {string}
 */
const FULLSCREEN_VS_SOURCE = `out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * The terrain vertex attribute block (ARCHITECTURE.md 3.1, locations 0..5).
 * Byte-identical to the block `render/gbuffer.js` uses.
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

/**
 * Material flag bits of ARCHITECTURE.md 3.1.
 *
 * `world/mesher.js` ORs `WAVES` into every fluid quad and never into glass,
 * ice, slime, honey or portals, so `WAVES` is exactly "this quad is water"
 * inside the water bucket.
 * @type {string}
 */
const WATER_FLAGS_GLSL = `
#define VOX_FLAG_WAVES    1
#define VOX_FLAG_EMISSIVE 2
#define VOX_FLAG_WET      4
#define VOX_FLAG_PARALLAX 8
`;

/**
 * Per-face orthonormal basis indexed by the face direction byte of 3.1
 * (`0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z`). Matches `render/gbuffer.js` exactly
 * so tangent-space normal maps come out the same way up on glass and ice.
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
 * Gerstner wave train. Shared verbatim by the vertex and the fragment stage so
 * the displaced geometry and the analytic normal can never disagree.
 *
 * Requires `<math>` (TAU, saturate).
 * @type {string}
 */
const GERSTNER_GLSL = `
/** dir.x, dir.z (unit), wavelength in blocks, steepness 0..1. */
const vec4 VOX_WAVES[5] = vec4[5](
  vec4( 0.970143,  0.242536, 23.0, 0.58),
  vec4(-0.514496,  0.857493, 12.5, 0.47),
  vec4( 0.316228, -0.948683,  6.7, 0.39),
  vec4(-0.894427, -0.447214,  3.5, 0.29),
  vec4( 0.640184,  0.768221,  1.9, 0.21)
);

/**
 * Sum the five Gerstner waves at a world XZ position.
 *
 * @param p       world XZ of the *undisplaced* vertex
 * @param t       wave time in seconds (already scaled)
 * @param amp     amplitude scale in blocks
 * @param choppy  horizontal displacement factor, 0 = pure heightfield
 * @param disp    out: world-space displacement to add to the vertex
 * @param nrm     out: analytic surface normal (y-up, not normalized)
 */
void voxGerstner(vec2 p, float t, float amp, float choppy, out vec3 disp, out vec3 nrm) {
  vec3 d = vec3(0.0);
  vec3 n = vec3(0.0, 1.0, 0.0);
  for (int i = 0; i < 5; ++i) {
    vec4 w = VOX_WAVES[i];
    vec2 dir = normalize(w.xy);
    float k = TAU / max(w.z, 0.25);
    float a = amp * w.w / k;
    float speed = sqrt(9.81 * k) * 0.55;
    float f = k * dot(dir, p) - speed * t;
    float s = sin(f);
    float c = cos(f);
    float h = choppy * a;
    d.x += dir.x * h * c;
    d.z += dir.y * h * c;
    d.y += a * s;
    n.x -= dir.x * (k * a) * c;
    n.z -= dir.y * (k * a) * c;
    n.y -= (h * k) * s;
  }
  disp = d;
  nrm = n;
}
`;

/**
 * Value-noise FBM detail layer for the wave normal, plus its central-difference
 * slope. Requires `<math>` and `<noise>` (valueNoise3).
 * @type {string}
 */
const WAVE_DETAIL_GLSL = `
#ifndef WATER_DETAIL_OCT
#define WATER_DETAIL_OCT 3
#endif

/** Animated FBM height detail in about [-1,1]. */
float voxWaterDetail(vec2 p, float t) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  vec3 q = vec3(p * 0.55, t * 0.31);
  for (int i = 0; i < 4; ++i) {
    if (i >= WATER_DETAIL_OCT) break;
    sum += amp * (valueNoise3(q) * 2.0 - 1.0);
    norm += amp;
    q = vec3(q.xy * 2.13 + vec2(13.71, 7.33), q.z * 1.63 + 3.17);
    amp *= 0.55;
  }
  return sum / max(norm, 1.0e-5);
}

/** Central-difference XZ slope of {@link voxWaterDetail}. */
vec2 voxWaterDetailSlope(vec2 p, float t) {
  const float e = 0.45;
  float h0 = voxWaterDetail(p, t);
  float hx = voxWaterDetail(p + vec2(e, 0.0), t);
  float hz = voxWaterDetail(p + vec2(0.0, e), t);
  return vec2(h0 - hx, h0 - hz) / e;
}
`;

/**
 * Animated two-octave voronoi caustics. Requires `<math>` (hash22, TAU).
 * @type {string}
 */
const CAUSTIC_GLSL = `
/** Distance to the nearest animated feature point of one voronoi octave. */
float voxCausticCell(vec2 p, float t) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float best = 8.0;
  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash22(ip + g);
      vec2 pt = g + 0.5 + 0.42 * sin(t + TAU * o);
      vec2 r = pt - fp;
      best = min(best, dot(r, r));
    }
  }
  return sqrt(best);
}

/** Caustic intensity in [0,1]: bright ridges where cells meet. */
float voxCaustics(vec2 p, float t) {
  float a = voxCausticCell(p, t);
  float b = voxCausticCell(p * 1.73 + vec2(31.7, 11.3), t * 1.27 + 2.1);
  float ca = pow(saturate(1.0 - a), 7.0);
  float cb = pow(saturate(1.0 - b), 7.0);
  return saturate(ca + cb * 0.75);
}
`;

/**
 * Depth-copy encode/decode. The copy is `R32F` where `EXT_color_buffer_float`
 * is available and an `RGBA8` packing of the window-space depth otherwise.
 * @type {string}
 */
const DEPTH_CODEC_GLSL = `
#ifdef DEPTH_RGBA8
/** Pack a window-space depth in [0,1] into RGBA8. */
vec4 voxPackDepth(float d) {
  vec4 e = vec4(1.0, 255.0, 65025.0, 16581375.0) * clamp(d, 0.0, 1.0);
  e = fract(e);
  e -= e.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  return e;
}
/** Inverse of {@link voxPackDepth}. */
float voxUnpackDepth(vec4 e) {
  return dot(e, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}
#endif
`;

/**
 * `voxSceneDepth(uv)` — read the copied window-space scene depth. Must be
 * pasted **after** the `u_gDepth` declaration.
 * @type {string}
 */
const DEPTH_FETCH_GLSL = `
/** Window-space depth of the copied scene at a screen uv. */
float voxSceneDepth(vec2 uv) {
#ifdef DEPTH_RGBA8
  return voxUnpackDepth(texture(u_gDepth, clamp(uv, vec2(0.0), vec2(1.0))));
#else
  return texture(u_gDepth, clamp(uv, vec2(0.0), vec2(1.0))).r;
#endif
}
`;

/* -------------------------------------------------------------------------- */
/* Scene copy program                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Fragment shader of the scene copy: one MRT pass that writes the HDR colour
 * into attachment 0 and the encoded depth into attachment 1.
 * @type {string}
 */
const COPY_FS = `
#include <math>

${DEPTH_CODEC_GLSL}

uniform sampler2D u_sceneColor;   // unit 8  — source HDR scene colour
uniform sampler2D u_srcDepth;     // unit 7  — source depth attachment
/** x > 0.5 when a real depth attachment was supplied. */
uniform vec4 u_copyParams;

in vec2 v_uv;

layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_depth;

void main() {
  o_color = vec4(max(texture(u_sceneColor, v_uv).rgb, vec3(0.0)), 1.0);
  float d = u_copyParams.x > 0.5 ? clamp(texture(u_srcDepth, v_uv).r, 0.0, 1.0) : 1.0;
#ifdef DEPTH_RGBA8
  o_depth = voxPackDepth(d);
#else
  o_depth = vec4(d, 0.0, 0.0, 1.0);
#endif
}
`;

/* -------------------------------------------------------------------------- */
/* Water surface vertex shader                                                */
/* -------------------------------------------------------------------------- */

/**
 * Water / glass surface vertex shader.
 *
 * Rebuilds the world position from `u_chunkOrigin` + the section-local position
 * and displaces the fluid *surface* vertices with the Gerstner sum. A vertex
 * belongs to the surface when it sits on a `+Y` face, or when it is the raised
 * top edge of a fluid side face (`fract(localY) > 0`, because `world/mesher.js`
 * puts side-face bottoms exactly on integer Y). The displacement is a pure
 * function of the undisplaced world XZ, so neighbouring quads — and even
 * neighbouring sections — can never crack apart.
 *
 * @type {string}
 */
const WATER_VS = `
#include <frame>
#include <math>

${TERRAIN_ATTRIBUTES_GLSL}
${WATER_FLAGS_GLSL}
${GERSTNER_GLSL}

uniform vec3 u_chunkOrigin;
/** x amplitude (blocks), y choppiness, z time scale, w detail strength. */
uniform vec4 u_waveParams;

out vec3 v_worldPos;
out vec3 v_basePos;
out vec2 v_uv;
out vec4 v_light;
out vec4 v_tint;
flat out int v_face;
flat out int v_layer;
flat out int v_flags;

void main() {
  int flags = int(a_tint.a * 255.0 + 0.5);
  int face = int(a_faceAO.x);
  vec3 base = u_chunkOrigin + a_position;
  vec3 world = base;

  bool isWater = (flags & VOX_FLAG_WAVES) != 0;
  if (isWater && u_waveParams.x > 0.0) {
    float surface = 0.0;
    if (face == 2) surface = 1.0;
    else if (face != 3) surface = step(0.0009, fract(a_position.y));
    if (surface > 0.0) {
      vec3 disp;
      vec3 nrm;
      voxGerstner(base.xz, u_time.x * u_waveParams.z, u_waveParams.x, u_waveParams.y, disp, nrm);
      world += disp * surface;
    }
  }

  v_worldPos = world;
  v_basePos = base;
  v_uv = a_uv;
  v_light = a_light;
  v_tint = vec4(a_tint.rgb, float(a_faceAO.y) * (1.0 / 255.0));
  v_face = face;
  v_layer = int(a_texLayer);
  v_flags = flags;

  vec4 clip = u_viewProj * vec4(world, 1.0);
  clip.xy += u_jitter.xy * clip.w;
  gl_Position = clip;
}
`;

/* -------------------------------------------------------------------------- */
/* Water surface fragment shader                                              */
/* -------------------------------------------------------------------------- */

/**
 * Water / glass surface fragment shader.
 *
 * Defines: `WATER_SSR` (screen-space reflections), `WATER_CAUSTICS`,
 * `WATER_FOAM`, `USE_SKY_LUT`, `USE_TEXTURE_ARRAYS`, `WATER_DETAIL_OCT`,
 * `WATER_SSR_STEPS`, `DEPTH_RGBA8`.
 *
 * Writes a single HDR colour with an alpha the forward pass blends with.
 * @type {string}
 */
const WATER_FS = `
#include <frame>
#include <math>
#include <noise>
#include <depth>
#include <pbr>
#include <fog>
#include <sky>

${WATER_FLAGS_GLSL}
${FACE_BASIS_GLSL}
${GERSTNER_GLSL}
${WAVE_DETAIL_GLSL}
${CAUSTIC_GLSL}
${DEPTH_CODEC_GLSL}

uniform sampler2D u_gDepth;      // unit 7  — copied scene depth
uniform sampler2D u_sceneCopy;   // unit 14 — copied HDR scene colour
#ifdef USE_SKY_LUT
uniform sampler2D u_skyLUT;      // unit 10
#endif
#ifdef USE_TEXTURE_ARRAYS
uniform sampler2DArray u_albedoArray;   // unit 0
uniform sampler2DArray u_normalArray;   // unit 1
uniform sampler2DArray u_mraeArray;     // unit 2
#endif

/** x amplitude (blocks), y choppiness, z time scale, w detail strength. */
uniform vec4 u_waveParams;
/** x normal gain, y refraction strength, z foam width (blocks), w caustic strength. */
uniform vec4 u_waterParams;
/** x caustic world scale, y specular clamp, z shallow fade, w minimum opacity. */
uniform vec4 u_waterParams2;
/** rgb extinction per block, w maximum depth considered. */
uniform vec4 u_absorb;
/** rgb in-scatter colour, w strength. */
uniform vec4 u_scatter;
/** x thickness, y max distance, z intensity, w jitter. */
uniform vec4 u_ssrParams;
/** x base alpha, y refraction scale, z minimum roughness, w tint strength. */
uniform vec4 u_glassParams;
/** x LUT mix, y LUT scale, z spare, w spare. */
uniform vec4 u_skyLutParams;

in vec3 v_worldPos;
in vec3 v_basePos;
in vec2 v_uv;
in vec4 v_light;
in vec4 v_tint;
flat in int v_face;
flat in int v_layer;
flat in int v_flags;

layout(location = 0) out vec4 o_color;

${DEPTH_FETCH_GLSL}

/** Sky radiance for a world direction, refined with the sky LUT when present. */
vec3 voxSkyRadiance(vec3 dir) {
  vec3 c = analyticSky(dir);
#ifdef USE_SKY_LUT
  vec3 d = safeNormalize(dir);
  vec2 lutUv = vec2(atan(d.z, d.x) * (1.0 / TAU) + 0.5,
                    sqrt(saturate(d.y * 0.5 + 0.5)));
  c = mix(c, texture(u_skyLUT, lutUv).rgb * max(u_skyLutParams.y, 0.0),
          saturate(u_skyLutParams.x));
#endif
  return max(c + sunDiskColor(dir) * 0.30, vec3(0.0));
}

#ifdef WATER_SSR
#ifndef WATER_SSR_STEPS
#define WATER_SSR_STEPS 26
#endif

/**
 * Screen-space reflection raymarch with binary refinement.
 *
 * Marches in world space and reprojects every step: for a standard perspective
 * matrix clip.w is exactly the positive view-space distance, which is what
 * linearizeDepth() returns, so the two are directly comparable.
 *
 * @returns rgb = reflected colour, a = confidence (0 = missed)
 */
vec4 voxTraceSSR(vec3 origin, vec3 dir, float jitter) {
  float maxDist = max(u_ssrParams.y, 1.0);
  float stepLen = maxDist / float(WATER_SSR_STEPS);
  float thickness = max(u_ssrParams.x, 0.05);

  vec3 lo = origin;
  vec3 hi = origin;
  bool hit = false;

  for (int i = 0; i < WATER_SSR_STEPS; ++i) {
    vec3 next = origin + dir * (stepLen * (float(i) + jitter + 1.0));
    vec4 clip = u_viewProj * vec4(next, 1.0);
    if (clip.w <= 1.0e-4) break;
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float sceneD = voxSceneDepth(uv);
    if (sceneD < 0.9999995) {
      float sceneZ = linearizeDepth(sceneD);
      float rayZ = clip.w;
      if (rayZ > sceneZ && (rayZ - sceneZ) < (thickness + stepLen)) {
        lo = origin + dir * (stepLen * (float(i) + jitter));
        hi = next;
        hit = true;
        break;
      }
    }
  }

  if (!hit) return vec4(0.0);

  for (int i = 0; i < 6; ++i) {
    vec3 mid = (lo + hi) * 0.5;
    vec4 clip = u_viewProj * vec4(mid, 1.0);
    float w = max(clip.w, 1.0e-4);
    vec2 uv = clip.xy / w * 0.5 + 0.5;
    float sceneZ = linearizeDepth(voxSceneDepth(uv));
    if (w > sceneZ) hi = mid; else lo = mid;
  }

  vec4 clip = u_viewProj * vec4(hi, 1.0);
  float w = max(clip.w, 1.0e-4);
  vec2 uv = clip.xy / w * 0.5 + 0.5;
  vec2 edge = smoothstep(vec2(0.0), vec2(0.10), uv) *
              (vec2(1.0) - smoothstep(vec2(0.90), vec2(1.0), uv));
  float fade = edge.x * edge.y;
  fade *= 1.0 - saturate(distance(hi, origin) / maxDist);
  fade = saturate(fade) * saturate(u_ssrParams.z);
  if (fade <= 0.0) return vec4(0.0);
  return vec4(max(texture(u_sceneCopy, clamp(uv, vec2(0.0), vec2(1.0))).rgb, vec3(0.0)), fade);
}
#endif

void main() {
  int flags = v_flags;
  bool isWater = (flags & VOX_FLAG_WAVES) != 0;
  int face = clamp(v_face, 0, 5);

  vec3 Ng = VOX_FACE_N[face];
  vec3 T = VOX_FACE_T[face];
  vec3 B = VOX_FACE_B[face];

  vec3 toEye = u_camPos.xyz - v_worldPos;
  float viewDist = max(length(toEye), 1.0e-4);
  vec3 V = toEye / viewDist;

  vec2 uv = clamp(gl_FragCoord.xy * u_screen.zw, vec2(0.0), vec2(1.0));
  float surfDist = linearizeDepth(gl_FragCoord.z);
  float centerDepth = voxSceneDepth(uv);
  bool centerSky = centerDepth >= 0.9999995;
  float centerDist = centerSky ? u_camDir.w : linearizeDepth(centerDepth);
  float waterDepth = max(centerDist - surfDist, 0.0);

  float skyLight = saturate(v_light.a);
  float rain = saturate(u_time.w);
  float waveTime = u_time.x * u_waveParams.z;

  /* ---- surface normal --------------------------------------------------- */
  vec3 N = Ng;
  float roughness = 0.02;
  float texAlpha = 1.0;
  vec3 baseTint = clamp(v_tint.rgb, vec3(0.0), vec3(1.0));
  vec3 glassAlbedo = vec3(0.92, 0.96, 1.0);

  if (isWater) {
    vec3 gDisp;
    vec3 gN;
    voxGerstner(v_basePos.xz, waveTime, u_waveParams.x, u_waveParams.y, gDisp, gN);
    vec2 slope = voxWaterDetailSlope(v_basePos.xz, waveTime) * u_waveParams.w;
    float gain = max(u_waterParams.x, 0.0);
    vec3 wn = safeNormalize(vec3(gN.x * gain + slope.x, 1.0, gN.z * gain + slope.y));
    if (face == 2) N = wn;
    else if (face == 3) N = vec3(0.0, -1.0, 0.0);
    else N = safeNormalize(Ng + vec3(wn.x, 0.0, wn.z) * 0.35);
    roughness = clamp(0.028 + rain * 0.055, 0.02, 0.35);
  } else {
#ifdef USE_TEXTURE_ARRAYS
    float layer = float(v_layer);
    vec4 alb = texture(u_albedoArray, vec3(v_uv, layer));
    vec4 nrm = texture(u_normalArray, vec3(v_uv, layer));
    vec4 mrae = texture(u_mraeArray, vec3(v_uv, layer));
    glassAlbedo = alb.rgb;
    texAlpha = clamp(alb.a, 0.0, 1.0);
    roughness = clamp(mrae.g, max(u_glassParams.z, 0.01), 1.0);
    vec3 nTS = nrm.xyz * 2.0 - 1.0;
    vec3 nWorld = T * nTS.x + B * nTS.y + Ng * nTS.z;
    N = dot(nWorld, nWorld) > 1.0e-8 ? normalize(nWorld) : Ng;
#else
    roughness = clamp(u_glassParams.z, 0.01, 1.0);
    N = Ng;
#endif
  }

  bool underside = (face == 2) && !gl_FrontFacing;
  vec3 Nflat = gl_FrontFacing ? Ng : -Ng;
  if (!gl_FrontFacing) N = -N;

  // Bend a back-facing wave normal toward the eye instead of shading garbage.
  float NoV = dot(N, V);
  if (NoV < 0.02) {
    N = safeNormalize(N - V * (NoV - 0.02));
    NoV = max(dot(N, V), 0.02);
  }
  NoV = clamp(NoV, 0.02, 1.0);

  bool fromBelow = underside || (u_params.w > 0.5);

  /* ---- refraction ------------------------------------------------------- */
  float depthFade = saturate(waterDepth * max(u_waterParams2.z, 0.01));
  float refractAmount = isWater
    ? u_waterParams.y * depthFade
    : u_glassParams.y * (0.25 + saturate(roughness * 4.0));
  // Only the *perturbation* of the normal bends the ray, so a flat surface seen
  // at a grazing angle does not smear the whole screen.
  vec3 viewPerturb = mat3(u_view) * (N - Nflat);
  // The projection squashes Y by the aspect ratio, so undo it here.
  float aspect = u_screen.x * max(u_screen.w, 1.0e-6);
  vec2 offset = viewPerturb.xy * refractAmount * vec2(1.0, aspect);

  vec2 refractUV = clamp(uv + offset, vec2(0.0), vec2(1.0));
  float refractDepth = voxSceneDepth(refractUV);
  bool refractSky = refractDepth >= 0.9999995;
  float refractDist = refractSky ? u_camDir.w : linearizeDepth(refractDepth);
  // Classic bleeding fix: reject a sample that sits in front of the surface.
  if (refractDist < surfDist) {
    refractUV = uv;
    refractDepth = centerDepth;
    refractSky = centerSky;
    refractDist = centerDist;
  }
  float refractedDepth = max(refractDist - surfDist, 0.0);

  vec3 sceneColor = max(texture(u_sceneCopy, refractUV).rgb, vec3(0.0));

  /* ---- absorption ------------------------------------------------------- */
  vec3 refracted = sceneColor;
  vec3 transmit = vec3(1.0);
  if (isWater && !fromBelow) {
    // Biome water colour drives the extinction: what the tint reflects is what
    // survives, so (1 - tint) is absorbed. Red dies first, blue-green survives.
    vec3 extinction = max(u_absorb.rgb * (vec3(0.28) + (vec3(1.0) - baseTint)), vec3(0.0));
    float thickness = min(refractedDepth, max(u_absorb.w, 1.0));
    transmit = exp(-extinction * thickness);
    vec3 ambient = u_skyAmbient.rgb * max(u_skyAmbient.w, 0.0);
    vec3 sunTerm = u_sunColor.rgb * max(u_sunColor.w, 0.0) * saturate(u_sunDir.y);
    vec3 inScatter = baseTint * u_scatter.rgb * u_scatter.w *
                     (ambient * 0.55 + sunTerm * 0.45) * mix(0.25, 1.0, skyLight);
    refracted = sceneColor * transmit + inScatter * (vec3(1.0) - transmit);
  } else if (!isWater) {
    vec3 tint = mix(vec3(1.0), glassAlbedo * baseTint, saturate(u_glassParams.w));
    refracted = sceneColor * tint;
  }

  /* ---- caustics --------------------------------------------------------- */
#ifdef WATER_CAUSTICS
  if (isWater && !fromBelow && !refractSky && u_waterParams.w > 0.0) {
    vec3 floorPos = worldFromDepth(refractUV, refractDepth);
    vec3 sunDir = safeNormalize(u_sunDir.xyz);
    float below = max(v_worldPos.y - floorPos.y, 0.0);
    vec2 cp = (floorPos.xz + sunDir.xz * below * 0.55) * max(u_waterParams2.x, 0.01);
    float caustic = voxCaustics(cp, waveTime * 0.55);
    float sunUp = saturate(sunDir.y * 1.6);
    float shallow = exp(-below * 0.22) * (1.0 - saturate(below / max(u_absorb.w, 1.0)));
    vec3 sunCol = u_sunColor.rgb * max(u_sunColor.w, 0.0);
    refracted += sunCol * (caustic * u_waterParams.w * sunUp * shallow * skyLight) * transmit;
  }
#endif

  /* ---- reflection ------------------------------------------------------- */
  vec3 R = reflect(-V, N);
  if (!fromBelow && R.y < 0.02) R = safeNormalize(vec3(R.x, 0.02, R.z));
  float skyGate = isWater ? mix(0.06, 1.0, smoothstep(0.10, 0.70, skyLight)) : 1.0;
  vec3 reflected = voxSkyRadiance(R) * skyGate;
  if (fromBelow) {
    // Under the surface the "reflection" is the water body itself.
    reflected = mix(reflected * 0.25, sceneColor, 0.65);
  }

#ifdef WATER_SSR
  {
    float jitter = fract(hash21(gl_FragCoord.xy) + u_time.z * 0.6180339887) * saturate(u_ssrParams.w);
    vec3 origin = v_worldPos + N * 0.045 + V * 0.02;
    vec4 ssr = voxTraceSSR(origin, R, jitter);
    if (ssr.a > 0.0) reflected = mix(reflected, ssr.rgb, ssr.a);
  }
#endif

  /* ---- fresnel + sun specular ------------------------------------------- */
  float f0 = isWater ? 0.02 : 0.045;
  float fresnel = f0 + (1.0 - f0) * pow5(1.0 - NoV);
  if (fromBelow) fresnel = mix(fresnel, 1.0, smoothstep(0.22, 0.02, NoV));
  fresnel = saturate(fresnel);

  vec3 color = mix(refracted, reflected, fresnel);

  vec3 L = safeNormalize(u_sunDir.xyz);
  float NoL = saturate(dot(N, L));
  if (NoL > 0.0 && u_sunDir.y > -0.08) {
    float perceptual = clamp(roughness, 0.02, 1.0);
    float a = perceptual * perceptual;
    vec3 H = safeNormalize(V + L);
    float NoH = saturate(dot(N, H));
    float LoH = saturate(dot(L, H));
    float D = D_GGX(NoH, a);
    float Vis = V_SmithGGX(NoV, NoL, a);
    vec3 F = F_Schlick(LoH, vec3(f0));
    vec3 sunCol = u_sunColor.rgb * max(u_sunColor.w, 0.0);
    vec3 spec = (D * Vis) * F * sunCol * NoL * mix(0.15, 1.0, skyLight) * (1.0 - rain * 0.55);
    color += min(spec, vec3(max(u_waterParams2.y, 0.0)));
  }

  /* ---- foam ------------------------------------------------------------- */
  float foam = 0.0;
#ifdef WATER_FOAM
  if (isWater && !fromBelow && u_waterParams.z > 0.0) {
    float shoreline = 1.0 - saturate(waterDepth / max(u_waterParams.z, 0.02));
    shoreline *= shoreline;
    float n = voxWaterDetail(v_basePos.xz * 2.7 + vec2(waveTime * 0.35, waveTime * -0.27),
                             waveTime * 1.6) * 0.5 + 0.5;
    foam = saturate(shoreline * (0.55 + 0.75 * n));
    float crestRef = max(u_waveParams.x, 1.0e-4) * 1.15;
    float crest = saturate((v_worldPos.y - v_basePos.y) / crestRef);
    foam = max(foam, saturate(crest - 0.55) * 1.6 * saturate(0.35 + 0.65 * n));
    foam = saturate(foam);
    vec3 foamCol = vec3(0.90, 0.95, 1.0) *
                   (u_skyAmbient.rgb * max(u_skyAmbient.w, 0.0) * 0.6 +
                    u_sunColor.rgb * max(u_sunColor.w, 0.0) * saturate(u_sunDir.y) * 0.6 + 0.02);
    color = mix(color, foamCol, foam * 0.92);
  }
#endif

  /* ---- alpha ------------------------------------------------------------ */
  float alpha;
  if (isWater) {
    float opacity = mix(max(u_waterParams2.w, 0.0), 1.0, saturate(waterDepth * 0.55));
    opacity = max(opacity, fresnel);
    opacity = max(opacity, foam);
    if (fromBelow) opacity = clamp(mix(0.30, 0.92, fresnel), 0.22, 0.96);
    if (centerSky) opacity = max(opacity, 0.90);
    alpha = clamp(opacity, 0.20, 1.0);
  } else {
    float base = clamp(u_glassParams.x, 0.02, 1.0);
    alpha = clamp(max(max(base, texAlpha), fresnel * 0.85), 0.05, 1.0);
  }

  color = applyFog(color, v_worldPos, -V, viewDist);
  o_color = vec4(max(color, vec3(0.0)), alpha);
}
`;

/* -------------------------------------------------------------------------- */
/* Underwater overlay fragment shader                                         */
/* -------------------------------------------------------------------------- */

/**
 * Fullscreen underwater / lava overlay.
 *
 * Reads the scene copy (unit 14) and the copied depth (unit 7) and writes the
 * fully composited result, so it must run with blending disabled.
 *
 * Defines: `UNDERWATER_GODRAYS`, `UNDERWATER_STEPS`, `UNDERWATER_PARTICLES`,
 * `WATER_DETAIL_OCT`, `DEPTH_RGBA8`.
 * @type {string}
 */
const UNDERWATER_FS = `
#include <frame>
#include <math>
#include <depth>

${CAUSTIC_GLSL}
${DEPTH_CODEC_GLSL}

uniform sampler2D u_gDepth;      // unit 7  — copied scene depth
uniform sampler2D u_sceneCopy;   // unit 14 — copied HDR scene colour

/** rgb extinction per block, w maximum distance considered. */
uniform vec4 u_uwAbsorb;
/** rgb in-scatter colour, w strength. */
uniform vec4 u_uwScatter;
/** x lava (0/1), y submerged 0..1, z surface Y, w wobble amplitude. */
uniform vec4 u_uwParams;
/** x god-ray intensity, y march distance, z depth falloff, w caustic scale. */
uniform vec4 u_uwGod;
/** x particle density, y particle brightness, z vignette, w spare. */
uniform vec4 u_uwGrain;

in vec2 v_uv;

layout(location = 0) out vec4 o_color;

${DEPTH_FETCH_GLSL}

void main() {
  float amount = saturate(u_uwParams.y);
  vec3 original = max(texture(u_sceneCopy, v_uv).rgb, vec3(0.0));
  if (amount <= 0.001) {
    o_color = vec4(original, 1.0);
    return;
  }

  float t = u_time.x;
  float lava = saturate(u_uwParams.x);

  /* ---- refraction wobble ------------------------------------------------ */
  float wobbleAmp = max(u_uwParams.w, 0.0) * (1.0 - lava * 0.55);
  vec2 wobble = vec2(sin(t * 1.73 + v_uv.y * 44.0) + 0.5 * sin(t * 3.11 + v_uv.y * 17.0),
                     cos(t * 1.41 + v_uv.x * 37.0) + 0.5 * cos(t * 2.69 + v_uv.x * 13.0));
  vec2 uv = clamp(v_uv + wobble * wobbleAmp, vec2(0.0), vec2(1.0));

  vec3 color = max(texture(u_sceneCopy, uv).rgb, vec3(0.0));

  float d = voxSceneDepth(uv);
  float far = max(u_camDir.w, 1.0);
  float dist = d >= 0.9999995 ? far : linearizeDepth(d);
  dist = clamp(dist, 0.0, max(u_uwAbsorb.w, 0.25));

  /* ---- absorption ------------------------------------------------------- */
  vec3 extinction = max(u_uwAbsorb.rgb, vec3(0.0));
  vec3 transmit = exp(-extinction * dist);
  vec3 scatter = max(u_uwScatter.rgb * u_uwScatter.w, vec3(0.0));
  color = color * transmit + scatter * (vec3(1.0) - transmit);

  vec3 rd = rayFromUV(v_uv);
  vec3 sunDir = safeNormalize(u_sunDir.xyz);

  /* ---- god rays from the surface ---------------------------------------- */
#ifdef UNDERWATER_GODRAYS
  if (lava < 0.5 && u_uwGod.x > 0.0) {
    float march = min(dist, max(u_uwGod.y, 1.0));
    float dither = hash21(gl_FragCoord.xy + vec2(fract(u_time.z * 0.6180339887)));
    float shaft = 0.0;
    for (int i = 0; i < UNDERWATER_STEPS; ++i) {
      float s = (float(i) + dither) / float(UNDERWATER_STEPS);
      vec3 p = u_camPos.xyz + rd * (march * s);
      float below = max(u_uwParams.z - p.y, 0.0);
      float att = exp(-below * max(u_uwGod.z, 0.0));
      vec2 cp = (p.xz + sunDir.xz * below * 0.65) * max(u_uwGod.w, 0.001);
      float c = voxCaustics(cp, t * 0.55);
      shaft += att * (0.18 + 0.82 * c);
    }
    shaft *= march / float(UNDERWATER_STEPS);
    float phase = pow(saturate(dot(rd, sunDir)), 5.0);
    vec3 sunCol = u_sunColor.rgb * max(u_sunColor.w, 0.0) * saturate(u_sunDir.y * 2.0 + 0.15);
    color += sunCol * (shaft * u_uwGod.x * (0.30 + 0.70 * phase));
  }
#endif

  /* ---- floating particulate --------------------------------------------- */
#ifdef UNDERWATER_PARTICLES
  if (u_uwGrain.y > 0.0) {
    float motes = 0.0;
    for (int i = 0; i < 4; ++i) {
      float shell = 1.4 + float(i) * 2.6;
      if (shell > dist) break;
      vec3 p = (u_camPos.xyz + rd * shell) * (1.5 + float(i) * 0.4);
      p.y += t * (0.11 + float(i) * 0.03);
      p.x += sin(t * 0.31 + float(i) * 1.7) * 0.35;
      p.z += cos(t * 0.27 + float(i) * 2.3) * 0.35;
      vec3 cell = floor(p);
      vec3 r = hash33(cell);
      vec3 centre = cell + 0.15 + 0.70 * r;
      float dd = length(p - centre);
      float radius = mix(0.05, 0.14, r.z) * max(u_uwGrain.x, 0.0);
      motes += smoothstep(radius, 0.0, dd) * (0.35 + 0.65 * r.x);
    }
    vec3 moteCol = mix(vec3(0.72, 0.90, 1.0), vec3(1.0, 0.62, 0.24), lava);
    color += moteCol * (motes * u_uwGrain.y);
  }
#endif

  /* ---- lava flicker ----------------------------------------------------- */
  if (lava > 0.0) {
    float flicker = 0.86 + 0.14 * sin(t * 6.7 + hash21(floor(v_uv * 24.0)) * TAU);
    vec3 hot = scatter * flicker + vec3(0.35, 0.08, 0.01) * flicker;
    color = mix(color, hot, lava * 0.55);
  }

  /* ---- vignette --------------------------------------------------------- */
  float r = length(v_uv - vec2(0.5)) * 1.41421356;
  float vig = 1.0 - saturate(u_uwGrain.z) * smoothstep(0.32, 1.05, r);
  color *= vig;

  o_color = vec4(max(mix(original, color, amount), vec3(0.0)), 1.0);
}
`;

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/**
 * Clamp a number into a range, tolerating non-finite input.
 * @param {number} v Value.
 * @param {number} a Lower bound.
 * @param {number} b Upper bound.
 * @returns {number} Clamped value.
 */
function clampNum(v, a, b) {
  const n = Number(v);
  if (!Number.isFinite(n)) return a;
  return n < a ? a : (n > b ? b : n);
}

/**
 * Read a component of a vector that may be an array or an `{x,y,z}` object.
 * @param {ArrayLike<number>|{x?:number,y?:number,z?:number}|null|undefined} v Source.
 * @param {number} i Component index 0..2.
 * @param {number} fallback Value when the component is missing.
 * @returns {number} The component.
 */
function comp(v, i, fallback) {
  if (!v) return fallback;
  const keyed = i === 0 ? v.x : (i === 1 ? v.y : v.z);
  if (typeof keyed === 'number' && Number.isFinite(keyed)) return keyed;
  const n = v[i];
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/* ========================================================================== */
/* WaterRenderer                                                              */
/* ========================================================================== */

/**
 * Forward transparent pass: water surfaces, glass/ice, and the underwater and
 * lava screen overlays.
 *
 * ```js
 * const water = new WaterRenderer(gl, settings);
 * water.setTextures(renderer.textures);            // optional: glass/ice maps
 * water.setSkyLUT(sky.lut, 1);                     // optional: SSR sky fallback
 * water.resize(width, height);
 * // ... deferred composite has filled sceneColorTex ...
 * water.captureScene(sceneColorTex, sceneDepthTex);
 * water.render(world, frame, gbuffer, sceneColorTex, sceneDepthTex, sceneFBO);
 * water.renderUnderwaterOverlay(frame, sceneFBO, sceneColorTex, sceneDepthTex);
 * ```
 */
export class WaterRenderer {
  /**
   * @param {import('../core/gl.js').GL} gl VOXELIA WebGL2 device.
   * @param {{get:function(string):*}|null} [settings=null] Live settings.
   */
  constructor(gl, settings = null) {
    /** @type {import('../core/gl.js').GL} Owning device. */
    this.device = gl;
    /** @type {WebGL2RenderingContext} Raw context. */
    this.raw = gl.gl;
    /** @type {{get:function(string):*}|null} Settings source. */
    this.settings = settings || null;

    /** @type {number} Full-resolution width of the pass. */
    this.width = 0;
    /** @type {number} Full-resolution height of the pass. */
    this.height = 0;
    /** @type {number} Width of the scene copy (half res on `waterQuality: 'low'`). */
    this.copyWidth = 0;
    /** @type {number} Height of the scene copy. */
    this.copyHeight = 0;

    /** @type {?WebGLTexture} HDR copy of the scene colour (unit 14). */
    this.sceneCopy = null;
    /** @type {?WebGLTexture} Copy of the scene depth (unit 7). */
    this.depthCopy = null;
    /** @type {?Object} Framebuffer wrapping both copies. @private */
    this._copyFBO = null;
    /** @type {boolean} True when the depth copy is RGBA8-packed. @private */
    this._packedDepth = false;

    /** @type {{surface:?Object, copy:?Object, underwater:?Object}} Programs. */
    this.programs = { surface: null, copy: null, underwater: null };

    /** @type {?{bindArrays:function(Object):void}} Procedural texture arrays. @private */
    this._textures = null;
    /** @type {?WebGLTexture} Sky LUT for the SSR fallback (unit 10). @private */
    this._skyLUT = null;
    /** @type {number} Mix of the sky LUT over `analyticSky`, 0..1. @private */
    this._skyLUTMix = 0;
    /** @type {number} Scale applied to sky LUT samples. @private */
    this._skyLUTScale = 1;

    /* ---- tunables (safe to poke from the orchestrator) ------------------- */

    /** @type {number} Base Gerstner amplitude in blocks (calm weather). */
    this.waveAmplitude = 0.042;
    /** @type {number} Horizontal Gerstner choppiness, 0..1. */
    this.waveChoppiness = 0.55;
    /** @type {number} Wave time scale. */
    this.waveSpeed = 1.0;
    /** @type {number} Strength of the FBM detail slope added to the normal. */
    this.waveDetail = 0.16;
    /** @type {number} Multiplier applied to the analytic wave normal slope. */
    this.normalGain = 5.5;
    /** @type {number} Refraction offset strength, in uv units per unit of normal bend. */
    this.refractionStrength = 0.045;
    /** @type {number} Shoreline foam band width in blocks. */
    this.foamWidth = 0.85;
    /** @type {number} Caustic brightness. */
    this.causticStrength = 0.55;
    /** @type {number} Caustic world scale (cells per block). */
    this.causticScale = 0.42;
    /** @type {number} Upper clamp of the sun specular highlight. */
    this.specularClamp = 48;
    /** @type {number} How quickly refraction ramps up with depth (1/blocks). */
    this.refractionDepthScale = 0.55;
    /** @type {number} Minimum water opacity in very shallow water. */
    this.minOpacity = 0.55;
    /** @type {number[]} Base extinction per block, scaled by (1 - biome tint). */
    this.absorption = [0.30, 0.15, 0.09];
    /** @type {number} Maximum water depth considered for absorption, in blocks. */
    this.absorptionDepth = 48;
    /** @type {number[]} In-scatter colour of the water body. */
    this.scatterColor = [0.16, 0.42, 0.48];
    /** @type {number} In-scatter strength. */
    this.scatterStrength = 0.9;
    /** @type {number} SSR thickness test in blocks. */
    this.ssrThickness = 0.9;
    /** @type {number} SSR maximum march distance in blocks. */
    this.ssrDistance = 64;
    /** @type {number} SSR blend intensity, 0..1. */
    this.ssrIntensity = 0.92;
    /** @type {number} Base glass/ice opacity. */
    this.glassAlpha = 0.18;
    /** @type {number} Glass/ice refraction scale. */
    this.glassRefraction = 0.018;
    /** @type {number} Minimum glass/ice roughness. */
    this.glassRoughness = 0.06;
    /** @type {number} How strongly glass/ice tints what is behind it. */
    this.glassTint = 0.75;

    /** @type {number[]} Underwater extinction per block. */
    this.underwaterAbsorption = [0.34, 0.10, 0.055];
    /** @type {number[]} Underwater in-scatter colour. */
    this.underwaterScatter = [0.055, 0.175, 0.215];
    /** @type {number} Underwater in-scatter strength. */
    this.underwaterScatterStrength = 0.95;
    /** @type {number} Underwater maximum considered distance in blocks. */
    this.underwaterDistance = 96;
    /** @type {number} Underwater screen wobble amplitude in uv units. */
    this.underwaterWobble = 0.0022;
    /**
     * Underwater god-ray intensity. The shaft integral grows with the march
     * distance, so this is a per-block density coefficient and stays small.
     * @type {number}
     */
    this.godRayIntensity = 0.010;
    /** @type {number} Underwater god-ray march distance in blocks. */
    this.godRayDistance = 42;
    /** @type {number} Underwater god-ray depth falloff (1/blocks). */
    this.godRayFalloff = 0.075;
    /** @type {number} Underwater particulate size factor. */
    this.particleDensity = 1.0;
    /** @type {number} Underwater particulate brightness. */
    this.particleBrightness = 0.06;
    /** @type {number} Underwater vignette strength. */
    this.vignette = 0.55;
    /** @type {number[]} Lava extinction per block (very short view distance). */
    this.lavaAbsorption = [1.7, 2.6, 3.4];
    /** @type {number[]} Lava in-scatter colour. */
    this.lavaScatter = [1.15, 0.30, 0.055];
    /** @type {number} Lava in-scatter strength. */
    this.lavaScatterStrength = 1.0;
    /** @type {number} Lava maximum considered distance in blocks. */
    this.lavaDistance = 3.2;

    /* ---- live state ------------------------------------------------------ */

    /**
     * Per-frame statistics for the debug overlay.
     * @type {{drawCalls:number, sections:number, copies:number, overlay:boolean,
     *   ssr:boolean, frameIndex:number}}
     */
    this.stats = {
      drawCalls: 0, sections: 0, copies: 0, overlay: false, ssr: false, frameIndex: -1,
    };

    /**
     * Explicit medium override; `null` means "derive it from the frame".
     * @type {?{water:boolean, lava:boolean, submerged:number, surfaceY:number}}
     * @private
     */
    this._medium = null;
    /** @type {{water:boolean, lava:boolean, submerged:number, surfaceY:number}} Resolved medium. @private */
    this._mediumState = { water: false, lava: false, submerged: 0, surfaceY: SEA_LEVEL };

    /** @type {number} Frame index the scene copy was taken on. @private */
    this._copyFrame = -1;
    /** @type {boolean} True once the copy holds a usable image. @private */
    this._copyValid = false;
    /** @type {?Object} Program used by the section draw callback. @private */
    this._drawProgram = null;
    /** @type {number} Draw calls of the running section loop. @private */
    this._drawCalls = 0;
    /** @type {number} Section-loop callback, bound once. @private */
    this._onSection = (mesh) => this._drawSection(mesh);
    /** @type {number} Signature of the programs that are currently built. @private */
    this._builtKey = -1;
    /** @type {boolean} Latched program build failure. @private */
    this._programError = false;
    /** @type {boolean} Latched target allocation failure. @private */
    this._targetError = false;
    /** @type {boolean} Latched draw failure. @private */
    this._drawError = false;
    /** @type {boolean} True once {@link WaterRenderer#dispose} ran. @private */
    this._disposed = false;

    /** @type {Float32Array} Scratch for `u_waveParams`. @private */
    this._vWave = new Float32Array(4);
    /** @type {Float32Array} Scratch for `u_waterParams`. @private */
    this._vWater = new Float32Array(4);
    /** @type {Float32Array} Scratch for `u_waterParams2`. @private */
    this._vWater2 = new Float32Array(4);
    /** @type {Float32Array} Scratch for `u_absorb`. @private */
    this._vAbsorb = new Float32Array(4);
    /** @type {Float32Array} Scratch for `u_scatter`. @private */
    this._vScatter = new Float32Array(4);
    /** @type {Float32Array} Scratch for `u_ssrParams`. @private */
    this._vSSR = new Float32Array(4);
    /** @type {Float32Array} Scratch for `u_glassParams`. @private */
    this._vGlass = new Float32Array(4);
    /** @type {Float32Array} Scratch for `u_skyLutParams`. @private */
    this._vSkyLut = new Float32Array(4);
    /** @type {Float32Array} Scratch for the overlay uniforms. @private */
    this._vUwAbsorb = new Float32Array(4);
    /** @type {Float32Array} Scratch for the overlay uniforms. @private */
    this._vUwScatter = new Float32Array(4);
    /** @type {Float32Array} Scratch for the overlay uniforms. @private */
    this._vUwParams = new Float32Array(4);
    /** @type {Float32Array} Scratch for the overlay uniforms. @private */
    this._vUwGod = new Float32Array(4);
    /** @type {Float32Array} Scratch for the overlay uniforms. @private */
    this._vUwGrain = new Float32Array(4);
  }

  /* ======================================================================= */
  /* Configuration                                                           */
  /* ======================================================================= */

  /**
   * Read a setting, tolerating a missing or throwing settings object.
   * @param {string} key Setting key.
   * @param {*} fallback Value when the key is unavailable.
   * @returns {*} The setting value.
   * @private
   */
  _setting(key, fallback) {
    if (!this.settings || typeof this.settings.get !== 'function') return fallback;
    try {
      const value = this.settings.get(key);
      return value === undefined || value === null ? fallback : value;
    } catch (err) {
      return fallback;
    }
  }

  /**
   * The `waterQuality` step, normalised to one of `low|medium|high|ultra`.
   * @returns {'low'|'medium'|'high'|'ultra'} Quality step.
   * @private
   */
  _quality() {
    const raw = String(this._setting('waterQuality', 'high')).toLowerCase();
    if (raw === 'low' || raw === 'off' || raw === 'potato') return 'low';
    if (raw === 'medium') return 'medium';
    if (raw === 'ultra' || raw === 'cinematic') return 'ultra';
    return 'high';
  }

  /**
   * Attach (or replace) the procedural texture manager whose arrays give glass
   * and ice their albedo, normal and roughness. Without it those surfaces fall
   * back to a neutral analytic look.
   *
   * Safe to call before `TextureManager.generate()` has run: the shader variant
   * that samples the arrays is only built once the arrays actually exist, so
   * glass never flashes black during loading.
   *
   * @param {?{bindArrays:function(Object):void, albedoArray?:WebGLTexture}} textures Texture manager.
   * @returns {void}
   */
  setTextures(textures) {
    this._textures = textures && typeof textures.bindArrays === 'function' ? textures : null;
  }

  /**
   * Whether the texture arrays are present *and* already generated.
   * @returns {boolean} `true` when glass/ice can sample the arrays.
   * @private
   */
  _arraysReady() {
    return !!(this._textures && this._textures.albedoArray);
  }

  /**
   * Supply the sky LUT (unit 10) used to refine the SSR sky fallback.
   * @param {?WebGLTexture} texture Latlong radiance LUT, or null to drop it.
   * @param {number} [mix=1] How much of it replaces `analyticSky`, 0..1.
   * @param {number} [scale=1] Scale applied to LUT samples.
   * @returns {void}
   */
  setSkyLUT(texture, mix = 1, scale = 1) {
    this._skyLUT = texture || null;
    this._skyLUTMix = texture ? clampNum(mix, 0, 1) : 0;
    this._skyLUTScale = Math.max(0, Number(scale) || 0);
  }

  /**
   * Force the camera medium instead of deriving it from the frame.
   * @param {?{water?:boolean, lava?:boolean, submerged?:number, surfaceY?:number}} state
   *        Medium description, or null to go back to deriving it.
   * @returns {void}
   */
  setMedium(state) {
    if (!state) {
      this._medium = null;
      return;
    }
    this._medium = {
      water: !!state.water,
      lava: !!state.lava,
      submerged: clampNum(state.submerged === undefined ? 1 : state.submerged, 0, 1),
      surfaceY: Number.isFinite(state.surfaceY) ? state.surfaceY : SEA_LEVEL,
    };
  }

  /**
   * Work out whether (and in what) the camera is submerged.
   * @param {Object} frame Frame descriptor (ARCHITECTURE.md 5.26).
   * @returns {{water:boolean, lava:boolean, submerged:number, surfaceY:number}} Medium state.
   * @private
   */
  _resolveMedium(frame) {
    const out = this._mediumState;
    out.water = false;
    out.lava = false;
    out.submerged = 0;
    out.surfaceY = SEA_LEVEL;

    if (this._medium) {
      out.water = this._medium.water;
      out.lava = this._medium.lava;
      out.submerged = this._medium.submerged;
      out.surfaceY = this._medium.surfaceY;
      return out;
    }
    if (!frame) return out;

    const camera = frame.camera || null;
    const player = frame.player || null;
    const env = frame.environment || null;

    let lava = false;
    let water = false;
    let submerged = 0;

    const flags = [camera, player, frame];
    for (const src of flags) {
      if (!src) continue;
      if (src.inLava === true || src.underLava === true || src.lava === true) lava = true;
      if (src.underwater === true || src.inWater === true || src.submergedInWater === true) water = true;
      if (Number.isFinite(src.submerged)) submerged = Math.max(submerged, clampNum(src.submerged, 0, 1));
    }
    const liquid = (player && player.liquid) || (frame && frame.liquid) || null;
    if (liquid) {
      if (liquid.lava === true) lava = true;
      if (liquid.water === true) water = true;
      if (Number.isFinite(liquid.submerged)) submerged = Math.max(submerged, clampNum(liquid.submerged, 0, 1));
    }
    if ((water || lava) && submerged <= 0) submerged = 1;
    if (submerged > 0 && !water && !lava) water = true;

    out.water = water && !lava;
    out.lava = lava;
    out.submerged = lava ? Math.max(submerged, 1) : submerged;

    let surfaceY = SEA_LEVEL;
    if (env && Number.isFinite(env.seaLevel)) surfaceY = env.seaLevel;
    else if (frame.world && Number.isFinite(frame.world.seaLevel)) surfaceY = frame.world.seaLevel;
    const camY = camera ? comp(camera.position, 1, NaN) : NaN;
    if (Number.isFinite(camY) && camY > surfaceY) surfaceY = camY + 1;
    out.surfaceY = surfaceY;
    return out;
  }

  /**
   * Wind/rain driven wave state for this frame.
   * @param {Object} frame Frame descriptor.
   * @returns {{amp:number, choppy:number, speed:number, detail:number}} Wave state.
   * @private
   */
  _waveState(frame) {
    const animate = this._setting('waveAnimation', true) !== false;
    const env = (frame && frame.environment) || null;
    let wind = 0;
    if (env) {
      if (Number.isFinite(env.windStrength)) wind = clampNum(env.windStrength, 0, 1);
      else if (Number.isFinite(env.wind)) wind = clampNum(env.wind, 0, 1);
      const rain = Number.isFinite(env.rainStrength) ? clampNum(env.rainStrength, 0, 1) : 0;
      const thunder = Number.isFinite(env.thunderStrength) ? clampNum(env.thunderStrength, 0, 1) : 0;
      wind = Math.max(wind, rain * 0.85 + thunder * 0.55);
    }
    wind = clampNum(wind, 0, 1.4);
    const gust = 1 + wind * 1.35;
    return {
      amp: Math.max(0, this.waveAmplitude) * gust * (animate ? 1 : 0.45),
      choppy: clampNum(this.waveChoppiness * (0.75 + wind * 0.5), 0, 1),
      speed: animate ? Math.max(0, this.waveSpeed) * (0.85 + wind * 0.5) : 0,
      detail: Math.max(0, this.waveDetail) * (1 + wind * 0.6),
    };
  }

  /* ======================================================================= */
  /* GPU resources                                                           */
  /* ======================================================================= */

  /**
   * Resize the scene copy for a new render target size.
   * @param {number} w Full-resolution width in pixels.
   * @param {number} h Full-resolution height in pixels.
   * @returns {boolean} `true` when the copy targets are usable afterwards.
   */
  resize(w, h) {
    if (this._disposed) return false;
    const nw = Math.max(1, w | 0);
    const nh = Math.max(1, h | 0);
    if (nw === this.width && nh === this.height && this._copyFBO) return this._copyFBO.complete;
    this.width = nw;
    this.height = nh;
    this._copyValid = false;
    this._copyFrame = -1;
    return this._ensureTargets();
  }

  /**
   * Allocate (or reallocate) the colour + depth copy at the current size and
   * quality step.
   * @returns {boolean} `true` when the copy framebuffer is complete.
   * @private
   */
  _ensureTargets() {
    if (this._disposed) return false;
    if (this.width <= 0 || this.height <= 0) return false;

    const half = this._quality() === 'low';
    const cw = half ? Math.max(1, Math.ceil(this.width / 2)) : this.width;
    const ch = half ? Math.max(1, Math.ceil(this.height / 2)) : this.height;

    if (this._copyFBO && this.copyWidth === cw && this.copyHeight === ch) {
      return this._copyFBO.complete;
    }

    const gl = this.raw;
    const device = this.device;
    try {
      if (!this.sceneCopy) {
        const float = !!device.caps.colorBufferFloat;
        this.sceneCopy = device.createTexture({
          target: gl.TEXTURE_2D,
          width: cw,
          height: ch,
          internalFormat: float ? gl.RGBA16F : gl.RGBA8,
          min: gl.LINEAR,
          mag: gl.LINEAR,
          wrap: gl.CLAMP_TO_EDGE,
        });
        this._packedDepth = !float;
        this.depthCopy = device.createTexture({
          target: gl.TEXTURE_2D,
          width: cw,
          height: ch,
          internalFormat: float ? gl.R32F : gl.RGBA8,
          min: gl.NEAREST,
          mag: gl.NEAREST,
          wrap: gl.CLAMP_TO_EDGE,
        });
      }
      if (!this._copyFBO) {
        this._copyFBO = device.createFramebuffer({
          color: [this.sceneCopy, this.depthCopy],
          depth: null,
          name: 'water.sceneCopy',
          width: cw,
          height: ch,
        });
      } else {
        this._copyFBO.resize(cw, ch);
      }
      this.copyWidth = cw;
      this.copyHeight = ch;
      this._copyValid = false;
      this._targetError = false;
      return !!(this._copyFBO && this._copyFBO.complete);
    } catch (err) {
      if (!this._targetError) {
        this._targetError = true;
        console.error('[VOXELIA] water: scene copy allocation failed — water pass disabled.', err);
      }
      return false;
    }
  }

  /**
   * Signature of the current shader configuration; a change forces a rebuild.
   * Packed into a small integer so the per-frame check allocates nothing.
   * @returns {number} Build key.
   * @private
   */
  _programKey() {
    const q = this._quality();
    const qi = q === 'low' ? 0 : (q === 'medium' ? 1 : (q === 'high' ? 2 : 3));
    const ssr = this._setting('ssr', true) !== false && SSR_STEPS[q] > 0;
    return qi |
      (ssr ? 4 : 0) |
      (this._arraysReady() ? 8 : 0) |
      (this._skyLUT && this._skyLUTMix > 0 ? 16 : 0) |
      (this._packedDepth ? 32 : 0);
  }

  /**
   * Build the three programs when they are missing or the configuration changed.
   * @returns {boolean} `true` when the surface program is usable.
   * @private
   */
  _ensurePrograms() {
    const key = this._programKey();
    if (this.programs.surface && this._builtKey === key) {
      return !!this.programs.surface.program;
    }
    this._disposePrograms();

    const q = this._quality();
    const ssrSteps = this._setting('ssr', true) !== false ? (SSR_STEPS[q] || 0) : 0;
    const detail = DETAIL_OCTAVES[q] || 3;
    const godSteps = GODRAY_STEPS[q] || 0;
    const useLUT = !!(this._skyLUT && this._skyLUTMix > 0);
    const packed = this._packedDepth;
    const device = this.device;

    try {
      this.programs.copy = device.createProgram('water.copy', FULLSCREEN_VS_SOURCE, COPY_FS, {
        defines: { DEPTH_RGBA8: packed },
      });
      this.programs.surface = device.createProgram('water.surface', WATER_VS, WATER_FS, {
        defines: {
          DEPTH_RGBA8: packed,
          USE_SKY_LUT: useLUT,
          USE_TEXTURE_ARRAYS: this._arraysReady(),
          WATER_DETAIL_OCT: detail,
          WATER_SSR: ssrSteps > 0,
          WATER_SSR_STEPS: ssrSteps > 0 ? ssrSteps : 8,
          WATER_CAUSTICS: q !== 'low',
          WATER_FOAM: true,
        },
      });
      this.programs.underwater = device.createProgram('water.underwater', FULLSCREEN_VS_SOURCE, UNDERWATER_FS, {
        defines: {
          DEPTH_RGBA8: packed,
          WATER_DETAIL_OCT: detail,
          UNDERWATER_GODRAYS: godSteps > 0,
          UNDERWATER_STEPS: godSteps > 0 ? godSteps : 8,
          UNDERWATER_PARTICLES: q !== 'low',
        },
      });

      for (const name of Object.keys(this.programs)) {
        const program = this.programs[name];
        if (!program) continue;
        program.bindUBO('Frame', FRAME_UBO_BINDING);
      }
      this._builtKey = key;
      this._programError = false;
      this.stats.ssr = ssrSteps > 0;
      return !!(this.programs.surface && this.programs.surface.program);
    } catch (err) {
      if (!this._programError) {
        this._programError = true;
        console.error('[VOXELIA] water: program build failed — water pass disabled.', err);
      }
      this._builtKey = key;
      return false;
    }
  }

  /**
   * Delete every program this pass owns.
   * @returns {void}
   * @private
   */
  _disposePrograms() {
    for (const name of Object.keys(this.programs)) {
      const program = this.programs[name];
      if (program && typeof program.dispose === 'function') {
        try { program.dispose(); } catch (err) { /* already gone */ }
      }
      this.programs[name] = null;
    }
    this._builtKey = -1;
  }

  /* ======================================================================= */
  /* Scene copy                                                              */
  /* ======================================================================= */

  /**
   * Blit the current HDR scene colour **and** the scene depth into this
   * module's private copies, so the water shader has something to refract and
   * raymarch against without ever sampling a texture that is still attached to
   * the bound framebuffer.
   *
   * Call this after the deferred composite and before {@link WaterRenderer#render}.
   * The copy is half resolution when `settings.waterQuality` is `'low'`.
   *
   * @param {?WebGLTexture} sceneColorTex HDR scene colour to copy.
   * @param {?WebGLTexture} [sceneDepthTex=null] Scene depth attachment to copy.
   * @param {number} [frameIndex=-1] Frame stamp; `render()` skips a second copy
   *        in the same frame when it matches.
   * @returns {boolean} `true` when the copy is usable.
   */
  captureScene(sceneColorTex, sceneDepthTex = null, frameIndex = -1) {
    if (this._disposed || !sceneColorTex) return false;
    if (this.width <= 0 || this.height <= 0) {
      const gl = this.raw;
      this.resize(gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    if (!this._ensureTargets()) return false;
    if (!this._ensurePrograms()) return false;

    const program = this.programs.copy;
    if (!program || !program.use()) return false;

    const device = this.device;
    const gl = this.raw;
    try {
      // The copy textures may still be bound from the previous frame; never
      // sample a target we are about to render into.
      device.bindTexture(WATER_UNITS.SCENE_COPY, gl.TEXTURE_2D, null);
      device.bindTexture(WATER_UNITS.G_DEPTH, gl.TEXTURE_2D, null);

      device.bindFramebuffer(this._copyFBO);
      device.setViewport(0, 0, this.copyWidth, this.copyHeight);
      device.setDepthTest(false);
      device.setDepthWrite(false);
      device.setBlend('none');
      device.setCull('none');
      device.setColorMask(true, true, true, true);
      device.setScissor(false);

      program.setTexture('u_sceneColor', sceneColorTex, WATER_UNITS.SCENE_COLOR, gl.TEXTURE_2D);
      program.setTexture('u_srcDepth', sceneDepthTex || null, WATER_UNITS.G_DEPTH, gl.TEXTURE_2D);
      program.setVec4('u_copyParams', sceneDepthTex ? 1 : 0, 0, 0, 0);
      device.drawFullscreen();

      this._copyValid = true;
      this._copyFrame = Number.isFinite(frameIndex) ? frameIndex : -1;
      this.stats.copies++;
      return true;
    } catch (err) {
      if (!this._drawError) {
        this._drawError = true;
        console.error('[VOXELIA] water: scene copy failed.', err);
      }
      return false;
    }
  }

  /**
   * Alias of {@link WaterRenderer#captureScene} for orchestrators that prefer
   * the "copy" wording.
   * @param {?WebGLTexture} sceneColorTex HDR scene colour to copy.
   * @param {?WebGLTexture} [sceneDepthTex=null] Scene depth attachment to copy.
   * @param {number} [frameIndex=-1] Frame stamp.
   * @returns {boolean} `true` when the copy is usable.
   */
  copyScene(sceneColorTex, sceneDepthTex = null, frameIndex = -1) {
    return this.captureScene(sceneColorTex, sceneDepthTex, frameIndex);
  }

  /* ======================================================================= */
  /* Water surface pass                                                      */
  /* ======================================================================= */

  /**
   * Bind a render target, restoring a sane viewport for raw framebuffers.
   * @param {?Object|WebGLFramebuffer} targetFBO Target, or null for the screen.
   * @returns {void}
   * @private
   */
  _bindTarget(targetFBO) {
    const device = this.device;
    if (!targetFBO) {
      device.bindFramebuffer(null);
      return;
    }
    device.bindFramebuffer(targetFBO);
    if (!(targetFBO.width > 0 && targetFBO.height > 0)) {
      if (this.width > 0 && this.height > 0) device.setViewport(0, 0, this.width, this.height);
      else device.setViewport(0, 0, this.raw.drawingBufferWidth, this.raw.drawingBufferHeight);
    }
  }

  /**
   * Draw the water bucket of one visible section. Reused as the render-list
   * callback so the hot loop never allocates.
   * @param {Object} mesh Section mesh handed over by `world.iterateRenderList`.
   * @returns {void}
   * @private
   */
  _drawSection(mesh) {
    if (!mesh) return;
    const bucket = mesh.water;
    if (!bucket || !bucket.vao || !(bucket.indexCount > 0)) return;
    const program = this._drawProgram;
    if (!program) return;
    const gl = this.raw;
    program.setVec3('u_chunkOrigin', mesh.originX, mesh.originY, mesh.originZ);
    this.device.bindVertexArray(bucket.vao);
    gl.drawElements(gl.TRIANGLES, bucket.indexCount, gl.UNSIGNED_INT, 0);
    this._drawCalls++;
  }

  /**
   * Draw the `water` bucket of every visible section back-to-front.
   *
   * Depth testing is on, depth writes are off, alpha blending is on and culling
   * is disabled so both sides of a surface are shaded. When `sceneColorTex` is
   * given and no copy was taken for this frame yet, the scene is copied first.
   *
   * @param {{iterateRenderList:function(Object, Function, string=):number}} world Chunk manager.
   * @param {Object} frame Frame descriptor (ARCHITECTURE.md 5.26).
   * @param {?{depth?:WebGLTexture}} gbuffer G-buffer (only its depth is used).
   * @param {?WebGLTexture} sceneColorTex HDR scene colour to refract.
   * @param {?WebGLTexture} sceneDepthTex Scene depth attachment.
   * @param {?Object|WebGLFramebuffer} targetFBO Target the water is drawn into.
   * @returns {number} Draw calls issued.
   */
  render(world, frame, gbuffer, sceneColorTex, sceneDepthTex, targetFBO) {
    if (this._disposed) return 0;
    if (!world || typeof world.iterateRenderList !== 'function') return 0;

    const frameIndex = frame && Number.isFinite(frame.frameIndex) ? frame.frameIndex : -1;
    if (frameIndex >= 0 && frameIndex !== this.stats.frameIndex) {
      this.stats.frameIndex = frameIndex;
      this.stats.drawCalls = 0;
      this.stats.sections = 0;
      this.stats.copies = 0;
      this.stats.overlay = false;
    }

    const depthTex = sceneDepthTex || (gbuffer && gbuffer.depth) || null;
    if (this.width <= 0 || this.height <= 0) {
      const target = targetFBO && targetFBO.width > 0
        ? [targetFBO.width, targetFBO.height]
        : [this.raw.drawingBufferWidth, this.raw.drawingBufferHeight];
      this.resize(target[0], target[1]);
    }
    if (!this._ensureTargets()) return 0;
    if (!this._ensurePrograms()) return 0;

    if (sceneColorTex && (!this._copyValid || frameIndex < 0 || this._copyFrame !== frameIndex)) {
      this.captureScene(sceneColorTex, depthTex, frameIndex);
    }
    if (!this._copyValid) return 0;

    const program = this.programs.surface;
    if (!program || !program.use()) return 0;

    const device = this.device;
    const gl = this.raw;
    let drawn = 0;

    try {
      this._bindTarget(targetFBO);

      program.bindUBO('Frame', FRAME_UBO_BINDING);
      program.setTexture('u_gDepth', this.depthCopy, WATER_UNITS.G_DEPTH, gl.TEXTURE_2D);
      program.setTexture('u_sceneCopy', this.sceneCopy, WATER_UNITS.SCENE_COPY, gl.TEXTURE_2D);
      if (this._arraysReady()) this._textures.bindArrays(program);
      if (this._skyLUT && this._skyLUTMix > 0) {
        program.setTexture('u_skyLUT', this._skyLUT, WATER_UNITS.SKY_LUT, gl.TEXTURE_2D);
      }

      const wave = this._waveState(frame);
      const w = this._vWave;
      w[0] = wave.amp; w[1] = wave.choppy; w[2] = wave.speed; w[3] = wave.detail;
      program.setVec4('u_waveParams', w);

      const p = this._vWater;
      p[0] = Math.max(0, this.normalGain);
      p[1] = Math.max(0, this.refractionStrength);
      p[2] = Math.max(0, this.foamWidth);
      p[3] = Math.max(0, this.causticStrength);
      program.setVec4('u_waterParams', p);

      const p2 = this._vWater2;
      p2[0] = Math.max(0.001, this.causticScale);
      p2[1] = Math.max(0, this.specularClamp);
      p2[2] = Math.max(0.001, this.refractionDepthScale);
      p2[3] = clampNum(this.minOpacity, 0, 1);
      program.setVec4('u_waterParams2', p2);

      const ab = this._vAbsorb;
      ab[0] = Math.max(0, this.absorption[0] || 0);
      ab[1] = Math.max(0, this.absorption[1] || 0);
      ab[2] = Math.max(0, this.absorption[2] || 0);
      ab[3] = Math.max(1, this.absorptionDepth);
      program.setVec4('u_absorb', ab);

      const sc = this._vScatter;
      sc[0] = Math.max(0, this.scatterColor[0] || 0);
      sc[1] = Math.max(0, this.scatterColor[1] || 0);
      sc[2] = Math.max(0, this.scatterColor[2] || 0);
      sc[3] = Math.max(0, this.scatterStrength);
      program.setVec4('u_scatter', sc);

      const ss = this._vSSR;
      ss[0] = Math.max(0.05, this.ssrThickness);
      ss[1] = Math.max(1, this.ssrDistance);
      ss[2] = clampNum(this.ssrIntensity, 0, 1);
      ss[3] = 1;
      program.setVec4('u_ssrParams', ss);

      const gp = this._vGlass;
      gp[0] = clampNum(this.glassAlpha, 0.02, 1);
      gp[1] = Math.max(0, this.glassRefraction);
      gp[2] = clampNum(this.glassRoughness, 0.01, 1);
      gp[3] = clampNum(this.glassTint, 0, 1);
      program.setVec4('u_glassParams', gp);

      const lut = this._vSkyLut;
      lut[0] = this._skyLUT ? this._skyLUTMix : 0;
      lut[1] = this._skyLUTScale;
      lut[2] = 0;
      lut[3] = 0;
      program.setVec4('u_skyLutParams', lut);

      device.setDepthTest(true);
      device.setDepthFunc(gl.LEQUAL);
      device.setDepthWrite(false);
      device.setBlend('alpha');
      device.setCull('none');
      device.setColorMask(true, true, true, true);

      this._drawProgram = program;
      this._drawCalls = 0;

      const frustum = (frame && frame.camera && frame.camera.frustum) ||
        (frame && frame.frustum) || null;
      const visible = world.iterateRenderList(frustum, this._onSection, 'water');

      drawn = this._drawCalls;
      this.stats.drawCalls += drawn;
      this.stats.sections += Number.isFinite(visible) ? visible : 0;
    } catch (err) {
      if (!this._drawError) {
        this._drawError = true;
        console.error('[VOXELIA] water: surface pass failed.', err);
      }
    } finally {
      this._drawProgram = null;
      try {
        this.device.bindVertexArray(null);
        this.device.setDepthWrite(true);
        this.device.setBlend('none');
        this.device.setCull('back');
      } catch (err) { /* context lost */ }
    }
    return drawn;
  }

  /* ======================================================================= */
  /* Underwater overlay                                                      */
  /* ======================================================================= */

  /**
   * Fullscreen overlay drawn when the camera is submerged.
   *
   * Adds depth-based blue-green absorption, a subtle screen-space refraction
   * wobble, floating particulate matter, god rays coming down from the surface
   * and a vignette. When the camera is inside lava the medium turns orange,
   * near-opaque and extremely short ranged instead.
   *
   * The overlay reads the scene copy, so pass `sceneColorTex` (the *current*
   * scene, water included) to have it re-captured first — otherwise the copy
   * taken before the water pass is reused.
   *
   * @param {Object} frame Frame descriptor (ARCHITECTURE.md 5.26).
   * @param {?Object|WebGLFramebuffer} targetFBO Target to composite into.
   * @param {?WebGLTexture} [sceneColorTex=null] Scene colour to re-capture.
   * @param {?WebGLTexture} [sceneDepthTex=null] Scene depth to re-capture.
   * @returns {boolean} `true` when the overlay was drawn.
   */
  renderUnderwaterOverlay(frame, targetFBO, sceneColorTex = null, sceneDepthTex = null) {
    if (this._disposed) return false;

    const medium = this._resolveMedium(frame);
    if (medium.submerged <= 0.001) return false;

    if (this.width <= 0 || this.height <= 0) {
      const target = targetFBO && targetFBO.width > 0
        ? [targetFBO.width, targetFBO.height]
        : [this.raw.drawingBufferWidth, this.raw.drawingBufferHeight];
      this.resize(target[0], target[1]);
    }
    if (!this._ensureTargets()) return false;
    if (!this._ensurePrograms()) return false;

    if (sceneColorTex) {
      const frameIndex = frame && Number.isFinite(frame.frameIndex) ? frame.frameIndex : -1;
      this.captureScene(sceneColorTex, sceneDepthTex, frameIndex);
    }
    if (!this._copyValid) return false;

    const program = this.programs.underwater;
    if (!program || !program.use()) return false;

    const device = this.device;
    const gl = this.raw;
    try {
      this._bindTarget(targetFBO);

      program.bindUBO('Frame', FRAME_UBO_BINDING);
      program.setTexture('u_gDepth', this.depthCopy, WATER_UNITS.G_DEPTH, gl.TEXTURE_2D);
      program.setTexture('u_sceneCopy', this.sceneCopy, WATER_UNITS.SCENE_COPY, gl.TEXTURE_2D);

      const lava = medium.lava;
      const absorb = lava ? this.lavaAbsorption : this.underwaterAbsorption;
      const scatter = lava ? this.lavaScatter : this.underwaterScatter;
      const strength = lava ? this.lavaScatterStrength : this.underwaterScatterStrength;
      const maxDist = lava ? this.lavaDistance : this.underwaterDistance;

      const a = this._vUwAbsorb;
      a[0] = Math.max(0, absorb[0] || 0);
      a[1] = Math.max(0, absorb[1] || 0);
      a[2] = Math.max(0, absorb[2] || 0);
      a[3] = Math.max(0.25, maxDist);
      program.setVec4('u_uwAbsorb', a);

      const s = this._vUwScatter;
      s[0] = Math.max(0, scatter[0] || 0);
      s[1] = Math.max(0, scatter[1] || 0);
      s[2] = Math.max(0, scatter[2] || 0);
      s[3] = Math.max(0, strength);
      program.setVec4('u_uwScatter', s);

      const up = this._vUwParams;
      up[0] = lava ? 1 : 0;
      up[1] = clampNum(medium.submerged, 0, 1);
      up[2] = Number.isFinite(medium.surfaceY) ? medium.surfaceY : SEA_LEVEL;
      up[3] = lava ? this.underwaterWobble * 1.6 : this.underwaterWobble;
      program.setVec4('u_uwParams', up);

      const g = this._vUwGod;
      g[0] = lava ? 0 : Math.max(0, this.godRayIntensity);
      g[1] = Math.max(1, this.godRayDistance);
      g[2] = Math.max(0, this.godRayFalloff);
      g[3] = Math.max(0.001, this.causticScale * 0.75);
      program.setVec4('u_uwGod', g);

      const gr = this._vUwGrain;
      gr[0] = Math.max(0, this.particleDensity);
      gr[1] = Math.max(0, this.particleBrightness) * (lava ? 1.8 : 1);
      gr[2] = clampNum(lava ? this.vignette * 1.35 : this.vignette, 0, 1);
      gr[3] = 0;
      program.setVec4('u_uwGrain', gr);

      device.setDepthTest(false);
      device.setDepthWrite(false);
      device.setBlend('none');
      device.setCull('none');
      device.setColorMask(true, true, true, true);
      device.drawFullscreen();

      this.stats.overlay = true;
      // The copy no longer matches what is on screen.
      this._copyFrame = -1;
      return true;
    } catch (err) {
      if (!this._drawError) {
        this._drawError = true;
        console.error('[VOXELIA] water: underwater overlay failed.', err);
      }
      return false;
    } finally {
      try {
        this.device.setDepthWrite(true);
        this.device.setCull('back');
      } catch (err) { /* context lost */ }
    }
  }

  /* ======================================================================= */
  /* Teardown                                                                */
  /* ======================================================================= */

  /**
   * Release every GPU resource this pass owns. Safe to call more than once.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._disposePrograms();
    try {
      if (this._copyFBO && typeof this._copyFBO.dispose === 'function') this._copyFBO.dispose();
    } catch (err) { /* already gone */ }
    this._copyFBO = null;
    try {
      if (this.sceneCopy) this.device.deleteTexture(this.sceneCopy);
      if (this.depthCopy) this.device.deleteTexture(this.depthCopy);
    } catch (err) { /* already gone */ }
    this.sceneCopy = null;
    this.depthCopy = null;
    this._textures = null;
    this._skyLUT = null;
    this._copyValid = false;
    this._drawProgram = null;
  }
}

