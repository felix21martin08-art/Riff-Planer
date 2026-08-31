/**
 * @file game/mobs.js — VOXELIA mob definitions, AI, A* pathfinding and spawning
 * (spec 5.35).
 *
 * Three things live here, in this order:
 *
 *  1. {@link MOB_TYPES} — the data table. Everything a creature *is* (model,
 *     hitbox, health, speed, loot, spawn rules, breeding) is data, so balancing
 *     never means touching code.
 *  2. {@link pathfind} — a real A* over the voxel grid with a binary-heap open
 *     set ({@link PriorityQueue}), an octile heuristic, capability-aware
 *     neighbour expansion (step-up / fall / swim / climb, plus width and height
 *     clearance so a 2-block-tall mob refuses a 1-block gap), a hard node
 *     budget and line-of-sight path smoothing.
 *  3. {@link Mob} + {@link MobAI} — behaviour objects with
 *     `canStart / canContinue / start / tick / stop`, evaluated highest-priority
 *     first every tick. No monolithic switch: a creeper is a creeper because it
 *     owns {@link CreeperFuseBehavior}, not because of an `if (type === ...)`.
 *  4. {@link MobSpawner} — the pack-based spawn algorithm with light, biome,
 *     surface and per-category cap checks, plus despawning.
 *
 * Conventions (binding, see ARCHITECTURE.md):
 *  - Game logic ticks at a fixed 20 TPS. Everything here takes `dt` in seconds
 *    and integrates with it; nothing is tied to the frame rate.
 *  - Right handed, Y up. A mob's `position` is the **centre of its footprint at
 *    foot height** — `aabb.minY === position[1]`.
 *  - Speeds are blocks/second, timers are seconds unless the name ends in
 *    `Ticks`.
 *  - Nothing in a tick throws: every entry point is guarded, failures are
 *    logged once via {@link warnOnce} and the mob degrades to standing still.
 *  - Hot paths reuse module scratch state and never allocate.
 *
 * Integration contract — the `ctx` object the Game hands to `Mob#update`:
 * ```js
 * { world, player, entities, environment, audio, particles, combat, difficulty }
 * ```
 * Every field is optional and read defensively; a missing subsystem only
 * removes the feature that needs it.
 */

import { AABB, clamp, damp, lerp, mulberry32 } from '../core/math.js';
import { PriorityQueue } from '../core/util.js';
import {
  B, BLOCK_COUNT, blockAABBs, isLiquid, isSolid
} from '../world/blocks.js';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_MAX_Y, WORLD_MIN_Y } from '../world/chunk.js';
import { getBiome } from '../world/biomes.js';
import { itemIdByName } from './items.js';
import { ItemStack } from './inventory.js';
import { Entity, ArrowEntity } from './entities.js';
import {
  GRAVITY, TERMINAL_VELOCITY, createMoveResult, isInLiquid, moveWithCollisions
} from './physics.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Fixed simulation rate of the game loop, in ticks per second. @type {number} */
export const TICK_RATE = 20;

/** Length of one game tick in seconds. @type {number} */
export const TICK_SECONDS = 1 / TICK_RATE;

/**
 * Spawn categories. Every entry in {@link MOB_TYPES} belongs to exactly one,
 * and each category has its own population cap and despawn rule.
 * @type {Readonly<Object<string, string>>}
 */
export const SPAWN_CATEGORY = Object.freeze({
  HOSTILE: 'hostile',
  PASSIVE: 'passive',
  AMBIENT: 'ambient',
  WATER: 'water',
});

/**
 * Base population caps per player, before the loaded-chunk scaling in
 * {@link MobSpawner#getMobCap}.
 * @type {Readonly<Object<string, number>>}
 */
export const MOB_CAPS = Object.freeze({
  hostile: 70,
  passive: 10,
  ambient: 15,
  water: 5,
});

/**
 * The biome mob tables in `world/biomes.js` use their own group names; this maps
 * them onto {@link SPAWN_CATEGORY}.
 * @type {Readonly<Object<string, string>>}
 */
export const BIOME_GROUP_CATEGORY = Object.freeze({
  monster: 'hostile',
  creature: 'passive',
  ambient: 'ambient',
  water_creature: 'water',
  water_ambient: 'water',
});

/** Closest a mob may spawn to the player, in blocks. @type {number} */
export const SPAWN_MIN_DISTANCE = 24;

/** Farthest a mob may spawn from the player, in blocks. @type {number} */
export const SPAWN_MAX_DISTANCE = 128;

/** Beyond this distance a hostile mob is removed immediately. @type {number} */
export const DESPAWN_HARD_DISTANCE = 128;

/** Beyond this distance a hostile mob may despawn randomly. @type {number} */
export const DESPAWN_SOFT_DISTANCE = 32;

/** Chance per despawn pass that a soft-range hostile vanishes. @type {number} */
export const DESPAWN_SOFT_CHANCE = 1 / 40;

/** Seconds between spawn attempts. @type {number} */
export const SPAWN_INTERVAL = 0.4;

/** Seconds between despawn sweeps. @type {number} */
export const DESPAWN_INTERVAL = 1.0;

/** Default A* node budget — a hard stop so pathing can never stall a tick. @type {number} */
export const DEFAULT_PATH_BUDGET = 2000;

/** Largest horizontal deviation from the path start A* will consider. @type {number} */
export const PATH_MAX_RANGE = 96;

/** Seconds a mob keeps a target it can no longer see. @type {number} */
export const TARGET_MEMORY = 4.0;

/**
 * Build the name of a mob sound event. `audio.play(mobSound('zombie','hurt'))`.
 * Kinds: `idle`, `hurt`, `death`, `step`, `attack`, `special`.
 * @param {string} type mob type name
 * @param {string} kind sound kind
 * @returns {string} the event name understood by `game/audio.js`
 */
export function mobSound(type, kind) {
  return `mob.${type}.${kind}`;
}

/* ========================================================================== */
/* Small utilities                                                            */
/* ========================================================================== */

/** Guard rail so a broken subsystem logs once, not once per tick. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a message exactly once per key.
 * @param {string} key dedupe key
 * @param {string} msg message
 * @param {*} [err] optional error object
 * @returns {void}
 */
function warnOnce(key, msg, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err !== undefined) console.warn(`[VOXELIA] mobs: ${msg}`, err);
  else console.warn(`[VOXELIA] mobs: ${msg}`);
}

/**
 * Coerce anything to a finite number.
 * @param {*} v candidate
 * @param {number} fallback replacement for non-finite input
 * @returns {number} a finite number
 */
function finite(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Shortest signed difference between two angles, in `(-PI, PI]`.
 * @param {number} a radians
 * @returns {number} wrapped radians
 */
function wrapAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/**
 * Squared horizontal distance between two `[x,y,z]` positions.
 * @param {ArrayLike<number>} a first position
 * @param {ArrayLike<number>} b second position
 * @returns {number} squared distance on the XZ plane
 */
function distSqXZ(a, b) {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return dx * dx + dz * dz;
}

/**
 * Squared distance between two `[x,y,z]` positions.
 * @param {ArrayLike<number>} a first position
 * @param {ArrayLike<number>} b second position
 * @returns {number} squared distance
 */
function distSq3(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/* ========================================================================== */
/* Block classification tables                                                */
/* ========================================================================== */

/**
 * Per block id: `1` when a mob's body fits inside the voxel. Non-solid blocks
 * never collide (`World#getCollisionAABBs` skips them), and solid blocks whose
 * collision shape stays at or below half a block are stepped over rather than
 * walked around (slabs, snow layers, carpets, closed trapdoors, lanterns).
 * @type {Uint8Array}
 */
const BLOCK_PASSABLE = new Uint8Array(BLOCK_COUNT);

/**
 * Per block id: `1` when a mob can stand on top of the voxel.
 * @type {Uint8Array}
 */
const BLOCK_FLOOR = new Uint8Array(BLOCK_COUNT);

/**
 * Per block id: `1` for voxels that hurt whatever walks into them.
 * @type {Uint8Array}
 */
const BLOCK_DANGER = new Uint8Array(BLOCK_COUNT);

/**
 * Per block id: `1` for ladders, vines and scaffolding.
 * @type {Uint8Array}
 */
const BLOCK_CLIMB = new Uint8Array(BLOCK_COUNT);

/**
 * Fill the block classification tables from the real collision shapes. Runs
 * once at module load, so the pathfinder never calls `blockAABBs` again.
 * @returns {void}
 */
function buildBlockTables() {
  for (let id = 0; id < BLOCK_COUNT; id++) {
    let passable = true;
    let floor = false;
    try {
      const solid = isSolid(id);
      if (solid) {
        const boxes = blockAABBs(id, 0);
        floor = boxes.length > 0;
        let maxY = 0;
        for (let i = 0; i < boxes.length; i++) {
          if (boxes[i][4] > maxY) maxY = boxes[i][4];
        }
        passable = maxY <= 0.5 + 1e-6;
      }
    } catch (e) {
      warnOnce('blocktable', 'could not classify a block shape; assuming solid', e);
      passable = false;
      floor = true;
    }
    BLOCK_PASSABLE[id] = passable ? 1 : 0;
    BLOCK_FLOOR[id] = floor ? 1 : 0;
  }
  BLOCK_PASSABLE[0] = 1;
  BLOCK_FLOOR[0] = 0;
  for (const name of ['LAVA', 'CACTUS', 'MAGMA_BLOCK', 'CAMPFIRE', 'SWEET_BERRY_BUSH']) {
    const id = B[name];
    if (id !== undefined) BLOCK_DANGER[id] = 1;
  }
  for (const name of ['LADDER', 'VINE', 'SCAFFOLDING']) {
    const id = B[name];
    if (id !== undefined) {
      BLOCK_CLIMB[id] = 1;
      BLOCK_PASSABLE[id] = 1;
    }
  }
}
buildBlockTables();

/** Water block id, resolved once. @type {number} */
const ID_WATER = B.WATER === undefined ? -1 : B.WATER;

/** Lava block id, resolved once. @type {number} */
const ID_LAVA = B.LAVA === undefined ? -1 : B.LAVA;

/** Door block ids a mob with `canOpenDoors` may walk through. @type {Set<number>} */
const DOOR_IDS = new Set();
for (const name of ['OAK_DOOR', 'OAK_FENCE_GATE']) {
  const id = B[name];
  if (id !== undefined) DOOR_IDS.add(id);
}

/** Blocks a sheep will eat to regrow its wool. @type {Set<number>} */
const GRASS_IDS = new Set();
for (const name of ['GRASS_BLOCK', 'SHORT_GRASS', 'TALL_GRASS', 'FERN']) {
  const id = B[name];
  if (id !== undefined) GRASS_IDS.add(id);
}

/**
 * Blocks an enderman is willing to pick up and carry around.
 * @type {number[]}
 */
const ENDERMAN_CARRIABLE = [];
for (const name of ['GRASS_BLOCK', 'DIRT', 'SAND', 'RED_SAND', 'GRAVEL', 'CLAY',
  'PODZOL', 'MYCELIUM', 'COARSE_DIRT', 'POPPY', 'DANDELION', 'BROWN_MUSHROOM',
  'RED_MUSHROOM', 'CACTUS', 'MELON', 'PUMPKIN', 'TNT']) {
  const id = B[name];
  if (id !== undefined) ENDERMAN_CARRIABLE.push(id);
}

/** The sixteen wool block names, indexed by sheep colour. @type {string[]} */
const WOOL_BLOCK_NAMES = [
  'WHITE_WOOL', 'ORANGE_WOOL', 'MAGENTA_WOOL', 'LIGHT_BLUE_WOOL', 'YELLOW_WOOL',
  'LIME_WOOL', 'PINK_WOOL', 'GRAY_WOOL', 'LIGHT_GRAY_WOOL', 'CYAN_WOOL',
  'PURPLE_WOOL', 'BLUE_WOOL', 'BROWN_WOOL', 'GREEN_WOOL', 'RED_WOOL', 'BLACK_WOOL',
];

/** The sixteen wool item names, indexed by sheep colour. @type {string[]} */
const WOOL_ITEM_NAMES = WOOL_BLOCK_NAMES.map((n) => n.toLowerCase());

/**
 * Natural sheep colour weights — mostly white, a little grey, rarely brown/pink.
 * @type {Array<{color:number, weight:number}>}
 */
const SHEEP_COLOR_WEIGHTS = [
  { color: 0, weight: 818 },
  { color: 7, weight: 50 },
  { color: 8, weight: 50 },
  { color: 15, weight: 50 },
  { color: 12, weight: 30 },
  { color: 6, weight: 2 },
];

/* ========================================================================== */
/* Item helpers                                                               */
/* ========================================================================== */

/** Item-name -> item-id cache, so loot rolls never hit the registry twice. @type {Map<string, number>} */
const ITEM_ID_CACHE = new Map();

/**
 * Resolve an item name to its id, cached. Unknown names resolve to `0`.
 * @param {string} name snake_case item name
 * @returns {number} item id, `0` when unknown
 */
function itemId(name) {
  let id = ITEM_ID_CACHE.get(name);
  if (id === undefined) {
    try {
      id = itemIdByName(name) | 0;
    } catch (e) {
      warnOnce('itemid', 'item registry unavailable; loot disabled', e);
      id = 0;
    }
    if (id === 0) warnOnce(`item:${name}`, `unknown loot item "${name}" skipped`);
    ITEM_ID_CACHE.set(name, id);
  }
  return id;
}

/**
 * Declare one loot-table row.
 * @param {string} item snake_case item name
 * @param {number} [min=1] minimum count
 * @param {number} [max=1] maximum count (inclusive)
 * @param {number} [chance=1] probability the row rolls at all, 0..1
 * @param {{fire?:boolean, playerOnly?:boolean, looting?:number}} [opts] extras:
 *   `fire` swaps in the cooked variant when the mob burned to death,
 *   `playerOnly` restricts the drop to player kills, `looting` is the extra
 *   maximum per level of the Looting enchantment.
 * @returns {{item:string, min:number, max:number, chance:number, fire:boolean,
 *   playerOnly:boolean, looting:number}} the loot row
 */
function loot(item, min = 1, max = 1, chance = 1, opts = {}) {
  return {
    item,
    min: min | 0,
    max: max | 0,
    chance,
    fire: opts.fire === true,
    playerOnly: opts.playerOnly === true,
    looting: opts.looting === undefined ? 0 : opts.looting,
  };
}

/* ========================================================================== */
/* MOB_TYPES                                                                  */
/* ========================================================================== */

/**
 * @typedef {Object} MobDef
 * @property {string} name type key, also the `entity.type` the renderer keys on
 * @property {string} display German display name shown in the HUD and on death
 * @property {string} model `ENTITY_VISUALS` key in `render/entities.js`
 * @property {number} width hitbox width and depth in blocks
 * @property {number} height hitbox height in blocks
 * @property {number} eyeHeight eye height above the feet, in blocks
 * @property {number} health maximum health in half-hearts
 * @property {number} armor natural armour points
 * @property {number} speed ground speed in blocks/second
 * @property {number} attackDamage melee damage in half-hearts
 * @property {number} attackReach melee reach in blocks, measured centre to centre
 * @property {number} attackCooldown seconds between melee swings
 * @property {number} knockback knockback this mob deals, as a multiplier
 * @property {number} knockbackResistance 0 = flung freely, 1 = immovable
 * @property {number} followRange how far the mob notices a target, in blocks
 * @property {number} xp experience dropped on death
 * @property {Array<Object>} loot loot table rows built by {@link loot}
 * @property {string} category one of {@link SPAWN_CATEGORY}
 * @property {?string[]} biomes biome names this mob may spawn in, `null` = any
 * @property {number[]} light inclusive `[min,max]` effective light for spawning
 * @property {'ground'|'water'|'air'} placement where a spawn position must be
 * @property {?boolean} surface `true` = needs sky access, `false` = cave only,
 *   `null` = either
 * @property {number[]} spawnY inclusive `[min,max]` world Y band for spawning
 * @property {number[]} packSize inclusive `[min,max]` mobs per spawn attempt
 * @property {boolean} burnsInDaylight catches fire in direct sunlight
 * @property {boolean} undead counts as undead for damage and sun logic
 * @property {boolean} arthropod counts as an arthropod (Bane of Arthropods)
 * @property {boolean} hostile attacks the player on sight
 * @property {boolean} neutral only retaliates, or is conditionally hostile
 * @property {boolean} despawns whether the despawn sweep may remove it
 * @property {boolean} aquatic lives in water and suffocates in air
 * @property {boolean} flying ignores gravity and flies
 * @property {boolean} avoidsWater refuses to path into water
 * @property {boolean} canSwim can cross water while pathing
 * @property {boolean} canClimb climbs vertical walls
 * @property {boolean} canOpenDoors treats doors as passable and opens them
 * @property {boolean} tameable can be tamed
 * @property {?string[]} tameFood items that tame it
 * @property {boolean} breedable can be bred
 * @property {?string[]} breedFood items that start love mode
 * @property {boolean} shearable can be sheared
 * @property {boolean} baby whether this definition is itself a baby variant
 * @property {number} babyScale hitbox and model scale of the baby
 * @property {number} growUpSeconds seconds a baby needs to become an adult
 * @property {number} stepHeight auto-step height in blocks
 * @property {number} floatSpeed upward speed in water, in blocks/second
 * @property {number} gravityScale gravity multiplier
 * @property {number} maxFall blocks the mob will path down in one drop
 * @property {number} sunAvoid `1` when the mob actively seeks shade at dawn
 */

/**
 * Fill in every {@link MobDef} default so the table below only states what is
 * special about a creature.
 * @param {string} name type key
 * @param {Object} o partial definition
 * @returns {MobDef} the completed, frozen definition
 */
function defineMob(name, o) {
  const category = o.category || SPAWN_CATEGORY.PASSIVE;
  const hostile = o.hostile === undefined ? category === SPAWN_CATEGORY.HOSTILE : o.hostile;
  const height = finite(o.height, 1.8);
  const def = {
    name,
    display: o.display || name,
    model: o.model || name,
    width: finite(o.width, 0.6),
    height,
    eyeHeight: finite(o.eyeHeight, height * 0.85),
    health: finite(o.health, 10),
    armor: finite(o.armor, 0),
    speed: finite(o.speed, 1.9),
    attackDamage: finite(o.attackDamage, 0),
    attackReach: finite(o.attackReach, 1.0 + finite(o.width, 0.6) * 0.5),
    attackCooldown: finite(o.attackCooldown, 1.0),
    knockback: finite(o.knockback, 1),
    knockbackResistance: clamp(finite(o.knockbackResistance, 0), 0, 1),
    followRange: finite(o.followRange, 16),
    xp: finite(o.xp, 0),
    loot: Object.freeze(o.loot || []),
    category,
    biomes: o.biomes ? Object.freeze(o.biomes.slice()) : null,
    light: Object.freeze(o.light ? o.light.slice(0, 2) : [0, 15]),
    placement: o.placement || 'ground',
    surface: o.surface === undefined ? null : o.surface,
    spawnY: Object.freeze(o.spawnY ? o.spawnY.slice(0, 2) : [WORLD_MIN_Y + 1, WORLD_MAX_Y - 1]),
    packSize: Object.freeze(o.packSize ? o.packSize.slice(0, 2) : [1, 4]),
    burnsInDaylight: o.burnsInDaylight === true,
    undead: o.undead === true,
    arthropod: o.arthropod === true,
    hostile,
    neutral: o.neutral === true,
    despawns: o.despawns === undefined ? category === SPAWN_CATEGORY.HOSTILE
      || category === SPAWN_CATEGORY.AMBIENT || category === SPAWN_CATEGORY.WATER : o.despawns,
    aquatic: o.aquatic === true,
    flying: o.flying === true,
    avoidsWater: o.avoidsWater === undefined ? !(o.aquatic === true || o.canSwim === true) : o.avoidsWater,
    canSwim: o.canSwim === true || o.aquatic === true,
    canClimb: o.canClimb === true,
    canOpenDoors: o.canOpenDoors === true,
    tameable: o.tameable === true,
    tameFood: o.tameFood ? Object.freeze(o.tameFood.slice()) : null,
    breedable: o.breedable === true,
    breedFood: o.breedFood ? Object.freeze(o.breedFood.slice()) : null,
    shearable: o.shearable === true,
    baby: o.baby === true,
    babyScale: finite(o.babyScale, 0.5),
    growUpSeconds: finite(o.growUpSeconds, 1200),
    stepHeight: finite(o.stepHeight, height >= 1.2 ? 0.6 : 0.55),
    floatSpeed: finite(o.floatSpeed, 3.0),
    gravityScale: finite(o.gravityScale, 1),
    maxFall: finite(o.maxFall, 3),
    sunAvoid: finite(o.sunAvoid, o.burnsInDaylight === true ? 1 : 0),
  };
  return Object.freeze(def);
}

/** Biome name lists reused by several definitions. @type {string[]} */
const OVERWORLD_LAND = [
  'plains', 'sunflower_plains', 'forest', 'flower_forest', 'birch_forest',
  'dark_forest', 'taiga', 'old_growth_pine_taiga', 'snowy_taiga', 'snowy_plains',
  'ice_spikes', 'mountains', 'snowy_slopes', 'grove', 'jagged_peaks',
  'frozen_peaks', 'stony_peaks', 'meadow', 'savanna', 'savanna_plateau',
  'desert', 'badlands', 'wooded_badlands', 'eroded_badlands', 'jungle',
  'bamboo_jungle', 'swamp', 'mangrove_swamp', 'beach', 'snowy_beach',
  'stony_shore', 'river', 'frozen_river', 'mushroom_fields', 'cherry_grove',
  'lush_caves', 'dripstone_caves', 'deep_dark',
];

/** Grassy biomes where farm animals appear. @type {string[]} */
const FARM_BIOMES = [
  'plains', 'sunflower_plains', 'forest', 'flower_forest', 'birch_forest',
  'dark_forest', 'taiga', 'old_growth_pine_taiga', 'snowy_taiga', 'meadow',
  'savanna', 'savanna_plateau', 'jungle', 'bamboo_jungle', 'swamp',
  'mangrove_swamp', 'cherry_grove', 'mountains',
];

/** Every ocean and river biome. @type {string[]} */
const WATER_BIOMES = [
  'ocean', 'deep_ocean', 'cold_ocean', 'lukewarm_ocean', 'warm_ocean',
  'frozen_ocean', 'river', 'frozen_river', 'lush_caves', 'mangrove_swamp',
];

/**
 * The complete creature table. Keys are the entity `type` strings, which are
 * also the keys of `ENTITY_VISUALS` in `render/entities.js` — that is what
 * makes a spawned {@link Mob} draw itself with the right model and skin.
 * @type {Readonly<Object<string, MobDef>>}
 */
export const MOB_TYPES = Object.freeze({

  /* ------------------------------------------------------------- hostile */

  zombie: defineMob('zombie', {
    display: 'Zombie', model: 'zombie',
    width: 0.6, height: 1.95, eyeHeight: 1.74,
    health: 20, armor: 2, speed: 1.85, attackDamage: 3, attackReach: 1.6,
    attackCooldown: 1.0, knockbackResistance: 0, followRange: 35, xp: 5,
    category: SPAWN_CATEGORY.HOSTILE, undead: true, burnsInDaylight: true,
    canOpenDoors: true, canSwim: true, light: [0, 7], packSize: [2, 4],
    biomes: OVERWORLD_LAND, growUpSeconds: 1200,
    loot: [
      loot('rotten_flesh', 0, 2, 1, { looting: 1 }),
      loot('iron_ingot', 1, 1, 0.025),
      loot('carrot', 1, 1, 0.025),
      loot('potato', 1, 1, 0.025),
    ],
  }),

  husk: defineMob('husk', {
    display: 'Wüstenzombie', model: 'husk',
    width: 0.6, height: 1.95, eyeHeight: 1.74,
    health: 20, armor: 2, speed: 1.85, attackDamage: 3, attackReach: 1.6,
    attackCooldown: 1.0, followRange: 35, xp: 5,
    category: SPAWN_CATEGORY.HOSTILE, undead: true, burnsInDaylight: false,
    canOpenDoors: true, canSwim: true, light: [0, 7], packSize: [2, 4],
    surface: true, biomes: ['desert', 'badlands', 'wooded_badlands', 'eroded_badlands'],
    loot: [
      loot('rotten_flesh', 0, 2, 1, { looting: 1 }),
      loot('sand', 0, 1, 0.1),
    ],
  }),

  drowned: defineMob('drowned', {
    display: 'Ertrunkener', model: 'drowned',
    width: 0.6, height: 1.95, eyeHeight: 1.74,
    health: 20, armor: 2, speed: 1.7, attackDamage: 3, attackReach: 1.6,
    attackCooldown: 1.0, followRange: 35, xp: 5,
    category: SPAWN_CATEGORY.HOSTILE, undead: true, burnsInDaylight: true,
    canSwim: true, avoidsWater: false, aquatic: false, light: [0, 7],
    packSize: [1, 3], placement: 'water', biomes: WATER_BIOMES,
    spawnY: [WORLD_MIN_Y + 1, SEA_LEVEL + 2],
    loot: [
      loot('rotten_flesh', 0, 2, 1, { looting: 1 }),
      loot('copper_ingot', 1, 1, 0.11),
      loot('cod', 1, 1, 0.05),
    ],
  }),

  skeleton: defineMob('skeleton', {
    display: 'Skelett', model: 'skeleton',
    width: 0.6, height: 1.99, eyeHeight: 1.74,
    health: 20, armor: 2, speed: 2.0, attackDamage: 2, attackReach: 1.6,
    attackCooldown: 1.0, followRange: 32, xp: 5,
    category: SPAWN_CATEGORY.HOSTILE, undead: true, burnsInDaylight: true,
    canSwim: true, light: [0, 7], packSize: [2, 4], biomes: OVERWORLD_LAND,
    loot: [
      loot('bone', 0, 2, 1, { looting: 1 }),
      loot('arrow', 0, 2, 1, { looting: 1 }),
    ],
  }),

  creeper: defineMob('creeper', {
    display: 'Creeper', model: 'creeper',
    width: 0.6, height: 1.7, eyeHeight: 1.45,
    health: 20, speed: 1.8, attackDamage: 0, attackReach: 3.0,
    followRange: 24, xp: 5,
    category: SPAWN_CATEGORY.HOSTILE, canSwim: true, light: [0, 7],
    packSize: [2, 4], biomes: OVERWORLD_LAND,
    loot: [
      loot('gunpowder', 0, 2, 1, { looting: 1 }),
    ],
  }),

  spider: defineMob('spider', {
    display: 'Spinne', model: 'spider',
    width: 1.4, height: 0.9, eyeHeight: 0.65,
    health: 16, speed: 2.6, attackDamage: 2, attackReach: 1.6,
    attackCooldown: 1.0, followRange: 24, xp: 5,
    category: SPAWN_CATEGORY.HOSTILE, arthropod: true, neutral: true,
    canClimb: true, canSwim: true, light: [0, 7], packSize: [2, 4],
    biomes: OVERWORLD_LAND, stepHeight: 0.6, maxFall: 6,
    loot: [
      loot('string', 0, 2, 1, { looting: 1 }),
      loot('spider_eye', 0, 1, 0.33, { playerOnly: true, looting: 1 }),
    ],
  }),

  enderman: defineMob('enderman', {
    display: 'Enderman', model: 'enderman',
    width: 0.6, height: 2.9, eyeHeight: 2.55,
    health: 40, speed: 2.9, attackDamage: 7, attackReach: 2.0,
    attackCooldown: 1.0, knockbackResistance: 0.2, followRange: 64, xp: 5,
    category: SPAWN_CATEGORY.HOSTILE, neutral: true, avoidsWater: true,
    light: [0, 7], packSize: [1, 2], biomes: OVERWORLD_LAND, maxFall: 12,
    loot: [
      loot('ender_pearl', 0, 1, 0.5, { looting: 1 }),
    ],
  }),

  witch: defineMob('witch', {
    display: 'Hexe', model: 'witch',
    width: 0.6, height: 1.95, eyeHeight: 1.62,
    health: 26, speed: 1.7, attackDamage: 3, attackReach: 1.6,
    attackCooldown: 3.0, followRange: 24, xp: 5,
    category: SPAWN_CATEGORY.HOSTILE, canSwim: true, light: [0, 7],
    packSize: [1, 1], biomes: OVERWORLD_LAND,
    loot: [
      loot('glass_bottle', 0, 2, 1, { looting: 1 }),
      loot('glowstone_dust', 0, 2, 0.5),
      loot('gunpowder', 0, 2, 0.5),
      loot('redstone', 0, 2, 0.5),
      loot('spider_eye', 0, 2, 0.4),
      loot('stick', 0, 2, 0.4),
      loot('sugar', 0, 2, 0.4),
    ],
  }),

  slime: defineMob('slime', {
    display: 'Schleim', model: 'slime',
    width: 1.02, height: 1.02, eyeHeight: 0.7,
    health: 4, speed: 1.4, attackDamage: 2, attackReach: 1.4,
    attackCooldown: 1.0, followRange: 16, xp: 2,
    category: SPAWN_CATEGORY.HOSTILE, canSwim: true, light: [0, 7],
    packSize: [2, 4], biomes: ['swamp', 'mangrove_swamp'],
    spawnY: [WORLD_MIN_Y + 1, 40], maxFall: 8,
    loot: [
      loot('slimeball', 0, 2, 1, { looting: 1 }),
    ],
  }),

  /* ------------------------------------------------------------- passive */

  pig: defineMob('pig', {
    display: 'Schwein', model: 'pig',
    width: 0.9, height: 0.9, eyeHeight: 0.76,
    health: 10, speed: 1.5, followRange: 16, xp: 1,
    category: SPAWN_CATEGORY.PASSIVE, canSwim: true, light: [9, 15],
    surface: true, packSize: [2, 4], biomes: FARM_BIOMES,
    breedable: true, breedFood: ['carrot', 'potato', 'beetroot'],
    loot: [
      loot('porkchop', 1, 3, 1, { fire: true, looting: 1 }),
    ],
  }),

  cow: defineMob('cow', {
    display: 'Kuh', model: 'cow',
    width: 0.9, height: 1.4, eyeHeight: 1.3,
    health: 10, speed: 1.4, followRange: 16, xp: 1,
    category: SPAWN_CATEGORY.PASSIVE, canSwim: true, light: [9, 15],
    surface: true, packSize: [2, 4], biomes: FARM_BIOMES,
    breedable: true, breedFood: ['wheat'],
    loot: [
      loot('beef', 1, 3, 1, { fire: true, looting: 1 }),
      loot('leather', 0, 2, 1, { looting: 1 }),
    ],
  }),

  sheep: defineMob('sheep', {
    display: 'Schaf', model: 'sheep',
    width: 0.9, height: 1.3, eyeHeight: 1.2,
    health: 8, speed: 1.5, followRange: 16, xp: 1,
    category: SPAWN_CATEGORY.PASSIVE, canSwim: true, light: [9, 15],
    surface: true, packSize: [2, 4], biomes: FARM_BIOMES,
    breedable: true, breedFood: ['wheat'], shearable: true,
    loot: [
      loot('mutton', 1, 2, 1, { fire: true, looting: 1 }),
    ],
  }),

  chicken: defineMob('chicken', {
    display: 'Huhn', model: 'chicken',
    width: 0.4, height: 0.7, eyeHeight: 0.64,
    health: 4, speed: 1.6, followRange: 16, xp: 1,
    category: SPAWN_CATEGORY.PASSIVE, canSwim: true, light: [9, 15],
    surface: true, packSize: [2, 4], biomes: FARM_BIOMES,
    breedable: true, breedFood: ['wheat_seeds', 'pumpkin_seeds', 'melon_seeds', 'beetroot_seeds'],
    gravityScale: 0.35, maxFall: 16, stepHeight: 0.55,
    loot: [
      loot('chicken', 1, 1, 1, { fire: true, looting: 1 }),
      loot('feather', 0, 2, 1, { looting: 1 }),
    ],
  }),

  wolf: defineMob('wolf', {
    display: 'Wolf', model: 'wolf',
    width: 0.6, height: 0.85, eyeHeight: 0.76,
    health: 8, speed: 3.4, attackDamage: 3, attackReach: 1.4,
    attackCooldown: 1.0, followRange: 24, xp: 1,
    category: SPAWN_CATEGORY.PASSIVE, neutral: true, canSwim: true,
    light: [9, 15], surface: true, packSize: [2, 4],
    biomes: ['forest', 'taiga', 'old_growth_pine_taiga', 'snowy_taiga', 'grove'],
    tameable: true, tameFood: ['bone'],
    breedable: true, breedFood: ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit'],
    loot: [],
  }),

  cat: defineMob('cat', {
    display: 'Katze', model: 'cat',
    width: 0.6, height: 0.7, eyeHeight: 0.6,
    health: 10, speed: 3.2, attackDamage: 2, attackReach: 1.2,
    attackCooldown: 1.0, followRange: 16, xp: 1,
    category: SPAWN_CATEGORY.PASSIVE, canSwim: true, light: [9, 15],
    surface: true, packSize: [1, 2], biomes: FARM_BIOMES,
    tameable: true, tameFood: ['cod', 'salmon'],
    breedable: true, breedFood: ['cod', 'salmon'], maxFall: 6,
    loot: [
      loot('string', 0, 2, 0.5),
    ],
  }),

  horse: defineMob('horse', {
    display: 'Pferd', model: 'horse',
    width: 1.4, height: 1.6, eyeHeight: 1.5,
    health: 22, speed: 4.4, followRange: 16, xp: 1,
    category: SPAWN_CATEGORY.PASSIVE, canSwim: true, light: [9, 15],
    surface: true, packSize: [2, 6],
    biomes: ['plains', 'sunflower_plains', 'savanna', 'savanna_plateau', 'meadow'],
    tameable: true, tameFood: ['sugar', 'apple', 'golden_carrot'],
    breedable: true, breedFood: ['golden_carrot', 'golden_apple', 'wheat', 'hay_block'],
    knockbackResistance: 0.2,
    loot: [
      loot('leather', 0, 2, 1, { looting: 1 }),
    ],
  }),

  villager: defineMob('villager', {
    display: 'Dorfbewohner', model: 'villager',
    width: 0.6, height: 1.95, eyeHeight: 1.62,
    health: 20, speed: 1.7, followRange: 16, xp: 0,
    category: SPAWN_CATEGORY.PASSIVE, canSwim: true, canOpenDoors: true,
    light: [0, 15], surface: null, packSize: [1, 1], biomes: null,
    despawns: false, breedable: true, breedFood: ['bread', 'carrot', 'potato', 'beetroot'],
    loot: [],
  }),

  iron_golem: defineMob('iron_golem', {
    display: 'Eisengolem', model: 'iron_golem',
    width: 1.4, height: 2.7, eyeHeight: 2.4,
    health: 100, armor: 6, speed: 1.9, attackDamage: 12, attackReach: 2.4,
    attackCooldown: 1.0, knockback: 3.4, knockbackResistance: 1,
    followRange: 32, xp: 0,
    category: SPAWN_CATEGORY.PASSIVE, neutral: true, canSwim: false,
    avoidsWater: true, light: [0, 15], packSize: [1, 1], biomes: null,
    despawns: false, stepHeight: 1.0,
    loot: [
      loot('iron_ingot', 3, 5, 1),
      loot('poppy', 0, 2, 1),
    ],
  }),

  fox: defineMob('fox', {
    display: 'Fuchs', model: 'fox',
    width: 0.6, height: 0.7, eyeHeight: 0.55,
    health: 10, speed: 3.0, attackDamage: 2, attackReach: 1.2,
    attackCooldown: 1.0, followRange: 16, xp: 1,
    category: SPAWN_CATEGORY.PASSIVE, canSwim: true, light: [0, 15],
    surface: true, packSize: [2, 4],
    biomes: ['taiga', 'old_growth_pine_taiga', 'snowy_taiga', 'grove'],
    breedable: true, breedFood: ['sweet_berries', 'glow_berries'], maxFall: 6,
    loot: [],
  }),

  rabbit: defineMob('rabbit', {
    display: 'Kaninchen', model: 'rabbit',
    width: 0.4, height: 0.5, eyeHeight: 0.42,
    health: 3, speed: 3.0, followRange: 12, xp: 1,
    category: SPAWN_CATEGORY.PASSIVE, canSwim: true, light: [9, 15],
    surface: true, packSize: [2, 3],
    biomes: ['desert', 'snowy_plains', 'ice_spikes', 'flower_forest', 'taiga',
      'meadow', 'grove', 'snowy_slopes'],
    breedable: true, breedFood: ['carrot', 'golden_carrot', 'dandelion'],
    maxFall: 6, stepHeight: 0.55,
    loot: [
      loot('rabbit', 0, 1, 1, { fire: true, looting: 1 }),
      loot('rabbit_hide', 0, 1, 1, { looting: 1 }),
    ],
  }),

  /* ------------------------------------------------------------- ambient */

  bat: defineMob('bat', {
    display: 'Fledermaus', model: 'bat',
    width: 0.5, height: 0.9, eyeHeight: 0.6,
    health: 6, speed: 2.6, followRange: 16, xp: 0,
    category: SPAWN_CATEGORY.AMBIENT, flying: true, gravityScale: 0,
    light: [0, 4], surface: false, packSize: [4, 8],
    spawnY: [WORLD_MIN_Y + 1, 63], biomes: OVERWORLD_LAND, maxFall: 32,
    loot: [],
  }),

  /* --------------------------------------------------------------- water */

  squid: defineMob('squid', {
    display: 'Tintenfisch', model: 'squid',
    width: 0.8, height: 0.8, eyeHeight: 0.4,
    health: 10, speed: 1.6, followRange: 16, xp: 1,
    category: SPAWN_CATEGORY.WATER, aquatic: true, gravityScale: 0,
    placement: 'water', light: [0, 15], packSize: [2, 4],
    spawnY: [SEA_LEVEL - 24, SEA_LEVEL], biomes: WATER_BIOMES,
    loot: [
      loot('ink_sac', 1, 3, 1, { looting: 1 }),
    ],
  }),
});

/** Every mob type name, in table order. @type {ReadonlyArray<string>} */
export const MOB_NAMES = Object.freeze(Object.keys(MOB_TYPES));

/**
 * Look up a mob definition by name.
 * @param {string} name mob type name
 * @returns {?MobDef} the definition, or `null` when unknown
 */
export function getMobType(name) {
  const def = MOB_TYPES[name];
  return def === undefined ? null : def;
}

/**
 * Whether a mob type exists in {@link MOB_TYPES}.
 * @param {string} name mob type name
 * @returns {boolean} `true` when known
 */
export function isKnownMob(name) {
  return MOB_TYPES[name] !== undefined;
}

/**
 * Whether a mob definition may naturally spawn in a biome.
 * @param {MobDef} def mob definition
 * @param {string} biomeName snake_case biome name
 * @returns {boolean} `true` when the biome is allowed
 */
export function canSpawnInBiome(def, biomeName) {
  if (!def) return false;
  if (def.biomes === null) return true;
  return def.biomes.indexOf(biomeName) >= 0;
}
