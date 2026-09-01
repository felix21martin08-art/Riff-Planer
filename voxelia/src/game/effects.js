/**
 * @file game/effects.js — VOXELIA status-effect system.
 *
 * The single source of truth for everything that temporarily changes an
 * entity: potions (`game/brewing.js`), food (`game/items.js` food effects),
 * beacons, conduits and mob abilities all funnel through {@link EffectManager}.
 *
 * ============================================================================
 * DESIGN
 * ============================================================================
 * * **Registry.** {@link EFFECT_DEFS} holds one immutable {@link EffectDef} per
 *   effect: id, German display name, particle/HUD colour, beneficial/instant
 *   flags and an `apply()` function that folds the effect into an attribute
 *   record. Attribute records are recomputed only when an entity's effect set
 *   actually changes, never per tick.
 * * **Fixed step.** {@link EffectManager#tick} takes real seconds, converts
 *   them into whole 20 TPS game ticks with an accumulator and clamps the
 *   catch-up, so behaviour never depends on the frame rate.
 * * **Two-phase tick.** Phase 1 walks every active effect and only decrements
 *   counters (a tight, allocation-free loop). Phase 2 flushes the *periodic*
 *   work — regeneration heals, poison/wither damage, hunger drain, levitation —
 *   round-robin under a {@link TimeBudget}, so a world full of poisoned mobs
 *   can never stall a tick. Nothing is lost when the budget runs out: the
 *   pending-fire counters computed in phase 1 are flushed on a later tick.
 * * **HUD contract.** Every tracked entity gets an `entity.effects` property
 *   holding the live `Map<string, ActiveEffect>`. `ui/hud.js` polls exactly
 *   that shape (`value.remaining` in seconds, `value.amplifier` 0-based), so
 *   the effect stack lights up with no HUD change.
 * * **Never throws.** Every per-entity step is guarded; a failure logs once
 *   through {@link warnOnce} and the offending effect is dropped.
 *
 * ============================================================================
 * ATTRIBUTES
 * ============================================================================
 * {@link EffectManager#attributes} returns a per-entity record the player
 * controller, the combat system and the interaction code read:
 *
 * | field                 | meaning                                          |
 * |-----------------------|--------------------------------------------------|
 * | `speed`               | walk/sprint/fly speed multiplier                 |
 * | `mining`              | block-breaking speed multiplier                  |
 * | `attackBonus`         | half-hearts added to a melee hit                 |
 * | `attackMultiplier`    | multiplier on a melee hit                        |
 * | `knockbackResistance` | 0..1, fraction of knockback ignored              |
 * | `jump`                | jump-impulse multiplier                          |
 * | `fallReduction`       | blocks subtracted from the fall distance         |
 * | `fallDamage`          | fall-damage multiplier (`0` = fully negated)     |
 * | `resistance`          | 0..1, fraction of incoming damage removed        |
 * | `fireResistance`      | immune to fire, lava and hot floors              |
 * | `waterBreathing`      | the air bar never drains                         |
 * | `invisible`/`glowing` | renderer flags                                   |
 * | `blind`/`nightVision` | post-processing flags                            |
 * | `nausea`              | 0..1 screen-warp strength                        |
 * | `levitation`          | upward target speed in blocks/s (`0` = off)      |
 * | `slowFalling`         | terminal fall speed is capped, no fall damage    |
 * | `maxHealthBonus`      | extra maximum health in half-hearts              |
 * | `absorptionMax`       | absorption pool size in half-hearts              |
 * | `conduit`             | conduit power is active                          |
 *
 * @module game/effects
 */

import { EventBus, TimeBudget } from '../core/util.js';
import { clamp } from '../core/math.js';
import { I, getItem } from './items.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Game ticks per second — the fixed logic rate of `game/game.js`. @type {number} */
export const TICKS_PER_SECOND = 20;

/** Seconds in one game tick. @type {number} */
export const TICK_SECONDS = 1 / TICKS_PER_SECOND;

/** Largest number of ticks a single {@link EffectManager#tick} may catch up. @type {number} */
export const MAX_CATCHUP_TICKS = 5;

/** Highest amplifier an effect may reach (0-based, so 255 = level CCLVI). @type {number} */
export const MAX_AMPLIFIER = 255;

/** Duration value that means "until it is removed". @type {number} */
export const INFINITE_DURATION = -1;

/** Save-format version written by {@link EffectManager#serialize}. @type {number} */
export const EFFECT_SAVE_VERSION = 1;

/** Milliseconds of a game tick the periodic phase may use. @type {number} */
export const DEFAULT_BUDGET_MS = 1.2;

/** Damage source id used by poison, wither and instant damage. @type {string} */
export const EFFECT_DAMAGE_SOURCE = 'magic';

/**
 * Pseudo effect types that `game/items.js` food records use but that are not
 * real status effects. {@link EffectManager#applyFoodEffects} understands them.
 * @type {Readonly<Object<string, string>>}
 */
export const PSEUDO_EFFECTS = Object.freeze({
  CLEAR: 'clear_effects',
  CURE_POISON: 'cure_poison',
  TELEPORT: 'teleport',
});

/* ========================================================================== */
/* Diagnostics                                                                */
/* ========================================================================== */

/** Keys of problems already reported. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a problem exactly once per key. The effect system runs inside the game
 * tick and must never spam the console or throw (hard rule 8).
 * @param {string} key de-duplication key
 * @param {string} message human readable message
 * @param {*} [err] the original error
 * @returns {void}
 */
function warnOnce(key, message, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err !== undefined) console.warn(`[VOXELIA] effects: ${message}`, err);
  else console.warn(`[VOXELIA] effects: ${message}`);
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

/**
 * Convert a `#rrggbb` string into linear-ish `[r, g, b]` floats for particles.
 * @param {string} hex colour string
 * @returns {readonly number[]} frozen `[r, g, b]` in `0..1`
 */
function rgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return Object.freeze([
    ((v >> 16) & 255) / 255,
    ((v >> 8) & 255) / 255,
    (v & 255) / 255,
  ]);
}

/* ========================================================================== */
/* Attribute record                                                           */
/* ========================================================================== */

/**
 * The gameplay numbers an entity's active effects add up to.
 *
 * @typedef {Object} EffectAttributes
 * @property {number} speed movement speed multiplier
 * @property {number} mining block-breaking speed multiplier
 * @property {number} attackBonus half-hearts added to a melee hit
 * @property {number} attackMultiplier multiplier applied to a melee hit
 * @property {number} knockbackResistance `0..1` fraction of knockback ignored
 * @property {number} jump jump-impulse multiplier
 * @property {number} fallReduction blocks subtracted from the fall distance
 * @property {number} fallDamage fall-damage multiplier (`0` fully negates)
 * @property {number} resistance `0..1` fraction of incoming damage removed
 * @property {boolean} fireResistance immune to fire and lava
 * @property {boolean} waterBreathing the air bar never drains
 * @property {boolean} invisible renderer hides the model
 * @property {boolean} blind post-processing blackout
 * @property {boolean} nightVision post-processing brightening
 * @property {boolean} glowing renderer draws an outline
 * @property {number} nausea `0..1` screen-warp strength
 * @property {number} levitation upward target speed in blocks/s (`0` = off)
 * @property {boolean} slowFalling capped fall speed, no fall damage
 * @property {number} maxHealthBonus extra maximum health in half-hearts
 * @property {number} absorptionMax absorption pool size in half-hearts
 * @property {boolean} conduit conduit power is active
 * @property {number} exhaustionRate extra exhaustion points per second
 * @property {number} saturationRate food points restored per second
 * @property {boolean} any `true` when at least one effect is active
 */

/**
 * Build a neutral attribute record (no effects active).
 * @returns {EffectAttributes} a fresh record
 */
export function createAttributes() {
  return {
    speed: 1,
    mining: 1,
    attackBonus: 0,
    attackMultiplier: 1,
    knockbackResistance: 0,
    jump: 1,
    fallReduction: 0,
    fallDamage: 1,
    resistance: 0,
    fireResistance: false,
    waterBreathing: false,
    invisible: false,
    blind: false,
    nightVision: false,
    glowing: false,
    nausea: 0,
    levitation: 0,
    slowFalling: false,
    maxHealthBonus: 0,
    absorptionMax: 0,
    conduit: false,
    exhaustionRate: 0,
    saturationRate: 0,
    any: false,
  };
}

/**
 * Reset an attribute record in place — no allocation on the recompute path.
 * @param {EffectAttributes} a record to clear
 * @returns {EffectAttributes} `a`
 */
function resetAttributes(a) {
  a.speed = 1;
  a.mining = 1;
  a.attackBonus = 0;
  a.attackMultiplier = 1;
  a.knockbackResistance = 0;
  a.jump = 1;
  a.fallReduction = 0;
  a.fallDamage = 1;
  a.resistance = 0;
  a.fireResistance = false;
  a.waterBreathing = false;
  a.invisible = false;
  a.blind = false;
  a.nightVision = false;
  a.glowing = false;
  a.nausea = 0;
  a.levitation = 0;
  a.slowFalling = false;
  a.maxHealthBonus = 0;
  a.absorptionMax = 0;
  a.conduit = false;
  a.exhaustionRate = 0;
  a.saturationRate = 0;
  a.any = false;
  return a;
}

/** Shared neutral record handed out for untracked entities. @type {EffectAttributes} */
const NEUTRAL_ATTRIBUTES = Object.freeze(createAttributes());

/* ========================================================================== */
/* Registry                                                                   */
/* ========================================================================== */

/**
 * One status effect.
 *
 * @typedef {Object} EffectDef
 * @property {string} id snake_case identifier, e.g. `'fire_resistance'`
 * @property {string} display German display name for the HUD and tooltips
 * @property {string} hex CSS colour of the HUD icon
 * @property {readonly number[]} color `[r, g, b]` in `0..1` for particles
 * @property {boolean} beneficial `true` for a buff, `false` for a debuff
 * @property {boolean} instant applied once on contact instead of over time
 * @property {number} maxAmplifier highest sensible 0-based level
 * @property {number} defaultDuration duration in ticks used when none is given
 * @property {boolean} periodic the effect fires on a period (see `period()`)
 * @property {(amplifier:number) => number} period ticks between two firings
 * @property {(attrs:EffectAttributes, amplifier:number) => void} apply folds
 *   one active instance into an attribute record
 */

/** Dense registry of every status effect, in HUD order. @type {EffectDef[]} */
const DEFS = [];

/** Effect id -> definition. @type {Map<string, EffectDef>} */
const DEF_BY_ID = new Map();

/** Period function for effects that do not fire periodically. @returns {number} `0` */
function noPeriod() {
  return 0;
}

/** Attribute hook for effects that only exist visually. @returns {void} */
function noApply() {
  /* purely visual or purely periodic — nothing to fold in */
}

/**
 * Register one effect.
 * @param {string} id snake_case identifier
 * @param {string} display German display name
 * @param {string} hex CSS colour
 * @param {Object} [opts] overrides
 * @param {boolean} [opts.beneficial] buff (default) or debuff
 * @param {boolean} [opts.instant] applied once instead of over time
 * @param {number} [opts.maxAmplifier] highest sensible 0-based level
 * @param {number} [opts.defaultDuration] fallback duration in ticks
 * @param {(amplifier:number) => number} [opts.period] ticks between firings
 * @param {(attrs:EffectAttributes, amplifier:number) => void} [opts.apply] attribute hook
 * @returns {EffectDef} the frozen definition
 */
function defineEffect(id, display, hex, opts = {}) {
  const def = Object.freeze({
    id,
    display,
    hex,
    color: rgb(hex),
    beneficial: opts.beneficial !== false,
    instant: opts.instant === true,
    maxAmplifier: opts.maxAmplifier ?? 3,
    defaultDuration: opts.defaultDuration ?? 600,
    periodic: typeof opts.period === 'function',
    period: opts.period ?? noPeriod,
    apply: opts.apply ?? noApply,
  });
  DEFS.push(def);
  DEF_BY_ID.set(id, def);
  return def;
}

/* -- movement -------------------------------------------------------------- */

defineEffect('speed', 'Schnelligkeit', '#7cafc6', {
  maxAmplifier: 4,
  apply: (a, amp) => { a.speed *= 1 + 0.2 * (amp + 1); },
});

defineEffect('slowness', 'Langsamkeit', '#5a6c81', {
  beneficial: false,
  maxAmplifier: 5,
  apply: (a, amp) => { a.speed *= Math.max(0, 1 - 0.15 * (amp + 1)); },
});

defineEffect('jump_boost', 'Sprungkraft', '#22ff4c', {
  maxAmplifier: 5,
  apply: (a, amp) => {
    a.jump *= 1 + 0.1 * (amp + 1);
    a.fallReduction += amp + 1;
  },
});

defineEffect('levitation', 'Schwebekraft', '#a8e6ff', {
  beneficial: false,
  maxAmplifier: 9,
  defaultDuration: 200,
  apply: (a, amp) => {
    a.levitation = 0.9 * (amp + 1);
    a.fallDamage = 0;
  },
});

defineEffect('slow_falling', 'Sanfter Fall', '#f7f8e0', {
  defaultDuration: 1800,
  apply: (a) => {
    a.slowFalling = true;
    a.fallDamage = 0;
  },
});

/* -- mining and combat ----------------------------------------------------- */

defineEffect('haste', 'Eile', '#d9c043', {
  maxAmplifier: 4,
  apply: (a, amp) => { a.mining *= 1 + 0.2 * (amp + 1); },
});

defineEffect('mining_fatigue', 'Abbaulähmung', '#4a4217', {
  beneficial: false,
  maxAmplifier: 4,
  apply: (a, amp) => { a.mining *= Math.pow(0.3, amp + 1); },
});

defineEffect('strength', 'Stärke', '#932423', {
  maxAmplifier: 4,
  apply: (a, amp) => { a.attackBonus += 3 * (amp + 1); },
});

defineEffect('weakness', 'Schwäche', '#484d48', {
  beneficial: false,
  maxAmplifier: 4,
  apply: (a, amp) => { a.attackBonus -= 4 * (amp + 1); },
});

defineEffect('resistance', 'Widerstand', '#99453a', {
  maxAmplifier: 4,
  apply: (a, amp) => {
    a.resistance = Math.max(a.resistance, Math.min(0.8, 0.2 * (amp + 1)));
    a.knockbackResistance = Math.max(a.knockbackResistance, Math.min(0.6, 0.15 * (amp + 1)));
  },
});

defineEffect('fire_resistance', 'Feuerresistenz', '#e49a3a', {
  defaultDuration: 3600,
  apply: (a) => { a.fireResistance = true; },
});

/* -- health ---------------------------------------------------------------- */

defineEffect('instant_health', 'Sofortheilung', '#f82423', {
  instant: true, maxAmplifier: 4, defaultDuration: 1,
});

defineEffect('instant_damage', 'Sofortschaden', '#430a09', {
  instant: true, beneficial: false, maxAmplifier: 4, defaultDuration: 1,
});

defineEffect('regeneration', 'Regeneration', '#cd5cab', {
  maxAmplifier: 4,
  defaultDuration: 900,
  // Vanilla: one half-heart every 50 ticks, halving with every level.
  period: (amp) => Math.max(1, 50 >> Math.min(5, amp)),
});

defineEffect('poison', 'Vergiftung', '#4e9331', {
  beneficial: false,
  maxAmplifier: 4,
  defaultDuration: 900,
  period: (amp) => Math.max(1, 25 >> Math.min(4, amp)),
});

defineEffect('wither', 'Verkümmern', '#352a27', {
  beneficial: false,
  maxAmplifier: 4,
  defaultDuration: 600,
  period: (amp) => Math.max(1, 40 >> Math.min(5, amp)),
});

defineEffect('health_boost', 'Extraleben', '#f87d23', {
  maxAmplifier: 4,
  defaultDuration: 1800,
  apply: (a, amp) => { a.maxHealthBonus += 4 * (amp + 1); },
});

defineEffect('absorption', 'Absorption', '#2552a5', {
  maxAmplifier: 4,
  defaultDuration: 2400,
  apply: (a, amp) => { a.absorptionMax += 4 * (amp + 1); },
});

/* -- food ------------------------------------------------------------------ */

defineEffect('hunger', 'Hunger', '#587653', {
  beneficial: false,
  maxAmplifier: 3,
  defaultDuration: 600,
  apply: (a, amp) => { a.exhaustionRate += 0.1 * (amp + 1); },
});

defineEffect('saturation', 'Sättigung', '#f8a423', {
  maxAmplifier: 3,
  defaultDuration: 100,
  apply: (a, amp) => { a.saturationRate += 20 * (amp + 1); },
});

/* -- senses ---------------------------------------------------------------- */

defineEffect('water_breathing', 'Wasseratmung', '#2e5299', {
  defaultDuration: 3600,
  apply: (a) => { a.waterBreathing = true; },
});

defineEffect('invisibility', 'Unsichtbarkeit', '#7f8392', {
  defaultDuration: 3600,
  apply: (a) => { a.invisible = true; },
});

defineEffect('blindness', 'Blindheit', '#1f1f23', {
  beneficial: false,
  defaultDuration: 400,
  apply: (a) => { a.blind = true; },
});

defineEffect('night_vision', 'Nachtsicht', '#1f1fa1', {
  defaultDuration: 3600,
  apply: (a) => { a.nightVision = true; },
});

defineEffect('nausea', 'Übelkeit', '#551d4a', {
  beneficial: false,
  defaultDuration: 300,
  apply: (a, amp) => { a.nausea = Math.max(a.nausea, Math.min(1, 0.5 + 0.25 * amp)); },
});

defineEffect('glowing', 'Leuchten', '#94a061', {
  defaultDuration: 200,
  apply: (a) => { a.glowing = true; },
});

defineEffect('conduit_power', 'Kraft des Leuchtfeuers', '#1dc2d1', {
  defaultDuration: 260,
  apply: (a) => {
    a.conduit = true;
    a.waterBreathing = true;
    a.mining *= 1.16;
    a.nightVision = true;
  },
});

/* -- frozen views ---------------------------------------------------------- */

/** Every effect definition, in HUD order. @type {readonly EffectDef[]} */
export const EFFECT_LIST = Object.freeze(DEFS.slice());

/** Effect id -> {@link EffectDef}. @type {ReadonlyMap<string, EffectDef>} */
export const EFFECT_DEFS = DEF_BY_ID;

/**
 * SCREAMING_SNAKE_CASE effect id constants, same convention as `B.*` and `I.*`.
 * @type {Readonly<Object<string, string>>}
 */
export const EFFECT = Object.freeze((() => {
  /** @type {Object<string, string>} */
  const out = Object.create(null);
  for (let i = 0; i < DEFS.length; i++) out[DEFS[i].id.toUpperCase()] = DEFS[i].id;
  return out;
})());

/** Number of registered effects. @type {number} */
export const EFFECT_COUNT = DEFS.length;

/**
 * Definition of an effect id. Never throws — unknown ids return `null` so
 * callers can guard with a single check.
 * @param {string} id effect id
 * @returns {?EffectDef} the definition, or `null`
 */
export function getEffect(id) {
  const def = DEF_BY_ID.get(id);
  return def === undefined ? null : def;
}

/**
 * Does an effect id exist?
 * @param {string} id effect id
 * @returns {boolean} `true` when the id is registered
 */
export function isEffect(id) {
  return DEF_BY_ID.has(id);
}

/**
 * German display name of an effect (the raw id for unknown effects).
 * @param {string} id effect id
 * @returns {string} the display name
 */
export function effectDisplay(id) {
  const def = DEF_BY_ID.get(id);
  return def === undefined ? String(id) : def.display;
}

/**
 * CSS colour of an effect's HUD icon.
 * @param {string} id effect id
 * @returns {string} a `#rrggbb` string
 */
export function effectColor(id) {
  const def = DEF_BY_ID.get(id);
  return def === undefined ? '#2b6fd0' : def.hex;
}

/**
 * Particle colour of an effect.
 * @param {string} id effect id
 * @returns {readonly number[]} `[r, g, b]` in `0..1`
 */
export function effectParticleColor(id) {
  const def = DEF_BY_ID.get(id);
  return def === undefined ? FALLBACK_COLOR : def.color;
}

/** Colour used for unknown effect ids. @type {readonly number[]} */
const FALLBACK_COLOR = rgb('#2b6fd0');

/**
 * Is the effect a buff?
 * @param {string} id effect id
 * @returns {boolean} `true` for a buff, `false` for a debuff or unknown id
 */
export function isBeneficial(id) {
  const def = DEF_BY_ID.get(id);
  return def !== undefined && def.beneficial;
}

/**
 * Is the effect applied once instead of over time?
 * @param {string} id effect id
 * @returns {boolean} `true` for instant health/damage
 */
export function isInstant(id) {
  const def = DEF_BY_ID.get(id);
  return def !== undefined && def.instant;
}

/**
 * Roman numeral for a 0-based amplifier, `''` for level I.
 * @param {number} amplifier 0-based level
 * @returns {string} `''`, `'II'`, `'III'`, …
 */
export function romanLevel(amplifier) {
  const n = Math.max(0, Math.min(MAX_AMPLIFIER, Math.round(num(amplifier, 0)))) + 1;
  if (n <= 1) return '';
  if (n <= ROMAN.length) return ROMAN[n - 1];
  return String(n);
}

/** Roman numerals for levels 1..12. @type {readonly string[]} */
const ROMAN = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']);

/**
 * Format a tick duration the way the HUD and potion tooltips show it.
 * @param {number} ticks duration in game ticks
 * @returns {string} `'3:00'`, or `'∞'` for {@link INFINITE_DURATION}
 */
export function formatTicks(ticks) {
  if (ticks === INFINITE_DURATION) return '∞';
  const total = Math.max(0, Math.ceil(num(ticks, 0) / TICKS_PER_SECOND));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/* ========================================================================== */
/* ActiveEffect                                                               */
/* ========================================================================== */

/**
 * One running instance of an effect on one entity.
 *
 * The field layout is deliberately the one `ui/hud.js` polls: `type` names the
 * effect, `amplifier` is 0-based and `remaining` is the remaining time **in
 * seconds** (mirrored from {@link ActiveEffect#ticks} once per tick, so the
 * HUD never has to divide).
 */
export class ActiveEffect {
  /**
   * @param {string} id effect id
   * @param {number} amplifier 0-based level
   * @param {number} ticks duration in game ticks, or {@link INFINITE_DURATION}
   * @param {Object} [opts] extras
   * @param {boolean} [opts.ambient] granted by a beacon/conduit (weaker particles)
   * @param {boolean} [opts.particles] show ambient particles (default `true`)
   * @param {boolean} [opts.icon] show the HUD icon (default `true`)
   */
  constructor(id, amplifier, ticks, opts = {}) {
    /** @type {string} Effect id — the key of the owning map. */
    this.id = id;
    /** @type {string} Alias of {@link ActiveEffect#id}; `ui/hud.js` reads `type`. */
    this.type = id;
    /** @type {number} 0-based level (0 = level I). */
    this.amplifier = clamp(Math.round(num(amplifier, 0)), 0, MAX_AMPLIFIER);
    /** @type {number} Remaining duration in game ticks, or `-1` for endless. */
    this.ticks = Number.isFinite(ticks) ? Math.max(0, Math.round(ticks)) : INFINITE_DURATION;
    /** @type {number} Duration this instance started with, for HUD progress. */
    this.totalTicks = this.ticks;
    /** @type {number} Remaining duration in seconds — the HUD reads this. */
    this.remaining = this.ticks === INFINITE_DURATION ? Infinity : this.ticks * TICK_SECONDS;
    /** @type {boolean} Ambient (beacon/conduit) source. */
    this.ambient = opts.ambient === true;
    /** @type {boolean} Emit ambient particles for this instance. */
    this.particles = opts.particles !== false;
    /** @type {boolean} Show the HUD icon for this instance. */
    this.icon = opts.icon !== false;
    /** @type {number} Ticks left until the next periodic firing. @private */
    this._nextFire = 0;
    /** @type {number} Periodic firings waiting to be applied. @private */
    this._pendingFires = 0;
  }

  /** @returns {number} 1-based level (level I = 1). */
  get level() {
    return this.amplifier + 1;
  }

  /** @returns {?EffectDef} the definition behind this instance. */
  get def() {
    return getEffect(this.id);
  }

  /** @returns {string} `'Stärke II'` — name plus roman numeral. */
  get label() {
    const roman = romanLevel(this.amplifier);
    return roman === '' ? effectDisplay(this.id) : `${effectDisplay(this.id)} ${roman}`;
  }

  /**
   * Would `amplifier`/`ticks` be an upgrade over this instance? Vanilla rule:
   * a strictly higher level always wins, an equal level wins on duration.
   * @param {number} amplifier candidate 0-based level
   * @param {number} ticks candidate duration in ticks
   * @returns {boolean} `true` when the candidate should replace this instance
   */
  isUpgradedBy(amplifier, ticks) {
    const amp = clamp(Math.round(num(amplifier, 0)), 0, MAX_AMPLIFIER);
    if (amp > this.amplifier) return true;
    if (amp < this.amplifier) return false;
    if (ticks === INFINITE_DURATION) return true;
    if (this.ticks === INFINITE_DURATION) return false;
    return ticks > this.ticks;
  }

  /**
   * Compact save record.
   * @returns {{i:string, a:number, t:number, tt:number, m?:number}} plain object
   */
  serialize() {
    /** @type {{i:string, a:number, t:number, tt:number, m?:number}} */
    const out = { i: this.id, a: this.amplifier, t: this.ticks, tt: this.totalTicks };
    let flags = 0;
    if (this.ambient) flags |= 1;
    if (!this.particles) flags |= 2;
    if (!this.icon) flags |= 4;
    if (flags !== 0) out.m = flags;
    return out;
  }

  /**
   * Rebuild from {@link ActiveEffect#serialize} output.
   * @param {?Object} o save record
   * @returns {?ActiveEffect} the instance, or `null` for unusable input
   */
  static deserialize(o) {
    if (o === null || o === undefined || typeof o !== 'object') return null;
    const id = typeof o.i === 'string' ? o.i : (typeof o.id === 'string' ? o.id : null);
    if (id === null || !DEF_BY_ID.has(id)) return null;
    const flags = num(o.m, 0) | 0;
    const fx = new ActiveEffect(id, num(o.a, 0), num(o.t, 0), {
      ambient: (flags & 1) !== 0,
      particles: (flags & 2) === 0,
      icon: (flags & 4) === 0,
    });
    fx.totalTicks = Math.max(fx.ticks, num(o.tt, fx.ticks));
    return fx;
  }
}

/* ========================================================================== */
/* Per-entity record                                                          */
/* ========================================================================== */

/**
 * Everything the manager keeps for one affected entity.
 * @typedef {Object} EffectHolder
 * @property {Object} entity the affected entity (player or mob)
 * @property {Map<string, ActiveEffect>} map live effects, also on `entity.effects`
 * @property {EffectAttributes} attrs folded attribute record
 * @property {boolean} dirty attributes need a recompute
 * @property {number} absorption current absorption pool in half-hearts
 * @property {number} absorptionCap pool size the last recompute granted
 * @property {number} baseMaxHealth maximum health before `health_boost`
 * @property {number} particleTimer ticks until the next particle puff
 * @property {boolean} undead the entity counts as undead
 */

/**
 * Does this entity count as undead (instant health hurts it, poison cannot)?
 * @param {*} entity candidate entity
 * @returns {boolean} `true` for zombies, skeletons, drowned, husks, …
 */
function isUndead(entity) {
  if (!entity || typeof entity !== 'object') return false;
  const def = entity.def;
  return def !== null && def !== undefined && def.undead === true;
}

/* ========================================================================== */
/* EffectManager                                                              */
/* ========================================================================== */

/**
 * Owns every status effect in the world.
 *
 * Emitted events (through {@link EventBus}):
 * - `'added'` `(entity, activeEffect)` — an effect started or was upgraded.
 * - `'removed'` `(entity, activeEffect, reason)` — `'expired'|'removed'|'cleared'|'milk'`.
 * - `'instant'` `(entity, effectId, amplifier, amount)` — an instant effect fired.
 * - `'cleared'` `(entity, count)` — every effect on an entity was dropped.
 * - `'attributes'` `(entity, attributes)` — the folded attributes changed.
 *
 * @augments EventBus
 */
export class EffectManager extends EventBus {
  /**
   * @param {Object} [options] wiring; every field is optional and degrades
   * @param {?Object} [options.player] the local player (`game/player.js`)
   * @param {?Object} [options.entities] the entity manager (`game/entities.js`)
   * @param {?Object} [options.combat] the combat system (`game/combat.js`)
   * @param {?Object} [options.particles] the particle system (`render/particles.js`)
   * @param {?Object} [options.audio] the audio engine (`game/audio.js`)
   * @param {number} [options.budgetMs] milliseconds per tick for periodic work
   */
  constructor(options = {}) {
    super();

    /** @type {?Object} The local player; effects on it drive the HUD. */
    this.player = options.player || null;
    /** @type {?Object} Entity manager, used to resolve ids when loading a save. */
    this.entities = options.entities || null;
    /** @type {?Object} Combat system; when set it applies the damage/healing. */
    this.combat = options.combat || null;
    /** @type {?Object} Particle system for the ambient effect puffs. */
    this.particles = options.particles || null;
    /** @type {?Object} Audio engine. */
    this.audio = options.audio || null;
    /** @type {boolean} Set by {@link EffectManager#dispose}. */
    this.disposed = false;

    /** @type {Map<Object, EffectHolder>} Affected entities. @private */
    this._holders = new Map();
    /** @type {EffectHolder[]} Flat view of `_holders`, rebuilt on mutation. @private */
    this._list = [];
    /** @type {boolean} `_list` needs a rebuild. @private */
    this._listDirty = false;
    /** @type {number} Round-robin cursor into `_list`. @private */
    this._cursor = 0;
    /** @type {number} Leftover fractional tick from {@link EffectManager#tick}. @private */
    this._accum = 0;
    /** @type {TimeBudget} Guards the periodic phase. @private */
    this._budget = new TimeBudget(num(options.budgetMs, DEFAULT_BUDGET_MS));
    /** @type {ActiveEffect[]} Scratch list of effects removed this tick. @private */
    this._expired = [];
    /** @type {Object[]} Scratch list of holders removed this tick. @private */
    this._drop = [];
    /** @type {string[]} Scratch list used by {@link EffectManager#clearHarmful}. @private */
    this._harmful = [];

    /** @type {{ticks:number, holders:number, effects:number, fires:number}} Live counters. */
    this.stats = { ticks: 0, holders: 0, effects: 0, fires: 0 };

    if (this.player !== null) this._ensureHolder(this.player);
  }

  /* ---------------------------------------------------------------- wiring -- */

  /**
   * Point the manager at the local player. Its effect map is published as
   * `player.effects`, which is exactly what `ui/hud.js` polls.
   * @param {?Object} player the player, or `null` to detach
   * @returns {EffectManager} `this`
   */
  attach(player) {
    if (this.player === player) return this;
    this.player = player || null;
    if (this.player !== null) this._ensureHolder(this.player);
    return this;
  }

  /**
   * Inject or replace the combat system used for damage and healing.
   * @param {?Object} combat the combat system
   * @returns {EffectManager} `this`
   */
  setCombat(combat) {
    this.combat = combat || null;
    return this;
  }

  /**
   * Inject or replace the entity manager (needed to restore a save).
   * @param {?Object} entities the entity manager
   * @returns {EffectManager} `this`
   */
  setEntities(entities) {
    this.entities = entities || null;
    return this;
  }

  /* ------------------------------------------------------------- holders --- */

  /**
   * Fetch (or create) the record for an entity and publish `entity.effects`.
   * @param {Object} entity the entity
   * @returns {?EffectHolder} the record, or `null` for a bad argument
   * @private
   */
  _ensureHolder(entity) {
    if (entity === null || entity === undefined || typeof entity !== 'object') return null;
    let holder = this._holders.get(entity);
    if (holder !== undefined) return holder;
    holder = {
      entity,
      map: new Map(),
      attrs: createAttributes(),
      dirty: false,
      absorption: 0,
      absorptionCap: 0,
      baseMaxHealth: num(entity.maxHealth, 20),
      particleTimer: 0,
      undead: isUndead(entity),
    };
    this._holders.set(entity, holder);
    this._listDirty = true;
    try {
      entity.effects = holder.map;
    } catch (err) {
      warnOnce('publish', 'an entity refused the `effects` property', err);
    }
    return holder;
  }

  /**
   * Drop the record of an entity that has no effects left.
   * @param {EffectHolder} holder the record
   * @returns {void}
   * @private
   */
  _releaseHolder(holder) {
    if (holder.map.size !== 0) return;
    this._restoreMaxHealth(holder);
    holder.absorption = 0;
    holder.absorptionCap = 0;
    this._publishAbsorption(holder);
    this._holders.delete(holder.entity);
    this._listDirty = true;
  }

  /**
   * Rebuild the flat holder list used by the round-robin walk.
   * @returns {EffectHolder[]} the list
   * @private
   */
  _holderList() {
    if (this._listDirty) {
      this._list.length = 0;
      this._holders.forEach((h) => { this._list.push(h); });
      this._listDirty = false;
      if (this._cursor >= this._list.length) this._cursor = 0;
    }
    return this._list;
  }

  /* --------------------------------------------------------------- queries -- */

  /**
   * Is an effect running on an entity?
   * @param {?Object} entity the entity
   * @param {string} effectId effect id
   * @returns {boolean} `true` when the effect is active
   */
  has(entity, effectId) {
    const holder = this._holders.get(entity);
    return holder !== undefined && holder.map.has(effectId);
  }

  /**
   * The running instance of an effect.
   * @param {?Object} entity the entity
   * @param {string} effectId effect id
   * @returns {?ActiveEffect} the instance, or `null`
   */
  get(entity, effectId) {
    const holder = this._holders.get(entity);
    if (holder === undefined) return null;
    const fx = holder.map.get(effectId);
    return fx === undefined ? null : fx;
  }

  /**
   * 1-based level of an effect (`0` when it is not running) — the shape most
   * gameplay code wants.
   * @param {?Object} entity the entity
   * @param {string} effectId effect id
   * @returns {number} level, `0` when absent
   */
  level(entity, effectId) {
    const fx = this.get(entity, effectId);
    return fx === null ? 0 : fx.amplifier + 1;
  }

  /**
   * 0-based amplifier of an effect, `-1` when it is not running.
   * @param {?Object} entity the entity
   * @param {string} effectId effect id
   * @returns {number} amplifier, `-1` when absent
   */
  amplifier(entity, effectId) {
    const fx = this.get(entity, effectId);
    return fx === null ? -1 : fx.amplifier;
  }

  /**
   * Live effect map of an entity. The returned map is the one the HUD polls —
   * treat it as read-only.
   * @param {?Object} entity the entity
   * @returns {?Map<string, ActiveEffect>} the map, or `null` when untracked
   */
  list(entity) {
    const holder = this._holders.get(entity);
    return holder === undefined ? null : holder.map;
  }

  /**
   * Number of running effects on an entity.
   * @param {?Object} entity the entity
   * @returns {number} effect count
   */
  count(entity) {
    const holder = this._holders.get(entity);
    return holder === undefined ? 0 : holder.map.size;
  }

  /** @returns {number} how many entities currently carry at least one effect */
  get trackedCount() {
    return this._holders.size;
  }

  /* ----------------------------------------------------------------- add ---- */

  /**
   * Start (or upgrade) an effect on an entity.
   *
   * Instant effects (`instant_health`, `instant_damage`) are applied on the
   * spot and never enter the map. Everything else replaces a weaker running
   * instance and is otherwise left alone, exactly like vanilla.
   *
   * @param {?Object} entity the entity to affect
   * @param {string} effectId a registered effect id
   * @param {number} [amplifier] 0-based level (0 = level I)
   * @param {number} [durationTicks] duration in game ticks, or
   *   {@link INFINITE_DURATION}; defaults to the effect's own default
   * @param {Object} [opts] extras forwarded to {@link ActiveEffect}
   * @param {number} [opts.potency] `0..1` scale on duration/instant strength
   *   (splash-potion distance falloff)
   * @param {boolean} [opts.ambient] beacon/conduit source
   * @param {boolean} [opts.particles] emit ambient particles
   * @param {boolean} [opts.icon] show the HUD icon
   * @returns {boolean} `true` when something actually changed
   */
  add(entity, effectId, amplifier = 0, durationTicks = undefined, opts = {}) {
    if (this.disposed) return false;
    const def = DEF_BY_ID.get(effectId);
    if (def === undefined) {
      warnOnce(`unknown:${effectId}`, `unknown effect id "${effectId}" was ignored`);
      return false;
    }
    if (entity === null || entity === undefined || typeof entity !== 'object') return false;
    if (entity.dead === true || entity.removed === true) return false;

    const potency = clamp(num(opts.potency, 1), 0, 1);
    if (potency <= 0) return false;

    const amp = clamp(Math.round(num(amplifier, 0)), 0, Math.min(MAX_AMPLIFIER, def.maxAmplifier));

    if (def.instant) {
      return this._applyInstant(entity, def, amp, potency);
    }

    let ticks = durationTicks === undefined ? def.defaultDuration : durationTicks;
    if (ticks !== INFINITE_DURATION) {
      ticks = Math.round(Math.max(0, num(ticks, def.defaultDuration)) * potency);
      if (ticks <= 0) return false;
    }

    const holder = this._ensureHolder(entity);
    if (holder === null) return false;

    const existing = holder.map.get(effectId);
    if (existing !== undefined) {
      if (!existing.isUpgradedBy(amp, ticks)) return false;
      existing.amplifier = amp;
      existing.ticks = ticks;
      existing.totalTicks = ticks;
      existing.remaining = ticks === INFINITE_DURATION ? Infinity : ticks * TICK_SECONDS;
      existing.ambient = opts.ambient === true;
      existing.particles = opts.particles !== false;
      existing.icon = opts.icon !== false;
      existing._nextFire = def.periodic ? def.period(amp) : 0;
      existing._pendingFires = 0;
      holder.dirty = true;
      this._refresh(holder);
      this.emit('added', entity, existing);
      return true;
    }

    const fx = new ActiveEffect(effectId, amp, ticks, opts);
    fx._nextFire = def.periodic ? def.period(amp) : 0;
    holder.map.set(effectId, fx);
    holder.dirty = true;
    this._refresh(holder);
    this.emit('added', entity, fx);
    return true;
  }

  /**
   * Apply an instant effect right now.
   * @param {Object} entity the entity
   * @param {EffectDef} def the effect definition
   * @param {number} amp 0-based level
   * @param {number} potency `0..1` distance falloff
   * @returns {boolean} `true` when health changed
   * @private
   */
  _applyInstant(entity, def, amp, potency) {
    const undead = isUndead(entity);
    const heals = def.id === 'instant_health' ? !undead : undead;
    const base = def.id === 'instant_health' ? 4 : 6;
    const amount = Math.max(1, Math.round(base * Math.pow(2, Math.min(6, amp)) * potency));
    try {
      if (heals) this._heal(entity, amount);
      else this._hurt(entity, amount, false);
    } catch (err) {
      warnOnce('instant', 'an instant effect failed', err);
      return false;
    }
    this._puff(entity, def, 8);
    this.emit('instant', entity, def.id, amp, amount);
    return true;
  }

  /* --------------------------------------------------------------- remove --- */

  /**
   * Stop one effect.
   * @param {?Object} entity the entity
   * @param {string} effectId effect id
   * @param {string} [reason] `'removed'|'expired'|'cleared'|'milk'`
   * @returns {boolean} `true` when the effect was running
   */
  remove(entity, effectId, reason = 'removed') {
    const holder = this._holders.get(entity);
    if (holder === undefined) return false;
    const fx = holder.map.get(effectId);
    if (fx === undefined) return false;
    holder.map.delete(effectId);
    holder.dirty = true;
    this._refresh(holder);
    this.emit('removed', entity, fx, reason);
    if (holder.map.size === 0) this._releaseHolder(holder);
    return true;
  }

  /**
   * Stop every effect on an entity. This is what milk does.
   * @param {?Object} entity the entity
   * @param {string} [reason] event reason
   * @returns {number} how many effects were removed
   */
  clear(entity, reason = 'cleared') {
    const holder = this._holders.get(entity);
    if (holder === undefined) return 0;
    let removed = 0;
    holder.map.forEach((fx) => {
      this.emit('removed', entity, fx, reason);
      removed++;
    });
    holder.map.clear();
    holder.dirty = true;
    this._refresh(holder);
    this._releaseHolder(holder);
    if (removed > 0) this.emit('cleared', entity, removed);
    return removed;
  }

  /**
   * Stop every *harmful* effect (used by the "cure poison" food records and by
   * a bucket of milk in the softer difficulty presets).
   * @param {?Object} entity the entity
   * @returns {number} how many effects were removed
   */
  clearHarmful(entity) {
    const holder = this._holders.get(entity);
    if (holder === undefined) return 0;
    let removed = 0;
    const doomed = this._harmful;
    doomed.length = 0;
    holder.map.forEach((fx, id) => {
      const def = DEF_BY_ID.get(id);
      if (def !== undefined && def.beneficial) return;
      doomed.push(id);
    });
    for (let i = 0; i < doomed.length; i++) {
      if (this.remove(holder.entity, doomed[i], 'cleared')) removed++;
    }
    doomed.length = 0;
    return removed;
  }

  /**
   * Drink a bucket of milk: every status effect ends immediately.
   * @param {?Object} entity the entity that drank
   * @returns {number} how many effects were removed
   */
  applyMilk(entity) {
    return this.clear(entity, 'milk');
  }

  /**
   * Apply the status effects of a consumed item, honouring the `chance` field
   * and the three pseudo effects `game/items.js` uses
   * (`clear_effects`, `cure_poison`, `teleport`).
   *
   * @param {?Object} entity the entity that ate/drank
   * @param {number} itemId the consumed item id
   * @param {() => number} [rng] random source returning `0..1`
   * @returns {number} how many real effects were applied
   */
  applyFoodEffects(entity, itemId, rng = Math.random) {
    if (entity === null || entity === undefined) return 0;
    const id = itemId | 0;
    if (id === I.MILK_BUCKET) {
      this.applyMilk(entity);
      return 0;
    }
    let def = null;
    try {
      def = getItem(id);
    } catch (err) {
      warnOnce('food:item', 'an item lookup failed', err);
      return 0;
    }
    const food = def === null ? null : def.food;
    if (food === null || food === undefined || !Array.isArray(food.effects)) return 0;

    const rand = typeof rng === 'function' ? rng : Math.random;
    let applied = 0;
    for (let i = 0; i < food.effects.length; i++) {
      const fx = food.effects[i];
      if (fx === null || typeof fx !== 'object' || typeof fx.type !== 'string') continue;
      if (fx.type === PSEUDO_EFFECTS.CLEAR) {
        this.clear(entity, 'milk');
        continue;
      }
      if (fx.type === PSEUDO_EFFECTS.CURE_POISON) {
        this.remove(entity, EFFECT.POISON, 'cleared');
        this.remove(entity, EFFECT.WITHER, 'cleared');
        continue;
      }
      if (fx.type === PSEUDO_EFFECTS.TELEPORT) continue;
      const chance = num(fx.chance, 1);
      if (chance < 1 && rand() >= chance) continue;
      const ticks = Math.round(Math.max(0, num(fx.duration, 0)) * TICKS_PER_SECOND);
      if (this.add(entity, fx.type, num(fx.amplifier, 0), ticks === 0 ? 1 : ticks)) applied++;
    }
    return applied;
  }

  /* ----------------------------------------------------------- attributes --- */

  /**
   * The folded attribute record of an entity. Untracked entities get a shared
   * frozen neutral record, so callers never need a null check.
   * @param {?Object} entity the entity
   * @returns {EffectAttributes} the record — do not mutate it
   */
  attributes(entity) {
    const holder = this._holders.get(entity);
    if (holder === undefined) return NEUTRAL_ATTRIBUTES;
    if (holder.dirty) this._recompute(holder);
    return holder.attrs;
  }

  /**
   * Recompute the folded attributes of one entity.
   * @param {EffectHolder} holder the record
   * @returns {void}
   * @private
   */
  _recompute(holder) {
    const a = resetAttributes(holder.attrs);
    holder.map.forEach((fx, id) => {
      const def = DEF_BY_ID.get(id);
      if (def === undefined) return;
      try {
        def.apply(a, fx.amplifier);
      } catch (err) {
        warnOnce(`apply:${id}`, `the attribute hook of "${id}" failed`, err);
      }
      a.any = true;
    });
    if (a.speed < 0) a.speed = 0;
    if (a.mining < 0) a.mining = 0;
    if (a.attackMultiplier < 0) a.attackMultiplier = 0;
    holder.dirty = false;
    this.emit('attributes', holder.entity, a);
  }

  /**
   * Recompute attributes and push the derived entity state (max health,
   * absorption cap) immediately, so a freshly applied Health Boost is visible
   * on the same tick.
   * @param {EffectHolder} holder the record
   * @returns {void}
   * @private
   */
  _refresh(holder) {
    this._recompute(holder);
    this._syncMaxHealth(holder);
    // The pool refills only when Absorption is (re)granted or upgraded — a
    // recompute triggered by some *other* effect expiring must never hand the
    // player their soaked-up hearts back.
    const cap = holder.attrs.absorptionMax;
    if (cap <= 0) holder.absorption = 0;
    else if (cap > holder.absorptionCap) holder.absorption = cap;
    else if (holder.absorption > cap) holder.absorption = cap;
    holder.absorptionCap = cap;
    this._publishAbsorption(holder);
  }

  /* -- convenience readers --------------------------------------------------- */

  /**
   * Movement speed multiplier — `game/player.js` multiplies its target ground
   * speed by this.
   * @param {?Object} entity the entity
   * @returns {number} multiplier, `1` when nothing is active
   */
  movementSpeedMultiplier(entity) {
    return this.attributes(entity).speed;
  }

  /**
   * Mining speed multiplier — `game/interaction.js` divides the break time by
   * this.
   * @param {?Object} entity the entity
   * @returns {number} multiplier, `1` when nothing is active
   */
  miningSpeedMultiplier(entity) {
    return this.attributes(entity).mining;
  }

  /**
   * Half-hearts to add to a melee hit (Strength adds, Weakness subtracts).
   * @param {?Object} entity the attacker
   * @returns {number} additive damage bonus, may be negative
   */
  attackDamageBonus(entity) {
    return this.attributes(entity).attackBonus;
  }

  /**
   * Multiplier applied to a melee hit after {@link EffectManager#attackDamageBonus}.
   * @param {?Object} entity the attacker
   * @returns {number} multiplier, `1` when nothing is active
   */
  attackDamageMultiplier(entity) {
    return this.attributes(entity).attackMultiplier;
  }

  /**
   * Knockback the entity ignores.
   * @param {?Object} entity the entity
   * @returns {number} `0..1`
   */
  knockbackResistance(entity) {
    return this.attributes(entity).knockbackResistance;
  }

  /**
   * Jump-impulse multiplier for `game/player.js`.
   * @param {?Object} entity the entity
   * @returns {number} multiplier, `1` when nothing is active
   */
  jumpMultiplier(entity) {
    return this.attributes(entity).jump;
  }

  /**
   * Blocks of fall distance the entity may ignore before fall damage starts.
   * @param {?Object} entity the entity
   * @returns {number} extra safe blocks
   */
  fallDamageReduction(entity) {
    return this.attributes(entity).fallReduction;
  }

  /**
   * Multiplier on fall damage — `0` means fall damage is fully negated.
   * @param {?Object} entity the entity
   * @returns {number} multiplier, `1` when nothing is active
   */
  fallDamageMultiplier(entity) {
    return this.attributes(entity).fallDamage;
  }

  /**
   * Fraction of incoming damage the Resistance effect removes.
   * @param {?Object} entity the entity
   * @returns {number} `0..0.8`
   */
  damageResistance(entity) {
    return this.attributes(entity).resistance;
  }

  /**
   * Is the entity immune to fire and lava?
   * @param {?Object} entity the entity
   * @returns {boolean} `true` while Fire Resistance runs
   */
  isFireImmune(entity) {
    return this.attributes(entity).fireResistance;
  }

  /**
   * Does the air bar stand still?
   * @param {?Object} entity the entity
   * @returns {boolean} `true` while Water Breathing or Conduit Power runs
   */
  hasWaterBreathing(entity) {
    return this.attributes(entity).waterBreathing;
  }

  /**
   * Should the renderer hide the entity?
   * @param {?Object} entity the entity
   * @returns {boolean} `true` while Invisibility runs
   */
  isInvisible(entity) {
    return this.attributes(entity).invisible;
  }

  /**
   * Should the post-processing black the screen out?
   * @param {?Object} entity the entity
   * @returns {boolean} `true` while Blindness runs
   */
  isBlind(entity) {
    return this.attributes(entity).blind;
  }

  /**
   * Should the post-processing brighten the scene?
   * @param {?Object} entity the entity
   * @returns {boolean} `true` while Night Vision runs
   */
  hasNightVision(entity) {
    return this.attributes(entity).nightVision;
  }

  /**
   * Should the renderer outline the entity?
   * @param {?Object} entity the entity
   * @returns {boolean} `true` while Glowing runs
   */
  isGlowing(entity) {
    return this.attributes(entity).glowing;
  }

  /**
   * Screen-warp strength for the nausea post effect.
   * @param {?Object} entity the entity
   * @returns {number} `0..1`
   */
  nauseaStrength(entity) {
    return this.attributes(entity).nausea;
  }

  /**
   * Current absorption pool (yellow hearts) in half-hearts.
   * @param {?Object} entity the entity
   * @returns {number} remaining absorption
   */
  absorption(entity) {
    const holder = this._holders.get(entity);
    return holder === undefined ? 0 : holder.absorption;
  }

  /**
   * Extra maximum health granted by Health Boost.
   * @param {?Object} entity the entity
   * @returns {number} half-hearts
   */
  maxHealthBonus(entity) {
    return this.attributes(entity).maxHealthBonus;
  }

  /* ------------------------------------------------------------- damage ----- */

  /**
   * Run incoming damage through the effect layer: Fire Resistance cancels heat
   * sources outright, Resistance scales the rest down and the Absorption pool
   * soaks up what is left.
   *
   * `game/combat.js` calls this right after `applyArmor()`.
   *
   * @param {?Object} entity the victim
   * @param {number} amount damage in half-hearts after armour
   * @param {string} [sourceId] a `DAMAGE.*` value from `game/combat.js`
   * @returns {number} the damage that should still be taken off the health bar
   */
  modifyIncomingDamage(entity, amount, sourceId = 'generic') {
    let dmg = Math.max(0, num(amount, 0));
    if (dmg <= 0) return 0;
    const holder = this._holders.get(entity);
    if (holder === undefined) return dmg;
    if (holder.dirty) this._recompute(holder);
    const a = holder.attrs;

    if (a.fireResistance && FIRE_SOURCES.has(sourceId)) return 0;
    if (a.fallDamage <= 0 && sourceId === 'fall') return 0;
    if (sourceId === 'fall' && a.fallDamage !== 1) dmg *= a.fallDamage;

    if (a.resistance > 0 && !BYPASS_RESISTANCE.has(sourceId)) {
      dmg *= 1 - a.resistance;
    }

    if (holder.absorption > 0) {
      const soaked = Math.min(holder.absorption, dmg);
      holder.absorption -= soaked;
      dmg -= soaked;
      this._publishAbsorption(holder);
    }
    return Math.max(0, dmg);
  }

  /* ---------------------------------------------------------------- tick ---- */

  /**
   * Advance every running effect.
   *
   * Takes real seconds and converts them into whole 20 TPS ticks, so the
   * behaviour is identical at 30 and at 240 FPS. Phase 1 (counters) always
   * runs for every effect; phase 2 (heals, damage, particles) is spread over
   * ticks with a {@link TimeBudget}.
   *
   * @param {number} dt elapsed seconds since the previous call
   * @returns {number} how many game ticks were simulated
   */
  tick(dt) {
    if (this.disposed) return 0;
    const step = clamp(num(dt, 0), 0, 0.25);
    this._accum += step * TICKS_PER_SECOND;
    let ticks = Math.floor(this._accum);
    if (ticks <= 0) return 0;
    this._accum -= ticks;
    if (ticks > MAX_CATCHUP_TICKS) {
      // A long stall (tab switch, world load) must not fire 300 poison hits.
      this._accum = 0;
      ticks = MAX_CATCHUP_TICKS;
    }

    for (let t = 0; t < ticks; t++) this._countDown();
    this._runPeriodic(step);

    this.stats.ticks += ticks;
    this.stats.holders = this._holders.size;
    return ticks;
  }

  /**
   * Phase 1 — decrement every timer. Tight, allocation-free, never budgeted:
   * an effect must expire on time even under load.
   * @returns {void}
   * @private
   */
  _countDown() {
    const list = this._holderList();
    let effects = 0;
    for (let h = 0; h < list.length; h++) {
      const holder = list[h];
      const map = holder.map;
      if (map.size === 0) continue;
      const entity = holder.entity;
      const gone = entity.removed === true || entity.dead === true;

      map.forEach((fx, id) => {
        effects++;
        const def = DEF_BY_ID.get(id);
        if (def === undefined) {
          this._expired.push(fx);
          return;
        }
        if (def.periodic) {
          if (fx._nextFire > 0) fx._nextFire--;
          if (fx._nextFire <= 0) {
            if (fx._pendingFires < 8) fx._pendingFires++;
            fx._nextFire = def.period(fx.amplifier);
          }
        }
        if (fx.ticks === INFINITE_DURATION) return;
        fx.ticks--;
        fx.remaining = fx.ticks * TICK_SECONDS;
        if (fx.ticks <= 0) this._expired.push(fx);
      });

      if (this._expired.length > 0) {
        for (let i = 0; i < this._expired.length; i++) {
          const fx = this._expired[i];
          map.delete(fx.id);
          this.emit('removed', entity, fx, 'expired');
        }
        this._expired.length = 0;
        holder.dirty = true;
        this._refresh(holder);
      }
      if (map.size === 0 || gone) this._drop.push(holder);
    }
    this.stats.effects = effects;

    if (this._drop.length > 0) {
      for (let i = 0; i < this._drop.length; i++) {
        const holder = /** @type {EffectHolder} */ (this._drop[i]);
        if (holder.entity.removed === true || holder.entity.dead === true) {
          holder.map.clear();
          this._restoreMaxHealth(holder);
          this._holders.delete(holder.entity);
          this._listDirty = true;
        } else {
          this._releaseHolder(holder);
        }
      }
      this._drop.length = 0;
    }
  }

  /**
   * Phase 2 — flush pending periodic work round-robin under a time budget.
   * @param {number} dtSeconds real seconds of the current frame
   * @returns {void}
   * @private
   */
  _runPeriodic(dtSeconds) {
    const list = this._holderList();
    const n = list.length;
    if (n === 0) return;
    this._budget.start();

    // The player always gets serviced first: its effects are the visible ones.
    const player = this.player;
    if (player !== null) {
      const holder = this._holders.get(player);
      if (holder !== undefined) this._serviceHolder(holder, dtSeconds);
    }

    let visited = 0;
    while (visited < n) {
      if (this._cursor >= n) this._cursor = 0;
      const holder = list[this._cursor];
      this._cursor++;
      visited++;
      if (holder === undefined) continue;
      if (holder.entity === player) continue;
      this._serviceHolder(holder, dtSeconds);
      if (this._budget.expired()) break;
    }
  }

  /**
   * Apply everything one entity owes: periodic firings, hunger/saturation
   * drift, levitation, slow falling and the ambient particle puff.
   * @param {EffectHolder} holder the record
   * @param {number} dtSeconds real seconds of the current frame
   * @returns {void}
   * @private
   */
  _serviceHolder(holder, dtSeconds) {
    const entity = holder.entity;
    if (entity.removed === true || entity.dead === true) return;
    try {
      holder.map.forEach((fx, id) => {
        if (fx._pendingFires <= 0) return;
        const fires = fx._pendingFires;
        fx._pendingFires = 0;
        this._fire(holder, id, fires);
      });

      if (holder.dirty) this._recompute(holder);
      const a = holder.attrs;
      if (!a.any) return;

      if (a.exhaustionRate > 0) this._addExhaustion(entity, a.exhaustionRate * dtSeconds);
      if (a.saturationRate > 0) this._feed(entity, a.saturationRate * dtSeconds);
      if (a.levitation > 0 || a.slowFalling) this._applyVerticalMotion(entity, a, dtSeconds);

      holder.particleTimer -= dtSeconds;
      if (holder.particleTimer <= 0) {
        holder.particleTimer = 0.4 + Math.random() * 0.3;
        this._ambientPuff(holder);
      }
    } catch (err) {
      warnOnce('service', 'a status effect could not be applied', err);
    }
  }

  /**
   * One periodic firing of an effect.
   * @param {EffectHolder} holder the record
   * @param {string} id effect id
   * @param {number} fires how many firings are due
   * @returns {void}
   * @private
   */
  _fire(holder, id, fires) {
    const entity = holder.entity;
    this.stats.fires += fires;
    switch (id) {
      case 'regeneration':
        this._heal(entity, fires);
        break;
      case 'poison':
        // Poison hurts but never kills — it always leaves half a heart.
        if (!holder.undead) this._hurt(entity, fires, true);
        break;
      case 'wither':
        this._hurt(entity, fires, false);
        break;
      default:
        break;
    }
  }

  /* --------------------------------------------------------- entity bridge -- */

  /**
   * Heal an entity through whatever API it offers.
   * @param {Object} entity the entity
   * @param {number} amount half-hearts
   * @returns {void}
   * @private
   */
  _heal(entity, amount) {
    const value = Math.max(0, num(amount, 0));
    if (value <= 0) return;
    if (this.combat !== null && entity === this.player
      && typeof this.combat.heal === 'function') {
      this.combat.heal(value);
      return;
    }
    if (typeof entity.heal === 'function') {
      entity.heal(value);
      return;
    }
    const max = num(entity.maxHealth, 20);
    entity.health = Math.min(max, num(entity.health, max) + value);
  }

  /**
   * Hurt an entity through whatever API it offers.
   * @param {Object} entity the entity
   * @param {number} amount half-hearts
   * @param {boolean} survivable `true` to leave at least half a heart (poison)
   * @returns {void}
   * @private
   */
  _hurt(entity, amount, survivable) {
    let value = Math.max(0, num(amount, 0));
    if (value <= 0) return;
    const health = num(entity.health, 0);
    if (survivable) {
      if (health <= 1) return;
      value = Math.min(value, health - 1);
      if (value <= 0) return;
    }
    if (this.combat !== null && typeof this.combat.dealDamage === 'function') {
      this.combat.dealDamage(entity, value, EFFECT_DAMAGE_SOURCE, null);
      return;
    }
    if (typeof entity.damage === 'function') {
      entity.damage(value, EFFECT_DAMAGE_SOURCE);
      return;
    }
    entity.health = Math.max(0, health - value);
  }

  /**
   * Add exhaustion (the Hunger effect) if the entity tracks it.
   * @param {Object} entity the entity
   * @param {number} amount exhaustion points
   * @returns {void}
   * @private
   */
  _addExhaustion(entity, amount) {
    const value = Math.max(0, num(amount, 0));
    if (value <= 0) return;
    if (typeof entity.addExhaustion === 'function') {
      entity.addExhaustion(value);
      return;
    }
    if (Number.isFinite(entity.exhaustion)) entity.exhaustion += value;
  }

  /**
   * Restore food and saturation (the Saturation effect).
   * @param {Object} entity the entity
   * @param {number} amount food points
   * @returns {void}
   * @private
   */
  _feed(entity, amount) {
    const value = Math.max(0, num(amount, 0));
    if (value <= 0) return;
    if (!Number.isFinite(entity.hunger)) return;
    entity.hunger = Math.min(20, entity.hunger + value);
    if (Number.isFinite(entity.saturation)) {
      entity.saturation = Math.min(entity.hunger, entity.saturation + value * 2);
    }
  }

  /**
   * Levitation pulls the entity up, Slow Falling caps how fast it may drop.
   * Both write velocity directly, so no other module has to know about them.
   * @param {Object} entity the entity
   * @param {EffectAttributes} a the folded attributes
   * @param {number} dtSeconds real seconds of the current frame
   * @returns {void}
   * @private
   */
  _applyVerticalMotion(entity, a, dtSeconds) {
    const v = entity.velocity;
    if (!v || v.length < 3) return;
    if (a.levitation > 0) {
      const target = a.levitation;
      const rate = Math.min(1, dtSeconds * 8);
      v[1] += (target - v[1]) * rate;
      if (Number.isFinite(entity.fallDistance)) entity.fallDistance = 0;
    } else if (a.slowFalling) {
      if (v[1] < -SLOW_FALL_SPEED) v[1] = -SLOW_FALL_SPEED;
      if (Number.isFinite(entity.fallDistance)) entity.fallDistance = 0;
    }
  }

  /**
   * Keep `entity.maxHealth` in sync with the Health Boost bonus.
   * @param {EffectHolder} holder the record
   * @returns {void}
   * @private
   */
  _syncMaxHealth(holder) {
    const entity = holder.entity;
    if (!Number.isFinite(entity.maxHealth)) return;
    const bonus = holder.attrs.maxHealthBonus;
    const wanted = holder.baseMaxHealth + bonus;
    if (entity.maxHealth === wanted) return;
    entity.maxHealth = wanted;
    if (num(entity.health, 0) > wanted) entity.health = wanted;
  }

  /**
   * Put `entity.maxHealth` back where it was before Health Boost.
   * @param {EffectHolder} holder the record
   * @returns {void}
   * @private
   */
  _restoreMaxHealth(holder) {
    const entity = holder.entity;
    if (!Number.isFinite(entity.maxHealth)) return;
    if (entity.maxHealth === holder.baseMaxHealth) return;
    entity.maxHealth = holder.baseMaxHealth;
    if (num(entity.health, 0) > holder.baseMaxHealth) entity.health = holder.baseMaxHealth;
  }

  /**
   * Mirror the absorption pool onto the entity so the HUD can draw the yellow
   * hearts without knowing this module.
   * @param {EffectHolder} holder the record
   * @returns {void}
   * @private
   */
  _publishAbsorption(holder) {
    try {
      holder.entity.absorption = holder.absorption;
    } catch (err) {
      warnOnce('absorb', 'an entity refused the `absorption` property', err);
    }
  }

  /* ------------------------------------------------------------ particles --- */

  /**
   * The gentle colour puff that marks an affected entity.
   * @param {EffectHolder} holder the record
   * @returns {void}
   * @private
   */
  _ambientPuff(holder) {
    const particles = this.particles;
    if (particles === null || typeof particles.spawn !== 'function') return;
    if (holder.map.size === 0) return;
    const entity = holder.entity;
    if (entity === this.player) return; // no puffs inside your own head
    const p = entity.position;
    if (!p || p.length < 3) return;

    let picked = null;
    holder.map.forEach((fx, id) => {
      if (picked !== null || !fx.particles) return;
      const def = DEF_BY_ID.get(id);
      if (def !== undefined) picked = def;
    });
    if (picked === null) return;
    this._puff(entity, picked, 1);
  }

  /**
   * Emit coloured dust around an entity.
   * @param {Object} entity the entity
   * @param {EffectDef} def the effect whose colour to use
   * @param {number} count particle count
   * @returns {void}
   * @private
   */
  _puff(entity, def, count) {
    const particles = this.particles;
    if (particles === null || typeof particles.spawn !== 'function') return;
    const p = entity.position;
    if (!p || p.length < 3) return;
    try {
      particles.spawn('dust', p[0], p[1] + num(entity.height, 1.8) * 0.6, p[2], {
        count,
        color: def.color,
        speed: 0.5,
        spread: 0.35,
        life: 0.8,
      });
    } catch (err) {
      warnOnce('puff', 'effect particles failed', err);
    }
  }

  /* ---------------------------------------------------------- persistence --- */

  /**
   * Snapshot every running effect.
   *
   * The player is stored under the `player` key; every other entity is stored
   * by its `entity.id`, which {@link EffectManager#deserialize} resolves
   * through the entity manager.
   *
   * @returns {{v:number, player:Object[], entities:Array<[number, Object[]]>}}
   *   a structured-clone-safe record
   */
  serialize() {
    /** @type {Object[]} */
    const playerEffects = [];
    /** @type {Array<[number, Object[]]>} */
    const entities = [];

    this._holders.forEach((holder) => {
      /** @type {Object[]} */
      const records = [];
      holder.map.forEach((fx) => {
        try {
          records.push(fx.serialize());
        } catch (err) {
          warnOnce('save:effect', 'an effect could not be serialised', err);
        }
      });
      if (records.length === 0) return;
      if (holder.entity === this.player) {
        for (let i = 0; i < records.length; i++) playerEffects.push(records[i]);
        return;
      }
      const id = holder.entity.id;
      if (Number.isFinite(id)) entities.push([id | 0, records]);
    });

    return { v: EFFECT_SAVE_VERSION, player: playerEffects, entities };
  }

  /**
   * Restore a snapshot produced by {@link EffectManager#serialize}. Effects on
   * entities that no longer exist are dropped silently.
   * @param {?Object} o the record
   * @returns {EffectManager} `this`
   */
  deserialize(o) {
    if (o === null || o === undefined || typeof o !== 'object') return this;

    if (this.player !== null && Array.isArray(o.player)) {
      this.clear(this.player, 'cleared');
      this._restore(this.player, o.player);
    }

    if (Array.isArray(o.entities) && this.entities !== null
      && typeof this.entities.get === 'function') {
      for (let i = 0; i < o.entities.length; i++) {
        const entry = o.entities[i];
        if (!Array.isArray(entry) || entry.length < 2) continue;
        let entity = null;
        try {
          entity = this.entities.get(entry[0] | 0);
        } catch (err) {
          warnOnce('load:lookup', 'an entity lookup failed while loading effects', err);
        }
        if (!entity) continue;
        this.clear(entity, 'cleared');
        this._restore(entity, entry[1]);
      }
    }
    return this;
  }

  /**
   * Push a list of saved effect records onto one entity.
   * @param {Object} entity the entity
   * @param {*} records array of {@link ActiveEffect#serialize} outputs
   * @returns {void}
   * @private
   */
  _restore(entity, records) {
    if (!Array.isArray(records) || records.length === 0) return;
    const holder = this._ensureHolder(entity);
    if (holder === null) return;
    for (let i = 0; i < records.length; i++) {
      const fx = ActiveEffect.deserialize(records[i]);
      if (fx === null) continue;
      const def = DEF_BY_ID.get(fx.id);
      if (def === undefined) continue;
      if (def.instant) continue;
      if (fx.ticks === 0) continue;
      fx._nextFire = def.periodic ? def.period(fx.amplifier) : 0;
      holder.map.set(fx.id, fx);
      this.emit('added', entity, fx);
    }
    holder.dirty = true;
    this._refresh(holder);
    if (holder.map.size === 0) this._releaseHolder(holder);
  }

  /* ---------------------------------------------------------------- misc ---- */

  /**
   * Drop every effect on every entity — used when a world unloads.
   * @returns {void}
   */
  clearAll() {
    const list = this._holderList().slice();
    for (let i = 0; i < list.length; i++) this.clear(list[i].entity, 'cleared');
    this._holders.clear();
    this._list.length = 0;
    this._listDirty = false;
    this._cursor = 0;
  }

  /**
   * Release everything. The manager is inert afterwards.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.clearAll();
    this.disposed = true;
    this.player = null;
    this.entities = null;
    this.combat = null;
    this.particles = null;
    this.audio = null;
    this.removeAllListeners();
  }
}

/** Damage sources Fire Resistance cancels outright. @type {ReadonlySet<string>} */
const FIRE_SOURCES = new Set(['fire', 'lava', 'hot_floor', 'in_fire', 'on_fire']);

/** Damage sources the Resistance effect cannot soften. @type {ReadonlySet<string>} */
const BYPASS_RESISTANCE = new Set(['void', 'starve', 'generic_kill']);

/** Fall speed cap while Slow Falling runs, in blocks/s. @type {number} */
const SLOW_FALL_SPEED = 1.6;

export default EffectManager;
