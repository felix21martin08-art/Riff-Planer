/**
 * VOXELIA — procedural GPU texture factory (ARCHITECTURE.md section 5.16).
 *
 * There is not a single image file in this engine. Every texel of every block
 * texture, the blue-noise dither mask, the 3D cloud noise and the 3D item icons
 * shown in the UI are generated here, on the GPU, from the material table in
 * `world/materials.js`.
 *
 * ## What this module produces
 *
 * | resource      | target             | format | size                         |
 * |---------------|--------------------|--------|------------------------------|
 * | `albedoArray` | `TEXTURE_2D_ARRAY` | RGBA8  | `res x res x MATERIAL_COUNT` |
 * | `normalArray` | `TEXTURE_2D_ARRAY` | RGBA8  | `res x res x MATERIAL_COUNT` |
 * | `mraeArray`   | `TEXTURE_2D_ARRAY` | RGBA8  | `res x res x MATERIAL_COUNT` |
 * | `blueNoise`   | `TEXTURE_2D`       | R8     | `64 x 64`                    |
 * | `cloudNoise`  | `TEXTURE_3D`       | RGBA8  | `64^3` or `128^3`            |
 *
 * Channel contract (ARCHITECTURE.md 3.6):
 * * `ALBEDO` rgb = linear albedo, a = coverage / opacity mask.
 * * `NORMAL` rgb = tangent-space normal `n * 0.5 + 0.5`, a = height (parallax).
 * * `MRAE`   r = metallic, g = roughness, b = baked AO/cavity, a = emissive.
 *
 * ## How a layer is built
 *
 * One fullscreen pass per material renders into all three arrays at once (MRT
 * with three color attachments, each pointed at the material's layer through
 * `framebufferTextureLayer`). The "uber" fragment shader switches on
 * `u_pattern` and evaluates a hand-written procedural function per pattern.
 *
 * Every pattern is written as a **height field** `h(uv)`; the tangent-space
 * normal is derived analytically from that field by sampling it on a ring of
 * `u_taps` offsets one texel wide and reconstructing the gradient
 * (`N = normalize(vec3(-dh/du * relief, -dh/dv * relief, 1))`, OpenGL "green
 * up" convention). Normals are therefore always consistent with the parallax
 * height in `NORMAL.a` — nothing here fakes a normal from luminance.
 *
 * Everything tiles seamlessly: all noise, worley and hash lookups wrap their
 * cell coordinates with `mod(cell, period)`, so the left edge of a tile hashes
 * to exactly the same value as the right edge.
 *
 * @module render/textures
 */

import { FULLSCREEN_VS } from '../core/gl.js';
import { MATERIALS, MATERIAL_COUNT, PATTERNS, patternId } from '../world/materials.js';
import { mulberry32, mat4, clamp } from '../core/math.js';
import { nextFrame, TimeBudget } from '../core/util.js';
import { faceMaterial, blockRender, blockTint, RENDER, getBlock } from '../world/blocks.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Supported texture-array edge sizes. @type {readonly number[]} */
export const TEXTURE_RESOLUTIONS = Object.freeze([128, 256, 512, 1024]);

/** Edge size of the generated blue-noise mask. @type {number} */
export const BLUE_NOISE_SIZE = 64;

/**
 * Soft VRAM ceiling for the three texture arrays together (bytes, mips
 * included). `MATERIAL_COUNT` is ~271, so 512 px costs ~1.1 GB and 1024 px
 * would cost ~4.5 GB — the resolution is clamped down rather than crashing the
 * driver, exactly as `world/materials.js` asks for.
 * @type {number}
 */
const VRAM_BUDGET_BYTES = 1.45 * 1024 * 1024 * 1024;

/** Milliseconds of GPU submission work per event-loop slice. @type {number} */
const SLICE_BUDGET_MS = 12;

/** Fixed texture units from ARCHITECTURE.md 3.5. @type {Readonly<Object<string,number>>} */
const UNIT = Object.freeze({ ALBEDO: 0, NORMAL: 1, MRAE: 2, BLUE_NOISE: 11, CLOUD: 13 });

/* ========================================================================== */
/* GLSL — the uber generator                                                  */
/* ========================================================================== */

/**
 * `#define PAT_<NAME> <index>` for every entry of `PATTERNS`, so the shader's
 * `switch (u_pattern)` can never drift out of sync with the table.
 * @type {string}
 */
const PATTERN_DEFINES = PATTERNS.map((p, i) => `#define PAT_${p.toUpperCase()} ${i}`).join('\n');

/** Uniforms, the surface struct and every periodic noise primitive. @type {string} */
const GEN_HEAD = `
#include <math>
#include <color>

in vec2 v_uv;

layout(location = 0) out vec4 o_albedo;
layout(location = 1) out vec4 o_normal;
layout(location = 2) out vec4 o_mrae;

uniform int   u_pattern;    // index into PATTERNS
uniform vec3  u_color;      // primary linear colour
uniform vec3  u_color2;     // secondary / shadow / host colour
uniform vec3  u_color3;     // accent colour
uniform vec4  u_prop;       // roughness, metallic, emissive, relief height
uniform vec4  u_pa;         // params 0..3
uniform vec4  u_pb;         // params 4..7
uniform float u_seed;       // per-material hash salt
uniform float u_scale;      // UV frequency multiplier
uniform float u_alphaMode;  // 1 when the material declares alpha
uniform float u_res;        // texture edge size in texels
uniform int   u_taps;       // gradient ring taps (>= 4)

#define GRAIN   u_pa.x
#define STRUCTP u_pa.y
#define CAVITY  u_pa.z
#define WEAR    u_pa.w
#define HUEV    u_pb.x
#define SPARK   u_pb.y
#define TILEP   u_pb.z
#define CONTR   u_pb.w
#define ROUGHB  u_prop.x
#define METALB  u_prop.y
#define EMITB   u_prop.z
#define RELIEF  u_prop.w
#define C1      u_color
#define C2      u_color2
#define C3      u_color3

/** Fully described surface point produced by a pattern. */
struct Surf {
  vec3  albedo;
  float alpha;
  float metal;
  float rough;
  float ao;
  float emit;
};

/** Neutral starting point: the material's own base properties. */
Surf surfInit() {
  Surf s;
  s.albedo = C1;
  s.alpha = 1.0;
  s.metal = METALB;
  s.rough = ROUGHB;
  s.ao = 1.0;
  s.emit = 0.0;
  return s;
}

/** One texel in UV units. */
float px() { return 1.0 / max(u_res, 8.0); }

/** Integer feature count for a family's documented base cell count. */
float cellsOf(float base) {
  return max(1.0, floor(base * max(TILEP, 0.06) * max(u_scale, 0.05) + 0.5));
}

/** Integer feature count that ignores the tiling parameter (p6 reused by a family). */
float countOf(float base) {
  return max(1.0, floor(base * max(u_scale, 0.05) + 0.5));
}

/* ---------------------------------------------------------------- hashing - */

/** Periodic scalar hash of an integer cell coordinate. */
float ph1(vec2 c, vec2 period, float salt) {
  return hash21(mod(c, max(period, vec2(1.0))) + vec2(salt * 0.7317, salt * 1.1731));
}

/** Periodic 2-vector hash of an integer cell coordinate. */
vec2 ph2(vec2 c, vec2 period, float salt) {
  return hash22(mod(c, max(period, vec2(1.0))) + vec2(salt * 1.1131, salt * 0.5771));
}

/* ------------------------------------------------------------------ noise - */

/** Seamlessly tiling value noise. \`freq\` is rounded to whole cells per tile. */
float pval(vec2 uv, vec2 freq, float salt) {
  vec2 f = max(vec2(1.0), floor(freq + 0.5));
  vec2 p = uv * f;
  vec2 i = floor(p);
  vec2 t = fract(p);
  vec2 u = t * t * (3.0 - 2.0 * t);
  float a = ph1(i, f, salt);
  float b = ph1(i + vec2(1.0, 0.0), f, salt);
  float c = ph1(i + vec2(0.0, 1.0), f, salt);
  float d = ph1(i + vec2(1.0, 1.0), f, salt);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Tiling fractal value noise in [0,1]. */
float pfbm(vec2 uv, vec2 freq, int oct, float salt) {
  vec2 f = max(vec2(1.0), floor(freq + 0.5));
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 8; ++i) {
    if (i >= oct) break;
    sum += amp * pval(uv, f, salt + float(i) * 23.17);
    norm += amp;
    f *= 2.0;
    amp *= 0.5;
  }
  return sum / max(norm, 1.0e-5);
}

/** Tiling ridged fractal noise in [0,1]; sharp creases at the ridges. */
float pridge(vec2 uv, vec2 freq, int oct, float salt) {
  vec2 f = max(vec2(1.0), floor(freq + 0.5));
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 8; ++i) {
    if (i >= oct) break;
    float v = 1.0 - abs(pval(uv, f, salt + float(i) * 11.71) * 2.0 - 1.0);
    sum += amp * v * v;
    norm += amp;
    f *= 2.0;
    amp *= 0.5;
  }
  return sum / max(norm, 1.0e-5);
}

/** Tiling domain warp; returns a displaced UV. */
vec2 pwarp(vec2 uv, vec2 freq, float strength, float salt) {
  return uv + (vec2(pval(uv, freq, salt), pval(uv, freq, salt + 71.3)) - 0.5) * strength;
}

/* ---------------------------------------------------------------- cellular - */

/** Result of a periodic worley lookup. */
struct Cell {
  float f1;     // distance to the nearest feature point, in cell units
  float f2;     // distance to the second nearest
  float id;     // stable per-cell random in [0,1]
  vec2  rel;    // vector from the sample to the nearest feature point
  vec2  coord;  // integer coordinate of the owning cell
};

/** Seamlessly tiling worley/Voronoi field. \`jitter\` in [0,1] keeps points in-cell. */
Cell pcells(vec2 uv, vec2 period, float salt, float jitter) {
  vec2 per = max(vec2(1.0), floor(period + 0.5));
  vec2 p = uv * per;
  vec2 base = floor(p);
  vec2 fr = fract(p);
  Cell o;
  o.f1 = 8.0;
  o.f2 = 8.0;
  o.id = 0.0;
  o.rel = vec2(0.0);
  o.coord = base;
  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      vec2 g = vec2(float(x), float(y));
      vec2 c = base + g;
      vec2 j = ph2(c, per, salt);
      vec2 r = g + vec2(0.5) + (j - 0.5) * clamp(jitter, 0.0, 1.0) - fr;
      float d = length(r);
      if (d < o.f1) {
        o.f2 = o.f1;
        o.f1 = d;
        o.id = ph1(c, per, salt + 61.37);
        o.rel = r;
        o.coord = c;
      } else if (d < o.f2) {
        o.f2 = d;
      }
    }
  }
  return o;
}

/** Ridged worley borders: 1 exactly on a cell boundary, 0 inside a cell. */
float crackLines(vec2 uv, vec2 period, float width, float salt) {
  Cell c = pcells(uv, period, salt, 1.0);
  return 1.0 - smoothstep(0.0, max(width, 0.002), c.f2 - c.f1);
}

/** Isolated round flecks on a jittered grid. \`prob\` is the per-cell chance. */
float speck(vec2 uv, float cells, float prob, float radius, float salt) {
  vec2 n = vec2(max(1.0, floor(cells + 0.5)));
  vec2 p = uv * n;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float on = step(1.0 - clamp(prob, 0.0, 1.0), ph1(i, n, salt));
  vec2 o = ph2(i, n, salt + 3.77);
  float d = length(f - clamp(o, vec2(0.15), vec2(0.85)));
  return on * (1.0 - smoothstep(radius * 0.35, radius, d));
}

/* -------------------------------------------------------------- distances - */

/** Signed distance to an axis-aligned box of half-extent \`b\`. */
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0);
}

/** Distance to the segment a..b. */
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1.0e-8), 0.0, 1.0);
  return length(pa - ba * h);
}

/** Antialiased "inside" mask for a distance field. */
float inside(float d, float soft) {
  return 1.0 - smoothstep(-soft, soft, d);
}

/** Antialiased stroke of width \`w\` centred on a distance value. */
float stroke(float d, float w) {
  return 1.0 - smoothstep(w * 0.55, w * 1.15, d);
}

/* ------------------------------------------------------------ shared fields */

/** Rounded-stone rubble field shared by cobble, gravel and the mossy variants. */
struct Rubble {
  float stone;  // 1 on a stone, 0 in the mortar gap
  float dome;   // 0 at the stone rim, 1 at its crown
  float id;     // per-stone random
  float border; // f2 - f1, distance to the nearest gap
  vec2  rel;    // offset from the stone centre
};

/** Build a rubble field of \`cells\` stones per edge. */
Rubble rubbleField(vec2 uv, float cells, float gapTexels, float wear, float salt) {
  vec2 w = pwarp(uv, vec2(max(2.0, floor(cells * 0.75 + 0.5))), 0.035 + 0.05 * wear, salt + 8.1);
  Cell c = pcells(w, vec2(cells), salt, 0.92);
  float gw = max(gapTexels, 0.4) * cells / max(u_res, 8.0);
  Rubble r;
  r.border = c.f2 - c.f1;
  r.stone = smoothstep(gw * 0.55, gw * 2.1 + 0.012 * wear, r.border);
  r.dome = smoothstep(0.0, 0.30 + 0.12 * wear, r.border);
  r.id = c.id;
  r.rel = c.rel;
  return r;
}

/** Masonry course field shared by bricks, stone bricks and deepslate bricks. */
struct Brick {
  float body;   // 1 inside a brick, 0 in the mortar joint
  float bevel;  // 0 at the brick rim, 1 at its centre
  float id;     // per-brick random
  vec2  local;  // position inside the brick, -0.5..0.5
  float chip;   // 1 where a corner has been chipped away
  float crack;  // 1 on a hairline crack across a cracked brick
};

/** Build a running-bond course field. \`stagger\` offsets odd rows by half a brick. */
Brick brickField(vec2 uv, float rows, float cols, float stagger, float mortar,
                 float chipFrac, float salt) {
  float y = uv.y * rows;
  float ri = floor(y);
  float fy = fract(y);
  float x = uv.x * cols + mod(ri, 2.0) * stagger;
  float ci = floor(x);
  float fx = fract(x);
  vec2 id2 = vec2(ci, ri);
  vec2 per = vec2(cols, rows);

  float mx = mortar * 0.5;
  float my = mortar * 0.5 * (cols / max(rows, 1.0));
  float sx = min(fx, 1.0 - fx);
  float sy = min(fy, 1.0 - fy);

  Brick b;
  b.id = ph1(id2, per, salt);
  b.local = vec2(fx - 0.5, fy - 0.5);

  // Chipped corners: erode the brick outline with a per-brick noise field.
  float chipRand = ph1(id2, per, salt + 17.9);
  float chipOn = step(1.0 - clamp(chipFrac, 0.0, 1.0), chipRand);
  float corner = max(abs(b.local.x) * 2.0, abs(b.local.y) * 2.0);
  float nz = pfbm(uv, vec2(cols * 6.0, rows * 6.0), 3, salt + 5.3);
  float erode = chipOn * smoothstep(0.55, 1.0, corner) * smoothstep(0.35, 0.75, nz);
  b.chip = erode;

  float edge = min(sx / max(mx, 1.0e-4), sy / max(my, 1.0e-4));
  b.body = smoothstep(0.55, 1.35, edge) * (1.0 - smoothstep(0.25, 0.6, erode));
  b.bevel = smoothstep(0.8, 3.2, edge);

  // Hairline crack running across a fraction of the bricks.
  float crackOn = step(1.0 - clamp(chipFrac * 0.9, 0.0, 1.0), ph1(id2, per, salt + 29.1));
  float cl = abs(b.local.y - (b.local.x * (chipRand - 0.5) * 1.4)
                 - (pfbm(uv, vec2(cols * 3.0, rows * 3.0), 3, salt + 41.7) - 0.5) * 0.22);
  b.crack = crackOn * (1.0 - smoothstep(0.008, 0.03, cl)) * b.body;
  return b;
}

/** Clumped granular soil height used by dirt, path, farmland, podzol and mycelium. */
float soilH(vec2 uv, float cells, float pebbles, float compact, float salt) {
  float clod = pfbm(uv, vec2(cells), 4, salt);
  float fine = pfbm(uv, vec2(cells * 6.0), 3, salt + 13.3);
  float big = speck(uv, cells * 1.6, 0.30 * pebbles, 0.42, salt + 27.7);
  float mid = speck(uv, cells * 3.2, 0.32 * pebbles, 0.40, salt + 31.1);
  float sml = speck(uv, cells * 6.4, 0.34 * pebbles, 0.44, salt + 37.3);
  float h = 0.42 + (clod - 0.5) * mix(0.62, 0.26, compact) + (fine - 0.5) * 0.18;
  h += big * 0.30 + mid * 0.18 + sml * 0.09;
  return h;
}

/** Matching soil albedo. */
vec3 soilCol(vec2 uv, float cells, vec3 base, vec3 dark, vec3 light, float hue, float salt) {
  float clod = pfbm(uv, vec2(cells), 4, salt);
  float fine = pfbm(uv, vec2(cells * 6.0), 3, salt + 13.3);
  float big = speck(uv, cells * 1.6, 0.30, 0.42, salt + 27.7);
  float mid = speck(uv, cells * 3.2, 0.32, 0.40, salt + 31.1);
  vec3 col = mix(dark, base, smoothstep(0.25, 0.78, clod));
  col = mix(col, light, clamp(hue, 0.0, 1.0) * smoothstep(0.55, 0.95, clod) * 0.85);
  col *= 0.86 + 0.28 * fine;
  col = mix(col, light * 1.06, big * 0.55 + mid * 0.30);
  return col;
}
`;

/** Aggregate rock, rubble and masonry patterns. @type {string} */
const GEN_ROCK = `
/* ======================================================================== */
/* Aggregate rock                                                           */
/* ======================================================================== */

/**
 * Shared multi-octave rock relief: large mineral blobs, medium mottling,
 * hairline fissures carved by a ridged worley and a sprinkle of hard flecks.
 */
float rockH(vec2 uv, float cells, vec2 aniso, float fissureCells, float fissureDepth) {
  vec2 q = uv * aniso;
  float blob = pfbm(q, vec2(cells) * aniso, 4, u_seed);
  float med = pfbm(q, vec2(cells * 4.0) * aniso, 3, u_seed + 11.7);
  float fine = pridge(uv, vec2(cells * 9.0), 2, u_seed + 3.9);
  float fis = crackLines(pwarp(uv, vec2(4.0), 0.05, u_seed + 6.1),
                         vec2(fissureCells), 0.030, u_seed + 19.3);
  float fleck = speck(uv, max(6.0, floor(sqrt(3000.0 * SPARK) + 0.5)), 1.0, 0.34, u_seed + 47.1);
  float h = 0.50 + (blob - 0.5) * 0.52 + (med - 0.5) * 0.30 + (fine - 0.5) * 0.14 * GRAIN;
  h -= fis * fissureDepth;
  h += fleck * 0.11;
  return h;
}

/** Matching rock albedo / roughness / cavity. */
Surf rockS(vec2 uv, float h, float cells, vec2 aniso, float fissureCells,
           vec3 base, vec3 dark, vec3 light) {
  vec2 q = uv * aniso;
  float blob = pfbm(q, vec2(cells) * aniso, 4, u_seed);
  float med = pfbm(q, vec2(cells * 4.0) * aniso, 3, u_seed + 11.7);
  float fis = crackLines(pwarp(uv, vec2(4.0), 0.05, u_seed + 6.1),
                         vec2(fissureCells), 0.030, u_seed + 19.3);
  float fleckN = max(6.0, floor(sqrt(3000.0 * SPARK) + 0.5));
  float bright = speck(uv, fleckN, 1.0, 0.34, u_seed + 47.1);
  float darkFleck = speck(uv, fleckN * 0.7, 0.55, 0.40, u_seed + 53.7);

  Surf s = surfInit();
  s.albedo = mix(dark, base, smoothstep(0.18, 0.80, blob));
  s.albedo = mix(s.albedo, light, clamp(HUEV, 0.0, 1.0) * smoothstep(0.55, 0.95, med) * 0.7);
  s.albedo = mix(s.albedo, light * 1.25, bright * 0.75);
  s.albedo = mix(s.albedo, dark * 0.55, darkFleck * 0.5);
  s.albedo *= 1.0 - fis * 0.45;
  s.rough = clamp(ROUGHB + (med - 0.5) * 0.16 - bright * 0.30 + fis * 0.06, 0.04, 1.0);
  s.ao = clamp(1.0 - fis * 0.75 * CAVITY - (1.0 - smoothstep(0.15, 0.7, blob)) * 0.22, 0.0, 1.0);
  return s;
}

/* --- solid: near-flat mottled material, also the star-field end portal ---- */

float hSolid(vec2 uv) {
  float m = pfbm(uv, vec2(cellsOf(8.0)), 4, u_seed);
  float f = pfbm(uv, vec2(cellsOf(8.0) * 5.0), 3, u_seed + 9.3);
  float sp = speck(uv, cellsOf(26.0), 0.35 * SPARK, 0.42, u_seed + 21.1);
  return 0.5 + (m - 0.5) * 0.45 * STRUCTP + (f - 0.5) * 0.22 * GRAIN + sp * 0.18;
}

Surf sSolid(vec2 uv, float h) {
  float m = pfbm(uv, vec2(cellsOf(8.0)), 4, u_seed);
  float sp = speck(uv, cellsOf(26.0), 0.35 * SPARK, 0.42, u_seed + 21.1);
  float glint = speck(uv, cellsOf(40.0), 0.55 * SPARK, 0.26, u_seed + 63.7);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.8, m));
  s.albedo = mix(s.albedo, C3, clamp(HUEV, 0.0, 1.0) * (sp * 0.7 + glint * 0.5));
  s.rough = clamp(ROUGHB + (m - 0.5) * 0.18 - glint * 0.35, 0.04, 1.0);
  s.ao = clamp(1.0 - (1.0 - m) * 0.25 * CAVITY, 0.0, 1.0);
  s.emit = EMITB * clamp(glint * 1.4 + sp * 0.5, 0.0, 1.0);
  return s;
}

/* --- stone: the workhorse -------------------------------------------------- */

float hStone(vec2 uv) {
  float h = rockH(uv, cellsOf(8.0), vec2(1.0), cellsOf(12.0 * STRUCTP + 1.0), 0.55 * CAVITY);
  if (EMITB > 0.0) {
    // Machine faces (observer, repeater) carry a recessed indicator lamp.
    float d = sdBox(uv - vec2(0.5), vec2(0.13, 0.09));
    h -= inside(d, 0.012) * 0.35;
    h += stroke(abs(d - 0.02), 0.02) * 0.12;
  }
  return h;
}

Surf sStone(vec2 uv, float h) {
  Surf s = rockS(uv, h, cellsOf(8.0), vec2(1.0), cellsOf(12.0 * STRUCTP + 1.0), C1, C2, C3);
  if (EMITB > 0.0) {
    float d = sdBox(uv - vec2(0.5), vec2(0.13, 0.09));
    float lamp = inside(d, 0.012);
    float rim = stroke(abs(d - 0.02), 0.022);
    s.albedo = mix(s.albedo, C3, lamp * 0.94);
    s.albedo = mix(s.albedo, C3 * 0.35, rim * 0.6);
    s.rough = mix(s.rough, 0.28, lamp);
    s.emit = EMITB * lamp;
    s.ao = mix(s.ao, s.ao * 0.75, rim);
  }
  return s;
}

/* --- granite: pink feldspar, grey matrix, dark mica, quartz glitter -------- */

float hGranite(vec2 uv) {
  float cells = cellsOf(8.0);
  Cell c = pcells(pwarp(uv, vec2(3.0), 0.06, u_seed + 2.3), vec2(cells), u_seed, 1.0);
  float med = pfbm(uv, vec2(cells * 4.0), 3, u_seed + 7.1);
  float mica = speck(uv, cells * 6.0, 0.30, 0.30, u_seed + 31.7);
  float fis = crackLines(uv, vec2(cellsOf(12.0 * STRUCTP + 1.0)), 0.022, u_seed + 17.9);
  return 0.5 + (c.id - 0.5) * 0.30 + (med - 0.5) * 0.24 + mica * 0.16
         - fis * 0.34 * CAVITY - smoothstep(0.28, 0.0, c.f2 - c.f1) * 0.10;
}

Surf sGranite(vec2 uv, float h) {
  float cells = cellsOf(8.0);
  Cell c = pcells(pwarp(uv, vec2(3.0), 0.06, u_seed + 2.3), vec2(cells), u_seed, 1.0);
  float med = pfbm(uv, vec2(cells * 4.0), 3, u_seed + 7.1);
  float mica = speck(uv, cells * 6.0, 0.30, 0.30, u_seed + 31.7);
  float quartz = speck(uv, cells * 4.5, 0.42 * SPARK * 2.0, 0.34, u_seed + 43.1);
  float fis = crackLines(uv, vec2(cellsOf(12.0 * STRUCTP + 1.0)), 0.022, u_seed + 17.9);

  Surf s = surfInit();
  // Two interlocking crystal populations: feldspar (C1) and plagioclase (C2).
  float which = smoothstep(0.36, 0.64, c.id);
  s.albedo = mix(C1, C2, which * clamp(HUEV, 0.0, 1.0));
  s.albedo *= 0.84 + 0.32 * med;
  s.albedo = mix(s.albedo, C3, mica * 0.85);
  s.albedo = mix(s.albedo, vec3(maxComp(C2) * 1.5), quartz * 0.55);
  s.albedo *= 1.0 - fis * 0.4;
  s.rough = clamp(ROUGHB + (med - 0.5) * 0.12 - quartz * 0.45 - mica * 0.1, 0.04, 1.0);
  s.ao = clamp(1.0 - fis * 0.6 * CAVITY - smoothstep(0.25, 0.0, c.f2 - c.f1) * 0.28, 0.0, 1.0);
  return s;
}

/* --- andesite: swirled grey with fine light speckle ----------------------- */

float hAndesite(vec2 uv) {
  float cells = cellsOf(8.0);
  vec2 w = pwarp(uv, vec2(cells * 0.5), 0.10, u_seed + 5.5);
  float band = pfbm(w, vec2(cells), 4, u_seed);
  float med = pfbm(uv, vec2(cells * 5.0), 3, u_seed + 12.7);
  float fis = crackLines(uv, vec2(cellsOf(12.0 * STRUCTP + 1.0)), 0.026, u_seed + 23.3);
  float fl = speck(uv, max(6.0, floor(sqrt(3000.0 * SPARK) + 0.5)), 1.0, 0.36, u_seed + 39.1);
  return 0.5 + (band - 0.5) * 0.5 + (med - 0.5) * 0.26 * GRAIN + fl * 0.12 - fis * 0.42 * CAVITY;
}

Surf sAndesite(vec2 uv, float h) {
  float cells = cellsOf(8.0);
  vec2 w = pwarp(uv, vec2(cells * 0.5), 0.10, u_seed + 5.5);
  float band = pfbm(w, vec2(cells), 4, u_seed);
  float med = pfbm(uv, vec2(cells * 5.0), 3, u_seed + 12.7);
  float fis = crackLines(uv, vec2(cellsOf(12.0 * STRUCTP + 1.0)), 0.026, u_seed + 23.3);
  float fl = speck(uv, max(6.0, floor(sqrt(3000.0 * SPARK) + 0.5)), 1.0, 0.36, u_seed + 39.1);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.15, 0.85, band));
  s.albedo = mix(s.albedo, C3, clamp(HUEV, 0.0, 1.0) * (fl * 0.8 + smoothstep(0.7, 1.0, med) * 0.35));
  s.albedo *= 1.0 - fis * 0.42;
  s.rough = clamp(ROUGHB + (med - 0.5) * 0.14 - fl * 0.2, 0.04, 1.0);
  s.ao = clamp(1.0 - fis * 0.7 * CAVITY - (1.0 - band) * 0.18, 0.0, 1.0);
  return s;
}

/* --- diorite: white matrix with black hornblende clusters ----------------- */

float hDiorite(vec2 uv) {
  float cells = cellsOf(8.0);
  Cell c = pcells(uv, vec2(cells * 1.4), u_seed + 4.4, 1.0);
  float grains = pfbm(uv, vec2(cells * 6.0), 3, u_seed + 8.8);
  float dark = speck(uv, cells * 3.0, 0.46, 0.44, u_seed + 15.1);
  float fis = crackLines(uv, vec2(cellsOf(12.0 * STRUCTP + 1.0)), 0.024, u_seed + 26.7);
  return 0.5 + (c.id - 0.5) * 0.22 + (grains - 0.5) * 0.30 - dark * 0.16 - fis * 0.40 * CAVITY;
}

Surf sDiorite(vec2 uv, float h) {
  float cells = cellsOf(8.0);
  Cell c = pcells(uv, vec2(cells * 1.4), u_seed + 4.4, 1.0);
  float grains = pfbm(uv, vec2(cells * 6.0), 3, u_seed + 8.8);
  float dark = speck(uv, cells * 3.0, 0.46, 0.44, u_seed + 15.1);
  float dark2 = speck(uv, cells * 5.5, 0.34, 0.36, u_seed + 18.3);
  float shiny = speck(uv, cells * 7.0, 0.5 * SPARK * 2.0, 0.28, u_seed + 45.9);
  float fis = crackLines(uv, vec2(cellsOf(12.0 * STRUCTP + 1.0)), 0.024, u_seed + 26.7);
  Surf s = surfInit();
  s.albedo = mix(C1, C3, smoothstep(0.4, 0.95, grains) * clamp(HUEV, 0.0, 1.0));
  s.albedo *= 0.90 + 0.18 * c.id;
  s.albedo = mix(s.albedo, C2, clamp(dark * 0.9 + dark2 * 0.55, 0.0, 1.0));
  s.albedo *= 1.0 - fis * 0.35;
  s.rough = clamp(ROUGHB + (grains - 0.5) * 0.10 - shiny * 0.4, 0.04, 1.0);
  s.ao = clamp(1.0 - fis * 0.65 * CAVITY - dark * 0.15, 0.0, 1.0);
  return s;
}

/* --- deepslate: schistose, strongly layered, deep fissures ---------------- */

float hDeepslate(vec2 uv) {
  float cells = cellsOf(8.0);
  vec2 aniso = vec2(0.55, 2.6);
  float lay = pfbm(uv, vec2(cells * 0.6, cells * 3.0), 4, u_seed);
  float h = rockH(uv, cells, aniso, cellsOf(12.0 * STRUCTP + 1.0), 0.62 * CAVITY);
  return h * 0.72 + (lay - 0.5) * 0.34 + 0.14;
}

Surf sDeepslate(vec2 uv, float h) {
  float cells = cellsOf(8.0);
  float lay = pfbm(uv, vec2(cells * 0.6, cells * 3.0), 4, u_seed);
  Surf s = rockS(uv, h, cells, vec2(0.55, 2.6), cellsOf(12.0 * STRUCTP + 1.0), C1, C2, C3);
  s.albedo = mix(s.albedo, C3, smoothstep(0.62, 1.0, lay) * 0.35 * clamp(HUEV, 0.0, 1.0));
  s.albedo *= 0.88 + 0.24 * lay;
  s.ao = clamp(s.ao - (1.0 - lay) * 0.12, 0.0, 1.0);
  return s;
}

/* --- tuff: porous volcanic ash with lithic inclusions --------------------- */

float hTuff(vec2 uv) {
  float cells = cellsOf(8.0);
  float base = pfbm(uv, vec2(cells), 4, u_seed);
  float pores = 1.0 - pcells(uv, vec2(cells * 3.2), u_seed + 6.6, 1.0).f1;
  float lith = speck(uv, cells * 2.2, 0.34 * (0.4 + WEAR), 0.42, u_seed + 24.9);
  float fis = crackLines(uv, vec2(cellsOf(12.0 * STRUCTP + 1.0)), 0.03, u_seed + 33.1);
  return 0.5 + (base - 0.5) * 0.45 - smoothstep(0.55, 1.0, pores) * 0.30 * CAVITY
         + lith * 0.26 - fis * 0.30 * CAVITY;
}

Surf sTuff(vec2 uv, float h) {
  float cells = cellsOf(8.0);
  float base = pfbm(uv, vec2(cells), 4, u_seed);
  float pores = 1.0 - pcells(uv, vec2(cells * 3.2), u_seed + 6.6, 1.0).f1;
  float lith = speck(uv, cells * 2.2, 0.34 * (0.4 + WEAR), 0.42, u_seed + 24.9);
  float fine = pfbm(uv, vec2(cells * 7.0), 3, u_seed + 44.3);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.8, base)) * (0.88 + 0.26 * fine);
  s.albedo = mix(s.albedo, C3, lith * 0.8 * clamp(HUEV, 0.0, 1.0));
  s.albedo *= 1.0 - smoothstep(0.6, 1.0, pores) * 0.45;
  s.rough = clamp(ROUGHB + (fine - 0.5) * 0.10, 0.05, 1.0);
  s.ao = clamp(1.0 - smoothstep(0.5, 1.0, pores) * 0.6 * CAVITY, 0.0, 1.0);
  return s;
}

/* --- calcite: bright crystalline, needle cleavage ------------------------- */

float hCalcite(vec2 uv) {
  float cells = cellsOf(8.0);
  Cell c = pcells(uv, vec2(cells * 0.9), u_seed, 0.95);
  float needle = pridge(uv, vec2(cells * 2.0, cells * 8.0), 3, u_seed + 5.1);
  float fis = crackLines(uv, vec2(cellsOf(12.0 * STRUCTP + 1.0)), 0.018, u_seed + 12.7);
  return 0.52 + (c.id - 0.5) * 0.22 + (needle - 0.5) * 0.30 - fis * 0.28 * CAVITY;
}

Surf sCalcite(vec2 uv, float h) {
  float cells = cellsOf(8.0);
  Cell c = pcells(uv, vec2(cells * 0.9), u_seed, 0.95);
  float needle = pridge(uv, vec2(cells * 2.0, cells * 8.0), 3, u_seed + 5.1);
  float glint = speck(uv, cells * 8.0, SPARK, 0.26, u_seed + 51.3);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.85, c.id));
  s.albedo = mix(s.albedo, C3, smoothstep(0.55, 1.0, needle) * (0.35 + 0.5 * clamp(HUEV, 0.0, 1.0)));
  s.albedo = mix(s.albedo, C3 * 1.15, glint * 0.7);
  s.rough = clamp(ROUGHB - glint * 0.4 + (needle - 0.5) * 0.14, 0.04, 1.0);
  s.ao = clamp(1.0 - (1.0 - smoothstep(0.15, 0.65, c.f2 - c.f1)) * 0.2 * CAVITY, 0.0, 1.0);
  return s;
}

/* --- blackstone / end_stone / purpur / netherrack share the rock core ------ */

float hBlackstone(vec2 uv) {
  float cells = cellsOf(8.0);
  float h = rockH(uv, cells, vec2(1.0), cellsOf(12.0 * STRUCTP + 1.0), 0.5 * CAVITY);
  float chunk = pcells(uv, vec2(cells * 1.3), u_seed + 9.1, 1.0).id;
  return h * 0.8 + (chunk - 0.5) * 0.24 + 0.10;
}

Surf sBlackstone(vec2 uv, float h) {
  float cells = cellsOf(8.0);
  Surf s = rockS(uv, h, cells, vec2(1.0), cellsOf(12.0 * STRUCTP + 1.0), C1, C2, C3);
  float chunk = pcells(uv, vec2(cells * 1.3), u_seed + 9.1, 1.0).id;
  s.albedo *= 0.82 + 0.36 * chunk;
  return s;
}

float hEndStone(vec2 uv) {
  float cells = cellsOf(8.0);
  Cell c = pcells(uv, vec2(cells * 1.1), u_seed, 1.0);
  float med = pfbm(uv, vec2(cells * 4.0), 3, u_seed + 7.7);
  float holes = speck(uv, cells * 2.4, 0.30 * STRUCTP, 0.44, u_seed + 22.1);
  return 0.52 + (c.id - 0.5) * 0.26 + (med - 0.5) * 0.28 - holes * 0.32 * CAVITY;
}

Surf sEndStone(vec2 uv, float h) {
  float cells = cellsOf(8.0);
  Cell c = pcells(uv, vec2(cells * 1.1), u_seed, 1.0);
  float med = pfbm(uv, vec2(cells * 4.0), 3, u_seed + 7.7);
  float holes = speck(uv, cells * 2.4, 0.30 * STRUCTP, 0.44, u_seed + 22.1);
  float pale = speck(uv, cells * 5.0, 0.4, 0.32, u_seed + 35.9);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.85, c.id)) * (0.88 + 0.26 * med);
  s.albedo = mix(s.albedo, C3, pale * 0.7 * clamp(HUEV, 0.0, 1.0));
  s.albedo = mix(s.albedo, C2 * 0.6, holes * 0.85);
  s.rough = clamp(ROUGHB + (med - 0.5) * 0.12, 0.05, 1.0);
  s.ao = clamp(1.0 - holes * 0.75 * CAVITY, 0.0, 1.0);
  return s;
}

float hPurpur(vec2 uv) {
  float cells = cellsOf(8.0);
  float blob = pfbm(uv, vec2(cells), 4, u_seed);
  float grid = 1.0 - stroke(min(abs(fract(uv.x * cellsOf(2.0)) - 0.5),
                                abs(fract(uv.y * cellsOf(2.0)) - 0.5)), 0.03);
  float sp = speck(uv, cells * 3.4, 0.4, 0.4, u_seed + 17.3);
  return 0.5 + (blob - 0.5) * 0.42 + sp * 0.2 - (1.0 - grid) * 0.18 * CAVITY;
}

Surf sPurpur(vec2 uv, float h) {
  float cells = cellsOf(8.0);
  float blob = pfbm(uv, vec2(cells), 4, u_seed);
  float sp = speck(uv, cells * 3.4, 0.4, 0.4, u_seed + 17.3);
  float dark = speck(uv, cells * 2.6, 0.3, 0.42, u_seed + 27.9);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.85, blob));
  s.albedo = mix(s.albedo, C3, sp * 0.8 * clamp(HUEV, 0.0, 1.0));
  s.albedo = mix(s.albedo, C2 * 0.8, dark * 0.5);
  s.rough = clamp(ROUGHB + (blob - 0.5) * 0.12, 0.05, 1.0);
  s.ao = clamp(1.0 - dark * 0.25 * CAVITY, 0.0, 1.0);
  return s;
}

float hNetherrack(vec2 uv) {
  float cells = cellsOf(8.0);
  float fib = pridge(uv, vec2(cells * 2.0, cells * 5.0), 4, u_seed);
  float pits = 1.0 - pcells(uv, vec2(cells * 2.6), u_seed + 3.3, 1.0).f1;
  float med = pfbm(uv, vec2(cells * 1.2), 4, u_seed + 8.4);
  return 0.5 + (fib - 0.5) * 0.42 + (med - 0.5) * 0.34 - smoothstep(0.5, 1.0, pits) * 0.36 * CAVITY;
}

Surf sNetherrack(vec2 uv, float h) {
  float cells = cellsOf(8.0);
  float fib = pridge(uv, vec2(cells * 2.0, cells * 5.0), 4, u_seed);
  float pits = 1.0 - pcells(uv, vec2(cells * 2.6), u_seed + 3.3, 1.0).f1;
  float med = pfbm(uv, vec2(cells * 1.2), 4, u_seed + 8.4);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.15, 0.8, med));
  s.albedo = mix(s.albedo, C3, smoothstep(0.55, 1.0, fib) * clamp(HUEV, 0.0, 1.0) * 0.8);
  s.albedo *= 1.0 - smoothstep(0.5, 1.0, pits) * 0.55;
  s.rough = clamp(ROUGHB + (fib - 0.5) * 0.1, 0.06, 1.0);
  s.ao = clamp(1.0 - smoothstep(0.45, 1.0, pits) * 0.7 * CAVITY, 0.0, 1.0);
  return s;
}

/* --- quartz: crystal streaks and a chiselled border ----------------------- */

float hQuartz(vec2 uv) {
  float streaks = pridge(uv, vec2(cellsOf(3.0), cellsOf(3.0) * countOf(10.0 * STRUCTP + 1.0)),
                         3, u_seed);
  float med = pfbm(uv, vec2(cellsOf(6.0)), 3, u_seed + 4.7);
  float bw = 0.02 + 0.10 * WEAR;
  float frame = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - bw)), 0.006);
  return 0.55 + (streaks - 0.5) * 0.26 + (med - 0.5) * 0.2 - frame * 0.30;
}

Surf sQuartz(vec2 uv, float h) {
  float streaks = pridge(uv, vec2(cellsOf(3.0), cellsOf(3.0) * countOf(10.0 * STRUCTP + 1.0)),
                         3, u_seed);
  float med = pfbm(uv, vec2(cellsOf(6.0)), 3, u_seed + 4.7);
  float glint = speck(uv, cellsOf(30.0), SPARK, 0.28, u_seed + 41.9);
  float bw = 0.02 + 0.10 * WEAR;
  float frame = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - bw)), 0.006);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.8, med));
  s.albedo = mix(s.albedo, C3, smoothstep(0.5, 1.0, streaks) * (0.4 + 0.5 * clamp(HUEV, 0.0, 1.0)));
  s.albedo = mix(s.albedo, C3 * 1.12, glint * 0.7);
  s.albedo *= 1.0 - frame * 0.22;
  s.rough = clamp(ROUGHB - glint * 0.4 + frame * 0.12, 0.04, 1.0);
  s.ao = clamp(1.0 - frame * 0.4 * CAVITY, 0.0, 1.0);
  return s;
}

/* --- obsidian: conchoidal fracture + flow banding ------------------------- */

float hObsidian(vec2 uv) {
  float h = 0.55;
  float bands = pfbm(pwarp(uv, vec2(3.0), 0.18 * WEAR, u_seed + 2.2), vec2(cellsOf(4.0)), 4, u_seed);
  h += (bands - 0.5) * 0.24;
  float fr = countOf(3.0 + 4.0 * STRUCTP);
  for (int i = 0; i < 3; ++i) {
    vec2 c = ph2(vec2(float(i), 0.0), vec2(4.0), u_seed + 11.0);
    float r = length(uv - c);
    float arc = fract(r * fr * 2.0 + bands * 0.6);
    h -= (1.0 - smoothstep(0.0, 0.16, min(arc, 1.0 - arc))) * 0.16 * STRUCTP
         * smoothstep(0.55, 0.05, r);
  }
  return h;
}

Surf sObsidian(vec2 uv, float h) {
  float bands = pfbm(pwarp(uv, vec2(3.0), 0.18 * WEAR, u_seed + 2.2), vec2(cellsOf(4.0)), 4, u_seed);
  float sheen = pfbm(uv, vec2(cellsOf(14.0)), 3, u_seed + 6.9);
  Surf s = surfInit();
  s.albedo = mix(C1, C2, smoothstep(0.25, 0.85, bands) * clamp(HUEV, 0.0, 1.0));
  s.albedo = mix(s.albedo, C3, smoothstep(0.72, 1.0, bands) * 0.55 * clamp(HUEV, 0.0, 1.0));
  s.rough = clamp(ROUGHB + (sheen - 0.5) * 0.12, 0.03, 1.0);
  s.ao = clamp(0.94 + 0.06 * bands, 0.0, 1.0);
  if (EMITB > 0.0) {
    // Crying obsidian: weeping purple droplets that run downward.
    float drops = speck(vec2(uv.x, uv.y * 0.6 + 0.2), cellsOf(5.0), 0.34, 0.5, u_seed + 55.1);
    float tear = drops * smoothstep(0.0, 0.35, 1.0 - uv.y);
    s.albedo = mix(s.albedo, C3, clamp(drops * 1.3, 0.0, 1.0));
    s.emit = EMITB * clamp(drops * 1.5 + tear * 0.4, 0.0, 1.0);
    s.rough = mix(s.rough, 0.25, drops);
  }
  return s;
}

/* --- bedrock: chaotic blocky rubble with void holes ----------------------- */

float hBedrock(vec2 uv) {
  float cells = cellsOf(7.0);
  Cell a = pcells(uv, vec2(cells), u_seed, 1.0);
  Cell b = pcells(uv, vec2(cells * 2.1), u_seed + 13.0, 1.0);
  float holes = speck(uv, cells * 1.5, 0.42 * WEAR, 0.46, u_seed + 29.3);
  float fis = crackLines(uv, vec2(cellsOf(12.0 * STRUCTP + 1.0)), 0.035, u_seed + 37.7);
  float h = 0.45 + (a.id - 0.5) * 0.5 + (b.id - 0.5) * 0.30;
  h -= holes * 0.55 + fis * 0.35 * CAVITY;
  return h;
}

Surf sBedrock(vec2 uv, float h) {
  float cells = cellsOf(7.0);
  Cell a = pcells(uv, vec2(cells), u_seed, 1.0);
  Cell b = pcells(uv, vec2(cells * 2.1), u_seed + 13.0, 1.0);
  float holes = speck(uv, cells * 1.5, 0.42 * WEAR, 0.46, u_seed + 29.3);
  float fis = crackLines(uv, vec2(cellsOf(12.0 * STRUCTP + 1.0)), 0.035, u_seed + 37.7);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, a.id);
  s.albedo = mix(s.albedo, C3, smoothstep(0.72, 1.0, b.id) * clamp(HUEV, 0.0, 1.0));
  s.albedo = mix(s.albedo, C2 * 0.35, holes);
  s.albedo *= 1.0 - fis * 0.4;
  s.rough = clamp(ROUGHB + (b.id - 0.5) * 0.1, 0.1, 1.0);
  s.ao = clamp(1.0 - holes * 0.85 - fis * 0.5 * CAVITY, 0.0, 1.0);
  return s;
}

/* --- basalt: columnar striations + vesicles ------------------------------- */

float hBasalt(vec2 uv) {
  float cols = countOf(14.0 * STRUCTP + 1.0);
  float ves = speck(uv, cellsOf(18.0), 0.36 * WEAR, 0.44, u_seed + 19.7);
  float fine = pfbm(uv, vec2(cellsOf(12.0)), 3, u_seed + 4.3);
  if (STRUCTP < 0.4) {
    // Cross section: hexagon-ish column tops.
    Cell c = pcells(uv, vec2(cellsOf(4.0)), u_seed, 0.55);
    float rim = smoothstep(0.0, 0.06, c.f2 - c.f1);
    return 0.45 + (c.id - 0.5) * 0.26 + rim * 0.28 + (fine - 0.5) * 0.2 - ves * 0.4;
  }
  float stripe = abs(fract(uv.x * cols + (pfbm(uv, vec2(3.0, 6.0), 3, u_seed + 2.0) - 0.5) * 0.4) - 0.5);
  float groove = 1.0 - smoothstep(0.04, 0.22, stripe);
  float vert = pfbm(uv, vec2(cols, 3.0), 3, u_seed + 7.5);
  return 0.55 - groove * 0.34 * CAVITY + (vert - 0.5) * 0.24 + (fine - 0.5) * 0.18 - ves * 0.4;
}

Surf sBasalt(vec2 uv, float h) {
  float cols = countOf(14.0 * STRUCTP + 1.0);
  float ves = speck(uv, cellsOf(18.0), 0.36 * WEAR, 0.44, u_seed + 19.7);
  float fine = pfbm(uv, vec2(cellsOf(12.0)), 3, u_seed + 4.3);
  Surf s = surfInit();
  if (STRUCTP < 0.4) {
    Cell c = pcells(uv, vec2(cellsOf(4.0)), u_seed, 0.55);
    float rim = smoothstep(0.0, 0.06, c.f2 - c.f1);
    s.albedo = mix(C2, C1, c.id) * (0.88 + 0.24 * fine);
    s.albedo = mix(s.albedo, C3, (1.0 - rim) * 0.7);
    s.ao = clamp(1.0 - (1.0 - rim) * 0.55 * CAVITY - ves * 0.5, 0.0, 1.0);
  } else {
    float stripe = abs(fract(uv.x * cols + (pfbm(uv, vec2(3.0, 6.0), 3, u_seed + 2.0) - 0.5) * 0.4) - 0.5);
    float groove = 1.0 - smoothstep(0.04, 0.22, stripe);
    float vert = pfbm(uv, vec2(cols, 3.0), 3, u_seed + 7.5);
    s.albedo = mix(C1, C2, groove * 0.85) * (0.86 + 0.28 * vert);
    s.albedo = mix(s.albedo, C3, smoothstep(0.72, 1.0, vert) * clamp(HUEV, 0.0, 1.0) * 0.8);
    s.ao = clamp(1.0 - groove * 0.6 * CAVITY - ves * 0.5, 0.0, 1.0);
  }
  s.albedo *= 1.0 - ves * 0.5;
  s.rough = clamp(ROUGHB + (fine - 0.5) * 0.1 + ves * 0.06, 0.06, 1.0);
  return s;
}

/* --- prismarine: scale grid with an iridescent shimmer -------------------- */

float hPrismarine(vec2 uv) {
  float cells = cellsOf(6.0);
  Cell c = pcells(uv, vec2(cells), u_seed, 0.45);
  float scale = smoothstep(0.0, 0.30, c.f2 - c.f1);
  float fine = pfbm(uv, vec2(cells * 5.0), 3, u_seed + 5.9);
  return 0.42 + scale * 0.42 + (c.id - 0.5) * 0.16 + (fine - 0.5) * 0.18;
}

Surf sPrismarine(vec2 uv, float h) {
  float cells = cellsOf(6.0);
  Cell c = pcells(uv, vec2(cells), u_seed, 0.45);
  float scale = smoothstep(0.0, 0.30, c.f2 - c.f1);
  float fine = pfbm(uv, vec2(cells * 5.0), 3, u_seed + 5.9);
  float shim = pfbm(uv, vec2(cells * 2.0), 4, u_seed + 15.1);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.05, 0.6, scale));
  s.albedo = mix(s.albedo, C3, smoothstep(0.55, 1.0, mix(c.id, shim, 0.6))
                 * clamp(HUEV, 0.0, 1.0) * (0.5 + 0.5 * WEAR));
  s.albedo *= 0.9 + 0.2 * fine;
  s.rough = clamp(ROUGHB - smoothstep(0.6, 1.0, shim) * 0.25 * WEAR, 0.05, 1.0);
  s.ao = clamp(1.0 - (1.0 - scale) * 0.55 * CAVITY, 0.0, 1.0);
  return s;
}

/* ======================================================================== */
/* Rubble & masonry                                                         */
/* ======================================================================== */

float hCobble(vec2 uv) {
  float cells = cellsOf(5.0);
  Rubble r = rubbleField(uv, cells, mix(0.5, 3.0, STRUCTP), WEAR, u_seed);
  float bumps = pfbm(uv, vec2(cells * 7.0), 3, u_seed + 12.1);
  return 0.14 + r.stone * (0.42 + 0.34 * r.dome + 0.20 * (r.id - 0.5))
         + r.stone * (bumps - 0.5) * 0.14;
}

Surf sCobbleTinted(vec2 uv, float h, vec3 base, vec3 dark, vec3 mortar) {
  float cells = cellsOf(5.0);
  Rubble r = rubbleField(uv, cells, mix(0.5, 3.0, STRUCTP), WEAR, u_seed);
  float bumps = pfbm(uv, vec2(cells * 7.0), 3, u_seed + 12.1);
  float grit = speck(uv, cells * 9.0, 0.3, 0.4, u_seed + 33.3);
  Surf s = surfInit();
  vec3 stoneCol = mix(dark, base, 0.25 + 0.75 * r.id);
  stoneCol *= 0.84 + 0.30 * bumps;
  stoneCol = mix(stoneCol, base * 1.3, grit * 0.35 * clamp(HUEV, 0.0, 1.0));
  // Rim darkening from wear.
  stoneCol *= 1.0 - (1.0 - r.dome) * 0.30 * WEAR;
  s.albedo = mix(mortar, stoneCol, r.stone);
  s.rough = clamp(ROUGHB + (1.0 - r.stone) * 0.06 + (bumps - 0.5) * 0.12, 0.08, 1.0);
  s.ao = clamp(mix(0.30, 1.0, r.stone) * (0.78 + 0.22 * r.dome), 0.0, 1.0);
  return s;
}

Surf sCobble(vec2 uv, float h) { return sCobbleTinted(uv, h, C1, C2, C3); }

float hGravel(vec2 uv) {
  float cells = cellsOf(5.0);
  Rubble a = rubbleField(uv, cells, mix(0.5, 3.0, STRUCTP), WEAR, u_seed);
  Rubble b = rubbleField(uv, cells * 2.0, mix(0.5, 2.0, STRUCTP), WEAR, u_seed + 71.0);
  float ha = a.stone * (0.40 + 0.36 * a.dome + 0.18 * (a.id - 0.5));
  float hb = b.stone * (0.26 + 0.28 * b.dome + 0.14 * (b.id - 0.5));
  float fine = pfbm(uv, vec2(cells * 10.0), 3, u_seed + 9.9);
  return 0.16 + max(ha, hb * 0.9) + (fine - 0.5) * 0.12;
}

Surf sGravel(vec2 uv, float h) {
  float cells = cellsOf(5.0);
  Rubble a = rubbleField(uv, cells, mix(0.5, 3.0, STRUCTP), WEAR, u_seed);
  Rubble b = rubbleField(uv, cells * 2.0, mix(0.5, 2.0, STRUCTP), WEAR, u_seed + 71.0);
  float fine = pfbm(uv, vec2(cells * 10.0), 3, u_seed + 9.9);
  float top = step(b.stone * (0.26 + 0.28 * b.dome), a.stone * (0.40 + 0.36 * a.dome));
  float id = mix(b.id, a.id, top);
  float dome = mix(b.dome, a.dome, top);
  float cover = max(a.stone, b.stone);
  Surf s = surfInit();
  vec3 stoneCol = mix(C2, C1, 0.15 + 0.85 * id);
  stoneCol = mix(stoneCol, C3, smoothstep(0.7, 1.0, id) * clamp(HUEV, 0.0, 1.0));
  stoneCol *= 0.85 + 0.30 * fine;
  s.albedo = mix(C2 * 0.55, stoneCol, cover);
  s.rough = clamp(ROUGHB + (fine - 0.5) * 0.1, 0.1, 1.0);
  s.ao = clamp(mix(0.34, 1.0, cover) * (0.76 + 0.24 * dome), 0.0, 1.0);
  return s;
}

/** Shared masonry relief. \`square\` selects the square running bond. */
float masonryH(vec2 uv, float square) {
  float rows = cellsOf(4.0);
  float cols = mix(rows * 2.0, rows, square);
  float mortar = mix(0.02, 0.14, STRUCTP);
  Brick b = brickField(uv, rows, cols, 0.5, mortar, WEAR, u_seed);
  float face = pfbm(uv, vec2(cols * 4.0, rows * 4.0), 3, u_seed + 6.3);
  float h = 0.18 + b.body * (0.52 + 0.18 * b.bevel + 0.14 * (b.id - 0.5));
  h += b.body * (face - 0.5) * 0.16;
  h -= b.crack * 0.30;
  h -= b.chip * 0.35;
  return h;
}

Surf masonryS(vec2 uv, float square, vec3 base, vec3 dark, vec3 mortarCol) {
  float rows = cellsOf(4.0);
  float cols = mix(rows * 2.0, rows, square);
  float mortar = mix(0.02, 0.14, STRUCTP);
  Brick b = brickField(uv, rows, cols, 0.5, mortar, WEAR, u_seed);
  float face = pfbm(uv, vec2(cols * 4.0, rows * 4.0), 3, u_seed + 6.3);
  float grit = speck(uv, cols * 8.0, 0.28, 0.4, u_seed + 26.3);
  Surf s = surfInit();
  vec3 brickCol = mix(dark, base, 0.2 + 0.8 * b.id);
  brickCol *= 0.86 + 0.28 * face;
  brickCol = mix(brickCol, base * 1.25, grit * 0.3 * clamp(HUEV, 0.0, 1.0));
  brickCol *= 1.0 - (1.0 - b.bevel) * 0.18 * WEAR;
  vec3 mc = mortarCol * (0.85 + 0.3 * pfbm(uv, vec2(cols * 6.0), 3, u_seed + 44.1));
  s.albedo = mix(mc, brickCol, b.body);
  s.albedo = mix(s.albedo, mc * 0.7, b.chip * 0.8);
  s.albedo *= 1.0 - b.crack * 0.45;
  s.rough = clamp(ROUGHB + (1.0 - b.body) * 0.05 + (face - 0.5) * 0.12, 0.08, 1.0);
  s.ao = clamp(mix(0.34, 1.0, b.body) * (0.80 + 0.20 * b.bevel)
               * (1.0 - b.crack * 0.4) * (1.0 - b.chip * 0.35), 0.0, 1.0);
  return s;
}

float hBricks(vec2 uv) { return masonryH(uv, 0.0); }
Surf sBricks(vec2 uv, float h) { return masonryS(uv, 0.0, C1, C2, C3); }
float hStoneBricks(vec2 uv) { return masonryH(uv, 1.0); }
Surf sStoneBricks(vec2 uv, float h) { return masonryS(uv, 1.0, C1, C2, C3); }

/* --- mossy: cobble or stone-brick substrate with creeping moss ------------ */

/** Moss coverage: thickest in the crevices and creeping up out of them. */
float mossMask(vec2 uv, float crevice, float lowBias) {
  float field = pfbm(uv, vec2(cellsOf(6.0)), 4, u_seed + 61.7);
  float tuft = pfbm(uv, vec2(cellsOf(26.0)), 3, u_seed + 67.3);
  float drive = field * 0.42 + crevice * 0.40 + lowBias * 0.18;
  float cov = clamp(SPARK, 0.0, 1.0);
  return clamp(smoothstep(0.78 - 0.72 * cov, 1.02 - 0.72 * cov, drive) * (0.55 + 0.55 * tuft), 0.0, 1.0);
}

float hMossy(vec2 uv) {
  int sub = int(WEAR + 0.5);
  float base = sub == 0 ? hCobble(uv) : masonryH(uv, 1.0);
  float crev;
  float low;
  if (sub == 0) {
    Rubble r = rubbleField(uv, cellsOf(5.0), mix(0.5, 3.0, STRUCTP), 0.4, u_seed);
    crev = 1.0 - r.stone;
    low = smoothstep(-0.10, 0.40, r.rel.y);
  } else {
    Brick b = brickField(uv, cellsOf(4.0), cellsOf(4.0), 0.5, mix(0.02, 0.14, STRUCTP), 0.2, u_seed);
    crev = 1.0 - b.body;
    low = smoothstep(-0.10, 0.35, b.local.y);
  }
  float m = mossMask(uv, crev, low);
  float fuzz = pfbm(uv, vec2(cellsOf(40.0)), 3, u_seed + 73.1);
  return base + m * (0.06 + 0.09 * fuzz);
}

Surf sMossy(vec2 uv, float h) {
  int sub = int(WEAR + 0.5);
  Surf s;
  float crev;
  float low;
  if (sub == 0) {
    s = sCobbleTinted(uv, h, C1, C2, C2 * 0.55);
    Rubble r = rubbleField(uv, cellsOf(5.0), mix(0.5, 3.0, STRUCTP), 0.4, u_seed);
    crev = 1.0 - r.stone;
    low = smoothstep(-0.10, 0.40, r.rel.y);
  } else {
    s = masonryS(uv, 1.0, C1, C2, C2 * 0.6);
    Brick b = brickField(uv, cellsOf(4.0), cellsOf(4.0), 0.5, mix(0.02, 0.14, STRUCTP), 0.2, u_seed);
    crev = 1.0 - b.body;
    low = smoothstep(-0.10, 0.35, b.local.y);
  }
  float m = mossMask(uv, crev, low);
  float fuzz = pfbm(uv, vec2(cellsOf(40.0)), 3, u_seed + 73.1);
  vec3 moss = C3 * (0.62 + 0.62 * fuzz);
  moss = mix(moss, C3 * 1.5, speck(uv, cellsOf(34.0), 0.3, 0.34, u_seed + 79.7) * 0.5);
  s.albedo = mix(s.albedo, moss, m);
  s.rough = mix(s.rough, 0.97, m);
  s.ao = clamp(s.ao * (1.0 - m * 0.16), 0.0, 1.0);
  return s;
}
`;

/** Soil, granular, ice, fluid and ore patterns. @type {string} */
const GEN_EARTH = `
/* ======================================================================== */
/* Soil                                                                     */
/* ======================================================================== */

float hDirt(vec2 uv) {
  return soilH(uv, cellsOf(6.0), STRUCTP, WEAR, u_seed);
}

Surf sDirt(vec2 uv, float h) {
  float cells = cellsOf(6.0);
  Surf s = surfInit();
  s.albedo = soilCol(uv, cells, C1, C2, C3, HUEV, u_seed);
  float roots = pridge(uv, vec2(cells * 8.0, cells * 3.0), 3, u_seed + 55.1);
  s.albedo = mix(s.albedo, C2 * 0.75, smoothstep(0.62, 1.0, roots) * SPARK);
  float pebble = speck(uv, cells * 1.6, 0.30 * STRUCTP, 0.42, u_seed + 27.7);
  s.albedo = mix(s.albedo, C3 * 1.15, pebble * 0.45);
  s.rough = clamp(ROUGHB - pebble * 0.12, 0.1, 1.0);
  s.ao = clamp(0.62 + 0.44 * h, 0.0, 1.0);
  return s;
}

/* --- grass_top: dense blade clusters ------------------------------------- */

/** One layer of grass blades; returns coverage, height and the blade parameter. */
vec4 bladeField(vec2 uv, float cells, float lenScale, float widthScale, float salt) {
  vec2 p = uv * cells;
  vec2 base = floor(p);
  vec2 fr = fract(p);
  float bestH = 0.0;
  float bestT = 0.0;
  float bestId = 0.0;
  float cover = 0.0;
  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      vec2 g = vec2(float(x), float(y));
      vec2 c = base + g;
      vec2 j = ph2(c, vec2(cells), salt);
      float id = ph1(c, vec2(cells), salt + 3.1);
      float ang = (ph1(c, vec2(cells), salt + 7.7) - 0.5) * TAU;
      float len = (0.45 + 0.75 * id) * lenScale;
      vec2 root = g + j;
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 tip = root + dir * len;
      // Slight curvature: bend the blade with a mid control point.
      vec2 mid = mix(root, tip, 0.5) + vec2(-dir.y, dir.x) * len * 0.22 * (id - 0.5) * 2.0;
      float d = min(sdSeg(fr, root, mid), sdSeg(fr, mid, tip));
      float t = clamp(dot(fr - root, dir) / max(len, 1.0e-4), 0.0, 1.0);
      float w = widthScale * (1.0 - 0.75 * t);
      float m = 1.0 - smoothstep(w * 0.45, w, d);
      float hh = m * (0.35 + 0.65 * id) * (0.5 + 0.5 * t);
      if (hh > bestH) { bestH = hh; bestT = t; bestId = id; }
      cover = max(cover, m);
    }
  }
  return vec4(cover, bestH, bestT, bestId);
}

float hGrassTop(vec2 uv) {
  float cells = cellsOf(14.0 * STRUCTP + 1.0);
  vec4 b = bladeField(uv, cells, 0.55, 0.30, u_seed);
  float mat = pfbm(uv, vec2(cells * 0.6), 4, u_seed + 11.0);
  return 0.30 + b.y * 0.55 + (mat - 0.5) * 0.26;
}

Surf sGrassTop(vec2 uv, float h) {
  float cells = cellsOf(14.0 * STRUCTP + 1.0);
  vec4 b = bladeField(uv, cells, 0.55, 0.30, u_seed);
  float mat = pfbm(uv, vec2(cells * 0.6), 4, u_seed + 11.0);
  float dry = pfbm(uv, vec2(cellsOf(3.0)), 4, u_seed + 23.7);
  Surf s = surfInit();
  vec3 soil = mix(C2 * 0.55, C2, mat);
  vec3 blade = mix(C2, C1, 0.25 + 0.75 * b.w);
  blade = mix(blade, C3, smoothstep(0.45, 1.0, b.z) * (0.35 + 0.5 * clamp(HUEV, 0.0, 1.0)));
  s.albedo = mix(soil, blade, clamp(b.x * 1.15, 0.0, 1.0));
  s.albedo = mix(s.albedo, C3 * 0.95, smoothstep(0.62, 0.95, dry) * clamp(SPARK, 0.0, 1.0));
  s.rough = clamp(ROUGHB - b.x * 0.05, 0.2, 1.0);
  s.ao = clamp(0.55 + 0.5 * h - (1.0 - b.x) * 0.12, 0.0, 1.0);
  return s;
}

/* --- grass_side: dirt body with an irregular overhang -------------------- */

/** Coverage of the top material on a "_side" texture, 1 above the fringe. */
float sideTopMask(vec2 uv) {
  float jagCells = cellsOf(10.0);
  float over = mix(0.02, 0.45, WEAR);
  float jag = (pfbm(uv, vec2(jagCells, 2.0), 3, u_seed + 3.7) - 0.5) * 0.16 * (0.3 + STRUCTP);
  float fine = (pfbm(uv, vec2(jagCells * 3.0, 2.0), 2, u_seed + 8.9) - 0.5) * 0.05;
  // A few columns drip further down than the rest.
  float col = floor(uv.x * jagCells);
  float drip = ph1(vec2(col, 0.0), vec2(jagCells), u_seed + 12.3);
  float extra = smoothstep(0.72, 1.0, drip) * 0.22
                * (1.0 - smoothstep(0.0, 0.5, abs(fract(uv.x * jagCells) - 0.5) * 2.0));
  float boundary = 1.0 - over - jag - fine - extra;
  return smoothstep(boundary - 0.012, boundary + 0.012, uv.y);
}

float hGrassSide(vec2 uv) {
  float body = soilH(uv, cellsOf(6.0), 0.5, 0.4, u_seed);
  float top = sideTopMask(uv);
  float cells = cellsOf(14.0);
  vec4 b = bladeField(uv, cells, 0.45, 0.30, u_seed + 31.0);
  float lip = top * (0.10 + 0.16 * CAVITY);
  return body * 0.9 + lip + top * b.y * 0.16;
}

Surf sGrassSide(vec2 uv, float h) {
  float top = sideTopMask(uv);
  float cells = cellsOf(14.0);
  vec4 b = bladeField(uv, cells, 0.45, 0.30, u_seed + 31.0);
  Surf s = surfInit();
  vec3 body = soilCol(uv, cellsOf(6.0), C2, C2 * 0.6, C2 * 1.35, HUEV, u_seed);
  vec3 cap = mix(C1 * 0.82, C1, 0.3 + 0.7 * b.w);
  cap = mix(cap, C3, 0.25 + 0.4 * smoothstep(0.4, 1.0, b.x));
  s.albedo = mix(body, cap, top);
  // Contact shadow just under the overhang.
  float shade = top * (1.0 - top);
  s.albedo *= 1.0 - shade * 1.6 * 0.35;
  s.rough = clamp(mix(ROUGHB, ROUGHB - 0.03, top), 0.15, 1.0);
  s.ao = clamp(mix(0.68 + 0.32 * h, 0.92, top) - shade * 0.9, 0.0, 1.0);
  return s;
}

/* --- podzol / mycelium / path / farmland / mud / moss -------------------- */

float hPodzol(vec2 uv) {
  float cells = cellsOf(6.0);
  float base = soilH(uv, cells, STRUCTP, WEAR, u_seed);
  float fuzz = speck(uv, cells * 5.0, 0.5 * SPARK, 0.42, u_seed + 41.3);
  return base + fuzz * 0.16;
}

Surf sPodzol(vec2 uv, float h) {
  float cells = cellsOf(6.0);
  Surf s = surfInit();
  s.albedo = soilCol(uv, cells, C1, C2, C3, HUEV, u_seed);
  float fuzz = speck(uv, cells * 5.0, 0.5 * SPARK, 0.42, u_seed + 41.3);
  float fuzz2 = speck(uv, cells * 9.0, 0.45 * SPARK, 0.36, u_seed + 47.9);
  s.albedo = mix(s.albedo, C2, fuzz * 0.8);
  s.albedo = mix(s.albedo, C3, fuzz2 * 0.55);
  s.rough = clamp(ROUGHB + fuzz * 0.04, 0.2, 1.0);
  s.ao = clamp(0.6 + 0.45 * h, 0.0, 1.0);
  return s;
}

float hMycelium(vec2 uv) {
  float cells = cellsOf(6.0);
  float base = soilH(uv, cells, STRUCTP, WEAR, u_seed);
  float hyph = pridge(uv, vec2(cells * 7.0), 3, u_seed + 51.7);
  return base * 0.9 + smoothstep(0.5, 1.0, hyph) * 0.14 * SPARK + 0.05;
}

Surf sMycelium(vec2 uv, float h) {
  float cells = cellsOf(6.0);
  Surf s = surfInit();
  s.albedo = soilCol(uv, cells, C1, C2, C3, HUEV, u_seed);
  float hyph = pridge(uv, vec2(cells * 7.0), 3, u_seed + 51.7);
  float spore = speck(uv, cells * 8.0, 0.5 * SPARK, 0.34, u_seed + 57.1);
  s.albedo = mix(s.albedo, C3, smoothstep(0.5, 1.0, hyph) * 0.55 * SPARK + spore * 0.7);
  s.rough = clamp(ROUGHB, 0.2, 1.0);
  s.ao = clamp(0.62 + 0.44 * h, 0.0, 1.0);
  return s;
}

float hPath(vec2 uv) {
  float cells = cellsOf(6.0);
  float base = soilH(uv, cells, STRUCTP, 0.85, u_seed);
  float rim = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - 0.055)), 0.02);
  return mix(base * 0.55 + 0.30, base * 0.85 + 0.10, 1.0 - rim * WEAR);
}

Surf sPath(vec2 uv, float h) {
  float cells = cellsOf(6.0);
  Surf s = surfInit();
  s.albedo = soilCol(uv, cells, C1, C2, C3, HUEV, u_seed);
  float rim = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - 0.055)), 0.025);
  float scuff = pfbm(uv, vec2(cells * 2.0), 4, u_seed + 61.1);
  s.albedo = mix(s.albedo, C3, smoothstep(0.5, 0.95, scuff) * 0.45);
  s.albedo = mix(s.albedo, C2 * 0.8, rim * WEAR * 0.75);
  s.rough = clamp(ROUGHB, 0.2, 1.0);
  s.ao = clamp(0.72 + 0.34 * h - rim * WEAR * 0.25, 0.0, 1.0);
  return s;
}

float hFarmland(vec2 uv) {
  float rows = countOf(4.0 * TILEP);
  float base = soilH(uv, cellsOf(6.0), STRUCTP, 0.7, u_seed);
  float f = abs(fract(uv.y * rows) - 0.5) * 2.0;
  float furrow = 1.0 - smoothstep(0.25, 0.95, f);
  float holes = speck(uv, cellsOf(9.0), 0.4 * STRUCTP, 0.3, u_seed + 27.1);
  return 0.35 + base * 0.35 - furrow * 0.55 * CAVITY - holes * 0.35;
}

Surf sFarmland(vec2 uv, float h) {
  float rows = countOf(4.0 * TILEP);
  float f = abs(fract(uv.y * rows) - 0.5) * 2.0;
  float furrow = 1.0 - smoothstep(0.25, 0.95, f);
  float holes = speck(uv, cellsOf(9.0), 0.4 * STRUCTP, 0.3, u_seed + 27.1);
  Surf s = surfInit();
  s.albedo = soilCol(uv, cellsOf(6.0), C1, C2, C3, HUEV, u_seed);
  s.albedo = mix(s.albedo, C2 * 0.7, furrow * 0.7);
  s.albedo = mix(s.albedo, C2 * 0.45, holes * 0.9);
  s.albedo *= 1.0 - clamp(WEAR, 0.0, 1.0) * 0.35;
  s.rough = clamp(ROUGHB - WEAR * 0.3, 0.12, 1.0);
  s.ao = clamp(0.55 + 0.5 * h - furrow * 0.3 - holes * 0.35, 0.0, 1.0);
  return s;
}

float hMud(vec2 uv) {
  float cells = cellsOf(6.0);
  float base = pfbm(uv, vec2(cells), 4, u_seed);
  float poly = crackLines(pwarp(uv, vec2(4.0), 0.05, u_seed + 2.1),
                          vec2(cellsOf(7.0 * STRUCTP + 2.0)), 0.055, u_seed + 9.3);
  float fine = pfbm(uv, vec2(cells * 5.0), 3, u_seed + 15.7);
  return 0.55 + (base - 0.5) * 0.34 + (fine - 0.5) * 0.18 - poly * 0.5 * CAVITY;
}

Surf sMud(vec2 uv, float h) {
  float cells = cellsOf(6.0);
  float base = pfbm(uv, vec2(cells), 4, u_seed);
  float poly = crackLines(pwarp(uv, vec2(4.0), 0.05, u_seed + 2.1),
                          vec2(cellsOf(7.0 * STRUCTP + 2.0)), 0.055, u_seed + 9.3);
  float wet = clamp(WEAR, 0.0, 1.0);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.8, base));
  s.albedo = mix(s.albedo, C3, speck(uv, cells * 4.0, 0.25, 0.4, u_seed + 21.9) * 0.5);
  s.albedo *= 1.0 - poly * 0.35;
  s.albedo *= 1.0 - wet * 0.35;
  s.rough = clamp(ROUGHB - 0.25 * wet + poly * 0.1, 0.06, 1.0);
  s.ao = clamp(1.0 - poly * 0.7 * CAVITY, 0.0, 1.0);
  return s;
}

float hMoss(vec2 uv) {
  float cells = cellsOf(10.0);
  vec4 b = bladeField(uv, cells * 2.0, 0.35, 0.34, u_seed);
  float tuft = pfbm(uv, vec2(cells), 4, u_seed + 5.5);
  float clump = pridge(uv, vec2(cells * 3.0), 3, u_seed + 12.1);
  return 0.28 + tuft * 0.34 * STRUCTP + clump * 0.22 + b.y * 0.30;
}

Surf sMoss(vec2 uv, float h) {
  float cells = cellsOf(10.0);
  vec4 b = bladeField(uv, cells * 2.0, 0.35, 0.34, u_seed);
  float tuft = pfbm(uv, vec2(cells), 4, u_seed + 5.5);
  float dry = pfbm(uv, vec2(cellsOf(3.0)), 4, u_seed + 19.3);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.15, 0.85, tuft));
  s.albedo = mix(s.albedo, C3, b.x * (0.35 + 0.55 * clamp(SPARK, 0.0, 1.0)));
  s.albedo = mix(s.albedo, C1 * 1.2, smoothstep(0.7, 1.0, dry) * clamp(WEAR, 0.0, 1.0));
  s.rough = clamp(ROUGHB, 0.4, 1.0);
  s.ao = clamp(0.48 + 0.6 * h, 0.0, 1.0);
  return s;
}

/* --- soul sand: hollow faces pressed into the grain ---------------------- */

/** Sunken face imprint inside a cell: two eye sockets and a moaning mouth. */
float faceImprint(vec2 uv, float cells, float salt) {
  vec2 p = uv * cells;
  vec2 i = floor(p);
  vec2 f = fract(p) - 0.5;
  float on = step(0.55, ph1(i, vec2(cells), salt));
  float sc = 0.6 + 0.4 * ph1(i, vec2(cells), salt + 3.3);
  f /= sc;
  float eyeL = length(f - vec2(-0.16, 0.10)) - 0.085;
  float eyeR = length(f - vec2(0.16, 0.10)) - 0.085;
  float mouth = length(vec2(f.x, (f.y + 0.19) * 1.9)) - 0.15;
  float d = min(min(eyeL, eyeR), mouth);
  return on * inside(d, 0.03);
}

float hSoulSand(vec2 uv) {
  float grains = pfbm(uv, vec2(cellsOf(64.0)), 3, u_seed);
  float lump = pfbm(uv, vec2(cellsOf(6.0)), 4, u_seed + 7.1);
  float face = faceImprint(uv, cellsOf(2.0 + 2.0 * STRUCTP), u_seed + 13.7);
  return 0.62 + (lump - 0.5) * 0.34 + (grains - 0.5) * 0.16 - face * (0.35 + 0.5 * CAVITY);
}

Surf sSoulSand(vec2 uv, float h) {
  float grains = pfbm(uv, vec2(cellsOf(64.0)), 3, u_seed);
  float lump = pfbm(uv, vec2(cellsOf(6.0)), 4, u_seed + 7.1);
  float face = faceImprint(uv, cellsOf(2.0 + 2.0 * STRUCTP), u_seed + 13.7);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.8, lump)) * (0.88 + 0.24 * grains);
  s.albedo = mix(s.albedo, C3, speck(uv, cellsOf(28.0), 0.3, 0.36, u_seed + 33.1) * 0.5);
  s.albedo *= 1.0 - face * 0.55;
  s.rough = clamp(ROUGHB, 0.3, 1.0);
  s.ao = clamp(1.0 - face * 0.8 - (1.0 - lump) * 0.2, 0.0, 1.0);
  return s;
}

/* ======================================================================== */
/* Granular                                                                 */
/* ======================================================================== */

float hSand(vec2 uv) {
  float grains = pfbm(uv, vec2(cellsOf(128.0)), 3, u_seed);
  float rp = countOf(10.0 * STRUCTP + 1.0);
  float warp = pfbm(uv, vec2(4.0), 3, u_seed + 5.3);
  float ripple = sin(TAU * (uv.y * rp + uv.x * max(1.0, floor(rp * 0.35 + 0.5)) + warp * 0.55));
  float dune = pfbm(uv, vec2(cellsOf(4.0)), 3, u_seed + 11.9);
  return 0.5 + ripple * 0.20 * STRUCTP + (grains - 0.5) * 0.30 + (dune - 0.5) * 0.16;
}

Surf sSand(vec2 uv, float h) {
  float grains = pfbm(uv, vec2(cellsOf(128.0)), 3, u_seed);
  float dune = pfbm(uv, vec2(cellsOf(4.0)), 3, u_seed + 11.9);
  float glitter = speck(uv, cellsOf(96.0), 0.3 * SPARK * 2.0, 0.4, u_seed + 45.7);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.25, 0.8, grains));
  s.albedo = mix(s.albedo, C3, smoothstep(0.55, 0.95, dune) * clamp(HUEV, 0.0, 1.0));
  s.albedo = mix(s.albedo, C3 * 1.35, glitter * 0.8);
  s.rough = clamp(ROUGHB - glitter * 0.55, 0.05, 1.0);
  s.ao = clamp(0.86 + 0.16 * h, 0.0, 1.0);
  return s;
}

float hSandstone(vec2 uv) {
  float bands = countOf(8.0 * STRUCTP + 1.0);
  float wob = pfbm(uv, vec2(4.0, 2.0), 3, u_seed + 3.1);
  float y = uv.y * bands + (wob - 0.5) * 0.35;
  float fy = fract(y);
  float line = 1.0 - smoothstep(0.0, 0.09, min(fy, 1.0 - fy));
  float grains = pfbm(uv, vec2(cellsOf(96.0)), 3, u_seed);
  float weather = pfbm(uv, vec2(cellsOf(5.0)), 4, u_seed + 17.3);
  return 0.58 - line * 0.42 * CAVITY + (grains - 0.5) * 0.22
         - smoothstep(0.65, 1.0, weather) * 0.24 * WEAR;
}

Surf sSandstone(vec2 uv, float h) {
  float bands = countOf(8.0 * STRUCTP + 1.0);
  float wob = pfbm(uv, vec2(4.0, 2.0), 3, u_seed + 3.1);
  float y = uv.y * bands + (wob - 0.5) * 0.35;
  float fy = fract(y);
  float bi = floor(y);
  float line = 1.0 - smoothstep(0.0, 0.09, min(fy, 1.0 - fy));
  float tone = ph1(vec2(0.0, bi), vec2(1.0, bands), u_seed + 7.7);
  float grains = pfbm(uv, vec2(cellsOf(96.0)), 3, u_seed);
  float weather = pfbm(uv, vec2(cellsOf(5.0)), 4, u_seed + 17.3);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, 0.25 + 0.75 * tone) * (0.90 + 0.20 * grains);
  s.albedo = mix(s.albedo, C3, clamp(HUEV, 0.0, 1.0) * smoothstep(0.6, 1.0, tone) * 0.6);
  s.albedo = mix(s.albedo, C2 * 0.8, line * 0.7);
  s.albedo *= 1.0 - smoothstep(0.6, 1.0, weather) * 0.22 * WEAR;
  s.rough = clamp(ROUGHB + line * 0.05, 0.2, 1.0);
  s.ao = clamp(1.0 - line * 0.55 * CAVITY, 0.0, 1.0);
  return s;
}

float hClay(vec2 uv) {
  float m = pfbm(uv, vec2(cellsOf(6.0)), 4, u_seed);
  float f = pfbm(uv, vec2(cellsOf(40.0)), 3, u_seed + 9.1);
  float incl = speck(uv, cellsOf(14.0), 0.3 * STRUCTP, 0.34, u_seed + 23.3);
  return 0.5 + (m - 0.5) * 0.30 + (f - 0.5) * 0.16 + incl * 0.14;
}

Surf sClay(vec2 uv, float h) {
  float m = pfbm(uv, vec2(cellsOf(6.0)), 4, u_seed);
  float f = pfbm(uv, vec2(cellsOf(40.0)), 3, u_seed + 9.1);
  float incl = speck(uv, cellsOf(14.0), 0.3 * STRUCTP, 0.34, u_seed + 23.3);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.8, m)) * (0.94 + 0.12 * f);
  s.albedo = mix(s.albedo, C3, incl * 0.6 * clamp(HUEV, 0.0, 1.0) + smoothstep(0.75, 1.0, m) * 0.2);
  s.rough = clamp(ROUGHB + (f - 0.5) * 0.08, 0.2, 1.0);
  s.ao = clamp(0.9 + 0.12 * h, 0.0, 1.0);
  return s;
}

float hSnow(vec2 uv) {
  float drift = pfbm(uv, vec2(cellsOf(4.0)), 4, u_seed);
  float grains = pfbm(uv, vec2(cellsOf(96.0)), 3, u_seed + 6.7);
  float crust = crackLines(uv, vec2(cellsOf(6.0 * STRUCTP + 2.0)), 0.04, u_seed + 14.9);
  return 0.55 + (drift - 0.5) * 0.5 * WEAR + (grains - 0.5) * 0.18 - crust * 0.28 * CAVITY;
}

Surf sSnow(vec2 uv, float h) {
  float drift = pfbm(uv, vec2(cellsOf(4.0)), 4, u_seed);
  float grains = pfbm(uv, vec2(cellsOf(96.0)), 3, u_seed + 6.7);
  float crust = crackLines(uv, vec2(cellsOf(6.0 * STRUCTP + 2.0)), 0.04, u_seed + 14.9);
  float glint = speck(uv, cellsOf(110.0), 0.25 * SPARK, 0.32, u_seed + 51.9);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.9, drift * 0.6 + grains * 0.4));
  s.albedo = mix(s.albedo, C3, glint * 0.9);
  s.albedo *= 1.0 - crust * 0.12;
  s.rough = clamp(ROUGHB - glint * 0.5 + crust * 0.05, 0.05, 1.0);
  s.ao = clamp(1.0 - crust * 0.35 * CAVITY, 0.0, 1.0);
  return s;
}

/* ======================================================================== */
/* Ice, water and molten rock                                               */
/* ======================================================================== */

float hIceCore(vec2 uv, float fractureCells, float bubbleCells) {
  float frac = crackLines(pwarp(uv, vec2(3.0), 0.06, u_seed + 2.7),
                          vec2(fractureCells), 0.05, u_seed);
  float frac2 = crackLines(pwarp(uv, vec2(5.0), 0.04, u_seed + 5.1),
                           vec2(fractureCells * 2.0), 0.03, u_seed + 31.7);
  float bub = speck(uv, bubbleCells, 0.35 * WEAR, 0.4, u_seed + 17.1);
  float swirl = pfbm(uv, vec2(cellsOf(5.0)), 4, u_seed + 8.3);
  return 0.6 + (swirl - 0.5) * 0.24 - (frac * 0.8 + frac2 * 0.45) * CAVITY * 0.6 + bub * 0.20;
}

Surf sIceCore(vec2 uv, float h, float fractureCells, float bubbleCells) {
  float frac = crackLines(pwarp(uv, vec2(3.0), 0.06, u_seed + 2.7),
                          vec2(fractureCells), 0.05, u_seed);
  float frac2 = crackLines(pwarp(uv, vec2(5.0), 0.04, u_seed + 5.1),
                           vec2(fractureCells * 2.0), 0.03, u_seed + 31.7);
  float bub = speck(uv, bubbleCells, 0.35 * WEAR, 0.4, u_seed + 17.1);
  float swirl = pfbm(uv, vec2(cellsOf(5.0)), 4, u_seed + 8.3);
  Surf s = surfInit();
  s.albedo = mix(C1, C2, smoothstep(0.25, 0.85, swirl) * clamp(HUEV, 0.0, 1.0));
  s.albedo = mix(s.albedo, C3, clamp(frac * 0.85 + frac2 * 0.5 + bub * 0.8, 0.0, 1.0));
  s.rough = clamp(ROUGHB + frac * 0.25 + bub * 0.2, 0.02, 1.0);
  s.ao = clamp(1.0 - frac * 0.25 * CAVITY, 0.0, 1.0);
  // Cracks, frost and bubbles are always opaque; the clear body uses p5.
  float opaque = clamp(frac * 0.9 + frac2 * 0.6 + bub, 0.0, 1.0);
  s.alpha = clamp(mix(clamp(SPARK, 0.0, 1.0), 1.0, opaque), 0.0, 1.0);
  return s;
}

float hIce(vec2 uv) { return hIceCore(uv, cellsOf(4.0 * STRUCTP + 1.0), cellsOf(20.0)); }
Surf sIce(vec2 uv, float h) { return sIceCore(uv, h, cellsOf(4.0 * STRUCTP + 1.0), cellsOf(20.0)); }

float hPackedIce(vec2 uv) {
  float base = hIceCore(uv, cellsOf(5.0 * STRUCTP + 2.0), cellsOf(30.0));
  float lay = pfbm(uv, vec2(cellsOf(3.0), cellsOf(9.0)), 4, u_seed + 25.3);
  return base * 0.85 + (lay - 0.5) * 0.22 + 0.06;
}

Surf sPackedIce(vec2 uv, float h) {
  Surf s = sIceCore(uv, h, cellsOf(5.0 * STRUCTP + 2.0), cellsOf(30.0));
  float lay = pfbm(uv, vec2(cellsOf(3.0), cellsOf(9.0)), 4, u_seed + 25.3);
  s.albedo = mix(s.albedo, C3, smoothstep(0.65, 1.0, lay) * 0.35);
  s.alpha = clamp(max(s.alpha, clamp(SPARK, 0.0, 1.0)), 0.0, 1.0);
  return s;
}

/* --- water: layered gerstner-ish crests ---------------------------------- */

/** Sum of four directional wave trains with integer frequency vectors. */
float waterH(vec2 uv) {
  float n = countOf(4.0 * STRUCTP + 1.0);
  float h = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 4; ++i) {
    float fi = float(i);
    vec2 k = vec2(floor(n * (1.0 + fi * 0.5) + 0.5),
                  floor(n * (0.6 + fi * 0.9) + 0.5)) * (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0);
    float ph = ph1(vec2(fi, 0.0), vec2(8.0), u_seed) * TAU;
    float w = sin(TAU * dot(uv, k) + ph);
    // Sharpen the crests the way a gerstner wave does.
    h += amp * (1.0 - pow(abs(w) * 0.5 + 0.5, 1.6)) * sign(w) * 0.5 + amp * w * 0.5;
    norm += amp;
    amp *= 0.62;
  }
  h /= max(norm, 1.0e-4);
  float ripple = pfbm(uv, vec2(cellsOf(28.0)), 3, u_seed + 9.7);
  return 0.5 + h * 0.34 * (0.4 + CAVITY) + (ripple - 0.5) * 0.16;
}

float hWater(vec2 uv) { return waterH(uv); }

Surf sWater(vec2 uv, float h) {
  float ripple = pfbm(uv, vec2(cellsOf(28.0)), 3, u_seed + 9.7);
  float crest = smoothstep(0.60, 0.86, h);
  Surf s = surfInit();
  s.albedo = mix(C1, C2, smoothstep(0.35, 0.75, h));
  s.albedo = mix(s.albedo, C3, crest * clamp(WEAR, 0.0, 1.0) * 0.9);
  s.rough = clamp(ROUGHB + crest * 0.25 * WEAR + (ripple - 0.5) * 0.05, 0.02, 1.0);
  s.ao = 1.0;
  s.alpha = clamp(mix(clamp(SPARK, 0.0, 1.0), 1.0, crest * clamp(WEAR, 0.0, 1.0)), 0.0, 1.0);
  if (EMITB > 0.0) {
    // Nether portal: swirling luminous filaments.
    vec2 w = pwarp(uv, vec2(cellsOf(3.0)), 0.22, u_seed + 3.3);
    float swirl = pridge(w, vec2(cellsOf(6.0)), 4, u_seed + 12.9);
    float core = smoothstep(0.5, 1.0, swirl);
    s.albedo = mix(C1, C2, core);
    s.albedo = mix(s.albedo, C3, smoothstep(0.78, 1.0, swirl));
    s.emit = EMITB * clamp(core * 1.2, 0.0, 1.0);
    s.alpha = clamp(mix(clamp(SPARK, 0.0, 1.0), 1.0, core), 0.0, 1.0);
    s.rough = 0.3;
  }
  return s;
}

/* --- lava & magma: cracked crust over glowing veins ---------------------- */

float lavaCrust(vec2 uv, float veinCells, float coverage) {
  vec2 w = pwarp(uv, vec2(cellsOf(3.0)), 0.09, u_seed + 4.1);
  Cell c = pcells(w, vec2(veinCells), u_seed, 1.0);
  float vein = 1.0 - smoothstep(0.0, 0.10 + 0.09 * (1.0 - coverage), c.f2 - c.f1);
  float blob = pfbm(w, vec2(cellsOf(5.0)), 4, u_seed + 8.9);
  float crust = smoothstep(0.42 - 0.35 * coverage, 0.78 - 0.35 * coverage, blob);
  return clamp(vein + (1.0 - crust) * 0.85, 0.0, 1.0);
}

float hLava(vec2 uv) {
  float heat = lavaCrust(uv, cellsOf(5.0 * STRUCTP + 2.0), clamp(CAVITY, 0.0, 1.0));
  float plates = pfbm(uv, vec2(cellsOf(7.0)), 4, u_seed + 15.1);
  return 0.62 + (plates - 0.5) * 0.30 * clamp(WEAR, 0.0, 1.0) - heat * 0.55;
}

Surf sLava(vec2 uv, float h) {
  float heat = lavaCrust(uv, cellsOf(5.0 * STRUCTP + 2.0), clamp(CAVITY, 0.0, 1.0));
  float plates = pfbm(uv, vec2(cellsOf(7.0)), 4, u_seed + 15.1);
  float spark = speck(uv, cellsOf(40.0), 0.35 * clamp(HUEV, 0.0, 1.0), 0.3, u_seed + 63.1);
  Surf s = surfInit();
  vec3 crustCol = mix(C1 * 0.7, C1, plates);
  s.albedo = mix(crustCol, C2, smoothstep(0.05, 0.55, heat));
  s.albedo = mix(s.albedo, C3, smoothstep(0.62, 1.0, heat));
  s.albedo = mix(s.albedo, C3 * 1.2, spark * 0.8);
  s.rough = clamp(ROUGHB - heat * 0.30, 0.1, 1.0);
  s.ao = clamp(1.0 - (1.0 - heat) * 0.25 * CAVITY, 0.0, 1.0);
  s.emit = clamp(EMITB * (heat * heat * 1.15 + spark * 0.8), 0.0, 1.0);
  return s;
}

float hMagma(vec2 uv) {
  float heat = lavaCrust(uv, cellsOf(5.0 * STRUCTP + 2.0), clamp(WEAR, 0.0, 1.0));
  float rock = pfbm(uv, vec2(cellsOf(8.0)), 4, u_seed + 21.7);
  return 0.66 + (rock - 0.5) * 0.34 - heat * 0.50 * CAVITY;
}

Surf sMagma(vec2 uv, float h) {
  float heat = lavaCrust(uv, cellsOf(5.0 * STRUCTP + 2.0), clamp(WEAR, 0.0, 1.0));
  float rock = pfbm(uv, vec2(cellsOf(8.0)), 4, u_seed + 21.7);
  float grit = speck(uv, cellsOf(30.0), 0.3, 0.36, u_seed + 29.9);
  Surf s = surfInit();
  s.albedo = mix(C1 * 0.75, C1, rock);
  s.albedo = mix(s.albedo, C1 * 1.4, grit * 0.4);
  s.albedo = mix(s.albedo, C2, smoothstep(0.15, 0.7, heat));
  s.albedo = mix(s.albedo, C3, smoothstep(0.70, 1.0, heat));
  s.rough = clamp(ROUGHB - heat * 0.25, 0.15, 1.0);
  s.ao = clamp(1.0 - (1.0 - rock) * 0.3 * CAVITY, 0.0, 1.0);
  s.emit = clamp(EMITB * heat * heat * 1.2, 0.0, 1.0);
  return s;
}

/* ======================================================================== */
/* Ores                                                                     */
/* ======================================================================== */

/** Host rock relief for the five documented host styles. */
float hostH(vec2 uv, int host) {
  float cells = cellsOf(8.0);
  if (host == 1) {
    float lay = pfbm(uv, vec2(cells * 0.6, cells * 3.0), 4, u_seed + 101.0);
    return rockH(uv, cells, vec2(0.55, 2.6), cells, 0.5) * 0.72 + (lay - 0.5) * 0.3 + 0.14;
  }
  if (host == 2) {
    float fib = pridge(uv, vec2(cells * 2.0, cells * 5.0), 4, u_seed + 103.0);
    float pits = 1.0 - pcells(uv, vec2(cells * 2.6), u_seed + 107.0, 1.0).f1;
    return 0.5 + (fib - 0.5) * 0.4 - smoothstep(0.5, 1.0, pits) * 0.3;
  }
  if (host == 3) {
    return rockH(uv, cells, vec2(1.0), cells, 0.45) * 0.8
           + (pcells(uv, vec2(cells * 1.3), u_seed + 109.0, 1.0).id - 0.5) * 0.24 + 0.1;
  }
  if (host == 4) {
    Cell c = pcells(uv, vec2(cells * 1.1), u_seed + 113.0, 1.0);
    return 0.52 + (c.id - 0.5) * 0.26
           + (pfbm(uv, vec2(cells * 4.0), 3, u_seed + 117.0) - 0.5) * 0.28;
  }
  return rockH(uv, cells, vec2(1.0), cells, 0.42);
}

/** Host rock albedo, built around the material's \`color2\`. */
vec3 hostCol(vec2 uv, int host) {
  float cells = cellsOf(8.0);
  vec3 base = C2;
  vec3 dark = C2 * 0.58;
  vec3 light = min(C2 * 1.7 + vec3(0.02), vec3(1.0));
  float blob = pfbm(uv, vec2(cells), 4, host == 1 ? u_seed + 101.0 : u_seed);
  float med = pfbm(uv, vec2(cells * 4.0), 3, u_seed + 11.7);
  vec3 col = mix(dark, base, smoothstep(0.18, 0.80, blob));
  col = mix(col, light, smoothstep(0.62, 0.98, med) * 0.45);
  if (host == 1) col *= 0.86 + 0.26 * pfbm(uv, vec2(cells * 0.6, cells * 3.0), 4, u_seed + 101.0);
  if (host == 2) col = mix(col, light, smoothstep(0.55, 1.0, pridge(uv, vec2(cells * 2.0, cells * 5.0), 4, u_seed + 103.0)) * 0.5);
  if (host == 4) col = mix(col, light, speck(uv, cells * 5.0, 0.4, 0.32, u_seed + 119.0) * 0.6);
  return col;
}

/** Irregular mineral blob field. x = coverage, y = rim, z = per-blob random. */
vec3 oreBlobs(vec2 uv, float count, float radius, float salt) {
  float g = max(1.0, ceil(sqrt(max(count, 1.0))));
  float prob = clamp(count / (g * g), 0.05, 1.0);
  vec2 p = uv * g;
  vec2 base = floor(p);
  vec2 fr = fract(p);
  float best = 1.0e6;
  float id = 0.0;
  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      vec2 gg = vec2(float(x), float(y));
      vec2 c = base + gg;
      if (ph1(c, vec2(g), salt) > prob) continue;
      vec2 j = ph2(c, vec2(g), salt + 5.5);
      vec2 ctr = gg + clamp(j, vec2(0.22), vec2(0.78));
      vec2 q = fr - ctr;
      float a = atan(q.y, q.x);
      float rr = radius * g * (0.62 + 0.55 * ph1(c, vec2(g), salt + 9.9));
      // Lobed outline instead of a circle.
      float wob = 1.0 + 0.30 * sin(a * 3.0 + ph1(c, vec2(g), salt + 13.1) * TAU)
                      + 0.18 * sin(a * 5.0 + ph1(c, vec2(g), salt + 17.3) * TAU);
      float d = length(q) - rr * wob;
      if (d < best) { best = d; id = ph1(c, vec2(g), salt + 23.7); }
    }
  }
  float soft = 1.2 / max(u_res, 8.0) * g;
  float cover = inside(best, soft);
  float rim = stroke(abs(best + soft * 1.5), soft * 2.0) * cover;
  return vec3(cover, rim, id);
}

float hOre(vec2 uv) {
  int host = int(clamp(WEAR, 0.0, 4.0) + 0.5);
  float base = hostH(uv, host);
  vec3 b = oreBlobs(uv, countOf(10.0 * STRUCTP), mix(0.02, 0.16, CAVITY), u_seed + 71.0);
  float bump = pfbm(uv, vec2(cellsOf(24.0)), 3, u_seed + 77.0);
  return mix(base, 0.72 + (bump - 0.5) * 0.24, b.x) - b.y * 0.12;
}

Surf sOre(vec2 uv, float h) {
  int host = int(clamp(WEAR, 0.0, 4.0) + 0.5);
  vec3 b = oreBlobs(uv, countOf(10.0 * STRUCTP), mix(0.02, 0.16, CAVITY), u_seed + 71.0);
  float bump = pfbm(uv, vec2(cellsOf(24.0)), 3, u_seed + 77.0);
  float glint = speck(uv, cellsOf(60.0), clamp(SPARK, 0.0, 1.0), 0.3, u_seed + 83.0);
  Surf s = surfInit();
  vec3 host3 = hostCol(uv, host);
  vec3 mineral = mix(C1 * 0.75, C1, bump);
  mineral = mix(mineral, C3, clamp(HUEV, 0.0, 1.0) * (b.z * 0.7 + smoothstep(0.6, 1.0, bump) * 0.35));
  mineral = mix(mineral, C3 * 1.3, glint * b.x * 0.8);
  s.albedo = mix(host3, mineral, b.x);
  s.albedo = mix(s.albedo, C3, b.y * 0.5);
  s.metal = METALB * b.x;
  s.rough = clamp(mix(ROUGHB + 0.14, ROUGHB - 0.18 - glint * 0.3, b.x), 0.05, 1.0);
  s.ao = clamp(1.0 - (1.0 - b.x) * 0.12 - b.y * 0.25, 0.0, 1.0);
  s.emit = EMITB * b.x;
  return s;
}

float hGemOre(vec2 uv) {
  int host = int(clamp(WEAR, 0.0, 4.0) + 0.5);
  float base = hostH(uv, host);
  vec3 b = oreBlobs(uv, countOf(10.0 * STRUCTP), mix(0.02, 0.16, CAVITY), u_seed + 91.0);
  // Faceted crystal: a tilted plane per worley cell inside the blob.
  Cell f = pcells(uv, vec2(cellsOf(16.0)), u_seed + 97.0, 0.8);
  vec2 tilt = (ph2(f.coord, vec2(cellsOf(16.0)), u_seed + 101.0) - 0.5) * 2.0;
  float facet = 0.70 + dot(-f.rel, tilt) * 0.55;
  float bevel = smoothstep(0.0, 0.09, f.f2 - f.f1);
  return mix(base, mix(facet - 0.18, facet, bevel), b.x);
}

Surf sGemOre(vec2 uv, float h) {
  int host = int(clamp(WEAR, 0.0, 4.0) + 0.5);
  vec3 b = oreBlobs(uv, countOf(10.0 * STRUCTP), mix(0.02, 0.16, CAVITY), u_seed + 91.0);
  Cell f = pcells(uv, vec2(cellsOf(16.0)), u_seed + 97.0, 0.8);
  float bevel = smoothstep(0.0, 0.09, f.f2 - f.f1);
  float glint = speck(uv, cellsOf(70.0), clamp(SPARK, 0.0, 1.0), 0.26, u_seed + 103.0);
  Surf s = surfInit();
  vec3 host3 = hostCol(uv, host);
  vec3 gem = mix(C1 * 0.7, C1, f.id);
  gem = mix(gem, C3, smoothstep(0.55, 1.0, f.id) * (0.4 + 0.5 * clamp(HUEV, 0.0, 1.0)));
  gem = mix(gem * 0.7, gem, bevel);
  gem = mix(gem, C3 * 1.4, glint * 0.85);
  s.albedo = mix(host3, gem, b.x);
  s.albedo = mix(s.albedo, C3, b.y * 0.65);
  s.metal = METALB * b.x;
  s.rough = clamp(mix(ROUGHB + 0.5, ROUGHB - glint * 0.06, b.x), 0.04, 1.0);
  s.ao = clamp(1.0 - (1.0 - b.x) * 0.1 - (1.0 - bevel) * b.x * 0.25, 0.0, 1.0);
  s.emit = EMITB * (b.y * 1.2 + b.x * 0.35);
  return s;
}
`;

/** Wood, foliage, crops and fruit patterns. @type {string} */
const GEN_WOOD = `
/* ======================================================================== */
/* Wood                                                                     */
/* ======================================================================== */

float hLogSide(vec2 uv) {
  float ridges = countOf(10.0 * STRUCTP + 1.0);
  // Bark plates: worley stretched along the trunk axis.
  Cell c = pcells(pwarp(uv, vec2(ridges, 3.0), 0.05, u_seed + 2.9),
                  vec2(ridges, max(2.0, floor(ridges * 0.35 + 0.5))), u_seed, 0.95);
  float fis = 1.0 - smoothstep(0.0, 0.11, c.f2 - c.f1);
  float fib = pridge(uv, vec2(ridges * 3.0, 5.0), 4, u_seed + 7.3);
  float coarse = pfbm(uv, vec2(ridges * 0.6, 2.0), 3, u_seed + 13.1);
  float knot = speck(uv, cellsOf(3.0), 0.32 * WEAR, 0.42, u_seed + 21.7);
  float h = 0.52 + (c.id - 0.5) * 0.24 + (fib - 0.5) * 0.34 + (coarse - 0.5) * 0.22;
  h -= fis * 0.55 * CAVITY;
  h += knot * 0.28;
  return h;
}

Surf sLogSide(vec2 uv, float h) {
  float ridges = countOf(10.0 * STRUCTP + 1.0);
  Cell c = pcells(pwarp(uv, vec2(ridges, 3.0), 0.05, u_seed + 2.9),
                  vec2(ridges, max(2.0, floor(ridges * 0.35 + 0.5))), u_seed, 0.95);
  float fis = 1.0 - smoothstep(0.0, 0.11, c.f2 - c.f1);
  float fib = pridge(uv, vec2(ridges * 3.0, 5.0), 4, u_seed + 7.3);
  float coarse = pfbm(uv, vec2(ridges * 0.6, 2.0), 3, u_seed + 13.1);
  float knot = speck(uv, cellsOf(3.0), 0.32 * WEAR, 0.42, u_seed + 21.7);
  float lich = speck(uv, cellsOf(16.0), 0.4 * SPARK * 2.0, 0.42, u_seed + 33.7);
  // Birch-style lenticels: short dark horizontal dashes.
  float dash = speck(vec2(uv.x, uv.y * 6.0), cellsOf(9.0), 0.30 * WEAR, 0.5, u_seed + 39.1);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.15, 0.85, mix(c.id, coarse, 0.55)));
  s.albedo *= 0.82 + 0.34 * fib;
  s.albedo = mix(s.albedo, C3, clamp(lich * 0.9 + dash * 0.85 * WEAR, 0.0, 1.0) * clamp(HUEV + 0.3, 0.0, 1.0));
  s.albedo = mix(s.albedo, C2 * 0.55, fis * 0.85);
  s.albedo = mix(s.albedo, C2 * 0.7, knot * 0.5);
  s.rough = clamp(ROUGHB + fis * 0.04 - lich * 0.1, 0.3, 1.0);
  s.ao = clamp(1.0 - fis * 0.8 * CAVITY - knot * 0.15, 0.0, 1.0);
  return s;
}

float hLogTop(vec2 uv) {
  float rings = countOf(14.0 * STRUCTP + 1.0);
  vec2 pith = vec2(0.5) + (ph2(vec2(0.0), vec2(2.0), u_seed) - 0.5) * 0.55 * clamp(SPARK, 0.0, 1.0);
  vec2 d = uv - pith;
  float r = length(d);
  float a = atan(d.y, d.x);
  float wob = pfbm(uv, vec2(cellsOf(5.0)), 3, u_seed + 4.9);
  float t = r * rings * 2.0 + (wob - 0.5) * 1.1 + a * 0.10;
  float ring = abs(fract(t) - 0.5) * 2.0;
  float ringLine = 1.0 - smoothstep(0.25, 0.85, ring);
  // Radial drying cracks.
  float cracks = countOf(6.0 * WEAR);
  float ang = fract(a / TAU * cracks + ph1(vec2(0.0), vec2(2.0), u_seed + 11.0));
  float crack = (1.0 - smoothstep(0.0, 0.035, abs(ang - 0.5)))
                * smoothstep(0.04, 0.32, r) * step(0.5, WEAR + 0.2);
  float bw = 0.055;
  float rim = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - bw)), 0.008);
  float bark = pridge(uv, vec2(cellsOf(26.0)), 3, u_seed + 17.7);
  float h = 0.62 - ringLine * 0.30 * CAVITY - crack * 0.45;
  h = mix(h, 0.5 + (bark - 0.5) * 0.5, rim);
  return h;
}

Surf sLogTop(vec2 uv, float h) {
  float rings = countOf(14.0 * STRUCTP + 1.0);
  vec2 pith = vec2(0.5) + (ph2(vec2(0.0), vec2(2.0), u_seed) - 0.5) * 0.55 * clamp(SPARK, 0.0, 1.0);
  vec2 d = uv - pith;
  float r = length(d);
  float a = atan(d.y, d.x);
  float wob = pfbm(uv, vec2(cellsOf(5.0)), 3, u_seed + 4.9);
  float t = r * rings * 2.0 + (wob - 0.5) * 1.1 + a * 0.10;
  float ring = abs(fract(t) - 0.5) * 2.0;
  float ringLine = 1.0 - smoothstep(0.25, 0.85, ring);
  float cracks = countOf(6.0 * WEAR);
  float ang = fract(a / TAU * cracks + ph1(vec2(0.0), vec2(2.0), u_seed + 11.0));
  float crack = (1.0 - smoothstep(0.0, 0.035, abs(ang - 0.5)))
                * smoothstep(0.04, 0.32, r) * step(0.5, WEAR + 0.2);
  float bw = 0.055;
  float rim = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - bw)), 0.008);
  float bark = pridge(uv, vec2(cellsOf(26.0)), 3, u_seed + 17.7);
  float fine = pfbm(uv, vec2(cellsOf(50.0), cellsOf(50.0)), 3, u_seed + 23.3);

  Surf s = surfInit();
  // Heartwood at the pith fading to sapwood outward.
  vec3 wood = mix(C1, C2, clamp(r * 2.1, 0.0, 1.0) * clamp(HUEV, 0.0, 1.0));
  wood *= 0.90 + 0.20 * fine;
  wood = mix(wood, C2 * 0.72, ringLine * 0.85);
  wood = mix(wood, C2 * 0.4, crack * 0.9);
  vec3 barkCol = mix(C3 * 0.7, C3, bark);
  s.albedo = mix(wood, barkCol, rim);
  s.rough = clamp(ROUGHB + ringLine * 0.05 + rim * 0.06, 0.3, 1.0);
  s.ao = clamp(1.0 - ringLine * 0.35 * CAVITY - crack * 0.6 - rim * 0.15, 0.0, 1.0);
  return s;
}

/** Shared plank relief. \`dark\` doubles the grain contrast for plank_dark. */
float planksH(vec2 uv, float dark) {
  float rows = cellsOf(4.0);
  float y = uv.y * rows;
  float bi = floor(y);
  float fy = fract(y);
  float phase = ph1(vec2(0.0, bi), vec2(1.0, rows), u_seed) * 3.7;
  float grainF = countOf(24.0 * STRUCTP + 2.0);
  vec2 guv = vec2(uv.x + phase, uv.y);
  float grain = pridge(guv, vec2(max(3.0, floor(grainF * 0.22 + 0.5)), grainF), 4, u_seed + 3.3);
  float seam = 1.0 - smoothstep(0.0, 0.055, min(fy, 1.0 - fy));
  float knot = speck(vec2(uv.x + phase, fy), cellsOf(5.0), 0.28 * WEAR, 0.34, u_seed + 9.7);
  float bevel = smoothstep(0.0, 0.12, min(fy, 1.0 - fy));
  float h = 0.58 + (grain - 0.5) * (0.22 + 0.20 * dark);
  h -= seam * (0.35 + 0.5 * CAVITY);
  h += bevel * 0.06 * SPARK * 4.0;
  h -= knot * 0.22;
  return h;
}

Surf planksS(vec2 uv, float dark) {
  float rows = cellsOf(4.0);
  float y = uv.y * rows;
  float bi = floor(y);
  float fy = fract(y);
  float tone = ph1(vec2(0.0, bi), vec2(1.0, rows), u_seed + 5.1);
  float phase = ph1(vec2(0.0, bi), vec2(1.0, rows), u_seed) * 3.7;
  float grainF = countOf(24.0 * STRUCTP + 2.0);
  vec2 guv = vec2(uv.x + phase, uv.y);
  float grain = pridge(guv, vec2(max(3.0, floor(grainF * 0.22 + 0.5)), grainF), 4, u_seed + 3.3);
  float fine = pfbm(guv, vec2(grainF * 2.0, grainF * 0.4), 3, u_seed + 7.9);
  float seam = 1.0 - smoothstep(0.0, 0.055, min(fy, 1.0 - fy));
  float knot = speck(vec2(uv.x + phase, fy), cellsOf(5.0), 0.28 * WEAR, 0.34, u_seed + 9.7);
  float nail = speck(vec2(uv.x, fy), cellsOf(4.0), 0.18 * WEAR, 0.10, u_seed + 15.3);
  float bevel = smoothstep(0.0, 0.12, min(fy, 1.0 - fy));

  Surf s = surfInit();
  vec3 board = mix(C2, C1, 0.20 + 0.80 * tone * clamp(HUEV * 2.2, 0.0, 1.0) + 0.35 * (1.0 - clamp(HUEV * 2.2, 0.0, 1.0)));
  float gcontrast = 0.30 + 0.34 * dark;
  board *= 1.0 - grain * gcontrast;
  board = mix(board, C3, smoothstep(0.62, 1.0, fine) * (0.28 + 0.2 * dark));
  board = mix(board, C2 * 0.55, knot * 0.85);
  board = mix(board, C3 * 0.85, nail * 0.9);
  board *= 0.94 + 0.10 * bevel;
  s.albedo = mix(C2 * 0.35, board, smoothstep(0.0, 0.9, 1.0 - seam));
  s.metal = mix(METALB, 0.85, nail * 0.8);
  s.rough = clamp(ROUGHB + grain * 0.10 - nail * 0.45, 0.12, 1.0);
  s.ao = clamp(1.0 - seam * 0.75 - knot * 0.25, 0.0, 1.0);
  if (u_alphaMode > 0.5) {
    // Door-top style window panel punched through the boards.
    float win = inside(sdBox(uv - vec2(0.5, 0.62), vec2(0.26, 0.20)), 0.004);
    s.alpha = 1.0 - win;
  }
  return s;
}

float hPlanks(vec2 uv) { return planksH(uv, 0.0); }
Surf sPlanks(vec2 uv, float h) { return planksS(uv, 0.0); }
float hPlankDark(vec2 uv) { return planksH(uv, 1.0); }
Surf sPlankDark(vec2 uv, float h) { return planksS(uv, 1.0); }

/* ======================================================================== */
/* Foliage                                                                  */
/* ======================================================================== */

/** Topmost leaf under \`uv\` from an overlapping cluster field. */
struct Leaf {
  float cover;  // 1 where a leaf covers the texel
  float depth;  // stacking order of the winning leaf
  float dome;   // cross-leaf curvature, 0 at the rim
  float vein;   // 1 on a vein
  float id;     // per-leaf random
  float tip;    // 0 at the stalk, 1 at the leaf tip
};

Leaf leafField(vec2 uv, float cells, float gapFrac, float salt) {
  vec2 p = uv * cells;
  vec2 base = floor(p);
  vec2 fr = fract(p);
  Leaf best;
  best.cover = 0.0;
  best.depth = -1.0;
  best.dome = 0.0;
  best.vein = 0.0;
  best.id = 0.0;
  best.tip = 0.0;
  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      vec2 g = vec2(float(x), float(y));
      vec2 c = base + g;
      float keep = ph1(c, vec2(cells), salt + 2.2);
      if (keep < gapFrac) continue;
      vec2 j = ph2(c, vec2(cells), salt);
      vec2 ctr = g + clamp(j, vec2(0.15), vec2(0.85));
      vec2 q = fr - ctr;
      float ang = ph1(c, vec2(cells), salt + 9.3) * TAU;
      vec2 lp = rotate2(q, ang);
      float len = 0.62 + 0.55 * ph1(c, vec2(cells), salt + 13.7);
      float wid = len * (0.36 + 0.22 * ph1(c, vec2(cells), salt + 21.1));
      float t = lp.y / len + 0.5;
      if (t <= 0.0 || t >= 1.0) continue;
      float w = wid * pow(max(sin(PI * t), 0.0), 0.60);
      if (abs(lp.x) > w) continue;
      float depth = keep + 0.35 * ph1(c, vec2(cells), salt + 27.5);
      if (depth <= best.depth) continue;
      float nx = lp.x / max(w, 1.0e-4);
      best.depth = depth;
      best.cover = 1.0;
      best.id = ph1(c, vec2(cells), salt + 31.9);
      best.tip = t;
      best.dome = sqrt(max(0.0, 1.0 - nx * nx)) * (0.35 + 0.65 * sin(PI * t));
      float mid = 1.0 - smoothstep(0.0, 0.18, abs(nx));
      float lateral = 1.0 - smoothstep(0.0, 0.34,
        abs(fract(t * 8.0 + abs(nx) * 2.6) - 0.5) * 2.0);
      best.vein = clamp(mid + lateral * 0.5 * smoothstep(0.06, 0.2, abs(nx)), 0.0, 1.0);
    }
  }
  return best;
}

float hLeaves(vec2 uv) {
  float cells = cellsOf(10.0 * STRUCTP + 1.0);
  Leaf a = leafField(uv, cells, clamp(CAVITY, 0.0, 0.85), u_seed);
  Leaf b = leafField(uv, cells * 1.7, clamp(CAVITY * 0.7, 0.0, 0.85), u_seed + 51.0);
  float ha = a.cover * (0.30 + 0.42 * a.depth + 0.30 * a.dome);
  float hb = b.cover * (0.18 + 0.30 * b.depth + 0.24 * b.dome);
  return 0.12 + max(ha, hb) - max(a.vein * a.cover, b.vein * b.cover) * 0.10;
}

Surf sLeaves(vec2 uv, float h) {
  float cells = cellsOf(10.0 * STRUCTP + 1.0);
  Leaf a = leafField(uv, cells, clamp(CAVITY, 0.0, 0.85), u_seed);
  Leaf b = leafField(uv, cells * 1.7, clamp(CAVITY * 0.7, 0.0, 0.85), u_seed + 51.0);
  float aTop = step(b.cover * (0.18 + 0.30 * b.depth), a.cover * (0.30 + 0.42 * a.depth));
  Leaf L;
  L.cover = max(a.cover, b.cover);
  L.depth = mix(b.depth, a.depth, aTop);
  L.dome = mix(b.dome, a.dome, aTop);
  L.vein = mix(b.vein, a.vein, aTop);
  L.id = mix(b.id, a.id, aTop);
  L.tip = mix(b.tip, a.tip, aTop);

  float speckN = speck(uv, cells * 5.0, 0.25, 0.34, u_seed + 63.0);
  Surf s = surfInit();
  vec3 leaf = mix(C1, C2, clamp(HUEV, 0.0, 1.0) * L.id);
  leaf *= 0.72 + 0.42 * L.dome;
  leaf = mix(leaf, C3, smoothstep(0.62, 1.0, L.tip) * clamp(SPARK, 0.0, 1.0));
  leaf = mix(leaf, C3 * 0.9, L.vein * 0.35);
  leaf = mix(leaf, C2 * 0.7, speckN * 0.25);
  // Layers behind the top leaf go darker so the canopy reads as deep.
  leaf *= mix(0.55, 1.0, clamp(L.depth, 0.0, 1.0));
  s.albedo = leaf;
  s.rough = clamp(ROUGHB - L.dome * 0.08, 0.3, 1.0);
  s.ao = clamp(0.45 + 0.55 * clamp(L.depth, 0.0, 1.0) * (0.5 + 0.5 * L.dome), 0.0, 1.0);
  s.alpha = L.cover;
  return s;
}

float hAzalea(vec2 uv) {
  float cells = cellsOf(9.0 * STRUCTP + 1.0);
  Leaf a = leafField(uv, cells, 0.06, u_seed);
  float blossom = speck(uv, cellsOf(6.0), 0.55 * WEAR, 0.40, u_seed + 43.0);
  return 0.18 + a.cover * (0.32 + 0.36 * a.depth + 0.30 * a.dome) + blossom * 0.28;
}

Surf sAzalea(vec2 uv, float h) {
  float cells = cellsOf(9.0 * STRUCTP + 1.0);
  Leaf a = leafField(uv, cells, 0.06, u_seed);
  float blossom = speck(uv, cellsOf(6.0), 0.55 * WEAR, 0.40, u_seed + 43.0);
  float petal = speck(uv, cellsOf(12.0), 0.45 * WEAR, 0.30, u_seed + 47.0);
  Surf s = surfInit();
  vec3 leaf = mix(C1, C2, clamp(HUEV, 0.0, 1.0) * a.id) * (0.70 + 0.44 * a.dome);
  leaf = mix(leaf, C1 * 1.25, a.vein * 0.22);
  s.albedo = mix(C2 * 0.6, leaf, a.cover);
  s.albedo = mix(s.albedo, C3, clamp(blossom * 0.95 + petal * 0.6, 0.0, 1.0));
  s.rough = clamp(ROUGHB - blossom * 0.1, 0.3, 1.0);
  s.ao = clamp(0.55 + 0.5 * h, 0.0, 1.0);
  s.alpha = u_alphaMode > 0.5 ? clamp(a.cover + blossom, 0.0, 1.0) : 1.0;
  return s;
}

/* ======================================================================== */
/* Plants                                                                   */
/* ======================================================================== */

/** Tuft of blades / stalks growing from the bottom edge. */
vec4 plantBlades(vec2 uv, float count, float widthFrac, float bend, float salt) {
  float best = 0.0;
  float bestT = 0.0;
  float bestId = 0.0;
  for (int i = 0; i < 24; ++i) {
    if (float(i) >= count) break;
    float fi = float(i);
    float id = ph1(vec2(fi, 0.0), vec2(64.0), salt);
    float id2 = ph1(vec2(fi, 1.0), vec2(64.0), salt + 3.3);
    float x0 = (fi + 0.5) / count + (id - 0.5) * 0.6 / count;
    float hgt = 0.45 + 0.55 * id2;
    float lean = (id - 0.5) * 2.0 * bend;
    vec2 root = vec2(x0, 0.0);
    vec2 mid = vec2(x0 + lean * 0.35, hgt * 0.55);
    vec2 tip = vec2(x0 + lean, hgt);
    float d = min(sdSeg(uv, root, mid), sdSeg(uv, mid, tip));
    float t = clamp(uv.y / max(hgt, 1.0e-4), 0.0, 1.0);
    float w = widthFrac * (1.0 - 0.7 * t) * (0.7 + 0.6 * id2);
    float m = 1.0 - smoothstep(w * 0.5, w, d);
    float score = m * (0.4 + 0.6 * id2);
    if (score > best) { best = score; bestT = t; bestId = id2; }
  }
  return vec4(best > 0.02 ? 1.0 : 0.0, best, bestT, bestId);
}

float hGrassPlant(vec2 uv) {
  if (STRUCTP <= 0.25) {
    // Stalk mode: bamboo / sugar cane with node rings every 1/8.
    float stalks = countOf(3.0);
    float w = 0.10 + 0.08 * CAVITY;
    float best = 0.0;
    for (int i = 0; i < 4; ++i) {
      if (float(i) >= stalks) break;
      float fi = float(i);
      float x0 = (fi + 0.5) / stalks + (ph1(vec2(fi, 0.0), vec2(8.0), u_seed) - 0.5) * 0.12;
      float lean = (ph1(vec2(fi, 2.0), vec2(8.0), u_seed) - 0.5) * 0.10;
      float d = abs(uv.x - (x0 + lean * uv.y));
      best = max(best, 1.0 - smoothstep(w * 0.75, w, d));
    }
    float node = 1.0 - smoothstep(0.0, 0.028, abs(fract(uv.y * 8.0) - 0.5) * 0.5);
    return 0.25 + best * (0.55 - node * 0.22 * SPARK);
  }
  float count = countOf(14.0 * STRUCTP);
  vec4 b = plantBlades(uv, count, 0.024 + 0.05 * CAVITY, 0.28 * WEAR + 0.06, u_seed);
  return 0.22 + b.y * 0.55;
}

Surf sGrassPlant(vec2 uv, float h) {
  Surf s = surfInit();
  if (STRUCTP <= 0.25) {
    float stalks = countOf(3.0);
    float w = 0.10 + 0.08 * CAVITY;
    float best = 0.0;
    float bestId = 0.0;
    float bestOff = 0.0;
    for (int i = 0; i < 4; ++i) {
      if (float(i) >= stalks) break;
      float fi = float(i);
      float x0 = (fi + 0.5) / stalks + (ph1(vec2(fi, 0.0), vec2(8.0), u_seed) - 0.5) * 0.12;
      float lean = (ph1(vec2(fi, 2.0), vec2(8.0), u_seed) - 0.5) * 0.10;
      float off = uv.x - (x0 + lean * uv.y);
      float m = 1.0 - smoothstep(w * 0.75, w, abs(off));
      if (m > best) { best = m; bestId = ph1(vec2(fi, 3.0), vec2(8.0), u_seed); bestOff = off / w; }
    }
    float node = 1.0 - smoothstep(0.0, 0.06, abs(fract(uv.y * 8.0) - 0.5) * 2.0);
    vec3 col = mix(C2, C1, 0.3 + 0.7 * bestId);
    col *= 0.72 + 0.5 * sqrt(max(0.0, 1.0 - bestOff * bestOff));
    col = mix(col, C3, node * clamp(SPARK, 0.0, 1.0));
    s.albedo = col;
    s.alpha = step(0.35, best);
    s.rough = ROUGHB;
    s.ao = clamp(0.6 + 0.4 * h, 0.0, 1.0);
    return s;
  }
  float count = countOf(14.0 * STRUCTP);
  vec4 b = plantBlades(uv, count, 0.024 + 0.05 * CAVITY, 0.28 * WEAR + 0.06, u_seed);
  vec3 col = mix(C1, C2, clamp(WEAR, 0.0, 1.0) * b.z);
  col = mix(col, C3, (1.0 - b.z) * 0.4);
  col = mix(col, C2 * 1.25, smoothstep(0.75, 1.0, b.z) * clamp(SPARK, 0.0, 1.0));
  col *= 0.72 + 0.5 * b.y;
  s.albedo = col;
  s.alpha = b.x;
  s.rough = ROUGHB;
  s.ao = clamp(0.55 + 0.5 * b.z, 0.0, 1.0);
  return s;
}

/** Flower geometry mask. x = petal, y = pistil, z = stem/leaf, w = petal radius t. */
vec4 flowerMask(vec2 uv) {
  float petals = max(3.0, floor(8.0 * STRUCTP + 0.5));
  float R = mix(0.10, 0.50, clamp(CAVITY, 0.0, 1.0));
  float stemH = mix(0.15, 0.85, clamp(WEAR, 0.0, 1.0));
  vec2 ctr = vec2(0.5, clamp(stemH + R * 0.55, 0.2, 0.86));
  vec2 q = uv - ctr;
  float r = length(q);
  float a = atan(q.y, q.x);
  float wob = (pfbm(uv, vec2(12.0), 3, u_seed + 3.7) - 0.5) * 0.10;
  float petalR = R * (0.70 + 0.30 * abs(cos(a * petals * 0.5))) * (1.0 + wob);
  float petal = inside(r - petalR, 0.008);
  float pR = R * mix(0.12, 0.48, clamp(SPARK, 0.0, 1.0));
  float pistil = inside(r - pR, 0.006);
  float sw = 0.010 + 0.016 * clamp(TILEP, 0.0, 2.0);
  float sx = 0.5 + sin(uv.y * 3.4 + u_seed) * 0.02;
  float stem = (1.0 - smoothstep(sw * 0.7, sw, abs(uv.x - sx))) * step(uv.y, ctr.y);
  // Two small leaves on the stem.
  for (int i = 0; i < 2; ++i) {
    float fi = float(i);
    float ly = stemH * (0.30 + 0.34 * fi);
    float dir = fi < 0.5 ? -1.0 : 1.0;
    vec2 lp = uv - vec2(sx, ly);
    lp = rotate2(lp, dir * 0.9);
    float d = length(vec2(lp.x / 0.115, lp.y / 0.030)) - 1.0;
    stem = max(stem, inside(d, 0.12) * step(0.0, dir * (uv.x - sx) + 0.02));
  }
  return vec4(petal, pistil, clamp(stem, 0.0, 1.0), clamp(r / max(petalR, 1.0e-3), 0.0, 1.0));
}

float hFlower(vec2 uv) {
  vec4 m = flowerMask(uv);
  float dome = sqrt(max(0.0, 1.0 - m.w * m.w));
  return 0.25 + m.x * (0.30 + 0.30 * dome) + m.y * 0.22 + m.z * 0.24;
}

Surf sFlower(vec2 uv, float h) {
  vec4 m = flowerMask(uv);
  float dome = sqrt(max(0.0, 1.0 - m.w * m.w));
  float grainN = pfbm(uv, vec2(cellsOf(30.0)), 3, u_seed + 5.5);
  Surf s = surfInit();
  vec3 petal = C1 * (0.78 + 0.34 * dome);
  petal = mix(petal, C1 * 1.25, smoothstep(0.65, 1.0, m.w) * 0.4);
  petal *= 0.94 + 0.12 * grainN;
  s.albedo = petal;
  s.albedo = mix(s.albedo, C3, m.z * (1.0 - m.x));
  s.albedo = mix(s.albedo, C2, m.y);
  s.rough = clamp(ROUGHB - m.y * 0.1, 0.25, 1.0);
  s.ao = clamp(0.6 + 0.4 * dome, 0.0, 1.0);
  s.alpha = clamp(max(max(m.x, m.y), m.z), 0.0, 1.0);
  return s;
}

/** Wheat / root crop mask. x = stalk, y = ear, z = leaf, w = ear parameter. */
vec4 cropMask(vec2 uv) {
  float stalks = max(1.0, floor(6.0 * STRUCTP + 0.5));
  float earLen = clamp(CAVITY, 0.0, 1.0);
  float droop = clamp(WEAR, 0.0, 1.0);
  float stalk = 0.0;
  float ear = 0.0;
  float leaf = 0.0;
  float earT = 0.0;
  for (int i = 0; i < 8; ++i) {
    if (float(i) >= stalks) break;
    float fi = float(i);
    float id = ph1(vec2(fi, 0.0), vec2(16.0), u_seed);
    float x0 = (fi + 0.5) / stalks + (id - 0.5) * 0.5 / stalks;
    float hgt = 0.55 + 0.42 * id;
    float lean = (id - 0.5) * 0.5 * droop;
    float sx = x0 + lean * uv.y * uv.y;
    float d = abs(uv.x - sx);
    stalk = max(stalk, (1.0 - smoothstep(0.010, 0.020, d)) * step(uv.y, hgt));
    // Seed head: a spindle at the top of the stalk.
    float e0 = hgt * (1.0 - earLen * 0.75);
    float t = clamp((uv.y - e0) / max(hgt - e0, 1.0e-4), 0.0, 1.0);
    float ew = 0.045 * sin(PI * clamp(t, 0.0, 1.0)) * (0.6 + 0.8 * earLen);
    float em = (1.0 - smoothstep(ew * 0.6, ew, d)) * step(e0, uv.y) * step(uv.y, hgt);
    // Grain kernels stacked along the ear.
    float kern = 0.55 + 0.45 * cos(t * PI * 9.0);
    if (em > ear) { ear = em * kern; earT = t; }
    // Awns / bristles above the ear.
    float awn = (1.0 - smoothstep(0.004, 0.010, abs(uv.x - sx - (fract(uv.y * 40.0) - 0.5) * 0.05)))
                * step(hgt, uv.y) * step(uv.y, hgt + 0.10 * clamp(SPARK, 0.0, 1.0));
    ear = max(ear, awn * 0.6);
    // Basal leaves.
    vec2 lp = rotate2(uv - vec2(sx, hgt * 0.28), (id - 0.5) * 2.2);
    float ld = length(vec2(lp.x / 0.13, lp.y / 0.022)) - 1.0;
    leaf = max(leaf, inside(ld, 0.15));
  }
  return vec4(stalk, ear, leaf, earT);
}

float hWheat(vec2 uv) {
  vec4 m = cropMask(uv);
  return 0.24 + m.x * 0.22 + m.y * 0.36 + m.z * 0.20;
}

Surf sWheat(vec2 uv, float h) {
  vec4 m = cropMask(uv);
  Surf s = surfInit();
  vec3 col = C3;
  col = mix(col, C1, m.x);
  col = mix(col, mix(C2, C3, smoothstep(0.2, 0.9, m.w)), m.y);
  col = mix(col, C1 * 0.85, m.z * (1.0 - m.y) * 0.9);
  col *= 0.92 + 0.16 * pfbm(uv, vec2(cellsOf(28.0)), 3, u_seed + 7.1);
  s.albedo = col;
  s.rough = ROUGHB;
  s.ao = clamp(0.6 + 0.4 * h, 0.0, 1.0);
  s.alpha = clamp(max(max(m.x, m.y), m.z), 0.0, 1.0);
  return s;
}

float hMushroom(vec2 uv) {
  float capR = 0.34;
  vec2 c = vec2(0.5, 0.60);
  vec2 q = uv - c;
  float dome = clamp(CAVITY, 0.0, 1.0);
  float cap = inside(length(vec2(q.x / capR, q.y / (capR * (0.55 + 0.5 * dome)))) - 1.0, 0.01)
              * step(0.0, q.y + capR * 0.15);
  float stemW = mix(0.05, 0.16, clamp(WEAR, 0.0, 1.0));
  float stem = inside(sdBox(uv - vec2(0.5, 0.30), vec2(stemW, 0.30)) - 0.02, 0.01);
  float spots = speck(uv, cellsOf(9.0), 0.4 * STRUCTP, 0.32, u_seed + 11.3);
  float capDome = sqrt(max(0.0, 1.0 - dot(q / capR, q / capR)));
  return 0.22 + cap * (0.30 + 0.34 * capDome) + stem * 0.24 - spots * cap * 0.06;
}

Surf sMushroom(vec2 uv, float h) {
  float capR = 0.34;
  vec2 c = vec2(0.5, 0.60);
  vec2 q = uv - c;
  float dome = clamp(CAVITY, 0.0, 1.0);
  float cap = inside(length(vec2(q.x / capR, q.y / (capR * (0.55 + 0.5 * dome)))) - 1.0, 0.01)
              * step(0.0, q.y + capR * 0.15);
  float stemW = mix(0.05, 0.16, clamp(WEAR, 0.0, 1.0));
  float stem = inside(sdBox(uv - vec2(0.5, 0.30), vec2(stemW, 0.30)) - 0.02, 0.01);
  float gills = 1.0 - smoothstep(0.0, 0.045, abs(q.y + capR * 0.08));
  float spots = speck(uv, cellsOf(9.0), 0.4 * STRUCTP, 0.32, u_seed + 11.3);
  float capDome = sqrt(max(0.0, 1.0 - clamp(dot(q / capR, q / capR), 0.0, 1.0)));
  Surf s = surfInit();
  vec3 col = C1 * (0.72 + 0.46 * capDome);
  col = mix(col, C2, spots * 0.9);
  vec3 stemCol = C3 * (0.8 + 0.3 * (1.0 - abs(uv.x - 0.5) / max(stemW, 1e-3)));
  s.albedo = mix(stemCol, col, cap);
  s.albedo = mix(s.albedo, C3 * 0.75, gills * cap * 0.6);
  s.rough = ROUGHB;
  s.ao = clamp(0.55 + 0.5 * capDome * cap + 0.3 * stem, 0.0, 1.0);
  s.alpha = clamp(max(cap, stem), 0.0, 1.0);
  return s;
}

float hVine(vec2 uv) {
  float strands = max(1.0, floor(9.0 * STRUCTP + 0.5));
  float m = 0.0;
  float lm = 0.0;
  for (int i = 0; i < 12; ++i) {
    if (float(i) >= strands) break;
    float fi = float(i);
    float id = ph1(vec2(fi, 0.0), vec2(16.0), u_seed);
    float x0 = (fi + 0.5) / strands;
    float len = mix(0.5, 1.0, mix(id, 1.0, 1.0 - clamp(WEAR, 0.0, 1.0)));
    float sx = x0 + sin(uv.y * 9.0 + id * TAU) * 0.035;
    m = max(m, (1.0 - smoothstep(0.008, 0.016, abs(uv.x - sx))) * step(1.0 - len, uv.y));
    for (int k = 0; k < 4; ++k) {
      float fk = float(k);
      float ly = 1.0 - len * (0.12 + 0.24 * fk);
      float dir = mod(fk + fi, 2.0) < 0.5 ? -1.0 : 1.0;
      vec2 lp = rotate2(uv - vec2(sx, ly), dir * 0.7);
      float d = length(vec2(lp.x / 0.075, lp.y / 0.035)) - 1.0;
      lm = max(lm, inside(d, 0.2) * clamp(CAVITY * 2.0, 0.0, 1.0));
    }
  }
  return 0.2 + m * 0.28 + lm * 0.34;
}

Surf sVine(vec2 uv, float h) {
  float strands = max(1.0, floor(9.0 * STRUCTP + 0.5));
  float m = 0.0;
  float lm = 0.0;
  float id = 0.0;
  for (int i = 0; i < 12; ++i) {
    if (float(i) >= strands) break;
    float fi = float(i);
    float rid = ph1(vec2(fi, 0.0), vec2(16.0), u_seed);
    float x0 = (fi + 0.5) / strands;
    float len = mix(0.5, 1.0, mix(rid, 1.0, 1.0 - clamp(WEAR, 0.0, 1.0)));
    float sx = x0 + sin(uv.y * 9.0 + rid * TAU) * 0.035;
    float sm = (1.0 - smoothstep(0.008, 0.016, abs(uv.x - sx))) * step(1.0 - len, uv.y);
    if (sm > m) { m = sm; id = rid; }
    for (int k = 0; k < 4; ++k) {
      float fk = float(k);
      float ly = 1.0 - len * (0.12 + 0.24 * fk);
      float dir = mod(fk + fi, 2.0) < 0.5 ? -1.0 : 1.0;
      vec2 lp = rotate2(uv - vec2(sx, ly), dir * 0.7);
      float d = length(vec2(lp.x / 0.075, lp.y / 0.035)) - 1.0;
      float leaf = inside(d, 0.2) * clamp(CAVITY * 2.0, 0.0, 1.0);
      if (leaf > lm) { lm = leaf; id = rid; }
    }
  }
  Surf s = surfInit();
  vec3 col = mix(C2, C1, 0.3 + 0.7 * id);
  col = mix(col, C3, lm * 0.55 * clamp(HUEV, 0.0, 1.0));
  col *= 0.85 + 0.3 * pfbm(uv, vec2(cellsOf(24.0)), 3, u_seed + 9.9);
  s.albedo = col;
  s.rough = ROUGHB;
  s.ao = clamp(0.6 + 0.4 * h, 0.0, 1.0);
  s.alpha = clamp(max(m, lm), 0.0, 1.0);
  return s;
}

float hKelp(vec2 uv) {
  float blades = max(1.0, floor(5.0 * STRUCTP + 0.5));
  float m = 0.0;
  for (int i = 0; i < 8; ++i) {
    if (float(i) >= blades) break;
    float fi = float(i);
    float id = ph1(vec2(fi, 0.0), vec2(16.0), u_seed);
    float x0 = (fi + 0.5) / blades;
    float sway = sin(uv.y * (3.0 + 3.0 * id) + id * TAU) * (0.06 + 0.10 * clamp(CAVITY, 0.0, 1.0));
    float w = (0.035 + 0.045 * id) * (0.45 + 0.75 * sin(PI * clamp(uv.y * 1.05, 0.0, 1.0)));
    m = max(m, 1.0 - smoothstep(w * 0.65, w, abs(uv.x - x0 - sway)));
  }
  float ripple = 0.5 + 0.5 * sin(uv.y * 26.0);
  return 0.2 + m * (0.32 + 0.12 * ripple);
}

Surf sKelp(vec2 uv, float h) {
  float blades = max(1.0, floor(5.0 * STRUCTP + 0.5));
  float m = 0.0;
  float off = 0.0;
  float id = 0.0;
  for (int i = 0; i < 8; ++i) {
    if (float(i) >= blades) break;
    float fi = float(i);
    float rid = ph1(vec2(fi, 0.0), vec2(16.0), u_seed);
    float x0 = (fi + 0.5) / blades;
    float sway = sin(uv.y * (3.0 + 3.0 * rid) + rid * TAU) * (0.06 + 0.10 * clamp(CAVITY, 0.0, 1.0));
    float w = (0.035 + 0.045 * rid) * (0.45 + 0.75 * sin(PI * clamp(uv.y * 1.05, 0.0, 1.0)));
    float d = uv.x - x0 - sway;
    float mm = 1.0 - smoothstep(w * 0.65, w, abs(d));
    if (mm > m) { m = mm; off = d / max(w, 1.0e-4); id = rid; }
  }
  Surf s = surfInit();
  vec3 col = mix(C2, C1, 0.3 + 0.7 * id);
  col *= 0.7 + 0.5 * sqrt(max(0.0, 1.0 - off * off));
  col = mix(col, C3, smoothstep(0.4, 1.0, 0.5 + 0.5 * sin(uv.y * 20.0 + id * TAU))
            * clamp(WEAR, 0.0, 1.0) * 0.6);
  s.albedo = col;
  s.rough = ROUGHB;
  s.ao = clamp(0.65 + 0.35 * h, 0.0, 1.0);
  s.alpha = step(0.35, m);
  return s;
}

float hCoral(vec2 uv) {
  float branches = max(1.0, floor(7.0 * STRUCTP + 0.5));
  float thick = mix(0.02, 0.075, clamp(WEAR, 0.0, 1.0));
  float m = 0.0;
  for (int i = 0; i < 10; ++i) {
    if (float(i) >= branches) break;
    float fi = float(i);
    float id = ph1(vec2(fi, 0.0), vec2(16.0), u_seed);
    float x0 = 0.5 + (fi / max(branches - 1.0, 1.0) - 0.5) * 0.8;
    float hgt = 0.45 + 0.5 * id;
    vec2 root = vec2(0.5 + (id - 0.5) * 0.1, 0.02);
    vec2 mid = vec2(mix(root.x, x0, 0.6), hgt * 0.55);
    vec2 tip = vec2(x0, hgt);
    float d = min(sdSeg(uv, root, mid), sdSeg(uv, mid, tip));
    m = max(m, 1.0 - smoothstep(thick * 0.7, thick, d));
    m = max(m, inside(length(uv - tip) - thick * 1.35, 0.008));
  }
  float polyp = speck(uv, cellsOf(20.0), 0.5 * clamp(CAVITY, 0.0, 1.0), 0.35, u_seed + 13.7);
  return 0.2 + m * 0.38 + m * polyp * 0.16;
}

Surf sCoral(vec2 uv, float h) {
  float branches = max(1.0, floor(7.0 * STRUCTP + 0.5));
  float thick = mix(0.02, 0.075, clamp(WEAR, 0.0, 1.0));
  float m = 0.0;
  float id = 0.0;
  float rim = 0.0;
  for (int i = 0; i < 10; ++i) {
    if (float(i) >= branches) break;
    float fi = float(i);
    float rid = ph1(vec2(fi, 0.0), vec2(16.0), u_seed);
    float x0 = 0.5 + (fi / max(branches - 1.0, 1.0) - 0.5) * 0.8;
    float hgt = 0.45 + 0.5 * rid;
    vec2 root = vec2(0.5 + (rid - 0.5) * 0.1, 0.02);
    vec2 mid = vec2(mix(root.x, x0, 0.6), hgt * 0.55);
    vec2 tip = vec2(x0, hgt);
    float d = min(sdSeg(uv, root, mid), min(sdSeg(uv, mid, tip), length(uv - tip) - thick * 0.35));
    float mm = 1.0 - smoothstep(thick * 0.7, thick, d);
    if (mm > m) { m = mm; id = rid; rim = smoothstep(thick * 0.25, thick, d); }
  }
  float polyp = speck(uv, cellsOf(20.0), 0.5 * clamp(CAVITY, 0.0, 1.0), 0.35, u_seed + 13.7);
  Surf s = surfInit();
  vec3 col = mix(C2, C1, 0.25 + 0.75 * id);
  col = mix(col, C3, polyp * 0.8 + rim * clamp(SPARK, 0.0, 1.0) * 0.6);
  s.albedo = col;
  s.rough = clamp(ROUGHB - polyp * 0.15, 0.1, 1.0);
  s.ao = clamp(0.6 + 0.4 * h, 0.0, 1.0);
  s.emit = EMITB * (0.5 + 0.5 * rim);
  s.alpha = step(0.35, m);
  return s;
}

/* --- cactus, melon, pumpkin, hay, sponge --------------------------------- */

float hCactus(vec2 uv) {
  float ribs = countOf(6.0 * STRUCTP + 1.0);
  float depth = clamp(CAVITY, 0.0, 1.0);
  if (STRUCTP > 0.7) {
    float r = abs(fract(uv.x * ribs) - 0.5) * 2.0;
    float groove = 1.0 - smoothstep(0.0, 0.35, r);
    float areole = speck(uv, cellsOf(7.0), 0.6 * WEAR, 0.22, u_seed + 5.3);
    float spine = speck(uv, cellsOf(14.0), 0.5 * WEAR, 0.10, u_seed + 9.1);
    return 0.55 + (1.0 - groove) * 0.20 * depth - groove * 0.22 * depth
           - areole * 0.18 + spine * 0.30;
  }
  Cell c = pcells(uv, vec2(cellsOf(3.0)), u_seed, 0.6);
  float rim = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - 0.06)), 0.01);
  float spine = speck(uv, cellsOf(12.0), 0.45 * WEAR, 0.10, u_seed + 9.1);
  return 0.55 + (c.id - 0.5) * 0.18 - rim * 0.22 + spine * 0.28;
}

Surf sCactus(vec2 uv, float h) {
  float ribs = countOf(6.0 * STRUCTP + 1.0);
  float fine = pfbm(uv, vec2(cellsOf(26.0)), 3, u_seed + 3.7);
  Surf s = surfInit();
  if (STRUCTP > 0.7) {
    float r = abs(fract(uv.x * ribs) - 0.5) * 2.0;
    float groove = 1.0 - smoothstep(0.0, 0.35, r);
    float areole = speck(uv, cellsOf(7.0), 0.6 * WEAR, 0.22, u_seed + 5.3);
    float spine = speck(uv, cellsOf(14.0), 0.5 * WEAR, 0.10, u_seed + 9.1);
    s.albedo = mix(C1, C2, groove * 0.85) * (0.9 + 0.2 * fine);
    s.albedo = mix(s.albedo, C2 * 0.55, areole * 0.85);
    s.albedo = mix(s.albedo, C3, spine * 0.95);
    s.ao = clamp(1.0 - groove * 0.5 - areole * 0.35, 0.0, 1.0);
  } else {
    Cell c = pcells(uv, vec2(cellsOf(3.0)), u_seed, 0.6);
    float rim = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - 0.06)), 0.01);
    float spine = speck(uv, cellsOf(12.0), 0.45 * WEAR, 0.10, u_seed + 9.1);
    s.albedo = mix(C2, C1, 0.35 + 0.65 * c.id) * (0.9 + 0.2 * fine);
    s.albedo = mix(s.albedo, C2 * 0.7, rim * 0.7);
    s.albedo = mix(s.albedo, C3, spine * 0.95);
    s.ao = clamp(1.0 - rim * 0.4, 0.0, 1.0);
  }
  s.rough = clamp(ROUGHB + (fine - 0.5) * 0.1, 0.3, 1.0);
  return s;
}

float hMelon(vec2 uv) {
  float pits = speck(uv, cellsOf(30.0), 0.4 * WEAR, 0.4, u_seed + 7.7);
  if (STRUCTP >= 0.9) {
    float stripes = countOf(8.0 * STRUCTP);
    float wob = (pfbm(uv, vec2(3.0, 6.0), 3, u_seed + 2.3) - 0.5) * clamp(CAVITY, 0.0, 1.0) * 0.5;
    float t = abs(fract(uv.x * stripes + wob) - 0.5) * 2.0;
    return 0.6 + (1.0 - t) * 0.10 - pits * 0.22;
  }
  float r = length(uv - vec2(0.5));
  float scar = inside(r - 0.13, 0.02);
  return 0.62 - scar * 0.24 - pits * 0.2;
}

Surf sMelon(vec2 uv, float h) {
  float pits = speck(uv, cellsOf(30.0), 0.4 * WEAR, 0.4, u_seed + 7.7);
  float fine = pfbm(uv, vec2(cellsOf(16.0)), 3, u_seed + 11.1);
  Surf s = surfInit();
  if (STRUCTP >= 0.9) {
    float stripes = countOf(8.0 * STRUCTP);
    float wob = (pfbm(uv, vec2(3.0, 6.0), 3, u_seed + 2.3) - 0.5) * clamp(CAVITY, 0.0, 1.0) * 0.5;
    float t = abs(fract(uv.x * stripes + wob) - 0.5) * 2.0;
    s.albedo = mix(C2, C1, smoothstep(0.25, 0.75, t));
    s.albedo = mix(s.albedo, C3, smoothstep(0.85, 1.0, t) * clamp(HUEV, 0.0, 1.0) * 0.4);
  } else {
    float r = length(uv - vec2(0.5));
    float scar = inside(r - 0.13, 0.02);
    float ring = stroke(abs(r - 0.13), 0.02);
    s.albedo = mix(C1, C2, smoothstep(0.3, 0.8, fine));
    s.albedo = mix(s.albedo, C3, clamp(scar + ring * 0.7, 0.0, 1.0));
  }
  s.albedo *= 0.92 + 0.16 * fine;
  s.albedo = mix(s.albedo, C2 * 0.7, pits * 0.5);
  s.rough = clamp(ROUGHB + pits * 0.1, 0.2, 1.0);
  s.ao = clamp(1.0 - pits * 0.4, 0.0, 1.0);
  return s;
}

/** Carved jack-o'-lantern face: triangular eyes and a toothed grin. */
float carvedFace(vec2 uv) {
  vec2 p = uv - vec2(0.5, 0.52);
  float eyeL = sdBox(rotate2(p - vec2(-0.17, 0.10), 0.35), vec2(0.085, 0.055));
  float eyeR = sdBox(rotate2(p - vec2(0.17, 0.10), -0.35), vec2(0.085, 0.055));
  float nose = sdBox(rotate2(p - vec2(0.0, -0.02), 0.78), vec2(0.045, 0.045));
  float mouth = sdBox(p - vec2(0.0, -0.20), vec2(0.24, 0.055));
  float teeth = sdBox(vec2(fract(p.x * 6.0 + 0.5) - 0.5, p.y + 0.20) * vec2(1.0 / 6.0, 1.0),
                      vec2(0.030, 0.055));
  float m = min(min(eyeL, eyeR), min(nose, max(mouth, -teeth)));
  return inside(m, 0.006);
}

float hPumpkin(vec2 uv) {
  float ribs = countOf(6.0 * STRUCTP + 1.0);
  float face = clamp(SPARK, 0.0, 1.0) > 0.5 ? carvedFace(uv) : 0.0;
  if (STRUCTP < 0.92) {
    // Top face: radial ribs plus the stem.
    vec2 q = uv - vec2(0.5);
    float a = atan(q.y, q.x);
    float r = length(q);
    float rib = abs(fract(a / TAU * ribs) - 0.5) * 2.0;
    float stem = inside(sdBox(q, vec2(0.055, 0.055)) - 0.03, 0.01) * (0.4 + 0.6 * clamp(WEAR, 0.0, 1.0));
    return 0.56 + (1.0 - rib) * 0.10 * CAVITY - smoothstep(0.9, 1.0, rib) * 0.16 * CAVITY
           + stem * 0.26 * smoothstep(0.3, 0.0, r);
  }
  float t = abs(fract(uv.x * ribs) - 0.5) * 2.0;
  float groove = 1.0 - smoothstep(0.0, 0.30, t);
  return 0.60 - groove * 0.40 * CAVITY - face * 0.42;
}

Surf sPumpkin(vec2 uv, float h) {
  float ribs = countOf(6.0 * STRUCTP + 1.0);
  float fine = pfbm(uv, vec2(cellsOf(18.0)), 3, u_seed + 5.9);
  float face = clamp(SPARK, 0.0, 1.0) > 0.5 ? carvedFace(uv) : 0.0;
  Surf s = surfInit();
  if (STRUCTP < 0.92) {
    vec2 q = uv - vec2(0.5);
    float a = atan(q.y, q.x);
    float r = length(q);
    float rib = abs(fract(a / TAU * ribs) - 0.5) * 2.0;
    float stem = inside(sdBox(q, vec2(0.055, 0.055)) - 0.03, 0.01);
    s.albedo = mix(C2, C1, smoothstep(0.15, 0.8, rib)) * (0.92 + 0.16 * fine);
    s.albedo = mix(s.albedo, C3, stem * smoothstep(0.32, 0.05, r));
    s.ao = clamp(1.0 - (1.0 - rib) * 0.35, 0.0, 1.0);
  } else {
    float t = abs(fract(uv.x * ribs) - 0.5) * 2.0;
    float groove = 1.0 - smoothstep(0.0, 0.30, t);
    s.albedo = mix(C1, C1 * 0.55, groove) * (0.92 + 0.16 * fine);
    s.ao = clamp(1.0 - groove * 0.55, 0.0, 1.0);
  }
  if (face > 0.0) {
    s.albedo = mix(s.albedo, C2, face);
    s.emit = EMITB * face;
    s.ao = mix(s.ao, s.ao * 0.5, face * (1.0 - step(0.01, EMITB)));
    s.rough = mix(s.rough, 0.6, face);
  }
  s.rough = clamp(s.rough + (fine - 0.5) * 0.08, 0.2, 1.0);
  return s;
}

float hHay(vec2 uv) {
  float strands = countOf(40.0 * STRUCTP + 1.0);
  float straw = pridge(uv, vec2(max(3.0, floor(strands * 0.18 + 0.5)), strands), 4, u_seed);
  float clump = pfbm(uv, vec2(cellsOf(5.0)), 3, u_seed + 7.3);
  float twine = 0.0;
  if (WEAR > 0.4) {
    float t = min(abs(uv.y - 0.22), abs(uv.y - 0.78));
    twine = 1.0 - smoothstep(0.02, 0.045 * WEAR + 0.02, t);
  }
  return 0.45 + (straw - 0.5) * 0.5 + (clump - 0.5) * 0.22 + twine * 0.12;
}

Surf sHay(vec2 uv, float h) {
  float strands = countOf(40.0 * STRUCTP + 1.0);
  float straw = pridge(uv, vec2(max(3.0, floor(strands * 0.18 + 0.5)), strands), 4, u_seed);
  float clump = pfbm(uv, vec2(cellsOf(5.0)), 3, u_seed + 7.3);
  float twine = 0.0;
  if (WEAR > 0.4) {
    float t = min(abs(uv.y - 0.22), abs(uv.y - 0.78));
    twine = 1.0 - smoothstep(0.02, 0.045 * WEAR + 0.02, t);
  }
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.85, straw));
  s.albedo *= 0.86 + 0.30 * clump;
  s.albedo = mix(s.albedo, C1 * 1.25, smoothstep(0.85, 1.0, straw) * clamp(HUEV, 0.0, 1.0));
  s.albedo = mix(s.albedo, C3, twine * 0.9);
  s.rough = clamp(ROUGHB, 0.5, 1.0);
  s.ao = clamp(0.55 + 0.5 * h - twine * 0.1, 0.0, 1.0);
  return s;
}

float hSponge(vec2 uv) {
  float cells = cellsOf(9.0);
  Cell a = pcells(uv, vec2(cells), u_seed, 1.0);
  Cell b = pcells(uv, vec2(cells * 1.9), u_seed + 13.0, 1.0);
  float sizeVar = 0.10 + 0.22 * clamp(WEAR, 0.0, 1.0);
  float pa = 1.0 - smoothstep(sizeVar * (0.4 + a.id), sizeVar * (0.9 + a.id), a.f1);
  float pb = 1.0 - smoothstep(sizeVar * 0.5, sizeVar * 1.1, b.f1);
  float pore = clamp(pa * STRUCTP + pb * 0.6 * STRUCTP, 0.0, 1.0);
  float fib = pfbm(uv, vec2(cells * 5.0), 3, u_seed + 5.5);
  return 0.72 - pore * (0.5 + 0.4 * CAVITY) + (fib - 0.5) * 0.20;
}

Surf sSponge(vec2 uv, float h) {
  float cells = cellsOf(9.0);
  Cell a = pcells(uv, vec2(cells), u_seed, 1.0);
  Cell b = pcells(uv, vec2(cells * 1.9), u_seed + 13.0, 1.0);
  float sizeVar = 0.10 + 0.22 * clamp(WEAR, 0.0, 1.0);
  float pa = 1.0 - smoothstep(sizeVar * (0.4 + a.id), sizeVar * (0.9 + a.id), a.f1);
  float pb = 1.0 - smoothstep(sizeVar * 0.5, sizeVar * 1.1, b.f1);
  float pore = clamp(pa * STRUCTP + pb * 0.6 * STRUCTP, 0.0, 1.0);
  float fib = pfbm(uv, vec2(cells * 5.0), 3, u_seed + 5.5);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.2, 0.85, fib));
  s.albedo = mix(s.albedo, C3, smoothstep(0.7, 1.0, fib) * clamp(HUEV, 0.0, 1.0));
  s.albedo = mix(s.albedo, C2 * 0.30, pore);
  s.rough = clamp(ROUGHB, 0.5, 1.0);
  s.ao = clamp(1.0 - pore * 0.85, 0.0, 1.0);
  return s;
}
`;

/** Metal, gem, glass, cloth, light and functional-block patterns. @type {string} */
const GEN_CRAFT = `
/* ======================================================================== */
/* Metal & gem blocks                                                       */
/* ======================================================================== */

float hMetal(vec2 uv) {
  float panels = countOf(2.0 * TILEP);
  float scratches = countOf(200.0 * STRUCTP + 1.0);
  float brush = pfbm(uv, vec2(max(2.0, floor(scratches * 0.02 + 0.5)), scratches), 3, u_seed);
  float dents = pcells(uv, vec2(cellsOf(6.0)), u_seed + 9.1, 1.0).f1;
  float seam = 1.0 - smoothstep(0.0, 0.035,
    min(abs(fract(uv.x * panels) - 0.5), abs(fract(uv.y * panels) - 0.5)));
  float rivet = speck(uv, panels * 2.0, 0.55, 0.10, u_seed + 15.7);
  float h = 0.62 + (brush - 0.5) * 0.16;
  h -= seam * 0.32;
  h -= (1.0 - smoothstep(0.25, 0.75, dents)) * 0.22 * CAVITY;
  h += rivet * 0.24;
  return h;
}

/** Bar-cage mask used when a metal material declares alpha (spawner, brewing stand). */
float metalCage(vec2 uv) {
  float bars = countOf(4.0 * TILEP);
  float t = 0.030;
  // Distance to the nearest bar centre line, measured in tile units.
  float dx = abs(fract(uv.x * bars) - 0.5) / max(bars, 1.0);
  float dy = abs(fract(uv.y * bars) - 0.5) / max(bars, 1.0);
  float gx = 1.0 - smoothstep(t * 0.6, t, dx);
  float gy = 1.0 - smoothstep(t * 0.6, t, dy);
  float frame = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - 0.055)), 0.004);
  return clamp(max(max(gx, gy), frame), 0.0, 1.0);
}

Surf sMetal(vec2 uv, float h) {
  float panels = countOf(2.0 * TILEP);
  float scratches = countOf(200.0 * STRUCTP + 1.0);
  float brush = pfbm(uv, vec2(max(2.0, floor(scratches * 0.02 + 0.5)), scratches), 3, u_seed);
  float fineBrush = pfbm(uv, vec2(3.0, scratches * 2.0), 2, u_seed + 3.3);
  float dents = pcells(uv, vec2(cellsOf(6.0)), u_seed + 9.1, 1.0).f1;
  float seam = 1.0 - smoothstep(0.0, 0.035,
    min(abs(fract(uv.x * panels) - 0.5), abs(fract(uv.y * panels) - 0.5)));
  float rivet = speck(uv, panels * 2.0, 0.55, 0.10, u_seed + 15.7);
  float grime = pfbm(uv, vec2(cellsOf(4.0)), 4, u_seed + 21.9);
  float ox = smoothstep(1.0 - clamp(WEAR, 0.0, 1.0) - 0.18, 1.0 - clamp(WEAR, 0.0, 1.0) + 0.18, grime);

  Surf s = surfInit();
  s.albedo = mix(C1 * 0.86, C1, brush);
  s.albedo = mix(s.albedo, C3, smoothstep(0.7, 1.0, fineBrush) * (0.25 + 0.5 * clamp(SPARK, 0.0, 1.0)));
  s.albedo = mix(s.albedo, C2, ox * 0.9);
  s.albedo = mix(s.albedo, C3, rivet * 0.8);
  s.albedo *= 1.0 - seam * 0.35;
  s.metal = mix(METALB, METALB * 0.25, ox);
  // Anisotropic brushed highlight: roughness varies along the brush direction.
  s.rough = clamp(ROUGHB + (brush - 0.5) * 0.22 * (0.5 + clamp(SPARK, 0.0, 1.0))
                  + ox * 0.35 + seam * 0.1, 0.04, 1.0);
  s.ao = clamp(1.0 - seam * 0.5 - (1.0 - smoothstep(0.2, 0.8, dents)) * 0.3 * CAVITY, 0.0, 1.0);
  s.emit = EMITB;
  if (u_alphaMode > 0.5) s.alpha = metalCage(uv);
  return s;
}

/** Faceted mineral block (gold / diamond / emerald / lapis / redstone). */
float hFacet(vec2 uv) {
  float cells = countOf(3.0 * TILEP);
  Cell c = pcells(uv, vec2(cells), u_seed, 0.72);
  vec2 tilt = (ph2(c.coord, vec2(cells), u_seed + 5.5) - 0.5) * 2.0;
  float facet = dot(-c.rel, tilt) * (0.5 + 1.4 * clamp(CAVITY, 0.0, 1.0));
  float bevelW = 0.03 + 0.16 * clamp(STRUCTP, 0.0, 1.0);
  float bevel = smoothstep(0.0, bevelW, c.f2 - c.f1);
  float wear = speck(uv, cells * 3.0, 0.4 * WEAR, 0.3, u_seed + 11.3);
  return 0.55 + facet * 0.30 - (1.0 - bevel) * 0.30 - wear * 0.12;
}

Surf sFacet(vec2 uv, float h) {
  float cells = countOf(3.0 * TILEP);
  Cell c = pcells(uv, vec2(cells), u_seed, 0.72);
  float bevelW = 0.03 + 0.16 * clamp(STRUCTP, 0.0, 1.0);
  float bevel = smoothstep(0.0, bevelW, c.f2 - c.f1);
  float sparkle = speck(uv, cells * 9.0, clamp(SPARK, 0.0, 1.0), 0.24, u_seed + 27.7);
  float wear = speck(uv, cells * 3.0, 0.4 * WEAR, 0.3, u_seed + 11.3);
  float fine = pfbm(uv, vec2(cells * 8.0), 3, u_seed + 33.1);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, 0.25 + 0.75 * c.id);
  s.albedo *= 0.86 + 0.26 * fine;
  s.albedo = mix(s.albedo, C2 * 0.7, 1.0 - bevel);
  s.albedo = mix(s.albedo, C3, sparkle * 0.9 + smoothstep(0.86, 1.0, c.id) * 0.25);
  s.albedo = mix(s.albedo, C2 * 0.85, wear * 0.6);
  s.rough = clamp(ROUGHB + (1.0 - bevel) * 0.18 + wear * 0.25 - sparkle * 0.08, 0.04, 1.0);
  s.ao = clamp(1.0 - (1.0 - bevel) * 0.45, 0.0, 1.0);
  s.emit = EMITB * (0.4 + 0.6 * sparkle);
  return s;
}

/* --- copper: streaked metal that oxidises into patina ------------------- */

float hCopper(vec2 uv) {
  float tiles = countOf(2.0 * TILEP);
  float streak = pfbm(uv, vec2(4.0, countOf(90.0 * STRUCTP + 1.0)), 3, u_seed);
  float pit = speck(uv, cellsOf(26.0), 0.35, 0.34, u_seed + 7.1);
  float seam = 1.0 - smoothstep(0.0, 0.03,
    min(abs(fract(uv.x * tiles) - 0.5), abs(fract(uv.y * tiles) - 0.5)));
  float patina = pfbm(uv, vec2(cellsOf(4.0)), 4, u_seed + 13.9);
  float cover = smoothstep(1.0 - clamp(WEAR, 0.0, 1.0) - 0.22,
                           1.0 - clamp(WEAR, 0.0, 1.0) + 0.22, patina);
  return 0.62 + (streak - 0.5) * 0.16 - pit * 0.24 * CAVITY - seam * 0.28 + cover * 0.10;
}

Surf sCopper(vec2 uv, float h) {
  float tiles = countOf(2.0 * TILEP);
  float streak = pfbm(uv, vec2(4.0, countOf(90.0 * STRUCTP + 1.0)), 3, u_seed);
  float pit = speck(uv, cellsOf(26.0), 0.35, 0.34, u_seed + 7.1);
  float seam = 1.0 - smoothstep(0.0, 0.03,
    min(abs(fract(uv.x * tiles) - 0.5), abs(fract(uv.y * tiles) - 0.5)));
  float patina = pfbm(uv, vec2(cellsOf(4.0)), 4, u_seed + 13.9);
  float speckle = pfbm(uv, vec2(cellsOf(16.0)), 3, u_seed + 19.1);
  float cover = smoothstep(1.0 - clamp(WEAR, 0.0, 1.0) - 0.22,
                           1.0 - clamp(WEAR, 0.0, 1.0) + 0.22, patina * 0.75 + speckle * 0.25);
  Surf s = surfInit();
  vec3 metalCol = mix(C1 * 0.85, C1, streak);
  metalCol = mix(metalCol, C3, smoothstep(0.72, 1.0, streak) * (0.3 + 0.6 * clamp(SPARK, 0.0, 1.0)));
  vec3 patinaCol = mix(C2 * 0.8, C2, speckle);
  s.albedo = mix(metalCol, patinaCol, cover);
  s.albedo *= 1.0 - pit * 0.30 - seam * 0.25;
  s.metal = mix(max(METALB, 1.0), 0.0, cover);
  s.rough = clamp(mix(min(ROUGHB, 0.4), 0.88, cover) + pit * 0.15, 0.05, 1.0);
  s.ao = clamp(1.0 - pit * 0.45 * CAVITY - seam * 0.35, 0.0, 1.0);
  return s;
}

float hCopperOxidized(vec2 uv) { return hCopper(uv); }
Surf sCopperOxidized(vec2 uv, float h) { return sCopper(uv, h); }

/* --- amethyst: crystal clusters on a matrix ------------------------------ */

float hAmethyst(vec2 uv) {
  float cells = countOf(9.0 * STRUCTP + 1.0);
  Cell c = pcells(uv, vec2(cells), u_seed, 0.9);
  float ang = c.id * TAU;
  vec2 lp = rotate2(c.rel, ang);
  // Hexagonal prism cross-section.
  float hexD = max(abs(lp.x) * 0.866 + abs(lp.y) * 0.5, abs(lp.y));
  float rad = 0.30 + 0.16 * c.id;
  float crystal = inside(hexD - rad, 0.03);
  float tipH = clamp(1.0 - hexD / max(rad, 1.0e-3), 0.0, 1.0);
  float matrix = pfbm(uv, vec2(cells * 3.0), 3, u_seed + 6.6);
  return 0.34 + (matrix - 0.5) * 0.18
         + crystal * (0.20 + 0.55 * clamp(CAVITY, 0.0, 1.0)) * (0.35 + 0.65 * tipH);
}

Surf sAmethyst(vec2 uv, float h) {
  float cells = countOf(9.0 * STRUCTP + 1.0);
  Cell c = pcells(uv, vec2(cells), u_seed, 0.9);
  vec2 lp = rotate2(c.rel, c.id * TAU);
  float hexD = max(abs(lp.x) * 0.866 + abs(lp.y) * 0.5, abs(lp.y));
  float rad = 0.30 + 0.16 * c.id;
  float crystal = inside(hexD - rad, 0.03);
  float tipH = clamp(1.0 - hexD / max(rad, 1.0e-3), 0.0, 1.0);
  float glint = speck(uv, cells * 6.0, clamp(SPARK, 0.0, 1.0), 0.26, u_seed + 23.9);
  float matrix = pfbm(uv, vec2(cells * 3.0), 3, u_seed + 6.6);
  Surf s = surfInit();
  vec3 host = mix(C2 * 0.8, C2, matrix);
  vec3 gem = mix(C1 * 0.7, C1, tipH);
  gem = mix(gem, C3, smoothstep(0.55, 1.0, tipH) * (0.4 + 0.6 * c.id));
  gem = mix(gem, C3 * 1.3, glint * 0.9);
  s.albedo = mix(host, gem, crystal);
  s.rough = clamp(mix(clamp(WEAR, 0.05, 1.0), ROUGHB, crystal) - glint * 0.15, 0.04, 1.0);
  s.ao = clamp(1.0 - (1.0 - crystal) * 0.35, 0.0, 1.0);
  s.emit = EMITB * (0.4 + 0.8 * tipH * crystal);
  return s;
}

/* ======================================================================== */
/* Translucent                                                              */
/* ======================================================================== */

float hGlass(vec2 uv) {
  float bw = mix(0.0, 0.12, clamp(STRUCTP, 0.0, 1.0));
  float d = sdBox(uv - vec2(0.5), vec2(0.5 - bw));
  float frame = 1.0 - inside(d, 0.004);
  float bevel = stroke(abs(d), 0.04) * clamp(CAVITY, 0.0, 1.0);
  float smudge = pfbm(uv, vec2(cellsOf(9.0)), 4, u_seed);
  return 0.55 + frame * 0.30 + bevel * 0.16 + (smudge - 0.5) * 0.10 * clamp(WEAR, 0.0, 1.0);
}

Surf sGlass(vec2 uv, float h) {
  float bw = mix(0.0, 0.12, clamp(STRUCTP, 0.0, 1.0));
  float d = sdBox(uv - vec2(0.5), vec2(0.5 - bw));
  float frame = 1.0 - inside(d, 0.004);
  float bevel = stroke(abs(d), 0.045);
  float smudge = pfbm(uv, vec2(cellsOf(9.0)), 4, u_seed);
  float dust = speck(uv, cellsOf(40.0), 0.35 * WEAR, 0.34, u_seed + 11.7);
  Surf s = surfInit();
  s.albedo = mix(C1, C3, bevel * 0.5);
  s.albedo = mix(s.albedo, C2, frame * 0.85);
  s.albedo = mix(s.albedo, C3, dust * 0.5);
  s.rough = clamp(ROUGHB + smudge * 0.10 * WEAR + dust * 0.35 + frame * 0.12, 0.02, 1.0);
  s.ao = clamp(1.0 - frame * 0.25, 0.0, 1.0);
  float body = clamp(SPARK, 0.0, 1.0);
  s.alpha = clamp(max(max(body, frame), max(bevel * 0.55, dust * 0.7)), 0.0, 1.0);
  if (EMITB > 0.0) {
    // Beacon: a luminous core behind the glass.
    float core = inside(sdBox(uv - vec2(0.5), vec2(0.20)) - 0.05, 0.02);
    s.albedo = mix(s.albedo, C3, core * 0.9);
    s.emit = EMITB * core;
    s.alpha = clamp(max(s.alpha, core), 0.0, 1.0);
  }
  return s;
}

/** Gel blocks: a smooth skin with suspended inner blobs. */
float hGel(vec2 uv) {
  float blobs = countOf(5.0 * STRUCTP + 1.0);
  Cell c = pcells(uv, vec2(blobs), u_seed, 0.85);
  float r = 0.24 + 0.16 * c.id;
  float blob = inside(c.f1 - r, 0.05);
  float dome = clamp(1.0 - c.f1 / max(r, 1.0e-3), 0.0, 1.0);
  float wob = pfbm(uv, vec2(cellsOf(7.0)), 4, u_seed + 5.1);
  return 0.55 + blob * dome * 0.34 * clamp(CAVITY, 0.0, 1.0)
         + (wob - 0.5) * 0.22 * clamp(WEAR, 0.0, 1.0);
}

Surf sGel(vec2 uv, float h) {
  float blobs = countOf(5.0 * STRUCTP + 1.0);
  Cell c = pcells(uv, vec2(blobs), u_seed, 0.85);
  float r = 0.24 + 0.16 * c.id;
  float blob = inside(c.f1 - r, 0.05);
  float dome = clamp(1.0 - c.f1 / max(r, 1.0e-3), 0.0, 1.0);
  float wob = pfbm(uv, vec2(cellsOf(7.0)), 4, u_seed + 5.1);
  float rim = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.46)), 0.02);
  Surf s = surfInit();
  s.albedo = mix(C1, C2, blob * (0.35 + 0.6 * dome));
  s.albedo = mix(s.albedo, C3, smoothstep(0.55, 1.0, wob) * 0.35 + rim * 0.35);
  s.rough = clamp(ROUGHB + (wob - 0.5) * 0.06, 0.03, 1.0);
  s.ao = clamp(1.0 - blob * 0.2, 0.0, 1.0);
  float body = clamp(SPARK, 0.0, 1.0);
  s.alpha = clamp(max(body, max(rim, blob * dome * 0.55)), 0.0, 1.0);
  return s;
}

/* ======================================================================== */
/* Light sources                                                            */
/* ======================================================================== */

/** p5 for the LIGHT family is a glow falloff exponent in 1..8. */
float glowPow() { return mix(1.0, 8.0, clamp(SPARK, 0.0, 1.0)); }

float hGlowstone(vec2 uv) {
  float nod = countOf(5.0 * TILEP);
  Cell c = pcells(uv, vec2(nod), u_seed, 0.9);
  float r = mix(0.18, 0.46, clamp(STRUCTP, 0.0, 1.0)) * (0.7 + 0.6 * c.id);
  float dome = clamp(1.0 - c.f1 / max(r, 1.0e-3), 0.0, 1.0);
  float nodule = inside(c.f1 - r, 0.03);
  float crust = pfbm(uv, vec2(nod * 4.0), 3, u_seed + 7.7);
  return 0.34 + nodule * dome * (0.30 + 0.42 * clamp(CAVITY, 0.0, 1.0))
         + (crust - 0.5) * 0.20;
}

Surf sGlowstone(vec2 uv, float h) {
  float nod = countOf(5.0 * TILEP);
  Cell c = pcells(uv, vec2(nod), u_seed, 0.9);
  float r = mix(0.18, 0.46, clamp(STRUCTP, 0.0, 1.0)) * (0.7 + 0.6 * c.id);
  float dome = clamp(1.0 - c.f1 / max(r, 1.0e-3), 0.0, 1.0);
  float nodule = inside(c.f1 - r, 0.03);
  float crust = pfbm(uv, vec2(nod * 4.0), 3, u_seed + 7.7);
  Surf s = surfInit();
  vec3 shell = mix(C2, C2 * 1.6, crust) * (1.0 - clamp(WEAR, 0.0, 1.0) * 0.4);
  vec3 core = mix(C1, C3, pow(dome, 1.0 / max(glowPow() * 0.35, 0.3)));
  s.albedo = mix(shell, core, nodule);
  s.rough = clamp(mix(ROUGHB + 0.15, ROUGHB - 0.2, nodule), 0.1, 1.0);
  s.ao = clamp(1.0 - (1.0 - nodule) * 0.5 * CAVITY, 0.0, 1.0);
  s.emit = clamp(EMITB * nodule * pow(clamp(dome, 0.0, 1.0), 1.0 / glowPow()) * 1.15, 0.0, 1.0);
  return s;
}

float hSeaLantern(vec2 uv) {
  float cells = countOf(4.0 * TILEP);
  float inset = mix(0.04, 0.18, clamp(STRUCTP, 0.0, 1.0));
  vec2 g = fract(uv * cells) - 0.5;
  float d = sdBox(g, vec2(0.5 - inset));
  float cell = inside(d, 0.03);
  float bevel = stroke(abs(d), inset * 1.4);
  return 0.5 + cell * 0.22 - bevel * 0.16;
}

Surf sSeaLantern(vec2 uv, float h) {
  float cells = countOf(4.0 * TILEP);
  float inset = mix(0.04, 0.18, clamp(STRUCTP, 0.0, 1.0));
  vec2 ci = floor(uv * cells);
  vec2 g = fract(uv * cells) - 0.5;
  float d = sdBox(g, vec2(0.5 - inset));
  float cell = inside(d, 0.03);
  float id = ph1(ci, vec2(cells), u_seed);
  float pulse = step(1.0 - clamp(WEAR, 0.0, 1.0), id);
  float grain = pfbm(uv, vec2(cells * 6.0), 3, u_seed + 9.1);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, cell * (0.55 + 0.45 * id));
  s.albedo = mix(s.albedo, C3, cell * pulse * 0.7 + cell * smoothstep(0.6, 1.0, grain) * 0.25);
  s.rough = clamp(ROUGHB - cell * 0.15, 0.05, 1.0);
  s.ao = clamp(1.0 - (1.0 - cell) * 0.35, 0.0, 1.0);
  s.emit = clamp(EMITB * cell * (0.65 + 0.45 * pulse)
                 * pow(clamp(1.0 - length(g) * 1.1, 0.0, 1.0), 1.0 / glowPow()) * 1.6, 0.0, 1.0);
  return s;
}

float hRedstoneLamp(vec2 uv) {
  float lat = countOf(4.0 * STRUCTP + 1.0);
  float t = min(abs(fract(uv.x * lat) - 0.5), abs(fract(uv.y * lat) - 0.5)) * 2.0;
  float bar = 1.0 - smoothstep(0.10, 0.34, t);
  float r = length(uv - vec2(0.5));
  float bulb = inside(r - mix(0.12, 0.42, clamp(WEAR, 0.0, 1.0)), 0.03);
  return 0.5 + bar * 0.22 * clamp(CAVITY, 0.0, 1.0) + bulb * 0.14;
}

Surf sRedstoneLamp(vec2 uv, float h) {
  float lat = countOf(4.0 * STRUCTP + 1.0);
  float t = min(abs(fract(uv.x * lat) - 0.5), abs(fract(uv.y * lat) - 0.5)) * 2.0;
  float bar = 1.0 - smoothstep(0.10, 0.34, t);
  float r = length(uv - vec2(0.5));
  float rad = mix(0.12, 0.42, clamp(WEAR, 0.0, 1.0));
  float bulb = inside(r - rad, 0.03);
  float grain = pfbm(uv, vec2(cellsOf(20.0)), 3, u_seed + 3.3);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, bulb * (1.0 - clamp(r / max(rad, 1e-3), 0.0, 1.0) * 0.4));
  s.albedo = mix(s.albedo, C3, bulb * smoothstep(0.65, 0.0, r / max(rad, 1e-3)) * 0.8);
  s.albedo = mix(s.albedo, C2 * 0.7, bar * 0.8);
  s.albedo *= 0.92 + 0.16 * grain;
  s.rough = clamp(ROUGHB + bar * 0.1 - bulb * 0.12, 0.1, 1.0);
  s.ao = clamp(1.0 - bar * 0.35 * CAVITY, 0.0, 1.0);
  s.emit = clamp(EMITB * bulb * pow(clamp(1.0 - r / max(rad, 1e-3), 0.0, 1.0), 1.0 / glowPow()) * 1.5,
                 0.0, 1.0);
  return s;
}

/** Torch / lever: a stick with a burning (or inert) head. */
vec4 torchMask(vec2 uv) {
  float sw = mix(0.04, 0.16, clamp(STRUCTP, 0.0, 1.0));
  float hr = mix(0.05, 0.18, clamp(CAVITY, 0.0, 1.0));
  float topY = 0.62;
  float stick = inside(sdBox(uv - vec2(0.5, topY * 0.5), vec2(sw, topY * 0.5)), 0.004);
  float head = inside(sdBox(uv - vec2(0.5, topY + hr * 0.6), vec2(sw * 1.25, hr)) - 0.01, 0.005);
  vec2 fq = (uv - vec2(0.5, topY + hr * 1.6)) / vec2(hr * 1.5, hr * 2.2);
  float wob = (pfbm(uv, vec2(9.0), 3, u_seed + 4.4) - 0.5) * clamp(WEAR, 0.0, 1.0) * 0.55;
  float flame = inside(length(vec2(fq.x + wob, fq.y * 0.85)) - 1.0, 0.12);
  float core = inside(length(vec2(fq.x + wob * 0.6, fq.y * 1.1)) - 0.5, 0.12);
  return vec4(stick, head, flame, core);
}

float hTorch(vec2 uv) {
  vec4 m = torchMask(uv);
  return 0.22 + m.x * 0.26 + m.y * 0.34 + m.z * 0.20;
}

Surf sTorch(vec2 uv, float h) {
  vec4 m = torchMask(uv);
  float grain = pfbm(uv, vec2(cellsOf(18.0)), 3, u_seed + 2.2);
  Surf s = surfInit();
  s.albedo = C1 * (0.85 + 0.3 * grain);
  s.albedo = mix(s.albedo, C2, m.y);
  s.albedo = mix(s.albedo, C3, m.z * 0.85);
  s.albedo = mix(s.albedo, min(C3 * 1.6, vec3(1.0)), m.w);
  s.rough = clamp(mix(ROUGHB, 0.35, m.z), 0.15, 1.0);
  s.ao = clamp(0.7 + 0.35 * h, 0.0, 1.0);
  s.emit = clamp(EMITB * (m.z * pow(clamp(m.z, 0.0, 1.0), 1.0 / glowPow()) * 0.9 + m.w * 1.1),
                 0.0, 1.0);
  s.alpha = clamp(max(max(m.x, m.y), m.z), 0.0, 1.0);
  return s;
}

float hLantern(vec2 uv) {
  float bars = countOf(6.0 * STRUCTP + 1.0);
  float body = inside(sdBox(uv - vec2(0.5, 0.42), vec2(0.20, 0.24)) - 0.03, 0.006);
  float cap = inside(sdBox(uv - vec2(0.5, 0.72), vec2(0.16, 0.05)) - 0.02, 0.006);
  float hook = inside(abs(length(uv - vec2(0.5, 0.88)) - 0.07) - 0.018, 0.006);
  float bar = (1.0 - smoothstep(0.012, 0.024, abs(fract(uv.x * bars) - 0.5) / max(bars, 1.0)))
              * body;
  float core = inside(length((uv - vec2(0.5, 0.42)) / vec2(0.13, 0.16))
                      - mix(0.4, 1.0, clamp(CAVITY, 0.0, 1.0)), 0.06) * body;
  return 0.22 + body * 0.22 + cap * 0.32 + hook * 0.26
         + bar * 0.14 * clamp(WEAR, 0.0, 1.0) - core * 0.10;
}

Surf sLantern(vec2 uv, float h) {
  float bars = countOf(6.0 * STRUCTP + 1.0);
  float body = inside(sdBox(uv - vec2(0.5, 0.42), vec2(0.20, 0.24)) - 0.03, 0.006);
  float cap = inside(sdBox(uv - vec2(0.5, 0.72), vec2(0.16, 0.05)) - 0.02, 0.006);
  float hook = inside(abs(length(uv - vec2(0.5, 0.88)) - 0.07) - 0.018, 0.006);
  float bar = (1.0 - smoothstep(0.012, 0.024, abs(fract(uv.x * bars) - 0.5) / max(bars, 1.0)))
              * body;
  float cr = mix(0.4, 1.0, clamp(CAVITY, 0.0, 1.0));
  float rr = length((uv - vec2(0.5, 0.42)) / vec2(0.13, 0.16));
  float core = inside(rr - cr, 0.06) * body;
  Surf s = surfInit();
  vec3 metalCol = mix(C2, C1, pfbm(uv, vec2(cellsOf(14.0)), 3, u_seed));
  s.albedo = metalCol;
  s.albedo = mix(s.albedo, C3, core * 0.92);
  s.albedo = mix(s.albedo, C1 * 1.2, (cap + hook + bar) * 0.5);
  s.metal = METALB * (1.0 - core * 0.85);
  s.rough = clamp(mix(ROUGHB, 0.35, core), 0.08, 1.0);
  s.ao = clamp(1.0 - bar * 0.3, 0.0, 1.0);
  s.emit = clamp(EMITB * core * pow(clamp(1.0 - rr / max(cr, 1e-3), 0.0, 1.0), 1.0 / glowPow()) * 1.6,
                 0.0, 1.0);
  s.alpha = clamp(max(max(body, cap), max(hook, core)), 0.0, 1.0);
  return s;
}

/* ======================================================================== */
/* Cloth & ceramic                                                          */
/* ======================================================================== */

float hWool(vec2 uv) {
  float strands = countOf(60.0 * STRUCTP + 1.0);
  float sx = pfbm(uv, vec2(strands, max(3.0, floor(strands / 7.0 + 0.5))), 3, u_seed);
  float sy = pfbm(uv, vec2(max(3.0, floor(strands / 7.0 + 0.5)), strands), 3, u_seed + 7.7);
  float pill = speck(uv, cellsOf(22.0), 0.4 * WEAR, 0.36, u_seed + 15.1);
  float fluff = pfbm(uv, vec2(cellsOf(9.0)), 4, u_seed + 21.3);
  return 0.45 + (max(sx, sy) - 0.5) * 0.42 + (fluff - 0.5) * 0.30 * clamp(CAVITY, 0.0, 1.0)
         + pill * 0.20;
}

Surf sWool(vec2 uv, float h) {
  float strands = countOf(60.0 * STRUCTP + 1.0);
  float sx = pfbm(uv, vec2(strands, max(3.0, floor(strands / 7.0 + 0.5))), 3, u_seed);
  float sy = pfbm(uv, vec2(max(3.0, floor(strands / 7.0 + 0.5)), strands), 3, u_seed + 7.7);
  float fluff = pfbm(uv, vec2(cellsOf(9.0)), 4, u_seed + 21.3);
  float lint = speck(uv, cellsOf(48.0), 0.35 * SPARK * 3.0, 0.3, u_seed + 27.9);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, smoothstep(0.15, 0.85, max(sx, sy)));
  s.albedo *= 0.86 + 0.30 * fluff;
  s.albedo = mix(s.albedo, C3, lint * 0.75 + smoothstep(0.85, 1.0, max(sx, sy)) * 0.2);
  s.rough = clamp(ROUGHB - lint * 0.1, 0.6, 1.0);
  s.ao = clamp(0.6 + 0.45 * h, 0.0, 1.0);
  return s;
}

float hCloth(vec2 uv) {
  float n = countOf(16.0 * STRUCTP + 1.0);
  vec2 g = uv * n;
  vec2 ci = floor(g);
  vec2 f = fract(g);
  // 2/2 twill: the warp floats over two wefts before dipping under.
  float over = step(0.5, mod(floor(ci.x + ci.y * 2.0), 3.0));
  float warp = 1.0 - abs(f.x - 0.5) * 2.0;
  float weft = 1.0 - abs(f.y - 0.5) * 2.0;
  float thread = mix(weft, warp, over);
  float fray = speck(uv, cellsOf(30.0), 0.3 * WEAR, 0.34, u_seed + 5.5);
  float trim = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - mix(0.0, 0.25, clamp(HUEV, 0.0, 1.0)))), 0.01);
  return 0.52 + (thread - 0.5) * 0.40 * clamp(CAVITY, 0.0, 1.0) - fray * 0.14 + trim * 0.06;
}

Surf sCloth(vec2 uv, float h) {
  float n = countOf(16.0 * STRUCTP + 1.0);
  vec2 g = uv * n;
  vec2 ci = floor(g);
  vec2 f = fract(g);
  float over = step(0.5, mod(floor(ci.x + ci.y * 2.0), 3.0));
  float warp = 1.0 - abs(f.x - 0.5) * 2.0;
  float weft = 1.0 - abs(f.y - 0.5) * 2.0;
  float thread = mix(weft, warp, over);
  float sheen = pfbm(uv, vec2(cellsOf(7.0)), 3, u_seed + 11.1);
  float fray = speck(uv, cellsOf(30.0), 0.3 * WEAR, 0.34, u_seed + 5.5);
  float tw = mix(0.0, 0.25, clamp(HUEV, 0.0, 1.0));
  float trim = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - tw)), 0.01);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, 0.35 + 0.65 * thread);
  s.albedo *= 0.9 + 0.2 * sheen;
  s.albedo = mix(s.albedo, C3, trim * step(0.001, tw));
  s.albedo = mix(s.albedo, C1 * 1.3, fray * 0.5);
  s.rough = clamp(ROUGHB - sheen * 0.2 * clamp(SPARK, 0.0, 1.0), 0.2, 1.0);
  s.ao = clamp(0.75 + 0.3 * thread - fray * 0.2, 0.0, 1.0);
  s.emit = EMITB * smoothstep(0.6, 1.0, sheen) * step(0.001, tw);
  return s;
}

float hConcrete(vec2 uv) {
  float pin = speck(uv, cellsOf(46.0), 0.35 * STRUCTP, 0.3, u_seed);
  float mott = pfbm(uv, vec2(countOf(3.0 * TILEP)), 4, u_seed + 7.1);
  float chip = speck(uv, cellsOf(9.0), 0.25 * WEAR, 0.28, u_seed + 13.3);
  return 0.6 - pin * 0.35 + (mott - 0.5) * 0.14 - chip * 0.3;
}

Surf sConcrete(vec2 uv, float h) {
  float pin = speck(uv, cellsOf(46.0), 0.35 * STRUCTP, 0.3, u_seed);
  float mott = pfbm(uv, vec2(countOf(3.0 * TILEP)), 4, u_seed + 7.1);
  float chip = speck(uv, cellsOf(9.0), 0.25 * WEAR, 0.28, u_seed + 13.3);
  float dust = pfbm(uv, vec2(cellsOf(60.0)), 3, u_seed + 19.7);
  Surf s = surfInit();
  s.albedo = mix(C1, C2, clamp(HUEV, 0.0, 1.0) * smoothstep(0.3, 0.85, mott));
  s.albedo *= 0.95 + 0.10 * dust;
  s.albedo = mix(s.albedo, C3, smoothstep(0.75, 1.0, mott) * 0.35);
  s.albedo = mix(s.albedo, C2 * 0.8, pin * 0.7 + chip * 0.6);
  s.rough = clamp(ROUGHB + pin * 0.05, 0.3, 1.0);
  s.ao = clamp(1.0 - pin * 0.6 - chip * 0.35, 0.0, 1.0);
  return s;
}

float hTerracotta(vec2 uv) {
  float bands = countOf(6.0 * STRUCTP + 1.0);
  float wob = pfbm(uv, vec2(5.0, 3.0), 3, u_seed + 3.1);
  float y = uv.y * bands + (wob - 0.5) * 0.6;
  float line = 1.0 - smoothstep(0.0, 0.12, min(fract(y), 1.0 - fract(y)));
  float scuff = pfbm(uv, vec2(cellsOf(30.0), cellsOf(10.0)), 3, u_seed + 9.9);
  return 0.6 - line * 0.24 * CAVITY + (scuff - 0.5) * 0.18 * clamp(WEAR, 0.0, 1.0);
}

Surf sTerracotta(vec2 uv, float h) {
  float bands = countOf(6.0 * STRUCTP + 1.0);
  float wob = pfbm(uv, vec2(5.0, 3.0), 3, u_seed + 3.1);
  float y = uv.y * bands + (wob - 0.5) * 0.6;
  float bi = floor(y);
  float line = 1.0 - smoothstep(0.0, 0.12, min(fract(y), 1.0 - fract(y)));
  float tone = ph1(vec2(0.0, bi), vec2(1.0, bands), u_seed + 7.3);
  float scuff = pfbm(uv, vec2(cellsOf(30.0), cellsOf(10.0)), 3, u_seed + 9.9);
  float gloss = pfbm(uv, vec2(cellsOf(6.0)), 3, u_seed + 17.1);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, 0.3 + 0.7 * tone);
  s.albedo = mix(s.albedo, C3, clamp(HUEV, 0.0, 1.0) * smoothstep(0.55, 1.0, tone) * 0.7);
  s.albedo = mix(s.albedo, C2 * 0.85, line * 0.6);
  s.albedo *= 0.93 + 0.14 * scuff;
  s.rough = clamp(ROUGHB - smoothstep(0.5, 1.0, gloss) * 0.3 * clamp(SPARK * 3.0, 0.0, 1.0), 0.1, 1.0);
  s.ao = clamp(1.0 - line * 0.35 * CAVITY, 0.0, 1.0);
  return s;
}

/** Eight built-in geometric motifs for glazed terracotta. */
float glazedMotif(vec2 uv, int motif) {
  vec2 p = fract(uv * max(1.0, floor(TILEP + 0.5)));
  vec2 q = p - 0.5;
  if (motif == 0) return inside(abs(length(p - vec2(0.0, 0.0)) - 0.5) - 0.14, 0.01);
  if (motif == 1) return inside(abs(q.x + q.y) - 0.16, 0.01);
  if (motif == 2) return inside(abs(sdBox(q, vec2(0.30))) - 0.07, 0.01);
  if (motif == 3) return step(0.0, sin((p.x + p.y) * TAU * 2.0)) * step(0.0, q.x * q.y + 0.02);
  if (motif == 4) return max(inside(abs(length(q) - 0.26) - 0.08, 0.01),
                             inside(min(abs(q.x), abs(q.y)) - 0.05, 0.01));
  if (motif == 5) return inside(abs(abs(q.x) + abs(q.y) - 0.32) - 0.08, 0.01);
  if (motif == 6) return step(0.5, fract((p.x + abs(fract(p.y * 2.0) - 0.5) * 2.0) * 3.0));
  return inside(abs(rotate2(q, atan(q.y, q.x) * 0.0 + length(q) * 6.0).x) - 0.10, 0.02);
}

float hGlazed(vec2 uv) {
  int motif = int(clamp(STRUCTP, 0.0, 0.999) * 8.0);
  float m = glazedMotif(uv, motif);
  float crackle = crackLines(uv, vec2(cellsOf(12.0)), 0.02, u_seed) * clamp(WEAR, 0.0, 1.0);
  return 0.62 + m * 0.24 * clamp(CAVITY, 0.0, 1.0) - crackle * 0.18;
}

Surf sGlazed(vec2 uv, float h) {
  int motif = int(clamp(STRUCTP, 0.0, 0.999) * 8.0);
  float m = glazedMotif(uv, motif);
  float m2 = glazedMotif(uv + vec2(0.06, 0.04), motif);
  float crackle = crackLines(uv, vec2(cellsOf(12.0)), 0.02, u_seed) * clamp(WEAR, 0.0, 1.0);
  float gloss = pfbm(uv, vec2(cellsOf(5.0)), 3, u_seed + 11.7);
  Surf s = surfInit();
  s.albedo = C1;
  s.albedo = mix(s.albedo, C3, clamp(m2 - m, 0.0, 1.0) * 0.8);
  s.albedo = mix(s.albedo, C2, m);
  s.albedo *= 0.96 + 0.08 * gloss;
  s.albedo = mix(s.albedo, C1 * 0.7, crackle * 0.5);
  s.rough = clamp(ROUGHB - clamp(SPARK, 0.0, 1.0) * 0.12 + crackle * 0.15, 0.03, 1.0);
  s.ao = clamp(1.0 - crackle * 0.3 - m * 0.12 * CAVITY, 0.0, 1.0);
  return s;
}

/* ======================================================================== */
/* Functional blocks                                                        */
/* ======================================================================== */

float hCraftingTable(vec2 uv) {
  float base = planksH(uv, 0.0);
  if (STRUCTP > 0.5) {
    // Top: a 3x3 recessed grid.
    vec2 g = fract(uv * 3.0) - 0.5;
    float cellD = sdBox(g, vec2(0.40));
    float grid = 1.0 - inside(cellD, 0.02);
    return base * 0.7 + 0.24 - grid * 0.22 * CAVITY;
  }
  // Front / side: a raised panel with tool marks.
  float panel = inside(sdBox(uv - vec2(0.5), vec2(0.34, 0.30)), 0.01);
  float tool = stroke(sdSeg(uv, vec2(0.34, 0.30), vec2(0.62, 0.66)), 0.045) * clamp(WEAR, 0.0, 1.0);
  float tool2 = stroke(abs(length(uv - vec2(0.64, 0.34)) - 0.10), 0.03) * clamp(WEAR, 0.0, 1.0);
  return base * 0.75 + 0.20 + panel * 0.10 - max(tool, tool2) * 0.20;
}

Surf sCraftingTable(vec2 uv, float h) {
  Surf s = planksS(uv, 0.0);
  if (STRUCTP > 0.5) {
    vec2 g = fract(uv * 3.0) - 0.5;
    float grid = 1.0 - inside(sdBox(g, vec2(0.40)), 0.02);
    s.albedo = mix(s.albedo, C3, grid * 0.85);
    s.ao = clamp(s.ao - grid * 0.35, 0.0, 1.0);
  } else {
    float panel = inside(sdBox(uv - vec2(0.5), vec2(0.34, 0.30)), 0.01);
    float frame = stroke(abs(sdBox(uv - vec2(0.5), vec2(0.34, 0.30))), 0.02);
    float tool = stroke(sdSeg(uv, vec2(0.34, 0.30), vec2(0.62, 0.66)), 0.045);
    float tool2 = stroke(abs(length(uv - vec2(0.64, 0.34)) - 0.10), 0.03);
    float marks = clamp(max(tool, tool2), 0.0, 1.0) * clamp(WEAR, 0.0, 1.0);
    s.albedo = mix(s.albedo, s.albedo * 1.18, panel * 0.5);
    s.albedo = mix(s.albedo, C2 * 0.6, frame * 0.8);
    s.albedo = mix(s.albedo, C3, marks * 0.85);
    s.ao = clamp(s.ao - frame * 0.3, 0.0, 1.0);
  }
  s.alpha = 1.0;
  return s;
}

float hFurnaceFront(vec2 uv) {
  float rock = pfbm(uv, vec2(cellsOf(10.0)), 4, u_seed);
  float fw = mix(0.05, 0.30, clamp(WEAR, 0.0, 1.0));
  float mouth = inside(sdBox(uv - vec2(0.5, 0.36), vec2(0.5 - fw, 0.26)) , 0.008);
  float bars = countOf(8.0 * SPARK + 1.0);
  float bar = (1.0 - smoothstep(0.10, 0.32, abs(fract(uv.x * bars) - 0.5) * 2.0)) * mouth;
  float lintel = inside(sdBox(uv - vec2(0.5, 0.80), vec2(0.5 - fw * 0.6, 0.07)), 0.008);
  return 0.60 + (rock - 0.5) * 0.22 - mouth * (0.30 + 0.5 * CAVITY) + bar * 0.22 + lintel * 0.10;
}

Surf sFurnaceFront(vec2 uv, float h) {
  float rock = pfbm(uv, vec2(cellsOf(10.0)), 4, u_seed);
  float grit = speck(uv, cellsOf(34.0), 0.4 * STRUCTP, 0.36, u_seed + 5.1);
  float fw = mix(0.05, 0.30, clamp(WEAR, 0.0, 1.0));
  float mouth = inside(sdBox(uv - vec2(0.5, 0.36), vec2(0.5 - fw, 0.26)), 0.008);
  float bars = countOf(8.0 * SPARK + 1.0);
  float bar = (1.0 - smoothstep(0.10, 0.32, abs(fract(uv.x * bars) - 0.5) * 2.0)) * mouth;
  float lintel = inside(sdBox(uv - vec2(0.5, 0.80), vec2(0.5 - fw * 0.6, 0.07)), 0.008);
  Surf s = surfInit();
  s.albedo = mix(C1 * 0.82, C1, rock);
  s.albedo = mix(s.albedo, C1 * 1.3, grit * 0.4);
  s.albedo = mix(s.albedo, C2, mouth * 0.95);
  s.albedo = mix(s.albedo, C3, clamp(bar + lintel * 0.6, 0.0, 1.0) * 0.85);
  s.metal = mix(METALB, 0.8, clamp(bar + lintel * 0.5, 0.0, 1.0) * 0.7);
  s.rough = clamp(ROUGHB - bar * 0.3 + mouth * 0.05, 0.1, 1.0);
  s.ao = clamp(1.0 - mouth * 0.75 + bar * 0.4, 0.0, 1.0);
  s.emit = EMITB;
  return s;
}

float hFurnaceSide(vec2 uv) {
  float rock = pfbm(uv, vec2(cellsOf(10.0)), 4, u_seed);
  float panel = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - mix(0.04, 0.16, clamp(WEAR, 0.0, 1.0)))), 0.01);
  float seam = 1.0 - smoothstep(0.0, 0.02, abs(uv.y - 0.5));
  return 0.60 + (rock - 0.5) * 0.26 - panel * 0.18 * CAVITY - seam * 0.14 * CAVITY;
}

Surf sFurnaceSide(vec2 uv, float h) {
  float rock = pfbm(uv, vec2(cellsOf(10.0)), 4, u_seed);
  float grit = speck(uv, cellsOf(34.0), 0.4 * STRUCTP, 0.36, u_seed + 5.1);
  float panel = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.5 - mix(0.04, 0.16, clamp(WEAR, 0.0, 1.0)))), 0.01);
  float seam = 1.0 - smoothstep(0.0, 0.02, abs(uv.y - 0.5));
  Surf s = surfInit();
  s.albedo = mix(C2, C1, rock);
  s.albedo = mix(s.albedo, C1 * 1.3, grit * 0.4);
  s.albedo = mix(s.albedo, C3, clamp(panel * 0.7 + seam * 0.6, 0.0, 1.0) * 0.7);
  s.rough = clamp(ROUGHB + (rock - 0.5) * 0.1, 0.2, 1.0);
  s.ao = clamp(1.0 - panel * 0.35 - seam * 0.3, 0.0, 1.0);
  return s;
}

float hBookshelf(vec2 uv) {
  float shelves = countOf(2.0 * TILEP);
  float fw = mix(0.04, 0.22, clamp(WEAR, 0.0, 1.0));
  float frameX = 1.0 - smoothstep(fw * 0.8, fw, min(uv.x, 1.0 - uv.x));
  float sy = uv.y * shelves;
  float si = floor(sy);
  float fy = fract(sy);
  float board = 1.0 - smoothstep(0.0, 0.10, min(fy, 1.0 - fy));
  float wood = clamp(max(frameX, board), 0.0, 1.0);
  float books = countOf(7.0 * STRUCTP + 1.0);
  float bx = (uv.x - fw) / max(1.0 - 2.0 * fw, 1.0e-3) * books;
  float bi = floor(bx);
  float fbx = fract(bx);
  float w = 0.30 + 0.55 * ph1(vec2(bi, si), vec2(books, shelves), u_seed);
  float tall = 0.55 + 0.40 * ph1(vec2(bi, si), vec2(books, shelves), u_seed + 3.3);
  float book = step(abs(fbx - 0.5) * 2.0, w) * step(fy, 0.10 + tall * 0.80) * step(0.12, fy)
               * (1.0 - frameX);
  float spine = 1.0 - smoothstep(w * 0.6, w, abs(fbx - 0.5) * 2.0);
  return 0.30 + wood * 0.36 + book * (0.30 + 0.20 * spine) * (1.0 - clamp(CAVITY, 0.0, 1.0) * 0.4);
}

Surf sBookshelf(vec2 uv, float h) {
  float shelves = countOf(2.0 * TILEP);
  float fw = mix(0.04, 0.22, clamp(WEAR, 0.0, 1.0));
  float frameX = 1.0 - smoothstep(fw * 0.8, fw, min(uv.x, 1.0 - uv.x));
  float sy = uv.y * shelves;
  float si = floor(sy);
  float fy = fract(sy);
  float board = 1.0 - smoothstep(0.0, 0.10, min(fy, 1.0 - fy));
  float wood = clamp(max(frameX, board), 0.0, 1.0);
  float books = countOf(7.0 * STRUCTP + 1.0);
  float bx = (uv.x - fw) / max(1.0 - 2.0 * fw, 1.0e-3) * books;
  float bi = floor(bx);
  float fbx = fract(bx);
  vec2 per = vec2(books, shelves);
  float w = 0.30 + 0.55 * ph1(vec2(bi, si), per, u_seed);
  float tall = 0.55 + 0.40 * ph1(vec2(bi, si), per, u_seed + 3.3);
  float book = step(abs(fbx - 0.5) * 2.0, w) * step(fy, 0.10 + tall * 0.80) * step(0.12, fy)
               * (1.0 - frameX);
  float hueR = ph1(vec2(bi, si), per, u_seed + 9.7);
  float band = step(0.5, fract(fy * 9.0)) * step(0.55, ph1(vec2(bi, si), per, u_seed + 15.1));
  float grain = pridge(uv, vec2(6.0, countOf(24.0)), 3, u_seed + 21.7);
  Surf s = surfInit();
  vec3 woodCol = mix(C1 * 0.75, C1, grain);
  // Book spines spread around color3 by rotating the channel emphasis.
  vec3 spine = mix(C3, C3.gbr, clamp(HUEV, 0.0, 1.0) * hueR);
  spine = mix(spine * 0.55, spine, 0.35 + 0.65 * ph1(vec2(bi, si), per, u_seed + 27.3));
  spine = mix(spine, C3 * 1.4, band * 0.5);
  vec3 gap = C2;
  s.albedo = mix(gap, spine, book);
  s.albedo = mix(s.albedo, woodCol, wood);
  s.rough = clamp(ROUGHB - book * 0.12, 0.2, 1.0);
  s.ao = clamp(mix(0.4, 1.0, max(book, wood)) - board * 0.15, 0.0, 1.0);
  return s;
}

float hTnt(vec2 uv) {
  float base = planksH(uv, 0.0) * 0.35 + 0.40;
  if (STRUCTP > 0.55) {
    float band = 1.0 - smoothstep(0.14, 0.19, abs(uv.y - 0.5));
    float letters = inside(sdBox(vec2(fract(uv.x * 3.0) - 0.5, uv.y - 0.5), vec2(0.14, 0.09)), 0.01) * band;
    return base + band * 0.10 - letters * 0.10;
  }
  if (STRUCTP > 0.25) {
    float r = length(uv - vec2(0.5));
    float fuse = inside(r - 0.10, 0.01);
    float ring = stroke(abs(r - 0.16), 0.03);
    return base + fuse * 0.22 + ring * 0.10;
  }
  return base;
}

Surf sTnt(vec2 uv, float h) {
  float grain = pridge(uv, vec2(5.0, countOf(30.0)), 3, u_seed);
  float fine = pfbm(uv, vec2(cellsOf(24.0)), 3, u_seed + 5.5);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, 0.35 + 0.65 * grain) * (0.92 + 0.16 * fine);
  if (STRUCTP > 0.55) {
    float band = 1.0 - smoothstep(0.14, 0.19, abs(uv.y - 0.5));
    float letters = inside(sdBox(vec2(fract(uv.x * 3.0) - 0.5, uv.y - 0.5), vec2(0.14, 0.09)), 0.01) * band;
    float bar = inside(sdBox(vec2(fract(uv.x * 3.0) - 0.5, uv.y - 0.5), vec2(0.04, 0.09)), 0.01) * band;
    s.albedo = mix(s.albedo, C3, band * 0.92);
    s.albedo = mix(s.albedo, C2 * 0.5, clamp(letters - bar * 0.0, 0.0, 1.0) * 0.9);
    s.ao = clamp(1.0 - letters * 0.2, 0.0, 1.0);
  } else if (STRUCTP > 0.25) {
    float r = length(uv - vec2(0.5));
    float fuse = inside(r - 0.10, 0.01);
    float ring = stroke(abs(r - 0.16), 0.03);
    s.albedo = mix(s.albedo, C3, clamp(fuse + ring * 0.7, 0.0, 1.0) * 0.9);
    s.ao = clamp(1.0 - ring * 0.3, 0.0, 1.0);
  }
  s.rough = clamp(ROUGHB + (fine - 0.5) * 0.1, 0.3, 1.0);
  return s;
}

float hNoteblock(vec2 uv) {
  float base = planksH(uv, 1.0);
  float dots = speck(uv, cellsOf(6.0), 0.55 * WEAR, 0.32, u_seed + 31.3);
  float frame = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.42)), 0.01);
  return base * 0.8 + 0.12 - dots * 0.28 - frame * 0.10;
}

Surf sNoteblock(vec2 uv, float h) {
  Surf s = planksS(uv, 1.0);
  float dots = speck(uv, cellsOf(6.0), 0.55 * WEAR, 0.32, u_seed + 31.3);
  float frame = 1.0 - inside(sdBox(uv - vec2(0.5), vec2(0.42)), 0.01);
  s.albedo = mix(s.albedo, C3, dots * 0.9);
  s.albedo = mix(s.albedo, C2 * 0.7, frame * 0.5);
  s.ao = clamp(s.ao - dots * 0.4 - frame * 0.15, 0.0, 1.0);
  s.alpha = 1.0;
  return s;
}

float hChest(vec2 uv) {
  float lines = countOf(6.0 * STRUCTP + 1.0);
  float grain = pridge(uv, vec2(4.0, lines * 4.0), 4, u_seed);
  float board = 1.0 - smoothstep(0.0, 0.045, abs(fract(uv.y * lines) - 0.5) * 2.0 - 0.90);
  float bandW = mix(0.02, 0.14, clamp(WEAR, 0.0, 1.0));
  float bandV = 1.0 - smoothstep(bandW * 0.8, bandW, abs(uv.x - 0.5));
  float bandE = 1.0 - smoothstep(bandW * 0.8, bandW, min(uv.x, 1.0 - uv.x));
  float band = clamp(max(bandV, bandE), 0.0, 1.0);
  float lid = 1.0 - smoothstep(0.0, 0.022, abs(uv.y - 0.66));
  float lock = SPARK > 0.30
    ? inside(sdBox(uv - vec2(0.5, 0.60), vec2(0.075, 0.095)) - 0.02, 0.006) : 0.0;
  return 0.55 + (grain - 0.5) * 0.22 - board * 0.18 * CAVITY - lid * 0.30
         + band * 0.20 + lock * 0.26;
}

Surf sChest(vec2 uv, float h) {
  float lines = countOf(6.0 * STRUCTP + 1.0);
  float grain = pridge(uv, vec2(4.0, lines * 4.0), 4, u_seed);
  float board = 1.0 - smoothstep(0.0, 0.045, abs(fract(uv.y * lines) - 0.5) * 2.0 - 0.90);
  float bandW = mix(0.02, 0.14, clamp(WEAR, 0.0, 1.0));
  float band = clamp(max(1.0 - smoothstep(bandW * 0.8, bandW, abs(uv.x - 0.5)),
                         1.0 - smoothstep(bandW * 0.8, bandW, min(uv.x, 1.0 - uv.x))), 0.0, 1.0);
  float lid = 1.0 - smoothstep(0.0, 0.022, abs(uv.y - 0.66));
  float lock = SPARK > 0.30
    ? inside(sdBox(uv - vec2(0.5, 0.60), vec2(0.075, 0.095)) - 0.02, 0.006) : 0.0;
  float keyhole = SPARK > 0.30 ? inside(length(uv - vec2(0.5, 0.60)) - 0.024, 0.005) : 0.0;
  float shine = speck(uv, cellsOf(20.0), clamp(SPARK, 0.0, 1.0), 0.3, u_seed + 17.7);
  Surf s = surfInit();
  vec3 wood = mix(C2, C1, 0.3 + 0.7 * grain);
  s.albedo = wood;
  s.albedo = mix(s.albedo, C2 * 0.55, clamp(board + lid, 0.0, 1.0) * 0.8);
  vec3 iron = mix(C3 * 0.8, C3, pfbm(uv, vec2(cellsOf(16.0)), 3, u_seed + 23.1));
  s.albedo = mix(s.albedo, iron, clamp(band + lock, 0.0, 1.0));
  s.albedo = mix(s.albedo, C3 * 1.3, shine * clamp(band + lock, 0.0, 1.0) * 0.6);
  s.albedo = mix(s.albedo, vec3(0.02), keyhole * 0.9);
  s.metal = mix(METALB, 0.9, clamp(band + lock, 0.0, 1.0) * 0.85);
  s.rough = clamp(mix(ROUGHB, 0.34, clamp(band + lock, 0.0, 1.0)), 0.1, 1.0);
  s.ao = clamp(1.0 - board * 0.35 - lid * 0.6 - keyhole * 0.5, 0.0, 1.0);
  return s;
}

/** Ladder / bars / trapdoor: vertical rails with optional rungs. */
vec2 ladderMask(vec2 uv) {
  float rails = countOf(2.0 * TILEP);
  float t = mix(0.03, 0.16, clamp(CAVITY, 0.0, 1.0));
  float railD = abs(fract(uv.x * rails + 0.5) - 0.5) / max(rails, 1.0);
  float rail = 1.0 - smoothstep(t * 0.75, t, railD);
  float rungs = floor(6.0 * STRUCTP + 0.5);
  float rung = 0.0;
  if (rungs >= 1.0) {
    float ry = abs(fract(uv.y * rungs + 0.5) - 0.5) / max(rungs, 1.0);
    rung = 1.0 - smoothstep(t * 0.6, t * 0.85, ry);
  }
  return vec2(rail, rung);
}

float hLadder(vec2 uv) {
  vec2 m = ladderMask(uv);
  float grain = pridge(uv, vec2(4.0, countOf(30.0)), 3, u_seed);
  return 0.22 + m.x * (0.36 + (grain - 0.5) * 0.14) + m.y * 0.28;
}

Surf sLadder(vec2 uv, float h) {
  vec2 m = ladderMask(uv);
  float grain = pridge(uv, vec2(4.0, countOf(30.0)), 3, u_seed);
  float shine = speck(uv, cellsOf(24.0), clamp(SPARK, 0.0, 1.0) * 3.0, 0.28, u_seed + 9.3);
  Surf s = surfInit();
  vec3 col = mix(C2, C1, 0.3 + 0.7 * grain);
  col = mix(col, C3, m.y * 0.5 + shine * 0.4);
  s.albedo = col;
  s.rough = clamp(ROUGHB - shine * 0.2, 0.06, 1.0);
  s.ao = clamp(0.72 + 0.34 * h, 0.0, 1.0);
  s.alpha = u_alphaMode > 0.5 ? step(0.4, max(m.x, m.y)) : 1.0;
  return s;
}

/** Rail / redstone wire: two parallel lines with optional sleepers. */
vec3 railMask(vec2 uv) {
  float t = mix(0.020, 0.055, clamp(CAVITY, 0.0, 1.0));
  float a = 1.0 - smoothstep(t * 0.7, t, abs(uv.x - 0.30));
  float b = 1.0 - smoothstep(t * 0.7, t, abs(uv.x - 0.70));
  float rails = clamp(a + b, 0.0, 1.0);
  float sleepers = floor(8.0 * STRUCTP + 0.5);
  float sl = 0.0;
  if (sleepers >= 1.0) {
    float sy = abs(fract(uv.y * sleepers + 0.5) - 0.5) / max(sleepers, 1.0);
    sl = (1.0 - smoothstep(0.020, 0.032, sy)) * step(abs(uv.x - 0.5), 0.34);
  }
  float ballast = speck(uv, cellsOf(16.0), 0.4 * clamp(WEAR, 0.0, 1.0), 0.3, u_seed + 5.5);
  return vec3(rails, sl, ballast);
}

float hRail(vec2 uv) {
  vec3 m = railMask(uv);
  return 0.24 + m.y * 0.22 + m.x * 0.40 + m.z * 0.12;
}

Surf sRail(vec2 uv, float h) {
  vec3 m = railMask(uv);
  float shine = speck(uv, cellsOf(30.0), clamp(SPARK, 0.0, 1.0) * 2.0, 0.26, u_seed + 11.3);
  Surf s = surfInit();
  s.albedo = mix(C2, C1, m.x);
  s.albedo = mix(s.albedo, C2, m.y * 0.9);
  s.albedo = mix(s.albedo, C3, clamp(shine * m.x * 0.8 + m.z * 0.4, 0.0, 1.0));
  if (EMITB > 0.0) {
    s.albedo = mix(s.albedo, C3, m.x * 0.55);
    s.emit = EMITB * m.x;
  }
  s.metal = METALB * m.x;
  s.rough = clamp(mix(ROUGHB + 0.35, ROUGHB, m.x) - shine * 0.15, 0.06, 1.0);
  s.ao = clamp(0.7 + 0.35 * h, 0.0, 1.0);
  s.alpha = u_alphaMode > 0.5 ? step(0.35, clamp(m.x + m.y, 0.0, 1.0)) : 1.0;
  return s;
}

float hCobweb(vec2 uv) {
  float radial = max(1.0, floor(12.0 * STRUCTP + 0.5));
  float rings = max(1.0, floor(6.0 * CAVITY + 0.5));
  float t = mix(0.004, 0.016, clamp(WEAR, 0.0, 1.0));
  vec2 q = uv - vec2(0.5);
  float r = length(q);
  float a = atan(q.y, q.x) / TAU + 0.5;
  float spoke = 1.0 - smoothstep(t * 0.6, t, abs(fract(a * radial) - 0.5) / max(radial, 1.0) * 2.0 * r);
  float wob = (pfbm(uv, vec2(6.0), 3, u_seed) - 0.5) * 0.06;
  float ring = 1.0 - smoothstep(t * 0.6, t, abs(fract((r + wob) * rings * 2.0) - 0.5) / max(rings * 2.0, 1.0));
  float web = clamp(max(spoke, ring), 0.0, 1.0) * smoothstep(0.52, 0.44, r);
  float dew = speck(uv, cellsOf(18.0), clamp(SPARK, 0.0, 1.0), 0.14, u_seed + 7.7) * web;
  return 0.35 + web * 0.24 + dew * 0.3;
}

Surf sCobweb(vec2 uv, float h) {
  float radial = max(1.0, floor(12.0 * STRUCTP + 0.5));
  float rings = max(1.0, floor(6.0 * CAVITY + 0.5));
  float t = mix(0.004, 0.016, clamp(WEAR, 0.0, 1.0));
  vec2 q = uv - vec2(0.5);
  float r = length(q);
  float a = atan(q.y, q.x) / TAU + 0.5;
  float spoke = 1.0 - smoothstep(t * 0.6, t, abs(fract(a * radial) - 0.5) / max(radial, 1.0) * 2.0 * r);
  float wob = (pfbm(uv, vec2(6.0), 3, u_seed) - 0.5) * 0.06;
  float ring = 1.0 - smoothstep(t * 0.6, t, abs(fract((r + wob) * rings * 2.0) - 0.5) / max(rings * 2.0, 1.0));
  float web = clamp(max(spoke, ring), 0.0, 1.0) * smoothstep(0.52, 0.44, r);
  float dew = speck(uv, cellsOf(18.0), clamp(SPARK, 0.0, 1.0), 0.14, u_seed + 7.7) * web;
  Surf s = surfInit();
  s.albedo = mix(C2, C1, web);
  s.albedo = mix(s.albedo, C3, dew * 0.9);
  s.rough = clamp(ROUGHB - dew * 0.5, 0.06, 1.0);
  s.ao = 1.0;
  s.alpha = clamp(max(web, dew), 0.0, 1.0);
  return s;
}
`;

/** Pattern dispatch and the fragment entry point. @type {string} */
const GEN_MAIN = `
/* ======================================================================== */
/* Dispatch                                                                 */
/* ======================================================================== */

/** Height field of the active pattern, before the shared micro grain. */
float patHeightCore(vec2 uv) {
  switch (u_pattern) {
    case PAT_SOLID:            return hSolid(uv);
    case PAT_STONE:            return hStone(uv);
    case PAT_COBBLE:           return hCobble(uv);
    case PAT_GRANITE:          return hGranite(uv);
    case PAT_ANDESITE:         return hAndesite(uv);
    case PAT_DIORITE:          return hDiorite(uv);
    case PAT_DEEPSLATE:        return hDeepslate(uv);
    case PAT_DIRT:             return hDirt(uv);
    case PAT_GRASS_TOP:        return hGrassTop(uv);
    case PAT_GRASS_SIDE:       return hGrassSide(uv);
    case PAT_SAND:             return hSand(uv);
    case PAT_GRAVEL:           return hGravel(uv);
    case PAT_CLAY:             return hClay(uv);
    case PAT_SNOW:             return hSnow(uv);
    case PAT_ICE:              return hIce(uv);
    case PAT_LOG_SIDE:         return hLogSide(uv);
    case PAT_LOG_TOP:          return hLogTop(uv);
    case PAT_PLANKS:           return hPlanks(uv);
    case PAT_LEAVES:           return hLeaves(uv);
    case PAT_PLANK_DARK:       return hPlankDark(uv);
    case PAT_BRICKS:           return hBricks(uv);
    case PAT_STONE_BRICKS:     return hStoneBricks(uv);
    case PAT_MOSSY:            return hMossy(uv);
    case PAT_SANDSTONE:        return hSandstone(uv);
    case PAT_OBSIDIAN:         return hObsidian(uv);
    case PAT_NETHERRACK:       return hNetherrack(uv);
    case PAT_ORE:              return hOre(uv);
    case PAT_GEM_ORE:          return hGemOre(uv);
    case PAT_GLASS:            return hGlass(uv);
    case PAT_WATER:            return hWater(uv);
    case PAT_LAVA:             return hLava(uv);
    case PAT_MAGMA:            return hMagma(uv);
    case PAT_GLOWSTONE:        return hGlowstone(uv);
    case PAT_REDSTONE_LAMP:    return hRedstoneLamp(uv);
    case PAT_TORCH:            return hTorch(uv);
    case PAT_CRAFTING_TABLE:   return hCraftingTable(uv);
    case PAT_FURNACE_FRONT:    return hFurnaceFront(uv);
    case PAT_FURNACE_SIDE:     return hFurnaceSide(uv);
    case PAT_WOOL:             return hWool(uv);
    case PAT_CLOTH:            return hCloth(uv);
    case PAT_BOOKSHELF:        return hBookshelf(uv);
    case PAT_TNT:              return hTnt(uv);
    case PAT_MELON:            return hMelon(uv);
    case PAT_PUMPKIN:          return hPumpkin(uv);
    case PAT_CACTUS:           return hCactus(uv);
    case PAT_WHEAT:            return hWheat(uv);
    case PAT_FLOWER:           return hFlower(uv);
    case PAT_GRASS_PLANT:      return hGrassPlant(uv);
    case PAT_MUSHROOM:         return hMushroom(uv);
    case PAT_SPONGE:           return hSponge(uv);
    case PAT_HAY:              return hHay(uv);
    case PAT_METAL:            return hMetal(uv);
    case PAT_GOLD_BLOCK:       return hFacet(uv);
    case PAT_DIAMOND_BLOCK:    return hFacet(uv);
    case PAT_EMERALD_BLOCK:    return hFacet(uv);
    case PAT_BEDROCK:          return hBedrock(uv);
    case PAT_SOUL_SAND:        return hSoulSand(uv);
    case PAT_QUARTZ:           return hQuartz(uv);
    case PAT_CONCRETE:         return hConcrete(uv);
    case PAT_TERRACOTTA:       return hTerracotta(uv);
    case PAT_GLAZED:           return hGlazed(uv);
    case PAT_CORAL:            return hCoral(uv);
    case PAT_KELP:             return hKelp(uv);
    case PAT_MYCELIUM:         return hMycelium(uv);
    case PAT_PODZOL:           return hPodzol(uv);
    case PAT_PATH:             return hPath(uv);
    case PAT_FARMLAND:         return hFarmland(uv);
    case PAT_NOTEBLOCK:        return hNoteblock(uv);
    case PAT_CHEST:            return hChest(uv);
    case PAT_LADDER:           return hLadder(uv);
    case PAT_RAIL:             return hRail(uv);
    case PAT_COBWEB:           return hCobweb(uv);
    case PAT_VINE:             return hVine(uv);
    case PAT_LANTERN:          return hLantern(uv);
    case PAT_AMETHYST:         return hAmethyst(uv);
    case PAT_COPPER:           return hCopper(uv);
    case PAT_COPPER_OXIDIZED:  return hCopperOxidized(uv);
    case PAT_DEEPSLATE_BRICKS: return hStoneBricks(uv);
    case PAT_CALCITE:          return hCalcite(uv);
    case PAT_TUFF:             return hTuff(uv);
    case PAT_BASALT:           return hBasalt(uv);
    case PAT_BLACKSTONE:       return hBlackstone(uv);
    case PAT_PACKED_ICE:       return hPackedIce(uv);
    case PAT_END_STONE:        return hEndStone(uv);
    case PAT_PURPUR:           return hPurpur(uv);
    case PAT_PRISMARINE:       return hPrismarine(uv);
    case PAT_SEA_LANTERN:      return hSeaLantern(uv);
    case PAT_SLIME:            return hGel(uv);
    case PAT_HONEY:            return hGel(uv);
    case PAT_MUD:              return hMud(uv);
    case PAT_MOSS:             return hMoss(uv);
    case PAT_AZALEA:           return hAzalea(uv);
    default:                   return hSolid(uv);
  }
}

/** Base frequency of the shared micro grain, ~2 texels per feature. */
float grainFreq() { return max(8.0, floor(u_res * 0.125 + 0.5)); }

/** Full height field: pattern relief plus the shared micro grain. */
float patHeight(vec2 uv) {
  return patHeightCore(uv)
       + (pfbm(uv, vec2(grainFreq()), 3, u_seed + 17.0) - 0.5) * 0.055 * GRAIN;
}

/** Surface properties of the active pattern. */
Surf patSurf(vec2 uv, float h) {
  switch (u_pattern) {
    case PAT_SOLID:            return sSolid(uv, h);
    case PAT_STONE:            return sStone(uv, h);
    case PAT_COBBLE:           return sCobble(uv, h);
    case PAT_GRANITE:          return sGranite(uv, h);
    case PAT_ANDESITE:         return sAndesite(uv, h);
    case PAT_DIORITE:          return sDiorite(uv, h);
    case PAT_DEEPSLATE:        return sDeepslate(uv, h);
    case PAT_DIRT:             return sDirt(uv, h);
    case PAT_GRASS_TOP:        return sGrassTop(uv, h);
    case PAT_GRASS_SIDE:       return sGrassSide(uv, h);
    case PAT_SAND:             return sSand(uv, h);
    case PAT_GRAVEL:           return sGravel(uv, h);
    case PAT_CLAY:             return sClay(uv, h);
    case PAT_SNOW:             return sSnow(uv, h);
    case PAT_ICE:              return sIce(uv, h);
    case PAT_LOG_SIDE:         return sLogSide(uv, h);
    case PAT_LOG_TOP:          return sLogTop(uv, h);
    case PAT_PLANKS:           return sPlanks(uv, h);
    case PAT_LEAVES:           return sLeaves(uv, h);
    case PAT_PLANK_DARK:       return sPlankDark(uv, h);
    case PAT_BRICKS:           return sBricks(uv, h);
    case PAT_STONE_BRICKS:     return sStoneBricks(uv, h);
    case PAT_MOSSY:            return sMossy(uv, h);
    case PAT_SANDSTONE:        return sSandstone(uv, h);
    case PAT_OBSIDIAN:         return sObsidian(uv, h);
    case PAT_NETHERRACK:       return sNetherrack(uv, h);
    case PAT_ORE:              return sOre(uv, h);
    case PAT_GEM_ORE:          return sGemOre(uv, h);
    case PAT_GLASS:            return sGlass(uv, h);
    case PAT_WATER:            return sWater(uv, h);
    case PAT_LAVA:             return sLava(uv, h);
    case PAT_MAGMA:            return sMagma(uv, h);
    case PAT_GLOWSTONE:        return sGlowstone(uv, h);
    case PAT_REDSTONE_LAMP:    return sRedstoneLamp(uv, h);
    case PAT_TORCH:            return sTorch(uv, h);
    case PAT_CRAFTING_TABLE:   return sCraftingTable(uv, h);
    case PAT_FURNACE_FRONT:    return sFurnaceFront(uv, h);
    case PAT_FURNACE_SIDE:     return sFurnaceSide(uv, h);
    case PAT_WOOL:             return sWool(uv, h);
    case PAT_CLOTH:            return sCloth(uv, h);
    case PAT_BOOKSHELF:        return sBookshelf(uv, h);
    case PAT_TNT:              return sTnt(uv, h);
    case PAT_MELON:            return sMelon(uv, h);
    case PAT_PUMPKIN:          return sPumpkin(uv, h);
    case PAT_CACTUS:           return sCactus(uv, h);
    case PAT_WHEAT:            return sWheat(uv, h);
    case PAT_FLOWER:           return sFlower(uv, h);
    case PAT_GRASS_PLANT:      return sGrassPlant(uv, h);
    case PAT_MUSHROOM:         return sMushroom(uv, h);
    case PAT_SPONGE:           return sSponge(uv, h);
    case PAT_HAY:              return sHay(uv, h);
    case PAT_METAL:            return sMetal(uv, h);
    case PAT_GOLD_BLOCK:       return sFacet(uv, h);
    case PAT_DIAMOND_BLOCK:    return sFacet(uv, h);
    case PAT_EMERALD_BLOCK:    return sFacet(uv, h);
    case PAT_BEDROCK:          return sBedrock(uv, h);
    case PAT_SOUL_SAND:        return sSoulSand(uv, h);
    case PAT_QUARTZ:           return sQuartz(uv, h);
    case PAT_CONCRETE:         return sConcrete(uv, h);
    case PAT_TERRACOTTA:       return sTerracotta(uv, h);
    case PAT_GLAZED:           return sGlazed(uv, h);
    case PAT_CORAL:            return sCoral(uv, h);
    case PAT_KELP:             return sKelp(uv, h);
    case PAT_MYCELIUM:         return sMycelium(uv, h);
    case PAT_PODZOL:           return sPodzol(uv, h);
    case PAT_PATH:             return sPath(uv, h);
    case PAT_FARMLAND:         return sFarmland(uv, h);
    case PAT_NOTEBLOCK:        return sNoteblock(uv, h);
    case PAT_CHEST:            return sChest(uv, h);
    case PAT_LADDER:           return sLadder(uv, h);
    case PAT_RAIL:             return sRail(uv, h);
    case PAT_COBWEB:           return sCobweb(uv, h);
    case PAT_VINE:             return sVine(uv, h);
    case PAT_LANTERN:          return sLantern(uv, h);
    case PAT_AMETHYST:         return sAmethyst(uv, h);
    case PAT_COPPER:           return sCopper(uv, h);
    case PAT_COPPER_OXIDIZED:  return sCopperOxidized(uv, h);
    case PAT_DEEPSLATE_BRICKS: return sStoneBricks(uv, h);
    case PAT_CALCITE:          return sCalcite(uv, h);
    case PAT_TUFF:             return sTuff(uv, h);
    case PAT_BASALT:           return sBasalt(uv, h);
    case PAT_BLACKSTONE:       return sBlackstone(uv, h);
    case PAT_PACKED_ICE:       return sPackedIce(uv, h);
    case PAT_END_STONE:        return sEndStone(uv, h);
    case PAT_PURPUR:           return sPurpur(uv, h);
    case PAT_PRISMARINE:       return sPrismarine(uv, h);
    case PAT_SEA_LANTERN:      return sSeaLantern(uv, h);
    case PAT_SLIME:            return sGel(uv, h);
    case PAT_HONEY:            return sGel(uv, h);
    case PAT_MUD:              return sMud(uv, h);
    case PAT_MOSS:             return sMoss(uv, h);
    case PAT_AZALEA:           return sAzalea(uv, h);
    default:                   return sSolid(uv, h);
  }
}

/** True for the families where p7 is an animation speed rather than a contrast. */
bool contrastIsSpeed() {
  return u_pattern == PAT_LAVA || u_pattern == PAT_MAGMA || u_pattern == PAT_WATER;
}

/**
 * Reference colour the p7 contrast expands about. It has to approximate the
 * tile's real average, so families that re-purpose color2 (ore hosts, the dirt
 * body of a "_side" texture, the glow colour of a carved pumpkin) need their
 * own blend — otherwise the contrast pushes the dominant colour toward the
 * complement of an accent that barely covers the tile.
 */
vec3 tileMean() {
  if (u_pattern == PAT_ORE || u_pattern == PAT_GEM_ORE) return mix(C2, C1, 0.12);
  if (u_pattern == PAT_GRASS_SIDE) return mix(C2, C1, 0.28);
  if (u_pattern == PAT_PUMPKIN || u_pattern == PAT_MELON) return mix(C1, C2, 0.20);
  if (u_pattern == PAT_MOSSY) return mix(mix(C1, C2, 0.35), C3, clamp(SPARK, 0.0, 1.0) * 0.4);
  if (u_pattern == PAT_TORCH || u_pattern == PAT_LANTERN || u_pattern == PAT_FLOWER ||
      u_pattern == PAT_COBWEB || u_pattern == PAT_RAIL) return mix(C1, C2, 0.5);
  return mix(C1, C2, 0.35);
}

void main() {
  vec2 uv = v_uv;
  float e = px();

  // Sample the height field on a ring of taps plus the centre. The loop bound is
  // a uniform so the compiler cannot unroll 'patHeight' N times into the binary.
  float h = 0.5;
  vec2 g = vec2(0.0);
  int taps = max(u_taps, 4);
  for (int i = 0; i < taps + 1; ++i) {
    vec2 d = vec2(0.0);
    if (i < taps) {
      float a = (float(i) + 0.5) * TAU / float(taps);
      d = vec2(cos(a), sin(a)) * e;
    }
    float hi = patHeight(uv + d);
    if (i < taps) g += d * hi;
    else h = hi;
  }
  // For a locally linear field, sum(d_i * h_i) = (N/2) * e^2 * grad(h).
  vec2 grad = g * (2.0 / (float(taps) * e * e));

  Surf s = patSurf(uv, h);

  // Shared micro grain on albedo and roughness, matching the height grain.
  float gr = pfbm(uv, vec2(grainFreq()), 3, u_seed + 17.0) - 0.5;
  s.albedo *= 1.0 + gr * 0.16 * GRAIN;
  s.rough = clamp(s.rough + gr * 0.12 * GRAIN, 0.02, 1.0);

  // Contrast about the tile mean (p7), except where p7 means animation speed.
  float contrast = contrastIsSpeed() ? 1.0 : clamp(CONTR, 0.0, 2.5);
  vec3 mean = mix(C1, C2, 0.35);
  s.albedo = max(vec3(0.0), mix(mean, s.albedo, contrast));

  // Emissive fallback for materials whose pattern does not shape it explicitly.
  if (EMITB > 0.0 && s.emit <= 0.0) {
    s.emit = EMITB * smoothstep(0.10, 0.85, clamp(luminance(s.albedo) * 1.7, 0.0, 1.0));
  }

  // Tangent-space normal from the reconstructed gradient (OpenGL "green up").
  vec2 nxy = -grad * max(RELIEF, 0.0005);
  float m = length(nxy);
  if (m > 5.0) nxy *= 5.0 / m;
  vec3 n = normalize(vec3(nxy, 1.0));

  // Cavity darkening: recessed texels lose ambient light.
  float cav = clamp(CAVITY, 0.0, 1.0) * 0.45;
  float ao = clamp(s.ao * mix(1.0, clamp(0.42 + 0.72 * h, 0.0, 1.0), cav), 0.0, 1.0);

  float alpha = u_alphaMode > 0.5 ? clamp(s.alpha, 0.0, 1.0) : 1.0;

  o_albedo = vec4(clamp(s.albedo, vec3(0.0), vec3(1.0)), alpha);
  o_normal = vec4(n * 0.5 + 0.5, clamp(h, 0.0, 1.0));
  o_mrae = vec4(clamp(s.metal, 0.0, 1.0), clamp(s.rough, 0.02, 1.0),
                ao, clamp(s.emit, 0.0, 1.0));
}
`;

/**
 * The complete uber generator fragment shader.
 * @type {string}
 */
export const GENERATOR_FS = [PATTERN_DEFINES, GEN_HEAD, GEN_ROCK, GEN_EARTH, GEN_WOOD,
  GEN_CRAFT, GEN_MAIN].join('\n');

/* ========================================================================== */
/* GLSL — cloud noise & icons                                                 */
/* ========================================================================== */

/**
 * Perlin-Worley volume noise, one Z slice per draw.
 * R = perlin-worley base, G/B/A = worley detail at rising frequencies.
 * @type {string}
 */
export const CLOUD_FS = `
#include <math>

in vec2 v_uv;
out vec4 fragColor;

uniform float u_slice;   // normalised Z of this slice
uniform float u_size;    // volume edge size in texels

float ch3(vec3 c, vec3 period) {
  return hash31(mod(c, max(period, vec3(1.0))));
}

vec3 ch33(vec3 c, vec3 period) {
  return hash33(mod(c, max(period, vec3(1.0))) + vec3(0.37, 0.11, 0.71));
}

/** Tiling 3D value noise. */
float pval3(vec3 p, float freq) {
  vec3 f3 = vec3(max(1.0, floor(freq + 0.5)));
  vec3 q = p * f3;
  vec3 i = floor(q);
  vec3 t = fract(q);
  vec3 u = t * t * (3.0 - 2.0 * t);
  float n000 = ch3(i + vec3(0.0, 0.0, 0.0), f3);
  float n100 = ch3(i + vec3(1.0, 0.0, 0.0), f3);
  float n010 = ch3(i + vec3(0.0, 1.0, 0.0), f3);
  float n110 = ch3(i + vec3(1.0, 1.0, 0.0), f3);
  float n001 = ch3(i + vec3(0.0, 0.0, 1.0), f3);
  float n101 = ch3(i + vec3(1.0, 0.0, 1.0), f3);
  float n011 = ch3(i + vec3(0.0, 1.0, 1.0), f3);
  float n111 = ch3(i + vec3(1.0, 1.0, 1.0), f3);
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

/** Tiling 3D worley, inverted so cell centres are 1. */
float pworley3(vec3 p, float freq) {
  vec3 f3 = vec3(max(1.0, floor(freq + 0.5)));
  vec3 q = p * f3;
  vec3 base = floor(q);
  vec3 fr = fract(q);
  float best = 8.0;
  for (int z = -1; z <= 1; ++z) {
    for (int y = -1; y <= 1; ++y) {
      for (int x = -1; x <= 1; ++x) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 o = ch33(base + g, f3);
        vec3 r = g + o - fr;
        best = min(best, dot(r, r));
      }
    }
  }
  return 1.0 - clamp(sqrt(best), 0.0, 1.0);
}

float perlinFbm(vec3 p, float freq, int oct) {
  float a = 0.5;
  float s = 0.0;
  float n = 0.0;
  float f = freq;
  for (int i = 0; i < 6; ++i) {
    if (i >= oct) break;
    s += a * (pval3(p, f) * 2.0 - 1.0);
    n += a;
    f *= 2.0;
    a *= 0.5;
  }
  return s / max(n, 1.0e-5) * 0.5 + 0.5;
}

float worleyFbm(vec3 p, float freq) {
  return pworley3(p, freq) * 0.625 + pworley3(p, freq * 2.0) * 0.25
       + pworley3(p, freq * 4.0) * 0.125;
}

void main() {
  vec3 p = vec3(v_uv, u_slice);
  float perlin = perlinFbm(p, 4.0, 5);
  float w0 = worleyFbm(p, 4.0);
  float w1 = worleyFbm(p, 8.0);
  float w2 = worleyFbm(p, 16.0);
  float w3 = worleyFbm(p, 24.0);
  // Perlin-Worley: remap the perlin range by the worley base (Schneider 2015).
  float pw = clamp(remapClamped(perlin, w0 - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  fragColor = vec4(pw, w1, w2, w3);
}
`;

/** Vertex shader for the isometric block-icon renderer. @type {string} */
export const ICON_VS = `
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
layout(location = 3) in vec3 a_tangent;
layout(location = 4) in float a_face;

uniform mat4 u_mvp;
uniform mat4 u_model;

out vec3 v_normal;
out vec3 v_tangent;
out vec2 v_uv;
flat out int v_face;

void main() {
  mat3 rot = mat3(u_model);
  v_normal = rot * a_normal;
  v_tangent = rot * a_tangent;
  v_uv = a_uv;
  v_face = int(a_face + 0.5);
  gl_Position = u_mvp * vec4(a_position, 1.0);
}
`;

/** Fragment shader for the isometric block-icon renderer. @type {string} */
export const ICON_FS = `
#include <math>
#include <color>

in vec3 v_normal;
in vec3 v_tangent;
in vec2 v_uv;
flat in int v_face;

uniform sampler2DArray u_albedoArray;
uniform sampler2DArray u_normalArray;
uniform sampler2DArray u_mraeArray;
uniform float u_layers[6];
uniform vec3  u_tint;
uniform float u_cutout;

out vec4 fragColor;

void main() {
  float layer = u_layers[clamp(v_face, 0, 5)];
  vec4 alb = texture(u_albedoArray, vec3(v_uv, layer));
  if (u_cutout > 0.5 && alb.a < 0.4) discard;

  vec3 nm = texture(u_normalArray, vec3(v_uv, layer)).xyz * 2.0 - 1.0;
  vec4 mrae = texture(u_mraeArray, vec3(v_uv, layer));

  vec3 N = safeNormalize(v_normal);
  vec3 T = safeNormalize(v_tangent - N * dot(N, v_tangent));
  vec3 B = cross(N, T);
  N = safeNormalize(mat3(T, B, N) * nm);

  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 base = alb.rgb * u_tint;
  float metal = mrae.r;
  float rough = clamp(mrae.g, 0.05, 1.0);
  float ao = mrae.b;

  // Three point studio lighting: warm key, cool fill, tight rim.
  vec3 L1 = safeNormalize(vec3(-0.42, 0.78, 0.46));
  vec3 L2 = safeNormalize(vec3(0.76, 0.10, 0.60));
  vec3 L3 = safeNormalize(vec3(0.10, -0.45, -0.88));
  vec3 diff = base * (1.0 - metal * 0.85);
  vec3 col = diff * (max(dot(N, L1), 0.0) * vec3(1.10, 1.04, 0.94)
                   + max(dot(N, L2), 0.0) * vec3(0.30, 0.36, 0.48)
                   + max(dot(N, L3), 0.0) * vec3(0.16, 0.16, 0.20));
  col += diff * vec3(0.22, 0.24, 0.30) * ao;

  vec3 f0 = mix(vec3(0.04), base, metal);
  float shine = pow(max(dot(N, safeNormalize(L1 + V)), 0.0), mix(96.0, 6.0, rough));
  col += f0 * shine * (1.0 - rough * 0.7) * 1.5;
  col += base * mrae.a * 1.6;

  col = acesFitted(col * 1.05);
  fragColor = vec4(linearToSrgb(col), alb.a);
}
`;

/* ========================================================================== */
/* Blue noise — void-and-cluster                                              */
/* ========================================================================== */

/**
 * Generate a `size x size` blue-noise threshold matrix with Ulichney's
 * void-and-cluster algorithm (toroidal, Gaussian energy kernel).
 *
 * Runs on the CPU in slices so the loading screen keeps animating: the caller
 * awaits `yieldFn()` whenever the time budget for one slice is spent.
 *
 * @param {number} size edge length (must be a power of two for best results)
 * @param {function():Promise<*>} yieldFn awaited to hand control back to the page
 * @returns {Promise<Uint8Array>} `size*size` bytes, uniformly distributed 0..255
 */
async function buildBlueNoise(size, yieldFn) {
  const total = size * size;
  const sigma = 1.9;
  const radius = 6;
  const span = radius * 2 + 1;
  const kernel = new Float32Array(span * span);
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      kernel[(y + radius) * span + (x + radius)] =
        Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
    }
  }

  const energy = new Float32Array(total);
  const binary = new Uint8Array(total);
  const rank = new Int32Array(total).fill(-1);

  /**
   * Splat (or un-splat) the energy kernel around a pixel.
   * @param {number} index pixel index
   * @param {number} sign +1 to add, -1 to remove
   * @returns {void}
   */
  const splat = (index, sign) => {
    const px = index % size;
    const py = (index / size) | 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = (py + dy + size) % size;
      const row = yy * size;
      const krow = (dy + radius) * span;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = (px + dx + size) % size;
        energy[row + xx] += sign * kernel[krow + (dx + radius)];
      }
    }
  };

  /**
   * Locate the tightest cluster (`want` = 1) or the largest void (`want` = 0).
   * @param {number} want binary value to search among
   * @returns {number} pixel index, or -1 when none exists
   */
  const findExtreme = (want) => {
    let best = -1;
    let bestVal = want === 1 ? -Infinity : Infinity;
    for (let i = 0; i < total; i++) {
      if (binary[i] !== want) continue;
      const v = energy[i];
      if (want === 1 ? v > bestVal : v < bestVal) { bestVal = v; best = i; }
    }
    return best;
  };

  // --- initial random pattern (~10% ones) ---------------------------------
  const rng = mulberry32(0x5eed1234);
  const targetOnes = Math.max(1, Math.round(total * 0.1));
  let ones = 0;
  while (ones < targetOnes) {
    const p = Math.min(total - 1, (rng() * total) | 0);
    if (binary[p]) continue;
    binary[p] = 1;
    splat(p, 1);
    ones++;
  }

  const budget = new TimeBudget(SLICE_BUDGET_MS);
  budget.start();

  // --- cluster/void swapping until the pattern stops changing --------------
  for (let iter = 0; iter < total; iter++) {
    const cluster = findExtreme(1);
    if (cluster < 0) break;
    binary[cluster] = 0;
    splat(cluster, -1);
    const voidPix = findExtreme(0);
    if (voidPix < 0 || voidPix === cluster) {
      binary[cluster] = 1;
      splat(cluster, 1);
      break;
    }
    binary[voidPix] = 1;
    splat(voidPix, 1);
    if (budget.expired()) { await yieldFn(); budget.start(); }
  }

  const prototype = binary.slice();
  const protoEnergy = energy.slice();

  // --- phase 1: remove the tightest cluster, ranking downwards -------------
  for (let r = ones - 1; r >= 0; r--) {
    const cluster = findExtreme(1);
    if (cluster < 0) break;
    binary[cluster] = 0;
    splat(cluster, -1);
    rank[cluster] = r;
    if (budget.expired()) { await yieldFn(); budget.start(); }
  }

  // --- phases 2 & 3: fill the largest void, ranking upwards ----------------
  binary.set(prototype);
  energy.set(protoEnergy);
  for (let r = ones; r < total; r++) {
    const voidPix = findExtreme(0);
    if (voidPix < 0) break;
    binary[voidPix] = 1;
    splat(voidPix, 1);
    rank[voidPix] = r;
    if (budget.expired()) { await yieldFn(); budget.start(); }
  }

  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const r = rank[i] < 0 ? 0 : rank[i];
    out[i] = Math.min(255, Math.floor(((r + 0.5) / total) * 256));
  }
  return out;
}

/* ========================================================================== */
/* Icon geometry                                                              */
/* ========================================================================== */

/**
 * Per-face basis of a unit cube: normal, U tangent and V bitangent, in the
 * face order of ARCHITECTURE.md 3.1 (`0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z`).
 * `cross(tangent, bitangent) === normal` for every entry, so the winding below
 * is counter-clockwise seen from outside.
 * @type {ReadonlyArray<{n:number[], t:number[], b:number[]}>}
 */
const CUBE_FACES = Object.freeze([
  { n: [1, 0, 0], t: [0, 0, -1], b: [0, 1, 0] },
  { n: [-1, 0, 0], t: [0, 0, 1], b: [0, 1, 0] },
  { n: [0, 1, 0], t: [1, 0, 0], b: [0, 0, -1] },
  { n: [0, -1, 0], t: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, 0, 1], t: [1, 0, 0], b: [0, 1, 0] },
  { n: [0, 0, -1], t: [-1, 0, 0], b: [0, 1, 0] },
]);

/** Floats per icon vertex: position(3) normal(3) uv(2) tangent(3) face(1). */
const ICON_VERTEX_FLOATS = 12;

/**
 * Build the interleaved vertex/index data for a unit cube centred on the origin.
 * @returns {{vertices:Float32Array, indices:Uint16Array}} cube mesh
 */
function buildCubeMesh() {
  const vertices = new Float32Array(24 * ICON_VERTEX_FLOATS);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (let f = 0; f < 6; f++) {
    const { n, t, b } = CUBE_FACES[f];
    const base = f * 4;
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let c = 0; c < 4; c++) {
      const u = corners[c][0];
      const w = corners[c][1];
      vertices[v++] = n[0] * 0.5 + t[0] * (u - 0.5) + b[0] * (w - 0.5);
      vertices[v++] = n[1] * 0.5 + t[1] * (u - 0.5) + b[1] * (w - 0.5);
      vertices[v++] = n[2] * 0.5 + t[2] * (u - 0.5) + b[2] * (w - 0.5);
      vertices[v++] = n[0]; vertices[v++] = n[1]; vertices[v++] = n[2];
      vertices[v++] = u; vertices[v++] = w;
      vertices[v++] = t[0]; vertices[v++] = t[1]; vertices[v++] = t[2];
      vertices[v++] = f;
    }
    indices[i++] = base; indices[i++] = base + 1; indices[i++] = base + 2;
    indices[i++] = base; indices[i++] = base + 2; indices[i++] = base + 3;
  }
  return { vertices, indices };
}

/**
 * Build a flat, camera-facing quad used for cross/plant style block icons.
 * @returns {{vertices:Float32Array, indices:Uint16Array}} quad mesh
 */
function buildQuadMesh() {
  const vertices = new Float32Array(4 * ICON_VERTEX_FLOATS);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  let v = 0;
  for (let c = 0; c < 4; c++) {
    const u = corners[c][0];
    const w = corners[c][1];
    vertices[v++] = u - 0.5; vertices[v++] = w - 0.5; vertices[v++] = 0;
    vertices[v++] = 0; vertices[v++] = 0; vertices[v++] = 1;
    vertices[v++] = u; vertices[v++] = w;
    vertices[v++] = 1; vertices[v++] = 0; vertices[v++] = 0;
    vertices[v++] = 4;
  }
  return { vertices, indices };
}

/** Icon tints for biome-coloured blocks (linear, matched to a temperate biome). */
const ICON_TINTS = Object.freeze({
  grass: [0.36, 0.62, 0.24],
  foliage: [0.30, 0.56, 0.20],
  water: [0.22, 0.42, 0.78],
});

/* ========================================================================== */
/* TextureManager                                                             */
/* ========================================================================== */

/**
 * Owns every procedurally generated texture in the engine.
 *
 * ```js
 * const textures = new TextureManager(gl, settings);
 * await textures.generate((p) => loadingScreen.setProgress(p));
 * textures.bindArrays(terrainProgram);            // units 0, 1, 2
 * program.setTexture('u_blueNoise', textures.blueNoise, 11);
 * program.setTexture('u_cloudNoise', textures.cloudNoise, 13, gl.gl.TEXTURE_3D);
 * ```
 */
export class TextureManager {
  /**
   * @param {import('../core/gl.js').GL} gl VOXELIA WebGL2 device
   * @param {{get:function(string):*}} settings settings instance (see `core/settings.js`)
   */
  constructor(gl, settings) {
    /** @type {import('../core/gl.js').GL} owning device */
    this.device = gl;
    /** @type {WebGL2RenderingContext} raw context */
    this.raw = gl.gl;
    /** @type {{get:function(string):*}|null} settings source */
    this.settings = settings || null;

    /** @type {WebGLTexture|null} RGBA8 albedo array (unit 0). */
    this.albedoArray = null;
    /** @type {WebGLTexture|null} RGBA8 tangent-space normal + height array (unit 1). */
    this.normalArray = null;
    /** @type {WebGLTexture|null} RGBA8 metallic/roughness/AO/emissive array (unit 2). */
    this.mraeArray = null;
    /** @type {WebGLTexture|null} 64x64 R8 blue-noise mask (unit 11). */
    this.blueNoise = null;
    /** @type {WebGLTexture|null} RGBA8 Perlin-Worley 3D volume (unit 13). */
    this.cloudNoise = null;

    /** @type {number} effective texture-array edge size in texels. */
    this.resolution = this._resolveResolution(this._setting('textureResolution', 256));
    /** @type {number} number of generated layers (may be clamped by the driver). */
    this.layerCount = Math.min(MATERIAL_COUNT, Math.max(1, gl.caps.maxLayers | 0));
    /** @type {number} edge size of the cloud volume. */
    this.cloudSize = this._resolveCloudSize();
    /** @type {boolean} true once `generate()` finished successfully. */
    this.ready = false;
    /** @type {number} last reported progress, 0..1. */
    this.progress = 0;

    /** @type {?Object} generator program. @private */
    this._genProgram = null;
    /** @type {?Object} MRT framebuffer over the three arrays. @private */
    this._genFBO = null;
    /** @type {?Object} cloud-volume program. @private */
    this._cloudProgram = null;
    /** @type {?Object} single-slice framebuffer over the cloud volume. @private */
    this._cloudFBO = null;
    /** @type {?Object} icon program. @private */
    this._iconProgram = null;
    /** @type {?Object} icon framebuffer. @private */
    this._iconFBO = null;
    /** @type {?WebGLTexture} icon colour target. @private */
    this._iconTexture = null;
    /** @type {number} current icon target size. @private */
    this._iconSize = 0;
    /** @type {?WebGLVertexArrayObject} cube VAO. @private */
    this._cubeVAO = null;
    /** @type {?WebGLVertexArrayObject} sprite quad VAO. @private */
    this._quadVAO = null;
    /** @type {WebGLBuffer[]} buffers owned by the icon meshes. @private */
    this._iconBuffers = [];
    /** @type {?HTMLCanvasElement} scratch canvas for icon read-back. @private */
    this._iconCanvas = null;
    /** @type {?CanvasRenderingContext2D} its 2D context. @private */
    this._iconCtx = null;
    /** @type {?Uint8Array} icon read-back staging buffer. @private */
    this._iconPixels = null;

    // Reusable scratch state — nothing here allocates per frame or per layer.
    /** @type {Float32Array} @private */
    this._mvp = mat4.create();
    /** @type {Float32Array} @private */
    this._model = mat4.create();
    /** @type {Float32Array} @private */
    this._proj = mat4.create();
    /** @type {Float32Array} @private */
    this._layerScratch = new Float32Array(6);
    /** @type {boolean} @private */
    this._disposed = false;
    /** @type {boolean} @private */
    this._warnedLayers = false;
  }

  /* ---------------------------------------------------------------- config */

  /**
   * Read a setting with a fallback, tolerating a missing settings object.
   * @param {string} key setting key
   * @param {*} fallback value when the key is unknown
   * @returns {*} the setting value
   * @private
   */
  _setting(key, fallback) {
    if (!this.settings || typeof this.settings.get !== 'function') return fallback;
    const v = this.settings.get(key);
    return v === undefined || v === null ? fallback : v;
  }

  /**
   * Clamp a requested resolution against the driver limits and the VRAM budget.
   * @param {number} requested requested edge size
   * @returns {number} the resolution actually used
   * @private
   */
  _resolveResolution(requested) {
    const caps = this.device.caps;
    let res = TEXTURE_RESOLUTIONS.indexOf(requested | 0) >= 0 ? requested | 0 : 256;
    res = Math.min(res, caps.maxTexSize | 0 || 256);
    const layers = Math.min(MATERIAL_COUNT, Math.max(1, caps.maxLayers | 0));
    // 3 arrays * RGBA8 * mip chain (~1.34x).
    const cost = (r) => layers * 3 * r * r * 4 * 1.34;
    while (res > 128 && cost(res) > VRAM_BUDGET_BYTES) res >>= 1;
    if (res !== (requested | 0)) {
      console.warn(`[textures] texture resolution clamped from ${requested} to ${res} ` +
        `(${layers} layers would need ${(cost(requested | 0) / 1048576) | 0} MB)`);
    }
    return Math.max(32, res);
  }

  /**
   * Pick the cloud-volume size from `cloudQuality` and the 3D texture limit.
   * @returns {number} edge size of the cloud volume
   * @private
   */
  _resolveCloudSize() {
    const q = String(this._setting('cloudQuality', 'high'));
    const wanted = (q === 'off' || q === 'potato' || q === 'low') ? 64 : 128;
    const limit = this.device.caps.max3DTexSize | 0;
    return limit > 0 ? Math.min(wanted, limit) : wanted;
  }

  /* -------------------------------------------------------------- resources */

  /**
   * Create the texture arrays, the MRT framebuffer and the generator program.
   * Never throws: on failure the manager degrades to "no textures" and the
   * renderer keeps running with whatever is already bound.
   * @returns {boolean} true when everything is usable
   * @private
   */
  _ensureResources() {
    if (this._disposed) return false;
    if (this._genProgram && this._genFBO && this.albedoArray) return true;
    const device = this.device;
    const gl = this.raw;
    try {
      if (device.caps.maxDrawBuffers < 3) {
        console.error('[textures] MAX_DRAW_BUFFERS < 3 — cannot render albedo/normal/mrae at once.');
        return false;
      }
      if (MATERIAL_COUNT > device.caps.maxLayers && !this._warnedLayers) {
        this._warnedLayers = true;
        console.error(`[textures] the driver allows ${device.caps.maxLayers} array layers but ` +
          `${MATERIAL_COUNT} materials exist; the last ${MATERIAL_COUNT - device.caps.maxLayers} ` +
          'materials will not be generated.');
      }

      const res = this.resolution;
      const aniso = Math.max(1, this._setting('anisotropy', 8) | 0);
      const desc = {
        target: gl.TEXTURE_2D_ARRAY,
        width: res,
        height: res,
        depth: this.layerCount,
        internalFormat: gl.RGBA8,
        min: 'linear_mipmap_linear',
        mag: 'linear',
        wrap: 'repeat',
        mips: true,
        aniso,
      };
      this.albedoArray = device.createTexture(desc);
      this.normalArray = device.createTexture(desc);
      this.mraeArray = device.createTexture(desc);

      this._genFBO = device.createFramebuffer({
        name: 'texture-generator',
        width: res,
        height: res,
        color: [
          { tex: this.albedoArray, layer: 0 },
          { tex: this.normalArray, layer: 0 },
          { tex: this.mraeArray, layer: 0 },
        ],
      });
      if (!this._genFBO.complete) {
        console.error('[textures] the generator framebuffer is incomplete; textures stay blank.');
        return false;
      }

      this._genProgram = device.createProgram('texture-generator', FULLSCREEN_VS, GENERATOR_FS);
      if (!this._genProgram.use()) {
        console.error('[textures] the generator shader failed to build; textures stay blank.');
        return false;
      }
      return true;
    } catch (err) {
      console.error('[textures] resource creation failed:', err);
      return false;
    }
  }

  /* -------------------------------------------------------------- generation */

  /**
   * Render every material layer, the blue-noise mask and the cloud volume.
   *
   * Work is sliced across event-loop turns (~12 ms of submission per slice) so
   * the loading screen keeps animating; `onProgress` is called with 0..1.
   *
   * @param {function(number):void} [onProgress] progress sink, 0..1
   * @returns {Promise<boolean>} true when the arrays are usable
   */
  async generate(onProgress) {
    const report = (p) => {
      this.progress = clamp(p, 0, 1);
      if (typeof onProgress !== 'function') return;
      try { onProgress(this.progress); } catch (err) { /* a broken UI never stops loading */ }
    };
    report(0);
    if (!this._ensureResources()) { report(1); return false; }

    try {
      await this._generateLayers((p) => report(p * 0.80));
      await this._generateBlueNoise();
      report(0.86);
      await this._generateCloudNoise((p) => report(0.86 + p * 0.14));
      this.ready = true;
      report(1);
      return true;
    } catch (err) {
      console.error('[textures] generation failed:', err);
      report(1);
      return false;
    }
  }

  /**
   * Render one fullscreen pass per material into all three arrays.
   * @param {function(number):void} report progress sink, 0..1
   * @returns {Promise<void>} resolves when every layer has been submitted
   * @private
   */
  async _generateLayers(report) {
    const device = this.device;
    const gl = this.raw;
    const program = this._genProgram;
    const fbo = this._genFBO;
    const res = this.resolution;
    const taps = res >= 512 ? 8 : (res >= 256 ? 8 : 6);

    device.setDepthTest(false);
    device.setDepthWrite(false);
    device.setCull('none');
    device.setBlend('none');
    device.setColorMask(true, true, true, true);
    program.use();
    program.setFloat('u_res', res);
    program.setInt('u_taps', taps);

    const count = Math.min(MATERIALS.length, this.layerCount);
    const budget = new TimeBudget(SLICE_BUDGET_MS);
    budget.start();

    for (let layer = 0; layer < count; layer++) {
      const m = MATERIALS[layer];
      const params = m.params || [];
      const c1 = m.color || [0.5, 0.5, 0.5];
      const c2 = m.color2 || [c1[0] * 0.6, c1[1] * 0.6, c1[2] * 0.6];
      const c3 = m.color3 || [Math.min(1, c1[0] * 1.5), Math.min(1, c1[1] * 1.5), Math.min(1, c1[2] * 1.5)];

      program.setInt('u_pattern', patternId(m.pattern));
      program.setVec3('u_color', c1);
      program.setVec3('u_color2', c2);
      program.setVec3('u_color3', c3);
      program.setVec4('u_prop',
        m.roughness === undefined ? 0.8 : m.roughness,
        m.metallic === undefined ? 0 : m.metallic,
        m.emissive === undefined ? 0 : m.emissive,
        m.height === undefined ? 0.02 : m.height);
      program.setVec4('u_pa', params[0] || 0, params[1] || 0, params[2] || 0, params[3] || 0);
      program.setVec4('u_pb', params[4] || 0, params[5] || 0,
        params[6] === undefined ? 1 : params[6],
        params[7] === undefined ? 1 : params[7]);
      program.setFloat('u_seed', m.seed === undefined ? layer * 37 + 11 : m.seed);
      program.setFloat('u_scale', m.scale === undefined ? 1 : m.scale);
      program.setFloat('u_alphaMode', m.alpha ? 1 : 0);

      fbo.setColorLayer(0, layer);
      fbo.setColorLayer(1, layer);
      fbo.setColorLayer(2, layer);
      fbo.bind();
      device.drawFullscreen();

      if (budget.expired() || layer === count - 1) {
        gl.flush();
        report((layer + 1) / count);
        await nextFrame();
        if (this._disposed) return;
        budget.start();
      }
    }

    device.bindFramebuffer(null);
    device.generateMipmap(this.albedoArray);
    device.generateMipmap(this.normalArray);
    device.generateMipmap(this.mraeArray);
    report(1);
  }

  /**
   * Build and upload the 64x64 blue-noise mask.
   * @returns {Promise<void>} resolves once the texture exists
   * @private
   */
  async _generateBlueNoise() {
    const gl = this.raw;
    try {
      const data = await buildBlueNoise(BLUE_NOISE_SIZE, nextFrame);
      if (this._disposed) return;
      if (this.blueNoise) this.device.deleteTexture(this.blueNoise);
      this.blueNoise = this.device.createTexture({
        target: gl.TEXTURE_2D,
        width: BLUE_NOISE_SIZE,
        height: BLUE_NOISE_SIZE,
        internalFormat: gl.R8,
        data,
        min: 'nearest',
        mag: 'nearest',
        wrap: 'repeat',
        mips: false,
      });
    } catch (err) {
      console.error('[textures] blue noise generation failed:', err);
    }
  }

  /**
   * Render the Perlin-Worley cloud volume slice by slice.
   * @param {function(number):void} report progress sink, 0..1
   * @returns {Promise<void>} resolves once every slice has been submitted
   * @private
   */
  async _generateCloudNoise(report) {
    const device = this.device;
    const gl = this.raw;
    const size = this.cloudSize;
    try {
      if (!this.cloudNoise) {
        this.cloudNoise = device.createTexture({
          target: gl.TEXTURE_3D,
          width: size,
          height: size,
          depth: size,
          internalFormat: gl.RGBA8,
          min: 'linear',
          mag: 'linear',
          wrap: 'repeat',
          mips: false,
        });
      }
      if (!this._cloudProgram) {
        this._cloudProgram = device.createProgram('cloud-noise', FULLSCREEN_VS, CLOUD_FS);
        if (!this._cloudProgram.use()) {
          console.error('[textures] the cloud-noise shader failed to build.');
          report(1);
          return;
        }
      }
      if (!this._cloudFBO) {
        this._cloudFBO = device.createFramebuffer({
          name: 'cloud-noise',
          width: size,
          height: size,
          color: [{ tex: this.cloudNoise, layer: 0 }],
        });
        if (!this._cloudFBO.complete) {
          console.error('[textures] the cloud-noise framebuffer is incomplete.');
          report(1);
          return;
        }
      }

      device.setDepthTest(false);
      device.setDepthWrite(false);
      device.setCull('none');
      device.setBlend('none');
      const program = this._cloudProgram;
      program.use();
      program.setFloat('u_size', size);

      const budget = new TimeBudget(SLICE_BUDGET_MS);
      budget.start();
      for (let z = 0; z < size; z++) {
        program.setFloat('u_slice', (z + 0.5) / size);
        this._cloudFBO.setColorLayer(0, z);
        this._cloudFBO.bind();
        device.drawFullscreen();
        if (budget.expired() || z === size - 1) {
          gl.flush();
          report((z + 1) / size);
          await nextFrame();
          if (this._disposed) return;
          budget.start();
        }
      }
      device.bindFramebuffer(null);
    } catch (err) {
      console.error('[textures] cloud noise generation failed:', err);
    }
    report(1);
  }

  /* ------------------------------------------------------------------ usage */

  /**
   * Bind the three material arrays to their fixed units 0, 1 and 2
   * (ARCHITECTURE.md 3.5). Samplers that the program does not declare are
   * skipped silently.
   * @param {{setTexture:function(string, WebGLTexture, number, number=):void}} program target program
   * @returns {void}
   */
  bindArrays(program) {
    if (!program || typeof program.setTexture !== 'function') return;
    const target = this.raw.TEXTURE_2D_ARRAY;
    program.setTexture('u_albedoArray', this.albedoArray, UNIT.ALBEDO, target);
    program.setTexture('u_normalArray', this.normalArray, UNIT.NORMAL, target);
    program.setTexture('u_mraeArray', this.mraeArray, UNIT.MRAE, target);
  }

  /**
   * Bind the blue-noise mask (unit 11) and the cloud volume (unit 13).
   * @param {{setTexture:function(string, WebGLTexture, number, number=):void}} program target program
   * @returns {void}
   */
  bindNoise(program) {
    if (!program || typeof program.setTexture !== 'function') return;
    program.setTexture('u_blueNoise', this.blueNoise, UNIT.BLUE_NOISE, this.raw.TEXTURE_2D);
    program.setTexture('u_cloudNoise', this.cloudNoise, UNIT.CLOUD, this.raw.TEXTURE_3D);
  }

  /**
   * Rebuild every texture at a new resolution (called when the setting changes).
   * @param {number} [resolution] new edge size; defaults to `settings.textureResolution`
   * @param {function(number):void} [onProgress] progress sink, 0..1
   * @returns {Promise<boolean>} true when the arrays are usable again
   */
  async regenerate(resolution, onProgress) {
    if (this._disposed) return false;
    const next = this._resolveResolution(
      resolution === undefined ? this._setting('textureResolution', 256) : resolution);
    const nextCloud = this._resolveCloudSize();
    this.ready = false;
    this._releaseArrays();
    if (nextCloud !== this.cloudSize) {
      this._releaseCloud();
      this.cloudSize = nextCloud;
    }
    this.resolution = next;
    this.layerCount = Math.min(MATERIAL_COUNT, Math.max(1, this.device.caps.maxLayers | 0));
    return this.generate(onProgress);
  }

  /* ------------------------------------------------------------------ icons */

  /**
   * Render a small isometric 3D preview of each block using the real generated
   * textures and three-point studio lighting, then read the pixels back as PNG
   * data URLs. Cross / plant / torch blocks render their sprite flat.
   *
   * @param {Iterable<number>} blockIds block ids to draw
   * @param {number} [size=64] icon edge size in pixels
   * @returns {Promise<Map<number,string>>} block id -> `data:image/png;base64,...`
   */
  async renderBlockIcons(blockIds, size = 64) {
    /** @type {Map<number,string>} */
    const out = new Map();
    const ids = Array.from(blockIds || []);
    if (ids.length === 0) return out;
    if (typeof document === 'undefined') {
      console.warn('[textures] renderBlockIcons needs a DOM canvas; returning no icons.');
      return out;
    }
    if (!this.albedoArray && !this._ensureResources()) return out;

    const px = Math.max(16, Math.min(512, size | 0));
    if (!this._ensureIconResources(px)) return out;

    const device = this.device;
    const gl = this.raw;
    const program = this._iconProgram;
    const target = gl.TEXTURE_2D_ARRAY;

    // Classic item-icon framing: yaw 45 degrees, pitch ~30 degrees, orthographic.
    mat4.ortho(this._proj, -0.92, 0.92, -0.92, 0.92, -4, 4);

    device.setDepthTest(true);
    device.setDepthWrite(true);
    device.setDepthFunc(gl.LEQUAL);
    device.setBlend('none');
    program.use();
    program.setTexture('u_albedoArray', this.albedoArray, UNIT.ALBEDO, target);
    program.setTexture('u_normalArray', this.normalArray, UNIT.NORMAL, target);
    program.setTexture('u_mraeArray', this.mraeArray, UNIT.MRAE, target);

    const budget = new TimeBudget(SLICE_BUDGET_MS);
    budget.start();

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] | 0;
      const kind = blockRender(id);
      if (kind === RENDER.NONE && id !== 0) {
        // Still draw a sprite for decorative "no render" blocks so the UI has art.
      }
      const flat = kind === RENDER.CROSS || kind === RENDER.TORCH || kind === RENDER.PANE ||
        kind === RENDER.NONE;
      const def = getBlock(id);
      if (!def || id === 0) continue;

      const tintName = blockTint(id);
      const tint = tintName && ICON_TINTS[tintName] ? ICON_TINTS[tintName] : null;

      for (let f = 0; f < 6; f++) this._layerScratch[f] = faceMaterial(id, f);
      if (flat) for (let f = 0; f < 6; f++) this._layerScratch[f] = faceMaterial(id, 4);

      mat4.identity(this._model);
      if (flat) {
        mat4.scale(this._model, this._model, [0.92, 0.92, 0.92]);
      } else {
        mat4.rotateX(this._model, this._model, 0.5236);
        mat4.rotateY(this._model, this._model, 0.7854);
        mat4.scale(this._model, this._model, [0.55, 0.55, 0.55]);
      }
      mat4.multiply(this._mvp, this._proj, this._model);

      program.setMat4('u_mvp', this._mvp);
      program.setMat4('u_model', this._model);
      program.setFloatArray('u_layers[0]', this._layerScratch);
      program.setVec3('u_tint', tint ? tint[0] : 1, tint ? tint[1] : 1, tint ? tint[2] : 1);
      program.setFloat('u_cutout', flat || def.cutout ? 1 : 0);

      this._iconFBO.bind();
      device.setCull(flat ? 'none' : 'back');
      device.clear([0, 0, 0, 0], true);
      device.bindVertexArray(flat ? this._quadVAO : this._cubeVAO);
      gl.drawElements(gl.TRIANGLES, flat ? 6 : 36, gl.UNSIGNED_SHORT, 0);

      out.set(id, this._readIcon(px));

      if (budget.expired()) { await nextFrame(); if (this._disposed) return out; budget.start(); }
    }

    device.bindVertexArray(null);
    device.bindFramebuffer(null);
    device.setCull('back');
    return out;
  }

  /**
   * Create (or resize) the icon framebuffer, program, meshes and read-back canvas.
   * @param {number} px icon edge size
   * @returns {boolean} true when the icon pipeline is usable
   * @private
   */
  _ensureIconResources(px) {
    const device = this.device;
    const gl = this.raw;
    try {
      if (!this._iconProgram) {
        this._iconProgram = device.createProgram('block-icon', ICON_VS, ICON_FS);
        if (!this._iconProgram.use()) {
          console.error('[textures] the block-icon shader failed to build.');
          return false;
        }
      }
      if (!this._cubeVAO) {
        const cube = buildCubeMesh();
        const quad = buildQuadMesh();
        this._cubeVAO = this._makeIconVAO(cube.vertices, cube.indices);
        this._quadVAO = this._makeIconVAO(quad.vertices, quad.indices);
      }
      if (!this._iconFBO || this._iconSize !== px) {
        if (this._iconFBO) { this._iconFBO.dispose(); this._iconFBO = null; }
        this._iconTexture = device.createTexture({
          target: gl.TEXTURE_2D,
          width: px,
          height: px,
          internalFormat: gl.RGBA8,
          min: 'linear',
          mag: 'linear',
          wrap: 'clamp',
          mips: false,
        });
        this._iconFBO = device.createFramebuffer({
          name: 'block-icon',
          width: px,
          height: px,
          color: [this._iconTexture],
          depth: true,
          ownTextures: true,
        });
        if (!this._iconFBO.complete) {
          console.error('[textures] the block-icon framebuffer is incomplete.');
          return false;
        }
        this._iconSize = px;
        this._iconPixels = new Uint8Array(px * px * 4);
        this._iconCanvas = document.createElement('canvas');
        this._iconCanvas.width = px;
        this._iconCanvas.height = px;
        this._iconCtx = this._iconCanvas.getContext('2d');
      }
      return !!this._iconCtx;
    } catch (err) {
      console.error('[textures] icon resource creation failed:', err);
      return false;
    }
  }

  /**
   * Upload one icon mesh and wrap it in a VAO matching {@link ICON_VS}.
   * @param {Float32Array} vertices interleaved vertex data
   * @param {Uint16Array} indices triangle indices
   * @returns {WebGLVertexArrayObject} the new VAO
   * @private
   */
  _makeIconVAO(vertices, indices) {
    const device = this.device;
    const gl = this.raw;
    const vbo = device.createBuffer(gl.ARRAY_BUFFER, vertices);
    const ibo = device.createBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    this._iconBuffers.push(vbo, ibo);
    const stride = ICON_VERTEX_FLOATS * 4;
    return device.createVertexArray({
      attributes: [
        { location: 0, buffer: vbo, size: 3, type: gl.FLOAT, stride, offset: 0 },
        { location: 1, buffer: vbo, size: 3, type: gl.FLOAT, stride, offset: 12 },
        { location: 2, buffer: vbo, size: 2, type: gl.FLOAT, stride, offset: 24 },
        { location: 3, buffer: vbo, size: 3, type: gl.FLOAT, stride, offset: 32 },
        { location: 4, buffer: vbo, size: 1, type: gl.FLOAT, stride, offset: 44 },
      ],
      indexBuffer: ibo,
      indexType: gl.UNSIGNED_SHORT,
    });
  }

  /**
   * Read the icon framebuffer back and encode it as a PNG data URL.
   * @param {number} px icon edge size
   * @returns {string} `data:image/png;base64,...`
   * @private
   */
  _readIcon(px) {
    const gl = this.raw;
    const pixels = this._iconPixels;
    gl.readPixels(0, 0, px, px, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const image = this._iconCtx.createImageData(px, px);
    const row = px * 4;
    for (let y = 0; y < px; y++) {
      // GL reads bottom-up; ImageData is top-down.
      image.data.set(pixels.subarray((px - 1 - y) * row, (px - y) * row), y * row);
    }
    this._iconCtx.putImageData(image, 0, 0);
    return this._iconCanvas.toDataURL('image/png');
  }

  /* ---------------------------------------------------------------- teardown */

  /**
   * Delete the three arrays and the generator framebuffer/program.
   * @returns {void}
   * @private
   */
  _releaseArrays() {
    const device = this.device;
    if (this._genFBO) { this._genFBO.dispose(); this._genFBO = null; }
    if (this._genProgram) { this._genProgram.dispose(); this._genProgram = null; }
    if (this.albedoArray) { device.deleteTexture(this.albedoArray); this.albedoArray = null; }
    if (this.normalArray) { device.deleteTexture(this.normalArray); this.normalArray = null; }
    if (this.mraeArray) { device.deleteTexture(this.mraeArray); this.mraeArray = null; }
  }

  /**
   * Delete the cloud volume and its framebuffer.
   * @returns {void}
   * @private
   */
  _releaseCloud() {
    if (this._cloudFBO) { this._cloudFBO.dispose(); this._cloudFBO = null; }
    if (this.cloudNoise) { this.device.deleteTexture(this.cloudNoise); this.cloudNoise = null; }
  }

  /**
   * Free every GPU resource this manager owns. Safe to call twice.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.ready = false;
    const device = this.device;
    const gl = this.raw;
    try {
      this._releaseArrays();
      this._releaseCloud();
      if (this._cloudProgram) { this._cloudProgram.dispose(); this._cloudProgram = null; }
      if (this.blueNoise) { device.deleteTexture(this.blueNoise); this.blueNoise = null; }
      if (this._iconFBO) { this._iconFBO.dispose(); this._iconFBO = null; }
      this._iconTexture = null;
      if (this._iconProgram) { this._iconProgram.dispose(); this._iconProgram = null; }
      if (this._cubeVAO) { gl.deleteVertexArray(this._cubeVAO); this._cubeVAO = null; }
      if (this._quadVAO) { gl.deleteVertexArray(this._quadVAO); this._quadVAO = null; }
      for (const buffer of this._iconBuffers) gl.deleteBuffer(buffer);
      this._iconBuffers.length = 0;
      this._iconCanvas = null;
      this._iconCtx = null;
      this._iconPixels = null;
      this._iconSize = 0;
    } catch (err) {
      console.error('[textures] dispose failed:', err);
    }
  }
}

export default TextureManager;
