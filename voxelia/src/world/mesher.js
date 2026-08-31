/**
 * @file VOXELIA section mesher (ARCHITECTURE.md 5.13).
 *
 * Turns one padded 18x18x18 block/light neighbourhood into three interleaved
 * vertex streams (opaque / cutout / water) using the 32-byte terrain vertex of
 * spec 3.1. The module is pure: it never touches `document` or `window`, so it
 * runs unchanged inside `world/worker.js`.
 *
 * ============================================================================
 * WHAT IT DOES
 * ============================================================================
 *  * **Greedy meshing** of full cubes: for every one of the six face
 *    directions the 16x16x16 volume is swept slice by slice; a 16x16 mask of
 *    face descriptors is built and rectangles of *identical* descriptors are
 *    merged. The comparison covers the complete per-vertex tuple — material
 *    layer, material flag byte, output bucket, the four AO bytes, the four
 *    RGBS light quads and the four packed biome tints — so a merged quad can
 *    never introduce a shading seam. The UV of a merged quad is `(w, h)` in
 *    blocks, i.e. the texture tiles once per block.
 *  * **Face culling** against the padded neighbourhood: a face survives when
 *    the neighbour is not opaque. Two transparent blocks of the same kind
 *    (water/water, glass/glass, ice/ice) never produce an interface; leaves
 *    only face other leaves when `fancyLeaves` is on.
 *  * **Vertex ambient occlusion**: the classic `side1 / side2 / corner` rule
 *    with four levels, stored as 0/85/170/255. The quad's triangulation is
 *    flipped when the AO gradient is anisotropic, which removes the well known
 *    diagonal artifact (light level sums break exact ties).
 *  * **Smooth lighting**: every vertex averages the four voxels that touch its
 *    corner on the outside of the face, per channel (R, G, B, Sky), skipping
 *    opaque voxels. `smoothLighting:false` falls back to flat face light.
 *  * **Biome tint**: the padded 18x18 biome plane is turned into a 3x3-blurred
 *    colour field which is then sampled at the four voxels around every vertex
 *    (an effective 4x4 tent filter), so biome borders fade smoothly. Blocks
 *    with `tint === null` get pure white.
 *  * **Render kinds**: CUBE (greedy), CROSS (two double sided diagonal quads
 *    with the waves flag), FLUID (per-corner surface height, top at 14/16
 *    unless covered, no interface between equal fluids), and SLAB / STAIRS /
 *    TORCH / PANE / MODEL built from `blockAABBs()` so partial blocks render
 *    exactly like their collision shape. NONE is skipped.
 *
 * ============================================================================
 * ALLOCATION POLICY
 * ============================================================================
 * Everything the mesher touches per call lives in module level scratch: the
 * greedy masks, the shading scratch, the tint field and the three growable
 * vertex/index buffers. Buffers only ever grow (geometrically, x2) and are
 * reused across calls. The only allocations a call makes are the exact-size
 * `ArrayBuffer`s of the result, produced with `slice()` so they are ready to be
 * transferred to the main thread.
 *
 * @module world/mesher
 */

import {
  RENDER,
  FLAG,
  BLOCKS,
  BLOCK_COUNT,
  FACE_MATERIAL_TABLE,
  FLAG_TABLE,
  blockAABBs,
  isOpaque,
  isSolid,
  isLiquid,
  blockRender,
  blockTint
} from './blocks.js';

import { BIOME_COUNT, biomeGrassColor, biomeFoliageColor, biomeWaterColor } from './biomes.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Size of one terrain vertex in bytes (spec 3.1). Attribute offsets inside the
 * stride are: 0 position (3 x float32), 12 uv (2 x float32), 20 texture layer
 * (uint16, little endian), 22 face direction + AO (2 x uint8), 24 light
 * (4 x uint8 normalized), 28 biome tint rgb + material flag byte
 * (4 x uint8 normalized).
 * @type {number}
 */
export const VERTEX_STRIDE = 32;

/**
 * Index of the opaque output bucket.
 * @type {number}
 */
export const BUCKET_OPAQUE = 0;

/**
 * Index of the alpha-tested (cutout) output bucket.
 * @type {number}
 */
export const BUCKET_CUTOUT = 1;

/**
 * Index of the transparent (water/glass/ice) output bucket.
 * @type {number}
 */
export const BUCKET_WATER = 2;

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

/** Edge length of the padded neighbourhood. @type {number} */
const PAD = 18;
/** Flat index stride along Z inside the padded neighbourhood. @type {number} */
const PAD_Z = PAD;
/** Flat index stride along Y inside the padded neighbourhood. @type {number} */
const PAD_Y = PAD * PAD;
/** Number of voxels in the padded neighbourhood. @type {number} */
const PAD_VOL = PAD * PAD * PAD;
/** Number of biome entries in the padded XZ plane. @type {number} */
const PAD_AREA = PAD * PAD;
/** Edge length of the meshed section. @type {number} */
const SEC = 16;
/** Number of cells in one greedy mask. @type {number} */
const MASK_AREA = SEC * SEC;
/** Vertices per axis of the tint grid (block corners of the section). @type {number} */
const TINT_DIM = SEC + 1;

/** Height of a full fluid surface that is not covered by more fluid. @type {number} */
const FLUID_TOP = 14 / 16;
/** Weight of a full fluid column in the corner-height average (vanilla rule). @type {number} */
const FLUID_WEIGHT = 10;
/** Tolerance used when testing whether a box face is flush with the voxel. @type {number} */
const FLUSH_EPS = 1e-4;
/** Packed white tint (`r | g << 8 | b << 16`). @type {number} */
const WHITE_TINT = 0xffffff;

// Render kinds, hoisted into plain numbers for the hot loops.
/** @type {number} */ const R_CUBE = RENDER.CUBE;
/** @type {number} */ const R_CROSS = RENDER.CROSS;
/** @type {number} */ const R_FLUID = RENDER.FLUID;
/** @type {number} */ const R_NONE = RENDER.NONE;

/** Face direction 0..5 -> normal X. @type {Int8Array} */
const DIR_X = new Int8Array([1, -1, 0, 0, 0, 0]);
/** Face direction 0..5 -> normal Y. @type {Int8Array} */
const DIR_Y = new Int8Array([0, 0, 1, -1, 0, 0]);
/** Face direction 0..5 -> normal Z. @type {Int8Array} */
const DIR_Z = new Int8Array([0, 0, 0, 0, 1, -1]);
/** Face direction 0..5 -> flat neighbour offset in the padded array. @type {Int32Array} */
const DIR_OFFSET = new Int32Array(6);
/** Face direction 0..5 -> flat padded offset of one step along its U axis. @type {Int32Array} */
const U_OFFSET = new Int32Array(6);
/** Face direction 0..5 -> flat padded offset of one step along its V axis. @type {Int32Array} */
const V_OFFSET = new Int32Array(6);
/** Face direction 0..5 -> flat padded offset of one step along its normal axis. @type {Int32Array} */
const N_OFFSET = new Int32Array(6);
/** 1 when the face direction points along a positive axis. @type {Uint8Array} */
const DIR_POSITIVE = new Uint8Array([1, 0, 1, 0, 1, 0]);
/** 1 for the four side directions (their V axis is world Y). @type {Uint8Array} */
const DIR_SIDE = new Uint8Array([1, 1, 0, 0, 1, 1]);

/** In-plane U axis per direction (X component). @type {Int8Array} */
const U_X = new Int8Array([0, 0, 1, 1, 1, 1]);
/** In-plane U axis per direction (Y component). @type {Int8Array} */
const U_Y = new Int8Array([0, 0, 0, 0, 0, 0]);
/** In-plane U axis per direction (Z component). @type {Int8Array} */
const U_Z = new Int8Array([1, 1, 0, 0, 0, 0]);
/** In-plane V axis per direction (X component). @type {Int8Array} */
const V_X = new Int8Array([0, 0, 0, 0, 0, 0]);
/** In-plane V axis per direction (Y component). @type {Int8Array} */
const V_Y = new Int8Array([1, 1, 0, 0, 1, 1]);
/** In-plane V axis per direction (Z component). @type {Int8Array} */
const V_Z = new Int8Array([0, 0, 1, 1, 0, 0]);
/** Normal axis selector per direction (X component). @type {Int8Array} */
const N_X = new Int8Array([1, 1, 0, 0, 0, 0]);
/** Normal axis selector per direction (Y component). @type {Int8Array} */
const N_Y = new Int8Array([0, 0, 1, 1, 0, 0]);
/** Normal axis selector per direction (Z component). @type {Int8Array} */
const N_Z = new Int8Array([0, 0, 0, 0, 1, 1]);

/**
 * Per direction, the U coordinate (0 or 1) of the four quad corners, ordered so
 * that the resulting triangle winding is counter-clockwise seen from outside.
 * @type {Uint8Array}
 */
const CORNER_DU = new Uint8Array([
  1, 0, 0, 1, // +X
  0, 1, 1, 0, // -X
  0, 0, 1, 1, // +Y
  0, 1, 1, 0, // -Y
  0, 1, 1, 0, // +Z
  0, 0, 1, 1 //  -Z
]);

/**
 * Per direction, the V coordinate (0 or 1) of the four quad corners.
 * @type {Uint8Array}
 */
const CORNER_DV = new Uint8Array([
  0, 0, 1, 1, // +X
  0, 0, 1, 1, // -X
  0, 1, 1, 0, // +Y
  0, 0, 1, 1, // -Y
  0, 0, 1, 1, // +Z
  0, 1, 1, 0 //  -Z
]);

/** Ambient occlusion level 0..3 mapped to the stored 0..255 range. @type {Uint8Array} */
const AO_LEVELS = new Uint8Array([0, 85, 170, 255]);

for (let d = 0; d < 6; d++) {
  DIR_OFFSET[d] = DIR_Y[d] * PAD_Y + DIR_Z[d] * PAD_Z + DIR_X[d];
  U_OFFSET[d] = U_Y[d] * PAD_Y + U_Z[d] * PAD_Z + U_X[d];
  V_OFFSET[d] = V_Y[d] * PAD_Y + V_Z[d] * PAD_Z + V_X[d];
  N_OFFSET[d] = N_Y[d] * PAD_Y + N_Z[d] * PAD_Z + N_X[d];
}

// ---------------------------------------------------------------------------
// Block lookup tables (built once at import time)
// ---------------------------------------------------------------------------

/** 1 when the block fully occludes its neighbours. @type {Uint8Array} */
const T_OPAQUE = new Uint8Array(BLOCK_COUNT);
/** 1 when the block has a collision shape (used by the fluid surface rule). @type {Uint8Array} */
const T_SOLID = new Uint8Array(BLOCK_COUNT);
/** `RENDER.*` value per block. @type {Uint8Array} */
const T_RENDER = new Uint8Array(BLOCK_COUNT);
/** Output bucket per block, -1 for blocks that produce no geometry. @type {Int8Array} */
const T_BUCKET = new Int8Array(BLOCK_COUNT);
/** Tint channel per block: 0 none, 1 grass, 2 foliage, 3 water. @type {Uint8Array} */
const T_TINT = new Uint8Array(BLOCK_COUNT);
/** Material flag byte per block (spec 3.1). @type {Uint8Array} */
const T_FLAGS = new Uint8Array(BLOCK_COUNT);
/** 1 for leaf blocks (they follow the `fancyLeaves` culling rule). @type {Uint8Array} */
const T_LEAVES = new Uint8Array(BLOCK_COUNT);
/** Connection family for post-and-arm shapes: 0 none, 1 fence, 2 pane/bars. @type {Uint8Array} */
const T_CONNECT = new Uint8Array(BLOCK_COUNT);

/**
 * Blocks that are drawn with real transparency although they are neither a
 * fluid nor named `*glass*`. Anything else that is merely "not a full opaque
 * cube" (chests, slabs, fences, plants …) is alpha tested instead.
 * @type {Set<string>}
 */
const TRANSLUCENT_NAMES = new Set([
  'ice', 'slime_block', 'honey_block', 'nether_portal', 'end_portal'
]);

/**
 * Decide which of the three output buckets a block belongs to.
 *
 * * Opaque full cubes go to the opaque bucket.
 * * Genuinely see-through blocks — fluids, every `glass` block and the
 *   {@link TRANSLUCENT_NAMES} set (ice, slime, honey, portals) — go to the
 *   water bucket, as required by spec 5.13. Lava is the one exception: it is
 *   light-tight and emissive, so it is drawn with the opaque geometry where the
 *   deferred pass can light it properly instead of through the water shader.
 * * Everything else (leaves, plants, torches, slabs, stairs, fences, panes,
 *   models) is alpha tested and goes to the cutout bucket. Fully opaque cutout
 *   textures simply pass the alpha test, so this is always safe.
 *
 * @param {import('./blocks.js').BlockDef} def block definition
 * @returns {number} `BUCKET_OPAQUE`, `BUCKET_CUTOUT`, `BUCKET_WATER` or -1
 */
function classifyBucket(def) {
  const id = def.id;
  if (id === 0) return -1;
  const render = blockRender(id);
  if (render === R_NONE) return -1;
  if (isOpaque(id)) return BUCKET_OPAQUE;
  if (isLiquid(id)) {
    // Lava: opaque looking and emissive -> deferred opaque geometry.
    return (def.flags & FLAG.EMISSIVE) !== 0 ? BUCKET_OPAQUE : BUCKET_WATER;
  }
  if (def.name.indexOf('glass') !== -1) return BUCKET_WATER;
  if (TRANSLUCENT_NAMES.has(def.name)) return BUCKET_WATER;
  return BUCKET_CUTOUT;
}

for (let id = 0; id < BLOCK_COUNT; id++) {
  const def = BLOCKS[id];
  T_OPAQUE[id] = isOpaque(id) ? 1 : 0;
  T_SOLID[id] = isSolid(id) ? 1 : 0;
  T_RENDER[id] = blockRender(id);
  T_BUCKET[id] = classifyBucket(def);
  T_FLAGS[id] = FLAG_TABLE[id];
  T_LEAVES[id] = def.name.endsWith('_leaves') ? 1 : 0;
  const tint = blockTint(id);
  T_TINT[id] = tint === 'grass' ? 1 : (tint === 'foliage' ? 2 : (tint === 'water' ? 3 : 0));
  if (def.name.endsWith('_fence')) T_CONNECT[id] = 1;
  else if (def.name.endsWith('_pane') || def.name === 'iron_bars') T_CONNECT[id] = 2;
  else T_CONNECT[id] = 0;
}

// ---------------------------------------------------------------------------
// Biome colour tables
// ---------------------------------------------------------------------------

/** Linear grass colour per biome, `id * 3 + channel`. @type {Float32Array} */
const BIOME_GRASS = new Float32Array(BIOME_COUNT * 3);
/** Linear foliage colour per biome, `id * 3 + channel`. @type {Float32Array} */
const BIOME_FOLIAGE = new Float32Array(BIOME_COUNT * 3);
/** Linear water colour per biome, `id * 3 + channel`. @type {Float32Array} */
const BIOME_WATER = new Float32Array(BIOME_COUNT * 3);

for (let b = 0; b < BIOME_COUNT; b++) {
  const g = biomeGrassColor(b);
  const f = biomeFoliageColor(b);
  const w = biomeWaterColor(b);
  BIOME_GRASS[b * 3] = g[0]; BIOME_GRASS[b * 3 + 1] = g[1]; BIOME_GRASS[b * 3 + 2] = g[2];
  BIOME_FOLIAGE[b * 3] = f[0]; BIOME_FOLIAGE[b * 3 + 1] = f[1]; BIOME_FOLIAGE[b * 3 + 2] = f[2];
  BIOME_WATER[b * 3] = w[0]; BIOME_WATER[b * 3 + 1] = w[1]; BIOME_WATER[b * 3 + 2] = w[2];
}

/** Tint channel (1..3) minus one -> colour table. @type {Float32Array[]} */
const TINT_TABLES = [BIOME_GRASS, BIOME_FOLIAGE, BIOME_WATER];

// ---------------------------------------------------------------------------
// Growable output buffers
// ---------------------------------------------------------------------------

/**
 * One growable interleaved vertex + index stream. Capacity only ever grows and
 * is reused across `meshSection()` calls; `reset()` just rewinds the cursors.
 */
class MeshBuffer {
  /**
   * @param {number} vertexCapacity initial capacity in vertices
   * @param {number} indexCapacity initial capacity in indices
   */
  constructor(vertexCapacity, indexCapacity) {
    /** @type {ArrayBuffer} backing store of the interleaved vertices */
    this.data = new ArrayBuffer(vertexCapacity * VERTEX_STRIDE);
    /** @type {Float32Array} float view over {@link MeshBuffer#data} */
    this.f32 = new Float32Array(this.data);
    /** @type {Uint8Array} byte view over {@link MeshBuffer#data} */
    this.u8 = new Uint8Array(this.data);
    /** @type {DataView} explicit-endian view over {@link MeshBuffer#data} */
    this.view = new DataView(this.data);
    /** @type {number} capacity in vertices */
    this.vertexCapacity = vertexCapacity;
    /** @type {number} vertices written so far */
    this.vertexCount = 0;
    /** @type {Uint32Array} index stream */
    this.indices = new Uint32Array(indexCapacity);
    /** @type {number} indices written so far */
    this.indexCount = 0;
  }

  /**
   * Rewind both cursors without releasing memory.
   * @returns {void}
   */
  reset() {
    this.vertexCount = 0;
    this.indexCount = 0;
  }

  /**
   * Make sure `extra` more vertices fit, growing geometrically if needed.
   * @param {number} extra number of additional vertices
   * @returns {void}
   */
  ensureVertices(extra) {
    const needed = this.vertexCount + extra;
    if (needed <= this.vertexCapacity) return;
    let cap = this.vertexCapacity * 2;
    while (cap < needed) cap *= 2;
    const data = new ArrayBuffer(cap * VERTEX_STRIDE);
    const u8 = new Uint8Array(data);
    u8.set(new Uint8Array(this.data, 0, this.vertexCount * VERTEX_STRIDE));
    this.data = data;
    this.f32 = new Float32Array(data);
    this.u8 = u8;
    this.view = new DataView(data);
    this.vertexCapacity = cap;
  }

  /**
   * Make sure `extra` more indices fit, growing geometrically if needed.
   * @param {number} extra number of additional indices
   * @returns {void}
   */
  ensureIndices(extra) {
    const needed = this.indexCount + extra;
    if (needed <= this.indices.length) return;
    let cap = this.indices.length * 2;
    while (cap < needed) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(this.indices.subarray(0, this.indexCount));
    this.indices = next;
  }

  /**
   * Copy the written range out into exact-size, transfer-ready buffers.
   * @returns {{vertices:ArrayBuffer, indices:ArrayBuffer, count:number}} bucket result
   */
  toResult() {
    if (this.indexCount === 0 || this.vertexCount === 0) {
      return { vertices: new ArrayBuffer(0), indices: new ArrayBuffer(0), count: 0 };
    }
    return {
      vertices: this.data.slice(0, this.vertexCount * VERTEX_STRIDE),
      indices: this.indices.buffer.slice(0, this.indexCount * 4),
      count: this.indexCount
    };
  }
}

/**
 * Allocate a reusable scratch set for {@link meshSectionInto}. Give every
 * worker its own instance; a single instance must never be used by two
 * concurrent meshing calls.
 * @returns {{opaque:MeshBuffer, cutout:MeshBuffer, water:MeshBuffer}} scratch buffers
 */
export function createMeshScratch() {
  return {
    opaque: new MeshBuffer(4096, 6144),
    cutout: new MeshBuffer(1024, 1536),
    water: new MeshBuffer(1024, 1536)
  };
}

/** Default scratch used by {@link meshSection}. @type {{opaque:MeshBuffer, cutout:MeshBuffer, water:MeshBuffer}} */
const DEFAULT_SCRATCH = createMeshScratch();

// ---------------------------------------------------------------------------
// Module scratch
// ---------------------------------------------------------------------------

/** Fallback light plane: no block light, full sky. @type {Uint16Array} */
const FALLBACK_LIGHT = new Uint16Array(PAD_VOL).fill(0xf000);
/** Fallback biome plane: everything biome 0. @type {Uint8Array} */
const FALLBACK_BIOMES = new Uint8Array(PAD_AREA);
/** Placeholder block volume held between calls so no input stays referenced. @type {Uint16Array} */
const EMPTY_BLOCKS = new Uint16Array(PAD_VOL);

/** Current padded block ids. @type {Uint16Array} */
let m_blocks = EMPTY_BLOCKS;
/** Current padded packed light. @type {Uint16Array} */
let m_light = FALLBACK_LIGHT;
/** Current padded biome plane. @type {Uint8Array} */
let m_biomes = FALLBACK_BIOMES;
/** Smooth lighting enabled for the current call. @type {boolean} */
let m_smooth = true;
/** Fancy (non-culling) leaves enabled for the current call. @type {boolean} */
let m_fancy = true;
/** Output buffers of the current call. @type {{opaque:MeshBuffer, cutout:MeshBuffer, water:MeshBuffer}} */
let m_out = DEFAULT_SCRATCH;

/** Greedy mask: texture layer per cell, -1 when the cell has no face. @type {Int32Array} */
const mk_layer = new Int32Array(MASK_AREA);
/** Greedy mask: output bucket per cell. @type {Uint8Array} */
const mk_bucket = new Uint8Array(MASK_AREA);
/** Greedy mask: material flag byte per cell. @type {Uint8Array} */
const mk_flags = new Uint8Array(MASK_AREA);
/** Greedy mask: four packed AO bytes per cell. @type {Uint32Array} */
const mk_ao = new Uint32Array(MASK_AREA);
/** Greedy mask: four packed RGBS light words per cell. @type {Uint32Array} */
const mk_light = new Uint32Array(MASK_AREA * 4);
/** Greedy mask: four packed RGB tints per cell. @type {Uint32Array} */
const mk_tint = new Uint32Array(MASK_AREA * 4);

/** Per-corner AO 0..255 of the face currently being shaded. @type {Uint8Array} */
const s_ao = new Uint8Array(4);
/** Per-corner light `[r,g,b,sky]` 0..255 of the face currently being shaded. @type {Uint8Array} */
const s_light = new Uint8Array(16);
/** AO re-indexed by `dv * 2 + du` for bilinear sampling of partial faces. @type {Float32Array} */
const s_aoUV = new Float32Array(4);
/** Light re-indexed by `(dv * 2 + du) * 4 + channel` for partial faces. @type {Float32Array} */
const s_lightUV = new Float32Array(16);

/** Quad corner positions (X). @type {Float32Array} */
const q_x = new Float32Array(4);
/** Quad corner positions (Y). @type {Float32Array} */
const q_y = new Float32Array(4);
/** Quad corner positions (Z). @type {Float32Array} */
const q_z = new Float32Array(4);
/** Quad corner U texture coordinates. @type {Float32Array} */
const q_u = new Float32Array(4);
/** Quad corner V texture coordinates. @type {Float32Array} */
const q_v = new Float32Array(4);
/** Quad corner AO 0..255. @type {Uint8Array} */
const q_ao = new Uint8Array(4);
/** Quad corner light, four bytes per corner. @type {Uint8Array} */
const q_light = new Uint8Array(16);
/** Quad corner packed RGB tint. @type {Uint32Array} */
const q_tint = new Uint32Array(4);

/** Raw per-cell biome colour of the padded plane. @type {Float32Array} */
const s_tintRaw = new Float32Array(PAD_AREA * 3);
/** 3x3 blurred biome colour of the padded plane. @type {Float32Array} */
const s_tintBlur = new Float32Array(PAD_AREA * 3);
/** Packed per-vertex tint grid, one 17x17 grid per tint channel. @type {Uint32Array[]} */
const s_tintGrid = [
  new Uint32Array(TINT_DIM * TINT_DIM),
  new Uint32Array(TINT_DIM * TINT_DIM),
  new Uint32Array(TINT_DIM * TINT_DIM)
];
/** 1 when the matching entry of {@link s_tintGrid} is valid for this call. @type {Uint8Array} */
const s_tintReady = new Uint8Array(3);

/** Fluid corner heights of the voxel being meshed, indexed `cz * 2 + cx`. @type {Float32Array} */
const s_fluidH = new Float32Array(4);

/** Greedy-meshable cubes per X slice of the section. @type {Uint16Array} */
const sc_cubeX = new Uint16Array(SEC);
/** Greedy-meshable cubes per Y slice of the section. @type {Uint16Array} */
const sc_cubeY = new Uint16Array(SEC);
/** Greedy-meshable cubes per Z slice of the section. @type {Uint16Array} */
const sc_cubeZ = new Uint16Array(SEC);
/** Voxels needing a special render path, packed as `y << 8 | z << 4 | x`. @type {Uint16Array} */
const sc_special = new Uint16Array(SEC * SEC * SEC);
/** Number of valid entries in {@link sc_special}. @type {number} */
let sc_specialCount = 0;

/** True once the "bad input" warning has been logged. @type {boolean} */
let warnedInput = false;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a float to the unit interval.
 * @param {number} v value
 * @returns {number} `v` clamped to `[0, 1]`
 */
function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/**
 * Convert a linear 0..1 colour component into a rounded 0..255 byte.
 * @param {number} v linear component
 * @returns {number} byte 0..255
 */
function toByte(v) {
  const n = (v * 255 + 0.5) | 0;
  return n < 0 ? 0 : (n > 255 ? 255 : n);
}

/**
 * Should the face of `id` towards `nid` be emitted?
 *
 * Opaque neighbours always cull. Identical transparent blocks (water/water,
 * glass/glass, ice/ice) never show an interface. Leaves only face other leaves
 * when fancy leaves are enabled.
 *
 * @param {number} id block the face belongs to
 * @param {number} nid neighbouring block id
 * @returns {boolean} true when the face must be emitted
 */
function faceVisible(id, nid) {
  if (T_OPAQUE[nid] === 1) return false;
  if (nid === id) return T_LEAVES[id] === 1 ? m_fancy : false;
  if (T_LEAVES[id] === 1 && T_LEAVES[nid] === 1 && !m_fancy) return false;
  return true;
}

/**
 * Build the packed per-vertex tint grid for one tint channel.
 * @param {number} t tint table index (0 grass, 1 foliage, 2 water)
 * @returns {void}
 */
function buildTintGrid(t) {
  const table = TINT_TABLES[t];
  const raw = s_tintRaw;
  const biomes = m_biomes;
  for (let i = 0; i < PAD_AREA; i++) {
    let bid = biomes[i];
    if (bid === undefined || bid >= BIOME_COUNT) bid = 0;
    const o = i * 3;
    const s = bid * 3;
    raw[o] = table[s];
    raw[o + 1] = table[s + 1];
    raw[o + 2] = table[s + 2];
  }

  // 3x3 box blur with clamped borders: this is what makes biome borders fade.
  const blur = s_tintBlur;
  for (let z = 0; z < PAD; z++) {
    const z0 = z > 0 ? z - 1 : 0;
    const z1 = z < PAD - 1 ? z + 1 : PAD - 1;
    for (let x = 0; x < PAD; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < PAD - 1 ? x + 1 : PAD - 1;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let zz = z0; zz <= z1; zz++) {
        const row = zz * PAD;
        for (let xx = x0; xx <= x1; xx++) {
          const o = (row + xx) * 3;
          r += raw[o];
          g += raw[o + 1];
          b += raw[o + 2];
          n++;
        }
      }
      const o = (z * PAD + x) * 3;
      const inv = 1 / n;
      blur[o] = r * inv;
      blur[o + 1] = g * inv;
      blur[o + 2] = b * inv;
    }
  }

  // Every section vertex averages the four padded cells that touch it.
  const grid = s_tintGrid[t];
  for (let vz = 0; vz < TINT_DIM; vz++) {
    for (let vx = 0; vx < TINT_DIM; vx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < 4; k++) {
        const px = vx + (k & 1);
        const pz = vz + (k >> 1);
        const o = (pz * PAD + px) * 3;
        r += blur[o];
        g += blur[o + 1];
        b += blur[o + 2];
      }
      grid[vz * TINT_DIM + vx] = toByte(r * 0.25) | (toByte(g * 0.25) << 8) | (toByte(b * 0.25) << 16);
    }
  }
  s_tintReady[t] = 1;
}

/**
 * Packed RGB biome tint at one section vertex.
 * @param {number} tint tint channel: 0 none, 1 grass, 2 foliage, 3 water
 * @param {number} vx vertex X in section space, 0..16
 * @param {number} vz vertex Z in section space, 0..16
 * @returns {number} `r | g << 8 | b << 16`
 */
function tintAt(tint, vx, vz) {
  if (tint === 0) return WHITE_TINT;
  const t = tint - 1;
  if (s_tintReady[t] === 0) buildTintGrid(t);
  const x = vx < 0 ? 0 : (vx > SEC ? SEC : vx);
  const z = vz < 0 ? 0 : (vz > SEC ? SEC : vz);
  return s_tintGrid[t][z * TINT_DIM + x];
}

/**
 * Average packed tint of the four corners of one voxel column — used for the
 * box based render kinds, whose vertices sit at fractional positions.
 * @param {number} tint tint channel 0..3
 * @param {number} x0 voxel X in section space
 * @param {number} z0 voxel Z in section space
 * @returns {number} packed `r | g << 8 | b << 16`
 */
function tintOfVoxel(tint, x0, z0) {
  if (tint === 0) return WHITE_TINT;
  const a = tintAt(tint, x0, z0);
  const b = tintAt(tint, x0 + 1, z0);
  const c = tintAt(tint, x0 + 1, z0 + 1);
  const d = tintAt(tint, x0, z0 + 1);
  const r = ((a & 255) + (b & 255) + (c & 255) + (d & 255) + 2) >> 2;
  const g = (((a >> 8) & 255) + ((b >> 8) & 255) + ((c >> 8) & 255) + ((d >> 8) & 255) + 2) >> 2;
  const bl = (((a >> 16) & 255) + ((b >> 16) & 255) + ((c >> 16) & 255) + ((d >> 16) & 255) + 2) >> 2;
  return r | (g << 8) | (bl << 16);
}

/**
 * Compute ambient occlusion and (optionally smooth) light for the four corners
 * of one face into {@link s_ao} / {@link s_light}.
 *
 * The samples all live on the outside of the face: `base` is the voxel the face
 * looks into, `side1`/`side2` are its in-plane neighbours towards the corner and
 * `corner` is the diagonal one. Opaque samples are skipped when averaging light;
 * when both sides are opaque the corner is invisible and ignored.
 *
 * @param {number} pi flat padded index of the source voxel
 * @param {number} dir face direction 0..5
 * @param {boolean} smooth use smooth lighting
 * @param {boolean} occlusion compute AO (false stores fully bright corners)
 * @returns {void}
 */
function faceShading(pi, dir, smooth, occlusion) {
  const blocks = m_blocks;
  const light = m_light;
  const bi = pi + DIR_OFFSET[dir];
  const uOff = U_OFFSET[dir];
  const vOff = V_OFFSET[dir];
  const co = dir * 4;

  if (!smooth) {
    const L = light[bi];
    const r = (L & 15) * 17;
    const g = ((L >> 4) & 15) * 17;
    const b = ((L >> 8) & 15) * 17;
    const sk = ((L >> 12) & 15) * 17;
    for (let c = 0; c < 4; c++) {
      const o = c * 4;
      s_light[o] = r;
      s_light[o + 1] = g;
      s_light[o + 2] = b;
      s_light[o + 3] = sk;
    }
  }

  for (let c = 0; c < 4; c++) {
    const du = CORNER_DU[co + c];
    const dv = CORNER_DV[co + c];
    const so = du === 1 ? uOff : -uOff;
    const to = dv === 1 ? vOff : -vOff;
    const iS = bi + so;
    const iT = bi + to;
    const iC = iS + to;
    const oS = T_OPAQUE[blocks[iS]];
    const oT = T_OPAQUE[blocks[iT]];
    const oC = T_OPAQUE[blocks[iC]];

    if (occlusion) {
      const level = (oS === 1 && oT === 1) ? 0 : 3 - (oS + oT + oC);
      s_ao[c] = AO_LEVELS[level];
    } else {
      s_ao[c] = 255;
    }

    if (!smooth) continue;

    let r = 0;
    let g = 0;
    let b = 0;
    let sk = 0;
    let n = 0;
    if (T_OPAQUE[blocks[bi]] === 0) {
      const L = light[bi];
      r += L & 15; g += (L >> 4) & 15; b += (L >> 8) & 15; sk += (L >> 12) & 15; n++;
    }
    if (oS === 0) {
      const L = light[iS];
      r += L & 15; g += (L >> 4) & 15; b += (L >> 8) & 15; sk += (L >> 12) & 15; n++;
    }
    if (oT === 0) {
      const L = light[iT];
      r += L & 15; g += (L >> 4) & 15; b += (L >> 8) & 15; sk += (L >> 12) & 15; n++;
    }
    if (oC === 0 && !(oS === 1 && oT === 1)) {
      const L = light[iC];
      r += L & 15; g += (L >> 4) & 15; b += (L >> 8) & 15; sk += (L >> 12) & 15; n++;
    }
    const o = c * 4;
    if (n === 0) {
      const L = light[bi];
      s_light[o] = (L & 15) * 17;
      s_light[o + 1] = ((L >> 4) & 15) * 17;
      s_light[o + 2] = ((L >> 8) & 15) * 17;
      s_light[o + 3] = ((L >> 12) & 15) * 17;
    } else {
      const inv = 17 / n;
      s_light[o] = (r * inv + 0.5) | 0;
      s_light[o + 1] = (g * inv + 0.5) | 0;
      s_light[o + 2] = (b * inv + 0.5) | 0;
      s_light[o + 3] = (sk * inv + 0.5) | 0;
    }
  }
}

/**
 * Re-index the result of {@link faceShading} by `(dv * 2 + du)` so partial
 * (box) faces can bilinearly sample it at fractional positions.
 * @param {number} dir face direction 0..5
 * @returns {void}
 */
function shadingToUV(dir) {
  const co = dir * 4;
  for (let c = 0; c < 4; c++) {
    const k = CORNER_DV[co + c] * 2 + CORNER_DU[co + c];
    s_aoUV[k] = s_ao[c];
    const src = c * 4;
    const dst = k * 4;
    s_lightUV[dst] = s_light[src];
    s_lightUV[dst + 1] = s_light[src + 1];
    s_lightUV[dst + 2] = s_light[src + 2];
    s_lightUV[dst + 3] = s_light[src + 3];
  }
}

/**
 * Fill {@link s_ao} / {@link s_light} with the flat light of one voxel and no
 * occlusion. Used for faces that do not touch the voxel boundary.
 * @param {number} pi flat padded index of the voxel
 * @returns {void}
 */
function flatShadingOf(pi) {
  const L = m_light[pi];
  const r = (L & 15) * 17;
  const g = ((L >> 4) & 15) * 17;
  const b = ((L >> 8) & 15) * 17;
  const sk = ((L >> 12) & 15) * 17;
  for (let c = 0; c < 4; c++) {
    s_ao[c] = 255;
    const o = c * 4;
    s_light[o] = r;
    s_light[o + 1] = g;
    s_light[o + 2] = b;
    s_light[o + 3] = sk;
  }
}

/**
 * Output buffer of a bucket index.
 * @param {number} bucket `BUCKET_OPAQUE`, `BUCKET_CUTOUT` or `BUCKET_WATER`
 * @returns {MeshBuffer} the matching growable buffer
 */
function bucketBuffer(bucket) {
  if (bucket === BUCKET_WATER) return m_out.water;
  if (bucket === BUCKET_CUTOUT) return m_out.cutout;
  return m_out.opaque;
}

/**
 * Write the quad currently held in the `q_*` scratch arrays into a bucket.
 *
 * The triangulation is flipped when the AO gradient across the quad is
 * anisotropic (`ao0 + ao2 > ao1 + ao3`), which keeps the split diagonal on the
 * darker pair of corners and removes the classic diagonal artifact. Exact ties
 * are broken with the light sums so smooth lighting gradients behave too.
 *
 * @param {MeshBuffer} buf destination bucket
 * @param {number} layer texture-array layer
 * @param {number} dir face direction byte 0..5
 * @param {number} flags material flag byte (spec 3.1)
 * @returns {void}
 */
function emitQuad(buf, layer, dir, flags) {
  buf.ensureVertices(4);
  buf.ensureIndices(6);
  const base = buf.vertexCount;
  const f32 = buf.f32;
  const u8 = buf.u8;
  const view = buf.view;

  for (let c = 0; c < 4; c++) {
    const off = (base + c) * VERTEX_STRIDE;
    const fo = off >> 2;
    f32[fo] = q_x[c];
    f32[fo + 1] = q_y[c];
    f32[fo + 2] = q_z[c];
    f32[fo + 3] = q_u[c];
    f32[fo + 4] = q_v[c];
    view.setUint16(off + 20, layer, true);
    u8[off + 22] = dir;
    u8[off + 23] = q_ao[c];
    const lo = c * 4;
    u8[off + 24] = q_light[lo];
    u8[off + 25] = q_light[lo + 1];
    u8[off + 26] = q_light[lo + 2];
    u8[off + 27] = q_light[lo + 3];
    const t = q_tint[c];
    u8[off + 28] = t & 255;
    u8[off + 29] = (t >> 8) & 255;
    u8[off + 30] = (t >> 16) & 255;
    u8[off + 31] = flags;
  }
  buf.vertexCount = base + 4;

  const a0 = q_ao[0];
  const a1 = q_ao[1];
  const a2 = q_ao[2];
  const a3 = q_ao[3];
  const diagA = a0 + a2;
  const diagB = a1 + a3;
  let flip;
  if (diagA !== diagB) {
    flip = diagA > diagB;
  } else {
    const l0 = q_light[0] + q_light[1] + q_light[2] + q_light[3];
    const l1 = q_light[4] + q_light[5] + q_light[6] + q_light[7];
    const l2 = q_light[8] + q_light[9] + q_light[10] + q_light[11];
    const l3 = q_light[12] + q_light[13] + q_light[14] + q_light[15];
    flip = (l0 + l2) > (l1 + l3);
  }

  const idx = buf.indices;
  let n = buf.indexCount;
  if (flip) {
    idx[n] = base + 1; idx[n + 1] = base + 2; idx[n + 2] = base + 3;
    idx[n + 3] = base + 1; idx[n + 4] = base + 3; idx[n + 5] = base;
  } else {
    idx[n] = base; idx[n + 1] = base + 1; idx[n + 2] = base + 2;
    idx[n + 3] = base; idx[n + 4] = base + 2; idx[n + 5] = base + 3;
  }
  buf.indexCount = n + 6;
}

/**
 * Reverse the corner order of the quad in the `q_*` scratch arrays, flipping
 * the winding while keeping every per-corner attribute attached to its vertex.
 * @returns {void}
 */
function reverseQuad() {
  for (let a = 0, b = 3; a < b; a++, b--) {
    let f = q_x[a]; q_x[a] = q_x[b]; q_x[b] = f;
    f = q_y[a]; q_y[a] = q_y[b]; q_y[b] = f;
    f = q_z[a]; q_z[a] = q_z[b]; q_z[b] = f;
    f = q_u[a]; q_u[a] = q_u[b]; q_u[b] = f;
    f = q_v[a]; q_v[a] = q_v[b]; q_v[b] = f;
    const ao = q_ao[a]; q_ao[a] = q_ao[b]; q_ao[b] = ao;
    const t = q_tint[a]; q_tint[a] = q_tint[b]; q_tint[b] = t;
    const oa = a * 4;
    const ob = b * 4;
    for (let k = 0; k < 4; k++) {
      const l = q_light[oa + k];
      q_light[oa + k] = q_light[ob + k];
      q_light[ob + k] = l;
    }
  }
}

// ---------------------------------------------------------------------------
// Greedy cube pass
// ---------------------------------------------------------------------------

/**
 * Fill the greedy mask for one slice of one face direction.
 * @param {number} dir face direction 0..5
 * @param {number} slice slice index along the normal axis, 0..15
 * @returns {boolean} true when at least one face was recorded
 */
function buildMask(dir, slice) {
  const blocks = m_blocks;
  const nOff = DIR_OFFSET[dir];
  const uOff = U_OFFSET[dir];
  const vOff = V_OFFSET[dir];
  const ux = U_X[dir]; const uz = U_Z[dir];
  const vx = V_X[dir]; const vz = V_Z[dir];
  const nx = N_X[dir]; const nz = N_Z[dir];
  const plane = DIR_POSITIVE[dir] === 1 ? slice + 1 : slice;
  const co = dir * 4;
  const rowOrigin = PAD_Y + PAD_Z + 1 + N_OFFSET[dir] * slice;
  let any = false;

  mk_layer.fill(-1);

  for (let v = 0; v < SEC; v++) {
    let pi = rowOrigin + vOff * v;
    for (let u = 0; u < SEC; u++, pi += uOff) {
      const id = blocks[pi];
      if (id === 0 || T_RENDER[id] !== R_CUBE) continue;
      const bucket = T_BUCKET[id];
      if (bucket < 0) continue;
      if (!faceVisible(id, blocks[pi + nOff])) continue;

      const n = (v << 4) | u;
      faceShading(pi, dir, m_smooth, true);

      mk_layer[n] = FACE_MATERIAL_TABLE[id * 6 + dir];
      mk_bucket[n] = bucket;
      mk_flags[n] = T_FLAGS[id];
      mk_ao[n] = s_ao[0] | (s_ao[1] << 8) | (s_ao[2] << 16) | (s_ao[3] << 24);

      const base4 = n << 2;
      for (let c = 0; c < 4; c++) {
        const o = c * 4;
        mk_light[base4 + c] = s_light[o] | (s_light[o + 1] << 8)
          | (s_light[o + 2] << 16) | (s_light[o + 3] << 24);
      }

      const tint = T_TINT[id];
      if (tint === 0) {
        mk_tint[base4] = WHITE_TINT;
        mk_tint[base4 + 1] = WHITE_TINT;
        mk_tint[base4 + 2] = WHITE_TINT;
        mk_tint[base4 + 3] = WHITE_TINT;
      } else {
        for (let c = 0; c < 4; c++) {
          const du = CORNER_DU[co + c];
          const dv = CORNER_DV[co + c];
          const uu = u + du;
          const vv = v + dv;
          const cx = ux * uu + vx * vv + nx * plane;
          const cz = uz * uu + vz * vv + nz * plane;
          mk_tint[base4 + c] = tintAt(tint, cx, cz);
        }
      }
      any = true;
    }
  }
  return any;
}

/**
 * Are two mask cells identical in every attribute a merged quad would share?
 * @param {number} a first cell index
 * @param {number} b second cell index
 * @returns {boolean} true when the cells may be merged
 */
function maskEqual(a, b) {
  if (mk_layer[a] !== mk_layer[b]) return false;
  if (mk_bucket[a] !== mk_bucket[b]) return false;
  if (mk_flags[a] !== mk_flags[b]) return false;
  if (mk_ao[a] !== mk_ao[b]) return false;
  const a4 = a << 2;
  const b4 = b << 2;
  for (let i = 0; i < 4; i++) {
    if (mk_light[a4 + i] !== mk_light[b4 + i]) return false;
    if (mk_tint[a4 + i] !== mk_tint[b4 + i]) return false;
  }
  return true;
}

/**
 * Emit one merged rectangle of the greedy mask.
 * @param {number} dir face direction 0..5
 * @param {number} plane coordinate of the face plane along the normal axis
 * @param {number} u0 rectangle origin on the U axis
 * @param {number} v0 rectangle origin on the V axis
 * @param {number} w rectangle width in blocks
 * @param {number} h rectangle height in blocks
 * @param {number} n mask index of the rectangle's origin cell
 * @returns {void}
 */
function emitMaskQuad(dir, plane, u0, v0, w, h, n) {
  const ux = U_X[dir]; const uy = U_Y[dir]; const uz = U_Z[dir];
  const vx = V_X[dir]; const vy = V_Y[dir]; const vz = V_Z[dir];
  const nx = N_X[dir]; const ny = N_Y[dir]; const nz = N_Z[dir];
  const side = DIR_SIDE[dir] === 1;
  const co = dir * 4;
  const base4 = n << 2;
  const ao = mk_ao[n];

  for (let c = 0; c < 4; c++) {
    const du = CORNER_DU[co + c];
    const dv = CORNER_DV[co + c];
    const uu = u0 + du * w;
    const vv = v0 + dv * h;
    q_x[c] = ux * uu + vx * vv + nx * plane;
    q_y[c] = uy * uu + vy * vv + ny * plane;
    q_z[c] = uz * uu + vz * vv + nz * plane;
    q_u[c] = du * w;
    q_v[c] = side ? (1 - dv) * h : dv * h;
    q_ao[c] = (ao >>> (c * 8)) & 255;
    const L = mk_light[base4 + c];
    const o = c * 4;
    q_light[o] = L & 255;
    q_light[o + 1] = (L >>> 8) & 255;
    q_light[o + 2] = (L >>> 16) & 255;
    q_light[o + 3] = (L >>> 24) & 255;
    q_tint[c] = mk_tint[base4 + c];
  }
  emitQuad(bucketBuffer(mk_bucket[n]), mk_layer[n], dir, mk_flags[n]);
}

/**
 * Greedily merge and emit the rectangles of the current mask.
 * @param {number} dir face direction 0..5
 * @param {number} slice slice index along the normal axis, 0..15
 * @returns {void}
 */
function emitMask(dir, slice) {
  const plane = DIR_POSITIVE[dir] === 1 ? slice + 1 : slice;
  for (let v = 0; v < SEC; v++) {
    for (let u = 0; u < SEC;) {
      const n = (v << 4) | u;
      if (mk_layer[n] < 0) { u++; continue; }

      let w = 1;
      while (u + w < SEC && maskEqual(n, n + w)) w++;

      let h = 1;
      grow: while (v + h < SEC) {
        const row = ((v + h) << 4) | u;
        for (let k = 0; k < w; k++) {
          if (!maskEqual(n, row + k)) break grow;
        }
        h++;
      }

      emitMaskQuad(dir, plane, u, v, w, h, n);

      for (let l = 0; l < h; l++) {
        const row = ((v + l) << 4) | u;
        for (let k = 0; k < w; k++) mk_layer[row + k] = -1;
      }
      u += w;
    }
  }
}

/**
 * Run the greedy cube pass over all six directions.
 * @returns {void}
 */
function meshCubes() {
  for (let dir = 0; dir < 6; dir++) {
    const counts = dir < 2 ? sc_cubeX : (dir < 4 ? sc_cubeY : sc_cubeZ);
    for (let slice = 0; slice < SEC; slice++) {
      if (counts[slice] === 0) continue;
      if (buildMask(dir, slice)) emitMask(dir, slice);
    }
  }
}

// ---------------------------------------------------------------------------
// Cross models
// ---------------------------------------------------------------------------

/**
 * Fill the quad scratch with one diagonal plane of a cross model.
 * @param {number} ax section X of the first (bottom) corner
 * @param {number} y0 section Y of the voxel
 * @param {number} az section Z of the first corner
 * @param {number} bx section X of the second corner
 * @param {number} bz section Z of the second corner
 * @param {number} tintA packed tint of the first corner column
 * @param {number} tintB packed tint of the second corner column
 * @returns {void}
 */
function setCrossPlane(ax, y0, az, bx, bz, tintA, tintB) {
  q_x[0] = ax; q_y[0] = y0; q_z[0] = az; q_u[0] = 0; q_v[0] = 1; q_tint[0] = tintA;
  q_x[1] = bx; q_y[1] = y0; q_z[1] = bz; q_u[1] = 1; q_v[1] = 1; q_tint[1] = tintB;
  q_x[2] = bx; q_y[2] = y0 + 1; q_z[2] = bz; q_u[2] = 1; q_v[2] = 0; q_tint[2] = tintB;
  q_x[3] = ax; q_y[3] = y0 + 1; q_z[3] = az; q_u[3] = 0; q_v[3] = 0; q_tint[3] = tintA;
}

/**
 * Emit a plant style cross model: two diagonal planes, each one double sided.
 * The waves flag is forced on so the vertex shader can sway the foliage, and
 * the face direction byte is `+Y` which gives plants the soft upward normal
 * they need for foliage subsurface lighting.
 * @param {number} id block id
 * @param {number} x0 section X of the voxel, 0..15
 * @param {number} y0 section Y of the voxel, 0..15
 * @param {number} z0 section Z of the voxel, 0..15
 * @param {number} pi flat padded index of the voxel
 * @returns {void}
 */
function emitCross(id, x0, y0, z0, pi) {
  const bucket = T_BUCKET[id];
  if (bucket < 0) return;
  const buf = bucketBuffer(bucket);
  const layer = FACE_MATERIAL_TABLE[id * 6];
  const flags = (T_FLAGS[id] | FLAG.WAVES) & 255;

  flatShadingOf(pi);
  for (let c = 0; c < 4; c++) {
    const o = c * 4;
    q_light[o] = s_light[o];
    q_light[o + 1] = s_light[o + 1];
    q_light[o + 2] = s_light[o + 2];
    q_light[o + 3] = s_light[o + 3];
    q_ao[c] = 255;
  }

  const tint = T_TINT[id];
  const t00 = tintAt(tint, x0, z0);
  const t10 = tintAt(tint, x0 + 1, z0);
  const t11 = tintAt(tint, x0 + 1, z0 + 1);
  const t01 = tintAt(tint, x0, z0 + 1);

  setCrossPlane(x0, y0, z0, x0 + 1, z0 + 1, t00, t11);
  emitQuad(buf, layer, 2, flags);
  reverseQuad();
  emitQuad(buf, layer, 2, flags);

  setCrossPlane(x0 + 1, y0, z0, x0, z0 + 1, t10, t01);
  emitQuad(buf, layer, 2, flags);
  reverseQuad();
  emitQuad(buf, layer, 2, flags);
}

// ---------------------------------------------------------------------------
// Fluids
// ---------------------------------------------------------------------------

/**
 * Height of one corner of a fluid surface, averaged over the four columns that
 * touch it. A column covered by more of the same fluid forces a full block
 * height; empty (non solid) columns pull the corner down, solid ones do not
 * contribute at all. Full fluid columns carry ten times the weight, so a
 * shoreline only droops slightly instead of collapsing.
 *
 * @param {number} id fluid block id
 * @param {number} pi flat padded index of the fluid voxel
 * @param {number} cx corner offset along X, 0 or 1
 * @param {number} cz corner offset along Z, 0 or 1
 * @returns {number} surface height in blocks, 0..1
 */
function fluidCornerHeight(id, pi, cx, cz) {
  const blocks = m_blocks;
  const base = pi + (cx - 1) + (cz - 1) * PAD_Z;
  let sum = 0;
  let count = 0;
  for (let k = 0; k < 4; k++) {
    const i = base + (k & 1) + (k >> 1) * PAD_Z;
    if (blocks[i + PAD_Y] === id) return 1;
    const nid = blocks[i];
    if (nid === id) {
      sum += FLUID_TOP * FLUID_WEIGHT;
      count += FLUID_WEIGHT;
    } else if (T_SOLID[nid] === 0) {
      count += 1;
    }
  }
  if (count === 0) return FLUID_TOP;
  return sum / count;
}

/**
 * Emit the surface of one fluid voxel: a per-corner-height top face (lowered to
 * 14/16 unless another fluid sits on top), a bottom face and the four side
 * faces, each skipped against the same fluid or an opaque neighbour. Fluid
 * quads always carry the waves flag so the shader can animate their UVs.
 *
 * @param {number} id fluid block id
 * @param {number} x0 section X of the voxel, 0..15
 * @param {number} y0 section Y of the voxel, 0..15
 * @param {number} z0 section Z of the voxel, 0..15
 * @param {number} pi flat padded index of the voxel
 * @returns {void}
 */
function emitFluid(id, x0, y0, z0, pi) {
  const bucket = T_BUCKET[id];
  if (bucket < 0) return;
  const blocks = m_blocks;
  const buf = bucketBuffer(bucket);
  const flags = (T_FLAGS[id] | FLAG.WAVES) & 255;
  const tint = T_TINT[id];

  s_fluidH[0] = fluidCornerHeight(id, pi, 0, 0);
  s_fluidH[1] = fluidCornerHeight(id, pi, 1, 0);
  s_fluidH[2] = fluidCornerHeight(id, pi, 0, 1);
  s_fluidH[3] = fluidCornerHeight(id, pi, 1, 1);

  // --- top face -----------------------------------------------------------
  const above = blocks[pi + PAD_Y];
  if (above !== id && T_OPAQUE[above] === 0) {
    const layer = FACE_MATERIAL_TABLE[id * 6 + 2];
    faceShading(pi, 2, m_smooth, false);
    const co = 2 * 4;
    for (let c = 0; c < 4; c++) {
      const du = CORNER_DU[co + c];
      const dv = CORNER_DV[co + c];
      q_x[c] = x0 + du;
      q_z[c] = z0 + dv;
      q_y[c] = y0 + s_fluidH[dv * 2 + du];
      q_u[c] = du;
      q_v[c] = dv;
      q_ao[c] = 255;
      const o = c * 4;
      q_light[o] = s_light[o];
      q_light[o + 1] = s_light[o + 1];
      q_light[o + 2] = s_light[o + 2];
      q_light[o + 3] = s_light[o + 3];
      q_tint[c] = tintAt(tint, x0 + du, z0 + dv);
    }
    emitQuad(buf, layer, 2, flags);
  }

  // --- bottom face --------------------------------------------------------
  const below = blocks[pi - PAD_Y];
  if (below !== id && T_OPAQUE[below] === 0) {
    const layer = FACE_MATERIAL_TABLE[id * 6 + 3];
    faceShading(pi, 3, m_smooth, false);
    const co = 3 * 4;
    for (let c = 0; c < 4; c++) {
      const du = CORNER_DU[co + c];
      const dv = CORNER_DV[co + c];
      q_x[c] = x0 + du;
      q_y[c] = y0;
      q_z[c] = z0 + dv;
      q_u[c] = du;
      q_v[c] = dv;
      q_ao[c] = 255;
      const o = c * 4;
      q_light[o] = s_light[o];
      q_light[o + 1] = s_light[o + 1];
      q_light[o + 2] = s_light[o + 2];
      q_light[o + 3] = s_light[o + 3];
      q_tint[c] = tintAt(tint, x0 + du, z0 + dv);
    }
    emitQuad(buf, layer, 3, flags);
  }

  // --- side faces ---------------------------------------------------------
  for (let s = 0; s < 4; s++) {
    const dir = s === 0 ? 0 : (s === 1 ? 1 : (s === 2 ? 4 : 5));
    const nid = blocks[pi + DIR_OFFSET[dir]];
    if (nid === id || T_OPAQUE[nid] === 1) continue;
    const layer = FACE_MATERIAL_TABLE[id * 6 + dir];
    faceShading(pi, dir, m_smooth, false);
    const co = dir * 4;
    const alongX = dir === 0 || dir === 1;
    const fixed = (dir === 0 || dir === 4) ? 1 : 0;
    const plane = alongX ? x0 + fixed : z0 + fixed;
    for (let c = 0; c < 4; c++) {
      const du = CORNER_DU[co + c];
      const dv = CORNER_DV[co + c];
      const cx = alongX ? fixed : du;
      const cz = alongX ? du : fixed;
      const height = s_fluidH[cz * 2 + cx];
      if (alongX) {
        q_x[c] = plane;
        q_z[c] = z0 + du;
      } else {
        q_x[c] = x0 + du;
        q_z[c] = plane;
      }
      q_y[c] = dv === 1 ? y0 + height : y0;
      q_u[c] = du;
      q_v[c] = dv === 1 ? 1 - height : 1;
      q_ao[c] = 255;
      const o = c * 4;
      q_light[o] = s_light[o];
      q_light[o + 1] = s_light[o + 1];
      q_light[o + 2] = s_light[o + 2];
      q_light[o + 3] = s_light[o + 3];
      q_tint[c] = tintAt(tint, x0 + cx, z0 + cz);
    }
    emitQuad(buf, layer, dir, flags);
  }
}

// ---------------------------------------------------------------------------
// Box models (slabs, stairs, torches, panes, fences, misc models)
// ---------------------------------------------------------------------------

/** Fallback shape for model blocks that declare no boxes at all. @type {number[][]} */
const FULL_BOX_LIST = [[0, 0, 0, 1, 1, 1]];

/**
 * Does a post-and-arm block connect towards `nid`?
 * @param {number} id the block itself
 * @param {number} nid the neighbour
 * @returns {boolean} true when an arm must be built
 */
function connectsTo(id, nid) {
  if (nid === id) return true;
  if (T_OPAQUE[nid] === 1) return true;
  const family = T_CONNECT[id];
  return family !== 0 && T_CONNECT[nid] === family;
}

/**
 * Block state to use when asking `blockAABBs()` for a shape. The mesher only
 * sees block ids, so the state is reconstructed where it is visually essential:
 * fences, glass panes and iron bars derive their four connection bits from the
 * neighbourhood. Everything else uses state 0 (bottom slab, +X stairs,
 * standing torch, closed door …).
 * @param {number} id block id
 * @param {number} pi flat padded index of the voxel
 * @returns {number} block state for `blockAABBs`
 */
function shapeState(id, pi) {
  if (T_CONNECT[id] === 0) return 0;
  const blocks = m_blocks;
  let state = 0;
  if (connectsTo(id, blocks[pi + DIR_OFFSET[0]])) state |= 1;
  if (connectsTo(id, blocks[pi + DIR_OFFSET[1]])) state |= 2;
  if (connectsTo(id, blocks[pi + DIR_OFFSET[4]])) state |= 4;
  if (connectsTo(id, blocks[pi + DIR_OFFSET[5]])) state |= 8;
  return state;
}

/**
 * Emit the six faces of every collision box of a partial block, so slabs,
 * stairs, torches, panes, fences and the generic model blocks all render
 * exactly as their shape describes.
 *
 * Faces flush with the voxel boundary are culled against opaque neighbours and
 * against the same block (which is what makes a pane wall or a slab run look
 * right) and receive the full smooth-lit, ambient-occluded shading of the
 * neighbouring cell, bilinearly sampled at the box's own extents. Interior
 * faces are always emitted and use the voxel's own light without occlusion.
 *
 * @param {number} id block id
 * @param {number} x0 section X of the voxel, 0..15
 * @param {number} y0 section Y of the voxel, 0..15
 * @param {number} z0 section Z of the voxel, 0..15
 * @param {number} pi flat padded index of the voxel
 * @returns {void}
 */
function emitBoxes(id, x0, y0, z0, pi) {
  const bucket = T_BUCKET[id];
  if (bucket < 0) return;
  const buf = bucketBuffer(bucket);
  const flags = T_FLAGS[id];
  const tint = tintOfVoxel(T_TINT[id], x0, z0);
  const blocks = m_blocks;

  let list = blockAABBs(id, shapeState(id, pi));
  if (list.length === 0) list = FULL_BOX_LIST;

  for (let b = 0; b < list.length; b++) {
    const box = list[b];
    const bx0 = clamp01(box[0]);
    const by0 = clamp01(box[1]);
    const bz0 = clamp01(box[2]);
    const bx1 = clamp01(box[3]);
    const by1 = clamp01(box[4]);
    const bz1 = clamp01(box[5]);
    if (bx1 <= bx0 || by1 <= by0 || bz1 <= bz0) continue;

    for (let dir = 0; dir < 6; dir++) {
      let flush;
      let plane;
      let uMin;
      let uMax;
      let vMin;
      let vMax;
      switch (dir) {
        case 0:
          flush = bx1 >= 1 - FLUSH_EPS; plane = bx1;
          uMin = bz0; uMax = bz1; vMin = by0; vMax = by1; break;
        case 1:
          flush = bx0 <= FLUSH_EPS; plane = bx0;
          uMin = bz0; uMax = bz1; vMin = by0; vMax = by1; break;
        case 2:
          flush = by1 >= 1 - FLUSH_EPS; plane = by1;
          uMin = bx0; uMax = bx1; vMin = bz0; vMax = bz1; break;
        case 3:
          flush = by0 <= FLUSH_EPS; plane = by0;
          uMin = bx0; uMax = bx1; vMin = bz0; vMax = bz1; break;
        case 4:
          flush = bz1 >= 1 - FLUSH_EPS; plane = bz1;
          uMin = bx0; uMax = bx1; vMin = by0; vMax = by1; break;
        default:
          flush = bz0 <= FLUSH_EPS; plane = bz0;
          uMin = bx0; uMax = bx1; vMin = by0; vMax = by1; break;
      }

      if (flush) {
        const nid = blocks[pi + DIR_OFFSET[dir]];
        if (T_OPAQUE[nid] === 1 || nid === id) continue;
        faceShading(pi, dir, m_smooth, true);
        shadingToUV(dir);
      } else {
        flatShadingOf(pi);
        shadingToUV(dir);
      }

      const ux = U_X[dir]; const uy = U_Y[dir]; const uz = U_Z[dir];
      const vx = V_X[dir]; const vy = V_Y[dir]; const vz = V_Z[dir];
      const nx = N_X[dir]; const ny = N_Y[dir]; const nz = N_Z[dir];
      const side = DIR_SIDE[dir] === 1;
      const co = dir * 4;

      for (let c = 0; c < 4; c++) {
        const du = CORNER_DU[co + c];
        const dv = CORNER_DV[co + c];
        const uu = du === 1 ? uMax : uMin;
        const vv = dv === 1 ? vMax : vMin;
        q_x[c] = x0 + ux * uu + vx * vv + nx * plane;
        q_y[c] = y0 + uy * uu + vy * vv + ny * plane;
        q_z[c] = z0 + uz * uu + vz * vv + nz * plane;
        q_u[c] = uu;
        q_v[c] = side ? 1 - vv : vv;
        q_tint[c] = tint;

        // Bilinear sample of the voxel-corner shading at the box's extents.
        const w00 = (1 - uu) * (1 - vv);
        const w10 = uu * (1 - vv);
        const w01 = (1 - uu) * vv;
        const w11 = uu * vv;
        let a = s_aoUV[0] * w00 + s_aoUV[1] * w10 + s_aoUV[2] * w01 + s_aoUV[3] * w11;
        a = (a + 0.5) | 0;
        q_ao[c] = a < 0 ? 0 : (a > 255 ? 255 : a);
        const o = c * 4;
        for (let k = 0; k < 4; k++) {
          let l = s_lightUV[k] * w00 + s_lightUV[4 + k] * w10
            + s_lightUV[8 + k] * w01 + s_lightUV[12 + k] * w11;
          l = (l + 0.5) | 0;
          q_light[o + k] = l < 0 ? 0 : (l > 255 ? 255 : l);
        }
      }
      emitQuad(buf, FACE_MATERIAL_TABLE[id * 6 + dir], dir, flags);
    }
  }
}

// ---------------------------------------------------------------------------
// Non-cube pass
// ---------------------------------------------------------------------------

/**
 * Walk the 16x16x16 interior and emit everything the greedy cube pass skipped.
 * @returns {void}
 */
function meshSpecials() {
  const blocks = m_blocks;
  for (let k = 0; k < sc_specialCount; k++) {
    const packed = sc_special[k];
    const x = packed & 15;
    const z = (packed >> 4) & 15;
    const y = (packed >> 8) & 15;
    const pi = (y + 1) * PAD_Y + (z + 1) * PAD_Z + (x + 1);
    const id = blocks[pi];
    const render = T_RENDER[id];
    if (render === R_CROSS) emitCross(id, x, y, z, pi);
    else if (render === R_FLUID) emitFluid(id, x, y, z, pi);
    else emitBoxes(id, x, y, z, pi);
  }
}

/**
 * Single pre-pass over the section interior: counts the greedy-meshable cubes
 * per slice on each axis (so completely empty slices cost nothing later) and
 * records every voxel that needs one of the special render paths.
 * @returns {void}
 */
function scanSection() {
  const blocks = m_blocks;
  sc_cubeX.fill(0);
  sc_cubeY.fill(0);
  sc_cubeZ.fill(0);
  sc_specialCount = 0;
  for (let y = 0; y < SEC; y++) {
    for (let z = 0; z < SEC; z++) {
      let pi = (y + 1) * PAD_Y + (z + 1) * PAD_Z + 1;
      for (let x = 0; x < SEC; x++, pi++) {
        const id = blocks[pi];
        if (id === 0) continue;
        if (T_BUCKET[id] < 0) continue;
        if (T_RENDER[id] === R_CUBE) {
          sc_cubeX[x]++;
          sc_cubeY[y]++;
          sc_cubeZ[z]++;
        } else {
          sc_special[sc_specialCount++] = (y << 8) | (z << 4) | x;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Validate and latch the mesher input into the module scratch.
 * @param {{blocks:Uint16Array, light?:Uint16Array, biomes?:Uint8Array,
 *   sy?:number, smoothLighting?:boolean, fancyLeaves?:boolean}} input mesh job
 * @returns {boolean} false when the input cannot be meshed
 */
function bindInput(input) {
  if (!input || !input.blocks || input.blocks.length < PAD_VOL) {
    if (!warnedInput) {
      warnedInput = true;
      console.warn('[mesher] meshSection called without a padded 18x18x18 block array');
    }
    return false;
  }
  m_blocks = input.blocks;
  m_light = (input.light && input.light.length >= PAD_VOL) ? input.light : FALLBACK_LIGHT;
  m_biomes = (input.biomes && input.biomes.length >= PAD_AREA) ? input.biomes : FALLBACK_BIOMES;
  m_smooth = input.smoothLighting !== false;
  m_fancy = input.fancyLeaves !== false;
  s_tintReady[0] = 0;
  s_tintReady[1] = 0;
  s_tintReady[2] = 0;
  return true;
}

/**
 * An empty bucket result. A fresh zero-length buffer is handed out every time so
 * the caller can transfer it without ever detaching a shared object.
 * @returns {{vertices:ArrayBuffer, indices:ArrayBuffer, count:number}} empty bucket
 */
function emptyBucket() {
  return { vertices: new ArrayBuffer(0), indices: new ArrayBuffer(0), count: 0 };
}

/**
 * Mesh one section into caller-owned scratch buffers.
 *
 * Identical to {@link meshSection} except that the growable intermediate
 * buffers are supplied by the caller, which lets a worker keep one set alive
 * for its whole lifetime. The returned `ArrayBuffer`s are exact-size copies, so
 * the scratch stays owned by the caller and can be reused immediately.
 *
 * @param {{blocks:Uint16Array, light:Uint16Array, biomes:Uint8Array, sy:number,
 *   smoothLighting:boolean, fancyLeaves:boolean}} input padded mesh job
 * @param {{opaque:MeshBuffer, cutout:MeshBuffer, water:MeshBuffer}} [scratch]
 *   buffers from {@link createMeshScratch}; the module default is used when omitted
 * @returns {{opaque:{vertices:ArrayBuffer, indices:ArrayBuffer, count:number},
 *   cutout:{vertices:ArrayBuffer, indices:ArrayBuffer, count:number},
 *   water:{vertices:ArrayBuffer, indices:ArrayBuffer, count:number}}}
 *   one bucket per render pass; `count` is the index count to draw
 */
export function meshSectionInto(input, scratch) {
  if (!bindInput(input)) {
    return { opaque: emptyBucket(), cutout: emptyBucket(), water: emptyBucket() };
  }
  m_out = scratch && scratch.opaque && scratch.cutout && scratch.water ? scratch : DEFAULT_SCRATCH;
  m_out.opaque.reset();
  m_out.cutout.reset();
  m_out.water.reset();

  scanSection();
  meshCubes();
  meshSpecials();

  const result = {
    opaque: m_out.opaque.toResult(),
    cutout: m_out.cutout.toResult(),
    water: m_out.water.toResult()
  };
  // Drop the references to the caller's arrays so a transferred job can be
  // collected (and can never be read by a later call).
  m_blocks = EMPTY_BLOCKS;
  m_light = FALLBACK_LIGHT;
  m_biomes = FALLBACK_BIOMES;
  m_out = DEFAULT_SCRATCH;
  return result;
}

/**
 * Mesh one 16x16x16 section from its padded neighbourhood (spec 5.13).
 *
 * Pure and worker safe. `blocks` and `light` are indexed `((y * 18) + z) * 18 + x`
 * with `x, y, z` in `0..17`, mapping to section offsets `-1..16`; `biomes` is
 * indexed `z * 18 + x` over the same padded range.
 *
 * @param {{blocks:Uint16Array, light:Uint16Array, biomes:Uint8Array, sy:number,
 *   smoothLighting:boolean, fancyLeaves:boolean}} input padded mesh job
 * @returns {{opaque:{vertices:ArrayBuffer, indices:ArrayBuffer, count:number},
 *   cutout:{vertices:ArrayBuffer, indices:ArrayBuffer, count:number},
 *   water:{vertices:ArrayBuffer, indices:ArrayBuffer, count:number}}}
 *   the three render buckets; empty buffers and `count === 0` when a bucket is unused
 */
export function meshSection(input) {
  return meshSectionInto(input, DEFAULT_SCRATCH);
}

/**
 * Cheap upper-bound estimate of the geometry one section will produce, without
 * building it. Useful for pre-sizing pools and for telemetry; the greedy pass
 * usually collapses cube faces to a fraction of `quads`.
 *
 * @param {{blocks:Uint16Array, fancyLeaves?:boolean}} input padded mesh job
 * @returns {{quads:number, vertices:number, indices:number, vertexBytes:number,
 *   indexBytes:number, bytes:number}} conservative size estimate in quads and bytes
 */
export function estimateBufferSize(input) {
  let quads = 0;
  if (input && input.blocks && input.blocks.length >= PAD_VOL) {
    const blocks = input.blocks;
    const fancy = input.fancyLeaves !== false;
    for (let y = 0; y < SEC; y++) {
      for (let z = 0; z < SEC; z++) {
        const rowBase = (y + 1) * PAD_Y + (z + 1) * PAD_Z + 1;
        for (let x = 0; x < SEC; x++) {
          const pi = rowBase + x;
          const id = blocks[pi];
          if (id === 0) continue;
          const render = T_RENDER[id];
          if (render === R_NONE || T_BUCKET[id] < 0) continue;
          if (render === R_CROSS) { quads += 4; continue; }
          if (render === R_CUBE || render === R_FLUID) {
            for (let d = 0; d < 6; d++) {
              const nid = blocks[pi + DIR_OFFSET[d]];
              if (T_OPAQUE[nid] === 1) continue;
              if (nid === id && !(render === R_CUBE && T_LEAVES[id] === 1 && fancy)) continue;
              quads++;
            }
            continue;
          }
          const list = blockAABBs(id, 0);
          quads += 6 * (list.length === 0 ? 1 : list.length);
        }
      }
    }
  }
  const vertices = quads * 4;
  const indices = quads * 6;
  const vertexBytes = vertices * VERTEX_STRIDE;
  const indexBytes = indices * 4;
  return { quads, vertices, indices, vertexBytes, indexBytes, bytes: vertexBytes + indexBytes };
}
