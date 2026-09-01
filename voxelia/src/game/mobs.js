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

import { AABB, clamp, damp, mulberry32 } from '../core/math.js';
import { PriorityQueue, nowMs } from '../core/util.js';
import { B, BLOCK_COUNT, blockAABBs, isSolid } from '../world/blocks.js';
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
 * Milliseconds of A* every 50 ms tick, summed over **all** mobs in the world.
 *
 * The per-search node budget bounds one path; this bounds the whole population,
 * so a thousand mobs asking for a route in the same tick cost the same as ten.
 * A mob that arrives after the budget is spent keeps walking its old path and
 * asks again next tick.
 * @type {number}
 */
export const PATH_TIME_BUDGET_MS = 2.0;

/** Start of the current pathfinding budget window, in `performance.now()` ms. @type {number} */
let PATH_WINDOW_START = 0;

/** Milliseconds of A* already spent in the current window. @type {number} */
let PATH_TIME_USED = 0;

/**
 * Whether there is pathfinding time left in this tick's budget.
 * @returns {boolean} `true` when a mob may run A* right now
 */
function pathBudgetAvailable() {
  const now = nowMs();
  if (now - PATH_WINDOW_START >= 50 || now < PATH_WINDOW_START) {
    PATH_WINDOW_START = now;
    PATH_TIME_USED = 0;
  }
  return PATH_TIME_USED < PATH_TIME_BUDGET_MS;
}

/**
 * How much of the world-wide pathfinding budget is still free, as a fraction.
 * Exposed for the F3 overlay.
 * @returns {number} `0` when the budget is exhausted, `1` when untouched
 */
export function pathBudgetRemaining() {
  return clamp(1 - PATH_TIME_USED / PATH_TIME_BUDGET_MS, 0, 1);
}

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

/* ========================================================================== */
/* Pathfinding                                                                */
/* ========================================================================== */

/**
 * @typedef {Object} PathCaps
 * @property {number} width footprint width in blocks
 * @property {number} height body height in blocks
 * @property {number} maxStepUp how many blocks the mob climbs in one step
 * @property {number} maxFall how many blocks the mob will drop in one move
 * @property {boolean} canSwim may traverse water
 * @property {boolean} canClimb may climb ladders, vines and sheer walls
 * @property {boolean} canOpenDoors treats doors as passable
 * @property {boolean} avoidWater adds a cost penalty to water nodes
 * @property {boolean} avoidDanger refuses lava, cactus, magma and campfires
 * @property {boolean} flying ignores floors entirely and paths through the air
 * @property {boolean} aquatic paths only through water
 * @property {number} maxRange horizontal search radius around the start
 */

/**
 * Defaults for {@link pathfind}. A humanoid-sized walker.
 * @type {Readonly<PathCaps>}
 */
export const DEFAULT_PATH_CAPS = Object.freeze({
  width: 0.6,
  height: 1.8,
  maxStepUp: 1,
  maxFall: 3,
  canSwim: false,
  canClimb: false,
  canOpenDoors: false,
  avoidWater: true,
  avoidDanger: true,
  flying: false,
  aquatic: false,
  maxRange: PATH_MAX_RANGE,
});

/** Reusable, normalised capability record — {@link pathfind} is not reentrant. @type {Object} */
const _caps = {
  cells: 1, heightCells: 2, maxStepUp: 1, maxFall: 3,
  canSwim: false, canClimb: false, canOpenDoors: false,
  avoidWater: true, avoidDanger: true, flying: false, aquatic: false,
  maxRange: PATH_MAX_RANGE,
};

/**
 * Normalise a caller's capability object into the module scratch record.
 * @param {?Object} caps partial {@link PathCaps}
 * @returns {Object} the shared normalised record
 */
function normaliseCaps(caps) {
  const c = caps || DEFAULT_PATH_CAPS;
  const width = finite(c.width, DEFAULT_PATH_CAPS.width);
  const height = finite(c.height, DEFAULT_PATH_CAPS.height);
  _caps.cells = clamp(Math.ceil(width - 0.05), 1, 3);
  _caps.heightCells = clamp(Math.ceil(height - 0.05), 1, 4);
  _caps.maxStepUp = clamp(Math.round(finite(c.maxStepUp, 1)), 0, 3);
  _caps.maxFall = clamp(Math.round(finite(c.maxFall, 3)), 0, 32);
  _caps.canSwim = c.canSwim === true;
  _caps.canClimb = c.canClimb === true;
  _caps.canOpenDoors = c.canOpenDoors === true;
  _caps.avoidWater = c.avoidWater !== false;
  _caps.avoidDanger = c.avoidDanger !== false;
  _caps.flying = c.flying === true;
  _caps.aquatic = c.aquatic === true;
  _caps.maxRange = clamp(finite(c.maxRange, PATH_MAX_RANGE), 4, 256);
  return _caps;
}

/**
 * Candidate footprint anchors for a given footprint size. A 2-wide mob fits in
 * any of the four 2x2 placements that contain its node, so a corridor only has
 * to be 2 wide somewhere — not centred on the node.
 * @param {number} cells footprint size in blocks, 1..3
 * @returns {number[]} flattened `[ax, az]` anchor offsets
 */
function footprintAnchors(cells) {
  if (cells <= 1) return ANCHORS_1;
  if (cells === 2) return ANCHORS_2;
  return ANCHORS_3;
}

/** Anchor offsets for a 1-wide footprint. @type {number[]} */
const ANCHORS_1 = [0, 0];
/** Anchor offsets for a 2-wide footprint. @type {number[]} */
const ANCHORS_2 = [0, 0, -1, 0, 0, -1, -1, -1];
/** Anchor offsets for a 3-wide footprint. @type {number[]} */
const ANCHORS_3 = [-1, -1];

/**
 * Whether a mob's body fits inside one voxel.
 * @param {Object} world world with `getBlock`
 * @param {number} x world X
 * @param {number} y world Y
 * @param {number} z world Z
 * @param {Object} caps normalised capabilities
 * @returns {boolean} `true` when the voxel does not block the body
 */
function cellPassable(world, x, y, z, caps) {
  if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return false;
  const id = world.getBlock(x, y, z);
  if (id === 0) return true;
  if (id === ID_LAVA) return false;
  if (id === ID_WATER) return caps.canSwim || caps.aquatic || caps.flying;
  if (caps.avoidDanger && BLOCK_DANGER[id] === 1) return false;
  if (BLOCK_PASSABLE[id] === 1) return true;
  if (caps.canOpenDoors && DOOR_IDS.has(id)) return true;
  return false;
}

/**
 * Whether the whole body clears a node — every footprint column, over the full
 * body height. This is what stops a 2-block-tall mob from pathing through a
 * 1-block gap.
 * @param {Object} world world with `getBlock`
 * @param {number} x node X
 * @param {number} y node Y (feet)
 * @param {number} z node Z
 * @param {Object} caps normalised capabilities
 * @returns {boolean} `true` when at least one footprint placement fits
 */
function hasClearance(world, x, y, z, caps) {
  const cells = caps.cells;
  const h = caps.heightCells;
  if (y < WORLD_MIN_Y || y + h > WORLD_MAX_Y) return false;
  const anchors = footprintAnchors(cells);
  for (let a = 0; a < anchors.length; a += 2) {
    const ax = x + anchors[a];
    const az = z + anchors[a + 1];
    let ok = true;
    for (let dz = 0; dz < cells && ok; dz++) {
      for (let dx = 0; dx < cells && ok; dx++) {
        for (let dy = 0; dy < h; dy++) {
          if (!cellPassable(world, ax + dx, y + dy, az + dz, caps)) { ok = false; break; }
        }
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Whether a mob can hold position at a node: standing on a floor, floating in
 * water, hanging on a climbable block, or simply airborne when it flies.
 * @param {Object} world world with `getBlock`
 * @param {number} x node X
 * @param {number} y node Y (feet)
 * @param {number} z node Z
 * @param {Object} caps normalised capabilities
 * @returns {boolean} `true` when the node supports the mob
 */
function isStandable(world, x, y, z, caps) {
  if (caps.flying) return true;
  const here = world.getBlock(x, y, z);
  if (here === ID_WATER) return caps.canSwim || caps.aquatic;
  if (caps.aquatic) return false;
  if (BLOCK_CLIMB[here] === 1 && caps.canClimb) return true;
  if (y - 1 < WORLD_MIN_Y) return false;
  const below = world.getBlock(x, y - 1, z);
  if (below === ID_WATER) return caps.canSwim;
  if (below === ID_LAVA) return false;
  if (caps.avoidDanger && BLOCK_DANGER[below] === 1) return false;
  return BLOCK_FLOOR[below] === 1;
}

/**
 * Extra cost of standing on a node — water is slow, danger is lethal.
 * @param {Object} world world with `getBlock`
 * @param {number} x node X
 * @param {number} y node Y
 * @param {number} z node Z
 * @param {Object} caps normalised capabilities
 * @returns {number} added cost, in node units
 */
function nodePenalty(world, x, y, z, caps) {
  const id = world.getBlock(x, y, z);
  let cost = 0;
  if (id === ID_WATER && caps.avoidWater && !caps.aquatic) cost += 6;
  if (BLOCK_DANGER[id] === 1) cost += 24;
  if (id !== 0 && BLOCK_PASSABLE[id] === 1 && BLOCK_FLOOR[id] === 1) cost += 0.2;
  if (caps.canOpenDoors && DOOR_IDS.has(id)) cost += 2;
  return cost;
}

/** Horizontal neighbour offsets: four cardinals then four diagonals. @type {number[]} */
const NEIGHBOR_DIRS = [
  1, 0, -1, 0, 0, 1, 0, -1,
  1, 1, 1, -1, -1, 1, -1, -1,
];

/** Pooled A* node records, reused across every {@link pathfind} call. @type {Object[]} */
const _nodePool = [];

/** Node key -> index into {@link _nodePool} for the current search. @type {Map<number, number>} */
const _nodeIndex = new Map();

/** The open set of the current search. @type {PriorityQueue} */
const _open = new PriorityQueue();

/** Raw reconstructed path before smoothing. @type {Array<number[]>} */
const _rawPath = [];

/** Reusable coordinate triples handed back to callers. @type {Array<number[]>} */
const _pathPool = [];

/**
 * Pack a node's coordinates into a unique non-negative integer key, relative to
 * the search origin so the key always fits in 30 bits.
 * @param {number} ox origin X
 * @param {number} oz origin Z
 * @param {number} x node X
 * @param {number} y node Y
 * @param {number} z node Z
 * @returns {number} the key, or `-1` when the node is out of range
 */
function nodeKey(ox, oz, x, y, z) {
  const dx = x - ox + 512;
  const dz = z - oz + 512;
  const dy = y - WORLD_MIN_Y;
  if (dx < 0 || dx > 1023 || dz < 0 || dz > 1023 || dy < 0 || dy > 511) return -1;
  return (dx * 1024 + dz) * 512 + dy;
}

/**
 * Fetch (or create) the pooled record for a node key.
 * @param {number} key packed node key
 * @param {number} x node X
 * @param {number} y node Y
 * @param {number} z node Z
 * @param {number} count current live node count
 * @returns {Object} the node record
 */
function acquireNode(key, x, y, z, count) {
  let rec = _nodePool[count];
  if (rec === undefined) {
    rec = { key: 0, x: 0, y: 0, z: 0, g: 0, h: 0, f: 0, parent: -1, closed: false };
    _nodePool[count] = rec;
  }
  rec.key = key;
  rec.x = x;
  rec.y = y;
  rec.z = z;
  rec.g = Infinity;
  rec.h = 0;
  rec.f = Infinity;
  rec.parent = -1;
  rec.closed = false;
  _nodeIndex.set(key, count);
  return rec;
}

/**
 * Octile distance heuristic: exact for 8-way movement on a plane, plus the
 * vertical difference. Admissible, so A* stays optimal.
 * @param {number} x node X
 * @param {number} y node Y
 * @param {number} z node Z
 * @param {number} gx goal X
 * @param {number} gy goal Y
 * @param {number} gz goal Z
 * @returns {number} estimated remaining cost
 */
function octile(x, y, z, gx, gy, gz) {
  const dx = Math.abs(x - gx);
  const dz = Math.abs(z - gz);
  const dy = Math.abs(y - gy);
  const lo = dx < dz ? dx : dz;
  return (dx + dz) + (Math.SQRT2 - 2) * lo + dy;
}

/**
 * Snap a requested goal onto a node the mob could actually occupy, by scanning
 * a few blocks up and down for standing room.
 * @param {Object} world world with `getBlock`
 * @param {number} gx goal X
 * @param {number} gy goal Y
 * @param {number} gz goal Z
 * @param {Object} caps normalised capabilities
 * @returns {number} the resolved goal Y, or `gy` when nothing fits
 */
function resolveGoalY(world, gx, gy, gz, caps) {
  if (hasClearance(world, gx, gy, gz, caps) && isStandable(world, gx, gy, gz, caps)) return gy;
  for (let d = 1; d <= 4; d++) {
    const up = gy + d;
    if (hasClearance(world, gx, up, gz, caps) && isStandable(world, gx, up, gz, caps)) return up;
    const down = gy - d;
    if (hasClearance(world, gx, down, gz, caps) && isStandable(world, gx, down, gz, caps)) return down;
  }
  return gy;
}

/**
 * Decide where a horizontal move actually lands: step up, stay level, or fall.
 * Writes the landing Y into {@link _landing} and returns the extra cost, or
 * `-1` when the move is impossible.
 * @param {Object} world world with `getBlock`
 * @param {number} x source X
 * @param {number} y source Y
 * @param {number} z source Z
 * @param {number} nx target X
 * @param {number} nz target Z
 * @param {Object} caps normalised capabilities
 * @returns {number} extra cost, or `-1` when blocked
 */
function resolveLanding(world, x, y, z, nx, nz, caps) {
  // 1. Step up (highest first) — needs headroom above the source too.
  for (let up = caps.maxStepUp; up >= 1; up--) {
    const ny = y + up;
    if (!hasClearance(world, x, ny, z, caps)) continue;
    if (!hasClearance(world, nx, ny, nz, caps)) continue;
    if (!isStandable(world, nx, ny, nz, caps)) continue;
    _landing[0] = ny;
    return 0.6 * up;
  }
  // 2. Level.
  if (hasClearance(world, nx, y, nz, caps)) {
    if (isStandable(world, nx, y, nz, caps)) {
      _landing[0] = y;
      return 0;
    }
    // 3. Fall — the column has to be free the whole way down.
    if (!caps.flying && !caps.aquatic) {
      for (let d = 1; d <= caps.maxFall; d++) {
        const ny = y - d;
        if (!hasClearance(world, nx, ny, nz, caps)) break;
        if (isStandable(world, nx, ny, nz, caps)) {
          _landing[0] = ny;
          return 0.35 * d;
        }
      }
    }
  }
  return -1;
}

/** Scratch landing height written by {@link resolveLanding}. @type {Int32Array} */
const _landing = new Int32Array(1);

/**
 * Whether a mob can walk in a straight line from one node to another, used by
 * the path smoother to delete redundant waypoints.
 * @param {Object} world world with `getBlock`
 * @param {number[]} a start node `[x,y,z]`
 * @param {number[]} b end node `[x,y,z]`
 * @param {Object} caps normalised capabilities
 * @returns {boolean} `true` when the straight segment is walkable
 */
function canWalkStraight(world, a, b, caps) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const span = Math.max(Math.abs(dx), Math.abs(dz));
  if (span === 0) return Math.abs(dy) <= Math.max(caps.maxStepUp, caps.maxFall);
  const steps = span * 3;
  let prevX = a[0];
  let prevY = a[1];
  let prevZ = a[2];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.round(a[0] + dx * t);
    const cz = Math.round(a[2] + dz * t);
    const cy = Math.round(a[1] + dy * t);
    if (cx === prevX && cy === prevY && cz === prevZ) continue;
    if (!hasClearance(world, cx, cy, cz, caps)) return false;
    if (!isStandable(world, cx, cy, cz, caps)) return false;
    const step = cy - prevY;
    if (step > caps.maxStepUp || -step > caps.maxFall) return false;
    // No diagonal corner cutting: both orthogonal cells must be clear too.
    if (cx !== prevX && cz !== prevZ) {
      if (!hasClearance(world, cx, cy, prevZ, caps) && !hasClearance(world, prevX, cy, cz, caps)) {
        return false;
      }
    }
    prevX = cx;
    prevY = cy;
    prevZ = cz;
  }
  return true;
}

/**
 * Remove redundant waypoints by line-of-sight: keep a waypoint only when the
 * mob cannot reach the next-but-one directly.
 * @param {Object} world world with `getBlock`
 * @param {Array<number[]>} path raw node list, mutated into the result
 * @param {Object} caps normalised capabilities
 * @returns {Array<number[]>} a new, shorter waypoint list
 */
function smoothPath(world, path, caps) {
  const n = path.length;
  if (n <= 2) return path.slice();
  const out = [path[0]];
  let i = 0;
  let guard = 0;
  while (i < n - 1 && guard++ < n * 2) {
    let best = i + 1;
    for (let j = n - 1; j > i + 1; j--) {
      if (canWalkStraight(world, path[i], path[j], caps)) { best = j; break; }
    }
    out.push(path[best]);
    i = best;
  }
  return out;
}

/**
 * A* over the voxel grid.
 *
 * The open set is the binary heap from `core/util.js`; there is no decrease-key,
 * so improved nodes are pushed again and stale pops are skipped by the closed
 * flag — the classic lazy-deletion variant, which is exact.
 *
 * `maxNodes` is a hard expansion budget: when it runs out the search returns
 * the best partial path found so far instead of `null`, so a mob always makes
 * progress and the tick never stalls.
 *
 * @param {Object} world world exposing `getBlock(x, y, z)`
 * @param {ArrayLike<number>} from start position `[x,y,z]` in world coordinates
 * @param {ArrayLike<number>} to goal position `[x,y,z]` in world coordinates
 * @param {number} [maxNodes=2000] maximum number of node expansions
 * @param {?PathCaps} [capabilities] movement capabilities; see {@link DEFAULT_PATH_CAPS}
 * @returns {?Array<number[]>} block-coordinate waypoints `[[x,y,z], ...]`
 *   including the start, or `null` when no route exists at all
 */
export function pathfind(world, from, to, maxNodes = DEFAULT_PATH_BUDGET, capabilities = null) {
  if (!world || typeof world.getBlock !== 'function' || !from || !to) return null;
  const caps = normaliseCaps(capabilities);

  const sx = Math.floor(finite(from[0], 0));
  const sy = Math.floor(finite(from[1], 0));
  const sz = Math.floor(finite(from[2], 0));
  let gx = Math.floor(finite(to[0], 0));
  let gy = Math.floor(finite(to[1], 0));
  let gz = Math.floor(finite(to[2], 0));

  if (Math.abs(gx - sx) > caps.maxRange || Math.abs(gz - sz) > caps.maxRange) return null;
  gy = resolveGoalY(world, gx, gy, gz, caps);

  const budget = clamp(Math.round(finite(maxNodes, DEFAULT_PATH_BUDGET)), 16, 20000);

  _nodeIndex.clear();
  _open.clear();
  let count = 0;

  const startKey = nodeKey(sx, sz, sx, sy, sz);
  if (startKey < 0) return null;
  const start = acquireNode(startKey, sx, sy, sz, count++);
  start.g = 0;
  start.h = octile(sx, sy, sz, gx, gy, gz);
  start.f = start.h;
  _open.push(0, start.f);

  let bestIndex = 0;
  let bestH = start.h;
  let goalIndex = -1;
  let expansions = 0;

  while (_open.size > 0 && expansions < budget) {
    const currentIndex = _open.pop();
    const current = _nodePool[currentIndex];
    if (current === undefined || current.closed) continue;
    current.closed = true;
    expansions++;

    if (current.x === gx && current.y === gy && current.z === gz) {
      goalIndex = currentIndex;
      break;
    }
    if (current.h < bestH) {
      bestH = current.h;
      bestIndex = currentIndex;
    }

    const cx = current.x;
    const cy = current.y;
    const cz = current.z;

    for (let d = 0; d < NEIGHBOR_DIRS.length; d += 2) {
      const ox = NEIGHBOR_DIRS[d];
      const oz = NEIGHBOR_DIRS[d + 1];
      const nx = cx + ox;
      const nz = cz + oz;
      if (Math.abs(nx - sx) > caps.maxRange || Math.abs(nz - sz) > caps.maxRange) continue;

      const diagonal = ox !== 0 && oz !== 0;
      if (diagonal) {
        // Never cut a corner: both orthogonal cells must be clear at this level.
        if (!hasClearance(world, cx + ox, cy, cz, caps)) continue;
        if (!hasClearance(world, cx, cy, cz + oz, caps)) continue;
      }

      const extra = resolveLanding(world, cx, cy, cz, nx, nz, caps);
      if (extra < 0) continue;
      const ny = _landing[0];

      const key = nodeKey(sx, sz, nx, ny, nz);
      if (key < 0) continue;

      const base = diagonal ? Math.SQRT2 : 1;
      const g = current.g + base + extra + nodePenalty(world, nx, ny, nz, caps);

      let idx = _nodeIndex.get(key);
      let node;
      if (idx === undefined) {
        if (count >= budget * 4) continue;
        idx = count++;
        node = acquireNode(key, nx, ny, nz, idx);
      } else {
        node = _nodePool[idx];
        if (node.closed || g >= node.g) continue;
      }
      node.g = g;
      node.h = octile(nx, ny, nz, gx, gy, gz);
      node.f = g + node.h;
      node.parent = currentIndex;
      _open.push(idx, node.f);
    }

    // Vertical moves: climbing and swimming are the only way to change Y in
    // place, and both need explicit permission.
    if (caps.canClimb || caps.canSwim || caps.flying || caps.aquatic) {
      for (let s = -1; s <= 1; s += 2) {
        const ny = cy + s;
        if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
        const here = world.getBlock(cx, cy, cz);
        const there = world.getBlock(cx, ny, cz);
        const climbing = caps.canClimb && (BLOCK_CLIMB[here] === 1 || BLOCK_CLIMB[there] === 1);
        const swimming = (caps.canSwim || caps.aquatic)
          && (here === ID_WATER || there === ID_WATER);
        if (!climbing && !swimming && !caps.flying) continue;
        if (!hasClearance(world, cx, ny, cz, caps)) continue;
        if (!caps.flying && !isStandable(world, cx, ny, cz, caps)) continue;

        const key = nodeKey(sx, sz, cx, ny, cz);
        if (key < 0) continue;
        const g = current.g + (climbing ? 1.6 : 1.2) + nodePenalty(world, cx, ny, cz, caps);
        let idx = _nodeIndex.get(key);
        let node;
        if (idx === undefined) {
          if (count >= budget * 4) continue;
          idx = count++;
          node = acquireNode(key, cx, ny, cz, idx);
        } else {
          node = _nodePool[idx];
          if (node.closed || g >= node.g) continue;
        }
        node.g = g;
        node.h = octile(cx, ny, cz, gx, gy, gz);
        node.f = g + node.h;
        node.parent = currentIndex;
        _open.push(idx, node.f);
      }
    }
  }

  const endIndex = goalIndex >= 0 ? goalIndex : bestIndex;
  if (endIndex < 0) return null;
  if (endIndex === 0 && goalIndex < 0) return null;

  _rawPath.length = 0;
  let walk = endIndex;
  let guard = 0;
  while (walk >= 0 && guard++ < 4096) {
    const node = _nodePool[walk];
    if (node === undefined) break;
    let slot = _pathPool[_rawPath.length];
    if (slot === undefined) {
      slot = [0, 0, 0];
      _pathPool[_rawPath.length] = slot;
    }
    slot[0] = node.x;
    slot[1] = node.y;
    slot[2] = node.z;
    _rawPath.push(slot);
    walk = node.parent;
  }
  _rawPath.reverse();
  if (_rawPath.length < 2) return null;

  // The pooled triples are recycled by the next search, so hand out copies.
  const smoothed = smoothPath(world, _rawPath, caps);
  const out = new Array(smoothed.length);
  for (let i = 0; i < smoothed.length; i++) {
    out[i] = [smoothed[i][0], smoothed[i][1], smoothed[i][2]];
  }
  return out;
}

/**
 * Turn a {@link MobDef} into the capability record its pathing needs.
 * @param {MobDef} def mob definition
 * @param {number} [scale=1] hitbox scale (babies are smaller)
 * @returns {PathCaps} a fresh capability record
 */
export function pathCapsFor(def, scale = 1) {
  return {
    width: def.width * scale,
    height: def.height * scale,
    maxStepUp: Math.max(1, Math.round(def.stepHeight + 0.4)),
    maxFall: def.maxFall,
    canSwim: def.canSwim,
    canClimb: def.canClimb,
    canOpenDoors: def.canOpenDoors,
    avoidWater: def.avoidsWater,
    avoidDanger: true,
    flying: def.flying,
    aquatic: def.aquatic,
    maxRange: PATH_MAX_RANGE,
  };
}

/* ========================================================================== */
/* Behaviours                                                                 */
/* ========================================================================== */

/**
 * One unit of mob behaviour.
 *
 * The AI keeps a list sorted by {@link Behavior#priority} and re-evaluates it
 * every tick: a higher-priority behaviour whose `canStart` is true always
 * pre-empts the running one, and the running one keeps going while its
 * `canContinue` holds. That is the whole scheduler — behaviours never talk to
 * each other, so they compose freely.
 */
export class Behavior {
  /**
   * @param {string} name stable identifier, also written to `mob.state`
   * @param {number} priority higher wins; see the table in this file's header
   */
  constructor(name, priority) {
    /** @type {string} */
    this.name = name;
    /** @type {number} */
    this.priority = priority;
  }

  /**
   * Whether this behaviour wants to take over right now.
   * @param {Mob} mob the mob
   * @param {Object} ctx the tick context
   * @returns {boolean} `true` to start
   */
  canStart(mob, ctx) { return false; }

  /**
   * Whether a running behaviour may keep running. Defaults to `canStart`.
   * @param {Mob} mob the mob
   * @param {Object} ctx the tick context
   * @returns {boolean} `true` to keep going
   */
  canContinue(mob, ctx) { return this.canStart(mob, ctx); }

  /**
   * Called once when the behaviour becomes active.
   * @param {Mob} mob the mob
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  start(mob, ctx) {}

  /**
   * Called every tick while the behaviour is active.
   * @param {Mob} mob the mob
   * @param {number} dt seconds since the last tick
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  tick(mob, dt, ctx) {}

  /**
   * Called once when the behaviour is replaced or gives up.
   * @param {Mob} mob the mob
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  stop(mob, ctx) {}
}

/**
 * Priority-ordered behaviour scheduler. One instance per mob.
 */
export class MobAI {
  /**
   * @param {Mob} mob the mob this AI drives
   * @param {Behavior[]} behaviors behaviours in any order; sorted here
   */
  constructor(mob, behaviors) {
    /** @type {Mob} */
    this.mob = mob;
    /** @type {Behavior[]} sorted by descending priority */
    this.behaviors = behaviors.slice().sort((a, b) => b.priority - a.priority);
    /** @type {?Behavior} the running behaviour */
    this.current = null;
    /** @type {number} seconds the current behaviour has been running */
    this.elapsed = 0;
  }

  /**
   * Re-evaluate and run one tick of the winning behaviour.
   * @param {number} dt seconds since the last tick
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  update(dt, ctx) {
    const mob = this.mob;
    const list = this.behaviors;
    let next = null;

    if (this.current !== null) {
      // Only strictly higher priorities may pre-empt.
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b === this.current || b.priority <= this.current.priority) break;
        if (b.canStart(mob, ctx)) { next = b; break; }
      }
      if (next === null && !this.current.canContinue(mob, ctx)) {
        this.current.stop(mob, ctx);
        this.current = null;
      }
    }

    if (next === null && this.current === null) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].canStart(mob, ctx)) { next = list[i]; break; }
      }
    }

    if (next !== null && next !== this.current) {
      if (this.current !== null) this.current.stop(mob, ctx);
      this.current = next;
      this.elapsed = 0;
      next.start(mob, ctx);
    }

    // A behaviour may retire itself — or kill the mob — inside its own tick
    // (creeper detonation does), so hold the reference before running it.
    const active = this.current;
    if (active !== null) {
      this.elapsed += dt;
      active.tick(mob, dt, ctx);
      mob.state = active.name;
    } else {
      mob.state = 'idle';
    }
  }

  /**
   * Abort the running behaviour, e.g. on death or teleport.
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  reset(ctx) {
    if (this.current !== null) this.current.stop(this.mob, ctx);
    this.current = null;
    this.elapsed = 0;
  }
}

/* ------------------------------------------------------------------------- */
/* Universal behaviours                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Run blindly away from whatever just hurt us, for a couple of seconds. Every
 * mob has this; hostile mobs simply get a much shorter panic time.
 */
export class PanicOnHurtBehavior extends Behavior {
  /** @param {number} [speedMul=1.5] speed multiplier while panicking */
  constructor(speedMul = 1.5) {
    super('panic', 100);
    /** @type {number} */
    this.speedMul = speedMul;
    /** @type {number} */
    this.repath = 0;
  }

  /** @inheritDoc */
  canStart(mob) { return mob.panicTimer > 0; }

  /** @inheritDoc */
  canContinue(mob) { return mob.panicTimer > 0; }

  /** @inheritDoc */
  start(mob) { this.repath = 0; }

  /** @inheritDoc */
  tick(mob, dt) {
    this.repath -= dt;
    if (this.repath <= 0 || mob.navDone) {
      this.repath = 1.0;
      const src = mob.panicSource;
      let dx;
      let dz;
      if (src !== null && src.position) {
        dx = mob.position[0] - src.position[0];
        dz = mob.position[2] - src.position[2];
      } else {
        dx = mob.random() * 2 - 1;
        dz = mob.random() * 2 - 1;
      }
      const len = Math.hypot(dx, dz) || 1;
      const dist = 8 + mob.random() * 6;
      mob.moveTo(
        mob.position[0] + (dx / len) * dist,
        mob.position[1],
        mob.position[2] + (dz / len) * dist,
        this.speedMul
      );
    }
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Undead in direct sunlight look for the nearest shaded block and hide there.
 * Failing that they at least run away from the sun.
 */
export class AvoidSunBehavior extends Behavior {
  constructor() {
    super('avoid_sun', 96);
    /** @type {number} */
    this.repath = 0;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    if (mob.def.sunAvoid <= 0) return false;
    if (mob.isBaby) return false;
    return mob.isSunlit(ctx);
  }

  /** @inheritDoc */
  canContinue(mob, ctx) { return mob.burningTimer > 0 || this.canStart(mob, ctx); }

  /** @inheritDoc */
  start(mob) { this.repath = 0; }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    this.repath -= dt;
    if (this.repath > 0 && !mob.navDone) return;
    this.repath = 1.5;
    const shade = mob.findShade(12);
    if (shade !== null) {
      mob.moveTo(shade[0] + 0.5, shade[1], shade[2] + 0.5, 1.3);
      return;
    }
    const env = ctx ? ctx.environment : null;
    let dx = mob.random() * 2 - 1;
    let dz = mob.random() * 2 - 1;
    if (env && env.sunDir && env.sunDir.length >= 3) {
      dx = -env.sunDir[0];
      dz = -env.sunDir[2];
    }
    const len = Math.hypot(dx, dz) || 1;
    mob.moveTo(
      mob.position[0] + (dx / len) * 10,
      mob.position[1],
      mob.position[2] + (dz / len) * 10,
      1.3
    );
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Walk to the current target and hit it whenever the cooldown allows.
 */
export class MeleeAttackBehavior extends Behavior {
  /** @param {number} [speedMul=1] approach speed multiplier */
  constructor(speedMul = 1) {
    super('melee', 80);
    /** @type {number} */
    this.speedMul = speedMul;
    /** @type {number} */
    this.repath = 0;
  }

  /** @inheritDoc */
  canStart(mob) {
    const t = mob.target;
    if (t === null || t.dead === true || !t.position) return false;
    if (mob.def.attackDamage <= 0) return false;
    return distSq3(mob.position, t.position) <= mob.def.followRange * mob.def.followRange;
  }

  /** @inheritDoc */
  canContinue(mob) {
    const t = mob.target;
    if (t === null || t.dead === true || !t.position) return false;
    const r = mob.def.followRange + 8;
    return distSq3(mob.position, t.position) <= r * r;
  }

  /** @inheritDoc */
  start(mob) { this.repath = 0; }

  /** @inheritDoc */
  tick(mob, dt) {
    const t = mob.target;
    if (t === null || !t.position) return;
    mob.lookAt(t.position[0], t.position[1] + 1.2, t.position[2]);

    const reach = mob.def.attackReach + (t.width === undefined ? 0.3 : t.width * 0.5);
    const d2 = distSq3(mob.position, t.position);
    if (d2 <= reach * reach) {
      mob.stopMoving();
      mob.faceEntity(t);
      mob.attack(t);
      return;
    }

    this.repath -= dt;
    if (this.repath <= 0 || mob.navDone) {
      this.repath = 0.5;
      mob.moveTo(t.position[0], t.position[1], t.position[2], this.speedMul);
    }
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Keep a distance band to the target, draw, then fire a predicted arrow.
 * Used by the skeleton (bow) and, at a slower rate, by the witch.
 */
export class RangedAttackBehavior extends Behavior {
  /**
   * @param {number} [minDist=8] start closing in below this distance
   * @param {number} [maxDist=15] start backing off above this distance
   * @param {number} [drawTime=1] seconds spent drawing before a shot
   */
  constructor(minDist = 8, maxDist = 15, drawTime = 1) {
    super('ranged', 84);
    /** @type {number} */
    this.minDist = minDist;
    /** @type {number} */
    this.maxDist = maxDist;
    /** @type {number} */
    this.drawTime = drawTime;
    /** @type {number} */
    this.strafeDir = 1;
    /** @type {number} */
    this.strafeTimer = 0;
    /** @type {number} */
    this.repath = 0;
  }

  /** @inheritDoc */
  canStart(mob) {
    const t = mob.target;
    if (t === null || t.dead === true || !t.position) return false;
    const r = mob.def.followRange;
    return distSq3(mob.position, t.position) <= r * r;
  }

  /** @inheritDoc */
  canContinue(mob) { return this.canStart(mob); }

  /** @inheritDoc */
  start(mob) {
    mob.drawTimer = 0;
    this.strafeTimer = 0;
    this.strafeDir = mob.random() < 0.5 ? -1 : 1;
    this.repath = 0;
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const t = mob.target;
    if (t === null || !t.position) return;
    mob.lookAt(t.position[0], t.position[1] + 1.2, t.position[2]);
    mob.faceEntity(t);

    const dist = Math.sqrt(distSq3(mob.position, t.position));
    const sees = mob.canSee(t);

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 1.0 + mob.random();
      if (mob.random() < 0.3) this.strafeDir = -this.strafeDir;
    }

    if (!sees) {
      this.repath -= dt;
      if (this.repath <= 0 || mob.navDone) {
        this.repath = 0.5;
        mob.moveTo(t.position[0], t.position[1], t.position[2], 1);
      }
      mob.drawTimer = 0;
      return;
    }

    mob.stopMoving();

    // Hold the band: back off when too close, close in when too far, and always
    // strafe sideways so the shot is a moving target.
    const dx = t.position[0] - mob.position[0];
    const dz = t.position[2] - mob.position[2];
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len;
    const fz = dz / len;
    let mx = 0;
    let mz = 0;
    if (dist < this.minDist) { mx -= fx; mz -= fz; } else if (dist > this.maxDist) { mx += fx; mz += fz; }
    mx += -fz * this.strafeDir * 0.8;
    mz += fx * this.strafeDir * 0.8;
    mob.moveToward(mx, mz, 1);

    mob.drawTimer += dt;
    if (mob.drawTimer >= this.drawTime) {
      mob.drawTimer = 0;
      mob.fireProjectile(t, ctx);
    }
  }

  /** @inheritDoc */
  stop(mob) {
    mob.drawTimer = 0;
    mob.stopMoving();
  }
}

/**
 * Move away from a class of entity that this mob is simply scared of — the fox
 * and the rabbit avoid the player, the creeper avoids cats.
 */
export class AvoidEntityBehavior extends Behavior {
  /**
   * @param {(entity:Object)=>boolean} predicate which entities are frightening
   * @param {number} [radius=8] detection radius in blocks
   * @param {number} [speedMul=1.4] flee speed multiplier
   * @param {number} [priority=86] scheduler priority
   */
  constructor(predicate, radius = 8, speedMul = 1.4, priority = 86) {
    super('avoid', priority);
    /** @type {(entity:Object)=>boolean} */
    this.predicate = predicate;
    /** @type {number} */
    this.radius = radius;
    /** @type {number} */
    this.speedMul = speedMul;
    /** @type {?Object} */
    this.threat = null;
    /** @type {number} */
    this.repath = 0;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    this.threat = mob.findNearby(ctx, this.radius, this.predicate);
    return this.threat !== null;
  }

  /** @inheritDoc */
  canContinue(mob, ctx) {
    const t = this.threat;
    if (t === null || t.dead === true || !t.position) return false;
    const r = this.radius + 4;
    return distSq3(mob.position, t.position) <= r * r;
  }

  /** @inheritDoc */
  start(mob) { this.repath = 0; }

  /** @inheritDoc */
  tick(mob, dt) {
    const t = this.threat;
    if (t === null || !t.position) return;
    this.repath -= dt;
    if (this.repath > 0 && !mob.navDone) return;
    this.repath = 0.6;
    const dx = mob.position[0] - t.position[0];
    const dz = mob.position[2] - t.position[2];
    const len = Math.hypot(dx, dz) || 1;
    mob.moveTo(
      mob.position[0] + (dx / len) * 12,
      mob.position[1],
      mob.position[2] + (dz / len) * 12,
      this.speedMul
    );
  }

  /** @inheritDoc */
  stop(mob) {
    this.threat = null;
    mob.stopMoving();
  }
}

/**
 * Trot after a player who is holding food this mob likes — wheat, seeds, bones,
 * whatever the definition lists.
 */
export class FollowFoodBehavior extends Behavior {
  /** @param {number} [radius=10] how far the smell carries */
  constructor(radius = 10) {
    super('follow_food', 66);
    /** @type {number} */
    this.radius = radius;
    /** @type {?Object} */
    this.holder = null;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    const player = ctx ? ctx.player : null;
    if (!player || !player.position) return false;
    if (distSq3(mob.position, player.position) > this.radius * this.radius) return false;
    if (!mob.likesHeldItem(player)) return false;
    this.holder = player;
    return true;
  }

  /** @inheritDoc */
  canContinue(mob, ctx) { return this.canStart(mob, ctx); }

  /** @inheritDoc */
  tick(mob, dt) {
    const p = this.holder;
    if (p === null || !p.position) return;
    mob.lookAt(p.position[0], p.position[1] + 1.4, p.position[2]);
    if (distSq3(mob.position, p.position) > 2.5 * 2.5) {
      mob.moveTo(p.position[0], p.position[1], p.position[2], 1.1);
    } else {
      mob.stopMoving();
      mob.faceEntity(p);
    }
  }

  /** @inheritDoc */
  stop(mob) {
    this.holder = null;
    mob.stopMoving();
  }
}

/**
 * Two adults in love mode walk together and produce a baby.
 */
export class BreedBehavior extends Behavior {
  constructor() {
    super('breed', 68);
    /** @type {?Mob} */
    this.partner = null;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    if (mob.loveTimer <= 0 || mob.isBaby) return false;
    this.partner = mob.findBreedingPartner(ctx, 8);
    return this.partner !== null;
  }

  /** @inheritDoc */
  canContinue(mob, ctx) {
    const p = this.partner;
    if (mob.loveTimer <= 0) return false;
    if (p === null || p.dead === true || p.loveTimer <= 0 || !p.position) return false;
    return distSq3(mob.position, p.position) <= 12 * 12;
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const p = this.partner;
    if (p === null || !p.position) return;
    mob.lookAt(p.position[0], p.position[1] + 0.5, p.position[2]);
    if (distSq3(mob.position, p.position) > 1.8 * 1.8) {
      mob.moveTo(p.position[0], p.position[1], p.position[2], 1.0);
      return;
    }
    mob.stopMoving();
    // Only one of the pair spawns the baby: the lower id wins the coin flip.
    if (mob.id === undefined || p.id === undefined || mob.id < p.id) {
      mob.produceBaby(p, ctx);
    }
  }

  /** @inheritDoc */
  stop(mob) {
    this.partner = null;
    mob.stopMoving();
  }
}

/**
 * A baby keeps close to the nearest adult of its own kind.
 */
export class FollowParentBehavior extends Behavior {
  constructor() {
    super('follow_parent', 56);
    /** @type {?Mob} */
    this.parent = null;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    if (!mob.isBaby) return false;
    this.parent = mob.findNearby(ctx, 12, (e) => e !== mob && e.typeName === mob.typeName
      && e.isBaby === false && e.dead !== true);
    return this.parent !== null;
  }

  /** @inheritDoc */
  canContinue(mob, ctx) { return mob.isBaby && this.canStart(mob, ctx); }

  /** @inheritDoc */
  tick(mob) {
    const p = this.parent;
    if (p === null || !p.position) return;
    if (distSq3(mob.position, p.position) > 3 * 3) {
      mob.moveTo(p.position[0], p.position[1], p.position[2], 1.15);
    } else {
      mob.stopMoving();
      mob.lookAt(p.position[0], p.position[1] + 0.4, p.position[2]);
    }
  }

  /** @inheritDoc */
  stop(mob) {
    this.parent = null;
    mob.stopMoving();
  }
}

/**
 * Wander to a random reachable spot, wait, wander again.
 */
export class WanderBehavior extends Behavior {
  /**
   * @param {number} [radius=10] how far a wander target may be
   * @param {number} [speedMul=1] speed multiplier
   * @param {number} [chance=0.08] per-tick probability of picking a new target
   */
  constructor(radius = 10, speedMul = 1, chance = 0.08) {
    super('wander', 30);
    /** @type {number} */
    this.radius = radius;
    /** @type {number} */
    this.speedMul = speedMul;
    /** @type {number} */
    this.chance = chance;
    /** @type {number} */
    this.pause = 0;
  }

  /** @inheritDoc */
  canStart(mob) { return !mob.def.aquatic; }

  /** @inheritDoc */
  canContinue(mob) { return !mob.def.aquatic; }

  /** @inheritDoc */
  start(mob) { this.pause = 0; }

  /** @inheritDoc */
  tick(mob, dt) {
    if (!mob.navDone) return;
    this.pause -= dt;
    if (this.pause > 0) return;
    if (mob.random() > this.chance) return;
    this.pause = 1 + mob.random() * 3;
    const r = this.radius;
    const tx = mob.position[0] + (mob.random() * 2 - 1) * r;
    const tz = mob.position[2] + (mob.random() * 2 - 1) * r;
    const ty = mob.position[1] + Math.round((mob.random() * 2 - 1) * 2);
    mob.moveTo(tx, ty, tz, this.speedMul);
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Turn the head towards the nearest player. Purely cosmetic, lowest but one.
 */
export class LookAtPlayerBehavior extends Behavior {
  /** @param {number} [radius=8] look-at radius in blocks */
  constructor(radius = 8) {
    super('look', 20);
    /** @type {number} */
    this.radius = radius;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    const p = ctx ? ctx.player : null;
    if (!p || !p.position) return false;
    return distSq3(mob.position, p.position) <= this.radius * this.radius;
  }

  /** @inheritDoc */
  canContinue(mob, ctx) { return this.canStart(mob, ctx); }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const p = ctx.player;
    mob.stopMoving();
    mob.lookAt(p.position[0], p.position[1] + 1.5, p.position[2]);
  }
}

/**
 * Stand still and breathe. The floor of the priority list, so a mob always has
 * exactly one active behaviour.
 */
export class IdleBehavior extends Behavior {
  constructor() { super('idle', 10); }

  /** @inheritDoc */
  canStart() { return true; }

  /** @inheritDoc */
  canContinue() { return true; }

  /** @inheritDoc */
  tick(mob) { mob.stopMoving(); }
}

/* ------------------------------------------------------------------------- */
/* Signature behaviours                                                       */
/* ------------------------------------------------------------------------- */

/** Seconds a creeper fuse burns before it detonates. @type {number} */
export const CREEPER_FUSE_SECONDS = 1.5;

/** Blast power of a creeper explosion. @type {number} */
export const CREEPER_BLAST_POWER = 3;

/**
 * Creeper: close in, stop at three blocks, swell for 1.5 s, detonate. Backing
 * out of range, losing the target, or taking damage during the fuse all defuse
 * it again — the swell winds back down instead of snapping to zero.
 */
export class CreeperFuseBehavior extends Behavior {
  constructor() {
    super('fuse', 94);
    /** @type {number} */
    this.repath = 0;
  }

  /** @inheritDoc */
  canStart(mob) {
    const t = mob.target;
    if (t === null || t.dead === true || !t.position) return false;
    return distSq3(mob.position, t.position) <= 3.0 * 3.0 && mob.canSee(t);
  }

  /** @inheritDoc */
  canContinue(mob) {
    if (mob.fuse > 0) return true;
    return this.canStart(mob);
  }

  /** @inheritDoc */
  start(mob, ctx) {
    this.repath = 0;
    if (mob.fuse <= 0 && ctx && ctx.audio) {
      mob.playSound(ctx, 'special', 1.0);
    }
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const t = mob.target;
    const inRange = t !== null && t.dead !== true && !!t.position
      && distSq3(mob.position, t.position) <= 3.2 * 3.2 && mob.canSee(t);

    if (t !== null && t.position) mob.lookAt(t.position[0], t.position[1] + 1.2, t.position[2]);

    if (inRange) {
      mob.stopMoving();
      mob.fuse = Math.min(CREEPER_FUSE_SECONDS, mob.fuse + dt);
    } else {
      // Wound down rather than cancelled: a creeper that ducks behind a corner
      // for a tick does not reset its whole fuse.
      mob.fuse = Math.max(0, mob.fuse - dt * 2);
      if (t !== null && t.position) {
        this.repath -= dt;
        if (this.repath <= 0 || mob.navDone) {
          this.repath = 0.4;
          mob.moveTo(t.position[0], t.position[1], t.position[2], 1.0);
        }
      }
    }

    mob.swell = clamp(mob.fuse / CREEPER_FUSE_SECONDS, 0, 1);
    if (mob.fuse >= CREEPER_FUSE_SECONDS) mob.explode(ctx);
  }

  /** @inheritDoc */
  stop(mob) {
    mob.fuse = 0;
    mob.swell = 0;
    mob.stopMoving();
  }
}

/**
 * Enderman: vanish. Triggered by damage, by standing in water, or by burning in
 * the sun; the mob is relocated to a random valid block within 32 and, on a
 * failed attempt, simply tries again next tick.
 */
export class TeleportAwayBehavior extends Behavior {
  constructor() {
    super('teleport', 97);
    /** @type {number} */
    this.cooldown = 0;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    if (mob.teleportRequest > 0) return true;
    if (mob.inWater && !mob.def.aquatic) return true;
    return mob.def.sunAvoid > 0 && mob.isSunlit(ctx) && mob.random() < 0.15;
  }

  /** @inheritDoc */
  canContinue(mob) { return mob.teleportRequest > 0 || (mob.inWater && !mob.def.aquatic); }

  /** @inheritDoc */
  start() { this.cooldown = 0; }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    this.cooldown -= dt;
    if (this.cooldown > 0) return;
    this.cooldown = 0.25;
    if (mob.teleportRandom(32, ctx)) {
      mob.teleportRequest = 0;
    } else if (mob.teleportRequest > 0) {
      mob.teleportRequest = Math.max(0, mob.teleportRequest - 1);
    }
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Enderman: carry a block around. Picks one up from the ground when it has
 * empty hands and puts it down again somewhere else later.
 */
export class CarryBlockBehavior extends Behavior {
  constructor() {
    super('carry_block', 34);
    /** @type {boolean} the single action of this activation is done */
    this.done = false;
  }

  /** @inheritDoc */
  canStart(mob) {
    return mob.target === null && mob.onGround && mob.blockActionTimer <= 0;
  }

  /** @inheritDoc */
  canContinue(mob) { return !this.done && mob.target === null; }

  /** @inheritDoc */
  start() { this.done = false; }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    mob.stopMoving();
    mob.blockActionTimer = 4 + mob.random() * 8;
    if (mob.carriedBlock === 0) mob.pickUpBlock(ctx);
    else mob.placeCarriedBlock(ctx);
    this.done = true;
  }

  /** @inheritDoc */
  stop() { this.done = false; }
}

/**
 * Slime: hop instead of walking, and bounce roughly every 0.6 s. Locomotion is
 * jump-driven, so the mob only steers while airborne.
 */
export class SlimeBounceBehavior extends Behavior {
  constructor() {
    super('bounce', 82);
    /** @type {number} */
    this.timer = 0;
    /** @type {number} */
    this.heading = 0;
  }

  /** @inheritDoc */
  canStart() { return true; }

  /** @inheritDoc */
  canContinue() { return true; }

  /** @inheritDoc */
  start(mob) {
    this.timer = 0;
    this.heading = mob.random() * Math.PI * 2;
  }

  /** @inheritDoc */
  tick(mob, dt) {
    const t = mob.target;
    if (t !== null && t.position) {
      this.heading = Math.atan2(t.position[0] - mob.position[0], t.position[2] - mob.position[2]);
      mob.lookAt(t.position[0], t.position[1] + 0.5, t.position[2]);
      // A slime hurts by touching, not by swinging.
      const reach = mob.def.attackReach * mob.sizeScale;
      if (distSq3(mob.position, t.position) <= reach * reach) mob.attack(t);
    }
    mob.bodyYaw = damp(mob.bodyYaw, mob.bodyYaw + wrapAngle(this.heading - mob.bodyYaw), 8, dt);
    mob.directDrive = true;

    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5 + mob.random() * 0.4;
    if (t === null && mob.random() < 0.35) this.heading = mob.random() * Math.PI * 2;
    if (!mob.onGround) return;
    mob.directDrive = true;
    const speed = mob.def.speed * (t !== null ? 1.2 : 0.8) * mob.sizeScale;
    mob.velocity[0] = Math.sin(this.heading) * speed;
    mob.velocity[2] = Math.cos(this.heading) * speed;
    mob.velocity[1] = 6.5 + mob.sizeScale * 0.8;
    mob.onGround = false;
    mob.squash = 1;
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Wolf and cat: stay near the owner, and teleport to them when hopelessly far
 * behind. Sitting suspends the whole behaviour.
 */
export class FollowOwnerBehavior extends Behavior {
  /**
   * @param {number} [near=3] stop approaching inside this radius
   * @param {number} [far=8] start following beyond this radius
   * @param {number} [teleport=20] teleport to the owner beyond this radius
   */
  constructor(near = 3, far = 8, teleport = 20) {
    super('follow_owner', 58);
    /** @type {number} */
    this.near = near;
    /** @type {number} */
    this.far = far;
    /** @type {number} */
    this.teleport = teleport;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    if (!mob.tamed || mob.sitting) return false;
    const owner = mob.resolveOwner(ctx);
    if (owner === null) return false;
    return distSq3(mob.position, owner.position) > this.far * this.far;
  }

  /** @inheritDoc */
  canContinue(mob, ctx) {
    if (!mob.tamed || mob.sitting) return false;
    const owner = mob.resolveOwner(ctx);
    if (owner === null) return false;
    return distSq3(mob.position, owner.position) > this.near * this.near;
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const owner = mob.resolveOwner(ctx);
    if (owner === null) return;
    const d2 = distSq3(mob.position, owner.position);
    if (d2 > this.teleport * this.teleport) {
      mob.teleportNear(owner.position[0], owner.position[1], owner.position[2], 3);
      return;
    }
    mob.lookAt(owner.position[0], owner.position[1] + 1.4, owner.position[2]);
    mob.moveTo(owner.position[0], owner.position[1], owner.position[2], 1.25);
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * A tamed animal told to sit stays put, whatever else is happening.
 */
export class SitBehavior extends Behavior {
  constructor() { super('sit', 88); }

  /** @inheritDoc */
  canStart(mob) { return mob.tamed && mob.sitting; }

  /** @inheritDoc */
  canContinue(mob) { return mob.tamed && mob.sitting; }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    mob.stopMoving();
    const p = ctx ? ctx.player : null;
    if (p && p.position && distSq3(mob.position, p.position) < 64) {
      mob.lookAt(p.position[0], p.position[1] + 1.4, p.position[2]);
    }
  }
}

/** Seconds a sheep spends with its head down before the grass is gone. @type {number} */
export const SHEEP_EAT_SECONDS = 2.0;

/**
 * Sheep: crop the grass under its feet, turning the block to dirt (or removing
 * the plant), and grow its wool back.
 */
export class EatGrassBehavior extends Behavior {
  constructor() {
    super('eat_grass', 52);
    /** @type {number} */
    this.timer = 0;
    /** @type {number} */
    this.bx = 0;
    /** @type {number} */
    this.by = 0;
    /** @type {number} */
    this.bz = 0;
  }

  /** @inheritDoc */
  canStart(mob) {
    if (!mob.sheared && !mob.isBaby) return false;
    if (mob.eatCooldown > 0) return false;
    return mob.findGrassUnderfoot(this) !== false;
  }

  /** @inheritDoc */
  canContinue(mob) { return this.timer > 0; }

  /** @inheritDoc */
  start(mob, ctx) {
    this.timer = SHEEP_EAT_SECONDS;
    mob.eating = 1;
    mob.stopMoving();
    mob.playSound(ctx, 'special', 0.6);
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    this.timer -= dt;
    mob.eating = clamp(1 - this.timer / SHEEP_EAT_SECONDS, 0, 1);
    mob.stopMoving();
    if (this.timer > 0) return;
    mob.consumeGrass(this.bx, this.by, this.bz, ctx);
    mob.eatCooldown = 20 + mob.random() * 40;
  }

  /** @inheritDoc */
  stop(mob) {
    this.timer = 0;
    mob.eating = 0;
  }
}

/**
 * Villager: keep the day loop going — wander the village, and stay away from
 * the entrance the hostiles came through. The flee half is handled by
 * {@link AvoidEntityBehavior}; this one keeps the villager near its home.
 */
export class VillagerRoutineBehavior extends Behavior {
  /** @param {number} [radius=24] how far from home the villager will roam */
  constructor(radius = 24) {
    super('village_routine', 28);
    /** @type {number} */
    this.radius = radius;
    /** @type {number} */
    this.pause = 0;
  }

  /** @inheritDoc */
  canStart(mob) { return mob.home !== null; }

  /** @inheritDoc */
  canContinue(mob) { return mob.home !== null; }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    if (!mob.navDone) return;
    this.pause -= dt;
    if (this.pause > 0) return;
    this.pause = 2 + mob.random() * 4;
    const home = mob.home;
    const night = ctx && ctx.environment && typeof ctx.environment.isNight === 'function'
      ? ctx.environment.isNight() : false;
    const r = night ? 3 : this.radius * 0.5;
    const tx = home[0] + (mob.random() * 2 - 1) * r;
    const tz = home[2] + (mob.random() * 2 - 1) * r;
    mob.moveTo(tx, home[1], tz, night ? 1.2 : 0.9);
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Squid and fish: a smooth undulating swim. Instead of steering towards
 * waypoints the mob keeps a slowly turning heading and pulses forward, which is
 * what makes the motion read as swimming rather than walking underwater.
 */
export class SwimWanderBehavior extends Behavior {
  constructor() {
    super('swim', 44);
    /** @type {number} */
    this.yaw = 0;
    /** @type {number} */
    this.pitch = 0;
    /** @type {number} */
    this.phase = 0;
    /** @type {number} */
    this.turnTimer = 0;
  }

  /** @inheritDoc */
  canStart(mob) { return mob.def.aquatic || mob.def.flying; }

  /** @inheritDoc */
  canContinue(mob) { return mob.def.aquatic || mob.def.flying; }

  /** @inheritDoc */
  start(mob) {
    this.yaw = mob.random() * Math.PI * 2;
    this.pitch = 0;
    this.phase = mob.random() * Math.PI * 2;
    this.turnTimer = 0;
  }

  /** @inheritDoc */
  tick(mob, dt) {
    this.turnTimer -= dt;
    if (this.turnTimer <= 0) {
      this.turnTimer = 1.5 + mob.random() * 3;
      this.yaw += (mob.random() * 2 - 1) * 1.4;
      this.pitch = clamp(this.pitch + (mob.random() * 2 - 1) * 0.5, -0.6, 0.6);
    }

    // Steer back into the medium: an aquatic mob must not swim into the air,
    // and a flying mob must not fly into the ground.
    const world = mob.world;
    if (world !== null) {
      const ahead = mob.def.aquatic ? 1 : 2;
      const px = Math.floor(mob.position[0] + Math.sin(this.yaw) * ahead);
      const pz = Math.floor(mob.position[2] + Math.cos(this.yaw) * ahead);
      const py = Math.floor(mob.position[1] + this.pitch * ahead + mob.def.height * 0.5);
      const id = world.getBlock(px, py, pz);
      if (mob.def.aquatic) {
        if (id !== ID_WATER) {
          this.yaw += 1.8;
          this.pitch = id === 0 ? -0.4 : 0.35;
        }
      } else if (id !== 0 && BLOCK_PASSABLE[id] !== 1) {
        this.yaw += 1.8;
        this.pitch = 0.35;
      }
    }

    this.phase += dt * 2.4;
    const pulse = 0.55 + 0.45 * Math.sin(this.phase);
    const speed = mob.def.speed * pulse;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const horiz = Math.cos(this.pitch);
    mob.velocity[0] = damp(mob.velocity[0], sy * horiz * speed, 4, dt);
    mob.velocity[2] = damp(mob.velocity[2], cy * horiz * speed, 4, dt);
    mob.velocity[1] = damp(mob.velocity[1], Math.sin(this.pitch) * speed, 4, dt);
    mob.bodyYaw = damp(mob.bodyYaw, mob.bodyYaw + wrapAngle(this.yaw - mob.bodyYaw), 6, dt);
    mob.navActive = false;
    mob.directDrive = true;
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/* ========================================================================== */
/* Mob                                                                        */
/* ========================================================================== */

/** Upward speed of a standard mob jump, in blocks/second (~1.15 blocks high). @type {number} */
const JUMP_SPEED = 8.6;

/** Seconds of invulnerability after taking a hit. @type {number} */
const HURT_IMMUNITY = 0.5;

/** Ticks the hurt tint stays on the model. @type {number} */
const HURT_FLASH_TICKS = 10;

/** Seconds the death animation plays before the entity is removed. @type {number} */
const DEATH_SECONDS = 1.0;

/** Damage per second taken while burning in daylight. @type {number} */
const BURN_DPS = 1;

/** Reusable scratch, never escapes a call. @type {number[]} */
const _scratchA = [0, 0, 0];
/** Reusable scratch, never escapes a call. @type {number[]} */
const _scratchB = [0, 0, 0];
/** Reusable entity query buffer. @type {Object[]} */
const _queryOut = [];
/** Reusable colored-light probe. @type {number[]} */
const _lightOut = [0, 0, 0];

/**
 * A living creature: an {@link Entity} with a {@link MobDef}, a {@link MobAI},
 * a navigation path and a combat state.
 *
 * `Mob#update` deliberately does **not** call `Entity#update`: this class owns
 * its whole simulation (senses, AI, navigation, physics, timers), so a mob
 * behaves identically no matter what the generic entity integrator does.
 */
export class Mob extends Entity {
  /**
   * @param {string} type mob type name, a key of {@link MOB_TYPES}
   * @param {number} x spawn X (footprint centre)
   * @param {number} y spawn Y (feet)
   * @param {number} z spawn Z (footprint centre)
   */
  constructor(type, x, y, z) {
    super(type, x, y, z);

    if (!Array.isArray(this.position) && !ArrayBuffer.isView(this.position)) {
      this.position = [finite(x, 0), finite(y, 0), finite(z, 0)];
    }
    if (!this.velocity || this.velocity.length < 3) this.velocity = [0, 0, 0];
    if (!this.rotation || this.rotation.length < 2) this.rotation = [0, 0];

    const def = getMobType(type);
    if (def === null) warnOnce(`type:${type}`, `unknown mob type "${type}"; falling back to pig`);
    /** @type {MobDef} the immutable definition this mob was built from */
    this.def = def === null ? MOB_TYPES.pig : def;
    /** @type {string} type key, mirrored so behaviours can compare cheaply */
    this.typeName = this.def.name;
    /** @type {string} the entity type the renderer keys on */
    this.type = this.def.name;

    /* ---- identity / growth ------------------------------------------- */
    /** @type {boolean} */
    this.isBaby = false;
    /** @type {number} uniform hitbox and model scale */
    this.sizeScale = 1;
    /** @type {number} seconds left until a baby grows up */
    this.growthTimer = 0;
    /** @type {number} slime size, 1..4; `1` never splits again */
    this.slimeSize = 2;

    /* ---- vitals ------------------------------------------------------- */
    /** @type {number} */
    this.maxHealth = this.def.health;
    /** @type {number} */
    this.health = this.def.health;
    /** @type {boolean} */
    this.dead = false;
    /** @type {boolean} set the moment health reaches zero */
    this.dying = false;
    /** @type {number} seconds the death animation has been playing */
    this.deathTimer = 0;
    /** @type {number} ticks of hurt tint left, read by the renderer */
    this.hurtTime = 0;
    /** @type {number} seconds of damage immunity left */
    this.immunity = 0;
    /** @type {number} seconds left on fire */
    this.burningTimer = 0;
    /** @type {number} seconds without air */
    this.drownTimer = 0;

    /* ---- pose --------------------------------------------------------- */
    /** @type {number[]} previous tick position, for render interpolation */
    this.prevPosition = [this.position[0], this.position[1], this.position[2]];
    /** @type {number} body yaw in radians, consumed by the renderer */
    this.bodyYaw = 0;
    /** @type {number} alias the renderer reads first */
    this.modelYaw = 0;
    /** @type {number} head pitch in radians */
    this.headPitch = 0;
    /** @type {number} yaw the head is looking along, in radians */
    this.lookYaw = 0;
    /** @type {boolean} */
    this.onGround = false;
    /** @type {boolean} */
    this.inWater = false;
    /** @type {boolean} */
    this.inLava = false;
    /** @type {number} 0..1 */
    this.submerged = 0;
    /** @type {number} blocks fallen since the last landing */
    this.fallDistance = 0;

    /* ---- AI ----------------------------------------------------------- */
    /** @type {?MobAI} */
    this.ai = null;
    /** @type {?Object} the entity this mob is currently after */
    this.target = null;
    /** @type {number} seconds of target memory left */
    this.targetMemory = 0;
    /** @type {?Array<number[]>} the current path, block coordinates */
    this.path = null;
    /** @type {number} index of the waypoint the mob is walking towards */
    this.pathIndex = 0;
    /** @type {string} name of the running behaviour */
    this.state = 'idle';
    /** @type {Object} animation flags read by `render/entities.js` */
    this.animation = { attack: false, eat: 0, swell: 0, sit: 0 };

    /* ---- navigation --------------------------------------------------- */
    /** @type {boolean} */
    this.navActive = false;
    /** @type {number[]} current goal in block coordinates */
    this.navGoal = [0, 0, 0];
    /** @type {number} speed multiplier requested by the behaviour */
    this.navSpeed = 1;
    /** @type {number} seconds until the path may be recomputed */
    this.navRepath = 0;
    /** @type {number} seconds the mob has failed to make progress */
    this.stuckTimer = 0;
    /** @type {number[]} position at the last stuck check */
    this.stuckAnchor = [0, 0, 0];
    /** @type {number} steering direction X, -1..1 */
    this.moveDX = 0;
    /** @type {number} steering direction Z, -1..1 */
    this.moveDZ = 0;
    /** @type {number} requested ground speed in blocks/second */
    this.moveSpeed = 0;
    /** @type {boolean} a behaviour is writing `velocity` itself this tick */
    this.directDrive = false;

    /* ---- combat / special --------------------------------------------- */
    /** @type {number} seconds until the next melee swing */
    this.attackTimer = 0;
    /** @type {boolean} renderer swing trigger */
    this.swinging = false;
    /** @type {number} seconds the bow has been drawn */
    this.drawTimer = 0;
    /** @type {number} seconds of panic left */
    this.panicTimer = 0;
    /** @type {?Object} whatever caused the panic */
    this.panicSource = null;
    /** @type {number} seconds of creeper fuse burned */
    this.fuse = 0;
    /** @type {number} 0..1 creeper swell, read by the renderer */
    this.swell = 0;
    /** @type {number} pending teleport requests (enderman) */
    this.teleportRequest = 0;
    /** @type {number} block id the enderman is carrying, `0` for none */
    this.carriedBlock = 0;
    /** @type {number} seconds until the mob may pick up or place a block again */
    this.blockActionTimer = 0;
    /** @type {number} accumulator for the enderman's water damage */
    this.waterAccum = 0;
    /** @type {number} accumulator for burning damage */
    this.burnAccum = 0;
    /** @type {number} accumulator for lava damage */
    this.lavaAccum = 0;
    /** @type {number} seconds of anger left for neutral mobs */
    this.angerTimer = 0;
    /** @type {number} squash-and-stretch impulse for the slime */
    this.squash = 0;
    /** @type {number} 0..1 grass-eating progress for the sheep */
    this.eating = 0;
    /** @type {number} seconds until the sheep may crop grass again */
    this.eatCooldown = 0;

    /* ---- taming / breeding -------------------------------------------- */
    /** @type {boolean} */
    this.tamed = false;
    /** @type {?string} owner id or name */
    this.owner = null;
    /** @type {boolean} */
    this.sitting = false;
    /** @type {number} seconds of love mode left */
    this.loveTimer = 0;
    /** @type {number} seconds until the mob can breed again */
    this.breedCooldown = 0;
    /** @type {boolean} sheep wool state */
    this.sheared = false;
    /** @type {number} sheep wool colour, 0..15 */
    this.woolColor = 0;
    /** @type {?string} villager profession key */
    this.profession = null;
    /** @type {?number[]} home position for villagers and golems */
    this.home = null;

    /* ---- runtime ------------------------------------------------------ */
    /** @type {?Object} the world, refreshed every tick */
    this.world = null;
    /** @type {Object} the context of the most recent tick */
    this._ctx = SHARED_CTX;
    /** @type {number} seconds alive */
    this.age = 0;
    /** @type {number} seconds since the last idle sound */
    this.idleSoundTimer = 4 + Math.random() * 8;
    /** @type {() => number} this mob's own RNG */
    this.rng = mulberry32((Math.random() * 0xffffffff) >>> 0);

    /** @type {AABB} collision box, kept in sync with `position` */
    this.aabb = this.aabb instanceof AABB ? this.aabb : new AABB();
    /** @type {Object} reusable move result */
    this._move = createMoveResult();
    /** @type {Object} reusable liquid probe result */
    this._liquid = { water: false, lava: false, submerged: 0 };
    /** @type {Object} reusable movement options */
    this._moveOpts = { stepHeight: this.def.stepHeight, autoStep: true, sneaking: false, onGround: false };

    this.gravityScale = this.def.gravityScale;
    this.applyScale(1);
    this.ai = new MobAI(this, buildBehaviorsFor(this));
  }

  /* ---------------------------------------------------------------- setup */

  /**
   * Resize the hitbox, model scale and derived stats. Called for babies, for
   * slime sizes, and once at construction.
   * @param {number} scale uniform scale factor
   * @returns {void}
   */
  applyScale(scale) {
    this.sizeScale = clamp(finite(scale, 1), 0.1, 8);
    this.width = this.def.width * this.sizeScale;
    this.height = this.def.height * this.sizeScale;
    this.eyeHeight = this.def.eyeHeight * this.sizeScale;
    this._moveOpts.stepHeight = Math.max(0.5, this.def.stepHeight * this.sizeScale);
    this.pathCaps = pathCapsFor(this.def, this.sizeScale);
    this.syncAABB();
  }

  /**
   * Turn this mob into a baby: smaller, faster, and on a growth timer.
   * @param {boolean} [baby=true] `false` restores the adult form
   * @returns {Mob} `this`
   */
  setBaby(baby = true) {
    this.isBaby = baby === true;
    this.growthTimer = this.isBaby ? this.def.growUpSeconds : 0;
    this.applyScale(this.isBaby ? this.def.babyScale : 1);
    if (!this.isBaby) {
      this.maxHealth = this.def.health;
      this.health = Math.min(this.health, this.maxHealth);
    }
    return this;
  }

  /**
   * Set a slime's size. Health, damage and hitbox all scale with it, and a
   * size-1 slime is the smallest one that exists.
   * @param {number} size slime size, 1..4
   * @returns {Mob} `this`
   */
  setSlimeSize(size) {
    const s = clamp(Math.round(finite(size, 2)), 1, 4);
    this.slimeSize = s;
    this.maxHealth = s * s;
    this.health = this.maxHealth;
    this.applyScale(s * 0.51);
    return this;
  }

  /**
   * Re-anchor the collision box on the current position.
   * @returns {void}
   */
  syncAABB() {
    const hw = this.width * 0.5;
    const p = this.position;
    this.aabb.set(p[0] - hw, p[1], p[2] - hw, p[0] + hw, p[1] + this.height, p[2] + hw);
  }

  /**
   * Copy the resolved collision box back onto `position`.
   * @returns {void}
   */
  syncPosition() {
    const b = this.aabb;
    this.position[0] = (b.minX + b.maxX) * 0.5;
    this.position[1] = b.minY;
    this.position[2] = (b.minZ + b.maxZ) * 0.5;
  }

  /**
   * The context this mob should act in: its own if it has ticked, otherwise the
   * one the rest of the world is using this tick.
   * @returns {Object} a tick context, never `null`
   */
  context() {
    return this._ctx || SHARED_CTX;
  }

  /**
   * This mob's private random source.
   * @returns {number} a value in `[0, 1)`
   */
  random() {
    return this.rng();
  }

  /**
   * World Y of the mob's eyes.
   * @returns {number} eye height in world coordinates
   */
  eyeY() {
    return this.position[1] + this.eyeHeight;
  }

  /**
   * Whether the navigator has nothing left to do.
   * @returns {boolean} `true` when idle
   */
  get navDone() {
    return !this.navActive;
  }

  /* ----------------------------------------------------------------- tick */

  /**
   * Advance the mob by one tick. Never throws: a failure disables this mob's
   * AI for the rest of its life and leaves the body in the world.
   * @param {number} dt seconds since the last tick (0.05 at 20 TPS)
   * @param {Object} world the chunk manager
   * @param {Object} [ctx] the tick context, see this file's header
   * @returns {void}
   */
  update(dt, world, ctx) {
    const step = clamp(finite(dt, 0), 0, 0.25);
    if (step <= 0) return;
    const context = ctx || EMPTY_CTX;
    /** @type {Object} the context of the current tick, used by damage callbacks */
    this._ctx = context;
    if (context !== EMPTY_CTX) SHARED_CTX = context;
    this.world = world || null;

    this.prevPosition[0] = this.position[0];
    this.prevPosition[1] = this.position[1];
    this.prevPosition[2] = this.position[2];

    try {
      this.age += step;
      this.updateTimers(step, context);

      if (this.dying) {
        this.deathTimer += step;
        this.deathTime = Math.round(this.deathTimer * TICK_RATE);
        this.moveDX = 0;
        this.moveDZ = 0;
        this.moveSpeed = 0;
        this.directDrive = false;
        if (world !== null) this.applyMovement(step, world);
        if (this.deathTimer >= DEATH_SECONDS) this.remove(context);
        return;
      }

      this.moveDX = 0;
      this.moveDZ = 0;
      this.moveSpeed = 0;
      this.directDrive = false;
      this.swinging = false;

      if (world !== null) {
        this.updateSenses(step, context);
        if (this.ai !== null) this.ai.update(step, context);
        this.updateNavigation(step);
        this.applyMovement(step, world);
        this.updateEnvironmentDamage(step, context);
      }

      this.modelYaw = this.bodyYaw;
      if (this.rotation && this.rotation.length >= 2) {
        this.rotation[0] = this.bodyYaw;
        this.rotation[1] = this.headPitch;
      }
      this.animation.attack = this.swinging;
      this.animation.eat = this.eating;
      this.animation.swell = this.swell;
      this.animation.sit = this.sitting ? 1 : 0;
    } catch (e) {
      warnOnce(`tick:${this.typeName}`, `mob "${this.typeName}" threw during its tick; AI disabled`, e);
      this.ai = null;
    }
  }

  /**
   * Count every timer down and handle growth, love and anger expiry.
   * @param {number} dt seconds
   * @param {Object} ctx tick context
   * @returns {void}
   */
  updateTimers(dt, ctx) {
    if (this.immunity > 0) this.immunity = Math.max(0, this.immunity - dt);
    if (this.hurtTime > 0) this.hurtTime = Math.max(0, this.hurtTime - dt * TICK_RATE);
    if (this.attackTimer > 0) this.attackTimer = Math.max(0, this.attackTimer - dt);
    if (this.panicTimer > 0) {
      this.panicTimer = Math.max(0, this.panicTimer - dt);
      if (this.panicTimer === 0) this.panicSource = null;
    }
    if (this.angerTimer > 0) this.angerTimer = Math.max(0, this.angerTimer - dt);
    if (this.breedCooldown > 0) this.breedCooldown = Math.max(0, this.breedCooldown - dt);
    if (this.loveTimer > 0) this.loveTimer = Math.max(0, this.loveTimer - dt);
    if (this.navRepath > 0) this.navRepath = Math.max(0, this.navRepath - dt);
    if (this.squash > 0) this.squash = Math.max(0, this.squash - dt * 4);
    if (this.eatCooldown > 0) this.eatCooldown = Math.max(0, this.eatCooldown - dt);
    if (this.blockActionTimer > 0) this.blockActionTimer = Math.max(0, this.blockActionTimer - dt);
    if (this.targetMemory > 0) {
      this.targetMemory = Math.max(0, this.targetMemory - dt);
      if (this.targetMemory === 0) this.setTarget(null);
    }

    if (this.isBaby && this.growthTimer > 0) {
      this.growthTimer -= dt;
      if (this.growthTimer <= 0) this.setBaby(false);
    }

    if (this.loveTimer > 0 && ctx.particles) {
      if (this.random() < dt * 4) {
        this.spawnParticles(ctx, 'heart', this.position[1] + this.height * 0.9, 2);
      }
    }

    this.idleSoundTimer -= dt;
    if (this.idleSoundTimer <= 0) {
      this.idleSoundTimer = 6 + this.random() * 12;
      if (!this.dying) this.playSound(ctx, 'idle', 0.5);
    }
  }

  /* -------------------------------------------------------------- senses */

  /**
   * Pick and validate the current target, and apply the per-species aggression
   * rules — spiders only in the dark, endermen only when stared at, golems only
   * against hostiles, tamed wolves only against their owner's quarry.
   * @param {number} dt seconds
   * @param {Object} ctx tick context
   * @returns {void}
   */
  updateSenses(dt, ctx) {
    const def = this.def;
    const player = ctx.player || null;

    // Drop a target that died, left the world or ran too far away.
    if (this.target !== null) {
      const t = this.target;
      const gone = t.dead === true || t.removed === true || !t.position;
      const far = !gone && distSq3(this.position, t.position) > (def.followRange + 16) ** 2;
      if (gone || far) this.setTarget(null);
      else if (this.canSee(t)) this.targetMemory = TARGET_MEMORY;
    }

    if (this.target !== null) return;

    // Species scans that have nothing to do with the player come first: a golem
    // guards its village whether or not anybody is watching.
    if (def.name === 'iron_golem') {
      const hostile = this.findNearby(ctx, def.followRange,
        (e) => e !== this && e.def !== undefined && e.def.hostile === true && e.dead !== true);
      if (hostile !== null) {
        this.setTarget(hostile);
        return;
      }
    }

    if (player === null || !player.position) return;
    if (player.gameMode === 'creative' || player.gameMode === 'spectator') return;
    if (player.dead === true || (player.health !== undefined && player.health <= 0)) return;

    const d2 = distSq3(this.position, player.position);
    if (d2 > def.followRange * def.followRange) return;

    let wants = false;
    if (def.hostile && !def.neutral) {
      wants = true;
    } else if (def.name === 'spider') {
      // Neutral in bright light, hostile in the dark.
      wants = this.effectiveLight(ctx) <= 9 || this.angerTimer > 0;
    } else if (def.name === 'enderman') {
      wants = this.angerTimer > 0 || this.isBeingStaredAt(player);
    } else if (def.neutral) {
      // A tamed pet never turns on a player by itself.
      wants = this.angerTimer > 0 && !this.tamed;
    }

    if (!wants) return;
    if (!this.canSee(player)) return;
    this.setTarget(player);
  }

  /**
   * Whether the player is looking straight at this mob's head — the enderman
   * aggression trigger. Uses the player's real view vector against the vector
   * to the head, so looking *past* an enderman is safe.
   * @param {Object} player the player
   * @returns {boolean} `true` when stared at
   */
  isBeingStaredAt(player) {
    let fx;
    let fy;
    let fz;
    if (typeof player.getLookDirection === 'function') {
      const d = player.getLookDirection();
      if (!d || d.length < 3) return false;
      fx = d[0]; fy = d[1]; fz = d[2];
    } else if (player.camera && player.camera.forward && player.camera.forward.length >= 3) {
      fx = player.camera.forward[0];
      fy = player.camera.forward[1];
      fz = player.camera.forward[2];
    } else if (Number.isFinite(player.yaw) && Number.isFinite(player.pitch)) {
      const cp = Math.cos(player.pitch);
      fx = Math.sin(player.yaw) * cp;
      fy = -Math.sin(player.pitch);
      fz = Math.cos(player.yaw) * cp;
    } else {
      return false;
    }

    const ey = typeof player.getEyePosition === 'function' ? player.getEyePosition() : null;
    const ox = ey ? ey[0] : player.position[0];
    const oy = ey ? ey[1] : player.position[1] + 1.62;
    const oz = ey ? ey[2] : player.position[2];

    // Aim at the head, not the feet: that is the whole point of the rule.
    const dx = this.position[0] - ox;
    const dy = (this.position[1] + this.height * 0.9) - oy;
    const dz = this.position[2] - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5 || len > 64) return false;
    const dot = (dx * fx + dy * fy + dz * fz) / len;
    if (dot < 0.985) return false;
    return this.canSee(player);
  }

  /**
   * The light level the mob actually stands in: the brighter of its coloured
   * block light and its sky light scaled by the time of day.
   * @param {Object} ctx tick context (for `environment`)
   * @returns {number} light level 0..15
   */
  effectiveLight(ctx) {
    const world = this.world;
    if (world === null) return 15;
    const x = Math.floor(this.position[0]);
    const y = Math.floor(this.position[1] + this.height * 0.5);
    const z = Math.floor(this.position[2]);
    let block = 0;
    if (typeof world.getBlockLight === 'function') {
      const rgb = world.getBlockLight(x, y, z, _lightOut);
      block = Math.max(rgb[0], rgb[1], rgb[2]);
    }
    let sky = typeof world.getSkyLight === 'function' ? world.getSkyLight(x, y, z) : 15;
    const env = ctx ? ctx.environment : null;
    if (env && typeof env.getLightLevel === 'function') {
      sky = sky * clamp(env.getLightLevel() / 15, 0, 1);
    }
    return Math.max(block, sky);
  }

  /**
   * Whether the mob stands in unobstructed daylight.
   * @param {Object} ctx tick context
   * @returns {boolean} `true` when the sun is on it
   */
  isSunlit(ctx) {
    const world = this.world;
    if (world === null) return false;
    const env = ctx ? ctx.environment : null;
    if (env) {
      if (typeof env.isDay === 'function' && !env.isDay()) return false;
      if (typeof env.rainStrength === 'number' && env.rainStrength > 0.4) return false;
    }
    const x = Math.floor(this.position[0]);
    const z = Math.floor(this.position[2]);
    const y = Math.floor(this.position[1] + this.height * 0.9);
    if (typeof world.getSkyLight === 'function' && world.getSkyLight(x, y, z) < 15) return false;
    if (typeof world.getHeight === 'function' && world.getHeight(x, z) > y + 1) return false;
    return true;
  }

  /**
   * Find the closest shaded block the mob could stand on.
   * @param {number} radius search radius in blocks
   * @returns {?number[]} `[x,y,z]` block coordinates, or `null`
   */
  findShade(radius) {
    const world = this.world;
    if (world === null || typeof world.getSkyLight !== 'function') return null;
    const cx = Math.floor(this.position[0]);
    const cy = Math.floor(this.position[1]);
    const cz = Math.floor(this.position[2]);
    let best = null;
    let bestD = Infinity;
    const caps = normaliseCaps(this.pathCaps);
    const r = Math.max(2, Math.round(radius));
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dz = -r; dz <= r; dz += 1) {
        const d = dx * dx + dz * dz;
        if (d > r * r || d >= bestD) continue;
        for (let dy = -2; dy <= 2; dy++) {
          const x = cx + dx;
          const y = cy + dy;
          const z = cz + dz;
          if (world.getSkyLight(x, y, z) >= 15) continue;
          if (!hasClearance(world, x, y, z, caps)) continue;
          if (!isStandable(world, x, y, z, caps)) continue;
          best = best === null ? [x, y, z] : best;
          best[0] = x; best[1] = y; best[2] = z;
          bestD = d;
          break;
        }
      }
    }
    return best;
  }

  /**
   * Whether this mob has an unobstructed line of sight to an entity.
   * @param {Object} other the other entity
   * @returns {boolean} `true` when visible
   */
  canSee(other) {
    const world = this.world;
    if (world === null || !other || !other.position) return false;
    if (typeof world.raycast !== 'function') return true;
    const ox = this.position[0];
    const oy = this.eyeY();
    const oz = this.position[2];
    const targetY = other.position[1] + (other.eyeHeight === undefined ? 1.5 : other.eyeHeight);
    let dx = other.position[0] - ox;
    let dy = targetY - oy;
    let dz = other.position[2] - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.001) return true;
    if (dist > 128) return false;
    dx /= dist; dy /= dist; dz /= dist;
    _scratchA[0] = ox; _scratchA[1] = oy; _scratchA[2] = oz;
    _scratchB[0] = dx; _scratchB[1] = dy; _scratchB[2] = dz;
    const hit = world.raycast(_scratchA, _scratchB, dist);
    return hit === null || hit.dist >= dist - 0.35;
  }

  /**
   * Nearest entity within a radius that satisfies a predicate.
   * @param {Object} ctx tick context (for `entities`)
   * @param {number} radius search radius in blocks
   * @param {(entity:Object)=>boolean} predicate filter
   * @returns {?Object} the nearest match, or `null`
   */
  findNearby(ctx, radius, predicate) {
    const em = ctx ? ctx.entities : null;
    if (!em || typeof em.queryRadius !== 'function') return null;
    _queryOut.length = 0;
    let list;
    try {
      list = em.queryRadius(this.position[0], this.position[1], this.position[2], radius, _queryOut);
    } catch (e) {
      warnOnce('queryRadius', 'entity manager queryRadius failed; proximity senses disabled', e);
      return null;
    }
    if (!list) return null;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e === this || !e.position) continue;
      if (!predicate(e)) continue;
      const d = distSq3(this.position, e.position);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /**
   * Whether a player is holding something this mob would follow or eat.
   * @param {Object} player the player
   * @returns {boolean} `true` when the held item is on the menu
   */
  likesHeldItem(player) {
    const wanted = this.wantedFoodIds();
    if (wanted.length === 0) return false;
    const held = readHeldItemId(player);
    if (held <= 0) return false;
    return wanted.indexOf(held) >= 0;
  }

  /**
   * The item ids that interest this mob — breeding food plus, for an untamed
   * tameable, its taming item.
   * @returns {number[]} item ids, possibly empty
   */
  wantedFoodIds() {
    if (this._foodIds === undefined) {
      const ids = [];
      const push = (names) => {
        if (!names) return;
        for (let i = 0; i < names.length; i++) {
          const id = itemId(names[i]);
          if (id > 0 && ids.indexOf(id) < 0) ids.push(id);
        }
      };
      push(this.def.breedFood);
      push(this.def.tameFood);
      /** @type {number[]} cached item ids this mob follows */
      this._foodIds = ids;
    }
    return this._foodIds;
  }

  /**
   * Nearest adult of the same species that is also in love mode.
   * @param {Object} ctx tick context
   * @param {number} radius search radius
   * @returns {?Mob} the partner, or `null`
   */
  findBreedingPartner(ctx, radius) {
    return /** @type {?Mob} */ (this.findNearby(ctx, radius, (e) => e !== this
      && e.typeName === this.typeName && e.loveTimer > 0 && e.isBaby === false
      && e.dead !== true));
  }

  /* ---------------------------------------------------------- navigation */

  /**
   * Compute a path to a world position. Honours the mob's capabilities and
   * scales the node budget with the distance, so a short hop is cheap and a
   * long trek still cannot blow the tick.
   * @param {number} tx target X
   * @param {number} ty target Y
   * @param {number} tz target Z
   * @returns {?Array<number[]>} the path, or `null` when unreachable
   */
  findPath(tx, ty, tz) {
    const world = this.world;
    if (world === null) return null;
    if (!pathBudgetAvailable()) {
      // The world has spent its A* budget this tick. Keep the old path and ask
      // again shortly, rather than stalling the tick or losing the route.
      this.navRepath = 0.1 + this.random() * 0.2;
      return this.path;
    }
    _scratchA[0] = Math.floor(this.position[0]);
    _scratchA[1] = Math.floor(this.position[1] + 0.1);
    _scratchA[2] = Math.floor(this.position[2]);
    _scratchB[0] = Math.floor(tx);
    _scratchB[1] = Math.floor(ty);
    _scratchB[2] = Math.floor(tz);
    const dist = Math.abs(_scratchB[0] - _scratchA[0]) + Math.abs(_scratchB[2] - _scratchA[2]);
    const budget = clamp(Math.round(dist * 40), 200, DEFAULT_PATH_BUDGET);
    let path = null;
    const started = nowMs();
    try {
      path = pathfind(world, _scratchA, _scratchB, budget, this.pathCaps);
    } catch (e) {
      warnOnce('pathfind', 'pathfinder failed; mobs fall back to direct steering', e);
      path = null;
    }
    PATH_TIME_USED += nowMs() - started;
    this.path = path;
    this.pathIndex = path === null ? 0 : 1;
    return path;
  }

  /**
   * Ask the navigator to walk to a world position. Cheap to call every tick:
   * the path is only recomputed when the goal moved or the cooldown expired.
   * @param {number} x target X
   * @param {number} y target Y
   * @param {number} z target Z
   * @param {number} [speedMul=1] speed multiplier
   * @returns {void}
   */
  moveTo(x, y, z, speedMul = 1) {
    this.navSpeed = clamp(finite(speedMul, 1), 0.1, 3);
    const gx = Math.floor(x);
    const gy = Math.floor(y);
    const gz = Math.floor(z);
    const moved = gx !== this.navGoal[0] || gy !== this.navGoal[1] || gz !== this.navGoal[2];
    if (this.path === null || moved || this.navRepath <= 0 || !this.navActive) {
      this.navGoal[0] = gx;
      this.navGoal[1] = gy;
      this.navGoal[2] = gz;
      this.navRepath = 0.5 + this.random() * 0.4;
      this.findPath(gx, gy, gz);
      this.stuckTimer = 0;
      this.stuckAnchor[0] = this.position[0];
      this.stuckAnchor[1] = this.position[1];
      this.stuckAnchor[2] = this.position[2];
    }
    this.navActive = true;
    if (this.path === null) {
      // No route: steer straight at the goal anyway, which is what a mob
      // pressed against a wall visibly does.
      const dx = x - this.position[0];
      const dz = z - this.position[2];
      this.moveToward(dx, dz, this.navSpeed);
      this.navActive = false;
    }
  }

  /**
   * Steer directly, ignoring the navigator. Used when the geometry is trivial
   * (strafing, fleeing, closing the last metre).
   * @param {number} dx direction X, not necessarily normalised
   * @param {number} dz direction Z
   * @param {number} [speedMul=1] speed multiplier
   * @returns {void}
   */
  moveToward(dx, dz, speedMul = 1) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) { this.moveDX = 0; this.moveDZ = 0; this.moveSpeed = 0; return; }
    this.moveDX = dx / len;
    this.moveDZ = dz / len;
    this.moveSpeed = this.baseSpeed() * clamp(finite(speedMul, 1), 0.1, 3);
  }

  /**
   * Ground speed this mob moves at right now — babies are quicker, water is
   * slower, panic is faster.
   * @returns {number} blocks per second
   */
  baseSpeed() {
    let s = this.def.speed;
    if (this.isBaby) s *= 1.25;
    if (this.inWater && !this.def.aquatic) s *= 0.6;
    return s;
  }

  /**
   * Cancel navigation and stand still.
   * @returns {void}
   */
  stopMoving() {
    this.navActive = false;
    this.moveDX = 0;
    this.moveDZ = 0;
    this.moveSpeed = 0;
  }

  /**
   * Point the head (and, slowly, the body) at a world position.
   * @param {number} x target X
   * @param {number} y target Y
   * @param {number} z target Z
   * @returns {void}
   */
  lookAt(x, y, z) {
    const dx = x - this.position[0];
    const dz = z - this.position[2];
    const flat = Math.hypot(dx, dz);
    if (flat > 1e-4) this.lookYaw = Math.atan2(dx, dz);
    this.headPitch = clamp(-Math.atan2(y - this.eyeY(), Math.max(flat, 1e-4)), -1.2, 1.2);
  }

  /**
   * Snap the body yaw at an entity, for attacks and staring contests.
   * @param {Object} other entity to face
   * @returns {void}
   */
  faceEntity(other) {
    if (!other || !other.position) return;
    const dx = other.position[0] - this.position[0];
    const dz = other.position[2] - this.position[2];
    if (Math.hypot(dx, dz) < 1e-4) return;
    const want = Math.atan2(dx, dz);
    this.bodyYaw += wrapAngle(want - this.bodyYaw) * 0.45;
    this.lookYaw = want;
  }

  /**
   * Jump, if the mob is standing on something.
   * @param {number} [strength=1] multiplier on the jump impulse
   * @returns {boolean} `true` when the jump happened
   */
  jump(strength = 1) {
    if (!this.onGround || this.def.flying || this.def.aquatic) return false;
    this.velocity[1] = JUMP_SPEED * clamp(finite(strength, 1), 0.2, 2);
    this.onGround = false;
    return true;
  }

  /**
   * Walk the current path: advance the waypoint cursor, produce a steering
   * direction, jump over steps, and give up when clearly stuck.
   * @param {number} dt seconds
   * @returns {void}
   */
  updateNavigation(dt) {
    if (!this.navActive || this.path === null) return;
    const path = this.path;
    if (this.pathIndex >= path.length) {
      this.navActive = false;
      this.path = null;
      return;
    }

    const wp = path[this.pathIndex];
    const tx = wp[0] + 0.5;
    const ty = wp[1];
    const tz = wp[2] + 0.5;
    const dx = tx - this.position[0];
    const dz = tz - this.position[2];
    const dy = ty - this.position[1];
    const flat2 = dx * dx + dz * dz;

    if (flat2 < 0.30 && Math.abs(dy) < 1.4) {
      this.pathIndex++;
      if (this.pathIndex >= path.length) {
        this.navActive = false;
        this.path = null;
        this.stopMoving();
      }
      return;
    }

    this.moveToward(dx, dz, this.navSpeed);
    this.lookAt(tx, this.eyeY(), tz);

    // Walk through doors rather than into them. Path smoothing may well have
    // deleted the waypoint that sat inside the doorway, so look at the cell the
    // mob is actually about to step into.
    if (this.def.canOpenDoors && this.world !== null) {
      const len = Math.sqrt(flat2) || 1;
      const ax = Math.floor(this.position[0] + (dx / len) * 0.8);
      const az = Math.floor(this.position[2] + (dz / len) * 0.8);
      const ay = Math.floor(this.position[1] + 0.2);
      if (DOOR_IDS.has(this.world.getBlock(ax, ay, az))) {
        this.useDoor(ax, ay, az, true, this.context());
      }
    }

    if (dy > 0.55 && this.onGround) this.jump();
    else if (this.def.canClimb && dy > 0.2 && !this.onGround && this.velocity[1] < 0.5) {
      this.velocity[1] = 2.4;
    }

    // Stuck detection: no meaningful progress for a second and a half means the
    // path is wrong, so throw it away and let the behaviour ask again.
    this.stuckTimer += dt;
    if (this.stuckTimer >= 1.5) {
      const moved = distSqXZ(this.position, this.stuckAnchor);
      this.stuckAnchor[0] = this.position[0];
      this.stuckAnchor[1] = this.position[1];
      this.stuckAnchor[2] = this.position[2];
      this.stuckTimer = 0;
      if (moved < 0.25) {
        this.path = null;
        this.navActive = false;
        this.navRepath = 0;
        this.jump();
      }
    }
  }

  /* ------------------------------------------------------------- movement */

  /**
   * Integrate one tick of physics: medium detection, gravity or buoyancy,
   * horizontal steering, the swept move, wall climbing and fall damage.
   * @param {number} dt seconds
   * @param {Object} world the chunk manager
   * @returns {void}
   */
  applyMovement(dt, world) {
    const def = this.def;
    const v = this.velocity;
    this.syncAABB();

    const liquid = isInLiquid(world, this.aabb, this._liquid);
    this.inWater = liquid.water;
    this.inLava = liquid.lava;
    this.submerged = liquid.submerged;

    const floats = def.flying || (def.aquatic && this.inWater);

    if (floats) {
      // Free flight / free swimming: only drag, no gravity.
      const k = Math.exp(-2.2 * dt);
      v[0] *= k; v[1] *= k; v[2] *= k;
      if (def.aquatic && !this.inWater) v[1] -= GRAVITY * 0.5 * dt;
    } else if (this.inWater) {
      // Buoyancy plus heavy drag; a non-aquatic mob bobs at the surface.
      const k = Math.exp(-4.5 * dt);
      v[0] *= k; v[2] *= k;
      v[1] = v[1] * k + (def.floatSpeed * this.submerged - GRAVITY * 0.25 * dt);
      v[1] = clamp(v[1], -6, def.floatSpeed);
    } else if (this.inLava) {
      const k = Math.exp(-8 * dt);
      v[0] *= k; v[2] *= k;
      v[1] = clamp(v[1] * k + 2.5 * this.submerged, -3, 3);
    } else {
      const g = GRAVITY * def.gravityScale;
      v[1] = Math.max(-TERMINAL_VELOCITY, v[1] - g * dt);
    }

    if (!this.directDrive && !floats) {
      const wantX = this.moveDX * this.moveSpeed;
      const wantZ = this.moveDZ * this.moveSpeed;
      const lambda = this.onGround ? 14 : (this.inWater ? 6 : 3.5);
      v[0] = damp(v[0], wantX, lambda, dt);
      v[2] = damp(v[2], wantZ, lambda, dt);
      if (this.moveSpeed === 0 && this.onGround) {
        const k = Math.exp(-11 * dt);
        v[0] *= k;
        v[2] *= k;
      }
    }

    const opts = this._moveOpts;
    opts.onGround = this.onGround;
    opts.autoStep = !def.flying && !def.aquatic;
    const res = moveWithCollisions(world, this.aabb, v, dt, this._move, opts);
    this.syncPosition();

    const wasOnGround = this.onGround;
    this.onGround = res.onGround;

    // Spider-style wall climbing: blocked horizontally while pushing into the
    // wall means going up instead of stopping.
    if (def.canClimb && (res.hitX || res.hitZ) && this.moveSpeed > 0.01) {
      v[1] = Math.max(v[1], 2.6);
      this.onGround = false;
    }
    if (this.isOnClimbable(world) && this.moveSpeed > 0.01) {
      v[1] = clamp(v[1], -1.5, 2.4);
    }

    // Fall damage, on the same 3-block threshold as the player.
    if (!def.flying && !def.aquatic) {
      if (this.onGround) {
        if (!wasOnGround && this.fallDistance > 3.0) {
          const amount = Math.floor(this.fallDistance - 3.0);
          if (amount > 0) this.damage(amount, { type: 'fall' });
        }
        this.fallDistance = 0;
        if (this.squash > 0) this.squash = Math.min(1, this.squash + 0.3);
      } else if (res.impactY < 0 || v[1] < 0) {
        this.fallDistance += Math.abs(v[1]) * dt;
      }
      if (this.inWater || this.inLava) this.fallDistance = 0;
    }

    // Auto-jump out of water and over a one-block ledge the navigator wants.
    if (this.inWater && !def.aquatic && this.moveSpeed > 0.01 && this.random() < 0.6) {
      v[1] = Math.max(v[1], def.floatSpeed * 0.8);
    }
    if (this.onGround && (res.hitX || res.hitZ) && this.moveSpeed > 0.01 && !def.canClimb) {
      if (this.random() < 0.5) this.jump();
    }

    this.bodyYaw = this.updateBodyYaw(dt);
  }

  /**
   * Turn the body towards where the mob is actually going (or looking when it
   * stands still), damped so it never snaps.
   * @param {number} dt seconds
   * @returns {number} the new body yaw in radians
   */
  updateBodyYaw(dt) {
    let want = this.bodyYaw;
    const speed2 = this.velocity[0] * this.velocity[0] + this.velocity[2] * this.velocity[2];
    if (speed2 > 0.02) want = Math.atan2(this.velocity[0], this.velocity[2]);
    else if (Number.isFinite(this.lookYaw)) want = this.lookYaw;
    return this.bodyYaw + wrapAngle(want - this.bodyYaw) * clamp(dt * 9, 0, 1);
  }

  /**
   * Whether the mob is hanging on a ladder, a vine or scaffolding.
   * @param {Object} world the chunk manager
   * @returns {boolean} `true` when climbing
   */
  isOnClimbable(world) {
    const id = world.getBlock(
      Math.floor(this.position[0]),
      Math.floor(this.position[1] + 0.2),
      Math.floor(this.position[2])
    );
    return BLOCK_CLIMB[id] === 1;
  }

  /**
   * Sunlight burning, drowning, lava and suffocation.
   * @param {number} dt seconds
   * @param {Object} ctx tick context
   * @returns {void}
   */
  updateEnvironmentDamage(dt, ctx) {
    const def = this.def;

    if (def.burnsInDaylight && !this.isBaby && this.isSunlit(ctx) && !this.inWater) {
      this.burningTimer = Math.max(this.burningTimer, 0.5);
    }
    if (this.burningTimer > 0) {
      this.burningTimer -= dt;
      if (this.inWater) this.burningTimer = 0;
      this.burnAccum += BURN_DPS * dt;
      if (this.burnAccum >= 1) {
        this.burnAccum -= 1;
        this.damage(1, { type: 'fire' });
      }
      if (ctx.particles && this.random() < dt * 8) {
        this.spawnParticles(ctx, 'flame', this.position[1] + this.height * 0.5, 1);
      }
    }

    if (this.inLava) {
      this.lavaAccum += dt;
      if (this.lavaAccum >= 0.5) {
        this.lavaAccum -= 0.5;
        this.damage(4, { type: 'lava' });
        this.burningTimer = Math.max(this.burningTimer, 8);
      }
    }

    // Water: aquatic mobs drown in air, everyone else drowns under water.
    const suffocating = def.aquatic ? !this.inWater : this.submerged > 0.85;
    if (suffocating) {
      this.drownTimer += dt;
      if (this.drownTimer >= 1) {
        this.drownTimer -= 1;
        this.damage(2, { type: 'drown' });
      }
    } else {
      this.drownTimer = 0;
    }

    if (this.position[1] < WORLD_MIN_Y - 16) this.damage(4, { type: 'void' });

    // Endermen take damage from water. The first contact hurts immediately —
    // they blink out on the very next tick, so a delayed tick would never fire.
    if (def.name === 'enderman' && this.inWater) {
      if (this.waterAccum <= 0) {
        this.damage(1, { type: 'drown' });
        this.teleportRequest = Math.max(this.teleportRequest, 2);
      }
      this.waterAccum += dt;
      if (this.waterAccum >= 0.5) this.waterAccum = 0;
    } else {
      this.waterAccum = 0;
    }
  }

  /* --------------------------------------------------------------- combat */

  /**
   * Set (or clear) the current target and reset the memory timer.
   * @param {?Object} entity the new target, or `null`
   * @returns {void}
   */
  setTarget(entity) {
    if (entity === this) return;
    if (this.target === entity) return;
    this.target = entity || null;
    this.targetMemory = this.target === null ? 0 : TARGET_MEMORY;
    if (this.target !== null) {
      this.path = null;
      this.navRepath = 0;
    }
  }

  /**
   * Swing at a target if the cooldown allows. Applies damage through the combat
   * system when one is available, and knockback either way.
   * @param {Object} target the entity to hit
   * @returns {boolean} `true` when the swing landed
   */
  attack(target) {
    if (this.attackTimer > 0 || target === null || !target.position) return false;
    const def = this.def;
    if (def.attackDamage <= 0) return false;
    this.attackTimer = def.attackCooldown;
    this.swinging = true;

    const damage = def.attackDamage * (this.isBaby ? 0.6 : 1);
    const dx = target.position[0] - this.position[0];
    const dz = target.position[2] - this.position[2];
    const len = Math.hypot(dx, dz) || 1;
    _scratchB[0] = (dx / len) * def.knockback;
    _scratchB[1] = 0.42 * def.knockback;
    _scratchB[2] = (dz / len) * def.knockback;

    const ctx = this.context();
    const combat = ctx && ctx.combat ? ctx.combat : null;
    let handled = false;
    if (combat !== null && typeof combat.dealDamage === 'function') {
      try {
        combat.dealDamage(target, damage, { type: 'mob', mob: this }, _scratchB);
        handled = true;
      } catch (e) {
        warnOnce('dealDamage', 'combat system rejected a mob attack', e);
      }
    }
    if (!handled && typeof target.damage === 'function') {
      try {
        target.damage(damage, { type: 'mob', mob: this });
      } catch (e) {
        warnOnce('targetDamage', 'target rejected damage from a mob', e);
      }
      if (target.velocity && target.velocity.length >= 3) {
        target.velocity[0] += _scratchB[0] * 4;
        target.velocity[1] = Math.max(target.velocity[1], _scratchB[1] * 8);
        target.velocity[2] += _scratchB[2] * 4;
      }
    }

    this.playSound(ctx, 'attack', 0.8);
    return true;
  }

  /**
   * Take damage. Armour, knockback resistance, invulnerability frames, the
   * hurt flash and death are all handled here — {@link Entity#damage} is
   * deliberately not called so a mob's damage rules can never drift.
   * @param {number} amount raw damage in half-hearts
   * @param {?Object} [source] `{type, mob, entity, player, knockback}`
   * @returns {boolean} `true` when damage was actually applied
   */
  damage(amount, source = null) {
    if (this.dead || this.dying) return false;
    const raw = finite(amount, 0);
    if (raw <= 0) return false;
    if (this.immunity > 0 && raw <= (this.lastDamage || 0)) return false;

    const reduced = raw * (1 - clamp(this.def.armor * 0.04, 0, 0.8));
    this.health -= reduced;
    this.lastDamage = raw;
    this.immunity = HURT_IMMUNITY;
    this.hurtTime = HURT_FLASH_TICKS;

    const ctx = this.context();
    this.playSound(ctx, 'hurt', 0.9);
    this.onHurt(source);

    if (this.health <= 0) {
      this.health = 0;
      this.die(source, ctx);
    }
    return true;
  }

  /**
   * React to being hurt: panic, retaliate, teleport, defuse.
   * @param {?Object} source damage source descriptor
   * @returns {void}
   */
  onHurt(source) {
    const def = this.def;
    const attacker = source && (source.mob || source.entity || source.player || null);

    // Knockback, scaled by the mob's own resistance.
    if (attacker && attacker.position && def.knockbackResistance < 1) {
      const dx = this.position[0] - attacker.position[0];
      const dz = this.position[2] - attacker.position[2];
      const len = Math.hypot(dx, dz) || 1;
      const k = (1 - def.knockbackResistance) * 5.5;
      this.velocity[0] += (dx / len) * k;
      this.velocity[2] += (dz / len) * k;
      if (this.onGround) this.velocity[1] = Math.max(this.velocity[1], 4.2);
      this.onGround = false;
    }

    // A creeper struck mid-fuse stops swelling.
    if (this.fuse > 0) this.fuse = Math.max(0, this.fuse - 0.75);

    // Endermen blink away from anything that touches them, projectiles included.
    if (def.name === 'enderman') this.teleportRequest = 3;

    if (attacker && attacker !== this) {
      if (def.hostile || def.neutral) {
        this.angerTimer = 20;
        this.setTarget(attacker);
      }
      if (!def.hostile) {
        this.panicSource = attacker;
        this.panicTimer = def.neutral ? 1.0 : 2.5 + this.random() * 2;
      }
      // A tamed wolf joins in whatever its owner is fighting.
      if (this.tamed) this.alertPack(attacker);
    } else if (!def.hostile) {
      this.panicSource = null;
      this.panicTimer = Math.max(this.panicTimer, 1.5);
    }

    this.loveTimer = 0;
  }

  /**
   * Tell nearby packmates (same owner, same species) to attack a target.
   * @param {Object} enemy the entity to gang up on
   * @returns {void}
   */
  alertPack(enemy) {
    const ctx = this.context();
    if (!ctx || !ctx.entities || typeof ctx.entities.queryRadius !== 'function') return;
    _queryOut.length = 0;
    let list = null;
    try {
      list = ctx.entities.queryRadius(this.position[0], this.position[1], this.position[2], 16, _queryOut);
    } catch (e) {
      return;
    }
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e === this || e.dead === true) continue;
      if (e.typeName !== this.typeName) continue;
      if (this.owner !== null && e.owner !== this.owner) continue;
      if (typeof e.setTarget === 'function' && e.target === null) {
        e.setTarget(enemy);
        e.angerTimer = 20;
      }
    }
  }

  /**
   * Order this mob's owner-controlled pack onto whatever the owner just hit.
   * Called by `game/combat.js` after a player attack.
   * @param {Object} enemy the entity the owner attacked
   * @returns {void}
   */
  onOwnerAttacked(enemy) {
    if (!this.tamed || this.sitting || !enemy || enemy === this) return;
    this.setTarget(enemy);
    this.angerTimer = 20;
  }

  /**
   * Begin dying: drop loot and XP now (so nothing is lost if the manager
   * removes the entity immediately) and start the death animation.
   * @param {?Object} source damage source
   * @param {Object} ctx tick context
   * @returns {void}
   */
  die(source, ctx) {
    if (this.dying) return;
    this.dying = true;
    this.deathTimer = 0;
    this.deathTime = 0;
    this.health = 0;
    this.target = null;
    this.path = null;
    this.navActive = false;
    if (this.ai !== null) this.ai.reset(ctx);
    this.playSound(ctx, 'death', 1.0);
    this.splitOnDeath(ctx);
    this.dropLoot(source, ctx);
    this.dropExperience(source, ctx);
    if (ctx && ctx.entities && typeof ctx.entities.emit === 'function') {
      try {
        ctx.entities.emit('mobDeath', this, source || null);
      } catch (e) {
        warnOnce('mobDeath', 'a mobDeath listener threw', e);
      }
    }
  }

  /**
   * Remove the mob from the world once the death animation has played.
   * @param {Object} ctx tick context
   * @returns {void}
   */
  remove(ctx) {
    this.dead = true;
    this.removed = true;
    const em = ctx ? ctx.entities : null;
    if (em && typeof em.remove === 'function' && this.id !== undefined) {
      try {
        em.remove(this.id);
        return;
      } catch (e) {
        warnOnce('remove', 'entity manager refused to remove a dead mob', e);
      }
    }
    if (typeof this.kill === 'function') {
      try {
        this.kill();
      } catch (e) {
        warnOnce('kill', 'Entity#kill threw on a dead mob; it stays flagged dead', e);
      }
    }
  }

  /**
   * Roll the loot table and drop the results as item entities.
   * @param {?Object} source damage source, for `playerOnly` and fire drops
   * @param {Object} ctx tick context
   * @returns {number} how many stacks were dropped
   */
  dropLoot(source, ctx) {
    const em = ctx ? ctx.entities : null;
    if (!em || typeof em.dropItem !== 'function') return 0;
    if (this.isBaby) return 0;
    const table = this.def.loot;
    const byPlayer = source !== null && source !== undefined
      && (source.type === 'player' || source.player !== undefined
        || (source.mob === undefined && source.type === undefined));
    const burned = this.burningTimer > 0 || (source && (source.type === 'fire' || source.type === 'lava'));
    const looting = source && Number.isFinite(source.looting) ? source.looting | 0 : 0;

    let dropped = 0;
    for (let i = 0; i < table.length; i++) {
      const row = table[i];
      if (row.playerOnly && !byPlayer) continue;
      if (this.random() > row.chance) continue;
      let name = row.item;
      if (burned && row.fire) {
        const cooked = `cooked_${name}`;
        if (itemId(cooked) > 0) name = cooked;
      }
      const id = itemId(name);
      if (id <= 0) continue;
      const extra = looting > 0 ? Math.floor(this.random() * (row.looting * looting + 1)) : 0;
      const span = Math.max(0, row.max - row.min);
      const count = row.min + Math.floor(this.random() * (span + 1)) + extra;
      if (count <= 0) continue;
      this.dropStack(em, new ItemStack(id, count));
      dropped++;
    }

    // The sheep's fleece is not a normal loot row: it only drops when unsheared.
    if (this.def.shearable && !this.sheared) {
      const woolId = itemId(WOOL_ITEM_NAMES[clamp(this.woolColor, 0, 15)]);
      if (woolId > 0) {
        this.dropStack(em, new ItemStack(woolId, 1));
        dropped++;
      }
    }

    // Whatever an enderman was carrying falls where it dies.
    if (this.carriedBlock !== 0) {
      const id = itemId(blockNameFor(this.carriedBlock));
      if (id > 0) this.dropStack(em, new ItemStack(id, 1));
      this.carriedBlock = 0;
    }
    return dropped;
  }

  /**
   * Drop one stack at the mob's chest height with a small random impulse.
   * @param {Object} em the entity manager
   * @param {ItemStack} stack the stack to drop
   * @returns {void}
   */
  dropStack(em, stack) {
    _scratchB[0] = (this.random() - 0.5) * 1.5;
    _scratchB[1] = 1.5 + this.random();
    _scratchB[2] = (this.random() - 0.5) * 1.5;
    try {
      em.dropItem(
        this.position[0],
        this.position[1] + this.height * 0.5,
        this.position[2],
        stack,
        _scratchB
      );
    } catch (e) {
      warnOnce('dropItem', 'entity manager could not drop mob loot', e);
    }
  }

  /**
   * Hand out the mob's experience. Uses whatever the entity manager or the
   * combat system offers, and otherwise announces it on the bus so the Game can
   * spawn the orbs itself.
   * @param {?Object} source damage source
   * @param {Object} ctx tick context
   * @returns {number} the amount awarded
   */
  dropExperience(source, ctx) {
    const xp = this.isBaby ? 0 : Math.round(this.def.xp);
    if (xp <= 0) return 0;
    const em = ctx ? ctx.entities : null;
    const x = this.position[0];
    const y = this.position[1] + this.height * 0.5;
    const z = this.position[2];
    try {
      if (em && typeof em.dropXP === 'function') { em.dropXP(x, y, z, xp); return xp; }
      if (em && typeof em.spawnXP === 'function') { em.spawnXP(x, y, z, xp); return xp; }
      if (em && typeof em.emit === 'function') { em.emit('dropXP', x, y, z, xp, this); return xp; }
    } catch (e) {
      warnOnce('dropXP', 'could not award mob experience', e);
    }
    return 0;
  }

  /* -------------------------------------------------------- special moves */

  /**
   * Fire the mob's projectile at a target, leading the shot by the target's own
   * velocity so a running player is actually hit.
   * @param {Object} target the entity to shoot at
   * @param {Object} ctx tick context
   * @returns {boolean} `true` when an arrow was spawned
   */
  fireProjectile(target, ctx) {
    const em = ctx ? ctx.entities : null;
    if (!em || typeof em.spawn !== 'function' || !target || !target.position) return false;

    const speed = 30;
    const ox = this.position[0];
    const oy = this.eyeY() - 0.1;
    const oz = this.position[2];

    // Lead prediction: solve for where the target will be when the arrow lands.
    let tx = target.position[0];
    let ty = target.position[1] + (target.eyeHeight === undefined ? 1.4 : target.eyeHeight) * 0.7;
    let tz = target.position[2];
    const flight = Math.hypot(tx - ox, ty - oy, tz - oz) / speed;
    if (target.velocity && target.velocity.length >= 3) {
      tx += target.velocity[0] * flight;
      ty += target.velocity[1] * flight * 0.5;
      tz += target.velocity[2] * flight;
    }
    // Compensate the arrow's own drop over the flight time.
    ty += 0.5 * GRAVITY * 0.05 * flight * flight;

    let dx = tx - ox;
    let dy = ty - oy;
    let dz = tz - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    dx = (dx / len) * speed;
    dy = (dy / len) * speed;
    dz = (dz / len) * speed;

    // Difficulty-scaled inaccuracy, so a skeleton is not a sniper.
    const spread = 0.6 / Math.max(1, finite(ctx.difficulty, 2));
    dx += (this.random() - 0.5) * spread;
    dy += (this.random() - 0.5) * spread;
    dz += (this.random() - 0.5) * spread;

    let arrow = null;
    try {
      arrow = new ArrowEntity(ox, oy, oz, dx, dy, dz, this);
    } catch (e) {
      warnOnce('arrow', 'ArrowEntity could not be constructed; ranged attacks disabled', e);
      return false;
    }
    if (arrow === null || arrow === undefined) return false;
    if (arrow.velocity && arrow.velocity.length >= 3) {
      arrow.velocity[0] = dx;
      arrow.velocity[1] = dy;
      arrow.velocity[2] = dz;
    } else {
      arrow.velocity = [dx, dy, dz];
    }
    arrow.owner = this;
    arrow.shooter = this;
    arrow.damage = 2 + finite(ctx.difficulty, 2) * 0.5;
    try {
      em.spawn(arrow);
    } catch (e) {
      warnOnce('arrowSpawn', 'entity manager refused an arrow', e);
      return false;
    }
    this.playSound(ctx, 'attack', 0.9);
    return true;
  }

  /**
   * Detonate. Uses the entity manager's explosion, which handles terrain
   * destruction, damage falloff and the particle burst.
   * @param {Object} ctx tick context
   * @returns {void}
   */
  explode(ctx) {
    const em = ctx ? ctx.entities : null;
    this.fuse = 0;
    this.swell = 0;
    const power = CREEPER_BLAST_POWER * (this.isBaby ? 0.6 : 1);
    if (em && typeof em.explode === 'function') {
      try {
        em.explode(this.position[0], this.position[1] + this.height * 0.5, this.position[2],
          power, { fire: false, destroy: true });
      } catch (e) {
        warnOnce('explode', 'entity manager could not create an explosion', e);
      }
    }
    // The creeper is consumed by its own blast and leaves its gunpowder.
    this.health = 0;
    this.die({ type: 'explosion' }, ctx);
    this.deathTimer = DEATH_SECONDS;
  }

  /**
   * Teleport to a random valid position within a radius, the enderman escape.
   * @param {number} radius maximum displacement in blocks
   * @param {Object} ctx tick context
   * @returns {boolean} `true` when a spot was found and taken
   */
  teleportRandom(radius, ctx) {
    const world = this.world;
    if (world === null) return false;
    const caps = normaliseCaps(this.pathCaps);
    for (let attempt = 0; attempt < 16; attempt++) {
      const x = Math.floor(this.position[0] + (this.random() * 2 - 1) * radius);
      const z = Math.floor(this.position[2] + (this.random() * 2 - 1) * radius);
      const top = typeof world.getHeight === 'function' ? world.getHeight(x, z) : this.position[1];
      const y = Math.floor(clamp(top + (this.random() * 6 - 3), WORLD_MIN_Y + 1, WORLD_MAX_Y - 4));
      for (let dy = 0; dy <= 4; dy++) {
        const ny = y - dy;
        if (!hasClearance(world, x, ny, z, caps)) continue;
        if (!isStandable(world, x, ny, z, caps)) continue;
        if (world.getBlock(x, ny, z) === ID_WATER) continue;
        this.spawnParticles(ctx, 'portal', this.position[1] + this.height * 0.5, 12);
        this.position[0] = x + 0.5;
        this.position[1] = ny;
        this.position[2] = z + 0.5;
        this.prevPosition[0] = this.position[0];
        this.prevPosition[1] = this.position[1];
        this.prevPosition[2] = this.position[2];
        this.velocity[0] = 0; this.velocity[1] = 0; this.velocity[2] = 0;
        this.syncAABB();
        this.path = null;
        this.navActive = false;
        this.fallDistance = 0;
        this.spawnParticles(ctx, 'portal', this.position[1] + this.height * 0.5, 12);
        this.playSound(ctx, 'special', 1.0);
        return true;
      }
    }
    return false;
  }

  /**
   * Teleport next to a position — the "tamed pet catches up" move.
   * @param {number} x target X
   * @param {number} y target Y
   * @param {number} z target Z
   * @param {number} spread search radius around the target
   * @returns {boolean} `true` when a spot was found
   */
  teleportNear(x, y, z, spread) {
    const world = this.world;
    if (world === null) return false;
    const caps = normaliseCaps(this.pathCaps);
    for (let attempt = 0; attempt < 12; attempt++) {
      const bx = Math.floor(x + (this.random() * 2 - 1) * spread);
      const bz = Math.floor(z + (this.random() * 2 - 1) * spread);
      for (let dy = 1; dy >= -2; dy--) {
        const by = Math.floor(y) + dy;
        if (!hasClearance(world, bx, by, bz, caps)) continue;
        if (!isStandable(world, bx, by, bz, caps)) continue;
        this.position[0] = bx + 0.5;
        this.position[1] = by;
        this.position[2] = bz + 0.5;
        this.prevPosition[0] = this.position[0];
        this.prevPosition[1] = this.position[1];
        this.prevPosition[2] = this.position[2];
        this.velocity[0] = 0; this.velocity[1] = 0; this.velocity[2] = 0;
        this.syncAABB();
        this.path = null;
        this.navActive = false;
        this.fallDistance = 0;
        return true;
      }
    }
    return false;
  }

  /**
   * Split a dying slime into two to four smaller ones, down to size 1.
   * @param {Object} ctx tick context
   * @returns {number} how many children were spawned
   */
  splitOnDeath(ctx) {
    if (this.def.name !== 'slime' || this.slimeSize <= 1) return 0;
    const em = ctx ? ctx.entities : null;
    if (!em || typeof em.spawn !== 'function') return 0;
    const childSize = this.slimeSize - 1;
    const count = 2 + Math.floor(this.random() * 2);
    let made = 0;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + this.random();
      const r = 0.4 + this.slimeSize * 0.2;
      const child = new Mob('slime',
        this.position[0] + Math.sin(angle) * r,
        this.position[1] + 0.1,
        this.position[2] + Math.cos(angle) * r);
      child.setSlimeSize(childSize);
      child.velocity[0] = Math.sin(angle) * 2.5;
      child.velocity[1] = 3.5;
      child.velocity[2] = Math.cos(angle) * 2.5;
      try {
        em.spawn(child);
        made++;
      } catch (e) {
        warnOnce('slimeSplit', 'could not spawn a slime child', e);
        break;
      }
    }
    return made;
  }

  /**
   * Enderman: lift the block it is standing next to.
   * @param {Object} ctx tick context
   * @returns {boolean} `true` when a block was taken
   */
  pickUpBlock(ctx) {
    const world = this.world;
    if (world === null || this.carriedBlock !== 0) return false;
    if (typeof world.setBlock !== 'function') return false;
    const ox = Math.floor(this.position[0]);
    const oy = Math.floor(this.position[1]);
    const oz = Math.floor(this.position[2]);
    const flip = this.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < NEIGHBOR_DIRS.length; i += 2) {
      const cx = ox + NEIGHBOR_DIRS[i] * flip;
      const cz = oz + NEIGHBOR_DIRS[i + 1] * flip;
      for (let dy = 0; dy >= -1; dy--) {
        const id = world.getBlock(cx, oy + dy, cz);
        if (id === 0 || ENDERMAN_CARRIABLE.indexOf(id) < 0) continue;
        world.setBlock(cx, oy + dy, cz, 0);
        this.carriedBlock = id;
        this.spawnParticles(ctx, 'portal', this.position[1] + this.height * 0.6, 4);
        return true;
      }
    }
    return false;
  }

  /**
   * Enderman: set the carried block down again on a free surface.
   * @param {Object} ctx tick context
   * @returns {boolean} `true` when the block was placed
   */
  placeCarriedBlock(ctx) {
    const world = this.world;
    if (world === null || this.carriedBlock === 0) return false;
    if (typeof world.setBlock !== 'function') return false;
    const ox = Math.floor(this.position[0]);
    const oy = Math.floor(this.position[1]);
    const oz = Math.floor(this.position[2]);
    const flip = this.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < NEIGHBOR_DIRS.length; i += 2) {
      const cx = ox + NEIGHBOR_DIRS[i] * flip;
      const cz = oz + NEIGHBOR_DIRS[i + 1] * flip;
      for (let dy = 0; dy >= -2; dy--) {
        const here = world.getBlock(cx, oy + dy, cz);
        const below = world.getBlock(cx, oy + dy - 1, cz);
        if (here !== 0) continue;
        if (BLOCK_FLOOR[below] !== 1) continue;
        world.setBlock(cx, oy + dy, cz, this.carriedBlock);
        this.carriedBlock = 0;
        this.spawnParticles(ctx, 'portal', this.position[1] + this.height * 0.6, 4);
        return true;
      }
    }
    return false;
  }

  /* ----------------------------------------------------- husbandry / farm */

  /**
   * Look for an edible grass block under the sheep and remember where it is.
   * @param {Object} slot receiver with `bx`, `by`, `bz` fields
   * @returns {boolean} `true` when there is grass to eat
   */
  findGrassUnderfoot(slot) {
    const world = this.world;
    if (world === null || typeof world.setBlock !== 'function') return false;
    const x = Math.floor(this.position[0]);
    const z = Math.floor(this.position[2]);
    const y = Math.floor(this.position[1]);
    // A tall plant at foot level first, then the grass block below.
    const here = world.getBlock(x, y, z);
    if (GRASS_IDS.has(here) && here !== B.GRASS_BLOCK) {
      slot.bx = x; slot.by = y; slot.bz = z;
      return true;
    }
    const below = world.getBlock(x, y - 1, z);
    if (below === B.GRASS_BLOCK) {
      slot.bx = x; slot.by = y - 1; slot.bz = z;
      return true;
    }
    return false;
  }

  /**
   * Eat the grass at a block: a plant is removed, a grass block becomes dirt,
   * and the sheep's wool grows back.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {Object} ctx tick context
   * @returns {boolean} `true` when something was eaten
   */
  consumeGrass(x, y, z, ctx) {
    const world = this.world;
    if (world === null || typeof world.setBlock !== 'function') return false;
    const id = world.getBlock(x, y, z);
    if (!GRASS_IDS.has(id)) return false;
    try {
      world.setBlock(x, y, z, id === B.GRASS_BLOCK ? (B.DIRT === undefined ? 0 : B.DIRT) : 0);
    } catch (e) {
      warnOnce('eatGrass', 'sheep could not modify the world', e);
      return false;
    }
    this.sheared = false;
    if (this.isBaby && this.growthTimer > 0) this.growthTimer = Math.max(0, this.growthTimer - 60);
    this.spawnParticles(ctx, 'break', y + 1.05, 8);
    return true;
  }

  /**
   * Shear this mob, dropping its wool.
   * @param {Object} ctx tick context
   * @returns {boolean} `true` when wool came off
   */
  shear(ctx) {
    if (!this.def.shearable || this.sheared || this.isBaby) return false;
    this.sheared = true;
    const em = ctx ? ctx.entities : null;
    if (em && typeof em.dropItem === 'function') {
      const id = itemId(WOOL_ITEM_NAMES[clamp(this.woolColor, 0, 15)]);
      if (id > 0) this.dropStack(em, new ItemStack(id, 1 + Math.floor(this.random() * 3)));
    }
    this.playSound(ctx, 'special', 0.9);
    return true;
  }

  /**
   * Try to tame this mob with the item a player is holding.
   * @param {Object} player the player doing the taming
   * @param {Object} ctx tick context
   * @returns {boolean} `true` when the attempt succeeded
   */
  tryTame(player, ctx) {
    if (!this.def.tameable || this.tamed) return false;
    const held = readHeldItemId(player);
    const foods = this.def.tameFood;
    if (held <= 0 || foods === null) return false;
    let match = false;
    for (let i = 0; i < foods.length; i++) if (itemId(foods[i]) === held) { match = true; break; }
    if (!match) return false;

    // A third of the time the animal accepts; otherwise it just eats the treat.
    if (this.random() < 0.34) {
      this.tamed = true;
      this.owner = playerIdOf(player);
      this.sitting = false;
      this.health = this.maxHealth;
      this.setTarget(null);
      this.panicTimer = 0;
      this.spawnParticles(ctx, 'heart', this.position[1] + this.height, 7);
      this.playSound(ctx, 'special', 1.0);
      return true;
    }
    this.spawnParticles(ctx, 'smoke', this.position[1] + this.height, 5);
    return false;
  }

  /**
   * Toggle the sit command on a tamed animal.
   * @param {boolean} [value] explicit state; omitted toggles
   * @returns {boolean} the new sitting state
   */
  setSitting(value) {
    if (!this.tamed) return false;
    this.sitting = value === undefined ? !this.sitting : value === true;
    if (this.sitting) {
      this.stopMoving();
      this.setTarget(null);
    }
    return this.sitting;
  }

  /**
   * Feed this mob to start love mode, or to heal a tamed pet.
   * @param {Object} player the feeding player
   * @param {Object} ctx tick context
   * @returns {boolean} `true` when the food was accepted
   */
  feed(player, ctx) {
    const held = readHeldItemId(player);
    if (held <= 0) return false;
    const foods = this.def.breedFood;
    if (foods === null) return this.tryTame(player, ctx);
    let match = false;
    for (let i = 0; i < foods.length; i++) if (itemId(foods[i]) === held) { match = true; break; }
    if (!match) return this.tryTame(player, ctx);

    if (this.tamed && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + 4);
      this.spawnParticles(ctx, 'heart', this.position[1] + this.height, 4);
      return true;
    }
    if (this.isBaby) {
      this.growthTimer = Math.max(0, this.growthTimer - this.def.growUpSeconds * 0.1);
      this.spawnParticles(ctx, 'heart', this.position[1] + this.height, 3);
      return true;
    }
    if (!this.def.breedable || this.breedCooldown > 0 || this.loveTimer > 0) return false;
    this.loveTimer = 30;
    this.spawnParticles(ctx, 'heart', this.position[1] + this.height, 7);
    return true;
  }

  /**
   * Spawn the baby of a successful breeding and put both parents on cooldown.
   * @param {Mob} partner the other parent
   * @param {Object} ctx tick context
   * @returns {?Mob} the baby, or `null` when it could not be spawned
   */
  produceBaby(partner, ctx) {
    const em = ctx ? ctx.entities : null;
    this.loveTimer = 0;
    partner.loveTimer = 0;
    this.breedCooldown = 300;
    partner.breedCooldown = 300;
    if (!em || typeof em.spawn !== 'function') return null;

    const baby = new Mob(this.typeName,
      (this.position[0] + partner.position[0]) * 0.5,
      this.position[1],
      (this.position[2] + partner.position[2]) * 0.5);
    baby.setBaby(true);
    if (this.def.shearable) {
      baby.woolColor = this.random() < 0.5 ? this.woolColor : partner.woolColor;
    }
    if (this.tamed && partner.tamed) {
      baby.tamed = true;
      baby.owner = this.owner;
    }
    try {
      em.spawn(baby);
    } catch (e) {
      warnOnce('breed', 'entity manager refused a baby mob', e);
      return null;
    }
    this.spawnParticles(ctx, 'heart', this.position[1] + this.height, 7);
    this.dropBreedingXP(ctx);
    return baby;
  }

  /**
   * Award the small experience drop breeding gives.
   * @param {Object} ctx tick context
   * @returns {void}
   */
  dropBreedingXP(ctx) {
    const em = ctx ? ctx.entities : null;
    if (!em) return;
    const xp = 1 + Math.floor(this.random() * 7);
    try {
      if (typeof em.dropXP === 'function') em.dropXP(this.position[0], this.position[1] + 0.5, this.position[2], xp);
      else if (typeof em.emit === 'function') em.emit('dropXP', this.position[0], this.position[1] + 0.5, this.position[2], xp, this);
    } catch (e) {
      warnOnce('breedXP', 'could not award breeding experience', e);
    }
  }

  /**
   * Resolve the owner entity of a tamed mob from the tick context.
   * @param {Object} ctx tick context
   * @returns {?Object} the owner, or `null`
   */
  resolveOwner(ctx) {
    if (!this.tamed || this.owner === null || !ctx) return null;
    const player = ctx.player;
    if (player && playerIdOf(player) === this.owner && player.dead !== true) return player;
    return null;
  }

  /**
   * Open the door this mob is about to walk through. VOXELIA stores door state
   * outside the block id, so the actual toggle belongs to whoever owns that
   * state: this reports the intent on the entity bus, plays the sound, and uses
   * `world.setBlockState` when the world offers one.
   * @param {number} x door X
   * @param {number} y door Y
   * @param {number} z door Z
   * @param {boolean} open desired state
   * @param {Object} ctx tick context
   * @returns {boolean} `true` when the request was delivered
   */
  useDoor(x, y, z, open, ctx) {
    const world = this.world;
    if (world === null) return false;
    if (!DOOR_IDS.has(world.getBlock(x, y, z))) return false;
    let delivered = false;
    if (typeof world.setBlockState === 'function') {
      try {
        world.setBlockState(x, y, z, open ? 1 : 0);
        delivered = true;
      } catch (e) {
        warnOnce('door', 'world rejected a door state change', e);
      }
    }
    const em = ctx ? ctx.entities : null;
    if (em && typeof em.emit === 'function') {
      try {
        em.emit('mobUseDoor', this, x, y, z, open);
        delivered = true;
      } catch (e) {
        warnOnce('doorEvent', 'a mobUseDoor listener threw', e);
      }
    }
    if (delivered && ctx && ctx.audio && typeof ctx.audio.play === 'function') {
      try {
        ctx.audio.play('door', { x: x + 0.5, y: y + 0.5, z: z + 0.5, volume: 0.7 });
      } catch (e) {
        warnOnce('doorSound', 'audio engine rejected the door sound', e);
      }
    }
    return delivered;
  }

  /* -------------------------------------------------------------- effects */

  /**
   * Play one of this mob's sounds, positioned at its head.
   * @param {Object} ctx tick context
   * @param {string} kind `idle`, `hurt`, `death`, `attack`, `step` or `special`
   * @param {number} [volume=1] linear volume
   * @returns {void}
   */
  playSound(ctx, kind, volume = 1) {
    const audio = ctx ? ctx.audio : null;
    if (!audio || typeof audio.play !== 'function') return;
    try {
      audio.play(mobSound(this.typeName, kind), {
        x: this.position[0],
        y: this.position[1] + this.height * 0.7,
        z: this.position[2],
        volume,
        pitch: this.isBaby ? 1.5 : 1,
      });
    } catch (e) {
      warnOnce('audio', 'audio engine rejected a mob sound', e);
    }
  }

  /**
   * Emit a small particle burst at the mob.
   * @param {Object} ctx tick context
   * @param {string} type particle type name understood by `render/particles.js`
   * @param {number} y world Y of the burst
   * @param {number} count number of particles
   * @returns {void}
   */
  spawnParticles(ctx, type, y, count) {
    const p = ctx ? ctx.particles : null;
    if (!p || typeof p.spawn !== 'function') return;
    try {
      p.spawn(type, this.position[0], y, this.position[2], { count, spread: this.width });
    } catch (e) {
      warnOnce('particles', 'particle system rejected a mob emission', e);
    }
  }

  /* -------------------------------------------------------- serialisation */

  /**
   * Snapshot the mob for the save file.
   * @returns {Object} a plain, JSON-safe object
   */
  serialize() {
    return {
      kind: 'mob',
      type: this.typeName,
      x: this.position[0],
      y: this.position[1],
      z: this.position[2],
      vx: this.velocity[0],
      vy: this.velocity[1],
      vz: this.velocity[2],
      yaw: this.bodyYaw,
      health: this.health,
      baby: this.isBaby,
      growth: this.growthTimer,
      slimeSize: this.slimeSize,
      tamed: this.tamed,
      owner: this.owner,
      sitting: this.sitting,
      sheared: this.sheared,
      wool: this.woolColor,
      profession: this.profession,
      home: this.home === null ? null : [this.home[0], this.home[1], this.home[2]],
      breedCooldown: this.breedCooldown,
      carried: this.carriedBlock,
      age: this.age,
    };
  }

  /**
   * Restore a mob from {@link Mob#serialize}.
   * @param {Object} o the snapshot
   * @returns {?Mob} the restored mob, or `null` when the snapshot is unusable
   */
  static deserialize(o) {
    if (!o || typeof o.type !== 'string' || !isKnownMob(o.type)) return null;
    const mob = new Mob(o.type, finite(o.x, 0), finite(o.y, 0), finite(o.z, 0));
    mob.velocity[0] = finite(o.vx, 0);
    mob.velocity[1] = finite(o.vy, 0);
    mob.velocity[2] = finite(o.vz, 0);
    mob.bodyYaw = finite(o.yaw, 0);
    mob.modelYaw = mob.bodyYaw;
    if (o.slimeSize !== undefined && mob.def.name === 'slime') mob.setSlimeSize(o.slimeSize);
    if (o.baby === true) mob.setBaby(true);
    mob.growthTimer = finite(o.growth, mob.growthTimer);
    mob.health = clamp(finite(o.health, mob.maxHealth), 0.1, mob.maxHealth);
    mob.tamed = o.tamed === true;
    mob.owner = typeof o.owner === 'string' ? o.owner : null;
    mob.sitting = o.sitting === true;
    mob.sheared = o.sheared === true;
    mob.woolColor = clamp(finite(o.wool, 0) | 0, 0, 15);
    mob.profession = typeof o.profession === 'string' ? o.profession : null;
    mob.home = Array.isArray(o.home) && o.home.length >= 3
      ? [finite(o.home[0], 0), finite(o.home[1], 0), finite(o.home[2], 0)] : null;
    mob.breedCooldown = Math.max(0, finite(o.breedCooldown, 0));
    mob.carriedBlock = clamp(finite(o.carried, 0) | 0, 0, BLOCK_COUNT - 1);
    mob.age = Math.max(0, finite(o.age, 0));
    mob.syncAABB();
    return mob;
  }
}

/** Shared empty context so `update` never has to null-check its argument. @type {Object} */
const EMPTY_CTX = Object.freeze({
  world: null, player: null, entities: null, environment: null,
  audio: null, particles: null, combat: null, difficulty: 2,
});

/**
 * The most recent tick context any mob was updated with.
 *
 * A mob can be damaged *before* its own `update` runs — combat resolves earlier
 * in the tick, and a mob spawned this tick has never seen a context at all.
 * Without this its loot, experience and death sound would silently vanish, so
 * damage falls back to the context the rest of the world is using.
 * @type {Object}
 */
let SHARED_CTX = EMPTY_CTX;

/**
 * Publish the tick context up front, so a mob killed before its first update
 * still drops its loot. `game/game.js` may call this once per tick; otherwise
 * the first {@link Mob#update} of the tick sets it.
 * @param {Object} ctx the tick context
 * @returns {void}
 */
export function setMobContext(ctx) {
  if (ctx && typeof ctx === 'object') SHARED_CTX = ctx;
}

/**
 * Read the item id a player is holding, across the shapes the inventory can
 * take. Returns `0` when nothing usable is held.
 * @param {Object} player the player
 * @returns {number} item id, `0` for empty hands
 */
function readHeldItemId(player) {
  if (!player) return 0;
  let stack = null;
  const inv = player.inventory;
  if (inv) {
    if (typeof inv.getSelected === 'function') stack = inv.getSelected();
    else if (typeof inv.get === 'function' && Number.isFinite(player.selectedSlot)) {
      stack = inv.get(player.selectedSlot | 0);
    }
  }
  if (stack === null || stack === undefined) stack = player.heldItem || null;
  if (!stack) return 0;
  if (typeof stack.isEmpty === 'function' && stack.isEmpty()) return 0;
  const id = stack.itemId !== undefined ? stack.itemId : stack.id;
  return Number.isFinite(id) ? id | 0 : 0;
}

/**
 * Block name for a block id, used when an enderman's cargo becomes an item.
 * @param {number} id block id
 * @returns {string} the snake_case block name, or an empty string
 */
function blockNameFor(id) {
  for (const key of Object.keys(B)) {
    if (B[key] === id) return key.toLowerCase();
  }
  return '';
}

/**
 * A stable identity string for a player, used as a pet's owner key.
 * @param {Object} player the player
 * @returns {?string} the id, or `null` when the player has none
 */
function playerIdOf(player) {
  if (!player) return null;
  if (typeof player.uuid === 'string') return player.uuid;
  if (typeof player.name === 'string') return player.name;
  if (player.id !== undefined) return String(player.id);
  return 'player';
}

/* ========================================================================== */
/* Behaviour assembly                                                         */
/* ========================================================================== */

/**
 * Build the behaviour list for a mob. This is the only place the species of a
 * creature matters: after this the AI is pure priority scheduling.
 * @param {Mob} mob the mob to equip
 * @returns {Behavior[]} its behaviours, in any order
 */
export function buildBehaviorsFor(mob) {
  const def = mob.def;
  /** @type {Behavior[]} */
  const list = [];

  list.push(new PanicOnHurtBehavior(def.hostile ? 1.2 : 1.6));
  if (def.sunAvoid > 0 && def.name !== 'enderman') list.push(new AvoidSunBehavior());

  if (def.aquatic || def.flying) {
    list.push(new SwimWanderBehavior());
  } else {
    list.push(new WanderBehavior(def.hostile ? 12 : 8, def.hostile ? 1 : 0.8,
      def.hostile ? 0.12 : 0.06));
  }

  list.push(new LookAtPlayerBehavior(def.hostile ? 12 : 8));
  list.push(new IdleBehavior());

  if (def.attackDamage > 0) list.push(new MeleeAttackBehavior(def.hostile ? 1.1 : 1));
  if (def.breedable) list.push(new BreedBehavior());
  if (def.breedFood !== null || def.tameFood !== null) list.push(new FollowFoodBehavior(10));
  if (def.breedable || def.tameable) list.push(new FollowParentBehavior());

  switch (def.name) {
    case 'creeper':
      list.push(new CreeperFuseBehavior());
      // Cats and ocelots send a creeper running.
      list.push(new AvoidEntityBehavior(
        (e) => e.typeName === 'cat' || e.typeName === 'ocelot' || e.type === 'cat' || e.type === 'ocelot',
        8, 1.5, 98
      ));
      break;

    case 'skeleton':
      list.push(new RangedAttackBehavior(8, 15, 1.0));
      break;

    case 'witch':
      list.push(new RangedAttackBehavior(4, 10, 1.6));
      break;

    case 'enderman':
      list.push(new TeleportAwayBehavior());
      list.push(new CarryBlockBehavior());
      break;

    case 'slime':
      list.push(new SlimeBounceBehavior());
      break;

    case 'wolf':
    case 'cat':
      list.push(new SitBehavior());
      list.push(new FollowOwnerBehavior(3, 8, 20));
      break;

    case 'sheep':
      list.push(new EatGrassBehavior());
      break;

    case 'villager':
      list.push(new VillagerRoutineBehavior(24));
      list.push(new AvoidEntityBehavior(
        (e) => e.def !== undefined && e.def.hostile === true && e.dead !== true,
        12, 1.4, 90
      ));
      break;

    case 'fox':
    case 'rabbit':
      list.push(new AvoidEntityBehavior(
        (e) => e.type === 'player' || e.isPlayer === true,
        8, 1.5, 78
      ));
      break;

    default:
      break;
  }

  return list;
}

/**
 * The village professions a naturally spawned villager can take, with their
 * German labels for the HUD.
 * @type {ReadonlyArray<{key:string, display:string}>}
 */
export const VILLAGER_PROFESSIONS = Object.freeze([
  { key: 'farmer', display: 'Bauer' },
  { key: 'librarian', display: 'Bibliothekar' },
  { key: 'toolsmith', display: 'Werkzeugschmied' },
  { key: 'weaponsmith', display: 'Waffenschmied' },
  { key: 'butcher', display: 'Metzger' },
  { key: 'cartographer', display: 'Kartograf' },
  { key: 'cleric', display: 'Kleriker' },
  { key: 'fisherman', display: 'Fischer' },
  { key: 'fletcher', display: 'Pfeilmacher' },
  { key: 'shepherd', display: 'Schäfer' },
  { key: 'nitwit', display: 'Tölpel' },
]);

/**
 * German display name of a villager profession key.
 * @param {?string} key profession key
 * @returns {string} the label, or an empty string for `null`
 */
export function professionDisplay(key) {
  if (!key) return '';
  for (let i = 0; i < VILLAGER_PROFESSIONS.length; i++) {
    if (VILLAGER_PROFESSIONS[i].key === key) return VILLAGER_PROFESSIONS[i].display;
  }
  return key;
}

/* ========================================================================== */
/* Mob construction                                                           */
/* ========================================================================== */

/**
 * Create a fully randomised mob of a type: sheep get a natural fleece colour,
 * slimes a size, villagers a profession, and a share of farm animals are born
 * as babies.
 *
 * @param {string} type mob type name, a key of {@link MOB_TYPES}
 * @param {number} x spawn X
 * @param {number} y spawn Y (feet)
 * @param {number} z spawn Z
 * @param {{baby?:boolean, slimeSize?:number, rng?:()=>number,
 *          profession?:string, home?:number[]}} [opts] overrides
 * @returns {?Mob} the mob, or `null` for an unknown type
 */
export function createMob(type, x, y, z, opts = {}) {
  if (!isKnownMob(type)) {
    warnOnce(`create:${type}`, `createMob("${type}") ignored: unknown mob type`);
    return null;
  }
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const mob = new Mob(type, x, y, z);
  const def = mob.def;

  if (def.name === 'slime') {
    mob.setSlimeSize(opts.slimeSize === undefined ? 1 + Math.floor(rng() * 3) : opts.slimeSize);
  }

  if (def.shearable) {
    let total = 0;
    for (let i = 0; i < SHEEP_COLOR_WEIGHTS.length; i++) total += SHEEP_COLOR_WEIGHTS[i].weight;
    let roll = rng() * total;
    for (let i = 0; i < SHEEP_COLOR_WEIGHTS.length; i++) {
      roll -= SHEEP_COLOR_WEIGHTS[i].weight;
      if (roll <= 0) { mob.woolColor = SHEEP_COLOR_WEIGHTS[i].color; break; }
    }
  }

  if (def.name === 'villager') {
    mob.profession = typeof opts.profession === 'string'
      ? opts.profession
      : VILLAGER_PROFESSIONS[Math.floor(rng() * VILLAGER_PROFESSIONS.length)].key;
    mob.home = [Math.floor(x), Math.floor(y), Math.floor(z)];
  }
  if (opts.home && opts.home.length >= 3) {
    mob.home = [opts.home[0], opts.home[1], opts.home[2]];
  }

  const wantsBaby = opts.baby === undefined
    ? (def.breedable && rng() < 0.05)
    : opts.baby === true;
  if (wantsBaby) mob.setBaby(true);

  mob.bodyYaw = rng() * Math.PI * 2;
  mob.modelYaw = mob.bodyYaw;
  return mob;
}

/* ========================================================================== */
/* MobSpawner                                                                 */
/* ========================================================================== */

/**
 * @typedef {Object} SpawnCandidate
 * @property {string} name mob type name
 * @property {number} weight selection weight from the biome table
 * @property {number} min minimum pack size
 * @property {number} max maximum pack size
 * @property {MobDef} def the resolved definition
 */

/**
 * Natural mob spawning and despawning.
 *
 * Every {@link SPAWN_INTERVAL} it picks random positions in loaded chunks
 * between {@link SPAWN_MIN_DISTANCE} and {@link SPAWN_MAX_DISTANCE} of the
 * player, resolves a floor (or a water column, or open air), and checks the
 * candidate against the biome's own mob table, the block and sky light, the
 * surface/cave requirement and the per-category population cap. Successful
 * attempts spawn a small **pack**, not a single mob.
 *
 * Passive mobs are not spawned on this loop at all: they arrive with the
 * terrain via {@link MobSpawner#populateChunk}, which `world/world.js` calls
 * when a chunk is generated for the first time.
 */
export class MobSpawner {
  /**
   * @param {Object} world the chunk manager
   * @param {Object} entityManager the entity manager
   */
  constructor(world, entityManager) {
    /** @type {Object} */
    this.world = world;
    /** @type {Object} */
    this.entities = entityManager;
    /** @type {boolean} master switch; the Game flips this on peaceful */
    this.enabled = true;
    /** @type {number} multiplier on every population cap */
    this.capScale = 1;
    /** @type {number} seconds until the next spawn round */
    this.spawnTimer = 0;
    /** @type {number} seconds until the next despawn sweep */
    this.despawnTimer = 0;
    /** @type {() => number} deterministic RNG, seeded from the world */
    this.rng = mulberry32(((world && Number.isFinite(world.seed) ? world.seed : 12345) ^ 0x9e3779b9) >>> 0);
    /** @type {Object<string, number>} live population per category */
    this.counts = { hostile: 0, passive: 0, ambient: 0, water: 0 };
    /** @type {number} mobs alive in total, refreshed every round */
    this.total = 0;
    /** @type {SpawnCandidate[]} scratch candidate list, reused every round */
    this._candidates = [];
    /** @type {number} how many mobs this spawner has created */
    this.spawnedTotal = 0;
    /** @type {number} how many mobs this spawner has despawned */
    this.despawnedTotal = 0;
    /** @type {Set<string>} chunk keys already populated with passive mobs */
    this._populated = new Set();
  }

  /* --------------------------------------------------------------- caps */

  /**
   * Population cap for a category, scaled by how much world is actually
   * loaded — a small render distance means fewer mobs, not the same mobs
   * crammed into less space.
   * @param {string} category one of {@link SPAWN_CATEGORY}
   * @returns {number} the cap, at least 1
   */
  getMobCap(category) {
    const base = MOB_CAPS[category];
    if (base === undefined) return 0;
    const loaded = this.world && this.world.chunks ? this.world.chunks.size : 289;
    const scale = clamp(loaded / 289, 0.25, 2.0);
    return Math.max(1, Math.round(base * scale * this.capScale));
  }

  /**
   * Recount the live population per category.
   * @returns {Object<string, number>} the `counts` record
   */
  countCategories() {
    const counts = this.counts;
    counts.hostile = 0;
    counts.passive = 0;
    counts.ambient = 0;
    counts.water = 0;
    this.total = 0;
    const em = this.entities;
    if (!em || !em.entities || typeof em.entities.forEach !== 'function') return counts;
    em.entities.forEach((e) => {
      if (!e || e.dead === true || e.def === undefined || e.def.category === undefined) return;
      const c = e.def.category;
      if (counts[c] !== undefined) counts[c]++;
      this.total++;
    });
    return counts;
  }

  /* -------------------------------------------------------------- update */

  /**
   * Run the spawn and despawn loops. Safe to call every tick; the work is
   * gated by its own timers.
   * @param {number} dt seconds since the last tick
   * @param {?Object} player the local player
   * @param {?Object} environment the time/weather state
   * @returns {void}
   */
  update(dt, player, environment) {
    const step = clamp(finite(dt, 0), 0, 0.25);
    if (step <= 0) return;
    try {
      this.despawnTimer -= step;
      if (this.despawnTimer <= 0) {
        this.despawnTimer = DESPAWN_INTERVAL;
        this.despawnPass(player);
      }
      if (!this.enabled) return;
      this.spawnTimer -= step;
      if (this.spawnTimer > 0) return;
      this.spawnTimer = SPAWN_INTERVAL;
      if (!player || !player.position) return;
      this.countCategories();
      this.spawnRound(player, environment);
    } catch (e) {
      warnOnce('spawner', 'mob spawner failed; natural spawning disabled', e);
      this.enabled = false;
    }
  }

  /* --------------------------------------------------------------- spawn */

  /**
   * One round of spawn attempts: a handful of random positions, each of which
   * may turn into a pack.
   * @param {Object} player the player to spawn around
   * @param {?Object} environment the environment state
   * @returns {number} how many mobs were spawned
   */
  spawnRound(player, environment) {
    const world = this.world;
    if (!world || typeof world.getBlock !== 'function') return 0;
    let spawned = 0;
    const attempts = 12;
    for (let i = 0; i < attempts; i++) {
      spawned += this.attemptSpawn(player, environment);
    }
    return spawned;
  }

  /**
   * A single spawn attempt at one random position.
   * @param {Object} player the player to spawn around
   * @param {?Object} environment the environment state
   * @returns {number} how many mobs were spawned
   */
  attemptSpawn(player, environment) {
    const world = this.world;
    const rng = this.rng;

    // A random point in the annulus [24, 128] around the player.
    const angle = rng() * Math.PI * 2;
    const radius = SPAWN_MIN_DISTANCE + rng() * (SPAWN_MAX_DISTANCE - SPAWN_MIN_DISTANCE);
    const x = Math.floor(player.position[0] + Math.sin(angle) * radius);
    const z = Math.floor(player.position[2] + Math.cos(angle) * radius);
    const cx = x >> 4;
    const cz = z >> 4;
    if (typeof world.isLoaded === 'function' && !world.isLoaded(cx, cz)) return 0;

    const biomeId = typeof world.getBiome === 'function' ? world.getBiome(x, z) : 0;
    const biome = getBiome(biomeId);
    if (!biome) return 0;

    const candidate = this.pickCandidate(biome);
    if (candidate === null) return 0;
    const def = candidate.def;

    const y = this.findSpawnY(x, z, def);
    if (y === null) return 0;
    if (!this.isValidSpawn(def, x, y, z, biome, player, environment)) return 0;

    // Packs, not singles: place the leader, then scatter the rest nearby.
    const packMin = Math.max(candidate.min, def.packSize[0]);
    const packMax = Math.max(packMin, Math.min(candidate.max, def.packSize[1]));
    const want = packMin + Math.floor(rng() * (packMax - packMin + 1));
    const cap = this.getMobCap(def.category);
    let made = 0;

    for (let i = 0; i < want; i++) {
      if (this.counts[def.category] >= cap) break;
      let px = x;
      let pz = z;
      if (i > 0) {
        px = x + Math.round((rng() * 2 - 1) * 5);
        pz = z + Math.round((rng() * 2 - 1) * 5);
      }
      const py = i === 0 ? y : this.findSpawnY(px, pz, def);
      if (py === null) continue;
      if (i > 0 && !this.isValidSpawn(def, px, py, pz, biome, player, environment)) continue;
      const mob = this.spawnMob(def.name, px + 0.5, py, pz + 0.5);
      if (mob === null) continue;
      made++;
      this.counts[def.category]++;
    }
    return made;
  }

  /**
   * Choose a mob from a biome's own spawn table, weighted, restricted to types
   * this module actually implements and to categories that are under their cap.
   * @param {Object} biome the biome definition
   * @returns {?SpawnCandidate} the chosen candidate, or `null`
   */
  pickCandidate(biome) {
    const list = this._candidates;
    list.length = 0;
    const entries = biome.mobs;
    if (!Array.isArray(entries) || entries.length === 0) return null;

    let total = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const def = getMobType(entry.name);
      if (def === null) continue;
      // Passive animals arrive with the terrain, not on this loop.
      if (def.category === SPAWN_CATEGORY.PASSIVE) continue;
      const category = BIOME_GROUP_CATEGORY[entry.group] || def.category;
      if (category !== def.category) continue;
      if (this.counts[def.category] >= this.getMobCap(def.category)) continue;
      if (!canSpawnInBiome(def, biome.name)) continue;
      const weight = Math.max(1, finite(entry.weight, 10));
      total += weight;
      list.push({
        name: entry.name,
        weight,
        min: Math.max(1, finite(entry.min, 1) | 0),
        max: Math.max(1, finite(entry.max, 4) | 0),
        def,
      });
    }
    if (list.length === 0) return null;

    let roll = this.rng() * total;
    for (let i = 0; i < list.length; i++) {
      roll -= list[i].weight;
      if (roll <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  /**
   * Find a Y at which a mob of this definition could stand (or float, or fly)
   * in a column.
   * @param {number} x column X
   * @param {number} z column Z
   * @param {MobDef} def the mob definition
   * @returns {?number} the spawn Y, or `null` when the column has no room
   */
  findSpawnY(x, z, def) {
    const world = this.world;
    const caps = normaliseCaps(pathCapsFor(def, 1));
    const surface = typeof world.getHeight === 'function' ? world.getHeight(x, z) : SEA_LEVEL;

    if (def.placement === 'water') {
      const lo = clamp(def.spawnY[0], WORLD_MIN_Y + 1, WORLD_MAX_Y - 4);
      const hi = clamp(Math.min(def.spawnY[1], SEA_LEVEL), lo, WORLD_MAX_Y - 4);
      for (let attempt = 0; attempt < 8; attempt++) {
        const y = lo + Math.floor(this.rng() * (hi - lo + 1));
        if (world.getBlock(x, y, z) !== ID_WATER) continue;
        if (world.getBlock(x, y + 1, z) !== ID_WATER) continue;
        return y;
      }
      return null;
    }

    if (def.surface === true) {
      const y = surface;
      if (y <= WORLD_MIN_Y || y >= WORLD_MAX_Y - 3) return null;
      if (!hasClearance(world, x, y, z, caps)) return null;
      if (!isStandable(world, x, y, z, caps)) return null;
      return y;
    }

    const lo = clamp(def.spawnY[0], WORLD_MIN_Y + 1, WORLD_MAX_Y - 4);
    const hi = clamp(Math.min(def.spawnY[1], surface + 4), lo, WORLD_MAX_Y - 4);
    if (hi <= lo) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = lo + Math.floor(this.rng() * (hi - lo + 1));
      // Scan down for the first floor with room above it: a start inside solid
      // rock simply fails, a start in open air finds the ground under it.
      for (let d = 0; d < 48; d++) {
        const y = start - d;
        if (y <= WORLD_MIN_Y) break;
        if (!hasClearance(world, x, y, z, caps)) continue;
        if (!isStandable(world, x, y, z, caps)) continue;
        return y;
      }
    }
    return null;
  }

  /**
   * The full spawn rule check: distance, light, biome, medium and crowding.
   * @param {MobDef} def the mob definition
   * @param {number} x spawn X
   * @param {number} y spawn Y
   * @param {number} z spawn Z
   * @param {Object} biome the biome definition
   * @param {Object} player the player
   * @param {?Object} environment the environment state
   * @returns {boolean} `true` when the position is legal
   */
  isValidSpawn(def, x, y, z, biome, player, environment) {
    const world = this.world;
    if (y <= WORLD_MIN_Y || y >= WORLD_MAX_Y - 2) return false;

    const dx = (x + 0.5) - player.position[0];
    const dy = y - player.position[1];
    const dz = (z + 0.5) - player.position[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < SPAWN_MIN_DISTANCE * SPAWN_MIN_DISTANCE) return false;
    if (d2 > SPAWN_MAX_DISTANCE * SPAWN_MAX_DISTANCE) return false;

    if (!canSpawnInBiome(def, biome.name)) return false;

    // Light: block light and time-scaled sky light, whichever is brighter.
    let block = 0;
    if (typeof world.getBlockLight === 'function') {
      const rgb = world.getBlockLight(x, y, z, _lightOut);
      block = Math.max(rgb[0], rgb[1], rgb[2]);
    }
    let sky = typeof world.getSkyLight === 'function' ? world.getSkyLight(x, y, z) : 15;
    const rawSky = sky;
    if (environment && typeof environment.getLightLevel === 'function') {
      sky = sky * clamp(environment.getLightLevel() / 15, 0, 1);
    }
    const light = Math.max(block, sky);
    if (light < def.light[0] || light > def.light[1]) return false;

    // Surface / cave requirement, judged on the *raw* sky light so it does not
    // change with the time of day.
    if (def.surface === true && rawSky < 15) return false;
    if (def.surface === false && rawSky > 0) return false;

    // Medium.
    const here = world.getBlock(x, y, z);
    if (def.placement === 'water') {
      if (here !== ID_WATER) return false;
    } else if (!def.aquatic) {
      if (here === ID_WATER && !def.canSwim) return false;
      if (here === ID_LAVA) return false;
      if (BLOCK_DANGER[here] === 1) return false;
      const below = world.getBlock(x, y - 1, z);
      if (BLOCK_DANGER[below] === 1) return false;
    }

    // Crowding: never stack a pack on top of an existing one.
    if (this.countNearby(x, y, z, 8, def.name) >= 6) return false;
    return true;
  }

  /**
   * Count the passive animals living around a point, the local density limit
   * that replaces the global cap for world-gen population.
   * @param {number} x centre X
   * @param {number} y centre Y
   * @param {number} z centre Z
   * @param {number} radius radius in blocks
   * @returns {number} the count
   */
  countPassiveNearby(x, y, z, radius) {
    const em = this.entities;
    if (!em || typeof em.queryRadius !== 'function') return 0;
    _queryOut.length = 0;
    let list = null;
    try {
      list = em.queryRadius(x, y, z, radius, _queryOut);
    } catch (e) {
      return 0;
    }
    if (!list) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.def === undefined || e.dead === true) continue;
      if (e.def.category !== SPAWN_CATEGORY.PASSIVE) continue;
      n++;
    }
    return n;
  }

  /**
   * Count mobs of a type within a radius.
   * @param {number} x centre X
   * @param {number} y centre Y
   * @param {number} z centre Z
   * @param {number} radius radius in blocks
   * @param {?string} type type name, or `null` for any mob
   * @returns {number} the count
   */
  countNearby(x, y, z, radius, type) {
    const em = this.entities;
    if (!em || typeof em.queryRadius !== 'function') return 0;
    _queryOut.length = 0;
    let list = null;
    try {
      list = em.queryRadius(x, y, z, radius, _queryOut);
    } catch (e) {
      return 0;
    }
    if (!list) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.def === undefined || e.dead === true) continue;
      if (type !== null && e.typeName !== type) continue;
      n++;
    }
    return n;
  }

  /**
   * Create and register a mob at a position, bypassing every spawn rule. This
   * is the entry point for spawn eggs, structures and commands.
   * @param {string} type mob type name
   * @param {number} x world X (footprint centre)
   * @param {number} y world Y (feet)
   * @param {number} z world Z (footprint centre)
   * @param {Object} [opts] forwarded to {@link createMob}
   * @returns {?Mob} the spawned mob, or `null` when it could not be created
   */
  spawnMob(type, x, y, z, opts = {}) {
    const mob = createMob(type, x, y, z, { rng: this.rng, ...opts });
    if (mob === null) return null;
    const em = this.entities;
    if (!em || typeof em.spawn !== 'function') return null;
    try {
      em.spawn(mob);
    } catch (e) {
      warnOnce('spawn', 'entity manager refused a mob spawn', e);
      return null;
    }
    this.spawnedTotal++;
    return mob;
  }

  /* ------------------------------------------------------------- despawn */

  /**
   * Remove mobs the player has walked away from: instantly past 128 blocks, and
   * with a small chance per sweep past 32.
   * @param {?Object} player the player
   * @returns {number} how many mobs were removed
   */
  despawnPass(player) {
    const em = this.entities;
    if (!em || !em.entities || typeof em.entities.forEach !== 'function') return 0;
    if (!player || !player.position) return 0;
    const doomed = [];
    em.entities.forEach((e) => {
      if (!e || e.def === undefined || e.dead === true || e.dying === true) return;
      if (!e.def.despawns) return;
      if (e.tamed === true || e.persistent === true || e.customName) return;
      const d2 = distSq3(e.position, player.position);
      if (d2 > DESPAWN_HARD_DISTANCE * DESPAWN_HARD_DISTANCE) { doomed.push(e); return; }
      if (d2 > DESPAWN_SOFT_DISTANCE * DESPAWN_SOFT_DISTANCE && this.rng() < DESPAWN_SOFT_CHANCE) {
        doomed.push(e);
      }
    });
    for (let i = 0; i < doomed.length; i++) {
      const e = doomed[i];
      e.dead = true;
      e.removed = true;
      try {
        if (typeof em.remove === 'function' && e.id !== undefined) em.remove(e.id);
      } catch (err) {
        warnOnce('despawn', 'entity manager refused a despawn', err);
      }
      this.despawnedTotal++;
    }
    return doomed.length;
  }

  /* ------------------------------------------------- world-gen population */

  /**
   * Populate a freshly generated chunk with its passive animals.
   *
   * `world/world.js` calls this once per chunk, on `'chunkLoaded'`. Passive
   * mobs never spawn on the continuous loop, which is exactly why a herd of
   * cows stays where the world put it instead of appearing behind the player.
   *
   * @param {Object} chunk the chunk, with `cx` and `cz`
   * @returns {number} how many animals were placed
   */
  populateChunk(chunk) {
    if (!chunk || !this.world || !this.entities) return 0;
    const key = `${chunk.cx},${chunk.cz}`;
    if (this._populated.has(key)) return 0;
    this._populated.add(key);
    if (this._populated.size > 8192) this._populated.clear();

    const rng = this.rng;
    // Only a small share of chunks carries a herd at all.
    if (rng() > 0.12) return 0;

    const world = this.world;
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    const x = baseX + Math.floor(rng() * CHUNK_SIZE);
    const z = baseZ + Math.floor(rng() * CHUNK_SIZE);
    const biomeId = typeof world.getBiome === 'function' ? world.getBiome(x, z) : 0;
    const biome = getBiome(biomeId);
    if (!biome || !Array.isArray(biome.mobs)) return 0;

    // Weighted pick among the biome's own passive entries.
    let total = 0;
    const pool = [];
    for (let i = 0; i < biome.mobs.length; i++) {
      const entry = biome.mobs[i];
      const def = getMobType(entry.name);
      if (def === null || def.category !== SPAWN_CATEGORY.PASSIVE) continue;
      if (!canSpawnInBiome(def, biome.name)) continue;
      const weight = Math.max(1, finite(entry.weight, 10));
      total += weight;
      pool.push({ def, entry, weight });
    }
    if (pool.length === 0) return 0;
    let roll = rng() * total;
    let chosen = pool[pool.length - 1];
    for (let i = 0; i < pool.length; i++) {
      roll -= pool[i].weight;
      if (roll <= 0) { chosen = pool[i]; break; }
    }

    const def = chosen.def;
    // World-gen animals are deliberately *not* subject to the global passive
    // cap: they never despawn, so a global cap would freeze animal generation
    // for the rest of the world's life after the first ten cows. The real limit
    // is local crowding, checked here.
    if (this.countPassiveNearby(x, 64, z, 24) >= 10) return 0;

    const min = Math.max(def.packSize[0], finite(chosen.entry.min, 2) | 0);
    const max = Math.max(min, Math.min(def.packSize[1], finite(chosen.entry.max, 4) | 0));
    const want = min + Math.floor(rng() * (max - min + 1));
    const caps = normaliseCaps(pathCapsFor(def, 1));

    let made = 0;
    for (let i = 0; i < want; i++) {
      const px = x + Math.round((rng() * 2 - 1) * 4);
      const pz = z + Math.round((rng() * 2 - 1) * 4);
      const py = typeof world.getHeight === 'function' ? world.getHeight(px, pz) : SEA_LEVEL;
      if (py <= WORLD_MIN_Y || py >= WORLD_MAX_Y - 3) continue;
      if (!hasClearance(world, px, py, pz, caps)) continue;
      if (!isStandable(world, px, py, pz, caps)) continue;
      if (world.getBlock(px, py, pz) === ID_WATER) continue;
      const mob = this.spawnMob(def.name, px + 0.5, py, pz + 0.5);
      if (mob === null) continue;
      made++;
      this.counts[def.category]++;
    }
    return made;
  }

  /**
   * Attach to a world's chunk events so passive mobs are placed automatically.
   * Call once, after both the world and the entity manager exist.
   * @returns {void}
   */
  attachToWorld() {
    const world = this.world;
    if (!world || typeof world.on !== 'function') return;
    if (this._boundChunk !== undefined) return;
    /** @type {(chunk:Object)=>void} */
    this._boundChunk = (chunk) => {
      try {
        this.populateChunk(chunk);
      } catch (e) {
        warnOnce('populate', 'chunk population failed; passive spawning disabled', e);
      }
    };
    world.on('chunkLoaded', this._boundChunk);
  }

  /**
   * Detach the chunk listener and forget the population history.
   * @returns {void}
   */
  dispose() {
    const world = this.world;
    if (world && typeof world.off === 'function' && this._boundChunk !== undefined) {
      world.off('chunkLoaded', this._boundChunk);
    }
    this._boundChunk = undefined;
    this._populated.clear();
    this._candidates.length = 0;
  }

  /**
   * Live spawner statistics for the F3 overlay.
   * @returns {{hostile:number, passive:number, ambient:number, water:number,
   *   total:number, caps:Object<string, number>, spawned:number, despawned:number}}
   *   the current numbers
   */
  getStats() {
    return {
      hostile: this.counts.hostile,
      passive: this.counts.passive,
      ambient: this.counts.ambient,
      water: this.counts.water,
      total: this.total,
      caps: {
        hostile: this.getMobCap('hostile'),
        passive: this.getMobCap('passive'),
        ambient: this.getMobCap('ambient'),
        water: this.getMobCap('water'),
      },
      spawned: this.spawnedTotal,
      despawned: this.despawnedTotal,
    };
  }
}

export default MOB_TYPES;
