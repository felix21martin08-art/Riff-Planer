/**
 * VOXELIA — agriculture: plant growth, soil, composting and animal breeding.
 *
 * `world/blocks.js` owns the crop *blocks*; this module owns everything that
 * makes them behave like a farm: when a seed becomes wheat, when farmland dries
 * out, what bone meal does to each plant, how grass creeps across bare dirt,
 * and how two cows become three.
 *
 * ============================================================================
 * 1. THE RANDOM TICK
 * ============================================================================
 * Growth is driven exactly the way Minecraft drives it — by **random ticks**,
 * never by a scan of the farm. Once per game tick every loaded, generated
 * section that is inside the simulation radius receives
 * {@link RANDOM_TICK_SAMPLES} random voxels; only those voxels are considered
 * for growth. Sampling reads `section.blocks` (a flat `Uint16Array`) directly
 * and tests the id against a `Uint8Array` dispatch table, so a sample that hits
 * stone costs two array reads and nothing else — no `world.getBlock()` (which
 * builds a string chunk key), no allocation, no branching on names.
 *
 * The pass is wrapped in a {@link TimeBudget} and keeps a **resume cursor**
 * into the chunk list: when the budget runs out mid-pass the remaining chunks
 * are simply the ones the next tick starts with. Work therefore spreads across
 * ticks under load instead of stalling one; nothing is ever skipped for good.
 *
 * Only plants that genuinely need per-block state keep a record (see 2). Sugar
 * cane, cactus and bamboo use a per-hit probability whose expectation matches
 * vanilla's hidden age counter (grow at age 16 == p = 1/16 per random tick),
 * which keeps the store — and the save file — free of thousands of entries.
 *
 * ============================================================================
 * 2. THE PLANT STATE STORE
 * ============================================================================
 * Voxel storage is one `Uint16` id per cell; farmland moisture, stem age,
 * sapling species and composter fill have nowhere to live. They go into this
 * module's own store, laid out exactly like the redstone engine's:
 *
 *   `_states: Map<chunkKey:number, Map<localKey:number, PlantState>>`
 *
 *   chunkKey = (cx + 131072) * 262144 + (cz + 131072)
 *   localKey = (y - WORLD_MIN_Y) * 256 + lz * 16 + lx
 *
 * One `Map` per chunk, so the whole bucket is dropped in O(1) when the chunk
 * unloads and is written chunk-by-chunk by {@link FarmingSystem#serialize}.
 * Keys are packed integers — never strings — so the tick loop allocates
 * nothing. A `'blockChanged'` listener drops records whose block no longer
 * matches, which is what keeps the store from leaking when a player mines a
 * field.
 *
 * ============================================================================
 * 3. GRACEFUL BLOCK RESOLUTION
 * ============================================================================
 * This build's block table has no dedicated stem, cocoa, nether-wart, sapling
 * or composter block. Every such plant therefore resolves its block id through
 * {@link resolveBlock}, which walks a preference list of names and returns the
 * first that exists: the real block when a future `blocks.js` adds it, a
 * sensible existing stand-in otherwise (a stem draws as a wheat stalk, a
 * sapling as an azalea bush, cocoa as a brown mushroom, nether wart as a red
 * mushroom — the same stand-in `world/netherworldgen.js` already picks). The
 * plant's true identity lives in its {@link PlantState} record, so behaviour is
 * correct either way and upgrades silently.
 *
 * ============================================================================
 * 4. EVENTS
 * ============================================================================
 * The system extends `EventBus`; all coordinates are world coordinates.
 *
 *   'grow'        (x, y, z, blockId)          a plant advanced one stage
 *   'plant'       (x, y, z, blockId)          a seed or sapling was planted
 *   'harvest'     (x, y, z, blockId)          a ripe crop was harvested
 *   'fruit'       (x, y, z, blockId)          a stem placed a melon/pumpkin
 *   'tree'        (x, y, z, species)          a sapling became a tree
 *   'till'        (x, y, z)                   dirt turned into farmland
 *   'trample'     (x, y, z, entity)           farmland stomped back to dirt
 *   'dry'         (x, y, z)                   farmland dried out to dirt
 *   'spread'      (x, y, z, blockId)          grass/mycelium/moss claimed dirt
 *   'boneMeal'    (x, y, z, blockId)          bone meal took effect
 *   'compost'     (x, y, z, level, filled)    composter accepted plant matter
 *   'composterFull' (x, y, z)                 composter is ready to harvest
 *   'love'        (mob)                       an animal entered love mode
 *   'baby'        (mob, parentA, parentB)     a baby was born
 *   'grownUp'     (mob)                       a baby finished growing
 *
 * Nothing in this module throws out of `tick()`: every guarded failure lands in
 * {@link warnOnce} and the affected feature degrades.
 *
 * @module game/farming
 */

import { EventBus, TimeBudget } from '../core/util.js';
import { clamp, mulberry32 } from '../core/math.js';
import {
  B, BLOCK_COUNT, RENDER, blockByName, getBlock as blockDef, blockRender,
  isSolid, isOpaque, isReplaceable, blockDrops,
} from '../world/blocks.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, SECTION_COUNT, CHUNK_SIZE } from '../world/chunk.js';
import { itemIdByName, itemDisplay } from '../game/items.js';
import { ItemStack } from '../game/inventory.js';
import { placeTree } from '../world/structures.js';

/* ========================================================================== */
/* Local helpers                                                              */
/* ========================================================================== */

/** @type {Set<string>} Keys already reported by {@link warnOnce}. */
const WARNED = new Set();

/**
 * Log a problem exactly once per key. Farming runs inside the fixed tick, so
 * nothing here may throw; every guarded failure lands in this function and the
 * affected feature simply stops.
 * @param {string} key De-duplication key.
 * @param {string} msg Human readable message (English — this is a log, not UI).
 * @param {*} [err] Optional error object.
 * @returns {void}
 */
function warnOnce(key, msg, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err !== undefined) console.warn(`[VOXELIA/farming] ${msg}`, err);
  else console.warn(`[VOXELIA/farming] ${msg}`);
}

/**
 * Finite-number coercion with a fallback.
 * @param {*} v Candidate value.
 * @param {number} d Fallback.
 * @returns {number} `v` when finite, else `d`.
 */
function num(v, d) {
  return Number.isFinite(v) ? v : d;
}

/**
 * First block id whose name exists in the registry.
 *
 * The whole module addresses blocks through this helper so a build whose
 * `blocks.js` lacks a dedicated stem/sapling/composter block still runs, using
 * the stand-in at the end of the list.
 *
 * @param {...string} names Candidate block names, best first.
 * @returns {number} The resolved block id, or `0` when none exists.
 */
export function resolveBlock(...names) {
  for (let i = 0; i < names.length; i++) {
    const def = blockByName(names[i]);
    if (def !== undefined && def !== null && def.id > 0) return def.id;
  }
  return 0;
}

/**
 * First item id whose name exists in the registry.
 * @param {...string} names Candidate item names, best first.
 * @returns {number} The resolved item id, or `0` when none exists.
 */
export function resolveItem(...names) {
  for (let i = 0; i < names.length; i++) {
    const id = itemIdByName(names[i]);
    if (id > 0) return id;
  }
  return 0;
}

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Save format version of {@link FarmingSystem#serialize}. @type {number} */
export const FARM_SAVE_VERSION = 1;

/** Random voxels sampled per loaded section per tick (vanilla uses 3). @type {number} */
export const RANDOM_TICK_SAMPLES = 3;

/** Default milliseconds the whole farming tick may consume. @type {number} */
export const DEFAULT_BUDGET_MS = 1.6;

/** Default simulation radius in chunks around the player. @type {number} */
export const DEFAULT_SIMULATION_DISTANCE = 8;

/** Ticks between rebuilds of the cached chunk list. @type {number} */
export const CHUNK_LIST_REFRESH_TICKS = 20;

/** Minimum light level a crop needs to advance a stage. @type {number} */
export const CROP_LIGHT_MIN = 9;

/** Maximum farmland moisture. @type {number} */
export const FARMLAND_MAX_MOISTURE = 7;

/** Horizontal radius searched for water under/next to farmland. @type {number} */
export const FARMLAND_WATER_RANGE = 4;

/** Fall distance (blocks) above which an entity tramples farmland. @type {number} */
export const TRAMPLE_MIN_FALL = 0.6;

/** Probability that a qualifying fall actually destroys the farmland. @type {number} */
export const TRAMPLE_CHANCE = 1;

/** Maximum sugar cane column height. @type {number} */
export const SUGAR_CANE_MAX_HEIGHT = 3;

/** Maximum cactus column height. @type {number} */
export const CACTUS_MAX_HEIGHT = 3;

/** Maximum bamboo culm height. @type {number} */
export const BAMBOO_MAX_HEIGHT = 12;

/** Per-random-tick growth probability of sugar cane. @type {number} */
export const SUGAR_CANE_CHANCE = 1 / 16;

/** Per-random-tick growth probability of cactus. @type {number} */
export const CACTUS_CHANCE = 1 / 16;

/** Per-random-tick growth probability of bamboo. @type {number} */
export const BAMBOO_CHANCE = 1 / 8;

/** Per-random-tick growth probability of a sapling stage. @type {number} */
export const SAPLING_CHANCE = 1 / 7;

/** Per-random-tick growth probability of nether wart. @type {number} */
export const NETHER_WART_CHANCE = 1 / 10;

/** Per-random-tick growth probability of cocoa. @type {number} */
export const COCOA_CHANCE = 1 / 5;

/** Per-random-tick probability that grass/mycelium tries to spread. @type {number} */
export const SPREAD_CHANCE = 0.25;

/** Per-random-tick probability that moss tries to spread. @type {number} */
export const MOSS_SPREAD_CHANCE = 0.12;

/** Attempts a spreading soil block makes when it does try. @type {number} */
export const SPREAD_ATTEMPTS = 2;

/** Fill level at which a composter yields bone meal. @type {number} */
export const COMPOSTER_MAX_LEVEL = 8;

/** Seconds of love mode a fed animal receives. @type {number} */
export const LOVE_SECONDS = 30;

/** Seconds two parents must wait before breeding again. @type {number} */
export const BREED_COOLDOWN_SECONDS = 300;

/** Maximum stage index of a four-stage crop. @type {number} */
export const CROP_MAX_STAGE = 3;

/** Maximum age of a melon/pumpkin stem. @type {number} */
export const STEM_MAX_AGE = 7;

/**
 * Kinds of {@link PlantState} record.
 * @type {{NONE:number, FARMLAND:number, STEM:number, SAPLING:number,
 *   NETHER_WART:number, COCOA:number, COMPOSTER:number}}
 */
export const PLANT = Object.freeze({
  NONE: 0, FARMLAND: 1, STEM: 2, SAPLING: 3, NETHER_WART: 4, COCOA: 5, COMPOSTER: 6,
});

/**
 * Dispatch codes of the random-tick table.
 * @type {Object<string, number>}
 */
const TICK = Object.freeze({
  NONE: 0, CROP: 1, FARMLAND: 2, SUGAR_CANE: 3, CACTUS: 4, BAMBOO: 5,
  SAPLING: 6, GRASS: 7, MYCELIUM: 8, MOSS: 9, STATE: 10,
});

/* ========================================================================== */
/* Block ids used by the module                                               */
/* ========================================================================== */

/** Farmland block id. @type {number} */
export const FARMLAND_BLOCK = resolveBlock('farmland');

/** Block farmland reverts to. @type {number} */
export const DIRT_BLOCK = resolveBlock('dirt');

/** Composter block id (falls back to a hay bale when absent). @type {number} */
export const COMPOSTER_BLOCK = resolveBlock('composter', 'hay_block');

/** Generic sapling stand-in used when no `*_sapling` block exists. @type {number} */
export const SAPLING_FALLBACK_BLOCK = resolveBlock('azalea', 'short_grass');

/** Block a cocoa pod draws as. @type {number} */
export const COCOA_BLOCK = resolveBlock('cocoa', 'cocoa_stage0', 'brown_mushroom');

/** Block nether wart draws as. @type {number} */
export const NETHER_WART_BLOCK = resolveBlock('nether_wart', 'nether_wart_stage0', 'red_mushroom');

/**
 * Block id per nether wart age 0..3. Falls back to the single stand-in block
 * for every age when the build has no staged wart blocks.
 * @type {readonly number[]}
 */
export const WART_BLOCKS = Object.freeze([0, 1, 2, 3].map(
  (age) => resolveBlock(`nether_wart_stage${age}`) || NETHER_WART_BLOCK));

/**
 * Block id per cocoa age 0..2.
 * @type {readonly number[]}
 */
export const COCOA_BLOCKS = Object.freeze([0, 1, 2].map(
  (age) => resolveBlock(`cocoa_stage${age}`) || COCOA_BLOCK));

/** Blocks a hoe turns into farmland. @type {readonly number[]} */
export const TILLABLE_BLOCKS = Object.freeze([
  resolveBlock('grass_block'), resolveBlock('dirt'), resolveBlock('coarse_dirt'),
  resolveBlock('dirt_path'), resolveBlock('podzol'), resolveBlock('mycelium'),
].filter((id) => id > 0));

/** Soils a melon or pumpkin fruit may rest on. @type {readonly number[]} */
export const FRUIT_SOILS = Object.freeze([
  resolveBlock('farmland'), resolveBlock('dirt'), resolveBlock('grass_block'),
  resolveBlock('coarse_dirt'), resolveBlock('podzol'), resolveBlock('moss_block'),
].filter((id) => id > 0));

/** Flowers bone meal scatters over a grass block. @type {readonly number[]} */
export const BONE_MEAL_FLOWERS = Object.freeze([
  resolveBlock('dandelion'), resolveBlock('poppy'), resolveBlock('blue_orchid'),
  resolveBlock('allium'), resolveBlock('cornflower'), resolveBlock('oxeye_daisy'),
].filter((id) => id > 0));

/* ========================================================================== */
/* Crop families                                                              */
/* ========================================================================== */

/**
 * @typedef {Object} CropFamily
 * @property {string} key            Internal key, e.g. `'wheat'`.
 * @property {string} display        German display name.
 * @property {number[]} stages       Block id per growth stage 0..3.
 * @property {number} seedItem       Item planted to create stage 0.
 * @property {number} productItem    Item harvested from the mature crop.
 * @property {number} boneMealMin    Smallest stage jump bone meal grants.
 * @property {number} boneMealMax    Largest stage jump bone meal grants.
 */

/**
 * Build one crop family from its block-name prefix.
 * @param {string} key Crop key and block prefix.
 * @param {string} display German display name.
 * @param {string} seed Seed item name.
 * @param {string} product Harvest item name.
 * @param {number} bmMin Minimum bone-meal stage jump.
 * @param {number} bmMax Maximum bone-meal stage jump.
 * @returns {?CropFamily} The family, or `null` when the blocks are missing.
 */
function defineCropFamily(key, display, seed, product, bmMin, bmMax) {
  const stages = [];
  for (let s = 0; s <= CROP_MAX_STAGE; s++) {
    const id = resolveBlock(`${key}_stage${s}`);
    if (id === 0) return null;
    stages.push(id);
  }
  return Object.freeze({
    key,
    display,
    stages: Object.freeze(stages),
    seedItem: resolveItem(seed),
    productItem: resolveItem(product),
    boneMealMin: bmMin,
    boneMealMax: bmMax,
  });
}

/**
 * Every four-stage crop the world knows, in registration order.
 * @type {ReadonlyArray<CropFamily>}
 */
export const CROP_FAMILIES = Object.freeze([
  defineCropFamily('wheat', 'Weizen', 'wheat_seeds', 'wheat', 1, 2),
  defineCropFamily('carrots', 'Karotten', 'carrot', 'carrot', 1, 2),
  defineCropFamily('potatoes', 'Kartoffeln', 'potato', 'potato', 1, 2),
  defineCropFamily('beetroot', 'Rote Bete', 'beetroot_seeds', 'beetroot', 1, 1),
].filter((f) => f !== null));

/**
 * @typedef {Object} StemType
 * @property {string} key       `'melon'` or `'pumpkin'`.
 * @property {string} display   German display name.
 * @property {number} seedItem  Seed item id.
 * @property {number} fruit     Block id of the fruit the stem grows.
 * @property {number[]} blocks  Block id per stem age 0..7.
 */

/**
 * Build the per-age block list of a stem, preferring real stem blocks and
 * falling back to the wheat stalk stages.
 * @param {string} key Stem key.
 * @returns {number[]} Eight block ids, one per age.
 */
function stemBlocks(key) {
  const out = [];
  for (let age = 0; age <= STEM_MAX_AGE; age++) {
    const real = resolveBlock(`${key}_stem_stage${age}`, `${key}_stem`);
    if (real > 0) { out.push(real); continue; }
    const stage = Math.min(CROP_MAX_STAGE, age >> 1);
    out.push(resolveBlock(`wheat_stage${stage}`));
  }
  return out;
}

/**
 * Melon and pumpkin stems.
 * @type {ReadonlyArray<StemType>}
 */
export const STEM_TYPES = Object.freeze([
  Object.freeze({
    key: 'melon', display: 'Melonenranke',
    seedItem: resolveItem('melon_seeds'), fruit: resolveBlock('melon'),
    blocks: Object.freeze(stemBlocks('melon')),
  }),
  Object.freeze({
    key: 'pumpkin', display: 'Kürbisranke',
    seedItem: resolveItem('pumpkin_seeds'), fruit: resolveBlock('pumpkin'),
    blocks: Object.freeze(stemBlocks('pumpkin')),
  }),
]);

/**
 * @typedef {Object} SaplingSpecies
 * @property {string} key      Wood species key.
 * @property {string} display  German display name.
 * @property {number} item     Sapling item id.
 * @property {number} block    Block the planted sapling occupies.
 * @property {string} tree     `placeTree()` archetype.
 * @property {?string} bigTree Rare larger archetype, or `null`.
 * @property {number} bigChance Probability of the larger archetype.
 */

/**
 * Every plantable sapling. `block` is a real `*_sapling` block when the build
 * has one and the shared azalea bush otherwise; the species is remembered in
 * the {@link PlantState} record either way.
 * @type {ReadonlyArray<SaplingSpecies>}
 */
export const SAPLING_SPECIES = Object.freeze([
  { key: 'oak', display: 'Eichensetzling', tree: 'oak', bigTree: 'big_oak', bigChance: 0.1 },
  { key: 'spruce', display: 'Fichtensetzling', tree: 'spruce', bigTree: 'tall_spruce', bigChance: 0.15 },
  { key: 'birch', display: 'Birkensetzling', tree: 'birch', bigTree: null, bigChance: 0 },
  { key: 'jungle', display: 'Dschungelsetzling', tree: 'jungle', bigTree: 'big_jungle', bigChance: 0.2 },
  { key: 'acacia', display: 'Akaziensetzling', tree: 'acacia', bigTree: null, bigChance: 0 },
  { key: 'dark_oak', display: 'Schwarzeichensetzling', tree: 'dark_oak', bigTree: null, bigChance: 0 },
  { key: 'cherry', display: 'Kirschsetzling', tree: 'cherry', bigTree: null, bigChance: 0 },
  { key: 'azalea', display: 'Azalee', tree: 'azalea', bigTree: null, bigChance: 0 },
].map((s) => Object.freeze({
  ...s,
  item: resolveItem(`${s.key}_sapling`, s.key),
  block: resolveBlock(`${s.key}_sapling`, s.key) || SAPLING_FALLBACK_BLOCK,
})));

/* ========================================================================== */
/* Composting                                                                 */
/* ========================================================================== */

/**
 * Compostable items and the chance one of them raises the composter by a
 * level, mirroring vanilla's tiers.
 * @type {ReadonlyArray<{names:string[], chance:number}>}
 */
const COMPOST_TIERS = Object.freeze([
  {
    chance: 0.30,
    names: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'short_grass',
      'fern', 'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves',
      'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'oak_sapling', 'spruce_sapling',
      'birch_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling',
      'cherry_sapling', 'kelp', 'seagrass', 'sweet_berries', 'glow_berries', 'bamboo',
      'moss_carpet'],
  },
  {
    chance: 0.50,
    names: ['dried_kelp', 'cactus', 'melon_slice', 'sugar_cane', 'tall_grass', 'vine',
      'azalea', 'moss_block'],
  },
  {
    chance: 0.65,
    names: ['apple', 'beetroot', 'carrot', 'potato', 'wheat', 'brown_mushroom',
      'red_mushroom', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'cornflower',
      'oxeye_daisy', 'sunflower', 'melon', 'pumpkin', 'carved_pumpkin', 'poisonous_potato'],
  },
  {
    chance: 0.85,
    names: ['baked_potato', 'bread', 'cookie', 'hay_block', 'pumpkin_pie'],
  },
  {
    chance: 1.0,
    names: ['cake'],
  },
]);

/**
 * Item id -> chance that composting it raises the level.
 * @type {Map<number, number>}
 */
export const COMPOSTABLE = new Map();
for (let t = 0; t < COMPOST_TIERS.length; t++) {
  const tier = COMPOST_TIERS[t];
  for (let i = 0; i < tier.names.length; i++) {
    const id = itemIdByName(tier.names[i]);
    if (id > 0) COMPOSTABLE.set(id, tier.chance);
  }
}

/**
 * Chance an item raises a composter's fill level.
 * @param {number} itemId Item id.
 * @returns {number} `0` when the item is not compostable.
 */
export function compostChance(itemId) {
  const v = COMPOSTABLE.get(itemId | 0);
  return v === undefined ? 0 : v;
}

/* ========================================================================== */
/* Lookup tables                                                              */
/* ========================================================================== */

/** Random-tick dispatch code per block id. @type {Uint8Array} */
const TICK_KIND = new Uint8Array(BLOCK_COUNT);

/** Crop stage + 1 per block id (`0` = not a crop). @type {Uint8Array} */
const CROP_STAGE_PLUS1 = new Uint8Array(BLOCK_COUNT);

/** Crop family index per block id (`-1` = not a crop). @type {Int8Array} */
const CROP_FAMILY_IDX = new Int8Array(BLOCK_COUNT).fill(-1);

/** `true` for every block that may carry a sapling record. @type {Uint8Array} */
const SAPLING_BLOCK = new Uint8Array(BLOCK_COUNT);

/** `true` for every block a stem may draw as. @type {Uint8Array} */
const STEM_BLOCK = new Uint8Array(BLOCK_COUNT);

/** `true` for every block a nether wart may draw as. @type {Uint8Array} */
const WART_BLOCK = new Uint8Array(BLOCK_COUNT);

/** `true` for every block a cocoa pod may draw as. @type {Uint8Array} */
const COCOA_FLAG = new Uint8Array(BLOCK_COUNT);

/**
 * Fill the dispatch tables. Runs once at module load.
 * @returns {void}
 */
function buildTables() {
  for (let f = 0; f < CROP_FAMILIES.length; f++) {
    const fam = CROP_FAMILIES[f];
    for (let s = 0; s < fam.stages.length; s++) {
      const id = fam.stages[s];
      TICK_KIND[id] = TICK.CROP;
      CROP_STAGE_PLUS1[id] = s + 1;
      CROP_FAMILY_IDX[id] = f;
    }
  }
  for (let i = 0; i < STEM_TYPES.length; i++) {
    const list = STEM_TYPES[i].blocks;
    for (let a = 0; a < list.length; a++) {
      const id = list[a];
      if (id <= 0) continue;
      STEM_BLOCK[id] = 1;
      if (TICK_KIND[id] === TICK.NONE) TICK_KIND[id] = TICK.STATE;
    }
  }
  for (let i = 0; i < SAPLING_SPECIES.length; i++) {
    const id = SAPLING_SPECIES[i].block;
    if (id <= 0) continue;
    SAPLING_BLOCK[id] = 1;
    TICK_KIND[id] = TICK.SAPLING;
  }
  if (FARMLAND_BLOCK > 0) TICK_KIND[FARMLAND_BLOCK] = TICK.FARMLAND;

  const cane = resolveBlock('sugar_cane');
  if (cane > 0) TICK_KIND[cane] = TICK.SUGAR_CANE;
  const cactus = resolveBlock('cactus');
  if (cactus > 0) TICK_KIND[cactus] = TICK.CACTUS;
  const bamboo = resolveBlock('bamboo');
  if (bamboo > 0) TICK_KIND[bamboo] = TICK.BAMBOO;

  const grass = resolveBlock('grass_block');
  if (grass > 0) TICK_KIND[grass] = TICK.GRASS;
  const myc = resolveBlock('mycelium');
  if (myc > 0) TICK_KIND[myc] = TICK.MYCELIUM;
  const moss = resolveBlock('moss_block');
  if (moss > 0) TICK_KIND[moss] = TICK.MOSS;

  // Blocks that only matter when a record sits on them (cocoa, nether wart and
  // any stem stand-in that is not already a crop stage).
  for (let a = 0; a < WART_BLOCKS.length; a++) {
    const id = WART_BLOCKS[a];
    if (id <= 0) continue;
    WART_BLOCK[id] = 1;
    if (TICK_KIND[id] === TICK.NONE) TICK_KIND[id] = TICK.STATE;
  }
  for (let a = 0; a < COCOA_BLOCKS.length; a++) {
    const id = COCOA_BLOCKS[a];
    if (id <= 0) continue;
    COCOA_FLAG[id] = 1;
    if (TICK_KIND[id] === TICK.NONE) TICK_KIND[id] = TICK.STATE;
  }
  if (COMPOSTER_BLOCK > 0 && TICK_KIND[COMPOSTER_BLOCK] === TICK.NONE) {
    // Composters never grow; they are excluded from the random tick on purpose.
    TICK_KIND[COMPOSTER_BLOCK] = TICK.NONE;
  }
}
buildTables();

/**
 * Growth stage of a crop block.
 * @param {number} blockId Block id.
 * @returns {number} Stage 0..3, or `-1` when the block is not a crop.
 */
export function cropStageOf(blockId) {
  const v = CROP_STAGE_PLUS1[blockId | 0];
  return v === 0 ? -1 : v - 1;
}

/**
 * Whether a block is one of the four-stage crops.
 * @param {number} blockId Block id.
 * @returns {boolean} `true` for any crop stage.
 */
export function isCropBlock(blockId) {
  return CROP_STAGE_PLUS1[blockId | 0] !== 0;
}

/**
 * Whether a block is a fully grown crop.
 * @param {number} blockId Block id.
 * @returns {boolean} `true` for stage 3 of any family.
 */
export function isMatureCrop(blockId) {
  return CROP_STAGE_PLUS1[blockId | 0] === CROP_MAX_STAGE + 1;
}

/**
 * The family a crop block belongs to.
 * @param {number} blockId Block id.
 * @returns {?CropFamily} The family, or `null`.
 */
export function cropFamilyOf(blockId) {
  const idx = CROP_FAMILY_IDX[blockId | 0];
  return idx < 0 ? null : CROP_FAMILIES[idx];
}

/**
 * Block id of the next growth stage.
 * @param {number} blockId Block id.
 * @returns {number} Next stage block id, or `0` when mature or not a crop.
 */
export function nextCropStage(blockId) {
  const idx = CROP_FAMILY_IDX[blockId | 0];
  if (idx < 0) return 0;
  const stage = CROP_STAGE_PLUS1[blockId | 0] - 1;
  if (stage >= CROP_MAX_STAGE) return 0;
  return CROP_FAMILIES[idx].stages[stage + 1];
}

/**
 * The seed item that plants a crop block's family.
 * @param {number} blockId Block id.
 * @returns {number} Seed item id, or `0`.
 */
export function seedItemFor(blockId) {
  const fam = cropFamilyOf(blockId);
  return fam === null ? 0 : fam.seedItem;
}

/**
 * The crop family a seed item plants.
 * @param {number} itemId Item id.
 * @returns {?CropFamily} The family, or `null` when the item is not a seed.
 */
export function cropFamilyForSeed(itemId) {
  const id = itemId | 0;
  for (let i = 0; i < CROP_FAMILIES.length; i++) {
    if (CROP_FAMILIES[i].seedItem === id) return CROP_FAMILIES[i];
  }
  return null;
}

/**
 * The sapling species an item plants.
 * @param {number} itemId Item id.
 * @returns {?SaplingSpecies} The species, or `null`.
 */
export function saplingSpeciesForItem(itemId) {
  const id = itemId | 0;
  for (let i = 0; i < SAPLING_SPECIES.length; i++) {
    if (SAPLING_SPECIES[i].item === id) return SAPLING_SPECIES[i];
  }
  return null;
}

/**
 * The stem type a seed item plants.
 * @param {number} itemId Item id.
 * @returns {?StemType} The stem type, or `null`.
 */
export function stemTypeForSeed(itemId) {
  const id = itemId | 0;
  for (let i = 0; i < STEM_TYPES.length; i++) {
    if (STEM_TYPES[i].seedItem === id) return STEM_TYPES[i];
  }
  return null;
}

/* ========================================================================== */
/* Key packing                                                                */
/* ========================================================================== */

/**
 * Map key of a chunk column, identical to the redstone engine's scheme.
 * @param {number} cx Chunk X.
 * @param {number} cz Chunk Z.
 * @returns {number} Packed key.
 */
export function farmChunkKey(cx, cz) {
  return (cx + 131072) * 262144 + (cz + 131072);
}

/**
 * Map key of a voxel inside its chunk.
 * @param {number} x World X.
 * @param {number} y World Y.
 * @param {number} z World Z.
 * @returns {number} Packed key, `0..(384*256)`.
 */
export function farmLocalKey(x, y, z) {
  return (y - WORLD_MIN_Y) * 256 + (z & 15) * 16 + (x & 15);
}

/* ========================================================================== */
/* PlantState                                                                 */
/* ========================================================================== */

/**
 * Per-block farming state. One monomorphic shape for every kind so the engine
 * never deoptimises on a polymorphic property read.
 */
export class PlantState {
  /**
   * @param {number} kind A {@link PLANT} value.
   */
  constructor(kind) {
    /** @type {number} A {@link PLANT} value. */
    this.kind = kind | 0;
    /** @type {number} Growth age: stem 0..7, sapling 0..1, wart 0..3, composter 0..8. */
    this.age = 0;
    /** @type {number} Farmland moisture 0..7. */
    this.moisture = 0;
    /** @type {number} Species/type index (sapling species, stem type). */
    this.species = 0;
  }
}

/* ========================================================================== */
/* BlockView                                                                  */
/* ========================================================================== */

/**
 * A chunk-caching block reader.
 *
 * `world.getBlock()` builds a `"cx,cz"` string on every call, which is fine for
 * a handful of reads and ruinous for the hundreds a moisture or spread search
 * performs. This view resolves the chunk once and then indexes it directly, so
 * a 9x9x2 water search costs one map lookup instead of 162.
 */
export class BlockView {
  /**
   * @param {Object} world The chunk manager.
   */
  constructor(world) {
    /** @type {Object} */
    this.world = world;
    /** @type {number} @private */
    this._cx = 0x7fffffff;
    /** @type {number} @private */
    this._cz = 0x7fffffff;
    /** @type {?Object} @private */
    this._chunk = null;
  }

  /**
   * Forget the cached chunk. Call once per tick, and after anything that could
   * unload chunks.
   * @returns {void}
   */
  invalidate() {
    this._cx = 0x7fffffff;
    this._cz = 0x7fffffff;
    this._chunk = null;
  }

  /**
   * Resolve (and cache) a chunk.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @returns {?Object} The chunk, or `null` when it is not loaded.
   */
  chunkAt(cx, cz) {
    if (cx === this._cx && cz === this._cz) return this._chunk;
    this._cx = cx;
    this._cz = cz;
    const world = this.world;
    this._chunk = world !== null && typeof world.getChunk === 'function'
      ? world.getChunk(cx, cz) : null;
    return this._chunk;
  }

  /**
   * Read a block id.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} Block id, `0` outside the loaded area.
   */
  get(x, y, z) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return 0;
    const chunk = this.chunkAt(x >> 4, z >> 4);
    return chunk === null ? 0 : chunk.getBlock(x & 15, y, z & 15);
  }

  /**
   * Whether the chunk owning a column is loaded and generated.
   * @param {number} x World X.
   * @param {number} z World Z.
   * @returns {boolean} `true` when reads at this column are meaningful.
   */
  loaded(x, z) {
    const chunk = this.chunkAt(x >> 4, z >> 4);
    return chunk !== null && chunk.generated === true;
  }

  /**
   * Packed light of a voxel.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} Packed light value.
   */
  lightPacked(x, y, z) {
    if (y < WORLD_MIN_Y) return 0;
    if (y >= WORLD_MAX_Y) return 0xf000;
    const chunk = this.chunkAt(x >> 4, z >> 4);
    return chunk === null ? 0xf000 : chunk.getLightPacked(x & 15, y, z & 15);
  }

  /**
   * The light level a plant sees: the brighter of sky light and the strongest
   * block-light channel.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} Light level 0..15.
   */
  light(x, y, z) {
    const v = this.lightPacked(x, y, z);
    const sky = (v >> 12) & 15;
    const r = v & 15;
    const g = (v >> 4) & 15;
    const b = (v >> 8) & 15;
    let block = r > g ? r : g;
    if (b > block) block = b;
    return sky > block ? sky : block;
  }
}

/* ========================================================================== */
/* Free helpers                                                               */
/* ========================================================================== */

/**
 * Whether a block is a plant-shaped (cross model) block, which is what
 * farmland tolerates on top of itself.
 * @param {number} id Block id.
 * @returns {boolean} `true` for cross-rendered plants and air.
 */
export function isPlantLike(id) {
  if (id === 0) return true;
  return blockRender(id) === RENDER.CROSS;
}

/**
 * Whether a fruit, plant or sapling may be written into this cell.
 * @param {number} id Block id currently there.
 * @returns {boolean} `true` for air and replaceable blocks.
 */
export function isFreeCell(id) {
  return id === 0 || isReplaceable(id);
}

/**
 * Whether a soil block can carry a melon or pumpkin.
 * @param {number} id Block id.
 * @returns {boolean} `true` for the soils in {@link FRUIT_SOILS}.
 */
function isFruitSoil(id) {
  for (let i = 0; i < FRUIT_SOILS.length; i++) if (FRUIT_SOILS[i] === id) return true;
  return false;
}

/**
 * Whether a hoe may till this block.
 * @param {number} id Block id.
 * @returns {boolean} `true` for dirt-like soils.
 */
export function isTillable(id) {
  for (let i = 0; i < TILLABLE_BLOCKS.length; i++) if (TILLABLE_BLOCKS[i] === id) return true;
  return false;
}

/* ========================================================================== */
/* FarmingSystem                                                              */
/* ========================================================================== */

/** Entity types that never trample farmland. @type {Set<string>} */
const NON_TRAMPLING = new Set(['item', 'xp_orb', 'arrow', 'falling_block']);

/** Scratch list reused by the entity pass. @type {Object[]} */
const _entityScratch = [];

/** Shared empty list so {@link FarmingSystem#breedFoods} never allocates. @type {readonly string[]} */
const EMPTY_STRINGS = Object.freeze([]);

/** Radius in blocks scanned for trampling and breeding upkeep. @type {number} */
const ENTITY_PASS_RADIUS = 48;

/** Scratch offsets for the four horizontal neighbours. @type {Int8Array} */
const NEIGHBOR_DX = new Int8Array([1, -1, 0, 0]);

/** Scratch offsets for the four horizontal neighbours. @type {Int8Array} */
const NEIGHBOR_DZ = new Int8Array([0, 0, 1, -1]);

/**
 * The agriculture simulation: random-tick plant growth, soil hydration,
 * composting, bone meal and animal breeding.
 *
 * Create one per world, call {@link FarmingSystem#attach} once the world and
 * the entity manager exist, and {@link FarmingSystem#tick} from the fixed
 * 20 TPS game tick.
 */
export class FarmingSystem extends EventBus {
  /**
   * @param {Object} world The chunk manager (`world/world.js`).
   * @param {Object} entityManager The entity manager (`game/entities.js`).
   * @param {{environment?:Object, audio?:Object, particles?:Object, player?:Object,
   *   seed?:number, budgetMs?:number, simulationDistance?:number,
   *   growthSpeed?:number}} [options] Optional collaborators and tuning.
   */
  constructor(world, entityManager, options = {}) {
    super();

    /** @type {Object} The chunk manager. */
    this.world = world || null;
    /** @type {Object} The entity manager. */
    this.entities = entityManager || null;
    /** @type {?Object} Time and weather. */
    this.environment = options.environment || null;
    /** @type {?Object} Sound engine. */
    this.audio = options.audio || null;
    /** @type {?Object} Particle system. */
    this.particles = options.particles || null;
    /** @type {?Object} The player, used as the centre of the simulation. */
    this.player = options.player || null;

    /** @type {number} Seed of this system's PRNG. */
    this.seed = (num(options.seed, (Math.random() * 0xffffffff) >>> 0) >>> 0);
    /** @type {() => number} Deterministic random source. */
    this.rng = mulberry32(this.seed);

    /** @type {number} Milliseconds the whole farming tick may use. */
    this.budgetMs = Math.max(0.2, num(options.budgetMs, DEFAULT_BUDGET_MS));
    /** @type {number} Radius in chunks around the player that is simulated. */
    this.simulationDistance = Math.max(1,
      num(options.simulationDistance, DEFAULT_SIMULATION_DISTANCE) | 0);
    /** @type {number} Global multiplier on every growth probability. */
    this.growthSpeed = clamp(num(options.growthSpeed, 1), 0.01, 20);

    /** @type {Map<number, Map<number, PlantState>>} Per-chunk state buckets. @private */
    this._states = new Map();
    /** @type {number} Maximum number of stored chunk buckets. @private */
    this._maxStoredChunks = 4096;

    /** @type {BlockView} Chunk-caching reader. @private */
    this._view = new BlockView(world);
    /** @type {TimeBudget} Tick budget. @private */
    this._budget = new TimeBudget(this.budgetMs);

    /** @type {Object[]} Cached list of simulated chunks. @private */
    this._chunkList = [];
    /** @type {number} Resume cursor into {@link _chunkList}. @private */
    this._cursor = 0;
    /** @type {number} Ticks until the chunk list is rebuilt. @private */
    this._listAge = 0;
    /** @type {number} Ticks elapsed. @private */
    this._ticks = 0;

    /** @type {number} Random ticks handed out since construction. @private */
    this._sampleCount = 0;
    /** @type {number} Growth events since construction. @private */
    this._growthCount = 0;

    /** @type {?function(Object):void} Chunk-unload listener. @private */
    this._onUnload = null;
    /** @type {?function(number,number,number,number,number):void} Block listener. @private */
    this._onBlock = null;
    /** @type {?function(number):void} Player landing listener. @private */
    this._onLand = null;
    /** @type {?Object} Player the landing listener is bound to. @private */
    this._landPlayer = null;
    /** @type {boolean} Whether {@link attach} ran. @private */
    this._attached = false;

    /**
     * Reusable context object for calls that arrive outside `tick()`; kept as
     * one instance so feeding an animal never allocates.
     * @type {Object} @private
     */
    this._ctxCache = {
      world: null, player: null, entities: null, environment: null,
      audio: null, particles: null, combat: null, difficulty: 2,
    };
  }

  /* ---------------------------------------------------------------- setup */

  /**
   * Adopt the collaborators carried by the game's shared tick context.
   * @param {Object} ctx The tick context (`{player, entities, particles, …}`).
   * @returns {void}
   */
  setContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    if (ctx.player) this.player = ctx.player;
    if (ctx.entities) this.entities = ctx.entities;
    if (ctx.particles) this.particles = ctx.particles;
    if (ctx.audio) this.audio = ctx.audio;
    if (ctx.environment) this.environment = ctx.environment;
    if (ctx.world && this.world === null) {
      this.world = ctx.world;
      this._view.world = ctx.world;
    }
  }

  /**
   * Subscribe to world and player events. Safe to call twice.
   * @returns {FarmingSystem} `this`.
   */
  attach() {
    if (this._attached) return this;
    this._attached = true;
    const world = this.world;
    if (world !== null && typeof world.on === 'function') {
      this._onUnload = (chunk) => {
        try {
          this._releaseChunk(chunk);
        } catch (err) {
          warnOnce('unload', 'chunk unload bookkeeping failed', err);
        }
      };
      this._onBlock = (x, y, z, prev, next) => {
        try {
          this._onBlockChanged(x, y, z, prev, next);
        } catch (err) {
          warnOnce('blockChanged', 'block change bookkeeping failed', err);
        }
      };
      world.on('chunkUnloaded', this._onUnload);
      world.on('blockChanged', this._onBlock);
    }
    this.bindPlayer(this.player);
    return this;
  }

  /**
   * Listen to a player's `'land'` event so a jump onto a field tramples it.
   * @param {?Object} player The player, or `null` to unbind.
   * @returns {void}
   */
  bindPlayer(player) {
    if (this._landPlayer !== null && this._onLand !== null
      && typeof this._landPlayer.off === 'function') {
      this._landPlayer.off('land', this._onLand);
    }
    this._landPlayer = null;
    this._onLand = null;
    if (!player || typeof player.on !== 'function') return;
    this.player = player;
    this._onLand = (fallDistance) => {
      try {
        if (num(fallDistance, 0) > TRAMPLE_MIN_FALL) this.trampleUnder(player);
      } catch (err) {
        warnOnce('land', 'trample on landing failed', err);
      }
    };
    this._landPlayer = player;
    player.on('land', this._onLand);
  }

  /**
   * Unsubscribe from every event source.
   * @returns {void}
   */
  detach() {
    const world = this.world;
    if (world !== null && typeof world.off === 'function') {
      if (this._onUnload !== null) world.off('chunkUnloaded', this._onUnload);
      if (this._onBlock !== null) world.off('blockChanged', this._onBlock);
    }
    this._onUnload = null;
    this._onBlock = null;
    this.bindPlayer(null);
    this._attached = false;
  }

  /* ----------------------------------------------------------------- store */

  /**
   * The state bucket of a chunk.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @param {boolean} [create=false] Create the bucket when missing.
   * @returns {?Map<number, PlantState>} The bucket, or `null`.
   * @private
   */
  _bucket(cx, cz, create = false) {
    const key = farmChunkKey(cx, cz);
    let bucket = this._states.get(key);
    if (bucket === undefined) {
      if (!create) return null;
      bucket = new Map();
      this._states.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Read the plant state of a voxel.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {?PlantState} The record, or `null`.
   */
  getState(x, y, z) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return null;
    const bucket = this._bucket(x >> 4, z >> 4, false);
    if (bucket === null) return null;
    const rec = bucket.get(farmLocalKey(x, y, z));
    return rec === undefined ? null : rec;
  }

  /**
   * Write the plant state of a voxel.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {PlantState} state The record.
   * @returns {PlantState} `state`.
   */
  setState(x, y, z, state) {
    const bucket = this._bucket(x >> 4, z >> 4, true);
    if (bucket !== null) bucket.set(farmLocalKey(x, y, z), state);
    return state;
  }

  /**
   * Drop the plant state of a voxel.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when a record was removed.
   */
  clearState(x, y, z) {
    const bucket = this._bucket(x >> 4, z >> 4, false);
    if (bucket === null) return false;
    const removed = bucket.delete(farmLocalKey(x, y, z));
    if (removed && bucket.size === 0) this._states.delete(farmChunkKey(x >> 4, z >> 4));
    return removed;
  }

  /**
   * Whether a record still describes the block that sits on it.
   * @param {PlantState} state The record.
   * @param {number} id Block id now at that position.
   * @returns {boolean} `true` when the record is still valid.
   * @private
   */
  _recordMatches(state, id) {
    switch (state.kind) {
      case PLANT.FARMLAND: return id === FARMLAND_BLOCK;
      case PLANT.STEM: return STEM_BLOCK[id] === 1;
      case PLANT.SAPLING: return SAPLING_BLOCK[id] === 1;
      case PLANT.NETHER_WART: return WART_BLOCK[id] === 1;
      case PLANT.COCOA: return COCOA_FLAG[id] === 1;
      case PLANT.COMPOSTER: return id === COMPOSTER_BLOCK;
      default: return false;
    }
  }

  /**
   * Drop records whose block has been replaced by something else.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} prev Previous block id.
   * @param {number} next New block id.
   * @returns {void}
   * @private
   */
  _onBlockChanged(x, y, z, prev, next) {
    void prev;
    const rec = this.getState(x, y, z);
    if (rec === null) return;
    if (!this._recordMatches(rec, next)) this.clearState(x, y, z);
  }

  /**
   * Chunk unloaded: keep the records (they are cheap and the chunk usually
   * comes back) but bound the total number of stored buckets.
   * @param {Object} chunk The unloaded chunk.
   * @returns {void}
   * @private
   */
  _releaseChunk(chunk) {
    this._view.invalidate();
    this._chunkList.length = 0;
    this._listAge = 0;
    if (this._states.size <= this._maxStoredChunks) return;
    const world = this.world;
    let excess = this._states.size - this._maxStoredChunks;
    for (const key of this._states.keys()) {
      if (excess <= 0) break;
      const cx = Math.floor(key / 262144) - 131072;
      const cz = (key % 262144) - 131072;
      if (world !== null && typeof world.isLoaded === 'function' && world.isLoaded(cx, cz)) continue;
      this._states.delete(key);
      excess--;
    }
    void chunk;
  }

  /* ------------------------------------------------------------------ tick */

  /**
   * One fixed game tick: random-tick growth, trampling and breeding upkeep.
   * Never throws.
   * @param {number} dt Seconds since the last tick (always 1/20 in practice).
   * @param {Object} [ctx] The game's shared tick context.
   * @returns {void}
   */
  tick(dt, ctx) {
    if (ctx !== undefined) this.setContext(ctx);
    const step = clamp(num(dt, 0.05), 0, 0.25);
    this._ticks++;
    this._budget.setBudget(this.budgetMs).start();
    this._view.invalidate();

    try {
      this._randomTickPass();
    } catch (err) {
      warnOnce('randomTick', 'random tick pass failed; growth paused this tick', err);
    }
    try {
      this._entityPass(step);
    } catch (err) {
      warnOnce('entityPass', 'entity pass failed; trampling and breeding upkeep paused', err);
    }
  }

  /**
   * Visit chunks round-robin, handing every non-empty section its fixed number
   * of random voxels, and stop as soon as the budget is gone.
   * @returns {void}
   * @private
   */
  _randomTickPass() {
    const list = this._refreshChunkList();
    const n = list.length;
    if (n === 0) return;
    if (this._cursor >= n) this._cursor = 0;
    const budget = this._budget;
    let visited = 0;
    while (visited < n) {
      const chunk = list[this._cursor];
      this._cursor = this._cursor + 1 >= n ? 0 : this._cursor + 1;
      visited++;
      if (chunk !== null && chunk !== undefined && chunk.generated === true) {
        this._tickChunk(chunk);
      }
      if (budget.expired()) break;
    }
  }

  /**
   * Rebuild — at most every {@link CHUNK_LIST_REFRESH_TICKS} ticks — the list
   * of chunks inside the simulation radius.
   * @returns {Object[]} The cached chunk list.
   * @private
   */
  _refreshChunkList() {
    if (this._listAge > 0 && this._chunkList.length > 0) {
      this._listAge--;
      return this._chunkList;
    }
    this._listAge = CHUNK_LIST_REFRESH_TICKS;
    const list = this._chunkList;
    list.length = 0;
    const world = this.world;
    if (world === null || !world.chunks || typeof world.chunks.forEach !== 'function') return list;

    const player = this.player;
    const hasCentre = player !== null && player !== undefined && player.position
      && Number.isFinite(player.position[0]);
    const ccx = hasCentre ? Math.floor(player.position[0]) >> 4 : 0;
    const ccz = hasCentre ? Math.floor(player.position[2]) >> 4 : 0;
    const r = this.simulationDistance;
    const r2 = r * r;

    world.chunks.forEach((chunk) => {
      if (!chunk || chunk.generated !== true) return;
      if (hasCentre) {
        const dx = chunk.cx - ccx;
        const dz = chunk.cz - ccz;
        if (dx * dx + dz * dz > r2) return;
      }
      list.push(chunk);
    });
    if (this._cursor >= list.length) this._cursor = 0;
    return list;
  }

  /**
   * Hand every non-empty section of one chunk its random voxels.
   * @param {Object} chunk The chunk.
   * @returns {void}
   * @private
   */
  _tickChunk(chunk) {
    const sections = chunk.sections;
    if (!sections) return;
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    const rng = this.rng;

    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const section = sections[sy];
      if (section === null || section === undefined) continue;
      const blocks = section.blocks;
      if (blocks === null || section.nonAirCount === 0) continue;
      const originY = Number.isFinite(section.originY)
        ? section.originY : WORLD_MIN_Y + sy * 16;

      for (let s = 0; s < RANDOM_TICK_SAMPLES; s++) {
        const idx = (rng() * 4096) | 0;
        const id = blocks[idx];
        this._sampleCount++;
        if (id === 0) continue;
        const kind = TICK_KIND[id];
        if (kind === TICK.NONE) continue;
        const x = baseX + (idx & 15);
        const z = baseZ + ((idx >> 4) & 15);
        const y = originY + ((idx >> 8) & 15);
        this._randomTick(kind, x, y, z, id);
      }
    }
  }

  /**
   * Run one random tick on a single voxel.
   * @param {number} kind The {@link TICK} dispatch code.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _randomTick(kind, x, y, z, id) {
    const rec = this.getState(x, y, z);
    if (rec !== null) {
      switch (rec.kind) {
        case PLANT.STEM: this._tickStem(x, y, z, id, rec); return;
        case PLANT.SAPLING: this._tickSapling(x, y, z, id, rec); return;
        case PLANT.NETHER_WART: this._tickNetherWart(x, y, z, id, rec); return;
        case PLANT.COCOA: this._tickCocoa(x, y, z, id, rec); return;
        case PLANT.COMPOSTER: return;
        default: break;
      }
    }

    switch (kind) {
      case TICK.CROP: this._tickCrop(x, y, z, id); break;
      case TICK.FARMLAND: this._tickFarmland(x, y, z, rec); break;
      case TICK.SUGAR_CANE: this._tickColumnPlant(x, y, z, id, SUGAR_CANE_MAX_HEIGHT, SUGAR_CANE_CHANCE, false); break;
      case TICK.CACTUS: this._tickColumnPlant(x, y, z, id, CACTUS_MAX_HEIGHT, CACTUS_CHANCE, true); break;
      case TICK.BAMBOO: this._tickBamboo(x, y, z, id); break;
      case TICK.GRASS: this._tickSpreadingSoil(x, y, z, id, TICK.GRASS); break;
      case TICK.MYCELIUM: this._tickSpreadingSoil(x, y, z, id, TICK.MYCELIUM); break;
      case TICK.MOSS: this._tickSpreadingSoil(x, y, z, id, TICK.MOSS); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------- utilities */

  /**
   * Random integer in `[a, b]`.
   * @param {number} a Lower bound.
   * @param {number} b Upper bound.
   * @returns {number} The value.
   * @private
   */
  _randInt(a, b) {
    return a + ((this.rng() * (b - a + 1)) | 0);
  }

  /**
   * Write a block through the world, guarded.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {boolean} `true` when the world changed.
   * @private
   */
  _place(x, y, z, id) {
    const world = this.world;
    if (world === null || typeof world.setBlock !== 'function') return false;
    try {
      return world.setBlock(x, y, z, id) === true;
    } catch (err) {
      warnOnce('setBlock', 'world.setBlock failed; growth disabled for this block', err);
      return false;
    }
  }

  /**
   * Break a plant and drop its loot.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id being broken.
   * @returns {void}
   * @private
   */
  _breakPlant(x, y, z, id) {
    let drops = null;
    try {
      drops = blockDrops(id, null, 0, 0, this.rng);
    } catch (err) {
      warnOnce('drops', 'blockDrops failed for a plant', err);
    }
    if (!this._place(x, y, z, 0)) return;
    this.clearState(x, y, z);
    const em = this.entities;
    if (drops !== null && em !== null && typeof em.dropBlockLoot === 'function') {
      try {
        em.dropBlockLoot(x, y, z, drops);
      } catch (err) {
        warnOnce('dropLoot', 'dropping plant loot failed', err);
      }
    }
  }

  /**
   * Spawn the small green sparkle growth uses.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} [count=8] Particle count.
   * @returns {void}
   * @private
   */
  _growParticles(x, y, z, count = 8) {
    const particles = this.particles;
    if (particles === null || typeof particles.spawn !== 'function') return;
    try {
      particles.spawn('spark', x + 0.5, y + 0.55, z + 0.5,
        { count, speed: 0.8, life: 0.7, color: [0.35, 0.95, 0.3] });
    } catch (err) {
      warnOnce('particles', 'growth particles failed', err);
    }
  }

  /**
   * Play a block sound, guarded.
   * @param {string} action `'place'`, `'break'` or `'hit'`.
   * @param {number} blockId Block id whose material decides the sound.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _sound(action, blockId, x, y, z) {
    const audio = this.audio;
    if (audio === null || typeof audio.playBlockSound !== 'function') return;
    try {
      audio.playBlockSound(action, blockId, x + 0.5, y + 0.5, z + 0.5);
    } catch (err) {
      warnOnce('audio', 'farming sound failed', err);
    }
  }

  /**
   * Whether it is raining on the surface right now.
   * @returns {boolean} `true` during rain, snow or a thunderstorm.
   * @private
   */
  _isRaining() {
    const env = this.environment;
    if (env === null) return false;
    if (typeof env.isRaining === 'function') {
      try {
        return env.isRaining() === true;
      } catch (err) {
        warnOnce('rain', 'environment.isRaining failed', err);
        return false;
      }
    }
    return num(env.rainStrength, 0) > 0.01;
  }

  /* ------------------------------------------------------------- soil ---- */

  /**
   * Is there a water source within {@link FARMLAND_WATER_RANGE} blocks of this
   * soil, on its own level or the one above? Reads through the cached
   * {@link BlockView}, so the 9x9x2 box costs one chunk lookup per column.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when the soil counts as irrigated.
   */
  hasWaterNearby(x, y, z) {
    const view = this._view;
    const r = FARMLAND_WATER_RANGE;
    const water = B.WATER;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = 0; dy <= 1; dy++) {
          if (view.get(x + dx, y + dy, z + dz) === water) return true;
        }
      }
    }
    return false;
  }

  /**
   * Moisture of a farmland block, computing and caching it the first time.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} Moisture 0..7.
   */
  moistureAt(x, y, z) {
    let rec = this.getState(x, y, z);
    if (rec !== null && rec.kind === PLANT.FARMLAND) return rec.moisture;
    rec = new PlantState(PLANT.FARMLAND);
    rec.moisture = this.hasWaterNearby(x, y, z) || this._isRaining()
      ? FARMLAND_MAX_MOISTURE : 0;
    this.setState(x, y, z, rec);
    return rec.moisture;
  }

  /**
   * Farmland random tick: re-hydrate, dry out, revert to dirt when it dried up
   * with nothing planted on it or got covered by a solid block.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {?PlantState} existing Record found by the dispatcher, may be `null`.
   * @returns {void}
   * @private
   */
  _tickFarmland(x, y, z, existing) {
    const view = this._view;
    const above = view.get(x, y + 1, z);
    if (above !== 0 && isSolid(above) && !isPlantLike(above)) {
      if (this._place(x, y, z, DIRT_BLOCK)) {
        this.clearState(x, y, z);
        this.emit('dry', x, y, z);
      }
      return;
    }

    let rec = existing !== null && existing.kind === PLANT.FARMLAND ? existing : null;
    if (rec === null) {
      rec = new PlantState(PLANT.FARMLAND);
      rec.moisture = FARMLAND_MAX_MOISTURE;
      this.setState(x, y, z, rec);
    }

    if (this.hasWaterNearby(x, y, z) || this._isRaining()) {
      rec.moisture = FARMLAND_MAX_MOISTURE;
      return;
    }
    if (rec.moisture > 0) {
      rec.moisture--;
      return;
    }
    // Bone dry: farmland with a plant on it survives, bare farmland collapses.
    if (isPlantLike(above) && above !== 0) return;
    if (this._place(x, y, z, DIRT_BLOCK)) {
      this.clearState(x, y, z);
      this.emit('dry', x, y, z);
    }
  }

  /* ------------------------------------------------------------- crops --- */

  /**
   * Vanilla's growth-point formula: the farmland under and around the crop
   * contributes points (moist soil three times as much as dry, diagonals a
   * quarter), and a crop that touches its own kind on both axes grows at half
   * speed. The result is the probability that this random tick advances the
   * plant.
   * @param {number} x World X.
   * @param {number} y World Y (the plant itself).
   * @param {number} z World Z.
   * @returns {number} Probability in `[0, 1]`.
   */
  growthChance(x, y, z) {
    const view = this._view;
    let points = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const soil = view.get(x + dx, y - 1, z + dz);
        let p = 0;
        if (soil === FARMLAND_BLOCK) p = this.moistureAt(x + dx, y - 1, z + dz) > 0 ? 3 : 1;
        if (dx !== 0 || dz !== 0) p *= 0.25;
        points += p;
      }
    }
    if (points <= 0) return 0;

    const self = view.get(x, y, z);
    const group = CROP_FAMILY_IDX[self];
    if (group >= 0) {
      const north = CROP_FAMILY_IDX[view.get(x, y, z - 1)] === group;
      const south = CROP_FAMILY_IDX[view.get(x, y, z + 1)] === group;
      const west = CROP_FAMILY_IDX[view.get(x - 1, y, z)] === group;
      const east = CROP_FAMILY_IDX[view.get(x + 1, y, z)] === group;
      if ((north || south) && (west || east)) {
        points *= 0.5;
      } else {
        const diag = CROP_FAMILY_IDX[view.get(x - 1, y, z - 1)] === group
          || CROP_FAMILY_IDX[view.get(x + 1, y, z - 1)] === group
          || CROP_FAMILY_IDX[view.get(x - 1, y, z + 1)] === group
          || CROP_FAMILY_IDX[view.get(x + 1, y, z + 1)] === group;
        if (diag) points *= 0.5;
      }
    }
    return 1 / (Math.floor(25 / points) + 1);
  }

  /**
   * Crop random tick: pop off unsupported crops, refuse to grow in the dark,
   * otherwise roll the growth chance and advance one stage.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Crop block id.
   * @returns {void}
   * @private
   */
  _tickCrop(x, y, z, id) {
    const view = this._view;
    if (view.get(x, y - 1, z) !== FARMLAND_BLOCK) {
      this._breakPlant(x, y, z, id);
      return;
    }
    const next = nextCropStage(id);
    if (next === 0) return;
    if (view.light(x, y, z) < CROP_LIGHT_MIN) return;
    if (this.rng() >= this.growthChance(x, y, z) * this.growthSpeed) return;
    if (!this._place(x, y, z, next)) return;
    this._growthCount++;
    this.emit('grow', x, y, z, next);
  }

  /* ------------------------------------------------------------- stems --- */

  /**
   * Stem random tick: age the stem and, once mature, try to set a fruit on a
   * free neighbouring soil block.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Current stem block id.
   * @param {PlantState} rec The stem record.
   * @returns {void}
   * @private
   */
  _tickStem(x, y, z, id, rec) {
    const view = this._view;
    if (view.get(x, y - 1, z) !== FARMLAND_BLOCK) {
      this._breakPlant(x, y, z, id);
      return;
    }
    if (view.light(x, y, z) < CROP_LIGHT_MIN) return;
    const type = STEM_TYPES[rec.species] || STEM_TYPES[0];
    if (this.rng() >= this.growthChance(x, y, z) * this.growthSpeed) return;

    if (rec.age < STEM_MAX_AGE) {
      rec.age++;
      const want = type.blocks[rec.age];
      if (want > 0 && want !== id) this._place(x, y, z, want);
      this._growthCount++;
      this.emit('grow', x, y, z, want > 0 ? want : id);
      return;
    }
    this._growFruit(x, y, z, type);
  }

  /**
   * Try to place the fruit of a mature stem.
   * @param {number} x Stem X.
   * @param {number} y Stem Y.
   * @param {number} z Stem Z.
   * @param {StemType} type The stem type.
   * @returns {boolean} `true` when a fruit was placed.
   * @private
   */
  _growFruit(x, y, z, type) {
    if (type.fruit <= 0) return false;
    const view = this._view;
    for (let d = 0; d < 4; d++) {
      if (view.get(x + NEIGHBOR_DX[d], y, z + NEIGHBOR_DZ[d]) === type.fruit) return false;
    }
    const d = this._randInt(0, 3);
    const nx = x + NEIGHBOR_DX[d];
    const nz = z + NEIGHBOR_DZ[d];
    if (!isFreeCell(view.get(nx, y, nz))) return false;
    if (!isFruitSoil(view.get(nx, y - 1, nz))) return false;
    if (!this._place(nx, y, nz, type.fruit)) return false;
    this._growthCount++;
    this._sound('place', type.fruit, nx, y, nz);
    this.emit('fruit', nx, y, nz, type.fruit);
    return true;
  }

  /* ---------------------------------------------------------- tall plants  */

  /**
   * Sugar cane and cactus: grow one block upward while below the height limit.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id The plant's block id.
   * @param {number} maxHeight Maximum column height.
   * @param {number} chance Per-random-tick growth probability.
   * @param {boolean} needsFreeSides `true` for cactus.
   * @returns {void}
   * @private
   */
  _tickColumnPlant(x, y, z, id, maxHeight, chance, needsFreeSides) {
    const view = this._view;
    // Support first: a column whose base was mined drops even when it is not
    // the topmost block of the stack.
    if (view.get(x, y - 1, z) === 0) {
      this._breakPlant(x, y, z, id);
      return;
    }
    if (view.get(x, y + 1, z) !== 0) return;
    let height = 1;
    while (height <= maxHeight && view.get(x, y - height, z) === id) height++;
    if (height >= maxHeight) return;
    if (needsFreeSides) {
      for (let d = 0; d < 4; d++) {
        const side = view.get(x + NEIGHBOR_DX[d], y + 1, z + NEIGHBOR_DZ[d]);
        if (side !== 0 && isSolid(side)) return;
      }
    }
    if (this.rng() >= chance * this.growthSpeed) return;
    if (!this._place(x, y + 1, z, id)) return;
    this._growthCount++;
    this.emit('grow', x, y + 1, z, id);
  }

  /**
   * Bamboo: taller than cane or cactus, and it needs light.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Bamboo block id.
   * @returns {void}
   * @private
   */
  _tickBamboo(x, y, z, id) {
    const view = this._view;
    if (view.get(x, y + 1, z) !== 0) return;
    if (view.light(x, y + 1, z) < CROP_LIGHT_MIN) return;
    let height = 1;
    while (height <= BAMBOO_MAX_HEIGHT && view.get(x, y - height, z) === id) height++;
    if (height >= BAMBOO_MAX_HEIGHT) return;
    if (this.rng() >= BAMBOO_CHANCE * this.growthSpeed) return;
    if (!this._place(x, y + 1, z, id)) return;
    this._growthCount++;
    this.emit('grow', x, y + 1, z, id);
  }

  /* ---------------------------------------------------------- saplings --- */

  /**
   * Soils a sapling accepts.
   * @param {number} id Block id under the sapling.
   * @returns {boolean} `true` when a tree may root here.
   * @private
   */
  _isSaplingSoil(id) {
    return id === DIRT_BLOCK || id === B.GRASS_BLOCK || id === B.COARSE_DIRT
      || id === B.PODZOL || id === B.MYCELIUM || id === FARMLAND_BLOCK
      || id === B.MOSS_BLOCK || id === B.MUD;
  }

  /**
   * Sapling random tick: two lit stages, then a tree.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Sapling block id.
   * @param {PlantState} rec The sapling record.
   * @returns {void}
   * @private
   */
  _tickSapling(x, y, z, id, rec) {
    const view = this._view;
    if (!this._isSaplingSoil(view.get(x, y - 1, z))) {
      this._breakPlant(x, y, z, id);
      return;
    }
    if (view.light(x, y, z) < CROP_LIGHT_MIN) return;
    if (this.rng() >= SAPLING_CHANCE * this.growthSpeed) return;
    if (rec.age < 1) {
      rec.age = 1;
      return;
    }
    this.growTree(x, y, z, rec.species);
  }

  /**
   * Is there room for a trunk and a crown above this sapling?
   * @param {number} x World X.
   * @param {number} y Sapling Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when the tree may be written.
   * @private
   */
  _hasTreeRoom(x, y, z) {
    const view = this._view;
    if (!view.loaded(x, z)) return false;
    for (let dy = 0; dy < 6; dy++) {
      const cy = y + dy;
      if (cy >= WORLD_MAX_Y - 1) return false;
      const radius = dy < 2 ? 0 : 1;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx === 0 && dz === 0 && dy === 0) continue;
          if (!this._isTreeOverwritable(view.get(x + dx, cy, z + dz))) return false;
        }
      }
    }
    return true;
  }

  /**
   * May a growing tree write over this block?
   * @param {number} id Block id.
   * @returns {boolean} `true` for air, plants and leaves.
   * @private
   */
  _isTreeOverwritable(id) {
    if (id === 0 || isReplaceable(id)) return true;
    if (blockRender(id) === RENDER.CROSS) return true;
    const def = blockDef(id);
    return typeof def.name === 'string' && def.name.endsWith('_leaves');
  }

  /**
   * Turn a sapling into a tree through `world/structures.js`.
   * @param {number} x Sapling X.
   * @param {number} y Sapling Y.
   * @param {number} z Sapling Z.
   * @param {number} speciesIndex Index into {@link SAPLING_SPECIES}.
   * @returns {boolean} `true` when a tree was written.
   */
  growTree(x, y, z, speciesIndex) {
    const species = SAPLING_SPECIES[speciesIndex] || SAPLING_SPECIES[0];
    if (!this._hasTreeRoom(x, y, z)) return false;

    const view = this._view;
    const previous = view.get(x, y, z);
    const record = this.getState(x, y, z);
    const type = species.bigTree !== null && this.rng() < species.bigChance
      ? species.bigTree : species.tree;

    this._place(x, y, z, 0);
    this.clearState(x, y, z);

    let grown = false;
    const world = this.world;
    try {
      grown = placeTree((bx, by, bz, bid) => {
        if (by < WORLD_MIN_Y || by >= WORLD_MAX_Y) return;
        if (!this._isTreeOverwritable(view.get(bx, by, bz))) return;
        if (world !== null && typeof world.setBlock === 'function') world.setBlock(bx, by, bz, bid);
      }, this.rng, x, y - 1, z, type) !== false;
    } catch (err) {
      warnOnce('placeTree', 'structures.placeTree failed; sapling restored', err);
      grown = false;
    }

    if (!grown) {
      if (previous > 0) this._place(x, y, z, previous);
      if (record !== null) this.setState(x, y, z, record);
      return false;
    }
    this._growthCount++;
    this._sound('place', species.block, x, y, z);
    this.emit('tree', x, y, z, species.key);
    return true;
  }

  /* --------------------------------------------------- wart & cocoa ------ */

  /**
   * Block a nether wart of a given age draws as.
   * @param {number} age Age 0..3.
   * @returns {number} Block id.
   * @private
   */
  _wartBlock(age) {
    return WART_BLOCKS[clamp(age | 0, 0, WART_BLOCKS.length - 1)];
  }

  /**
   * Block a cocoa pod of a given age draws as.
   * @param {number} age Age 0..2.
   * @returns {number} Block id.
   * @private
   */
  _cocoaBlock(age) {
    return COCOA_BLOCKS[clamp(age | 0, 0, COCOA_BLOCKS.length - 1)];
  }

  /**
   * Nether wart random tick: soul sand only, no light requirement, slow.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Current block id.
   * @param {PlantState} rec The wart record.
   * @returns {void}
   * @private
   */
  _tickNetherWart(x, y, z, id, rec) {
    const view = this._view;
    const below = view.get(x, y - 1, z);
    if (below !== B.SOUL_SAND && below !== B.SOUL_SOIL) {
      this._breakPlant(x, y, z, id);
      return;
    }
    if (rec.age >= 3) return;
    if (this.rng() >= NETHER_WART_CHANCE * this.growthSpeed) return;
    rec.age++;
    const want = this._wartBlock(rec.age);
    if (want > 0 && want !== id) this._place(x, y, z, want);
    this._growthCount++;
    this.emit('grow', x, y, z, want > 0 ? want : id);
  }

  /**
   * Cocoa random tick: it must stay attached to a jungle log.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Current block id.
   * @param {PlantState} rec The cocoa record.
   * @returns {void}
   * @private
   */
  _tickCocoa(x, y, z, id, rec) {
    if (!this._cocoaHost(x, y, z)) {
      this._breakPlant(x, y, z, id);
      return;
    }
    if (rec.age >= 2) return;
    if (this.rng() >= COCOA_CHANCE * this.growthSpeed) return;
    rec.age++;
    const want = this._cocoaBlock(rec.age);
    if (want > 0 && want !== id) this._place(x, y, z, want);
    this._growthCount++;
    this.emit('grow', x, y, z, want > 0 ? want : id);
  }

  /**
   * Is one of the four horizontal neighbours a jungle log?
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when the pod has a host.
   * @private
   */
  _cocoaHost(x, y, z) {
    const view = this._view;
    const jungle = B.JUNGLE_LOG;
    for (let d = 0; d < 4; d++) {
      if (view.get(x + NEIGHBOR_DX[d], y, z + NEIGHBOR_DZ[d]) === jungle) return true;
    }
    return false;
  }

  /* ------------------------------------------------------ spreading soil - */

  /**
   * May this soil type claim the target block?
   * @param {number} kind The {@link TICK} code of the source soil.
   * @param {number} target Block id of the candidate.
   * @returns {boolean} `true` when the block may be converted.
   * @private
   */
  _canSpreadOnto(kind, target) {
    if (kind === TICK.MOSS) {
      return target === DIRT_BLOCK || target === B.COARSE_DIRT || target === B.STONE
        || target === B.PODZOL || target === B.GRAVEL;
    }
    if (kind === TICK.MYCELIUM) {
      return target === DIRT_BLOCK || target === B.COARSE_DIRT || target === B.GRASS_BLOCK;
    }
    return target === DIRT_BLOCK || target === B.COARSE_DIRT;
  }

  /**
   * Grass, mycelium and moss random tick: die under a solid block, otherwise
   * creep onto nearby bare soil.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id The soil's own block id.
   * @param {number} kind The {@link TICK} code.
   * @returns {void}
   * @private
   */
  _tickSpreadingSoil(x, y, z, id, kind) {
    const view = this._view;
    const above = view.get(x, y + 1, z);
    const lightBlocked = above !== 0 && isOpaque(above);

    if (kind !== TICK.MOSS && lightBlocked) {
      if (this._place(x, y, z, DIRT_BLOCK)) this.emit('spread', x, y, z, DIRT_BLOCK);
      return;
    }
    const chance = kind === TICK.MOSS ? MOSS_SPREAD_CHANCE : SPREAD_CHANCE;
    if (this.rng() >= chance) return;
    if (kind !== TICK.MOSS && view.light(x, y + 1, z) < CROP_LIGHT_MIN) return;

    for (let attempt = 0; attempt < SPREAD_ATTEMPTS; attempt++) {
      const tx = x + this._randInt(-1, 1);
      const ty = y + this._randInt(-1, 1);
      const tz = z + this._randInt(-1, 1);
      if (tx === x && ty === y && tz === z) continue;
      if (!this._canSpreadOnto(kind, view.get(tx, ty, tz))) continue;
      const cover = view.get(tx, ty + 1, tz);
      if (cover !== 0 && isOpaque(cover)) continue;
      if (kind !== TICK.MOSS && view.light(tx, ty + 1, tz) < 4) continue;
      if (this._place(tx, ty, tz, id)) {
        this.emit('spread', tx, ty, tz, id);
        return;
      }
    }
  }

  /* ==================================================================== */
  /* Player-facing actions                                                */
  /* ==================================================================== */

  /**
   * Till a dirt-like block into farmland (the hoe's right-click).
   * @param {number} x World X.
   * @param {number} y World Y of the soil.
   * @param {number} z World Z.
   * @returns {boolean} `true` when farmland was created.
   */
  tillAt(x, y, z) {
    if (FARMLAND_BLOCK === 0) return false;
    this._view.invalidate();
    const view = this._view;
    const id = view.get(x, y, z);
    if (!isTillable(id)) return false;
    const above = view.get(x, y + 1, z);
    if (above !== 0 && !isReplaceable(above)) return false;
    if (!this._place(x, y, z, FARMLAND_BLOCK)) return false;

    const rec = new PlantState(PLANT.FARMLAND);
    rec.moisture = this.hasWaterNearby(x, y, z) || this._isRaining()
      ? FARMLAND_MAX_MOISTURE : 0;
    this.setState(x, y, z, rec);
    this._sound('place', FARMLAND_BLOCK, x, y, z);
    this.emit('till', x, y, z);
    return true;
  }

  /**
   * Stomp farmland back into dirt when something heavy lands on it.
   * @param {Object} entity The entity that landed.
   * @returns {boolean} `true` when farmland was destroyed.
   */
  trampleUnder(entity) {
    if (!entity || !entity.position) return false;
    if (entity.noClip === true || entity.flying === true) return false;
    this._view.invalidate();
    const x = Math.floor(entity.position[0]);
    const y = Math.floor(entity.position[1] + 0.0001) - 1;
    const z = Math.floor(entity.position[2]);
    if (this._view.get(x, y, z) !== FARMLAND_BLOCK) return false;
    if (this.rng() >= TRAMPLE_CHANCE) return false;

    const above = this._view.get(x, y + 1, z);
    if (above !== 0 && isPlantLike(above)) this._breakPlant(x, y + 1, z, above);
    if (!this._place(x, y, z, DIRT_BLOCK)) return false;
    this.clearState(x, y, z);
    this._sound('break', FARMLAND_BLOCK, x, y, z);
    this.emit('trample', x, y, z, entity);
    return true;
  }

  /**
   * Plant a seed, a sapling, a stem, cocoa or nether wart.
   *
   * `(x, y, z)` is the cell the plant should occupy — normally the block above
   * the soil the player clicked.
   *
   * @param {number} x World X of the plant cell.
   * @param {number} y World Y of the plant cell.
   * @param {number} z World Z of the plant cell.
   * @param {number} itemId The item in the player's hand.
   * @returns {boolean} `true` when something was planted.
   */
  plantAt(x, y, z, itemId) {
    const id = itemId | 0;
    if (id <= 0) return false;
    this._view.invalidate();
    const view = this._view;
    if (!isFreeCell(view.get(x, y, z))) return false;
    const below = view.get(x, y - 1, z);

    const crop = cropFamilyForSeed(id);
    if (crop !== null) {
      if (below !== FARMLAND_BLOCK) return false;
      if (!this._place(x, y, z, crop.stages[0])) return false;
      this._sound('place', crop.stages[0], x, y, z);
      this.emit('plant', x, y, z, crop.stages[0]);
      return true;
    }

    const stem = stemTypeForSeed(id);
    if (stem !== null) {
      if (below !== FARMLAND_BLOCK) return false;
      const block = stem.blocks[0];
      if (block <= 0 || !this._place(x, y, z, block)) return false;
      const rec = new PlantState(PLANT.STEM);
      rec.species = STEM_TYPES.indexOf(stem);
      this.setState(x, y, z, rec);
      this._sound('place', block, x, y, z);
      this.emit('plant', x, y, z, block);
      return true;
    }

    const sapling = saplingSpeciesForItem(id);
    if (sapling !== null) {
      if (!this._isSaplingSoil(below)) return false;
      if (sapling.block <= 0 || !this._place(x, y, z, sapling.block)) return false;
      const rec = new PlantState(PLANT.SAPLING);
      rec.species = SAPLING_SPECIES.indexOf(sapling);
      this.setState(x, y, z, rec);
      this._sound('place', sapling.block, x, y, z);
      this.emit('plant', x, y, z, sapling.block);
      return true;
    }

    const wartItem = resolveItem('nether_wart');
    if (wartItem > 0 && id === wartItem) {
      if (below !== B.SOUL_SAND && below !== B.SOUL_SOIL) return false;
      const block = this._wartBlock(0);
      if (block <= 0 || !this._place(x, y, z, block)) return false;
      this.setState(x, y, z, new PlantState(PLANT.NETHER_WART));
      this._sound('place', block, x, y, z);
      this.emit('plant', x, y, z, block);
      return true;
    }

    const cocoaItem = resolveItem('cocoa_beans');
    if (cocoaItem > 0 && id === cocoaItem) {
      if (!this._cocoaHost(x, y, z)) return false;
      const block = this._cocoaBlock(0);
      if (block <= 0 || !this._place(x, y, z, block)) return false;
      this.setState(x, y, z, new PlantState(PLANT.COCOA));
      this._sound('place', block, x, y, z);
      this.emit('plant', x, y, z, block);
      return true;
    }
    return false;
  }

  /**
   * Harvest a mature crop: drop its loot and optionally sow it again.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {boolean} [replant=true] Put stage 0 back when a seed is known.
   * @returns {?Array<{item:string, count:number}>} The drops, or `null` when
   *   nothing was harvested.
   */
  harvestAt(x, y, z, replant = true) {
    this._view.invalidate();
    const id = this._view.get(x, y, z);
    if (!isMatureCrop(id)) return null;
    const family = cropFamilyOf(id);
    let drops = null;
    try {
      drops = blockDrops(id, null, 0, 0, this.rng);
    } catch (err) {
      warnOnce('harvestDrops', 'blockDrops failed while harvesting', err);
      drops = [];
    }
    const replacement = replant && family !== null ? family.stages[0] : 0;
    if (!this._place(x, y, z, replacement)) return null;
    if (replacement === 0) this.clearState(x, y, z);

    const em = this.entities;
    if (em !== null && typeof em.dropBlockLoot === 'function' && drops !== null) {
      try {
        em.dropBlockLoot(x, y, z, drops);
      } catch (err) {
        warnOnce('harvestLoot', 'dropping harvest loot failed', err);
      }
    }
    this._sound('break', id, x, y, z);
    this.emit('harvest', x, y, z, id);
    return drops;
  }

  /* -------------------------------------------------------- bone meal ---- */

  /**
   * Apply bone meal, with the stage jump that is right for whatever is there.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when the bone meal was consumed.
   */
  applyBoneMeal(x, y, z) {
    this._view.invalidate();
    const id = this._view.get(x, y, z);
    if (id === 0) return false;
    const rec = this.getState(x, y, z);

    if (rec !== null && rec.kind === PLANT.STEM) return this._boneMealStem(x, y, z, id, rec);
    if (rec !== null && rec.kind === PLANT.SAPLING) return this._boneMealSapling(x, y, z, rec);
    if (rec !== null && rec.kind === PLANT.COCOA) return this._boneMealCocoa(x, y, z, id, rec);

    if (isCropBlock(id)) return this._boneMealCrop(x, y, z, id);
    if (SAPLING_BLOCK[id] === 1) {
      const fresh = new PlantState(PLANT.SAPLING);
      fresh.species = this._speciesForBlock(id);
      this.setState(x, y, z, fresh);
      return this._boneMealSapling(x, y, z, fresh);
    }
    if (id === B.GRASS_BLOCK) return this._boneMealGrass(x, y, z);
    if (id === B.MOSS_BLOCK) return this._boneMealMoss(x, y, z);
    if (id === B.BAMBOO) return this._boneMealBamboo(x, y, z, id);
    return false;
  }

  /**
   * Which sapling species a block id belongs to.
   * @param {number} id Block id.
   * @returns {number} Index into {@link SAPLING_SPECIES}.
   * @private
   */
  _speciesForBlock(id) {
    const name = blockDef(id).name;
    for (let i = 0; i < SAPLING_SPECIES.length; i++) {
      const species = SAPLING_SPECIES[i];
      if (name === `${species.key}_sapling` || name === species.key) return i;
    }
    for (let i = 0; i < SAPLING_SPECIES.length; i++) {
      if (SAPLING_SPECIES[i].block === id) return i;
    }
    return 0;
  }

  /**
   * Bone meal on a crop: jump the family's own number of stages.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Crop block id.
   * @returns {boolean} `true` when the crop grew.
   * @private
   */
  _boneMealCrop(x, y, z, id) {
    const family = cropFamilyOf(id);
    if (family === null) return false;
    const stage = cropStageOf(id);
    if (stage >= CROP_MAX_STAGE) return false;
    const jump = this._randInt(family.boneMealMin, family.boneMealMax);
    const target = family.stages[Math.min(CROP_MAX_STAGE, stage + jump)];
    if (!this._place(x, y, z, target)) return false;
    this._growParticles(x, y, z, 12);
    this._growthCount++;
    this.emit('boneMeal', x, y, z, target);
    this.emit('grow', x, y, z, target);
    return true;
  }

  /**
   * Bone meal on a stem: one to three ages, then a fruit attempt.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Current stem block id.
   * @param {PlantState} rec The stem record.
   * @returns {boolean} `true` when something happened.
   * @private
   */
  _boneMealStem(x, y, z, id, rec) {
    const type = STEM_TYPES[rec.species] || STEM_TYPES[0];
    if (rec.age >= STEM_MAX_AGE) {
      if (!this._growFruit(x, y, z, type)) return false;
      this._growParticles(x, y, z, 12);
      this.emit('boneMeal', x, y, z, type.fruit);
      return true;
    }
    rec.age = Math.min(STEM_MAX_AGE, rec.age + this._randInt(1, 3));
    const want = type.blocks[rec.age];
    if (want > 0 && want !== id) this._place(x, y, z, want);
    this._growParticles(x, y, z, 12);
    this._growthCount++;
    this.emit('boneMeal', x, y, z, want > 0 ? want : id);
    this.emit('grow', x, y, z, want > 0 ? want : id);
    return true;
  }

  /**
   * Bone meal on a sapling: a 45 % chance to become a tree at once.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {PlantState} rec The sapling record.
   * @returns {boolean} `true` when the bone meal was consumed.
   * @private
   */
  _boneMealSapling(x, y, z, rec) {
    this._growParticles(x, y, z, 14);
    if (this.rng() < 0.45 || rec.age >= 1) {
      if (this.growTree(x, y, z, rec.species)) {
        this.emit('boneMeal', x, y, z, 0);
        return true;
      }
    }
    rec.age = 1;
    this.emit('boneMeal', x, y, z, 0);
    return true;
  }

  /**
   * Bone meal on a cocoa pod.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Current block id.
   * @param {PlantState} rec The cocoa record.
   * @returns {boolean} `true` when the pod grew.
   * @private
   */
  _boneMealCocoa(x, y, z, id, rec) {
    if (rec.age >= 2) return false;
    rec.age++;
    const want = this._cocoaBlock(rec.age);
    if (want > 0 && want !== id) this._place(x, y, z, want);
    this._growParticles(x, y, z, 10);
    this.emit('boneMeal', x, y, z, want > 0 ? want : id);
    return true;
  }

  /**
   * Bone meal on bamboo: one or two extra culms.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Bamboo block id.
   * @returns {boolean} `true` when bamboo grew.
   * @private
   */
  _boneMealBamboo(x, y, z, id) {
    const view = this._view;
    let top = y;
    while (view.get(x, top + 1, z) === id) top++;
    let height = 1;
    while (view.get(x, top - height, z) === id) height++;
    const want = this._randInt(1, 2);
    let grown = 0;
    for (let i = 0; i < want; i++) {
      if (height + grown >= BAMBOO_MAX_HEIGHT) break;
      if (view.get(x, top + 1 + grown, z) !== 0) break;
      if (!this._place(x, top + 1 + grown, z, id)) break;
      grown++;
    }
    if (grown === 0) return false;
    this._growParticles(x, top, z, 10);
    this.emit('boneMeal', x, y, z, id);
    return true;
  }

  /**
   * Bone meal on a grass block: scatter short grass and flowers around it.
   * @param {number} x World X.
   * @param {number} y World Y of the grass block.
   * @param {number} z World Z.
   * @returns {boolean} `true` when at least one plant appeared.
   */
  _boneMealGrass(x, y, z) {
    const view = this._view;
    const grassPlant = resolveBlock('short_grass');
    let placed = 0;

    for (let attempt = 0; attempt < 48 && placed < 14; attempt++) {
      // The clicked block itself is always the first candidate, so bone meal on
      // a lone patch of grass never does nothing.
      const tx = attempt === 0 ? x : x + this._randInt(-3, 3);
      const tz = attempt === 0 ? z : z + this._randInt(-3, 3);
      const ty = attempt === 0 ? y : y + this._randInt(-1, 1);
      if (view.get(tx, ty, tz) !== B.GRASS_BLOCK) continue;
      if (!isFreeCell(view.get(tx, ty + 1, tz))) continue;
      let plant = grassPlant;
      if (this.rng() < 0.15 && BONE_MEAL_FLOWERS.length > 0) {
        plant = BONE_MEAL_FLOWERS[this._randInt(0, BONE_MEAL_FLOWERS.length - 1)];
      }
      if (plant <= 0) continue;
      if (this._place(tx, ty + 1, tz, plant)) placed++;
    }
    if (placed === 0) return false;
    this._growParticles(x, y + 1, z, 12);
    this.emit('boneMeal', x, y, z, B.GRASS_BLOCK);
    return true;
  }

  /**
   * Bone meal on moss: convert a small blob of nearby stone and dirt.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when the blob grew.
   * @private
   */
  _boneMealMoss(x, y, z) {
    const view = this._view;
    const moss = B.MOSS_BLOCK;
    let placed = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          if (this.rng() > 0.4) continue;
          const target = view.get(x + dx, y + dy, z + dz);
          if (!this._canSpreadOnto(TICK.MOSS, target)) continue;
          if (this._place(x + dx, y + dy, z + dz, moss)) placed++;
        }
      }
    }
    if (placed === 0) return false;
    this._growParticles(x, y + 1, z, 10);
    this.emit('boneMeal', x, y, z, moss);
    return true;
  }

  /* -------------------------------------------------------- composter ---- */

  /**
   * Fill level of a composter, 0..8. Level 8 means it is ready to harvest.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} The level, `0` when the block is not a composter.
   */
  composterLevel(x, y, z) {
    if (COMPOSTER_BLOCK === 0) return 0;
    if (this._view.get(x, y, z) !== COMPOSTER_BLOCK) return 0;
    const rec = this.getState(x, y, z);
    return rec === null || rec.kind !== PLANT.COMPOSTER ? 0 : rec.age;
  }

  /**
   * Throw plant matter into a composter.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} itemId The item offered.
   * @returns {{accepted:boolean, filled:boolean, level:number, full:boolean,
   *   message:string}} Outcome, with a German message for the HUD.
   */
  composterAdd(x, y, z, itemId) {
    this._view.invalidate();
    const result = {
      accepted: false, filled: false, level: 0, full: false, message: '',
    };
    if (COMPOSTER_BLOCK === 0 || this._view.get(x, y, z) !== COMPOSTER_BLOCK) {
      result.message = 'Hier steht kein Komposter.';
      return result;
    }
    let rec = this.getState(x, y, z);
    if (rec === null || rec.kind !== PLANT.COMPOSTER) {
      rec = new PlantState(PLANT.COMPOSTER);
      this.setState(x, y, z, rec);
    }
    result.level = rec.age;
    if (rec.age >= COMPOSTER_MAX_LEVEL) {
      result.full = true;
      result.message = 'Der Komposter ist voll — Knochenmehl entnehmen.';
      return result;
    }
    const chance = compostChance(itemId);
    if (chance <= 0) {
      result.message = 'Das lässt sich nicht kompostieren.';
      return result;
    }

    result.accepted = true;
    if (this.rng() < chance) {
      rec.age = Math.min(COMPOSTER_MAX_LEVEL, rec.age + 1);
      result.filled = true;
      this._growParticles(x, y + 1, z, 6);
    }
    result.level = rec.age;
    result.full = rec.age >= COMPOSTER_MAX_LEVEL;
    result.message = result.full
      ? 'Der Komposter ist voll — Knochenmehl entnehmen.'
      : `Kompostiert: ${itemDisplay(itemId)} (${rec.age}/${COMPOSTER_MAX_LEVEL})`;
    this._sound('place', COMPOSTER_BLOCK, x, y, z);
    this.emit('compost', x, y, z, rec.age, result.filled);
    if (result.full) this.emit('composterFull', x, y, z);
    return result;
  }

  /**
   * Take the bone meal out of a full composter.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {?ItemStack} One bone meal, or `null` when the composter is not ready.
   */
  composterCollect(x, y, z) {
    if (this.composterLevel(x, y, z) < COMPOSTER_MAX_LEVEL) return null;
    const rec = this.getState(x, y, z);
    if (rec === null) return null;
    rec.age = 0;
    const boneMeal = resolveItem('bone_meal');
    if (boneMeal <= 0) return null;
    this._sound('break', COMPOSTER_BLOCK, x, y, z);
    this.emit('compost', x, y, z, 0, false);
    return new ItemStack(boneMeal, 1, null);
  }

  /* ==================================================================== */
  /* Animal breeding                                                      */
  /* ==================================================================== */

  /**
   * The food item names that put this animal into love mode.
   * @param {Object} mob The animal.
   * @returns {readonly string[]} Item names, possibly empty.
   */
  breedFoods(mob) {
    if (!mob || !mob.def || !Array.isArray(mob.def.breedFood)) return EMPTY_STRINGS;
    return mob.def.breedFood;
  }

  /**
   * Whether an animal could enter love mode right now.
   * @param {Object} mob The animal.
   * @returns {boolean} `true` when feeding it would work.
   */
  canBreed(mob) {
    if (!mob || !mob.def || mob.def.breedable !== true) return false;
    if (mob.isBaby === true || mob.dead === true || mob.removed === true) return false;
    return num(mob.breedCooldown, 0) <= 0 && num(mob.loveTimer, 0) <= 0;
  }

  /**
   * Put an animal into love mode without a player (used by villagers feeding
   * their livestock, and by debug tooling).
   * @param {Object} mob The animal.
   * @param {number} [seconds] Duration of love mode.
   * @returns {boolean} `true` when love mode started.
   */
  startLove(mob, seconds = LOVE_SECONDS) {
    if (!this.canBreed(mob)) return false;
    mob.loveTimer = Math.max(1, num(seconds, LOVE_SECONDS));
    this.emit('love', mob);
    return true;
  }

  /**
   * Feed the animal the player is holding food for.
   *
   * The heavy lifting — love mode, pathing together, the baby, the shared
   * cooldown and the growth timer — already lives in `game/mobs.js`
   * (`Mob#feed`, `BreedBehavior`, `Mob#produceBaby`); this method is the bridge
   * that validates the interaction, hands it over and consumes the item.
   *
   * @param {Object} mob The animal being fed.
   * @param {Object} player The feeding player.
   * @param {Object} [ctx] Tick context handed to `Mob#feed`.
   * @returns {boolean} `true` when the food was accepted.
   */
  feedAnimal(mob, player, ctx) {
    if (!mob || typeof mob.feed !== 'function' || !player) return false;
    if (mob.dead === true || mob.removed === true) return false;
    const before = num(mob.loveTimer, 0);
    let accepted = false;
    try {
      accepted = mob.feed(player, ctx || this._mobContext()) === true;
    } catch (err) {
      warnOnce('feed', 'Mob#feed threw; feeding disabled for this interaction', err);
      return false;
    }
    if (!accepted) return false;

    if (player.gameMode !== 'creative') {
      const inv = player.inventory;
      if (inv && typeof inv.consumeSelected === 'function') {
        try {
          inv.consumeSelected(1);
        } catch (err) {
          warnOnce('consume', 'consuming the feeding item failed', err);
        }
      }
    }
    if (before <= 0 && num(mob.loveTimer, 0) > 0) this.emit('love', mob);
    return true;
  }

  /**
   * Right-click on an animal: feed it when the held item is on its menu.
   * @param {Object} player The player.
   * @param {Object} mob The animal.
   * @returns {boolean} `true` when the interaction was handled.
   */
  interactWithAnimal(player, mob) {
    if (!player || !mob || typeof mob.likesHeldItem !== 'function') return false;
    if (!mob.likesHeldItem(player)) return false;
    return this.feedAnimal(mob, player);
  }

  /**
   * A minimal tick context for calls that arrive from the UI thread rather
   * than from `tick()`.
   * @returns {Object} A context object shaped like the game's.
   * @private
   */
  _mobContext() {
    const ctx = this._ctxCache;
    ctx.world = this.world;
    ctx.player = this.player;
    ctx.entities = this.entities;
    ctx.environment = this.environment;
    ctx.audio = this.audio;
    ctx.particles = this.particles;
    return ctx;
  }

  /**
   * Trampling and breeding bookkeeping for every entity near the player.
   * @param {number} step Seconds since the last tick.
   * @returns {void}
   * @private
   */
  _entityPass(step) {
    void step;
    const em = this.entities;
    const player = this.player;
    if (em === null || typeof em.queryRadius !== 'function') return;
    if (!player || !player.position || !Number.isFinite(player.position[0])) return;

    let list;
    try {
      list = em.queryRadius(player.position[0], player.position[1], player.position[2],
        ENTITY_PASS_RADIUS, _entityScratch);
    } catch (err) {
      warnOnce('queryRadius', 'entity query failed; trampling disabled', err);
      return;
    }
    if (!list) return;

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.removed === true || !e.position) continue;
      if (NON_TRAMPLING.has(e.type)) continue;

      const prevFall = num(e._farmFall, 0);
      if (e.onGround === true) {
        if (prevFall > TRAMPLE_MIN_FALL) this.trampleUnder(e);
        e._farmFall = 0;
      } else {
        e._farmFall = num(e.fallDistance, prevFall);
      }

      if (e.def === undefined) continue;
      if (e.isBaby === true) {
        if (e._farmBaby !== 1) {
          e._farmBaby = 1;
          if (num(e.age, 99) < 2) this.emit('baby', e);
        }
      } else if (e._farmBaby === 1) {
        e._farmBaby = 0;
        this.emit('grownUp', e);
      }
    }
  }

  /* ==================================================================== */
  /* Persistence                                                          */
  /* ==================================================================== */

  /**
   * Snapshot of every plant record, grouped by chunk.
   * @returns {{version:number, seed:number, chunks:Array<Object>}} The snapshot.
   */
  serialize() {
    const chunks = [];
    for (const [key, bucket] of this._states) {
      if (bucket.size === 0) continue;
      const keys = [];
      const kinds = [];
      const ages = [];
      const moist = [];
      const species = [];
      for (const [local, state] of bucket) {
        // Fully hydrated farmland is the overwhelmingly common record and it
        // costs nothing to recompute: `moistureAt()` re-derives it from the
        // water next to the block the first time it is read again. Skipping it
        // keeps a thousand-block field out of the save file entirely.
        if (state.kind === PLANT.FARMLAND && state.moisture >= FARMLAND_MAX_MOISTURE) continue;
        keys.push(local);
        kinds.push(state.kind);
        ages.push(state.age);
        moist.push(state.moisture);
        species.push(state.species);
      }
      if (keys.length === 0) continue;
      chunks.push({ c: key, k: keys, t: kinds, a: ages, m: moist, s: species });
    }
    return { version: FARM_SAVE_VERSION, seed: this.seed, chunks };
  }

  /**
   * Restore a snapshot written by {@link FarmingSystem#serialize}.
   * @param {Object} snapshot The snapshot.
   * @returns {boolean} `true` when the snapshot was applied.
   */
  deserialize(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (num(snapshot.version, 0) > FARM_SAVE_VERSION) {
      warnOnce('saveVersion', `farming snapshot version ${snapshot.version} is newer than ${FARM_SAVE_VERSION}; ignored`);
      return false;
    }
    this._states.clear();
    if (Number.isFinite(snapshot.seed)) {
      this.seed = snapshot.seed >>> 0;
      this.rng = mulberry32(this.seed);
    }
    const chunks = Array.isArray(snapshot.chunks) ? snapshot.chunks : [];
    for (let c = 0; c < chunks.length; c++) {
      const entry = chunks[c];
      if (!entry || !Array.isArray(entry.k)) continue;
      const bucket = new Map();
      for (let i = 0; i < entry.k.length; i++) {
        const state = new PlantState(num(entry.t ? entry.t[i] : PLANT.NONE, PLANT.NONE));
        if (state.kind === PLANT.NONE) continue;
        state.age = clamp(num(entry.a ? entry.a[i] : 0, 0) | 0, 0, 64);
        state.moisture = clamp(num(entry.m ? entry.m[i] : 0, 0) | 0, 0, FARMLAND_MAX_MOISTURE);
        state.species = clamp(num(entry.s ? entry.s[i] : 0, 0) | 0, 0, 63);
        bucket.set(num(entry.k[i], 0) | 0, state);
      }
      if (bucket.size > 0) this._states.set(num(entry.c, 0), bucket);
    }
    this._chunkList.length = 0;
    this._listAge = 0;
    return true;
  }

  /**
   * Counters for the F3 overlay.
   * @returns {{records:number, chunks:number, samples:number, growths:number,
   *   simulated:number}} Statistics.
   */
  getStats() {
    let records = 0;
    for (const bucket of this._states.values()) records += bucket.size;
    return {
      records,
      chunks: this._states.size,
      samples: this._sampleCount,
      growths: this._growthCount,
      simulated: this._chunkList.length,
    };
  }

  /**
   * Release every listener and drop all state.
   * @returns {void}
   */
  dispose() {
    this.detach();
    this._states.clear();
    this._chunkList.length = 0;
    this._cursor = 0;
    this.removeAllListeners();
  }
}

export default FarmingSystem;
