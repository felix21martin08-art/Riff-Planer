/**
 * @file game/game.js — the VOXELIA integrator (spec 5.40).
 *
 * Owns every subsystem, wires their events together and runs the one loop:
 * a fixed 20 TPS accumulator for `tick()` plus a variable-rate `frame()` that
 * interpolates the camera, drives world streaming, updates the DOM UI and calls
 * `renderer.render(frame)`.
 *
 * Design rules honoured here:
 *  - Nothing throws out of `tick()` or `frame()`. Every stage is guarded and a
 *    failure is rate-limited into a toast instead of a frozen tab.
 *  - A subsystem that fails to construct becomes `null`; the game keeps running
 *    without it.
 *  - No per-frame allocation on the hot path: the frame object, the menu camera
 *    and every scratch vector are created once.
 *  - All player-visible strings are German.
 */

import { GL } from '../core/gl.js';
import { Settings } from '../core/settings.js';
import { Input } from '../core/input.js';
import { EventBus, nowMs } from '../core/util.js';
import { mat4, vec3, Frustum, clamp } from '../core/math.js';

import { World } from '../world/world.js';
import { isSolid, isLiquid, blockByName } from '../world/blocks.js';
import { CHUNK_SIZE, SEA_LEVEL } from '../world/chunk.js';

import { Renderer } from '../render/renderer.js';

import { Player } from './player.js';
import { PlayerInventory, Container, createContainer } from './inventory.js';
import { smeltResult, fuelValue } from './crafting.js';
import { EntityManager } from './entities.js';
import { MobSpawner, setMobContext } from './mobs.js';
import { CombatSystem } from './combat.js';
import { Environment } from './environment.js';
import { Interaction } from './interaction.js';
import { AudioEngine } from './audio.js';
import { SaveManager } from './save.js';

import { HUD } from '../ui/hud.js';
import { ScreenManager } from '../ui/screens.js';
import { InventoryUI } from '../ui/inventory_ui.js';
import { DebugOverlay } from '../ui/debugoverlay.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Fixed simulation rate in ticks per second. @type {number} */
export const TICK_RATE = 20;

/** Duration of one fixed tick in seconds. @type {number} */
export const TICK_SECONDS = 1 / TICK_RATE;

/**
 * Hard cap on catch-up ticks per frame. A backgrounded tab can accumulate
 * minutes of simulation debt; running all of it would freeze the page on
 * return, so the surplus is dropped.
 * @type {number}
 */
export const MAX_CATCHUP_TICKS = 5;

/** Seconds between automatic saves. @type {number} */
export const AUTOSAVE_SECONDS = 30;

/** Render distance the living menu backdrop is allowed to stream. @type {number} */
export const MENU_RENDER_DISTANCE = 5;

/** Radians per second the menu camera orbits its demo world. @type {number} */
export const MENU_ORBIT_SPEED = 0.055;

/** Wall-clock budget for the initial world pump, in milliseconds. @type {number} */
export const LOAD_BUDGET_MS = 30000;

/** `world.update()` calls per pump iteration while the loading screen is up. @type {number} */
export const LOAD_PUMP_STEPS = 8;

/**
 * Milliseconds one pump burst may hold the main thread. `world.update()` budgets
 * itself, but several calls back to back still add up — this keeps the loading
 * animation alive while draining the queues far faster than one call per frame.
 * @type {number}
 */
export const LOAD_BURST_MS = 24;

/** Distance in blocks entities are still handed to the renderer. @type {number} */
export const ENTITY_RENDER_DISTANCE = 128;

/**
 * How often one failure tag may raise a toast. A subsystem that fails every
 * tick must report itself, then get out of the way.
 * @type {number}
 */
export const TOAST_LIMIT_PER_TAG = 3;

/** Highest world Y the spawn search will consider. @type {number} */
const SPAWN_SCAN_TOP = 316;

/** Lowest world Y the spawn search will consider. @type {number} */
const SPAWN_SCAN_BOTTOM = -60;

/** Fallback spawn height when the terrain cannot be probed at all. @type {number} */
const SPAWN_FALLBACK_Y = 100;

/** Widest the spawn search wanders from the origin column, in blocks. @type {number} */
const SPAWN_SEARCH_RADIUS = 64;

/** Column spacing of the spawn spiral, in blocks. @type {number} */
const SPAWN_SEARCH_STEP = 3;

/**
 * Lowest Y a spawn is still considered "on the surface". Below this the column
 * is a ravine or a cave mouth: usable, but only when nothing better is in range.
 * @type {number}
 */
const SPAWN_MIN_SURFACE_Y = SEA_LEVEL - 6;

/** Lazily built spawn offsets, sorted by distance. @type {?Int32Array} */
let spawnSpiralCache = null;

/**
 * Column offsets the spawn search visits, nearest first. Built once and reused,
 * because a world start must not allocate a fresh table every time.
 * @returns {Int32Array} Flat `[dx, dz, dx, dz, ...]` pairs, sorted by distance.
 */
function spawnSpiral() {
  if (spawnSpiralCache !== null) return spawnSpiralCache;
  const step = SPAWN_SEARCH_STEP;
  const span = Math.floor(SPAWN_SEARCH_RADIUS / step);
  /** @type {Array<[number, number, number]>} */
  const cells = [];
  for (let dz = -span; dz <= span; dz++) {
    for (let dx = -span; dx <= span; dx++) {
      const x = dx * step;
      const z = dz * step;
      cells.push([x * x + z * z, x, z]);
    }
  }
  cells.sort((a, b) => a[0] - b[0]);
  const out = new Int32Array(cells.length * 2);
  for (let i = 0; i < cells.length; i++) {
    out[i * 2] = cells[i][1];
    out[i * 2 + 1] = cells[i][2];
  }
  spawnSpiralCache = out;
  return out;
}

/**
 * Block name -> container kind for every right-clickable block that owns an
 * inventory. Blocks the registry does not know are skipped at build time.
 * @type {Readonly<Object<string, string>>}
 */
const CONTAINER_BLOCKS = Object.freeze({
  chest: 'chest',
  barrel: 'barrel',
  hopper: 'hopper',
  dispenser: 'dispenser',
  dropper: 'dispenser',
  furnace: 'furnace',
  blast_furnace: 'blast_furnace',
  smoker: 'smoker',
});

/**
 * Interaction kinds that open a screen but have no inventory behind them yet.
 * They get a German HUD hint instead of an empty window.
 * @type {Readonly<Object<string, string>>}
 */
const UNIMPLEMENTED_SCREENS = Object.freeze({
  enchanting: 'Der Zaubertisch hat noch keine Oberfläche.',
  anvil: 'Der Amboss hat noch keine Oberfläche.',
  brewing: 'Der Braustand hat noch keine Oberfläche.',
  beacon: 'Das Leuchtfeuer hat noch keine Oberfläche.',
});

/** Every state the game can be in. @type {ReadonlyArray<string>} */
export const STATES = Object.freeze([
  'boot', 'menu', 'loading', 'playing', 'paused', 'inventory', 'dead',
]);

/** States in which the simulation advances. @type {Set<string>} */
const SIMULATING = new Set(['playing', 'inventory']);

/** States in which the pointer should be locked to the canvas. @type {Set<string>} */
const POINTER_LOCKED = new Set(['playing']);

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/**
 * Finite number or fallback.
 * @param {*} v Candidate.
 * @param {number} fallback Replacement for non-numbers.
 * @returns {number} A usable number.
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build a camera object shaped exactly like `FrameShape.camera` (spec 5.26).
 * Used for the menu backdrop and while no player exists yet.
 * @returns {Object} A fresh camera record.
 */
function createCamera() {
  return {
    position: new Float32Array([0, SPAWN_FALLBACK_Y, 0]),
    forward: new Float32Array([0, 0, -1]),
    up: new Float32Array([0, 1, 0]),
    right: new Float32Array([1, 0, 0]),
    yaw: 0,
    pitch: -0.18,
    fov: 68,
    near: 0.05,
    far: 512,
    aspect: 16 / 9,
    view: mat4.create(),
    proj: mat4.create(),
    viewProj: mat4.create(),
    prevViewProj: mat4.identity(mat4.create()),
    frustum: new Frustum(),
    underwater: false,
  };
}

/**
 * Recompute a free camera's basis and matrices from its yaw/pitch/position.
 * @param {Object} cam A camera made by {@link createCamera}.
 * @returns {Object} The same camera, updated in place.
 */
function refreshCamera(cam) {
  const cp = Math.cos(cam.pitch);
  const fx = Math.sin(cam.yaw) * cp;
  const fy = Math.sin(cam.pitch);
  const fz = -Math.cos(cam.yaw) * cp;
  cam.forward[0] = fx; cam.forward[1] = fy; cam.forward[2] = fz;

  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  cam.right[0] = rx; cam.right[1] = 0; cam.right[2] = rz;

  cam.up[0] = -rz * fy;
  cam.up[1] = rz * fx - rx * fz;
  cam.up[2] = rx * fy;
  const ul = Math.hypot(cam.up[0], cam.up[1], cam.up[2]) || 1;
  cam.up[0] /= ul; cam.up[1] /= ul; cam.up[2] /= ul;

  const px = cam.position[0];
  const py = cam.position[1];
  const pz = cam.position[2];
  const ux = cam.up[0];
  const uy = cam.up[1];
  const uz = cam.up[2];

  mat4.copy(cam.prevViewProj, cam.viewProj);

  const view = cam.view;
  view[0] = rx; view[4] = 0; view[8] = rz; view[12] = -(rx * px + rz * pz);
  view[1] = ux; view[5] = uy; view[9] = uz; view[13] = -(ux * px + uy * py + uz * pz);
  view[2] = -fx; view[6] = -fy; view[10] = -fz; view[14] = fx * px + fy * py + fz * pz;
  view[3] = 0; view[7] = 0; view[11] = 0; view[15] = 1;

  if (!(cam.aspect > 0)) cam.aspect = 16 / 9;
  mat4.perspective(cam.proj, cam.fov * Math.PI / 180, cam.aspect, cam.near, cam.far);
  mat4.multiply(cam.viewProj, cam.proj, view);
  cam.frustum.fromViewProj(cam.viewProj);
  return cam;
}

/**
 * A read-only settings facade that clamps the render distance. The menu
 * backdrop must never stream a full render-distance world behind the title.
 * `world/world.js` only ever calls `get`, `on` and `off`, so this is enough.
 * @param {Object} settings The real settings store.
 * @param {number} maxDistance Highest render distance the facade reports.
 * @returns {Object} The facade.
 */
function clampedSettings(settings, maxDistance) {
  return {
    /**
     * @param {string} key Setting key.
     * @returns {*} The value, with `renderDistance` clamped.
     */
    get(key) {
      const v = settings.get(key);
      if (key !== 'renderDistance') return v;
      return Math.min(maxDistance, Number.isFinite(v) ? v : maxDistance);
    },
    /**
     * @param {string} key Setting key.
     * @returns {boolean} Whether the key exists.
     */
    has(key) {
      return typeof settings.has === 'function' ? settings.has(key) : true;
    },
    /**
     * @param {string} evt Event name.
     * @param {Function} fn Listener.
     * @returns {void}
     */
    on(evt, fn) { settings.on(evt, fn); },
    /**
     * @param {string} evt Event name.
     * @param {Function} fn Listener.
     * @returns {void}
     */
    off(evt, fn) { settings.off(evt, fn); },
  };
}

/* ========================================================================== */
/* Game                                                                       */
/* ========================================================================== */

/**
 * The VOXELIA game: one canvas, one loop, every subsystem.
 *
 * ```js
 * const game = new Game(document.getElementById('gl'));
 * await game.boot((p, label) => showBar(p, label));
 * game.start();
 * ```
 */
export class Game extends EventBus {
  /**
   * @param {HTMLCanvasElement} canvas The `#gl` canvas the game renders into.
   * @param {{uiRoot?:HTMLElement}} [options] Optional overrides; `uiRoot`
   *   defaults to `#ui` (or the document body).
   */
  constructor(canvas, options = {}) {
    super();

    /** @type {HTMLCanvasElement} The render surface. */
    this.canvas = canvas;
    /** @type {?HTMLElement} DOM root every UI layer is mounted into. */
    this.uiRoot = options.uiRoot
      || (typeof document !== 'undefined' ? document.getElementById('ui') : null)
      || (typeof document !== 'undefined' ? document.body : null);

    /* ---- core ------------------------------------------------------------ */
    /** @type {?GL} WebGL2 device. */
    this.gl = null;
    /** @type {?Settings} Persisted settings. */
    this.settings = null;
    /** @type {?Input} Keyboard/mouse/touch/gamepad. */
    this.input = null;
    /** @type {?Renderer} Deferred PBR pipeline. */
    this.renderer = null;
    /** @type {?AudioEngine} Procedural audio. */
    this.audio = null;
    /** @type {?SaveManager} IndexedDB persistence. */
    this.save = null;

    /* ---- world & gameplay ------------------------------------------------ */
    /** @type {?World} The world being played, `null` in the menu. */
    this.world = null;
    /** @type {?World} Small demo world rendered behind the main menu. */
    this.menuWorld = null;
    /** @type {?Player} The local player. */
    this.player = null;
    /** @type {?EntityManager} Dropped items, mobs, projectiles, TNT. */
    this.entities = null;
    /** @type {?MobSpawner} Natural mob spawning. */
    this.mobs = null;
    /** @type {?CombatSystem} Health, hunger, damage, XP. */
    this.combat = null;
    /** @type {?Environment} Time of day and weather of the played world. */
    this.environment = null;
    /** @type {?Environment} Time of day for the menu backdrop. */
    this.menuEnvironment = null;
    /** @type {?Interaction} Raycast, break, place, use. */
    this.interaction = null;
    /** @type {?Object} Particle system (owned by the renderer). */
    this.particles = null;
    /** @type {?Object} Metadata record of the world currently loaded. */
    this.worldMeta = null;

    /* ---- ui -------------------------------------------------------------- */
    /**
     * The DOM UI managers.
     * @type {{hud:?HUD, screens:?ScreenManager, inventory:?InventoryUI, debug:?DebugOverlay}}
     */
    this.ui = { hud: null, screens: null, inventory: null, debug: null };
    /** @type {?ScreenManager} Alias so screens can be reached as `game.screens`. */
    this.screens = null;
    /** @type {?HUD} Alias so the HUD can be reached as `game.hud`. */
    this.hud = null;

    /* ---- state ----------------------------------------------------------- */
    /** @type {'boot'|'menu'|'loading'|'playing'|'paused'|'inventory'|'dead'} */
    this.state = 'boot';
    /** @type {boolean} True once {@link Game#boot} finished successfully. */
    this.booted = false;
    /** @type {boolean} True while the rAF loop is scheduled. */
    this.running = false;
    /** @type {boolean} True once {@link Game#dispose} ran. */
    this.disposed = false;

    /**
     * Live performance counters. `tools/smoke.mjs` reads `fps`.
     * @type {{fps:number, tps:number, frameMs:number, tickMs:number,
     *   frames:number, ticks:number, dt:number, alpha:number, state:string}}
     */
    this.stats = {
      fps: 0, tps: 0, frameMs: 0, tickMs: 0,
      frames: 0, ticks: 0, dt: 1 / 60, alpha: 1, state: 'boot',
    };

    /* ---- loop bookkeeping ------------------------------------------------ */
    /** @type {number} rAF handle. @private */
    this._raf = 0;
    /** @type {number} Timestamp of the previous frame. @private */
    this._lastFrameAt = 0;
    /** @type {number} Timestamp of the previous presented frame (fps cap). @private */
    this._lastPresentAt = 0;
    /** @type {number} Unspent simulation time in seconds. @private */
    this._accumulator = 0;
    /** @type {number} Interpolation alpha of the current frame. @private */
    this._alpha = 1;
    /** @type {number} Frames counted in the current second. @private */
    this._fpsFrames = 0;
    /** @type {number} Ticks counted in the current second. @private */
    this._fpsTicks = 0;
    /** @type {number} Start of the current statistics second. @private */
    this._fpsAt = 0;
    /** @type {number} Milliseconds spent inside the last frame body. @private */
    this._frameMs = 0;
    /** @type {number} `document.hidden` mirror. @private */
    this._hidden = false;
    /** @type {number} Cached `maxFps` setting. @private */
    this._maxFps = 0;
    /** @type {number} Seconds since the last autosave. @private */
    this._sinceSave = 0;
    /** @type {boolean} True while an autosave is in flight. @private */
    this._saving = false;
    /** @type {boolean} A screenshot was requested by the `screenshot` action. @private */
    this._wantScreenshot = false;
    /** @type {number} `nowMs()` of the last error toast. @private */
    this._lastErrorAt = -1e9;
    /** @type {Set<string>} Failure tags already logged. @private */
    this._logged = new Set();
    /** @type {Map<string, number>} Toasts already shown per failure tag. @private */
    this._toasted = new Map();
    /** @type {number} Guard against re-entrant world switches. @private */
    this._loadToken = 0;
    /** @type {number} Seconds left before the "click to lock" hint repeats. @private */
    this._lockHint = 0;

    /* ---- reusable objects (never allocated per frame) -------------------- */
    /** @type {Object} The frame record handed to the renderer. @private */
    this._frame = {
      camera: null, world: null, entities: null, player: null, environment: null,
      particles: null, hit: null, breakProgress: 0, time: 0, dt: 1 / 60,
      alpha: 1, frameIndex: 0, particlesUpdated: false,
    };
    /** @type {Object} Camera used for the menu backdrop and during loading. @private */
    this._menuCamera = createCamera();
    /** @type {Float32Array} Orbit centre of the menu camera. @private */
    this._menuCenter = new Float32Array([0, SPAWN_FALLBACK_Y, 0]);
    /** @type {number} Menu orbit angle in radians. @private */
    this._menuAngle = 0.6;
    /** @type {Object} Shared entity/mob update context. @private */
    this._ctx = {
      manager: null, world: null, player: null, entities: null, particles: null,
      audio: null, environment: null, combat: null, difficulty: 2, time: 0, dt: 0,
    };
    /** @type {Map<string, Container>} Block-backed containers by `"x,y,z"`. @private */
    this._containers = new Map();
    /** @type {Map<number, string>} Block id -> container kind. @private */
    this._containerKinds = new Map();
    /** @type {Container[]} Furnaces that need ticking, refreshed on mutation. @private */
    this._furnaces = [];
    /** @type {Float32Array} Scratch eye position for the audio listener. @private */
    this._listenerPos = new Float32Array(3);
    /** @type {number} Seconds since the ambience was last re-evaluated. @private */
    this._ambienceTimer = 0;
    /** @type {string} Signature of the ambience currently pushed to audio. @private */
    this._ambienceSignature = '';

    /* ---- bound handlers -------------------------------------------------- */
    /** @type {function(number):void} @private */
    this._boundFrame = (now) => this.frame(now);
    /** @type {function():void} @private */
    this._onVisibility = () => this._handleVisibility();
    /** @type {function():void} @private */
    this._onBeforeUnload = () => { this._flushOnExit(); };
    /** @type {function(PointerEvent):void} @private */
    this._onCanvasPointerDown = () => this._handleCanvasPointer();
    /** @type {function(boolean):void} @private */
    this._onLockChange = (locked) => this._handleLockChange(locked);
    /** @type {function():void} @private */
    this._onFirstGesture = () => this._unlockAudio();
    /** @type {function(string):void} @private */
    this._onSettingChanged = (key) => this._handleSettingChanged(key);
    /** @type {function():void} @private */
    this._onResize = () => this._handleResize();

    // Spec 5.40: the running instance is reachable from the console and from
    // the automated smoke test as `window.game`.
    if (typeof window !== 'undefined') window.game = this;
  }

  /* ====================================================================== */
  /* Boot                                                                    */
  /* ====================================================================== */

  /**
   * Build every subsystem and end up in the `'menu'` state with a living
   * backdrop behind the title.
   *
   * Only the WebGL2 device is fatal: everything else degrades to `null` and the
   * game keeps running without it.
   *
   * @param {?function(number, string):void} [onProgress] Receives
   *   `(fraction, germanLabel)` while booting.
   * @returns {Promise<boolean>} `true` when the menu is up.
   */
  async boot(onProgress) {
    if (this.booted) return true;

    /**
     * Report progress to the caller, the loading screen and the boot splash.
     * @param {number} fraction Progress `0..1`.
     * @param {string} label German step name.
     * @returns {void}
     */
    const report = (fraction, label) => {
      const f = clamp(num(fraction, 0), 0, 1);
      this.emit('progress', f, label);
      if (typeof onProgress === 'function') {
        try { onProgress(f, label); } catch { /* a broken splash never blocks boot */ }
      }
    };

    report(0.01, 'Grafikgerät wird geöffnet');
    // The only hard requirement: without WebGL2 there is no game at all.
    this.gl = new GL(this.canvas, {});

    report(0.03, 'Einstellungen werden geladen');
    this.settings = this._construct('settings', () => new Settings());
    if (this.settings) {
      this._maxFps = Math.max(0, num(this.settings.get('maxFps'), 0));
      this.settings.on('change', this._onSettingChanged);
    }

    report(0.05, 'Eingabe wird eingerichtet');
    this.input = this._construct('input', () => new Input(this.canvas, {
      settings: this.settings,
    }));
    if (this.input) {
      this.input.on('lockchange', this._onLockChange);
      this.input.setEnabled(false);
    }

    report(0.07, 'Audio wird vorbereitet');
    this.audio = this._construct('audio', () => new AudioEngine(this.settings));

    report(0.09, 'Speicher wird geöffnet');
    this.save = this._construct('save', () => new SaveManager('voxelia', {
      onError: (code, error, message) => this._fail(`save:${code}`, error, message),
    }));
    if (this.save) {
      try { await this.save.open(); } catch (err) { this._fail('save:open', err); }
    }

    report(0.11, 'Renderer wird gebaut');
    this.renderer = this._construct('renderer', () => new Renderer(this.gl, this.settings));
    if (this.renderer) {
      try {
        await this.renderer.init((f, label) => report(0.11 + clamp(f, 0, 1) * 0.72, label || 'Renderer'));
      } catch (err) {
        this._fail('renderer:init', err);
      }
      this.particles = this.renderer.particles || null;
    }

    report(0.85, 'Oberfläche wird aufgebaut');
    this._buildUI();

    report(0.88, 'Menüwelt wird erzeugt');
    await this._buildMenuWorld((f) => report(0.88 + clamp(f, 0, 1) * 0.1, 'Menüwelt wird erzeugt'));

    this._installGlobalListeners();
    this.booted = true;

    report(0.99, 'Bereit');
    this.setState('menu');
    if (this.ui.screens) this.ui.screens.show('mainmenu');
    report(1, 'Bereit');
    this.emit('booted', this);
    return true;
  }

  /**
   * Construct one subsystem inside its own guard.
   * @param {string} name Field name, used for the error tag.
   * @param {function():*} factory Constructor thunk.
   * @returns {*} The instance, or `null` when it threw.
   * @private
   */
  _construct(name, factory) {
    try {
      return factory() || null;
    } catch (err) {
      this._fail(`init:${name}`, err, `Teilsystem „${name}" konnte nicht gestartet werden.`);
      return null;
    }
  }

  /**
   * Create the four DOM UI managers and wire the ones that talk back.
   * @returns {void}
   * @private
   */
  _buildUI() {
    const root = this.uiRoot;
    this.ui.screens = this._construct('screens', () => new ScreenManager(this, root));
    this.ui.hud = this._construct('hud', () => new HUD(this, root));
    this.ui.inventory = this._construct('inventory_ui', () => new InventoryUI(this, root));
    this.ui.debug = this._construct('debugoverlay', () => new DebugOverlay(this, root));
    this.screens = this.ui.screens;
    this.hud = this.ui.hud;
    if (this.ui.hud) this.ui.hud.hide();
  }

  /**
   * Install the window/document listeners the loop depends on.
   * @returns {void}
   * @private
   */
  _installGlobalListeners() {
    if (typeof window === 'undefined') return;
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('beforeunload', this._onBeforeUnload);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('pointerdown', this._onFirstGesture, { once: true });
    window.addEventListener('keydown', this._onFirstGesture, { once: true });
    if (this.canvas) this.canvas.addEventListener('pointerdown', this._onCanvasPointerDown);
  }

  /**
   * Start the WebAudio graph. Browsers only allow this from a user gesture, so
   * it hangs off the very first click or key press.
   * @returns {void}
   * @private
   */
  _unlockAudio() {
    const audio = this.audio;
    if (!audio || audio.ready || audio.failed) return;
    Promise.resolve(audio.init())
      .then((ok) => {
        if (!ok) return;
        audio.setAutoMood(true);
        if (SIMULATING.has(this.state)) audio.startMusic('calm');
      })
      .catch((err) => this._fail('audio:init', err));
  }

  /* ====================================================================== */
  /* Menu backdrop                                                           */
  /* ====================================================================== */

  /**
   * Generate the small demo world the main menu orbits over.
   * @param {?function(number):void} [onProgress] Progress sink, `0..1`.
   * @returns {Promise<void>} Resolves once the backdrop is presentable.
   * @private
   */
  async _buildMenuWorld(onProgress) {
    if (!this.gl || !this.settings || this.disposed) return;
    if (this.menuWorld) return;
    /**
     * @param {number} f Progress `0..1`.
     * @returns {void}
     */
    const report = (f) => {
      if (typeof onProgress === 'function') onProgress(f);
    };
    const seed = (Math.random() * 0x7fffffff) | 0;
    this.menuWorld = this._construct('menuWorld', () => new World(
      this.gl, clampedSettings(this.settings, MENU_RENDER_DISTANCE),
      { seed, name: 'menu', id: '__menu__' }));
    this.menuEnvironment = this._construct('menuEnvironment',
      () => new Environment(this.settings, seed));

    if (this.menuEnvironment) {
      // Late afternoon: long shadows and a warm sky make the best backdrop.
      this.menuEnvironment.setTime(0.42);
      this.menuEnvironment.setFrozen(false);
    }
    if (!this.menuWorld) return;

    try {
      await this.menuWorld.init();
    } catch (err) {
      this._fail('menuWorld:init', err);
      return;
    }

    const cam = this._menuCamera;
    vec3.set(this._menuCenter, 8, SPAWN_FALLBACK_Y, 8);
    this._placeMenuCamera();

    // Two seconds is plenty for a five-chunk radius and keeps boot snappy; the
    // rest streams in while the player reads the menu.
    const deadline = nowMs() + 2500;
    while (nowMs() < deadline) {
      // A world start (or `dispose`) can drop the backdrop while this is still
      // yielding between bursts.
      const menu = this.menuWorld;
      if (menu === null || this.disposed) return;
      const burst = nowMs();
      for (let i = 0; i < LOAD_PUMP_STEPS; i++) {
        try {
          menu.update(1 / 60, cam.position, cam.frustum);
        } catch (err) {
          this._fail('menuWorld:update', err);
          return;
        }
        if (nowMs() - burst > LOAD_BURST_MS) break;
      }
      let st = null;
      try { st = menu.getStats(); } catch { st = null; }
      if (st) {
        report(clamp(st.sections / 220, 0, 1));
        if (menu.isLoaded(0, 0)) this._placeMenuCamera();
        if (st.queued === 0 && st.generating === 0 && st.meshing === 0 && st.sections > 0) break;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    report(1);
  }

  /**
   * Park the menu orbit centre on the terrain surface of the demo world.
   * @returns {void}
   * @private
   */
  _placeMenuCamera() {
    const world = this.menuWorld;
    if (!world) return;
    let h = SPAWN_FALLBACK_Y;
    try {
      const probe = world.getHeight(8, 8);
      if (Number.isFinite(probe)) h = probe;
    } catch { /* generator not ready yet */ }
    this._menuCenter[1] = clamp(h + 14, 40, 220);
  }

  /**
   * Advance the slow orbit of the menu camera.
   * @param {number} dt Frame time in seconds.
   * @returns {Object} The menu camera.
   * @private
   */
  _updateMenuCamera(dt) {
    const cam = this._menuCamera;
    this._menuAngle += dt * MENU_ORBIT_SPEED;
    if (this._menuAngle > Math.PI * 2) this._menuAngle -= Math.PI * 2;

    const radius = 42;
    const cx = this._menuCenter[0];
    const cy = this._menuCenter[1];
    const cz = this._menuCenter[2];
    cam.position[0] = cx + Math.sin(this._menuAngle) * radius;
    cam.position[1] = cy + 9 + Math.sin(this._menuAngle * 0.7) * 3.5;
    cam.position[2] = cz + Math.cos(this._menuAngle) * radius;

    // Always look back at the centre of the demo world.
    const dx = cx - cam.position[0];
    const dy = (cy - 4) - cam.position[1];
    const dz = cz - cam.position[2];
    cam.yaw = Math.atan2(dx, -dz);
    cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    cam.fov = clamp(num(this.settings && this.settings.get('fov'), 70), 30, 120);
    cam.aspect = this._aspect();
    cam.far = 640;

    const world = this.menuWorld;
    if (world && typeof world.getBlock === 'function') {
      const id = world.getBlock(
        Math.floor(cam.position[0]), Math.floor(cam.position[1]), Math.floor(cam.position[2]));
      cam.underwater = id !== 0 && isLiquid(id);
    }
    return refreshCamera(cam);
  }

  /**
   * Current canvas aspect ratio.
   * @returns {number} Width over height, never zero.
   * @private
   */
  _aspect() {
    const gl = this.gl && this.gl.gl;
    if (gl && gl.drawingBufferHeight > 0) return gl.drawingBufferWidth / gl.drawingBufferHeight;
    const c = this.canvas;
    if (c && c.clientHeight > 0) return c.clientWidth / c.clientHeight;
    return 16 / 9;
  }

  /* ====================================================================== */
  /* World lifecycle                                                         */
  /* ====================================================================== */

  /**
   * Create a brand new world and drop the player into it.
   * @param {{seed?:number, name?:string, gameMode?:string, generator?:string,
   *   generatorOptions?:Object, seedText?:string}} [config] World configuration
   *   as produced by the world-create screen.
   * @returns {Promise<boolean>} `true` when the world is playable.
   */
  async startWorld(config = {}) {
    const cfg = config && typeof config === 'object' ? config : {};
    const seed = Number.isFinite(Number(cfg.seed))
      ? (Number(cfg.seed) | 0)
      : ((Math.random() * 0x7fffffff) | 0);
    const name = typeof cfg.name === 'string' && cfg.name.trim().length !== 0
      ? cfg.name.trim().slice(0, 64) : 'Neue Welt';
    const gameMode = typeof cfg.gameMode === 'string' ? cfg.gameMode : 'survival';

    let meta = {
      id: '', name, seed, gameMode,
      generator: typeof cfg.generator === 'string' ? cfg.generator : 'default',
      created: Date.now(), lastPlayed: Date.now(), playTime: 0,
    };
    if (this.save) {
      try {
        const created = await this.save.createWorld(meta);
        if (created) meta = created;
      } catch (err) {
        this._fail('save:createWorld', err);
      }
    }
    if (!meta.id) meta.id = `local-${Date.now().toString(36)}`;

    return this._enterWorld(meta, cfg.generatorOptions || null, null);
  }

  /**
   * Load a stored world and restore the player, entities and clock.
   * @param {string} id World id from the save manager.
   * @returns {Promise<boolean>} `true` when the world is playable.
   */
  async loadWorld(id) {
    if (typeof id !== 'string' || id.length === 0) return false;
    let meta = null;
    if (this.save) {
      try {
        meta = await this.save.loadMeta(id);
      } catch (err) {
        this._fail('save:loadMeta', err);
      }
    }
    if (!meta) {
      this._reportToScreens('Diese Welt konnte nicht gefunden werden.');
      return false;
    }
    let snapshot = null;
    if (this.save) {
      try {
        snapshot = await this.save.loadPlayer(id);
      } catch (err) {
        this._fail('save:loadPlayer', err);
      }
    }
    return this._enterWorld(meta, null, snapshot);
  }

  /**
   * The shared body of {@link Game#startWorld} and {@link Game#loadWorld}.
   * @param {Object} meta World metadata record.
   * @param {?Object} generatorOptions Extra generator options, or `null`.
   * @param {?Object} snapshot Saved player payload, or `null`.
   * @returns {Promise<boolean>} `true` when the world is playable.
   * @private
   */
  async _enterWorld(meta, generatorOptions, snapshot) {
    const token = ++this._loadToken;
    this.setState('loading');
    if (this.ui.screens && this.ui.screens.currentName !== 'loading') {
      this.ui.screens.show('loading', {
        title: 'Welt wird geladen', step: `„${meta.name}" wird vorbereitet…`,
      });
    }
    this.emit('progress', 0.02, 'Welt wird angelegt');

    this._teardownWorld();
    // Free the backdrop's worker pool and chunk memory before the real world
    // claims its own; the loading screen covers the gap.
    this._disposeMenuWorld();
    this.worldMeta = meta;

    /* ---- world ---------------------------------------------------------- */
    this.world = this._construct('world', () => new World(this.gl, this.settings, {
      seed: meta.seed,
      name: meta.name,
      id: meta.id,
      generator: generatorOptions || undefined,
    }));
    if (!this.world) {
      this._reportToScreens('Die Welt konnte nicht erzeugt werden.');
      this.setState('menu');
      if (this.ui.screens) this.ui.screens.replace('mainmenu');
      return false;
    }
    if (this.save) this.world.setSaveManager(this.save, meta.id);
    this.world.on('error', (where, err) => this._fail(`world:${where}`, err));

    try {
      await this.world.init();
    } catch (err) {
      this._fail('world:init', err);
    }
    if (token !== this._loadToken) return false;

    /* ---- player --------------------------------------------------------- */
    this.emit('progress', 0.12, 'Spieler wird erstellt');
    this.player = this._construct('player',
      () => new Player(this.world, this.settings, this.input));
    if (this.player) {
      this.player.inventory = this._construct('playerInventory', () => new PlayerInventory());
      this.player.setViewport(this.canvas ? this.canvas.width : 1280,
        this.canvas ? this.canvas.height : 720);
      this.player.setGameMode(meta.gameMode === 'creative' || meta.gameMode === 'spectator'
        ? meta.gameMode : 'survival');
      if (this.player.inventory) {
        this.player.inventory.on('select', (index) => { this.player.selectedSlot = index; });
      }
    }

    /* ---- entities, mobs, combat, environment, interaction ---------------- */
    this.entities = this._construct('entities', () => new EntityManager(this.world));
    if (this.entities) {
      this.entities.particles = this.particles;
      this.entities.audio = this.audio;
      this.entities.onParticle = (type, x, y, z, opts) => this._spawnParticles(type, x, y, z, opts);
    }

    this.mobs = this._construct('mobs', () => new MobSpawner(this.world, this.entities));
    if (this.mobs) this.mobs.attachToWorld();

    this.combat = this._construct('combat', () => new CombatSystem(
      this.world, this.entities, this.player, this.audio, this.particles));

    this.environment = this._construct('environment',
      () => new Environment(this.settings, meta.seed));

    this.interaction = this._construct('interaction', () => new Interaction(
      this.world, this.player, this.input, this.audio, this.particles, this.entities));

    this._buildContainerKinds();
    this._wireWorldEvents();
    this._syncContext();

    /* ---- restore the snapshot before the terrain is probed ---------------- */
    let restoredPosition = false;
    if (snapshot && this.player) {
      try {
        this.player.deserialize(snapshot);
        restoredPosition = Array.isArray(snapshot.position) && snapshot.position.length >= 3;
      } catch (err) {
        this._fail('player:deserialize', err);
      }
      if (this.environment && snapshot.environment) {
        try { this.environment.deserialize(snapshot.environment); } catch (err) {
          this._fail('environment:deserialize', err);
        }
      }
      this._restoreContainers(snapshot.containers);
    }
    if (this.save && this.entities) {
      try {
        const stored = await this.save.loadEntities(meta.id);
        if (stored) this.entities.deserialize(stored);
      } catch (err) {
        this._fail('save:loadEntities', err);
      }
    }
    if (token !== this._loadToken) return false;

    /* ---- stream the spawn area before showing it -------------------------- */
    await this._pumpWorld(token, restoredPosition);
    if (token !== this._loadToken) return false;
    // Covers the restored-position path, where `_commitSpawn` never ran.
    this._resetFallTracking();

    /* ---- go ------------------------------------------------------------- */
    this.emit('progress', 1, 'Bereit');
    this._accumulator = 0;
    this._sinceSave = 0;
    this._lastFrameAt = nowMs();
    if (this.ui.screens) this.ui.screens.hide();
    if (this.ui.hud) this.ui.hud.show();
    this.setState('playing');
    this._requestLock(true);
    this._applyAmbience(true);
    if (this.audio && this.audio.ready) this.audio.startMusic('calm');
    if (this.save && meta.id) {
      Promise.resolve(this.save.touchWorld(meta.id, 0)).catch(() => undefined);
    }
    this.emit('worldReady', this.world, this.player);
    return true;
  }

  /**
   * Run the world's streaming pump behind the loading screen until the spawn
   * area is generated, lit and meshed.
   *
   * `world.update()` only spends a few milliseconds per call, so one call per
   * frame would leave the player standing in a half-built world. This drains it
   * in bursts, yielding to the event loop so the loading bar keeps animating.
   *
   * @param {number} token Load token; a newer load aborts this one.
   * @param {boolean} keepPosition `true` when a saved position must be kept.
   * @returns {Promise<void>} Resolves when the spawn area is ready or the
   *   budget ran out.
   * @private
   */
  async _pumpWorld(token, keepPosition) {
    const world = this.world;
    const player = this.player;
    if (!world) return;

    const camera = player ? player.camera : this._menuCamera;
    if (player) {
      // Point the streaming camera at the saved position (or the origin) so the
      // right chunks are requested from the very first pump iteration.
      if (!keepPosition) player.teleport(0.5, SPAWN_FALLBACK_Y, 0.5);
      player.setViewport(this.canvas ? this.canvas.width : 1280,
        this.canvas ? this.canvas.height : 720);
      player.updateCamera(1);
    } else {
      vec3.set(this._menuCamera.position, 0.5, SPAWN_FALLBACK_Y, 0.5);
      refreshCamera(this._menuCamera);
    }

    const deadline = nowMs() + LOAD_BUDGET_MS;
    let placed = keepPosition;
    let idleRuns = 0;

    while (nowMs() < deadline) {
      if (token !== this._loadToken) return;
      const burst = nowMs();
      for (let i = 0; i < LOAD_PUMP_STEPS; i++) {
        try {
          world.update(1 / 60, camera.position, camera.frustum);
        } catch (err) {
          this._fail('world:stream', err);
          return;
        }
        if (nowMs() - burst > LOAD_BURST_MS) break;
      }

      let st = null;
      try { st = world.getStats(); } catch { st = null; }

      if (!placed && player) {
        const cx = Math.floor(player.position[0]) >> 4;
        const cz = Math.floor(player.position[2]) >> 4;
        if (world.isLoaded(cx, cz)) {
          this._placePlayerAtSurface();
          player.updateCamera(1);
          placed = true;
        }
      }

      if (st) {
        // Two thirds of the bar is streaming, the last third is settling.
        const progress = placed
          ? clamp(0.35 + (st.sections / Math.max(1, st.loaded * 4)) * 0.6, 0.35, 0.97)
          : clamp(st.loaded / 24, 0.05, 0.34);
        this.emit('progress', progress, placed ? 'Chunks werden gebaut' : 'Gelände wird erzeugt');

        const idle = st.queued === 0 && st.meshing === 0 && st.generating === 0
          && (st.lightQueue | 0) === 0;
        if (placed && idle && st.sections > 0) {
          if (++idleRuns >= 3) break;
        } else {
          idleRuns = 0;
        }
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    if (!placed && player) this._placePlayerAtSurface();
    if (player) player.updateCamera(1);
  }

  /**
   * Move the player onto a safe surface: two blocks of clear, dry air standing
   * on solid ground.
   *
   * A spawn buried in terrain — or dropped from the sky into an ocean — makes
   * the whole world look broken, so this walks a distance-sorted spiral of
   * columns around the current position and takes the first one that is dry
   * land at surface level. Deep-but-dry ground and a water surface are kept as
   * second and third choices.
   * @returns {boolean} `true` when a real spot was found.
   * @private
   */
  _placePlayerAtSurface() {
    const world = this.world;
    const player = this.player;
    if (!world || !player) return false;

    const ox = Math.floor(player.position[0]);
    const oz = Math.floor(player.position[2]);
    const offsets = spawnSpiral();
    const reach = this._spawnSearchRadius();

    // Three tiers, best first: dry land at surface level, dry land anywhere
    // (a deep ravine floor beats the void), and finally the surface of a body
    // of water so a pure-ocean start floats instead of falling out of the sky.
    let deepX = ox;
    let deepY = 0;
    let deepZ = oz;
    let hasDeep = false;
    let wetX = ox;
    let wetY = 0;
    let wetZ = oz;
    let hasWet = false;

    for (let i = 0; i < offsets.length; i += 2) {
      const dx = offsets[i];
      const dz = offsets[i + 1];
      if (dx * dx + dz * dz > reach * reach) break;
      const bx = ox + dx;
      const bz = oz + dz;
      if (!world.isLoaded(bx >> 4, bz >> 4)) continue;

      const top = this._columnTop(bx, bz);
      if (top === -1) continue;

      const head = world.getBlock(bx, top + 1, bz);
      const chest = world.getBlock(bx, top + 2, bz);
      if (isSolid(head) || isSolid(chest)) continue;

      if (isLiquid(head) || isLiquid(chest)) {
        if (!hasWet) {
          hasWet = true;
          wetX = bx;
          wetZ = bz;
          wetY = Math.max(top + 1, SEA_LEVEL + 1);
        }
        continue;
      }
      if (top + 1 >= SPAWN_MIN_SURFACE_Y) {
        this._commitSpawn(bx + 0.5, top + 1, bz + 0.5);
        return true;
      }
      if (!hasDeep) {
        hasDeep = true;
        deepX = bx;
        deepY = top + 1;
        deepZ = bz;
      }
    }

    if (hasDeep) {
      this._commitSpawn(deepX + 0.5, deepY, deepZ + 0.5);
      return true;
    }
    if (hasWet) {
      this._commitSpawn(wetX + 0.5, wetY, wetZ + 0.5);
      return true;
    }

    // No column in range carried anything solid at all (an unloaded or empty
    // world): park the player above sea level instead of in the void.
    this._commitSpawn(ox + 0.5, SPAWN_FALLBACK_Y, oz + 0.5);
    return false;
  }

  /**
   * Radius in blocks the spawn search may wander, bounded by what the streamer
   * has actually loaded so far.
   * @returns {number} Search radius in blocks.
   * @private
   */
  _spawnSearchRadius() {
    let rd = 10;
    if (this.settings && typeof this.settings.get === 'function') {
      const v = Number(this.settings.get('renderDistance'));
      if (Number.isFinite(v)) rd = v;
    }
    return clamp((rd - 1) * CHUNK_SIZE, CHUNK_SIZE, SPAWN_SEARCH_RADIUS);
  }

  /**
   * World Y of the topmost solid block in a column.
   * @param {number} bx Block X.
   * @param {number} bz Block Z.
   * @returns {number} The block Y, or `-1` when the column is empty.
   * @private
   */
  _columnTop(bx, bz) {
    const world = this.world;
    let from = SPAWN_SCAN_TOP;
    try {
      const h = world.getHeight(bx, bz);
      // `getHeight` reports the first free cell above the terrain; two blocks of
      // slack cover snow layers and the odd structure sitting on top of it.
      if (Number.isFinite(h)) from = clamp(h + 2, SPAWN_SCAN_BOTTOM + 1, SPAWN_SCAN_TOP);
    } catch { /* scan the whole column instead */ }

    for (let y = from; y > SPAWN_SCAN_BOTTOM; y--) {
      const id = world.getBlock(bx, y, bz);
      if (id !== 0 && isSolid(id)) return y;
    }
    return -1;
  }

  /**
   * Move the player to a resolved spawn and remember it as the respawn point.
   * @param {number} x Feet X.
   * @param {number} y Feet Y.
   * @param {number} z Feet Z.
   * @returns {void}
   * @private
   */
  _commitSpawn(x, y, z) {
    const player = this.player;
    player.teleport(x, y, z);
    player.setSpawnPoint(x, y, z);
    if (this.world && this.world.spawn === null) this.world.spawn = [x, y, z];
    this._resetFallTracking();
  }

  /**
   * Re-baseline the combat system's fall tracking after an instant move.
   *
   * `CombatSystem` records the highest Y of the current fall when it attaches,
   * and the player is still standing at its construction height when that
   * happens — long before the spawn is known. Without this, the first landing
   * after the spawn search reads as a fall of tens of blocks and greets the
   * player with fall damage.
   * @returns {void}
   * @private
   */
  _resetFallTracking() {
    const combat = this.combat;
    const player = this.player;
    if (!combat || !player || typeof combat.attach !== 'function') return;
    try {
      combat.attach(player);
    } catch (err) {
      this._fail('combat:attach', err);
    }
  }

  /**
   * Save everything, drop the world and go back to the main menu.
   * @returns {Promise<void>} Resolves once the menu is up.
   */
  async quitToMenu() {
    if (this.world) {
      try { await this.saveAll(true); } catch (err) { this._fail('save:quit', err); }
    }
    this._loadToken++;
    this._teardownWorld();
    // Rebuilt in the background: the menu appears immediately and the backdrop
    // fades in as its chunks arrive.
    this._buildMenuWorld(null).catch((err) => this._fail('menuWorld:rebuild', err));
    if (this.ui.hud) this.ui.hud.hide();
    if (this.ui.debug) this.ui.debug.hide();
    if (this.audio && this.audio.ready) this.audio.setAmbience(0, false, 'clear', false);
    this.setState('menu');
    if (this.ui.screens) {
      this.ui.screens.hide();
      this.ui.screens.show('mainmenu');
    }
    this.emit('quitToMenu');
  }

  /**
   * Release the menu backdrop: it owns its own worker pool and chunk data, so
   * it must not stay resident while a real world is being played.
   * @returns {void}
   * @private
   */
  _disposeMenuWorld() {
    if (this.menuWorld) {
      try { this.menuWorld.dispose(); } catch { /* ignore */ }
      this.menuWorld = null;
    }
    if (this.menuEnvironment) {
      try { this.menuEnvironment.dispose(); } catch { /* ignore */ }
      this.menuEnvironment = null;
    }
  }

  /**
   * Dispose every per-world subsystem and forget the world.
   * @returns {void}
   * @private
   */
  _teardownWorld() {
    if (this.ui.inventory && this.ui.inventory.isOpen) {
      try { this.ui.inventory.close(); } catch { /* nothing to close */ }
    }
    if (this.interaction) { try { this.interaction.dispose(); } catch { /* ignore */ } }
    if (this.combat) { try { this.combat.dispose(); } catch { /* ignore */ } }
    if (this.mobs) { try { this.mobs.dispose(); } catch { /* ignore */ } }
    if (this.entities) { try { this.entities.dispose(); } catch { /* ignore */ } }
    if (this.environment) { try { this.environment.dispose(); } catch { /* ignore */ } }
    if (this.player) { try { this.player.dispose(); } catch { /* ignore */ } }
    if (this.world) { try { this.world.dispose(); } catch { /* ignore */ } }

    this.interaction = null;
    this.combat = null;
    this.mobs = null;
    this.entities = null;
    this.environment = null;
    this.player = null;
    this.world = null;
    this.worldMeta = null;
    this._containers.clear();
    this._furnaces.length = 0;
    this._accumulator = 0;
    this._syncContext();
  }

  /* ====================================================================== */
  /* Cross-system wiring                                                     */
  /* ====================================================================== */

  /**
   * Resolve the block id -> container kind table once per world.
   * @returns {void}
   * @private
   */
  _buildContainerKinds() {
    this._containerKinds.clear();
    for (const name of Object.keys(CONTAINER_BLOCKS)) {
      try {
        const def = blockByName(name);
        if (def && def.id > 0) this._containerKinds.set(def.id, CONTAINER_BLOCKS[name]);
      } catch { /* the registry simply does not have this block */ }
    }
  }

  /**
   * Keep the shared entity/mob context in step with the live subsystems.
   * @returns {void}
   * @private
   */
  _syncContext() {
    const ctx = this._ctx;
    ctx.manager = this.entities;
    ctx.entities = this.entities;
    ctx.world = this.world;
    ctx.player = this.player;
    ctx.particles = this.particles;
    ctx.audio = this.audio;
    ctx.environment = this.environment;
    ctx.combat = this.combat;
    ctx.difficulty = this.combat ? this.combat.difficulty : 2;
    setMobContext(ctx);
  }

  /**
   * Connect the per-world subsystems to each other.
   * @returns {void}
   * @private
   */
  _wireWorldEvents() {
    const hud = this.ui.hud;

    /* ---- interaction -------------------------------------------------- */
    if (this.interaction) {
      this.interaction.on('blockBroken', (x, y, z, blockId, drops) => {
        // Particles, sound and the drops themselves are raised inside
        // `interaction`; what is left is the survival bookkeeping and the
        // container that used to live in that block.
        if (this.combat) this.combat.onBlockBroken();
        this._removeContainerAt(x, y, z, true);
        this.emit('blockBroken', x, y, z, blockId, drops);
      });
      this.interaction.on('blockPlaced', (x, y, z, blockId) => {
        this.emit('blockPlaced', x, y, z, blockId);
      });
      this.interaction.on('openScreen', (kind, x, y, z, blockId) => {
        this._openBlockScreen(kind, x, y, z, blockId);
      });
      this.interaction.on('message', (text) => {
        if (hud) hud.setMessage(text, 2000);
      });
    }

    /* ---- entities ------------------------------------------------------ */
    if (this.entities) {
      this.entities.on('spawn', (entity) => this._normalizeEntity(entity));
      this.entities.forEach((entity) => this._normalizeEntity(entity));
      this.entities.on('explosion', (x, y, z, strength) => {
        this._spawnParticles('explosion', x, y, z, { scale: clamp(strength / 4, 0.5, 3) });
        this._play('explode', x, y, z, 1);
        if (hud) hud.flashDamage(clamp(strength / 12, 0.15, 0.6));
      });
      this.entities.on('mobDeath', (mob) => {
        if (!mob || !mob.position) return;
        this._play('hurt', mob.position[0], mob.position[1], mob.position[2], 0.7);
      });
      this.entities.on('blockLanded', (x, y, z, blockId) => {
        if (this.audio && this.audio.ready) {
          try { this.audio.playBlockSound('place', blockId, x + 0.5, y + 0.5, z + 0.5); } catch { /* ignore */ }
        }
      });
    }

    /* ---- combat -------------------------------------------------------- */
    if (this.combat) {
      this.combat.on('death', (payload) => this._onPlayerDeath(payload));
      this.combat.on('levelup', () => {
        if (this.audio && this.audio.ready) {
          try { this.audio.playUI('levelup'); } catch { /* ignore */ }
        }
      });
    }
    if (this.player) {
      this.player.on('step', (blockId, x, y, z) => {
        if (this.audio && this.audio.ready) {
          try { this.audio.playBlockSound('step', blockId, x, y, z); } catch { /* ignore */ }
        }
      });
      this.player.on('splash', () => this._play('splash',
        this.player.position[0], this.player.position[1], this.player.position[2], 0.8));
      this.player.on('gamemode', (mode) => {
        if (hud) hud.setMessage(`Spielmodus: ${mode === 'creative' ? 'Kreativ' : mode === 'spectator' ? 'Zuschauer' : 'Überleben'}`, 2000);
      });
    }

    /* ---- environment ---------------------------------------------------- */
    if (this.environment) {
      this.environment.on('weather', (state) => {
        this._applyAmbience(true);
        if (hud) {
          const label = state === 'thunder' ? 'Ein Gewitter zieht auf.'
            : state === 'rain' ? 'Es fängt an zu regnen.' : 'Das Wetter klart auf.';
          hud.setMessage(label, 2600);
        }
      });
      this.environment.on('lightning', (x, y, z, strength) => {
        if (this.particles && typeof this.particles.triggerLightning === 'function') {
          try { this.particles.triggerLightning(x, y, z, strength); } catch { /* ignore */ }
        }
        this._play('thunder', x, y, z, 1);
      });
      this.environment.on('day', () => this._applyAmbience(true));
      this.environment.on('night', () => this._applyAmbience(true));
    }
  }

  /**
   * Make one freshly spawned entity safe for every consumer of its state.
   *
   * `game/mobs.js` re-declares `prevPosition` as a plain array, while
   * `game/entities.js` calls `.set()` on it when an entity freezes beyond the
   * tick radius — which would throw and stop the whole entity update. A
   * `Float32Array` satisfies both call styles (indexed writes and `set()`), so
   * the integrator normalises it here instead of patching another module.
   * @param {Object} entity The entity that just entered the world.
   * @returns {void}
   * @private
   */
  _normalizeEntity(entity) {
    if (!entity) return;
    const prev = entity.prevPosition;
    if (prev && typeof prev.set !== 'function' && prev.length >= 3) {
      entity.prevPosition = new Float32Array([prev[0], prev[1], prev[2]]);
    }
  }

  /**
   * React to the player's death: freeze the world and show the death screen.
   * @param {Object} payload The combat system's `'death'` payload.
   * @returns {void}
   * @private
   */
  _onPlayerDeath(payload) {
    this.setState('dead');
    if (this.ui.inventory && this.ui.inventory.isOpen) {
      try { this.ui.inventory.close(); } catch { /* ignore */ }
    }
    if (this.ui.screens) this.ui.screens.show('death', payload || {});
    if (this.audio && this.audio.ready) {
      try { this.audio.stopMusic(); } catch { /* ignore */ }
    }
    this.emit('death', payload);
  }

  /**
   * Bring the player back to life at their spawn point.
   * @returns {void}
   */
  respawn() {
    if (!this.player) return;
    try {
      if (this.combat) this.combat.respawn();
      else this.player.respawn();
    } catch (err) {
      this._fail('respawn', err);
    }
    // The spawn point may sit in terrain that changed since it was set.
    if (this.world) {
      const px = Math.floor(this.player.position[0]);
      const pz = Math.floor(this.player.position[2]);
      if (this.world.isLoaded(px >> 4, pz >> 4)) this._placePlayerAtSurface();
    }
    this._accumulator = 0;
    if (this.ui.screens) this.ui.screens.hide();
    if (this.ui.hud) this.ui.hud.show();
    this.setState('playing');
    this._requestLock(true);
    if (this.audio && this.audio.ready) this.audio.startMusic('calm');
    this.emit('respawn');
  }

  /* ====================================================================== */
  /* Containers                                                              */
  /* ====================================================================== */

  /**
   * Open the UI a right-clicked block asked for.
   * @param {string} kind Interaction kind (`'crafting'`, `'chest'`, …).
   * @param {number} x Block X.
   * @param {number} y Block Y.
   * @param {number} z Block Z.
   * @param {number} blockId The block that was used.
   * @returns {void}
   * @private
   */
  _openBlockScreen(kind, x, y, z, blockId) {
    const ui = this.ui.inventory;
    if (!ui) return;
    const hint = UNIMPLEMENTED_SCREENS[kind];
    if (hint) {
      if (this.ui.hud) this.ui.hud.setMessage(hint, 2600);
      return;
    }
    if (kind === 'crafting') {
      ui.open('crafting', null);
      return;
    }
    const container = this._containerAt(x, y, z, blockId);
    if (!container) {
      if (this.ui.hud) this.ui.hud.setMessage('Dieser Block hat keine Oberfläche.', 2000);
      return;
    }
    ui.open(kind, container);
  }

  /**
   * Fetch (or lazily create) the container backing a block.
   * @param {number} x Block X.
   * @param {number} y Block Y.
   * @param {number} z Block Z.
   * @param {number} blockId Block id at that position.
   * @returns {?Container} The container, or `null` when the block has none.
   * @private
   */
  _containerAt(x, y, z, blockId) {
    const key = `${x},${y},${z}`;
    const existing = this._containers.get(key);
    if (existing) return existing;
    const kind = this._containerKinds.get(blockId);
    if (!kind) return null;
    let container = null;
    try {
      container = createContainer(kind, x, y, z);
      container.setResolvers(smeltResult, fuelValue);
    } catch (err) {
      this._fail('container:create', err);
      return null;
    }
    this._containers.set(key, container);
    if (container.isFurnace) this._furnaces.push(container);
    return container;
  }

  /**
   * Forget the container at a position, optionally scattering its contents.
   * @param {number} x Block X.
   * @param {number} y Block Y.
   * @param {number} z Block Z.
   * @param {boolean} dropContents `true` to drop everything inside.
   * @returns {void}
   * @private
   */
  _removeContainerAt(x, y, z, dropContents) {
    const key = `${x},${y},${z}`;
    const container = this._containers.get(key);
    if (!container) return;
    this._containers.delete(key);
    const at = this._furnaces.indexOf(container);
    if (at >= 0) this._furnaces.splice(at, 1);
    if (!dropContents || !this.entities) return;
    for (let i = 0; i < container.size; i++) {
      const stack = container.take(i);
      if (stack === null) continue;
      try {
        this.entities.dropItem(x + 0.5, y + 0.5, z + 0.5, stack);
      } catch (err) {
        this._fail('container:drop', err);
        return;
      }
    }
  }

  /**
   * Restore the containers of a saved world.
   * @param {*} records The `containers` array of a player snapshot.
   * @returns {void}
   * @private
   */
  _restoreContainers(records) {
    if (!Array.isArray(records)) return;
    for (let i = 0; i < records.length; i++) {
      const entry = records[i];
      if (!Array.isArray(entry) || entry.length < 2) continue;
      try {
        const container = Container.deserialize(entry[1]);
        container.setResolvers(smeltResult, fuelValue);
        this._containers.set(String(entry[0]), container);
        if (container.isFurnace) this._furnaces.push(container);
      } catch (err) {
        this._fail('container:restore', err);
        return;
      }
    }
  }

  /* ====================================================================== */
  /* Loop                                                                    */
  /* ====================================================================== */

  /**
   * Start the animation loop. Idempotent.
   * @returns {void}
   */
  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this._lastFrameAt = nowMs();
    this._lastPresentAt = this._lastFrameAt;
    this._fpsAt = this._lastFrameAt;
    this._accumulator = 0;
    this._raf = requestAnimationFrame(this._boundFrame);
  }

  /**
   * Stop the animation loop.
   * @returns {void}
   */
  stop() {
    this.running = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  /**
   * Pause gameplay: release the pointer, show the pause screen, save.
   * @returns {void}
   */
  pause() {
    if (this.state !== 'playing' && this.state !== 'inventory') return;
    if (this.ui.inventory && this.ui.inventory.isOpen) {
      try { this.ui.inventory.close(); } catch { /* ignore */ }
    }
    this.setState('paused');
    if (this.ui.screens) this.ui.screens.show('pause');
    if (this.audio && this.audio.ready) {
      try { this.audio.stopMusic(); } catch { /* ignore */ }
    }
    this.autosave();
    this.emit('paused');
  }

  /**
   * Leave the pause screen and hand control back to the player.
   * @returns {void}
   */
  resume() {
    if (this.state !== 'paused') return;
    if (this.ui.screens) this.ui.screens.hide();
    if (this.ui.hud) this.ui.hud.show();
    this._accumulator = 0;
    this._lastFrameAt = nowMs();
    this.setState('playing');
    this._requestLock(true);
    if (this.audio && this.audio.ready) this.audio.startMusic('calm');
    this.emit('resumed');
  }

  /**
   * One fixed simulation step. Never throws.
   * @param {number} dt Tick duration in seconds (always `TICK_SECONDS`).
   * @returns {void}
   */
  tick(dt) {
    const started = nowMs();
    const step = clamp(num(dt, TICK_SECONDS), 0, 0.25);
    const ctx = this._ctx;
    ctx.dt = step;
    ctx.time += step;
    ctx.difficulty = this.combat ? this.combat.difficulty : 2;

    // Each stage is guarded on its own: one misbehaving subsystem must not cost
    // the player their physics, their aim or their health for that tick.
    if (this.environment) this._stage('environment', step, this._stepEnvironment);
    if (this.player) this._stage('player', step, this._stepPlayer);
    if (this.interaction) this._stage('interaction', step, this._stepInteraction);
    if (this.entities) this._stage('entities', step, this._stepEntities);
    if (this.mobs) this._stage('mobs', step, this._stepMobs);
    if (this.combat) this._stage('combat', step, this._stepCombat);
    this._stage('furnaces', step, this._stepFurnaces);
    this._stage('melee', step, this._stepMelee);

    this._fpsTicks++;
    this.stats.ticks++;
    this.stats.tickMs = nowMs() - started;
    this.emit('tick', step);
  }

  /**
   * Run one tick stage inside its own guard.
   * @param {string} name Stage name, used as the failure tag.
   * @param {number} step Tick duration in seconds.
   * @param {function(number):void} fn The stage body, called with `this` bound.
   * @returns {void}
   * @private
   */
  _stage(name, step, fn) {
    try {
      fn.call(this, step);
    } catch (err) {
      this._fail(`tick:${name}`, err, `Der Schritt „${name}" ist fehlgeschlagen.`);
    }
  }

  /**
   * Tick stage: clock, weather and every derived render colour.
   * @param {number} step Tick duration in seconds.
   * @returns {void}
   * @private
   */
  _stepEnvironment(step) {
    this.environment.update(step, this.player, this.world);
  }

  /**
   * Tick stage: player physics and vitals.
   * @param {number} step Tick duration in seconds.
   * @returns {void}
   * @private
   */
  _stepPlayer(step) {
    this.player.update(step, this.world);
  }

  /**
   * Tick stage: targeting, breaking, placing and item use.
   * @param {number} step Tick duration in seconds.
   * @returns {void}
   * @private
   */
  _stepInteraction(step) {
    this.interaction.update(step);
  }

  /**
   * Tick stage: dropped items, projectiles, TNT and mob AI.
   * @param {number} step Tick duration in seconds.
   * @returns {void}
   * @private
   */
  _stepEntities(step) {
    this.entities.update(step, this.player, this._ctx);
  }

  /**
   * Tick stage: natural spawning and despawning.
   * @param {number} step Tick duration in seconds.
   * @returns {void}
   * @private
   */
  _stepMobs(step) {
    this.mobs.update(step, this.player, this.environment);
  }

  /**
   * Tick stage: health, hunger, armour, drowning and experience.
   * @param {number} step Tick duration in seconds.
   * @returns {void}
   * @private
   */
  _stepCombat(step) {
    this.combat.update(step, this.environment);
  }

  /**
   * Tick stage: advance every open furnace by one tick.
   * @returns {void}
   * @private
   */
  _stepFurnaces() {
    const list = this._furnaces;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i].tickFurnace(1);
      } catch (err) {
        this._fail('furnace', err);
        return;
      }
    }
  }

  /**
   * Melee: attack whatever the player is aiming at.
   *
   * `interaction` owns the block half of the left mouse button; the entity half
   * lives here because only the combat system knows reach, cooldown and armour.
   * @returns {void}
   * @private
   */
  _stepMelee() {
    const input = this.input;
    const combat = this.combat;
    const player = this.player;
    if (!input || !combat || !player || player.dead === true) return;
    if (player.gameMode === 'spectator') return;

    const held = input.isActionDown('attack');
    const pressed = input.wasActionPressed('attack');
    // The aim query costs a spatial lookup plus a raycast, so it only runs while
    // the attack button is actually involved.
    if (!held && !pressed) return;

    const target = combat.pickAttackTarget();
    if (target === null) return;

    // A creature in the line of fire also shields the block behind it, so the
    // mining progress is held at zero while one is in reach.
    if (this.interaction && held) this.interaction.breakProgress = 0;
    if (!pressed) return;

    try {
      combat.playerAttack(target);
      if (typeof player.swing === 'function') player.swing();
      if (this.audio && this.audio.ready) this.audio.notifyCombat(7);
    } catch (err) {
      this._fail('attack', err);
    }
  }

  /**
   * One animation frame: fixed-step catch-up, camera interpolation, streaming,
   * UI refresh and the render call. Never throws.
   * @param {number} now `performance.now()` timestamp from `requestAnimationFrame`.
   * @returns {void}
   */
  frame(now) {
    if (!this.running || this.disposed) return;
    this._raf = requestAnimationFrame(this._boundFrame);

    const t = Number.isFinite(now) ? now : nowMs();

    /* ---- frame-rate cap -------------------------------------------------- */
    if (this._maxFps > 0) {
      // Half a millisecond of slack keeps a 60 Hz cap from dropping every other
      // vsync on a 60 Hz display.
      if (t - this._lastPresentAt < 1000 / this._maxFps - 0.5) return;
    }
    this._lastPresentAt = t;

    const rawDt = (t - this._lastFrameAt) / 1000;
    this._lastFrameAt = t;
    const dt = clamp(Number.isFinite(rawDt) ? rawDt : 1 / 60, 0, 0.25);
    const started = nowMs();

    try {
      this._frameBody(t, dt);
    } catch (err) {
      this._fail('frame', err, 'Ein Bild konnte nicht gezeichnet werden.');
    }

    this._frameMs = nowMs() - started;
    this._fpsFrames++;
    this.stats.frames++;
    this.stats.dt = dt;
    this.stats.alpha = this._alpha;
    this.stats.frameMs = this._frameMs;
    this.stats.state = this.state;
    if (t - this._fpsAt >= 1000) {
      const span = (t - this._fpsAt) / 1000;
      this.stats.fps = Math.round(this._fpsFrames / span);
      this.stats.tps = Math.round(this._fpsTicks / span);
      this._fpsFrames = 0;
      this._fpsTicks = 0;
      this._fpsAt = t;
    }
  }

  /**
   * The body of {@link Game#frame}, split out so the guard stays readable.
   * @param {number} t Frame timestamp in milliseconds.
   * @param {number} dt Frame duration in seconds.
   * @returns {void}
   * @private
   */
  _frameBody(t, dt) {
    const simulating = SIMULATING.has(this.state) && !this._hidden;

    if (this.input) this.input.beginFrame(dt);
    // Only in `playing`: the inventory screen owns Escape and the inventory key
    // while it is open, and must not see them twice.
    if (this.state === 'playing' && !this._hidden) this._handleActions();

    // Mouse look and the edge-triggered latches are per *frame*, while ticks run
    // zero, one or several times per frame — so this has to happen before the
    // tick loop, or a jump press would be seen one frame late.
    if (this.player) this.player.pollInput(dt);

    /* ---- fixed-step simulation ------------------------------------------- */
    if (simulating) {
      this._accumulator += dt;
      let steps = 0;
      while (this._accumulator >= TICK_SECONDS && steps < MAX_CATCHUP_TICKS) {
        this._accumulator -= TICK_SECONDS;
        this.tick(TICK_SECONDS);
        steps++;
      }
      // A backgrounded tab must not carry minutes of debt into the next frame.
      if (this._accumulator > TICK_SECONDS * MAX_CATCHUP_TICKS) {
        this._accumulator = TICK_SECONDS * MAX_CATCHUP_TICKS;
      }
      this._alpha = clamp(this._accumulator / TICK_SECONDS, 0, 1);
      this._sinceSave += dt;
      if (this._sinceSave >= AUTOSAVE_SECONDS && this.settings
        && this.settings.get('autoSave') !== false) {
        this._sinceSave = 0;
        this.autosave();
      }
    } else {
      this._accumulator = 0;
      this._alpha = 1;
    }

    /* ---- camera ---------------------------------------------------------- */
    const world = this.world || this.menuWorld;
    const environment = this.world ? this.environment : this.menuEnvironment;
    let camera;
    if (this.world && this.player) {
      if (this.canvas) this.player.setViewport(this.canvas.width, this.canvas.height);
      camera = this.player.updateCamera(this._alpha);
    } else {
      if (!this.world && this.menuEnvironment) this.menuEnvironment.update(dt, null, this.menuWorld);
      camera = this._updateMenuCamera(dt);
    }

    /* ---- streaming ------------------------------------------------------- */
    if (world && camera) {
      try {
        world.update(dt, camera.position, camera.frustum);
      } catch (err) {
        this._fail('world:update', err);
      }
    }

    /* ---- audio ----------------------------------------------------------- */
    this._updateAudio(dt, camera);

    /* ---- UI -------------------------------------------------------------- */
    this._updateUI(dt);

    /* ---- render ---------------------------------------------------------- */
    const frame = this._frame;
    frame.camera = camera;
    frame.world = world;
    frame.environment = environment;
    frame.player = this.world ? this.player : null;
    frame.entities = (this.world && this.entities && camera)
      ? this.entities.getRenderList(camera.position, ENTITY_RENDER_DISTANCE)
      : null;
    frame.particles = null;
    frame.particlesUpdated = false;
    frame.hit = this.interaction ? this.interaction.hit : null;
    frame.breakProgress = this.interaction ? this.interaction.breakProgress : 0;
    frame.alpha = this._alpha;
    frame.dt = dt;
    frame.time = environment && Number.isFinite(environment.time) ? environment.time : t / 1000;
    frame.frameIndex = this.stats.frames;

    if (this.renderer) this.renderer.render(frame);
    if (this._wantScreenshot) {
      this._wantScreenshot = false;
      this._captureScreenshot();
    }
    if (this.input) this.input.endFrame();
  }

  /**
   * Edge-triggered actions that belong to the game rather than to a subsystem.
   * @returns {void}
   * @private
   */
  _handleActions() {
    const input = this.input;
    if (!input) return;

    if (input.wasActionPressed('pause')) {
      this.pause();
      return;
    }
    if (input.wasActionPressed('inventory')) this._toggleInventory();
    if (input.wasActionPressed('debug') && this.ui.debug) this.ui.debug.toggle();
    if (input.wasActionPressed('screenshot')) this._wantScreenshot = true;
    if (input.wasActionPressed('fullscreen')) this._toggleFullscreen();
    if (input.wasActionPressed('drop')) this._dropHeld(input.isActionDown('sneak'));
  }

  /**
   * Open or close the player inventory.
   * @returns {void}
   * @private
   */
  _toggleInventory() {
    const ui = this.ui.inventory;
    if (!ui || !this.player) return;
    if (ui.isOpen) ui.close();
    else ui.open('inventory', null);
  }

  /**
   * Throw the held item into the world.
   * @param {boolean} whole `true` to drop the whole stack instead of one item.
   * @returns {void}
   * @private
   */
  _dropHeld(whole) {
    const player = this.player;
    const inv = player && player.inventory;
    if (!inv || !this.entities || player.dead === true) return;
    const slot = inv.selectedSlot;
    const stack = whole ? inv.take(slot) : inv.remove(slot, 1);
    if (stack === null) return;
    try {
      const eye = player.getEyePosition();
      const look = player.getLookDirection();
      this.entities.dropItem(eye[0] + look[0] * 0.4, eye[1] - 0.25, eye[2] + look[2] * 0.4, stack,
        [look[0] * 6, look[1] * 6 + 1.5, look[2] * 6]);
      this._play('toss', eye[0], eye[1], eye[2], 0.6);
    } catch (err) {
      this._fail('drop', err);
      inv.add(stack);
    }
  }

  /**
   * Toggle browser fullscreen for the whole document.
   * @returns {void}
   * @private
   */
  _toggleFullscreen() {
    if (typeof document === 'undefined') return;
    try {
      if (document.fullscreenElement) {
        const done = document.exitFullscreen();
        if (done && typeof done.catch === 'function') done.catch(() => undefined);
      } else if (document.documentElement.requestFullscreen) {
        const done = document.documentElement.requestFullscreen();
        if (done && typeof done.catch === 'function') done.catch(() => undefined);
      }
    } catch (err) {
      this._fail('fullscreen', err);
    }
  }

  /**
   * Turn the current back buffer into a PNG download.
   *
   * The canvas is created without `preserveDrawingBuffer`, so this only works
   * in the same task as the draw call — which is exactly where it is called.
   * @returns {void}
   * @private
   */
  _captureScreenshot() {
    if (!this.canvas || typeof document === 'undefined') return;
    try {
      const url = this.canvas.toDataURL('image/png');
      const link = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      link.href = url;
      link.download = `voxelia-${stamp}.png`;
      link.click();
      if (this.ui.hud) this.ui.hud.showToast('Bildschirmfoto', link.download, '📷');
    } catch (err) {
      this._fail('screenshot', err, 'Das Bildschirmfoto konnte nicht gespeichert werden.');
    }
  }

  /* ====================================================================== */
  /* Per-frame side systems                                                  */
  /* ====================================================================== */

  /**
   * Move the audio listener and keep the ambience in step with the biome.
   * @param {number} dt Frame duration in seconds.
   * @param {?Object} camera The active camera.
   * @returns {void}
   * @private
   */
  _updateAudio(dt, camera) {
    const audio = this.audio;
    if (!audio || !audio.ready) return;
    try {
      if (camera) {
        this._listenerPos[0] = camera.position[0];
        this._listenerPos[1] = camera.position[1];
        this._listenerPos[2] = camera.position[2];
        audio.setListener(this._listenerPos, camera.forward, camera.up);
        audio.setSubmerged(camera.underwater === true ? 1 : 0);
      }
      audio.update(dt);
      this._ambienceTimer = (this._ambienceTimer || 0) + dt;
      if (this._ambienceTimer >= 1) {
        this._ambienceTimer = 0;
        this._applyAmbience(false);
      }
    } catch (err) {
      this._fail('audio:update', err);
    }
  }

  /**
   * Push the current biome, daylight and weather into the audio engine.
   * @param {boolean} force `true` to write even when nothing changed.
   * @returns {void}
   * @private
   */
  _applyAmbience(force) {
    const audio = this.audio;
    const env = this.world ? this.environment : this.menuEnvironment;
    if (!audio || !audio.ready || !env) return;
    const biome = num(env.biome, 0) | 0;
    const night = env.isNight === undefined ? false : env.isNight();
    const weather = typeof env.weather === 'string' ? env.weather : 'clear';
    let underground = false;
    if (this.player && this.world) {
      const px = Math.floor(this.player.position[0]);
      const pz = Math.floor(this.player.position[2]);
      let surface = Number.NaN;
      try { surface = this.world.getHeight(px, pz); } catch { surface = Number.NaN; }
      underground = Number.isFinite(surface) && this.player.position[1] < surface - 4;
    }
    const signature = `${biome}|${night ? 1 : 0}|${weather}|${underground ? 1 : 0}`;
    if (!force && signature === this._ambienceSignature) return;
    this._ambienceSignature = signature;
    try {
      audio.setAmbience(biome, night, weather, underground);
    } catch (err) {
      this._fail('audio:ambience', err);
    }
  }

  /**
   * Refresh every DOM UI layer. Each manager writes only what changed.
   * @param {number} dt Frame duration in seconds.
   * @returns {void}
   * @private
   */
  _updateUI(dt) {
    const ui = this.ui;
    try {
      if (ui.hud) ui.hud.update(dt);
      if (ui.inventory) ui.inventory.update(dt);
      if (ui.screens) ui.screens.update(dt);
      if (ui.debug) ui.debug.update(dt);
    } catch (err) {
      this._fail('ui', err);
    }
    if (this._lockHint > 0) {
      this._lockHint -= dt;
      if (this._lockHint <= 0 && this.state === 'playing'
        && this.input && !this.input.locked && !this.input.isTouchMode && ui.hud) {
        ui.hud.setMessage('Klicke ins Bild, um zu spielen.', 3000);
        this._lockHint = 5;
      }
    }
  }

  /* ====================================================================== */
  /* State machine                                                           */
  /* ====================================================================== */

  /**
   * Switch the game state, applying pointer lock, input enablement and UI
   * visibility. Unknown states are ignored.
   * @param {'boot'|'menu'|'loading'|'playing'|'paused'|'inventory'|'dead'} s The new state.
   * @returns {void}
   */
  setState(s) {
    if (STATES.indexOf(s) < 0) {
      console.warn(`[VOXELIA] game: unknown state "${s}"`);
      return;
    }
    if (s === this.state) return;
    const previous = this.state;
    this.state = s;
    this.stats.state = s;

    const input = this.input;
    if (input) {
      const wantInput = s === 'playing' || s === 'inventory';
      // The combat system freezes the input on death and thaws it on respawn;
      // never fight it for ownership.
      if (!(this.combat && this.combat.inputFrozen && wantInput)) input.setEnabled(wantInput);
      if (!POINTER_LOCKED.has(s) && input.locked) input.exitLock();
    }

    const hud = this.ui.hud;
    if (hud) {
      if (s === 'playing' || s === 'inventory') hud.show();
      else hud.hide();
    }
    if (s !== 'playing') this._lockHint = 0;
    else if (input && !input.locked && !input.isTouchMode) this._lockHint = 0.75;

    this.emit('state', s, previous);
  }

  /* ====================================================================== */
  /* Persistence                                                             */
  /* ====================================================================== */

  /**
   * Fire-and-forget autosave. Overlapping calls are collapsed.
   * @returns {void}
   */
  autosave() {
    if (this._saving || !this.world || !this.save) return;
    this.saveAll(false).catch((err) => this._fail('autosave', err));
  }

  /**
   * Persist the world, the player, the entities and the metadata.
   * @param {boolean} [flush] `true` to also flush the write batch to disk.
   * @returns {Promise<boolean>} `true` when everything was written.
   */
  async saveAll(flush = false) {
    if (this._saving) return false;
    const save = this.save;
    const meta = this.worldMeta;
    if (!save || !this.world || !meta || !meta.id) return false;
    this._saving = true;
    let ok = true;
    try {
      await this.world.save();

      if (this.player) {
        const payload = this.player.serialize();
        payload.environment = this.environment ? this.environment.serialize() : null;
        payload.containers = this._serializeContainers();
        await save.savePlayer(meta.id, payload);
      }
      if (this.entities) {
        await save.saveEntities(meta.id, this.entities.serialize());
      }
      if (this.player && this.player.position) {
        meta.spawn = [this.player.spawnPoint[0], this.player.spawnPoint[1], this.player.spawnPoint[2]];
      }
      meta.lastPlayed = Date.now();
      await save.saveMeta(meta.id, meta);
      if (flush) await save.flush();
    } catch (err) {
      ok = false;
      this._fail('save', err, 'Die Welt konnte nicht gespeichert werden.');
    } finally {
      this._saving = false;
      this._sinceSave = 0;
    }
    if (ok) this.emit('saved', meta.id);
    return ok;
  }

  /**
   * Snapshot every block-backed container.
   * @returns {Array<[string, Object]>} Position key / container record pairs.
   * @private
   */
  _serializeContainers() {
    /** @type {Array<[string, Object]>} */
    const out = [];
    this._containers.forEach((container, key) => {
      try {
        if (!container.isEmpty() || container.isFurnace) out.push([key, container.serialize()]);
      } catch { /* one broken container never blocks the save */ }
    });
    return out;
  }

  /**
   * Best-effort save on page unload. Nothing may be awaited here, so the write
   * is only started; `SaveManager` flushes its own batch on page-hide.
   * @returns {void}
   * @private
   */
  _flushOnExit() {
    if (!this.world || !this.save) return;
    try {
      this.saveAll(true).catch(() => undefined);
    } catch { /* the page is going away anyway */ }
  }

  /* ====================================================================== */
  /* DOM event handlers                                                      */
  /* ====================================================================== */

  /**
   * Pause the simulation while the tab is hidden, and save on the way out.
   * @returns {void}
   * @private
   */
  _handleVisibility() {
    this._hidden = typeof document !== 'undefined' && document.hidden === true;
    if (this._hidden) {
      this._accumulator = 0;
      if (this.input) this.input.clear();
      if (this.world) this.autosave();
      if (this.state === 'playing') this.pause();
    } else {
      this._lastFrameAt = nowMs();
      this._lastPresentAt = this._lastFrameAt;
    }
  }

  /**
   * Keep the camera aspect and the render targets in step with the window.
   * @returns {void}
   * @private
   */
  _handleResize() {
    if (this.renderer) {
      try { this.renderer.resize(); } catch (err) { this._fail('resize', err); }
    }
    if (this.player && this.canvas) {
      this.player.setViewport(this.canvas.width, this.canvas.height);
    }
    this._menuCamera.aspect = this._aspect();
  }

  /**
   * Clicking the canvas re-acquires pointer lock while playing.
   * @returns {void}
   * @private
   */
  _handleCanvasPointer() {
    this._unlockAudio();
    if (this.state !== 'playing') return;
    if (this.ui.inventory && this.ui.inventory.isOpen) return;
    this._requestLock(false);
  }

  /**
   * Ask for pointer lock, tolerating a browser that refuses.
   * @param {boolean} hint `true` to show the German "click to play" hint when
   *   the request does not take effect.
   * @returns {void}
   * @private
   */
  _requestLock(hint) {
    const input = this.input;
    if (!input || input.locked || input.isTouchMode) return;
    try {
      input.requestLock();
    } catch (err) {
      this._fail('pointerlock', err);
    }
    if (hint) this._lockHint = 0.75;
  }

  /**
   * React to the pointer lock being gained or lost.
   * @param {boolean} locked The new lock state.
   * @returns {void}
   * @private
   */
  _handleLockChange(locked) {
    if (locked) {
      this._lockHint = 0;
      return;
    }
    // Losing the lock while playing means Escape or a lost focus: pause, unless
    // a container screen took the pointer on purpose.
    if (this.state !== 'playing') return;
    if (this.ui.inventory && this.ui.inventory.isOpen) return;
    this.pause();
  }

  /**
   * React to a settings change the loop itself owns.
   * @param {string} key The setting that changed.
   * @returns {void}
   * @private
   */
  _handleSettingChanged(key) {
    if (key === 'maxFps') {
      this._maxFps = Math.max(0, num(this.settings.get('maxFps'), 0));
      return;
    }
    if (key === 'renderDistance' && this.player) {
      // The far plane is derived from the render distance; refresh it now so a
      // slider drag is visible immediately instead of on the next camera move.
      this.player.updateCamera(this._alpha);
    }
  }

  /* ====================================================================== */
  /* Small utilities                                                         */
  /* ====================================================================== */

  /**
   * Spawn particles through whichever system the renderer built.
   * @param {string|number} type Particle type name or id.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {Object} [opts] Emitter overrides.
   * @returns {void}
   * @private
   */
  _spawnParticles(type, x, y, z, opts) {
    const particles = this.particles;
    if (!particles || typeof particles.spawn !== 'function') return;
    try {
      particles.spawn(type, x, y, z, opts || {});
    } catch (err) {
      this._fail('particles', err);
    }
  }

  /**
   * Play a positional sound without ever letting audio break a tick.
   * @param {string} name Sound name.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} [volume] Level `0..2`.
   * @returns {void}
   * @private
   */
  _play(name, x, y, z, volume = 1) {
    const audio = this.audio;
    if (!audio || !audio.ready) return;
    try {
      audio.play(name, { x, y, z, volume });
    } catch { /* a missing sound never matters */ }
  }

  /**
   * Report a failure to the screen manager, if there is one.
   * @param {string} message German message.
   * @returns {void}
   * @private
   */
  _reportToScreens(message) {
    if (this.ui.screens) this.ui.screens.reportError(message);
    else console.error(`[VOXELIA] game: ${message}`);
  }

  /**
   * Log a subsystem failure once per tag, emit it on the bus and — at most once
   * per second, and at most {@link TOAST_LIMIT_PER_TAG} times per tag — surface
   * it as a toast. A permanently broken stage therefore reports itself without
   * burying the screen. Never throws.
   * @param {string} where Failure tag.
   * @param {*} error The error.
   * @param {string} [message] Optional German text for the toast.
   * @returns {void}
   * @private
   */
  _fail(where, error, message) {
    if (!this._logged.has(where)) {
      this._logged.add(where);
      console.error(`[VOXELIA] game/${where}:`, error);
    }
    try { this.emit('error', message || where, error); } catch { /* listener threw */ }
    if (!message) return;

    const shown = this._toasted.get(where) || 0;
    if (shown >= TOAST_LIMIT_PER_TAG) return;
    const now = nowMs();
    if (now - this._lastErrorAt < 1000) return;
    this._lastErrorAt = now;
    this._toasted.set(where, shown + 1);

    const hud = this.ui.hud;
    if (hud && typeof hud.showToast === 'function') {
      try { hud.showToast('Fehler', message, '⚠', 'danger'); } catch { /* ignore */ }
    }
  }

  /* ====================================================================== */
  /* Teardown                                                                */
  /* ====================================================================== */

  /**
   * Stop the loop and release every resource the game owns.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();

    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
      window.removeEventListener('beforeunload', this._onBeforeUnload);
      window.removeEventListener('resize', this._onResize);
      if (this.canvas) this.canvas.removeEventListener('pointerdown', this._onCanvasPointerDown);
    }

    this._teardownWorld();

    this._disposeMenuWorld();
    for (const key of ['hud', 'inventory', 'debug', 'screens']) {
      const manager = this.ui[key];
      if (manager) { try { manager.dispose(); } catch { /* ignore */ } }
      this.ui[key] = null;
    }
    if (this.renderer) { try { this.renderer.dispose(); } catch { /* ignore */ } }
    if (this.audio) { try { this.audio.dispose(); } catch { /* ignore */ } }
    if (this.save) { try { this.save.close(); } catch { /* ignore */ } }
    if (this.input) { try { this.input.destroy(); } catch { /* ignore */ } }
    if (this.settings) {
      try { this.settings.off('change', this._onSettingChanged); } catch { /* ignore */ }
    }
    if (this.gl) { try { this.gl.dispose(); } catch { /* ignore */ } }

    this.renderer = null;
    this.particles = null;
    this.audio = null;
    this.save = null;
    this.input = null;
    this.screens = null;
    this.hud = null;
    this.removeAllListeners();
  }
}

export default Game;
