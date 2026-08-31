/**
 * @file render/shadows.js — VOXELIA cascaded shadow maps (spec 5.18).
 *
 * `ShadowMapper` owns a `DEPTH_COMPONENT32F` `TEXTURE_2D_ARRAY` with one layer
 * per cascade, computes stable light-space orthographic frusta for the camera's
 * shadow range and drives the depth-only geometry pass for every cascade.
 *
 * ### What "stable" means here
 *
 * A naive CSM recomputes a tight AABB around the 8 corners of each frustum slice
 * every frame. That AABB changes shape as soon as the camera *rotates*, so the
 * projection of every world texel drifts and the shadow edges crawl ("shimmer").
 * This implementation avoids that with the two classic fixes:
 *
 * 1. **Sphere extent** — each cascade is bounded by the *minimal sphere* around
 *    its frustum slice. The radius depends only on `(near, far, fovY, aspect)`,
 *    never on camera position or orientation, so the ortho extent is bit-exactly
 *    constant while the camera moves and turns.
 * 2. **Texel snapping** — the sphere centre is transformed into light space and
 *    snapped down to a whole shadow texel before the ortho box is built, so the
 *    world→texel mapping only ever changes in whole-texel steps.
 *
 * The near plane is additionally pushed *backwards* along the light direction
 * ("pancaking") so geometry behind the cascade still writes depth and therefore
 * still casts into it.
 *
 * ### Sampling contract
 *
 * The `shadows` GLSL chunk in `render/shaders/common.glsl.js` samples the array
 * with a plain `sampler2DArray` (`textureLod(u_shadowMap, vec3(uv, cascade), 0.0).r`)
 * and does its own PCF/PCSS, so:
 *
 * * `TEXTURE_COMPARE_MODE` **must stay off** (`createTexture` leaves it off
 *   because `compare` is not requested);
 * * filtering is `NEAREST` (depth textures are not filterable without compare);
 * * the cascade index is the **third texture coordinate**, i.e. the array layer;
 * * `u_csmMatrix[i] * vec4(worldPos, 1)` must land in clip space with
 *   `z` in `[-1, 1]` (`* 0.5 + 0.5` gives the stored depth), which is exactly
 *   what `mat4.ortho` produces.
 *
 * ### Who draws the geometry
 *
 * `ShadowMapper` never imports `render/gbuffer.js`. The caster is injected —
 * either an object with `renderShadowDepth(world, lightFrame, cascadeIndex)`
 * (the `GBuffer`) or a plain function with the same arguments. See
 * {@link ShadowMapper#setCaster} and {@link ShadowMapper#update}.
 *
 * @module render/shadows
 */

import { mat4, Frustum, clamp, DEG2RAD } from '../core/math.js';

/* ------------------------------------------------------------------------- */
/* Constants                                                                  */
/* ------------------------------------------------------------------------- */

/** Fixed texture unit of `u_shadowMap` (ARCHITECTURE.md 3.5). @type {number} */
export const SHADOW_TEXTURE_UNIT = 12;

/** UBO binding point of the `Shadows` block (ARCHITECTURE.md 3.4). @type {number} */
export const SHADOW_UBO_BINDING = 1;

/** Hard cap on cascades — `u_csmMatrix` is a `mat4[4]`. @type {number} */
export const MAX_SHADOW_CASCADES = 4;

/**
 * Size of the `Shadows` std140 block: `4 * mat4` + `3 * vec4`.
 * @type {number}
 */
export const SHADOW_UBO_BYTES = 4 * 64 + 3 * 16;

/** Float count of {@link SHADOW_UBO_BYTES}. @type {number} */
export const SHADOW_UBO_FLOATS = SHADOW_UBO_BYTES / 4;

/** Allowed shadow map edge sizes. @type {ReadonlyArray<number>} */
export const SHADOW_RESOLUTIONS = Object.freeze([512, 1024, 2048, 4096]);

/** Column-major identity, used to pad unused cascade slots. @type {Float32Array} */
const IDENTITY_MAT4 = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/** Scratch: light-space eye position (the light "camera" sits at the origin). */
const LIGHT_ORIGIN = new Float32Array(3);

/* ------------------------------------------------------------------------- */
/* ShadowMapper                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Cascaded shadow map renderer.
 *
 * Lifecycle: `new ShadowMapper(gl, settings)` → `update(frame, world, entities)`
 * once per frame → `uploadUBO(shadowsUbo)` → the lighting pass binds
 * {@link ShadowMapper#texture} to unit 12 (or calls {@link ShadowMapper#bind}).
 */
export class ShadowMapper {
  /**
   * @param {import('../core/gl.js').GL} gl VOXELIA WebGL2 device.
   * @param {{get:function(string):*, on?:function(string,Function):*,
   *          off?:function(string,Function):*}} [settings] settings store.
   */
  constructor(gl, settings) {
    /** @type {import('../core/gl.js').GL} Owning device. */
    this.device = gl;
    /** @type {WebGL2RenderingContext} Raw context. */
    this.gl = gl.gl;
    /** @type {?Object} Settings store (may be null in tests). */
    this.settings = settings || null;

    /** @type {boolean} Mirrors `settings.shadows`. */
    this.enabled = this._setting('shadows', true) !== false;
    /** @type {number} Shadow map edge size in texels. */
    this.resolution = this._resolveResolution(this._setting('shadowResolution', 2048));
    /** @type {number} Active cascade count, 1..4. */
    this.cascadeCount = clamp(Math.round(Number(this._setting('shadowCascades', 3)) || 3),
      1, MAX_SHADOW_CASCADES);

    /* ---- tunables -------------------------------------------------------- */

    /** @type {number} Practical-split blend, 1 = pure logarithmic, 0 = uniform. */
    this.lambda = 0.7;
    /**
     * Shadow range in world units; `0` derives it from `renderDistance`.
     * @type {number}
     */
    this.shadowDistance = 0;
    /**
     * World units the near plane is pushed back along the light so casters
     * *behind* the cascade still write depth (pancaking).
     * @type {number}
     */
    this.casterExtent = 220;
    /** @type {number} Constant depth bias expressed in cascade-0 texels. */
    this.depthBiasTexels = 2.5;
    /** @type {number} Normal/light offset in cascade texels (shader `u_shadowParams.z`). */
    this.normalBias = 1.75;
    /** @type {number} PCF kernel radius in texels (shader `u_shadowParams.w`). */
    this.softness = this._setting('softShadows', true) ? 1.6 : 1.0;
    /** @type {number} Auto-computed constant depth bias in normalized depth units. */
    this.depthBias = 0.0004;
    /** @type {'back'|'front'|'none'} Cull mode used while filling the cascades. */
    this.cullFace = 'back';
    /** @type {number} `glPolygonOffset` slope factor (the slope-scaled bias). */
    this.polygonOffsetFactor = 2.5;
    /** @type {number} `glPolygonOffset` constant units. */
    this.polygonOffsetUnits = 8;
    /**
     * Minimum |sun.y| before the sun is considered below the horizon and the
     * moon takes over as the key light.
     * @type {number}
     */
    this.horizonThreshold = 0.035;
    /** @type {boolean} Cast moon shadows when the sun is down. */
    this.useMoon = true;

    /* ---- GPU resources --------------------------------------------------- */

    /** @type {?WebGLTexture} `TEXTURE_2D_ARRAY`, `DEPTH_COMPONENT32F`. */
    this.texture = null;
    /** @type {?Object} Depth-only framebuffer (layer switched per cascade). */
    this.framebuffer = null;

    /* ---- per-cascade state ---------------------------------------------- */

    /** @type {Float32Array} 4 packed column-major light view-projections. */
    this.matrices = new Float32Array(MAX_SHADOW_CASCADES * 16);
    /** @type {Float32Array[]} Per-cascade views into {@link ShadowMapper#matrices}. */
    this.matrixViews = [];
    for (let i = 0; i < MAX_SHADOW_CASCADES; i++) {
      const view = this.matrices.subarray(i * 16, i * 16 + 16);
      view.set(IDENTITY_MAT4);
      this.matrixViews.push(view);
    }
    /** @type {Float32Array} View-space far distance of each cascade. */
    this.splits = new Float32Array(MAX_SHADOW_CASCADES);
    /** @type {Float32Array} View-space near distance of each cascade. */
    this.splitNears = new Float32Array(MAX_SHADOW_CASCADES);
    /** @type {Float32Array} World units covered by one shadow texel per cascade. */
    this.texelSizes = new Float32Array(MAX_SHADOW_CASCADES);
    /** @type {Float32Array} Bounding-sphere radius per cascade. */
    this.radii = new Float32Array(MAX_SHADOW_CASCADES);
    /** @type {Float32Array} Bounding-sphere centre per cascade (xyz packed). */
    this.centers = new Float32Array(MAX_SHADOW_CASCADES * 3);
    /** @type {Frustum[]} Light frustum per cascade, for caster culling. */
    this.frustums = [];
    for (let i = 0; i < MAX_SHADOW_CASCADES; i++) this.frustums.push(new Frustum());

    /** @type {Float32Array} Direction **towards** the key light (matches `u_sunDir`). */
    this.lightDir = new Float32Array([0.4, 0.82, 0.41]);
    /** @type {boolean} True while the moon (not the sun) is the key light. */
    this.usingMoon = false;
    /** @type {number} Number of cascades actually rendered last frame. */
    this.renderedCascades = 0;

    /* ---- scratch (no per-frame allocation) ------------------------------- */

    this._lightView = new Float32Array(16);
    this._lightProj = new Float32Array(16);
    this._camPos = new Float32Array(3);
    this._camFwd = new Float32Array(3);
    this._camUp = new Float32Array(3);
    this._camRight = new Float32Array(3);
    this._lightUp = new Float32Array(3);
    this._lightTarget = new Float32Array(3);
    this._uboData = new Float32Array(SHADOW_UBO_FLOATS);
    this._lightFrames = [];
    for (let i = 0; i < MAX_SHADOW_CASCADES; i++) this._lightFrames.push(this._makeLightFrame(i));

    /** @type {?Object|Function} Injected geometry caster. */
    this._caster = null;
    /** @type {Function[]} Extra per-cascade caster callbacks (entities, …). */
    this.extraCasters = [];
    /** @type {boolean} True once a failure has been reported (log once). */
    this._failed = false;
    /** @type {boolean} */
    this._disposed = false;

    this._onSettingsChange = (key) => this._handleSettingChange(key);
    if (this.settings && typeof this.settings.on === 'function') {
      this.settings.on('change', this._onSettingsChange);
    }

    this._createResources();
    this._resetCascades();
  }

  /* ----------------------------------------------------------------------- */
  /* Settings plumbing                                                        */
  /* ----------------------------------------------------------------------- */

  /**
   * Read a setting, tolerating a missing store or an unknown key.
   * @param {string} key setting key
   * @param {*} fallback value used when the setting is unavailable
   * @returns {*} the stored value or `fallback`
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
   * Snap an arbitrary number to the nearest supported shadow map size.
   * @param {number} value requested edge size
   * @returns {number} a power-of-two size the device can allocate
   * @private
   */
  _resolveResolution(value) {
    const requested = Math.round(Number(value) || 2048);
    let best = SHADOW_RESOLUTIONS[0];
    let bestDelta = Infinity;
    for (const candidate of SHADOW_RESOLUTIONS) {
      const delta = Math.abs(candidate - requested);
      if (delta < bestDelta) { bestDelta = delta; best = candidate; }
    }
    const limit = Math.max(512, this.device.caps.maxTexSize | 0);
    while (best > limit) best >>= 1;
    return Math.max(64, best);
  }

  /**
   * React to a settings change that affects the shadow pipeline.
   * @param {string} key changed key
   * @returns {void}
   * @private
   */
  _handleSettingChange(key) {
    if (this._disposed) return;
    if (key === 'shadows') {
      this.enabled = this._setting('shadows', true) !== false;
      return;
    }
    if (key === 'softShadows') {
      this.softness = this._setting('softShadows', true) ? 1.6 : 1.0;
      return;
    }
    if (key === 'shadowResolution' || key === 'shadowCascades') {
      this.resize(this._setting('shadowResolution', this.resolution),
        this._setting('shadowCascades', this.cascadeCount));
    }
  }

  /* ----------------------------------------------------------------------- */
  /* GPU resources                                                            */
  /* ----------------------------------------------------------------------- */

  /**
   * Allocate the depth array texture and the depth-only framebuffer.
   * Never throws; on failure the mapper disables itself.
   * @returns {boolean} true when the resources are usable
   * @private
   */
  _createResources() {
    const gl = this.gl;
    this._destroyResources();
    try {
      this.texture = this.device.createTexture({
        target: gl.TEXTURE_2D_ARRAY,
        width: this.resolution,
        height: this.resolution,
        depth: Math.max(1, this.cascadeCount),
        internalFormat: gl.DEPTH_COMPONENT32F,
        // Depth textures are not filterable without a compare mode, and the
        // `shadows` chunk explicitly does its own PCF, so NEAREST + no compare.
        min: 'nearest',
        mag: 'nearest',
        wrap: 'clamp',
        mips: false,
      });
      this.framebuffer = this.device.createFramebuffer({
        name: 'shadow-cascades',
        color: [],
        depth: this.texture,
        width: this.resolution,
        height: this.resolution,
      });
      if (!this.framebuffer.complete) {
        this._reportFailure('shadow framebuffer is incomplete');
        return false;
      }
      // Start with every layer cleared to "far" so a sampled-but-never-rendered
      // cascade reads as fully lit instead of as garbage.
      this.device.setScissor(false);
      for (let i = 0; i < this.cascadeCount; i++) {
        this.framebuffer.setDepthLayer(i);
        this.device.bindFramebuffer(this.framebuffer);
        this.device.clear(null, 1);
      }
      this.device.bindFramebuffer(null);
      return true;
    } catch (err) {
      this._reportFailure(err);
      return false;
    }
  }

  /**
   * Release the texture and framebuffer.
   * @returns {void}
   * @private
   */
  _destroyResources() {
    if (this.framebuffer) {
      try { this.framebuffer.dispose(); } catch (err) { /* already gone */ }
      this.framebuffer = null;
    }
    if (this.texture) {
      try { this.device.deleteTexture(this.texture); } catch (err) { /* already gone */ }
      this.texture = null;
    }
  }

  /**
   * Log a subsystem failure exactly once and disable shadow rendering.
   * @param {*} err error or message
   * @returns {void}
   * @private
   */
  _reportFailure(err) {
    if (this._failed) return;
    this._failed = true;
    this.enabled = false;
    console.error('[shadows] disabled after an initialisation failure:', err);
  }

  /**
   * Build the reusable per-cascade "light frame" handed to the caster.
   * @param {number} index cascade index
   * @returns {Object} frame-shaped descriptor with reusable buffers
   * @private
   */
  _makeLightFrame(index) {
    return {
      /** Frame-shaped camera describing the light's orthographic view. */
      camera: {
        position: new Float32Array(3),
        forward: new Float32Array(3),
        up: new Float32Array(3),
        right: new Float32Array(3),
        yaw: 0,
        pitch: 0,
        fov: 0,
        near: 0,
        far: 0,
        aspect: 1,
        orthographic: true,
        view: new Float32Array(16),
        proj: new Float32Array(16),
        // Shares storage with `matrices` / `matrixViews[index]`, so it is always
        // in sync with the cascade that was just computed.
        viewProj: this.matrixViews[index],
        // Shadow casters have no motion vectors; "previous == current" is the
        // only sane answer, but it gets its own storage so a consumer that
        // writes into it cannot corrupt the live matrix.
        prevViewProj: new Float32Array(16),
        frustum: this.frustums[index],
        underwater: false,
      },
      shadow: true,
      pass: 'shadow',
      cascade: index,
      cascadeCount: this.cascadeCount,
      resolution: this.resolution,
      // `matrix` / `lightViewProj` are this cascade's matrix; `matrices` and
      // `frustums` are the full per-cascade lists indexed by `cascadeIndex`.
      // A caster may use whichever shape it prefers — all of them agree.
      matrix: this.matrixViews[index],
      lightViewProj: this.matrixViews[index],
      matrices: this.matrixViews,
      frustums: this.frustums,
      frustum: this.frustums[index],
      lightDir: this.lightDir,
      center: this.centers.subarray(index * 3, index * 3 + 3),
      radius: 0,
      texelWorldSize: 0,
      splitNear: 0,
      splitFar: 0,
      world: null,
      entities: null,
      environment: null,
      time: 0,
      dt: 0,
      frameIndex: 0,
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Public API                                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * Inject the object (or callback) that draws shadow casters.
   *
   * Accepted shapes:
   * * an object with `renderShadowDepth(world, lightFrame, cascadeIndex)` —
   *   this is what `render/gbuffer.js` exposes (spec 5.17);
   * * a function `(world, lightFrame, cascadeIndex) => void`.
   *
   * @param {?Object|Function} caster caster object or callback
   * @returns {void}
   */
  setCaster(caster) {
    this._caster = caster || null;
  }

  /**
   * Bind the cascade array to its fixed unit on a program.
   * @param {{setTexture:function(string, WebGLTexture, number, number=):void}} program target program
   * @returns {void}
   */
  bind(program) {
    if (!program || typeof program.setTexture !== 'function' || !this.texture) return;
    program.setTexture('u_shadowMap', this.texture, SHADOW_TEXTURE_UNIT, this.gl.TEXTURE_2D_ARRAY);
  }

  /**
   * Reallocate the cascade array.
   * @param {number} [res] new edge size in texels (snapped to a supported size)
   * @param {number} [cascades] new cascade count, 1..4
   * @returns {boolean} true when the resources are usable afterwards
   */
  resize(res, cascades) {
    if (this._disposed) return false;
    const nextRes = this._resolveResolution(res === undefined ? this.resolution : res);
    const nextCascades = clamp(
      Math.round(Number(cascades === undefined ? this.cascadeCount : cascades)) || this.cascadeCount,
      1, MAX_SHADOW_CASCADES);
    if (nextRes === this.resolution && nextCascades === this.cascadeCount && this.texture) return true;

    const layersUnchanged = nextCascades === this.cascadeCount;
    this.resolution = nextRes;
    this.cascadeCount = nextCascades;
    for (const frame of this._lightFrames) {
      frame.resolution = nextRes;
      frame.cascadeCount = nextCascades;
    }
    this._failed = false;

    // Only the layer *count* forces a new texture object; a pure resolution
    // change reallocates in place so `this.texture` (unit 12) stays valid for
    // anything that already bound it.
    let ok;
    if (layersUnchanged && this.texture && this.framebuffer) {
      try {
        this.framebuffer.resize(nextRes, nextRes);
        ok = !!this.framebuffer.complete;
        if (ok) {
          this.device.setScissor(false);
          for (let i = 0; i < this.cascadeCount; i++) {
            this.framebuffer.setDepthLayer(i);
            this.device.bindFramebuffer(this.framebuffer);
            this.device.clear(null, 1);
          }
          this.device.bindFramebuffer(null);
        }
      } catch (err) {
        console.warn('[shadows] in-place resize failed, rebuilding the cascade array:', err);
        ok = false;
      }
      if (!ok) ok = this._createResources();
    } else {
      ok = this._createResources();
    }
    this._resetCascades();
    return ok;
  }

  /**
   * Reset every cascade to a harmless identity state (fully lit).
   * @returns {void}
   * @private
   */
  _resetCascades() {
    for (let i = 0; i < MAX_SHADOW_CASCADES; i++) {
      this.matrixViews[i].set(IDENTITY_MAT4);
      this.splits[i] = 1e9;
      this.splitNears[i] = 0;
      this.texelSizes[i] = 1;
      this.radii[i] = 0;
      this.centers[i * 3] = 0;
      this.centers[i * 3 + 1] = 0;
      this.centers[i * 3 + 2] = 0;
    }
    this.renderedCascades = 0;
  }

  /**
   * Recompute every cascade and render the shadow depth for each of them.
   *
   * @param {Object} frame the render frame (see `FrameShape`, spec 5.26)
   * @param {Object} world the world (forwarded verbatim to the caster)
   * @param {Object} [entities] entity manager (exposed as `lightFrame.entities`)
   * @param {?Object|Function} [caster] caster for this call; defaults to the one
   *        given to {@link ShadowMapper#setCaster}
   * @returns {boolean} true when cascades were rendered this frame
   */
  update(frame, world, entities, caster) {
    if (!this.computeCascades(frame)) return false;
    return this.renderCascades(frame, world, entities, caster);
  }

  /**
   * Recompute the light direction, the split scheme and every cascade matrix
   * **without** touching the GPU.
   *
   * Split out from {@link ShadowMapper#update} so an orchestrator that wants to
   * upload the `Shadows` UBO early (before the geometry passes) can do
   * `computeCascades(frame)` → `uploadUBO(ubo)` → `renderCascades(...)`.
   * Calling `update()` does all three in the natural order.
   *
   * @param {Object} frame the render frame
   * @returns {boolean} true when the matrices are valid this frame
   */
  computeCascades(frame) {
    if (this._disposed) return false;
    this.enabled = this._setting('shadows', true) !== false;
    if (!this.enabled || this._failed || !this.texture || !this.framebuffer) {
      this.renderedCascades = 0;
      return false;
    }
    const camera = frame && frame.camera ? frame.camera : null;
    if (!camera) {
      this.renderedCascades = 0;
      return false;
    }
    try {
      this._extractCamera(camera);
      this._selectLight(frame);
      this._buildCascades(camera);
      return true;
    } catch (err) {
      this._reportFailure(err);
      return false;
    }
  }

  /**
   * Render the depth of every cascade. Requires a preceding successful
   * {@link ShadowMapper#computeCascades} in the same frame.
   *
   * @param {Object} frame the render frame
   * @param {Object} world the world (forwarded verbatim to the caster)
   * @param {Object} [entities] entity manager (exposed as `lightFrame.entities`)
   * @param {?Object|Function} [caster] caster for this call
   * @returns {boolean} true when at least one cascade was drawn
   */
  renderCascades(frame, world, entities, caster) {
    if (this._disposed || !this.enabled || this._failed) return false;
    if (!this.texture || !this.framebuffer) return false;
    const target = caster || this._caster;
    if (!target) {
      // The matrices are valid; only the depth content is missing. Keep the
      // previous depth rather than flashing wrong shadows.
      this.renderedCascades = 0;
      return false;
    }
    return this._renderCascades(frame, world, entities, target);
  }

  /**
   * Fill the `Shadows` UBO (binding 1) exactly as ARCHITECTURE.md 3.4 requires.
   *
   * Layout (std140, 304 bytes):
   * `mat4 u_csmMatrix[4]` · `vec4 u_csmSplits` · `vec4 u_csmTexel` ·
   * `vec4 u_shadowParams(cascadeCount, depthBias, normalBias, softness)`.
   *
   * Unused cascade slots repeat the last valid cascade so a stray sample can
   * never read uninitialised memory, and `cascadeCount` is `0` while shadows are
   * disabled (which makes `sampleShadow` return "fully lit").
   *
   * @param {{update:function(Float32Array, number=):void}} ubo the Shadows UBO
   * @returns {Float32Array} the packed data that was uploaded
   */
  uploadUBO(ubo) {
    const data = this._uboData;
    const count = this.enabled && !this._failed
      ? clamp(this.cascadeCount, 1, MAX_SHADOW_CASCADES)
      : 0;
    const last = Math.max(0, count - 1);

    for (let i = 0; i < MAX_SHADOW_CASCADES; i++) {
      const src = i < count ? i : last;
      data.set(this.matrixViews[src], i * 16);
    }
    for (let i = 0; i < MAX_SHADOW_CASCADES; i++) {
      const src = i < count ? i : last;
      // Splits must stay monotonically non-decreasing: the shader compares
      // against .x/.y/.z in order before clamping to cascadeCount-1.
      data[64 + i] = count > 0 ? this.splits[src] : 1e9;
      data[68 + i] = count > 0 ? Math.max(this.texelSizes[src], 1e-5) : 1;
    }
    data[72] = count;
    data[73] = Math.max(this.depthBias, 0);
    data[74] = Math.max(this.normalBias, 0);
    data[75] = Math.max(this.softness, 0.5);

    if (ubo && typeof ubo.update === 'function') {
      try { ubo.update(data); } catch (err) { /* never throw during a frame */ }
    }
    return data;
  }

  /**
   * Delete every GPU resource and detach the settings listener.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.settings && typeof this.settings.off === 'function') {
      try { this.settings.off('change', this._onSettingsChange); } catch (err) { /* ignore */ }
    }
    this._destroyResources();
    this._caster = null;
    this.extraCasters.length = 0;
  }

  /* ----------------------------------------------------------------------- */
  /* Cascade construction                                                     */
  /* ----------------------------------------------------------------------- */

  /**
   * Copy (or derive) the camera basis into the scratch vectors.
   * @param {Object} camera frame camera
   * @returns {void}
   * @private
   */
  _extractCamera(camera) {
    const pos = camera.position;
    this._camPos[0] = pos ? pos[0] : 0;
    this._camPos[1] = pos ? pos[1] : 0;
    this._camPos[2] = pos ? pos[2] : 0;

    const view = camera.view;
    const fwd = camera.forward;
    const up = camera.up;
    const right = camera.right;

    if (fwd && up && right) {
      this._camFwd[0] = fwd[0]; this._camFwd[1] = fwd[1]; this._camFwd[2] = fwd[2];
      this._camUp[0] = up[0]; this._camUp[1] = up[1]; this._camUp[2] = up[2];
      this._camRight[0] = right[0]; this._camRight[1] = right[1]; this._camRight[2] = right[2];
    } else if (view && view.length >= 16) {
      // Column-major view matrix: rows of the rotation part are the basis.
      this._camRight[0] = view[0]; this._camRight[1] = view[4]; this._camRight[2] = view[8];
      this._camUp[0] = view[1]; this._camUp[1] = view[5]; this._camUp[2] = view[9];
      this._camFwd[0] = -view[2]; this._camFwd[1] = -view[6]; this._camFwd[2] = -view[10];
    } else {
      this._camFwd[0] = 0; this._camFwd[1] = 0; this._camFwd[2] = -1;
      this._camUp[0] = 0; this._camUp[1] = 1; this._camUp[2] = 0;
      this._camRight[0] = 1; this._camRight[1] = 0; this._camRight[2] = 0;
    }
    normalizeInto(this._camFwd);
    normalizeInto(this._camUp);
    normalizeInto(this._camRight);
  }

  /**
   * Pick the key light direction (sun, or moon after sunset) for this frame.
   * @param {Object} frame render frame
   * @returns {void}
   * @private
   */
  _selectLight(frame) {
    const env = frame && frame.environment ? frame.environment : null;
    let dir = (frame && frame.sunDir) || (env && env.sunDir) || null;
    let moon = (frame && frame.moonDir) || (env && env.moonDir) || null;
    this.usingMoon = false;

    if (this.useMoon && dir && moon && dir.length >= 3 && moon.length >= 3) {
      const sunUp = dir[1];
      const moonUp = moon[1];
      if (sunUp < this.horizonThreshold && moonUp > this.horizonThreshold) {
        dir = moon;
        this.usingMoon = true;
      }
    }

    if (dir && dir.length >= 3) {
      this.lightDir[0] = dir[0];
      this.lightDir[1] = dir[1];
      this.lightDir[2] = dir[2];
    } else {
      this.lightDir[0] = 0.4; this.lightDir[1] = 0.82; this.lightDir[2] = 0.41;
    }
    if (!normalizeInto(this.lightDir)) {
      this.lightDir[0] = 0.4; this.lightDir[1] = 0.82; this.lightDir[2] = 0.41;
      normalizeInto(this.lightDir);
    }
    // A light exactly on the horizon produces a degenerate ortho box; nudge it.
    if (Math.abs(this.lightDir[1]) < 0.02) {
      this.lightDir[1] = this.lightDir[1] >= 0 ? 0.02 : -0.02;
      normalizeInto(this.lightDir);
    }
  }

  /**
   * Resolve the world-space distance the cascades should cover.
   * @param {number} cameraFar camera far plane
   * @returns {number} shadow range in world units
   * @private
   */
  _resolveShadowDistance(cameraFar) {
    let distance = Number(this.shadowDistance);
    if (!Number.isFinite(distance) || distance <= 0) {
      const renderDistance = Number(this._setting('renderDistance', 10)) || 10;
      distance = clamp(renderDistance * 16 * 0.75, 64, 320);
    }
    const far = Number.isFinite(cameraFar) && cameraFar > 0 ? cameraFar : 1000;
    return Math.max(8, Math.min(distance, far));
  }

  /**
   * Build the practical split scheme and one stable light matrix per cascade.
   * @param {Object} camera frame camera
   * @returns {void}
   * @private
   */
  _buildCascades(camera) {
    const count = this.cascadeCount;
    const near = Math.max(0.01, Number(camera.near) || 0.05);
    const far = Math.max(this._resolveShadowDistance(Number(camera.far) || 1000), near + 1);

    const fovY = (Number(camera.fov) || 75) * DEG2RAD;
    let aspect = Number(camera.aspect);
    if (!Number.isFinite(aspect) || aspect <= 0) {
      const w = this.gl.drawingBufferWidth || 16;
      const h = this.gl.drawingBufferHeight || 9;
      aspect = w / Math.max(1, h);
    }
    const tanHalf = Math.tan(Math.min(Math.max(fovY, 0.05), 3.0) * 0.5);
    // m = squared radius factor of a frustum corner at unit depth.
    const m = tanHalf * tanHalf * (1 + aspect * aspect);
    const sqrtM = Math.sqrt(m);

    // ---- practical split scheme (log/uniform blend, lambda) ---------------
    // The logarithmic term is evaluated from a *scheme* near plane rather than
    // the camera's 5 cm near plane: `near * (far/near)^p` collapses the first
    // cascade to a couple of metres when `near` is that small, which wastes a
    // whole cascade on the inside of the player's own hand. Cascade 0 still
    // *starts* at the real near plane, so nothing is left unshadowed.
    const lambda = clamp(this.lambda, 0, 1);
    const schemeNear = Math.max(near, Math.min(1, far * 0.02));
    const schemeRange = Math.max(far - schemeNear, 0.1);
    const ratio = far / schemeNear;
    let sliceNear = near;
    for (let i = 0; i < count; i++) {
      const p = (i + 1) / count;
      const logSplit = schemeNear * Math.pow(ratio, p);
      const uniSplit = schemeNear + schemeRange * p;
      const sliceFar = i === count - 1 ? far : lambda * logSplit + (1 - lambda) * uniSplit;
      this.splitNears[i] = sliceNear;
      this.splits[i] = Math.max(sliceFar, sliceNear + 0.05);
      sliceNear = this.splits[i];
    }
    for (let i = count; i < MAX_SHADOW_CASCADES; i++) {
      this.splitNears[i] = this.splitNears[count - 1];
      this.splits[i] = this.splits[count - 1];
    }

    // ---- stable light basis (depends only on the light direction) ---------
    const L = this.lightDir;
    this._lightTarget[0] = -L[0];
    this._lightTarget[1] = -L[1];
    this._lightTarget[2] = -L[2];
    if (Math.abs(L[1]) > 0.995) {
      this._lightUp[0] = 0; this._lightUp[1] = 0; this._lightUp[2] = 1;
    } else {
      this._lightUp[0] = 0; this._lightUp[1] = 1; this._lightUp[2] = 0;
    }
    mat4.lookAt(this._lightView, LIGHT_ORIGIN, this._lightTarget, this._lightUp);
    const lv = this._lightView;

    const resolution = this.resolution;
    for (let i = 0; i < count; i++) {
      const n = this.splitNears[i];
      const f = this.splits[i];

      // ---- minimal bounding sphere of the frustum slice -------------------
      // Solving |corner(n) - (0,0,d)| == |corner(f) - (0,0,d)| gives
      // d = (f + n) * (m + 1) / 2. When that centre would sit past the far
      // plane the far corners alone define the sphere.
      let d = (f + n) * (m + 1) * 0.5;
      let radius;
      if (d >= f) {
        d = f;
        radius = f * sqrtM;
      } else {
        const dn = n - d;
        radius = Math.sqrt(m * n * n + dn * dn);
      }
      radius = Math.max(radius, 0.5);

      // ---- sphere centre in world space -----------------------------------
      const cx = this._camPos[0] + this._camFwd[0] * d;
      const cy = this._camPos[1] + this._camFwd[1] * d;
      const cz = this._camPos[2] + this._camFwd[2] * d;
      this.centers[i * 3] = cx;
      this.centers[i * 3 + 1] = cy;
      this.centers[i * 3 + 2] = cz;
      this.radii[i] = radius;

      // ---- snap the centre to whole shadow texels in light space ----------
      const texel = (radius * 2) / resolution;
      this.texelSizes[i] = texel;

      const lx = lv[0] * cx + lv[4] * cy + lv[8] * cz + lv[12];
      const ly = lv[1] * cx + lv[5] * cy + lv[9] * cz + lv[13];
      const lz = lv[2] * cx + lv[6] * cy + lv[10] * cz + lv[14];

      const sx = Math.floor(lx / texel) * texel;
      const sy = Math.floor(ly / texel) * texel;
      const sz = Math.floor(lz / texel) * texel;

      // The light "camera" looks down -Z, so a point in front of it has a
      // negative z; -sz is its distance along the light direction. Pushing the
      // near plane back by `casterExtent` is the pancaking that keeps casters
      // behind the cascade alive.
      const forwardDist = -sz;
      const zNear = forwardDist - radius - Math.max(this.casterExtent, 0);
      const zFar = forwardDist + radius;

      mat4.ortho(this._lightProj, sx - radius, sx + radius, sy - radius, sy + radius, zNear, zFar);
      const outMatrix = this.matrixViews[i];
      mat4.multiply(outMatrix, this._lightProj, lv);
      this.frustums[i].fromViewProj(outMatrix);

      // ---- keep the reusable light frame in sync --------------------------
      const lf = this._lightFrames[i];
      const lc = lf.camera;
      const distToEye = radius + Math.max(this.casterExtent, 0);
      lc.position[0] = cx + L[0] * distToEye;
      lc.position[1] = cy + L[1] * distToEye;
      lc.position[2] = cz + L[2] * distToEye;
      lc.forward[0] = -L[0]; lc.forward[1] = -L[1]; lc.forward[2] = -L[2];
      lc.up[0] = lv[1]; lc.up[1] = lv[5]; lc.up[2] = lv[9];
      lc.right[0] = lv[0]; lc.right[1] = lv[4]; lc.right[2] = lv[8];
      lc.near = zNear;
      lc.far = zFar;
      lc.aspect = 1;
      lc.fov = 0;
      lc.view.set(lv);
      lc.proj.set(this._lightProj);
      lc.prevViewProj.set(outMatrix);
      lf.radius = radius;
      lf.texelWorldSize = texel;
      lf.splitNear = n;
      lf.splitFar = f;
      lf.cascade = i;
      lf.cascadeCount = count;
      lf.resolution = resolution;
    }

    for (let i = count; i < MAX_SHADOW_CASCADES; i++) {
      this.matrixViews[i].set(this.matrixViews[count - 1]);
      this.texelSizes[i] = this.texelSizes[count - 1];
      this.radii[i] = this.radii[count - 1];
    }

    // ---- constant depth bias ---------------------------------------------
    // The shader scales `u_shadowParams.y` by texel_i / texel_0, so the value
    // stored here is expressed for cascade 0. Converting "N texels of world
    // space" into normalized depth needs cascade 0's depth range.
    const depthRange0 = 2 * this.radii[0] + Math.max(this.casterExtent, 0);
    this.depthBias = clamp(
      (this.depthBiasTexels * this.texelSizes[0]) / Math.max(depthRange0, 1e-3),
      1e-6, 0.02);
  }

  /* ----------------------------------------------------------------------- */
  /* Rendering                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * Render the depth of every cascade through the injected caster.
   * @param {Object} frame render frame
   * @param {Object} world world instance
   * @param {Object} entities entity manager
   * @param {Object|Function} caster caster object or callback
   * @returns {boolean} true when at least one cascade was drawn
   * @private
   */
  _renderCascades(frame, world, entities, caster) {
    const device = this.device;
    const gl = this.gl;
    const fbo = this.framebuffer;
    const count = this.cascadeCount;
    const isFn = typeof caster === 'function';
    const method = !isFn && caster && typeof caster.renderShadowDepth === 'function'
      ? caster.renderShadowDepth
      : null;
    if (!isFn && !method) {
      this.renderedCascades = 0;
      return false;
    }

    let drawn = 0;
    try {
      device.setScissor(false);
      device.setDepthTest(true);
      device.setDepthWrite(true);
      device.setDepthFunc(gl.LEQUAL);
      device.setBlend('none');
      device.setCull(this.cullFace);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(this.polygonOffsetFactor, this.polygonOffsetUnits);

      for (let i = 0; i < count; i++) {
        const lf = this._lightFrames[i];
        lf.world = world || null;
        lf.entities = entities || null;
        lf.environment = frame ? frame.environment || null : null;
        lf.time = frame ? frame.time || 0 : 0;
        lf.dt = frame ? frame.dt || 0 : 0;
        lf.frameIndex = frame ? frame.frameIndex || 0 : 0;

        fbo.setDepthLayer(i);
        device.bindFramebuffer(fbo);
        device.setViewport(0, 0, this.resolution, this.resolution);
        device.clear(null, 1);

        if (isFn) caster(world, lf, i);
        else method.call(caster, world, lf, i);

        for (let e = 0; e < this.extraCasters.length; e++) {
          const extra = this.extraCasters[e];
          if (typeof extra === 'function') extra(world, lf, i, entities);
        }
        drawn++;
      }
    } catch (err) {
      if (!this._failed) {
        this._failed = true;
        this.enabled = false;
        console.error('[shadows] cascade rendering failed; shadows disabled:', err);
      }
    } finally {
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(0, 0);
      device.setCull('back');
      device.bindFramebuffer(null);
    }

    this.renderedCascades = drawn;
    return drawn > 0;
  }

  /* ----------------------------------------------------------------------- */
  /* Debug helpers                                                            */
  /* ----------------------------------------------------------------------- */

  /**
   * Human readable snapshot for the F3 overlay.
   * @returns {{enabled:boolean, resolution:number, cascades:number,
   *            splits:number[], texels:number[], usingMoon:boolean,
   *            depthBias:number, memoryMB:number}} stats
   */
  getStats() {
    const bytes = this.texture ? this.resolution * this.resolution * this.cascadeCount * 4 : 0;
    const splits = [];
    const texels = [];
    for (let i = 0; i < this.cascadeCount; i++) {
      splits.push(Math.round(this.splits[i] * 100) / 100);
      texels.push(Math.round(this.texelSizes[i] * 10000) / 10000);
    }
    return {
      enabled: this.enabled && !this._failed,
      resolution: this.resolution,
      cascades: this.cascadeCount,
      splits,
      texels,
      usingMoon: this.usingMoon,
      depthBias: this.depthBias,
      memoryMB: bytes / (1024 * 1024),
    };
  }
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Normalize a 3-component array in place.
 * @param {Float32Array|number[]} v vector to normalize
 * @returns {boolean} false when the vector was degenerate (left untouched)
 */
function normalizeInto(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-8)) return false;
  const inv = 1 / len;
  v[0] *= inv; v[1] *= inv; v[2] *= inv;
  return true;
}

export default ShadowMapper;
