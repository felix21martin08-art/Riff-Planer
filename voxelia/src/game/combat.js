/**
 * @file game/combat.js — VOXELIA survival rules: health, hunger, armour,
 * damage, knockback, experience and death (spec 5.36).
 *
 * ============================================================================
 * WHAT THIS MODULE OWNS
 * ============================================================================
 * `game/player.js` is a *controller*: it moves a box through the world and
 * keeps the vitals as plain numbers. Everything that decides how those numbers
 * change lives here, so there is exactly one place that knows the survival
 * rules:
 *
 *  - **Food.** Exhaustion accrues from sprinting, jumping, swimming, mining,
 *    attacking, taking damage and regenerating. Every {@link EXHAUSTION_LEVEL}
 *    points burn one saturation point, and once saturation is gone, one hunger
 *    point.
 *  - **Health.** Regeneration is fast while hunger is high *and* saturation is
 *    left, slow when only hunger is high, and turns into starvation at hunger
 *    zero — down to a difficulty-dependent floor.
 *  - **Damage.** Eleven typed sources ({@link DAMAGE}), each with its own
 *    cadence and its own rules about armour, plus a 0.5 s invulnerability
 *    window in which only a *stronger* hit gets through, and then only for the
 *    difference.
 *  - **Armour.** The real reduction curve (points, toughness, enchantment
 *    protection) and per-hit durability loss.
 *  - **Attacks.** A charge-based attack cooldown, so a spammed click does a
 *    fifth of the damage of a timed one, sprint knockback and falling crits.
 *  - **Experience.** The three-segment level curve and the orbs dropped on
 *    death.
 *  - **Death.** Freeze input, scatter the inventory, emit the event the UI
 *    turns into the death screen, respawn with a fresh state.
 *
 * ============================================================================
 * HOW IT ATTACHES TO THE PLAYER
 * ============================================================================
 * {@link CombatSystem#attach} takes ownership of the player's damage path:
 * `player.applyOwnFallDamage` / `player.applyOwnAirDamage` are switched off and
 * `player.damage()` / `player.addXP()` are re-pointed at this system. Anything
 * that already calls `player.damage(...)` — the void guard inside the
 * controller, `EntityManager.explode()`, a mob's melee swing — therefore lands
 * in the full pipeline (invulnerability window, armour, knockback, events)
 * instead of a second, simpler one. {@link CombatSystem#detach} puts the
 * original methods back.
 *
 * Nothing here throws during a tick: every foreign call is guarded, a failure
 * is logged once and the subsystem degrades.
 *
 * @module game/combat
 */

import { EventBus } from '../core/util.js';
import { clamp } from '../core/math.js';
import { B, blockAABBs, isOpaque, isSolid } from '../world/blocks.js';
import {
  armorPoints,
  armorToughness,
  attackDamage,
  attackSpeed,
  knockbackResistance,
} from './items.js';
import { SLOT } from './inventory.js';
import { Player } from './player.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/**
 * Damage source ids. Every one of them behaves differently — see
 * {@link DAMAGE_SOURCES} for the per-source rules.
 * @type {Readonly<Object<string, string>>}
 */
export const DAMAGE = Object.freeze({
  FALL: 'fall',
  DROWN: 'drown',
  LAVA: 'lava',
  FIRE: 'fire',
  VOID: 'void',
  MOB: 'mob',
  PLAYER: 'player',
  EXPLOSION: 'explosion',
  STARVE: 'starve',
  SUFFOCATE: 'suffocate',
  CACTUS: 'cactus',
});

/** Source id of a projectile hit, shared with `game/entities.js`. @type {string} */
export const DAMAGE_ARROW = 'arrow';

/** Source id of anything unclassified, shared with `game/entities.js`. @type {string} */
export const DAMAGE_GENERIC = 'generic';

/** Source id of magic damage (potions, wither), which ignores armour. @type {string} */
export const DAMAGE_MAGIC = 'magic';

/**
 * @typedef {Object} DamageSourceDef
 * @property {string} id the source id
 * @property {string} label German noun for the HUD and the debug overlay
 * @property {string} death German death message, without the player name
 * @property {boolean} bypassArmor armour points do not reduce this source
 * @property {boolean} bypassEnchantments even Protection does not help
 * @property {boolean} fire the source is heat, so Fire Protection applies
 * @property {boolean} blast the source is a blast, so Blast Protection applies
 * @property {boolean} projectile Projectile Protection applies
 * @property {boolean} fall Feather Falling applies
 * @property {boolean} knockback the source normally imparts knockback
 * @property {boolean} scaleWithDifficulty the difficulty multiplier applies
 */

/**
 * Per-source behaviour table. `getDamageSources()` hands this out.
 * @type {Readonly<Object<string, DamageSourceDef>>}
 */
export const DAMAGE_SOURCES = Object.freeze({
  fall: source('fall', 'Sturz', 'ist zu tief gefallen',
    { fall: true, knockback: false }),
  drown: source('drown', 'Ertrinken', 'ist ertrunken',
    { bypassArmor: true, knockback: false }),
  lava: source('lava', 'Lava', 'ist in Lava verbrannt',
    { fire: true, knockback: false }),
  fire: source('fire', 'Feuer', 'ist verbrannt',
    { fire: true, knockback: false }),
  void: source('void', 'Leere', 'ist aus der Welt gefallen',
    { bypassArmor: true, bypassEnchantments: true, knockback: false }),
  mob: source('mob', 'Kreatur', 'wurde von einer Kreatur getötet',
    { scaleWithDifficulty: true }),
  player: source('player', 'Spieler', 'wurde im Kampf getötet', {}),
  explosion: source('explosion', 'Explosion', 'wurde von einer Explosion zerrissen',
    { blast: true, scaleWithDifficulty: true }),
  starve: source('starve', 'Hunger', 'ist verhungert',
    { bypassArmor: true, bypassEnchantments: true, knockback: false }),
  suffocate: source('suffocate', 'Ersticken', 'ist in einer Wand erstickt',
    { bypassArmor: true, knockback: false }),
  cactus: source('cactus', 'Kaktus', 'wurde von einem Kaktus durchbohrt',
    { knockback: false }),
  arrow: source('arrow', 'Pfeil', 'wurde erschossen', { projectile: true }),
  magic: source('magic', 'Magie', 'wurde von Magie getötet',
    { bypassArmor: true, knockback: false }),
  generic: source('generic', 'Schaden', 'ist gestorben', {}),
});

/**
 * Enchantment ids this module understands. `game/inventory.js` stores them as
 * `{id, level}` records on an {@link ItemStack}'s metadata.
 * @type {Readonly<Object<string, string>>}
 */
export const ENCHANTMENTS = Object.freeze({
  PROTECTION: 'protection',
  FIRE_PROTECTION: 'fire_protection',
  BLAST_PROTECTION: 'blast_protection',
  PROJECTILE_PROTECTION: 'projectile_protection',
  FEATHER_FALLING: 'feather_falling',
  RESPIRATION: 'respiration',
  THORNS: 'thorns',
  SHARPNESS: 'sharpness',
  SMITE: 'smite',
  BANE_OF_ARTHROPODS: 'bane_of_arthropods',
  KNOCKBACK: 'knockback',
  FIRE_ASPECT: 'fire_aspect',
  LOOTING: 'looting',
  UNBREAKING: 'unbreaking',
});

/** Maximum player health in half-hearts (10 hearts). @type {number} */
export const MAX_HEALTH = 20;

/** Maximum hunger in half-drumsticks. @type {number} */
export const MAX_HUNGER = 20;

/** Exhaustion points that burn one saturation (then one hunger) point. @type {number} */
export const EXHAUSTION_LEVEL = 4;

/** Exhaustion per metre sprinted. @type {number} */
export const EXHAUSTION_SPRINT = 0.1;

/** Exhaustion per metre swum. @type {number} */
export const EXHAUSTION_SWIM = 0.01;

/** Exhaustion per metre walked. @type {number} */
export const EXHAUSTION_WALK = 0.01;

/** Exhaustion of a standing jump. @type {number} */
export const EXHAUSTION_JUMP = 0.05;

/** Exhaustion of a sprint jump. @type {number} */
export const EXHAUSTION_SPRINT_JUMP = 0.2;

/** Exhaustion of breaking one block. @type {number} */
export const EXHAUSTION_MINE = 0.005;

/** Exhaustion of one melee swing that connects. @type {number} */
export const EXHAUSTION_ATTACK = 0.1;

/** Exhaustion of taking one hit. @type {number} */
export const EXHAUSTION_DAMAGE = 0.1;

/** Exhaustion of regenerating one half-heart. @type {number} */
export const EXHAUSTION_REGEN = 6;

/** Hunger must be strictly above this to sprint. @type {number} */
export const SPRINT_MIN_HUNGER = 6;

/** Hunger at or above which health regenerates at all. @type {number} */
export const REGEN_MIN_HUNGER = 18;

/** Seconds between two saturation-fuelled heals. @type {number} */
export const REGEN_FAST_INTERVAL = 0.5;

/** Seconds between two hunger-fuelled heals. @type {number} */
export const REGEN_SLOW_INTERVAL = 4;

/** Saturation burnt by one fast heal. @type {number} */
export const REGEN_SATURATION_COST = 1;

/** Seconds between two starvation hits. @type {number} */
export const STARVE_INTERVAL = 4;

/**
 * Health a starving player is left with, per difficulty
 * (`0` peaceful, `1` easy, `2` normal, `3` hard).
 * @type {Readonly<number[]>}
 */
export const STARVE_FLOOR = Object.freeze([MAX_HEALTH, 10, 2, 0]);

/**
 * Multiplier applied to hostile damage per difficulty.
 * @type {Readonly<number[]>}
 */
export const DIFFICULTY_DAMAGE = Object.freeze([0, 0.5, 1.0, 1.5]);

/** German difficulty names for the settings screen. @type {Readonly<string[]>} */
export const DIFFICULTY_LABELS = Object.freeze(['Friedlich', 'Einfach', 'Normal', 'Schwer']);

/** Invulnerability window after a hit, in seconds. @type {number} */
export const INVULNERABILITY_TIME = 0.5;

/** Maximum air supply, in ticks (15 s at 20 TPS) — matches `game/player.js`. @type {number} */
export const MAX_AIR = 300;

/** Air consumed per second while submerged, in air ticks. @type {number} */
export const AIR_DRAIN_RATE = 20;

/** Air recovered per second while breathing, in air ticks. @type {number} */
export const AIR_REFILL_RATE = 80;

/** Damage per second once the air supply is empty. @type {number} */
export const DROWN_DAMAGE_PER_SECOND = 1;

/** Damage per second while standing in lava. @type {number} */
export const LAVA_DAMAGE_PER_SECOND = 4;

/** Damage per second while on fire. @type {number} */
export const FIRE_DAMAGE_PER_SECOND = 1;

/** Damage per half-second below {@link VOID_LEVEL}. @type {number} */
export const VOID_DAMAGE = 4;

/** World Y below which the void starts hurting. @type {number} */
export const VOID_LEVEL = -80;

/** Damage per half-second while a solid block overlaps the eye. @type {number} */
export const SUFFOCATE_DAMAGE = 1;

/** Damage per half-second while touching a cactus. @type {number} */
export const CACTUS_DAMAGE = 1;

/** Seconds of burning that stepping into lava sets. @type {number} */
export const LAVA_FIRE_DURATION = 15;

/** Seconds of burning one level of Fire Aspect sets. @type {number} */
export const FIRE_ASPECT_DURATION = 4;

/** Blocks of free fall before fall damage starts. @type {number} */
export const FALL_SAFE_DISTANCE = 3;

/** Half-hearts of fall damage per block past {@link FALL_SAFE_DISTANCE}. @type {number} */
export const FALL_DAMAGE_PER_BLOCK = 1;

/** Horizontal knockback speed of a plain hit, in blocks/s. @type {number} */
export const KNOCKBACK_SPEED = 6.0;

/** Vertical knockback speed of a plain hit, in blocks/s. @type {number} */
export const KNOCKBACK_LIFT = 4.4;

/** Extra horizontal knockback per Knockback level (or per sprint hit), in blocks/s. @type {number} */
export const KNOCKBACK_BONUS = 3.6;

/** Damage multiplier of a critical hit. @type {number} */
export const CRITICAL_MULTIPLIER = 1.5;

/** Attack charge below which a hit can never crit. @type {number} */
export const CRITICAL_MIN_CHARGE = 0.9;

/**
 * Scale on the item table's attack speed, tuned so a sword recharges in
 * exactly `0.5 s` (`1 / 1.6 * 0.8`) and a bare fist in `0.2 s`.
 * @type {number}
 */
export const COOLDOWN_SCALE = 0.8;

/** Shortest attack cooldown in seconds. @type {number} */
export const COOLDOWN_MIN = 0.15;

/** Longest attack cooldown in seconds. @type {number} */
export const COOLDOWN_MAX = 2.0;

/** Maximum melee reach in blocks. @type {number} */
export const ATTACK_REACH = 3.5;

/**
 * Slack on every interval comparison. A 20 TPS tick accumulates `0.05` at a
 * time, and ten of those add up to `0.49999999999999994`, so an exact `>= 0.5`
 * would silently drop one hit in two on the half-second sources.
 * @type {number}
 */
const TIMER_EPSILON = 1e-9;

/** Cap on the summed enchantment protection factor. @type {number} */
export const EPF_CAP = 20;

/** Experience dropped on death, per level, capped at {@link DEATH_XP_CAP}. @type {number} */
export const DEATH_XP_PER_LEVEL = 7;

/** Hard cap on the experience dropped on death. @type {number} */
export const DEATH_XP_CAP = 100;

/**
 * Fall-damage multiplier of the block landed on. Hay and slime halve the
 * impact; slime negates it entirely unless the player lands sneaking (which is
 * also what disables the bounce), and water negates it separately.
 * @type {Readonly<Object<string, number>>}
 */
const FALL_BLOCK_MULTIPLIER = Object.freeze({
  hay_block: 0.5,
  slime_block: 0.5,
  honey_block: 0.2,
  cobweb: 0,
  powder_snow: 0,
});

/** Fall multiplier per block id, built once from {@link FALL_BLOCK_MULTIPLIER}. @type {Map<number, number>} */
const FALL_MULTIPLIER_BY_ID = new Map();
for (const name of Object.keys(FALL_BLOCK_MULTIPLIER)) {
  const id = B[name.toUpperCase()];
  if (typeof id === 'number' && id > 0) FALL_MULTIPLIER_BY_ID.set(id, FALL_BLOCK_MULTIPLIER[name]);
}

/** Block id of a slime block, or `-1`. @type {number} */
const SLIME_BLOCK_ID = typeof B.SLIME_BLOCK === 'number' ? B.SLIME_BLOCK : -1;

/** Block id of a cactus, or `-1`. @type {number} */
const CACTUS_ID = typeof B.CACTUS === 'number' ? B.CACTUS : -1;

/** Block id of water, or `-1`. @type {number} */
const WATER_ID = typeof B.WATER === 'number' ? B.WATER : -1;

/** Block id of lava, or `-1`. @type {number} */
const LAVA_ID = typeof B.LAVA === 'number' ? B.LAVA : -1;

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/**
 * Build one {@link DamageSourceDef}; every flag defaults to `false`.
 * @param {string} id source id
 * @param {string} label German noun
 * @param {string} death German death message
 * @param {Object} flags overrides
 * @returns {DamageSourceDef} the frozen record
 */
function source(id, label, death, flags) {
  return Object.freeze({
    id,
    label,
    death,
    bypassArmor: flags.bypassArmor === true,
    bypassEnchantments: flags.bypassEnchantments === true,
    fire: flags.fire === true,
    blast: flags.blast === true,
    projectile: flags.projectile === true,
    fall: flags.fall === true,
    knockback: flags.knockback !== false,
    scaleWithDifficulty: flags.scaleWithDifficulty === true,
  });
}

/** Keys already reported by {@link warnOnce}. @type {Set<string>} */
const warned = new Set();

/**
 * Log a problem exactly once per key — the combat system runs inside the game
 * tick and must never spam or throw.
 * @param {string} key de-duplication key
 * @param {string} message human readable message
 * @param {*} [err] the original error
 * @returns {void}
 */
function warnOnce(key, message, err) {
  if (warned.has(key)) return;
  warned.add(key);
  if (err !== undefined) console.warn(`[VOXELIA] combat: ${message}`, err);
  else console.warn(`[VOXELIA] combat: ${message}`);
}

/**
 * Coerce anything into a finite number.
 * @param {*} v candidate
 * @param {number} fallback value when `v` is not finite
 * @returns {number} a finite number
 */
function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Look up a damage source record; unknown ids fall back to `generic`.
 * @param {string} id source id
 * @returns {DamageSourceDef} the record
 */
function sourceDef(id) {
  const def = DAMAGE_SOURCES[id];
  return def === undefined ? DAMAGE_SOURCES.generic : def;
}

/**
 * Read the item id out of anything that could be a stack.
 * @param {*} stack an `ItemStack`, or null
 * @returns {number} item id, `0` when there is nothing usable
 */
function stackItemId(stack) {
  if (!stack) return 0;
  if (typeof stack.isEmpty === 'function' && stack.isEmpty()) return 0;
  const id = Number.isFinite(stack.itemId) ? stack.itemId : stack.id;
  return Number.isFinite(id) ? id | 0 : 0;
}

/**
 * Read an enchantment level off a stack without assuming its exact API.
 * @param {*} stack an `ItemStack`, or null
 * @param {string} id enchantment id
 * @returns {number} the level, `0` when absent
 */
function enchantLevel(stack, id) {
  if (!stack) return 0;
  try {
    if (typeof stack.getEnchantmentLevel === 'function') {
      return Math.max(0, stack.getEnchantmentLevel(id) | 0);
    }
    const list = stack.meta && stack.meta.enchantments;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return Math.max(0, list[i].level | 0);
      }
    }
  } catch (err) {
    warnOnce('enchant', 'an enchantment lookup failed', err);
  }
  return 0;
}

/* ========================================================================== */
/* Experience curve                                                           */
/* ========================================================================== */

/**
 * Experience needed to advance **from** `level` to `level + 1`.
 * The three official segments: `2L + 7` up to 15, `5L - 38` up to 30,
 * `9L - 158` from 31 on.
 * @param {number} level current level
 * @returns {number} points needed for the next level
 */
export function xpForLevel(level) {
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
export function totalXPForLevel(level) {
  const l = Math.max(0, Math.floor(num(level, 0)));
  if (l <= 16) return l * l + 6 * l;
  if (l <= 31) return 2.5 * l * l - 40.5 * l + 360;
  return 4.5 * l * l - 162.5 * l + 2220;
}

/* ========================================================================== */
/* CombatSystem                                                               */
/* ========================================================================== */

/**
 * The survival rules for the local player and everything that fights it.
 *
 * Emitted events:
 * - `'damage'` `(entity, amount, source, raw)` — damage actually applied.
 * - `'heal'` `(entity, amount)` — health restored.
 * - `'hunger'` `(hunger, saturation)` — the food bar changed.
 * - `'attack'` `(target, damage, {charge, critical, knockback})` — a swing hit.
 * - `'miss'` `(charge)` — a swing found nothing.
 * - `'kill'` `(entity, source)` — something the player hit died.
 * - `'xp'` `(xp, level, progress)` — experience changed.
 * - `'levelup'` `(level)` — a level was gained.
 * - `'death'` `({source, label, message, x, y, z, xp})` — the player died; the
 *   UI turns this into the death screen.
 * - `'respawn'` `()` — the player is alive again.
 *
 * @augments EventBus
 */
export class CombatSystem extends EventBus {
  /**
   * @param {?Object} world the chunk manager (`world/world.js`)
   * @param {?Object} entityManager the entity manager (`game/entities.js`)
   * @param {?Object} player the local player (`game/player.js`)
   * @param {?Object} audio the audio engine (`game/audio.js`), may be null
   * @param {?Object} particles the particle system (`render/particles.js`), may be null
   */
  constructor(world, entityManager, player, audio, particles) {
    super();

    /** @type {?Object} the world */
    this.world = world || null;
    /** @type {?Object} the entity manager */
    this.entities = entityManager || null;
    /** @type {?Object} the local player */
    this.player = null;
    /** @type {?Object} the audio engine */
    this.audio = audio || null;
    /** @type {?Object} the particle system */
    this.particles = particles || null;

    /** @type {number} difficulty: 0 peaceful, 1 easy, 2 normal, 3 hard */
    this.difficulty = 2;

    /** @type {boolean} `true` while the death screen owns the input */
    this.inputFrozen = false;

    /**
     * `true` when this system books the movement half of the exhaustion model
     * itself. The stock {@link Player} controller already charges sprinting,
     * jumping and swimming, so {@link CombatSystem#attach} clears the flag for
     * it and only mining, attacking, damage and regeneration are added here.
     * @type {boolean}
     */
    this.trackMovementExhaustion = true;

    /* ---- timers --------------------------------------------------------- */

    /** @type {number} seconds of invulnerability left */
    this.invulnerability = 0;
    /** @type {number} raw damage of the hit that opened the current window */
    this.lastDamage = 0;
    /** @type {string} source of the last hit, for the death message */
    this.lastDamageSource = DAMAGE_GENERIC;
    /** @type {number} seconds since the last swing, for the attack charge */
    this.attackTimer = COOLDOWN_MAX;
    /** @type {number} cooldown of the currently held weapon, in seconds */
    this.attackCooldown = COOLDOWN_MIN;

    /** @type {number} seconds accumulated toward a fast heal @private */
    this._fastRegen = 0;
    /** @type {number} seconds accumulated toward a slow heal @private */
    this._slowRegen = 0;
    /** @type {number} seconds accumulated toward a starvation hit @private */
    this._starveTimer = 0;
    /** @type {number} seconds accumulated toward a drowning hit @private */
    this._drownTimer = 0;
    /** @type {number} seconds accumulated toward a lava hit @private */
    this._lavaTimer = 0;
    /** @type {number} seconds accumulated toward a burning hit @private */
    this._fireTimer = 0;
    /** @type {number} seconds accumulated toward a void hit @private */
    this._voidTimer = 0;
    /** @type {number} seconds accumulated toward a suffocation hit @private */
    this._suffocateTimer = 0;
    /** @type {number} seconds accumulated toward a cactus hit @private */
    this._cactusTimer = 0;

    /** @type {number} highest Y reached during the current fall @private */
    this._fallPeak = 0;
    /** @type {boolean} whether the player was on the ground last tick @private */
    this._wasOnGround = true;
    /** @type {number} walked distance seen last tick, for exhaustion @private */
    this._lastWalked = 0;

    /** @type {?Function} the player's original `damage` method @private */
    this._originalDamage = null;
    /** @type {?Function} the player's original `addXP` method @private */
    this._originalAddXP = null;
    /** @type {?Function} the listener installed on the player's `'jump'` event @private */
    this._jumpListener = null;

    /** @type {number[]} scratch knockback direction @private */
    this._knockDir = [0, 0, 0];
    /** @type {Object[]} scratch list for entity queries @private */
    this._queryList = [];

    this.attach(player);
  }

  /* ====================================================================== */
  /* Wiring                                                                 */
  /* ====================================================================== */

  /**
   * Take ownership of a player's survival rules.
   *
   * Switches off the controller's own fall and air damage and re-points
   * `player.damage()` and `player.addXP()` at this system, so every existing
   * call site (the void guard, `EntityManager.explode()`, mob melee) runs the
   * full pipeline exactly once.
   *
   * @param {?Object} player the player to attach to, or null to just detach
   * @returns {void}
   */
  attach(player) {
    this.detach();
    if (!player) return;

    this.player = player;
    player.applyOwnFallDamage = false;
    player.applyOwnAirDamage = false;
    if (!Number.isFinite(player.fireTime)) player.fireTime = 0;
    if (!Number.isFinite(player.air)) player.air = MAX_AIR;

    // The stock controller already charges sprint/jump/swim exhaustion.
    this.trackMovementExhaustion = !(player instanceof Player);

    if (typeof player.damage === 'function') {
      this._originalDamage = player.damage;
      const self = this;
      player.damage = function combatDamage(amount, damageSource) {
        return self.dealDamage(player, amount, damageSource, null);
      };
    }
    if (typeof player.addXP === 'function') {
      this._originalAddXP = player.addXP;
      const self = this;
      player.addXP = function combatAddXP(points) {
        self.addXP(points);
        return player.xpLevel;
      };
    }
    if (this.trackMovementExhaustion && typeof player.on === 'function') {
      this._jumpListener = () => {
        this.addExhaustion(player.sprinting ? EXHAUSTION_SPRINT_JUMP : EXHAUSTION_JUMP);
      };
      player.on('jump', this._jumpListener);
    }

    this._fallPeak = num(player.position && player.position[1], 0);
    this._wasOnGround = player.onGround === true;
    this._lastWalked = num(player.walkedDistance, 0);
    this.refreshArmor();
  }

  /**
   * Give the player its own methods back and stop owning its rules.
   * @returns {void}
   */
  detach() {
    const player = this.player;
    if (!player) {
      this._originalDamage = null;
      this._originalAddXP = null;
      this._jumpListener = null;
      return;
    }
    if (this._originalDamage !== null) player.damage = this._originalDamage;
    if (this._originalAddXP !== null) player.addXP = this._originalAddXP;
    if (this._jumpListener !== null && typeof player.off === 'function') {
      player.off('jump', this._jumpListener);
    }
    player.applyOwnFallDamage = true;
    player.applyOwnAirDamage = true;
    this._originalDamage = null;
    this._originalAddXP = null;
    this._jumpListener = null;
    this.player = null;
  }

  /**
   * Swap the world reference (a new world was loaded).
   * @param {?Object} world the new world
   * @returns {void}
   */
  setWorld(world) {
    this.world = world || null;
  }

  /**
   * Set the difficulty.
   * @param {number} level `0` peaceful, `1` easy, `2` normal, `3` hard
   * @returns {number} the difficulty actually set
   */
  setDifficulty(level) {
    this.difficulty = clamp(Math.round(num(level, 2)), 0, 3);
    return this.difficulty;
  }

  /**
   * The per-source behaviour table, so the HUD and the death screen can look up
   * a label or a death message without duplicating it.
   * @returns {Readonly<Object<string, DamageSourceDef>>} the frozen table
   */
  getDamageSources() {
    return DAMAGE_SOURCES;
  }

  /**
   * Release every reference and restore the player.
   * @returns {void}
   */
  dispose() {
    this.detach();
    this.world = null;
    this.entities = null;
    this.audio = null;
    this.particles = null;
    if (this._listeners && typeof this._listeners.clear === 'function') {
      this._listeners.clear();
    }
  }

  /* ====================================================================== */
  /* Tick                                                                   */
  /* ====================================================================== */

  /**
   * Run one game tick of the survival rules.
   * @param {number} dt seconds since the previous tick
   * @param {?Object} [environment] the environment (`game/environment.js`),
   *   used to decide whether rain puts a fire out
   * @returns {void}
   */
  update(dt, environment) {
    const step = clamp(num(dt, 0), 0, 0.25);
    if (step <= 0) return;

    // Timers keep running even while dead, so the attack charge is full again
    // by the time the player respawns.
    if (this.invulnerability > 0) this.invulnerability = Math.max(0, this.invulnerability - step);
    if (this.invulnerability === 0) this.lastDamage = 0;
    // Capped so an idle player cannot drift the charge accumulator over hours.
    this.attackTimer = Math.min(this.attackTimer + step, COOLDOWN_MAX * 4);

    const player = this.player;
    if (!player) return;

    try {
      this.refreshArmor();
      this._updateBurning(step, environment);

      if (player.dead === true) return;

      const mode = player.gameMode;
      const survival = mode !== 'creative' && mode !== 'spectator';

      this.updateFallDamage(player);
      if (!survival) {
        this._resetEnvironmentTimers();
        return;
      }

      if (this.trackMovementExhaustion) this._trackMovementExhaustion(step);
      this.updateAir(step);
      this._updateEnvironmentDamage(step);
      this.updateHunger(step);
      this.updateHealth(step);
      this._enforceSprintRule();
    } catch (err) {
      warnOnce('update', 'the combat tick failed; survival rules are degraded', err);
    }
  }

  /**
   * Reset every environment damage accumulator (creative mode, or a respawn).
   * @returns {void}
   * @private
   */
  _resetEnvironmentTimers() {
    this._drownTimer = 0;
    this._lavaTimer = 0;
    this._fireTimer = 0;
    this._voidTimer = 0;
    this._suffocateTimer = 0;
    this._cactusTimer = 0;
    this._starveTimer = 0;
  }

  /* ====================================================================== */
  /* Armour                                                                 */
  /* ====================================================================== */

  /**
   * Recompute the player's armour points and toughness from the worn pieces
   * and mirror the point total onto `player.armor` for the HUD.
   * @returns {{points:number, toughness:number}} the current armour values
   */
  refreshArmor() {
    const player = this.player;
    const result = { points: 0, toughness: 0 };
    if (!player) return result;

    const inv = player.inventory;
    try {
      if (inv && typeof inv.totalArmorPoints === 'function') {
        result.points = num(inv.totalArmorPoints(), 0);
        result.toughness = typeof inv.totalArmorToughness === 'function'
          ? num(inv.totalArmorToughness(), 0) : 0;
      } else if (inv && typeof inv.armor === 'function') {
        for (let i = 0; i < 4; i++) {
          const id = stackItemId(inv.armor(i));
          if (id > 0) {
            result.points += num(armorPoints(id), 0);
            result.toughness += num(armorToughness(id), 0);
          }
        }
      } else {
        result.points = num(player.armor, 0);
      }
    } catch (err) {
      warnOnce('armor', 'the armour lookup failed', err);
      result.points = num(player.armor, 0);
    }

    player.armor = clamp(result.points, 0, 20);
    player.armorToughness = Math.max(0, result.toughness);
    return result;
  }

  /**
   * One worn armour piece, across the inventory shapes the player can carry.
   * @param {number} slot armour slot `0..3` (head, chest, legs, feet)
   * @returns {?Object} the `ItemStack`, or null
   * @private
   */
  _armorPiece(slot) {
    const inv = this.player && this.player.inventory;
    if (!inv) return null;
    try {
      if (typeof inv.armor === 'function') return inv.armor(slot);
      if (Array.isArray(inv.slots)) return inv.slots[SLOT.ARMOR_START + slot] || null;
    } catch (err) {
      warnOnce('armorSlot', 'an armour slot could not be read', err);
    }
    return null;
  }

  /**
   * Total enchantment protection factor of the worn armour against one source.
   * @param {DamageSourceDef} def the damage source
   * @returns {number} the EPF, before the {@link EPF_CAP}
   * @private
   */
  _protectionFactor(def) {
    if (def.bypassEnchantments) return 0;
    let epf = 0;
    for (let i = 0; i < 4; i++) {
      const piece = this._armorPiece(i);
      if (!piece) continue;
      epf += enchantLevel(piece, ENCHANTMENTS.PROTECTION);
      if (def.fire) epf += 2 * enchantLevel(piece, ENCHANTMENTS.FIRE_PROTECTION);
      if (def.blast) epf += 2 * enchantLevel(piece, ENCHANTMENTS.BLAST_PROTECTION);
      if (def.projectile) epf += 2 * enchantLevel(piece, ENCHANTMENTS.PROJECTILE_PROTECTION);
      if (def.fall) epf += 3 * enchantLevel(piece, ENCHANTMENTS.FEATHER_FALLING);
    }
    return epf;
  }

  /**
   * Reduce incoming damage by armour.
   *
   * Uses the real curve — points and toughness together decide how much of a
   * big hit gets through — followed by enchantment protection, and wears the
   * worn pieces down by one point per four half-hearts.
   *
   * @param {Object} entity the entity being hit (the player, or a mob)
   * @param {number} amount raw damage in half-hearts
   * @param {string} damageSource a {@link DAMAGE} value
   * @returns {number} the damage left after armour
   */
  applyArmor(entity, amount, damageSource) {
    const raw = Math.max(0, num(amount, 0));
    if (raw <= 0) return 0;
    const def = sourceDef(damageSource);
    if (def.bypassArmor && def.bypassEnchantments) return raw;

    let points = 0;
    let toughness = 0;
    const isPlayer = entity === this.player;
    if (isPlayer) {
      points = clamp(num(entity.armor, 0), 0, 20);
      toughness = Math.max(0, num(entity.armorToughness, 0));
    } else if (entity && entity.def && Number.isFinite(entity.def.armor)) {
      points = clamp(entity.def.armor, 0, 20);
    }

    let damage = raw;
    if (!def.bypassArmor && points > 0) {
      // Vanilla curve: high damage punches through a thin armour bar, and
      // toughness is what slows that punch-through down.
      const cut = Math.min(20, Math.max(points / 5, points - raw / (2 + toughness / 4)));
      damage = raw * (1 - cut / 25);
    }

    if (isPlayer && !def.bypassEnchantments) {
      const epf = Math.min(EPF_CAP, this._protectionFactor(def));
      if (epf > 0) damage *= 1 - epf * 0.04;
    }

    if (isPlayer && !def.bypassArmor) this._damageArmor(raw);
    return Math.max(0, damage);
  }

  /**
   * Wear the worn armour down after a hit: one durability point per four
   * half-hearts of raw damage, at least one.
   * @param {number} raw raw damage of the hit
   * @returns {void}
   * @private
   */
  _damageArmor(raw) {
    const inv = this.player && this.player.inventory;
    if (!inv || typeof inv.damageSlot !== 'function') return;
    const wear = Math.max(1, Math.floor(raw / 4));
    for (let i = 0; i < 4; i++) {
      const piece = this._armorPiece(i);
      if (!piece) continue;
      const unbreaking = enchantLevel(piece, ENCHANTMENTS.UNBREAKING);
      // Unbreaking on armour skips a point with 60 % / (level + 1) probability.
      if (unbreaking > 0 && Math.random() < 0.6 - 0.6 / (unbreaking + 1)) continue;
      try {
        inv.damageSlot(SLOT.ARMOR_START + i, wear);
      } catch (err) {
        warnOnce('armorWear', 'armour could not be damaged', err);
      }
    }
    this.refreshArmor();
  }

  /* ====================================================================== */
  /* Damage                                                                 */
  /* ====================================================================== */

  /**
   * Hurt something. This is the single entry point for every damage source in
   * the game — the player, a mob, a dropped item, a boat.
   *
   * For the player it runs the whole pipeline: difficulty scaling, the
   * invulnerability window (a stronger hit inside the window still applies the
   * difference), armour, exhaustion, knockback, effects and death. For anything
   * else it delegates to the entity's own `damage()` and only adds knockback.
   *
   * @param {?Object} entity the victim
   * @param {number} amount raw damage in half-hearts
   * @param {string} [damageSource] a {@link DAMAGE} value
   * @param {?ArrayLike<number>} [knockbackDir] direction the victim is pushed
   *   in (need not be normalized); `null` for no knockback
   * @returns {number} the damage actually applied
   */
  dealDamage(entity, amount, damageSource = DAMAGE_GENERIC, knockbackDir = null) {
    let raw = Math.max(0, num(amount, 0));
    if (!entity || raw <= 0) return 0;
    const id = typeof damageSource === 'string' ? damageSource : DAMAGE_GENERIC;
    const def = sourceDef(id);

    if (def.scaleWithDifficulty) {
      raw *= DIFFICULTY_DAMAGE[this.difficulty];
      if (raw <= 0) return 0;
    }

    if (entity === this.player) return this._damagePlayer(raw, def, knockbackDir);
    return this._damageEntity(entity, raw, def, knockbackDir);
  }

  /**
   * Apply damage to the local player.
   * @param {number} raw raw damage after the difficulty scale
   * @param {DamageSourceDef} def the source record
   * @param {?ArrayLike<number>} knockbackDir knockback direction, or null
   * @returns {number} the damage actually applied
   * @private
   */
  _damagePlayer(raw, def, knockbackDir) {
    const player = this.player;
    if (!player || player.dead === true) return 0;
    const mode = player.gameMode;
    if (mode === 'creative' || mode === 'spectator') return 0;

    /* ---- invulnerability window ------------------------------------------ */
    // The epsilon matters: a source on a 0.5 s cadence (lava, the void) is
    // exactly in phase with the window, and float noise must not swallow every
    // second hit.
    let effective = raw;
    if (this.invulnerability > 1e-6) {
      if (raw <= this.lastDamage) return 0;
      // A stronger hit inside the window only tops the previous one up.
      effective = raw - this.lastDamage;
    }

    const applied = this.applyArmor(player, effective, def.id);
    if (applied <= 0 && effective > 0) {
      // Fully absorbed, but the window and the flash still happen.
      this.invulnerability = INVULNERABILITY_TIME;
      this.lastDamage = raw;
      return 0;
    }

    player.health = clamp(num(player.health, MAX_HEALTH) - applied, 0,
      num(player.maxHealth, MAX_HEALTH));
    this.invulnerability = INVULNERABILITY_TIME;
    this.lastDamage = raw;
    this.lastDamageSource = def.id;
    player.hurtTime = INVULNERABILITY_TIME;
    this._syncPlayerImmunity(raw);
    this.addExhaustion(EXHAUSTION_DAMAGE);

    if (knockbackDir && def.knockback) {
      this.applyKnockback(player, knockbackDir[0], knockbackDir[2], 1, 0);
    }

    this._playHurtEffects(player, def);
    this._emitPlayer('damage', applied, def.id);
    this.emit('damage', player, applied, def.id, raw);

    if (player.health <= 0) this.onPlayerDeath(def.id);
    return applied;
  }

  /**
   * Mirror the invulnerability window onto the controller's own bookkeeping so
   * a direct `Player#damage` call (if this system is ever detached mid-flight)
   * agrees with what already happened.
   * @param {number} raw raw damage of the hit
   * @returns {void}
   * @private
   */
  _syncPlayerImmunity(raw) {
    const player = this.player;
    if (!player) return;
    if (Number.isFinite(player._immunity)) player._immunity = INVULNERABILITY_TIME;
    if (Number.isFinite(player._lastDamage)) player._lastDamage = raw;
  }

  /**
   * Apply damage to any entity that is not the player.
   * @param {Object} entity the victim
   * @param {number} raw raw damage
   * @param {DamageSourceDef} def the source record
   * @param {?ArrayLike<number>} knockbackDir knockback direction, or null
   * @returns {number} the damage applied (best effort)
   * @private
   */
  _damageEntity(entity, raw, def, knockbackDir) {
    const before = num(entity.health, 0);
    const reduced = this.applyArmor(entity, raw, def.id);
    if (reduced <= 0) return 0;

    let ok = false;
    try {
      if (typeof entity.damage === 'function') ok = entity.damage(reduced, def.id) !== false;
      else if (Number.isFinite(entity.health)) { entity.health -= reduced; ok = true; }
    } catch (err) {
      warnOnce('entityDamage', 'an entity refused damage', err);
      return 0;
    }
    if (!ok) return 0;

    if (knockbackDir && def.knockback) {
      this.applyKnockback(entity, knockbackDir[0], knockbackDir[2], 1, 0);
    }
    if (typeof entity.onHurt === 'function') {
      try { entity.onHurt(def.id, this.player); } catch (err) {
        warnOnce('onHurt', 'an entity hurt hook failed', err);
      }
    }
    const applied = Math.max(0, before - num(entity.health, before));
    this.emit('damage', entity, applied > 0 ? applied : reduced, def.id, raw);
    if (entity.dead === true || num(entity.health, 1) <= 0) {
      this.emit('kill', entity, def.id);
    }
    return applied > 0 ? applied : reduced;
  }

  /**
   * Push an entity away from a hit.
   * @param {Object} entity the victim (needs a `velocity`)
   * @param {number} dx horizontal X of the push direction (need not be unit)
   * @param {number} dz horizontal Z of the push direction
   * @param {number} [scale] overall strength multiplier
   * @param {number} [bonus] extra knockback levels (sprint hit, Knockback)
   * @returns {void}
   */
  applyKnockback(entity, dx, dz, scale = 1, bonus = 0) {
    if (!entity || !entity.velocity || entity.velocity.length < 3) return;
    let x = num(dx, 0);
    let z = num(dz, 0);
    const len = Math.hypot(x, z);
    if (len < 1e-4) {
      // Straight up when there is no usable direction.
      x = 0; z = 0;
    } else {
      x /= len; z /= len;
    }

    let resist = 0;
    if (entity === this.player) resist = this._playerKnockbackResistance();
    else if (entity.def && Number.isFinite(entity.def.knockbackResistance)) {
      resist = clamp(entity.def.knockbackResistance, 0, 1);
    }
    const factor = Math.max(0, 1 - resist) * Math.max(0, num(scale, 1));
    if (factor <= 0) return;

    const push = (KNOCKBACK_SPEED + KNOCKBACK_BONUS * Math.max(0, bonus)) * factor;
    const v = entity.velocity;
    v[0] = v[0] * 0.5 + x * push;
    v[2] = v[2] * 0.5 + z * push;
    v[1] = Math.min(v[1] * 0.5 + KNOCKBACK_LIFT * factor, KNOCKBACK_LIFT * 1.3);
    entity.onGround = false;
  }

  /**
   * Summed knockback resistance of the player's worn armour, `0..1`.
   * @returns {number} the resistance
   * @private
   */
  _playerKnockbackResistance() {
    let total = 0;
    for (let i = 0; i < 4; i++) {
      const id = stackItemId(this._armorPiece(i));
      if (id > 0) total += num(knockbackResistance(id), 0);
    }
    return clamp(total, 0, 1);
  }

  /**
   * Fire the sound and the particles of a hit taken.
   * @param {Object} player the player
   * @param {DamageSourceDef} def the source record
   * @returns {void}
   * @private
   */
  _playHurtEffects(player, def) {
    const p = player.position;
    const x = num(p && p[0], 0);
    const y = num(p && p[1], 0) + num(player.eyeHeight, 1.62) * 0.6;
    const z = num(p && p[2], 0);
    this._play(def.fire ? 'burn' : 'hurt', x, y, z, 1, 0.9 + Math.random() * 0.2);
    this._spawn('crit', x, y, z, { count: 6, speed: 2.2, color: [0.75, 0.05, 0.05] });
  }

  /* ====================================================================== */
  /* Environmental damage                                                   */
  /* ====================================================================== */

  /**
   * Lava, burning, the void, suffocation and cactus contact.
   * @param {number} dt seconds
   * @returns {void}
   * @private
   */
  _updateEnvironmentDamage(dt) {
    const player = this.player;
    const p = player.position;
    const x = num(p && p[0], 0);
    const y = num(p && p[1], 0);
    const z = num(p && p[2], 0);

    /* ---- the void --------------------------------------------------------- */
    if (y < VOID_LEVEL) {
      this._voidTimer += dt;
      while (this._voidTimer >= 0.5 - TIMER_EPSILON) {
        this._voidTimer -= 0.5;
        this.dealDamage(player, VOID_DAMAGE, DAMAGE.VOID, null);
        if (player.dead === true) return;
      }
    } else {
      this._voidTimer = 0;
    }

    /* ---- lava -------------------------------------------------------------- */
    if (player.inLava === true) {
      player.fireTime = LAVA_FIRE_DURATION;
      this._lavaTimer += dt;
      while (this._lavaTimer >= 0.5 - TIMER_EPSILON) {
        this._lavaTimer -= 0.5;
        this.dealDamage(player, LAVA_DAMAGE_PER_SECOND * 0.5, DAMAGE.LAVA, null);
        if (player.dead === true) return;
      }
    } else {
      this._lavaTimer = 0;
    }

    /* ---- burning ----------------------------------------------------------- */
    if (num(player.fireTime, 0) > 0 && player.inLava !== true) {
      this._fireTimer += dt;
      while (this._fireTimer >= 1 - TIMER_EPSILON) {
        this._fireTimer -= 1;
        this.dealDamage(player, FIRE_DAMAGE_PER_SECOND, DAMAGE.FIRE, null);
        if (player.dead === true) return;
      }
    } else {
      this._fireTimer = 0;
    }

    /* ---- suffocation ------------------------------------------------------- */
    if (this._isSuffocating(x, y + num(player.eyeHeight, 1.62), z)) {
      this._suffocateTimer += dt;
      while (this._suffocateTimer >= 0.5 - TIMER_EPSILON) {
        this._suffocateTimer -= 0.5;
        this.dealDamage(player, SUFFOCATE_DAMAGE, DAMAGE.SUFFOCATE, null);
        if (player.dead === true) return;
      }
    } else {
      this._suffocateTimer = 0;
    }

    /* ---- cactus ------------------------------------------------------------ */
    if (this._touchesBlock(CACTUS_ID)) {
      this._cactusTimer += dt;
      while (this._cactusTimer >= 0.5 - TIMER_EPSILON) {
        this._cactusTimer -= 0.5;
        this.dealDamage(player, CACTUS_DAMAGE, DAMAGE.CACTUS, null);
        if (player.dead === true) return;
      }
    } else {
      this._cactusTimer = 0;
    }
  }

  /**
   * Burn down the fire timer and put the fire out in water or rain.
   * @param {number} dt seconds
   * @param {?Object} environment the environment, for the rain check
   * @returns {void}
   * @private
   */
  _updateBurning(dt, environment) {
    const player = this.player;
    if (!player) return;
    let fire = num(player.fireTime, 0);
    if (fire <= 0) {
      player.fireTime = 0;
      return;
    }

    if (player.inWater === true || num(player.submerged, 0) > 0.1) {
      player.fireTime = 0;
      this._fireTimer = 0;
      return;
    }
    if (environment && typeof environment.isPrecipitatingAt === 'function') {
      const p = player.position;
      try {
        if (environment.isPrecipitatingAt(this.world, num(p && p[0], 0),
          num(p && p[1], 0) + 1, num(p && p[2], 0))) {
          player.fireTime = 0;
          this._fireTimer = 0;
          return;
        }
      } catch (err) {
        warnOnce('rainCheck', 'the precipitation query failed', err);
      }
    }

    fire = Math.max(0, fire - dt);
    player.fireTime = fire;
    if (fire > 0 && this.particles) {
      const p = player.position;
      this._spawn('flame', num(p && p[0], 0), num(p && p[1], 0) + 0.6, num(p && p[2], 0),
        { count: 1, spread: 0.28, speed: 0.6 });
    }
  }

  /**
   * Is a solid block sitting inside the player's eye?
   * @param {number} x eye X
   * @param {number} y eye Y
   * @param {number} z eye Z
   * @returns {boolean} `true` when the eye is inside a solid box
   * @private
   */
  _isSuffocating(x, y, z) {
    const world = this.world;
    if (!world || typeof world.getBlock !== 'function') return false;
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    let id = 0;
    try {
      id = world.getBlock(bx, by, bz) | 0;
    } catch (err) {
      warnOnce('suffocateBlock', 'a block lookup failed', err);
      return false;
    }
    if (id <= 0 || !isSolid(id) || !isOpaque(id)) return false;

    const boxes = blockAABBs(id, 0);
    const lx = x - bx;
    const ly = y - by;
    const lz = z - bz;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (lx >= b[0] && lx <= b[3] && ly >= b[1] && ly <= b[4] && lz >= b[2] && lz <= b[5]) {
        return true;
      }
    }
    return false;
  }

  /**
   * Does the player's box overlap any block of a given id?
   * @param {number} blockId block id to look for; `-1` disables the test
   * @returns {boolean} `true` on contact
   * @private
   */
  _touchesBlock(blockId) {
    if (blockId < 0) return false;
    const world = this.world;
    const player = this.player;
    if (!world || typeof world.getBlock !== 'function' || !player) return false;

    const box = player.aabb;
    if (!box || !Number.isFinite(box.minX)) return false;
    // Shrink slightly so merely standing next to a cactus is safe.
    const inset = 0.1;
    const x0 = Math.floor(box.minX + inset);
    const x1 = Math.floor(box.maxX - inset);
    const y0 = Math.floor(box.minY + 0.02);
    const y1 = Math.floor(box.maxY - 0.02);
    const z0 = Math.floor(box.minZ + inset);
    const z1 = Math.floor(box.maxZ - inset);

    try {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            if ((world.getBlock(x, y, z) | 0) === blockId) return true;
          }
        }
      }
    } catch (err) {
      warnOnce('touchBlock', 'a contact block lookup failed', err);
    }
    return false;
  }

  /* ====================================================================== */
  /* Air                                                                    */
  /* ====================================================================== */

  /**
   * Drain and refill the air supply, and drown the player once it is empty.
   * @param {number} dt seconds
   * @returns {void}
   */
  updateAir(dt) {
    const player = this.player;
    if (!player) return;
    const fluid = this._eyeFluid();

    if (fluid !== 0) {
      // Respiration buys a level's worth of extra breath per point.
      const respiration = enchantLevel(this._armorPiece(0), ENCHANTMENTS.RESPIRATION);
      const drain = AIR_DRAIN_RATE / (1 + respiration);
      player.air = Math.max(0, num(player.air, MAX_AIR) - dt * drain);
      if (player.air <= 0) {
        this._drownTimer += dt;
        while (this._drownTimer >= 1 - TIMER_EPSILON) {
          this._drownTimer -= 1;
          this.dealDamage(player, DROWN_DAMAGE_PER_SECOND, DAMAGE.DROWN, null);
          if (player.dead === true) return;
        }
      } else if (this.particles && Math.random() < dt * 4) {
        const p = player.position;
        this._spawn('bubble', num(p && p[0], 0),
          num(p && p[1], 0) + num(player.eyeHeight, 1.62), num(p && p[2], 0),
          { count: 1, spread: 0.2, speed: 0.4 });
      }
    } else {
      this._drownTimer = 0;
      player.air = Math.min(MAX_AIR, num(player.air, MAX_AIR) + dt * AIR_REFILL_RATE);
    }
  }

  /**
   * Which fluid the player's eye is in.
   * @returns {number} `0` none, `1` water, `2` lava
   * @private
   */
  _eyeFluid() {
    const world = this.world;
    const player = this.player;
    if (!world || typeof world.getBlock !== 'function' || !player) return 0;
    const p = player.position;
    try {
      const id = world.getBlock(
        Math.floor(num(p && p[0], 0)),
        Math.floor(num(p && p[1], 0) + num(player.eyeHeight, 1.62)),
        Math.floor(num(p && p[2], 0))) | 0;
      if (id === LAVA_ID) return 2;
      if (id === WATER_ID) return 1;
    } catch (err) {
      warnOnce('eyeFluid', 'the eye fluid lookup failed', err);
    }
    return 0;
  }

  /* ====================================================================== */
  /* Fall damage                                                            */
  /* ====================================================================== */

  /**
   * Track a fall and hurt the entity when it lands.
   *
   * One half-heart per block past {@link FALL_SAFE_DISTANCE}, negated by water,
   * scaled by what was landed on (hay and slime halve it, honey nearly removes
   * it, slime negates it entirely unless the landing was a sneak) and reduced
   * by Feather Falling through {@link CombatSystem#applyArmor}.
   *
   * @param {Object} entity the falling entity; usually the player
   * @returns {number} the damage dealt on this tick (`0` while still falling)
   */
  updateFallDamage(entity) {
    if (!entity || !entity.position) return 0;
    const isPlayer = entity === this.player;
    const y = num(entity.position[1], 0);
    const onGround = entity.onGround === true;

    // Flight, climbing and the non-survival modes cancel the fall outright.
    if (isPlayer && (entity.flying === true || entity.climbing === true ||
        entity.gameMode === 'creative' || entity.gameMode === 'spectator')) {
      this._setFallPeak(entity, y, onGround);
      entity.fallDistance = 0;
      return 0;
    }

    /* ---- water and lava break a fall completely ----------------------------- */
    if (entity.inWater === true || entity.inLava === true ||
        num(entity.submerged, 0) > 0.1) {
      this._setFallPeak(entity, y, onGround);
      entity.fallDistance = 0;
      return 0;
    }

    /* ---- still in the air --------------------------------------------------- */
    if (!onGround) {
      const peak = Math.max(this._getFallPeak(entity, y), y);
      this._setFallPeak(entity, peak, false);
      entity.fallDistance = Math.max(0, peak - y);
      return 0;
    }

    /* ---- landed ------------------------------------------------------------- */
    const fall = Math.max(0, this._getFallPeak(entity, y) - y);
    const justLanded = !this._wasGrounded(entity);
    this._setFallPeak(entity, y, true);
    entity.fallDistance = 0;
    if (!justLanded || fall <= FALL_SAFE_DISTANCE) return 0;

    const multiplier = this._fallMultiplier(entity);
    if (multiplier <= 0) return 0;

    const damage = Math.floor((fall - FALL_SAFE_DISTANCE) * FALL_DAMAGE_PER_BLOCK * multiplier);
    if (damage <= 0) return 0;
    return this.dealDamage(entity, damage, DAMAGE.FALL, null);
  }

  /**
   * Highest Y reached during the current fall. The player's peak lives on this
   * system; any other entity carries its own, so one call site can service the
   * whole world without them stepping on each other.
   * @param {Object} entity the falling entity
   * @param {number} fallback value when nothing has been recorded yet
   * @returns {number} the peak Y
   * @private
   */
  _getFallPeak(entity, fallback) {
    if (entity === this.player) return this._fallPeak;
    return Number.isFinite(entity._combatFallPeak) ? entity._combatFallPeak : fallback;
  }

  /**
   * Record the fall peak and the grounded flag of an entity.
   * @param {Object} entity the falling entity
   * @param {number} peak peak Y to store
   * @param {boolean} grounded whether the entity is on the ground now
   * @returns {void}
   * @private
   */
  _setFallPeak(entity, peak, grounded) {
    if (entity === this.player) {
      this._fallPeak = peak;
      this._wasOnGround = grounded;
      return;
    }
    entity._combatFallPeak = peak;
    entity._combatGrounded = grounded;
  }

  /**
   * Was the entity on the ground on the previous tick?
   * @param {Object} entity the entity
   * @returns {boolean} `true` when it was already grounded
   * @private
   */
  _wasGrounded(entity) {
    if (entity === this.player) return this._wasOnGround;
    return entity._combatGrounded === true;
  }

  /**
   * Fall-damage multiplier of the block an entity landed on.
   * @param {Object} entity the entity
   * @returns {number} the multiplier, `1` for ordinary ground
   * @private
   */
  _fallMultiplier(entity) {
    const world = this.world;
    if (!world || typeof world.getBlock !== 'function') return 1;
    const p = entity.position;
    let id = 0;
    try {
      id = world.getBlock(
        Math.floor(num(p && p[0], 0)),
        Math.floor(num(p && p[1], 0) - 0.2),
        Math.floor(num(p && p[2], 0))) | 0;
    } catch (err) {
      warnOnce('fallBlock', 'the landing block lookup failed', err);
      return 1;
    }
    if (id === SLIME_BLOCK_ID && entity.sneaking !== true) return 0;
    const m = FALL_MULTIPLIER_BY_ID.get(id);
    return m === undefined ? 1 : m;
  }

  /* ====================================================================== */
  /* Hunger                                                                 */
  /* ====================================================================== */

  /**
   * Convert accumulated exhaustion into saturation and then hunger.
   * @param {number} dt seconds
   * @returns {void}
   */
  updateHunger(dt) {
    void dt;
    const player = this.player;
    if (!player) return;

    const hungerBefore = num(player.hunger, MAX_HUNGER);
    const saturationBefore = num(player.saturation, 0);

    let exhaustion = num(player.exhaustion, 0);
    let saturation = saturationBefore;
    let hunger = hungerBefore;
    let guard = 0;
    while (exhaustion >= EXHAUSTION_LEVEL && guard++ < 64) {
      exhaustion -= EXHAUSTION_LEVEL;
      if (saturation > 0) saturation = Math.max(0, saturation - 1);
      else hunger = Math.max(0, hunger - 1);
    }
    player.exhaustion = exhaustion;
    player.saturation = clamp(saturation, 0, MAX_HUNGER);
    player.hunger = clamp(hunger, 0, MAX_HUNGER);
    // Saturation can never exceed the food bar it sits on.
    if (player.saturation > player.hunger) player.saturation = player.hunger;

    if (player.hunger !== hungerBefore || player.saturation !== saturationBefore) {
      this.emit('hunger', player.hunger, player.saturation);
    }
  }

  /**
   * Add exhaustion. Every {@link EXHAUSTION_LEVEL} points cost one saturation,
   * and once saturation is gone, one hunger.
   * @param {number} value exhaustion points
   * @returns {void}
   */
  addExhaustion(value) {
    const player = this.player;
    const v = num(value, 0);
    if (!player || v <= 0) return;
    if (player.gameMode !== 'survival') return;
    player.exhaustion = num(player.exhaustion, 0) + v;
  }

  /**
   * Charge the exhaustion the player earned by moving, for controllers that do
   * not book it themselves.
   * @param {number} dt seconds
   * @returns {void}
   * @private
   */
  _trackMovementExhaustion(dt) {
    void dt;
    const player = this.player;
    const walked = num(player.walkedDistance, 0);
    // A negative delta means the controller reset its odometer; start over.
    const delta = walked - this._lastWalked;
    this._lastWalked = walked;
    if (!(delta > 0)) return;

    if (num(player.submerged, 0) > 0.4) this.addExhaustion(EXHAUSTION_SWIM * delta);
    else if (player.sprinting === true) this.addExhaustion(EXHAUSTION_SPRINT * delta);
    else if (player.onGround === true) this.addExhaustion(EXHAUSTION_WALK * delta);
  }

  /**
   * Charge the exhaustion of breaking one block. `game/interaction.js` calls
   * `player.addExhaustion()` directly; this is the equivalent entry point for
   * anything that goes through the combat system.
   * @returns {void}
   */
  onBlockBroken() {
    this.addExhaustion(EXHAUSTION_MINE);
  }

  /**
   * Sprinting needs hunger strictly above {@link SPRINT_MIN_HUNGER}.
   * @returns {void}
   * @private
   */
  _enforceSprintRule() {
    const player = this.player;
    if (!player || player.gameMode !== 'survival') return;
    if (player.sprinting === true && num(player.hunger, MAX_HUNGER) <= SPRINT_MIN_HUNGER) {
      player.sprinting = false;
    }
  }

  /* ====================================================================== */
  /* Health                                                                 */
  /* ====================================================================== */

  /**
   * Regeneration and starvation.
   *
   * With hunger at {@link REGEN_MIN_HUNGER} or above and saturation left, a
   * half-heart returns every {@link REGEN_FAST_INTERVAL} at the cost of
   * saturation. With the same hunger but no saturation it takes
   * {@link REGEN_SLOW_INTERVAL}. At hunger zero the player starves down to the
   * difficulty's floor instead.
   *
   * @param {number} dt seconds
   * @returns {void}
   */
  updateHealth(dt) {
    const player = this.player;
    if (!player || player.dead === true) return;

    const health = num(player.health, MAX_HEALTH);
    const maxHealth = num(player.maxHealth, MAX_HEALTH);
    const hunger = num(player.hunger, MAX_HUNGER);
    const saturation = num(player.saturation, 0);

    /* ---- starvation -------------------------------------------------------- */
    if (hunger <= 0) {
      this._fastRegen = 0;
      this._slowRegen = 0;
      this._starveTimer += dt;
      while (this._starveTimer >= STARVE_INTERVAL - TIMER_EPSILON) {
        this._starveTimer -= STARVE_INTERVAL;
        const floor = STARVE_FLOOR[this.difficulty];
        if (player.health > floor) {
          this.dealDamage(player, 1, DAMAGE.STARVE, null);
          if (player.dead === true) return;
        }
      }
      return;
    }
    this._starveTimer = 0;

    if (health >= maxHealth || hunger < REGEN_MIN_HUNGER) {
      this._fastRegen = 0;
      this._slowRegen = 0;
      return;
    }

    /* ---- fast regeneration ------------------------------------------------- */
    if (saturation > 0) {
      this._slowRegen = 0;
      this._fastRegen += dt;
      while (this._fastRegen >= REGEN_FAST_INTERVAL - TIMER_EPSILON && player.health < maxHealth &&
             player.saturation > 0) {
        this._fastRegen -= REGEN_FAST_INTERVAL;
        this._heal(1);
        player.saturation = Math.max(0, num(player.saturation, 0) - REGEN_SATURATION_COST);
      }
      return;
    }

    /* ---- slow regeneration -------------------------------------------------- */
    this._fastRegen = 0;
    this._slowRegen += dt;
    while (this._slowRegen >= REGEN_SLOW_INTERVAL - TIMER_EPSILON && player.health < maxHealth) {
      this._slowRegen -= REGEN_SLOW_INTERVAL;
      this._heal(1);
      this.addExhaustion(EXHAUSTION_REGEN);
    }
  }

  /**
   * Restore health and raise the event.
   * @param {number} amount half-hearts
   * @returns {number} the amount actually restored
   * @private
   */
  _heal(amount) {
    const player = this.player;
    if (!player) return 0;
    const before = num(player.health, 0);
    const maxHealth = num(player.maxHealth, MAX_HEALTH);
    player.health = clamp(before + Math.max(0, num(amount, 0)), 0, maxHealth);
    const healed = player.health - before;
    if (healed > 0) this.emit('heal', player, healed);
    return healed;
  }

  /**
   * Restore health from the outside (a golden apple, a command).
   * @param {number} amount half-hearts
   * @returns {number} the amount actually restored
   */
  heal(amount) {
    return this._heal(amount);
  }

  /* ====================================================================== */
  /* Attacking                                                              */
  /* ====================================================================== */

  /**
   * Attack cooldown of the currently held item, in seconds.
   * @returns {number} the cooldown
   */
  getAttackCooldown() {
    const player = this.player;
    let speed = 4;
    if (player) {
      const id = stackItemId(this._heldStack());
      if (id > 0) speed = Math.max(0.1, num(attackSpeed(id), 4));
    }
    return clamp(COOLDOWN_SCALE / speed, COOLDOWN_MIN, COOLDOWN_MAX);
  }

  /**
   * How far the attack has recharged, `0..1`. The HUD draws this as the
   * cooldown bar under the crosshair.
   * @returns {number} the charge
   */
  getAttackCharge() {
    this.attackCooldown = this.getAttackCooldown();
    return clamp(this.attackTimer / this.attackCooldown, 0, 1);
  }

  /**
   * The stack in the player's main hand.
   * @returns {?Object} the `ItemStack`, or null
   * @private
   */
  _heldStack() {
    const player = this.player;
    if (!player) return null;
    try {
      if (typeof player.getHeldItem === 'function') return player.getHeldItem();
    } catch (err) {
      warnOnce('heldItem', 'the held item could not be read', err);
    }
    return null;
  }

  /**
   * Swing at a target.
   *
   * The damage scales with the attack charge — a spammed click lands a fifth of
   * a timed one — plus Sharpness/Smite/Bane of Arthropods, a 50 % critical
   * bonus for hitting while falling, sprint knockback and Fire Aspect.
   *
   * @param {?Object} target the entity to hit; when omitted the system picks
   *   whatever is under the crosshair within {@link ATTACK_REACH}
   * @returns {number} the damage dealt, `0` for a miss
   */
  playerAttack(target) {
    const player = this.player;
    if (!player || player.dead === true) return 0;

    const charge = this.getAttackCharge();
    this.attackTimer = 0;

    const victim = target || this.pickAttackTarget();
    if (!victim) {
      this.emit('miss', charge);
      return 0;
    }
    if (player.gameMode === 'spectator') return 0;

    const stack = this._heldStack();
    const itemId = stackItemId(stack);

    /* ---- base damage -------------------------------------------------------- */
    let damage = itemId > 0 ? Math.max(1, num(attackDamage(itemId), 1)) : 1;

    /* ---- weapon enchantments ------------------------------------------------ */
    const sharpness = enchantLevel(stack, ENCHANTMENTS.SHARPNESS);
    if (sharpness > 0) damage += 1 + 0.5 * (sharpness - 1);
    const undead = victim.def && victim.def.undead === true;
    const arthropod = victim.def && victim.def.arthropod === true;
    if (undead) damage += 2.5 * enchantLevel(stack, ENCHANTMENTS.SMITE);
    if (arthropod) damage += 2.5 * enchantLevel(stack, ENCHANTMENTS.BANE_OF_ARTHROPODS);

    /* ---- cooldown scaling --------------------------------------------------- */
    // 20 % at a dead-cold swing, 100 % at a fully charged one.
    damage *= 0.2 + charge * charge * 0.8;

    /* ---- critical hits ------------------------------------------------------ */
    const critical = charge >= CRITICAL_MIN_CHARGE && this._canCrit(player);
    if (critical) damage *= CRITICAL_MULTIPLIER;

    /* ---- knockback ---------------------------------------------------------- */
    let bonus = enchantLevel(stack, ENCHANTMENTS.KNOCKBACK);
    if (player.sprinting === true) {
      bonus += 1;
      player.sprinting = false;
    }
    const dir = this._directionTo(victim);

    /* ---- resolve ------------------------------------------------------------ */
    const applied = this.dealDamage(victim, damage, DAMAGE.PLAYER, dir);
    if (applied <= 0) {
      this.emit('miss', charge);
      return 0;
    }

    /* ---- extra knockback, fire, wear, exhaustion ---------------------------- */
    if (bonus > 0) this.applyKnockback(victim, dir[0], dir[2], 1, bonus);
    const fireAspect = enchantLevel(stack, ENCHANTMENTS.FIRE_ASPECT);
    if (fireAspect > 0 && Number.isFinite(victim.fireTime)) {
      victim.fireTime = Math.max(victim.fireTime, fireAspect * FIRE_ASPECT_DURATION);
    }
    this._wearHeldItem(1);
    this.addExhaustion(EXHAUSTION_ATTACK);
    if (typeof player.swing === 'function') {
      try { player.swing(); } catch (err) { warnOnce('swing', 'the swing animation failed', err); }
    }

    const cx = num(victim.position && victim.position[0], 0);
    const cy = num(victim.position && victim.position[1], 0) + num(victim.height, 1) * 0.6;
    const cz = num(victim.position && victim.position[2], 0);
    this._play(critical ? 'attack_crit' : 'attack_hit', cx, cy, cz, 0.9,
      critical ? 1.2 : 0.95 + Math.random() * 0.1);
    if (critical) this._spawn('crit', cx, cy, cz, { count: 12, speed: 3.2 });

    this.emit('attack', victim, applied, { charge, critical, knockback: bonus });
    if (victim.dead === true || num(victim.health, 1) <= 0) {
      this._onKilledByPlayer(victim);
    }
    return applied;
  }

  /**
   * Whether the player is in a state that allows a critical hit: falling,
   * airborne, not swimming, not climbing and not sprinting.
   * @param {Object} player the player
   * @returns {boolean} `true` when the swing may crit
   * @private
   */
  _canCrit(player) {
    if (player.onGround === true || player.flying === true) return false;
    if (player.climbing === true || player.inWater === true) return false;
    if (player.sprinting === true) return false;
    return num(player.velocity && player.velocity[1], 0) < -0.1 &&
      num(player.fallDistance, 0) > 0;
  }

  /**
   * Unit direction from the player to a victim, written into a reused scratch
   * vector.
   * @param {Object} victim the target
   * @returns {number[]} `[x, y, z]`, horizontal length 1
   * @private
   */
  _directionTo(victim) {
    const out = this._knockDir;
    const player = this.player;
    const px = num(player && player.position && player.position[0], 0);
    const pz = num(player && player.position && player.position[2], 0);
    const vx = num(victim.position && victim.position[0], px);
    const vz = num(victim.position && victim.position[2], pz);
    let dx = vx - px;
    let dz = vz - pz;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) {
      // Standing exactly on top of it: push along the look direction instead.
      if (player && typeof player.getLookDirection === 'function') {
        const look = player.getLookDirection();
        dx = num(look[0], 1);
        dz = num(look[2], 0);
      } else {
        dx = 1; dz = 0;
      }
    } else {
      dx /= len; dz /= len;
    }
    out[0] = dx;
    out[1] = 0;
    out[2] = dz;
    return out;
  }

  /**
   * Wear the held weapon down by one point, honouring Unbreaking.
   * @param {number} amount durability points
   * @returns {void}
   * @private
   */
  _wearHeldItem(amount) {
    const player = this.player;
    const inv = player && player.inventory;
    if (!inv || typeof inv.damageSelected !== 'function') return;
    if (player.gameMode === 'creative') return;
    const unbreaking = enchantLevel(this._heldStack(), ENCHANTMENTS.UNBREAKING);
    if (unbreaking > 0 && Math.random() < unbreaking / (unbreaking + 1)) return;
    try {
      inv.damageSelected(Math.max(1, amount | 0));
    } catch (err) {
      warnOnce('wear', 'the held item could not be damaged', err);
    }
  }

  /**
   * Find the closest entity the player is looking at, inside melee reach and
   * not occluded by terrain.
   * @param {number} [reach] maximum distance in blocks
   * @returns {?Object} the target, or null
   */
  pickAttackTarget(reach = ATTACK_REACH) {
    const player = this.player;
    const manager = this.entities;
    if (!player || !manager || typeof manager.queryRadius !== 'function') return null;

    let origin;
    let look;
    try {
      origin = player.getEyePosition();
      look = player.getLookDirection();
    } catch (err) {
      warnOnce('aim', 'the player aim could not be read', err);
      return null;
    }
    const ox = num(origin[0], 0);
    const oy = num(origin[1], 0);
    const oz = num(origin[2], 0);
    const dx = num(look[0], 0);
    const dy = num(look[1], 0);
    const dz = num(look[2], -1);

    // Terrain shortens the reach: never hit through a wall.
    let limit = reach;
    if (this.world && typeof this.world.raycast === 'function') {
      try {
        const hit = this.world.raycast(origin, look, reach);
        if (hit && Number.isFinite(hit.dist)) limit = Math.min(limit, hit.dist);
      } catch (err) {
        warnOnce('aimRay', 'the aim raycast failed', err);
      }
    }

    const list = manager.queryRadius(ox + dx * limit * 0.5, oy + dy * limit * 0.5,
      oz + dz * limit * 0.5, limit + 2, this._queryList);
    let best = null;
    let bestT = limit;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e === player || e.removed === true || e.dead === true) continue;
      if (!Number.isFinite(e.health) || e.health <= 0) continue;
      const box = e.aabb;
      if (!box || !Number.isFinite(box.minX)) continue;
      const t = rayBox(ox, oy, oz, dx, dy, dz, box, bestT);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = e;
      }
    }
    list.length = 0;
    return best;
  }

  /**
   * Loot and experience for something the player killed.
   * @param {Object} victim the dead entity
   * @returns {void}
   * @private
   */
  _onKilledByPlayer(victim) {
    // The `'kill'` event itself is raised by `_damageEntity`; this only adds the
    // experience a player-killed mob owes.
    const xp = victim.def && Number.isFinite(victim.def.xp) ? victim.def.xp : 0;
    if (xp <= 0 || !this.entities || typeof this.entities.dropXP !== 'function') return;
    try {
      this.entities.dropXP(
        num(victim.position && victim.position[0], 0),
        num(victim.position && victim.position[1], 0) + 0.4,
        num(victim.position && victim.position[2], 0), xp);
    } catch (err) {
      warnOnce('killXP', 'the kill experience could not be dropped', err);
    }
  }

  /* ====================================================================== */
  /* Explosions                                                             */
  /* ====================================================================== */

  /**
   * Damage everything around a blast with the usual distance falloff.
   *
   * `EntityManager.explode()` already does this for the entities it owns; this
   * entry point exists for explosions raised outside the entity manager (a
   * lightning strike, a command) and for the player specifically.
   *
   * @param {number} x blast X
   * @param {number} y blast Y
   * @param {number} z blast Z
   * @param {number} power blast power (TNT is 4)
   * @param {{entities?:boolean}} [opts] `entities:false` hurts only the player
   * @returns {number} how many victims were hurt
   */
  explosionDamage(x, y, z, power, opts = {}) {
    const strength = clamp(num(power, 4), 0.5, 24);
    const radius = strength * 2;
    let hurt = 0;

    const victims = [];
    if (opts.entities !== false && this.entities &&
        typeof this.entities.queryRadius === 'function') {
      try {
        const list = this.entities.queryRadius(x, y, z, radius, this._queryList);
        for (let i = 0; i < list.length; i++) victims.push(list[i]);
        list.length = 0;
      } catch (err) {
        warnOnce('blastQuery', 'the explosion entity query failed', err);
      }
    }
    if (this.player) victims.push(this.player);

    for (let i = 0; i < victims.length; i++) {
      const e = victims[i];
      if (!e || e.removed === true || e.dead === true) continue;
      const ex = num(e.position && e.position[0], 0);
      const ey = num(e.position && e.position[1], 0) + num(e.height, 1.8) * 0.5;
      const ez = num(e.position && e.position[2], 0);
      const dist = Math.hypot(ex - x, ey - y, ez - z);
      if (dist > radius) continue;
      const impact = 1 - dist / radius;
      const damage = Math.floor((impact * impact + impact) * 0.5 * 7 * strength + 1);
      if (damage <= 0) continue;
      this._knockDir[0] = ex - x;
      this._knockDir[1] = 0;
      this._knockDir[2] = ez - z;
      if (this.dealDamage(e, damage, DAMAGE.EXPLOSION, this._knockDir) > 0) hurt++;
    }
    return hurt;
  }

  /* ====================================================================== */
  /* Experience                                                             */
  /* ====================================================================== */

  /**
   * The level a total experience amount buys.
   * @param {number} xp total experience points
   * @returns {number} the level
   */
  levelFromXP(xp) {
    const total = Math.max(0, num(xp, 0));
    let level;
    if (total <= 352) level = Math.sqrt(total + 9) - 3;
    else if (total <= 1507) level = 8.1 + Math.sqrt(0.4 * (total - 195.975));
    else level = 18.0555555555 + Math.sqrt((total - 752.9861111111) / 4.5);
    level = Math.floor(level);
    // Round-trip against the exact curve so the two never disagree.
    let guard = 0;
    while (level > 0 && totalXPForLevel(level) > total && guard++ < 64) level--;
    guard = 0;
    while (totalXPForLevel(level + 1) <= total && guard++ < 64) level++;
    return level;
  }

  /**
   * Add (or, with a negative amount, take away) experience and recompute the
   * level and the progress bar.
   * @param {number} amount experience points
   * @returns {number} the new level
   */
  addXP(amount) {
    const player = this.player;
    const v = num(amount, 0);
    if (!player || v === 0) return player ? num(player.xpLevel, 0) : 0;

    const beforeLevel = num(player.xpLevel, 0);
    player.xp = Math.max(0, num(player.xp, 0) + v);
    this._recalculateXP();
    if (player.xpLevel > beforeLevel) {
      const p = player.position;
      this._play('level_up', num(p && p[0], 0), num(p && p[1], 0) + 1, num(p && p[2], 0), 0.7, 1);
      this.emit('levelup', player.xpLevel);
      this._emitPlayer('levelup', player.xpLevel);
    }
    this.emit('xp', player.xp, player.xpLevel, player.xpProgress);
    return player.xpLevel;
  }

  /**
   * Grant whole levels, e.g. from a command.
   * @param {number} levels number of levels
   * @returns {number} the new level
   */
  addXPLevels(levels) {
    const player = this.player;
    if (!player) return 0;
    const target = Math.max(0, num(player.xpLevel, 0) + Math.round(num(levels, 0)));
    return this.addXP(totalXPForLevel(target) - num(player.xp, 0));
  }

  /**
   * Refresh `xpLevel` and `xpProgress` from `xp`.
   * @returns {void}
   * @private
   */
  _recalculateXP() {
    const player = this.player;
    if (!player) return;
    const total = Math.max(0, num(player.xp, 0));
    const level = this.levelFromXP(total);
    const base = totalXPForLevel(level);
    const need = xpForLevel(level);
    player.xpLevel = level;
    player.xpProgress = need > 0 ? clamp((total - base) / need, 0, 1) : 0;
  }

  /* ====================================================================== */
  /* Death & respawn                                                        */
  /* ====================================================================== */

  /**
   * Kill the player: freeze the input, scatter the inventory and the earned
   * experience, and raise the `'death'` event the UI turns into the death
   * screen.
   *
   * @param {string} [damageSource] what killed the player; defaults to the last
   *   damage source seen
   * @returns {void}
   */
  onPlayerDeath(damageSource = '') {
    const player = this.player;
    if (!player || player.dead === true) return;
    const def = sourceDef(damageSource || this.lastDamageSource);

    player.health = 0;
    player.dead = true;
    player.sprinting = false;
    player.flying = false;
    player.fireTime = 0;
    if (player.velocity && player.velocity.length >= 3) {
      player.velocity[0] = 0;
      player.velocity[1] = 0;
      player.velocity[2] = 0;
    }

    this._freezeInput(true);

    const x = num(player.position && player.position[0], 0);
    const y = num(player.position && player.position[1], 0);
    const z = num(player.position && player.position[2], 0);

    const droppedXP = this._dropExperience(x, y, z);
    const droppedItems = this.dropInventory(x, y, z);

    this._play('death', x, y + 1, z, 1, 1);
    this._resetEnvironmentTimers();
    this._fastRegen = 0;
    this._slowRegen = 0;

    const payload = {
      source: def.id,
      label: def.label,
      message: def.death,
      x, y, z,
      xp: droppedXP,
      items: droppedItems,
    };
    this._emitPlayer('death', def.id);
    this.emit('death', payload);
  }

  /**
   * Scatter every carried stack on the ground.
   * @param {number} x drop X
   * @param {number} y drop Y
   * @param {number} z drop Z
   * @returns {number} how many stacks were dropped
   */
  dropInventory(x, y, z) {
    const player = this.player;
    const inv = player && player.inventory;
    const manager = this.entities;
    if (!inv || !manager || typeof manager.dropItem !== 'function') return 0;
    if (!Array.isArray(inv.slots)) return 0;

    let dropped = 0;
    const last = Math.min(inv.slots.length - 1, SLOT.CRAFT_END);
    for (let i = 0; i <= last; i++) {
      const stack = inv.slots[i];
      if (!stack || (typeof stack.isEmpty === 'function' && stack.isEmpty())) continue;
      try {
        const copy = typeof stack.clone === 'function' ? stack.clone() : stack;
        if (typeof inv.set === 'function') inv.set(i, null);
        else inv.slots[i] = null;
        if (manager.dropItem(x, y + 1, z, copy, null) !== null) dropped++;
      } catch (err) {
        warnOnce('dropInventory', 'a stack could not be dropped', err);
      }
    }
    if (typeof inv.emit === 'function') {
      try { inv.emit('changed', -1, null, inv); } catch (err) { /* listener problem */ }
    }
    this.refreshArmor();
    return dropped;
  }

  /**
   * Drop the experience a death costs: seven points per level, capped.
   * @param {number} x drop X
   * @param {number} y drop Y
   * @param {number} z drop Z
   * @returns {number} the points dropped
   * @private
   */
  _dropExperience(x, y, z) {
    const player = this.player;
    if (!player) return 0;
    const level = num(player.xpLevel, 0);
    const amount = Math.min(DEATH_XP_CAP, Math.floor(level * DEATH_XP_PER_LEVEL));
    player.xp = 0;
    player.xpLevel = 0;
    player.xpProgress = 0;
    if (amount > 0 && this.entities && typeof this.entities.dropXP === 'function') {
      try {
        this.entities.dropXP(x, y + 0.6, z, amount);
      } catch (err) {
        warnOnce('deathXP', 'the death experience could not be dropped', err);
        return 0;
      }
    }
    this.emit('xp', 0, 0, 0);
    return amount;
  }

  /**
   * Bring the player back at the spawn point with a fresh state.
   * @returns {void}
   */
  respawn() {
    const player = this.player;
    if (!player) return;

    try {
      if (typeof player.respawn === 'function') player.respawn();
      else {
        player.health = num(player.maxHealth, MAX_HEALTH);
        player.hunger = MAX_HUNGER;
        player.saturation = 5;
        player.dead = false;
      }
    } catch (err) {
      warnOnce('respawn', 'the player could not be respawned', err);
    }

    player.fireTime = 0;
    player.air = MAX_AIR;
    player.exhaustion = 0;
    this.invulnerability = INVULNERABILITY_TIME * 4;
    this.lastDamage = 0;
    this.lastDamageSource = DAMAGE_GENERIC;
    this.attackTimer = COOLDOWN_MAX;
    this._fallPeak = num(player.position && player.position[1], 0);
    this._wasOnGround = true;
    this._lastWalked = num(player.walkedDistance, 0);
    this._fastRegen = 0;
    this._slowRegen = 0;
    this._resetEnvironmentTimers();
    this._freezeInput(false);
    this.refreshArmor();
    this.emit('respawn');
  }

  /**
   * Freeze or release the input device behind the player.
   * @param {boolean} frozen `true` to freeze
   * @returns {void}
   * @private
   */
  _freezeInput(frozen) {
    this.inputFrozen = frozen === true;
    const input = this.player && this.player.input;
    if (!input) return;
    try {
      if (typeof input.setEnabled === 'function') input.setEnabled(!this.inputFrozen);
      if (this.inputFrozen && typeof input.exitLock === 'function') input.exitLock();
    } catch (err) {
      warnOnce('freezeInput', 'the input could not be frozen', err);
    }
  }

  /* ====================================================================== */
  /* Effects                                                                */
  /* ====================================================================== */

  /**
   * Play a sound without ever letting the audio engine break the tick.
   * @param {string} name sound name
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {number} volume volume 0..1
   * @param {number} pitch playback rate
   * @returns {void}
   * @private
   */
  _play(name, x, y, z, volume, pitch) {
    const audio = this.audio;
    if (!audio || typeof audio.play !== 'function') return;
    try {
      audio.play(name, { x, y, z, volume, pitch });
    } catch (err) {
      warnOnce(`sound:${name}`, `the sound "${name}" failed`, err);
    }
  }

  /**
   * Spawn particles without ever letting the particle system break the tick.
   * @param {string} type particle type name
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {Object} opts spawn options
   * @returns {void}
   * @private
   */
  _spawn(type, x, y, z, opts) {
    const particles = this.particles;
    if (!particles || typeof particles.spawn !== 'function') return;
    try {
      particles.spawn(type, x, y, z, opts);
    } catch (err) {
      warnOnce(`particle:${type}`, `the "${type}" particles failed`, err);
    }
  }

  /**
   * Re-emit an event on the player's own bus, so listeners wired to the player
   * (the HUD, the audio engine) keep working unchanged.
   * @param {string} evt event name
   * @param {...*} args event arguments
   * @returns {void}
   * @private
   */
  _emitPlayer(evt, ...args) {
    const player = this.player;
    if (!player || typeof player.emit !== 'function') return;
    try {
      player.emit(evt, ...args);
    } catch (err) {
      warnOnce(`emit:${evt}`, `a "${evt}" listener on the player failed`, err);
    }
  }
}

/* ========================================================================== */
/* Geometry                                                                   */
/* ========================================================================== */

/**
 * Slab test of a ray against an axis-aligned box, slightly inflated so a swing
 * that grazes an entity still connects.
 * @param {number} ox ray origin X
 * @param {number} oy ray origin Y
 * @param {number} oz ray origin Z
 * @param {number} dx ray direction X (unit)
 * @param {number} dy ray direction Y (unit)
 * @param {number} dz ray direction Z (unit)
 * @param {{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number}} box the box
 * @param {number} limit maximum distance
 * @returns {number} the hit distance, or `-1` when the ray misses
 */
function rayBox(ox, oy, oz, dx, dy, dz, box, limit) {
  const pad = 0.15;
  const minX = box.minX - pad;
  const minY = box.minY - pad;
  const minZ = box.minZ - pad;
  const maxX = box.maxX + pad;
  const maxY = box.maxY + pad;
  const maxZ = box.maxZ + pad;

  let tMin = 0;
  let tMax = limit;

  const ix = dx !== 0 ? 1 / dx : Infinity;
  let t1 = (minX - ox) * ix;
  let t2 = (maxX - ox) * ix;
  if (dx === 0) {
    if (ox < minX || ox > maxX) return -1;
  } else {
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  const iy = dy !== 0 ? 1 / dy : Infinity;
  t1 = (minY - oy) * iy;
  t2 = (maxY - oy) * iy;
  if (dy === 0) {
    if (oy < minY || oy > maxY) return -1;
  } else {
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  const iz = dz !== 0 ? 1 / dz : Infinity;
  t1 = (minZ - oz) * iz;
  t2 = (maxZ - oz) * iz;
  if (dz === 0) {
    if (oz < minZ || oz > maxZ) return -1;
  } else {
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  return tMin;
}

export default CombatSystem;
