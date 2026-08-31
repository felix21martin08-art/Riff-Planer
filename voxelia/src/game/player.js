/**
 * @file game/player.js — VOXELIA player controller + camera (spec 5.29).
 *
 * The player is the only entity with a camera, so this module owns both:
 *
 *  - **Simulation** (`update(dt, world)`) runs inside the fixed 20 TPS game
 *    tick: input latches, pose, acceleration-based movement with per-medium
 *    friction, jumping (coyote time + buffering), swimming, climbing, block
 *    effects (ice, slime, honey, soul sand, cobweb, powder snow), the swept
 *    collision solve from `game/physics.js`, fall damage, air supply and
 *    exhaustion.
 *  - **Presentation** (`pollInput(dt)` + `updateCamera(alpha)`) runs once per
 *    rendered frame: mouse look at full frame rate, view bobbing, strafe roll,
 *    the sprint FOV kick, first/third-person framing with a terrain-aware
 *    camera arm, and the interpolated matrices the renderer consumes as
 *    `FrameShape.camera` (spec 5.26).
 *
 * Nothing here is tied to the frame rate: every rate is expressed per second
 * and integrated with the `dt` it is handed. Hot paths reuse module- and
 * instance-level scratch buffers, and no method throws — bad input degrades to
 * "do not move" and is logged once.
 */

import {
  AABB, Frustum, clamp, damp, lerp, smoothstep, mat4, DEG2RAD,
} from '../core/math.js';
import { EventBus } from '../core/util.js';
import { B, BLOCK_COUNT, isLiquid } from '../world/blocks.js';
import { WORLD_MIN_Y } from '../world/chunk.js';
import { foodValue, armorPoints } from './items.js';
import {
  GRAVITY, TERMINAL_VELOCITY, STEP_HEIGHT, MEDIUM_DRAG,
  moveWithCollisions, createMoveResult, isInLiquid,
  applyGravity, applyBuoyancy, applyDrag,
} from './physics.js';

/* ------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* ------------------------------------------------------------------------- */

/** Walking speed in blocks/s. @type {number} */
export const WALK_SPEED = 4.317;
/** Sprinting speed in blocks/s. @type {number} */
export const SPRINT_SPEED = 5.612;
/** Sneaking speed in blocks/s. @type {number} */
export const SNEAK_SPEED = 1.295;
/** Swimming speed in blocks/s. @type {number} */
export const SWIM_SPEED = 2.2;
/** Sprint-swimming speed in blocks/s. @type {number} */
export const SWIM_SPRINT_SPEED = 3.4;
/** Creative flight speed in blocks/s. @type {number} */
export const FLY_SPEED = 10.9;
/** Creative flight speed while sprinting, in blocks/s. @type {number} */
export const FLY_SPRINT_SPEED = 21.8;
/** Vertical creative-flight speed in blocks/s. @type {number} */
export const FLY_VERTICAL_SPEED = 7.6;
/** Jump impulse in blocks/s (`0.42` blocks/tick at 20 TPS). @type {number} */
export const JUMP_IMPULSE = 8.4;
/** Extra horizontal impulse of a sprint jump, in blocks/s. @type {number} */
export const SPRINT_JUMP_BOOST = 2.4;
/** Upward swim speed while holding jump, in blocks/s. @type {number} */
export const SWIM_UP_SPEED = 3.2;
/** Downward swim speed while holding sneak, in blocks/s. @type {number} */
export const SWIM_DOWN_SPEED = 2.6;
/** Climbing speed on ladders and vines, in blocks/s. @type {number} */
export const CLIMB_SPEED = 2.35;
/** Maximum sliding speed while touching a ladder, in blocks/s. @type {number} */
export const CLIMB_SLIDE_SPEED = 3.0;
/** Grace period after leaving the ground during which a jump still works. @type {number} */
export const COYOTE_TIME = 0.1;
/** How long a jump press is remembered while airborne. @type {number} */
export const JUMP_BUFFER_TIME = 0.15;
/** Minimum time between two jumps, in seconds. @type {number} */
export const JUMP_COOLDOWN = 0.1;
/** Player box width (X and Z) in blocks. @type {number} */
export const PLAYER_WIDTH = 0.6;
/** Standing box height in blocks. @type {number} */
export const HEIGHT_STANDING = 1.8;
/** Sneaking box height in blocks. @type {number} */
export const HEIGHT_SNEAKING = 1.5;
/** Swimming (prone) box height in blocks. @type {number} */
export const HEIGHT_SWIMMING = 0.6;
/** Standing eye height in blocks. @type {number} */
export const EYE_STANDING = 1.62;
/** Sneaking eye height in blocks. @type {number} */
export const EYE_SNEAKING = 1.27;
/** Swimming eye height in blocks. @type {number} */
export const EYE_SWIMMING = 0.4;
/** Field-of-view bonus in degrees while sprinting. @type {number} */
export const FOV_SPRINT_BONUS = 8;
/** Time the sprint FOV kick takes to fully ease in or out, in seconds. @type {number} */
export const FOV_KICK_TIME = 0.12;
/** Distance of the third-person camera behind (or in front of) the eye. @type {number} */
export const THIRD_PERSON_DISTANCE = 4;
/** Maximum camera roll while strafing, in radians. @type {number} */
export const STRAFE_ROLL = 0.9 * DEG2RAD;
/** Maximum air supply in ticks (15 seconds at 20 TPS). @type {number} */
export const MAX_AIR = 300;
/** Fall height, in blocks, that is absorbed without damage. @type {number} */
export const FALL_SAFE_DISTANCE = 3;
/** Hunger level strictly required to keep sprinting. @type {number} */
export const SPRINT_MIN_HUNGER = 6;
/** Highest reachable pitch, in radians. @type {number} */
export const PITCH_LIMIT = 89.9 * DEG2RAD;
/** Degrees of rotation per mouse pixel at `mouseSensitivity === 1`. @type {number} */
export const LOOK_DEGREES_PER_PIXEL = 1.0;

/** Horizontal acceleration/friction rate on the ground, in 1/s. @type {number} */
const GROUND_RESPONSE = 14;
/** Horizontal acceleration rate in mid-air, in 1/s — deliberately tiny. @type {number} */
const AIR_RESPONSE = 1.7;
/** Horizontal acceleration rate in a fluid, in 1/s. @type {number} */
const WATER_RESPONSE = 5.5;
/** Horizontal acceleration rate while flying, in 1/s. @type {number} */
const FLY_RESPONSE = 8;
/** Horizontal acceleration rate while climbing, in 1/s. @type {number} */
const CLIMB_RESPONSE = 9;
/** How fast the eye height catches up with the pose, in 1/s. @type {number} */
const EYE_RESPONSE = 16;
/** Downward speed cap inside a cobweb, in blocks/s. @type {number} */
const COBWEB_FALL_SPEED = 0.9;
/** Horizontal speed multiplier inside a cobweb. @type {number} */
const COBWEB_SPEED = 0.22;
/** Horizontal speed multiplier inside powder-snow-like blocks. @type {number} */
const POWDER_SNOW_SPEED = 0.55;
/** Distance walked between two footstep events, in blocks. @type {number} */
const STEP_DISTANCE = 1.9;
/** Invulnerability window after taking damage, in seconds. @type {number} */
const HURT_IMMUNITY = 0.5;

/* ------------------------------------------------------------------------- */
/* Block effect tables (built once, indexed by block id)                      */
/* ------------------------------------------------------------------------- */

/**
 * Look up a block id by name without ever throwing on an unknown name.
 * @param {string} name snake_case block name.
 * @returns {number} Block id, or `-1` when the block does not exist.
 */
function blockId(name) {
  const v = B[name.toUpperCase()];
  return typeof v === 'number' && v > 0 && v < BLOCK_COUNT ? v : -1;
}

/**
 * Write a value into a per-block table, silently skipping unknown blocks.
 * @param {Float32Array|Uint8Array} table Table indexed by block id.
 * @param {string} name Block name.
 * @param {number} value Value to store.
 * @returns {void}
 */
function setBlockValue(table, name, value) {
  const id = blockId(name);
  if (id >= 0) table[id] = value;
}

/**
 * Multiplier on the horizontal acceleration/friction rate of the block an
 * entity stands on. `< 1` is slippery (ice), `> 1` is sticky (honey).
 * @type {Float32Array}
 */
const GROUND_SLIP = new Float32Array(BLOCK_COUNT).fill(1);
setBlockValue(GROUND_SLIP, 'ice', 0.11);
setBlockValue(GROUND_SLIP, 'packed_ice', 0.09);
setBlockValue(GROUND_SLIP, 'blue_ice', 0.06);
setBlockValue(GROUND_SLIP, 'slime_block', 0.55);
setBlockValue(GROUND_SLIP, 'honey_block', 1.8);

/**
 * Multiplier on the target walking speed for the block an entity stands on.
 * @type {Float32Array}
 */
const GROUND_SPEED = new Float32Array(BLOCK_COUNT).fill(1);
setBlockValue(GROUND_SPEED, 'soul_sand', 0.4);
setBlockValue(GROUND_SPEED, 'soul_soil', 0.45);
setBlockValue(GROUND_SPEED, 'honey_block', 0.45);
setBlockValue(GROUND_SPEED, 'mud', 0.75);

/**
 * Restitution of the block an entity lands on: `0.8` on slime, `0` elsewhere.
 * @type {Float32Array}
 */
const GROUND_BOUNCE = new Float32Array(BLOCK_COUNT);
setBlockValue(GROUND_BOUNCE, 'slime_block', 0.8);

/**
 * Fall-damage multiplier of the block an entity lands on.
 * @type {Float32Array}
 */
const GROUND_FALL_MUL = new Float32Array(BLOCK_COUNT).fill(1);
setBlockValue(GROUND_FALL_MUL, 'slime_block', 0);
setBlockValue(GROUND_FALL_MUL, 'hay_block', 0.2);
setBlockValue(GROUND_FALL_MUL, 'honey_block', 0.2);

/**
 * `1` for blocks that forbid jumping (honey).
 * @type {Uint8Array}
 */
const GROUND_NO_JUMP = new Uint8Array(BLOCK_COUNT);
setBlockValue(GROUND_NO_JUMP, 'honey_block', 1);

/**
 * Climbable blocks: `1` = always climbable (ladder, scaffolding),
 * `2` = climbable while pressing into it (vine).
 * @type {Uint8Array}
 */
const CLIMBABLE = new Uint8Array(BLOCK_COUNT);
setBlockValue(CLIMBABLE, 'ladder', 1);
setBlockValue(CLIMBABLE, 'scaffolding', 1);
setBlockValue(CLIMBABLE, 'vine', 2);

/**
 * Blocks that slow an entity down while it is *inside* them.
 * `1` = cobweb, `2` = powder-snow-like.
 * @type {Uint8Array}
 */
const INSIDE_EFFECT = new Uint8Array(BLOCK_COUNT);
setBlockValue(INSIDE_EFFECT, 'cobweb', 1);
setBlockValue(INSIDE_EFFECT, 'snow_layer', 2);
setBlockValue(INSIDE_EFFECT, 'snow_block', 2);
setBlockValue(INSIDE_EFFECT, 'powder_snow', 2);

/** `1` for blocks whose ground effect should win over a plain block. @type {Uint8Array} */
const GROUND_SPECIAL = new Uint8Array(BLOCK_COUNT);
for (let i = 0; i < BLOCK_COUNT; i++) {
  if (GROUND_SLIP[i] !== 1 || GROUND_SPEED[i] !== 1 || GROUND_BOUNCE[i] !== 0 ||
      GROUND_FALL_MUL[i] !== 1 || GROUND_NO_JUMP[i] !== 0) {
    GROUND_SPECIAL[i] = 1;
  }
}

/** Valid game modes. @type {ReadonlyArray<string>} */
export const GAME_MODES = Object.freeze(['survival', 'creative', 'spectator']);

/** Camera perspectives: first person, third person behind, third person front. */
export const PERSPECTIVE = Object.freeze({ FIRST: 0, THIRD_BACK: 1, THIRD_FRONT: 2 });

/** Damage sources this controller raises on its own. @type {Readonly<Object<string,string>>} */
export const PLAYER_DAMAGE = Object.freeze({ FALL: 'fall', DROWN: 'drown', VOID: 'void' });

/** Sources that ignore armour. @type {ReadonlySet<string>} */
const ARMOR_BYPASS = new Set(['drown', 'starve', 'void', 'magic', 'wither']);

/** Third-person camera arm sample offsets (unit box corners, scaled at use). */
const CAMERA_PROBES = Object.freeze([
  Object.freeze([0, 0, 0]),
  Object.freeze([1, 1, 0]),
  Object.freeze([-1, 1, 0]),
  Object.freeze([1, -1, 0]),
  Object.freeze([-1, -1, 0]),
]);

/* ------------------------------------------------------------------------- */
/* Player                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * The local player: state, movement, vitals and camera.
 *
 * Emitted events: `'jump'`, `'land'` (fallDistance), `'step'` (blockId, x, y, z),
 * `'damage'` (amount, source), `'death'` (source), `'respawn'`, `'eat'` (itemId,
 * food), `'gamemode'` (mode), `'perspective'` (index), `'fly'` (flying),
 * `'slot'` (index), `'splash'` (enteringWater), `'levelup'` (level).
 */
export class Player extends EventBus {
  /**
   * @param {Object} world Chunk manager (`world/world.js`), may be swapped later.
   * @param {Object} settings Settings instance (`core/settings.js`).
   * @param {Object} input Input instance (`core/input.js`).
   */
  constructor(world, settings, input) {
    super();

    /** @type {Object} Current world. */
    this.world = world || null;
    /** @type {Object} Settings instance. */
    this.settings = settings || null;
    /** @type {Object} Input instance. */
    this.input = input || null;

    /* ---- transform ------------------------------------------------------ */
    /** @type {Float32Array} Feet position `[x, y, z]` (y = bottom of the box). */
    this.position = new Float32Array([0, 80, 0]);
    /** @type {Float32Array} Feet position at the start of the current tick. */
    this.prevPosition = new Float32Array([0, 80, 0]);
    /** @type {Float32Array} Velocity in blocks/s. */
    this.velocity = new Float32Array(3);
    /** @type {number} Yaw in radians; `0` looks north (`-Z`), growing clockwise. */
    this.yaw = 0;
    /** @type {number} Pitch in radians; positive looks up. */
    this.pitch = 0;
    /** @type {AABB} Collision box, always in sync with {@link Player#position}. */
    this.aabb = new AABB();
    /** @type {number} Current box height in blocks. */
    this.height = HEIGHT_STANDING;
    /** @type {number} Current interpolated eye height in blocks. */
    this.eyeHeight = EYE_STANDING;
    /** @type {number} Eye height at the start of the current tick. */
    this.prevEyeHeight = EYE_STANDING;

    /* ---- movement state ------------------------------------------------- */
    /** @type {boolean} Standing on solid ground. */
    this.onGround = false;
    /** @type {boolean} Sprinting. */
    this.sprinting = false;
    /** @type {boolean} Sneaking (crouched pose + ledge protection). */
    this.sneaking = false;
    /** @type {boolean} Creative flight active. */
    this.flying = false;
    /** @type {boolean} Prone swim pose. */
    this.swimming = false;
    /** @type {boolean} Attached to a ladder, vine or scaffolding. */
    this.climbing = false;
    /** @type {boolean} Any part of the box is inside water. */
    this.inWater = false;
    /** @type {boolean} Any part of the box is inside lava. */
    this.inLava = false;
    /** @type {number} Submerged volume fraction `0..1`. */
    this.submerged = 0;
    /** @type {number} Blocks fallen since the highest point of the current fall. */
    this.fallDistance = 0;
    /** @type {number} Total distance walked, drives view bobbing and footsteps. */
    this.walkedDistance = 0;

    /* ---- gameplay state -------------------------------------------------- */
    /** @type {'survival'|'creative'|'spectator'} Active game mode. */
    this.gameMode = 'survival';
    /** @type {number} Health in half-hearts, `0..20`. */
    this.health = 20;
    /** @type {number} Maximum health. */
    this.maxHealth = 20;
    /** @type {number} Hunger, `0..20`. */
    this.hunger = 20;
    /** @type {number} Saturation, `0..20`; consumed before hunger. */
    this.saturation = 5;
    /** @type {number} Exhaustion accumulator; every 4 points cost one food point. */
    this.exhaustion = 0;
    /** @type {number} Air supply in ticks, `0..MAX_AIR`. */
    this.air = MAX_AIR;
    /** @type {number} Total experience points. */
    this.xp = 0;
    /** @type {number} Experience level. */
    this.xpLevel = 0;
    /** @type {number} Progress towards the next level, `0..1`. */
    this.xpProgress = 0;
    /** @type {number} Armour points, `0..20`. */
    this.armor = 0;
    /** @type {number} Selected hotbar slot, `0..8`. */
    this.selectedSlot = 0;
    /** @type {?Object} Inventory instance, assigned by the game. */
    this.inventory = null;
    /** @type {boolean} True once health reached zero. */
    this.dead = false;
    /** @type {number} Remaining hurt flash time in seconds. */
    this.hurtTime = 0;
    /** @type {boolean} True while the arm swing animation plays. */
    this.swinging = false;
    /** @type {number} Arm swing progress `0..1`, `-1` when idle. */
    this.swingProgress = -1;
    /** @type {Float32Array} Respawn point. */
    this.spawnPoint = new Float32Array([0, 80, 0]);

    /* ---- camera ---------------------------------------------------------- */
    /** @type {number} `0` first person, `1` third person behind, `2` third person front. */
    this.perspective = PERSPECTIVE.FIRST;
    /**
     * Camera state shaped exactly like `FrameShape.camera` (spec 5.26).
     * @type {{position:Float32Array, forward:Float32Array, up:Float32Array,
     *   right:Float32Array, yaw:number, pitch:number, fov:number, near:number,
     *   far:number, aspect:number, view:Float32Array, proj:Float32Array,
     *   viewProj:Float32Array, prevViewProj:Float32Array, frustum:Frustum,
     *   underwater:boolean}}
     */
    this.camera = {
      position: new Float32Array(3),
      forward: new Float32Array([0, 0, -1]),
      up: new Float32Array([0, 1, 0]),
      right: new Float32Array([1, 0, 0]),
      yaw: 0,
      pitch: 0,
      fov: 75,
      near: 0.05,
      far: 512,
      aspect: 16 / 9,
      view: mat4.create(),
      proj: mat4.create(),
      viewProj: mat4.create(),
      prevViewProj: mat4.create(),
      frustum: new Frustum(),
      underwater: false,
    };

    /* ---- integration switches -------------------------------------------- */
    /** @type {boolean} Apply fall damage here (turn off if CombatSystem owns it). */
    this.applyOwnFallDamage = true;
    /** @type {boolean} Drain air and apply drowning damage here. */
    this.applyOwnAirDamage = true;
    /** @type {boolean} React to hotbar keys and the mouse wheel. */
    this.handleHotbarInput = true;

    /* ---- private ---------------------------------------------------------- */
    /** @type {{jump:boolean, jumpDouble:boolean, perspective:number,
     *   sprint:boolean, forwardDouble:boolean}} Per-frame input latches. */
    this._latch = { jump: false, jumpDouble: false, perspective: 0, sprint: false, forwardDouble: false };
    /** @type {boolean} Whether {@link Player#pollInput} already ran this frame. */
    this._polled = false;
    /** @type {number} Timestamp of the previous {@link Player#pollInput}, in ms. */
    this._lastPollMs = -1;
    /** @type {number} Duration of the last rendered frame, in seconds. */
    this._frameDt = 1 / 60;
    /** @type {number} Remaining coyote time in seconds. */
    this._coyote = 0;
    /** @type {number} Remaining jump buffer in seconds. */
    this._jumpBuffer = 0;
    /** @type {number} Remaining jump cooldown in seconds. */
    this._jumpCooldown = 0;
    /** @type {number} Highest Y reached since leaving the ground. */
    this._highestY = 0;
    /** @type {boolean} Ground state of the previous tick. */
    this._wasOnGround = false;
    /** @type {boolean} Water state of the previous tick (splash detection). */
    this._wasInWater = false;
    /** @type {number} Distance walked since the last footstep event. */
    this._stepAccum = 0;
    /** @type {number} Remaining damage immunity in seconds. */
    this._immunity = 0;
    /** @type {number} Amount of the damage that started the current immunity. */
    this._lastDamage = 0;
    /** @type {number} Seconds spent with an empty air bar. */
    this._drownTimer = 0;
    /** @type {number} Sprint FOV kick progress `0..1`. */
    this._fovKick = 0;
    /** @type {number} Smoothed view-bobbing amplitude `0..1`. */
    this._bobAmount = 0;
    /** @type {number} Smoothed camera roll in radians. */
    this._roll = 0;
    /** @type {number} Third-person camera distance, smoothed. */
    this._camDistance = THIRD_PERSON_DISTANCE;
    /** @type {boolean} Whether `camera.prevViewProj` holds a real previous frame. */
    this._hasPrevVP = false;
    /** @type {boolean} A warning was already logged for a missing world. */
    this._warnedWorld = false;

    /** @type {{water:boolean, lava:boolean, submerged:number}} Liquid probe result. */
    this._liquid = { water: false, lava: false, submerged: 0 };
    /** @type {Object} Result record reused by the physics solver. */
    this._moveResult = createMoveResult();
    /** @type {Object} Options record reused by the physics solver. */
    this._moveOpts = {
      stepHeight: STEP_HEIGHT, autoStep: true, sneaking: false, onGround: false, noClip: false,
    };
    /**
     * Environment scan of the current tick.
     * @type {{groundBlock:number, climb:number, cobweb:boolean, powderSnow:boolean,
     *   slip:number, speed:number, bounce:number, fallMul:number, noJump:boolean}}
     */
    this._env = {
      groundBlock: 0, climb: 0, cobweb: false, powderSnow: false,
      slip: 1, speed: 1, bounce: 0, fallMul: 1, noJump: false,
    };

    /** @type {AABB} Scratch box for pose resizing. @private */
    this._poseBox = new AABB();
    /** @type {Array<ArrayLike<number>>} Scratch collision list. @private */
    this._poseOut = [];
    /** @type {Float32Array} Scratch eye position. @private */
    this._eyeScratch = new Float32Array(3);
    /** @type {Float32Array} Scratch look direction. @private */
    this._lookScratch = new Float32Array(3);
    /** @type {Float32Array} Scratch camera ray origin. @private */
    this._rayOrigin = new Float32Array(3);
    /** @type {Float32Array} Scratch camera ray direction. @private */
    this._rayDir = new Float32Array(3);
    /** @type {Float32Array} Scratch look-at target. @private */
    this._lookTarget = new Float32Array(3);

    this._syncAABB();
    this.prevPosition.set(this.position);
    this._highestY = this.position[1];
  }

  /* ===================================================================== */
  /* Settings & viewport                                                    */
  /* ===================================================================== */

  /**
   * Read a setting, falling back when the key or the settings object is absent.
   * @param {string} key Setting key from `core/settings.js` DEFAULTS.
   * @param {*} fallback Value used when the setting is unavailable.
   * @returns {*} The setting value or `fallback`.
   */
  _setting(key, fallback) {
    const s = this.settings;
    if (!s || typeof s.get !== 'function') return fallback;
    if (typeof s.has === 'function' && !s.has(key)) return fallback;
    const v = s.get(key);
    return v === undefined || v === null ? fallback : v;
  }

  /**
   * Tell the camera about the drawing-buffer size so the projection aspect is
   * correct. Call this from the renderer's resize handler.
   * @param {number} width Viewport width in pixels.
   * @param {number} height Viewport height in pixels.
   * @returns {void}
   */
  setViewport(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      this.camera.aspect = w / h;
    }
  }

  /* ===================================================================== */
  /* Per-frame input                                                        */
  /* ===================================================================== */

  /**
   * Frame-rate work: mouse look and edge-triggered input latching.
   *
   * Call this **once per rendered frame**, before the fixed-step ticks. It is
   * separate from {@link Player#update} because edge-triggered input
   * (`wasActionPressed`, `wasDoublePressed`) is defined per frame, while ticks
   * may run zero, one or several times per frame. {@link Player#updateCamera}
   * calls it automatically when the game forgot to.
   *
   * @param {number} [dt=-1] Frame duration in seconds; measured internally when
   *   negative or omitted.
   * @returns {void}
   */
  pollInput(dt = -1) {
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    let frameDt = dt;
    if (!(frameDt >= 0)) {
      frameDt = this._lastPollMs < 0 ? 1 / 60 : (now - this._lastPollMs) / 1000;
    }
    this._lastPollMs = now;
    this._frameDt = clamp(Number.isFinite(frameDt) ? frameDt : 1 / 60, 0, 0.25);
    this._polled = true;

    const input = this.input;
    if (!input) return;

    /* ---- look ------------------------------------------------------------ */
    if (typeof input.consumeLookDelta === 'function') {
      const look = input.consumeLookDelta();
      const dx = Number.isFinite(look[0]) ? look[0] : 0;
      const dy = Number.isFinite(look[1]) ? look[1] : 0;
      if (dx !== 0 || dy !== 0) {
        const sens = Math.max(0.01, Number(this._setting('mouseSensitivity', 0.15)) || 0.15);
        const scale = sens * LOOK_DEGREES_PER_PIXEL * DEG2RAD;
        const invert = this._setting('invertY', false) ? -1 : 1;
        this.yaw += dx * scale;
        this.pitch -= dy * scale * invert;
        if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
        else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
        this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
      }
    }

    /* ---- edge-triggered latches ------------------------------------------ */
    const latch = this._latch;
    if (typeof input.wasActionPressed === 'function') {
      if (input.wasActionPressed('jump')) latch.jump = true;
      if (input.wasActionPressed('sprint')) latch.sprint = true;
      if (input.wasActionPressed('perspective')) latch.perspective++;
    }
    if (typeof input.wasDoublePressed === 'function') {
      if (input.wasDoublePressed('jump', 300)) latch.jumpDouble = true;
      if (input.wasDoublePressed('forward', 300)) latch.forwardDouble = true;
    }

    /* ---- hotbar ---------------------------------------------------------- */
    if (this.handleHotbarInput) this._pollHotbar(input);
  }

  /**
   * Hotbar selection from the number keys and the mouse wheel.
   * @param {Object} input Input instance.
   * @returns {void}
   */
  _pollHotbar(input) {
    if (typeof input.wasActionPressed === 'function') {
      for (let i = 0; i < 9; i++) {
        if (input.wasActionPressed(`hotbar${i + 1}`)) {
          this.setSelectedSlot(i);
          return;
        }
      }
    }
    if (typeof input.getWheelSteps === 'function') {
      const steps = input.getWheelSteps() | 0;
      if (steps !== 0) this.setSelectedSlot(((this.selectedSlot + steps) % 9 + 9) % 9);
    }
  }

  /**
   * Select a hotbar slot, emitting `'slot'` when it actually changes.
   * @param {number} index Slot index; wrapped into `0..8`.
   * @returns {void}
   */
  setSelectedSlot(index) {
    const i = ((Math.trunc(Number(index)) || 0) % 9 + 9) % 9;
    if (i === this.selectedSlot) return;
    this.selectedSlot = i;
    if (this.inventory && typeof this.inventory.selected === 'number') {
      this.inventory.selected = i;
    }
    this.emit('slot', i);
  }

  /* ===================================================================== */
  /* Fixed-step simulation                                                  */
  /* ===================================================================== */

  /**
   * Advance the player by one fixed game tick.
   * @param {number} dt Tick duration in seconds (`0.05` at 20 TPS).
   * @param {Object} [world] World to use; defaults to the constructor's.
   * @returns {void}
   */
  update(dt, world) {
    if (world) this.world = world;
    const w = this.world;
    const t = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);

    this.prevPosition[0] = this.position[0];
    this.prevPosition[1] = this.position[1];
    this.prevPosition[2] = this.position[2];
    this.prevEyeHeight = this.eyeHeight;

    if (t <= 0) return;

    this._tickTimers(t);

    if (!w || typeof w.getCollisionAABBs !== 'function') {
      if (!this._warnedWorld) {
        this._warnedWorld = true;
        console.warn('[VOXELIA] player: no usable world, physics disabled');
      }
      this._consumeLatches();
      return;
    }

    const input = this.input;
    const jumpHeld = !!input && typeof input.isActionDown === 'function' && input.isActionDown('jump');
    const sneakHeld = !!input && typeof input.isActionDown === 'function' && input.isActionDown('sneak');
    const sprintHeld = !!input && typeof input.isActionDown === 'function' && input.isActionDown('sprint');

    let moveX = 0;
    let moveZ = 0;
    if (input && typeof input.getMoveAxis === 'function') {
      const axis = input.getMoveAxis();
      moveX = Number.isFinite(axis[0]) ? axis[0] : 0;
      moveZ = Number.isFinite(axis[1]) ? axis[1] : 0;
    }
    if (this.dead || this.gameMode === 'spectator' && false) {
      moveX = 0;
      moveZ = 0;
    }
    if (this.dead) {
      moveX = 0;
      moveZ = 0;
    }
    const moveMag = Math.hypot(moveX, moveZ);

    /* ---- flight toggle (double tap jump) --------------------------------- */
    if (this._latch.jumpDouble && this._canFly()) {
      this.flying = !this.flying;
      if (this.flying) {
        this.velocity[1] = 0;
        this.onGround = false;
        this._highestY = this.position[1];
      }
      this._jumpBuffer = 0;
      this.emit('fly', this.flying);
    }
    if (this.gameMode === 'spectator') this.flying = true;
    if (!this._canFly()) this.flying = false;

    /* ---- perspective cycling --------------------------------------------- */
    if (this._latch.perspective > 0) {
      this.perspective = (this.perspective + this._latch.perspective) % 3;
      this.emit('perspective', this.perspective);
    }

    if (this._latch.jump) this._jumpBuffer = JUMP_BUFFER_TIME;

    /* ---- environment & pose ---------------------------------------------- */
    this._scanLiquid(w);
    this._scanEnvironment(w, moveMag);
    this._updateSprint(sprintHeld, moveZ, moveMag);
    this._updatePose(w, sneakHeld, moveMag);

    /* ---- movement --------------------------------------------------------- */
    const wishX = moveZ * Math.sin(this.yaw) + moveX * Math.cos(this.yaw);
    const wishZ = moveZ * -Math.cos(this.yaw) + moveX * Math.sin(this.yaw);

    if (this.flying) {
      this._moveFlying(t, wishX, wishZ, jumpHeld, sneakHeld);
    } else if (this.climbing) {
      this._moveClimbing(t, wishX, wishZ, moveZ, jumpHeld, sneakHeld);
    } else if (this.submerged > 0.05) {
      this._moveSwimming(t, wishX, wishZ, jumpHeld, sneakHeld);
    } else {
      this._moveGrounded(t, wishX, wishZ, jumpHeld, moveMag);
    }

    /* ---- collide ---------------------------------------------------------- */
    const opts = this._moveOpts;
    opts.sneaking = this.sneaking;
    opts.onGround = this.onGround;
    opts.noClip = this.gameMode === 'spectator';
    opts.autoStep = !this.flying && !this.swimming && this.gameMode !== 'spectator';
    opts.stepHeight = opts.autoStep ? STEP_HEIGHT : 0;

    const before = this.position[1];
    const res = moveWithCollisions(w, this.aabb, this.velocity, t, this._moveResult, opts);
    this._syncPositionFromBox();
    this.onGround = res.onGround || (this.flying && res.hitY && this.velocity[1] <= 0);

    /* ---- post move --------------------------------------------------------- */
    this._postMove(t, res, before);
    this._updateVitals(t, moveMag);
    this._consumeLatches();
  }

  /**
   * Tick down the short-lived timers.
   * @param {number} dt Tick duration in seconds.
   * @returns {void}
   */
  _tickTimers(dt) {
    if (this._jumpBuffer > 0) this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    if (this._jumpCooldown > 0) this._jumpCooldown = Math.max(0, this._jumpCooldown - dt);
    if (this._immunity > 0) this._immunity = Math.max(0, this._immunity - dt);
    if (this.hurtTime > 0) this.hurtTime = Math.max(0, this.hurtTime - dt);
    if (this.swinging) {
      this.swingProgress = this.swingProgress < 0 ? 0 : this.swingProgress + dt * 3.4;
      if (this.swingProgress >= 1) {
        this.swingProgress = -1;
        this.swinging = false;
      }
    }
  }

  /**
   * Clear the per-frame input latches after a tick consumed them.
   * @returns {void}
   */
  _consumeLatches() {
    const l = this._latch;
    l.jump = false;
    l.jumpDouble = false;
    l.perspective = 0;
    l.sprint = false;
    l.forwardDouble = false;
  }

  /**
   * Whether the current game mode allows creative flight.
   * @returns {boolean} True in creative and spectator mode.
   */
  _canFly() {
    return this.gameMode === 'creative' || this.gameMode === 'spectator';
  }

  /* ===================================================================== */
  /* Environment                                                            */
  /* ===================================================================== */

  /**
   * Refresh the fluid state of the whole body box.
   * @param {Object} world World instance.
   * @returns {void}
   */
  _scanLiquid(world) {
    isInLiquid(world, this.aabb, this._liquid);
    this.inWater = this._liquid.water;
    this.inLava = this._liquid.lava;
    this.submerged = this._liquid.submerged;
  }

  /**
   * Scan the blocks the player touches and the block underneath, filling
   * {@link Player#_env} with the resulting movement modifiers.
   * @param {Object} world World instance.
   * @param {number} moveMag Magnitude of the movement input, `0..1`.
   * @returns {void}
   */
  _scanEnvironment(world, moveMag) {
    const env = this._env;
    env.groundBlock = 0;
    env.climb = 0;
    env.cobweb = false;
    env.powderSnow = false;
    env.slip = 1;
    env.speed = 1;
    env.bounce = 0;
    env.fallMul = 1;
    env.noJump = false;

    const a = this.aabb;
    const x0 = Math.floor(a.minX + 1e-4);
    const x1 = Math.floor(a.maxX - 1e-4);
    const z0 = Math.floor(a.minZ + 1e-4);
    const z1 = Math.floor(a.maxZ - 1e-4);
    const y0 = Math.floor(a.minY + 1e-4);
    const y1 = Math.floor(a.maxY - 1e-4);

    /* ---- blocks the body is inside --------------------------------------- */
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = world.getBlock(x, y, z);
          if (id === 0) continue;
          const climb = CLIMBABLE[id];
          if (climb > env.climb) env.climb = climb;
          const inside = INSIDE_EFFECT[id];
          if (inside === 1) env.cobweb = true;
          else if (inside === 2) env.powderSnow = true;
        }
      }
    }

    /* ---- the block underneath the feet ------------------------------------ */
    const gy = Math.floor(a.minY - 0.08);
    let ground = 0;
    for (let z = z0; z <= z1 && ground === 0; z++) {
      for (let x = x0; x <= x1; x++) {
        const id = world.getBlock(x, gy, z);
        if (id === 0) continue;
        if (GROUND_SPECIAL[id]) {
          ground = id;
          break;
        }
        if (ground === 0) ground = id;
      }
    }
    env.groundBlock = ground;
    if (ground > 0) {
      env.slip = GROUND_SLIP[ground];
      env.speed = GROUND_SPEED[ground];
      env.bounce = GROUND_BOUNCE[ground];
      env.fallMul = GROUND_FALL_MUL[ground];
      env.noJump = GROUND_NO_JUMP[ground] === 1;
    }

    /* ---- climbing --------------------------------------------------------- */
    this.climbing = !this.flying && env.climb > 0 &&
      (env.climb === 1 || moveMag > 0.1) &&
      this.gameMode !== 'spectator';
  }

  /**
   * Update the sprint state machine.
   * @param {boolean} sprintHeld Sprint action currently down.
   * @param {number} forwardAxis Forward input, `-1..1`.
   * @param {number} moveMag Magnitude of the movement input.
   * @returns {void}
   */
  _updateSprint(sprintHeld, forwardAxis, moveMag) {
    const hungerOk = this.gameMode !== 'survival' || this.hunger > SPRINT_MIN_HUNGER;
    if (this.sprinting) {
      if (forwardAxis <= 0.1 || moveMag < 0.1 || !hungerOk || this.dead ||
          (this.sneaking && !this.flying && !this.swimming)) {
        this.sprinting = false;
      }
    } else if ((sprintHeld || this._latch.sprint || this._latch.forwardDouble) &&
               forwardAxis > 0.5 && hungerOk && !this.dead &&
               !(this.sneaking && !this.flying)) {
      this.sprinting = true;
    }
  }

  /**
   * Choose the pose (standing / sneaking / swimming) and resize the box, only
   * growing back when there is room.
   * @param {Object} world World instance.
   * @param {boolean} sneakHeld Sneak action currently down.
   * @param {number} moveMag Magnitude of the movement input.
   * @returns {void}
   */
  _updatePose(world, sneakHeld, moveMag) {
    const spectator = this.gameMode === 'spectator';
    this.swimming = !this.flying && !spectator && this.submerged > 0.6 &&
      !this.onGround && (this.sprinting || moveMag > 0.1);
    this.sneaking = sneakHeld && !this.flying && !this.swimming && !spectator && !this.dead;

    const targetHeight = this.swimming ? HEIGHT_SWIMMING
      : (this.sneaking ? HEIGHT_SNEAKING : HEIGHT_STANDING);
    this._resize(world, targetHeight);

    const targetEye = this.swimming ? EYE_SWIMMING
      : (this.height <= HEIGHT_SNEAKING + 1e-4 ? EYE_SNEAKING : EYE_STANDING);
    this.eyeHeight = damp(this.eyeHeight, targetEye, EYE_RESPONSE, 0.05);
    if (Math.abs(this.eyeHeight - targetEye) < 1e-3) this.eyeHeight = targetEye;
  }

  /**
   * Resize the collision box, refusing to grow into solid blocks.
   * @param {Object} world World instance.
   * @param {number} height Desired box height in blocks.
   * @returns {boolean} True when the box actually changed size.
   */
  _resize(world, height) {
    if (Math.abs(height - this.height) < 1e-6) return false;
    if (height < this.height || this.gameMode === 'spectator' || !world) {
      this.height = height;
      this.aabb.maxY = this.aabb.minY + height;
      return true;
    }
    const a = this.aabb;
    const e = 1e-3;
    this._poseBox.set(a.minX + e, a.minY + this.height, a.minZ + e,
      a.maxX - e, a.minY + height, a.maxZ - e);
    if (world.getCollisionAABBs(this._poseBox, this._poseOut).length > 0) return false;
    this.height = height;
    a.maxY = a.minY + height;
    return true;
  }

  /* ===================================================================== */
  /* Movement modes                                                         */
  /* ===================================================================== */

  /**
   * Creative / spectator flight: full 3D control, no gravity.
   * @param {number} dt Tick duration in seconds.
   * @param {number} wishX World-space movement direction X (unit-ish).
   * @param {number} wishZ World-space movement direction Z.
   * @param {boolean} jumpHeld Ascend.
   * @param {boolean} sneakHeld Descend.
   * @returns {void}
   */
  _moveFlying(dt, wishX, wishZ, jumpHeld, sneakHeld) {
    const speed = this.sprinting ? FLY_SPRINT_SPEED : FLY_SPEED;
    const v = this.velocity;
    v[0] = damp(v[0], wishX * speed, FLY_RESPONSE, dt);
    v[2] = damp(v[2], wishZ * speed, FLY_RESPONSE, dt);
    const vertical = (jumpHeld ? 1 : 0) - (sneakHeld ? 1 : 0);
    const vSpeed = FLY_VERTICAL_SPEED * (this.sprinting ? 2 : 1);
    v[1] = damp(v[1], vertical * vSpeed, FLY_RESPONSE, dt);
    this._highestY = this.position[1];
    this.fallDistance = 0;
    this._jumpBuffer = 0;
  }

  /**
   * Ladder / vine / scaffolding climbing.
   * @param {number} dt Tick duration in seconds.
   * @param {number} wishX World-space movement direction X.
   * @param {number} wishZ World-space movement direction Z.
   * @param {number} forwardAxis Forward input, `-1..1`.
   * @param {boolean} jumpHeld Climb up.
   * @param {boolean} sneakHeld Hold position.
   * @returns {void}
   */
  _moveClimbing(dt, wishX, wishZ, forwardAxis, jumpHeld, sneakHeld) {
    const v = this.velocity;
    const speed = WALK_SPEED * 0.55;
    v[0] = damp(v[0], wishX * speed, CLIMB_RESPONSE, dt);
    v[2] = damp(v[2], wishZ * speed, CLIMB_RESPONSE, dt);

    if (sneakHeld) v[1] = 0;
    else if (jumpHeld || this._jumpBuffer > 0) v[1] = CLIMB_SPEED;
    else if (forwardAxis > 0.1) v[1] = CLIMB_SPEED * 0.85;
    else if (v[1] < -CLIMB_SLIDE_SPEED) v[1] = -CLIMB_SLIDE_SPEED;
    else applyGravity(v, dt, GRAVITY * 0.35, CLIMB_SLIDE_SPEED);

    this._jumpBuffer = 0;
    this._highestY = this.position[1];
    this.fallDistance = 0;
  }

  /**
   * Swimming: buoyancy, per-medium drag, sprint-swim and vertical control.
   * @param {number} dt Tick duration in seconds.
   * @param {number} wishX World-space movement direction X.
   * @param {number} wishZ World-space movement direction Z.
   * @param {boolean} jumpHeld Swim up / jump out of the water.
   * @param {boolean} sneakHeld Dive.
   * @returns {void}
   */
  _moveSwimming(dt, wishX, wishZ, jumpHeld, sneakHeld) {
    const v = this.velocity;
    const deep = this.submerged;
    const lava = this.inLava && !this.inWater;

    let speed = this.sprinting && deep > 0.4 ? SWIM_SPRINT_SPEED : SWIM_SPEED;
    if (lava) speed *= 0.4;
    speed *= this._env.cobweb ? COBWEB_SPEED : 1;

    // Shallow water still allows normal walking, so blend the two targets.
    const walkBlend = clamp((deep - 0.15) / 0.45, 0, 1);
    const walkSpeed = this._targetGroundSpeed();
    const target = lerp(walkSpeed, speed, walkBlend);
    const response = lerp(this.onGround ? GROUND_RESPONSE : AIR_RESPONSE, WATER_RESPONSE, walkBlend);

    v[0] = damp(v[0], wishX * target, response, dt);
    v[2] = damp(v[2], wishZ * target, response, dt);

    applyGravity(v, dt, GRAVITY * lerp(1, 0.35, walkBlend), TERMINAL_VELOCITY);
    applyBuoyancy(v, dt, deep, lava);
    applyDrag(v, dt, 0, (lava ? MEDIUM_DRAG.lava.y : MEDIUM_DRAG.water.y) * deep);

    if (jumpHeld) {
      const up = SWIM_UP_SPEED * (lava ? 0.5 : 1);
      if (deep > 0.5) {
        if (v[1] < up) v[1] = up;
      } else if (this.onGround) {
        this._tryJump(true);
      } else if (v[1] < up * 0.8) {
        v[1] = up * 0.8;
      }
    } else if (sneakHeld && deep > 0.5) {
      if (v[1] > -SWIM_DOWN_SPEED) v[1] = Math.max(v[1] - SWIM_DOWN_SPEED * dt * 6, -SWIM_DOWN_SPEED);
    }

    this._highestY = this.position[1];
    this.fallDistance = 0;
    this._jumpBuffer = 0;
  }

  /**
   * Walking, sprinting, sneaking, falling — the default medium.
   * @param {number} dt Tick duration in seconds.
   * @param {number} wishX World-space movement direction X.
   * @param {number} wishZ World-space movement direction Z.
   * @param {boolean} jumpHeld Jump action currently down.
   * @param {number} moveMag Magnitude of the movement input.
   * @returns {void}
   */
  _moveGrounded(dt, wishX, wishZ, jumpHeld, moveMag) {
    const v = this.velocity;
    const env = this._env;
    const target = this._targetGroundSpeed();
    const response = (this.onGround ? GROUND_RESPONSE * env.slip : AIR_RESPONSE) *
      (env.cobweb ? 2.5 : 1);

    v[0] = damp(v[0], wishX * target, response, dt);
    v[2] = damp(v[2], wishZ * target, response, dt);

    if (env.cobweb) {
      applyDrag(v, dt, MEDIUM_DRAG.cobweb.xz, MEDIUM_DRAG.cobweb.y);
      applyGravity(v, dt, GRAVITY * 0.12, COBWEB_FALL_SPEED);
      if (v[1] < -COBWEB_FALL_SPEED) v[1] = -COBWEB_FALL_SPEED;
    } else {
      applyGravity(v, dt, GRAVITY, TERMINAL_VELOCITY);
      if (!this.onGround) applyDrag(v, dt, 0, MEDIUM_DRAG.air.y * 0.25);
    }

    if (jumpHeld || this._jumpBuffer > 0) this._tryJump(false);
    if (moveMag < 0.05 && this.onGround && Math.abs(v[0]) < 0.02 && Math.abs(v[2]) < 0.02) {
      v[0] = 0;
      v[2] = 0;
    }
  }

  /**
   * Target horizontal speed on land, including pose and block modifiers.
   * @returns {number} Speed in blocks/s.
   */
  _targetGroundSpeed() {
    let speed = WALK_SPEED;
    if (this.sneaking) speed = SNEAK_SPEED;
    else if (this.sprinting) speed = SPRINT_SPEED;
    speed *= this._env.speed;
    if (this._env.cobweb) speed *= COBWEB_SPEED;
    if (this._env.powderSnow) speed *= POWDER_SNOW_SPEED;
    if (!this.onGround) speed *= 1.0;
    return speed;
  }

  /**
   * Perform a jump when the buffered request is still valid.
   * @param {boolean} fromWater True when jumping out of shallow water.
   * @returns {boolean} True when a jump was actually performed.
   */
  _tryJump(fromWater) {
    if (this._jumpCooldown > 0 || this.dead) return false;
    if (this._env.noJump && !fromWater) return false;
    if (!this.onGround && this._coyote <= 0 && !fromWater) return false;

    const v = this.velocity;
    v[1] = JUMP_IMPULSE;
    if (this.sprinting) {
      const sy = Math.sin(this.yaw);
      const cy = Math.cos(this.yaw);
      v[0] += sy * SPRINT_JUMP_BOOST;
      v[2] += -cy * SPRINT_JUMP_BOOST;
    }
    this.onGround = false;
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._jumpCooldown = JUMP_COOLDOWN;
    this._highestY = this.position[1];
    this.addExhaustion(this.sprinting ? 0.2 : 0.05);
    this.emit('jump');
    return true;
  }

  /* ===================================================================== */
  /* Post-move bookkeeping                                                  */
  /* ===================================================================== */

  /**
   * Fall tracking, landings, bounces, footsteps and splashes.
   * @param {number} dt Tick duration in seconds.
   * @param {Object} res Result record from the physics solver.
   * @param {number} beforeY Feet Y before the move.
   * @returns {void}
   */
  _postMove(dt, res, beforeY) {
    const y = this.position[1];

    if (this.onGround) {
      if (!this._wasOnGround) this._land(res);
      this._highestY = y;
      this._coyote = COYOTE_TIME;
      this.fallDistance = 0;
    } else {
      if (y > this._highestY) this._highestY = y;
      if (this.inWater || this.climbing || this.flying || this.gameMode === 'spectator') {
        this._highestY = y;
        this.fallDistance = 0;
      } else {
        this.fallDistance = Math.max(0, this._highestY - y);
      }
      if (this._coyote > 0) this._coyote = Math.max(0, this._coyote - dt);
    }
    this._wasOnGround = this.onGround;

    if (this.flying && this.onGround && this.velocity[1] <= 0 && this.gameMode !== 'spectator') {
      this.flying = false;
      this.emit('fly', false);
    }

    /* ---- footsteps -------------------------------------------------------- */
    const dx = this.position[0] - this.prevPosition[0];
    const dz = this.position[2] - this.prevPosition[2];
    const walked = Math.hypot(dx, dz);
    this.walkedDistance += walked;
    if (this.onGround && !this.sneaking && walked > 1e-4) {
      this._stepAccum += walked;
      const threshold = STEP_DISTANCE * (this.sprinting ? 0.75 : 1);
      if (this._stepAccum >= threshold) {
        this._stepAccum = 0;
        const id = this._env.groundBlock;
        if (id > 0) {
          this.emit('step', id, this.position[0], this.position[1], this.position[2]);
        }
      }
    } else if (!this.onGround) {
      this._stepAccum = STEP_DISTANCE * 0.5;
    }

    /* ---- splash ----------------------------------------------------------- */
    if (this.inWater !== this._wasInWater) {
      if (Math.abs(this.velocity[1]) > 1.5 || Math.abs(beforeY - this.position[1]) > 0.05) {
        this.emit('splash', this.inWater);
      }
      this._wasInWater = this.inWater;
    }

    /* ---- exhaustion -------------------------------------------------------- */
    if (this.gameMode === 'survival' && walked > 0) {
      if (this.sprinting) this.addExhaustion(0.1 * walked);
      else if (this.submerged > 0.4) this.addExhaustion(0.01 * walked);
      else if (this.onGround) this.addExhaustion(0.01 * walked);
    }

    /* ---- the void ---------------------------------------------------------- */
    if (this.position[1] < WORLD_MIN_Y - 32 && this.gameMode === 'survival') {
      this.damage(4 * dt * 2, PLAYER_DAMAGE.VOID);
    }
  }

  /**
   * Resolve a landing: bounce, fall damage and the `'land'` event.
   * @param {Object} res Result record from the physics solver.
   * @returns {void}
   */
  _land(res) {
    const fall = Math.max(0, this._highestY - this.position[1]);
    this.fallDistance = fall;
    const ground = this._env.groundBlock;
    const impact = res.impactY;

    if (fall > 0.15) this.emit('land', fall, ground);

    /* ---- slime bounce ----------------------------------------------------- */
    const bounce = ground > 0 ? GROUND_BOUNCE[ground] : 0;
    if (bounce > 0 && !this.sneaking && impact < -1) {
      const up = -impact * bounce;
      if (up > 0.6) {
        this.velocity[1] = up;
        this.onGround = false;
        this._highestY = this.position[1];
        this._coyote = 0;
      }
    }

    /* ---- fall damage ------------------------------------------------------- */
    if (!this.applyOwnFallDamage || this.gameMode !== 'survival' || this.flying) {
      this._highestY = this.position[1];
      return;
    }
    if (this.inWater) {
      this._highestY = this.position[1];
      return;
    }
    const mul = ground > 0 ? GROUND_FALL_MUL[ground] : 1;
    const damage = Math.floor(Math.max(0, fall - FALL_SAFE_DISTANCE) * mul);
    if (damage > 0) this.damage(damage, PLAYER_DAMAGE.FALL);
    this._highestY = this.position[1];
  }

  /**
   * Air supply, drowning and the hunger/saturation bookkeeping that belongs to
   * the controller itself.
   * @param {number} dt Tick duration in seconds.
   * @param {number} moveMag Magnitude of the movement input.
   * @returns {void}
   */
  _updateVitals(dt, moveMag) {
    if (!this.applyOwnAirDamage) return;
    const survival = this.gameMode === 'survival';
    const eyeSubmerged = this._isEyeInFluid();

    if (eyeSubmerged === 1 && survival && !this.dead) {
      this.air -= dt * 20;
      if (this.air <= 0) {
        this.air = 0;
        this._drownTimer += dt;
        if (this._drownTimer >= 1) {
          this._drownTimer -= 1;
          this.damage(2, PLAYER_DAMAGE.DROWN);
        }
      }
    } else {
      this._drownTimer = 0;
      if (this.air < MAX_AIR) this.air = Math.min(MAX_AIR, this.air + dt * 80);
    }
    if (moveMag > 0 && this.dead) this.velocity[0] = 0;
  }

  /**
   * Which fluid, if any, the eye is inside.
   * @returns {number} `0` = none, `1` = water, `2` = lava.
   */
  _isEyeInFluid() {
    const w = this.world;
    if (!w || typeof w.getBlock !== 'function') return 0;
    const x = Math.floor(this.position[0]);
    const y = Math.floor(this.position[1] + this.eyeHeight);
    const z = Math.floor(this.position[2]);
    const id = w.getBlock(x, y, z);
    if (id === 0 || !isLiquid(id)) return 0;
    return id === B.LAVA ? 2 : 1;
  }

  /* ===================================================================== */
  /* Transform helpers                                                      */
  /* ===================================================================== */

  /**
   * Rebuild {@link Player#aabb} from {@link Player#position} and the pose height.
   * @returns {void}
   */
  _syncAABB() {
    this.aabb.setFromEntity(this.position[0], this.position[1], this.position[2],
      PLAYER_WIDTH, this.height);
  }

  /**
   * Read {@link Player#position} back out of the (already moved) box.
   * @returns {void}
   */
  _syncPositionFromBox() {
    const a = this.aabb;
    this.position[0] = (a.minX + a.maxX) * 0.5;
    this.position[1] = a.minY;
    this.position[2] = (a.minZ + a.maxZ) * 0.5;
  }

  /**
   * Current eye position in world space.
   * @param {Float32Array|number[]} [out] Receiver; an internal scratch vector is
   *   used (and overwritten on the next call) when omitted.
   * @returns {Float32Array|number[]} `[x, y, z]` of the eye.
   */
  getEyePosition(out = this._eyeScratch) {
    out[0] = this.position[0];
    out[1] = this.position[1] + this.eyeHeight;
    out[2] = this.position[2];
    return out;
  }

  /**
   * Current unit look direction.
   * @param {Float32Array|number[]} [out] Receiver; an internal scratch vector is
   *   used (and overwritten on the next call) when omitted.
   * @returns {Float32Array|number[]} `[x, y, z]`, normalized.
   */
  getLookDirection(out = this._lookScratch) {
    const cp = Math.cos(this.pitch);
    out[0] = Math.sin(this.yaw) * cp;
    out[1] = Math.sin(this.pitch);
    out[2] = -Math.cos(this.yaw) * cp;
    return out;
  }

  /**
   * The stack in the selected hotbar slot, if an inventory is attached.
   * @returns {?Object} The held `ItemStack`, or `null`.
   */
  getHeldItem() {
    const inv = this.inventory;
    if (!inv) return null;
    try {
      if (typeof inv.getSelected === 'function') return inv.getSelected();
      if (typeof inv.get === 'function') return inv.get(this.selectedSlot);
      if (Array.isArray(inv.slots)) return inv.slots[this.selectedSlot] || null;
    } catch (e) {
      return null;
    }
    return null;
  }

  /* ===================================================================== */
  /* Camera                                                                 */
  /* ===================================================================== */

  /**
   * Build the render camera for this frame.
   *
   * Interpolates the tick state with `alpha`, applies view bobbing, strafe roll
   * and the sprint FOV kick, resolves the third-person arm against the terrain,
   * and fills every field of `FrameShape.camera` (spec 5.26) including
   * `prevViewProj` (for TAA / motion blur) and `underwater`.
   *
   * @param {number} alpha Interpolation factor `0..1` between the previous and
   *   the current tick.
   * @returns {Object} {@link Player#camera}, ready to hand to the renderer.
   */
  updateCamera(alpha) {
    if (!this._polled) this.pollInput();
    this._polled = false;

    const cam = this.camera;
    const dt = this._frameDt;
    const a = clamp(Number.isFinite(alpha) ? alpha : 1, 0, 1);

    /* ---- interpolated eye -------------------------------------------------- */
    let ex = lerp(this.prevPosition[0], this.position[0], a);
    let ey = lerp(this.prevPosition[1], this.position[1], a) +
      lerp(this.prevEyeHeight, this.eyeHeight, a);
    let ez = lerp(this.prevPosition[2], this.position[2], a);

    /* ---- bobbing & roll ---------------------------------------------------- */
    const speed = Math.hypot(this.velocity[0], this.velocity[2]);
    const bobbingOn = this._setting('viewBobbing', true) === true;
    const wantBob = bobbingOn && this.onGround && !this.flying && this.perspective === 0;
    const bobTarget = wantBob ? clamp(speed / WALK_SPEED, 0, 1.4) : 0;
    this._bobAmount = damp(this._bobAmount, bobTarget, 9, dt);

    let strafe = 0;
    if (this.input && typeof this.input.getMoveAxis === 'function') {
      const axis = this.input.getMoveAxis();
      strafe = Number.isFinite(axis[0]) ? axis[0] : 0;
    }
    this._roll = damp(this._roll, -strafe * STRAFE_ROLL, 8, dt);

    const bobPhase = this.walkedDistance * 2.2;
    let roll = this._roll;
    if (this._bobAmount > 1e-3) {
      const amp = this._bobAmount * 0.062;
      const sway = Math.sin(bobPhase) * amp;
      const heave = -Math.abs(Math.cos(bobPhase)) * amp * 0.75;
      const cy = Math.cos(this.yaw);
      const sy = Math.sin(this.yaw);
      // Sway sideways along the camera's right axis, heave straight up.
      ex += cy * sway;
      ez += sy * sway;
      ey += heave;
      roll += Math.sin(bobPhase) * this._bobAmount * 0.012;
    }

    /* ---- fov kick ----------------------------------------------------------- */
    const wantKick = this.sprinting && (speed > 0.4 || this.flying);
    const rate = dt / Math.max(1e-4, FOV_KICK_TIME);
    this._fovKick = clamp(this._fovKick + (wantKick ? rate : -rate), 0, 1);
    const baseFov = clamp(Number(this._setting('fov', 75)) || 75, 20, 140);
    const bonus = (this.flying ? FOV_SPRINT_BONUS * 1.5 : FOV_SPRINT_BONUS) *
      smoothstep(0, 1, this._fovKick);
    cam.fov = clamp(baseFov + bonus, 20, 150);

    /* ---- basis --------------------------------------------------------------- */
    const cp = Math.cos(this.pitch);
    let fx = Math.sin(this.yaw) * cp;
    let fy = Math.sin(this.pitch);
    let fz = -Math.cos(this.yaw) * cp;

    let px = ex;
    let py = ey;
    let pz = ez;

    if (this.perspective !== PERSPECTIVE.FIRST) {
      const back = this.perspective === PERSPECTIVE.THIRD_BACK;
      const dirX = back ? -fx : fx;
      const dirY = back ? -fy : fy;
      const dirZ = back ? -fz : fz;
      const dist = this._resolveCameraArm(ex, ey, ez, dirX, dirY, dirZ);
      this._camDistance = damp(this._camDistance, dist, 20, dt);
      const d = Math.min(this._camDistance, dist);
      px = ex + dirX * d;
      py = ey + dirY * d;
      pz = ez + dirZ * d;
      if (!back) {
        fx = -fx;
        fy = -fy;
        fz = -fz;
      }
    } else {
      this._camDistance = THIRD_PERSON_DISTANCE;
    }

    // Orthonormal basis with roll applied around the view axis.
    let rx = -fz;
    let ry = 0;
    let rz = fx;
    let rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-6) {
      rx = 1; ry = 0; rz = 0; rl = 1;
    }
    rx /= rl; ry /= rl; rz /= rl;
    let ux = ry * fz - rz * fy;
    let uy = rz * fx - rx * fz;
    let uz = rx * fy - ry * fx;
    if (roll !== 0) {
      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      const nrx = rx * cr + ux * sr;
      const nry = ry * cr + uy * sr;
      const nrz = rz * cr + uz * sr;
      ux = ux * cr - rx * sr;
      uy = uy * cr - ry * sr;
      uz = uz * cr - rz * sr;
      rx = nrx; ry = nry; rz = nrz;
    }

    cam.position[0] = px;
    cam.position[1] = py;
    cam.position[2] = pz;
    cam.forward[0] = fx;
    cam.forward[1] = fy;
    cam.forward[2] = fz;
    cam.right[0] = rx;
    cam.right[1] = ry;
    cam.right[2] = rz;
    cam.up[0] = ux;
    cam.up[1] = uy;
    cam.up[2] = uz;
    cam.yaw = this.yaw;
    cam.pitch = this.pitch;

    /* ---- matrices ------------------------------------------------------------ */
    mat4.copy(cam.prevViewProj, cam.viewProj);

    const view = cam.view;
    view[0] = rx; view[4] = ry; view[8] = rz; view[12] = -(rx * px + ry * py + rz * pz);
    view[1] = ux; view[5] = uy; view[9] = uz; view[13] = -(ux * px + uy * py + uz * pz);
    view[2] = -fx; view[6] = -fy; view[10] = -fz; view[14] = fx * px + fy * py + fz * pz;
    view[3] = 0; view[7] = 0; view[11] = 0; view[15] = 1;

    const renderDistance = Math.max(2, Number(this._setting('renderDistance', 10)) || 10);
    cam.near = 0.05;
    cam.far = clamp(renderDistance * 16 * 1.6 + 64, 192, 4096);
    if (!(cam.aspect > 0)) cam.aspect = 16 / 9;
    mat4.perspective(cam.proj, cam.fov * DEG2RAD, cam.aspect, cam.near, cam.far);
    mat4.multiply(cam.viewProj, cam.proj, view);
    if (!this._hasPrevVP) {
      mat4.copy(cam.prevViewProj, cam.viewProj);
      this._hasPrevVP = true;
    }
    cam.frustum.fromViewProj(cam.viewProj);

    /* ---- underwater ---------------------------------------------------------- */
    cam.underwater = false;
    const w = this.world;
    if (w && typeof w.getBlock === 'function') {
      const id = w.getBlock(Math.floor(px), Math.floor(py), Math.floor(pz));
      cam.underwater = id !== 0 && isLiquid(id);
    }
    return cam;
  }

  /**
   * Distance the third-person camera may travel backwards before it would clip
   * into terrain. Five rays (centre plus four offsets) keep the near plane out
   * of walls without a full box sweep.
   * @param {number} ex Eye X.
   * @param {number} ey Eye Y.
   * @param {number} ez Eye Z.
   * @param {number} dx Direction X (unit).
   * @param {number} dy Direction Y (unit).
   * @param {number} dz Direction Z (unit).
   * @returns {number} Allowed distance in blocks.
   */
  _resolveCameraArm(ex, ey, ez, dx, dy, dz) {
    const w = this.world;
    let best = THIRD_PERSON_DISTANCE;
    if (!w || typeof w.raycast !== 'function') return best;

    // Build a basis perpendicular to the view direction for the probe offsets.
    let rx = -dz;
    let rz = dx;
    const rl = Math.hypot(rx, rz);
    if (rl > 1e-6) {
      rx /= rl;
      rz /= rl;
    } else {
      rx = 1;
      rz = 0;
    }
    const ux = rz * dy - 0 * dz;
    const uy = 0 * dx - rx * dz;
    const uz = rx * 0 - rz * dx;
    const spread = 0.12;

    const origin = this._rayOrigin;
    const dir = this._rayDir;
    dir[0] = dx;
    dir[1] = dy;
    dir[2] = dz;

    for (let i = 0; i < CAMERA_PROBES.length; i++) {
      const p = CAMERA_PROBES[i];
      origin[0] = ex + (rx * p[0] + ux * p[1]) * spread;
      origin[1] = ey + (uy * p[1]) * spread;
      origin[2] = ez + (rz * p[0] + uz * p[1]) * spread;
      let hit = null;
      try {
        hit = w.raycast(origin, dir, THIRD_PERSON_DISTANCE, { fluids: false });
      } catch (e) {
        hit = null;
      }
      if (hit && Number.isFinite(hit.dist)) {
        const d = hit.dist - 0.25;
        if (d < best) best = d;
      }
    }
    return clamp(best, 0.35, THIRD_PERSON_DISTANCE);
  }

  /* ===================================================================== */
  /* Vitals & gameplay API                                                  */
  /* ===================================================================== */

  /**
   * Apply damage, honouring game mode, the invulnerability window and armour.
   * @param {number} amount Damage in half-hearts.
   * @param {string} [source='generic'] Damage source id (see `game/combat.js`).
   * @returns {number} The damage actually applied.
   */
  damage(amount, source = 'generic') {
    const raw = Number(amount);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    if (this.dead || this.gameMode === 'creative' || this.gameMode === 'spectator') return 0;
    if (this._immunity > 0 && raw <= this._lastDamage) return 0;

    let applied = raw;
    if (!ARMOR_BYPASS.has(source)) {
      const points = clamp(this.armor, 0, 20);
      applied = raw * (1 - points * 0.04);
    }
    applied = Math.max(0, applied);

    this.health = clamp(this.health - applied, 0, this.maxHealth);
    this._immunity = HURT_IMMUNITY;
    this._lastDamage = raw;
    this.hurtTime = HURT_IMMUNITY;
    this.emit('damage', applied, source);

    if (this.health <= 0 && !this.dead) {
      this.dead = true;
      this.sprinting = false;
      this.flying = false;
      this.emit('death', source);
    }
    return applied;
  }

  /**
   * Restore health.
   * @param {number} amount Half-hearts to restore.
   * @returns {number} The amount actually restored.
   */
  heal(amount) {
    const v = Number(amount);
    if (!Number.isFinite(v) || v <= 0 || this.dead) return 0;
    const before = this.health;
    this.health = clamp(this.health + v, 0, this.maxHealth);
    return this.health - before;
  }

  /**
   * Add exhaustion, converting full points into saturation and then hunger.
   * `game/combat.js` should call this instead of duplicating the conversion.
   * @param {number} v Exhaustion points.
   * @returns {void}
   */
  addExhaustion(v) {
    const amount = Number(v);
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (this.gameMode !== 'survival') return;
    this.exhaustion += amount;
    let guard = 0;
    while (this.exhaustion >= 4 && guard++ < 64) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
  }

  /**
   * Eat or drink an item.
   * @param {number|{itemId:number}} item Item id or an `ItemStack`.
   * @returns {boolean} True when the item was consumed.
   */
  eat(item) {
    const id = typeof item === 'number' ? item
      : (item && Number.isFinite(item.itemId) ? item.itemId : -1);
    if (id < 0) return false;
    let food = null;
    try {
      food = foodValue(id);
    } catch (e) {
      food = null;
    }
    if (!food) return false;
    if (this.hunger >= 20 && food.alwaysEdible !== true) return false;

    this.hunger = clamp(this.hunger + food.hunger, 0, 20);
    this.saturation = clamp(this.saturation + food.saturation, 0, this.hunger);
    this.exhaustion = Math.max(0, this.exhaustion - 0.3);
    this.emit('eat', id, food);
    return true;
  }

  /**
   * Add experience and recompute the level.
   * @param {number} points Experience points to add (may be negative).
   * @returns {number} The new level.
   */
  addXP(points) {
    const v = Number(points);
    if (!Number.isFinite(v)) return this.xpLevel;
    const before = this.xpLevel;
    this.xp = Math.max(0, this.xp + v);
    this._recalculateXP();
    if (this.xpLevel > before) this.emit('levelup', this.xpLevel);
    return this.xpLevel;
  }

  /**
   * Derive {@link Player#xpLevel} and {@link Player#xpProgress} from
   * {@link Player#xp}, using the classic 7/…/9/…/11 curve.
   * @returns {void}
   */
  _recalculateXP() {
    let level = 0;
    let remaining = this.xp;
    let guard = 0;
    let need = 7;
    while (remaining >= need && guard++ < 4096) {
      remaining -= need;
      level++;
      if (level < 16) need = 7 + level * 2;
      else if (level < 31) need = 37 + (level - 15) * 5;
      else need = 112 + (level - 30) * 9;
    }
    this.xpLevel = level;
    this.xpProgress = need > 0 ? clamp(remaining / need, 0, 1) : 0;
  }

  /**
   * Recompute {@link Player#armor} from the attached inventory, if it exposes
   * an `armor` array of stacks.
   * @returns {number} The new armour point total.
   */
  recalculateArmor() {
    const inv = this.inventory;
    let total = 0;
    try {
      const slots = inv && (inv.armor || inv.armorSlots);
      if (slots && typeof slots.length === 'number') {
        for (let i = 0; i < slots.length; i++) {
          const stack = slots[i];
          if (!stack || !Number.isFinite(stack.itemId)) continue;
          total += armorPoints(stack.itemId) || 0;
        }
      }
    } catch (e) {
      total = this.armor;
    }
    this.armor = clamp(total, 0, 20);
    return this.armor;
  }

  /**
   * Respawn at the spawn point with full vitals.
   * @returns {void}
   */
  respawn() {
    this.health = this.maxHealth;
    this.hunger = 20;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = MAX_AIR;
    this.dead = false;
    this.hurtTime = 0;
    this._immunity = 0;
    this._lastDamage = 0;
    this._drownTimer = 0;
    this.fallDistance = 0;
    this.sprinting = false;
    this.sneaking = false;
    this.swimming = false;
    this.climbing = false;
    this.flying = this.gameMode === 'spectator';
    this.velocity[0] = 0;
    this.velocity[1] = 0;
    this.velocity[2] = 0;
    this.height = HEIGHT_STANDING;
    this.eyeHeight = EYE_STANDING;
    this.prevEyeHeight = EYE_STANDING;
    this.teleport(this.spawnPoint[0], this.spawnPoint[1], this.spawnPoint[2]);
    this.emit('respawn');
  }

  /**
   * Switch the game mode.
   * @param {'survival'|'creative'|'spectator'} m New mode; ignored when unknown.
   * @returns {boolean} True when the mode changed.
   */
  setGameMode(m) {
    if (GAME_MODES.indexOf(m) < 0) {
      console.warn(`[VOXELIA] player: unknown game mode "${m}"`);
      return false;
    }
    if (m === this.gameMode) return false;
    this.gameMode = m;
    if (m === 'spectator') {
      this.flying = true;
      this.dead = false;
      this.health = this.maxHealth;
    } else if (m === 'survival') {
      this.flying = false;
    }
    this._highestY = this.position[1];
    this.fallDistance = 0;
    this.emit('gamemode', m);
    return true;
  }

  /**
   * Move the player instantly, clearing velocity and fall tracking so no
   * interpolation smear or fall damage results.
   * @param {number} x Feet X.
   * @param {number} y Feet Y.
   * @param {number} z Feet Z.
   * @returns {void}
   */
  teleport(x, y, z) {
    const nx = Number(x);
    const ny = Number(y);
    const nz = Number(z);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
      console.warn('[VOXELIA] player: teleport with non-finite coordinates ignored');
      return;
    }
    this.position[0] = nx;
    this.position[1] = ny;
    this.position[2] = nz;
    this.prevPosition[0] = nx;
    this.prevPosition[1] = ny;
    this.prevPosition[2] = nz;
    this.velocity[0] = 0;
    this.velocity[1] = 0;
    this.velocity[2] = 0;
    this._syncAABB();
    this._highestY = ny;
    this.fallDistance = 0;
    this._coyote = 0;
    this._jumpBuffer = 0;
    this.onGround = false;
    this._wasOnGround = false;
  }

  /**
   * Set the respawn point.
   * @param {number} x Spawn X.
   * @param {number} y Spawn Y.
   * @param {number} z Spawn Z.
   * @returns {void}
   */
  setSpawnPoint(x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    this.spawnPoint[0] = x;
    this.spawnPoint[1] = y;
    this.spawnPoint[2] = z;
  }

  /**
   * Start the arm-swing animation (called by `game/interaction.js`).
   * @returns {void}
   */
  swing() {
    this.swinging = true;
    if (this.swingProgress < 0) this.swingProgress = 0;
  }

  /* ===================================================================== */
  /* Persistence                                                            */
  /* ===================================================================== */

  /**
   * Snapshot every value the save system needs.
   * @returns {Object} A plain, JSON/structured-clone-safe object.
   */
  serialize() {
    let inventory = null;
    try {
      if (this.inventory && typeof this.inventory.serialize === 'function') {
        inventory = this.inventory.serialize();
      }
    } catch (e) {
      inventory = null;
    }
    return {
      version: 1,
      position: [this.position[0], this.position[1], this.position[2]],
      velocity: [this.velocity[0], this.velocity[1], this.velocity[2]],
      spawnPoint: [this.spawnPoint[0], this.spawnPoint[1], this.spawnPoint[2]],
      yaw: this.yaw,
      pitch: this.pitch,
      gameMode: this.gameMode,
      health: this.health,
      hunger: this.hunger,
      saturation: this.saturation,
      exhaustion: this.exhaustion,
      air: this.air,
      xp: this.xp,
      xpLevel: this.xpLevel,
      armor: this.armor,
      selectedSlot: this.selectedSlot,
      flying: this.flying,
      onGround: this.onGround,
      perspective: this.perspective,
      walkedDistance: this.walkedDistance,
      dead: this.dead,
      inventory,
    };
  }

  /**
   * Restore a snapshot produced by {@link Player#serialize}. Unknown or invalid
   * fields keep their current value.
   * @param {Object} obj Saved state.
   * @returns {boolean} True when something was restored.
   */
  deserialize(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
    const arr = obj.position;
    if (arr && arr.length >= 3) {
      this.teleport(num(arr[0], this.position[0]), num(arr[1], this.position[1]),
        num(arr[2], this.position[2]));
    }
    if (obj.velocity && obj.velocity.length >= 3) {
      this.velocity[0] = num(obj.velocity[0], 0);
      this.velocity[1] = num(obj.velocity[1], 0);
      this.velocity[2] = num(obj.velocity[2], 0);
    }
    if (obj.spawnPoint && obj.spawnPoint.length >= 3) {
      this.setSpawnPoint(num(obj.spawnPoint[0], 0), num(obj.spawnPoint[1], 80),
        num(obj.spawnPoint[2], 0));
    }
    this.yaw = num(obj.yaw, this.yaw);
    this.pitch = clamp(num(obj.pitch, this.pitch), -PITCH_LIMIT, PITCH_LIMIT);
    if (GAME_MODES.indexOf(obj.gameMode) >= 0) this.gameMode = obj.gameMode;
    this.health = clamp(num(obj.health, this.health), 0, this.maxHealth);
    this.hunger = clamp(num(obj.hunger, this.hunger), 0, 20);
    this.saturation = clamp(num(obj.saturation, this.saturation), 0, 20);
    this.exhaustion = Math.max(0, num(obj.exhaustion, 0));
    this.air = clamp(num(obj.air, MAX_AIR), 0, MAX_AIR);
    this.xp = Math.max(0, num(obj.xp, 0));
    this.armor = clamp(num(obj.armor, 0), 0, 20);
    this.selectedSlot = ((Math.trunc(num(obj.selectedSlot, 0)) % 9) + 9) % 9;
    this.flying = obj.flying === true && this._canFly();
    this.onGround = obj.onGround === true;
    this.perspective = clamp(Math.trunc(num(obj.perspective, 0)), 0, 2);
    this.walkedDistance = Math.max(0, num(obj.walkedDistance, 0));
    this.dead = obj.dead === true && this.health <= 0;
    this._recalculateXP();
    if (Number.isFinite(Number(obj.xpLevel)) && this.xp === 0) {
      this.xpLevel = Math.max(0, Math.trunc(Number(obj.xpLevel)));
    }

    try {
      if (obj.inventory && this.inventory && typeof this.inventory.deserialize === 'function') {
        this.inventory.deserialize(obj.inventory);
      }
    } catch (e) {
      console.warn('[VOXELIA] player: inventory could not be restored');
    }

    this.height = HEIGHT_STANDING;
    this.eyeHeight = EYE_STANDING;
    this.prevEyeHeight = EYE_STANDING;
    this._syncAABB();
    this._hasPrevVP = false;
    return true;
  }

  /**
   * Drop references so the player can be garbage collected with its world.
   * @returns {void}
   */
  dispose() {
    this.world = null;
    this.inventory = null;
    if (typeof this.off === 'function' && this._events) this._events.clear?.();
  }
}

export default Player;
