/**
 * @file VOXELIA world manager: chunk streaming, worker pool, meshing, raycast
 *       and collision queries (ARCHITECTURE.md 5.14).
 *
 * The `World` owns everything that lives in voxel space on the main thread:
 *
 *  * **A pool of module workers** (`min(4, max(1, hardwareConcurrency - 1))`)
 *    created from `world/worker.js`. Jobs are round-robin dispatched with a
 *    per-worker in-flight limit; every job is tracked in a map so a chunk that
 *    is unloaded before its job returns simply drops the result. If workers are
 *    unavailable (no `Worker`, module workers blocked, worker crash) the world
 *    degrades to a time-budgeted main-thread generator/mesher instead of dying.
 *  * **Streaming**: a spiral ordered offset table around the camera chunk feeds
 *    a nearest-first generation queue; chunks beyond `renderDistance + 2` are
 *    saved (when modified) and unloaded.
 *  * **The chunk lifecycle**
 *    `empty -> generating -> generated -> (skylight + pending structure edits)
 *     -> lit -> meshing -> ready`.
 *    A section is only meshed once all eight horizontal neighbour chunks are at
 *    least `generated`, otherwise light and AO would be wrong at the borders.
 *  * **Time budgets**: every phase of `update()` runs under its own
 *    {@link TimeBudget}; mesh uploads never exceed 3 ms per frame and the light
 *    engine gets a fixed slice through `lighting.process()`.
 *
 * No frame path allocates: the padded 18^3 mesh inputs are the only per-job
 * buffers (they are transferred to a worker and therefore cannot be pooled),
 * culling reuses one list, and collision boxes come from an internal pool.
 *
 * This module runs on the main thread only — it is the one file under
 * `src/world/` that touches the GL wrapper — but it still avoids `document` and
 * `window` at module scope so importing it from a worker cannot throw.
 */

import { EventBus, TimeBudget, nowMs } from '../core/util.js';
import {
  CHUNK_SIZE,
  SECTION_SIZE,
  SECTION_COUNT,
  WORLD_MIN_Y,
  WORLD_MAX_Y,
  SKY_FULL_PACKED,
  Chunk,
  chunkKey,
} from './chunk.js';
import { LightEngine } from './lighting.js';
import { WorldGenerator, GEN_VERSION } from './worldgen.js';
import { meshSection } from './mesher.js';
import {
  RENDER,
  BLOCK_BY_NAME,
  ABSORB_TABLE,
  blockAABBs,
  blockRender,
  isSolid,
  isLiquid,
} from './blocks.js';
import { resolveBiomeBlocks } from './biomes.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Edge length of the padded neighbourhood handed to the mesher. @type {number} */
const PAD = 18;
/** Flat stride along Z inside the padded neighbourhood. @type {number} */
const PAD_Z = PAD;
/** Flat stride along Y inside the padded neighbourhood. @type {number} */
const PAD_Y = PAD * PAD;
/** Voxels in the padded neighbourhood. @type {number} */
const PAD_VOL = PAD * PAD * PAD;
/** Columns in the padded biome plane. @type {number} */
const PAD_AREA = PAD * PAD;

/** Hard upper bound on pool size (spec 7). @type {number} */
const MAX_WORKERS = 4;
/** Jobs a single worker may have in flight at once. @type {number} */
const MAX_INFLIGHT_PER_WORKER = 3;
/** Share of the pool capacity generation jobs may occupy. @type {number} */
const GEN_CAPACITY_SHARE = 0.6;

/** Milliseconds `update()` may spend dispatching generation jobs. @type {number} */
const GEN_DISPATCH_BUDGET_MS = 1.5;
/** Milliseconds `update()` may spend uploading finished meshes (spec 7). @type {number} */
const MESH_UPLOAD_BUDGET_MS = 3;
/** Milliseconds `update()` hands to the light engine. @type {number} */
const LIGHT_BUDGET_MS = 2;
/** Milliseconds `update()` may spend building and dispatching mesh jobs. @type {number} */
const MESH_DISPATCH_BUDGET_MS = 1.5;
/** Milliseconds the worker-less fallback may spend generating per update. @type {number} */
const LOCAL_GEN_BUDGET_MS = 6;
/** Milliseconds the worker-less fallback may spend meshing per update. @type {number} */
const LOCAL_MESH_BUDGET_MS = 4;

/** How many chunks may wait for a free worker before streaming pauses. @type {number} */
const GEN_QUEUE_SLACK = 8;
/** Concurrent `saveManager.loadChunk()` reads. @type {number} */
const MAX_DISK_LOADS = 8;
/** Chunks whose deferred structure edits are kept while they are not loaded. @type {number} */
const MAX_PENDING_EDIT_CHUNKS = 8192;
/** Grace period after lighting a chunk before it is meshed anyway. @type {number} */
const MESH_LIGHT_GRACE_MS = 250;
/** Seconds between two full unload scans while the camera stays in one chunk. @type {number} */
const UNLOAD_SCAN_INTERVAL_MS = 1000;
/** Milliseconds between two chunk memory recomputations for `getStats()`. @type {number} */
const MEMORY_SAMPLE_INTERVAL_MS = 500;
/** Safety margin added to every section AABB for vertex-animated (waving) geometry. @type {number} */
const AABB_MARGIN = 0.5;
/** How long {@link World#init} waits for a worker's `ready` message. @type {number} */
const WORKER_READY_TIMEOUT_MS = 20000;

/** Selection box used for `RENDER.CROSS` blocks that have no collision box. @type {number[][]} */
const CROSS_SELECTION = [[0.1, 0, 0.1, 0.9, 0.8, 0.9]];
/** Selection box used for fluids. @type {number[][]} */
const FLUID_SELECTION = [[0, 0, 0, 1, 0.875, 1]];
/** Selection box used for any other box-less block. @type {number[][]} */
const CUBE_SELECTION = [[0, 0, 0, 1, 1, 1]];

/** Neighbour offsets of the eight horizontal neighbours. @type {number[]} */
const NEIGHBOUR_OFFSETS = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1];

/** Resolved URL of the worker entry point. @type {URL|null} */
const WORKER_URL = (() => {
  try {
    return new URL('./worker.js', import.meta.url);
  } catch (e) {
    return null;
  }
})();

/**
 * Documentation-only description of the objects `iterateRenderList()` hands to
 * its callback and that live in `chunk.meshes[sy]`.
 *
 * ```
 * { cx, cz, sy,                       // owning chunk + section index
 *   originX, originY, originZ,        // world position of the section corner
 *   aabb: [minX,minY,minZ,maxX,maxY,maxZ],   // world space, wave margin included
 *   opaque: { vao, indexCount } | null,
 *   cutout: { vao, indexCount } | null,
 *   water:  { vao, indexCount } | null,
 *   version }                         // section content stamp this mesh was built from
 * ```
 * Every bucket additionally carries its `vbo`, `ibo`, `vertexCount` and `bytes`
 * so the mesh can free itself; `vao.indexType` is `gl.UNSIGNED_INT`.
 * @type {Readonly<Object>}
 */
export const SectionMeshShape = Object.freeze({
  cx: 0,
  cz: 0,
  sy: 0,
  originX: 0,
  originY: 0,
  originZ: 0,
  aabb: Object.freeze([0, 0, 0, 0, 0, 0]),
  opaque: null,
  cutout: null,
  water: null,
  version: 0,
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Read component 0 of a vector that may be an array or an `{x,y,z}` object.
 * @param {ArrayLike<number>|{x:number}} v Source vector.
 * @returns {number} X component.
 */
function vx(v) {
  return typeof v.x === 'number' ? v.x : v[0];
}

/**
 * Read component 1 of a vector that may be an array or an `{x,y,z}` object.
 * @param {ArrayLike<number>|{y:number}} v Source vector.
 * @returns {number} Y component.
 */
function vy(v) {
  return typeof v.y === 'number' ? v.y : v[1];
}

/**
 * Read component 2 of a vector that may be an array or an `{x,y,z}` object.
 * @param {ArrayLike<number>|{z:number}} v Source vector.
 * @returns {number} Z component.
 */
function vz(v) {
  return typeof v.z === 'number' ? v.z : v[2];
}

/**
 * Number of workers to spawn: `min(4, max(1, hardwareConcurrency - 1))`.
 * @returns {number} Pool size.
 */
function poolSize() {
  let cores = 4;
  if (typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)) {
    cores = navigator.hardwareConcurrency;
  }
  return Math.min(MAX_WORKERS, Math.max(1, (cores | 0) - 1));
}

/**
 * Selection / collision boxes of a block, with sane fallbacks for blocks that
 * declare no box at all (plants, fluids, portals).
 * @param {number} id Block id.
 * @param {number} state Block state.
 * @returns {ArrayLike<ArrayLike<number>>} List of `[minX,minY,minZ,maxX,maxY,maxZ]`.
 */
function selectionBoxes(id, state) {
  const boxes = blockAABBs(id, state);
  if (boxes.length !== 0) return boxes;
  const render = blockRender(id);
  if (render === RENDER.CROSS) return CROSS_SELECTION;
  if (render === RENDER.FLUID) return FLUID_SELECTION;
  return CUBE_SELECTION;
}

// ---------------------------------------------------------------------------
// SectionMesh
// ---------------------------------------------------------------------------

/**
 * GPU residency of one meshed section: up to three buckets (opaque, cutout,
 * water), each with its own VAO, vertex buffer and index buffer, plus the
 * precomputed world AABB used for frustum culling and front-to-back sorting.
 */
class SectionMesh {
  /**
   * @param {World} world Owning world (needed for GL access and statistics).
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @param {number} sy Section index 0..23.
   * @param {number} version Section content stamp this mesh was built from.
   */
  constructor(world, cx, cz, sy, version) {
    /** @type {World} @private */
    this._world = world;
    /** @type {number} Chunk X coordinate. */
    this.cx = cx;
    /** @type {number} Chunk Z coordinate. */
    this.cz = cz;
    /** @type {number} Section index 0..23. */
    this.sy = sy;
    /** @type {number} World X of the section corner. */
    this.originX = cx * CHUNK_SIZE;
    /** @type {number} World Y of the section corner. */
    this.originY = WORLD_MIN_Y + sy * SECTION_SIZE;
    /** @type {number} World Z of the section corner. */
    this.originZ = cz * CHUNK_SIZE;
    /** @type {number[]} World AABB `[minX,minY,minZ,maxX,maxY,maxZ]`. */
    this.aabb = [
      this.originX, this.originY, this.originZ,
      this.originX + SECTION_SIZE, this.originY + SECTION_SIZE, this.originZ + SECTION_SIZE,
    ];
    /** @type {{vao:WebGLVertexArrayObject, indexCount:number, vbo:WebGLBuffer, ibo:WebGLBuffer, vertexCount:number, bytes:number}|null} */
    this.opaque = null;
    /** @type {{vao:WebGLVertexArrayObject, indexCount:number, vbo:WebGLBuffer, ibo:WebGLBuffer, vertexCount:number, bytes:number}|null} */
    this.cutout = null;
    /** @type {{vao:WebGLVertexArrayObject, indexCount:number, vbo:WebGLBuffer, ibo:WebGLBuffer, vertexCount:number, bytes:number}|null} */
    this.water = null;
    /** @type {number} Section content stamp this mesh was built from. */
    this.version = version;
    /** @type {number} Total vertices across all buckets. */
    this.vertexCount = 0;
    /** @type {number} Total triangles across all buckets. */
    this.triangleCount = 0;
    /** @type {number} Bytes of GPU memory held by all buckets. */
    this.bytes = 0;
    /** @type {number} Squared distance to the camera, refreshed while culling. */
    this.distSq = 0;
    /** @type {number} Index inside the world's flat mesh list, -1 when detached. @private */
    this._listIndex = -1;
    /** @type {boolean} Whether {@link SectionMesh#dispose} already ran. */
    this.disposed = false;
  }

  /**
   * Whether this mesh holds any drawable geometry at all.
   * @returns {boolean} `true` when at least one bucket exists.
   */
  get isEmpty() {
    return this.opaque === null && this.cutout === null && this.water === null;
  }

  /**
   * Release every GL object owned by this mesh and detach it from the world.
   * Safe to call twice; `Chunk.dispose()` calls this for all its sections.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const world = this._world;
    if (world) world._retireMesh(this);
    this._world = null;
    this.opaque = null;
    this.cutout = null;
    this.water = null;
  }
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

/**
 * One pooled module worker plus its in-flight bookkeeping.
 */
class WorkerHandle {
  /**
   * @param {World} world Owning world.
   * @param {number} index Slot inside the pool.
   * @param {Worker} worker The live worker.
   */
  constructor(world, index, worker) {
    /** @type {number} Slot inside the pool. */
    this.index = index;
    /** @type {Worker} The underlying module worker. */
    this.worker = worker;
    /** @type {number} Jobs currently dispatched to this worker. */
    this.inflight = 0;
    /** @type {boolean} `false` once the worker failed or was terminated. */
    this.alive = true;
    /** @type {boolean} `true` once the worker acknowledged its `init` message. */
    this.ready = false;
    /** @type {(() => void)|null} Resolver of the pending `ready` promise. */
    this.resolveReady = null;
    /** @type {*} Timeout handle guarding the `ready` promise. */
    this.readyTimer = null;
    worker.onmessage = (e) => world._onWorkerMessage(this, e.data);
    worker.onerror = (e) => world._onWorkerFailure(this, e && e.message ? e.message : 'worker error');
    worker.onmessageerror = () => world._onWorkerFailure(this, 'worker message could not be deserialized');
  }

  /**
   * Post a message to the worker.
   * @param {Object} msg Message payload.
   * @param {Transferable[]} [transfer] Buffers to transfer.
   * @returns {void}
   */
  post(msg, transfer) {
    if (!this.alive) return;
    if (transfer && transfer.length !== 0) this.worker.postMessage(msg, transfer);
    else this.worker.postMessage(msg);
  }

  /**
   * Kill the worker.
   * @returns {void}
   */
  terminate() {
    if (!this.alive) return;
    this.alive = false;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    try {
      this.worker.postMessage({ type: 'dispose' });
    } catch (e) {
      /* the worker may already be gone; termination follows anyway */
    }
    this.worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/**
 * The main-thread voxel world: chunk store, worker pool, streaming, lighting
 * driver, mesh uploader and the query surface (`getBlock`, `raycast`,
 * `getCollisionAABBs`, `iterateRenderList`).
 *
 * Events emitted on the bus:
 * `'chunkLoaded'(chunk)`, `'chunkReady'(chunk)`, `'chunkUnloaded'(chunk)`,
 * `'blockChanged'(x, y, z, oldId, newId)`, `'error'(where, error)`.
 */
export class World extends EventBus {
  /**
   * @param {import('../core/gl.js').GL} gl The GL wrapper (buffers + VAOs).
   * @param {import('../core/settings.js').Settings} settings Live settings.
   * @param {{seed?:number, name?:string, dimension?:string, id?:string,
   *   generator?:Object}} [options] World identity and generator options.
   */
  constructor(gl, settings, options = {}) {
    super();
    /** @type {import('../core/gl.js').GL} The GL wrapper. */
    this.gl = gl;
    /** @type {import('../core/settings.js').Settings} Live settings. */
    this.settings = settings;
    /** @type {number} World seed. */
    this.seed = Number.isFinite(options.seed) ? (options.seed | 0) : ((Math.random() * 0x7fffffff) | 0);
    /** @type {string} Display name of this world. */
    this.name = options.name || 'world';
    /** @type {string} Dimension key. */
    this.dimension = options.dimension || 'overworld';
    /** @type {string} Persistence id used with the save manager. */
    this.worldId = options.id || this.name;
    /** @type {Object} Extra options forwarded to the world generator. */
    this.generatorOptions = options.generator || {};

    /** @type {Map<string, Chunk>} Live chunks keyed by `"cx,cz"`. */
    this.chunks = new Map();
    /** @type {WorldGenerator|null} Main-thread generator (queries + fallback). */
    this.generator = null;
    /** @type {LightEngine} Colored flood-fill light engine. */
    this.lighting = new LightEngine(this);
    /** @type {Object[]} Entities living in this world (owned by `game/entities.js`). */
    this.entities = [];
    /** @type {Map<string, number[]>} Deferred structure edits, flat `[x,y,z,id,...]`. */
    this.pendingEdits = new Map();
    /** @type {number[]|null} Preferred spawn point, filled by `load()`. */
    this.spawn = null;
    /** @type {boolean} Set by {@link World#dispose}. */
    this.disposed = false;
    /** @type {boolean} `true` once {@link World#init} finished. */
    this.initialized = false;

    // -- worker pool -------------------------------------------------------
    /** @type {WorkerHandle[]} @private */
    this._workers = [];
    /** @type {Map<number, Object>} Job id -> job record. @private */
    this._jobs = new Map();
    /** @type {number} @private */
    this._nextJobId = 1;
    /** @type {number} Round-robin cursor. @private */
    this._rr = 0;
    /** @type {number} Generation jobs currently dispatched. @private */
    this._genInflight = 0;
    /** @type {number} Mesh jobs currently dispatched. @private */
    this._meshInflight = 0;
    /** @type {number} Maximum concurrent generation jobs. @private */
    this._genCap = MAX_INFLIGHT_PER_WORKER;
    /** @type {boolean} `true` when everything runs on the main thread. @private */
    this._localMode = true;

    // -- streaming ---------------------------------------------------------
    /** @type {Int32Array} Spiral offsets `(dx, dz)` sorted by distance. @private */
    this._spiral = new Int32Array(0);
    /** @type {number} Radius the spiral was built for. @private */
    this._spiralRadius = -1;
    /** @type {number} @private */
    this._renderDistance = 0;
    /** @type {Chunk[]} Chunks waiting for a free worker, nearest first. @private */
    this._genQueue = [];
    /** @type {number} Chunks in the `generating` state. @private */
    this._generating = 0;
    /** @type {number} Concurrent save-manager chunk reads. @private */
    this._diskLoads = 0;
    /** @type {Array<{job:Object, msg:Object}>} Finished mesh jobs awaiting upload. @private */
    this._meshQueue = [];

    // -- camera / frame state ---------------------------------------------
    /** @type {number} @private */ this._camX = 0;
    /** @type {number} @private */ this._camY = 0;
    /** @type {number} @private */ this._camZ = 0;
    /** @type {number} @private */ this._camChunkX = 0;
    /** @type {number} @private */ this._camChunkZ = 0;
    /** @type {boolean} @private */ this._hasCamera = false;
    /** @type {number} @private */ this._lastUnloadScan = 0;

    // -- culling cache -----------------------------------------------------
    /** @type {SectionMesh[]} Every uploaded mesh, for culling. @private */
    this._meshList = [];
    /** @type {SectionMesh[]} Reused visible-mesh list. @private */
    this._visible = [];
    /** @type {Object|null} @private */ this._cullFrustum = null;
    /** @type {number} @private */ this._cullEpoch = -1;
    /** @type {boolean} @private */ this._cullNearFirst = true;
    /** @type {number} Bumped whenever the render list content changes. @private */
    this._epoch = 0;

    // -- statistics --------------------------------------------------------
    /** @type {number} @private */ this._vertexTotal = 0;
    /** @type {number} @private */ this._triangleTotal = 0;
    /** @type {number} @private */ this._meshBytes = 0;
    /** @type {number} @private */ this._chunkBytes = 0;
    /** @type {number} @private */ this._chunkBytesAt = 0;
    /** @type {number} @private */ this._meshedSections = 0;

    // -- persistence -------------------------------------------------------
    /** @type {Object|null} Injected `game/save.js` manager. @private */
    this._saveManager = null;
    /** @type {boolean} Whether chunks are read from / written to storage. @private */
    this._persist = false;

    // -- scratch -----------------------------------------------------------
    /** @type {TimeBudget} @private */ this._budget = new TimeBudget(1);
    /** @type {number[][]} Collision box pool. @private */ this._boxPool = [];
    /** @type {Array<Object>} Reused VAO attribute spec. @private */ this._attribs = null;
    /** @type {Object|null} Reused VAO descriptor. @private */ this._vaoSpec = null;
    /** @type {(a:SectionMesh, b:SectionMesh) => number} @private */
    this._nearSort = (a, b) => a.distSq - b.distSq;

    /** @type {(key:string) => void} @private */
    this._onSettingChanged = (key) => {
      if (key === 'smoothLighting' || key === 'fancyLeaves') this.remeshAll();
    };
    if (settings && typeof settings.on === 'function') settings.on('change', this._onSettingChanged);
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Build the generator, resolve the biome block table and start the worker
   * pool. Resolves once every worker acknowledged its `init` message (or was
   * written off, in which case the world falls back to main-thread work).
   * @returns {Promise<World>} `this`.
   */
  async init() {
    if (this.initialized) return this;
    resolveBiomeBlocks(BLOCK_BY_NAME);
    try {
      this.generator = new WorldGenerator(this.seed, this.generatorOptions);
    } catch (err) {
      this.generator = null;
      this._reportError('generator', err);
    }
    this._renderDistance = this._readRenderDistance();
    this._buildSpiral(this._renderDistance + 1);
    await this._startWorkers();
    this.initialized = true;
    return this;
  }

  /**
   * Spawn the worker pool and wait for every worker's `ready` acknowledgement.
   * @returns {Promise<void>} Resolves when the pool is usable (or empty).
   * @private
   */
  async _startWorkers() {
    if (typeof Worker === 'undefined' || WORKER_URL === null) {
      this._localMode = true;
      return;
    }
    const count = poolSize();
    /** @type {Promise<void>[]} */
    const waits = [];
    for (let i = 0; i < count; i++) {
      let raw = null;
      try {
        raw = new Worker(WORKER_URL, { type: 'module' });
      } catch (err) {
        this._reportError('worker-spawn', err);
        break;
      }
      const handle = new WorkerHandle(this, this._workers.length, raw);
      this._workers.push(handle);
      waits.push(new Promise((resolve) => {
        handle.resolveReady = resolve;
        handle.readyTimer = setTimeout(() => {
          handle.readyTimer = null;
          handle.resolveReady = null;
          resolve();
        }, WORKER_READY_TIMEOUT_MS);
      }));
      handle.post({
        type: 'init',
        id: this._nextJobId++,
        seed: this.seed,
        options: { ...this.generatorOptions, dimension: this.dimension },
      });
    }
    this._localMode = this._workers.length === 0;
    this._genCap = Math.max(1, Math.ceil(this._workers.length * MAX_INFLIGHT_PER_WORKER * GEN_CAPACITY_SHARE));
    if (waits.length !== 0) await Promise.all(waits);
  }

  /**
   * Inject the `game/save.js` manager lazily so `world.js` never imports it
   * (which would create a cycle through `game/game.js`).
   * @param {Object|null} saveManager A `SaveManager` instance, or `null`.
   * @param {string} [worldId] Persistence id; defaults to the current one.
   * @returns {World} `this`.
   */
  setSaveManager(saveManager, worldId) {
    this._saveManager = saveManager || null;
    if (typeof worldId === 'string' && worldId.length !== 0) this.worldId = worldId;
    this._persist = !!(saveManager && typeof saveManager.saveChunk === 'function');
    return this;
  }

  /**
   * Tear everything down: workers, GPU meshes, chunk data and listeners.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = 0; i < this._workers.length; i++) {
      const w = this._workers[i];
      this._settleReady(w);
      w.terminate();
    }
    this._workers.length = 0;
    this._jobs.clear();
    this._genQueue.length = 0;
    this._meshQueue.length = 0;
    for (const chunk of this.chunks.values()) chunk.dispose();
    this.chunks.clear();
    this._meshList.length = 0;
    this._visible.length = 0;
    this.pendingEdits.clear();
    this.lighting.clear();
    this._vertexTotal = 0;
    this._triangleTotal = 0;
    this._meshBytes = 0;
    this._chunkBytes = 0;
    this._chunkBytesAt = 0;
    this._meshedSections = 0;
    if (this.generator !== null && typeof this.generator.dispose === 'function') {
      this.generator.dispose();
    }
    if (this.settings && typeof this.settings.off === 'function') {
      this.settings.off('change', this._onSettingChanged);
    }
    this.removeAllListeners();
  }

  // =========================================================================
  // Per-frame update
  // =========================================================================

  /**
   * Advance streaming, worker dispatch, lighting and mesh uploads. Every phase
   * is time budgeted, so a call never stalls the frame no matter how much work
   * is outstanding.
   * @param {number} dt Frame time in seconds (unused directly, kept for parity).
   * @param {ArrayLike<number>|{x:number,y:number,z:number}} cameraPos Camera world position.
   * @param {import('../core/math.js').Frustum} [frustum] Camera frustum.
   * @returns {void}
   */
  update(dt, cameraPos, frustum) {
    if (this.disposed) return;
    if (cameraPos) {
      this._camX = vx(cameraPos);
      this._camY = vy(cameraPos);
      this._camZ = vz(cameraPos);
      this._hasCamera = true;
    }
    const ccx = Math.floor(this._camX / CHUNK_SIZE);
    const ccz = Math.floor(this._camZ / CHUNK_SIZE);
    const moved = ccx !== this._camChunkX || ccz !== this._camChunkZ;
    this._camChunkX = ccx;
    this._camChunkZ = ccz;
    // Invalidate the cull cache every frame: the camera (and therefore the sort
    // order) may have moved even when the frustum object stays the same.
    this._epoch++;

    const rd = this._readRenderDistance();
    if (rd !== this._renderDistance) {
      this._renderDistance = rd;
      this._buildSpiral(rd + 1);
    }

    const budget = this._budget;
    const local = this._localMode;

    budget.setBudget(local ? LOCAL_GEN_BUDGET_MS : GEN_DISPATCH_BUDGET_MS).start();
    this._pumpGenQueue(budget);
    this._streamChunks(budget);

    budget.setBudget(MESH_UPLOAD_BUDGET_MS).start();
    this._drainMeshResults(budget);

    if (this.lighting.pending !== 0) this.lighting.process(LIGHT_BUDGET_MS);

    budget.setBudget(local ? LOCAL_MESH_BUDGET_MS : MESH_DISPATCH_BUDGET_MS).start();
    this._scheduleMeshJobs(budget);

    const now = nowMs();
    if (moved || now - this._lastUnloadScan >= UNLOAD_SCAN_INTERVAL_MS) {
      this._lastUnloadScan = now;
      this._unloadFar();
    }
  }

  /**
   * Current render distance in chunks.
   * @returns {number} Render distance (>= 2).
   * @private
   */
  _readRenderDistance() {
    let rd = 10;
    if (this.settings && typeof this.settings.get === 'function') {
      const v = this.settings.get('renderDistance');
      if (Number.isFinite(v)) rd = v | 0;
    }
    return Math.max(2, Math.min(64, rd));
  }

  /**
   * Rebuild the spiral offset table for a radius.
   * @param {number} radius Radius in chunks.
   * @returns {void}
   * @private
   */
  _buildSpiral(radius) {
    if (radius === this._spiralRadius) return;
    const r = Math.max(1, radius | 0);
    const limit = r * r + r;
    /** @type {number[]} */
    const entries = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > limit) continue;
        entries.push(d2, dx, dz);
      }
    }
    const count = entries.length / 3;
    const order = new Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    order.sort((a, b) => entries[a * 3] - entries[b * 3]);
    const out = new Int32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const src = order[i] * 3;
      out[i * 2] = entries[src + 1];
      out[i * 2 + 1] = entries[src + 2];
    }
    this._spiral = out;
    this._spiralRadius = r;
  }

  // =========================================================================
  // Streaming
  // =========================================================================

  /**
   * Walk the spiral and request every chunk that is not loaded yet, nearest
   * first, until the queue is full or the budget runs out.
   *
   * The spiral covers `renderDistance + 1` chunks: a section can only be meshed
   * once all eight neighbours carry terrain, so without that one chunk margin
   * the outermost visible ring could never build a mesh.
   * @param {TimeBudget} budget Dispatch budget.
   * @returns {void}
   * @private
   */
  _streamChunks(budget) {
    const spiral = this._spiral;
    const cx0 = this._camChunkX;
    const cz0 = this._camChunkZ;
    const maxQueued = this._genCap + GEN_QUEUE_SLACK;
    for (let i = 0; i < spiral.length; i += 2) {
      if (this._genQueue.length >= maxQueued) return;
      if ((i & 63) === 0 && budget.expired()) return;
      const cx = cx0 + spiral[i];
      const cz = cz0 + spiral[i + 1];
      const key = chunkKey(cx, cz);
      if (this.chunks.has(key)) continue;
      if (!this._requestChunk(cx, cz, key)) return;
      this._pumpGenQueue(budget);
    }
  }

  /**
   * Create a chunk placeholder and start filling it, either from storage or
   * through the generation queue.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @param {string} key Precomputed chunk key.
   * @returns {boolean} `false` when storage reads are saturated and the caller
   *   should stop requesting chunks this frame.
   * @private
   */
  _requestChunk(cx, cz, key) {
    const fromDisk = this._persist && typeof this._saveManager.loadChunk === 'function';
    if (fromDisk && this._diskLoads >= MAX_DISK_LOADS) return false;
    const chunk = new Chunk(cx, cz);
    chunk.state = 'generating';
    chunk.__litAt = 0;
    chunk.__meshJobs = 0;
    chunk.__genJob = 0;
    chunk.__fromDisk = false;
    chunk.__meshPending = new Uint8Array(SECTION_COUNT);
    chunk.oceanFloor = null;
    this.chunks.set(key, chunk);
    this._generating++;

    if (fromDisk) {
      this._diskLoads++;
      Promise.resolve(this._saveManager.loadChunk(this.worldId, cx, cz)).then(
        (data) => this._onDiskChunk(chunk, data),
        (err) => {
          this._reportError('loadChunk', err);
          this._onDiskChunk(chunk, null);
        },
      );
      return true;
    }
    this._genQueue.push(chunk);
    return true;
  }

  /**
   * Handle the result of a `saveManager.loadChunk()` read.
   * @param {Chunk} chunk The placeholder chunk.
   * @param {Object|null} data Stored snapshot, or `null` when nothing was saved.
   * @returns {void}
   * @private
   */
  _onDiskChunk(chunk, data) {
    this._diskLoads--;
    if (!this._isLive(chunk)) return;
    chunk.__genJob = 0;
    if (!data) {
      this._genQueue.push(chunk);
      return;
    }
    let restored = null;
    try {
      restored = Chunk.deserialize(data);
    } catch (err) {
      this._reportError('deserialize', err);
      restored = null;
    }
    if (restored === null) {
      this._genQueue.push(chunk);
      return;
    }
    restored.__litAt = 0;
    restored.__meshJobs = 0;
    restored.__genJob = 0;
    restored.__fromDisk = true;
    restored.__meshPending = new Uint8Array(SECTION_COUNT);
    restored.oceanFloor = null;
    this.chunks.set(chunk.key, restored);
    chunk.dispose();
    this._generating--;
    // Structure spillover was already baked into the stored snapshot.
    this.pendingEdits.delete(restored.key);
    this._finishChunk(restored);
  }

  /**
   * Hand queued chunks to free workers (or to the local generator).
   * @param {TimeBudget} budget Dispatch budget.
   * @returns {void}
   * @private
   */
  _pumpGenQueue(budget) {
    const queue = this._genQueue;
    while (queue.length !== 0) {
      const chunk = queue[0];
      if (!this._isLive(chunk)) {
        queue.shift();
        continue;
      }
      if (this._localMode) {
        if (budget.expired()) return;
        queue.shift();
        this._generateLocal(chunk);
        if (budget.expired()) return;
        continue;
      }
      if (this._genInflight >= this._genCap) return;
      const worker = this._pickWorker();
      if (worker === null) return;
      queue.shift();
      const id = this._nextJobId++;
      const job = { id, kind: 'gen', chunk, key: chunk.key, cx: chunk.cx, cz: chunk.cz, sy: -1, version: 0, worker };
      this._jobs.set(id, job);
      worker.inflight++;
      this._genInflight++;
      chunk.__genJob = id;
      worker.post({ type: 'gen', id, cx: chunk.cx, cz: chunk.cz });
    }
  }

  /**
   * Generate a chunk on the main thread (no worker available). Time boxed by
   * the caller: at most one chunk per `update()`.
   * @param {Chunk} chunk Chunk to fill.
   * @returns {void}
   * @private
   */
  _generateLocal(chunk) {
    if (this.generator === null) {
      this._generating--;
      chunk.state = 'generated';
      chunk.generated = true;
      this._finishChunk(chunk);
      return;
    }
    let data = null;
    try {
      data = this.generator.generateChunk(chunk.cx, chunk.cz);
    } catch (err) {
      this._reportError('generateChunk', err);
      data = null;
    }
    this._generating--;
    if (!this._isLive(chunk)) return;
    if (data !== null) {
      try {
        chunk.applyGenerated(data);
        this._normalizeHeightmap(chunk);
      } catch (err) {
        this._reportError('applyGenerated', err);
      }
      if (data.oceanFloor) chunk.oceanFloor = data.oceanFloor;
    }
    if (typeof this.generator.takePendingEdits === 'function') {
      let edits = null;
      try {
        edits = this.generator.takePendingEdits();
      } catch (err) {
        this._reportError('takePendingEdits', err);
      }
      if (edits) this._ingestEditMap(edits);
    }
    this._finishChunk(chunk);
  }

  /**
   * Promote a freshly filled chunk to `lit`: apply deferred structure edits,
   * seed sky light and colored emitters, queue the border re-propagation and
   * invalidate the meshes of neighbours that were meshed without this chunk.
   * @param {Chunk} chunk The chunk to finish.
   * @returns {void}
   * @private
   */
  _finishChunk(chunk) {
    if (!chunk.__fromDisk) this._applyPendingEdits(chunk);
    chunk.generated = true;
    chunk.state = 'generated';
    try {
      this.lighting.initChunkSkylight(chunk);
      this.lighting.queueChunkBorders(chunk);
    } catch (err) {
      this._reportError('lighting', err);
    }
    chunk.lit = true;
    chunk.state = 'lit';
    chunk.__litAt = nowMs();
    for (let i = 0; i < NEIGHBOUR_OFFSETS.length; i += 2) {
      const n = this.getChunk(chunk.cx + NEIGHBOUR_OFFSETS[i], chunk.cz + NEIGHBOUR_OFFSETS[i + 1]);
      if (n === null || !n.lit) continue;
      if (n.state === 'meshing' || n.state === 'ready') this._markChunkDirty(n);
    }
    this._epoch++;
    this.emit('chunkLoaded', chunk);
  }

  /**
   * Bring a generator heightmap into the convention `world/chunk.js` and
   * `world/lighting.js` use: the world Y of the **first voxel that is fully
   * open to the sky**, i.e. `topmost light blocking Y + 1`.
   *
   * Generators are free to report the topmost non-air voxel instead, which is
   * one too low and would leave the surface block permanently seeded with sky
   * light 15 (the flood fill only ever brightens, so it could never repair
   * that). Raising a column is always safe: a voxel that is left unseeded gets
   * its light from the free-falling sky column during propagation.
   *
   * The scan only ever moves a column up and stops immediately on a heightmap
   * that already follows the convention, so it is a no-op for a correct
   * generator and costs 256 lookups otherwise.
   * @param {Chunk} chunk Freshly generated chunk.
   * @returns {void}
   * @private
   */
  _normalizeHeightmap(chunk) {
    const hm = chunk.heightmap;
    for (let i = 0; i < hm.length; i++) {
      let h = hm[i];
      if (h < WORLD_MIN_Y) {
        hm[i] = WORLD_MIN_Y;
        continue;
      }
      const lx = i & 15;
      const lz = (i >> 4) & 15;
      while (h < WORLD_MAX_Y && ABSORB_TABLE[chunk.getBlock(lx, h, lz)] > 0) h++;
      hm[i] = h;
    }
  }

  /**
   * Mark every non-empty section of a chunk for a mesh rebuild.
   * @param {Chunk} chunk Target chunk.
   * @returns {void}
   * @private
   */
  _markChunkDirty(chunk) {
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const s = chunk.sections[sy];
      if (s === null || s.nonAirCount === 0) continue;
      chunk.markSectionDirty(sy);
    }
  }

  /**
   * Force a full rebuild of every loaded chunk mesh (quality settings changed).
   * @returns {void}
   */
  remeshAll() {
    for (const chunk of this.chunks.values()) {
      if (chunk.lit) this._markChunkDirty(chunk);
    }
  }

  /**
   * Unload every chunk further than `renderDistance + 2` from the camera,
   * saving modified ones first.
   * @returns {void}
   * @private
   */
  _unloadFar() {
    if (!this._hasCamera) return;
    const r = this._renderDistance + 2;
    const ccx = this._camChunkX;
    const ccz = this._camChunkZ;
    for (const [key, chunk] of this.chunks) {
      const dx = chunk.cx - ccx;
      const dz = chunk.cz - ccz;
      if (dx >= -r && dx <= r && dz >= -r && dz <= r) continue;
      this._unloadChunk(key, chunk);
    }
  }

  /**
   * Save (when modified), detach and free one chunk.
   * @param {string} key Chunk key.
   * @param {Chunk} chunk The chunk.
   * @returns {void}
   * @private
   */
  _unloadChunk(key, chunk) {
    this.chunks.delete(key);
    if (chunk.state === 'generating' || chunk.__genJob !== 0) {
      this._generating--;
      chunk.__genJob = 0;
    }
    if (chunk.modified && this._persist) {
      let snapshot = null;
      try {
        snapshot = chunk.serialize();
      } catch (err) {
        this._reportError('serialize', err);
      }
      if (snapshot !== null) {
        Promise.resolve(this._saveManager.saveChunk(this.worldId, chunk.cx, chunk.cz, snapshot)).catch(
          (err) => this._reportError('saveChunk', err),
        );
      }
    }
    chunk.dispose();
    this._epoch++;
    this.emit('chunkUnloaded', chunk);
  }

  /**
   * Whether a chunk object is still the registered owner of its coordinate.
   * @param {Chunk} chunk Chunk to test.
   * @returns {boolean} `true` when the chunk is still live.
   * @private
   */
  _isLive(chunk) {
    return !this.disposed && !chunk.disposed && this.chunks.get(chunk.key) === chunk;
  }

  // =========================================================================
  // Deferred structure edits
  // =========================================================================

  /**
   * Merge a `Map<'cx,cz', Array<[x,y,z,id]>>` of deferred edits.
   * @param {Map<string, Array<number[]>>} map Generator output.
   * @returns {void}
   * @private
   */
  _ingestEditMap(map) {
    if (!map || typeof map.forEach !== 'function') return;
    for (const [key, list] of map) {
      if (!list || list.length === 0) continue;
      const flat = this._editBucket(key);
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || e.length < 4) continue;
        flat.push(e[0] | 0, e[1] | 0, e[2] | 0, e[3] | 0);
      }
    }
    this._flushEditsToLoadedChunks();
  }

  /**
   * Merge the flattened `[key, Int32Array]` pairs a worker posts back.
   * @param {Array<[string, Int32Array|ArrayBuffer]>} pairs Worker payload.
   * @returns {void}
   * @private
   */
  _ingestEditPairs(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) return;
    for (let p = 0; p < pairs.length; p++) {
      const entry = pairs[p];
      if (!entry) continue;
      const key = entry[0];
      const raw = entry[1];
      if (typeof key !== 'string' || !raw) continue;
      const data = raw instanceof Int32Array ? raw : new Int32Array(raw);
      if (data.length === 0) continue;
      const flat = this._editBucket(key);
      for (let i = 0; i + 3 < data.length; i += 4) {
        flat.push(data[i], data[i + 1], data[i + 2], data[i + 3]);
      }
    }
    this._flushEditsToLoadedChunks();
  }

  /**
   * Fetch (or create) the edit bucket of a chunk key, evicting the oldest one
   * when the table grows past its cap.
   * @param {string} key Chunk key.
   * @returns {number[]} Flat `[x,y,z,id,...]` list.
   * @private
   */
  _editBucket(key) {
    let flat = this.pendingEdits.get(key);
    if (flat === undefined) {
      if (this.pendingEdits.size >= MAX_PENDING_EDIT_CHUNKS) {
        const oldest = this.pendingEdits.keys().next();
        if (!oldest.done) this.pendingEdits.delete(oldest.value);
      }
      flat = [];
      this.pendingEdits.set(key, flat);
    }
    return flat;
  }

  /**
   * Apply every pending edit whose target chunk is already generated.
   * @returns {void}
   * @private
   */
  _flushEditsToLoadedChunks() {
    if (this.pendingEdits.size === 0) return;
    for (const key of this.pendingEdits.keys()) {
      const chunk = this.chunks.get(key);
      if (chunk === undefined || !chunk.generated) continue;
      this._applyPendingEdits(chunk);
    }
  }

  /**
   * Write the deferred structure edits stored for a chunk into it.
   * @param {Chunk} chunk Target chunk.
   * @returns {number} Number of blocks actually changed.
   * @private
   */
  _applyPendingEdits(chunk) {
    const flat = this.pendingEdits.get(chunk.key);
    if (flat === undefined) return 0;
    this.pendingEdits.delete(chunk.key);
    const relight = chunk.lit;
    let changed = 0;
    for (let i = 0; i + 3 < flat.length; i += 4) {
      const x = flat[i];
      const y = flat[i + 1];
      const z = flat[i + 2];
      const id = flat[i + 3];
      if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) continue;
      const prev = chunk.setBlock(x & 15, y, z & 15, id);
      if (prev === id) continue;
      changed++;
      if (relight) {
        this.lighting.onBlockChanged(x, y, z, prev, id);
        this.markDirty(x, y, z);
      }
    }
    return changed;
  }

  // =========================================================================
  // Worker pool
  // =========================================================================

  /**
   * Pick the next worker with free capacity (round robin).
   * @returns {WorkerHandle|null} A worker, or `null` when the pool is saturated.
   * @private
   */
  _pickWorker() {
    const list = this._workers;
    const n = list.length;
    if (n === 0) return null;
    for (let i = 0; i < n; i++) {
      const idx = (this._rr + i) % n;
      const w = list[idx];
      if (w.alive && w.inflight < MAX_INFLIGHT_PER_WORKER) {
        this._rr = (idx + 1) % n;
        return w;
      }
    }
    return null;
  }

  /**
   * Resolve a worker's pending `ready` promise exactly once.
   * @param {WorkerHandle} handle The worker.
   * @returns {void}
   * @private
   */
  _settleReady(handle) {
    if (handle.readyTimer !== null) {
      clearTimeout(handle.readyTimer);
      handle.readyTimer = null;
    }
    const resolve = handle.resolveReady;
    if (resolve !== null) {
      handle.resolveReady = null;
      resolve();
    }
  }

  /**
   * Route one message coming back from a worker.
   * @param {WorkerHandle} handle The sending worker.
   * @param {Object} msg Message payload.
   * @returns {void}
   * @private
   */
  _onWorkerMessage(handle, msg) {
    if (!msg || this.disposed) return;
    if (msg.type === 'ready') {
      handle.ready = true;
      this._settleReady(handle);
      return;
    }
    const job = this._jobs.get(msg.id);
    if (job === undefined) {
      // A cancelled job, or a failure the worker could not attribute.
      if (msg.type === 'error') this._reportError('worker', new Error(msg.message || 'worker error'));
      return;
    }
    this._jobs.delete(msg.id);
    handle.inflight--;
    if (job.kind === 'gen') this._genInflight--;
    else this._meshInflight--;

    if (msg.type === 'error') {
      this._reportError(`worker-${job.kind}`, new Error(msg.message || 'worker job failed'));
      this._failJob(job);
      return;
    }
    if (job.kind === 'gen') this._onGenResult(job, msg);
    else this._meshQueue.push({ job, msg });
  }

  /**
   * A worker died: write it off, requeue its jobs and fall back to main-thread
   * work when the pool is empty.
   * @param {WorkerHandle} handle The failed worker.
   * @param {string} reason Human readable reason.
   * @returns {void}
   * @private
   */
  _onWorkerFailure(handle, reason) {
    if (!handle.alive) return;
    handle.alive = false;
    this._settleReady(handle);
    try {
      handle.worker.terminate();
    } catch (e) {
      /* already gone */
    }
    for (const [id, job] of this._jobs) {
      if (job.worker !== handle) continue;
      this._jobs.delete(id);
      handle.inflight--;
      if (job.kind === 'gen') this._genInflight--;
      else this._meshInflight--;
      this._failJob(job);
    }
    const index = this._workers.indexOf(handle);
    if (index >= 0) this._workers.splice(index, 1);
    this._localMode = this._workers.length === 0;
    this._genCap = this._workers.length === 0
      ? 1
      : Math.max(1, Math.ceil(this._workers.length * MAX_INFLIGHT_PER_WORKER * GEN_CAPACITY_SHARE));
    this._reportError('worker', new Error(reason));
  }

  /**
   * Put the work of a lost job back into the pipeline.
   * @param {Object} job The job record.
   * @returns {void}
   * @private
   */
  _failJob(job) {
    const chunk = job.chunk;
    if (!this._isLive(chunk)) return;
    if (job.kind === 'gen') {
      if (chunk.__genJob === job.id) chunk.__genJob = 0;
      this._genQueue.push(chunk);
      return;
    }
    chunk.__meshPending[job.sy] = 0;
    if (chunk.__meshJobs > 0) chunk.__meshJobs--;
    chunk.markSectionDirty(job.sy);
  }

  /**
   * Adopt a finished generation job.
   * @param {Object} job The job record.
   * @param {Object} msg Worker payload.
   * @returns {void}
   * @private
   */
  _onGenResult(job, msg) {
    const chunk = job.chunk;
    const live = this._isLive(chunk);
    if (chunk.__genJob === job.id) {
      chunk.__genJob = 0;
      this._generating--;
    }
    if (msg.edits) this._ingestEditPairs(msg.edits);
    if (!live) return;
    try {
      chunk.applyGenerated({ sections: msg.sections, heightmap: msg.heightmap, biomes: msg.biomes });
      this._normalizeHeightmap(chunk);
    } catch (err) {
      this._reportError('applyGenerated', err);
    }
    if (msg.oceanFloor) chunk.oceanFloor = new Int16Array(msg.oceanFloor);
    this._finishChunk(chunk);
  }

  // =========================================================================
  // Meshing
  // =========================================================================

  /**
   * Whether all eight horizontal neighbours of a chunk carry terrain, which is
   * the precondition for correct border light and AO.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @returns {boolean} `true` when the 3x3 neighbourhood is generated.
   * @private
   */
  _neighboursGenerated(cx, cz) {
    for (let i = 0; i < NEIGHBOUR_OFFSETS.length; i += 2) {
      const n = this.chunks.get(chunkKey(cx + NEIGHBOUR_OFFSETS[i], cz + NEIGHBOUR_OFFSETS[i + 1]));
      if (n === undefined || !n.generated) return false;
    }
    return true;
  }

  /**
   * Dispatch mesh jobs for dirty sections, nearest chunk first.
   * @param {TimeBudget} budget Dispatch budget.
   * @returns {void}
   * @private
   */
  _scheduleMeshJobs(budget) {
    const spiral = this._spiral;
    const cx0 = this._camChunkX;
    const cz0 = this._camChunkZ;
    const lightSettled = this.lighting.pending === 0;
    const now = nowMs();
    for (let i = 0; i < spiral.length; i += 2) {
      if (budget.expired()) return;
      const cx = cx0 + spiral[i];
      const cz = cz0 + spiral[i + 1];
      const chunk = this.chunks.get(chunkKey(cx, cz));
      if (chunk === undefined || !chunk.lit) continue;
      if (chunk.dirtySections.size === 0) {
        this._updateChunkState(chunk);
        continue;
      }
      if (!lightSettled && now - chunk.__litAt < MESH_LIGHT_GRACE_MS) continue;
      if (!this._neighboursGenerated(cx, cz)) continue;
      for (const sy of chunk.dirtySections) {
        const section = chunk.sections[sy];
        if (section === null || section.nonAirCount === 0) {
          chunk.clearSectionDirty(sy);
          const stale = chunk.meshes[sy];
          if (stale) {
            chunk.meshes[sy] = null;
            stale.dispose();
          }
          continue;
        }
        if (chunk.__meshPending[sy] === 1) continue;
        if (!this._dispatchMesh(chunk, sy)) return;
        if (budget.expired()) return;
      }
      this._updateChunkState(chunk);
    }
  }

  /**
   * Build the padded neighbourhood of one section and send it off to be meshed.
   * @param {Chunk} chunk Owning chunk.
   * @param {number} sy Section index.
   * @returns {boolean} `false` when no capacity was available.
   * @private
   */
  _dispatchMesh(chunk, sy) {
    const smooth = this._readBool('smoothLighting', true);
    const fancy = this._readBool('fancyLeaves', true);
    const section = chunk.sections[sy];
    const version = section === null ? 0 : section.meshVersion;

    if (this._localMode) {
      const padded = this._buildPaddedSection(chunk.cx, sy, chunk.cz);
      chunk.clearSectionDirty(sy);
      chunk.__meshPending[sy] = 1;
      chunk.__meshJobs++;
      chunk.state = 'meshing';
      let result = null;
      try {
        result = meshSection({
          blocks: padded.blocks,
          light: padded.light,
          biomes: padded.biomes,
          sy,
          smoothLighting: smooth,
          fancyLeaves: fancy,
        });
      } catch (err) {
        this._reportError('meshSection', err);
        chunk.__meshPending[sy] = 0;
        chunk.__meshJobs--;
        return true;
      }
      this._meshQueue.push({
        job: { id: 0, kind: 'mesh', chunk, key: chunk.key, cx: chunk.cx, cz: chunk.cz, sy, version, worker: null },
        msg: result,
      });
      return true;
    }

    const worker = this._pickWorker();
    if (worker === null) return false;
    const padded = this._buildPaddedSection(chunk.cx, sy, chunk.cz);
    const id = this._nextJobId++;
    const job = { id, kind: 'mesh', chunk, key: chunk.key, cx: chunk.cx, cz: chunk.cz, sy, version, worker };
    this._jobs.set(id, job);
    worker.inflight++;
    this._meshInflight++;
    chunk.clearSectionDirty(sy);
    chunk.__meshPending[sy] = 1;
    chunk.__meshJobs++;
    chunk.state = 'meshing';
    worker.post({
      type: 'mesh',
      id,
      cx: chunk.cx,
      cz: chunk.cz,
      sy,
      blocks: padded.blocks,
      light: padded.light,
      biomes: padded.biomes,
      smoothLighting: smooth,
      fancyLeaves: fancy,
    }, [padded.blocks.buffer, padded.light.buffer, padded.biomes.buffer]);
    return true;
  }

  /**
   * Read a boolean setting with a fallback.
   * @param {string} key Setting key.
   * @param {boolean} fallback Value used when settings are unavailable.
   * @returns {boolean} The setting value.
   * @private
   */
  _readBool(key, fallback) {
    if (!this.settings || typeof this.settings.get !== 'function') return fallback;
    const v = this.settings.get(key);
    return typeof v === 'boolean' ? v : fallback;
  }

  /**
   * Fill the 18x18x18 block/light volumes and the 18x18 biome plane of one
   * section from the chunk and its eight neighbours.
   * @param {number} cx Chunk X.
   * @param {number} sy Section index 0..23.
   * @param {number} cz Chunk Z.
   * @returns {{blocks:Uint16Array, light:Uint16Array, biomes:Uint8Array}} Padded input.
   */
  buildPaddedSection(cx, sy, cz) {
    return this._buildPaddedSection(cx, sy, cz);
  }

  /**
   * Implementation of {@link World#buildPaddedSection}.
   * @param {number} cx Chunk X.
   * @param {number} sy Section index 0..23.
   * @param {number} cz Chunk Z.
   * @returns {{blocks:Uint16Array, light:Uint16Array, biomes:Uint8Array}} Padded input.
   * @private
   */
  _buildPaddedSection(cx, sy, cz) {
    const blocks = new Uint16Array(PAD_VOL);
    const light = new Uint16Array(PAD_VOL);
    const biomes = new Uint8Array(PAD_AREA);
    const baseY = WORLD_MIN_Y + sy * SECTION_SIZE;
    for (let dz = -1; dz <= 1; dz++) {
      const pz0 = dz < 0 ? 0 : (dz === 0 ? 1 : PAD - 1);
      const pzCount = dz === 0 ? CHUNK_SIZE : 1;
      const lz0 = dz < 0 ? CHUNK_SIZE - 1 : 0;
      for (let dx = -1; dx <= 1; dx++) {
        const px0 = dx < 0 ? 0 : (dx === 0 ? 1 : PAD - 1);
        const pxCount = dx === 0 ? CHUNK_SIZE : 1;
        const lx0 = dx < 0 ? CHUNK_SIZE - 1 : 0;
        const chunk = this.chunks.get(chunkKey(cx + dx, cz + dz)) || null;
        this._fillPaddedRegion(chunk, blocks, light, biomes, baseY, px0, pxCount, lx0, pz0, pzCount, lz0);
      }
    }
    return { blocks, light, biomes };
  }

  /**
   * Copy one of the nine source chunks into its slice of the padded volume.
   * @param {Chunk|null} chunk Source chunk (`null` -> air + full sky light).
   * @param {Uint16Array} blocks Padded block volume.
   * @param {Uint16Array} light Padded light volume.
   * @param {Uint8Array} biomes Padded biome plane.
   * @param {number} baseY World Y of the section's bottom layer.
   * @param {number} px0 First padded X of the slice.
   * @param {number} pxCount Padded X count.
   * @param {number} lx0 First chunk-local X of the slice.
   * @param {number} pz0 First padded Z of the slice.
   * @param {number} pzCount Padded Z count.
   * @param {number} lz0 First chunk-local Z of the slice.
   * @returns {void}
   * @private
   */
  _fillPaddedRegion(chunk, blocks, light, biomes, baseY, px0, pxCount, lx0, pz0, pzCount, lz0) {
    for (let j = 0; j < pzCount; j++) {
      const pz = pz0 + j;
      const lz = lz0 + j;
      const rowBiome = pz * PAD_Z;
      for (let i = 0; i < pxCount; i++) {
        biomes[rowBiome + px0 + i] = chunk === null ? 0 : chunk.biomes[(lz << 4) | (lx0 + i)];
      }
    }
    const heightmap = chunk === null ? null : chunk.heightmap;
    for (let py = 0; py < PAD; py++) {
      const wy = baseY - 1 + py;
      if (wy < WORLD_MIN_Y) continue;
      const rowY = py * PAD_Y;
      if (chunk === null || wy >= WORLD_MAX_Y) {
        for (let j = 0; j < pzCount; j++) {
          const base = rowY + (pz0 + j) * PAD_Z + px0;
          for (let i = 0; i < pxCount; i++) light[base + i] = SKY_FULL_PACKED;
        }
        continue;
      }
      const yy = wy - WORLD_MIN_Y;
      const section = chunk.sections[yy >> 4];
      const ly = yy & 15;
      if (section === null) {
        for (let j = 0; j < pzCount; j++) {
          const lz = lz0 + j;
          const base = rowY + (pz0 + j) * PAD_Z + px0;
          for (let i = 0; i < pxCount; i++) {
            light[base + i] = wy >= heightmap[(lz << 4) | (lx0 + i)] ? SKY_FULL_PACKED : 0;
          }
        }
        continue;
      }
      const sb = section.blocks;
      const sl = section.light;
      const uniform = section.uniformSky;
      for (let j = 0; j < pzCount; j++) {
        const lz = lz0 + j;
        const base = rowY + (pz0 + j) * PAD_Z + px0;
        const sBase = (ly << 8) | (lz << 4);
        for (let i = 0; i < pxCount; i++) {
          const lx = lx0 + i;
          const si = sBase | lx;
          if (sb !== null) blocks[base + i] = sb[si];
          if (sl !== null) light[base + i] = sl[si];
          else if (uniform || wy >= heightmap[(lz << 4) | lx]) light[base + i] = SKY_FULL_PACKED;
        }
      }
    }
  }

  /**
   * Upload finished meshes until the budget is spent.
   * @param {TimeBudget} budget Upload budget (3 ms).
   * @returns {void}
   * @private
   */
  _drainMeshResults(budget) {
    const queue = this._meshQueue;
    let head = 0;
    while (head < queue.length) {
      const entry = queue[head];
      head++;
      this._uploadMesh(entry.job, entry.msg);
      if (budget.expired()) break;
    }
    if (head === queue.length) queue.length = 0;
    else if (head > 0) queue.splice(0, head);
  }

  /**
   * Turn one mesher result into GPU buffers and swap it into the chunk. The old
   * mesh stays alive until the new one is fully built, so a rebuild never
   * flashes an empty section.
   * @param {Object} job The mesh job record.
   * @param {{opaque:Object, cutout:Object, water:Object}} result Mesher output.
   * @returns {void}
   * @private
   */
  _uploadMesh(job, result) {
    const chunk = job.chunk;
    const live = this._isLive(chunk);
    if (live) {
      chunk.__meshPending[job.sy] = 0;
      if (chunk.__meshJobs > 0) chunk.__meshJobs--;
    }
    if (!live || !result) return;

    const mesh = new SectionMesh(this, job.cx, job.cz, job.sy, job.version);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const buckets = ['opaque', 'cutout', 'water'];
    for (let b = 0; b < buckets.length; b++) {
      const name = buckets[b];
      const src = result[name];
      if (!src || !src.count || src.count === 0) continue;
      const bounds = this._bucketBounds(src.vertices);
      if (bounds !== null) {
        if (bounds[0] < minX) minX = bounds[0];
        if (bounds[1] < minY) minY = bounds[1];
        if (bounds[2] < minZ) minZ = bounds[2];
        if (bounds[3] > maxX) maxX = bounds[3];
        if (bounds[4] > maxY) maxY = bounds[4];
        if (bounds[5] > maxZ) maxZ = bounds[5];
      }
      const bucket = this._createBucket(src);
      if (bucket === null) continue;
      mesh[name] = bucket;
      mesh.vertexCount += bucket.vertexCount;
      mesh.triangleCount += bucket.indexCount / 3;
      mesh.bytes += bucket.bytes;
    }

    const old = chunk.meshes[job.sy];
    if (mesh.isEmpty) {
      chunk.meshes[job.sy] = null;
      if (old) old.dispose();
      this._updateChunkState(chunk);
      return;
    }
    if (minX <= maxX) {
      mesh.aabb[0] = mesh.originX + minX - AABB_MARGIN;
      mesh.aabb[1] = mesh.originY + minY - AABB_MARGIN;
      mesh.aabb[2] = mesh.originZ + minZ - AABB_MARGIN;
      mesh.aabb[3] = mesh.originX + maxX + AABB_MARGIN;
      mesh.aabb[4] = mesh.originY + maxY + AABB_MARGIN;
      mesh.aabb[5] = mesh.originZ + maxZ + AABB_MARGIN;
    }
    chunk.meshes[job.sy] = mesh;
    mesh._listIndex = this._meshList.length;
    this._meshList.push(mesh);
    this._vertexTotal += mesh.vertexCount;
    this._triangleTotal += mesh.triangleCount;
    this._meshBytes += mesh.bytes;
    this._meshedSections++;
    this._epoch++;
    if (old) old.dispose();
    this._updateChunkState(chunk);
  }

  /**
   * Scan the positions of one vertex buffer for its local bounding box.
   * @param {ArrayBuffer} vertices Interleaved vertex data (stride 32).
   * @returns {number[]|null} `[minX,minY,minZ,maxX,maxY,maxZ]` in section space.
   * @private
   */
  _bucketBounds(vertices) {
    if (!vertices || vertices.byteLength < 32) return null;
    const view = new Float32Array(vertices);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i + 2 < view.length; i += 8) {
      const x = view[i];
      const y = view[i + 1];
      const z = view[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    if (minX > maxX) return null;
    return [minX, minY, minZ, maxX, maxY, maxZ];
  }

  /**
   * Create the VAO + buffers of one render bucket.
   * @param {{vertices:ArrayBuffer, indices:ArrayBuffer, count:number}} src Mesher bucket.
   * @returns {{vao:WebGLVertexArrayObject, indexCount:number, vbo:WebGLBuffer,
   *   ibo:WebGLBuffer, vertexCount:number, bytes:number}|null} GPU bucket.
   * @private
   */
  _createBucket(src) {
    const device = this.gl;
    if (!device || !device.gl) return null;
    const raw = device.gl;
    if (this._attribs === null) this._buildVaoSpec();
    let vbo = null;
    let ibo = null;
    try {
      vbo = device.createBuffer(raw.ARRAY_BUFFER, src.vertices, raw.STATIC_DRAW);
      ibo = device.createBuffer(raw.ELEMENT_ARRAY_BUFFER, src.indices, raw.STATIC_DRAW);
      const attribs = this._attribs;
      for (let i = 0; i < attribs.length; i++) attribs[i].buffer = vbo;
      this._vaoSpec.indexBuffer = ibo;
      const vao = device.createVertexArray(this._vaoSpec);
      for (let i = 0; i < attribs.length; i++) attribs[i].buffer = null;
      this._vaoSpec.indexBuffer = null;
      return {
        vao,
        indexCount: src.count,
        vbo,
        ibo,
        vertexCount: src.vertices.byteLength / 32,
        bytes: src.vertices.byteLength + src.indices.byteLength,
      };
    } catch (err) {
      this._reportError('meshUpload', err);
      if (vbo) raw.deleteBuffer(vbo);
      if (ibo) raw.deleteBuffer(ibo);
      return null;
    }
  }

  /**
   * Build the reusable terrain vertex layout (spec 3.1).
   * @returns {void}
   * @private
   */
  _buildVaoSpec() {
    const g = this.gl.gl;
    this._attribs = [
      { location: 0, buffer: null, size: 3, type: g.FLOAT, normalized: false, integer: false, stride: 32, offset: 0 },
      { location: 1, buffer: null, size: 2, type: g.FLOAT, normalized: false, integer: false, stride: 32, offset: 12 },
      { location: 2, buffer: null, size: 1, type: g.UNSIGNED_SHORT, normalized: false, integer: true, stride: 32, offset: 20 },
      { location: 3, buffer: null, size: 2, type: g.UNSIGNED_BYTE, normalized: false, integer: true, stride: 32, offset: 22 },
      { location: 4, buffer: null, size: 4, type: g.UNSIGNED_BYTE, normalized: true, integer: false, stride: 32, offset: 24 },
      { location: 5, buffer: null, size: 4, type: g.UNSIGNED_BYTE, normalized: true, integer: false, stride: 32, offset: 28 },
    ];
    this._vaoSpec = { attributes: this._attribs, indexBuffer: null, indexType: g.UNSIGNED_INT };
  }

  /**
   * Free the GL objects of a mesh and drop it from the render list. Called by
   * {@link SectionMesh#dispose}.
   * @param {SectionMesh} mesh The mesh being disposed.
   * @returns {void}
   * @private
   */
  _retireMesh(mesh) {
    const index = mesh._listIndex;
    if (index >= 0 && index < this._meshList.length && this._meshList[index] === mesh) {
      const last = this._meshList.pop();
      if (last !== mesh) {
        this._meshList[index] = last;
        last._listIndex = index;
      }
      mesh._listIndex = -1;
      this._vertexTotal -= mesh.vertexCount;
      this._triangleTotal -= mesh.triangleCount;
      this._meshBytes -= mesh.bytes;
      this._meshedSections--;
      this._epoch++;
    }
    const device = this.gl;
    if (!device || !device.gl) return;
    const raw = device.gl;
    const buckets = [mesh.opaque, mesh.cutout, mesh.water];
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (!b) continue;
      if (b.vao) {
        device.bindVertexArray(null);
        raw.deleteVertexArray(b.vao);
      }
      if (b.vbo) raw.deleteBuffer(b.vbo);
      if (b.ibo) raw.deleteBuffer(b.ibo);
      b.vao = null;
      b.vbo = null;
      b.ibo = null;
      b.indexCount = 0;
    }
  }

  /**
   * Promote a chunk to `ready` once nothing is dirty or in flight any more.
   * @param {Chunk} chunk The chunk to check.
   * @returns {void}
   * @private
   */
  _updateChunkState(chunk) {
    if (!chunk.lit) return;
    if (chunk.dirtySections.size !== 0 || chunk.__meshJobs !== 0) return;
    if (chunk.state === 'ready') return;
    chunk.state = 'ready';
    this.emit('chunkReady', chunk);
  }

  // =========================================================================
  // Block access
  // =========================================================================

  /**
   * Chunk lookup.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @returns {Chunk|null} The chunk, or `null` when it is not loaded.
   */
  getChunk(cx, cz) {
    return this.chunks.get(chunkKey(cx, cz)) || null;
  }

  /**
   * Whether a chunk is loaded and carries terrain.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @returns {boolean} `true` when the chunk is usable.
   */
  isLoaded(cx, cz) {
    const c = this.chunks.get(chunkKey(cx, cz));
    return c !== undefined && c.generated;
  }

  /**
   * Read a block id in world coordinates.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} Block id; 0 outside the loaded area or the world.
   */
  getBlock(x, y, z) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return 0;
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (chunk === undefined) return 0;
    return chunk.getBlock(x & 15, y, z & 15);
  }

  /**
   * Write a block id in world coordinates, updating the heightmap, the light
   * engine, every affected section mesh and the save flag.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id New block id.
   * @param {{noRelight?:boolean, noSave?:boolean}} [opts] Behaviour switches.
   * @returns {boolean} `true` when the block actually changed.
   */
  setBlock(x, y, z, id, opts = {}) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return false;
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (chunk === undefined) return false;
    const wasModified = chunk.modified;
    const prev = chunk.setBlock(x & 15, y, z & 15, id);
    if (prev === id) return false;
    if (opts.noSave === true) chunk.modified = wasModified;
    if (opts.noRelight !== true) this.lighting.onBlockChanged(x, y, z, prev, id);
    this.markDirty(x, y, z);
    this.emit('blockChanged', x, y, z, prev, id);
    return true;
  }

  /**
   * Mark the section owning a voxel — and every neighbouring section that
   * samples it across a chunk or section border — for a mesh rebuild.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   */
  markDirty(x, y, z) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
    const cx = x >> 4;
    const cz = z >> 4;
    const sy = (y - WORLD_MIN_Y) >> 4;
    const home = this.chunks.get(chunkKey(cx, cz));
    if (home === undefined) return;
    home.markSectionDirty(sy);
    const lx = x & 15;
    const lz = z & 15;
    const ly = (y - WORLD_MIN_Y) & 15;
    const dy = ly === 0 ? -1 : (ly === 15 ? 1 : 0);
    if (dy !== 0) home.markSectionDirty(sy + dy);
    const dx = lx === 0 ? -1 : (lx === 15 ? 1 : 0);
    const dz = lz === 0 ? -1 : (lz === 15 ? 1 : 0);
    if (dx === 0 && dz === 0) return;
    if (dx !== 0) this._markNeighbourSection(cx + dx, cz, sy, dy);
    if (dz !== 0) this._markNeighbourSection(cx, cz + dz, sy, dy);
    if (dx !== 0 && dz !== 0) this._markNeighbourSection(cx + dx, cz + dz, sy, dy);
  }

  /**
   * Mark one section (and optionally its vertical neighbour) of another chunk.
   * @param {number} cx Chunk X.
   * @param {number} cz Chunk Z.
   * @param {number} sy Section index.
   * @param {number} dy `-1`, `0` or `1`.
   * @returns {void}
   * @private
   */
  _markNeighbourSection(cx, cz, sy, dy) {
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c === undefined) return;
    c.markSectionDirty(sy);
    if (dy !== 0) c.markSectionDirty(sy + dy);
  }

  /**
   * Packed light value of a voxel.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} Packed uint16 light (`packLight` layout).
   */
  getLightPacked(x, y, z) {
    if (y >= WORLD_MAX_Y) return SKY_FULL_PACKED;
    if (y < WORLD_MIN_Y) return 0;
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (chunk === undefined) return SKY_FULL_PACKED;
    return chunk.getLightPacked(x & 15, y, z & 15);
  }

  /**
   * Sky light of a voxel.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} Sky light 0..15.
   */
  getSkyLight(x, y, z) {
    return (this.getLightPacked(x, y, z) >> 12) & 15;
  }

  /**
   * Colored block light of a voxel.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number[]} [out] Optional target array to avoid an allocation.
   * @returns {number[]} `[r, g, b]`, each 0..15.
   */
  getBlockLight(x, y, z, out) {
    const v = this.getLightPacked(x, y, z);
    const target = out || [0, 0, 0];
    target[0] = v & 15;
    target[1] = (v >> 4) & 15;
    target[2] = (v >> 8) & 15;
    return target;
  }

  /**
   * Biome id of a column; falls back to the generator outside loaded chunks.
   * @param {number} x World X.
   * @param {number} z World Z.
   * @returns {number} Biome id.
   */
  getBiome(x, z) {
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (chunk !== undefined && chunk.generated) return chunk.getBiome(x & 15, z & 15);
    if (this.generator !== null && typeof this.generator.getBiomeAt === 'function') {
      return this.generator.getBiomeAt(x, z) | 0;
    }
    return 0;
  }

  /**
   * Column height (world Y of the first block open to the sky); falls back to
   * the generator outside loaded chunks.
   * @param {number} x World X.
   * @param {number} z World Z.
   * @returns {number} Column height.
   */
  getHeight(x, z) {
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (chunk !== undefined && chunk.generated) return chunk.getHeight(x & 15, z & 15);
    if (this.generator !== null && typeof this.generator.getHeightAt === 'function') {
      return this.generator.getHeightAt(x, z) | 0;
    }
    return WORLD_MIN_Y;
  }

  // =========================================================================
  // Queries
  // =========================================================================

  /**
   * Amanatides & Woo voxel DDA against the real per-block AABBs, so slabs,
   * torches, plants and fluids report the correct hit face and distance.
   * @param {ArrayLike<number>|{x:number,y:number,z:number}} origin Ray origin.
   * @param {ArrayLike<number>|{x:number,y:number,z:number}} dir Ray direction (normalized or not).
   * @param {number} [maxDist=5] Maximum distance in blocks.
   * @param {{fluids?:boolean, ignore?:Set<number>}} [opts] `fluids` includes
   *   water/lava, `ignore` skips the given block ids.
   * @returns {{x:number, y:number, z:number, face:number, faceNormal:number[],
   *   point:number[], dist:number, blockId:number}|null} The hit, or `null`.
   */
  raycast(origin, dir, maxDist = 5, opts = {}) {
    let dx = vx(dir);
    let dy = vy(dir);
    let dz = vz(dir);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-9)) return null;
    const inv = 1 / len;
    dx *= inv;
    dy *= inv;
    dz *= inv;
    const ox = vx(origin);
    const oy = vy(origin);
    const oz = vz(origin);
    const limit = Number.isFinite(maxDist) ? Math.max(0, maxDist) : 5;
    const wantFluids = opts.fluids === true;
    const ignore = opts.ignore instanceof Set ? opts.ignore : null;

    let ix = Math.floor(ox);
    let iy = Math.floor(oy);
    let iz = Math.floor(oz);
    const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
    const stepZ = dz > 0 ? 1 : (dz < 0 ? -1 : 0);
    const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dz);
    let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? (ix + 1 - ox) / dx : (ix - ox) / dx);
    let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? (iy + 1 - oy) / dy : (iy - oy) / dy);
    let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? (iz + 1 - oz) / dz : (iz - oz) / dz);

    const maxSteps = Math.ceil(limit * 3) + 8;
    let t = 0;
    for (let step = 0; step < maxSteps; step++) {
      if (iy >= WORLD_MIN_Y && iy < WORLD_MAX_Y) {
        const id = this.getBlock(ix, iy, iz);
        if (id !== 0 && (ignore === null || !ignore.has(id)) && (wantFluids || !isLiquid(id))) {
          const hit = this._hitBlock(id, ix, iy, iz, ox, oy, oz, dx, dy, dz, limit);
          if (hit !== null) return hit;
        }
      }
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          t = tMaxX;
          ix += stepX;
          tMaxX += tDeltaX;
        } else {
          t = tMaxZ;
          iz += stepZ;
          tMaxZ += tDeltaZ;
        }
      } else if (tMaxY < tMaxZ) {
        t = tMaxY;
        iy += stepY;
        tMaxY += tDeltaY;
      } else {
        t = tMaxZ;
        iz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (t > limit) return null;
    }
    return null;
  }

  /**
   * Slab test of a ray against every AABB of one block.
   * @param {number} id Block id.
   * @param {number} bx Block X.
   * @param {number} by Block Y.
   * @param {number} bz Block Z.
   * @param {number} ox Ray origin X.
   * @param {number} oy Ray origin Y.
   * @param {number} oz Ray origin Z.
   * @param {number} dx Normalized direction X.
   * @param {number} dy Normalized direction Y.
   * @param {number} dz Normalized direction Z.
   * @param {number} limit Maximum distance.
   * @returns {{x:number, y:number, z:number, face:number, faceNormal:number[],
   *   point:number[], dist:number, blockId:number}|null} The hit, or `null`.
   * @private
   */
  _hitBlock(id, bx, by, bz, ox, oy, oz, dx, dy, dz, limit) {
    const boxes = selectionBoxes(id, 0);
    let bestT = Infinity;
    let bestAxis = -1;
    let bestSign = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      let tMin = 0;
      let tMax = limit;
      let axis = -1;
      let sign = 0;
      let ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        const o = a === 0 ? ox : (a === 1 ? oy : oz);
        const d = a === 0 ? dx : (a === 1 ? dy : dz);
        const base = a === 0 ? bx : (a === 1 ? by : bz);
        const lo = base + box[a];
        const hi = base + box[a + 3];
        if (d > -1e-12 && d < 1e-12) {
          if (o < lo || o > hi) ok = false;
          continue;
        }
        let tEnter;
        let tExit;
        let s;
        if (d > 0) {
          tEnter = (lo - o) / d;
          tExit = (hi - o) / d;
          s = -1;
        } else {
          tEnter = (hi - o) / d;
          tExit = (lo - o) / d;
          s = 1;
        }
        if (tEnter > tMin) {
          tMin = tEnter;
          axis = a;
          sign = s;
        }
        if (tExit < tMax) tMax = tExit;
        if (tMin > tMax) ok = false;
      }
      if (!ok || tMin > limit || tMin >= bestT) continue;
      bestT = tMin;
      bestAxis = axis;
      bestSign = sign;
    }
    if (bestT === Infinity) return null;
    if (bestAxis < 0) {
      // The origin sits inside the box: report the face pointing at the viewer.
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const az = Math.abs(dz);
      if (ax >= ay && ax >= az) {
        bestAxis = 0;
        bestSign = dx > 0 ? -1 : 1;
      } else if (ay >= az) {
        bestAxis = 1;
        bestSign = dy > 0 ? -1 : 1;
      } else {
        bestAxis = 2;
        bestSign = dz > 0 ? -1 : 1;
      }
    }
    const nx = bestAxis === 0 ? bestSign : 0;
    const ny = bestAxis === 1 ? bestSign : 0;
    const nz = bestAxis === 2 ? bestSign : 0;
    const face = bestAxis === 0 ? (bestSign > 0 ? 0 : 1)
      : (bestAxis === 1 ? (bestSign > 0 ? 2 : 3) : (bestSign > 0 ? 4 : 5));
    return {
      x: bx,
      y: by,
      z: bz,
      face,
      faceNormal: [nx, ny, nz],
      point: [ox + dx * bestT, oy + dy * bestT, oz + dz * bestT],
      dist: bestT,
      blockId: id,
    };
  }

  /**
   * Collect every solid block AABB overlapping a box. The returned arrays come
   * from an internal pool and stay valid until the next call.
   * @param {import('../core/math.js').AABB|ArrayLike<number>} aabb Query box.
   * @param {Array<number[]>} [out] Target list (cleared and refilled).
   * @returns {Array<number[]>} `out`, filled with `[minX,minY,minZ,maxX,maxY,maxZ]`.
   */
  getCollisionAABBs(aabb, out = []) {
    out.length = 0;
    const qMinX = aabb.minX !== undefined ? aabb.minX : aabb[0];
    const qMinY = aabb.minY !== undefined ? aabb.minY : aabb[1];
    const qMinZ = aabb.minZ !== undefined ? aabb.minZ : aabb[2];
    const qMaxX = aabb.maxX !== undefined ? aabb.maxX : aabb[3];
    const qMaxY = aabb.maxY !== undefined ? aabb.maxY : aabb[4];
    const qMaxZ = aabb.maxZ !== undefined ? aabb.maxZ : aabb[5];
    const x0 = Math.floor(qMinX);
    const y0 = Math.floor(qMinY);
    const z0 = Math.floor(qMinZ);
    const x1 = Math.ceil(qMaxX) - 1;
    const y1 = Math.ceil(qMaxY) - 1;
    const z1 = Math.ceil(qMaxZ) - 1;
    let count = 0;
    for (let y = y0; y <= y1; y++) {
      if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = this.getBlock(x, y, z);
          if (id === 0 || !isSolid(id)) continue;
          const boxes = blockAABBs(id, 0);
          for (let i = 0; i < boxes.length; i++) {
            const b = boxes[i];
            const minX = x + b[0];
            const minY = y + b[1];
            const minZ = z + b[2];
            const maxX = x + b[3];
            const maxY = y + b[4];
            const maxZ = z + b[5];
            if (minX >= qMaxX || maxX <= qMinX) continue;
            if (minY >= qMaxY || maxY <= qMinY) continue;
            if (minZ >= qMaxZ || maxZ <= qMinZ) continue;
            let slot = this._boxPool[count];
            if (slot === undefined) {
              slot = [0, 0, 0, 0, 0, 0];
              this._boxPool[count] = slot;
            }
            slot[0] = minX;
            slot[1] = minY;
            slot[2] = minZ;
            slot[3] = maxX;
            slot[4] = maxY;
            slot[5] = maxZ;
            out.push(slot);
            count++;
          }
        }
      }
    }
    return out;
  }

  /**
   * Whether every chunk column touched by a box carries terrain.
   * @param {import('../core/math.js').AABB|ArrayLike<number>} aabb Query box.
   * @returns {boolean} `true` when the area is fully loaded.
   */
  isAreaLoaded(aabb) {
    const minX = aabb.minX !== undefined ? aabb.minX : aabb[0];
    const minZ = aabb.minZ !== undefined ? aabb.minZ : aabb[2];
    const maxX = aabb.maxX !== undefined ? aabb.maxX : aabb[3];
    const maxZ = aabb.maxZ !== undefined ? aabb.maxZ : aabb[5];
    const cx0 = Math.floor(minX) >> 4;
    const cz0 = Math.floor(minZ) >> 4;
    const cx1 = Math.floor(maxX) >> 4;
    const cz1 = Math.floor(maxZ) >> 4;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunks.get(chunkKey(cx, cz));
        if (c === undefined || !c.generated) return false;
      }
    }
    return true;
  }

  // =========================================================================
  // Render list
  // =========================================================================

  /**
   * Frustum-cull all uploaded section meshes and invoke `cb` for each visible
   * one. Opaque and cutout passes are ordered front-to-back (early-Z), the
   * water pass back-to-front (blending).
   * @param {import('../core/math.js').Frustum} frustum Camera or light frustum.
   * @param {(mesh:SectionMesh) => void} cb Called once per visible mesh.
   * @param {'opaque'|'cutout'|'water'|'shadow'} [pass='opaque'] Draw pass.
   * @returns {number} Number of meshes handed to `cb`.
   */
  iterateRenderList(frustum, cb, pass = 'opaque') {
    if (typeof cb !== 'function') return 0;
    const list = this._cullVisible(frustum);
    const nearFirst = pass !== 'water';
    if (nearFirst !== this._cullNearFirst) {
      list.reverse();
      this._cullNearFirst = nearFirst;
    }
    for (let i = 0; i < list.length; i++) cb(list[i]);
    return list.length;
  }

  /**
   * Rebuild (or reuse) the sorted visible mesh list for a frustum.
   * @param {import('../core/math.js').Frustum} frustum Frustum to cull against.
   * @returns {SectionMesh[]} Visible meshes, nearest first.
   * @private
   */
  _cullVisible(frustum) {
    if (frustum === this._cullFrustum && this._cullEpoch === this._epoch) return this._visible;
    const visible = this._visible;
    visible.length = 0;
    const meshes = this._meshList;
    const camX = this._camX;
    const camY = this._camY;
    const camZ = this._camZ;
    const test = frustum && typeof frustum.containsAABB === 'function';
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      const a = mesh.aabb;
      if (test && !frustum.containsAABB(a[0], a[1], a[2], a[3], a[4], a[5])) continue;
      const cx = (a[0] + a[3]) * 0.5 - camX;
      const cy = (a[1] + a[4]) * 0.5 - camY;
      const cz = (a[2] + a[5]) * 0.5 - camZ;
      mesh.distSq = cx * cx + cy * cy + cz * cz;
      visible.push(mesh);
    }
    visible.sort(this._nearSort);
    this._cullFrustum = frustum || null;
    this._cullEpoch = this._epoch;
    this._cullNearFirst = true;
    return visible;
  }

  // =========================================================================
  // Statistics, persistence, errors
  // =========================================================================

  /**
   * Live counters for the F3 overlay and the renderer.
   * @returns {{loaded:number, meshing:number, generating:number, queued:number,
   *   vertices:number, triangles:number, memoryMB:number, sections:number,
   *   workers:number, lightQueue:number, pendingEdits:number}} Statistics.
   */
  getStats() {
    const now = nowMs();
    if (now - this._chunkBytesAt >= MEMORY_SAMPLE_INTERVAL_MS) {
      this._chunkBytesAt = now;
      let bytes = 0;
      for (const chunk of this.chunks.values()) bytes += chunk.memoryBytes();
      this._chunkBytes = bytes;
    }
    return {
      loaded: this.chunks.size,
      meshing: this._meshInflight + this._meshQueue.length,
      generating: this._generating,
      queued: this._genQueue.length + this._meshQueue.length,
      vertices: this._vertexTotal,
      triangles: this._triangleTotal,
      memoryMB: (this._chunkBytes + this._meshBytes) / 1048576,
      sections: this._meshedSections,
      workers: this._workers.length,
      lightQueue: this.lighting.pending,
      pendingEdits: this.pendingEdits.size,
    };
  }

  /**
   * World metadata written to storage.
   * @returns {{id:string, name:string, seed:number, dimension:string,
   *   genVersion:number, spawn:number[]|null, savedAt:number}} Metadata record.
   */
  getMeta() {
    return {
      id: this.worldId,
      name: this.name,
      seed: this.seed,
      dimension: this.dimension,
      genVersion: GEN_VERSION,
      spawn: this.spawn,
      savedAt: Date.now(),
    };
  }

  /**
   * Persist every modified chunk plus the world metadata.
   * @returns {Promise<number>} Number of chunks written.
   */
  async save() {
    if (!this._persist) return 0;
    const mgr = this._saveManager;
    let written = 0;
    for (const chunk of this.chunks.values()) {
      if (!chunk.modified) continue;
      let snapshot = null;
      try {
        snapshot = chunk.serialize();
      } catch (err) {
        this._reportError('serialize', err);
        continue;
      }
      chunk.modified = false;
      try {
        await mgr.saveChunk(this.worldId, chunk.cx, chunk.cz, snapshot);
        written++;
      } catch (err) {
        chunk.modified = true;
        this._reportError('saveChunk', err);
      }
    }
    if (typeof mgr.saveMeta === 'function') {
      try {
        await mgr.saveMeta(this.worldId, this.getMeta());
      } catch (err) {
        this._reportError('saveMeta', err);
      }
    }
    if (typeof mgr.flush === 'function') {
      try {
        await mgr.flush();
      } catch (err) {
        this._reportError('flush', err);
      }
    }
    return written;
  }

  /**
   * Read the stored world metadata. Call this **before** {@link World#init} so
   * the persisted seed is adopted by the generator.
   * @returns {Promise<Object|null>} The metadata record, or `null`.
   */
  async load() {
    const mgr = this._saveManager;
    if (!mgr || typeof mgr.loadMeta !== 'function') return null;
    let meta = null;
    try {
      meta = await mgr.loadMeta(this.worldId);
    } catch (err) {
      this._reportError('loadMeta', err);
      return null;
    }
    if (!meta) return null;
    if (!this.initialized && Number.isFinite(meta.seed)) this.seed = meta.seed | 0;
    if (typeof meta.name === 'string' && meta.name.length !== 0) this.name = meta.name;
    if (Array.isArray(meta.spawn) && meta.spawn.length >= 3) this.spawn = meta.spawn.slice(0, 3);
    return meta;
  }

  /**
   * Log a subsystem failure once and forward it on the bus instead of throwing
   * during a frame.
   * @param {string} where Subsystem tag.
   * @param {Error|string} error The failure.
   * @returns {void}
   * @private
   */
  _reportError(where, error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[VOXELIA] world/${where}:`, err);
    this.emit('error', where, err);
  }
}
