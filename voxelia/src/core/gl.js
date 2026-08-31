/**
 * VOXELIA — WebGL2 device wrapper.
 *
 * Owns the `WebGL2RenderingContext`, the GLSL `#include` preprocessor, program /
 * buffer / VAO / texture / framebuffer / UBO creation, a redundancy-eliminating
 * GL state cache, GPU timer queries and the fullscreen-triangle helper.
 *
 * Every other render module builds on top of this file. Shader sources passed to
 * {@link GL#createProgram} must NOT contain `#version` — the device prepends
 * `#version 300 es`, the precision qualifiers and any `options.defines`.
 *
 * @module core/gl
 */

/**
 * Vertex shader source for a fullscreen (oversized) triangle.
 *
 * Attribute-less: the three vertices are derived from `gl_VertexID`, so no VBO
 * and no VAO attributes are required. Provides `out vec2 v_uv` with (0,0) at the
 * bottom-left of the screen and (1,1) at the top-right.
 *
 * Do not prepend `#version` — {@link GL#createProgram} does that.
 * @type {string}
 */
export const FULLSCREEN_VS = `out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Maximum `#include` nesting depth before the preprocessor bails out. @type {number} */
const MAX_INCLUDE_DEPTH = 16;

/** Value returned by `getUniformBlockIndex` for an unknown block. @type {number} */
const INVALID_INDEX = 0xffffffff;

/** Precision qualifier block injected into every shader (highp everywhere). @type {string} */
const PRECISION_BLOCK = [
  'precision highp float;',
  'precision highp int;',
  'precision highp sampler2D;',
  'precision highp sampler3D;',
  'precision highp samplerCube;',
  'precision highp sampler2DArray;',
  'precision highp sampler2DShadow;',
  'precision highp sampler2DArrayShadow;',
  'precision highp isampler2D;',
  'precision highp usampler2D;',
  'precision highp isampler2DArray;',
  'precision highp usampler2DArray;',
].join('\n');

/**
 * A compiled + linked shader program with cached uniform locations.
 *
 * A program whose compilation or link failed degrades into a harmless no-op:
 * `program` becomes `null`, `use()` returns false and every setter does nothing.
 * Nothing in this class ever throws, so a broken shader can never kill a frame.
 */
class Program {
  /**
   * @param {GL} device owning device
   * @param {string} name debug name
   * @param {WebGLProgram|null} program linked (or linking) GL program
   * @param {{vs:?{shader:WebGLShader,source:string,stage:string},
   *          fs:?{shader:WebGLShader,source:string,stage:string}}|null} pending
   *        shaders whose status has not been queried yet (deferred link check)
   */
  constructor(device, name, program, pending) {
    /** @type {string} */
    this.name = name;
    /** @type {WebGLProgram|null} */
    this.program = program;
    /** @type {GL} */
    this._device = device;
    this._pending = pending;
    /** @type {Map<string, WebGLUniformLocation|null>} */
    this._uniforms = new Map();
    /** @type {Map<string, number>} */
    this._blocks = new Map();
    /** @type {Map<string, number>} */
    this._blockBindings = new Map();
    /** @type {Map<string, number>} */
    this._scalars = new Map();
    /** @type {Map<string, number>} */
    this._attribs = new Map();
  }

  /**
   * Resolve the deferred compile/link status, reporting errors with line numbers.
   * @returns {boolean} true when the program is usable
   */
  _finalize() {
    const pending = this._pending;
    if (!pending) return this.program !== null;
    this._pending = null;
    const device = this._device;
    const gl = device.gl;
    const prog = this.program;
    let ok = true;
    for (const rec of [pending.vs, pending.fs]) {
      if (!rec) continue;
      if (!gl.getShaderParameter(rec.shader, gl.COMPILE_STATUS)) {
        ok = false;
        console.error(device._formatShaderError(this.name, rec.stage, rec.source,
          gl.getShaderInfoLog(rec.shader) || '(no info log)'));
      }
    }
    if (ok && prog && !gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      ok = false;
      console.error(`[GL] program "${this.name}" failed to link:\n${gl.getProgramInfoLog(prog) || '(no info log)'}`);
      if (pending.vs) console.error(device._numberSource(`${this.name}.vert`, pending.vs.source));
      if (pending.fs) console.error(device._numberSource(`${this.name}.frag`, pending.fs.source));
    }
    for (const rec of [pending.vs, pending.fs]) {
      if (!rec) continue;
      if (prog) gl.detachShader(prog, rec.shader);
      gl.deleteShader(rec.shader);
    }
    if (!ok) {
      if (prog) gl.deleteProgram(prog);
      this.program = null;
      if (device.brokenPrograms.indexOf(this.name) < 0) device.brokenPrograms.push(this.name);
    }
    return ok;
  }

  /**
   * Non-blocking readiness probe (uses KHR_parallel_shader_compile when present).
   * @returns {boolean} true when the program finished compiling and is usable
   */
  ready() {
    if (!this._pending) return this.program !== null;
    const ext = this._device.ext.parallelShaderCompile;
    if (ext && this.program &&
        !this._device.gl.getProgramParameter(this.program, ext.COMPLETION_STATUS_KHR)) return false;
    return this._finalize();
  }

  /**
   * Make this program current (state-cached).
   * @returns {boolean} false when the program is broken
   */
  use() {
    if (this._pending) this._finalize();
    if (!this.program) return false;
    this._device.useProgram(this.program);
    return true;
  }

  /**
   * Look up (and cache) a uniform location.
   * @param {string} name uniform name
   * @returns {WebGLUniformLocation|null} null when the uniform does not exist
   */
  uniform(name) {
    if (this._pending) this._finalize();
    if (!this.program) return null;
    let loc = this._uniforms.get(name);
    if (loc === undefined) {
      loc = this._device.gl.getUniformLocation(this.program, name);
      this._uniforms.set(name, loc);
    }
    return loc;
  }

  /**
   * Look up (and cache) a vertex attribute location.
   * @param {string} name attribute name
   * @returns {number} -1 when the attribute does not exist
   */
  attrib(name) {
    if (this._pending) this._finalize();
    if (!this.program) return -1;
    let loc = this._attribs.get(name);
    if (loc === undefined) {
      loc = this._device.gl.getAttribLocation(this.program, name);
      this._attribs.set(name, loc);
    }
    return loc;
  }

  /**
   * @param {string} name uniform name
   * @param {number} v integer value
   * @returns {void}
   */
  setInt(name, v) {
    const loc = this.uniform(name);
    if (loc === null) return;
    const iv = v | 0;
    if (this._scalars.get(name) === iv) return;
    this.use();
    this._device.gl.uniform1i(loc, iv);
    this._scalars.set(name, iv);
  }

  /**
   * @param {string} name uniform name
   * @param {boolean|number} v boolean value
   * @returns {void}
   */
  setBool(name, v) { this.setInt(name, v ? 1 : 0); }

  /**
   * @param {string} name uniform name
   * @param {number} v float value
   * @returns {void}
   */
  setFloat(name, v) {
    const loc = this.uniform(name);
    if (loc === null) return;
    if (this._scalars.get(name) === v) return;
    this.use();
    this._device.gl.uniform1f(loc, v);
    this._scalars.set(name, v);
  }

  /**
   * @param {string} name uniform name
   * @param {number|ArrayLike<number>} x x component, or an array of 2 values
   * @param {number} [y] y component
   * @returns {void}
   */
  setVec2(name, x, y) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    if (typeof x === 'number') this._device.gl.uniform2f(loc, x, y);
    else this._device.gl.uniform2f(loc, x[0], x[1]);
  }

  /**
   * @param {string} name uniform name
   * @param {number|ArrayLike<number>} x x component, or an array of 3 values
   * @param {number} [y] y component
   * @param {number} [z] z component
   * @returns {void}
   */
  setVec3(name, x, y, z) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    if (typeof x === 'number') this._device.gl.uniform3f(loc, x, y, z);
    else this._device.gl.uniform3f(loc, x[0], x[1], x[2]);
  }

  /**
   * @param {string} name uniform name
   * @param {number|ArrayLike<number>} x x component, or an array of 4 values
   * @param {number} [y] y component
   * @param {number} [z] z component
   * @param {number} [w] w component
   * @returns {void}
   */
  setVec4(name, x, y, z, w) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    if (typeof x === 'number') this._device.gl.uniform4f(loc, x, y, z, w);
    else this._device.gl.uniform4f(loc, x[0], x[1], x[2], x[3]);
  }

  /**
   * @param {string} name uniform name
   * @param {number|ArrayLike<number>} x x component, or an array of 2 values
   * @param {number} [y] y component
   * @returns {void}
   */
  setIVec2(name, x, y) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    if (typeof x === 'number') this._device.gl.uniform2i(loc, x | 0, y | 0);
    else this._device.gl.uniform2i(loc, x[0] | 0, x[1] | 0);
  }

  /**
   * @param {string} name uniform name
   * @param {number|ArrayLike<number>} x x component, or an array of 3 values
   * @param {number} [y] y component
   * @param {number} [z] z component
   * @returns {void}
   */
  setIVec3(name, x, y, z) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    if (typeof x === 'number') this._device.gl.uniform3i(loc, x | 0, y | 0, z | 0);
    else this._device.gl.uniform3i(loc, x[0] | 0, x[1] | 0, x[2] | 0);
  }

  /**
   * @param {string} name uniform name
   * @param {ArrayLike<number>} m 16 floats, column-major
   * @returns {void}
   */
  setMat4(name, m) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    this._device.gl.uniformMatrix4fv(loc, false, m);
  }

  /**
   * @param {string} name uniform name
   * @param {ArrayLike<number>} m 9 floats, column-major
   * @returns {void}
   */
  setMat3(name, m) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    this._device.gl.uniformMatrix3fv(loc, false, m);
  }

  /**
   * @param {string} name uniform array name (e.g. `u_kernel[0]`)
   * @param {ArrayLike<number>} data flat float data
   * @returns {void}
   */
  setFloatArray(name, data) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    this._device.gl.uniform1fv(loc, data);
  }

  /**
   * @param {string} name uniform array name
   * @param {ArrayLike<number>} data flat float data, 2 per element
   * @returns {void}
   */
  setVec2Array(name, data) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    this._device.gl.uniform2fv(loc, data);
  }

  /**
   * @param {string} name uniform array name
   * @param {ArrayLike<number>} data flat float data, 3 per element
   * @returns {void}
   */
  setVec3Array(name, data) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    this._device.gl.uniform3fv(loc, data);
  }

  /**
   * @param {string} name uniform array name
   * @param {ArrayLike<number>} data flat float data, 4 per element
   * @returns {void}
   */
  setVec4Array(name, data) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    this._device.gl.uniform4fv(loc, data);
  }

  /**
   * @param {string} name uniform array name
   * @param {ArrayLike<number>} data flat float data, 16 per matrix, column-major
   * @returns {void}
   */
  setMat4Array(name, data) {
    const loc = this.uniform(name);
    if (loc === null) return;
    this.use();
    this._device.gl.uniformMatrix4fv(loc, false, data);
  }

  /**
   * Bind a texture to a unit and point the sampler uniform at that unit.
   * @param {string} name sampler uniform name
   * @param {WebGLTexture|null} texture texture to bind
   * @param {number} unit texture unit index
   * @param {number} [target=gl.TEXTURE_2D] texture target
   * @returns {void}
   */
  setTexture(name, texture, unit, target) {
    const loc = this.uniform(name);
    const device = this._device;
    const gl = device.gl;
    const tgt = target === undefined ? gl.TEXTURE_2D : target;
    if (loc === null) return;
    device.bindTexture(unit | 0, tgt, texture || null);
    this.use();
    if (this._scalars.get(name) !== (unit | 0)) {
      gl.uniform1i(loc, unit | 0);
      this._scalars.set(name, unit | 0);
    }
  }

  /**
   * Bind a named uniform block to a UBO binding point.
   * @param {string} blockName std140 block name (e.g. `'Frame'`)
   * @param {number} bindingPoint binding point index
   * @returns {boolean} false when the block does not exist in this program
   */
  bindUBO(blockName, bindingPoint) {
    if (this._pending) this._finalize();
    if (!this.program) return false;
    let index = this._blocks.get(blockName);
    if (index === undefined) {
      index = this._device.gl.getUniformBlockIndex(this.program, blockName);
      this._blocks.set(blockName, index);
    }
    if (index === INVALID_INDEX) return false;
    if (this._blockBindings.get(blockName) === bindingPoint) return true;
    this._device.gl.uniformBlockBinding(this.program, index, bindingPoint | 0);
    this._blockBindings.set(blockName, bindingPoint | 0);
    return true;
  }

  /**
   * Delete the GL program and drop every cache.
   * @returns {void}
   */
  dispose() {
    const gl = this._device.gl;
    if (this._pending) {
      for (const rec of [this._pending.vs, this._pending.fs]) {
        if (rec) gl.deleteShader(rec.shader);
      }
      this._pending = null;
    }
    if (this.program) {
      if (this._device._state.program === this.program) {
        gl.useProgram(null);
        this._device._state.program = null;
      }
      gl.deleteProgram(this.program);
      this.program = null;
    }
    this._uniforms.clear();
    this._blocks.clear();
    this._blockBindings.clear();
    this._scalars.clear();
    this._attribs.clear();
  }
}

/**
 * WebGL2 device: context, shader includes, resource factories and state cache.
 */
export class GL {
  /**
   * @param {HTMLCanvasElement|OffscreenCanvas} canvas target canvas
   * @param {Object} [opts={}] extra context attributes merged over the defaults
   */
  constructor(canvas, opts = {}) {
    /** @type {HTMLCanvasElement|OffscreenCanvas} */
    this.canvas = canvas;

    const attribs = Object.assign({
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true,
      failIfMajorPerformanceCaveat: false,
    }, opts);

    /** @type {WebGL2RenderingContext} */
    const gl = canvas && typeof canvas.getContext === 'function'
      ? canvas.getContext('webgl2', attribs)
      : null;
    if (!gl) {
      throw new Error(
        'VOXELIA requires WebGL2. This browser or device did not provide a "webgl2" context. ' +
        'Update your browser, enable hardware acceleration, or check that WebGL is not blocked.');
    }
    this.gl = gl;

    /**
     * Loaded WebGL extensions (null when unsupported).
     * @type {{colorBufferFloat:?Object, textureFloatLinear:?Object, anisotropic:?Object,
     *         timerQuery:?Object, debugRendererInfo:?Object, parallelShaderCompile:?Object,
     *         floatBlend:?Object}}
     */
    this.ext = {
      colorBufferFloat: gl.getExtension('EXT_color_buffer_float'),
      textureFloatLinear: gl.getExtension('OES_texture_float_linear'),
      anisotropic: gl.getExtension('EXT_texture_filter_anisotropic'),
      timerQuery: gl.getExtension('EXT_disjoint_timer_query_webgl2'),
      debugRendererInfo: gl.getExtension('WEBGL_debug_renderer_info'),
      parallelShaderCompile: gl.getExtension('KHR_parallel_shader_compile'),
      floatBlend: gl.getExtension('EXT_float_blend'),
    };

    let rendererName = 'unknown';
    let vendorName = 'unknown';
    try {
      const dri = this.ext.debugRendererInfo;
      rendererName = String(dri ? gl.getParameter(dri.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      vendorName = String(dri ? gl.getParameter(dri.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
    } catch (e) {
      rendererName = 'unknown';
    }

    /**
     * Device capabilities.
     * @type {{maxAniso:number, maxTexSize:number, maxLayers:number, maxDrawBuffers:number,
     *         timerQuery:boolean, floatBlend:boolean, rendererName:string, vendorName:string,
     *         colorBufferFloat:boolean, textureFloatLinear:boolean, anisotropy:boolean,
     *         max3DTexSize:number, maxRenderbufferSize:number, maxTextureUnits:number,
     *         maxVertexTextureUnits:number, maxUniformBufferBindings:number,
     *         maxUniformBlockSize:number, uboOffsetAlignment:number, parallelCompile:boolean}}
     */
    this.caps = {
      maxAniso: this.ext.anisotropic ? gl.getParameter(this.ext.anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1,
      maxTexSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
      timerQuery: !!this.ext.timerQuery,
      floatBlend: !!this.ext.floatBlend,
      rendererName,
      vendorName,
      colorBufferFloat: !!this.ext.colorBufferFloat,
      textureFloatLinear: !!this.ext.textureFloatLinear,
      anisotropy: !!this.ext.anisotropic,
      max3DTexSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      maxVertexTextureUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      maxUniformBufferBindings: gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS),
      maxUniformBlockSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE),
      uboOffsetAlignment: gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT),
      parallelCompile: !!this.ext.parallelShaderCompile,
    };

    /**
     * Registered GLSL chunks addressable via `#include <name>`.
     * @type {Map<string,string>}
     */
    this.includes = new Map();

    /** Names of programs that failed to build. @type {string[]} */
    this.brokenPrograms = [];

    /** Render scale multiplier applied on top of devicePixelRatio. @type {number} */
    this.renderScale = 1;

    // ---- state cache ------------------------------------------------------
    const unitCount = Math.max(16, this.caps.maxTextureUnits | 0);
    this._texUnits = new Array(unitCount);
    for (let i = 0; i < unitCount; i++) this._texUnits[i] = new Map();
    this._state = {
      program: null,
      vao: null,
      fbo: null,
      arrayBuffer: null,
      uniformBuffer: null,
      activeUnit: -1,
      vx: -1, vy: -1, vw: -1, vh: -1,
      sx: -1, sy: -1, sw: -1, sh: -1,
      scissor: null,
      depthTest: null,
      depthWrite: null,
      depthFunc: null,
      cull: null,
      blend: null,
      cr: null, cg: null, cb: null, ca: null,
      clearR: -1, clearG: -1, clearB: -1, clearA: -1,
      clearDepth: -1,
      clearStencil: -1,
    };
    /** @type {Array<WebGLBuffer|null>} */
    this._uboBindings = new Array(Math.max(8, this.caps.maxUniformBufferBindings | 0)).fill(null);

    // ---- fullscreen triangle ---------------------------------------------
    this._fullscreenVAO = null;

    // ---- GPU timers -------------------------------------------------------
    this._queryPool = [];
    this._pendingQueries = [];
    this._activeQuery = null;
    this._timerDepth = 0;
    this._timerFrame = 0;
    /** @type {Object<string, number>} */
    this._timings = Object.create(null);

    // ---- lookup tables ----------------------------------------------------
    this._texFormats = buildFormatTable(gl);
    this._intFormats = buildIntegerFormatSet(gl);
    this._depthFormats = buildDepthFormatSet(gl);
    this._fbStatus = new Map([
      [gl.FRAMEBUFFER_COMPLETE, 'FRAMEBUFFER_COMPLETE'],
      [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT, 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT (an attachment is unusable with this format)'],
      [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT, 'FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT (no attachments)'],
      [gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS, 'FRAMEBUFFER_INCOMPLETE_DIMENSIONS (attachments differ in size)'],
      [gl.FRAMEBUFFER_UNSUPPORTED, 'FRAMEBUFFER_UNSUPPORTED (format combination not renderable)'],
      [gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE, 'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE (sample count mismatch)'],
    ]);

    // Sensible starting state.
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.invalidateState();
  }

  // =========================================================================
  // GLSL includes & preprocessing
  // =========================================================================

  /**
   * Register (or replace) a GLSL chunk addressable as `#include <name>`.
   * @param {string} name chunk name
   * @param {string} source GLSL source without `#version`
   * @returns {void}
   */
  registerInclude(name, source) {
    this.includes.set(String(name), String(source));
  }

  /**
   * Recursively expand `#include <name>` / `#include "name"` directives.
   *
   * Includes are resolved at most once per compilation (implicit `#pragma once`),
   * so chunks may safely declare their own dependencies. Cycles and excessive
   * nesting are reported and replaced with a comment instead of throwing.
   *
   * @param {string} src source text
   * @param {number} depth current recursion depth
   * @param {Set<string>} included names already expanded in this compilation
   * @param {string[]} stack include stack, for cycle detection
   * @returns {string} fully expanded source
   */
  _resolveIncludes(src, depth, included, stack) {
    if (depth >= MAX_INCLUDE_DEPTH) {
      console.warn(`[GL] #include nesting exceeded ${MAX_INCLUDE_DEPTH} levels (${stack.join(' -> ')}); stopped expanding.`);
      return src;
    }
    // A fresh RegExp per call: String.replace mutates lastIndex on global regexes
    // and this function re-enters itself from inside the replacer.
    const re = /^[ \t]*#[ \t]*include[ \t]+[<"]([^>"\n]+)[>"][ \t]*$/gm;
    return src.replace(re, (match, rawName) => {
      const name = rawName.trim();
      if (stack.indexOf(name) >= 0) {
        console.warn(`[GL] circular #include <${name}> (${stack.concat(name).join(' -> ')})`);
        return `// [gl] circular include <${name}> dropped`;
      }
      if (included.has(name)) return `// [gl] include <${name}> already expanded`;
      const chunk = this.includes.get(name);
      if (chunk === undefined) {
        console.warn(`[GL] unknown #include <${name}> — registered chunks: ${[...this.includes.keys()].join(', ')}`);
        return `// [gl] missing include <${name}>`;
      }
      included.add(name);
      stack.push(name);
      const body = this._resolveIncludes(stripVersion(chunk), depth + 1, included, stack);
      stack.pop();
      return `// ---- begin include <${name}> ----\n${body}\n// ---- end include <${name}> ----`;
    });
  }

  /**
   * Build the final shader source: version, extensions, precision, defines, body.
   * @param {'vertex'|'fragment'} stage shader stage
   * @param {string} source user source (no `#version`)
   * @param {{defines?:Object<string,(string|number|boolean)>, extensions?:string[]}} options build options
   * @returns {string} complete GLSL ES 3.00 source
   */
  _buildSource(stage, source, options) {
    const parts = ['#version 300 es'];
    if (Array.isArray(options.extensions)) {
      for (const e of options.extensions) parts.push(`#extension ${e} : enable`);
    }
    parts.push(PRECISION_BLOCK);
    parts.push('#define VOXELIA 1');
    parts.push(stage === 'vertex' ? '#define STAGE_VERTEX 1' : '#define STAGE_FRAGMENT 1');
    const defines = options.defines;
    if (defines) {
      for (const key of Object.keys(defines)) {
        const value = defines[key];
        if (value === false || value === null || value === undefined) continue;
        parts.push(value === true ? `#define ${key} 1` : `#define ${key} ${value}`);
      }
    }
    parts.push(this._resolveIncludes(stripVersion(String(source)), 0, new Set(), []));
    parts.push('');
    return parts.join('\n');
  }

  /**
   * Render a source listing with 1-based line numbers.
   * @param {string} label heading
   * @param {string} source source text
   * @returns {string} numbered listing
   */
  _numberSource(label, source) {
    const lines = source.split('\n');
    const width = String(lines.length).length;
    const out = [`[GL] ---- ${label} (${lines.length} lines) ----`];
    for (let i = 0; i < lines.length; i++) {
      out.push(`${String(i + 1).padStart(width, ' ')} | ${lines[i]}`);
    }
    return out.join('\n');
  }

  /**
   * Format a shader compile failure with the offending lines highlighted.
   * @param {string} programName program debug name
   * @param {string} stage `'vertex'` or `'fragment'`
   * @param {string} source fully preprocessed source
   * @param {string} log driver info log
   * @returns {string} human readable report
   */
  _formatShaderError(programName, stage, source, log) {
    const lines = source.split('\n');
    const out = [`[GL] ${stage} shader of program "${programName}" failed to compile:`];
    for (const entry of log.split('\n')) {
      const text = entry.trim();
      if (!text) continue;
      out.push('  ' + text);
      const m = text.match(/^\w+\s*:\s*\d+\s*:\s*(\d+)/);
      if (!m) continue;
      const ln = Number(m[1]);
      const from = Math.max(1, ln - 3);
      const to = Math.min(lines.length, ln + 3);
      for (let i = from; i <= to; i++) {
        out.push(`    ${i === ln ? '>>' : '  '} ${String(i).padStart(5, ' ')} | ${lines[i - 1]}`);
      }
    }
    out.push(this._numberSource(`${programName}.${stage === 'vertex' ? 'vert' : 'frag'}`, source));
    return out.join('\n');
  }

  // =========================================================================
  // Programs
  // =========================================================================

  /**
   * Compile and link a program. Never throws: on failure the returned program is
   * an inert stub whose `use()` is a no-op and whose setters do nothing.
   *
   * @param {string} name debug name (used in error messages)
   * @param {string} vsSource vertex shader source without `#version`
   * @param {?string} fsSource fragment shader source without `#version`
   *        (null builds a trivial pass-through for transform-feedback programs)
   * @param {{defines?:Object<string,(string|number|boolean)>, feedback?:string[],
   *          transform?:boolean, extensions?:string[],
   *          attribs?:Object<string,number>}} [options={}] build options —
   *        `feedback` lists transform-feedback varyings, `transform` selects
   *        SEPARATE_ATTRIBS (true) over INTERLEAVED_ATTRIBS (false)
   * @returns {Program} program wrapper
   */
  createProgram(name, vsSource, fsSource, options = {}) {
    const gl = this.gl;
    const vsFull = this._buildSource('vertex', vsSource, options);
    const fsFull = this._buildSource('fragment', fsSource || 'void main() {}', options);

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsFull);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsFull);
    gl.compileShader(fs);

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);

    if (options.attribs) {
      for (const key of Object.keys(options.attribs)) {
        gl.bindAttribLocation(prog, options.attribs[key] | 0, key);
      }
    }
    if (Array.isArray(options.feedback) && options.feedback.length > 0) {
      gl.transformFeedbackVaryings(prog, options.feedback,
        options.transform ? gl.SEPARATE_ATTRIBS : gl.INTERLEAVED_ATTRIBS);
    }
    gl.linkProgram(prog);

    const program = new Program(this, name, prog, {
      vs: { shader: vs, source: vsFull, stage: 'vertex' },
      fs: { shader: fs, source: fsFull, stage: 'fragment' },
    });
    // Without parallel compile there is nothing to gain from deferring, and
    // immediate reporting is much friendlier during development.
    if (!this.ext.parallelShaderCompile) program._finalize();
    return program;
  }

  /**
   * Resolve every deferred program link so pending errors get reported.
   * @param {Program[]} programs programs to finalize
   * @returns {number} number of programs that are usable
   */
  flushPrograms(programs) {
    let ok = 0;
    for (const p of programs) {
      if (p && typeof p._finalize === 'function' && p._finalize()) ok++;
    }
    return ok;
  }

  /**
   * Make a raw GL program current (state-cached).
   * @param {WebGLProgram|null} program program object
   * @returns {void}
   */
  useProgram(program) {
    if (this._state.program === program) return;
    this.gl.useProgram(program);
    this._state.program = program;
  }

  // =========================================================================
  // Buffers & vertex arrays
  // =========================================================================

  /**
   * Create and fill a buffer object.
   * @param {number} target e.g. `gl.ARRAY_BUFFER`
   * @param {ArrayBufferView|ArrayBuffer|number} dataOrSize initial data or byte size
   * @param {number} [usage=gl.STATIC_DRAW] usage hint
   * @returns {WebGLBuffer} the new buffer
   */
  createBuffer(target, dataOrSize, usage) {
    const gl = this.gl;
    const use = usage === undefined ? gl.STATIC_DRAW : usage;
    // ELEMENT_ARRAY_BUFFER binding is VAO state — never touch a foreign VAO.
    if (target === gl.ELEMENT_ARRAY_BUFFER) this.bindVertexArray(null);
    const buffer = gl.createBuffer();
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, dataOrSize, use);
    if (target === gl.ARRAY_BUFFER) this._state.arrayBuffer = buffer;
    else if (target === gl.UNIFORM_BUFFER) this._state.uniformBuffer = buffer;
    return buffer;
  }

  /**
   * Upload data into an existing buffer.
   * @param {WebGLBuffer} buffer target buffer
   * @param {number} target e.g. `gl.ARRAY_BUFFER`
   * @param {ArrayBufferView|ArrayBuffer} data source data
   * @param {number} [offset=0] destination byte offset
   * @returns {void}
   */
  updateBuffer(buffer, target, data, offset = 0) {
    const gl = this.gl;
    if (target === gl.ELEMENT_ARRAY_BUFFER) this.bindVertexArray(null);
    gl.bindBuffer(target, buffer);
    gl.bufferSubData(target, offset, data);
    if (target === gl.ARRAY_BUFFER) this._state.arrayBuffer = buffer;
    else if (target === gl.UNIFORM_BUFFER) this._state.uniformBuffer = buffer;
  }

  /**
   * Build a vertex array object from an attribute spec.
   *
   * @param {{attributes:Array<{location:number, buffer:WebGLBuffer, size:number,
   *          type:number, normalized?:boolean, integer?:boolean, stride?:number,
   *          offset?:number, divisor?:number}>,
   *         indexBuffer?:WebGLBuffer, indexType?:number}} spec layout description
   * @returns {WebGLVertexArrayObject} the new VAO; `vao.indexType` carries the
   *          element type (defaults to `gl.UNSIGNED_INT`) for convenience
   */
  createVertexArray(spec) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    this.bindVertexArray(vao);
    const attributes = spec.attributes || [];
    for (let i = 0; i < attributes.length; i++) {
      const a = attributes[i];
      if (!a || a.location === undefined || a.location < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer);
      this._state.arrayBuffer = a.buffer;
      gl.enableVertexAttribArray(a.location);
      const stride = a.stride || 0;
      const offset = a.offset || 0;
      if (a.integer) gl.vertexAttribIPointer(a.location, a.size, a.type, stride, offset);
      else gl.vertexAttribPointer(a.location, a.size, a.type, !!a.normalized, stride, offset);
      if (a.divisor) gl.vertexAttribDivisor(a.location, a.divisor | 0);
    }
    if (spec.indexBuffer) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, spec.indexBuffer);
    this.bindVertexArray(null);
    vao.indexType = spec.indexType === undefined ? gl.UNSIGNED_INT : spec.indexType;
    return vao;
  }

  /**
   * Bind a vertex array object (state-cached).
   * @param {WebGLVertexArrayObject|null} vao vertex array, or null for none
   * @returns {void}
   */
  bindVertexArray(vao) {
    if (this._state.vao === vao) return;
    this.gl.bindVertexArray(vao);
    this._state.vao = vao;
  }

  // =========================================================================
  // Textures
  // =========================================================================

  /**
   * Create a texture. Storage is mutable (`texImage*`), so framebuffer resizes
   * can reallocate an attachment without invalidating the texture handle.
   *
   * The returned texture carries a `__vox` descriptor (target, size, formats,
   * filters, mips) that {@link GL#createFramebuffer} uses to resize attachments.
   *
   * @param {{target?:number, width:number, height:number, depth?:number,
   *          internalFormat?:number, format?:number, type?:number,
   *          data?:?ArrayBufferView, min?:number|string, mag?:number|string,
   *          wrap?:number|string|{s?:number|string,t?:number|string,r?:number|string},
   *          mips?:boolean, aniso?:number, compare?:boolean|number,
   *          baseLevel?:number, maxLevel?:number}} desc texture description
   * @returns {WebGLTexture} the new texture
   */
  createTexture(desc) {
    const gl = this.gl;
    const target = desc.target === undefined ? gl.TEXTURE_2D : desc.target;
    const internalFormat = desc.internalFormat === undefined ? gl.RGBA8 : desc.internalFormat;
    const info = this._texFormats.get(internalFormat) || { format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    const isDepth = this._depthFormats.has(internalFormat);
    const isInteger = this._intFormats.has(internalFormat);
    const filterable = !isDepth && !isInteger;
    const mips = !!desc.mips && filterable && target !== gl.TEXTURE_3D;

    const meta = {
      target,
      width: Math.max(1, desc.width | 0),
      height: Math.max(1, desc.height | 0),
      depth: Math.max(1, (desc.depth === undefined ? 1 : desc.depth) | 0),
      internalFormat,
      format: desc.format === undefined ? info.format : desc.format,
      type: desc.type === undefined ? info.type : desc.type,
      mips,
      data: desc.data || null,
    };

    const tex = gl.createTexture();
    tex.__vox = meta;
    this.bindTexture(0, target, tex);

    const defaultMin = filterable ? (mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR) : gl.NEAREST;
    const defaultMag = filterable ? gl.LINEAR : gl.NEAREST;
    const min = resolveFilter(gl, desc.min, defaultMin);
    const mag = resolveFilter(gl, desc.mag, defaultMag);
    const wrap = desc.wrap;
    let wrapS = gl.CLAMP_TO_EDGE;
    let wrapT = gl.CLAMP_TO_EDGE;
    let wrapR = gl.CLAMP_TO_EDGE;
    if (wrap !== undefined && wrap !== null) {
      if (typeof wrap === 'object') {
        wrapS = resolveWrap(gl, wrap.s, gl.CLAMP_TO_EDGE);
        wrapT = resolveWrap(gl, wrap.t, wrapS);
        wrapR = resolveWrap(gl, wrap.r, wrapS);
      } else {
        wrapS = wrapT = wrapR = resolveWrap(gl, wrap, gl.CLAMP_TO_EDGE);
      }
    }

    this._allocTexture(tex, meta);

    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrapT);
    if (target === gl.TEXTURE_3D || target === gl.TEXTURE_2D_ARRAY) {
      gl.texParameteri(target, gl.TEXTURE_WRAP_R, wrapR);
    }
    if (desc.baseLevel !== undefined) gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, desc.baseLevel | 0);
    if (desc.maxLevel !== undefined) gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, desc.maxLevel | 0);

    if (desc.compare) {
      gl.texParameteri(target, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(target, gl.TEXTURE_COMPARE_FUNC,
        typeof desc.compare === 'number' ? desc.compare : gl.LEQUAL);
    }

    const anisoExt = this.ext.anisotropic;
    if (anisoExt && desc.aniso && filterable) {
      const aniso = Math.max(1, Math.min(this.caps.maxAniso, desc.aniso));
      gl.texParameterf(target, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, aniso);
      meta.aniso = aniso;
    }

    if (mips) gl.generateMipmap(target);
    meta.data = null;
    meta.min = min;
    meta.mag = mag;
    return tex;
  }

  /**
   * (Re)allocate a texture's level-0 storage from its `__vox` descriptor.
   * @param {WebGLTexture} tex texture created by {@link GL#createTexture}
   * @param {Object} meta the texture's descriptor
   * @returns {void}
   */
  _allocTexture(tex, meta) {
    const gl = this.gl;
    this.bindTexture(0, meta.target, tex);
    if (meta.target === gl.TEXTURE_2D) {
      gl.texImage2D(meta.target, 0, meta.internalFormat, meta.width, meta.height, 0,
        meta.format, meta.type, meta.data || null);
    } else {
      gl.texImage3D(meta.target, 0, meta.internalFormat, meta.width, meta.height, meta.depth, 0,
        meta.format, meta.type, meta.data || null);
    }
  }

  /**
   * Regenerate the mip chain of a texture created by {@link GL#createTexture}.
   * @param {WebGLTexture} tex texture with mips enabled
   * @returns {void}
   */
  generateMipmap(tex) {
    const meta = tex && tex.__vox;
    if (!meta) return;
    this.bindTexture(0, meta.target, tex);
    this.gl.generateMipmap(meta.target);
  }

  /**
   * Bind a texture to a unit (state-cached).
   * @param {number} unit texture unit index
   * @param {number} target texture target
   * @param {WebGLTexture|null} texture texture or null
   * @returns {void}
   */
  bindTexture(unit, target, texture) {
    const units = this._texUnits;
    const u = unit | 0;
    if (u < 0 || u >= units.length) return;
    const slot = units[u];
    if (slot.get(target) === texture) return;
    if (this._state.activeUnit !== u) {
      this.gl.activeTexture(this.gl.TEXTURE0 + u);
      this._state.activeUnit = u;
    }
    this.gl.bindTexture(target, texture);
    slot.set(target, texture);
  }

  /**
   * Delete a texture and purge it from the binding cache.
   * @param {WebGLTexture|null} texture texture to delete
   * @returns {void}
   */
  deleteTexture(texture) {
    if (!texture) return;
    for (const slot of this._texUnits) {
      for (const [target, tex] of slot) if (tex === texture) slot.set(target, null);
    }
    this.gl.deleteTexture(texture);
  }

  // =========================================================================
  // Framebuffers
  // =========================================================================

  /**
   * Create a framebuffer with any number of color attachments plus an optional
   * depth texture or renderbuffer.
   *
   * @param {{color?:Array<WebGLTexture|{tex:WebGLTexture, level?:number, layer?:number}>,
   *          depth?:WebGLTexture|WebGLRenderbuffer|boolean|null,
   *          name?:string, width?:number, height?:number, ownTextures?:boolean}} desc description
   * @returns {{fbo:WebGLFramebuffer, color:WebGLTexture[], depth:(WebGLTexture|WebGLRenderbuffer|null),
   *            name:string, width:number, height:number, complete:boolean,
   *            bind:function():void, resize:function(number,number):boolean,
   *            setColorLayer:function(number,number):void, setDepthLayer:function(number):void,
   *            dispose:function():void}} framebuffer wrapper
   */
  createFramebuffer(desc) {
    const gl = this.gl;
    const device = this;
    const name = desc.name || 'framebuffer';
    const specs = (desc.color || []).map((c) => {
      if (c && c.tex !== undefined) {
        return { tex: c.tex, level: c.level ? c.level | 0 : 0, layer: c.layer === undefined ? -1 : c.layer | 0 };
      }
      return { tex: c, level: 0, layer: -1 };
    }).filter((s) => !!s.tex);

    let depthTex = null;
    let depthRb = null;
    let ownDepthRb = false;
    let depthLayer = -1;
    const d = desc.depth;
    if (d) {
      if (isRenderbuffer(d)) depthRb = d;
      else if (d === true) { depthRb = null; ownDepthRb = true; }
      else if (d && d.renderbuffer === true) { depthRb = null; ownDepthRb = true; }
      else depthTex = d;
    }

    let width = desc.width | 0;
    let height = desc.height | 0;
    if (!width || !height) {
      const ref = (specs[0] && specs[0].tex && specs[0].tex.__vox) || (depthTex && depthTex.__vox) || null;
      if (ref) { width = ref.width; height = ref.height; }
    }
    width = Math.max(1, width);
    height = Math.max(1, height);

    if (ownDepthRb) {
      depthRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }

    const fbo = gl.createFramebuffer();
    const wrapper = {
      fbo,
      name,
      color: specs.map((s) => s.tex),
      depth: depthTex || depthRb,
      width,
      height,
      complete: false,
      /**
       * Bind this framebuffer and set the viewport to its full size.
       * @returns {void}
       */
      bind() { device.bindFramebuffer(wrapper); },
      /**
       * Point a color attachment at a different array/3D layer.
       * @param {number} index color attachment index
       * @param {number} layer array layer or 3D slice
       * @returns {void}
       */
      setColorLayer(index, layer) {
        const spec = specs[index];
        if (!spec) return;
        spec.layer = layer | 0;
        device._bindFramebufferRaw(fbo);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, spec.tex, spec.level, spec.layer);
      },
      /**
       * Point the depth attachment at a different array layer.
       * @param {number} layer array layer
       * @returns {void}
       */
      setDepthLayer(layer) {
        if (!depthTex) return;
        depthLayer = layer | 0;
        device._bindFramebufferRaw(fbo);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, depthAttachmentPoint(gl, device, depthTex), depthTex, 0, depthLayer);
      },
      /**
       * Reallocate every attachment at a new size, keeping all formats.
       * @param {number} w new width in pixels
       * @param {number} h new height in pixels
       * @returns {boolean} true when a reallocation happened
       */
      resize(w, h) {
        const nw = Math.max(1, w | 0);
        const nh = Math.max(1, h | 0);
        if (nw === wrapper.width && nh === wrapper.height) return false;
        wrapper.width = nw;
        wrapper.height = nh;
        const seen = new Set();
        for (const spec of specs) {
          const meta = spec.tex && spec.tex.__vox;
          if (!meta || seen.has(spec.tex)) continue;
          seen.add(spec.tex);
          meta.width = nw;
          meta.height = nh;
          device._allocTexture(spec.tex, meta);
          if (meta.mips) device.generateMipmap(spec.tex);
        }
        if (depthTex && depthTex.__vox && !seen.has(depthTex)) {
          depthTex.__vox.width = nw;
          depthTex.__vox.height = nh;
          device._allocTexture(depthTex, depthTex.__vox);
        }
        if (depthRb) {
          gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
          gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, nw, nh);
          gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        }
        attach();
        return true;
      },
      /**
       * Delete the framebuffer (and any renderbuffer/textures it owns).
       * @returns {void}
       */
      dispose() {
        if (device._state.fbo === fbo) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          device._state.fbo = null;
        }
        gl.deleteFramebuffer(fbo);
        if (ownDepthRb && depthRb) gl.deleteRenderbuffer(depthRb);
        if (desc.ownTextures) {
          const seen = new Set();
          for (const spec of specs) {
            if (spec.tex && !seen.has(spec.tex)) { seen.add(spec.tex); device.deleteTexture(spec.tex); }
          }
          if (depthTex) device.deleteTexture(depthTex);
        }
        wrapper.complete = false;
      },
    };

    /**
     * (Re)attach every attachment and validate completeness.
     * @returns {void}
     */
    function attach() {
      device._bindFramebufferRaw(fbo);
      const buffers = [];
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        const meta = spec.tex.__vox;
        const point = gl.COLOR_ATTACHMENT0 + i;
        const layered = spec.layer >= 0 ||
          (meta && (meta.target === gl.TEXTURE_2D_ARRAY || meta.target === gl.TEXTURE_3D));
        if (layered) {
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, point, spec.tex, spec.level, Math.max(0, spec.layer));
        } else {
          gl.framebufferTexture2D(gl.FRAMEBUFFER, point, gl.TEXTURE_2D, spec.tex, spec.level);
        }
        buffers.push(point);
      }
      if (buffers.length > 0) {
        gl.drawBuffers(buffers);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
      } else {
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);
      }
      if (depthTex) {
        const point = depthAttachmentPoint(gl, device, depthTex);
        const meta = depthTex.__vox;
        if (depthLayer >= 0 || (meta && meta.target === gl.TEXTURE_2D_ARRAY)) {
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, point, depthTex, 0, Math.max(0, depthLayer));
        } else {
          gl.framebufferTexture2D(gl.FRAMEBUFFER, point, gl.TEXTURE_2D, depthTex, 0);
        }
      } else if (depthRb) {
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
      }
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      wrapper.complete = status === gl.FRAMEBUFFER_COMPLETE;
      if (!wrapper.complete) {
        const label = device._fbStatus.get(status) || `0x${status.toString(16)}`;
        console.error(`[GL] framebuffer "${name}" is incomplete: ${label} ` +
          `(${wrapper.width}x${wrapper.height}, ${specs.length} color attachment(s), ` +
          `depth=${depthTex ? 'texture' : depthRb ? 'renderbuffer' : 'none'})`);
      }
    }

    attach();
    return wrapper;
  }

  /**
   * Bind a framebuffer without touching the viewport (internal).
   * @param {WebGLFramebuffer|null} raw framebuffer object
   * @returns {void}
   */
  _bindFramebufferRaw(raw) {
    if (this._state.fbo === raw) return;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, raw);
    this._state.fbo = raw;
  }

  /**
   * Bind a framebuffer (wrapper, raw object or null for the default) and set the
   * viewport to cover it. Call {@link GL#setViewport} afterwards for sub-rects.
   * @param {?{fbo:WebGLFramebuffer,width:number,height:number}|WebGLFramebuffer} fboOrNull target
   * @returns {void}
   */
  bindFramebuffer(fboOrNull) {
    const gl = this.gl;
    if (!fboOrNull) {
      this._bindFramebufferRaw(null);
      this.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      return;
    }
    const raw = fboOrNull.fbo !== undefined ? fboOrNull.fbo : fboOrNull;
    this._bindFramebufferRaw(raw);
    if (fboOrNull.width && fboOrNull.height) this.setViewport(0, 0, fboOrNull.width, fboOrNull.height);
  }

  // =========================================================================
  // Uniform buffers
  // =========================================================================

  /**
   * Create a std140 uniform buffer bound to a fixed binding point.
   * @param {string} name debug name (also the expected GLSL block name)
   * @param {number} sizeBytes buffer size in bytes
   * @param {number} bindingPoint UBO binding point index
   * @returns {{buffer:WebGLBuffer, name:string, size:number, bindingPoint:number,
   *            bind:function():void, update:function(Float32Array, number=):void,
   *            dispose:function():void}} UBO handle
   */
  createUBO(name, sizeBytes, bindingPoint) {
    const gl = this.gl;
    const device = this;
    const size = Math.max(16, Math.ceil(sizeBytes / 16) * 16);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
    gl.bufferData(gl.UNIFORM_BUFFER, size, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, bindingPoint | 0, buffer);
    this._state.uniformBuffer = buffer;
    if ((bindingPoint | 0) < this._uboBindings.length) this._uboBindings[bindingPoint | 0] = buffer;
    return {
      buffer,
      name,
      size,
      bindingPoint: bindingPoint | 0,
      /**
       * Bind this UBO to its binding point (state-cached).
       * @returns {void}
       */
      bind() {
        const bp = bindingPoint | 0;
        if (bp < device._uboBindings.length && device._uboBindings[bp] === buffer) return;
        gl.bindBufferBase(gl.UNIFORM_BUFFER, bp, buffer);
        device._state.uniformBuffer = buffer;
        if (bp < device._uboBindings.length) device._uboBindings[bp] = buffer;
      },
      /**
       * Upload data into the buffer.
       * @param {Float32Array} data source data (must fit in `size` bytes)
       * @param {number} [offset=0] destination byte offset
       * @returns {void}
       */
      update(data, offset = 0) {
        gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
        device._state.uniformBuffer = buffer;
        gl.bufferSubData(gl.UNIFORM_BUFFER, offset, data);
      },
      /**
       * Delete the underlying buffer.
       * @returns {void}
       */
      dispose() {
        const bp = bindingPoint | 0;
        if (bp < device._uboBindings.length && device._uboBindings[bp] === buffer) device._uboBindings[bp] = null;
        if (device._state.uniformBuffer === buffer) device._state.uniformBuffer = null;
        gl.deleteBuffer(buffer);
      },
    };
  }

  // =========================================================================
  // State cache
  // =========================================================================

  /**
   * Drop every cached GL state value; the next setter call re-issues its command.
   * @returns {void}
   */
  invalidateState() {
    const s = this._state;
    s.program = undefined;
    s.vao = undefined;
    s.fbo = undefined;
    s.arrayBuffer = undefined;
    s.uniformBuffer = undefined;
    s.activeUnit = -1;
    s.vx = s.vy = s.vw = s.vh = -1;
    s.sx = s.sy = s.sw = s.sh = -1;
    s.scissor = null;
    s.depthTest = null;
    s.depthWrite = null;
    s.depthFunc = null;
    s.cull = null;
    s.blend = null;
    s.cr = s.cg = s.cb = s.ca = null;
    s.clearR = s.clearG = s.clearB = s.clearA = -1;
    s.clearDepth = -1;
    s.clearStencil = -1;
    for (const slot of this._texUnits) slot.clear();
    for (let i = 0; i < this._uboBindings.length; i++) this._uboBindings[i] = undefined;
  }

  /**
   * @param {number} x left in pixels
   * @param {number} y bottom in pixels
   * @param {number} w width in pixels
   * @param {number} h height in pixels
   * @returns {void}
   */
  setViewport(x, y, w, h) {
    const s = this._state;
    if (s.vx === x && s.vy === y && s.vw === w && s.vh === h) return;
    this.gl.viewport(x, y, w, h);
    s.vx = x; s.vy = y; s.vw = w; s.vh = h;
  }

  /**
   * @param {boolean} on enable the scissor test
   * @param {number} [x=0] left in pixels
   * @param {number} [y=0] bottom in pixels
   * @param {number} [w=0] width in pixels
   * @param {number} [h=0] height in pixels
   * @returns {void}
   */
  setScissor(on, x = 0, y = 0, w = 0, h = 0) {
    const gl = this.gl;
    const s = this._state;
    const enabled = !!on;
    if (s.scissor !== enabled) {
      if (enabled) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
      s.scissor = enabled;
    }
    if (!enabled) return;
    if (s.sx === x && s.sy === y && s.sw === w && s.sh === h) return;
    gl.scissor(x, y, w, h);
    s.sx = x; s.sy = y; s.sw = w; s.sh = h;
  }

  /**
   * @param {boolean} on enable depth testing
   * @returns {void}
   */
  setDepthTest(on) {
    const gl = this.gl;
    const s = this._state;
    const v = !!on;
    if (s.depthTest === v) return;
    if (v) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    s.depthTest = v;
  }

  /**
   * @param {boolean} on enable depth writes
   * @returns {void}
   */
  setDepthWrite(on) {
    const s = this._state;
    const v = !!on;
    if (s.depthWrite === v) return;
    this.gl.depthMask(v);
    s.depthWrite = v;
  }

  /**
   * @param {number} f depth comparison function (e.g. `gl.LEQUAL`)
   * @returns {void}
   */
  setDepthFunc(f) {
    const s = this._state;
    if (s.depthFunc === f) return;
    this.gl.depthFunc(f);
    s.depthFunc = f;
  }

  /**
   * @param {'back'|'front'|'none'} mode face culling mode
   * @returns {void}
   */
  setCull(mode) {
    const gl = this.gl;
    const s = this._state;
    if (s.cull === mode) return;
    if (mode === 'none') {
      gl.disable(gl.CULL_FACE);
    } else {
      if (s.cull === 'none' || s.cull === null || s.cull === undefined) gl.enable(gl.CULL_FACE);
      gl.cullFace(mode === 'front' ? gl.FRONT : gl.BACK);
    }
    s.cull = mode;
  }

  /**
   * @param {'none'|'alpha'|'add'|'premult'} mode blending mode
   * @returns {void}
   */
  setBlend(mode) {
    const gl = this.gl;
    const s = this._state;
    if (s.blend === mode) return;
    if (mode === 'none') {
      gl.disable(gl.BLEND);
    } else {
      if (s.blend === 'none' || s.blend === null || s.blend === undefined) gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      if (mode === 'alpha') {
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      } else if (mode === 'add') {
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
      } else {
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
    }
    s.blend = mode;
  }

  /**
   * @param {boolean} r write red
   * @param {boolean} g write green
   * @param {boolean} b write blue
   * @param {boolean} a write alpha
   * @returns {void}
   */
  setColorMask(r, g, b, a) {
    const s = this._state;
    const R = !!r, G = !!g, B = !!b, A = !!a;
    if (s.cr === R && s.cg === G && s.cb === B && s.ca === A) return;
    this.gl.colorMask(R, G, B, A);
    s.cr = R; s.cg = G; s.cb = B; s.ca = A;
  }

  /**
   * Clear the currently bound framebuffer.
   * Clearing color forces the color mask on; clearing depth forces depth writes
   * on (both are required by GL and both stay reflected in the state cache).
   *
   * @param {?ArrayLike<number>|boolean} [color=null] clear color `[r,g,b,a]`,
   *        `true` to reuse the current clear color, or null/false to skip
   * @param {boolean|number} [depth=false] `true` (clears to 1.0), a depth value, or false
   * @param {boolean|number} [stencil=false] `true` (clears to 0), a stencil value, or false
   * @returns {void}
   */
  clear(color = null, depth = false, stencil = false) {
    const gl = this.gl;
    const s = this._state;
    let mask = 0;
    if (color) {
      if (color !== true && color.length >= 3) {
        const r = color[0], g = color[1], b = color[2];
        const a = color.length > 3 ? color[3] : 1;
        if (s.clearR !== r || s.clearG !== g || s.clearB !== b || s.clearA !== a) {
          gl.clearColor(r, g, b, a);
          s.clearR = r; s.clearG = g; s.clearB = b; s.clearA = a;
        }
      }
      this.setColorMask(true, true, true, true);
      mask |= gl.COLOR_BUFFER_BIT;
    }
    if (depth !== false && depth !== null && depth !== undefined) {
      const value = depth === true ? 1 : depth;
      if (s.clearDepth !== value) { gl.clearDepth(value); s.clearDepth = value; }
      this.setDepthWrite(true);
      mask |= gl.DEPTH_BUFFER_BIT;
    }
    if (stencil !== false && stencil !== null && stencil !== undefined) {
      const value = stencil === true ? 0 : stencil;
      if (s.clearStencil !== value) { gl.clearStencil(value); s.clearStencil = value; }
      mask |= gl.STENCIL_BUFFER_BIT;
    }
    if (mask) gl.clear(mask);
  }

  // =========================================================================
  // Drawing helpers
  // =========================================================================

  /**
   * Draw a single oversized triangle covering the whole viewport using the
   * currently bound program (which must have been built from {@link FULLSCREEN_VS}).
   * @returns {void}
   */
  drawFullscreen() {
    const gl = this.gl;
    if (!this._fullscreenVAO) this._fullscreenVAO = gl.createVertexArray();
    this.bindVertexArray(this._fullscreenVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Resize the drawing buffer to `clientSize * devicePixelRatio * renderScale`.
   * @returns {boolean} true when the drawing buffer size changed
   */
  resizeCanvas() {
    const canvas = this.canvas;
    if (!canvas) return false;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const scale = Math.max(0.1, Math.min(4, this.renderScale || 1));
    const cssW = canvas.clientWidth || canvas.width || 1;
    const cssH = canvas.clientHeight || canvas.height || 1;
    const limit = this.caps.maxTexSize;
    const w = Math.max(1, Math.min(limit, Math.round(cssW * dpr * scale)));
    const h = Math.max(1, Math.min(limit, Math.round(cssH * dpr * scale)));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  }

  // =========================================================================
  // GPU timers
  // =========================================================================

  /**
   * Begin a GPU timer scope. Nested scopes are ignored (GL allows one active
   * TIME_ELAPSED query). No-op when the extension is unavailable.
   * @param {string} label timer label
   * @returns {void}
   */
  beginTimer(label) {
    const ext = this.ext.timerQuery;
    if (!ext) return;
    if (this._activeQuery) { this._timerDepth++; return; }
    const query = this._queryPool.pop() || this.gl.createQuery();
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this._activeQuery = { label, query };
  }

  /**
   * End the GPU timer scope opened by {@link GL#beginTimer}.
   * @param {string} label timer label (must match the matching begin)
   * @returns {void}
   */
  endTimer(label) {
    const ext = this.ext.timerQuery;
    if (!ext) return;
    if (this._timerDepth > 0) { this._timerDepth--; return; }
    const active = this._activeQuery;
    if (!active) return;
    this.gl.endQuery(ext.TIME_ELAPSED_EXT);
    this._activeQuery = null;
    if (this._pendingQueries.length > 256) {
      const dropped = this._pendingQueries.shift();
      this._queryPool.push(dropped.query);
    }
    this._pendingQueries.push({ label: active.label || label, query: active.query, frame: this._timerFrame });
  }

  /**
   * Collect finished GPU timer results. Call once per frame.
   * Results lag ~2 frames behind; the returned object is reused (no allocation).
   * @returns {Object<string, number>} label -> milliseconds
   */
  getTimings() {
    const ext = this.ext.timerQuery;
    if (!ext) return this._timings;
    const gl = this.gl;
    this._timerFrame++;
    let disjoint = false;
    try { disjoint = !!gl.getParameter(ext.GPU_DISJOINT_EXT); } catch (e) { disjoint = false; }
    const pending = this._pendingQueries;
    let i = 0;
    while (i < pending.length) {
      const entry = pending[i];
      if (this._timerFrame - entry.frame < 2) { i++; continue; }
      let available = false;
      try { available = !!gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE); } catch (e) { available = true; }
      if (!available) { i++; continue; }
      if (!disjoint) {
        let ns = 0;
        try { ns = gl.getQueryParameter(entry.query, gl.QUERY_RESULT) || 0; } catch (e) { ns = 0; }
        this._timings[entry.label] = ns / 1e6;
      }
      this._queryPool.push(entry.query);
      pending.splice(i, 1);
    }
    return this._timings;
  }

  /**
   * Release the fullscreen VAO, timer queries and drop all caches.
   * @returns {void}
   */
  dispose() {
    const gl = this.gl;
    if (this._fullscreenVAO) { gl.deleteVertexArray(this._fullscreenVAO); this._fullscreenVAO = null; }
    for (const q of this._queryPool) gl.deleteQuery(q);
    for (const e of this._pendingQueries) gl.deleteQuery(e.query);
    if (this._activeQuery) gl.deleteQuery(this._activeQuery.query);
    this._queryPool.length = 0;
    this._pendingQueries.length = 0;
    this._activeQuery = null;
    this.includes.clear();
    this.invalidateState();
  }
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/**
 * Remove any `#version` directive from a source string.
 * @param {string} src source text
 * @returns {string} source without `#version` lines
 */
function stripVersion(src) {
  return src.replace(/^[ \t]*#[ \t]*version[^\n]*\n?/gm, '');
}

/**
 * Test whether a value is a WebGLRenderbuffer.
 * @param {*} value candidate
 * @returns {boolean} true when it is a renderbuffer
 */
function isRenderbuffer(value) {
  return typeof WebGLRenderbuffer !== 'undefined' && value instanceof WebGLRenderbuffer;
}

/**
 * Pick DEPTH_ATTACHMENT or DEPTH_STENCIL_ATTACHMENT for a depth texture.
 * @param {WebGL2RenderingContext} gl context
 * @param {GL} device owning device
 * @param {WebGLTexture} tex depth texture
 * @returns {number} attachment point enum
 */
function depthAttachmentPoint(gl, device, tex) {
  const meta = tex && tex.__vox;
  const fmt = meta ? meta.internalFormat : gl.DEPTH_COMPONENT24;
  if (fmt === gl.DEPTH24_STENCIL8 || fmt === gl.DEPTH32F_STENCIL8) return gl.DEPTH_STENCIL_ATTACHMENT;
  return gl.DEPTH_ATTACHMENT;
}

/**
 * Resolve a filter given as a GL enum or a friendly string.
 * @param {WebGL2RenderingContext} gl context
 * @param {number|string|undefined} value filter
 * @param {number} fallback default enum
 * @returns {number} GL filter enum
 */
function resolveFilter(gl, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return value;
  switch (String(value).toLowerCase()) {
    case 'nearest': return gl.NEAREST;
    case 'linear': return gl.LINEAR;
    case 'nearest_mipmap_nearest': return gl.NEAREST_MIPMAP_NEAREST;
    case 'linear_mipmap_nearest': return gl.LINEAR_MIPMAP_NEAREST;
    case 'nearest_mipmap_linear': return gl.NEAREST_MIPMAP_LINEAR;
    case 'linear_mipmap_linear': case 'trilinear': return gl.LINEAR_MIPMAP_LINEAR;
    default: return fallback;
  }
}

/**
 * Resolve a wrap mode given as a GL enum or a friendly string.
 * @param {WebGL2RenderingContext} gl context
 * @param {number|string|undefined} value wrap mode
 * @param {number} fallback default enum
 * @returns {number} GL wrap enum
 */
function resolveWrap(gl, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return value;
  switch (String(value).toLowerCase()) {
    case 'repeat': return gl.REPEAT;
    case 'clamp': case 'clamp_to_edge': return gl.CLAMP_TO_EDGE;
    case 'mirror': case 'mirrored_repeat': return gl.MIRRORED_REPEAT;
    default: return fallback;
  }
}

/**
 * Build the sized-internal-format -> {format, type} table.
 * @param {WebGL2RenderingContext} gl context
 * @returns {Map<number,{format:number,type:number}>} lookup table
 */
function buildFormatTable(gl) {
  const m = new Map();
  const add = (internal, format, type) => { m.set(internal, { format, type }); };
  add(gl.R8, gl.RED, gl.UNSIGNED_BYTE);
  add(gl.R8_SNORM, gl.RED, gl.BYTE);
  add(gl.R16F, gl.RED, gl.HALF_FLOAT);
  add(gl.R32F, gl.RED, gl.FLOAT);
  add(gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE);
  add(gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT);
  add(gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT);
  add(gl.RG8, gl.RG, gl.UNSIGNED_BYTE);
  add(gl.RG16F, gl.RG, gl.HALF_FLOAT);
  add(gl.RG32F, gl.RG, gl.FLOAT);
  add(gl.RG8UI, gl.RG_INTEGER, gl.UNSIGNED_BYTE);
  add(gl.RG16UI, gl.RG_INTEGER, gl.UNSIGNED_SHORT);
  add(gl.RG32UI, gl.RG_INTEGER, gl.UNSIGNED_INT);
  add(gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE);
  add(gl.SRGB8, gl.RGB, gl.UNSIGNED_BYTE);
  add(gl.RGB565, gl.RGB, gl.UNSIGNED_SHORT_5_6_5);
  add(gl.R11F_G11F_B10F, gl.RGB, gl.HALF_FLOAT);
  add(gl.RGB9_E5, gl.RGB, gl.HALF_FLOAT);
  add(gl.RGB16F, gl.RGB, gl.HALF_FLOAT);
  add(gl.RGB32F, gl.RGB, gl.FLOAT);
  add(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  add(gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE);
  add(gl.RGB5_A1, gl.RGBA, gl.UNSIGNED_SHORT_5_5_5_1);
  add(gl.RGBA4, gl.RGBA, gl.UNSIGNED_SHORT_4_4_4_4);
  add(gl.RGB10_A2, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV);
  add(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
  add(gl.RGBA32F, gl.RGBA, gl.FLOAT);
  add(gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE);
  add(gl.RGBA16UI, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT);
  add(gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT);
  add(gl.DEPTH_COMPONENT16, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT);
  add(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT);
  add(gl.DEPTH_COMPONENT32F, gl.DEPTH_COMPONENT, gl.FLOAT);
  add(gl.DEPTH24_STENCIL8, gl.DEPTH_STENCIL, gl.UNSIGNED_INT_24_8);
  add(gl.DEPTH32F_STENCIL8, gl.DEPTH_STENCIL, gl.FLOAT_32_UNSIGNED_INT_24_8_REV);
  return m;
}

/**
 * Set of integer (non-filterable) sized internal formats.
 * @param {WebGL2RenderingContext} gl context
 * @returns {Set<number>} integer formats
 */
function buildIntegerFormatSet(gl) {
  return new Set([
    gl.R8UI, gl.R16UI, gl.R32UI, gl.R8I, gl.R16I, gl.R32I,
    gl.RG8UI, gl.RG16UI, gl.RG32UI, gl.RG8I, gl.RG16I, gl.RG32I,
    gl.RGBA8UI, gl.RGBA16UI, gl.RGBA32UI, gl.RGBA8I, gl.RGBA16I, gl.RGBA32I,
    gl.RGB10_A2UI,
  ]);
}

/**
 * Set of depth / depth-stencil sized internal formats.
 * @param {WebGL2RenderingContext} gl context
 * @returns {Set<number>} depth formats
 */
function buildDepthFormatSet(gl) {
  return new Set([
    gl.DEPTH_COMPONENT16, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT32F,
    gl.DEPTH24_STENCIL8, gl.DEPTH32F_STENCIL8,
  ]);
}
