/**
 * @file render/lightingpass.js — VOXELIA deferred PBR composite (spec 5.21).
 *
 * This is the pass where the G-buffer becomes an image. One fullscreen triangle
 * reads the four G-buffer attachments plus depth (units **3..7**), the SSAO
 * result (**9**), the sky LUT (**10**), the blue-noise mask (**11**) and the
 * cascaded shadow array (**12**), and writes linear HDR radiance into the target
 * framebuffer (`RGBA16F`). Nothing is tonemapped here — `render/post.js` owns
 * exposure, ACES and grading.
 *
 * ### What one pixel costs
 *
 * ```
 *   depth ──► worldFromDepth ──► world position, view ray, view depth
 *
 *   1. sun     evalDirect(GGX)  x sampleShadow(CSM) x smoothstep(bakedSkyLight)
 *   2. moon    evalDirect(GGX)  x same shadow, cool tint, ~1/50 intensity,
 *                               modulated by the moon phase (u_moonDir.w)
 *   3. ambient evalAmbient(hemisphere sky/ground) x skyLight x AO
 *              + ground bounce tinted by the dominant terrain albedo
 *   4. block   colored voxel light -> a virtual point-ish light with a real
 *              GGX lobe, so a torch glints off polished blocks
 *   5. sss     wrapped diffuse + view-dependent back-scatter for foliage
 *   6. emissive albedo * emissive * strong HDR factor (bloom feeds on this)
 *   7. fog     exponential height fog (fogFactor from <fog>), biome fog colour,
 *              sun inscattering, blended into the sky at the far plane
 *   8. shafts  half-resolution raymarched god rays, bilaterally upsampled
 *   9. water   Beer-Lambert absorption (red first) + blue-green medium when
 *              u_params.w == 1
 * ```
 *
 * ### Two passes, not one
 *
 * The volumetric raymarch runs at **half resolution** into its own `RGBA16F`
 * target (`rgb` = in-scattered radiance, `a` = the linear view depth the ray was
 * marched to) and is then **bilaterally upsampled inside the composite shader**
 * — no third fullscreen pass, no extra bandwidth, and the depth in `.a` is
 * exactly what the bilateral weight needs. Marching 16..48 steps at quarter the
 * pixel count is 4x cheaper than doing it inline, and the blue-noise-jittered
 * start plus TAA hides the resolution loss completely.
 *
 * ### Sky pixels
 *
 * Fragments at `depth == 1.0` are the background. By default (`skyFill = true`)
 * the pass fills them with `analyticSky()` + sun/moon disks + the volumetric
 * term, so the composite alone already produces a complete frame. When
 * `render/sky.js` draws its (much better) background *after* this pass it simply
 * overwrites that fill; call {@link LightingPass#renderVolumetricOverlay}
 * afterwards to put the god rays back on top of the real sky. Set
 * `skyFill = false` to `discard` background fragments instead and keep whatever
 * the target already holds.
 *
 * ### Everything is switchable
 *
 * Every block above sits behind a `#define` (`USE_SHADOWS`, `USE_SSAO`,
 * `USE_SUBSURFACE`, `USE_VOLUMETRIC`, `USE_FOG`, `USE_UNDERWATER`,
 * `USE_SKY_LUT`, `USE_SKY_PROBE`, `BLOCK_LIGHT_GRADIENT`, `SOFT_SHADOWS`,
 * `SHADOW_PCF_TAPS`, `VOL_STEPS`, `VOL_NOISE`). The programs are rebuilt only
 * when the derived define set actually changes, so a low preset compiles a
 * genuinely small shader instead of branching around dead code.
 *
 * @module render/lightingpass
 */

import { FULLSCREEN_VS } from '../core/gl.js';
import { clamp } from '../core/math.js';

/* ------------------------------------------------------------------------- */
/* Constants                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Fixed texture units this pass reads (ARCHITECTURE.md 3.5). Unit 15 is the
 * documented "free / per-pass" slot and carries the half-resolution volumetric
 * buffer.
 * @type {Readonly<{G_ALBEDO:number, G_NORMAL:number, G_LIGHT:number,
 *   G_EXTRA:number, G_DEPTH:number, SSAO:number, SKY_LUT:number,
 *   BLUE_NOISE:number, SHADOW_MAP:number, VOLUMETRIC:number}>}
 */
export const LIGHTING_UNITS = Object.freeze({
  G_ALBEDO: 3,
  G_NORMAL: 4,
  G_LIGHT: 5,
  G_EXTRA: 6,
  G_DEPTH: 7,
  SSAO: 9,
  SKY_LUT: 10,
  BLUE_NOISE: 11,
  SHADOW_MAP: 12,
  VOLUMETRIC: 15,
});

/** Frame UBO binding point (ARCHITECTURE.md 3.3). @type {number} */
export const FRAME_UBO_BINDING = 0;

/** Shadows UBO binding point (ARCHITECTURE.md 3.4). @type {number} */
export const SHADOW_UBO_BINDING = 1;

/**
 * Raymarch step count per `settings.cloudQuality` step. `cloudQuality` is the
 * closest thing the settings contract has to a "sky/atmosphere budget" knob and
 * the quality presets move it together with `volumetricLight`.
 * @type {Readonly<Object<string, number>>}
 */
export const VOLUMETRIC_STEPS = Object.freeze({
  off: 16,
  low: 16,
  medium: 24,
  high: 32,
  ultra: 48,
});

/**
 * Parameterization this pass expects from the sky LUT on unit 10 when
 * {@link LightingPass#skyLUTMix} is greater than zero.
 *
 * ```glsl
 * u = atan(dir.z, dir.x) / TAU + 0.5      // azimuth, wraps
 * v = sqrt(saturate(dir.y * 0.5 + 0.5))   // elevation, denser near the horizon
 * ```
 *
 * `render/sky.js` may store its LUT any way it likes; until it advertises this
 * layout (`sky.lutLayout === 'latlong'`) the mix stays at 0 and the pass uses
 * `analyticSky()` from the `sky` chunk instead — the LUT is a refinement, never
 * a requirement.
 * @type {Readonly<{mapping:string, u:string, v:string}>}
 */
export const SKY_LUT_LAYOUT = Object.freeze({
  mapping: 'latlong',
  u: 'atan(dir.z, dir.x) / TAU + 0.5',
  v: 'sqrt(saturate(dir.y * 0.5 + 0.5))',
});

/** Default cool moon tint. @type {ReadonlyArray<number>} */
const MOON_TINT = Object.freeze([0.55, 0.68, 1.0]);

/** Moonlight as a fraction of the sun's intensity. @type {number} */
const MOON_SUN_RATIO = 1 / 50;

/** Fallback sun intensity when neither frame nor environment reports one. */
const DEFAULT_SUN_INTENSITY = 3.0;

/* ------------------------------------------------------------------------- */
/* Shared GLSL                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Bilateral upsample of the half-resolution volumetric buffer.
 *
 * `u_volumetric` stores `rgb` = in-scattered radiance and `a` = the linear view
 * depth the half-res ray stopped at, so the depth weight needs no second
 * texture. The four taps are point-sampled (the target is NEAREST) and weighted
 * by the bilinear footprint times `exp(-|dz| * sigma)`.
 * @type {string}
 */
const VOLUMETRIC_UPSAMPLE_GLSL = `
vec3 lightingVolumetric(vec2 uv, float linDepth) {
  vec2 st = uv * u_volTarget.xy - 0.5;
  vec2 baseTexel = floor(st);
  vec2 frc = st - baseTexel;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 2; ++j) {
    for (int i = 0; i < 2; ++i) {
      vec2 tc = (baseTexel + vec2(float(i), float(j)) + 0.5) * u_volTarget.zw;
      vec4 s = texture(u_volumetric, clamp(tc, vec2(0.0), vec2(1.0)));
      float bw = (i == 0 ? 1.0 - frc.x : frc.x) * (j == 0 ? 1.0 - frc.y : frc.y);
      float dw = exp(-abs(s.a - linDepth) * max(u_volParams2.w, 0.0));
      float w = bw * dw + 1.0e-4;
      acc += s.rgb * w;
      wsum += w;
    }
  }
  return acc / max(wsum, 1.0e-5);
}
`;

/* ------------------------------------------------------------------------- */
/* Composite shader                                                           */
/* ------------------------------------------------------------------------- */

/**
 * The deferred composite fragment shader.
 *
 * Reads units 3..7, 9, 10, 11, 12 and 15; writes linear HDR radiance. Every
 * feature is behind a define so a low preset compiles a small shader.
 * @type {string}
 */
const COMPOSITE_FS = `
#include <frame>
#include <math>
#include <color>
#include <depth>
#include <pbr>
#include <fog>
#include <sky>
#ifdef USE_SHADOWS
#include <shadows>
#endif

in vec2 v_uv;
layout(location = 0) out vec4 o_color;

uniform sampler2D u_gAlbedo;   // unit 3  - rgb albedo, a metallic
uniform sampler2D u_gNormal;   // unit 4  - rgb world normal*0.5+0.5, a roughness
uniform sampler2D u_gLight;    // unit 5  - rgb baked voxel light, a sky light
uniform sampler2D u_gExtra;    // unit 6  - r AO, g matFlags/255, b emissive, a subsurface
uniform sampler2D u_gDepth;    // unit 7  - DEPTH_COMPONENT32F
#ifdef USE_SSAO
uniform sampler2D u_ssao;      // unit 9
#endif
#ifdef USE_SKY_LUT
uniform sampler2D u_skyLUT;    // unit 10
#endif
#ifdef USE_VOLUMETRIC
uniform sampler2D u_volumetric; // unit 15 (half resolution)
#endif
// u_shadowMap (unit 12, sampler2DArray) is declared by the <shadows> chunk.

/** rgb sky ambient, w = intensity (w < 0 -> fall back to u_skyAmbient). */
uniform vec4 u_ambientSky;
/** rgb ground ambient, w = intensity (w < 0 -> derive from u_fogColor). */
uniform vec4 u_ambientGround;
/** rgb dominant terrain albedo, w = ground-bounce strength. */
uniform vec4 u_bounce;
/** x sun multiplier, y sky-light gate low, z gate high, w cave ambient floor. */
uniform vec4 u_sunTerm;
/** rgb moon tint, w = moon intensity before the phase term. */
uniform vec4 u_moonColor;
/** x block-light intensity, y falloff exponent, z gradient confidence, w wrap floor. */
uniform vec4 u_blockTerm;
/** rgb warm tint for neutral block light, w = saturation response. */
uniform vec4 u_blockTint;
/** x emissive strength, y subsurface strength, z AO strength, w ambient multiplier. */
uniform vec4 u_terms;
/** rgb biome fog colour, w = blend against u_fogColor. */
uniform vec4 u_biomeFog;
/** x sun inscattering, y blend-to-sky at the far plane, z far-blend start, w spare. */
uniform vec4 u_fogParams;
/** rgb water extinction per metre, w = distance scale. */
uniform vec4 u_waterAbsorb;
/** rgb water in-scatter colour, w = strength. */
uniform vec4 u_waterTint;
/** x shaft intensity, y max march distance, z 1/scale height, w extinction. */
uniform vec4 u_volParams;
/** x Henyey-Greenstein g, y base density, z rain multiplier, w bilateral sigma. */
uniform vec4 u_volParams2;
/** half-res target: x width, y height, z 1/width, w 1/height. */
uniform vec4 u_volTarget;
/** x LUT mix, y LUT scale, z sky-probe scale, w sky-probe mix. */
uniform vec4 u_skyLutParams;

#ifdef USE_VOLUMETRIC
${VOLUMETRIC_UPSAMPLE_GLSL}
#endif

/**
 * Sky radiance for a world direction: the analytic dome from <sky>, optionally
 * refined with the sky LUT on unit 10 (see SKY_LUT_LAYOUT).
 */
vec3 lightingSkyRadiance(vec3 dir) {
  vec3 c = analyticSky(dir);
#ifdef USE_SKY_LUT
  vec3 d = safeNormalize(dir);
  vec2 lutUv = vec2(atan(d.z, d.x) * (1.0 / TAU) + 0.5,
                    sqrt(saturate(d.y * 0.5 + 0.5)));
  vec3 lut = texture(u_skyLUT, lutUv).rgb * max(u_skyLutParams.y, 0.0);
  c = mix(c, lut, saturate(u_skyLutParams.x));
#endif
  return max(c, vec3(0.0));
}

/**
 * Exponential height fog with a biome-tinted colour, sun inscattering and a
 * blend into the sky itself at the far plane (no visible render-distance edge).
 * 'dir' points from the camera toward the shaded surface.
 */
vec3 lightingFog(vec3 color, vec3 worldPos, vec3 dir, float dist) {
  float f = fogFactor(dist);
  if (f <= 0.0) return color;

  float rain = saturate(u_time.w);
  vec3 base = mix(u_fogColor.rgb, max(u_biomeFog.rgb, vec3(0.0)), saturate(u_biomeFog.w));

  // Denser and darker down low, thinner up high.
  float heightBlend = saturate((worldPos.y - (u_params.y - 32.0)) / 112.0);
  base *= mix(0.80, 1.06, heightBlend);
  base = mix(base, base * vec3(0.72, 0.76, 0.84), rain * 0.6);

  // Inscattering: the fog brightens toward the sun.
  vec3 s = safeNormalize(u_sunDir.xyz);
  float sunAmount = saturate(dot(dir, s));
  vec3 sunGlow = u_sunColor.rgb * max(u_sunColor.w, 0.0) * smoothstep(-0.10, 0.15, s.y);
  base += sunGlow * (pow(sunAmount, 8.0) * max(u_fogParams.x, 0.0) * (1.0 - 0.7 * rain));

  // At the edge of the render distance the fog becomes the sky.
  float renderDist = max(u_params.x, 32.0);
  float start = clamp(u_fogParams.z, 0.05, 0.98);
  float edge = saturate((dist - renderDist * start) / max(renderDist * (1.0 - start), 1.0));
  if (edge > 0.0) {
    base = mix(base, lightingSkyRadiance(dir), edge * edge * saturate(u_fogParams.y));
  }
  return mix(color, base, f);
}

/**
 * Underwater medium: Beer-Lambert absorption over the travelled distance (red
 * dies first), a blue-green in-scatter that brightens toward the sun, and the
 * much denser fog curve fogFactor() already applies when u_params.w == 1.
 */
vec3 lightingWater(vec3 color, vec3 dir, float dist) {
  float d = max(dist, 0.0) * max(u_waterAbsorb.w, 0.0);
  vec3 absorb = exp(-max(u_waterAbsorb.rgb, vec3(0.0)) * d);
  vec3 s = safeNormalize(u_sunDir.xyz);
  float glow = 1.0 + 0.9 * pow(saturate(dot(dir, s)), 4.0) * smoothstep(-0.05, 0.20, s.y);
  vec3 medium = max(u_waterTint.rgb, vec3(0.0)) * (max(u_waterTint.w, 0.0) * glow);
  vec3 col = color * absorb + medium * (vec3(1.0) - absorb);
  return mix(col, medium, fogFactor(dist));
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float rawDepth = texelFetch(u_gDepth, px, 0).r;
  vec3 D = rayFromUV(v_uv);

#ifdef BLOCK_LIGHT_GRADIENT
  // Screen-space derivatives are only well defined in uniform control flow, so
  // the block-light gradient has to be taken before the background early-out.
  float blLum = luminance(texelFetch(u_gLight, px, 0).rgb);
  vec2 blGrad = vec2(dFdx(blLum), dFdy(blLum));
#endif

  // ---- background ---------------------------------------------------------
  if (rawDepth >= 1.0) {
#ifdef FILL_SKY
    vec3 bg = lightingSkyRadiance(D);
    bg += sunDiskColor(D);
    bg += moonDiskColor(D);
#ifdef USE_VOLUMETRIC
    bg += lightingVolumetric(v_uv, u_camDir.w) * max(u_volParams.x, 0.0);
#endif
    o_color = vec4(max(bg, vec3(0.0)), 1.0);
#else
    discard;
#endif
    return;
  }

  // ---- unpack the G-buffer ------------------------------------------------
  vec4 gAlb = texelFetch(u_gAlbedo, px, 0);
  vec4 gNrm = texelFetch(u_gNormal, px, 0);
  vec4 gLit = texelFetch(u_gLight, px, 0);
  vec4 gExt = texelFetch(u_gExtra, px, 0);

  vec3 albedo = max(gAlb.rgb, vec3(0.0));
  float metallic = saturate(gAlb.a);
  vec3 N = safeNormalize(gNrm.xyz * 2.0 - 1.0);
  float roughness = clamp(gNrm.a, 0.045, 1.0);
  vec3 blockLight = max(gLit.rgb, vec3(0.0));
  float skyLight = saturate(gLit.a);
  float bakedAO = saturate(gExt.r);
  float emissive = saturate(gExt.b);
  float subsurf = saturate(gExt.a);

  vec3 worldPos = worldFromDepth(v_uv, rawDepth);
  vec3 toEye = u_camPos.xyz - worldPos;
  float dist = max(length(toEye), 1.0e-4);
  vec3 V = toEye / dist;
  float viewDepth = linearizeDepth(rawDepth);

  // ---- occlusion ----------------------------------------------------------
  // The baked vertex AO and the screen-space AO model the *same* voxel corners,
  // so multiplying them squares the darkening and produces black seams. min()
  // keeps whichever term is more confident and never double-darkens.
  float ao = bakedAO;
#ifdef USE_SSAO
  ao = min(ao, saturate(texture(u_ssao, v_uv).r));
#endif
  ao = mix(1.0, ao, saturate(u_terms.z));

  // ---- key lights ---------------------------------------------------------
  vec3 L = safeNormalize(u_sunDir.xyz);
  vec3 Lm = safeNormalize(u_moonDir.xyz);
  float NoL = dot(N, L);
  float NoLm = dot(N, Lm);

  float sunUp = smoothstep(-0.09, 0.05, L.y);
  float moonUp = smoothstep(-0.06, 0.08, Lm.y) * (1.0 - sunUp);
  float moonPhase = mix(0.06, 1.0, abs(u_moonDir.w * 2.0 - 1.0));

  vec3 sunRadiance = u_sunColor.rgb * max(u_sunColor.w, 0.0) * (sunUp * max(u_sunTerm.x, 0.0));
  vec3 moonRadiance = max(u_moonColor.rgb, vec3(0.0)) * (max(u_moonColor.w, 0.0) * moonPhase * moonUp);

  float shadowTerm = 1.0;
#ifdef USE_SHADOWS
  // The cascades follow whichever body is the key light, so feed sampleShadow
  // the matching NdotL: the sun while it is up, the moon once it has set.
  float keyNoL = mix(NoL, NoLm, step(sunUp, 0.001));
  shadowTerm = sampleShadow(worldPos, keyNoL, viewDepth);
#endif

  // Caves must stay dark even where the shadow cascades do not reach: gate the
  // celestial light on the baked sky light so no sun leaks through walls.
  float skyGate = smoothstep(u_sunTerm.y, u_sunTerm.z, skyLight);
  float sunVis = shadowTerm * skyGate;

  vec3 color = vec3(0.0);
  color += evalDirect(albedo, metallic, roughness, N, V, L, sunRadiance * sunVis);
  if (moonUp > 0.0) {
    color += evalDirect(albedo, metallic, roughness, N, V, Lm, moonRadiance * sunVis);
  }

  // ---- subsurface: the reason a forest reads as a forest ------------------
#ifdef USE_SUBSURFACE
  if (subsurf > 0.0 && u_terms.y > 0.0) {
    float trans = subsurf * max(u_terms.y, 0.0) * skyGate * mix(0.35, 1.0, shadowTerm);
    float wrapS = wrapDiffuse(NoL, 0.75);
    float backS = pow(saturate(dot(V, -L)), 5.0);
    color += albedo * sunRadiance * (trans * (0.45 * wrapS + 1.15 * backS));
    if (moonUp > 0.0) {
      float wrapM = wrapDiffuse(NoLm, 0.75);
      float backM = pow(saturate(dot(V, -Lm)), 5.0);
      color += albedo * moonRadiance * (trans * (0.45 * wrapM + 1.15 * backM));
    }
  }
#endif

  // ---- colored voxel light ------------------------------------------------
  // The mesher bakes a 0.8^distance falloff into the light channel; the extra
  // exponent sharpens it back into something that reads as a point light.
  vec3 bl = pow(saturate(blockLight), vec3(max(u_blockTerm.y, 0.05))) * max(u_blockTerm.x, 0.0);
  float blSat = maxComp(blockLight) - minComp(blockLight);
  bl *= mix(max(u_blockTint.rgb, vec3(0.0)), vec3(1.0), saturate(blSat * u_blockTint.w));

#ifdef BLOCK_LIGHT_GRADIENT
  // The baked light rises toward its source, so the screen-space gradient of
  // its luminance points at the torch. That gives the block light a real
  // direction - and therefore a real GGX highlight on polished blocks.
  vec3 camRight = safeNormalize(u_invView[0].xyz);
  vec3 camUp = safeNormalize(u_invView[1].xyz);
  vec3 gradDir = camRight * blGrad.x + camUp * blGrad.y;
  float conf = saturate(length(blGrad) * max(u_blockTerm.z, 0.0));
  vec3 Lb = safeNormalize(mix(N, safeNormalize(gradDir + N * 0.45), conf));
#else
  vec3 Lb = safeNormalize(N * 0.72 + V * 0.28);
#endif
  color += evalDirect(albedo, metallic, roughness, N, V, Lb, bl * ao);
  // Wrap floor: faces turned away from the virtual light still see the room.
  color += albedo * (1.0 - metallic) * bl * (max(u_blockTerm.w, 0.0) * ao);

  // ---- emissive -----------------------------------------------------------
  color += albedo * (emissive * max(u_terms.x, 0.0));

  // ---- sky ambient + ground bounce ---------------------------------------
  vec3 skyCol = u_ambientSky.w < 0.0
    ? u_skyAmbient.rgb * max(u_skyAmbient.w, 0.0)
    : max(u_ambientSky.rgb, vec3(0.0)) * max(u_ambientSky.w, 0.0);
  vec3 groundCol = u_ambientGround.w < 0.0
    ? u_fogColor.rgb * 0.35
    : max(u_ambientGround.rgb, vec3(0.0)) * max(u_ambientGround.w, 0.0);

#ifdef USE_SKY_PROBE
  // Image-based-ish: sample the dome along a normal-biased up direction.
  vec3 probe = lightingSkyRadiance(safeNormalize(N + vec3(0.0, 0.65, 0.0)));
  skyCol = mix(skyCol, probe * max(u_skyLutParams.z, 0.0), saturate(u_skyLutParams.w));
#endif

  float skyMask = mix(saturate(u_sunTerm.w), 1.0, smoothstep(0.0, 0.85, skyLight));
  vec3 ambient = evalAmbient(albedo, metallic, roughness, N, V,
                             skyCol * skyMask, groundCol * skyMask, ao);

  // Light bouncing off the ground, tinted by the dominant terrain albedo.
  float downward = saturate(-N.y * 0.5 + 0.5);
  float bounceEnergy = luminance(sunRadiance) * 0.35 + luminance(skyCol) * 0.25;
  vec3 bounceCol = max(u_bounce.rgb, vec3(0.0)) * (max(u_bounce.w, 0.0) * bounceEnergy);
  ambient += albedo * (1.0 - metallic) * bounceCol * (downward * ao * skyMask);

  color += ambient * max(u_terms.w, 0.0);

  // ---- participating media ------------------------------------------------
  float underwater = saturate(u_params.w);
#ifdef USE_FOG
  if (underwater < 0.5) color = lightingFog(color, worldPos, -V, dist);
#endif
#ifdef USE_UNDERWATER
  if (underwater >= 0.5) color = lightingWater(color, -V, dist);
#endif

#ifdef USE_VOLUMETRIC
  color += lightingVolumetric(v_uv, viewDepth) * max(u_volParams.x, 0.0);
#endif

  o_color = vec4(max(color, vec3(0.0)), 1.0);
}
`;

/* ------------------------------------------------------------------------- */
/* Volumetric shader                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Half-resolution volumetric sun-shaft raymarch.
 *
 * Marches `VOL_STEPS` samples from the camera to the pixel's world position (or
 * to the maximum distance for background pixels), starting at a blue-noise
 * jittered offset so the banding turns into noise that TAA removes. Each step
 * takes a **single** shadow-map tap — the full PCF kernel of `sampleShadow()`
 * would be 16x the cost for a term that is integrated along the ray anyway.
 * Density falls off exponentially with altitude (so it thickens near the
 * ground), rises in rain, and is modulated by a scrolling value noise at the
 * top quality step.
 *
 * Output: `rgb` = in-scattered radiance, `a` = the linear view depth the ray
 * stopped at (the bilateral upsample weight in the composite).
 * @type {string}
 */
const VOLUMETRIC_FS = `
#include <frame>
#include <math>
#include <depth>
#ifdef VOL_NOISE
#include <noise>
#endif
#ifdef USE_SHADOWS
#include <shadows>
#endif

#ifndef VOL_STEPS
#define VOL_STEPS 32
#endif

in vec2 v_uv;
layout(location = 0) out vec4 o_frag;

uniform sampler2D u_gDepth;     // unit 7 (full resolution)
uniform sampler2D u_blueNoise;  // unit 11
// u_shadowMap (unit 12) comes from the <shadows> chunk.

/** x shaft intensity (applied in the composite), y max distance, z 1/scale height, w extinction. */
uniform vec4 u_volParams;
/** x Henyey-Greenstein g, y base density, z rain multiplier, w bilateral sigma. */
uniform vec4 u_volParams2;
/** x frame index (0 when TAA is off), y jitter amount, z noise scale, w noise strength. */
uniform vec4 u_volNoise;
/** rgb moon tint, w = moon intensity before the phase term. */
uniform vec4 u_moonColor;

/** Henyey-Greenstein phase function. */
float hgPhase(float cosTheta, float g) {
  float gg = clamp(g, -0.95, 0.95);
  float g2 = gg * gg;
  float denom = 1.0 + g2 - 2.0 * gg * cosTheta;
  return (1.0 - g2) / (4.0 * PI * pow(max(denom, 1.0e-4), 1.5));
}

/** Blue-noise (or hash) dither in [0,1), rotated per frame by the golden ratio. */
float volDither(ivec2 px) {
#ifdef NO_BLUE_NOISE
  float n = hash21(vec2(px));
#else
  ivec2 ns = max(textureSize(u_blueNoise, 0), ivec2(1));
  float n = texelFetch(u_blueNoise, ivec2(px.x % ns.x, px.y % ns.y), 0).r;
#endif
  return fract(n + u_volNoise.x * 0.6180339887498949);
}

/** Medium density at a world position. */
float volDensity(vec3 p) {
  float h = p.y - u_params.y;
  float d = exp(-max(h, -96.0) * max(u_volParams.z, 0.0));
  d *= mix(1.0, max(u_volParams2.z, 1.0), saturate(u_time.w));
#ifdef VOL_NOISE
  vec3 q = p * max(u_volNoise.z, 1.0e-4) + vec3(u_time.x * 0.021, u_time.x * 0.007, u_time.x * 0.013);
  d *= mix(1.0, 0.35 + 1.30 * valueNoise3(q), saturate(u_volNoise.w));
#endif
  return d * max(u_volParams2.y, 0.0);
}

/** One-tap cascaded shadow test - 16x cheaper than the PCF kernel per step. */
float volShadow(vec3 p, float viewDepth) {
#ifdef USE_SHADOWS
  int count = int(u_shadowParams.x + 0.5);
  if (count <= 0) return 1.0;
  int cascade = 0;
  if (viewDepth > u_csmSplits.x) cascade = 1;
  if (viewDepth > u_csmSplits.y) cascade = 2;
  if (viewDepth > u_csmSplits.z) cascade = 3;
  cascade = min(cascade, count - 1);

  vec4 clip = csmMatrix(cascade) * vec4(p, 1.0);
  float w = abs(clip.w) < 1.0e-6 ? 1.0 : clip.w;
  vec3 uvz = clip.xyz / w * 0.5 + 0.5;
  if (any(lessThan(uvz, vec3(0.0))) || any(greaterThan(uvz, vec3(1.0)))) return 1.0;

  float bias = max(u_shadowParams.y, 0.0) * 2.0;
  return step(uvz.z - bias, shadowFetch(uvz.xy, cascade));
#else
  return 1.0;
#endif
}

void main() {
  ivec2 hpx = ivec2(gl_FragCoord.xy);
  ivec2 size = max(textureSize(u_gDepth, 0), ivec2(1));
  ivec2 fpx = min(hpx * 2, size - 1);

  // Nearest of the 2x2 full-res texels: shafts must never bleed in front of
  // geometry; the bilateral upsample repairs the silhouettes afterwards.
  float d0 = texelFetch(u_gDepth, fpx, 0).r;
  float d1 = texelFetch(u_gDepth, min(fpx + ivec2(1, 0), size - 1), 0).r;
  float d2 = texelFetch(u_gDepth, min(fpx + ivec2(0, 1), size - 1), 0).r;
  float d3 = texelFetch(u_gDepth, min(fpx + ivec2(1, 1), size - 1), 0).r;
  float rawDepth = min(min(d0, d1), min(d2, d3));

  vec2 uvFull = (vec2(fpx) + 0.5) / vec2(size);
  vec3 D = rayFromUV(uvFull);

  float maxDist = max(u_volParams.y, 1.0);
  float linDepth;
  float marchLen;
  if (rawDepth >= 1.0) {
    linDepth = u_camDir.w;
    marchLen = maxDist;
  } else {
    linDepth = linearizeDepth(rawDepth);
    marchLen = min(length(worldFromDepth(uvFull, rawDepth) - u_camPos.xyz), maxDist);
  }
  if (marchLen <= 1.0e-3) {
    o_frag = vec4(0.0, 0.0, 0.0, linDepth);
    return;
  }

  // Key light: the sun while it is up, the moon afterwards - the cascades
  // follow the same body, so the shaft always matches the shadows.
  vec3 sunL = safeNormalize(u_sunDir.xyz);
  vec3 moonL = safeNormalize(u_moonDir.xyz);
  float sunUp = smoothstep(-0.09, 0.05, sunL.y);
  float moonUp = smoothstep(-0.06, 0.08, moonL.y) * (1.0 - sunUp);
  float moonPhase = mix(0.06, 1.0, abs(u_moonDir.w * 2.0 - 1.0));

  vec3 keyDir = sunUp > 0.001 ? sunL : moonL;
  vec3 keyColor = sunUp > 0.001
    ? u_sunColor.rgb * max(u_sunColor.w, 0.0) * sunUp
    : max(u_moonColor.rgb, vec3(0.0)) * (max(u_moonColor.w, 0.0) * moonPhase * moonUp);

  float phase = hgPhase(dot(D, keyDir), u_volParams2.x);
  float steps = float(VOL_STEPS);
  float dt = marchLen / steps;
  float offset = mix(0.5, volDither(hpx), saturate(u_volNoise.y));

  vec3 camFwd = safeNormalize(u_camDir.xyz);
  vec3 p = u_camPos.xyz + D * (dt * offset);
  float extinction = max(u_volParams.w, 0.0);
  float transmittance = 1.0;
  float scatter = 0.0;

  for (int i = 0; i < VOL_STEPS; ++i) {
    float density = volDensity(p);
    float optical = density * dt;
    if (optical > 0.0) {
      float vis = volShadow(p, dot(p - u_camPos.xyz, camFwd));
      scatter += transmittance * vis * optical;
      transmittance *= exp(-optical * extinction);
    }
    p += D * dt;
  }

  o_frag = vec4(max(keyColor * (scatter * phase), vec3(0.0)), linDepth);
}
`;

/* ------------------------------------------------------------------------- */
/* Volumetric overlay shader                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Additive overlay that puts the god rays back on top of a sky background that
 * was drawn *after* the composite. Only touches fragments at `depth == 1.0`, so
 * it can never double-add on geometry.
 * @type {string}
 */
const VOLUMETRIC_OVERLAY_FS = `
#include <frame>
#include <math>

in vec2 v_uv;
layout(location = 0) out vec4 o_color;

uniform sampler2D u_gDepth;
uniform sampler2D u_volumetric;
uniform vec4 u_volParams;
uniform vec4 u_volParams2;
uniform vec4 u_volTarget;

${VOLUMETRIC_UPSAMPLE_GLSL}

void main() {
  float rawDepth = texelFetch(u_gDepth, ivec2(gl_FragCoord.xy), 0).r;
  if (rawDepth < 1.0) discard;
  vec3 c = lightingVolumetric(v_uv, u_camDir.w) * max(u_volParams.x, 0.0);
  o_color = vec4(max(c, vec3(0.0)), 0.0);
}
`;

/* ------------------------------------------------------------------------- */
/* LightingPass                                                               */
/* ------------------------------------------------------------------------- */

/**
 * The deferred PBR composite.
 *
 * ```js
 * const lighting = new LightingPass(gl, settings);
 * lighting.resize(width, height);
 * lighting.render(gbuffer, shadowMapper, ssao, sky, frame, environment, hdrFbo);
 * // optional, only after Sky#renderBackground has overwritten the sky pixels:
 * lighting.renderVolumetricOverlay(gbuffer, hdrFbo);
 * ```
 */
export class LightingPass {
  /**
   * @param {import('../core/gl.js').GL} gl VOXELIA WebGL2 device.
   * @param {{get:function(string):*, on?:function(string,Function):*,
   *          off?:function(string,Function):*}} [settings] settings store.
   */
  constructor(gl, settings) {
    /** @type {import('../core/gl.js').GL} Owning device. */
    this.device = gl;
    /** @type {WebGL2RenderingContext} Raw context. */
    this.gl = gl.gl;
    /** @type {?Object} Settings store (may be null in tests). */
    this.settings = settings || null;

    /** @type {number} Full-resolution width in pixels. */
    this.width = Math.max(1, this.gl.drawingBufferWidth || 1);
    /** @type {number} Full-resolution height in pixels. */
    this.height = Math.max(1, this.gl.drawingBufferHeight || 1);
    /** @type {number} Half-resolution width of the volumetric target. */
    this.halfWidth = Math.max(1, Math.ceil(this.width / 2));
    /** @type {number} Half-resolution height of the volumetric target. */
    this.halfHeight = Math.max(1, Math.ceil(this.height / 2));

    /* ---- public tunables ------------------------------------------------- */

    /** @type {boolean} Fill `depth == 1` fragments with the analytic sky. */
    this.skyFill = true;
    /** @type {number} Multiplier on the sun radiance from the Frame UBO. */
    this.sunIntensity = 1.0;
    /** @type {number} Baked sky light where the sun starts to reach a surface. */
    this.skyGateLow = 0.08;
    /** @type {number} Baked sky light where the sun reaches a surface fully. */
    this.skyGateHigh = 0.55;
    /** @type {number} Ambient left in a fully enclosed cave, 0..1. */
    this.caveAmbient = 0.05;
    /** @type {number[]} Cool moon tint, linear rgb. */
    this.moonTint = [MOON_TINT[0], MOON_TINT[1], MOON_TINT[2]];
    /** @type {number} Moonlight as a fraction of the sun intensity (~1/50). */
    this.moonRatio = MOON_SUN_RATIO;
    /** @type {number} Absolute moon intensity; recomputed per frame when 0. */
    this.moonIntensity = 0;
    /** @type {number} Multiplier on the hemispheric ambient term. */
    this.ambientIntensity = 1.0;
    /** @type {number[]} Dominant terrain albedo used by the ground bounce. */
    this.groundAlbedo = [0.30, 0.29, 0.21];
    /** @type {number} Ground-bounce strength. */
    this.bounceStrength = 0.35;
    /** @type {number} Colored voxel-light intensity (~PI compensates 1/PI diffuse). */
    this.blockLightIntensity = 3.0;
    /** @type {number} Extra falloff exponent applied to the baked block light. */
    this.blockLightCurve = 1.35;
    /** @type {number} Confidence scale of the screen-space block-light gradient. */
    this.blockLightGradientScale = 60.0;
    /** @type {number} Omnidirectional floor of the block-light diffuse. */
    this.blockLightWrap = 0.35;
    /** @type {number[]} Warm tint applied to *neutral* block light. */
    this.blockLightTint = [1.0, 0.72, 0.42];
    /** @type {number} How fast saturated block light keeps its own hue. */
    this.blockLightTintResponse = 6.0;
    /** @type {number} HDR emissive factor (bloom feeds on this). */
    this.emissiveStrength = 6.0;
    /** @type {number} Foliage subsurface strength. */
    this.subsurfaceStrength = 1.0;
    /** @type {number} AO strength, 0 disables occlusion entirely. */
    this.aoStrength = 1.0;
    /** @type {number} Blend of the biome fog colour over `u_fogColor`. */
    this.biomeFogBlend = 1.0;
    /** @type {number} Sun inscattering strength in the fog. */
    this.fogInscatter = 0.6;
    /** @type {number} How completely the fog becomes the sky at the far plane. */
    this.fogSkyBlend = 1.0;
    /** @type {number} Fraction of the render distance where that blend starts. */
    this.fogSkyStart = 0.72;
    /** @type {number[]} Water extinction per metre — red dies first. */
    this.waterAbsorption = [0.42, 0.11, 0.06];
    /** @type {number} Distance scale applied to the water extinction. */
    this.waterAbsorptionScale = 1.0;
    /** @type {number[]} Blue-green colour of the underwater medium. */
    this.waterTint = [0.05, 0.16, 0.20];
    /** @type {number} Strength of the underwater in-scatter. */
    this.waterTintStrength = 0.8;
    /** @type {number} Volumetric shaft intensity. */
    this.volumetricIntensity = 1.0;
    /** @type {number} Maximum raymarch distance in blocks. */
    this.volumetricDistance = 160;
    /** @type {number} Inverse scale height of the medium. */
    this.volumetricHeightFalloff = 0.012;
    /** @type {number} Extinction applied to the accumulated optical depth. */
    this.volumetricExtinction = 4.0;
    /** @type {number} Henyey-Greenstein anisotropy of the shafts. */
    this.volumetricAnisotropy = 0.72;
    /** @type {number} Base medium density at sea level. */
    this.volumetricDensity = 0.0016;
    /** @type {number} Density multiplier at full rain. */
    this.volumetricRainDensity = 3.0;
    /** @type {number} Bilateral depth sigma of the volumetric upsample. */
    this.volumetricBilateral = 0.6;
    /** @type {number} World scale of the volumetric detail noise. */
    this.volumetricNoiseScale = 0.045;
    /** @type {number} Strength of the volumetric detail noise, 0..1. */
    this.volumetricNoiseStrength = 0.55;
    /** @type {number} Mix of the sky LUT (unit 10) over `analyticSky`, 0..1. */
    this.skyLUTMix = 0;
    /** @type {number} Scale applied to sky LUT samples. */
    this.skyLUTScale = 1.0;
    /** @type {number} Scale of the sky-probe ambient. */
    this.skyProbeScale = 1.0;
    /** @type {number} Mix of the sky-probe ambient over `Sky.getAmbient()`. */
    this.skyProbeMix = 0.5;

    /* ---- injected resources --------------------------------------------- */

    /** @type {?WebGLTexture} Blue-noise mask (unit 11); see setBlueNoise. */
    this.blueNoise = null;
    /** @type {?WebGLTexture} Sky LUT override (unit 10); see setSkyLUT. */
    this.skyLUT = null;

    /* ---- GPU resources --------------------------------------------------- */

    /** @type {?Object} Composite program. @private */
    this._composite = null;
    /** @type {?Object} Half-res volumetric program. @private */
    this._volume = null;
    /** @type {?Object} Additive sky overlay program. @private */
    this._overlay = null;
    /** @type {?WebGLTexture} Half-res volumetric buffer (rgb scatter, a depth). */
    this.volumetricTexture = null;
    /** @type {?Object} Framebuffer wrapping {@link LightingPass#volumetricTexture}. @private */
    this._volFBO = null;

    /* ---- live state ------------------------------------------------------ */

    /**
     * Per-frame statistics for the debug overlay.
     * @type {{drawCalls:number, volumetric:boolean, steps:number, tier:string}}
     */
    this.stats = { drawCalls: 0, volumetric: false, steps: 0, tier: 'high' };

    /** @type {boolean} True while the volumetric buffer holds a usable frame. @private */
    this._volValid = false;
    /** @type {number} Bitmask of the resources available at the last build. @private */
    this._availKey = -1;
    /** @type {boolean} Rebuild the programs on the next frame. @private */
    this._programsDirty = true;
    /** @type {boolean} True once the missing-float warning was logged. @private */
    this._floatWarned = false;
    /** @type {boolean} True once a failure has been reported (log once). @private */
    this._failed = false;
    /** @type {boolean} @private */
    this._disposed = false;
    /** @type {number} Fallback frame counter when the frame carries no index. @private */
    this._frameCounter = 0;

    /* ---- scratch (no per-frame allocation) ------------------------------- */

    this._vAmbientSky = new Float32Array(4);
    this._vAmbientGround = new Float32Array(4);
    this._vBounce = new Float32Array(4);
    this._vSunTerm = new Float32Array(4);
    this._vMoonColor = new Float32Array(4);
    this._vBlockTerm = new Float32Array(4);
    this._vBlockTint = new Float32Array(4);
    this._vTerms = new Float32Array(4);
    this._vBiomeFog = new Float32Array(4);
    this._vFogParams = new Float32Array(4);
    this._vWaterAbsorb = new Float32Array(4);
    this._vWaterTint = new Float32Array(4);
    this._vVolParams = new Float32Array(4);
    this._vVolParams2 = new Float32Array(4);
    this._vVolTarget = new Float32Array(4);
    this._vVolNoise = new Float32Array(4);
    this._vSkyLut = new Float32Array(4);

    this._onSettingsChange = () => { this._programsDirty = true; };
    if (this.settings && typeof this.settings.on === 'function') {
      try { this.settings.on('change', this._onSettingsChange); } catch (err) { /* ignore */ }
    }

    this._createTargets();
  }

  /* ----------------------------------------------------------------------- */
  /* Settings plumbing                                                        */
  /* ----------------------------------------------------------------------- */

  /**
   * Read a setting, tolerating a missing store or an unknown key.
   * @param {string} key setting key
   * @param {*} fallback value used when the setting is unavailable
   * @returns {*} the stored value or `fallback`
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
   * Coarse quality tier derived from the graphics flags the presets move
   * together. Drives the PCF tap count, the sky probe, the block-light gradient
   * and the volumetric detail noise.
   * @returns {'low'|'medium'|'high'} quality tier
   * @private
   */
  _qualityTier() {
    let score = 0;
    if (this._setting('shadows', true) !== false) score++;
    if (this._setting('softShadows', true) !== false) score++;
    if (this._setting('ssao', true) !== false) score++;
    if (this._setting('volumetricLight', true) !== false) score++;
    if (score <= 1) return 'low';
    if (score <= 3) return 'medium';
    return 'high';
  }

  /**
   * Raymarch step count for the current `cloudQuality` step, clamped to 16..48.
   * @returns {number} number of steps
   * @private
   */
  _volumetricSteps() {
    const key = String(this._setting('cloudQuality', 'high')).toLowerCase();
    const steps = VOLUMETRIC_STEPS[key] === undefined ? VOLUMETRIC_STEPS.high : VOLUMETRIC_STEPS[key];
    return clamp(steps | 0, 16, 48);
  }

  /* ----------------------------------------------------------------------- */
  /* GPU resources                                                            */
  /* ----------------------------------------------------------------------- */

  /**
   * Allocate the half-resolution volumetric target.
   * @returns {boolean} true when the target is usable
   * @private
   */
  _createTargets() {
    const gl = this.gl;
    this._destroyTargets();
    if (!this.device.caps.colorBufferFloat) {
      // Without renderable float there is nowhere to put HDR in-scattering.
      if (!this._floatWarned) {
        this._floatWarned = true;
        console.warn('[lightingpass] EXT_color_buffer_float missing — volumetric light disabled.');
      }
      return false;
    }
    try {
      this.volumetricTexture = this.device.createTexture({
        target: gl.TEXTURE_2D,
        width: this.halfWidth,
        height: this.halfHeight,
        internalFormat: gl.RGBA16F,
        min: 'nearest',
        mag: 'nearest',
        wrap: 'clamp',
        mips: false,
      });
      this._volFBO = this.device.createFramebuffer({
        name: 'lighting-volumetric',
        color: [this.volumetricTexture],
        width: this.halfWidth,
        height: this.halfHeight,
      });
      if (!this._volFBO || this._volFBO.complete === false) {
        this._destroyTargets();
        console.warn('[lightingpass] volumetric framebuffer incomplete — shafts disabled.');
        return false;
      }
      this._clearVolumetric();
      return true;
    } catch (err) {
      this._destroyTargets();
      console.warn('[lightingpass] could not allocate the volumetric target:', err);
      return false;
    }
  }

  /**
   * Zero the volumetric buffer. Fresh (and freshly resized) texture storage has
   * undefined contents, and the composite adds it unconditionally, so it must
   * never be read before the raymarch has written it.
   * @returns {void}
   * @private
   */
  _clearVolumetric() {
    this._volValid = false;
    if (!this._volFBO) return;
    try {
      this.device.bindTexture(LIGHTING_UNITS.VOLUMETRIC, this.gl.TEXTURE_2D, null);
      this.device.setScissor(false);
      this.device.setColorMask(true, true, true, true);
      this.device.bindFramebuffer(this._volFBO);
      this.device.clear([0, 0, 0, 0]);
      this.device.bindFramebuffer(null);
    } catch (err) {
      /* never throw during a frame */
    }
  }

  /**
   * Delete the volumetric target.
   * @returns {void}
   * @private
   */
  _destroyTargets() {
    if (this._volFBO && typeof this._volFBO.dispose === 'function') {
      try { this._volFBO.dispose(); } catch (err) { /* already gone */ }
    }
    this._volFBO = null;
    if (this.volumetricTexture) {
      try { this.device.deleteTexture(this.volumetricTexture); } catch (err) { /* already gone */ }
      this.volumetricTexture = null;
    }
    this._volValid = false;
  }

  /**
   * (Re)build the composite, volumetric and overlay programs for the current
   * define set. Never throws.
   *
   * @param {boolean} hasShadows shadow array available
   * @param {boolean} hasSSAO AO texture available
   * @param {boolean} hasLut sky LUT available and mixed in
   * @param {boolean} wantVolumetric volumetric shafts enabled
   * @param {boolean} hasNoise blue-noise mask available
   * @returns {void}
   * @private
   */
  _buildPrograms(hasShadows, hasSSAO, hasLut, wantVolumetric, hasNoise) {
    const device = this.device;
    const tier = this._qualityTier();
    const steps = this._volumetricSteps();
    this.stats.tier = tier;
    this.stats.steps = wantVolumetric ? steps : 0;

    const soft = this._setting('softShadows', true) !== false;
    const taps = tier === 'high' ? 16 : (tier === 'medium' ? 12 : 8);

    const compositeDefines = {
      USE_SHADOWS: hasShadows,
      SOFT_SHADOWS: hasShadows && soft && tier !== 'low',
      SHADOW_PCF_TAPS: hasShadows ? taps : 4,
      USE_SSAO: hasSSAO,
      USE_SKY_LUT: hasLut,
      USE_SKY_PROBE: tier !== 'low',
      USE_VOLUMETRIC: wantVolumetric,
      USE_SUBSURFACE: true,
      USE_FOG: true,
      USE_UNDERWATER: true,
      BLOCK_LIGHT_GRADIENT: tier !== 'low',
      FILL_SKY: this.skyFill !== false,
    };

    const volumeDefines = {
      USE_SHADOWS: hasShadows,
      VOL_STEPS: steps,
      VOL_NOISE: tier === 'high',
      NO_BLUE_NOISE: !hasNoise,
    };

    this._disposePrograms();
    try {
      this._composite = device.createProgram('lighting-composite', FULLSCREEN_VS, COMPOSITE_FS,
        { defines: compositeDefines });
      this._composite.bindUBO('Frame', FRAME_UBO_BINDING);
      if (hasShadows) this._composite.bindUBO('Shadows', SHADOW_UBO_BINDING);

      if (wantVolumetric) {
        this._volume = device.createProgram('lighting-volumetric', FULLSCREEN_VS, VOLUMETRIC_FS,
          { defines: volumeDefines });
        this._volume.bindUBO('Frame', FRAME_UBO_BINDING);
        if (hasShadows) this._volume.bindUBO('Shadows', SHADOW_UBO_BINDING);

        this._overlay = device.createProgram('lighting-vol-overlay', FULLSCREEN_VS,
          VOLUMETRIC_OVERLAY_FS, {});
        this._overlay.bindUBO('Frame', FRAME_UBO_BINDING);
      }

      if (!this._composite.program) {
        this._reportFailure('the deferred composite shader failed to compile');
      }
    } catch (err) {
      this._reportFailure(err);
    }
  }

  /**
   * Rebuild the programs when the available resources or the settings changed.
   * @param {boolean} hasShadows shadow array available
   * @param {boolean} hasSSAO AO texture available
   * @param {boolean} hasLut sky LUT available
   * @param {boolean} wantVolumetric volumetric shafts enabled
   * @param {boolean} hasNoise blue-noise mask available
   * @returns {void}
   * @private
   */
  _ensurePrograms(hasShadows, hasSSAO, hasLut, wantVolumetric, hasNoise) {
    const key = (hasShadows ? 1 : 0) | (hasSSAO ? 2 : 0) | (hasLut ? 4 : 0) |
      (wantVolumetric ? 8 : 0) | (hasNoise ? 16 : 0) | (this.skyFill !== false ? 32 : 0);
    if (!this._programsDirty && key === this._availKey && this._composite) return;
    this._availKey = key;
    this._programsDirty = false;
    this._buildPrograms(hasShadows, hasSSAO, hasLut, wantVolumetric, hasNoise);
  }

  /**
   * Delete every program.
   * @returns {void}
   * @private
   */
  _disposePrograms() {
    for (const program of [this._composite, this._volume, this._overlay]) {
      if (program && typeof program.dispose === 'function') {
        try { program.dispose(); } catch (err) { /* already gone */ }
      }
    }
    this._composite = null;
    this._volume = null;
    this._overlay = null;
  }

  /**
   * Log a failure once; the pass then degrades to "do nothing".
   * @param {*} err error or message
   * @returns {void}
   * @private
   */
  _reportFailure(err) {
    if (this._failed) return;
    this._failed = true;
    console.error('[lightingpass] disabled after a failure:', err);
  }

  /* ----------------------------------------------------------------------- */
  /* Public API                                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * Supply the shared blue-noise mask (unit 11) from the `TextureManager`.
   * Without it the volumetric raymarch falls back to a hash dither.
   * @param {?WebGLTexture} texture 2D R8 blue-noise mask
   * @returns {void}
   */
  setBlueNoise(texture) {
    this.blueNoise = texture || null;
  }

  /**
   * Supply a sky LUT for unit 10.
   * @param {?WebGLTexture} texture latlong radiance LUT (see {@link SKY_LUT_LAYOUT})
   * @param {number} [mix=1] how much of it replaces `analyticSky`, 0..1
   * @returns {void}
   */
  setSkyLUT(texture, mix = 1) {
    this.skyLUT = texture || null;
    this.skyLUTMix = texture ? clamp(Number(mix) || 0, 0, 1) : 0;
    this._programsDirty = true;
  }

  /**
   * Reallocate the half-resolution volumetric target for a new screen size.
   * @param {number} w full-resolution width in pixels
   * @param {number} h full-resolution height in pixels
   * @returns {boolean} true when the target is usable afterwards
   */
  resize(w, h) {
    if (this._disposed) return false;
    const nw = Math.max(1, w | 0);
    const nh = Math.max(1, h | 0);
    if (nw === this.width && nh === this.height && this.volumetricTexture) return true;
    this.width = nw;
    this.height = nh;
    this.halfWidth = Math.max(1, Math.ceil(nw / 2));
    this.halfHeight = Math.max(1, Math.ceil(nh / 2));
    this._volValid = false;

    // Resizing in place keeps the texture handle alive, so unit 15 stays valid.
    if (this._volFBO && this.volumetricTexture) {
      try {
        this._volFBO.resize(this.halfWidth, this.halfHeight);
        if (this._volFBO.complete !== false) {
          this._clearVolumetric();
          return true;
        }
      } catch (err) {
        console.warn('[lightingpass] in-place resize failed, rebuilding:', err);
      }
    }
    return this._createTargets();
  }

  /**
   * Composite the G-buffer into linear HDR radiance.
   *
   * Never throws: a missing sub-system (no shadows, no AO, no sky) simply
   * removes its term, and a failed shader disables the pass after one log line.
   *
   * @param {{albedo?:WebGLTexture, normal?:WebGLTexture, light?:WebGLTexture,
   *          extra?:WebGLTexture, depth?:WebGLTexture, targets?:WebGLTexture[],
   *          width?:number, height?:number}} gbuffer the G-buffer (spec 5.17)
   * @param {?{texture?:WebGLTexture, enabled?:boolean}} shadows the shadow mapper (5.18)
   * @param {?{texture?:WebGLTexture, enabled?:boolean}} ssao the AO pass (5.19)
   * @param {?{lut?:WebGLTexture, lutLayout?:string, blueNoise?:WebGLTexture,
   *           getAmbient?:function():{skyColor:number[], groundColor:number[],
   *           sunColor:number[], intensity:number}}} sky the sky (5.20)
   * @param {?{frameIndex?:number, camera?:Object, environment?:Object,
   *           sunIntensity?:number, textures?:Object}} frame the render frame
   * @param {?{fogColor?:number[], biomeFogColor?:number[], groundColor?:number[],
   *           rainStrength?:number, sunIntensity?:number}} environment world state (5.37)
   * @param {?Object} targetFBO destination framebuffer wrapper, or null for the screen
   * @returns {boolean} true when the composite was drawn
   */
  render(gbuffer, shadows, ssao, sky, frame, environment, targetFBO) {
    if (this._disposed || this._failed) return false;
    if (!gbuffer || !gbuffer.depth) return false;

    const device = this.device;
    const gl = this.gl;

    try {
      // ---- resources ------------------------------------------------------
      const gWidth = gbuffer.width | 0;
      const gHeight = gbuffer.height | 0;
      if (gWidth > 0 && gHeight > 0 && (gWidth !== this.width || gHeight !== this.height)) {
        this.resize(gWidth, gHeight);
      }

      const shadowTex = shadows && shadows.enabled !== false ? (shadows.texture || null) : null;
      const ssaoTex = ssao && ssao.enabled !== false ? (ssao.texture || null) : null;
      const noiseTex = this._resolveBlueNoise(sky, frame);
      const lutTex = this._resolveSkyLUT(sky);
      const wantVolumetric = this._setting('volumetricLight', true) !== false &&
        !!this.volumetricTexture && !!this._volFBO && this.volumetricIntensity > 0;

      this._ensurePrograms(!!shadowTex, !!ssaoTex, !!lutTex && this.skyLUTMix > 0,
        wantVolumetric, !!noiseTex);

      const composite = this._composite;
      if (!composite) return false;

      this.stats.drawCalls = 0;
      this.stats.volumetric = false;

      // ---- per-frame uniform values ---------------------------------------
      this._updateUniformData(sky, frame, environment);

      // ---- shared fullscreen state ----------------------------------------
      device.setScissor(false);
      device.setDepthTest(false);
      device.setDepthWrite(false);
      device.setCull('none');
      device.setColorMask(true, true, true, true);
      device.setBlend('none');

      // ---- 1. half-resolution volumetric raymarch -------------------------
      if (wantVolumetric && this._volume) {
        this._renderVolumetric(gbuffer, shadowTex, noiseTex);
      }

      // ---- 2. the composite ------------------------------------------------
      device.bindFramebuffer(targetFBO || null);
      device.setBlend('none');
      if (!composite.use()) return false;

      composite.bindUBO('Frame', FRAME_UBO_BINDING);
      if (shadowTex) composite.bindUBO('Shadows', SHADOW_UBO_BINDING);

      const tex2d = gl.TEXTURE_2D;
      composite.setTexture('u_gAlbedo', this._gbufferTexture(gbuffer, 'albedo', 0),
        LIGHTING_UNITS.G_ALBEDO, tex2d);
      composite.setTexture('u_gNormal', this._gbufferTexture(gbuffer, 'normal', 1),
        LIGHTING_UNITS.G_NORMAL, tex2d);
      composite.setTexture('u_gLight', this._gbufferTexture(gbuffer, 'light', 2),
        LIGHTING_UNITS.G_LIGHT, tex2d);
      composite.setTexture('u_gExtra', this._gbufferTexture(gbuffer, 'extra', 3),
        LIGHTING_UNITS.G_EXTRA, tex2d);
      composite.setTexture('u_gDepth', gbuffer.depth, LIGHTING_UNITS.G_DEPTH, tex2d);
      if (ssaoTex) composite.setTexture('u_ssao', ssaoTex, LIGHTING_UNITS.SSAO, tex2d);
      if (lutTex) composite.setTexture('u_skyLUT', lutTex, LIGHTING_UNITS.SKY_LUT, tex2d);
      if (shadowTex) {
        composite.setTexture('u_shadowMap', shadowTex, LIGHTING_UNITS.SHADOW_MAP,
          gl.TEXTURE_2D_ARRAY);
      }
      if (wantVolumetric) {
        composite.setTexture('u_volumetric', this.volumetricTexture,
          LIGHTING_UNITS.VOLUMETRIC, tex2d);
      }

      this._applyUniforms(composite, true);
      device.drawFullscreen();
      this.stats.drawCalls++;
      return true;
    } catch (err) {
      this._reportFailure(err);
      return false;
    }
  }

  /**
   * Add the volumetric shafts on top of a background that was drawn *after*
   * {@link LightingPass#render} (i.e. by `Sky#renderBackground`). Only touches
   * fragments at `depth == 1.0`, so geometry can never receive the term twice.
   *
   * Call this only when something has overwritten the composite's own sky fill;
   * otherwise the shafts are already there.
   *
   * @param {{depth?:WebGLTexture}} gbuffer the G-buffer (for its depth texture)
   * @param {?Object} targetFBO destination framebuffer wrapper, or null for the screen
   * @returns {boolean} true when the overlay was drawn
   */
  renderVolumetricOverlay(gbuffer, targetFBO) {
    if (this._disposed || this._failed) return false;
    if (!this._overlay || !this._volValid || !this.volumetricTexture) return false;
    if (!gbuffer || !gbuffer.depth) return false;
    const device = this.device;
    const gl = this.gl;
    try {
      device.bindFramebuffer(targetFBO || null);
      device.setScissor(false);
      device.setDepthTest(false);
      device.setDepthWrite(false);
      device.setCull('none');
      device.setColorMask(true, true, true, true);
      device.setBlend('add');
      if (!this._overlay.use()) return false;
      this._overlay.bindUBO('Frame', FRAME_UBO_BINDING);
      this._overlay.setTexture('u_gDepth', gbuffer.depth, LIGHTING_UNITS.G_DEPTH, gl.TEXTURE_2D);
      this._overlay.setTexture('u_volumetric', this.volumetricTexture,
        LIGHTING_UNITS.VOLUMETRIC, gl.TEXTURE_2D);
      this._overlay.setVec4('u_volParams', this._vVolParams);
      this._overlay.setVec4('u_volParams2', this._vVolParams2);
      this._overlay.setVec4('u_volTarget', this._vVolTarget);
      device.drawFullscreen();
      device.setBlend('none');
      this.stats.drawCalls++;
      return true;
    } catch (err) {
      this._reportFailure(err);
      return false;
    }
  }

  /**
   * Release every GPU resource and detach the settings listener.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.settings && typeof this.settings.off === 'function') {
      try { this.settings.off('change', this._onSettingsChange); } catch (err) { /* ignore */ }
    }
    this._disposePrograms();
    this._destroyTargets();
    this.blueNoise = null;
    this.skyLUT = null;
  }

  /* ----------------------------------------------------------------------- */
  /* Internals                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * Render the half-resolution volumetric buffer.
   * @param {Object} gbuffer the G-buffer
   * @param {?WebGLTexture} shadowTex shadow array, or null
   * @param {?WebGLTexture} noiseTex blue-noise mask, or null
   * @returns {void}
   * @private
   */
  _renderVolumetric(gbuffer, shadowTex, noiseTex) {
    const device = this.device;
    const gl = this.gl;
    const program = this._volume;
    if (!program) return;

    // The volumetric texture is about to be a render target: make sure it is
    // not still bound as a sampler on unit 15 (feedback loop).
    device.bindTexture(LIGHTING_UNITS.VOLUMETRIC, gl.TEXTURE_2D, null);
    device.bindFramebuffer(this._volFBO);
    device.setBlend('none');
    if (!program.use()) return;

    program.bindUBO('Frame', FRAME_UBO_BINDING);
    if (shadowTex) program.bindUBO('Shadows', SHADOW_UBO_BINDING);

    program.setTexture('u_gDepth', gbuffer.depth, LIGHTING_UNITS.G_DEPTH, gl.TEXTURE_2D);
    if (noiseTex) program.setTexture('u_blueNoise', noiseTex, LIGHTING_UNITS.BLUE_NOISE, gl.TEXTURE_2D);
    if (shadowTex) {
      program.setTexture('u_shadowMap', shadowTex, LIGHTING_UNITS.SHADOW_MAP, gl.TEXTURE_2D_ARRAY);
    }
    this._applyUniforms(program, false);
    device.drawFullscreen();
    this.stats.drawCalls++;
    this.stats.volumetric = true;
    this._volValid = true;
  }

  /**
   * Push the cached uniform vectors onto a program.
   * @param {Object} program target program
   * @param {boolean} full true for the composite, false for the raymarch
   * @returns {void}
   * @private
   */
  _applyUniforms(program, full) {
    program.setVec4('u_volParams', this._vVolParams);
    program.setVec4('u_volParams2', this._vVolParams2);
    program.setVec4('u_moonColor', this._vMoonColor);
    if (!full) {
      program.setVec4('u_volNoise', this._vVolNoise);
      return;
    }
    program.setVec4('u_volTarget', this._vVolTarget);
    program.setVec4('u_ambientSky', this._vAmbientSky);
    program.setVec4('u_ambientGround', this._vAmbientGround);
    program.setVec4('u_bounce', this._vBounce);
    program.setVec4('u_sunTerm', this._vSunTerm);
    program.setVec4('u_blockTerm', this._vBlockTerm);
    program.setVec4('u_blockTint', this._vBlockTint);
    program.setVec4('u_terms', this._vTerms);
    program.setVec4('u_biomeFog', this._vBiomeFog);
    program.setVec4('u_fogParams', this._vFogParams);
    program.setVec4('u_waterAbsorb', this._vWaterAbsorb);
    program.setVec4('u_waterTint', this._vWaterTint);
    program.setVec4('u_skyLutParams', this._vSkyLut);
  }

  /**
   * Refresh every cached uniform vector from the sky, the frame and the
   * environment. Allocation free.
   * @param {?Object} sky the sky module
   * @param {?Object} frame the render frame
   * @param {?Object} environment world state
   * @returns {void}
   * @private
   */
  _updateUniformData(sky, frame, environment) {
    const env = environment || (frame ? frame.environment : null) || null;

    // ---- ambient ----------------------------------------------------------
    let ambient = null;
    if (sky && typeof sky.getAmbient === 'function') {
      try { ambient = sky.getAmbient(); } catch (err) { ambient = null; }
    }
    const ambientIntensity = ambient && Number.isFinite(ambient.intensity)
      ? ambient.intensity : 1;
    if (ambient && isVec3(ambient.skyColor)) {
      this._vAmbientSky[0] = ambient.skyColor[0];
      this._vAmbientSky[1] = ambient.skyColor[1];
      this._vAmbientSky[2] = ambient.skyColor[2];
      this._vAmbientSky[3] = Math.max(0, ambientIntensity);
    } else {
      // w < 0 tells the shader to fall back to u_skyAmbient from the Frame UBO.
      this._vAmbientSky[0] = 1;
      this._vAmbientSky[1] = 1;
      this._vAmbientSky[2] = 1;
      this._vAmbientSky[3] = -1;
    }
    if (ambient && isVec3(ambient.groundColor)) {
      this._vAmbientGround[0] = ambient.groundColor[0];
      this._vAmbientGround[1] = ambient.groundColor[1];
      this._vAmbientGround[2] = ambient.groundColor[2];
      this._vAmbientGround[3] = Math.max(0, ambientIntensity);
    } else {
      this._vAmbientGround[0] = 1;
      this._vAmbientGround[1] = 1;
      this._vAmbientGround[2] = 1;
      this._vAmbientGround[3] = -1;
    }

    // ---- ground bounce ----------------------------------------------------
    const bounceAlbedo = (env && isVec3(env.groundColor)) ? env.groundColor
      : ((env && isVec3(env.grassColor)) ? env.grassColor : this.groundAlbedo);
    this._vBounce[0] = bounceAlbedo[0];
    this._vBounce[1] = bounceAlbedo[1];
    this._vBounce[2] = bounceAlbedo[2];
    this._vBounce[3] = Math.max(0, this.bounceStrength);

    // ---- sun / moon -------------------------------------------------------
    const lo = Math.min(this.skyGateLow, this.skyGateHigh - 1e-3);
    this._vSunTerm[0] = Math.max(0, this.sunIntensity);
    this._vSunTerm[1] = lo;
    this._vSunTerm[2] = Math.max(lo + 1e-3, this.skyGateHigh);
    this._vSunTerm[3] = clamp(this.caveAmbient, 0, 1);

    let sunIntensity = DEFAULT_SUN_INTENSITY;
    if (frame && Number.isFinite(frame.sunIntensity)) {
      sunIntensity = frame.sunIntensity;
    } else if (env && Number.isFinite(env.sunIntensity)) {
      sunIntensity = env.sunIntensity;
    } else if (ambient && isVec3(ambient.sunColor)) {
      // Only trust the sky's sun colour when it clearly carries HDR intensity;
      // a normalized tint would make the moon vanish.
      const peak = Math.max(ambient.sunColor[0], ambient.sunColor[1], ambient.sunColor[2]);
      if (peak > 1) sunIntensity = peak;
    }
    const moon = this.moonIntensity > 0
      ? this.moonIntensity
      : Math.max(0, sunIntensity) * Math.max(0, this.moonRatio);
    this._vMoonColor[0] = this.moonTint[0];
    this._vMoonColor[1] = this.moonTint[1];
    this._vMoonColor[2] = this.moonTint[2];
    this._vMoonColor[3] = moon;

    // ---- voxel light ------------------------------------------------------
    this._vBlockTerm[0] = Math.max(0, this.blockLightIntensity);
    this._vBlockTerm[1] = Math.max(0.05, this.blockLightCurve);
    this._vBlockTerm[2] = Math.max(0, this.blockLightGradientScale);
    this._vBlockTerm[3] = Math.max(0, this.blockLightWrap);
    this._vBlockTint[0] = this.blockLightTint[0];
    this._vBlockTint[1] = this.blockLightTint[1];
    this._vBlockTint[2] = this.blockLightTint[2];
    this._vBlockTint[3] = Math.max(0, this.blockLightTintResponse);

    // ---- misc terms -------------------------------------------------------
    this._vTerms[0] = Math.max(0, this.emissiveStrength);
    this._vTerms[1] = Math.max(0, this.subsurfaceStrength);
    this._vTerms[2] = clamp(this.aoStrength, 0, 1);
    this._vTerms[3] = Math.max(0, this.ambientIntensity);

    // ---- fog --------------------------------------------------------------
    const fogColor = (env && isVec3(env.biomeFogColor)) ? env.biomeFogColor
      : ((env && isVec3(env.fogColor)) ? env.fogColor : null);
    if (fogColor) {
      this._vBiomeFog[0] = fogColor[0];
      this._vBiomeFog[1] = fogColor[1];
      this._vBiomeFog[2] = fogColor[2];
      this._vBiomeFog[3] = clamp(this.biomeFogBlend, 0, 1);
    } else {
      this._vBiomeFog[0] = 0;
      this._vBiomeFog[1] = 0;
      this._vBiomeFog[2] = 0;
      this._vBiomeFog[3] = 0;
    }
    this._vFogParams[0] = Math.max(0, this.fogInscatter);
    this._vFogParams[1] = clamp(this.fogSkyBlend, 0, 1);
    this._vFogParams[2] = clamp(this.fogSkyStart, 0.05, 0.98);
    this._vFogParams[3] = 0;

    // ---- water ------------------------------------------------------------
    this._vWaterAbsorb[0] = Math.max(0, this.waterAbsorption[0]);
    this._vWaterAbsorb[1] = Math.max(0, this.waterAbsorption[1]);
    this._vWaterAbsorb[2] = Math.max(0, this.waterAbsorption[2]);
    this._vWaterAbsorb[3] = Math.max(0, this.waterAbsorptionScale);
    this._vWaterTint[0] = Math.max(0, this.waterTint[0]);
    this._vWaterTint[1] = Math.max(0, this.waterTint[1]);
    this._vWaterTint[2] = Math.max(0, this.waterTint[2]);
    this._vWaterTint[3] = Math.max(0, this.waterTintStrength);

    // ---- volumetrics ------------------------------------------------------
    this._vVolParams[0] = Math.max(0, this.volumetricIntensity);
    this._vVolParams[1] = Math.max(1, this.volumetricDistance);
    this._vVolParams[2] = Math.max(0, this.volumetricHeightFalloff);
    this._vVolParams[3] = Math.max(0, this.volumetricExtinction);
    this._vVolParams2[0] = clamp(this.volumetricAnisotropy, -0.95, 0.95);
    this._vVolParams2[1] = Math.max(0, this.volumetricDensity);
    this._vVolParams2[2] = Math.max(1, this.volumetricRainDensity);
    this._vVolParams2[3] = Math.max(0, this.volumetricBilateral);
    this._vVolTarget[0] = this.halfWidth;
    this._vVolTarget[1] = this.halfHeight;
    this._vVolTarget[2] = 1 / this.halfWidth;
    this._vVolTarget[3] = 1 / this.halfHeight;

    let index = frame && Number.isFinite(frame.frameIndex) ? frame.frameIndex | 0 : this._frameCounter;
    this._frameCounter = (this._frameCounter + 1) & 0x3fffffff;
    if (this._setting('taa', true) === false) index = 0;
    this._vVolNoise[0] = index % 64;
    this._vVolNoise[1] = 1;
    this._vVolNoise[2] = Math.max(1e-4, this.volumetricNoiseScale);
    this._vVolNoise[3] = clamp(this.volumetricNoiseStrength, 0, 1);

    // ---- sky LUT / probe --------------------------------------------------
    this._vSkyLut[0] = clamp(this.skyLUTMix, 0, 1);
    this._vSkyLut[1] = Math.max(0, this.skyLUTScale);
    this._vSkyLut[2] = Math.max(0, this.skyProbeScale);
    this._vSkyLut[3] = clamp(this.skyProbeMix, 0, 1);
  }

  /**
   * Pick a G-buffer attachment by name, falling back to the `targets` array.
   * @param {Object} gbuffer the G-buffer
   * @param {string} name attachment property name
   * @param {number} index attachment index in `targets`
   * @returns {?WebGLTexture} the texture, or null
   * @private
   */
  _gbufferTexture(gbuffer, name, index) {
    if (gbuffer[name]) return gbuffer[name];
    if (Array.isArray(gbuffer.targets) && gbuffer.targets[index]) return gbuffer.targets[index];
    return null;
  }

  /**
   * Find the blue-noise mask: explicitly injected, or carried by the sky, the
   * frame or its texture manager.
   * @param {?Object} sky the sky module
   * @param {?Object} frame the render frame
   * @returns {?WebGLTexture} a usable mask, or null
   * @private
   */
  _resolveBlueNoise(sky, frame) {
    if (this.blueNoise) return this.blueNoise;
    if (sky && sky.blueNoise) return sky.blueNoise;
    if (frame) {
      if (frame.blueNoise) return frame.blueNoise;
      if (frame.textures && frame.textures.blueNoise) return frame.textures.blueNoise;
    }
    return null;
  }

  /**
   * Find the sky LUT for unit 10. A LUT is only *used* when
   * {@link LightingPass#skyLUTMix} is above zero, which stays 0 until the sky
   * advertises the layout this pass understands ({@link SKY_LUT_LAYOUT}).
   * @param {?Object} sky the sky module
   * @returns {?WebGLTexture} the LUT, or null
   * @private
   */
  _resolveSkyLUT(sky) {
    if (this.skyLUT) return this.skyLUT;
    if (!sky || !sky.lut) return null;
    if (sky.lutLayout === SKY_LUT_LAYOUT.mapping && this.skyLUTMix <= 0) {
      this.skyLUTMix = 1;
      this._programsDirty = true;
    }
    return sky.lut;
  }
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Test whether a value is an array-like of at least three finite numbers.
 * @param {*} v candidate
 * @returns {boolean} true when it can be read as an rgb triple
 */
function isVec3(v) {
  return !!v && typeof v.length === 'number' && v.length >= 3 &&
    Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

export default LightingPass;
