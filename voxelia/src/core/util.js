/**
 * @file core/util.js — VOXELIA shared utilities (spec 5.3).
 *
 * Event bus, object pool, binary-heap priority queue, frame time budget, LRU
 * cache and small helpers. Everything here is dependency-free and safe to
 * import inside a Web Worker: there is no `document`/`window` access at module
 * scope, and the only host APIs touched are `performance`, `setTimeout` and
 * (guarded) `requestAnimationFrame`.
 */

const PERF = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? performance
  : null;

/**
 * High-resolution monotonic timestamp in milliseconds. Falls back to
 * `Date.now()` on the (theoretical) hosts without `performance`.
 * @returns {number} Milliseconds since the time origin.
 */
export function nowMs() {
  return PERF ? PERF.now() : Date.now();
}

/**
 * Await the next animation frame. In a Worker — where there is no
 * `requestAnimationFrame` — this falls back to a ~16 ms timeout so the same
 * code can yield in both contexts.
 * @returns {Promise<number>} Resolves with the frame timestamp in milliseconds.
 */
export async function nextFrame() {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => { requestAnimationFrame(resolve); });
  }
  return new Promise((resolve) => { setTimeout(() => resolve(nowMs()), 16); });
}

/**
 * Throw when `cond` is falsy. Development guard for invariants that would
 * otherwise corrupt world data silently — never call it inside a per-frame hot
 * path, and never inside the render loop (see hard rule 8: no throwing during
 * a frame).
 * @param {*} cond Condition to check.
 * @param {string} [msg='assertion failed'] Message describing the invariant.
 * @returns {*} `cond`, so the call can be used inline.
 */
export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(`[VOXELIA] ${msg}`);
  return cond;
}

/**
 * Wrap a function so it runs at most once; every later call returns the first
 * result without re-invoking. The wrapper exposes a boolean `called` property.
 * @param {Function} fn Function to guard.
 * @returns {Function} The guarded wrapper.
 */
export function once(fn) {
  let result;
  const wrapped = function wrappedOnce(...args) {
    if (!wrapped.called) {
      wrapped.called = true;
      result = fn.apply(this, args);
    }
    return result;
  };
  /** @type {boolean} Whether the wrapped function has run. */
  wrapped.called = false;
  return wrapped;
}

/**
 * Rate-limit `fn` to at most one call per `ms`, leading edge first and with a
 * trailing call carrying the most recent arguments. The returned wrapper has a
 * `cancel()` method that drops any pending trailing call.
 * @param {Function} fn Function to throttle.
 * @param {number} ms Minimum interval between invocations, in milliseconds.
 * @returns {Function} The throttled wrapper.
 */
export function throttle(fn, ms) {
  let last = -Infinity;
  let timer = null;
  let pendingArgs = null;
  let pendingThis = null;

  const invoke = () => {
    timer = null;
    last = nowMs();
    const args = pendingArgs;
    const self = pendingThis;
    pendingArgs = null;
    pendingThis = null;
    fn.apply(self, args);
  };

  const wrapped = function throttled(...args) {
    const t = nowMs();
    const wait = ms - (t - last);
    if (wait <= 0) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingArgs = null;
      pendingThis = null;
      last = t;
      return fn.apply(this, args);
    }
    pendingArgs = args;
    pendingThis = this;
    if (timer === null) timer = setTimeout(invoke, wait);
    return undefined;
  };

  /** Drop any pending trailing invocation. */
  wrapped.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
    pendingThis = null;
  };

  return wrapped;
}

/**
 * Delay `fn` until `ms` have passed without another call. The returned wrapper
 * has `cancel()` (drop the pending call) and `flush()` (run it immediately).
 * @param {Function} fn Function to debounce.
 * @param {number} ms Quiet period in milliseconds.
 * @returns {Function} The debounced wrapper.
 */
export function debounce(fn, ms) {
  let timer = null;
  let pendingArgs = null;
  let pendingThis = null;

  const run = () => {
    timer = null;
    const args = pendingArgs;
    const self = pendingThis;
    pendingArgs = null;
    pendingThis = null;
    fn.apply(self, args);
  };

  const wrapped = function debounced(...args) {
    pendingArgs = args;
    pendingThis = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };

  /** Drop the pending invocation. */
  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
    pendingThis = null;
  };

  /** Run the pending invocation right now, if any. */
  wrapped.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      run();
    }
  };

  return wrapped;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Format a byte count for the debug overlay (base 1024).
 * @param {number} n Number of bytes.
 * @param {number} [decimals=1] Fraction digits for units above bytes.
 * @returns {string} Human readable size, e.g. `"12.4 MB"`.
 */
export function formatBytes(n, decimals = 1) {
  if (!Number.isFinite(n)) return 'n/a';
  const sign = n < 0 ? '-' : '';
  let v = Math.abs(n);
  if (v < 1024) return `${sign}${Math.round(v)} B`;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sign}${v.toFixed(decimals)} ${BYTE_UNITS[i]}`;
}

/* ------------------------------------------------------------------------- */
/* EventBus                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Minimal synchronous event emitter. Base class for `Settings`, `World`,
 * `Game`, `Inventory`, `EntityManager` and `Environment`.
 *
 * Listener lists are copy-on-write while an `emit` is in flight, so handlers
 * may safely subscribe or unsubscribe from inside a callback. A listener that
 * throws is caught and logged instead of aborting the emit (hard rule 8).
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Function[]>} @protected */
    this._listeners = new Map();
    /** @type {number} Nesting depth of the current emit. @protected */
    this._emitDepth = 0;
  }

  /**
   * Subscribe to an event.
   * @param {string} evt Event name.
   * @param {Function} fn Handler.
   * @returns {EventBus} `this`.
   */
  on(evt, fn) {
    if (typeof fn !== 'function') return this;
    const list = this._listeners.get(evt);
    if (!list) {
      this._listeners.set(evt, [fn]);
    } else if (this._emitDepth > 0) {
      const copy = list.slice();
      copy.push(fn);
      this._listeners.set(evt, copy);
    } else {
      list.push(fn);
    }
    return this;
  }

  /**
   * Unsubscribe a handler. Also removes a `once` wrapper registered for `fn`.
   * @param {string} evt Event name.
   * @param {Function} fn Handler previously passed to `on`/`once`.
   * @returns {EventBus} `this`.
   */
  off(evt, fn) {
    const list = this._listeners.get(evt);
    if (!list) return this;
    let index = -1;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (h === fn || h.listener === fn) {
        index = i;
        break;
      }
    }
    if (index < 0) return this;
    if (this._emitDepth > 0) {
      const copy = list.slice();
      copy.splice(index, 1);
      if (copy.length === 0) this._listeners.delete(evt);
      else this._listeners.set(evt, copy);
    } else {
      list.splice(index, 1);
      if (list.length === 0) this._listeners.delete(evt);
    }
    return this;
  }

  /**
   * Subscribe to the next occurrence of an event only.
   * @param {string} evt Event name.
   * @param {Function} fn Handler.
   * @returns {EventBus} `this`.
   */
  once(evt, fn) {
    if (typeof fn !== 'function') return this;
    const self = this;
    const wrapper = function onceWrapper(...args) {
      self.off(evt, wrapper);
      return fn.apply(self, args);
    };
    /** @type {Function} The original handler, so `off(evt, fn)` still works. */
    wrapper.listener = fn;
    return this.on(evt, wrapper);
  }

  /**
   * Invoke every handler registered for an event, in subscription order.
   * @param {string} evt Event name.
   * @param {...*} args Arguments forwarded to the handlers.
   * @returns {EventBus} `this`.
   */
  emit(evt, ...args) {
    const list = this._listeners.get(evt);
    if (!list || list.length === 0) return this;
    this._emitDepth++;
    try {
      for (let i = 0; i < list.length; i++) {
        try {
          list[i].apply(this, args);
        } catch (err) {
          console.error(`[VOXELIA] listener for "${evt}" threw:`, err);
        }
      }
    } finally {
      this._emitDepth--;
    }
    return this;
  }

  /**
   * Number of handlers registered for an event.
   * @param {string} evt Event name.
   * @returns {number} Listener count.
   */
  listenerCount(evt) {
    const list = this._listeners.get(evt);
    return list ? list.length : 0;
  }

  /**
   * Remove all handlers for one event, or for every event when `evt` is omitted.
   * @param {string} [evt] Event name; omit to clear the whole bus.
   * @returns {EventBus} `this`.
   */
  removeAllListeners(evt) {
    if (evt === undefined) this._listeners.clear();
    else this._listeners.delete(evt);
    return this;
  }
}

/* ------------------------------------------------------------------------- */
/* PriorityQueue                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Default comparator: ascending numeric priority (a min-heap).
 * @param {number} a Left priority.
 * @param {number} b Right priority.
 * @returns {number} Negative when `a` should be popped first.
 */
function defaultCompare(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * Binary min-heap priority queue — `push`/`pop` are O(log n), `peek` is O(1).
 * Used for chunk generation/meshing job ordering and A* pathfinding.
 *
 * The comparator receives the two **priority values** (not the items) and must
 * return a negative number when its first argument should be popped first.
 * Because `push(item)` defaults the priority to the item itself, a comparator
 * written over items also works if you push without an explicit priority.
 */
export class PriorityQueue {
  /**
   * @param {(a: *, b: *) => number} [cmp=defaultCompare] Priority comparator.
   */
  constructor(cmp = defaultCompare) {
    /** @type {(a: *, b: *) => number} @protected */
    this._cmp = cmp;
    /** @type {Array<*>} @protected */
    this._items = [];
    /** @type {Array<*>} @protected */
    this._prio = [];
    /** @type {number} @protected */
    this._size = 0;
  }

  /**
   * Number of queued entries.
   * @returns {number} Current size.
   */
  get size() {
    return this._size;
  }

  /**
   * Insert an item.
   * @param {*} item Payload.
   * @param {*} [priority=item] Priority value passed to the comparator.
   * @returns {PriorityQueue} `this`.
   */
  push(item, priority = item) {
    const i = this._size++;
    this._items[i] = item;
    this._prio[i] = priority;
    this._siftUp(i);
    return this;
  }

  /**
   * Remove and return the highest-priority item.
   * @returns {*} The item, or `undefined` when the queue is empty.
   */
  pop() {
    if (this._size === 0) return undefined;
    const top = this._items[0];
    const last = --this._size;
    if (last > 0) {
      this._items[0] = this._items[last];
      this._prio[0] = this._prio[last];
    }
    this._items[last] = undefined;
    this._prio[last] = undefined;
    if (last > 0) this._siftDown(0);
    return top;
  }

  /**
   * Look at the highest-priority item without removing it.
   * @returns {*} The item, or `undefined` when the queue is empty.
   */
  peek() {
    return this._size === 0 ? undefined : this._items[0];
  }

  /**
   * Look at the priority of the highest-priority item.
   * @returns {*} The priority, or `undefined` when the queue is empty.
   */
  peekPriority() {
    return this._size === 0 ? undefined : this._prio[0];
  }

  /**
   * Drop every entry.
   * @returns {PriorityQueue} `this`.
   */
  clear() {
    this._items.length = 0;
    this._prio.length = 0;
    this._size = 0;
    return this;
  }

  /**
   * Remove every entry matching a predicate and re-heapify in O(n).
   * Used to cancel queued chunk jobs when a chunk unloads.
   * @param {(item: *, priority: *) => boolean} pred Returns `true` to remove.
   * @returns {number} How many entries were removed.
   */
  remove(pred) {
    let removed = 0;
    let n = this._size;
    for (let i = n - 1; i >= 0; i--) {
      if (pred(this._items[i], this._prio[i])) {
        n--;
        this._items[i] = this._items[n];
        this._prio[i] = this._prio[n];
        this._items[n] = undefined;
        this._prio[n] = undefined;
        removed++;
      }
    }
    this._size = n;
    for (let i = (n >> 1) - 1; i >= 0; i--) this._siftDown(i);
    return removed;
  }

  /**
   * Restore the heap invariant upwards from `i`.
   * @param {number} i Start index.
   * @protected
   */
  _siftUp(i) {
    const items = this._items;
    const prio = this._prio;
    const item = items[i];
    const p = prio[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._cmp(p, prio[parent]) >= 0) break;
      items[i] = items[parent];
      prio[i] = prio[parent];
      i = parent;
    }
    items[i] = item;
    prio[i] = p;
  }

  /**
   * Restore the heap invariant downwards from `i`.
   * @param {number} i Start index.
   * @protected
   */
  _siftDown(i) {
    const items = this._items;
    const prio = this._prio;
    const n = this._size;
    const item = items[i];
    const p = prio[i];
    const half = n >> 1;
    while (i < half) {
      let child = i * 2 + 1;
      const right = child + 1;
      if (right < n && this._cmp(prio[right], prio[child]) < 0) child = right;
      if (this._cmp(prio[child], p) >= 0) break;
      items[i] = items[child];
      prio[i] = prio[child];
      i = child;
    }
    items[i] = item;
    prio[i] = p;
  }
}

/* ------------------------------------------------------------------------- */
/* ObjectPool                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Free-list object pool — recycles short-lived objects (particles, vectors,
 * mesh job descriptors) to keep hot paths allocation-free.
 */
export class ObjectPool {
  /**
   * @param {() => *} factory Creates a fresh object when the pool is empty.
   * @param {((obj: *) => void)|null} [reset=null] Called on an object as it is released.
   * @param {number} [initial=0] Number of objects to pre-allocate.
   */
  constructor(factory, reset = null, initial = 0) {
    /** @type {() => *} @protected */
    this._factory = factory;
    /** @type {((obj: *) => void)|null} @protected */
    this._reset = reset;
    /** @type {Array<*>} @protected */
    this._free = [];
    /** @type {number} Total objects ever created by this pool. */
    this.created = 0;
    for (let i = 0; i < initial; i++) {
      this._free.push(factory());
      this.created++;
    }
  }

  /**
   * Number of objects currently parked in the pool.
   * @returns {number} Free count.
   */
  get size() {
    return this._free.length;
  }

  /**
   * Take an object from the pool, creating one if the free list is empty.
   * @returns {*} A pooled or freshly created object.
   */
  get() {
    if (this._free.length > 0) return this._free.pop();
    this.created++;
    return this._factory();
  }

  /**
   * Return an object to the pool. The caller must not keep using it.
   * Releasing the same object twice corrupts the pool and is not checked.
   * @param {*} obj Object to recycle.
   * @returns {ObjectPool} `this`.
   */
  release(obj) {
    if (obj === null || obj === undefined) return this;
    if (this._reset) this._reset(obj);
    this._free.push(obj);
    return this;
  }

  /**
   * Drop every parked object (the `created` counter is kept).
   * @returns {ObjectPool} `this`.
   */
  clear() {
    this._free.length = 0;
    return this;
  }
}

/* ------------------------------------------------------------------------- */
/* TimeBudget                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Per-frame time budget, e.g. the <= 3 ms allowed for chunk mesh uploads.
 * Call {@link TimeBudget#start} once per frame and poll
 * {@link TimeBudget#expired} inside the work loop.
 */
export class TimeBudget {
  /**
   * @param {number} [ms=3] Budget in milliseconds.
   */
  constructor(ms = 3) {
    /** @type {number} Budget in milliseconds. */
    this.budgetMs = ms;
    /** @type {number} Timestamp of the last `start()`. */
    this.startTime = nowMs();
  }

  /**
   * Reset the clock.
   * @returns {TimeBudget} `this`.
   */
  start() {
    this.startTime = nowMs();
    return this;
  }

  /**
   * Change the budget (does not reset the clock).
   * @param {number} ms New budget in milliseconds.
   * @returns {TimeBudget} `this`.
   */
  setBudget(ms) {
    this.budgetMs = ms;
    return this;
  }

  /**
   * Milliseconds since the last `start()`.
   * @returns {number} Elapsed time.
   */
  elapsed() {
    return nowMs() - this.startTime;
  }

  /**
   * Whether the budget is used up.
   * @returns {boolean} `true` when no time is left.
   */
  expired() {
    return (nowMs() - this.startTime) >= this.budgetMs;
  }

  /**
   * Milliseconds left in the budget, never negative.
   * @returns {number} Remaining time.
   */
  remaining() {
    const left = this.budgetMs - (nowMs() - this.startTime);
    return left > 0 ? left : 0;
  }
}

/* ------------------------------------------------------------------------- */
/* LRU                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * True least-recently-used cache backed by a `Map` (which preserves insertion
 * order): reading or writing a key moves it to the most-recent end, and the
 * oldest entry is evicted once `limit` is exceeded.
 */
export class LRU {
  /**
   * @param {number} limit Maximum number of entries (>= 1).
   * @param {((key: *, value: *) => void)|null} [onEvict=null] Called for every
   *   evicted entry — the place to `dispose()` GPU resources.
   */
  constructor(limit, onEvict = null) {
    /** @type {number} Maximum number of entries. */
    this.limit = Math.max(1, limit | 0);
    /** @type {((key: *, value: *) => void)|null} */
    this.onEvict = onEvict;
    /** @type {Map<*, *>} @protected */
    this._map = new Map();
  }

  /**
   * Current number of entries.
   * @returns {number} Entry count.
   */
  get size() {
    return this._map.size;
  }

  /**
   * Look a key up and mark it most-recently used.
   * @param {*} k Key.
   * @returns {*} The value, or `undefined` when absent.
   */
  get(k) {
    const map = this._map;
    if (!map.has(k)) return undefined;
    const v = map.get(k);
    map.delete(k);
    map.set(k, v);
    return v;
  }

  /**
   * Look a key up **without** changing its recency.
   * @param {*} k Key.
   * @returns {*} The value, or `undefined` when absent.
   */
  peek(k) {
    return this._map.get(k);
  }

  /**
   * Insert or update a key, marking it most-recently used and evicting the
   * oldest entries while the cache is over its limit.
   * @param {*} k Key.
   * @param {*} v Value.
   * @returns {LRU} `this`.
   */
  set(k, v) {
    const map = this._map;
    if (map.has(k)) map.delete(k);
    map.set(k, v);
    while (map.size > this.limit) {
      const oldestKey = map.keys().next().value;
      const oldestValue = map.get(oldestKey);
      map.delete(oldestKey);
      if (this.onEvict) this.onEvict(oldestKey, oldestValue);
    }
    return this;
  }

  /**
   * Membership test; does not change recency.
   * @param {*} k Key.
   * @returns {boolean} `true` when the key is cached.
   */
  has(k) {
    return this._map.has(k);
  }

  /**
   * Remove one entry. `onEvict` is **not** called for explicit deletes.
   * @param {*} k Key.
   * @returns {boolean} `true` when an entry was removed.
   */
  delete(k) {
    return this._map.delete(k);
  }

  /**
   * Iterate keys, oldest first.
   * @returns {IterableIterator<*>} Key iterator.
   */
  keys() {
    return this._map.keys();
  }

  /**
   * Iterate values, oldest first.
   * @returns {IterableIterator<*>} Value iterator.
   */
  values() {
    return this._map.values();
  }

  /**
   * Iterate `[key, value]` pairs, oldest first.
   * @returns {IterableIterator<[*, *]>} Entry iterator.
   */
  entries() {
    return this._map.entries();
  }

  /**
   * Drop every entry, calling `onEvict` for each.
   * @returns {LRU} `this`.
   */
  clear() {
    if (this.onEvict) {
      for (const [k, v] of this._map) this.onEvict(k, v);
    }
    this._map.clear();
    return this;
  }
}

/* ------------------------------------------------------------------------- */
/* RingBuffer                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Fixed-capacity circular buffer over a typed array — the storage behind the
 * frame-time and memory graphs in the debug overlay. Pushing never allocates
 * and overwrites the oldest sample once the buffer is full. Index `0` is always
 * the oldest retained sample.
 */
export class RingBuffer {
  /**
   * @param {number} capacity Number of samples to retain (>= 1).
   * @param {Function} [ArrayType=Float32Array] Typed-array constructor for the storage.
   */
  constructor(capacity, ArrayType = Float32Array) {
    /** @type {number} Maximum number of retained samples. */
    this.capacity = Math.max(1, capacity | 0);
    /** @type {Float32Array|Int32Array|Uint8Array|Float64Array} Backing storage. */
    this.data = new ArrayType(this.capacity);
    /** @type {number} Write cursor. @protected */
    this._head = 0;
    /** @type {number} @protected */
    this._length = 0;
  }

  /**
   * Number of samples currently stored.
   * @returns {number} Sample count, at most `capacity`.
   */
  get length() {
    return this._length;
  }

  /**
   * Whether the buffer has wrapped at least once.
   * @returns {boolean} `true` when `length === capacity`.
   */
  get full() {
    return this._length === this.capacity;
  }

  /**
   * Append a sample, overwriting the oldest one when full.
   * @param {number} v Sample value.
   * @returns {RingBuffer} `this`.
   */
  push(v) {
    this.data[this._head] = v;
    this._head = (this._head + 1) % this.capacity;
    if (this._length < this.capacity) this._length++;
    return this;
  }

  /**
   * Read a sample by age: `0` is the oldest retained sample,
   * `length - 1` the newest.
   * @param {number} i Index in `[0, length)`.
   * @returns {number} The sample, or `0` when `i` is out of range.
   */
  get(i) {
    if (i < 0 || i >= this._length) return 0;
    const start = (this._head - this._length + this.capacity) % this.capacity;
    return this.data[(start + i) % this.capacity];
  }

  /**
   * Most recently pushed sample.
   * @returns {number} The newest sample, or `0` when empty.
   */
  last() {
    if (this._length === 0) return 0;
    return this.data[(this._head - 1 + this.capacity) % this.capacity];
  }

  /**
   * Smallest retained sample.
   * @returns {number} Minimum, or `0` when empty.
   */
  min() {
    if (this._length === 0) return 0;
    let m = Infinity;
    for (let i = 0; i < this._length; i++) {
      const v = this.get(i);
      if (v < m) m = v;
    }
    return m;
  }

  /**
   * Largest retained sample.
   * @returns {number} Maximum, or `0` when empty.
   */
  max() {
    if (this._length === 0) return 0;
    let m = -Infinity;
    for (let i = 0; i < this._length; i++) {
      const v = this.get(i);
      if (v > m) m = v;
    }
    return m;
  }

  /**
   * Sum of the retained samples.
   * @returns {number} Sum, or `0` when empty.
   */
  sum() {
    let s = 0;
    for (let i = 0; i < this._length; i++) s += this.get(i);
    return s;
  }

  /**
   * Arithmetic mean of the retained samples.
   * @returns {number} Average, or `0` when empty.
   */
  average() {
    if (this._length === 0) return 0;
    return this.sum() / this._length;
  }

  /**
   * Visit every retained sample from oldest to newest.
   * @param {(value: number, index: number) => void} cb Visitor.
   * @returns {RingBuffer} `this`.
   */
  forEach(cb) {
    for (let i = 0; i < this._length; i++) cb(this.get(i), i);
    return this;
  }

  /**
   * Copy the retained samples, oldest first, into a linear array.
   * @param {Float32Array|number[]} [out=[]] Receiver; must hold `length` entries.
   * @returns {Float32Array|number[]} `out`.
   */
  toArray(out = []) {
    for (let i = 0; i < this._length; i++) out[i] = this.get(i);
    return out;
  }

  /**
   * Forget every sample.
   * @returns {RingBuffer} `this`.
   */
  clear() {
    this._head = 0;
    this._length = 0;
    this.data.fill(0);
    return this;
  }
}

/* ------------------------------------------------------------------------- */
/* Deferred                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * A promise with its `resolve`/`reject` exposed — used to await worker job
 * results, asset generation and screen transitions without nesting executors.
 * Settling twice is ignored.
 */
export class Deferred {
  constructor() {
    /** @type {'pending'|'fulfilled'|'rejected'} Current state. */
    this.state = 'pending';
    /** @type {*} Fulfilment value, once resolved. */
    this.value = undefined;
    /** @type {*} Rejection reason, once rejected. */
    this.reason = undefined;
    /** @type {Function} @protected */
    this._resolve = null;
    /** @type {Function} @protected */
    this._reject = null;
    /** @type {Promise<*>} The controlled promise. */
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  /**
   * Whether the promise has already settled.
   * @returns {boolean} `true` when fulfilled or rejected.
   */
  get settled() {
    return this.state !== 'pending';
  }

  /**
   * Fulfil the promise. No-op once settled.
   * @param {*} [value] Fulfilment value.
   * @returns {Deferred} `this`.
   */
  resolve(value) {
    if (this.state !== 'pending') return this;
    this.state = 'fulfilled';
    this.value = value;
    this._resolve(value);
    return this;
  }

  /**
   * Reject the promise. No-op once settled.
   * @param {*} [reason] Rejection reason.
   * @returns {Deferred} `this`.
   */
  reject(reason) {
    if (this.state !== 'pending') return this;
    this.state = 'rejected';
    this.reason = reason;
    this._reject(reason);
    return this;
  }
}
