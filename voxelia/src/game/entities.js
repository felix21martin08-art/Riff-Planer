/**
 * @file game/entities.js — VOXELIA entity system (ARCHITECTURE.md section 5.34).
 *
 * Everything dynamic that is not the player lives here: dropped items, arrows,
 * experience orbs, primed TNT and falling sand. `game/mobs.js` builds on the
 * same {@link Entity} base and is stored in the same {@link EntityManager}.
 *
 * ============================================================================
 * DESIGN
 * ============================================================================
 * * **Fixed step.** Every `update(dt, world, ctx)` takes the elapsed seconds and
 *   integrates with it. The game ticks at 20 Hz (`dt = 0.05`), but nothing here
 *   assumes that number — the renderer interpolates between `prevPosition` and
 *   `position`, which is why `prevPosition` is refreshed at the top of every
 *   entity update and never anywhere else.
 * * **Physics comes from `game/physics.js`.** Entities never resolve collisions
 *   themselves; they configure `gravityScale`, `drag` and their box and let the
 *   swept solver do the work, so an entity can never tunnel through a wall.
 * * **Spatial hash.** {@link EntityManager} keeps a uniform grid keyed by block
 *   coordinates ({@link CELL_SIZE} blocks per cell) and maintains it
 *   incrementally, so `queryAABB`/`queryRadius` touch a handful of buckets
 *   instead of every entity. Item merging, explosions and mob AI all depend on
 *   this being cheap.
 * * **Merging matters.** Chopping a tree drops dozens of stacks a second; item
 *   entities absorb neighbours of the same kind within
 *   {@link ITEM_MERGE_RADIUS}, which keeps the entity count (and therefore the
 *   draw calls) flat instead of exploding.
 * * **Never throws.** Every entity update is wrapped; a broken entity is logged
 *   once and removed rather than killing the tick.
 *
 * ============================================================================
 * THE CONTEXT OBJECT
 * ============================================================================
 * `update(dt, world, ctx)` receives one shared, reused context record. Nothing
 * is mandatory — every field is probed before use:
 *
 * ```js
 * ctx = {
 *   manager,      // the EntityManager doing the tick (always set)
 *   world,        // the World (always set, may be null)
 *   player,       // the local player, or null
 *   particles,    // render/particles.js ParticleSystem, or null
 *   audio,        // game/audio.js AudioEngine, or null
 *   environment,  // game/environment.js Environment, or null
 *   combat,       // game/combat.js CombatSystem, or null
 *   time,         // world time in seconds
 *   dt            // seconds of this tick
 * }
 * ```
 *
 * @module game/entities
 */

import { AABB, clamp, mulberry32 } from '../core/math.js';
import { EventBus } from '../core/util.js';
import {
  GRAVITY,
  TERMINAL_VELOCITY,
  applyBuoyancy,
  applyDrag,
  applyGravity,
  applyMediumDrag,
  createMoveResult,
  isInLiquid,
  moveWithCollisions,
  resolveEntityPush,
} from './physics.js';
import {
  B,
  TOOL_TIER,
  blockDrops,
  getBlock,
  isReplaceable,
  isSolid,
} from '../world/blocks.js';
import { WORLD_MAX_Y, WORLD_MIN_Y } from '../world/chunk.js';
import { ItemStack } from './inventory.js';
import { blockToItem, itemIdByName } from './items.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/**
 * Edge length of one spatial-hash cell, in blocks. Four is a good compromise:
 * item merging (0.5 blocks) and mob awareness (up to 16 blocks) both stay
 * within a handful of buckets.
 * @type {number}
 */
export const CELL_SIZE = 4;

/**
 * Entities further than this from the player (in blocks) are frozen: they still
 * age (so despawn timers keep running) but run no physics at all.
 * @type {number}
 */
export const ENTITY_TICK_RADIUS = 96;

/**
 * Hard cap on simultaneously living entities. Spawning beyond it is refused so
 * a runaway TNT chain can never lock the tick up.
 * @type {number}
 */
export const MAX_ENTITIES = 4000;

/** Seconds a dropped item survives before it despawns (5 minutes). @type {number} */
export const ITEM_DESPAWN_TIME = 300;

/** Seconds a fresh drop refuses to be picked up. @type {number} */
export const ITEM_PICKUP_DELAY = 0.5;

/** Distance in blocks within which two identical drops merge. @type {number} */
export const ITEM_MERGE_RADIUS = 0.5;

/** Distance in blocks from which a drop flies towards the player. @type {number} */
export const ITEM_ATTRACT_RADIUS = 1.5;

/** Distance in blocks from which an experience orb flies towards the player. @type {number} */
export const XP_ATTRACT_RADIUS = 5.5;

/** Distance in blocks within which two experience orbs merge. @type {number} */
export const XP_MERGE_RADIUS = 0.5;

/** Largest value a single merged experience orb may carry. @type {number} */
export const XP_MERGE_LIMIT = 200;

/** Y below which an entity takes void damage. @type {number} */
export const VOID_LEVEL = WORLD_MIN_Y - 8;

/** Seconds an entity burns after leaving lava. @type {number} */
export const FIRE_DURATION = 8;

/** Seconds between two ticks of environmental (fire/lava/void) damage. @type {number} */
export const ENVIRONMENT_DAMAGE_INTERVAL = 0.5;

/** Default fuse of primed TNT in seconds (80 ticks). @type {number} */
export const TNT_FUSE = 4;

/** Default explosion power of primed TNT. @type {number} */
export const TNT_POWER = 4;

/** Seconds a falling block may travel before it gives up and drops as an item. @type {number} */
export const FALLING_BLOCK_MAX_AGE = 30;

/** Seconds an arrow stays stuck in a block before it despawns. @type {number} */
export const ARROW_STUCK_LIFETIME = 60;

/**
 * Damage source strings. They mirror `DAMAGE` in `game/combat.js` so a damage
 * event can be routed without a translation table.
 * @type {Readonly<Object<string, string>>}
 */
export const ENTITY_DAMAGE = Object.freeze({
  FALL: 'fall',
  LAVA: 'lava',
  FIRE: 'fire',
  VOID: 'void',
  EXPLOSION: 'explosion',
  ARROW: 'arrow',
  MOB: 'mob',
  PLAYER: 'player',
  GENERIC: 'generic',
});

/** Air drag rate of a loose object, in 1/s (≈ 0.98 per tick). @type {number} */
const LOOSE_DRAG = 0.4;

/** Air drag rate of an arrow, in 1/s (≈ 0.99 per tick). @type {number} */
const ARROW_DRAG = 0.2;

/** Knockback speed an explosion imparts per unit of impact, in blocks/s. @type {number} */
const EXPLOSION_KNOCKBACK = 14;

/** Step length of an explosion ray, in blocks. @type {number} */
const EXPLOSION_STEP = 0.3;

/** Intensity an explosion ray loses per step, independent of the blocks hit. @type {number} */
const EXPLOSION_DECAY = 0.225;

/** Grid resolution of the explosion ray cube (vanilla uses 16). @type {number} */
const EXPLOSION_RAYS = 16;

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/** Monotonic entity id source. @type {number} */
let nextId = 1;

/**
 * Allocate the next stable entity id. Ids are unique for the lifetime of the
 * page and are what the save file, the renderer's animation cache and every
 * `EntityManager` map key use.
 * @returns {number} a fresh id
 */
export function allocateEntityId() {
  return nextId++;
}

/**
 * Tell the id allocator about ids restored from a save so freshly spawned
 * entities never collide with them.
 * @param {number} id highest id seen in the save
 * @returns {void}
 */
export function reserveEntityId(id) {
  const v = Number(id);
  if (Number.isFinite(v) && v >= nextId) nextId = Math.floor(v) + 1;
}

/** Warnings already printed, so a broken entity logs once and not per tick. @type {Set<string>} */
const warned = new Set();

/**
 * Log a message exactly once per key.
 * @param {string} key dedupe key
 * @param {string} message text to print
 * @param {*} [detail] optional error or payload
 * @returns {void}
 */
function warnOnce(key, message, detail) {
  if (warned.has(key)) return;
  warned.add(key);
  if (detail !== undefined) console.warn(`[entities] ${message}`, detail);
  else console.warn(`[entities] ${message}`);
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
 * Hash three cell coordinates into one integer key. Collisions are harmless:
 * every query re-tests the real geometry, so a shared bucket can only produce
 * extra candidates, never a miss.
 * @param {number} cx cell X
 * @param {number} cy cell Y
 * @param {number} cz cell Z
 * @returns {number} 32 bit hash
 */
function cellHash(cx, cy, cz) {
  let h = Math.imul(cx | 0, 0x8da6b343);
  h ^= Math.imul(cy | 0, 0xd8163841);
  h ^= Math.imul(cz | 0, 0xcb1ab31f);
  h ^= h >>> 15;
  return h | 0;
}

/**
 * Blast resistance of a block. The block registry only stores hardness, so the
 * resistance is derived from it: unbreakable blocks are immune, and anything
 * else resists roughly three times its hardness (which reproduces the familiar
 * "TNT clears stone but not obsidian" behaviour).
 * @param {number} id block id
 * @returns {number} blast resistance, `Infinity` for indestructible blocks
 */
export function blastResistance(id) {
  const def = getBlock(id);
  if (def.id === 0) return 0;
  if (def.hardness < 0) return Infinity;
  if (def.liquid) return 100;
  return def.hardness * 3;
}

/** Scratch receiver for {@link bodyDistance}: `[distance, dx, dy, dz]`. @type {Float64Array} */
const BODY_PROBE = new Float64Array(4);

/**
 * Distance from a point to a player's *body* (the closest point on their
 * collision box), plus the direction towards the body centre.
 *
 * Measuring against the box instead of a single point is what makes pickup feel
 * right: a drop resting on the ground is only 0.1 blocks from the player's feet
 * but almost a full block from their chest.
 *
 * @param {Object} player anything with `position`, and optionally `width`/`height`
 * @param {number} x probe X
 * @param {number} y probe Y
 * @param {number} z probe Z
 * @returns {Float64Array} shared `[distance, dirX, dirY, dirZ]` (direction is
 *   normalized, or all zero when the point sits inside the box)
 */
function bodyDistance(player, x, y, z) {
  const out = BODY_PROBE;
  const pos = player.position;
  const height = Math.max(0.2, num(player.height, 1.8));
  const half = Math.max(0.05, num(player.width, 0.6)) * 0.5;
  const qx = clamp(x, pos[0] - half, pos[0] + half);
  const qy = clamp(y, pos[1], pos[1] + height);
  const qz = clamp(z, pos[2] - half, pos[2] + half);
  const dx = qx - x;
  const dy = qy - y;
  const dz = qz - z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  out[0] = dist;
  if (dist > 1e-6) {
    out[1] = dx / dist;
    out[2] = dy / dist;
    out[3] = dz / dist;
  } else {
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
  }
  return out;
}

/**
 * Build an {@link ItemStack} from whatever a caller passed in (a stack, a plain
 * `{itemId, count}` record or a serialised `{i, c}` pair).
 * @param {*} src stack-ish value
 * @returns {?ItemStack} a real stack, or `null` when nothing usable was given
 */
function toStack(src) {
  if (src === null || src === undefined) return null;
  if (src instanceof ItemStack) return src;
  if (typeof src === 'object') {
    const restored = ItemStack.deserialize(src);
    if (restored !== null) return restored;
    const itemId = num(src.itemId, 0) | 0;
    const count = num(src.count, 0) | 0;
    if (itemId > 0 && count > 0) return new ItemStack(itemId, count, src.meta ?? null);
  }
  return null;
}

/* ========================================================================== */
/* Entity                                                                     */
/* ========================================================================== */

/**
 * Base class of every dynamic object in the world.
 *
 * An entity is an axis-aligned box with a velocity. The base `update()` runs
 * gravity, medium drag, buoyancy, the swept world collision and the
 * environmental damage sources (lava, fire, void); subclasses add behaviour on
 * top and only rarely need to touch the physics themselves.
 */
export class Entity {
  /**
   * @param {string} type entity type name (`'item'`, `'arrow'`, `'zombie'`, …);
   *   `render/entities.js` picks the visual from this string
   * @param {number} x world X of the entity's centre
   * @param {number} y world Y of the entity's feet
   * @param {number} z world Z of the entity's centre
   */
  constructor(type, x, y, z) {
    /** @type {number} Stable unique id. */
    this.id = allocateEntityId();
    /** @type {string} Type name, also the renderer's visual key. */
    this.type = typeof type === 'string' && type.length > 0 ? type : 'entity';

    /** @type {Float32Array} `[x, y, z]`, X/Z centred, Y at the feet. */
    this.position = new Float32Array([num(x, 0), num(y, 0), num(z, 0)]);
    /** @type {Float32Array} Position at the start of the current tick (render lerp). */
    this.prevPosition = new Float32Array(this.position);
    /** @type {Float32Array} Velocity in blocks/s. */
    this.velocity = new Float32Array(3);
    /** @type {Float32Array} `[yaw, pitch, roll]` in radians. */
    this.rotation = new Float32Array(3);

    /** @type {number} Full width along X and Z, in blocks. */
    this.width = 0.6;
    /** @type {number} Height along Y, in blocks. */
    this.height = 1.8;
    /** @type {AABB} Collision box, always in sync with {@link Entity#position}. */
    this.aabb = new AABB();

    /** @type {boolean} Standing on solid ground. */
    this.onGround = false;
    /** @type {boolean} Skip world collision entirely. */
    this.noClip = false;
    /** @type {boolean} Opt out of {@link resolveEntityPush}. */
    this.noPush = false;
    /** @type {number} Gravity multiplier (`0` floats, `1` is a normal body). */
    this.gravityScale = 1;
    /** @type {number} Horizontal air drag rate in 1/s. */
    this.drag = LOOSE_DRAG;
    /** @type {number} Vertical air drag rate in 1/s. */
    this.dragY = LOOSE_DRAG * 0.25;

    /** @type {number} Current health in half-hearts. */
    this.health = 10;
    /** @type {number} Maximum health in half-hearts. */
    this.maxHealth = 10;
    /** @type {boolean} Health reached zero; the death animation is playing. */
    this.dead = false;
    /** @type {boolean} Scheduled for removal at the end of the tick. */
    this.removed = false;
    /** @type {?string} Why the entity was removed (`'killed'`, `'despawn'`, …). */
    this.removeReason = null;

    /** @type {number} Seconds since the entity spawned. */
    this.age = 0;
    /** @type {number} Seconds the hurt flash still lasts. */
    this.hurtTime = 0;
    /** @type {number} Seconds of remaining damage immunity. */
    this.invulnerableTime = 0;
    /** @type {number} Seconds the death animation has been running. */
    this.deathTime = 0;
    /** @type {number} Seconds the entity keeps burning. */
    this.fireTime = 0;
    /** @type {boolean} Immune to fire and lava. */
    this.fireProof = false;
    /** @type {boolean} Ignores void, lava and fire damage entirely. */
    this.invulnerable = false;
    /** @type {number} Blocks fallen since the last time the entity was grounded. */
    this.fallDistance = 0;
    /** @type {number} Seconds until the entity despawns (`0` = never). */
    this.despawnTime = 0;

    /** @type {boolean} Any part of the box is inside water. */
    this.inWater = false;
    /** @type {boolean} Any part of the box is inside lava. */
    this.inLava = false;
    /** @type {number} Submerged volume fraction `0..1`. */
    this.submerged = 0;
    /** @type {boolean} The manager skipped this entity because it is far away. */
    this.frozen = false;

    /** @type {?EntityManager} Owning manager, set by {@link EntityManager#spawn}. */
    this.manager = null;

    /** @type {{water:boolean, lava:boolean, submerged:number}} Liquid probe scratch. @private */
    this._liquid = { water: false, lava: false, submerged: 0 };
    /** @type {Object} Physics result scratch. @private */
    this._move = createMoveResult();
    /** @type {{stepHeight:number, autoStep:boolean, sneaking:boolean, onGround:boolean}} @private */
    this._moveOpts = { stepHeight: 0, autoStep: false, sneaking: false, onGround: false };
    /** @type {number} Seconds since the last environmental damage tick. @private */
    this._envTimer = 0;
    /** @type {number} Spatial hash key, `NaN` while the entity is not indexed. @private */
    this._cell = NaN;

    this.syncAABB();
  }

  /* ---------------------------------------------------------------- shape -- */

  /**
   * Yaw in radians (`rotation[0]`). Kept as a property because
   * `render/entities.js` reads `entity.yaw` directly.
   * @returns {number} yaw
   */
  get yaw() {
    return this.rotation[0];
  }

  /**
   * @param {number} v new yaw in radians
   */
  set yaw(v) {
    this.rotation[0] = num(v, 0);
  }

  /**
   * Pitch in radians (`rotation[1]`).
   * @returns {number} pitch
   */
  get pitch() {
    return this.rotation[1];
  }

  /**
   * @param {number} v new pitch in radians
   */
  set pitch(v) {
    this.rotation[1] = num(v, 0);
  }

  /**
   * Resize the collision box, keeping the feet where they are.
   * @param {number} width full width along X and Z
   * @param {number} height height along Y
   * @returns {Entity} `this`
   */
  setSize(width, height) {
    this.width = Math.max(0.01, num(width, 0.6));
    this.height = Math.max(0.01, num(height, 1.8));
    this.syncAABB();
    return this;
  }

  /**
   * Teleport the entity, resetting the interpolation so the renderer does not
   * draw a streak across the world.
   * @param {number} x world X
   * @param {number} y world Y of the feet
   * @param {number} z world Z
   * @returns {Entity} `this`
   */
  setPosition(x, y, z) {
    this.position[0] = num(x, this.position[0]);
    this.position[1] = num(y, this.position[1]);
    this.position[2] = num(z, this.position[2]);
    this.prevPosition.set(this.position);
    this.syncAABB();
    if (this.manager !== null) this.manager.reindex(this);
    return this;
  }

  /**
   * Add to the velocity, clamped so a bad impulse cannot launch the entity out
   * of the world.
   * @param {number} x blocks/s along X
   * @param {number} y blocks/s along Y
   * @param {number} z blocks/s along Z
   * @returns {Entity} `this`
   */
  addVelocity(x, y, z) {
    const v = this.velocity;
    v[0] = clamp(v[0] + num(x, 0), -TERMINAL_VELOCITY, TERMINAL_VELOCITY);
    v[1] = clamp(v[1] + num(y, 0), -TERMINAL_VELOCITY, TERMINAL_VELOCITY);
    v[2] = clamp(v[2] + num(z, 0), -TERMINAL_VELOCITY, TERMINAL_VELOCITY);
    return this;
  }

  /**
   * Rebuild {@link Entity#aabb} from the position and the box size.
   * @returns {void}
   */
  syncAABB() {
    this.aabb.setFromEntity(this.position[0], this.position[1], this.position[2],
      this.width, this.height);
  }

  /**
   * Copy the resolved box back into the position vector.
   * @returns {void}
   * @private
   */
  _syncPositionFromAABB() {
    const b = this.aabb;
    this.position[0] = (b.minX + b.maxX) * 0.5;
    this.position[1] = b.minY;
    this.position[2] = (b.minZ + b.maxZ) * 0.5;
  }

  /**
   * World-space centre of the box.
   * @param {Float32Array|number[]} [out] receiver
   * @returns {Float32Array|number[]} `[x, y, z]` of the centre
   */
  getCenter(out = [0, 0, 0]) {
    out[0] = this.position[0];
    out[1] = this.position[1] + this.height * 0.5;
    out[2] = this.position[2];
    return out;
  }

  /**
   * Squared distance from the entity's centre to a point.
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @returns {number} squared distance in blocks²
   */
  distanceSqTo(x, y, z) {
    const dx = this.position[0] - x;
    const dy = (this.position[1] + this.height * 0.5) - y;
    const dz = this.position[2] - z;
    return dx * dx + dy * dy + dz * dz;
  }

  /* ----------------------------------------------------------------- tick -- */

  /**
   * Advance the entity by `dt` seconds.
   *
   * Subclasses normally call `super.update(dt, world, ctx)` first and then add
   * their own behaviour; overriding it entirely is fine for entities that do
   * not want the default physics (arrows do exactly that).
   *
   * @param {number} dt elapsed seconds
   * @param {Object} world the `world/world.js` World
   * @param {Object} [ctx] shared context (see the module header)
   * @returns {void}
   */
  update(dt, world, ctx) {
    this.prevPosition.set(this.position);
    if (this.removed) return;
    const step = clamp(num(dt, 0), 0, 0.25);
    this.age += step;

    if (this.hurtTime > 0) this.hurtTime = Math.max(0, this.hurtTime - step);
    if (this.invulnerableTime > 0) this.invulnerableTime = Math.max(0, this.invulnerableTime - step);

    if (this.dead) {
      this.deathTime += step;
      if (this.deathTime >= 0.6) this.remove('dead');
      return;
    }

    this.updatePhysics(step, world);
    this.updateEnvironment(step, world, ctx);

    if (this.despawnTime > 0 && this.age >= this.despawnTime) this.remove('despawn');
  }

  /**
   * Gravity, drag, buoyancy and the swept world collision.
   * @param {number} dt elapsed seconds
   * @param {Object} world the World
   * @returns {void}
   */
  updatePhysics(dt, world) {
    if (dt <= 0) return;
    const v = this.velocity;

    if (!world || typeof world.getCollisionAABBs !== 'function') {
      // No world (or a stub): integrate ballistically so nothing freezes.
      if (this.gravityScale !== 0) applyGravity(v, dt, GRAVITY * this.gravityScale, TERMINAL_VELOCITY);
      this.position[0] += v[0] * dt;
      this.position[1] += v[1] * dt;
      this.position[2] += v[2] * dt;
      this.syncAABB();
      return;
    }

    const liquid = isInLiquid(world, this.aabb, this._liquid);
    this.inWater = liquid.water;
    this.inLava = liquid.lava;
    this.submerged = liquid.submerged;

    if (this.gravityScale !== 0) {
      const scale = liquid.submerged > 0 ? this.gravityScale * 0.4 : this.gravityScale;
      applyGravity(v, dt, GRAVITY * scale, TERMINAL_VELOCITY);
    }
    if (liquid.submerged > 0) applyBuoyancy(v, dt, liquid.submerged, liquid.lava && !liquid.water);

    if (liquid.lava) applyMediumDrag(v, dt, 'lava', liquid.submerged);
    else if (liquid.water) applyMediumDrag(v, dt, 'water', liquid.submerged);
    else applyDrag(v, dt, this.drag, this.dragY);

    if (this.noClip) {
      this.position[0] += v[0] * dt;
      this.position[1] += v[1] * dt;
      this.position[2] += v[2] * dt;
      this.syncAABB();
      this.onGround = false;
      return;
    }

    const opts = this._moveOpts;
    opts.onGround = this.onGround;
    const res = moveWithCollisions(world, this.aabb, v, dt, this._move, opts);
    this._syncPositionFromAABB();

    const wasOnGround = this.onGround;
    this.onGround = res.onGround;
    if (res.onGround) {
      if (!wasOnGround && this.fallDistance > 0) this.onLand(this.fallDistance, res.impactY);
      this.fallDistance = 0;
    } else if (v[1] < 0) {
      this.fallDistance += -v[1] * dt;
    }

    if (res.hitX) this.onCollide(res.impactX > 0 ? 0 : 1);
    if (res.hitY) this.onCollide(res.impactY > 0 ? 2 : 3);
    if (res.hitZ) this.onCollide(res.impactZ > 0 ? 4 : 5);
  }

  /**
   * Fire, lava and void damage, plus the "stuck outside the world" guard.
   * @param {number} dt elapsed seconds
   * @param {Object} world the World
   * @param {Object} [ctx] shared context
   * @returns {void}
   */
  updateEnvironment(dt, world, ctx) {
    if (this.invulnerable) {
      this.fireTime = 0;
      return;
    }

    if (this.inLava && !this.fireProof) this.fireTime = FIRE_DURATION;
    if (this.fireTime > 0) this.fireTime = Math.max(0, this.fireTime - dt);

    this._envTimer += dt;
    if (this._envTimer < ENVIRONMENT_DAMAGE_INTERVAL) return;
    this._envTimer -= ENVIRONMENT_DAMAGE_INTERVAL;

    const y = this.position[1];
    if (y < VOID_LEVEL) {
      this.damage(4, ENTITY_DAMAGE.VOID, ctx);
      return;
    }
    if (y > WORLD_MAX_Y + 256) {
      // Something launched it out of the sky box; drop it back in.
      this.velocity[1] = Math.min(this.velocity[1], 0);
    }
    if (this.fireProof) return;
    if (this.inLava) this.damage(2, ENTITY_DAMAGE.LAVA, ctx);
    else if (this.fireTime > 0) this.damage(0.5, ENTITY_DAMAGE.FIRE, ctx);
  }

  /* ----------------------------------------------------------------- hooks -- */

  /**
   * Called for every axis that collided during the last move.
   * @param {number} face face direction that was hit (`0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z`)
   * @returns {void}
   */
  onCollide(face) {
    void face;
  }

  /**
   * Called on the tick the entity touches the ground after a fall.
   * @param {number} distance blocks fallen
   * @param {number} impactY vertical speed at the moment of impact, in blocks/s
   * @returns {void}
   */
  onLand(distance, impactY) {
    void distance;
    void impactY;
  }

  /* ---------------------------------------------------------------- damage -- */

  /**
   * Hurt the entity.
   * @param {number} amount damage in half-hearts
   * @param {string} [source] a {@link ENTITY_DAMAGE} value
   * @param {Object} [ctx] shared context, used to emit the hurt event
   * @returns {boolean} true when the damage was applied
   */
  damage(amount, source = ENTITY_DAMAGE.GENERIC, ctx = null) {
    const value = num(amount, 0);
    if (this.dead || this.removed || this.invulnerable || value <= 0) return false;
    if (this.invulnerableTime > 0) return false;

    this.health -= value;
    this.hurtTime = 0.5;
    this.invulnerableTime = 0.5;

    const manager = this.manager;
    if (manager !== null) manager.emit('entityHurt', this, value, source);
    void ctx;

    if (this.health <= 0) {
      this.health = 0;
      this.kill(source);
    }
    return true;
  }

  /**
   * Restore health, never above {@link Entity#maxHealth}.
   * @param {number} amount half-hearts to restore
   * @returns {void}
   */
  heal(amount) {
    const value = num(amount, 0);
    if (this.dead || value <= 0) return;
    this.health = Math.min(this.maxHealth, this.health + value);
  }

  /**
   * Kill the entity: it plays its death animation for a moment and is then
   * removed. Subclasses drop their loot by overriding {@link Entity#onDeath}.
   * @param {string} [source] a {@link ENTITY_DAMAGE} value
   * @returns {void}
   */
  kill(source = ENTITY_DAMAGE.GENERIC) {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.deathTime = 0;
    try {
      this.onDeath(source);
    } catch (err) {
      warnOnce(`death:${this.type}`, `onDeath of "${this.type}" failed`, err);
    }
    if (this.manager !== null) this.manager.emit('entityDeath', this, source);
  }

  /**
   * Hook for loot and death effects.
   * @param {string} source a {@link ENTITY_DAMAGE} value
   * @returns {void}
   */
  onDeath(source) {
    void source;
  }

  /**
   * Mark the entity for removal; the manager reaps it at the end of the tick.
   * @param {string} [reason] free-form reason, kept for the event listeners
   * @returns {void}
   */
  remove(reason = 'removed') {
    if (this.removed) return;
    this.removed = true;
    this.removeReason = reason;
  }

  /* ------------------------------------------------------------- persistence -- */

  /**
   * Write the fields every entity shares into a save record.
   * @param {Object} out target record
   * @returns {Object} `out`
   * @protected
   */
  writeBaseState(out) {
    out.type = this.type;
    out.id = this.id;
    out.p = [this.position[0], this.position[1], this.position[2]];
    out.v = [this.velocity[0], this.velocity[1], this.velocity[2]];
    out.r = [this.rotation[0], this.rotation[1], this.rotation[2]];
    out.hp = this.health;
    out.maxHp = this.maxHealth;
    out.age = this.age;
    if (this.fireTime > 0) out.fire = this.fireTime;
    return out;
  }

  /**
   * Restore the shared fields from a save record.
   * @param {Object} o save record produced by {@link Entity#serialize}
   * @returns {Entity} `this`
   * @protected
   */
  readBaseState(o) {
    if (!o || typeof o !== 'object') return this;
    const p = Array.isArray(o.p) ? o.p : null;
    if (p) {
      this.position[0] = num(p[0], this.position[0]);
      this.position[1] = num(p[1], this.position[1]);
      this.position[2] = num(p[2], this.position[2]);
    }
    const v = Array.isArray(o.v) ? o.v : null;
    if (v) {
      this.velocity[0] = num(v[0], 0);
      this.velocity[1] = num(v[1], 0);
      this.velocity[2] = num(v[2], 0);
    }
    const r = Array.isArray(o.r) ? o.r : null;
    if (r) {
      this.rotation[0] = num(r[0], 0);
      this.rotation[1] = num(r[1], 0);
      this.rotation[2] = num(r[2], 0);
    }
    this.maxHealth = Math.max(1, num(o.maxHp, this.maxHealth));
    this.health = clamp(num(o.hp, this.health), 0, this.maxHealth);
    this.age = Math.max(0, num(o.age, 0));
    this.fireTime = Math.max(0, num(o.fire, 0));
    if (Number.isFinite(o.id)) {
      this.id = o.id | 0;
      reserveEntityId(this.id);
    }
    this.prevPosition.set(this.position);
    this.syncAABB();
    return this;
  }

  /**
   * Plain, structured-clone friendly save record.
   * @returns {Object} the record
   */
  serialize() {
    return this.writeBaseState({});
  }

  /**
   * Rebuild an entity from {@link Entity#serialize} output, dispatching on the
   * stored `type` through the class registry.
   * @param {Object} o save record
   * @returns {?Entity} the entity, or `null` when the record is unusable
   */
  static deserialize(o) {
    if (!o || typeof o !== 'object') return null;
    const type = typeof o.type === 'string' ? o.type : 'entity';
    const cls = ENTITY_CLASSES.get(type);
    if (cls !== undefined && cls !== Entity
      && typeof cls.deserialize === 'function' && cls.deserialize !== Entity.deserialize) {
      try {
        return cls.deserialize(o);
      } catch (err) {
        warnOnce(`deserialize:${type}`, `could not restore a "${type}"`, err);
        return null;
      }
    }
    const p = Array.isArray(o.p) ? o.p : [0, 0, 0];
    const entity = new Entity(type, num(p[0], 0), num(p[1], 0), num(p[2], 0));
    return entity.readBaseState(o);
  }
}

/* ========================================================================== */
/* ItemEntity                                                                 */
/* ========================================================================== */

/**
 * A dropped item stack lying in the world.
 *
 * Bobs and spins (the renderer animates that from the entity id), refuses to be
 * picked up for {@link ITEM_PICKUP_DELAY}, flies towards a player within
 * {@link ITEM_ATTRACT_RADIUS}, absorbs identical drops within
 * {@link ITEM_MERGE_RADIUS} and despawns after {@link ITEM_DESPAWN_TIME}.
 */
export class ItemEntity extends Entity {
  /**
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {ItemStack|{itemId:number, count:number}} stack the dropped stack
   */
  constructor(x, y, z, stack) {
    super('item', x, y, z);
    this.setSize(0.25, 0.25);

    /** @type {ItemStack} The stack this drop carries. */
    this.stack = toStack(stack) ?? new ItemStack(0, 0, null);
    /** @type {number} Seconds before the drop may be picked up. */
    this.pickupDelay = ITEM_PICKUP_DELAY;
    /** @type {number} Id of the entity that may not pick this up yet (`0` = anyone). */
    this.ownerId = 0;

    this.health = 5;
    this.maxHealth = 5;
    this.gravityScale = 1;
    this.drag = LOOSE_DRAG;
    this.dragY = LOOSE_DRAG * 0.25;
    this.noPush = true;
    this.despawnTime = ITEM_DESPAWN_TIME;

    /** @type {number} Seconds until the next merge scan. @private */
    this._mergeTimer = 0.25 + (this.id % 5) * 0.05;
  }

  /**
   * @param {number} dt elapsed seconds
   * @param {Object} world the World
   * @param {Object} [ctx] shared context
   * @returns {void}
   */
  update(dt, world, ctx) {
    super.update(dt, world, ctx);
    if (this.removed || this.dead) return;

    const step = clamp(num(dt, 0), 0, 0.25);
    if (this.pickupDelay > 0) this.pickupDelay = Math.max(0, this.pickupDelay - step);

    if (this.stack === null || this.stack.isEmpty()) {
      this.remove('empty');
      return;
    }

    this._mergeTimer -= step;
    if (this._mergeTimer <= 0) {
      this._mergeTimer = 0.5;
      this.tryMerge();
    }

    const player = ctx && ctx.player ? ctx.player : null;
    if (player !== null && this.pickupDelay <= 0) this._followAndPickUp(step, player, ctx);
  }

  /**
   * Fly towards a nearby player and hand the stack over on contact.
   * @param {number} dt elapsed seconds
   * @param {Object} player the local player
   * @param {Object} [ctx] shared context
   * @returns {void}
   * @private
   */
  _followAndPickUp(dt, player, ctx) {
    const pos = player.position;
    if (!pos || pos.length < 3) return;
    if (player.dead === true || player.gameMode === 'spectator') return;

    const probe = bodyDistance(player, this.position[0], this.position[1] + this.height * 0.5,
      this.position[2]);
    const dist = probe[0];
    if (dist > ITEM_ATTRACT_RADIUS) return;
    if (dist <= 0.4) {
      this._pickUp(player, ctx);
      return;
    }

    // Accelerate towards the player, stronger the closer it gets.
    const pull = 26 * dt * (1 - dist / ITEM_ATTRACT_RADIUS);
    const v = this.velocity;
    v[0] += probe[1] * pull;
    v[1] += probe[2] * pull * 0.7 + 1.4 * dt;
    v[2] += probe[3] * pull;
  }

  /**
   * Move the stack into the player's inventory.
   * @param {Object} player the local player
   * @param {Object} [ctx] shared context
   * @returns {boolean} true when at least one item was picked up
   * @private
   */
  _pickUp(player, ctx) {
    const inv = player.inventory;
    if (!inv) return false;

    let leftover = null;
    const before = this.stack.count;
    try {
      if (typeof inv.addPickup === 'function') leftover = inv.addPickup(this.stack);
      else if (typeof inv.add === 'function') leftover = inv.add(this.stack);
      else return false;
    } catch (err) {
      warnOnce('pickup', 'inventory refused a pickup', err);
      return false;
    }

    const taken = before - (leftover === null ? 0 : leftover.count);
    if (taken <= 0) return false;

    const manager = this.manager;
    if (leftover === null || leftover.isEmpty()) {
      this.stack = new ItemStack(0, 0, null);
      this.remove('pickup');
    } else {
      this.stack = leftover;
    }

    if (manager !== null) manager.emit('itemPickup', this, player, taken);
    const audio = ctx && ctx.audio ? ctx.audio : null;
    if (audio && typeof audio.play === 'function') {
      try {
        audio.play('item_pickup', {
          x: this.position[0], y: this.position[1], z: this.position[2],
          pitch: 1.6 + Math.random() * 0.3, volume: 0.25,
        });
      } catch (err) {
        warnOnce('pickupSound', 'the pickup sound failed', err);
      }
    }
    return true;
  }

  /**
   * Absorb identical drops that lie within {@link ITEM_MERGE_RADIUS}.
   *
   * Only the entity with the lower id merges, so a pair is never processed
   * twice and the surviving drop is always the older one.
   * @returns {number} how many items were absorbed
   */
  tryMerge() {
    const manager = this.manager;
    if (manager === null || this.removed || this.stack.isEmpty()) return 0;
    const limit = this.stack.maxStack;
    if (this.stack.count >= limit) return 0;

    const found = manager.queryRadius(this.position[0], this.position[1] + 0.125,
      this.position[2], ITEM_MERGE_RADIUS, manager.scratchList());
    let absorbed = 0;
    for (let i = 0; i < found.length; i++) {
      const other = found[i];
      if (other === this || !(other instanceof ItemEntity)) continue;
      if (other.removed || other.dead || other.stack.isEmpty()) continue;
      if (other.id < this.id) continue;
      if (!this.stack.canStackWith(other.stack)) continue;

      const space = limit - this.stack.count;
      if (space <= 0) break;
      const move = Math.min(space, other.stack.count);
      if (move <= 0) continue;

      this.stack.count += move;
      other.stack.count -= move;
      absorbed += move;
      // The absorbed drop keeps the longer remaining life of the two.
      this.age = Math.min(this.age, other.age);
      this.pickupDelay = Math.max(this.pickupDelay, other.pickupDelay);
      if (other.stack.count <= 0) other.remove('merged');
    }
    if (absorbed > 0 && manager !== null) manager.emit('itemMerged', this, absorbed);
    return absorbed;
  }

  /**
   * @returns {Object} save record
   */
  serialize() {
    const out = this.writeBaseState({});
    out.stack = this.stack.serialize();
    out.pickupDelay = this.pickupDelay;
    return out;
  }

  /**
   * @param {Object} o save record
   * @returns {?ItemEntity} the restored drop
   */
  static deserialize(o) {
    if (!o || typeof o !== 'object') return null;
    const p = Array.isArray(o.p) ? o.p : [0, 0, 0];
    const stack = toStack(o.stack);
    if (stack === null) return null;
    const e = new ItemEntity(num(p[0], 0), num(p[1], 0), num(p[2], 0), stack);
    e.readBaseState(o);
    e.pickupDelay = Math.max(0, num(o.pickupDelay, 0));
    return e;
  }
}

/* ========================================================================== */
/* ArrowEntity                                                                */
/* ========================================================================== */

/**
 * A flying arrow.
 *
 * Arrows do not use the box solver: they trace their own segment through the
 * world every tick, which keeps the trajectory exact at 60 blocks/s and lets
 * them stick into the precise face they hit. Damage scales with the speed at
 * impact; a critical arrow (one fired from a fully drawn bow while falling)
 * adds a random bonus.
 */
export class ArrowEntity extends Entity {
  /**
   * @param {number} x world X of the tip
   * @param {number} y world Y of the tip
   * @param {number} z world Z of the tip
   * @param {{velocity?:ArrayLike<number>, damage?:number, critical?:boolean,
   *   shooterId?:number, knockback?:number, fire?:boolean}} [opts] launch options
   */
  constructor(x, y, z, opts = {}) {
    super('arrow', x, y, z);
    this.setSize(0.25, 0.25);

    this.health = 1;
    this.maxHealth = 1;
    this.gravityScale = 0.625; // 20 blocks/s², the classic arrow arc
    this.drag = ARROW_DRAG;
    this.dragY = ARROW_DRAG;
    this.noPush = true;
    this.despawnTime = 0;

    /** @type {number} Base damage per block/tick of speed. */
    this.baseDamage = Math.max(0, num(opts.damage, 2));
    /** @type {boolean} Critical hit: adds a random damage bonus and particles. */
    this.critical = opts.critical === true;
    /** @type {number} Id of the shooter; it cannot be hit for the first moments. */
    this.shooterId = num(opts.shooterId, 0) | 0;
    /** @type {number} Extra knockback levels (Punch enchantment). */
    this.knockback = Math.max(0, num(opts.knockback, 0));
    /** @type {boolean} Sets its target on fire (Flame enchantment). */
    this.flaming = opts.fire === true;
    /** @type {boolean} True once the arrow is stuck in a block. */
    this.inGround = false;
    /** @type {number} Seconds spent stuck in a block. */
    this.stuckTime = 0;
    /** @type {number} Block the arrow is stuck in, `0` while flying. */
    this.stuckBlock = 0;
    /** @type {boolean} Can the arrow be picked up again? */
    this.pickupable = true;

    const v = opts.velocity;
    if (v && v.length >= 3) {
      this.velocity[0] = num(v[0], 0);
      this.velocity[1] = num(v[1], 0);
      this.velocity[2] = num(v[2], 0);
    }
    this._updateRotation();
  }

  /**
   * Point the arrow model along its velocity.
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
   * Current speed in blocks per second.
   * @returns {number} speed
   */
  getSpeed() {
    const v = this.velocity;
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  }

  /**
   * Damage this arrow would deal right now: vanilla's
   * `ceil(speedPerTick * baseDamage)` plus the critical bonus.
   * @returns {number} damage in half-hearts
   */
  getDamage() {
    const perTick = clamp(this.getSpeed() / 20, 0, 12);
    let dmg = Math.ceil(perTick * this.baseDamage);
    if (dmg < 1) dmg = 1;
    if (this.critical) dmg += Math.floor(Math.random() * (dmg / 2 + 1));
    return dmg;
  }

  /**
   * @param {number} dt elapsed seconds
   * @param {Object} world the World
   * @param {Object} [ctx] shared context
   * @returns {void}
   */
  update(dt, world, ctx) {
    this.prevPosition.set(this.position);
    if (this.removed) return;
    const step = clamp(num(dt, 0), 0, 0.25);
    this.age += step;

    if (this.inGround) {
      this.stuckTime += step;
      // The block it was stuck in got mined: fall again.
      if (world && typeof world.getBlock === 'function') {
        const bx = Math.floor(this.position[0]);
        const by = Math.floor(this.position[1]);
        const bz = Math.floor(this.position[2]);
        const id = world.getBlock(bx, by, bz);
        if (id !== this.stuckBlock && !isSolid(id)) {
          this.inGround = false;
          this.stuckTime = 0;
          this.velocity[1] = -1;
        }
      }
      if (this.stuckTime >= ARROW_STUCK_LIFETIME) this.remove('despawn');
      return;
    }

    const v = this.velocity;
    applyGravity(v, step, GRAVITY * this.gravityScale, TERMINAL_VELOCITY);
    applyDrag(v, step, this.drag, this.dragY);

    const dx = v[0] * step;
    const dy = v[1] * step;
    const dz = v[2] * step;
    const travel = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (travel > 1e-6) {
      const hitEntity = this._sweepEntities(dx, dy, dz, travel, ctx);
      if (hitEntity !== null) {
        this._onEntityHit(hitEntity, ctx);
        return;
      }
      const blockHit = this._traceBlocks(world, dx, dy, dz, travel);
      if (blockHit !== null) {
        this._stick(blockHit, ctx);
        return;
      }
    }

    this.position[0] += dx;
    this.position[1] += dy;
    this.position[2] += dz;
    this.syncAABB();
    this._updateRotation();

    const liquid = world && typeof world.getBlock === 'function'
      ? isInLiquid(world, this.aabb, this._liquid) : null;
    if (liquid !== null && liquid.submerged > 0) {
      applyMediumDrag(v, step, liquid.lava ? 'lava' : 'water', liquid.submerged);
      this.inWater = liquid.water;
      this.inLava = liquid.lava;
      if (liquid.lava) this.remove('burned');
    }

    if (this.critical && ctx && ctx.particles && typeof ctx.particles.spawn === 'function') {
      try {
        ctx.particles.spawn('crit', this.position[0], this.position[1], this.position[2],
          { count: 1, speed: 0.3, life: 0.35 });
      } catch (err) {
        warnOnce('arrowParticles', 'crit particles failed', err);
      }
    }

    if (this.age > 120 || this.position[1] < VOID_LEVEL) this.remove('despawn');
  }

  /**
   * Find the first entity the arrow's segment crosses this tick.
   * @param {number} dx displacement X
   * @param {number} dy displacement Y
   * @param {number} dz displacement Z
   * @param {number} travel length of the displacement
   * @param {Object} [ctx] shared context
   * @returns {?Entity} the entity that was hit, or `null`
   * @private
   */
  _sweepEntities(dx, dy, dz, travel, ctx) {
    const manager = this.manager;
    if (manager === null) return null;
    const ox = this.position[0];
    const oy = this.position[1];
    const oz = this.position[2];

    const box = manager.scratchBox();
    box.set(Math.min(ox, ox + dx), Math.min(oy, oy + dy), Math.min(oz, oz + dz),
      Math.max(ox, ox + dx), Math.max(oy, oy + dy), Math.max(oz, oz + dz));
    box.expand(0.6);

    const list = manager.queryAABB(box, manager.scratchList());
    let best = null;
    let bestT = travel;
    const probe = manager.scratchBox2();
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e === this || e.removed || e.dead) continue;
      if (e.id === this.shooterId && this.age < 0.4) continue;
      if (e instanceof ArrowEntity || e instanceof ItemEntity || e instanceof XPOrbEntity) continue;
      probe.copy(e.aabb).expand(0.16);
      const t = probe.rayIntersect(ox, oy, oz, dx / travel, dy / travel, dz / travel);
      if (t >= 0 && t <= bestT) {
        bestT = t;
        best = e;
      }
    }
    void ctx;
    return best;
  }

  /**
   * Trace the arrow's segment against the voxel world.
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
    const dir = ARROW_DIR;
    dir[0] = dx / travel;
    dir[1] = dy / travel;
    dir[2] = dz / travel;
    try {
      return world.raycast(this.position, dir, travel, ARROW_RAY_OPTS);
    } catch (err) {
      warnOnce('arrowRay', 'the arrow raycast failed', err);
      return null;
    }
  }

  /**
   * Stick the arrow into the block it hit.
   * @param {Object} hit `world.raycast()` result
   * @param {Object} [ctx] shared context
   * @returns {void}
   * @private
   */
  _stick(hit, ctx) {
    const p = hit.point;
    const n = hit.faceNormal;
    this.position[0] = p[0] + n[0] * 0.02;
    this.position[1] = p[1] + n[1] * 0.02;
    this.position[2] = p[2] + n[2] * 0.02;
    this.syncAABB();
    this.velocity[0] = 0;
    this.velocity[1] = 0;
    this.velocity[2] = 0;
    this.inGround = true;
    this.stuckTime = 0;
    this.stuckBlock = hit.blockId;
    this.critical = false;

    if (this.manager !== null) this.manager.emit('arrowStuck', this, hit);
    const audio = ctx && ctx.audio ? ctx.audio : null;
    if (audio && typeof audio.play === 'function') {
      try {
        audio.play('arrow_hit', { x: this.position[0], y: this.position[1], z: this.position[2] });
      } catch (err) {
        warnOnce('arrowSound', 'the arrow impact sound failed', err);
      }
    }
  }

  /**
   * Apply damage and knockback to the entity the arrow struck.
   * @param {Entity} target the entity that was hit
   * @param {Object} [ctx] shared context
   * @returns {void}
   * @private
   */
  _onEntityHit(target, ctx) {
    const damage = this.getDamage();
    const speed = this.getSpeed();
    if (typeof target.damage === 'function') target.damage(damage, ENTITY_DAMAGE.ARROW, ctx);
    if (this.flaming && target.fireProof !== true) target.fireTime = FIRE_DURATION * 0.6;

    if (speed > 1e-4 && target.velocity && target.velocity.length >= 3) {
      const push = (0.6 + this.knockback * 0.5) * 6;
      const inv = 1 / speed;
      target.velocity[0] += this.velocity[0] * inv * push;
      target.velocity[1] += 2.4;
      target.velocity[2] += this.velocity[2] * inv * push;
    }

    if (this.manager !== null) this.manager.emit('arrowHit', this, target, damage);
    const particles = ctx && ctx.particles ? ctx.particles : null;
    if (particles && typeof particles.spawn === 'function') {
      try {
        particles.spawn(this.critical ? 'crit' : 'dust',
          this.position[0], this.position[1], this.position[2], { count: 6 });
      } catch (err) {
        warnOnce('arrowHitParticles', 'hit particles failed', err);
      }
    }
    this.remove('hit');
  }

  /**
   * @returns {Object} save record
   */
  serialize() {
    const out = this.writeBaseState({});
    out.baseDamage = this.baseDamage;
    out.critical = this.critical;
    out.shooterId = this.shooterId;
    out.knockback = this.knockback;
    out.flaming = this.flaming;
    out.inGround = this.inGround;
    out.stuckTime = this.stuckTime;
    out.stuckBlock = this.stuckBlock;
    return out;
  }

  /**
   * @param {Object} o save record
   * @returns {?ArrowEntity} the restored arrow
   */
  static deserialize(o) {
    if (!o || typeof o !== 'object') return null;
    const p = Array.isArray(o.p) ? o.p : [0, 0, 0];
    const e = new ArrowEntity(num(p[0], 0), num(p[1], 0), num(p[2], 0), {
      damage: num(o.baseDamage, 2),
      critical: o.critical === true,
      shooterId: num(o.shooterId, 0),
      knockback: num(o.knockback, 0),
      fire: o.flaming === true,
    });
    e.readBaseState(o);
    e.inGround = o.inGround === true;
    e.stuckTime = Math.max(0, num(o.stuckTime, 0));
    e.stuckBlock = num(o.stuckBlock, 0) | 0;
    return e;
  }
}

/** Scratch direction vector for the arrow raycast. @type {Float32Array} */
const ARROW_DIR = new Float32Array(3);

/** Raycast options shared by every arrow (fluids do not stop an arrow). @type {Object} */
const ARROW_RAY_OPTS = Object.freeze({ fluids: false });

/* ========================================================================== */
/* XPOrbEntity                                                                */
/* ========================================================================== */

/**
 * A floating experience orb. Orbs merge with each other so a big kill does not
 * leave a hundred entities behind, and fly to the player from
 * {@link XP_ATTRACT_RADIUS}.
 */
export class XPOrbEntity extends Entity {
  /**
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {number} [value] experience points this orb carries
   */
  constructor(x, y, z, value = 1) {
    super('xp_orb', x, y, z);
    this.setSize(0.25, 0.25);

    /** @type {number} Experience points carried by this orb. */
    this.value = Math.max(1, Math.round(num(value, 1)));
    this.health = 5;
    this.maxHealth = 5;
    this.gravityScale = 0.45;
    this.drag = 1.2;
    this.dragY = 0.4;
    this.noPush = true;
    this.despawnTime = ITEM_DESPAWN_TIME;

    /** @type {number} Seconds until the next merge scan. @private */
    this._mergeTimer = 0.3 + (this.id % 7) * 0.03;
  }

  /**
   * @param {number} dt elapsed seconds
   * @param {Object} world the World
   * @param {Object} [ctx] shared context
   * @returns {void}
   */
  update(dt, world, ctx) {
    super.update(dt, world, ctx);
    if (this.removed || this.dead) return;
    const step = clamp(num(dt, 0), 0, 0.25);

    this._mergeTimer -= step;
    if (this._mergeTimer <= 0) {
      this._mergeTimer = 0.5;
      this.tryMerge();
    }

    const player = ctx && ctx.player ? ctx.player : null;
    if (player === null || player.dead === true || player.gameMode === 'spectator') return;
    const pos = player.position;
    if (!pos || pos.length < 3) return;

    const probe = bodyDistance(player, this.position[0], this.position[1] + 0.125,
      this.position[2]);
    const dist = probe[0];
    if (dist > XP_ATTRACT_RADIUS) return;
    if (dist <= 0.5) {
      this._collect(player, ctx);
      return;
    }
    const pull = 18 * step * (1 - dist / XP_ATTRACT_RADIUS);
    const v = this.velocity;
    v[0] += probe[1] * pull;
    v[1] += probe[2] * pull + 1.8 * step;
    v[2] += probe[3] * pull;
  }

  /**
   * Hand the experience to the player.
   * @param {Object} player the local player
   * @param {Object} [ctx] shared context
   * @returns {void}
   * @private
   */
  _collect(player, ctx) {
    const manager = this.manager;
    try {
      if (typeof player.addXP === 'function') player.addXP(this.value);
      else if (Number.isFinite(player.xp)) player.xp += this.value;
    } catch (err) {
      warnOnce('xpCollect', 'the player refused experience', err);
      return;
    }
    if (manager !== null) manager.emit('xpCollected', this, player, this.value);
    const audio = ctx && ctx.audio ? ctx.audio : null;
    if (audio && typeof audio.play === 'function') {
      try {
        audio.play('xp_pickup', {
          x: this.position[0], y: this.position[1], z: this.position[2],
          pitch: 1 + Math.random() * 0.4,
        });
      } catch (err) {
        warnOnce('xpSound', 'the experience sound failed', err);
      }
    }
    this.remove('collected');
  }

  /**
   * Absorb nearby orbs, up to {@link XP_MERGE_LIMIT} points.
   * @returns {number} points absorbed
   */
  tryMerge() {
    const manager = this.manager;
    if (manager === null || this.removed) return 0;
    if (this.value >= XP_MERGE_LIMIT) return 0;

    const found = manager.queryRadius(this.position[0], this.position[1] + 0.125,
      this.position[2], XP_MERGE_RADIUS, manager.scratchList());
    let gained = 0;
    for (let i = 0; i < found.length; i++) {
      const other = found[i];
      if (other === this || !(other instanceof XPOrbEntity)) continue;
      if (other.removed || other.id < this.id) continue;
      if (this.value + other.value > XP_MERGE_LIMIT) continue;
      this.value += other.value;
      gained += other.value;
      this.age = Math.min(this.age, other.age);
      other.remove('merged');
      if (this.value >= XP_MERGE_LIMIT) break;
    }
    return gained;
  }

  /**
   * @returns {Object} save record
   */
  serialize() {
    const out = this.writeBaseState({});
    out.value = this.value;
    return out;
  }

  /**
   * @param {Object} o save record
   * @returns {?XPOrbEntity} the restored orb
   */
  static deserialize(o) {
    if (!o || typeof o !== 'object') return null;
    const p = Array.isArray(o.p) ? o.p : [0, 0, 0];
    const e = new XPOrbEntity(num(p[0], 0), num(p[1], 0), num(p[2], 0), num(o.value, 1));
    return e.readBaseState(o);
  }
}

/* ========================================================================== */
/* TNTEntity                                                                  */
/* ========================================================================== */

/**
 * Primed TNT: a physical block that bounces, floats in water and detonates when
 * its fuse runs out. The renderer flashes it white while `fuseTime >= 0`.
 */
export class TNTEntity extends Entity {
  /**
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {number} [fuse] fuse length in seconds
   * @param {{power?:number, sourceId?:number, blockId?:number}} [opts] extras
   */
  constructor(x, y, z, fuse = TNT_FUSE, opts = {}) {
    super('tnt', x, y, z);
    this.setSize(0.98, 0.98);

    /** @type {number} Seconds left on the fuse. */
    this.fuseTime = Math.max(0.05, num(fuse, TNT_FUSE));
    /** @type {number} Explosion power. */
    this.power = clamp(num(opts.power, TNT_POWER), 0.5, 24);
    /** @type {number} Entity that lit this TNT (`0` = the world). */
    this.sourceId = num(opts.sourceId, 0) | 0;
    /** @type {number} Block drawn by the renderer. */
    this.blockId = num(opts.blockId, B.TNT ?? 0) | 0;

    this.health = 1;
    this.maxHealth = 1;
    this.gravityScale = 1;
    this.drag = 0.4;
    this.dragY = 0.1;
    this.fireProof = true;

    // The classic little hop when it is primed.
    const angle = Math.random() * Math.PI * 2;
    this.velocity[0] = Math.cos(angle) * 0.4;
    this.velocity[1] = 4.0;
    this.velocity[2] = Math.sin(angle) * 0.4;
  }

  /**
   * @param {number} dt elapsed seconds
   * @param {Object} world the World
   * @param {Object} [ctx] shared context
   * @returns {void}
   */
  update(dt, world, ctx) {
    super.update(dt, world, ctx);
    if (this.removed) return;
    const step = clamp(num(dt, 0), 0, 0.25);

    this.fuseTime -= step;

    const particles = ctx && ctx.particles ? ctx.particles : null;
    if (particles && typeof particles.spawn === 'function' && (this.age * 20 | 0) % 2 === 0) {
      try {
        particles.spawn('smoke', this.position[0], this.position[1] + 0.9, this.position[2],
          { count: 1, speed: 0.15, life: 0.7 });
      } catch (err) {
        warnOnce('tntSmoke', 'TNT smoke failed', err);
      }
    }

    if (this.fuseTime <= 0) this.explode(ctx);
  }

  /**
   * Detonate immediately.
   * @param {Object} [ctx] shared context
   * @returns {void}
   */
  explode(ctx) {
    this.remove('exploded');
    const manager = this.manager;
    if (manager === null) return;
    manager.explode(this.position[0], this.position[1] + 0.49, this.position[2], this.power, {
      destroy: true,
      sourceId: this.id,
      player: ctx && ctx.player ? ctx.player : null,
      particles: ctx && ctx.particles ? ctx.particles : null,
      audio: ctx && ctx.audio ? ctx.audio : null,
    });
  }

  /**
   * A hit from any source lights the charge early.
   * @param {number} amount damage in half-hearts
   * @param {string} [source] a {@link ENTITY_DAMAGE} value
   * @param {Object} [ctx] shared context
   * @returns {boolean} always false — TNT never takes damage, it detonates
   */
  damage(amount, source = ENTITY_DAMAGE.GENERIC, ctx = null) {
    void amount;
    void source;
    if (this.removed) return false;
    this.fuseTime = Math.min(this.fuseTime, 0.3);
    void ctx;
    return false;
  }

  /**
   * @returns {Object} save record
   */
  serialize() {
    const out = this.writeBaseState({});
    out.fuseTime = this.fuseTime;
    out.power = this.power;
    out.blockId = this.blockId;
    return out;
  }

  /**
   * @param {Object} o save record
   * @returns {?TNTEntity} the restored charge
   */
  static deserialize(o) {
    if (!o || typeof o !== 'object') return null;
    const p = Array.isArray(o.p) ? o.p : [0, 0, 0];
    const e = new TNTEntity(num(p[0], 0), num(p[1], 0), num(p[2], 0), num(o.fuseTime, TNT_FUSE), {
      power: num(o.power, TNT_POWER),
      blockId: num(o.blockId, B.TNT ?? 0),
    });
    e.readBaseState(o);
    e.fuseTime = Math.max(0.05, num(o.fuseTime, TNT_FUSE));
    return e;
  }
}

/* ========================================================================== */
/* FallingBlockEntity                                                         */
/* ========================================================================== */

/**
 * Sand, gravel and anvils on their way down. When the entity lands it turns
 * back into a block; if the destination cannot hold it (it is occupied, or the
 * world is not loaded there) the block drops as an item instead, so nothing is
 * ever silently lost.
 */
export class FallingBlockEntity extends Entity {
  /**
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {number} blockId the block that is falling
   * @param {number} [state] block state carried along
   */
  constructor(x, y, z, blockId, state = 0) {
    super('falling_block', x, y, z);
    this.setSize(0.98, 0.98);

    /** @type {number} The block this entity will become again. */
    this.blockId = num(blockId, 0) | 0;
    /** @type {number} Block state carried through the fall. */
    this.blockState = num(state, 0) | 0;

    this.health = 1;
    this.maxHealth = 1;
    this.gravityScale = 1;
    this.drag = 0;
    this.dragY = 0.05;
    this.fireProof = true;
    this.noPush = true;
  }

  /**
   * @param {number} dt elapsed seconds
   * @param {Object} world the World
   * @param {Object} [ctx] shared context
   * @returns {void}
   */
  update(dt, world, ctx) {
    super.update(dt, world, ctx);
    if (this.removed) return;

    if (this.onGround) {
      this._land(world, ctx);
      return;
    }
    if (this.age >= FALLING_BLOCK_MAX_AGE) {
      this._dropAsItem(ctx);
      this.remove('expired');
    }
  }

  /**
   * Turn back into a block, or drop as an item when that is impossible.
   * @param {Object} world the World
   * @param {Object} [ctx] shared context
   * @returns {void}
   * @private
   */
  _land(world, ctx) {
    this.remove('landed');
    if (!world || typeof world.setBlock !== 'function') {
      this._dropAsItem(ctx);
      return;
    }
    const bx = Math.floor(this.position[0]);
    const by = Math.floor(this.position[1] + 0.02);
    const bz = Math.floor(this.position[2]);
    if (by < WORLD_MIN_Y || by >= WORLD_MAX_Y) {
      this._dropAsItem(ctx);
      return;
    }

    const existing = world.getBlock(bx, by, bz);
    if (existing !== 0 && !isReplaceable(existing)) {
      this._dropAsItem(ctx);
      return;
    }
    const placed = world.setBlock(bx, by, bz, this.blockId);
    if (!placed) {
      this._dropAsItem(ctx);
      return;
    }
    if (this.manager !== null) {
      this.manager.emit('blockLanded', bx, by, bz, this.blockId, this.blockState);
    }
    const audio = ctx && ctx.audio ? ctx.audio : null;
    if (audio && typeof audio.playBlockSound === 'function') {
      try {
        audio.playBlockSound('place', this.blockId, bx + 0.5, by + 0.5, bz + 0.5);
      } catch (err) {
        warnOnce('landSound', 'the landing sound failed', err);
      }
    }
  }

  /**
   * Spill the block as an item stack.
   * @param {Object} [ctx] shared context
   * @returns {void}
   * @private
   */
  _dropAsItem(ctx) {
    void ctx;
    const manager = this.manager;
    if (manager === null) return;
    const itemId = blockToItem(this.blockId);
    if (itemId <= 0) return;
    manager.dropItem(this.position[0], this.position[1] + 0.25, this.position[2],
      new ItemStack(itemId, 1, null), null);
  }

  /**
   * @returns {Object} save record
   */
  serialize() {
    const out = this.writeBaseState({});
    out.blockId = this.blockId;
    out.blockState = this.blockState;
    return out;
  }

  /**
   * @param {Object} o save record
   * @returns {?FallingBlockEntity} the restored falling block
   */
  static deserialize(o) {
    if (!o || typeof o !== 'object') return null;
    const p = Array.isArray(o.p) ? o.p : [0, 0, 0];
    const id = num(o.blockId, 0) | 0;
    if (id <= 0) return null;
    const e = new FallingBlockEntity(num(p[0], 0), num(p[1], 0), num(p[2], 0), id,
      num(o.blockState, 0));
    return e.readBaseState(o);
  }
}

/* ========================================================================== */
/* Class registry                                                             */
/* ========================================================================== */

/**
 * Entity type name -> class, used by {@link Entity.deserialize} and by
 * {@link EntityManager#deserialize}. `game/mobs.js` registers its own types
 * here at import time.
 * @type {Map<string, typeof Entity>}
 */
export const ENTITY_CLASSES = new Map([
  ['entity', Entity],
  ['item', ItemEntity],
  ['arrow', ArrowEntity],
  ['xp_orb', XPOrbEntity],
  ['tnt', TNTEntity],
  ['falling_block', FallingBlockEntity],
]);

/**
 * Register an entity class so saved entities of that type can be restored.
 * @param {string} type entity type name
 * @param {typeof Entity} cls the class; it should provide a static `deserialize`
 * @returns {void}
 */
export function registerEntityClass(type, cls) {
  if (typeof type !== 'string' || type.length === 0 || typeof cls !== 'function') {
    warnOnce('register', 'registerEntityClass called with bad arguments');
    return;
  }
  ENTITY_CLASSES.set(type, cls);
}

/* ========================================================================== */
/* EntityManager                                                              */
/* ========================================================================== */

/**
 * Owns every entity in the world.
 *
 * Emits (all through {@link EventBus}):
 * `spawn(entity)`, `remove(entity)`, `entityHurt(entity, amount, source)`,
 * `entityDeath(entity, source)`, `itemPickup(item, player, count)`,
 * `itemMerged(item, count)`, `xpCollected(orb, player, value)`,
 * `arrowStuck(arrow, hit)`, `arrowHit(arrow, target, damage)`,
 * `blockLanded(x, y, z, blockId, state)` and
 * `explosion(x, y, z, power, blocksDestroyed)`.
 */
export class EntityManager extends EventBus {
  /**
   * @param {Object} world the `world/world.js` World (may be swapped later)
   */
  constructor(world) {
    super();

    /** @type {Object} The world entities live in. */
    this.world = world || null;
    /** @type {Map<number, Entity>} Every living entity, keyed by id. */
    this.entities = new Map();
    /** @type {number} Blocks within which entities are ticked. */
    this.tickRadius = ENTITY_TICK_RADIUS;
    /** @type {number} Hard entity cap. */
    this.maxEntities = MAX_ENTITIES;
    /** @type {?Object} Particle system used when no `ctx.particles` is given. */
    this.particles = null;
    /** @type {?Object} Audio engine used when no `ctx.audio` is given. */
    this.audio = null;
    /**
     * Optional particle callback: `(type, x, y, z, opts) => void`. Set by the
     * Game so explosions can spawn effects without this module importing
     * anything from `render/*`.
     * @type {?function(string, number, number, number, Object): void}
     */
    this.onParticle = null;
    /** @type {{ticked:number, frozen:number, total:number, explosions:number}} Last tick's counters. */
    this.stats = { ticked: 0, frozen: 0, total: 0, explosions: 0 };

    /** @type {Map<number, Entity[]>} Spatial hash: cell key -> entities. @private */
    this._cells = new Map();
    /** @type {Entity[][]} Recycled bucket arrays. @private */
    this._bucketPool = [];
    /** @type {Entity[]} Snapshot of the entities to tick. @private */
    this._active = [];
    /** @type {Entity[]} Reusable query result list. @private */
    this._scratchList = [];
    /** @type {Entity[]} Reusable render list. @private */
    this._renderList = [];
    /** @type {Set<number>} Buckets already visited by the running query. @private */
    this._seen = new Set();
    /** @type {AABB} Query scratch box. @private */
    this._scratchBox = new AABB();
    /** @type {AABB} Second query scratch box. @private */
    this._scratchBox2 = new AABB();
    /** @type {() => number} Deterministic-ish random source. @private */
    this._rng = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
    /** @type {Set<number>} Blocks marked by the running explosion. @private */
    this._blastSet = new Set();
    /** @type {Object} Reusable update context. @private */
    this._ctx = {
      manager: this, world: this.world, player: null, particles: null,
      audio: null, environment: null, combat: null, time: 0, dt: 0,
    };
    /** @type {boolean} A spawn was already refused, so the cap warns once. @private */
    this._capWarned = false;
  }

  /* --------------------------------------------------------------- lifecycle -- */

  /**
   * Swap the world (used when a new save is loaded).
   * @param {Object} world the new World
   * @returns {void}
   */
  setWorld(world) {
    this.world = world || null;
    this._ctx.world = this.world;
  }

  /**
   * Add an entity to the world.
   * @param {Entity} entity the entity to spawn
   * @returns {?Entity} the entity, or `null` when it was refused
   */
  spawn(entity) {
    if (!(entity instanceof Entity)) {
      warnOnce('spawnType', 'spawn() ignored a value that is not an Entity');
      return null;
    }
    if (entity.removed) return null;
    if (this.entities.has(entity.id)) return entity;
    if (this.entities.size >= this.maxEntities) {
      if (!this._capWarned) {
        this._capWarned = true;
        console.warn(`[entities] entity cap of ${this.maxEntities} reached; spawns are refused`);
      }
      return null;
    }
    entity.manager = this;
    this.entities.set(entity.id, entity);
    this._insert(entity);
    this.stats.total = this.entities.size;
    this.emit('spawn', entity);
    return entity;
  }

  /**
   * Remove an entity by id.
   * @param {number} id entity id
   * @returns {boolean} true when an entity was removed
   */
  remove(id) {
    const entity = this.entities.get(id | 0);
    if (entity === undefined) return false;
    entity.remove('removed');
    this._detach(entity);
    return true;
  }

  /**
   * Look an entity up by id.
   * @param {number} id entity id
   * @returns {?Entity} the entity, or `null`
   */
  get(id) {
    return this.entities.get(id | 0) ?? null;
  }

  /**
   * Number of living entities.
   * @returns {number} entity count
   */
  get count() {
    return this.entities.size;
  }

  /**
   * Iterate every entity.
   * @param {function(Entity): void} fn callback
   * @returns {void}
   */
  forEach(fn) {
    if (typeof fn !== 'function') return;
    this.entities.forEach(fn);
  }

  /**
   * Drop every entity (world unload).
   * @returns {void}
   */
  clear() {
    this.entities.forEach((e) => {
      e.manager = null;
      e.removed = true;
    });
    this.entities.clear();
    this._cells.forEach((bucket) => {
      bucket.length = 0;
      this._bucketPool.push(bucket);
    });
    this._cells.clear();
    this._active.length = 0;
    this._renderList.length = 0;
    this._scratchList.length = 0;
    this.stats.total = 0;
    this._capWarned = false;
  }

  /* ------------------------------------------------------------- spatial hash -- */

  /**
   * Insert an entity into its spatial-hash bucket.
   * @param {Entity} entity the entity
   * @returns {void}
   * @private
   */
  _insert(entity) {
    const key = cellHash(
      Math.floor(entity.position[0] / CELL_SIZE),
      Math.floor(entity.position[1] / CELL_SIZE),
      Math.floor(entity.position[2] / CELL_SIZE),
    );
    entity._cell = key;
    let bucket = this._cells.get(key);
    if (bucket === undefined) {
      bucket = this._bucketPool.pop() || [];
      bucket.length = 0;
      this._cells.set(key, bucket);
    }
    bucket.push(entity);
  }

  /**
   * Take an entity out of its bucket.
   * @param {Entity} entity the entity
   * @returns {void}
   * @private
   */
  _unlink(entity) {
    const key = entity._cell;
    if (!Number.isFinite(key)) return;
    const bucket = this._cells.get(key);
    entity._cell = NaN;
    if (bucket === undefined) return;
    const i = bucket.indexOf(entity);
    if (i >= 0) {
      bucket[i] = bucket[bucket.length - 1];
      bucket.pop();
    }
    if (bucket.length === 0) {
      this._cells.delete(key);
      this._bucketPool.push(bucket);
    }
  }

  /**
   * Move an entity to the bucket its current position belongs to. Cheap when
   * the entity did not leave its cell, which is the common case.
   * @param {Entity} entity the entity
   * @returns {void}
   */
  reindex(entity) {
    if (!(entity instanceof Entity)) return;
    const key = cellHash(
      Math.floor(entity.position[0] / CELL_SIZE),
      Math.floor(entity.position[1] / CELL_SIZE),
      Math.floor(entity.position[2] / CELL_SIZE),
    );
    if (key === entity._cell) return;
    this._unlink(entity);
    this._insert(entity);
  }

  /**
   * Fully forget an entity.
   * @param {Entity} entity the entity
   * @returns {void}
   * @private
   */
  _detach(entity) {
    this._unlink(entity);
    this.entities.delete(entity.id);
    entity.manager = null;
    this.stats.total = this.entities.size;
    this.emit('remove', entity);
  }

  /**
   * A reusable result array for queries. Callers must consume it before the
   * next query — it is the same array every time.
   * @returns {Entity[]} the shared list, cleared
   */
  scratchList() {
    this._scratchList.length = 0;
    return this._scratchList;
  }

  /**
   * A reusable {@link AABB}, so hot paths do not allocate.
   * @returns {AABB} the shared box
   */
  scratchBox() {
    return this._scratchBox;
  }

  /**
   * A second reusable {@link AABB}.
   * @returns {AABB} the shared box
   */
  scratchBox2() {
    return this._scratchBox2;
  }

  /**
   * Every entity whose box overlaps `aabb`.
   * @param {AABB|ArrayLike<number>} aabb query box
   * @param {Entity[]} [out] receiver (cleared and refilled)
   * @returns {Entity[]} `out`
   */
  queryAABB(aabb, out = []) {
    out.length = 0;
    if (!aabb) return out;
    const minX = aabb.minX !== undefined ? aabb.minX : aabb[0];
    const minY = aabb.minY !== undefined ? aabb.minY : aabb[1];
    const minZ = aabb.minZ !== undefined ? aabb.minZ : aabb[2];
    const maxX = aabb.maxX !== undefined ? aabb.maxX : aabb[3];
    const maxY = aabb.maxY !== undefined ? aabb.maxY : aabb[4];
    const maxZ = aabb.maxZ !== undefined ? aabb.maxZ : aabb[5];
    if (!Number.isFinite(minX) || !Number.isFinite(maxZ)) return out;

    this._forEachCell(minX, minY, minZ, maxX, maxY, maxZ, (entity) => {
      if (entity.removed) return;
      const b = entity.aabb;
      if (b.maxX <= minX || b.minX >= maxX) return;
      if (b.maxY <= minY || b.minY >= maxY) return;
      if (b.maxZ <= minZ || b.minZ >= maxZ) return;
      out.push(entity);
    });
    return out;
  }

  /**
   * Every entity whose centre lies within `r` blocks of a point.
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {number} r radius in blocks
   * @param {Entity[]} [out] receiver (cleared and refilled)
   * @returns {Entity[]} `out`
   */
  queryRadius(x, y, z, r, out = []) {
    out.length = 0;
    const radius = Math.max(0, num(r, 0));
    if (radius === 0) return out;
    const r2 = radius * radius;
    this._forEachCell(x - radius, y - radius, z - radius, x + radius, y + radius, z + radius,
      (entity) => {
        if (entity.removed) return;
        if (entity.distanceSqTo(x, y, z) <= r2) out.push(entity);
      });
    return out;
  }

  /**
   * Visit every entity in the buckets overlapping a box.
   * @param {number} minX box minimum X
   * @param {number} minY box minimum Y
   * @param {number} minZ box minimum Z
   * @param {number} maxX box maximum X
   * @param {number} maxY box maximum Y
   * @param {number} maxZ box maximum Z
   * @param {function(Entity): void} cb visitor
   * @returns {void}
   * @private
   */
  _forEachCell(minX, minY, minZ, maxX, maxY, maxZ, cb) {
    const cx0 = Math.floor(minX / CELL_SIZE);
    const cy0 = Math.floor(minY / CELL_SIZE);
    const cz0 = Math.floor(minZ / CELL_SIZE);
    const cx1 = Math.floor(maxX / CELL_SIZE);
    const cy1 = Math.floor(maxY / CELL_SIZE);
    const cz1 = Math.floor(maxZ / CELL_SIZE);
    // A pathological query would visit millions of cells; clamp it instead.
    const cells = (cx1 - cx0 + 1) * (cy1 - cy0 + 1) * (cz1 - cz0 + 1);
    if (!Number.isFinite(cells) || cells > 32768) {
      this.entities.forEach(cb);
      return;
    }

    const seen = this._seen;
    seen.clear();
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cellHash(cx, cy, cz);
          if (seen.has(key)) continue;
          seen.add(key);
          const bucket = this._cells.get(key);
          if (bucket === undefined) continue;
          for (let i = 0; i < bucket.length; i++) cb(bucket[i]);
        }
      }
    }
  }

  /* ------------------------------------------------------------------- tick -- */

  /**
   * Tick every entity near the player and freeze the rest.
   * @param {number} dt elapsed seconds (0.05 at 20 TPS)
   * @param {Object} [player] the local player
   * @param {Object} [ctx] extra context merged into the shared record
   * @returns {void}
   */
  update(dt, player, ctx) {
    const step = clamp(num(dt, 0), 0, 0.25);
    const world = this.world;
    const context = ctx && typeof ctx === 'object' ? ctx : this._ctx;
    context.manager = this;
    context.world = world;
    context.player = player || null;
    context.dt = step;
    if (context.particles === undefined || context.particles === null) context.particles = this.particles;
    if (context.audio === undefined || context.audio === null) context.audio = this.audio;

    const active = this._active;
    active.length = 0;
    this.entities.forEach((e) => {
      if (!e.removed) active.push(e);
    });

    const hasPlayer = player !== null && player !== undefined
      && player.position !== undefined && player.position.length >= 3;
    const px = hasPlayer ? player.position[0] : 0;
    const py = hasPlayer ? player.position[1] : 0;
    const pz = hasPlayer ? player.position[2] : 0;
    const radiusSq = this.tickRadius * this.tickRadius;

    let ticked = 0;
    let frozen = 0;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (e.removed) continue;
      if (hasPlayer && e.distanceSqTo(px, py, pz) > radiusSq) {
        // Frozen: no physics, but the despawn clock keeps running.
        e.frozen = true;
        e.prevPosition.set(e.position);
        e.age += step;
        if (e.despawnTime > 0 && e.age >= e.despawnTime) e.remove('despawn');
        frozen++;
        continue;
      }
      e.frozen = false;
      try {
        e.update(step, world, context);
      } catch (err) {
        warnOnce(`update:${e.type}`, `"${e.type}" threw during update and was removed`, err);
        e.remove('error');
      }
      this.reindex(e);
      ticked++;
    }

    try {
      resolveEntityPush(active, step);
    } catch (err) {
      warnOnce('push', 'entity push resolution failed', err);
    }

    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (e.removed) this._detach(e);
    }

    this.stats.ticked = ticked;
    this.stats.frozen = frozen;
    this.stats.total = this.entities.size;
  }

  /**
   * Entities close enough to the camera to be worth drawing.
   * @param {ArrayLike<number>} cameraPos camera position
   * @param {number} [maxDist] cut-off distance in blocks
   * @returns {Entity[]} a reused array, nearest first
   */
  getRenderList(cameraPos, maxDist = 96) {
    const out = this._renderList;
    out.length = 0;
    const cx = cameraPos ? num(cameraPos[0], 0) : 0;
    const cy = cameraPos ? num(cameraPos[1], 0) : 0;
    const cz = cameraPos ? num(cameraPos[2], 0) : 0;
    const limit = Math.max(0, num(maxDist, 96));
    const limitSq = limit * limit;
    this.entities.forEach((e) => {
      if (e.removed) return;
      if (e.distanceSqTo(cx, cy, cz) <= limitSq) out.push(e);
    });
    out.sort((a, b) => a.distanceSqTo(cx, cy, cz) - b.distanceSqTo(cx, cy, cz));
    return out;
  }

  /* ------------------------------------------------------------------ spawn -- */

  /**
   * Drop an item stack into the world.
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {ItemStack|{itemId:number, count:number}} stack the stack to drop
   * @param {?ArrayLike<number>} [velocity] initial velocity; a small random pop
   *   is used when omitted
   * @returns {?ItemEntity} the spawned drop, or `null`
   */
  dropItem(x, y, z, stack, velocity = null) {
    const real = toStack(stack);
    if (real === null || real.isEmpty()) return null;
    const entity = new ItemEntity(num(x, 0), num(y, 0), num(z, 0), real);
    if (velocity && velocity.length >= 3) {
      entity.velocity[0] = num(velocity[0], 0);
      entity.velocity[1] = num(velocity[1], 0);
      entity.velocity[2] = num(velocity[2], 0);
    } else {
      const rng = this._rng;
      entity.velocity[0] = (rng() - 0.5) * 2;
      entity.velocity[1] = 2 + rng() * 1.2;
      entity.velocity[2] = (rng() - 0.5) * 2;
    }
    return this.spawn(entity) === null ? null : entity;
  }

  /**
   * Drop everything a block yields, one entity per stack.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {{item:string, count:number}[]} drops result of `blockDrops()`
   * @returns {number} how many drops were spawned
   */
  dropBlockLoot(x, y, z, drops) {
    if (!Array.isArray(drops) || drops.length === 0) return 0;
    let spawned = 0;
    for (let i = 0; i < drops.length; i++) {
      const entry = drops[i];
      if (!entry || typeof entry.item !== 'string') continue;
      const itemId = itemIdByName(entry.item);
      if (itemId <= 0) continue;
      let remaining = Math.max(0, entry.count | 0);
      while (remaining > 0) {
        const stack = new ItemStack(itemId, remaining, null);
        const move = Math.min(remaining, stack.maxStack);
        stack.count = move;
        remaining -= move;
        if (this.dropItem(x + 0.5, y + 0.5, z + 0.5, stack, null) !== null) spawned++;
      }
    }
    return spawned;
  }

  /**
   * Scatter experience as a handful of orbs.
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {number} amount total experience points
   * @returns {number} how many orbs were spawned
   */
  dropXP(x, y, z, amount) {
    let left = Math.max(0, Math.round(num(amount, 0)));
    let spawned = 0;
    let guard = 0;
    while (left > 0 && guard++ < 64) {
      const value = left >= 17 ? 17 : (left >= 7 ? 7 : (left >= 3 ? 3 : 1));
      left -= value;
      const orb = new XPOrbEntity(x, y, z, value);
      const rng = this._rng;
      orb.velocity[0] = (rng() - 0.5) * 1.6;
      orb.velocity[1] = 1.5 + rng();
      orb.velocity[2] = (rng() - 0.5) * 1.6;
      if (this.spawn(orb) !== null) spawned++;
    }
    return spawned;
  }

  /**
   * Prime a TNT block into a {@link TNTEntity}.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {number} [fuse] fuse in seconds
   * @param {number} [sourceId] entity that lit it
   * @returns {?TNTEntity} the primed charge
   */
  primeTNT(x, y, z, fuse = TNT_FUSE, sourceId = 0) {
    const tnt = new TNTEntity(Math.floor(x) + 0.5, Math.floor(y), Math.floor(z) + 0.5, fuse,
      { sourceId });
    return this.spawn(tnt) === null ? null : tnt;
  }

  /**
   * Turn a block into a {@link FallingBlockEntity}.
   * @param {number} x block X
   * @param {number} y block Y
   * @param {number} z block Z
   * @param {number} blockId the block that starts falling
   * @param {number} [state] block state carried along
   * @returns {?FallingBlockEntity} the spawned entity
   */
  spawnFallingBlock(x, y, z, blockId, state = 0) {
    const id = num(blockId, 0) | 0;
    if (id <= 0) return null;
    const e = new FallingBlockEntity(Math.floor(x) + 0.5, Math.floor(y), Math.floor(z) + 0.5,
      id, state);
    return this.spawn(e) === null ? null : e;
  }

  /* -------------------------------------------------------------- explosions -- */

  /**
   * Blow a hole in the world.
   *
   * Rays are cast from the centre through the faces of a
   * {@link EXPLOSION_RAYS}³ cube. Each ray carries a randomised intensity and
   * loses `(resistance / 5 + 0.3) * step` per block it passes plus a constant
   * decay, so soft blocks let the blast through and obsidian stops it dead.
   * Every block a ray survives is destroyed; a fraction of them drop their
   * loot. Entities inside twice the power take damage scaled by distance and by
   * how much of them the blast can actually see, plus knockback.
   *
   * @param {number} x world X of the centre
   * @param {number} y world Y of the centre
   * @param {number} z world Z of the centre
   * @param {number} power explosion power (TNT is 4)
   * @param {{fire?:boolean, destroy?:boolean, dropChance?:number, sourceId?:number,
   *   player?:Object, particles?:Object, audio?:Object,
   *   onParticle?:function(string, number, number, number, Object): void}} [opts] options
   * @returns {number} how many blocks were destroyed
   */
  explode(x, y, z, power, opts = {}) {
    const cx = num(x, 0);
    const cy = num(y, 0);
    const cz = num(z, 0);
    const strength = clamp(num(power, 4), 0.5, 24);
    const destroy = opts.destroy !== false;
    const fire = opts.fire === true;
    const dropChance = clamp(num(opts.dropChance, 1 / strength), 0, 1);
    const world = this.world;
    const rng = this._rng;

    // Entities are hurt *before* the blocks break, exactly like the real game:
    // otherwise the loot this explosion just dropped would be caught in its own
    // blast and destroyed again.
    this._blastEntities(cx, cy, cz, strength, opts);

    let destroyed = 0;
    if (destroy && world && typeof world.getBlock === 'function') {
      destroyed = this._blastBlocks(cx, cy, cz, strength, dropChance, fire, rng);
    }

    // Effects: the explicit callback first, then any particle system we know.
    const particles = opts.particles || this.particles;
    if (particles && typeof particles.spawn === 'function') {
      try {
        particles.spawn('explosion', cx, cy, cz, { power: strength });
      } catch (err) {
        warnOnce('explodeParticles', 'explosion particles failed', err);
      }
    }
    const hook = typeof opts.onParticle === 'function' ? opts.onParticle : this.onParticle;
    if (typeof hook === 'function') {
      try {
        hook('explosion', cx, cy, cz, { power: strength, blocks: destroyed });
      } catch (err) {
        warnOnce('explodeHook', 'the explosion particle callback failed', err);
      }
    }
    const audio = opts.audio || this.audio;
    if (audio && typeof audio.play === 'function') {
      try {
        audio.play('explode', { x: cx, y: cy, z: cz, volume: 1, pitch: 0.8 + rng() * 0.4 });
      } catch (err) {
        warnOnce('explodeSound', 'the explosion sound failed', err);
      }
    }

    this.stats.explosions++;
    this.emit('explosion', cx, cy, cz, strength, destroyed);
    return destroyed;
  }

  /**
   * Ray-march the blast and destroy every block that survives it.
   * @param {number} cx centre X
   * @param {number} cy centre Y
   * @param {number} cz centre Z
   * @param {number} strength explosion power
   * @param {number} dropChance chance per block to drop its loot
   * @param {boolean} fire leave fire behind where the world supports it
   * @param {() => number} rng random source
   * @returns {number} blocks destroyed
   * @private
   */
  _blastBlocks(cx, cy, cz, strength, dropChance, fire, rng) {
    const world = this.world;
    const marked = this._blastSet;
    marked.clear();

    const n = EXPLOSION_RAYS;
    const last = n - 1;
    const half = last / 2;
    for (let kx = 0; kx < n; kx++) {
      for (let ky = 0; ky < n; ky++) {
        for (let kz = 0; kz < n; kz++) {
          if (kx !== 0 && kx !== last && ky !== 0 && ky !== last && kz !== 0 && kz !== last) continue;
          let dx = kx / half - 1;
          let dy = ky / half - 1;
          let dz = kz / half - 1;
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (len < 1e-6) continue;
          dx /= len;
          dy /= len;
          dz /= len;

          let intensity = strength * (0.7 + rng() * 0.6);
          let px = cx;
          let py = cy;
          let pz = cz;
          let guard = 0;
          while (intensity > 0 && guard++ < 256) {
            const bx = Math.floor(px);
            const by = Math.floor(py);
            const bz = Math.floor(pz);
            if (by >= WORLD_MIN_Y && by < WORLD_MAX_Y) {
              const id = world.getBlock(bx, by, bz);
              if (id !== 0) {
                const resistance = blastResistance(id);
                if (!Number.isFinite(resistance)) {
                  intensity = 0;
                } else {
                  intensity -= (resistance / 5 + 0.3) * EXPLOSION_STEP;
                  if (intensity > 0) {
                    const key = blastKey(bx - Math.floor(cx), by - Math.floor(cy), bz - Math.floor(cz));
                    if (key >= 0) marked.add(key);
                  }
                }
              }
            }
            px += dx * EXPLOSION_STEP;
            py += dy * EXPLOSION_STEP;
            pz += dz * EXPLOSION_STEP;
            intensity -= EXPLOSION_DECAY;
          }
        }
      }
    }

    const ox = Math.floor(cx);
    const oy = Math.floor(cy);
    const oz = Math.floor(cz);
    const fireBlock = fire ? blastFireBlock() : 0;
    let destroyed = 0;

    marked.forEach((key) => {
      const bx = ox + ((key >> 14) & 127) - 64;
      const by = oy + ((key >> 7) & 127) - 64;
      const bz = oz + (key & 127) - 64;
      if (by < WORLD_MIN_Y || by >= WORLD_MAX_Y) return;
      const id = world.getBlock(bx, by, bz);
      if (id === 0) return;
      const def = getBlock(id);
      if (def.hardness < 0) return;

      if (B.TNT !== undefined && id === B.TNT) {
        // Chain reaction instead of a plain removal.
        world.setBlock(bx, by, bz, 0);
        this.primeTNT(bx, by, bz, 0.5 + rng() * 0.75, 0);
        destroyed++;
        return;
      }

      if (!def.liquid && rng() < dropChance) {
        const drops = blockDrops(id, def.toolType, TOOL_TIER.NETHERITE, 0, rng);
        this.dropBlockLoot(bx, by, bz, drops);
      }
      if (world.setBlock(bx, by, bz, 0)) destroyed++;

      if (fireBlock > 0 && rng() < 0.28) {
        const below = world.getBlock(bx, by - 1, bz);
        if (below !== 0 && isSolid(below)) world.setBlock(bx, by, bz, fireBlock);
      }
    });

    marked.clear();
    return destroyed;
  }

  /**
   * Damage and shove everything caught in the blast, the player included.
   * @param {number} cx centre X
   * @param {number} cy centre Y
   * @param {number} cz centre Z
   * @param {number} strength explosion power
   * @param {Object} opts the options passed to {@link EntityManager#explode}
   * @returns {void}
   * @private
   */
  _blastEntities(cx, cy, cz, strength, opts) {
    const radius = strength * 2;
    const list = this.queryRadius(cx, cy, cz, radius, this.scratchList());
    const sourceId = num(opts.sourceId, 0) | 0;

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed || e.id === sourceId) continue;
      this._applyBlast(e, e.position[0], e.position[1] + e.height * 0.5, e.position[2],
        e.aabb, cx, cy, cz, strength, radius);
    }

    const player = opts.player || this._ctx.player;
    if (player && player.position && player.position.length >= 3 && player.gameMode !== 'creative'
      && player.gameMode !== 'spectator') {
      const height = num(player.height, 1.8);
      const box = this.scratchBox2();
      box.setFromEntity(player.position[0], player.position[1], player.position[2],
        num(player.width, 0.6), height);
      this._applyBlast(player, player.position[0], player.position[1] + height * 0.5,
        player.position[2], box, cx, cy, cz, strength, radius);
    }
  }

  /**
   * Apply the blast to one target (entity or player).
   * @param {Object} target something with `damage()` and `velocity`
   * @param {number} tx target centre X
   * @param {number} ty target centre Y
   * @param {number} tz target centre Z
   * @param {AABB} box the target's box, used for the exposure test
   * @param {number} cx centre X
   * @param {number} cy centre Y
   * @param {number} cz centre Z
   * @param {number} strength explosion power
   * @param {number} radius blast radius
   * @returns {void}
   * @private
   */
  _applyBlast(target, tx, ty, tz, box, cx, cy, cz, strength, radius) {
    const dx = tx - cx;
    const dy = ty - cy;
    const dz = tz - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > radius || radius <= 0) return;

    const falloff = 1 - dist / radius;
    const exposure = this._exposure(cx, cy, cz, box);
    const impact = falloff * exposure;
    if (impact <= 0) return;

    const damage = Math.floor((impact * impact + impact) * 0.5 * 7 * strength + 1);
    if (typeof target.damage === 'function') {
      try {
        target.damage(damage, ENTITY_DAMAGE.EXPLOSION);
      } catch (err) {
        warnOnce('blastDamage', 'a blast target refused damage', err);
      }
    }

    const v = target.velocity;
    if (v && v.length >= 3) {
      const inv = dist > 1e-4 ? 1 / dist : 0;
      const push = impact * EXPLOSION_KNOCKBACK;
      v[0] += dx * inv * push;
      v[1] += (dy * inv * push) + impact * 4;
      v[2] += dz * inv * push;
    }
  }

  /**
   * How much of a box the explosion can see, `0..1`. Eight rays from the blast
   * centre to the corners of the (slightly shrunk) box; each one that reaches
   * without crossing a solid block counts.
   * @param {number} cx centre X
   * @param {number} cy centre Y
   * @param {number} cz centre Z
   * @param {AABB} box the target box
   * @returns {number} exposure `0..1`
   * @private
   */
  _exposure(cx, cy, cz, box) {
    const world = this.world;
    if (!world || typeof world.getBlock !== 'function') return 1;
    const inset = 0.05;
    let hits = 0;
    for (let i = 0; i < 8; i++) {
      const tx = (i & 1) ? box.maxX - inset : box.minX + inset;
      const ty = (i & 2) ? box.maxY - inset : box.minY + inset;
      const tz = (i & 4) ? box.maxZ - inset : box.minZ + inset;
      if (this._lineOfSight(cx, cy, cz, tx, ty, tz)) hits++;
    }
    return hits / 8;
  }

  /**
   * Step along a segment and report whether it stays clear of solid blocks.
   * @param {number} x0 start X
   * @param {number} y0 start Y
   * @param {number} z0 start Z
   * @param {number} x1 end X
   * @param {number} y1 end Y
   * @param {number} z1 end Z
   * @returns {boolean} true when nothing blocks the line
   * @private
   */
  _lineOfSight(x0, y0, z0, x1, y1, z1) {
    const world = this.world;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-4) return true;
    const steps = Math.min(96, Math.ceil(dist / 0.3));
    const inv = 1 / steps;
    let lastX = NaN;
    let lastY = NaN;
    let lastZ = NaN;
    for (let i = 1; i < steps; i++) {
      const t = i * inv;
      const bx = Math.floor(x0 + dx * t);
      const by = Math.floor(y0 + dy * t);
      const bz = Math.floor(z0 + dz * t);
      if (bx === lastX && by === lastY && bz === lastZ) continue;
      lastX = bx;
      lastY = by;
      lastZ = bz;
      if (by < WORLD_MIN_Y || by >= WORLD_MAX_Y) continue;
      const id = world.getBlock(bx, by, bz);
      if (id !== 0 && isSolid(id) && getBlock(id).opaque) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------- persistence -- */

  /**
   * Save every entity.
   * @returns {{entities:Object[], nextId:number}} plain save record
   */
  serialize() {
    /** @type {Object[]} */
    const out = [];
    this.entities.forEach((e) => {
      if (e.removed || e.dead) return;
      try {
        const record = e.serialize();
        if (record && typeof record === 'object') out.push(record);
      } catch (err) {
        warnOnce(`serialize:${e.type}`, `"${e.type}" could not be saved`, err);
      }
    });
    return { entities: out, nextId };
  }

  /**
   * Replace the world's entities with the ones in a save record.
   * @param {{entities:Object[], nextId?:number}|Object[]} o save record
   * @returns {number} how many entities were restored
   */
  deserialize(o) {
    this.clear();
    const list = Array.isArray(o) ? o : (o && Array.isArray(o.entities) ? o.entities : null);
    if (list === null) return 0;
    if (o && Number.isFinite(o.nextId)) reserveEntityId(o.nextId);

    let restored = 0;
    for (let i = 0; i < list.length; i++) {
      let entity = null;
      try {
        entity = Entity.deserialize(list[i]);
      } catch (err) {
        warnOnce('deserializeEntry', 'an entity record could not be restored', err);
        entity = null;
      }
      if (entity === null) continue;
      if (this.spawn(entity) !== null) restored++;
    }
    return restored;
  }

  /**
   * Release every reference. The manager is unusable afterwards.
   * @returns {void}
   */
  dispose() {
    this.clear();
    this.removeAllListeners();
    this.world = null;
    this.particles = null;
    this.audio = null;
    this.onParticle = null;
  }
}

/* ========================================================================== */
/* Explosion helpers                                                          */
/* ========================================================================== */

/**
 * Pack a block offset relative to the explosion centre into one integer, so the
 * marked-block set never allocates strings. Offsets outside ±63 blocks (which
 * no legal explosion reaches) return `-1`.
 * @param {number} dx offset X
 * @param {number} dy offset Y
 * @param {number} dz offset Z
 * @returns {number} packed key, or `-1` when out of range
 */
function blastKey(dx, dy, dz) {
  if (dx < -64 || dx > 63 || dy < -64 || dy > 63 || dz < -64 || dz > 63) return -1;
  return ((dx + 64) << 14) | ((dy + 64) << 7) | (dz + 64);
}

/** Cached fire block id (`-1` = not looked up yet, `0` = the world has none). @type {number} */
let fireBlockId = -1;

/**
 * Block id used for the fire an incendiary explosion leaves behind. The block
 * registry does not have to contain one; when it does not, incendiary
 * explosions simply leave no fire.
 * @returns {number} block id, or `0` when the registry has no fire block
 */
function blastFireBlock() {
  if (fireBlockId < 0) {
    const id = B.FIRE;
    fireBlockId = Number.isFinite(id) ? id | 0 : 0;
  }
  return fireBlockId;
}
