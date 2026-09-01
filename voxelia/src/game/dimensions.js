/**
 * VOXELIA — `game/dimensions.js`
 *
 * Multiple worlds in one save: a dimension registry, a manager that owns one
 * {@link World} per visited dimension, and the whole nether-portal mechanic
 * (frame validation, ignition, per-entity dwell timers, coordinate scaling,
 * destination search, return portals and travel cooldowns).
 *
 * ## Registry
 *
 * {@link DIMENSIONS} describes `overworld`, `nether` and `end`. Every entry
 * carries its German display name, the generator factory, the coordinate scale
 * (the Nether is 1:8), its build height range, the ambient light floor, whether
 * it rains, whether water evaporates, whether beds explode, the sky/fog
 * treatment the renderer should use and its music mood.
 *
 * The `end` entry is complete metadata with **no** generator: nothing in this
 * project generates End terrain yet. `canEnter('end')` reports that honestly
 * and {@link registerDimensionGenerator} lets a future `world/endworldgen.js`
 * plug itself in without touching this file.
 *
 * ## Inactive dimensions: frozen, then retired
 *
 * The manager keeps one `World` per visited dimension but **does not tick the
 * inactive ones** (`idleMode: 'frozen'`, the default). A `World` only does work
 * inside `update()` — streaming, meshing, lighting — so not calling it costs
 * exactly nothing and, more importantly, stops an unattended world from
 * streaming chunks around a stale camera and eating memory forever. What the
 * manager *does* run for an idle world is a 5-second maintenance pulse that
 * drains any light-engine queue left over from the last block edits (bounded by
 * a {@link TimeBudget}), and, after `idleRetireSeconds` (3 minutes) without a
 * visit, it saves the world and disposes it. The dimension record survives, so
 * walking back through the portal rebuilds the world at the same seed with the
 * same portals.
 *
 * `idleMode: 'slow'` is available for integrators who would rather keep the
 * other dimension warm: it calls `world.update()` once every
 * `idlePulseTicks` ticks with the last known camera position, i.e. roughly a
 * twentieth of the normal rate.
 *
 * ## Integration
 *
 * `world/worker.js` must build the right generator for the dimension it was
 * initialised with. Import {@link NetherWorldGenerator} there **directly** —
 * do not import this module into a worker, it pulls in `world/world.js`.
 *
 * @module game/dimensions
 */

import { EventBus, TimeBudget, nowMs } from '../core/util.js';
import { clamp } from '../core/math.js';
import { World } from '../world/world.js';
import { WorldGenerator } from '../world/worldgen.js';
import {
  NetherWorldGenerator, NETHER_MIN_Y, NETHER_MAX_Y, NETHER_LAVA_LEVEL,
  NETHER_CEILING_Y,
} from '../world/netherworldgen.js';
import { B, isLiquid, isSolid, getBlock } from '../world/blocks.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, SEA_LEVEL } from '../world/chunk.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Save-format version of {@link DimensionManager#serialize}. @type {number} */
export const DIMENSION_SAVE_VERSION = 1;

/** Fixed logic rate of the game loop, in ticks per second. @type {number} */
export const TICKS_PER_SECOND = 20;

/** Smallest portal interior width, in blocks (outer frame `4`). @type {number} */
export const PORTAL_MIN_WIDTH = 2;
/** Largest portal interior width, in blocks (outer frame `23`). @type {number} */
export const PORTAL_MAX_WIDTH = 21;
/** Smallest portal interior height, in blocks (outer frame `5`). @type {number} */
export const PORTAL_MIN_HEIGHT = 3;
/** Largest portal interior height, in blocks (outer frame `23`). @type {number} */
export const PORTAL_MAX_HEIGHT = 21;

/** How far the destination search looks for an existing portal, in blocks. @type {number} */
export const PORTAL_SEARCH_RADIUS = 128;
/** Ticks a **player** must stand inside a portal before travelling (4 s). @type {number} */
export const PORTAL_PLAYER_TICKS = 80;
/** Ticks any other entity must stand inside a portal (instant). @type {number} */
export const PORTAL_ENTITY_TICKS = 0;
/** Ticks of travel cooldown after arriving, so nobody ping-pongs (15 s). @type {number} */
export const PORTAL_COOLDOWN_TICKS = 300;
/** Radius around the player in which entity portal dwell is evaluated. @type {number} */
export const PORTAL_ENTITY_RADIUS = 96;

/** Ticks between idle-world maintenance pulses (5 s). @type {number} */
const IDLE_PULSE_TICKS = 100;
/** Milliseconds the idle maintenance pulse may spend per inactive world. @type {number} */
const IDLE_BUDGET_MS = 0.6;
/** Milliseconds the per-tick portal scan may spend. @type {number} */
const PORTAL_BUDGET_MS = 0.8;
/** Ticks between re-sampling the region under the player for the fog tint. @type {number} */
const ENV_REGION_INTERVAL = 20;
/** Default seconds an unvisited world stays resident before it is retired. @type {number} */
const DEFAULT_IDLE_RETIRE_SECONDS = 180;
/** Wall-clock budget for streaming the destination area in, in milliseconds. @type {number} */
const AREA_LOAD_TIMEOUT_MS = 6000;
/** Chunk radius that must be loaded around a destination before it is edited. @type {number} */
const AREA_LOAD_RADIUS = 1;

/** Deduplicated warning keys. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a warning at most once per key. Ticks must never throw and must never
 * spam the console.
 * @param {string} key dedup key
 * @param {string} message message
 * @param {*} [err] optional error
 * @returns {void}
 */
function warnOnce(key, message, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err !== undefined) console.warn(`[VOXELIA] dimensions: ${message}`, err);
  else console.warn(`[VOXELIA] dimensions: ${message}`);
}

/**
 * Coerce to a finite number.
 * @param {*} v candidate
 * @param {number} fallback value when `v` is not finite
 * @returns {number} finite number
 */
function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/* -------------------------------------------------------------------------- */
/* Generator factories                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Dimension id -> generator factory. `world/world.js` builds a
 * {@link WorldGenerator} unconditionally in `init()`; the manager swaps in the
 * right one afterwards, and `world/worker.js` picks the same class from the
 * `dimension` option it receives.
 * @type {Map<string, (seed:number, options:Object)=>Object>}
 */
const GENERATOR_FACTORIES = new Map([
  ['overworld', (seed, options) => new WorldGenerator(seed, options)],
  ['nether', (seed, options) => new NetherWorldGenerator(seed, options)],
]);

/**
 * Register (or replace) the generator factory of a dimension. This is the hook
 * a future `world/endworldgen.js` uses to make the End enterable.
 * @param {string} id dimension id
 * @param {(seed:number, options:Object)=>Object} factory generator factory
 * @returns {void}
 */
export function registerDimensionGenerator(id, factory) {
  if (typeof id !== 'string' || typeof factory !== 'function') return;
  GENERATOR_FACTORIES.set(id, factory);
}

/**
 * Build the generator for a dimension.
 * @param {string} id dimension id
 * @param {number|string} seed world seed
 * @param {Object} [options] generator options
 * @returns {Object|null} generator instance, or `null` when the dimension has
 *   no generator yet
 */
export function createDimensionGenerator(id, seed, options = {}) {
  const factory = GENERATOR_FACTORIES.get(id);
  if (factory === undefined) return null;
  try {
    return factory(seed, options);
  } catch (err) {
    warnOnce(`gen:${id}`, `generator for "${id}" failed to build`, err);
    return null;
  }
}

/**
 * Whether a dimension currently has a generator.
 * @param {string} id dimension id
 * @returns {boolean} `true` when the dimension can be generated
 */
export function hasDimensionGenerator(id) {
  return GENERATOR_FACTORIES.has(id);
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} DimensionSky
 * @property {'atmosphere'|'nether'|'end'} mode how `render/sky.js` should treat
 *   the background: full atmospheric scattering, a flat fogged void with no
 *   celestial bodies, or the End's starfield void
 * @property {boolean} sun draw a sun disk
 * @property {boolean} moon draw the moon
 * @property {boolean} stars draw stars
 * @property {boolean} clouds draw volumetric clouds
 * @property {number} sunIntensity HDR magnitude of the key light
 * @property {[number,number,number]} sunColor linear key-light tint
 * @property {[number,number,number]} skyAmbient linear hemispheric ambient
 * @property {[number,number,number]} groundColor linear ground bounce albedo
 * @property {[number,number,number]} fogColor linear distance-fog colour
 * @property {number} fogDensity exponential fog density per block
 * @property {number} fogStart blocks of clear air before the fog bites
 * @property {[number,number,number]} grassColor linear foliage/grass tint
 */

/**
 * @typedef {Object} DimensionDef
 * @property {string} id stable dimension id
 * @property {string} display German display name
 * @property {string} shortDisplay short German label for the HUD
 * @property {number} coordinateScale overworld blocks per block of this
 *   dimension — `1` for the Overworld and the End, `8` for the Nether
 * @property {number} minY lowest buildable Y
 * @property {number} maxY one past the highest buildable Y
 * @property {number} defaultSpawnY Y a fresh arrival aims for
 * @property {number} ambientLight ambient light floor, `0..1`
 * @property {boolean} hasSkyLight whether sky light reaches the ground
 * @property {boolean} hasCeiling whether the world is closed at the top
 * @property {boolean} hasDayCycle whether the sun moves
 * @property {boolean} rains whether weather runs here
 * @property {boolean} waterEvaporates whether placed water boils away
 * @property {boolean} bedsExplode whether sleeping detonates the bed
 * @property {boolean} respawnAnchorWorks whether a respawn anchor is usable
 * @property {boolean} ultrawarm lava flows fast, snow and ice melt
 * @property {boolean} natural whether compasses/clocks work and villagers breed
 * @property {DimensionSky} sky renderer sky/fog treatment
 * @property {('calm'|'night'|'cave'|'danger')} musicMood generative music mood
 * @property {string} ambience `game/audio.js` ambience hint
 * @property {string|null} portalTarget dimension a nether portal leads to from
 *   here, or `null` when portals do nothing
 * @property {number} portalFrameBlock block id of the frame material
 * @property {number} portalBlock block id of the portal surface
 */

/**
 * Every dimension VOXELIA knows about.
 * @type {Readonly<Object<string, DimensionDef>>}
 */
export const DIMENSIONS = Object.freeze({
  overworld: Object.freeze({
    id: 'overworld',
    display: 'Oberwelt',
    shortDisplay: 'Oberwelt',
    coordinateScale: 1,
    minY: WORLD_MIN_Y,
    maxY: WORLD_MAX_Y,
    defaultSpawnY: SEA_LEVEL + 2,
    ambientLight: 0.0,
    hasSkyLight: true,
    hasCeiling: false,
    hasDayCycle: true,
    rains: true,
    waterEvaporates: false,
    bedsExplode: false,
    respawnAnchorWorks: false,
    ultrawarm: false,
    natural: true,
    sky: Object.freeze({
      mode: 'atmosphere',
      sun: true,
      moon: true,
      stars: true,
      clouds: true,
      sunIntensity: 1,
      sunColor: [1.0, 0.975, 0.94],
      skyAmbient: [0.34, 0.42, 0.56],
      groundColor: [0.12, 0.16, 0.09],
      fogColor: [0.52, 0.66, 0.86],
      fogDensity: 0.008,
      fogStart: 24,
      grassColor: [0.45, 0.72, 0.35],
    }),
    musicMood: 'calm',
    ambience: 'overworld',
    portalTarget: 'nether',
    portalFrameBlock: B.OBSIDIAN,
    portalBlock: B.NETHER_PORTAL,
  }),

  nether: Object.freeze({
    id: 'nether',
    display: 'Der Nether',
    shortDisplay: 'Nether',
    coordinateScale: 8,
    minY: NETHER_MIN_Y,
    maxY: NETHER_MAX_Y,
    defaultSpawnY: 64,
    // Never pitch black: even sealed rock keeps a dull ember glow.
    ambientLight: 0.12,
    hasSkyLight: false,
    hasCeiling: true,
    hasDayCycle: false,
    rains: false,
    waterEvaporates: true,
    bedsExplode: true,
    respawnAnchorWorks: true,
    ultrawarm: true,
    natural: false,
    sky: Object.freeze({
      mode: 'nether',
      sun: false,
      moon: false,
      stars: false,
      clouds: false,
      sunIntensity: 0,
      sunColor: [0.62, 0.30, 0.16],
      // The ambient floor is what keeps an unlit cavern readable.
      skyAmbient: [0.115, 0.052, 0.040],
      groundColor: [0.085, 0.030, 0.022],
      fogColor: [0.185, 0.033, 0.028],
      // Thick, and it starts close: you never see far in the Nether.
      fogDensity: 0.055,
      fogStart: 6,
      grassColor: [0.42, 0.16, 0.14],
    }),
    musicMood: 'danger',
    ambience: 'cave',
    portalTarget: 'overworld',
    portalFrameBlock: B.OBSIDIAN,
    portalBlock: B.NETHER_PORTAL,
  }),

  end: Object.freeze({
    id: 'end',
    display: 'Das Ende',
    shortDisplay: 'Ende',
    coordinateScale: 1,
    minY: 0,
    maxY: 256,
    defaultSpawnY: 70,
    ambientLight: 0.08,
    hasSkyLight: false,
    hasCeiling: false,
    hasDayCycle: false,
    rains: false,
    waterEvaporates: false,
    bedsExplode: true,
    respawnAnchorWorks: false,
    ultrawarm: false,
    natural: false,
    sky: Object.freeze({
      mode: 'end',
      sun: false,
      moon: false,
      stars: true,
      clouds: false,
      sunIntensity: 0,
      sunColor: [0.55, 0.45, 0.70],
      skyAmbient: [0.075, 0.060, 0.098],
      groundColor: [0.070, 0.065, 0.055],
      fogColor: [0.045, 0.030, 0.062],
      fogDensity: 0.022,
      fogStart: 16,
      grassColor: [0.55, 0.52, 0.42],
    }),
    musicMood: 'danger',
    ambience: 'cave',
    portalTarget: 'overworld',
    portalFrameBlock: B.END_PORTAL_FRAME === undefined ? B.OBSIDIAN : B.END_PORTAL_FRAME,
    portalBlock: B.END_PORTAL === undefined ? B.NETHER_PORTAL : B.END_PORTAL,
  }),
});

/** Every dimension id, in menu order. @type {ReadonlyArray<string>} */
export const DIMENSION_IDS = Object.freeze(['overworld', 'nether', 'end']);

/**
 * Look up a dimension, falling back to the Overworld.
 * @param {string} id dimension id
 * @returns {DimensionDef} the definition
 */
export function getDimension(id) {
  const def = DIMENSIONS[id];
  return def === undefined ? DIMENSIONS.overworld : def;
}

/**
 * Whether `id` names a known dimension.
 * @param {*} id candidate
 * @returns {boolean} `true` when the registry knows it
 */
export function isDimension(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DIMENSIONS, id);
}

/**
 * Factor a horizontal coordinate is multiplied by when travelling between two
 * dimensions. Overworld -> Nether is `1/8`, Nether -> Overworld is `8`.
 * @param {string} fromId source dimension
 * @param {string} toId destination dimension
 * @returns {number} scale factor
 */
export function dimensionScaleRatio(fromId, toId) {
  const from = getDimension(fromId);
  const to = getDimension(toId);
  const ratio = from.coordinateScale / to.coordinateScale;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * Scale one horizontal coordinate from one dimension into another.
 * @param {number} v coordinate
 * @param {string} fromId source dimension
 * @param {string} toId destination dimension
 * @returns {number} scaled coordinate, floored to a block
 * @example scaleCoordinate(800, 'overworld', 'nether') // -> 100
 */
export function scaleCoordinate(v, fromId, toId) {
  return Math.floor(num(v, 0) * dimensionScaleRatio(fromId, toId));
}

/* -------------------------------------------------------------------------- */
/* Environment overrides                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Write a dimension's sky/fog/ambient treatment onto a `game/environment.js`
 * instance.
 *
 * `Environment.update()` recomputes every derived colour once per tick, so this
 * must run **after** it — see {@link DimensionManager#tick}, which does exactly
 * that. Nothing is allocated: the `Float32Array` fields are written in place.
 *
 * @param {Object} env the live `Environment`
 * @param {string} id dimension id
 * @param {?[number,number,number]} [fogTint] optional per-region fog colour that
 *   replaces the dimension default (the Nether biomes use this)
 * @returns {void}
 */
export function applyDimensionEnvironment(env, id, fogTint = null) {
  if (!env) return;
  const def = getDimension(id);
  const sky = def.sky;

  env.dimension = def.id;
  env.skyMode = sky.mode;
  env.ambientFloor = def.ambientLight;
  env.fogStart = sky.fogStart;
  env.hasSkyLight = def.hasSkyLight;
  env.hasCeiling = def.hasCeiling;

  if (def.hasDayCycle && sky.mode === 'atmosphere') return;

  // No sun, no moon, no day cycle.
  env.sunIntensity = sky.sunIntensity;
  writeTriple(env.sunColor, sky.sunColor);
  writeTriple(env.skyAmbient, sky.skyAmbient);
  writeTriple(env.groundColor, sky.groundColor);
  writeTriple(env.grassColor, sky.grassColor);

  const fog = fogTint === null ? sky.fogColor : fogTint;
  writeTriple(env.fogColor, fog);
  writeTriple(env.biomeFogColor, fog);
  env.fogDensity = sky.fogDensity;

  if (env.sunDir && env.sunDir.length >= 3) {
    env.sunDir[0] = 0;
    env.sunDir[1] = -1;
    env.sunDir[2] = 0;
  }
  if (env.moonDir && env.moonDir.length >= 3) {
    env.moonDir[0] = 0;
    env.moonDir[1] = -1;
    env.moonDir[2] = 0;
  }

  env.aurora = 0;
  env.auroraIntensity = 0;
  if (!def.rains) {
    env.weather = 'clear';
    env.weatherState = 'clear';
    env.rainStrength = 0;
    env.thunderStrength = 0;
    env.snowStrength = 0;
    env.snowing = false;
  }
  env.seaLevel = def.id === 'nether' ? NETHER_LAVA_LEVEL : env.seaLevel;
  env.timeOfDay = 0.5;
}

/**
 * Copy three numbers into a vector-like target without allocating.
 * @param {?(Float32Array|number[])} dst destination
 * @param {ArrayLike<number>} src source triple
 * @returns {void}
 */
function writeTriple(dst, src) {
  if (!dst || dst.length < 3) return;
  dst[0] = src[0];
  dst[1] = src[1];
  dst[2] = src[2];
}

/* -------------------------------------------------------------------------- */
/* Portal geometry                                                             */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} PortalRecord
 * @property {string} dimension dimension the portal stands in
 * @property {'x'|'z'} axis horizontal axis the portal plane spans
 * @property {number} x entry x (interior centre, floored)
 * @property {number} y entry y (lowest interior row)
 * @property {number} z entry z (interior centre, floored)
 * @property {number} minX interior minimum x
 * @property {number} minY interior minimum y
 * @property {number} minZ interior minimum z
 * @property {number} maxX interior maximum x
 * @property {number} maxY interior maximum y
 * @property {number} maxZ interior maximum z
 * @property {number} width interior width, `2..21`
 * @property {number} height interior height, `3..21`
 * @property {?{dimension:string, x:number, y:number, z:number}} link the portal
 *   this one was created from, so a round trip lands on the same pair
 */

/**
 * Whether a block may sit inside a portal frame's interior.
 * @param {number} id block id
 * @returns {boolean} `true` for air, fire and portal blocks
 */
function isPortalInterior(id) {
  return id === 0 || id === B.NETHER_PORTAL;
}

/**
 * Validate an obsidian portal frame around an interior block.
 *
 * Accepts frames from `4 x 5` up to `23 x 23` **outer** size, i.e. a `2 x 3`
 * to `21 x 21` interior, exactly like the block game. Corner blocks are not
 * required. The interior must contain nothing but air and existing portal
 * blocks.
 *
 * @param {Object} world the `World` to read
 * @param {number} x an interior x
 * @param {number} y an interior y
 * @param {number} z an interior z
 * @param {'x'|'z'} axis horizontal axis the plane spans
 * @param {number} [frameBlock] frame block id (default obsidian)
 * @returns {?PortalRecord} the frame, or `null` when it is not a valid portal
 */
export function validatePortalFrame(world, x, y, z, axis, frameBlock = B.OBSIDIAN) {
  if (!world || (axis !== 'x' && axis !== 'z')) return null;
  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);
  if (!isPortalInterior(world.getBlock(bx, by, bz))) return null;

  /**
   * Read a block on the portal plane.
   * @param {number} a offset along the portal axis
   * @param {number} h world y
   * @returns {number} block id
   */
  const at = (a, h) => (axis === 'x' ? world.getBlock(a, h, bz) : world.getBlock(bx, h, a));

  const a0 = axis === 'x' ? bx : bz;

  // Walk down to the lowest interior row.
  let yMin = by;
  for (let i = 0; i < PORTAL_MAX_HEIGHT + 1; i++) {
    if (!isPortalInterior(at(a0, yMin - 1))) break;
    yMin--;
  }
  if (at(a0, yMin - 1) !== frameBlock) return null;

  // Walk up to the highest interior row.
  let yMax = yMin;
  for (let i = 0; i < PORTAL_MAX_HEIGHT + 1; i++) {
    if (!isPortalInterior(at(a0, yMax + 1))) break;
    yMax++;
  }
  if (at(a0, yMax + 1) !== frameBlock) return null;
  const height = yMax - yMin + 1;
  if (height < PORTAL_MIN_HEIGHT || height > PORTAL_MAX_HEIGHT) return null;

  // Walk out along the axis to the interior edges.
  let aMin = a0;
  for (let i = 0; i < PORTAL_MAX_WIDTH + 1; i++) {
    if (!isPortalInterior(at(aMin - 1, yMin))) break;
    aMin--;
  }
  if (at(aMin - 1, yMin) !== frameBlock) return null;

  let aMax = a0;
  for (let i = 0; i < PORTAL_MAX_WIDTH + 1; i++) {
    if (!isPortalInterior(at(aMax + 1, yMin))) break;
    aMax++;
  }
  if (at(aMax + 1, yMin) !== frameBlock) return null;
  const width = aMax - aMin + 1;
  if (width < PORTAL_MIN_WIDTH || width > PORTAL_MAX_WIDTH) return null;

  // Full rectangle check: interior clear, sides and lintels solid.
  for (let a = aMin; a <= aMax; a++) {
    if (at(a, yMin - 1) !== frameBlock) return null;
    if (at(a, yMax + 1) !== frameBlock) return null;
    for (let h = yMin; h <= yMax; h++) {
      if (!isPortalInterior(at(a, h))) return null;
    }
  }
  for (let h = yMin; h <= yMax; h++) {
    if (at(aMin - 1, h) !== frameBlock) return null;
    if (at(aMax + 1, h) !== frameBlock) return null;
  }

  const cx = axis === 'x' ? aMin + (width >> 1) : bx;
  const cz = axis === 'z' ? aMin + (width >> 1) : bz;

  return {
    dimension: typeof world.dimension === 'string' ? world.dimension : 'overworld',
    axis,
    x: cx,
    y: yMin,
    z: cz,
    minX: axis === 'x' ? aMin : bx,
    minY: yMin,
    minZ: axis === 'z' ? aMin : bz,
    maxX: axis === 'x' ? aMax : bx,
    maxY: yMax,
    maxZ: axis === 'z' ? aMax : bz,
    width,
    height,
    link: null,
  };
}

/**
 * Validate the frame around `(x, y, z)` and fill its interior with portal
 * blocks.
 * @param {Object} world the `World` to edit
 * @param {number} x an interior x
 * @param {number} y an interior y
 * @param {number} z an interior z
 * @param {'x'|'z'} axis horizontal axis the plane spans
 * @returns {?PortalRecord} the lit portal, or `null` when the frame is invalid
 */
export function buildPortal(world, x, y, z, axis) {
  const frame = validatePortalFrame(world, x, y, z, axis);
  if (frame === null) return null;
  const portal = B.NETHER_PORTAL;
  for (let py = frame.minY; py <= frame.maxY; py++) {
    for (let pz = frame.minZ; pz <= frame.maxZ; pz++) {
      for (let px = frame.minX; px <= frame.maxX; px++) {
        world.setBlock(px, py, pz, portal);
      }
    }
  }
  return frame;
}

/**
 * Light a portal the way flint and steel does: try both plane orientations at
 * the given position and fill whichever frame validates.
 * @param {Object} world the `World` to edit
 * @param {number} x block x the flame would occupy
 * @param {number} y block y the flame would occupy
 * @param {number} z block z the flame would occupy
 * @param {{axis?:('x'|'z')}} [opts] force a plane orientation
 * @returns {?PortalRecord} the lit portal, or `null` when there is no frame
 */
export function ignitePortal(world, x, y, z, opts = {}) {
  const preferred = opts.axis === 'x' || opts.axis === 'z' ? opts.axis : null;
  const order = preferred === null ? ['x', 'z'] : [preferred, preferred === 'x' ? 'z' : 'x'];
  for (let i = 0; i < order.length; i++) {
    const built = buildPortal(world, x, y, z, /** @type {'x'|'z'} */ (order[i]));
    if (built !== null) return built;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* DimensionManager                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} DimensionRecord
 * @property {string} id dimension id
 * @property {number} seed generator seed used for this dimension
 * @property {boolean} visited whether the player has ever been here
 * @property {number} lastVisit `nowMs()` of the last activation
 * @property {[number,number,number]} lastPos last known player position here
 * @property {number} lastYaw last known player yaw here
 */

/**
 * Owns one {@link World} per visited dimension, switches the active one and
 * runs the portal mechanic.
 *
 * The manager never touches the renderer and never imports `game/game.js`; the
 * integrator passes the handles it needs and listens for `'switched'` to
 * re-point everything a world change invalidates.
 *
 * @fires DimensionManager#switching
 * @fires DimensionManager#switched
 * @fires DimensionManager#worldCreated
 * @fires DimensionManager#worldRetired
 * @fires DimensionManager#portalCreated
 * @fires DimensionManager#travel
 * @fires DimensionManager#travelFailed
 * @fires DimensionManager#evaporate
 * @fires DimensionManager#error
 */
export class DimensionManager extends EventBus {
  /**
   * @param {Object} ctx live subsystem handles
   * @param {Object} ctx.gl the `GL` wrapper (forwarded to every `World`)
   * @param {Object} ctx.settings the live `Settings`
   * @param {Object} ctx.world the already-built world of the starting dimension
   * @param {Object} [ctx.player] the local `Player`
   * @param {Object} [ctx.entities] the `EntityManager`
   * @param {Object} [ctx.environment] the `Environment`
   * @param {Object} [ctx.saveManager] the `SaveManager`
   * @param {number} [ctx.seed] world seed (defaults to `ctx.world.seed`)
   * @param {string} [ctx.worldId] persistence id of the save
   * @param {string} [ctx.worldName] display name of the save
   * @param {Object} [options] behaviour switches
   * @param {string} [options.active='overworld'] starting dimension
   * @param {('frozen'|'slow')} [options.idleMode='frozen'] what inactive worlds do
   * @param {number} [options.idlePulseTicks=100] ticks between idle pulses
   * @param {number} [options.idleRetireSeconds=180] idle seconds before a world
   *   is saved and disposed (`0` keeps worlds resident forever)
   * @param {boolean} [options.manageEnvironment=true] apply the sky/fog override
   * @param {boolean} [options.managePortals=true] run the per-entity portal timers
   * @param {Object} [options.generatorOptions] options forwarded to every generator
   */
  constructor(ctx = {}, options = {}) {
    super();

    /** @type {Object} the `GL` wrapper. */
    this.gl = ctx.gl || null;
    /** @type {Object} live settings. */
    this.settings = ctx.settings || null;
    /** @type {?Object} the local player. */
    this.player = ctx.player || null;
    /** @type {?Object} the entity manager. */
    this.entities = ctx.entities || null;
    /** @type {?Object} the environment. */
    this.environment = ctx.environment || null;
    /** @type {?Object} the save manager. */
    this.saveManager = ctx.saveManager || null;

    /** @type {number} world seed shared by every dimension. */
    this.seed = num(ctx.seed, ctx.world ? num(ctx.world.seed, 0) : 0) | 0;
    /** @type {string} persistence id of the save. */
    this.worldId = typeof ctx.worldId === 'string' && ctx.worldId.length !== 0
      ? ctx.worldId
      : (ctx.world && typeof ctx.world.worldId === 'string' ? ctx.world.worldId : 'world');
    /** @type {string} display name of the save. */
    this.worldName = typeof ctx.worldName === 'string' && ctx.worldName.length !== 0
      ? ctx.worldName
      : (ctx.world && typeof ctx.world.name === 'string' ? ctx.world.name : 'world');

    /** @type {Object} generator options forwarded to every dimension. */
    this.generatorOptions = options.generatorOptions || {};
    /** @type {'frozen'|'slow'} what inactive worlds do. */
    this.idleMode = options.idleMode === 'slow' ? 'slow' : 'frozen';
    /** @type {number} ticks between idle-world maintenance pulses. */
    this.idlePulseTicks = Math.max(1, (options.idlePulseTicks | 0) || IDLE_PULSE_TICKS);
    /** @type {number} idle seconds before a world is retired (`0` = never). */
    this.idleRetireSeconds = num(options.idleRetireSeconds, DEFAULT_IDLE_RETIRE_SECONDS);
    /** @type {boolean} whether the sky/fog override is applied every tick. */
    this.manageEnvironment = options.manageEnvironment !== false;
    /** @type {boolean} whether the per-entity portal timers run. */
    this.managePortals = options.managePortals !== false;

    /** @type {string} id of the active dimension. */
    this.active = isDimension(options.active) ? options.active : 'overworld';

    /** @type {Map<string, Object>} live worlds keyed by dimension id. */
    this.worlds = new Map();
    /** @type {Map<string, DimensionRecord>} which dimensions exist. */
    this.records = new Map();
    /** @type {Map<string, PortalRecord[]>} known portals per dimension. */
    this.portals = new Map();

    if (ctx.world) {
      ctx.world.dimension = this.active;
      this.worlds.set(this.active, ctx.world);
    }
    this._touchRecord(this.active);

    /** @type {boolean} `true` while a travel promise is in flight. */
    this.travelling = false;
    /** @type {boolean} set by {@link DimensionManager#dispose}. */
    this.disposed = false;

    /* ---- per-entity portal state -------------------------------------- */
    /** @type {Map<number|string, {ticks:number, cooldown:number, inside:boolean}>} @private */
    this._portalState = new Map();
    /** @type {Object[]} reused entity query buffer. @private */
    this._entityScratch = [];
    /** @type {TimeBudget} @private */
    this._budget = new TimeBudget(PORTAL_BUDGET_MS);
    /** @type {number} tick counter. @private */
    this._ticks = 0;
    /** @type {number} ticks until the next region resample. @private */
    this._envTimer = 0;
    /** @type {?[number,number,number]} cached per-region fog tint. @private */
    this._fogTint = null;
    /** @type {number[]} scratch camera position for idle pulses. @private */
    this._idleCam = [0, 0, 0];
    /** @type {number[]} scratch camera position for destination streaming. @private */
    this._loadCam = [0, 0, 0];
    /** @type {Map<string, Object>} parked entity snapshots per dimension. @private */
    this._entityStore = new Map();
    /** @type {Map<string, number>} `nowMs()` an inactive world went idle. @private */
    this._idleSince = new Map();
    /** @type {boolean} whether we froze the environment clock ourselves. @private */
    this._frozeClock = false;
    /** @type {boolean} previous `environment.frozen` value. @private */
    this._prevFrozen = false;
  }

  /* ====================================================================== */
  /* Registry access                                                        */
  /* ====================================================================== */

  /**
   * The active dimension's definition.
   * @returns {DimensionDef} definition
   */
  getDimensionDef() {
    return getDimension(this.active);
  }

  /**
   * The German display name of a dimension.
   * @param {string} [id] dimension id (defaults to the active one)
   * @returns {string} display name
   */
  getDisplayName(id = this.active) {
    return getDimension(id).display;
  }

  /**
   * The live world of a dimension, if it is resident.
   * @param {string} [id] dimension id (defaults to the active one)
   * @returns {?Object} the `World`, or `null`
   */
  getWorld(id = this.active) {
    const w = this.worlds.get(id);
    return w === undefined ? null : w;
  }

  /**
   * Whether the player can travel to a dimension right now.
   * @param {string} id dimension id
   * @returns {{ok:boolean, reason:string}} verdict with a German reason
   */
  canEnter(id) {
    if (!isDimension(id)) return { ok: false, reason: 'Unbekannte Dimension.' };
    if (!hasDimensionGenerator(id)) {
      return { ok: false, reason: `${getDimension(id).display} ist noch nicht begehbar.` };
    }
    if (this.disposed) return { ok: false, reason: 'Die Welt wurde bereits geschlossen.' };
    return { ok: true, reason: '' };
  }

  /**
   * Whether placed water boils away in a dimension.
   * @param {string} [id] dimension id
   * @returns {boolean} `true` in the Nether
   */
  waterEvaporates(id = this.active) {
    return getDimension(id).waterEvaporates === true;
  }

  /**
   * Whether sleeping detonates the bed in a dimension.
   * @param {string} [id] dimension id
   * @returns {boolean} `true` in the Nether and the End
   */
  bedsExplode(id = this.active) {
    return getDimension(id).bedsExplode === true;
  }

  /**
   * Gate a liquid placement through the dimension's rules.
   *
   * Call this from `game/interaction.js` before emptying a bucket: in the
   * Nether the water flashes to steam instead of being placed.
   *
   * @param {number} x block x
   * @param {number} y block y
   * @param {number} z block z
   * @param {number} blockId fluid block that would be placed
   * @returns {boolean} `true` when the fluid may be placed, `false` when it
   *   evaporated (a `'evaporate'` event is emitted in that case)
   */
  allowLiquidPlacement(x, y, z, blockId) {
    if (!this.waterEvaporates()) return true;
    if (blockId !== B.WATER && blockId !== B.STILL_WATER) return true;
    /**
     * Water boiled away instead of being placed.
     * @event DimensionManager#evaporate
     */
    this.emit('evaporate', Math.floor(x), Math.floor(y), Math.floor(z), blockId);
    return false;
  }

  /* ====================================================================== */
  /* World lifecycle                                                        */
  /* ====================================================================== */

  /**
   * Persistence id of one dimension's chunk store. The Overworld keeps the
   * bare save id so existing saves stay readable; every other dimension gets a
   * suffix so their chunks can never collide.
   * @param {string} id dimension id
   * @returns {string} storage id
   */
  storageIdFor(id) {
    return id === 'overworld' ? this.worldId : `${this.worldId}:${id}`;
  }

  /**
   * Create or fetch the record describing one dimension.
   * @param {string} id dimension id
   * @returns {DimensionRecord} the record
   * @private
   */
  _touchRecord(id) {
    let rec = this.records.get(id);
    if (rec === undefined) {
      const def = getDimension(id);
      rec = {
        id,
        seed: this.seed,
        visited: false,
        lastVisit: 0,
        lastPos: [0, def.defaultSpawnY, 0],
        lastYaw: 0,
      };
      this.records.set(id, rec);
    }
    if (!this.portals.has(id)) this.portals.set(id, []);
    return rec;
  }

  /**
   * Build (or return) the world of one dimension, with the right generator.
   * @param {string} id dimension id
   * @returns {Promise<?Object>} the `World`, or `null` when it cannot be built
   */
  async ensureWorld(id) {
    const existing = this.worlds.get(id);
    if (existing !== undefined && !existing.disposed) return existing;

    const check = this.canEnter(id);
    if (!check.ok) return null;

    const rec = this._touchRecord(id);
    const def = getDimension(id);
    let world = null;
    try {
      world = new World(this.gl, this.settings, {
        seed: rec.seed,
        name: this.worldName,
        id: this.storageIdFor(id),
        dimension: id,
        generator: this.generatorOptions,
      });
      if (this.saveManager) world.setSaveManager(this.saveManager, this.storageIdFor(id));
      world.on('error', (where, err) => this._report(`world:${id}:${where}`, err));
      await world.init();
    } catch (err) {
      this._report(`ensureWorld:${id}`, err);
      if (world) {
        try { world.dispose(); } catch { /* already broken */ }
      }
      return null;
    }

    // `World.init()` always builds an overworld generator; swap in the right
    // one for anything else so main-thread queries (height, biome, the
    // no-worker fallback path) answer for the correct dimension.
    if (id !== 'overworld') {
      const gen = createDimensionGenerator(id, rec.seed, this.generatorOptions);
      if (gen !== null) {
        const previous = world.generator;
        world.generator = gen;
        if (previous && previous !== gen && typeof previous.dispose === 'function') {
          try { previous.dispose(); } catch { /* nothing to release */ }
        }
      } else {
        warnOnce(`nogen:${id}`, `no generator registered for "${id}"; using the overworld one`);
      }
    }

    this.worlds.set(id, world);
    this._idleSince.delete(id);
    /**
     * A dimension's world was created.
     * @event DimensionManager#worldCreated
     */
    this.emit('worldCreated', id, world, def);
    return world;
  }

  /**
   * Make a dimension the active one.
   *
   * The caller is responsible for everything that is *not* world-shaped —
   * re-pointing `game.world`, rebuilding the `MobSpawner`, re-wiring world
   * events — which is what the `'switched'` event is for.
   *
   * @param {string} id dimension id
   * @param {{x?:number, y?:number, z?:number, keepEntities?:boolean}} [opts]
   *   optional arrival position; `keepEntities` skips the entity swap
   * @returns {Promise<?Object>} the now-active `World`, or `null` on failure
   */
  async switchTo(id, opts = {}) {
    if (this.disposed) return null;
    if (id === this.active) return this.getWorld(id);
    const world = await this.ensureWorld(id);
    if (world === null) return null;

    const from = this.active;
    /**
     * A dimension switch is starting.
     * @event DimensionManager#switching
     */
    this.emit('switching', from, id);

    this._stashPlayerPosition(from);
    if (opts.keepEntities !== true) this._swapEntities(from, id, world);

    this.active = id;
    const rec = this._touchRecord(id);
    rec.visited = true;
    rec.lastVisit = nowMs();
    this._idleSince.set(from, nowMs());
    this._idleSince.delete(id);
    this._fogTint = null;
    this._envTimer = 0;

    if (this.player) {
      this.player.world = world;
      if (Number.isFinite(opts.x) && Number.isFinite(opts.y) && Number.isFinite(opts.z)) {
        try {
          this.player.teleport(opts.x, opts.y, opts.z);
        } catch (err) {
          this._report('player:teleport', err);
        }
      }
      rec.lastPos[0] = this.player.position[0];
      rec.lastPos[1] = this.player.position[1];
      rec.lastPos[2] = this.player.position[2];
      rec.lastYaw = num(this.player.yaw, 0);
    }

    this._applyEnvironmentClock(id);

    /**
     * The active dimension changed.
     * @event DimensionManager#switched
     */
    this.emit('switched', id, world, from, getDimension(id));
    return world;
  }

  /**
   * Remember where the player stood in a dimension.
   * @param {string} id dimension id
   * @returns {void}
   * @private
   */
  _stashPlayerPosition(id) {
    if (!this.player || !this.player.position) return;
    const rec = this._touchRecord(id);
    rec.lastPos[0] = this.player.position[0];
    rec.lastPos[1] = this.player.position[1];
    rec.lastPos[2] = this.player.position[2];
    rec.lastYaw = num(this.player.yaw, 0);
  }

  /**
   * Park the entities of the dimension we are leaving and restore the ones
   * belonging to the dimension we are entering.
   * @param {string} from dimension being left
   * @param {string} to dimension being entered
   * @param {Object} world the destination world
   * @returns {void}
   * @private
   */
  _swapEntities(from, to, world) {
    const em = this.entities;
    if (!em || typeof em.serialize !== 'function') return;
    try {
      this._entityStore.set(from, em.serialize());
    } catch (err) {
      this._report('entities:serialize', err);
    }
    try {
      if (typeof em.clear === 'function') em.clear();
      if (typeof em.setWorld === 'function') em.setWorld(world);
      const stored = this._entityStore.get(to);
      if (stored && typeof em.deserialize === 'function') em.deserialize(stored);
    } catch (err) {
      this._report('entities:swap', err);
    }
    this._portalState.clear();
  }

  /**
   * Freeze or release the day/night clock to match a dimension.
   * @param {string} id dimension id
   * @returns {void}
   * @private
   */
  _applyEnvironmentClock(id) {
    const env = this.environment;
    if (!env || !this.manageEnvironment) return;
    const def = getDimension(id);
    try {
      if (!def.hasDayCycle) {
        if (!this._frozeClock) {
          this._prevFrozen = env.frozen === true;
          this._frozeClock = true;
        }
        if (typeof env.setFrozen === 'function') env.setFrozen(true);
        else env.frozen = true;
      } else if (this._frozeClock) {
        this._frozeClock = false;
        if (typeof env.setFrozen === 'function') env.setFrozen(this._prevFrozen);
        else env.frozen = this._prevFrozen;
      }
    } catch (err) {
      this._report('environment:clock', err);
    }
  }

  /* ====================================================================== */
  /* Tick                                                                   */
  /* ====================================================================== */

  /**
   * Advance the manager by one fixed game tick.
   *
   * Call **after** `environment.update()` and `entities.update()` inside
   * `game.tick()`, and never from the render frame: everything here is written
   * against a 20 Hz clock and takes `dt` in seconds.
   *
   * Never throws: every stage is guarded and degrades to a no-op.
   *
   * @param {number} dt seconds since the previous tick
   * @returns {void}
   */
  tick(dt) {
    if (this.disposed) return;
    const step = clamp(num(dt, 0), 0, 0.25);
    if (step <= 0) return;
    this._ticks++;

    if (this.manageEnvironment) {
      try {
        this._tickEnvironment();
      } catch (err) {
        this._report('tick:environment', err);
      }
    }
    if (this.managePortals && !this.travelling) {
      try {
        this._tickPortals(step);
      } catch (err) {
        this._report('tick:portals', err);
      }
    }
    try {
      this._tickIdleWorlds(step);
    } catch (err) {
      this._report('tick:idle', err);
    }
  }

  /**
   * Re-apply the dimension's sky/fog treatment, refreshing the per-region fog
   * tint once a second.
   * @returns {void}
   * @private
   */
  _tickEnvironment() {
    const env = this.environment;
    if (!env) return;
    const def = this.getDimensionDef();

    if (this._envTimer <= 0) {
      this._envTimer = ENV_REGION_INTERVAL;
      this._fogTint = this._sampleRegionFog(def);
    } else {
      this._envTimer--;
    }
    applyDimensionEnvironment(env, this.active, this._fogTint);
  }

  /**
   * Fog tint of the Nether region under the player, when the generator can
   * name one.
   * @param {DimensionDef} def active dimension
   * @returns {?[number,number,number]} tint, or `null` for the dimension default
   * @private
   */
  _sampleRegionFog(def) {
    if (def.id !== 'nether' || !this.player) return null;
    const world = this.getWorld();
    const gen = world ? world.generator : null;
    if (!gen || typeof gen.getRegionAt !== 'function') return null;
    try {
      const px = Math.floor(this.player.position[0]);
      const pz = Math.floor(this.player.position[2]);
      const region = gen.getRegionAt(px, pz);
      const table = NETHER_REGION_FOG;
      return table[region] === undefined ? null : table[region];
    } catch (err) {
      warnOnce('regionFog', 'region fog lookup failed; using the dimension default', err);
      return null;
    }
  }

  /**
   * Run every inactive world's maintenance pulse and retire the ones that have
   * been idle for too long.
   * @param {number} dt seconds since the previous tick
   * @returns {void}
   * @private
   */
  _tickIdleWorlds(dt) {
    if (this.worlds.size < 2) return;
    if ((this._ticks % this.idlePulseTicks) !== 0) return;
    const now = nowMs();

    for (const [id, world] of this.worlds) {
      if (id === this.active || !world || world.disposed) continue;
      const since = this._idleSince.get(id);
      if (since === undefined) this._idleSince.set(id, now);

      if (this.idleMode === 'slow') {
        const rec = this.records.get(id);
        if (rec) {
          this._idleCam[0] = rec.lastPos[0];
          this._idleCam[1] = rec.lastPos[1];
          this._idleCam[2] = rec.lastPos[2];
          try {
            world.update(dt * this.idlePulseTicks, this._idleCam, null);
          } catch (err) {
            this._report(`idle:update:${id}`, err);
          }
        }
      } else if (world.lighting && world.lighting.pending !== 0) {
        // Frozen: nothing streams, but the light queue left over from the last
        // block edits still drains so the world is consistent when we return.
        try {
          world.lighting.process(IDLE_BUDGET_MS);
        } catch (err) {
          this._report(`idle:light:${id}`, err);
        }
      }

      const idleFor = (now - (this._idleSince.get(id) || now)) / 1000;
      if (this.idleRetireSeconds > 0 && idleFor >= this.idleRetireSeconds) {
        this.retireWorld(id);
      }
    }
  }

  /**
   * Save and dispose an inactive dimension's world, freeing its worker pool
   * and chunk memory. The record and its portals survive, so walking back
   * rebuilds the same world.
   * @param {string} id dimension id
   * @returns {boolean} `true` when a world was retired
   */
  retireWorld(id) {
    if (id === this.active) return false;
    const world = this.worlds.get(id);
    if (world === undefined) return false;
    this.worlds.delete(id);
    this._idleSince.delete(id);
    try {
      if (typeof world.save === 'function') Promise.resolve(world.save()).catch(() => undefined);
    } catch (err) {
      this._report(`retire:save:${id}`, err);
    }
    try {
      world.dispose();
    } catch (err) {
      this._report(`retire:dispose:${id}`, err);
    }
    /**
     * An inactive dimension's world was disposed.
     * @event DimensionManager#worldRetired
     */
    this.emit('worldRetired', id);
    return true;
  }

  /* ====================================================================== */
  /* Portal dwell timers                                                    */
  /* ====================================================================== */

  /**
   * Advance the per-entity portal dwell timers and fire travel when one is
   * full. Time-budgeted: the entity scan stops early and resumes next tick.
   * @param {number} dt seconds since the previous tick
   * @returns {void}
   * @private
   */
  _tickPortals(dt) {
    const world = this.getWorld();
    if (!world) return;
    const def = this.getDimensionDef();
    const target = def.portalTarget;

    // The player first — it is the only entity whose dwell is 4 seconds long.
    const player = this.player;
    if (player && player.position) {
      const state = this._stateFor('player');
      if (state.cooldown > 0) state.cooldown--;
      const inside = this._isInPortal(world, player.position[0],
        player.position[1] + 0.9, player.position[2]);
      if (!inside) {
        state.ticks = 0;
        state.inside = false;
      } else {
        state.inside = true;
        state.ticks++;
        if (state.cooldown === 0 && state.ticks >= PORTAL_PLAYER_TICKS && target !== null) {
          state.ticks = 0;
          state.cooldown = PORTAL_COOLDOWN_TICKS;
          this.travelThroughPortal(player, target, 'player');
          return;
        }
      }
    }

    const em = this.entities;
    if (!em || typeof em.queryRadius !== 'function' || !player) return;

    const list = this._entityScratch;
    list.length = 0;
    try {
      em.queryRadius(player.position[0], player.position[1], player.position[2],
        PORTAL_ENTITY_RADIUS, list);
    } catch (err) {
      this._report('portals:query', err);
      return;
    }

    const budget = this._budget;
    budget.setBudget(PORTAL_BUDGET_MS).start();
    for (let i = 0; i < list.length; i++) {
      if ((i & 15) === 0 && budget.expired()) break;
      const e = list[i];
      if (!e || e.dead || e.removed || !e.position) continue;
      const state = this._stateFor(e.id);
      if (state.cooldown > 0) { state.cooldown--; continue; }
      if (!this._isInPortal(world, e.position[0], e.position[1] + 0.4, e.position[2])) {
        state.ticks = 0;
        state.inside = false;
        continue;
      }
      state.inside = true;
      state.ticks++;
      if (state.ticks > PORTAL_ENTITY_TICKS && target !== null) {
        state.ticks = 0;
        state.cooldown = PORTAL_COOLDOWN_TICKS;
        // Other entities travel instantly, but only one per tick so a herd
        // standing in a portal cannot chain-load the destination.
        this.travelThroughPortal(e, target, 'entity');
        break;
      }
    }

    if (this._portalState.size > 512) this._prunePortalState();
  }

  /**
   * Fetch (or create) the portal state record of one entity.
   * @param {number|string} key entity id, or `'player'`
   * @returns {{ticks:number, cooldown:number, inside:boolean}} the record
   * @private
   */
  _stateFor(key) {
    let s = this._portalState.get(key);
    if (s === undefined) {
      s = { ticks: 0, cooldown: 0, inside: false };
      this._portalState.set(key, s);
    }
    return s;
  }

  /**
   * Drop portal records of entities that are neither inside a portal nor on
   * cooldown, so a busy world cannot grow the map without bound.
   * @returns {void}
   * @private
   */
  _prunePortalState() {
    for (const [key, s] of this._portalState) {
      if (key === 'player') continue;
      if (s.cooldown === 0 && s.ticks === 0 && !s.inside) this._portalState.delete(key);
    }
  }

  /**
   * Whether a world position sits inside a portal block.
   * @param {Object} world the world to read
   * @param {number} x world x
   * @param {number} y world y
   * @param {number} z world z
   * @returns {boolean} `true` when the block is a portal
   * @private
   */
  _isInPortal(world, x, y, z) {
    return world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === B.NETHER_PORTAL;
  }

  /* ====================================================================== */
  /* Travel                                                                 */
  /* ====================================================================== */

  /**
   * Send an entity through a portal into another dimension.
   *
   * Only the player actually changes dimension — the manager owns exactly one
   * active world, so a mob that walks into a portal is removed from this side
   * and remembered on the other (the same thing a chunk unload would do).
   *
   * @param {Object} entity the traveller (the player, or any `Entity`)
   * @param {string} toId destination dimension
   * @param {('player'|'entity')} [kind='player'] traveller kind
   * @returns {Promise<boolean>} `true` when the travel completed
   */
  async travelThroughPortal(entity, toId, kind = 'player') {
    if (this.disposed || this.travelling) return false;
    const check = this.canEnter(toId);
    if (!check.ok) {
      /**
       * A travel attempt was refused.
       * @event DimensionManager#travelFailed
       */
      this.emit('travelFailed', entity, toId, check.reason);
      return false;
    }
    const fromId = this.active;
    const isPlayer = kind === 'player' || entity === this.player;

    if (!isPlayer) {
      // Non-players are simply consumed by the portal on this side.
      try {
        if (typeof entity.remove === 'function') entity.remove('portal');
      } catch (err) {
        this._report('travel:removeEntity', err);
      }
      this.emit('travel', entity, fromId, toId, null);
      return true;
    }

    this.travelling = true;
    try {
      const sx = num(entity.position[0], 0);
      const sy = num(entity.position[1], 64);
      const sz = num(entity.position[2], 0);

      const world = await this.ensureWorld(toId);
      if (world === null) {
        this.emit('travelFailed', entity, toId, check.reason || 'Ziel nicht erreichbar.');
        return false;
      }

      const tx = scaleCoordinate(sx, fromId, toId);
      const tz = scaleCoordinate(sz, fromId, toId);
      const toDef = getDimension(toId);
      const ty = Math.round(clamp(sy, toDef.minY + 4, toDef.maxY - 6));

      // The portal we are standing in, if we know it. Its recorded link is what
      // makes the return trip land on the portal we originally came from
      // instead of building a second one next to it.
      const source = this._portalContaining(fromId, sx, sy + 0.9, sz);
      const link = source === null
        ? { dimension: fromId, x: Math.floor(sx), y: Math.floor(sy), z: Math.floor(sz) }
        : { dimension: fromId, x: source.x, y: source.y, z: source.z };

      let destination = await this._followLink(source, toId);
      if (destination === null) {
        destination = await this.findOrCreateDestination(toId, tx, ty, tz, link);
      }
      if (destination === null) {
        this.emit('travelFailed', entity, toId, 'Es konnte kein Portal gebaut werden.');
        return false;
      }
      if (source !== null && source.link === null) {
        source.link = {
          dimension: toId, x: destination.x, y: destination.y, z: destination.z,
        };
      }

      const spot = this._exitPosition(destination);
      await this.switchTo(toId, { x: spot[0], y: spot[1], z: spot[2] });

      const state = this._stateFor('player');
      state.cooldown = PORTAL_COOLDOWN_TICKS;
      state.ticks = 0;
      state.inside = true;

      /**
       * A traveller changed dimension.
       * @event DimensionManager#travel
       */
      this.emit('travel', entity, fromId, toId, spot);
      return true;
    } catch (err) {
      this._report('travel', err);
      this.emit('travelFailed', entity, toId, 'Die Reise ist fehlgeschlagen.');
      return false;
    } finally {
      this.travelling = false;
    }
  }

  /**
   * The registered portal whose interior contains a position, with one block of
   * slack so a traveller standing on the rim still counts.
   * @param {string} id dimension id
   * @param {number} x world x
   * @param {number} y world y
   * @param {number} z world z
   * @returns {?PortalRecord} the portal, or `null`
   * @private
   */
  _portalContaining(id, x, y, z) {
    const list = this.portals.get(id);
    if (list === undefined) return null;
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (bx < p.minX - 1 || bx > p.maxX + 1) continue;
      if (by < p.minY - 1 || by > p.maxY + 1) continue;
      if (bz < p.minZ - 1 || bz > p.maxZ + 1) continue;
      return p;
    }
    return null;
  }

  /**
   * Resolve a portal's recorded partner on the other side, if it is still
   * standing. This is what turns a one-way trip into a stable portal pair.
   * @param {?PortalRecord} source the portal being entered
   * @param {string} toId destination dimension
   * @returns {Promise<?PortalRecord>} the partner, or `null`
   * @private
   */
  async _followLink(source, toId) {
    if (source === null || source.link === null) return null;
    if (source.link.dimension !== toId) return null;
    const world = await this.ensureWorld(toId);
    if (world === null) return null;
    const partner = this.findNearestPortal(toId, source.link.x, source.link.y, source.link.z, 8);
    if (partner === null) return null;
    if (!await this._ensureArea(world, partner.x, partner.z)) return null;
    if (world.getBlock(partner.x, partner.y, partner.z) !== B.NETHER_PORTAL) {
      this.forgetPortal(partner);
      source.link = null;
      return null;
    }
    return partner;
  }

  /**
   * Where an arriving traveller is placed for a portal.
   * @param {PortalRecord} portal the destination portal
   * @returns {number[]} `[x, y, z]` feet position
   * @private
   */
  _exitPosition(portal) {
    const cx = (portal.minX + portal.maxX) * 0.5 + 0.5;
    const cz = (portal.minZ + portal.maxZ) * 0.5 + 0.5;
    return [cx, portal.minY, cz];
  }

  /**
   * Find an existing portal near a destination or build a fresh one, complete
   * with the platform it stands on.
   *
   * @param {string} toId destination dimension
   * @param {number} x scaled destination x
   * @param {number} y preferred destination y
   * @param {number} z scaled destination z
   * @param {?{dimension:string, x:number, y:number, z:number}} [link] the portal
   *   this trip started from, recorded so the return trip lands on the same pair
   * @returns {Promise<?PortalRecord>} the destination portal, or `null`
   */
  async findOrCreateDestination(toId, x, y, z, link = null) {
    const world = await this.ensureWorld(toId);
    if (world === null) return null;

    const existing = this.findNearestPortal(toId, x, y, z, PORTAL_SEARCH_RADIUS);
    if (existing !== null) {
      const ok = await this._ensureArea(world, existing.x, existing.z);
      // A portal we remember may have been mined out while we were away.
      if (ok && world.getBlock(existing.x, existing.y, existing.z) === B.NETHER_PORTAL) {
        if (link !== null && existing.link === null) existing.link = link;
        return existing;
      }
      this.forgetPortal(existing);
    }

    const loaded = await this._ensureArea(world, x, z);
    if (!loaded) {
      warnOnce(`area:${toId}`, `destination area in "${toId}" did not stream in; building blind`);
    }

    const def = getDimension(toId);
    const spot = this._findPlatformSpot(world, def, x, y, z);
    const axis = /** @type {'x'|'z'} */ (((x + z) & 1) === 0 ? 'x' : 'z');
    const portal = this._carvePortal(world, def, spot[0], spot[1], spot[2], axis);
    if (portal === null) return null;
    portal.link = link;
    this.registerPortal(portal);
    /**
     * A portal was created by the destination search.
     * @event DimensionManager#portalCreated
     */
    this.emit('portalCreated', portal);
    return portal;
  }

  /**
   * Stream the chunks around a position in so they can be edited.
   * @param {Object} world the world to pump
   * @param {number} x world x
   * @param {number} z world z
   * @returns {Promise<boolean>} `true` when the area is loaded
   * @private
   */
  async _ensureArea(world, x, z) {
    const cx = Math.floor(x) >> 4;
    const cz = Math.floor(z) >> 4;
    const cam = this._loadCam;
    cam[0] = Math.floor(x) + 0.5;
    cam[1] = getDimension(world.dimension || this.active).defaultSpawnY;
    cam[2] = Math.floor(z) + 0.5;

    const deadline = nowMs() + AREA_LOAD_TIMEOUT_MS;
    while (nowMs() < deadline) {
      if (this.disposed || world.disposed) return false;
      let ready = true;
      for (let dz = -AREA_LOAD_RADIUS; dz <= AREA_LOAD_RADIUS && ready; dz++) {
        for (let dx = -AREA_LOAD_RADIUS; dx <= AREA_LOAD_RADIUS; dx++) {
          const chunk = world.getChunk(cx + dx, cz + dz);
          if (!chunk || !chunk.generated) { ready = false; break; }
        }
      }
      if (ready) return true;
      try {
        world.update(1 / TICKS_PER_SECOND, cam, null);
      } catch (err) {
        this._report('ensureArea:update', err);
        return false;
      }
      await frameYield();
    }
    return false;
  }

  /**
   * Pick a spot for a new portal: a solid floor with head room, away from lava,
   * as close as possible to the scaled destination.
   * @param {Object} world destination world
   * @param {DimensionDef} def destination dimension
   * @param {number} x scaled x
   * @param {number} y preferred y
   * @param {number} z scaled z
   * @returns {number[]} `[x, y, z]` of the portal's lowest interior block
   * @private
   */
  _findPlatformSpot(world, def, x, y, z) {
    const budget = new TimeBudget(4).start();
    // `minY + 8` keeps the frame clear of the bedrock floor in every dimension.
    const loY = Math.max(def.minY + 8, def.id === 'nether' ? NETHER_LAVA_LEVEL + 4 : def.minY + 8);
    const hiY = Math.min(def.maxY - 6, def.id === 'nether' ? NETHER_CEILING_Y - 6 : def.maxY - 6);
    let best = null;
    let bestScore = -Infinity;

    for (let i = 0; i < PLATFORM_OFFSETS.length; i += 2) {
      if (budget.expired()) break;
      const px = x + PLATFORM_OFFSETS[i];
      const pz = z + PLATFORM_OFFSETS[i + 1];
      for (let py = hiY; py >= loY; py--) {
        if (((hiY - py) & 15) === 0 && budget.expired()) break;
        const floor = world.getBlock(px, py - 1, pz);
        if (floor === 0 || isLiquid(floor) || !isSolid(floor)) continue;
        if (!isClearColumn(world, px, py, pz, 4)) continue;
        if (nearLava(world, px, py, pz)) continue;
        const score = -Math.abs(py - y) - 0.35 * (Math.abs(PLATFORM_OFFSETS[i])
          + Math.abs(PLATFORM_OFFSETS[i + 1]));
        if (score > bestScore) {
          bestScore = score;
          best = [px, py, pz];
        }
        break;
      }
    }

    if (best !== null) return best;
    // Nothing suitable: carve a shelf at the preferred height instead.
    const fallbackY = Math.round(clamp(y, loY, hiY));
    return [x, fallbackY, z];
  }

  /**
   * Carve a safe pocket, lay an obsidian platform and raise a `4 x 5` frame,
   * then fill it with portal blocks.
   * @param {Object} world destination world
   * @param {DimensionDef} def destination dimension
   * @param {number} x lowest interior x
   * @param {number} y lowest interior y
   * @param {number} z lowest interior z
   * @param {'x'|'z'} axis plane orientation
   * @returns {?PortalRecord} the finished portal, or `null` when nothing could
   *   be written (the chunks are not loaded)
   * @private
   */
  _carvePortal(world, def, x, y, z, axis) {
    const frameBlock = def.portalFrameBlock;
    const portalBlock = B.NETHER_PORTAL;
    const along = axis === 'x' ? 1 : 0;
    const across = axis === 'x' ? 0 : 1;

    // Clearance: 3 blocks out along the plane, 2 across, 6 tall.
    for (let dy = -1; dy <= 6; dy++) {
      for (let da = -3; da <= 4; da++) {
        for (let dc = -2; dc <= 2; dc++) {
          const bx = x + da * along + dc * across;
          const bz = z + da * across + dc * along;
          const by = y + dy;
          if (by <= def.minY || by >= def.maxY - 1) continue;
          const cur = world.getBlock(bx, by, bz);
          if (cur === B.BEDROCK) continue;
          if (dy === -1) {
            // Floor slab, so the platform is never lava or thin air.
            world.setBlock(bx, by, bz, frameBlock);
          } else if (cur !== 0) {
            world.setBlock(bx, by, bz, 0);
          }
        }
      }
    }

    // Frame ring: interior 2 wide x 3 tall, corners included.
    for (let da = -1; da <= 2; da++) {
      for (let dy = -1; dy <= 3; dy++) {
        const inner = da >= 0 && da <= 1 && dy >= 0 && dy <= 2;
        if (inner) continue;
        const bx = x + da * along;
        const bz = z + da * across;
        world.setBlock(bx, y + dy, bz, frameBlock);
      }
    }

    // Interior.
    for (let da = 0; da <= 1; da++) {
      for (let dy = 0; dy <= 2; dy++) {
        world.setBlock(x + da * along, y + dy, z + da * across, portalBlock);
      }
    }

    const built = validatePortalFrame(world, x, y, z, axis, frameBlock);
    if (built !== null) {
      built.dimension = def.id;
      return built;
    }
    // The chunks were not writable; report honestly rather than inventing a
    // portal record that points at nothing.
    warnOnce(`carve:${def.id}`, `portal frame in "${def.id}" could not be written`);
    return null;
  }

  /* ====================================================================== */
  /* Portal registry                                                        */
  /* ====================================================================== */

  /**
   * Remember a portal so the destination search can find it later.
   * @param {PortalRecord} portal the portal
   * @returns {PortalRecord} the same record
   */
  registerPortal(portal) {
    if (!portal) return portal;
    const id = portal.dimension;
    if (!this.portals.has(id)) this.portals.set(id, []);
    const list = this.portals.get(id);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.minX === portal.minX && p.minY === portal.minY && p.minZ === portal.minZ) {
        list[i] = portal;
        return portal;
      }
    }
    list.push(portal);
    return portal;
  }

  /**
   * Forget a portal (it was mined out, or it never existed).
   * @param {PortalRecord} portal the portal
   * @returns {boolean} `true` when it was in the registry
   */
  forgetPortal(portal) {
    if (!portal) return false;
    const list = this.portals.get(portal.dimension);
    if (list === undefined) return false;
    const at = list.indexOf(portal);
    if (at < 0) return false;
    list.splice(at, 1);
    return true;
  }

  /**
   * Nearest known portal to a position within a radius.
   * @param {string} id dimension id
   * @param {number} x world x
   * @param {number} y world y
   * @param {number} z world z
   * @param {number} [radius=PORTAL_SEARCH_RADIUS] search radius in blocks
   * @returns {?PortalRecord} the nearest portal, or `null`
   */
  findNearestPortal(id, x, y, z, radius = PORTAL_SEARCH_RADIUS) {
    const list = this.portals.get(id);
    if (list === undefined || list.length === 0) return null;
    const r2 = radius * radius;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const dx = p.x - x;
      const dz = p.z - z;
      const flat = dx * dx + dz * dz;
      if (flat > r2) continue;
      const dy = (p.y - y) * 0.5;
      const d = flat + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /**
   * Light a portal in the active world, the way flint and steel does, and
   * register it so travel can find it again.
   * @param {number} x block x the flame would occupy
   * @param {number} y block y the flame would occupy
   * @param {number} z block z the flame would occupy
   * @param {{axis?:('x'|'z')}} [opts] force a plane orientation
   * @returns {?PortalRecord} the lit portal, or `null` when there is no frame
   */
  ignitePortalAt(x, y, z, opts = {}) {
    const world = this.getWorld();
    if (!world) return null;
    let portal = null;
    try {
      portal = ignitePortal(world, x, y, z, opts);
    } catch (err) {
      this._report('ignitePortal', err);
      return null;
    }
    if (portal === null) return null;
    portal.dimension = this.active;
    this.registerPortal(portal);
    this.emit('portalCreated', portal);
    return portal;
  }

  /* ====================================================================== */
  /* Persistence                                                            */
  /* ====================================================================== */

  /**
   * Snapshot which dimensions exist, where the player last stood in each, and
   * every known portal. Store this next to the player snapshot in the save.
   * @returns {Object} a JSON-safe snapshot
   */
  serialize() {
    /** @type {Object[]} */
    const dims = [];
    for (const rec of this.records.values()) {
      dims.push({
        id: rec.id,
        seed: rec.seed | 0,
        visited: rec.visited === true,
        lastPos: [rec.lastPos[0], rec.lastPos[1], rec.lastPos[2]],
        lastYaw: rec.lastYaw,
      });
    }
    /** @type {Object[]} */
    const portals = [];
    for (const list of this.portals.values()) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        portals.push({
          dimension: p.dimension,
          axis: p.axis,
          x: p.x, y: p.y, z: p.z,
          minX: p.minX, minY: p.minY, minZ: p.minZ,
          maxX: p.maxX, maxY: p.maxY, maxZ: p.maxZ,
          width: p.width, height: p.height,
          link: p.link === null ? null : {
            dimension: p.link.dimension, x: p.link.x, y: p.link.y, z: p.link.z,
          },
        });
      }
    }
    const playerState = this._portalState.get('player');
    return {
      version: DIMENSION_SAVE_VERSION,
      active: this.active,
      seed: this.seed,
      dimensions: dims,
      portals,
      playerCooldown: playerState === undefined ? 0 : playerState.cooldown | 0,
    };
  }

  /**
   * Restore a snapshot produced by {@link DimensionManager#serialize}.
   *
   * Only data is restored — no world is created and the active dimension is
   * **not** switched. Read {@link DimensionManager#active} afterwards and call
   * {@link DimensionManager#switchTo} if it differs from the world the game
   * already built.
   *
   * @param {*} o the snapshot
   * @returns {boolean} `true` when something was restored
   */
  deserialize(o) {
    if (!o || typeof o !== 'object') return false;
    try {
      if (Number.isFinite(o.seed)) this.seed = o.seed | 0;

      if (Array.isArray(o.dimensions)) {
        for (let i = 0; i < o.dimensions.length; i++) {
          const d = o.dimensions[i];
          if (!d || !isDimension(d.id)) continue;
          const rec = this._touchRecord(d.id);
          rec.seed = Number.isFinite(d.seed) ? d.seed | 0 : this.seed;
          rec.visited = d.visited === true;
          rec.lastYaw = num(d.lastYaw, 0);
          if (Array.isArray(d.lastPos) && d.lastPos.length >= 3) {
            rec.lastPos[0] = num(d.lastPos[0], 0);
            rec.lastPos[1] = num(d.lastPos[1], getDimension(d.id).defaultSpawnY);
            rec.lastPos[2] = num(d.lastPos[2], 0);
          }
        }
      }

      if (Array.isArray(o.portals)) {
        for (const list of this.portals.values()) list.length = 0;
        for (let i = 0; i < o.portals.length; i++) {
          const p = o.portals[i];
          if (!p || !isDimension(p.dimension)) continue;
          if (p.axis !== 'x' && p.axis !== 'z') continue;
          this.registerPortal({
            dimension: p.dimension,
            axis: p.axis,
            x: num(p.x, 0) | 0, y: num(p.y, 0) | 0, z: num(p.z, 0) | 0,
            minX: num(p.minX, 0) | 0, minY: num(p.minY, 0) | 0, minZ: num(p.minZ, 0) | 0,
            maxX: num(p.maxX, 0) | 0, maxY: num(p.maxY, 0) | 0, maxZ: num(p.maxZ, 0) | 0,
            width: clamp(num(p.width, 2) | 0, PORTAL_MIN_WIDTH, PORTAL_MAX_WIDTH),
            height: clamp(num(p.height, 3) | 0, PORTAL_MIN_HEIGHT, PORTAL_MAX_HEIGHT),
            link: p.link && isDimension(p.link.dimension) ? {
              dimension: p.link.dimension,
              x: num(p.link.x, 0) | 0,
              y: num(p.link.y, 0) | 0,
              z: num(p.link.z, 0) | 0,
            } : null,
          });
        }
      }

      if (isDimension(o.active)) this.active = o.active;
      if (Number.isFinite(o.playerCooldown)) {
        this._stateFor('player').cooldown = Math.max(0, o.playerCooldown | 0);
      }
      this._touchRecord(this.active);
      return true;
    } catch (err) {
      this._report('deserialize', err);
      return false;
    }
  }

  /* ====================================================================== */
  /* Teardown                                                               */
  /* ====================================================================== */

  /**
   * Report a failure without ever throwing out of a tick.
   * @param {string} where failing stage
   * @param {*} err the error
   * @returns {void}
   * @private
   */
  _report(where, err) {
    warnOnce(`err:${where}`, `${where} failed`, err);
    try {
      /**
       * A stage failed and was degraded.
       * @event DimensionManager#error
       */
      this.emit('error', where, err);
    } catch { /* a listener threw; nothing more to do */ }
  }

  /**
   * Dispose every world this manager owns except the one the caller still
   * holds, and drop all listeners.
   * @param {{keepActive?:boolean}} [opts] `keepActive` leaves the active world
   *   alive for the caller to dispose (the default, since `game.js` owns it)
   * @returns {void}
   */
  dispose(opts = {}) {
    if (this.disposed) return;
    this.disposed = true;
    const keepActive = opts.keepActive !== false;
    for (const [id, world] of this.worlds) {
      if (keepActive && id === this.active) continue;
      try { world.dispose(); } catch { /* already gone */ }
    }
    this.worlds.clear();
    this._idleSince.clear();
    this._portalState.clear();
    this._entityScratch.length = 0;
    this._entityStore.clear();
    if (this._frozeClock && this.environment) {
      try {
        if (typeof this.environment.setFrozen === 'function') {
          this.environment.setFrozen(this._prevFrozen);
        } else {
          this.environment.frozen = this._prevFrozen;
        }
      } catch { /* environment already disposed */ }
      this._frozeClock = false;
    }
    this._listeners.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Free helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Candidate `(dx, dz)` offsets the destination search tries, nearest first.
 * Flat pairs so the scan never allocates.
 * @type {Int8Array}
 */
const PLATFORM_OFFSETS = new Int8Array([
  0, 0,
  -4, 0, 4, 0, 0, -4, 0, 4,
  -4, -4, 4, -4, -4, 4, 4, 4,
  -8, 0, 8, 0, 0, -8, 0, 8,
  -8, -8, 8, -8, -8, 8, 8, 8,
  -12, 0, 12, 0, 0, -12, 0, 12,
  -16, 0, 16, 0, 0, -16, 0, 16,
]);

/**
 * Fog tint per Nether region id, matching `world/netherworldgen.js`.
 * @type {ReadonlyArray<[number,number,number]>}
 */
const NETHER_REGION_FOG = Object.freeze([
  Object.freeze([0.200, 0.035, 0.030]),
  Object.freeze([0.075, 0.115, 0.150]),
  Object.freeze([0.180, 0.020, 0.022]),
  Object.freeze([0.030, 0.100, 0.098]),
  Object.freeze([0.090, 0.075, 0.072]),
]);

/**
 * Whether a column of `height` blocks above `(x, y, z)` is free of solids.
 * @param {Object} world the world to read
 * @param {number} x world x
 * @param {number} y lowest y to test
 * @param {number} z world z
 * @param {number} height blocks to test
 * @returns {boolean} `true` when the column is clear
 */
function isClearColumn(world, x, y, z, height) {
  for (let i = 0; i < height; i++) {
    const id = world.getBlock(x, y + i, z);
    if (id === 0) continue;
    if (isLiquid(id)) return false;
    if (isSolid(id)) return false;
  }
  return true;
}

/**
 * Whether lava sits within one block of a candidate portal spot.
 * @param {Object} world the world to read
 * @param {number} x world x
 * @param {number} y world y
 * @param {number} z world z
 * @returns {boolean} `true` when lava is adjacent
 */
function nearLava(world, x, y, z) {
  for (let dy = -1; dy <= 2; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const id = world.getBlock(x + dx, y + dy, z + dz);
        if (id === B.LAVA || id === B.STILL_LAVA) return true;
      }
    }
  }
  return false;
}

/**
 * Yield to the host between streaming pumps. Uses `requestAnimationFrame` when
 * there is one and a short timeout otherwise, so a hidden tab still makes
 * progress instead of deadlocking the travel promise.
 * @returns {Promise<void>} resolves on the next frame or after ~16 ms
 */
function frameYield() {
  return new Promise((resolve) => {
    let settled = false;
    /**
     * Resolve exactly once.
     * @returns {void}
     */
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(done);
    setTimeout(done, 24);
  });
}

/**
 * Human-readable summary of a dimension, for the F3 overlay and the HUD.
 * @param {string} id dimension id
 * @returns {string} German one-liner
 */
export function describeDimension(id) {
  const d = getDimension(id);
  const scale = d.coordinateScale === 1 ? '1:1' : `1:${d.coordinateScale}`;
  return `${d.display} — Maßstab ${scale}, Höhe ${d.minY}…${d.maxY - 1}`;
}

/**
 * Whether a block id is one this module treats as a portal surface.
 * @param {number} id block id
 * @returns {boolean} `true` for the nether portal block
 */
export function isPortalBlock(id) {
  return id === B.NETHER_PORTAL;
}

/**
 * The display name of the block a portal frame is built from, for tooltips.
 * @param {string} [id] dimension id
 * @returns {string} block display name
 */
export function portalFrameName(id = 'overworld') {
  const def = getDimension(id);
  const block = getBlock(def.portalFrameBlock);
  return block && block.display ? block.display : 'Obsidian';
}

export default DimensionManager;
