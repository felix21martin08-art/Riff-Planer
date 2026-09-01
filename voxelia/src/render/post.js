/**
 * @file render/post.js — VOXELIA HDR post-processing chain (spec 5.23).
 *
 * Owns everything that happens between the HDR scene buffer produced by
 * `render/lightingpass.js` + `render/water.js` and the pixels that end up on the
 * default framebuffer.
 *
 * ### Pass order
 *
 * ```
 *   sceneTex (RGBA16F, full res) + gDepth
 *     1. TAA resolve        (settings.taa)          -> history[cur]      full res
 *     2. motion blur        (settings.motionBlur)   -> hdr ping          full res
 *     3. depth of field     (settings.dof)          -> hdr pong          half + full
 *     4. auto exposure      (this.autoExposure)     -> 64x64 mips -> 1x1 adaptation
 *     5. bloom              (settings.bloom)        -> 6 mip chain       resolution independent
 *     6. FINAL (one pass)   tonemap + grade + chromatic aberration + vignette
 *                           + film grain + blue-noise dither             full res
 *     7. FXAA               (only when TAA is off)                       full res
 * ```
 *
 * Exactly **one** full-resolution pass does tonemapping, grading and all the
 * cheap screen effects; every optional stage allocates its render targets the
 * first time it actually runs and releases them again when the setting is
 * turned off, so a "potato" configuration owns nothing but the final pass.
 *
 * ### Colour space
 *
 * Everything up to and including the ACES fit lives in **linear** light. The
 * grade (white balance, lift/gamma/gain, saturation/contrast, time-of-day)
 * runs on the tonemapped-but-still-linear signal, and only the last few lines
 * of the final shader apply the sRGB OETF, the film grain and the dither.
 *
 * ### TAA contract with the renderer
 *
 * `render/renderer.js` must ask this module for the sub-pixel jitter:
 *
 * ```js
 *   const j = post.getJitter(frameIndex, width, height);   // NDC offset, reused array
 *   // proj[8] += j[0];  proj[9] += j[1];   (column-major mat4)
 *   // frame UBO: u_jitter = [j[0], j[1], prevJ[0], prevJ[1]]
 * ```
 *
 * `getJitter` returns `(0,0)` whenever TAA is disabled, so the caller can apply
 * it unconditionally. The resolve assumes `u_proj`/`u_viewProj`/`u_prevViewProj`
 * carry the jitter and removes the **previous** jitter (`u_jitter.zw`) when it
 * reprojects, because the history buffer holds the already resolved (unjittered)
 * image.
 *
 * @module render/post
 */

import { FULLSCREEN_VS } from '../core/gl.js';
import { clamp, damp } from '../core/math.js';

/* ========================================================================== */
/* Fixed texture units (ARCHITECTURE.md 3.5)                                  */
/* ========================================================================== */

/** Unit of `u_gDepth` — the G-buffer depth texture. @type {number} */
export const POST_DEPTH_UNIT = 7;
/** Unit of `u_sceneColor` — whatever HDR/LDR image a pass reads. @type {number} */
export const POST_SCENE_UNIT = 8;
/** Unit of `u_blueNoise` — the 64x64 R8 mask (dither, grain rotation). @type {number} */
export const POST_BLUE_NOISE_UNIT = 11;
/** Unit 14 (`u_sceneCopy` slot) — post scratch A: history / bloom / DOF far. @type {number} */
export const POST_AUX_UNIT = 14;
/** Unit 15 ("free / per-pass") — post scratch B: exposure / DOF near. @type {number} */
export const POST_AUX2_UNIT = 15;

/** Frame UBO binding point (ARCHITECTURE.md 3.3). @type {number} */
export const FRAME_UBO_BINDING = 0;

/* ========================================================================== */
/* Tunables                                                                   */
/* ========================================================================== */

/** Number of Halton(2,3) jitter samples before the sequence repeats. @type {number} */
export const TAA_JITTER_SAMPLES = 16;
/** Bloom mip levels (spec: 6-step progressive downsample). @type {number} */
export const BLOOM_LEVELS = 6;
/** Edge length of the auto-exposure luminance target (power of two). @type {number} */
const LUM_SIZE = 64;
/** Mip level of {@link LUM_SIZE} that is exactly 1x1. @type {number} */
const LUM_MIP = Math.log2(LUM_SIZE);
/** Edge length of the internally generated fallback blue-noise mask. @type {number} */
const FALLBACK_NOISE_SIZE = 64;
/** First coefficient of the R2 low-discrepancy sequence. @type {number} */
const R2_A1 = 0.7548776662466927;
/** Second coefficient of the R2 low-discrepancy sequence. @type {number} */
const R2_A2 = 0.5698402909980532;
/**
 * Screen height, in pixels, whose bloom pyramid is the artistic reference. The
 * chain's base divisor scales with `height / REFERENCE_HEIGHT` so the coarsest
 * bloom mip always covers the same *fraction* of the screen — that is what makes
 * the bloom radius resolution independent.
 * @type {number}
 */
const REFERENCE_HEIGHT = 1088;

/* ========================================================================== */
/* Shared GLSL snippets                                                       */
/* ========================================================================== */

/**
 * Log-luminance / exposure codecs. Both quantities are stored **normalized to
 * [0,1]** so the auto-exposure targets work identically with `R16F` and `RGBA8`
 * storage, and so mip-averaging a log-luminance texture stays a correct
 * geometric mean.
 * @type {string}
 */
const GLSL_EXPOSURE_CODEC = `
const float VOX_LUM_LOG_MIN = -12.0;
const float VOX_LUM_LOG_MAX =  10.0;
const float VOX_EXP_LOG_MIN =  -8.0;
const float VOX_EXP_LOG_MAX =   8.0;

float encodeLogLum(float lum) {
  float l = clamp(log2(max(lum, 1.0e-8)), VOX_LUM_LOG_MIN, VOX_LUM_LOG_MAX);
  return (l - VOX_LUM_LOG_MIN) / (VOX_LUM_LOG_MAX - VOX_LUM_LOG_MIN);
}

float decodeLogLum(float v) {
  return mix(VOX_LUM_LOG_MIN, VOX_LUM_LOG_MAX, clamp(v, 0.0, 1.0));
}

float encodeExposure(float e) {
  float l = clamp(log2(max(e, 1.0e-8)), VOX_EXP_LOG_MIN, VOX_EXP_LOG_MAX);
  return (l - VOX_EXP_LOG_MIN) / (VOX_EXP_LOG_MAX - VOX_EXP_LOG_MIN);
}

float decodeExposure(float v) {
  return exp2(mix(VOX_EXP_LOG_MIN, VOX_EXP_LOG_MAX, clamp(v, 0.0, 1.0)));
}
`;

/**
 * Reads the adapted exposure. `u_exposureCtl.x` is the manual multiplier
 * (`settings.exposure`), `u_exposureCtl.y` is 1 when the 1x1 adaptation texture
 * on unit 15 should be folded in.
 * @type {string}
 */
const GLSL_EXPOSURE_SAMPLER = `
uniform sampler2D u_exposureTex;
uniform vec2 u_exposureCtl;

float currentExposure() {
  float e = u_exposureCtl.x;
  if (u_exposureCtl.y > 0.5) e *= decodeExposure(texture(u_exposureTex, vec2(0.5)).r);
  return max(e, 0.0);
}
`;

/**
 * Depth-based reprojection shared by TAA and motion blur.
 *
 * The scene was rendered through the *jittered* projection, so unprojecting the
 * depth buffer with `u_invViewProj` yields the correct world position. The
 * history/previous image is unjittered, hence `u_jitter.zw` is removed from the
 * previous clip position.
 * @type {string}
 */
const GLSL_REPROJECT = `
vec2 reprojectUV(vec2 uv, float depth) {
  vec3 world = worldFromDepth(uv, depth);
  vec4 prevClip = u_prevViewProj * vec4(world, 1.0);
  float w = prevClip.w;
  w = abs(w) < 1.0e-6 ? (w < 0.0 ? -1.0e-6 : 1.0e-6) : w;
  vec2 prevNDC = prevClip.xy / w - u_jitter.zw;
  return prevNDC * 0.5 + 0.5;
}
`;

/* ========================================================================== */
/* Shader sources                                                             */
/* ========================================================================== */

/**
 * TAA resolve: closest-depth velocity, Catmull-Rom history fetch, YCoCg
 * variance clipping, depth-edge and off-screen rejection, luma-weighted blend.
 * @type {string}
 */
const TAA_FS = `
#include <math>
#include <color>
#include <depth>

in vec2 v_uv;

uniform sampler2D u_sceneColor;   // unit 8  — this frame, HDR
uniform sampler2D u_gDepth;       // unit 7  — G-buffer depth
uniform sampler2D u_history;      // unit 14 — last resolved frame

uniform vec2 u_texel;             // 1 / render target size
uniform vec4 u_taaParams;         // x = max feedback, y = min feedback, z = variance gamma, w = hasHistory
uniform vec2 u_taaEdge;           // x = depth edge scale, y = motion rejection scale (pixels)

out vec4 o_color;

${GLSL_REPROJECT}

vec3 rgbToYCoCg(vec3 c) {
  float y  =  0.25 * c.r + 0.5 * c.g + 0.25 * c.b;
  float co =  0.50 * c.r - 0.5 * c.b;
  float cg = -0.25 * c.r + 0.5 * c.g - 0.25 * c.b;
  return vec3(y, co, cg);
}

vec3 ycoCgToRgb(vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

/** Range compression that keeps the clip stable in HDR; exactly invertible. */
vec3 tonemapTaa(vec3 c) {
  return c / (1.0 + max(maxComp(c), 0.0));
}

vec3 untonemapTaa(vec3 c) {
  return c / max(1.0 - max(maxComp(c), 0.0), 1.0e-4);
}

/** Clip 'value' against the AABB along the line towards the box centre. */
vec3 clipToAABB(vec3 boxMin, vec3 boxMax, vec3 value) {
  vec3 centre = 0.5 * (boxMax + boxMin);
  vec3 extent = 0.5 * (boxMax - boxMin) + 1.0e-5;
  vec3 delta = value - centre;
  vec3 unit = delta / extent;
  float m = maxComp(abs(unit));
  return m > 1.0 ? centre + delta / m : value;
}

/** Sharp 5-tap bicubic (Catmull-Rom) history fetch — kills TAA blur. */
vec4 sampleHistory(vec2 uv, vec2 texSize) {
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1.0e-5));

  vec2 uv0 = (texPos1 - 1.0) / texSize;
  vec2 uv3 = (texPos1 + 2.0) / texSize;
  vec2 uv12 = (texPos1 + offset12) / texSize;

  vec4 sum = vec4(0.0);
  sum += texture(u_history, vec2(uv12.x, uv0.y))  * (w12.x * w0.y);
  sum += texture(u_history, vec2(uv0.x,  uv12.y)) * (w0.x  * w12.y);
  sum += texture(u_history, vec2(uv12.x, uv12.y)) * (w12.x * w12.y);
  sum += texture(u_history, vec2(uv3.x,  uv12.y)) * (w3.x  * w12.y);
  sum += texture(u_history, vec2(uv12.x, uv3.y))  * (w12.x * w3.y);
  float wsum = (w12.x * w0.y) + (w0.x * w12.y) + (w12.x * w12.y) + (w3.x * w12.y) + (w12.x * w3.y);
  return sum / max(wsum, 1.0e-4);
}

void main() {
  vec2 uv = v_uv;
  vec2 texSize = 1.0 / u_texel;

  vec3 centre = max(texture(u_sceneColor, uv).rgb, vec3(0.0));

  // ---- 3x3 neighbourhood: colour moments, depth range, closest fragment ----
  float centreDepth = texture(u_gDepth, uv).r;
  float closestDepth = centreDepth;
  vec2 closestUV = uv;
  float depthMin = centreDepth;
  float depthMax = centreDepth;

  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 nMin = vec3(1.0e20);
  vec3 nMax = vec3(-1.0e20);

  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      vec2 off = vec2(float(x), float(y)) * u_texel;
      vec2 suv = uv + off;
      vec3 s = rgbToYCoCg(tonemapTaa(max(texture(u_sceneColor, suv).rgb, vec3(0.0))));
      m1 += s;
      m2 += s * s;
      nMin = min(nMin, s);
      nMax = max(nMax, s);
      float d = texture(u_gDepth, suv).r;
      depthMin = min(depthMin, d);
      depthMax = max(depthMax, d);
      if (d < closestDepth) {
        closestDepth = d;
        closestUV = suv;
      }
    }
  }

  vec3 mu = m1 * (1.0 / 9.0);
  vec3 sigma = sqrt(max(m2 * (1.0 / 9.0) - mu * mu, vec3(0.0)));
  vec3 boxMin = max(mu - u_taaParams.z * sigma, nMin);
  vec3 boxMax = min(mu + u_taaParams.z * sigma, nMax);

  // ---- reprojection ------------------------------------------------------
  vec2 prevUV = reprojectUV(closestUV, closestDepth);
  bool onScreen = all(greaterThanEqual(prevUV, vec2(0.0))) && all(lessThanEqual(prevUV, vec2(1.0)));

  vec3 history = max(sampleHistory(prevUV, texSize).rgb, vec3(0.0));
  vec3 historyT = rgbToYCoCg(tonemapTaa(history));
  vec3 clipped = clipToAABB(boxMin, boxMax, historyT);

  float clipDist = length(clipped - historyT) / max(length(sigma) + 1.0e-4, 1.0e-4);

  // ---- rejection ---------------------------------------------------------
  float nearLin = linearizeDepth(depthMin);
  float farLin = linearizeDepth(depthMax);
  float edge = saturate((farLin - nearLin) / max(nearLin * u_taaEdge.x + 0.05, 1.0e-4));
  float motion = saturate(length((prevUV - uv) * texSize) / max(u_taaEdge.y, 1.0));

  float feedback = mix(u_taaParams.x, u_taaParams.y, saturate(clipDist));
  feedback = mix(feedback, u_taaParams.y, max(edge, motion));
  if (!onScreen || u_taaParams.w < 0.5) feedback = 0.0;

  vec3 resolvedHistory = max(untonemapTaa(ycoCgToRgb(clipped)), vec3(0.0));

  // Karis' luma-weighted average: strongly suppresses single-pixel flicker.
  float wCur = (1.0 - feedback) / (1.0 + luminance(centre));
  float wHis = feedback / (1.0 + luminance(resolvedHistory));
  vec3 result = (centre * wCur + resolvedHistory * wHis) / max(wCur + wHis, 1.0e-5);

  if (any(isnan(result)) || any(isinf(result))) result = centre;

  o_color = vec4(result, 1.0);
}
`;

/**
 * Motion blur: 8 taps along the reconstructed per-pixel velocity with a soft
 * depth comparison so foreground surfaces never smear onto the background.
 * @type {string}
 */
const MOTION_BLUR_FS = `
#include <math>
#include <depth>

in vec2 v_uv;

uniform sampler2D u_sceneColor;   // unit 8
uniform sampler2D u_gDepth;       // unit 7
uniform sampler2D u_blueNoise;    // unit 11

uniform vec2 u_texel;
uniform vec2 u_noiseUVScale;
uniform vec2 u_noiseOffset;
uniform vec4 u_mbParams;          // x = shutter scale, y = max radius (uv), z = depth softness, w = unused

out vec4 o_color;

${GLSL_REPROJECT}

const int MB_TAPS = 8;

void main() {
  vec2 uv = v_uv;
  vec3 centreColor = max(texture(u_sceneColor, uv).rgb, vec3(0.0));
  float centreDepth = texture(u_gDepth, uv).r;

  vec2 prevUV = reprojectUV(uv, centreDepth);
  vec2 velocity = (uv - prevUV) * u_mbParams.x;

  float vlen = length(velocity);
  if (vlen > u_mbParams.y) velocity *= u_mbParams.y / max(vlen, 1.0e-8);

  float pixels = length(velocity / u_texel);
  if (pixels < 1.0) {
    o_color = vec4(centreColor, 1.0);
    return;
  }

  float centreLin = linearizeDepth(centreDepth);
  float softness = max(centreLin * u_mbParams.z + 0.25, 1.0e-3);
  float noise = texture(u_blueNoise, uv * u_noiseUVScale + u_noiseOffset).r;

  vec3 sum = vec3(0.0);
  float wsum = 0.0;

  for (int i = 0; i < MB_TAPS; ++i) {
    float t = (float(i) + noise) / float(MB_TAPS) - 0.5;
    vec2 suv = clamp(uv + velocity * t, vec2(0.0), vec2(1.0));
    float sd = texture(u_gDepth, suv).r;
    float slin = linearizeDepth(sd);
    // 1 when the tap sits at the same depth or behind, 0 when it is a much
    // closer surface (which must not bleed onto this background pixel).
    float w = saturate(1.0 + (slin - centreLin) / softness);
    sum += max(texture(u_sceneColor, suv).rgb, vec3(0.0)) * w;
    wsum += w;
  }

  o_color = vec4(wsum > 1.0e-4 ? sum / wsum : centreColor, 1.0);
}
`;

/**
 * DOF prepass (half resolution, MRT): box-downsamples the scene and splits the
 * signed circle of confusion into a near and a far coverage channel.
 * @type {string}
 */
const DOF_PREPASS_FS = `
#include <math>
#include <depth>

in vec2 v_uv;

uniform sampler2D u_sceneColor;   // unit 8  (full resolution)
uniform sampler2D u_gDepth;       // unit 7  (full resolution)

uniform vec2 u_texel;             // FULL resolution texel size
uniform vec4 u_dofParams;         // x = focus distance, y = aperture strength, z = max radius (half-res px), w = unused

layout(location = 0) out vec4 o_near;   // rgb colour, a = near CoC coverage
layout(location = 1) out vec4 o_far;    // rgb colour, a = far CoC coverage

float signedCoC(float depth) {
  float z = linearizeDepth(depth);
  float coc = (z - u_dofParams.x) / max(z, 1.0e-3);
  return clamp(coc * u_dofParams.y, -1.0, 1.0);
}

void main() {
  vec2 uv = v_uv;
  vec2 o = u_texel * 0.5;

  vec3 c0 = max(texture(u_sceneColor, uv + vec2(-o.x, -o.y)).rgb, vec3(0.0));
  vec3 c1 = max(texture(u_sceneColor, uv + vec2( o.x, -o.y)).rgb, vec3(0.0));
  vec3 c2 = max(texture(u_sceneColor, uv + vec2(-o.x,  o.y)).rgb, vec3(0.0));
  vec3 c3 = max(texture(u_sceneColor, uv + vec2( o.x,  o.y)).rgb, vec3(0.0));
  vec3 colour = (c0 + c1 + c2 + c3) * 0.25;

  float k0 = signedCoC(texture(u_gDepth, uv + vec2(-o.x, -o.y)).r);
  float k1 = signedCoC(texture(u_gDepth, uv + vec2( o.x, -o.y)).r);
  float k2 = signedCoC(texture(u_gDepth, uv + vec2(-o.x,  o.y)).r);
  float k3 = signedCoC(texture(u_gDepth, uv + vec2( o.x,  o.y)).r);

  float cocMin = min(min(k0, k1), min(k2, k3));
  float cocMax = max(max(k0, k1), max(k2, k3));

  o_near = vec4(colour, saturate(-cocMin));
  o_far  = vec4(colour, saturate(cocMax));
}
`;

/**
 * DOF gather (half resolution, MRT): a golden-angle disc, evaluated as
 * scatter-as-gather so each sample only contributes where its own circle of
 * confusion actually reaches. Near and far fields are blurred separately.
 * @type {string}
 */
const DOF_GATHER_FS = `
#include <math>

in vec2 v_uv;

uniform sampler2D u_dofNear;      // unit 14
uniform sampler2D u_dofFar;       // unit 15
uniform sampler2D u_blueNoise;    // unit 11

uniform vec2 u_texel;             // HALF resolution texel size
uniform vec2 u_noiseUVScale;
uniform vec2 u_noiseOffset;
uniform vec4 u_dofParams;         // z = max radius in half-res pixels

layout(location = 0) out vec4 o_near;
layout(location = 1) out vec4 o_far;

const int DOF_TAPS = 32;
const float GOLDEN_ANGLE = 2.39996323;

void main() {
  vec2 uv = v_uv;
  vec4 nearCentre = texture(u_dofNear, uv);
  vec4 farCentre = texture(u_dofFar, uv);

  float maxRadius = max(u_dofParams.z, 1.0);
  float rot = texture(u_blueNoise, uv * u_noiseUVScale + u_noiseOffset).r * TAU;

  vec3 nearSum = nearCentre.rgb * nearCentre.a;
  float nearWeight = nearCentre.a;
  float nearCoverage = nearCentre.a;

  vec3 farSum = farCentre.rgb;
  float farWeight = 1.0;

  for (int i = 0; i < DOF_TAPS; ++i) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(DOF_TAPS));
    float a = fi * GOLDEN_ANGLE + rot;
    vec2 dir = vec2(cos(a), sin(a)) * r;
    float distPx = r * maxRadius;
    vec2 suv = clamp(uv + dir * maxRadius * u_texel, vec2(0.0), vec2(1.0));

    vec4 sn = texture(u_dofNear, suv);
    float wn = saturate(sn.a * maxRadius - distPx + 1.0);
    nearSum += sn.rgb * wn;
    nearWeight += wn;
    nearCoverage = max(nearCoverage, sn.a * wn);

    vec4 sf = texture(u_dofFar, suv);
    float wf = saturate(sf.a * maxRadius - distPx + 1.0);
    farSum += sf.rgb * wf;
    farWeight += wf;
  }

  o_near = vec4(nearWeight > 1.0e-4 ? nearSum / nearWeight : nearCentre.rgb, saturate(nearCoverage));
  o_far  = vec4(farSum / max(farWeight, 1.0e-4), farCentre.a);
}
`;

/**
 * DOF composite: full resolution, blends the far field under and the near field
 * over the sharp image so foreground blur bleeds across silhouettes.
 * @type {string}
 */
const DOF_COMPOSITE_FS = `
#include <math>
#include <depth>

in vec2 v_uv;

uniform sampler2D u_sceneColor;   // unit 8
uniform sampler2D u_gDepth;       // unit 7
uniform sampler2D u_dofNear;      // unit 14 (blurred)
uniform sampler2D u_dofFar;       // unit 15 (blurred)

uniform vec4 u_dofParams;         // x = focus distance, y = aperture strength

out vec4 o_color;

void main() {
  vec2 uv = v_uv;
  vec3 sharp = max(texture(u_sceneColor, uv).rgb, vec3(0.0));

  float z = linearizeDepth(texture(u_gDepth, uv).r);
  float coc = clamp(((z - u_dofParams.x) / max(z, 1.0e-3)) * u_dofParams.y, -1.0, 1.0);

  vec4 far = texture(u_dofFar, uv);
  vec4 near = texture(u_dofNear, uv);

  float farBlend = smoothstep(0.04, 0.45, saturate(coc));
  vec3 colour = mix(sharp, max(far.rgb, vec3(0.0)), farBlend);

  float nearBlend = smoothstep(0.02, 0.40, near.a);
  colour = mix(colour, max(near.rgb, vec3(0.0)), nearBlend);

  o_color = vec4(colour, 1.0);
}
`;

/**
 * Bloom downsample. `BLOOM_PREFILTER` turns the first step into the
 * exposure-aware soft-knee threshold with a Karis firefly filter.
 * @type {string}
 */
const BLOOM_DOWN_FS = `
#include <math>
#include <color>

in vec2 v_uv;

uniform sampler2D u_source;       // unit 14
uniform vec2 u_texel;             // texel size of the SOURCE

${GLSL_EXPOSURE_CODEC}
#ifdef BLOOM_PREFILTER
${GLSL_EXPOSURE_SAMPLER}
uniform vec4 u_filter;            // x = threshold, y = threshold - knee, z = 2*knee, w = 0.25/knee
#endif

out vec4 o_color;

vec3 fetchSource(vec2 uv) {
  return max(texture(u_source, uv).rgb, vec3(0.0));
}

#ifdef BLOOM_PREFILTER
vec3 softKnee(vec3 c) {
  float br = maxComp(c);
  float rq = clamp(br - u_filter.y, 0.0, u_filter.z);
  rq = rq * rq * u_filter.w;
  return c * max(rq, br - u_filter.x) / max(br, 1.0e-5);
}

float karisWeight(vec3 c) {
  return 1.0 / (1.0 + luminance(c));
}
#endif

void main() {
  vec2 uv = v_uv;
  vec2 t = u_texel;

  vec3 s0 = fetchSource(uv + vec2(-2.0,  2.0) * t);
  vec3 s1 = fetchSource(uv + vec2( 0.0,  2.0) * t);
  vec3 s2 = fetchSource(uv + vec2( 2.0,  2.0) * t);
  vec3 s3 = fetchSource(uv + vec2(-2.0,  0.0) * t);
  vec3 s4 = fetchSource(uv);
  vec3 s5 = fetchSource(uv + vec2( 2.0,  0.0) * t);
  vec3 s6 = fetchSource(uv + vec2(-2.0, -2.0) * t);
  vec3 s7 = fetchSource(uv + vec2( 0.0, -2.0) * t);
  vec3 s8 = fetchSource(uv + vec2( 2.0, -2.0) * t);
  vec3 s9 = fetchSource(uv + vec2(-1.0,  1.0) * t);
  vec3 sa = fetchSource(uv + vec2( 1.0,  1.0) * t);
  vec3 sb = fetchSource(uv + vec2(-1.0, -1.0) * t);
  vec3 sc = fetchSource(uv + vec2( 1.0, -1.0) * t);

  vec3 g0 = (s9 + sa + sb + sc) * 0.25;
  vec3 g1 = (s0 + s1 + s3 + s4) * 0.25;
  vec3 g2 = (s1 + s2 + s4 + s5) * 0.25;
  vec3 g3 = (s3 + s4 + s6 + s7) * 0.25;
  vec3 g4 = (s4 + s5 + s7 + s8) * 0.25;

#ifdef BLOOM_PREFILTER
  float exposure = currentExposure();
  g0 = softKnee(g0 * exposure);
  g1 = softKnee(g1 * exposure);
  g2 = softKnee(g2 * exposure);
  g3 = softKnee(g3 * exposure);
  g4 = softKnee(g4 * exposure);

  float w0 = karisWeight(g0) * 0.5;
  float w1 = karisWeight(g1) * 0.125;
  float w2 = karisWeight(g2) * 0.125;
  float w3 = karisWeight(g3) * 0.125;
  float w4 = karisWeight(g4) * 0.125;
  vec3 result = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) /
                max(w0 + w1 + w2 + w3 + w4, 1.0e-5);
#else
  vec3 result = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
#endif

  o_color = vec4(max(result, vec3(0.0)), 1.0);
}
`;

/**
 * Bloom upsample: 9-tap tent filter, drawn with additive blending so each level
 * accumulates into the next larger one.
 * @type {string}
 */
const BLOOM_UP_FS = `
in vec2 v_uv;

uniform sampler2D u_source;       // unit 14 — the smaller mip
uniform vec2 u_radius;            // tent radius in uv

out vec4 o_color;

vec3 fetchSource(vec2 uv) {
  return max(texture(u_source, uv).rgb, vec3(0.0));
}

void main() {
  vec2 uv = v_uv;
  vec2 r = u_radius;

  vec3 sum = fetchSource(uv + vec2(-1.0,  1.0) * r) * 1.0;
  sum += fetchSource(uv + vec2( 0.0,  1.0) * r) * 2.0;
  sum += fetchSource(uv + vec2( 1.0,  1.0) * r) * 1.0;
  sum += fetchSource(uv + vec2(-1.0,  0.0) * r) * 2.0;
  sum += fetchSource(uv) * 4.0;
  sum += fetchSource(uv + vec2( 1.0,  0.0) * r) * 2.0;
  sum += fetchSource(uv + vec2(-1.0, -1.0) * r) * 1.0;
  sum += fetchSource(uv + vec2( 0.0, -1.0) * r) * 2.0;
  sum += fetchSource(uv + vec2( 1.0, -1.0) * r) * 1.0;

  o_color = vec4(sum * (1.0 / 16.0), 1.0);
}
`;

/**
 * Auto exposure step 1: write normalized log-luminance into a small square
 * target whose mip chain is then averaged down to 1x1 by `generateMipmap`.
 * @type {string}
 */
const LUMINANCE_FS = `
#include <math>
#include <color>

in vec2 v_uv;

uniform sampler2D u_sceneColor;   // unit 8
uniform vec2 u_spread;            // quarter of a luminance texel, in scene uv

${GLSL_EXPOSURE_CODEC}

out vec4 o_color;

void main() {
  vec2 uv = v_uv;
  vec3 c = max(texture(u_sceneColor, uv + vec2(-1.0, -1.0) * u_spread).rgb, vec3(0.0));
  c += max(texture(u_sceneColor, uv + vec2( 1.0, -1.0) * u_spread).rgb, vec3(0.0));
  c += max(texture(u_sceneColor, uv + vec2(-1.0,  1.0) * u_spread).rgb, vec3(0.0));
  c += max(texture(u_sceneColor, uv + vec2( 1.0,  1.0) * u_spread).rgb, vec3(0.0));
  c *= 0.25;

  float enc = encodeLogLum(max(luminance(c), 1.0e-6));
  o_color = vec4(enc, enc, enc, 1.0);
}
`;

/**
 * Auto exposure step 2: 1x1 ping-pong adaptation with separate speeds for
 * brightening and darkening, smoothed in log space.
 * @type {string}
 */
const ADAPT_FS = `
in vec2 v_uv;

uniform sampler2D u_lumTex;       // unit 14 — LUM_SIZE^2, mipped
uniform sampler2D u_prevExposure; // unit 15 — 1x1

uniform vec4 u_adaptParams;       // x = dt, y = speed up, z = speed down, w = hasHistory
uniform vec4 u_adaptRange;        // x = key value, y = min exposure, z = max exposure, w = 1x1 mip level

${GLSL_EXPOSURE_CODEC}

out vec4 o_color;

void main() {
  float avgLog = decodeLogLum(textureLod(u_lumTex, vec2(0.5), u_adaptRange.w).r);
  float avgLum = exp2(avgLog);

  float target = clamp(u_adaptRange.x / max(avgLum, 1.0e-5), u_adaptRange.y, u_adaptRange.z);

  float prev = target;
  if (u_adaptParams.w > 0.5) prev = decodeExposure(texture(u_prevExposure, vec2(0.5)).r);

  // target < prev means the scene got brighter, so the eye stops down.
  float speed = target < prev ? u_adaptParams.y : u_adaptParams.z;
  float k = clamp(1.0 - exp(-max(u_adaptParams.x, 0.0) * max(speed, 0.0)), 0.0, 1.0);

  float current = exp2(mix(log2(max(prev, 1.0e-6)), log2(max(target, 1.0e-6)), k));
  o_color = vec4(encodeExposure(current), 0.0, 0.0, 1.0);
}
`;

/**
 * The single full-resolution finishing pass: chromatic aberration, bloom mix,
 * exposure, ACES, white balance, lift/gamma/gain, saturation/contrast,
 * time-of-day grade, vignette, sRGB encode, film grain and blue-noise dither.
 * @type {string}
 */
const FINAL_FS = `
#include <math>
#include <color>
#include <frame>

in vec2 v_uv;

uniform sampler2D u_sceneColor;   // unit 8
uniform sampler2D u_bloom;        // unit 14
uniform sampler2D u_blueNoise;    // unit 11

uniform vec2 u_texel;
uniform vec2 u_noiseUVScale;
uniform vec2 u_noiseOffset;
uniform vec2 u_grainOffset;
uniform vec4 u_grade;             // x = manual exposure, y = saturation, z = contrast, w = bloom strength
uniform vec4 u_effects;           // x = chromatic aberration, y = vignette, z = film grain, w = dither
uniform vec4 u_extra;             // x = unused, y = bloom on, z = grade strength, w = aspect

${GLSL_EXPOSURE_CODEC}
${GLSL_EXPOSURE_SAMPLER}

out vec4 o_color;

void main() {
  vec2 uv = v_uv;
  vec2 centred = uv - 0.5;
  float r2 = dot(centred, centred);

  // ---- 1. chromatic aberration (radial, R and B pulled apart) -------------
  vec3 colour;
  if (u_effects.x > 0.0) {
    vec2 off = centred * r2 * u_effects.x;
    colour.r = texture(u_sceneColor, uv - off).r;
    colour.g = texture(u_sceneColor, uv).g;
    colour.b = texture(u_sceneColor, uv + off).b;
  } else {
    colour = texture(u_sceneColor, uv).rgb;
  }
  colour = max(colour, vec3(0.0));

  // ---- 2. exposure (manual x adapted) ------------------------------------
  colour *= currentExposure();

  // ---- 3. bloom (already in exposed space) -------------------------------
  if (u_extra.y > 0.5) {
    vec3 bloom = max(texture(u_bloom, uv).rgb, vec3(0.0));
    colour = mix(colour, bloom, clamp(u_grade.w, 0.0, 1.0));
  }

  // ---- 4. ACES filmic tonemap, in linear ---------------------------------
  colour = acesFitted(colour);

  // ---- 5. time-of-day grade ----------------------------------------------
  float sunY = clamp(u_sunDir.y, -1.0, 1.0);
  float night = 1.0 - smoothstep(-0.14, 0.05, sunY);
  float golden = (1.0 - smoothstep(0.02, 0.34, sunY)) * (1.0 - night);
  float gradeAmount = clamp(u_extra.z, 0.0, 1.0);
  night *= gradeAmount;
  golden *= gradeAmount;

  colour = whiteBalance(colour, golden * 0.30 - night * 0.26, golden * 0.04 - night * 0.05);

  vec3 lift = mix(vec3(0.0), vec3(-0.006, 0.001, 0.024), night);
  vec3 gamma = mix(vec3(1.0), vec3(1.04, 1.00, 0.96), night) *
               mix(vec3(1.0), vec3(0.99, 1.00, 1.02), golden);
  vec3 gain = mix(vec3(1.0), vec3(0.93, 0.96, 1.06), night) *
              mix(vec3(1.0), vec3(1.07, 1.01, 0.90), golden);
  colour = liftGammaGain(colour, lift, gamma, gain);

  colour = adjustSaturationContrast(colour, u_grade.y * mix(1.0, 0.86, night), u_grade.z);

  // ---- 6. vignette --------------------------------------------------------
  if (u_effects.y > 0.0) {
    float d = length(centred * vec2(u_extra.w, 1.0)) * 1.4142136;
    colour *= max(1.0 - u_effects.y * smoothstep(0.35, 1.10, d), 0.0);
  }

  // ---- 7. display encode --------------------------------------------------
  vec3 srgb = linearToSrgb(max(colour, vec3(0.0)));

  // ---- 8. animated film grain (stronger in the shadows) -------------------
  if (u_effects.z > 0.0) {
    float g = hash21(uv / max(u_texel, vec2(1.0e-6)) + u_grainOffset) - 0.5;
    srgb += g * u_effects.z * (1.0 - 0.65 * luminance(srgb));
  }

  // ---- 9. blue-noise dither, triangular PDF -------------------------------
  if (u_effects.w > 0.0) {
    vec2 nuv = uv * u_noiseUVScale + u_noiseOffset;
    float n1 = texture(u_blueNoise, nuv).r;
    float n2 = texture(u_blueNoise, nuv + vec2(0.5)).r;
    srgb += (n1 - n2) * u_effects.w;
  }

  o_color = vec4(max(srgb, vec3(0.0)), 1.0);
}
`;

/**
 * FXAA 3.11-style edge blend, run on the finished LDR image. Only used when TAA
 * is off, because the two never look good together.
 * @type {string}
 */
const FXAA_FS = `
in vec2 v_uv;

uniform sampler2D u_sceneColor;   // unit 8 — LDR, sRGB encoded
uniform vec2 u_texel;

out vec4 o_color;

const float FXAA_SPAN_MAX = 8.0;
const float FXAA_REDUCE_MUL = 1.0 / 8.0;
const float FXAA_REDUCE_MIN = 1.0 / 128.0;
const float FXAA_EDGE_THRESHOLD = 0.125;
const float FXAA_EDGE_THRESHOLD_MIN = 0.0312;

float fxaaLuma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 uv = v_uv;
  vec2 t = u_texel;

  vec3 rgbM = texture(u_sceneColor, uv).rgb;
  float lM = fxaaLuma(rgbM);
  float lNW = fxaaLuma(texture(u_sceneColor, uv + vec2(-1.0, -1.0) * t).rgb);
  float lNE = fxaaLuma(texture(u_sceneColor, uv + vec2( 1.0, -1.0) * t).rgb);
  float lSW = fxaaLuma(texture(u_sceneColor, uv + vec2(-1.0,  1.0) * t).rgb);
  float lSE = fxaaLuma(texture(u_sceneColor, uv + vec2( 1.0,  1.0) * t).rgb);

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  float range = lMax - lMin;

  if (range < max(FXAA_EDGE_THRESHOLD_MIN, lMax * FXAA_EDGE_THRESHOLD)) {
    o_color = vec4(rgbM, 1.0);
    return;
  }

  vec2 dir;
  dir.x = -((lNW + lNE) - (lSW + lSE));
  dir.y =  ((lNW + lSW) - (lNE + lSE));

  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * FXAA_REDUCE_MUL, FXAA_REDUCE_MIN);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-FXAA_SPAN_MAX), vec2(FXAA_SPAN_MAX)) * t;

  vec3 rgbA = 0.5 * (texture(u_sceneColor, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture(u_sceneColor, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(u_sceneColor, uv + dir * -0.5).rgb +
                                   texture(u_sceneColor, uv + dir *  0.5).rgb);

  float lB = fxaaLuma(rgbB);
  o_color = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;

/**
 * Emergency path: exposure + ACES + sRGB only. Used when a stage failed to
 * build so the player still sees the world instead of a black screen.
 * @type {string}
 */
const BLIT_FS = `
#include <color>

in vec2 v_uv;

uniform sampler2D u_sceneColor;   // unit 8
uniform float u_exposure;

out vec4 o_color;

void main() {
  vec3 c = max(texture(u_sceneColor, v_uv).rgb, vec3(0.0)) * max(u_exposure, 0.0);
  o_color = vec4(linearToSrgb(acesFitted(c)), 1.0);
}
`;

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/**
 * Radical-inverse Halton sample.
 * @param {number} index 1-based sample index
 * @param {number} base prime base (2 and 3 for the classic TAA sequence)
 * @returns {number} value in `[0,1)`
 */
export function halton(index, base) {
  let result = 0;
  let f = 1 / base;
  let i = Math.max(1, index | 0);
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/**
 * Fractional part, matching GLSL `fract` for positive inputs.
 * @param {number} x value
 * @returns {number} `x - floor(x)`
 */
function fract(x) {
  return x - Math.floor(x);
}

/**
 * Edge length of a blue-noise texture created by `core/gl.js`.
 * @param {?WebGLTexture} tex candidate texture
 * @returns {number} edge length in texels
 */
function noiseSizeOf(tex) {
  const meta = tex && tex.__vox;
  const size = meta && meta.width ? meta.width | 0 : 0;
  return size > 0 ? size : FALLBACK_NOISE_SIZE;
}

/**
 * Build a small blue-noise mask by minimizing a Gaussian energy field with
 * random pair swaps (a cheap stand-in for void-and-cluster). Only ever used
 * when `render/textures.js` did not hand us its mask.
 *
 * @param {number} size edge length, a power of two
 * @returns {Uint8Array} `size * size` single-channel values
 */
function generateFallbackNoise(size) {
  const n = size * size;
  const values = new Float32Array(n);
  let state = 0x9e3779b9 >>> 0;
  const rnd = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < n; i++) values[i] = rnd();

  const radius = 2;
  const span = radius * 2 + 1;
  const kernel = new Float32Array(span * span);
  const sigma2 = 2 * 1.9 * 1.9;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      kernel[(dy + radius) * span + (dx + radius)] =
        (dx === 0 && dy === 0) ? 0 : Math.exp(-(dx * dx + dy * dy) / sigma2);
    }
  }

  const energyAt = (idx) => {
    const x0 = idx % size;
    const y0 = (idx / size) | 0;
    const v0 = values[idx];
    let e = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = (y0 + dy + size) % size;
      for (let dx = -radius; dx <= radius; dx++) {
        const w = kernel[(dy + radius) * span + (dx + radius)];
        if (w === 0) continue;
        const diff = v0 - values[y * size + ((x0 + dx + size) % size)];
        e += w * (1 - Math.abs(diff));
      }
    }
    return e;
  };

  const iterations = n * 2;
  for (let it = 0; it < iterations; it++) {
    const a = (rnd() * n) | 0;
    const b = (rnd() * n) | 0;
    if (a === b || a >= n || b >= n) continue;
    const before = energyAt(a) + energyAt(b);
    const tmp = values[a];
    values[a] = values[b];
    values[b] = tmp;
    if (energyAt(a) + energyAt(b) > before) {
      const back = values[a];
      values[a] = values[b];
      values[b] = back;
    }
  }

  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = Math.max(0, Math.min(255, Math.round(values[i] * 255)));
  }
  return data;
}

/* ========================================================================== */
/* PostProcess                                                                */
/* ========================================================================== */

/**
 * The complete HDR post-processing chain (ARCHITECTURE.md 5.23).
 *
 * Owns every intermediate render target between the lighting pass and the
 * screen; nothing is shared with the rest of the renderer except the scene
 * colour and the G-buffer depth handed to {@link PostProcess#render}.
 */
export class PostProcess {
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
    /** @type {number} Half-resolution width (DOF). */
    this.halfWidth = Math.max(1, Math.ceil(this.width / 2));
    /** @type {number} Half-resolution height (DOF). */
    this.halfHeight = Math.max(1, Math.ceil(this.height / 2));

    /* ---- TAA tunables ---------------------------------------------------- */

    /** @type {number} Halton samples before the jitter sequence repeats. */
    this.jitterSamples = TAA_JITTER_SAMPLES;
    /** @type {number} Jitter amplitude, in pixels (1 = a full pixel). */
    this.jitterScale = 1.0;
    /** @type {number} History weight when nothing rejects it. */
    this.feedbackMax = 0.92;
    /** @type {number} History weight when the clamp fires hard. */
    this.feedbackMin = 0.62;
    /** @type {number} Variance clipping width, in standard deviations. */
    this.varianceGamma = 1.25;
    /** @type {number} Relative depth delta that counts as a silhouette. */
    this.depthEdgeScale = 0.06;
    /** @type {number} Reprojection length (pixels) that fully distrusts history. */
    this.motionRejectPixels = 48;

    /* ---- motion blur tunables -------------------------------------------- */

    /** @type {number} Shutter angle in degrees (180 = the film standard). */
    this.shutterAngle = 180;
    /** @type {number} Maximum blur length as a fraction of the screen. */
    this.motionBlurMaxRadius = 0.055;
    /** @type {number} Relative depth softness of the foreground rejection. */
    this.motionBlurDepthSoftness = 0.1;

    /* ---- depth of field tunables ------------------------------------------ */

    /** @type {number} Manual focus distance in blocks (used when autoFocus is off). */
    this.focusDistance = 12;
    /** @type {boolean} Focus on the crosshair (`frame.hit.dist`) when available. */
    this.autoFocus = true;
    /** @type {number} Focus distance used when the crosshair hits nothing. */
    this.defaultFocusDistance = 48;
    /** @type {number} Exponential focus pull speed (1/s). */
    this.focusSpeed = 6;
    /** @type {number} Aperture strength; larger blurs the out-of-focus range harder. */
    this.aperture = 1.6;
    /** @type {number} Bokeh radius as a fraction of the half-resolution height. */
    this.bokehRadiusFraction = 0.03;

    /* ---- bloom tunables ---------------------------------------------------- */

    /** @type {number} Soft-knee threshold in exposed luminance. */
    this.bloomThreshold = 1.0;
    /** @type {number} Knee width relative to the threshold. */
    this.bloomKnee = 0.55;
    /** @type {number} Final mix weight (spec: 0.04 .. 0.08). */
    this.bloomStrength = 0.06;
    /** @type {number} Tent-filter radius in destination texels. */
    this.bloomRadius = 1.0;

    /* ---- exposure tunables -------------------------------------------------- */

    /** @type {boolean} Enable the GPU auto-exposure feedback loop. */
    this.autoExposure = true;
    /** @type {number} Middle-grey key value. */
    this.exposureKey = 0.20;
    /** @type {number} Lower clamp of the adapted exposure. */
    this.minExposure = 0.12;
    /** @type {number} Upper clamp of the adapted exposure. */
    this.maxExposure = 8.0;
    /** @type {number} Adaptation speed while stopping down (scene got brighter). */
    this.adaptSpeedUp = 2.2;
    /** @type {number} Adaptation speed while opening up (scene got darker). */
    this.adaptSpeedDown = 0.9;

    /* ---- grade tunables ------------------------------------------------------ */

    /** @type {number} Strength of the time-of-day grade, 0 disables it. */
    this.gradeStrength = 1.0;
    /** @type {number} Radial chromatic aberration amount. */
    this.chromaticAberrationStrength = 0.0035;
    /** @type {number} Vignette darkening at the corners. */
    this.vignetteStrength = 0.35;
    /** @type {number} Film grain amplitude in display units. */
    this.filmGrainStrength = 0.022;
    /** @type {number} Dither amplitude; ~1 LSB of an 8-bit channel. */
    this.ditherStrength = 1.0 / 255.0;
    /** @type {boolean} Run FXAA when TAA is off. */
    this.fxaa = true;

    /* ---- GPU resources ------------------------------------------------------- */

    /** @type {Array<?{tex:WebGLTexture, fbo:Object}>} Full-res HDR ping-pong. @private */
    this._hdr = [null, null];
    /** @type {Array<?{tex:WebGLTexture, fbo:Object}>} Full-res LDR ping-pong. @private */
    this._ldr = [null, null];
    /** @type {Array<?{tex:WebGLTexture, fbo:Object}>} TAA history ping-pong. @private */
    this._history = [null, null];
    /** @type {Array<{tex:WebGLTexture, fbo:Object, width:number, height:number}>} Bloom chain. @private */
    this._bloom = [];
    /** @type {?Object} DOF half-resolution targets. @private */
    this._dof = null;
    /** @type {?{tex:WebGLTexture, fbo:Object}} Log-luminance pyramid. @private */
    this._lum = null;
    /** @type {Array<?{tex:WebGLTexture, fbo:Object}>} 1x1 exposure ping-pong. @private */
    this._adapt = [null, null];

    /** @type {number} Index of the history slot written this frame. @private */
    this._historyIndex = 0;
    /** @type {boolean} True once a usable history exists. @private */
    this._historyValid = false;
    /** @type {number} Index of the exposure slot written this frame. @private */
    this._adaptIndex = 0;
    /** @type {boolean} True once the adaptation has a previous value. @private */
    this._adaptValid = false;
    /** @type {number} Alternating index for the HDR ping-pong. @private */
    this._pingIndex = 0;
    /** @type {number} Base divisor of the bloom chain (resolution independence). @private */
    this._bloomDiv = 2;

    /* ---- programs (built lazily, per stage) ---------------------------------- */

    /** @type {Map<string, ?Object>} Compiled programs by key. @private */
    this._programs = new Map();

    /* ---- blue noise ------------------------------------------------------------ */

    /** @type {?WebGLTexture} Blue-noise mask (set by the renderer, or resolved from the frame). */
    this.blueNoise = null;
    /** @type {?WebGLTexture} Internally generated mask. @private */
    this._fallbackNoise = null;
    /** @type {number} Edge length of the mask in use. @private */
    this._noiseSize = FALLBACK_NOISE_SIZE;

    /* ---- scratch (no per-frame allocation) -------------------------------------- */

    this._jitter = new Float32Array(2);
    this._vec2A = new Float32Array(2);
    this._vec2B = new Float32Array(2);
    this._vec2C = new Float32Array(2);
    this._vec2D = new Float32Array(2);
    this._vec4A = new Float32Array(4);
    this._vec4B = new Float32Array(4);
    this._vec4C = new Float32Array(4);
    this._noiseUVScale = new Float32Array(2);
    this._noiseOffset = new Float32Array(2);
    this._grainOffset = new Float32Array(2);
    this._dofParams = new Float32Array(4);

    /** @type {number} Smoothed focus distance. @private */
    this._focus = this.defaultFocusDistance;
    /** @type {number} Frame counter used when the frame object has no index. @private */
    this._frameCounter = 0;
    /** @type {boolean} True after a fatal error; the chain degrades to a blit. @private */
    this._failed = false;
    /** @type {boolean} */
    this._disposed = false;

    this._onSettingsChange = (key) => this._handleSettingChange(key);
    if (this.settings && typeof this.settings.on === 'function') {
      this.settings.on('change', this._onSettingsChange);
    }
  }

  /* ======================================================================== */
  /* Settings                                                                 */
  /* ======================================================================== */

  /**
   * Read a setting, tolerating a missing store or an unknown key.
   * @param {string} key setting key
   * @param {*} fallback value used when the key is unavailable
   * @returns {*} the setting value or `fallback`
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
   * Release the targets of a stage that was just switched off.
   * @param {string} key changed setting key
   * @returns {void}
   * @private
   */
  _handleSettingChange(key) {
    if (this._disposed) return;
    if (key === 'taa') {
      if (this._setting('taa', true) === false) this._releaseHistory();
      this._historyValid = false;
    } else if (key === 'bloom') {
      if (this._setting('bloom', true) === false) this._releaseBloom();
    } else if (key === 'dof') {
      if (this._setting('dof', false) !== true) this._releaseDof();
    } else if (key === 'motionBlur' || key === 'renderScale') {
      this._historyValid = false;
    }
  }

  /**
   * Whether temporal anti-aliasing is currently active.
   * @returns {boolean} true when `settings.taa` is on
   */
  get taaEnabled() {
    return this._setting('taa', true) !== false;
  }

  /* ======================================================================== */
  /* TAA jitter                                                               */
  /* ======================================================================== */

  /**
   * Halton(2,3) sub-pixel jitter for a frame, expressed as an **NDC** offset —
   * exactly what the renderer must add to `proj[8]`/`proj[9]` and write into
   * `u_jitter.xy` (moving the previous value into `u_jitter.zw`).
   *
   * Returns `(0,0)` while TAA is disabled, so the caller may apply it
   * unconditionally.
   *
   * @param {number} frameIndex monotonically increasing frame counter
   * @param {number} width render target width in pixels
   * @param {number} height render target height in pixels
   * @param {Float32Array|number[]} [out] optional destination (length >= 2)
   * @returns {Float32Array|number[]} `[x, y]` NDC offset — the internal array is
   *          **reused** between calls when `out` is omitted; copy it if you keep it
   */
  getJitter(frameIndex, width, height, out) {
    const dst = out || this._jitter;
    if (!this.taaEnabled) {
      dst[0] = 0;
      dst[1] = 0;
      return dst;
    }
    const count = Math.max(1, this.jitterSamples | 0);
    const raw = Number.isFinite(frameIndex) ? (frameIndex | 0) : 0;
    const index = ((raw % count) + count) % count;
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const scale = this.jitterScale;
    dst[0] = (halton(index + 1, 2) - 0.5) * 2.0 * scale / w;
    dst[1] = (halton(index + 1, 3) - 0.5) * 2.0 * scale / h;
    return dst;
  }

  /* ======================================================================== */
  /* Programs                                                                 */
  /* ======================================================================== */

  /**
   * Compile (once) and return a program by key. Never throws.
   * @param {string} key program key
   * @returns {?Object} the program, or null when it failed to build
   * @private
   */
  _program(key) {
    if (this._programs.has(key)) return this._programs.get(key);
    let program = null;
    try {
      program = this._buildProgram(key);
      if (program && typeof program.ready === 'function') program.ready();
      if (program && !program.program) program = null;
    } catch (err) {
      console.error(`[post] failed to build program "${key}":`, err);
      program = null;
    }
    this._programs.set(key, program);
    return program;
  }

  /**
   * Create the GL program for a key.
   * @param {string} key program key
   * @returns {?Object} freshly created program
   * @private
   */
  _buildProgram(key) {
    const device = this.device;
    switch (key) {
      case 'taa': return device.createProgram('post.taa', FULLSCREEN_VS, TAA_FS);
      case 'motionBlur': return device.createProgram('post.motionBlur', FULLSCREEN_VS, MOTION_BLUR_FS);
      case 'dofPrepass': return device.createProgram('post.dofPrepass', FULLSCREEN_VS, DOF_PREPASS_FS);
      case 'dofGather': return device.createProgram('post.dofGather', FULLSCREEN_VS, DOF_GATHER_FS);
      case 'dofComposite': return device.createProgram('post.dofComposite', FULLSCREEN_VS, DOF_COMPOSITE_FS);
      case 'bloomPrefilter':
        return device.createProgram('post.bloomPrefilter', FULLSCREEN_VS, BLOOM_DOWN_FS,
          { defines: { BLOOM_PREFILTER: 1 } });
      case 'bloomDown': return device.createProgram('post.bloomDown', FULLSCREEN_VS, BLOOM_DOWN_FS);
      case 'bloomUp': return device.createProgram('post.bloomUp', FULLSCREEN_VS, BLOOM_UP_FS);
      case 'luminance': return device.createProgram('post.luminance', FULLSCREEN_VS, LUMINANCE_FS);
      case 'adapt': return device.createProgram('post.adapt', FULLSCREEN_VS, ADAPT_FS);
      case 'final': return device.createProgram('post.final', FULLSCREEN_VS, FINAL_FS);
      case 'fxaa': return device.createProgram('post.fxaa', FULLSCREEN_VS, FXAA_FS);
      case 'blit': return device.createProgram('post.blit', FULLSCREEN_VS, BLIT_FS);
      default: return null;
    }
  }

  /* ======================================================================== */
  /* Render targets                                                           */
  /* ======================================================================== */

  /**
   * Preferred HDR colour format; falls back to `RGBA8` without float targets.
   * @returns {number} sized internal format
   * @private
   */
  _hdrFormat() {
    const gl = this.gl;
    return this.device.caps && this.device.caps.colorBufferFloat ? gl.RGBA16F : gl.RGBA8;
  }

  /**
   * Create a single-attachment colour target plus its framebuffer.
   * @param {string} name debug name
   * @param {number} width width in pixels
   * @param {number} height height in pixels
   * @param {number} internalFormat sized internal format
   * @param {{mips?:boolean, filter?:string, wrap?:string}} [opts] extra options
   * @returns {?{tex:WebGLTexture, fbo:Object, width:number, height:number}} target
   * @private
   */
  _makeTarget(name, width, height, internalFormat, opts = {}) {
    const gl = this.gl;
    const device = this.device;
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    try {
      const tex = device.createTexture({
        target: gl.TEXTURE_2D,
        width: w,
        height: h,
        internalFormat,
        min: opts.mips ? 'linear_mipmap_linear' : (opts.filter || 'linear'),
        mag: opts.filter || 'linear',
        wrap: opts.wrap || 'clamp',
        mips: !!opts.mips,
      });
      const fbo = device.createFramebuffer({ color: [tex], depth: null, name, ownTextures: true });
      if (!fbo.complete) {
        fbo.dispose();
        return null;
      }
      return { tex, fbo, width: w, height: h };
    } catch (err) {
      console.error(`[post] failed to create target "${name}":`, err);
      return null;
    }
  }

  /**
   * Lazily obtain a full-resolution HDR ping-pong slot.
   * @param {number} slot 0 or 1
   * @returns {?{tex:WebGLTexture, fbo:Object}} target
   * @private
   */
  _hdrTarget(slot) {
    const i = slot & 1;
    if (!this._hdr[i]) {
      this._hdr[i] = this._makeTarget(`post.hdr${i}`, this.width, this.height, this._hdrFormat());
    }
    return this._hdr[i];
  }

  /**
   * Lazily obtain a full-resolution LDR ping-pong slot.
   * @param {number} slot 0 or 1
   * @returns {?{tex:WebGLTexture, fbo:Object}} target
   * @private
   */
  _ldrTarget(slot) {
    const i = slot & 1;
    if (!this._ldr[i]) {
      this._ldr[i] = this._makeTarget(`post.ldr${i}`, this.width, this.height, this.gl.RGBA8);
    }
    return this._ldr[i];
  }

  /**
   * Lazily obtain a TAA history slot.
   * @param {number} slot 0 or 1
   * @returns {?{tex:WebGLTexture, fbo:Object}} target
   * @private
   */
  _historyTarget(slot) {
    const i = slot & 1;
    if (!this._history[i]) {
      this._history[i] = this._makeTarget(`post.history${i}`, this.width, this.height, this._hdrFormat());
      this._historyValid = false;
    }
    return this._history[i];
  }

  /**
   * Base divisor of the bloom chain. Scales with the screen height so the
   * coarsest of the {@link BLOOM_LEVELS} mips always covers the same *fraction*
   * of the screen — the reason the bloom radius is resolution independent.
   * @returns {number} power-of-two divisor in `[2, 8]`
   * @private
   */
  _bloomBaseDiv() {
    const ratio = Math.max(1e-3, this.height / REFERENCE_HEIGHT);
    const exp = clamp(Math.round(Math.log2(ratio)) + 1, 1, 3);
    return 1 << exp;
  }

  /**
   * (Re)build the bloom mip chain for the current resolution.
   * @returns {boolean} true when the chain is usable
   * @private
   */
  _ensureBloom() {
    const div = this._bloomBaseDiv();
    if (this._bloom.length === BLOOM_LEVELS && this._bloomDiv === div &&
        this._bloom[0] && this._bloom[0].width === Math.max(1, Math.floor(this.width / div))) {
      return true;
    }
    this._releaseBloom();
    this._bloomDiv = div;
    const format = this._hdrFormat();
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const d = div << i;
      const w = Math.max(1, Math.floor(this.width / d));
      const h = Math.max(1, Math.floor(this.height / d));
      const target = this._makeTarget(`post.bloom${i}`, w, h, format);
      if (!target) {
        this._releaseBloom();
        return false;
      }
      this._bloom.push(target);
    }
    return true;
  }

  /**
   * (Re)build the half-resolution depth-of-field targets.
   * @returns {boolean} true when the targets are usable
   * @private
   */
  _ensureDof() {
    if (this._dof && this._dof.width === this.halfWidth && this._dof.height === this.halfHeight) return true;
    this._releaseDof();
    const gl = this.gl;
    const device = this.device;
    const format = this._hdrFormat();
    const w = this.halfWidth;
    const h = this.halfHeight;
    const make = () => device.createTexture({
      target: gl.TEXTURE_2D,
      width: w,
      height: h,
      internalFormat: format,
      min: 'linear',
      mag: 'linear',
      wrap: 'clamp',
      mips: false,
    });
    try {
      const nearA = make();
      const farA = make();
      const nearB = make();
      const farB = make();
      const fboA = device.createFramebuffer({ color: [nearA, farA], depth: null, name: 'post.dofPrepass' });
      const fboB = device.createFramebuffer({ color: [nearB, farB], depth: null, name: 'post.dofGather' });
      if (!fboA.complete || !fboB.complete) {
        fboA.dispose();
        fboB.dispose();
        device.deleteTexture(nearA);
        device.deleteTexture(farA);
        device.deleteTexture(nearB);
        device.deleteTexture(farB);
        return false;
      }
      this._dof = { nearA, farA, nearB, farB, fboA, fboB, width: w, height: h };
      return true;
    } catch (err) {
      console.error('[post] failed to create DOF targets:', err);
      this._dof = null;
      return false;
    }
  }

  /**
   * (Re)build the fixed-size auto-exposure targets.
   * @returns {boolean} true when the targets are usable
   * @private
   */
  _ensureExposure() {
    const format = this.device.caps && this.device.caps.colorBufferFloat ? this.gl.R16F : this.gl.RGBA8;
    if (!this._lum) {
      this._lum = this._makeTarget('post.luminance', LUM_SIZE, LUM_SIZE, format, { mips: true });
    }
    if (!this._adapt[0]) {
      this._adapt[0] = this._makeTarget('post.exposure0', 1, 1, format, { filter: 'nearest' });
      this._adaptValid = false;
    }
    if (!this._adapt[1]) {
      this._adapt[1] = this._makeTarget('post.exposure1', 1, 1, format, { filter: 'nearest' });
      this._adaptValid = false;
    }
    return !!(this._lum && this._adapt[0] && this._adapt[1]);
  }

  /* ---- release ----------------------------------------------------------- */

  /**
   * Dispose the TAA history pair.
   * @returns {void}
   * @private
   */
  _releaseHistory() {
    for (let i = 0; i < 2; i++) {
      if (this._history[i]) this._history[i].fbo.dispose();
      this._history[i] = null;
    }
    this._historyValid = false;
  }

  /**
   * Dispose the bloom mip chain.
   * @returns {void}
   * @private
   */
  _releaseBloom() {
    for (const level of this._bloom) if (level) level.fbo.dispose();
    this._bloom.length = 0;
  }

  /**
   * Dispose the depth-of-field targets.
   * @returns {void}
   * @private
   */
  _releaseDof() {
    const dof = this._dof;
    if (!dof) return;
    dof.fboA.dispose();
    dof.fboB.dispose();
    this.device.deleteTexture(dof.nearA);
    this.device.deleteTexture(dof.farA);
    this.device.deleteTexture(dof.nearB);
    this.device.deleteTexture(dof.farB);
    this._dof = null;
  }

  /**
   * Dispose the auto-exposure targets.
   * @returns {void}
   * @private
   */
  _releaseExposure() {
    if (this._lum) this._lum.fbo.dispose();
    this._lum = null;
    for (let i = 0; i < 2; i++) {
      if (this._adapt[i]) this._adapt[i].fbo.dispose();
      this._adapt[i] = null;
    }
    this._adaptValid = false;
  }

  /**
   * Dispose every resolution-dependent target (they are recreated on demand).
   * @returns {void}
   * @private
   */
  _releaseSized() {
    for (let i = 0; i < 2; i++) {
      if (this._hdr[i]) this._hdr[i].fbo.dispose();
      this._hdr[i] = null;
      if (this._ldr[i]) this._ldr[i].fbo.dispose();
      this._ldr[i] = null;
    }
    this._releaseHistory();
    this._releaseBloom();
    this._releaseDof();
  }

  /**
   * Reallocate every size-dependent target.
   * @param {number} w new width in pixels
   * @param {number} h new height in pixels
   * @returns {void}
   */
  resize(w, h) {
    if (this._disposed) return;
    const nw = Math.max(1, w | 0);
    const nh = Math.max(1, h | 0);
    if (nw === this.width && nh === this.height) return;
    this.width = nw;
    this.height = nh;
    this.halfWidth = Math.max(1, Math.ceil(nw / 2));
    this.halfHeight = Math.max(1, Math.ceil(nh / 2));
    this._releaseSized();
  }

  /* ======================================================================== */
  /* Blue noise                                                               */
  /* ======================================================================== */

  /**
   * Resolve the blue-noise mask, generating a fallback exactly once.
   * @param {?Object} frame the per-frame object
   * @returns {?WebGLTexture} mask texture
   * @private
   */
  _resolveNoise(frame) {
    if (this.blueNoise) {
      this._noiseSize = noiseSizeOf(this.blueNoise);
      return this.blueNoise;
    }
    const candidates = [
      frame && frame.blueNoise,
      frame && frame.textures && frame.textures.blueNoise,
      frame && frame.renderer && frame.renderer.textures && frame.renderer.textures.blueNoise,
    ];
    for (const candidate of candidates) {
      if (candidate) {
        this.blueNoise = candidate;
        this._noiseSize = noiseSizeOf(candidate);
        return candidate;
      }
    }
    if (!this._fallbackNoise) {
      try {
        const gl = this.gl;
        this._fallbackNoise = this.device.createTexture({
          target: gl.TEXTURE_2D,
          width: FALLBACK_NOISE_SIZE,
          height: FALLBACK_NOISE_SIZE,
          internalFormat: gl.R8,
          data: generateFallbackNoise(FALLBACK_NOISE_SIZE),
          min: 'nearest',
          mag: 'nearest',
          wrap: 'repeat',
          mips: false,
        });
      } catch (err) {
        console.error('[post] fallback blue noise generation failed:', err);
        this._fallbackNoise = null;
      }
    }
    if (this._fallbackNoise) this._noiseSize = FALLBACK_NOISE_SIZE;
    return this._fallbackNoise;
  }

  /**
   * Refresh the per-frame noise scale/offset scratch vectors.
   * @param {number} frameIndex current frame index
   * @returns {void}
   * @private
   */
  _updateNoiseUniforms(frameIndex) {
    const size = Math.max(1, this._noiseSize);
    this._noiseUVScale[0] = this.width / size;
    this._noiseUVScale[1] = this.height / size;
    const cycle = ((frameIndex % 64) + 64) % 64;
    this._noiseOffset[0] = Math.floor(fract(cycle * R2_A1) * size) / size;
    this._noiseOffset[1] = Math.floor(fract(cycle * R2_A2) * size) / size;
    this._grainOffset[0] = fract(frameIndex * R2_A1) * 512.0;
    this._grainOffset[1] = fract(frameIndex * R2_A2) * 512.0;
  }

  /* ======================================================================== */
  /* Render                                                                   */
  /* ======================================================================== */

  /**
   * Run the whole post chain.
   *
   * Every disabled stage is skipped without allocating (or keeping) its render
   * targets. Nothing here throws: a failure logs once and permanently degrades
   * the chain to a plain exposure + ACES + sRGB blit.
   *
   * @param {WebGLTexture} sceneTex HDR scene colour (full resolution).
   * @param {?WebGLTexture} depthTex G-buffer depth; TAA/motion blur/DOF are
   *        skipped when it is missing.
   * @param {?Object} frame the per-frame object (`dt`, `frameIndex`, `hit`, ...).
   * @param {boolean} [outputToScreen=true] draw to the default framebuffer.
   * @returns {?WebGLTexture} the final LDR texture when `outputToScreen` is
   *          false, otherwise `null`.
   */
  render(sceneTex, depthTex, frame, outputToScreen = true) {
    if (this._disposed || !sceneTex) return null;
    const device = this.device;
    const gl = this.gl;

    const meta = sceneTex.__vox;
    const w = meta && meta.width ? meta.width : (gl.drawingBufferWidth || this.width);
    const h = meta && meta.height ? meta.height : (gl.drawingBufferHeight || this.height);
    if (w !== this.width || h !== this.height) this.resize(w, h);

    const dt = frame && Number.isFinite(frame.dt) ? clamp(frame.dt, 0, 0.25) : 1 / 60;
    const frameIndex = frame && Number.isFinite(frame.frameIndex)
      ? (frame.frameIndex | 0)
      : this._frameCounter;
    this._frameCounter = (this._frameCounter + 1) & 0x3fffffff;

    if (this._failed) return this._renderFallback(sceneTex, outputToScreen);

    try {
      const hasDepth = !!depthTex;
      const useTaa = hasDepth && this._setting('taa', true) !== false;
      const useMotionBlur = hasDepth && this._setting('motionBlur', true) !== false;
      const useDof = hasDepth && this._setting('dof', false) === true;
      const useBloom = this._setting('bloom', true) !== false;
      const useAuto = this.autoExposure !== false;

      if (!useTaa && this._history[0]) this._releaseHistory();
      if (!useBloom && this._bloom.length) this._releaseBloom();
      if (!useDof && this._dof) this._releaseDof();
      if (!useAuto && this._lum) this._releaseExposure();

      const noiseTex = this._resolveNoise(frame);
      this._updateNoiseUniforms(frameIndex);

      device.setScissor(false);
      device.setDepthTest(false);
      device.setDepthWrite(false);
      device.setBlend('none');
      device.setCull('none');
      device.setColorMask(true, true, true, true);

      this._pingIndex = 0;
      let color = sceneTex;

      if (useTaa) color = this._renderTaa(color, depthTex) || color;
      if (useMotionBlur) color = this._renderMotionBlur(color, depthTex, noiseTex) || color;
      if (useDof) color = this._renderDof(color, depthTex, noiseTex, frame, dt) || color;

      const exposureTex = useAuto ? this._renderExposure(color, dt) : null;
      const bloomTex = useBloom ? this._renderBloom(color, exposureTex) : null;

      return this._renderFinal(color, bloomTex, exposureTex, noiseTex, useTaa, outputToScreen);
    } catch (err) {
      this._fail(err);
      return this._renderFallback(sceneTex, outputToScreen);
    }
  }

  /**
   * TAA resolve into the current history slot.
   * @param {WebGLTexture} sceneTex current HDR frame
   * @param {WebGLTexture} depthTex G-buffer depth
   * @returns {?WebGLTexture} the resolved colour, or null when unavailable
   * @private
   */
  _renderTaa(sceneTex, depthTex) {
    const program = this._program('taa');
    if (!program) return null;
    const current = this._historyTarget(this._historyIndex);
    const previous = this._historyTarget(1 - this._historyIndex);
    if (!current || !previous) return null;

    const device = this.device;
    const gl = this.gl;

    device.bindFramebuffer(current.fbo);
    if (!program.use()) return null;
    program.bindUBO('Frame', FRAME_UBO_BINDING);
    program.setTexture('u_sceneColor', sceneTex, POST_SCENE_UNIT, gl.TEXTURE_2D);
    program.setTexture('u_gDepth', depthTex, POST_DEPTH_UNIT, gl.TEXTURE_2D);
    program.setTexture('u_history', previous.tex, POST_AUX_UNIT, gl.TEXTURE_2D);

    this._vec2A[0] = 1 / this.width;
    this._vec2A[1] = 1 / this.height;
    program.setVec2('u_texel', this._vec2A);

    this._vec4A[0] = clamp(this.feedbackMax, 0, 0.99);
    this._vec4A[1] = clamp(this.feedbackMin, 0, 0.99);
    this._vec4A[2] = Math.max(this.varianceGamma, 0.1);
    this._vec4A[3] = this._historyValid ? 1 : 0;
    program.setVec4('u_taaParams', this._vec4A);

    this._vec2B[0] = Math.max(this.depthEdgeScale, 1e-4);
    this._vec2B[1] = Math.max(this.motionRejectPixels, 1);
    program.setVec2('u_taaEdge', this._vec2B);

    device.drawFullscreen();

    this._historyIndex = 1 - this._historyIndex;
    this._historyValid = true;
    return current.tex;
  }

  /**
   * Velocity-driven motion blur.
   * @param {WebGLTexture} colorTex input colour
   * @param {WebGLTexture} depthTex G-buffer depth
   * @param {?WebGLTexture} noiseTex blue-noise mask
   * @returns {?WebGLTexture} blurred colour, or null when unavailable
   * @private
   */
  _renderMotionBlur(colorTex, depthTex, noiseTex) {
    const program = this._program('motionBlur');
    if (!program || !noiseTex) return null;
    const target = this._hdrTarget(this._pingIndex);
    if (!target) return null;
    this._pingIndex ^= 1;

    const device = this.device;
    const gl = this.gl;

    device.bindFramebuffer(target.fbo);
    if (!program.use()) return null;
    program.bindUBO('Frame', FRAME_UBO_BINDING);
    program.setTexture('u_sceneColor', colorTex, POST_SCENE_UNIT, gl.TEXTURE_2D);
    program.setTexture('u_gDepth', depthTex, POST_DEPTH_UNIT, gl.TEXTURE_2D);
    program.setTexture('u_blueNoise', noiseTex, POST_BLUE_NOISE_UNIT, gl.TEXTURE_2D);

    this._vec2A[0] = 1 / this.width;
    this._vec2A[1] = 1 / this.height;
    program.setVec2('u_texel', this._vec2A);
    program.setVec2('u_noiseUVScale', this._noiseUVScale);
    program.setVec2('u_noiseOffset', this._noiseOffset);

    this._vec4A[0] = clamp(this.shutterAngle / 360, 0, 1);
    this._vec4A[1] = clamp(this.motionBlurMaxRadius, 0.001, 0.25);
    this._vec4A[2] = Math.max(this.motionBlurDepthSoftness, 1e-3);
    this._vec4A[3] = 0;
    program.setVec4('u_mbParams', this._vec4A);

    device.drawFullscreen();
    return target.tex;
  }

  /**
   * Update the smoothed focus distance from the crosshair hit.
   * @param {?Object} frame per-frame object
   * @param {number} dt seconds since the last frame
   * @returns {number} focus distance in blocks
   * @private
   */
  _updateFocus(frame, dt) {
    let target = this.focusDistance;
    if (this.autoFocus) {
      const hit = frame && frame.hit;
      target = hit && Number.isFinite(hit.dist) ? hit.dist : this.defaultFocusDistance;
    }
    target = clamp(target, 0.2, 4096);
    this._focus = damp(this._focus, target, Math.max(this.focusSpeed, 0), dt);
    if (!Number.isFinite(this._focus)) this._focus = target;
    return this._focus;
  }

  /**
   * Half-resolution bokeh depth of field with separate near/far fields.
   * @param {WebGLTexture} colorTex input colour
   * @param {WebGLTexture} depthTex G-buffer depth
   * @param {?WebGLTexture} noiseTex blue-noise mask
   * @param {?Object} frame per-frame object
   * @param {number} dt seconds since the last frame
   * @returns {?WebGLTexture} composited colour, or null when unavailable
   * @private
   */
  _renderDof(colorTex, depthTex, noiseTex, frame, dt) {
    const prepass = this._program('dofPrepass');
    const gather = this._program('dofGather');
    const composite = this._program('dofComposite');
    if (!prepass || !gather || !composite || !noiseTex) return null;
    if (!this._ensureDof()) return null;

    const device = this.device;
    const gl = this.gl;
    const dof = this._dof;

    const focus = this._updateFocus(frame, dt);
    const maxRadius = clamp(this.bokehRadiusFraction * this.halfHeight, 2, 32);
    this._dofParams[0] = focus;
    this._dofParams[1] = Math.max(this.aperture, 0.01);
    this._dofParams[2] = maxRadius;
    this._dofParams[3] = 0;

    // ---- 1. prepass: half-res colour + signed CoC split -------------------
    device.bindFramebuffer(dof.fboA);
    if (!prepass.use()) return null;
    prepass.bindUBO('Frame', FRAME_UBO_BINDING);
    prepass.setTexture('u_sceneColor', colorTex, POST_SCENE_UNIT, gl.TEXTURE_2D);
    prepass.setTexture('u_gDepth', depthTex, POST_DEPTH_UNIT, gl.TEXTURE_2D);
    this._vec2A[0] = 1 / this.width;
    this._vec2A[1] = 1 / this.height;
    prepass.setVec2('u_texel', this._vec2A);
    prepass.setVec4('u_dofParams', this._dofParams);
    device.drawFullscreen();

    // ---- 2. gather: golden-angle disc, near + far -------------------------
    device.bindFramebuffer(dof.fboB);
    if (!gather.use()) return null;
    gather.setTexture('u_dofNear', dof.nearA, POST_AUX_UNIT, gl.TEXTURE_2D);
    gather.setTexture('u_dofFar', dof.farA, POST_AUX2_UNIT, gl.TEXTURE_2D);
    gather.setTexture('u_blueNoise', noiseTex, POST_BLUE_NOISE_UNIT, gl.TEXTURE_2D);
    this._vec2B[0] = 1 / this.halfWidth;
    this._vec2B[1] = 1 / this.halfHeight;
    gather.setVec2('u_texel', this._vec2B);
    gather.setVec2('u_noiseUVScale', this._noiseUVScale);
    gather.setVec2('u_noiseOffset', this._noiseOffset);
    gather.setVec4('u_dofParams', this._dofParams);
    device.drawFullscreen();

    // ---- 3. composite back at full resolution -----------------------------
    const target = this._hdrTarget(this._pingIndex);
    if (!target) return null;
    this._pingIndex ^= 1;

    device.bindFramebuffer(target.fbo);
    if (!composite.use()) return null;
    composite.bindUBO('Frame', FRAME_UBO_BINDING);
    composite.setTexture('u_sceneColor', colorTex, POST_SCENE_UNIT, gl.TEXTURE_2D);
    composite.setTexture('u_gDepth', depthTex, POST_DEPTH_UNIT, gl.TEXTURE_2D);
    composite.setTexture('u_dofNear', dof.nearB, POST_AUX_UNIT, gl.TEXTURE_2D);
    composite.setTexture('u_dofFar', dof.farB, POST_AUX2_UNIT, gl.TEXTURE_2D);
    composite.setVec4('u_dofParams', this._dofParams);
    device.drawFullscreen();

    return target.tex;
  }

  /**
   * Auto exposure: log-luminance pyramid, 1x1 mip average, adaptation ping-pong.
   * @param {WebGLTexture} colorTex current HDR colour
   * @param {number} dt seconds since the last frame
   * @returns {?WebGLTexture} the 1x1 adaptation texture, or null when unavailable
   * @private
   */
  _renderExposure(colorTex, dt) {
    const lumProgram = this._program('luminance');
    const adaptProgram = this._program('adapt');
    if (!lumProgram || !adaptProgram) return null;
    if (!this._ensureExposure()) return null;

    const device = this.device;
    const gl = this.gl;

    // ---- 1. log-luminance ------------------------------------------------
    device.bindFramebuffer(this._lum.fbo);
    if (!lumProgram.use()) return null;
    lumProgram.setTexture('u_sceneColor', colorTex, POST_SCENE_UNIT, gl.TEXTURE_2D);
    this._vec2A[0] = 0.25 / LUM_SIZE;
    this._vec2A[1] = 0.25 / LUM_SIZE;
    lumProgram.setVec2('u_spread', this._vec2A);
    device.drawFullscreen();

    device.generateMipmap(this._lum.tex);

    // ---- 2. adaptation ---------------------------------------------------
    const current = this._adapt[this._adaptIndex];
    const previous = this._adapt[1 - this._adaptIndex];
    if (!current || !previous) return null;

    device.bindFramebuffer(current.fbo);
    if (!adaptProgram.use()) return null;
    adaptProgram.setTexture('u_lumTex', this._lum.tex, POST_AUX_UNIT, gl.TEXTURE_2D);
    adaptProgram.setTexture('u_prevExposure', previous.tex, POST_AUX2_UNIT, gl.TEXTURE_2D);

    this._vec4A[0] = dt;
    this._vec4A[1] = Math.max(this.adaptSpeedUp, 0);
    this._vec4A[2] = Math.max(this.adaptSpeedDown, 0);
    this._vec4A[3] = this._adaptValid ? 1 : 0;
    adaptProgram.setVec4('u_adaptParams', this._vec4A);

    this._vec4B[0] = Math.max(this.exposureKey, 1e-4);
    this._vec4B[1] = Math.max(this.minExposure, 1e-3);
    this._vec4B[2] = Math.max(this.maxExposure, this.minExposure + 1e-3);
    this._vec4B[3] = LUM_MIP;
    adaptProgram.setVec4('u_adaptRange', this._vec4B);

    device.drawFullscreen();

    this._adaptIndex = 1 - this._adaptIndex;
    this._adaptValid = true;
    return current.tex;
  }

  /**
   * Progressive bloom: Karis-filtered soft-knee prefilter, five more
   * downsamples, then an additive tent-filter upsample chain.
   * @param {WebGLTexture} colorTex current HDR colour
   * @param {?WebGLTexture} exposureTex 1x1 adaptation texture (may be null)
   * @returns {?WebGLTexture} the largest bloom mip, or null when unavailable
   * @private
   */
  _renderBloom(colorTex, exposureTex) {
    const prefilter = this._program('bloomPrefilter');
    const down = this._program('bloomDown');
    const up = this._program('bloomUp');
    if (!prefilter || !down || !up) return null;
    if (!this._ensureBloom()) return null;

    const device = this.device;
    const gl = this.gl;
    const chain = this._bloom;
    const manualExposure = Math.max(Number(this._setting('exposure', 1)) || 0, 0);

    // ---- 1. prefilter (full res -> level 0) ------------------------------
    device.setBlend('none');
    device.bindFramebuffer(chain[0].fbo);
    if (!prefilter.use()) return null;
    prefilter.setTexture('u_source', colorTex, POST_AUX_UNIT, gl.TEXTURE_2D);
    prefilter.setTexture('u_exposureTex', exposureTex || colorTex, POST_AUX2_UNIT, gl.TEXTURE_2D);
    this._vec2A[0] = manualExposure;
    this._vec2A[1] = exposureTex ? 1 : 0;
    prefilter.setVec2('u_exposureCtl', this._vec2A);
    this._vec2B[0] = 1 / this.width;
    this._vec2B[1] = 1 / this.height;
    prefilter.setVec2('u_texel', this._vec2B);

    const threshold = Math.max(this.bloomThreshold, 0);
    const knee = Math.max(threshold * clamp(this.bloomKnee, 0.001, 1), 1e-4);
    this._vec4A[0] = threshold;
    this._vec4A[1] = threshold - knee;
    this._vec4A[2] = 2 * knee;
    this._vec4A[3] = 0.25 / knee;
    prefilter.setVec4('u_filter', this._vec4A);
    device.drawFullscreen();

    // ---- 2. downsample chain ---------------------------------------------
    if (!down.use()) return null;
    for (let i = 1; i < chain.length; i++) {
      const src = chain[i - 1];
      device.bindFramebuffer(chain[i].fbo);
      down.setTexture('u_source', src.tex, POST_AUX_UNIT, gl.TEXTURE_2D);
      this._vec2C[0] = 1 / src.width;
      this._vec2C[1] = 1 / src.height;
      down.setVec2('u_texel', this._vec2C);
      device.drawFullscreen();
    }

    // ---- 3. additive tent upsample ---------------------------------------
    device.setBlend('add');
    if (!up.use()) {
      device.setBlend('none');
      return null;
    }
    const radius = Math.max(this.bloomRadius, 0.1);
    for (let i = chain.length - 2; i >= 0; i--) {
      const dst = chain[i];
      device.bindFramebuffer(dst.fbo);
      up.setTexture('u_source', chain[i + 1].tex, POST_AUX_UNIT, gl.TEXTURE_2D);
      this._vec2D[0] = radius / dst.width;
      this._vec2D[1] = radius / dst.height;
      up.setVec2('u_radius', this._vec2D);
      device.drawFullscreen();
    }
    device.setBlend('none');

    return chain[0].tex;
  }

  /**
   * The merged finishing pass (+ optional FXAA when TAA is off).
   * @param {WebGLTexture} colorTex HDR colour
   * @param {?WebGLTexture} bloomTex bloom result or null
   * @param {?WebGLTexture} exposureTex 1x1 adaptation texture or null
   * @param {?WebGLTexture} noiseTex blue-noise mask
   * @param {boolean} taaActive whether TAA ran (FXAA is skipped then)
   * @param {boolean} outputToScreen draw to the default framebuffer
   * @returns {?WebGLTexture} final texture when not drawing to the screen
   * @private
   */
  _renderFinal(colorTex, bloomTex, exposureTex, noiseTex, taaActive, outputToScreen) {
    const program = this._program('final');
    if (!program) throw new Error('post: the final pass failed to build');

    const device = this.device;
    const gl = this.gl;

    let fxaaProgram = null;
    if (!taaActive && this.fxaa !== false) fxaaProgram = this._program('fxaa');

    const firstTarget = (fxaaProgram || !outputToScreen) ? this._ldrTarget(0) : null;
    if ((fxaaProgram || !outputToScreen) && !firstTarget) {
      throw new Error('post: LDR target allocation failed');
    }

    device.setBlend('none');
    device.bindFramebuffer(firstTarget ? firstTarget.fbo : null);
    if (!program.use()) throw new Error('post: the final pass is not usable');
    program.bindUBO('Frame', FRAME_UBO_BINDING);

    program.setTexture('u_sceneColor', colorTex, POST_SCENE_UNIT, gl.TEXTURE_2D);
    program.setTexture('u_bloom', bloomTex || colorTex, POST_AUX_UNIT, gl.TEXTURE_2D);
    program.setTexture('u_exposureTex', exposureTex || colorTex, POST_AUX2_UNIT, gl.TEXTURE_2D);
    if (noiseTex) program.setTexture('u_blueNoise', noiseTex, POST_BLUE_NOISE_UNIT, gl.TEXTURE_2D);

    this._vec2A[0] = 1 / this.width;
    this._vec2A[1] = 1 / this.height;
    program.setVec2('u_texel', this._vec2A);
    program.setVec2('u_noiseUVScale', this._noiseUVScale);
    program.setVec2('u_noiseOffset', this._noiseOffset);
    program.setVec2('u_grainOffset', this._grainOffset);

    const manualExposure = Math.max(Number(this._setting('exposure', 1)) || 0, 0);
    this._vec2B[0] = manualExposure;
    this._vec2B[1] = exposureTex ? 1 : 0;
    program.setVec2('u_exposureCtl', this._vec2B);

    this._vec4A[0] = manualExposure;
    this._vec4A[1] = clamp(Number(this._setting('saturation', 1.05)) || 1, 0, 3);
    this._vec4A[2] = clamp(Number(this._setting('contrast', 1.02)) || 1, 0.25, 3);
    this._vec4A[3] = bloomTex ? clamp(this.bloomStrength, 0, 1) : 0;
    program.setVec4('u_grade', this._vec4A);

    const wantCA = this._setting('chromaticAberration', true) !== false;
    const wantVignette = this._setting('vignette', true) !== false;
    const wantGrain = this._setting('filmGrain', true) !== false;
    this._vec4B[0] = wantCA ? Math.max(this.chromaticAberrationStrength, 0) : 0;
    this._vec4B[1] = wantVignette ? clamp(this.vignetteStrength, 0, 1) : 0;
    this._vec4B[2] = wantGrain ? Math.max(this.filmGrainStrength, 0) : 0;
    this._vec4B[3] = noiseTex ? Math.max(this.ditherStrength, 0) : 0;
    program.setVec4('u_effects', this._vec4B);

    this._vec4C[0] = 0;
    this._vec4C[1] = bloomTex ? 1 : 0;
    this._vec4C[2] = clamp(this.gradeStrength, 0, 1);
    this._vec4C[3] = this.width / Math.max(this.height, 1);
    program.setVec4('u_extra', this._vec4C);

    device.drawFullscreen();

    if (!fxaaProgram) return firstTarget ? firstTarget.tex : null;

    // ---- FXAA (TAA is off) -------------------------------------------------
    const secondTarget = outputToScreen ? null : this._ldrTarget(1);
    if (!outputToScreen && !secondTarget) return firstTarget.tex;

    device.bindFramebuffer(secondTarget ? secondTarget.fbo : null);
    if (!fxaaProgram.use()) return firstTarget ? firstTarget.tex : null;
    fxaaProgram.setTexture('u_sceneColor', firstTarget.tex, POST_SCENE_UNIT, gl.TEXTURE_2D);
    this._vec2A[0] = 1 / this.width;
    this._vec2A[1] = 1 / this.height;
    fxaaProgram.setVec2('u_texel', this._vec2A);
    device.drawFullscreen();

    return secondTarget ? secondTarget.tex : null;
  }

  /**
   * Minimal exposure + ACES + sRGB output used after a fatal error.
   * @param {WebGLTexture} sceneTex HDR scene colour
   * @param {boolean} outputToScreen draw to the default framebuffer
   * @returns {?WebGLTexture} final texture when not drawing to the screen
   * @private
   */
  _renderFallback(sceneTex, outputToScreen) {
    const program = this._program('blit');
    if (!program) return null;
    try {
      const device = this.device;
      const gl = this.gl;
      const target = outputToScreen ? null : this._ldrTarget(0);
      device.setScissor(false);
      device.setDepthTest(false);
      device.setDepthWrite(false);
      device.setBlend('none');
      device.setCull('none');
      device.setColorMask(true, true, true, true);
      device.bindFramebuffer(target ? target.fbo : null);
      if (!program.use()) return null;
      program.setTexture('u_sceneColor', sceneTex, POST_SCENE_UNIT, gl.TEXTURE_2D);
      program.setFloat('u_exposure', Math.max(Number(this._setting('exposure', 1)) || 1, 0));
      device.drawFullscreen();
      return target ? target.tex : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Log a fatal error exactly once and disable the full chain.
   * @param {*} err the caught error
   * @returns {void}
   * @private
   */
  _fail(err) {
    if (this._failed) return;
    this._failed = true;
    console.error('[post] post-processing disabled after an error:', err);
    this._releaseSized();
    this._releaseExposure();
  }

  /* ======================================================================== */
  /* Teardown                                                                 */
  /* ======================================================================== */

  /**
   * Release every GPU resource owned by the post chain.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (this.settings && typeof this.settings.off === 'function') {
      try {
        this.settings.off('change', this._onSettingsChange);
      } catch (err) {
        /* the store may not support removal — harmless */
      }
    }

    this._releaseSized();
    this._releaseExposure();

    for (const program of this._programs.values()) {
      if (program && typeof program.dispose === 'function') program.dispose();
    }
    this._programs.clear();

    if (this._fallbackNoise) {
      this.device.deleteTexture(this._fallbackNoise);
      this._fallbackNoise = null;
    }
    this.blueNoise = null;
  }
}

export default PostProcess;
