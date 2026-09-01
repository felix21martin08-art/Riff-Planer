/**
 * VOXELIA — `world/netherworldgen.js`
 *
 * A `WorldGenerator`-compatible generator for the **Nether** dimension. The
 * public surface is byte-for-byte the one `world/worldgen.js` exposes
 * (`generateChunk`, `getBiomeAt`, `getHeightAt`, `getWaterLevelAt`,
 * `takePendingEdits`, `clearCache`, `dispose`), so `world/world.js` and
 * `world/worker.js` can drive it without knowing which dimension they are in.
 *
 * ## What it produces
 *
 * 1. **A closed cavern world.** Everything lives between a rough bedrock floor
 *    (`y 0..4`) and a rough bedrock ceiling (`y 123..127`). The rock in
 *    between is carved from a 3D density field evaluated on a `4 x 4 x 4` cell
 *    grid and trilinearly interpolated, exactly like the overworld generator.
 *    Two independent "openness" fields decide where the field opens into vast
 *    caverns and where it stays dense rock; a pair of iso-surface tunnels
 *    (`a^2 + b^2 < r^2`) threads connecting passages through the dense parts,
 *    including holes in the ceiling that lavafalls pour through. Because the
 *    field is genuinely 3D, cliffs, overhangs and stacked cavern levels come
 *    out for free.
 * 2. **A lava sea** at `y 31`: every open voxel at or below that height is
 *    lava. The floor closure keeps the rock solid below `y ~18`, so the sea is
 *    a real, connected body rather than a bottomless drop.
 * 3. **Five biome-like regions** picked from three low-frequency 2D fields:
 *    nether wastes, soul sand valley, crimson forest, warped forest and
 *    basalt deltas. Each has its own surface rule, its own decoration set and
 *    its own huge-fungus / column / fossil features.
 * 4. **Ore**: nether quartz, nether gold and — deep and rare — ancient debris.
 * 5. **Decoration**: glowstone clusters hanging from ceilings, magma along the
 *    lava shoreline, soul fire in the soul sand valley, basalt columns in the
 *    deltas and lavafalls from the ceiling.
 * 6. **A fortress**: nether-brick corridors, bridges over the lava sea with
 *    railings and support piers, a blaze spawner room and loot chests.
 *
 * ## Determinism and chunk borders
 *
 * Identical to `world/worldgen.js`. Small features (fungi, columns, glowstone,
 * lavafalls, scatter) are generated for the **3x3 chunk neighbourhood** and
 * clipped to the chunk being built, so a fungus never loses half its cap. The
 * fortress buffers out-of-chunk writes into the pending-edit map returned by
 * {@link NetherWorldGenerator#takePendingEdits}, which `world/world.js`
 * applies after the target chunk's own terrain pass.
 *
 * ## Block palette
 *
 * The Nether needs blocks that `world/blocks.js` may or may not define
 * (`crimson_nylium`, `shroomlight`, `nether_wart_block`, `bone_block`, …).
 * {@link NETHER_BLOCKS} resolves every slot through a preference list: the
 * real block if the registry has it, otherwise the closest existing stand-in.
 * Adding the real blocks to `blocks.js` later upgrades the generator with no
 * change here.
 *
 * No `window` / `document` access — safe to import inside a module Web Worker.
 *
 * @module world/netherworldgen
 */

import {
  B, BLOCK_BY_NAME, BLOCK_COUNT, ABSORB_TABLE, RENDER,
  blockRender, isSolid, isLiquid,
} from './blocks.js';
import { Noise } from './noise.js';
import {
  CHUNK_SIZE, SECTION_COUNT, SECTION_VOLUME, WORLD_MIN_Y, WORLD_MAX_Y,
  HEIGHTMAP_EMPTY,
} from './chunk.js';
import { mulberry32, xxhash32, clamp } from '../core/math.js';
import { placeOreVein } from './structures.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Generator version. Bump when a change alters the blocks produced for a given
 * seed, so saved Nether chunks can be migrated or regenerated.
 * @type {number}
 */
export const NETHER_GEN_VERSION = 1;

/** Lowest world Y the Nether uses (the bottom bedrock layer). @type {number} */
export const NETHER_MIN_Y = 0;
/** One past the highest world Y the Nether uses. @type {number} */
export const NETHER_MAX_Y = 128;
/** Vertical extent of the dimension in blocks. @type {number} */
export const NETHER_HEIGHT = NETHER_MAX_Y - NETHER_MIN_Y;
/** Highest bedrock-floor layer (`y 0..4` may be bedrock). @type {number} */
export const NETHER_FLOOR_Y = 4;
/** Lowest bedrock-ceiling layer (`y 123..127` may be bedrock). @type {number} */
export const NETHER_CEILING_Y = 123;
/** Every open voxel at or below this Y is filled with lava. @type {number} */
export const NETHER_LAVA_LEVEL = 31;
/** Sentinel returned by {@link NetherWorldGenerator#getHeightAt} for a column with no walkable floor. @type {number} */
export const NETHER_NO_FLOOR = NETHER_MIN_Y - 1;

/** Horizontal size of one density interpolation cell, in blocks. */
const CELL_XZ = 4;
/** Vertical size of one density interpolation cell, in blocks. */
const CELL_Y = 4;
/** Reciprocal of {@link CELL_XZ}. */
const INV_CELL_XZ = 1 / CELL_XZ;
/** Reciprocal of {@link CELL_Y}. */
const INV_CELL_Y = 1 / CELL_Y;
/** Density grid points per chunk axis (`16 / 4 + 1`). */
const GRID_N = CHUNK_SIZE / CELL_XZ + 1;
/** Density grid points per chunk layer. */
const GRID_XZ = GRID_N * GRID_N;
/** Vertical density grid levels (`128 / 4 + 1`). */
const GY_COUNT = NETHER_HEIGHT / CELL_Y + 1;
/** Columns per chunk. */
const COLUMN_COUNT = CHUNK_SIZE * CHUNK_SIZE;
/** Voxels considered by the solidity mask (one chunk column set). */
const MASK_SIZE = COLUMN_COUNT * NETHER_HEIGHT;

/** Number of bedrock layers at each end of the dimension. */
const BEDROCK_LAYERS = 5;

/** Y at which the ceiling closure starts pushing the field solid. */
const ROOF_START = 93;
/** Span of the ceiling closure ramp, in blocks. */
const ROOF_SPAN = NETHER_CEILING_Y - ROOF_START;
/** Reciprocal of {@link ROOF_SPAN}. */
const INV_ROOF_SPAN = 1 / ROOF_SPAN;
/** Y at which the floor closure stops pushing the field solid. */
const FLOOR_END = 18;
/** Span of the floor closure ramp, in blocks. */
const FLOOR_SPAN = FLOOR_END - NETHER_FLOOR_Y;
/** Reciprocal of {@link FLOOR_SPAN}. */
const INV_FLOOR_SPAN = 1 / FLOOR_SPAN;

/** Density above which a voxel counts as rock. */
const SOLID_ISO = -0.02;
/** Squared radius of the connecting-tunnel iso-surface intersection. */
const TUNNEL_R2 = 0.0075;
/** Reciprocal of {@link TUNNEL_R2}. */
const INV_TUNNEL_R2 = 1 / TUNNEL_R2;
/** How hard a tunnel carves into the density field. */
const TUNNEL_STRENGTH = 1.95;

/** Independent hash salts so the passes never correlate. */
const SALT_ORES = 0x2c1b3a91;
const SALT_FEATURES = 0x7f4a7c15;
const SALT_STRUCTURES = 0x1d8e4b07;
const SALT_BEDROCK = 0x9e3779b1;
const SALT_SURFACE = 0x45d9f3b3;

/** Chunk spacing of the fortress siting grid. */
const FORTRESS_SPACING = 27;
/** Minimum gap the fortress keeps from its region edge, in chunks. */
const FORTRESS_SEPARATION = 4;
/** Hard cap on blocks one fortress may write, so a bad seed cannot stall a worker. */
const FORTRESS_BUDGET = 48000;

/* -------------------------------------------------------------------------- */
/* Block palette                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the first block name that the registry actually knows.
 * @param {...string} names preference list, best first
 * @returns {number} block id (`B.NETHERRACK` when nothing matches)
 */
function pickBlock(...names) {
  for (let i = 0; i < names.length; i++) {
    const def = BLOCK_BY_NAME.get(names[i]);
    if (def !== undefined) return def.id;
  }
  return B.NETHERRACK === undefined ? 0 : B.NETHERRACK;
}

/**
 * Every block the Nether generator writes, resolved once at module load.
 *
 * Slots whose "real" block does not exist in `world/blocks.js` fall back to
 * the closest existing block so the dimension is complete and playable today;
 * adding the real block later upgrades it automatically.
 *
 * @type {Readonly<Object<string, number>>}
 */
export const NETHER_BLOCKS = Object.freeze({
  AIR: 0,
  BEDROCK: pickBlock('bedrock'),
  LAVA: pickBlock('lava'),
  NETHERRACK: pickBlock('netherrack'),
  GRAVEL: pickBlock('gravel'),
  MAGMA: pickBlock('magma_block'),
  GLOWSTONE: pickBlock('glowstone'),
  SOUL_SAND: pickBlock('soul_sand'),
  SOUL_SOIL: pickBlock('soul_soil'),
  BASALT: pickBlock('basalt'),
  SMOOTH_BASALT: pickBlock('smooth_basalt', 'basalt'),
  BLACKSTONE: pickBlock('blackstone'),
  POLISHED_BLACKSTONE: pickBlock('polished_blackstone', 'blackstone'),
  GILDED_BLACKSTONE: pickBlock('gilded_blackstone', 'polished_blackstone', 'blackstone'),
  OBSIDIAN: pickBlock('obsidian'),
  CRYING_OBSIDIAN: pickBlock('crying_obsidian', 'obsidian'),
  NETHER_BRICKS: pickBlock('nether_bricks'),
  NETHER_BRICK_FENCE: pickBlock('nether_brick_fence', 'iron_bars'),
  CHEST: pickBlock('chest'),
  SPAWNER: pickBlock('spawner'),
  QUARTZ_ORE: pickBlock('nether_quartz_ore', 'quartz_ore', 'quartz_block'),
  GOLD_ORE: pickBlock('nether_gold_ore', 'gold_ore'),
  ANCIENT_DEBRIS: pickBlock('ancient_debris'),
  BONE_BLOCK: pickBlock('bone_block', 'calcite'),
  SOUL_FIRE: pickBlock('soul_fire', 'soul_torch'),
  SOUL_LANTERN: pickBlock('soul_lantern', 'soul_torch'),
  FIRE: pickBlock('fire', 'campfire'),
  SHROOMLIGHT: pickBlock('shroomlight', 'glowstone'),
  CRIMSON_NYLIUM: pickBlock('crimson_nylium', 'red_terracotta'),
  CRIMSON_STEM: pickBlock('crimson_stem', 'crimson_hyphae', 'brown_terracotta'),
  CRIMSON_CAP: pickBlock('nether_wart_block', 'red_concrete'),
  CRIMSON_FUNGUS: pickBlock('crimson_fungus', 'red_mushroom'),
  CRIMSON_ROOTS: pickBlock('crimson_roots', 'dead_bush'),
  WARPED_NYLIUM: pickBlock('warped_nylium', 'cyan_terracotta'),
  WARPED_STEM: pickBlock('warped_stem', 'warped_hyphae', 'dark_prismarine'),
  WARPED_CAP: pickBlock('warped_wart_block', 'prismarine'),
  WARPED_FUNGUS: pickBlock('warped_fungus', 'brown_mushroom'),
  WARPED_ROOTS: pickBlock('warped_roots', 'nether_sprouts', 'blue_orchid'),
  NETHER_WART: pickBlock('nether_wart', 'nether_wart_stage0', 'red_mushroom'),
  NETHER_PORTAL: pickBlock('nether_portal'),
});

/* -------------------------------------------------------------------------- */
/* Regions                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Nether region ids. These are **not** `world/biomes.js` ids — see
 * {@link NETHER_BIOMES} for the mapping the chunk `biomes` array carries.
 * @type {Readonly<Object<string, number>>}
 */
export const NETHER_REGION = Object.freeze({
  WASTES: 0,
  SOUL_SAND_VALLEY: 1,
  CRIMSON_FOREST: 2,
  WARPED_FOREST: 3,
  BASALT_DELTAS: 4,
});

/**
 * @typedef {Object} NetherBiomeDef
 * @property {number} id region id (see {@link NETHER_REGION})
 * @property {string} name stable snake_case identifier
 * @property {string} display German display name
 * @property {number} vanillaBiome `world/biomes.js` id written into the chunk
 *   biome array, chosen for its fog colour and music mood
 * @property {[number,number,number]} fogColor linear fog tint for this region
 * @property {number} fogDensity per-block exponential fog density
 * @property {[number,number,number]} ambient linear ambient light floor
 * @property {number} fungusDensity huge-fungus attempts per chunk
 * @property {number} scatterDensity ground-cover attempts per chunk
 */

/**
 * The five Nether regions, in region-id order.
 *
 * `vanillaBiome` maps each region onto an existing `world/biomes.js` entry so
 * the chunk biome array, the mesher tint lookup and `game/audio.js` ambience
 * all keep working; the ids were picked for their fog colour and music mood
 * (`dripstone_caves` and `deep_dark` are dark and ominous, `badlands` is
 * red-brown, `lush_caves` is dark green) and none of them precipitates.
 *
 * @type {ReadonlyArray<NetherBiomeDef>}
 */
export const NETHER_BIOMES = Object.freeze([
  Object.freeze({
    id: 0,
    name: 'nether_wastes',
    display: 'Nether-Ödland',
    vanillaBiome: 42,
    fogColor: [0.20, 0.035, 0.030],
    fogDensity: 0.052,
    ambient: [0.115, 0.052, 0.040],
    fungusDensity: 0,
    scatterDensity: 3,
  }),
  Object.freeze({
    id: 1,
    name: 'soul_sand_valley',
    display: 'Seelensandtal',
    vanillaBiome: 43,
    fogColor: [0.075, 0.115, 0.150],
    fogDensity: 0.060,
    ambient: [0.055, 0.085, 0.115],
    fungusDensity: 0,
    scatterDensity: 5,
  }),
  Object.freeze({
    id: 2,
    name: 'crimson_forest',
    display: 'Karmesinwald',
    vanillaBiome: 21,
    fogColor: [0.180, 0.020, 0.022],
    fogDensity: 0.070,
    ambient: [0.125, 0.048, 0.045],
    fungusDensity: 9,
    scatterDensity: 26,
  }),
  Object.freeze({
    id: 3,
    name: 'warped_forest',
    display: 'Wirrwald',
    vanillaBiome: 41,
    fogColor: [0.030, 0.100, 0.098],
    fogDensity: 0.068,
    ambient: [0.040, 0.100, 0.098],
    fungusDensity: 8,
    scatterDensity: 24,
  }),
  Object.freeze({
    id: 4,
    name: 'basalt_deltas',
    display: 'Basaltdelta',
    vanillaBiome: 42,
    fogColor: [0.090, 0.075, 0.072],
    fogDensity: 0.058,
    ambient: [0.075, 0.065, 0.062],
    fungusDensity: 0,
    scatterDensity: 2,
  }),
]);

/** Fast region -> vanilla biome id table. @type {Uint8Array} */
const REGION_TO_BIOME = (() => {
  const t = new Uint8Array(NETHER_BIOMES.length);
  for (let i = 0; i < NETHER_BIOMES.length; i++) t[i] = NETHER_BIOMES[i].vanillaBiome & 255;
  return t;
})();

/**
 * Look up a Nether region descriptor, clamped to a valid entry.
 * @param {number} id region id
 * @returns {NetherBiomeDef} region descriptor
 */
export function getNetherRegion(id) {
  const i = id | 0;
  return NETHER_BIOMES[i >= 0 && i < NETHER_BIOMES.length ? i : 0];
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Blocks that may only be written into air or another replaceable block —
 * every cross-rendered plant plus the two fungus sprites.
 * @type {Uint8Array}
 */
const SOFT_PLACE = (() => {
  const mask = new Uint8Array(BLOCK_COUNT);
  for (let id = 0; id < BLOCK_COUNT; id++) {
    if (blockRender(id) === RENDER.CROSS || blockRender(id) === RENDER.TORCH) mask[id] = 1;
  }
  return mask;
})();

/**
 * Read one block out of a raw section array set.
 * @param {(Uint16Array|null)[]} sections 24 chunk sections
 * @param {number} lx chunk-local x, `0..15`
 * @param {number} y world y
 * @param {number} lz chunk-local z, `0..15`
 * @returns {number} block id (air outside the world)
 */
function sectionGet(sections, lx, y, lz) {
  if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return 0;
  const s = sections[(y - WORLD_MIN_Y) >> 4];
  if (s === null || s === undefined) return 0;
  return s[((y & 15) * CHUNK_SIZE + lz) * CHUNK_SIZE + lx];
}

/**
 * Write one block into a raw section array set, allocating the section on the
 * first non-air write.
 * @param {(Uint16Array|null)[]} sections 24 chunk sections
 * @param {number} lx chunk-local x, `0..15`
 * @param {number} y world y
 * @param {number} lz chunk-local z, `0..15`
 * @param {number} id block id
 * @returns {void}
 */
function sectionSet(sections, lx, y, lz, id) {
  if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
  const si = (y - WORLD_MIN_Y) >> 4;
  let s = sections[si];
  if (s === null || s === undefined) {
    if (id === 0) return;
    s = new Uint16Array(SECTION_VOLUME);
    sections[si] = s;
  }
  s[((y & 15) * CHUNK_SIZE + lz) * CHUNK_SIZE + lx] = id;
}

/**
 * Deterministic float in `[0, 1)` from three integers and a salt.
 * @param {number} a first integer
 * @param {number} b second integer
 * @param {number} c third integer
 * @param {number} salt salt
 * @returns {number} pseudo-random float
 */
function hashUnit(a, b, c, salt) {
  return xxhash32(a | 0, b | 0, c | 0, salt | 0) / 4294967296;
}

/**
 * Uniform integer in `[lo, hi]`.
 * @param {() => number} rng random source
 * @param {number} lo inclusive lower bound
 * @param {number} hi inclusive upper bound
 * @returns {number} integer
 */
function randInt(rng, lo, hi) {
  if (hi <= lo) return lo;
  const v = lo + ((rng() * (hi - lo + 1)) | 0);
  return v > hi ? hi : v;
}

/**
 * Turn a string or number seed into a stable int32.
 * @param {number|string} seed raw seed
 * @returns {number} int32 seed
 */
function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed | 0;
  const s = String(seed === undefined || seed === null ? '' : seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/* -------------------------------------------------------------------------- */
/* NetherWorldGenerator                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} NetherColumnRegion
 * @property {string} key `"cx,cz"`
 * @property {number} cx chunk x
 * @property {number} cz chunk z
 * @property {Float32Array} grid interpolated density grid, `GRID_XZ * GY_COUNT`
 * @property {Uint8Array} region Nether region id per column (256)
 * @property {Uint8Array} biomes vanilla biome id per column (256)
 * @property {Int16Array} floorY main walkable floor per column (256)
 * @property {Int16Array} ceilY ceiling above the main floor per column (256)
 */

/**
 * The VOXELIA Nether generator.
 *
 * API-compatible with {@link import('./worldgen.js').WorldGenerator}: build one
 * per world (or per worker) and call {@link NetherWorldGenerator#generateChunk}.
 */
export class NetherWorldGenerator {
  /**
   * @param {number|string} seed world seed (strings are hashed)
   * @param {Object} [options] generator switches
   * @param {boolean} [options.ores=true] place quartz / gold / ancient debris
   * @param {boolean} [options.features=true] place fungi, columns, glowstone, lavafalls
   * @param {boolean} [options.structures=true] place fortresses
   * @param {boolean} [options.decoration=true] apply the per-region surface rules
   * @param {number} [options.cacheSize=192] column regions kept in the LRU
   */
  constructor(seed, options = {}) {
    /** @type {number} int32 world seed */
    this.seed = normalizeSeed(seed);

    /**
     * The Nether uses a different noise family than the overworld even for the
     * same seed, so a world's two dimensions never mirror each other.
     * @type {number}
     */
    this._salt = (this.seed ^ 0x4e455448) | 0;

    /** @type {{ores:boolean, features:boolean, structures:boolean, decoration:boolean, cacheSize:number}} */
    this.options = {
      ores: options.ores !== false,
      features: options.features !== false,
      structures: options.structures !== false,
      decoration: options.decoration !== false,
      cacheSize: Math.max(16, (options.cacheSize | 0) || 192),
    };

    const s = this._salt;
    /* Cavern shaping. */
    this.nMain = new Noise(s + 101);
    this.nDetail = new Noise(s + 102);
    this.nOpenA = new Noise(s + 103);
    this.nOpenB = new Noise(s + 104);
    this.nTunA = new Noise(s + 105);
    this.nTunB = new Noise(s + 106);

    /* Regions. */
    this.nRegTemp = new Noise(s + 121);
    this.nRegHumid = new Noise(s + 122);
    this.nRegWeird = new Noise(s + 123);

    /* Surface / decoration. */
    this.nPatch = new Noise(s + 141);
    this.nSoil = new Noise(s + 142);
    this.nDelta = new Noise(s + 143);
    this.nFortress = new Noise(s + 144);

    /**
     * Deferred writes for structures that cross a chunk border.
     * @type {Map<string, Array<number[]>>}
     */
    this._pending = new Map();

    /**
     * LRU of computed column regions, keyed `"cx,cz"`.
     * @type {Map<string, NetherColumnRegion>}
     */
    this._cache = new Map();

    /**
     * Shared solidity mask for one chunk (`col * NETHER_HEIGHT + y`). Only one
     * chunk is ever live at a time, so a single 32 KB buffer serves the whole
     * generator and no pass allocates.
     * @type {Uint8Array}
     * @private
     */
    this._mask = new Uint8Array(MASK_SIZE);
    /** @type {string} region key {@link NetherWorldGenerator#_mask} holds. @private */
    this._maskKey = '';

    /** Scratch grid climate values, reused across chunks. @type {Float32Array} @private */
    this._gridOpen = new Float32Array(GRID_XZ);
  }

  /* ------------------------------------------------------------ density -- */

  /**
   * Raw rock density before the openness bias. Positive is rock.
   * @param {number} wx world x
   * @param {number} wy world y
   * @param {number} wz world z
   * @returns {number} density
   * @private
   */
  _density(wx, wy, wz) {
    let n = this.nMain.fbm3(wx * 0.0102, wy * 0.0158, wz * 0.0102, 4);
    n += this.nDetail.fbm3(wx * 0.0295, wy * 0.0410, wz * 0.0295, 2) * 0.26;

    // Ceiling closure: the field turns solid on the way up to the bedrock roof.
    const roof = (wy - ROOF_START) * INV_ROOF_SPAN;
    if (roof > 0) {
      const t = roof > 1 ? 1 : roof;
      n += t * t * 1.35;
    }
    // Floor closure: solid rock under the lava sea, so it has a bed to sit in.
    const floorT = (FLOOR_END - wy) * INV_FLOOR_SPAN;
    if (floorT > 0) {
      const t = floorT > 1 ? 1 : floorT;
      n += t * t * 1.30;
    }

    // Connecting tunnels: the intersection of two iso-surfaces is a tube.
    const a = this.nTunA.simplex3(wx * 0.0128, wy * 0.0182, wz * 0.0128);
    const b = this.nTunB.simplex3(wx * 0.0128, wy * 0.0182, wz * 0.0128);
    const d2 = a * a + b * b;
    if (d2 < TUNNEL_R2) n -= (1 - d2 * INV_TUNNEL_R2) * TUNNEL_STRENGTH;

    return n;
  }

  /**
   * Openness bias for a column: how much the cavern field is pushed toward
   * air. High values give vast open caverns, low values dense rock.
   * @param {number} wx world x
   * @param {number} wz world z
   * @returns {number} bias, roughly `-0.17 .. 0.30`
   * @private
   */
  _openness(wx, wz) {
    const a = this.nOpenA.fbm2(wx * 0.0018, wz * 0.0018, 3);
    const b = this.nOpenB.fbm2(wx * 0.0061, wz * 0.0061, 2);
    return 0.06 + a * 0.24 + b * 0.07;
  }

  /**
   * Pick the Nether region at a world column.
   * @param {number} wx world x
   * @param {number} wz world z
   * @returns {number} region id (see {@link NETHER_REGION})
   * @private
   */
  _regionAt(wx, wz) {
    const w = this.nRegWeird.fbm2(wx * 0.00105, wz * 0.00105, 2);
    if (w > 0.44) return NETHER_REGION.BASALT_DELTAS;
    const t = this.nRegTemp.fbm2(wx * 0.00160, wz * 0.00160, 3);
    if (t < -0.26) return NETHER_REGION.SOUL_SAND_VALLEY;
    const h = this.nRegHumid.fbm2(wx * 0.00160, wz * 0.00160, 3);
    if (h > 0.26) return NETHER_REGION.CRIMSON_FOREST;
    if (h < -0.26) return NETHER_REGION.WARPED_FOREST;
    return NETHER_REGION.WASTES;
  }

  /* ------------------------------------------------------------- region -- */

  /**
   * Fetch (or build) the cached column region of one chunk.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @returns {NetherColumnRegion} the region
   * @private
   */
  _regionFor(cx, cz) {
    const key = cx + ',' + cz;
    const hit = this._cache.get(key);
    if (hit !== undefined) {
      // Refresh LRU order.
      this._cache.delete(key);
      this._cache.set(key, hit);
      return hit;
    }
    const reg = this._computeColumns(cx, cz, key);
    this._cache.set(key, reg);
    if (this._cache.size > this.options.cacheSize) {
      const oldest = this._cache.keys().next();
      if (!oldest.done) this._cache.delete(oldest.value);
    }
    return reg;
  }

  /**
   * Build the density grid, the region map and the per-column floor/ceiling
   * heights of one chunk.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {string} key cache key
   * @returns {NetherColumnRegion} the region
   * @private
   */
  _computeColumns(cx, cz, key) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const grid = new Float32Array(GRID_XZ * GY_COUNT);
    const open = this._gridOpen;

    for (let gz = 0; gz < GRID_N; gz++) {
      for (let gx = 0; gx < GRID_N; gx++) {
        open[gz * GRID_N + gx] = this._openness(ox + gx * CELL_XZ, oz + gz * CELL_XZ);
      }
    }

    for (let gy = 0; gy < GY_COUNT; gy++) {
      const wy = NETHER_MIN_Y + gy * CELL_Y;
      const base = gy * GRID_XZ;
      for (let gz = 0; gz < GRID_N; gz++) {
        const wz = oz + gz * CELL_XZ;
        for (let gx = 0; gx < GRID_N; gx++) {
          const wx = ox + gx * CELL_XZ;
          const gi = gz * GRID_N + gx;
          grid[base + gi] = this._density(wx, wy, wz) - open[gi];
        }
      }
    }

    const region = new Uint8Array(COLUMN_COUNT);
    const biomes = new Uint8Array(COLUMN_COUNT);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const col = lz * CHUNK_SIZE + lx;
        const r = this._regionAt(ox + lx, oz + lz);
        region[col] = r;
        biomes[col] = REGION_TO_BIOME[r];
      }
    }

    /** @type {NetherColumnRegion} */
    const reg = {
      key,
      cx,
      cz,
      grid,
      region,
      biomes,
      floorY: new Int16Array(COLUMN_COUNT),
      ceilY: new Int16Array(COLUMN_COUNT),
    };

    this._buildMask(reg);
    this._deriveColumnHeights(reg);
    return reg;
  }

  /**
   * Trilinearly interpolated density at a chunk-local voxel.
   * @param {NetherColumnRegion} reg column region
   * @param {number} lx chunk-local x, `0..15`
   * @param {number} y world y
   * @param {number} lz chunk-local z, `0..15`
   * @returns {number} density (positive is rock)
   * @private
   */
  _sampleDensity(reg, lx, y, lz) {
    const grid = reg.grid;

    let fy = (y - NETHER_MIN_Y) * INV_CELL_Y;
    let gy0 = fy | 0;
    if (gy0 < 0) gy0 = 0;
    else if (gy0 > GY_COUNT - 2) gy0 = GY_COUNT - 2;
    const ty = fy - gy0;

    const fx = lx * INV_CELL_XZ;
    let gx0 = fx | 0;
    if (gx0 > GRID_N - 2) gx0 = GRID_N - 2;
    const tx = fx - gx0;

    const fz = lz * INV_CELL_XZ;
    let gz0 = fz | 0;
    if (gz0 > GRID_N - 2) gz0 = GRID_N - 2;
    const tz = fz - gz0;

    const b0 = gy0 * GRID_XZ;
    const b1 = b0 + GRID_XZ;
    const r0 = gz0 * GRID_N + gx0;
    const r1 = r0 + GRID_N;

    const c000 = grid[b0 + r0];
    const c100 = grid[b0 + r0 + 1];
    const c010 = grid[b0 + r1];
    const c110 = grid[b0 + r1 + 1];
    const c001 = grid[b1 + r0];
    const c101 = grid[b1 + r0 + 1];
    const c011 = grid[b1 + r1];
    const c111 = grid[b1 + r1 + 1];

    const x00 = c000 + (c100 - c000) * tx;
    const x10 = c010 + (c110 - c010) * tx;
    const x01 = c001 + (c101 - c001) * tx;
    const x11 = c011 + (c111 - c011) * tx;
    const z0 = x00 + (x10 - x00) * tz;
    const z1 = x01 + (x11 - x01) * tz;
    return z0 + (z1 - z0) * ty;
  }

  /**
   * Fill the shared solidity mask for a region.
   * @param {NetherColumnRegion} reg column region
   * @returns {void}
   * @private
   */
  _buildMask(reg) {
    const mask = this._mask;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const base = (lz * CHUNK_SIZE + lx) * NETHER_HEIGHT;
        for (let y = 0; y < NETHER_HEIGHT; y++) {
          mask[base + y] = this._sampleDensity(reg, lx, y, lz) > SOLID_ISO ? 1 : 0;
        }
      }
    }
    this._maskKey = reg.key;
  }

  /**
   * Make sure the shared mask holds this region.
   * @param {NetherColumnRegion} reg column region
   * @returns {Uint8Array} the mask
   * @private
   */
  _ensureMask(reg) {
    if (this._maskKey !== reg.key) this._buildMask(reg);
    return this._mask;
  }

  /**
   * Derive the main walkable floor and the ceiling above it for every column.
   * @param {NetherColumnRegion} reg column region (mask must be current)
   * @returns {void}
   * @private
   */
  _deriveColumnHeights(reg) {
    const mask = this._mask;
    const floorY = reg.floorY;
    const ceilY = reg.ceilY;
    const top = NETHER_CEILING_Y - 1;
    const bottom = NETHER_LAVA_LEVEL + 1;

    for (let col = 0; col < COLUMN_COUNT; col++) {
      const base = col * NETHER_HEIGHT;
      let f = NETHER_NO_FLOOR;
      for (let y = top; y >= bottom; y--) {
        if (mask[base + y] === 0) continue;
        if (mask[base + y + 1] !== 0) continue;
        if (mask[base + y + 2] !== 0) continue;
        if (mask[base + y + 3] !== 0) continue;
        f = y;
        break;
      }
      floorY[col] = f;
      if (f === NETHER_NO_FLOOR) {
        ceilY[col] = NETHER_NO_FLOOR;
        continue;
      }
      let c = NETHER_CEILING_Y;
      for (let y = f + 1; y < NETHER_CEILING_Y; y++) {
        if (mask[base + y] !== 0) { c = y; break; }
      }
      ceilY[col] = c;
    }
  }

  /* -------------------------------------------------------------- blocks -- */

  /**
   * Write netherrack for every solid voxel and lava for every open voxel at or
   * below the lava sea.
   * @param {NetherColumnRegion} reg column region
   * @param {(Uint16Array|null)[]} sections destination sections
   * @returns {void}
   * @private
   */
  _fillTerrain(reg, sections) {
    const mask = this._ensureMask(reg);
    const rock = NETHER_BLOCKS.NETHERRACK;
    const lava = NETHER_BLOCKS.LAVA;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const base = (lz * CHUNK_SIZE + lx) * NETHER_HEIGHT;
        for (let y = 0; y < NETHER_HEIGHT; y++) {
          if (mask[base + y] !== 0) sectionSet(sections, lx, y, lz, rock);
          else if (y <= NETHER_LAVA_LEVEL) sectionSet(sections, lx, y, lz, lava);
        }
      }
    }
  }

  /**
   * Seal the dimension: a rough bedrock floor at the bottom and a rough
   * bedrock ceiling at the top, so nothing can fall or build out of the world.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections destination sections
   * @returns {void}
   * @private
   */
  _applyBedrock(cx, cz, sections) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const bedrock = NETHER_BLOCKS.BEDROCK;
    const salt = this.seed ^ SALT_BEDROCK;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = ox + lx;
        const wz = oz + lz;
        for (let k = 0; k < BEDROCK_LAYERS; k++) {
          const yLow = NETHER_MIN_Y + k;
          const yHigh = NETHER_MAX_Y - 1 - k;
          if (k === 0) {
            sectionSet(sections, lx, yLow, lz, bedrock);
            sectionSet(sections, lx, yHigh, lz, bedrock);
            continue;
          }
          const p = (BEDROCK_LAYERS - k) / BEDROCK_LAYERS;
          if (hashUnit(wx, yLow, wz, salt) < p) sectionSet(sections, lx, yLow, lz, bedrock);
          if (hashUnit(wx, yHigh, wz, salt ^ 0x5bd1e995) < p) sectionSet(sections, lx, yHigh, lz, bedrock);
        }
      }
    }
  }

  /* ------------------------------------------------------------- surface -- */

  /**
   * Apply the per-region surface rules to every exposed rock face — floors,
   * ceilings and the first few blocks of wall behind them.
   * @param {NetherColumnRegion} reg column region
   * @param {(Uint16Array|null)[]} sections destination sections
   * @returns {void}
   * @private
   */
  _applySurface(reg, sections) {
    const mask = this._ensureMask(reg);
    const ox = reg.cx * CHUNK_SIZE;
    const oz = reg.cz * CHUNK_SIZE;
    const salt = this.seed ^ SALT_SURFACE;
    const yTop = NETHER_CEILING_Y - 1;
    const yBottom = NETHER_FLOOR_Y + 1;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const wz = oz + lz;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = ox + lx;
        const col = lz * CHUNK_SIZE + lx;
        const base = col * NETHER_HEIGHT;
        const rid = reg.region[col];
        let depth = 0;

        for (let y = yTop; y >= yBottom; y--) {
          if (mask[base + y] === 0) { depth = 0; continue; }
          const openAbove = mask[base + y + 1] === 0;
          depth = openAbove ? 0 : depth + 1;
          const openBelow = mask[base + y - 1] === 0;
          if (depth > 4 && !openBelow) continue;

          const id = this._surfaceBlock(rid, wx, y, wz, depth, openBelow, salt);
          if (id !== 0) sectionSet(sections, lx, y, lz, id);
        }
      }
    }
  }

  /**
   * Decide the block for one exposed rock voxel.
   * @param {number} rid Nether region id
   * @param {number} wx world x
   * @param {number} wy world y
   * @param {number} wz world z
   * @param {number} depth distance below the top of this solid run
   * @param {boolean} openBelow whether the voxel below is open (a ceiling face)
   * @param {number} salt hash salt
   * @returns {number} block id, or `0` to leave the netherrack alone
   * @private
   */
  _surfaceBlock(rid, wx, wy, wz, depth, openBelow, salt) {
    const P = NETHER_BLOCKS;
    const shore = wy <= NETHER_LAVA_LEVEL + 3 && wy >= NETHER_LAVA_LEVEL - 2;

    switch (rid) {
      case NETHER_REGION.SOUL_SAND_VALLEY: {
        if (openBelow && depth > 0) return P.SOUL_SOIL;
        if (depth === 0) {
          const m = this.nSoil.simplex3(wx * 0.085, wy * 0.085, wz * 0.085);
          return m > 0.05 ? P.SOUL_SAND : P.SOUL_SOIL;
        }
        return depth <= 3 ? P.SOUL_SOIL : 0;
      }
      case NETHER_REGION.CRIMSON_FOREST: {
        if (depth === 0 && !shore) return P.CRIMSON_NYLIUM;
        if (depth === 0 && shore) return P.MAGMA;
        return 0;
      }
      case NETHER_REGION.WARPED_FOREST: {
        if (depth === 0 && !shore) return P.WARPED_NYLIUM;
        if (depth === 0 && shore) return P.MAGMA;
        return 0;
      }
      case NETHER_REGION.BASALT_DELTAS: {
        if (depth > 4 && !openBelow) return 0;
        const m = this.nDelta.simplex3(wx * 0.070, wy * 0.055, wz * 0.070);
        if (depth === 0 && shore && hashUnit(wx, wy, wz, salt) < 0.42) return P.MAGMA;
        return m > 0.10 ? P.BASALT : P.BLACKSTONE;
      }
      default: {
        if (depth === 0 && shore && hashUnit(wx, wy, wz, salt) < 0.30) return P.MAGMA;
        if (depth > 1) return 0;
        const p = this.nPatch.simplex3(wx * 0.055, wy * 0.055, wz * 0.055);
        if (p > 0.70) return P.GRAVEL;
        if (p < -0.72) return P.SOUL_SAND;
        return 0;
      }
    }
  }

  /* ---------------------------------------------------------------- ores -- */

  /**
   * Build a writer that clips to the chunk and only replaces the rock types
   * the ore passes are allowed to eat.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {(x:number,y:number,z:number,id:number)=>void} writer
   * @private
   */
  _makeOreWriter(cx, cz, sections) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const P = NETHER_BLOCKS;
    return (x, y, z, id) => {
      const lx = x - ox;
      const lz = z - oz;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return;
      if (y <= NETHER_FLOOR_Y || y >= NETHER_CEILING_Y) return;
      const cur = sectionGet(sections, lx, y, lz);
      if (cur !== P.NETHERRACK && cur !== P.BASALT && cur !== P.BLACKSTONE
        && cur !== P.SOUL_SOIL && cur !== P.SOUL_SAND) return;
      sectionSet(sections, lx, y, lz, id);
    };
  }

  /**
   * Scatter quartz, gold and ancient debris through the rock.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {void}
   * @private
   */
  _generateOres(cx, cz, sections) {
    const write = this._makeOreWriter(cx, cz, sections);
    const rng = mulberry32(xxhash32(cx, cz, this.seed, SALT_ORES));
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const P = NETHER_BLOCKS;

    // Nether quartz: everywhere, common, medium veins.
    for (let i = 0; i < 16; i++) {
      const x = ox + randInt(rng, 0, 15);
      const z = oz + randInt(rng, 0, 15);
      const y = randInt(rng, NETHER_FLOOR_Y + 6, NETHER_CEILING_Y - 6);
      placeOreVein(write, rng, x, y, z, P.QUARTZ_ORE, randInt(rng, 8, 15));
    }

    // Nether gold: slightly rarer, smaller veins, biased low.
    for (let i = 0; i < 10; i++) {
      const x = ox + randInt(rng, 0, 15);
      const z = oz + randInt(rng, 0, 15);
      const y = randInt(rng, NETHER_FLOOR_Y + 6, NETHER_CEILING_Y - 20);
      placeOreVein(write, rng, x, y, z, P.GOLD_ORE, randInt(rng, 5, 11));
    }

    // Ancient debris: deep in the rock under the lava sea, and very rare.
    if (rng() < 0.42) {
      const x = ox + randInt(rng, 0, 15);
      const z = oz + randInt(rng, 0, 15);
      const y = randInt(rng, NETHER_FLOOR_Y + 3, 22);
      placeOreVein(write, rng, x, y, z, P.ANCIENT_DEBRIS, randInt(rng, 2, 3));
    }
    if (rng() < 0.06) {
      const x = ox + randInt(rng, 0, 15);
      const z = oz + randInt(rng, 0, 15);
      const y = randInt(rng, 8, 118);
      placeOreVein(write, rng, x, y, z, P.ANCIENT_DEBRIS, 2);
    }
  }

  /* ------------------------------------------------------------ features -- */

  /**
   * Writer for the small-feature pass: clips to the chunk, never touches
   * bedrock and only lets plants replace air.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {(x:number,y:number,z:number,id:number)=>void} writer
   * @private
   */
  _makeClippedWriter(cx, cz, sections) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const bedrock = NETHER_BLOCKS.BEDROCK;
    return (x, y, z, id) => {
      const lx = x - ox;
      const lz = z - oz;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return;
      if (y <= NETHER_FLOOR_Y || y >= NETHER_CEILING_Y) return;
      const cur = sectionGet(sections, lx, y, lz);
      if (cur === bedrock) return;
      if (SOFT_PLACE[id] === 1 && cur !== 0) return;
      sectionSet(sections, lx, y, lz, id);
    };
  }

  /**
   * Run the feature pass for the 3x3 chunk neighbourhood so nothing is cut in
   * half at a chunk border.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {void}
   * @private
   */
  _generateFeatures(cx, cz, sections) {
    const write = this._makeClippedWriter(cx, cz, sections);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this._featurePass(cx + dx, cz + dz, write);
      }
    }
  }

  /**
   * Generate the features owned by one chunk. Deterministic in
   * `(cx, cz, seed)`, so a neighbour asking for them gets the same result.
   * @param {number} cx chunk x that owns the features
   * @param {number} cz chunk z that owns the features
   * @param {(x:number,y:number,z:number,id:number)=>void} write clipped writer
   * @returns {void}
   * @private
   */
  _featurePass(cx, cz, write) {
    const reg = this._regionFor(cx, cz);
    const rng = mulberry32(xxhash32(cx, cz, this.seed, SALT_FEATURES));
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const P = NETHER_BLOCKS;
    const centre = getNetherRegion(reg.region[8 * CHUNK_SIZE + 8]);

    /* ---- huge fungi ---------------------------------------------------- */
    for (let i = 0; i < centre.fungusDensity; i++) {
      const lx = randInt(rng, 1, 14);
      const lz = randInt(rng, 1, 14);
      const col = lz * CHUNK_SIZE + lx;
      const rid = reg.region[col];
      if (rid !== NETHER_REGION.CRIMSON_FOREST && rid !== NETHER_REGION.WARPED_FOREST) continue;
      const y = reg.floorY[col];
      if (y === NETHER_NO_FLOOR) continue;
      const head = reg.ceilY[col] - y;
      if (head < 7) continue;
      if (rng() > 0.55) continue;
      this._placeHugeFungus(write, rng, ox + lx, y, oz + lz,
        rid === NETHER_REGION.CRIMSON_FOREST, head);
    }

    /* ---- ground cover -------------------------------------------------- */
    for (let i = 0; i < centre.scatterDensity; i++) {
      const lx = randInt(rng, 0, 15);
      const lz = randInt(rng, 0, 15);
      const col = lz * CHUNK_SIZE + lx;
      const y = reg.floorY[col];
      if (y === NETHER_NO_FLOOR) continue;
      const rid = reg.region[col];
      let id = 0;
      if (rid === NETHER_REGION.CRIMSON_FOREST) id = rng() < 0.24 ? P.CRIMSON_FUNGUS : P.CRIMSON_ROOTS;
      else if (rid === NETHER_REGION.WARPED_FOREST) id = rng() < 0.24 ? P.WARPED_FUNGUS : P.WARPED_ROOTS;
      else if (rid === NETHER_REGION.SOUL_SAND_VALLEY) id = rng() < 0.30 ? P.SOUL_FIRE : 0;
      else if (rng() < 0.25) id = P.CRIMSON_ROOTS;
      if (id !== 0) write(ox + lx, y + 1, oz + lz, id);
    }

    /* ---- glowstone clusters hanging from the ceiling -------------------- */
    for (let i = 0; i < 4; i++) {
      if (rng() > 0.34) continue;
      const lx = randInt(rng, 1, 14);
      const lz = randInt(rng, 1, 14);
      const col = lz * CHUNK_SIZE + lx;
      const c = reg.ceilY[col];
      if (c === NETHER_NO_FLOOR || c >= NETHER_CEILING_Y) continue;
      if (c - reg.floorY[col] < 5) continue;
      this._placeGlowstoneCluster(write, rng, ox + lx, c, oz + lz);
    }

    /* ---- lavafalls from the ceiling ------------------------------------ */
    for (let i = 0; i < 2; i++) {
      if (rng() > 0.10) continue;
      const lx = randInt(rng, 1, 14);
      const lz = randInt(rng, 1, 14);
      const col = lz * CHUNK_SIZE + lx;
      const c = reg.ceilY[col];
      const f = reg.floorY[col];
      if (c === NETHER_NO_FLOOR || f === NETHER_NO_FLOOR) continue;
      if (c - f < 10) continue;
      write(ox + lx, c, oz + lz, P.LAVA);
      for (let y = c - 1; y > f; y--) write(ox + lx, y, oz + lz, P.LAVA);
      write(ox + lx, f, oz + lz, P.MAGMA);
    }

    /* ---- basalt columns in the deltas ---------------------------------- */
    if (centre.id === NETHER_REGION.BASALT_DELTAS) {
      for (let i = 0; i < 7; i++) {
        const lx = randInt(rng, 0, 15);
        const lz = randInt(rng, 0, 15);
        const col = lz * CHUNK_SIZE + lx;
        const f = reg.floorY[col];
        const c = reg.ceilY[col];
        if (f === NETHER_NO_FLOOR) continue;
        const room = Math.min(c - f - 1, 14);
        if (room < 3) continue;
        const h = randInt(rng, 3, room);
        for (let k = 1; k <= h; k++) {
          write(ox + lx, f + k, oz + lz, k === h && rng() < 0.35 ? P.MAGMA : P.BASALT);
        }
      }
    }

    /* ---- fossils in the soul sand valley -------------------------------- */
    if (centre.id === NETHER_REGION.SOUL_SAND_VALLEY && rng() < 0.22) {
      const lx = randInt(rng, 3, 12);
      const lz = randInt(rng, 3, 12);
      const col = lz * CHUNK_SIZE + lx;
      const f = reg.floorY[col];
      if (f !== NETHER_NO_FLOOR) this._placeFossil(write, rng, ox + lx, f, oz + lz);
    }

    /* ---- soul lanterns on valley ceilings ------------------------------- */
    if (centre.id === NETHER_REGION.SOUL_SAND_VALLEY) {
      for (let i = 0; i < 3; i++) {
        if (rng() > 0.30) continue;
        const lx = randInt(rng, 0, 15);
        const lz = randInt(rng, 0, 15);
        const col = lz * CHUNK_SIZE + lx;
        const c = reg.ceilY[col];
        if (c === NETHER_NO_FLOOR || c >= NETHER_CEILING_Y) continue;
        write(ox + lx, c - 1, oz + lz, P.SOUL_LANTERN);
      }
    }
  }

  /**
   * Grow one huge fungus: a stem topped by a rounded wart cap with a few
   * shroomlights baked into it, plus roots around the base.
   * @param {(x:number,y:number,z:number,id:number)=>void} write clipped writer
   * @param {() => number} rng random source
   * @param {number} x floor x
   * @param {number} y floor y (the stem starts at `y + 1`)
   * @param {number} z floor z
   * @param {boolean} crimson `true` for crimson, `false` for warped
   * @param {number} headroom blocks of free space above the floor
   * @returns {void}
   * @private
   */
  _placeHugeFungus(write, rng, x, y, z, crimson, headroom) {
    const P = NETHER_BLOCKS;
    const stem = crimson ? P.CRIMSON_STEM : P.WARPED_STEM;
    const cap = crimson ? P.CRIMSON_CAP : P.WARPED_CAP;
    const roots = crimson ? P.CRIMSON_ROOTS : P.WARPED_ROOTS;
    const glow = P.SHROOMLIGHT;

    const maxH = Math.min(13, headroom - 4);
    if (maxH < 4) return;
    const h = randInt(rng, 4, maxH);
    const top = y + h;
    const rx = h >= 9 ? 3 : 2;
    const ry = h >= 9 ? 2 : 2;

    // Cap first: an ellipsoidal shell so the inside stays hollow.
    for (let dy = 0; dy <= ry * 2; dy++) {
      const fy = (dy - ry) / ry;
      const wy = top - 1 + dy;
      for (let dz = -rx; dz <= rx; dz++) {
        const fz = dz / rx;
        for (let dx = -rx; dx <= rx; dx++) {
          const fx = dx / rx;
          const d = fx * fx + fy * fy * 0.85 + fz * fz;
          if (d > 1.02) continue;
          if (d < 0.36 && dy !== 0) continue;
          write(x + dx, wy, z + dz, rng() < 0.07 ? glow : cap);
        }
      }
    }

    // Stem, drawn through the cap so it always reads as one plant.
    for (let k = 1; k <= h; k++) write(x, y + k, z, stem);
    if (rng() < 0.5) write(x, top + 1, z, glow);

    // Roots and sprouts around the base.
    for (let i = 0; i < 6; i++) {
      const dx = randInt(rng, -2, 2);
      const dz = randInt(rng, -2, 2);
      if (dx === 0 && dz === 0) continue;
      write(x + dx, y + 1, z + dz, roots);
    }
  }

  /**
   * Hang a glowstone cluster from a ceiling block.
   * @param {(x:number,y:number,z:number,id:number)=>void} write clipped writer
   * @param {() => number} rng random source
   * @param {number} x cluster x
   * @param {number} y y of the lowest ceiling block
   * @param {number} z cluster z
   * @returns {void}
   * @private
   */
  _placeGlowstoneCluster(write, rng, x, y, z) {
    const glow = NETHER_BLOCKS.GLOWSTONE;
    const depth = randInt(rng, 2, 4);
    for (let k = 0; k < depth; k++) {
      const r = k === 0 ? 2 : (k === 1 ? 1 : 0);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dz * dz > r * r + 1) continue;
          if (k > 0 && rng() < 0.28) continue;
          write(x + dx, y - k, z + dz, glow);
        }
      }
    }
  }

  /**
   * Lay a bone fossil into the soul sand: a spine with a rib cage.
   * @param {(x:number,y:number,z:number,id:number)=>void} write clipped writer
   * @param {() => number} rng random source
   * @param {number} x centre x
   * @param {number} y floor y
   * @param {number} z centre z
   * @returns {void}
   * @private
   */
  _placeFossil(write, rng, x, y, z) {
    const bone = NETHER_BLOCKS.BONE_BLOCK;
    const alongX = rng() < 0.5;
    const len = randInt(rng, 7, 11);
    const half = len >> 1;
    const spineY = y + 1;

    for (let i = -half; i <= half; i++) {
      const sx = alongX ? x + i : x;
      const sz = alongX ? z : z + i;
      write(sx, spineY, sz, bone);
      if (((i + half) & 1) !== 0 || rng() < 0.25) continue;
      const ribH = randInt(rng, 2, 4);
      for (let k = 1; k <= ribH; k++) {
        if (alongX) {
          write(sx, spineY + k, sz - k, bone);
          write(sx, spineY + k, sz + k, bone);
        } else {
          write(sx - k, spineY + k, sz, bone);
          write(sx + k, spineY + k, sz, bone);
        }
      }
    }
  }

  /* ---------------------------------------------------------- structures -- */

  /**
   * Writer for large structures: in-chunk writes land immediately, out-of-chunk
   * writes are buffered as pending edits for the target chunk.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {(x:number,y:number,z:number,id:number)=>void} writer
   * @private
   */
  _makeStructureWriter(cx, cz, sections) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const pending = this._pending;
    const bedrock = NETHER_BLOCKS.BEDROCK;
    return (x, y, z, id) => {
      if (y <= NETHER_FLOOR_Y || y >= NETHER_CEILING_Y) return;
      const lx = x - ox;
      const lz = z - oz;
      if (lx >= 0 && lx <= 15 && lz >= 0 && lz <= 15) {
        if (sectionGet(sections, lx, y, lz) === bedrock) return;
        sectionSet(sections, lx, y, lz, id);
        return;
      }
      const key = (x >> 4) + ',' + (z >> 4);
      let list = pending.get(key);
      if (list === undefined) {
        list = [];
        pending.set(key, list);
      }
      list.push([x, y, z, id]);
    };
  }

  /**
   * Region-based structure siting: at most one structure per
   * `spacing x spacing` chunk region, jittered inside the region.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {number} spacing region size in chunks
   * @param {number} separation gap kept from the region edge
   * @param {number} salt structure salt
   * @returns {boolean} whether this chunk owns the structure
   * @private
   */
  _isStructureChunk(cx, cz, spacing, separation, salt) {
    const rx = Math.floor(cx / spacing);
    const rz = Math.floor(cz / spacing);
    const span = Math.max(1, spacing - separation);
    const r = mulberry32(xxhash32(rx, rz, this.seed, salt));
    const sx = rx * spacing + ((r() * span) | 0);
    const sz = rz * spacing + ((r() * span) | 0);
    return sx === cx && sz === cz;
  }

  /**
   * Place the large structures owned by this chunk.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {void}
   * @private
   */
  _generateStructures(cx, cz, sections) {
    if (!this._isStructureChunk(cx, cz, FORTRESS_SPACING, FORTRESS_SEPARATION, SALT_STRUCTURES)) {
      return;
    }
    const write = this._makeStructureWriter(cx, cz, sections);
    const rng = mulberry32(xxhash32(cx, cz, this.seed, SALT_STRUCTURES ^ 0x51ed270b));
    const ox = cx * CHUNK_SIZE + 8;
    const oz = cz * CHUNK_SIZE + 8;
    const y = 48 + ((this.nFortress.fbm2(cx * 0.21, cz * 0.21, 2) * 11) | 0);
    this._placeFortress(write, rng, ox, clamp(y, 42, 62), oz);
  }

  /**
   * Build a nether fortress: a nether-brick spine with side wings, two
   * railed bridges over the lava sea on piers, a blaze spawner room, a wart
   * garden and two loot chests.
   *
   * Everything is written through `write`, so out-of-chunk blocks end up in the
   * pending-edit map. A hard block budget keeps a pathological seed from ever
   * stalling a worker.
   *
   * @param {(x:number,y:number,z:number,id:number)=>void} write structure writer
   * @param {() => number} rng random source
   * @param {number} x centre x
   * @param {number} y floor y of the corridors
   * @param {number} z centre z
   * @returns {void}
   * @private
   */
  _placeFortress(write, rng, x, y, z) {
    const P = NETHER_BLOCKS;
    const brick = P.NETHER_BRICKS;
    const fence = P.NETHER_BRICK_FENCE;
    let budget = FORTRESS_BUDGET;

    /**
     * Budgeted write.
     * @param {number} bx block x
     * @param {number} by block y
     * @param {number} bz block z
     * @param {number} id block id
     * @returns {void}
     */
    const put = (bx, by, bz, id) => {
      if (budget <= 0) return;
      budget--;
      write(bx, by, bz, id);
    };

    /**
     * Fill an inclusive box with one block id.
     * @param {number} x0 min x
     * @param {number} y0 min y
     * @param {number} z0 min z
     * @param {number} x1 max x
     * @param {number} y1 max y
     * @param {number} z1 max z
     * @param {number} id block id
     * @returns {void}
     */
    const box = (x0, y0, z0, x1, y1, z1, id) => {
      for (let by = y0; by <= y1; by++) {
        for (let bz = z0; bz <= z1; bz++) {
          for (let bx = x0; bx <= x1; bx++) put(bx, by, bz, id);
        }
      }
    };

    /**
     * Build one corridor segment: floor, walls, ceiling and a hollow interior,
     * with barred windows down both sides.
     * @param {number} x0 min x of the outer shell
     * @param {number} z0 min z of the outer shell
     * @param {number} x1 max x of the outer shell
     * @param {number} z1 max z of the outer shell
     * @param {number} by floor y (the floor slab is at `by`)
     * @returns {void}
     */
    const corridor = (x0, z0, x1, z1, by) => {
      box(x0, by, z0, x1, by + 5, z1, brick);
      box(x0 + 1, by + 1, z0 + 1, x1 - 1, by + 4, z1 - 1, 0);
      const alongX = (x1 - x0) >= (z1 - z0);
      if (alongX) {
        for (let bx = x0 + 2; bx <= x1 - 2; bx += 3) {
          put(bx, by + 2, z0, fence);
          put(bx, by + 3, z0, fence);
          put(bx, by + 2, z1, fence);
          put(bx, by + 3, z1, fence);
        }
      } else {
        for (let bz = z0 + 2; bz <= z1 - 2; bz += 3) {
          put(x0, by + 2, bz, fence);
          put(x0, by + 3, bz, fence);
          put(x1, by + 2, bz, fence);
          put(x1, by + 3, bz, fence);
        }
      }
    };

    /**
     * Build an open bridge with railings and support piers reaching down to
     * the lava sea.
     * @param {number} x0 min x of the deck
     * @param {number} z0 min z of the deck
     * @param {number} x1 max x of the deck
     * @param {number} z1 max z of the deck
     * @param {number} by deck y
     * @returns {void}
     */
    const bridge = (x0, z0, x1, z1, by) => {
      // Clear the head room first, then lay the deck: a bridge buried in rock
      // is not a bridge.
      box(x0, by + 1, z0, x1, by + 5, z1, 0);
      box(x0, by, z0, x1, by, z1, brick);
      const alongX = (x1 - x0) >= (z1 - z0);
      if (alongX) {
        for (let bx = x0; bx <= x1; bx++) {
          put(bx, by + 1, z0, fence);
          put(bx, by + 1, z1, fence);
        }
        for (let bx = x0 + 2; bx <= x1 - 2; bx += 6) {
          for (let py = by - 1; py > NETHER_LAVA_LEVEL - 2; py--) {
            put(bx, py, z0 + 1, brick);
            put(bx, py, z1 - 1, brick);
          }
        }
      } else {
        for (let bz = z0; bz <= z1; bz++) {
          put(x0, by + 1, bz, fence);
          put(x1, by + 1, bz, fence);
        }
        for (let bz = z0 + 2; bz <= z1 - 2; bz += 6) {
          for (let py = by - 1; py > NETHER_LAVA_LEVEL - 2; py--) {
            put(x0 + 1, py, bz, brick);
            put(x1 - 1, py, bz, brick);
          }
        }
      }
    };

    /* ---- main spine ----------------------------------------------------- */
    corridor(x - 20, z - 3, x + 20, z + 3, y);

    /* ---- cross wings ---------------------------------------------------- */
    corridor(x - 15, z - 18, x - 9, z + 18, y);
    corridor(x + 9, z - 18, x + 15, z + 18, y);

    /* Doorways where the wings meet the spine. */
    box(x - 14, y + 1, z - 2, x - 10, y + 3, z + 2, 0);
    box(x + 10, y + 1, z - 2, x + 14, y + 3, z + 2, 0);

    /* ---- bridges over the lava sea -------------------------------------- */
    bridge(x + 21, z - 2, x + 40, z + 2, y);
    bridge(x - 40, z - 2, x - 21, z + 2, y);
    box(x + 20, y + 1, z - 2, x + 20, y + 4, z + 2, 0);
    box(x - 20, y + 1, z - 2, x - 20, y + 4, z + 2, 0);

    /* ---- blaze spawner room --------------------------------------------- */
    const rx = x - 12;
    const rz = z + 21;
    box(rx - 6, y, rz - 5, rx + 6, y + 7, rz + 5, brick);
    box(rx - 5, y + 1, rz - 4, rx + 5, y + 6, rz + 4, 0);
    // Raised spawner platform with a barred rim.
    box(rx - 2, y + 1, rz - 2, rx + 2, y + 1, rz + 2, brick);
    for (let bx = rx - 2; bx <= rx + 2; bx++) {
      put(bx, y + 2, rz - 2, fence);
      put(bx, y + 2, rz + 2, fence);
    }
    for (let bz = rz - 1; bz <= rz + 1; bz++) {
      put(rx - 2, y + 2, bz, fence);
      put(rx + 2, y + 2, bz, fence);
    }
    box(rx - 1, y + 2, rz - 1, rx + 1, y + 2, rz + 1, 0);
    put(rx, y + 2, rz, P.SPAWNER);
    // Connect the room to the west wing.
    box(rx, y + 1, rz - 6, rx, y + 3, rz - 4, 0);
    box(x - 12, y + 1, z + 15, x - 12, y + 3, rz - 5, 0);

    /* ---- nether wart garden --------------------------------------------- */
    const gx = x + 12;
    const gz = z + 21;
    box(gx - 5, y, gz - 4, gx + 5, y + 6, gz + 4, brick);
    box(gx - 4, y + 1, gz - 3, gx + 4, y + 5, gz + 3, 0);
    for (let bz = gz - 2; bz <= gz + 2; bz++) {
      for (let bx = gx - 3; bx <= gx + 3; bx++) {
        put(bx, y, bz, P.SOUL_SAND);
        if (rng() < 0.72) put(bx, y + 1, bz, P.NETHER_WART);
      }
    }
    box(gx, y + 1, gz - 5, gx, y + 3, gz - 3, 0);
    box(x + 12, y + 1, z + 15, x + 12, y + 3, gz - 4, 0);

    /* ---- loot chests and lighting --------------------------------------- */
    put(x - 18, y + 1, z + 2, P.CHEST);
    put(x + 18, y + 1, z - 2, P.CHEST);
    put(rx + 4, y + 1, rz + 3, P.CHEST);
    for (let i = -18; i <= 18; i += 9) {
      put(x + i, y + 4, z - 2, P.GLOWSTONE);
      put(x + i, y + 4, z + 2, P.GLOWSTONE);
    }
    put(rx, y + 6, rz, P.GLOWSTONE);
    put(gx, y + 5, gz, P.GLOWSTONE);
  }

  /* -------------------------------------------------------------- output -- */

  /**
   * Rebuild the two heightmaps from the finished blocks, using the same
   * convention as `world/chunk.js`: one **above** the highest matching block,
   * `HEIGHTMAP_EMPTY` for a column with none.
   *
   * In the Nether the sky-blocking height is the bedrock ceiling, which is
   * exactly what the light engine needs: no sky light ever reaches the caverns.
   *
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @param {Int16Array} heightmap destination sky-blocking heightmap
   * @param {Int16Array} oceanFloor destination solid-floor heightmap
   * @returns {void}
   * @private
   */
  _computeHeightmaps(sections, heightmap, oceanFloor) {
    heightmap.fill(HEIGHTMAP_EMPTY);
    oceanFloor.fill(HEIGHTMAP_EMPTY);

    let topSection = -1;
    for (let s = SECTION_COUNT - 1; s >= 0; s--) {
      if (sections[s] !== null && sections[s] !== undefined) { topSection = s; break; }
    }
    if (topSection < 0) return;
    const startY = WORLD_MIN_Y + (topSection + 1) * 16 - 1;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const col = lz * CHUNK_SIZE + lx;
        let haveSky = false;
        for (let y = startY; y >= WORLD_MIN_Y; y--) {
          const id = sectionGet(sections, lx, y, lz);
          if (id === 0) continue;
          if (!haveSky && ABSORB_TABLE[id] > 0) {
            heightmap[col] = y + 1;
            haveSky = true;
          }
          if (isSolid(id) && !isLiquid(id)) {
            oceanFloor[col] = y + 1;
            break;
          }
        }
      }
    }
  }

  /**
   * Generate one whole chunk column.
   *
   * The returned object is transferable-friendly and matches
   * {@link import('./worldgen.js').WorldGenerator#generateChunk} exactly.
   *
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @returns {{sections:(Uint16Array|null)[], heightmap:Int16Array, biomes:Uint8Array, oceanFloor:Int16Array}}
   *   generated chunk data
   */
  generateChunk(cx, cz) {
    const reg = this._regionFor(cx, cz);
    /** @type {(Uint16Array|null)[]} */
    const sections = new Array(SECTION_COUNT).fill(null);

    this._fillTerrain(reg, sections);
    this._applyBedrock(cx, cz, sections);
    if (this.options.decoration) this._applySurface(reg, sections);
    if (this.options.ores) this._generateOres(cx, cz, sections);
    if (this.options.structures) this._generateStructures(cx, cz, sections);
    if (this.options.features) this._generateFeatures(cx, cz, sections);

    const heightmap = new Int16Array(COLUMN_COUNT);
    const oceanFloor = new Int16Array(COLUMN_COUNT);
    this._computeHeightmaps(sections, heightmap, oceanFloor);

    return {
      sections,
      heightmap,
      biomes: new Uint8Array(reg.biomes),
      oceanFloor,
    };
  }

  /**
   * Vanilla biome id at a world column — the `world/biomes.js` entry the Nether
   * region maps onto (see {@link NETHER_BIOMES}).
   * @param {number} x world x
   * @param {number} z world z
   * @returns {number} biome id
   */
  getBiomeAt(x, z) {
    // The region is a pure function of the column, so this never has to build
    // (or evict) a density grid — it stays cheap enough for the fog and
    // ambience resamples that run every second on the main thread.
    return REGION_TO_BIOME[this._regionAt(Math.floor(x), Math.floor(z))];
  }

  /**
   * Nether region id at a world column (see {@link NETHER_REGION}).
   * @param {number} x world x
   * @param {number} z world z
   * @returns {number} region id
   */
  getRegionAt(x, z) {
    return this._regionAt(Math.floor(x), Math.floor(z));
  }

  /**
   * Y of the main walkable cavern floor — the block you stand **on**.
   *
   * Unlike the overworld this is deliberately *not* the topmost solid block
   * (that would be the bedrock ceiling): the useful answer in a cavern world is
   * the floor of the largest open level, which is what spawn placement and
   * portal siting need.
   *
   * @param {number} x world x
   * @param {number} z world z
   * @returns {number} floor y, or {@link NETHER_NO_FLOOR} when the column is
   *   solid rock or drowned in lava
   */
  getHeightAt(x, z) {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const reg = this._regionFor(bx >> 4, bz >> 4);
    return reg.floorY[(bz & 15) * CHUNK_SIZE + (bx & 15)];
  }

  /**
   * Y of the ceiling directly above the main floor of a column.
   * @param {number} x world x
   * @param {number} z world z
   * @returns {number} ceiling y, or {@link NETHER_NO_FLOOR} when there is none
   */
  getCeilingAt(x, z) {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const reg = this._regionFor(bx >> 4, bz >> 4);
    return reg.ceilY[(bz & 15) * CHUNK_SIZE + (bx & 15)];
  }

  /**
   * Fluid surface height of a column. The Nether has one fluid body, the lava
   * sea, so this is constant.
   * @param {number} _x world x (unused)
   * @param {number} _z world z (unused)
   * @returns {number} {@link NETHER_LAVA_LEVEL}
   */
  getWaterLevelAt(_x, _z) {
    return NETHER_LAVA_LEVEL;
  }

  /**
   * Hand over every buffered cross-chunk structure edit and clear the buffer.
   * @returns {Map<string, Array<number[]>>} `"cx,cz"` -> `[[x, y, z, blockId], ...]`
   */
  takePendingEdits() {
    const out = this._pending;
    this._pending = new Map();
    return out;
  }

  /**
   * Drop the cached column regions.
   * @returns {void}
   */
  clearCache() {
    this._cache.clear();
    this._maskKey = '';
  }

  /**
   * Release everything held by the generator.
   * @returns {void}
   */
  dispose() {
    this._cache.clear();
    this._pending.clear();
    this._maskKey = '';
  }
}

export default NetherWorldGenerator;
