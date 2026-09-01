/**
 * @file render/ssao.js — VOXELIA ground-truth-style ambient occlusion (spec 5.19).
 *
 * A GTAO (ground-truth ambient occlusion) implementation that runs at half
 * resolution, is denoised with a separable depth-aware bilateral filter and is
 * then bilaterally upsampled to full resolution. The final single-channel result
 * lives in {@link SSAO#texture} and is what the lighting pass binds to the fixed
 * `u_ssao` unit **9**.
 *
 * ### Pipeline
 *
 * ```
 *   G-buffer depth (unit 7) ─┐
 *   G-buffer normal (unit 4) ─┼─► [GTAO, half res, R8]  ─► aoA
 *   blue noise      (unit 11) ┘
 *                                aoA ─► [bilateral X] ─► aoB
 *                                aoB ─► [bilateral Y] ─► aoA
 *                                aoA ─► [bilateral upsample] ─► this.texture (full res, R8)
 * ```
 *
 * ### Why GTAO and not SSAO/HBAO
 *
 * Horizon-based methods sample a set of screen-space slices through the pixel,
 * find the maximum horizon angle on each side and then *analytically* integrate
 * the visible arc of the cosine-weighted hemisphere inside that slice. That
 * integral (Jimenez et al. 2016) is the ground truth for the slice, so the
 * result matches a ray-traced reference far better than the "count occluded
 * samples" family, needs fewer taps, and does not need an artist-tuned bias
 * curve. Voxel worlds are all hard 90° corners, which is exactly where
 * sample-counting AO produces the classic dark banding.
 *
 * ### Temporal stability
 *
 * The per-pixel slice rotation and step jitter come from the 64×64 blue-noise
 * mask on unit 11, offset every frame with an R2 low-discrepancy sequence and
 * rotated by the golden ratio. Consecutive frames therefore sample *different*
 * slices of the same integral, which TAA averages into a clean result. When
 * `settings.taa` is off the rotation is frozen so the image does not boil.
 *
 * @module render/ssao
 */

import { FULLSCREEN_VS } from '../core/gl.js';
import { clamp } from '../core/math.js';

/* ------------------------------------------------------------------------- */
/* Constants                                                                  */
/* ------------------------------------------------------------------------- */

/** Fixed unit of `u_ssao` — where the *result* is consumed (ARCHITECTURE.md 3.5). */
export const SSAO_TEXTURE_UNIT = 9;
/** Fixed unit of `u_gNormal`. @type {number} */
export const GNORMAL_UNIT = 4;
/** Fixed unit of `u_gDepth`. @type {number} */
export const GDEPTH_UNIT = 7;
/** Fixed unit of `u_blueNoise`. @type {number} */
export const BLUE_NOISE_UNIT = 11;
/** Scratch unit (3.5 lists 15 as "free / per-pass") for the intermediate AO. */
export const SSAO_SCRATCH_UNIT = 15;

/**
 * Directions / steps per `settings.ssaoQuality` step.
 * @type {Readonly<Object<string, {directions:number, steps:number, blur:number}>>}
 */
export const SSAO_QUALITY = Object.freeze({
  low: { directions: 4, steps: 2, blur: 2 },
  medium: { directions: 6, steps: 4, blur: 3 },
  high: { directions: 8, steps: 6, blur: 3 },
  ultra: { directions: 12, steps: 8, blur: 4 },
});

/** Edge size of the internally generated fallback blue-noise mask. */
const FALLBACK_NOISE_SIZE = 32;

/** R2 low-discrepancy constants used to walk the noise mask per frame. */
const R2_A1 = 0.7548776662466927;
const R2_A2 = 0.5698402909980532;

/** Golden-ratio conjugate, used for the per-frame slice rotation. */
const GOLDEN = 0.6180339887498949;

/* ------------------------------------------------------------------------- */
/* Shaders                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * GTAO fragment shader (half resolution).
 * `AO_DIRECTIONS` / `AO_STEPS` are injected as defines.
 * @type {string}
 */
const GTAO_FS = `
#include <frame>
#include <math>
#include <depth>

#ifndef AO_DIRECTIONS
#define AO_DIRECTIONS 8
#endif
#ifndef AO_STEPS
#define AO_STEPS 6
#endif

in vec2 v_uv;
layout(location = 0) out vec4 o_frag;

uniform sampler2D u_gDepth;
uniform sampler2D u_gNormal;
uniform sampler2D u_blueNoise;

/** x = width, y = height, z = 1/width, w = 1/height of the half-res target. */
uniform vec4 u_aoTarget;
/** x = world radius, y = intensity, z = thin-occluder compensation, w = max radius in px. */
uniform vec4 u_aoParams;
/** Per-frame integer offset into the blue-noise mask, in texels. */
uniform vec2 u_noiseOffset;
/** Per-frame rotation added to the slice angle, 0..1. */
uniform float u_temporalRot;
/** Edge size of the blue-noise mask in texels. */
uniform float u_noiseSize;

/** Anything at or beyond this window-space depth is sky and cannot occlude. */
const float AO_SKY_DEPTH = 0.9999995;

/**
 * March one side of a slice and return the cosine of the widest horizon angle
 * found, measured against the view vector.
 *
 * Two heuristics keep thin geometry (leaves, fences, torch posts, single-block
 * pillars) from behaving like an infinite occluder:
 *  - a quadratic distance falloff fades a sample's contribution to "no horizon"
 *    as it approaches the world-space radius, which removes the dark halo that
 *    naive HBAO leaves around silhouettes;
 *  - 'thin' lets a *later* sample along the ray pull the horizon back down
 *    (thin-occluder compensation): if the ray passes an occluder and finds open
 *    space behind it, the occluder is treated as a sheet rather than as a wall.
 */
float voxMarchHorizon(vec2 uv, vec3 P, vec3 V, vec2 dirTexel, float stepPx,
                      float jitter, float invRadius, float thin) {
  float horizon = -1.0;
  for (int i = 0; i < AO_STEPS; ++i) {
    float distPx = (float(i) + jitter) * stepPx + 1.0;
    vec2 suv = uv + dirTexel * distPx;
    if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) break;
    float d = textureLod(u_gDepth, suv, 0.0).r;
    if (d >= AO_SKY_DEPTH) continue;
    vec3 S = viewFromDepth(suv, d);
    vec3 dv = S - P;
    float dl = length(dv);
    if (dl < 1.0e-4) continue;
    float c = dot(dv / dl, V);
    float fall = saturate(dl * invRadius);
    c = mix(c, -1.0, fall * fall);
    horizon = mix(max(horizon, c), c, thin);
  }
  return horizon;
}

void main() {
  vec2 uv = v_uv;
  float rawDepth = textureLod(u_gDepth, uv, 0.0).r;
  if (rawDepth >= AO_SKY_DEPTH) { o_frag = vec4(1.0); return; }

  vec3 P = viewFromDepth(uv, rawDepth);
  float viewDist = max(-P.z, 1.0e-3);

  vec3 nEnc = textureLod(u_gNormal, uv, 0.0).xyz * 2.0 - 1.0;
  float nLen = length(nEnc);
  vec3 N = nLen > 1.0e-4 ? normalize(mat3(u_view) * (nEnc / nLen)) : vec3(0.0, 0.0, 1.0);

  // Lift the origin off the surface so depth-buffer quantisation on grazing
  // faces cannot occlude the pixel with itself.
  P += N * (viewDist * 0.0015);
  vec3 V = normalize(-P);

  float radiusWorld = max(u_aoParams.x, 0.01);
  float radiusPx = radiusWorld * (u_proj[1][1] * 0.5 * u_aoTarget.y) / viewDist;
  radiusPx = min(radiusPx, max(u_aoParams.w, 2.0));
  if (radiusPx < 1.5) { o_frag = vec4(1.0); return; }

  // textureLod, not texture(): the early returns above make this non-uniform
  // control flow, where an implicit-derivative fetch is undefined. The mask is
  // NEAREST + REPEAT with no mips, so LOD 0 is exactly the intended texel.
  vec2 noiseUV = (gl_FragCoord.xy + u_noiseOffset) / max(u_noiseSize, 1.0);
  float rnd = textureLod(u_blueNoise, noiseUV, 0.0).r;
  float dirRot = fract(rnd + u_temporalRot);
  float jitter = fract(rnd * 7.0 + u_temporalRot * 1.6180339887498949);

  float stepPx = radiusPx / float(AO_STEPS);
  vec2 texel = u_aoTarget.zw;
  float invRadius = 1.0 / radiusWorld;
  float thin = clamp(u_aoParams.z, 0.0, 1.0);
  float sliceStep = PI / float(AO_DIRECTIONS);

  float visibility = 0.0;

  for (int s = 0; s < AO_DIRECTIONS; ++s) {
    float phi = (float(s) + dirRot) * sliceStep;
    vec2 dir = vec2(cos(phi), sin(phi));
    vec3 sliceDir = vec3(dir, 0.0);

    // Normal of the slice plane spanned by the view vector and the slice
    // direction; the whole integral lives inside that plane.
    vec3 axis = cross(sliceDir, V);
    axis /= max(length(axis), 1.0e-5);

    vec3 projN = N - axis * dot(N, axis);
    float projNLen = length(projN);
    vec3 projNn = projN / max(projNLen, 1.0e-6);

    // In-plane vector orthogonal to V, pointing along +dir.
    vec3 tangent = cross(V, axis);
    float cosGamma = clamp(dot(projNn, V), -1.0, 1.0);
    float gamma = (dot(projNn, tangent) < 0.0 ? -1.0 : 1.0) * acos(cosGamma);

    vec2 dirTexel = dir * texel;
    float c2 = voxMarchHorizon(uv, P, V, dirTexel, stepPx, jitter, invRadius, thin);
    float c1 = voxMarchHorizon(uv, P, V, -dirTexel, stepPx, jitter, invRadius, thin);

    float h1 = -acos(clamp(c1, -1.0, 1.0));
    float h2 = acos(clamp(c2, -1.0, 1.0));

    // Clamp both horizons into the hemisphere around the (projected) normal.
    h1 = gamma + max(h1 - gamma, -HALF_PI);
    h2 = gamma + min(h2 - gamma, HALF_PI);

    // Analytic inner integral of the visible arc (Jimenez et al. 2016).
    float sg = sin(gamma);
    float cg = cos(gamma);
    float arc = 0.25 * (-cos(2.0 * h1 - gamma) + cg + 2.0 * h1 * sg)
              + 0.25 * (-cos(2.0 * h2 - gamma) + cg + 2.0 * h2 * sg);
    visibility += projNLen * arc;
  }

  visibility = saturate(visibility / float(AO_DIRECTIONS));
  visibility = mix(1.0, visibility, clamp(u_aoParams.y, 0.0, 4.0));
  o_frag = vec4(saturate(visibility), 0.0, 0.0, 1.0);
}
`;

/**
 * Separable depth-aware bilateral blur (half resolution).
 * `BLUR_RADIUS` is injected as a define.
 * @type {string}
 */
const BLUR_FS = `
#include <frame>
#include <math>
#include <depth>

#ifndef BLUR_RADIUS
#define BLUR_RADIUS 3
#endif

in vec2 v_uv;
layout(location = 0) out vec4 o_frag;

uniform sampler2D u_aoTex;
uniform sampler2D u_gDepth;
/** One texel step along the blur axis, in half-res uv units. */
uniform vec2 u_blurDir;
/** Relative depth tolerance: the sigma is u_depthSigma * linear depth. */
uniform float u_depthSigma;

void main() {
  float centerDepth = linearizeDepth(textureLod(u_gDepth, v_uv, 0.0).r);
  float sum = textureLod(u_aoTex, v_uv, 0.0).r;
  float wsum = 1.0;
  float sigma = max(u_depthSigma * centerDepth, 0.02);
  float spread = max(float(BLUR_RADIUS), 1.0);

  for (int i = 1; i <= BLUR_RADIUS; ++i) {
    float fi = float(i);
    float gw = exp(-0.5 * (fi * fi) / (0.35 * spread * spread));
    for (int s = 0; s < 2; ++s) {
      vec2 suv = v_uv + u_blurDir * (s == 0 ? fi : -fi);
      if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) continue;
      float d = linearizeDepth(textureLod(u_gDepth, suv, 0.0).r);
      float w = gw * exp(-abs(d - centerDepth) / sigma);
      sum += textureLod(u_aoTex, suv, 0.0).r * w;
      wsum += w;
    }
  }
  o_frag = vec4(saturate(sum / max(wsum, 1.0e-4)), 0.0, 0.0, 1.0);
}
`;

/**
 * Joint-bilateral upsample from the half-res AO to full resolution.
 * @type {string}
 */
const UPSAMPLE_FS = `
#include <frame>
#include <math>
#include <depth>

in vec2 v_uv;
layout(location = 0) out vec4 o_frag;

uniform sampler2D u_aoTex;
uniform sampler2D u_gDepth;
/** Half-res target: x = width, y = height, z = 1/width, w = 1/height. */
uniform vec4 u_aoTarget;
uniform float u_depthSigma;

const float AO_SKY_DEPTH = 0.9999995;

void main() {
  float rawD = textureLod(u_gDepth, v_uv, 0.0).r;
  if (rawD >= AO_SKY_DEPTH) { o_frag = vec4(1.0); return; }
  float centerDepth = linearizeDepth(rawD);
  float sigma = max(u_depthSigma * centerDepth, 0.02);

  vec2 coord = v_uv * u_aoTarget.xy - 0.5;
  vec2 base = floor(coord);
  vec2 f = coord - base;
  vec2 lo = u_aoTarget.zw * 0.5;
  vec2 hi = vec2(1.0) - lo;

  float sum = 0.0;
  float wsum = 0.0;
  for (int j = 0; j < 2; ++j) {
    for (int i = 0; i < 2; ++i) {
      vec2 tc = (base + vec2(float(i), float(j)) + 0.5) * u_aoTarget.zw;
      tc = clamp(tc, lo, hi);
      float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
      float d = linearizeDepth(textureLod(u_gDepth, tc, 0.0).r);
      float w = bw * exp(-abs(d - centerDepth) / sigma) + 1.0e-4;
      sum += textureLod(u_aoTex, tc, 0.0).r * w;
      wsum += w;
    }
  }
  o_frag = vec4(saturate(sum / max(wsum, 1.0e-5)), 0.0, 0.0, 1.0);
}
`;

/* ------------------------------------------------------------------------- */
/* SSAO                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Screen-space ambient occlusion pass.
 *
 * Usage:
 * ```js
 * const ssao = new SSAO(gl, settings);
 * ssao.resize(width, height);
 * ssao.render(gbuffer, frame);           // leaves the result in ssao.texture
 * program.setTexture('u_ssao', ssao.texture, 9);
 * ```
 */
export class SSAO {
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

    /** @type {number} Full-resolution width. */
    this.width = Math.max(1, this.gl.drawingBufferWidth || 1);
    /** @type {number} Full-resolution height. */
    this.height = Math.max(1, this.gl.drawingBufferHeight || 1);
    /** @type {number} Half-resolution width. */
    this.halfWidth = Math.max(1, Math.ceil(this.width / 2));
    /** @type {number} Half-resolution height. */
    this.halfHeight = Math.max(1, Math.ceil(this.height / 2));

    /* ---- tunables -------------------------------------------------------- */

    /** @type {number} World-space occlusion radius, in blocks. */
    this.radius = 0.9;
    /** @type {number} 0 disables the effect, 1 is physical, >1 exaggerates. */
    this.intensity = 1.0;
    /** @type {number} Thin-occluder compensation, 0..1. */
    this.thinOccluder = 0.25;
    /** @type {number} Upper bound of the screen-space radius, in half-res pixels. */
    this.maxRadiusPixels = 64;
    /** @type {number} Bilateral depth tolerance, relative to the linear depth. */
    this.depthSigma = 0.02;

    /* ---- GPU resources --------------------------------------------------- */

    /** @type {?WebGLTexture} Full-resolution AO result (bind to unit 9). */
    this.texture = null;
    /** @type {?WebGLTexture} Half-resolution ping target. @private */
    this._aoA = null;
    /** @type {?WebGLTexture} Half-resolution pong target. @private */
    this._aoB = null;
    this._fboA = null;
    this._fboB = null;
    this._fboFull = null;

    /** @type {?Object} GTAO program. @private */
    this._gtaoProgram = null;
    /** @type {?Object} Bilateral blur program. @private */
    this._blurProgram = null;
    /** @type {?Object} Bilateral upsample program. @private */
    this._upsampleProgram = null;

    /** @type {?WebGLTexture} Blue-noise mask supplied by the TextureManager. */
    this.blueNoise = null;
    /** @type {?WebGLTexture} Internally generated fallback mask. @private */
    this._fallbackNoise = null;
    /** @type {number} Edge size of the mask currently in use. @private */
    this._noiseSize = 64;

    /** @type {string} Active quality step. */
    this.quality = this._resolveQuality(this._setting('ssaoQuality', 'high'));
    /** @type {boolean} Mirrors `settings.ssao`. */
    this.enabled = this._setting('ssao', true) !== false;

    /* ---- scratch --------------------------------------------------------- */

    this._aoTargetVec = new Float32Array(4);
    this._paramsVec = new Float32Array(4);
    this._noiseOffset = new Float32Array(2);
    this._blurDir = new Float32Array(2);
    /** @type {number} Internal frame counter used when the frame has no index. */
    this._frameCounter = 0;
    /** @type {boolean} True while `this.texture` already holds a pure-white AO. */
    this._whiteValid = false;
    /** @type {boolean} */
    this._failed = false;
    /** @type {boolean} */
    this._disposed = false;

    this._onSettingsChange = (key) => this._handleSettingChange(key);
    if (this.settings && typeof this.settings.on === 'function') {
      this.settings.on('change', this._onSettingsChange);
    }

    this._createTargets();
    this._buildPrograms();
  }

  /* ----------------------------------------------------------------------- */
  /* Settings plumbing                                                        */
  /* ----------------------------------------------------------------------- */

  /**
   * Read a setting, tolerating a missing store or an unknown key.
   * @param {string} key setting key
   * @param {*} fallback default value
   * @returns {*} value or `fallback`
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
   * Normalize an arbitrary quality value onto a known step.
   * @param {*} value requested quality
   * @returns {string} one of `low` | `medium` | `high` | `ultra`
   * @private
   */
  _resolveQuality(value) {
    const key = String(value || 'high').toLowerCase();
    return SSAO_QUALITY[key] ? key : 'high';
  }

  /**
   * React to a settings change.
   * @param {string} key changed key
   * @returns {void}
   * @private
   */
  _handleSettingChange(key) {
    if (this._disposed) return;
    if (key === 'ssao') {
      const next = this._setting('ssao', true) !== false;
      if (next !== this.enabled) {
        this.enabled = next;
        this._whiteValid = false;
      }
      return;
    }
    if (key === 'ssaoQuality') {
      const next = this._resolveQuality(this._setting('ssaoQuality', 'high'));
      if (next !== this.quality) {
        this.quality = next;
        this._buildPrograms();
      }
    }
  }

  /* ----------------------------------------------------------------------- */
  /* GPU resources                                                            */
  /* ----------------------------------------------------------------------- */

  /**
   * Allocate the half-res ping/pong pair and the full-res result.
   * @returns {boolean} true when every target is usable
   * @private
   */
  _createTargets() {
    const gl = this.gl;
    this._destroyTargets();
    try {
      const make = (w, h, name) => this.device.createTexture({
        target: gl.TEXTURE_2D,
        width: w,
        height: h,
        internalFormat: gl.R8,
        min: 'linear',
        mag: 'linear',
        wrap: 'clamp',
        mips: false,
        name,
      });
      this._aoA = make(this.halfWidth, this.halfHeight, 'ssao-half-a');
      this._aoB = make(this.halfWidth, this.halfHeight, 'ssao-half-b');
      this.texture = make(this.width, this.height, 'ssao-full');

      this._fboA = this.device.createFramebuffer({ name: 'ssao-half-a', color: [this._aoA] });
      this._fboB = this.device.createFramebuffer({ name: 'ssao-half-b', color: [this._aoB] });
      this._fboFull = this.device.createFramebuffer({ name: 'ssao-full', color: [this.texture] });

      if (!this._fboA.complete || !this._fboB.complete || !this._fboFull.complete) {
        this._reportFailure('one of the SSAO framebuffers is incomplete');
        return false;
      }
      this._whiteValid = false;
      this._clearWhite();
      return true;
    } catch (err) {
      this._reportFailure(err);
      return false;
    }
  }

  /**
   * Delete every render target.
   * @returns {void}
   * @private
   */
  _destroyTargets() {
    for (const fbo of [this._fboA, this._fboB, this._fboFull]) {
      if (fbo) { try { fbo.dispose(); } catch (err) { /* already gone */ } }
    }
    this._fboA = this._fboB = this._fboFull = null;
    for (const tex of [this._aoA, this._aoB, this.texture]) {
      if (tex) { try { this.device.deleteTexture(tex); } catch (err) { /* already gone */ } }
    }
    this._aoA = null;
    this._aoB = null;
    this.texture = null;
  }

  /**
   * Compile (or recompile) the three programs for the active quality step.
   * @returns {boolean} true when every program linked
   * @private
   */
  _buildPrograms() {
    const q = SSAO_QUALITY[this.quality] || SSAO_QUALITY.high;
    this._disposePrograms();
    try {
      this._gtaoProgram = this.device.createProgram('ssao-gtao', FULLSCREEN_VS, GTAO_FS, {
        defines: { AO_DIRECTIONS: q.directions, AO_STEPS: q.steps },
      });
      this._blurProgram = this.device.createProgram('ssao-blur', FULLSCREEN_VS, BLUR_FS, {
        defines: { BLUR_RADIUS: q.blur },
      });
      this._upsampleProgram = this.device.createProgram('ssao-upsample', FULLSCREEN_VS, UPSAMPLE_FS, {});

      const programs = [this._gtaoProgram, this._blurProgram, this._upsampleProgram];
      const ok = this.device.flushPrograms(programs);
      for (const program of programs) program.bindUBO('Frame', 0);
      if (ok !== programs.length) {
        this._reportFailure('an SSAO shader failed to compile');
        return false;
      }
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
    for (const program of [this._gtaoProgram, this._blurProgram, this._upsampleProgram]) {
      if (program && typeof program.dispose === 'function') {
        try { program.dispose(); } catch (err) { /* already gone */ }
      }
    }
    this._gtaoProgram = null;
    this._blurProgram = null;
    this._upsampleProgram = null;
  }

  /**
   * Log a failure once and fall back to "no occlusion".
   * @param {*} err error or message
   * @returns {void}
   * @private
   */
  _reportFailure(err) {
    if (this._failed) return;
    this._failed = true;
    console.error('[ssao] disabled after a failure:', err);
  }

  /* ----------------------------------------------------------------------- */
  /* Public API                                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * Supply the shared blue-noise mask (unit 11) generated by the
   * `TextureManager`. When it is never set, an internally generated fallback is
   * used so the pass keeps working.
   * @param {?WebGLTexture} texture 2D R8 blue-noise texture, wrap = REPEAT
   * @param {number} [size=64] edge size of the mask in texels
   * @returns {void}
   */
  setBlueNoise(texture, size) {
    this.blueNoise = texture || null;
    if (texture) this._noiseSize = noiseSizeOf(texture, size);
  }

  /**
   * Reallocate every target for a new full-resolution size.
   * @param {number} w full-resolution width in pixels
   * @param {number} h full-resolution height in pixels
   * @returns {boolean} true when the targets are usable afterwards
   */
  resize(w, h) {
    if (this._disposed) return false;
    const nw = Math.max(1, w | 0);
    const nh = Math.max(1, h | 0);
    if (nw === this.width && nh === this.height && this.texture) return true;
    this.width = nw;
    this.height = nh;
    this.halfWidth = Math.max(1, Math.ceil(nw / 2));
    this.halfHeight = Math.max(1, Math.ceil(nh / 2));
    this._failed = false;

    // Reallocating in place keeps the texture *handles* alive, so a consumer
    // that cached `ssao.texture` (or bound it once to unit 9) stays valid.
    if (this._fboA && this._fboB && this._fboFull && this.texture) {
      try {
        this._fboA.resize(this.halfWidth, this.halfHeight);
        this._fboB.resize(this.halfWidth, this.halfHeight);
        this._fboFull.resize(nw, nh);
        if (this._fboA.complete && this._fboB.complete && this._fboFull.complete) {
          this._whiteValid = false;
          this._clearWhite();
          return true;
        }
      } catch (err) {
        console.warn('[ssao] in-place resize failed, rebuilding targets:', err);
      }
    }
    return this._createTargets();
  }

  /**
   * Compute ambient occlusion for the current frame.
   *
   * Reads the G-buffer normal (unit 4), the G-buffer depth (unit 7) and the
   * blue-noise mask (unit 11); leaves the full-resolution result in
   * {@link SSAO#texture}. Never throws.
   *
   * @param {{targets?:WebGLTexture[], depth?:WebGLTexture, normal?:WebGLTexture,
   *          framebuffer?:Object}} gbuffer the G-buffer (spec 5.17)
   * @param {{frameIndex?:number}} [frame] the render frame
   * @returns {?WebGLTexture} {@link SSAO#texture}
   */
  render(gbuffer, frame) {
    if (this._disposed) return this.texture;

    this.enabled = this._setting('ssao', true) !== false;
    if (!this.enabled || this._failed || !this.texture) {
      this._clearWhite();
      return this.texture;
    }

    const depthTex = resolveDepthTexture(gbuffer);
    const normalTex = resolveNormalTexture(gbuffer);
    if (!depthTex || !normalTex) {
      this._clearWhite();
      return this.texture;
    }
    const noiseTex = this._resolveNoise(frame, gbuffer);
    if (!noiseTex) {
      this._clearWhite();
      return this.texture;
    }
    if (!this._gtaoProgram || !this._blurProgram || !this._upsampleProgram) {
      this._clearWhite();
      return this.texture;
    }

    const device = this.device;
    const gl = this.gl;
    const arrayTarget = gl.TEXTURE_2D;

    try {
      // ---- per-frame noise animation -------------------------------------
      const taa = this._setting('taa', true) !== false;
      let index = frame && Number.isFinite(frame.frameIndex) ? frame.frameIndex | 0 : this._frameCounter;
      this._frameCounter = (this._frameCounter + 1) & 0x3fffffff;
      if (!taa) index = 0;
      const cycle = ((index % 64) + 64) % 64;
      this._noiseOffset[0] = Math.floor(fract(cycle * R2_A1) * this._noiseSize);
      this._noiseOffset[1] = Math.floor(fract(cycle * R2_A2) * this._noiseSize);
      const temporalRot = fract(cycle * GOLDEN);

      this._aoTargetVec[0] = this.halfWidth;
      this._aoTargetVec[1] = this.halfHeight;
      this._aoTargetVec[2] = 1 / this.halfWidth;
      this._aoTargetVec[3] = 1 / this.halfHeight;

      this._paramsVec[0] = Math.max(this.radius, 0.01);
      this._paramsVec[1] = clamp(this.intensity, 0, 4);
      this._paramsVec[2] = clamp(this.thinOccluder, 0, 1);
      this._paramsVec[3] = clamp(this.maxRadiusPixels, 2, 512);

      // ---- shared fullscreen state ----------------------------------------
      device.setScissor(false);
      device.setDepthTest(false);
      device.setDepthWrite(false);
      device.setBlend('none');
      device.setCull('none');
      device.setColorMask(true, true, true, true);

      // ---- 1. GTAO (half res, aoA) ----------------------------------------
      const gtao = this._gtaoProgram;
      device.bindFramebuffer(this._fboA);
      if (gtao.use()) {
        gtao.setTexture('u_gDepth', depthTex, GDEPTH_UNIT, arrayTarget);
        gtao.setTexture('u_gNormal', normalTex, GNORMAL_UNIT, arrayTarget);
        gtao.setTexture('u_blueNoise', noiseTex, BLUE_NOISE_UNIT, arrayTarget);
        gtao.setVec4('u_aoTarget', this._aoTargetVec);
        gtao.setVec4('u_aoParams', this._paramsVec);
        gtao.setVec2('u_noiseOffset', this._noiseOffset);
        gtao.setFloat('u_temporalRot', temporalRot);
        gtao.setFloat('u_noiseSize', this._noiseSize);
        device.drawFullscreen();
      }

      // ---- 2. bilateral blur, horizontal (aoA -> aoB) ----------------------
      const blur = this._blurProgram;
      if (blur.use()) {
        blur.setTexture('u_gDepth', depthTex, GDEPTH_UNIT, arrayTarget);
        blur.setFloat('u_depthSigma', Math.max(this.depthSigma, 1e-4));

        device.bindFramebuffer(this._fboB);
        blur.setTexture('u_aoTex', this._aoA, SSAO_SCRATCH_UNIT, arrayTarget);
        this._blurDir[0] = 1 / this.halfWidth;
        this._blurDir[1] = 0;
        blur.setVec2('u_blurDir', this._blurDir);
        device.drawFullscreen();

        // ---- 3. bilateral blur, vertical (aoB -> aoA) ----------------------
        device.bindFramebuffer(this._fboA);
        blur.setTexture('u_aoTex', this._aoB, SSAO_SCRATCH_UNIT, arrayTarget);
        this._blurDir[0] = 0;
        this._blurDir[1] = 1 / this.halfHeight;
        blur.setVec2('u_blurDir', this._blurDir);
        device.drawFullscreen();
      }

      // ---- 4. bilateral upsample (aoA -> full res) -------------------------
      const up = this._upsampleProgram;
      device.bindFramebuffer(this._fboFull);
      if (up.use()) {
        up.setTexture('u_aoTex', this._aoA, SSAO_SCRATCH_UNIT, arrayTarget);
        up.setTexture('u_gDepth', depthTex, GDEPTH_UNIT, arrayTarget);
        up.setVec4('u_aoTarget', this._aoTargetVec);
        up.setFloat('u_depthSigma', Math.max(this.depthSigma, 1e-4));
        device.drawFullscreen();
      }

      device.bindFramebuffer(null);
      this._whiteValid = false;
    } catch (err) {
      this._reportFailure(err);
      this._clearWhite();
    }
    return this.texture;
  }

  /**
   * Bind the AO result to its fixed unit on a program.
   * @param {{setTexture:function(string, WebGLTexture, number, number=):void}} program target program
   * @returns {void}
   */
  bind(program) {
    if (!program || typeof program.setTexture !== 'function' || !this.texture) return;
    program.setTexture('u_ssao', this.texture, SSAO_TEXTURE_UNIT, this.gl.TEXTURE_2D);
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
    if (this._fallbackNoise) {
      try { this.device.deleteTexture(this._fallbackNoise); } catch (err) { /* ignore */ }
      this._fallbackNoise = null;
    }
    this.blueNoise = null;
  }

  /* ----------------------------------------------------------------------- */
  /* Internals                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * Fill the full-resolution result with 1.0 ("no occlusion") exactly once, so
   * a disabled or failed SSAO still hands the lighting pass a valid unit 9.
   * @returns {void}
   * @private
   */
  _clearWhite() {
    if (this._whiteValid || !this._fboFull || !this.texture) return;
    try {
      this.device.setScissor(false);
      this.device.bindFramebuffer(this._fboFull);
      this.device.clear([1, 1, 1, 1]);
      this.device.bindFramebuffer(null);
      this._whiteValid = true;
    } catch (err) {
      /* never throw during a frame */
    }
  }

  /**
   * Find the blue-noise mask: explicitly injected, carried by the frame or the
   * G-buffer, or the internally generated fallback.
   * @param {Object} frame render frame
   * @param {Object} gbuffer G-buffer
   * @returns {?WebGLTexture} a usable noise texture
   * @private
   */
  _resolveNoise(frame, gbuffer) {
    if (this.blueNoise) return this.blueNoise;
    const candidates = [
      frame && frame.blueNoise,
      frame && frame.textures && frame.textures.blueNoise,
      gbuffer && gbuffer.blueNoise,
      gbuffer && gbuffer.textures && gbuffer.textures.blueNoise,
    ];
    for (const candidate of candidates) {
      if (candidate) {
        this.blueNoise = candidate;
        this._noiseSize = noiseSizeOf(candidate);
        return candidate;
      }
    }
    if (!this._fallbackNoise) this._fallbackNoise = this._createFallbackNoise();
    if (this._fallbackNoise) this._noiseSize = FALLBACK_NOISE_SIZE;
    return this._fallbackNoise;
  }

  /**
   * Generate a small void-and-cluster blue-noise mask on the CPU. Used only
   * when nothing supplied the shared mask; no external asset is involved.
   * @returns {?WebGLTexture} R8 texture with REPEAT wrapping
   * @private
   */
  _createFallbackNoise() {
    const gl = this.gl;
    try {
      const data = buildVoidAndClusterNoise(FALLBACK_NOISE_SIZE);
      return this.device.createTexture({
        target: gl.TEXTURE_2D,
        width: FALLBACK_NOISE_SIZE,
        height: FALLBACK_NOISE_SIZE,
        internalFormat: gl.R8,
        data,
        min: 'nearest',
        mag: 'nearest',
        wrap: 'repeat',
        mips: false,
      });
    } catch (err) {
      console.warn('[ssao] fallback blue noise generation failed:', err);
      return null;
    }
  }

  /**
   * Human readable snapshot for the F3 overlay.
   * @returns {{enabled:boolean, quality:string, directions:number, steps:number,
   *            width:number, height:number, halfWidth:number, halfHeight:number,
   *            radius:number, usingFallbackNoise:boolean}} stats
   */
  getStats() {
    const q = SSAO_QUALITY[this.quality] || SSAO_QUALITY.high;
    return {
      enabled: this.enabled && !this._failed,
      quality: this.quality,
      directions: q.directions,
      steps: q.steps,
      width: this.width,
      height: this.height,
      halfWidth: this.halfWidth,
      halfHeight: this.halfHeight,
      radius: this.radius,
      usingFallbackNoise: !!this._fallbackNoise && this.blueNoise === null,
    };
  }
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Fractional part, matching GLSL `fract` for non-negative inputs.
 * @param {number} x value
 * @returns {number} `x - floor(x)`
 */
function fract(x) {
  return x - Math.floor(x);
}

/**
 * Edge size of a noise texture: the explicit hint, the `__vox` descriptor that
 * `GL#createTexture` attaches, or 64 (the shared mask's size).
 * @param {?WebGLTexture} texture noise texture
 * @param {number} [hint] caller-supplied size
 * @returns {number} edge size in texels
 */
function noiseSizeOf(texture, hint) {
  if (Number.isFinite(hint) && hint > 0) return Math.max(1, hint | 0);
  const meta = texture && texture.__vox;
  if (meta && Number.isFinite(meta.width) && meta.width > 0) return Math.max(1, meta.width | 0);
  return 64;
}

/**
 * Locate the G-buffer depth texture without importing `render/gbuffer.js`.
 * @param {Object} gbuffer G-buffer-like object
 * @returns {?WebGLTexture} depth texture
 */
function resolveDepthTexture(gbuffer) {
  if (!gbuffer) return null;
  if (gbuffer.depth) return gbuffer.depth;
  if (gbuffer.depthTexture) return gbuffer.depthTexture;
  if (gbuffer.framebuffer && gbuffer.framebuffer.depth) return gbuffer.framebuffer.depth;
  return null;
}

/**
 * Locate the G-buffer normal texture (RT1, ARCHITECTURE.md 3.2).
 * @param {Object} gbuffer G-buffer-like object
 * @returns {?WebGLTexture} normal texture
 */
function resolveNormalTexture(gbuffer) {
  if (!gbuffer) return null;
  if (Array.isArray(gbuffer.targets) && gbuffer.targets[1]) return gbuffer.targets[1];
  if (gbuffer.normal) return gbuffer.normal;
  const fb = gbuffer.framebuffer;
  if (fb && Array.isArray(fb.color) && fb.color[1]) return fb.color[1];
  return null;
}

/**
 * Build a blue-noise mask with Ulichney's void-and-cluster method.
 *
 * The algorithm keeps a Gaussian "energy" field over a toroidal grid: adding a
 * point splats the kernel, removing one subtracts it. Repeatedly moving the
 * point sitting in the *tightest cluster* into the *largest void* converges on a
 * pattern whose points are as evenly spread as possible; ranking every pixel by
 * the order in which it joins that pattern turns it into a threshold mask whose
 * spectrum is blue (no low-frequency clumping), which is exactly what a
 * temporally accumulated sampler wants.
 *
 * @param {number} size edge size (must be small — this is O(n²))
 * @returns {Uint8Array} `size * size` bytes, one channel
 */
function buildVoidAndClusterNoise(size) {
  const n = size * size;
  const sigma = 1.9;
  const twoSigmaSq = 2 * sigma * sigma;
  const r = Math.min(size >> 1, 6);
  const k = 2 * r + 1;

  const kernel = new Float32Array(k * k);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      kernel[(dy + r) * k + (dx + r)] = Math.exp(-(dx * dx + dy * dy) / twoSigmaSq);
    }
  }

  const energy = new Float32Array(n);
  const binary = new Uint8Array(n);
  const rank = new Int32Array(n).fill(-1);

  const splat = (idx, sign) => {
    const px = idx % size;
    const py = (idx / size) | 0;
    for (let dy = -r; dy <= r; dy++) {
      const y = (py + dy + size) % size;
      const rowK = (dy + r) * k;
      const rowE = y * size;
      for (let dx = -r; dx <= r; dx++) {
        const x = (px + dx + size) % size;
        energy[rowE + x] += sign * kernel[rowK + (dx + r)];
      }
    }
  };

  const tightestCluster = () => {
    let best = -1;
    let bestE = -Infinity;
    for (let i = 0; i < n; i++) {
      if (binary[i] === 1 && energy[i] > bestE) { bestE = energy[i]; best = i; }
    }
    return best;
  };

  const largestVoid = () => {
    let best = -1;
    let bestE = Infinity;
    for (let i = 0; i < n; i++) {
      if (binary[i] === 0 && energy[i] < bestE) { bestE = energy[i]; best = i; }
    }
    return best;
  };

  // Deterministic xorshift32 seed pattern (~10% coverage).
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= (seed << 13); seed >>>= 0;
    seed ^= (seed >>> 17);
    seed ^= (seed << 5); seed >>>= 0;
    return seed / 4294967296;
  };
  const initialCount = Math.max(1, Math.round(n * 0.1));
  let ones = 0;
  let guard = n * 32;
  while (ones < initialCount && guard-- > 0) {
    const idx = Math.min(n - 1, Math.floor(rnd() * n));
    if (binary[idx]) continue;
    binary[idx] = 1;
    splat(idx, 1);
    ones++;
  }

  // Relax the seed pattern until cluster and void coincide.
  for (let iter = 0; iter < n; iter++) {
    const cluster = tightestCluster();
    if (cluster < 0) break;
    binary[cluster] = 0;
    splat(cluster, -1);
    const target = largestVoid();
    if (target < 0 || target === cluster) {
      binary[cluster] = 1;
      splat(cluster, 1);
      break;
    }
    binary[target] = 1;
    splat(target, 1);
  }

  const seedPattern = binary.slice();
  const seedEnergy = energy.slice();

  // Phase 1 — rank the seed pattern downwards by removing tightest clusters.
  let count = ones;
  while (count > 0) {
    const cluster = tightestCluster();
    if (cluster < 0) break;
    binary[cluster] = 0;
    splat(cluster, -1);
    count--;
    rank[cluster] = count;
  }

  // Phase 2 — restore, then fill the remaining ranks into the largest voids.
  binary.set(seedPattern);
  energy.set(seedEnergy);
  count = ones;
  while (count < n) {
    const target = largestVoid();
    if (target < 0) break;
    binary[target] = 1;
    splat(target, 1);
    rank[target] = count;
    count++;
  }

  const out = new Uint8Array(n);
  const scale = 256 / n;
  for (let i = 0; i < n; i++) {
    const rk = rank[i] < 0 ? 0 : rank[i];
    out[i] = Math.min(255, Math.floor((rk + 0.5) * scale));
  }
  return out;
}

export default SSAO;
