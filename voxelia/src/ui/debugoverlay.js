/**
 * @file ui/debugoverlay.js — VOXELIA F3 screen (ARCHITECTURE.md § 5.41).
 *
 * A two-column, monospaced diagnostic overlay drawn on top of the canvas:
 *
 * ```
 * left                              right
 *   FPS + frame-time graph            resolution / render scale
 *   CPU and GPU frame cost            per-pass GPU timings (renderer.stats)
 *   XYZ / block / chunk / section     draw calls, triangles, sections
 *   facing, biome                     entities, particles
 *   sky light + coloured block light  chunk streaming counters
 *   the targeted block                JS heap (Chromium only)
 *   weather, day and clock            world seed, GPU name
 * ```
 *
 * ============================================================================
 * COST
 * ============================================================================
 * While hidden the overlay is a single `display:none` element and
 * {@link DebugOverlay#update} returns on its first line — nothing is read, no
 * string is built, the graph is not drawn. While visible the text rows refresh
 * at 10 Hz and only the values that actually changed are written back into the
 * DOM; the frame-time graph is the one thing redrawn every frame, because that
 * is the entire point of a frame-time graph. The canvas is 240x56 device
 * pixels, so the redraw is a rounding error.
 *
 * ============================================================================
 * WIRING
 * ============================================================================
 * The overlay has no keyboard handler of its own — the `debug` action of
 * `core/input.js` (F3 by default) belongs to the game loop, which calls
 * {@link DebugOverlay#toggle}. Everything it reads is duck-typed and guarded,
 * so it also works while the world or the renderer is still booting.
 *
 * All player-visible text is German.
 *
 * @module ui/debugoverlay
 */

import { getBlock } from '../world/blocks.js';
import { getBiome } from '../world/biomes.js';
import { CHUNK_SIZE, SECTION_SIZE, WORLD_MIN_Y } from '../world/chunk.js';
import { WEATHER_LABELS, PHASE_LABELS } from '../game/environment.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Id of the injected stylesheet. @type {string} */
const STYLE_ID = 'vx-debug-css';

/** Seconds between two text refreshes. The graph updates every frame. */
const TEXT_INTERVAL = 0.1;

/** Frame-time samples kept when the renderer exposes no history. @type {number} */
const LOCAL_SAMPLES = 180;

/** Backing-store width of the frame-time graph in device pixels. @type {number} */
const GRAPH_W = 240;

/** Backing-store height of the frame-time graph in device pixels. @type {number} */
const GRAPH_H = 56;

/**
 * Canonical GPU pass order. It mirrors `render/renderer.js#PASS_LABELS`; any
 * pass the device reports that is not listed here is appended in the order the
 * renderer hands it over, so a new pass shows up without a code change here.
 * @type {ReadonlyArray<string>}
 */
const PASS_ORDER = Object.freeze([
  'sky.lut', 'shadows', 'gbuffer', 'ssao', 'lighting', 'sky', 'water',
  'particles', 'debug', 'post',
]);

/** German labels for the GPU passes. @type {Readonly<Object<string, string>>} */
const PASS_LABELS_DE = Object.freeze({
  'sky.lut': 'Himmels-LUT',
  shadows: 'Schatten',
  gbuffer: 'G-Buffer',
  ssao: 'SSAO',
  lighting: 'Beleuchtung',
  sky: 'Himmel',
  water: 'Wasser',
  particles: 'Partikel',
  debug: 'Debug',
  post: 'Post',
});

/** Compass names, indexed by the quadrant the yaw falls into. */
const FACING = Object.freeze([
  { de: 'Norden', axis: '-Z' },
  { de: 'Osten', axis: '+X' },
  { de: 'Süden', axis: '+Z' },
  { de: 'Westen', axis: '-X' },
]);

/** German names of the eight moon phases; `0` is full moon. */
const MOON_LABELS = Object.freeze([
  'Vollmond', 'Abnehmend (3/4)', 'Letztes Viertel', 'Abnehmend (1/4)',
  'Neumond', 'Zunehmend (1/4)', 'Erstes Viertel', 'Zunehmend (3/4)',
]);

/** Overlay stylesheet; prepended to `<head>` so `ui/style.css` always wins. */
const CSS = `
.vx-dbg{position:absolute;inset:0;z-index:var(--z-hud-top);pointer-events:none;
 display:grid;grid-template-columns:minmax(0,auto) 1fr minmax(0,auto);align-items:start;
 gap:var(--sp-2);padding:calc(6px * var(--gui-scale)) calc(8px * var(--gui-scale));
 box-sizing:border-box;font-family:var(--font-mono);font-size:var(--fs-xs);
 line-height:1.4;font-variant-numeric:tabular-nums;color:var(--text-0);
 text-shadow:0 1px 2px rgba(0,0,0,.9)}
.vx-dbg__col{display:flex;flex-direction:column;min-width:0;max-height:calc(100vh - calc(16px * var(--gui-scale)));
 overflow:hidden;padding:var(--sp-2) var(--sp-3);border-radius:var(--r-sm);
 background:rgba(4,7,12,.46);border:var(--hair) solid var(--line-0);
 -webkit-backdrop-filter:var(--blur-sm);backdrop-filter:var(--blur-sm)}
.vx-dbg__col--right{grid-column:3}
.vx-dbg__head{font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:var(--ls-caps);
 color:var(--text-3);margin-bottom:calc(2px * var(--gui-scale))}
.vx-dbg__row{display:flex;gap:var(--sp-4);justify-content:space-between;white-space:nowrap}
.vx-dbg__k{color:var(--text-3)}
.vx-dbg__v{color:var(--text-0)}
.vx-dbg__fps{font-family:var(--font-mono);font-size:var(--fs-lg);font-weight:var(--fw-bold);
 letter-spacing:var(--ls-tight);color:var(--ok)}
.vx-dbg.is-bad .vx-dbg__fps{color:var(--warn)}
.vx-dbg.is-terrible .vx-dbg__fps{color:var(--danger)}
.vx-dbg__graph{display:block;width:calc(232px * var(--gui-scale));height:calc(54px * var(--gui-scale));
 margin:var(--sp-1) 0;border-radius:var(--r-xs);background:rgba(0,0,0,.42);
 border:var(--hair) solid var(--line-0)}
.vx-dbg__sep{height:var(--hair);background:var(--line-0);margin:var(--sp-2) 0;flex:none}
.vx-dbg__sw{display:inline-block;width:calc(9px * var(--gui-scale));height:calc(9px * var(--gui-scale));
 margin-left:calc(5px * var(--gui-scale));border-radius:calc(2px * var(--gui-scale));
 border:var(--hair) solid var(--line-2);vertical-align:-1px}
@media (max-width:640px){.vx-dbg{font-size:var(--fs-2xs)}
 .vx-dbg__col--right{display:none}
 .vx-dbg__graph{width:calc(180px * var(--gui-scale))}}
`;

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/** Keys of problems already reported. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a message at most once per key.
 * @param {string} key de-duplication key
 * @param {string} message human readable message
 * @param {*} [err] optional underlying error
 * @returns {void}
 */
function warnOnce(key, message, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err === undefined) console.warn(`[debug-overlay] ${message}`);
  else console.warn(`[debug-overlay] ${message}`, err);
}

/** True once the overlay stylesheet has been inserted. @type {boolean} */
let stylesInstalled = false;

/**
 * Insert the overlay stylesheet exactly once, before every other stylesheet.
 * @returns {void}
 */
function ensureStyles() {
  if (stylesInstalled) return;
  stylesInstalled = true;
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.insertBefore(style, document.head.firstChild);
}

/**
 * Create an element with a class list and optional text.
 * @param {string} tag tag name
 * @param {string} [cls] space separated class list
 * @param {string} [text] text content
 * @returns {HTMLElement} the new element
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * Write text into a node only when it actually changed.
 * @param {?HTMLElement} node target node
 * @param {string} value new text
 * @returns {void}
 */
function setText(node, value) {
  if (node === null || node === undefined) return;
  if (node.__vxText === value) return;
  node.__vxText = value;
  node.textContent = value;
}

/**
 * Format a finite number with a fixed number of decimals; `'—'` for anything
 * that is not a number.
 * @param {*} value candidate number
 * @param {number} [digits] decimal places
 * @returns {string} the formatted value
 */
function fmt(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/**
 * Format an integer with thin thousands separators.
 * @param {*} value candidate number
 * @returns {string} the formatted value
 */
function fmtInt(value) {
  if (!Number.isFinite(value)) return '—';
  const n = Math.round(value);
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(n));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ' ';
    out += digits[i];
  }
  return sign + out;
}

/**
 * Floor division that also works for negative coordinates.
 * @param {number} value the value
 * @param {number} size divisor
 * @returns {number} the floored quotient
 */
function floorDiv(value, size) {
  return Math.floor(value / size);
}

/**
 * German name of a block face from its normal.
 * @param {?ArrayLike<number>} normal the face normal
 * @returns {string} the face name
 */
function faceName(normal) {
  if (!normal || normal.length < 3) return '—';
  if (normal[1] > 0.5) return 'oben (+Y)';
  if (normal[1] < -0.5) return 'unten (-Y)';
  if (normal[0] > 0.5) return 'Osten (+X)';
  if (normal[0] < -0.5) return 'Westen (-X)';
  if (normal[2] > 0.5) return 'Süden (+Z)';
  if (normal[2] < -0.5) return 'Norden (-Z)';
  return '—';
}

/* ========================================================================== */
/* DebugOverlay                                                               */
/* ========================================================================== */

/**
 * The F3 diagnostic screen.
 *
 * Created once during boot and toggled by the game loop; it never throws and
 * never allocates while hidden.
 */
export class DebugOverlay {
  /**
   * @param {*} game the `Game` instance (duck-typed: `renderer`, `world`,
   *   `player`, `entities`, `environment`, `interaction`, `gl`)
   * @param {HTMLElement} root the `#ui` root element
   */
  constructor(game, root) {
    ensureStyles();

    /** @type {*} the game */
    this.game = game || null;
    /** @type {?HTMLElement} the UI root */
    this.root = root || null;

    /** @type {boolean} is the overlay on screen? @private */
    this._visible = false;
    /** @type {boolean} set by {@link DebugOverlay#dispose}. @private */
    this._disposed = false;
    /** @type {number} seconds until the next text refresh. @private */
    this._textTimer = 0;

    /** @type {HTMLElement} overlay root */
    this.layer = el('div', 'vx-layer vx-dbg');
    this.layer.classList.add('is-hidden');

    /** @type {HTMLElement} left column @private */
    this._left = el('div', 'vx-dbg__col vx-dbg__col--left');
    /** @type {HTMLElement} right column @private */
    this._right = el('div', 'vx-dbg__col vx-dbg__col--right');
    this.layer.appendChild(this._left);
    this.layer.appendChild(el('div'));
    this.layer.appendChild(this._right);
    if (this.root) this.root.appendChild(this.layer);

    /** @type {Object<string, HTMLElement>} value nodes by field key. @private */
    this._f = Object.create(null);

    /** @type {?HTMLCanvasElement} frame-time graph. @private */
    this._canvas = null;
    /** @type {?CanvasRenderingContext2D} graph context. @private */
    this._ctx = null;
    /** @type {Float32Array} local frame-time history. @private */
    this._history = new Float32Array(LOCAL_SAMPLES);
    /** @type {number} write cursor into {@link DebugOverlay#_history}. @private */
    this._historyAt = 0;
    /** @type {number} valid samples in {@link DebugOverlay#_history}. @private */
    this._historyLen = 0;
    /** @type {Float32Array} scratch the graph reads its samples into. @private */
    this._samples = new Float32Array(GRAPH_W);

    /** @type {HTMLElement} container of the GPU pass rows. @private */
    this._passBox = el('div');
    /** @type {string} key signature of the rendered pass rows. @private */
    this._passKeys = '';
    /** @type {Object<string, HTMLElement>} pass label -> value node. @private */
    this._passRows = Object.create(null);

    /** @type {HTMLElement} colour swatch of the block light. @private */
    this._lightSwatch = el('i', 'vx-dbg__sw');
    /** @type {string} last swatch colour written. @private */
    this._lightColor = '';

    /** @type {number[]} scratch for `world.getBlockLight`. @private */
    this._rgb = [0, 0, 0];

    this._build();
  }

  /* ====================================================================== */
  /* Public API                                                             */
  /* ====================================================================== */

  /**
   * Whether the overlay is currently on screen.
   * @returns {boolean} true while visible
   */
  get visible() {
    return this._visible;
  }

  /**
   * Show the overlay.
   * @returns {void}
   */
  show() {
    if (this._disposed || this._visible) return;
    this._visible = true;
    this._textTimer = 0;
    this.layer.classList.remove('is-hidden');
    this._resizeGraph();
  }

  /**
   * Hide the overlay. Everything below `update()`'s first line stops running.
   * @returns {void}
   */
  hide() {
    if (!this._visible) return;
    this._visible = false;
    this.layer.classList.add('is-hidden');
  }

  /**
   * Flip the overlay on or off — this is what the `debug` action (F3) calls.
   * @returns {boolean} the new visibility
   */
  toggle() {
    if (this._visible) this.hide();
    else this.show();
    return this._visible;
  }

  /**
   * Per-frame refresh. Returns immediately while hidden.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   */
  update(dt) {
    if (!this._visible || this._disposed) return;
    const step = Number.isFinite(dt) ? dt : 0;
    try {
      this._pushFrameTime(step);
      this._drawGraph();
      this._textTimer -= step;
      if (this._textTimer <= 0) {
        this._textTimer = TEXT_INTERVAL;
        this._updateLeft();
        this._updateRight();
      }
    } catch (err) {
      warnOnce('update', 'the F3 overlay failed and was hidden.', err);
      this.hide();
    }
  }

  /**
   * Detach the overlay.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._visible = false;
    if (this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this._ctx = null;
    this._canvas = null;
    this._passRows = Object.create(null);
    this._f = Object.create(null);
  }

  /* ====================================================================== */
  /* Construction                                                           */
  /* ====================================================================== */

  /**
   * Build both columns once.
   * @returns {void}
   * @private
   */
  _build() {
    /* -- left ------------------------------------------------------------- */
    this._left.appendChild(el('div', 'vx-dbg__head', 'VOXELIA · F3'));

    const fps = el('div', 'vx-dbg__fps', '— FPS');
    this._f.fps = fps;
    this._left.appendChild(fps);

    this._canvas = /** @type {HTMLCanvasElement} */ (el('canvas', 'vx-dbg__graph'));
    this._canvas.width = GRAPH_W;
    this._canvas.height = GRAPH_H;
    try {
      this._ctx = this._canvas.getContext('2d');
    } catch (err) {
      warnOnce('ctx', 'no 2D context: the frame-time graph stays empty.', err);
      this._ctx = null;
    }
    this._left.appendChild(this._canvas);

    this._row(this._left, 'frame', 'Bild');
    this._row(this._left, 'cpu', 'CPU / GPU');
    this._left.appendChild(el('div', 'vx-dbg__sep'));

    this._row(this._left, 'xyz', 'XYZ');
    this._row(this._left, 'block', 'Block');
    this._row(this._left, 'chunk', 'Chunk');
    this._row(this._left, 'section', 'Sektion');
    this._row(this._left, 'facing', 'Blick');
    this._row(this._left, 'velocity', 'Geschwindigkeit');
    this._left.appendChild(el('div', 'vx-dbg__sep'));

    this._row(this._left, 'biome', 'Biom');
    const lightRow = this._row(this._left, 'light', 'Licht');
    lightRow.appendChild(this._lightSwatch);
    this._row(this._left, 'target', 'Ziel');
    this._row(this._left, 'targetPos', 'Zielposition');
    this._row(this._left, 'targetFace', 'Fläche');
    this._left.appendChild(el('div', 'vx-dbg__sep'));

    this._row(this._left, 'weather', 'Wetter');
    this._row(this._left, 'day', 'Tag');
    this._row(this._left, 'clock', 'Uhrzeit');
    this._row(this._left, 'moon', 'Mondphase');
    this._row(this._left, 'seed', 'Seed');

    /* -- right ------------------------------------------------------------ */
    this._right.appendChild(el('div', 'vx-dbg__head', 'Renderer'));
    this._row(this._right, 'res', 'Auflösung');
    this._row(this._right, 'scale', 'Renderskalierung');
    this._row(this._right, 'draws', 'Draw-Calls');
    this._row(this._right, 'tris', 'Dreiecke');
    this._row(this._right, 'sections', 'Sektionen');
    this._row(this._right, 'entities', 'Entitäten');
    this._row(this._right, 'particles', 'Partikel');
    this._right.appendChild(el('div', 'vx-dbg__sep'));

    this._right.appendChild(el('div', 'vx-dbg__head', 'GPU-Pässe'));
    this._right.appendChild(this._passBox);
    this._right.appendChild(el('div', 'vx-dbg__sep'));

    this._right.appendChild(el('div', 'vx-dbg__head', 'Welt'));
    this._row(this._right, 'loaded', 'Chunks geladen');
    this._row(this._right, 'meshing', 'Vernetzung');
    this._row(this._right, 'queued', 'Warteschlange');
    this._row(this._right, 'generating', 'Generierung');
    this._row(this._right, 'lightQueue', 'Lichtqueue');
    this._row(this._right, 'workers', 'Worker');
    this._row(this._right, 'chunkMem', 'Chunk-Speicher');
    this._right.appendChild(el('div', 'vx-dbg__sep'));

    this._right.appendChild(el('div', 'vx-dbg__head', 'System'));
    this._row(this._right, 'heap', 'JS-Heap');
    this._row(this._right, 'gpu', 'Grafikkarte');
  }

  /**
   * Append one label/value row.
   * @param {HTMLElement} column the column to append to
   * @param {string} key field key used by the updaters
   * @param {string} label German label
   * @returns {HTMLElement} the row element
   * @private
   */
  _row(column, key, label) {
    const row = el('div', 'vx-dbg__row');
    row.appendChild(el('span', 'vx-dbg__k', label));
    const value = el('span', 'vx-dbg__v', '—');
    row.appendChild(value);
    column.appendChild(row);
    this._f[key] = value;
    return row;
  }

  /* ====================================================================== */
  /* Frame-time graph                                                       */
  /* ====================================================================== */

  /**
   * Record this frame's duration in the local history, which is used whenever
   * the renderer exposes no ring buffer of its own.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   * @private
   */
  _pushFrameTime(dt) {
    if (!(dt > 0)) return;
    this._history[this._historyAt] = dt * 1000;
    this._historyAt = (this._historyAt + 1) % LOCAL_SAMPLES;
    if (this._historyLen < LOCAL_SAMPLES) this._historyLen++;
  }

  /**
   * Match the canvas backing store to the device pixel ratio once per show.
   * @returns {void}
   * @private
   */
  _resizeGraph() {
    const canvas = this._canvas;
    if (canvas === null) return;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = Math.round(GRAPH_W * dpr);
    const h = Math.round(GRAPH_H * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      if (this._samples.length < w) this._samples = new Float32Array(w);
    }
  }

  /**
   * Copy the newest frame times into the scratch buffer, preferring the
   * renderer's own ring buffer.
   * @param {number} want how many samples to collect
   * @returns {number} how many samples were written
   * @private
   */
  _collectSamples(want) {
    const out = this._samples;
    const renderer = this.game && this.game.renderer;
    const ring = renderer && renderer.stats && renderer.stats.frameTimes;
    if (ring && typeof ring.get === 'function' && Number.isFinite(ring.length)) {
      const total = ring.length | 0;
      const n = Math.min(want, total);
      const skip = total - n;
      for (let i = 0; i < n; i++) out[i] = ring.get(skip + i);
      return n;
    }
    const total = this._historyLen;
    const n = Math.min(want, total);
    const start = (this._historyAt - n + LOCAL_SAMPLES * 2) % LOCAL_SAMPLES;
    for (let i = 0; i < n; i++) out[i] = this._history[(start + i) % LOCAL_SAMPLES];
    return n;
  }

  /**
   * Redraw the frame-time graph: one bar per sample, a green/amber/red scale
   * with guides at 60 and 30 FPS.
   * @returns {void}
   * @private
   */
  _drawGraph() {
    const ctx = this._ctx;
    const canvas = this._canvas;
    if (ctx === null || canvas === null) return;
    const w = canvas.width;
    const h = canvas.height;

    const count = this._collectSamples(w);
    ctx.clearRect(0, 0, w, h);
    if (count === 0) return;

    const samples = this._samples;
    let peak = 33.4;
    for (let i = 0; i < count; i++) if (samples[i] > peak) peak = samples[i];
    const scale = Math.min(peak * 1.08, 200);

    // Guides at 16.7 ms (60 FPS) and 33.3 ms (30 FPS).
    ctx.fillStyle = 'rgba(120,224,150,0.22)';
    const y60 = h - (16.667 / scale) * h;
    ctx.fillRect(0, Math.round(y60), w, 1);
    ctx.fillStyle = 'rgba(255,182,72,0.22)';
    const y30 = h - (33.333 / scale) * h;
    ctx.fillRect(0, Math.round(y30), w, 1);

    const step = w / count;
    const barW = Math.max(1, Math.floor(step));
    for (let i = 0; i < count; i++) {
      const ms = samples[i];
      const bar = Math.max(1, Math.round((ms / scale) * h));
      ctx.fillStyle = ms <= 16.9 ? '#58d996' : (ms <= 33.4 ? '#ffb648' : '#ff5566');
      ctx.fillRect(Math.round(i * step), h - bar, barW, bar);
    }
  }

  /* ====================================================================== */
  /* Text updates                                                           */
  /* ====================================================================== */

  /**
   * Refresh the left column: timing, position, environment and the target.
   * @returns {void}
   * @private
   */
  _updateLeft() {
    const game = this.game;
    const f = this._f;
    const renderer = game && game.renderer;
    const stats = renderer && renderer.stats;

    /* -- timing ----------------------------------------------------------- */
    let fps = 0;
    let frameMs = 0;
    if (stats) {
      fps = Number.isFinite(stats.fps) ? stats.fps : 0;
      frameMs = Number.isFinite(stats.frameMs) ? stats.frameMs : 0;
    }
    if (!(fps > 0) && this._historyLen > 0) {
      const last = this._history[(this._historyAt - 1 + LOCAL_SAMPLES) % LOCAL_SAMPLES];
      frameMs = last;
      fps = last > 0 ? 1000 / last : 0;
    }
    setText(f.fps, `${Math.round(fps)} FPS`);
    this.layer.classList.toggle('is-bad', fps > 0 && fps < 55);
    this.layer.classList.toggle('is-terrible', fps > 0 && fps < 25);

    let lo = Infinity;
    let hi = 0;
    const count = this._collectSamples(Math.min(this._samples.length, 120));
    for (let i = 0; i < count; i++) {
      const v = this._samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    setText(f.frame, count === 0
      ? `${fmt(frameMs, 2)} ms`
      : `${fmt(frameMs, 2)} ms  (min ${fmt(lo, 1)} / max ${fmt(hi, 1)})`);
    setText(f.cpu, stats
      ? `${fmt(stats.cpuMs, 2)} / ${fmt(stats.gpuMs, 2)} ms`
      : '—');

    /* -- position --------------------------------------------------------- */
    const player = game && game.player;
    const pos = player && player.position;
    if (pos && pos.length >= 3) {
      const x = pos[0];
      const y = pos[1];
      const z = pos[2];
      const bx = Math.floor(x);
      const by = Math.floor(y);
      const bz = Math.floor(z);
      const cx = floorDiv(bx, CHUNK_SIZE);
      const cz = floorDiv(bz, CHUNK_SIZE);
      const sy = floorDiv(by - WORLD_MIN_Y, SECTION_SIZE);
      setText(f.xyz, `${fmt(x, 3)} / ${fmt(y, 3)} / ${fmt(z, 3)}`);
      setText(f.block, `${bx} ${by} ${bz}`);
      setText(f.chunk, `${cx} ${cz}  (in Chunk ${bx - cx * CHUNK_SIZE} ${bz - cz * CHUNK_SIZE})`);
      setText(f.section, `${sy}  (Y-Basis ${WORLD_MIN_Y + sy * SECTION_SIZE})`);

      const yaw = Number.isFinite(player.yaw) ? player.yaw : 0;
      const pitch = Number.isFinite(player.pitch) ? player.pitch : 0;
      let deg = (yaw * 180) / Math.PI;
      deg %= 360;
      if (deg < 0) deg += 360;
      const dir = FACING[Math.round(deg / 90) % 4];
      setText(f.facing, `${dir.de} (${dir.axis})  ${fmt(deg, 1)}° / ${fmt((pitch * 180) / Math.PI, 1)}°`);

      const vel = player.velocity;
      if (vel && vel.length >= 3) {
        const speed = Math.hypot(vel[0], vel[2]);
        setText(f.velocity, `${fmt(speed, 2)} B/s  (Y ${fmt(vel[1], 2)})`);
      } else {
        setText(f.velocity, '—');
      }

      this._updateWorldSamples(bx, by, bz);
    } else {
      setText(f.xyz, '—');
      setText(f.block, '—');
      setText(f.chunk, '—');
      setText(f.section, '—');
      setText(f.facing, '—');
      setText(f.velocity, '—');
      setText(f.biome, '—');
      setText(f.light, '—');
    }

    this._updateTarget();
    this._updateEnvironment();
  }

  /**
   * Biome and light readings for the block the player stands in.
   * @param {number} bx block X
   * @param {number} by block Y
   * @param {number} bz block Z
   * @returns {void}
   * @private
   */
  _updateWorldSamples(bx, by, bz) {
    const f = this._f;
    const world = this.game && this.game.world;
    if (!world) {
      setText(f.biome, '—');
      setText(f.light, '—');
      return;
    }

    if (typeof world.getBiome === 'function') {
      const id = world.getBiome(bx, bz) | 0;
      const biome = getBiome(id);
      setText(f.biome, `${biome.display}  (#${id})`);
    } else {
      setText(f.biome, '—');
    }

    let sky = 0;
    const rgb = this._rgb;
    rgb[0] = 0;
    rgb[1] = 0;
    rgb[2] = 0;
    const eyeY = by + 1;
    if (typeof world.getSkyLight === 'function') sky = world.getSkyLight(bx, eyeY, bz) | 0;
    if (typeof world.getBlockLight === 'function') world.getBlockLight(bx, eyeY, bz, rgb);
    const block = Math.max(rgb[0], rgb[1], rgb[2]);
    setText(f.light, `Himmel ${sky} · Block ${block}  (${rgb[0]},${rgb[1]},${rgb[2]})`);

    const color = `rgb(${Math.round((rgb[0] / 15) * 255)},${Math.round((rgb[1] / 15) * 255)},`
      + `${Math.round((rgb[2] / 15) * 255)})`;
    if (color !== this._lightColor) {
      this._lightColor = color;
      this._lightSwatch.style.setProperty('background', color);
    }
  }

  /**
   * The block the player is looking at, taken from `game/interaction.js` and
   * falling back to a fresh raycast when the interaction system is absent.
   * @returns {void}
   * @private
   */
  _updateTarget() {
    const f = this._f;
    const game = this.game;
    let hit = game && game.interaction ? game.interaction.hit : null;

    if ((hit === null || hit === undefined) && game && game.world && game.player
      && typeof game.world.raycast === 'function'
      && typeof game.player.getEyePosition === 'function'
      && typeof game.player.getLookDirection === 'function') {
      try {
        hit = game.world.raycast(game.player.getEyePosition(), game.player.getLookDirection(), 6);
      } catch (err) {
        warnOnce('raycast', 'raycast() failed; the target readout is disabled.', err);
        hit = null;
      }
    }

    if (hit === null || hit === undefined) {
      setText(f.target, 'nichts');
      setText(f.targetPos, '—');
      setText(f.targetFace, '—');
      return;
    }
    const def = getBlock(hit.blockId | 0);
    setText(f.target, `${def.display}  (#${hit.blockId | 0})`);
    setText(f.targetPos, `${hit.x} ${hit.y} ${hit.z}  ${fmt(hit.dist, 2)} B`);
    setText(f.targetFace, faceName(hit.faceNormal));
  }

  /**
   * Weather, day, clock, moon phase and the world seed.
   * @returns {void}
   * @private
   */
  _updateEnvironment() {
    const f = this._f;
    const game = this.game;
    const env = game && game.environment;
    const world = game && game.world;

    if (env) {
      const weather = WEATHER_LABELS[env.weather] || String(env.weather || '—');
      const rain = Number.isFinite(env.rainStrength) ? env.rainStrength : 0;
      const thunder = Number.isFinite(env.thunderStrength) ? env.thunderStrength : 0;
      setText(f.weather, rain > 0.001 || thunder > 0.001
        ? `${weather}  (Regen ${fmt(rain, 2)} · Donner ${fmt(thunder, 2)})`
        : weather);
      setText(f.day, `${Number.isFinite(env.dayCount) ? env.dayCount | 0 : 0}`);
      const phase = typeof env.getPhase === 'function' ? env.getPhase() : '';
      const clock = typeof env.getClockString === 'function' ? env.getClockString() : '—';
      const phaseLabel = PHASE_LABELS[phase] || '';
      setText(f.clock, phaseLabel ? `${clock}  (${phaseLabel})` : clock);
      const moon = Number.isFinite(env.moonPhase) ? env.moonPhase | 0 : 0;
      setText(f.moon, `${MOON_LABELS[moon & 7]}  (${moon})`);
    } else {
      setText(f.weather, '—');
      setText(f.day, '—');
      setText(f.clock, '—');
      setText(f.moon, '—');
    }

    const seed = world && Number.isFinite(world.seed) ? world.seed : null;
    setText(f.seed, seed === null ? '—' : String(seed));
  }

  /**
   * Refresh the right column: renderer counters, GPU passes, chunk streaming
   * and system memory.
   * @returns {void}
   * @private
   */
  _updateRight() {
    const f = this._f;
    const game = this.game;
    const renderer = game && game.renderer;
    const stats = renderer && renderer.stats;

    if (stats) {
      setText(f.res, `${stats.width | 0} x ${stats.height | 0}`);
      setText(f.scale, `${fmt(stats.renderScale, 2)}x`);
      setText(f.draws, fmtInt(stats.drawCalls));
      setText(f.tris, fmtInt(stats.triangles));
      setText(f.sections, fmtInt(stats.sections));
      setText(f.particles, fmtInt(stats.particles));
    } else {
      setText(f.res, '—');
      setText(f.scale, '—');
      setText(f.draws, '—');
      setText(f.tris, '—');
      setText(f.sections, '—');
      setText(f.particles, '—');
    }

    const entities = game && game.entities;
    let live = null;
    if (entities && entities.entities && Number.isFinite(entities.entities.size)) {
      live = entities.entities.size;
    } else if (stats && Number.isFinite(stats.entities)) {
      live = stats.entities;
    }
    const drawn = stats && Number.isFinite(stats.entities) ? stats.entities : null;
    setText(f.entities, live === null
      ? '—'
      : `${fmtInt(live)}${drawn === null ? '' : `  (${fmtInt(drawn)} sichtbar)`}`);

    this._updatePasses(stats);

    const world = game && game.world;
    if (world && typeof world.getStats === 'function') {
      let ws = null;
      try {
        ws = world.getStats();
      } catch (err) {
        warnOnce('worldstats', 'world.getStats() failed.', err);
        ws = null;
      }
      if (ws !== null) {
        setText(f.loaded, fmtInt(ws.loaded));
        setText(f.meshing, fmtInt(ws.meshing));
        setText(f.queued, fmtInt(ws.queued));
        setText(f.generating, fmtInt(ws.generating));
        setText(f.lightQueue, fmtInt(ws.lightQueue));
        setText(f.workers, fmtInt(ws.workers));
        setText(f.chunkMem, `${fmt(ws.memoryMB, 1)} MB`);
      }
    } else {
      setText(f.loaded, '—');
      setText(f.meshing, '—');
      setText(f.queued, '—');
      setText(f.generating, '—');
      setText(f.lightQueue, '—');
      setText(f.workers, '—');
      setText(f.chunkMem, '—');
    }

    const mem = typeof performance !== 'undefined' ? performance.memory : undefined;
    if (mem && Number.isFinite(mem.usedJSHeapSize)) {
      const used = mem.usedJSHeapSize / 1048576;
      const total = mem.totalJSHeapSize / 1048576;
      const limit = mem.jsHeapSizeLimit / 1048576;
      setText(f.heap, `${fmt(used, 0)} / ${fmt(total, 0)} MB  (max ${fmt(limit, 0)})`);
    } else {
      setText(f.heap, 'nicht verfügbar');
    }

    const gl = game && game.gl;
    const caps = gl && gl.caps;
    setText(f.gpu, caps && typeof caps.rendererName === 'string' ? caps.rendererName : '—');
  }

  /**
   * Mirror `renderer.stats.passes` into the pass rows, creating the rows the
   * first time a pass reports a timing.
   * @param {?Object} stats the renderer statistics block
   * @returns {void}
   * @private
   */
  _updatePasses(stats) {
    const passes = stats && stats.passes;
    if (!passes) {
      if (this._passKeys !== 'none') {
        this._passKeys = 'none';
        this._passBox.textContent = '';
        this._passRows = Object.create(null);
        const row = el('div', 'vx-dbg__row');
        row.appendChild(el('span', 'vx-dbg__k', 'Zeitmessung'));
        row.appendChild(el('span', 'vx-dbg__v', 'nicht verfügbar'));
        this._passBox.appendChild(row);
      }
      return;
    }

    /** @type {string[]} */
    const keys = [];
    for (let i = 0; i < PASS_ORDER.length; i++) {
      if (Number.isFinite(passes[PASS_ORDER[i]])) keys.push(PASS_ORDER[i]);
    }
    for (const key of Object.keys(passes)) {
      if (keys.indexOf(key) === -1 && Number.isFinite(passes[key])) keys.push(key);
    }

    const signature = keys.join(',');
    if (signature !== this._passKeys) {
      this._passKeys = signature;
      this._passBox.textContent = '';
      this._passRows = Object.create(null);
      if (keys.length === 0) {
        const row = el('div', 'vx-dbg__row');
        row.appendChild(el('span', 'vx-dbg__k', 'Zeitmessung'));
        row.appendChild(el('span', 'vx-dbg__v', 'nicht verfügbar'));
        this._passBox.appendChild(row);
      }
      for (let i = 0; i < keys.length; i++) {
        const row = el('div', 'vx-dbg__row');
        row.appendChild(el('span', 'vx-dbg__k', PASS_LABELS_DE[keys[i]] || keys[i]));
        const value = el('span', 'vx-dbg__v', '—');
        row.appendChild(value);
        this._passBox.appendChild(row);
        this._passRows[keys[i]] = value;
      }
    }

    for (let i = 0; i < keys.length; i++) {
      setText(this._passRows[keys[i]], `${fmt(passes[keys[i]], 2)} ms`);
    }
  }
}

export default DebugOverlay;
