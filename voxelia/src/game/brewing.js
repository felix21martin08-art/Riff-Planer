/**
 * @file game/brewing.js — VOXELIA brewing stand, potions and splash potions.
 *
 * ============================================================================
 * HOW A POTION IS STORED
 * ============================================================================
 * `game/items.js` is a frozen registry — no module may add item ids to it at
 * runtime. A potion is therefore a **glass bottle carrying metadata**: the
 * stack is `I.GLASS_BOTTLE` and its {@link StackMeta} `name` is the potion's
 * full German display name, which uniquely identifies the triple
 * `(potion, variant, kind)`.
 *
 * That is not a trick — it is the only carrier the existing
 * {@link ItemStack} contract keeps intact through `clone()`, `serialize()`,
 * `deserialize()` and `metaEquals()`. The decode side is a single `Map`
 * lookup built once at module load from every `(potion, variant, kind)`
 * combination, so it is exact and lossless — no string parsing, no guessing.
 * The `lore` lines are regenerated on encode and are purely cosmetic: they are
 * the German effect list the tooltip shows.
 *
 * Unrecognised metadata degrades to "plain glass bottle", never to an error.
 *
 * ============================================================================
 * INGREDIENT SUBSTITUTION
 * ============================================================================
 * Four vanilla brewing ingredients have no item id in this build
 * (`nether_wart`, `fermented_spider_eye`, `pufferfish`, `rabbit_foot`,
 * `phantom_membrane`, `glistering_melon_slice`, `dragon_breath`). Every
 * ingredient is therefore declared by *name* with an ordered fallback list
 * (see {@link INGREDIENT_NAMES}); the first name that exists in `items.js`
 * wins, and an ingredient with no resolvable name simply has no recipe. When
 * `items.js` later grows the real items, the table picks them up with no code
 * change.
 *
 * ============================================================================
 * THE STAND
 * ============================================================================
 * {@link BrewingStand} is a five-slot {@link Inventory} (3 bottles, 1
 * ingredient, 1 fuel). One blaze powder fills the fuel bar with
 * {@link FUEL_USES} brews; a brew takes {@link BREW_TIME} ticks and burns one
 * fuel unit when it starts. {@link BrewingManager} owns the stands per block
 * position, spreads their ticking across frames with a {@link TimeBudget} and
 * serialises them into the save.
 *
 * @module game/brewing
 */

import { EventBus, TimeBudget } from '../core/util.js';
import { clamp } from '../core/math.js';
import { I, itemIdByName, getItem } from './items.js';
import { ItemStack, Inventory } from './inventory.js';
import { Entity, registerEntityClass } from './entities.js';
import { isSolid } from '../world/blocks.js';
import {
  GRAVITY, TERMINAL_VELOCITY, applyGravity, applyDrag,
} from './physics.js';
import {
  EFFECT, TICKS_PER_SECOND, getEffect, effectDisplay, effectParticleColor,
  romanLevel, formatTicks,
} from './effects.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Ticks one brew takes. @type {number} */
export const BREW_TIME = 400;

/** Brews one blaze powder fuels. @type {number} */
export const FUEL_USES = 20;

/** Slot layout of a {@link BrewingStand}. @type {Readonly<Object<string, number>>} */
export const BREW_SLOT = Object.freeze({
  BOTTLE_0: 0, BOTTLE_1: 1, BOTTLE_2: 2, INGREDIENT: 3, FUEL: 4,
});

/** Number of slots in a brewing stand. @type {number} */
export const BREW_SLOT_COUNT = 5;

/** Splash radius in blocks. @type {number} */
export const SPLASH_RADIUS = 4.0;

/** Duration multiplier of a splash potion (vanilla 3/4). @type {number} */
export const SPLASH_DURATION_SCALE = 0.75;

/** Duration multiplier of a lingering potion (vanilla 1/4). @type {number} */
export const LINGERING_DURATION_SCALE = 0.25;

/** Launch speed of a thrown potion in blocks/s. @type {number} */
export const THROW_SPEED = 10;

/** Seconds a thrown potion may fly before it gives up. @type {number} */
export const THROW_MAX_AGE = 40;

/** Save-format version written by {@link BrewingManager#serialize}. @type {number} */
export const BREWING_SAVE_VERSION = 1;

/** Milliseconds of a tick {@link BrewingManager} may spend. @type {number} */
export const DEFAULT_BUDGET_MS = 1.0;

/** Kinds of potion container. @type {Readonly<Object<string, string>>} */
export const POTION_KIND = Object.freeze({
  DRINK: 'drink', SPLASH: 'splash', LINGERING: 'lingering',
});

/** Potency variants of a potion. @type {Readonly<Object<string, string>>} */
export const POTION_VARIANT = Object.freeze({
  BASE: 'base', LONG: 'long', STRONG: 'strong',
});

/** Modifier kinds an ingredient can be. @type {Readonly<Object<string, string>>} */
export const MODIFIER = Object.freeze({
  EXTEND: 'extend', AMPLIFY: 'amplify', SPLASH: 'splash',
  LINGER: 'linger', CORRUPT: 'corrupt',
});

/* ========================================================================== */
/* Diagnostics                                                                */
/* ========================================================================== */

/** Keys of problems already reported. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a problem exactly once per key — brewing runs inside the game tick.
 * @param {string} key de-duplication key
 * @param {string} message human readable message
 * @param {*} [err] the original error
 * @returns {void}
 */
function warnOnce(key, message, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err !== undefined) console.warn(`[VOXELIA] brewing: ${message}`, err);
  else console.warn(`[VOXELIA] brewing: ${message}`);
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
/* Ingredient resolution                                                      */
/* ========================================================================== */

/**
 * Every brewing ingredient by logical name, with the ordered fallback names
 * used when the real item does not exist in this build. The first resolvable
 * name wins; a logical ingredient with no resolvable name is simply skipped,
 * which removes exactly the recipes that use it.
 * @type {Readonly<Object<string, readonly string[]>>}
 */
export const INGREDIENT_NAMES = Object.freeze({
  nether_wart: Object.freeze(['nether_wart', 'red_mushroom']),
  fermented_spider_eye: Object.freeze(['fermented_spider_eye', 'brown_mushroom']),
  glowstone_dust: Object.freeze(['glowstone_dust']),
  redstone: Object.freeze(['redstone']),
  gunpowder: Object.freeze(['gunpowder']),
  dragon_breath: Object.freeze(['dragon_breath']),
  blaze_powder: Object.freeze(['blaze_powder']),
  sugar: Object.freeze(['sugar']),
  spider_eye: Object.freeze(['spider_eye']),
  ghast_tear: Object.freeze(['ghast_tear']),
  magma_cream: Object.freeze(['magma_cream']),
  golden_carrot: Object.freeze(['golden_carrot']),
  rabbit_foot: Object.freeze(['rabbit_foot', 'rabbit_hide']),
  pufferfish: Object.freeze(['pufferfish', 'tropical_fish']),
  phantom_membrane: Object.freeze(['phantom_membrane', 'feather']),
  glistering_melon_slice: Object.freeze(['glistering_melon_slice', 'melon_slice']),
});

/** Logical ingredient name -> resolved item id (`0` = unavailable). @type {Map<string, number>} */
const INGREDIENT_ID = new Map();

/** Resolved item id -> logical ingredient name. @type {Map<number, string>} */
const INGREDIENT_NAME_BY_ID = new Map();

for (const logical of Object.keys(INGREDIENT_NAMES)) {
  const candidates = INGREDIENT_NAMES[logical];
  let id = 0;
  for (let i = 0; i < candidates.length; i++) {
    const resolved = itemIdByName(candidates[i]);
    if (resolved > 0) { id = resolved; break; }
  }
  INGREDIENT_ID.set(logical, id);
  if (id > 0 && !INGREDIENT_NAME_BY_ID.has(id)) INGREDIENT_NAME_BY_ID.set(id, logical);
}

/**
 * Item id backing a logical brewing ingredient.
 * @param {string} logical a key of {@link INGREDIENT_NAMES}
 * @returns {number} item id, `0` when the ingredient does not exist here
 */
export function ingredientItem(logical) {
  const id = INGREDIENT_ID.get(logical);
  return id === undefined ? 0 : id;
}

/**
 * Logical brewing ingredient an item id stands for.
 * @param {number} itemId item id
 * @returns {?string} the logical name, or `null`
 */
export function ingredientName(itemId) {
  const name = INGREDIENT_NAME_BY_ID.get(itemId | 0);
  return name === undefined ? null : name;
}

/* ========================================================================== */
/* Potion registry                                                            */
/* ========================================================================== */

/**
 * One effect a potion grants.
 * @typedef {{id:string, amplifier:number, duration:number}} PotionEffect
 */

/**
 * One brewable potion type.
 *
 * @typedef {Object} PotionDef
 * @property {string} id snake_case identifier, e.g. `'strength'`
 * @property {?string} genitive German genitive phrase (`'der Stärke'`), or
 *   `null` for the four bases, which carry explicit nouns instead
 * @property {?Readonly<Object<string, string>>} nouns explicit German names per
 *   kind, used by the bases
 * @property {string} hex tooltip/particle colour
 * @property {Readonly<Object<string, readonly PotionEffect[]>>} variants
 *   variant name -> effect list (`base` always exists)
 * @property {boolean} isBase `true` for water/mundane/thick/awkward
 */

/** Dense list of every potion, in brewing order. @type {PotionDef[]} */
const POTION_DEFS = [];

/** Potion id -> definition. @type {Map<string, PotionDef>} */
const POTION_BY_ID = new Map();

/** Empty effect list shared by the bases. @type {readonly PotionEffect[]} */
const NO_EFFECTS = Object.freeze([]);

/**
 * Build one potion effect record.
 * @param {string} id effect id from `game/effects.js`
 * @param {number} amplifier 0-based level
 * @param {number} duration duration in ticks (`0` for instant effects)
 * @returns {PotionEffect} the frozen record
 */
function pe(id, amplifier, duration) {
  return Object.freeze({ id, amplifier, duration });
}

/**
 * Register one potion.
 * @param {string} id potion id
 * @param {?string} genitive German genitive phrase, `null` for a base
 * @param {string} hex colour
 * @param {Object<string, readonly PotionEffect[]>} variants variant -> effects
 * @param {?Object<string, string>} [nouns] explicit names per kind (bases only)
 * @returns {PotionDef} the frozen definition
 */
function definePotion(id, genitive, hex, variants, nouns = null) {
  /** @type {Object<string, readonly PotionEffect[]>} */
  const frozenVariants = Object.create(null);
  for (const key of Object.keys(variants)) frozenVariants[key] = Object.freeze(variants[key].slice());
  const def = Object.freeze({
    id,
    genitive,
    nouns: nouns === null ? null : Object.freeze({ ...nouns }),
    hex,
    variants: Object.freeze(frozenVariants),
    isBase: genitive === null,
  });
  POTION_DEFS.push(def);
  POTION_BY_ID.set(id, def);
  return def;
}

/* -- the four bases -------------------------------------------------------- */

definePotion('water', null, '#385dc6', { base: NO_EFFECTS }, {
  drink: 'Wasserflasche',
  splash: 'Wurfwasserflasche',
  lingering: 'Verweilwasserflasche',
});

definePotion('mundane', null, '#6b7b8c', { base: NO_EFFECTS }, {
  drink: 'Fader Trank',
  splash: 'Fader Wurftrank',
  lingering: 'Fader Verweiltrank',
});

definePotion('thick', null, '#4f5b6b', { base: NO_EFFECTS }, {
  drink: 'Dickflüssiger Trank',
  splash: 'Dickflüssiger Wurftrank',
  lingering: 'Dickflüssiger Verweiltrank',
});

definePotion('awkward', null, '#3f6bb5', { base: NO_EFFECTS }, {
  drink: 'Seltsamer Trank',
  splash: 'Seltsamer Wurftrank',
  lingering: 'Seltsamer Verweiltrank',
});

/* -- the effect potions ---------------------------------------------------- */

definePotion('night_vision', 'der Nachtsicht', '#1f1fa1', {
  base: [pe(EFFECT.NIGHT_VISION, 0, 3600)],
  long: [pe(EFFECT.NIGHT_VISION, 0, 9600)],
});

definePotion('invisibility', 'der Unsichtbarkeit', '#7f8392', {
  base: [pe(EFFECT.INVISIBILITY, 0, 3600)],
  long: [pe(EFFECT.INVISIBILITY, 0, 9600)],
});

definePotion('leaping', 'der Sprungkraft', '#22ff4c', {
  base: [pe(EFFECT.JUMP_BOOST, 0, 3600)],
  long: [pe(EFFECT.JUMP_BOOST, 0, 9600)],
  strong: [pe(EFFECT.JUMP_BOOST, 1, 1800)],
});

definePotion('fire_resistance', 'der Feuerresistenz', '#e49a3a', {
  base: [pe(EFFECT.FIRE_RESISTANCE, 0, 3600)],
  long: [pe(EFFECT.FIRE_RESISTANCE, 0, 9600)],
});

definePotion('swiftness', 'der Schnelligkeit', '#7cafc6', {
  base: [pe(EFFECT.SPEED, 0, 3600)],
  long: [pe(EFFECT.SPEED, 0, 9600)],
  strong: [pe(EFFECT.SPEED, 1, 1800)],
});

definePotion('slowness', 'der Langsamkeit', '#5a6c81', {
  base: [pe(EFFECT.SLOWNESS, 0, 1800)],
  long: [pe(EFFECT.SLOWNESS, 0, 4800)],
  strong: [pe(EFFECT.SLOWNESS, 3, 400)],
});

definePotion('water_breathing', 'der Wasseratmung', '#2e5299', {
  base: [pe(EFFECT.WATER_BREATHING, 0, 3600)],
  long: [pe(EFFECT.WATER_BREATHING, 0, 9600)],
});

definePotion('healing', 'der Heilung', '#f82423', {
  base: [pe(EFFECT.INSTANT_HEALTH, 0, 0)],
  strong: [pe(EFFECT.INSTANT_HEALTH, 1, 0)],
});

definePotion('harming', 'des Schadens', '#430a09', {
  base: [pe(EFFECT.INSTANT_DAMAGE, 0, 0)],
  strong: [pe(EFFECT.INSTANT_DAMAGE, 1, 0)],
});

definePotion('poison', 'der Vergiftung', '#4e9331', {
  base: [pe(EFFECT.POISON, 0, 900)],
  long: [pe(EFFECT.POISON, 0, 1800)],
  strong: [pe(EFFECT.POISON, 1, 432)],
});

definePotion('regeneration', 'der Regeneration', '#cd5cab', {
  base: [pe(EFFECT.REGENERATION, 0, 900)],
  long: [pe(EFFECT.REGENERATION, 0, 1800)],
  strong: [pe(EFFECT.REGENERATION, 1, 440)],
});

definePotion('strength', 'der Stärke', '#932423', {
  base: [pe(EFFECT.STRENGTH, 0, 3600)],
  long: [pe(EFFECT.STRENGTH, 0, 9600)],
  strong: [pe(EFFECT.STRENGTH, 1, 1800)],
});

definePotion('weakness', 'der Schwäche', '#484d48', {
  base: [pe(EFFECT.WEAKNESS, 0, 1800)],
  long: [pe(EFFECT.WEAKNESS, 0, 4800)],
});

definePotion('slow_falling', 'des sanften Falls', '#f7f8e0', {
  base: [pe(EFFECT.SLOW_FALLING, 0, 1800)],
  long: [pe(EFFECT.SLOW_FALLING, 0, 4800)],
});

/** Every registered potion, in brewing order. @type {readonly PotionDef[]} */
export const POTIONS = Object.freeze(POTION_DEFS.slice());

/** Potion id -> {@link PotionDef}. @type {ReadonlyMap<string, PotionDef>} */
export const POTION_BY_NAME = POTION_BY_ID;

/**
 * Definition of a potion id.
 * @param {string} id potion id
 * @returns {?PotionDef} the definition, or `null`
 */
export function getPotion(id) {
  const def = POTION_BY_ID.get(id);
  return def === undefined ? null : def;
}

/* ========================================================================== */
/* German names — the encode/decode table                                     */
/* ========================================================================== */

/** German prefix per potion kind. @type {Readonly<Object<string, string>>} */
const KIND_PREFIX = Object.freeze({
  drink: 'Trank', splash: 'Wurftrank', lingering: 'Verweiltrank',
});

/** German suffix per variant. @type {Readonly<Object<string, string>>} */
const VARIANT_SUFFIX = Object.freeze({
  base: '', long: ' (verlängert)', strong: ' II',
});

/**
 * Full German display name of a `(potion, variant, kind)` triple. This name is
 * what a potion stack stores in `meta.name`, and it is the key
 * {@link readPotion} decodes.
 *
 * @param {string} potionId potion id
 * @param {string} [variant] `'base'|'long'|'strong'`
 * @param {string} [kind] `'drink'|'splash'|'lingering'`
 * @returns {string} the German name, `''` for an unknown potion
 */
export function potionDisplayName(potionId, variant = POTION_VARIANT.BASE, kind = POTION_KIND.DRINK) {
  const def = POTION_BY_ID.get(potionId);
  if (def === undefined) return '';
  if (def.nouns !== null) {
    const noun = def.nouns[kind];
    return noun === undefined ? def.nouns.drink : noun;
  }
  const prefix = KIND_PREFIX[kind] ?? KIND_PREFIX.drink;
  const suffix = VARIANT_SUFFIX[variant] ?? '';
  return `${prefix} ${def.genitive}${suffix}`;
}

/**
 * Display name -> the triple it encodes. Built once over every legal
 * combination, so decoding is one `Map.get` and can never mis-parse.
 * @type {Map<string, {potion:string, variant:string, kind:string}>}
 */
const NAME_TO_STATE = new Map();

for (let i = 0; i < POTION_DEFS.length; i++) {
  const def = POTION_DEFS[i];
  const variants = def.isBase ? [POTION_VARIANT.BASE] : Object.keys(def.variants);
  for (let v = 0; v < variants.length; v++) {
    for (const kind of [POTION_KIND.DRINK, POTION_KIND.SPLASH, POTION_KIND.LINGERING]) {
      const name = potionDisplayName(def.id, variants[v], kind);
      if (name === '' || NAME_TO_STATE.has(name)) continue;
      NAME_TO_STATE.set(name, Object.freeze({ potion: def.id, variant: variants[v], kind }));
    }
  }
}

/* ========================================================================== */
/* Potion state                                                               */
/* ========================================================================== */

/**
 * What a potion stack is.
 * @typedef {{potion:string, variant:string, kind:string}} PotionState
 */

/** Item id every potion stack uses. @type {number} */
export const POTION_ITEM = I.GLASS_BOTTLE;

/** The plain water bottle, brewing's starting point. @type {Readonly<PotionState>} */
export const WATER_BOTTLE = Object.freeze({
  potion: 'water', variant: POTION_VARIANT.BASE, kind: POTION_KIND.DRINK,
});

/**
 * Duration multiplier of a potion kind.
 * @param {string} kind `'drink'|'splash'|'lingering'`
 * @returns {number} multiplier applied to every non-instant duration
 */
export function kindDurationScale(kind) {
  if (kind === POTION_KIND.SPLASH) return SPLASH_DURATION_SCALE;
  if (kind === POTION_KIND.LINGERING) return LINGERING_DURATION_SCALE;
  return 1;
}

/**
 * The effects a potion state grants, with the kind's duration scale already
 * applied. The returned array is freshly allocated, so callers may keep it.
 *
 * @param {?PotionState} state the potion
 * @returns {PotionEffect[]} effect list (empty for the four bases)
 */
export function potionEffects(state) {
  /** @type {PotionEffect[]} */
  const out = [];
  if (state === null || state === undefined) return out;
  const def = POTION_BY_ID.get(state.potion);
  if (def === undefined) return out;
  const list = def.variants[state.variant] ?? def.variants.base;
  if (list === undefined) return out;
  const scale = kindDurationScale(state.kind);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const effectDef = getEffect(e.id);
    const instant = effectDef !== null && effectDef.instant;
    out.push({
      id: e.id,
      amplifier: e.amplifier,
      duration: instant ? 0 : Math.max(1, Math.round(e.duration * scale)),
    });
  }
  return out;
}

/**
 * Tooltip colour of a potion.
 * @param {?PotionState} state the potion
 * @returns {string} a `#rrggbb` string
 */
export function potionColor(state) {
  if (state === null || state === undefined) return '#385dc6';
  const def = POTION_BY_ID.get(state.potion);
  return def === undefined ? '#385dc6' : def.hex;
}

/**
 * Particle colour of a potion, as `[r, g, b]` floats.
 * @param {?PotionState} state the potion
 * @returns {readonly number[]} `[r, g, b]` in `0..1`
 */
export function potionParticleColor(state) {
  const effects = potionEffects(state);
  if (effects.length > 0) return effectParticleColor(effects[0].id);
  const hex = potionColor(state);
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * The German tooltip lines of a potion: one per effect, plus a hint line for
 * the effect-less bases.
 * @param {?PotionState} state the potion
 * @returns {string[]} freshly allocated lore lines
 */
export function potionLore(state) {
  /** @type {string[]} */
  const out = [];
  const effects = potionEffects(state);
  if (effects.length === 0) {
    if (state !== null && state !== undefined && state.potion === 'awkward') {
      out.push('Basis für alle Wirkungstränke');
    } else {
      out.push('Keine Wirkung');
    }
    return out;
  }
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    const roman = romanLevel(e.amplifier);
    const name = roman === '' ? effectDisplay(e.id) : `${effectDisplay(e.id)} ${roman}`;
    out.push(e.duration > 0 ? `${name} · ${formatTicks(e.duration)}` : name);
  }
  if (state !== null && state !== undefined && state.kind === POTION_KIND.SPLASH) {
    out.push('Wirft und trifft alles im Umkreis');
  } else if (state !== null && state !== undefined && state.kind === POTION_KIND.LINGERING) {
    out.push('Hinterlässt eine Wolke');
  }
  return out;
}

/**
 * Build a potion stack.
 * @param {string} potionId potion id
 * @param {string} [variant] `'base'|'long'|'strong'`
 * @param {string} [kind] `'drink'|'splash'|'lingering'`
 * @param {number} [count] stack size
 * @returns {?ItemStack} the stack, or `null` for an unknown potion
 */
export function makePotionStack(potionId, variant = POTION_VARIANT.BASE,
  kind = POTION_KIND.DRINK, count = 1) {
  const def = POTION_BY_ID.get(potionId);
  if (def === undefined) {
    warnOnce(`potion:${potionId}`, `unknown potion "${potionId}"`);
    return null;
  }
  const realVariant = def.variants[variant] === undefined ? POTION_VARIANT.BASE : variant;
  const state = { potion: potionId, variant: def.isBase ? POTION_VARIANT.BASE : realVariant, kind };
  const stack = new ItemStack(POTION_ITEM, Math.max(1, count | 0), null);
  const meta = stack.ensureMeta();
  meta.durability = -1;
  meta.name = potionDisplayName(state.potion, state.variant, state.kind);
  meta.lore = potionLore(state);
  return stack;
}

/**
 * A fresh water bottle — what filling a glass bottle at water yields.
 * @param {number} [count] stack size
 * @returns {ItemStack} the water bottle
 */
export function makeWaterBottle(count = 1) {
  return /** @type {ItemStack} */ (makePotionStack('water', POTION_VARIANT.BASE,
    POTION_KIND.DRINK, count));
}

/**
 * An empty glass bottle — what is left after drinking.
 * @param {number} [count] stack size
 * @returns {ItemStack} the empty bottle
 */
export function makeEmptyBottle(count = 1) {
  return new ItemStack(POTION_ITEM, Math.max(1, count | 0), null);
}

/**
 * Read the potion a stack represents.
 * @param {?ItemStack} stack candidate stack
 * @returns {?PotionState} the state, or `null` when the stack is not a potion
 */
export function readPotion(stack) {
  if (stack === null || stack === undefined) return null;
  if (stack.itemId !== POTION_ITEM) return null;
  if (typeof stack.isEmpty === 'function' && stack.isEmpty()) return null;
  const meta = stack.meta;
  if (meta === null || meta === undefined || typeof meta.name !== 'string') return null;
  const state = NAME_TO_STATE.get(meta.name);
  return state === undefined ? null : state;
}

/**
 * Is this stack a potion (as opposed to an empty glass bottle)?
 * @param {?ItemStack} stack candidate stack
 * @returns {boolean} `true` for any potion
 */
export function isPotion(stack) {
  return readPotion(stack) !== null;
}

/**
 * Is this stack an empty glass bottle that could be filled with water?
 * @param {?ItemStack} stack candidate stack
 * @returns {boolean} `true` for a plain glass bottle
 */
export function isEmptyBottle(stack) {
  if (stack === null || stack === undefined) return false;
  if (stack.itemId !== POTION_ITEM) return false;
  if (typeof stack.isEmpty === 'function' && stack.isEmpty()) return false;
  return readPotion(stack) === null;
}

/**
 * Is this potion thrown rather than drunk?
 * @param {?ItemStack} stack candidate stack
 * @returns {boolean} `true` for splash and lingering potions
 */
export function isThrowable(stack) {
  const state = readPotion(stack);
  return state !== null && state.kind !== POTION_KIND.DRINK;
}

/* ========================================================================== */
/* The recipe graph                                                           */
/* ========================================================================== */

/**
 * Water + X. Mirrors vanilla: the useless-but-legal bases plus nether wart.
 * @type {Readonly<Object<string, string>>}
 */
const WATER_RECIPES = Object.freeze({
  nether_wart: 'awkward',
  glowstone_dust: 'thick',
  redstone: 'mundane',
  sugar: 'mundane',
  spider_eye: 'mundane',
  ghast_tear: 'mundane',
  magma_cream: 'mundane',
  blaze_powder: 'mundane',
  golden_carrot: 'mundane',
  rabbit_foot: 'mundane',
  pufferfish: 'mundane',
  phantom_membrane: 'mundane',
  glistering_melon_slice: 'mundane',
});

/**
 * Awkward potion + X -> the effect potion.
 * @type {Readonly<Object<string, string>>}
 */
const EFFECT_RECIPES = Object.freeze({
  golden_carrot: 'night_vision',
  rabbit_foot: 'leaping',
  magma_cream: 'fire_resistance',
  sugar: 'swiftness',
  pufferfish: 'water_breathing',
  glistering_melon_slice: 'healing',
  spider_eye: 'poison',
  ghast_tear: 'regeneration',
  blaze_powder: 'strength',
  phantom_membrane: 'slow_falling',
});

/**
 * Fermented spider eye turns a potion into its opposite.
 * @type {Readonly<Object<string, string>>}
 */
const CORRUPTION = Object.freeze({
  water: 'weakness',
  mundane: 'weakness',
  thick: 'weakness',
  awkward: 'weakness',
  night_vision: 'invisibility',
  swiftness: 'slowness',
  leaping: 'slowness',
  healing: 'harming',
  poison: 'harming',
  strength: 'weakness',
});

/**
 * Logical ingredient -> modifier kind.
 * @type {Readonly<Object<string, string>>}
 */
const MODIFIER_BY_INGREDIENT = Object.freeze({
  redstone: MODIFIER.EXTEND,
  glowstone_dust: MODIFIER.AMPLIFY,
  gunpowder: MODIFIER.SPLASH,
  dragon_breath: MODIFIER.LINGER,
  fermented_spider_eye: MODIFIER.CORRUPT,
});

/**
 * Modifier kind an item acts as, if any.
 * @param {number} itemId item id
 * @returns {?string} a {@link MODIFIER} value, or `null`
 */
export function modifierOf(itemId) {
  const logical = ingredientName(itemId);
  if (logical === null) return null;
  const mod = MODIFIER_BY_INGREDIENT[logical];
  return mod === undefined ? null : mod;
}

/**
 * Could this item ever go into the ingredient slot?
 * @param {number} itemId item id
 * @returns {boolean} `true` for every recognised ingredient or modifier
 */
export function isBrewingIngredient(itemId) {
  return ingredientName(itemId) !== null;
}

/**
 * Is this item brewing-stand fuel?
 * @param {number} itemId item id
 * @returns {boolean} `true` for blaze powder
 */
export function isBrewingFuel(itemId) {
  return itemId > 0 && itemId === ingredientItem('blaze_powder');
}

/**
 * Pick the variant a corrupted potion should land on.
 * @param {PotionDef} target the corrupted potion
 * @param {string} variant the source variant
 * @returns {string} a variant the target actually has
 */
function carryVariant(target, variant) {
  if (target.variants[variant] !== undefined) return variant;
  return POTION_VARIANT.BASE;
}

/**
 * Resolve one brewing step.
 *
 * The order below is what makes the vanilla graph fall out naturally: a
 * modifier that cannot apply to the current potion drops through to the plain
 * ingredient tables, which is exactly why water + redstone is a mundane potion
 * and water + glowstone is a thick one.
 *
 * @param {?PotionState} input the potion currently in the bottle slot
 * @param {number} ingredientItemId item in the ingredient slot
 * @returns {?PotionState} the resulting potion, or `null` when nothing brews
 */
export function brewResult(input, ingredientItemId) {
  if (input === null || input === undefined) return null;
  const def = POTION_BY_ID.get(input.potion);
  if (def === undefined) return null;
  const logical = ingredientName(ingredientItemId | 0);
  if (logical === null) return null;

  const modifier = MODIFIER_BY_INGREDIENT[logical];

  if (modifier === MODIFIER.SPLASH) {
    if (input.kind !== POTION_KIND.DRINK) return null;
    return { potion: input.potion, variant: input.variant, kind: POTION_KIND.SPLASH };
  }

  if (modifier === MODIFIER.LINGER) {
    if (input.kind !== POTION_KIND.SPLASH) return null;
    return { potion: input.potion, variant: input.variant, kind: POTION_KIND.LINGERING };
  }

  if (modifier === MODIFIER.CORRUPT) {
    const targetId = CORRUPTION[input.potion];
    if (targetId === undefined) return null;
    const target = POTION_BY_ID.get(targetId);
    if (target === undefined) return null;
    return {
      potion: targetId,
      variant: carryVariant(target, input.variant),
      kind: input.kind,
    };
  }

  if (modifier === MODIFIER.EXTEND && def.variants.long !== undefined
    && input.variant !== POTION_VARIANT.LONG) {
    return { potion: input.potion, variant: POTION_VARIANT.LONG, kind: input.kind };
  }

  if (modifier === MODIFIER.AMPLIFY && def.variants.strong !== undefined
    && input.variant !== POTION_VARIANT.STRONG) {
    return { potion: input.potion, variant: POTION_VARIANT.STRONG, kind: input.kind };
  }

  if (input.potion === 'water' && input.variant === POTION_VARIANT.BASE) {
    const targetId = WATER_RECIPES[logical];
    if (targetId === undefined) return null;
    return { potion: targetId, variant: POTION_VARIANT.BASE, kind: input.kind };
  }

  if (input.potion === 'awkward') {
    const targetId = EFFECT_RECIPES[logical];
    if (targetId === undefined) return null;
    return { potion: targetId, variant: POTION_VARIANT.BASE, kind: input.kind };
  }

  return null;
}

/**
 * Resolve one brewing step on a whole stack.
 * @param {?ItemStack} bottle the stack in a bottle slot
 * @param {?ItemStack} ingredient the stack in the ingredient slot
 * @returns {?ItemStack} the brewed stack, or `null` when nothing brews
 */
export function brewStack(bottle, ingredient) {
  if (bottle === null || ingredient === null || ingredient === undefined) return null;
  if (typeof ingredient.isEmpty === 'function' && ingredient.isEmpty()) return null;
  const state = readPotion(bottle);
  if (state === null) return null;
  const result = brewResult(state, ingredient.itemId);
  if (result === null) return null;
  return makePotionStack(result.potion, result.variant, result.kind, bottle.count);
}

/* ========================================================================== */
/* Drinking                                                                   */
/* ========================================================================== */

/**
 * Drink a potion: apply its effects and hand back the empty bottle.
 *
 * Splash and lingering potions are not drinkable — {@link throwPotion} handles
 * those — so this returns `applied: false` for them.
 *
 * @param {?ItemStack} stack the potion stack (its count is **not** changed)
 * @param {?Object} target the entity that drinks
 * @param {Object} [ctx] wiring
 * @param {?Object} [ctx.effects] the {@link EffectManager}
 * @param {?Object} [ctx.audio] the audio engine
 * @param {?Object} [ctx.particles] the particle system
 * @returns {{applied:boolean, leftover:?ItemStack, state:?PotionState}}
 *   `leftover` is the empty glass bottle to give back
 */
export function drinkPotion(stack, target, ctx = {}) {
  const state = readPotion(stack);
  if (state === null || target === null || target === undefined) {
    return { applied: false, leftover: null, state: null };
  }
  if (state.kind !== POTION_KIND.DRINK) {
    return { applied: false, leftover: null, state };
  }

  const effects = ctx.effects || null;
  const list = potionEffects(state);
  if (effects !== null && typeof effects.add === 'function') {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      try {
        effects.add(target, e.id, e.amplifier, e.duration > 0 ? e.duration : undefined);
      } catch (err) {
        warnOnce(`drink:${e.id}`, 'a potion effect could not be applied', err);
      }
    }
  }

  const p = target.position;
  if (ctx.audio && typeof ctx.audio.play === 'function' && p && p.length >= 3) {
    try {
      ctx.audio.play('drink', { x: p[0], y: p[1] + 1.2, z: p[2], volume: 0.8 });
    } catch (err) {
      warnOnce('drink:audio', 'the drinking sound failed', err);
    }
  }
  if (ctx.particles && typeof ctx.particles.spawn === 'function' && p && p.length >= 3) {
    try {
      ctx.particles.spawn('dust', p[0], p[1] + 1.3, p[2], {
        count: 6, color: potionParticleColor(state), speed: 0.7, life: 0.7,
      });
    } catch (err) {
      warnOnce('drink:particles', 'the drinking particles failed', err);
    }
  }

  return { applied: true, leftover: makeEmptyBottle(1), state };
}

/* ========================================================================== */
/* Splash potions                                                             */
/* ========================================================================== */

/**
 * Apply a splash potion's effects to everything inside {@link SPLASH_RADIUS},
 * with the vanilla linear distance falloff.
 *
 * @param {PotionState} state the potion that shattered
 * @param {number} x impact world X
 * @param {number} y impact world Y
 * @param {number} z impact world Z
 * @param {Object} [ctx] wiring
 * @param {?Object} [ctx.effects] the {@link EffectManager}
 * @param {?Object} [ctx.manager] the entity manager, for the radius query
 * @param {?Object} [ctx.player] the local player (queried separately)
 * @param {?Object} [ctx.particles] the particle system
 * @param {?Object} [ctx.audio] the audio engine
 * @param {number} [ctx.radius] override for {@link SPLASH_RADIUS}
 * @returns {number} how many entities were affected
 */
export function applySplash(state, x, y, z, ctx = {}) {
  if (state === null || state === undefined) return 0;
  const effects = ctx.effects || null;
  const radius = Math.max(0.5, num(ctx.radius, SPLASH_RADIUS));
  const list = potionEffects(state);

  if (ctx.particles && typeof ctx.particles.spawn === 'function') {
    try {
      ctx.particles.spawn('dust', x, y, z, {
        count: 28, color: potionParticleColor(state), speed: 3.4, spread: 0.6, life: 1.1,
      });
    } catch (err) {
      warnOnce('splash:particles', 'splash particles failed', err);
    }
  }
  if (ctx.audio && typeof ctx.audio.play === 'function') {
    try {
      ctx.audio.play('splash', { x, y, z, volume: 0.9, pitch: 1.1 });
    } catch (err) {
      warnOnce('splash:audio', 'the splash sound failed', err);
    }
  }
  if (effects === null || typeof effects.add !== 'function' || list.length === 0) return 0;

  let hits = 0;
  const targets = SPLASH_SCRATCH;
  targets.length = 0;

  const manager = ctx.manager || null;
  if (manager !== null && typeof manager.queryRadius === 'function') {
    try {
      manager.queryRadius(x, y, z, radius, targets);
    } catch (err) {
      warnOnce('splash:query', 'the splash radius query failed', err);
      targets.length = 0;
    }
  }
  const player = ctx.player || null;
  if (player !== null && targets.indexOf(player) < 0) targets.push(player);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (target === null || target === undefined) continue;
    if (target.removed === true || target.dead === true) continue;
    const p = target.position;
    if (!p || p.length < 3) continue;
    // Measure to the middle of the body, like vanilla does.
    const cy = p[1] + num(target.height, 1.8) * 0.5;
    const dx = p[0] - x;
    const dy = cy - y;
    const dz = p[2] - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > radius) continue;
    const potency = clamp(1 - dist / radius, 0, 1);
    if (potency <= 0.02) continue;

    let touched = false;
    for (let e = 0; e < list.length; e++) {
      const fx = list[e];
      try {
        const applied = fx.duration > 0
          ? effects.add(target, fx.id, fx.amplifier, fx.duration, { potency })
          : effects.add(target, fx.id, fx.amplifier, undefined, { potency });
        if (applied) touched = true;
      } catch (err) {
        warnOnce(`splash:${fx.id}`, 'a splash effect could not be applied', err);
      }
    }
    if (touched) hits++;
  }
  targets.length = 0;
  return hits;
}

/** Scratch list reused by {@link applySplash}. @type {Object[]} */
const SPLASH_SCRATCH = [];

/**
 * A thrown potion in flight.
 *
 * Flies on the classic potion arc (20 blocks/s² of gravity), shatters on the
 * first solid block or entity it touches and hands the impact over to
 * {@link applySplash}.
 */
export class SplashPotionEntity extends Entity {
  /**
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {Object} [opts] launch options
   * @param {?PotionState} [opts.state] the potion being thrown
   * @param {ArrayLike<number>} [opts.velocity] initial velocity in blocks/s
   * @param {number} [opts.ownerId] entity id of the thrower
   */
  constructor(x, y, z, opts = {}) {
    super('splash_potion', x, y, z);
    this.setSize(0.25, 0.25);

    this.health = 1;
    this.maxHealth = 1;
    this.gravityScale = 0.625;
    this.drag = 0.01;
    this.dragY = 0.01;
    this.noPush = true;
    this.fireProof = true;

    /** @type {PotionState} The potion this projectile carries. */
    this.state = normalizeState(opts.state);
    /** @type {number} Entity id of the thrower; it cannot be hit immediately. */
    this.ownerId = num(opts.ownerId, 0) | 0;
    /** @type {boolean} `true` once the bottle has shattered. */
    this.shattered = false;

    const v = opts.velocity;
    if (v && v.length >= 3) {
      this.velocity[0] = num(v[0], 0);
      this.velocity[1] = num(v[1], 0);
      this.velocity[2] = num(v[2], 0);
    }
    this._updateRotation();
  }

  /**
   * Point the model along the flight path.
   * @returns {void}
   * @private
   */
  _updateRotation() {
    const v = this.velocity;
    const horiz = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
    if (horiz > 1e-4 || Math.abs(v[1]) > 1e-4) {
      this.rotation[0] = Math.atan2(v[0], -v[2]);
      this.rotation[1] = Math.atan2(v[1], horiz);
    }
  }

  /**
   * @param {number} dt elapsed seconds
   * @param {Object} world the World
   * @param {Object} [ctx] shared context from the entity manager
   * @returns {void}
   */
  update(dt, world, ctx) {
    this.prevPosition.set(this.position);
    if (this.removed) return;
    const step = clamp(num(dt, 0), 0, 0.25);
    this.age += step;

    const v = this.velocity;
    applyGravity(v, step, GRAVITY * this.gravityScale, TERMINAL_VELOCITY);
    applyDrag(v, step, this.drag, this.dragY);

    const dx = v[0] * step;
    const dy = v[1] * step;
    const dz = v[2] * step;
    const travel = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // March in sub-steps so a fast bottle cannot tunnel through a wall.
    const steps = Math.max(1, Math.min(8, Math.ceil(travel / 0.4)));
    const sx = dx / steps;
    const sy = dy / steps;
    const sz = dz / steps;

    for (let i = 0; i < steps; i++) {
      this.position[0] += sx;
      this.position[1] += sy;
      this.position[2] += sz;
      this.syncAABB();
      if (this._hitsBlock(world) || this._hitsEntity(ctx)) {
        this.shatter(ctx);
        return;
      }
    }

    this._updateRotation();
    if (this.age > THROW_MAX_AGE || this.position[1] < -128) this.remove('despawn');
  }

  /**
   * Did the bottle enter a solid block?
   * @param {?Object} world the World
   * @returns {boolean} `true` on contact
   * @private
   */
  _hitsBlock(world) {
    if (!world || typeof world.getBlock !== 'function') return false;
    try {
      const id = world.getBlock(
        Math.floor(this.position[0]),
        Math.floor(this.position[1]),
        Math.floor(this.position[2]),
      );
      return id > 0 && isSolid(id);
    } catch (err) {
      warnOnce('splash:block', 'a block probe failed', err);
      return false;
    }
  }

  /**
   * Did the bottle touch a living entity?
   * @param {Object} [ctx] shared context
   * @returns {boolean} `true` on contact
   * @private
   */
  _hitsEntity(ctx) {
    const manager = this.manager;
    if (manager === null || typeof manager.queryRadius !== 'function') return false;
    const player = ctx && ctx.player ? ctx.player : null;
    if (player !== null && player.position && this.age > 0.25) {
      const dx = player.position[0] - this.position[0];
      const dy = player.position[1] + num(player.height, 1.8) * 0.5 - this.position[1];
      const dz = player.position[2] - this.position[2];
      if (dx * dx + dy * dy + dz * dz < 0.7 * 0.7) return true;
    }
    const list = HIT_SCRATCH;
    list.length = 0;
    try {
      manager.queryRadius(this.position[0], this.position[1], this.position[2], 0.9, list);
    } catch (err) {
      warnOnce('splash:sweep', 'the projectile sweep failed', err);
      list.length = 0;
      return false;
    }
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e === this || e.removed || e.dead) continue;
      if (e.type === 'item' || e.type === 'xp_orb' || e.type === 'arrow'
        || e.type === 'splash_potion') continue;
      if (e.id === this.ownerId && this.age < 0.25) continue;
      list.length = 0;
      return true;
    }
    list.length = 0;
    return false;
  }

  /**
   * Break the bottle and apply the cloud.
   * @param {Object} [ctx] shared context
   * @returns {void}
   */
  shatter(ctx) {
    if (this.shattered) return;
    this.shattered = true;
    this.remove('splashed');
    try {
      applySplash(this.state, this.position[0], this.position[1], this.position[2], {
        effects: ctx && ctx.effects ? ctx.effects : (this.manager && this.manager.effects) || null,
        manager: this.manager,
        player: ctx && ctx.player ? ctx.player : null,
        particles: ctx && ctx.particles ? ctx.particles : null,
        audio: ctx && ctx.audio ? ctx.audio : null,
        radius: this.state.kind === POTION_KIND.LINGERING ? SPLASH_RADIUS * 0.75 : SPLASH_RADIUS,
      });
    } catch (err) {
      warnOnce('splash:apply', 'the splash could not be applied', err);
    }
  }

  /**
   * @returns {Object} save record
   */
  serialize() {
    const out = this.writeBaseState({});
    out.potion = this.state.potion;
    out.variant = this.state.variant;
    out.kind = this.state.kind;
    out.owner = this.ownerId;
    return out;
  }

  /**
   * @param {Object} o save record
   * @returns {?SplashPotionEntity} the restored projectile
   */
  static deserialize(o) {
    if (!o || typeof o !== 'object') return null;
    const p = Array.isArray(o.p) ? o.p : [0, 0, 0];
    const e = new SplashPotionEntity(num(p[0], 0), num(p[1], 0), num(p[2], 0), {
      state: {
        potion: typeof o.potion === 'string' ? o.potion : 'water',
        variant: typeof o.variant === 'string' ? o.variant : POTION_VARIANT.BASE,
        kind: typeof o.kind === 'string' ? o.kind : POTION_KIND.SPLASH,
      },
      ownerId: num(o.owner, 0),
    });
    e.readBaseState(o);
    return e;
  }
}

registerEntityClass('splash_potion', SplashPotionEntity);

/** Scratch list reused by {@link SplashPotionEntity#_hitsEntity}. @type {Object[]} */
const HIT_SCRATCH = [];

/**
 * Clamp any input into a legal {@link PotionState}.
 * @param {*} raw candidate state
 * @returns {PotionState} a state that always resolves
 */
function normalizeState(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { potion: 'water', variant: POTION_VARIANT.BASE, kind: POTION_KIND.SPLASH };
  }
  const def = POTION_BY_ID.get(raw.potion);
  if (def === undefined) {
    return { potion: 'water', variant: POTION_VARIANT.BASE, kind: POTION_KIND.SPLASH };
  }
  const variant = def.variants[raw.variant] === undefined ? POTION_VARIANT.BASE : raw.variant;
  const kind = raw.kind === POTION_KIND.LINGERING ? POTION_KIND.LINGERING : POTION_KIND.SPLASH;
  return { potion: def.id, variant, kind };
}

/**
 * Throw a splash or lingering potion from an entity's eyes.
 *
 * @param {?ItemStack} stack the potion stack (its count is **not** changed)
 * @param {?Object} thrower the entity throwing it (player or mob)
 * @param {Object} [ctx] wiring
 * @param {?Object} [ctx.entities] the entity manager (required to spawn)
 * @param {?Object} [ctx.audio] the audio engine
 * @param {number} [ctx.speed] launch speed in blocks/s
 * @returns {?SplashPotionEntity} the projectile, or `null` when nothing was thrown
 */
export function throwPotion(stack, thrower, ctx = {}) {
  const state = readPotion(stack);
  if (state === null || state.kind === POTION_KIND.DRINK) return null;
  if (thrower === null || thrower === undefined) return null;
  const manager = ctx.entities || null;
  if (manager === null || typeof manager.spawn !== 'function') return null;

  const p = thrower.position;
  if (!p || p.length < 3) return null;
  const eye = p[1] + num(thrower.eyeHeight, num(thrower.height, 1.8) * 0.9);

  let dx = 0;
  let dy = -0.35;
  let dz = -1;
  if (typeof thrower.getLookDirection === 'function') {
    try {
      const dir = thrower.getLookDirection();
      if (dir && dir.length >= 3) {
        dx = num(dir[0], 0);
        dy = num(dir[1], 0) - 0.32; // vanilla throws slightly below the crosshair
        dz = num(dir[2], -1);
      }
    } catch (err) {
      warnOnce('throw:look', 'the look direction could not be read', err);
    }
  } else {
    const yaw = num(thrower.yaw, 0);
    const pitch = num(thrower.pitch, 0);
    const cp = Math.cos(pitch);
    dx = -Math.sin(yaw) * cp;
    dy = Math.sin(pitch) - 0.32;
    dz = -Math.cos(yaw) * cp;
  }
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const speed = Math.max(1, num(ctx.speed, THROW_SPEED));

  const potion = new SplashPotionEntity(
    p[0] + (dx / len) * 0.3,
    eye - 0.1,
    p[2] + (dz / len) * 0.3,
    {
      state,
      ownerId: num(thrower.id, 0),
      velocity: [(dx / len) * speed, (dy / len) * speed, (dz / len) * speed],
    },
  );
  manager.spawn(potion);

  if (ctx.audio && typeof ctx.audio.play === 'function') {
    try {
      ctx.audio.play('toss', { x: p[0], y: eye, z: p[2], volume: 0.7, pitch: 1.15 });
    } catch (err) {
      warnOnce('throw:audio', 'the throw sound failed', err);
    }
  }
  return potion;
}

/* ========================================================================== */
/* BrewingStand                                                               */
/* ========================================================================== */

/**
 * The block entity behind a brewing stand.
 *
 * Five slots: three bottles, one ingredient, one fuel. Because it extends
 * {@link Inventory} the whole inventory UI — drag, split, shift-click — works
 * on it with no special case, and `canPlaceIn`/`slotLimit` keep the slots
 * honest (one bottle each, fuel only takes blaze powder).
 *
 * Emits `'brewing'` `(stand)` whenever the progress or the fuel changed, on
 * top of the `'change'` event {@link Inventory} already fires.
 *
 * @augments Inventory
 */
export class BrewingStand extends Inventory {
  /**
   * @param {Object} [opts] configuration
   * @param {number} [opts.x] block X of the stand
   * @param {number} [opts.y] block Y
   * @param {number} [opts.z] block Z
   */
  constructor(opts = {}) {
    super(BREW_SLOT_COUNT, {
      title: 'Braustand',
      storageStart: BREW_SLOT.BOTTLE_0,
      storageEnd: BREW_SLOT.BOTTLE_2,
    });

    /** @type {string} Container kind, for the inventory UI. */
    this.kind = 'brewing_stand';
    /** @type {number} UI grid columns. */
    this.cols = 3;
    /** @type {number} UI grid rows. */
    this.rows = 2;
    /** @type {number} Block X, `NaN` when the stand is not placed. */
    this.x = Number.isFinite(opts.x) ? opts.x | 0 : NaN;
    /** @type {number} Block Y. */
    this.y = Number.isFinite(opts.y) ? opts.y | 0 : NaN;
    /** @type {number} Block Z. */
    this.z = Number.isFinite(opts.z) ? opts.z | 0 : NaN;
    /** @type {number} How many screens currently show this stand. */
    this.viewers = 0;

    /** @type {number} Ticks left on the running brew (`0` = idle). */
    this.brewTime = 0;
    /** @type {number} Brews left in the fuel bar. */
    this.fuel = 0;
    /** @type {number} Fuel bar size the last blaze powder gave. */
    this.fuelTotal = FUEL_USES;
    /** @type {number} Ticks owed by {@link BrewingManager} but not yet run. */
    this.pendingTicks = 0;
  }

  /** @returns {number} brewing progress `0..1` for the UI arrow */
  get progress() {
    if (this.brewTime <= 0) return 0;
    return clamp((BREW_TIME - this.brewTime) / BREW_TIME, 0, 1);
  }

  /** @returns {number} fuel bar fill `0..1` */
  get fuelProgress() {
    return this.fuelTotal > 0 ? clamp(this.fuel / this.fuelTotal, 0, 1) : 0;
  }

  /** @returns {boolean} `true` while a brew is running */
  get brewing() {
    return this.brewTime > 0;
  }

  /**
   * Bottle slots hold one item, the other two hold a full stack.
   * @param {number} i slot index
   * @param {?ItemStack} [stack] the stack being placed
   * @returns {number} the per-slot cap
   */
  slotLimit(i, stack = null) {
    if (i >= BREW_SLOT.BOTTLE_0 && i <= BREW_SLOT.BOTTLE_2) return 1;
    return super.slotLimit(i, stack);
  }

  /**
   * Bottle slots take bottles and potions, the ingredient slot takes known
   * ingredients, the fuel slot takes blaze powder.
   * @param {number} i slot index
   * @param {?ItemStack} stack the stack about to be placed
   * @returns {boolean} `true` when the slot accepts the stack
   */
  canPlaceIn(i, stack) {
    if (!super.canPlaceIn(i, stack)) return false;
    if (i >= BREW_SLOT.BOTTLE_0 && i <= BREW_SLOT.BOTTLE_2) {
      return stack.itemId === POTION_ITEM;
    }
    if (i === BREW_SLOT.INGREDIENT) return isBrewingIngredient(stack.itemId);
    if (i === BREW_SLOT.FUEL) return isBrewingFuel(stack.itemId);
    return false;
  }

  /**
   * Shift-click insertion: fuel to the fuel slot, ingredients to the
   * ingredient slot, bottles into the first free bottle slot.
   * @param {?ItemStack} stack stack to insert (not mutated)
   * @returns {?ItemStack} leftover, or `null`
   */
  quickInsert(stack) {
    if (stack === null || stack === undefined || stack.isEmpty()) return null;
    if (isBrewingFuel(stack.itemId)) return this.addAt(BREW_SLOT.FUEL, stack);
    if (stack.itemId === POTION_ITEM) {
      let rest = stack;
      for (let i = BREW_SLOT.BOTTLE_0; i <= BREW_SLOT.BOTTLE_2 && rest !== null; i++) {
        rest = this.addAt(i, rest);
      }
      return rest;
    }
    if (isBrewingIngredient(stack.itemId)) return this.addAt(BREW_SLOT.INGREDIENT, stack);
    return stack.clone();
  }

  /* -- viewers ------------------------------------------------------------- */

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

  /* -- simulation ---------------------------------------------------------- */

  /**
   * Would at least one bottle change if the brew finished right now?
   * @returns {boolean} `true` when a brew is possible
   */
  canBrew() {
    const ingredient = this.slots[BREW_SLOT.INGREDIENT];
    if (ingredient === null || ingredient.isEmpty()) return false;
    for (let i = BREW_SLOT.BOTTLE_0; i <= BREW_SLOT.BOTTLE_2; i++) {
      const bottle = this.slots[i];
      if (bottle === null) continue;
      const state = readPotion(bottle);
      if (state === null) continue;
      if (brewResult(state, ingredient.itemId) !== null) return true;
    }
    return false;
  }

  /**
   * Advance the stand by whole game ticks. Safe to call with `0`.
   * @param {number} [ticks] number of 50 ms ticks to simulate
   * @returns {boolean} `true` when anything changed (so the UI can repaint)
   */
  tick(ticks = 1) {
    const steps = Math.max(0, ticks | 0);
    if (steps === 0) return false;
    let changed = false;

    if (this.fuel <= 0) {
      const fuelStack = this.slots[BREW_SLOT.FUEL];
      if (fuelStack !== null && isBrewingFuel(fuelStack.itemId) && this.canBrew()) {
        const prev = fuelStack.clone();
        fuelStack.count -= 1;
        if (fuelStack.count <= 0) this.slots[BREW_SLOT.FUEL] = null;
        this._changed(BREW_SLOT.FUEL, prev);
        this.fuel = FUEL_USES;
        this.fuelTotal = FUEL_USES;
        changed = true;
      }
    }

    const possible = this.canBrew();

    if (this.brewTime > 0) {
      if (!possible) {
        this.brewTime = 0;
        changed = true;
      } else {
        this.brewTime -= steps;
        changed = true;
        if (this.brewTime <= 0) {
          this.brewTime = 0;
          this._finishBrew();
        }
      }
    } else if (possible && this.fuel > 0) {
      this.fuel -= 1;
      this.brewTime = BREW_TIME;
      changed = true;
    }

    if (changed) this.emit('brewing', this);
    return changed;
  }

  /**
   * Transform every bottle the ingredient works on and eat one ingredient.
   * @returns {void}
   * @private
   */
  _finishBrew() {
    const ingredient = this.slots[BREW_SLOT.INGREDIENT];
    if (ingredient === null || ingredient.isEmpty()) return;

    let brewed = false;
    this.beginBatch();
    for (let i = BREW_SLOT.BOTTLE_0; i <= BREW_SLOT.BOTTLE_2; i++) {
      const bottle = this.slots[i];
      if (bottle === null) continue;
      const state = readPotion(bottle);
      if (state === null) continue;
      const result = brewResult(state, ingredient.itemId);
      if (result === null) continue;
      const next = makePotionStack(result.potion, result.variant, result.kind, bottle.count);
      if (next === null) continue;
      const prev = bottle;
      this.slots[i] = next;
      this._changed(i, prev);
      brewed = true;
    }

    if (brewed) {
      const prev = ingredient.clone();
      ingredient.count -= 1;
      if (ingredient.count <= 0) this.slots[BREW_SLOT.INGREDIENT] = null;
      this._changed(BREW_SLOT.INGREDIENT, prev);
    }
    this.endBatch();
    this.emit('brewed', this);
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
      brewTime: this.brewTime,
      fuel: this.fuel,
      fuelTotal: this.fuelTotal,
    };
  }

  /**
   * @param {?Object} o save record
   * @returns {BrewingStand} `this`
   */
  deserialize(o) {
    super.deserialize(o);
    if (o === null || o === undefined) return this;
    if (Number.isFinite(o.x)) this.x = o.x | 0;
    if (Number.isFinite(o.y)) this.y = o.y | 0;
    if (Number.isFinite(o.z)) this.z = o.z | 0;
    this.brewTime = clamp(num(o.brewTime, 0) | 0, 0, BREW_TIME);
    this.fuelTotal = Math.max(1, num(o.fuelTotal, FUEL_USES) | 0);
    this.fuel = clamp(num(o.fuel, 0) | 0, 0, this.fuelTotal);
    this.pendingTicks = 0;
    return this;
  }

  /**
   * Rebuild a stand from save data.
   * @param {?Object} o save record
   * @returns {BrewingStand} the restored stand
   */
  static deserialize(o) {
    const stand = new BrewingStand({
      x: (o && Number.isFinite(o.x)) ? o.x : undefined,
      y: (o && Number.isFinite(o.y)) ? o.y : undefined,
      z: (o && Number.isFinite(o.z)) ? o.z : undefined,
    });
    stand.deserialize(o);
    return stand;
  }
}

/* ========================================================================== */
/* BrewingManager                                                             */
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
 * Owns every brewing stand in the world, ticks them inside a time budget and
 * writes them into the save.
 *
 * Emits `'brewed'` `(stand)` when a stand finishes a brew and `'removed'`
 * `(stand)` when a stand is broken.
 *
 * @augments EventBus
 */
export class BrewingManager extends EventBus {
  /**
   * @param {?Object} world the chunk manager (`world/world.js`)
   * @param {Object} [options] wiring; every field is optional
   * @param {?Object} [options.entities] the entity manager, for dropped contents
   * @param {?Object} [options.effects] the {@link EffectManager}
   * @param {?Object} [options.particles] the particle system
   * @param {?Object} [options.audio] the audio engine
   * @param {number} [options.budgetMs] milliseconds per tick
   */
  constructor(world, options = {}) {
    super();

    /** @type {?Object} The world. */
    this.world = world || null;
    /** @type {?Object} Entity manager, used when a stand is broken. */
    this.entities = options.entities || null;
    /** @type {?Object} Effect manager, handed to drink/splash helpers. */
    this.effects = options.effects || null;
    /** @type {?Object} Particle system. */
    this.particles = options.particles || null;
    /** @type {?Object} Audio engine. */
    this.audio = options.audio || null;
    /** @type {boolean} Set by {@link BrewingManager#dispose}. */
    this.disposed = false;

    /** @type {Map<string, BrewingStand>} Stands by `"x,y,z"`. @private */
    this._stands = new Map();
    /** @type {BrewingStand[]} Flat view of `_stands`. @private */
    this._list = [];
    /** @type {boolean} `_list` needs a rebuild. @private */
    this._listDirty = false;
    /** @type {number} Round-robin cursor into `_list`. @private */
    this._cursor = 0;
    /** @type {number} Leftover fractional tick. @private */
    this._accum = 0;
    /** @type {TimeBudget} Guards the per-stand work. @private */
    this._budget = new TimeBudget(num(options.budgetMs, DEFAULT_BUDGET_MS));

    /** @type {{stands:number, ticked:number, brews:number}} Live counters. */
    this.stats = { stands: 0, ticked: 0, brews: 0 };
  }

  /* -- wiring -------------------------------------------------------------- */

  /**
   * Swap the world (dimension change).
   * @param {?Object} world the new world
   * @returns {BrewingManager} `this`
   */
  setWorld(world) {
    this.world = world || null;
    return this;
  }

  /**
   * Inject or replace the effect manager.
   * @param {?Object} effects the {@link EffectManager}
   * @returns {BrewingManager} `this`
   */
  setEffects(effects) {
    this.effects = effects || null;
    return this;
  }

  /* -- stands -------------------------------------------------------------- */

  /**
   * Is there a stand at this position?
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {boolean} `true` when a stand exists
   */
  hasStand(x, y, z) {
    return this._stands.has(posKey(x, y, z));
  }

  /**
   * Fetch (and optionally create) the stand at a position.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {boolean} [create] create the stand when it does not exist yet
   * @returns {?BrewingStand} the stand, or `null`
   */
  getStand(x, y, z, create = true) {
    const key = posKey(x, y, z);
    const existing = this._stands.get(key);
    if (existing !== undefined) return existing;
    if (!create) return null;
    const stand = new BrewingStand({ x, y, z });
    stand.on('brewed', this._onBrewed);
    this._stands.set(key, stand);
    this._listDirty = true;
    return stand;
  }

  /**
   * Forget the stand at a position, scattering its contents.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {boolean} [dropContents] drop the slots into the world
   * @returns {boolean} `true` when a stand was removed
   */
  removeStand(x, y, z, dropContents = true) {
    const key = posKey(x, y, z);
    const stand = this._stands.get(key);
    if (stand === undefined) return false;
    this._stands.delete(key);
    this._listDirty = true;
    stand.off('brewed', this._onBrewed);

    if (dropContents && this.entities !== null && typeof this.entities.dropItem === 'function') {
      for (let i = 0; i < stand.size; i++) {
        const item = stand.take(i);
        if (item === null) continue;
        try {
          this.entities.dropItem(x + 0.5, y + 0.5, z + 0.5, item, null);
        } catch (err) {
          warnOnce('drop', 'the stand contents could not be dropped', err);
        }
      }
    }
    this.emit('removed', stand);
    return true;
  }

  /**
   * Relay a finished brew as a manager event plus sound and particles.
   * @param {BrewingStand} stand the stand that finished
   * @returns {void}
   * @private
   */
  _onBrewed = (stand) => {
    this.stats.brews++;
    this.emit('brewed', stand);
    if (!Number.isFinite(stand.x)) return;
    const cx = stand.x + 0.5;
    const cy = stand.y + 0.9;
    const cz = stand.z + 0.5;
    if (this.audio !== null && typeof this.audio.play === 'function') {
      try {
        this.audio.play('brewing', { x: cx, y: cy, z: cz, volume: 0.8 });
      } catch (err) {
        warnOnce('brew:audio', 'the brewing sound failed', err);
      }
    }
    if (this.particles !== null && typeof this.particles.spawn === 'function') {
      try {
        this.particles.spawn('dust', cx, cy, cz, { count: 10, speed: 0.6, life: 1.0 });
      } catch (err) {
        warnOnce('brew:particles', 'the brewing particles failed', err);
      }
    }
  };

  /**
   * Rebuild the flat stand list.
   * @returns {BrewingStand[]} the list
   * @private
   */
  _standList() {
    if (this._listDirty) {
      this._list.length = 0;
      this._stands.forEach((s) => { this._list.push(s); });
      this._listDirty = false;
      if (this._cursor >= this._list.length) this._cursor = 0;
    }
    return this._list;
  }

  /* -- tick ---------------------------------------------------------------- */

  /**
   * Advance every stand.
   *
   * The tick count is booked on **every** stand first (a two-line loop), and
   * only the actual simulation is spread round-robin under a time budget — so
   * a world full of brewing stands costs a bounded amount of time per tick and
   * still brews at exactly the right rate.
   *
   * @param {number} dt elapsed seconds
   * @returns {number} how many game ticks were booked
   */
  tick(dt) {
    if (this.disposed) return 0;
    const list = this._standList();
    this.stats.stands = list.length;
    if (list.length === 0) {
      this._accum = 0;
      return 0;
    }

    this._accum += clamp(num(dt, 0), 0, 0.25) * TICKS_PER_SECOND;
    const ticks = Math.floor(this._accum);
    if (ticks <= 0) return 0;
    this._accum -= ticks;

    for (let i = 0; i < list.length; i++) {
      list[i].pendingTicks = Math.min(BREW_TIME, list[i].pendingTicks + ticks);
    }

    this._budget.start();
    let visited = 0;
    let ticked = 0;
    const n = list.length;
    while (visited < n) {
      if (this._cursor >= n) this._cursor = 0;
      const stand = list[this._cursor];
      this._cursor++;
      visited++;
      if (stand === undefined || stand.pendingTicks <= 0) continue;
      const owed = stand.pendingTicks;
      stand.pendingTicks = 0;
      try {
        stand.tick(owed);
        ticked++;
      } catch (err) {
        warnOnce('stand:tick', 'a brewing stand failed to tick', err);
      }
      if (this._budget.expired()) break;
    }
    this.stats.ticked = ticked;
    return ticks;
  }

  /* -- persistence --------------------------------------------------------- */

  /**
   * Snapshot every stand that holds something or is mid-brew.
   * @returns {{v:number, stands:Array<[string, Object]>}} save record
   */
  serialize() {
    /** @type {Array<[string, Object]>} */
    const stands = [];
    this._stands.forEach((stand, key) => {
      try {
        if (stand.isEmpty() && stand.fuel === 0 && stand.brewTime === 0) return;
        stands.push([key, stand.serialize()]);
      } catch (err) {
        warnOnce('save:stand', 'a brewing stand could not be serialised', err);
      }
    });
    return { v: BREWING_SAVE_VERSION, stands };
  }

  /**
   * Restore a snapshot produced by {@link BrewingManager#serialize}.
   * @param {?Object} o the record
   * @returns {BrewingManager} `this`
   */
  deserialize(o) {
    this.clear();
    if (o === null || o === undefined || !Array.isArray(o.stands)) return this;
    for (let i = 0; i < o.stands.length; i++) {
      const entry = o.stands[i];
      if (!Array.isArray(entry) || entry.length < 2) continue;
      try {
        const stand = BrewingStand.deserialize(entry[1]);
        stand.on('brewed', this._onBrewed);
        this._stands.set(String(entry[0]), stand);
      } catch (err) {
        warnOnce('load:stand', 'a brewing stand could not be restored', err);
      }
    }
    this._listDirty = true;
    return this;
  }

  /**
   * Forget every stand without dropping anything (world unload).
   * @returns {void}
   */
  clear() {
    this._stands.forEach((stand) => { stand.off('brewed', this._onBrewed); });
    this._stands.clear();
    this._list.length = 0;
    this._listDirty = false;
    this._cursor = 0;
    this._accum = 0;
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
    this.effects = null;
    this.particles = null;
    this.audio = null;
    this.removeAllListeners();
  }
}

/**
 * German label of an item id, used by the brewing UI for ingredient hints.
 * @param {number} itemId item id
 * @returns {string} the display name
 */
export function ingredientDisplay(itemId) {
  try {
    return getItem(itemId | 0).display;
  } catch (err) {
    warnOnce('display', 'an item display lookup failed', err);
    return '';
  }
}

export default BrewingManager;
