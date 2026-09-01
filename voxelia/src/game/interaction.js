/**
 * @file game/interaction.js — VOXELIA block interaction (ARCHITECTURE.md 5.30).
 *
 * Everything that happens between the crosshair and the world: the continuous
 * raycast, breaking with real mining times, placing with a computed block
 * state, and right-click behaviour for both blocks and items.
 *
 * ============================================================================
 * WHAT THIS MODULE OWNS
 * ============================================================================
 * * `hit` — the current raycast result, handed to the renderer so it can draw
 *   the selection outline, and to the HUD for the block name.
 * * `breakProgress` — `0..1`, drives the crack overlay.
 * * The **block state**. `world/world.js` stores one id per voxel; the extra
 *   orientation nibble (slab half, stairs facing, torch wall, log axis, fence
 *   connections, door half …) lives in the chunk's block-entity record under
 *   the key `state`, written through {@link Interaction#setBlockState}. The
 *   conventions are the ones documented at the top of `world/blocks.js`.
 *
 * ============================================================================
 * EVENTS (the Game wires these to the UI)
 * ============================================================================
 * | event          | arguments                                   |
 * |----------------|---------------------------------------------|
 * | `blockBroken`  | `(x, y, z, blockId, drops)`                 |
 * | `blockPlaced`  | `(x, y, z, blockId, state)`                 |
 * | `openScreen`   | `(kind, x, y, z, blockId)` — `'crafting'`, `'furnace'`, `'chest'`, … |
 * | `interact`     | `({kind, label, x, y, z, blockId})`         |
 * | `useItem`      | `(itemId, x, y, z)`                         |
 * | `eat`          | `(itemId)`                                  |
 * | `pickBlock`    | `(itemId, slot)`                            |
 * | `message`      | `(germanText)` — short HUD hint             |
 *
 * Nothing in here throws: every world, inventory and audio call is probed
 * before use and guarded, because a failed interaction must never kill a tick.
 *
 * @module game/interaction
 */

import { AABB, clamp } from '../core/math.js';
import { EventBus } from '../core/util.js';
import {
  B,
  RENDER,
  TOOL_TIER,
  blockAABBs,
  blockByName,
  blockDrops,
  breakTime,
  canHarvest,
  getBlock as blockDef,
  hasGravity,
  isLiquid,
  isReplaceable,
  isSolid,
} from '../world/blocks.js';
import { WORLD_MAX_Y, WORLD_MIN_Y } from '../world/chunk.js';
import { ItemStack } from './inventory.js';
import {
  blockToItem,
  foodValue,
  getItem as itemDef,
  itemDurability,
  itemIdByName,
  itemToBlock,
  toolTier,
  toolType,
} from './items.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Reach in blocks while in survival or adventure mode. @type {number} */
export const REACH_SURVIVAL = 4.5;

/** Reach in blocks while in creative mode. @type {number} */
export const REACH_CREATIVE = 5.5;

/** Seconds between two placements while the use key is held. @type {number} */
export const PLACE_COOLDOWN = 0.2;

/** Seconds between two creative-mode block breaks. @type {number} */
export const CREATIVE_BREAK_COOLDOWN = 0.15;

/** Seconds between two dig particle bursts / dig sounds while mining. @type {number} */
export const DIG_EFFECT_INTERVAL = 0.2;

/** Exhaustion added for breaking one block. @type {number} */
export const BREAK_EXHAUSTION = 0.005;

/** Horizontal facing values, matching `world/blocks.js`. @type {Readonly<Object<string, number>>} */
export const FACING = Object.freeze({ POS_X: 0, NEG_X: 1, POS_Z: 2, NEG_Z: 3 });

/**
 * Entity types that never block a placement (you can build through dropped
 * items, orbs and arrows, but not through a cow).
 * @type {Set<string>}
 */
const NON_BLOCKING_ENTITIES = new Set(['item', 'item_entity', 'dropped_item', 'xp_orb',
  'experience_orb', 'arrow']);

/**
 * Right-clickable blocks. `kind` is what the Game hands to the UI; `label` is
 * the German HUD hint. Names that the block registry does not contain are
 * skipped at construction time, so this table may safely list more than the
 * registry has.
 * @type {Readonly<Object<string, {kind:string, label:string, screen:boolean}>>}
 */
const INTERACTIVE_BLOCKS = Object.freeze({
  crafting_table: { kind: 'crafting', label: 'Werkbank öffnen', screen: true },
  furnace: { kind: 'furnace', label: 'Ofen öffnen', screen: true },
  blast_furnace: { kind: 'furnace', label: 'Schmelzofen öffnen', screen: true },
  chest: { kind: 'chest', label: 'Truhe öffnen', screen: true },
  barrel: { kind: 'chest', label: 'Fass öffnen', screen: true },
  hopper: { kind: 'hopper', label: 'Trichter öffnen', screen: true },
  dispenser: { kind: 'dispenser', label: 'Werfer öffnen', screen: true },
  enchanting_table: { kind: 'enchanting', label: 'Zaubertisch öffnen', screen: true },
  anvil: { kind: 'anvil', label: 'Amboss öffnen', screen: true },
  brewing_stand: { kind: 'brewing', label: 'Braustand öffnen', screen: true },
  beacon: { kind: 'beacon', label: 'Leuchtfeuer öffnen', screen: true },
  jukebox: { kind: 'jukebox', label: 'Plattenspieler', screen: false },
  note_block: { kind: 'note_block', label: 'Notenblock spielen', screen: false },
  bed: { kind: 'bed', label: 'Schlafen', screen: false },
  red_bed: { kind: 'bed', label: 'Schlafen', screen: false },
  lever: { kind: 'lever', label: 'Hebel umlegen', screen: false },
  stone_button: { kind: 'button', label: 'Knopf drücken', screen: false },
  oak_door: { kind: 'door', label: 'Tür öffnen', screen: false },
  oak_trapdoor: { kind: 'trapdoor', label: 'Falltür öffnen', screen: false },
  oak_fence_gate: { kind: 'fence_gate', label: 'Zauntor öffnen', screen: false },
  cauldron: { kind: 'cauldron', label: 'Kessel', screen: false },
});

/** Blocks a hoe turns into farmland. @type {Set<string>} */
const TILLABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'dirt_path', 'podzol', 'mycelium']);

/** Raycast options for the block ray (fluids are see-through). @type {Object} */
const SOLID_RAY = Object.freeze({ fluids: false });

/** Raycast options for the fluid ray (buckets need to see water). @type {Object} */
const FLUID_RAY = Object.freeze({ fluids: true });

/** Warn dedupe keys. @type {Set<string>} */
const warned = new Set();

/**
 * Log a message once per key so a broken subsystem cannot spam the console.
 * @param {string} key dedupe key
 * @param {string} message text
 * @param {*} [detail] optional error
 * @returns {void}
 */
function warnOnce(key, message, detail) {
  if (warned.has(key)) return;
  warned.add(key);
  if (detail !== undefined) console.warn(`[interaction] ${message}`, detail);
  else console.warn(`[interaction] ${message}`);
}

/**
 * Finite number or fallback.
 * @param {*} v candidate
 * @param {number} fallback replacement for non-numbers
 * @returns {number} a usable number
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Horizontal facing (`FACING.*`) a direction vector points at.
 * @param {number} dx direction X
 * @param {number} dz direction Z
 * @returns {number} `0 = +X, 1 = -X, 2 = +Z, 3 = -Z`
 */
export function facingFromDirection(dx, dz) {
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? FACING.POS_X : FACING.NEG_X;
  return dz >= 0 ? FACING.POS_Z : FACING.NEG_Z;
}

/**
 * The opposite horizontal facing.
 * @param {number} facing a `FACING` value
 * @returns {number} the opposite facing
 */
export function oppositeFacing(facing) {
  switch (facing & 3) {
    case FACING.POS_X: return FACING.NEG_X;
    case FACING.NEG_X: return FACING.POS_X;
    case FACING.POS_Z: return FACING.NEG_Z;
    default: return FACING.POS_Z;
  }
}

/** Unit X offset per horizontal facing. @type {readonly number[]} */
const FACING_DX = Object.freeze([1, -1, 0, 0]);

/** Unit Z offset per horizontal facing. @type {readonly number[]} */
const FACING_DZ = Object.freeze([0, 0, 1, -1]);

/** Face direction (3.1) -> horizontal facing, `-1` for the vertical faces. @type {readonly number[]} */
const FACE_TO_FACING = Object.freeze([FACING.POS_X, FACING.NEG_X, -1, -1, FACING.POS_Z, FACING.NEG_Z]);

/**
 * Torch state for a clicked face: `0` standing, `1` on the -X wall, `2` +X,
 * `3` -Z, `4` +Z (see the state conventions in `world/blocks.js`).
 * @type {readonly number[]}
 */
const FACE_TO_TORCH = Object.freeze([1, 2, 0, -1, 3, 4]);

/**
 * Ladder state for a clicked face: the wall the ladder ends up hanging on.
 * @type {readonly number[]}
 */
const FACE_TO_LADDER = Object.freeze([1, 0, -1, -1, 3, 2]);

/* ========================================================================== */
/* Interaction                                                                */
/* ========================================================================== */

/**
 * Turns the player's mouse buttons into world edits.
 *
 * One instance lives for the whole session; `game/game.js` calls
 * {@link Interaction#update} once per fixed tick and reads {@link Interaction#hit}
 * and {@link Interaction#breakProgress} when it builds the render frame.
 */
export class Interaction extends EventBus {
  /**
   * @param {Object} world the `world/world.js` World
   * @param {Object} player the `game/player.js` Player
   * @param {Object} input the `core/input.js` Input
   * @param {?Object} [audio] the `game/audio.js` AudioEngine
   * @param {?Object} [particles] the `render/particles.js` ParticleSystem
   * @param {?Object} [entities] the {@link module:game/entities.EntityManager}
   */
  constructor(world, player, input, audio = null, particles = null, entities = null) {
    super();

    /** @type {Object} The world being edited. */
    this.world = world || null;
    /** @type {Object} The acting player. */
    this.player = player || null;
    /** @type {Object} Input state. */
    this.input = input || null;
    /** @type {?Object} Audio engine (optional). */
    this.audio = audio;
    /** @type {?Object} Particle system (optional). */
    this.particles = particles;
    /** @type {?Object} Entity manager (optional but needed for drops). */
    this.entities = entities;

    /**
     * Current raycast hit, or `null`.
     * @type {?{x:number, y:number, z:number, face:number, faceNormal:number[],
     *   point:number[], dist:number, blockId:number}}
     */
    this.hit = null;
    /** @type {number} Breaking progress of the current target, `0..1`. */
    this.breakProgress = 0;
    /** @type {number} Seconds until the next block may be placed. */
    this.placeCooldown = 0;
    /** @type {number} Seconds until the next creative break. */
    this.breakCooldown = 0;
    /** @type {boolean} True while the player holds the attack button on a block. */
    this.breaking = false;
    /** @type {boolean} True while an item is being consumed. */
    this.eating = false;
    /** @type {number} Seconds the current item use has been held. */
    this.useTime = 0;
    /** @type {number} Seconds the current item use needs in total. */
    this.useDuration = 0;
    /** @type {boolean} Master switch; the Game turns this off in menus. */
    this.enabled = true;

    /** @type {number} X of the block being mined. @private */
    this._targetX = 0;
    /** @type {number} Y of the block being mined. @private */
    this._targetY = 0;
    /** @type {number} Z of the block being mined. @private */
    this._targetZ = 0;
    /** @type {number} Block id being mined (`0` = nothing). @private */
    this._targetBlock = 0;
    /** @type {number} Item id held when the current break started. @private */
    this._breakItem = -1;
    /** @type {number} Seconds the current block needs in total. @private */
    this._breakDuration = 0;
    /** @type {number} Seconds since the last dig particle burst. @private */
    this._digTimer = 0;
    /** @type {number} Item id being consumed. @private */
    this._useItemId = 0;

    /** @type {Float32Array} Scratch ray origin. @private */
    this._origin = new Float32Array(3);
    /** @type {Float32Array} Scratch ray direction. @private */
    this._dir = new Float32Array(3);
    /** @type {AABB} Scratch placement box. @private */
    this._box = new AABB();
    /** @type {Int32Array} Scratch target cell `[x, y, z]`. @private */
    this._cell = new Int32Array(3);
    /** @type {Object[]} Scratch entity query result. @private */
    this._entityList = [];
    /** @type {boolean} Set to `true` once the module is disposed. @private */
    this._disposed = false;

    /** @type {Map<number, {kind:string, label:string, screen:boolean}>} Resolved table. @private */
    this._interactive = new Map();
    for (const name of Object.keys(INTERACTIVE_BLOCKS)) {
      const def = blockByName(name);
      if (def.id !== 0) this._interactive.set(def.id, INTERACTIVE_BLOCKS[name]);
    }
  }

  /* ===================================================================== */
  /* Frame                                                                  */
  /* ===================================================================== */

  /**
   * Reach in blocks for the current game mode.
   * @returns {number} reach distance
   */
  getReach() {
    const mode = this.player && this.player.gameMode ? this.player.gameMode : 'survival';
    return mode === 'creative' || mode === 'spectator' ? REACH_CREATIVE : REACH_SURVIVAL;
  }

  /**
   * Advance the interaction state by one tick.
   * @param {number} dt elapsed seconds (0.05 at 20 TPS)
   * @returns {void}
   */
  update(dt) {
    if (this._disposed) return;
    const step = clamp(num(dt, 0), 0, 0.25);
    if (this.placeCooldown > 0) this.placeCooldown = Math.max(0, this.placeCooldown - step);
    if (this.breakCooldown > 0) this.breakCooldown = Math.max(0, this.breakCooldown - step);

    if (!this.enabled || this.player === null || this.world === null || this.input === null) {
      this.hit = null;
      this._resetBreak();
      return;
    }

    try {
      this._updateHit();
    } catch (err) {
      warnOnce('raycast', 'the interaction raycast failed; targeting is disabled', err);
      this.hit = null;
    }

    if (this.player.gameMode === 'spectator' || this.player.dead === true) {
      this._resetBreak();
      this._abortUse();
      return;
    }

    try {
      this._updateBreaking(step);
      this._updateUsing(step);
    } catch (err) {
      warnOnce('update', 'an interaction step failed and was skipped', err);
      this._resetBreak();
      this._abortUse();
    }
  }

  /**
   * Refresh {@link Interaction#hit} from the camera.
   * @returns {void}
   * @private
   */
  _updateHit() {
    const player = this.player;
    const origin = typeof player.getEyePosition === 'function'
      ? player.getEyePosition(this._origin) : this._origin;
    const dir = typeof player.getLookDirection === 'function'
      ? player.getLookDirection(this._dir) : this._dir;
    if (origin !== this._origin) {
      this._origin[0] = origin[0];
      this._origin[1] = origin[1];
      this._origin[2] = origin[2];
    }
    if (dir !== this._dir) {
      this._dir[0] = dir[0];
      this._dir[1] = dir[1];
      this._dir[2] = dir[2];
    }
    this.hit = this.world.raycast(this._origin, this._dir, this.getReach(), SOLID_RAY);
  }

  /* ===================================================================== */
  /* Breaking                                                               */
  /* ===================================================================== */

  /**
   * Accumulate mining progress while the attack button is held.
   * @param {number} dt elapsed seconds
   * @returns {void}
   * @private
   */
  _updateBreaking(dt) {
    const input = this.input;
    const attacking = input.isActionDown('attack');
    const hit = this.hit;

    if (!attacking || hit === null) {
      if (this.breaking) this.emit('breakAborted', this._targetX, this._targetY, this._targetZ);
      this._resetBreak();
      return;
    }

    const player = this.player;
    const creative = player.gameMode === 'creative';
    const held = this._heldStack();
    const heldId = held === null ? 0 : held.itemId;

    // A new target or a different tool restarts the progress bar.
    if (hit.x !== this._targetX || hit.y !== this._targetY || hit.z !== this._targetZ
      || hit.blockId !== this._targetBlock || heldId !== this._breakItem) {
      this._targetX = hit.x;
      this._targetY = hit.y;
      this._targetZ = hit.z;
      this._targetBlock = hit.blockId;
      this._breakItem = heldId;
      this.breakProgress = 0;
      this._digTimer = DIG_EFFECT_INTERVAL;
      this._breakDuration = this._computeBreakTime(hit.blockId, held);
      this.breaking = true;
      if (typeof player.swing === 'function') player.swing();
    }

    if (creative) {
      if (this.breakCooldown <= 0) {
        this.breakCooldown = CREATIVE_BREAK_COOLDOWN;
        this.tryBreak();
      }
      this.breakProgress = 0;
      return;
    }

    const duration = this._breakDuration;
    if (!Number.isFinite(duration)) {
      // Bedrock and friends: show no progress at all.
      this.breakProgress = 0;
      this._emitDigEffects(dt, hit);
      return;
    }

    this.breakProgress += duration <= 0 ? 1 : dt / duration;
    this._emitDigEffects(dt, hit);

    if (this.breakProgress >= 1) {
      this.breakProgress = 0;
      this.tryBreak();
      // Keep mining: the next block starts from zero on the following tick.
      this._targetBlock = 0;
    }
  }

  /**
   * Seconds the held item needs for one block, including the enchantments and
   * the player's posture.
   * @param {number} blockId the block being mined
   * @param {?ItemStack} held the held stack
   * @returns {number} seconds, `Infinity` for unbreakable blocks
   * @private
   */
  _computeBreakTime(blockId, held) {
    const player = this.player;
    const itemId = held === null ? 0 : held.itemId;
    const efficiency = held === null ? 0 : held.getEnchantmentLevel('efficiency');
    const onGround = player.onGround !== false;
    const inWater = this._eyeInWater();
    let aqua = 0;
    const inv = player.inventory;
    if (inv && typeof inv.armor === 'function') {
      const helmet = inv.armor(0);
      if (helmet) aqua = helmet.getEnchantmentLevel('aqua_affinity');
    }
    return breakTime(blockId, toolType(itemId), toolTier(itemId), efficiency, onGround,
      inWater, aqua > 0);
  }

  /**
   * Is the player's head inside water? Mining is five times slower there.
   * @returns {boolean} true when the eye is submerged
   * @private
   */
  _eyeInWater() {
    const player = this.player;
    if (player.inWater !== true) return false;
    const world = this.world;
    if (!world || typeof world.getBlock !== 'function') return true;
    const eye = typeof player.getEyePosition === 'function'
      ? player.getEyePosition(this._origin) : null;
    if (eye === null) return true;
    const id = world.getBlock(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]));
    return id === B.WATER;
  }

  /**
   * Chip particles and the dig sound, on a cadence instead of every tick.
   * @param {number} dt elapsed seconds
   * @param {Object} hit the current raycast hit
   * @returns {void}
   * @private
   */
  _emitDigEffects(dt, hit) {
    this._digTimer += dt;
    if (this._digTimer < DIG_EFFECT_INTERVAL) return;
    this._digTimer = 0;

    const particles = this.particles;
    if (particles && typeof particles.spawnBlockHit === 'function') {
      try {
        particles.spawnBlockHit(hit.x, hit.y, hit.z, hit.blockId, hit.faceNormal);
      } catch (err) {
        warnOnce('digParticles', 'dig particles failed', err);
      }
    }
    const audio = this.audio;
    if (audio && typeof audio.playBlockSound === 'function') {
      try {
        audio.playBlockSound('hit', hit.blockId, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      } catch (err) {
        warnOnce('digSound', 'the dig sound failed', err);
      }
    }
    const player = this.player;
    if (typeof player.swing === 'function') player.swing();
  }

  /**
   * Forget the current mining target.
   * @returns {void}
   * @private
   */
  _resetBreak() {
    this.breaking = false;
    this.breakProgress = 0;
    this._targetBlock = 0;
    this._breakItem = -1;
    this._breakDuration = 0;
    this._digTimer = 0;
  }

  /**
   * Break the targeted block right now: remove it, spawn its drops, wear the
   * tool down and add exhaustion.
   * @returns {boolean} true when a block was removed
   */
  tryBreak() {
    const hit = this.hit;
    const world = this.world;
    const player = this.player;
    if (hit === null || world === null || player === null) return false;
    if (player.gameMode === 'spectator') return false;

    const { x, y, z } = hit;
    const blockId = world.getBlock(x, y, z);
    if (blockId === 0) return false;
    const def = blockDef(blockId);
    if (def.hardness < 0 && player.gameMode !== 'creative') return false;

    const creative = player.gameMode === 'creative';
    const held = this._heldStack();
    const itemId = held === null ? 0 : held.itemId;
    const state = this.getBlockState(x, y, z);

    if (!world.setBlock(x, y, z, 0)) return false;
    this.setBlockState(x, y, z, 0);

    // A door takes its other half with it.
    this._breakDoorPartner(blockId, state, x, y, z);

    /** @type {{item:string, count:number}[]} */
    let drops = [];
    if (!creative) {
      drops = this._computeDrops(blockId, held);
      this._spawnDrops(x, y, z, drops);
      if (itemId !== 0 && itemDurability(itemId) > 0 && def.hardness > 0) {
        const inv = player.inventory;
        if (inv && typeof inv.damageSelected === 'function') inv.damageSelected(1);
      }
      if (typeof player.addExhaustion === 'function') player.addExhaustion(BREAK_EXHAUSTION);
    }

    const particles = this.particles;
    if (particles && typeof particles.spawnBlockBreak === 'function') {
      try {
        particles.spawnBlockBreak(x, y, z, blockId);
      } catch (err) {
        warnOnce('breakParticles', 'break particles failed', err);
      }
    }
    const audio = this.audio;
    if (audio && typeof audio.playBlockSound === 'function') {
      try {
        audio.playBlockSound('break', blockId, x + 0.5, y + 0.5, z + 0.5);
      } catch (err) {
        warnOnce('breakSound', 'the break sound failed', err);
      }
    }
    if (typeof player.swing === 'function') player.swing();

    this._updateNeighbourConnections(x, y, z);
    this._dropUnsupportedNeighbours(x, y, z);
    this._checkFalling(x, y + 1, z);

    this.breakProgress = 0;
    this._targetBlock = 0;
    this.emit('blockBroken', x, y, z, blockId, drops);
    return true;
  }

  /**
   * Loot of one block, honouring Silk Touch, Fortune and the tool requirement.
   * @param {number} blockId the block that was mined
   * @param {?ItemStack} held the held stack
   * @returns {{item:string, count:number}[]} drop list
   * @private
   */
  _computeDrops(blockId, held) {
    const itemId = held === null ? 0 : held.itemId;
    const type = toolType(itemId);
    const tier = toolTier(itemId);
    if (!canHarvest(blockId, type, tier)) return [];

    if (held !== null && held.getEnchantmentLevel('silk_touch') > 0) {
      const def = blockDef(blockId);
      const silk = blockToItem(blockId);
      if (silk > 0 && !def.liquid) return [{ item: itemDef(silk).name, count: 1 }];
    }
    const fortune = held === null ? 0 : held.getEnchantmentLevel('fortune');
    return blockDrops(blockId, type, tier, fortune);
  }

  /**
   * Turn a drop list into item entities.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {{item:string, count:number}[]} drops drop list
   * @returns {void}
   * @private
   */
  _spawnDrops(x, y, z, drops) {
    if (!Array.isArray(drops) || drops.length === 0) return;
    const entities = this.entities;
    if (entities && typeof entities.dropBlockLoot === 'function') {
      try {
        entities.dropBlockLoot(x, y, z, drops);
        return;
      } catch (err) {
        warnOnce('dropLoot', 'dropping the block loot failed', err);
      }
    }
    // Fallback: straight into the inventory, so nothing is lost without an
    // entity manager attached (used by the tests and by the level editor).
    const inv = this.player ? this.player.inventory : null;
    if (!inv || typeof inv.addPickup !== 'function') return;
    for (let i = 0; i < drops.length; i++) {
      const id = itemIdByName(drops[i].item);
      if (id > 0) inv.addPickup(new ItemStack(id, Math.max(1, drops[i].count | 0), null));
    }
  }

  /**
   * Remove the other half of a door when one half breaks.
   * @param {number} blockId the block that was broken
   * @param {number} state its state
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {void}
   * @private
   */
  _breakDoorPartner(blockId, state, x, y, z) {
    const def = blockDef(blockId);
    if (!def.name.endsWith('_door')) return;
    const partnerY = (state & 2) !== 0 ? y - 1 : y + 1;
    if (partnerY < WORLD_MIN_Y || partnerY >= WORLD_MAX_Y) return;
    if (this.world.getBlock(x, partnerY, z) !== blockId) return;
    this.world.setBlock(x, partnerY, z, 0);
    this.setBlockState(x, partnerY, z, 0);
  }

  /* ===================================================================== */
  /* Placing                                                                */
  /* ===================================================================== */

  /**
   * Place the held block against the targeted face.
   * @returns {boolean} true when a block was placed
   */
  tryPlace() {
    const hit = this.hit;
    const world = this.world;
    const player = this.player;
    if (hit === null || world === null || player === null) return false;
    if (player.gameMode === 'spectator') return false;
    if (this.placeCooldown > 0) return false;

    const held = this._heldStack();
    if (held === null || held.isEmpty()) return false;
    const itemId = held.itemId;
    const item = itemDef(itemId);
    if (item.name === 'water_bucket' || item.name === 'lava_bucket') return false;

    const blockId = itemToBlock(itemId);
    if (blockId <= 0) return false;

    const state = this.getPlacementState(blockId, hit, player);
    if (state < 0) return false;

    // Slabs and snow layers grow the block that was clicked instead of adding a
    // new one next to it; everything else goes into the clicked cell when that
    // is replaceable (tall grass, water) and against the clicked face otherwise.
    const merging = this._isMergePlacement(blockId, state, hit);
    let tx = hit.x;
    let ty = hit.y;
    let tz = hit.z;
    if (!merging) {
      const cell = this._targetCell(hit);
      tx = cell[0];
      ty = cell[1];
      tz = cell[2];
    }
    if (ty < WORLD_MIN_Y || ty >= WORLD_MAX_Y) return false;

    const existing = world.getBlock(tx, ty, tz);
    if (!merging && existing !== 0 && !isReplaceable(existing)) return false;

    if (!this._placementSupported(blockId, state, tx, ty, tz)) {
      this.emit('message', 'Hier hält der Block nicht.');
      this.placeCooldown = PLACE_COOLDOWN;
      return false;
    }
    if (!this._canOccupy(blockId, state, tx, ty, tz)) return false;

    const def = blockDef(blockId);

    if (merging) {
      // The block id does not change — only its state grows.
      this.setBlockState(tx, ty, tz, state);
      if (player.gameMode !== 'creative') {
        const inv = player.inventory;
        if (inv && typeof inv.consumeSelected === 'function') inv.consumeSelected(1);
      }
      const mergeAudio = this.audio;
      if (mergeAudio && typeof mergeAudio.playBlockSound === 'function') {
        try {
          mergeAudio.playBlockSound('place', blockId, tx + 0.5, ty + 0.5, tz + 0.5);
        } catch (err) {
          warnOnce('placeSound', 'the place sound failed', err);
        }
      }
      if (typeof player.swing === 'function') player.swing();
      this.placeCooldown = PLACE_COOLDOWN;
      this.emit('blockPlaced', tx, ty, tz, blockId, state);
      return true;
    }

    const isDoor = def.name.endsWith('_door');
    if (isDoor) {
      const upper = ty + 1;
      if (upper >= WORLD_MAX_Y) return false;
      const above = world.getBlock(tx, upper, tz);
      if (above !== 0 && !isReplaceable(above)) {
        this.emit('message', 'Über der Tür ist kein Platz.');
        this.placeCooldown = PLACE_COOLDOWN;
        return false;
      }
    }

    if (!world.setBlock(tx, ty, tz, blockId)) return false;
    this.setBlockState(tx, ty, tz, state);
    if (isDoor) {
      world.setBlock(tx, ty + 1, tz, blockId);
      this.setBlockState(tx, ty + 1, tz, state | 2);
    }

    this._updateNeighbourConnections(tx, ty, tz);
    this._refreshConnections(tx, ty, tz);

    if (player.gameMode !== 'creative') {
      const inv = player.inventory;
      if (inv && typeof inv.consumeSelected === 'function') inv.consumeSelected(1);
    }

    const audio = this.audio;
    if (audio && typeof audio.playBlockSound === 'function') {
      try {
        audio.playBlockSound('place', blockId, tx + 0.5, ty + 0.5, tz + 0.5);
      } catch (err) {
        warnOnce('placeSound', 'the place sound failed', err);
      }
    }
    if (typeof player.swing === 'function') player.swing();

    this.placeCooldown = PLACE_COOLDOWN;
    this._checkFalling(tx, ty, tz);
    this.emit('blockPlaced', tx, ty, tz, blockId, state);
    return true;
  }

  /**
   * Does this placement grow the block that was clicked (a bottom slab turning
   * into a double slab, a snow layer getting taller) instead of adding a new
   * block beside it?
   * @param {number} blockId the block being placed
   * @param {number} state the state {@link Interaction#getPlacementState} computed
   * @param {Object} hit the raycast hit
   * @returns {boolean} true when the clicked cell itself is edited
   * @private
   */
  _isMergePlacement(blockId, state, hit) {
    if (hit.blockId !== blockId) return false;
    const def = blockDef(blockId);
    // Snow shares the slab render kind, so it has to be tested first.
    if (def.name === 'snow_layer') return state > (this.getBlockState(hit.x, hit.y, hit.z) & 7);
    if (def.render === RENDER.SLAB) return state === 2;
    return false;
  }

  /**
   * The cell a placement lands in: the clicked cell when its block can be
   * replaced (tall grass, water, snow), otherwise the cell against the clicked
   * face.
   * @param {Object} hit the raycast hit
   * @returns {Int32Array} shared `[x, y, z]`
   * @private
   */
  _targetCell(hit) {
    const out = this._cell;
    out[0] = hit.x;
    out[1] = hit.y;
    out[2] = hit.z;
    if (!isReplaceable(hit.blockId)) {
      out[0] += hit.faceNormal[0] | 0;
      out[1] += hit.faceNormal[1] | 0;
      out[2] += hit.faceNormal[2] | 0;
    }
    return out;
  }

  /**
   * Orientation of a block that is about to be placed.
   *
   * The returned integer follows the state conventions documented at the top of
   * `world/blocks.js`; blocks that ignore their state return `0`. A negative
   * result means "this cannot be placed here".
   *
   * @param {number} blockId the block being placed
   * @param {Object} hit the raycast hit it is placed against
   * @param {Object} [player] the placing player (defaults to the bound one)
   * @returns {number} the block state
   */
  getPlacementState(blockId, hit, player = this.player) {
    const def = blockDef(blockId);
    if (def.id === 0 || hit === null) return 0;
    const name = def.name;
    const face = hit.face | 0;

    const dir = player && typeof player.getLookDirection === 'function'
      ? player.getLookDirection(this._dir) : null;
    const lookFacing = dir === null ? FACING.POS_X : facingFromDirection(dir[0], dir[2]);
    const nearFacing = oppositeFacing(lookFacing);

    // How far up the clicked face did the cursor land? Drives slabs, stairs and
    // trapdoors when the player clicks a side.
    const point = hit.point;
    const fracY = point ? point[1] - Math.floor(point[1]) : 0.5;
    const upperHalf = face === 3 || (face !== 2 && fracY > 0.5);

    if (name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_pillar')
      || name === 'basalt' || name === 'bone_block') {
      // Axis: 0 = Y (default), 1 = X, 2 = Z — taken from the clicked face.
      if (face === 0 || face === 1) return 1;
      if (face === 4 || face === 5) return 2;
      return 0;
    }

    if (name === 'snow_layer') {
      // Snow uses the slab shape table but stacks in eight steps instead of
      // turning into a double slab, so it is handled before the render switch.
      if (hit.blockId === blockId) {
        const existing = this.getBlockState(hit.x, hit.y, hit.z) & 7;
        return Math.min(7, existing + 1);
      }
      return 0;
    }

    switch (def.render) {
      case RENDER.SLAB: {
        // Clicking an existing matching slab doubles it.
        if (hit.blockId === blockId) {
          const existing = this.getBlockState(hit.x, hit.y, hit.z);
          if ((existing & 3) < 2) return 2;
        }
        if (face === 2) return 0;
        if (face === 3) return 1;
        return upperHalf ? 1 : 0;
      }
      case RENDER.STAIRS:
        return (upperHalf ? 4 : 0) | lookFacing;
      case RENDER.TORCH: {
        const torch = FACE_TO_TORCH[face];
        if (torch === undefined || torch < 0) return -1;
        return torch;
      }
      case RENDER.PANE: {
        const cell = this._targetCell(hit);
        return this._connectionMask(blockId, cell[0], cell[1], cell[2]);
      }
      default:
        break;
    }

    if (name === 'ladder') {
      const wall = FACE_TO_LADDER[face];
      if (wall === undefined || wall < 0) return -1;
      return wall;
    }
    if (name.endsWith('_fence')) {
      const cell = this._targetCell(hit);
      return this._connectionMask(blockId, cell[0], cell[1], cell[2]);
    }
    if (name.endsWith('_door')) {
      // Closed, lower half, panel on the side the player is standing on.
      return (nearFacing << 2) & 0xc;
    }
    if (name.endsWith('_trapdoor')) {
      const top = face === 3 || (face !== 2 && fracY > 0.5);
      return ((nearFacing << 2) & 0xc) | (top ? 2 : 0);
    }
    if (name.endsWith('_fence_gate')) {
      return (lookFacing << 2) & 0xc;
    }
    if (name === 'lever' || name.endsWith('_button')) {
      const wall = FACE_TO_TORCH[face];
      return wall === undefined || wall < 0 ? 0 : wall;
    }
    return 0;
  }

  /**
   * Connection bits (`+X, -X, +Z, -Z`) of a fence/pane at a position.
   * @param {number} blockId the fence or pane block
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {number} the four connection bits
   * @private
   */
  _connectionMask(blockId, x, y, z) {
    const world = this.world;
    if (!world) return 0;
    let mask = 0;
    for (let f = 0; f < 4; f++) {
      const nx = x + FACING_DX[f];
      const nz = z + FACING_DZ[f];
      if (this._connectsTo(blockId, world.getBlock(nx, y, nz))) mask |= 1 << f;
    }
    return mask;
  }

  /**
   * Does a fence or pane connect to a neighbouring block?
   * @param {number} blockId the fence/pane
   * @param {number} neighbourId the neighbour
   * @returns {boolean} true when they connect
   * @private
   */
  _connectsTo(blockId, neighbourId) {
    if (neighbourId === 0) return false;
    const self = blockDef(blockId);
    const other = blockDef(neighbourId);
    const fullCube = other.opaque && other.solid && other.render === RENDER.CUBE;
    if (self.render === RENDER.PANE) {
      return other.render === RENDER.PANE || fullCube;
    }
    // Fences and gates are MODEL-rendered, so they are matched by name.
    if (other.name.endsWith('_fence') || other.name.endsWith('_fence_gate')) return true;
    return fullCube;
  }

  /**
   * Recompute the connection state of the four horizontal neighbours after a
   * fence or pane appeared or vanished.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {void}
   * @private
   */
  _updateNeighbourConnections(x, y, z) {
    const world = this.world;
    if (!world) return;
    for (let f = 0; f < 4; f++) {
      const nx = x + FACING_DX[f];
      const nz = z + FACING_DZ[f];
      const id = world.getBlock(nx, y, nz);
      if (id === 0) continue;
      const def = blockDef(id);
      if (def.render !== RENDER.PANE && !def.name.endsWith('_fence')) continue;
      this.setBlockState(nx, y, nz, this._connectionMask(id, nx, y, nz));
    }
  }

  /**
   * Recompute the connection state of the block that was just placed.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {void}
   * @private
   */
  _refreshConnections(x, y, z) {
    const world = this.world;
    if (!world) return;
    const id = world.getBlock(x, y, z);
    if (id === 0) return;
    const def = blockDef(id);
    if (def.render !== RENDER.PANE && !def.name.endsWith('_fence')) return;
    this.setBlockState(x, y, z, this._connectionMask(id, x, y, z));
  }

  /**
   * Can a block with this shape occupy the cell without trapping the player or
   * an entity inside it?
   * @param {number} blockId the block being placed
   * @param {number} state its state
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {boolean} true when the cell is free
   * @private
   */
  _canOccupy(blockId, state, x, y, z) {
    const def = blockDef(blockId);
    if (!def.solid || def.liquid) return true;
    const boxes = blockAABBs(blockId, state);
    if (boxes.length === 0) return true;

    const box = this._box;
    const player = this.player;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      box.set(x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]);
      if (player && player.aabb && box.intersects(player.aabb)) return false;

      const entities = this.entities;
      if (entities && typeof entities.queryAABB === 'function') {
        const list = entities.queryAABB(box, this._entityList);
        for (let k = 0; k < list.length; k++) {
          const e = list[k];
          if (!e || e.removed === true || e.dead === true) continue;
          if (NON_BLOCKING_ENTITIES.has(e.type)) continue;
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Does the block find something to stand on or hang from?
   * @param {number} blockId the block being placed
   * @param {number} state its state
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {boolean} true when the placement is supported
   * @private
   */
  _placementSupported(blockId, state, x, y, z) {
    const def = blockDef(blockId);
    const name = def.name;

    if (def.render === RENDER.TORCH || name === 'lever' || name.endsWith('_button')) {
      if ((state & 7) === 0) return this._solidTop(x, y - 1, z);
      // Wall states 1..4: -X, +X, -Z, +Z.
      const wallX = state === 1 ? x - 1 : (state === 2 ? x + 1 : x);
      const wallZ = state === 3 ? z - 1 : (state === 4 ? z + 1 : z);
      return this._solidSupport(wallX, y, wallZ);
    }
    if (name === 'ladder' || name === 'vine') {
      // Wall states 0..3: +X, -X, +Z, -Z.
      const f = state & 3;
      return this._solidSupport(x + FACING_DX[f], y, z + FACING_DZ[f]);
    }
    if (name === 'lantern' || name === 'soul_lantern') {
      return this._solidTop(x, y - 1, z) || this._solidSupport(x, y + 1, z);
    }
    if (def.dropKind === 'crop' || name.startsWith('wheat_') || name.startsWith('carrots_')
      || name.startsWith('potatoes_') || name.startsWith('beetroot_')) {
      return this.world.getBlock(x, y - 1, z) === B.FARMLAND;
    }
    if (name === 'cactus') {
      const below = this.world.getBlock(x, y - 1, z);
      return below === B.SAND || below === B.RED_SAND || below === blockId;
    }
    if (name === 'sugar_cane') {
      const below = this.world.getBlock(x, y - 1, z);
      if (below === blockId) return true;
      if (below !== B.SAND && below !== B.RED_SAND && below !== B.DIRT
        && below !== B.GRASS_BLOCK && below !== B.COARSE_DIRT) return false;
      // Sugar cane needs water next to its base.
      for (let f = 0; f < 4; f++) {
        const id = this.world.getBlock(x + FACING_DX[f], y - 1, z + FACING_DZ[f]);
        if (id === B.WATER) return true;
      }
      return false;
    }
    if (def.render === RENDER.CROSS || name === 'snow_layer' || name === 'rail'
      || name === 'powered_rail' || name.endsWith('_carpet')
      || name.endsWith('_pressure_plate')) {
      return this._solidTop(x, y - 1, z);
    }
    return true;
  }

  /**
   * Is there a full, solid top face at this position (something a plant or a
   * standing torch can sit on)?
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {boolean} true when the top face is solid
   * @private
   */
  _solidTop(x, y, z) {
    const world = this.world;
    if (!world) return false;
    const id = world.getBlock(x, y, z);
    if (id === 0 || isLiquid(id) || !isSolid(id)) return false;
    const boxes = blockAABBs(id, this.getBlockState(x, y, z));
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b[4] >= 0.999 && b[0] <= 0.001 && b[2] <= 0.001 && b[3] >= 0.999 && b[5] >= 0.999) {
        return true;
      }
    }
    return false;
  }

  /**
   * Is the block at this position solid enough to hang something from?
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {boolean} true when it can carry an attachment
   * @private
   */
  _solidSupport(x, y, z) {
    const world = this.world;
    if (!world) return false;
    const id = world.getBlock(x, y, z);
    if (id === 0 || isLiquid(id)) return false;
    const def = blockDef(id);
    return def.solid && def.render === RENDER.CUBE;
  }

  /**
   * Break attached blocks (torches, plants, rails) that just lost their
   * support, and drop them.
   * @param {number} x block X of the removed block
   * @param {number} y block Y of the removed block
   * @param {number} z block Z of the removed block
   * @returns {void}
   * @private
   */
  _dropUnsupportedNeighbours(x, y, z) {
    const world = this.world;
    if (!world) return;
    for (let i = 0; i < 5; i++) {
      const nx = i === 0 ? x : x + FACING_DX[i - 1];
      const nz = i === 0 ? z : z + FACING_DZ[i - 1];
      const ny = i === 0 ? y + 1 : y;
      const id = world.getBlock(nx, ny, nz);
      if (id === 0) continue;
      const def = blockDef(id);
      if (def.render === RENDER.CUBE && def.name !== 'snow_layer') continue;
      const state = this.getBlockState(nx, ny, nz);
      if (this._placementSupported(id, state, nx, ny, nz)) continue;
      if (!world.setBlock(nx, ny, nz, 0)) continue;
      this.setBlockState(nx, ny, nz, 0);
      if (this.player && this.player.gameMode !== 'creative') {
        this._spawnDrops(nx, ny, nz, blockDrops(id, def.toolType, TOOL_TIER.NETHERITE));
      }
    }
  }

  /**
   * Turn unsupported gravity blocks into falling entities, walking up the whole
   * column so a mined pillar of sand collapses at once.
   * @param {number} x block X
   * @param {number} y block Y of the lowest candidate
   * @param {number} z block Z
   * @returns {number} how many blocks started falling
   * @private
   */
  _checkFalling(x, y, z) {
    const world = this.world;
    const entities = this.entities;
    if (!world || !entities || typeof entities.spawnFallingBlock !== 'function') return 0;
    if (y - 1 < WORLD_MIN_Y) return 0;
    const below = world.getBlock(x, y - 1, z);
    if (below !== 0 && !isReplaceable(below)) return 0;

    let fallen = 0;
    for (let cy = y; cy < y + 64 && cy < WORLD_MAX_Y; cy++) {
      const id = world.getBlock(x, cy, z);
      if (id === 0 || !hasGravity(id)) break;
      const state = this.getBlockState(x, cy, z);
      if (!world.setBlock(x, cy, z, 0)) break;
      this.setBlockState(x, cy, z, 0);
      entities.spawnFallingBlock(x, cy, z, id, state);
      fallen++;
    }
    return fallen;
  }

  /* ===================================================================== */
  /* Using                                                                  */
  /* ===================================================================== */

  /**
   * Right-click handling: interactive blocks, then item behaviour, then
   * placing.
   * @param {number} dt elapsed seconds
   * @returns {void}
   * @private
   */
  _updateUsing(dt) {
    const input = this.input;
    if (input.wasActionPressed('pick')) this.pickBlock();

    const down = input.isActionDown('use');
    const pressed = input.wasActionPressed('use');

    if (!down) {
      if (this.eating) this._abortUse();
      return;
    }

    if (this.eating) {
      this._tickConsume(dt);
      return;
    }
    if (pressed) {
      if (this.tryUse()) return;
      this.tryPlace();
      return;
    }
    if (this.placeCooldown <= 0) this.tryPlace();
  }

  /**
   * Use the held item, or the block the player is looking at.
   * @returns {boolean} true when the right click was consumed
   */
  tryUse() {
    const player = this.player;
    if (player === null || this.world === null) return false;
    if (player.gameMode === 'spectator') return false;

    const held = this._heldStack();
    const sneaking = player.sneaking === true;
    const hasPlaceable = held !== null && !held.isEmpty() && itemToBlock(held.itemId) > 0;

    if (this.hit !== null && !(sneaking && hasPlaceable)) {
      const entry = this._interactive.get(this.hit.blockId);
      if (entry !== undefined && this._interactBlock(entry, this.hit)) return true;
    }
    return this._useItem(held);
  }

  /**
   * Run the behaviour of an interactive block.
   * @param {{kind:string, label:string, screen:boolean}} entry table entry
   * @param {Object} hit the raycast hit
   * @returns {boolean} true when the interaction happened
   * @private
   */
  _interactBlock(entry, hit) {
    const { x, y, z, blockId } = hit;
    const descriptor = { kind: entry.kind, label: entry.label, x, y, z, blockId };

    switch (entry.kind) {
      case 'door':
      case 'trapdoor':
      case 'fence_gate': {
        const state = this.getBlockState(x, y, z);
        const open = (state & 1) === 0;
        this.setBlockState(x, y, z, open ? state | 1 : state & ~1);
        if (entry.kind === 'door') {
          const partnerY = (state & 2) !== 0 ? y - 1 : y + 1;
          if (this.world.getBlock(x, partnerY, z) === blockId) {
            const ps = this.getBlockState(x, partnerY, z);
            this.setBlockState(x, partnerY, z, open ? ps | 1 : ps & ~1);
          }
        }
        this._playUiSound(entry.kind === 'fence_gate' ? 'door' : entry.kind, x, y, z, open);
        this.emit('interact', descriptor);
        this.emit('message', open ? `${entry.label}` : 'Schließen');
        break;
      }
      case 'lever':
      case 'button': {
        const state = this.getBlockState(x, y, z);
        this.setBlockState(x, y, z, state ^ 8);
        this._playUiSound('click', x, y, z, true);
        this.emit('interact', descriptor);
        break;
      }
      default: {
        this.emit('interact', descriptor);
        if (entry.screen) this.emit('openScreen', entry.kind, x, y, z, blockId);
        this._playUiSound(entry.kind, x, y, z, true);
        break;
      }
    }

    this.placeCooldown = PLACE_COOLDOWN;
    const player = this.player;
    if (typeof player.swing === 'function') player.swing();
    return true;
  }

  /**
   * Item-specific right-click behaviour.
   * @param {?ItemStack} held the held stack
   * @returns {boolean} true when the item did something
   * @private
   */
  _useItem(held) {
    if (held === null || held.isEmpty()) return false;
    const item = itemDef(held.itemId);
    const name = item.name;

    const food = foodValue(held.itemId);
    if (food !== null) return this._startConsume(held, food);
    if (name === 'bucket') return this._fillBucket(held);
    if (name === 'water_bucket' || name === 'lava_bucket') return this._emptyBucket(held, name);
    if (name === 'flint_and_steel') return this._useFlintAndSteel(held);
    if (name === 'bone_meal') return this._useBoneMeal(held);
    if (item.toolType === 'hoe') return this._useHoe(held);
    if (item.toolType === 'shears') return this._useShears(held);
    return false;
  }

  /* -------------------------------------------------------------- eating -- */

  /**
   * Begin eating or drinking.
   * @param {ItemStack} held the held stack
   * @param {Object} food the food record from `game/items.js`
   * @returns {boolean} true when consumption started
   * @private
   */
  _startConsume(held, food) {
    const player = this.player;
    if (player.gameMode !== 'creative' && food.alwaysEdible !== true
      && num(player.hunger, 20) >= 20) {
      this.emit('message', 'Du bist satt.');
      return true;
    }
    this.eating = true;
    this.useTime = 0;
    this.useDuration = Math.max(0.2, num(food.eatTime, 1.6));
    this._useItemId = held.itemId;
    this.emit('useStart', held.itemId, this.useDuration);
    return true;
  }

  /**
   * Advance the eat/drink timer and finish when it is full.
   * @param {number} dt elapsed seconds
   * @returns {void}
   * @private
   */
  _tickConsume(dt) {
    const held = this._heldStack();
    if (held === null || held.itemId !== this._useItemId) {
      this._abortUse();
      return;
    }
    this.useTime += dt;

    const particles = this.particles;
    if (particles && typeof particles.spawn === 'function'
      && Math.floor(this.useTime / 0.2) !== Math.floor((this.useTime - dt) / 0.2)) {
      try {
        const eye = this.player.getEyePosition(this._origin);
        particles.spawn('dust', eye[0] + this._dir[0] * 0.4, eye[1] - 0.15 + this._dir[1] * 0.4,
          eye[2] + this._dir[2] * 0.4, { count: 3, speed: 0.8, life: 0.4 });
      } catch (err) {
        warnOnce('eatParticles', 'eating particles failed', err);
      }
    }

    if (this.useTime < this.useDuration) return;
    this._finishConsume(held);
  }

  /**
   * Apply a finished meal.
   * @param {ItemStack} held the consumed stack
   * @returns {void}
   * @private
   */
  _finishConsume(held) {
    const player = this.player;
    const itemId = held.itemId;
    const food = foodValue(itemId);
    this.eating = false;
    this.useTime = 0;
    this._useItemId = 0;
    if (food === null) return;

    let eaten = false;
    if (typeof player.eat === 'function') eaten = player.eat(itemId);
    else eaten = true;
    if (!eaten && player.gameMode !== 'creative') return;

    const inv = player.inventory;
    if (player.gameMode !== 'creative' && inv && typeof inv.consumeSelected === 'function') {
      inv.consumeSelected(1);
      if (food.container > 0 && typeof inv.addPickup === 'function') {
        inv.addPickup(new ItemStack(food.container, 1, null));
      }
    }

    const audio = this.audio;
    if (audio && typeof audio.play === 'function') {
      try {
        audio.play(food.drink ? 'drink' : 'eat', {
          x: player.position[0], y: player.position[1], z: player.position[2],
        });
      } catch (err) {
        warnOnce('eatSound', 'the eating sound failed', err);
      }
    }
    this.placeCooldown = PLACE_COOLDOWN;
    this.emit('eat', itemId);
  }

  /**
   * Cancel an item use in progress.
   * @returns {void}
   * @private
   */
  _abortUse() {
    if (!this.eating) return;
    this.eating = false;
    this.useTime = 0;
    this._useItemId = 0;
    this.emit('useCancel');
  }

  /* ------------------------------------------------------------- buckets -- */

  /**
   * Scoop a fluid source into an empty bucket.
   * @param {ItemStack} held the empty bucket
   * @returns {boolean} true when the bucket was filled
   * @private
   */
  _fillBucket(held) {
    const world = this.world;
    const player = this.player;
    const hit = world.raycast(this._origin, this._dir, this.getReach(), FLUID_RAY);
    if (hit === null || !isLiquid(hit.blockId)) return false;

    const filled = hit.blockId === B.LAVA ? 'lava_bucket' : 'water_bucket';
    const id = itemIdByName(filled);
    if (id <= 0) return false;

    if (player.gameMode !== 'creative') {
      world.setBlock(hit.x, hit.y, hit.z, 0);
      const inv = player.inventory;
      if (inv) {
        if (held.count > 1 && typeof inv.consumeSelected === 'function') {
          inv.consumeSelected(1);
          if (typeof inv.addPickup === 'function') inv.addPickup(new ItemStack(id, 1, null));
        } else if (typeof inv.set === 'function' && typeof inv.selectedSlot === 'number') {
          inv.set(inv.selectedSlot, new ItemStack(id, 1, null));
        }
      }
    }

    this._playUiSound('bucket_fill', hit.x, hit.y, hit.z, true);
    this.placeCooldown = PLACE_COOLDOWN;
    this.emit('useItem', held.itemId, hit.x, hit.y, hit.z);
    return true;
  }

  /**
   * Pour a filled bucket out into the world.
   * @param {ItemStack} held the filled bucket
   * @param {string} name `'water_bucket'` or `'lava_bucket'`
   * @returns {boolean} true when the fluid was placed
   * @private
   */
  _emptyBucket(held, name) {
    const hit = this.hit;
    const world = this.world;
    const player = this.player;
    if (hit === null) return false;

    const cell = this._targetCell(hit);
    const tx = cell[0];
    const ty = cell[1];
    const tz = cell[2];
    if (ty < WORLD_MIN_Y || ty >= WORLD_MAX_Y) return false;
    const existing = world.getBlock(tx, ty, tz);
    if (existing !== 0 && !isReplaceable(existing)) return false;

    const fluid = name === 'lava_bucket' ? B.LAVA : B.WATER;
    if (!world.setBlock(tx, ty, tz, fluid)) return false;

    if (player.gameMode !== 'creative') {
      const inv = player.inventory;
      const empty = itemIdByName('bucket');
      if (inv && typeof inv.set === 'function' && typeof inv.selectedSlot === 'number'
        && empty > 0) {
        inv.set(inv.selectedSlot, new ItemStack(empty, 1, null));
      }
    }

    this._playUiSound('bucket_empty', tx, ty, tz, true);
    this.placeCooldown = PLACE_COOLDOWN;
    this.emit('useItem', held.itemId, tx, ty, tz);
    return true;
  }

  /* -------------------------------------------------------------- tools --- */

  /**
   * Light TNT, or set the clicked face on fire when the world has a fire block.
   * @param {ItemStack} held the flint and steel
   * @returns {boolean} true when something was ignited
   * @private
   */
  _useFlintAndSteel(held) {
    const hit = this.hit;
    const world = this.world;
    if (hit === null) return false;

    if (B.TNT !== undefined && hit.blockId === B.TNT) {
      const entities = this.entities;
      world.setBlock(hit.x, hit.y, hit.z, 0);
      this.setBlockState(hit.x, hit.y, hit.z, 0);
      if (entities && typeof entities.primeTNT === 'function') {
        entities.primeTNT(hit.x, hit.y, hit.z, 4, 0);
      }
      this._damageHeld(1);
      this._playUiSound('ignite', hit.x, hit.y, hit.z, true);
      this.placeCooldown = PLACE_COOLDOWN;
      this.emit('useItem', held.itemId, hit.x, hit.y, hit.z);
      return true;
    }

    const fire = B.FIRE;
    if (!Number.isFinite(fire) || fire <= 0) {
      this._playUiSound('ignite', hit.x, hit.y, hit.z, true);
      this.placeCooldown = PLACE_COOLDOWN;
      return true;
    }
    const tx = hit.x + (hit.faceNormal[0] | 0);
    const ty = hit.y + (hit.faceNormal[1] | 0);
    const tz = hit.z + (hit.faceNormal[2] | 0);
    const existing = world.getBlock(tx, ty, tz);
    if (existing !== 0 && !isReplaceable(existing)) return false;
    if (!world.setBlock(tx, ty, tz, fire)) return false;
    this._damageHeld(1);
    this._playUiSound('ignite', tx, ty, tz, true);
    this.placeCooldown = PLACE_COOLDOWN;
    this.emit('useItem', held.itemId, tx, ty, tz);
    return true;
  }

  /**
   * Grow a crop by one stage, or sprinkle grass and flowers on a grass block.
   * @param {ItemStack} held the bone meal
   * @returns {boolean} true when something grew
   * @private
   */
  _useBoneMeal(held) {
    const hit = this.hit;
    const world = this.world;
    if (hit === null) return false;
    const def = blockDef(hit.blockId);

    const staged = /^(.*)_stage(\d+)$/.exec(def.name);
    if (staged !== null) {
      const next = blockByName(`${staged[1]}_stage${(staged[2] | 0) + 1}`);
      if (next.id === 0) {
        this.emit('message', 'Die Pflanze ist ausgewachsen.');
        return true;
      }
      world.setBlock(hit.x, hit.y, hit.z, next.id);
      this._consumeOne();
      this._boneMealParticles(hit.x, hit.y, hit.z);
      this.placeCooldown = PLACE_COOLDOWN;
      this.emit('useItem', held.itemId, hit.x, hit.y, hit.z);
      return true;
    }

    if (hit.blockId === B.GRASS_BLOCK) {
      const grass = blockByName('short_grass');
      let grown = 0;
      for (let i = 0; i < 12; i++) {
        const gx = hit.x + Math.floor(Math.random() * 5) - 2;
        const gz = hit.z + Math.floor(Math.random() * 5) - 2;
        const gy = hit.y + 1;
        if (world.getBlock(gx, gy, gz) !== 0) continue;
        if (world.getBlock(gx, gy - 1, gz) !== B.GRASS_BLOCK) continue;
        if (grass.id !== 0 && world.setBlock(gx, gy, gz, grass.id)) grown++;
      }
      if (grown === 0) return false;
      this._consumeOne();
      this._boneMealParticles(hit.x, hit.y + 1, hit.z);
      this.placeCooldown = PLACE_COOLDOWN;
      this.emit('useItem', held.itemId, hit.x, hit.y, hit.z);
      return true;
    }
    return false;
  }

  /**
   * The green sparkle of bone meal.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @returns {void}
   * @private
   */
  _boneMealParticles(x, y, z) {
    const particles = this.particles;
    if (!particles || typeof particles.spawn !== 'function') return;
    try {
      particles.spawn('spark', x + 0.5, y + 0.7, z + 0.5,
        { count: 12, speed: 0.9, life: 0.8, color: [0.35, 0.95, 0.3] });
    } catch (err) {
      warnOnce('boneMeal', 'bone meal particles failed', err);
    }
  }

  /**
   * Till dirt into farmland.
   * @param {ItemStack} held the hoe
   * @returns {boolean} true when a block was tilled
   * @private
   */
  _useHoe(held) {
    const hit = this.hit;
    const world = this.world;
    if (hit === null || hit.face === 3) return false;
    const def = blockDef(hit.blockId);
    if (!TILLABLE.has(def.name)) return false;
    if (world.getBlock(hit.x, hit.y + 1, hit.z) !== 0) return false;
    const farmland = B.FARMLAND;
    if (!Number.isFinite(farmland) || farmland <= 0) return false;
    if (!world.setBlock(hit.x, hit.y, hit.z, farmland)) return false;

    this._damageHeld(1);
    this._playUiSound('hoe', hit.x, hit.y, hit.z, true);
    if (typeof this.player.addExhaustion === 'function') this.player.addExhaustion(0.005);
    this.placeCooldown = PLACE_COOLDOWN;
    this.emit('useItem', held.itemId, hit.x, hit.y, hit.z);
    return true;
  }

  /**
   * Shear leaves, wool and vines: the block is harvested instantly with its
   * shear drop instead of its normal loot.
   * @param {ItemStack} held the shears
   * @returns {boolean} true when something was sheared
   * @private
   */
  _useShears(held) {
    const hit = this.hit;
    const world = this.world;
    if (hit === null) return false;
    const def = blockDef(hit.blockId);
    const kind = def.dropKind;
    if (kind !== 'leaves' && kind !== 'shear_only' && kind !== 'grass_plant'
      && kind !== 'cobweb') return false;

    const drops = blockDrops(hit.blockId, 'shears', TOOL_TIER.IRON);
    if (!world.setBlock(hit.x, hit.y, hit.z, 0)) return false;
    this.setBlockState(hit.x, hit.y, hit.z, 0);
    if (this.player.gameMode !== 'creative') {
      this._spawnDrops(hit.x, hit.y, hit.z, drops);
      this._damageHeld(1);
    }

    const particles = this.particles;
    if (particles && typeof particles.spawnBlockBreak === 'function') {
      try {
        particles.spawnBlockBreak(hit.x, hit.y, hit.z, hit.blockId);
      } catch (err) {
        warnOnce('shearParticles', 'shear particles failed', err);
      }
    }
    this._playUiSound('shear', hit.x, hit.y, hit.z, true);
    this.placeCooldown = PLACE_COOLDOWN;
    this.emit('useItem', held.itemId, hit.x, hit.y, hit.z);
    return true;
  }

  /* ===================================================================== */
  /* Pick block                                                             */
  /* ===================================================================== */

  /**
   * Copy the targeted block into the hotbar (middle click). In creative the
   * item is created if necessary; in survival the hotbar is only re-selected
   * when the item is already carried.
   * @returns {boolean} true when the hotbar changed or a slot was selected
   */
  pickBlock() {
    const hit = this.hit;
    const player = this.player;
    if (hit === null || player === null) return false;
    const inv = player.inventory;
    if (!inv) return false;

    const itemId = blockToItem(hit.blockId);
    if (itemId <= 0) return false;

    // Already in the hotbar? Just select it.
    if (typeof inv.hotbarSlotOf === 'function') {
      const slot = inv.hotbarSlotOf(itemId);
      if (slot >= 0) {
        if (typeof player.setSelectedSlot === 'function') player.setSelectedSlot(slot);
        else if (typeof inv.setSelected === 'function') inv.setSelected(slot);
        this.emit('pickBlock', itemId, slot);
        return true;
      }
    }
    if (player.gameMode !== 'creative') return false;

    let target = typeof inv.selected === 'number' ? inv.selected : 0;
    if (typeof inv.firstEmpty === 'function') {
      const empty = inv.firstEmpty(0, 8);
      if (empty >= 0) target = empty;
    }
    if (typeof inv.set === 'function') inv.set(target, new ItemStack(itemId, 1, null));
    if (typeof player.setSelectedSlot === 'function') player.setSelectedSlot(target);
    else if (typeof inv.setSelected === 'function') inv.setSelected(target);
    this.emit('pickBlock', itemId, target);
    return true;
  }

  /* ===================================================================== */
  /* Block state storage                                                    */
  /* ===================================================================== */

  /**
   * Orientation state of a block, `0` when it has none.
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @returns {number} block state
   */
  getBlockState(x, y, z) {
    const world = this.world;
    if (!world || typeof world.getChunk !== 'function') return 0;
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return 0;
    const chunk = world.getChunk(x >> 4, z >> 4);
    if (chunk === null || typeof chunk.getBlockEntity !== 'function') return 0;
    const record = chunk.getBlockEntity(x & 15, y, z & 15);
    if (record === null || record === undefined) return 0;
    return Number.isFinite(record.state) ? record.state | 0 : 0;
  }

  /**
   * Store the orientation state of a block. Passing `0` clears it (and the
   * whole record when nothing else is stored there).
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {number} state the new state
   * @returns {boolean} true when the state was written
   */
  setBlockState(x, y, z, state) {
    const world = this.world;
    if (!world || typeof world.getChunk !== 'function') return false;
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return false;
    const chunk = world.getChunk(x >> 4, z >> 4);
    if (chunk === null || typeof chunk.setBlockEntity !== 'function') return false;

    const lx = x & 15;
    const lz = z & 15;
    const value = state | 0;
    const record = chunk.getBlockEntity(lx, y, lz);

    if (value === 0) {
      if (record === null || record === undefined) return true;
      delete record.state;
      if (Object.keys(record).length === 0) chunk.removeBlockEntity(lx, y, lz);
      else chunk.setBlockEntity(lx, y, lz, record);
      return true;
    }
    const target = record === null || record === undefined ? {} : record;
    target.state = value;
    chunk.setBlockEntity(lx, y, lz, target);
    return true;
  }

  /* ===================================================================== */
  /* Helpers                                                                */
  /* ===================================================================== */

  /**
   * The stack in the player's selected hotbar slot.
   * @returns {?ItemStack} the held stack, or `null`
   * @private
   */
  _heldStack() {
    const player = this.player;
    if (player === null) return null;
    if (typeof player.getHeldItem === 'function') {
      const held = player.getHeldItem();
      return held === undefined ? null : held;
    }
    const inv = player.inventory;
    if (inv && typeof inv.getSelected === 'function') return inv.getSelected();
    return null;
  }

  /**
   * Wear the held item down by `amount` (survival only).
   * @param {number} amount durability points
   * @returns {void}
   * @private
   */
  _damageHeld(amount) {
    const player = this.player;
    if (player === null || player.gameMode === 'creative') return;
    const inv = player.inventory;
    if (inv && typeof inv.damageSelected === 'function') inv.damageSelected(amount);
  }

  /**
   * Consume one of the held items (survival only).
   * @returns {void}
   * @private
   */
  _consumeOne() {
    const player = this.player;
    if (player === null || player.gameMode === 'creative') return;
    const inv = player.inventory;
    if (inv && typeof inv.consumeSelected === 'function') inv.consumeSelected(1);
  }

  /**
   * Play a positional interaction sound, guarded.
   * @param {string} name sound name
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {boolean} open passed through as a pitch variation
   * @returns {void}
   * @private
   */
  _playUiSound(name, x, y, z, open) {
    const audio = this.audio;
    if (!audio || typeof audio.play !== 'function') return;
    try {
      audio.play(name, { x: x + 0.5, y: y + 0.5, z: z + 0.5, pitch: open ? 1 : 0.9 });
    } catch (err) {
      warnOnce(`sound:${name}`, `the "${name}" sound failed`, err);
    }
  }

  /**
   * Drop every reference and stop reacting to input.
   * @returns {void}
   */
  dispose() {
    this._disposed = true;
    this.enabled = false;
    this.hit = null;
    this.breakProgress = 0;
    this.eating = false;
    this._entityList.length = 0;
    this._interactive.clear();
    this.removeAllListeners();
    this.world = null;
    this.player = null;
    this.input = null;
    this.audio = null;
    this.particles = null;
    this.entities = null;
  }
}
