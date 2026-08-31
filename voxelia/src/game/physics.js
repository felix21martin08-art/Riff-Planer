/**
 * @file game/physics.js — VOXELIA swept-AABB voxel physics (spec 5.28).
 *
 * A small, allocation-free solver for entities that are axis-aligned boxes
 * moving through a voxel world:
 *
 *  - {@link moveWithCollisions} resolves the three axes **separately, in the
 *    order Y, X, Z**, each time querying `world.getCollisionAABBs()` for the
 *    swept volume of that single axis. Because every axis step is a true sweep
 *    (the allowed distance is clipped against the whole motion, not just the
 *    end position) nothing can tunnel through geometry, no matter how fast it
 *    moves or how thin the block shape is.
 *  - Auto-step lifts an entity over obstacles up to {@link STEP_HEIGHT} high
 *    when it was standing on the ground, is not sneaking, and there is enough
 *    headroom for the lift.
 *  - Sneaking additionally clamps horizontal motion so an entity can never walk
 *    off a ledge.
 *  - {@link isInLiquid} reports water/lava contact plus the exact submerged
 *    volume fraction, which drives buoyancy, drag, fog and the drowning timer.
 *
 * Conventions (binding, see ARCHITECTURE.md §2):
 *  - Right handed, **Y up**; block `(x,y,z)` occupies `[x,x+1]³`.
 *  - Velocities are in **blocks per second**; `dt` is in seconds. Game logic
 *    runs at a fixed 20 TPS, so `dt` is normally `0.05` — nothing in this file
 *    assumes that, everything is integrated with the `dt` it is given.
 *  - Every hot function reuses module-level scratch state. The only functions
 *    that may allocate are the ones whose `out` parameter was omitted, and they
 *    say so in their doc comment.
 *  - Nothing here throws: bad worlds, NaN velocities and degenerate boxes all
 *    degrade to "no movement" and are reported once via `console.warn`.
 */

import { AABB, clamp } from '../core/math.js';
import { B, isLiquid } from '../world/blocks.js';

/* ------------------------------------------------------------------------- */
/* Constants                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Downward acceleration in blocks/s². Matches the classic 0.08 blocks/tick²
 * feel at 20 TPS (`0.08 * 20 * 20 = 32`).
 * @type {number}
 */
export const GRAVITY = 32.0;

/**
 * Maximum free-fall speed in blocks/s (`3.92 blocks/tick * 20`).
 * @type {number}
 */
export const TERMINAL_VELOCITY = 78.4;

/**
 * Default auto-step height in blocks — one slab, one stair, one soul-sand top.
 * @type {number}
 */
export const STEP_HEIGHT = 0.6;

/**
 * Geometric tolerance used to decide whether two boxes touch or overlap.
 * @type {number}
 */
export const EPSILON = 1e-7;

/**
 * How deep below the feet the sneak ledge guard looks for support, in blocks.
 * @type {number}
 */
export const LEDGE_PROBE_DEPTH = 0.6;

/**
 * Largest displacement resolved in a single {@link moveWithCollisions} call,
 * in blocks per axis. Anything beyond this is clamped so a runaway velocity can
 * never turn one tick into a million-voxel query.
 * @type {number}
 */
export const MAX_STEP_DISTANCE = 32;

/**
 * Exponential drag rates per medium, in 1/seconds. A velocity component decays
 * as `v * exp(-k * dt)`, which is frame-rate independent. The values reproduce
 * the familiar per-tick factors: air `0.91` horizontally / `0.98` vertically,
 * water `0.80`, lava `0.50`.
 * @type {Readonly<{air:{xz:number,y:number}, water:{xz:number,y:number},
 *   lava:{xz:number,y:number}, cobweb:{xz:number,y:number}}>}
 */
export const MEDIUM_DRAG = Object.freeze({
  air: Object.freeze({ xz: 1.8859, y: 0.4041 }),
  water: Object.freeze({ xz: 4.4629, y: 4.4629 }),
  lava: Object.freeze({ xz: 13.8629, y: 13.8629 }),
  cobweb: Object.freeze({ xz: 27.7259, y: 34.5388 }),
});

/**
 * Upward acceleration applied to a fully submerged entity, in blocks/s².
 * Water lifts less than gravity pulls (so you sink slowly when idle), lava
 * lifts slightly less than water but its huge drag makes it feel thick.
 * @type {Readonly<{water:number, lava:number}>}
 */
export const BUOYANCY = Object.freeze({ water: 22.0, lava: 25.0 });

/* ------------------------------------------------------------------------- */
/* Module scratch state (never reallocated)                                   */
/* ------------------------------------------------------------------------- */

/** Query box handed to `world.getCollisionAABBs`. @type {AABB} */
const _query = new AABB();

/** Receiver for `world.getCollisionAABBs`. @type {Array<ArrayLike<number>>} */
const _boxes = [];

/** Saved box state (post-Y position). @type {Float64Array} */
const _saveA = new Float64Array(6);

/** Saved box state (plain, non-stepped horizontal result). @type {Float64Array} */
const _saveB = new Float64Array(6);

/** Scratch box for {@link sweepAABB}. @type {AABB} */
const _sweepSelf = new AABB();

/** Scratch box for {@link sweepAABB} candidates. @type {AABB} */
const _sweepOther = new AABB();

/** Scratch normal for {@link sweepAABB}. @type {number[]} */
const _sweepNormal = [0, 0, 0];

/** Flattened entity list used by {@link resolveEntityPush}. @type {Object[]} */
const _pushList = [];

/** Spatial hash buckets used by {@link resolveEntityPush}. @type {Map<number, number[]>} */
const _pushCells = new Map();

/** Recycled bucket arrays. @type {Array<number[]>} */
const _pushPool = [];

/** Empty options object so the fast path never allocates. @type {Object} */
const EMPTY_OPTS = Object.freeze({});

/** One-shot warning flags, so a broken world logs once instead of every tick. */
const _warned = { world: false, aabb: false, velocity: false };

/**
 * Log a message at most once per category.
 * @param {'world'|'aabb'|'velocity'} key Category.
 * @param {string} message Text to log.
 * @returns {void}
 */
function warnOnce(key, message) {
  if (_warned[key]) return;
  _warned[key] = true;
  console.warn(`[VOXELIA] physics: ${message}`);
}

/* ------------------------------------------------------------------------- */
/* Box helpers                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Read the minimum X of an `AABB` or a packed `[minX,minY,minZ,maxX,maxY,maxZ]`.
 * @param {AABB|ArrayLike<number>} b Box in either representation.
 * @param {number} i Component index `0..5`.
 * @returns {number} The component, or `NaN` when `b` is unusable.
 */
function comp(b, i) {
  if (b === null || b === undefined) return NaN;
  switch (i) {
    case 0: return b.minX !== undefined ? b.minX : b[0];
    case 1: return b.minY !== undefined ? b.minY : b[1];
    case 2: return b.minZ !== undefined ? b.minZ : b[2];
    case 3: return b.maxX !== undefined ? b.maxX : b[3];
    case 4: return b.maxY !== undefined ? b.maxY : b[4];
    default: return b.maxZ !== undefined ? b.maxZ : b[5];
  }
}

/**
 * Copy any box representation into an {@link AABB}.
 * @param {AABB} dst Receiver.
 * @param {AABB|ArrayLike<number>} src Source box.
 * @returns {AABB} `dst`.
 */
function toBox(dst, src) {
  return dst.set(comp(src, 0), comp(src, 1), comp(src, 2),
    comp(src, 3), comp(src, 4), comp(src, 5));
}

/**
 * Snapshot the six bounds of a box.
 * @param {AABB} a Source box.
 * @param {Float64Array} dst Six-element receiver.
 * @returns {void}
 */
function saveBox(a, dst) {
  dst[0] = a.minX; dst[1] = a.minY; dst[2] = a.minZ;
  dst[3] = a.maxX; dst[4] = a.maxY; dst[5] = a.maxZ;
}

/**
 * Restore a snapshot taken by {@link saveBox}.
 * @param {AABB} a Receiver box.
 * @param {Float64Array} src Six-element snapshot.
 * @returns {void}
 */
function loadBox(a, src) {
  a.minX = src[0]; a.minY = src[1]; a.minZ = src[2];
  a.maxX = src[3]; a.maxY = src[4]; a.maxZ = src[5];
}

/**
 * Finite-number guard.
 * @param {number} v Candidate.
 * @param {number} fallback Value used when `v` is not finite.
 * @returns {number} `v` or `fallback`.
 */
function finite(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/* ------------------------------------------------------------------------- */
/* Per-axis swept clipping                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Longest distance the box may travel along Y before touching solid geometry.
 * @param {Object} world World providing `getCollisionAABBs`.
 * @param {AABB} a Moving box, at its current position.
 * @param {number} dy Desired displacement along Y.
 * @returns {number} The clipped displacement, same sign as `dy`.
 */
function clipY(world, a, dy) {
  if (dy === 0) return 0;
  _query.copy(a).expandByVelocity(0, dy, 0);
  const list = world.getCollisionAABBs(_query, _boxes);
  let d = dy;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (a.maxX <= b[0] + EPSILON || a.minX >= b[3] - EPSILON) continue;
    if (a.maxZ <= b[2] + EPSILON || a.minZ >= b[5] - EPSILON) continue;
    if (d > 0) {
      if (b[1] >= a.maxY - EPSILON) {
        const c = b[1] - a.maxY;
        if (c < d) d = c > 0 ? c : 0;
      }
    } else if (b[4] <= a.minY + EPSILON) {
      const c = b[4] - a.minY;
      if (c > d) d = c < 0 ? c : 0;
    }
  }
  return d;
}

/**
 * Longest distance the box may travel along X before touching solid geometry.
 * @param {Object} world World providing `getCollisionAABBs`.
 * @param {AABB} a Moving box, at its current position.
 * @param {number} dx Desired displacement along X.
 * @returns {number} The clipped displacement, same sign as `dx`.
 */
function clipX(world, a, dx) {
  if (dx === 0) return 0;
  _query.copy(a).expandByVelocity(dx, 0, 0);
  const list = world.getCollisionAABBs(_query, _boxes);
  let d = dx;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (a.maxY <= b[1] + EPSILON || a.minY >= b[4] - EPSILON) continue;
    if (a.maxZ <= b[2] + EPSILON || a.minZ >= b[5] - EPSILON) continue;
    if (d > 0) {
      if (b[0] >= a.maxX - EPSILON) {
        const c = b[0] - a.maxX;
        if (c < d) d = c > 0 ? c : 0;
      }
    } else if (b[3] <= a.minX + EPSILON) {
      const c = b[3] - a.minX;
      if (c > d) d = c < 0 ? c : 0;
    }
  }
  return d;
}

/**
 * Longest distance the box may travel along Z before touching solid geometry.
 * @param {Object} world World providing `getCollisionAABBs`.
 * @param {AABB} a Moving box, at its current position.
 * @param {number} dz Desired displacement along Z.
 * @returns {number} The clipped displacement, same sign as `dz`.
 */
function clipZ(world, a, dz) {
  if (dz === 0) return 0;
  _query.copy(a).expandByVelocity(0, 0, dz);
  const list = world.getCollisionAABBs(_query, _boxes);
  let d = dz;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (a.maxX <= b[0] + EPSILON || a.minX >= b[3] - EPSILON) continue;
    if (a.maxY <= b[1] + EPSILON || a.minY >= b[4] - EPSILON) continue;
    if (d > 0) {
      if (b[2] >= a.maxZ - EPSILON) {
        const c = b[2] - a.maxZ;
        if (c < d) d = c > 0 ? c : 0;
      }
    } else if (b[5] <= a.minZ + EPSILON) {
      const c = b[5] - a.minZ;
      if (c > d) d = c < 0 ? c : 0;
    }
  }
  return d;
}

/**
 * Whether solid geometry supports the box when it is offset horizontally.
 * Used by the sneak ledge guard: a thin slab directly under the (shifted) feet
 * is queried, so an entity may overhang an edge exactly as far as its own
 * footprint allows and not one voxel further.
 * @param {Object} world World providing `getCollisionAABBs`.
 * @param {AABB} a Box at its current position.
 * @param {number} ox Horizontal offset along X to test.
 * @param {number} oz Horizontal offset along Z to test.
 * @param {number} depth Probe depth below the feet, in blocks.
 * @returns {boolean} `true` when something solid is underneath.
 */
function hasSupport(world, a, ox, oz, depth) {
  _query.set(a.minX + ox, a.minY - depth, a.minZ + oz,
    a.maxX + ox, a.minY, a.maxZ + oz);
  return world.getCollisionAABBs(_query, _boxes).length > 0;
}

/**
 * Shrink a horizontal displacement until the entity still has ground under its
 * feet, in 5 cm steps (the classic sneak-edge behaviour).
 * @param {Object} world World providing `getCollisionAABBs`.
 * @param {AABB} a Box at its current position.
 * @param {number} dx Desired displacement along X.
 * @param {number} dz Desired displacement along Z.
 * @param {number} axis `0` = shrink X only, `1` = shrink Z only, `2` = both.
 * @param {number} depth Probe depth below the feet.
 * @returns {number} The surviving displacement of the requested axis
 *   (for `axis === 2` the X component; the Z component is scaled identically).
 */
function shrinkForLedge(world, a, dx, dz, axis, depth) {
  const stepSize = 0.05;
  let x = axis === 1 ? 0 : dx;
  let z = axis === 0 ? 0 : dz;
  for (let guard = 0; guard < 64; guard++) {
    if (x === 0 && z === 0) break;
    if (hasSupport(world, a, x, z, depth)) break;
    if (axis !== 1 && x !== 0) {
      if (Math.abs(x) <= stepSize) x = 0;
      else x -= x > 0 ? stepSize : -stepSize;
    }
    if (axis !== 0 && z !== 0) {
      if (Math.abs(z) <= stepSize) z = 0;
      else z -= z > 0 ? stepSize : -stepSize;
    }
  }
  return axis === 1 ? z : x;
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Allocate a fresh result object for {@link moveWithCollisions}. Callers that
 * move something every tick should create one of these once and pass it in.
 * @returns {{onGround:boolean, hitX:boolean, hitY:boolean, hitZ:boolean,
 *   stepped:boolean, position:number[], velocity:number[],
 *   impactX:number, impactY:number, impactZ:number, distance:number}}
 *   A zeroed result record.
 */
export function createMoveResult() {
  return {
    onGround: false,
    hitX: false,
    hitY: false,
    hitZ: false,
    stepped: false,
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    impactX: 0,
    impactY: 0,
    impactZ: 0,
    distance: 0,
  };
}

/**
 * Whether solid geometry is directly beneath the box.
 * @param {Object} world World providing `getCollisionAABBs`.
 * @param {AABB|ArrayLike<number>} aabb Entity box.
 * @param {number} [tolerance=0.002] Probe depth below the feet, in blocks.
 * @returns {boolean} `true` when the entity is supported.
 */
export function isOnGround(world, aabb, tolerance = 0.002) {
  if (!world || typeof world.getCollisionAABBs !== 'function' || !aabb) return false;
  const minX = comp(aabb, 0);
  const minY = comp(aabb, 1);
  const minZ = comp(aabb, 2);
  const maxX = comp(aabb, 3);
  const maxZ = comp(aabb, 5);
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) return false;
  _query.set(minX, minY - Math.abs(tolerance), minZ, maxX, minY, maxZ);
  return world.getCollisionAABBs(_query, _boxes).length > 0;
}

/**
 * Move an axis-aligned box through the voxel world, resolving collisions on the
 * three axes separately in the order **Y, X, Z**.
 *
 * The box is translated **in place** to its resolved position, and `velocity`
 * is zeroed component-wise on every axis that collided (the pre-collision value
 * survives in `out.impactX/Y/Z`, which is what fall damage and bouncy blocks
 * need). Nothing else is allocated: with an `out` record and a reused `aabb`
 * this is a zero-garbage call.
 *
 * @param {Object} world World exposing `getCollisionAABBs(box, out)`.
 * @param {AABB} aabb Entity box; translated in place to the resolved position.
 * @param {Float32Array|number[]} velocity Velocity in blocks/s, mutated in place.
 * @param {number} dt Elapsed time in seconds.
 * @param {?Object} [out] Result record from {@link createMoveResult}; a fresh
 *   one is allocated when omitted.
 * @param {?{stepHeight?:number, autoStep?:boolean, sneaking?:boolean,
 *   onGround?:boolean, noClip?:boolean, ledgeProbe?:number}} [opts] Behaviour
 *   switches. `onGround` is the state *before* this move and gates both
 *   auto-step and the sneak ledge guard; when omitted it is probed.
 * @returns {{onGround:boolean, hitX:boolean, hitY:boolean, hitZ:boolean,
 *   stepped:boolean, position:number[], velocity:number[],
 *   impactX:number, impactY:number, impactZ:number, distance:number}} `out`.
 */
export function moveWithCollisions(world, aabb, velocity, dt, out = null, opts = null) {
  const res = out || createMoveResult();
  res.onGround = false;
  res.hitX = false;
  res.hitY = false;
  res.hitZ = false;
  res.stepped = false;
  res.impactX = 0;
  res.impactY = 0;
  res.impactZ = 0;
  res.distance = 0;

  if (!aabb || !Number.isFinite(aabb.minX)) {
    warnOnce('aabb', 'moveWithCollisions called without a usable AABB');
    return res;
  }
  if (!velocity || velocity.length < 3) {
    warnOnce('velocity', 'moveWithCollisions called without a usable velocity');
    writeResult(res, aabb, velocity);
    return res;
  }

  // Sanitise the velocity: a single NaN must never poison the entity forever.
  if (!Number.isFinite(velocity[0]) || !Number.isFinite(velocity[1]) || !Number.isFinite(velocity[2])) {
    warnOnce('velocity', 'non-finite velocity clamped to zero');
    velocity[0] = finite(velocity[0], 0);
    velocity[1] = finite(velocity[1], 0);
    velocity[2] = finite(velocity[2], 0);
  }

  const o = opts || EMPTY_OPTS;
  const step = Math.max(0, finite(o.stepHeight, STEP_HEIGHT));
  const autoStep = o.autoStep !== false && step > 0;
  const sneaking = o.sneaking === true;
  const ledgeProbe = Math.max(0.05, finite(o.ledgeProbe, LEDGE_PROBE_DEPTH));

  const t = clamp(finite(dt, 0), 0, 0.25);
  let dx = clamp(velocity[0] * t, -MAX_STEP_DISTANCE, MAX_STEP_DISTANCE);
  let dy = clamp(velocity[1] * t, -MAX_STEP_DISTANCE, MAX_STEP_DISTANCE);
  let dz = clamp(velocity[2] * t, -MAX_STEP_DISTANCE, MAX_STEP_DISTANCE);

  const usable = !!world && typeof world.getCollisionAABBs === 'function';
  if (!usable) warnOnce('world', 'world has no getCollisionAABBs(); moving without collisions');

  if (!usable || o.noClip === true) {
    aabb.offset(dx, dy, dz);
    res.distance = Math.hypot(dx, dy, dz);
    writeResult(res, aabb, velocity);
    return res;
  }

  const wasOnGround = o.onGround !== undefined ? o.onGround === true : isOnGround(world, aabb);
  const startX = aabb.minX;
  const startY = aabb.minY;
  const startZ = aabb.minZ;

  /* ---- 1. Y ------------------------------------------------------------- */
  const dy0 = dy;
  if (dy !== 0) {
    const clipped = clipY(world, aabb, dy);
    if (clipped !== dy) {
      res.hitY = true;
      res.impactY = velocity[1];
      velocity[1] = 0;
    }
    aabb.offset(0, clipped, 0);
  }
  saveBox(aabb, _saveA);

  /* ---- 2. sneak ledge guard --------------------------------------------- */
  if (sneaking && wasOnGround && dy0 <= 0 && (dx !== 0 || dz !== 0)) {
    if (dx !== 0) dx = shrinkForLedge(world, aabb, dx, 0, 0, ledgeProbe);
    if (dz !== 0) dz = shrinkForLedge(world, aabb, 0, dz, 1, ledgeProbe);
    if (dx !== 0 && dz !== 0 && !hasSupport(world, aabb, dx, dz, ledgeProbe)) {
      // The diagonal still leaves the ledge: drop the smaller component first.
      if (Math.abs(dx) < Math.abs(dz)) dx = 0;
      else dz = 0;
      if (dx !== 0 && !hasSupport(world, aabb, dx, 0, ledgeProbe)) dx = 0;
      if (dz !== 0 && !hasSupport(world, aabb, 0, dz, ledgeProbe)) dz = 0;
    }
  }

  /* ---- 3. X, then Z ------------------------------------------------------ */
  const clippedX = clipX(world, aabb, dx);
  aabb.offset(clippedX, 0, 0);
  const clippedZ = clipZ(world, aabb, dz);
  aabb.offset(0, 0, clippedZ);
  let hitX = clippedX !== dx;
  let hitZ = clippedZ !== dz;

  /* ---- 4. auto-step ------------------------------------------------------ */
  if (autoStep && wasOnGround && !sneaking && (hitX || hitZ) && (dx !== 0 || dz !== 0)) {
    saveBox(aabb, _saveB);
    const plainX = aabb.minX - _saveA[0];
    const plainZ = aabb.minZ - _saveA[2];
    const plainSq = plainX * plainX + plainZ * plainZ;

    loadBox(aabb, _saveA);
    const lift = clipY(world, aabb, step);
    let keepStep = false;

    if (lift > 1e-4) {
      aabb.offset(0, lift, 0);
      const sx = clipX(world, aabb, dx);
      aabb.offset(sx, 0, 0);
      const sz = clipZ(world, aabb, dz);
      aabb.offset(0, 0, sz);
      const drop = clipY(world, aabb, -lift);
      aabb.offset(0, drop, 0);

      const gainX = aabb.minX - _saveA[0];
      const gainZ = aabb.minZ - _saveA[2];
      if (gainX * gainX + gainZ * gainZ > plainSq + 1e-8) {
        keepStep = true;
        hitX = sx !== dx;
        hitZ = sz !== dz;
        res.stepped = true;
        // Landing on top of the obstacle counts as a vertical contact.
        if (drop > -lift + 1e-9) {
          res.hitY = true;
          if (velocity[1] < 0) {
            res.impactY = velocity[1];
            velocity[1] = 0;
          }
        }
      }
    }
    if (!keepStep) loadBox(aabb, _saveB);
  }

  if (hitX) {
    res.impactX = velocity[0];
    velocity[0] = 0;
  }
  if (hitZ) {
    res.impactZ = velocity[2];
    velocity[2] = 0;
  }
  res.hitX = hitX;
  res.hitZ = hitZ;

  /* ---- 5. ground state --------------------------------------------------- */
  if (res.stepped) {
    res.onGround = true;
  } else if (res.hitY && dy0 < 0) {
    res.onGround = true;
  } else if (dy0 === 0) {
    // Nothing pushed the entity down this step, so ask the world directly
    // instead of reporting a spurious "airborne".
    res.onGround = isOnGround(world, aabb);
  }

  res.distance = Math.hypot(aabb.minX - startX, aabb.minY - startY, aabb.minZ - startZ);
  writeResult(res, aabb, velocity);
  return res;
}

/**
 * Copy the resolved box and velocity into a result record.
 * @param {Object} res Result record.
 * @param {AABB} aabb Resolved entity box.
 * @param {?ArrayLike<number>} velocity Velocity after resolution.
 * @returns {void}
 */
function writeResult(res, aabb, velocity) {
  res.position[0] = (aabb.minX + aabb.maxX) * 0.5;
  res.position[1] = aabb.minY;
  res.position[2] = (aabb.minZ + aabb.maxZ) * 0.5;
  if (velocity && velocity.length >= 3) {
    res.velocity[0] = velocity[0];
    res.velocity[1] = velocity[1];
    res.velocity[2] = velocity[2];
  }
}

/**
 * Swept test of a moving box against a list of static boxes.
 *
 * Unlike {@link moveWithCollisions} this does **not** resolve anything — it
 * only reports the earliest contact, which is what projectiles, ray-ish checks
 * and the third-person camera arm want.
 *
 * @param {AABB|ArrayLike<number>} aabb The moving box.
 * @param {ArrayLike<number>} velocity Full displacement for the step
 *   (already multiplied by `dt`, i.e. in blocks, not blocks/s).
 * @param {Array<AABB|ArrayLike<number>>} boxes Static candidate boxes.
 * @param {?{t:number, normal:number[]}} [out] Receiver; a fresh object is
 *   allocated when omitted, so hot paths should pass one in.
 * @returns {{t:number, normal:number[]}} Entry time in `[0,1]` (`1` = no hit)
 *   and the contact normal (all zeroes when there is no hit).
 */
export function sweepAABB(aabb, velocity, boxes, out = null) {
  const res = out || { t: 1, normal: [0, 0, 0] };
  res.t = 1;
  res.normal[0] = 0;
  res.normal[1] = 0;
  res.normal[2] = 0;
  if (!aabb || !velocity || !boxes || boxes.length === 0) return res;

  const vx = finite(velocity[0], 0);
  const vy = finite(velocity[1], 0);
  const vz = finite(velocity[2], 0);
  if (vx === 0 && vy === 0 && vz === 0) return res;

  toBox(_sweepSelf, aabb);
  if (!Number.isFinite(_sweepSelf.minX)) return res;

  for (let i = 0; i < boxes.length; i++) {
    const candidate = boxes[i];
    if (!candidate) continue;
    toBox(_sweepOther, candidate);
    if (!Number.isFinite(_sweepOther.minX)) continue;
    const t = _sweepSelf.sweep(_sweepOther, vx, vy, vz, _sweepNormal);
    if (t < res.t) {
      res.t = t;
      res.normal[0] = _sweepNormal[0];
      res.normal[1] = _sweepNormal[1];
      res.normal[2] = _sweepNormal[2];
      if (t <= 0) break;
    }
  }
  return res;
}

/**
 * Fluid contact test for an entity box.
 *
 * Fluid blocks fill their whole voxel, so the submerged fraction is the exact
 * overlap volume of the box with all fluid cells divided by the box volume.
 * A value of `0` means "dry", `1` means "completely under".
 *
 * @param {Object} world World exposing `getBlock(x, y, z)`.
 * @param {AABB|ArrayLike<number>} aabb Entity box.
 * @param {?{water:boolean, lava:boolean, submerged:number}} [out] Receiver; a
 *   fresh object is allocated when omitted.
 * @returns {{water:boolean, lava:boolean, submerged:number}} `out`.
 */
export function isInLiquid(world, aabb, out = null) {
  const res = out || { water: false, lava: false, submerged: 0 };
  res.water = false;
  res.lava = false;
  res.submerged = 0;
  if (!world || typeof world.getBlock !== 'function' || !aabb) return res;

  const minX = comp(aabb, 0);
  const minY = comp(aabb, 1);
  const minZ = comp(aabb, 2);
  const maxX = comp(aabb, 3);
  const maxY = comp(aabb, 4);
  const maxZ = comp(aabb, 5);
  if (!Number.isFinite(minX) || !Number.isFinite(maxZ)) return res;

  const volume = (maxX - minX) * (maxY - minY) * (maxZ - minZ);

  const x0 = Math.floor(minX);
  const y0 = Math.floor(minY);
  const z0 = Math.floor(minZ);
  const x1 = Math.min(x0 + 16, Math.ceil(maxX) - 1);
  const y1 = Math.min(y0 + 32, Math.ceil(maxY) - 1);
  const z1 = Math.min(z0 + 16, Math.ceil(maxZ) - 1);

  let fluid = 0;
  for (let y = y0; y <= y1; y++) {
    const oy = Math.min(maxY, y + 1) - Math.max(minY, y);
    if (oy <= 0) continue;
    for (let z = z0; z <= z1; z++) {
      const oz = Math.min(maxZ, z + 1) - Math.max(minZ, z);
      if (oz <= 0) continue;
      for (let x = x0; x <= x1; x++) {
        const id = world.getBlock(x, y, z);
        if (id === 0 || !isLiquid(id)) continue;
        const ox = Math.min(maxX, x + 1) - Math.max(minX, x);
        if (ox <= 0) continue;
        if (id === B.LAVA) res.lava = true;
        else res.water = true;
        fluid += ox * oy * oz;
      }
    }
  }

  if (volume > 1e-9) {
    res.submerged = clamp(fluid / volume, 0, 1);
  } else if (res.water || res.lava) {
    // Degenerate (zero-volume) box that still sits inside a fluid cell.
    res.submerged = 1;
  }
  return res;
}

/**
 * Integrate gravity into a velocity, clamped to terminal velocity.
 * @param {Float32Array|number[]} velocity Velocity in blocks/s, mutated in place.
 * @param {number} dt Elapsed time in seconds.
 * @param {number} [gravity=GRAVITY] Downward acceleration in blocks/s².
 * @param {number} [terminal=TERMINAL_VELOCITY] Speed cap in blocks/s.
 * @returns {Float32Array|number[]} `velocity`.
 */
export function applyGravity(velocity, dt, gravity = GRAVITY, terminal = TERMINAL_VELOCITY) {
  if (!velocity || velocity.length < 3) return velocity;
  const t = clamp(finite(dt, 0), 0, 0.25);
  if (t <= 0) return velocity;
  const g = finite(gravity, GRAVITY);
  const cap = Math.abs(finite(terminal, TERMINAL_VELOCITY));
  let vy = finite(velocity[1], 0) - g * t;
  if (vy < -cap) vy = -cap;
  else if (vy > cap) vy = cap;
  velocity[1] = vy;
  return velocity;
}

/**
 * Apply frame-rate independent exponential drag.
 * @param {Float32Array|number[]} velocity Velocity in blocks/s, mutated in place.
 * @param {number} dt Elapsed time in seconds.
 * @param {number} kXZ Horizontal drag rate in 1/s.
 * @param {number} [kY=kXZ] Vertical drag rate in 1/s.
 * @returns {Float32Array|number[]} `velocity`.
 */
export function applyDrag(velocity, dt, kXZ, kY = kXZ) {
  if (!velocity || velocity.length < 3) return velocity;
  const t = clamp(finite(dt, 0), 0, 0.25);
  if (t <= 0) return velocity;
  const fxz = Math.exp(-Math.max(0, finite(kXZ, 0)) * t);
  const fy = Math.exp(-Math.max(0, finite(kY, 0)) * t);
  velocity[0] *= fxz;
  velocity[1] *= fy;
  velocity[2] *= fxz;
  return velocity;
}

/**
 * Apply the drag of a medium picked by name.
 * @param {Float32Array|number[]} velocity Velocity in blocks/s, mutated in place.
 * @param {number} dt Elapsed time in seconds.
 * @param {'air'|'water'|'lava'|'cobweb'} medium Medium key of {@link MEDIUM_DRAG}.
 * @param {number} [scale=1] Multiplier on the drag rate (e.g. the submerged
 *   fraction, so a half-submerged entity feels half the water drag).
 * @returns {Float32Array|number[]} `velocity`.
 */
export function applyMediumDrag(velocity, dt, medium, scale = 1) {
  const m = MEDIUM_DRAG[medium] || MEDIUM_DRAG.air;
  const s = clamp(finite(scale, 1), 0, 4);
  return applyDrag(velocity, dt, m.xz * s, m.y * s);
}

/**
 * Apply buoyancy for a partially or fully submerged entity.
 * @param {Float32Array|number[]} velocity Velocity in blocks/s, mutated in place.
 * @param {number} dt Elapsed time in seconds.
 * @param {number} submerged Submerged fraction `0..1` (see {@link isInLiquid}).
 * @param {boolean} [lava=false] `true` for lava, `false` for water.
 * @returns {Float32Array|number[]} `velocity`.
 */
export function applyBuoyancy(velocity, dt, submerged, lava = false) {
  if (!velocity || velocity.length < 3) return velocity;
  const t = clamp(finite(dt, 0), 0, 0.25);
  const s = clamp(finite(submerged, 0), 0, 1);
  if (t <= 0 || s <= 0) return velocity;
  velocity[1] += (lava ? BUOYANCY.lava : BUOYANCY.water) * s * t;
  return velocity;
}

/**
 * Push overlapping entities apart horizontally.
 *
 * Uses a uniform spatial hash so a crowded chunk stays linear instead of
 * quadratic. Entities opt out with `noPush === true`, and dead entities are
 * skipped. Only velocities are modified — positions move on the next
 * {@link moveWithCollisions} call, so pushing can never shove anything through
 * a wall.
 *
 * @param {Array<Object>|{forEach:Function}} entities Entities with
 *   `position[3]`, `velocity[3]` and optionally `width` / `aabb` / `noPush`.
 * @param {number} dt Elapsed time in seconds.
 * @param {number} [strength=6] Separation acceleration in blocks/s².
 * @returns {number} Number of overlapping pairs that were resolved.
 */
export function resolveEntityPush(entities, dt, strength = 6) {
  const t = clamp(finite(dt, 0), 0, 0.25);
  if (!entities || t <= 0) return 0;

  // ---- gather -------------------------------------------------------------
  let n = 0;
  const collect = (e) => {
    if (!e || e.noPush === true || e.dead === true || e.removed === true) return;
    const p = e.position;
    const v = e.velocity;
    if (!p || p.length < 3 || !v || v.length < 3) return;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return;
    _pushList[n++] = e;
  };
  if (Array.isArray(entities)) {
    for (let i = 0; i < entities.length; i++) collect(entities[i]);
  } else if (typeof entities.forEach === 'function') {
    entities.forEach(collect);
  } else if (entities.entities && typeof entities.entities.forEach === 'function') {
    entities.entities.forEach(collect);
  }
  for (let i = _pushList.length - 1; i >= n; i--) _pushList.pop();
  if (n < 2) return 0;

  // ---- bucket -------------------------------------------------------------
  _pushCells.forEach(recycleBucket);
  _pushCells.clear();
  const CELL = 2;
  for (let i = 0; i < n; i++) {
    const p = _pushList[i].position;
    const key = cellKey(Math.floor(p[0] / CELL), Math.floor(p[2] / CELL));
    let bucket = _pushCells.get(key);
    if (bucket === undefined) {
      bucket = _pushPool.pop() || [];
      bucket.length = 0;
      _pushCells.set(key, bucket);
    }
    bucket.push(i);
  }

  // ---- resolve ------------------------------------------------------------
  let pairs = 0;
  const accel = Math.max(0, finite(strength, 6));
  for (let i = 0; i < n; i++) {
    const a = _pushList[i];
    const pa = a.position;
    const cx = Math.floor(pa[0] / CELL);
    const cz = Math.floor(pa[2] / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const bucket = _pushCells.get(cellKey(cx + ox, cz + oz));
        if (bucket === undefined) continue;
        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          if (j <= i) continue;
          if (pushPair(a, _pushList[j], i, j, accel, t)) pairs++;
        }
      }
    }
  }
  return pairs;
}

/**
 * Return a bucket array to the pool.
 * @param {number[]} bucket Bucket to recycle.
 * @returns {void}
 */
function recycleBucket(bucket) {
  bucket.length = 0;
  if (_pushPool.length < 256) _pushPool.push(bucket);
}

/**
 * Hash a spatial-hash cell coordinate pair into a single integer key.
 * @param {number} cx Cell X.
 * @param {number} cz Cell Z.
 * @returns {number} Integer key.
 */
function cellKey(cx, cz) {
  return ((cx & 0xffff) << 16) | (cz & 0xffff);
}

/**
 * Horizontal radius of an entity.
 * @param {Object} e Entity.
 * @returns {number} Radius in blocks.
 */
function entityRadius(e) {
  if (e.aabb && Number.isFinite(e.aabb.minX)) {
    return Math.max(0.05, (e.aabb.maxX - e.aabb.minX) * 0.5);
  }
  return Math.max(0.05, finite(e.width, 0.6) * 0.5);
}

/**
 * Vertical span of an entity as `[bottom, top]`, written into a scratch pair.
 * @param {Object} e Entity.
 * @param {number[]} out Two-element receiver.
 * @returns {number[]} `out`.
 */
function entitySpan(e, out) {
  if (e.aabb && Number.isFinite(e.aabb.minY)) {
    out[0] = e.aabb.minY;
    out[1] = e.aabb.maxY;
  } else {
    out[0] = e.position[1];
    out[1] = e.position[1] + Math.max(0.05, finite(e.height, 1.8));
  }
  return out;
}

/** Scratch vertical spans for {@link pushPair}. @type {number[]} */
const _spanA = [0, 0];
/** Scratch vertical spans for {@link pushPair}. @type {number[]} */
const _spanB = [0, 0];

/**
 * Push one overlapping pair apart.
 * @param {Object} a First entity.
 * @param {Object} b Second entity.
 * @param {number} ia Index of `a` (used for deterministic tie-breaking).
 * @param {number} ib Index of `b`.
 * @param {number} accel Separation acceleration in blocks/s².
 * @param {number} dt Elapsed time in seconds.
 * @returns {boolean} `true` when the pair overlapped and was pushed.
 */
function pushPair(a, b, ia, ib, accel, dt) {
  const pa = a.position;
  const pb = b.position;
  let dx = pb[0] - pa[0];
  let dz = pb[2] - pa[2];
  const r = entityRadius(a) + entityRadius(b);
  let d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return false;

  entitySpan(a, _spanA);
  entitySpan(b, _spanB);
  if (_spanA[1] <= _spanB[0] || _spanB[1] <= _spanA[0]) return false;

  let d = Math.sqrt(d2);
  if (d < 1e-4) {
    // Perfectly stacked: separate along a stable pseudo-random axis so the
    // result does not depend on iteration order.
    const angle = ((ia * 2654435761 + ib * 40503) % 6283) * 0.001;
    dx = Math.cos(angle);
    dz = Math.sin(angle);
    d = 1;
    d2 = 1;
  }
  const inv = 1 / d;
  dx *= inv;
  dz *= inv;

  const overlap = clamp((r - d) / r, 0, 1);
  const f = Math.min(accel * overlap * dt, 0.5);
  const wa = a.pushWeight === undefined ? 1 : clamp(finite(a.pushWeight, 1), 0, 1);
  const wb = b.pushWeight === undefined ? 1 : clamp(finite(b.pushWeight, 1), 0, 1);

  a.velocity[0] -= dx * f * wa;
  a.velocity[2] -= dz * f * wa;
  b.velocity[0] += dx * f * wb;
  b.velocity[2] += dz * f * wb;
  return true;
}
