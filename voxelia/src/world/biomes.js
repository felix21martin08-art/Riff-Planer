/**
 * VOXELIA — `world/biomes.js` (spec 5.8)
 *
 * Biome table, multi-noise climate mapping and per-biome tint colours.
 *
 * ## Two different temperature scales (read this)
 *
 * - `BiomeDef.temperature` / `BiomeDef.humidity` are the **Minecraft-style**
 *   scalars: temperature roughly `-0.7 .. 2.0` (below `0.15` water freezes and
 *   precipitation falls as snow), humidity/downfall `0 .. 1`. They drive
 *   `biomeTemperatureAt()`, snow/rain decisions and foliage dryness.
 * - `BiomeDef.climate` is the **noise parameter box** used by `selectBiome()`.
 *   All six axes live in `[-1, 1]`:
 *   `[cMin,cMax, eMin,eMax, tMin,tMax, hMin,hMax, wMin,wMax, dMin,dMax]`
 *   (continentalness, erosion, temperature, humidity, weirdness, depth).
 *
 * ## Colours
 *
 * `grassColor`, `foliageColor`, `waterColor`, `fogColor` and `skyTint` are
 * `Float32Array(3)` in **linear** RGB `0..1` (authored as sRGB hex and
 * converted once at module load). They are shared, frozen-by-convention
 * buffers — never mutate what the getters hand back.
 *
 * ## Block names, not ids
 *
 * `surfaceBlock` / `subSurfaceBlock` / `underwaterBlock` are block **names**
 * (strings). This file deliberately does not import `world/blocks.js` so the
 * two modules can never form an import cycle. Call `resolveBiomeBlocks()` once
 * at startup (ideally passing `BLOCK_BY_NAME`) and then read the numeric ids
 * through `biome.surfaceBlockId` / `biomeSurfaceBlock(id)`.
 *
 * No `window`/`document` access — safe inside a module Web Worker.
 *
 * @module world/biomes
 */

/* -------------------------------------------------------------------------- */
/* Colour helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * sRGB electro-optical transfer function (gamma decode).
 * @param {number} c channel in `[0, 1]` (sRGB encoded)
 * @returns {number} linear channel in `[0, 1]`
 */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Convert a `0xRRGGBB` sRGB literal into a linear `Float32Array(3)`.
 * @param {number} hex packed sRGB colour
 * @returns {Float32Array} linear rgb, length 3
 */
function linearRGB(hex) {
  const out = new Float32Array(3);
  out[0] = srgbToLinear(((hex >> 16) & 255) / 255);
  out[1] = srgbToLinear(((hex >> 8) & 255) / 255);
  out[2] = srgbToLinear((hex & 255) / 255);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Shared spawn groups                                                         */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} MobSpawn
 * @property {string} name entity type name (matches `game/mobs.js`)
 * @property {number} weight relative spawn weight inside its group
 * @property {number} min minimum pack size
 * @property {number} max maximum pack size
 * @property {'creature'|'monster'|'ambient'|'water_creature'|'water_ambient'} group
 *   spawn category — each category has its own cap in the spawner
 */

/** @type {MobSpawn[]} baseline hostile set present in almost every overworld biome */
const HOSTILE_BASE = Object.freeze([
  Object.freeze({ name: 'zombie', weight: 95, min: 2, max: 4, group: 'monster' }),
  Object.freeze({ name: 'skeleton', weight: 80, min: 2, max: 4, group: 'monster' }),
  Object.freeze({ name: 'creeper', weight: 90, min: 2, max: 4, group: 'monster' }),
  Object.freeze({ name: 'spider', weight: 80, min: 2, max: 4, group: 'monster' }),
  Object.freeze({ name: 'enderman', weight: 10, min: 1, max: 2, group: 'monster' }),
  Object.freeze({ name: 'witch', weight: 5, min: 1, max: 1, group: 'monster' }),
  Object.freeze({ name: 'slime', weight: 6, min: 2, max: 4, group: 'monster' }),
]);

/** @type {MobSpawn[]} temperate farm animals */
const FARM_ANIMALS = Object.freeze([
  Object.freeze({ name: 'sheep', weight: 12, min: 2, max: 4, group: 'creature' }),
  Object.freeze({ name: 'cow', weight: 8, min: 2, max: 4, group: 'creature' }),
  Object.freeze({ name: 'pig', weight: 10, min: 2, max: 4, group: 'creature' }),
  Object.freeze({ name: 'chicken', weight: 10, min: 2, max: 4, group: 'creature' }),
]);

/** @type {MobSpawn[]} cave ambience */
const AMBIENT_BAT = Object.freeze([
  Object.freeze({ name: 'bat', weight: 10, min: 4, max: 8, group: 'ambient' }),
]);

/** @type {MobSpawn[]} generic temperate overworld surface set */
const SPAWNS_TEMPERATE = Object.freeze([
  ...FARM_ANIMALS,
  Object.freeze({ name: 'horse', weight: 5, min: 2, max: 6, group: 'creature' }),
  ...AMBIENT_BAT,
  ...HOSTILE_BASE,
]);

/** @type {MobSpawn[]} shared ocean set */
const SPAWNS_OCEAN = Object.freeze([
  Object.freeze({ name: 'squid', weight: 10, min: 1, max: 4, group: 'water_creature' }),
  Object.freeze({ name: 'cod', weight: 10, min: 3, max: 6, group: 'water_ambient' }),
  Object.freeze({ name: 'drowned', weight: 12, min: 1, max: 2, group: 'monster' }),
  Object.freeze({ name: 'guardian', weight: 2, min: 1, max: 1, group: 'monster' }),
]);

/**
 * Concatenate spawn groups into one frozen list.
 * @param {...MobSpawn[]} groups spawn arrays to merge
 * @returns {MobSpawn[]} frozen merged list
 */
function spawns(...groups) {
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    for (let j = 0; j < g.length; j++) out.push(g[j]);
  }
  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* Vocabularies                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Music mood tags consumed by `game/audio.js` when picking an adaptive track.
 * @type {readonly string[]}
 */
export const MUSIC_MOODS = Object.freeze([
  'pastoral', 'wooded', 'floral', 'boreal', 'frozen', 'alpine', 'arid',
  'jungle', 'swamp', 'aquatic', 'abyssal', 'mysterious', 'ominous', 'serene',
]);

/**
 * Tree archetypes; every value is a valid `type` for
 * `world/structures.js#placeTree`.
 * @type {readonly string[]}
 */
export const TREE_TYPES = Object.freeze([
  'oak', 'big_oak', 'spruce', 'tall_spruce', 'birch', 'jungle', 'big_jungle',
  'acacia', 'dark_oak', 'cherry', 'mangrove', 'azalea',
]);

/* -------------------------------------------------------------------------- */
/* Biome table                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} BiomeDef
 * @property {number} id dense index into {@link BIOMES}
 * @property {string} name snake_case identifier
 * @property {string} display human readable label
 * @property {'land'|'ocean'|'river'|'beach'|'cave'} category coarse family
 * @property {number} temperature Minecraft-style temperature (`< 0.15` freezes)
 * @property {number} humidity Minecraft-style downfall `0..1`
 * @property {number} baseHeight target surface Y (absolute world Y)
 * @property {number} heightVariation surface amplitude in blocks
 * @property {Float32Array} climate 12 numbers, see module docs
 * @property {string} surfaceBlock block *name* placed on the surface
 * @property {string} subSurfaceBlock block *name* placed just below it
 * @property {string} underwaterBlock block *name* used when submerged
 * @property {number} surfaceBlockId resolved block id (lazy getter)
 * @property {number} subSurfaceBlockId resolved block id (lazy getter)
 * @property {number} underwaterBlockId resolved block id (lazy getter)
 * @property {Float32Array} grassColor linear rgb
 * @property {Float32Array} foliageColor linear rgb
 * @property {Float32Array} waterColor linear rgb
 * @property {Float32Array} fogColor linear rgb
 * @property {Float32Array} skyTint linear rgb
 * @property {number} grassColorHex authored sRGB colour
 * @property {number} foliageColorHex authored sRGB colour
 * @property {number} waterColorHex authored sRGB colour
 * @property {number} fogColorHex authored sRGB colour
 * @property {number} skyTintHex authored sRGB colour
 * @property {number} treeDensity expected tree attempts per 16x16 column
 * @property {readonly string[]} treeTypes weighted by repetition; pick uniformly
 * @property {number} grassDensity expected grass/plant attempts per 16x16 column
 * @property {readonly string[]} grassTypes block names, weighted by repetition
 * @property {number} flowerDensity expected flower attempts per 16x16 column
 * @property {readonly string[]} flowerTypes block names, weighted by repetition
 * @property {readonly string[]} features advisory feature tags for worldgen
 * @property {readonly MobSpawn[]} mobs spawn table
 * @property {string} musicMood one of {@link MUSIC_MOODS}
 * @property {'none'|'rain'|'snow'} precipitation base weather at sea level
 */

/**
 * Dense biome table; array index === biome id. Ids are stable and are written
 * into `Chunk.biomes` (a `Uint8Array`), so never reorder this list.
 * @type {BiomeDef[]}
 */
export const BIOMES = [];

/**
 * Biome name -> id.
 * @type {Map<string, number>}
 */
export const BIOME_INDEX = new Map();

/**
 * SCREAMING_SNAKE_CASE id constants (`BIOME_ID.SNOWY_TAIGA`).
 * @type {Object<string, number>}
 */
export const BIOME_ID = Object.create(null);

/** Names of the three block-name fields, in slot order. */
const BLOCK_NAME_KEYS = ['surfaceBlock', 'subSurfaceBlock', 'underwaterBlock'];

/** @type {((name: string) => number) | null} active name -> id resolver */
let blockLookup = null;

/** Bumped whenever the resolver changes so cached ids are invalidated. */
let resolveEpoch = 0;

/** @type {Set<string>} names we already complained about */
const warnedNames = new Set();

/** Whether the "no resolver installed" warning was already printed. */
let warnedNoResolver = false;

/**
 * Emit a console warning at most once per distinct message.
 * @param {string} msg message text
 * @returns {void}
 */
function warnOnce(msg) {
  if (warnedNames.has(msg)) return;
  warnedNames.add(msg);
  if (typeof console !== 'undefined' && console.warn) console.warn(msg);
}

/**
 * Resolve one block name through the installed lookup.
 * @param {string} name block name
 * @returns {number} block id, or 0 (air) when unknown
 */
function lookupBlockId(name) {
  if (blockLookup === null) return 0;
  const id = blockLookup(name);
  if (typeof id === 'number' && id >= 0) return id | 0;
  warnOnce(`[biomes] unknown block name "${name}", falling back to air`);
  return 0;
}

/**
 * Lazily resolve and cache the three block ids of a biome.
 * @param {BiomeDef} biome biome definition
 * @param {number} slot 0 = surface, 1 = sub-surface, 2 = underwater
 * @returns {number} block id
 */
function biomeBlockId(biome, slot) {
  if (blockLookup === null) {
    if (!warnedNoResolver) {
      warnedNoResolver = true;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[biomes] block ids requested before resolveBiomeBlocks(); returning air');
      }
    }
    return 0;
  }
  if (biome._idEpoch !== resolveEpoch) {
    const ids = biome._ids;
    for (let i = 0; i < 3; i++) ids[i] = lookupBlockId(biome[BLOCK_NAME_KEYS[i]]);
    biome._idEpoch = resolveEpoch;
  }
  return biome._ids[slot];
}

/**
 * Register a biome definition, filling defaults and installing the lazy block
 * id getters. Called once per entry while this module loads.
 * @param {Object} o raw biome literal
 * @returns {BiomeDef} the frozen-ish, registered definition
 */
function defineBiome(o) {
  const id = BIOMES.length;
  /** @type {any} */
  const b = {
    id,
    name: o.name,
    display: o.display,
    category: o.category || 'land',
    temperature: o.temperature,
    humidity: o.humidity,
    baseHeight: o.baseHeight,
    heightVariation: o.heightVariation,
    climate: new Float32Array(o.climate),
    surfaceBlock: o.surfaceBlock,
    subSurfaceBlock: o.subSurfaceBlock,
    underwaterBlock: o.underwaterBlock,
    grassColor: linearRGB(o.grass),
    foliageColor: linearRGB(o.foliage),
    waterColor: linearRGB(o.water),
    fogColor: linearRGB(o.fog),
    skyTint: linearRGB(o.sky),
    grassColorHex: o.grass,
    foliageColorHex: o.foliage,
    waterColorHex: o.water,
    fogColorHex: o.fog,
    skyTintHex: o.sky,
    treeDensity: o.treeDensity || 0,
    treeTypes: Object.freeze(o.treeTypes || []),
    grassDensity: o.grassDensity || 0,
    grassTypes: Object.freeze(o.grassTypes || []),
    flowerDensity: o.flowerDensity || 0,
    flowerTypes: Object.freeze(o.flowerTypes || []),
    features: Object.freeze(o.features || []),
    mobs: o.mobs || [],
    musicMood: o.musicMood,
    precipitation: o.precipitation,
  };

  // Internal id cache — hidden so a biome def stays clean when logged/cloned.
  Object.defineProperty(b, '_ids', {
    value: new Int32Array(3), enumerable: false, writable: false, configurable: false,
  });
  Object.defineProperty(b, '_idEpoch', {
    value: -1, enumerable: false, writable: true, configurable: false,
  });

  Object.defineProperty(b, 'surfaceBlockId', {
    get() { return biomeBlockId(this, 0); },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(b, 'subSurfaceBlockId', {
    get() { return biomeBlockId(this, 1); },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(b, 'underwaterBlockId', {
    get() { return biomeBlockId(this, 2); },
    enumerable: false,
    configurable: true,
  });
  // Short aliases so callers can use either spelling.
  Object.defineProperty(b, 'surfaceId', {
    get() { return biomeBlockId(this, 0); }, enumerable: false, configurable: true,
  });
  Object.defineProperty(b, 'subSurfaceId', {
    get() { return biomeBlockId(this, 1); }, enumerable: false, configurable: true,
  });
  Object.defineProperty(b, 'underwaterId', {
    get() { return biomeBlockId(this, 2); }, enumerable: false, configurable: true,
  });

  BIOMES.push(b);
  BIOME_INDEX.set(b.name, id);
  BIOME_ID[b.name.toUpperCase()] = id;
  return b;
}

/* ------------------------------- 0 plains -------------------------------- */
defineBiome({
  name: 'plains', display: 'Plains', category: 'land',
  temperature: 0.8, humidity: 0.4, baseHeight: 67, heightVariation: 4,
  climate: [-0.11, 1, 0.15, 1, -0.15, 0.55, -0.4, 0.12, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0x91BD59, foliage: 0x77AB2F, water: 0x3F76E4, fog: 0xC0D8FF, sky: 0x78A7FF,
  treeDensity: 0.4, treeTypes: ['oak'],
  grassDensity: 13, grassTypes: ['short_grass', 'short_grass', 'short_grass', 'tall_grass'],
  flowerDensity: 1.6, flowerTypes: ['dandelion', 'poppy', 'cornflower', 'oxeye_daisy', 'allium'],
  features: ['lakes', 'ravines', 'ore_veins', 'village', 'dungeons', 'pumpkins'],
  mobs: SPAWNS_TEMPERATE, musicMood: 'pastoral', precipitation: 'rain',
});

/* -------------------------- 1 sunflower_plains --------------------------- */
defineBiome({
  name: 'sunflower_plains', display: 'Sunflower Plains', category: 'land',
  temperature: 0.8, humidity: 0.4, baseHeight: 67, heightVariation: 4,
  climate: [-0.11, 1, 0.3, 1, 0.0, 0.55, -0.25, 0.12, 0.5, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0x91BD59, foliage: 0x77AB2F, water: 0x3F76E4, fog: 0xC9DCF7, sky: 0x7CAAFF,
  treeDensity: 0.3, treeTypes: ['oak'],
  grassDensity: 12, grassTypes: ['short_grass', 'short_grass', 'tall_grass'],
  flowerDensity: 9, flowerTypes: ['sunflower', 'sunflower', 'dandelion', 'poppy', 'oxeye_daisy'],
  features: ['lakes', 'ravines', 'ore_veins', 'village', 'dungeons'],
  mobs: SPAWNS_TEMPERATE, musicMood: 'floral', precipitation: 'rain',
});

/* -------------------------------- 2 forest ------------------------------- */
defineBiome({
  name: 'forest', display: 'Forest', category: 'land',
  temperature: 0.7, humidity: 0.8, baseHeight: 69, heightVariation: 7,
  climate: [-0.11, 1, -0.2, 0.85, -0.2, 0.25, 0.08, 0.45, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0x79C05A, foliage: 0x59AE30, water: 0x3F76E4, fog: 0xC0D8FF, sky: 0x78A7FF,
  treeDensity: 10, treeTypes: ['oak', 'oak', 'oak', 'oak', 'big_oak', 'birch'],
  grassDensity: 6, grassTypes: ['short_grass', 'short_grass', 'tall_grass', 'fern'],
  flowerDensity: 1.4, flowerTypes: ['dandelion', 'poppy', 'blue_orchid', 'oxeye_daisy'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'mineshafts', 'mushrooms'],
  mobs: spawns(SPAWNS_TEMPERATE, [
    { name: 'wolf', weight: 5, min: 4, max: 4, group: 'creature' },
  ]),
  musicMood: 'wooded', precipitation: 'rain',
});

/* ---------------------------- 3 flower_forest ---------------------------- */
defineBiome({
  name: 'flower_forest', display: 'Flower Forest', category: 'land',
  temperature: 0.7, humidity: 0.8, baseHeight: 68, heightVariation: 5,
  climate: [-0.11, 1, 0.0, 0.85, -0.2, 0.25, 0.08, 0.45, -1, -0.5, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0x79C05A, foliage: 0x59AE30, water: 0x3F76E4, fog: 0xCEDCF7, sky: 0x7EABFF,
  treeDensity: 5, treeTypes: ['oak', 'oak', 'birch'],
  grassDensity: 8, grassTypes: ['short_grass', 'tall_grass'],
  flowerDensity: 13,
  flowerTypes: ['dandelion', 'poppy', 'allium', 'blue_orchid', 'cornflower', 'oxeye_daisy'],
  features: ['lakes', 'ore_veins', 'dungeons', 'bee_nests'],
  mobs: spawns(SPAWNS_TEMPERATE, [
    { name: 'rabbit', weight: 4, min: 2, max: 3, group: 'creature' },
    { name: 'bee', weight: 6, min: 2, max: 4, group: 'creature' },
  ]),
  musicMood: 'floral', precipitation: 'rain',
});

/* ---------------------------- 4 birch_forest ----------------------------- */
defineBiome({
  name: 'birch_forest', display: 'Birch Forest', category: 'land',
  temperature: 0.6, humidity: 0.6, baseHeight: 69, heightVariation: 6,
  climate: [-0.11, 1, 0.0, 0.75, -0.2, 0.12, 0.08, 0.32, 0.0, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0x88BB67, foliage: 0x6BA941, water: 0x3F76E4, fog: 0xC6DAF7, sky: 0x7BA9FF,
  treeDensity: 10, treeTypes: ['birch', 'birch', 'birch', 'birch', 'oak'],
  grassDensity: 6, grassTypes: ['short_grass', 'short_grass', 'tall_grass'],
  flowerDensity: 1.2, flowerTypes: ['dandelion', 'poppy', 'oxeye_daisy', 'cornflower'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'mushrooms'],
  mobs: SPAWNS_TEMPERATE, musicMood: 'wooded', precipitation: 'rain',
});

/* ----------------------------- 5 dark_forest ----------------------------- */
defineBiome({
  name: 'dark_forest', display: 'Dark Forest', category: 'land',
  temperature: 0.7, humidity: 0.8, baseHeight: 69, heightVariation: 6,
  climate: [-0.11, 1, -0.1, 0.85, -0.2, 0.25, 0.32, 1, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0x507A32, foliage: 0x3F7420, water: 0x3C6FD0, fog: 0x9EB2C4, sky: 0x6E8FCC,
  treeDensity: 15, treeTypes: ['dark_oak', 'dark_oak', 'dark_oak', 'dark_oak', 'big_oak', 'birch'],
  grassDensity: 4, grassTypes: ['short_grass', 'fern'],
  flowerDensity: 0.8, flowerTypes: ['poppy', 'dandelion'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'giant_mushrooms', 'ruins'],
  mobs: spawns(SPAWNS_TEMPERATE, [
    { name: 'witch', weight: 12, min: 1, max: 1, group: 'monster' },
  ]),
  musicMood: 'mysterious', precipitation: 'rain',
});

/* -------------------------------- 6 taiga -------------------------------- */
defineBiome({
  name: 'taiga', display: 'Taiga', category: 'land',
  temperature: 0.25, humidity: 0.8, baseHeight: 70, heightVariation: 8,
  climate: [-0.11, 1, -0.3, 0.7, -0.5, -0.15, 0.05, 0.6, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'gravel',
  grass: 0x86B783, foliage: 0x68A464, water: 0x3D6FD8, fog: 0xBACFEB, sky: 0x7AA2F0,
  treeDensity: 9, treeTypes: ['spruce', 'spruce', 'spruce', 'tall_spruce'],
  grassDensity: 5, grassTypes: ['fern', 'fern', 'short_grass'],
  flowerDensity: 0.6, flowerTypes: ['dandelion', 'poppy'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'mushrooms', 'boulders'],
  mobs: spawns(SPAWNS_TEMPERATE, [
    { name: 'wolf', weight: 8, min: 4, max: 4, group: 'creature' },
    { name: 'fox', weight: 6, min: 2, max: 4, group: 'creature' },
    { name: 'rabbit', weight: 4, min: 2, max: 3, group: 'creature' },
  ]),
  musicMood: 'boreal', precipitation: 'rain',
});

/* --------------------- 7 old_growth_pine_taiga ---------------------------- */
defineBiome({
  name: 'old_growth_pine_taiga', display: 'Old Growth Pine Taiga', category: 'land',
  temperature: 0.3, humidity: 0.8, baseHeight: 71, heightVariation: 9,
  climate: [0.03, 1, -0.25, 0.5, -0.5, -0.15, 0.4, 1, 0.15, 1, -0.25, 0.25],
  surfaceBlock: 'podzol', subSurfaceBlock: 'dirt', underwaterBlock: 'gravel',
  grass: 0x86B87F, foliage: 0x619961, water: 0x3D6FD8, fog: 0xB2C6E0, sky: 0x749AE6,
  treeDensity: 13, treeTypes: ['tall_spruce', 'tall_spruce', 'tall_spruce', 'spruce'],
  grassDensity: 4, grassTypes: ['fern', 'fern', 'short_grass'],
  flowerDensity: 0.3, flowerTypes: ['dandelion'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'podzol_patches', 'mushrooms', 'boulders'],
  mobs: spawns(SPAWNS_TEMPERATE, [
    { name: 'wolf', weight: 8, min: 4, max: 4, group: 'creature' },
    { name: 'fox', weight: 8, min: 2, max: 4, group: 'creature' },
  ]),
  musicMood: 'boreal', precipitation: 'rain',
});

/* ----------------------------- 8 snowy_taiga ----------------------------- */
defineBiome({
  name: 'snowy_taiga', display: 'Snowy Taiga', category: 'land',
  temperature: -0.5, humidity: 0.4, baseHeight: 70, heightVariation: 8,
  climate: [-0.11, 1, -0.3, 0.7, -1, -0.5, 0.05, 0.6, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'gravel',
  grass: 0x80B497, foliage: 0x60A17B, water: 0x3D57D6, fog: 0xD2E2F2, sky: 0x8FBBF5,
  treeDensity: 8, treeTypes: ['spruce', 'spruce', 'tall_spruce'],
  grassDensity: 2, grassTypes: ['fern', 'short_grass'],
  flowerDensity: 0.1, flowerTypes: ['dandelion'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'snow_layer', 'ice_patches'],
  mobs: spawns(FARM_ANIMALS, AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'wolf', weight: 8, min: 4, max: 4, group: 'creature' },
    { name: 'fox', weight: 8, min: 2, max: 4, group: 'creature' },
    { name: 'stray', weight: 40, min: 1, max: 2, group: 'monster' },
  ]),
  musicMood: 'frozen', precipitation: 'snow',
});

/* ---------------------------- 9 snowy_plains ----------------------------- */
defineBiome({
  name: 'snowy_plains', display: 'Snowy Plains', category: 'land',
  temperature: 0.0, humidity: 0.5, baseHeight: 67, heightVariation: 4,
  climate: [-0.11, 1, 0.15, 1, -1, -0.5, -0.6, 0.08, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0x80B497, foliage: 0x60A17B, water: 0x3D57D6, fog: 0xD8E8F5, sky: 0x93C0F7,
  treeDensity: 0.05, treeTypes: ['spruce'],
  grassDensity: 1, grassTypes: ['short_grass'],
  flowerDensity: 0.05, flowerTypes: ['dandelion'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'snow_layer', 'ice_patches', 'village'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'rabbit', weight: 10, min: 2, max: 3, group: 'creature' },
    { name: 'polar_bear', weight: 1, min: 1, max: 2, group: 'creature' },
    { name: 'stray', weight: 80, min: 1, max: 2, group: 'monster' },
  ]),
  musicMood: 'frozen', precipitation: 'snow',
});

/* ----------------------------- 10 ice_spikes ----------------------------- */
defineBiome({
  name: 'ice_spikes', display: 'Ice Spikes', category: 'land',
  temperature: 0.0, humidity: 0.5, baseHeight: 68, heightVariation: 5,
  climate: [0.03, 1, 0.3, 1, -1, -0.6, -0.6, -0.15, 0.55, 1, -0.25, 0.25],
  surfaceBlock: 'snow_block', subSurfaceBlock: 'packed_ice', underwaterBlock: 'packed_ice',
  grass: 0x80B497, foliage: 0x60A17B, water: 0x3D57D6, fog: 0xE2F0FF, sky: 0xA6CFFA,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0.2, grassTypes: ['short_grass'],
  flowerDensity: 0, flowerTypes: [],
  features: ['ice_spikes', 'ravines', 'ore_veins', 'dungeons', 'snow_layer'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'rabbit', weight: 10, min: 2, max: 3, group: 'creature' },
    { name: 'stray', weight: 80, min: 1, max: 2, group: 'monster' },
  ]),
  musicMood: 'frozen', precipitation: 'snow',
});

/* ----------------------------- 11 mountains ------------------------------ */
defineBiome({
  name: 'mountains', display: 'Windswept Hills', category: 'land',
  temperature: 0.2, humidity: 0.3, baseHeight: 98, heightVariation: 34,
  climate: [0.03, 1, -0.65, -0.2, -0.5, 0.25, -0.45, 0.32, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'gravel',
  grass: 0x8AB689, foliage: 0x6DA36D, water: 0x3F76E4, fog: 0xC8DCF5, sky: 0x82B0FF,
  treeDensity: 0.8, treeTypes: ['spruce', 'oak'],
  grassDensity: 3, grassTypes: ['short_grass', 'fern'],
  flowerDensity: 0.3, flowerTypes: ['dandelion', 'poppy', 'cornflower'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'emerald_ore', 'stone_patches', 'boulders'],
  mobs: spawns(SPAWNS_TEMPERATE, [
    { name: 'goat', weight: 5, min: 1, max: 3, group: 'creature' },
    { name: 'llama', weight: 5, min: 4, max: 6, group: 'creature' },
  ]),
  musicMood: 'alpine', precipitation: 'rain',
});

/* --------------------------- 12 snowy_slopes ----------------------------- */
defineBiome({
  name: 'snowy_slopes', display: 'Snowy Slopes', category: 'land',
  temperature: -0.3, humidity: 0.9, baseHeight: 124, heightVariation: 30,
  climate: [0.2, 1, -0.85, -0.35, -1, -0.35, -0.4, 0.45, -1, 1, -0.25, 0.25],
  surfaceBlock: 'snow_block', subSurfaceBlock: 'stone', underwaterBlock: 'gravel',
  grass: 0x80B497, foliage: 0x60A17B, water: 0x3D57D6, fog: 0xDCEBFA, sky: 0x9DC8FA,
  treeDensity: 0.05, treeTypes: ['spruce'],
  grassDensity: 0.2, grassTypes: ['short_grass'],
  flowerDensity: 0, flowerTypes: [],
  features: ['ravines', 'ore_veins', 'dungeons', 'snow_layer', 'emerald_ore', 'ice_patches'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'goat', weight: 10, min: 1, max: 3, group: 'creature' },
    { name: 'rabbit', weight: 6, min: 2, max: 3, group: 'creature' },
    { name: 'stray', weight: 40, min: 1, max: 2, group: 'monster' },
  ]),
  musicMood: 'alpine', precipitation: 'snow',
});

/* -------------------------------- 13 grove ------------------------------- */
defineBiome({
  name: 'grove', display: 'Grove', category: 'land',
  temperature: -0.2, humidity: 0.8, baseHeight: 112, heightVariation: 22,
  climate: [0.2, 1, -0.7, -0.2, -0.75, -0.3, 0.0, 0.6, -1, 1, -0.25, 0.25],
  surfaceBlock: 'snow_block', subSurfaceBlock: 'dirt', underwaterBlock: 'gravel',
  grass: 0x80B497, foliage: 0x60A17B, water: 0x3D57D6, fog: 0xD2E4F5, sky: 0x93C0F7,
  treeDensity: 9, treeTypes: ['spruce', 'spruce', 'tall_spruce'],
  grassDensity: 1.5, grassTypes: ['fern', 'short_grass'],
  flowerDensity: 0.1, flowerTypes: ['dandelion'],
  features: ['ravines', 'ore_veins', 'dungeons', 'snow_layer', 'emerald_ore'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'wolf', weight: 8, min: 4, max: 4, group: 'creature' },
    { name: 'fox', weight: 8, min: 2, max: 4, group: 'creature' },
    { name: 'rabbit', weight: 4, min: 2, max: 3, group: 'creature' },
  ]),
  musicMood: 'alpine', precipitation: 'snow',
});

/* ---------------------------- 14 jagged_peaks ---------------------------- */
defineBiome({
  name: 'jagged_peaks', display: 'Jagged Peaks', category: 'land',
  temperature: -0.7, humidity: 0.9, baseHeight: 162, heightVariation: 58,
  climate: [0.3, 1, -1, -0.6, -1, -0.2, -0.5, 0.5, -1, 0.1, -0.25, 0.25],
  surfaceBlock: 'snow_block', subSurfaceBlock: 'stone', underwaterBlock: 'stone',
  grass: 0x80B497, foliage: 0x60A17B, water: 0x3D57D6, fog: 0xDCEBFF, sky: 0xA8D0FF,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['ravines', 'ore_veins', 'emerald_ore', 'snow_layer', 'stone_patches'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'goat', weight: 12, min: 1, max: 3, group: 'creature' },
  ]),
  musicMood: 'alpine', precipitation: 'snow',
});

/* ---------------------------- 15 frozen_peaks ---------------------------- */
defineBiome({
  name: 'frozen_peaks', display: 'Frozen Peaks', category: 'land',
  temperature: -0.7, humidity: 0.9, baseHeight: 166, heightVariation: 60,
  climate: [0.3, 1, -1, -0.7, -1, -0.5, -0.5, 0.5, 0.1, 1, -0.25, 0.25],
  surfaceBlock: 'packed_ice', subSurfaceBlock: 'stone', underwaterBlock: 'packed_ice',
  grass: 0x80B497, foliage: 0x60A17B, water: 0x3D57D6, fog: 0xE4F2FF, sky: 0xB0D6FF,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['ravines', 'ore_veins', 'emerald_ore', 'snow_layer', 'ice_patches'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'goat', weight: 12, min: 1, max: 3, group: 'creature' },
  ]),
  musicMood: 'frozen', precipitation: 'snow',
});

/* ---------------------------- 16 stony_peaks ----------------------------- */
defineBiome({
  name: 'stony_peaks', display: 'Stony Peaks', category: 'land',
  temperature: 1.0, humidity: 0.3, baseHeight: 152, heightVariation: 50,
  climate: [0.3, 1, -1, -0.6, 0.25, 1, -0.5, 0.5, -1, 1, -0.25, 0.25],
  surfaceBlock: 'stone', subSurfaceBlock: 'stone', underwaterBlock: 'gravel',
  grass: 0x9ABE4B, foliage: 0x8AAE3B, water: 0x3F76E4, fog: 0xC8D8EE, sky: 0x86B0F5,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0.4, grassTypes: ['short_grass'],
  flowerDensity: 0, flowerTypes: [],
  features: ['ravines', 'ore_veins', 'emerald_ore', 'stone_patches', 'calcite_veins'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'goat', weight: 8, min: 1, max: 3, group: 'creature' },
  ]),
  musicMood: 'alpine', precipitation: 'rain',
});

/* ------------------------------- 17 meadow ------------------------------- */
defineBiome({
  name: 'meadow', display: 'Meadow', category: 'land',
  temperature: 0.5, humidity: 0.8, baseHeight: 90, heightVariation: 12,
  climate: [0.03, 1, -0.45, 0.15, -0.2, 0.4, -0.1, 0.45, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0x83BB6D, foliage: 0x63A948, water: 0x3F76E4, fog: 0xC6E0F5, sky: 0x82B4FF,
  treeDensity: 0.2, treeTypes: ['oak', 'birch'],
  grassDensity: 24, grassTypes: ['short_grass', 'short_grass', 'tall_grass'],
  flowerDensity: 11,
  flowerTypes: ['dandelion', 'poppy', 'cornflower', 'oxeye_daisy', 'allium', 'blue_orchid'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'bee_nests', 'village'],
  mobs: spawns(FARM_ANIMALS, AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'donkey', weight: 4, min: 1, max: 2, group: 'creature' },
    { name: 'rabbit', weight: 4, min: 2, max: 3, group: 'creature' },
    { name: 'bee', weight: 8, min: 2, max: 4, group: 'creature' },
  ]),
  musicMood: 'serene', precipitation: 'rain',
});

/* ------------------------------ 18 savanna ------------------------------- */
defineBiome({
  name: 'savanna', display: 'Savanna', category: 'land',
  temperature: 1.2, humidity: 0.0, baseHeight: 69, heightVariation: 6,
  climate: [-0.11, 1, 0.15, 1, 0.55, 1, -0.6, -0.08, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0xBFB755, foliage: 0xAEA42A, water: 0x2C8B9C, fog: 0xD6CFA0, sky: 0x93B4E8,
  treeDensity: 2.2, treeTypes: ['acacia', 'acacia', 'acacia', 'oak'],
  grassDensity: 20, grassTypes: ['short_grass', 'short_grass', 'short_grass', 'tall_grass'],
  flowerDensity: 0.5, flowerTypes: ['dandelion', 'poppy'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'village', 'pumpkins'],
  mobs: spawns(FARM_ANIMALS, AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'horse', weight: 8, min: 2, max: 6, group: 'creature' },
    { name: 'donkey', weight: 3, min: 1, max: 3, group: 'creature' },
    { name: 'llama', weight: 4, min: 4, max: 6, group: 'creature' },
  ]),
  musicMood: 'arid', precipitation: 'none',
});

/* -------------------------- 19 savanna_plateau --------------------------- */
defineBiome({
  name: 'savanna_plateau', display: 'Savanna Plateau', category: 'land',
  temperature: 1.0, humidity: 0.0, baseHeight: 100, heightVariation: 10,
  climate: [0.3, 1, -0.25, 0.2, 0.55, 1, -0.6, -0.08, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0xBFB755, foliage: 0xAEA42A, water: 0x2C8B9C, fog: 0xD9D2A6, sky: 0x8FB0E4,
  treeDensity: 1.2, treeTypes: ['acacia', 'acacia', 'oak'],
  grassDensity: 16, grassTypes: ['short_grass', 'short_grass', 'tall_grass'],
  flowerDensity: 0.3, flowerTypes: ['dandelion'],
  features: ['ravines', 'ore_veins', 'dungeons', 'village'],
  mobs: spawns(FARM_ANIMALS, AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'horse', weight: 6, min: 2, max: 6, group: 'creature' },
    { name: 'llama', weight: 8, min: 4, max: 6, group: 'creature' },
  ]),
  musicMood: 'arid', precipitation: 'none',
});

/* ------------------------------- 20 desert ------------------------------- */
defineBiome({
  name: 'desert', display: 'Desert', category: 'land',
  temperature: 2.0, humidity: 0.0, baseHeight: 67, heightVariation: 5,
  climate: [-0.11, 1, -0.2, 1, 0.6, 1, -1, -0.5, -1, 0.3, -0.25, 0.25],
  surfaceBlock: 'sand', subSurfaceBlock: 'sandstone', underwaterBlock: 'sand',
  grass: 0xBFB755, foliage: 0xAEA42A, water: 0x32A598, fog: 0xE4CFA0, sky: 0x93B0E8,
  treeDensity: 0, treeTypes: [],
  grassDensity: 1.2, grassTypes: ['dead_bush', 'dead_bush', 'short_grass'],
  flowerDensity: 0, flowerTypes: [],
  features: ['desert_wells', 'desert_pyramid', 'ravines', 'ore_veins', 'dungeons', 'cactus', 'village', 'fossils'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'rabbit', weight: 6, min: 2, max: 3, group: 'creature' },
    { name: 'husk', weight: 80, min: 2, max: 4, group: 'monster' },
  ]),
  musicMood: 'arid', precipitation: 'none',
});

/* ------------------------------ 21 badlands ------------------------------ */
defineBiome({
  name: 'badlands', display: 'Badlands', category: 'land',
  temperature: 2.0, humidity: 0.0, baseHeight: 86, heightVariation: 22,
  climate: [0.03, 1, 0.0, 0.6, 0.6, 1, -1, -0.6, 0.25, 1, -0.25, 0.25],
  surfaceBlock: 'red_sand', subSurfaceBlock: 'red_sandstone', underwaterBlock: 'red_sand',
  grass: 0x90814D, foliage: 0x9E814D, water: 0x4E7F81, fog: 0xD9A96B, sky: 0x9AA8D0,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0.4, grassTypes: ['dead_bush', 'dead_bush'],
  flowerDensity: 0, flowerTypes: [],
  features: ['badlands_bands', 'mineshafts', 'ravines', 'ore_veins', 'dungeons', 'cactus', 'gold_ore_boost'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'husk', weight: 20, min: 2, max: 4, group: 'monster' },
  ]),
  musicMood: 'arid', precipitation: 'none',
});

/* -------------------------- 22 wooded_badlands --------------------------- */
defineBiome({
  name: 'wooded_badlands', display: 'Wooded Badlands', category: 'land',
  temperature: 2.0, humidity: 0.0, baseHeight: 94, heightVariation: 24,
  climate: [0.03, 1, 0.0, 0.55, 0.6, 1, -0.72, -0.35, 0.25, 1, -0.25, 0.25],
  surfaceBlock: 'coarse_dirt', subSurfaceBlock: 'terracotta', underwaterBlock: 'red_sand',
  grass: 0x90814D, foliage: 0x9E814D, water: 0x4E7F81, fog: 0xD2A878, sky: 0x9AA8D0,
  treeDensity: 3.5, treeTypes: ['oak', 'oak', 'big_oak'],
  grassDensity: 1.5, grassTypes: ['short_grass', 'dead_bush'],
  flowerDensity: 0, flowerTypes: [],
  features: ['badlands_bands', 'mineshafts', 'ravines', 'ore_veins', 'dungeons', 'gold_ore_boost'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'husk', weight: 15, min: 2, max: 4, group: 'monster' },
  ]),
  musicMood: 'arid', precipitation: 'none',
});

/* -------------------------- 23 eroded_badlands --------------------------- */
defineBiome({
  name: 'eroded_badlands', display: 'Eroded Badlands', category: 'land',
  temperature: 2.0, humidity: 0.0, baseHeight: 84, heightVariation: 32,
  climate: [0.03, 1, -0.55, 0.0, 0.6, 1, -1, -0.6, 0.45, 1, -0.25, 0.25],
  surfaceBlock: 'red_sand', subSurfaceBlock: 'terracotta', underwaterBlock: 'red_sand',
  grass: 0x90814D, foliage: 0x9E814D, water: 0x4E7F81, fog: 0xE0AF6E, sky: 0xA0AAD0,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0.3, grassTypes: ['dead_bush'],
  flowerDensity: 0, flowerTypes: [],
  features: ['badlands_bands', 'hoodoos', 'mineshafts', 'ravines', 'ore_veins', 'gold_ore_boost'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'husk', weight: 20, min: 2, max: 4, group: 'monster' },
  ]),
  musicMood: 'arid', precipitation: 'none',
});

/* ------------------------------- 24 jungle ------------------------------- */
defineBiome({
  name: 'jungle', display: 'Jungle', category: 'land',
  temperature: 0.95, humidity: 0.9, baseHeight: 71, heightVariation: 9,
  climate: [-0.11, 1, -0.25, 0.65, 0.5, 1, 0.3, 1, -1, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0x59C93C, foliage: 0x30BB0B, water: 0x14A2C5, fog: 0xA8D8B0, sky: 0x77A8D8,
  treeDensity: 28, treeTypes: ['jungle', 'jungle', 'jungle', 'big_jungle', 'oak'],
  grassDensity: 30, grassTypes: ['short_grass', 'short_grass', 'tall_grass', 'fern'],
  flowerDensity: 1.0, flowerTypes: ['dandelion', 'poppy', 'blue_orchid'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'vines', 'melons', 'bamboo', 'jungle_temple', 'cocoa'],
  mobs: spawns(FARM_ANIMALS, AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'parrot', weight: 10, min: 1, max: 2, group: 'creature' },
    { name: 'ocelot', weight: 6, min: 1, max: 2, group: 'creature' },
    { name: 'panda', weight: 2, min: 1, max: 2, group: 'creature' },
  ]),
  musicMood: 'jungle', precipitation: 'rain',
});

/* --------------------------- 25 bamboo_jungle ---------------------------- */
defineBiome({
  name: 'bamboo_jungle', display: 'Bamboo Jungle', category: 'land',
  temperature: 0.95, humidity: 0.9, baseHeight: 71, heightVariation: 8,
  climate: [0.03, 1, -0.25, 0.65, 0.5, 1, 0.5, 1, 0.35, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0x59C93C, foliage: 0x30BB0B, water: 0x14A2C5, fog: 0xB2DEB6, sky: 0x7BAADA,
  treeDensity: 12, treeTypes: ['jungle', 'big_jungle'],
  grassDensity: 26, grassTypes: ['short_grass', 'tall_grass', 'fern'],
  flowerDensity: 0.6, flowerTypes: ['dandelion', 'blue_orchid'],
  features: ['lakes', 'ravines', 'ore_veins', 'dungeons', 'bamboo', 'bamboo', 'vines', 'melons'],
  mobs: spawns(FARM_ANIMALS, AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'panda', weight: 16, min: 1, max: 2, group: 'creature' },
    { name: 'parrot', weight: 8, min: 1, max: 2, group: 'creature' },
    { name: 'ocelot', weight: 4, min: 1, max: 2, group: 'creature' },
  ]),
  musicMood: 'jungle', precipitation: 'rain',
});

/* -------------------------------- 26 swamp ------------------------------- */
defineBiome({
  name: 'swamp', display: 'Swamp', category: 'land',
  temperature: 0.8, humidity: 0.9, baseHeight: 62, heightVariation: 2,
  climate: [-0.11, 0.35, 0.45, 1, 0.15, 0.6, 0.3, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'mud',
  grass: 0x6A7039, foliage: 0x6A7039, water: 0x617B64, fog: 0x7C8A66, sky: 0x6E86A8,
  treeDensity: 3.5, treeTypes: ['oak', 'oak', 'big_oak'],
  grassDensity: 10, grassTypes: ['short_grass', 'short_grass', 'tall_grass', 'fern'],
  flowerDensity: 0.4, flowerTypes: ['blue_orchid', 'dandelion'],
  features: ['water_lakes', 'ravines', 'ore_veins', 'dungeons', 'vines', 'mushrooms', 'clay_patches', 'sugar_cane', 'witch_hut'],
  mobs: spawns(FARM_ANIMALS, AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'slime', weight: 40, min: 2, max: 4, group: 'monster' },
    { name: 'witch', weight: 20, min: 1, max: 1, group: 'monster' },
    { name: 'frog', weight: 8, min: 2, max: 5, group: 'creature' },
  ]),
  musicMood: 'swamp', precipitation: 'rain',
});

/* --------------------------- 27 mangrove_swamp --------------------------- */
defineBiome({
  name: 'mangrove_swamp', display: 'Mangrove Swamp', category: 'land',
  temperature: 0.8, humidity: 0.9, baseHeight: 62, heightVariation: 2,
  climate: [-0.11, 0.35, 0.45, 1, 0.6, 1, 0.3, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'mud', subSurfaceBlock: 'mud', underwaterBlock: 'mud',
  grass: 0x6A7039, foliage: 0x5A7038, water: 0x3A7A6A, fog: 0x7B8A6E, sky: 0x6E90A6,
  treeDensity: 7, treeTypes: ['mangrove', 'mangrove', 'mangrove', 'oak'],
  grassDensity: 9, grassTypes: ['short_grass', 'tall_grass', 'fern'],
  flowerDensity: 0.3, flowerTypes: ['blue_orchid'],
  features: ['water_lakes', 'ravines', 'ore_veins', 'vines', 'mud_patches', 'seagrass', 'sugar_cane'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'frog', weight: 20, min: 2, max: 5, group: 'creature' },
    { name: 'slime', weight: 20, min: 2, max: 4, group: 'monster' },
    { name: 'tropical_fish', weight: 8, min: 3, max: 6, group: 'water_ambient' },
  ]),
  musicMood: 'swamp', precipitation: 'rain',
});

/* -------------------------------- 28 beach ------------------------------- */
defineBiome({
  name: 'beach', display: 'Beach', category: 'beach',
  temperature: 0.8, humidity: 0.4, baseHeight: 64, heightVariation: 2,
  climate: [-0.19, -0.11, -0.35, 1, -0.4, 1, -1, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'sand', subSurfaceBlock: 'sand', underwaterBlock: 'sand',
  grass: 0x91BD59, foliage: 0x77AB2F, water: 0x3F76E4, fog: 0xC6DCF7, sky: 0x7EAAFF,
  treeDensity: 0.05, treeTypes: ['oak'],
  grassDensity: 0.3, grassTypes: ['short_grass'],
  flowerDensity: 0, flowerTypes: [],
  features: ['ore_veins', 'sugar_cane', 'shipwreck', 'buried_treasure'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'turtle', weight: 5, min: 2, max: 5, group: 'creature' },
  ]),
  musicMood: 'serene', precipitation: 'rain',
});

/* ----------------------------- 29 snowy_beach ---------------------------- */
defineBiome({
  name: 'snowy_beach', display: 'Snowy Beach', category: 'beach',
  temperature: 0.05, humidity: 0.3, baseHeight: 64, heightVariation: 2,
  climate: [-0.19, -0.11, -0.35, 1, -1, -0.45, -1, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'sand', subSurfaceBlock: 'sandstone', underwaterBlock: 'gravel',
  grass: 0x83B593, foliage: 0x60A17B, water: 0x3D57D6, fog: 0xD8E8F5, sky: 0x93C0F7,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0.1, grassTypes: ['short_grass'],
  flowerDensity: 0, flowerTypes: [],
  features: ['ore_veins', 'snow_layer', 'ice_patches', 'shipwreck'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'stray', weight: 30, min: 1, max: 2, group: 'monster' },
  ]),
  musicMood: 'frozen', precipitation: 'snow',
});

/* ----------------------------- 30 stony_shore ---------------------------- */
defineBiome({
  name: 'stony_shore', display: 'Stony Shore', category: 'beach',
  temperature: 0.2, humidity: 0.3, baseHeight: 67, heightVariation: 7,
  climate: [-0.19, -0.11, -1, -0.35, -1, 1, -1, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'stone', subSurfaceBlock: 'stone', underwaterBlock: 'gravel',
  grass: 0x8AB689, foliage: 0x6DA36D, water: 0x3F76E4, fog: 0xB6C8DE, sky: 0x7CA4EE,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0.2, grassTypes: ['short_grass'],
  flowerDensity: 0, flowerTypes: [],
  features: ['ore_veins', 'ravines', 'stone_patches', 'shipwreck'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE),
  musicMood: 'alpine', precipitation: 'rain',
});

/* -------------------------------- 31 ocean ------------------------------- */
defineBiome({
  name: 'ocean', display: 'Ocean', category: 'ocean',
  temperature: 0.5, humidity: 0.5, baseHeight: 45, heightVariation: 8,
  climate: [-0.455, -0.19, -1, 1, -0.15, 0.25, -1, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'gravel', subSurfaceBlock: 'dirt', underwaterBlock: 'gravel',
  grass: 0x8EB971, foliage: 0x71A74D, water: 0x3F76E4, fog: 0xB0CCEE, sky: 0x78A7FF,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['seagrass', 'kelp_forest', 'ore_veins', 'shipwreck', 'ocean_ruins', 'clay_patches'],
  mobs: spawns(SPAWNS_OCEAN, [
    { name: 'dolphin', weight: 2, min: 1, max: 2, group: 'water_creature' },
  ]),
  musicMood: 'aquatic', precipitation: 'rain',
});

/* ----------------------------- 32 deep_ocean ----------------------------- */
defineBiome({
  name: 'deep_ocean', display: 'Deep Ocean', category: 'ocean',
  temperature: 0.5, humidity: 0.5, baseHeight: 26, heightVariation: 12,
  climate: [-1, -0.455, -1, 1, -0.45, 0.6, -1, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'gravel', subSurfaceBlock: 'dirt', underwaterBlock: 'gravel',
  grass: 0x8EB971, foliage: 0x71A74D, water: 0x3059C4, fog: 0x8FB2E0, sky: 0x6C97E8,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['seagrass', 'kelp_forest', 'ore_veins', 'shipwreck', 'ocean_ruins', 'ocean_monument'],
  mobs: spawns(SPAWNS_OCEAN, [
    { name: 'glow_squid', weight: 10, min: 2, max: 4, group: 'water_creature' },
    { name: 'drowned', weight: 24, min: 1, max: 3, group: 'monster' },
  ]),
  musicMood: 'abyssal', precipitation: 'rain',
});

/* ----------------------------- 33 cold_ocean ----------------------------- */
defineBiome({
  name: 'cold_ocean', display: 'Cold Ocean', category: 'ocean',
  temperature: 0.5, humidity: 0.5, baseHeight: 45, heightVariation: 8,
  climate: [-0.455, -0.19, -1, 1, -0.45, -0.15, -1, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'gravel', subSurfaceBlock: 'gravel', underwaterBlock: 'gravel',
  grass: 0x8EB971, foliage: 0x71A74D, water: 0x3D57D6, fog: 0xA6C2E8, sky: 0x76A0F2,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['seagrass', 'kelp_forest', 'ore_veins', 'shipwreck', 'ocean_ruins'],
  mobs: spawns(SPAWNS_OCEAN, [
    { name: 'salmon', weight: 15, min: 3, max: 5, group: 'water_ambient' },
  ]),
  musicMood: 'aquatic', precipitation: 'rain',
});

/* --------------------------- 34 lukewarm_ocean --------------------------- */
defineBiome({
  name: 'lukewarm_ocean', display: 'Lukewarm Ocean', category: 'ocean',
  temperature: 0.5, humidity: 0.5, baseHeight: 46, heightVariation: 8,
  climate: [-0.455, -0.19, -1, 1, 0.25, 0.6, -1, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'sand', subSurfaceBlock: 'sand', underwaterBlock: 'sand',
  grass: 0x8EB971, foliage: 0x71A74D, water: 0x45ADF2, fog: 0xB6DCF2, sky: 0x7CB4FF,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['seagrass', 'ore_veins', 'shipwreck', 'ocean_ruins'],
  mobs: spawns(SPAWNS_OCEAN, [
    { name: 'tropical_fish', weight: 10, min: 3, max: 6, group: 'water_ambient' },
    { name: 'pufferfish', weight: 5, min: 1, max: 3, group: 'water_ambient' },
    { name: 'dolphin', weight: 4, min: 1, max: 2, group: 'water_creature' },
  ]),
  musicMood: 'aquatic', precipitation: 'rain',
});

/* ----------------------------- 35 warm_ocean ----------------------------- */
defineBiome({
  name: 'warm_ocean', display: 'Warm Ocean', category: 'ocean',
  temperature: 0.5, humidity: 0.5, baseHeight: 48, heightVariation: 7,
  climate: [-0.455, -0.19, -1, 1, 0.6, 1, -1, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'sand', subSurfaceBlock: 'sandstone', underwaterBlock: 'sand',
  grass: 0x8EB971, foliage: 0x71A74D, water: 0x43D5EE, fog: 0xA8E6E8, sky: 0x86C4FF,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['coral_reef', 'seagrass', 'ore_veins', 'shipwreck', 'ocean_ruins'],
  mobs: spawns(SPAWNS_OCEAN, [
    { name: 'tropical_fish', weight: 25, min: 4, max: 8, group: 'water_ambient' },
    { name: 'pufferfish', weight: 15, min: 1, max: 3, group: 'water_ambient' },
    { name: 'dolphin', weight: 6, min: 1, max: 2, group: 'water_creature' },
    { name: 'turtle', weight: 3, min: 2, max: 5, group: 'creature' },
  ]),
  musicMood: 'aquatic', precipitation: 'rain',
});

/* ---------------------------- 36 frozen_ocean ---------------------------- */
defineBiome({
  name: 'frozen_ocean', display: 'Frozen Ocean', category: 'ocean',
  temperature: 0.0, humidity: 0.5, baseHeight: 44, heightVariation: 8,
  climate: [-1, -0.19, -1, 1, -1, -0.45, -1, 1, -1, 1, -0.2, 0.2],
  surfaceBlock: 'gravel', subSurfaceBlock: 'gravel', underwaterBlock: 'gravel',
  grass: 0x80B497, foliage: 0x60A17B, water: 0x8FCBE0, fog: 0xD8EBF5, sky: 0x9CC8F7,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['icebergs', 'ore_veins', 'shipwreck', 'ice_patches'],
  mobs: spawns([
    { name: 'squid', weight: 8, min: 1, max: 4, group: 'water_creature' },
    { name: 'salmon', weight: 15, min: 3, max: 5, group: 'water_ambient' },
    { name: 'polar_bear', weight: 4, min: 1, max: 2, group: 'creature' },
    { name: 'drowned', weight: 5, min: 1, max: 1, group: 'monster' },
  ], HOSTILE_BASE, [
    { name: 'stray', weight: 30, min: 1, max: 2, group: 'monster' },
  ]),
  musicMood: 'frozen', precipitation: 'snow',
});

/* -------------------------------- 37 river ------------------------------- */
defineBiome({
  name: 'river', display: 'River', category: 'river',
  temperature: 0.5, humidity: 0.5, baseHeight: 58, heightVariation: 2,
  climate: [-0.11, 1, -0.4, 1, -0.45, 1, -1, 1, -0.06, 0.06, -0.2, 0.2],
  surfaceBlock: 'sand', subSurfaceBlock: 'sand', underwaterBlock: 'sand',
  grass: 0x8EB971, foliage: 0x71A74D, water: 0x3F76E4, fog: 0xBCD4F5, sky: 0x7BA8FF,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0.2, grassTypes: ['short_grass'],
  flowerDensity: 0, flowerTypes: [],
  features: ['seagrass', 'ore_veins', 'sugar_cane', 'clay_patches'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'squid', weight: 6, min: 1, max: 4, group: 'water_creature' },
    { name: 'salmon', weight: 8, min: 2, max: 4, group: 'water_ambient' },
    { name: 'drowned', weight: 6, min: 1, max: 1, group: 'monster' },
  ]),
  musicMood: 'serene', precipitation: 'rain',
});

/* ---------------------------- 38 frozen_river ---------------------------- */
defineBiome({
  name: 'frozen_river', display: 'Frozen River', category: 'river',
  temperature: 0.0, humidity: 0.5, baseHeight: 58, heightVariation: 2,
  climate: [-0.11, 1, -0.4, 1, -1, -0.45, -1, 1, -0.06, 0.06, -0.2, 0.2],
  surfaceBlock: 'sand', subSurfaceBlock: 'gravel', underwaterBlock: 'gravel',
  grass: 0x80B497, foliage: 0x60A17B, water: 0x93CBE0, fog: 0xDCEBF7, sky: 0x9CC8F7,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['ore_veins', 'ice_patches', 'snow_layer'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'squid', weight: 4, min: 1, max: 4, group: 'water_creature' },
    { name: 'salmon', weight: 8, min: 2, max: 4, group: 'water_ambient' },
    { name: 'stray', weight: 20, min: 1, max: 2, group: 'monster' },
  ]),
  musicMood: 'frozen', precipitation: 'snow',
});

/* -------------------------- 39 mushroom_fields --------------------------- */
defineBiome({
  name: 'mushroom_fields', display: 'Mushroom Fields', category: 'land',
  temperature: 0.9, humidity: 1.0, baseHeight: 70, heightVariation: 8,
  climate: [-0.6, -0.25, -0.5, 0.6, 0.0, 0.8, 0.2, 1, 0.85, 1, -0.25, 0.25],
  surfaceBlock: 'mycelium', subSurfaceBlock: 'dirt', underwaterBlock: 'gravel',
  grass: 0x55C93F, foliage: 0x2BBB0F, water: 0x3F76E4, fog: 0xD8C0E0, sky: 0x8FA6E8,
  treeDensity: 0.6, treeTypes: ['oak'],
  grassDensity: 3, grassTypes: ['brown_mushroom', 'red_mushroom', 'brown_mushroom'],
  flowerDensity: 0, flowerTypes: [],
  features: ['giant_mushrooms', 'giant_mushrooms', 'ore_veins', 'ravines', 'lakes'],
  mobs: Object.freeze([
    Object.freeze({ name: 'mooshroom', weight: 20, min: 4, max: 8, group: 'creature' }),
    Object.freeze({ name: 'bat', weight: 10, min: 4, max: 8, group: 'ambient' }),
  ]),
  musicMood: 'mysterious', precipitation: 'rain',
});

/* ---------------------------- 40 cherry_grove ---------------------------- */
defineBiome({
  name: 'cherry_grove', display: 'Cherry Grove', category: 'land',
  temperature: 0.5, humidity: 0.8, baseHeight: 86, heightVariation: 14,
  climate: [0.03, 1, -0.45, 0.25, -0.05, 0.45, -0.05, 0.45, 0.65, 1, -0.25, 0.25],
  surfaceBlock: 'grass_block', subSurfaceBlock: 'dirt', underwaterBlock: 'dirt',
  grass: 0xB6DB61, foliage: 0xF3B3E2, water: 0x5DB7EF, fog: 0xF2D2E4, sky: 0xA8B8F0,
  treeDensity: 9, treeTypes: ['cherry', 'cherry', 'cherry', 'oak'],
  grassDensity: 14, grassTypes: ['short_grass', 'short_grass', 'tall_grass'],
  flowerDensity: 7, flowerTypes: ['allium', 'allium', 'oxeye_daisy', 'dandelion', 'poppy'],
  features: ['lakes', 'ore_veins', 'dungeons', 'bee_nests', 'emerald_ore'],
  mobs: spawns(FARM_ANIMALS, AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'rabbit', weight: 8, min: 2, max: 3, group: 'creature' },
    { name: 'bee', weight: 10, min: 2, max: 4, group: 'creature' },
    { name: 'pig', weight: 10, min: 2, max: 4, group: 'creature' },
  ]),
  musicMood: 'floral', precipitation: 'rain',
});

/* ----------------------------- 41 lush_caves ----------------------------- */
defineBiome({
  name: 'lush_caves', display: 'Lush Caves', category: 'cave',
  temperature: 0.5, humidity: 0.5, baseHeight: 40, heightVariation: 12,
  climate: [-0.25, 1, -1, 1, -0.35, 1, 0.22, 1, -1, 1, 0.55, 1],
  surfaceBlock: 'moss_block', subSurfaceBlock: 'dirt', underwaterBlock: 'clay',
  grass: 0x6BC94A, foliage: 0x48B518, water: 0x47ACBB, fog: 0x4C6B4A, sky: 0x2E4A3A,
  treeDensity: 1.2, treeTypes: ['azalea'],
  grassDensity: 20, grassTypes: ['short_grass', 'tall_grass', 'moss_carpet', 'moss_carpet'],
  flowerDensity: 2, flowerTypes: ['dandelion', 'blue_orchid'],
  features: ['lush_cave_vegetation', 'clay_patches', 'water_lakes', 'ore_veins', 'dungeons'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'axolotl', weight: 10, min: 4, max: 6, group: 'water_creature' },
    { name: 'glow_squid', weight: 6, min: 2, max: 4, group: 'water_creature' },
    { name: 'tropical_fish', weight: 4, min: 2, max: 4, group: 'water_ambient' },
  ]),
  musicMood: 'mysterious', precipitation: 'none',
});

/* --------------------------- 42 dripstone_caves -------------------------- */
defineBiome({
  name: 'dripstone_caves', display: 'Dripstone Caves', category: 'cave',
  temperature: 0.8, humidity: 0.4, baseHeight: 30, heightVariation: 16,
  climate: [-0.25, 1, -1, 1, -0.35, 1, -1, -0.12, -1, 1, 0.55, 1],
  surfaceBlock: 'stone', subSurfaceBlock: 'dripstone_block', underwaterBlock: 'gravel',
  grass: 0x8EB971, foliage: 0x71A74D, water: 0x3F76E4, fog: 0x6B5B4C, sky: 0x3A3128,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['dripstone', 'dripstone', 'ore_veins', 'lava_lakes', 'dungeons', 'fossils'],
  mobs: spawns(AMBIENT_BAT, HOSTILE_BASE, [
    { name: 'cave_spider', weight: 20, min: 1, max: 2, group: 'monster' },
    { name: 'silverfish', weight: 8, min: 1, max: 3, group: 'monster' },
  ]),
  musicMood: 'ominous', precipitation: 'none',
});

/* ----------------------------- 43 deep_dark ------------------------------ */
defineBiome({
  name: 'deep_dark', display: 'Deep Dark', category: 'cave',
  temperature: 0.8, humidity: 0.4, baseHeight: -10, heightVariation: 8,
  climate: [0.0, 1, -1, -0.2, -1, 1, -0.18, 0.28, -1, 1, 0.82, 1],
  surfaceBlock: 'deepslate', subSurfaceBlock: 'deepslate', underwaterBlock: 'deepslate',
  grass: 0x6B7C5A, foliage: 0x5A6B4A, water: 0x22304A, fog: 0x0A0C10, sky: 0x05070C,
  treeDensity: 0, treeTypes: [],
  grassDensity: 0, grassTypes: [],
  flowerDensity: 0, flowerTypes: [],
  features: ['sculk', 'ancient_city', 'ore_veins', 'no_mob_spawns'],
  mobs: Object.freeze([
    Object.freeze({ name: 'warden', weight: 1, min: 1, max: 1, group: 'monster' }),
  ]),
  musicMood: 'ominous', precipitation: 'none',
});

/* -------------------------------------------------------------------------- */
/* Derived tables                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Number of registered biomes. Ids are `0 .. BIOME_COUNT - 1`.
 * @type {number}
 */
export const BIOME_COUNT = BIOMES.length;

/** Flattened climate boxes: 12 floats per biome, same order as `BIOMES`. */
const CLIMATE_BOX = new Float32Array(BIOME_COUNT * 12);
/** 1 when the biome participates in the generic nearest-box scan. */
const SCANNABLE = new Uint8Array(BIOME_COUNT);
/** 1 when the biome is an underground (cave) biome. */
const IS_CAVE = new Uint8Array(BIOME_COUNT);
/**
 * Tiny specificity penalty proportional to the 6D volume of the climate box.
 *
 * Variant biomes (`sunflower_plains`, `ice_spikes`, `bamboo_jungle`, ...) are
 * strict sub-boxes of a broader parent (`plains`, `snowy_plains`, `jungle`).
 * Inside the variant box both distances are exactly 0, so without this the
 * broader parent would always win on index order and the variant could never
 * be generated. The penalty is 1e-4 at most — far below any genuine distance
 * difference — so it only ever breaks ties, in favour of the tighter box.
 */
const SPECIFICITY = new Float32Array(BIOME_COUNT);

/** Largest possible box volume: six axes of width 2. */
const MAX_BOX_VOLUME = 64;
/** Scale of the specificity tie-break. */
const SPECIFICITY_EPS = 1e-4;

for (let i = 0; i < BIOME_COUNT; i++) {
  const b = BIOMES[i];
  CLIMATE_BOX.set(b.climate, i * 12);
  IS_CAVE[i] = b.category === 'cave' ? 1 : 0;
  // Ocean / river / beach are picked by the explicit continentalness rules, so
  // they must never win the generic land scan.
  SCANNABLE[i] = (b.category === 'land' || b.category === 'cave') ? 1 : 0;
  let volume = 1;
  for (let a = 0; a < 12; a += 2) volume *= b.climate[a + 1] - b.climate[a];
  SPECIFICITY[i] = (volume / MAX_BOX_VOLUME) * SPECIFICITY_EPS;
}

/* Axis weights for the nearest-box distance. Temperature and continentalness
 * dominate (they define the broad strokes), weirdness only breaks ties, depth
 * is heavy so surface and cave biomes can never bleed into each other. */
const W_CONT = 1.35;
const W_EROS = 1.0;
const W_TEMP = 1.65;
const W_HUMI = 1.25;
const W_WEIRD = 0.55;
const W_DEPTH = 2.2;

/** Continentalness below this is open ocean. */
const CONT_OCEAN = -0.19;
/** Continentalness below this is deep ocean. */
const CONT_DEEP_OCEAN = -0.455;
/** Continentalness below this (but above `CONT_OCEAN`) is coastline. */
const CONT_COAST = -0.11;
/** Erosion below this turns a coast into a stony shore instead of a beach. */
const EROSION_STONY_SHORE = -0.375;
/** Half-width of the river channel in weirdness space. */
const RIVER_HALF_WIDTH = 0.055;
/** Temperature below this freezes water. */
const CLIMATE_FREEZING = -0.45;
/** Depth at or above which only cave biomes are considered. */
const DEPTH_CAVE_ONLY = 0.72;
/** Depth at or above which cave biomes start competing with surface biomes. */
const DEPTH_CAVE_START = 0.45;
/** Weirdness above this turns an ocean cell into a mushroom island. */
const WEIRD_MUSHROOM_ISLAND = 0.88;

/**
 * Clamp into `[-1, 1]`, mapping `NaN`/`undefined` to 0 so `selectBiome` can
 * never be handed a value that poisons the distance metric.
 * @param {number} v raw parameter
 * @returns {number} clamped value
 */
function clamp11(v) {
  if (v > 1) return 1;
  if (v < -1) return -1;
  return v === v ? v : 0;
}

/**
 * Distance from `v` to the closed interval `[lo, hi]` (0 when inside).
 * @param {number} v value
 * @param {number} lo interval minimum
 * @param {number} hi interval maximum
 * @returns {number} non-negative distance
 */
function intervalDist(v, lo, hi) {
  if (v < lo) return lo - v;
  if (v > hi) return v - hi;
  return 0;
}

/**
 * Nearest climate box in weighted 6D parameter space; ties go to the biome
 * with the tighter (more specific) box.
 * @param {number} c continentalness
 * @param {number} e erosion
 * @param {number} t temperature
 * @param {number} h humidity
 * @param {number} w weirdness
 * @param {number} d depth
 * @param {boolean} allowSurface consider surface biomes
 * @param {boolean} allowCave consider cave biomes
 * @returns {number} biome id (never `undefined`)
 */
function nearestBiome(c, e, t, h, w, d, allowSurface, allowCave) {
  let best = 0;
  let bestDist = Infinity;
  const box = CLIMATE_BOX;
  for (let i = 0; i < BIOME_COUNT; i++) {
    if (SCANNABLE[i] === 0) continue;
    if (IS_CAVE[i] === 1) {
      if (!allowCave) continue;
    } else if (!allowSurface) {
      continue;
    }
    const o = i * 12;
    let a = intervalDist(c, box[o], box[o + 1]) * W_CONT;
    let sum = a * a;
    if (sum >= bestDist) continue;
    a = intervalDist(e, box[o + 2], box[o + 3]) * W_EROS;
    sum += a * a;
    if (sum >= bestDist) continue;
    a = intervalDist(t, box[o + 4], box[o + 5]) * W_TEMP;
    sum += a * a;
    if (sum >= bestDist) continue;
    a = intervalDist(h, box[o + 6], box[o + 7]) * W_HUMI;
    sum += a * a;
    if (sum >= bestDist) continue;
    a = intervalDist(w, box[o + 8], box[o + 9]) * W_WEIRD;
    sum += a * a;
    if (sum >= bestDist) continue;
    a = intervalDist(d, box[o + 10], box[o + 11]) * W_DEPTH;
    sum += a * a + SPECIFICITY[i];
    if (sum < bestDist) {
      bestDist = sum;
      best = i;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Look up a biome definition. Always returns a definition — an out-of-range or
 * non-numeric id falls back to `plains` (id 0), so callers never see
 * `undefined`.
 * @param {number} id biome id
 * @returns {BiomeDef} biome definition
 */
export function getBiome(id) {
  const b = BIOMES[id | 0];
  return b !== undefined ? b : BIOMES[0];
}

/**
 * Look up a biome by its snake_case name.
 * @param {string} name biome name
 * @returns {BiomeDef} biome definition (`plains` when unknown)
 */
export function getBiomeByName(name) {
  const id = BIOME_INDEX.get(name);
  return id === undefined ? BIOMES[0] : BIOMES[id];
}

/**
 * Map a point in climate space onto a biome id.
 *
 * All six parameters live in `[-1, 1]` and are clamped defensively:
 *
 * - `continentalness` — `-1` abyssal plain, `-0.455` deep ocean edge,
 *   `-0.19` shoreline, `+1` deep inland.
 * - `erosion` — `-1` mountainous / uneroded, `+1` flat and eroded.
 * - `temperature` — `-1` polar, `+1` tropical.
 * - `humidity` — `-1` arid, `+1` rainforest.
 * - `weirdness` — the ridge/variant axis; `|weirdness|` near 0 carves rivers.
 * - `depth` — `0` at the terrain surface, positive going down (`>= 0.72`
 *   selects a cave biome), negative above the surface.
 *
 * Resolution order: cave depth, then the ocean/coast/river bands from
 * continentalness, then the nearest climate box.
 *
 * Deterministic, allocation-free and total — it always returns a valid id.
 *
 * @param {number} continentalness landmass parameter
 * @param {number} erosion terrain flatness parameter
 * @param {number} temperature climate temperature
 * @param {number} humidity climate humidity
 * @param {number} weirdness variant / river parameter
 * @param {number} depth distance below the surface
 * @returns {number} biome id in `[0, BIOME_COUNT)`
 */
export function selectBiome(continentalness, erosion, temperature, humidity, weirdness, depth) {
  const c = clamp11(continentalness);
  const e = clamp11(erosion);
  const t = clamp11(temperature);
  const h = clamp11(humidity);
  const w = clamp11(weirdness);
  const d = clamp11(depth);

  // 1. Well below the surface: cave biomes only.
  if (d >= DEPTH_CAVE_ONLY) {
    return nearestBiome(c, e, t, h, w, d, false, true);
  }

  // 2. Ocean bands, driven purely by continentalness + temperature.
  if (c < CONT_OCEAN) {
    if (w >= WEIRD_MUSHROOM_ISLAND && c > CONT_DEEP_OCEAN) {
      return BIOME_ID.MUSHROOM_FIELDS;
    }
    if (t < CLIMATE_FREEZING) return BIOME_ID.FROZEN_OCEAN;
    if (c < CONT_DEEP_OCEAN) return BIOME_ID.DEEP_OCEAN;
    if (t < -0.15) return BIOME_ID.COLD_OCEAN;
    if (t < 0.25) return BIOME_ID.OCEAN;
    if (t < 0.6) return BIOME_ID.LUKEWARM_OCEAN;
    return BIOME_ID.WARM_OCEAN;
  }

  // 3. Coastline: beach, snowy beach or stony shore.
  if (c < CONT_COAST) {
    if (e < EROSION_STONY_SHORE) return BIOME_ID.STONY_SHORE;
    if (t < CLIMATE_FREEZING) return BIOME_ID.SNOWY_BEACH;
    return BIOME_ID.BEACH;
  }

  // 4. River channel: |weirdness| near zero on non-mountainous land.
  if (w > -RIVER_HALF_WIDTH && w < RIVER_HALF_WIDTH && e > -0.4 && d < 0.35) {
    return t < CLIMATE_FREEZING ? BIOME_ID.FROZEN_RIVER : BIOME_ID.RIVER;
  }

  // 5. Everything else: nearest climate box.
  return nearestBiome(c, e, t, h, w, d, true, d >= DEPTH_CAVE_START);
}

/**
 * Linear grass tint for a biome.
 * @param {number} id biome id
 * @returns {Float32Array} shared linear rgb triple — do not mutate
 */
export function biomeGrassColor(id) {
  return getBiome(id).grassColor;
}

/**
 * Linear leaf/foliage tint for a biome.
 * @param {number} id biome id
 * @returns {Float32Array} shared linear rgb triple — do not mutate
 */
export function biomeFoliageColor(id) {
  return getBiome(id).foliageColor;
}

/**
 * Linear water tint for a biome (multiplied onto the water surface and used
 * for the underwater fog colour).
 * @param {number} id biome id
 * @returns {Float32Array} shared linear rgb triple — do not mutate
 */
export function biomeWaterColor(id) {
  return getBiome(id).waterColor;
}

/**
 * Linear distance-fog colour for a biome.
 * @param {number} id biome id
 * @returns {Float32Array} shared linear rgb triple — do not mutate
 */
export function biomeFogColor(id) {
  return getBiome(id).fogColor;
}

/**
 * Linear sky tint for a biome; the sky pass multiplies its scattering result
 * by this so deserts get a hazier, deep-dark an almost black sky.
 * @param {number} id biome id
 * @returns {Float32Array} shared linear rgb triple — do not mutate
 */
export function biomeSkyTint(id) {
  return getBiome(id).skyTint;
}

/** Temperature drop per block above sea level (vanilla-style lapse rate). */
const TEMP_LAPSE = 0.0016666666666666668;
/** Height at which the lapse rate starts to bite. */
const TEMP_LAPSE_BASE = 64;
/** Slight warming per block below y=0, capped at 128 blocks. */
const TEMP_CAVE_WARMING = 0.0009;

/**
 * Effective temperature of a biome at a given altitude. Air cools with height
 * and warms slightly deep underground, which is what decides rain vs. snow and
 * whether exposed water freezes.
 *
 * The scale matches `BiomeDef.temperature`: below `0.15` water freezes and
 * precipitation falls as snow.
 *
 * @param {number} id biome id
 * @param {number} y world Y coordinate
 * @returns {number} temperature, clamped to `[-1, 2]`
 */
export function biomeTemperatureAt(id, y) {
  const b = getBiome(id);
  let t = b.temperature;
  if (y > TEMP_LAPSE_BASE) {
    t -= (y - TEMP_LAPSE_BASE) * TEMP_LAPSE;
  } else if (y < 0) {
    const below = y < -128 ? 128 : -y;
    t += below * TEMP_CAVE_WARMING;
  }
  if (t < -1) return -1;
  if (t > 2) return 2;
  return t;
}

/**
 * Precipitation a biome actually produces at a given altitude — a rainy biome
 * turns snowy high enough up.
 * @param {number} id biome id
 * @param {number} y world Y coordinate
 * @returns {'none'|'rain'|'snow'} weather kind
 */
export function biomePrecipitationAt(id, y) {
  const b = getBiome(id);
  if (b.precipitation === 'none') return 'none';
  return biomeTemperatureAt(id, y) < 0.15 ? 'snow' : 'rain';
}

/**
 * True when the biome is any kind of ocean.
 * @param {number} id biome id
 * @returns {boolean} whether the biome is oceanic
 */
export function isOceanBiome(id) {
  return getBiome(id).category === 'ocean';
}

/**
 * True when the biome is a river or frozen river.
 * @param {number} id biome id
 * @returns {boolean} whether the biome is a river
 */
export function isRiverBiome(id) {
  return getBiome(id).category === 'river';
}

/**
 * True when the biome is a beach, snowy beach or stony shore.
 * @param {number} id biome id
 * @returns {boolean} whether the biome is a shoreline
 */
export function isBeachBiome(id) {
  return getBiome(id).category === 'beach';
}

/**
 * True when the biome is an underground biome.
 * @param {number} id biome id
 * @returns {boolean} whether the biome is a cave biome
 */
export function isCaveBiome(id) {
  return getBiome(id).category === 'cave';
}

/**
 * Pick a tree archetype for a biome. Weighting is expressed by repetition in
 * `treeTypes`, so a uniform draw already respects it.
 * @param {number} id biome id
 * @param {() => number} rng random source returning `[0, 1)`
 * @returns {string|null} a `placeTree` type, or `null` when the biome is treeless
 */
export function pickTreeType(id, rng) {
  const list = getBiome(id).treeTypes;
  const n = list.length;
  if (n === 0) return null;
  const i = (rng() * n) | 0;
  return list[i < n ? i : n - 1];
}

/**
 * Pick a flower block name for a biome.
 * @param {number} id biome id
 * @param {() => number} rng random source returning `[0, 1)`
 * @returns {string|null} block name, or `null` when the biome grows no flowers
 */
export function pickFlowerType(id, rng) {
  const list = getBiome(id).flowerTypes;
  const n = list.length;
  if (n === 0) return null;
  const i = (rng() * n) | 0;
  return list[i < n ? i : n - 1];
}

/**
 * Pick a ground-cover plant block name for a biome.
 * @param {number} id biome id
 * @param {() => number} rng random source returning `[0, 1)`
 * @returns {string|null} block name, or `null` when the biome has no ground cover
 */
export function pickGrassType(id, rng) {
  const list = getBiome(id).grassTypes;
  const n = list.length;
  if (n === 0) return null;
  const i = (rng() * n) | 0;
  return list[i < n ? i : n - 1];
}

/**
 * Collect the spawn entries of a biome, optionally filtered by category.
 * Pass an `out` array to keep the call allocation-free.
 * @param {number} id biome id
 * @param {string|null} [category] spawn group, or `null`/omitted for all
 * @param {MobSpawn[]} [out] destination array (cleared before filling)
 * @returns {MobSpawn[]} the filled array
 */
export function biomeMobs(id, category = null, out = []) {
  out.length = 0;
  const list = getBiome(id).mobs;
  for (let i = 0; i < list.length; i++) {
    if (category === null || list[i].group === category) out.push(list[i]);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Block-name resolution                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Turn whatever `blocks.js` hands us into a plain `(name) => id` function.
 * Accepts: a function, a `Map<string, BlockDef|number>`, a plain object of
 * `{ name: id }`, or the whole `blocks.js` module namespace.
 * @param {*} src resolver source
 * @returns {((name: string) => number)|null} normalised lookup
 */
function normalizeLookup(src) {
  if (!src) return null;
  if (typeof src === 'function') {
    return (name) => {
      const v = src(name);
      if (typeof v === 'number') return v;
      if (v && typeof v.id === 'number') return v.id;
      return -1;
    };
  }
  if (src instanceof Map) {
    return (name) => {
      const v = src.get(name);
      if (typeof v === 'number') return v;
      if (v && typeof v.id === 'number') return v.id;
      return -1;
    };
  }
  if (typeof src === 'object') {
    // Module namespace: prefer BLOCK_BY_NAME, then blockByName(), then B.
    if (src.BLOCK_BY_NAME) return normalizeLookup(src.BLOCK_BY_NAME);
    if (typeof src.blockByName === 'function') return normalizeLookup(src.blockByName);
    return (name) => {
      const v = src[name];
      if (typeof v === 'number') return v;
      if (v && typeof v.id === 'number') return v.id;
      return -1;
    };
  }
  return null;
}

/**
 * Install the block-name resolver used by the lazy `*.surfaceBlockId` getters.
 * Cached ids are invalidated, so it is safe to call more than once (for
 * example after a datapack-style block registry rebuild).
 * @param {((name: string) => number)|Map<string, *>|Object} lookup resolver
 * @returns {boolean} `true` when a usable resolver was installed
 */
export function setBlockResolver(lookup) {
  const fn = normalizeLookup(lookup);
  if (fn === null) return false;
  blockLookup = fn;
  resolveEpoch++;
  warnedNoResolver = false;
  return true;
}

/**
 * Eagerly resolve every biome's block names into numeric block ids.
 *
 * Call this **once at startup**, before any chunk is generated. Two ways:
 *
 * ```js
 * import { BLOCK_BY_NAME } from './blocks.js';
 * resolveBiomeBlocks(BLOCK_BY_NAME);          // synchronous, preferred
 * await resolveBiomeBlocks();                 // dynamic-imports blocks.js
 * ```
 *
 * The argument-less form exists so this module never has to statically import
 * `blocks.js` (that keeps the two files free of any import cycle); it returns
 * a promise because the dynamic import is asynchronous.
 *
 * @param {((name: string) => number)|Map<string, *>|Object} [lookup]
 *   name -> id resolver, a `Map` such as `BLOCK_BY_NAME`, or the `blocks.js`
 *   module namespace. Omit to have this function import `blocks.js` itself.
 * @returns {number|Promise<number>} number of biomes resolved — a plain number
 *   when a resolver was supplied (or already installed), a promise otherwise
 */
export function resolveBiomeBlocks(lookup) {
  if (lookup !== undefined && lookup !== null) {
    if (!setBlockResolver(lookup)) {
      warnOnce('[biomes] resolveBiomeBlocks() got an unusable lookup; ignoring it');
    }
  }
  if (blockLookup !== null) {
    return resolveAllBiomeBlocks();
  }
  return import('./blocks.js').then((mod) => {
    setBlockResolver(mod);
    return resolveAllBiomeBlocks();
  });
}

/**
 * Force every biome to resolve and cache its three block ids.
 * @returns {number} number of biomes resolved
 */
function resolveAllBiomeBlocks() {
  for (let i = 0; i < BIOME_COUNT; i++) {
    const b = BIOMES[i];
    b._idEpoch = -1;
    biomeBlockId(b, 0);
  }
  return BIOME_COUNT;
}

/**
 * Whether `resolveBiomeBlocks()` / `setBlockResolver()` has run successfully.
 * @returns {boolean} `true` once block ids are available
 */
export function biomeBlocksResolved() {
  return blockLookup !== null;
}

/**
 * Resolved surface block id of a biome.
 * @param {number} id biome id
 * @returns {number} block id (0 before resolution)
 */
export function biomeSurfaceBlock(id) {
  return biomeBlockId(getBiome(id), 0);
}

/**
 * Resolved sub-surface block id of a biome.
 * @param {number} id biome id
 * @returns {number} block id (0 before resolution)
 */
export function biomeSubSurfaceBlock(id) {
  return biomeBlockId(getBiome(id), 1);
}

/**
 * Resolved underwater block id of a biome.
 * @param {number} id biome id
 * @returns {number} block id (0 before resolution)
 */
export function biomeUnderwaterBlock(id) {
  return biomeBlockId(getBiome(id), 2);
}
