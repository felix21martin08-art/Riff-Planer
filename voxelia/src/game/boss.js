/**
 * @file game/boss.js — VOXELIA boss encounter: **„Der Verderber"** (Wither class).
 *
 * One complete, self-contained encounter, built on top of the existing engine
 * instead of beside it:
 *
 *  * {@link WitherBoss} extends {@link Mob} from `game/mobs.js`. It reuses the
 *    whole mob simulation — senses, {@link MobAI} behaviour scheduler, swept
 *    physics, hurt flash, death animation — and only replaces what a boss must
 *    do differently (flight steering, phases, armour, knockback immunity,
 *    loot).
 *  * {@link WitherSkullEntity} extends {@link Entity} from `game/entities.js`
 *    and is a real projectile with its own physics, an entity sweep, a voxel
 *    raycast, an explosion and the **wither** status effect — applied through
 *    `game/effects.js` ({@link EFFECT}.WITHER), never through a parallel
 *    system of its own.
 *  * {@link BossManager} watches block placement for the summoning ritual,
 *    owns the HUD boss-bar state, drains the block-shatter work under a
 *    {@link TimeBudget} and serialises an in-progress fight.
 *
 * ============================================================================
 * THE RITUAL
 * ============================================================================
 * The classic T: four soul blocks and three skulls, along either the X or the
 * Z axis (`base` = the lower stem block):
 *
 * ```
 *   y+2     K K K          skulls
 *   y+1     S S S          soul blocks
 *   y+0       S            soul block  <- base
 *          -1 0 +1
 * ```
 *
 * `world/blocks.js` is a frozen registry and this module may not add to it, so
 * the two material groups are resolved by *name* through an ordered fallback
 * list ({@link SOUL_BLOCK_NAMES}, {@link SKULL_BLOCK_NAMES}). If the registry
 * ever grows a real `wither_skeleton_skull`, the ritual picks it up with no
 * code change; until then a carved pumpkin / jack-o'-lantern is the skull, and
 * {@link describeSummonRitual} names whatever is actually accepted, in German.
 *
 * ============================================================================
 * PHASES
 * ============================================================================
 * | Phase | Trigger        | Behaviour                                       |
 * |-------|----------------|-------------------------------------------------|
 * | 0     | summoned       | invulnerable charge-up, {@link CHARGE_SECONDS} s |
 * | 1     | charge done    | flies, keeps distance, explosive skull barrage   |
 * | 2     | HP <= 50 %     | +armour, dash attacks that shatter terrain       |
 * | 3     | HP <= 25 %     | summons adds and drains life from them           |
 *
 * The boss retreats to regenerate after a burst of heavy damage, and it can
 * never end up permanently stuck: a three-stage escalation (carve — phase
 * through — teleport) runs from {@link WitherBoss#updateTimers}, which is the
 * one hook that ticks no matter which behaviour is active.
 *
 * ============================================================================
 * INTEGRATION
 * ============================================================================
 * Nothing here reaches into `render/*` or `ui/*`. Effects are delivered twice:
 * directly to whatever subsystem the tick context carries, **and** as an event
 * on the {@link BossManager} event bus, so the integrator can wire screen shake
 * and toasts without this module knowing they exist. See the module report /
 * {@link BOSS_BAR_SHAPE} for the HUD contract.
 *
 * @module game/boss
 */

import { clamp, damp } from '../core/math.js';
import { EventBus, TimeBudget } from '../core/util.js';
import { B, getBlock, isSolid } from '../world/blocks.js';
import { GRAVITY, TERMINAL_VELOCITY, applyGravity } from './physics.js';
import {
  Entity,
  ENTITY_DAMAGE,
  VOID_LEVEL,
  blastResistance,
  registerEntityClass,
} from './entities.js';
import { Behavior, Mob, MobAI, createMob } from './mobs.js';
import { EFFECT, TICKS_PER_SECOND } from './effects.js';
import { I, itemIdByName } from './items.js';
import { ItemStack } from './inventory.js';

/* ========================================================================== */
/* Identity                                                                   */
/* ========================================================================== */

/**
 * Entity type of the boss. Also the key `render/entities.js` looks up in its
 * visual table, and the key {@link registerEntityClass} stores it under.
 * @type {string}
 */
export const BOSS_TYPE = 'wither_boss';

/**
 * Entity type of the boss's projectile.
 * @type {string}
 */
export const SKULL_TYPE = 'wither_skull';

/** German name of the boss, shown on the boss bar and in every toast. @type {string} */
export const BOSS_NAME = 'Der Verderber';

/** German name of the projectile. @type {string} */
export const SKULL_NAME = 'Verderbnisschädel';

/** German name of the minions summoned in phase 3. @type {string} */
export const ADD_NAME = 'Verderbtes Gefolge';

/** Save-format version of everything this module writes. @type {number} */
export const BOSS_SAVE_VERSION = 1;

/* ========================================================================== */
/* Tuning                                                                     */
/* ========================================================================== */

/** Maximum health of the boss, in half-hearts. @type {number} */
export const BOSS_MAX_HEALTH = 300;

/** Health fraction at which phase 2 begins. @type {number} */
export const PHASE2_THRESHOLD = 0.5;

/** Health fraction at which phase 3 begins. @type {number} */
export const PHASE3_THRESHOLD = 0.25;

/** Seconds the invulnerable charge-up lasts. @type {number} */
export const CHARGE_SECONDS = 10;

/** Explosion power released when the charge-up completes. @type {number} */
export const CHARGE_BLAST_POWER = 7;

/** Muzzle speed of a normal skull, in blocks/second. @type {number} */
export const SKULL_SPEED = 24;

/** Explosion power of a normal skull. @type {number} */
export const SKULL_POWER = 1.6;

/** Explosion power of a charged (phase 3) skull. @type {number} */
export const CHARGED_SKULL_POWER = 2.8;

/** Seconds of {@link EFFECT}.WITHER a skull inflicts. @type {number} */
export const SKULL_WITHER_SECONDS = 10;

/** Radius in blocks within which a detonating skull applies wither. @type {number} */
export const SKULL_WITHER_RADIUS = 3.2;

/** Distance the boss tries to hold to its target, in blocks. @type {number} */
export const PREFERRED_RANGE = 13;

/** Closest the boss willingly gets while firing, in blocks. @type {number} */
export const MIN_RANGE = 7;

/** Farthest the boss drifts before closing in again, in blocks. @type {number} */
export const MAX_RANGE = 26;

/** Blocks the boss hovers above its target. @type {number} */
export const HOVER_HEIGHT = 4.5;

/** Minimum clearance the boss keeps above the terrain, in blocks. @type {number} */
export const GROUND_CLEARANCE = 3.0;

/** Speed of a phase-2 dash, in blocks/second. @type {number} */
export const RUSH_SPEED = 26;

/** Seconds a dash lasts before it gives up. @type {number} */
export const RUSH_DURATION = 1.5;

/** Seconds between two dashes. @type {number} */
export const RUSH_COOLDOWN = 7;

/** Radius in blocks the dash impact shatters. @type {number} */
export const SHATTER_RADIUS = 3.4;

/**
 * Highest blast resistance the boss can shatter. Obsidian (150) and bedrock
 * (`Infinity`) survive; stone (18) and wood do not.
 * @type {number}
 */
export const SHATTER_MAX_RESISTANCE = 20;

/** Blocks removed per tick at most, across every queued shatter. @type {number} */
export const SHATTER_PER_TICK = 24;

/** Milliseconds per tick the shatter queue may consume. @type {number} */
export const SHATTER_BUDGET_MS = 1.0;

/** How many minions phase 3 summons per wave. @type {number} */
export const ADD_COUNT = 3;

/** Mob types used as minions, tried in order until one spawns. @type {readonly string[]} */
export const ADD_TYPES = Object.freeze(['skeleton', 'zombie', 'husk']);

/** Half-hearts per second the boss drains from every living minion. @type {number} */
export const ADD_DRAIN = 1.6;

/** Seconds before a new wave of minions may be summoned. @type {number} */
export const ADD_COOLDOWN = 20;

/** Blocks beyond which a minion is considered lost and stops feeding the boss. @type {number} */
export const ADD_LEASH = 40;

/** Half-hearts per second regained while retreating. @type {number} */
export const RETREAT_REGEN = 3.0;

/** Seconds a retreat lasts. @type {number} */
export const RETREAT_SECONDS = 4.0;

/** Damage taken inside {@link DAMAGE_WINDOW} that triggers a retreat. @type {number} */
export const RETREAT_DAMAGE = 26;

/** Length of the rolling damage window, in seconds. @type {number} */
export const DAMAGE_WINDOW = 3.0;

/** Seconds between retreats. @type {number} */
export const RETREAT_COOLDOWN = 22;

/** Experience the boss drops. @type {number} */
export const BOSS_XP = 500;

/** How far the boss may drift from its arena before it flies back, in blocks. @type {number} */
export const ARENA_LEASH = 72;

/** Distance within which the HUD boss bar is shown, in blocks. @type {number} */
export const BOSS_BAR_RANGE = 96;

/** Aggro radius, in blocks — larger than the mob follow range on purpose. @type {number} */
export const BOSS_AGGRO_RANGE = 64;

/** Damping rate of the flight steering, in 1/s. @type {number} */
const FLY_LAMBDA = 4.5;

/** Seconds of no progress that counts as one "stuck" strike. @type {number} */
const STUCK_WINDOW = 1.6;

/** Blocks of movement inside {@link STUCK_WINDOW} that still counts as progress. @type {number} */
const STUCK_PROGRESS = 0.55;

/** Seconds the boss may phase through terrain to free itself. @type {number} */
const NOCLIP_ESCAPE_SECONDS = 1.2;

/** Seed mob type handed to `Mob`'s constructor; every field is replaced below. @type {string} */
const SEED_TYPE = 'zombie';

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/** Messages already printed, so a broken subsystem logs once, not per tick. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a message exactly once per key. Nothing in this module ever throws
 * during a tick; every failure lands here and degrades.
 * @param {string} key dedupe key
 * @param {string} message text to print
 * @param {*} [detail] optional error or payload
 * @returns {void}
 */
function warnOnce(key, message, detail) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (detail !== undefined) console.warn(`[VOXELIA] boss: ${message}`, detail);
  else console.warn(`[VOXELIA] boss: ${message}`);
}

/**
 * Finite number or fallback.
 * @param {*} v candidate
 * @param {number} fallback value used when `v` is not a finite number
 * @returns {number} a usable number
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
 * Squared distance between an entity position and a point.
 * @param {ArrayLike<number>} p `[x, y, z]`
 * @param {number} x point X
 * @param {number} y point Y
 * @param {number} z point Z
 * @returns {number} squared distance
 */
function distSqTo(p, x, y, z) {
  const dx = p[0] - x;
  const dy = p[1] - y;
  const dz = p[2] - z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Eye height of anything: players and mobs both publish `eyeHeight`, and a
 * bare entity is measured from its box.
 * @param {Object} e the entity
 * @returns {number} eye height above the feet, in blocks
 */
function eyeOffset(e) {
  if (e === null || e === undefined) return 1.6;
  if (Number.isFinite(e.eyeHeight)) return e.eyeHeight;
  return num(e.height, 1.8) * 0.85;
}

/**
 * Whether an entity is a legal target for the boss: alive, not a projectile,
 * not the boss itself and not one of its own minions.
 * @param {Object} e candidate
 * @returns {boolean} `true` when it may be attacked
 */
function isHittable(e) {
  if (!e || e.removed === true || e.dead === true || e.dying === true) return false;
  if (!e.position || e.position.length < 3) return false;
  const t = e.type;
  if (t === SKULL_TYPE || t === BOSS_TYPE) return false;
  if (t === 'item' || t === 'xp_orb' || t === 'arrow' || t === 'splash_potion') return false;
  if (e.witherAdd === true) return false;
  return true;
}

/**
 * Whether a player-like object may be engaged (alive, not creative/spectator).
 * @param {?Object} player the player
 * @returns {boolean} `true` when the boss should care about them
 */
function isEngageablePlayer(player) {
  if (!player || !player.position || player.position.length < 3) return false;
  if (player.dead === true) return false;
  if (Number.isFinite(player.health) && player.health <= 0) return false;
  if (player.gameMode === 'creative' || player.gameMode === 'spectator') return false;
  return true;
}

/* ========================================================================== */
/* Ritual materials                                                           */
/* ========================================================================== */

/**
 * Block names accepted as the "soul" part of the ritual, best first.
 * @type {readonly string[]}
 */
export const SOUL_BLOCK_NAMES = Object.freeze(['SOUL_SAND', 'SOUL_SOIL']);

/**
 * Block names accepted as the "skull" part of the ritual, best first. The
 * first three do not exist in this build yet; the list is future-proofing, and
 * the carved pumpkin is the working stand-in.
 * @type {readonly string[]}
 */
export const SKULL_BLOCK_NAMES = Object.freeze([
  'WITHER_SKELETON_SKULL', 'WITHER_SKULL', 'SKELETON_SKULL',
  'JACK_O_LANTERN', 'CARVED_PUMPKIN',
]);

/**
 * German names for the ritual blocks. `world/blocks.js` stores English display
 * strings, and every player-visible string in VOXELIA is German, so the ritual
 * text is built from this table instead.
 * @type {Readonly<Object<string, string>>}
 */
const GERMAN_BLOCK_NAMES = Object.freeze({
  SOUL_SAND: 'Seelensand',
  SOUL_SOIL: 'Seelenerde',
  WITHER_SKELETON_SKULL: 'Witherskelettschädel',
  WITHER_SKULL: 'Witherschädel',
  SKELETON_SKULL: 'Skelettschädel',
  JACK_O_LANTERN: 'Kürbislaterne',
  CARVED_PUMPKIN: 'Geschnitzter Kürbis',
});

/**
 * Resolve a list of block names into the ids that actually exist.
 * @param {readonly string[]} names candidate names, best first
 * @returns {{ids:Set<number>, primary:number, primaryName:string}} the accepted
 *   ids, plus the best available one and its key
 */
function resolveBlocks(names) {
  const ids = new Set();
  let primary = 0;
  let primaryName = '';
  for (let i = 0; i < names.length; i++) {
    const id = B[names[i]];
    if (!Number.isFinite(id) || id <= 0) continue;
    ids.add(id | 0);
    if (primary === 0) {
      primary = id | 0;
      primaryName = names[i];
    }
  }
  return { ids, primary, primaryName };
}

/** Resolved soul blocks. @type {{ids:Set<number>, primary:number, primaryName:string}} */
const SOUL_BLOCKS = resolveBlocks(SOUL_BLOCK_NAMES);

/** Resolved skull blocks. @type {{ids:Set<number>, primary:number, primaryName:string}} */
const SKULL_BLOCKS = resolveBlocks(SKULL_BLOCK_NAMES);

if (SOUL_BLOCKS.primary === 0 || SKULL_BLOCKS.primary === 0) {
  warnOnce('ritual', 'the block registry has no soul or skull block; the ritual is disabled');
}

/**
 * Block ids accepted as the soul part of the ritual.
 * @returns {number[]} a fresh array of block ids (possibly empty)
 */
export function soulBlockIds() {
  return Array.from(SOUL_BLOCKS.ids);
}

/**
 * Block ids accepted as the skull part of the ritual.
 * @returns {number[]} a fresh array of block ids (possibly empty)
 */
export function skullBlockIds() {
  return Array.from(SKULL_BLOCKS.ids);
}

/**
 * German, player-facing description of the summoning ritual, naming the blocks
 * that are actually accepted in this build.
 * @returns {string} one sentence, ready for a tooltip or a book page
 */
export function describeSummonRitual() {
  const soul = GERMAN_BLOCK_NAMES[SOUL_BLOCKS.primaryName] || 'Seelensand';
  const skull = GERMAN_BLOCK_NAMES[SKULL_BLOCKS.primaryName] || 'Schädel';
  return `Ritual: vier ${soul}-Blöcke als T (einer unten, drei darüber), darauf drei Mal `
    + `${skull}. Dann erwacht ${BOSS_NAME}.`;
}

/**
 * Offsets of the four soul blocks relative to the ritual base, along +X.
 * @type {readonly number[][]}
 */
export const SOUL_OFFSETS = Object.freeze([
  Object.freeze([0, 0, 0]),
  Object.freeze([-1, 1, 0]),
  Object.freeze([0, 1, 0]),
  Object.freeze([1, 1, 0]),
]);

/**
 * Offsets of the three skulls relative to the ritual base, along +X.
 * @type {readonly number[][]}
 */
export const SKULL_OFFSETS = Object.freeze([
  Object.freeze([-1, 2, 0]),
  Object.freeze([0, 2, 0]),
  Object.freeze([1, 2, 0]),
]);

/* ========================================================================== */
/* Loot                                                                       */
/* ========================================================================== */

/** Cached result of {@link bossTrophyStack}'s item lookup. @type {number} */
let TROPHY_ITEM = -1;

/** `true` when the trophy is the substitute rather than a real nether star. @type {boolean} */
let TROPHY_IS_SUBSTITUTE = false;

/**
 * The boss trophy as an item stack.
 *
 * `game/items.js` is frozen and has no `nether_star` yet, so the drop falls
 * back to the beacon — the exact thing a nether star is worth in vanilla — and
 * carries the German name and lore in its {@link ItemStack} metadata, which is
 * the only lossless carrier the stack contract offers. The moment `items.js`
 * grows a real `nether_star`, this picks it up with no code change.
 *
 * @returns {?ItemStack} a fresh stack, or `null` when nothing can be dropped
 */
export function bossTrophyStack() {
  if (TROPHY_ITEM < 0) {
    let id = 0;
    try {
      id = itemIdByName('nether_star') | 0;
    } catch (err) {
      warnOnce('trophy', 'the item registry could not be queried for the trophy', err);
      id = 0;
    }
    if (id > 0) {
      TROPHY_IS_SUBSTITUTE = false;
    } else {
      id = Number.isFinite(I.BEACON) ? I.BEACON | 0 : 0;
      TROPHY_IS_SUBSTITUTE = true;
    }
    TROPHY_ITEM = id;
  }
  if (TROPHY_ITEM <= 0) return null;
  const meta = TROPHY_IS_SUBSTITUTE
    ? {
      name: 'Netherstern',
      lore: ['Aus dem Kern des Verderbers geborgen.', 'Er summt, als wäre er noch am Leben.'],
    }
    : { lore: ['Aus dem Kern des Verderbers geborgen.'] };
  return new ItemStack(TROPHY_ITEM, 1, meta);
}

/* ========================================================================== */
/* Definition                                                                 */
/* ========================================================================== */

/**
 * The boss's {@link MobDef}. `MOB_TYPES` in `game/mobs.js` is frozen, so the
 * definition lives here and is installed onto the instance right after
 * `Mob`'s constructor has run. Every field of the `MobDef` contract is present
 * so the shared mob code — pathing capabilities, movement, senses, loot — sees
 * exactly the record it expects.
 * @type {Readonly<Object>}
 */
export const WITHER_BOSS_DEF = Object.freeze({
  name: BOSS_TYPE,
  display: BOSS_NAME,
  model: BOSS_TYPE,
  width: 0.9,
  height: 3.5,
  eyeHeight: 3.0,
  health: BOSS_MAX_HEALTH,
  armor: 4,
  speed: 9.0,
  attackDamage: 8,
  attackReach: 3.2,
  attackCooldown: 1.0,
  knockback: 2.2,
  knockbackResistance: 1,
  followRange: 80,
  xp: BOSS_XP,
  loot: Object.freeze([]),
  category: 'hostile',
  biomes: null,
  light: Object.freeze([0, 15]),
  placement: 'air',
  surface: null,
  spawnY: Object.freeze([-64, 320]),
  packSize: Object.freeze([1, 1]),
  burnsInDaylight: false,
  undead: true,
  arthropod: false,
  hostile: true,
  neutral: false,
  despawns: false,
  aquatic: false,
  flying: true,
  avoidsWater: false,
  canSwim: true,
  canClimb: false,
  canOpenDoors: false,
  tameable: false,
  tameFood: null,
  breedable: false,
  breedFood: null,
  shearable: false,
  baby: false,
  babyScale: 1,
  growUpSeconds: 0,
  stepHeight: 1.0,
  floatSpeed: 4.0,
  gravityScale: 0,
  maxFall: 512,
  sunAvoid: 0,
});

/**
 * Phase ids.
 * @type {Readonly<{CHARGING:number, BARRAGE:number, ARMOURED:number, SWARM:number}>}
 */
export const BOSS_PHASE = Object.freeze({
  CHARGING: 0,
  BARRAGE: 1,
  ARMOURED: 2,
  SWARM: 3,
});

/**
 * German label of a phase, for the boss bar.
 * @param {number} phase a {@link BOSS_PHASE} value
 * @returns {string} the label
 */
export function phaseLabel(phase) {
  switch (phase | 0) {
    case BOSS_PHASE.CHARGING: return 'Erwacht …';
    case BOSS_PHASE.BARRAGE: return 'Erste Phase · Schädelhagel';
    case BOSS_PHASE.ARMOURED: return 'Zweite Phase · Gepanzerter Ansturm';
    case BOSS_PHASE.SWARM: return 'Dritte Phase · Verderbtes Gefolge';
    default: return '';
  }
}

/**
 * CSS colour of the boss bar for a phase. The HUD may ignore it.
 * @param {number} phase a {@link BOSS_PHASE} value
 * @returns {string} a hex colour
 */
export function phaseColor(phase) {
  switch (phase | 0) {
    case BOSS_PHASE.CHARGING: return '#d9cfae';
    case BOSS_PHASE.BARRAGE: return '#3c332f';
    case BOSS_PHASE.ARMOURED: return '#6b5a4a';
    case BOSS_PHASE.SWARM: return '#8c2f2a';
    default: return '#3c332f';
  }
}

/* ========================================================================== */
/* Active manager registry                                                    */
/* ========================================================================== */

/**
 * The most recently constructed {@link BossManager}.
 *
 * Projectiles and minions are ordinary entities in the shared
 * {@link EntityManager}; they receive the generic tick context, which has no
 * slot for a boss manager. Rather than mutate another module's object, they
 * fall back to this reference (after `ctx.boss`, which always wins).
 * @type {?BossManager}
 */
let ACTIVE_MANAGER = null;

/**
 * Publish the manager that entities without an explicit `ctx.boss` should use.
 * {@link BossManager} calls this itself; only call it manually when you run
 * more than one manager and want to choose which is the default.
 * @param {?BossManager} manager the manager, or `null` to clear
 * @returns {void}
 */
export function setActiveBossManager(manager) {
  ACTIVE_MANAGER = manager instanceof BossManager ? manager : null;
}

/**
 * The manager entities fall back to.
 * @returns {?BossManager} the active manager, or `null`
 */
export function getActiveBossManager() {
  return ACTIVE_MANAGER;
}

/**
 * Resolve the manager for a tick.
 * @param {?Object} ctx the tick context
 * @returns {?BossManager} `ctx.boss`, else the active manager, else `null`
 */
function managerFrom(ctx) {
  if (ctx && ctx.boss instanceof BossManager) return ctx.boss;
  return ACTIVE_MANAGER;
}

/**
 * Resolve the effect manager for a tick.
 * @param {?Object} ctx the tick context
 * @returns {?Object} an `EffectManager`, or `null`
 */
function effectsFrom(ctx) {
  if (ctx && ctx.effects && typeof ctx.effects.add === 'function') return ctx.effects;
  const m = managerFrom(ctx);
  if (m !== null && m.effects && typeof m.effects.add === 'function') return m.effects;
  return null;
}

/**
 * Fire a positional sound through the audio engine *and* as a manager event.
 * @param {?Object} ctx the tick context
 * @param {string} name sound event name understood by `game/audio.js`
 * @param {number} x world X
 * @param {number} y world Y
 * @param {number} z world Z
 * @param {{volume?:number, pitch?:number}} [opts] level and pitch
 * @returns {void}
 */
function emitSound(ctx, name, x, y, z, opts = {}) {
  const volume = num(opts.volume, 1);
  const pitch = num(opts.pitch, 1);
  const audio = (ctx && ctx.audio) || (ACTIVE_MANAGER && ACTIVE_MANAGER.audio) || null;
  if (audio && typeof audio.play === 'function') {
    try {
      audio.play(name, { x, y, z, volume, pitch });
    } catch (err) {
      warnOnce('sound', 'the audio engine rejected a boss sound', err);
    }
  }
  const manager = managerFrom(ctx);
  if (manager !== null) manager.report('sound', name, x, y, z, volume, pitch);
}

/**
 * Spawn particles through the particle system *and* as a manager event.
 * @param {?Object} ctx the tick context
 * @param {string} type particle type understood by `render/particles.js`
 * @param {number} x world X
 * @param {number} y world Y
 * @param {number} z world Z
 * @param {Object} [opts] particle options
 * @returns {void}
 */
function emitParticles(ctx, type, x, y, z, opts = {}) {
  const particles = (ctx && ctx.particles) || (ACTIVE_MANAGER && ACTIVE_MANAGER.particles) || null;
  if (particles && typeof particles.spawn === 'function') {
    try {
      particles.spawn(type, x, y, z, opts);
    } catch (err) {
      warnOnce('particles', 'the particle system rejected a boss emission', err);
    }
  }
  const manager = managerFrom(ctx);
  if (manager !== null) manager.report('particles', type, x, y, z, opts);
}

/**
 * Ask for a camera shake. There is no shake subsystem in the engine, so this
 * is event-only — the integrator decides what it means.
 * @param {?Object} ctx the tick context
 * @param {number} strength `0..1` intensity
 * @param {number} seconds duration in seconds
 * @param {number} x world X of the source
 * @param {number} y world Y of the source
 * @param {number} z world Z of the source
 * @returns {void}
 */
function emitShake(ctx, strength, seconds, x, y, z) {
  const manager = managerFrom(ctx);
  if (manager === null) return;
  manager.report('shake', clamp(num(strength, 0.3), 0, 1), Math.max(0, num(seconds, 0.3)), x, y, z);
}

/* ========================================================================== */
/* WitherSkullEntity                                                          */
/* ========================================================================== */

/** Scratch direction vector for the skull raycast. @type {Float32Array} */
const SKULL_DIR = new Float32Array(3);

/** Raycast options shared by every skull (fluids do not stop it). @type {Object} */
const SKULL_RAY_OPTS = Object.freeze({ fluids: false });

/** Reusable candidate list for the skull's entity sweep. @type {Object[]} */
const SKULL_SWEEP = [];

/**
 * Reusable particle options for the projectile trail. `ParticleSystem#spawn`
 * reads its options synchronously and never keeps them, so one shared record
 * keeps the hottest path in this module allocation free.
 * @type {Object}
 */
const TRAIL_OPTS = { count: 1, speed: 0.25, life: 0.55, spread: 0.15 };

/**
 * A flying, exploding wither skull.
 *
 * It does not use the generic entity integrator: it moves along its own
 * velocity, sweeps the entities it would cross this tick, raycasts the voxel
 * world for the same segment, and detonates on the first contact. Detonation
 * produces a real explosion through {@link EntityManager#explode} (so terrain
 * damage, falloff and knockback all behave like every other blast in the game)
 * and applies {@link EFFECT}.WITHER through `game/effects.js`.
 */
export class WitherSkullEntity extends Entity {
  /**
   * @param {number} x world X of the muzzle
   * @param {number} y world Y of the muzzle
   * @param {number} z world Z of the muzzle
   * @param {{velocity?:ArrayLike<number>, power?:number, charged?:boolean,
   *   ownerId?:number, destroy?:boolean, witherSeconds?:number,
   *   witherAmplifier?:number, homing?:number, targetId?:number}} [opts] launch options
   */
  constructor(x, y, z, opts = {}) {
    super(SKULL_TYPE, x, y, z);
    this.setSize(0.55, 0.55);

    this.health = 1;
    this.maxHealth = 1;
    this.gravityScale = 0;
    this.drag = 0;
    this.dragY = 0;
    this.noPush = true;
    this.fireProof = true;
    this.despawnTime = 0;

    /** @type {boolean} Charged skulls are slower, heavier and break more. */
    this.charged = opts.charged === true;
    /** @type {number} Explosion power on impact. */
    this.power = clamp(num(opts.power, this.charged ? CHARGED_SKULL_POWER : SKULL_POWER), 0.5, 8);
    /** @type {boolean} Whether the blast destroys terrain. */
    this.destroys = opts.destroy !== false;
    /** @type {number} Entity id of the shooter; it is never hit by its own skull. */
    this.ownerId = num(opts.ownerId, 0) | 0;
    /** @type {number} Seconds of wither inflicted on a direct or splash hit. */
    this.witherSeconds = Math.max(0, num(opts.witherSeconds, SKULL_WITHER_SECONDS));
    /** @type {number} 0-based amplifier of the wither effect. */
    this.witherAmplifier = clamp(num(opts.witherAmplifier, this.charged ? 1 : 0) | 0, 0, 3);
    /** @type {number} Steering strength towards {@link WitherSkullEntity#targetId}, `0` = none. */
    this.homing = clamp(num(opts.homing, 0), 0, 1);
    /** @type {number} Entity id the skull steers towards while homing. */
    this.targetId = num(opts.targetId, 0) | 0;
    /** @type {number} Seconds before the skull gives up and vanishes. */
    this.maxAge = 12;
    /** @type {boolean} Guards against a double detonation. */
    this.detonated = false;
    /** @type {number} Seconds since the last trail puff. @private */
    this._trail = 0;

    const v = opts.velocity;
    if (v && v.length >= 3) {
      this.velocity[0] = num(v[0], 0);
      this.velocity[1] = num(v[1], 0);
      this.velocity[2] = num(v[2], 0);
    }
    this._updateRotation();
  }

  /**
   * Point the model along the flight direction.
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
   * Advance the projectile.
   * @param {number} dt elapsed seconds
   * @param {Object} world the World
   * @param {Object} [ctx] shared tick context
   * @returns {void}
   */
  update(dt, world, ctx) {
    this.prevPosition.set(this.position);
    if (this.removed) return;
    const step = clamp(num(dt, 0), 0, 0.25);
    this.age += step;

    if (this.age >= this.maxAge || this.position[1] < VOID_LEVEL) {
      this.remove('despawn');
      return;
    }

    const v = this.velocity;
    if (this.homing > 0) this._steerHome(step, ctx);
    if (this.gravityScale !== 0) {
      applyGravity(v, step, GRAVITY * this.gravityScale, TERMINAL_VELOCITY);
    }

    const dx = v[0] * step;
    const dy = v[1] * step;
    const dz = v[2] * step;
    const travel = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (travel > 1e-6) {
      const victim = this._sweepEntities(dx, dy, dz, travel, ctx);
      if (victim !== null) {
        this.position[0] = victim.position[0];
        this.position[1] = victim.position[1] + num(victim.height, 1.8) * 0.5;
        this.position[2] = victim.position[2];
        this.syncAABB();
        this.detonate(ctx, victim);
        return;
      }
      const hit = this._traceBlocks(world, dx, dy, dz, travel);
      if (hit !== null) {
        const p = hit.point;
        const n = hit.faceNormal;
        this.position[0] = p[0] + n[0] * 0.05;
        this.position[1] = p[1] + n[1] * 0.05;
        this.position[2] = p[2] + n[2] * 0.05;
        this.syncAABB();
        this.detonate(ctx, null);
        return;
      }
    }

    this.position[0] += dx;
    this.position[1] += dy;
    this.position[2] += dz;
    this.syncAABB();
    this._updateRotation();

    this._trail += step;
    if (this._trail >= 0.1) {
      this._trail = 0;
      TRAIL_OPTS.count = this.charged ? 2 : 1;
      emitParticles(ctx, this.charged ? 'ember' : 'smoke',
        this.position[0], this.position[1], this.position[2], TRAIL_OPTS);
    }
  }

  /**
   * Bend the flight path towards the tracked target.
   * @param {number} dt elapsed seconds
   * @param {Object} [ctx] shared tick context
   * @returns {void}
   * @private
   */
  _steerHome(dt, ctx) {
    if (this.targetId === 0) return;
    let target = null;
    const manager = this.manager;
    if (manager !== null && typeof manager.get === 'function') target = manager.get(this.targetId);
    if (target === null && ctx && ctx.player && ctx.player.id === this.targetId) target = ctx.player;
    if (target === null || !target.position || target.dead === true) {
      this.homing = 0;
      return;
    }
    const v = this.velocity;
    const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (speed < 1e-3) return;
    let dx = target.position[0] - this.position[0];
    let dy = (target.position[1] + eyeOffset(target) * 0.6) - this.position[1];
    let dz = target.position[2] - this.position[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-3) return;
    dx /= len; dy /= len; dz /= len;
    const k = clamp(this.homing * dt * 2.5, 0, 0.5);
    v[0] = (v[0] / speed * (1 - k) + dx * k) * speed;
    v[1] = (v[1] / speed * (1 - k) + dy * k) * speed;
    v[2] = (v[2] / speed * (1 - k) + dz * k) * speed;
  }

  /**
   * First entity the skull's segment crosses this tick.
   * @param {number} dx displacement X
   * @param {number} dy displacement Y
   * @param {number} dz displacement Z
   * @param {number} travel length of the displacement
   * @param {Object} [ctx] shared tick context
   * @returns {?Object} the entity hit, or `null`
   * @private
   */
  _sweepEntities(dx, dy, dz, travel, ctx) {
    const manager = this.manager;
    if (manager === null || typeof manager.queryAABB !== 'function') return null;
    const ox = this.position[0];
    const oy = this.position[1];
    const oz = this.position[2];
    const inv = 1 / travel;

    const box = manager.scratchBox();
    box.set(
      Math.min(ox, ox + dx), Math.min(oy, oy + dy), Math.min(oz, oz + dz),
      Math.max(ox, ox + dx), Math.max(oy, oy + dy), Math.max(oz, oz + dz),
    );
    box.expand(0.8);

    SKULL_SWEEP.length = 0;
    let list;
    try {
      list = manager.queryAABB(box, SKULL_SWEEP);
    } catch (err) {
      warnOnce('skull:sweep', 'the projectile sweep failed', err);
      SKULL_SWEEP.length = 0;
      return null;
    }

    let best = null;
    let bestT = travel;
    const probe = manager.scratchBox2();
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e === this || e.id === this.ownerId) continue;
      if (!isHittable(e)) continue;
      probe.copy(e.aabb).expand(0.2);
      const t = probe.rayIntersect(ox, oy, oz, dx * inv, dy * inv, dz * inv);
      if (t >= 0 && t <= bestT) {
        bestT = t;
        best = e;
      }
    }
    SKULL_SWEEP.length = 0;

    // The local player is not an entity in the manager, so it is tested apart.
    const player = ctx && ctx.player ? ctx.player : null;
    if (player !== null && isEngageablePlayer(player) && player.id !== this.ownerId) {
      const half = Math.max(0.05, num(player.width, 0.6)) * 0.5;
      const height = Math.max(0.2, num(player.height, 1.8));
      probe.set(
        player.position[0] - half, player.position[1], player.position[2] - half,
        player.position[0] + half, player.position[1] + height, player.position[2] + half,
      );
      probe.expand(0.15);
      const t = probe.rayIntersect(ox, oy, oz, dx * inv, dy * inv, dz * inv);
      if (t >= 0 && t <= bestT) best = player;
    }
    return best;
  }

  /**
   * Trace the segment against the voxel world.
   * @param {Object} world the World
   * @param {number} dx displacement X
   * @param {number} dy displacement Y
   * @param {number} dz displacement Z
   * @param {number} travel length of the displacement
   * @returns {?Object} the `world.raycast()` hit, or `null`
   * @private
   */
  _traceBlocks(world, dx, dy, dz, travel) {
    if (!world || typeof world.raycast !== 'function') return null;
    const inv = 1 / travel;
    SKULL_DIR[0] = dx * inv;
    SKULL_DIR[1] = dy * inv;
    SKULL_DIR[2] = dz * inv;
    try {
      return world.raycast(this.position, SKULL_DIR, travel, SKULL_RAY_OPTS);
    } catch (err) {
      warnOnce('skull:ray', 'the projectile raycast failed', err);
      return null;
    }
  }

  /**
   * Blow up: explosion, wither cloud, particles, sound, shake.
   * @param {Object} [ctx] shared tick context
   * @param {?Object} [direct] the entity that was struck head-on, if any
   * @returns {void}
   */
  detonate(ctx, direct = null) {
    if (this.detonated) return;
    this.detonated = true;
    const x = this.position[0];
    const y = this.position[1];
    const z = this.position[2];
    // Removing first keeps the skull out of its own blast candidate list.
    this.remove('detonated');

    const manager = this.manager;
    if (manager !== null && typeof manager.explode === 'function') {
      try {
        manager.explode(x, y, z, this.power, {
          destroy: this.destroys,
          fire: false,
          dropChance: 0,
          // The shooter is excluded, so the boss never damages itself.
          sourceId: this.ownerId,
          player: ctx && ctx.player ? ctx.player : null,
          particles: ctx && ctx.particles ? ctx.particles : null,
          audio: ctx && ctx.audio ? ctx.audio : null,
        });
      } catch (err) {
        warnOnce('skull:explode', 'the skull explosion failed', err);
      }
    }

    this._applyWither(ctx, direct);

    emitParticles(ctx, 'smoke', x, y, z, { count: 18, speed: 2.4, life: 1.1, spread: 0.8 });
    emitParticles(ctx, 'ember', x, y, z, { count: 10, speed: 3.0, life: 0.9, spread: 0.5 });
    emitSound(ctx, 'explode', x, y, z, { volume: 0.9, pitch: this.charged ? 0.7 : 1.05 });
    emitShake(ctx, this.charged ? 0.5 : 0.3, 0.35, x, y, z);

    const boss = managerFrom(ctx);
    if (boss !== null) boss.report('skullImpact', x, y, z, this.power, this.charged);
  }

  /**
   * Apply the wither status effect to everything in the blast.
   * @param {Object} [ctx] shared tick context
   * @param {?Object} direct the entity that was struck head-on, if any
   * @returns {void}
   * @private
   */
  _applyWither(ctx, direct) {
    const effects = effectsFrom(ctx);
    if (effects === null || this.witherSeconds <= 0) return;
    const ticks = Math.round(this.witherSeconds * TICKS_PER_SECOND);
    if (ticks <= 0) return;

    const x = this.position[0];
    const y = this.position[1];
    const z = this.position[2];
    const r2 = SKULL_WITHER_RADIUS * SKULL_WITHER_RADIUS;

    /**
     * @param {Object} e the victim
     * @param {number} scale duration multiplier
     * @returns {void}
     */
    const apply = (e, scale) => {
      if (!e || e.id === this.ownerId) return;
      // Undead creatures — the boss's own kind — shrug the withering off.
      if (e.def && e.def.undead === true) return;
      if (e.witherAdd === true) return;
      try {
        effects.add(e, EFFECT.WITHER, this.witherAmplifier, Math.round(ticks * scale),
          { particles: true, icon: true });
      } catch (err) {
        warnOnce('skull:wither', 'the wither effect could not be applied', err);
      }
    };

    if (direct !== null) apply(direct, 1);

    const manager = this.manager;
    if (manager !== null && typeof manager.queryRadius === 'function') {
      SKULL_SWEEP.length = 0;
      try {
        manager.queryRadius(x, y, z, SKULL_WITHER_RADIUS, SKULL_SWEEP);
      } catch (err) {
        warnOnce('skull:radius', 'the wither radius query failed', err);
        SKULL_SWEEP.length = 0;
      }
      for (let i = 0; i < SKULL_SWEEP.length; i++) {
        const e = SKULL_SWEEP[i];
        if (e === direct || !isHittable(e)) continue;
        apply(e, 0.6);
      }
      SKULL_SWEEP.length = 0;
    }

    // The local player is not stored in the entity manager, so it is measured
    // separately — against the middle of its body, like every other victim.
    const player = ctx && ctx.player ? ctx.player : null;
    if (player !== null && player !== direct && isEngageablePlayer(player)) {
      const py = player.position[1] + num(player.height, 1.8) * 0.5;
      const dx = player.position[0] - x;
      const dy = py - y;
      const dz = player.position[2] - z;
      if (dx * dx + dy * dy + dz * dz <= r2) apply(player, 0.7);
    }
  }

  /**
   * A skull is fragile: any hit pops it early.
   * @param {number} amount damage in half-hearts
   * @param {string} [source] a {@link ENTITY_DAMAGE} value
   * @param {Object} [ctx] shared tick context
   * @returns {boolean} always `false` — a skull never "takes" damage
   */
  damage(amount, source = ENTITY_DAMAGE.GENERIC, ctx = null) {
    void amount;
    void source;
    if (this.removed || this.detonated) return false;
    this.detonate(ctx, null);
    return false;
  }

  /**
   * @returns {Object} save record
   */
  serialize() {
    const out = this.writeBaseState({});
    out.power = this.power;
    out.charged = this.charged;
    out.destroys = this.destroys;
    out.owner = this.ownerId;
    out.witherSeconds = this.witherSeconds;
    out.witherAmplifier = this.witherAmplifier;
    out.homing = this.homing;
    out.targetId = this.targetId;
    return out;
  }

  /**
   * @param {Object} o save record
   * @returns {?WitherSkullEntity} the restored projectile
   */
  static deserialize(o) {
    if (!o || typeof o !== 'object') return null;
    const p = Array.isArray(o.p) ? o.p : [0, 0, 0];
    const e = new WitherSkullEntity(num(p[0], 0), num(p[1], 0), num(p[2], 0), {
      power: num(o.power, SKULL_POWER),
      charged: o.charged === true,
      destroy: o.destroys !== false,
      ownerId: num(o.owner, 0),
      witherSeconds: num(o.witherSeconds, SKULL_WITHER_SECONDS),
      witherAmplifier: num(o.witherAmplifier, 0),
      homing: num(o.homing, 0),
      targetId: num(o.targetId, 0),
    });
    e.readBaseState(o);
    return e;
  }
}

/* ========================================================================== */
/* Shatter offsets                                                            */
/* ========================================================================== */

/** Largest radius {@link WitherBoss#queueShatter} supports, in blocks. @type {number} */
const SHATTER_MAX_R = 5;

/**
 * Block offsets of a sphere of radius {@link SHATTER_MAX_R}, ordered by
 * distance from the centre, packed as `x,y,z` triples. Precomputed once so the
 * shatter never allocates and always eats its way outwards.
 * @type {Int8Array}
 */
const SHATTER_OFFSETS = (() => {
  const r = SHATTER_MAX_R;
  /** @type {Array<{x:number, y:number, z:number, d:number}>} */
  const list = [];
  for (let y = -r; y <= r; y++) {
    for (let z = -r; z <= r; z++) {
      for (let x = -r; x <= r; x++) {
        const d = Math.sqrt(x * x + y * y + z * z);
        if (d <= r + 0.001) list.push({ x, y, z, d });
      }
    }
  }
  list.sort((a, b) => a.d - b.d);
  const out = new Int8Array(list.length * 3);
  for (let i = 0; i < list.length; i++) {
    out[i * 3] = list[i].x;
    out[i * 3 + 1] = list[i].y;
    out[i * 3 + 2] = list[i].z;
  }
  return out;
})();

/** Squared distance of every entry in {@link SHATTER_OFFSETS}. @type {Float32Array} */
const SHATTER_DIST2 = (() => {
  const n = SHATTER_OFFSETS.length / 3;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = SHATTER_OFFSETS[i * 3];
    const y = SHATTER_OFFSETS[i * 3 + 1];
    const z = SHATTER_OFFSETS[i * 3 + 2];
    out[i] = x * x + y * y + z * z;
  }
  return out;
})();

/** Number of offsets in the shatter sphere. @type {number} */
const SHATTER_COUNT = SHATTER_DIST2.length;

/* ========================================================================== */
/* Behaviours                                                                 */
/* ========================================================================== */

/**
 * The dramatic, invulnerable awakening. The boss rises out of the ritual,
 * spinning faster and faster, until {@link CHARGE_SECONDS} have passed and it
 * releases a shockwave.
 */
export class BossChargeBehavior extends Behavior {
  constructor() {
    super('boss_charge', 140);
    /** @type {number} Seconds until the next rumble. @private */
    this._beat = 0;
  }

  /** @inheritDoc */
  canStart(mob) { return mob.charging === true; }

  /** @inheritDoc */
  canContinue(mob) { return mob.charging === true; }

  /** @inheritDoc */
  start(mob) {
    this._beat = 0;
    mob.velocity[0] = 0;
    mob.velocity[1] = 0;
    mob.velocity[2] = 0;
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const progress = mob.chargeProgress();
    // Rise slowly, spin ever faster.
    const v = mob.velocity;
    v[0] = damp(v[0], 0, 6, dt);
    v[2] = damp(v[2], 0, 6, dt);
    v[1] = damp(v[1], 0.6 + progress * 0.9, 3, dt);
    mob.directDrive = true;
    mob.navActive = false;
    mob.moveIntent = 0;
    mob.bodyYaw += dt * (2 + progress * 16);
    mob.lookYaw = mob.bodyYaw;

    const x = mob.position[0];
    const y = mob.position[1] + mob.height * 0.6;
    const z = mob.position[2];

    if (mob.random() < dt * (8 + progress * 40)) {
      emitParticles(ctx, 'portal', x, y, z,
        { count: 3, speed: 1.5 + progress * 3, life: 0.9, spread: 1.6 });
    }
    if (mob.random() < dt * (4 + progress * 16)) {
      emitParticles(ctx, 'ember', x, y, z, { count: 2, speed: 2.2, life: 0.8, spread: 1.2 });
    }

    this._beat -= dt;
    if (this._beat <= 0) {
      this._beat = 1.2 - progress * 0.85;
      emitSound(ctx, 'beacon', x, y, z, { volume: 0.5 + progress * 0.5, pitch: 0.5 + progress });
      emitShake(ctx, 0.15 + progress * 0.5, 0.3, x, y, z);
    }
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * The anti-stuck escalation. Never lets the boss end its life wedged inside
 * terrain: it carves, then phases, then teleports.
 */
export class BossEscapeBehavior extends Behavior {
  constructor() {
    super('boss_escape', 130);
  }

  /** @inheritDoc */
  canStart(mob) { return mob.escapeTimer > 0; }

  /** @inheritDoc */
  canContinue(mob) { return mob.escapeTimer > 0; }

  /** @inheritDoc */
  start(mob, ctx) {
    emitParticles(ctx, 'portal', mob.position[0], mob.position[1] + mob.height * 0.5,
      mob.position[2], { count: 12, speed: 2, life: 0.8, spread: 1.2 });
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    // Straight up and out of the hole, at speed, phasing if it has to.
    const world = mob.world;
    let tx = mob.position[0];
    let tz = mob.position[2];
    if (mob.target !== null && mob.target.position) {
      tx = mob.position[0] + (mob.position[0] - mob.target.position[0]) * 0.2;
      tz = mob.position[2] + (mob.position[2] - mob.target.position[2]) * 0.2;
    }
    let ty = mob.position[1] + 8;
    if (world !== null && typeof world.getHeight === 'function') {
      ty = Math.max(ty, world.getHeight(Math.floor(tx), Math.floor(tz)) + GROUND_CLEARANCE + 4);
    }
    mob.steer(dt, tx, ty, tz, 14);
    if (mob.random() < dt * 10) {
      emitParticles(ctx, 'smoke', mob.position[0], mob.position[1] + mob.height * 0.5,
        mob.position[2], { count: 2, speed: 1.2, life: 0.6 });
    }
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Phase 3: summon the minions, then hang back and feed on them.
 */
export class BossSummonBehavior extends Behavior {
  constructor() {
    super('boss_summon', 120);
    /** @type {number} Seconds spent in the summoning pose. @private */
    this._cast = 0;
    /** @type {boolean} The wave has already been released. @private */
    this._done = false;
  }

  /** @inheritDoc */
  canStart(mob) {
    return mob.phase >= BOSS_PHASE.SWARM
      && !mob.charging
      && mob.addCooldown <= 0
      && mob.livingAdds === 0
      && mob.target !== null;
  }

  /** @inheritDoc */
  canContinue(mob) {
    if (mob.charging) return false;
    return !this._done || this._cast > 0;
  }

  /** @inheritDoc */
  start(mob, ctx) {
    this._cast = 1.6;
    this._done = false;
    emitSound(ctx, 'thunder', mob.position[0], mob.position[1], mob.position[2],
      { volume: 0.8, pitch: 1.4 });
    const manager = managerFrom(ctx);
    if (manager !== null) manager.report('summonWave', mob);
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    // Hold position, arms out, then release the wave.
    const v = mob.velocity;
    v[0] = damp(v[0], 0, 5, dt);
    v[2] = damp(v[2], 0, 5, dt);
    v[1] = damp(v[1], 1.2, 4, dt);
    mob.directDrive = true;
    mob.navActive = false;
    mob.moveIntent = 0;
    if (mob.target !== null) mob.faceEntity(mob.target);

    emitParticles(ctx, 'portal', mob.position[0], mob.position[1] + mob.height * 0.5,
      mob.position[2], { count: 3, speed: 2.5, life: 0.7, spread: 1.4 });

    if (this._cast > 0) {
      this._cast -= dt;
      if (this._cast <= 0 && !this._done) {
        this._done = true;
        mob.summonAdds(ctx);
      }
    }
  }

  /** @inheritDoc */
  stop(mob) {
    this._cast = 0;
    this._done = false;
    mob.stopMoving();
  }
}

/**
 * Pull back out of reach and knit itself together again.
 */
export class BossRetreatBehavior extends Behavior {
  constructor() {
    super('boss_retreat', 112);
  }

  /** @inheritDoc */
  canStart(mob) { return mob.retreatTimer > 0 && !mob.charging; }

  /** @inheritDoc */
  canContinue(mob) { return mob.retreatTimer > 0 && !mob.charging; }

  /** @inheritDoc */
  start(mob, ctx) {
    emitSound(ctx, 'burn', mob.position[0], mob.position[1], mob.position[2],
      { volume: 0.7, pitch: 0.6 });
    const manager = managerFrom(ctx);
    if (manager !== null) manager.report('retreat', mob);
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const target = mob.target;
    let tx = mob.position[0];
    let tz = mob.position[2];
    if (target !== null && target.position) {
      let dx = mob.position[0] - target.position[0];
      let dz = mob.position[2] - target.position[2];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      tx = target.position[0] + dx * (MAX_RANGE + 4);
      tz = target.position[2] + dz * (MAX_RANGE + 4);
      mob.lookAt(target.position[0], target.position[1] + eyeOffset(target), target.position[2]);
    }
    mob.steer(dt, tx, mob.desiredAltitude(tx, tz, 6), tz, mob.def.speed * 1.35);

    mob.healBoss(RETREAT_REGEN * dt);
    if (mob.random() < dt * 12) {
      emitParticles(ctx, 'heart', mob.position[0], mob.position[1] + mob.height * 0.7,
        mob.position[2], { count: 1, speed: 0.4, life: 0.8 });
    }
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Phase 2+: a straight, fast charge at the target that shatters the terrain it
 * lands in.
 */
export class BossRushBehavior extends Behavior {
  constructor() {
    super('boss_rush', 104);
    /** @type {number} Seconds of dash left. @private */
    this._left = 0;
    /** @type {Float32Array} Frozen dash direction. @private */
    this._dir = new Float32Array(3);
    /** @type {boolean} The impact has already been resolved. @private */
    this._hit = false;
  }

  /** @inheritDoc */
  canStart(mob) {
    if (mob.charging || mob.phase < BOSS_PHASE.ARMOURED) return false;
    if (mob.rushTimer > 0 || mob.target === null || !mob.target.position) return false;
    const d2 = distSqTo(mob.position, mob.target.position[0], mob.target.position[1],
      mob.target.position[2]);
    if (d2 > 30 * 30 || d2 < 3 * 3) return false;
    return mob.canSee(mob.target);
  }

  /** @inheritDoc */
  canContinue(mob) { return this._left > 0 && !mob.charging && mob.target !== null; }

  /** @inheritDoc */
  start(mob, ctx) {
    const target = mob.target;
    this._left = RUSH_DURATION;
    this._hit = false;
    mob.rushTimer = RUSH_COOLDOWN;
    if (target === null || !target.position) {
      this._left = 0;
      return;
    }
    let dx = target.position[0] - mob.position[0];
    let dy = (target.position[1] + eyeOffset(target) * 0.5) - (mob.position[1] + mob.height * 0.5);
    let dz = target.position[2] - mob.position[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    this._dir[0] = dx / len;
    this._dir[1] = clamp(dy / len, -0.7, 0.7);
    this._dir[2] = dz / len;
    emitSound(ctx, 'attack_hit', mob.position[0], mob.position[1], mob.position[2],
      { volume: 1, pitch: 0.55 });
    emitShake(ctx, 0.25, 0.25, mob.position[0], mob.position[1], mob.position[2]);
    const manager = managerFrom(ctx);
    if (manager !== null) manager.report('rush', mob);
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    this._left -= dt;
    const v = mob.velocity;
    v[0] = damp(v[0], this._dir[0] * RUSH_SPEED, 9, dt);
    v[1] = damp(v[1], this._dir[1] * RUSH_SPEED, 9, dt);
    v[2] = damp(v[2], this._dir[2] * RUSH_SPEED, 9, dt);
    mob.directDrive = true;
    mob.navActive = false;
    mob.moveIntent = 1;
    mob.bodyYaw += wrapAngle(Math.atan2(this._dir[0], this._dir[2]) - mob.bodyYaw)
      * clamp(dt * 10, 0, 1);

    emitParticles(ctx, 'ember', mob.position[0], mob.position[1] + mob.height * 0.5,
      mob.position[2], { count: 2, speed: 1.5, life: 0.4, spread: 0.6 });

    if (this._hit) return;

    const target = mob.target;
    const close = target !== null && target.position
      && distSqTo(mob.position, target.position[0], target.position[1] + eyeOffset(target) * 0.5,
        target.position[2]) < (mob.def.attackReach + 1.2) ** 2;
    const blocked = mob.blockedAhead(this._dir[0], this._dir[1], this._dir[2], 1.6);

    if (close || blocked || this._left <= 0) {
      this._hit = true;
      mob.rushImpact(ctx, close ? target : null);
      this._left = Math.min(this._left, 0.15);
    }
  }

  /** @inheritDoc */
  stop(mob) {
    this._left = 0;
    this._hit = false;
    mob.stopMoving();
  }
}

/**
 * The default combat behaviour: hold the preferred range, strafe, keep line of
 * sight, and fire explosive skulls with lead prediction.
 */
export class BossBarrageBehavior extends Behavior {
  constructor() {
    super('boss_barrage', 96);
    /** @type {number} Current strafe direction, `-1` or `1`. @private */
    this._strafe = 1;
    /** @type {number} Seconds until the strafe flips. @private */
    this._flip = 0;
    /** @type {number} Seconds spent without line of sight. @private */
    this._blind = 0;
  }

  /** @inheritDoc */
  canStart(mob) {
    return !mob.charging && mob.target !== null && mob.target.position !== undefined;
  }

  /** @inheritDoc */
  canContinue(mob) { return this.canStart(mob); }

  /** @inheritDoc */
  start(mob) {
    this._strafe = mob.random() < 0.5 ? -1 : 1;
    this._flip = 2 + mob.random() * 3;
    this._blind = 0;
  }

  /** @inheritDoc */
  tick(mob, dt, ctx) {
    const target = mob.target;
    if (target === null || !target.position) return;

    const tx = target.position[0];
    const ty = target.position[1];
    const tz = target.position[2];

    let dx = mob.position[0] - tx;
    let dz = mob.position[2] - tz;
    const flat = Math.hypot(dx, dz);
    if (flat > 1e-3) { dx /= flat; dz /= flat; }
    else { dx = 1; dz = 0; }

    this._flip -= dt;
    if (this._flip <= 0) {
      this._flip = 2.5 + mob.random() * 3.5;
      this._strafe = -this._strafe;
    }

    const visible = mob.canSee(target);
    this._blind = visible ? 0 : this._blind + dt;

    // Ring position: preferred radius, offset around the target by the strafe.
    let radius = PREFERRED_RANGE;
    if (flat < MIN_RANGE) radius = MIN_RANGE + 3;
    else if (flat > MAX_RANGE) radius = PREFERRED_RANGE;
    // Without line of sight, close in and climb until the shot opens up.
    if (this._blind > 0.8) radius = Math.max(MIN_RANGE, radius - 4);

    const angle = Math.atan2(dx, dz) + this._strafe * dt * 0.55;
    const px = tx + Math.sin(angle) * radius;
    const pz = tz + Math.cos(angle) * radius;
    const lift = this._blind > 0.8 ? HOVER_HEIGHT + 4 : HOVER_HEIGHT;
    const py = Math.max(ty + lift, mob.desiredAltitude(px, pz, lift));

    mob.steer(dt, px, py, pz, mob.def.speed);
    mob.lookAt(tx, ty + eyeOffset(target), tz);
    mob.faceEntity(target);

    if (visible) {
      mob.barrageTimer -= dt;
      if (mob.barrageTimer <= 0) {
        mob.barrageTimer = mob.barrageInterval();
        mob.fireBarrage(ctx, target);
      }
    }
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Nothing to fight: circle the arena and wait.
 */
export class BossHoverBehavior extends Behavior {
  constructor() {
    super('boss_hover', 20);
    /** @type {number} Orbit angle in radians. @private */
    this._angle = 0;
  }

  /** @inheritDoc */
  canStart(mob) { return !mob.charging; }

  /** @inheritDoc */
  canContinue(mob) { return !mob.charging; }

  /** @inheritDoc */
  start(mob) { this._angle = mob.random() * Math.PI * 2; }

  /** @inheritDoc */
  tick(mob, dt) {
    this._angle += dt * 0.4;
    const home = mob.arena;
    const cx = home === null ? mob.position[0] : home[0];
    const cy = home === null ? mob.position[1] : home[1];
    const cz = home === null ? mob.position[2] : home[2];
    const px = cx + Math.sin(this._angle) * 7;
    const pz = cz + Math.cos(this._angle) * 7;
    const py = Math.max(cy + 6, mob.desiredAltitude(px, pz, 6));
    mob.steer(dt, px, py, pz, mob.def.speed * 0.45);
    mob.lookYaw = this._angle + Math.PI * 0.5;
  }

  /** @inheritDoc */
  stop(mob) { mob.stopMoving(); }
}

/**
 * Build the boss's behaviour list.
 * @param {WitherBoss} boss the boss
 * @returns {Behavior[]} the behaviours, in any order
 */
export function buildBossBehaviors(boss) {
  void boss;
  return [
    new BossChargeBehavior(),
    new BossEscapeBehavior(),
    new BossSummonBehavior(),
    new BossRetreatBehavior(),
    new BossRushBehavior(),
    new BossBarrageBehavior(),
    new BossHoverBehavior(),
  ];
}

/* ========================================================================== */
/* WitherBoss                                                                 */
/* ========================================================================== */

/** Damage source ids the boss simply ignores. @type {Set<string>} */
const IMMUNE_SOURCES = new Set([
  'fire', 'lava', 'burn', 'drown', 'suffocate', 'starve', 'cactus',
  'magic', 'wither', 'fall', 'void',
]);

/** Scratch direction for {@link WitherBoss#blockedAhead}. @type {Float32Array} */
const BOSS_DIR = new Float32Array(3);

/**
 * „Der Verderber" — a three-phase flying boss.
 */
export class WitherBoss extends Mob {
  /**
   * @param {number} x world X (footprint centre)
   * @param {number} y world Y (feet)
   * @param {number} z world Z (footprint centre)
   * @param {{charging?:boolean, arena?:ArrayLike<number>}} [opts] spawn options
   */
  constructor(x, y, z, opts = {}) {
    // `MOB_TYPES` is frozen, so the boss borrows a known type to get through
    // `Mob`'s constructor without a warning and then installs its own
    // definition. Everything the seed type produced is replaced right below.
    super(SEED_TYPE, x, y, z);

    /** @type {Object} the boss definition (replaces the seed type's) */
    this.def = WITHER_BOSS_DEF;
    this.typeName = BOSS_TYPE;
    this.type = BOSS_TYPE;
    this.gravityScale = WITHER_BOSS_DEF.gravityScale;
    this.maxHealth = WITHER_BOSS_DEF.health;
    this.health = WITHER_BOSS_DEF.health;
    this.despawnTime = 0;
    this.fireProof = true;
    this.noPush = true;
    this.applyScale(1);

    /* ---- encounter state --------------------------------------------- */
    /** @type {number} Current {@link BOSS_PHASE}. */
    this.phase = BOSS_PHASE.CHARGING;
    /** @type {boolean} Invulnerable awakening in progress. */
    this.charging = opts.charging !== false;
    /** @type {number} Seconds of charge-up left. */
    this.chargeTimer = this.charging ? CHARGE_SECONDS : 0;
    /** @type {number} Extra armour points granted by the phases. */
    this.armorBonus = 0;
    /** @type {?number[]} `[x, y, z]` of the summoning site, the leash anchor. */
    this.arena = opts.arena && opts.arena.length >= 3
      ? [num(opts.arena[0], x), num(opts.arena[1], y), num(opts.arena[2], z)]
      : [x, y, z];

    /* ---- combat timers ------------------------------------------------ */
    /** @type {number} Seconds until the next skull volley. */
    this.barrageTimer = 1.2;
    /** @type {number} Seconds until the next dash. */
    this.rushTimer = RUSH_COOLDOWN * 0.5;
    /** @type {number} Seconds of retreat left. */
    this.retreatTimer = 0;
    /** @type {number} Seconds until the boss may retreat again. */
    this.retreatCooldown = 0;
    /** @type {number} Damage taken inside the rolling window. */
    this.damageWindow = 0;
    /** @type {number} Seconds left of the rolling damage window. */
    this.damageWindowTimer = 0;

    /* ---- minions ------------------------------------------------------ */
    /** @type {number[]} Entity ids of the living minions. */
    this.addIds = [];
    /** @type {number} Minions actually alive as of the last tick. */
    this.livingAdds = 0;
    /** @type {number} Seconds until a new wave may be summoned. */
    this.addCooldown = 0;
    /** @type {number} Total half-hearts drained from minions. */
    this.drained = 0;

    /* ---- anti-stuck --------------------------------------------------- */
    /** @type {number} `1` while a behaviour wants the boss to move. */
    this.moveIntent = 0;
    /** @type {number} Seconds since the last stuck check. @private */
    this._stuckClock = 0;
    /** @type {number[]} Position at the last stuck check. @private */
    this._stuckAnchor = [x, y, z];
    /** @type {number} Consecutive failed progress checks. */
    this.stuckStrikes = 0;
    /** @type {number} Seconds of forced escape behaviour left. */
    this.escapeTimer = 0;
    /** @type {number} Seconds of terrain phasing left. */
    this.noClipTimer = 0;
    /** @type {number} Seconds since the last enclosure probe. @private */
    this._enclosedClock = 0;

    /* ---- shatter queue ------------------------------------------------ */
    /**
     * Pending block-shatter jobs. Each is `{x, y, z, r2, cursor}` and is eaten
     * a few blocks per tick under a {@link TimeBudget}, never in one sweep.
     * @type {Array<{x:number, y:number, z:number, r2:number, cursor:number}>}
     */
    this.shatterQueue = [];

    /** @type {number[]} Shared probe origin, so terrain probes never allocate. @private */
    this._probe = [0, 0, 0];

    /** @type {?BossManager} The manager that owns this fight, when there is one. */
    this.bossManager = null;
    /** @type {boolean} Set once the death sequence has produced its loot. @private */
    this._looted = false;

    this.bodyYaw = 0;
    this.modelYaw = 0;
    this.ai = new MobAI(this, buildBossBehaviors(this));
    if (!this.charging) this.phase = BOSS_PHASE.BARRAGE;
  }

  /* ------------------------------------------------------------- queries -- */

  /**
   * Charge-up progress.
   * @returns {number} `0` at the start, `1` the moment it completes
   */
  chargeProgress() {
    if (!this.charging) return 1;
    return clamp(1 - this.chargeTimer / CHARGE_SECONDS, 0, 1);
  }

  /**
   * Health as a fraction of the maximum.
   * @returns {number} `0..1`
   */
  healthFraction() {
    return this.maxHealth > 0 ? clamp(this.health / this.maxHealth, 0, 1) : 0;
  }

  /**
   * Seconds between two skull volleys in the current phase.
   * @returns {number} the cadence in seconds
   */
  barrageInterval() {
    const base = this.phase >= BOSS_PHASE.SWARM ? 1.0
      : (this.phase >= BOSS_PHASE.ARMOURED ? 1.35 : 1.9);
    return base * (0.85 + this.random() * 0.3);
  }

  /**
   * Skulls fired per volley in the current phase.
   * @returns {number} `1`, `2` or `3`
   */
  barrageCount() {
    if (this.phase >= BOSS_PHASE.SWARM) return 3;
    if (this.phase >= BOSS_PHASE.ARMOURED) return 2;
    return 1;
  }

  /**
   * A safe flight altitude above a column: never closer than
   * {@link GROUND_CLEARANCE} to the terrain.
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} [extra] blocks of head room on top of the clearance
   * @returns {number} world Y to aim for
   */
  desiredAltitude(x, z, extra = 0) {
    const world = this.world;
    if (world === null || typeof world.getHeight !== 'function') {
      return this.position[1];
    }
    let ground;
    try {
      ground = world.getHeight(Math.floor(x), Math.floor(z));
    } catch (err) {
      warnOnce('altitude', 'the height query failed; the boss holds its altitude', err);
      return this.position[1];
    }
    return ground + GROUND_CLEARANCE + Math.max(0, extra);
  }

  /**
   * Whether solid terrain sits within `distance` blocks along a direction.
   * @param {number} dx direction X (normalized)
   * @param {number} dy direction Y (normalized)
   * @param {number} dz direction Z (normalized)
   * @param {number} distance probe length in blocks
   * @returns {boolean} `true` when the way is blocked
   */
  blockedAhead(dx, dy, dz, distance) {
    const world = this.world;
    if (world === null || typeof world.raycast !== 'function') return false;
    BOSS_DIR[0] = dx;
    BOSS_DIR[1] = dy;
    BOSS_DIR[2] = dz;
    const origin = this._probeOrigin();
    try {
      const hit = world.raycast(origin, BOSS_DIR, Math.max(0.1, distance), SKULL_RAY_OPTS);
      return hit !== null;
    } catch (err) {
      warnOnce('probe', 'the terrain probe failed', err);
      return false;
    }
  }

  /**
   * Centre of the body, reused as the origin of every probe.
   * @returns {number[]} a shared `[x, y, z]` — do not keep it
   * @private
   */
  _probeOrigin() {
    const o = this._probe;
    o[0] = this.position[0];
    o[1] = this.position[1] + this.height * 0.5;
    o[2] = this.position[2];
    return o;
  }

  /* ------------------------------------------------------------ steering -- */

  /**
   * Fly towards a point. The boss is a flying mob, so `Mob#applyMovement`
   * leaves the velocity alone — this writes it directly and still goes through
   * the swept collision, so the boss can never tunnel through terrain.
   * @param {number} dt elapsed seconds
   * @param {number} tx target X
   * @param {number} ty target Y
   * @param {number} tz target Z
   * @param {number} speed desired speed in blocks/second
   * @returns {void}
   */
  steer(dt, tx, ty, tz, speed) {
    const v = this.velocity;
    let dx = tx - this.position[0];
    let dy = ty - this.position[1];
    let dz = tz - this.position[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const s = clamp(num(speed, 0), 0, 40);
    if (len > 1e-4) {
      const inv = 1 / len;
      // Ease off over the last two blocks so the boss settles instead of
      // oscillating around its hover point.
      const approach = clamp(len * 0.5, 0.15, 1);
      dx *= inv * approach;
      dy *= inv * approach;
      dz *= inv * approach;
    } else {
      dx = 0; dy = 0; dz = 0;
    }
    v[0] = damp(v[0], dx * s, FLY_LAMBDA, dt);
    v[1] = damp(v[1], dy * s, FLY_LAMBDA, dt);
    v[2] = damp(v[2], dz * s, FLY_LAMBDA, dt);
    this.directDrive = true;
    this.navActive = false;
    this.moveIntent = s > 0.2 ? 1 : 0;
  }

  /**
   * Cancel every steering request.
   * @returns {void}
   */
  stopMoving() {
    super.stopMoving();
    this.moveIntent = 0;
  }

  /* ---------------------------------------------------------------- tick -- */

  /**
   * The always-on hook. `Mob#update` calls this before it branches on the
   * death animation and before the AI runs, so everything a boss must do
   * regardless of its current behaviour lives here: charge-up, phases, the
   * life drain, cooldowns and the anti-stuck escalation.
   * @param {number} dt elapsed seconds
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  updateTimers(dt, ctx) {
    super.updateTimers(dt, ctx);
    if (this.dying || this.removed) return;

    if (this.bossManager === null) {
      const m = managerFrom(ctx);
      if (m !== null) this.bossManager = m;
    }

    if (this.rushTimer > 0) this.rushTimer = Math.max(0, this.rushTimer - dt);
    if (this.retreatCooldown > 0) this.retreatCooldown = Math.max(0, this.retreatCooldown - dt);
    if (this.addCooldown > 0) this.addCooldown = Math.max(0, this.addCooldown - dt);
    if (this.retreatTimer > 0) this.retreatTimer = Math.max(0, this.retreatTimer - dt);
    if (this.escapeTimer > 0) this.escapeTimer = Math.max(0, this.escapeTimer - dt);
    if (this.damageWindowTimer > 0) {
      this.damageWindowTimer = Math.max(0, this.damageWindowTimer - dt);
      if (this.damageWindowTimer === 0) this.damageWindow = 0;
    }

    this._updateCharge(dt, ctx);
    if (this.charging) return;

    this._updatePhase(ctx);
    this._updateAdds(dt, ctx);
    this._updateStuck(dt, ctx);
    this._updateLeash();
    // A BossManager drains every boss under one shared time budget; without one
    // the boss eats its own queue so a crater still finishes.
    if (this.bossManager === null) this.drainShatter(SHATTER_PER_TICK, null);
    this._ambient(dt, ctx);
  }

  /**
   * Run the awakening clock.
   * @param {number} dt elapsed seconds
   * @param {Object} ctx the tick context
   * @returns {void}
   * @private
   */
  _updateCharge(dt, ctx) {
    if (!this.charging) return;
    this.chargeTimer -= dt;
    // The boss knits itself together while it charges.
    this.health = clamp(this.maxHealth * (0.3 + 0.7 * this.chargeProgress()), 1, this.maxHealth);
    if (this.chargeTimer > 0) return;
    this.finishCharge(ctx);
  }

  /**
   * End the awakening: shockwave, first phase, boss bar goes live.
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  finishCharge(ctx) {
    if (!this.charging) return;
    this.charging = false;
    this.chargeTimer = 0;
    this.health = this.maxHealth;
    this.phase = BOSS_PHASE.BARRAGE;
    this.barrageTimer = 0.8;

    const x = this.position[0];
    const y = this.position[1] + this.height * 0.5;
    const z = this.position[2];

    const em = ctx && ctx.entities ? ctx.entities : this.manager;
    if (em && typeof em.explode === 'function') {
      try {
        em.explode(x, y, z, CHARGE_BLAST_POWER, {
          destroy: true,
          fire: false,
          dropChance: 0,
          sourceId: this.id,
          player: ctx && ctx.player ? ctx.player : null,
          particles: ctx && ctx.particles ? ctx.particles : null,
          audio: ctx && ctx.audio ? ctx.audio : null,
        });
      } catch (err) {
        warnOnce('charge:blast', 'the awakening shockwave failed', err);
      }
    }

    emitParticles(ctx, 'explosion', x, y, z, { power: CHARGE_BLAST_POWER });
    emitParticles(ctx, 'portal', x, y, z, { count: 60, speed: 7, life: 1.6, spread: 3 });
    emitSound(ctx, 'thunder', x, y, z, { volume: 1, pitch: 0.55 });
    emitShake(ctx, 1, 1.6, x, y, z);

    const manager = managerFrom(ctx);
    if (manager !== null) {
      manager.report('awakened', this);
      manager.report('toast', BOSS_NAME, 'Der Himmel reißt auf.', '☄', 'danger');
    }
    if (ctx && ctx.player) this.setTarget(ctx.player);
  }

  /**
   * Promote the boss when its health crosses a threshold. Phases never go
   * backwards, so healing out of phase 3 does not undo the fight.
   * @param {Object} ctx the tick context
   * @returns {void}
   * @private
   */
  _updatePhase(ctx) {
    const frac = this.healthFraction();
    let want = BOSS_PHASE.BARRAGE;
    if (frac <= PHASE3_THRESHOLD) want = BOSS_PHASE.SWARM;
    else if (frac <= PHASE2_THRESHOLD) want = BOSS_PHASE.ARMOURED;
    if (want <= this.phase) return;
    this.enterPhase(want, ctx);
  }

  /**
   * Switch to a phase and fire everything that belongs to the transition.
   * @param {number} phase a {@link BOSS_PHASE} value
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  enterPhase(phase, ctx) {
    const previous = this.phase;
    this.phase = phase | 0;

    const x = this.position[0];
    const y = this.position[1] + this.height * 0.5;
    const z = this.position[2];

    if (this.phase === BOSS_PHASE.ARMOURED) {
      this.armorBonus = 10;
      this.rushTimer = 1.5;
      emitSound(ctx, 'anvil', x, y, z, { volume: 1, pitch: 0.6 });
      emitParticles(ctx, 'spark', x, y, z, { count: 40, speed: 5, life: 1.1, spread: 1.6 });
      emitShake(ctx, 0.6, 0.8, x, y, z);
    } else if (this.phase === BOSS_PHASE.SWARM) {
      this.armorBonus = 6;
      this.addCooldown = 0;
      emitSound(ctx, 'thunder', x, y, z, { volume: 1, pitch: 0.9 });
      emitParticles(ctx, 'portal', x, y, z, { count: 50, speed: 5, life: 1.4, spread: 2.2 });
      emitShake(ctx, 0.7, 0.9, x, y, z);
    }

    const manager = managerFrom(ctx);
    if (manager !== null) {
      manager.report('phase', this, this.phase, previous);
      manager.report('toast', BOSS_NAME, phaseLabel(this.phase), '☄', 'danger');
    }
  }

  /**
   * Keep the minion list honest and drain what is still alive.
   * @param {number} dt elapsed seconds
   * @param {Object} ctx the tick context
   * @returns {void}
   * @private
   */
  _updateAdds(dt, ctx) {
    const ids = this.addIds;
    if (ids.length === 0) {
      this.livingAdds = 0;
      return;
    }
    const em = (ctx && ctx.entities) || this.manager;
    let alive = 0;
    let write = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const e = em && typeof em.get === 'function' ? em.get(id) : null;
      if (e === null || e === undefined || e.removed === true || e.dead === true
        || e.dying === true) {
        continue;
      }
      // A save round-trip can turn a minion back into a plain entity (mob types
      // are not in the entity class registry). Anything that lost the marker is
      // dropped rather than left feeding the boss forever.
      if (e.witherAdd !== true) continue;
      const far = distSqTo(e.position, this.position[0], this.position[1], this.position[2])
        > ADD_LEASH * ADD_LEASH;
      ids[write++] = id;
      if (!far) alive++;
    }
    ids.length = write;
    this.livingAdds = alive;

    if (alive <= 0) {
      if (this.addCooldown <= 0 && this.phase >= BOSS_PHASE.SWARM && ids.length === 0) {
        // The wave is spent; the behaviour may raise the next one.
        this.addCooldown = 0;
      }
      return;
    }

    const gain = ADD_DRAIN * alive * dt;
    const before = this.health;
    this.healBoss(gain);
    this.drained += this.health - before;

    if (ctx && this.random() < dt * 6) {
      emitParticles(ctx, 'heart', this.position[0], this.position[1] + this.height * 0.75,
        this.position[2], { count: 1, speed: 0.5, life: 0.7 });
    }
  }

  /**
   * The three-stage anti-stuck escalation.
   *
   * Stage 1 carves the terrain around the body, stage 2 lets the boss phase
   * through it for a moment, stage 3 teleports it to verified open air. A
   * separate enclosure probe catches the case where the boss is not *trying*
   * to move but is nevertheless entombed.
   * @param {number} dt elapsed seconds
   * @param {Object} ctx the tick context
   * @returns {void}
   * @private
   */
  _updateStuck(dt, ctx) {
    if (this.noClipTimer > 0) {
      this.noClipTimer = Math.max(0, this.noClipTimer - dt);
      this.noClip = this.noClipTimer > 0;
      if (!this.noClip && this._isEnclosed()) {
        // Still buried when the phase window closed: escalate immediately.
        this.stuckStrikes = 3;
        this._triggerEscape(ctx);
      }
    }

    this._enclosedClock += dt;
    if (this._enclosedClock >= 0.5) {
      this._enclosedClock = 0;
      if (this.noClipTimer <= 0 && this._isEnclosed()) {
        this.stuckStrikes = Math.max(this.stuckStrikes, 2);
        this._triggerEscape(ctx);
      }
    }

    this._stuckClock += dt;
    if (this._stuckClock < STUCK_WINDOW) return;
    this._stuckClock = 0;

    const moved = Math.hypot(
      this.position[0] - this._stuckAnchor[0],
      this.position[1] - this._stuckAnchor[1],
      this.position[2] - this._stuckAnchor[2],
    );
    this._stuckAnchor[0] = this.position[0];
    this._stuckAnchor[1] = this.position[1];
    this._stuckAnchor[2] = this.position[2];

    if (this.moveIntent === 0 || moved >= STUCK_PROGRESS) {
      this.stuckStrikes = 0;
      return;
    }
    this.stuckStrikes++;
    this._triggerEscape(ctx);
  }

  /**
   * Act on the current stuck strike count.
   * @param {Object} ctx the tick context
   * @returns {void}
   * @private
   */
  _triggerEscape(ctx) {
    if (this.stuckStrikes <= 0) return;
    this.escapeTimer = Math.max(this.escapeTimer, 1.2);

    if (this.stuckStrikes === 1) {
      this.queueShatter(this.position[0], this.position[1] + this.height * 0.5,
        this.position[2], 2.6);
      this.velocity[1] = Math.max(this.velocity[1], 6);
      return;
    }
    if (this.stuckStrikes === 2) {
      this.queueShatter(this.position[0], this.position[1] + this.height * 0.5,
        this.position[2], 3.2);
      this.noClipTimer = NOCLIP_ESCAPE_SECONDS;
      this.noClip = true;
      this.velocity[1] = Math.max(this.velocity[1], 8);
      emitParticles(ctx, 'portal', this.position[0], this.position[1] + this.height * 0.5,
        this.position[2], { count: 20, speed: 3, life: 0.8, spread: 1.4 });
      return;
    }

    // Last resort: teleport somewhere verified free.
    const spot = this._findFreeSpot(14);
    if (spot !== null) {
      emitParticles(ctx, 'portal', this.position[0], this.position[1] + this.height * 0.5,
        this.position[2], { count: 30, speed: 4, life: 1, spread: 1.6 });
      this.setPosition(spot[0], spot[1], spot[2]);
      this.velocity[0] = 0;
      this.velocity[1] = 0;
      this.velocity[2] = 0;
      emitParticles(ctx, 'portal', spot[0], spot[1] + this.height * 0.5, spot[2],
        { count: 30, speed: 4, life: 1, spread: 1.6 });
      emitSound(ctx, 'thunder', spot[0], spot[1], spot[2], { volume: 0.6, pitch: 1.6 });
      const manager = managerFrom(ctx);
      if (manager !== null) manager.report('blink', this, spot[0], spot[1], spot[2]);
    } else {
      // Nothing free within reach: keep phasing rather than freeze forever.
      this.noClipTimer = NOCLIP_ESCAPE_SECONDS;
      this.noClip = true;
      this.velocity[1] = Math.max(this.velocity[1], 9);
    }
    this.stuckStrikes = 0;
    this.escapeTimer = Math.max(this.escapeTimer, 0.6);
  }

  /**
   * Whether the body currently overlaps solid terrain.
   * @returns {boolean} `true` when buried
   * @private
   */
  _isEnclosed() {
    const world = this.world;
    if (world === null || typeof world.getBlock !== 'function') return false;
    const x0 = Math.floor(this.position[0] - this.width * 0.5 + 0.05);
    const x1 = Math.floor(this.position[0] + this.width * 0.5 - 0.05);
    const z0 = Math.floor(this.position[2] - this.width * 0.5 + 0.05);
    const z1 = Math.floor(this.position[2] + this.width * 0.5 - 0.05);
    const y0 = Math.floor(this.position[1] + 0.1);
    const y1 = Math.floor(this.position[1] + this.height - 0.1);
    let solid = 0;
    let total = 0;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          total++;
          try {
            if (isSolid(world.getBlock(x, y, z))) solid++;
          } catch (err) {
            warnOnce('enclosed', 'the enclosure probe failed', err);
            return false;
          }
        }
      }
    }
    return total > 0 && solid / total > 0.5;
  }

  /**
   * Find open air near the boss that its whole body fits into.
   * @param {number} radius search radius in blocks
   * @returns {?number[]} a fresh `[x, y, z]` (feet), or `null`
   * @private
   */
  _findFreeSpot(radius) {
    const world = this.world;
    if (world === null || typeof world.getBlock !== 'function') return null;
    const target = this.target;
    const cx = target !== null && target.position ? target.position[0] : this.position[0];
    const cz = target !== null && target.position ? target.position[2] : this.position[2];

    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = this.random() * Math.PI * 2;
      const dist = 4 + this.random() * radius;
      const x = Math.floor(cx + Math.sin(angle) * dist) + 0.5;
      const z = Math.floor(cz + Math.cos(angle) * dist) + 0.5;
      let base;
      try {
        base = world.getHeight(Math.floor(x), Math.floor(z));
      } catch (err) {
        warnOnce('freespot', 'the height query failed while looking for open air', err);
        return null;
      }
      const y = base + GROUND_CLEARANCE + 1 + Math.floor(this.random() * 4);
      if (this._fitsAt(world, x, y, z)) return [x, y, z];
    }
    // Straight up is the fallback that always exists in an open world.
    const up = this.position[1] + 12;
    if (this._fitsAt(world, this.position[0], up, this.position[2])) {
      return [this.position[0], up, this.position[2]];
    }
    return null;
  }

  /**
   * Whether the body fits at a position without touching solid terrain.
   * @param {Object} world the World
   * @param {number} x world X (centre)
   * @param {number} y world Y (feet)
   * @param {number} z world Z (centre)
   * @returns {boolean} `true` when the spot is free
   * @private
   */
  _fitsAt(world, x, y, z) {
    const half = this.width * 0.5;
    const x0 = Math.floor(x - half);
    const x1 = Math.floor(x + half);
    const z0 = Math.floor(z - half);
    const z1 = Math.floor(z + half);
    const y1 = Math.floor(y + this.height);
    for (let by = Math.floor(y); by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (let bx = x0; bx <= x1; bx++) {
          try {
            if (isSolid(world.getBlock(bx, by, bz))) return false;
          } catch (err) {
            warnOnce('fits', 'the clearance probe failed', err);
            return false;
          }
        }
      }
    }
    return true;
  }

  /**
   * Fly back when the boss has drifted too far from the ritual site.
   * @returns {void}
   * @private
   */
  _updateLeash() {
    if (this.arena === null) return;
    const d2 = distSqTo(this.position, this.arena[0], this.arena[1], this.arena[2]);
    if (d2 <= ARENA_LEASH * ARENA_LEASH) return;
    // Nudge, not teleport: the behaviours keep control, they simply drift home.
    const inv = 1 / Math.max(1e-3, Math.sqrt(d2));
    this.velocity[0] += (this.arena[0] - this.position[0]) * inv * 6;
    this.velocity[1] += (this.arena[1] + 8 - this.position[1]) * inv * 3;
    this.velocity[2] += (this.arena[2] - this.position[2]) * inv * 6;
  }

  /**
   * Idle smoke and the odd growl.
   * @param {number} dt elapsed seconds
   * @param {Object} ctx the tick context
   * @returns {void}
   * @private
   */
  _ambient(dt, ctx) {
    if (!ctx) return;
    if (this.random() < dt * 6) {
      emitParticles(ctx, 'smoke', this.position[0], this.position[1] + this.height * 0.8,
        this.position[2], { count: 1, speed: 0.4, life: 1.4, spread: 0.5 });
    }
  }

  /**
   * Integrate one tick of movement.
   *
   * `Mob#applyMovement` always runs the swept collision, so the inherited
   * version can never free a buried boss. While the escape window is open this
   * integrates ballistically instead — that is the guarantee that the boss can
   * never stay stuck in terrain.
   * @param {number} dt elapsed seconds
   * @param {Object} world the chunk manager
   * @returns {void}
   */
  applyMovement(dt, world) {
    if (this.noClipTimer <= 0) {
      super.applyMovement(dt, world);
      return;
    }
    const v = this.velocity;
    this.position[0] += v[0] * dt;
    this.position[1] += v[1] * dt;
    this.position[2] += v[2] * dt;
    this.syncAABB();
    this.onGround = false;
    this.inWater = false;
    this.inLava = false;
    this.submerged = 0;
    this.fallDistance = 0;
    this.bodyYaw = this.updateBodyYaw(dt);
  }

  /* --------------------------------------------------------------- senses -- */

  /**
   * A boss never loses interest. The shared senses pick the target; this keeps
   * it once it is picked, even through walls, and grabs a nearby player the
   * moment the fight starts.
   * @param {number} dt elapsed seconds
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  updateSenses(dt, ctx) {
    if (this.charging) {
      this.target = null;
      return;
    }
    super.updateSenses(dt, ctx);
    if (this.target === null) {
      const player = ctx ? ctx.player : null;
      if (isEngageablePlayer(player)
        && distSqTo(this.position, player.position[0], player.position[1], player.position[2])
          <= BOSS_AGGRO_RANGE * BOSS_AGGRO_RANGE) {
        this.setTarget(player);
      }
    }
    if (this.target !== null) this.targetMemory = Math.max(this.targetMemory, 8);
  }

  /**
   * The boss is immune to the world: no burning, no drowning, no suffocation.
   * Only the void still counts, and even that only far below the world.
   * @param {number} dt elapsed seconds
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  updateEnvironmentDamage(dt, ctx) {
    this.burningTimer = 0;
    this.drownTimer = 0;
    this.lavaAccum = 0;
    this.burnAccum = 0;
    if (this.position[1] < VOID_LEVEL - 32) {
      // Pushed out of the world entirely: put it back instead of killing it.
      this.setPosition(this.arena === null ? this.position[0] : this.arena[0],
        (this.arena === null ? 64 : this.arena[1]) + 12,
        this.arena === null ? this.position[2] : this.arena[2]);
      this.velocity[0] = 0;
      this.velocity[1] = 0;
      this.velocity[2] = 0;
    }
    void ctx;
  }

  /* --------------------------------------------------------------- combat -- */

  /**
   * Take damage.
   *
   * Replaces {@link Mob#damage} entirely so the boss's rules can never drift:
   * invulnerable while charging, immune to its own damage types, armour from
   * the phase, and a rolling window that decides when to retreat. Knockback
   * immunity comes from `knockbackResistance: 1` in {@link WITHER_BOSS_DEF},
   * which {@link Mob#onHurt} honours.
   *
   * @param {number} amount raw damage in half-hearts
   * @param {?(Object|string)} [source] a damage-source string or record
   * @returns {boolean} `true` when damage was applied
   */
  damage(amount, source = null) {
    if (this.dead || this.dying || this.removed) return false;
    const raw = num(amount, 0);
    if (raw <= 0) return false;

    const kind = typeof source === 'string' ? source
      : (source && typeof source.type === 'string' ? source.type : '');
    if (IMMUNE_SOURCES.has(kind)) return false;

    const ctx = this.context();
    if (this.charging) {
      // The awakening cannot be interrupted — show that it was refused.
      emitParticles(ctx, 'spark', this.position[0], this.position[1] + this.height * 0.6,
        this.position[2], { count: 6, speed: 2.5, life: 0.4 });
      emitSound(ctx, 'anvil', this.position[0], this.position[1], this.position[2],
        { volume: 0.4, pitch: 1.9 });
      return false;
    }

    if (this.immunity > 0 && raw <= (this.lastDamage || 0)) return false;

    const armor = clamp(this.def.armor + this.armorBonus, 0, 20);
    const reduced = raw * (1 - clamp(armor * 0.04, 0, 0.8));
    if (reduced <= 0) return false;

    this.health -= reduced;
    this.lastDamage = raw;
    this.immunity = 0.35;
    this.hurtTime = 10;

    this.damageWindow += reduced;
    this.damageWindowTimer = DAMAGE_WINDOW;

    this.playSound(ctx, 'hurt', 1);
    this.onHurt(source);

    if (this.health <= 0) {
      this.health = 0;
      this.die(source, ctx);
      return true;
    }

    if (this.retreatCooldown <= 0 && this.retreatTimer <= 0
      && this.damageWindow >= RETREAT_DAMAGE && this.healthFraction() < 0.6) {
      this.retreatTimer = RETREAT_SECONDS;
      this.retreatCooldown = RETREAT_COOLDOWN;
      this.damageWindow = 0;
    }
    return true;
  }

  /**
   * React to a hit: no panic, no knockback, but the whole arena hears it.
   * @param {?(Object|string)} source the damage source
   * @returns {void}
   */
  onHurt(source) {
    const attacker = source && typeof source === 'object'
      ? (source.mob || source.entity || source.player || null) : null;
    if (attacker && attacker !== this && attacker.position) {
      this.setTarget(attacker);
      this.alertAdds(attacker);
    } else {
      const ctx = this.context();
      if (this.target === null && ctx && isEngageablePlayer(ctx.player)) {
        this.setTarget(ctx.player);
        this.alertAdds(ctx.player);
      }
    }
    // Never panics, is never knocked back, never loses love (it has none).
    this.panicTimer = 0;
    this.panicSource = null;
  }

  /**
   * Point every living minion at a target.
   * @param {Object} enemy the entity the minions should attack
   * @returns {void}
   */
  alertAdds(enemy) {
    if (!enemy) return;
    const em = this.manager;
    if (em === null || typeof em.get !== 'function') return;
    for (let i = 0; i < this.addIds.length; i++) {
      const e = em.get(this.addIds[i]);
      if (e && typeof e.setTarget === 'function' && e.dead !== true) {
        try {
          e.setTarget(enemy);
          e.angerTimer = 30;
        } catch (err) {
          warnOnce('alert', 'a minion refused a target', err);
        }
      }
    }
  }

  /**
   * Heal without ever exceeding the maximum, and without reviving a corpse.
   * @param {number} amount half-hearts to restore
   * @returns {void}
   */
  healBoss(amount) {
    const v = num(amount, 0);
    if (v <= 0 || this.dying || this.dead) return;
    this.health = Math.min(this.maxHealth, this.health + v);
  }

  /* ---------------------------------------------------------- projectiles -- */

  /**
   * Fire one volley at a target.
   * @param {Object} ctx the tick context
   * @param {Object} target the entity to shoot at
   * @returns {number} how many skulls were spawned
   */
  fireBarrage(ctx, target) {
    const count = this.barrageCount();
    let fired = 0;
    for (let i = 0; i < count; i++) {
      // Fan the volley out: the middle skull is the aimed one.
      const offset = count === 1 ? 0 : (i - (count - 1) * 0.5) * 0.14;
      if (this.fireSkull(ctx, target, offset, i === 0 && this.phase >= BOSS_PHASE.SWARM)) fired++;
    }
    if (fired > 0) {
      const x = this.position[0];
      const y = this.eyeY();
      const z = this.position[2];
      emitSound(ctx, 'bow_shoot', x, y, z, { volume: 0.9, pitch: 0.6 });
      emitParticles(ctx, 'smoke', x, y, z, { count: 6, speed: 1.6, life: 0.5, spread: 0.4 });
    }
    return fired;
  }

  /**
   * Spawn one skull, leading the shot so a running target is actually hit.
   * @param {Object} ctx the tick context
   * @param {Object} target the entity to shoot at
   * @param {number} [yawOffset] radians of fan-out for volleys
   * @param {boolean} [charged] fire the heavier, homing variant
   * @returns {boolean} `true` when a skull was spawned
   */
  fireSkull(ctx, target, yawOffset = 0, charged = false) {
    const em = (ctx && ctx.entities) || this.manager;
    if (!em || typeof em.spawn !== 'function' || !target || !target.position) return false;

    const speed = charged ? SKULL_SPEED * 0.8 : SKULL_SPEED;
    const ox = this.position[0];
    const oy = this.eyeY() - 0.35;
    const oz = this.position[2];

    // Lead prediction: solve where the target will be when the skull arrives.
    let tx = target.position[0];
    let ty = target.position[1] + eyeOffset(target) * 0.6;
    let tz = target.position[2];
    let flight = Math.hypot(tx - ox, ty - oy, tz - oz) / speed;
    if (target.velocity && target.velocity.length >= 3) {
      // Two refinement passes: the first estimate moves the aim point, which
      // changes the flight time, which moves the aim point again.
      for (let pass = 0; pass < 2; pass++) {
        const px = target.position[0] + num(target.velocity[0], 0) * flight;
        const py = target.position[1] + eyeOffset(target) * 0.6
          + num(target.velocity[1], 0) * flight * 0.5;
        const pz = target.position[2] + num(target.velocity[2], 0) * flight;
        flight = Math.hypot(px - ox, py - oy, pz - oz) / speed;
        tx = px; ty = py; tz = pz;
      }
    }

    let dx = tx - ox;
    let dy = ty - oy;
    let dz = tz - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    dx /= len; dy /= len; dz /= len;

    if (yawOffset !== 0) {
      const c = Math.cos(yawOffset);
      const s = Math.sin(yawOffset);
      const nx = dx * c - dz * s;
      const nz = dx * s + dz * c;
      dx = nx;
      dz = nz;
    }

    // A little scatter, tighter in the later phases.
    const spread = (this.phase >= BOSS_PHASE.SWARM ? 0.02 : 0.045)
      / Math.max(0.5, num(ctx && ctx.difficulty, 2) * 0.5);
    dx += (this.random() - 0.5) * spread;
    dy += (this.random() - 0.5) * spread;
    dz += (this.random() - 0.5) * spread;

    let skull;
    try {
      skull = new WitherSkullEntity(ox, oy, oz, {
        velocity: [dx * speed, dy * speed, dz * speed],
        charged,
        power: charged ? CHARGED_SKULL_POWER : SKULL_POWER,
        destroy: true,
        ownerId: this.id,
        witherSeconds: SKULL_WITHER_SECONDS,
        witherAmplifier: charged ? 1 : 0,
        homing: charged ? 0.6 : 0,
        targetId: charged && Number.isFinite(target.id) ? target.id | 0 : 0,
      });
    } catch (err) {
      warnOnce('skull:new', 'a wither skull could not be constructed', err);
      return false;
    }

    try {
      if (em.spawn(skull) === null) return false;
    } catch (err) {
      warnOnce('skull:spawn', 'the entity manager refused a wither skull', err);
      return false;
    }
    if (this.bossManager !== null) this.bossManager.stats.skulls++;
    return true;
  }

  /* --------------------------------------------------------------- impact -- */

  /**
   * Resolve the end of a dash: melee damage, knockback and a shattered crater.
   * @param {Object} ctx the tick context
   * @param {?Object} victim the entity that was rammed, if any
   * @returns {void}
   */
  rushImpact(ctx, victim) {
    const x = this.position[0];
    const y = this.position[1] + this.height * 0.4;
    const z = this.position[2];

    this.queueShatter(x, y, z, SHATTER_RADIUS);

    if (victim !== null) {
      const damage = this.def.attackDamage * (this.phase >= BOSS_PHASE.SWARM ? 1.25 : 1);
      let dx = victim.position[0] - this.position[0];
      let dz = victim.position[2] - this.position[2];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;

      const combat = ctx && ctx.combat ? ctx.combat : null;
      let handled = false;
      if (combat !== null && typeof combat.dealDamage === 'function') {
        try {
          combat.dealDamage(victim, damage, 'mob', [dx * this.def.knockback, 0,
            dz * this.def.knockback]);
          handled = true;
        } catch (err) {
          warnOnce('rush:combat', 'the combat system rejected the dash impact', err);
        }
      }
      if (!handled && typeof victim.damage === 'function') {
        try {
          victim.damage(damage, { type: 'mob', mob: this });
        } catch (err) {
          warnOnce('rush:damage', 'the dash target refused damage', err);
        }
      }
      if (victim.velocity && victim.velocity.length >= 3) {
        victim.velocity[0] += dx * 14;
        victim.velocity[1] = Math.max(victim.velocity[1], 8);
        victim.velocity[2] += dz * 14;
      }
      this.swinging = true;
    }

    // Bounce off the impact so the boss does not grind against the crater.
    this.velocity[0] *= -0.25;
    this.velocity[1] = Math.max(this.velocity[1], 5);
    this.velocity[2] *= -0.25;

    emitParticles(ctx, 'explosion', x, y, z, { power: 2 });
    emitParticles(ctx, 'dust', x, y, z, { count: 30, speed: 5, life: 1.1, spread: 1.8 });
    emitSound(ctx, 'explode', x, y, z, { volume: 1, pitch: 0.6 });
    emitShake(ctx, 0.75, 0.6, x, y, z);

    const manager = managerFrom(ctx);
    if (manager !== null) manager.report('impact', this, x, y, z);
  }

  /* -------------------------------------------------------------- shatter -- */

  /**
   * Queue a sphere of terrain for destruction. Nothing is destroyed here: the
   * job is eaten a few blocks at a time by {@link WitherBoss#drainShatter}, so
   * a crater never costs one long frame.
   * @param {number} x centre X
   * @param {number} y centre Y
   * @param {number} z centre Z
   * @param {number} radius radius in blocks (clamped to 5)
   * @returns {void}
   */
  queueShatter(x, y, z, radius) {
    const r = clamp(num(radius, 3), 0.5, SHATTER_MAX_R);
    if (this.shatterQueue.length >= 8) this.shatterQueue.shift();
    this.shatterQueue.push({
      x: Math.floor(x),
      y: Math.floor(y),
      z: Math.floor(z),
      r2: r * r,
      cursor: 0,
    });
  }

  /**
   * Destroy up to `limit` queued blocks, stopping early when the shared time
   * budget runs out.
   * @param {number} limit maximum blocks this call may remove
   * @param {?TimeBudget} budget shared budget, or `null` for none
   * @returns {number} how many blocks were destroyed
   */
  drainShatter(limit, budget) {
    const queue = this.shatterQueue;
    if (queue.length === 0) return 0;
    const world = this.world;
    if (world === null || typeof world.setBlock !== 'function') {
      queue.length = 0;
      return 0;
    }

    let removed = 0;
    let steps = 0;
    const maxSteps = Math.max(1, limit | 0) * 8;

    while (queue.length > 0 && removed < limit && steps < maxSteps) {
      const job = queue[0];
      if (job.cursor >= SHATTER_COUNT || SHATTER_DIST2[job.cursor] > job.r2) {
        queue.shift();
        continue;
      }
      const i = job.cursor++;
      steps++;
      const bx = job.x + SHATTER_OFFSETS[i * 3];
      const by = job.y + SHATTER_OFFSETS[i * 3 + 1];
      const bz = job.z + SHATTER_OFFSETS[i * 3 + 2];

      let id = 0;
      try {
        id = world.getBlock(bx, by, bz);
      } catch (err) {
        warnOnce('shatter:read', 'a block read failed during the shatter', err);
        queue.shift();
        continue;
      }
      if (id === 0) continue;
      const def = getBlock(id);
      if (def.liquid === true) continue;
      if (blastResistance(id) > SHATTER_MAX_RESISTANCE) continue;

      try {
        if (world.setBlock(bx, by, bz, 0)) removed++;
      } catch (err) {
        warnOnce('shatter:write', 'a block write failed during the shatter', err);
        queue.shift();
        continue;
      }

      if (removed % 6 === 1) {
        emitParticles(this.context(), 'break', bx + 0.5, by + 0.5, bz + 0.5,
          { count: 4, blockId: id, speed: 2, life: 0.7 });
      }
      if (budget !== null && budget.expired()) break;
    }
    return removed;
  }

  /* -------------------------------------------------------------- minions -- */

  /**
   * Raise a wave of minions around the boss.
   * @param {Object} ctx the tick context
   * @returns {number} how many minions were spawned
   */
  summonAdds(ctx) {
    const em = (ctx && ctx.entities) || this.manager;
    if (!em || typeof em.spawn !== 'function') return 0;
    const world = this.world;
    this.addCooldown = ADD_COOLDOWN;

    let spawned = 0;
    for (let i = 0; i < ADD_COUNT; i++) {
      const angle = (i / ADD_COUNT) * Math.PI * 2 + this.random() * 0.7;
      const dist = 3 + this.random() * 3;
      const x = this.position[0] + Math.sin(angle) * dist;
      const z = this.position[2] + Math.cos(angle) * dist;
      const y = this._groundBelow(world, x, z, this.position[1] + 2);
      if (y === null) continue;

      let mob = null;
      for (let t = 0; t < ADD_TYPES.length && mob === null; t++) {
        try {
          mob = createMob(ADD_TYPES[t], x, y, z, { rng: this.rng, baby: false });
        } catch (err) {
          warnOnce('adds:create', 'a minion could not be created', err);
          mob = null;
        }
      }
      if (mob === null) continue;

      /** @type {boolean} marks this mob as one of the boss's minions */
      mob.witherAdd = true;
      /** @type {number} the boss this minion feeds */
      mob.witherBossId = this.id;
      mob.fireProof = true;
      if (mob.def && mob.def.burnsInDaylight) mob.burningTimer = 0;
      if (this.target !== null && typeof mob.setTarget === 'function') {
        mob.setTarget(this.target);
        mob.angerTimer = 60;
      }

      let ok = null;
      try {
        ok = em.spawn(mob);
      } catch (err) {
        warnOnce('adds:spawn', 'the entity manager refused a minion', err);
        ok = null;
      }
      if (ok === null) continue;

      this.addIds.push(mob.id);
      spawned++;
      emitParticles(ctx, 'portal', x, y + 1, z, { count: 14, speed: 2.5, life: 0.9, spread: 0.7 });
    }

    this.livingAdds = spawned;
    if (spawned > 0) {
      emitSound(ctx, 'thunder', this.position[0], this.position[1], this.position[2],
        { volume: 0.9, pitch: 1.2 });
      emitShake(ctx, 0.35, 0.5, this.position[0], this.position[1], this.position[2]);
      const manager = managerFrom(ctx);
      if (manager !== null) {
        manager.report('addsSummoned', this, spawned);
        manager.report('toast', ADD_NAME, `${spawned} Diener erheben sich.`, '☠', 'danger');
      }
    }
    return spawned;
  }

  /**
   * First solid floor below a point, with two blocks of head room.
   * @param {?Object} world the World
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} fromY world Y to start scanning down from
   * @returns {?number} world Y of the standing surface, or `null`
   * @private
   */
  _groundBelow(world, x, z, fromY) {
    if (!world || typeof world.getBlock !== 'function') return null;
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const start = Math.floor(fromY);
    for (let y = start; y > start - 24; y--) {
      let below;
      let here;
      let above;
      try {
        below = world.getBlock(bx, y - 1, bz);
        here = world.getBlock(bx, y, bz);
        above = world.getBlock(bx, y + 1, bz);
      } catch (err) {
        warnOnce('ground', 'the ground probe failed', err);
        return null;
      }
      if (isSolid(below) && !isSolid(here) && !isSolid(above)) return y;
    }
    return null;
  }

  /**
   * Kill every living minion — used when the boss falls, so the arena empties
   * with it.
   * @param {Object} ctx the tick context
   * @returns {number} how many minions were dismissed
   */
  dismissAdds(ctx) {
    const em = (ctx && ctx.entities) || this.manager;
    if (!em || typeof em.get !== 'function') {
      this.addIds.length = 0;
      this.livingAdds = 0;
      return 0;
    }
    let count = 0;
    for (let i = 0; i < this.addIds.length; i++) {
      const e = em.get(this.addIds[i]);
      if (!e || e.removed === true || e.dead === true) continue;
      emitParticles(ctx, 'smoke', e.position[0], e.position[1] + 1, e.position[2],
        { count: 10, speed: 1.6, life: 0.8 });
      try {
        if (typeof e.damage === 'function') e.damage(1e6, { type: 'magic' });
        if (e.removed !== true && typeof e.remove === 'function') e.remove('boss_dismissed');
      } catch (err) {
        warnOnce('dismiss', 'a minion could not be dismissed', err);
      }
      count++;
    }
    this.addIds.length = 0;
    this.livingAdds = 0;
    return count;
  }

  /* ----------------------------------------------------------------- death -- */

  /**
   * Begin the death sequence.
   * @param {?Object} source the damage source
   * @param {Object} ctx the tick context
   * @returns {void}
   */
  die(source, ctx) {
    if (this.dying) return;
    const x = this.position[0];
    const y = this.position[1] + this.height * 0.5;
    const z = this.position[2];

    this.charging = false;
    this.shatterQueue.length = 0;
    this.dismissAdds(ctx);

    super.die(source, ctx);

    emitParticles(ctx, 'explosion', x, y, z, { power: 4 });
    emitParticles(ctx, 'portal', x, y, z, { count: 80, speed: 6, life: 2.2, spread: 3 });
    emitSound(ctx, 'thunder', x, y, z, { volume: 1, pitch: 0.75 });
    emitSound(ctx, 'levelup', x, y, z, { volume: 0.9, pitch: 0.8 });
    emitShake(ctx, 1, 2.0, x, y, z);

    const manager = managerFrom(ctx);
    if (manager !== null) {
      manager.report('defeated', this, source || null);
      manager.report('toast', `${BOSS_NAME} ist gefallen`,
        'Ein Netherstern bleibt zurück.', '⭐', 'achievement');
    }
  }

  /**
   * Drop the trophy. The definition's loot table is deliberately empty so the
   * unique drop lives in one obvious place.
   * @param {?Object} source the damage source
   * @param {Object} ctx the tick context
   * @returns {number} how many stacks were dropped
   */
  dropLoot(source, ctx) {
    if (this._looted) return 0;
    this._looted = true;
    const em = (ctx && ctx.entities) || this.manager;
    if (!em || typeof em.dropItem !== 'function') return 0;
    const stack = bossTrophyStack();
    if (stack === null) return 0;
    const dropped = em.dropItem(this.position[0], this.position[1] + this.height * 0.5,
      this.position[2], stack, [0, 3, 0]);
    return dropped === null ? 0 : 1;
  }

  /* --------------------------------------------------------- serialisation -- */

  /**
   * Snapshot the whole fight, so a save taken mid-encounter reloads into
   * exactly the same phase, timers, minions and crater work.
   * @returns {Object} a plain, JSON-safe record
   */
  serialize() {
    return {
      type: BOSS_TYPE,
      kind: 'boss',
      v: BOSS_SAVE_VERSION,
      id: this.id,
      p: [this.position[0], this.position[1], this.position[2]],
      v3: [this.velocity[0], this.velocity[1], this.velocity[2]],
      yaw: this.bodyYaw,
      hp: this.health,
      maxHp: this.maxHealth,
      age: this.age,
      phase: this.phase,
      charging: this.charging,
      chargeTimer: this.chargeTimer,
      armorBonus: this.armorBonus,
      arena: this.arena === null ? null : [this.arena[0], this.arena[1], this.arena[2]],
      barrageTimer: this.barrageTimer,
      rushTimer: this.rushTimer,
      retreatTimer: this.retreatTimer,
      retreatCooldown: this.retreatCooldown,
      addIds: this.addIds.slice(),
      addCooldown: this.addCooldown,
      drained: this.drained,
    };
  }

  /**
   * Restore a boss from {@link WitherBoss#serialize}.
   * @param {Object} o the record
   * @returns {?WitherBoss} the boss, or `null` when the record is unusable
   */
  static deserialize(o) {
    if (!o || typeof o !== 'object') return null;
    const p = Array.isArray(o.p) ? o.p : [0, 0, 0];
    let boss;
    try {
      boss = new WitherBoss(num(p[0], 0), num(p[1], 0), num(p[2], 0), {
        charging: o.charging === true,
        arena: Array.isArray(o.arena) ? o.arena : null,
      });
    } catch (err) {
      warnOnce('boss:restore', 'the boss could not be reconstructed', err);
      return null;
    }

    const v = Array.isArray(o.v3) ? o.v3 : (Array.isArray(o.v) ? o.v : null);
    if (v !== null && v.length >= 3) {
      boss.velocity[0] = num(v[0], 0);
      boss.velocity[1] = num(v[1], 0);
      boss.velocity[2] = num(v[2], 0);
    }
    if (Number.isFinite(o.id)) boss.id = o.id | 0;
    boss.maxHealth = Math.max(1, num(o.maxHp, BOSS_MAX_HEALTH));
    boss.health = clamp(num(o.hp, boss.maxHealth), 0.5, boss.maxHealth);
    boss.age = Math.max(0, num(o.age, 0));
    boss.bodyYaw = num(o.yaw, 0);
    boss.modelYaw = boss.bodyYaw;
    boss.phase = clamp(num(o.phase, BOSS_PHASE.BARRAGE) | 0, 0, 3);
    boss.charging = o.charging === true;
    boss.chargeTimer = boss.charging
      ? clamp(num(o.chargeTimer, CHARGE_SECONDS), 0, CHARGE_SECONDS) : 0;
    boss.armorBonus = clamp(num(o.armorBonus, 0), 0, 16);
    boss.barrageTimer = Math.max(0, num(o.barrageTimer, 1));
    boss.rushTimer = Math.max(0, num(o.rushTimer, RUSH_COOLDOWN));
    boss.retreatTimer = Math.max(0, num(o.retreatTimer, 0));
    boss.retreatCooldown = Math.max(0, num(o.retreatCooldown, 0));
    boss.addCooldown = Math.max(0, num(o.addCooldown, 0));
    boss.drained = Math.max(0, num(o.drained, 0));
    boss.addIds.length = 0;
    if (Array.isArray(o.addIds)) {
      for (let i = 0; i < o.addIds.length; i++) {
        const id = num(o.addIds[i], 0) | 0;
        if (id > 0) boss.addIds.push(id);
      }
    }
    boss.prevPosition[0] = boss.position[0];
    boss.prevPosition[1] = boss.position[1];
    boss.prevPosition[2] = boss.position[2];
    boss.syncAABB();
    return boss;
  }
}

registerEntityClass(BOSS_TYPE, WitherBoss);
registerEntityClass(SKULL_TYPE, WitherSkullEntity);

/* ========================================================================== */
/* Boss bar                                                                   */
/* ========================================================================== */

/**
 * Documentation-only template of {@link BossManager#bossBar}. The real object
 * is mutated in place every tick and is never replaced, so the HUD may hold a
 * reference to it forever and simply read fields.
 * @type {Readonly<Object>}
 */
export const BOSS_BAR_SHAPE = Object.freeze({
  /** `true` while a boss exists, is alive and is close enough to matter. */
  active: false,
  /** German boss name. */
  name: BOSS_NAME,
  /** German subtitle: phase label, or the awakening countdown. */
  subtitle: '',
  /** Current {@link BOSS_PHASE}. */
  phase: 0,
  /** German phase label. */
  phaseLabel: '',
  /** Health in half-hearts. */
  health: 0,
  /** Maximum health in half-hearts. */
  maxHealth: BOSS_MAX_HEALTH,
  /** `health / maxHealth`, clamped to `0..1` — the bar fill. */
  progress: 0,
  /** `true` during the invulnerable awakening. */
  charging: false,
  /** Awakening progress `0..1`; `1` whenever `charging` is false. */
  chargeProgress: 1,
  /** `true` while damage is being refused. */
  invulnerable: false,
  /** Living minions feeding the boss. */
  adds: 0,
  /** Distance from the player in blocks, `-1` when unknown. */
  distance: -1,
  /** Suggested CSS colour for the bar fill. */
  color: '#3c332f',
  /** Entity id of the boss the bar describes, `0` when inactive. */
  id: 0,
});

/* ========================================================================== */
/* BossManager                                                                */
/* ========================================================================== */

/**
 * Owner of the encounter.
 *
 * Watches block placement for the ritual, spawns the boss, publishes the HUD
 * boss-bar state, drains every boss's shatter queue under a shared
 * {@link TimeBudget}, and serialises the fight.
 *
 * Events (all through {@link EventBus}):
 * `summonStructure(x, y, z, axis)`, `summoned(boss)`, `awakened(boss)`,
 * `phase(boss, phase, previous)`, `rush(boss)`, `impact(boss, x, y, z)`,
 * `retreat(boss)`, `summonWave(boss)`, `addsSummoned(boss, count)`,
 * `blink(boss, x, y, z)`, `skullImpact(x, y, z, power, charged)`,
 * `defeated(boss, source)`, `cleared(boss)`,
 * `sound(name, x, y, z, volume, pitch)`,
 * `particles(type, x, y, z, opts)`, `shake(strength, seconds, x, y, z)`,
 * `toast(title, subtitle, icon, kind)`.
 */
export class BossManager extends EventBus {
  /**
   * @param {?Object} world the chunk manager (`world/world.js`)
   * @param {Object} [options] wiring; every field is optional and degrades
   * @param {?Object} [options.entities] the entity manager
   * @param {?Object} [options.effects] the `game/effects.js` EffectManager
   * @param {?Object} [options.particles] the particle system
   * @param {?Object} [options.audio] the audio engine
   * @param {?Object} [options.combat] the combat system
   * @param {?Object} [options.player] the local player
   * @param {number} [options.budgetMs] milliseconds per tick for terrain work
   * @param {boolean} [options.autoWatch] hook `world.blockChanged` immediately
   */
  constructor(world, options = {}) {
    super();

    /** @type {?Object} The world the ritual is watched in. */
    this.world = null;
    /** @type {?Object} Entity manager. */
    this.entities = options.entities || null;
    /** @type {?Object} Effect manager, used for the wither effect. */
    this.effects = options.effects || null;
    /** @type {?Object} Particle system. */
    this.particles = options.particles || null;
    /** @type {?Object} Audio engine. */
    this.audio = options.audio || null;
    /** @type {?Object} Combat system. */
    this.combat = options.combat || null;
    /** @type {?Object} The local player. */
    this.player = options.player || null;
    /** @type {boolean} Set by {@link BossManager#dispose}. */
    this.disposed = false;
    /** @type {boolean} Ritual detection can be switched off entirely. */
    this.ritualEnabled = SOUL_BLOCKS.primary !== 0 && SKULL_BLOCKS.primary !== 0;

    /** @type {number[]} Entity ids of every living boss. */
    this.bossIds = [];
    /** @type {WitherBoss[]} Resolved bosses, rebuilt every update. @private */
    this._bosses = [];
    /** @type {number} How many bosses have been defeated in this world. */
    this.kills = 0;

    /** @type {TimeBudget} Guards the terrain shatter. @private */
    this._budget = new TimeBudget(num(options.budgetMs, SHATTER_BUDGET_MS));
    /** @type {{bosses:number, shattered:number, skulls:number}} Live counters. */
    this.stats = { bosses: 0, shattered: 0, skulls: 0 };

    /**
     * The HUD boss-bar state. Mutated in place, never replaced.
     * @type {Object}
     */
    this.bossBar = {
      active: false,
      name: BOSS_NAME,
      subtitle: '',
      phase: BOSS_PHASE.CHARGING,
      phaseLabel: '',
      health: 0,
      maxHealth: BOSS_MAX_HEALTH,
      progress: 0,
      charging: false,
      chargeProgress: 1,
      invulnerable: false,
      adds: 0,
      distance: -1,
      color: phaseColor(BOSS_PHASE.CHARGING),
      id: 0,
    };

    /** @type {Object} Reusable tick context handed to bosses. @private */
    this._ctx = {
      world: null, player: null, entities: null, environment: null,
      audio: null, particles: null, combat: null, effects: null,
      difficulty: 2, boss: this,
    };

    /**
     * Bound `blockChanged` listener, kept so it can be detached again.
     * @type {function(number, number, number, number, number): void}
     * @private
     */
    this._onBlockChanged = (x, y, z, prev, id) => {
      void prev;
      this.onBlockPlaced(x, y, z, id);
    };
    /** @type {?Object} The world the listener is currently attached to. @private */
    this._watched = null;

    setActiveBossManager(this);
    if (world) this.attachWorld(world, options.autoWatch !== false);
  }

  /* ----------------------------------------------------------------- wiring */

  /**
   * Point the manager at a world and (optionally) start watching block
   * placement for the ritual.
   * @param {?Object} world the World
   * @param {boolean} [watch] subscribe to `world.blockChanged`
   * @returns {BossManager} `this`
   */
  attachWorld(world, watch = true) {
    if (this._watched !== null && typeof this._watched.off === 'function') {
      try {
        this._watched.off('blockChanged', this._onBlockChanged);
      } catch (err) {
        warnOnce('detach', 'the previous world refused to release the boss listener', err);
      }
      this._watched = null;
    }
    this.world = world || null;
    this._ctx.world = this.world;
    if (watch && this.world !== null && typeof this.world.on === 'function') {
      try {
        this.world.on('blockChanged', this._onBlockChanged);
        this._watched = this.world;
      } catch (err) {
        warnOnce('attach', 'the world refused the boss block listener', err);
      }
    }
    return this;
  }

  /**
   * Inject or replace the entity manager.
   * @param {?Object} entities the entity manager
   * @returns {BossManager} `this`
   */
  setEntities(entities) {
    this.entities = entities || null;
    return this;
  }

  /**
   * Inject or replace the effect manager (the wither effect needs it).
   * @param {?Object} effects the EffectManager
   * @returns {BossManager} `this`
   */
  setEffects(effects) {
    this.effects = effects || null;
    return this;
  }

  /**
   * Inject or replace the local player.
   * @param {?Object} player the player
   * @returns {BossManager} `this`
   */
  setPlayer(player) {
    this.player = player || null;
    return this;
  }

  /**
   * Inject or replace the particle system.
   * @param {?Object} particles the particle system
   * @returns {BossManager} `this`
   */
  setParticles(particles) {
    this.particles = particles || null;
    return this;
  }

  /**
   * Inject or replace the audio engine.
   * @param {?Object} audio the audio engine
   * @returns {BossManager} `this`
   */
  setAudio(audio) {
    this.audio = audio || null;
    return this;
  }

  /**
   * Inject or replace the combat system.
   * @param {?Object} combat the combat system
   * @returns {BossManager} `this`
   */
  setCombat(combat) {
    this.combat = combat || null;
    return this;
  }

  /**
   * Emit an event without ever letting a listener break the tick.
   * @param {string} name event name
   * @param {...*} args event arguments
   * @returns {void}
   */
  report(name, ...args) {
    if (this.disposed) return;
    try {
      this.emit(name, ...args);
    } catch (err) {
      warnOnce(`listener:${name}`, `a "${name}" listener threw`, err);
    }
  }

  /* ----------------------------------------------------------------- ritual */

  /**
   * Feed a block change in. Safe to call for every placement in the game: it
   * returns immediately unless the block is part of the ritual.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {number} blockId the block that is now there
   * @returns {?WitherBoss} the boss that was summoned, or `null`
   */
  onBlockPlaced(x, y, z, blockId) {
    if (this.disposed || !this.ritualEnabled) return null;
    const id = blockId | 0;
    if (!SKULL_BLOCKS.ids.has(id) && !SOUL_BLOCKS.ids.has(id)) return null;
    const site = this.checkSummon(x, y, z);
    if (site === null) return null;
    return this.summon(site.x, site.y, site.z, site.axis);
  }

  /**
   * Test whether the block at a position completes the ritual.
   *
   * At most 14 candidate anchors are examined and each costs seven block
   * reads, so this is bounded and cheap enough to run on every placement.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {?{x:number, y:number, z:number, axis:number}} the ritual base and
   *   its axis (`0` = along X, `1` = along Z), or `null`
   */
  checkSummon(x, y, z) {
    const world = this.world;
    if (world === null || typeof world.getBlock !== 'function') return null;
    let id;
    try {
      id = world.getBlock(x, y, z);
    } catch (err) {
      warnOnce('ritual:read', 'the ritual probe could not read a block', err);
      return null;
    }
    const isSkull = SKULL_BLOCKS.ids.has(id);
    const isSoul = SOUL_BLOCKS.ids.has(id);
    if (!isSkull && !isSoul) return null;

    const offsets = isSkull ? SKULL_OFFSETS : SOUL_OFFSETS;
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < offsets.length; i++) {
        const off = offsets[i];
        const ox = axis === 0 ? off[0] : off[2];
        const oz = axis === 0 ? off[2] : off[0];
        const bx = x - ox;
        const by = y - off[1];
        const bz = z - oz;
        if (this.matchStructure(bx, by, bz, axis)) return { x: bx, y: by, z: bz, axis };
      }
    }
    return null;
  }

  /**
   * Whether a complete ritual stands at a base position.
   * @param {number} bx base block X
   * @param {number} by base block Y
   * @param {number} bz base block Z
   * @param {number} axis `0` = the arms run along X, `1` = along Z
   * @returns {boolean} `true` when all seven blocks are right
   */
  matchStructure(bx, by, bz, axis) {
    const world = this.world;
    if (world === null || typeof world.getBlock !== 'function') return false;
    try {
      for (let i = 0; i < SOUL_OFFSETS.length; i++) {
        const off = SOUL_OFFSETS[i];
        const dx = axis === 0 ? off[0] : off[2];
        const dz = axis === 0 ? off[2] : off[0];
        if (!SOUL_BLOCKS.ids.has(world.getBlock(bx + dx, by + off[1], bz + dz))) return false;
      }
      for (let i = 0; i < SKULL_OFFSETS.length; i++) {
        const off = SKULL_OFFSETS[i];
        const dx = axis === 0 ? off[0] : off[2];
        const dz = axis === 0 ? off[2] : off[0];
        if (!SKULL_BLOCKS.ids.has(world.getBlock(bx + dx, by + off[1], bz + dz))) return false;
      }
    } catch (err) {
      warnOnce('ritual:match', 'the ritual match failed', err);
      return false;
    }
    return true;
  }

  /**
   * Consume a completed ritual and spawn the boss on it.
   * @param {number} bx base block X
   * @param {number} by base block Y
   * @param {number} bz base block Z
   * @param {number} axis `0` = arms along X, `1` = along Z
   * @returns {?WitherBoss} the boss, or `null` when it could not be spawned
   */
  summon(bx, by, bz, axis) {
    const world = this.world;
    const em = this.entities;
    if (world === null || em === null || typeof em.spawn !== 'function') {
      warnOnce('summon:wiring', 'the boss cannot be summoned without a world and entity manager');
      return null;
    }

    // Eat the ritual first: an interrupted spawn must not leave a structure
    // that instantly re-triggers on the next block update.
    try {
      for (let i = 0; i < SOUL_OFFSETS.length; i++) {
        const off = SOUL_OFFSETS[i];
        const dx = axis === 0 ? off[0] : off[2];
        const dz = axis === 0 ? off[2] : off[0];
        world.setBlock(bx + dx, by + off[1], bz + dz, 0);
      }
      for (let i = 0; i < SKULL_OFFSETS.length; i++) {
        const off = SKULL_OFFSETS[i];
        const dx = axis === 0 ? off[0] : off[2];
        const dz = axis === 0 ? off[2] : off[0];
        world.setBlock(bx + dx, by + off[1], bz + dz, 0);
      }
    } catch (err) {
      warnOnce('summon:clear', 'the ritual blocks could not be consumed', err);
    }

    const x = bx + 0.5;
    const y = by;
    const z = bz + 0.5;

    let boss;
    try {
      boss = new WitherBoss(x, y, z, { charging: true, arena: [x, y, z] });
    } catch (err) {
      warnOnce('summon:new', 'the boss could not be constructed', err);
      return null;
    }
    boss.bossManager = this;
    boss.world = world;

    let spawned = null;
    try {
      spawned = em.spawn(boss);
    } catch (err) {
      warnOnce('summon:spawn', 'the entity manager refused the boss', err);
      spawned = null;
    }
    if (spawned === null) return null;

    this.bossIds.push(boss.id);

    const ctx = this._context();
    emitParticles(ctx, 'portal', x, y + 2, z, { count: 60, speed: 4, life: 1.6, spread: 2 });
    emitSound(ctx, 'thunder', x, y, z, { volume: 1, pitch: 0.5 });
    emitShake(ctx, 0.5, 1.0, x, y, z);

    this.report('summonStructure', bx, by, bz, axis);
    this.report('summoned', boss);
    this.report('toast', BOSS_NAME, 'Etwas erwacht unter dir.', '☄', 'danger');
    return boss;
  }

  /* ------------------------------------------------------------------- tick */

  /**
   * Advance the encounter.
   *
   * Call this once per game tick **after** `entities.update()`, so the bosses
   * have already moved and the bar shows this tick's state.
   * @param {number} dt elapsed seconds (0.05 at 20 TPS)
   * @param {Object} [ctx] the shared tick context; its fields override the
   *   manager's own wiring for this tick
   * @returns {void}
   */
  update(dt, ctx) {
    if (this.disposed) return;
    // The bosses themselves are ticked by the entity manager, so `dt` is only
    // part of the signature for symmetry with every other manager.
    void dt;
    const context = this._context(ctx);

    this._resolveBosses();

    // Terrain destruction is shared work: one budget for every boss, so ten
    // craters cost the same as one.
    this._budget.start();
    let shattered = 0;
    for (let i = 0; i < this._bosses.length; i++) {
      const boss = this._bosses[i];
      if (boss.shatterQueue.length === 0) continue;
      try {
        shattered += boss.drainShatter(SHATTER_PER_TICK, this._budget);
      } catch (err) {
        warnOnce('shatter', 'the terrain shatter failed and was dropped', err);
        boss.shatterQueue.length = 0;
      }
      if (this._budget.expired()) break;
    }
    this.stats.shattered = shattered;
    this.stats.bosses = this._bosses.length;

    this._refreshBar(context);
  }

  /**
   * Rebuild the resolved boss list from the stored ids, dropping the dead.
   * @returns {void}
   * @private
   */
  _resolveBosses() {
    const em = this.entities;
    const list = this._bosses;
    list.length = 0;
    if (em === null || typeof em.get !== 'function') {
      // Without an entity manager the ids cannot be resolved; keep them for a
      // later rebind instead of throwing the fight away.
      return;
    }
    let write = 0;
    let lost = 0;
    for (let i = 0; i < this.bossIds.length; i++) {
      const id = this.bossIds[i];
      const e = em.get(id);
      if (!(e instanceof WitherBoss) || e.removed === true) {
        // Gone from the world: either defeated, or the save never restored it.
        lost++;
        continue;
      }
      if (e.bossManager === null) e.bossManager = this;
      this.bossIds[write++] = id;
      list.push(e);
    }
    if (lost > 0) {
      this.bossIds.length = write;
      for (let i = 0; i < lost; i++) this._noteCleared();
    }
  }

  /**
   * Record that a boss left the world.
   * @returns {void}
   * @private
   */
  _noteCleared() {
    this.kills++;
    this.report('cleared', null);
  }

  /**
   * Pick the boss the bar should describe and refresh it in place.
   * @param {Object} ctx the tick context
   * @returns {void}
   * @private
   */
  _refreshBar(ctx) {
    const bar = this.bossBar;
    const player = ctx.player;
    const known = player !== null && player !== undefined && player.position
      && player.position.length >= 3;
    let best = null;
    let bestD = Infinity;

    for (let i = 0; i < this._bosses.length; i++) {
      const boss = this._bosses[i];
      if (boss.dead === true) continue;
      let d = 0;
      if (known) {
        d = Math.sqrt(distSqTo(boss.position, player.position[0], player.position[1],
          player.position[2]));
        if (d > BOSS_BAR_RANGE) continue;
      }
      if (d < bestD) {
        bestD = d;
        best = boss;
      }
    }

    if (best === null) {
      bar.active = false;
      bar.id = 0;
      bar.adds = 0;
      bar.distance = -1;
      bar.progress = 0;
      bar.subtitle = '';
      return;
    }

    bar.active = true;
    bar.id = best.id;
    bar.name = BOSS_NAME;
    bar.phase = best.phase;
    bar.phaseLabel = phaseLabel(best.phase);
    bar.health = best.health;
    bar.maxHealth = best.maxHealth;
    bar.progress = best.healthFraction();
    bar.charging = best.charging;
    bar.chargeProgress = best.chargeProgress();
    bar.invulnerable = best.charging;
    bar.adds = best.livingAdds;
    bar.distance = known ? bestD : -1;
    bar.color = phaseColor(best.phase);
    if (best.dying === true) {
      bar.subtitle = 'Zerfällt …';
    } else if (best.charging) {
      const left = Math.max(0, Math.ceil(best.chargeTimer));
      bar.subtitle = `Erwacht … ${left} s`;
    } else if (best.livingAdds > 0) {
      bar.subtitle = `${bar.phaseLabel} · ${best.livingAdds} Diener`;
    } else {
      bar.subtitle = bar.phaseLabel;
    }
  }

  /**
   * Merge the caller's context with the manager's own wiring.
   * @param {Object} [ctx] the caller's tick context
   * @returns {Object} the shared context record (reused, never keep it)
   * @private
   */
  _context(ctx) {
    const c = this._ctx;
    c.boss = this;
    c.world = (ctx && ctx.world) || this.world;
    c.player = (ctx && ctx.player) || this.player;
    c.entities = (ctx && ctx.entities) || this.entities;
    c.effects = (ctx && ctx.effects) || this.effects;
    c.particles = (ctx && ctx.particles) || this.particles;
    c.audio = (ctx && ctx.audio) || this.audio;
    c.combat = (ctx && ctx.combat) || this.combat;
    c.environment = (ctx && ctx.environment) || null;
    c.difficulty = ctx && Number.isFinite(ctx.difficulty) ? ctx.difficulty : 2;
    return c;
  }

  /* ---------------------------------------------------------------- queries */

  /**
   * The boss the bar currently describes.
   * @returns {?WitherBoss} the boss, or `null`
   */
  getActiveBoss() {
    if (this.bossBar.id === 0) return null;
    for (let i = 0; i < this._bosses.length; i++) {
      if (this._bosses[i].id === this.bossBar.id) return this._bosses[i];
    }
    return null;
  }

  /**
   * Whether a fight is currently running.
   * @returns {boolean} `true` when at least one boss is alive
   */
  get fightActive() {
    return this._bosses.length > 0;
  }

  /**
   * Every living boss.
   * @returns {WitherBoss[]} the internal list — read only, do not mutate
   */
  get bosses() {
    return this._bosses;
  }

  /**
   * Spawn a boss directly, bypassing the ritual (commands, tests, structures).
   * @param {number} x world X
   * @param {number} y world Y (feet)
   * @param {number} z world Z
   * @param {{charging?:boolean}} [opts] `charging` defaults to `true`
   * @returns {?WitherBoss} the boss, or `null`
   */
  spawnBoss(x, y, z, opts = {}) {
    const em = this.entities;
    if (em === null || typeof em.spawn !== 'function') return null;
    let boss;
    try {
      boss = new WitherBoss(num(x, 0), num(y, 0), num(z, 0), {
        charging: opts.charging !== false,
        arena: [num(x, 0), num(y, 0), num(z, 0)],
      });
    } catch (err) {
      warnOnce('spawn:new', 'the boss could not be constructed', err);
      return null;
    }
    boss.bossManager = this;
    boss.world = this.world;
    let ok = null;
    try {
      ok = em.spawn(boss);
    } catch (err) {
      warnOnce('spawn:refused', 'the entity manager refused the boss', err);
      ok = null;
    }
    if (ok === null) return null;
    this.bossIds.push(boss.id);
    this.report('summoned', boss);
    return boss;
  }

  /* ----------------------------------------------------------- persistence */

  /**
   * Save the encounter.
   *
   * The boss and its skulls are ordinary entities and travel in the entity
   * manager's own save (both types are registered with
   * {@link registerEntityClass}); this record only carries what the *manager*
   * knows: which entity ids are bosses, and the tally.
   * @returns {Object} a plain, JSON-safe record
   */
  serialize() {
    return {
      version: BOSS_SAVE_VERSION,
      bossIds: this.bossIds.slice(),
      kills: this.kills,
    };
  }

  /**
   * Restore the encounter. The boss entities themselves are restored by the
   * entity manager; the ids are rebound on the next {@link BossManager#update}.
   * @param {?Object} o a record from {@link BossManager#serialize}
   * @returns {number} how many boss ids were restored
   */
  deserialize(o) {
    this.bossIds.length = 0;
    this._bosses.length = 0;
    this.kills = 0;
    if (!o || typeof o !== 'object') return 0;
    if (Number.isFinite(o.version) && (o.version | 0) > BOSS_SAVE_VERSION) {
      warnOnce('load:version', `boss save version ${o.version} is newer than ${BOSS_SAVE_VERSION}`);
    }
    this.kills = Math.max(0, num(o.kills, 0) | 0);
    if (Array.isArray(o.bossIds)) {
      for (let i = 0; i < o.bossIds.length; i++) {
        const id = num(o.bossIds[i], 0) | 0;
        if (id > 0 && this.bossIds.indexOf(id) < 0) this.bossIds.push(id);
      }
    }
    // A save written before the ids were tracked (or a hand-edited one) still
    // finds its boss: adopt every boss entity the manager can see.
    this.adoptExisting();
    return this.bossIds.length;
  }

  /**
   * Adopt every {@link WitherBoss} already living in the entity manager. Called
   * after a load, and safe to call at any time.
   * @returns {number} how many bosses were adopted
   */
  adoptExisting() {
    const em = this.entities;
    if (em === null || typeof em.forEach !== 'function') return 0;
    let found = 0;
    try {
      em.forEach((e) => {
        if (!(e instanceof WitherBoss) || e.removed === true) return;
        if (this.bossIds.indexOf(e.id) < 0) this.bossIds.push(e.id);
        e.bossManager = this;
        found++;
      });
    } catch (err) {
      warnOnce('adopt', 'the entity manager could not be scanned for bosses', err);
    }
    return found;
  }

  /**
   * Release every reference and stop watching the world.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this._watched !== null && typeof this._watched.off === 'function') {
      try {
        this._watched.off('blockChanged', this._onBlockChanged);
      } catch (err) {
        warnOnce('dispose', 'the world refused to release the boss listener', err);
      }
    }
    this._watched = null;
    this.bossIds.length = 0;
    this._bosses.length = 0;
    this.bossBar.active = false;
    this.bossBar.id = 0;
    this.world = null;
    this.entities = null;
    this.effects = null;
    this.particles = null;
    this.audio = null;
    this.combat = null;
    this.player = null;
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
    if (ACTIVE_MANAGER === this) ACTIVE_MANAGER = null;
  }
}

export default BossManager;
