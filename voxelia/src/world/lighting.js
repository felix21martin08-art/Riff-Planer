/**
 * @file VOXELIA colored voxel light engine (spec 5.12).
 *
 * Four independent 4-bit channels live in every voxel: red, green and blue
 * block light plus sky light, packed into the section light array by
 * `world/chunk.js` ({@link packLight}).
 *
 * * **Sky light** is seeded per column from the chunk heightmap: every voxel
 *   above the topmost light blocking block starts at 15. Propagation costs one
 *   level per step plus the target block's `lightAbsorb`; a full strength (15)
 *   column falls straight down through transparent blocks for free, which is
 *   what makes shafts and overhangs look right without lighting up whole caves.
 * * **Block light** floods out of every emitting block, once per channel, so a
 *   red torch next to a blue lamp blends to magenta instead of overwriting.
 * * **Removal** uses the classic two queue algorithm: the removal BFS zeroes
 *   everything that was fed by the vanished source and re-queues the surviving
 *   sources it bumps into, then the add BFS refills the hole.
 *
 * All queue nodes are packed integers inside typed-array ring buffers, so
 * draining the queues never allocates. `process()` is time budgeted and marks
 * every touched section (and the neighbours that sample it) dirty.
 *
 * Worker safe: no `document`, no `window`.
 */

import { TimeBudget } from '../core/util.js';
import { ABSORB_TABLE, EMISSION_RGB, BLOCK_COUNT } from './blocks.js';
import {
  CHUNK_SIZE,
  SECTION_SIZE,
  SECTION_COUNT,
  SECTION_VOLUME,
  COLUMN_COUNT,
  WORLD_MIN_Y,
  WORLD_MAX_Y,
  MAX_LIGHT,
  chunkKey,
} from './chunk.js';

// ---------------------------------------------------------------------------
// Channel / direction tables
// ---------------------------------------------------------------------------

/** Red block light channel index. @type {number} */
export const CH_RED = 0;
/** Green block light channel index. @type {number} */
export const CH_GREEN = 1;
/** Blue block light channel index. @type {number} */
export const CH_BLUE = 2;
/** Sky light channel index. @type {number} */
export const CH_SKY = 3;

/** Face direction order, matching spec 3.1: 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z. */
const DIR_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
const DIR_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
const DIR_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);
/** Index of the -Y direction inside the direction tables. */
const DIR_DOWN = 3;

/** Neighbour chunk offsets used by {@link LightEngine#queueChunkBorders}. */
const BORDER_DX = new Int8Array([1, -1, 0, 0]);
const BORDER_DZ = new Int8Array([0, 0, 1, -1]);

/** Integers stored per queued node: x, y, z, meta. */
const NODE_STRIDE = 4;

/** How many nodes are processed between two clock reads. */
const BUDGET_CHECK_INTERVAL = 192;

/** Ring buffer capacity (in nodes) the queues shrink back to when idle. */
const QUEUE_IDLE_CAPACITY = 4096;

/**
 * `1` for every block id that emits light in at least one channel. Built once
 * so the per-chunk emitter scan is a single typed-array lookup per voxel.
 * @type {Uint8Array}
 */
const EMITTER = (() => {
  const t = new Uint8Array(BLOCK_COUNT);
  for (let id = 0; id < BLOCK_COUNT; id++) {
    const i = id * 3;
    if (EMISSION_RGB[i] > 0 || EMISSION_RGB[i + 1] > 0 || EMISSION_RGB[i + 2] > 0) t[id] = 1;
  }
  return t;
})();

/**
 * Light absorption of a block id, tolerant of unknown ids.
 * @param {number} id Block id.
 * @returns {number} Absorption 0..15.
 */
function absorbOf(id) {
  const a = ABSORB_TABLE[id];
  return a === undefined ? 0 : a;
}

// ---------------------------------------------------------------------------
// Packed node ring buffer
// ---------------------------------------------------------------------------

/**
 * FIFO ring buffer of `(x, y, z, meta)` int32 quadruplets. Popping writes the
 * node into the `a`/`b`/`c`/`d` fields instead of returning an object, so a
 * full drain never allocates.
 */
class LightQueue {
  /**
   * @param {number} [capacity=1024] Initial capacity in nodes; rounded up to a
   *   power of two.
   */
  constructor(capacity = 1024) {
    let cap = 16;
    while (cap < capacity) cap <<= 1;
    /** @type {number} Capacity in nodes (always a power of two). */
    this.capacity = cap;
    /** @type {Int32Array} Backing storage, `capacity * NODE_STRIDE` ints. */
    this.data = new Int32Array(cap * NODE_STRIDE);
    /** @type {number} `capacity - 1`, used instead of a modulo. */
    this.mask = cap - 1;
    /** @type {number} Index of the oldest node. */
    this.head = 0;
    /** @type {number} Number of queued nodes. */
    this.count = 0;
    /** @type {number} X of the node last popped. */
    this.a = 0;
    /** @type {number} Y of the node last popped. */
    this.b = 0;
    /** @type {number} Z of the node last popped. */
    this.c = 0;
    /** @type {number} Meta word of the node last popped. */
    this.d = 0;
  }

  /**
   * Number of queued nodes.
   * @returns {number} Queue length.
   */
  get size() {
    return this.count;
  }

  /**
   * Append one node.
   * @param {number} a World X.
   * @param {number} b World Y.
   * @param {number} c World Z.
   * @param {number} d Meta word: `level | (channel << 4)`.
   * @returns {void}
   */
  push(a, b, c, d) {
    if (this.count === this.capacity) this._grow();
    const i = ((this.head + this.count) & this.mask) * NODE_STRIDE;
    const buf = this.data;
    buf[i] = a;
    buf[i + 1] = b;
    buf[i + 2] = c;
    buf[i + 3] = d;
    this.count++;
  }

  /**
   * Pop the oldest node into `this.a/b/c/d`.
   * @returns {boolean} `false` when the queue was empty.
   */
  pop() {
    if (this.count === 0) return false;
    const i = this.head * NODE_STRIDE;
    const buf = this.data;
    this.a = buf[i];
    this.b = buf[i + 1];
    this.c = buf[i + 2];
    this.d = buf[i + 3];
    this.head = (this.head + 1) & this.mask;
    this.count--;
    return true;
  }

  /**
   * Double the ring buffer, re-linearising the stored nodes.
   * @returns {void}
   */
  _grow() {
    const cap = this.capacity << 1;
    const next = new Int32Array(cap * NODE_STRIDE);
    const buf = this.data;
    const mask = this.mask;
    for (let n = 0; n < this.count; n++) {
      const src = ((this.head + n) & mask) * NODE_STRIDE;
      const dst = n * NODE_STRIDE;
      next[dst] = buf[src];
      next[dst + 1] = buf[src + 1];
      next[dst + 2] = buf[src + 2];
      next[dst + 3] = buf[src + 3];
    }
    this.data = next;
    this.capacity = cap;
    this.mask = cap - 1;
    this.head = 0;
  }

  /**
   * Drop every queued node.
   * @returns {void}
   */
  clear() {
    this.head = 0;
    this.count = 0;
  }

  /**
   * Release an oversized buffer once the queue has drained.
   * @param {number} [target=QUEUE_IDLE_CAPACITY] Capacity to shrink back to.
   * @returns {void}
   */
  shrink(target = QUEUE_IDLE_CAPACITY) {
    if (this.count !== 0 || this.capacity <= target) return;
    let cap = 16;
    while (cap < target) cap <<= 1;
    this.capacity = cap;
    this.data = new Int32Array(cap * NODE_STRIDE);
    this.mask = cap - 1;
    this.head = 0;
  }
}

// ---------------------------------------------------------------------------
// LightEngine
// ---------------------------------------------------------------------------

/**
 * Incremental colored flood-fill light engine operating on the chunks of a
 * {@link World}. Nodes that point into chunks which are not loaded are skipped;
 * {@link LightEngine#queueChunkBorders} re-injects them once the neighbour
 * arrives.
 */
export class LightEngine {
  /**
   * @param {{getChunk?:function(number, number):object, chunks?:Map<string, object>}} world
   *   The chunk owner. Only `getChunk(cx, cz)` (or a `chunks` map) is used.
   */
  constructor(world) {
    /** @type {object} The world this engine lights. */
    this.world = world;
    /** @type {LightQueue} Brightening BFS queue. */
    this.addQueue = new LightQueue(QUEUE_IDLE_CAPACITY);
    /** @type {LightQueue} Darkening BFS queue, always drained first. */
    this.removeQueue = new LightQueue(1024);
    /** @type {TimeBudget} Reused budget clock for {@link LightEngine#process}. */
    this.budget = new TimeBudget(3);
    /** @type {number} Total nodes processed since construction. */
    this.totalProcessed = 0;

    // Single entry chunk caches. Reset whenever a public method is entered,
    // because chunks may have been loaded or unloaded in between.
    this._cx = 0x7fffffff;
    this._cz = 0x7fffffff;
    /** @type {object|null} */
    this._cc = null;
    this._mx = 0x7fffffff;
    this._mz = 0x7fffffff;
    /** @type {object|null} */
    this._mc = null;
  }

  /**
   * Number of queued light nodes still waiting to be processed.
   * @returns {number} Pending node count.
   */
  get pending() {
    return this.addQueue.count + this.removeQueue.count;
  }

  /**
   * Drop every queued node and reset the internal chunk caches.
   * @returns {void}
   */
  clear() {
    this.addQueue.clear();
    this.removeQueue.clear();
    this.addQueue.shrink();
    this.removeQueue.shrink(1024);
    this._resetCache();
  }

  // -- chunk access --------------------------------------------------------

  /**
   * Invalidate the chunk lookup caches.
   * @returns {void}
   */
  _resetCache() {
    this._cx = 0x7fffffff;
    this._cz = 0x7fffffff;
    this._cc = null;
    this._mx = 0x7fffffff;
    this._mz = 0x7fffffff;
    this._mc = null;
  }

  /**
   * Uncached chunk lookup.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @returns {object|null} The chunk, or `null` when it is not loaded.
   */
  _lookupChunk(cx, cz) {
    const w = this.world;
    if (!w) return null;
    if (typeof w.getChunk === 'function') return w.getChunk(cx, cz) || null;
    if (w.chunks && typeof w.chunks.get === 'function') return w.chunks.get(chunkKey(cx, cz)) || null;
    return null;
  }

  /**
   * Cached chunk lookup used by the propagation loops.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @returns {object|null} The chunk, or `null` when it is not loaded.
   */
  _chunkAt(cx, cz) {
    if (cx === this._cx && cz === this._cz) return this._cc;
    const c = this._lookupChunk(cx, cz);
    this._cx = cx;
    this._cz = cz;
    this._cc = c;
    return c;
  }

  /**
   * Cached chunk lookup used by dirty marking, kept separate so it never
   * evicts the propagation cache.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @returns {object|null} The chunk, or `null` when it is not loaded.
   */
  _markChunkAt(cx, cz) {
    if (cx === this._mx && cz === this._mz) return this._mc;
    const c = this._lookupChunk(cx, cz);
    this._mx = cx;
    this._mz = cz;
    this._mc = c;
    return c;
  }

  // -- light access --------------------------------------------------------

  /**
   * Read one light channel at world coordinates.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} ch Channel index 0..3.
   * @returns {number} Level 0..15, or -1 when the chunk is not loaded.
   */
  _getLevel(x, y, z, ch) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return ch === CH_SKY && y >= WORLD_MAX_Y ? MAX_LIGHT : 0;
    const c = this._chunkAt(x >> 4, z >> 4);
    if (c === null) return -1;
    return (c.getLightPacked(x & 15, y, z & 15) >> (ch << 2)) & 15;
  }

  /**
   * Write one light channel at world coordinates and mark the affected
   * sections dirty.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} ch Channel index 0..3.
   * @param {number} v Level 0..15.
   * @returns {boolean} `true` when the stored value changed.
   */
  _setLevel(x, y, z, ch, v) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return false;
    const c = this._chunkAt(x >> 4, z >> 4);
    if (c === null) return false;
    const lx = x & 15;
    const lz = z & 15;
    const shift = ch << 2;
    const cur = c.getLightPacked(lx, y, lz);
    const next = (cur & ~(15 << shift)) | ((v & 15) << shift);
    if (next === cur) return false;
    c.setLightPacked(lx, y, lz, next);
    this._markDirty(c, x, y, z);
    return true;
  }

  /**
   * Mark the section owning a voxel dirty, plus every neighbouring section that
   * samples it through the mesher's 18^3 neighbourhood.
   * @param {object} chunk Chunk owning the voxel.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   */
  _markDirty(chunk, x, y, z) {
    const yy = y - WORLD_MIN_Y;
    const sy = yy >> 4;
    if (sy < 0 || sy >= SECTION_COUNT) return;
    chunk.markSectionDirty(sy);
    const lx = x & 15;
    const lz = z & 15;
    const ly = yy & 15;
    const dx = lx === 0 ? -1 : lx === 15 ? 1 : 0;
    const dz = lz === 0 ? -1 : lz === 15 ? 1 : 0;
    const dy = ly === 0 ? -1 : ly === 15 ? 1 : 0;
    if (dy !== 0) chunk.markSectionDirty(sy + dy);
    if (dx === 0 && dz === 0) return;
    const cx = x >> 4;
    const cz = z >> 4;
    if (dx !== 0) this._markNeighbour(cx + dx, cz, sy, dy);
    if (dz !== 0) this._markNeighbour(cx, cz + dz, sy, dy);
    if (dx !== 0 && dz !== 0) this._markNeighbour(cx + dx, cz + dz, sy, dy);
  }

  /**
   * Mark one section of a neighbouring chunk dirty.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @param {number} sy Section index.
   * @param {number} dy `-1`, `0` or `1`: also mark the vertical neighbour.
   * @returns {void}
   */
  _markNeighbour(cx, cz, sy, dy) {
    const c = this._markChunkAt(cx, cz);
    if (c === null) return;
    c.markSectionDirty(sy);
    if (dy !== 0) c.markSectionDirty(sy + dy);
  }

  // -- chunk initialisation ------------------------------------------------

  /**
   * Seed the sky light of a freshly generated chunk and queue the boundary
   * voxels the flood fill has to continue from. Also seeds every emitting block
   * of the chunk (there is no separate hook in the module contract), so calling
   * this once per chunk is all that is required to light it.
   * @param {object} chunk The chunk to initialise.
   * @returns {void}
   */
  initChunkSkylight(chunk) {
    this._resetCache();
    if (!chunk) return;
    const hm = chunk.heightmap;
    let minH = 0x7fffffff;
    let maxH = -0x7fffffff;
    for (let i = 0; i < COLUMN_COUNT; i++) {
      const h = hm[i];
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    chunk.maxHeight = maxH;

    // 1. Materialised sections: fill their sky-exposed voxels with 15. Sections
    //    that do not exist keep answering from the heightmap for free.
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const s = chunk.sections[sy];
      if (s === null) continue;
      const base = WORLD_MIN_Y + sy * SECTION_SIZE;
      const top = base + SECTION_SIZE;
      if (base >= maxH) {
        s.setUniformSky(true);
        continue;
      }
      if (top <= minH) continue;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const h = hm[(lz << 4) | lx];
          if (h >= top) continue;
          const y0 = h > base ? h - base : 0;
          for (let ly = y0; ly < SECTION_SIZE; ly++) s.setSkyLight(lx, ly, lz, MAX_LIGHT);
        }
      }
      chunk.dirtySections.add(sy);
    }

    // 2. Queue the lit voxels that actually border darkness: the lowest sky lit
    //    voxel of every column plus everything up to the tallest neighbour.
    const ox = chunk.cx * CHUNK_SIZE;
    const oz = chunk.cz * CHUNK_SIZE;
    const meta = MAX_LIGHT | (CH_SKY << 4);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const h = hm[(lz << 4) | lx];
        if (h >= WORLD_MAX_Y) continue;
        const wx = ox + lx;
        const wz = oz + lz;
        let yTop = h + 1;
        let n = this._heightAt(wx + 1, wz);
        if (n > yTop) yTop = n;
        n = this._heightAt(wx - 1, wz);
        if (n > yTop) yTop = n;
        n = this._heightAt(wx, wz + 1);
        if (n > yTop) yTop = n;
        n = this._heightAt(wx, wz - 1);
        if (n > yTop) yTop = n;
        if (yTop > WORLD_MAX_Y) yTop = WORLD_MAX_Y;
        for (let y = h < WORLD_MIN_Y ? WORLD_MIN_Y : h; y < yTop; y++) {
          this.addQueue.push(wx, y, wz, meta);
        }
      }
    }

    this.initChunkBlockLight(chunk);
    chunk.lit = true;
  }

  /**
   * Column height of a world position, `WORLD_MIN_Y` when the chunk is not
   * loaded (the border pass fixes those columns later).
   * @param {number} x World X.
   * @param {number} z World Z.
   * @returns {number} Column height.
   */
  _heightAt(x, z) {
    const c = this._chunkAt(x >> 4, z >> 4);
    if (c === null) return WORLD_MIN_Y;
    return c.getHeight(x & 15, z & 15);
  }

  /**
   * Seed every emitting block of a chunk into the add queue.
   * @param {object} chunk The chunk to scan.
   * @returns {number} Number of emitters found.
   */
  initChunkBlockLight(chunk) {
    if (!chunk) return 0;
    const ox = chunk.cx * CHUNK_SIZE;
    const oz = chunk.cz * CHUNK_SIZE;
    let found = 0;
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const s = chunk.sections[sy];
      if (s === null || s.blocks === null) continue;
      const blocks = s.blocks;
      const base = WORLD_MIN_Y + sy * SECTION_SIZE;
      for (let i = 0; i < SECTION_VOLUME; i++) {
        const id = blocks[i];
        if (id === 0 || EMITTER[id] !== 1) continue;
        found++;
        const lx = i & 15;
        const lz = (i >> 4) & 15;
        const ly = (i >> 8) & 15;
        const wx = ox + lx;
        const wy = base + ly;
        const wz = oz + lz;
        const e = id * 3;
        const cur = s.getLight(lx, ly, lz);
        let next = cur;
        for (let ch = 0; ch < 3; ch++) {
          const level = EMISSION_RGB[e + ch];
          if (level === 0) continue;
          const shift = ch << 2;
          if (((next >> shift) & 15) < level) next = (next & ~(15 << shift)) | (level << shift);
          this.addQueue.push(wx, wy, wz, level | (ch << 4));
        }
        if (next !== cur) {
          s.setLight(lx, ly, lz, next);
          chunk.markSectionDirty(sy);
        }
      }
    }
    return found;
  }

  /**
   * Re-propagate light across the four borders of a chunk that just became
   * available. Only voxel pairs that can actually push light are queued, so the
   * scan is cheap even though it walks the whole shared face.
   * @param {object} chunk The freshly loaded chunk.
   * @returns {void}
   */
  queueChunkBorders(chunk) {
    this._resetCache();
    if (!chunk) return;
    for (let d = 0; d < 4; d++) {
      const n = this._lookupChunk(chunk.cx + BORDER_DX[d], chunk.cz + BORDER_DZ[d]);
      if (n === null) continue;
      this._scanBorder(chunk, n, d);
    }
  }

  /**
   * Compare the two sides of one chunk border and queue every voxel that can
   * brighten its counterpart.
   * @param {object} a The chunk `queueChunkBorders` was called for.
   * @param {object} b The neighbour chunk.
   * @param {number} d Border index: 0=+X, 1=-X, 2=+Z, 3=-Z.
   * @returns {void}
   */
  _scanBorder(a, b, d) {
    const aox = a.cx * CHUNK_SIZE;
    const aoz = a.cz * CHUNK_SIZE;
    const box = b.cx * CHUNK_SIZE;
    const boz = b.cz * CHUNK_SIZE;
    for (let i = 0; i < CHUNK_SIZE; i++) {
      let alx;
      let alz;
      let blx;
      let blz;
      if (d === 0) {
        alx = 15;
        alz = i;
        blx = 0;
        blz = i;
      } else if (d === 1) {
        alx = 0;
        alz = i;
        blx = 15;
        blz = i;
      } else if (d === 2) {
        alx = i;
        alz = 15;
        blx = i;
        blz = 0;
      } else {
        alx = i;
        alz = 0;
        blx = i;
        blz = 15;
      }
      const ha = a.heightmap[(alz << 4) | alx];
      const hb = b.heightmap[(blz << 4) | blx];
      let yTop = (ha > hb ? ha : hb) + MAX_LIGHT + 1;
      if (yTop > WORLD_MAX_Y) yTop = WORLD_MAX_Y;
      const awx = aox + alx;
      const awz = aoz + alz;
      const bwx = box + blx;
      const bwz = boz + blz;
      for (let y = WORLD_MIN_Y; y < yTop; y++) {
        const pa = a.getLightPacked(alx, y, alz);
        const pb = b.getLightPacked(blx, y, blz);
        if (pa === pb) continue;
        const costIntoB = 1 + absorbOf(b.getBlock(blx, y, blz));
        const costIntoA = 1 + absorbOf(a.getBlock(alx, y, alz));
        for (let ch = 0; ch < 4; ch++) {
          const shift = ch << 2;
          const la = (pa >> shift) & 15;
          const lb = (pb >> shift) & 15;
          if (la - costIntoB > lb) this.addQueue.push(awx, y, awz, la | (ch << 4));
          else if (lb - costIntoA > la) this.addQueue.push(bwx, y, bwz, lb | (ch << 4));
        }
      }
    }
  }

  // -- incremental updates -------------------------------------------------

  /**
   * Queue exactly the work a single block change causes. Call this *after* the
   * world stored the new block, so the chunk heightmap is already up to date.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} oldId Previous block id.
   * @param {number} newId New block id.
   * @returns {void}
   */
  onBlockChanged(x, y, z, oldId, newId) {
    this._resetCache();
    if (oldId === newId) return;
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
    const chunk = this._chunkAt(x >> 4, z >> 4);
    if (chunk === null) return;

    const oldAbsorb = absorbOf(oldId);
    const newAbsorb = absorbOf(newId);
    const oe = oldId * 3;
    const ne = newId * 3;

    // Block light: one independent pass per channel.
    for (let ch = 0; ch < 3; ch++) {
      const oldEmit = EMISSION_RGB[oe + ch] || 0;
      const newEmit = EMISSION_RGB[ne + ch] || 0;
      if (oldAbsorb === newAbsorb && oldEmit === newEmit) continue;
      const cur = this._getLevel(x, y, z, ch);
      if (cur > 0) {
        this._setLevel(x, y, z, ch, 0);
        this.removeQueue.push(x, y, z, cur | (ch << 4));
      }
      if (newEmit > 0 && newAbsorb < MAX_LIGHT) {
        this._setLevel(x, y, z, ch, newEmit);
        this.addQueue.push(x, y, z, newEmit | (ch << 4));
      }
      this._queueNeighbourAdds(x, y, z, ch);
    }

    // Sky light: only an opacity change can alter it.
    if (oldAbsorb !== newAbsorb) {
      const cur = this._getLevel(x, y, z, CH_SKY);
      if (cur > 0) {
        this._setLevel(x, y, z, CH_SKY, 0);
        this.removeQueue.push(x, y, z, cur | (CH_SKY << 4));
      }
      if (newAbsorb < MAX_LIGHT && y >= chunk.getHeight(x & 15, z & 15)) {
        this._setLevel(x, y, z, CH_SKY, MAX_LIGHT);
        this.addQueue.push(x, y, z, MAX_LIGHT | (CH_SKY << 4));
      }
      this._queueNeighbourAdds(x, y, z, CH_SKY);
    }
  }

  /**
   * Queue the six neighbours of a voxel so their light can flow back into it.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} ch Channel index 0..3.
   * @returns {void}
   */
  _queueNeighbourAdds(x, y, z, ch) {
    for (let d = 0; d < 6; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      const nz = z + DIR_DZ[d];
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
      const level = this._getLevel(nx, ny, nz, ch);
      if (level > 1) this.addQueue.push(nx, ny, nz, level | (ch << 4));
    }
  }

  // -- propagation ---------------------------------------------------------

  /**
   * Drain the removal queue first and then the add queue, staying inside a time
   * budget. Every write marks the touched sections dirty on their chunk.
   * @param {number} [budgetMs=3] Milliseconds this call may spend.
   * @returns {number} Number of queue nodes processed.
   */
  process(budgetMs = 3) {
    this._resetCache();
    const budget = this.budget;
    budget.setBudget(budgetMs);
    budget.start();
    const remove = this.removeQueue;
    const add = this.addQueue;
    let processed = 0;
    let sinceCheck = 0;

    while (remove.count > 0) {
      remove.pop();
      this._processRemove(remove.a, remove.b, remove.c, remove.d);
      processed++;
      if (++sinceCheck >= BUDGET_CHECK_INTERVAL) {
        sinceCheck = 0;
        if (budget.expired()) {
          this.totalProcessed += processed;
          return processed;
        }
      }
    }

    while (add.count > 0) {
      add.pop();
      this._processAdd(add.a, add.b, add.c, add.d);
      processed++;
      if (++sinceCheck >= BUDGET_CHECK_INTERVAL) {
        sinceCheck = 0;
        if (budget.expired()) {
          this.totalProcessed += processed;
          return processed;
        }
      }
    }

    add.shrink();
    remove.shrink(1024);
    this.totalProcessed += processed;
    return processed;
  }

  /**
   * Spread one channel of one voxel into its six neighbours.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} meta `level | (channel << 4)` as queued.
   * @returns {void}
   */
  _processAdd(x, y, z, meta) {
    const ch = meta >> 4;
    const shift = ch << 2;
    const home = this._chunkAt(x >> 4, z >> 4);
    if (home === null) return;
    const cur = (home.getLightPacked(x & 15, y, z & 15) >> shift) & 15;
    if (cur <= 0) return;
    const isSky = ch === CH_SKY;
    const freeFall = isSky && cur === MAX_LIGHT;
    for (let d = 0; d < 6; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      const nz = z + DIR_DZ[d];
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
      const c = this._chunkAt(nx >> 4, nz >> 4);
      if (c === null) continue;
      const lx = nx & 15;
      const lz = nz & 15;
      const absorb = absorbOf(c.getBlock(lx, ny, lz));
      if (absorb >= MAX_LIGHT) continue;
      const next = cur - (freeFall && d === DIR_DOWN ? absorb : 1 + absorb);
      if (next <= 0) continue;
      const packed = c.getLightPacked(lx, ny, lz);
      if (((packed >> shift) & 15) >= next) continue;
      c.setLightPacked(lx, ny, lz, (packed & ~(15 << shift)) | (next << shift));
      this._markDirty(c, nx, ny, nz);
      this.addQueue.push(nx, ny, nz, next | (ch << 4));
    }
  }

  /**
   * Darken every neighbour that was fed by a vanished light value and re-queue
   * the independent sources the wavefront runs into.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} meta `oldLevel | (channel << 4)` as queued.
   * @returns {void}
   */
  _processRemove(x, y, z, meta) {
    const ch = meta >> 4;
    const oldLevel = meta & 15;
    if (oldLevel === 0) return;
    const shift = ch << 2;
    const isSky = ch === CH_SKY;
    const fullSky = isSky && oldLevel === MAX_LIGHT;
    for (let d = 0; d < 6; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      const nz = z + DIR_DZ[d];
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
      const c = this._chunkAt(nx >> 4, nz >> 4);
      if (c === null) continue;
      const lx = nx & 15;
      const lz = nz & 15;
      const packed = c.getLightPacked(lx, ny, lz);
      const level = (packed >> shift) & 15;
      if (level === 0) continue;
      // A voxel below a removed full strength sky column was fed by it even
      // though its level is identical (free fall costs nothing).
      const fed = level < oldLevel || (fullSky && d === DIR_DOWN && level === MAX_LIGHT);
      if (!fed) {
        this.addQueue.push(nx, ny, nz, level | (ch << 4));
        continue;
      }
      let cleared = packed & ~(15 << shift);
      if (!isSky) {
        const emit = EMISSION_RGB[c.getBlock(lx, ny, lz) * 3 + ch] || 0;
        if (emit > 0) {
          cleared |= emit << shift;
          this.addQueue.push(nx, ny, nz, emit | (ch << 4));
        }
      }
      c.setLightPacked(lx, ny, lz, cleared);
      this._markDirty(c, nx, ny, nz);
      this.removeQueue.push(nx, ny, nz, level | (ch << 4));
    }
  }
}
