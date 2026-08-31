/**
 * @file game/save.js — VOXELIA persistence layer (spec 5.39).
 *
 * Everything the player can lose by closing the tab lives here: world
 * metadata, the *delta* of every modified chunk, the player record and the
 * loose entities. The module is deliberately self-contained — it imports only
 * `core/util.js` (for {@link LRU} and {@link formatBytes}) plus the two world
 * constants it needs — so the world-select screen can list saves long before a
 * `World` instance exists.
 *
 * ---------------------------------------------------------------------------
 * Object stores (IndexedDB database `dbName`, schema version {@link DB_VERSION})
 * ---------------------------------------------------------------------------
 *
 * | store      | keyPath                    | indices                | payload                       |
 * |------------|----------------------------|------------------------|-------------------------------|
 * | `worlds`   | `id`                       | `byLastPlayed`         | world metadata (see §4)       |
 * | `chunks`   | `['worldId','cx','cz']`    | `byWorld` -> `worldId` | encoded chunk delta records   |
 * | `players`  | `worldId`                  | —                      | `Player#serialize()` snapshot |
 * | `entities` | `['worldId','bucket']`     | `byWorld` -> `worldId` | entity buckets of 256 records |
 *
 * **Migration path.** `onupgradeneeded` walks forward from `event.oldVersion`,
 * applying one numbered, *append-only* step at a time:
 *
 * ```
 *   0 -> 1   create all four stores and their indices (current schema)
 * ```
 *
 * To introduce schema version 2 later: bump {@link DB_VERSION} to `2` and add a
 * `if (oldVersion < 2) { ... }` block at the end of {@link SaveManager#_upgrade}.
 * Never edit an existing block — users upgrade *through* every step, so an
 * edited step would silently skip work on databases that already passed it.
 * The upgrade transaction (`request.transaction`) is passed in so a step can
 * migrate existing rows with a cursor.
 *
 * Changes to the *shape of a record* that do not need new stores do not bump
 * the schema at all: every chunk record carries {@link SAVE_FORMAT_VERSION} in
 * its `v` field and is upgraded lazily on read by `migrateChunkRecord()`.
 *
 * ---------------------------------------------------------------------------
 * Chunk record format
 * ---------------------------------------------------------------------------
 *
 * Only chunks whose `modified` flag is set are ever handed to
 * {@link SaveManager#saveChunk} (`world.js` enforces that), so the database
 * holds a delta over the deterministic generator, not a copy of the world.
 *
 * ```js
 * {
 *   worldId: string,          // part of the compound primary key
 *   cx: number, cz: number,   // chunk coordinates, part of the primary key
 *   v: 1,                     // SAVE_FORMAT_VERSION
 *   sections: [               // only non-empty sections, ascending sy
 *     { sy: 0..23, enc: 0|1, data: ArrayBuffer }
 *   ],
 *   heightmap: ArrayBuffer,   // Int16Array(256), column z*16+x
 *   biomes:    ArrayBuffer,   // Uint8Array(256), column z*16+x
 *   blockEntities: [[key, value], ...],
 *   chunkVersion: number,     // Chunk#version at save time
 *   savedAt: number           // Date.now()
 * }
 * ```
 *
 * Typed-array buffers are stored **as `ArrayBuffer`s**: the structured clone
 * algorithm persists them natively and byte-exactly. They are never
 * `JSON.stringify`-ed — that would inflate 8 KiB of voxel data into ~25 KiB of
 * decimal text and destroy the read path's performance.
 *
 * **Section encoding** (`enc`), see {@link ENCODING}:
 *
 * * `0 = RAW` — `data` is a `Uint16Array(4096)` buffer, 8192 bytes, in the
 *   canonical section order `idx = (y * 16 + z) * 16 + x`.
 * * `1 = RLE` — `data` is a `Uint16Array` of **run/value pairs**:
 *   `[run0, value0, run1, value1, ...]`. Each `run` is `1..4096` (never 0) and
 *   the runs sum to exactly 4096; `value` is the block id. Decoding is a plain
 *   `fill()` walk. Voxel data is enormously run-friendly (a section of stone
 *   with one tunnel through it collapses from 8192 bytes to a few dozen), so
 *   RLE is tried first and the raw form is only kept when the encoded pair
 *   stream would not be smaller — i.e. the writer picks `min(raw, rle)` per
 *   section and the reader honours whatever the `enc` field says.
 *
 * {@link encodeSectionBlocks} and {@link decodeSectionBlocks} are the matching
 * codec pair and are exported so tools and tests can round-trip them.
 *
 * ---------------------------------------------------------------------------
 * Write batching
 * ---------------------------------------------------------------------------
 *
 * `saveChunk()` never touches IndexedDB. It encodes the snapshot on the spot
 * (so the caller may reuse its buffers immediately), drops the record into a
 * pending `Map` keyed by `worldId|cx,cz` — a second write to the same chunk
 * simply replaces the first — and returns the promise of the *batch* it landed
 * in. The batch is committed in **one** `readwrite` transaction when either
 * {@link FLUSH_INTERVAL_MS} has elapsed or {@link MAX_BATCH} chunks are queued.
 * Reads consult the pending and in-flight maps before the database, so a chunk
 * that was unloaded and immediately walked back into is never lost.
 *
 * ---------------------------------------------------------------------------
 * Robustness
 * ---------------------------------------------------------------------------
 *
 * * No method of this class ever rejects. Failures resolve to `null`
 *   (`false`/`0` where a boolean/count is the documented success value) and are
 *   reported once through {@link SaveManager#onError}.
 * * `QuotaExceededError` is detected explicitly, flips `quotaExceeded` and is
 *   reported with the `'quota'` code so the HUD can warn the player.
 * * When IndexedDB is missing or refuses to open (private browsing, disabled
 *   storage, blocked upgrade) the manager transparently degrades to in-memory
 *   `Map`s. The game then runs perfectly for the session and only forgets
 *   everything when the tab closes — which beats not starting at all.
 */

import { LRU, formatBytes, nowMs } from '../core/util.js';
import { SECTION_COUNT, SECTION_VOLUME, COLUMN_COUNT } from '../world/chunk.js';
import { GEN_VERSION } from '../world/worldgen.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/**
 * IndexedDB schema version. Bump this **only** when stores or indices change,
 * and add a matching append-only step in {@link SaveManager#_upgrade}.
 * @type {number}
 */
export const DB_VERSION = 1;

/**
 * Version stamped into every chunk/player/meta record. Bump this for pure
 * payload changes; records are migrated lazily on read.
 * @type {number}
 */
export const SAVE_FORMAT_VERSION = 1;

/**
 * Object store names.
 * @type {Readonly<{WORLDS:string, CHUNKS:string, PLAYERS:string, ENTITIES:string}>}
 */
export const STORES = Object.freeze({
  WORLDS: 'worlds',
  CHUNKS: 'chunks',
  PLAYERS: 'players',
  ENTITIES: 'entities',
});

/**
 * Section payload encodings, see the file header for the byte layout.
 * @type {Readonly<{RAW:number, RLE:number}>}
 */
export const ENCODING = Object.freeze({ RAW: 0, RLE: 1 });

/** Flush timer period in milliseconds. @type {number} */
export const FLUSH_INTERVAL_MS = 1000;

/** Pending chunk count that forces an immediate flush. @type {number} */
export const MAX_BATCH = 64;

/** Entities per `entities` store bucket. @type {number} */
export const ENTITY_BUCKET_SIZE = 256;

/** Highest bucket index we will ever scan when deleting stale buckets. */
const MAX_ENTITY_BUCKETS = 4096;

/** `indexedDB.open()` watchdog in milliseconds. */
const OPEN_TIMEOUT_MS = 10000;

/** Negative-lookup cache size (chunk keys known to be absent from storage). */
const MISS_CACHE_LIMIT = 8192;

/** Safety valve so a pathological writer cannot spin `_drain()` forever. */
const MAX_DRAIN_BATCHES = 512;

/**
 * Cap on the in-memory overflow store while a real database is in use, so a
 * persistent quota error cannot grow the heap without bound. Not applied in
 * true memory-fallback mode, where that map is the only storage there is.
 */
const MEM_OVERFLOW_LIMIT = 4096;

/** Supported game modes; anything else falls back to `'survival'`. */
const GAME_MODES = ['survival', 'creative', 'spectator'];

/* ========================================================================== */
/* Diagnostics                                                                */
/* ========================================================================== */

/** @type {Set<string>} Tags already logged, so a broken save spams once. */
const WARNED = new Set();

/**
 * Log a save-subsystem problem exactly once per tag (hard rule: never throw,
 * log once, degrade).
 * @param {string} tag Stable identifier for the failure site.
 * @param {string} message Human readable English developer message.
 * @param {*} [err] Optional underlying error.
 * @returns {void}
 */
function warnOnce(tag, message, err) {
  if (WARNED.has(tag)) return;
  WARNED.add(tag);
  if (err !== undefined && err !== null) console.warn(`[VOXELIA] save/${tag}: ${message}`, err);
  else console.warn(`[VOXELIA] save/${tag}: ${message}`);
}

/**
 * Whether an error is a storage-quota failure in any of the shapes browsers
 * use (name, legacy `code` 22, or a `NS_ERROR_*` string from Gecko).
 * @param {*} err Candidate error.
 * @returns {boolean} `true` when the write failed for lack of space.
 */
function isQuotaError(err) {
  if (!err) return false;
  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (err.code === 22 || err.code === 1014) return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return msg.indexOf('quota') !== -1 || msg.indexOf('Quota') !== -1;
}

/* ========================================================================== */
/* Typed array helpers                                                        */
/* ========================================================================== */

/**
 * View any structured-clone-safe source as a `Uint16Array` without copying when
 * the alignment allows it.
 * @param {ArrayBuffer|ArrayBufferView|number[]|null|undefined} src Source data.
 * @returns {Uint16Array|null} A view over the whole payload, or `null`.
 */
function asUint16(src) {
  if (!src) return null;
  try {
    if (src instanceof Uint16Array) return src;
    if (src instanceof ArrayBuffer) return new Uint16Array(src, 0, src.byteLength >> 1);
    if (ArrayBuffer.isView(src)) {
      if ((src.byteOffset & 1) === 0) return new Uint16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
      const copy = new Uint8Array(src.byteLength);
      copy.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
      return new Uint16Array(copy.buffer, 0, copy.byteLength >> 1);
    }
    if (Array.isArray(src)) return Uint16Array.from(src);
  } catch (err) {
    warnOnce('asUint16', 'unreadable Uint16 payload', err);
  }
  return null;
}

/**
 * Copy any source into a freshly allocated `Int16Array` of exactly `length`
 * elements (missing entries stay `0`, extra entries are dropped).
 * @param {ArrayBuffer|ArrayBufferView|number[]|null|undefined} src Source data.
 * @param {number} length Element count of the result.
 * @returns {Int16Array|null} The copy, or `null` when `src` is unusable.
 */
function copyInt16(src, length) {
  if (!src) return null;
  try {
    const out = new Int16Array(length);
    if (Array.isArray(src)) {
      for (let i = 0, n = Math.min(length, src.length); i < n; i++) out[i] = src[i] | 0;
      return out;
    }
    let view = null;
    if (src instanceof Int16Array) view = src;
    else if (src instanceof ArrayBuffer) view = new Int16Array(src, 0, src.byteLength >> 1);
    else if (ArrayBuffer.isView(src) && (src.byteOffset & 1) === 0) view = new Int16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
    if (view === null) return null;
    out.set(view.subarray(0, Math.min(length, view.length)));
    return out;
  } catch (err) {
    warnOnce('copyInt16', 'unreadable Int16 payload', err);
    return null;
  }
}

/**
 * Copy any source into a freshly allocated `Uint8Array` of exactly `length`.
 * @param {ArrayBuffer|ArrayBufferView|number[]|null|undefined} src Source data.
 * @param {number} length Element count of the result.
 * @returns {Uint8Array|null} The copy, or `null` when `src` is unusable.
 */
function copyUint8(src, length) {
  if (!src) return null;
  try {
    const out = new Uint8Array(length);
    if (Array.isArray(src)) {
      for (let i = 0, n = Math.min(length, src.length); i < n; i++) out[i] = src[i] & 255;
      return out;
    }
    let view = null;
    if (src instanceof Uint8Array) view = src;
    else if (src instanceof ArrayBuffer) view = new Uint8Array(src);
    else if (ArrayBuffer.isView(src)) view = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    if (view === null) return null;
    out.set(view.subarray(0, Math.min(length, view.length)));
    return out;
  } catch (err) {
    warnOnce('copyUint8', 'unreadable Uint8 payload', err);
    return null;
  }
}

/**
 * Detached-safe `ArrayBuffer` copy for values that come out of structured
 * clone or straight from `Chunk#serialize()`.
 * @param {ArrayBuffer|ArrayBufferView|null|undefined} src Source buffer.
 * @returns {ArrayBuffer|null} An independent copy, or `null`.
 */
function copyBuffer(src) {
  if (!src) return null;
  try {
    if (src instanceof ArrayBuffer) return src.slice(0);
    if (ArrayBuffer.isView(src)) {
      const out = new Uint8Array(src.byteLength);
      out.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
      return out.buffer;
    }
  } catch (err) {
    warnOnce('copyBuffer', 'buffer could not be copied', err);
  }
  return null;
}

/* ========================================================================== */
/* Section RLE codec                                                          */
/* ========================================================================== */

/**
 * Scratch space for {@link encodeSectionBlocks}. Worst case is one run per
 * voxel, i.e. `2 * 4096` u16 entries. Reused so batching 64 sections per second
 * allocates nothing beyond the final `slice()`.
 * @type {Uint16Array}
 */
const RLE_SCRATCH = new Uint16Array(SECTION_VOLUME * 2);

/**
 * Encode one section's block array, choosing the smaller of run-length and raw.
 *
 * The RLE stream is a flat `Uint16Array` of `[run, value]` pairs whose runs sum
 * to {@link SECTION_VOLUME}; runs can never exceed 4096 so they always fit a
 * `uint16`. When the pair stream would not be shorter than the raw array (a
 * section of pure noise), the raw form wins and `enc` reports {@link ENCODING}`.RAW`.
 *
 * @param {Uint16Array|ArrayBuffer|ArrayBufferView} src The 4096 block ids.
 * @returns {{enc:number, data:ArrayBuffer}|null} Encoded payload, or `null`
 *   when `src` does not hold a full section.
 */
export function encodeSectionBlocks(src) {
  const blocks = asUint16(src);
  if (blocks === null || blocks.length < SECTION_VOLUME) {
    warnOnce('encodeSection', 'section payload was not 4096 block ids');
    return null;
  }
  const n = SECTION_VOLUME;
  const scratch = RLE_SCRATCH;
  let w = 0;
  let prev = blocks[0];
  let run = 1;
  for (let i = 1; i < n; i++) {
    const v = blocks[i];
    if (v === prev) {
      run++;
      continue;
    }
    scratch[w] = run;
    scratch[w + 1] = prev;
    w += 2;
    prev = v;
    run = 1;
  }
  scratch[w] = run;
  scratch[w + 1] = prev;
  w += 2;
  if (w < n) return { enc: ENCODING.RLE, data: scratch.slice(0, w).buffer };
  return { enc: ENCODING.RAW, data: blocks.slice(0, n).buffer };
}

/**
 * Inverse of {@link encodeSectionBlocks}.
 *
 * A truncated or overlong RLE stream is not fatal: the decoder fills what it
 * can, pads the remainder with air and warns once. Losing part of one section
 * is always better than dropping the whole chunk.
 *
 * @param {number} enc Encoding tag from {@link ENCODING}.
 * @param {ArrayBuffer|ArrayBufferView} data Payload.
 * @returns {Uint16Array|null} A fresh `Uint16Array(4096)`, or `null` when the
 *   payload is unreadable.
 */
export function decodeSectionBlocks(enc, data) {
  const view = asUint16(data);
  if (view === null) return null;
  if (enc === ENCODING.RAW) {
    const out = new Uint16Array(SECTION_VOLUME);
    out.set(view.subarray(0, Math.min(view.length, SECTION_VOLUME)));
    if (view.length < SECTION_VOLUME) warnOnce('decodeRaw', 'raw section was shorter than 4096 entries');
    return out;
  }
  if (enc !== ENCODING.RLE) {
    warnOnce('decodeEnc', `unknown section encoding ${enc}`);
    return null;
  }
  const out = new Uint16Array(SECTION_VOLUME);
  let o = 0;
  for (let i = 0; i + 1 < view.length; i += 2) {
    let run = view[i];
    const value = view[i + 1];
    if (run === 0) continue;
    if (o + run > SECTION_VOLUME) run = SECTION_VOLUME - o;
    if (run <= 0) break;
    if (value !== 0) out.fill(value, o, o + run);
    o += run;
    if (o >= SECTION_VOLUME) break;
  }
  if (o !== SECTION_VOLUME) warnOnce('decodeRle', `RLE stream covered ${o} of ${SECTION_VOLUME} voxels`);
  return out;
}

/* ========================================================================== */
/* Record encoding                                                            */
/* ========================================================================== */

/**
 * Compose the `Map`/IndexedDB key of one chunk.
 * @param {string} worldId World id.
 * @param {number} cx Chunk X.
 * @param {number} cz Chunk Z.
 * @returns {string} `"worldId|cx,cz"`.
 */
function chunkCacheKey(worldId, cx, cz) {
  return `${worldId}|${cx | 0},${cz | 0}`;
}

/**
 * Turn a `Chunk#serialize()` snapshot into a storable record.
 * @param {string} worldId Owning world id.
 * @param {number} cx Chunk X.
 * @param {number} cz Chunk Z.
 * @param {Object} snapshot Output of `Chunk#serialize()`.
 * @returns {Object|null} The record, or `null` when the snapshot is unusable.
 */
function encodeChunkRecord(worldId, cx, cz, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  /** @type {{sy:number, enc:number, data:ArrayBuffer}[]} */
  const sections = [];
  const list = Array.isArray(snapshot.sections) ? snapshot.sections : [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry) continue;
    const sy = entry.sy | 0;
    if (sy < 0 || sy >= SECTION_COUNT) continue;
    const encoded = encodeSectionBlocks(entry.blocks);
    if (encoded === null) continue;
    sections.push({ sy, enc: encoded.enc, data: encoded.data });
  }

  /** @type {[string, Object][]} */
  let blockEntities = [];
  const be = snapshot.blockEntities;
  if (Array.isArray(be)) {
    for (let i = 0; i < be.length; i++) {
      const pair = be[i];
      if (Array.isArray(pair) && pair.length >= 2 && typeof pair[0] === 'string') {
        blockEntities.push([pair[0], pair[1]]);
      }
    }
  } else if (be instanceof Map) {
    for (const [k, v] of be) if (typeof k === 'string') blockEntities.push([k, v]);
  } else if (be && typeof be === 'object') {
    const keys = Object.keys(be);
    for (let i = 0; i < keys.length; i++) blockEntities.push([keys[i], be[keys[i]]]);
  }
  if (blockEntities.length === 0) blockEntities = [];

  const heightmap = copyBuffer(snapshot.heightmap);
  const biomes = copyBuffer(snapshot.biomes);

  return {
    worldId,
    cx: cx | 0,
    cz: cz | 0,
    v: SAVE_FORMAT_VERSION,
    sections,
    heightmap,
    biomes,
    blockEntities,
    chunkVersion: Number.isFinite(snapshot.version) ? snapshot.version | 0 : 0,
    savedAt: Date.now(),
  };
}

/**
 * Lazily migrate an older chunk record to {@link SAVE_FORMAT_VERSION}.
 *
 * Version 1 is the initial format, so this is currently a pass-through with a
 * guard for records written by a *newer* build (which we refuse rather than
 * misread). Future payload changes append a step here.
 *
 * @param {Object} rec Raw stored record.
 * @returns {Object|null} A record in the current format, or `null`.
 */
function migrateChunkRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const v = Number.isFinite(rec.v) ? rec.v | 0 : 1;
  if (v > SAVE_FORMAT_VERSION) {
    warnOnce('recordVersion', `chunk record format ${v} is newer than ${SAVE_FORMAT_VERSION}; ignoring it`);
    return null;
  }
  // v === 1 is the current layout — nothing to do.
  return rec;
}

/**
 * Decode a stored record back into the exact shape `Chunk.deserialize()` wants.
 * Every buffer is copied so the caller may mutate the result freely even when
 * the record came from the in-memory fallback or the pending write queue.
 * @param {Object} rec Stored record.
 * @returns {Object|null} `Chunk.deserialize()` input, or `null`.
 */
function decodeChunkRecord(rec) {
  const src = migrateChunkRecord(rec);
  if (src === null) return null;
  /** @type {{sy:number, blocks:Uint16Array}[]} */
  const sections = [];
  const list = Array.isArray(src.sections) ? src.sections : [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry) continue;
    const sy = entry.sy | 0;
    if (sy < 0 || sy >= SECTION_COUNT) continue;
    const blocks = decodeSectionBlocks(entry.enc | 0, entry.data);
    if (blocks === null) continue;
    sections.push({ sy, blocks });
  }
  const heightmap = copyInt16(src.heightmap, COLUMN_COUNT);
  const biomes = copyUint8(src.biomes, COLUMN_COUNT);
  /** @type {[string, Object][]} */
  const blockEntities = [];
  if (Array.isArray(src.blockEntities)) {
    for (let i = 0; i < src.blockEntities.length; i++) {
      const pair = src.blockEntities[i];
      if (Array.isArray(pair) && pair.length >= 2) blockEntities.push([pair[0], pair[1]]);
    }
  }
  return {
    cx: src.cx | 0,
    cz: src.cz | 0,
    version: Number.isFinite(src.chunkVersion) ? src.chunkVersion | 0 : 0,
    modified: true,
    sections,
    heightmap,
    biomes,
    blockEntities,
  };
}

/**
 * Approximate stored size of a chunk record, for the debug overlay.
 * @param {Object} rec Stored record.
 * @returns {number} Bytes.
 */
function chunkRecordBytes(rec) {
  if (!rec) return 0;
  let bytes = 96;
  const list = Array.isArray(rec.sections) ? rec.sections : [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i] && list[i].data;
    if (d && typeof d.byteLength === 'number') bytes += d.byteLength + 16;
  }
  if (rec.heightmap && typeof rec.heightmap.byteLength === 'number') bytes += rec.heightmap.byteLength;
  if (rec.biomes && typeof rec.biomes.byteLength === 'number') bytes += rec.biomes.byteLength;
  if (Array.isArray(rec.blockEntities)) bytes += rec.blockEntities.length * 64;
  return bytes;
}

/* ========================================================================== */
/* World metadata                                                             */
/* ========================================================================== */

/**
 * @typedef {Object} WorldMeta
 * @property {string} id Stable primary key.
 * @property {string} name Display name (German UI).
 * @property {number} seed World seed (int32).
 * @property {number} created `Date.now()` at creation.
 * @property {number} lastPlayed `Date.now()` of the last session.
 * @property {number} playTime Accumulated play time in **seconds**.
 * @property {'survival'|'creative'|'spectator'} gameMode Default game mode.
 * @property {number} version Save format version of this record.
 * @property {number} genVersion Generator version the terrain was made with.
 * @property {string} generator Generator preset name.
 * @property {string} dimension Dimension id, `'overworld'` today.
 * @property {string|null} thumbnail `data:` URL screenshot slot (never a file).
 * @property {number[]|null} spawn World spawn point `[x, y, z]`.
 * @property {number} savedAt `Date.now()` of the last metadata write.
 */

/**
 * Generate a collision-free world id without relying on `crypto.randomUUID`
 * (missing on insecure origins).
 * @returns {string} New world id.
 */
function makeWorldId() {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return `w_${c.randomUUID()}`;
    if (c && typeof c.getRandomValues === 'function') {
      const buf = new Uint32Array(4);
      c.getRandomValues(buf);
      let s = '';
      for (let i = 0; i < buf.length; i++) s += buf[i].toString(36);
      return `w_${s}`;
    }
  } catch (err) {
    warnOnce('worldId', 'crypto unavailable, falling back to Math.random', err);
  }
  return `w_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

/**
 * Coerce arbitrary input into a complete, structured-clone-safe {@link WorldMeta}.
 * @param {Object} src Partial metadata.
 * @param {WorldMeta|null} [previous=null] Existing record to merge over.
 * @returns {WorldMeta} A fully populated record.
 */
function normalizeMeta(src, previous = null) {
  const base = previous || {};
  const input = src && typeof src === 'object' ? src : {};
  const now = Date.now();
  const pick = (key, fallback) => (input[key] !== undefined ? input[key] : (base[key] !== undefined ? base[key] : fallback));

  const id = typeof pick('id', '') === 'string' && pick('id', '').length !== 0 ? String(pick('id', '')) : makeWorldId();
  let name = pick('name', 'Neue Welt');
  name = typeof name === 'string' && name.trim().length !== 0 ? name.trim().slice(0, 64) : 'Neue Welt';

  let seed = pick('seed', 0);
  seed = Number.isFinite(Number(seed)) ? Number(seed) | 0 : 0;

  let gameMode = pick('gameMode', 'survival');
  if (GAME_MODES.indexOf(gameMode) === -1) gameMode = 'survival';

  const created = Number.isFinite(Number(pick('created', now))) ? Number(pick('created', now)) : now;
  const lastPlayed = Number.isFinite(Number(pick('lastPlayed', created))) ? Number(pick('lastPlayed', created)) : created;
  const playTime = Math.max(0, Number(pick('playTime', 0)) || 0);

  let spawn = pick('spawn', null);
  if (Array.isArray(spawn) && spawn.length >= 3 && spawn.every((v) => Number.isFinite(Number(v)))) {
    spawn = [Number(spawn[0]), Number(spawn[1]), Number(spawn[2])];
  } else {
    spawn = null;
  }

  let thumbnail = pick('thumbnail', null);
  if (typeof thumbnail !== 'string' || thumbnail.indexOf('data:') !== 0) thumbnail = null;

  let dimension = pick('dimension', 'overworld');
  if (typeof dimension !== 'string' || dimension.length === 0) dimension = 'overworld';

  let generator = pick('generator', 'default');
  if (typeof generator !== 'string' || generator.length === 0) generator = 'default';

  const genVersion = Number.isFinite(Number(pick('genVersion', GEN_VERSION))) ? Number(pick('genVersion', GEN_VERSION)) | 0 : GEN_VERSION;

  return {
    id,
    name,
    seed,
    created,
    lastPlayed,
    playTime,
    gameMode,
    version: SAVE_FORMAT_VERSION,
    genVersion,
    generator,
    dimension,
    thumbnail,
    spawn,
    savedAt: now,
  };
}

/* ========================================================================== */
/* IndexedDB promise helpers                                                  */
/* ========================================================================== */

/**
 * Resolve the global `IDBFactory`, tolerating sandboxes where merely touching
 * `indexedDB` throws a `SecurityError`.
 * @returns {IDBFactory|null} The factory, or `null` when unavailable.
 */
function getIndexedDB() {
  try {
    const g = /** @type {any} */ (globalThis);
    const idb = g.indexedDB || g.webkitIndexedDB || g.mozIndexedDB || null;
    return idb && typeof idb.open === 'function' ? idb : null;
  } catch (err) {
    warnOnce('idbAccess', 'indexedDB is not accessible in this context', err);
    return null;
  }
}

/**
 * Promise wrapper for an `IDBRequest`.
 * @param {IDBRequest} req The request.
 * @returns {Promise<*>} Resolves with `req.result`, rejects with `req.error`.
 */
function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      reject(req.error || new Error('IndexedDB request failed'));
    };
  });
}

/**
 * Promise wrapper for an `IDBTransaction`.
 * @param {IDBTransaction} tx The transaction.
 * @returns {Promise<boolean>} Resolves `true` on `complete`.
 */
function idbTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = (ev) => {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      reject(tx.error || new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Key range covering every compound key that starts with `worldId`.
 *
 * IndexedDB orders array keys element-wise and ranks an *array* element above
 * every number and string, so `[id]` .. `[id, []]` brackets `[id, cx, cz]` and
 * `[id, bucket]` exactly.
 * @param {string} worldId World id.
 * @returns {IDBKeyRange|null} The range, or `null` when `IDBKeyRange` is gone.
 */
function worldKeyRange(worldId) {
  try {
    return IDBKeyRange.bound([worldId], [worldId, []], false, false);
  } catch (err) {
    warnOnce('keyRange', 'IDBKeyRange.bound failed', err);
    return null;
  }
}

/* ========================================================================== */
/* storageEstimate                                                            */
/* ========================================================================== */

/**
 * Query the browser's storage budget for the settings/world-select UI.
 *
 * Returns numbers *and* pre-formatted German labels so a screen can render the
 * result without importing `formatBytes` itself. Resolves `null` when the
 * Storage API is unavailable (Safari < 17, workers on old engines) — the UI
 * should then simply hide the quota row.
 *
 * @returns {Promise<{usage:number, quota:number, free:number, ratio:number,
 *   persisted:boolean, usageText:string, quotaText:string, freeText:string,
 *   label:string}|null>} The estimate, or `null`.
 */
export async function storageEstimate() {
  try {
    const nav = /** @type {any} */ (globalThis).navigator;
    const store = nav && nav.storage;
    if (!store || typeof store.estimate !== 'function') return null;
    const est = await store.estimate();
    const usage = Number.isFinite(Number(est && est.usage)) ? Number(est.usage) : 0;
    const quota = Number.isFinite(Number(est && est.quota)) ? Number(est.quota) : 0;
    const free = Math.max(0, quota - usage);
    let persisted = false;
    if (typeof store.persisted === 'function') {
      try {
        persisted = await store.persisted() === true;
      } catch (err) {
        persisted = false;
      }
    }
    const usageText = formatBytes(usage);
    const quotaText = quota > 0 ? formatBytes(quota) : 'unbekannt';
    return {
      usage,
      quota,
      free,
      ratio: quota > 0 ? usage / quota : 0,
      persisted,
      usageText,
      quotaText,
      freeText: formatBytes(free),
      label: quota > 0 ? `${usageText} von ${quotaText} belegt` : `${usageText} belegt`,
    };
  } catch (err) {
    warnOnce('storageEstimate', 'navigator.storage.estimate() failed', err);
    return null;
  }
}

/**
 * Ask the browser to mark this origin's storage as persistent so the saves are
 * not evicted under pressure. Safe to call repeatedly; never throws.
 * @returns {Promise<boolean>} `true` when storage is (now) persistent.
 */
export async function requestPersistentStorage() {
  try {
    const nav = /** @type {any} */ (globalThis).navigator;
    const store = nav && nav.storage;
    if (!store) return false;
    if (typeof store.persisted === 'function' && await store.persisted() === true) return true;
    if (typeof store.persist !== 'function') return false;
    return await store.persist() === true;
  } catch (err) {
    warnOnce('persist', 'navigator.storage.persist() failed', err);
    return false;
  }
}

/* ========================================================================== */
/* SaveManager                                                                */
/* ========================================================================== */

/**
 * IndexedDB-backed persistence for worlds, chunk deltas, the player and loose
 * entities — with a transparent in-memory fallback.
 *
 * ```js
 * const save = new SaveManager('voxelia', { onError: (code, err, msg) => hud.setMessage(msg) });
 * await save.open();
 * const meta = await save.createWorld({ name: 'Testwelt', seed: 1234, gameMode: 'survival' });
 * world.setSaveManager(save, meta.id);
 * // ... play ...
 * await save.flush();
 * save.close();
 * ```
 *
 * No method rejects: failures resolve to `null` and are reported once through
 * {@link SaveManager#onError}.
 */
export class SaveManager {
  /**
   * @param {string} [dbName='voxelia'] IndexedDB database name.
   * @param {{onError?:((code:string, error:Error, message:string)=>void)|null,
   *   autoFlushOnHide?:boolean}} [options={}] Optional configuration.
   */
  constructor(dbName = 'voxelia', options = {}) {
    const opts = options && typeof options === 'object' ? options : {};

    /** @type {string} Database name. */
    this.dbName = typeof dbName === 'string' && dbName.length !== 0 ? dbName : 'voxelia';
    /** @type {IDBDatabase|null} The open database, `null` in memory mode. */
    this.db = null;
    /** @type {boolean} `true` when running on the in-memory fallback. */
    this.memory = false;
    /** @type {boolean} `true` once {@link SaveManager#close} has run. */
    this.closed = false;
    /** @type {boolean} Set after the first `QuotaExceededError`. */
    this.quotaExceeded = false;
    /**
     * Failure sink. Receives `(code, error, germanMessage)` where `code` is one
     * of `'unavailable'|'open'|'blocked'|'quota'|'write'|'read'|'delete'|'encode'`.
     * @type {((code:string, error:Error, message:string)=>void)|null}
     */
    this.onError = typeof opts.onError === 'function' ? opts.onError : null;
    /** @type {boolean} Flush pending writes when the page is hidden/unloaded. */
    this.autoFlushOnHide = opts.autoFlushOnHide !== false;

    /** @type {{chunksWritten:number, chunksRead:number, batches:number, bytesWritten:number, failures:number, queued:number, lastFlushMs:number}} */
    this.stats = {
      chunksWritten: 0,
      chunksRead: 0,
      batches: 0,
      bytesWritten: 0,
      failures: 0,
      queued: 0,
      lastFlushMs: 0,
    };

    /** @type {Map<string, Object>} Encoded records waiting for the next batch. @private */
    this._pending = new Map();
    /** @type {Map<string, Object>|null} The batch currently being committed. @private */
    this._inflight = null;
    /** @type {*} Handle of the pending flush timer. @private */
    this._timer = null;
    /** @type {boolean} A `_drain()` loop is running. @private */
    this._draining = false;
    /** @type {Promise<void>|null} The running `_drain()` loop. @private */
    this._drainPromise = null;
    /** @type {boolean} Every batch of the last drain committed cleanly. @private */
    this._drainOk = true;
    /** @type {Promise<boolean>|null} In-flight `open()`. @private */
    this._opening = null;

    /** @type {LRU} Chunk keys known to be absent from storage. @private */
    this._missCache = new LRU(MISS_CACHE_LIMIT);

    /**
     * In-memory fallback stores. Also used as an overflow bucket when a real
     * database write fails, so the current session keeps its edits.
     * @type {{worlds:Map<string, WorldMeta>, chunks:Map<string, Object>,
     *   players:Map<string, Object>, entities:Map<string, Object>}}
     * @private
     */
    this._mem = {
      worlds: new Map(),
      chunks: new Map(),
      players: new Map(),
      entities: new Map(),
    };

    /** @type {(()=>void)|null} Removes the page-hide listeners. @private */
    this._unhook = null;
    /** @type {()=>void} @private */
    this._onHide = () => {
      if (this._pending.size !== 0) this._drain();
    };
  }

  /* ---------------------------------------------------------------- open -- */

  /**
   * Open (and if necessary create/upgrade) the database.
   *
   * Never rejects and never leaves the manager unusable: when IndexedDB is
   * missing, blocked or broken the manager silently switches to its in-memory
   * stores and reports the reason through {@link SaveManager#onError}.
   *
   * @returns {Promise<boolean>} `true` when a real database is in use, `false`
   *   when the manager degraded to memory-only storage.
   */
  async open() {
    if (this.closed) return false;
    if (this.db !== null) return true;
    if (this.memory) return false;
    if (this._opening !== null) return this._opening;
    this._opening = this._openInternal();
    let ok = false;
    try {
      ok = await this._opening;
    } catch (err) {
      this._degrade('open', err);
      ok = false;
    }
    this._opening = null;
    return ok;
  }

  /**
   * Actual open + upgrade dance.
   * @returns {Promise<boolean>} `true` on success.
   * @private
   */
  async _openInternal() {
    const factory = getIndexedDB();
    if (factory === null) {
      this._degrade('unavailable', new Error('IndexedDB is not available'));
      return false;
    }
    /** @type {IDBDatabase|null} */
    let db = null;
    try {
      db = await new Promise((resolve, reject) => {
        /** @type {IDBOpenDBRequest} */
        let req;
        try {
          req = factory.open(this.dbName, DB_VERSION);
        } catch (err) {
          reject(err);
          return;
        }
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('IndexedDB open timed out'));
        }, OPEN_TIMEOUT_MS);
        req.onupgradeneeded = (ev) => {
          try {
            this._upgrade(req.result, ev.oldVersion | 0, ev.newVersion | 0, req.transaction);
          } catch (err) {
            warnOnce('upgrade', 'schema upgrade failed', err);
            try {
              if (req.transaction) req.transaction.abort();
            } catch (abortErr) {
              warnOnce('upgradeAbort', 'could not abort the upgrade transaction', abortErr);
            }
          }
        };
        req.onblocked = () => {
          warnOnce('blocked', 'another tab holds an older version of the database');
          this._report('blocked', new Error('IndexedDB upgrade blocked'),
            'Ein anderer Tab blockiert die Speicherdatenbank. Bitte schließe ihn und lade neu.');
        };
        req.onsuccess = () => {
          clearTimeout(timer);
          if (settled) {
            try {
              req.result.close();
            } catch (err) {
              warnOnce('lateClose', 'could not close a late database handle', err);
            }
            return;
          }
          settled = true;
          resolve(req.result);
        };
        req.onerror = () => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(req.error || new Error('IndexedDB open failed'));
        };
      });
    } catch (err) {
      this._degrade('open', err);
      return false;
    }
    if (!db) {
      this._degrade('open', new Error('IndexedDB returned no database'));
      return false;
    }
    // Verify the schema really is there (a half-applied upgrade would be worse
    // than the memory fallback).
    const names = db.objectStoreNames;
    const required = [STORES.WORLDS, STORES.CHUNKS, STORES.PLAYERS, STORES.ENTITIES];
    for (let i = 0; i < required.length; i++) {
      if (!names.contains(required[i])) {
        try {
          db.close();
        } catch (err) {
          warnOnce('closeBroken', 'could not close the incomplete database', err);
        }
        this._degrade('open', new Error(`object store "${required[i]}" is missing`));
        return false;
      }
    }
    db.onversionchange = () => {
      warnOnce('versionchange', 'another tab requested a schema upgrade; closing this connection');
      this.close();
    };
    db.onclose = () => {
      if (!this.closed) {
        this.db = null;
        warnOnce('dbClosed', 'the database connection was closed by the browser');
      }
    };
    this.db = db;
    this._installUnloadGuard();
    return true;
  }

  /**
   * Create the schema. Append-only: each `if (oldVersion < N)` block runs
   * exactly once per database, in order, so upgrades from any older version
   * land on the current layout.
   * @param {IDBDatabase} db The database being upgraded.
   * @param {number} oldVersion Version the database had before.
   * @param {number} newVersion Version we are upgrading to.
   * @param {IDBTransaction|null} tx The `versionchange` transaction.
   * @returns {void}
   * @private
   */
  _upgrade(db, oldVersion, newVersion, tx) {
    // ---- 0 -> 1: initial schema ------------------------------------------
    if (oldVersion < 1) {
      if (!db.objectStoreNames.contains(STORES.WORLDS)) {
        const worlds = db.createObjectStore(STORES.WORLDS, { keyPath: 'id' });
        worlds.createIndex('byLastPlayed', 'lastPlayed', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.CHUNKS)) {
        const chunks = db.createObjectStore(STORES.CHUNKS, { keyPath: ['worldId', 'cx', 'cz'] });
        chunks.createIndex('byWorld', 'worldId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.PLAYERS)) {
        db.createObjectStore(STORES.PLAYERS, { keyPath: 'worldId' });
      }
      if (!db.objectStoreNames.contains(STORES.ENTITIES)) {
        const entities = db.createObjectStore(STORES.ENTITIES, { keyPath: ['worldId', 'bucket'] });
        entities.createIndex('byWorld', 'worldId', { unique: false });
      }
    }
    // ---- 1 -> 2: add the next step here, never edit the block above -------
    void newVersion;
    void tx;
  }

  /**
   * Switch to the in-memory fallback and tell the UI why.
   * @param {string} code Error code for {@link SaveManager#onError}.
   * @param {*} err Underlying failure.
   * @returns {void}
   * @private
   */
  _degrade(code, err) {
    if (this.memory) return;
    this.memory = true;
    this.db = null;
    const error = err instanceof Error ? err : new Error(String(err));
    warnOnce(`degrade:${code}`, 'falling back to in-memory storage', error);
    this._report(code, error,
      'Speichern auf der Festplatte ist nicht möglich (privater Modus?). Der Fortschritt bleibt nur bis zum Schließen des Tabs erhalten.');
    this._installUnloadGuard();
  }

  /**
   * Forward a failure to {@link SaveManager#onError} without ever letting the
   * callback's own exception escape.
   * @param {string} code Error code.
   * @param {*} err Underlying failure.
   * @param {string} message German, user-facing description.
   * @returns {void}
   * @private
   */
  _report(code, err, message) {
    this.stats.failures++;
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.onError === null) return;
    try {
      this.onError(code, error, message);
    } catch (cbErr) {
      warnOnce('onError', 'the onError callback threw', cbErr);
    }
  }

  /**
   * Classify and report a write failure (quota gets its own message).
   * @param {*} err Underlying failure.
   * @param {string} [where='write'] Error code when it is not a quota problem.
   * @returns {void}
   * @private
   */
  _reportWriteError(err, where = 'write') {
    if (isQuotaError(err)) {
      const first = !this.quotaExceeded;
      this.quotaExceeded = true;
      warnOnce('quota', 'storage quota exceeded', err);
      if (first) {
        this._report('quota', err,
          'Der Speicherplatz ist voll. Bitte lösche alte Welten, sonst gehen Änderungen verloren.');
      } else {
        this.stats.failures++;
      }
      return;
    }
    warnOnce(where, 'a storage write failed', err);
    this._report(where, err, 'Eine Änderung konnte nicht gespeichert werden.');
  }

  /**
   * Attach page-hide listeners so a closing tab still commits its queue.
   * @returns {void}
   * @private
   */
  _installUnloadGuard() {
    if (!this.autoFlushOnHide || this._unhook !== null) return;
    const g = /** @type {any} */ (globalThis);
    if (typeof g.addEventListener !== 'function' || typeof g.document === 'undefined') return;
    const doc = g.document;
    const onVisibility = () => {
      if (doc && doc.visibilityState === 'hidden') this._onHide();
    };
    g.addEventListener('pagehide', this._onHide);
    if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);
    this._unhook = () => {
      try {
        g.removeEventListener('pagehide', this._onHide);
        if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
      } catch (err) {
        warnOnce('unhook', 'could not remove the page-hide listeners', err);
      }
    };
  }

  /**
   * Get the live database, opening it on demand.
   * @returns {Promise<IDBDatabase|null>} The database, or `null` in memory mode.
   * @private
   */
  async _ensureDb() {
    if (this.db !== null) return this.db;
    if (this.closed || this.memory) return null;
    await this.open();
    return this.db;
  }

  /**
   * Run `fn(store)` inside a fresh transaction and await its completion.
   * @param {string|string[]} storeNames Store name(s).
   * @param {'readonly'|'readwrite'} mode Transaction mode.
   * @param {(stores:Object)=>*} fn Body; receives `{name: IDBObjectStore}`.
   * @param {string} where Error code used when something fails.
   * @returns {Promise<*>} `fn`'s (awaited) result, or `null` on failure.
   * @private
   */
  async _tx(storeNames, mode, fn, where) {
    const db = await this._ensureDb();
    if (db === null) return null;
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    /** @type {IDBTransaction} */
    let tx;
    try {
      tx = db.transaction(names, mode);
    } catch (err) {
      if (mode === 'readwrite') this._reportWriteError(err, where);
      else {
        warnOnce(where, 'could not open a transaction', err);
        this._report(where, err, 'Auf den Speicher konnte nicht zugegriffen werden.');
      }
      return null;
    }
    /** @type {Object} */
    const stores = {};
    try {
      for (let i = 0; i < names.length; i++) stores[names[i]] = tx.objectStore(names[i]);
    } catch (err) {
      warnOnce(where, 'object store missing from the transaction', err);
      return null;
    }
    let result = null;
    let body = null;
    try {
      body = fn(stores);
    } catch (err) {
      if (mode === 'readwrite') this._reportWriteError(err, where);
      else warnOnce(where, 'transaction body threw', err);
      try {
        tx.abort();
      } catch (abortErr) {
        warnOnce(`${where}:abort`, 'could not abort the transaction', abortErr);
      }
      return null;
    }
    try {
      const settled = await Promise.all([Promise.resolve(body), idbTransaction(tx)]);
      result = settled[0];
    } catch (err) {
      if (mode === 'readwrite') this._reportWriteError(err, where);
      else {
        warnOnce(where, 'transaction failed', err);
        this._report(where, err, 'Gespeicherte Daten konnten nicht gelesen werden.');
      }
      return null;
    }
    return result === undefined ? null : result;
  }

  /* --------------------------------------------------------------- worlds -- */

  /**
   * All stored worlds, newest session first.
   * @returns {Promise<WorldMeta[]>} Sorted metadata list (empty on failure).
   */
  async listWorlds() {
    /** @type {WorldMeta[]} */
    let out = [];
    if (this.memory || (this.db === null && this.closed)) {
      out = Array.from(this._mem.worlds.values());
    } else {
      const rows = await this._tx(STORES.WORLDS, 'readonly',
        (s) => idbRequest(s[STORES.WORLDS].getAll()), 'read');
      if (Array.isArray(rows)) out = rows;
      else if (this.memory) out = Array.from(this._mem.worlds.values());
    }
    const list = [];
    for (let i = 0; i < out.length; i++) {
      const meta = out[i];
      if (meta && typeof meta.id === 'string') list.push(normalizeMeta(meta, meta));
    }
    list.sort((a, b) => (b.lastPlayed - a.lastPlayed) || (b.created - a.created) || a.name.localeCompare(b.name, 'de'));
    return list;
  }

  /**
   * Create (or overwrite) a world entry.
   * @param {Partial<WorldMeta>} meta Anything known so far; `id` is generated
   *   when missing, every other field gets a sane default.
   * @returns {Promise<WorldMeta|null>} The stored record, or `null` on failure.
   */
  async createWorld(meta) {
    const record = normalizeMeta(meta || {});
    record.created = record.created || Date.now();
    record.lastPlayed = Date.now();
    if (this.memory) {
      this._mem.worlds.set(record.id, record);
      return record;
    }
    const ok = await this._tx(STORES.WORLDS, 'readwrite', (s) => {
      s[STORES.WORLDS].put(record);
      return true;
    }, 'write');
    if (ok === null) {
      // Keep the session alive even though the write failed.
      this._mem.worlds.set(record.id, record);
      return this.memory ? record : null;
    }
    return record;
  }

  /**
   * Delete a world and **every** record that belongs to it: metadata, chunk
   * deltas, the player snapshot and all entity buckets. Pending chunk writes
   * for that world are dropped first so they cannot resurrect it.
   * @param {string} id World id.
   * @returns {Promise<boolean|null>} `true` on success, `null` on failure.
   */
  async deleteWorld(id) {
    if (typeof id !== 'string' || id.length === 0) return null;

    // Drop queued writes for this world.
    for (const key of Array.from(this._pending.keys())) {
      if (key.startsWith(`${id}|`)) this._pending.delete(key);
    }
    if (this._inflight !== null) {
      for (const key of Array.from(this._inflight.keys())) {
        if (key.startsWith(`${id}|`)) this._inflight.delete(key);
      }
    }
    this.stats.queued = this._pending.size;
    for (const key of Array.from(this._mem.chunks.keys())) {
      if (key.startsWith(`${id}|`)) this._mem.chunks.delete(key);
    }
    for (const key of Array.from(this._mem.entities.keys())) {
      if (key.startsWith(`${id}|`)) this._mem.entities.delete(key);
    }
    this._mem.worlds.delete(id);
    this._mem.players.delete(id);
    this._missCache.clear();

    if (this.memory) return true;

    const range = worldKeyRange(id);
    const ok = await this._tx(
      [STORES.WORLDS, STORES.CHUNKS, STORES.PLAYERS, STORES.ENTITIES],
      'readwrite',
      (s) => {
        s[STORES.WORLDS].delete(id);
        s[STORES.PLAYERS].delete(id);
        if (range !== null) {
          s[STORES.CHUNKS].delete(range);
          s[STORES.ENTITIES].delete(range);
          return true;
        }
        // Fallback: walk the byWorld indices when key ranges are unavailable.
        return Promise.all([
          this._deleteByIndex(s[STORES.CHUNKS], id),
          this._deleteByIndex(s[STORES.ENTITIES], id),
        ]).then(() => true);
      },
      'delete',
    );
    return ok === null ? null : true;
  }

  /**
   * Cursor-based deletion through the `byWorld` index (fallback path).
   * @param {IDBObjectStore} store Store to purge.
   * @param {string} worldId World id.
   * @returns {Promise<number>} Number of deleted rows.
   * @private
   */
  _deleteByIndex(store, worldId) {
    return new Promise((resolve) => {
      let removed = 0;
      /** @type {IDBRequest} */
      let req;
      try {
        req = store.index('byWorld').openKeyCursor(IDBKeyRange.only(worldId));
      } catch (err) {
        warnOnce('deleteIndex', 'byWorld index cursor failed', err);
        resolve(0);
        return;
      }
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(removed);
          return;
        }
        try {
          store.delete(cursor.primaryKey);
          removed++;
        } catch (err) {
          warnOnce('deleteIndexRow', 'could not delete an indexed row', err);
        }
        cursor.continue();
      };
      req.onerror = (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        resolve(removed);
      };
    });
  }

  /**
   * Read one world's metadata.
   * @param {string} worldId World id.
   * @returns {Promise<WorldMeta|null>} The record, or `null`.
   */
  async loadMeta(worldId) {
    if (typeof worldId !== 'string' || worldId.length === 0) return null;
    if (this.memory) {
      const m = this._mem.worlds.get(worldId);
      return m ? normalizeMeta(m, m) : null;
    }
    const rec = await this._tx(STORES.WORLDS, 'readonly',
      (s) => idbRequest(s[STORES.WORLDS].get(worldId)), 'read');
    if (rec && typeof rec === 'object') return normalizeMeta(rec, rec);
    const fallback = this._mem.worlds.get(worldId);
    return fallback ? normalizeMeta(fallback, fallback) : null;
  }

  /**
   * Merge and persist world metadata. Unknown fields are dropped, missing ones
   * are taken from the stored record so a partial update is safe.
   * @param {string} worldId World id.
   * @param {Partial<WorldMeta>} meta Fields to write.
   * @returns {Promise<WorldMeta|null>} The stored record, or `null`.
   */
  async saveMeta(worldId, meta) {
    if (typeof worldId !== 'string' || worldId.length === 0) return null;
    const previous = await this.loadMeta(worldId);
    const merged = normalizeMeta({ ...(meta || {}), id: worldId }, previous);
    merged.lastPlayed = Number.isFinite(Number(meta && meta.lastPlayed)) ? Number(meta.lastPlayed) : Date.now();
    if (this.memory) {
      this._mem.worlds.set(worldId, merged);
      return merged;
    }
    const ok = await this._tx(STORES.WORLDS, 'readwrite', (s) => {
      s[STORES.WORLDS].put(merged);
      return true;
    }, 'write');
    if (ok === null) {
      this._mem.worlds.set(worldId, merged);
      return null;
    }
    this._mem.worlds.set(worldId, merged);
    return merged;
  }

  /**
   * Bump `lastPlayed` and add to `playTime` — the cheap "the player is still
   * here" heartbeat used by the autosave timer.
   * @param {string} worldId World id.
   * @param {number} [playTimeDeltaSeconds=0] Seconds played since the last call.
   * @returns {Promise<WorldMeta|null>} The updated record, or `null`.
   */
  async touchWorld(worldId, playTimeDeltaSeconds = 0) {
    const previous = await this.loadMeta(worldId);
    if (previous === null) return null;
    const delta = Number.isFinite(Number(playTimeDeltaSeconds)) ? Math.max(0, Number(playTimeDeltaSeconds)) : 0;
    return this.saveMeta(worldId, { playTime: previous.playTime + delta, lastPlayed: Date.now() });
  }

  /**
   * Store the world-select thumbnail. Only `data:` URLs are accepted — the game
   * never references external assets.
   * @param {string} worldId World id.
   * @param {string|null} dataURL A `data:image/...` URL, or `null` to clear.
   * @returns {Promise<WorldMeta|null>} The updated record, or `null`.
   */
  async saveThumbnail(worldId, dataURL) {
    const value = typeof dataURL === 'string' && dataURL.indexOf('data:') === 0 ? dataURL : null;
    return this.saveMeta(worldId, { thumbnail: value });
  }

  /* --------------------------------------------------------------- chunks -- */

  /**
   * Queue one modified chunk for the next batch.
   *
   * The snapshot is encoded **synchronously**, so the caller may reuse, transfer
   * or drop its buffers the moment this returns, and the returned promise
   * resolves as soon as the record is queued — it deliberately does *not* wait
   * for the transaction. Callers such as `World#save()` await this in a serial
   * loop; blocking each iteration until the next timer tick would turn a
   * hundred-chunk save into a hundred seconds. {@link SaveManager#flush} is the
   * durability barrier (`World#save()` calls it right after its loop), and
   * write failures are reported through {@link SaveManager#onError}.
   *
   * @param {string} worldId World id.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @param {Object} data Output of `Chunk#serialize()`.
   * @returns {Promise<boolean|null>} `true` when queued (or written, in memory
   *   mode), `null` when the input was unusable or the manager is closed.
   */
  saveChunk(worldId, cx, cz, data) {
    if (this.closed) return Promise.resolve(null);
    if (typeof worldId !== 'string' || worldId.length === 0) return Promise.resolve(null);
    let record = null;
    try {
      record = encodeChunkRecord(worldId, cx, cz, data);
    } catch (err) {
      warnOnce('encode', 'chunk snapshot could not be encoded', err);
      this._report('encode', err, 'Ein Chunk konnte nicht gespeichert werden.');
      return Promise.resolve(null);
    }
    if (record === null) return Promise.resolve(null);

    const key = chunkCacheKey(worldId, cx, cz);
    this._missCache.delete(key);

    if (this.memory) {
      this._stashChunk(key, record);
      this.stats.chunksWritten++;
      this.stats.bytesWritten += chunkRecordBytes(record);
      return Promise.resolve(true);
    }

    this._pending.set(key, record);
    this.stats.queued = this._pending.size;
    if (this._pending.size >= MAX_BATCH) {
      this._clearTimer();
      this._drain();
    } else {
      this._scheduleFlush();
    }
    return Promise.resolve(true);
  }

  /**
   * Read one stored chunk delta.
   *
   * Pending and in-flight writes are consulted first, so a chunk that was
   * unloaded a moment ago and is being streamed back in never reads stale data.
   *
   * @param {string} worldId World id.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @returns {Promise<Object|null>} A `Chunk.deserialize()` input object, or
   *   `null` when nothing is stored (the caller then generates the chunk).
   */
  async loadChunk(worldId, cx, cz) {
    if (typeof worldId !== 'string' || worldId.length === 0) return null;
    const key = chunkCacheKey(worldId, cx, cz);

    const queued = this._lookupQueued(key);
    if (queued !== null) return this._decodeCounted(queued);
    if (this._missCache.has(key)) return null;
    if (this.memory) return null;

    const rec = await this._tx(STORES.CHUNKS, 'readonly',
      (s) => idbRequest(s[STORES.CHUNKS].get([worldId, cx | 0, cz | 0])), 'read');

    // A write may have landed while we were reading — prefer it.
    const queuedAfter = this._lookupQueued(key);
    if (queuedAfter !== null) return this._decodeCounted(queuedAfter);

    if (!rec) {
      this._missCache.set(key, 1);
      return null;
    }
    return this._decodeCounted(rec);
  }

  /**
   * Look a chunk key up in the pending queue, the in-flight batch and the
   * memory overflow store, in that order.
   * @param {string} key Cache key.
   * @returns {Object|null} The record, or `null`.
   * @private
   */
  _lookupQueued(key) {
    const pending = this._pending.get(key);
    if (pending !== undefined) return pending;
    if (this._inflight !== null) {
      const flying = this._inflight.get(key);
      if (flying !== undefined) return flying;
    }
    const mem = this._mem.chunks.get(key);
    return mem !== undefined ? mem : null;
  }

  /**
   * Decode a record and count the read.
   * @param {Object} rec Stored record.
   * @returns {Object|null} Decoded snapshot.
   * @private
   */
  _decodeCounted(rec) {
    let out = null;
    try {
      out = decodeChunkRecord(rec);
    } catch (err) {
      warnOnce('decode', 'stored chunk could not be decoded', err);
      out = null;
    }
    if (out !== null) this.stats.chunksRead++;
    return out;
  }

  /**
   * Remove one chunk delta so the chunk reverts to pure generator output.
   * @param {string} worldId World id.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @returns {Promise<boolean|null>} `true` on success, `null` on failure.
   */
  async deleteChunk(worldId, cx, cz) {
    if (typeof worldId !== 'string' || worldId.length === 0) return null;
    const key = chunkCacheKey(worldId, cx, cz);
    this._pending.delete(key);
    if (this._inflight !== null) this._inflight.delete(key);
    this._mem.chunks.delete(key);
    this.stats.queued = this._pending.size;
    this._missCache.set(key, 1);
    if (this.memory) return true;
    const ok = await this._tx(STORES.CHUNKS, 'readwrite', (s) => {
      s[STORES.CHUNKS].delete([worldId, cx | 0, cz | 0]);
      return true;
    }, 'delete');
    return ok === null ? null : true;
  }

  /**
   * Count the stored chunk deltas of one world (for the world-select screen).
   * @param {string} worldId World id.
   * @returns {Promise<number>} The count, `0` on failure.
   */
  async countChunks(worldId) {
    if (typeof worldId !== 'string' || worldId.length === 0) return 0;
    if (this.memory) {
      let n = 0;
      for (const key of this._mem.chunks.keys()) if (key.startsWith(`${worldId}|`)) n++;
      return n;
    }
    const n = await this._tx(STORES.CHUNKS, 'readonly',
      (s) => idbRequest(s[STORES.CHUNKS].index('byWorld').count(IDBKeyRange.only(worldId))), 'read');
    return Number.isFinite(n) ? n : 0;
  }

  /* --------------------------------------------------------------- player -- */

  /**
   * Persist the player snapshot for one world.
   * @param {string} worldId World id.
   * @param {Object} data Output of `Player#serialize()`.
   * @returns {Promise<boolean|null>} `true` on success, `null` on failure.
   */
  async savePlayer(worldId, data) {
    if (typeof worldId !== 'string' || worldId.length === 0) return null;
    if (!data || typeof data !== 'object') return null;
    const record = { worldId, v: SAVE_FORMAT_VERSION, savedAt: Date.now(), data };
    if (this.memory) {
      this._mem.players.set(worldId, record);
      return true;
    }
    const ok = await this._tx(STORES.PLAYERS, 'readwrite', (s) => {
      s[STORES.PLAYERS].put(record);
      return true;
    }, 'write');
    if (ok === null) {
      this._mem.players.set(worldId, record);
      return null;
    }
    return true;
  }

  /**
   * Read the player snapshot of one world.
   * @param {string} worldId World id.
   * @returns {Promise<Object|null>} The `Player#deserialize()` payload, or `null`.
   */
  async loadPlayer(worldId) {
    if (typeof worldId !== 'string' || worldId.length === 0) return null;
    if (this.memory) {
      const rec = this._mem.players.get(worldId);
      return rec && rec.data ? rec.data : null;
    }
    const rec = await this._tx(STORES.PLAYERS, 'readonly',
      (s) => idbRequest(s[STORES.PLAYERS].get(worldId)), 'read');
    if (rec && typeof rec === 'object' && rec.data && typeof rec.data === 'object') return rec.data;
    const fallback = this._mem.players.get(worldId);
    return fallback && fallback.data ? fallback.data : null;
  }

  /* ------------------------------------------------------------- entities -- */

  /**
   * Persist the loose entities of one world.
   *
   * The list is split into buckets of {@link ENTITY_BUCKET_SIZE} records so a
   * world with thousands of dropped items does not become one giant row that
   * has to be re-cloned on every write. Bucket `0` carries the header
   * (`nextId`, `buckets`); stale buckets from a previous, larger save are
   * deleted in the same transaction.
   *
   * @param {string} worldId World id.
   * @param {{entities:Object[], nextId?:number}|Object[]} data Output of
   *   `EntityManager#serialize()`.
   * @returns {Promise<boolean|null>} `true` on success, `null` on failure.
   */
  async saveEntities(worldId, data) {
    if (typeof worldId !== 'string' || worldId.length === 0) return null;
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.entities) ? data.entities : null);
    if (list === null) return null;
    const nextId = data && Number.isFinite(Number(data.nextId)) ? Number(data.nextId) | 0 : 0;
    const bucketCount = Math.max(1, Math.min(MAX_ENTITY_BUCKETS, Math.ceil(list.length / ENTITY_BUCKET_SIZE) || 1));
    const now = Date.now();
    /** @type {Object[]} */
    const records = [];
    for (let b = 0; b < bucketCount; b++) {
      records.push({
        worldId,
        bucket: b,
        v: SAVE_FORMAT_VERSION,
        savedAt: now,
        nextId: b === 0 ? nextId : 0,
        buckets: b === 0 ? bucketCount : 0,
        entities: list.slice(b * ENTITY_BUCKET_SIZE, (b + 1) * ENTITY_BUCKET_SIZE),
      });
    }

    if (this.memory) {
      for (const key of Array.from(this._mem.entities.keys())) {
        if (key.startsWith(`${worldId}|`)) this._mem.entities.delete(key);
      }
      for (let i = 0; i < records.length; i++) this._mem.entities.set(`${worldId}|${i}`, records[i]);
      return true;
    }

    const ok = await this._tx(STORES.ENTITIES, 'readwrite', (s) => {
      const store = s[STORES.ENTITIES];
      for (let i = 0; i < records.length; i++) store.put(records[i]);
      // Purge buckets left over from a larger previous save.
      try {
        store.delete(IDBKeyRange.bound([worldId, bucketCount], [worldId, []], false, false));
      } catch (err) {
        warnOnce('entityPurge', 'stale entity buckets could not be purged', err);
      }
      return true;
    }, 'write');
    return ok === null ? null : true;
  }

  /**
   * Read every entity bucket of one world and reassemble the flat list.
   * @param {string} worldId World id.
   * @returns {Promise<{entities:Object[], nextId:number}|null>} The
   *   `EntityManager#deserialize()` payload, or `null` when nothing is stored.
   */
  async loadEntities(worldId) {
    if (typeof worldId !== 'string' || worldId.length === 0) return null;
    /** @type {Object[]} */
    let rows = [];
    if (this.memory) {
      for (const [key, rec] of this._mem.entities) if (key.startsWith(`${worldId}|`)) rows.push(rec);
    } else {
      const range = worldKeyRange(worldId);
      const result = await this._tx(STORES.ENTITIES, 'readonly', (s) => {
        const store = s[STORES.ENTITIES];
        return idbRequest(range !== null ? store.getAll(range) : store.index('byWorld').getAll(IDBKeyRange.only(worldId)));
      }, 'read');
      if (Array.isArray(result)) rows = result;
    }
    if (rows.length === 0) return null;
    rows.sort((a, b) => (a.bucket | 0) - (b.bucket | 0));
    /** @type {Object[]} */
    const entities = [];
    let nextId = 0;
    for (let i = 0; i < rows.length; i++) {
      const rec = rows[i];
      if (!rec) continue;
      if (Number.isFinite(rec.nextId) && rec.nextId > nextId) nextId = rec.nextId | 0;
      if (Array.isArray(rec.entities)) {
        for (let j = 0; j < rec.entities.length; j++) {
          const e = rec.entities[j];
          if (e && typeof e === 'object') entities.push(e);
        }
      }
    }
    return { entities, nextId };
  }

  /* ---------------------------------------------------------------- flush -- */

  /**
   * Arm the batch timer if it is not already running.
   * @returns {void}
   * @private
   */
  _scheduleFlush() {
    if (this._timer !== null || this.closed) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._drain();
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * Cancel the batch timer.
   * @returns {void}
   * @private
   */
  _clearTimer() {
    if (this._timer === null) return;
    clearTimeout(this._timer);
    this._timer = null;
  }

  /**
   * Serial drain loop: keeps committing batches until the queue is empty. Only
   * one loop ever runs; concurrent callers share its promise.
   * @returns {Promise<void>} Resolves when the queue is (momentarily) empty.
   * @private
   */
  _drain() {
    if (this._draining) return this._drainPromise || Promise.resolve();
    this._draining = true;
    this._drainOk = true;
    this._drainPromise = (async () => {
      let guard = 0;
      while (this._pending.size !== 0 && guard < MAX_DRAIN_BATCHES) {
        guard++;
        if (await this._flushBatch() === null) this._drainOk = false;
      }
      if (guard >= MAX_DRAIN_BATCHES) {
        warnOnce('drainGuard', 'flush loop hit its batch guard; queue stays non-empty');
        this._drainOk = false;
      }
      this._draining = false;
      this._drainPromise = null;
    })();
    return this._drainPromise;
  }

  /**
   * Commit the whole pending queue in exactly one transaction.
   * @returns {Promise<boolean|null>} `true` when everything was written.
   * @private
   */
  async _flushBatch() {
    this._clearTimer();
    if (this._pending.size === 0) return true;
    const batch = this._pending;
    this._pending = new Map();
    this.stats.queued = 0;
    this._inflight = batch;

    const started = nowMs();
    let ok = null;
    try {
      ok = await this._writeBatch(batch);
    } catch (err) {
      this._reportWriteError(err, 'write');
      ok = null;
    }
    this.stats.lastFlushMs = nowMs() - started;
    this._inflight = null;
    return ok;
  }

  /**
   * Write one batch of chunk records.
   * @param {Map<string, Object>} batch Records keyed by cache key.
   * @returns {Promise<boolean|null>} `true` when every record landed.
   * @private
   */
  async _writeBatch(batch) {
    const db = await this._ensureDb();
    if (db === null) {
      // Degraded: keep the edits in memory so the session is not corrupted.
      for (const [key, rec] of batch) this._stashChunk(key, rec);
      return null;
    }
    /** @type {IDBTransaction} */
    let tx;
    try {
      tx = db.transaction(STORES.CHUNKS, 'readwrite');
    } catch (err) {
      this._reportWriteError(err, 'write');
      for (const [key, rec] of batch) this._stashChunk(key, rec);
      return null;
    }
    const store = tx.objectStore(STORES.CHUNKS);
    /** @type {string[]} Keys the store refused; kept in memory afterwards. */
    const failedKeys = [];
    let bytes = 0;
    for (const [key, rec] of batch) {
      try {
        const req = store.put(rec);
        req.onerror = (ev) => {
          // preventDefault() keeps one bad record from aborting the whole batch.
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
          failedKeys.push(key);
          this._reportWriteError(req.error, 'write');
        };
        bytes += chunkRecordBytes(rec);
      } catch (err) {
        // Synchronous throw: DataCloneError from a rogue block entity, or a
        // dead transaction. Skip the record instead of losing the batch.
        failedKeys.push(key);
        this._reportWriteError(err, 'write');
      }
    }
    try {
      await idbTransaction(tx);
    } catch (err) {
      this._reportWriteError(err, 'write');
      for (const [key, rec] of batch) this._stashChunk(key, rec);
      return null;
    }
    // Whatever the store refused (quota, clone) stays in memory so the running
    // session keeps its edits even though they will not survive a reload.
    const refused = new Set(failedKeys);
    for (let i = 0; i < failedKeys.length; i++) {
      const key = failedKeys[i];
      const rec = batch.get(key);
      if (rec !== undefined) this._stashChunk(key, rec);
    }
    // Anything that *did* land must drop out of the overflow store, otherwise
    // an older stashed copy would shadow the fresh row on the next read.
    if (this._mem.chunks.size !== 0) {
      for (const key of batch.keys()) if (!refused.has(key)) this._mem.chunks.delete(key);
    }
    this.stats.batches++;
    this.stats.chunksWritten += Math.max(0, batch.size - failedKeys.length);
    this.stats.bytesWritten += bytes;
    return failedKeys.length === 0 ? true : null;
  }

  /**
   * Park a chunk record in the in-memory overflow store. In true memory mode
   * this map *is* the storage and never evicts; when it is only catching failed
   * database writes it is capped so a persistent quota error cannot grow the
   * heap without bound.
   * @param {string} key Chunk cache key.
   * @param {Object} rec Encoded record.
   * @returns {void}
   * @private
   */
  _stashChunk(key, rec) {
    this._mem.chunks.set(key, rec);
    if (this.memory) return;
    while (this._mem.chunks.size > MEM_OVERFLOW_LIMIT) {
      const oldest = this._mem.chunks.keys().next().value;
      if (oldest === undefined) break;
      this._mem.chunks.delete(oldest);
    }
  }

  /**
   * Commit everything that is queued and wait for it. This is the durability
   * barrier: after it resolves `true`, every chunk handed to
   * {@link SaveManager#saveChunk} before the call is on disk.
   * @returns {Promise<boolean|null>} `true` when the queue is empty and every
   *   write succeeded, `null` when at least one write failed.
   */
  async flush() {
    if (this.memory) return true;
    if (this._pending.size === 0 && !this._draining) return this._drainOk ? true : null;
    this._clearTimer();
    try {
      await this._drain();
    } catch (err) {
      this._reportWriteError(err, 'write');
      return null;
    }
    return this._drainOk && this._pending.size === 0 ? true : null;
  }

  /* ---------------------------------------------------------------- close -- */

  /**
   * Stop the timers, commit whatever is queued and close the database.
   *
   * Returns immediately; the final flush runs in the background and closes the
   * connection when it is done. Callers that need durability (e.g. before
   * navigating away) should `await save.flush()` first.
   * @returns {void}
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    this._clearTimer();
    if (this._unhook !== null) {
      this._unhook();
      this._unhook = null;
    }
    const db = this.db;
    const finish = () => {
      // `this.db` stays live until here so the final drain can still write.
      this.db = null;
      if (db === null) return;
      try {
        db.close();
      } catch (err) {
        warnOnce('close', 'the database could not be closed', err);
      }
    };
    if (this._pending.size !== 0 && db !== null) {
      // The queue must go out before the handle dies; `_drain` never throws.
      this._drain().then(finish, finish);
    } else {
      finish();
    }
  }

  /**
   * Reopen a manager that was closed (e.g. after the browser dropped the
   * connection for a schema upgrade in another tab).
   * @returns {Promise<boolean>} Same contract as {@link SaveManager#open}.
   */
  async reopen() {
    if (!this.closed) return this.open();
    this.closed = false;
    this.memory = false;
    this.db = null;
    return this.open();
  }

  /* ---------------------------------------------------------------- stats -- */

  /**
   * Live counters for the F3 overlay and the pause screen.
   * @returns {{backend:string, pending:number, inflight:number,
   *   chunksWritten:number, chunksRead:number, batches:number,
   *   bytesWritten:number, bytesText:string, failures:number,
   *   quotaExceeded:boolean, lastFlushMs:number}} Snapshot of the counters.
   */
  getStats() {
    return {
      backend: this.memory ? 'memory' : (this.db !== null ? 'indexeddb' : 'closed'),
      pending: this._pending.size,
      inflight: this._inflight === null ? 0 : this._inflight.size,
      chunksWritten: this.stats.chunksWritten,
      chunksRead: this.stats.chunksRead,
      batches: this.stats.batches,
      bytesWritten: this.stats.bytesWritten,
      bytesText: formatBytes(this.stats.bytesWritten),
      failures: this.stats.failures,
      quotaExceeded: this.quotaExceeded,
      lastFlushMs: this.stats.lastFlushMs,
    };
  }
}
