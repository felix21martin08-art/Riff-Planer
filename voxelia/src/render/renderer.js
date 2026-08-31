/**
 * VOXELIA — deferred PBR pipeline orchestrator (spec 5.26).
 *
 * `Renderer` owns nothing that draws by itself: it owns the **contract** that
 * every other `render/*` module plugs into — the `Frame` UBO (binding 0), the
 * `Shadows` UBO (binding 1), the HDR scene target, the render-target sizes, the
 * TAA jitter, the per-pass GPU timers — and it calls the passes in the one
 * order that produces a correct image.
 *
 * ```
 *   sky LUTs ─┐
 *             ├─▶ Frame UBO ─▶ shadow cascades ─▶ G-buffer ─▶ SSAO
 *   sun/moon ─┘                                                 │
 *                                                               ▼
 *   post ◀── underwater ◀── debug/outline ◀── particles ◀── water ◀── sky bg ◀── lighting
 * ```
 *
 * ### Two integration decisions worth knowing
 *
 * **1. Where the TAA jitter lives.** Every geometry shader in this engine
 * (`gbuffer`, `water`, `entities`) offsets its own clip position by
 * `u_jitter.xy * clip.w`, so `u_proj` / `u_viewProj` are uploaded **unjittered**
 * — exactly as ARCHITECTURE.md 3.3 describes, and exactly matching
 * `frame.camera.viewProj`, which `entities` reads directly. The *inverses*
 * (`u_invProj`, `u_invViewProj`) and `u_prevViewProj` are built from the
 * **jittered** matrices, because those are the matrices the depth buffer was
 * actually rasterized with: that makes `worldFromDepth()` exact, which is what
 * TAA, SSAO and the deferred composite reconstruct positions with.
 * `u_jitter.zw` carries the *previous* frame's jitter, which `post.js` removes
 * when it reprojects into the (unjittered) history buffer.
 *
 * **2. Where the first-person hand is drawn.** `EntityRenderer.renderHeldItem()`
 * writes the full four-attachment G-buffer contract of 3.2 and reserves the
 * front 5 % of the depth range for itself (`gl.depthRange(0, 0.05)`), so it can
 * never be clipped by the world's near plane nor occluded by geometry. It is
 * therefore drawn as the **last** step of the G-buffer pass rather than after
 * the composite: that is the only placement in which it receives real deferred
 * lighting, and its reserved depth slice still keeps water, particles and the
 * block outline from drawing over it. The block outline, which has an explicit
 * `pass:'forward'` variant, is drawn after the transparent passes as specified.
 *
 * Nothing here throws during a frame: every pass is constructed inside its own
 * `try`/`catch` and a pass that fails is set to `null` and simply skipped, so a
 * broken sub-system costs a feature, never the picture.
 *
 * @module render/renderer
 */

import { registerCommonChunks } from './shaders/common.glsl.js';
import { TextureManager } from './textures.js';
import { GBuffer } from './gbuffer.js';
import { ShadowMapper, SHADOW_UBO_BYTES, MAX_SHADOW_CASCADES } from './shadows.js';
import { SSAO } from './ssao.js';
import { Sky } from './sky.js';
import { LightingPass } from './lightingpass.js';
import { WaterRenderer } from './water.js';
import { PostProcess } from './post.js';
import { ParticleSystem } from './particles.js';
import { EntityRenderer } from './entities.js';
import { DebugRenderer } from './debug.js';
import { FULLSCREEN_VS } from '../core/gl.js';
import { mat4, clamp, DEG2RAD } from '../core/math.js';
import { RingBuffer, nowMs } from '../core/util.js';
import { QUALITY_PRESETS } from '../core/settings.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** `Frame` UBO binding point (ARCHITECTURE.md 3.3). @type {number} */
export const FRAME_UBO_BINDING = 0;

/** `Shadows` UBO binding point (ARCHITECTURE.md 3.4). @type {number} */
export const SHADOWS_UBO_BINDING = 1;

/** Floats in the `Frame` block: 7 × mat4 + 11 × vec4. @type {number} */
export const FRAME_UBO_FLOATS = 7 * 16 + 11 * 4;

/** Size of the `Frame` block in bytes — 624, exactly as 3.3 requires. @type {number} */
export const FRAME_UBO_BYTES = FRAME_UBO_FLOATS * 4;

/**
 * Float offsets of every `Frame` member, in the std140 order of 3.3.
 * @type {Readonly<Object<string, number>>}
 */
export const FRAME_UBO_OFFSETS = Object.freeze({
  view: 0,
  proj: 16,
  viewProj: 32,
  invView: 48,
  invProj: 64,
  invViewProj: 80,
  prevViewProj: 96,
  camPos: 112,
  camDir: 116,
  sunDir: 120,
  sunColor: 124,
  moonDir: 128,
  skyAmbient: 132,
  fogColor: 136,
  screen: 140,
  time: 144,
  params: 148,
  jitter: 152,
});

/** Texture unit of `u_sceneColor` (ARCHITECTURE.md 3.5). @type {number} */
const UNIT_SCENE_COLOR = 8;

/** Length of one in-game day in seconds, used when no environment exists. @type {number} */
const DAY_LENGTH_SECONDS = 1200;

/** Tilt of the fallback sun arc, matching `render/sky.js`. @type {number} */
const SUN_ARC_TILT = 0.35;

/** Samples kept in the frame-time ring buffer. @type {number} */
const FRAME_TIME_SAMPLES = 120;

/** Names of the GPU timer scopes, in pipeline order. @type {ReadonlyArray<string>} */
export const PASS_LABELS = Object.freeze([
  'sky.lut', 'shadows', 'gbuffer', 'ssao', 'lighting', 'sky', 'water',
  'particles', 'debug', 'post',
]);

/**
 * Fallback presentation shader: exposure + ACES + sRGB.
 *
 * Used when `render/post.js` failed to build, so a broken post chain shows the
 * world instead of a black screen.
 * @type {string}
 */
const BLIT_FS = `
#include <math>
#include <color>

uniform sampler2D u_sceneColor;
uniform float u_exposure;

in vec2 v_uv;

layout(location = 0) out vec4 o_color;

void main() {
  vec3 hdr = texture(u_sceneColor, v_uv).rgb * max(u_exposure, 0.0);
  o_color = vec4(linearToSrgb(acesFitted(hdr)), 1.0);
}
`;

/**
 * The frame object `game/game.js` hands to {@link Renderer#render}.
 *
 * Documentation only — nothing imports this at runtime.
 * @type {Readonly<Object>}
 */
export const FrameShape = Object.freeze({
  camera: {
    position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0], right: [1, 0, 0],
    yaw: 0, pitch: 0, fov: 75, near: 0.05, far: 1000, aspect: 1,
    view: null, proj: null, viewProj: null, prevViewProj: null,
    frustum: null, underwater: false,
  },
  world: null,
  entities: null,
  player: null,
  environment: null,
  particles: null,
  hit: null,
  breakProgress: 0,
  time: 0,
  dt: 0,
  frameIndex: 0,
});

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Test whether a value can be read as a column-major 4×4 matrix.
 * @param {*} m Candidate.
 * @returns {boolean} `true` when it has 16 numeric entries.
 */
function isMat4(m) {
  return !!m && typeof m.length === 'number' && m.length === 16 && Number.isFinite(m[0]);
}

/**
 * Test whether a value can be read as an rgb / xyz triple.
 * @param {*} v Candidate.
 * @returns {boolean} `true` when it has three finite entries.
 */
function isVec3(v) {
  return !!v && typeof v.length === 'number' && v.length >= 3 &&
    Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

/**
 * Read a number with a fallback.
 * @param {*} v Candidate.
 * @param {number} fallback Value used when `v` is not finite.
 * @returns {number} A finite number.
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Fractional part, always in `[0, 1)`.
 * @param {number} x Input.
 * @returns {number} `x - floor(x)`.
 */
function fract(x) {
  return x - Math.floor(x);
}

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The one render entry point of the engine.
 *
 * ```js
 * const renderer = new Renderer(gl, settings);
 * await renderer.init((p, label) => showLoadingBar(p, label));
 * renderer.resize(canvas.clientWidth, canvas.clientHeight);
 * // once per animation frame:
 * renderer.render(frame);
 * ```
 */
export class Renderer {
  /**
   * @param {import('../core/gl.js').GL} gl VOXELIA WebGL2 device.
   * @param {import('../core/settings.js').Settings} settings Live settings.
   */
  constructor(gl, settings) {
    /** @type {import('../core/gl.js').GL} Owning device. */
    this.device = gl;
    /** @type {WebGL2RenderingContext} Raw context. */
    this.raw = gl.gl;
    /** @type {?Object} Settings store. */
    this.settings = settings || null;

    /** @type {boolean} True once {@link Renderer#init} succeeded. */
    this.ready = false;
    /** @type {number} Init progress, 0..1. */
    this.progress = 0;
    /** @type {string[]} Names of the passes that failed to initialise. */
    this.failedPasses = [];

    /** @type {number} Internal render-target width in device pixels. */
    this.width = 0;
    /** @type {number} Internal render-target height in device pixels. */
    this.height = 0;

    /* ---- sub-systems (public: the UI and the game read these) ------------- */

    /** @type {?TextureManager} Procedural texture arrays; the UI needs its icons. */
    this.textures = null;
    /** @type {?GBuffer} Deferred targets + terrain geometry pass. */
    this.gbuffer = null;
    /** @type {?ShadowMapper} Cascaded shadow maps. */
    this.shadows = null;
    /** @type {?SSAO} Ambient occlusion. */
    this.ssao = null;
    /** @type {?Sky} Atmosphere, clouds, stars. */
    this.sky = null;
    /** @type {?LightingPass} Deferred PBR composite. */
    this.lighting = null;
    /** @type {?WaterRenderer} Water surface, SSR, underwater overlay. */
    this.water = null;
    /** @type {?PostProcess} TAA, bloom, tonemap, grade. */
    this.post = null;
    /** @type {?ParticleSystem} Particles and weather. */
    this.particles = null;
    /** @type {?EntityRenderer} Mobs, items, held item, block outline. */
    this.entities = null;
    /** @type {?DebugRenderer} Debug lines and the frame-time graph. */
    this.debug = null;

    /* ---- uniform buffers -------------------------------------------------- */

    /** @type {?Object} The `Frame` UBO (binding 0). */
    this.frameUBO = null;
    /** @type {?Object} The `Shadows` UBO (binding 1). */
    this.shadowUBO = null;

    /* ---- scene target ----------------------------------------------------- */

    /** @type {?WebGLTexture} HDR scene colour (RGBA16F when available). @private */
    this._sceneTex = null;
    /** @type {?WebGLTexture} Private copy of the G-buffer depth (see `_ensureSceneTarget`). @private */
    this._sceneDepth = null;
    /** @type {?Object} Framebuffer over `_sceneTex` + `_sceneDepth`. @private */
    this._sceneFBO = null;
    /** @type {boolean} True once the depth blit has been reported as failing. @private */
    this._depthCopyFailed = false;
    /** @type {?Object} Fallback presentation program. @private */
    this._blit = null;

    /* ---- toggles ---------------------------------------------------------- */

    /** @type {boolean} Draw the selection wireframe around `frame.hit`. */
    this.drawBlockOutline = true;
    /** @type {boolean} Draw the break-progress overlay. */
    this.drawBreakOverlay = true;
    /** @type {boolean} Draw the first-person arm / held item. */
    this.drawHeldItem = true;

    /* ---- statistics -------------------------------------------------------- */

    /**
     * Live frame statistics for the F3 overlay.
     * @type {{drawCalls:number, triangles:number, sections:number, entities:number,
     *   particles:number, cpuMs:number, gpuMs:number, frameMs:number, fps:number,
     *   width:number, height:number, renderScale:number,
     *   passes:Object<string, number>, frameTimes:import('../core/util.js').RingBuffer}}
     */
    this.stats = {
      drawCalls: 0,
      triangles: 0,
      sections: 0,
      entities: 0,
      particles: 0,
      cpuMs: 0,
      gpuMs: 0,
      frameMs: 0,
      fps: 0,
      width: 0,
      height: 0,
      renderScale: 1,
      passes: Object.create(null),
      frameTimes: new RingBuffer(FRAME_TIME_SAMPLES, Float32Array),
    };

    /* ---- scratch (nothing below allocates per frame) ----------------------- */

    /** @type {Float32Array} std140 staging buffer for the `Frame` block. @private */
    this._frameData = new Float32Array(FRAME_UBO_FLOATS);
    /** @type {Float32Array} @private */
    this._proj = mat4.create();
    /** @type {Float32Array} @private */
    this._viewProj = mat4.create();
    /** @type {Float32Array} Projection with the TAA jitter baked in. @private */
    this._projJ = mat4.create();
    /** @type {Float32Array} View-projection with the TAA jitter baked in. @private */
    this._viewProjJ = mat4.create();
    /** @type {Float32Array} @private */
    this._invView = mat4.create();
    /** @type {Float32Array} @private */
    this._invProjJ = mat4.create();
    /** @type {Float32Array} @private */
    this._invViewProjJ = mat4.create();
    /** @type {Float32Array} Previous frame's jittered view-projection. @private */
    this._prevViewProjJ = mat4.identity(mat4.create());
    /** @type {Float32Array} Immutable identity, used when a matrix is missing. @private */
    this._identity = mat4.identity(mat4.create());

    /** @type {Float32Array} Current TAA jitter, NDC. @private */
    this._jitter = new Float32Array(2);
    /** @type {Float32Array} Previous TAA jitter, NDC. @private */
    this._prevJitter = new Float32Array(2);

    /** @type {Float32Array} Direction toward the sun. @private */
    this._sunDir = new Float32Array([0.36, 0.84, 0.41]);
    /** @type {Float32Array} Direction toward the moon. @private */
    this._moonDir = new Float32Array([-0.36, -0.84, -0.41]);
    /** @type {Float32Array} World-space camera position. @private */
    this._camPos = new Float32Array(3);
    /** @type {Float32Array} World-space camera forward. @private */
    this._camDir = new Float32Array([0, 0, -1]);
    /** @type {Float32Array} Clear colour used when the composite is unavailable. @private */
    this._clearColor = new Float32Array([0.04, 0.06, 0.09, 1]);

    /** @type {number} 1 while the camera is submerged. @private */
    this._underwater = 0;
    /** @type {number} Fallback frame counter. @private */
    this._frameCounter = 0;
    /** @type {number} `nowMs()` of the previous frame. @private */
    this._lastFrameAt = 0;
    /** @type {number} Current exposure setting, cached for the fallback blit. @private */
    this._exposure = 1;

    /** @type {?Object} Entity list of the frame being rendered. @private */
    this._frameEntities = null;
    /** @type {?Object} Player of the frame being rendered. @private */
    this._framePlayer = null;

    /* ---- settings reactions ------------------------------------------------ */

    /** @type {{size:boolean, shadows:boolean, textures:boolean}} @private */
    this._dirty = { size: false, shadows: false, textures: false };
    /** @type {number} Texture resolution the arrays were generated for. @private */
    this._appliedTextureResolution = 0;
    /** @type {boolean} True while an async texture regeneration is running. @private */
    this._textureBusy = false;

    /** @type {?function(string):void} @private */
    this._onSettingChange = null;
    /** @type {?function():void} @private */
    this._onSettingBulk = null;

    /** @type {boolean} True once a per-frame failure was reported. @private */
    this._frameErrorLogged = false;
    /** @type {boolean} @private */
    this._disposed = false;

    /**
     * Extra shadow caster: draws mobs and the player into every cascade.
     * @type {function(Object, Object, number, Object=):void}
     * @private
     */
    this._shadowEntityCaster = (world, lightFrame, cascadeIndex, entities) => {
      const renderer = this.entities;
      if (!renderer) return;
      const list = entities || this._frameEntities;
      if (!list && !this._framePlayer) return;
      try {
        renderer.render(list, this._framePlayer, lightFrame, world, { pass: 'shadow' });
      } catch (err) {
        this._reportFrameError(err);
      }
    };
  }

  /* ======================================================================== */
  /* Settings plumbing                                                        */
  /* ======================================================================== */

  /**
   * Read a setting, tolerating a missing store or an unknown key.
   * @param {string} key Setting key.
   * @param {*} fallback Value used when the key is unavailable.
   * @returns {*} The stored value or `fallback`.
   * @private
   */
  _setting(key, fallback) {
    if (!this.settings || typeof this.settings.get !== 'function') return fallback;
    try {
      const value = this.settings.get(key);
      return value === undefined || value === null ? fallback : value;
    } catch (err) {
      return fallback;
    }
  }

  /**
   * The render scale, clamped to a sane range.
   * @returns {number} Multiplier applied on top of `devicePixelRatio`.
   * @private
   */
  _renderScale() {
    return clamp(num(this._setting('renderScale', 1), 1), 0.25, 2);
  }

  /**
   * Subscribe to the settings bus so quality changes rebuild only what changed.
   * @returns {void}
   * @private
   */
  _subscribeSettings() {
    if (!this.settings || typeof this.settings.on !== 'function') return;
    this._onSettingChange = (key) => {
      switch (key) {
        case 'renderScale':
          this._dirty.size = true;
          break;
        case 'shadowResolution':
        case 'shadowCascades':
          this._dirty.shadows = true;
          break;
        case 'textureResolution':
          this._dirty.textures = true;
          break;
        default:
          break;
      }
    };
    this._onSettingBulk = () => {
      this._dirty.size = true;
      this._dirty.shadows = true;
      this._dirty.textures = true;
    };
    try {
      this.settings.on('change', this._onSettingChange);
      this.settings.on('preset', this._onSettingBulk);
      this.settings.on('reset', this._onSettingBulk);
      this.settings.on('load', this._onSettingBulk);
    } catch (err) {
      console.warn('[VOXELIA] renderer: could not subscribe to settings changes.', err);
    }
  }

  /**
   * Apply everything a settings change flagged as dirty.
   *
   * Never called from inside the settings event itself — rebuilding GPU state
   * from an event handler would run in the middle of somebody else's frame.
   *
   * @param {boolean} [force=false] Re-evaluate every key even without a flag.
   * @returns {void}
   * @private
   */
  _applyPendingSettings(force = false) {
    const dirty = this._dirty;
    if (!force && !dirty.size && !dirty.shadows && !dirty.textures) return;

    if (force || dirty.size) {
      dirty.size = false;
      const scale = this._renderScale();
      if (Math.abs(scale - num(this.device.renderScale, 1)) > 1e-4) {
        try { this.resize(); } catch (err) { this._reportFrameError(err); }
      }
    }

    if (force || dirty.shadows) {
      dirty.shadows = false;
      const shadows = this.shadows;
      if (shadows) {
        const res = Math.round(num(this._setting('shadowResolution', 2048), 2048));
        const cascades = clamp(Math.round(num(this._setting('shadowCascades', 3), 3)),
          1, MAX_SHADOW_CASCADES);
        if (res !== shadows.resolution || cascades !== shadows.cascadeCount) {
          try { shadows.resize(res, cascades); } catch (err) { this._reportFrameError(err); }
        }
      }
    }

    if (force || dirty.textures) {
      const res = Math.round(num(this._setting('textureResolution', 256), 256));
      if (this.textures && res !== this._appliedTextureResolution) {
        // A regeneration already in flight keeps the flag set, so the newest
        // resolution is picked up as soon as that one finishes instead of
        // being silently dropped.
        if (!this._textureBusy) {
          dirty.textures = false;
          this._regenerateTextures(res);
        }
      } else {
        dirty.textures = false;
      }
    }
  }

  /**
   * Rebuild the procedural texture arrays at a new resolution, off the frame.
   *
   * `TextureManager.regenerate()` deletes every array and then re-renders them
   * over many event-loop turns, so frames keep being drawn while the arrays are
   * gone. Consumers that *cached* a texture handle would keep binding a deleted
   * object, and the manager renders **into** the very arrays and the cloud
   * volume the sky and terrain sample — a WebGL2 feedback loop. Both are avoided
   * by detaching every texture up front and re-attaching once the rebuild is
   * done; {@link Renderer#_unbindTextureUnits} keeps the fixed units clean in
   * the meantime.
   *
   * @param {number} resolution Requested edge size in texels.
   * @returns {void}
   * @private
   */
  _regenerateTextures(resolution) {
    if (!this.textures || this._textureBusy || this._disposed) return;
    this._textureBusy = true;
    this._appliedTextureResolution = resolution;
    this._attachTextures(null);
    Promise.resolve()
      .then(() => this.textures.regenerate(resolution))
      .catch((err) => {
        console.error('[VOXELIA] renderer: texture regeneration failed.', err);
      })
      .then(() => {
        this._textureBusy = false;
        this._attachTextures(this.textures);
      });
  }

  /**
   * Point every consumer at a texture manager, or at `null` to detach.
   * @param {?TextureManager} tex The manager, or null while it is rebuilding.
   * @returns {void}
   * @private
   */
  _attachTextures(tex) {
    if (this._disposed) return;
    const blue = tex ? (tex.blueNoise || null) : null;
    const cloud = tex ? (tex.cloudNoise || null) : null;
    try {
      if (this.gbuffer) this.gbuffer.setTextures(tex);
      if (this.water) this.water.setTextures(tex);
      if (this.particles) this.particles.setTextureManager(tex);
      if (this.entities) this.entities.textures = tex;
      if (this.ssao) this.ssao.setBlueNoise(blue);
      if (this.lighting) this.lighting.setBlueNoise(blue);
      if (this.post) this.post.blueNoise = blue;
      if (this.sky) {
        this.sky.setBlueNoise(blue);
        this.sky.setCloudNoise(cloud);
      }
    } catch (err) {
      this._reportFrameError(err);
    }
  }

  /**
   * Unbind the texture-array and noise units while the arrays are being
   * regenerated, so nothing samples a deleted object or a target the generator
   * is rendering into.
   * @returns {void}
   * @private
   */
  _unbindTextureUnits() {
    const gl = this.raw;
    const device = this.device;
    try {
      device.bindTexture(0, gl.TEXTURE_2D_ARRAY, null);
      device.bindTexture(1, gl.TEXTURE_2D_ARRAY, null);
      device.bindTexture(2, gl.TEXTURE_2D_ARRAY, null);
      device.bindTexture(11, gl.TEXTURE_2D, null);
      device.bindTexture(13, gl.TEXTURE_3D, null);
    } catch (err) { /* context lost */ }
  }

  /* ======================================================================== */
  /* Initialisation                                                           */
  /* ======================================================================== */

  /**
   * Build every GPU resource the pipeline needs.
   *
   * Progress is reported across the *whole* init, not just the texture
   * generation, so the loading bar is honest: ~4 % for the shared GLSL chunks
   * and the uniform buffers, ~66 % for the procedural textures (by far the most
   * expensive step) and the rest for the individual passes.
   *
   * A pass that throws is logged once, set to `null` and skipped forever after;
   * the pipeline keeps rendering without it.
   *
   * @param {function(number, string=):void} [onProgress] Progress sink, 0..1
   *        plus a short human-readable label.
   * @returns {Promise<boolean>} `true` when the pipeline can draw a frame.
   */
  async init(onProgress) {
    if (this._disposed) return false;

    const report = (p, label) => {
      this.progress = clamp(p, 0, 1);
      if (typeof onProgress !== 'function') return;
      try { onProgress(this.progress, label); } catch (err) { /* a broken UI never blocks loading */ }
    };

    report(0, 'Shader-Bibliothek');
    try {
      registerCommonChunks(this.device);
    } catch (err) {
      console.error('[VOXELIA] renderer: the shared GLSL chunks could not be registered.', err);
    }

    report(0.02, 'Uniform-Puffer');
    try {
      this.frameUBO = this.device.createUBO('Frame', FRAME_UBO_BYTES, FRAME_UBO_BINDING);
      this.shadowUBO = this.device.createUBO('Shadows', SHADOW_UBO_BYTES, SHADOWS_UBO_BINDING);
    } catch (err) {
      console.error('[VOXELIA] renderer: the uniform buffers could not be created.', err);
      this.frameUBO = null;
      this.shadowUBO = null;
    }

    report(0.04, 'Texturen');
    try {
      this.textures = new TextureManager(this.device, this.settings);
      await this.textures.generate((p) => report(0.04 + clamp(p, 0, 1) * 0.66, 'Texturen'));
      this._appliedTextureResolution = Math.round(num(this._setting('textureResolution', 256), 256));
    } catch (err) {
      console.error('[VOXELIA] renderer: the procedural textures failed — running untextured.', err);
      this.failedPasses.push('textures');
    }

    /**
     * Construct one pass inside its own guard.
     * @param {string} field Property name on the renderer.
     * @param {string} label Loading-bar label.
     * @param {number} fraction Progress fraction to report before building.
     * @param {function():Object} factory Constructor thunk.
     * @returns {void}
     */
    const build = (field, label, fraction, factory) => {
      report(fraction, label);
      if (this._disposed) return;
      try {
        this[field] = factory() || null;
      } catch (err) {
        this[field] = null;
        this.failedPasses.push(field);
        console.error(`[VOXELIA] renderer: pass "${field}" failed to initialise — continuing without it.`, err);
      }
    };

    build('gbuffer', 'G-Buffer', 0.71,
      () => new GBuffer(this.device, this.settings, this.textures));

    build('shadows', 'Schattenkaskaden', 0.74, () => {
      const shadows = new ShadowMapper(this.device, this.settings);
      if (this.gbuffer) shadows.setCaster(this.gbuffer);
      shadows.extraCasters.push(this._shadowEntityCaster);
      return shadows;
    });

    build('ssao', 'Umgebungsverdeckung', 0.77, () => {
      const ssao = new SSAO(this.device, this.settings);
      if (this.textures && this.textures.blueNoise) ssao.setBlueNoise(this.textures.blueNoise);
      return ssao;
    });

    build('sky', 'Atmosphäre', 0.80, () => {
      const sky = new Sky(this.device, this.settings);
      if (this.textures) sky.setTextures(this.textures);
      return sky;
    });

    build('lighting', 'Beleuchtung', 0.85, () => {
      const lighting = new LightingPass(this.device, this.settings);
      if (this.textures && this.textures.blueNoise) lighting.setBlueNoise(this.textures.blueNoise);
      return lighting;
    });

    build('water', 'Wasser', 0.88, () => {
      const water = new WaterRenderer(this.device, this.settings);
      if (this.textures) water.setTextures(this.textures);
      return water;
    });

    build('post', 'Post-Processing', 0.90, () => {
      const post = new PostProcess(this.device, this.settings);
      if (this.textures && this.textures.blueNoise) post.blueNoise = this.textures.blueNoise;
      return post;
    });

    build('particles', 'Partikel', 0.92, () => {
      const particles = new ParticleSystem(this.device, this.settings);
      if (this.textures) particles.setTextureManager(this.textures);
      return particles;
    });

    build('entities', 'Kreaturen', 0.94, () => {
      const entities = new EntityRenderer(this.device, this.settings, this.textures);
      try { entities.prepare(); } catch (err) {
        console.warn('[VOXELIA] renderer: entity resources deferred to the first frame.', err);
      }
      return entities;
    });

    build('debug', 'Debug-Werkzeuge', 0.97, () => new DebugRenderer(this.device, this.settings));

    report(0.98, 'Render-Ziele');
    try {
      this._blit = this._createBlitProgram();
    } catch (err) {
      this._blit = null;
    }

    try {
      this.resize();
    } catch (err) {
      console.error('[VOXELIA] renderer: the render targets could not be sized.', err);
    }

    this._subscribeSettings();
    this.ready = !!(this.gbuffer && this.frameUBO && this._sceneFBO);
    if (!this.ready) {
      console.error('[VOXELIA] renderer: the deferred pipeline is unavailable ' +
        `(gbuffer=${!!this.gbuffer}, frameUBO=${!!this.frameUBO}, sceneTarget=${!!this._sceneFBO}).`);
    }
    report(1, 'Bereit');
    return this.ready;
  }

  /**
   * Compile the fallback presentation program.
   * @returns {?Object} The program, or null when it failed.
   * @private
   */
  _createBlitProgram() {
    const program = this.device.createProgram('renderer.blit', FULLSCREEN_VS, BLIT_FS);
    if (program && typeof program.ready === 'function') program.ready();
    return program && program.program ? program : null;
  }

  /* ======================================================================== */
  /* Sizing                                                                   */
  /* ======================================================================== */

  /**
   * Resize the internal render targets.
   *
   * `width` / `height` are **CSS pixels** (the canvas' layout size). The
   * internal buffer ends up at `size * devicePixelRatio * settings.renderScale`,
   * clamped to `caps.maxTexSize`. When the canvas is laid out by CSS the
   * arguments are optional — the device measures the canvas itself. A canvas
   * that reports a zero size keeps the previous target size, so a hidden or
   * detached canvas can never allocate a 0×0 framebuffer.
   *
   * @param {number} [width] Canvas width in CSS pixels.
   * @param {number} [height] Canvas height in CSS pixels.
   * @returns {boolean} `true` when the internal size actually changed.
   */
  resize(width, height) {
    if (this._disposed) return false;
    const device = this.device;
    const gl = this.raw;
    const canvas = device.canvas;
    const scale = this._renderScale();
    device.renderScale = scale;

    const clientW = canvas ? (canvas.clientWidth | 0) : 0;
    const clientH = canvas ? (canvas.clientHeight | 0) : 0;
    const limit = Math.max(1, num(device.caps && device.caps.maxTexSize, 4096));

    if (clientW > 0 && clientH > 0) {
      // CSS-driven canvas: `resizeCanvas` applies dpr * renderScale for us.
      device.resizeCanvas();
    } else if (canvas && num(width, 0) > 0 && num(height, 0) > 0) {
      const w = clamp(Math.round(width * scale), 1, limit) | 0;
      const h = clamp(Math.round(height * scale), 1, limit) | 0;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }

    const w = Math.max(1, gl.drawingBufferWidth | 0);
    const h = Math.max(1, gl.drawingBufferHeight | 0);
    const changed = w !== this.width || h !== this.height;

    this.width = w;
    this.height = h;
    this.stats.width = w;
    this.stats.height = h;
    this.stats.renderScale = scale;

    this._resizePass(this.gbuffer, w, h);
    this._resizePass(this.ssao, w, h);
    this._resizePass(this.lighting, w, h);
    this._resizePass(this.water, w, h);
    this._resizePass(this.post, w, h);
    this._resizePass(this.sky, w, h);
    this._resizePass(this.particles, w, h);
    this._resizePass(this.entities, w, h);
    this._resizePass(this.debug, w, h);

    this._ensureSceneTarget();
    return changed;
  }

  /**
   * Forward a resize to one pass, swallowing failures.
   * @param {?{resize?:function(number, number):*}} pass The pass.
   * @param {number} w Width in pixels.
   * @param {number} h Height in pixels.
   * @returns {void}
   * @private
   */
  _resizePass(pass, w, h) {
    if (!pass || typeof pass.resize !== 'function') return;
    try {
      pass.resize(w, h);
    } catch (err) {
      console.error('[VOXELIA] renderer: a pass failed to resize.', err);
    }
  }

  /**
   * Keep the internal size in step with the canvas without allocating.
   * @returns {boolean} `true` when the pipeline has a usable target.
   * @private
   */
  _syncSize() {
    const device = this.device;
    const gl = this.raw;
    const canvas = device.canvas;
    let need = gl.drawingBufferWidth !== this.width || gl.drawingBufferHeight !== this.height;

    if (!need && canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
      const scale = clamp(num(device.renderScale, 1), 0.1, 4);
      const limit = Math.max(1, num(device.caps && device.caps.maxTexSize, 4096));
      const wantW = clamp(Math.round(canvas.clientWidth * dpr * scale), 1, limit);
      const wantH = clamp(Math.round(canvas.clientHeight * dpr * scale), 1, limit);
      if (canvas.width !== wantW || canvas.height !== wantH) need = true;
    }

    if (need) this.resize();
    if (!this._sceneFBO) this._ensureSceneTarget();
    return this.width > 0 && this.height > 0 && !!this._sceneFBO && !!this.gbuffer;
  }

  /**
   * (Re)create the HDR scene target.
   *
   * The scene buffer gets its **own** `DEPTH_COMPONENT32F` attachment, which
   * {@link Renderer#_copySceneDepth} blits from the G-buffer once the geometry
   * pass is done. Re-using the G-buffer's depth texture directly would be
   * cheaper, but every pass that draws into the scene while *sampling*
   * `u_gDepth` — the deferred composite, the volumetric overlay, the soft
   * particles — would then form a WebGL2 feedback loop, and WebGL answers a
   * feedback loop with `INVALID_OPERATION` and a silently skipped draw call.
   * One depth blit per frame buys a pipeline where all of those still work.
   *
   * Depth *writes* stay off in every forward pass, so `gbuffer.depth` remains
   * the authoritative depth buffer for TAA and motion blur.
   *
   * @returns {boolean} `true` when the target is complete.
   * @private
   */
  _ensureSceneTarget() {
    if (this._disposed) return false;
    const gbuffer = this.gbuffer;
    if (!gbuffer || !gbuffer.depth) {
      this._destroySceneTarget();
      return false;
    }
    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);
    if (this._sceneFBO && this._sceneFBO.width === w && this._sceneFBO.height === h &&
        this._sceneFBO.complete !== false) {
      return true;
    }

    this._destroySceneTarget();
    const gl = this.raw;
    try {
      const format = this.device.caps.colorBufferFloat ? gl.RGBA16F : gl.RGBA8;
      this._sceneTex = this.device.createTexture({
        target: gl.TEXTURE_2D,
        width: w,
        height: h,
        internalFormat: format,
        min: 'linear',
        mag: 'linear',
        wrap: 'clamp',
        mips: false,
      });
      // Must match the G-buffer depth format exactly — blitFramebuffer refuses
      // to convert depth formats.
      this._sceneDepth = this.device.createTexture({
        target: gl.TEXTURE_2D,
        width: w,
        height: h,
        internalFormat: gl.DEPTH_COMPONENT32F,
        min: 'nearest',
        mag: 'nearest',
        wrap: 'clamp',
        mips: false,
      });
      this._sceneFBO = this.device.createFramebuffer({
        name: 'scene.hdr',
        color: [this._sceneTex],
        depth: this._sceneDepth,
        width: w,
        height: h,
      });
      this.device.bindFramebuffer(this._sceneFBO);
      this.device.setScissor(false);
      this.device.clear([0, 0, 0, 1], 1);
      this._depthCopyFailed = false;
      return this._sceneFBO.complete !== false;
    } catch (err) {
      console.error('[VOXELIA] renderer: the HDR scene target could not be allocated.', err);
      this._destroySceneTarget();
      return false;
    }
  }

  /**
   * Blit the G-buffer depth into the scene target so every forward pass
   * depth-tests against the geometry the deferred pass shaded.
   * @returns {boolean} `true` when the depth was copied.
   * @private
   */
  _copySceneDepth() {
    const gbuffer = this.gbuffer;
    const src = gbuffer && gbuffer.framebuffer;
    const dst = this._sceneFBO;
    if (!src || !dst || !this._sceneDepth) return false;
    const gl = this.raw;
    const w = Math.min(this.width, gbuffer.width || this.width);
    const h = Math.min(this.height, gbuffer.height || this.height);
    if (!(w > 0) || !(h > 0)) return false;
    try {
      this.device.setScissor(false);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      // The split READ/DRAW bindings bypassed the device's state cache.
      this.device.invalidateState();
      return true;
    } catch (err) {
      if (!this._depthCopyFailed) {
        this._depthCopyFailed = true;
        console.error('[VOXELIA] renderer: the scene depth copy failed; ' +
          'transparent passes lose their depth test.', err);
      }
      try {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        this.device.invalidateState();
      } catch (e) { /* context lost */ }
      return false;
    }
  }

  /**
   * Delete the scene colour and depth textures and their framebuffer.
   * @returns {void}
   * @private
   */
  _destroySceneTarget() {
    if (this._sceneFBO && typeof this._sceneFBO.dispose === 'function') {
      try { this._sceneFBO.dispose(); } catch (err) { /* already gone */ }
    }
    this._sceneFBO = null;
    for (const tex of [this._sceneTex, this._sceneDepth]) {
      if (!tex) continue;
      try { this.device.deleteTexture(tex); } catch (err) { /* already gone */ }
    }
    this._sceneTex = null;
    this._sceneDepth = null;
  }

  /* ======================================================================== */
  /* Quality                                                                  */
  /* ======================================================================== */

  /**
   * Apply a quality preset and rebuild only what actually changed.
   *
   * The preset is pushed through `settings.applyPreset()`, whose `change`
   * events flag the affected sub-systems; the rebuild then happens here, on the
   * caller's stack, never inside the event.
   *
   * @param {'potato'|'low'|'medium'|'high'|'ultra'|'cinematic'|string} preset Preset name.
   * @returns {boolean} `true` when the preset existed and was applied.
   */
  setQuality(preset) {
    const name = String(preset || '').trim();
    if (!QUALITY_PRESETS[name]) {
      console.warn(`[VOXELIA] renderer: unknown quality preset "${preset}".`);
      return false;
    }
    let applied = true;
    if (this.settings && typeof this.settings.applyPreset === 'function') {
      try {
        applied = this.settings.applyPreset(name) !== false;
      } catch (err) {
        console.error('[VOXELIA] renderer: applying the quality preset failed.', err);
        applied = false;
      }
    }
    this._applyPendingSettings(true);
    return applied;
  }

  /* ======================================================================== */
  /* Per-frame state                                                          */
  /* ======================================================================== */

  /**
   * Resolve the sun and moon directions for this frame.
   *
   * Prefers `environment.sunDir`; otherwise it rebuilds the same tilted arc
   * `render/sky.js` uses as its own fallback, so the sky, the shadows and the
   * `Frame` UBO always agree on where the sun is. The result is also published
   * as `frame.sunDir` / `frame.moonDir` (when the frame does not already carry
   * them) because `render/shadows.js` reads the key light from there.
   *
   * @param {Object} frame The render frame.
   * @param {?Object} env The environment state.
   * @param {number} timeOfDay Day fraction, 0..1.
   * @returns {void}
   * @private
   */
  _resolveSunMoon(frame, env, timeOfDay) {
    const sun = this._sunDir;
    const moon = this._moonDir;
    const src = (env && env.sunDir) || (frame && frame.sunDir) || null;

    if (isVec3(src)) {
      sun[0] = src[0]; sun[1] = src[1]; sun[2] = src[2];
    } else {
      const a = timeOfDay * Math.PI * 2;
      sun[0] = Math.cos(a);
      sun[1] = Math.sin(a) * Math.cos(SUN_ARC_TILT);
      sun[2] = Math.sin(a) * Math.sin(SUN_ARC_TILT);
    }
    let len = Math.hypot(sun[0], sun[1], sun[2]);
    if (!(len > 1e-6)) { sun[0] = 0; sun[1] = 1; sun[2] = 0; len = 1; }
    sun[0] /= len; sun[1] /= len; sun[2] /= len;

    const msrc = (env && env.moonDir) || (frame && frame.moonDir) || null;
    if (isVec3(msrc)) {
      moon[0] = msrc[0]; moon[1] = msrc[1]; moon[2] = msrc[2];
    } else {
      moon[0] = -sun[0]; moon[1] = -sun[1]; moon[2] = -sun[2];
    }
    let mlen = Math.hypot(moon[0], moon[1], moon[2]);
    if (!(mlen > 1e-6)) { moon[0] = 0; moon[1] = -1; moon[2] = 0; mlen = 1; }
    moon[0] /= mlen; moon[1] /= mlen; moon[2] /= mlen;

    // `render/shadows.js` picks its key light from frame.sunDir / frame.moonDir.
    try {
      if (!isVec3(frame.sunDir)) frame.sunDir = sun;
      if (!isVec3(frame.moonDir)) frame.moonDir = moon;
    } catch (err) { /* a frozen frame simply keeps the environment's own values */ }
  }

  /**
   * Fill and upload the `Frame` UBO in the exact std140 order of 3.3.
   *
   * See the module header for why the forward matrices are unjittered while the
   * inverses and `u_prevViewProj` are not.
   *
   * @param {Object} frame The render frame.
   * @param {Object} camera `frame.camera`.
   * @param {?Object} env The environment state.
   * @param {number} frameIndex Monotonic frame counter.
   * @param {number} dt Seconds since the previous frame.
   * @returns {void}
   * @private
   */
  _uploadFrameUBO(frame, camera, env, frameIndex, dt) {
    const f = this._frameData;
    const O = FRAME_UBO_OFFSETS;
    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);

    /* ---- matrices -------------------------------------------------------- */
    const view = isMat4(camera.view) ? camera.view : this._identity;
    const near = Math.max(1e-3, num(camera.near, 0.05));
    const far = Math.max(near + 1, num(camera.far, 1000));

    let proj;
    if (isMat4(camera.proj)) {
      proj = camera.proj;
    } else {
      const fov = clamp(num(camera.fov, num(this._setting('fov', 75), 75)), 20, 140);
      const aspect = num(camera.aspect, 0) > 0 ? camera.aspect : w / h;
      mat4.perspective(this._proj, fov * DEG2RAD, aspect, near, far);
      proj = this._proj;
    }
    const viewProj = isMat4(camera.viewProj)
      ? camera.viewProj
      : mat4.multiply(this._viewProj, proj, view);

    // TAA jitter: keep the previous value before asking for the new one.
    this._prevJitter[0] = this._jitter[0];
    this._prevJitter[1] = this._jitter[1];
    if (this.post && typeof this.post.getJitter === 'function') {
      this.post.getJitter(frameIndex, w, h, this._jitter);
    } else {
      this._jitter[0] = 0;
      this._jitter[1] = 0;
    }

    mat4.copy(this._projJ, proj);
    this._projJ[8] += this._jitter[0];
    this._projJ[9] += this._jitter[1];
    mat4.multiply(this._viewProjJ, this._projJ, view);
    mat4.invert(this._invView, view);
    mat4.invert(this._invProjJ, this._projJ);
    mat4.invert(this._invViewProjJ, this._viewProjJ);

    f.set(view, O.view);
    f.set(proj, O.proj);
    f.set(viewProj, O.viewProj);
    f.set(this._invView, O.invView);
    f.set(this._invProjJ, O.invProj);
    f.set(this._invViewProjJ, O.invViewProj);
    f.set(this._prevViewProjJ, O.prevViewProj);

    /* ---- camera ---------------------------------------------------------- */
    const pos = camera.position;
    this._camPos[0] = pos ? num(pos[0], 0) : 0;
    this._camPos[1] = pos ? num(pos[1], 0) : 0;
    this._camPos[2] = pos ? num(pos[2], 0) : 0;

    const fwd = camera.forward;
    if (isVec3(fwd)) {
      this._camDir[0] = fwd[0];
      this._camDir[1] = fwd[1];
      this._camDir[2] = fwd[2];
    } else {
      // Third row of a column-major view matrix is the camera's +Z axis.
      this._camDir[0] = -view[2];
      this._camDir[1] = -view[6];
      this._camDir[2] = -view[10];
    }
    const dlen = Math.hypot(this._camDir[0], this._camDir[1], this._camDir[2]);
    if (dlen > 1e-6) {
      this._camDir[0] /= dlen; this._camDir[1] /= dlen; this._camDir[2] /= dlen;
    } else {
      this._camDir[0] = 0; this._camDir[1] = 0; this._camDir[2] = -1;
    }

    f[O.camPos] = this._camPos[0];
    f[O.camPos + 1] = this._camPos[1];
    f[O.camPos + 2] = this._camPos[2];
    f[O.camPos + 3] = near;

    f[O.camDir] = this._camDir[0];
    f[O.camDir + 1] = this._camDir[1];
    f[O.camDir + 2] = this._camDir[2];
    f[O.camDir + 3] = far;

    /* ---- sun / moon ------------------------------------------------------ */
    const time = num(frame.time, 0);
    const timeOfDay = clamp(num(env && env.timeOfDay, fract(time / DAY_LENGTH_SECONDS)), 0, 1);
    this._resolveSunMoon(frame, env, timeOfDay);

    f[O.sunDir] = this._sunDir[0];
    f[O.sunDir + 1] = this._sunDir[1];
    f[O.sunDir + 2] = this._sunDir[2];
    f[O.sunDir + 3] = timeOfDay;

    let moonPhase = num(env && env.moonPhase, 0);
    if (moonPhase > 1.0001) moonPhase /= 8;
    f[O.moonDir] = this._moonDir[0];
    f[O.moonDir + 1] = this._moonDir[1];
    f[O.moonDir + 2] = this._moonDir[2];
    f[O.moonDir + 3] = clamp(fract(moonPhase), 0, 1);

    /* ---- sun colour ------------------------------------------------------ */
    const sky = this.sky;
    const ambient = sky && typeof sky.getAmbient === 'function' ? sky.getAmbient() : null;
    const sunColor = isVec3(env && env.sunColor)
      ? env.sunColor
      : (ambient && isVec3(ambient.sunColor) ? ambient.sunColor
        : (sky && isVec3(sky.sunColor) ? sky.sunColor : null));
    f[O.sunColor] = sunColor ? sunColor[0] : 1;
    f[O.sunColor + 1] = sunColor ? sunColor[1] : 1;
    f[O.sunColor + 2] = sunColor ? sunColor[2] : 1;
    f[O.sunColor + 3] = Math.max(0, num(env && env.sunIntensity,
      num(sky && sky.sunIntensity, 1)));

    /* ---- ambient --------------------------------------------------------- */
    const skyAmbient = ambient && isVec3(ambient.skyColor)
      ? ambient.skyColor
      : (isVec3(env && env.skyAmbient) ? env.skyAmbient : null);
    f[O.skyAmbient] = skyAmbient ? skyAmbient[0] : 0.20;
    f[O.skyAmbient + 1] = skyAmbient ? skyAmbient[1] : 0.34;
    f[O.skyAmbient + 2] = skyAmbient ? skyAmbient[2] : 0.52;
    f[O.skyAmbient + 3] = Math.max(0, num(ambient && ambient.intensity, 0.3));

    /* ---- fog ------------------------------------------------------------- */
    const fogColor = isVec3(env && env.fogColor)
      ? env.fogColor
      : (sky && isVec3(sky.fogColor) ? sky.fogColor : null);
    f[O.fogColor] = fogColor ? fogColor[0] : 0.55;
    f[O.fogColor + 1] = fogColor ? fogColor[1] : 0.66;
    f[O.fogColor + 2] = fogColor ? fogColor[2] : 0.82;
    f[O.fogColor + 3] = Math.max(0, num(env && env.fogDensity,
      num(sky && sky.fogDensity, 0.008)));

    this._clearColor[0] = f[O.fogColor];
    this._clearColor[1] = f[O.fogColor + 1];
    this._clearColor[2] = f[O.fogColor + 2];

    /* ---- screen ---------------------------------------------------------- */
    f[O.screen] = w;
    f[O.screen + 1] = h;
    f[O.screen + 2] = 1 / w;
    f[O.screen + 3] = 1 / h;

    /* ---- time ------------------------------------------------------------ */
    let rain = num(env && env.rainStrength, NaN);
    if (!Number.isFinite(rain)) {
      const weather = String((env && env.weather) || 'clear');
      rain = weather === 'clear' ? 0 : 1;
    }
    f[O.time] = time;
    f[O.time + 1] = dt;
    f[O.time + 2] = frameIndex;
    f[O.time + 3] = clamp(rain, 0, 1);

    /* ---- params ---------------------------------------------------------- */
    this._exposure = Math.max(0, num(this._setting('exposure', 1), 1));
    this._underwater = this._resolveUnderwater(frame, camera);
    f[O.params] = Math.max(16, num(this._setting('renderDistance', 10), 10) * 16);
    f[O.params + 1] = num(env && env.seaLevel, 62);
    f[O.params + 2] = this._exposure;
    f[O.params + 3] = this._underwater;

    /* ---- jitter ---------------------------------------------------------- */
    f[O.jitter] = this._jitter[0];
    f[O.jitter + 1] = this._jitter[1];
    f[O.jitter + 2] = this._prevJitter[0];
    f[O.jitter + 3] = this._prevJitter[1];

    if (this.frameUBO) {
      this.frameUBO.bind();
      this.frameUBO.update(f);
    }
  }

  /**
   * Decide whether the camera is submerged, from whichever field the game set.
   * @param {Object} frame The render frame.
   * @param {Object} camera `frame.camera`.
   * @returns {number} `1` when submerged, `0` otherwise.
   * @private
   */
  _resolveUnderwater(frame, camera) {
    const player = frame.player || null;
    const sources = [camera, frame, player];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (!s) continue;
      if (s.underwater === true || s.inWater === true || s.inLava === true) return 1;
      if (Number.isFinite(s.submerged) && s.submerged > 0.001) return 1;
    }
    const liquid = (player && player.liquid) || frame.liquid || null;
    if (liquid && (liquid.water === true || liquid.lava === true)) {
      return Number.isFinite(liquid.submerged) ? (liquid.submerged > 0.001 ? 1 : 0) : 1;
    }
    return 0;
  }

  /* ======================================================================== */
  /* The frame                                                                */
  /* ======================================================================== */

  /**
   * Render one frame.
   *
   * The single entry point per animation frame. Never throws: a failure in any
   * stage is caught, logged once and the remaining stages still run, so the
   * screen keeps updating.
   *
   * @param {Object} frame The frame descriptor — see {@link FrameShape}.
   * @returns {void}
   */
  render(frame) {
    if (this._disposed || !this.ready || !frame) return;

    const device = this.device;
    const gl = this.raw;
    const started = nowMs();

    try {
      this._applyPendingSettings();
      if (!this._syncSize()) return;

      const camera = frame.camera;
      if (!camera) return;

      const world = frame.world || null;
      const env = frame.environment || null;
      const entityList = frame.entities || null;
      const player = frame.player || null;
      this._frameEntities = entityList;
      this._framePlayer = player;

      const frameIndex = Number.isFinite(frame.frameIndex)
        ? (frame.frameIndex | 0)
        : this._frameCounter;
      this._frameCounter = (this._frameCounter + 1) & 0x3fffffff;
      const dt = clamp(num(frame.dt, 1 / 60), 0, 0.25);

      const gbuffer = this.gbuffer;
      const sceneFBO = this._sceneFBO;
      const sceneTex = this._sceneTex;

      device.setScissor(false);
      if (this._textureBusy) this._unbindTextureUnits();

      /* ---- a. sky LUTs, then the Frame UBO ------------------------------- */
      if (this.sky) {
        device.beginTimer('sky.lut');
        try { this.sky.update(frame, env); } catch (err) { this._reportFrameError(err); }
        device.endTimer('sky.lut');
      }
      this._uploadFrameUBO(frame, camera, env, frameIndex, dt);

      /* ---- b. shadow cascades -------------------------------------------- */
      if (this.shadows) {
        device.beginTimer('shadows');
        try {
          const active = this.shadows.computeCascades(frame);
          this.shadows.uploadUBO(this.shadowUBO);
          if (active && world) this.shadows.renderCascades(frame, world, entityList);
        } catch (err) {
          this._reportFrameError(err);
        }
        device.endTimer('shadows');
      }

      /* ---- c. G-buffer: terrain, entities, break overlay, held item ------- */
      device.beginTimer('gbuffer');
      try {
        gbuffer.bindForWriting();
        device.setScissor(false);
        gbuffer.clear(true, true);
        if (world) {
          gbuffer.renderTerrain(world, frame, { pass: 'opaque' });
          gbuffer.renderTerrain(world, frame, { pass: 'cutout' });
        }
        if (this.entities) {
          if (entityList || player) {
            this.entities.render(entityList, player, frame, world, { pass: 'gbuffer' });
          }
          if (this.drawBreakOverlay && frame.hit && num(frame.breakProgress, 0) > 0) {
            this.entities.renderBreakOverlay(frame.hit, frame.breakProgress, frame);
          }
          // Drawn last, into the depth slice it reserves for itself: this is the
          // only placement in which the hand receives real deferred lighting.
          if (this.drawHeldItem && player) {
            this.entities.renderHeldItem(player, frame, world);
          }
        }
      } catch (err) {
        this._reportFrameError(err);
      }
      // Hand the world depth to the scene target: from here on every forward
      // pass depth-tests against it while still being free to sample
      // `gbuffer.depth` as a texture.
      this._copySceneDepth();
      device.endTimer('gbuffer');

      /* ---- d. ambient occlusion ------------------------------------------ */
      if (this.ssao) {
        device.beginTimer('ssao');
        try { this.ssao.render(gbuffer, frame); } catch (err) { this._reportFrameError(err); }
        device.endTimer('ssao');
      }

      /* ---- e. deferred composite into the HDR scene ---------------------- */
      let lit = false;
      device.beginTimer('lighting');
      try {
        if (this.lighting) {
          lit = this.lighting.render(gbuffer, this.shadows, this.ssao, this.sky,
            frame, env, sceneFBO) === true;
        }
        if (!lit) {
          device.bindFramebuffer(sceneFBO);
          device.setScissor(false);
          device.clear(this._clearColor, false);
        }
      } catch (err) {
        this._reportFrameError(err);
      }
      device.endTimer('lighting');

      /* ---- f. sky where nothing was drawn -------------------------------- */
      if (this.sky) {
        device.beginTimer('sky');
        try {
          this.sky.renderBackground(frame, env, sceneFBO);
          // The background overwrote the composite's own cheap sky fill, so the
          // volumetric shafts have to be added back on top of it.
          if (lit && this.lighting) this.lighting.renderVolumetricOverlay(gbuffer, sceneFBO);
        } catch (err) {
          this._reportFrameError(err);
        }
        device.endTimer('sky');
      }

      /* ---- g. scene copy + water / transparent forward pass -------------- */
      if (this.water && sceneTex) {
        device.beginTimer('water');
        try {
          this.water.captureScene(sceneTex, gbuffer.depth, frameIndex);
          if (world) {
            this.water.render(world, frame, gbuffer, sceneTex, gbuffer.depth, sceneFBO);
          }
        } catch (err) {
          this._reportFrameError(err);
        }
        device.endTimer('water');
      }

      /* ---- h. particles and weather -------------------------------------- */
      const particles = (frame.particles && typeof frame.particles.render === 'function')
        ? frame.particles
        : this.particles;
      if (particles) {
        device.beginTimer('particles');
        try {
          // Only simulate the system we own, and only when the game did not
          // already advance it this frame.
          if (particles === this.particles && frame.particlesUpdated !== true) {
            particles.spawnWeather(env, this._camPos, dt);
            particles.update(dt, world, frame);
          }
          device.bindFramebuffer(sceneFBO);
          particles.render(frame, gbuffer);
        } catch (err) {
          this._reportFrameError(err);
        }
        device.endTimer('particles');
      }

      /* ---- i. block outline, debug geometry ------------------------------ */
      try {
        device.bindFramebuffer(sceneFBO);
        if (this.entities && this.drawBlockOutline && frame.hit) {
          this.entities.renderBlockOutline(frame.hit, frame, { pass: 'forward' });
        }
        if (this.debug) {
          if (world && this.debug.isEnabled('chunkBorders')) {
            this.debug.drawChunkBorders(world, this._camPos);
          }
          device.beginTimer('debug');
          this.debug.render(frame);
          device.endTimer('debug');
        }
      } catch (err) {
        this._reportFrameError(err);
      }

      /* ---- j. the held item was drawn with the G-buffer (see header) ------ */

      /* ---- k. underwater overlay ----------------------------------------- */
      if (this.water && sceneTex && this._underwater > 0) {
        try {
          this.water.renderUnderwaterOverlay(frame, sceneFBO, sceneTex, gbuffer.depth);
        } catch (err) {
          this._reportFrameError(err);
        }
      }

      /* ---- l. post-processing to the default framebuffer ------------------ */
      device.beginTimer('post');
      let presented = false;
      try {
        if (this.post && sceneTex) {
          this.post.render(sceneTex, gbuffer.depth, frame, true);
          presented = true;
        }
        if (!presented && sceneTex) presented = this._blitToScreen(sceneTex);
      } catch (err) {
        this._reportFrameError(err);
      }
      if (!presented) {
        device.bindFramebuffer(null);
        device.setScissor(false);
        device.clear(this._clearColor, true);
      }
      device.endTimer('post');

      /* ---- the performance overlay lives above the tonemapper ------------- */
      if (this.debug && this.debug.isEnabled('graph')) {
        try {
          device.bindFramebuffer(null);
          this.debug.renderOverlay(frame);
        } catch (err) {
          this._reportFrameError(err);
        }
      }

      /* ---- carry this frame's camera into the next one -------------------- */
      mat4.copy(this._prevViewProjJ, this._viewProjJ);
    } catch (err) {
      this._reportFrameError(err);
    } finally {
      this._frameEntities = null;
      this._framePlayer = null;
      this._collectStats(started);
      // Leave the state cache in a predictable place for whatever draws next.
      try {
        this.device.bindVertexArray(null);
        this.device.setBlend('none');
        this.device.setDepthWrite(true);
        gl.depthRange(0, 1);
      } catch (err) { /* context lost */ }
    }
  }

  /**
   * Present the HDR scene with a minimal exposure + ACES + sRGB pass.
   * Used only when `render/post.js` is unavailable.
   * @param {WebGLTexture} sceneTex HDR scene colour.
   * @returns {boolean} `true` when something was drawn.
   * @private
   */
  _blitToScreen(sceneTex) {
    const program = this._blit;
    if (!program || !sceneTex || !program.use()) return false;
    const device = this.device;
    const gl = this.raw;
    device.bindFramebuffer(null);
    device.setScissor(false);
    device.setDepthTest(false);
    device.setDepthWrite(false);
    device.setBlend('none');
    device.setCull('none');
    device.setColorMask(true, true, true, true);
    program.setTexture('u_sceneColor', sceneTex, UNIT_SCENE_COLOR, gl.TEXTURE_2D);
    program.setFloat('u_exposure', this._exposure);
    device.drawFullscreen();
    return true;
  }

  /* ======================================================================== */
  /* Statistics                                                               */
  /* ======================================================================== */

  /**
   * Gather draw counters, GPU timings and the frame-time history.
   * @param {number} started `nowMs()` at the top of {@link Renderer#render}.
   * @returns {void}
   * @private
   */
  _collectStats(started) {
    const stats = this.stats;
    const now = nowMs();

    stats.cpuMs = now - started;
    if (this._lastFrameAt > 0) {
      const delta = now - this._lastFrameAt;
      stats.frameMs = delta;
      stats.fps = delta > 0 ? 1000 / delta : 0;
      stats.frameTimes.push(delta);
      if (this.debug) this.debug.pushFrameTime(delta);
    }
    this._lastFrameAt = now;

    let drawCalls = 0;
    let triangles = 0;
    let sections = 0;

    const g = this.gbuffer && this.gbuffer.stats;
    if (g) {
      drawCalls += g.drawCalls + g.shadowDrawCalls;
      triangles += g.triangles + g.shadowTriangles;
      sections += g.sections;
    }
    const e = this.entities && this.entities.stats;
    if (e) {
      drawCalls += e.drawCalls;
      triangles += e.triangles;
      stats.entities = e.entities;
    } else {
      stats.entities = 0;
    }
    const w = this.water && this.water.stats;
    if (w) drawCalls += w.drawCalls;
    const l = this.lighting && this.lighting.stats;
    if (l) drawCalls += l.drawCalls;
    const d = this.debug && this.debug.stats;
    if (d) drawCalls += d.drawCalls;
    if (this.particles) {
      const p = this.particles.stats;
      stats.particles = this.particles.count;
      if (p && (p.alpha > 0 || p.additive > 0)) {
        drawCalls += (p.alpha > 0 ? 1 : 0) + (p.additive > 0 ? 1 : 0);
      }
    } else {
      stats.particles = 0;
    }

    stats.drawCalls = drawCalls;
    stats.triangles = Math.round(triangles);
    stats.sections = sections;

    let timings = null;
    try { timings = this.device.getTimings(); } catch (err) { timings = null; }
    if (timings) {
      stats.passes = timings;
      let gpu = 0;
      for (let i = 0; i < PASS_LABELS.length; i++) {
        const ms = timings[PASS_LABELS[i]];
        if (Number.isFinite(ms)) gpu += ms;
      }
      stats.gpuMs = gpu;
    }
  }

  /**
   * Log a per-frame failure exactly once, then keep going.
   * @param {*} err The error.
   * @returns {void}
   * @private
   */
  _reportFrameError(err) {
    if (this._frameErrorLogged) return;
    this._frameErrorLogged = true;
    console.error('[VOXELIA] renderer: a stage failed during the frame; the pipeline continues.', err);
  }

  /* ======================================================================== */
  /* Teardown                                                                 */
  /* ======================================================================== */

  /**
   * Release every GPU resource this renderer and its passes own.
   * Safe to call more than once.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.ready = false;

    if (this.settings && typeof this.settings.off === 'function') {
      try {
        if (this._onSettingChange) this.settings.off('change', this._onSettingChange);
        if (this._onSettingBulk) {
          this.settings.off('preset', this._onSettingBulk);
          this.settings.off('reset', this._onSettingBulk);
          this.settings.off('load', this._onSettingBulk);
        }
      } catch (err) { /* bus already torn down */ }
    }
    this._onSettingChange = null;
    this._onSettingBulk = null;

    const passes = ['debug', 'entities', 'particles', 'post', 'water', 'lighting',
      'sky', 'ssao', 'shadows', 'gbuffer', 'textures'];
    for (let i = 0; i < passes.length; i++) {
      const pass = this[passes[i]];
      if (pass && typeof pass.dispose === 'function') {
        try { pass.dispose(); } catch (err) { /* already gone */ }
      }
      this[passes[i]] = null;
    }

    this._destroySceneTarget();

    if (this._blit && typeof this._blit.dispose === 'function') {
      try { this._blit.dispose(); } catch (err) { /* already gone */ }
    }
    this._blit = null;

    for (const ubo of [this.frameUBO, this.shadowUBO]) {
      if (ubo && typeof ubo.dispose === 'function') {
        try { ubo.dispose(); } catch (err) { /* already gone */ }
      }
    }
    this.frameUBO = null;
    this.shadowUBO = null;

    this._frameEntities = null;
    this._framePlayer = null;
    this.stats.frameTimes.clear();
    this.width = 0;
    this.height = 0;
  }
}

export default Renderer;
