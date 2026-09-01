/**
 * VOXELIA — shared GLSL chunks.
 *
 * Every chunk is plain GLSL ES 3.00 **without** `#version` and without precision
 * qualifiers: `core/gl.js` prepends those. Chunks are addressed with
 * `#include <name>` on its own line and are expanded at most once per shader, so
 * a chunk may safely `#include` the chunks it depends on.
 *
 * The device also defines `STAGE_VERTEX` / `STAGE_FRAGMENT` for the current
 * shader stage; chunks use that to guard fragment-only builtins.
 *
 * Do not redeclare `PI`, `TAU`, `saturate`, `sq` or any other chunk symbol in a
 * shader that includes `math` — GLSL has no shadowing at global scope.
 *
 * @module render/shaders/common.glsl
 */

/* ------------------------------------------------------------------------ */
/* frame — Frame UBO, binding 0 (ARCHITECTURE.md 3.3, byte-exact order)      */
/* ------------------------------------------------------------------------ */
const FRAME = `
#ifndef VOX_FRAME_INCLUDED
#define VOX_FRAME_INCLUDED

layout(std140) uniform Frame {
  mat4 u_view;
  mat4 u_proj;
  mat4 u_viewProj;
  mat4 u_invView;
  mat4 u_invProj;
  mat4 u_invViewProj;
  mat4 u_prevViewProj;
  vec4 u_camPos;      // xyz world camera, w = near
  vec4 u_camDir;      // xyz forward,      w = far
  vec4 u_sunDir;      // xyz to-sun,       w = timeOfDay 0..1
  vec4 u_sunColor;    // rgb linear,       w = sun intensity
  vec4 u_moonDir;     // xyz to-moon,      w = moon phase 0..1
  vec4 u_skyAmbient;  // rgb ambient,      w = ambient intensity
  vec4 u_fogColor;    // rgb,              w = fog density
  vec4 u_screen;      // w, h, 1/w, 1/h
  vec4 u_time;        // seconds, dt, frameIndex, rainStrength
  vec4 u_params;      // renderDistanceBlocks, seaLevel, exposure, underwater(0/1)
  vec4 u_jitter;      // TAA jitter xy in NDC, prev jitter zw
};

#endif
`;

/* ------------------------------------------------------------------------ */
/* math                                                                      */
/* ------------------------------------------------------------------------ */
const MATH = `
#ifndef VOX_MATH_INCLUDED
#define VOX_MATH_INCLUDED

const float PI       = 3.14159265358979323846;
const float TAU      = 6.28318530717958647692;
const float HALF_PI  = 1.57079632679489661923;
const float INV_PI   = 0.31830988618379067154;
const float EPSILON  = 1.0e-6;

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2  saturate(vec2  x) { return clamp(x, vec2(0.0), vec2(1.0)); }
vec3  saturate(vec3  x) { return clamp(x, vec3(0.0), vec3(1.0)); }
vec4  saturate(vec4  x) { return clamp(x, vec4(0.0), vec4(1.0)); }

float sq(float x) { return x * x; }
vec2  sq(vec2  x) { return x * x; }
vec3  sq(vec3  x) { return x * x; }
vec4  sq(vec4  x) { return x * x; }

float pow5(float x) { float t = x * x; return t * t * x; }

/** Linearly remap v from [a,b] into [c,d]. Degenerate ranges map to c. */
float remap(float v, float a, float b, float c, float d) {
  float span = b - a;
  float t = abs(span) < 1.0e-8 ? 0.0 : (v - a) / span;
  return c + (d - c) * t;
}
vec3 remap(vec3 v, float a, float b, float c, float d) {
  float span = b - a;
  vec3 t = abs(span) < 1.0e-8 ? vec3(0.0) : (v - vec3(a)) / span;
  return vec3(c) + (d - c) * t;
}

/** Remap and clamp to [c,d]. */
float remapClamped(float v, float a, float b, float c, float d) {
  return clamp(remap(v, a, b, c, d), min(c, d), max(c, d));
}

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash31(vec3 p) {
  vec3 p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

/** Rotate a 2D vector by 'a' radians (counter-clockwise). */
vec2 rotate2(vec2 v, float a) {
  float s = sin(a);
  float c = cos(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

/** 2x2 rotation matrix for 'a' radians. */
mat2 rotation2(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, s, -s, c);
}

float maxComp(vec2 v) { return max(v.x, v.y); }
float maxComp(vec3 v) { return max(v.x, max(v.y, v.z)); }
float maxComp(vec4 v) { return max(max(v.x, v.y), max(v.z, v.w)); }
float minComp(vec2 v) { return min(v.x, v.y); }
float minComp(vec3 v) { return min(v.x, min(v.y, v.z)); }
float minComp(vec4 v) { return min(min(v.x, v.y), min(v.z, v.w)); }

/** Normalize without producing NaNs for degenerate vectors. */
vec2 safeNormalize(vec2 v) {
  float l2 = dot(v, v);
  return l2 > 1.0e-12 ? v * inversesqrt(l2) : vec2(0.0, 1.0);
}
vec3 safeNormalize(vec3 v) {
  float l2 = dot(v, v);
  return l2 > 1.0e-12 ? v * inversesqrt(l2) : vec3(0.0, 1.0, 0.0);
}

/** Polynomial smooth minimum (k = blend width). */
float smin(float a, float b, float k) {
  float kk = max(k, 1.0e-5);
  float h = saturate(0.5 + 0.5 * (b - a) / kk);
  return mix(b, a, h) - kk * h * (1.0 - h);
}

/** Polynomial smooth maximum. */
float smax(float a, float b, float k) {
  return -smin(-a, -b, k);
}

/** Cubic falloff in [0,1] used for radial masks. */
float bump(float x) {
  float t = saturate(1.0 - x);
  return t * t * (3.0 - 2.0 * t);
}

#endif
`;

/* ------------------------------------------------------------------------ */
/* packing                                                                   */
/* ------------------------------------------------------------------------ */
const PACKING = `
#ifndef VOX_PACKING_INCLUDED
#define VOX_PACKING_INCLUDED
#include <math>

/** Octahedral encode a unit vector into [0,1]^2. */
vec2 octEncode(vec3 n) {
  vec3 v = n / max(abs(n.x) + abs(n.y) + abs(n.z), 1.0e-8);
  vec2 e = v.xy;
  if (v.z < 0.0) {
    e = (1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
  }
  return e * 0.5 + 0.5;
}

/** Inverse of octEncode. */
vec3 octDecode(vec2 f) {
  vec2 e = f * 2.0 - 1.0;
  vec3 n = vec3(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  float t = saturate(-n.z);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return safeNormalize(n);
}

/** Pack an LDR colour into a single float (8 bits per channel, exact in highp). */
float packColor(vec3 c) {
  vec3 q = floor(saturate(c) * 255.0 + 0.5);
  return q.r * 65536.0 + q.g * 256.0 + q.b;
}

/** Inverse of packColor. */
vec3 unpackColor(float v) {
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  return vec3(r, g, b) * (1.0 / 255.0);
}

/** Pack two [0,1] values into one float with 12 bits each. */
float pack2x12(vec2 v) {
  vec2 q = floor(saturate(v) * 4095.0 + 0.5);
  return q.x * 4096.0 + q.y;
}

/** Inverse of pack2x12. */
vec2 unpack2x12(float v) {
  float x = floor(v / 4096.0);
  return vec2(x, v - x * 4096.0) * (1.0 / 4095.0);
}

#endif
`;

/* ------------------------------------------------------------------------ */
/* color                                                                     */
/* ------------------------------------------------------------------------ */
const COLOR = `
#ifndef VOX_COLOR_INCLUDED
#define VOX_COLOR_INCLUDED
#include <math>

float srgbToLinear(float c) {
  float lo = c / 12.92;
  float hi = pow(max((c + 0.055) / 1.055, 0.0), 2.4);
  return c <= 0.04045 ? lo : hi;
}
vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

float linearToSrgb(float c) {
  float v = max(c, 0.0);
  float lo = v * 12.92;
  float hi = 1.055 * pow(v, 1.0 / 2.4) - 0.055;
  return v <= 0.0031308 ? lo : hi;
}
vec3 linearToSrgb(vec3 c) {
  vec3 v = max(c, vec3(0.0));
  vec3 lo = v * 12.92;
  vec3 hi = 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), v));
}

/** Rec.709 relative luminance of a linear colour. */
float luminance(vec3 c) { return dot(c, vec3(0.2126729, 0.7151522, 0.0721750)); }

// Stephen Hill's fit of the ACES RRT + ODT (sRGB output).
const mat3 VOX_ACES_INPUT = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);

const mat3 VOX_ACES_OUTPUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

vec3 voxRrtAndOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / max(b, vec3(1.0e-7));
}

/** ACES filmic tonemap (Stephen Hill RRT/ODT fit). Input and output linear. */
vec3 acesFitted(vec3 color) {
  vec3 c = VOX_ACES_INPUT * max(color, vec3(0.0));
  c = voxRrtAndOdtFit(c);
  c = VOX_ACES_OUTPUT * c;
  return saturate(c);
}

/** Reinhard-Jodie tonemap: preserves saturation better than plain Reinhard. */
vec3 reinhardJodie(vec3 c) {
  vec3 v = max(c, vec3(0.0));
  float l = luminance(v);
  vec3 tc = v / (v + 1.0);
  return mix(v / (1.0 + l), tc, tc);
}

const mat3 VOX_LIN_2_LMS = mat3(
  3.90405e-1, 7.08416e-2, 2.31082e-2,
  5.49941e-1, 9.63172e-1, 1.28021e-1,
  8.92632e-3, 1.35775e-3, 9.36245e-1);

const mat3 VOX_LMS_2_LIN = mat3(
   2.85847e+0, -2.10182e-1, -4.18120e-2,
  -1.62879e+0,  1.15820e+0, -1.18169e-1,
  -2.48910e-2,  3.24281e-4,  1.06867e+0);

/**
 * Von-Kries white balance in LMS space.
 * temperature/tint are artistic offsets in [-1,1]; 0 leaves the image untouched.
 */
vec3 whiteBalance(vec3 color, float temperature, float tint) {
  float t1 = clamp(temperature, -1.0, 1.0) * 0.65;
  float t2 = clamp(tint, -1.0, 1.0) * 0.65;
  float x = 0.31271 - t1 * (t1 < 0.0 ? 0.1 : 0.05);
  float standardY = 2.87 * x - 3.0 * x * x - 0.27509507;
  float y = standardY + t2 * 0.05;
  float bigY = 1.0;
  float bigX = bigY * x / max(y, 1.0e-4);
  float bigZ = bigY * (1.0 - x - y) / max(y, 1.0e-4);
  float l =  0.7328 * bigX + 0.4296 * bigY - 0.1624 * bigZ;
  float m = -0.7036 * bigX + 1.6975 * bigY + 0.0061 * bigZ;
  float s =  0.0030 * bigX + 0.0136 * bigY + 0.9834 * bigZ;
  vec3 balance = vec3(0.949237, 1.03542, 1.08728) / max(vec3(l, m, s), vec3(1.0e-4));
  vec3 lms = VOX_LIN_2_LMS * max(color, vec3(0.0));
  lms *= balance;
  return VOX_LMS_2_LIN * lms;
}

/** Classic lift / gamma / gain grade. Neutral values: lift 0, gamma 1, gain 1. */
vec3 liftGammaGain(vec3 color, vec3 lift, vec3 gamma, vec3 gain) {
  vec3 c = max(color, vec3(0.0));
  c = c * gain + lift * (1.0 - c);
  c = max(c, vec3(0.0));
  return pow(c, 1.0 / max(gamma, vec3(1.0e-4)));
}

/** Saturation / contrast around a mid-grey pivot, in linear light. */
vec3 adjustSaturationContrast(vec3 color, float saturation, float contrast) {
  vec3 c = max(color, vec3(0.0));
  c = mix(vec3(luminance(c)), c, saturation);
  const float pivot = 0.18;
  c = max(pow(max(c, vec3(0.0)) / pivot, vec3(contrast)) * pivot, vec3(0.0));
  return c;
}

#endif
`;

/* ------------------------------------------------------------------------ */
/* depth                                                                     */
/* ------------------------------------------------------------------------ */
const DEPTH = `
#ifndef VOX_DEPTH_INCLUDED
#define VOX_DEPTH_INCLUDED
#include <frame>

/**
 * Convert a window-space depth value (0..1, as sampled from the depth buffer)
 * into a positive view-space distance along -Z. Standard perspective, no
 * reversed-Z.
 */
float linearizeDepth(float d) {
  float near = u_camPos.w;
  float far = u_camDir.w;
  float z = d * 2.0 - 1.0;
  return (2.0 * near * far) / max(far + near - z * (far - near), 1.0e-6);
}

/** Reconstruct the view-space position of a pixel. */
vec3 viewFromDepth(vec2 uv, float d) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = u_invProj * ndc;
  return v.xyz / (abs(v.w) < 1.0e-8 ? 1.0 : v.w);
}

/** Reconstruct the world-space position of a pixel. */
vec3 worldFromDepth(vec2 uv, float d) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 w = u_invViewProj * ndc;
  return w.xyz / (abs(w.w) < 1.0e-8 ? 1.0 : w.w);
}

/** Project a world position back to a window-space depth value in [0,1]. */
float depthFromWorld(vec3 p) {
  vec4 clip = u_viewProj * vec4(p, 1.0);
  float w = abs(clip.w) < 1.0e-8 ? 1.0 : clip.w;
  return clip.z / w * 0.5 + 0.5;
}

/** Screen-space uv (0..1) of a world position. */
vec2 uvFromWorld(vec3 p) {
  vec4 clip = u_viewProj * vec4(p, 1.0);
  float w = abs(clip.w) < 1.0e-8 ? 1.0 : clip.w;
  return clip.xy / w * 0.5 + 0.5;
}

/** Normalized world-space ray direction through a screen uv. */
vec3 rayFromUV(vec2 uv) {
  vec4 far = u_invViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 p = far.xyz / (abs(far.w) < 1.0e-8 ? 1.0 : far.w);
  return normalize(p - u_camPos.xyz);
}

#endif
`;

/* ------------------------------------------------------------------------ */
/* noise                                                                     */
/* ------------------------------------------------------------------------ */
const NOISE = `
#ifndef VOX_NOISE_INCLUDED
#define VOX_NOISE_INCLUDED
#include <math>

vec3 vnMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 vnMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 vnPermute(vec4 x) { return vnMod289(((x * 34.0) + 1.0) * x); }
vec4 vnTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

/** Trilinear value noise in [0,1]. */
float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

/** True gradient simplex noise (Ashima/Gustavson 3D), range about [-1,1]. */
float simplex3(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = vnMod289(i);
  vec4 p = vnPermute(vnPermute(vnPermute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = vnTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/** Fractal Brownian motion over simplex3; range about [-1,1]. */
float fbm3(vec3 p, int octaves) {
  int n = clamp(octaves, 1, 8);
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  vec3 q = p;
  for (int i = 0; i < 8; ++i) {
    if (i >= n) break;
    sum += amp * simplex3(q);
    norm += amp;
    q = q * 2.02 + vec3(17.13, 5.71, 11.37);
    amp *= 0.5;
  }
  return sum / max(norm, 1.0e-5);
}

/** Ridged fbm, range about [0,1]; useful for mountains and cloud detail. */
float ridged3(vec3 p, int octaves) {
  int n = clamp(octaves, 1, 8);
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  vec3 q = p;
  for (int i = 0; i < 8; ++i) {
    if (i >= n) break;
    float s = 1.0 - abs(simplex3(q));
    sum += amp * s * s;
    norm += amp;
    q = q * 2.03 + vec3(9.17, 23.31, 3.77);
    amp *= 0.5;
  }
  return sum / max(norm, 1.0e-5);
}

/** Worley / cellular noise: distance to the nearest feature point, about [0,1]. */
float worley3(vec3 p) {
  vec3 base = floor(p);
  vec3 f = fract(p);
  float best = 8.0;
  for (int z = -1; z <= 1; ++z) {
    for (int y = -1; y <= 1; ++y) {
      for (int x = -1; x <= 1; ++x) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 o = hash33(base + g);
        vec3 r = g + o - f;
        best = min(best, dot(r, r));
      }
    }
  }
  return sqrt(best);
}

/** Inverted worley, 1 at cell centres — the classic billow cloud base. */
float worleyFbm3(vec3 p, int octaves) {
  int n = clamp(octaves, 1, 4);
  float amp = 0.625;
  float sum = 0.0;
  float norm = 0.0;
  vec3 q = p;
  for (int i = 0; i < 4; ++i) {
    if (i >= n) break;
    sum += amp * (1.0 - worley3(q));
    norm += amp;
    q *= 2.0;
    amp *= 0.5;
  }
  return sum / max(norm, 1.0e-5);
}

/** Y component of the curl of a simplex noise vector field (divergence free). */
float curlY(vec3 p) {
  const float e = 0.15;
  const vec3 offsetX = vec3(19.31, 7.77, 41.13);
  const vec3 offsetZ = vec3(-53.17, 23.71, 5.09);
  float dFxdz = (simplex3(p + vec3(0.0, 0.0, e) + offsetX) -
                 simplex3(p - vec3(0.0, 0.0, e) + offsetX)) / (2.0 * e);
  float dFzdx = (simplex3(p + vec3(e, 0.0, 0.0) + offsetZ) -
                 simplex3(p - vec3(e, 0.0, 0.0) + offsetZ)) / (2.0 * e);
  return dFxdz - dFzdx;
}

/** Cheap domain warp used by terrain-ish material patterns. */
vec3 warp3(vec3 p, float strength) {
  vec3 q = vec3(simplex3(p + vec3(0.0, 0.0, 0.0)),
                simplex3(p + vec3(5.2, 1.3, 7.1)),
                simplex3(p + vec3(9.7, 4.4, 2.9)));
  return p + q * strength;
}

#endif
`;

/* ------------------------------------------------------------------------ */
/* pbr                                                                       */
/* ------------------------------------------------------------------------ */
const PBR = `
#ifndef VOX_PBR_INCLUDED
#define VOX_PBR_INCLUDED
#include <math>

/** Trowbridge-Reitz (GGX) normal distribution. a = roughness^2. */
float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / max(PI * d * d, 1.0e-7);
}

/** Height-correlated Smith visibility term (already divided by 4*NoL*NoV). */
float V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float lambdaV = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float lambdaL = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(lambdaV + lambdaL, 1.0e-5);
}

/** Schlick Fresnel. */
vec3 F_Schlick(float u, vec3 f0) {
  return f0 + (vec3(1.0) - f0) * pow5(1.0 - saturate(u));
}

/** Schlick Fresnel with an explicit f90. */
vec3 F_Schlick(float u, vec3 f0, float f90) {
  return f0 + (vec3(f90) - f0) * pow5(1.0 - saturate(u));
}

/** Disney/Burley diffuse (energy normalised, already divided by PI). */
float Fd_Burley(float NoV, float NoL, float LoH, float a) {
  float f90 = 0.5 + 2.0 * a * LoH * LoH;
  float lightScatter = 1.0 + (f90 - 1.0) * pow5(1.0 - saturate(NoL));
  float viewScatter = 1.0 + (f90 - 1.0) * pow5(1.0 - saturate(NoV));
  return lightScatter * viewScatter * INV_PI;
}

/** Karis' analytic environment BRDF fit (split-sum approximation, no LUT). */
vec3 envBRDFApprox(vec3 f0, float roughness, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = roughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * saturate(NoV))) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

/** Specular occlusion derived from diffuse AO (Lagarde). */
float specularOcclusion(float NoV, float ao, float roughness) {
  return saturate(pow(saturate(NoV + ao), exp2(-16.0 * roughness - 1.0)) - 1.0 + ao);
}

/**
 * Direct lighting for one analytic light.
 * N, V and L must be normalized; V points from the surface toward the camera and
 * L from the surface toward the light. lightColor already contains intensity and
 * shadowing. Returns linear radiance.
 */
vec3 evalDirect(vec3 albedo, float metal, float rough, vec3 N, vec3 V, vec3 L, vec3 lightColor) {
  float perceptual = clamp(rough, 0.045, 1.0);
  float a = perceptual * perceptual;
  vec3 H = safeNormalize(V + L);
  float NoV = abs(dot(N, V)) + 1.0e-5;
  float NoL = saturate(dot(N, L));
  if (NoL <= 0.0) return vec3(0.0);
  float NoH = saturate(dot(N, H));
  float LoH = saturate(dot(L, H));

  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 diffuseColor = albedo * (1.0 - metal);

  float D = D_GGX(NoH, a);
  float Vis = V_SmithGGX(NoV, NoL, a);
  vec3 F = F_Schlick(LoH, f0);

  vec3 specular = (D * Vis) * F;
  vec3 diffuse = diffuseColor * Fd_Burley(NoV, NoL, LoH, a);
  return (diffuse + specular) * lightColor * NoL;
}

/**
 * Hemispheric ambient: sky irradiance from above, bounce from below, plus an
 * approximate environment specular using the Karis BRDF fit.
 */
vec3 evalAmbient(vec3 albedo, float metal, float rough, vec3 N, vec3 V,
                 vec3 skyCol, vec3 groundCol, float ao) {
  float perceptual = clamp(rough, 0.045, 1.0);
  float NoV = saturate(dot(N, V)) + 1.0e-5;
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 diffuseColor = albedo * (1.0 - metal);

  float hemi = N.y * 0.5 + 0.5;
  vec3 irradiance = mix(groundCol, skyCol, hemi);
  vec3 diffuse = diffuseColor * irradiance * ao;

  vec3 R = reflect(-V, N);
  float rHemi = R.y * 0.5 + 0.5;
  vec3 envColor = mix(groundCol, skyCol, rHemi);
  // Rough surfaces converge toward the average of the two hemispheres.
  envColor = mix(envColor, mix(groundCol, skyCol, 0.6), saturate(perceptual * perceptual));

  vec3 specular = envColor * envBRDFApprox(f0, perceptual, NoV) *
                  specularOcclusion(NoV, ao, perceptual);
  return diffuse + specular;
}

/** Wrapped diffuse for foliage / subsurface-ish materials. */
float wrapDiffuse(float NoL, float wrapAmount) {
  return saturate((NoL + wrapAmount) / sq(1.0 + wrapAmount));
}

#endif
`;

/* ------------------------------------------------------------------------ */
/* sky                                                                       */
/* ------------------------------------------------------------------------ */
const SKY = `
#ifndef VOX_SKY_INCLUDED
#define VOX_SKY_INCLUDED
#include <frame>
#include <math>

/** Rayleigh phase function. */
float rayleighPhase(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

/** Cornette-Shanks Mie phase function. */
float miePhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (3.0 / (8.0 * PI)) * ((1.0 - g2) * (1.0 + cosTheta * cosTheta)) /
         ((2.0 + g2) * pow(max(denom, 1.0e-4), 1.5));
}

/** Relative air mass for a ray leaving the ground with vertical component up. */
float airMass(float up) {
  return 1.0 / (max(up, 0.0) + 0.09);
}

// Relative scattering coefficients, tuned so the zenith reads ~(0.2,0.45,0.75).
const vec3 VOX_BETA_R = vec3(0.0396, 0.0936, 0.1610);
const vec3 VOX_BETA_M = vec3(0.0336);

/**
 * Cheap analytic Rayleigh + Mie sky. 'dir' is a world-space direction (need not
 * be normalized). Returns linear radiance including the ground half, horizon
 * haze, the moon at night and rain darkening (u_time.w).
 */
vec3 analyticSky(vec3 dir) {
  vec3 d = safeNormalize(dir);
  vec3 s = safeNormalize(u_sunDir.xyz);
  vec3 m = safeNormalize(u_moonDir.xyz);
  float rain = saturate(u_time.w);

  vec3 betaR = VOX_BETA_R;
  vec3 betaM = VOX_BETA_M * mix(1.0, 2.5, rain);

  float viewMass = airMass(d.y);
  vec3 viewTransmit = exp(-(betaR + betaM) * viewMass);
  vec3 sunTransmit = exp(-(betaR + betaM) * airMass(s.y));
  vec3 moonTransmit = exp(-(betaR + betaM) * airMass(m.y));

  float cosS = dot(d, s);
  float cosM = dot(d, m);
  float g = mix(0.76, 0.55, rain);

  vec3 sunLight = u_sunColor.rgb * max(u_sunColor.w, 0.0) * smoothstep(-0.18, 0.03, s.y);
  float moonBright = mix(0.12, 1.0, abs(u_moonDir.w * 2.0 - 1.0));
  vec3 moonLight = vec3(0.055, 0.075, 0.135) * moonBright * smoothstep(-0.12, 0.06, m.y);

  vec3 scatterSun = (betaR * rayleighPhase(cosS) + betaM * miePhase(cosS, g)) *
                    viewMass * sunTransmit * sunLight;
  vec3 scatterMoon = (betaR * rayleighPhase(cosM) + betaM * miePhase(cosM, g * 0.6)) *
                     viewMass * moonTransmit * moonLight;

  vec3 col = (scatterSun + scatterMoon) * 12.0;

  // Never fully black: a small ambient floor keeps night scenes readable.
  col += u_skyAmbient.rgb * max(u_skyAmbient.w, 0.0) * 0.12 * viewTransmit;

  // Ground half of the sphere.
  float below = saturate(-d.y * 6.0);
  vec3 groundCol = u_fogColor.rgb * (0.30 + 0.55 * saturate(s.y + 0.25));
  col = mix(col, groundCol, below);

  // Horizon haze.
  float haze = pow(1.0 - saturate(abs(d.y)), 6.0);
  col = mix(col, mix(col, u_fogColor.rgb, 0.65), haze * (0.35 + 0.5 * rain));

  // Rain desaturates and darkens the dome.
  float lum = dot(col, vec3(0.2126729, 0.7151522, 0.0721750));
  col = mix(col, vec3(lum) * vec3(0.86, 0.90, 0.98), rain * 0.7);
  col *= mix(1.0, 0.45, rain);

  return max(col, vec3(0.0));
}

/**
 * Radiance of the sun disk for a view direction, with quadratic limb darkening.
 * Returns black outside the disk.
 */
vec3 sunDiskColor(vec3 dir) {
  vec3 d = safeNormalize(dir);
  vec3 s = safeNormalize(u_sunDir.xyz);
  float cosT = dot(d, s);
  const float angularRadius = 0.0093;  // ~0.53 deg, slightly enlarged for looks
  float edge = cos(angularRadius);
  if (cosT <= edge) return vec3(0.0);

  float theta = acos(clamp(cosT, -1.0, 1.0));
  float r = saturate(theta / angularRadius);
  float mu = sqrt(max(1.0e-4, 1.0 - r * r));

  // Hestroffer-Magnan style limb darkening, redder toward the rim.
  const vec3 u = vec3(0.397, 0.503, 0.652);
  const vec3 a = vec3(0.13, 0.17, 0.20);
  vec3 limb = 1.0 - u * (1.0 - pow(vec3(mu), a));

  vec3 sunLight = u_sunColor.rgb * max(u_sunColor.w, 0.0);
  float horizon = smoothstep(-0.06, 0.10, s.y);
  float rain = saturate(u_time.w);
  float softEdge = smoothstep(1.0, 0.92, r);
  return sunLight * limb * (14.0 * horizon * softEdge) * (1.0 - 0.85 * rain);
}

/** Radiance of the moon disk, phase-shaded, used by the sky pass. */
vec3 moonDiskColor(vec3 dir) {
  vec3 d = safeNormalize(dir);
  vec3 m = safeNormalize(u_moonDir.xyz);
  float cosT = dot(d, m);
  const float angularRadius = 0.014;
  float edge = cos(angularRadius);
  if (cosT <= edge) return vec3(0.0);
  float theta = acos(clamp(cosT, -1.0, 1.0));
  float r = saturate(theta / angularRadius);
  float mu = sqrt(max(1.0e-4, 1.0 - r * r));
  float bright = mix(0.10, 1.0, abs(u_moonDir.w * 2.0 - 1.0));
  float horizon = smoothstep(-0.05, 0.10, m.y);
  float softEdge = smoothstep(1.0, 0.94, r);
  return vec3(0.85, 0.90, 1.0) * (bright * horizon * softEdge * (0.25 + 0.75 * mu)) *
         (1.0 - 0.9 * saturate(u_time.w));
}

#endif
`;

/* ------------------------------------------------------------------------ */
/* fog                                                                       */
/* ------------------------------------------------------------------------ */
const FOG = `
#ifndef VOX_FOG_INCLUDED
#define VOX_FOG_INCLUDED
#include <frame>
#include <math>

/**
 * Exponential-squared height fog. Density comes from u_fogColor.w, thinned by
 * the camera altitude above sea level (u_params.y), and forced to 1 at the edge
 * of the render distance (u_params.x) so chunk pop-in is hidden.
 */
float fogFactor(float dist) {
  float density = max(u_fogColor.w, 0.0);
  float altitude = max(u_camPos.y - u_params.y, 0.0);
  float heightAtten = exp(-altitude * 0.006);
  float d = max(dist, 0.0) * density * heightAtten;
  float f = 1.0 - exp(-d * d);

  float renderDist = max(u_params.x, 32.0);
  float edge = saturate((dist - renderDist * 0.80) / max(renderDist * 0.20, 1.0));
  f = max(f, edge * edge);

  // Underwater the medium is much denser.
  float underwater = saturate(u_params.w);
  float uw = 1.0 - exp(-sq(max(dist, 0.0) * 0.075));
  f = mix(f, max(f, uw), underwater);
  return saturate(f);
}

/**
 * Blend a shaded colour toward the fog colour, tinted by sun inscattering when
 * looking toward the sun and darkened by rain (u_time.w).
 */
vec3 applyFog(vec3 color, vec3 worldPos, vec3 viewDir, float dist) {
  float f = fogFactor(dist);
  if (f <= 0.0) return color;

  vec3 v = safeNormalize(viewDir);
  vec3 s = safeNormalize(u_sunDir.xyz);
  float sunAmount = saturate(dot(v, s));
  float rain = saturate(u_time.w);

  vec3 base = u_fogColor.rgb;
  vec3 inscatter = u_sunColor.rgb * max(u_sunColor.w, 0.0) * smoothstep(-0.10, 0.15, s.y);
  vec3 fogCol = mix(base, base * 0.55 + inscatter * 0.60, pow(sunAmount, 6.0) * (1.0 - 0.7 * rain));

  // Fog is denser and slightly darker down low.
  float heightBlend = saturate((worldPos.y - (u_params.y - 32.0)) / 112.0);
  fogCol *= mix(0.78, 1.06, heightBlend);
  fogCol = mix(fogCol, fogCol * vec3(0.72, 0.76, 0.84), rain * 0.6);

  float underwater = saturate(u_params.w);
  fogCol = mix(fogCol, fogCol * vec3(0.22, 0.52, 0.72), underwater);

  return mix(color, fogCol, f);
}

#endif
`;

/* ------------------------------------------------------------------------ */
/* shadows                                                                   */
/* ------------------------------------------------------------------------ */
const SHADOWS = `
#ifndef VOX_SHADOWS_INCLUDED
#define VOX_SHADOWS_INCLUDED
#include <frame>
#include <math>

layout(std140) uniform Shadows {
  mat4 u_csmMatrix[4];
  vec4 u_csmSplits;    // view-space far distance per cascade
  vec4 u_csmTexel;     // world units per shadow texel per cascade
  vec4 u_shadowParams; // x=cascadeCount, y=depthBias, z=normalBias, w=softness
};

uniform sampler2DArray u_shadowMap;

#ifndef SHADOW_PCF_TAPS
#define SHADOW_PCF_TAPS 16
#endif

const vec2 VOX_POISSON16[16] = vec2[16](
  vec2(-0.94201624, -0.39906216), vec2( 0.94558609, -0.76890725),
  vec2(-0.09418410, -0.92938870), vec2( 0.34495938,  0.29387760),
  vec2(-0.91588581,  0.45771432), vec2(-0.81544232, -0.87912464),
  vec2(-0.38277543,  0.27676845), vec2( 0.97484398,  0.75648379),
  vec2( 0.44323325, -0.97511554), vec2( 0.53742981, -0.47373420),
  vec2(-0.26496911, -0.41893023), vec2( 0.79197514,  0.19090188),
  vec2(-0.24188840,  0.99706507), vec2(-0.81409955,  0.91437590),
  vec2( 0.19984126,  0.78641367), vec2( 0.14383161, -0.14100790)
);

mat4 csmMatrix(int i) {
  if (i <= 0) return u_csmMatrix[0];
  if (i == 1) return u_csmMatrix[1];
  if (i == 2) return u_csmMatrix[2];
  return u_csmMatrix[3];
}

float csmSplit(int i) {
  if (i <= 0) return u_csmSplits.x;
  if (i == 1) return u_csmSplits.y;
  if (i == 2) return u_csmSplits.z;
  return u_csmSplits.w;
}

float csmTexel(int i) {
  if (i <= 0) return u_csmTexel.x;
  if (i == 1) return u_csmTexel.y;
  if (i == 2) return u_csmTexel.z;
  return u_csmTexel.w;
}

/** Fetch one shadow-map texel (always LOD 0: safe in divergent control flow). */
float shadowFetch(vec2 uv, int cascade) {
  return textureLod(u_shadowMap, vec3(uv, float(cascade)), 0.0).r;
}

/**
 * Percentage-closer filtering for one cascade.
 * Returns 1 when fully lit, 0 when fully shadowed.
 */
float shadowCascadeLit(vec3 worldPos, int cascade, float slope, float rot) {
  float texel = csmTexel(cascade);

  // Offset along the light direction: removes acne without a surface normal,
  // scaled by the cascade's world-space texel size and the slope.
  vec3 wp = worldPos + u_sunDir.xyz * (texel * max(u_shadowParams.z, 0.0) * (1.0 + 2.0 * slope));

  vec4 clip = csmMatrix(cascade) * vec4(wp, 1.0);
  float w = abs(clip.w) < 1.0e-6 ? 1.0 : clip.w;
  vec3 uvz = clip.xyz / w * 0.5 + 0.5;

  if (uvz.z >= 1.0 || uvz.z <= 0.0) return 1.0;
  if (any(lessThan(uvz.xy, vec2(0.0))) || any(greaterThan(uvz.xy, vec2(1.0)))) return 1.0;

  float texelRatio = texel / max(u_csmTexel.x, 1.0e-5);
  float bias = max(u_shadowParams.y, 0.0) * (1.0 + 2.0 * slope) * texelRatio;

  vec2 texelSize = 1.0 / vec2(textureSize(u_shadowMap, 0).xy);
  float radius = max(u_shadowParams.w, 0.5);

#ifdef SOFT_SHADOWS
  // PCSS blocker search -> penumbra width estimate.
  float blockerSum = 0.0;
  float blockerCount = 0.0;
  float searchRadius = radius * 3.5;
  for (int i = 0; i < 8; ++i) {
    vec2 o = VOX_POISSON16[i] * searchRadius * texelSize;
    float d = shadowFetch(uvz.xy + o, cascade);
    if (d < uvz.z - bias) {
      blockerSum += d;
      blockerCount += 1.0;
    }
  }
  if (blockerCount > 0.0) {
    float avgBlocker = blockerSum / blockerCount;
    float penumbra = (uvz.z - avgBlocker) / max(avgBlocker, 1.0e-4);
    radius = clamp(radius * (1.0 + penumbra * 42.0), radius, radius * 8.0);
  }
#endif

  float s = sin(rot);
  float c = cos(rot);
  mat2 rm = mat2(c, s, -s, c);

  float lit = 0.0;
  for (int i = 0; i < SHADOW_PCF_TAPS; ++i) {
    vec2 o = rm * VOX_POISSON16[i] * radius * texelSize;
    float d = shadowFetch(uvz.xy + o, cascade);
    lit += step(uvz.z - bias, d);
  }
  return lit / float(SHADOW_PCF_TAPS);
}

/**
 * Cascaded shadow lookup.
 * @param worldPos  world-space position of the shaded point
 * @param NdotL     dot(surface normal, light direction), used for slope bias
 * @param viewDepth positive view-space distance of the point from the camera
 * returns 1 = lit, 0 = fully shadowed
 */
float sampleShadow(vec3 worldPos, float NdotL, float viewDepth) {
  int count = int(u_shadowParams.x + 0.5);
  if (count <= 0) return 1.0;
  if (NdotL <= 0.0) return 0.0;

  float slope = clamp(sqrt(max(0.0, 1.0 - NdotL * NdotL)) / max(NdotL, 0.05), 0.0, 6.0);

  int cascade = 0;
  if (viewDepth > u_csmSplits.x) cascade = 1;
  if (viewDepth > u_csmSplits.y) cascade = 2;
  if (viewDepth > u_csmSplits.z) cascade = 3;
  cascade = min(cascade, count - 1);

#ifdef STAGE_FRAGMENT
  vec2 noiseSeed = gl_FragCoord.xy;
#else
  vec2 noiseSeed = worldPos.xz * 8.0;
#endif
  float rot = hash21(noiseSeed) * TAU;

  float lit = shadowCascadeLit(worldPos, cascade, slope, rot);

  // Cross-fade band so cascade boundaries are invisible.
  if (cascade + 1 < count) {
    float far = csmSplit(cascade);
    float band = max(far * 0.12, 1.0);
    float t = saturate((viewDepth - (far - band)) / band);
    if (t > 0.0) {
      lit = mix(lit, shadowCascadeLit(worldPos, cascade + 1, slope, rot), t);
    }
  }

  // Fade the last cascade out at its far edge instead of hard-popping to lit.
  float lastFar = csmSplit(count - 1);
  float fade = saturate((viewDepth - lastFar * 0.9) / max(lastFar * 0.1, 1.0));
  lit = mix(lit, 1.0, fade);

  return saturate(lit);
}

/** Debug helper: index of the cascade a view depth falls into. */
int shadowCascadeIndex(float viewDepth) {
  int count = int(u_shadowParams.x + 0.5);
  int cascade = 0;
  if (viewDepth > u_csmSplits.x) cascade = 1;
  if (viewDepth > u_csmSplits.y) cascade = 2;
  if (viewDepth > u_csmSplits.z) cascade = 3;
  return min(cascade, max(count - 1, 0));
}

#endif
`;

/**
 * Shared GLSL chunks, keyed by the name used in `#include <name>`.
 *
 * Sources contain no `#version` and no precision qualifiers — `core/gl.js`
 * prepends both. Chunks include their own dependencies; the preprocessor expands
 * each chunk at most once per shader.
 *
 * @type {{frame:string, shadows:string, math:string, noise:string, color:string,
 *         depth:string, pbr:string, fog:string, sky:string, packing:string}}
 */
export const GLSL_CHUNKS = {
  frame: FRAME,
  shadows: SHADOWS,
  math: MATH,
  noise: NOISE,
  color: COLOR,
  depth: DEPTH,
  pbr: PBR,
  fog: FOG,
  sky: SKY,
  packing: PACKING,
};

/**
 * Register every shared chunk on a {@link GL} device so shaders can `#include` them.
 * Safe to call more than once (registration replaces by name).
 *
 * @param {{registerInclude:function(string,string):void}} gl the VOXELIA GL device
 * @returns {string[]} the names that were registered
 */
export function registerCommonChunks(gl) {
  const names = Object.keys(GLSL_CHUNKS);
  for (const name of names) gl.registerInclude(name, GLSL_CHUNKS[name]);
  return names;
}
