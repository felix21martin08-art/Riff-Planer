/**
 * VOXELIA — immediate-mode debug geometry and performance overlay (spec 5.27).
 *
 * `DebugRenderer` is a tiny, always-compiled visual debugger:
 *
 * * an **immediate-mode line renderer** — call {@link DebugRenderer#drawLine},
 *   {@link DebugRenderer#drawAABB}, {@link DebugRenderer#drawRay} … from
 *   anywhere during the frame, then {@link DebugRenderer#render} flushes every
 *   queued line through **one dynamic VBO in one draw call**;
 * * `F3+G`-style **chunk / section borders** around the camera;
 * * a **GPU-drawn frame-time graph** ({@link DebugRenderer#renderOverlay})
 *   fed by {@link DebugRenderer#pushFrameTime}.
 *
 * Everything is off by default and every feature can be toggled individually
 * with {@link DebugRenderer#setEnabled}, so the class is cheap enough to leave
 * compiled into a release build: with nothing enabled a frame costs one boolean
 * test and zero GL calls.
 *
 * ### Render target contract
 *
 * The shaders write **one** colour output (`layout(location = 0)`), so draw
 * into a single-attachment target — the HDR scene buffer or the default
 * framebuffer — never into the multi-attachment G-buffer (attachments 1..3
 * would receive undefined values). Lines are alpha-blended, depth-tested
 * against whatever depth buffer is attached and never write depth.
 *
 * World-space lines apply `u_jitter.xy` exactly like every other geometry pass,
 * so they stay rock-steady under TAA. The screen-space overlay does not.
 *
 * @module render/debug
 */

import { CHUNK_SIZE, SECTION_SIZE, WORLD_MIN_Y, WORLD_HEIGHT } from '../world/chunk.js';
import { RingBuffer } from '../core/util.js';
import { clamp } from '../core/math.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Frame UBO binding point (ARCHITECTURE.md 3.3). @type {number} */
export const FRAME_UBO_BINDING = 0;

/** Floats per debug vertex: `vec3 position` + `vec4 color`. @type {number} */
export const DEBUG_VERTEX_FLOATS = 7;

/** Bytes per debug vertex. @type {number} */
export const DEBUG_VERTEX_BYTES = DEBUG_VERTEX_FLOATS * 4;

/** Initial vertex capacity of the dynamic VBO. @type {number} */
const INITIAL_VERTICES = 8192;

/** Hard upper bound on the vertex capacity (~7 MB of line data). @type {number} */
const MAX_VERTICES = 262144;

/** Samples kept in the frame-time ring buffer. @type {number} */
export const FRAME_TIME_SAMPLES = 128;

/** Default colour for lines drawn without one. @type {ReadonlyArray<number>} */
const DEFAULT_COLOR = Object.freeze([1, 1, 1, 1]);

/**
 * The twelve edges of a box, as pairs of corner indices where bit 0 = x1,
 * bit 1 = y1, bit 2 = z1.
 * @type {ReadonlyArray<ReadonlyArray<number>>}
 */
const BOX_EDGES = Object.freeze([
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
]);

/** Toggleable features and their default state. @type {Readonly<Object>} */
export const DEBUG_FEATURES = Object.freeze({
  lines: true,
  aabb: true,
  chunkBorders: false,
  graph: false,
});

/** Colour of the camera chunk's vertical edges. @type {ReadonlyArray<number>} */
const CHUNK_EDGE_COLOR = Object.freeze([1.0, 0.92, 0.25, 0.95]);

/** Colour of the 1-block grid painted on the chunk walls. @type {ReadonlyArray<number>} */
const CHUNK_GRID_COLOR = Object.freeze([0.25, 0.62, 1.0, 0.40]);

/** Colour of the 16-block section separators. @type {ReadonlyArray<number>} */
const SECTION_COLOR = Object.freeze([0.35, 1.0, 0.55, 0.55]);

/** Colour of the neighbouring chunk footprints. @type {ReadonlyArray<number>} */
const NEIGHBOUR_COLOR = Object.freeze([0.55, 0.55, 0.62, 0.32]);

/* -------------------------------------------------------------------------- */
/* Shaders                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Debug vertex shader.
 *
 * `u_screenSpace == 0` transforms `a_position` with the frame's view-projection
 * (plus the TAA jitter, so debug geometry is temporally stable);
 * `u_screenSpace == 1` treats `a_position.xy` as normalized device coordinates
 * and ignores the camera entirely.
 * @type {string}
 */
const DEBUG_VS = `
#include <frame>

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;

uniform int u_screenSpace;
uniform float u_gain;
uniform float u_depthBias;

out vec4 v_color;

void main() {
  v_color = vec4(a_color.rgb * max(u_gain, 0.0), a_color.a);
  if (u_screenSpace == 1) {
    gl_Position = vec4(a_position.xy, 0.0, 1.0);
    return;
  }
  vec4 clip = u_viewProj * vec4(a_position, 1.0);
  clip.xy += u_jitter.xy * clip.w;
  // Pull the line a hair toward the camera so it survives the z-fight against
  // the face it outlines (WebGL2 has no polygon offset for GL_LINES).
  clip.z -= u_depthBias * clip.w;
  gl_Position = clip;
}
`;

/**
 * Debug fragment shader: a single straight colour write.
 * @type {string}
 */
const DEBUG_FS = `
in vec4 v_color;

layout(location = 0) out vec4 o_color;

void main() {
  o_color = v_color;
}
`;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read a colour from an array-like, falling back to opaque white.
 * @param {ArrayLike<number>|null|undefined} c Source colour `[r,g,b]` or `[r,g,b,a]`.
 * @param {number[]} out Receiver `[r,g,b,a]`.
 * @returns {number[]} `out`.
 */
function readColor(c, out) {
  if (c && typeof c.length === 'number' && c.length >= 3) {
    out[0] = Number(c[0]) || 0;
    out[1] = Number(c[1]) || 0;
    out[2] = Number(c[2]) || 0;
    out[3] = c.length > 3 && Number.isFinite(c[3]) ? c[3] : 1;
  } else {
    out[0] = DEFAULT_COLOR[0];
    out[1] = DEFAULT_COLOR[1];
    out[2] = DEFAULT_COLOR[2];
    out[3] = DEFAULT_COLOR[3];
  }
  return out;
}

/**
 * Read component `i` of a vector that may be an array or an `{x,y,z}` object.
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null} v Source vector.
 * @param {number} i Component index, 0..2.
 * @returns {number} The component, or 0.
 */
function comp(v, i) {
  if (!v) return 0;
  if (typeof v.length === 'number') return Number(v[i]) || 0;
  const key = i === 0 ? 'x' : (i === 1 ? 'y' : 'z');
  return Number(v[key]) || 0;
}

/* -------------------------------------------------------------------------- */
/* DebugRenderer                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Immediate-mode debug line renderer and performance overlay.
 *
 * ```js
 * const debug = new DebugRenderer(gl, settings);
 * debug.setEnabled('chunkBorders', true);
 * // ... during the frame:
 * debug.drawAABB(player.aabb, [0, 1, 0]);
 * debug.drawChunkBorders(world, camera.position);
 * // ... after the deferred composite, into the HDR scene target:
 * debug.render(frame);
 * // ... after post-processing, into the default framebuffer:
 * debug.pushFrameTime(frameMs);
 * debug.renderOverlay(frame);
 * ```
 */
export class DebugRenderer {
  /**
   * @param {import('../core/gl.js').GL} gl VOXELIA WebGL2 device.
   * @param {?{get:function(string):*}} [settings] Settings store (optional).
   */
  constructor(gl, settings) {
    /** @type {import('../core/gl.js').GL} Owning device. */
    this.device = gl;
    /** @type {WebGL2RenderingContext} Raw context. */
    this.gl = gl.gl;
    /** @type {?Object} Settings store. */
    this.settings = settings || null;

    /** @type {boolean} Master switch; nothing is drawn while this is false. */
    this.enabled = false;

    /**
     * Per-feature switches, flipped with {@link DebugRenderer#setEnabled}.
     * @type {{lines:boolean, aabb:boolean, chunkBorders:boolean, graph:boolean}}
     */
    this.features = {
      lines: DEBUG_FEATURES.lines,
      aabb: DEBUG_FEATURES.aabb,
      chunkBorders: DEBUG_FEATURES.chunkBorders,
      graph: DEBUG_FEATURES.graph,
    };

    /** @type {number} Colour multiplier for HDR targets (lines are authored LDR). */
    this.gain = 1.0;
    /** @type {number} Clip-space depth bias that lifts lines off the surface. */
    this.depthBias = 0.00035;
    /** @type {number} Vertical half-extent of the chunk borders, in blocks. */
    this.chunkBorderHeight = 40;
    /** @type {number} Chebyshev radius (in chunks) of the neighbour footprints. */
    this.chunkBorderRadius = 1;

    /* ---- graph geometry (pixels) ---------------------------------------- */

    /** @type {number} Frame-time graph width in device pixels. */
    this.graphWidth = 236;
    /** @type {number} Frame-time graph height in device pixels. */
    this.graphHeight = 58;
    /** @type {number} Graph margin from the bottom-left corner, in pixels. */
    this.graphMargin = 10;
    /** @type {number} Frame time (ms) mapped to the full graph height. */
    this.graphScaleMs = 50;

    /* ---- GPU resources --------------------------------------------------- */

    /** @type {?Object} Line/overlay program. @private */
    this._program = null;
    /** @type {?WebGLBuffer} The one dynamic vertex buffer. @private */
    this._vbo = null;
    /** @type {?WebGLVertexArrayObject} Its vertex array. @private */
    this._vao = null;
    /** @type {number} Vertices the VBO can hold. @private */
    this._capacity = 0;

    /* ---- CPU staging ------------------------------------------------------ */

    /** @type {Float32Array} Interleaved staging buffer. @private */
    this._data = new Float32Array(INITIAL_VERTICES * DEBUG_VERTEX_FLOATS);
    /** @type {number} Vertices currently queued. @private */
    this._count = 0;
    /** @type {boolean} True once the queue overflowed (log once). @private */
    this._overflowed = false;

    /* ---- frame-time history ---------------------------------------------- */

    /**
     * Rolling frame-time history in milliseconds.
     * @type {import('../core/util.js').RingBuffer}
     */
    this.frameTimes = new RingBuffer(FRAME_TIME_SAMPLES, Float32Array);

    /* ---- target size ------------------------------------------------------ */

    /** @type {number} Target width in pixels (for the screen-space overlay). */
    this.width = Math.max(1, this.gl.drawingBufferWidth || 1);
    /** @type {number} Target height in pixels. */
    this.height = Math.max(1, this.gl.drawingBufferHeight || 1);

    /* ---- scratch (no per-frame allocation) -------------------------------- */

    /** @type {number[]} @private */
    this._color = [1, 1, 1, 1];
    /** @type {number[]} @private */
    this._corner = [0, 0, 0];
    /** @type {number[]} @private */
    this._boxMin = [0, 0, 0];
    /** @type {number[]} @private */
    this._boxMax = [0, 0, 0];

    /**
     * Live counters for the F3 overlay.
     * @type {{lines:number, vertices:number, drawCalls:number}}
     */
    this.stats = { lines: 0, vertices: 0, drawCalls: 0 };

    /** @type {boolean} True once a failure has been reported (log once). @private */
    this._failed = false;
    /** @type {boolean} @private */
    this._disposed = false;

    try {
      this._build();
    } catch (err) {
      this._fail(err);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Resources                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * Build the program and the initial buffer.
   * @returns {boolean} `true` when the renderer is usable.
   * @private
   */
  _build() {
    if (this._disposed) return false;
    if (!this._program) {
      this._program = this.device.createProgram('debug.lines', DEBUG_VS, DEBUG_FS);
      if (this._program && typeof this._program.ready === 'function') this._program.ready();
      if (!this._program || !this._program.program) {
        this._program = null;
        this._fail('program build failed');
        return false;
      }
      this._program.bindUBO('Frame', FRAME_UBO_BINDING);
    }
    return this._ensureCapacity(INITIAL_VERTICES);
  }

  /**
   * Grow the dynamic VBO (and the staging array) to hold `vertices` vertices.
   *
   * The VAO caches the buffer binding, so a new buffer always gets a new VAO.
   * @param {number} vertices Required vertex capacity.
   * @returns {boolean} `true` when the buffer can hold the request.
   * @private
   */
  _ensureCapacity(vertices) {
    if (this._disposed || this._failed) return false;
    const want = Math.max(INITIAL_VERTICES, vertices | 0);
    if (this._vbo && this._capacity >= want) return true;
    if (want > MAX_VERTICES) return false;

    let capacity = Math.max(INITIAL_VERTICES, this._capacity || INITIAL_VERTICES);
    while (capacity < want && capacity < MAX_VERTICES) capacity *= 2;
    capacity = Math.min(capacity, MAX_VERTICES);

    const gl = this.gl;
    const device = this.device;
    try {
      this._releaseBuffers();
      this._vbo = device.createBuffer(gl.ARRAY_BUFFER, capacity * DEBUG_VERTEX_BYTES, gl.DYNAMIC_DRAW);
      this._vao = device.createVertexArray({
        attributes: [
          {
            location: 0, buffer: this._vbo, size: 3, type: gl.FLOAT,
            normalized: false, integer: false, stride: DEBUG_VERTEX_BYTES, offset: 0,
          },
          {
            location: 1, buffer: this._vbo, size: 4, type: gl.FLOAT,
            normalized: false, integer: false, stride: DEBUG_VERTEX_BYTES, offset: 12,
          },
        ],
      });
      this._capacity = capacity;
      if (this._data.length < capacity * DEBUG_VERTEX_FLOATS) {
        const next = new Float32Array(capacity * DEBUG_VERTEX_FLOATS);
        next.set(this._data.subarray(0, Math.min(this._data.length, next.length)));
        this._data = next;
      }
      return true;
    } catch (err) {
      this._fail(err);
      return false;
    }
  }

  /**
   * Delete the VBO and the VAO.
   * @returns {void}
   * @private
   */
  _releaseBuffers() {
    const gl = this.gl;
    if (this._vao) {
      try {
        this.device.bindVertexArray(null);
        gl.deleteVertexArray(this._vao);
      } catch (err) { /* already gone */ }
      this._vao = null;
    }
    if (this._vbo) {
      try { gl.deleteBuffer(this._vbo); } catch (err) { /* already gone */ }
      this._vbo = null;
    }
    this._capacity = 0;
  }

  /**
   * Disable the renderer after a failure, logging exactly once.
   * @param {*} err Error or message.
   * @returns {void}
   * @private
   */
  _fail(err) {
    if (this._failed) return;
    this._failed = true;
    console.error('[VOXELIA] debug: disabled after a failure.', err);
  }

  /* ----------------------------------------------------------------------- */
  /* Toggles                                                                  */
  /* ----------------------------------------------------------------------- */

  /**
   * Switch a feature (or the whole renderer) on or off.
   *
   * Known flags: `'all'` / `'enabled'` (the master switch), `'lines'`, `'aabb'`,
   * `'chunkBorders'`, `'graph'`. Enabling any individual feature also turns the
   * master switch on, which is what a debug overlay almost always means.
   *
   * @param {string} flag Feature name.
   * @param {boolean} [on] New state; omit to toggle.
   * @returns {boolean} The resulting state of that flag.
   */
  setEnabled(flag, on) {
    const key = String(flag || '').trim();
    if (key === 'all' || key === 'enabled' || key === '') {
      this.enabled = on === undefined ? !this.enabled : !!on;
      return this.enabled;
    }
    if (!(key in this.features)) return false;
    const next = on === undefined ? !this.features[key] : !!on;
    this.features[key] = next;
    if (next) this.enabled = true;
    return next;
  }

  /**
   * Query a feature switch.
   * @param {string} flag Feature name (see {@link DebugRenderer#setEnabled}).
   * @returns {boolean} `true` when the feature would draw this frame.
   */
  isEnabled(flag) {
    const key = String(flag || '').trim();
    if (key === 'all' || key === 'enabled' || key === '') return this.enabled;
    return this.enabled && !!this.features[key];
  }

  /**
   * Record the render-target size; only the screen-space overlay needs it.
   * @param {number} w Width in pixels.
   * @param {number} h Height in pixels.
   * @returns {void}
   */
  resize(w, h) {
    this.width = Math.max(1, w | 0);
    this.height = Math.max(1, h | 0);
  }

  /* ----------------------------------------------------------------------- */
  /* Immediate-mode geometry                                                  */
  /* ----------------------------------------------------------------------- */

  /**
   * Drop every queued line. Called automatically at the end of
   * {@link DebugRenderer#render}.
   * @returns {void}
   */
  clear() {
    this._count = 0;
  }

  /**
   * Append one vertex to the queue.
   * @param {number} x World (or NDC) x.
   * @param {number} y World (or NDC) y.
   * @param {number} z World z (ignored in screen space).
   * @param {number[]} c Colour `[r,g,b,a]`.
   * @returns {void}
   * @private
   */
  _push(x, y, z, c) {
    if (this._count + 1 > this._capacity && !this._ensureCapacity(this._count + 64)) {
      if (!this._overflowed) {
        this._overflowed = true;
        console.warn(`[VOXELIA] debug: line buffer full at ${MAX_VERTICES} vertices; extra geometry dropped.`);
      }
      return;
    }
    const d = this._data;
    let o = this._count * DEBUG_VERTEX_FLOATS;
    d[o++] = x; d[o++] = y; d[o++] = z;
    d[o++] = c[0]; d[o++] = c[1]; d[o++] = c[2]; d[o] = c[3];
    this._count++;
  }

  /**
   * Queue a world-space line segment.
   * @param {ArrayLike<number>|{x:number,y:number,z:number}} a Start point.
   * @param {ArrayLike<number>|{x:number,y:number,z:number}} b End point.
   * @param {ArrayLike<number>} [color] Linear rgb(a), default opaque white.
   * @returns {void}
   */
  drawLine(a, b, color) {
    if (!this.enabled || !this.features.lines || this._failed || !a || !b) return;
    const c = readColor(color, this._color);
    this._push(comp(a, 0), comp(a, 1), comp(a, 2), c);
    this._push(comp(b, 0), comp(b, 1), comp(b, 2), c);
  }

  /**
   * Queue a world-space line from six raw numbers (allocation free).
   * @param {number} x0 Start x.
   * @param {number} y0 Start y.
   * @param {number} z0 Start z.
   * @param {number} x1 End x.
   * @param {number} y1 End y.
   * @param {number} z1 End z.
   * @param {ArrayLike<number>} [color] Linear rgb(a).
   * @returns {void}
   */
  drawSegment(x0, y0, z0, x1, y1, z1, color) {
    if (!this.enabled || !this.features.lines || this._failed) return;
    const c = readColor(color, this._color);
    this._push(x0, y0, z0, c);
    this._push(x1, y1, z1, c);
  }

  /**
   * Queue the twelve edges of an axis-aligned box.
   * @param {number} x0 Minimum x.
   * @param {number} y0 Minimum y.
   * @param {number} z0 Minimum z.
   * @param {number} x1 Maximum x.
   * @param {number} y1 Maximum y.
   * @param {number} z1 Maximum z.
   * @param {ArrayLike<number>} [color] Linear rgb(a).
   * @returns {void}
   */
  drawBox(x0, y0, z0, x1, y1, z1, color) {
    if (!this.enabled || !this.features.aabb || this._failed) return;
    const c = readColor(color, this._color);
    const mn = this._boxMin;
    const mx = this._boxMax;
    mn[0] = Math.min(x0, x1); mn[1] = Math.min(y0, y1); mn[2] = Math.min(z0, z1);
    mx[0] = Math.max(x0, x1); mx[1] = Math.max(y0, y1); mx[2] = Math.max(z0, z1);
    for (let e = 0; e < BOX_EDGES.length; e++) {
      const edge = BOX_EDGES[e];
      for (let k = 0; k < 2; k++) {
        const i = edge[k];
        this._push(
          (i & 1) ? mx[0] : mn[0],
          (i & 2) ? mx[1] : mn[1],
          (i & 4) ? mx[2] : mn[2],
          c);
      }
    }
  }

  /**
   * Queue the wireframe of an AABB.
   *
   * Accepts a `core/math.js` {@link AABB} instance, a flat
   * `[minX,minY,minZ,maxX,maxY,maxZ]` array, or an object with `min`/`max`
   * vectors.
   *
   * @param {Object|ArrayLike<number>} aabb The box.
   * @param {ArrayLike<number>} [color] Linear rgb(a).
   * @returns {void}
   */
  drawAABB(aabb, color) {
    if (!this.enabled || !this.features.aabb || this._failed || !aabb) return;
    if (typeof aabb.length === 'number' && aabb.length >= 6) {
      this.drawBox(aabb[0], aabb[1], aabb[2], aabb[3], aabb[4], aabb[5], color);
      return;
    }
    if (Number.isFinite(aabb.minX) && Number.isFinite(aabb.maxX)) {
      this.drawBox(aabb.minX, aabb.minY, aabb.minZ, aabb.maxX, aabb.maxY, aabb.maxZ, color);
      return;
    }
    if (aabb.min && aabb.max) {
      this.drawBox(
        comp(aabb.min, 0), comp(aabb.min, 1), comp(aabb.min, 2),
        comp(aabb.max, 0), comp(aabb.max, 1), comp(aabb.max, 2), color);
    }
  }

  /**
   * Queue a ray as a line plus a small cross at its end.
   * @param {ArrayLike<number>} origin Ray origin.
   * @param {ArrayLike<number>} direction Ray direction (need not be normalized).
   * @param {number} [length=8] Length in blocks.
   * @param {ArrayLike<number>} [color] Linear rgb(a).
   * @returns {void}
   */
  drawRay(origin, direction, length = 8, color) {
    if (!this.enabled || !this.features.lines || this._failed || !origin || !direction) return;
    const ox = comp(origin, 0);
    const oy = comp(origin, 1);
    const oz = comp(origin, 2);
    let dx = comp(direction, 0);
    let dy = comp(direction, 1);
    let dz = comp(direction, 2);
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-8)) return;
    const scale = (Number.isFinite(length) ? length : 8) / len;
    dx *= scale; dy *= scale; dz *= scale;
    const c = readColor(color, this._color);
    this._push(ox, oy, oz, c);
    this._push(ox + dx, oy + dy, oz + dz, c);
    this._crossAt(ox + dx, oy + dy, oz + dz, 0.12, c);
  }

  /**
   * Queue a three-axis cross marker.
   * @param {ArrayLike<number>} p Centre point.
   * @param {number} [size=0.25] Half-extent in blocks.
   * @param {ArrayLike<number>} [color] Linear rgb(a).
   * @returns {void}
   */
  drawCross(p, size = 0.25, color) {
    if (!this.enabled || !this.features.lines || this._failed || !p) return;
    this._crossAt(comp(p, 0), comp(p, 1), comp(p, 2),
      Number.isFinite(size) ? size : 0.25, readColor(color, this._color));
  }

  /**
   * Append a three-axis cross (internal, colour already resolved).
   * @param {number} x Centre x.
   * @param {number} y Centre y.
   * @param {number} z Centre z.
   * @param {number} s Half-extent.
   * @param {number[]} c Colour `[r,g,b,a]`.
   * @returns {void}
   * @private
   */
  _crossAt(x, y, z, s, c) {
    this._push(x - s, y, z, c); this._push(x + s, y, z, c);
    this._push(x, y - s, z, c); this._push(x, y + s, z, c);
    this._push(x, y, z - s, c); this._push(x, y, z + s, c);
  }

  /**
   * Queue Minecraft-style chunk and section borders around the camera.
   *
   * Draws, for the chunk the camera stands in: the four vertical corner edges,
   * a one-block grid on the four chunk walls, and the 16-block section
   * separators — all clipped to `±chunkBorderHeight` around the camera so the
   * 384-block world column never floods the line buffer. Neighbouring chunks
   * within {@link DebugRenderer#chunkBorderRadius} get a plain footprint.
   *
   * @param {?Object} world Chunk manager; only `isLoaded(cx,cz)` is used, and
   *        only when present.
   * @param {ArrayLike<number>} cameraPos World-space camera position.
   * @returns {void}
   */
  drawChunkBorders(world, cameraPos) {
    if (!this.enabled || !this.features.chunkBorders || this._failed) return;
    if (!cameraPos) return;

    const px = comp(cameraPos, 0);
    const py = comp(cameraPos, 1);
    const pz = comp(cameraPos, 2);

    const cx = Math.floor(px / CHUNK_SIZE);
    const cz = Math.floor(pz / CHUNK_SIZE);
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const x1 = x0 + CHUNK_SIZE;
    const z1 = z0 + CHUNK_SIZE;

    const worldTop = WORLD_MIN_Y + WORLD_HEIGHT;
    const half = Math.max(8, this.chunkBorderHeight);
    const y0 = Math.max(WORLD_MIN_Y, Math.floor(py - half));
    const y1 = Math.min(worldTop, Math.ceil(py + half));
    if (!(y1 > y0)) return;

    const edge = CHUNK_EDGE_COLOR;
    const grid = CHUNK_GRID_COLOR;
    const section = SECTION_COLOR;

    // --- the four vertical corner edges, full visible column ---------------
    this.drawSegment(x0, y0, z0, x0, y1, z0, edge);
    this.drawSegment(x1, y0, z0, x1, y1, z0, edge);
    this.drawSegment(x0, y0, z1, x0, y1, z1, edge);
    this.drawSegment(x1, y0, z1, x1, y1, z1, edge);

    // --- one-block grid on the four chunk walls ---------------------------
    for (let i = 1; i < CHUNK_SIZE; i++) {
      const x = x0 + i;
      const z = z0 + i;
      this.drawSegment(x, y0, z0, x, y1, z0, grid);
      this.drawSegment(x, y0, z1, x, y1, z1, grid);
      this.drawSegment(x0, y0, z, x0, y1, z, grid);
      this.drawSegment(x1, y0, z, x1, y1, z, grid);
    }

    // --- horizontal rings every 2 blocks, section separators every 16 -----
    const firstY = Math.ceil(y0 / 2) * 2;
    for (let y = firstY; y <= y1; y += 2) {
      const isSection = ((y - WORLD_MIN_Y) % SECTION_SIZE) === 0;
      const c = isSection ? section : grid;
      this.drawSegment(x0, y, z0, x1, y, z0, c);
      this.drawSegment(x0, y, z1, x1, y, z1, c);
      this.drawSegment(x0, y, z0, x0, y, z1, c);
      this.drawSegment(x1, y, z0, x1, y, z1, c);
    }

    // --- neighbouring chunk footprints at the camera height ---------------
    const radius = Math.max(0, this.chunkBorderRadius | 0);
    if (radius <= 0) return;
    const fy = Math.floor(py);
    const loaded = world && typeof world.isLoaded === 'function' ? world : null;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dz === 0) continue;
        const ncx = cx + dx;
        const ncz = cz + dz;
        let ok = true;
        if (loaded) {
          try { ok = !!loaded.isLoaded(ncx, ncz); } catch (err) { ok = true; }
        }
        if (!ok) continue;
        const nx0 = ncx * CHUNK_SIZE;
        const nz0 = ncz * CHUNK_SIZE;
        const nx1 = nx0 + CHUNK_SIZE;
        const nz1 = nz0 + CHUNK_SIZE;
        this.drawSegment(nx0, fy, nz0, nx1, fy, nz0, NEIGHBOUR_COLOR);
        this.drawSegment(nx1, fy, nz0, nx1, fy, nz1, NEIGHBOUR_COLOR);
        this.drawSegment(nx1, fy, nz1, nx0, fy, nz1, NEIGHBOUR_COLOR);
        this.drawSegment(nx0, fy, nz1, nx0, fy, nz0, NEIGHBOUR_COLOR);
      }
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Frame-time history                                                       */
  /* ----------------------------------------------------------------------- */

  /**
   * Append a frame time to the graph history.
   * @param {number} ms Frame duration in milliseconds.
   * @returns {void}
   */
  pushFrameTime(ms) {
    if (!Number.isFinite(ms)) return;
    this.frameTimes.push(Math.max(0, ms));
  }

  /* ----------------------------------------------------------------------- */
  /* Drawing                                                                  */
  /* ----------------------------------------------------------------------- */

  /**
   * Upload the staged vertices and issue one draw call.
   * @param {number} count Vertex count.
   * @param {number} mode `gl.LINES` or `gl.TRIANGLES`.
   * @param {boolean} screenSpace Draw in NDC instead of world space.
   * @param {boolean} depthTest Depth-test the geometry.
   * @param {number} gain Colour multiplier.
   * @returns {boolean} `true` when the draw was issued.
   * @private
   */
  _flush(count, mode, screenSpace, depthTest, gain) {
    if (count <= 0 || this._failed || this._disposed) return false;
    const program = this._program;
    if (!program || !this._vbo || !this._vao) return false;
    if (!program.use()) return false;

    const device = this.device;
    const gl = this.gl;
    try {
      device.updateBuffer(this._vbo, gl.ARRAY_BUFFER,
        this._data.subarray(0, count * DEBUG_VERTEX_FLOATS), 0);

      program.bindUBO('Frame', FRAME_UBO_BINDING);
      program.setInt('u_screenSpace', screenSpace ? 1 : 0);
      program.setFloat('u_gain', gain);
      program.setFloat('u_depthBias', screenSpace ? 0 : this.depthBias);

      device.setScissor(false);
      device.setDepthTest(!!depthTest);
      if (depthTest) device.setDepthFunc(gl.LEQUAL);
      device.setDepthWrite(false);
      device.setBlend('alpha');
      device.setCull('none');
      device.setColorMask(true, true, true, true);

      device.bindVertexArray(this._vao);
      gl.drawArrays(mode, 0, count);
      this.stats.drawCalls++;
      return true;
    } catch (err) {
      this._fail(err);
      return false;
    } finally {
      try {
        this.device.bindVertexArray(null);
        this.device.setBlend('none');
        this.device.setDepthWrite(true);
      } catch (err) { /* context lost */ }
    }
  }

  /**
   * Flush every queued line into the currently bound single-attachment target.
   *
   * The queue is emptied afterwards, so this is safe to call once per frame
   * regardless of how much geometry was pushed.
   *
   * @param {Object} [frame] The render frame (unused today; kept for the spec
   *        signature and for future per-frame options).
   * @param {{depthTest?:boolean, gain?:number}} [options] Draw options —
   *        `depthTest:false` puts the lines on top of everything.
   * @returns {number} Draw calls issued (0 or 1).
   */
  render(frame, options) {
    this.stats.drawCalls = 0;
    this.stats.vertices = this._count;
    this.stats.lines = this._count >> 1;
    if (!this.enabled || this._failed || this._disposed) {
      this._count = 0;
      return 0;
    }
    const count = this._count;
    if (count < 2) {
      this._count = 0;
      return 0;
    }
    const depthTest = !options || options.depthTest !== false;
    const gain = options && Number.isFinite(options.gain) ? options.gain : this.gain;
    const drawn = this._flush(count, this.gl.LINES, false, depthTest, gain) ? 1 : 0;
    this._count = 0;
    return drawn;
  }

  /**
   * Draw the frame-time graph into the currently bound target.
   *
   * Screen space, no depth test — call this **after** post-processing, with the
   * default framebuffer bound, so the tonemapper cannot touch it.
   *
   * The graph is a bar chart of {@link DebugRenderer#frameTimes}: green below
   * 16.7 ms, amber below 33.3 ms, red above, over a translucent panel with
   * reference lines at 60 and 30 fps.
   *
   * @param {Object} [frame] The render frame (unused; spec symmetry).
   * @returns {number} Draw calls issued (0 or 1).
   */
  renderOverlay(frame) {
    if (!this.enabled || !this.features.graph || this._failed || this._disposed) return 0;
    const samples = this.frameTimes.length;
    if (samples <= 0) return 0;

    const needed = (samples + 8) * 6;
    if (!this._ensureCapacity(needed)) return 0;

    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);
    const gw = Math.min(this.graphWidth, w - 2 * this.graphMargin);
    const gh = Math.min(this.graphHeight, h - 2 * this.graphMargin);
    if (!(gw > 8) || !(gh > 8)) return 0;

    const left = this.graphMargin;
    const bottom = this.graphMargin;
    const toNdcX = (px) => (px / w) * 2 - 1;
    const toNdcY = (py) => (py / h) * 2 - 1;

    // Rebuild from scratch: renderOverlay runs after render() emptied the queue.
    this._count = 0;
    const c = this._color;

    /* ---- panel ----------------------------------------------------------- */
    c[0] = 0.02; c[1] = 0.03; c[2] = 0.05; c[3] = 0.62;
    this._quad(toNdcX(left - 3), toNdcY(bottom - 3),
      toNdcX(left + gw + 3), toNdcY(bottom + gh + 3), c);

    /* ---- reference lines ------------------------------------------------- */
    const scale = Math.max(1, this.graphScaleMs);
    const yFor = (ms) => bottom + clamp(ms / scale, 0, 1) * gh;
    c[0] = 0.35; c[1] = 0.85; c[2] = 0.45; c[3] = 0.45;
    let ry = yFor(1000 / 60);
    this._quad(toNdcX(left), toNdcY(ry), toNdcX(left + gw), toNdcY(ry + 1), c);
    c[0] = 0.95; c[1] = 0.72; c[2] = 0.25; c[3] = 0.40;
    ry = yFor(1000 / 30);
    this._quad(toNdcX(left), toNdcY(ry), toNdcX(left + gw), toNdcY(ry + 1), c);

    /* ---- bars ------------------------------------------------------------ */
    const barW = gw / samples;
    for (let i = 0; i < samples; i++) {
      const ms = this.frameTimes.get(i);
      const t = clamp(ms / scale, 0, 1);
      const bh = Math.max(1, t * gh);
      if (ms <= 1000 / 60) { c[0] = 0.30; c[1] = 0.92; c[2] = 0.48; }
      else if (ms <= 1000 / 30) { c[0] = 0.98; c[1] = 0.78; c[2] = 0.26; }
      else { c[0] = 1.0; c[1] = 0.30; c[2] = 0.28; }
      c[3] = 0.9;
      const bx = left + i * barW;
      this._quad(toNdcX(bx), toNdcY(bottom),
        toNdcX(bx + Math.max(barW - 0.5, 0.5)), toNdcY(bottom + bh), c);
    }

    const drawn = this._flush(this._count, this.gl.TRIANGLES, true, false, 1) ? 1 : 0;
    this._count = 0;
    return drawn;
  }

  /**
   * Append a screen-space quad as two triangles.
   * @param {number} x0 Left in NDC.
   * @param {number} y0 Bottom in NDC.
   * @param {number} x1 Right in NDC.
   * @param {number} y1 Top in NDC.
   * @param {number[]} c Colour `[r,g,b,a]`.
   * @returns {void}
   * @private
   */
  _quad(x0, y0, x1, y1, c) {
    this._push(x0, y0, 0, c);
    this._push(x1, y0, 0, c);
    this._push(x1, y1, 0, c);
    this._push(x0, y0, 0, c);
    this._push(x1, y1, 0, c);
    this._push(x0, y1, 0, c);
  }

  /* ----------------------------------------------------------------------- */
  /* Teardown                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * Release every GPU resource. Safe to call more than once.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._releaseBuffers();
    if (this._program && typeof this._program.dispose === 'function') {
      try { this._program.dispose(); } catch (err) { /* already gone */ }
    }
    this._program = null;
    this._count = 0;
    this.frameTimes.clear();
  }
}

export default DebugRenderer;
