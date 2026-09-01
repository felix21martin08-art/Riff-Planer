/**
 * VOXELIA — `world/worldgen.js` (spec 5.9)
 *
 * A 1.18+-class multi-noise terrain generator.
 *
 * ## Pipeline
 *
 * 1. **Climate.** Five independent 2D noise fields — continentalness, erosion,
 *    peaks-and-valleys (from weirdness), temperature and humidity — are sampled
 *    on a 4-block grid and pushed through monotone `splineCurve()` shapers.
 *    The splines produce a *target height*, a *squash factor* and a *3D noise
 *    amplitude* per grid column.
 * 2. **Density field.** A true 3D field
 *    `d = (target - y) * squash + fbm3 * amp` is evaluated on a
 *    `4 x 4 x 4` cell grid and trilinearly interpolated to full resolution.
 *    Because `squash` drops to `0.085` in mountainous (low-erosion) terrain,
 *    the 3D noise can flip the sign well away from the target height, which is
 *    what produces real overhangs, arches and floating cliffs. Peaks reach
 *    `y ~ 250`.
 * 3. **Caves.** Cheese caverns, spaghetti tunnels (the intersection of two
 *    iso-surfaces), noodle caves and ravines are folded into the same
 *    interpolated density field, so they cost nothing extra per voxel. A
 *    separate low-frequency *entrance* field lets caves break the surface in
 *    roughly 5% of the world.
 * 4. **Aquifers.** Every column carries one water-table height, decided from
 *    the *uncarved* spline height so a deep ravine never masquerades as sea.
 *    Ocean and lake columns clamp it to `SEA_LEVEL`, which is what stops a
 *    cave from draining the sea; inland columns get a smooth, mostly-very-low noise level so most
 *    caves are dry and some hold underground lakes. Everything below
 *    `LAVA_LEVEL` is lava.
 * 5. **Surface rules.** Per biome: grass over dirt, sand over sandstone,
 *    banded terracotta in badlands, gravel on stony shores, mud in swamps,
 *    mycelium/podzol, snow layers and deep alpine snow above the snow line,
 *    ice on frozen water.
 * 6. **Ores.** Per-height-band veins with the correct rarity, deepslate
 *    variants below the (noise-jittered) deepslate line, extra gold in
 *    badlands and emerald only in mountain biomes.
 * 7. **Features and structures** from `world/structures.js`, seeded per chunk
 *    with `mulberry32(hash(cx, cz, seed))`.
 *
 * ## Determinism and chunk borders
 *
 * Small features (trees, plants, ore veins) are generated for the **3x3
 * neighbourhood** of every chunk and clipped to the chunk being built. They
 * are therefore always complete, whatever order chunks load in — a tree never
 * loses half its canopy. Large structures (villages, mineshafts, pyramids,
 * dungeons, geodes, ruins, lakes) instead buffer their out-of-chunk writes
 * into the pending-edit map returned by {@link WorldGenerator#takePendingEdits}
 * — `world/world.js` applies those to the target chunk *after* that chunk's own
 * terrain generation.
 *
 * No `window`/`document` access — safe to import inside a module Web Worker.
 *
 * @module world/worldgen
 */

import {
  B, BLOCK_BY_NAME, BLOCK_COUNT, RENDER, ABSORB_TABLE, blockRender, isReplaceable,
  isSolid, isLiquid,
} from './blocks.js';
import {
  getBiome, selectBiome, resolveBiomeBlocks, biomeTemperatureAt,
  biomePrecipitationAt, pickTreeType,
} from './biomes.js';
import { Noise, splineCurve } from './noise.js';
import {
  CHUNK_SIZE, SECTION_COUNT, SECTION_VOLUME, WORLD_MIN_Y, WORLD_MAX_Y, SEA_LEVEL,
  HEIGHTMAP_EMPTY,
} from './chunk.js';
import { mulberry32, xxhash32, clamp, lerp } from '../core/math.js';
import {
  placeTree, placeVegetation, placeOreVein, placeDungeon, placeRuins,
  placeMineshaft, placeVillage, placeDesertPyramid, placeAmethystGeode,
  placeStrongholdRoom, placeBoulder, placeDesertWell, placeGiantMushroom,
  placeIceSpike, placeFallenLog, placeWitchHut, placeLakePocket,
} from './structures.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Generator version. Bump whenever a change alters the blocks produced for a
 * given seed so saves can be migrated or regenerated.
 * @type {number}
 */
export const GEN_VERSION = 1;

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
/** Hard ceiling on vertical grid levels (whole world height). */
const MAX_GY = (WORLD_MAX_Y - WORLD_MIN_Y) / CELL_Y + 1;

/**
 * Clamp on the height-gradient term of the density field, so deep rock stays
 * inside the numeric range the cave fields can carve.
 */
const DENSITY_CAP = 4.0;
/** Everything below this y that would be air becomes lava. */
const LAVA_LEVEL = -48;

/**
 * Distance above a column's target height beyond which the density field is
 * unconditionally air, so the noise can be skipped. The 3D noise contribution
 * peaks at `1.80` (amplitude) plus `0.45` (jagged-crest term) and the smallest
 * squash is `0.085`, so at 38 blocks up the gradient alone is `-3.23` — more
 * than the noise can ever recover.
 */
const AIR_MARGIN = 38;

/**
 * Lowest value the inland water table can take. Well below the world floor, so
 * most columns end up with no aquifer at all and their caves stay dry.
 */
const AQUIFER_FLOOR = WORLD_MIN_Y - 90;
/** Number of world layers that can contain bedrock. */
const BEDROCK_LAYERS = 5;

/** Sentinel written into `terrainTop` for a column with no solid block. */
const NO_TERRAIN = WORLD_MIN_Y - 1;

/** Half-width of the river channel in weirdness space (matches `biomes.js`). */
const RIVER_HALF_WIDTH = 0.055;

/* Independent hash salts so the different generation passes never correlate. */
const SALT_ORES = 0x51ed270b;
const SALT_TREES = 0x1b873593;
const SALT_PLANTS = 0x27d4eb2f;
const SALT_STRUCTURES = 0x165667b1;
const SALT_CAVE_DECOR = 0x9e3779b9;
const SALT_BEDROCK = 0x85ebca6b;
const SALT_SHORE = 0xc2b2ae35;

/* -------------------------------------------------------------------------- */
/* Terrain shaping splines                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Continentalness -> height offset from sea level. `-1` is the abyssal plain,
 * `-0.19` the shoreline, `+1` deep inland.
 * @type {(t:number)=>number}
 */
const SPLINE_CONTINENTAL = splineCurve([
  [-1.00, -42], [-0.80, -36], [-0.60, -30], [-0.455, -24],
  [-0.30, -14], [-0.19, -2], [-0.12, 1], [-0.05, 3],
  [0.05, 5], [0.20, 8], [0.40, 14], [0.70, 22], [1.00, 30],
]);

/**
 * Erosion -> mountain amplitude in `[0, 1]`. `-1` is uneroded and jagged,
 * `+1` is a flat eroded plain.
 * @type {(t:number)=>number}
 */
const SPLINE_EROSION = splineCurve([
  [-1.00, 1.00], [-0.78, 0.90], [-0.55, 0.72], [-0.375, 0.52],
  [-0.2225, 0.38], [0.05, 0.26], [0.45, 0.16], [0.55, 0.20],
  [0.75, 0.10], [1.00, 0.06],
]);

/**
 * Peaks-and-valleys -> raw height offset in blocks, before the erosion
 * amplitude is applied.
 * @type {(t:number)=>number}
 */
const SPLINE_PEAKS = splineCurve([
  [-1.00, -24], [-0.85, -18], [-0.60, -10], [-0.35, -4],
  [-0.10, 1], [0.10, 6], [0.30, 20], [0.50, 48],
  [0.70, 86], [0.85, 120], [1.00, 150],
]);

/**
 * Erosion -> vertical squash. Small values let the 3D noise win over the
 * height gradient, which is what creates overhangs and floating cliffs.
 * @type {(t:number)=>number}
 */
const SPLINE_SQUASH = splineCurve([
  [-1.00, 0.085], [-0.50, 0.115], [0.00, 0.185], [0.50, 0.300], [1.00, 0.460],
]);

/* -------------------------------------------------------------------------- */
/* Ore table                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} OreConfig
 * @property {number} block ore block id used in stone
 * @property {number} deep ore block id used in deepslate
 * @property {number} count vein attempts per chunk
 * @property {number} size nominal vein size
 * @property {number} minY lowest vein centre
 * @property {number} maxY highest vein centre
 * @property {'uniform'|'triangle'|'low'} shape vertical distribution
 * @property {number} chance probability that one attempt is taken
 * @property {'any'|'mountain'|'badlands'} biomes biome restriction
 */

/**
 * Ore distribution, tuned to feel like 1.18+: coal everywhere and shallow,
 * iron in three overlapping bands, copper mid, gold deep (plus a huge badlands
 * bonus band), redstone/diamond at the bottom, lapis in a narrow band, emerald
 * only in mountains and ancient debris very deep and very rare.
 * @type {OreConfig[]}
 */
const ORES = [
  { block: B.COAL_ORE, deep: B.DEEPSLATE_COAL_ORE, count: 22, size: 17, minY: 0, maxY: 190, shape: 'triangle', chance: 1, biomes: 'any' },
  { block: B.IRON_ORE, deep: B.DEEPSLATE_IRON_ORE, count: 10, size: 9, minY: -24, maxY: 56, shape: 'triangle', chance: 1, biomes: 'any' },
  { block: B.IRON_ORE, deep: B.DEEPSLATE_IRON_ORE, count: 8, size: 4, minY: -63, maxY: 72, shape: 'uniform', chance: 1, biomes: 'any' },
  { block: B.IRON_ORE, deep: B.DEEPSLATE_IRON_ORE, count: 6, size: 9, minY: 80, maxY: 248, shape: 'triangle', chance: 1, biomes: 'any' },
  { block: B.COPPER_ORE, deep: B.DEEPSLATE_COPPER_ORE, count: 16, size: 10, minY: -16, maxY: 112, shape: 'triangle', chance: 1, biomes: 'any' },
  { block: B.GOLD_ORE, deep: B.DEEPSLATE_GOLD_ORE, count: 2, size: 9, minY: -64, maxY: 32, shape: 'triangle', chance: 1, biomes: 'any' },
  { block: B.GOLD_ORE, deep: B.DEEPSLATE_GOLD_ORE, count: 20, size: 9, minY: 32, maxY: 96, shape: 'uniform', chance: 1, biomes: 'badlands' },
  { block: B.REDSTONE_ORE, deep: B.DEEPSLATE_REDSTONE_ORE, count: 8, size: 8, minY: -64, maxY: 15, shape: 'low', chance: 1, biomes: 'any' },
  { block: B.LAPIS_ORE, deep: B.DEEPSLATE_LAPIS_ORE, count: 1, size: 7, minY: -64, maxY: 64, shape: 'triangle', chance: 1, biomes: 'any' },
  { block: B.LAPIS_ORE, deep: B.DEEPSLATE_LAPIS_ORE, count: 1, size: 7, minY: -32, maxY: 32, shape: 'triangle', chance: 1, biomes: 'any' },
  { block: B.DIAMOND_ORE, deep: B.DEEPSLATE_DIAMOND_ORE, count: 2, size: 6, minY: -64, maxY: 16, shape: 'low', chance: 0.7, biomes: 'any' },
  { block: B.EMERALD_ORE, deep: B.DEEPSLATE_EMERALD_ORE, count: 12, size: 3, minY: -16, maxY: 248, shape: 'triangle', chance: 1, biomes: 'mountain' },
  { block: B.ANCIENT_DEBRIS, deep: B.ANCIENT_DEBRIS, count: 1, size: 3, minY: -64, maxY: -32, shape: 'uniform', chance: 0.10, biomes: 'any' },
];

/** Biome names that count as "mountain" for emerald generation. */
const MOUNTAIN_BIOMES = new Set([
  'mountains', 'snowy_slopes', 'grove', 'jagged_peaks', 'frozen_peaks',
  'stony_peaks', 'meadow', 'stony_shore',
]);

/** Terracotta palette used for badlands banding. */
const BADLANDS_PALETTE = [
  B.TERRACOTTA, B.ORANGE_TERRACOTTA, B.YELLOW_TERRACOTTA, B.BROWN_TERRACOTTA,
  B.RED_TERRACOTTA, B.LIGHT_GRAY_TERRACOTTA, B.WHITE_TERRACOTTA,
];

/** Blocks a tree or plant is allowed to grow on. @type {Set<number>} */
const SOIL_BLOCKS = new Set([
  B.GRASS_BLOCK, B.DIRT, B.COARSE_DIRT, B.PODZOL, B.MYCELIUM, B.MOSS_BLOCK,
  B.MUD, B.FARMLAND, B.SNOW_BLOCK,
]);

/** Blocks a desert plant (cactus, dead bush) is allowed to grow on. @type {Set<number>} */
const SAND_BLOCKS = new Set([
  B.SAND, B.RED_SAND, B.TERRACOTTA, B.ORANGE_TERRACOTTA, B.RED_TERRACOTTA,
  B.WHITE_TERRACOTTA, B.YELLOW_TERRACOTTA, B.BROWN_TERRACOTTA,
  B.LIGHT_GRAY_TERRACOTTA, B.COARSE_DIRT,
]);

/** Stone-family blocks an ore vein may replace. @type {Set<number>} */
const ORE_HOST = new Set([
  B.STONE, B.GRANITE, B.DIORITE, B.ANDESITE, B.TUFF,
]);

/**
 * Blocks that the surface-rule pass is allowed to convert. Anything else
 * (bedrock, ores, structure blocks) is left untouched.
 * @type {Set<number>}
 */
const SURFACEABLE = new Set([
  B.STONE, B.DEEPSLATE, B.GRANITE, B.DIORITE, B.ANDESITE, B.TUFF, B.GRAVEL, B.DIRT,
]);

/**
 * Placement mask: `1` for blocks that may only be written into air or another
 * replaceable block (leaves, plants, snow, vines, water). Built once from the
 * block registry.
 * @type {Uint8Array}
 */
const SOFT_PLACE = (() => {
  const mask = new Uint8Array(BLOCK_COUNT);
  for (let id = 0; id < BLOCK_COUNT; id++) {
    if (id === B.AIR) continue;
    const render = blockRender(id);
    if (render === RENDER.CROSS || isReplaceable(id)) mask[id] = 1;
  }
  const softNames = [
    'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves',
    'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'azalea',
    'vine', 'moss_carpet', 'cobweb', 'snow_layer', 'water',
    'tube_coral_block', 'brain_coral_block', 'bubble_coral_block',
    'fire_coral_block', 'horn_coral_block', 'cactus', 'bamboo',
  ];
  for (let i = 0; i < softNames.length; i++) {
    const def = BLOCK_BY_NAME.get(softNames[i]);
    if (def !== undefined) mask[def.id] = 1;
  }
  return mask;
})();

/**
 * Overwrite mask: `1` for blocks a soft placement is allowed to replace.
 * @type {Uint8Array}
 */
const SOFT_TARGET = (() => {
  const mask = new Uint8Array(BLOCK_COUNT);
  mask[B.AIR] = 1;
  for (let id = 0; id < BLOCK_COUNT; id++) {
    if (isReplaceable(id) || blockRender(id) === RENDER.CROSS) mask[id] = 1;
  }
  return mask;
})();

// The biome table stores block *names*; resolve them once, here, so every
// `biome.surfaceBlockId` lookup below is a plain array read.
resolveBiomeBlocks(BLOCK_BY_NAME);

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

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
  if (s === null) return 0;
  return s[((y & 15) * CHUNK_SIZE + lz) * CHUNK_SIZE + lx];
}

/**
 * Write one block into a raw section array set, allocating the section on
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
  if (s === null) {
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
 * Turn a string or number seed into a stable uint32.
 * @param {number|string} seed raw seed
 * @returns {number} uint32 seed
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

/**
 * Redistribute an fbm sample across `[-1, 1]`.
 *
 * Summed-octave noise is roughly normal around 0, so raw values almost never
 * reach the tails and rare climates (desert, badlands, ice spikes) would never
 * be generated. `tanh` with a gain above one expands the crowded middle and
 * saturates smoothly at the ends, keeping the field continuous and monotone.
 * @param {number} v raw fbm sample
 * @param {number} gain expansion strength (`> 1` spreads)
 * @returns {number} redistributed value in `(-1, 1)`
 */
function spread(v, gain) {
  return Math.tanh(v * gain);
}

/**
 * Smootherstep-shaped fade in `[0, 1]`.
 * @param {number} e0 lower edge
 * @param {number} e1 upper edge
 * @param {number} x value
 * @returns {number} eased value
 */
function fade01(e0, e1, x) {
  if (e1 === e0) return x >= e1 ? 1 : 0;
  let t = (x - e0) / (e1 - e0);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/* -------------------------------------------------------------------------- */
/* WorldGenerator                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ColumnRegion
 * @property {number} cx chunk x
 * @property {number} cz chunk z
 * @property {number} gyCount vertical density grid levels
 * @property {number} gridTopY world y of the topmost grid level
 * @property {Float32Array} grid interpolated density values, `GRID_XZ * gyCount`
 * @property {Float32Array} varGrid stone-variant noise, same layout
 * @property {Int16Array} terrainTop topmost solid y per column (256)
 * @property {Float32Array} targetY pre-cave spline surface height per column (256)
 * @property {Int16Array} fluidLevel water-table y per column (256)
 * @property {Int16Array} deepslateY deepslate transition y per column (256)
 * @property {Uint8Array} biomes surface biome id per column (256)
 * @property {Uint8Array} surfaceDepth surface layer thickness per column (256)
 * @property {Uint16Array} surfaceTop resolved surface block id per column (256)
 * @property {Float32Array} climate 5 climate values per column (`256 * 5`)
 */

/**
 * The VOXELIA overworld generator.
 */
export class WorldGenerator {
  /**
   * @param {number|string} seed world seed (strings are hashed)
   * @param {Object} [options] generator switches
   * @param {boolean} [options.caves=true] carve caves and ravines
   * @param {boolean} [options.ores=true] place ore veins
   * @param {boolean} [options.features=true] place trees, plants and scatter
   * @param {boolean} [options.structures=true] place villages, mineshafts, ...
   * @param {boolean} [options.caveDecoration=true] moss and dripstone in caves
   * @param {number} [options.cacheSize=192] column regions kept in the LRU
   */
  constructor(seed, options = {}) {
    /** @type {number} uint32 world seed */
    this.seed = normalizeSeed(seed);

    /** @type {{caves:boolean, ores:boolean, features:boolean, structures:boolean, caveDecoration:boolean, cacheSize:number}} */
    this.options = {
      caves: options.caves !== false,
      ores: options.ores !== false,
      features: options.features !== false,
      structures: options.structures !== false,
      caveDecoration: options.caveDecoration !== false,
      cacheSize: Math.max(16, options.cacheSize | 0 || 192),
    };

    const s = this.seed;
    /* Climate fields. */
    this.nCont = new Noise(s + 1);
    this.nEros = new Noise(s + 2);
    this.nWeird = new Noise(s + 3);
    this.nTemp = new Noise(s + 4);
    this.nHumid = new Noise(s + 5);
    this.nWarp = new Noise(s + 6);
    this.nDetail2 = new Noise(s + 7);

    /* Density fields. */
    this.nShape = new Noise(s + 11);
    this.nFine = new Noise(s + 12);
    this.nVar = new Noise(s + 13);
    this.nJagged = new Noise(s + 14);

    /* Caves. */
    this.nCheese = new Noise(s + 21);
    this.nCheeseMod = new Noise(s + 22);
    this.nSpagA = new Noise(s + 23);
    this.nSpagB = new Noise(s + 24);
    this.nNoodleA = new Noise(s + 25);
    this.nNoodleB = new Noise(s + 26);
    this.nNoodleMask = new Noise(s + 27);
    this.nEntrance = new Noise(s + 28);
    this.nRavRegion = new Noise(s + 29);
    this.nRavLine = new Noise(s + 30);
    this.nRavTop = new Noise(s + 31);
    this.nRavDepth = new Noise(s + 32);

    /* Surface / aquifer. */
    this.nAquifer = new Noise(s + 41);
    this.nDeepslate = new Noise(s + 42);
    this.nSurfDepth = new Noise(s + 43);
    this.nPatch = new Noise(s + 44);

    /**
     * Badlands terracotta band table, indexed by `y mod 64`. Built once so the
     * bands are horizontal, continuous and identical for a given seed.
     * @type {Uint16Array}
     */
    this.badlandsBands = new Uint16Array(64);
    const bandRng = mulberry32(this.seed ^ 0x2f6d1c33);
    for (let i = 0; i < 64; i++) this.badlandsBands[i] = B.TERRACOTTA;
    for (let pass = 0; pass < 22; pass++) {
      const colour = BADLANDS_PALETTE[1 + ((bandRng() * (BADLANDS_PALETTE.length - 1)) | 0)];
      const start = (bandRng() * 64) | 0;
      const width = 1 + ((bandRng() * 3) | 0);
      for (let k = 0; k < width; k++) this.badlandsBands[(start + k) & 63] = colour;
    }

    /**
     * Deferred writes for structures that cross a chunk border.
     * @type {Map<string, Array<number[]>>}
     */
    this._pending = new Map();

    /**
     * LRU of computed column regions, keyed `"cx,cz"`.
     * @type {Map<string, ColumnRegion>}
     */
    this._cache = new Map();

    /** Scratch used by the grid pass; reused across chunks. @type {Float32Array} */
    this._gridTarget = new Float32Array(GRID_XZ);
    /** @type {Float32Array} */
    this._gridSquash = new Float32Array(GRID_XZ);
    /** @type {Float32Array} */
    this._gridAmp = new Float32Array(GRID_XZ);
    /** @type {Float32Array} climate per grid point: c, e, w, t, h */
    this._gridClimate = new Float32Array(GRID_XZ * 5);
  }

  /* ------------------------------------------------------------- climate -- */

  /**
   * Sample the five climate parameters at a world position into `out`.
   * All five live in `[-1, 1]`.
   * @param {number} wx world x
   * @param {number} wz world z
   * @param {Float32Array} out destination
   * @param {number} offset index of the first slot to write
   * @returns {void}
   */
  _sampleClimate(wx, wz, out, offset) {
    // Domain warp keeps coastlines and biome borders from looking like noise
    // contours.
    const warp = this.nWarp.domainWarp2(wx * 0.0011, wz * 0.0011, 42, 1);
    const cx = wx + warp[0];
    const cz = wz + warp[1];

    // The small positive biases push the land/ocean split toward ~62% land and
    // keep the world from reading as permanently frozen.
    out[offset] = spread(this.nCont.fbm2(cx * 0.00082, cz * 0.00082, 6) + 0.055, 2.55);
    out[offset + 1] = spread(this.nEros.fbm2(wx * 0.00155, wz * 0.00155, 5), 2.30);
    out[offset + 2] = spread(this.nWeird.fbm2(wx * 0.00295, wz * 0.00295, 5), 2.20);
    out[offset + 3] = spread(this.nTemp.fbm2(cx * 0.00046, cz * 0.00046, 4) + 0.045, 2.75);
    out[offset + 4] = spread(this.nHumid.fbm2(cx * 0.00061, cz * 0.00061, 4), 2.60);
  }

  /**
   * Peaks-and-valleys parameter derived from weirdness (the classic
   * `1 - |3|w| - 2|` folding).
   * @param {number} w weirdness in `[-1, 1]`
   * @returns {number} peaks-and-valleys in `[-1, 1]`
   */
  static peaksValleys(w) {
    const a = w < 0 ? -w : w;
    return 1 - Math.abs(3 * a - 2);
  }

  /* ------------------------------------------------------------- density -- */

  /**
   * Base density before caves: the height gradient plus 3D shape noise.
   * @param {number} wx world x
   * @param {number} wy world y
   * @param {number} wz world z
   * @param {number} target target surface height for this column
   * @param {number} squash vertical squash factor
   * @param {number} amp 3D noise amplitude
   * @returns {number} density (positive is solid)
   */
  _baseDensity(wx, wy, wz, target, squash, amp) {
    // The raw height gradient grows without bound with depth, which would make
    // deep rock impossible for the cave fields to carve — and would make cave
    // density depend on how high the terrain above happens to be. Clamping it
    // keeps the surface crisp and gives the whole underground one consistent
    // numeric range for the cave carve to work against.
    const dy = target - wy;
    let g = dy * squash;
    if (g > DENSITY_CAP) g = DENSITY_CAP;
    else if (g < -DENSITY_CAP) g = -DENSITY_CAP;

    // The 3D shape noise is what makes overhangs; it fades out with depth so
    // the deep world is uniformly solid rather than randomly denser under
    // mountains than under plains.
    const shapeFade = 1 - 0.62 * fade01(24, 80, dy);
    const coarse = this.nShape.fbm3(wx * 0.0092, wy * 0.0128, wz * 0.0092, 4);
    const fine = this.nFine.fbm3(wx * 0.0271, wy * 0.0343, wz * 0.0271, 2);
    let d = g + (coarse * 0.74 + fine * 0.26) * amp * shapeFade;

    // Jagged crests: extra ridged detail only where the terrain is already high.
    if (target > 120) {
      const jag = this.nJagged.ridged3(wx * 0.021, wy * 0.017, wz * 0.021, 2);
      d += (jag - 0.5) * fade01(120, 190, target) * 0.9;
    }

    // Guarantee a floor and a ceiling.
    const fromBottom = wy - WORLD_MIN_Y;
    if (fromBottom < 8) d += (8 - fromBottom) * 3.0;
    const toTop = WORLD_MAX_Y - 8 - wy;
    if (toTop < 8) d -= (8 - toTop) * 3.0;
    return d;
  }

  /**
   * Total cave carve strength at a point: cheese caverns, spaghetti tunnels,
   * noodle caves and ravines. Subtracted from the base density.
   * @param {number} wx world x
   * @param {number} wy world y
   * @param {number} wz world z
   * @param {number} target target surface height for this column
   * @returns {number} non-negative carve amount
   */
  _caveCarve(wx, wy, wz, target) {
    if (wy < WORLD_MIN_Y + 5) return 0;
    if (wy > target + 3) return 0;

    // Ravines are open chasms: they deliberately skip the near-surface fade
    // below, which is what lets them slice through the terrain and be visible
    // from the sky.
    const ravine = this._ravineCarve(wx, wy, wz, target);

    const below = target - wy;
    // Ordinary caves fade out as they approach the surface; the entrance field
    // switches that fade off over roughly 5% of the world so tunnels really do
    // break out onto hillsides.
    let fade = below >= 14 ? 1 : (below <= 0 ? 0 : below / 14);
    if (fade < 1) {
      const entrance = this.nEntrance.perlin2(wx * 0.0057, wz * 0.0057);
      if (entrance > 0.60) fade = 1;
      else if (entrance > 0.45) fade = Math.max(fade, (entrance - 0.45) / 0.15);
    }
    if (fade <= 0) return ravine;

    let carve = 0;

    // 1. Cheese caves: large blobby caverns.
    const cheese = this.nCheese.fbm3(wx * 0.0082, wy * 0.0122, wz * 0.0082, 3);
    const cheeseT = 0.32 + 0.15 * this.nCheeseMod.perlin2(wx * 0.0013, wz * 0.0013);
    if (cheese > cheeseT) carve += (cheese - cheeseT) * 24;

    // 2. Spaghetti caves: the intersection of two iso-surfaces is a tube.
    const sa = this.nSpagA.perlin3(wx * 0.0193, wy * 0.0122, wz * 0.0193);
    const sb = this.nSpagB.perlin3(wx * 0.0193, wy * 0.0122, wz * 0.0193);
    const sm = Math.max(sa < 0 ? -sa : sa, sb < 0 ? -sb : sb);
    if (sm < 0.068) carve += (1 - sm / 0.068) * 9.0;

    // 3. Noodle caves: thin and winding, only inside masked regions.
    if (below > 8) {
      const mask = this.nNoodleMask.perlin2(wx * 0.0021, wz * 0.0021);
      if (mask > 0.05) {
        const na = this.nNoodleA.perlin3(wx * 0.0405, wy * 0.0512, wz * 0.0405);
        const nb = this.nNoodleB.perlin3(wx * 0.0405, wy * 0.0512, wz * 0.0405);
        const nm = Math.max(na < 0 ? -na : na, nb < 0 ? -nb : nb);
        if (nm < 0.042) carve += (1 - nm / 0.042) * 7.5 * Math.min(1, mask * 4);
      }
    }

    return carve * fade + ravine;
  }

  /**
   * Ravine carve: a winding vertical slab following an iso-line of a 2D field,
   * confined to sparse regions and tapered toward its floor.
   * @param {number} wx world x
   * @param {number} wy world y
   * @param {number} wz world z
   * @param {number} target target surface height for this column
   * @returns {number} non-negative carve amount
   */
  _ravineCarve(wx, wy, wz, target) {
    const region = this.nRavRegion.perlin2(wx * 0.00097, wz * 0.00097);
    if (region < 0.55) return 0;

    const line = this.nRavLine.perlin2(wx * 0.0038, wz * 0.0038);
    const half = 0.009 + 0.020 * (region - 0.55);
    const a = line < 0 ? -line : line;
    if (a >= half) return 0;
    const across = 1 - a / half;

    const topY = target - Math.round(2 + 5 * this.nRavTop.perlin2(wx * 0.007, wz * 0.007));
    const depth = 26 + 36 * (0.5 + 0.5 * this.nRavDepth.perlin2(wx * 0.0052, wz * 0.0052));
    const botY = topY - depth;
    if (wy > topY || wy < botY) return 0;

    const v = (wy - botY) / (topY - botY);
    const taper = 0.32 + 0.68 * Math.sqrt(v);
    return across * taper * 13;
  }

  /* --------------------------------------------------------- column pass -- */

  /**
   * Compute (or fetch from the LRU) the per-column data of one chunk: the
   * density grid, biomes, terrain heights, water table and surface blocks.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @returns {ColumnRegion} region data (owned by the cache — treat as const)
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
    const region = this._computeColumns(cx, cz);
    this._cache.set(key, region);
    if (this._cache.size > this.options.cacheSize) {
      const oldest = this._cache.keys().next();
      if (!oldest.done) this._cache.delete(oldest.value);
    }
    return region;
  }

  /**
   * Build the density grid and column tables for one chunk.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @returns {ColumnRegion} freshly computed region
   */
  _computeColumns(cx, cz) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const gTarget = this._gridTarget;
    const gSquash = this._gridSquash;
    const gAmp = this._gridAmp;
    const gClim = this._gridClimate;

    // --- 1. Climate + shaping on the 5x5 grid -----------------------------
    let maxTarget = WORLD_MIN_Y;
    for (let gz = 0; gz < GRID_N; gz++) {
      for (let gx = 0; gx < GRID_N; gx++) {
        const gi = gz * GRID_N + gx;
        const wx = ox + gx * CELL_XZ;
        const wz = oz + gz * CELL_XZ;
        this._sampleClimate(wx, wz, gClim, gi * 5);

        const c = gClim[gi * 5];
        const e = gClim[gi * 5 + 1];
        const w = gClim[gi * 5 + 2];

        const erosionAmp = SPLINE_EROSION(e);
        const pv = WorldGenerator.peaksValleys(w);
        // Peaks only grow inland. Without this factor a coastal cell with a
        // high peaks-and-valleys value would raise an 80-block "beach" right
        // at the waterline.
        const inland = 0.10 + 0.90 * fade01(-0.04, 0.38, c);
        let target = SEA_LEVEL + SPLINE_CONTINENTAL(c) + erosionAmp * SPLINE_PEAKS(pv) * inland;
        target += this.nDetail2.fbm2(wx * 0.0125, wz * 0.0125, 3) * (2 + 6 * erosionAmp);

        // Rare oceanic islands, aligned with the weirdness band that
        // `selectBiome` turns into mushroom fields.
        const isle = fade01(0.84, 0.96, w) * fade01(-0.11, -0.40, c);
        if (isle > 0) target = lerp(target, SEA_LEVEL + 12 + 16 * erosionAmp, isle);

        let squash = SPLINE_SQUASH(e);
        let amp = 0.55 + 1.25 * erosionAmp;

        // Rivers: a smooth channel wherever weirdness crosses zero on land.
        const aw = w < 0 ? -w : w;
        if (aw < RIVER_HALF_WIDTH && c > -0.11 && e > -0.4) {
          const t = 1 - aw / RIVER_HALF_WIDTH;
          const carve = t * t * (3 - 2 * t);
          target += (SEA_LEVEL - 4.5 - target) * carve * 0.92;
          squash = lerp(squash, 0.46, carve * 0.85);
          amp = lerp(amp, 0.22, carve);
        }

        // Oceans are smoother than land and never overhang.
        if (c < -0.19) {
          const oceanic = fade01(-0.19, -0.5, c);
          amp *= 1 - 0.5 * oceanic;
          squash += 0.16 * oceanic;
        }

        gTarget[gi] = target;
        gSquash[gi] = squash;
        gAmp[gi] = amp;
        if (target > maxTarget) maxTarget = target;
      }
    }

    // --- 2. Density grid ---------------------------------------------------
    const topY = Math.max(maxTarget + 32, SEA_LEVEL + 6);
    let gyCount = Math.ceil((topY - WORLD_MIN_Y) * INV_CELL_Y) + 1;
    if (gyCount > MAX_GY) gyCount = MAX_GY;
    if (gyCount < 8) gyCount = 8;
    const gridTopY = WORLD_MIN_Y + (gyCount - 1) * CELL_Y;

    const grid = new Float32Array(GRID_XZ * gyCount);
    const varGrid = new Float32Array(GRID_XZ * gyCount);
    const caves = this.options.caves;

    for (let gz = 0; gz < GRID_N; gz++) {
      for (let gx = 0; gx < GRID_N; gx++) {
        const gi = gz * GRID_N + gx;
        const wx = ox + gx * CELL_XZ;
        const wz = oz + gz * CELL_XZ;
        const target = gTarget[gi];
        const squash = gSquash[gi];
        const amp = gAmp[gi];
        const base = gi * gyCount;
        // Well above this column's target height the field is unconditionally
        // air (the gradient beats the largest possible noise excursion), so
        // the noise is skipped entirely — a large saving in a chunk where one
        // corner is a mountain peak and the rest is a valley.
        const skipAbove = target + AIR_MARGIN;
        for (let gy = 0; gy < gyCount; gy++) {
          const wy = WORLD_MIN_Y + gy * CELL_Y;
          if (wy > skipAbove) {
            grid[base + gy] = -2;
            varGrid[base + gy] = 0;
            continue;
          }
          let d = this._baseDensity(wx, wy, wz, target, squash, amp);
          if (caves) d -= this._caveCarve(wx, wy, wz, target);
          grid[base + gy] = d;
          varGrid[base + gy] = this.nVar.fbm3(wx * 0.0335, wy * 0.0455, wz * 0.0335, 2);
        }
      }
    }

    // --- 3. Per-column climate, biome and derived tables -------------------
    const terrainTop = new Int16Array(256);
    const targetY = new Float32Array(256);
    const fluidLevel = new Int16Array(256);
    const deepslateY = new Int16Array(256);
    const biomes = new Uint8Array(256);
    const surfaceDepth = new Uint8Array(256);
    const surfaceTop = new Uint16Array(256);
    const climate = new Float32Array(256 * 5);

    /** @type {ColumnRegion} */
    const region = {
      cx, cz, gyCount, gridTopY, grid, varGrid,
      terrainTop, targetY, fluidLevel, deepslateY, biomes, surfaceDepth, surfaceTop, climate,
    };

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const fz = lz * INV_CELL_XZ;
      let gz = fz | 0;
      if (gz > GRID_N - 2) gz = GRID_N - 2;
      const tz = fz - gz;

      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const fx = lx * INV_CELL_XZ;
        let gx = fx | 0;
        if (gx > GRID_N - 2) gx = GRID_N - 2;
        const tx = fx - gx;

        const g00 = gz * GRID_N + gx;
        const g10 = g00 + 1;
        const g01 = g00 + GRID_N;
        const g11 = g01 + 1;
        const i00 = g00 * 5;
        const i10 = g10 * 5;
        const i01 = g01 * 5;
        const i11 = g11 * 5;
        const col = lz * CHUNK_SIZE + lx;
        const wx = ox + lx;
        const wz = oz + lz;

        // Pre-cave spline height. The aquifer uses this rather than the carved
        // terrain height, otherwise every ravine that cut below sea level
        // would report itself as an ocean column and flood.
        const ta = gTarget[g00] + (gTarget[g10] - gTarget[g00]) * tx;
        const tb = gTarget[g01] + (gTarget[g11] - gTarget[g01]) * tx;
        const colTarget = ta + (tb - ta) * tz;
        targetY[col] = colTarget;

        // Bilinear climate so biome borders stay smooth.
        for (let k = 0; k < 5; k++) {
          const a = gClim[i00 + k] + (gClim[i10 + k] - gClim[i00 + k]) * tx;
          const b = gClim[i01 + k] + (gClim[i11 + k] - gClim[i01 + k]) * tx;
          climate[col * 5 + k] = a + (b - a) * tz;
        }

        // Terrain height from the interpolated density field.
        let top = NO_TERRAIN;
        for (let y = gridTopY - 1; y >= WORLD_MIN_Y; y--) {
          if (this._sampleDensity(region, lx, y, lz) > 0) { top = y; break; }
        }
        terrainTop[col] = top;

        // Altitude-adjusted temperature so high ground reads as alpine.
        const cC = climate[col * 5];
        const cE = climate[col * 5 + 1];
        const cW = climate[col * 5 + 2];
        let cT = climate[col * 5 + 3];
        const cH = climate[col * 5 + 4];
        const surfaceY = top === NO_TERRAIN ? WORLD_MIN_Y : top;
        if (surfaceY > 96) cT -= clamp((surfaceY - 96) / 190, 0, 0.62);
        biomes[col] = selectBiome(cC, cE, clamp(cT, -1, 1), cH, cW, 0);

        fluidLevel[col] = this._aquiferLevel(wx, wz, surfaceY, colTarget);
        deepslateY[col] = -2 + Math.round(this.nDeepslate.perlin2(wx * 0.083, wz * 0.083) * 6);
        surfaceDepth[col] = 3 + (((this.nSurfDepth.perlin2(wx * 0.091, wz * 0.091) + 1) * 1.6) | 0);
        surfaceTop[col] = this._surfaceTopBlock(
          biomes[col], wx, surfaceY, wz, surfaceY < fluidLevel[col],
        );
      }
    }
    return region;
  }

  /**
   * Trilinearly interpolate the density grid at a chunk-local position.
   * @param {ColumnRegion} reg region data
   * @param {number} lx chunk-local x, `0..15`
   * @param {number} y world y
   * @param {number} lz chunk-local z, `0..15`
   * @returns {number} density (positive is solid)
   */
  _sampleDensity(reg, lx, y, lz) {
    const gyCount = reg.gyCount;
    const fy = (y - WORLD_MIN_Y) * INV_CELL_Y;
    if (fy < 0) return 1000;
    const gy = fy | 0;
    if (gy >= gyCount - 1) return -1000;
    const ty = fy - gy;

    const fx = lx * INV_CELL_XZ;
    let gx = fx | 0;
    if (gx > GRID_N - 2) gx = GRID_N - 2;
    const tx = fx - gx;

    const fz = lz * INV_CELL_XZ;
    let gz = fz | 0;
    if (gz > GRID_N - 2) gz = GRID_N - 2;
    const tz = fz - gz;

    const g = reg.grid;
    const b00 = (gz * GRID_N + gx) * gyCount + gy;
    const b10 = (gz * GRID_N + gx + 1) * gyCount + gy;
    const b01 = ((gz + 1) * GRID_N + gx) * gyCount + gy;
    const b11 = ((gz + 1) * GRID_N + gx + 1) * gyCount + gy;

    const e00 = g[b00] + (g[b00 + 1] - g[b00]) * ty;
    const e10 = g[b10] + (g[b10 + 1] - g[b10]) * ty;
    const e01 = g[b01] + (g[b01 + 1] - g[b01]) * ty;
    const e11 = g[b11] + (g[b11 + 1] - g[b11]) * ty;

    const f0 = e00 + (e01 - e00) * tz;
    const f1 = e10 + (e11 - e10) * tz;
    return f0 + (f1 - f0) * tx;
  }

  /**
   * Local water table for a column.
   *
   * Ocean, river and lake columns (terrain at or below sea level) clamp to
   * `SEA_LEVEL`, so a cave carved under the sea floor fills with water instead
   * of draining the ocean. Inland columns get a smooth noise level that is
   * usually far below the world, producing dry caves with occasional
   * underground lakes; the level is additionally capped a few blocks under the
   * terrain so no water ever hangs on a hillside.
   *
   * @param {number} wx world x
   * @param {number} wz world z
   * @param {number} surfaceY carved terrain surface y for this column
   * @param {number} targetY pre-cave spline surface height for this column
   * @returns {number} highest y that is filled with fluid
   */
  _aquiferLevel(wx, wz, surfaceY, targetY) {
    // `spread` flattens the fbm distribution, then a cubic curve pushes most
    // columns far below the world so the majority of caves stay dry; the few
    // that come up high are the underground lakes.
    const n = spread(this.nAquifer.fbm2(wx * 0.0042, wz * 0.0042, 3), 2.4);
    const t = (n + 1) * 0.5;
    const s = t * t * t;
    let inland = Math.round(lerp(AQUIFER_FLOOR, SEA_LEVEL - 3, s));
    const cap = surfaceY - 5;
    if (inland > cap) inland = cap;

    // Blend to sea level as the terrain sinks toward (and under) the sea. The
    // *uncarved* height decides this, so a flooded basin is a real lake or sea
    // rather than a ravine that happened to cut below y=62.
    const oceanic = fade01(SEA_LEVEL + 3, SEA_LEVEL - 3, targetY);
    const level = Math.round(lerp(inland, SEA_LEVEL, oceanic));
    return level < WORLD_MIN_Y - 2 ? WORLD_MIN_Y - 2 : level;
  }

  /* --------------------------------------------------------------- fill --- */

  /**
   * Pick the stone-family block for a solid voxel from the variant noise and
   * the deepslate line.
   * @param {number} v variant noise in `[-1, 1]`
   * @param {number} y world y
   * @param {number} dsY deepslate transition y for this column
   * @returns {number} block id
   */
  _stoneBlock(v, y, dsY) {
    if (y <= dsY) {
      if (v < -0.44 && v > -0.60) return B.TUFF;
      return B.DEEPSLATE;
    }
    if (v > 0.49) return B.GRANITE;
    if (v > 0.44) return B.ANDESITE;
    if (v < -0.49) return B.DIORITE;
    if (v < -0.44) return B.ANDESITE;
    if (y < 54 && v > 0.300 && v < 0.320) return B.GRAVEL;
    if (y > 6 && v < -0.300 && v > -0.325) return B.DIRT;
    return B.STONE;
  }

  /**
   * Fill the chunk's sections from the interpolated density field: stone
   * family, deepslate, aquifer water and the deep lava sea.
   * @param {ColumnRegion} reg region data
   * @param {(Uint16Array|null)[]} sections destination sections
   * @returns {void}
   */
  _fillTerrain(reg, sections) {
    const gyCount = reg.gyCount;
    const grid = reg.grid;
    const varGrid = reg.varGrid;
    const fluid = reg.fluidLevel;
    const dsY = reg.deepslateY;

    for (let gz = 0; gz < GRID_N - 1; gz++) {
      for (let gx = 0; gx < GRID_N - 1; gx++) {
        const b00 = (gz * GRID_N + gx) * gyCount;
        const b10 = (gz * GRID_N + gx + 1) * gyCount;
        const b01 = ((gz + 1) * GRID_N + gx) * gyCount;
        const b11 = ((gz + 1) * GRID_N + gx + 1) * gyCount;

        for (let gy = 0; gy < gyCount - 1; gy++) {
          const d000 = grid[b00 + gy];
          const d001 = grid[b00 + gy + 1];
          const d100 = grid[b10 + gy];
          const d101 = grid[b10 + gy + 1];
          const d010 = grid[b01 + gy];
          const d011 = grid[b01 + gy + 1];
          const d110 = grid[b11 + gy];
          const d111 = grid[b11 + gy + 1];
          const v000 = varGrid[b00 + gy];
          const v001 = varGrid[b00 + gy + 1];
          const v100 = varGrid[b10 + gy];
          const v101 = varGrid[b10 + gy + 1];
          const v010 = varGrid[b01 + gy];
          const v011 = varGrid[b01 + gy + 1];
          const v110 = varGrid[b11 + gy];
          const v111 = varGrid[b11 + gy + 1];
          const baseY = WORLD_MIN_Y + gy * CELL_Y;

          for (let sy = 0; sy < CELL_Y; sy++) {
            const y = baseY + sy;
            if (y >= WORLD_MAX_Y) break;
            const ty = sy * INV_CELL_Y;
            const e00 = d000 + (d001 - d000) * ty;
            const e10 = d100 + (d101 - d100) * ty;
            const e01 = d010 + (d011 - d010) * ty;
            const e11 = d110 + (d111 - d110) * ty;
            const w00 = v000 + (v001 - v000) * ty;
            const w10 = v100 + (v101 - v100) * ty;
            const w01 = v010 + (v011 - v010) * ty;
            const w11 = v110 + (v111 - v110) * ty;
            const deepLava = y <= LAVA_LEVEL;

            for (let sz = 0; sz < CELL_XZ; sz++) {
              const lz = gz * CELL_XZ + sz;
              const tz = sz * INV_CELL_XZ;
              const f0 = e00 + (e01 - e00) * tz;
              const f1 = e10 + (e11 - e10) * tz;
              const q0 = w00 + (w01 - w00) * tz;
              const q1 = w10 + (w11 - w10) * tz;
              const rowBase = lz * CHUNK_SIZE;

              for (let sx = 0; sx < CELL_XZ; sx++) {
                const lx = gx * CELL_XZ + sx;
                const tx = sx * INV_CELL_XZ;
                const d = f0 + (f1 - f0) * tx;
                let id;
                if (d > 0) {
                  const v = q0 + (q1 - q0) * tx;
                  id = this._stoneBlock(v, y, dsY[rowBase + lx]);
                } else if (deepLava) {
                  id = B.LAVA;
                } else if (y <= fluid[rowBase + lx]) {
                  id = B.WATER;
                } else {
                  continue;
                }
                sectionSet(sections, lx, y, lz, id);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Lay a rough one-to-five layer bedrock floor.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections destination sections
   * @returns {void}
   */
  _applyBedrock(cx, cz, sections) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = ox + lx;
        const wz = oz + lz;
        for (let k = 0; k < BEDROCK_LAYERS; k++) {
          const y = WORLD_MIN_Y + k;
          if (k === 0) {
            sectionSet(sections, lx, y, lz, B.BEDROCK);
            continue;
          }
          const p = (BEDROCK_LAYERS - k) / BEDROCK_LAYERS;
          if (hashUnit(wx, y, wz, this.seed ^ SALT_BEDROCK) < p) {
            sectionSet(sections, lx, y, lz, B.BEDROCK);
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------ surface --- */

  /**
   * Terracotta colour for a badlands band at a given altitude.
   * @param {number} y world y
   * @returns {number} block id
   */
  _badlandsBand(y) {
    return this.badlandsBands[((y % 64) + 64) & 63];
  }

  /**
   * Block placed on top of an exposed solid run.
   * @param {number} biomeId biome id
   * @param {number} wx world x
   * @param {number} wy world y of the block being written
   * @param {number} wz world z
   * @param {boolean} underwater whether fluid sits directly above
   * @returns {number} block id
   */
  _surfaceTopBlock(biomeId, wx, wy, wz, underwater) {
    const b = getBiome(biomeId);
    const name = b.name;

    if (underwater) {
      if (name === 'swamp' || name === 'mangrove_swamp') return B.MUD;
      if (name === 'lush_caves') return B.CLAY;
      // Coastal shelves get patchy clay and sand.
      if (this.nPatch.perlin2(wx * 0.07, wz * 0.07) > 0.62 && wy > SEA_LEVEL - 12) {
        return B.CLAY;
      }
      return b.underwaterBlockId;
    }

    if (name.indexOf('badlands') >= 0) {
      if (wy <= 70) return B.RED_SAND;
      if (name === 'wooded_badlands' && wy > 97) return B.COARSE_DIRT;
      return this._badlandsBand(wy);
    }

    if (name === 'stony_shore') {
      return hashUnit(wx, wy, wz, this.seed ^ SALT_SHORE) < 0.38 ? B.GRAVEL : B.STONE;
    }

    // Snow line: deep alpine snow well above it, plain surface block below.
    const t = biomeTemperatureAt(biomeId, wy);
    if (t < -0.22 && wy > 128 && b.precipitation !== 'none') return B.SNOW_BLOCK;

    return b.surfaceBlockId;
  }

  /**
   * Block placed just below the surface of an exposed solid run.
   * @param {number} biomeId biome id
   * @param {number} wy world y of the block being written
   * @param {boolean} underwater whether the run top was submerged
   * @returns {number} block id
   */
  _surfaceSubBlock(biomeId, wy, underwater) {
    const b = getBiome(biomeId);
    const name = b.name;
    if (name.indexOf('badlands') >= 0) {
      if (wy <= 70) return B.RED_SANDSTONE;
      return this._badlandsBand(wy);
    }
    if (underwater) return b.underwaterBlockId;
    if (name === 'stony_shore') return B.STONE;
    return b.subSurfaceBlockId;
  }

  /**
   * Apply the per-biome surface rules over the whole chunk, then add snow
   * layers and freeze exposed water in cold biomes.
   * @param {ColumnRegion} reg region data
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @returns {void}
   */
  _applySurface(reg, sections, cx, cz) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const col = lz * CHUNK_SIZE + lx;
        const top = reg.terrainTop[col];
        if (top === NO_TERRAIN) continue;
        const wx = ox + lx;
        const wz = oz + lz;
        const biomeId = reg.biomes[col];
        const sd = reg.surfaceDepth[col];
        const fl = reg.fluidLevel[col];

        let run = 0;
        let gap = 99;
        let surfaced = false;
        let aboveWater = false;

        // Start one block above the topmost solid so the very first iteration
        // records whether the surface is submerged before it is written.
        for (let y = top + 1; y > WORLD_MIN_Y; y--) {
          const id = sectionGet(sections, lx, y, lz);
          if (id === B.AIR || id === B.WATER || id === B.LAVA) {
            run = 0;
            surfaced = false;
            gap++;
            aboveWater = id === B.WATER;
            continue;
          }
          if (!SURFACEABLE.has(id)) {
            run = 0;
            surfaced = false;
            gap = 0;
            continue;
          }
          run++;
          if (run === 1) {
            surfaced = y >= top - 24 && gap >= 2;
            gap = 0;
            if (surfaced) {
              const surf = this._surfaceTopBlock(biomeId, wx, y, wz, aboveWater);
              sectionSet(sections, lx, y, lz, surf);
              if (!aboveWater) this._decorateSurfaceTop(sections, biomeId, lx, y, lz, wx, wz);
            }
          } else if (surfaced && run <= sd) {
            sectionSet(sections, lx, y, lz, this._surfaceSubBlock(biomeId, y, aboveWater));
          }
        }

        // Freeze exposed water in cold biomes.
        if (fl >= top && fl > LAVA_LEVEL && fl < WORLD_MAX_Y) {
          if (sectionGet(sections, lx, fl, lz) === B.WATER
              && sectionGet(sections, lx, fl + 1, lz) === B.AIR
              && biomeTemperatureAt(biomeId, fl) < 0.15) {
            const packed = hashUnit(wx, fl, wz, this.seed ^ SALT_SHORE) < 0.08;
            sectionSet(sections, lx, fl, lz, packed ? B.PACKED_ICE : B.ICE);
          }
        }
      }
    }
  }

  /**
   * Snow cover on top of an exposed land surface.
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @param {number} biomeId biome id
   * @param {number} lx chunk-local x
   * @param {number} y surface y
   * @param {number} lz chunk-local z
   * @param {number} wx world x
   * @param {number} wz world z
   * @returns {void}
   */
  _decorateSurfaceTop(sections, biomeId, lx, y, lz, wx, wz) {
    if (biomePrecipitationAt(biomeId, y + 1) !== 'snow') return;
    if (sectionGet(sections, lx, y + 1, lz) !== B.AIR) return;

    const t = biomeTemperatureAt(biomeId, y + 1);
    // Above the snow line proper the cover thickens into full snow blocks —
    // this build has no powder snow, so deep snow stands in for it.
    if (t < -0.30 && y > 140) {
      const layers = 1 + ((hashUnit(wx, y, wz, this.seed ^ 0x3ac1) * 2) | 0);
      for (let k = 1; k <= layers; k++) sectionSet(sections, lx, y + k, lz, B.SNOW_BLOCK);
      sectionSet(sections, lx, y + layers + 1, lz, B.SNOW_LAYER);
      return;
    }
    sectionSet(sections, lx, y + 1, lz, B.SNOW_LAYER);
  }

  /* ------------------------------------------------------- cave decoration */

  /**
   * Dress underground biomes: moss and azalea shrubs in lush caves, dripstone
   * spikes in dripstone caves.
   * @param {ColumnRegion} reg region data
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @returns {void}
   */
  _decorateCaves(reg, sections, cx, cz) {
    const rng = mulberry32(xxhash32(cx, cz, this.seed, SALT_CAVE_DECOR));
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        if (rng() > 0.34) continue;
        const col = lz * CHUNK_SIZE + lx;
        const base = col * 5;
        const caveBiome = selectBiome(
          reg.climate[base], reg.climate[base + 1], reg.climate[base + 3],
          reg.climate[base + 4], reg.climate[base + 2], 0.86,
        );
        const name = getBiome(caveBiome).name;
        if (name !== 'lush_caves' && name !== 'dripstone_caves') continue;

        const topScan = Math.min(reg.terrainTop[col] - 8, 46);
        let air = 0;
        for (let y = topScan; y > WORLD_MIN_Y + 2; y--) {
          const id = sectionGet(sections, lx, y, lz);
          if (id === B.AIR) { air++; continue; }
          if (id !== B.STONE && id !== B.DEEPSLATE && id !== B.TUFF
              && id !== B.ANDESITE && id !== B.GRANITE && id !== B.DIORITE) {
            air = 0;
            continue;
          }
          if (air >= 3) {
            if (name === 'lush_caves') {
              sectionSet(sections, lx, y, lz, B.MOSS_BLOCK);
              const r = rng();
              if (r < 0.22) sectionSet(sections, lx, y + 1, lz, B.MOSS_CARPET);
              else if (r < 0.30) sectionSet(sections, lx, y + 1, lz, B.SHORT_GRASS);
              else if (r < 0.33) {
                placeTree(
                  (bx, by, bz, bid) => {
                    const dx = bx - ox;
                    const dz = bz - oz;
                    if (dx < 0 || dx > 15 || dz < 0 || dz > 15) return;
                    if (SOFT_PLACE[bid] === 1
                        && SOFT_TARGET[sectionGet(sections, dx, by, dz)] === 0) return;
                    sectionSet(sections, dx, by, dz, bid);
                  },
                  rng, ox + lx, y, oz + lz, 'azalea',
                );
              }
            } else {
              const h = 1 + ((rng() * 3) | 0);
              for (let k = 1; k <= h; k++) {
                if (sectionGet(sections, lx, y + k, lz) !== B.AIR) break;
                sectionSet(sections, lx, y + k, lz, B.DRIPSTONE_BLOCK);
              }
              sectionSet(sections, lx, y, lz, B.DRIPSTONE_BLOCK);
            }
          }
          air = 0;
        }
      }
    }
  }

  /* ----------------------------------------------------------------- ores - */

  /**
   * Place every ore vein whose centre lies in the 3x3 chunk neighbourhood,
   * clipping the writes to the chunk being generated. Doing the neighbourhood
   * means a vein is never cut in half by a chunk border, whatever order chunks
   * are generated in.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {void}
   */
  _generateOres(cx, cz, sections) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    let stoneId = B.STONE;
    let deepId = B.STONE;

    /**
     * Ore writer: only replaces stone-family blocks inside this chunk, and
     * swaps in the deepslate variant when it finds deepslate.
     * @param {number} x world x
     * @param {number} y world y
     * @param {number} z world z
     * @returns {void}
     */
    const write = (x, y, z) => {
      const lx = x - ox;
      const lz = z - oz;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return;
      if (y <= WORLD_MIN_Y + 1 || y >= WORLD_MAX_Y) return;
      const cur = sectionGet(sections, lx, y, lz);
      if (cur === B.DEEPSLATE) sectionSet(sections, lx, y, lz, deepId);
      else if (ORE_HOST.has(cur)) sectionSet(sections, lx, y, lz, stoneId);
    };

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ncx = cx + dx;
        const ncz = cz + dz;
        const nox = ncx * CHUNK_SIZE;
        const noz = ncz * CHUNK_SIZE;

        for (let o = 0; o < ORES.length; o++) {
          const ore = ORES[o];
          stoneId = ore.block;
          deepId = ore.deep;
          // Each ore gets its own stream, so adding or removing an entry never
          // reshuffles the others and a skipped biome-gated ore costs nothing.
          const rng = mulberry32(xxhash32(ncx, ncz, this.seed, SALT_ORES + o * 0x9e37));

          if (ore.biomes !== 'any') {
            const nreg = this._regionFor(ncx, ncz);
            const name = getBiome(nreg.biomes[8 * CHUNK_SIZE + 8]).name;
            const ok = ore.biomes === 'mountain'
              ? MOUNTAIN_BIOMES.has(name)
              : name.indexOf('badlands') >= 0;
            if (!ok) continue;
          }

          for (let i = 0; i < ore.count; i++) {
            const rx = rng();
            const rz = rng();
            const ry = rng();
            const rc = rng();
            if (rc > ore.chance) continue;
            const vx = nox + ((rx * CHUNK_SIZE) | 0);
            const vz = noz + ((rz * CHUNK_SIZE) | 0);
            let t;
            if (ore.shape === 'triangle') t = (ry + rc) * 0.5;
            else if (ore.shape === 'low') t = ry < rc ? ry : rc;
            else t = ry;
            const vy = ore.minY + Math.round(t * (ore.maxY - ore.minY));
            placeOreVein(write, rng, vx, vy, vz, stoneId, ore.size);
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------- features - */

  /**
   * Build the writer used by the small-feature pass: it clips to the chunk
   * being generated and refuses to bury solid terrain under leaves or plants.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {(x:number,y:number,z:number,id:number)=>void} writer
   */
  _makeClippedWriter(cx, cz, sections) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    return (x, y, z, id) => {
      const lx = x - ox;
      const lz = z - oz;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return;
      if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
      const cur = sectionGet(sections, lx, y, lz);
      if (cur === B.BEDROCK) return;
      if (SOFT_PLACE[id] === 1 && SOFT_TARGET[cur] === 0) return;
      sectionSet(sections, lx, y, lz, id);
    };
  }

  /**
   * Build the writer used by large structures: writes inside the chunk are
   * applied immediately, writes outside are buffered as pending edits for the
   * target chunk.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {(x:number,y:number,z:number,id:number)=>void} writer
   */
  _makeStructureWriter(cx, cz, sections) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const pending = this._pending;
    return (x, y, z, id) => {
      if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
      const lx = x - ox;
      const lz = z - oz;
      if (lx >= 0 && lx <= 15 && lz >= 0 && lz <= 15) {
        if (sectionGet(sections, lx, y, lz) === B.BEDROCK) return;
        sectionSet(sections, lx, y, lz, id);
        return;
      }
      const tcx = x >> 4;
      const tcz = z >> 4;
      const key = tcx + ',' + tcz;
      let list = pending.get(key);
      if (list === undefined) {
        list = [];
        pending.set(key, list);
      }
      list.push([x, y, z, id]);
    };
  }

  /**
   * Run the tree / plant / scatter pass for the 3x3 chunk neighbourhood,
   * clipping every write to the chunk being generated.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {void}
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
   * Generate the features owned by one chunk. Deterministic in `(cx, cz, seed)`
   * so the same trees appear no matter which neighbour asks for them.
   * @param {number} cx chunk x that owns the features
   * @param {number} cz chunk z that owns the features
   * @param {(x:number,y:number,z:number,id:number)=>void} write clipped writer
   * @returns {void}
   */
  _featurePass(cx, cz, write) {
    const reg = this._regionFor(cx, cz);
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const rng = mulberry32(xxhash32(cx, cz, this.seed, SALT_TREES));
    const centreCol = 8 * CHUNK_SIZE + 8;
    const centreBiome = reg.biomes[centreCol];
    const bdef = getBiome(centreBiome);
    const feats = bdef.features;

    /* --- Trees ---------------------------------------------------------- */
    // The attempt budget comes from the densest biome present in the chunk and
    // every attempt is then accepted with `columnDensity / maxDensity`. That
    // gives each column its own biome's density while keeping the transition
    // across a chunk border (and across a biome border) seamless.
    const maxTree = this._maxDensity(reg, TREE_DENSITY);
    let attempts = maxTree | 0;
    if (rng() < maxTree - attempts) attempts++;
    for (let i = 0; i < attempts; i++) {
      const lx = (rng() * CHUNK_SIZE) | 0;
      const lz = (rng() * CHUNK_SIZE) | 0;
      const col = lz * CHUNK_SIZE + lx;
      const colBiome = reg.biomes[col];
      if (rng() * maxTree > getBiome(colBiome).treeDensity) continue;
      const y = reg.terrainTop[col];
      if (y === NO_TERRAIN || y < reg.fluidLevel[col]) continue;
      if (!SOIL_BLOCKS.has(reg.surfaceTop[col])) continue;
      const type = pickTreeType(colBiome, rng);
      if (type === null) continue;
      placeTree(write, rng, ox + lx, y, oz + lz, type);
    }

    /* --- Ground cover --------------------------------------------------- */
    const plantRng = mulberry32(xxhash32(cx, cz, this.seed, SALT_PLANTS));
    const maxCover = this._maxDensity(reg, COVER_DENSITY);
    let plantTries = (maxCover * 0.6) | 0;
    if (plantRng() < maxCover * 0.6 - plantTries) plantTries++;
    // Sparse biomes still deserve their signature plant, so guarantee a try
    // and give cactus/cane biomes a couple of extra ones.
    if (maxCover > 0 && plantTries < 1) plantTries = 1;
    if (hasTag(feats, 'cactus')) plantTries += 2;
    if (hasTag(feats, 'sugar_cane')) plantTries += 2;
    for (let i = 0; i < plantTries; i++) {
      const lx = (plantRng() * CHUNK_SIZE) | 0;
      const lz = (plantRng() * CHUNK_SIZE) | 0;
      const col = lz * CHUNK_SIZE + lx;
      const colBiome = reg.biomes[col];
      if (plantRng() * maxCover > COVER_DENSITY(getBiome(colBiome))) continue;
      const y = reg.terrainTop[col];
      if (y === NO_TERRAIN) continue;
      const fl = reg.fluidLevel[col];
      const surf = reg.surfaceTop[col];
      const underwater = y < fl;
      if (!underwater && !SOIL_BLOCKS.has(surf) && !SAND_BLOCKS.has(surf)) continue;
      placeVegetation(write, plantRng, ox + lx, y, oz + lz, colBiome, fl);
    }

    /* --- Biome scatter -------------------------------------------------- */
    const scatterRng = mulberry32(xxhash32(cx, cz, this.seed ^ 0x5bd1e995, SALT_PLANTS));

    if (hasTag(feats, 'boulders')) {
      const n = scatterRng() < 0.35 ? 1 + ((scatterRng() * 2) | 0) : 0;
      for (let i = 0; i < n; i++) {
        const lx = (scatterRng() * CHUNK_SIZE) | 0;
        const lz = (scatterRng() * CHUNK_SIZE) | 0;
        const col = lz * CHUNK_SIZE + lx;
        const y = reg.terrainTop[col];
        if (y === NO_TERRAIN || y < reg.fluidLevel[col]) continue;
        placeBoulder(write, scatterRng, ox + lx, y, oz + lz);
      }
    }

    if (hasTag(feats, 'ice_spikes') || bdef.name === 'ice_spikes') {
      const n = scatterRng() < 0.55 ? 1 + ((scatterRng() * 3) | 0) : 0;
      for (let i = 0; i < n; i++) {
        const lx = (scatterRng() * CHUNK_SIZE) | 0;
        const lz = (scatterRng() * CHUNK_SIZE) | 0;
        const col = lz * CHUNK_SIZE + lx;
        const y = reg.terrainTop[col];
        if (y === NO_TERRAIN || y < reg.fluidLevel[col]) continue;
        placeIceSpike(write, scatterRng, ox + lx, y, oz + lz);
      }
    }

    if (hasTag(feats, 'giant_mushrooms') && scatterRng() < 0.5) {
      const n = 1 + ((scatterRng() * 2) | 0);
      for (let i = 0; i < n; i++) {
        const lx = (scatterRng() * CHUNK_SIZE) | 0;
        const lz = (scatterRng() * CHUNK_SIZE) | 0;
        const col = lz * CHUNK_SIZE + lx;
        const y = reg.terrainTop[col];
        if (y === NO_TERRAIN || y < reg.fluidLevel[col]) continue;
        if (!SOIL_BLOCKS.has(reg.surfaceTop[col])) continue;
        placeGiantMushroom(write, scatterRng, ox + lx, y, oz + lz);
      }
    }

    if (bdef.treeDensity > 3 && scatterRng() < 0.14) {
      const lx = (scatterRng() * CHUNK_SIZE) | 0;
      const lz = (scatterRng() * CHUNK_SIZE) | 0;
      const col = lz * CHUNK_SIZE + lx;
      const y = reg.terrainTop[col];
      if (y !== NO_TERRAIN && y >= reg.fluidLevel[col] && SOIL_BLOCKS.has(reg.surfaceTop[col])) {
        placeFallenLog(write, scatterRng, ox + lx, y, oz + lz, B.OAK_LOG);
      }
    }
  }

  /**
   * Highest value a per-biome density accessor takes over a 4-block sample of
   * the chunk's columns. Used as the attempt budget for the feature passes.
   * @param {ColumnRegion} reg region data
   * @param {(b: *) => number} accessor density accessor, given a biome def
   * @returns {number} maximum sampled density (never negative)
   */
  _maxDensity(reg, accessor) {
    let max = 0;
    for (let lz = 0; lz < CHUNK_SIZE; lz += 4) {
      for (let lx = 0; lx < CHUNK_SIZE; lx += 4) {
        const v = accessor(getBiome(reg.biomes[lz * CHUNK_SIZE + lx]));
        if (v > max) max = v;
      }
    }
    return max;
  }

  /* ---------------------------------------------------------- structures - */

  /**
   * Region-based structure siting: at most one structure of a kind per
   * `spacing x spacing` chunk region, jittered inside the region so the grid is
   * invisible.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {number} spacing region size in chunks
   * @param {number} separation minimum gap kept from the region edge
   * @param {number} salt structure salt
   * @returns {boolean} whether this chunk is the structure chunk of its region
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
   * Place the large structures owned by this chunk. Writes that leave the
   * chunk go into the pending-edit map.
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @returns {void}
   */
  _generateStructures(cx, cz, sections) {
    const reg = this._regionFor(cx, cz);
    const write = this._makeStructureWriter(cx, cz, sections);
    const rng = mulberry32(xxhash32(cx, cz, this.seed, SALT_STRUCTURES));
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const centreCol = 8 * CHUNK_SIZE + 8;
    const biomeId = reg.biomes[centreCol];
    const bdef = getBiome(biomeId);
    const feats = bdef.features;
    const surfaceY = reg.terrainTop[centreCol];
    const dry = surfaceY !== NO_TERRAIN && surfaceY > reg.fluidLevel[centreCol];

    /* Dungeons — a couple of blind attempts through the stone column. */
    for (let i = 0; i < 3; i++) {
      if (rng() > 0.06) continue;
      const dx = ox + randInt(rng, 3, 12);
      const dz = oz + randInt(rng, 3, 12);
      const dy = randInt(rng, WORLD_MIN_Y + 10, 68);
      placeDungeon(write, rng, dx, dy, dz);
    }

    /* Amethyst geodes. */
    if (rng() < 0.018) {
      placeAmethystGeode(
        write, rng, ox + randInt(rng, 2, 13), randInt(rng, WORLD_MIN_Y + 12, 28),
        oz + randInt(rng, 2, 13),
      );
    }

    /* Mineshafts. */
    if (this._isStructureChunk(cx, cz, 12, 4, 0x4d6d1a17)) {
      const my = clamp(
        (dry ? surfaceY : SEA_LEVEL) - randInt(rng, 26, 58), WORLD_MIN_Y + 12, 40,
      );
      placeMineshaft(write, rng, ox + 8, my, oz + 8, xxhash32(cx, cz, this.seed, 0x77113355));
    }

    /* Strongholds. */
    if (this._isStructureChunk(cx, cz, 40, 12, 0x2a1f77b5)) {
      placeStrongholdRoom(write, rng, ox + 8, randInt(rng, -38, 8), oz + 8);
    }

    if (!dry) return;

    const name = bdef.name;
    const desert = name === 'desert';
    const badlands = name.indexOf('badlands') >= 0;

    /* Desert pyramids. */
    if ((desert || badlands) && this._isStructureChunk(cx, cz, 20, 6, 0x6c1d9a3b)) {
      placeDesertPyramid(write, rng, ox + 8, surfaceY, oz + 8);
    }

    /* Villages. */
    if (hasTag(feats, 'village') && this._isStructureChunk(cx, cz, 28, 8, 0x1f0e5c2d)) {
      placeVillage(write, rng, ox + 8, surfaceY, oz + 8, biomeId);
    }

    /* Desert wells. */
    if (desert && rng() < 0.006) {
      placeDesertWell(write, rng, ox + randInt(rng, 3, 12), surfaceY, oz + randInt(rng, 3, 12));
    }

    /* Witch huts. */
    if (hasTag(feats, 'witch_hut') && this._isStructureChunk(cx, cz, 14, 4, 0x3b9a73c1)) {
      placeWitchHut(write, rng, ox + 8, Math.min(surfaceY, SEA_LEVEL), oz + 8);
    }

    /* Surface ruins. */
    if (hasTag(feats, 'ruins') && rng() < 0.02) {
      placeRuins(write, rng, ox + randInt(rng, 4, 11), surfaceY, oz + randInt(rng, 4, 11), biomeId);
    }

    /* Ponds and small lava pools. */
    if (hasTag(feats, 'lakes') && rng() < 0.022) {
      const lx = randInt(rng, 4, 11);
      const lz = randInt(rng, 4, 11);
      const col = lz * CHUNK_SIZE + lx;
      const ly = reg.terrainTop[col];
      if (ly !== NO_TERRAIN && ly > reg.fluidLevel[col]) {
        placeLakePocket(write, rng, ox + lx, ly, oz + lz, B.WATER, B.CLAY);
      }
    }
    if (hasTag(feats, 'lava_lakes') && rng() < 0.014) {
      placeLakePocket(
        write, rng, ox + randInt(rng, 4, 11), randInt(rng, WORLD_MIN_Y + 8, -12),
        oz + randInt(rng, 4, 11), B.LAVA, B.MAGMA_BLOCK,
      );
    }
  }

  /* --------------------------------------------------------------- output - */

  /**
   * Rebuild the two heightmaps from the finished blocks.
   *
   * Both use the same convention as `world/chunk.js`: the value is **one above**
   * the highest matching block, and `HEIGHTMAP_EMPTY` (`WORLD_MIN_Y`) when the
   * column has none. `heightmap` matches `Chunk.heightmap` exactly (highest
   * sky-blocking block, i.e. non-zero light absorption) so `world.js` can copy
   * it straight in; `oceanFloor` is the highest solid, non-liquid block, which
   * is the seabed under water and the walkable ground on land.
   *
   * @param {(Uint16Array|null)[]} sections chunk sections
   * @param {Int16Array} heightmap destination sky-blocking heightmap
   * @param {Int16Array} oceanFloor destination solid-floor heightmap
   * @returns {void}
   */
  _computeHeightmaps(sections, heightmap, oceanFloor) {
    heightmap.fill(HEIGHTMAP_EMPTY);
    oceanFloor.fill(HEIGHTMAP_EMPTY);

    let topSection = -1;
    for (let s = SECTION_COUNT - 1; s >= 0; s--) {
      if (sections[s] !== null) { topSection = s; break; }
    }
    if (topSection < 0) return;
    const startY = WORLD_MIN_Y + (topSection + 1) * 16 - 1;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const col = lz * CHUNK_SIZE + lx;
        let haveSky = false;
        for (let y = startY; y >= WORLD_MIN_Y; y--) {
          const id = sectionGet(sections, lx, y, lz);
          if (id === B.AIR) continue;
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
   * The returned object is transferable-friendly: `sections` holds
   * `Uint16Array`s (or `null` for an all-air section) and the three maps are
   * typed arrays over the 16x16 column grid indexed `z * 16 + x`.
   *
   * `heightmap` and `oceanFloor` follow the `world/chunk.js` convention: one
   * above the highest sky-blocking / highest solid non-liquid block, and
   * `HEIGHTMAP_EMPTY` for an empty column.
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
    this._applySurface(reg, sections, cx, cz);
    if (this.options.caves && this.options.caveDecoration) {
      this._decorateCaves(reg, sections, cx, cz);
    }
    if (this.options.ores) this._generateOres(cx, cz, sections);
    if (this.options.structures) this._generateStructures(cx, cz, sections);
    if (this.options.features) this._generateFeatures(cx, cz, sections);

    const heightmap = new Int16Array(256);
    const oceanFloor = new Int16Array(256);
    this._computeHeightmaps(sections, heightmap, oceanFloor);

    return {
      sections,
      heightmap,
      biomes: new Uint8Array(reg.biomes),
      oceanFloor,
    };
  }

  /**
   * Surface biome id at a world position.
   * @param {number} x world x
   * @param {number} z world z
   * @returns {number} biome id
   */
  getBiomeAt(x, z) {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const reg = this._regionFor(bx >> 4, bz >> 4);
    return reg.biomes[(bz & 15) * CHUNK_SIZE + (bx & 15)];
  }

  /**
   * Terrain surface height at a world position — the y of the topmost solid
   * terrain block, ignoring fluids, plants and structures.
   * @param {number} x world x
   * @param {number} z world z
   * @returns {number} y of the topmost solid terrain block — stand on `y + 1`
   *   (`WORLD_MIN_Y - 1` when the column is empty)
   */
  getHeightAt(x, z) {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const reg = this._regionFor(bx >> 4, bz >> 4);
    return reg.terrainTop[(bz & 15) * CHUNK_SIZE + (bx & 15)];
  }

  /**
   * Water table height at a world position — the highest y that fluid fills in
   * that column. Below `SEA_LEVEL` on land it marks an underground lake.
   * @param {number} x world x
   * @param {number} z world z
   * @returns {number} fluid surface y
   */
  getWaterLevelAt(x, z) {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const reg = this._regionFor(bx >> 4, bz >> 4);
    return reg.fluidLevel[(bz & 15) * CHUNK_SIZE + (bx & 15)];
  }

  /**
   * Hand over every buffered cross-chunk structure edit and clear the buffer.
   *
   * `world/world.js` must keep the returned lists for chunks that are not
   * loaded yet and apply them **after** that chunk's own terrain generation,
   * otherwise a village or mineshaft would be overwritten by the terrain pass.
   *
   * @returns {Map<string, Array<number[]>>} `"cx,cz"` -> `[[x, y, z, blockId], ...]`
   */
  takePendingEdits() {
    const out = this._pending;
    this._pending = new Map();
    return out;
  }

  /**
   * Drop the cached column regions. Safe to call at any time; the generator
   * simply recomputes what it needs.
   * @returns {void}
   */
  clearCache() {
    this._cache.clear();
  }

  /**
   * Release everything held by the generator.
   * @returns {void}
   */
  dispose() {
    this._cache.clear();
    this._pending.clear();
  }
}

/**
 * Tree attempts per chunk for a biome.
 * @param {*} b biome definition
 * @returns {number} density
 */
function TREE_DENSITY(b) {
  return b.treeDensity;
}

/**
 * Ground-cover attempts per chunk for a biome. Oceans and rivers declare no
 * cover but still want kelp, seagrass and coral, so they get a fixed budget.
 * @param {*} b biome definition
 * @returns {number} density
 */
function COVER_DENSITY(b) {
  const base = b.grassDensity + b.flowerDensity;
  return (b.category === 'ocean' || b.category === 'river') ? base + 20 : base;
}

/**
 * Feature-tag test against a biome's advisory `features` list.
 * @param {readonly string[]} features feature list
 * @param {string} tag tag to look for
 * @returns {boolean} whether the tag is present
 */
function hasTag(features, tag) {
  for (let i = 0; i < features.length; i++) if (features[i] === tag) return true;
  return false;
}

export default WorldGenerator;
