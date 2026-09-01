/**
 * VOXELIA — villagers: professions, trading, village life and iron golems.
 *
 * `game/mobs.js` owns the villager *creature* — its model, its stats, its A*
 * navigation and its behaviour scheduler. This module owns everything that
 * makes a villager a *person*: the job it claims, the bed it sleeps in, the
 * offers it trades, the reputation it keeps about the player, and the iron
 * golem a big enough village calls for help.
 *
 * ============================================================================
 * 1. LAYERING ON THE EXISTING AI
 * ============================================================================
 * The AI is **not** forked. `buildBehaviorsFor()` already gives every villager
 * panic, wander, look-at-player, breeding, and an `AvoidEntityBehavior` that
 * makes it run from hostiles. {@link attachVillagerBehaviors} pushes four more
 * {@link Behavior} objects into the *same* `mob.ai.behaviors` list and re-sorts
 * it, so the priority scheduler in `MobAI#update` keeps doing the arbitration:
 *
 *   70  `VillagerRestBehavior`    sleep in the claimed bed, or head indoors
 *   36  `VillagerMeetingBehavior` gather at the meeting point in the afternoon
 *   34  `VillagerWorkBehavior`    work the claimed workstation by day
 *
 * They sit below panic (100) and the hostile-avoidance (90) that mobs.js
 * installs, and above wander (30) and the stock village routine (28) — which is
 * exactly the vanilla ordering: a villager runs from a zombie before it goes to
 * bed, and goes to bed before it wanders.
 *
 * ============================================================================
 * 2. PER-VILLAGER DATA AND IDENTITY
 * ============================================================================
 * `Mob#serialize` has no room for a trade list, so every villager carries a
 * {@link VillagerData} record in this module's registry, reachable from the mob
 * as `mob.villagerData`. Each record owns a stable `uid`. On load the records
 * are parked in a pending map and adopted by the first villager that shows up
 * with a matching uid — or, when the mob snapshot predates this module, by the
 * nearest villager to the record's stored position. A villager that finds no
 * record simply gets a fresh one, so a world can gain this module mid-save
 * without losing anything.
 *
 * ============================================================================
 * 3. POINTS OF INTEREST
 * ============================================================================
 * Workstations, beds and the meeting point are found by a **sliced search**:
 * a villager without a claim posts a job, and the manager scans exactly one
 * horizontal layer of that job's box per tick, under the shared
 * {@link TimeBudget}. A full 17x7x17 search therefore costs seven ticks of a
 * few hundred array reads instead of one 2000-block stall, and the whole
 * village settles within a second or two. Claims are exclusive: a `Map` from a
 * packed block position to the owning villager uid, released when the villager
 * dies or the block disappears.
 *
 * ============================================================================
 * 4. TRADING
 * ============================================================================
 * Each profession has five tiers ({@link TRADE_LEVELS}); a villager unlocks the
 * next tier by earning trade experience. An offer's price moves with two
 * modifiers, both vanilla:
 *
 *   *demand*     — an offer used a lot before a restock gets more expensive;
 *   *reputation* — trading with a villager makes it like the player, and a
 *                  liked villager discounts every offer it has.
 *
 * Offers restock **twice a day** — once in the morning, once around midday —
 * and only while the villager is standing at its own workstation.
 * {@link TradingSession} is the object the UI drives; it never touches block or
 * entity state itself, so a screen can be opened and closed freely.
 *
 * ============================================================================
 * 5. EVENTS
 * ============================================================================
 *   'assigned'   (mob, professionKey)      villager took a job
 *   'claimBed'   (mob, x, y, z)            villager claimed a bed
 *   'claimWork'  (mob, x, y, z)            villager claimed a workstation
 *   'work'       (mob, x, y, z)            villager worked its station
 *   'harvest'    (mob, x, y, z, cropKey)   a farmer reaped a ripe crop
 *   'sow'        (mob, x, y, z)            a farmer sowed bare farmland
 *   'restock'    (mob)                     offers were refilled
 *   'openTrade'  (mob, player)             a trading screen was opened
 *   'trade'      (mob, offer, player)      a trade went through
 *   'levelUp'    (mob, level)              villager reached a new tier
 *   'fed'        (mob, food)               the player handed over food
 *   'sleep'      (mob, sleeping)           villager went to / got out of bed
 *   'census'     (count, beds, x, y, z, freeBeds)  a village was measured
 *   'golem'      (golem, x, y, z)          a village summoned an iron golem
 *   'breed'      (mobA, mobB)              two villagers entered love mode
 *
 * Nothing in this module throws out of `tick()`.
 *
 * @module game/villagers
 */

import { EventBus, TimeBudget } from '../core/util.js';
import { clamp, mulberry32 } from '../core/math.js';
import { B, isSolid, isOpaque } from '../world/blocks.js';
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../world/chunk.js';
import { itemIdByName, itemDisplay } from '../game/items.js';
import { ItemStack } from '../game/inventory.js';
import { Behavior, AvoidEntityBehavior, createMob } from '../game/mobs.js';
import { ENCHANT, maxLevel as enchantMaxLevel, enchantmentDisplay } from '../game/enchanting.js';
import { BlockView, resolveBlock, resolveItem, isMatureCrop, cropFamilyOf } from '../game/farming.js';

/* ========================================================================== */
/* Local helpers                                                              */
/* ========================================================================== */

/** @type {Set<string>} Keys already reported by {@link warnOnce}. */
const WARNED = new Set();

/**
 * Log a problem exactly once per key.
 * @param {string} key De-duplication key.
 * @param {string} msg Human readable message (English — this is a log, not UI).
 * @param {*} [err] Optional error object.
 * @returns {void}
 */
function warnOnce(key, msg, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err !== undefined) console.warn(`[VOXELIA/villagers] ${msg}`, err);
  else console.warn(`[VOXELIA/villagers] ${msg}`);
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
 * Packed key of a block position, used for claim maps.
 * @param {number} x World X.
 * @param {number} y World Y.
 * @param {number} z World Z.
 * @returns {string} A stable key.
 */
function posKey(x, y, z) {
  return `${x | 0},${y | 0},${z | 0}`;
}

/**
 * Squared horizontal + vertical distance between a mob and a block position.
 * @param {number[]} pos Entity position.
 * @param {number[]} block Block position `[x, y, z]`.
 * @returns {number} Squared distance.
 */
function distSqTo(pos, block) {
  const dx = pos[0] - (block[0] + 0.5);
  const dy = pos[1] - block[1];
  const dz = pos[2] - (block[2] + 0.5);
  return dx * dx + dy * dy + dz * dz;
}

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Save format version of {@link VillagerManager#serialize}. @type {number} */
export const VILLAGER_SAVE_VERSION = 1;

/** Milliseconds the villager tick may consume. @type {number} */
export const DEFAULT_BUDGET_MS = 1.4;

/** Radius in blocks a villager searches for a workstation or bed. @type {number} */
export const POI_RADIUS = 8;

/** Vertical reach of a point-of-interest search. @type {number} */
export const POI_HEIGHT = 3;

/** Blocks within which a villager counts as standing at a claimed block. @type {number} */
export const POI_REACH = 2.4;

/** Seconds between two point-of-interest searches for the same villager. @type {number} */
export const POI_RETRY_SECONDS = 8;

/** Radius that groups villagers into one village. @type {number} */
export const VILLAGE_RADIUS = 20;

/** Villagers a village needs before it summons an iron golem. @type {number} */
export const IRON_GOLEM_MIN_VILLAGERS = 5;

/** Beds a village needs before it summons an iron golem. @type {number} */
export const IRON_GOLEM_MIN_BEDS = 3;

/** No second golem is summoned within this radius. @type {number} */
export const IRON_GOLEM_SPACING = 32;

/** Seconds a village waits between two golem summons. @type {number} */
export const IRON_GOLEM_COOLDOWN = 300;

/** Seconds between two village censuses. @type {number} */
export const CENSUS_INTERVAL = 5;

/** Food points a villager needs before it is willing to breed. @type {number} */
export const BREED_FOOD_THRESHOLD = 6;

/** Seconds of love mode a willing villager pair receives. @type {number} */
export const BREED_LOVE_SECONDS = 24;

/** Seconds a villager waits between two breeding attempts. @type {number} */
export const BREED_INTERVAL = 60;

/** Reputation gained per completed trade. @type {number} */
export const REPUTATION_PER_TRADE = 1;

/** Reputation lost when the player hurts a villager. @type {number} */
export const REPUTATION_ON_HURT = 8;

/** Hard bounds on a player's reputation with one villager. @type {number} */
export const REPUTATION_LIMIT = 30;

/** Reputation decays by this much per in-game day. @type {number} */
export const REPUTATION_DECAY_PER_DAY = 2;

/** How strongly reputation moves a price, per point. @type {number} */
export const REPUTATION_PRICE_WEIGHT = 0.05;

/** Largest number of items an offer may ever ask for. @type {number} */
export const MAX_PRICE = 64;

/** Restocks a villager may perform per in-game day. @type {number} */
export const RESTOCKS_PER_DAY = 2;

/** Seconds a villager keeps working its station before it takes a break. @type {number} */
export const WORK_SESSION_SECONDS = 24;

/** Seconds a villager rests between two work sessions. @type {number} */
export const WORK_BREAK_SECONDS = 14;

/** Seconds between two farmer field inspections. @type {number} */
export const FARM_SCAN_INTERVAL = 4;

/** Radius in blocks a farmer tends. @type {number} */
export const FARM_RADIUS = 6;

/**
 * Time of day at which villagers gather at the meeting point. `timeOfDay` runs
 * `0 = sunrise`, `0.5 = sunset`, so this window is the late afternoon — the
 * last stretch of daylight before {@link VillagerRestBehavior} takes over.
 * @type {number}
 */
export const MEETING_START = 0.36;

/** Time of day at which the gathering breaks up. @type {number} */
export const MEETING_END = 0.48;

/**
 * The five trade tiers, with the total experience each one needs.
 * @type {ReadonlyArray<{key:string, display:string, xp:number}>}
 */
export const TRADE_LEVELS = Object.freeze([
  Object.freeze({ key: 'novice', display: 'Neuling', xp: 0 }),
  Object.freeze({ key: 'apprentice', display: 'Lehrling', xp: 10 }),
  Object.freeze({ key: 'journeyman', display: 'Geselle', xp: 70 }),
  Object.freeze({ key: 'expert', display: 'Experte', xp: 150 }),
  Object.freeze({ key: 'master', display: 'Meister', xp: 250 }),
]);

/** Highest trade level. @type {number} */
export const MAX_TRADE_LEVEL = TRADE_LEVELS.length;

/** Currency of every trade. @type {number} */
export const EMERALD_ITEM = resolveItem('emerald');

/** Block a villager sleeps in. @type {number} */
export const BED_BLOCK = resolveBlock('red_bed', 'bed', 'white_bed', 'red_wool');

/** Block a village gathers around. @type {number} */
export const MEETING_BLOCK = resolveBlock('bell', 'lantern');

/* ========================================================================== */
/* Trade definitions                                                          */
/* ========================================================================== */

/**
 * @typedef {Object} TradeDef
 * @property {{item:number, count:number}} inputA  First price slot.
 * @property {?{item:number, count:number}} inputB Optional second price slot.
 * @property {{item:number, count:number}} output  What the villager hands over.
 * @property {number} maxUses     Trades before the offer runs dry.
 * @property {number} xp          Villager experience per trade.
 * @property {number} priceMultiplier How strongly demand and reputation move the price.
 * @property {?{id:string, level:number}} enchant Enchantment put on the output.
 */

/** Trade definitions that referenced a missing item, for diagnostics. @type {string[]} */
const DROPPED_TRADES = [];

/**
 * Build one trade definition, returning `null` when an item is missing from
 * this build's registry (the offer is then simply not published).
 * @param {string} inName Item the player pays with.
 * @param {number} inCount How many.
 * @param {string} outName Item the villager hands over.
 * @param {number} outCount How many.
 * @param {{maxUses?:number, xp?:number, priceMultiplier?:number,
 *   second?:[string, number], enchant?:[string, number]}} [opts] Extras.
 * @returns {?TradeDef} The definition, or `null`.
 */
function trade(inName, inCount, outName, outCount, opts = {}) {
  const inItem = itemIdByName(inName);
  const outItem = itemIdByName(outName);
  if (inItem <= 0 || outItem <= 0) {
    DROPPED_TRADES.push(`${inName}->${outName}`);
    return null;
  }
  let second = null;
  if (Array.isArray(opts.second)) {
    const id = itemIdByName(opts.second[0]);
    if (id <= 0) {
      DROPPED_TRADES.push(`${inName}+${opts.second[0]}->${outName}`);
      return null;
    }
    second = { item: id, count: Math.max(1, opts.second[1] | 0) };
  }
  let enchant = null;
  if (Array.isArray(opts.enchant)) {
    enchant = { id: opts.enchant[0], level: Math.max(1, opts.enchant[1] | 0) };
  }
  return Object.freeze({
    inputA: Object.freeze({ item: inItem, count: clamp(inCount | 0, 1, MAX_PRICE) }),
    inputB: second === null ? null : Object.freeze(second),
    output: Object.freeze({ item: outItem, count: clamp(outCount | 0, 1, 64) }),
    maxUses: Math.max(1, num(opts.maxUses, 12) | 0),
    xp: Math.max(0, num(opts.xp, 2) | 0),
    priceMultiplier: clamp(num(opts.priceMultiplier, 0.05), 0, 1),
    enchant: enchant === null ? null : Object.freeze(enchant),
  });
}

/**
 * The villager buys `count` of an item and pays emeralds.
 * @param {string} name Item the player sells.
 * @param {number} count How many the villager wants.
 * @param {number} emeralds Emeralds paid.
 * @param {Object} [opts] Extras forwarded to {@link trade}.
 * @returns {?TradeDef} The definition.
 */
function buys(name, count, emeralds, opts = {}) {
  return trade(name, count, 'emerald', emeralds, opts);
}

/**
 * The villager sells an item for emeralds.
 * @param {number} emeralds Emeralds the player pays.
 * @param {string} name Item handed over.
 * @param {number} count How many.
 * @param {Object} [opts] Extras forwarded to {@link trade}.
 * @returns {?TradeDef} The definition.
 */
function sells(emeralds, name, count, opts = {}) {
  return trade('emerald', emeralds, name, count, opts);
}

/**
 * Assemble the five tiers of a profession, dropping unavailable offers.
 * @param {Array<Array<?TradeDef>>} tiers Five arrays of definitions.
 * @returns {ReadonlyArray<ReadonlyArray<TradeDef>>} The cleaned table.
 */
function tierTable(tiers) {
  const out = [];
  for (let i = 0; i < MAX_TRADE_LEVEL; i++) {
    const list = (tiers[i] || []).filter((t) => t !== null && t !== undefined);
    out.push(Object.freeze(list));
  }
  return Object.freeze(out);
}

/**
 * @typedef {Object} Profession
 * @property {string} key            Internal key.
 * @property {string} display        German display name.
 * @property {string[]} stationNames Workstation block names, best first.
 * @property {number} station        Resolved workstation block id.
 * @property {ReadonlyArray<ReadonlyArray<TradeDef>>} tiers Offers per level.
 */

/**
 * Register one profession.
 * @param {string} key Internal key.
 * @param {string} display German display name.
 * @param {string[]} stationNames Workstation block candidates.
 * @param {Array<Array<?TradeDef>>} tiers Five tiers of offers.
 * @returns {Profession} The frozen profession.
 */
function defineProfession(key, display, stationNames, tiers) {
  return Object.freeze({
    key,
    display,
    stationNames: Object.freeze(stationNames.slice()),
    station: resolveBlock(...stationNames),
    tiers: tierTable(tiers),
  });
}

/**
 * The twelve professions, each with its workstation block, its German label
 * and five tiers of offers.
 *
 * Workstation blocks are resolved through a preference list: the real block
 * when this build has it, otherwise a distinct existing stand-in, so every
 * profession always owns exactly one block id nobody else claims.
 *
 * @type {ReadonlyArray<Profession>}
 */
export const PROFESSIONS = Object.freeze([

  defineProfession('farmer', 'Bauer', ['composter', 'hay_block'], [
    [buys('wheat', 20, 1, { maxUses: 16, xp: 2 }),
      buys('potato', 26, 1, { maxUses: 16, xp: 2 }),
      sells(1, 'bread', 6, { maxUses: 16, xp: 1 })],
    [buys('pumpkin', 6, 1, { maxUses: 12, xp: 5 }),
      sells(1, 'pumpkin_pie', 4, { maxUses: 12, xp: 5 }),
      sells(1, 'apple', 4, { maxUses: 16, xp: 5 })],
    [buys('melon', 4, 1, { maxUses: 12, xp: 10 }),
      sells(3, 'cookie', 18, { maxUses: 12, xp: 10 })],
    [buys('carrot', 22, 1, { maxUses: 12, xp: 15 }),
      sells(1, 'cake', 1, { maxUses: 10, xp: 15 })],
    [sells(3, 'golden_carrot', 3, { maxUses: 12, xp: 30 }),
      sells(4, 'golden_apple', 1, { maxUses: 8, xp: 30 })],
  ]),

  defineProfession('fisherman', 'Fischer', ['barrel'], [
    [buys('string', 20, 1, { maxUses: 16, xp: 2 }),
      buys('cod', 15, 1, { maxUses: 16, xp: 2 }),
      sells(1, 'cooked_cod', 6, { maxUses: 16, xp: 1 })],
    [buys('salmon', 13, 1, { maxUses: 16, xp: 5 }),
      sells(2, 'campfire', 1, { maxUses: 12, xp: 5 })],
    [sells(1, 'cooked_salmon', 6, { maxUses: 16, xp: 10 }),
      buys('tropical_fish', 6, 1, { maxUses: 12, xp: 10 })],
    [buys('oak_boat', 1, 1, { maxUses: 8, xp: 15 }),
      sells(8, 'fishing_rod', 1, { maxUses: 3, xp: 15, enchant: [ENCHANT.LURE, 2] })],
    [buys('cooked_cod', 10, 1, { maxUses: 12, xp: 30 }),
      sells(6, 'fishing_rod', 1, { maxUses: 3, xp: 30, enchant: [ENCHANT.LUCK_OF_THE_SEA, 2] })],
  ]),

  defineProfession('shepherd', 'Schäfer', ['loom', 'white_wool'], [
    [buys('white_wool', 18, 1, { maxUses: 16, xp: 2 }),
      sells(2, 'shears', 1, { maxUses: 12, xp: 1 })],
    [buys('white_dye', 12, 1, { maxUses: 16, xp: 5 }),
      sells(1, 'white_wool', 1, { maxUses: 16, xp: 5 }),
      sells(1, 'black_wool', 1, { maxUses: 16, xp: 5 })],
    [buys('red_dye', 12, 1, { maxUses: 16, xp: 10 }),
      sells(1, 'red_wool', 1, { maxUses: 16, xp: 10 }),
      sells(1, 'yellow_wool', 1, { maxUses: 16, xp: 10 })],
    [buys('blue_dye', 12, 1, { maxUses: 16, xp: 15 }),
      sells(1, 'blue_wool', 1, { maxUses: 16, xp: 15 }),
      sells(1, 'light_blue_wool', 1, { maxUses: 16, xp: 15 })],
    [sells(3, 'green_wool', 3, { maxUses: 12, xp: 30 }),
      sells(3, 'pink_wool', 3, { maxUses: 12, xp: 30 })],
  ]),

  defineProfession('fletcher', 'Pfeilmacher', ['fletching_table', 'scaffolding'], [
    [buys('stick', 32, 1, { maxUses: 16, xp: 2 }),
      sells(1, 'arrow', 16, { maxUses: 16, xp: 1 })],
    [buys('flint', 26, 1, { maxUses: 12, xp: 5 }),
      sells(2, 'bow', 1, { maxUses: 12, xp: 5 })],
    [buys('string', 14, 1, { maxUses: 16, xp: 10 }),
      sells(3, 'crossbow', 1, { maxUses: 12, xp: 10 })],
    [buys('feather', 24, 1, { maxUses: 16, xp: 15 }),
      sells(2, 'arrow', 8, { maxUses: 12, xp: 15 })],
    [sells(12, 'bow', 1, { maxUses: 3, xp: 30, enchant: [ENCHANT.POWER, 3] }),
      sells(8, 'crossbow', 1, { maxUses: 3, xp: 30, enchant: [ENCHANT.UNBREAKING, 2] })],
  ]),

  defineProfession('librarian', 'Bibliothekar', ['lectern', 'bookshelf'], [
    [buys('paper', 24, 1, { maxUses: 16, xp: 2 }),
      sells(9, 'bookshelf', 1, { maxUses: 12, xp: 1 }),
      sells(12, 'enchanted_book', 1, { maxUses: 3, xp: 2, enchant: ['random', 1] })],
    [buys('book', 4, 1, { maxUses: 12, xp: 5 }),
      sells(1, 'lantern', 1, { maxUses: 12, xp: 5 })],
    [buys('ink_sac', 5, 1, { maxUses: 12, xp: 10 }),
      sells(4, 'glass', 4, { maxUses: 12, xp: 10 }),
      sells(16, 'enchanted_book', 1, { maxUses: 3, xp: 10, enchant: ['random', 2] })],
    [sells(5, 'clock', 1, { maxUses: 12, xp: 15 }),
      sells(4, 'compass', 1, { maxUses: 12, xp: 15 })],
    [sells(20, 'name_tag', 1, { maxUses: 3, xp: 30 }),
      sells(22, 'enchanted_book', 1, { maxUses: 3, xp: 30, enchant: [ENCHANT.MENDING, 1] })],
  ]),

  defineProfession('cartographer', 'Kartograf', ['cartography_table', 'jukebox'], [
    [buys('paper', 24, 1, { maxUses: 16, xp: 2 }),
      sells(7, 'map', 1, { maxUses: 12, xp: 1 })],
    [buys('glass_pane', 11, 1, { maxUses: 12, xp: 5 }),
      sells(4, 'compass', 1, { maxUses: 12, xp: 5 })],
    [sells(13, 'map', 1, { maxUses: 8, xp: 10 }),
      sells(1, 'glass_pane', 4, { maxUses: 12, xp: 10 })],
    [sells(14, 'clock', 1, { maxUses: 8, xp: 15 }),
      buys('ink_sac', 8, 1, { maxUses: 12, xp: 15 })],
    [sells(10, 'glass', 8, { maxUses: 8, xp: 30 }),
      sells(3, 'white_wool', 3, { maxUses: 12, xp: 30 })],
  ]),

  defineProfession('cleric', 'Kleriker', ['brewing_stand'], [
    [buys('rotten_flesh', 32, 1, { maxUses: 16, xp: 2 }),
      sells(1, 'redstone', 2, { maxUses: 16, xp: 1 })],
    [buys('gold_ingot', 3, 1, { maxUses: 12, xp: 5 }),
      sells(1, 'lapis_lazuli', 1, { maxUses: 12, xp: 5 })],
    [sells(4, 'glowstone', 1, { maxUses: 12, xp: 10 }),
      buys('glass_bottle', 9, 1, { maxUses: 12, xp: 10 })],
    [sells(5, 'ender_pearl', 1, { maxUses: 8, xp: 15 }),
      sells(3, 'blaze_powder', 1, { maxUses: 8, xp: 15 })],
    [sells(7, 'ender_eye', 1, { maxUses: 8, xp: 30 }),
      sells(4, 'magma_cream', 2, { maxUses: 8, xp: 30 })],
  ]),

  defineProfession('armorer', 'Rüstungsschmied', ['blast_furnace'], [
    [buys('coal', 15, 1, { maxUses: 16, xp: 2 }),
      sells(4, 'iron_helmet', 1, { maxUses: 12, xp: 1 }),
      sells(5, 'iron_boots', 1, { maxUses: 12, xp: 1 })],
    [buys('iron_ingot', 4, 1, { maxUses: 12, xp: 5 }),
      sells(10, 'iron_chestplate', 1, { maxUses: 12, xp: 5 })],
    [sells(7, 'iron_leggings', 1, { maxUses: 12, xp: 10 }),
      sells(9, 'chainmail_chestplate', 1, { maxUses: 12, xp: 10 })],
    [buys('lava_bucket', 1, 1, { maxUses: 8, xp: 15 }),
      sells(6, 'chainmail_leggings', 1, { maxUses: 12, xp: 15 })],
    [sells(19, 'diamond_chestplate', 1, { maxUses: 3, xp: 30, enchant: [ENCHANT.PROTECTION, 2] }),
      sells(14, 'diamond_helmet', 1, { maxUses: 3, xp: 30, enchant: [ENCHANT.PROTECTION, 1] })],
  ]),

  defineProfession('weaponsmith', 'Waffenschmied', ['grindstone', 'anvil'], [
    [buys('coal', 15, 1, { maxUses: 16, xp: 2 }),
      sells(3, 'iron_axe', 1, { maxUses: 12, xp: 1 })],
    [buys('iron_ingot', 4, 1, { maxUses: 12, xp: 5 }),
      sells(7, 'iron_sword', 1, { maxUses: 12, xp: 5, enchant: [ENCHANT.SHARPNESS, 1] })],
    [buys('flint', 24, 1, { maxUses: 12, xp: 10 }),
      sells(5, 'shield', 1, { maxUses: 12, xp: 10 })],
    [buys('diamond', 1, 1, { maxUses: 12, xp: 15 }),
      sells(9, 'bow', 1, { maxUses: 8, xp: 15, enchant: [ENCHANT.POWER, 2] })],
    [sells(18, 'diamond_sword', 1, { maxUses: 3, xp: 30, enchant: [ENCHANT.SHARPNESS, 3] }),
      sells(13, 'diamond_axe', 1, { maxUses: 3, xp: 30, enchant: [ENCHANT.EFFICIENCY, 2] })],
  ]),

  defineProfession('toolsmith', 'Werkzeugschmied', ['smithing_table', 'note_block'], [
    [buys('coal', 15, 1, { maxUses: 16, xp: 2 }),
      sells(1, 'stone_axe', 1, { maxUses: 12, xp: 1 }),
      sells(1, 'stone_pickaxe', 1, { maxUses: 12, xp: 1 })],
    [buys('iron_ingot', 4, 1, { maxUses: 12, xp: 5 }),
      sells(1, 'stone_shovel', 1, { maxUses: 12, xp: 5 }),
      sells(1, 'stone_hoe', 1, { maxUses: 12, xp: 5 })],
    [buys('flint', 30, 1, { maxUses: 12, xp: 10 }),
      sells(8, 'iron_pickaxe', 1, { maxUses: 8, xp: 10, enchant: [ENCHANT.EFFICIENCY, 1] })],
    [buys('diamond', 1, 1, { maxUses: 12, xp: 15 }),
      sells(7, 'iron_axe', 1, { maxUses: 8, xp: 15, enchant: [ENCHANT.EFFICIENCY, 2] })],
    [sells(18, 'diamond_pickaxe', 1, { maxUses: 3, xp: 30, enchant: [ENCHANT.EFFICIENCY, 3] }),
      sells(16, 'diamond_shovel', 1, { maxUses: 3, xp: 30, enchant: [ENCHANT.UNBREAKING, 3] })],
  ]),

  defineProfession('butcher', 'Metzger', ['smoker', 'furnace'], [
    [buys('chicken', 14, 1, { maxUses: 16, xp: 2 }),
      buys('porkchop', 7, 1, { maxUses: 16, xp: 2 }),
      sells(1, 'rabbit_stew', 1, { maxUses: 12, xp: 1 })],
    [buys('coal', 15, 1, { maxUses: 16, xp: 5 }),
      sells(1, 'cooked_porkchop', 5, { maxUses: 16, xp: 5 }),
      sells(1, 'cooked_chicken', 8, { maxUses: 16, xp: 5 })],
    [buys('mutton', 7, 1, { maxUses: 16, xp: 10 }),
      buys('beef', 10, 1, { maxUses: 16, xp: 10 })],
    [buys('dried_kelp', 10, 1, { maxUses: 12, xp: 15 }),
      sells(1, 'cooked_beef', 3, { maxUses: 12, xp: 15 })],
    [buys('sweet_berries', 10, 1, { maxUses: 12, xp: 30 }),
      sells(2, 'cooked_mutton', 4, { maxUses: 12, xp: 30 })],
  ]),

  defineProfession('leatherworker', 'Gerber', ['cauldron'], [
    [buys('leather', 6, 1, { maxUses: 16, xp: 2 }),
      sells(3, 'leather_leggings', 1, { maxUses: 12, xp: 1 })],
    [buys('flint', 26, 1, { maxUses: 12, xp: 5 }),
      sells(7, 'leather_chestplate', 1, { maxUses: 12, xp: 5 })],
    [buys('rabbit_hide', 9, 1, { maxUses: 12, xp: 10 }),
      sells(5, 'leather_helmet', 1, { maxUses: 12, xp: 10 })],
    [sells(4, 'leather_boots', 1, { maxUses: 12, xp: 15 }),
      buys('leather', 9, 2, { maxUses: 12, xp: 15 })],
    [sells(6, 'saddle', 1, { maxUses: 6, xp: 30 }),
      sells(6, 'leather_chestplate', 1, { maxUses: 6, xp: 30, enchant: [ENCHANT.PROTECTION, 1] })],
  ]),
]);

if (DROPPED_TRADES.length > 0) {
  warnOnce('trades', `${DROPPED_TRADES.length} trade(s) reference items this build has no entry for and were dropped: ${DROPPED_TRADES.join(', ')}`);
}

/** Profession key -> definition. @type {Map<string, Profession>} */
export const PROFESSION_BY_KEY = new Map(PROFESSIONS.map((p) => [p.key, p]));

/** Workstation block id -> profession. @type {Map<number, Profession>} */
export const PROFESSION_BY_STATION = new Map();
for (let i = 0; i < PROFESSIONS.length; i++) {
  const p = PROFESSIONS[i];
  if (p.station > 0 && !PROFESSION_BY_STATION.has(p.station)) PROFESSION_BY_STATION.set(p.station, p);
}

/**
 * Look up a profession by key.
 * @param {?string} key Profession key.
 * @returns {?Profession} The profession, or `null`.
 */
export function getProfession(key) {
  if (typeof key !== 'string') return null;
  const p = PROFESSION_BY_KEY.get(key);
  return p === undefined ? null : p;
}

/**
 * Which profession claims a workstation block.
 * @param {number} blockId Block id.
 * @returns {?Profession} The profession, or `null` when the block is no station.
 */
export function professionForStation(blockId) {
  const p = PROFESSION_BY_STATION.get(blockId | 0);
  return p === undefined ? null : p;
}

/**
 * German label of a profession, falling back to a neutral word.
 * @param {?string} key Profession key.
 * @returns {string} The label.
 */
export function professionLabel(key) {
  const p = getProfession(key);
  return p === null ? 'Dorfbewohner' : p.display;
}

/**
 * German label of a trade level.
 * @param {number} level Level 1..5.
 * @returns {string} The label.
 */
export function levelLabel(level) {
  const entry = TRADE_LEVELS[clamp((level | 0) - 1, 0, MAX_TRADE_LEVEL - 1)];
  return entry.display;
}

/* ========================================================================== */
/* Trade offers                                                               */
/* ========================================================================== */

/** Every enchantment id, used by the librarian's random books. @type {readonly string[]} */
const ENCHANT_POOL = Object.freeze(Object.keys(ENCHANT).map((k) => ENCHANT[k]));

/**
 * A stable identity string for a player, used as the reputation key.
 * @param {?Object} player The player.
 * @returns {string} The id.
 */
export function playerIdOf(player) {
  if (!player) return 'player';
  if (typeof player.uuid === 'string') return player.uuid;
  if (typeof player.name === 'string') return player.name;
  if (player.id !== undefined) return String(player.id);
  return 'player';
}

/**
 * Resolve an enchantment specification into a concrete `{id, level}`.
 * @param {{id:string, level:number}} spec The definition's enchantment.
 * @param {() => number} rng Random source.
 * @returns {?{id:string, level:number}} The enchantment, or `null`.
 */
function resolveEnchant(spec, rng) {
  if (!spec) return null;
  let id = spec.id;
  if (id === 'random') {
    if (ENCHANT_POOL.length === 0) return null;
    id = ENCHANT_POOL[(rng() * ENCHANT_POOL.length) | 0];
  }
  const cap = Math.max(1, enchantMaxLevel(id) || 1);
  return { id, level: clamp(spec.level | 0, 1, cap) };
}

/**
 * One live trade offer: a definition plus everything that changes about it —
 * how often it was used, how much the villager wants for it right now, and
 * whether it is out of stock until the next restock.
 */
export class TradeOffer {
  /**
   * @param {TradeDef} def The immutable definition.
   * @param {() => number} [rng] Random source for enchanted results.
   */
  constructor(def, rng = Math.random) {
    /** @type {TradeDef} */
    this.def = def;
    /** @type {number} Item the player pays with. */
    this.priceItem = def.inputA.item;
    /** @type {number} Base amount asked for. */
    this.basePrice = def.inputA.count;
    /** @type {?{itemId:number, count:number}} Optional second price slot. */
    this.second = def.inputB === null ? null
      : { itemId: def.inputB.item, count: def.inputB.count };
    /** @type {number} Item handed over. */
    this.resultItem = def.output.item;
    /** @type {number} How many are handed over. */
    this.resultCount = def.output.count;
    /** @type {?{id:string, level:number}} Enchantment put on the result. */
    this.enchant = resolveEnchant(def.enchant, rng);
    /** @type {number} Trades before the offer runs dry. */
    this.maxUses = def.maxUses;
    /** @type {number} Trades made since the last restock. */
    this.uses = 0;
    /** @type {number} Villager experience per trade. */
    this.xp = def.xp;
    /** @type {number} How strongly demand and reputation move the price. */
    this.priceMultiplier = def.priceMultiplier;
    /** @type {number} Demand accumulated over past restock periods. */
    this.demand = 0;
  }

  /**
   * Whether the offer is used up until the next restock.
   * @returns {boolean} `true` when nothing is left.
   */
  get outOfStock() {
    return this.uses >= this.maxUses;
  }

  /**
   * The price this offer asks a given player right now.
   * @param {number} [reputation=0] The player's standing with the villager.
   * @returns {number} Amount of {@link TradeOffer#priceItem}, at least 1.
   */
  priceFor(reputation = 0) {
    const base = this.basePrice;
    const demandBonus = Math.max(0, Math.floor(base * this.demand * this.priceMultiplier));
    const rep = clamp(num(reputation, 0), -REPUTATION_LIMIT, REPUTATION_LIMIT);
    const repAdjust = Math.round(base * REPUTATION_PRICE_WEIGHT * rep);
    const floorPrice = Math.max(1, Math.ceil(base * 0.35));
    return clamp(base + demandBonus - repAdjust, floorPrice, MAX_PRICE);
  }

  /**
   * Build the stack this offer hands over.
   * @returns {?ItemStack} A fresh stack, or `null` when the item is unknown.
   */
  createResult() {
    if (this.resultItem <= 0) return null;
    const stack = new ItemStack(this.resultItem, this.resultCount, null);
    if (this.enchant !== null) {
      try {
        stack.addEnchantment(this.enchant.id, this.enchant.level);
      } catch (err) {
        warnOnce('enchant', 'could not enchant a trade result', err);
      }
    }
    return stack;
  }

  /**
   * German one-line description, e.g. `20x Weizen -> 1x Smaragd`.
   * @param {number} [reputation=0] Reputation used for the price.
   * @returns {string} The description.
   */
  describe(reputation = 0) {
    const price = `${this.priceFor(reputation)}x ${itemDisplay(this.priceItem)}`;
    const extra = this.second === null ? ''
      : ` + ${this.second.count}x ${itemDisplay(this.second.itemId)}`;
    let result = `${this.resultCount}x ${itemDisplay(this.resultItem)}`;
    if (this.enchant !== null) result += ` (${enchantmentDisplay(this.enchant.id)} ${this.enchant.level})`;
    return `${price}${extra} → ${result}`;
  }

  /**
   * Refill the offer and let demand follow how hard it was used.
   * @returns {void}
   */
  restock() {
    this.demand = Math.max(0, this.demand + this.uses - Math.floor((this.maxUses - this.uses) / 2));
    if (this.demand > 32) this.demand = 32;
    this.uses = 0;
  }

  /**
   * Compact snapshot.
   * @returns {{u:number, d:number, e:?{id:string, level:number}}} The snapshot.
   */
  serialize() {
    return { u: this.uses, d: this.demand, e: this.enchant };
  }

  /**
   * Restore a snapshot written by {@link TradeOffer#serialize}.
   * @param {Object} snapshot The snapshot.
   * @returns {void}
   */
  deserialize(snapshot) {
    if (!snapshot) return;
    this.uses = clamp(num(snapshot.u, 0) | 0, 0, this.maxUses);
    this.demand = clamp(num(snapshot.d, 0) | 0, 0, 32);
    if (snapshot.e && typeof snapshot.e.id === 'string') {
      this.enchant = { id: snapshot.e.id, level: Math.max(1, num(snapshot.e.level, 1) | 0) };
    }
  }
}

/* ========================================================================== */
/* VillagerData                                                               */
/* ========================================================================== */

/** Monotonic source of villager uids. @type {number} */
let NEXT_UID = 1;

/**
 * Everything a villager knows that its `Mob` does not: its job, its level, its
 * offers, the blocks it claimed and what it thinks of every player.
 */
export class VillagerData {
  /**
   * @param {number} [uid] Stable identity; a fresh one is allocated when omitted.
   * @param {?string} [profession=null] Profession key, `null` for unemployed.
   * @param {() => number} [rng] Random source.
   */
  constructor(uid = 0, profession = null, rng = Math.random) {
    /** @type {number} Stable identity across saves. */
    this.uid = uid > 0 ? uid | 0 : NEXT_UID++;
    if (this.uid >= NEXT_UID) NEXT_UID = this.uid + 1;
    /** @type {?string} Profession key, `null` while unemployed. */
    this.profession = profession;
    /** @type {number} Trade level 1..5. */
    this.level = 1;
    /** @type {number} Trade experience. */
    this.xp = 0;
    /** @type {TradeOffer[]} Published offers, in tier order. */
    this.offers = [];
    /** @type {?number[]} Claimed workstation block. */
    this.workstation = null;
    /** @type {?number[]} Claimed bed block. */
    this.bed = null;
    /** @type {?number[]} The village meeting point. */
    this.meeting = null;
    /** @type {number} Food points; a villager needs some to be willing to breed. */
    this.food = 0;
    /** @type {Map<string, number>} Reputation per player id. */
    this.reputation = new Map();
    /** @type {number} Index of the last restock window that was used. */
    this.restockSlot = -1;
    /** @type {number} Restocks performed in the current day. */
    this.restocksToday = 0;
    /** @type {number} Seconds until the villager looks for a job site again. */
    this.poiCooldown = 0;
    /** @type {number} Which missing point of interest is searched for next. */
    this.poiTurn = 0;
    /** @type {number} Seconds until this villager may try to breed again. */
    this.breedCooldown = BREED_INTERVAL;
    /** @type {number} Seconds worked since the last work animation. */
    this.workTimer = 0;
    /** @type {number} Seconds until the next field inspection. */
    this.farmTimer = 0;
    /** @type {boolean} Whether the villager is asleep. */
    this.sleeping = false;
    /** @type {number[]} Last known position, used to re-adopt loaded records. */
    this.lastSeen = [0, 0, 0];
    /** @type {number} Day the reputation was last decayed. */
    this.lastDecayDay = -1;
    /** @type {() => number} Random source for offer generation. */
    this.rng = rng;
    if (profession !== null) this.rebuildOffers();
  }

  /**
   * Publish the offers of every unlocked tier, keeping the state of offers
   * that already existed.
   * @returns {void}
   */
  rebuildOffers() {
    const profession = getProfession(this.profession);
    if (profession === null) {
      this.offers.length = 0;
      return;
    }
    const kept = this.offers;
    const next = [];
    let index = 0;
    for (let tier = 0; tier < this.level && tier < profession.tiers.length; tier++) {
      const defs = profession.tiers[tier];
      for (let i = 0; i < defs.length; i++) {
        const existing = kept[index];
        if (existing !== undefined && existing.def === defs[i]) next.push(existing);
        else next.push(new TradeOffer(defs[i], this.rng));
        index++;
      }
    }
    this.offers = next;
  }

  /**
   * Award trade experience and unlock tiers.
   * @param {number} amount Experience to add.
   * @returns {boolean} `true` when the villager reached a new level.
   */
  addXP(amount) {
    const add = Math.max(0, num(amount, 0) | 0);
    if (add === 0) return false;
    this.xp += add;
    let leveled = false;
    while (this.level < MAX_TRADE_LEVEL && this.xp >= TRADE_LEVELS[this.level].xp) {
      this.level++;
      leveled = true;
    }
    if (leveled) this.rebuildOffers();
    return leveled;
  }

  /**
   * Experience needed for the next level.
   * @returns {number} The threshold, or the current xp when already master.
   */
  xpForNextLevel() {
    if (this.level >= MAX_TRADE_LEVEL) return this.xp;
    return TRADE_LEVELS[this.level].xp;
  }

  /**
   * Progress through the current level, for the UI's xp bar.
   * @returns {number} A value in `[0, 1]`.
   */
  xpProgress() {
    if (this.level >= MAX_TRADE_LEVEL) return 1;
    const from = TRADE_LEVELS[this.level - 1].xp;
    const to = TRADE_LEVELS[this.level].xp;
    if (to <= from) return 1;
    return clamp((this.xp - from) / (to - from), 0, 1);
  }

  /**
   * This villager's opinion of a player.
   * @param {string} playerId Player identity.
   * @returns {number} Reputation, `0` when unknown.
   */
  reputationOf(playerId) {
    const v = this.reputation.get(playerId);
    return v === undefined ? 0 : v;
  }

  /**
   * Change a player's standing.
   * @param {string} playerId Player identity.
   * @param {number} delta Change, positive or negative.
   * @returns {number} The new reputation.
   */
  addReputation(playerId, delta) {
    const value = clamp(this.reputationOf(playerId) + num(delta, 0), -REPUTATION_LIMIT, REPUTATION_LIMIT);
    if (value === 0) this.reputation.delete(playerId);
    else this.reputation.set(playerId, value);
    return value;
  }

  /**
   * Refill every offer; called at the workstation, twice a day.
   * @returns {void}
   */
  restock() {
    for (let i = 0; i < this.offers.length; i++) this.offers[i].restock();
  }

  /**
   * Give the villager a job, resetting its trade progress.
   * @param {?string} professionKey Profession key.
   * @returns {boolean} `true` when the profession changed.
   */
  setProfession(professionKey) {
    if (this.profession === professionKey) return false;
    this.profession = professionKey;
    this.level = 1;
    this.xp = 0;
    this.offers.length = 0;
    this.rebuildOffers();
    return true;
  }

  /**
   * Compact snapshot for the save file.
   * @returns {Object} The snapshot.
   */
  serialize() {
    const reputation = [];
    for (const [key, value] of this.reputation) reputation.push([key, value]);
    return {
      uid: this.uid,
      p: this.profession,
      l: this.level,
      x: this.xp,
      o: this.offers.map((offer) => offer.serialize()),
      w: this.workstation,
      b: this.bed,
      m: this.meeting,
      f: this.food,
      r: reputation,
      s: this.restockSlot,
      t: this.poiTurn,
      pos: [this.lastSeen[0], this.lastSeen[1], this.lastSeen[2]],
    };
  }

  /**
   * Restore a snapshot written by {@link VillagerData#serialize}.
   * @param {Object} snapshot The snapshot.
   * @returns {VillagerData} `this`.
   */
  deserialize(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return this;
    this.uid = Math.max(1, num(snapshot.uid, this.uid) | 0);
    if (this.uid >= NEXT_UID) NEXT_UID = this.uid + 1;
    this.profession = typeof snapshot.p === 'string' ? snapshot.p : null;
    this.level = clamp(num(snapshot.l, 1) | 0, 1, MAX_TRADE_LEVEL);
    this.xp = Math.max(0, num(snapshot.x, 0) | 0);
    this.offers.length = 0;
    this.rebuildOffers();
    if (Array.isArray(snapshot.o)) {
      for (let i = 0; i < this.offers.length && i < snapshot.o.length; i++) {
        this.offers[i].deserialize(snapshot.o[i]);
      }
    }
    this.workstation = Array.isArray(snapshot.w) && snapshot.w.length >= 3
      ? [snapshot.w[0] | 0, snapshot.w[1] | 0, snapshot.w[2] | 0] : null;
    this.bed = Array.isArray(snapshot.b) && snapshot.b.length >= 3
      ? [snapshot.b[0] | 0, snapshot.b[1] | 0, snapshot.b[2] | 0] : null;
    this.meeting = Array.isArray(snapshot.m) && snapshot.m.length >= 3
      ? [snapshot.m[0] | 0, snapshot.m[1] | 0, snapshot.m[2] | 0] : null;
    this.food = clamp(num(snapshot.f, 0) | 0, 0, 64);
    this.reputation.clear();
    if (Array.isArray(snapshot.r)) {
      for (let i = 0; i < snapshot.r.length; i++) {
        const entry = snapshot.r[i];
        if (Array.isArray(entry) && typeof entry[0] === 'string') {
          this.reputation.set(entry[0], clamp(num(entry[1], 0), -REPUTATION_LIMIT, REPUTATION_LIMIT));
        }
      }
    }
    this.restockSlot = num(snapshot.s, -1) | 0;
    this.poiTurn = clamp(num(snapshot.t, 0) | 0, 0, 5);
    if (Array.isArray(snapshot.pos) && snapshot.pos.length >= 3) {
      this.lastSeen[0] = num(snapshot.pos[0], 0);
      this.lastSeen[1] = num(snapshot.pos[1], 0);
      this.lastSeen[2] = num(snapshot.pos[2], 0);
    }
    return this;
  }
}

/* ========================================================================== */
/* TradingSession                                                             */
/* ========================================================================== */

/**
 * @typedef {Object} OfferView
 * @property {number} index         Position in the offer list.
 * @property {number} priceItem     Item the player pays with.
 * @property {number} price         How many, after demand and reputation.
 * @property {number} basePrice     The undiscounted price.
 * @property {string} priceLabel    German label of the price.
 * @property {?{itemId:number, count:number, label:string}} second Second price slot.
 * @property {number} resultItem    Item handed over.
 * @property {number} resultCount   How many.
 * @property {string} resultLabel   German label of the result.
 * @property {?{id:string, level:number, label:string}} enchant Result enchantment.
 * @property {number} uses          Trades made since the last restock.
 * @property {number} maxUses       Trades before it runs dry.
 * @property {boolean} outOfStock   Whether it is used up.
 * @property {boolean} affordable   Whether the player can pay right now.
 * @property {string} text          One-line description.
 */

/**
 * The object the trading screen drives.
 *
 * It reads and writes only the villager's own data and the player's inventory,
 * so opening, re-opening and abandoning a session is always safe. Call
 * {@link TradingSession#refresh} after anything that could change the
 * inventory; every getter is cheap.
 */
export class TradingSession {
  /**
   * @param {VillagerManager} manager The owning manager.
   * @param {Object} villager The villager mob.
   * @param {Object} player The trading player.
   */
  constructor(manager, villager, player) {
    /** @type {VillagerManager} */
    this.manager = manager;
    /** @type {Object} The villager mob. */
    this.villager = villager;
    /** @type {VillagerData} */
    this.data = manager.dataOf(villager);
    /** @type {Object} The trading player. */
    this.player = player;
    /** @type {string} Reputation key of the player. */
    this.playerId = playerIdOf(player);
    /** @type {number} Index of the selected offer. */
    this.selectedIndex = 0;
    /** @type {OfferView[]} Cached offer views. */
    this.views = [];
    /** @type {boolean} Whether the session is still usable. */
    this.open = true;
    this.refresh();
  }

  /** German headline, e.g. `Bauer — Lehrling`. @returns {string} The title. */
  get title() {
    return `${professionLabel(this.data.profession)} — ${levelLabel(this.data.level)}`;
  }

  /** The villager's trade level. @returns {number} Level 1..5. */
  get level() {
    return this.data.level;
  }

  /** German name of the trade level. @returns {string} The label. */
  get levelName() {
    return levelLabel(this.data.level);
  }

  /** Total trade experience. @returns {number} The experience. */
  get xp() {
    return this.data.xp;
  }

  /** Experience the next level needs. @returns {number} The threshold. */
  get xpForNext() {
    return this.data.xpForNextLevel();
  }

  /** Progress through the current level. @returns {number} `0..1`. */
  get xpProgress() {
    return this.data.xpProgress();
  }

  /** This player's standing with the villager. @returns {number} Reputation. */
  get reputation() {
    return this.data.reputationOf(this.playerId);
  }

  /** The published offers. @returns {OfferView[]} The views. */
  get offers() {
    return this.views;
  }

  /**
   * Rebuild the offer views from the villager's live data.
   * @returns {OfferView[]} The refreshed views.
   */
  refresh() {
    const reputation = this.reputation;
    const list = this.data.offers;
    this.views.length = 0;
    for (let i = 0; i < list.length; i++) {
      const offer = list[i];
      const price = offer.priceFor(reputation);
      this.views.push({
        index: i,
        priceItem: offer.priceItem,
        price,
        basePrice: offer.basePrice,
        priceLabel: `${price}x ${itemDisplay(offer.priceItem)}`,
        second: offer.second === null ? null : {
          itemId: offer.second.itemId,
          count: offer.second.count,
          label: `${offer.second.count}x ${itemDisplay(offer.second.itemId)}`,
        },
        resultItem: offer.resultItem,
        resultCount: offer.resultCount,
        resultLabel: `${offer.resultCount}x ${itemDisplay(offer.resultItem)}`,
        enchant: offer.enchant === null ? null : {
          id: offer.enchant.id,
          level: offer.enchant.level,
          label: `${enchantmentDisplay(offer.enchant.id)} ${offer.enchant.level}`,
        },
        uses: offer.uses,
        maxUses: offer.maxUses,
        outOfStock: offer.outOfStock,
        affordable: this.canAfford(i),
        text: offer.describe(reputation),
      });
    }
    if (this.selectedIndex >= this.views.length) this.selectedIndex = 0;
    return this.views;
  }

  /**
   * Select an offer.
   * @param {number} index Offer index.
   * @returns {boolean} `true` when the index existed.
   */
  select(index) {
    const i = index | 0;
    if (i < 0 || i >= this.data.offers.length) return false;
    this.selectedIndex = i;
    return true;
  }

  /** The selected offer view. @returns {?OfferView} The view, or `null`. */
  get selected() {
    return this.views[this.selectedIndex] || null;
  }

  /**
   * The inventory this session pays from.
   * @returns {?Object} The player inventory, or `null`.
   * @private
   */
  _inventory() {
    const player = this.player;
    if (!player) return null;
    const inv = player.inventory;
    return inv && typeof inv.count === 'function' ? inv : null;
  }

  /**
   * Can the player pay for an offer?
   * @param {number} [index] Offer index; the selection when omitted.
   * @returns {boolean} `true` when the price is covered.
   */
  canAfford(index = this.selectedIndex) {
    const offer = this.data.offers[index | 0];
    if (offer === undefined || offer.outOfStock) return false;
    if (this.player && this.player.gameMode === 'creative') return true;
    const inv = this._inventory();
    if (inv === null) return false;
    const price = offer.priceFor(this.reputation);
    if (inv.count(offer.priceItem) < price) return false;
    if (offer.second !== null && inv.count(offer.second.itemId) < offer.second.count) return false;
    return true;
  }

  /**
   * Execute the selected (or given) trade.
   * @param {number} [count=1] How many times to trade.
   * @param {number} [index] Offer index; the selection when omitted.
   * @returns {{ok:boolean, traded:number, message:string, stack:?ItemStack}} The
   *   outcome, with a German message for the HUD.
   */
  takeTrade(count = 1, index = this.selectedIndex) {
    const result = { ok: false, traded: 0, message: '', stack: null };
    if (!this.open) {
      result.message = 'Der Handel ist beendet.';
      return result;
    }
    const offer = this.data.offers[index | 0];
    if (offer === undefined) {
      result.message = 'Dieses Angebot gibt es nicht.';
      return result;
    }
    const wanted = Math.max(1, count | 0);
    for (let n = 0; n < wanted; n++) {
      const step = this.manager.executeTrade(this.villager, offer, this.player);
      if (!step.ok) {
        result.message = result.traded > 0 ? 'Nicht mehr auf Lager.' : step.message;
        break;
      }
      result.traded++;
      result.stack = step.stack;
      result.ok = true;
      result.message = step.message;
    }
    this.refresh();
    return result;
  }

  /**
   * End the session.
   * @returns {void}
   */
  close() {
    this.open = false;
    this.manager.closeSession(this);
  }
}

/* ========================================================================== */
/* Behaviours                                                                 */
/* ========================================================================== */

/**
 * Sleep in the claimed bed; without one, get out of the open and wait the night
 * out under a roof.
 *
 * Priority 70 — above breeding (68) and the stock village routine (28), below
 * the hostile avoidance (90) and panic (100) that `game/mobs.js` installs, so a
 * villager always runs from a zombie before it goes to bed.
 */
export class VillagerRestBehavior extends Behavior {
  /**
   * @param {VillagerManager} manager The owning manager.
   */
  constructor(manager) {
    super('village_rest', 70);
    /** @type {VillagerManager} */
    this.manager = manager;
    /** @type {number} Seconds until the path is recomputed. */
    this.repath = 0;
    /** @type {?number[]} Shelter position chosen for a bedless villager. */
    this.shelter = null;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    if (!mob.villagerData) return false;
    return this.manager.isNight(ctx);
  }

  /** @inheritDoc */
  canContinue(mob, ctx) {
    return this.canStart(mob, ctx);
  }

  /** @inheritDoc */
  start(mob) {
    this.repath = 0;
    this.shelter = null;
    void mob;
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const data = mob.villagerData;
    if (!data) return;

    let target = data.bed;
    if (target === null) {
      if (this.shelter === null) this.shelter = this.manager.findShelter(mob);
      target = this.shelter || data.meeting || mob.home;
    }
    if (!target) {
      mob.stopMoving();
      return;
    }

    if (distSqTo(mob.position, target) <= POI_REACH * POI_REACH) {
      mob.stopMoving();
      mob.lookAt(target[0] + 0.5, target[1] + 0.4, target[2] + 0.5);
      if (data.bed !== null && !data.sleeping) {
        data.sleeping = true;
        mob.animation.sit = 1;
        this.manager.emit('sleep', mob, true);
      }
      return;
    }

    this.repath -= dt;
    if (this.repath <= 0 || mob.navDone) {
      this.repath = 1.0 + mob.random() * 0.8;
      mob.moveTo(target[0] + 0.5, target[1], target[2] + 0.5, 1.05);
    }
  }

  /** @inheritDoc */
  stop(mob) {
    const data = mob.villagerData;
    if (data && data.sleeping) {
      data.sleeping = false;
      mob.animation.sit = 0;
      this.manager.emit('sleep', mob, false);
    }
    this.shelter = null;
    mob.stopMoving();
  }
}

/**
 * Work the claimed workstation during the day, in sessions with breaks in
 * between so the village does not look like a row of statues.
 *
 * Priority 34 — above wander (30), below resting (70).
 */
export class VillagerWorkBehavior extends Behavior {
  /**
   * @param {VillagerManager} manager The owning manager.
   */
  constructor(manager) {
    super('village_work', 34);
    /** @type {VillagerManager} */
    this.manager = manager;
    /** @type {number} Seconds until the path is recomputed. */
    this.repath = 0;
    /** @type {number} Mob age at which the current work session ends. */
    this.sessionEnd = 0;
    /** @type {number} Mob age before which no new session may start. */
    this.breakUntil = 0;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    const data = mob.villagerData;
    if (!data || mob.isBaby === true) return false;
    if (!this.manager.isDay(ctx)) return false;
    if (mob.age < this.breakUntil) return false;
    // Job sites are searched for by the manager, which rotates fairly between
    // workstation, bed and meeting point; asking from here would starve the
    // other two searches, because `canStart` runs every single tick.
    return data.workstation !== null;
  }

  /** @inheritDoc */
  canContinue(mob, ctx) {
    const data = mob.villagerData;
    if (!data || data.workstation === null) return false;
    if (!this.manager.isDay(ctx)) return false;
    return mob.age < this.sessionEnd;
  }

  /** @inheritDoc */
  start(mob) {
    this.repath = 0;
    this.sessionEnd = mob.age + WORK_SESSION_SECONDS;
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const data = mob.villagerData;
    if (!data || data.workstation === null) return;
    const station = data.workstation;

    if (distSqTo(mob.position, station) <= POI_REACH * POI_REACH) {
      mob.stopMoving();
      mob.lookAt(station[0] + 0.5, station[1] + 0.5, station[2] + 0.5);
      this.manager.workAtStation(mob, data, dt, ctx);
      return;
    }
    this.repath -= dt;
    if (this.repath <= 0 || mob.navDone) {
      this.repath = 1.0 + mob.random() * 0.6;
      mob.moveTo(station[0] + 0.5, station[1], station[2] + 0.5, 0.95);
    }
  }

  /** @inheritDoc */
  stop(mob) {
    this.breakUntil = mob.age + WORK_BREAK_SECONDS;
    mob.stopMoving();
  }
}

/**
 * Gather at the village meeting point in the late afternoon, which is also
 * where villagers exchange news — and where the manager measures how big the
 * village really is.
 *
 * Priority 36 — above work (34), so the gathering ends the working day the way
 * vanilla's schedule does, and below resting (70).
 */
export class VillagerMeetingBehavior extends Behavior {
  /**
   * @param {VillagerManager} manager The owning manager.
   */
  constructor(manager) {
    super('village_meeting', 36);
    /** @type {VillagerManager} */
    this.manager = manager;
    /** @type {number} Seconds until the path is recomputed. */
    this.repath = 0;
    /** @type {number} Seconds until the villager shuffles to a new spot. */
    this.shuffle = 0;
  }

  /** @inheritDoc */
  canStart(mob, ctx) {
    const data = mob.villagerData;
    if (!data || mob.isBaby === true) return false;
    if (!this.manager.isMeetingTime(ctx)) return false;
    if (data.meeting === null) return false;
    return distSqTo(mob.position, data.meeting) <= VILLAGE_RADIUS * VILLAGE_RADIUS * 4;
  }

  /** @inheritDoc */
  canContinue(mob, ctx) {
    return this.canStart(mob, ctx);
  }

  /** @inheritDoc */
  start(mob) {
    this.repath = 0;
    this.shuffle = 0;
    void mob;
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const data = mob.villagerData;
    if (!data || data.meeting === null) return;
    const point = data.meeting;
    const near = distSqTo(mob.position, point) <= 16;

    if (near) {
      this.shuffle -= dt;
      const friend = this.manager.nearestVillager(mob, ctx, 6);
      if (friend !== null) mob.lookAt(friend.position[0], friend.position[1] + 1.2, friend.position[2]);
      else mob.lookAt(point[0] + 0.5, point[1] + 1, point[2] + 0.5);
      if (this.shuffle > 0) {
        mob.stopMoving();
        return;
      }
      this.shuffle = 3 + mob.random() * 5;
      mob.moveTo(point[0] + 0.5 + (mob.random() * 2 - 1) * 3, point[1],
        point[2] + 0.5 + (mob.random() * 2 - 1) * 3, 0.7);
      return;
    }

    this.repath -= dt;
    if (this.repath <= 0 || mob.navDone) {
      this.repath = 1.2 + mob.random() * 0.8;
      mob.moveTo(point[0] + 0.5, point[1], point[2] + 0.5, 0.9);
    }
  }

  /** @inheritDoc */
  stop(mob) {
    mob.stopMoving();
  }
}

/**
 * Add the village behaviours to a villager's existing behaviour list.
 *
 * The AI is not replaced: the new behaviours are pushed into the very list
 * `game/mobs.js` built and the list is re-sorted, so `MobAI#update` keeps
 * arbitrating between panic, hostile avoidance, breeding, wandering and these.
 * Calling it twice is a no-op.
 *
 * @param {Object} mob The villager.
 * @param {VillagerManager} manager The owning manager.
 * @returns {boolean} `true` when behaviours were added.
 */
export function attachVillagerBehaviors(mob, manager) {
  if (!mob || !mob.ai || !Array.isArray(mob.ai.behaviors)) return false;
  const list = mob.ai.behaviors;
  let present = false;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b instanceof VillagerWorkBehavior || b instanceof VillagerRestBehavior
      || b instanceof VillagerMeetingBehavior) {
      // Already equipped — re-point it at the manager that is asking, so a
      // reloaded world does not leave behaviours talking to a dead manager.
      b.manager = manager;
      present = true;
    }
  }
  if (present) return false;
  list.push(new VillagerRestBehavior(manager));
  list.push(new VillagerWorkBehavior(manager));
  list.push(new VillagerMeetingBehavior(manager));

  // `buildBehaviorsFor()` already gives villagers an AvoidEntityBehavior for
  // hostiles; add one only when this mob was built without it.
  let flees = false;
  for (let i = 0; i < list.length; i++) {
    if (list[i] instanceof AvoidEntityBehavior) { flees = true; break; }
  }
  if (!flees) {
    list.push(new AvoidEntityBehavior(
      (e) => e && e.def !== undefined && e.def.hostile === true && e.dead !== true,
      12, 1.4, 90,
    ));
  }
  list.sort((a, b) => b.priority - a.priority);
  return true;
}

/* ========================================================================== */
/* VillagerManager                                                            */
/* ========================================================================== */

/** Items a villager accepts as food, with the food points they are worth. @type {Map<number, number>} */
export const VILLAGER_FOOD = new Map();
for (const [name, value] of [['bread', 3], ['carrot', 1], ['potato', 1], ['beetroot', 1],
  ['wheat', 1], ['baked_potato', 2], ['cookie', 1], ['apple', 2], ['melon_slice', 1]]) {
  const id = itemIdByName(name);
  if (id > 0) VILLAGER_FOOD.set(id, value);
}

/** Scratch list reused by entity queries. @type {Object[]} */
const _query = [];

/** Scratch list of the points of interest a villager still lacks. @type {string[]} */
const _missing = [];

/**
 * Village life: professions, job sites, beds, trading, breeding and golems.
 *
 * Create one per world, call {@link VillagerManager#attach} once the world and
 * the entity manager exist, and {@link VillagerManager#tick} from the fixed
 * 20 TPS game tick.
 */
export class VillagerManager extends EventBus {
  /**
   * @param {Object} world The chunk manager.
   * @param {Object} entityManager The entity manager.
   * @param {{mobs?:Object, environment?:Object, audio?:Object, particles?:Object,
   *   farming?:Object, player?:Object, seed?:number, budgetMs?:number}} [options]
   *   Collaborators and tuning. `mobs` is the `MobSpawner`, `farming` the
   *   {@link module:game/farming.FarmingSystem} a farmer works its field with.
   */
  constructor(world, entityManager, options = {}) {
    super();

    /** @type {Object} The chunk manager. */
    this.world = world || null;
    /** @type {Object} The entity manager. */
    this.entities = entityManager || null;
    /** @type {?Object} The mob spawner, used for iron golems. */
    this.mobs = options.mobs || null;
    /** @type {?Object} Time and weather. */
    this.environment = options.environment || null;
    /** @type {?Object} Sound engine. */
    this.audio = options.audio || null;
    /** @type {?Object} Particle system. */
    this.particles = options.particles || null;
    /** @type {?Object} The farming system a farmer tends its field with. */
    this.farming = options.farming || null;
    /** @type {?Object} The player. */
    this.player = options.player || null;

    /** @type {number} Seed of this manager's PRNG. */
    this.seed = num(options.seed, (Math.random() * 0xffffffff) >>> 0) >>> 0;
    /** @type {() => number} Deterministic random source. */
    this.rng = mulberry32(this.seed);
    /** @type {number} Milliseconds the villager tick may use. */
    this.budgetMs = Math.max(0.2, num(options.budgetMs, DEFAULT_BUDGET_MS));

    /** @type {Map<number, VillagerData>} Live records by uid. @private */
    this._data = new Map();
    /** @type {Object[]} Loaded records waiting to be adopted. @private */
    this._pending = [];
    /** @type {Map<string, number>} Claimed block -> owning uid. @private */
    this._claims = new Map();
    /** @type {Map<string, Object>} Running point-of-interest searches. @private */
    this._poiJobs = new Map();
    /** @type {Map<string, number[]>} Beds the searches have seen, claimed or not. @private */
    this._knownBeds = new Map();
    /** @type {TradingSession[]} Open sessions. @private */
    this._sessions = [];

    /** @type {Object[]} Cached villager list. @private */
    this._villagers = [];
    /** @type {Object[]} Cached iron golem list. @private */
    this._golems = [];
    /** @type {number} Ticks until the entity lists are rebuilt. @private */
    this._listAge = 0;
    /** @type {Map<string, number>} Golem cooldown per village cell. @private */
    this._golemCooldown = new Map();
    /** @type {number} Seconds until the next census. @private */
    this._censusTimer = 0;
    /** @type {number} Which village the next census looks at. @private */
    this._censusCursor = 0;
    /** @type {number} Seconds elapsed. @private */
    this._time = 0;
    /** @type {number} Villagers born since construction. @private */
    this._births = 0;
    /** @type {number} Golems summoned since construction. @private */
    this._golemCount = 0;
    /** @type {number} Trades completed since construction. @private */
    this._trades = 0;

    /** @type {BlockView} Chunk-caching reader. @private */
    this._view = new BlockView(world);
    /** @type {TimeBudget} Tick budget. @private */
    this._budget = new TimeBudget(this.budgetMs);

    /** @type {?function(Object):void} Entity spawn listener. @private */
    this._onSpawn = null;
    /** @type {?function(Object):void} Entity remove listener. @private */
    this._onRemove = null;
    /** @type {?function(...*):void} Entity hurt listener. @private */
    this._onHurt = null;
    /** @type {?function(...*):void} Block change listener. @private */
    this._onBlock = null;
    /** @type {boolean} Whether {@link attach} ran. @private */
    this._attached = false;
  }

  /* ---------------------------------------------------------------- setup */

  /**
   * Adopt the collaborators carried by the game's shared tick context.
   * @param {Object} ctx The tick context.
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
   * Subscribe to the entity manager and the world. Safe to call twice.
   * @returns {VillagerManager} `this`.
   */
  attach() {
    if (this._attached) return this;
    this._attached = true;

    const em = this.entities;
    if (em !== null && typeof em.on === 'function') {
      this._onSpawn = (entity) => {
        try {
          if (this._isVillager(entity)) this.register(entity);
        } catch (err) {
          warnOnce('spawn', 'registering a spawned villager failed', err);
        }
      };
      this._onRemove = (entity) => {
        try {
          if (this._isVillager(entity) && entity.villagerData) this.releaseClaims(entity.villagerData);
        } catch (err) {
          warnOnce('remove', 'releasing a removed villager failed', err);
        }
      };
      this._onHurt = (entity, amount, source) => {
        try {
          if (this._isVillager(entity)) this.onVillagerHurt(entity, source);
        } catch (err) {
          warnOnce('hurt', 'reputation update failed', err);
        }
        void amount;
      };
      em.on('spawn', this._onSpawn);
      em.on('remove', this._onRemove);
      em.on('entityHurt', this._onHurt);
    }

    const world = this.world;
    if (world !== null && typeof world.on === 'function') {
      this._onBlock = (x, y, z, prev, next) => {
        try {
          this._onBlockChanged(x, y, z, prev, next);
        } catch (err) {
          warnOnce('blockChanged', 'claim bookkeeping failed', err);
        }
      };
      world.on('blockChanged', this._onBlock);
    }
    return this;
  }

  /**
   * Unsubscribe from every event source.
   * @returns {void}
   */
  detach() {
    const em = this.entities;
    if (em !== null && typeof em.off === 'function') {
      if (this._onSpawn !== null) em.off('spawn', this._onSpawn);
      if (this._onRemove !== null) em.off('remove', this._onRemove);
      if (this._onHurt !== null) em.off('entityHurt', this._onHurt);
    }
    const world = this.world;
    if (world !== null && typeof world.off === 'function' && this._onBlock !== null) {
      world.off('blockChanged', this._onBlock);
    }
    this._onSpawn = null;
    this._onRemove = null;
    this._onHurt = null;
    this._onBlock = null;
    this._attached = false;
  }

  /**
   * Is this entity a villager?
   * @param {Object} entity Candidate.
   * @returns {boolean} `true` for living villagers.
   * @private
   */
  _isVillager(entity) {
    return !!entity && (entity.typeName === 'villager' || entity.type === 'villager');
  }

  /* ------------------------------------------------------------- registry */

  /**
   * The record of a villager, created — or adopted from the save file — on
   * first access.
   * @param {Object} mob The villager.
   * @returns {VillagerData} Its record.
   */
  dataOf(mob) {
    if (mob.villagerData instanceof VillagerData) return mob.villagerData;
    return this.register(mob);
  }

  /**
   * Give a villager its record and its village behaviours.
   * @param {Object} mob The villager.
   * @returns {VillagerData} Its record.
   */
  register(mob) {
    if (mob.villagerData instanceof VillagerData) return mob.villagerData;

    let data = this._adoptPending(mob);
    if (data === null) {
      const profession = typeof mob.profession === 'string' && getProfession(mob.profession) !== null
        ? mob.profession : null;
      data = new VillagerData(0, profession, this.rng);
    }
    data.lastSeen[0] = mob.position[0];
    data.lastSeen[1] = mob.position[1];
    data.lastSeen[2] = mob.position[2];
    mob.villagerData = data;
    mob.profession = data.profession;
    this._data.set(data.uid, data);
    this._reclaim(data);
    attachVillagerBehaviors(mob, this);
    return data;
  }

  /**
   * Find the loaded record that belongs to a villager: by uid when the mob
   * still carries one, otherwise the nearest unclaimed record.
   * @param {Object} mob The villager.
   * @returns {?VillagerData} The adopted record, or `null`.
   * @private
   */
  _adoptPending(mob) {
    if (this._pending.length === 0) return null;
    const uid = num(mob.villagerUid, 0) | 0;
    let bestIndex = -1;
    let bestDist = 36;

    for (let i = 0; i < this._pending.length; i++) {
      const snapshot = this._pending[i];
      if (uid > 0 && (snapshot.uid | 0) === uid) { bestIndex = i; bestDist = -1; break; }
      const pos = Array.isArray(snapshot.pos) ? snapshot.pos : null;
      if (pos === null) continue;
      const dx = mob.position[0] - pos[0];
      const dy = mob.position[1] - pos[1];
      const dz = mob.position[2] - pos[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) { bestDist = d; bestIndex = i; }
    }
    if (bestIndex < 0) return null;
    const snapshot = this._pending.splice(bestIndex, 1)[0];
    const data = new VillagerData(0, null, this.rng).deserialize(snapshot);
    mob.villagerUid = data.uid;
    return data;
  }

  /**
   * Re-register the claims a loaded record brought with it.
   * @param {VillagerData} data The record.
   * @returns {void}
   * @private
   */
  _reclaim(data) {
    if (data.workstation !== null) this._claims.set(posKey(...data.workstation), data.uid);
    if (data.bed !== null) this._claims.set(posKey(...data.bed), data.uid);
  }

  /**
   * Drop every claim a villager holds.
   * @param {VillagerData} data The record.
   * @returns {void}
   */
  releaseClaims(data) {
    if (!data) return;
    if (data.workstation !== null) {
      const key = posKey(...data.workstation);
      if (this._claims.get(key) === data.uid) this._claims.delete(key);
      data.workstation = null;
    }
    if (data.bed !== null) {
      const key = posKey(...data.bed);
      if (this._claims.get(key) === data.uid) this._claims.delete(key);
      data.bed = null;
    }
  }

  /**
   * Whether a block is already spoken for by another villager.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} uid The asking villager.
   * @returns {boolean} `true` when somebody else owns it.
   * @private
   */
  _isClaimed(x, y, z, uid) {
    const owner = this._claims.get(posKey(x, y, z));
    return owner !== undefined && owner !== uid && this._data.has(owner);
  }

  /**
   * A claimed block was replaced: give the claim up.
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
    if (this._claims.size === 0) return;
    const key = posKey(x, y, z);
    const uid = this._claims.get(key);
    if (uid === undefined) return;
    const data = this._data.get(uid);
    if (data === undefined) {
      this._claims.delete(key);
      return;
    }
    const stillWork = data.workstation !== null && posKey(...data.workstation) === key;
    const stillBed = data.bed !== null && posKey(...data.bed) === key;
    if (stillWork) {
      const profession = getProfession(data.profession);
      if (profession === null || next !== profession.station) {
        this._claims.delete(key);
        data.workstation = null;
      }
      return;
    }
    if (stillBed && next !== BED_BLOCK) {
      this._claims.delete(key);
      data.bed = null;
    }
  }

  /* ------------------------------------------------------------------ time */

  /**
   * The environment currently in use.
   * @param {Object} [ctx] Tick context.
   * @returns {?Object} The environment, or `null`.
   * @private
   */
  _env(ctx) {
    if (ctx && ctx.environment) return ctx.environment;
    return this.environment;
  }

  /**
   * Is the sun up?
   * @param {Object} [ctx] Tick context.
   * @returns {boolean} `true` during the day (and when there is no clock).
   */
  isDay(ctx) {
    const env = this._env(ctx);
    if (env === null || typeof env.isDay !== 'function') return true;
    try {
      return env.isDay() === true;
    } catch (err) {
      warnOnce('isDay', 'environment.isDay failed; villagers assume daytime', err);
      return true;
    }
  }

  /**
   * Is it night?
   * @param {Object} [ctx] Tick context.
   * @returns {boolean} `true` after sunset.
   */
  isNight(ctx) {
    return !this.isDay(ctx);
  }

  /**
   * Is it time for the village to gather?
   * @param {Object} [ctx] Tick context.
   * @returns {boolean} `true` inside the meeting window.
   */
  isMeetingTime(ctx) {
    const env = this._env(ctx);
    if (env === null) return false;
    const t = num(env.timeOfDay, -1);
    return t >= MEETING_START && t < MEETING_END;
  }

  /**
   * The current in-game day.
   * @param {Object} [ctx] Tick context.
   * @returns {number} Day count, `0` without a clock.
   * @private
   */
  _day(ctx) {
    const env = this._env(ctx);
    return env === null ? 0 : num(env.dayCount, 0) | 0;
  }

  /* ------------------------------------------------------------------ tick */

  /**
   * One fixed game tick. Never throws.
   * @param {number} dt Seconds since the last tick.
   * @param {Object} [ctx] The game's shared tick context.
   * @returns {void}
   */
  tick(dt, ctx) {
    if (ctx !== undefined) this.setContext(ctx);
    const step = clamp(num(dt, 0.05), 0, 0.25);
    this._time += step;
    this._budget.setBudget(this.budgetMs).start();
    this._view.invalidate();

    try {
      this._refreshLists();
    } catch (err) {
      warnOnce('lists', 'rebuilding the villager list failed', err);
    }
    try {
      this._updateVillagers(step, ctx);
    } catch (err) {
      warnOnce('update', 'villager upkeep failed this tick', err);
    }
    try {
      this._processPOI();
    } catch (err) {
      warnOnce('poi', 'point-of-interest search failed; job sites paused', err);
    }
    this._censusTimer -= step;
    if (this._censusTimer <= 0) {
      this._censusTimer = CENSUS_INTERVAL;
      try {
        this._census(ctx);
      } catch (err) {
        warnOnce('census', 'village census failed', err);
      }
    }
  }

  /**
   * Rebuild the cached villager and golem lists every 20 ticks.
   * @returns {void}
   * @private
   */
  _refreshLists() {
    if (this._listAge > 0) {
      this._listAge--;
      return;
    }
    this._listAge = 20;
    this._villagers.length = 0;
    this._golems.length = 0;
    const em = this.entities;
    if (em === null || !em.entities || typeof em.entities.forEach !== 'function') return;
    em.entities.forEach((e) => {
      if (!e || e.removed === true || e.dead === true) return;
      if (this._isVillager(e)) this._villagers.push(e);
      else if (e.typeName === 'iron_golem' || e.type === 'iron_golem') this._golems.push(e);
    });
  }

  /**
   * Per-villager upkeep: timers, waking up, and posting job-site searches.
   * @param {number} step Seconds since the last tick.
   * @param {Object} [ctx] Tick context.
   * @returns {void}
   * @private
   */
  _updateVillagers(step, ctx) {
    const list = this._villagers;
    const day = this._day(ctx);
    const night = this.isNight(ctx);

    for (let i = 0; i < list.length; i++) {
      const mob = list[i];
      if (!mob || mob.removed === true || mob.dead === true) continue;
      const data = this.dataOf(mob);
      data.lastSeen[0] = mob.position[0];
      data.lastSeen[1] = mob.position[1];
      data.lastSeen[2] = mob.position[2];
      if (data.poiCooldown > 0) data.poiCooldown = Math.max(0, data.poiCooldown - step);
      if (data.breedCooldown > 0) data.breedCooldown = Math.max(0, data.breedCooldown - step);

      if (data.sleeping && !night) {
        data.sleeping = false;
        mob.animation.sit = 0;
        this.emit('sleep', mob, false);
      }

      if (data.lastDecayDay < 0) {
        data.lastDecayDay = day;
      } else if (day > data.lastDecayDay) {
        this._decayReputation(data, day - data.lastDecayDay);
        data.lastDecayDay = day;
        data.restocksToday = 0;
      }

      if (mob.isBaby === true) continue;
      // Search for whatever is still missing, one kind per turn: a village with
      // no free workstation must not stop its people from ever finding a bed.
      _missing.length = 0;
      if (data.workstation === null) _missing.push('workstation');
      if (data.bed === null) _missing.push('bed');
      if (data.meeting === null) _missing.push('meeting');
      if (_missing.length > 0) {
        const kind = _missing[data.poiTurn % _missing.length];
        if (this.requestPOI(mob, kind)) data.poiTurn = (data.poiTurn + 1) % 6;
      }
    }
  }

  /**
   * Move every reputation entry a little back towards neutral.
   * @param {VillagerData} data The record.
   * @param {number} days Days that passed.
   * @returns {void}
   * @private
   */
  _decayReputation(data, days) {
    const amount = REPUTATION_DECAY_PER_DAY * Math.max(1, days | 0);
    for (const [key, value] of data.reputation) {
      const next = value > 0 ? Math.max(0, value - amount) : Math.min(0, value + amount);
      if (next === 0) data.reputation.delete(key);
      else data.reputation.set(key, next);
    }
  }

  /* ------------------------------------------------------- points of interest */

  /**
   * Post a sliced search for a workstation, a bed or the meeting point.
   * @param {Object} mob The villager.
   * @param {'workstation'|'bed'|'meeting'} kind What to look for.
   * @returns {boolean} `true` when a new search was started.
   */
  requestPOI(mob, kind) {
    const data = mob.villagerData instanceof VillagerData ? mob.villagerData : this.dataOf(mob);
    if (data.poiCooldown > 0) return false;
    const key = `${data.uid}:${kind}`;
    if (this._poiJobs.has(key)) return false;
    if (kind === 'bed' && BED_BLOCK <= 0) return false;
    if (kind === 'meeting' && MEETING_BLOCK <= 0) return false;

    this._poiJobs.set(key, {
      uid: data.uid,
      mob,
      kind,
      // A villager that has already traded keeps its craft; one that never did
      // takes whatever job site the village has free.
      profession: data.xp > 0 ? data.profession : null,
      cx: Math.floor(mob.position[0]),
      cy: Math.floor(mob.position[1]),
      cz: Math.floor(mob.position[2]),
      dy: -POI_HEIGHT,
      best: null,
      bestBlock: 0,
      bestDist: Infinity,
    });
    data.poiCooldown = POI_RETRY_SECONDS;
    return true;
  }

  /**
   * Advance every running search by one horizontal layer, under the tick
   * budget.
   * @returns {void}
   * @private
   */
  _processPOI() {
    if (this._poiJobs.size === 0) return;
    const budget = this._budget;
    const finished = [];
    for (const [key, job] of this._poiJobs) {
      if (budget.expired()) break;
      const mob = job.mob;
      if (!mob || mob.removed === true || mob.dead === true || !this._data.has(job.uid)) {
        finished.push(key);
        continue;
      }
      this._scanPOILayer(job);
      if (job.dy > POI_HEIGHT) {
        this._finishPOI(job);
        finished.push(key);
      }
    }
    for (let i = 0; i < finished.length; i++) this._poiJobs.delete(finished[i]);
  }

  /**
   * Does this block satisfy the search?
   * @param {Object} job The running search.
   * @param {number} id Block id.
   * @returns {boolean} `true` for a candidate.
   * @private
   */
  _poiMatches(job, id) {
    if (job.kind === 'bed') return id === BED_BLOCK;
    if (job.kind === 'meeting') return id === MEETING_BLOCK;
    const profession = professionForStation(id);
    if (profession === null) return false;
    if (job.profession !== null && profession.key !== job.profession) return false;
    return true;
  }

  /**
   * Scan one horizontal layer of a search box.
   * @param {Object} job The running search.
   * @returns {void}
   * @private
   */
  _scanPOILayer(job) {
    const view = this._view;
    const y = job.cy + job.dy;
    if (y > WORLD_MIN_Y && y < WORLD_MAX_Y) {
      for (let dz = -POI_RADIUS; dz <= POI_RADIUS; dz++) {
        const z = job.cz + dz;
        for (let dx = -POI_RADIUS; dx <= POI_RADIUS; dx++) {
          const x = job.cx + dx;
          const id = view.get(x, y, z);
          if (id === 0) continue;
          // Every search doubles as a bed survey: knowing where the *unclaimed*
          // beds are is what tells the census whether the village has room to
          // grow. Recording them here costs one map write and no extra reads.
          if (id === BED_BLOCK) this._noteBed(x, y, z);
          if (!this._poiMatches(job, id)) continue;
          if (job.kind !== 'meeting' && this._isClaimed(x, y, z, job.uid)) continue;
          const dist = dx * dx + dz * dz + job.dy * job.dy * 4;
          if (dist >= job.bestDist) continue;
          job.bestDist = dist;
          job.bestBlock = id;
          if (job.best === null) job.best = [x, y, z];
          else { job.best[0] = x; job.best[1] = y; job.best[2] = z; }
        }
      }
    }
    job.dy++;
  }

  /**
   * Remember a bed a search walked past, so the census can tell claimed beds
   * from free ones. The registry is bounded; the oldest entry is dropped when
   * it overflows.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _noteBed(x, y, z) {
    const key = posKey(x, y, z);
    if (this._knownBeds.has(key)) return;
    if (this._knownBeds.size >= 512) {
      const oldest = this._knownBeds.keys().next();
      if (!oldest.done) this._knownBeds.delete(oldest.value);
    }
    this._knownBeds.set(key, [x, y, z]);
  }

  /**
   * How many beds inside a village are still free — the number that decides
   * whether the village may grow. Entries whose block is gone are pruned.
   * @param {number} cx Village centre X.
   * @param {number} cy Village centre Y.
   * @param {number} cz Village centre Z.
   * @returns {number} Free beds, `0` when the world has no bed block at all.
   * @private
   */
  _freeBedsNear(cx, cy, cz) {
    if (BED_BLOCK <= 0 || this._knownBeds.size === 0) return 0;
    const view = this._view;
    const r2 = VILLAGE_RADIUS * VILLAGE_RADIUS;
    let free = 0;
    let stale = null;
    for (const [key, pos] of this._knownBeds) {
      const dx = pos[0] + 0.5 - cx;
      const dy = pos[1] - cy;
      const dz = pos[2] + 0.5 - cz;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (view.get(pos[0], pos[1], pos[2]) !== BED_BLOCK) {
        if (stale === null) stale = [];
        stale.push(key);
        continue;
      }
      const owner = this._claims.get(key);
      if (owner !== undefined && this._data.has(owner)) continue;
      free++;
    }
    if (stale !== null) for (let i = 0; i < stale.length; i++) this._knownBeds.delete(stale[i]);
    return free;
  }

  /**
   * Claim what a finished search found.
   * @param {Object} job The finished search.
   * @returns {void}
   * @private
   */
  _finishPOI(job) {
    const data = this._data.get(job.uid);
    const mob = job.mob;
    if (data === undefined) return;
    if (job.best === null) {
      data.poiCooldown = POI_RETRY_SECONDS;
      return;
    }
    const x = job.best[0];
    const y = job.best[1];
    const z = job.best[2];

    // The world moved on while the search was slicing through its layers: the
    // block may be gone, and another villager may have claimed it in the
    // meantime. Re-validate before taking it, or two villagers end up sharing
    // one workstation.
    if (job.kind !== 'meeting') {
      this._view.invalidate();
      const current = this._view.get(x, y, z);
      if (current !== job.bestBlock || this._isClaimed(x, y, z, job.uid)) {
        data.poiCooldown = POI_RETRY_SECONDS;
        return;
      }
    }

    if (job.kind === 'workstation') {
      const profession = professionForStation(job.bestBlock);
      if (profession === null) return;
      if (data.profession !== profession.key) {
        data.setProfession(profession.key);
        mob.profession = profession.key;
        this.emit('assigned', mob, profession.key);
      }
      data.workstation = [x, y, z];
      this._claims.set(posKey(x, y, z), data.uid);
      this.emit('claimWork', mob, x, y, z);
    } else if (job.kind === 'bed') {
      data.bed = [x, y, z];
      this._claims.set(posKey(x, y, z), data.uid);
      // The stock `VillagerRoutineBehavior` homes on `mob.home`; pointing it at
      // the bed is what keeps a villager inside its own village.
      mob.home = [x, y, z];
      this.emit('claimBed', mob, x, y, z);
    } else {
      data.meeting = [x, y, z];
    }
    data.poiCooldown = 0;
  }

  /**
   * Find a covered, walkable spot for a villager that has no bed.
   * @param {Object} mob The villager.
   * @returns {?number[]} A block position, or `null`.
   */
  findShelter(mob) {
    const view = this._view;
    view.invalidate();
    const px = Math.floor(mob.position[0]);
    const py = Math.floor(mob.position[1]);
    const pz = Math.floor(mob.position[2]);
    let best = null;
    let bestDist = Infinity;

    for (let dz = -6; dz <= 6; dz++) {
      for (let dx = -6; dx <= 6; dx++) {
        const dist = dx * dx + dz * dz;
        if (dist >= bestDist) continue;
        const x = px + dx;
        const z = pz + dz;
        if (view.get(x, py, z) !== 0 || view.get(x, py + 1, z) !== 0) continue;
        if (!isSolid(view.get(x, py - 1, z))) continue;
        let roof = false;
        for (let dy = 2; dy <= 5; dy++) {
          if (isOpaque(view.get(x, py + dy, z))) { roof = true; break; }
        }
        if (!roof) continue;
        bestDist = dist;
        best = [x, py, z];
      }
    }
    return best;
  }

  /**
   * The villager closest to another one, for the meeting-point chatter.
   * @param {Object} mob The asking villager.
   * @param {Object} [ctx] Tick context (unused, kept for symmetry).
   * @param {number} [radius=8] Search radius.
   * @returns {?Object} The neighbour, or `null`.
   */
  nearestVillager(mob, ctx, radius = 8) {
    void ctx;
    const list = this._villagers;
    let best = null;
    let bestDist = radius * radius;
    for (let i = 0; i < list.length; i++) {
      const other = list[i];
      if (other === mob || !other || other.removed === true) continue;
      const dx = other.position[0] - mob.position[0];
      const dy = other.position[1] - mob.position[1];
      const dz = other.position[2] - mob.position[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) { bestDist = d; best = other; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ work */

  /**
   * Called every tick while a villager stands at its own workstation: restock
   * twice a day, and do the job the profession actually implies.
   * @param {Object} mob The villager.
   * @param {VillagerData} data Its record.
   * @param {number} dt Seconds since the last tick.
   * @param {Object} [ctx] Tick context.
   * @returns {void}
   */
  workAtStation(mob, data, dt, ctx) {
    this._tryRestock(mob, data, ctx);
    if (data.profession === 'farmer') this._farmerWork(mob, data, dt);

    data.workTimer += dt;
    if (data.workTimer < 3) return;
    data.workTimer = 0;
    const station = data.workstation;
    if (station === null) return;
    this._workParticles(station[0], station[1], station[2]);
    this.emit('work', mob, station[0], station[1], station[2]);
  }

  /**
   * Refill the offers once per half-day window, at the workstation.
   * @param {Object} mob The villager.
   * @param {VillagerData} data Its record.
   * @param {Object} [ctx] Tick context.
   * @returns {boolean} `true` when a restock happened.
   * @private
   */
  _tryRestock(mob, data, ctx) {
    const env = this._env(ctx);
    if (env === null) return false;
    const slot = this._day(ctx) * RESTOCKS_PER_DAY
      + (num(env.timeOfDay, 0) < 0.5 ? 0 : 1);
    if (data.restockSlot === slot) return false;
    const first = data.restockSlot < 0;
    data.restockSlot = slot;
    if (first) return false;
    if (data.restocksToday >= RESTOCKS_PER_DAY) return false;
    data.restocksToday++;
    data.restock();
    this.emit('restock', mob);
    return true;
  }

  /**
   * A farmer harvests one ripe crop or sows one bare patch of farmland per
   * inspection, and puts the produce towards the village food stock.
   * @param {Object} mob The farmer.
   * @param {VillagerData} data Its record.
   * @param {number} dt Seconds since the last tick.
   * @returns {boolean} `true` when the farmer did something.
   * @private
   */
  _farmerWork(mob, data, dt) {
    data.farmTimer -= dt;
    if (data.farmTimer > 0) return false;
    data.farmTimer = FARM_SCAN_INTERVAL;
    const farming = this.farming;
    if (farming === null) return false;

    const view = this._view;
    const px = Math.floor(mob.position[0]);
    const py = Math.floor(mob.position[1]);
    const pz = Math.floor(mob.position[2]);
    let sowX = 0;
    let sowY = 0;
    let sowZ = 0;
    let sow = false;

    for (let dy = 1; dy >= -1; dy--) {
      for (let dz = -FARM_RADIUS; dz <= FARM_RADIUS; dz++) {
        for (let dx = -FARM_RADIUS; dx <= FARM_RADIUS; dx++) {
          const x = px + dx;
          const y = py + dy;
          const z = pz + dz;
          const id = view.get(x, y, z);
          if (isMatureCrop(id)) {
            const family = cropFamilyOf(id);
            if (farming.harvestAt(x, y, z, true) !== null) {
              data.food = Math.min(64, data.food + 2);
              this.emit('harvest', mob, x, y, z, family === null ? '' : family.key);
              return true;
            }
          } else if (!sow && id === 0 && view.get(x, y - 1, z) === B.FARMLAND) {
            sow = true;
            sowX = x;
            sowY = y;
            sowZ = z;
          }
        }
      }
    }

    if (sow) {
      const seed = itemIdByName('wheat_seeds');
      if (seed > 0 && farming.plantAt(sowX, sowY, sowZ, seed)) {
        this.emit('sow', mob, sowX, sowY, sowZ);
        return true;
      }
    }
    return false;
  }

  /**
   * The little puff a working villager makes.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _workParticles(x, y, z) {
    const particles = this.particles;
    if (particles === null || typeof particles.spawn !== 'function') return;
    try {
      particles.spawn('spark', x + 0.5, y + 1.1, z + 0.5,
        { count: 4, speed: 0.5, life: 0.6, color: [0.85, 0.8, 0.5] });
    } catch (err) {
      warnOnce('particles', 'work particles failed', err);
    }
  }

  /* --------------------------------------------------------------- trading */

  /**
   * Can this villager trade right now?
   * @param {Object} mob The villager.
   * @returns {boolean} `true` when a session may be opened.
   */
  canTrade(mob) {
    if (!this._isVillager(mob) || mob.dead === true || mob.removed === true) return false;
    if (mob.isBaby === true) return false;
    const data = this.dataOf(mob);
    if (data.sleeping) return false;
    return data.profession !== null && data.offers.length > 0;
  }

  /**
   * Open a trading session; the UI drives the returned object.
   * @param {Object} mob The villager.
   * @param {Object} player The player.
   * @returns {?TradingSession} The session, or `null` when the villager will
   *   not trade.
   */
  openTrade(mob, player) {
    if (!this.canTrade(mob)) return null;
    for (let i = 0; i < this._sessions.length; i++) {
      if (this._sessions[i].villager === mob) this._sessions[i].close();
    }
    const session = new TradingSession(this, mob, player);
    this._sessions.push(session);
    if (typeof mob.faceEntity === 'function') mob.faceEntity(player);
    this.emit('openTrade', mob, player);
    return session;
  }

  /**
   * Forget a closed session.
   * @param {TradingSession} session The session.
   * @returns {void}
   */
  closeSession(session) {
    const i = this._sessions.indexOf(session);
    if (i >= 0) this._sessions.splice(i, 1);
  }

  /**
   * Whether an inventory has room for a stack.
   * @param {Object} inv The inventory.
   * @param {ItemStack} stack The stack.
   * @returns {boolean} `true` when it fits somewhere.
   * @private
   */
  _hasRoomFor(inv, stack) {
    if (!inv) return false;
    const from = Number.isFinite(inv.storageStart) ? inv.storageStart : 0;
    const to = Number.isFinite(inv.storageEnd) ? inv.storageEnd : inv.size - 1;
    if (typeof inv.firstEmpty === 'function' && inv.firstEmpty(from, to) >= 0) return true;
    if (typeof inv.findPartial === 'function' && inv.findPartial(stack, from) >= 0) return true;
    return false;
  }

  /**
   * Run one trade: check the price, hand over the goods, take the payment and
   * pay the villager in experience and goodwill.
   * @param {Object} mob The villager.
   * @param {TradeOffer} offer The offer.
   * @param {Object} player The player.
   * @returns {{ok:boolean, message:string, stack:?ItemStack}} The outcome with
   *   a German message.
   */
  executeTrade(mob, offer, player) {
    const out = { ok: false, message: '', stack: null };
    if (!offer) {
      out.message = 'Dieses Angebot gibt es nicht.';
      return out;
    }
    if (offer.outOfStock) {
      out.message = 'Ausverkauft — komm später wieder.';
      return out;
    }
    const data = this.dataOf(mob);
    const playerId = playerIdOf(player);
    const price = offer.priceFor(data.reputationOf(playerId));
    const creative = player && player.gameMode === 'creative';
    const inv = player && player.inventory ? player.inventory : null;

    if (!creative) {
      if (inv === null || typeof inv.count !== 'function') {
        out.message = 'Du kannst gerade nicht handeln.';
        return out;
      }
      if (inv.count(offer.priceItem) < price) {
        out.message = `Du brauchst ${price}x ${itemDisplay(offer.priceItem)}.`;
        return out;
      }
      if (offer.second !== null && inv.count(offer.second.itemId) < offer.second.count) {
        out.message = `Du brauchst ${offer.second.count}x ${itemDisplay(offer.second.itemId)}.`;
        return out;
      }
    }

    const stack = offer.createResult();
    if (stack === null) {
      out.message = 'Der Händler hat gerade nichts anzubieten.';
      return out;
    }
    if (inv !== null && !this._hasRoomFor(inv, stack)) {
      out.message = 'Dein Inventar ist voll.';
      return out;
    }

    if (!creative && inv !== null) {
      inv.removeItem(offer.priceItem, price);
      if (offer.second !== null) inv.removeItem(offer.second.itemId, offer.second.count);
    }

    let leftover = null;
    if (inv !== null) {
      try {
        leftover = typeof inv.addPickup === 'function' ? inv.addPickup(stack) : inv.add(stack);
      } catch (err) {
        warnOnce('give', 'handing over a traded item failed', err);
        leftover = stack;
      }
    } else {
      leftover = stack;
    }
    if (leftover !== null && typeof leftover.isEmpty === 'function' && !leftover.isEmpty()) {
      this._dropNear(player, leftover);
    }

    offer.uses++;
    data.food = Math.min(64, data.food + 1);
    this._trades++;
    const leveled = data.addXP(offer.xp);
    data.addReputation(playerId, REPUTATION_PER_TRADE);
    this._playSound('trade', mob);

    out.ok = true;
    out.stack = stack;
    out.message = 'Handel abgeschlossen.';
    this.emit('trade', mob, offer, player);
    if (leveled) {
      this.emit('levelUp', mob, data.level);
      this._playSound('levelup', mob);
    }
    return out;
  }

  /**
   * Drop a stack at the player's feet when the inventory could not take it.
   * @param {Object} player The player.
   * @param {ItemStack} stack The stack.
   * @returns {void}
   * @private
   */
  _dropNear(player, stack) {
    const em = this.entities;
    if (em === null || typeof em.dropItem !== 'function' || !player || !player.position) return;
    try {
      em.dropItem(player.position[0], player.position[1] + 0.5, player.position[2], stack, null);
    } catch (err) {
      warnOnce('drop', 'dropping a traded item failed', err);
    }
  }

  /**
   * Play one of the villager sounds, guarded.
   * @param {string} name Sound name.
   * @param {Object} mob The villager.
   * @returns {void}
   * @private
   */
  _playSound(name, mob) {
    const audio = this.audio;
    if (audio === null || typeof audio.play !== 'function') return;
    try {
      audio.play(name, { x: mob.position[0], y: mob.position[1] + 1, z: mob.position[2], volume: 0.8 });
    } catch (err) {
      warnOnce('audio', 'villager sound failed', err);
    }
  }

  /**
   * The player hurt a villager: everybody in earshot thinks worse of them.
   * @param {Object} mob The villager.
   * @param {string} source Damage source id.
   * @returns {void}
   */
  onVillagerHurt(mob, source) {
    if (source !== 'player' && source !== 'arrow') return;
    const playerId = playerIdOf(this.player);
    const data = this.dataOf(mob);
    data.addReputation(playerId, -REPUTATION_ON_HURT);
    const list = this._villagers;
    for (let i = 0; i < list.length; i++) {
      const other = list[i];
      if (other === mob || !other.villagerData) continue;
      const dx = other.position[0] - mob.position[0];
      const dz = other.position[2] - mob.position[2];
      if (dx * dx + dz * dz > 256) continue;
      other.villagerData.addReputation(playerId, -Math.round(REPUTATION_ON_HURT / 2));
    }
  }

  /**
   * Feed a villager: food makes it willing to breed.
   * @param {Object} mob The villager.
   * @param {Object} player The player.
   * @returns {boolean} `true` when the food was accepted.
   */
  feedVillager(mob, player) {
    if (!this._isVillager(mob) || !player) return false;
    const inv = player.inventory;
    let stack = null;
    if (inv && typeof inv.getSelected === 'function') stack = inv.getSelected();
    if (stack === null || stack === undefined || (typeof stack.isEmpty === 'function' && stack.isEmpty())) {
      return false;
    }
    const value = VILLAGER_FOOD.get(stack.itemId);
    if (value === undefined) return false;

    const data = this.dataOf(mob);
    data.food = Math.min(64, data.food + value);
    if (player.gameMode !== 'creative' && typeof inv.consumeSelected === 'function') {
      inv.consumeSelected(1);
    }
    this.emit('fed', mob, data.food);
    return true;
  }

  /**
   * Right-click on a villager: hand over food, or open the trade screen.
   * @param {Object} player The player.
   * @param {Object} mob The villager.
   * @returns {?TradingSession} The opened session, or `null` when the
   *   interaction was food (or refused).
   */
  interact(player, mob) {
    if (this.feedVillager(mob, player)) return null;
    return this.openTrade(mob, player);
  }

  /* ---------------------------------------------------------------- census */

  /**
   * Look at one village: count its people and beds, summon an iron golem when
   * it is big enough, and let a willing pair breed when there is a spare bed.
   * A different village is examined on each census, so the cost stays flat no
   * matter how many villages exist.
   * @param {Object} [ctx] Tick context.
   * @returns {void}
   * @private
   */
  _census(ctx) {
    const list = this._villagers;
    if (list.length === 0) return;
    if (this._censusCursor >= list.length) this._censusCursor = 0;

    const anchor = list[this._censusCursor];
    this._censusCursor++;
    if (!anchor || anchor.removed === true || !anchor.villagerData) return;

    const members = _query;
    members.length = 0;
    members.push(anchor);
    let beds = anchor.villagerData.bed !== null ? 1 : 0;
    let cx = anchor.position[0];
    let cy = anchor.position[1];
    let cz = anchor.position[2];
    const r2 = VILLAGE_RADIUS * VILLAGE_RADIUS;

    for (let i = 0; i < list.length; i++) {
      const other = list[i];
      if (other === anchor || !other || other.removed === true) continue;
      const dx = other.position[0] - anchor.position[0];
      const dy = other.position[1] - anchor.position[1];
      const dz = other.position[2] - anchor.position[2];
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      members.push(other);
      const data = other.villagerData;
      if (data && data.bed !== null) beds++;
      cx += other.position[0];
      cy += other.position[1];
      cz += other.position[2];
    }

    const count = members.length;
    cx /= count;
    cy /= count;
    cz /= count;
    const freeBeds = this._freeBedsNear(cx, cy, cz);
    this.emit('census', count, beds, cx, cy, cz, freeBeds);
    this._tryGolem(members, count, beds, cx, cy, cz);
    this._tryBreed(members, freeBeds, ctx);
    members.length = 0;
  }

  /**
   * Summon an iron golem when the village is big enough, has beds, has no
   * golem nearby, and its cooldown has run out.
   * @param {Object[]} members The villagers of this village.
   * @param {number} count How many there are.
   * @param {number} beds How many claimed beds they have.
   * @param {number} cx Village centre X.
   * @param {number} cy Village centre Y.
   * @param {number} cz Village centre Z.
   * @returns {?Object} The golem, or `null`.
   * @private
   */
  _tryGolem(members, count, beds, cx, cy, cz) {
    if (count < IRON_GOLEM_MIN_VILLAGERS || beds < IRON_GOLEM_MIN_BEDS) return null;
    const cell = `${Math.floor(cx / 16)},${Math.floor(cz / 16)}`;
    const until = this._golemCooldown.get(cell);
    if (until !== undefined && until > this._time) return null;

    const spacing = IRON_GOLEM_SPACING * IRON_GOLEM_SPACING;
    for (let i = 0; i < this._golems.length; i++) {
      const g = this._golems[i];
      if (!g || g.removed === true) continue;
      const dx = g.position[0] - cx;
      const dz = g.position[2] - cz;
      if (dx * dx + dz * dz < spacing) {
        this._golemCooldown.set(cell, this._time + IRON_GOLEM_COOLDOWN * 0.5);
        return null;
      }
    }

    const spot = this._findGolemSpot(cx, cy, cz);
    if (spot === null) {
      this._golemCooldown.set(cell, this._time + 30);
      return null;
    }

    let golem = null;
    try {
      if (this.mobs !== null && typeof this.mobs.spawnMob === 'function') {
        golem = this.mobs.spawnMob('iron_golem', spot[0] + 0.5, spot[1], spot[2] + 0.5);
      } else {
        golem = createMob('iron_golem', spot[0] + 0.5, spot[1], spot[2] + 0.5, { rng: this.rng });
        if (golem !== null && this.entities !== null && typeof this.entities.spawn === 'function') {
          this.entities.spawn(golem);
        }
      }
    } catch (err) {
      warnOnce('golem', 'spawning an iron golem failed', err);
      golem = null;
    }
    this._golemCooldown.set(cell, this._time + IRON_GOLEM_COOLDOWN);
    if (golem === null) return null;

    golem.home = [Math.round(cx), Math.round(cy), Math.round(cz)];
    this._golems.push(golem);
    this._golemCount++;
    for (let i = 0; i < members.length; i++) {
      const data = members[i].villagerData;
      if (data) data.food = Math.max(0, data.food - 1);
    }
    this.emit('golem', golem, spot[0], spot[1], spot[2]);
    return golem;
  }

  /**
   * Find solid ground with head room near a village centre.
   * @param {number} cx Centre X.
   * @param {number} cy Centre Y.
   * @param {number} cz Centre Z.
   * @returns {?number[]} `[x, y, z]` where `y` is the free cell to stand in.
   * @private
   */
  _findGolemSpot(cx, cy, cz) {
    const view = this._view;
    view.invalidate();
    const baseX = Math.floor(cx);
    const baseY = Math.floor(cy);
    const baseZ = Math.floor(cz);

    for (let attempt = 0; attempt < 16; attempt++) {
      const x = baseX + Math.round((this.rng() * 2 - 1) * 8);
      const z = baseZ + Math.round((this.rng() * 2 - 1) * 8);
      for (let dy = 3; dy >= -4; dy--) {
        const y = baseY + dy;
        if (y <= WORLD_MIN_Y + 1 || y >= WORLD_MAX_Y - 4) continue;
        if (!isSolid(view.get(x, y - 1, z))) continue;
        let free = true;
        for (let h = 0; h < 3 && free; h++) {
          if (view.get(x, y + h, z) !== 0) free = false;
          if (view.get(x + 1, y + h, z) !== 0) free = false;
          if (view.get(x, y + h, z + 1) !== 0) free = false;
        }
        if (!free) continue;
        return [x, y, z];
      }
    }
    return null;
  }

  /**
   * Put two willing villagers into love mode when the village has a spare bed
   * and they are both well fed. The pairing, the walk towards each other, the
   * baby and the shared cooldown are all handled by `game/mobs.js`.
   * @param {Object[]} members The villagers of this village.
   * @param {number} freeBeds Unclaimed beds inside the village.
   * @param {Object} [ctx] Tick context.
   * @returns {boolean} `true` when a pair started breeding.
   * @private
   */
  _tryBreed(members, freeBeds, ctx) {
    if (freeBeds < 1) return false;
    if (this.isNight(ctx)) return false;
    let a = null;
    let b = null;
    for (let i = 0; i < members.length; i++) {
      const mob = members[i];
      const data = mob.villagerData;
      if (!data || mob.isBaby === true || mob.dead === true) continue;
      if (data.food < BREED_FOOD_THRESHOLD) continue;
      if (data.breedCooldown > 0) continue;
      if (num(mob.loveTimer, 0) > 0 || num(mob.breedCooldown, 0) > 0) continue;
      if (a === null) a = mob;
      else { b = mob; break; }
    }
    if (a === null || b === null) return false;

    for (const mob of [a, b]) {
      const data = mob.villagerData;
      data.food = Math.max(0, data.food - BREED_FOOD_THRESHOLD);
      data.breedCooldown = BREED_INTERVAL;
      mob.loveTimer = BREED_LOVE_SECONDS;
    }
    this._births++;
    this.emit('breed', a, b);
    return true;
  }

  /* ----------------------------------------------------------- persistence */

  /**
   * Snapshot of every villager record, including the ones whose mob has not
   * been loaded yet.
   * @returns {{version:number, seed:number, nextUid:number,
   *   villagers:Object[]}} The snapshot.
   */
  serialize() {
    const villagers = [];
    for (const data of this._data.values()) villagers.push(data.serialize());
    for (let i = 0; i < this._pending.length; i++) villagers.push(this._pending[i]);
    return {
      version: VILLAGER_SAVE_VERSION,
      seed: this.seed,
      nextUid: NEXT_UID,
      villagers,
    };
  }

  /**
   * Restore a snapshot written by {@link VillagerManager#serialize}. Records
   * are parked until their villagers show up; villagers that are already in the
   * world re-adopt immediately.
   * @param {Object} snapshot The snapshot.
   * @returns {boolean} `true` when the snapshot was applied.
   */
  deserialize(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (num(snapshot.version, 0) > VILLAGER_SAVE_VERSION) {
      warnOnce('saveVersion', `villager snapshot version ${snapshot.version} is newer than ${VILLAGER_SAVE_VERSION}; ignored`);
      return false;
    }
    if (Number.isFinite(snapshot.seed)) {
      this.seed = snapshot.seed >>> 0;
      this.rng = mulberry32(this.seed);
    }
    if (Number.isFinite(snapshot.nextUid) && snapshot.nextUid > NEXT_UID) {
      NEXT_UID = snapshot.nextUid | 0;
    }
    this._data.clear();
    this._claims.clear();
    this._poiJobs.clear();
    this._pending = Array.isArray(snapshot.villagers) ? snapshot.villagers.slice() : [];

    // Villagers already in the world re-adopt their record right away.
    for (let i = 0; i < this._villagers.length; i++) {
      const mob = this._villagers[i];
      if (!mob) continue;
      mob.villagerData = null;
      this.register(mob);
    }
    return true;
  }

  /**
   * Counters for the F3 overlay.
   * @returns {{villagers:number, records:number, claims:number, jobs:number,
   *   trades:number, golems:number, births:number, sessions:number}} Statistics.
   */
  getStats() {
    return {
      villagers: this._villagers.length,
      records: this._data.size,
      claims: this._claims.size,
      jobs: this._poiJobs.size,
      trades: this._trades,
      golems: this._golemCount,
      births: this._births,
      sessions: this._sessions.length,
    };
  }

  /**
   * Release every listener and drop all state.
   * @returns {void}
   */
  dispose() {
    this.detach();
    for (let i = this._sessions.length - 1; i >= 0; i--) this._sessions[i].open = false;
    this._sessions.length = 0;
    this._data.clear();
    this._claims.clear();
    this._poiJobs.clear();
    this._knownBeds.clear();
    this._pending.length = 0;
    this._villagers.length = 0;
    this._golems.length = 0;
    this._golemCooldown.clear();
    this.removeAllListeners();
  }
}

export default VillagerManager;
