/**
 * @file game/enchanting.js — VOXELIA enchanting table, anvil and the
 * enchantment rules the rest of the game reads.
 *
 * ============================================================================
 * WHAT LIVES HERE
 * ============================================================================
 * 1. **The registry** — {@link ENCHANTMENT_DEFS}: every enchantment with its
 *    maximum level, selection weight, applicable item types, per-level cost
 *    window and conflicts.
 * 2. **The table** — {@link EnchantingTable}: bookshelf detection over the
 *    5x5 ring with the vanilla gap rule (capped at 15), three offers rolled
 *    deterministically from a per-table seed that re-rolls whenever the item
 *    on the table changes, and lapis + experience costs.
 * 3. **The anvil** — {@link Anvil}: combining two items, applying enchanted
 *    books, renaming, repairing with materials and the doubling prior-work
 *    penalty.
 * 4. **The effect helpers** — `damageBonus`, `protectionFactor`,
 *    `efficiencyLevel`, `fortuneLevel`, `silkTouch`, `unbreakingRoll` and
 *    friends, which `game/combat.js`, `game/items.js`, `game/interaction.js`
 *    and `game/player.js` call so enchantments actually do something.
 *
 * ============================================================================
 * DEPENDENCY DIRECTION
 * ============================================================================
 * This module deliberately does **not** import `game/combat.js`: combat is the
 * consumer of the helpers below, and a two-way import would be a cycle. The
 * damage-source flags {@link protectionFactor} needs are therefore mirrored in
 * {@link SOURCE_FLAGS}, keyed by exactly the `DAMAGE.*` ids `combat.js`
 * exports. The experience curve is likewise re-derived here
 * ({@link totalExperienceForLevel}) rather than imported.
 *
 * ============================================================================
 * PRIOR WORK
 * ============================================================================
 * {@link ItemStack} metadata has four fields and none of them is a free slot,
 * so the anvil's prior-work counter is stored as a lore line
 * (`"Reparaturkosten: 3"`). That line is legitimate, player-visible German
 * text — vanilla shows the very same number — and it survives `clone()`,
 * `serialize()` and `metaEquals()` untouched.
 *
 * @module game/enchanting
 */

import { EventBus, TimeBudget } from '../core/util.js';
import { clamp, mulberry32 } from '../core/math.js';
import {
  I, getItem, itemDisplay, itemDurability, toolType, armorSlot, ARMOR_SLOT,
} from './items.js';
import { ItemStack, Inventory } from './inventory.js';
import { B, isOpaque } from '../world/blocks.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Highest number of bookshelves an enchanting table counts. @type {number} */
export const MAX_BOOKSHELVES = 15;

/** Number of offers an enchanting table shows. @type {number} */
export const OFFER_COUNT = 3;

/** Lapis lazuli the top/middle/bottom offer costs. @type {readonly number[]} */
export const OFFER_LAPIS = Object.freeze([1, 2, 3]);

/** Experience levels an anvil refuses to charge (vanilla's "Too Expensive!"). @type {number} */
export const ANVIL_LEVEL_LIMIT = 40;

/** Fraction of maximum durability one repair material restores. @type {number} */
export const REPAIR_FRACTION = 0.25;

/** Fraction of maximum durability the two-item anvil repair adds on top. @type {number} */
export const COMBINE_REPAIR_BONUS = 0.12;

/** Highest number of repair materials one anvil use may consume. @type {number} */
export const MAX_REPAIR_MATERIALS = 4;

/** Chance an anvil is damaged by one use. @type {number} */
export const ANVIL_BREAK_CHANCE = 0.12;

/** Cap on the summed enchantment protection factor. @type {number} */
export const EPF_CAP = 25;

/** Save-format version written by {@link EnchantingManager#serialize}. @type {number} */
export const ENCHANTING_SAVE_VERSION = 1;

/** Milliseconds of a tick {@link EnchantingManager} may spend rescanning. @type {number} */
export const DEFAULT_BUDGET_MS = 0.8;

/** German label of the lore line that carries the prior-work counter. @type {string} */
export const PRIOR_WORK_LABEL = 'Reparaturkosten';

/** Matches the prior-work lore line. @type {RegExp} */
const PRIOR_WORK_RE = /^Reparaturkosten:\s*(\d+)$/;

/* ========================================================================== */
/* Diagnostics                                                                */
/* ========================================================================== */

/** Keys of problems already reported. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a problem exactly once per key — enchanting runs inside the game tick.
 * @param {string} key de-duplication key
 * @param {string} message human readable message
 * @param {*} [err] the original error
 * @returns {void}
 */
function warnOnce(key, message, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err !== undefined) console.warn(`[VOXELIA] enchanting: ${message}`, err);
  else console.warn(`[VOXELIA] enchanting: ${message}`);
}

/**
 * Coerce anything into a finite number.
 * @param {*} v candidate
 * @param {number} fallback value used when `v` is not finite
 * @returns {number} a finite number
 */
function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/* ========================================================================== */
/* Experience curve (mirrored, see the file header)                           */
/* ========================================================================== */

/**
 * Experience points needed to advance **from** `level` to `level + 1`.
 * @param {number} level current level
 * @returns {number} points needed for the next level
 */
export function experienceForNextLevel(level) {
  const l = Math.max(0, Math.floor(num(level, 0)));
  if (l <= 15) return 2 * l + 7;
  if (l <= 30) return 5 * l - 38;
  return 9 * l - 158;
}

/**
 * Total experience accumulated by the time a level is reached.
 * @param {number} level the level
 * @returns {number} total points
 */
export function totalExperienceForLevel(level) {
  const l = Math.max(0, Math.floor(num(level, 0)));
  if (l <= 16) return l * l + 6 * l;
  if (l <= 31) return 2.5 * l * l - 40.5 * l + 360;
  return 4.5 * l * l - 162.5 * l + 2220;
}

/**
 * Take experience levels off a player, keeping `xp`, `xpLevel` and
 * `xpProgress` consistent. Creative mode always succeeds and pays nothing.
 *
 * @param {?Object} player the player (`game/player.js`)
 * @param {number} levels levels to spend
 * @returns {boolean} `true` when the player could pay
 */
export function spendLevels(player, levels) {
  if (player === null || player === undefined) return false;
  const cost = Math.max(0, Math.round(num(levels, 0)));
  if (cost === 0) return true;
  if (player.gameMode === 'creative') return true;
  const have = Math.max(0, Math.floor(num(player.xpLevel, 0)));
  if (have < cost) return false;
  const left = have - cost;
  const progress = clamp(num(player.xpProgress, 0), 0, 0.999);
  player.xpLevel = left;
  player.xpProgress = progress;
  player.xp = Math.round(totalExperienceForLevel(left) + progress * experienceForNextLevel(left));
  return true;
}

/* ========================================================================== */
/* Item classification                                                        */
/* ========================================================================== */

/**
 * Item classes an enchantment can target.
 * @type {Readonly<Object<string, string>>}
 */
export const TARGET = Object.freeze({
  ARMOR: 'armor',
  HELMET: 'helmet',
  CHESTPLATE: 'chestplate',
  LEGGINGS: 'leggings',
  BOOTS: 'boots',
  SWORD: 'sword',
  AXE: 'axe',
  DIGGER: 'digger',
  SHEARS: 'shears',
  BOW: 'bow',
  CROSSBOW: 'crossbow',
  FISHING_ROD: 'fishing_rod',
  BREAKABLE: 'breakable',
});

/** Tool classes counted as "diggers" for Efficiency/Fortune/Silk Touch. @type {ReadonlySet<string>} */
const DIGGER_TOOLS = new Set(['pickaxe', 'axe', 'shovel', 'hoe']);

/**
 * Does an item belong to a target class?
 * @param {string} target a {@link TARGET} value
 * @param {number} itemId item id
 * @returns {boolean} `true` when the enchantment may go on this item
 */
export function matchesTarget(target, itemId) {
  const id = itemId | 0;
  if (id <= 0) return false;
  const slot = armorSlot(id);
  const tool = toolType(id);
  const name = getItem(id).name;
  switch (target) {
    case TARGET.ARMOR: return slot !== ARMOR_SLOT.NONE;
    case TARGET.HELMET: return slot === ARMOR_SLOT.HEAD;
    case TARGET.CHESTPLATE: return slot === ARMOR_SLOT.CHEST;
    case TARGET.LEGGINGS: return slot === ARMOR_SLOT.LEGS;
    case TARGET.BOOTS: return slot === ARMOR_SLOT.FEET;
    case TARGET.SWORD: return tool === 'sword';
    case TARGET.AXE: return tool === 'axe';
    case TARGET.DIGGER: return tool !== null && DIGGER_TOOLS.has(tool);
    case TARGET.SHEARS: return tool === 'shears';
    case TARGET.BOW: return name === 'bow';
    case TARGET.CROSSBOW: return name === 'crossbow';
    case TARGET.FISHING_ROD: return name === 'fishing_rod';
    case TARGET.BREAKABLE: return itemDurability(id) > 0;
    default: return false;
  }
}

/** Enchantability of tool and weapon materials. @type {Readonly<Object<string, number>>} */
const TOOL_ENCHANTABILITY = Object.freeze({
  wooden: 15, stone: 5, iron: 14, golden: 22, diamond: 10, netherite: 15,
});

/** Enchantability of armour materials. @type {Readonly<Object<string, number>>} */
const ARMOR_ENCHANTABILITY = Object.freeze({
  leather: 15, chainmail: 12, iron: 9, golden: 25, diamond: 10, netherite: 15,
});

/** Enchantability of the items that are not made of a tiered material. @type {Readonly<Object<string, number>>} */
const SPECIAL_ENCHANTABILITY = Object.freeze({
  bow: 1, crossbow: 1, fishing_rod: 1, shears: 5, book: 1, enchanted_book: 1,
});

/**
 * How readily an item takes enchantments — the vanilla "enchantability" that
 * widens the random window in {@link rollEnchantments}.
 * @param {number} itemId item id
 * @returns {number} enchantability (>= 1)
 */
export function enchantability(itemId) {
  const def = getItem(itemId | 0);
  const special = SPECIAL_ENCHANTABILITY[def.name];
  if (special !== undefined) return special;
  const material = def.name.indexOf('_') > 0 ? def.name.slice(0, def.name.indexOf('_')) : def.name;
  const table = armorSlot(def.id) === ARMOR_SLOT.NONE ? TOOL_ENCHANTABILITY : ARMOR_ENCHANTABILITY;
  const value = table[material];
  return value === undefined ? 1 : value;
}

/**
 * Can an item receive enchantments at all?
 * @param {number} itemId item id
 * @returns {boolean} `true` for tools, weapons, armour and books
 */
export function isEnchantable(itemId) {
  const id = itemId | 0;
  if (id === I.ENCHANTED_BOOK || id === I.BOOK) return true;
  return getItem(id).enchantable === true;
}

/* ========================================================================== */
/* Registry                                                                   */
/* ========================================================================== */

/**
 * One enchantment.
 *
 * @typedef {Object} EnchantmentDef
 * @property {string} id snake_case identifier, e.g. `'fire_protection'`
 * @property {string} display German display name
 * @property {number} maxLevel highest level the enchantment reaches
 * @property {number} weight selection weight (10 common … 1 very rare)
 * @property {string} rarity `'common'|'uncommon'|'rare'|'very_rare'`
 * @property {readonly string[]} targets {@link TARGET} values it applies to
 * @property {readonly string[]} conflicts ids it may never share an item with
 * @property {boolean} treasure only obtainable from loot/trades, never rolled
 * @property {(level:number) => number} minCost lowest modified level the
 *   enchantment can be rolled at
 * @property {(level:number) => number} maxCost highest modified level
 * @property {number} anvilItemCost cost multiplier when merged from an item
 * @property {number} anvilBookCost cost multiplier when merged from a book
 */

/** Dense registry of every enchantment. @type {EnchantmentDef[]} */
const ENCH_DEFS = [];

/** Enchantment id -> definition. @type {Map<string, EnchantmentDef>} */
const ENCH_BY_ID = new Map();

/** Anvil cost multipliers per rarity: `[fromItem, fromBook]`. @type {Readonly<Object<string, number[]>>} */
const ANVIL_COST = Object.freeze({
  common: [1, 1], uncommon: [2, 1], rare: [4, 2], very_rare: [8, 4],
});

/**
 * Rarity name for a selection weight.
 * @param {number} weight the weight
 * @returns {string} a key of {@link ANVIL_COST}
 */
function rarityOf(weight) {
  if (weight >= 10) return 'common';
  if (weight >= 5) return 'uncommon';
  if (weight >= 2) return 'rare';
  return 'very_rare';
}

/**
 * Build a linear cost window: `first + (level - 1) * step`, `+ span` wide.
 * @param {number} first minimum cost of level 1
 * @param {number} step increase per level
 * @param {number} span width of the window
 * @returns {{min:(l:number)=>number, max:(l:number)=>number}} the two curves
 */
function window(first, step, span) {
  const min = (l) => first + (Math.max(1, l) - 1) * step;
  return { min, max: (l) => min(l) + span };
}

/**
 * Register one enchantment.
 * @param {string} id snake_case identifier
 * @param {string} display German display name
 * @param {number} maxLevel highest level
 * @param {number} weight selection weight
 * @param {readonly string[]} targets applicable {@link TARGET} values
 * @param {{min:(l:number)=>number, max:(l:number)=>number}} cost the cost window
 * @param {Object} [opts] extras
 * @param {readonly string[]} [opts.conflicts] extra conflicting ids
 * @param {boolean} [opts.treasure] never rolled at a table
 * @returns {EnchantmentDef} the frozen definition
 */
function defineEnchantment(id, display, maxLevel, weight, targets, cost, opts = {}) {
  const rarity = rarityOf(weight);
  const def = Object.freeze({
    id,
    display,
    maxLevel,
    weight,
    rarity,
    targets: Object.freeze(targets.slice()),
    conflicts: Object.freeze((opts.conflicts ?? []).slice()),
    treasure: opts.treasure === true,
    minCost: cost.min,
    maxCost: cost.max,
    anvilItemCost: ANVIL_COST[rarity][0],
    anvilBookCost: ANVIL_COST[rarity][1],
  });
  ENCH_DEFS.push(def);
  ENCH_BY_ID.set(id, def);
  return def;
}

/* -- armour ---------------------------------------------------------------- */

defineEnchantment('protection', 'Schutz', 4, 10, [TARGET.ARMOR], window(1, 11, 11));
defineEnchantment('fire_protection', 'Feuerschutz', 4, 5, [TARGET.ARMOR], window(10, 8, 8));
defineEnchantment('feather_falling', 'Federfall', 4, 5, [TARGET.BOOTS], window(5, 6, 6));
defineEnchantment('blast_protection', 'Explosionsschutz', 4, 2, [TARGET.ARMOR], window(5, 8, 8));
defineEnchantment('projectile_protection', 'Geschossschutz', 4, 5, [TARGET.ARMOR], window(3, 6, 6));
defineEnchantment('respiration', 'Atmung', 3, 2, [TARGET.HELMET], window(10, 10, 30));
defineEnchantment('aqua_affinity', 'Wasseraffinität', 1, 2, [TARGET.HELMET], window(1, 1, 40));
defineEnchantment('thorns', 'Dornen', 3, 1, [TARGET.ARMOR], window(10, 20, 50));
defineEnchantment('depth_strider', 'Tiefenläufer', 3, 2, [TARGET.BOOTS], window(10, 10, 15));

/* -- weapons --------------------------------------------------------------- */

defineEnchantment('sharpness', 'Schärfe', 5, 10, [TARGET.SWORD, TARGET.AXE], window(1, 11, 20));
defineEnchantment('smite', 'Bann', 5, 5, [TARGET.SWORD, TARGET.AXE], window(5, 8, 20));
defineEnchantment('bane_of_arthropods', 'Nemesis der Gliederfüßer', 5, 5,
  [TARGET.SWORD, TARGET.AXE], window(5, 8, 20));
defineEnchantment('knockback', 'Rückstoß', 2, 5, [TARGET.SWORD], window(5, 20, 50));
defineEnchantment('fire_aspect', 'Verbrennung', 2, 2, [TARGET.SWORD], window(10, 20, 50));
defineEnchantment('looting', 'Plünderung', 3, 2, [TARGET.SWORD], window(15, 9, 50));
defineEnchantment('sweeping', 'Schwungkraft', 3, 2, [TARGET.SWORD], window(5, 9, 15));

/* -- tools ----------------------------------------------------------------- */

defineEnchantment('efficiency', 'Effizienz', 5, 10, [TARGET.DIGGER, TARGET.SHEARS], window(1, 10, 50));
defineEnchantment('silk_touch', 'Behutsamkeit', 1, 1, [TARGET.DIGGER, TARGET.SHEARS], window(15, 1, 50));
defineEnchantment('unbreaking', 'Haltbarkeit', 3, 5, [TARGET.BREAKABLE], window(5, 8, 50));
defineEnchantment('fortune', 'Glück', 3, 2, [TARGET.DIGGER], window(15, 9, 50));

/* -- ranged ---------------------------------------------------------------- */

defineEnchantment('power', 'Stärke', 5, 10, [TARGET.BOW], window(1, 10, 15));
defineEnchantment('punch', 'Schlag', 2, 2, [TARGET.BOW], window(12, 20, 25));
defineEnchantment('flame', 'Flamme', 1, 2, [TARGET.BOW], window(20, 1, 30));
defineEnchantment('infinity', 'Unendlichkeit', 1, 1, [TARGET.BOW], window(20, 1, 30));

/* -- fishing --------------------------------------------------------------- */

defineEnchantment('luck_of_the_sea', 'Glück des Meeres', 3, 2, [TARGET.FISHING_ROD], window(15, 9, 50));
defineEnchantment('lure', 'Köder', 3, 2, [TARGET.FISHING_ROD], window(15, 9, 50));

/* -- treasure -------------------------------------------------------------- */

defineEnchantment('mending', 'Reparatur', 1, 2, [TARGET.BREAKABLE], window(25, 1, 50),
  { treasure: true });

/* -- conflict groups ------------------------------------------------------- */

/**
 * Enchantments that are mutually exclusive as a set.
 * @type {readonly (readonly string[])[]}
 */
export const CONFLICT_GROUPS = Object.freeze([
  Object.freeze(['sharpness', 'smite', 'bane_of_arthropods']),
  Object.freeze(['silk_touch', 'fortune']),
  Object.freeze(['infinity', 'mending']),
  Object.freeze(['protection', 'fire_protection', 'blast_protection', 'projectile_protection']),
]);

/** Enchantment id -> every id it conflicts with. @type {Map<string, Set<string>>} */
const CONFLICT_MAP = new Map();

for (let g = 0; g < CONFLICT_GROUPS.length; g++) {
  const group = CONFLICT_GROUPS[g];
  for (let i = 0; i < group.length; i++) {
    let set = CONFLICT_MAP.get(group[i]);
    if (set === undefined) {
      set = new Set();
      CONFLICT_MAP.set(group[i], set);
    }
    for (let j = 0; j < group.length; j++) if (j !== i) set.add(group[j]);
  }
}
for (let i = 0; i < ENCH_DEFS.length; i++) {
  const def = ENCH_DEFS[i];
  if (def.conflicts.length === 0) continue;
  let set = CONFLICT_MAP.get(def.id);
  if (set === undefined) {
    set = new Set();
    CONFLICT_MAP.set(def.id, set);
  }
  for (let c = 0; c < def.conflicts.length; c++) {
    set.add(def.conflicts[c]);
    let other = CONFLICT_MAP.get(def.conflicts[c]);
    if (other === undefined) {
      other = new Set();
      CONFLICT_MAP.set(def.conflicts[c], other);
    }
    other.add(def.id);
  }
}

/* -- frozen views ---------------------------------------------------------- */

/** Every enchantment definition. @type {readonly EnchantmentDef[]} */
export const ENCHANTMENT_LIST = Object.freeze(ENCH_DEFS.slice());

/** Enchantment id -> {@link EnchantmentDef}. @type {ReadonlyMap<string, EnchantmentDef>} */
export const ENCHANTMENT_DEFS = ENCH_BY_ID;

/**
 * SCREAMING_SNAKE_CASE enchantment id constants.
 * @type {Readonly<Object<string, string>>}
 */
export const ENCHANT = Object.freeze((() => {
  /** @type {Object<string, string>} */
  const out = Object.create(null);
  for (let i = 0; i < ENCH_DEFS.length; i++) out[ENCH_DEFS[i].id.toUpperCase()] = ENCH_DEFS[i].id;
  return out;
})());

/** Number of registered enchantments. @type {number} */
export const ENCHANTMENT_COUNT = ENCH_DEFS.length;

/**
 * Definition of an enchantment id.
 * @param {string} id enchantment id
 * @returns {?EnchantmentDef} the definition, or `null`
 */
export function getEnchantment(id) {
  const def = ENCH_BY_ID.get(id);
  return def === undefined ? null : def;
}

/**
 * German display name of an enchantment (the raw id when unknown).
 * @param {string} id enchantment id
 * @returns {string} the display name
 */
export function enchantmentDisplay(id) {
  const def = ENCH_BY_ID.get(id);
  return def === undefined ? String(id) : def.display;
}

/**
 * Highest level an enchantment reaches.
 * @param {string} id enchantment id
 * @returns {number} the maximum level, `0` when unknown
 */
export function maxLevel(id) {
  const def = ENCH_BY_ID.get(id);
  return def === undefined ? 0 : def.maxLevel;
}

/**
 * May an enchantment go on an item? Enchanted books accept everything.
 * @param {string} id enchantment id
 * @param {number} itemId item id
 * @returns {boolean} `true` when the pairing is legal
 */
export function canEnchant(id, itemId) {
  const def = ENCH_BY_ID.get(id);
  if (def === undefined) return false;
  const item = itemId | 0;
  if (item === I.ENCHANTED_BOOK || item === I.BOOK) return true;
  for (let i = 0; i < def.targets.length; i++) {
    if (matchesTarget(def.targets[i], item)) return true;
  }
  return false;
}

/**
 * Do two enchantments exclude each other?
 * @param {string} a first enchantment id
 * @param {string} b second enchantment id
 * @returns {boolean} `true` when they may not share an item
 */
export function conflictsWith(a, b) {
  if (a === b) return false;
  const set = CONFLICT_MAP.get(a);
  return set !== undefined && set.has(b);
}

/**
 * The modified-level window an enchantment level can be rolled in.
 * @param {string} id enchantment id
 * @param {number} level the level
 * @returns {?{min:number, max:number}} the window, or `null` when unknown
 */
export function enchantmentLevelCost(id, level) {
  const def = ENCH_BY_ID.get(id);
  if (def === undefined) return null;
  const l = clamp(Math.round(num(level, 1)), 1, def.maxLevel);
  return { min: def.minCost(l), max: def.maxCost(l) };
}

/**
 * Every enchantment id that could ever go on an item.
 * @param {number} itemId item id
 * @returns {string[]} freshly allocated id list
 */
export function applicableEnchantments(itemId) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < ENCH_DEFS.length; i++) {
    if (canEnchant(ENCH_DEFS[i].id, itemId)) out.push(ENCH_DEFS[i].id);
  }
  return out;
}

/* ========================================================================== */
/* Enchantment level lookup on a stack                                        */
/* ========================================================================== */

/**
 * Level of one enchantment on a stack, without assuming the stack's exact API.
 * @param {*} stack an {@link ItemStack}, or `null`
 * @param {string} id enchantment id
 * @returns {number} the level, `0` when absent
 */
export function enchantLevel(stack, id) {
  if (stack === null || stack === undefined) return 0;
  try {
    if (typeof stack.getEnchantmentLevel === 'function') {
      const level = stack.getEnchantmentLevel(id);
      return Number.isFinite(level) && level > 0 ? level | 0 : 0;
    }
    const list = stack.meta && stack.meta.enchantments;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return Math.max(0, list[i].level | 0);
      }
    }
  } catch (err) {
    warnOnce('level', 'an enchantment lookup failed', err);
  }
  return 0;
}

/**
 * Enchantment list of a stack (never `null`).
 * @param {*} stack an {@link ItemStack}, or `null`
 * @returns {readonly {id:string, level:number}[]} the list
 */
function enchantmentsOf(stack) {
  if (stack === null || stack === undefined) return EMPTY_LIST;
  const meta = stack.meta;
  if (meta === null || meta === undefined || !Array.isArray(meta.enchantments)) return EMPTY_LIST;
  return meta.enchantments;
}

/** Shared empty enchantment list. @type {readonly {id:string, level:number}[]} */
const EMPTY_LIST = Object.freeze([]);

/* ========================================================================== */
/* Gameplay helpers — what combat.js / items.js / the player call             */
/* ========================================================================== */

/**
 * Extra melee damage the held weapon's enchantments add against one target.
 *
 * Sharpness is flat, Smite and Bane of Arthropods only bite their own family.
 * Undead/arthropod is read from `target.def`, exactly how `game/mobs.js`
 * flags it.
 *
 * @param {*} stack the held stack
 * @param {?Object} [target] the victim
 * @returns {number} half-hearts to add to the hit
 */
export function damageBonus(stack, target = null) {
  let bonus = 0;
  const sharpness = enchantLevel(stack, ENCHANT.SHARPNESS);
  if (sharpness > 0) bonus += 1 + 0.5 * (sharpness - 1);

  const def = target !== null && target !== undefined ? target.def : null;
  if (def !== null && def !== undefined) {
    if (def.undead === true) bonus += 2.5 * enchantLevel(stack, ENCHANT.SMITE);
    if (def.arthropod === true) bonus += 2.5 * enchantLevel(stack, ENCHANT.BANE_OF_ARTHROPODS);
  }
  return bonus;
}

/**
 * Damage-source flags mirrored from `game/combat.js#DAMAGE_SOURCES`. Keyed by
 * the very same ids so `protectionFactor(armour, 'explosion')` just works.
 * @type {Readonly<Object<string, {fire:boolean, blast:boolean, projectile:boolean, fall:boolean, bypass:boolean}>>}
 */
export const SOURCE_FLAGS = Object.freeze({
  fall: Object.freeze({ fire: false, blast: false, projectile: false, fall: true, bypass: false }),
  drown: Object.freeze({ fire: false, blast: false, projectile: false, fall: false, bypass: false }),
  lava: Object.freeze({ fire: true, blast: false, projectile: false, fall: false, bypass: false }),
  fire: Object.freeze({ fire: true, blast: false, projectile: false, fall: false, bypass: false }),
  void: Object.freeze({ fire: false, blast: false, projectile: false, fall: false, bypass: true }),
  mob: Object.freeze({ fire: false, blast: false, projectile: false, fall: false, bypass: false }),
  player: Object.freeze({ fire: false, blast: false, projectile: false, fall: false, bypass: false }),
  explosion: Object.freeze({ fire: false, blast: true, projectile: false, fall: false, bypass: false }),
  starve: Object.freeze({ fire: false, blast: false, projectile: false, fall: false, bypass: true }),
  suffocate: Object.freeze({ fire: false, blast: false, projectile: false, fall: false, bypass: false }),
  cactus: Object.freeze({ fire: false, blast: false, projectile: false, fall: false, bypass: false }),
  arrow: Object.freeze({ fire: false, blast: false, projectile: true, fall: false, bypass: false }),
  magic: Object.freeze({ fire: false, blast: false, projectile: false, fall: false, bypass: true }),
  generic: Object.freeze({ fire: false, blast: false, projectile: false, fall: false, bypass: false }),
});

/**
 * Resolve a damage source into its flags. Accepts the string ids of
 * `game/combat.js#DAMAGE` as well as a whole `DamageSourceDef`.
 * @param {string|Object} source a damage-source id or record
 * @returns {{fire:boolean, blast:boolean, projectile:boolean, fall:boolean, bypass:boolean}} the flags
 */
function sourceFlags(source) {
  if (source !== null && typeof source === 'object') {
    return {
      fire: source.fire === true,
      blast: source.blast === true,
      projectile: source.projectile === true,
      fall: source.fall === true,
      bypass: source.bypassEnchantments === true,
    };
  }
  const flags = SOURCE_FLAGS[String(source)];
  return flags === undefined ? SOURCE_FLAGS.generic : flags;
}

/**
 * Iterate the four worn armour pieces of whatever the caller hands over: an
 * array of stacks, a `PlayerInventory` (via its `armor(i)` accessor), or a
 * single stack.
 * @param {*} armour the armour source
 * @param {(stack:*) => void} visit callback per non-empty piece
 * @returns {void}
 */
function forEachArmorPiece(armour, visit) {
  if (armour === null || armour === undefined) return;
  if (Array.isArray(armour)) {
    for (let i = 0; i < armour.length; i++) if (armour[i]) visit(armour[i]);
    return;
  }
  if (typeof armour.armor === 'function') {
    for (let i = 0; i < 4; i++) {
      let piece = null;
      try {
        piece = armour.armor(i);
      } catch (err) {
        warnOnce('armor:slot', 'an armour slot could not be read', err);
      }
      if (piece) visit(piece);
    }
    return;
  }
  if (typeof armour.itemId === 'number') visit(armour);
}

/**
 * Summed enchantment protection factor (EPF) of a set of armour against one
 * damage source. `game/combat.js` turns this into `1 - epf * 0.04`.
 *
 * @param {*} armour array of armour stacks, a `PlayerInventory`, or one stack
 * @param {string|Object} source a `DAMAGE.*` id or a `DamageSourceDef`
 * @returns {number} the EPF, capped at {@link EPF_CAP}
 */
export function protectionFactor(armour, source) {
  const flags = sourceFlags(source);
  if (flags.bypass) return 0;
  let epf = 0;
  forEachArmorPiece(armour, (piece) => {
    epf += enchantLevel(piece, ENCHANT.PROTECTION);
    if (flags.fire) epf += 2 * enchantLevel(piece, ENCHANT.FIRE_PROTECTION);
    if (flags.blast) epf += 2 * enchantLevel(piece, ENCHANT.BLAST_PROTECTION);
    if (flags.projectile) epf += 2 * enchantLevel(piece, ENCHANT.PROJECTILE_PROTECTION);
    if (flags.fall) epf += 3 * enchantLevel(piece, ENCHANT.FEATHER_FALLING);
  });
  return Math.min(EPF_CAP, epf);
}

/**
 * Efficiency level of a stack — `world/blocks.js#breakTime` takes this
 * directly as its `efficiency` argument.
 * @param {*} stack the held stack
 * @returns {number} the level, `0` when absent
 */
export function efficiencyLevel(stack) {
  return enchantLevel(stack, ENCHANT.EFFICIENCY);
}

/**
 * Fortune level of a stack — `world/blocks.js#blockDrops` takes this directly.
 * @param {*} stack the held stack
 * @returns {number} the level, `0` when absent
 */
export function fortuneLevel(stack) {
  return enchantLevel(stack, ENCHANT.FORTUNE);
}

/**
 * Does the held tool have Silk Touch?
 * @param {*} stack the held stack
 * @returns {boolean} `true` when the block should drop itself
 */
export function silkTouch(stack) {
  return enchantLevel(stack, ENCHANT.SILK_TOUCH) > 0;
}

/**
 * Looting level of a stack — extra mob drops.
 * @param {*} stack the held stack
 * @returns {number} the level, `0` when absent
 */
export function lootingLevel(stack) {
  return enchantLevel(stack, ENCHANT.LOOTING);
}

/**
 * Knockback level of a stack.
 * @param {*} stack the held stack
 * @returns {number} the level, `0` when absent
 */
export function knockbackLevel(stack) {
  return enchantLevel(stack, ENCHANT.KNOCKBACK);
}

/**
 * Seconds of burning one hit with this weapon sets (Fire Aspect).
 * @param {*} stack the held stack
 * @param {number} [secondsPerLevel] burn seconds per level
 * @returns {number} burn duration in seconds, `0` when absent
 */
export function fireAspectSeconds(stack, secondsPerLevel = 4) {
  return enchantLevel(stack, ENCHANT.FIRE_ASPECT) * secondsPerLevel;
}

/**
 * Fraction of a sweep hit that is passed on to neighbouring mobs.
 * @param {*} stack the held stack
 * @returns {number} `0..1`
 */
export function sweepingFactor(stack) {
  const level = enchantLevel(stack, ENCHANT.SWEEPING);
  return level <= 0 ? 0 : level / (level + 1);
}

/**
 * Damage Thorns reflects back at an attacker.
 * @param {*} armour armour stacks, a `PlayerInventory`, or one stack
 * @param {() => number} [rng] random source returning `0..1`
 * @returns {number} half-hearts to reflect, `0` when nothing triggers
 */
export function thornsDamage(armour, rng = Math.random) {
  const rand = typeof rng === 'function' ? rng : Math.random;
  let best = 0;
  forEachArmorPiece(armour, (piece) => {
    const level = enchantLevel(piece, ENCHANT.THORNS);
    if (level > best) best = level;
  });
  if (best <= 0) return 0;
  if (rand() >= best * 0.15) return 0;
  return best > 10 ? best - 10 : 1 + Math.floor(rand() * 4);
}

/**
 * Extra air ticks Respiration grants — `combat.updateAir()` divides the drain
 * by `level + 1`.
 * @param {*} armour armour stacks or a `PlayerInventory`
 * @returns {number} the Respiration level of the helmet
 */
export function respirationLevel(armour) {
  let best = 0;
  forEachArmorPiece(armour, (piece) => {
    const level = enchantLevel(piece, ENCHANT.RESPIRATION);
    if (level > best) best = level;
  });
  return best;
}

/**
 * Does the helmet remove the underwater mining penalty?
 * @param {*} armour armour stacks or a `PlayerInventory`
 * @returns {boolean} `true` when Aqua Affinity is worn
 */
export function aquaAffinity(armour) {
  let found = false;
  forEachArmorPiece(armour, (piece) => {
    if (!found && enchantLevel(piece, ENCHANT.AQUA_AFFINITY) > 0) found = true;
  });
  return found;
}

/**
 * Underwater walk-speed multiplier from Depth Strider.
 * @param {*} armour armour stacks or a `PlayerInventory`
 * @returns {number} multiplier `1..2`
 */
export function depthStriderFactor(armour) {
  let best = 0;
  forEachArmorPiece(armour, (piece) => {
    const level = enchantLevel(piece, ENCHANT.DEPTH_STRIDER);
    if (level > best) best = level;
  });
  return 1 + Math.min(3, best) / 3;
}

/**
 * Fall-damage multiplier from Feather Falling.
 * @param {*} armour armour stacks or a `PlayerInventory`
 * @returns {number} multiplier `0..1`
 */
export function featherFallingFactor(armour) {
  const epf = protectionFactor(armour, 'fall');
  return Math.max(0, 1 - epf * 0.04);
}

/**
 * Extra arrow damage from Power.
 * @param {*} stack the bow
 * @returns {number} multiplier on the arrow's base damage
 */
export function powerFactor(stack) {
  const level = enchantLevel(stack, ENCHANT.POWER);
  return level <= 0 ? 1 : 1 + 0.25 * (level + 1);
}

/**
 * Extra arrow knockback from Punch.
 * @param {*} stack the bow
 * @returns {number} knockback levels, `0` when absent
 */
export function punchLevel(stack) {
  return enchantLevel(stack, ENCHANT.PUNCH);
}

/**
 * Does the bow set its arrows on fire?
 * @param {*} stack the bow
 * @returns {boolean} `true` with Flame
 */
export function flameArrow(stack) {
  return enchantLevel(stack, ENCHANT.FLAME) > 0;
}

/**
 * Does the bow keep its arrows?
 * @param {*} stack the bow
 * @returns {boolean} `true` with Infinity
 */
export function infinityArrow(stack) {
  return enchantLevel(stack, ENCHANT.INFINITY) > 0;
}

/**
 * Luck of the Sea level of a fishing rod.
 * @param {*} stack the rod
 * @returns {number} the level, `0` when absent
 */
export function luckOfTheSea(stack) {
  return enchantLevel(stack, ENCHANT.LUCK_OF_THE_SEA);
}

/**
 * Seconds Lure takes off the fishing wait.
 * @param {*} stack the rod
 * @returns {number} seconds saved
 */
export function lureSeconds(stack) {
  return enchantLevel(stack, ENCHANT.LURE) * 5;
}

/**
 * Does this stack repair itself from collected experience?
 * @param {*} stack any stack
 * @returns {boolean} `true` with Mending
 */
export function hasMending(stack) {
  return enchantLevel(stack, ENCHANT.MENDING) > 0;
}

/**
 * Spend experience on a Mending item.
 * @param {*} stack the item to repair
 * @param {number} xp experience points collected
 * @returns {{repaired:number, spent:number}} durability restored and XP used
 */
export function mendingRepair(stack, xp) {
  const points = Math.max(0, Math.floor(num(xp, 0)));
  if (points === 0 || !hasMending(stack)) return { repaired: 0, spent: 0 };
  const max = itemDurability(stack.itemId);
  if (max <= 0) return { repaired: 0, spent: 0 };
  const missing = max - stack.durability;
  if (missing <= 0) return { repaired: 0, spent: 0 };
  // Vanilla: two durability points per experience point.
  const want = Math.min(missing, points * 2);
  const spent = Math.ceil(want / 2);
  try {
    stack.repair(want);
  } catch (err) {
    warnOnce('mending', 'a Mending repair failed', err);
    return { repaired: 0, spent: 0 };
  }
  return { repaired: want, spent };
}

/**
 * Should this use actually consume a durability point? Unbreaking makes the
 * answer `false` some of the time; armour additionally only rolls 60 % of the
 * time, exactly like vanilla.
 *
 * @param {*} stack the item being used
 * @param {() => number} [rng] random source returning `0..1`
 * @returns {boolean} `true` when a durability point should be spent
 */
export function unbreakingRoll(stack, rng = Math.random) {
  const level = enchantLevel(stack, ENCHANT.UNBREAKING);
  if (level <= 0) return true;
  const rand = typeof rng === 'function' ? rng : Math.random;
  if (stack && armorSlot(stack.itemId) !== ARMOR_SLOT.NONE && rand() >= 0.6) return true;
  return rand() < 1 / (level + 1);
}

/* ========================================================================== */
/* Prior work (anvil penalty)                                                 */
/* ========================================================================== */

/**
 * How often this item has been through an anvil.
 * @param {*} stack any stack
 * @returns {number} the counter, `0` for a fresh item
 */
export function priorWork(stack) {
  if (stack === null || stack === undefined) return 0;
  const meta = stack.meta;
  if (meta === null || meta === undefined || !Array.isArray(meta.lore)) return 0;
  for (let i = 0; i < meta.lore.length; i++) {
    const match = PRIOR_WORK_RE.exec(meta.lore[i]);
    if (match !== null) return Math.max(0, parseInt(match[1], 10) | 0);
  }
  return 0;
}

/**
 * Experience levels the prior-work counter adds to an anvil use.
 * @param {*} stack any stack
 * @returns {number} `2^priorWork - 1`
 */
export function priorWorkPenalty(stack) {
  const n = Math.min(31, priorWork(stack));
  return (1 << n) - 1;
}

/**
 * Write the prior-work counter onto a stack, replacing any previous line and
 * leaving every other lore line alone.
 * @param {*} stack the stack to stamp
 * @param {number} value the new counter
 * @returns {*} `stack`, for chaining
 */
export function setPriorWork(stack, value) {
  if (stack === null || stack === undefined) return stack;
  const n = Math.max(0, Math.min(31, Math.round(num(value, 0))));
  let meta;
  try {
    meta = stack.ensureMeta();
  } catch (err) {
    warnOnce('prior:meta', 'the prior-work counter could not be written', err);
    return stack;
  }
  if (!Array.isArray(meta.lore)) meta.lore = [];
  const kept = [];
  for (let i = 0; i < meta.lore.length; i++) {
    if (PRIOR_WORK_RE.exec(meta.lore[i]) === null) kept.push(meta.lore[i]);
  }
  if (n > 0) kept.push(`${PRIOR_WORK_LABEL}: ${n}`);
  meta.lore = kept;
  return stack;
}

/* ========================================================================== */
/* Bookshelf detection                                                        */
/* ========================================================================== */

/** Block id of a bookshelf, `-1` when the build has none. @type {number} */
const BOOKSHELF_ID = typeof B.BOOKSHELF === 'number' ? B.BOOKSHELF : -1;

/**
 * Is the block at this position see-through enough for a bookshelf behind it
 * to still count? Vanilla wants air; we accept anything non-opaque, which is
 * the same rule the light engine uses and lets glass panes through.
 * @param {Object} world the world
 * @param {number} x block X
 * @param {number} y block Y
 * @param {number} z block Z
 * @returns {boolean} `true` when the gap is clear
 */
function isGapClear(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  return id === 0 || !isOpaque(id);
}

/**
 * Count the bookshelves an enchanting table can see.
 *
 * The vanilla rule: for each of the eight horizontal directions, the two
 * blocks directly next to the table (at the table's level and one above) must
 * be clear; only then do the bookshelves two blocks out in that direction
 * count. Diagonals additionally pick up the two "shoulder" positions. The
 * result is capped at {@link MAX_BOOKSHELVES}.
 *
 * @param {?Object} world the chunk manager (`world/world.js`)
 * @param {number} x table block X
 * @param {number} y table block Y
 * @param {number} z table block Z
 * @returns {number} `0..15`
 */
export function countBookshelves(world, x, y, z) {
  if (world === null || world === undefined || typeof world.getBlock !== 'function') return 0;
  if (BOOKSHELF_ID < 0) return 0;
  const bx = x | 0;
  const by = y | 0;
  const bz = z | 0;
  let count = 0;
  try {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        if (!isGapClear(world, bx + dx, by, bz + dz)) continue;
        if (!isGapClear(world, bx + dx, by + 1, bz + dz)) continue;

        if (world.getBlock(bx + dx * 2, by, bz + dz * 2) === BOOKSHELF_ID) count++;
        if (world.getBlock(bx + dx * 2, by + 1, bz + dz * 2) === BOOKSHELF_ID) count++;

        if (dx !== 0 && dz !== 0) {
          if (world.getBlock(bx + dx * 2, by, bz + dz) === BOOKSHELF_ID) count++;
          if (world.getBlock(bx + dx * 2, by + 1, bz + dz) === BOOKSHELF_ID) count++;
          if (world.getBlock(bx + dx, by, bz + dz * 2) === BOOKSHELF_ID) count++;
          if (world.getBlock(bx + dx, by + 1, bz + dz * 2) === BOOKSHELF_ID) count++;
        }
        if (count >= MAX_BOOKSHELVES) return MAX_BOOKSHELVES;
      }
    }
  } catch (err) {
    warnOnce('bookshelf', 'the bookshelf scan failed', err);
    return 0;
  }
  return Math.min(MAX_BOOKSHELVES, count);
}

/* ========================================================================== */
/* Rolling enchantments                                                       */
/* ========================================================================== */

/**
 * Integer in `[0, bound]`, inclusive.
 * @param {() => number} rng random source returning `0..1`
 * @param {number} bound inclusive upper bound
 * @returns {number} the integer
 */
function randInt(rng, bound) {
  if (bound <= 0) return 0;
  return Math.floor(rng() * (bound + 1));
}

/**
 * One candidate the roll may pick.
 * @typedef {{id:string, level:number, weight:number}} EnchantCandidate
 */

/**
 * Every `(enchantment, level)` pair whose cost window contains `power`.
 * @param {number} itemId the item being enchanted
 * @param {number} power the modified enchantment level
 * @param {boolean} allowTreasure include treasure-only enchantments
 * @param {EnchantCandidate[]} out receiver, cleared first
 * @returns {EnchantCandidate[]} `out`
 */
function collectCandidates(itemId, power, allowTreasure, out) {
  out.length = 0;
  const book = itemId === I.ENCHANTED_BOOK || itemId === I.BOOK;
  for (let i = 0; i < ENCH_DEFS.length; i++) {
    const def = ENCH_DEFS[i];
    if (def.treasure && !allowTreasure) continue;
    if (!book && !canEnchant(def.id, itemId)) continue;
    for (let level = def.maxLevel; level >= 1; level--) {
      if (power >= def.minCost(level) && power <= def.maxCost(level)) {
        out.push({ id: def.id, level, weight: def.weight });
        break;
      }
    }
  }
  return out;
}

/**
 * Weighted pick from a candidate list.
 * @param {() => number} rng random source returning `0..1`
 * @param {EnchantCandidate[]} list the candidates
 * @returns {?EnchantCandidate} the pick, or `null` for an empty list
 */
function weightedPick(rng, list) {
  let total = 0;
  for (let i = 0; i < list.length; i++) total += list[i].weight;
  if (total <= 0) return null;
  let roll = rng() * total;
  for (let i = 0; i < list.length; i++) {
    roll -= list[i].weight;
    if (roll <= 0) return list[i];
  }
  return list[list.length - 1];
}

/**
 * Roll the enchantment list one offer grants.
 *
 * This is the vanilla algorithm: the offer level is widened by the item's
 * enchantability and a `±15 %` triangular bonus, every `(enchantment, level)`
 * whose window contains the result becomes a weighted candidate, one is
 * picked, and further compatible ones are chained on with a halving
 * probability.
 *
 * @param {() => number} rng random source returning `0..1`
 * @param {number} level the offer's experience level
 * @param {number} itemId the item being enchanted
 * @param {Object} [opts] extras
 * @param {boolean} [opts.treasure] allow treasure enchantments (books/loot)
 * @returns {{id:string, level:number}[]} the rolled enchantments
 */
export function rollEnchantments(rng, level, itemId, opts = {}) {
  /** @type {{id:string, level:number}[]} */
  const chosen = [];
  const rand = typeof rng === 'function' ? rng : Math.random;
  const item = itemId | 0;
  const ability = enchantability(item);
  if (ability <= 0) return chosen;

  let power = Math.max(1, Math.round(num(level, 1)));
  power += 1 + randInt(rand, ability >> 2) + randInt(rand, ability >> 2);
  const bonus = 1 + (rand() + rand() - 1) * 0.15;
  power = Math.max(1, Math.round(power * bonus));

  /** @type {EnchantCandidate[]} */
  const pool = [];
  collectCandidates(item, power, opts.treasure === true, pool);
  let pick = weightedPick(rand, pool);
  if (pick === null) return chosen;
  chosen.push({ id: pick.id, level: pick.level });

  // Chain further enchantments on with a halving probability.
  for (let guard = 0; guard < 8; guard++) {
    if (rand() * 50 > power) break;
    power = Math.floor(power / 2);
    if (power < 1) break;
    collectCandidates(item, power, opts.treasure === true, pool);
    for (let i = pool.length - 1; i >= 0; i--) {
      let bad = false;
      for (let c = 0; c < chosen.length; c++) {
        if (chosen[c].id === pool[i].id || conflictsWith(chosen[c].id, pool[i].id)) {
          bad = true;
          break;
        }
      }
      if (bad) pool.splice(i, 1);
    }
    pick = weightedPick(rand, pool);
    if (pick === null) break;
    chosen.push({ id: pick.id, level: pick.level });
  }
  return chosen;
}

/**
 * The three offers an enchanting table shows for one item.
 *
 * Deterministic: the same `(seed, bookshelves, itemId)` always yields the same
 * offers, so the preview the player sees is exactly what they get.
 *
 * @param {number} seed the table's 32-bit seed
 * @param {number} bookshelves `0..15`
 * @param {number} itemId the item on the table
 * @returns {{slot:number, level:number, lapis:number, enchantments:{id:string, level:number}[], label:string}[]}
 *   up to three offers; a slot with no possible enchantment is dropped
 */
export function generateOffers(seed, bookshelves, itemId) {
  /** @type {{slot:number, level:number, lapis:number, enchantments:{id:string, level:number}[], label:string}[]} */
  const offers = [];
  const item = itemId | 0;
  if (item <= 0 || !isEnchantable(item)) return offers;

  const shelves = clamp(Math.round(num(bookshelves, 0)), 0, MAX_BOOKSHELVES);
  const base = mulberry32((seed >>> 0) || 1);
  const roll = 1 + randInt(base, 7) + (shelves >> 1) + randInt(base, shelves);

  for (let slot = 0; slot < OFFER_COUNT; slot++) {
    let level;
    if (slot === 0) level = Math.max(Math.floor(roll / 3), 1);
    else if (slot === 1) level = Math.floor((roll * 2) / 3) + 1;
    else level = Math.max(roll, shelves * 2);
    level = Math.max(1, Math.min(60, level));
    if (level < slot + 1) continue;

    const rng = mulberry32((((seed >>> 0) + slot * 0x9e3779b9) >>> 0) || 1);
    const rolled = rollEnchantments(rng, level, item);
    if (rolled.length === 0) continue;

    offers.push({
      slot,
      level,
      lapis: OFFER_LAPIS[slot],
      enchantments: rolled,
      label: describeEnchantments(rolled),
    });
  }
  return offers;
}

/**
 * German one-line summary of an enchantment list.
 * @param {readonly {id:string, level:number}[]} list the enchantments
 * @returns {string} e.g. `'Effizienz III, Haltbarkeit II'`
 */
export function describeEnchantments(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const roman = ROMAN[Math.max(1, Math.min(ROMAN.length - 1, list[i].level | 0))];
    parts.push(`${enchantmentDisplay(list[i].id)} ${roman}`.trim());
  }
  return parts.join(', ');
}

/** Roman numerals, indexed by level. @type {readonly string[]} */
const ROMAN = Object.freeze(['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']);

/**
 * Put a rolled enchantment list onto a stack, turning a plain book into an
 * enchanted one on the way.
 * @param {ItemStack} stack the stack to enchant (mutated)
 * @param {readonly {id:string, level:number}[]} list the enchantments
 * @returns {ItemStack} the enchanted stack (a new one for a plain book)
 */
export function applyEnchantments(stack, list) {
  let target = stack;
  if (target.itemId === I.BOOK && I.ENCHANTED_BOOK !== undefined) {
    target = new ItemStack(I.ENCHANTED_BOOK, 1, null);
  }
  for (let i = 0; i < list.length; i++) {
    try {
      target.addEnchantment(list[i].id, list[i].level);
    } catch (err) {
      warnOnce('apply', 'an enchantment could not be applied', err);
    }
  }
  return target;
}

/* ========================================================================== */
/* EnchantingTable                                                            */
/* ========================================================================== */

/**
 * Slot layout of an {@link EnchantingTable}. @type {Readonly<Object<string, number>>}
 */
export const TABLE_SLOT = Object.freeze({ ITEM: 0, LAPIS: 1 });

/**
 * The block entity behind an enchanting table.
 *
 * Two slots (the item and the lapis lazuli) plus a 32-bit seed that re-rolls
 * whenever the item changes, so the three offers are stable while the player
 * looks at them and different for the next item.
 *
 * Emits `'offers'` `(table)` whenever the offer list changed.
 *
 * @augments Inventory
 */
export class EnchantingTable extends Inventory {
  /**
   * @param {Object} [opts] configuration
   * @param {number} [opts.x] block X
   * @param {number} [opts.y] block Y
   * @param {number} [opts.z] block Z
   * @param {number} [opts.seed] initial seed (a random one is drawn otherwise)
   */
  constructor(opts = {}) {
    super(2, { title: 'Zaubertisch', storageStart: TABLE_SLOT.ITEM, storageEnd: TABLE_SLOT.ITEM });

    /** @type {string} Container kind, for the inventory UI. */
    this.kind = 'enchanting_table';
    /** @type {number} Block X, `NaN` when the table is not placed. */
    this.x = Number.isFinite(opts.x) ? opts.x | 0 : NaN;
    /** @type {number} Block Y. */
    this.y = Number.isFinite(opts.y) ? opts.y | 0 : NaN;
    /** @type {number} Block Z. */
    this.z = Number.isFinite(opts.z) ? opts.z | 0 : NaN;
    /** @type {number} How many screens currently show this table. */
    this.viewers = 0;

    /** @type {number} 32-bit seed the offers are rolled from. */
    this.seed = (Number.isFinite(opts.seed) ? opts.seed >>> 0 : (Math.random() * 0x100000000) >>> 0) || 1;
    /** @type {number} Bookshelves counted around the table, `0..15`. */
    this.bookshelves = 0;
    /** @type {{slot:number, level:number, lapis:number, enchantments:{id:string, level:number}[], label:string}[]} Current offers. */
    this.offers = [];
    /** @type {number} Item id the current offers were rolled for. @private */
    this._offerItem = 0;
    /** @type {string} Fingerprint of the item the offers belong to. @private */
    this._offerKey = '';
    /** @type {boolean} A bookshelf rescan is queued. */
    this.needsScan = true;
  }

  /**
   * Only the item slot takes items; lapis is placed by the UI into slot 1.
   * @param {number} i slot index
   * @param {?ItemStack} stack the stack about to be placed
   * @returns {boolean} `true` when the slot accepts the stack
   */
  canPlaceIn(i, stack) {
    if (!super.canPlaceIn(i, stack)) return false;
    if (i === TABLE_SLOT.LAPIS) return stack.itemId === I.LAPIS_LAZULI;
    if (i === TABLE_SLOT.ITEM) return isEnchantable(stack.itemId) && enchantmentsOf(stack).length === 0;
    return false;
  }

  /**
   * Shift-click insertion: lapis to the lapis slot, everything enchantable to
   * the item slot.
   * @param {?ItemStack} stack stack to insert (not mutated)
   * @returns {?ItemStack} leftover, or `null`
   */
  quickInsert(stack) {
    if (stack === null || stack === undefined || stack.isEmpty()) return null;
    if (stack.itemId === I.LAPIS_LAZULI) return this.addAt(TABLE_SLOT.LAPIS, stack);
    if (this.slots[TABLE_SLOT.ITEM] === null && this.canPlaceIn(TABLE_SLOT.ITEM, stack)) {
      return this.addAt(TABLE_SLOT.ITEM, stack);
    }
    return stack.clone();
  }

  /** @returns {?ItemStack} the item on the table */
  get item() {
    return this.slots[TABLE_SLOT.ITEM];
  }

  /** @returns {number} how much lapis lies on the table */
  get lapis() {
    const stack = this.slots[TABLE_SLOT.LAPIS];
    return stack === null ? 0 : stack.count;
  }

  /**
   * Register a viewer.
   * @returns {number} the new viewer count
   */
  open() {
    this.viewers++;
    if (this.viewers === 1) this.emit('open', this);
    return this.viewers;
  }

  /**
   * Unregister a viewer.
   * @returns {number} the new viewer count
   */
  close() {
    if (this.viewers > 0) this.viewers--;
    if (this.viewers === 0) this.emit('close', this);
    return this.viewers;
  }

  /**
   * Fingerprint of the item on the table — used to notice a swap.
   * @returns {string} the fingerprint, `''` when the table is empty
   * @private
   */
  _itemKey() {
    const stack = this.item;
    if (stack === null) return '';
    const meta = stack.meta;
    const name = meta !== null && meta.name !== null ? meta.name : '';
    return `${stack.itemId}:${stack.count}:${name}:${stack.durability}`;
  }

  /**
   * Recompute the offers. Re-rolls the seed when the item on the table
   * changed, and keeps it while the same item lies there — so the offer list
   * is stable to look at but never farmable.
   *
   * @param {number} [bookshelves] the bookshelf count; keeps the current one
   *   when omitted
   * @returns {boolean} `true` when the offer list changed
   */
  refresh(bookshelves = this.bookshelves) {
    const shelves = clamp(Math.round(num(bookshelves, 0)), 0, MAX_BOOKSHELVES);
    const key = this._itemKey();
    const stack = this.item;
    const itemId = stack === null ? 0 : stack.itemId;

    if (key === '' || itemId <= 0) {
      this.bookshelves = shelves;
      if (this.offers.length === 0 && this._offerKey === '') return false;
      this.offers = [];
      this._offerKey = '';
      this._offerItem = 0;
      this.emit('offers', this);
      return true;
    }

    const itemChanged = key !== this._offerKey;
    if (itemChanged) this.seed = ((Math.random() * 0x100000000) >>> 0) || 1;
    else if (shelves === this.bookshelves && this.offers.length > 0) return false;

    this.bookshelves = shelves;
    this._offerKey = key;
    this._offerItem = itemId;
    this.offers = generateOffers(this.seed, shelves, itemId);
    this.emit('offers', this);
    return true;
  }

  /**
   * Can the player afford an offer right now?
   * @param {number} index offer index `0..2`
   * @param {?Object} player the player
   * @returns {{ok:boolean, reason:string}} `reason` is a German message
   */
  canAfford(index, player) {
    const offer = this.offers[index];
    if (offer === undefined) return { ok: false, reason: 'Kein Angebot' };
    if (this.item === null) return { ok: false, reason: 'Kein Gegenstand' };
    if (player !== null && player !== undefined && player.gameMode === 'creative') {
      return { ok: true, reason: '' };
    }
    if (this.lapis < offer.lapis) return { ok: false, reason: 'Zu wenig Lapislazuli' };
    const levels = player === null || player === undefined
      ? 0 : Math.floor(num(player.xpLevel, 0));
    if (levels < offer.level) return { ok: false, reason: 'Zu wenig Erfahrungsstufen' };
    return { ok: true, reason: '' };
  }

  /**
   * Buy an offer: pay the lapis and the levels, enchant the item and re-roll
   * the table for the next customer.
   *
   * @param {number} index offer index `0..2`
   * @param {?Object} player the player paying
   * @returns {{ok:boolean, stack:?ItemStack, cost:number, message:string}}
   *   `stack` is the enchanted item, still sitting in the item slot
   */
  enchant(index, player) {
    const offer = this.offers[index];
    const check = this.canAfford(index, player);
    if (!check.ok || offer === undefined) {
      return { ok: false, stack: null, cost: 0, message: check.reason };
    }
    const stack = this.item;
    if (stack === null) return { ok: false, stack: null, cost: 0, message: 'Kein Gegenstand' };

    const creative = player !== null && player !== undefined && player.gameMode === 'creative';
    if (!creative && !spendLevels(player, offer.level)) {
      return { ok: false, stack: null, cost: 0, message: 'Zu wenig Erfahrungsstufen' };
    }

    if (!creative) {
      const lapisStack = this.slots[TABLE_SLOT.LAPIS];
      if (lapisStack !== null) {
        const prev = lapisStack.clone();
        lapisStack.count -= offer.lapis;
        if (lapisStack.count <= 0) this.slots[TABLE_SLOT.LAPIS] = null;
        this._changed(TABLE_SLOT.LAPIS, prev);
      }
    }

    const enchanted = applyEnchantments(stack.clone(), offer.enchantments);
    const prevItem = this.slots[TABLE_SLOT.ITEM];
    this.slots[TABLE_SLOT.ITEM] = enchanted;
    this._changed(TABLE_SLOT.ITEM, prevItem);

    // A used table always draws a new seed, exactly like vanilla.
    this.seed = ((Math.random() * 0x100000000) >>> 0) || 1;
    this._offerKey = '';
    this.refresh(this.bookshelves);

    return {
      ok: true,
      stack: enchanted,
      cost: offer.level,
      message: describeEnchantments(offer.enchantments),
    };
  }

  /* -- persistence --------------------------------------------------------- */

  /**
   * @returns {Object} structured-clone-safe save record
   */
  serialize() {
    const base = super.serialize();
    return {
      size: base.size,
      slots: base.slots,
      kind: this.kind,
      x: Number.isFinite(this.x) ? this.x : null,
      y: Number.isFinite(this.y) ? this.y : null,
      z: Number.isFinite(this.z) ? this.z : null,
      seed: this.seed,
      bookshelves: this.bookshelves,
    };
  }

  /**
   * @param {?Object} o save record
   * @returns {EnchantingTable} `this`
   */
  deserialize(o) {
    super.deserialize(o);
    if (o === null || o === undefined) return this;
    if (Number.isFinite(o.x)) this.x = o.x | 0;
    if (Number.isFinite(o.y)) this.y = o.y | 0;
    if (Number.isFinite(o.z)) this.z = o.z | 0;
    this.seed = (Number.isFinite(o.seed) ? o.seed >>> 0 : this.seed) || 1;
    this.bookshelves = clamp(num(o.bookshelves, 0) | 0, 0, MAX_BOOKSHELVES);
    this._offerKey = '';
    this.offers = [];
    this.needsScan = true;
    return this;
  }

  /**
   * Rebuild a table from save data.
   * @param {?Object} o save record
   * @returns {EnchantingTable} the restored table
   */
  static deserialize(o) {
    const table = new EnchantingTable({
      x: (o && Number.isFinite(o.x)) ? o.x : undefined,
      y: (o && Number.isFinite(o.y)) ? o.y : undefined,
      z: (o && Number.isFinite(o.z)) ? o.z : undefined,
      seed: (o && Number.isFinite(o.seed)) ? o.seed : undefined,
    });
    table.deserialize(o);
    return table;
  }
}

/* ========================================================================== */
/* Anvil                                                                      */
/* ========================================================================== */

/** Slot layout of an {@link Anvil}. @type {Readonly<Object<string, number>>} */
export const ANVIL_SLOT = Object.freeze({ LEFT: 0, RIGHT: 1, RESULT: 2 });

/**
 * The outcome of one anvil combination.
 * @typedef {Object} AnvilResult
 * @property {?ItemStack} stack the resulting item, or `null` when nothing works
 * @property {number} cost experience levels the use costs
 * @property {number} materialCost how many items of the right slot are eaten
 * @property {boolean} tooExpensive the cost reached {@link ANVIL_LEVEL_LIMIT}
 * @property {string} message a German explanation for the UI
 */

/**
 * Combine two stacks the way an anvil does.
 *
 * Handles all four vanilla jobs at once: repairing with a material, repairing
 * with a second item of the same kind, merging enchantments (from an item or
 * from an enchanted book) and renaming — plus the doubling prior-work penalty
 * that eventually makes an item "too expensive".
 *
 * The inputs are never mutated; the result is a fresh stack.
 *
 * @param {?ItemStack} left the item being worked on
 * @param {?ItemStack} right the sacrifice / material / book, may be `null`
 * @param {?string} [customName] the new name, or `null` to keep the current one
 * @returns {AnvilResult} what the anvil would produce
 */
export function combineItems(left, right, customName = null) {
  /** @type {AnvilResult} */
  const fail = {
    stack: null, cost: 0, materialCost: 0, tooExpensive: false, message: 'Nicht kombinierbar',
  };
  if (left === null || left === undefined || left.isEmpty()) {
    return { ...fail, message: 'Kein Gegenstand' };
  }

  const result = left.clone();
  let cost = priorWorkPenalty(left) + (right === null ? 0 : priorWorkPenalty(right));
  let materialCost = 0;
  let didSomething = false;

  const maxDurability = itemDurability(left.itemId);
  const hasRight = right !== null && right !== undefined && !right.isEmpty();

  if (hasRight) {
    const repairItem = getItem(left.itemId).repairItem;
    const sameItem = right.itemId === left.itemId;

    if (maxDurability > 0 && repairItem > 0 && right.itemId === repairItem && !sameItem) {
      /* ---- repair with raw material ------------------------------------- */
      const missing = maxDurability - left.durability;
      if (missing <= 0) return { ...fail, message: 'Nicht beschädigt' };
      const perUnit = Math.max(1, Math.floor(maxDurability * REPAIR_FRACTION));
      const needed = Math.min(
        Math.min(MAX_REPAIR_MATERIALS, right.count),
        Math.ceil(missing / perUnit),
      );
      result.repair(needed * perUnit);
      materialCost = needed;
      cost += needed;
      didSomething = true;
    } else if (sameItem) {
      /* ---- repair with a second item + merge its enchantments ----------- */
      if (maxDurability > 0) {
        const missing = maxDurability - left.durability;
        if (missing > 0) {
          const restored = Math.min(
            missing,
            right.durability + Math.floor(maxDurability * COMBINE_REPAIR_BONUS),
          );
          if (restored > 0) {
            result.repair(restored);
            didSomething = true;
          }
        }
      }
      materialCost = 1;
      if (mergeEnchantments(result, right, false, (n) => { cost += n; })) didSomething = true;
    } else if (right.itemId === I.ENCHANTED_BOOK) {
      /* ---- apply an enchanted book -------------------------------------- */
      materialCost = 1;
      if (mergeEnchantments(result, right, true, (n) => { cost += n; })) didSomething = true;
    } else {
      return { ...fail, message: 'Nicht kombinierbar' };
    }
  }

  /* ---- renaming --------------------------------------------------------- */
  if (customName !== null && customName !== undefined) {
    const wanted = String(customName).slice(0, 48);
    const current = left.meta !== null && left.meta.name !== null
      ? left.meta.name : itemDisplay(left.itemId);
    if (wanted !== current) {
      if (wanted.length === 0 || wanted === itemDisplay(left.itemId)) result.setCustomName(null);
      else result.setCustomName(wanted);
      cost += 1;
      didSomething = true;
    }
  }

  if (!didSomething) {
    return { ...fail, message: hasRight ? 'Nichts zu tun' : 'Kein Ergebnis' };
  }

  /* ---- prior work ------------------------------------------------------- */
  const nextWork = Math.max(priorWork(left), right === null ? 0 : priorWork(right)) + 1;
  setPriorWork(result, nextWork);

  const total = Math.max(1, Math.round(cost));
  return {
    stack: result,
    cost: total,
    materialCost,
    tooExpensive: total >= ANVIL_LEVEL_LIMIT,
    message: total >= ANVIL_LEVEL_LIMIT ? 'Zu teuer!' : '',
  };
}

/**
 * Fold the enchantments of `source` into `target`, charging the caller through
 * `addCost`. Levels stack the vanilla way: two equal levels below the maximum
 * become one level higher, otherwise the higher of the two wins.
 *
 * @param {ItemStack} target the item being upgraded (mutated)
 * @param {ItemStack} source the sacrifice or book
 * @param {boolean} fromBook use the book cost multipliers
 * @param {(n:number) => void} addCost receives the level cost of each merge
 * @returns {boolean} `true` when at least one enchantment moved over
 */
function mergeEnchantments(target, source, fromBook, addCost) {
  const list = enchantmentsOf(source);
  if (list.length === 0) return false;
  let moved = false;

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const def = ENCH_BY_ID.get(entry.id);
    if (def === undefined) continue;

    if (!canEnchant(entry.id, target.itemId)) {
      // Vanilla silently drops an inapplicable enchantment but still charges.
      addCost(1);
      continue;
    }

    let conflicted = false;
    const existing = enchantmentsOf(target);
    for (let c = 0; c < existing.length; c++) {
      if (existing[c].id !== entry.id && conflictsWith(existing[c].id, entry.id)) {
        conflicted = true;
        break;
      }
    }
    if (conflicted) {
      addCost(1);
      continue;
    }

    const own = enchantLevel(target, entry.id);
    let level;
    if (own === entry.level) level = Math.min(def.maxLevel, own + 1);
    else level = Math.min(def.maxLevel, Math.max(own, entry.level));
    if (level <= own) {
      addCost(1);
      continue;
    }

    target.addEnchantment(entry.id, level);
    addCost(level * (fromBook ? def.anvilBookCost : def.anvilItemCost));
    moved = true;
  }
  return moved;
}

/**
 * The block entity behind an anvil: two inputs, one preview output and the
 * rename field.
 *
 * Emits `'result'` `(anvil)` whenever the preview changed.
 *
 * @augments Inventory
 */
export class Anvil extends Inventory {
  /**
   * @param {Object} [opts] configuration
   * @param {number} [opts.x] block X
   * @param {number} [opts.y] block Y
   * @param {number} [opts.z] block Z
   */
  constructor(opts = {}) {
    super(3, { title: 'Amboss', storageStart: ANVIL_SLOT.LEFT, storageEnd: ANVIL_SLOT.RIGHT });

    /** @type {string} Container kind, for the inventory UI. */
    this.kind = 'anvil';
    /** @type {number} Block X, `NaN` when the anvil is not placed. */
    this.x = Number.isFinite(opts.x) ? opts.x | 0 : NaN;
    /** @type {number} Block Y. */
    this.y = Number.isFinite(opts.y) ? opts.y | 0 : NaN;
    /** @type {number} Block Z. */
    this.z = Number.isFinite(opts.z) ? opts.z | 0 : NaN;
    /** @type {number} How many screens currently show this anvil. */
    this.viewers = 0;

    /** @type {?string} The name typed into the rename field. */
    this.itemName = null;
    /** @type {number} Experience levels the current preview costs. */
    this.cost = 0;
    /** @type {number} Items of the right slot the preview eats. */
    this.materialCost = 0;
    /** @type {boolean} The preview is over {@link ANVIL_LEVEL_LIMIT}. */
    this.tooExpensive = false;
    /** @type {string} German explanation for the UI. */
    this.message = '';
    /** @type {boolean} Re-entrancy guard for {@link Anvil#refresh}. @private */
    this._refreshing = false;
  }

  /**
   * The result slot is never a drop target.
   * @param {number} i slot index
   * @param {?ItemStack} stack the stack about to be placed
   * @returns {boolean} `true` when the slot accepts the stack
   */
  canPlaceIn(i, stack) {
    if (!super.canPlaceIn(i, stack)) return false;
    return i === ANVIL_SLOT.LEFT || i === ANVIL_SLOT.RIGHT;
  }

  /**
   * Shift-click insertion: fill the left slot first, then the right one.
   * @param {?ItemStack} stack stack to insert (not mutated)
   * @returns {?ItemStack} leftover, or `null`
   */
  quickInsert(stack) {
    if (stack === null || stack === undefined || stack.isEmpty()) return null;
    let rest = stack;
    if (this.slots[ANVIL_SLOT.LEFT] === null) rest = this.addAt(ANVIL_SLOT.LEFT, rest);
    if (rest !== null && this.slots[ANVIL_SLOT.RIGHT] === null) {
      rest = this.addAt(ANVIL_SLOT.RIGHT, rest);
    }
    return rest;
  }

  /**
   * Register a viewer.
   * @returns {number} the new viewer count
   */
  open() {
    this.viewers++;
    if (this.viewers === 1) this.emit('open', this);
    return this.viewers;
  }

  /**
   * Unregister a viewer.
   * @returns {number} the new viewer count
   */
  close() {
    if (this.viewers > 0) this.viewers--;
    if (this.viewers === 0) this.emit('close', this);
    return this.viewers;
  }

  /**
   * Set the rename field and refresh the preview.
   * @param {?string} name the new name, `null` to keep the default
   * @returns {Anvil} `this`
   */
  setName(name) {
    this.itemName = (name === null || name === undefined || String(name).length === 0)
      ? null : String(name).slice(0, 48);
    this.refresh();
    return this;
  }

  /**
   * Recompute the preview in the result slot.
   * @returns {AnvilResult} the outcome the preview shows
   */
  refresh() {
    // Writing the preview fires `change`, and a UI that refreshes on `change`
    // would otherwise recurse forever.
    if (this._refreshing) {
      return {
        stack: this.slots[ANVIL_SLOT.RESULT],
        cost: this.cost,
        materialCost: this.materialCost,
        tooExpensive: this.tooExpensive,
        message: this.message,
      };
    }
    this._refreshing = true;
    const outcome = combineItems(
      this.slots[ANVIL_SLOT.LEFT],
      this.slots[ANVIL_SLOT.RIGHT],
      this.itemName,
    );
    this.cost = outcome.cost;
    this.materialCost = outcome.materialCost;
    this.tooExpensive = outcome.tooExpensive;
    this.message = outcome.message;
    const prev = this.slots[ANVIL_SLOT.RESULT];
    this.slots[ANVIL_SLOT.RESULT] = outcome.tooExpensive ? null : outcome.stack;
    try {
      if (prev !== this.slots[ANVIL_SLOT.RESULT]) this._changed(ANVIL_SLOT.RESULT, prev);
      this.emit('result', this);
    } finally {
      this._refreshing = false;
    }
    return outcome;
  }

  /**
   * Take the result: pay the levels, eat the inputs and hand the item over.
   *
   * Deliberately **not** called `take()` — {@link Inventory#take} already owns
   * that name with a slot-index signature, and `_dropContents()` relies on it.
   *
   * @param {?Object} player the player paying
   * @returns {{ok:boolean, stack:?ItemStack, cost:number, message:string}} the outcome
   */
  takeResult(player) {
    const outcome = this.refresh();
    if (outcome.stack === null) {
      return { ok: false, stack: null, cost: 0, message: outcome.message };
    }
    if (outcome.tooExpensive) {
      return { ok: false, stack: null, cost: outcome.cost, message: 'Zu teuer!' };
    }
    const creative = player !== null && player !== undefined && player.gameMode === 'creative';
    if (!creative && !spendLevels(player, outcome.cost)) {
      return { ok: false, stack: null, cost: outcome.cost, message: 'Zu wenig Erfahrungsstufen' };
    }

    this.beginBatch();
    const prevLeft = this.slots[ANVIL_SLOT.LEFT];
    this.slots[ANVIL_SLOT.LEFT] = null;
    this._changed(ANVIL_SLOT.LEFT, prevLeft);

    const right = this.slots[ANVIL_SLOT.RIGHT];
    if (right !== null) {
      const prevRight = right.clone();
      right.count -= Math.max(1, outcome.materialCost);
      if (right.count <= 0) this.slots[ANVIL_SLOT.RIGHT] = null;
      this._changed(ANVIL_SLOT.RIGHT, prevRight);
    }

    const prevResult = this.slots[ANVIL_SLOT.RESULT];
    this.slots[ANVIL_SLOT.RESULT] = null;
    this._changed(ANVIL_SLOT.RESULT, prevResult);
    this.endBatch();

    this.itemName = null;
    this.cost = 0;
    this.materialCost = 0;
    this.message = '';
    this.emit('used', this, outcome);
    return { ok: true, stack: outcome.stack, cost: outcome.cost, message: '' };
  }

  /* -- persistence --------------------------------------------------------- */

  /**
   * @returns {Object} structured-clone-safe save record
   */
  serialize() {
    const base = super.serialize();
    return {
      size: base.size,
      slots: base.slots,
      kind: this.kind,
      x: Number.isFinite(this.x) ? this.x : null,
      y: Number.isFinite(this.y) ? this.y : null,
      z: Number.isFinite(this.z) ? this.z : null,
      itemName: this.itemName,
    };
  }

  /**
   * @param {?Object} o save record
   * @returns {Anvil} `this`
   */
  deserialize(o) {
    super.deserialize(o);
    if (o === null || o === undefined) return this;
    if (Number.isFinite(o.x)) this.x = o.x | 0;
    if (Number.isFinite(o.y)) this.y = o.y | 0;
    if (Number.isFinite(o.z)) this.z = o.z | 0;
    this.itemName = typeof o.itemName === 'string' && o.itemName.length > 0 ? o.itemName : null;
    this.refresh();
    return this;
  }

  /**
   * Rebuild an anvil from save data.
   * @param {?Object} o save record
   * @returns {Anvil} the restored anvil
   */
  static deserialize(o) {
    const anvil = new Anvil({
      x: (o && Number.isFinite(o.x)) ? o.x : undefined,
      y: (o && Number.isFinite(o.y)) ? o.y : undefined,
      z: (o && Number.isFinite(o.z)) ? o.z : undefined,
    });
    anvil.deserialize(o);
    return anvil;
  }
}

/* ========================================================================== */
/* EnchantingManager                                                          */
/* ========================================================================== */

/**
 * Position key of a block.
 * @param {number} x block X
 * @param {number} y block Y
 * @param {number} z block Z
 * @returns {string} `"x,y,z"`
 */
function posKey(x, y, z) {
  return `${x | 0},${y | 0},${z | 0}`;
}

/**
 * Owns every enchanting table and anvil in the world, keeps the bookshelf
 * counts up to date inside a time budget and writes both into the save.
 *
 * Emits `'offers'` `(table)` when a table's offers changed, `'enchanted'`
 * `(table, result)` after a successful purchase and `'removed'` `(kind, node)`
 * when a table or anvil is broken.
 *
 * @augments EventBus
 */
export class EnchantingManager extends EventBus {
  /**
   * @param {?Object} world the chunk manager (`world/world.js`)
   * @param {Object} [options] wiring; every field is optional
   * @param {?Object} [options.entities] the entity manager, for dropped contents
   * @param {?Object} [options.audio] the audio engine
   * @param {?Object} [options.particles] the particle system
   * @param {number} [options.rescanSeconds] seconds between bookshelf rescans
   * @param {number} [options.budgetMs] milliseconds per tick
   */
  constructor(world, options = {}) {
    super();

    /** @type {?Object} The world. */
    this.world = world || null;
    /** @type {?Object} Entity manager, used when a block is broken. */
    this.entities = options.entities || null;
    /** @type {?Object} Audio engine. */
    this.audio = options.audio || null;
    /** @type {?Object} Particle system. */
    this.particles = options.particles || null;
    /** @type {boolean} Set by {@link EnchantingManager#dispose}. */
    this.disposed = false;

    /** @type {number} Seconds between two bookshelf rescans of one table. */
    this.rescanSeconds = Math.max(0.25, num(options.rescanSeconds, 1));

    /** @type {Map<string, EnchantingTable>} Tables by `"x,y,z"`. @private */
    this._tables = new Map();
    /** @type {Map<string, Anvil>} Anvils by `"x,y,z"`. @private */
    this._anvils = new Map();
    /** @type {EnchantingTable[]} Flat view of `_tables`. @private */
    this._list = [];
    /** @type {boolean} `_list` needs a rebuild. @private */
    this._listDirty = false;
    /** @type {number} Round-robin cursor into `_list`. @private */
    this._cursor = 0;
    /** @type {number} Seconds until the next rescan sweep. @private */
    this._rescanTimer = 0;
    /** @type {TimeBudget} Guards the bookshelf scans. @private */
    this._budget = new TimeBudget(num(options.budgetMs, DEFAULT_BUDGET_MS));

    /** @type {{tables:number, anvils:number, scans:number}} Live counters. */
    this.stats = { tables: 0, anvils: 0, scans: 0 };
  }

  /**
   * Swap the world (dimension change).
   * @param {?Object} world the new world
   * @returns {EnchantingManager} `this`
   */
  setWorld(world) {
    this.world = world || null;
    this._tables.forEach((table) => { table.needsScan = true; });
    return this;
  }

  /* -- tables -------------------------------------------------------------- */

  /**
   * Fetch (and optionally create) the enchanting table at a position. A newly
   * created table gets its bookshelves counted immediately, so the first open
   * already shows the right offers.
   *
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {boolean} [create] create the table when it does not exist yet
   * @returns {?EnchantingTable} the table, or `null`
   */
  getTable(x, y, z, create = true) {
    const key = posKey(x, y, z);
    const existing = this._tables.get(key);
    if (existing !== undefined) {
      if (existing.needsScan) this.rescanTable(existing);
      return existing;
    }
    if (!create) return null;
    const table = new EnchantingTable({ x, y, z });
    table.on('offers', this._onOffers);
    this._tables.set(key, table);
    this._listDirty = true;
    this.rescanTable(table);
    return table;
  }

  /**
   * Is there an enchanting table at this position?
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {boolean} `true` when a table exists
   */
  hasTable(x, y, z) {
    return this._tables.has(posKey(x, y, z));
  }

  /**
   * Recount the bookshelves around one table and refresh its offers.
   * @param {EnchantingTable} table the table
   * @returns {number} the bookshelf count
   */
  rescanTable(table) {
    if (!Number.isFinite(table.x)) {
      table.needsScan = false;
      return table.bookshelves;
    }
    const shelves = countBookshelves(this.world, table.x, table.y, table.z);
    table.needsScan = false;
    this.stats.scans++;
    table.refresh(shelves);
    return shelves;
  }

  /**
   * Forget the table at a position, scattering its contents.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {boolean} [dropContents] drop the slots into the world
   * @returns {boolean} `true` when a table was removed
   */
  removeTable(x, y, z, dropContents = true) {
    const key = posKey(x, y, z);
    const table = this._tables.get(key);
    if (table === undefined) return false;
    this._tables.delete(key);
    this._listDirty = true;
    table.off('offers', this._onOffers);
    if (dropContents) this._dropContents(table, x, y, z);
    this.emit('removed', 'enchanting_table', table);
    return true;
  }

  /* -- anvils -------------------------------------------------------------- */

  /**
   * Fetch (and optionally create) the anvil at a position.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {boolean} [create] create the anvil when it does not exist yet
   * @returns {?Anvil} the anvil, or `null`
   */
  getAnvil(x, y, z, create = true) {
    const key = posKey(x, y, z);
    const existing = this._anvils.get(key);
    if (existing !== undefined) return existing;
    if (!create) return null;
    const anvil = new Anvil({ x, y, z });
    this._anvils.set(key, anvil);
    return anvil;
  }

  /**
   * Is there an anvil at this position?
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {boolean} `true` when an anvil exists
   */
  hasAnvil(x, y, z) {
    return this._anvils.has(posKey(x, y, z));
  }

  /**
   * Forget the anvil at a position, scattering its contents.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {boolean} [dropContents] drop the slots into the world
   * @returns {boolean} `true` when an anvil was removed
   */
  removeAnvil(x, y, z, dropContents = true) {
    const key = posKey(x, y, z);
    const anvil = this._anvils.get(key);
    if (anvil === undefined) return false;
    this._anvils.delete(key);
    // The result slot only ever holds a preview — dropping it would duplicate
    // the inputs that are still sitting in the two input slots.
    anvil.slots[ANVIL_SLOT.RESULT] = null;
    if (dropContents) this._dropContents(anvil, x, y, z);
    this.emit('removed', 'anvil', anvil);
    return true;
  }

  /**
   * Buy an offer at a table and report it.
   * @param {EnchantingTable} table the table
   * @param {number} index offer index `0..2`
   * @param {?Object} player the player paying
   * @returns {{ok:boolean, stack:?ItemStack, cost:number, message:string}} the outcome
   */
  enchant(table, index, player) {
    const result = table.enchant(index, player);
    if (!result.ok) return result;
    this.emit('enchanted', table, result);
    if (this.audio !== null && typeof this.audio.play === 'function' && Number.isFinite(table.x)) {
      try {
        this.audio.play('enchanting', {
          x: table.x + 0.5, y: table.y + 1, z: table.z + 0.5, volume: 0.9,
        });
      } catch (err) {
        warnOnce('ench:audio', 'the enchanting sound failed', err);
      }
    }
    if (this.particles !== null && typeof this.particles.spawn === 'function'
      && Number.isFinite(table.x)) {
      try {
        this.particles.spawn('portal', table.x + 0.5, table.y + 1.2, table.z + 0.5,
          { count: 24, speed: 1.4, life: 1.1 });
      } catch (err) {
        warnOnce('ench:particles', 'the enchanting particles failed', err);
      }
    }
    return result;
  }

  /**
   * Relay a table's offer change.
   * @param {EnchantingTable} table the table
   * @returns {void}
   * @private
   */
  _onOffers = (table) => {
    this.emit('offers', table);
  };

  /**
   * Drop everything an inventory holds at a block position.
   * @param {Inventory} inventory the container
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {void}
   * @private
   */
  _dropContents(inventory, x, y, z) {
    if (this.entities === null || typeof this.entities.dropItem !== 'function') return;
    for (let i = 0; i < inventory.size; i++) {
      const stack = inventory.take(i);
      if (stack === null) continue;
      try {
        this.entities.dropItem(x + 0.5, y + 0.5, z + 0.5, stack, null);
      } catch (err) {
        warnOnce('drop', 'the container contents could not be dropped', err);
      }
    }
  }

  /**
   * Rebuild the flat table list.
   * @returns {EnchantingTable[]} the list
   * @private
   */
  _tableList() {
    if (this._listDirty) {
      this._list.length = 0;
      this._tables.forEach((t) => { this._list.push(t); });
      this._listDirty = false;
      if (this._cursor >= this._list.length) this._cursor = 0;
    }
    return this._list;
  }

  /* -- tick ---------------------------------------------------------------- */

  /**
   * Keep the bookshelf counts fresh.
   *
   * A rescan walks up to 32 block probes, so the sweep is spread round-robin
   * across ticks under a {@link TimeBudget}: a room full of enchanting tables
   * costs a bounded amount of time per tick and every table is still rescanned
   * within a few seconds.
   *
   * @param {number} dt elapsed seconds
   * @returns {number} how many tables were rescanned this tick
   */
  tick(dt) {
    if (this.disposed) return 0;
    const list = this._tableList();
    this.stats.tables = list.length;
    this.stats.anvils = this._anvils.size;
    if (list.length === 0) return 0;

    this._rescanTimer -= clamp(num(dt, 0), 0, 0.25);
    const sweep = this._rescanTimer <= 0;
    if (sweep) {
      this._rescanTimer = this.rescanSeconds;
      for (let i = 0; i < list.length; i++) list[i].needsScan = true;
    }

    this._budget.start();
    let scanned = 0;
    let visited = 0;
    const n = list.length;
    while (visited < n) {
      if (this._cursor >= n) this._cursor = 0;
      const table = list[this._cursor];
      this._cursor++;
      visited++;
      if (table === undefined || !table.needsScan) continue;
      try {
        this.rescanTable(table);
        scanned++;
      } catch (err) {
        warnOnce('rescan', 'a bookshelf rescan failed', err);
        table.needsScan = false;
      }
      if (this._budget.expired()) break;
    }
    return scanned;
  }

  /* -- persistence --------------------------------------------------------- */

  /**
   * Snapshot every table and anvil that holds something.
   * @returns {{v:number, tables:Array<[string, Object]>, anvils:Array<[string, Object]>}} save record
   */
  serialize() {
    /** @type {Array<[string, Object]>} */
    const tables = [];
    /** @type {Array<[string, Object]>} */
    const anvils = [];
    this._tables.forEach((table, key) => {
      try {
        tables.push([key, table.serialize()]);
      } catch (err) {
        warnOnce('save:table', 'an enchanting table could not be serialised', err);
      }
    });
    this._anvils.forEach((anvil, key) => {
      try {
        if (anvil.isEmpty() && anvil.itemName === null) return;
        anvils.push([key, anvil.serialize()]);
      } catch (err) {
        warnOnce('save:anvil', 'an anvil could not be serialised', err);
      }
    });
    return { v: ENCHANTING_SAVE_VERSION, tables, anvils };
  }

  /**
   * Restore a snapshot produced by {@link EnchantingManager#serialize}.
   * @param {?Object} o the record
   * @returns {EnchantingManager} `this`
   */
  deserialize(o) {
    this.clear();
    if (o === null || o === undefined) return this;
    if (Array.isArray(o.tables)) {
      for (let i = 0; i < o.tables.length; i++) {
        const entry = o.tables[i];
        if (!Array.isArray(entry) || entry.length < 2) continue;
        try {
          const table = EnchantingTable.deserialize(entry[1]);
          table.on('offers', this._onOffers);
          this._tables.set(String(entry[0]), table);
        } catch (err) {
          warnOnce('load:table', 'an enchanting table could not be restored', err);
        }
      }
    }
    if (Array.isArray(o.anvils)) {
      for (let i = 0; i < o.anvils.length; i++) {
        const entry = o.anvils[i];
        if (!Array.isArray(entry) || entry.length < 2) continue;
        try {
          this._anvils.set(String(entry[0]), Anvil.deserialize(entry[1]));
        } catch (err) {
          warnOnce('load:anvil', 'an anvil could not be restored', err);
        }
      }
    }
    this._listDirty = true;
    return this;
  }

  /**
   * Forget every table and anvil without dropping anything (world unload).
   * @returns {void}
   */
  clear() {
    this._tables.forEach((table) => { table.off('offers', this._onOffers); });
    this._tables.clear();
    this._anvils.clear();
    this._list.length = 0;
    this._listDirty = false;
    this._cursor = 0;
    this._rescanTimer = 0;
  }

  /**
   * Release everything. The manager is inert afterwards.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.world = null;
    this.entities = null;
    this.audio = null;
    this.particles = null;
    this.removeAllListeners();
  }
}

export default EnchantingManager;
