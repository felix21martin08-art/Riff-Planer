/**
 * @file VOXELIA chunk & section voxel storage (spec 5.11).
 *
 * A `Chunk` is a 16 x 384 x 16 column made of 24 stacked `Section`s covering
 * world Y `-64 .. 319`. Hundreds of chunks are live at once, so every buffer is
 * allocated lazily and freed again as soon as it becomes redundant:
 *
 *  * `Section.blocks` — `Uint16Array(4096)`, `null` while the section is pure
 *    air. The array is created on the first non-air write and released again
 *    when `nonAirCount` falls back to zero.
 *  * `Section.light` — `Uint16Array(4096)` packing four 4-bit channels
 *    (bits 0-3 R, 4-7 G, 8-11 B, 12-15 Sky). Also `null` until something is
 *    written; a section that sits entirely above the terrain reports full sky
 *    light through the `uniformSky` flag without allocating anything.
 *
 * This module is worker-safe: it never touches `document` or `window`.
 */

import { ABSORB_TABLE } from './blocks.js';

// ---------------------------------------------------------------------------
// World constants (spec 2)
// ---------------------------------------------------------------------------

/** Horizontal chunk size in blocks, on both X and Z. @type {number} */
export const CHUNK_SIZE = 16;

/** Vertical size of a single section in blocks. @type {number} */
export const SECTION_SIZE = 16;

/** Number of sections stacked in one chunk column. @type {number} */
export const SECTION_COUNT = 24;

/** Total world height in blocks (`SECTION_COUNT * SECTION_SIZE`). @type {number} */
export const WORLD_HEIGHT = 384;

/** Lowest world Y coordinate. @type {number} */
export const WORLD_MIN_Y = -64;

/** Exclusive upper world Y bound: the world range is `[-64, 320)`. @type {number} */
export const WORLD_MAX_Y = WORLD_MIN_Y + WORLD_HEIGHT;

/** Default sea level. @type {number} */
export const SEA_LEVEL = 62;

/** Voxels stored in one section. @type {number} */
export const SECTION_VOLUME = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE;

/** Blocks in one chunk column layer (`CHUNK_SIZE * CHUNK_SIZE`). @type {number} */
export const COLUMN_COUNT = CHUNK_SIZE * CHUNK_SIZE;

/** Maximum value of any single light channel. @type {number} */
export const MAX_LIGHT = 15;

/** Packed light meaning "no block light, full sky light". @type {number} */
export const SKY_FULL_PACKED = 0xf000;

/**
 * Heightmap entry for a column that contains no light blocking block at all.
 * Heights are stored as "world Y of the first block that is fully open to the
 * sky", i.e. `topmostBlockingY + 1`.
 * @type {number}
 */
export const HEIGHTMAP_EMPTY = WORLD_MIN_Y;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Canonical map key for a chunk coordinate pair.
 * @param {number} cx Chunk X coordinate.
 * @param {number} cz Chunk Z coordinate.
 * @returns {string} `"cx,cz"`.
 */
export function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

/**
 * Index of a voxel inside a section: `(y * 16 + z) * 16 + x`.
 * @param {number} x Local X 0..15.
 * @param {number} y Local Y 0..15.
 * @param {number} z Local Z 0..15.
 * @returns {number} Flat index 0..4095.
 */
export function sectionIndex(x, y, z) {
  return ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
}

/**
 * Pack four 4-bit light channels into one uint16.
 * Layout: bits 0-3 red, 4-7 green, 8-11 blue, 12-15 sky.
 * @param {number} r Red block light 0..15.
 * @param {number} g Green block light 0..15.
 * @param {number} b Blue block light 0..15.
 * @param {number} sky Sky light 0..15.
 * @returns {number} Packed uint16 light value.
 */
export function packLight(r, g, b, sky) {
  return (r & 15) | ((g & 15) << 4) | ((b & 15) << 8) | ((sky & 15) << 12);
}

/**
 * Unpack a light value produced by {@link packLight}. Allocates a fresh array,
 * so prefer {@link unpackLightInto} in hot loops.
 * @param {number} v Packed uint16 light value.
 * @returns {number[]} `[r, g, b, sky]`, each 0..15.
 */
export function unpackLight(v) {
  return [v & 15, (v >> 4) & 15, (v >> 8) & 15, (v >> 12) & 15];
}

/**
 * Allocation free variant of {@link unpackLight}.
 * @param {number} v Packed uint16 light value.
 * @param {number[]|Uint8Array|Float32Array} out Target of length >= 4.
 * @returns {number[]|Uint8Array|Float32Array} `out`, filled with `[r,g,b,sky]`.
 */
export function unpackLightInto(v, out) {
  out[0] = v & 15;
  out[1] = (v >> 4) & 15;
  out[2] = (v >> 8) & 15;
  out[3] = (v >> 12) & 15;
  return out;
}

/**
 * Whether a block id stops the sky light column (anything with absorption).
 * @param {number} id Block id.
 * @returns {boolean} `true` when the block blocks sky light.
 */
function blocksSky(id) {
  if (id === 0) return false;
  const a = ABSORB_TABLE[id];
  return a !== undefined && a > 0;
}

/**
 * Normalise a serialized buffer into a `Uint16Array` view without copying when
 * possible. Accepts `ArrayBuffer`, typed arrays and plain arrays.
 * @param {ArrayBuffer|ArrayBufferView|number[]|null|undefined} src Source data.
 * @param {number} length Expected element count.
 * @returns {Uint16Array|null} A view of `length` elements, or `null`.
 */
function toUint16(src, length) {
  if (!src) return null;
  if (src instanceof Uint16Array) return src.length === length ? src : new Uint16Array(src.buffer, src.byteOffset, length);
  if (src instanceof ArrayBuffer) return new Uint16Array(src, 0, length);
  if (ArrayBuffer.isView(src)) return new Uint16Array(src.buffer, src.byteOffset, length);
  if (Array.isArray(src)) return Uint16Array.from(src);
  return null;
}

/**
 * Normalise serialized heightmap data into an `Int16Array`.
 * @param {ArrayBuffer|ArrayBufferView|number[]|null|undefined} src Source data.
 * @param {number} length Expected element count.
 * @returns {Int16Array|null} A view of `length` elements, or `null`.
 */
function toInt16(src, length) {
  if (!src) return null;
  if (src instanceof Int16Array) return src.length === length ? src : new Int16Array(src.buffer, src.byteOffset, length);
  if (src instanceof ArrayBuffer) return new Int16Array(src, 0, length);
  if (ArrayBuffer.isView(src)) return new Int16Array(src.buffer, src.byteOffset, length);
  if (Array.isArray(src)) return Int16Array.from(src);
  return null;
}

/**
 * Normalise serialized biome data into a `Uint8Array`.
 * @param {ArrayBuffer|ArrayBufferView|number[]|null|undefined} src Source data.
 * @param {number} length Expected element count.
 * @returns {Uint8Array|null} A view of `length` elements, or `null`.
 */
function toUint8(src, length) {
  if (!src) return null;
  if (src instanceof Uint8Array) return src.length === length ? src : new Uint8Array(src.buffer, src.byteOffset, length);
  if (src instanceof ArrayBuffer) return new Uint8Array(src, 0, length);
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, length);
  if (Array.isArray(src)) return Uint8Array.from(src);
  return null;
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/**
 * One 16x16x16 slice of a chunk. Blocks and light are allocated lazily; an
 * air-only, fully sky lit section costs nothing but the object header.
 */
export class Section {
  /**
   * @param {number} sy Section index 0..23 inside the chunk column.
   */
  constructor(sy) {
    /** @type {number} Section index 0..23. */
    this.sy = sy | 0;
    /** @type {number} World Y of this section's bottom layer. */
    this.originY = WORLD_MIN_Y + this.sy * SECTION_SIZE;
    /** @type {Uint16Array|null} Block ids, `null` while the section is pure air. */
    this.blocks = null;
    /** @type {Uint16Array|null} Packed light, `null` until first written. */
    this.light = null;
    /** @type {number} Number of non-air voxels. */
    this.nonAirCount = 0;
    /**
     * @type {boolean} When `true` and `light === null`, every voxel reports
     * sky light 15 and no block light. Materialised on the first light write.
     */
    this.uniformSky = false;
    /** @type {boolean} Set whenever content changed since the last mesh build. */
    this.dirty = false;
    /** @type {number} Monotonic content stamp; a mesh is stale when it differs. */
    this.meshVersion = 0;
  }

  /**
   * Whether the section contains no non-air block at all.
   * @returns {boolean} `true` when the section is pure air.
   */
  get isEmpty() {
    return this.nonAirCount === 0;
  }

  /**
   * Whether a light array has been materialised for this section.
   * @returns {boolean} `true` when {@link Section#light} is a real array.
   */
  get hasLight() {
    return this.light !== null;
  }

  /**
   * Ensure the block array exists.
   * @returns {Uint16Array} The block array.
   */
  ensureBlocks() {
    if (this.blocks === null) this.blocks = new Uint16Array(SECTION_VOLUME);
    return this.blocks;
  }

  /**
   * Ensure the light array exists, materialising a `uniformSky` section.
   * @returns {Uint16Array} The light array.
   */
  ensureLight() {
    if (this.light === null) {
      this.light = new Uint16Array(SECTION_VOLUME);
      if (this.uniformSky) {
        this.light.fill(SKY_FULL_PACKED);
        this.uniformSky = false;
      }
    }
    return this.light;
  }

  /**
   * Allocate both the block and the light array up front.
   * @returns {Section} `this`.
   */
  allocate() {
    this.ensureBlocks();
    this.ensureLight();
    return this;
  }

  /**
   * Flag the whole section as fully sky lit without allocating a light array.
   * Any stored light is discarded, so only call this while the section is known
   * to hold no block light (chunk initialisation).
   * @param {boolean} [on=true] Whether the section is fully sky lit.
   * @returns {Section} `this`.
   */
  setUniformSky(on = true) {
    if (on) {
      this.light = null;
      this.uniformSky = true;
      this.dirty = true;
      this.meshVersion++;
    } else if (this.light === null) {
      this.uniformSky = false;
    }
    return this;
  }

  /**
   * Adopt a full block array (worldgen / deserialisation fast path).
   * @param {Uint16Array|null} array Exactly `SECTION_VOLUME` block ids, or `null`.
   * @returns {number} The resulting non-air count.
   */
  setBlocks(array) {
    if (array === null) {
      this.blocks = null;
      this.nonAirCount = 0;
    } else {
      const src = array.length === SECTION_VOLUME ? array : new Uint16Array(SECTION_VOLUME);
      if (src !== array) src.set(array.subarray(0, Math.min(array.length, SECTION_VOLUME)));
      let count = 0;
      for (let i = 0; i < SECTION_VOLUME; i++) if (src[i] !== 0) count++;
      this.nonAirCount = count;
      this.blocks = count === 0 ? null : src;
    }
    this.dirty = true;
    this.meshVersion++;
    return this.nonAirCount;
  }

  /**
   * Read a block id.
   * @param {number} x Local X 0..15.
   * @param {number} y Local Y 0..15.
   * @param {number} z Local Z 0..15.
   * @returns {number} Block id, 0 for air.
   */
  get(x, y, z) {
    const b = this.blocks;
    return b === null ? 0 : b[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
  }

  /**
   * Write a block id, allocating or releasing the block array as needed.
   * @param {number} x Local X 0..15.
   * @param {number} y Local Y 0..15.
   * @param {number} z Local Z 0..15.
   * @param {number} id Block id to store.
   * @returns {number} The previous block id.
   */
  set(x, y, z, id) {
    const i = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
    let b = this.blocks;
    if (b === null) {
      if (id === 0) return 0;
      b = this.ensureBlocks();
    }
    const prev = b[i];
    if (prev === id) return prev;
    b[i] = id;
    if (prev === 0) {
      this.nonAirCount++;
    } else if (id === 0) {
      this.nonAirCount--;
      if (this.nonAirCount <= 0) {
        this.nonAirCount = 0;
        this.blocks = null;
      }
    }
    this.dirty = true;
    this.meshVersion++;
    return prev;
  }

  /**
   * Read the packed light value of a voxel.
   * @param {number} x Local X 0..15.
   * @param {number} y Local Y 0..15.
   * @param {number} z Local Z 0..15.
   * @returns {number} Packed uint16 light (see {@link packLight}).
   */
  getLight(x, y, z) {
    const l = this.light;
    if (l === null) return this.uniformSky ? SKY_FULL_PACKED : 0;
    return l[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
  }

  /**
   * Write the packed light value of a voxel.
   * @param {number} x Local X 0..15.
   * @param {number} y Local Y 0..15.
   * @param {number} z Local Z 0..15.
   * @param {number} packed Packed uint16 light value.
   * @returns {boolean} `true` when the stored value actually changed.
   */
  setLight(x, y, z, packed) {
    const i = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
    const v = packed & 0xffff;
    let l = this.light;
    if (l === null) {
      if (v === (this.uniformSky ? SKY_FULL_PACKED : 0)) return false;
      l = this.ensureLight();
    } else if (l[i] === v) {
      return false;
    }
    l[i] = v;
    this.dirty = true;
    this.meshVersion++;
    return true;
  }

  /**
   * Read the three block light channels of a voxel.
   * @param {number} x Local X 0..15.
   * @param {number} y Local Y 0..15.
   * @param {number} z Local Z 0..15.
   * @returns {number[]} `[r, g, b]`, each 0..15.
   */
  getBlockLight(x, y, z) {
    const v = this.getLight(x, y, z);
    return [v & 15, (v >> 4) & 15, (v >> 8) & 15];
  }

  /**
   * Write the three block light channels of a voxel, keeping its sky light.
   * @param {number} x Local X 0..15.
   * @param {number} y Local Y 0..15.
   * @param {number} z Local Z 0..15.
   * @param {number} r Red 0..15.
   * @param {number} g Green 0..15.
   * @param {number} b Blue 0..15.
   * @returns {boolean} `true` when the stored value actually changed.
   */
  setBlockLight(x, y, z, r, g, b) {
    const cur = this.getLight(x, y, z);
    return this.setLight(x, y, z, (cur & 0xf000) | (r & 15) | ((g & 15) << 4) | ((b & 15) << 8));
  }

  /**
   * Read the sky light of a voxel.
   * @param {number} x Local X 0..15.
   * @param {number} y Local Y 0..15.
   * @param {number} z Local Z 0..15.
   * @returns {number} Sky light 0..15.
   */
  getSkyLight(x, y, z) {
    return (this.getLight(x, y, z) >> 12) & 15;
  }

  /**
   * Write the sky light of a voxel, keeping its block light.
   * @param {number} x Local X 0..15.
   * @param {number} y Local Y 0..15.
   * @param {number} z Local Z 0..15.
   * @param {number} v Sky light 0..15.
   * @returns {boolean} `true` when the stored value actually changed.
   */
  setSkyLight(x, y, z, v) {
    const cur = this.getLight(x, y, z);
    return this.setLight(x, y, z, (cur & 0x0fff) | ((v & 15) << 12));
  }

  /**
   * Bytes currently held by this section's typed arrays.
   * @returns {number} Allocated byte count.
   */
  memoryBytes() {
    return (this.blocks === null ? 0 : this.blocks.byteLength) + (this.light === null ? 0 : this.light.byteLength);
  }

  /**
   * Release every buffer held by this section.
   * @returns {void}
   */
  dispose() {
    this.blocks = null;
    this.light = null;
    this.nonAirCount = 0;
    this.uniformSky = false;
    this.dirty = false;
  }
}

// ---------------------------------------------------------------------------
// Chunk
// ---------------------------------------------------------------------------

/**
 * A full 16 x 384 x 16 world column: 24 sections, a motion/light heightmap, a
 * per-column biome map, the per-section mesh slots and the block entity table.
 */
export class Chunk {
  /**
   * @param {number} cx Chunk X coordinate.
   * @param {number} cz Chunk Z coordinate.
   */
  constructor(cx, cz) {
    /** @type {number} Chunk X coordinate. */
    this.cx = cx | 0;
    /** @type {number} Chunk Z coordinate. */
    this.cz = cz | 0;
    /** @type {string} `"cx,cz"` map key. */
    this.key = chunkKey(this.cx, this.cz);
    /** @type {number} World X of local x = 0. */
    this.originX = this.cx * CHUNK_SIZE;
    /** @type {number} World Z of local z = 0. */
    this.originZ = this.cz * CHUNK_SIZE;
    /** @type {(Section|null)[]} 24 section slots, bottom first. */
    this.sections = new Array(SECTION_COUNT).fill(null);
    /**
     * @type {Int16Array} Per column `z * 16 + x`: world Y of the first block
     * fully open to the sky (`topmost light blocking Y + 1`).
     */
    this.heightmap = new Int16Array(COLUMN_COUNT).fill(HEIGHTMAP_EMPTY);
    /** @type {Uint8Array} Per column biome id, indexed `z * 16 + x`. */
    this.biomes = new Uint8Array(COLUMN_COUNT);
    /** @type {number} Highest heightmap entry, used for sky light shortcuts. */
    this.maxHeight = HEIGHTMAP_EMPTY;
    /** @type {'empty'|'generating'|'generated'|'lit'|'meshing'|'ready'} */
    this.state = 'empty';
    /** @type {boolean} Terrain data is present. */
    this.generated = false;
    /** @type {boolean} Initial light propagation has been seeded. */
    this.lit = false;
    /** @type {Set<number>} Section indices that need a mesh rebuild. */
    this.dirtySections = new Set();
    /** @type {(object|null)[]} Per section mesh handles owned by `world.js`. */
    this.meshes = new Array(SECTION_COUNT).fill(null);
    /** @type {object[]} Entities currently bound to this chunk. */
    this.entities = [];
    /** @type {Map<string, object>} Block entities keyed by `"x,y,z"` (local x/z, world y). */
    this.blockEntities = new Map();
    /** @type {boolean} `true` when the chunk differs from generator output. */
    this.modified = false;
    /** @type {number} Monotonically increasing content version. */
    this.version = 0;
    /** @type {boolean} Set by {@link Chunk#dispose}. */
    this.disposed = false;
    /** @type {boolean} Suppresses lazy section light seeding during bulk loads. */
    this._bulk = false;
  }

  // -- sections ------------------------------------------------------------

  /**
   * Fetch a section, optionally creating it.
   * @param {number} sy Section index 0..23.
   * @param {boolean} [create=false] Create the section when missing.
   * @returns {Section|null} The section, or `null`.
   */
  getSection(sy, create = false) {
    if (sy < 0 || sy >= SECTION_COUNT) return null;
    let s = this.sections[sy];
    if (s === null && create) {
      s = new Section(sy);
      this.sections[sy] = s;
      if (!this._bulk) this._seedSectionLight(s);
    }
    return s;
  }

  /**
   * Give a freshly created section the light state its voxels already reported
   * through the heightmap fallback, so materialising a section never darkens or
   * brightens the world.
   * @param {Section} s Newly created section.
   * @returns {void}
   */
  _seedSectionLight(s) {
    const base = s.originY;
    const top = base + SECTION_SIZE;
    if (base >= this.maxHeight) {
      s.uniformSky = true;
      return;
    }
    const hm = this.heightmap;
    let any = false;
    for (let i = 0; i < COLUMN_COUNT; i++) {
      if (hm[i] < top) {
        any = true;
        break;
      }
    }
    if (!any) return;
    const light = s.ensureLight();
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const h = hm[(lz << 4) | lx];
        if (h >= top) continue;
        const y0 = h > base ? h - base : 0;
        for (let ly = y0; ly < SECTION_SIZE; ly++) light[(ly << 8) | (lz << 4) | lx] = SKY_FULL_PACKED;
      }
    }
  }

  /**
   * Mark a section (and its mesh) as needing a rebuild.
   * @param {number} sy Section index; out-of-range values are ignored.
   * @returns {void}
   */
  markSectionDirty(sy) {
    if (sy < 0 || sy >= SECTION_COUNT) return;
    const s = this.sections[sy];
    if (s !== null) s.dirty = true;
    this.dirtySections.add(sy);
  }

  /**
   * Clear the dirty flag of a section after its mesh has been rebuilt.
   * @param {number} sy Section index.
   * @returns {void}
   */
  clearSectionDirty(sy) {
    this.dirtySections.delete(sy);
    const s = this.sections[sy];
    if (s !== null) s.dirty = false;
  }

  // -- blocks --------------------------------------------------------------

  /**
   * Read a block. Y values outside the world return air instead of throwing.
   * @param {number} x Chunk local X 0..15.
   * @param {number} y World Y.
   * @param {number} z Chunk local Z 0..15.
   * @returns {number} Block id, 0 for air / out of bounds.
   */
  getBlock(x, y, z) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return 0;
    const yy = y - WORLD_MIN_Y;
    const s = this.sections[yy >> 4];
    if (s === null) return 0;
    const b = s.blocks;
    if (b === null) return 0;
    return b[((yy & 15) << 8) | ((z & 15) << 4) | (x & 15)];
  }

  /**
   * Write a block and keep the heightmap, dirty set and save flag in sync.
   * @param {number} x Chunk local X 0..15.
   * @param {number} y World Y.
   * @param {number} z Chunk local Z 0..15.
   * @param {number} id Block id to store.
   * @returns {number} The previous block id (0 when out of bounds).
   */
  setBlock(x, y, z, id) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return 0;
    const lx = x & 15;
    const lz = z & 15;
    const yy = y - WORLD_MIN_Y;
    const sy = yy >> 4;
    const ly = yy & 15;
    let s = this.sections[sy];
    if (s === null) {
      if (id === 0) return 0;
      s = this.getSection(sy, true);
    }
    const prev = s.set(lx, ly, lz, id);
    if (prev === id) return prev;

    this.version++;
    this.modified = true;
    this.markSectionDirty(sy);
    if (ly === 0) this.markSectionDirty(sy - 1);
    else if (ly === 15) this.markSectionDirty(sy + 1);

    const ci = (lz << 4) | lx;
    const wasBlocking = blocksSky(prev);
    const isBlocking = blocksSky(id);
    if (isBlocking) {
      if (y + 1 > this.heightmap[ci]) {
        this.heightmap[ci] = y + 1;
        if (y + 1 > this.maxHeight) this.maxHeight = y + 1;
      }
    } else if (wasBlocking && this.heightmap[ci] === y + 1) {
      this.recomputeHeight(lx, lz);
    }

    if (this.blockEntities.size !== 0) {
      const bk = `${lx},${y},${lz}`;
      if (this.blockEntities.has(bk)) this.blockEntities.delete(bk);
    }
    return prev;
  }

  // -- light ---------------------------------------------------------------

  /**
   * Read the packed light of a voxel. Sections that were never materialised
   * answer from the heightmap: full sky above the terrain, darkness below.
   * @param {number} x Chunk local X 0..15.
   * @param {number} y World Y.
   * @param {number} z Chunk local Z 0..15.
   * @returns {number} Packed uint16 light value.
   */
  getLightPacked(x, y, z) {
    if (y >= WORLD_MAX_Y) return SKY_FULL_PACKED;
    if (y < WORLD_MIN_Y) return 0;
    const yy = y - WORLD_MIN_Y;
    const s = this.sections[yy >> 4];
    const lx = x & 15;
    const lz = z & 15;
    if (s === null) return y >= this.heightmap[(lz << 4) | lx] ? SKY_FULL_PACKED : 0;
    const l = s.light;
    if (l === null) return s.uniformSky || y >= this.heightmap[(lz << 4) | lx] ? SKY_FULL_PACKED : 0;
    return l[((yy & 15) << 8) | (lz << 4) | lx];
  }

  /**
   * Write the packed light of a voxel, materialising the section when needed.
   * @param {number} x Chunk local X 0..15.
   * @param {number} y World Y.
   * @param {number} z Chunk local Z 0..15.
   * @param {number} v Packed uint16 light value.
   * @returns {boolean} `true` when the stored value actually changed.
   */
  setLightPacked(x, y, z, v) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return false;
    const yy = y - WORLD_MIN_Y;
    const sy = yy >> 4;
    const lx = x & 15;
    const lz = z & 15;
    let s = this.sections[sy];
    if (s === null) {
      if ((v & 0xffff) === this.getLightPacked(lx, y, lz)) return false;
      s = this.getSection(sy, true);
    } else if (s.light === null && !s.uniformSky) {
      // The section still answers from the heightmap fallback; materialise that
      // state first so the write does not wipe the sky light of its neighbours.
      this._seedSectionLight(s);
    }
    if (!s.setLight(lx, yy & 15, lz, v)) return false;
    this.dirtySections.add(sy);
    return true;
  }

  /**
   * Sky light of a voxel.
   * @param {number} x Chunk local X 0..15.
   * @param {number} y World Y.
   * @param {number} z Chunk local Z 0..15.
   * @returns {number} Sky light 0..15.
   */
  getSkyLight(x, y, z) {
    return (this.getLightPacked(x, y, z) >> 12) & 15;
  }

  /**
   * Block light of a voxel.
   * @param {number} x Chunk local X 0..15.
   * @param {number} y World Y.
   * @param {number} z Chunk local Z 0..15.
   * @returns {number[]} `[r, g, b]`, each 0..15.
   */
  getBlockLight(x, y, z) {
    const v = this.getLightPacked(x, y, z);
    return [v & 15, (v >> 4) & 15, (v >> 8) & 15];
  }

  // -- heightmap -----------------------------------------------------------

  /**
   * Height of a column: world Y of the first block open to the sky.
   * @param {number} x Chunk local X 0..15.
   * @param {number} z Chunk local Z 0..15.
   * @returns {number} Column height (>= {@link WORLD_MIN_Y}).
   */
  getHeight(x, z) {
    return this.heightmap[((z & 15) << 4) | (x & 15)];
  }

  /**
   * Rescan one column top-down and refresh its heightmap entry.
   * @param {number} x Chunk local X 0..15.
   * @param {number} z Chunk local Z 0..15.
   * @returns {number} The new column height.
   */
  recomputeHeight(x, z) {
    const lx = x & 15;
    const lz = z & 15;
    const ci = (lz << 4) | lx;
    const old = this.heightmap[ci];
    let h = HEIGHTMAP_EMPTY;
    for (let sy = SECTION_COUNT - 1; sy >= 0; sy--) {
      const s = this.sections[sy];
      if (s === null || s.blocks === null) continue;
      const b = s.blocks;
      const base = WORLD_MIN_Y + sy * SECTION_SIZE;
      let found = -1;
      for (let ly = SECTION_SIZE - 1; ly >= 0; ly--) {
        if (blocksSky(b[(ly << 8) | (lz << 4) | lx])) {
          found = ly;
          break;
        }
      }
      if (found >= 0) {
        h = base + found + 1;
        break;
      }
    }
    this.heightmap[ci] = h;
    if (old === this.maxHeight && h < old) this._recomputeMaxHeight();
    else if (h > this.maxHeight) this.maxHeight = h;
    return h;
  }

  /**
   * Refresh {@link Chunk#maxHeight} from the heightmap.
   * @returns {number} The new maximum height.
   */
  _recomputeMaxHeight() {
    let m = HEIGHTMAP_EMPTY;
    const hm = this.heightmap;
    for (let i = 0; i < COLUMN_COUNT; i++) if (hm[i] > m) m = hm[i];
    this.maxHeight = m;
    return m;
  }

  /**
   * Rebuild the whole heightmap from the block data.
   * @returns {void}
   */
  rebuildHeightmap() {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) this.recomputeHeight(lx, lz);
    }
    this._recomputeMaxHeight();
  }

  /**
   * Biome id of a column.
   * @param {number} x Chunk local X 0..15.
   * @param {number} z Chunk local Z 0..15.
   * @returns {number} Biome id.
   */
  getBiome(x, z) {
    return this.biomes[((z & 15) << 4) | (x & 15)];
  }

  // -- block entities ------------------------------------------------------

  /**
   * Read a block entity record.
   * @param {number} x Chunk local X 0..15.
   * @param {number} y World Y.
   * @param {number} z Chunk local Z 0..15.
   * @returns {object|null} The record, or `null`.
   */
  getBlockEntity(x, y, z) {
    return this.blockEntities.get(`${x & 15},${y},${z & 15}`) ?? null;
  }

  /**
   * Store a block entity record (chest inventory, furnace state, sign text...).
   * @param {number} x Chunk local X 0..15.
   * @param {number} y World Y.
   * @param {number} z Chunk local Z 0..15.
   * @param {object} data Plain, structured-clone friendly payload.
   * @returns {object} `data`.
   */
  setBlockEntity(x, y, z, data) {
    this.blockEntities.set(`${x & 15},${y},${z & 15}`, data);
    this.modified = true;
    this.version++;
    return data;
  }

  /**
   * Delete a block entity record.
   * @param {number} x Chunk local X 0..15.
   * @param {number} y World Y.
   * @param {number} z Chunk local Z 0..15.
   * @returns {boolean} `true` when a record was removed.
   */
  removeBlockEntity(x, y, z) {
    const ok = this.blockEntities.delete(`${x & 15},${y},${z & 15}`);
    if (ok) {
      this.modified = true;
      this.version++;
    }
    return ok;
  }

  // -- bulk loading --------------------------------------------------------

  /**
   * Adopt a `WorldGenerator.generateChunk()` result.
   * @param {{sections:(Uint16Array|ArrayBuffer|null)[], heightmap?:Int16Array|ArrayBuffer,
   *   biomes?:Uint8Array|ArrayBuffer}} data Generator output.
   * @returns {Chunk} `this`.
   */
  applyGenerated(data) {
    this._bulk = true;
    const src = data.sections || [];
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const raw = toUint16(src[sy], SECTION_VOLUME);
      if (raw === null) {
        const old = this.sections[sy];
        if (old !== null) old.dispose();
        this.sections[sy] = null;
        continue;
      }
      const s = this.getSection(sy, true);
      s.setBlocks(raw);
      if (s.blocks === null && s.light === null) this.sections[sy] = null;
    }
    const hm = toInt16(data.heightmap, COLUMN_COUNT);
    if (hm !== null) this.heightmap.set(hm);
    const bm = toUint8(data.biomes, COLUMN_COUNT);
    if (bm !== null) this.biomes.set(bm);
    this._bulk = false;
    if (hm === null) this.rebuildHeightmap();
    else this._recomputeMaxHeight();
    this.generated = true;
    this.state = 'generated';
    this.version++;
    for (let sy = 0; sy < SECTION_COUNT; sy++) if (this.sections[sy] !== null) this.dirtySections.add(sy);
    return this;
  }

  // -- persistence ---------------------------------------------------------

  /**
   * Compact, transferable snapshot: only non-empty sections plus the heightmap,
   * biomes and block entities. Light is never stored; it is recomputed on load.
   * Every typed array is copied, so transferring the result never detaches the
   * live chunk buffers. Use {@link chunkTransferables} to build the transfer
   * list for `postMessage`.
   * @returns {{cx:number, cz:number, version:number, modified:boolean,
   *   sections:{sy:number, blocks:ArrayBuffer}[], heightmap:ArrayBuffer,
   *   biomes:ArrayBuffer, blockEntities:[string, object][]}} Snapshot object.
   */
  serialize() {
    /** @type {{sy:number, blocks:ArrayBuffer}[]} */
    const sections = [];
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const s = this.sections[sy];
      if (s === null || s.blocks === null || s.nonAirCount === 0) continue;
      sections.push({ sy, blocks: s.blocks.slice().buffer });
    }
    /** @type {[string, object][]} */
    const blockEntities = [];
    for (const [k, v] of this.blockEntities) blockEntities.push([k, v]);
    return {
      cx: this.cx,
      cz: this.cz,
      version: this.version,
      modified: this.modified,
      sections,
      heightmap: this.heightmap.slice().buffer,
      biomes: this.biomes.slice().buffer,
      blockEntities,
    };
  }

  /**
   * Rebuild a chunk from {@link Chunk#serialize} output (IndexedDB or worker).
   * @param {{cx:number, cz:number, version?:number, modified?:boolean,
   *   sections?:{sy:number, blocks:ArrayBuffer|Uint16Array}[],
   *   heightmap?:ArrayBuffer|Int16Array, biomes?:ArrayBuffer|Uint8Array,
   *   blockEntities?:[string, object][]|object}} obj Snapshot object.
   * @returns {Chunk} The restored chunk.
   */
  static deserialize(obj) {
    const chunk = new Chunk(obj.cx, obj.cz);
    chunk._bulk = true;
    const list = obj.sections || [];
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry) continue;
      const sy = entry.sy | 0;
      if (sy < 0 || sy >= SECTION_COUNT) continue;
      const blocks = toUint16(entry.blocks, SECTION_VOLUME);
      if (blocks === null) continue;
      const s = chunk.getSection(sy, true);
      s.setBlocks(blocks);
      if (s.blocks === null) chunk.sections[sy] = null;
    }
    const hm = toInt16(obj.heightmap, COLUMN_COUNT);
    if (hm !== null) chunk.heightmap.set(hm);
    const bm = toUint8(obj.biomes, COLUMN_COUNT);
    if (bm !== null) chunk.biomes.set(bm);
    chunk._bulk = false;
    if (hm === null) chunk.rebuildHeightmap();
    else chunk._recomputeMaxHeight();
    const be = obj.blockEntities;
    if (Array.isArray(be)) {
      for (let i = 0; i < be.length; i++) chunk.blockEntities.set(be[i][0], be[i][1]);
    } else if (be && typeof be === 'object') {
      for (const k of Object.keys(be)) chunk.blockEntities.set(k, be[k]);
    }
    chunk.version = obj.version || 0;
    chunk.modified = obj.modified !== false;
    chunk.generated = true;
    chunk.state = 'generated';
    for (let sy = 0; sy < SECTION_COUNT; sy++) if (chunk.sections[sy] !== null) chunk.dirtySections.add(sy);
    return chunk;
  }

  /**
   * Approximate heap footprint of this chunk's voxel data.
   * @returns {number} Bytes held by sections, heightmap and biomes.
   */
  memoryBytes() {
    let bytes = this.heightmap.byteLength + this.biomes.byteLength;
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const s = this.sections[sy];
      if (s !== null) bytes += s.memoryBytes();
    }
    return bytes;
  }

  /**
   * Release all voxel data and mesh handles held by this chunk.
   * @returns {void}
   */
  dispose() {
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const s = this.sections[sy];
      if (s !== null) s.dispose();
      this.sections[sy] = null;
      const m = this.meshes[sy];
      if (m && typeof m.dispose === 'function') m.dispose();
      this.meshes[sy] = null;
    }
    this.dirtySections.clear();
    this.blockEntities.clear();
    this.entities.length = 0;
    this.generated = false;
    this.lit = false;
    this.state = 'empty';
    this.disposed = true;
  }
}

/**
 * Collect every `ArrayBuffer` of a {@link Chunk#serialize} snapshot so it can be
 * handed to `postMessage(msg, transferList)`.
 * @param {{sections:{blocks:ArrayBuffer}[], heightmap:ArrayBuffer, biomes:ArrayBuffer}} obj Snapshot.
 * @returns {ArrayBuffer[]} Transfer list.
 */
export function chunkTransferables(obj) {
  /** @type {ArrayBuffer[]} */
  const out = [];
  if (!obj) return out;
  if (obj.heightmap instanceof ArrayBuffer) out.push(obj.heightmap);
  if (obj.biomes instanceof ArrayBuffer) out.push(obj.biomes);
  const list = obj.sections || [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i] && list[i].blocks;
    if (b instanceof ArrayBuffer) out.push(b);
  }
  return out;
}
