/**
 * @file core/math.js — VOXELIA math library (spec 5.2).
 *
 * Conventions (binding):
 *  - Right handed, **Y up**, `+X` east, `+Z` south.
 *  - Matrices are **column-major** `Float32Array(16)`, directly compatible with
 *    `gl.uniformMatrix4fv(loc, false, m)` — identical to the gl-matrix layout:
 *    `m[col * 4 + row]`.
 *  - Every function that *produces* a vector/matrix/quaternion takes an explicit
 *    `out` as its first parameter (gl-matrix style `add(out, a, b)`) and returns
 *    `out`. Scalar-returning helpers (`dot`, `len`, `dist`, ...) and
 *    `create`/`fromValues` are the only exceptions.
 *  - Nothing here allocates in a hot path: all temporaries are scalars or the
 *    module-level scratch buffers declared at the bottom of the file.
 *  - No DOM access whatsoever — safe to import inside a Web Worker.
 */

/** Degrees -> radians multiplier. @type {number} */
export const DEG2RAD = Math.PI / 180;

/** Radians -> degrees multiplier. @type {number} */
export const RAD2DEG = 180 / Math.PI;

/** Comparison epsilon used by `mat4.equals` and degenerate-basis guards. @type {number} */
export const EPSILON = 1e-6;

/**
 * Clamp `v` into the inclusive range `[a, b]`.
 * @param {number} v Value to clamp.
 * @param {number} a Lower bound.
 * @param {number} b Upper bound.
 * @returns {number} The clamped value.
 */
export function clamp(v, a, b) {
  return v < a ? a : (v > b ? b : v);
}

/**
 * Linear interpolation between two scalars.
 * @param {number} a Value at `t = 0`.
 * @param {number} b Value at `t = 1`.
 * @param {number} t Interpolation factor (not clamped).
 * @returns {number} `a + (b - a) * t`.
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Hermite smoothstep. Returns 0 below `e0`, 1 above `e1`, smooth in between.
 * @param {number} e0 Lower edge.
 * @param {number} e1 Upper edge.
 * @param {number} x Sample position.
 * @returns {number} Smoothed value in `[0, 1]`.
 */
export function smoothstep(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing (Lerp Smoothing done right).
 * Equivalent to `lerp(current, target, 1 - exp(-lambda * dt))`, so the result
 * does not depend on the frame rate. Higher `lambda` = snappier.
 * @param {number} current Current value.
 * @param {number} target Target value.
 * @param {number} lambda Smoothing rate (1/seconds). `0` freezes the value.
 * @param {number} dt Elapsed time in seconds.
 * @returns {number} The smoothed value.
 */
export function damp(current, target, lambda, dt) {
  if (lambda <= 0 || dt <= 0) return current;
  return target + (current - target) * Math.exp(-lambda * dt);
}

/**
 * Mulberry32 — small, fast, well-distributed seeded PRNG.
 * @param {number} seed 32-bit integer seed (any number; coerced with `|0`).
 * @returns {() => number} Generator producing floats in `[0, 1)`.
 */
export function mulberry32(seed) {
  let a = seed | 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const XXH_PRIME2 = 2246822519;
const XXH_PRIME3 = 3266489917;
const XXH_PRIME4 = 668265263;
const XXH_PRIME5 = 374761393;

/**
 * XXHash32 over the three 32-bit integer coordinates `(x, y, z)`.
 * Deterministic, avalanche-quality hash used for voxel/coordinate hashing
 * (ore placement, structure jitter, per-block randomness). Allocation-free.
 * @param {number} x Integer coordinate (truncated with `|0`).
 * @param {number} y Integer coordinate (truncated with `|0`).
 * @param {number} z Integer coordinate (truncated with `|0`).
 * @param {number} [seed=0] Integer seed.
 * @returns {number} Unsigned 32-bit hash in `[0, 4294967295]`.
 */
export function xxhash32(x, y, z, seed = 0) {
  let h = ((seed | 0) + XXH_PRIME5 + 12) | 0;
  h = (h + Math.imul(x | 0, XXH_PRIME3)) | 0;
  h = Math.imul((h << 17) | (h >>> 15), XXH_PRIME4);
  h = (h + Math.imul(y | 0, XXH_PRIME3)) | 0;
  h = Math.imul((h << 17) | (h >>> 15), XXH_PRIME4);
  h = (h + Math.imul(z | 0, XXH_PRIME3)) | 0;
  h = Math.imul((h << 17) | (h >>> 15), XXH_PRIME4);
  h ^= h >>> 15;
  h = Math.imul(h, XXH_PRIME2);
  h ^= h >>> 13;
  h = Math.imul(h, XXH_PRIME3);
  h ^= h >>> 16;
  return h >>> 0;
}

/* ------------------------------------------------------------------------- */
/* vec3                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * 3-component vector helpers. Vectors are `Float32Array(3)` or any indexable
 * array-like of length 3.
 * @namespace vec3
 */
export const vec3 = {
  /**
   * Allocate a zeroed vector.
   * @returns {Float32Array} New `Float32Array(3)`.
   */
  create() {
    return new Float32Array(3);
  },

  /**
   * Allocate a vector from three components.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @param {number} z Z component.
   * @returns {Float32Array} New `Float32Array(3)`.
   */
  fromValues(x, y, z) {
    const out = new Float32Array(3);
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  },

  /**
   * Set the components of `out`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @param {number} z Z component.
   * @returns {Float32Array|number[]} `out`.
   */
  set(out, x, y, z) {
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  },

  /**
   * Copy `a` into `out`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source.
   * @returns {Float32Array|number[]} `out`.
   */
  copy(out, a) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    return out;
  },

  /**
   * Component-wise addition.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array|number[]} `out`.
   */
  add(out, a, b) {
    out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
    return out;
  },

  /**
   * Component-wise subtraction (`a - b`).
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array|number[]} `out`.
   */
  sub(out, a, b) {
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
    return out;
  },

  /**
   * Component-wise multiplication (Hadamard product).
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array|number[]} `out`.
   */
  mul(out, a, b) {
    out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2];
    return out;
  },

  /**
   * Multiply a vector by a scalar.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source vector.
   * @param {number} s Scalar factor.
   * @returns {Float32Array|number[]} `out`.
   */
  scale(out, a, s) {
    out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
    return out;
  },

  /**
   * Fused multiply-add: `out = a + b * s`. Handy in ray marching / integration.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Base vector.
   * @param {ArrayLike<number>} b Vector to scale and add.
   * @param {number} s Scalar factor applied to `b`.
   * @returns {Float32Array|number[]} `out`.
   */
  scaleAndAdd(out, a, b, s) {
    out[0] = a[0] + b[0] * s;
    out[1] = a[1] + b[1] * s;
    out[2] = a[2] + b[2] * s;
    return out;
  },

  /**
   * Dot product.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {number} `a . b`.
   */
  dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  },

  /**
   * Cross product (`a x b`). Safe when `out` aliases `a` or `b`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array|number[]} `out`.
   */
  cross(out, a, b) {
    const ax = a[0], ay = a[1], az = a[2];
    const bx = b[0], by = b[1], bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
  },

  /**
   * Euclidean length.
   * @param {ArrayLike<number>} a Vector.
   * @returns {number} `|a|`.
   */
  len(a) {
    return Math.hypot(a[0], a[1], a[2]);
  },

  /**
   * Squared length (no square root).
   * @param {ArrayLike<number>} a Vector.
   * @returns {number} `|a|^2`.
   */
  lenSq(a) {
    return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
  },

  /**
   * Normalize to unit length. A zero-length input yields `(0, 0, 0)`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source vector.
   * @returns {Float32Array|number[]} `out`.
   */
  normalize(out, a) {
    const x = a[0], y = a[1], z = a[2];
    let l = x * x + y * y + z * z;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      out[0] = x * l; out[1] = y * l; out[2] = z * l;
    } else {
      out[0] = 0; out[1] = 0; out[2] = 0;
    }
    return out;
  },

  /**
   * Component-wise linear interpolation.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Value at `t = 0`.
   * @param {ArrayLike<number>} b Value at `t = 1`.
   * @param {number} t Interpolation factor (not clamped).
   * @returns {Float32Array|number[]} `out`.
   */
  lerp(out, a, b, t) {
    const ax = a[0], ay = a[1], az = a[2];
    out[0] = ax + (b[0] - ax) * t;
    out[1] = ay + (b[1] - ay) * t;
    out[2] = az + (b[2] - az) * t;
    return out;
  },

  /**
   * Distance between two points.
   * @param {ArrayLike<number>} a First point.
   * @param {ArrayLike<number>} b Second point.
   * @returns {number} `|b - a|`.
   */
  dist(a, b) {
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  },

  /**
   * Squared distance between two points (no square root).
   * @param {ArrayLike<number>} a First point.
   * @param {ArrayLike<number>} b Second point.
   * @returns {number} `|b - a|^2`.
   */
  distSq(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    return dx * dx + dy * dy + dz * dz;
  },

  /**
   * Manhattan (L1, taxicab) distance between two points — the natural metric
   * for chunk/voxel grid distances.
   * @param {ArrayLike<number>} a First point.
   * @param {ArrayLike<number>} b Second point.
   * @returns {number} `|dx| + |dy| + |dz|`.
   */
  manhattan(a, b) {
    return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) + Math.abs(b[2] - a[2]);
  },

  /**
   * Negate all components.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source vector.
   * @returns {Float32Array|number[]} `out`.
   */
  negate(out, a) {
    out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2];
    return out;
  },

  /**
   * Component-wise minimum.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array|number[]} `out`.
   */
  min(out, a, b) {
    out[0] = Math.min(a[0], b[0]);
    out[1] = Math.min(a[1], b[1]);
    out[2] = Math.min(a[2], b[2]);
    return out;
  },

  /**
   * Component-wise maximum.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array|number[]} `out`.
   */
  max(out, a, b) {
    out[0] = Math.max(a[0], b[0]);
    out[1] = Math.max(a[1], b[1]);
    out[2] = Math.max(a[2], b[2]);
    return out;
  },

  /**
   * Component-wise `Math.floor` — block coordinate from a world position.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source vector.
   * @returns {Float32Array|number[]} `out`.
   */
  floor(out, a) {
    out[0] = Math.floor(a[0]);
    out[1] = Math.floor(a[1]);
    out[2] = Math.floor(a[2]);
    return out;
  },

  /**
   * Transform a **point** by a 4x4 matrix, including translation and the
   * perspective divide.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Point to transform.
   * @param {ArrayLike<number>} m Column-major 4x4 matrix.
   * @returns {Float32Array|number[]} `out`.
   */
  transformMat4(out, a, m) {
    const x = a[0], y = a[1], z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w === 0) w = 1;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
  },

  /**
   * Transform a **direction** by the upper-left 3x3 of a 4x4 matrix. Ignores
   * translation and the perspective divide; the result is not renormalized.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Direction to transform.
   * @param {ArrayLike<number>} m Column-major 4x4 matrix.
   * @returns {Float32Array|number[]} `out`.
   */
  transformDir(out, a, m) {
    const x = a[0], y = a[1], z = a[2];
    out[0] = m[0] * x + m[4] * y + m[8] * z;
    out[1] = m[1] * x + m[5] * y + m[9] * z;
    out[2] = m[2] * x + m[6] * y + m[10] * z;
    return out;
  },

  /**
   * Rotate a vector around the world **Y** axis (yaw), optionally around a
   * pivot point. Positive angles turn `+Z` towards `+X`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Vector to rotate.
   * @param {number} rad Angle in radians.
   * @param {ArrayLike<number>|null} [origin=null] Optional pivot; defaults to the origin.
   * @returns {Float32Array|number[]} `out`.
   */
  rotateY(out, a, rad, origin = null) {
    const ox = origin ? origin[0] : 0;
    const oy = origin ? origin[1] : 0;
    const oz = origin ? origin[2] : 0;
    const px = a[0] - ox, py = a[1] - oy, pz = a[2] - oz;
    const c = Math.cos(rad), s = Math.sin(rad);
    out[0] = px * c + pz * s + ox;
    out[1] = py + oy;
    out[2] = pz * c - px * s + oz;
    return out;
  }
};

/* ------------------------------------------------------------------------- */
/* vec4                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * 4-component vector helpers. Vectors are `Float32Array(4)` or any indexable
 * array-like of length 4.
 * @namespace vec4
 */
export const vec4 = {
  /**
   * Allocate a zeroed vector.
   * @returns {Float32Array} New `Float32Array(4)`.
   */
  create() {
    return new Float32Array(4);
  },

  /**
   * Allocate a vector from four components.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @param {number} z Z component.
   * @param {number} w W component.
   * @returns {Float32Array} New `Float32Array(4)`.
   */
  fromValues(x, y, z, w) {
    const out = new Float32Array(4);
    out[0] = x; out[1] = y; out[2] = z; out[3] = w;
    return out;
  },

  /**
   * Set the components of `out`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @param {number} z Z component.
   * @param {number} w W component.
   * @returns {Float32Array|number[]} `out`.
   */
  set(out, x, y, z, w) {
    out[0] = x; out[1] = y; out[2] = z; out[3] = w;
    return out;
  },

  /**
   * Copy `a` into `out`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source.
   * @returns {Float32Array|number[]} `out`.
   */
  copy(out, a) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
    return out;
  },

  /**
   * Component-wise addition.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array|number[]} `out`.
   */
  add(out, a, b) {
    out[0] = a[0] + b[0]; out[1] = a[1] + b[1];
    out[2] = a[2] + b[2]; out[3] = a[3] + b[3];
    return out;
  },

  /**
   * Component-wise subtraction (`a - b`).
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array|number[]} `out`.
   */
  sub(out, a, b) {
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1];
    out[2] = a[2] - b[2]; out[3] = a[3] - b[3];
    return out;
  },

  /**
   * Multiply a vector by a scalar.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source vector.
   * @param {number} s Scalar factor.
   * @returns {Float32Array|number[]} `out`.
   */
  scale(out, a, s) {
    out[0] = a[0] * s; out[1] = a[1] * s;
    out[2] = a[2] * s; out[3] = a[3] * s;
    return out;
  },

  /**
   * Dot product.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {number} `a . b`.
   */
  dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  },

  /**
   * Transform a 4-vector by a column-major 4x4 matrix (no divide).
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Vector to transform.
   * @param {ArrayLike<number>} m Column-major 4x4 matrix.
   * @returns {Float32Array|number[]} `out`.
   */
  transformMat4(out, a, m) {
    const x = a[0], y = a[1], z = a[2], w = a[3];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    return out;
  }
};

/* ------------------------------------------------------------------------- */
/* mat4                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Column-major 4x4 matrix helpers. Matrices are `Float32Array(16)` laid out as
 * `m[col * 4 + row]`, ready for `uniformMatrix4fv(loc, false, m)`.
 * @namespace mat4
 */
export const mat4 = {
  /**
   * Allocate a new identity matrix.
   * @returns {Float32Array} New `Float32Array(16)` set to identity.
   */
  create() {
    const out = new Float32Array(16);
    out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1;
    return out;
  },

  /**
   * Set `out` to the identity matrix.
   * @param {Float32Array|number[]} out Receiver.
   * @returns {Float32Array|number[]} `out`.
   */
  identity(out) {
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  },

  /**
   * Copy `a` into `out`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source matrix.
   * @returns {Float32Array|number[]} `out`.
   */
  copy(out, a) {
    for (let i = 0; i < 16; i++) out[i] = a[i];
    return out;
  },

  /**
   * Matrix product `out = a * b` (apply `b` first, then `a`).
   * Safe when `out` aliases `a` and/or `b`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Left matrix.
   * @param {ArrayLike<number>} b Right matrix.
   * @returns {Float32Array|number[]} `out`.
   */
  multiply(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return out;
  },

  /**
   * Full 4x4 inverse via cofactor expansion (2x2 sub-determinants).
   * On a singular matrix `out` is set to the identity and `null` is returned —
   * callers may keep using `out` safely without a throw during a frame.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Matrix to invert.
   * @returns {Float32Array|number[]|null} `out`, or `null` if `a` is singular.
   */
  invert(out, a) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (det === 0 || !Number.isFinite(det)) {
      mat4.identity(out);
      return null;
    }
    det = 1 / det;

    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  },

  /**
   * Transpose. Safe when `out` aliases `a`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source matrix.
   * @returns {Float32Array|number[]} `out`.
   */
  transpose(out, a) {
    const a01 = a[1], a02 = a[2], a03 = a[3];
    const a12 = a[6], a13 = a[7], a23 = a[11];
    out[0] = a[0];
    out[1] = a[4];
    out[2] = a[8];
    out[3] = a[12];
    out[4] = a01;
    out[5] = a[5];
    out[6] = a[9];
    out[7] = a[13];
    out[8] = a02;
    out[9] = a12;
    out[10] = a[10];
    out[11] = a[14];
    out[12] = a03;
    out[13] = a13;
    out[14] = a23;
    out[15] = a[15];
    return out;
  },

  /**
   * Right-handed perspective projection mapping depth to `[-1, 1]`.
   * Passing `Infinity` (or `null`) as `far` produces the infinite-far variant.
   * @param {Float32Array|number[]} out Receiver.
   * @param {number} fovy Vertical field of view in **radians**.
   * @param {number} aspect Viewport aspect ratio (width / height).
   * @param {number} near Near plane distance (> 0).
   * @param {number} [far=Infinity] Far plane distance, or `Infinity`.
   * @returns {Float32Array|number[]} `out`.
   */
  perspective(out, fovy, aspect, near, far = Infinity) {
    const f = 1 / Math.tan(fovy * 0.5);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[11] = -1;
    out[12] = 0; out[13] = 0; out[15] = 0;
    if (far == null || far === Infinity) {
      out[10] = -1;
      out[14] = -2 * near;
    } else {
      const nf = 1 / (near - far);
      out[10] = (far + near) * nf;
      out[14] = 2 * far * near * nf;
    }
    return out;
  },

  /**
   * Right-handed perspective projection with an **infinite far plane** — the
   * preferred projection for the terrain pass (no far-plane clipping, better
   * depth precision distribution for reversed usage).
   * @param {Float32Array|number[]} out Receiver.
   * @param {number} fovy Vertical field of view in **radians**.
   * @param {number} aspect Viewport aspect ratio (width / height).
   * @param {number} near Near plane distance (> 0).
   * @returns {Float32Array|number[]} `out`.
   */
  perspectiveInfinite(out, fovy, aspect, near) {
    const f = 1 / Math.tan(fovy * 0.5);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = -1; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = -2 * near; out[15] = 0;
    return out;
  },

  /**
   * Right-handed orthographic projection mapping depth to `[-1, 1]`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {number} left Left clip plane.
   * @param {number} right Right clip plane.
   * @param {number} bottom Bottom clip plane.
   * @param {number} top Top clip plane.
   * @param {number} near Near clip plane.
   * @param {number} far Far clip plane.
   * @returns {Float32Array|number[]} `out`.
   */
  ortho(out, left, right, bottom, top, near, far) {
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 2 * nf; out[11] = 0;
    out[12] = (left + right) * lr;
    out[13] = (top + bottom) * bt;
    out[14] = (far + near) * nf;
    out[15] = 1;
    return out;
  },

  /**
   * Build a **view** matrix looking from `eye` towards `center`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} eye Camera position.
   * @param {ArrayLike<number>} center Point to look at.
   * @param {ArrayLike<number>} up World up vector.
   * @returns {Float32Array|number[]} `out`.
   */
  lookAt(out, eye, center, up) {
    const eyex = eye[0], eyey = eye[1], eyez = eye[2];
    const centerx = center[0], centery = center[1], centerz = center[2];
    const upx = up[0], upy = up[1], upz = up[2];

    if (Math.abs(eyex - centerx) < EPSILON &&
        Math.abs(eyey - centery) < EPSILON &&
        Math.abs(eyez - centerz) < EPSILON) {
      return mat4.identity(out);
    }

    let z0 = eyex - centerx, z1 = eyey - centery, z2 = eyez - centerz;
    let l = 1 / Math.hypot(z0, z1, z2);
    z0 *= l; z1 *= l; z2 *= l;

    let x0 = upy * z2 - upz * z1;
    let x1 = upz * z0 - upx * z2;
    let x2 = upx * z1 - upy * z0;
    l = Math.hypot(x0, x1, x2);
    if (l === 0) {
      x0 = 0; x1 = 0; x2 = 0;
    } else {
      l = 1 / l;
      x0 *= l; x1 *= l; x2 *= l;
    }

    let y0 = z1 * x2 - z2 * x1;
    let y1 = z2 * x0 - z0 * x2;
    let y2 = z0 * x1 - z1 * x0;
    l = Math.hypot(y0, y1, y2);
    if (l === 0) {
      y0 = 0; y1 = 0; y2 = 0;
    } else {
      l = 1 / l;
      y0 *= l; y1 *= l; y2 *= l;
    }

    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
    out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
    out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
    out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez);
    out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez);
    out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez);
    out[15] = 1;
    return out;
  },

  /**
   * Build a **world (model) matrix** placing an object at `eye` oriented so that
   * its `-Z` axis points at `target`. This is the inverse of `lookAt` and is what
   * entity/billboard transforms want.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} eye Object position.
   * @param {ArrayLike<number>} target Point to face.
   * @param {ArrayLike<number>} up World up vector.
   * @returns {Float32Array|number[]} `out`.
   */
  targetTo(out, eye, target, up) {
    const eyex = eye[0], eyey = eye[1], eyez = eye[2];
    const upx = up[0], upy = up[1], upz = up[2];

    let z0 = eyex - target[0], z1 = eyey - target[1], z2 = eyez - target[2];
    let l = z0 * z0 + z1 * z1 + z2 * z2;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      z0 *= l; z1 *= l; z2 *= l;
    }

    let x0 = upy * z2 - upz * z1;
    let x1 = upz * z0 - upx * z2;
    let x2 = upx * z1 - upy * z0;
    l = x0 * x0 + x1 * x1 + x2 * x2;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      x0 *= l; x1 *= l; x2 *= l;
    }

    out[0] = x0; out[1] = x1; out[2] = x2; out[3] = 0;
    out[4] = z1 * x2 - z2 * x1;
    out[5] = z2 * x0 - z0 * x2;
    out[6] = z0 * x1 - z1 * x0;
    out[7] = 0;
    out[8] = z0; out[9] = z1; out[10] = z2; out[11] = 0;
    out[12] = eyex; out[13] = eyey; out[14] = eyez; out[15] = 1;
    return out;
  },

  /**
   * Build a pure translation matrix.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} v Translation vector.
   * @returns {Float32Array|number[]} `out`.
   */
  fromTranslation(out, v) {
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1;
    return out;
  },

  /**
   * Build the rotation matrix `Ry(y) * Rx(x)` — the canonical yaw/pitch
   * orientation used for cameras, entities and held items. `x` is pitch about
   * the X axis, `y` is yaw about the Y axis.
   * @param {Float32Array|number[]} out Receiver.
   * @param {number} x Pitch in radians.
   * @param {number} y Yaw in radians.
   * @returns {Float32Array|number[]} `out`.
   */
  fromRotationXY(out, x, y) {
    const sx = Math.sin(x), cx = Math.cos(x);
    const sy = Math.sin(y), cy = Math.cos(y);
    out[0] = cy; out[1] = 0; out[2] = -sy; out[3] = 0;
    out[4] = sy * sx; out[5] = cx; out[6] = cy * sx; out[7] = 0;
    out[8] = sy * cx; out[9] = -sx; out[10] = cy * cx; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  },

  /**
   * Post-multiply by a translation: `out = a * T(v)`. Safe when `out === a`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source matrix.
   * @param {ArrayLike<number>} v Translation vector.
   * @returns {Float32Array|number[]} `out`.
   */
  translate(out, a, v) {
    const x = v[0], y = v[1], z = v[2];
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    out[0] = a00; out[1] = a01; out[2] = a02; out[3] = a03;
    out[4] = a10; out[5] = a11; out[6] = a12; out[7] = a13;
    out[8] = a20; out[9] = a21; out[10] = a22; out[11] = a23;
    out[12] = a00 * x + a10 * y + a20 * z + a[12];
    out[13] = a01 * x + a11 * y + a21 * z + a[13];
    out[14] = a02 * x + a12 * y + a22 * z + a[14];
    out[15] = a03 * x + a13 * y + a23 * z + a[15];
    return out;
  },

  /**
   * Post-multiply by a rotation about X: `out = a * Rx(rad)`. Safe when `out === a`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source matrix.
   * @param {number} rad Angle in radians.
   * @returns {Float32Array|number[]} `out`.
   */
  rotateX(out, a, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    if (out !== a) {
      out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    out[4] = a10 * c + a20 * s;
    out[5] = a11 * c + a21 * s;
    out[6] = a12 * c + a22 * s;
    out[7] = a13 * c + a23 * s;
    out[8] = a20 * c - a10 * s;
    out[9] = a21 * c - a11 * s;
    out[10] = a22 * c - a12 * s;
    out[11] = a23 * c - a13 * s;
    return out;
  },

  /**
   * Post-multiply by a rotation about Y: `out = a * Ry(rad)`. Safe when `out === a`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source matrix.
   * @param {number} rad Angle in radians.
   * @returns {Float32Array|number[]} `out`.
   */
  rotateY(out, a, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    if (out !== a) {
      out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    out[0] = a00 * c - a20 * s;
    out[1] = a01 * c - a21 * s;
    out[2] = a02 * c - a22 * s;
    out[3] = a03 * c - a23 * s;
    out[8] = a00 * s + a20 * c;
    out[9] = a01 * s + a21 * c;
    out[10] = a02 * s + a22 * c;
    out[11] = a03 * s + a23 * c;
    return out;
  },

  /**
   * Post-multiply by a rotation about Z: `out = a * Rz(rad)`. Safe when `out === a`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source matrix.
   * @param {number} rad Angle in radians.
   * @returns {Float32Array|number[]} `out`.
   */
  rotateZ(out, a, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    if (out !== a) {
      out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    out[0] = a00 * c + a10 * s;
    out[1] = a01 * c + a11 * s;
    out[2] = a02 * c + a12 * s;
    out[3] = a03 * c + a13 * s;
    out[4] = a10 * c - a00 * s;
    out[5] = a11 * c - a01 * s;
    out[6] = a12 * c - a02 * s;
    out[7] = a13 * c - a03 * s;
    return out;
  },

  /**
   * Post-multiply by a non-uniform scale: `out = a * S(v)`. Safe when `out === a`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source matrix.
   * @param {ArrayLike<number>} v Scale vector.
   * @returns {Float32Array|number[]} `out`.
   */
  scale(out, a, v) {
    const x = v[0], y = v[1], z = v[2];
    out[0] = a[0] * x; out[1] = a[1] * x; out[2] = a[2] * x; out[3] = a[3] * x;
    out[4] = a[4] * y; out[5] = a[5] * y; out[6] = a[6] * y; out[7] = a[7] * y;
    out[8] = a[8] * z; out[9] = a[9] * z; out[10] = a[10] * z; out[11] = a[11] * z;
    out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    return out;
  },

  /**
   * Extract the translation column of a matrix.
   * @param {Float32Array|number[]} out Receiver `vec3`.
   * @param {ArrayLike<number>} m Source matrix.
   * @returns {Float32Array|number[]} `out`.
   */
  getTranslation(out, m) {
    out[0] = m[12]; out[1] = m[13]; out[2] = m[14];
    return out;
  },

  /**
   * Build a rotation matrix from a quaternion `(x, y, z, w)`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} q Unit quaternion.
   * @returns {Float32Array|number[]} `out`.
   */
  fromQuat(out, q) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, yx = y * x2, yy = y * y2;
    const zx = z * x2, zy = z * y2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = 1 - yy - zz; out[1] = yx + wz; out[2] = zx - wy; out[3] = 0;
    out[4] = yx - wz; out[5] = 1 - xx - zz; out[6] = zy + wx; out[7] = 0;
    out[8] = zx + wy; out[9] = zy - wx; out[10] = 1 - xx - yy; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  },

  /**
   * Decompose an affine transform into translation, rotation and scale.
   * A mirrored (negative determinant) basis reports the sign on `outScale[0]`.
   * Allocation-free (uses a module-level scratch matrix).
   * @param {Float32Array|number[]} outTranslation Receiver `vec3` for the translation.
   * @param {Float32Array|number[]} outRotation Receiver `quat` for the rotation.
   * @param {Float32Array|number[]} outScale Receiver `vec3` for the scale.
   * @param {ArrayLike<number>} m Matrix to decompose.
   * @returns {Float32Array|number[]} `outTranslation`.
   */
  decompose(outTranslation, outRotation, outScale, m) {
    outTranslation[0] = m[12];
    outTranslation[1] = m[13];
    outTranslation[2] = m[14];

    let sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);

    // Determinant of the upper-left 3x3; negative means a mirrored basis.
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) -
      m[4] * (m[1] * m[10] - m[2] * m[9]) +
      m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (det < 0) sx = -sx;

    outScale[0] = sx;
    outScale[1] = sy;
    outScale[2] = sz;

    const isx = sx !== 0 ? 1 / sx : 0;
    const isy = sy !== 0 ? 1 / sy : 0;
    const isz = sz !== 0 ? 1 / sz : 0;

    const r = SCRATCH_M0;
    r[0] = m[0] * isx; r[1] = m[1] * isx; r[2] = m[2] * isx;
    r[4] = m[4] * isy; r[5] = m[5] * isy; r[6] = m[6] * isy;
    r[8] = m[8] * isz; r[9] = m[9] * isz; r[10] = m[10] * isz;

    // Column-major: mRowCol -> r[col * 4 + row].
    const m00 = r[0], m10 = r[1], m20 = r[2];
    const m01 = r[4], m11 = r[5], m21 = r[6];
    const m02 = r[8], m12 = r[9], m22 = r[10];
    const trace = m00 + m11 + m22;

    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      outRotation[3] = 0.25 * s;
      outRotation[0] = (m21 - m12) / s;
      outRotation[1] = (m02 - m20) / s;
      outRotation[2] = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      outRotation[3] = (m21 - m12) / s;
      outRotation[0] = 0.25 * s;
      outRotation[1] = (m01 + m10) / s;
      outRotation[2] = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      outRotation[3] = (m02 - m20) / s;
      outRotation[0] = (m01 + m10) / s;
      outRotation[1] = 0.25 * s;
      outRotation[2] = (m12 + m21) / s;
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      outRotation[3] = (m10 - m01) / s;
      outRotation[0] = (m02 + m20) / s;
      outRotation[1] = (m12 + m21) / s;
      outRotation[2] = 0.25 * s;
    }
    return outTranslation;
  },

  /**
   * Approximate equality with a relative epsilon.
   * @param {ArrayLike<number>} a First matrix.
   * @param {ArrayLike<number>} b Second matrix.
   * @returns {boolean} `true` when every element matches within epsilon.
   */
  equals(a, b) {
    for (let i = 0; i < 16; i++) {
      const av = a[i], bv = b[i];
      if (Math.abs(av - bv) > EPSILON * Math.max(1, Math.abs(av), Math.abs(bv))) return false;
    }
    return true;
  }
};

/* ------------------------------------------------------------------------- */
/* quat                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Quaternion helpers. Quaternions are `Float32Array(4)` laid out `(x, y, z, w)`.
 * @namespace quat
 */
export const quat = {
  /**
   * Allocate a new identity quaternion.
   * @returns {Float32Array} New `Float32Array(4)` set to `(0, 0, 0, 1)`.
   */
  create() {
    const out = new Float32Array(4);
    out[3] = 1;
    return out;
  },

  /**
   * Set `out` to the identity quaternion.
   * @param {Float32Array|number[]} out Receiver.
   * @returns {Float32Array|number[]} `out`.
   */
  identity(out) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    return out;
  },

  /**
   * Build a rotation of `rad` radians about a (not necessarily normalized) axis.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} axis Rotation axis.
   * @param {number} rad Angle in radians.
   * @returns {Float32Array|number[]} `out`.
   */
  setAxisAngle(out, axis, rad) {
    let ax = axis[0], ay = axis[1], az = axis[2];
    let l = ax * ax + ay * ay + az * az;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      ax *= l; ay *= l; az *= l;
    }
    const half = rad * 0.5;
    const s = Math.sin(half);
    out[0] = ax * s; out[1] = ay * s; out[2] = az * s; out[3] = Math.cos(half);
    return out;
  },

  /**
   * Hamilton product `out = a * b` (apply `b` first, then `a`).
   * Safe when `out` aliases `a` and/or `b`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Left quaternion.
   * @param {ArrayLike<number>} b Right quaternion.
   * @returns {Float32Array|number[]} `out`.
   */
  multiply(out, a, b) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = ax * bw + aw * bx + ay * bz - az * by;
    out[1] = ay * bw + aw * by + az * bx - ax * bz;
    out[2] = az * bw + aw * bz + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
  },

  /**
   * Spherical linear interpolation along the shortest arc.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Rotation at `t = 0`.
   * @param {ArrayLike<number>} b Rotation at `t = 1`.
   * @param {number} t Interpolation factor.
   * @returns {Float32Array|number[]} `out`.
   */
  slerp(out, a, b, t) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let cosom = ax * bx + ay * by + az * bz + aw * bw;
    if (cosom < 0) {
      cosom = -cosom;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    let scale0, scale1;
    if (1 - cosom > EPSILON) {
      const omega = Math.acos(cosom);
      const sinom = Math.sin(omega);
      scale0 = Math.sin((1 - t) * omega) / sinom;
      scale1 = Math.sin(t * omega) / sinom;
    } else {
      scale0 = 1 - t;
      scale1 = t;
    }
    out[0] = scale0 * ax + scale1 * bx;
    out[1] = scale0 * ay + scale1 * by;
    out[2] = scale0 * az + scale1 * bz;
    out[3] = scale0 * aw + scale1 * bw;
    return out;
  },

  /**
   * Normalize to unit length. A zero quaternion yields the identity.
   * @param {Float32Array|number[]} out Receiver.
   * @param {ArrayLike<number>} a Source quaternion.
   * @returns {Float32Array|number[]} `out`.
   */
  normalize(out, a) {
    const x = a[0], y = a[1], z = a[2], w = a[3];
    let l = x * x + y * y + z * z + w * w;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      out[0] = x * l; out[1] = y * l; out[2] = z * l; out[3] = w * l;
    } else {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    }
    return out;
  },

  /**
   * Build a quaternion from Euler angles in **radians**, applied in the
   * yaw-pitch-roll order `Ry(y) * Rx(x) * Rz(z)` — the same convention as
   * `mat4.fromRotationXY`.
   * @param {Float32Array|number[]} out Receiver.
   * @param {number} x Pitch about X, in radians.
   * @param {number} y Yaw about Y, in radians.
   * @param {number} z Roll about Z, in radians.
   * @returns {Float32Array|number[]} `out`.
   */
  fromEuler(out, x, y, z) {
    const hx = x * 0.5, hy = y * 0.5, hz = z * 0.5;
    const sx = Math.sin(hx), cx = Math.cos(hx);
    const sy = Math.sin(hy), cy = Math.cos(hy);
    const sz = Math.sin(hz), cz = Math.cos(hz);
    // q = (qy * qx) * qz, expanded.
    const ax = cy * sx, ay = sy * cx, az = -sy * sx, aw = cy * cx;
    out[0] = ax * cz + ay * sz;
    out[1] = ay * cz - ax * sz;
    out[2] = az * cz + aw * sz;
    out[3] = aw * cz - az * sz;
    return out;
  }
};

/* ------------------------------------------------------------------------- */
/* Frustum                                                                    */
/* ------------------------------------------------------------------------- */

/** Plane order inside {@link Frustum#planes}. */
const PLANE_COUNT = 6;

/**
 * View frustum built from a view-projection matrix with the Gribb-Hartmann
 * plane extraction. All plane normals point **inwards**, so a point is inside
 * the frustum when `a*x + b*y + c*z + d >= 0` for all six planes.
 *
 * Every query is allocation-free and safe to call thousands of times per frame.
 */
export class Frustum {
  constructor() {
    /**
     * Six planes, packed as `(a, b, c, d)` in the order
     * left, right, bottom, top, near, far.
     * @type {Float32Array}
     */
    this.planes = new Float32Array(PLANE_COUNT * 4);
  }

  /**
   * Extract and normalize the six planes from a column-major view-projection
   * matrix (Gribb-Hartmann).
   * @param {ArrayLike<number>} m Column-major view-projection matrix.
   * @returns {Frustum} `this`, for chaining.
   */
  fromViewProj(m) {
    const p = this.planes;
    const m00 = m[0], m10 = m[1], m20 = m[2], m30 = m[3];
    const m01 = m[4], m11 = m[5], m21 = m[6], m31 = m[7];
    const m02 = m[8], m12 = m[9], m22 = m[10], m32 = m[11];
    const m03 = m[12], m13 = m[13], m23 = m[14], m33 = m[15];

    // left = row3 + row0
    p[0] = m30 + m00; p[1] = m31 + m01; p[2] = m32 + m02; p[3] = m33 + m03;
    // right = row3 - row0
    p[4] = m30 - m00; p[5] = m31 - m01; p[6] = m32 - m02; p[7] = m33 - m03;
    // bottom = row3 + row1
    p[8] = m30 + m10; p[9] = m31 + m11; p[10] = m32 + m12; p[11] = m33 + m13;
    // top = row3 - row1
    p[12] = m30 - m10; p[13] = m31 - m11; p[14] = m32 - m12; p[15] = m33 - m13;
    // near = row3 + row2
    p[16] = m30 + m20; p[17] = m31 + m21; p[18] = m32 + m22; p[19] = m33 + m23;
    // far = row3 - row2
    p[20] = m30 - m20; p[21] = m31 - m21; p[22] = m32 - m22; p[23] = m33 - m23;

    for (let i = 0; i < 24; i += 4) {
      const a = p[i], b = p[i + 1], c = p[i + 2];
      const l = Math.hypot(a, b, c);
      if (l > 0) {
        const inv = 1 / l;
        p[i] = a * inv;
        p[i + 1] = b * inv;
        p[i + 2] = c * inv;
        p[i + 3] *= inv;
      }
    }
    return this;
  }

  /**
   * Conservative axis-aligned box test using the p-vertex (positive vertex)
   * method: for each plane only the box corner furthest along the plane normal
   * is evaluated. Exact and allocation-free.
   * @param {number} minX Box minimum X.
   * @param {number} minY Box minimum Y.
   * @param {number} minZ Box minimum Z.
   * @param {number} maxX Box maximum X.
   * @param {number} maxY Box maximum Y.
   * @param {number} maxZ Box maximum Z.
   * @returns {boolean} `false` only when the box is fully outside a plane.
   */
  containsAABB(minX, minY, minZ, maxX, maxY, maxZ) {
    const p = this.planes;
    for (let i = 0; i < 24; i += 4) {
      const a = p[i], b = p[i + 1], c = p[i + 2], d = p[i + 3];
      const px = a >= 0 ? maxX : minX;
      const py = b >= 0 ? maxY : minY;
      const pz = c >= 0 ? maxZ : minZ;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }

  /**
   * Convenience wrapper around {@link Frustum#containsAABB} for the packed
   * 6-element box arrays used by `SectionMesh.aabb` and `world.getCollisionAABBs`.
   * @param {ArrayLike<number>} box `[minX, minY, minZ, maxX, maxY, maxZ]`.
   * @returns {boolean} `true` when the box may be visible.
   */
  containsBox(box) {
    return this.containsAABB(box[0], box[1], box[2], box[3], box[4], box[5]);
  }

  /**
   * Sphere test.
   * @param {number} x Sphere center X.
   * @param {number} y Sphere center Y.
   * @param {number} z Sphere center Z.
   * @param {number} r Sphere radius.
   * @returns {boolean} `false` only when the sphere is fully outside a plane.
   */
  containsSphere(x, y, z, r) {
    const p = this.planes;
    for (let i = 0; i < 24; i += 4) {
      if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < -r) return false;
    }
    return true;
  }

  /**
   * Point test.
   * @param {number} x Point X.
   * @param {number} y Point Y.
   * @param {number} z Point Z.
   * @returns {boolean} `true` when the point is inside all six planes.
   */
  containsPoint(x, y, z) {
    const p = this.planes;
    for (let i = 0; i < 24; i += 4) {
      if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < 0) return false;
    }
    return true;
  }

  /**
   * Signed distance from a point to one plane (positive = inside).
   * @param {number} index Plane index `0..5` (left, right, bottom, top, near, far).
   * @param {number} x Point X.
   * @param {number} y Point Y.
   * @param {number} z Point Z.
   * @returns {number} Signed distance in world units.
   */
  distanceToPlane(index, x, y, z) {
    const i = index * 4;
    const p = this.planes;
    return p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3];
  }

  /**
   * Copy the planes of another frustum into this one.
   * @param {Frustum} other Source frustum.
   * @returns {Frustum} `this`.
   */
  copy(other) {
    this.planes.set(other.planes);
    return this;
  }
}

/* ------------------------------------------------------------------------- */
/* AABB                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Axis-aligned bounding box. Used for entities, block collision shapes, chunk
 * sections and broad-phase queries. All mutating methods return `this` so they
 * can be chained, and none of them allocate.
 */
export class AABB {
  /**
   * @param {number} [minX=0] Minimum X.
   * @param {number} [minY=0] Minimum Y.
   * @param {number} [minZ=0] Minimum Z.
   * @param {number} [maxX=0] Maximum X.
   * @param {number} [maxY=0] Maximum Y.
   * @param {number} [maxZ=0] Maximum Z.
   */
  constructor(minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0) {
    /** @type {number} */ this.minX = minX;
    /** @type {number} */ this.minY = minY;
    /** @type {number} */ this.minZ = minZ;
    /** @type {number} */ this.maxX = maxX;
    /** @type {number} */ this.maxY = maxY;
    /** @type {number} */ this.maxZ = maxZ;
  }

  /**
   * Overwrite all six bounds.
   * @param {number} minX Minimum X.
   * @param {number} minY Minimum Y.
   * @param {number} minZ Minimum Z.
   * @param {number} maxX Maximum X.
   * @param {number} maxY Maximum Y.
   * @param {number} maxZ Maximum Z.
   * @returns {AABB} `this`.
   */
  set(minX, minY, minZ, maxX, maxY, maxZ) {
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
    return this;
  }

  /**
   * Copy the bounds of another box.
   * @param {AABB} o Source box.
   * @returns {AABB} `this`.
   */
  copy(o) {
    this.minX = o.minX; this.minY = o.minY; this.minZ = o.minZ;
    this.maxX = o.maxX; this.maxY = o.maxY; this.maxZ = o.maxZ;
    return this;
  }

  /**
   * Read the bounds from a packed `[minX, minY, minZ, maxX, maxY, maxZ]` array.
   * @param {ArrayLike<number>} a Packed bounds.
   * @param {number} [offset=0] Index of `minX` inside `a`.
   * @returns {AABB} `this`.
   */
  setFromArray(a, offset = 0) {
    this.minX = a[offset]; this.minY = a[offset + 1]; this.minZ = a[offset + 2];
    this.maxX = a[offset + 3]; this.maxY = a[offset + 4]; this.maxZ = a[offset + 5];
    return this;
  }

  /**
   * Set the box from a center point and full size along each axis.
   * @param {number} cx Center X.
   * @param {number} cy Center Y.
   * @param {number} cz Center Z.
   * @param {number} sx Full size along X.
   * @param {number} sy Full size along Y.
   * @param {number} sz Full size along Z.
   * @returns {AABB} `this`.
   */
  setFromCenterSize(cx, cy, cz, sx, sy, sz) {
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    return this.set(cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz);
  }

  /**
   * Set the box from an entity footprint: horizontally centered on `(x, z)`,
   * with its base at `y`.
   * @param {number} x Center X.
   * @param {number} y Feet (base) Y.
   * @param {number} z Center Z.
   * @param {number} width Full width along X and Z.
   * @param {number} height Height along Y.
   * @returns {AABB} `this`.
   */
  setFromEntity(x, y, z, width, height) {
    const h = width * 0.5;
    return this.set(x - h, y, z - h, x + h, y + height, z + h);
  }

  /**
   * Grow (or, with a negative `d`, shrink) the box by `d` on every side.
   * @param {number} d Amount to expand on each side.
   * @returns {AABB} `this`.
   */
  expand(d) {
    this.minX -= d; this.minY -= d; this.minZ -= d;
    this.maxX += d; this.maxY += d; this.maxZ += d;
    return this;
  }

  /**
   * Extend the box along a motion vector, producing the broad-phase box that
   * covers the whole sweep.
   * @param {number} vx Motion along X.
   * @param {number} vy Motion along Y.
   * @param {number} vz Motion along Z.
   * @returns {AABB} `this`.
   */
  expandByVelocity(vx, vy, vz) {
    if (vx > 0) this.maxX += vx; else this.minX += vx;
    if (vy > 0) this.maxY += vy; else this.minY += vy;
    if (vz > 0) this.maxZ += vz; else this.minZ += vz;
    return this;
  }

  /**
   * Translate the box.
   * @param {number} x Offset along X.
   * @param {number} y Offset along Y.
   * @param {number} z Offset along Z.
   * @returns {AABB} `this`.
   */
  offset(x, y, z) {
    this.minX += x; this.maxX += x;
    this.minY += y; this.maxY += y;
    this.minZ += z; this.maxZ += z;
    return this;
  }

  /**
   * Overlap test against another box. Touching faces do **not** count as an
   * intersection, which is what the swept collision solver needs.
   * @param {AABB} o Other box.
   * @returns {boolean} `true` when the two boxes overlap with positive volume.
   */
  intersects(o) {
    return this.minX < o.maxX && this.maxX > o.minX &&
           this.minY < o.maxY && this.maxY > o.minY &&
           this.minZ < o.maxZ && this.maxZ > o.minZ;
  }

  /**
   * Point containment test (inclusive on the minimum faces).
   * @param {number} x Point X.
   * @param {number} y Point Y.
   * @param {number} z Point Z.
   * @returns {boolean} `true` when the point is inside the box.
   */
  contains(x, y, z) {
    return x >= this.minX && x <= this.maxX &&
           y >= this.minY && y <= this.maxY &&
           z >= this.minZ && z <= this.maxZ;
  }

  /**
   * Full containment test of another box.
   * @param {AABB} o Other box.
   * @returns {boolean} `true` when `o` lies completely inside this box.
   */
  containsAABB(o) {
    return o.minX >= this.minX && o.maxX <= this.maxX &&
           o.minY >= this.minY && o.maxY <= this.maxY &&
           o.minZ >= this.minZ && o.maxZ <= this.maxZ;
  }

  /**
   * Grow this box so it also contains `o`.
   * @param {AABB} o Box to absorb.
   * @returns {AABB} `this`.
   */
  union(o) {
    if (o.minX < this.minX) this.minX = o.minX;
    if (o.minY < this.minY) this.minY = o.minY;
    if (o.minZ < this.minZ) this.minZ = o.minZ;
    if (o.maxX > this.maxX) this.maxX = o.maxX;
    if (o.maxY > this.maxY) this.maxY = o.maxY;
    if (o.maxZ > this.maxZ) this.maxZ = o.maxZ;
    return this;
  }

  /**
   * Grow this box so it also contains the given point.
   * @param {number} x Point X.
   * @param {number} y Point Y.
   * @param {number} z Point Z.
   * @returns {AABB} `this`.
   */
  encapsulate(x, y, z) {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
    return this;
  }

  /**
   * Write the center point into `out`.
   * @param {Float32Array|number[]} out Receiver `vec3`.
   * @returns {Float32Array|number[]} `out`.
   */
  center(out) {
    out[0] = (this.minX + this.maxX) * 0.5;
    out[1] = (this.minY + this.maxY) * 0.5;
    out[2] = (this.minZ + this.maxZ) * 0.5;
    return out;
  }

  /**
   * Write the full size along each axis into `out`.
   * @param {Float32Array|number[]} out Receiver `vec3`.
   * @returns {Float32Array|number[]} `out`.
   */
  size(out) {
    out[0] = this.maxX - this.minX;
    out[1] = this.maxY - this.minY;
    out[2] = this.maxZ - this.minZ;
    return out;
  }

  /**
   * Radius of the bounding sphere around this box.
   * @returns {number} Half the diagonal length.
   */
  boundingRadius() {
    return 0.5 * Math.hypot(this.maxX - this.minX, this.maxY - this.minY, this.maxZ - this.minZ);
  }

  /**
   * Pack the bounds into a 6-element array.
   * @param {Float32Array|number[]} [out=[]] Receiver.
   * @param {number} [offset=0] Index of `minX` inside `out`.
   * @returns {Float32Array|number[]} `out` holding `[minX, minY, minZ, maxX, maxY, maxZ]`.
   */
  toArray(out = [], offset = 0) {
    out[offset] = this.minX; out[offset + 1] = this.minY; out[offset + 2] = this.minZ;
    out[offset + 3] = this.maxX; out[offset + 4] = this.maxY; out[offset + 5] = this.maxZ;
    return out;
  }

  /**
   * Allocate an independent copy of this box.
   * @returns {AABB} A new box with the same bounds.
   */
  clone() {
    return new AABB(this.minX, this.minY, this.minZ, this.maxX, this.maxY, this.maxZ);
  }

  /**
   * Swept test of this (moving) box against a static box.
   * @param {AABB} other Static box to sweep against.
   * @param {number} vx Motion along X for the whole step.
   * @param {number} vy Motion along Y for the whole step.
   * @param {number} vz Motion along Z for the whole step.
   * @param {Float32Array|number[]|null} [outNormal=null] Optional receiver for the
   *   contact normal (pointing away from `other`); zeroed when there is no hit.
   * @returns {number} Entry time in `[0, 1]`, or `1` when no collision occurs.
   */
  sweep(other, vx, vy, vz, outNormal = null) {
    if (outNormal) {
      outNormal[0] = 0; outNormal[1] = 0; outNormal[2] = 0;
    }

    let xEntry, xExit, yEntry, yExit, zEntry, zExit;

    if (vx > 0) {
      xEntry = (other.minX - this.maxX) / vx;
      xExit = (other.maxX - this.minX) / vx;
    } else if (vx < 0) {
      xEntry = (other.maxX - this.minX) / vx;
      xExit = (other.minX - this.maxX) / vx;
    } else {
      if (this.maxX <= other.minX || this.minX >= other.maxX) return 1;
      xEntry = -Infinity; xExit = Infinity;
    }

    if (vy > 0) {
      yEntry = (other.minY - this.maxY) / vy;
      yExit = (other.maxY - this.minY) / vy;
    } else if (vy < 0) {
      yEntry = (other.maxY - this.minY) / vy;
      yExit = (other.minY - this.maxY) / vy;
    } else {
      if (this.maxY <= other.minY || this.minY >= other.maxY) return 1;
      yEntry = -Infinity; yExit = Infinity;
    }

    if (vz > 0) {
      zEntry = (other.minZ - this.maxZ) / vz;
      zExit = (other.maxZ - this.minZ) / vz;
    } else if (vz < 0) {
      zEntry = (other.maxZ - this.minZ) / vz;
      zExit = (other.minZ - this.maxZ) / vz;
    } else {
      if (this.maxZ <= other.minZ || this.minZ >= other.maxZ) return 1;
      zEntry = -Infinity; zExit = Infinity;
    }

    const entry = Math.max(xEntry, yEntry, zEntry);
    const exit = Math.min(xExit, yExit, zExit);
    if (entry > exit || entry < 0 || entry > 1 || !Number.isFinite(entry)) return 1;

    if (outNormal) {
      if (entry === xEntry) {
        outNormal[0] = vx > 0 ? -1 : 1;
      } else if (entry === yEntry) {
        outNormal[1] = vy > 0 ? -1 : 1;
      } else {
        outNormal[2] = vz > 0 ? -1 : 1;
      }
    }
    return entry;
  }

  /**
   * Ray/box intersection using the slab method, robust against axis-parallel
   * rays. Returns `0` when the origin is already inside the box.
   * @param {number} ox Ray origin X.
   * @param {number} oy Ray origin Y.
   * @param {number} oz Ray origin Z.
   * @param {number} dx Ray direction X (need not be normalized).
   * @param {number} dy Ray direction Y.
   * @param {number} dz Ray direction Z.
   * @returns {number} Distance along the ray to the entry point, or `-1` for a miss.
   */
  rayIntersect(ox, oy, oz, dx, dy, dz) {
    let tmin = 0;
    let tmax = Infinity;

    if (Math.abs(dx) < 1e-12) {
      if (ox < this.minX || ox > this.maxX) return -1;
    } else {
      const inv = 1 / dx;
      let t1 = (this.minX - ox) * inv;
      let t2 = (this.maxX - ox) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    if (Math.abs(dy) < 1e-12) {
      if (oy < this.minY || oy > this.maxY) return -1;
    } else {
      const inv = 1 / dy;
      let t1 = (this.minY - oy) * inv;
      let t2 = (this.maxY - oy) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    if (Math.abs(dz) < 1e-12) {
      if (oz < this.minZ || oz > this.maxZ) return -1;
    } else {
      const inv = 1 / dz;
      let t1 = (this.minZ - oz) * inv;
      let t2 = (this.maxZ - oz) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    return tmin;
  }

  /**
   * Allocate a box from a center point and full size.
   * @param {number} cx Center X.
   * @param {number} cy Center Y.
   * @param {number} cz Center Z.
   * @param {number} sx Full size along X.
   * @param {number} sy Full size along Y.
   * @param {number} sz Full size along Z.
   * @returns {AABB} A new box.
   */
  static fromCenterSize(cx, cy, cz, sx, sy, sz) {
    return new AABB().setFromCenterSize(cx, cy, cz, sx, sy, sz);
  }

  /**
   * Allocate the unit box of the block at integer coordinates `(x, y, z)`.
   * @param {number} x Block X.
   * @param {number} y Block Y.
   * @param {number} z Block Z.
   * @returns {AABB} A new box spanning `[x, x+1] x [y, y+1] x [z, z+1]`.
   */
  static fromBlock(x, y, z) {
    return new AABB(x, y, z, x + 1, y + 1, z + 1);
  }
}

/* ------------------------------------------------------------------------- */
/* Ray                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * A parametric ray `origin + direction * t`, shared by the renderer (picking,
 * SSR debug) and the physics/interaction code (block raycasts).
 * The direction is stored as given — call {@link Ray#normalize} when `t` must
 * be a world-space distance.
 */
export class Ray {
  /**
   * @param {ArrayLike<number>|null} [origin=null] Initial origin, copied. Defaults to `(0, 0, 0)`.
   * @param {ArrayLike<number>|null} [direction=null] Initial direction, copied. Defaults to `(0, 0, -1)`.
   */
  constructor(origin = null, direction = null) {
    /** @type {Float32Array} Ray origin. */
    this.origin = new Float32Array(3);
    /** @type {Float32Array} Ray direction. */
    this.direction = new Float32Array(3);
    this.direction[2] = -1;
    if (origin) {
      this.origin[0] = origin[0]; this.origin[1] = origin[1]; this.origin[2] = origin[2];
    }
    if (direction) {
      this.direction[0] = direction[0];
      this.direction[1] = direction[1];
      this.direction[2] = direction[2];
    }
  }

  /**
   * Set origin and direction from six scalars.
   * @param {number} ox Origin X.
   * @param {number} oy Origin Y.
   * @param {number} oz Origin Z.
   * @param {number} dx Direction X.
   * @param {number} dy Direction Y.
   * @param {number} dz Direction Z.
   * @returns {Ray} `this`.
   */
  set(ox, oy, oz, dx, dy, dz) {
    this.origin[0] = ox; this.origin[1] = oy; this.origin[2] = oz;
    this.direction[0] = dx; this.direction[1] = dy; this.direction[2] = dz;
    return this;
  }

  /**
   * Set origin and direction from two vectors.
   * @param {ArrayLike<number>} origin Origin vector.
   * @param {ArrayLike<number>} direction Direction vector.
   * @returns {Ray} `this`.
   */
  setFromVectors(origin, direction) {
    return this.set(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2]);
  }

  /**
   * Copy another ray.
   * @param {Ray} r Source ray.
   * @returns {Ray} `this`.
   */
  copy(r) {
    this.origin.set(r.origin);
    this.direction.set(r.direction);
    return this;
  }

  /**
   * Allocate an independent copy of this ray.
   * @returns {Ray} A new ray.
   */
  clone() {
    return new Ray(this.origin, this.direction);
  }

  /**
   * Normalize the direction in place.
   * @returns {Ray} `this`.
   */
  normalize() {
    vec3.normalize(this.direction, this.direction);
    return this;
  }

  /**
   * Evaluate the ray at parameter `t`.
   * @param {number} t Distance along the direction.
   * @param {Float32Array|number[]} out Receiver `vec3`.
   * @returns {Float32Array|number[]} `out` set to `origin + direction * t`.
   */
  at(t, out) {
    out[0] = this.origin[0] + this.direction[0] * t;
    out[1] = this.origin[1] + this.direction[1] * t;
    out[2] = this.origin[2] + this.direction[2] * t;
    return out;
  }

  /**
   * Intersect this ray with an axis-aligned box.
   * @param {AABB} aabb Box to test.
   * @returns {number} Distance along the ray to the entry point, or `-1` for a miss.
   */
  intersectAABB(aabb) {
    return aabb.rayIntersect(
      this.origin[0], this.origin[1], this.origin[2],
      this.direction[0], this.direction[1], this.direction[2]
    );
  }
}

/* ------------------------------------------------------------------------- */
/* Module-level scratch buffers (never returned to callers)                   */
/* ------------------------------------------------------------------------- */

/** Scratch matrix used by `mat4.decompose`. @type {Float32Array} */
const SCRATCH_M0 = mat4.create();
