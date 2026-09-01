/**
 * VOXELIA — `world/noise.js` (spec 5.7)
 *
 * Seeded, allocation-free procedural noise. Everything in here is a pure
 * function of `(seed, coordinates)`; no module-scope `window`/`document`
 * access, so the file is safe to import inside a module Web Worker.
 *
 * Value ranges (documented per method, relied upon by `world/worldgen.js`):
 *
 * | method                         | range                                 |
 * |--------------------------------|---------------------------------------|
 * | `perlin2` / `perlin3`          | `[-1, 1]` (theoretical bound, exact)  |
 * | `simplex2` / `simplex3`        | `[-1, 1]`                             |
 * | `value3`                       | `[-1, 1]`                             |
 * | `fbm2` / `fbm3`                | `[-1, 1]` (amplitude-normalised)      |
 * | `ridged2` / `ridged3`          | `[0, 1]`, 1 = ridge crest             |
 * | `billow3`                      | `[0, 1]`, 0 = smooth, 1 = bubbly      |
 * | `worley2.f1/.f2`               | `[0, ~2.1]` euclidean, cell units     |
 *
 * Hot-path rules honoured here:
 * - no allocation inside any sampling method,
 * - `worley2`/`worley3`/`domainWarp2` write into a reusable scratch object
 *   owned by the `Noise` instance (or into a caller supplied `out`),
 * - all tables are typed arrays built once in the constructor.
 *
 * @module world/noise
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Normalisation for 2D Perlin built from unit gradients: `sqrt(2)`. */
const PERLIN2_NORM = 1.4142135623730951;

/** Normalisation for 3D Perlin built from the 12 `sqrt(2)`-long gradients. */
const PERLIN3_NORM = 0.816496580927726;

/** 2D simplex skew factor `0.5 * (sqrt(3) - 1)`. */
const F2 = 0.3660254037844386;
/** 2D simplex unskew factor `(3 - sqrt(3)) / 6`. */
const G2 = 0.21132486540518713;
/** 3D simplex skew factor `1/3`. */
const F3 = 0.3333333333333333;
/** 3D simplex unskew factor `1/6`. */
const G3 = 0.16666666666666666;

/** Scaling that brings 2D simplex into `[-1, 1]`. */
const SIMPLEX2_SCALE = 70.0;
/** Scaling that brings 3D simplex into `[-1, 1]`. */
const SIMPLEX3_SCALE = 32.0;

/** Eight unit gradients at 45 degree steps, used by `perlin2`. */
const GRAD2 = new Float64Array([
  1, 0,
  -1, 0,
  0, 1,
  0, -1,
  0.7071067811865476, 0.7071067811865476,
  -0.7071067811865476, 0.7071067811865476,
  0.7071067811865476, -0.7071067811865476,
  -0.7071067811865476, -0.7071067811865476,
]);

/** Ken Perlin's 12 cube-edge gradients, used by `perlin3`, `simplex2`, `simplex3`. */
const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/** Reciprocal of `2^24`, turns 24 hash bits into a float. */
const INV_2_24 = 1 / 16777216;

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Branch-light floor for `|v| < 2^31`. Faster than `Math.floor` in V8 for the
 * coordinate magnitudes a voxel world produces.
 * @param {number} v value to floor
 * @returns {number} largest integer `<= v`
 */
function fastFloor(v) {
  const i = v | 0;
  return v < i ? i - 1 : i;
}

/**
 * Quintic interpolant `6t^5 - 15t^4 + 10t^3` (Perlin's improved fade).
 * @param {number} t value in `[0, 1]`
 * @returns {number} eased value in `[0, 1]`
 */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Mulberry32 PRNG, used only while building the permutation table.
 * @param {number} a 32-bit seed
 * @returns {() => number} generator producing floats in `[0, 1)`
 */
function mulberry32(a) {
  let s = a | 0;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convert any seed value (number, string, undefined) into a uint32.
 * @param {number|string|undefined|null} seed raw seed
 * @returns {number} uint32 seed
 */
function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    // Fold the fractional part in so 0.5 and 0.25 are different worlds.
    const whole = Math.trunc(seed);
    const frac = Math.round((seed - whole) * 4294967296);
    return (Math.imul(whole >>> 0, 0x9e3779b1) ^ (frac >>> 0)) >>> 0;
  }
  if (typeof seed === 'string') {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  return 0;
}

/**
 * Strong 3D integer hash (xxhash-flavoured avalanche). Deterministic across
 * platforms because every step is a 32-bit integer operation.
 * @param {number} x integer lattice x
 * @param {number} y integer lattice y
 * @param {number} z integer lattice z
 * @param {number} seed uint32 seed
 * @returns {number} uint32 hash
 */
function hash3i(x, y, z, seed) {
  let h = (seed + Math.imul(x | 0, 0x27d4eb2d)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x165667b1);
  h = (h + Math.imul(y | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  h = (h + Math.imul(z | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x2545f491);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * Hashed lattice value in `[-1, 1]`, used by `value3`.
 * @param {number} x integer lattice x
 * @param {number} y integer lattice y
 * @param {number} z integer lattice z
 * @param {number} seed uint32 seed
 * @returns {number} value in `[-1, 1]`
 */
function hashValue(x, y, z, seed) {
  return (hash3i(x, y, z, seed) >>> 8) * INV_2_24 * 2 - 1;
}

/* -------------------------------------------------------------------------- */
/* Noise                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Seeded noise generator. One instance owns one permutation table; create a
 * few instances with derived seeds instead of re-seeding a single one.
 *
 * All sampling methods are allocation-free. `worley2`, `worley3` and
 * `domainWarp2` return a scratch object/array owned by the instance — copy the
 * values out before the next call if you need to keep them.
 */
export class Noise {
  /**
   * @param {number|string} [seed=0] world seed; strings are hashed
   */
  constructor(seed = 0) {
    /** @type {number} uint32 seed actually used */
    this.seed = normalizeSeed(seed);

    const source = new Uint8Array(256);
    for (let i = 0; i < 256; i++) source[i] = i;

    // Fisher-Yates shuffle driven by the seed.
    const rnd = mulberry32((this.seed ^ 0x9e3779b9) | 0);
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = source[i];
      source[i] = source[j];
      source[j] = t;
    }

    /** @type {Uint8Array} doubled permutation table (length 512) */
    this.perm = new Uint8Array(512);
    /** @type {Uint8Array} `perm % 12`, indexes GRAD3 without a modulo */
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      const v = source[i & 255];
      this.perm[i] = v;
      this.permMod12[i] = v % 12;
    }

    /** @type {{f1:number, f2:number, cellX:number, cellY:number, cellZ:number}} */
    this._cell2 = { f1: 0, f2: 0, cellX: 0, cellY: 0, cellZ: 0 };
    /** @type {{f1:number, f2:number, cellX:number, cellY:number, cellZ:number}} */
    this._cell3 = { f1: 0, f2: 0, cellX: 0, cellY: 0, cellZ: 0 };
    /** @type {Float64Array} scratch for `domainWarp2` */
    this._warp = new Float64Array(2);
  }

  /* ---------------------------------------------------------------- Perlin */

  /**
   * Classic 2D Perlin noise with quintic fade and 8 unit gradients.
   * @param {number} x sample x
   * @param {number} y sample y
   * @returns {number} noise in `[-1, 1]`
   */
  perlin2(x, y) {
    const p = this.perm;
    const xi = fastFloor(x);
    const yi = fastFloor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const u = fade(xf);
    const v = fade(yf);

    const a = p[X] + Y;
    const b = p[X + 1] + Y;
    const g00 = (p[a] & 7) << 1;
    const g10 = (p[b] & 7) << 1;
    const g01 = (p[a + 1] & 7) << 1;
    const g11 = (p[b + 1] & 7) << 1;

    const x1 = xf - 1;
    const y1 = yf - 1;

    const n00 = GRAD2[g00] * xf + GRAD2[g00 + 1] * yf;
    const n10 = GRAD2[g10] * x1 + GRAD2[g10 + 1] * yf;
    const n01 = GRAD2[g01] * xf + GRAD2[g01 + 1] * y1;
    const n11 = GRAD2[g11] * x1 + GRAD2[g11 + 1] * y1;

    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * PERLIN2_NORM;
  }

  /**
   * Classic 3D Perlin noise with quintic fade and the 12 edge gradients.
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {number} z sample z
   * @returns {number} noise in `[-1, 1]`
   */
  perlin3(x, y, z) {
    const p = this.perm;
    const pm = this.permMod12;
    const xi = fastFloor(x);
    const yi = fastFloor(y);
    const zi = fastFloor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const X = xi & 255;
    const Y = yi & 255;
    const Z = zi & 255;
    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const a = p[X] + Y;
    const aa = p[a] + Z;
    const ab = p[a + 1] + Z;
    const b = p[X + 1] + Y;
    const ba = p[b] + Z;
    const bb = p[b + 1] + Z;

    const x1 = xf - 1;
    const y1 = yf - 1;
    const z1 = zf - 1;

    let g = pm[aa] * 3;
    const n000 = GRAD3[g] * xf + GRAD3[g + 1] * yf + GRAD3[g + 2] * zf;
    g = pm[ba] * 3;
    const n100 = GRAD3[g] * x1 + GRAD3[g + 1] * yf + GRAD3[g + 2] * zf;
    g = pm[ab] * 3;
    const n010 = GRAD3[g] * xf + GRAD3[g + 1] * y1 + GRAD3[g + 2] * zf;
    g = pm[bb] * 3;
    const n110 = GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * zf;
    g = pm[aa + 1] * 3;
    const n001 = GRAD3[g] * xf + GRAD3[g + 1] * yf + GRAD3[g + 2] * z1;
    g = pm[ba + 1] * 3;
    const n101 = GRAD3[g] * x1 + GRAD3[g + 1] * yf + GRAD3[g + 2] * z1;
    g = pm[ab + 1] * 3;
    const n011 = GRAD3[g] * xf + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1;
    g = pm[bb + 1] * 3;
    const n111 = GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1;

    const nx00 = n000 + u * (n100 - n000);
    const nx10 = n010 + u * (n110 - n010);
    const nx01 = n001 + u * (n101 - n001);
    const nx11 = n011 + u * (n111 - n011);
    const ny0 = nx00 + v * (nx10 - nx00);
    const ny1 = nx01 + v * (nx11 - nx01);
    return (ny0 + w * (ny1 - ny0)) * PERLIN3_NORM;
  }

  /* --------------------------------------------------------------- Simplex */

  /**
   * Genuine 2D simplex noise (skew/unskew onto the triangular lattice,
   * radial falloff, 12-gradient set).
   * @param {number} x sample x
   * @param {number} y sample y
   * @returns {number} noise in `[-1, 1]`
   */
  simplex2(x, y) {
    const p = this.perm;
    const pm = this.permMod12;

    const s = (x + y) * F2;
    const i = fastFloor(x + s);
    const j = fastFloor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);

    let i1 = 0;
    let j1 = 1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n0 = 0;
    let n1 = 0;
    let n2 = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = pm[ii + p[jj]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = pm[ii + i1 + p[jj + j1]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = pm[ii + 1 + p[jj + 1]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2);
    }
    return SIMPLEX2_SCALE * (n0 + n1 + n2);
  }

  /**
   * Genuine 3D simplex noise (tetrahedral lattice with proper corner ordering).
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {number} z sample z
   * @returns {number} noise in `[-1, 1]`
   */
  simplex3(x, y, z) {
    const p = this.perm;
    const pm = this.permMod12;

    const s = (x + y + z) * F3;
    const i = fastFloor(x + s);
    const j = fastFloor(y + s);
    const k = fastFloor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);

    let i1;
    let j1;
    let k1;
    let i2;
    let j2;
    let k2;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else if (y0 < z0) {
      i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
    } else if (x0 < z0) {
      i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
    } else {
      i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    let n0 = 0;
    let n1 = 0;
    let n2 = 0;
    let n3 = 0;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = pm[ii + p[jj + p[kk]]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = pm[ii + i1 + p[jj + j1 + p[kk + k1]]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = pm[ii + i2 + p[jj + j2 + p[kk + k2]]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = pm[ii + 1 + p[jj + 1 + p[kk + 1]]] * 3;
      t3 *= t3;
      n3 = t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return SIMPLEX3_SCALE * (n0 + n1 + n2 + n3);
  }

  /* ---------------------------------------------------------------- Value */

  /**
   * Hash-based 3D value noise with quintic interpolation. Cheaper than Perlin
   * and free of the axis-aligned gradient artefacts, good for jitter/detail.
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {number} z sample z
   * @returns {number} noise in `[-1, 1]`
   */
  value3(x, y, z) {
    const xi = fastFloor(x);
    const yi = fastFloor(y);
    const zi = fastFloor(z);
    const u = fade(x - xi);
    const v = fade(y - yi);
    const w = fade(z - zi);
    const s = this.seed;
    const x1 = xi + 1;
    const y1 = yi + 1;
    const z1 = zi + 1;

    const c000 = hashValue(xi, yi, zi, s);
    const c100 = hashValue(x1, yi, zi, s);
    const c010 = hashValue(xi, y1, zi, s);
    const c110 = hashValue(x1, y1, zi, s);
    const c001 = hashValue(xi, yi, z1, s);
    const c101 = hashValue(x1, yi, z1, s);
    const c011 = hashValue(xi, y1, z1, s);
    const c111 = hashValue(x1, y1, z1, s);

    const a00 = c000 + u * (c100 - c000);
    const a10 = c010 + u * (c110 - c010);
    const a01 = c001 + u * (c101 - c001);
    const a11 = c011 + u * (c111 - c011);
    const b0 = a00 + v * (a10 - a00);
    const b1 = a01 + v * (a11 - a01);
    return b0 + w * (b1 - b0);
  }

  /* ---------------------------------------------------------------- Fractal */

  /**
   * Fractional Brownian motion over 2D simplex noise.
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {number} [oct=4] octave count (>= 1)
   * @param {number} [lac=2] lacunarity (frequency multiplier per octave)
   * @param {number} [gain=0.5] amplitude multiplier per octave
   * @returns {number} amplitude-normalised value in `[-1, 1]`
   */
  fbm2(x, y, oct = 4, lac = 2, gain = 0.5) {
    let sum = 0;
    let norm = 0;
    let amp = 1;
    let fx = x;
    let fy = y;
    const n = oct | 0;
    for (let i = 0; i < n; i++) {
      sum += amp * this.simplex2(fx, fy);
      norm += amp;
      amp *= gain;
      fx *= lac;
      fy *= lac;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Fractional Brownian motion over 3D simplex noise.
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {number} z sample z
   * @param {number} [oct=4] octave count (>= 1)
   * @param {number} [lac=2] lacunarity
   * @param {number} [gain=0.5] amplitude falloff
   * @returns {number} amplitude-normalised value in `[-1, 1]`
   */
  fbm3(x, y, z, oct = 4, lac = 2, gain = 0.5) {
    let sum = 0;
    let norm = 0;
    let amp = 1;
    let fx = x;
    let fy = y;
    let fz = z;
    const n = oct | 0;
    for (let i = 0; i < n; i++) {
      sum += amp * this.simplex3(fx, fy, fz);
      norm += amp;
      amp *= gain;
      fx *= lac;
      fy *= lac;
      fz *= lac;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Ridged multifractal in 2D — sharp crests, good for mountain spines.
   * Each octave is weighted by the previous one so ridges stay coherent.
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {number} [oct=4] octave count
   * @param {number} [lac=2] lacunarity
   * @param {number} [gain=0.5] amplitude falloff
   * @returns {number} value in `[0, 1]`, 1 at a ridge crest
   */
  ridged2(x, y, oct = 4, lac = 2, gain = 0.5) {
    let sum = 0;
    let norm = 0;
    let amp = 1;
    let weight = 1;
    let fx = x;
    let fy = y;
    const n = oct | 0;
    for (let i = 0; i < n; i++) {
      let v = 1 - Math.abs(this.simplex2(fx, fy));
      v *= v;
      v *= weight;
      weight = v * 2;
      if (weight > 1) weight = 1;
      else if (weight < 0) weight = 0;
      sum += amp * v;
      norm += amp;
      amp *= gain;
      fx *= lac;
      fy *= lac;
    }
    if (norm <= 0) return 0;
    const r = sum / norm;
    return r < 0 ? 0 : (r > 1 ? 1 : r);
  }

  /**
   * Ridged multifractal in 3D.
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {number} z sample z
   * @param {number} [oct=4] octave count
   * @param {number} [lac=2] lacunarity
   * @param {number} [gain=0.5] amplitude falloff
   * @returns {number} value in `[0, 1]`, 1 at a ridge crest
   */
  ridged3(x, y, z, oct = 4, lac = 2, gain = 0.5) {
    let sum = 0;
    let norm = 0;
    let amp = 1;
    let weight = 1;
    let fx = x;
    let fy = y;
    let fz = z;
    const n = oct | 0;
    for (let i = 0; i < n; i++) {
      let v = 1 - Math.abs(this.simplex3(fx, fy, fz));
      v *= v;
      v *= weight;
      weight = v * 2;
      if (weight > 1) weight = 1;
      else if (weight < 0) weight = 0;
      sum += amp * v;
      norm += amp;
      amp *= gain;
      fx *= lac;
      fy *= lac;
      fz *= lac;
    }
    if (norm <= 0) return 0;
    const r = sum / norm;
    return r < 0 ? 0 : (r > 1 ? 1 : r);
  }

  /**
   * Billow fractal in 3D — the absolute value of simplex, producing puffy
   * cloud-like lobes. Useful for cave "cheese" and cloud shaping.
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {number} z sample z
   * @param {number} [oct=4] octave count
   * @param {number} [lac=2] lacunarity
   * @param {number} [gain=0.5] amplitude falloff
   * @returns {number} value in `[0, 1]`
   */
  billow3(x, y, z, oct = 4, lac = 2, gain = 0.5) {
    let sum = 0;
    let norm = 0;
    let amp = 1;
    let fx = x;
    let fy = y;
    let fz = z;
    const n = oct | 0;
    for (let i = 0; i < n; i++) {
      sum += amp * Math.abs(this.simplex3(fx, fy, fz));
      norm += amp;
      amp *= gain;
      fx *= lac;
      fy *= lac;
      fz *= lac;
    }
    if (norm <= 0) return 0;
    const r = sum / norm;
    return r < 0 ? 0 : (r > 1 ? 1 : r);
  }

  /* --------------------------------------------------------------- Worley */

  /**
   * 2D Worley / cellular noise. One feature point per unit cell, 3x3 search.
   *
   * The returned object is the instance scratch object — copy the fields out
   * before calling any Worley method again.
   *
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {{f1:number,f2:number,cellX:number,cellY:number,cellZ:number}} [out]
   *   optional destination (pass your own object to make the call reentrant)
   * @returns {{f1:number,f2:number,cellX:number,cellY:number,cellZ:number}}
   *   `f1` nearest distance, `f2` second nearest, `cellX/cellY` the integer
   *   cell that owns the nearest feature point (`cellZ` is always 0)
   */
  worley2(x, y, out = this._cell2) {
    const bx = fastFloor(x);
    const by = fastFloor(y);
    const seed = this.seed;
    let f1 = 1e30;
    let f2 = 1e30;
    let cx = bx;
    let cy = by;

    for (let dy = -1; dy <= 1; dy++) {
      const gy = by + dy;
      for (let dx = -1; dx <= 1; dx++) {
        const gx = bx + dx;
        const h = hash3i(gx, gy, 0, seed);
        const px = gx + (h & 1023) * (1 / 1024);
        const py = gy + ((h >>> 10) & 1023) * (1 / 1024);
        const ox = px - x;
        const oy = py - y;
        const d = ox * ox + oy * oy;
        if (d < f1) {
          f2 = f1;
          f1 = d;
          cx = gx;
          cy = gy;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }

    out.f1 = Math.sqrt(f1);
    out.f2 = Math.sqrt(f2);
    out.cellX = cx;
    out.cellY = cy;
    out.cellZ = 0;
    return out;
  }

  /**
   * 3D Worley / cellular noise. One feature point per unit cell, 3x3x3 search.
   *
   * The returned object is the instance scratch object — copy the fields out
   * before calling any Worley method again.
   *
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {number} z sample z
   * @param {{f1:number,f2:number,cellX:number,cellY:number,cellZ:number}} [out]
   *   optional destination
   * @returns {{f1:number,f2:number,cellX:number,cellY:number,cellZ:number}}
   *   `f1` nearest distance, `f2` second nearest, `cellX/cellY/cellZ` the cell
   *   owning the nearest feature point
   */
  worley3(x, y, z, out = this._cell3) {
    const bx = fastFloor(x);
    const by = fastFloor(y);
    const bz = fastFloor(z);
    const seed = this.seed;
    let f1 = 1e30;
    let f2 = 1e30;
    let cx = bx;
    let cy = by;
    let cz = bz;

    for (let dz = -1; dz <= 1; dz++) {
      const gz = bz + dz;
      for (let dy = -1; dy <= 1; dy++) {
        const gy = by + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const gx = bx + dx;
          const h = hash3i(gx, gy, gz, seed);
          const px = gx + (h & 1023) * (1 / 1024);
          const py = gy + ((h >>> 10) & 1023) * (1 / 1024);
          const pz = gz + ((h >>> 20) & 1023) * (1 / 1024);
          const ox = px - x;
          const oy = py - y;
          const oz = pz - z;
          const d = ox * ox + oy * oy + oz * oz;
          if (d < f1) {
            f2 = f1;
            f1 = d;
            cx = gx;
            cy = gy;
            cz = gz;
          } else if (d < f2) {
            f2 = d;
          }
        }
      }
    }

    out.f1 = Math.sqrt(f1);
    out.f2 = Math.sqrt(f2);
    out.cellX = cx;
    out.cellY = cy;
    out.cellZ = cz;
    return out;
  }

  /* ------------------------------------------------------------ Domain warp */

  /**
   * Two-octave domain warp. Displaces `(x, y)` along a divergence-free-ish
   * noise field; feeding the result back into another noise call is what turns
   * boring fbm into curled, eroded-looking terrain.
   *
   * The returned array is instance scratch — read it before the next call, or
   * pass your own `out`.
   *
   * @param {number} x sample x
   * @param {number} y sample y
   * @param {number} [strength=1] maximum displacement in world units
   * @param {number} [scale=1] frequency of the warp field
   * @param {Float64Array|number[]} [out] optional destination of length >= 2
   * @returns {Float64Array|number[]} `[warpedX, warpedY]`
   */
  domainWarp2(x, y, strength = 1, scale = 1, out = this._warp) {
    const sx = x * scale;
    const sy = y * scale;
    const a0 = this.simplex2(sx, sy);
    const a1 = this.simplex2(sx + 5.2, sy + 1.3);
    const b0 = this.simplex2(sx * 2.03 + 1.7, sy * 2.03 + 9.2);
    const b1 = this.simplex2(sx * 2.03 + 8.3, sy * 2.03 + 2.8);
    const k = strength * 0.6666666666666666;
    out[0] = x + k * (a0 + 0.5 * b0);
    out[1] = y + k * (a1 + 0.5 * b1);
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* OctaveNoise                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Pre-configured fbm sampler. Holds frequency/amplitude/lacunarity/gain so hot
 * loops do not have to pass them every call. Allocation-free.
 */
export class OctaveNoise {
  /**
   * @param {Noise} noise backing noise instance (shared, not copied)
   * @param {number} [octaves=4] number of octaves (>= 1)
   * @param {number} [freq=1] base frequency applied to input coordinates
   * @param {number} [amp=1] output amplitude (result is `[-amp, amp]`)
   * @param {number} [lac=2] lacunarity
   * @param {number} [gain=0.5] amplitude falloff per octave
   */
  constructor(noise, octaves = 4, freq = 1, amp = 1, lac = 2, gain = 0.5) {
    /** @type {Noise} */
    this.noise = noise;
    /** @type {number} */
    this.octaves = Math.max(1, octaves | 0);
    /** @type {number} */
    this.freq = freq;
    /** @type {number} */
    this.amp = amp;
    /** @type {number} */
    this.lac = lac;
    /** @type {number} */
    this.gain = gain;

    let total = 0;
    let a = 1;
    for (let i = 0; i < this.octaves; i++) {
      total += a;
      a *= gain;
    }
    /** @type {number} sum of the octave amplitudes before normalisation */
    this.maxAmplitude = total;
    /** @type {number} `amp / maxAmplitude`, folded into the sample loop */
    this.scale = total > 0 ? amp / total : 0;
  }

  /**
   * Sample the configured 2D fbm.
   * @param {number} x world x
   * @param {number} y world y (or z — it is just the second axis)
   * @returns {number} value in `[-amp, amp]`
   */
  sample2(x, y) {
    const n = this.noise;
    const lac = this.lac;
    const gain = this.gain;
    let fx = x * this.freq;
    let fy = y * this.freq;
    let a = 1;
    let sum = 0;
    for (let i = 0; i < this.octaves; i++) {
      sum += a * n.simplex2(fx, fy);
      a *= gain;
      fx *= lac;
      fy *= lac;
    }
    return sum * this.scale;
  }

  /**
   * Sample the configured 3D fbm.
   * @param {number} x world x
   * @param {number} y world y
   * @param {number} z world z
   * @returns {number} value in `[-amp, amp]`
   */
  sample3(x, y, z) {
    const n = this.noise;
    const lac = this.lac;
    const gain = this.gain;
    let fx = x * this.freq;
    let fy = y * this.freq;
    let fz = z * this.freq;
    let a = 1;
    let sum = 0;
    for (let i = 0; i < this.octaves; i++) {
      sum += a * n.simplex3(fx, fy, fz);
      a *= gain;
      fx *= lac;
      fy *= lac;
      fz *= lac;
    }
    return sum * this.scale;
  }
}

/* -------------------------------------------------------------------------- */
/* splineCurve                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a monotone cubic interpolant through the given control points
 * (Fritsch-Carlson tangent limiting, so the curve never overshoots between
 * points — essential for terrain shaping splines where an overshoot means a
 * floating cliff).
 *
 * The returned sampler is allocation-free and clamps outside the control
 * range (`t < x0` yields `y0`, `t > xn` yields `yn`).
 *
 * @param {Array<[number, number]>} points control points `[[x, y], ...]`;
 *   they are copied and sorted by `x`, duplicates on `x` are dropped
 * @returns {(t: number) => number} sampler function
 */
export function splineCurve(points) {
  const src = Array.isArray(points) ? points.slice() : [];
  src.sort((a, b) => a[0] - b[0]);

  // Drop duplicate / non-finite x values, keeping the first occurrence.
  const xsList = [];
  const ysList = [];
  for (let i = 0; i < src.length; i++) {
    const px = +src[i][0];
    const py = +src[i][1];
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    if (xsList.length > 0 && px - xsList[xsList.length - 1] <= 1e-12) continue;
    xsList.push(px);
    ysList.push(py);
  }

  const n = xsList.length;

  if (n === 0) {
    return function constantZero() {
      return 0;
    };
  }
  if (n === 1) {
    const only = ysList[0];
    return function constantOne() {
      return only;
    };
  }

  const xs = new Float64Array(xsList);
  const ys = new Float64Array(ysList);
  const dx = new Float64Array(n - 1);
  const slope = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i];
    slope[i] = (ys[i + 1] - ys[i]) / dx[i];
  }

  // Initial tangents: one-sided at the ends, averaged inside.
  const m = new Float64Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (slope[i - 1] + slope[i]) * 0.5;
    }
  }

  // Fritsch-Carlson limiter keeps the interpolant monotone.
  for (let i = 0; i < n - 1; i++) {
    const s = slope[i];
    if (s === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / s;
    const b = m[i + 1] / s;
    const h = a * a + b * b;
    if (h > 9) {
      const tau = 3 / Math.sqrt(h);
      m[i] = tau * a * s;
      m[i + 1] = tau * b * s;
    }
  }

  const last = n - 1;
  const firstX = xs[0];
  const lastX = xs[last];
  const firstY = ys[0];
  const lastY = ys[last];
  const linearScan = n <= 8;

  /**
   * Evaluate the spline.
   * @param {number} t input value
   * @returns {number} interpolated value
   */
  return function sampleSpline(t) {
    if (!(t > firstX)) return firstY;
    if (t >= lastX) return lastY;

    let i = 0;
    if (linearScan) {
      while (i < last - 1 && t >= xs[i + 1]) i++;
    } else {
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= t) lo = mid;
        else hi = mid;
      }
      i = lo;
    }

    const h = dx[i];
    const u = (t - xs[i]) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}
