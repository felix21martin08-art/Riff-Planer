/**
 * @file render/sky.js — VOXELIA physically based sky (ARCHITECTURE.md 5.20).
 *
 * The sky is the single biggest contributor to the mood of the game, so it is
 * not a gradient: it is a real atmosphere. Three GPU look-up tables encode a
 * Rayleigh + Mie + ozone atmosphere with a Hillaire-style multiple-scattering
 * approximation, and a single fullscreen pass composites the atmosphere, the
 * star field, the moon, the sun, the aurora and two layers of volumetric clouds
 * into the HDR scene colour wherever the depth buffer is still at the far plane.
 *
 * ## The look-up tables
 *
 * | LUT             | default size | depends on            | rebuilt when |
 * |-----------------|--------------|-----------------------|--------------|
 * | transmittance   | `256 x 64`   | atmosphere only       | haze/rain changes |
 * | multi-scatter   | `32 x 32`    | atmosphere + sun      | sun moves / haze changes |
 * | sky-view        | `192 x 108`  | atmosphere + sun + eye| sun moves / haze / altitude |
 *
 * The transmittance LUT uses the Bruneton parameterisation
 * (`d`-based on the x axis, `rho`-based on the y axis) so the horizon is
 * resolved properly. The sky-view LUT is parameterised by the azimuth measured
 * *relative to the sun* (x, wrapping) and by a square-root remapped zenith angle
 * that is split at the horizon (y), which concentrates texels exactly where the
 * atmosphere changes fastest. Earth-like constants throughout: planet radius
 * 6360 km, atmosphere top 6460 km, Rayleigh scattering
 * `(5.802, 13.558, 33.1)e-6 m^-1`, Mie scattering `3.996e-6 m^-1` with
 * `g = 0.8`, Mie absorption `4.4e-6 m^-1` and the usual ozone tent centred at
 * 25 km.
 *
 * ## The background pass
 *
 * `renderBackground()` draws one oversized triangle whose vertices sit at
 * `gl_Position = vec4(xy, 1, 1)`, i.e. exactly on the far plane. The pass runs
 * with **`LEQUAL` depth testing and depth writes off**: a background pixel still
 * holds the cleared depth of `1.0` so `1.0 <= 1.0` passes, while any pixel
 * covered by geometry holds a depth `< 1.0` so the sky fails and is discarded.
 * That is the "far-plane trick" the spec allows, and it is preferred over
 * `EQUAL` because it survives drivers that apply a depth range or a viewport
 * transform with a slightly different rounding — with `EQUAL` a single ULP of
 * disagreement would blank the whole sky.
 *
 * Composited in this order (each stage is additive over the previous one unless
 * noted): atmosphere -> stars -> moon -> sun -> aurora -> cirrus -> cumulus
 * (the last two alpha-composited, cirrus first because it is the higher deck).
 *
 * ## Ambient
 *
 * {@link Sky#getAmbient} does **not** read pixels back from the GPU (a
 * synchronous `readPixels` would stall the pipeline mid-frame). Instead the same
 * atmosphere model — the same constants, the same phase functions, the same
 * density profiles — is evaluated on the CPU in a handful of fixed directions
 * once per LUT update. The result is therefore physically consistent with what
 * the sky-view LUT actually looks like: warm and dim at sunset, deep blue at
 * night, grey and flat in the rain.
 *
 * ## Fixed texture units used (ARCHITECTURE.md 3.5)
 *
 * * **10** `u_skyLUT` — the sky-view LUT, exposed as {@link Sky#lut}.
 * * **11** `u_blueNoise` — dither mask for the cloud ray starts.
 * * **13** `u_cloudNoise` — the 3D Perlin-Worley volume from `TextureManager`.
 * * **15** `u_transmittanceLUT` — per-pass scratch unit (3.5 lists 15 as free).
 *
 * @module render/sky
 */

import { FULLSCREEN_VS } from '../core/gl.js';
import { clamp, lerp, smoothstep } from '../core/math.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Fixed unit the sky-view LUT is exposed on. @type {number} */
export const SKY_LUT_UNIT = 10;
/** Fixed unit of the shared blue-noise mask. @type {number} */
export const BLUE_NOISE_UNIT = 11;
/** Fixed unit of the shared 3D cloud noise volume. @type {number} */
export const CLOUD_NOISE_UNIT = 13;
/** Per-pass scratch unit used for the transmittance LUT. @type {number} */
export const TRANSMITTANCE_LUT_UNIT = 15;

/**
 * Earth-like atmosphere constants, in kilometres and inverse kilometres.
 * These are mirrored verbatim by {@link ATMOSPHERE_GLSL} — change both or
 * neither.
 * @type {Readonly<Object<string, number|number[]>>}
 */
export const ATMOSPHERE = Object.freeze({
  /** Planet radius in km. */
  groundRadius: 6360.0,
  /** Atmosphere top radius in km. */
  topRadius: 6460.0,
  /** Rayleigh scattering coefficients, km^-1. */
  rayleighScattering: Object.freeze([5.802e-3, 13.558e-3, 33.1e-3]),
  /** Rayleigh density scale height, km. */
  rayleighHeight: 8.0,
  /** Mie scattering coefficient, km^-1. */
  mieScattering: 3.996e-3,
  /** Mie absorption coefficient, km^-1. */
  mieAbsorption: 4.4e-3,
  /** Mie density scale height, km. */
  mieHeight: 1.2,
  /** Cornette-Shanks / HG asymmetry of the Mie phase function. */
  mieG: 0.8,
  /** Ozone absorption coefficients, km^-1. */
  ozoneAbsorption: Object.freeze([0.650e-3, 1.881e-3, 0.085e-3]),
  /** Centre of the ozone tent, km. */
  ozoneCenter: 25.0,
  /** Half-width of the ozone tent, km. */
  ozoneWidth: 15.0,
  /** Lambertian albedo of the planet surface used by the scattering integral. */
  groundAlbedo: 0.28,
  /** Top-of-atmosphere sun irradiance in VOXELIA's linear HDR units. */
  sunIlluminance: 20.0,
});

/** World-space radius used to curve both cloud decks toward the horizon. @type {number} */
export const CLOUD_CURVE_RADIUS = 300000.0;

/**
 * Per-`settings.cloudQuality` step for the background pass.
 * `volumetric` is additionally gated by `settings.volumetricClouds`.
 * @type {Readonly<Object<string, {volumetric:boolean, steps:number, lightSteps:number,
 *   cirrus:boolean, aurora:boolean, auroraLayers:number, detail:boolean, starGrid:number}>>}
 */
export const CLOUD_QUALITY = Object.freeze({
  off: Object.freeze({
    volumetric: false, steps: 0, lightSteps: 0, cirrus: false,
    aurora: false, auroraLayers: 0, detail: false, starGrid: 14,
  }),
  low: Object.freeze({
    volumetric: false, steps: 0, lightSteps: 0, cirrus: true,
    aurora: false, auroraLayers: 0, detail: false, starGrid: 18,
  }),
  medium: Object.freeze({
    volumetric: true, steps: 40, lightSteps: 4, cirrus: true,
    aurora: true, auroraLayers: 7, detail: false, starGrid: 22,
  }),
  high: Object.freeze({
    volumetric: true, steps: 64, lightSteps: 5, cirrus: true,
    aurora: true, auroraLayers: 10, detail: true, starGrid: 24,
  }),
  ultra: Object.freeze({
    volumetric: true, steps: 96, lightSteps: 6, cirrus: true,
    aurora: true, auroraLayers: 14, detail: true, starGrid: 24,
  }),
});

/**
 * LUT sizes and raymarch budgets per quality step.
 * `high` is exactly the size the spec asks for (256x64 / 32x32 / 192x108).
 * @type {Readonly<Object<string, Object>>}
 */
export const SKY_LUT_QUALITY = Object.freeze({
  low: Object.freeze({
    transmittance: Object.freeze([128, 32]), multiScatter: Object.freeze([16, 16]),
    skyView: Object.freeze([96, 54]), transSteps: 24, msSqrt: 3, msSteps: 12, viewSteps: 20,
  }),
  medium: Object.freeze({
    transmittance: Object.freeze([192, 48]), multiScatter: Object.freeze([24, 24]),
    skyView: Object.freeze([128, 72]), transSteps: 32, msSqrt: 4, msSteps: 16, viewSteps: 26,
  }),
  high: Object.freeze({
    transmittance: Object.freeze([256, 64]), multiScatter: Object.freeze([32, 32]),
    skyView: Object.freeze([192, 108]), transSteps: 40, msSqrt: 4, msSteps: 20, viewSteps: 32,
  }),
  ultra: Object.freeze({
    transmittance: Object.freeze([256, 64]), multiScatter: Object.freeze([32, 32]),
    skyView: Object.freeze([192, 108]), transSteps: 48, msSqrt: 5, msSteps: 24, viewSteps: 40,
  }),
});

/** Cosine of the angle the sun may drift before the LUTs are rebuilt. @type {number} */
const SUN_EPSILON_COS = Math.cos(0.25 * Math.PI / 180);
/** Haze/rain delta that forces a full LUT rebuild. @type {number} */
const HAZE_EPSILON = 0.01;
/** Camera altitude delta (world units) that forces a sky-view rebuild. @type {number} */
const ALTITUDE_EPSILON = 24.0;
/** Edge size of the internally generated fallback blue-noise mask. @type {number} */
const FALLBACK_NOISE_SIZE = 64;
/** Edge size of the internally generated fallback cloud volume. @type {number} */
const FALLBACK_CLOUD_SIZE = 16;
/** Base world Y of the cumulus deck. @type {number} */
const CUMULUS_BOTTOM = 1200.0;
/** Top world Y of the cumulus deck. @type {number} */
const CUMULUS_TOP = 2600.0;
/** World Y of the thin cirrus sheet. @type {number} */
const CIRRUS_HEIGHT = 5200.0;
/** Furthest distance the cumulus raymarch travels, world units. @type {number} */
const CLOUD_MAX_DISTANCE = 90000.0;
/** R2 low-discrepancy constants used to walk the blue-noise mask per frame. */
const R2_A1 = 0.7548776662466927;
const R2_A2 = 0.5698402909980532;

/* ========================================================================== */
/* GLSL — shared atmosphere                                                   */
/* ========================================================================== */

/**
 * The atmosphere model shared by all four sky programs. Concatenated (not
 * registered as an `#include` chunk) so `render/shaders/common.glsl.js` stays
 * untouched. Requires `#include <math>` to have run first (`PI`, `TAU`,
 * `saturate`, `remapClamped`).
 * @type {string}
 */
export const ATMOSPHERE_GLSL = `
#ifndef VOX_ATMO_INCLUDED
#define VOX_ATMO_INCLUDED

const float ATMO_GROUND_R = 6360.0;
const float ATMO_TOP_R    = 6460.0;
const vec3  ATMO_RAY_SCAT = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const float ATMO_MIE_SCAT = 3.996e-3;
const float ATMO_MIE_ABS  = 4.400e-3;
const vec3  ATMO_OZO_ABS  = vec3(0.650e-3, 1.881e-3, 0.085e-3);
const float ATMO_RAY_H    = 8.0;
const float ATMO_MIE_H    = 1.2;
const float ATMO_OZO_C    = 25.0;
const float ATMO_OZO_W    = 15.0;

/** x = mie/haze multiplier, y = ground albedo, z = sun illuminance, w = mie g. */
uniform vec4 u_atmo;

/**
 * Scattering and extinction of the medium at altitude h (km above the ground).
 */
void atmoMedium(float h, out vec3 rayScat, out float mieScat, out vec3 extinction) {
  float alt = max(h, 0.0);
  float rayD = exp(-alt / ATMO_RAY_H);
  float mieD = exp(-alt / ATMO_MIE_H);
  float ozoD = max(0.0, 1.0 - abs(alt - ATMO_OZO_C) / ATMO_OZO_W);
  float haze = max(u_atmo.x, 0.0);
  rayScat = ATMO_RAY_SCAT * rayD;
  mieScat = ATMO_MIE_SCAT * mieD * haze;
  float mieAbs = ATMO_MIE_ABS * mieD * haze;
  extinction = rayScat + vec3(mieScat + mieAbs) + ATMO_OZO_ABS * ozoD;
}

/** Nearest positive hit of a ray against a sphere centred on the origin, -1 = miss. */
float atmoRaySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  if (c > 0.0 && b > 0.0) return -1.0;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  float t0 = -b - s;
  float t1 = -b + s;
  if (t1 < 0.0) return -1.0;
  return t0 < 0.0 ? t1 : t0;
}

/** Rayleigh phase function. */
float atmoRayleighPhase(float c) {
  return (3.0 / (16.0 * PI)) * (1.0 + c * c);
}

/** Cornette-Shanks Mie phase function. */
float atmoMiePhase(float c, float g) {
  float g2 = g * g;
  float num = (1.0 - g2) * (1.0 + c * c);
  float den = (2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1.0e-4), 1.5);
  return (3.0 / (8.0 * PI)) * num / den;
}

/** Henyey-Greenstein phase function (used by the clouds). */
float atmoHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1.0e-4), 1.5));
}

/* ---- transmittance LUT parameterisation (Bruneton / Hillaire) ------------ */

/** (radius, cos zenith) -> transmittance LUT uv in [0,1]^2. */
vec2 atmoTransmittanceUv(float r, float mu) {
  float H = sqrt(max(ATMO_TOP_R * ATMO_TOP_R - ATMO_GROUND_R * ATMO_GROUND_R, 0.0));
  float rho = sqrt(max(r * r - ATMO_GROUND_R * ATMO_GROUND_R, 0.0));
  float disc = r * r * (mu * mu - 1.0) + ATMO_TOP_R * ATMO_TOP_R;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = ATMO_TOP_R - r;
  float dMax = rho + H;
  float xMu = (d - dMin) / max(dMax - dMin, 1.0e-5);
  float xR = rho / max(H, 1.0e-5);
  return clamp(vec2(xMu, xR), vec2(0.0), vec2(1.0));
}

/** Inverse of {@link atmoTransmittanceUv}. */
void atmoUvToTransmittance(vec2 uv, out float r, out float mu) {
  float H = sqrt(max(ATMO_TOP_R * ATMO_TOP_R - ATMO_GROUND_R * ATMO_GROUND_R, 0.0));
  float rho = H * clamp(uv.y, 0.0, 1.0);
  r = sqrt(rho * rho + ATMO_GROUND_R * ATMO_GROUND_R);
  float dMin = ATMO_TOP_R - r;
  float dMax = rho + H;
  float d = dMin + clamp(uv.x, 0.0, 1.0) * (dMax - dMin);
  mu = d <= 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
}

/** Sample the transmittance LUT with the half-texel guard band applied. */
vec3 atmoTransmittance(sampler2D lut, float r, float mu) {
  vec2 uv = atmoTransmittanceUv(r, mu);
  vec2 s = vec2(textureSize(lut, 0));
  uv = (uv + 0.5 / s) * (s / (s + 1.0));
  return texture(lut, uv).rgb;
}

/* ---- multiple scattering LUT parameterisation ---------------------------- */

/** (radius, cos sun zenith) -> multi-scatter LUT uv. */
vec2 atmoMsUv(float r, float muSun) {
  float x = clamp(muSun * 0.5 + 0.5, 0.0, 1.0);
  float y = clamp((r - ATMO_GROUND_R) / max(ATMO_TOP_R - ATMO_GROUND_R, 1.0e-4), 0.0, 1.0);
  return vec2(x, y);
}

/** Sample the multiple-scattering LUT with the half-texel guard band applied. */
vec3 atmoMultiScatter(sampler2D lut, float r, float muSun) {
  vec2 uv = atmoMsUv(r, muSun);
  vec2 s = vec2(textureSize(lut, 0));
  uv = (uv + 0.5 / s) * (s / (s + 1.0));
  return texture(lut, uv).rgb;
}

/* ---- sky-view LUT parameterisation --------------------------------------- */

/** Build the sun-aligned horizontal basis used by the sky-view parameterisation. */
void atmoSkyBasis(vec3 sunDir, out vec3 fwd, out vec3 side) {
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 sunH = sunDir - up * sunDir.y;
  fwd = dot(sunH, sunH) > 1.0e-8 ? normalize(sunH) : vec3(1.0, 0.0, 0.0);
  side = cross(up, fwd);
}

/**
 * World direction -> sky-view LUT uv. x wraps (REPEAT), y is split at the
 * horizon with a square-root remap on both halves so texels bunch up there.
 */
vec2 atmoSkyViewUv(vec3 dir, vec3 sunDir, float r) {
  vec3 fwd, side;
  atmoSkyBasis(sunDir, fwd, side);
  vec2 dirH = vec2(dot(dir, side), dot(dir, fwd));
  float phi = dot(dirH, dirH) > 1.0e-12 ? atan(dirH.x, dirH.y) : 0.0;
  float u = phi * (1.0 / TAU) + 0.5;

  float horizonCos = clamp(sqrt(max(r * r - ATMO_GROUND_R * ATMO_GROUND_R, 0.0)) / max(r, 1.0), -1.0, 1.0);
  float beta = acos(horizonCos);
  float zenithHorizon = PI - beta;
  float vza = acos(clamp(dir.y, -1.0, 1.0));

  float v;
  if (vza < zenithHorizon) {
    float c = vza / max(zenithHorizon, 1.0e-4);
    v = (1.0 - sqrt(max(1.0 - c, 0.0))) * 0.5;
  } else {
    float c = (vza - zenithHorizon) / max(beta, 1.0e-4);
    v = sqrt(clamp(c, 0.0, 1.0)) * 0.5 + 0.5;
  }
  return vec2(u, clamp(v, 0.0, 1.0));
}

/** Inverse of {@link atmoSkyViewUv}: sky-view LUT uv -> world direction. */
vec3 atmoSkyViewDir(vec2 uv, vec3 sunDir, float r) {
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 fwd, side;
  atmoSkyBasis(sunDir, fwd, side);
  float phi = (uv.x - 0.5) * TAU;

  float horizonCos = clamp(sqrt(max(r * r - ATMO_GROUND_R * ATMO_GROUND_R, 0.0)) / max(r, 1.0), -1.0, 1.0);
  float beta = acos(horizonCos);
  float zenithHorizon = PI - beta;

  float vza;
  if (uv.y < 0.5) {
    float c = 1.0 - 2.0 * uv.y;
    vza = (1.0 - c * c) * zenithHorizon;
  } else {
    float c = 2.0 * uv.y - 1.0;
    vza = zenithHorizon + c * c * beta;
  }
  float sinV = sin(vza);
  return normalize((fwd * cos(phi) + side * sin(phi)) * sinV + up * cos(vza));
}

/** Sample the sky-view LUT for a world direction. */
vec3 atmoSampleSkyView(sampler2D lut, vec3 dir, vec3 sunDir, float r) {
  return texture(lut, atmoSkyViewUv(dir, sunDir, r)).rgb;
}

#endif
`;

/**
 * Stand-alone snippet other passes (lighting, water, reflections) can paste in
 * to read the sky-view LUT on unit 10. It is a strict subset of
 * {@link ATMOSPHERE_GLSL}; paste **either** this or the full block, never both.
 * @type {string}
 */
export const SKY_LUT_GLSL = ATMOSPHERE_GLSL;

/* ========================================================================== */
/* GLSL — transmittance LUT                                                   */
/* ========================================================================== */

/**
 * Transmittance LUT fragment shader. One `exp(-opticalDepth)` per texel.
 * `TRANSMITTANCE_STEPS` is injected as a define.
 * @type {string}
 */
export const TRANSMITTANCE_FS = `
#include <math>
${ATMOSPHERE_GLSL}

#ifndef TRANSMITTANCE_STEPS
#define TRANSMITTANCE_STEPS 40
#endif

in vec2 v_uv;
layout(location = 0) out vec4 o_frag;

/** Size of the LUT in texels, for the half-texel guard band. */
uniform vec2 u_lutSize;

void main() {
  vec2 uv = (v_uv - 0.5 / u_lutSize) * (u_lutSize / max(u_lutSize - 1.0, vec2(1.0)));
  uv = clamp(uv, vec2(0.0), vec2(1.0));

  float r, mu;
  atmoUvToTransmittance(uv, r, mu);

  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(max(1.0 - mu * mu, 0.0)), mu, 0.0);

  float tTop = atmoRaySphere(ro, rd, ATMO_TOP_R);
  float tGround = atmoRaySphere(ro, rd, ATMO_GROUND_R);
  float tMax = tTop < 0.0 ? 0.0 : tTop;
  if (tGround > 0.0) tMax = min(tMax, tGround);

  vec3 depth = vec3(0.0);
  if (tMax > 0.0) {
    float dt = tMax / float(TRANSMITTANCE_STEPS);
    for (int i = 0; i < TRANSMITTANCE_STEPS; ++i) {
      vec3 p = ro + rd * (dt * (float(i) + 0.5));
      float h = length(p) - ATMO_GROUND_R;
      vec3 rs;
      float ms;
      vec3 ex;
      atmoMedium(h, rs, ms, ex);
      depth += ex * dt;
    }
  }
  o_frag = vec4(exp(-depth), 1.0);
}
`;

/* ========================================================================== */
/* GLSL — multiple scattering LUT                                             */
/* ========================================================================== */

/**
 * Multiple-scattering LUT fragment shader (Hillaire 2020, section 5.1).
 *
 * For every (sun cos-zenith, altitude) pair it fires `MS_SQRT_SAMPLES^2`
 * uniformly distributed rays, accumulates the second-order in-scattered
 * luminance `L_2nd` and the "energy that keeps bouncing" factor `f_ms`, then
 * closes the infinite series analytically as `psi = L_2nd / (1 - f_ms)`.
 * The pass uses the **uniform phase function**, exactly as the reference does.
 * @type {string}
 */
export const MULTISCATTER_FS = `
#include <math>
${ATMOSPHERE_GLSL}

#ifndef MS_SQRT_SAMPLES
#define MS_SQRT_SAMPLES 4
#endif
#ifndef MS_STEPS
#define MS_STEPS 20
#endif

in vec2 v_uv;
layout(location = 0) out vec4 o_frag;

uniform sampler2D u_transmittanceLUT;
uniform vec2 u_lutSize;

const float MS_UNIFORM_PHASE = 1.0 / (4.0 * PI);

/**
 * March one direction, returning the second-order luminance and the
 * multiple-scattering transfer factor.
 */
void msRaymarch(vec3 ro, vec3 rd, vec3 sunDir, out vec3 lum, out vec3 fms) {
  lum = vec3(0.0);
  fms = vec3(0.0);

  float tTop = atmoRaySphere(ro, rd, ATMO_TOP_R);
  float tGround = atmoRaySphere(ro, rd, ATMO_GROUND_R);
  float tMax = tTop < 0.0 ? 0.0 : tTop;
  bool hitGround = tGround > 0.0;
  if (hitGround) tMax = min(tMax, tGround);
  if (tMax <= 0.0) return;

  float dt = tMax / float(MS_STEPS);
  vec3 throughput = vec3(1.0);

  for (int i = 0; i < MS_STEPS; ++i) {
    vec3 p = ro + rd * (dt * (float(i) + 0.5));
    float rr = max(length(p), ATMO_GROUND_R);
    float h = rr - ATMO_GROUND_R;

    vec3 rs;
    float ms;
    vec3 ex;
    atmoMedium(h, rs, ms, ex);
    vec3 safeEx = max(ex, vec3(1.0e-9));
    vec3 sampleT = exp(-ex * dt);

    vec3 upv = p / rr;
    float muS = clamp(dot(upv, sunDir), -1.0, 1.0);
    vec3 sunT = atmoTransmittance(u_transmittanceLUT, rr, muS);
    float shadow = atmoRaySphere(p, sunDir, ATMO_GROUND_R) >= 0.0 ? 0.0 : 1.0;

    vec3 scat = rs + vec3(ms);

    // f_ms: treat every scattering event as an isotropic unit source.
    fms += throughput * ((scat - scat * sampleT) / safeEx);

    // L_2nd: single scattering with illuminance 1 and the uniform phase.
    vec3 S = sunT * shadow * scat * MS_UNIFORM_PHASE;
    lum += throughput * ((S - S * sampleT) / safeEx);

    throughput *= sampleT;
  }

  if (hitGround) {
    vec3 p = ro + rd * tGround;
    float rr = max(length(p), ATMO_GROUND_R);
    vec3 upv = p / rr;
    float muS = clamp(dot(upv, sunDir), -1.0, 1.0);
    if (muS > 0.0) {
      vec3 sunT = atmoTransmittance(u_transmittanceLUT, rr, muS);
      lum += throughput * sunT * muS * (max(u_atmo.y, 0.0) / PI);
    }
  }
}

void main() {
  vec2 uv = (v_uv - 0.5 / u_lutSize) * (u_lutSize / max(u_lutSize - 1.0, vec2(1.0)));
  uv = clamp(uv, vec2(0.0), vec2(1.0));

  float muSun = clamp(uv.x * 2.0 - 1.0, -1.0, 1.0);
  float r = mix(ATMO_GROUND_R + 0.002, ATMO_TOP_R - 0.002, uv.y);
  vec3 sunDir = vec3(sqrt(max(1.0 - muSun * muSun, 0.0)), muSun, 0.0);
  vec3 ro = vec3(0.0, r, 0.0);

  vec3 lumTotal = vec3(0.0);
  vec3 fmsTotal = vec3(0.0);
  float n = float(MS_SQRT_SAMPLES);
  float invN = 1.0 / (n * n);

  for (int i = 0; i < MS_SQRT_SAMPLES; ++i) {
    for (int j = 0; j < MS_SQRT_SAMPLES; ++j) {
      float u0 = (float(i) + 0.5) / n;
      float u1 = (float(j) + 0.5) / n;
      float cosT = 1.0 - 2.0 * u0;
      float sinT = sqrt(max(1.0 - cosT * cosT, 0.0));
      float phi = TAU * u1;
      vec3 rd = vec3(sinT * cos(phi), cosT, sinT * sin(phi));

      vec3 l, f;
      msRaymarch(ro, rd, sunDir, l, f);
      lumTotal += l * invN;
      fmsTotal += f * invN;
    }
  }

  vec3 psi = lumTotal / max(vec3(1.0) - fmsTotal, vec3(1.0e-4));
  o_frag = vec4(max(psi, vec3(0.0)), 1.0);
}
`;

/* ========================================================================== */
/* GLSL — sky-view LUT                                                        */
/* ========================================================================== */

/**
 * Sky-view LUT fragment shader: single scattering with real phase functions
 * plus the multiple-scattering term from {@link MULTISCATTER_FS}.
 * `SKY_STEPS` is injected as a define.
 * @type {string}
 */
export const SKYVIEW_FS = `
#include <math>
${ATMOSPHERE_GLSL}

#ifndef SKY_STEPS
#define SKY_STEPS 32
#endif

in vec2 v_uv;
layout(location = 0) out vec4 o_frag;

uniform sampler2D u_transmittanceLUT;
uniform sampler2D u_msLUT;
uniform vec3 u_sunDirection;
/** Distance of the eye from the planet centre, km. */
uniform float u_viewHeight;

void main() {
  float r = max(u_viewHeight, ATMO_GROUND_R + 1.0e-4);
  vec3 sunDir = normalize(u_sunDirection);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = atmoSkyViewDir(v_uv, sunDir, r);

  float tTop = atmoRaySphere(ro, rd, ATMO_TOP_R);
  float tGround = atmoRaySphere(ro, rd, ATMO_GROUND_R);
  float tMax = tTop < 0.0 ? 0.0 : tTop;
  bool hitGround = tGround > 0.0;
  if (hitGround) tMax = min(tMax, tGround);

  vec3 lum = vec3(0.0);
  vec3 throughput = vec3(1.0);

  if (tMax > 0.0) {
    float cosT = clamp(dot(rd, sunDir), -1.0, 1.0);
    float rayPhase = atmoRayleighPhase(cosT);
    float miePhase = atmoMiePhase(cosT, clamp(u_atmo.w, 0.0, 0.95));
    float illum = max(u_atmo.z, 0.0);
    float invN = 1.0 / float(SKY_STEPS);
    float prevT = 0.0;

    for (int i = 0; i < SKY_STEPS; ++i) {
      // Quadratic step distribution: fine near the eye where the medium is
      // dense, coarse high up where it is not.
      float f1 = float(i + 1) * invN;
      float nextT = tMax * f1 * f1;
      float dt = nextT - prevT;
      vec3 p = ro + rd * (prevT + dt * 0.5);
      prevT = nextT;
      if (dt <= 0.0) continue;

      float rr = max(length(p), ATMO_GROUND_R);
      float h = rr - ATMO_GROUND_R;
      vec3 rs;
      float ms;
      vec3 ex;
      atmoMedium(h, rs, ms, ex);
      vec3 safeEx = max(ex, vec3(1.0e-9));
      vec3 sampleT = exp(-ex * dt);

      vec3 upv = p / rr;
      float muS = clamp(dot(upv, sunDir), -1.0, 1.0);
      vec3 sunT = atmoTransmittance(u_transmittanceLUT, rr, muS);
      float shadow = atmoRaySphere(p, sunDir, ATMO_GROUND_R) >= 0.0 ? 0.0 : 1.0;
      vec3 psi = atmoMultiScatter(u_msLUT, rr, muS);

      vec3 single = sunT * shadow * (rs * rayPhase + vec3(ms) * miePhase);
      vec3 multi = (rs + vec3(ms)) * psi;
      vec3 S = (single + multi) * illum;

      lum += throughput * ((S - S * sampleT) / safeEx);
      throughput *= sampleT;
    }

    if (hitGround) {
      vec3 p = ro + rd * tGround;
      float rr = max(length(p), ATMO_GROUND_R);
      vec3 upv = p / rr;
      float muS = clamp(dot(upv, sunDir), -1.0, 1.0);
      if (muS > 0.0) {
        vec3 sunT = atmoTransmittance(u_transmittanceLUT, rr, muS);
        lum += throughput * sunT * muS * (max(u_atmo.y, 0.0) / PI) * illum;
      }
    }
  }

  o_frag = vec4(max(lum, vec3(0.0)), 1.0);
}
`;

/* ========================================================================== */
/* GLSL — background pass                                                     */
/* ========================================================================== */

/**
 * Vertex shader for the sky background: the same attribute-less oversized
 * triangle as {@link FULLSCREEN_VS}, but pushed onto the **far plane**
 * (`gl_Position.z == gl_Position.w`) so the depth test can reject every pixel
 * that geometry already claimed.
 * @type {string}
 */
export const SKY_VS = `out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}
`;

/**
 * Helper GLSL shared by the composite pass: local noise, the star field, the
 * moon, the sun and the aurora.
 * @type {string}
 */
const SKY_ELEMENTS_GLSL = `
#ifndef STAR_GRID
#define STAR_GRID 24
#endif
#ifndef AURORA_LAYERS
#define AURORA_LAYERS 10
#endif

/* ---- cheap local noise (hash21 comes from <math>) ------------------------ */

float voxVal2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float voxFbm2(vec2 p, int octaves) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  vec2 q = p;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 6; ++i) {
    if (i >= octaves) break;
    sum += amp * voxVal2(q);
    norm += amp;
    q = rot * q * 2.07 + vec2(11.3, 7.9);
    amp *= 0.5;
  }
  return sum / max(norm, 1.0e-5);
}

/* ---- stars --------------------------------------------------------------- */

/**
 * ~2000 procedural stars on the celestial sphere.
 *
 * The direction is projected onto the dominant cube face; that face carries a
 * STAR_GRID x STAR_GRID jitter grid, and every cell may hold one star. Because
 * the face mapping is linear in the face coordinates the three basis vectors
 * are computed once and the 3x3 cell scan only needs a normalize per candidate.
 * The jitter is inset well away from the cell border, so a star is never close
 * enough to a face seam for a pixel on the neighbouring face to need it: no
 * duplicates, no gaps.
 *
 * @param dir        view direction already rotated into celestial space
 * @param coreSharp  1/(2*sigma^2) of the star core, in inverse squared chord
 * @param twinkle    slowly advancing time used for the scintillation
 */
vec3 voxStarField(vec3 dir, float coreSharp, float twinkle) {
  vec3 a = abs(dir);
  float m = max(a.x, max(a.y, a.z));
  vec2 p;
  vec3 bA, bB, bC;
  float face;
  if (a.x >= m) {
    float s = dir.x >= 0.0 ? 1.0 : -1.0;
    p = vec2(dir.z, dir.y) / max(a.x, 1.0e-6);
    bA = vec3(s, 0.0, 0.0);
    bB = vec3(0.0, 0.0, 1.0);
    bC = vec3(0.0, 1.0, 0.0);
    face = dir.x >= 0.0 ? 0.0 : 1.0;
  } else if (a.y >= m) {
    float s = dir.y >= 0.0 ? 1.0 : -1.0;
    p = vec2(dir.x, dir.z) / max(a.y, 1.0e-6);
    bA = vec3(0.0, s, 0.0);
    bB = vec3(1.0, 0.0, 0.0);
    bC = vec3(0.0, 0.0, 1.0);
    face = dir.y >= 0.0 ? 2.0 : 3.0;
  } else {
    float s = dir.z >= 0.0 ? 1.0 : -1.0;
    p = vec2(dir.x, dir.y) / max(a.z, 1.0e-6);
    bA = vec3(0.0, 0.0, s);
    bB = vec3(1.0, 0.0, 0.0);
    bC = vec3(0.0, 1.0, 0.0);
    face = dir.z >= 0.0 ? 4.0 : 5.0;
  }

  float grid = float(STAR_GRID);
  vec2 g = (p * 0.5 + 0.5) * grid;
  vec2 cell = floor(g);
  vec3 acc = vec3(0.0);

  for (int j = -1; j <= 1; ++j) {
    for (int i = -1; i <= 1; ++i) {
      vec2 c = cell + vec2(float(i), float(j));
      if (c.x < 0.0 || c.y < 0.0 || c.x >= grid || c.y >= grid) continue;

      vec3 seed = vec3(c, face * 37.0 + 5.0);
      float exists = hash31(seed);
      if (exists > 0.60) continue;

      float mag = hash31(seed + vec3(3.71, 1.13, 9.27));
      float temp = hash31(seed + vec3(13.3, 27.1, 4.9));
      vec2 jit = vec2(hash31(seed + vec3(7.13, 2.57, 1.91)),
                      hash31(seed + vec3(19.7, 5.33, 23.1))) * 0.74 + 0.13;

      vec2 sp = ((c + jit) / grid) * 2.0 - 1.0;
      vec3 sd = normalize(bA + bB * sp.x + bC * sp.y);

      vec3 delta = sd - dir;
      float d2 = dot(delta, delta);

      // Magnitude: a steep power keeps a few bright stars and many faint ones.
      float brightness = pow(mag, 4.2) * 1.35 + 0.030;

      // Scintillation: two slow, incommensurate beats per star.
      float ph1 = hash31(seed + vec3(31.7, 11.9, 2.3)) * TAU;
      float ph2 = hash31(seed + vec3(2.9, 41.3, 17.7)) * TAU;
      float tw = 0.70 + 0.30 * sin(twinkle * 1.9 + ph1) * sin(twinkle * 0.67 + ph2);
      // Stars low over the horizon shimmer far more than stars at the zenith.
      tw = mix(tw, 0.42 + 0.58 * sin(twinkle * 3.1 + ph1), saturate(1.0 - abs(sd.y)) * 0.45);

      float core = exp(-d2 * coreSharp);
      float halo = exp(-d2 * coreSharp * 0.055) * 0.16;

      // Colour temperature: cool blue-white giants through warm red dwarfs.
      vec3 warm = vec3(1.00, 0.68, 0.42);
      vec3 mid = vec3(1.00, 0.95, 0.90);
      vec3 cool = vec3(0.68, 0.79, 1.00);
      vec3 tint = temp < 0.5 ? mix(warm, mid, temp * 2.0) : mix(mid, cool, (temp - 0.5) * 2.0);

      acc += tint * (brightness * tw * (core + halo));
    }
  }
  return acc;
}

/* ---- moon ---------------------------------------------------------------- */

/**
 * The moon: a real disk with a phase-correct terminator, a procedurally
 * cratered albedo taken from the shared 3D noise volume and a soft halo.
 *
 * @param rd        view direction
 * @param moonDir   direction from the eye toward the moon
 * @param radius    angular radius of the disk, radians
 * @param phaseAng  0 = full moon, PI = new moon
 * @param bright    overall brightness (already folded with the phase)
 * @param haloAmt   halo strength (grows when it rains: ice halo)
 */
vec3 voxMoon(vec3 rd, vec3 moonDir, sampler3D craterTex,
             float radius, float phaseAng, float bright, float haloAmt) {
  if (bright <= 0.0) return vec3(0.0);

  float cosT = clamp(dot(rd, moonDir), -1.0, 1.0);
  float ang = acos(cosT);

  vec3 upRef = abs(moonDir.y) > 0.985 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 tanT = normalize(cross(upRef, moonDir));
  vec3 tanB = cross(moonDir, tanT);

  vec3 col = vec3(0.0);

  if (ang < radius * 1.02) {
    float aX = dot(rd, tanT) / radius;
    float aY = dot(rd, tanB) / radius;
    float rr = min(sqrt(aX * aX + aY * aY), 1.0);
    float cz = sqrt(max(1.0 - rr * rr, 0.0));
    vec3 n = normalize(tanT * aX + tanB * aY - moonDir * max(cz, 1.0e-4));

    // Sun direction as seen from the moon, reconstructed from the phase angle.
    vec3 L = normalize(-moonDir * cos(phaseAng) + tanT * sin(phaseAng));
    float ndl = dot(n, L);
    float lit = smoothstep(-0.075, 0.14, ndl);

    // Lommel-Seeliger reflectance: the reason a full moon looks like a flat
    // disk instead of a shaded ball.
    float ndv = max(cz, 1.0e-3);
    float nl = max(ndl, 0.0);
    float refl = nl / max(nl + ndv, 1.0e-3) * 1.75;

    // Procedural regolith: broad maria plus small craters.
    vec4 big = texture(craterTex, n * 0.29 + vec3(0.31, 0.77, 0.13));
    vec4 fine = texture(craterTex, n * 0.86 + 0.5);
    float maria = smoothstep(0.40, 0.70, big.r);
    float craters = fine.b * 0.62 + fine.a * 0.38;
    vec3 albedo = mix(vec3(0.66, 0.645, 0.615), vec3(0.34, 0.345, 0.375), maria);
    albedo *= 0.70 + 0.55 * craters;
    albedo *= 0.88 + 0.24 * big.g;

    float edge = 1.0 - smoothstep(0.985, 1.0, sqrt(aX * aX + aY * aY));
    // A touch of earthshine keeps the dark limb readable instead of a hole.
    float earthshine = 0.030 * (1.0 - lit);
    col += albedo * (refl * lit + earthshine) * bright * edge * 3.2;
  }

  float halo = exp(-ang / max(radius * 7.0, 1.0e-5)) * 0.32
             + exp(-ang / max(radius * 24.0, 1.0e-5)) * 0.10;
  col += vec3(0.56, 0.66, 0.96) * (halo * bright * haloAmt);
  return col;
}

/* ---- sun ----------------------------------------------------------------- */

/**
 * The sun disk with quadratic limb darkening plus a tight bloom-friendly glow.
 * The 'base' argument already carries the atmospheric transmittance along the sun ray.
 */
vec3 voxSun(vec3 rd, vec3 sunDir, vec3 base, float radius, float glowAmt) {
  float cosT = clamp(dot(rd, sunDir), -1.0, 1.0);
  float ang = acos(cosT);

  float x = saturate(ang / max(radius, 1.0e-5));
  float mu = sqrt(max(1.0 - x * x, 1.0e-4));
  // Hestroffer-Magnan style: the limb is dimmer and markedly redder.
  const vec3 uCoef = vec3(0.397, 0.503, 0.652);
  const vec3 aCoef = vec3(0.13, 0.17, 0.20);
  vec3 limb = vec3(1.0) - uCoef * (vec3(1.0) - pow(vec3(mu), aCoef));

  float disk = 1.0 - smoothstep(radius * 0.982, radius * 1.03, ang);
  vec3 col = base * limb * disk;

  float glow = exp(-ang / max(radius * 7.0, 1.0e-5)) * 0.055
             + exp(-ang / max(radius * 46.0, 1.0e-5)) * 0.012;
  col += base * (glow * glowAmt);
  return col;
}

/* ---- aurora -------------------------------------------------------------- */

/**
 * Animated aurora curtains: layered, domain-warped ridged noise sampled on a
 * stack of horizontal sheets between ~8 km and ~26 km, tinted green at the
 * bottom and magenta at the top. Purely additive.
 */
vec3 voxAurora(vec3 rd, float strength, float t) {
  if (strength <= 0.0 || rd.y < 0.015) return vec3(0.0);
  vec3 acc = vec3(0.0);
  float layers = float(AURORA_LAYERS);

  for (int i = 0; i < AURORA_LAYERS; ++i) {
    float f = (float(i) + 0.5) / layers;
    float h = mix(8000.0, 26000.0, f);
    float dist = h / max(rd.y, 0.015);
    if (dist > 420000.0) break;

    vec2 q = rd.xz * dist * 0.000055;
    q += vec2(t * 0.0075, t * 0.0041);

    vec2 warp = vec2(voxVal2(q * 1.7 + vec2(t * 0.030, 0.0)),
                     voxVal2(q * 1.9 + vec2(0.0, -t * 0.021))) - 0.5;
    q += warp * 0.95;

    float band = voxVal2(q * vec2(2.6, 0.65));
    float ridge = 1.0 - abs(band * 2.0 - 1.0);
    ridge = pow(saturate(ridge), 4.5);

    float fine = voxVal2(q * vec2(9.0, 2.1) + vec2(0.0, t * 0.06));
    ridge *= 0.55 + 0.75 * fine;

    float vertical = smoothstep(0.0, 0.22, f) * smoothstep(1.0, 0.52, f);
    vec3 tint = mix(vec3(0.10, 1.00, 0.44), vec3(0.74, 0.20, 0.96), f * f);
    acc += tint * (ridge * vertical);
  }

  return acc * (strength * 2.6 / layers) * saturate(rd.y * 5.5);
}
`;

/**
 * Cloud GLSL: two decks (raymarched cumulus + a thin cirrus sheet) plus the
 * cheap 2D layered-noise plane used when `settings.volumetricClouds` is off.
 * @type {string}
 */
const SKY_CLOUDS_GLSL = `
#ifndef CLOUD_STEPS
#define CLOUD_STEPS 64
#endif
#ifndef CLOUD_LIGHT_STEPS
#define CLOUD_LIGHT_STEPS 5
#endif

const float CLOUD_CURVE = ${CLOUD_CURVE_RADIUS.toFixed(1)};

/** Cone-shaped offsets for the light march, so the shadow rays fan out. */
const vec3 VOX_CLOUD_CONE[6] = vec3[6](
  vec3( 0.31, 0.14, -0.22), vec3(-0.27, 0.35,  0.19),
  vec3( 0.12, -0.30, 0.41), vec3(-0.44, -0.11, -0.26),
  vec3( 0.38, 0.28,  0.33), vec3(-0.09, 0.47, -0.40)
);

/**
 * Distance along a ray at which it reaches height 'h' above the eye on a shell
 * of radius CLOUD_CURVE. Solving the same quadratic that
 * {@link voxCloudRelHeight} inverts keeps the two exactly consistent.
 */
float voxCloudShellT(float h, float dy) {
  return CLOUD_CURVE * (-dy + sqrt(max(dy * dy + 2.0 * h / CLOUD_CURVE, 0.0)));
}

/** Height above the eye of a point at distance 't' along a ray, with shell curvature. */
float voxCloudRelHeight(float t, float dy) {
  return t * dy + (t * t) / (2.0 * CLOUD_CURVE);
}

/** Vertical density profile of a cumulus: broad base, eroded cauliflower top. */
float voxCloudGradient(float hf) {
  float base = smoothstep(0.00, 0.17, hf);
  float top = smoothstep(1.00, 0.58, hf);
  return base * top;
}

/**
 * Density of the cumulus deck at a world position.
 * @param p      world position
 * @param hf     normalised height inside the deck, 0..1
 * @param detail 1 to run the high-frequency erosion pass
 */
float voxCloudDensity(vec3 p, float hf, int detail) {
  vec3 wind = vec3(u_cloudB.z, 0.0, u_cloudB.w);
  vec3 q = (p + wind) * u_cloudA.z;
  vec4 base = texture(u_cloudNoise, q);

  float fbm = base.g * 0.625 + base.b * 0.25 + base.a * 0.125;
  float shape = remapClamped(base.r, fbm * 0.58 - 0.06, 1.0, 0.0, 1.0);

  float cov = clamp(u_cloudA.x, 0.0, 0.995);
  float d = remapClamped(shape, 1.0 - cov, 1.0, 0.0, 1.0);
  d *= voxCloudGradient(hf);
  if (d <= 0.0) return 0.0;

  if (detail > 0) {
    vec3 dq = (p + wind * 1.7) * u_cloudA.w;
    vec4 det = texture(u_cloudNoise, dq);
    float hi = det.g * 0.625 + det.b * 0.25 + det.a * 0.125;
    // Wispy at the base, billowy at the top.
    hi = mix(1.0 - hi, hi, saturate(hf * 2.4));
    d = remapClamped(d, hi * 0.44 * (1.0 - hf * 0.55), 1.0, 0.0, 1.0);
  }
  return max(d, 0.0) * max(u_cloudA.y, 0.0);
}

/** Optical depth from a point toward the sun, 4..6 cone-jittered samples. */
float voxCloudLightMarch(vec3 p, vec3 L) {
  float thickness = max(u_cloudB.y - u_cloudB.x, 1.0);
  float stepLen = thickness * 0.13;
  float depth = 0.0;
  float t = 0.0;
  for (int i = 0; i < CLOUD_LIGHT_STEPS; ++i) {
    t += stepLen;
    vec3 sp = p + L * t + VOX_CLOUD_CONE[i < 6 ? i : 5] * (t * 0.32);
    float hf = (sp.y - u_cloudB.x) / thickness;
    if (hf <= 0.0 || hf >= 1.0) break;
    depth += voxCloudDensity(sp, hf, i < 2 ? CLOUD_DETAIL : 0) * stepLen;
    stepLen *= 1.55;
  }
  // One long sample far along the ray catches distant self-shadowing cheaply.
  vec3 far = p + L * (thickness * 2.4);
  float hfFar = (far.y - u_cloudB.x) / thickness;
  if (hfFar > 0.0 && hfFar < 1.0) {
    depth += voxCloudDensity(far, hfFar, 0) * thickness * 0.75;
  }
  return depth;
}

/** Dual-lobe HG phase, normalised so an isotropic medium evaluates to ~1. */
float voxCloudPhase(float c) {
  return mix(atmoHG(c, 0.74), atmoHG(c, -0.28), 0.42) * (4.0 * PI);
}

/**
 * Raymarch the cumulus deck. Returns premultiplied-free colour in rgb and
 * coverage in a.
 */
vec4 voxCumulus(vec3 rd, vec3 sunDir, float jitter) {
  float camY = u_camPos.y;
  float hb = u_cloudB.x - camY;
  float ht = u_cloudB.y - camY;
  float t0, t1;

  if (hb > 0.0) {
    // The normal case: the eye is below the deck.
    if (rd.y <= 0.002) return vec4(0.0);
    t0 = voxCloudShellT(hb, rd.y);
    t1 = voxCloudShellT(ht, rd.y);
  } else if (ht > 0.0) {
    // Inside the deck (creative flight).
    t0 = 0.0;
    if (rd.y > 0.002) t1 = voxCloudShellT(ht, rd.y);
    else if (rd.y < -0.002) t1 = hb / rd.y;
    else t1 = u_cloudC.w;
  } else {
    // Above the deck, looking down.
    if (rd.y >= -0.002) return vec4(0.0);
    t0 = ht / rd.y;
    t1 = hb / rd.y;
  }

  t1 = min(t1, u_cloudC.w);
  if (!(t1 > t0)) return vec4(0.0);

  float steps = float(CLOUD_STEPS);
  // Geometric step growth: dense sampling nearby, coarse far away.
  float growth = 1.022;
  float total = (pow(growth, steps) - 1.0) / (growth - 1.0);
  float stepLen = (t1 - t0) / max(total, 1.0e-3);

  float cosT = clamp(dot(rd, sunDir), -1.0, 1.0);
  float phase = voxCloudPhase(cosT);
  float sigma = max(u_cloudC.x, 1.0e-4);
  float powderAmt = saturate(u_cloudC.y);

  float t = t0 + stepLen * jitter;
  float transmittance = 1.0;
  vec3 scattered = vec3(0.0);
  float depthSum = 0.0;
  float depthWeight = 0.0;

  for (int i = 0; i < CLOUD_STEPS; ++i) {
    if (transmittance < 0.012 || t > t1) break;

    float hRel = voxCloudRelHeight(t, rd.y);
    float hf = (hRel - hb) / max(ht - hb, 1.0);
    if (hf > -0.02 && hf < 1.02) {
      vec3 p = vec3(u_camPos.x + rd.x * t, camY + hRel, u_camPos.z + rd.z * t);
      float d = voxCloudDensity(p, saturate(hf), CLOUD_DETAIL);
      if (d > 0.002) {
        float lightDepth = voxCloudLightMarch(p, sunDir);
        float beer = exp(-lightDepth * sigma);
        float powder = 1.0 - exp(-d * stepLen * sigma * 2.0);
        float energy = beer * mix(1.0, powder * 2.0, powderAmt);

        vec3 ambient = mix(u_cloudAmbBot, u_cloudAmbTop, saturate(hf));
        vec3 lum = u_cloudSun * (energy * phase) + ambient * (0.42 + 0.58 * saturate(hf));

        float sampleT = exp(-d * stepLen * sigma);
        scattered += transmittance * lum * (1.0 - sampleT);
        transmittance *= sampleT;

        depthSum += t * (1.0 - sampleT);
        depthWeight += (1.0 - sampleT);
      }
    }
    t += stepLen;
    stepLen *= growth;
  }

  float alpha = saturate(1.0 - transmittance);
  if (alpha <= 0.001) return vec4(0.0);

  float meanT = depthWeight > 0.0 ? depthSum / depthWeight : t0;
  // Aerial perspective: distant clouds sink into the sky colour.
  float aerial = saturate(meanT / max(u_cloudC.w, 1.0));
  vec3 col = mix(scattered / max(alpha, 1.0e-4), u_cloudAmbTop * 1.15, aerial * aerial * 0.65);

  // Fade the very edge of the march so the deck does not end with a hard line.
  float distFade = 1.0 - smoothstep(u_cloudC.w * 0.70, u_cloudC.w * 0.99, meanT);
  float horizonFade = smoothstep(0.0, 0.045, rd.y);
  return vec4(col, alpha * distFade * mix(horizonFade, 1.0, step(hb, 0.0)));
}

/**
 * Cheap replacement for {@link voxCumulus} when volumetric clouds are off: one
 * layered-noise plane with a two-tap fake self-shadow toward the sun.
 */
vec4 voxFlatClouds(vec3 rd, vec3 sunDir) {
  float camY = u_camPos.y;
  float h = (u_cloudB.x + u_cloudB.y) * 0.5 - camY;
  if (h <= 0.0 || rd.y <= 0.004) return vec4(0.0);

  float t = voxCloudShellT(h, rd.y);
  if (t > u_cloudC.w) return vec4(0.0);

  vec2 w = u_camPos.xz + rd.xz * t;
  vec2 q = w * u_flat.x + vec2(u_cloudB.z, u_cloudB.w) * u_flat.x;

  float f = voxFbm2(q, 5);
  float cov = clamp(u_cloudA.x, 0.0, 0.98);
  float d = smoothstep(1.0 - cov, 1.0 - cov + u_flat.y, f);
  if (d <= 0.001) return vec4(0.0);

  // Sample once more shifted toward the sun to fake the lit/shadowed sides.
  vec2 off = normalize(sunDir.xz + vec2(1.0e-4, 0.0)) * u_flat.z;
  float f2 = voxFbm2(q + off * u_flat.x, 4);
  float d2 = smoothstep(1.0 - cov, 1.0 - cov + u_flat.y, f2);
  float lit = saturate(0.42 + 1.15 * (d - d2));

  vec3 col = u_cloudSun * (lit * 0.85 + 0.10) + mix(u_cloudAmbBot, u_cloudAmbTop, 0.6) * 0.75;
  float alpha = saturate(d * 0.94);
  float distFade = 1.0 - smoothstep(u_cloudC.w * 0.62, u_cloudC.w * 0.98, t);
  return vec4(col, alpha * distFade * smoothstep(0.004, 0.055, rd.y));
}

/** The thin high cirrus sheet: stretched, domain-warped streaks. */
vec4 voxCirrus(vec3 rd, vec3 sunDir) {
  if (u_cirrus.y <= 0.0 || rd.y <= 0.005) return vec4(0.0);
  float h = u_cirrus.z - u_camPos.y;
  if (h <= 0.0) return vec4(0.0);

  float t = voxCloudShellT(h, rd.y);
  if (t > u_cloudC.w * 2.4) return vec4(0.0);

  vec2 w = u_camPos.xz + rd.xz * t;
  vec2 q = w * 0.00030 + vec2(u_cirrus.w, u_cirrus.w * 0.35);
  q = vec2(q.x * 0.34, q.y * 1.30);

  vec2 warp = vec2(voxVal2(q * 1.55), voxVal2(q * 1.55 + 4.7)) - 0.5;
  q += warp * 0.60;

  float f = voxFbm2(q, 5);
  float cov = clamp(u_cirrus.x, 0.0, 0.98);
  float d = smoothstep(1.0 - cov, 1.0 - cov + 0.30, f);
  float streak = smoothstep(0.35, 0.85, voxVal2(q * vec2(0.9, 4.5)));
  d *= 0.45 + 0.75 * streak;

  float alpha = saturate(d * u_cirrus.y) * smoothstep(0.005, 0.09, rd.y);
  if (alpha <= 0.002) return vec4(0.0);

  float cosT = clamp(dot(rd, sunDir), -1.0, 1.0);
  vec3 col = u_cloudSun * (0.50 + 1.05 * pow(saturate(cosT), 10.0)) + u_cloudAmbTop * 0.65;
  return vec4(col, alpha * 0.72);
}
`;

/**
 * The complete sky background fragment shader.
 *
 * Uniform blocks: `Frame` (binding 0, via `<depth>`), plus the sky's own
 * uniforms. Samplers sit on the fixed units 10 / 11 / 13 / 15.
 * @type {string}
 */
export const SKY_BACKGROUND_FS = `
#include <math>
#include <color>
#include <depth>
${ATMOSPHERE_GLSL}

in vec2 v_uv;
layout(location = 0) out vec4 o_frag;

uniform sampler2D u_skyLUT;            // unit 10
uniform sampler2D u_transmittanceLUT;  // unit 15
uniform sampler2D u_blueNoise;         // unit 11
uniform sampler3D u_cloudNoise;        // unit 13

/** Eye distance from the planet centre, km. */
uniform float u_viewHeight;
uniform vec3 u_sunDirection;
uniform vec3 u_moonDirection;
/** Rotates a view direction into celestial (star) space. */
uniform mat3 u_starMatrix;
/** x = core sharpness, y = brightness, z = visibility fade, w = twinkle time. */
uniform vec4 u_starParams;
/** x = angular radius, y = disk gain, z = glow gain, w = rain strength. */
uniform vec4 u_sunParams;
/** x = angular radius, y = phase angle (rad), z = brightness, w = halo gain. */
uniform vec4 u_moonParams;
/** x = strength, y = animation time, z/w = reserved. */
uniform vec4 u_auroraParams;
/** x = coverage, y = density gain, z = base noise scale, w = detail noise scale. */
uniform vec4 u_cloudA;
/** x = deck bottom Y, y = deck top Y, z/w = wind offset in world units. */
uniform vec4 u_cloudB;
/** x = extinction sigma, y = powder amount, z = reserved, w = max distance. */
uniform vec4 u_cloudC;
/** x = coverage, y = strength, z = sheet Y, w = wind offset. */
uniform vec4 u_cirrus;
/** x = noise scale, y = coverage softness, z = shading offset, w = reserved. */
uniform vec4 u_flat;
/** Sun radiance used to light the clouds. */
uniform vec3 u_cloudSun;
/** Ambient sky colour at the top of the cloud deck. */
uniform vec3 u_cloudAmbTop;
/** Ambient sky colour at the bottom of the cloud deck. */
uniform vec3 u_cloudAmbBot;
/** Per-frame integer offset into the blue-noise mask. */
uniform vec2 u_noiseOffset;
/** x = horizon haze amount, y = ground blend, z = sky gain, w = reserved. */
uniform vec4 u_horizon;

#ifndef CLOUD_DETAIL
#define CLOUD_DETAIL 0
#endif

${SKY_ELEMENTS_GLSL}
${SKY_CLOUDS_GLSL}

void main() {
  vec3 rd = normalize(rayFromUV(v_uv));
  vec3 sunDir = normalize(u_sunDirection);
  vec3 moonDir = normalize(u_moonDirection);
  float r = max(u_viewHeight, ATMO_GROUND_R + 1.0e-4);
  float rain = saturate(u_sunParams.w);

  /* ---- 1. atmosphere ---------------------------------------------------- */
  vec3 col = max(atmoSampleSkyView(u_skyLUT, rd, sunDir, r), vec3(0.0)) * u_horizon.z;

  // Transmittance from the eye to space along the view ray; celestial bodies
  // are attenuated by it, which is what reddens a rising moon.
  vec3 viewT = atmoTransmittance(u_transmittanceLUT, r, clamp(rd.y, -0.02, 1.0));
  float above = smoothstep(-0.025, 0.030, rd.y);

  /* ---- 2. stars --------------------------------------------------------- */
  if (u_starParams.z > 0.002) {
    vec3 celestial = u_starMatrix * rd;
    vec3 stars = voxStarField(celestial, u_starParams.x, u_starParams.w);
    col += stars * (u_starParams.y * u_starParams.z * above) * viewT;
  }

  /* ---- 3. moon ---------------------------------------------------------- */
  if (u_moonParams.z > 0.0) {
    col += voxMoon(rd, moonDir, u_cloudNoise, u_moonParams.x, u_moonParams.y,
                   u_moonParams.z, u_moonParams.w) * viewT * above;
  }

  /* ---- 4. sun ----------------------------------------------------------- */
  if (u_sunParams.y > 0.0) {
    vec3 sunT = atmoTransmittance(u_transmittanceLUT, r, clamp(sunDir.y, -0.05, 1.0));
    vec3 base = sunT * (max(u_atmo.z, 0.0) * u_sunParams.y) * (1.0 - 0.88 * rain);
    float horizonGate = smoothstep(-0.045, 0.020, sunDir.y);
    col += voxSun(rd, sunDir, base * horizonGate, u_sunParams.x, u_sunParams.z) * above;
  }

  /* ---- 5. aurora -------------------------------------------------------- */
#if AURORA_ENABLED
  if (u_auroraParams.x > 0.002) {
    col += voxAurora(rd, u_auroraParams.x, u_auroraParams.y) * viewT;
  }
#endif

  /* ---- 6. clouds -------------------------------------------------------- */
  vec2 bnSize = vec2(textureSize(u_blueNoise, 0));
  float jitter = texelFetch(u_blueNoise,
    ivec2(mod(gl_FragCoord.xy + u_noiseOffset, max(bnSize, vec2(1.0)))), 0).r;

#if CIRRUS_ENABLED
  vec4 cirrus = voxCirrus(rd, sunDir);
  col = mix(col, cirrus.rgb, cirrus.a);
#endif

#if CLOUDS_ENABLED
#if VOLUMETRIC_CLOUDS
  vec4 cumulus = voxCumulus(rd, sunDir, jitter);
#else
  vec4 cumulus = voxFlatClouds(rd, sunDir);
#endif
  col = mix(col, cumulus.rgb, cumulus.a);
#endif

  /* ---- 7. horizon + weather -------------------------------------------- */
  // Melt the last few degrees above the horizon into the scene fog so distant
  // terrain and the sky agree; heavy weather pulls the whole dome that way.
  float haze = pow(1.0 - saturate(abs(rd.y)), 7.0) * u_horizon.x;
  col = mix(col, u_fogColor.rgb, saturate(haze));

  float below = saturate(-rd.y * 7.0);
  col = mix(col, u_fogColor.rgb * 0.92, below * u_horizon.y);

  if (rain > 0.0) {
    float lum = luminance(col);
    col = mix(col, vec3(lum) * vec3(0.88, 0.91, 0.98), rain * 0.62);
  }

  o_frag = vec4(max(col, vec3(0.0)), 1.0);
}
`;

/* ========================================================================== */
/* CPU mirror of the atmosphere (used for ambient, fog and sun colour)        */
/* ========================================================================== */

/**
 * Scratch vectors so the CPU model never allocates per update.
 *
 * `_cpuScat` / `_cpuExt` belong to {@link cpuTransmittance}, `_skyScat` /
 * `_skyExt` to {@link cpuSkyRadiance}. They must stay separate: the scattering
 * integral holds the medium of the current step across a nested transmittance
 * raymarch, and sharing one buffer silently corrupts every colour it produces.
 * @private
 */
const _cpuScat = new Float64Array(3);
const _cpuExt = new Float64Array(3);
const _skyScat = new Float64Array(3);
const _skyExt = new Float64Array(3);
const _cpuT = new Float64Array(3);
const _cpuT2 = new Float64Array(3);
const _cpuRad = new Float64Array(3);

/**
 * Scattering / extinction of the medium at altitude `h` (km), CPU twin of
 * `atmoMedium()`. Writes the Rayleigh scattering into `scat`, the extinction
 * into `ext` and returns the Mie scattering coefficient.
 *
 * @param {number} h altitude above the ground in km
 * @param {number} haze Mie multiplier (1 = clear, >1 = rain/fog)
 * @param {Float64Array} scat receives the Rayleigh scattering, km^-1
 * @param {Float64Array} ext receives the total extinction, km^-1
 * @returns {number} Mie scattering coefficient in km^-1
 */
function cpuMedium(h, haze, scat, ext) {
  const alt = h > 0 ? h : 0;
  const rayD = Math.exp(-alt / ATMOSPHERE.rayleighHeight);
  const mieD = Math.exp(-alt / ATMOSPHERE.mieHeight);
  const ozoD = Math.max(0, 1 - Math.abs(alt - ATMOSPHERE.ozoneCenter) / ATMOSPHERE.ozoneWidth);
  const rs = ATMOSPHERE.rayleighScattering;
  const oz = ATMOSPHERE.ozoneAbsorption;
  const mieScat = ATMOSPHERE.mieScattering * mieD * haze;
  const mieAbs = ATMOSPHERE.mieAbsorption * mieD * haze;
  for (let i = 0; i < 3; i++) {
    scat[i] = rs[i] * rayD;
    ext[i] = scat[i] + mieScat + mieAbs + oz[i] * ozoD;
  }
  return mieScat;
}

/**
 * Distance from `(0, r, 0)` along a ray with vertical component `mu` to a
 * sphere of radius `radius` centred on the origin. Returns -1 on a miss.
 * @param {number} r radius of the start point
 * @param {number} mu cosine of the ray's zenith angle
 * @param {number} radius sphere radius
 * @returns {number} nearest positive hit distance, or -1
 */
function cpuRaySphere(r, mu, radius) {
  const b = r * mu;
  const c = r * r - radius * radius;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  const t1 = -b + s;
  if (t1 < 0) return -1;
  return t0 < 0 ? t1 : t0;
}

/** Number of steps in the CPU transmittance integral. @type {number} */
const CPU_TRANSMITTANCE_STEPS = 12;
/** Number of steps in the CPU single-scattering integral. @type {number} */
const CPU_SCATTER_STEPS = 16;

/**
 * CPU twin of the transmittance LUT: `exp(-opticalDepth)` from `(0, r, 0)`
 * along a ray with vertical component `mu`, out to the atmosphere boundary.
 *
 * @param {number} r radius of the start point, km
 * @param {number} mu cosine of the ray's zenith angle
 * @param {number} haze Mie multiplier
 * @param {Float64Array} out receives the rgb transmittance
 * @returns {Float64Array} `out`
 */
function cpuTransmittance(r, mu, haze, out) {
  const ground = ATMOSPHERE.groundRadius;
  const top = ATMOSPHERE.topRadius;
  let tMax = cpuRaySphere(r, mu, top);
  if (tMax < 0) { out[0] = out[1] = out[2] = 1; return out; }
  const tGround = cpuRaySphere(r, mu, ground);
  if (tGround > 0) tMax = Math.min(tMax, tGround);

  const sinMu = Math.sqrt(Math.max(1 - mu * mu, 0));
  let d0 = 0, d1 = 0, d2 = 0;
  const dt = tMax / CPU_TRANSMITTANCE_STEPS;
  for (let i = 0; i < CPU_TRANSMITTANCE_STEPS; i++) {
    const t = dt * (i + 0.5);
    const y = r + t * mu;
    const x = t * sinMu;
    const h = Math.sqrt(x * x + y * y) - ground;
    cpuMedium(h, haze, _cpuScat, _cpuExt);
    d0 += _cpuExt[0] * dt;
    d1 += _cpuExt[1] * dt;
    d2 += _cpuExt[2] * dt;
  }
  out[0] = Math.exp(-d0);
  out[1] = Math.exp(-d1);
  out[2] = Math.exp(-d2);
  return out;
}

/**
 * CPU twin of the sky-view LUT for a single direction: Rayleigh + Mie single
 * scattering plus an isotropic multiple-scattering term tuned to match the
 * GPU multi-scatter LUT to within a few percent, plus the ground bounce.
 *
 * This is what {@link Sky#getAmbient} and the fog colour are built from — it
 * uses the very same constants and phase functions as the shaders, so the
 * ambient can never drift away from what the player actually sees.
 *
 * @param {number} dirX ray direction x (unit)
 * @param {number} dirY ray direction y (unit)
 * @param {number} dirZ ray direction z (unit)
 * @param {ArrayLike<number>} sunDir unit direction toward the sun
 * @param {number} r eye radius from the planet centre, km
 * @param {number} haze Mie multiplier
 * @param {number} illuminance top-of-atmosphere sun irradiance
 * @param {Float64Array} out receives the rgb radiance
 * @returns {Float64Array} `out`
 */
function cpuSkyRadiance(dirX, dirY, dirZ, sunDir, r, haze, illuminance, out) {
  const ground = ATMOSPHERE.groundRadius;
  const top = ATMOSPHERE.topRadius;
  out[0] = out[1] = out[2] = 0;

  let tMax = cpuRaySphere(r, dirY, top);
  if (tMax < 0) return out;
  const tGround = cpuRaySphere(r, dirY, ground);
  const hitGround = tGround > 0;
  if (hitGround) tMax = Math.min(tMax, tGround);
  if (tMax <= 0) return out;

  const cosT = dirX * sunDir[0] + dirY * sunDir[1] + dirZ * sunDir[2];
  const rayPhase = (3 / (16 * Math.PI)) * (1 + cosT * cosT);
  const g = ATMOSPHERE.mieG;
  const g2 = g * g;
  const miePhase = (3 / (8 * Math.PI)) * ((1 - g2) * (1 + cosT * cosT)) /
    ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * g * cosT, 1e-4), 1.5));

  // Isotropic stand-in for the multiple-scattering LUT.
  const msFactor = 0.075 * smoothstep(-0.25, 0.12, sunDir[1]);

  let th0 = 1, th1 = 1, th2 = 1;
  let prevT = 0;
  const invN = 1 / CPU_SCATTER_STEPS;

  for (let i = 0; i < CPU_SCATTER_STEPS; i++) {
    const f1 = (i + 1) * invN;
    const nextT = tMax * f1 * f1;
    const dt = nextT - prevT;
    const t = prevT + dt * 0.5;
    prevT = nextT;
    if (dt <= 0) continue;

    const px = dirX * t;
    const py = r + dirY * t;
    const pz = dirZ * t;
    const rr = Math.max(Math.sqrt(px * px + py * py + pz * pz), ground);
    // Uses the sky-radiance scratch: `cpuTransmittance` below owns _cpuScat/_cpuExt.
    const mieScat = cpuMedium(rr - ground, haze, _skyScat, _skyExt);

    const invRR = 1 / rr;
    const muS = clamp((px * sunDir[0] + py * sunDir[1] + pz * sunDir[2]) * invRR, -1, 1);
    const shadow = cpuRaySphere(rr, muS, ground) >= 0 ? 0 : 1;
    cpuTransmittance(rr, muS, haze, _cpuT);

    for (let c = 0; c < 3; c++) {
      const ext = Math.max(_skyExt[c], 1e-9);
      const scatTotal = _skyScat[c] + mieScat;
      const single = _cpuT[c] * shadow * (_skyScat[c] * rayPhase + mieScat * miePhase);
      const multi = scatTotal * msFactor * _cpuT[c];
      const S = (single + multi) * illuminance;
      const sampleT = Math.exp(-ext * dt);
      const contrib = (S - S * sampleT) / ext;
      if (c === 0) { out[0] += th0 * contrib; th0 *= sampleT; }
      else if (c === 1) { out[1] += th1 * contrib; th1 *= sampleT; }
      else { out[2] += th2 * contrib; th2 *= sampleT; }
    }
  }

  if (hitGround) {
    const px = dirX * tGround;
    const py = r + dirY * tGround;
    const pz = dirZ * tGround;
    const rr = Math.max(Math.sqrt(px * px + py * py + pz * pz), ground);
    const muS = clamp((px * sunDir[0] + py * sunDir[1] + pz * sunDir[2]) / rr, -1, 1);
    if (muS > 0) {
      cpuTransmittance(rr, muS, haze, _cpuT2);
      const k = muS * (ATMOSPHERE.groundAlbedo / Math.PI) * illuminance;
      out[0] += th0 * _cpuT2[0] * k;
      out[1] += th1 * _cpuT2[1] * k;
      out[2] += th2 * _cpuT2[2] * k;
    }
  }

  out[0] = Math.max(out[0], 0);
  out[1] = Math.max(out[1], 0);
  out[2] = Math.max(out[2], 0);
  return out;
}

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/**
 * Read a finite number out of a loose object, falling back when absent.
 * @param {*} value candidate
 * @param {number} fallback default
 * @returns {number} a finite number
 */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Copy three finite components out of an array-like into a target.
 * @param {*} src candidate array-like
 * @param {Float32Array|Float64Array|number[]} dst destination of length >= 3
 * @returns {boolean} true when `src` supplied three finite numbers
 */
function readVec3(src, dst) {
  if (!src || typeof src.length !== 'number' || src.length < 3) return false;
  const x = src[0], y = src[1], z = src[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  dst[0] = x; dst[1] = y; dst[2] = z;
  return true;
}

/**
 * Normalize a 3-vector in place, falling back to a default direction.
 * @param {Float32Array|Float64Array|number[]} v vector to normalize
 * @param {number} fx fallback x
 * @param {number} fy fallback y
 * @param {number} fz fallback z
 * @returns {void}
 */
function normalize3(v, fx, fy, fz) {
  const l2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (!(l2 > 1e-12)) { v[0] = fx; v[1] = fy; v[2] = fz; return; }
  const inv = 1 / Math.sqrt(l2);
  v[0] *= inv; v[1] *= inv; v[2] *= inv;
}

/** Fractional part, matching GLSL `fract` for positive and negative inputs. */
function fract(x) { return x - Math.floor(x); }

/* ========================================================================== */
/* Sky                                                                        */
/* ========================================================================== */

/**
 * Physically based sky: atmosphere LUTs, background compositing and the
 * ambient / fog values the rest of the pipeline consumes.
 *
 * Usage:
 * ```js
 * const sky = new Sky(gl, settings);
 * sky.setTextures(renderer.textures);     // blue noise + 3D cloud volume
 * sky.resize(width, height);
 * sky.update(frame, environment);         // refreshes the LUTs when needed
 * const amb = sky.getAmbient();           // feed u_skyAmbient / u_sunColor
 * sky.renderBackground(frame, environment, sceneFBO);
 * program.setTexture('u_skyLUT', sky.lut, 10);
 * ```
 */
export class Sky {
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
    /** @type {?Object} Settings store. */
    this.settings = settings || null;

    /* ---- public state ---------------------------------------------------- */

    /**
     * The sky-view LUT — bind this to unit {@link SKY_LUT_UNIT}.
     * @type {?WebGLTexture}
     */
    this.lut = null;
    /** @type {?WebGLTexture} Alias of {@link Sky#lut}. */
    this.skyViewLUT = null;
    /** @type {?WebGLTexture} Transmittance LUT (unit 15 during the sky pass). */
    this.transmittanceLUT = null;
    /** @type {?WebGLTexture} Multiple-scattering LUT (internal). */
    this.multiScatterLUT = null;

    /** @type {Float32Array} Linear rgb fog colour computed by {@link Sky#update}. */
    this.fogColor = new Float32Array([0.55, 0.66, 0.82]);
    /** @type {number} Fog density for `u_fogColor.w`. */
    this.fogDensity = 0.008;
    /** @type {Float32Array} Linear rgb sun irradiance for `u_sunColor.rgb`. */
    this.sunColor = new Float32Array([1, 1, 1]);
    /** @type {number} Sun intensity scalar for `u_sunColor.w`. */
    this.sunIntensity = 1;
    /** @type {boolean} True once a LUT build has failed; the pass then no-ops. */
    this.failed = false;

    /* ---- resolution ------------------------------------------------------ */

    /** @type {number} Backbuffer width, used to keep stars ~2 px wide. */
    this.width = Math.max(1, this.gl.drawingBufferWidth || 1);
    /** @type {number} Backbuffer height. */
    this.height = Math.max(1, this.gl.drawingBufferHeight || 1);

    /* ---- quality --------------------------------------------------------- */

    /** @type {string} Resolved cloud quality step. */
    this.cloudQuality = this._resolveCloudQuality();
    /** @type {string} Resolved LUT quality step. */
    this.lutQuality = this._resolveLutQuality();
    /** @type {boolean} Mirrors `settings.volumetricClouds`. */
    this.volumetric = this._setting('volumetricClouds', true) !== false;

    /* ---- GPU resources --------------------------------------------------- */

    this._transFBO = null;
    this._msFBO = null;
    this._viewFBO = null;
    this._transProgram = null;
    this._msProgram = null;
    this._viewProgram = null;
    this._bgProgram = null;

    /** @type {?WebGLTexture} Blue-noise mask supplied by the TextureManager. */
    this.blueNoise = null;
    /** @type {?WebGLTexture} 3D cloud volume supplied by the TextureManager. */
    this.cloudNoise = null;
    /** @type {?WebGLTexture} Internally generated blue-noise fallback. @private */
    this._fallbackNoise = null;
    /** @type {?WebGLTexture} Internally generated cloud-volume fallback. @private */
    this._fallbackCloud = null;

    /* ---- cached frame state ---------------------------------------------- */

    /** @type {Float64Array} Unit direction toward the sun. @private */
    this._sunDir = new Float64Array([0.0, 0.6, 0.8]);
    /** @type {Float64Array} Unit direction toward the moon. @private */
    this._moonDir = new Float64Array([0.0, -0.6, -0.8]);
    /** @type {Float64Array} Sun direction the LUTs were built for. @private */
    this._lutSunDir = new Float64Array([0, -2, 0]);
    /** @type {number} Haze the LUTs were built for. @private */
    this._lutHaze = -1;
    /** @type {number} Eye radius (km) the sky-view LUT was built for. @private */
    this._lutViewHeight = -1;
    /** @type {boolean} @private */
    this._transmittanceValid = false;
    /** @type {number} Eye radius from the planet centre, km. @private */
    this._viewHeight = ATMOSPHERE.groundRadius;

    /** @type {number} Mie multiplier: 1 clear, up to ~4 in a storm. @private */
    this._haze = 1;
    /** @type {number} `environment.rainStrength`, 0..1. @private */
    this._rain = 0;
    /** @type {number} 1 when the precipitation is snow. @private */
    this._snow = 0;
    /** @type {number} 0..1 moon phase (0 = full). @private */
    this._moonPhase = 0;
    /** @type {number} Aurora strength, 0..1. @private */
    this._aurora = 0;
    /** @type {number} Seconds since world start, for animation. @private */
    this._time = 0;
    /** @type {number} Internal frame counter for the blue-noise walk. @private */
    this._frameCounter = 0;
    /** @type {boolean} True once the ambient has been integrated at least once. @private */
    this._ambientValid = false;
    /** @type {number} `frame.time` of the last ambient integration. @private */
    this._ambientTime = -1e9;
    /** @type {boolean} @private */
    this._updated = false;
    /** @type {boolean} @private */
    this._disposed = false;

    /* ---- scratch (no per-frame allocation) -------------------------------- */

    this._vec4A = new Float32Array(4);
    this._vec4B = new Float32Array(4);
    this._vec4C = new Float32Array(4);
    this._vec4D = new Float32Array(4);
    this._vec4E = new Float32Array(4);
    this._vec4F = new Float32Array(4);
    this._vec4G = new Float32Array(4);
    this._vec4H = new Float32Array(4);
    this._vec4I = new Float32Array(4);
    this._vec2A = new Float32Array(2);
    this._vec2B = new Float32Array(2);
    this._sunDirF = new Float32Array(3);
    this._moonDirF = new Float32Array(3);
    this._cloudSun = new Float32Array(3);
    this._cloudAmbTop = new Float32Array(3);
    this._cloudAmbBot = new Float32Array(3);
    this._starMatrix = new Float32Array(9);
    this._windOffset = new Float32Array(2);
    this._cirrusWind = 0;

    /**
     * Linear rgb radiance of moonlight as a directional key light, for the
     * lighting pass to use after sunset.
     * @type {Float32Array}
     */
    this.moonColor = new Float32Array([0, 0, 0]);

    /**
     * Reused ambient descriptor returned by {@link Sky#getAmbient}.
     * @type {{skyColor:Float32Array, groundColor:Float32Array, sunColor:Float32Array,
     *         moonColor:Float32Array, intensity:number}}
     * @private
     */
    this._ambient = {
      skyColor: new Float32Array([0.20, 0.34, 0.52]),
      groundColor: new Float32Array([0.10, 0.10, 0.10]),
      sunColor: new Float32Array([1, 1, 1]),
      moonColor: this.moonColor,
      intensity: 0.3,
    };

    /**
     * Reused fog descriptor returned by {@link Sky#getFog}.
     * @type {{color:Float32Array, density:number}}
     * @private
     */
    this._fog = { color: this.fogColor, density: this.fogDensity };

    this._onSettingsChange = (key) => this._handleSettingChange(key);
    if (this.settings && typeof this.settings.on === 'function') {
      try { this.settings.on('change', this._onSettingsChange); } catch (err) { /* optional */ }
    }

    try {
      this._createFallbacks();
      this._createTargets();
      this._buildPrograms();
    } catch (err) {
      this._reportFailure(err);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Settings                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * Read a setting, tolerating a missing store or an unknown key.
   * @param {string} key setting key
   * @param {*} fallback default value
   * @returns {*} the value or `fallback`
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
   * Normalize `settings.cloudQuality` onto a known step.
   * @returns {string} one of the {@link CLOUD_QUALITY} keys
   * @private
   */
  _resolveCloudQuality() {
    const key = String(this._setting('cloudQuality', 'high')).toLowerCase();
    return CLOUD_QUALITY[key] ? key : 'high';
  }

  /**
   * Pick the LUT quality step from the cloud quality (they track each other).
   * @returns {string} one of the {@link SKY_LUT_QUALITY} keys
   * @private
   */
  _resolveLutQuality() {
    const q = this._resolveCloudQuality();
    if (q === 'off' || q === 'low') return 'low';
    if (q === 'medium') return 'medium';
    if (q === 'ultra') return 'ultra';
    return 'high';
  }

  /**
   * React to a settings change: rebuild the LUT targets and/or the background
   * program when the quality step moved.
   * @param {string} key changed key
   * @returns {void}
   * @private
   */
  _handleSettingChange(key) {
    if (this._disposed) return;
    if (key !== 'cloudQuality' && key !== 'volumetricClouds') return;
    const cloud = this._resolveCloudQuality();
    const lut = this._resolveLutQuality();
    const vol = this._setting('volumetricClouds', true) !== false;
    if (cloud === this.cloudQuality && lut === this.lutQuality && vol === this.volumetric) return;

    const lutChanged = lut !== this.lutQuality;
    this.cloudQuality = cloud;
    this.lutQuality = lut;
    this.volumetric = vol;
    this.failed = false;
    try {
      this._ambientValid = false;
      if (lutChanged) {
        this._createTargets();
        this._transmittanceValid = false;
        this._lutHaze = -1;
        this._lutViewHeight = -1;
        this._lutSunDir[1] = -2;
      }
      this._buildPrograms();
    } catch (err) {
      this._reportFailure(err);
    }
  }

  /**
   * Log a failure once and disable the pass for the rest of the session.
   * @param {*} err error or message
   * @returns {void}
   * @private
   */
  _reportFailure(err) {
    if (this.failed) return;
    this.failed = true;
    console.error('[sky] disabled after a failure:', err);
  }

  /* ----------------------------------------------------------------------- */
  /* GPU resources                                                            */
  /* ----------------------------------------------------------------------- */

  /**
   * Build the internal blue-noise and 3D-noise fallbacks, so the shader never
   * samples an unbound sampler when the `TextureManager` has not run yet.
   * @returns {void}
   * @private
   */
  _createFallbacks() {
    const gl = this.gl;

    // R2 low-discrepancy dither: not true blue noise, but its Fourier spectrum
    // is flat enough to hide the cloud ray-start banding.
    const n = FALLBACK_NOISE_SIZE;
    const noise = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        noise[y * n + x] = Math.min(255, Math.floor(fract(x * R2_A1 + y * R2_A2) * 256));
      }
    }
    this._fallbackNoise = this.device.createTexture({
      target: gl.TEXTURE_2D,
      width: n,
      height: n,
      internalFormat: gl.R8,
      data: noise,
      min: 'nearest',
      mag: 'nearest',
      wrap: 'repeat',
      mips: false,
    });

    // A tiny tiling value-noise volume with the same channel meaning as the
    // TextureManager volume (r = base shape, gba = rising-frequency detail).
    const c = FALLBACK_CLOUD_SIZE;
    const vol = new Uint8Array(c * c * c * 4);
    const cellHash = (x, y, z, s) => {
      const xi = ((x % c) + c) % c;
      const yi = ((y % c) + c) % c;
      const zi = ((z % c) + c) % c;
      return fract(Math.sin(xi * 127.1 + yi * 311.7 + zi * 74.7 + s * 19.3) * 43758.5453);
    };
    const smoothVol = (x, y, z, freq, s) => {
      const fx = x * freq, fy = y * freq, fz = z * freq;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      const tx = fx - ix, ty = fy - iy, tz = fz - iz;
      const ux = tx * tx * (3 - 2 * tx);
      const uy = ty * ty * (3 - 2 * ty);
      const uz = tz * tz * (3 - 2 * tz);
      let acc = 0;
      for (let k = 0; k < 8; k++) {
        const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
        const w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
        acc += w * cellHash(ix + dx, iy + dy, iz + dz, s);
      }
      return acc;
    };
    let i = 0;
    for (let z = 0; z < c; z++) {
      for (let y = 0; y < c; y++) {
        for (let x = 0; x < c; x++) {
          const u = x / c, v = y / c, w = z / c;
          vol[i++] = Math.floor(clamp(smoothVol(u, v, w, 4, 1), 0, 1) * 255);
          vol[i++] = Math.floor(clamp(smoothVol(u, v, w, 4, 2), 0, 1) * 255);
          vol[i++] = Math.floor(clamp(smoothVol(u, v, w, 8, 3), 0, 1) * 255);
          vol[i++] = Math.floor(clamp(smoothVol(u, v, w, 8, 4), 0, 1) * 255);
        }
      }
    }
    this._fallbackCloud = this.device.createTexture({
      target: gl.TEXTURE_3D,
      width: c,
      height: c,
      depth: c,
      internalFormat: gl.RGBA8,
      data: vol,
      min: 'linear',
      mag: 'linear',
      wrap: 'repeat',
      mips: false,
    });
  }

  /**
   * Allocate the three LUTs and their framebuffers for the active quality step.
   * Falls back to `RGBA8` when float render targets are unavailable — the LUTs
   * then band slightly but the sky still renders.
   * @returns {boolean} true when every target is usable
   * @private
   */
  _createTargets() {
    const gl = this.gl;
    const q = SKY_LUT_QUALITY[this.lutQuality] || SKY_LUT_QUALITY.high;
    this._destroyTargets();

    // Half-float colour buffers need EXT_color_buffer_float to be *renderable*;
    // linear filtering of RGBA16F is core WebGL2, so the filter never degrades.
    const useFloat = !!this.device.caps.colorBufferFloat;
    const internalFormat = useFloat ? gl.RGBA16F : gl.RGBA8;

    const make = (w, h, wrapS) => this.device.createTexture({
      target: gl.TEXTURE_2D,
      width: w,
      height: h,
      internalFormat,
      min: 'linear',
      mag: 'linear',
      wrap: wrapS ? { s: 'repeat', t: 'clamp' } : 'clamp',
      mips: false,
    });

    this.transmittanceLUT = make(q.transmittance[0], q.transmittance[1], false);
    this.multiScatterLUT = make(q.multiScatter[0], q.multiScatter[1], false);
    this.skyViewLUT = make(q.skyView[0], q.skyView[1], true);
    this.lut = this.skyViewLUT;

    this._transFBO = this.device.createFramebuffer({ name: 'sky-transmittance', color: [this.transmittanceLUT] });
    this._msFBO = this.device.createFramebuffer({ name: 'sky-multiscatter', color: [this.multiScatterLUT] });
    this._viewFBO = this.device.createFramebuffer({ name: 'sky-view', color: [this.skyViewLUT] });

    if (!this._transFBO.complete || !this._msFBO.complete || !this._viewFBO.complete) {
      this._reportFailure('one of the sky LUT framebuffers is incomplete');
      return false;
    }
    return true;
  }

  /**
   * Delete every LUT and framebuffer.
   * @returns {void}
   * @private
   */
  _destroyTargets() {
    for (const fbo of [this._transFBO, this._msFBO, this._viewFBO]) {
      if (fbo) { try { fbo.dispose(); } catch (err) { /* already gone */ } }
    }
    this._transFBO = this._msFBO = this._viewFBO = null;
    for (const tex of [this.transmittanceLUT, this.multiScatterLUT, this.skyViewLUT]) {
      if (tex) { try { this.device.deleteTexture(tex); } catch (err) { /* already gone */ } }
    }
    this.transmittanceLUT = null;
    this.multiScatterLUT = null;
    this.skyViewLUT = null;
    this.lut = null;
  }

  /**
   * Compile (or recompile) the four sky programs for the active quality step.
   * @returns {boolean} true when every program linked
   * @private
   */
  _buildPrograms() {
    const q = SKY_LUT_QUALITY[this.lutQuality] || SKY_LUT_QUALITY.high;
    const c = CLOUD_QUALITY[this.cloudQuality] || CLOUD_QUALITY.high;
    const volumetric = this.volumetric && c.volumetric;
    this._disposePrograms();

    try {
      this._transProgram = this.device.createProgram('sky-transmittance', FULLSCREEN_VS, TRANSMITTANCE_FS, {
        defines: { TRANSMITTANCE_STEPS: q.transSteps },
      });
      this._msProgram = this.device.createProgram('sky-multiscatter', FULLSCREEN_VS, MULTISCATTER_FS, {
        defines: { MS_SQRT_SAMPLES: q.msSqrt, MS_STEPS: q.msSteps },
      });
      this._viewProgram = this.device.createProgram('sky-view', FULLSCREEN_VS, SKYVIEW_FS, {
        defines: { SKY_STEPS: q.viewSteps },
      });
      this._bgProgram = this.device.createProgram('sky-background', SKY_VS, SKY_BACKGROUND_FS, {
        defines: {
          STAR_GRID: c.starGrid,
          CLOUDS_ENABLED: this.cloudQuality === 'off' ? 0 : 1,
          VOLUMETRIC_CLOUDS: volumetric ? 1 : 0,
          CLOUD_STEPS: Math.max(volumetric ? c.steps : 1, 1),
          CLOUD_LIGHT_STEPS: Math.max(volumetric ? c.lightSteps : 1, 1),
          CLOUD_DETAIL: c.detail ? 1 : 0,
          CIRRUS_ENABLED: c.cirrus ? 1 : 0,
          AURORA_ENABLED: c.aurora ? 1 : 0,
          AURORA_LAYERS: Math.max(c.auroraLayers, 1),
        },
      });

      const programs = [this._transProgram, this._msProgram, this._viewProgram, this._bgProgram];
      const ok = this.device.flushPrograms(programs);
      this._bgProgram.bindUBO('Frame', 0);
      if (ok !== programs.length) {
        this._reportFailure('a sky shader failed to compile');
        return false;
      }
      // Force a full LUT rebuild against the new programs.
      this._transmittanceValid = false;
      this._lutHaze = -1;
      this._lutViewHeight = -1;
      this._lutSunDir[1] = -2;
      return true;
    } catch (err) {
      this._reportFailure(err);
      return false;
    }
  }

  /**
   * Delete the programs.
   * @returns {void}
   * @private
   */
  _disposePrograms() {
    for (const p of [this._transProgram, this._msProgram, this._viewProgram, this._bgProgram]) {
      if (p && typeof p.dispose === 'function') {
        try { p.dispose(); } catch (err) { /* already gone */ }
      }
    }
    this._transProgram = null;
    this._msProgram = null;
    this._viewProgram = null;
    this._bgProgram = null;
  }

  /* ----------------------------------------------------------------------- */
  /* Shared textures                                                          */
  /* ----------------------------------------------------------------------- */

  /**
   * Adopt the blue-noise mask and the 3D cloud volume from a
   * {@link import('./textures.js').TextureManager}. Safe to call again after a
   * `regenerate()`.
   * @param {?{blueNoise?:?WebGLTexture, cloudNoise?:?WebGLTexture}} textures texture manager
   * @returns {void}
   */
  setTextures(textures) {
    if (!textures) return;
    if (textures.blueNoise) this.blueNoise = textures.blueNoise;
    if (textures.cloudNoise) this.cloudNoise = textures.cloudNoise;
  }

  /**
   * Supply the shared blue-noise mask (unit 11).
   * @param {?WebGLTexture} texture 2D R8 mask with `REPEAT` wrapping
   * @returns {void}
   */
  setBlueNoise(texture) { this.blueNoise = texture || null; }

  /**
   * Supply the shared 3D cloud volume (unit 13).
   * @param {?WebGLTexture} texture `TEXTURE_3D` RGBA8 Perlin-Worley volume
   * @returns {void}
   */
  setCloudNoise(texture) { this.cloudNoise = texture || null; }

  /**
   * Bind the sky-view LUT to its fixed unit on another pass' program.
   * @param {{setTexture:function(string, WebGLTexture, number, number=):void}} program target program
   * @param {string} [name='u_skyLUT'] sampler uniform name
   * @returns {void}
   */
  bindSkyLUT(program, name = 'u_skyLUT') {
    if (!program || typeof program.setTexture !== 'function' || !this.lut) return;
    program.setTexture(name, this.lut, SKY_LUT_UNIT, this.gl.TEXTURE_2D);
  }

  /**
   * Record the backbuffer size. The sky owns no screen-sized targets; the size
   * is only used to keep the stars roughly two pixels wide at any resolution.
   * @param {number} w width in pixels
   * @param {number} h height in pixels
   * @returns {boolean} always true
   */
  resize(w, h) {
    this.width = Math.max(1, w | 0);
    this.height = Math.max(1, h | 0);
    return true;
  }

  /* ----------------------------------------------------------------------- */
  /* Per-frame update                                                         */
  /* ----------------------------------------------------------------------- */

  /**
   * Refresh the cached environment state, rebuild the LUTs when the sun has
   * moved far enough or the weather changed, and recompute the ambient, the
   * sun colour and the fog colour the rest of the pipeline reads.
   *
   * Never throws: any failure disables the pass and logs once.
   *
   * @param {Object} frame the render frame (spec 5.26)
   * @param {Object} [environment] the `game/environment.js` state (spec 5.37)
   * @returns {void}
   */
  update(frame, environment) {
    if (this._disposed || this.failed) return;
    try {
      this._resolveEnvironment(frame, environment);
      const rebuilt = this._updateLUTs();
      // The CPU hemisphere integral costs about 0.8 ms, so it runs only when
      // the LUTs it mirrors actually changed (roughly once a second), with a
      // half-second safety net for anything that drifts without touching them.
      if (rebuilt || !this._ambientValid || Math.abs(this._time - this._ambientTime) > 0.5) {
        this._computeAmbientAndFog();
        this._ambientValid = true;
        this._ambientTime = this._time;
      }
      this._updated = true;
    } catch (err) {
      this._reportFailure(err);
    }
  }

  /**
   * Pull everything the sky needs out of the frame and the environment, with a
   * usable fallback for every field so the sky renders even before
   * `game/environment.js` exists.
   * @param {Object} frame render frame
   * @param {Object} [environment] environment state
   * @returns {void}
   * @private
   */
  _resolveEnvironment(frame, environment) {
    const env = environment || (frame && frame.environment) || null;
    const camera = (frame && frame.camera) || null;

    /* ---- time ------------------------------------------------------------ */
    this._time = num(frame && frame.time, this._time + 0.016);
    const timeOfDay = clamp(num(env && env.timeOfDay, fract(this._time / 1200)), 0, 1);

    /* ---- sun ------------------------------------------------------------- */
    if (!readVec3(env && env.sunDir, this._sunDir)) {
      // 0 = sunrise in the east, 0.25 = noon; the arc is tilted so the sun does
      // not pass exactly through the zenith.
      const a = timeOfDay * Math.PI * 2;
      const tilt = 0.35;
      this._sunDir[0] = Math.cos(a);
      this._sunDir[1] = Math.sin(a) * Math.cos(tilt);
      this._sunDir[2] = Math.sin(a) * Math.sin(tilt);
    }
    normalize3(this._sunDir, 0, 1, 0);

    /* ---- moon ------------------------------------------------------------ */
    if (!readVec3(env && env.moonDir, this._moonDir)) {
      this._moonDir[0] = -this._sunDir[0];
      this._moonDir[1] = -this._sunDir[1];
      this._moonDir[2] = -this._sunDir[2];
    }
    normalize3(this._moonDir, 0, -1, 0);

    let phase = num(env && env.moonPhase, 0);
    if (phase > 1.0001) phase = phase / 8;
    this._moonPhase = clamp(fract(phase), 0, 1);

    /* ---- weather --------------------------------------------------------- */
    const weather = String((env && env.weather) || 'clear');
    this._rain = clamp(num(env && env.rainStrength, weather === 'clear' ? 0 : 1), 0, 1);
    this._snow = weather === 'snow' ? 1 : 0;
    const thunder = clamp(num(env && env.thunderStrength, 0), 0, 1);
    // Rain and snow thicken the aerosol layer: more Mie, greyer, darker.
    this._haze = 1 + this._rain * 2.6 + thunder * 0.9 + this._snow * 0.5;

    /* ---- eye altitude ---------------------------------------------------- */
    let camY = 62;
    if (camera && camera.position && Number.isFinite(camera.position[1])) camY = camera.position[1];
    const seaLevel = num(env && env.seaLevel, 62);
    // 1 block == 1 metre; clamp so a creative-mode ascent cannot leave the LUT.
    const altitudeKm = clamp((camY - seaLevel) * 0.001, 0, 30);
    this._viewHeight = ATMOSPHERE.groundRadius + Math.max(altitudeKm, 0.0004);

    /* ---- aurora ---------------------------------------------------------- */
    this._aurora = this._resolveAurora(env);

    /* ---- star rotation --------------------------------------------------- */
    this._buildStarMatrix(timeOfDay);

    /* ---- cloud wind ------------------------------------------------------ */
    const windSpeed = 11 + this._rain * 16;
    this._windOffset[0] = (this._time * windSpeed) % 100000;
    this._windOffset[1] = (this._time * windSpeed * 0.42) % 100000;
    this._cirrusWind = (this._time * 0.0016) % 1000;
  }

  /**
   * Decide how strong the aurora should be tonight.
   *
   * Honoured in order: an explicit `environment.auroraIntensity` / `aurora`,
   * then a `environment.latitude` in degrees (aurora appears past ~50 deg),
   * and finally — because `game/environment.js` is not required to expose
   * either — a stable per-in-game-day hash so the aurora shows up on roughly
   * one night in three instead of never.
   *
   * @param {?Object} env environment state
   * @returns {number} 0..1 aurora strength before the night/rain gates
   * @private
   */
  _resolveAurora(env) {
    let a = num(env && env.auroraIntensity, NaN);
    if (!Number.isFinite(a)) a = num(env && env.aurora, NaN);
    if (!Number.isFinite(a)) {
      const lat = num(env && env.latitude, NaN);
      if (Number.isFinite(lat)) {
        a = clamp((Math.abs(lat) - 48) / 22, 0, 1);
      } else {
        const day = Math.floor(num(env && env.dayCount, Math.floor(this._time / 1200)));
        const h = fract(Math.sin(day * 127.1 + 311.7) * 43758.5453);
        a = h > 0.62 ? 0.25 + clamp((h - 0.62) / 0.38, 0, 1) * 0.75 : 0;
      }
    }
    a = clamp(a, 0, 1);

    // Night only, and washed out by cloud cover.
    const night = smoothstep(0.05, -0.16, this._sunDir[1]);
    return a * night * (1 - 0.9 * this._rain);
  }

  /**
   * Build the 3x3 matrix that rotates a view direction into celestial space, so
   * the star field turns with the day cycle around a tilted pole.
   * @param {number} timeOfDay 0..1
   * @returns {void}
   * @private
   */
  _buildStarMatrix(timeOfDay) {
    const angle = -timeOfDay * Math.PI * 2;
    // Pole tilted away from the vertical, so the stars sweep an inclined arc.
    const tilt = 0.42;
    const ax = 0;
    const ay = Math.cos(tilt);
    const az = Math.sin(tilt);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const m = this._starMatrix;
    // Column-major, as `uniformMatrix3fv` expects.
    m[0] = t * ax * ax + c;
    m[1] = t * ax * ay + s * az;
    m[2] = t * ax * az - s * ay;
    m[3] = t * ax * ay - s * az;
    m[4] = t * ay * ay + c;
    m[5] = t * ay * az + s * ax;
    m[6] = t * ax * az + s * ay;
    m[7] = t * ay * az - s * ax;
    m[8] = t * az * az + c;
  }

  /**
   * Rebuild whichever LUTs have gone stale.
   *
   * * transmittance — depends on the atmosphere only, so only the haze matters;
   * * multiple scattering — additionally depends on the sun elevation;
   * * sky view — additionally depends on the eye altitude.
   *
   * @returns {boolean} true when at least one LUT was re-rendered
   * @private
   */
  _updateLUTs() {
    if (!this._transProgram || !this._msProgram || !this._viewProgram) return false;
    if (!this._transFBO || !this._msFBO || !this._viewFBO) return false;

    const sun = this._sunDir;
    const alignment = sun[0] * this._lutSunDir[0] + sun[1] * this._lutSunDir[1] + sun[2] * this._lutSunDir[2];
    const hazeChanged = Math.abs(this._haze - this._lutHaze) > HAZE_EPSILON;
    const needTransmittance = !this._transmittanceValid || hazeChanged;
    const needMultiScatter = needTransmittance || alignment < SUN_EPSILON_COS;
    const needSkyView = needMultiScatter ||
      Math.abs(this._viewHeight - this._lutViewHeight) > ALTITUDE_EPSILON * 0.001;
    if (!needSkyView) return false;

    const device = this.device;
    const gl = this.gl;

    // Drop any stale sampler binding on the units we are about to render into:
    // sampling a texture that is also a colour attachment is undefined.
    device.bindTexture(SKY_LUT_UNIT, gl.TEXTURE_2D, null);
    device.bindTexture(TRANSMITTANCE_LUT_UNIT, gl.TEXTURE_2D, null);

    device.setDepthTest(false);
    device.setDepthWrite(false);
    device.setBlend('none');
    device.setCull('none');
    device.setColorMask(true, true, true, true);

    this._vec4A[0] = this._haze;
    this._vec4A[1] = ATMOSPHERE.groundAlbedo;
    this._vec4A[2] = ATMOSPHERE.sunIlluminance;
    this._vec4A[3] = ATMOSPHERE.mieG;

    this._sunDirF[0] = sun[0];
    this._sunDirF[1] = sun[1];
    this._sunDirF[2] = sun[2];

    /* ---- 1. transmittance ------------------------------------------------ */
    if (needTransmittance) {
      const p = this._transProgram;
      if (p.use()) {
        device.bindFramebuffer(this._transFBO);
        p.setVec4('u_atmo', this._vec4A);
        this._vec2A[0] = this._transFBO.width;
        this._vec2A[1] = this._transFBO.height;
        p.setVec2('u_lutSize', this._vec2A);
        device.drawFullscreen();
        this._transmittanceValid = true;
      }
    }

    /* ---- 2. multiple scattering ------------------------------------------ */
    if (needMultiScatter) {
      const p = this._msProgram;
      if (p.use()) {
        device.bindFramebuffer(this._msFBO);
        p.setVec4('u_atmo', this._vec4A);
        this._vec2A[0] = this._msFBO.width;
        this._vec2A[1] = this._msFBO.height;
        p.setVec2('u_lutSize', this._vec2A);
        p.setTexture('u_transmittanceLUT', this.transmittanceLUT, TRANSMITTANCE_LUT_UNIT, gl.TEXTURE_2D);
        device.drawFullscreen();
      }
    }

    /* ---- 3. sky view ------------------------------------------------------ */
    {
      const p = this._viewProgram;
      if (p.use()) {
        device.bindFramebuffer(this._viewFBO);
        p.setVec4('u_atmo', this._vec4A);
        p.setVec3('u_sunDirection', this._sunDirF);
        p.setFloat('u_viewHeight', this._viewHeight);
        p.setTexture('u_transmittanceLUT', this.transmittanceLUT, TRANSMITTANCE_LUT_UNIT, gl.TEXTURE_2D);
        // Unit 10 is free at this point: the sky-view LUT is the render target,
        // never a source, during this pass.
        p.setTexture('u_msLUT', this.multiScatterLUT, SKY_LUT_UNIT, gl.TEXTURE_2D);
        device.drawFullscreen();
      }
    }

    this._lutSunDir[0] = sun[0];
    this._lutSunDir[1] = sun[1];
    this._lutSunDir[2] = sun[2];
    this._lutHaze = this._haze;
    this._lutViewHeight = this._viewHeight;

    // Leave the LUT we just wrote off unit 10 so the next `setTexture` there
    // is not swallowed by the binding cache.
    device.bindTexture(SKY_LUT_UNIT, gl.TEXTURE_2D, null);
    device.bindFramebuffer(null);
    return true;
  }

  /* ----------------------------------------------------------------------- */
  /* Ambient, sun colour and fog                                              */
  /* ----------------------------------------------------------------------- */

  /**
   * Illuminated fraction of the moon disk for the current phase (0 = full).
   * @returns {number} 0..1
   * @private
   */
  _moonIllumination() {
    return 0.5 + 0.5 * Math.cos(this._moonPhase * Math.PI * 2);
  }

  /**
   * Integrate the atmosphere over the hemisphere on the CPU and turn it into
   * the ambient, the sun colour, the cloud lighting and the fog colour.
   *
   * Called once per {@link Sky#update}; the raymarches are deliberately coarse
   * (4 x 5 directions, 16 steps each) because the result is a single irradiance
   * value, not an image.
   * @returns {void}
   * @private
   */
  _computeAmbientAndFog() {
    const r = this._viewHeight;
    const haze = this._haze;
    const illum = ATMOSPHERE.sunIlluminance;
    const sun = this._sunDir;
    const rain = this._rain;

    /* ---- cosine-weighted hemisphere average ------------------------------ */
    const RINGS = 4;
    const AZIMUTHS = 5;
    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let k = 0; k < RINGS; k++) {
      const mu = (k + 0.5) / RINGS;
      const st = Math.sqrt(Math.max(1 - mu * mu, 0));
      for (let a = 0; a < AZIMUTHS; a++) {
        const phi = ((a + (k & 1) * 0.5) / AZIMUTHS) * Math.PI * 2;
        const dx = st * Math.cos(phi);
        const dz = st * Math.sin(phi);
        cpuSkyRadiance(dx, mu, dz, sun, r, haze, illum, _cpuRad);
        sr += _cpuRad[0] * mu;
        sg += _cpuRad[1] * mu;
        sb += _cpuRad[2] * mu;
        sw += mu;
      }
    }
    const invW = 1 / Math.max(sw, 1e-6);
    let skyR = sr * invW;
    let skyG = sg * invW;
    let skyB = sb * invW;

    /* ---- moonlight ------------------------------------------------------- */
    const moonUp = smoothstep(-0.06, 0.22, this._moonDir[1]);
    const moonFrac = this._moonIllumination();
    const moonAmt = moonUp * (0.06 + 0.94 * moonFrac) * (1 - 0.85 * rain);
    skyR += 0.0075 * moonAmt;
    skyG += 0.0105 * moonAmt;
    skyB += 0.0230 * moonAmt;

    // Artistic floor: a pitch black night is unplayable, and real nights are
    // never truly black either (airglow + integrated starlight).
    skyR += 0.0032;
    skyG += 0.0044;
    skyB += 0.0090;

    /* ---- rain greys and dims the ambient --------------------------------- */
    if (rain > 0) {
      const lum = 0.2126729 * skyR + 0.7151522 * skyG + 0.0721750 * skyB;
      const g = rain * 0.55;
      skyR = lerp(skyR, lum * 0.94, g);
      skyG = lerp(skyG, lum * 0.97, g);
      skyB = lerp(skyB, lum * 1.04, g);
      const dim = 1 - 0.42 * rain;
      skyR *= dim; skyG *= dim; skyB *= dim;
    }

    const amb = this._ambient;
    amb.skyColor[0] = skyR;
    amb.skyColor[1] = skyG;
    amb.skyColor[2] = skyB;

    /* ---- direct sun ------------------------------------------------------ */
    cpuTransmittance(r, clamp(sun[1], -1, 1), haze, _cpuT);
    const sunGate = smoothstep(-0.055, 0.075, sun[1]);
    const sunAtten = illum * sunGate * (1 - 0.80 * rain) * (1 - 0.35 * this._snow);
    amb.sunColor[0] = _cpuT[0] * sunAtten;
    amb.sunColor[1] = _cpuT[1] * sunAtten;
    amb.sunColor[2] = _cpuT[2] * sunAtten;

    this.sunColor[0] = amb.sunColor[0];
    this.sunColor[1] = amb.sunColor[1];
    this.sunColor[2] = amb.sunColor[2];
    this.sunIntensity = sunGate * (1 - 0.80 * rain);

    /* ---- moonlight as a directional key light ---------------------------- */
    const moonKey = moonAmt * 0.42;
    this.moonColor[0] = 0.32 * moonKey;
    this.moonColor[1] = 0.40 * moonKey;
    this.moonColor[2] = 0.68 * moonKey;
    amb.moonColor = this.moonColor;

    /* ---- ground bounce --------------------------------------------------- */
    const albedo = ATMOSPHERE.groundAlbedo;
    const sunDown = Math.max(sun[1], 0);
    for (let c = 0; c < 3; c++) {
      const skyC = c === 0 ? skyR : c === 1 ? skyG : skyB;
      amb.groundColor[c] = skyC * albedo * 0.62 +
        amb.sunColor[c] * albedo * sunDown * (0.11 / Math.PI) * 3.0;
    }
    // Snow on the ground bounces far more light back up.
    if (this._snow > 0) {
      for (let c = 0; c < 3; c++) amb.groundColor[c] *= 1 + 1.35 * this._snow;
    }

    amb.intensity = 0.2126729 * skyR + 0.7151522 * skyG + 0.0721750 * skyB;

    /* ---- cloud lighting --------------------------------------------------- */
    const cloudSunGain = 0.22 * (1 - 0.62 * rain);
    for (let c = 0; c < 3; c++) {
      this._cloudSun[c] = amb.sunColor[c] * cloudSunGain + this.moonColor[c] * 0.55;
    }
    this._cloudAmbTop[0] = skyR * 1.55;
    this._cloudAmbTop[1] = skyG * 1.55;
    this._cloudAmbTop[2] = skyB * 1.55;
    for (let c = 0; c < 3; c++) {
      this._cloudAmbBot[c] = (c === 0 ? skyR : c === 1 ? skyG : skyB) * 0.42 +
        amb.groundColor[c] * 0.55;
    }
    if (rain > 0) {
      const dark = 1 - 0.42 * rain;
      for (let c = 0; c < 3; c++) {
        this._cloudAmbTop[c] *= dark;
        this._cloudAmbBot[c] *= dark;
      }
    }

    /* ---- fog -------------------------------------------------------------- */
    // Average the sky just above the horizon: that is exactly the radiance
    // distant terrain has to blend into.
    const elev = 0.05;
    const horiz = Math.sqrt(Math.max(1 - elev * elev, 0));
    let fr = 0, fg = 0, fb = 0;
    const FOG_DIRS = 6;
    for (let a = 0; a < FOG_DIRS; a++) {
      const phi = (a / FOG_DIRS) * Math.PI * 2;
      cpuSkyRadiance(horiz * Math.cos(phi), elev, horiz * Math.sin(phi), sun, r, haze, illum, _cpuRad);
      fr += _cpuRad[0];
      fg += _cpuRad[1];
      fb += _cpuRad[2];
    }
    // Fog is in-scattering along a mostly horizontal path, so it is dominated by
    // the horizon ring but not purely made of it: a little of the whole-dome
    // average keeps it from tracking the brightest sliver of sky.
    const invF = 0.72 / FOG_DIRS;
    fr = fr * invF + skyR * 0.28;
    fg = fg * invF + skyG * 0.28;
    fb = fb * invF + skyB * 0.28;

    fr += 0.010 * moonAmt + 0.0045;
    fg += 0.013 * moonAmt + 0.0058;
    fb += 0.026 * moonAmt + 0.0110;

    if (rain > 0) {
      const lum = 0.2126729 * fr + 0.7151522 * fg + 0.0721750 * fb;
      const g = rain * 0.72;
      fr = lerp(fr, lum * 0.92, g);
      fg = lerp(fg, lum * 0.96, g);
      fb = lerp(fb, lum * 1.05, g);
      const dim = 1 - 0.38 * rain;
      fr *= dim; fg *= dim; fb *= dim;
    }
    if (this._snow > 0) {
      const s = this._snow * 0.6;
      fr = lerp(fr, fr * 1.25 + 0.02, s);
      fg = lerp(fg, fg * 1.25 + 0.022, s);
      fb = lerp(fb, fb * 1.22 + 0.026, s);
    }

    this.fogColor[0] = Math.max(fr, 0);
    this.fogColor[1] = Math.max(fg, 0);
    this.fogColor[2] = Math.max(fb, 0);

    const renderDistanceBlocks = Math.max(32, num(this._setting('renderDistance', 10), 10) * 16);
    let density = 1.15 / renderDistanceBlocks;
    density *= 1 + 1.35 * rain + 0.55 * this._snow;
    this.fogDensity = clamp(density, 0.0008, 0.09);
  }

  /**
   * Ambient lighting derived from the atmosphere, for the deferred lighting
   * pass' image-based ambient term.
   *
   * All three colours are **absolute linear values** — nothing needs to be
   * multiplied by `intensity`, which is only the luminance of `skyColor`
   * offered as a convenience scalar. The recommended `Frame` UBO upload is
   * `u_skyAmbient = [...skyColor, 1.0]` and `u_sunColor = [...sunColor, 1.0]`.
   *
   * @returns {{skyColor:Float32Array, groundColor:Float32Array,
   *            sunColor:Float32Array, moonColor:Float32Array, intensity:number}}
   *          the reused ambient descriptor (never allocate per frame)
   */
  getAmbient() {
    return this._ambient;
  }

  /**
   * The fog colour and density {@link Sky#update} derived from the atmosphere.
   * @returns {{color:Float32Array, density:number}} reused descriptor
   */
  getFog() {
    this._fog.color = this.fogColor;
    this._fog.density = this.fogDensity;
    return this._fog;
  }

  /* ----------------------------------------------------------------------- */
  /* Background pass                                                          */
  /* ----------------------------------------------------------------------- */

  /**
   * Draw the sky wherever the depth buffer still holds the cleared far-plane
   * value.
   *
   * The triangle is emitted at `gl_Position.z == gl_Position.w`, i.e. depth
   * `1.0`, and the pass runs with `LEQUAL` depth testing and **depth writes
   * off**: background pixels (depth `1.0`) pass, geometry pixels (depth `< 1.0`)
   * fail. See the module header for why `LEQUAL` is preferred over `EQUAL`.
   *
   * Writes a single colour attachment (`location = 0`), so bind an HDR scene
   * colour target — not the multi-attachment G-buffer.
   *
   * @param {Object} frame the render frame (spec 5.26)
   * @param {Object} [environment] environment state (spec 5.37)
   * @param {?Object} [target] framebuffer wrapper to draw into; omit to keep
   *        whatever is currently bound
   * @param {{depthTest?:boolean}} [options] pass options
   * @returns {void}
   */
  renderBackground(frame, environment, target, options) {
    if (this._disposed || this.failed || !this._bgProgram) return;
    if (!this._updated) this.update(frame, environment);

    try {
      const device = this.device;
      const gl = this.gl;
      const program = this._bgProgram;
      if (!program.use()) return;

      if (target) device.bindFramebuffer(target);

      const depthTest = !options || options.depthTest !== false;
      device.setDepthTest(depthTest);
      device.setDepthWrite(false);
      if (depthTest) device.setDepthFunc(gl.LEQUAL);
      device.setCull('none');
      device.setBlend('none');
      device.setColorMask(true, true, true, true);

      program.bindUBO('Frame', 0);
      this._bindBackgroundUniforms(frame, program);
      device.drawFullscreen();
    } catch (err) {
      this._reportFailure(err);
    }
  }

  /**
   * Push every uniform of the background pass. Split out of
   * {@link Sky#renderBackground} purely for readability.
   * @param {Object} frame render frame
   * @param {Object} program the background program
   * @returns {void}
   * @private
   */
  _bindBackgroundUniforms(frame, program) {
    const gl = this.gl;
    const rain = this._rain;
    const camera = (frame && frame.camera) || null;

    /* ---- samplers -------------------------------------------------------- */
    program.setTexture('u_skyLUT', this.lut, SKY_LUT_UNIT, gl.TEXTURE_2D);
    program.setTexture('u_transmittanceLUT', this.transmittanceLUT, TRANSMITTANCE_LUT_UNIT, gl.TEXTURE_2D);
    program.setTexture('u_blueNoise', this.blueNoise || this._fallbackNoise, BLUE_NOISE_UNIT, gl.TEXTURE_2D);
    program.setTexture('u_cloudNoise', this.cloudNoise || this._fallbackCloud, CLOUD_NOISE_UNIT, gl.TEXTURE_3D);

    /* ---- atmosphere ------------------------------------------------------ */
    this._vec4A[0] = this._haze;
    this._vec4A[1] = ATMOSPHERE.groundAlbedo;
    this._vec4A[2] = ATMOSPHERE.sunIlluminance;
    this._vec4A[3] = ATMOSPHERE.mieG;
    program.setVec4('u_atmo', this._vec4A);
    program.setFloat('u_viewHeight', this._viewHeight);

    this._sunDirF[0] = this._sunDir[0];
    this._sunDirF[1] = this._sunDir[1];
    this._sunDirF[2] = this._sunDir[2];
    this._moonDirF[0] = this._moonDir[0];
    this._moonDirF[1] = this._moonDir[1];
    this._moonDirF[2] = this._moonDir[2];
    program.setVec3('u_sunDirection', this._sunDirF);
    program.setVec3('u_moonDirection', this._moonDirF);

    /* ---- stars ----------------------------------------------------------- */
    const fovDeg = clamp(num(camera && camera.fov, num(this._setting('fov', 75), 75)), 20, 140);
    const pixelAngle = (2 * Math.tan(fovDeg * Math.PI / 360)) / Math.max(this.height, 1);
    // d2 == 2(1 - cos(theta)) ~= theta^2, so the Gaussian falloff is 1/(2*sigma^2).
    const sigma = Math.max(pixelAngle * 1.15, 3.0e-4);
    const moonGlow = smoothstep(-0.05, 0.25, this._moonDir[1]) * this._moonIllumination();
    program.setMat3('u_starMatrix', this._starMatrix);
    this._vec4B[0] = 1 / (2 * sigma * sigma);
    this._vec4B[1] = 1.0;
    this._vec4B[2] = smoothstep(0.055, -0.09, this._sunDir[1]) *
      (1 - 0.50 * moonGlow) * (1 - 0.92 * rain);
    this._vec4B[3] = this._time * 0.9;
    program.setVec4('u_starParams', this._vec4B);

    /* ---- sun ------------------------------------------------------------- */
    this._vec4C[0] = 0.0095;   // ~0.545 deg, a hair larger than the real disk
    this._vec4C[1] = 3.6;      // HDR gain: bright enough for bloom, finite
    this._vec4C[2] = 1.0;
    this._vec4C[3] = rain;
    program.setVec4('u_sunParams', this._vec4C);

    /* ---- moon ------------------------------------------------------------ */
    const moonFrac = this._moonIllumination();
    this._vec4D[0] = 0.0135;
    this._vec4D[1] = this._moonPhase * Math.PI * 2;
    this._vec4D[2] = (0.05 + 0.95 * moonFrac) *
      smoothstep(-0.065, 0.10, this._moonDir[1]) * (1 - 0.88 * rain);
    this._vec4D[3] = 0.55 + 1.7 * rain;
    program.setVec4('u_moonParams', this._vec4D);

    /* ---- aurora ---------------------------------------------------------- */
    this._vec4E[0] = this._aurora;
    this._vec4E[1] = this._time;
    this._vec4E[2] = 0;
    this._vec4E[3] = 0;
    program.setVec4('u_auroraParams', this._vec4E);

    /* ---- cumulus --------------------------------------------------------- */
    // A very slow breathing term keeps a clear sky from looking frozen.
    const drift = 0.035 * Math.sin(this._time * 0.0071);
    this._vec4F[0] = clamp(lerp(0.46, 0.88, rain) + drift, 0.05, 0.97);
    this._vec4F[1] = lerp(1.0, 1.85, rain);
    this._vec4F[2] = 0.000085;
    this._vec4F[3] = 0.00110;
    program.setVec4('u_cloudA', this._vec4F);

    this._vec4G[0] = CUMULUS_BOTTOM;
    this._vec4G[1] = CUMULUS_TOP;
    this._vec4G[2] = this._windOffset[0];
    this._vec4G[3] = this._windOffset[1];
    program.setVec4('u_cloudB', this._vec4G);

    this._vec4H[0] = 0.030 * (1 + 0.5 * rain);
    this._vec4H[1] = 0.55;
    this._vec4H[2] = 0;
    this._vec4H[3] = CLOUD_MAX_DISTANCE;
    program.setVec4('u_cloudC', this._vec4H);

    /* ---- cirrus ---------------------------------------------------------- */
    this._vec4I[0] = clamp(0.44 + 0.16 * rain, 0.05, 0.95);
    this._vec4I[1] = 0.55 * (1 - 0.55 * rain);
    this._vec4I[2] = CIRRUS_HEIGHT;
    this._vec4I[3] = this._cirrusWind;
    program.setVec4('u_cirrus', this._vec4I);

    /* ---- flat-cloud fallback + horizon ----------------------------------- */
    program.setVec3('u_cloudSun', this._cloudSun);
    program.setVec3('u_cloudAmbTop', this._cloudAmbTop);
    program.setVec3('u_cloudAmbBot', this._cloudAmbBot);

    // Reuse vec4A now that u_atmo has been uploaded.
    const flat = this._vec4A;
    flat[0] = 0.00085;   // 2D noise scale
    flat[1] = 0.30;      // coverage softness
    flat[2] = 900.0;     // shading offset toward the sun, world units
    flat[3] = 0;
    program.setVec4('u_flat', flat);

    const horizon = this._vec4B;
    horizon[0] = 0.10 + 0.46 * rain;   // haze blend toward the fog colour
    horizon[1] = 0.85;                 // ground-half blend
    horizon[2] = 1.0;                  // sky-view gain
    horizon[3] = 0;
    program.setVec4('u_horizon', horizon);

    /* ---- blue-noise walk -------------------------------------------------- */
    const taa = this._setting('taa', true) !== false;
    let index = num(frame && frame.frameIndex, this._frameCounter);
    this._frameCounter = (this._frameCounter + 1) & 0x3fffffff;
    if (!taa) index = 0;
    const cycle = ((Math.floor(index) % 64) + 64) % 64;
    this._vec2B[0] = Math.floor(fract(cycle * R2_A1) * 64);
    this._vec2B[1] = Math.floor(fract(cycle * R2_A2) * 64);
    program.setVec2('u_noiseOffset', this._vec2B);
  }

  /* ----------------------------------------------------------------------- */
  /* Teardown                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * Release every GPU resource and unsubscribe from the settings store.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.settings && typeof this.settings.off === 'function') {
      try { this.settings.off('change', this._onSettingsChange); } catch (err) { /* optional */ }
    }
    this._disposePrograms();
    this._destroyTargets();
    for (const tex of [this._fallbackNoise, this._fallbackCloud]) {
      if (tex) { try { this.device.deleteTexture(tex); } catch (err) { /* already gone */ } }
    }
    this._fallbackNoise = null;
    this._fallbackCloud = null;
    this.blueNoise = null;
    this.cloudNoise = null;
  }
}
