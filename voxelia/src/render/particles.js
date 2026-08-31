/**
 * VOXELIA — GPU-instanced particles and weather (ARCHITECTURE.md 5.24).
 *
 * The whole system is a *data-oriented* CPU simulation feeding **one instanced
 * draw call per blend mode**:
 *
 * * every particle attribute lives in a flat `Float32Array` / `Uint8Array`
 *   (structure of arrays, no per-particle objects, no per-frame allocation),
 * * slots are handed out from a free list so an index stays stable for the
 *   whole life of a particle — which is what lets the weather system *recycle*
 *   its cylinder of rain/snow instead of churning through spawn/despawn,
 * * `update()` integrates gravity, drag and wind, ages particles and runs a
 *   cheap 3-axis voxel collision (`world.getBlock`) for "heavy" types so break
 *   chips bounce off the floor and settle,
 * * `render()` packs the live range into a dynamic VBO with `bufferSubData`
 *   and issues two `drawElementsInstanced` calls: one alpha-blended, one
 *   additive.
 *
 * ### Lighting
 * A particle samples the baked voxel light (`world.getLightPacked`) at spawn
 * and then only ~4 times a second (1/16 of the population per frame, staggered
 * by slot index). Block light and sky light are stored separately so a
 * sunset dims every particle in the world without a single resample. Emissive
 * types (flame, spark, ember, portal, explosion core, lava) skip the lookup and
 * carry HDR values well above 1.0 so `render/post.js` bloom picks them up.
 *
 * ### Appearance
 * There is no sprite atlas — every sprite is an analytic shape evaluated in the
 * fragment shader (soft blob, noisy smoke puff, sharp spark, flame tongue,
 * droplet, bubble ring, heart, eighth note, portal swirl, snow crystal, leaf,
 * crit star, shock ring). Break chips are the exception: they sample the real
 * block albedo out of `u_albedoArray` (unit 0) with a per-particle sub-tile UV.
 *
 * ### Texture units (ARCHITECTURE.md 3.5 — never rebound elsewhere)
 * * `0` `u_albedoArray` `sampler2DArray` — block albedo, for break chips.
 * * `7` `u_gDepth` `sampler2D` — scene depth, for the soft-particle fade.
 *
 * ### GLSL includes
 * `frame` (Frame UBO, binding 0), `math`, `depth`.
 *
 * Nothing in this module throws during a frame: shader builds and the draw path
 * are wrapped, a failure is logged once and the system degrades to a no-op.
 *
 * @module render/particles
 */

import { clamp, mulberry32 } from '../core/math.js';
import { isSolid, faceMaterial, blockTint } from '../world/blocks.js';
import { MATERIALS } from '../world/materials.js';
import {
  biomeGrassColor, biomeFoliageColor, biomeWaterColor, biomePrecipitationAt,
} from '../world/biomes.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Hard ceiling on simultaneously live particles. @type {number} */
export const MAX_PARTICLES = 100000;

/** Frame UBO binding point (ARCHITECTURE.md 3.3). @type {number} */
const FRAME_BINDING = 0;

/** Texture unit of the block albedo array (ARCHITECTURE.md 3.5). @type {number} */
const UNIT_ALBEDO_ARRAY = 0;

/** Texture unit of the sampled scene depth (ARCHITECTURE.md 3.5). @type {number} */
const UNIT_DEPTH = 7;

/** Floats per instance in the dynamic vertex buffer. @type {number} */
const INSTANCE_FLOATS = 19;

/** Bytes per instance. @type {number} */
const INSTANCE_STRIDE = INSTANCE_FLOATS * 4;

/** Smallest instance buffer we ever allocate. @type {number} */
const MIN_INSTANCES = 512;

/** Above this many alpha instances the back-to-front sort is skipped. @type {number} */
const SORT_LIMIT = 6144;

/** Fraction of a break-chip's tile covered by one chip's UV window. @type {number} */
const CHIP_UV_SCALE = 0.25;

/** Never let a particle go fully black; keeps caves readable. @type {number} */
const AMBIENT_FLOOR = 0.035;

/** Radius of the persistent weather cylinder, in blocks. @type {number} */
const WEATHER_RADIUS = 26;

/** How far above the camera weather particles are (re)placed. @type {number} */
const WEATHER_TOP = 15;

/** How far below the camera a weather particle survives before recycling. @type {number} */
const WEATHER_BOTTOM = 14;

/** Seconds between sky-coverage re-samples above the camera. @type {number} */
const COVERAGE_INTERVAL = 0.25;

/**
 * Numeric particle type ids. The string names accepted by
 * {@link ParticleSystem#spawn} map onto these.
 * @type {Readonly<Object<string, number>>}
 */
export const PARTICLE_TYPES = Object.freeze({
  BREAK: 0,
  DUST: 1,
  SPLASH: 2,
  BUBBLE: 3,
  SMOKE: 4,
  FLAME: 5,
  SPARK: 6,
  CRIT: 7,
  HEART: 8,
  NOTE: 9,
  PORTAL: 10,
  DRIP: 11,
  LEAF: 12,
  EMBER: 13,
  EXPLOSION: 14,
  RAIN: 15,
  SNOW: 16,
  RAIN_SPLASH: 17,
  CLOUD: 18,
  LAVA: 19,
});

/** Number of distinct particle types. @type {number} */
const TYPE_COUNT = 20;

/**
 * Fragment-shader sprite kinds. Must stay in sync with the `kind ==` ladder in
 * {@link PARTICLE_FS}.
 * @type {Readonly<Object<string, number>>}
 */
const SPRITE = Object.freeze({
  BLOB: 0,
  SMOKE: 1,
  CHIP: 2,
  SPARK: 3,
  FLAME: 4,
  DROP: 5,
  BUBBLE: 6,
  HEART: 7,
  NOTE: 8,
  PORTAL: 9,
  SNOW: 10,
  LEAF: 11,
  STAR: 12,
  RING: 13,
});

/**
 * Per-particle behaviour flags.
 * @type {Readonly<Object<string, number>>}
 */
const F = Object.freeze({
  /** Runs the cheap voxel collision and can settle on the ground. */
  COLLIDE: 1,
  /** Goes into the additive bucket instead of the alpha bucket. */
  ADDITIVE: 2,
  /** Velocity-stretched billboard (vertex mode 1). */
  STRETCH: 4,
  /** Axis-locked billboard, world +Y up (vertex mode 2). */
  AXIS: 8,
  /** Ignores the voxel light and keeps its HDR colour. */
  EMISSIVE: 16,
  /** Persistent weather particle: recycled, never freed by ageing. */
  WEATHER: 32,
  /** Has come to rest on a surface. */
  SETTLED: 64,
  /** Pushed around by the wind. */
  WIND: 128,
});

/**
 * @typedef {Object} ParticleTypeDef
 * @property {number} id numeric type id
 * @property {number} sprite fragment-shader sprite kind
 * @property {number} count default burst size
 * @property {number} life mean lifetime in seconds
 * @property {number} lifeVar lifetime jitter, as a fraction of `life`
 * @property {number} size base billboard width in blocks
 * @property {number} sizeVar size jitter, as a fraction of `size`
 * @property {number} aspect height / width of the billboard
 * @property {number} grow relative size change per second (negative shrinks)
 * @property {number} spread spawn position jitter radius in blocks
 * @property {number} speed random velocity magnitude in blocks/s
 * @property {number} rise extra +Y velocity in blocks/s
 * @property {number} gravity downward acceleration in blocks/s^2 (negative floats up)
 * @property {number} drag linear velocity damping per second
 * @property {number} bounce restitution used by the voxel collision
 * @property {number} spin maximum rotation speed in rad/s
 * @property {number} wind wind influence multiplier
 * @property {number[]} color linear rgb
 * @property {?number[]} color2 optional second colour, randomly mixed in
 * @property {number} alpha base opacity
 * @property {number} emissive HDR multiplier; 0 means "lit by the voxel light"
 * @property {number} fadeIn fraction of the lifetime spent fading in
 * @property {number} fadeOut fraction of the lifetime spent fading out
 * @property {number} flags bitmask of {@link F}
 */

/**
 * Fill in the defaults of a partial type definition.
 * @param {Object} d partial definition
 * @returns {ParticleTypeDef} complete definition
 */
function def(d) {
  return {
    id: d.id | 0,
    sprite: d.sprite === undefined ? SPRITE.BLOB : d.sprite,
    count: d.count === undefined ? 6 : d.count,
    life: d.life === undefined ? 1 : d.life,
    lifeVar: d.lifeVar === undefined ? 0.35 : d.lifeVar,
    size: d.size === undefined ? 0.12 : d.size,
    sizeVar: d.sizeVar === undefined ? 0.3 : d.sizeVar,
    aspect: d.aspect === undefined ? 1 : d.aspect,
    grow: d.grow === undefined ? 0 : d.grow,
    spread: d.spread === undefined ? 0.25 : d.spread,
    speed: d.speed === undefined ? 1 : d.speed,
    rise: d.rise === undefined ? 0 : d.rise,
    gravity: d.gravity === undefined ? 0 : d.gravity,
    drag: d.drag === undefined ? 1 : d.drag,
    bounce: d.bounce === undefined ? 0.25 : d.bounce,
    spin: d.spin === undefined ? 0 : d.spin,
    wind: d.wind === undefined ? 0 : d.wind,
    color: d.color === undefined ? [1, 1, 1] : d.color,
    color2: d.color2 === undefined ? null : d.color2,
    alpha: d.alpha === undefined ? 1 : d.alpha,
    emissive: d.emissive === undefined ? 0 : d.emissive,
    fadeIn: d.fadeIn === undefined ? 0.08 : d.fadeIn,
    fadeOut: d.fadeOut === undefined ? 0.3 : d.fadeOut,
    flags: d.flags === undefined ? 0 : d.flags,
  };
}

const P = PARTICLE_TYPES;

/**
 * Every particle archetype, indexed by the numeric type id.
 * @type {ReadonlyArray<ParticleTypeDef>}
 */
const TYPE_DEFS = Object.freeze([
  def({ // 0 break — a chip of the block that was destroyed
    id: P.BREAK, sprite: SPRITE.CHIP, count: 28, life: 1.15, lifeVar: 0.45,
    size: 0.11, sizeVar: 0.45, grow: 0, spread: 0.82, speed: 2.3, rise: 1.7,
    gravity: 21, drag: 0.85, bounce: 0.3, spin: 7, wind: 0.05,
    color: [1, 1, 1], alpha: 1, fadeIn: 0.02, fadeOut: 0.22, flags: F.COLLIDE,
  }),
  def({ // 1 dust — footsteps, landing puffs
    id: P.DUST, sprite: SPRITE.BLOB, count: 6, life: 0.95, lifeVar: 0.4,
    size: 0.16, sizeVar: 0.4, grow: 0.45, spread: 0.4, speed: 0.75, rise: 0.45,
    gravity: 3.2, drag: 1.9, bounce: 0.1, spin: 1.2, wind: 0.6,
    color: [0.60, 0.56, 0.50], color2: [0.72, 0.68, 0.62],
    alpha: 0.5, fadeIn: 0.12, fadeOut: 0.55, flags: F.WIND,
  }),
  def({ // 2 splash — water droplets
    id: P.SPLASH, sprite: SPRITE.DROP, count: 9, life: 0.55, lifeVar: 0.4,
    size: 0.055, sizeVar: 0.4, aspect: 1.7, spread: 0.32, speed: 2.7, rise: 2.6,
    gravity: 22, drag: 0.35, bounce: 0.15, wind: 0.15,
    color: [0.58, 0.72, 0.95], alpha: 0.72, fadeIn: 0.04, fadeOut: 0.28,
    flags: F.STRETCH,
  }),
  def({ // 3 bubble — underwater, floats up
    id: P.BUBBLE, sprite: SPRITE.BUBBLE, count: 6, life: 1.7, lifeVar: 0.4,
    size: 0.07, sizeVar: 0.45, grow: 0.12, spread: 0.28, speed: 0.3, rise: 0.9,
    gravity: -2.4, drag: 1.4,
    color: [0.80, 0.90, 1.0], alpha: 0.55, fadeIn: 0.06, fadeOut: 0.25,
  }),
  def({ // 4 smoke — soft, wind driven, grows
    id: P.SMOKE, sprite: SPRITE.SMOKE, count: 8, life: 2.4, lifeVar: 0.4,
    size: 0.34, sizeVar: 0.35, grow: 0.5, spread: 0.28, speed: 0.35, rise: 1.05,
    gravity: -0.4, drag: 0.95, spin: 0.9, wind: 1.0,
    color: [0.13, 0.128, 0.125], color2: [0.34, 0.335, 0.33],
    alpha: 0.55, fadeIn: 0.14, fadeOut: 0.5, flags: F.WIND,
  }),
  def({ // 5 flame — emissive tongue
    id: P.FLAME, sprite: SPRITE.FLAME, count: 5, life: 0.85, lifeVar: 0.35,
    size: 0.22, sizeVar: 0.3, aspect: 1.35, grow: -0.45, spread: 0.14,
    speed: 0.35, rise: 0.95, gravity: -1.3, drag: 1.7, wind: 0.35,
    color: [1.0, 0.50, 0.14], color2: [1.0, 0.86, 0.42],
    alpha: 1, emissive: 6.5, fadeIn: 0.06, fadeOut: 0.4,
    flags: F.ADDITIVE | F.EMISSIVE | F.WIND,
  }),
  def({ // 6 spark — tiny, very bright, velocity stretched
    id: P.SPARK, sprite: SPRITE.SPARK, count: 12, life: 0.7, lifeVar: 0.45,
    size: 0.05, sizeVar: 0.45, aspect: 1.6, grow: -0.5, spread: 0.12,
    speed: 3.8, rise: 1.8, gravity: 12, drag: 1.1, wind: 0.2,
    color: [1.0, 0.68, 0.26], color2: [1.0, 0.95, 0.78],
    alpha: 1, emissive: 14, fadeIn: 0.02, fadeOut: 0.45,
    flags: F.ADDITIVE | F.EMISSIVE | F.STRETCH,
  }),
  def({ // 7 crit — combat star burst
    id: P.CRIT, sprite: SPRITE.STAR, count: 8, life: 0.6, lifeVar: 0.3,
    size: 0.11, sizeVar: 0.35, grow: -0.35, spread: 0.5, speed: 1.5, rise: 0.7,
    gravity: 6, drag: 1.5,
    color: [1.0, 0.93, 0.58], alpha: 1, emissive: 3.5, fadeIn: 0.05, fadeOut: 0.4,
    flags: F.ADDITIVE | F.EMISSIVE,
  }),
  def({ // 8 heart — taming / breeding
    id: P.HEART, sprite: SPRITE.HEART, count: 3, life: 1.3, lifeVar: 0.25,
    size: 0.26, sizeVar: 0.15, grow: 0.08, spread: 0.3, speed: 0.25, rise: 0.85,
    gravity: -0.35, drag: 1.6,
    color: [1.0, 0.20, 0.30], alpha: 1, fadeIn: 0.1, fadeOut: 0.3,
  }),
  def({ // 9 note — jukebox / note block
    id: P.NOTE, sprite: SPRITE.NOTE, count: 1, life: 1.5, lifeVar: 0.2,
    size: 0.28, sizeVar: 0.12, spread: 0.12, speed: 0.5, rise: 1.15,
    gravity: -0.5, drag: 1.5,
    color: [0.95, 0.28, 0.85], color2: [0.30, 0.90, 0.55],
    alpha: 1, fadeIn: 0.08, fadeOut: 0.3,
  }),
  def({ // 10 portal — swirling vortex motes
    id: P.PORTAL, sprite: SPRITE.PORTAL, count: 6, life: 1.7, lifeVar: 0.4,
    size: 0.20, sizeVar: 0.4, grow: -0.18, spread: 0.9, speed: 0.55, rise: 0.15,
    gravity: 0, drag: 1.0, spin: 2.2,
    color: [0.50, 0.16, 0.86], color2: [0.85, 0.48, 1.0],
    alpha: 1, emissive: 3.2, fadeIn: 0.15, fadeOut: 0.35,
    flags: F.ADDITIVE | F.EMISSIVE,
  }),
  def({ // 11 drip — a single falling droplet from a ceiling
    id: P.DRIP, sprite: SPRITE.DROP, count: 1, life: 2.6, lifeVar: 0.2,
    size: 0.055, sizeVar: 0.2, aspect: 1.8, spread: 0.08, speed: 0.05,
    gravity: 18, drag: 0.05, bounce: 0,
    color: [0.42, 0.60, 0.92], alpha: 0.85, fadeIn: 0.04, fadeOut: 0.12,
    flags: F.STRETCH,
  }),
  def({ // 12 leaf — drifting foliage
    id: P.LEAF, sprite: SPRITE.LEAF, count: 3, life: 4.5, lifeVar: 0.35,
    size: 0.16, sizeVar: 0.35, spread: 0.6, speed: 0.35, rise: 0,
    gravity: 1.1, drag: 2.4, spin: 2.4, wind: 1.3,
    color: [0.26, 0.50, 0.17], color2: [0.44, 0.64, 0.24],
    alpha: 0.92, fadeIn: 0.06, fadeOut: 0.2, flags: F.WIND,
  }),
  def({ // 13 ember — slow, glowing, rises on the wind
    id: P.EMBER, sprite: SPRITE.SPARK, count: 6, life: 2.6, lifeVar: 0.45,
    size: 0.05, sizeVar: 0.4, grow: -0.25, spread: 0.4, speed: 0.6, rise: 1.35,
    gravity: -0.9, drag: 1.0, wind: 1.1,
    color: [1.0, 0.42, 0.10], color2: [1.0, 0.76, 0.30],
    alpha: 1, emissive: 7, fadeIn: 0.1, fadeOut: 0.45,
    flags: F.ADDITIVE | F.EMISSIVE | F.WIND,
  }),
  def({ // 14 explosion — the bright expanding core
    id: P.EXPLOSION, sprite: SPRITE.BLOB, count: 5, life: 0.7, lifeVar: 0.3,
    size: 1.3, sizeVar: 0.35, grow: 1.5, spread: 0.55, speed: 1.3, rise: 0.4,
    gravity: -0.4, drag: 2.4,
    color: [1.0, 0.70, 0.32], color2: [1.0, 0.96, 0.72],
    alpha: 1, emissive: 5, fadeIn: 0.04, fadeOut: 0.55,
    flags: F.ADDITIVE | F.EMISSIVE,
  }),
  def({ // 15 rain — persistent, stretched streak
    id: P.RAIN, sprite: SPRITE.DROP, count: 0, life: 1e9, lifeVar: 0,
    size: 0.048, sizeVar: 0.3, aspect: 6.5, spread: 0, speed: 0, gravity: 0,
    drag: 0, wind: 0,
    color: [0.60, 0.70, 0.88], alpha: 0.30, fadeIn: 0, fadeOut: 0,
    flags: F.STRETCH | F.WEATHER,
  }),
  def({ // 16 snow — persistent, axis locked, slow drift
    id: P.SNOW, sprite: SPRITE.SNOW, count: 0, life: 1e9, lifeVar: 0,
    size: 0.105, sizeVar: 0.45, spread: 0, speed: 0, gravity: 0, drag: 0,
    spin: 0.6, wind: 0,
    color: [0.92, 0.955, 1.0], alpha: 0.85, fadeIn: 0, fadeOut: 0,
    flags: F.AXIS | F.WEATHER,
  }),
  def({ // 17 rain_splash — the little crown where a drop lands
    id: P.RAIN_SPLASH, sprite: SPRITE.RING, count: 1, life: 0.33, lifeVar: 0.25,
    size: 0.15, sizeVar: 0.3, grow: 2.0, spread: 0.05, speed: 0.05,
    gravity: 0, drag: 2,
    color: [0.66, 0.76, 0.94], alpha: 0.45, fadeIn: 0.06, fadeOut: 0.6,
    flags: F.AXIS,
  }),
  def({ // 18 cloud — big pale puff (campfire, snowball impact)
    id: P.CLOUD, sprite: SPRITE.SMOKE, count: 6, life: 1.6, lifeVar: 0.4,
    size: 0.42, sizeVar: 0.35, grow: 0.7, spread: 0.35, speed: 0.5, rise: 0.35,
    gravity: -0.2, drag: 1.6, spin: 0.6, wind: 0.9,
    color: [0.82, 0.84, 0.86], alpha: 0.4, fadeIn: 0.15, fadeOut: 0.55,
    flags: F.WIND,
  }),
  def({ // 19 lava — heavy glowing blob
    id: P.LAVA, sprite: SPRITE.BLOB, count: 4, life: 1.4, lifeVar: 0.4,
    size: 0.13, sizeVar: 0.4, grow: -0.15, spread: 0.35, speed: 1.8, rise: 2.6,
    gravity: 17, drag: 0.5, bounce: 0.1,
    color: [1.0, 0.38, 0.06], color2: [1.0, 0.66, 0.18],
    alpha: 1, emissive: 4.5, fadeIn: 0.05, fadeOut: 0.35,
    flags: F.ADDITIVE | F.EMISSIVE | F.COLLIDE,
  }),
]);

/**
 * String name -> numeric type id, including a few friendly aliases.
 * @type {ReadonlyMap<string, number>}
 */
const TYPE_BY_NAME = new Map([
  ['break', P.BREAK], ['block', P.BREAK], ['chip', P.BREAK],
  ['dust', P.DUST], ['poof', P.DUST],
  ['splash', P.SPLASH],
  ['bubble', P.BUBBLE],
  ['smoke', P.SMOKE],
  ['flame', P.FLAME], ['fire', P.FLAME],
  ['spark', P.SPARK],
  ['crit', P.CRIT], ['critical', P.CRIT],
  ['heart', P.HEART],
  ['note', P.NOTE],
  ['portal', P.PORTAL], ['enchant', P.PORTAL],
  ['drip', P.DRIP],
  ['leaf', P.LEAF],
  ['ember', P.EMBER],
  ['explosion', P.EXPLOSION], ['explode', P.EXPLOSION],
  ['rain', P.RAIN],
  ['snow', P.SNOW],
  ['rain_splash', P.RAIN_SPLASH], ['rainsplash', P.RAIN_SPLASH],
  ['cloud', P.CLOUD],
  ['lava', P.LAVA],
]);

/* ---- flattened per-type lookup tables (hot path, no property access) ----- */

const T_GRAVITY = new Float32Array(TYPE_COUNT);
const T_DRAG = new Float32Array(TYPE_COUNT);
const T_BOUNCE = new Float32Array(TYPE_COUNT);
const T_GROW = new Float32Array(TYPE_COUNT);
const T_SPIN = new Float32Array(TYPE_COUNT);
const T_WIND = new Float32Array(TYPE_COUNT);
const T_FADE_IN = new Float32Array(TYPE_COUNT);
const T_FADE_OUT = new Float32Array(TYPE_COUNT);
for (let i = 0; i < TYPE_COUNT; i++) {
  const d = TYPE_DEFS[i];
  T_GRAVITY[i] = d.gravity;
  T_DRAG[i] = d.drag;
  T_BOUNCE[i] = d.bounce;
  T_GROW[i] = d.grow;
  T_SPIN[i] = d.spin;
  T_WIND[i] = d.wind;
  T_FADE_IN[i] = d.fadeIn;
  T_FADE_OUT[i] = d.fadeOut;
}

/**
 * Quality steps driven by `settings.particles`.
 * @type {Readonly<Object<string, {capacity:number, spawn:number, weather:number,
 *   soft:boolean, sort:boolean, splash:number}>>}
 */
const QUALITY = Object.freeze({
  off: { capacity: 0, spawn: 0, weather: 0, soft: false, sort: false, splash: 0 },
  low: { capacity: 6000, spawn: 0.35, weather: 0.25, soft: false, sort: false, splash: 0 },
  medium: { capacity: 20000, spawn: 0.6, weather: 0.5, soft: true, sort: false, splash: 0.1 },
  high: { capacity: 55000, spawn: 1.0, weather: 1.0, soft: true, sort: true, splash: 0.22 },
  ultra: { capacity: MAX_PARTICLES, spawn: 1.35, weather: 1.6, soft: true, sort: true, splash: 0.34 },
});

/* ========================================================================== */
/* Shaders                                                                    */
/* ========================================================================== */

/**
 * Particle vertex shader.
 *
 * Location 0 comes from the shared static quad (corners in `[-0.5, 0.5]`),
 * locations 1..5 are per-instance (`divisor = 1`) out of the dynamic VBO.
 * Centres are camera-relative (`a_center = worldPos - u_origin`) so float32
 * precision never breaks down far from the origin.
 *
 * @type {string}
 */
const PARTICLE_VS = `
#include <frame>
#include <math>

layout(location = 0) in vec2 a_corner;   // static quad corner, -0.5 .. 0.5
layout(location = 1) in vec3 a_center;   // world position minus u_origin
layout(location = 2) in vec4 a_params;   // sizeX, sizeY, rotation, seed
layout(location = 3) in vec4 a_color;    // linear rgb (may be HDR), alpha
layout(location = 4) in vec4 a_sprite;   // sprite kind, array layer, sub-uv x, sub-uv y
layout(location = 5) in vec4 a_motion;   // velocity xyz, billboard mode

uniform vec3 u_origin;
uniform float u_stretch;

out vec2 v_uv;
out float v_depth;
flat out vec4 v_color;
flat out vec2 v_sub;
flat out float v_layer;
flat out float v_kind;
flat out float v_seed;

void main() {
  vec3 world = a_center + u_origin;
  vec3 toCam = u_camPos.xyz - world;
  float camDist = length(toCam);
  vec3 fwd = camDist > 1.0e-4 ? toCam / camDist : vec3(0.0, 0.0, 1.0);

  int mode = int(a_motion.w + 0.5);
  vec2 corner = a_corner;
  float sx = max(a_params.x, 1.0e-4);
  float sy = max(a_params.y, 1.0e-4);
  vec3 right;
  vec3 up;

  if (mode == 1) {
    // Velocity-stretched: the quad's up axis follows the motion vector and the
    // quad lengthens with speed (rain streaks, sparks, drips).
    vec3 vel = a_motion.xyz;
    float speed = length(vel);
    vec3 axis = speed > 1.0e-4 ? vel / speed : vec3(0.0, 1.0, 0.0);
    vec3 side = cross(axis, fwd);
    float sideLen = length(side);
    right = sideLen > 1.0e-4 ? side / sideLen : safeNormalize(u_invView[0].xyz);
    up = axis;
    sy *= 1.0 + min(speed * u_stretch, 32.0);
  } else if (mode == 2) {
    // Axis locked to world up: falling snow, ground decals.
    up = vec3(0.0, 1.0, 0.0);
    vec3 side = cross(up, fwd);
    float sideLen = length(side);
    right = sideLen > 1.0e-4 ? side / sideLen : vec3(1.0, 0.0, 0.0);
  } else {
    // Plain camera-facing billboard with per-particle roll.
    right = safeNormalize(u_invView[0].xyz);
    up = safeNormalize(u_invView[1].xyz);
    corner = rotate2(corner, a_params.z);
  }

  vec3 wp = world + right * (corner.x * sx) + up * (corner.y * sy);
  vec4 viewPos = u_view * vec4(wp, 1.0);
  v_depth = max(-viewPos.z, 0.0);
  gl_Position = u_proj * viewPos;

  v_uv = a_corner + 0.5;
  v_color = a_color;
  v_sub = a_sprite.zw;
  v_layer = a_sprite.y;
  v_kind = a_sprite.x;
  v_seed = a_params.w;
}
`;

/**
 * Particle fragment shader.
 *
 * Every sprite except the block chip is an analytic shape — no atlas, no
 * external asset. The chip samples the real block albedo array (unit 0) with a
 * per-particle sub-tile window. Soft-particle fading reads the scene depth
 * (unit 7) and dissolves the sprite as it approaches geometry.
 *
 * @type {string}
 */
const PARTICLE_FS = `
#include <frame>
#include <math>
#include <depth>

uniform sampler2DArray u_albedoArray;
uniform sampler2D u_gDepth;

uniform float u_softDistance;   // world units over which a sprite fades into geometry
uniform float u_premultiply;    // 1 for the additive pass, 0 for the alpha pass
uniform float u_chipScale;      // UV window of one break chip inside its tile
uniform float u_fadeNear;       // distance over which sprites fade in near the camera
uniform int u_soft;             // 1 = soft-particle depth fade enabled
uniform int u_hasAlbedo;        // 1 = the block albedo array is bound

in vec2 v_uv;
in float v_depth;
flat in vec4 v_color;
flat in vec2 v_sub;
flat in float v_layer;
flat in float v_kind;
flat in float v_seed;

layout(location = 0) out vec4 o_color;

/** Soft round blob: opaque core, feathered rim. p in [-0.5, 0.5]^2. */
float voxBlob(vec2 p) {
  float r = length(p) * 2.0;
  return saturate(1.0 - smoothstep(0.30, 1.0, r));
}

/** Smoke puff: irregular lobed silhouette with a little grain. */
float voxSmoke(vec2 p, float seed) {
  float r = length(p) * 2.0;
  float a = atan(p.y, p.x);
  float lobes = 0.12 * sin(a * 3.0 + seed * 31.0) + 0.08 * sin(a * 5.0 - seed * 17.0);
  float mask = 1.0 - smoothstep(0.18, 1.0 + lobes, r);
  float grain = 0.82 + 0.18 * hash21(p * 6.0 + vec2(seed * 23.0, seed * 11.0));
  return saturate(mask * grain);
}

/** Spark: pinpoint core plus a faint four-way flare. */
float voxSpark(vec2 p) {
  float r = length(p) * 2.0;
  float core = pow(saturate(1.0 - r), 3.0);
  vec2 q = abs(p);
  float flare = pow(saturate(1.0 - q.x * 9.0), 2.0) * pow(saturate(1.0 - q.y * 2.1), 2.0)
              + pow(saturate(1.0 - q.y * 9.0), 2.0) * pow(saturate(1.0 - q.x * 2.1), 2.0);
  return saturate(core * 1.35 + flare * 0.5);
}

/** Flame tongue: wide at the base, tapering to a wobbling tip. */
float voxFlame(vec2 p, float seed) {
  float y = saturate(p.y + 0.5);
  float w = 0.46 * pow(max(1.0 - y, 0.0), 0.62) * (1.0 + 0.22 * sin(y * 11.0 + seed * 27.0));
  float d = abs(p.x) - w;
  float mask = (1.0 - smoothstep(-0.05, 0.03, d)) * smoothstep(-0.02, 0.14, y);
  float core = saturate(1.0 - abs(p.x) / max(w, 1.0e-3));
  return saturate(mask * (0.45 + 0.55 * core));
}

/** Water droplet / rain streak: an ellipse that is fatter at the bottom. */
float voxDrop(vec2 p) {
  float t = saturate(1.0 - sq(p.y * 2.0));
  float w = 0.30 * sqrt(t) * (0.55 + 0.45 * saturate(0.5 - p.y));
  float d = abs(p.x) - w;
  float mask = 1.0 - smoothstep(-0.02, 0.02, d);
  return saturate(mask * (0.55 + 0.45 * saturate(1.0 - abs(p.x) / max(w, 1.0e-3))));
}

/** Air bubble: bright rim, faint fill, one specular glint. */
float voxBubble(vec2 p) {
  float r = length(p) * 2.0;
  float ring = 1.0 - smoothstep(0.04, 0.20, abs(r - 0.80));
  float fill = (1.0 - smoothstep(0.60, 0.86, r)) * 0.16;
  float glint = pow(saturate(1.0 - length(p - vec2(-0.14, 0.14)) * 5.0), 2.0) * 0.5;
  return saturate(ring * 0.85 + fill + glint);
}

/** Classic implicit heart, (x^2+y^2-1)^3 - x^2 y^3 <= 0. */
float voxHeart(vec2 p) {
  float x = p.x * 2.55;
  float y = p.y * 2.35 + 0.22;
  float a = x * x + y * y - 1.0;
  float f = a * a * a - x * x * y * y * y;
  return 1.0 - smoothstep(-0.02, 0.12, f);
}

/** Eighth note: tilted head, stem and flag. */
float voxNote(vec2 p) {
  vec2 h = rotate2(p - vec2(-0.13, -0.26), 0.40);
  float head = 1.0 - smoothstep(0.15, 0.19, length(h * vec2(1.0, 1.5)));
  float stemX = 1.0 - smoothstep(0.030, 0.048, abs(p.x - 0.055));
  float stemY = smoothstep(-0.30, -0.24, p.y) * (1.0 - smoothstep(0.32, 0.38, p.y));
  vec2 f = (p - vec2(0.13, 0.24)) * vec2(0.85, 1.7);
  float flag = 1.0 - smoothstep(0.11, 0.15, length(f));
  return saturate(head + stemX * stemY + flag);
}

/** Portal mote: two swirling arms rotating around a bright centre. */
float voxPortal(vec2 p, float seed, float t) {
  float r = length(p) * 2.0;
  float a = atan(p.y, p.x) + r * 3.4 - t * 1.7 + seed * TAU;
  float arms = 0.5 + 0.5 * sin(a * 2.0);
  float mask = (1.0 - smoothstep(0.35, 1.0, r)) * smoothstep(0.0, 0.22, r);
  return saturate(mask * (0.30 + 0.90 * arms) + pow(saturate(1.0 - r * 2.2), 3.0) * 0.6);
}

/** Six-armed snow crystal built by folding the plane into one 60-degree wedge. */
float voxSnow(vec2 p, float seed) {
  float r = length(p) * 2.0;
  float a = atan(p.y, p.x) + seed * TAU;
  float k = TAU / 6.0;
  float fold = mod(a + PI, k) - k * 0.5;
  vec2 q = vec2(cos(fold), sin(fold)) * r;
  float arm = (1.0 - smoothstep(0.05, 0.11, abs(q.y))) * (1.0 - smoothstep(0.74, 0.94, q.x));
  float side = (1.0 - smoothstep(0.04, 0.09, abs(abs(q.y) - max(q.x - 0.30, 0.0) * 0.55)))
             * step(0.28, q.x) * (1.0 - smoothstep(0.58, 0.76, q.x));
  float core = 1.0 - smoothstep(0.08, 0.20, r);
  return saturate(max(max(arm, side * 0.85), core));
}

/** Leaf silhouette, randomly oriented per particle. */
float voxLeaf(vec2 p, float seed) {
  vec2 q = rotate2(p, seed * TAU);
  float t = saturate(1.0 - sq(q.y * 2.0));
  float w = 0.40 * sqrt(t) * (0.55 + 0.45 * saturate(q.y + 0.5));
  float d = abs(q.x) - w;
  float mask = 1.0 - smoothstep(-0.02, 0.03, d);
  return saturate(mask) * (0.82 + 0.18 * saturate(1.0 - abs(q.x) * 6.0));
}

/** Four-point star used for critical hits. */
float voxStar(vec2 p) {
  float r = length(p) * 2.0;
  float a = atan(p.y, p.x);
  float reach = 0.30 + 0.70 * pow(abs(cos(a * 2.0)), 5.0);
  float mask = 1.0 - smoothstep(reach * 0.55, reach, r);
  return saturate(mask + pow(saturate(1.0 - r * 1.7), 4.0));
}

/** Thin expanding ring: rain splash crowns and shock waves. */
float voxRing(vec2 p) {
  float r = length(p) * 2.0;
  float ring = 1.0 - smoothstep(0.05, 0.26, abs(r - 0.78));
  return saturate(ring * (1.0 - smoothstep(0.84, 1.05, r)));
}

void main() {
  vec2 p = v_uv - 0.5;
  int kind = int(v_kind + 0.5);
  float t = u_time.x;

  vec3 rgb = v_color.rgb;
  float alpha = v_color.a;
  float shape;

  if (kind == 2) {
    // Block chip: a window into the real block texture, so a broken dirt block
    // throws dirt and a broken diamond block throws diamond.
    shape = 1.0;
    if (u_hasAlbedo == 1) {
      vec4 tex = texture(u_albedoArray, vec3(v_sub + v_uv * u_chipScale, v_layer));
      rgb *= tex.rgb;
      shape = tex.a;
    }
    rgb *= 0.80 + 0.28 * v_uv.y;
  } else if (kind == 0) {
    shape = voxBlob(p);
  } else if (kind == 1) {
    shape = voxSmoke(p, v_seed);
  } else if (kind == 3) {
    shape = voxSpark(p);
  } else if (kind == 4) {
    shape = voxFlame(p, v_seed);
  } else if (kind == 5) {
    shape = voxDrop(p);
  } else if (kind == 6) {
    shape = voxBubble(p);
  } else if (kind == 7) {
    shape = voxHeart(p);
  } else if (kind == 8) {
    shape = voxNote(p);
  } else if (kind == 9) {
    shape = voxPortal(p, v_seed, t);
  } else if (kind == 10) {
    shape = voxSnow(p, v_seed);
  } else if (kind == 11) {
    shape = voxLeaf(p, v_seed);
  } else if (kind == 12) {
    shape = voxStar(p);
  } else {
    shape = voxRing(p);
  }

  alpha *= shape;
  if (alpha <= 0.0025) discard;

  if (u_soft == 1) {
    vec2 suv = gl_FragCoord.xy * u_screen.zw;
    float sceneDepth = linearizeDepth(texture(u_gDepth, suv).r);
    alpha *= saturate((sceneDepth - v_depth) / max(u_softDistance, 1.0e-3));
  }

  // Dissolve sprites that are right on top of the near plane.
  alpha *= smoothstep(0.0, max(u_fadeNear, 1.0e-3), v_depth - u_camPos.w);
  if (alpha <= 0.0025) discard;

  rgb *= mix(1.0, alpha, u_premultiply);
  o_color = vec4(rgb, alpha);
}
`;

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/**
 * Read a settings key without ever throwing.
 * @param {?{get:function(string):*}} settings settings object
 * @param {string} key key name
 * @param {*} fallback value used when the key is missing
 * @returns {*} the setting value
 */
function readSetting(settings, key, fallback) {
  if (!settings || typeof settings.get !== 'function') return fallback;
  try {
    const v = settings.get(key);
    return v === undefined || v === null ? fallback : v;
  } catch (err) {
    return fallback;
  }
}

/**
 * Whether the block occupying a world position blocks a heavy particle.
 * @param {?{getBlock:function(number,number,number):number}} world the world
 * @param {number} x world X
 * @param {number} y world Y
 * @param {number} z world Z
 * @returns {boolean} true when the voxel is solid
 */
function solidAt(world, x, y, z) {
  const id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
  return id !== 0 && isSolid(id);
}

/**
 * Next power of two >= n, clamped into `[MIN_INSTANCES, limit]`.
 * @param {number} n requested instance count
 * @param {number} limit hard upper bound
 * @returns {number} allocation size in instances
 */
function growCapacity(n, limit) {
  let c = MIN_INSTANCES;
  while (c < n && c < limit) c *= 2;
  return Math.min(Math.max(c, Math.min(n, limit)), limit);
}

/**
 * Test whether a value looks like a WebGL texture.
 * @param {*} v candidate
 * @returns {boolean} true for a texture object
 */
function isTexture(v) {
  return !!v && typeof WebGLTexture !== 'undefined' && v instanceof WebGLTexture;
}

/* ========================================================================== */
/* ParticleSystem                                                             */
/* ========================================================================== */

/**
 * CPU-simulated, GPU-instanced particle and weather system.
 *
 * Typical wiring inside `render/renderer.js`:
 *
 * ```js
 * particles.setTextureManager(this.textures);       // block albedo array (unit 0)
 * particles.setDepthTexture(this.gbuffer.depth);    // soft particles (unit 7)
 * // per frame, after the lighting composite, into the HDR scene target:
 * particles.spawnWeather(frame.environment, frame.camera.position, frame.dt);
 * particles.update(frame.dt, frame.world, frame);
 * particles.render(frame, this.gbuffer);
 * ```
 */
export class ParticleSystem {
  /**
   * @param {import('../core/gl.js').GL} gl the VOXELIA WebGL2 device
   * @param {?{get:function(string):*, on?:function(string,Function):*,
   *           off?:function(string,Function):*}} [settings] the settings store
   */
  constructor(gl, settings) {
    /** @type {import('../core/gl.js').GL} The owning device. */
    this.device = gl;
    /** @type {?Object} The settings store (may be null). */
    this.settings = settings || null;

    /** @type {boolean} */
    this._disposed = false;
    /** @type {boolean} Set once a shader or draw failure disables the system. */
    this._failed = false;

    /** @type {number} Live particle count. */
    this._count = 0;
    /** @type {number} One past the highest slot ever used since the last shrink. */
    this._top = 0;
    /** @type {number} Number of entries currently on the free stack. */
    this._freeTop = 0;
    /** @type {?Int32Array} Stack of unused slot indices; null until sized. */
    this._freeList = null;
    /** @type {number} Allocated slot count. */
    this.capacity = 0;

    /* ---- quality ---------------------------------------------------------- */

    /** @type {string} Resolved `settings.particles` step. */
    this.quality = 'high';
    /** @type {number} Multiplier applied to every burst size. */
    this._spawnScale = 1;
    /** @type {number} Multiplier applied to the weather population. */
    this._weatherScale = 1;
    /** @type {boolean} Whether the soft-particle depth fade runs. */
    this._softEnabled = true;
    /** @type {boolean} Whether the alpha bucket is depth sorted. */
    this._sortEnabled = true;
    /** @type {number} Probability that a landing raindrop spawns a splash. */
    this._splashChance = 0.22;

    /* ---- simulation state ------------------------------------------------- */

    /** @type {?Object} Last world handed to {@link ParticleSystem#update}. */
    this._world = null;
    /** @type {number} Accumulated simulation time in seconds. */
    this._time = 0;
    /** @type {number} Monotonic internal frame counter. */
    this._frame = 0;
    /** @type {number} Current wind velocity along X. */
    this.windX = 0;
    /** @type {number} Current wind velocity along Z. */
    this.windZ = 0;
    /** @type {number} Sky-light scale, 0 at midnight, 1 at noon. */
    this._skyLevel = 1;
    /** @type {Float32Array} Ambient sky tint applied to sky-lit particles. */
    this._ambient = new Float32Array([1, 1, 1]);
    /** @type {number} Decaying lightning flash, 0..1. */
    this._lightning = 0;
    /** @type {?function(number,number,number,number):void} Lightning notification. */
    this.onLightning = null;

    /* ---- weather ---------------------------------------------------------- */

    /** @type {Int32Array} Slot indices owned by the weather cylinder. */
    this._weatherIdx = new Int32Array(0);
    /** @type {number} Number of live weather particles. */
    this._weatherCount = 0;
    /** @type {number} 0 = none, 1 = rain, 2 = snow. */
    this._weatherKind = 0;
    /** @type {number} Smoothed fraction of the sky visible above the camera. */
    this._coverage = 1;
    /** @type {number} Countdown to the next coverage re-sample. */
    this._coverageTimer = 0;
    /** @type {number} Last evaluated precipitation kind (sticky between checks). */
    this._precipTimer = 0;

    /* ---- GPU resources ---------------------------------------------------- */

    /** @type {?Object} The instanced particle program. */
    this._program = null;
    /** @type {?WebGLBuffer} Static unit quad. */
    this._quadBuffer = null;
    /** @type {?WebGLBuffer} Static quad indices. */
    this._indexBuffer = null;
    /** @type {?WebGLBuffer} Dynamic instance buffer, alpha bucket. */
    this._alphaBuffer = null;
    /** @type {?WebGLBuffer} Dynamic instance buffer, additive bucket. */
    this._addBuffer = null;
    /** @type {?WebGLVertexArrayObject} */
    this._alphaVAO = null;
    /** @type {?WebGLVertexArrayObject} */
    this._addVAO = null;
    /** @type {number} Instances the alpha buffer can hold. */
    this._alphaCap = 0;
    /** @type {number} Instances the additive buffer can hold. */
    this._addCap = 0;
    /** @type {Float32Array} Staging memory for the alpha bucket. */
    this._alphaData = new Float32Array(0);
    /** @type {Float32Array} Staging memory for the additive bucket. */
    this._addData = new Float32Array(0);
    /** @type {number} Instances packed for the alpha bucket this frame. */
    this._alphaN = 0;
    /** @type {number} Instances packed for the additive bucket this frame. */
    this._addN = 0;

    /* ---- external textures ------------------------------------------------ */

    /** @type {?Object} A `TextureManager`, queried for `albedoArray`. */
    this._textures = null;
    /** @type {?WebGLTexture} Explicit block albedo array override. */
    this._albedoOverride = null;
    /** @type {?WebGLTexture} Explicit scene-depth override. */
    this._depthOverride = null;

    /* ---- render state ----------------------------------------------------- */

    /** @type {number} Render target width in pixels (informational). */
    this.width = 1;
    /** @type {number} Render target height in pixels (informational). */
    this.height = 1;
    /** @type {number} World-space distance over which soft particles dissolve. */
    this.softDistance = 0.55;
    /** @type {number} Extra length per unit of speed for stretched billboards. */
    this.stretch = 0.03;
    /** @type {number} Distance over which sprites fade in near the camera. */
    this.nearFade = 0.35;
    /** @type {number} Frame index the instance buffers were packed for. */
    this._packedFrame = -1;
    /** @type {Float32Array} Camera origin the packed centres are relative to. */
    this._origin = new Float32Array(3);

    /* ---- scratch ---------------------------------------------------------- */

    /** @type {function():number} Deterministic PRNG. */
    this._rng = mulberry32(0x9e3779b9);
    /** @type {Float32Array} Reusable rgb scratch for tint lookups. */
    this._tint = new Float32Array([1, 1, 1]);
    /** @type {Int32Array} Alpha-bucket slot indices for this frame. */
    this._alphaIdx = new Int32Array(0);
    /** @type {Int32Array} Additive-bucket slot indices for this frame. */
    this._addIdx = new Int32Array(0);
    /** @type {Float32Array} Squared camera distance per slot, for sorting. */
    this._sortKey = new Float32Array(0);
    /** @type {?function(number,number):number} Cached sort comparator. */
    this._sortCmp = null;

    /* ---- go --------------------------------------------------------------- */

    this._applyQuality(true);
    this._buildProgram();
    this._buildStaticMesh();

    /** @type {?function(string):void} Settings listener, kept for `off()`. */
    this._onSettingsChange = null;
    if (this.settings && typeof this.settings.on === 'function') {
      this._onSettingsChange = (key) => {
        if (key === 'particles') this._applyQuality(false);
      };
      try {
        this.settings.on('change', this._onSettingsChange);
      } catch (err) {
        this._onSettingsChange = null;
      }
    }
  }

  /* ======================================================================== */
  /* Setup                                                                    */
  /* ======================================================================== */

  /**
   * Compile the instanced particle program.
   * @returns {boolean} true when the program is usable
   * @private
   */
  _buildProgram() {
    try {
      this._program = this.device.createProgram('particles', PARTICLE_VS, PARTICLE_FS, {});
      if (this.device.flushPrograms([this._program]) !== 1) {
        this._reportFailure('the particle shader failed to compile');
        return false;
      }
      this._program.bindUBO('Frame', FRAME_BINDING);
      return true;
    } catch (err) {
      this._reportFailure(err);
      return false;
    }
  }

  /**
   * Create the shared unit quad and its index buffer.
   * @returns {void}
   * @private
   */
  _buildStaticMesh() {
    const gl = this.device.gl;
    try {
      const corners = new Float32Array([
        -0.5, -0.5,
        0.5, -0.5,
        0.5, 0.5,
        -0.5, 0.5,
      ]);
      const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
      this._quadBuffer = this.device.createBuffer(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
      this._indexBuffer = this.device.createBuffer(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    } catch (err) {
      this._reportFailure(err);
    }
  }

  /**
   * Log a failure once and shut the system down for the rest of the session.
   * @param {*} err error or message
   * @returns {void}
   * @private
   */
  _reportFailure(err) {
    if (this._failed) return;
    this._failed = true;
    console.error('[particles] disabled after a failure:', err);
  }

  /**
   * Re-read `settings.particles` and, when the capacity changes, reallocate the
   * simulation arrays (which clears every live particle).
   * @param {boolean} force reallocate even when the step did not change
   * @returns {void}
   * @private
   */
  _applyQuality(force) {
    const raw = String(readSetting(this.settings, 'particles', 'high')).toLowerCase();
    const step = QUALITY[raw] ? raw : 'high';
    if (!force && step === this.quality) return;
    this.quality = step;
    const q = QUALITY[step];
    this._spawnScale = q.spawn;
    this._weatherScale = q.weather;
    this._softEnabled = q.soft;
    this._sortEnabled = q.sort;
    this._splashChance = q.splash;
    this._setCapacity(q.capacity);
  }

  /**
   * (Re)allocate every simulation array. All live particles are dropped.
   * @param {number} capacity number of slots
   * @returns {void}
   * @private
   */
  _setCapacity(capacity) {
    const cap = Math.max(0, Math.min(MAX_PARTICLES, capacity | 0));
    if (cap === this.capacity && this._freeList) {
      this.clear();
      return;
    }
    this.capacity = cap;

    const f = () => new Float32Array(cap);
    this.posX = f(); this.posY = f(); this.posZ = f();
    this.velX = f(); this.velY = f(); this.velZ = f();
    this.life = f(); this.maxLife = f();
    this.szX = f(); this.szY = f();
    this.rot = f();
    this.colR = f(); this.colG = f(); this.colB = f();
    this.alpha = f();
    this.lgtR = f(); this.lgtG = f(); this.lgtB = f(); this.lgtS = f();
    this.seed = f();

    this.layer = new Uint16Array(cap);
    this.type = new Uint8Array(cap);
    this.flags = new Uint8Array(cap);
    this.sprite = new Uint8Array(cap);
    this.subU = new Uint8Array(cap);
    this.subV = new Uint8Array(cap);
    this.alive = new Uint8Array(cap);

    this._freeList = new Int32Array(cap);
    this._alphaIdx = new Int32Array(cap);
    this._addIdx = new Int32Array(cap);
    this._sortKey = new Float32Array(cap);
    this._weatherIdx = new Int32Array(Math.min(cap, 24000));
    // The comparator caches a reference to the old key array — rebuild it.
    this._sortCmp = null;

    this.clear();
  }

  /* ======================================================================== */
  /* Slot management                                                          */
  /* ======================================================================== */

  /**
   * Take a slot off the free list.
   * @returns {number} the slot index, or -1 when the system is full
   * @private
   */
  _alloc() {
    if (this._freeTop <= 0) return -1;
    const i = this._freeList[--this._freeTop];
    this.alive[i] = 1;
    if (i >= this._top) this._top = i + 1;
    this._count++;
    return i;
  }

  /**
   * Return a slot to the free list.
   * @param {number} i slot index
   * @returns {void}
   * @private
   */
  _free(i) {
    if (this.alive[i] === 0) return;
    this.alive[i] = 0;
    this.flags[i] = 0;
    this._freeList[this._freeTop++] = i;
    this._count--;
  }

  /* ======================================================================== */
  /* Spawning                                                                 */
  /* ======================================================================== */

  /**
   * Emit a burst of particles.
   *
   * @param {string|number} type one of `'break'|'dust'|'splash'|'bubble'|
   *   'smoke'|'flame'|'spark'|'crit'|'heart'|'note'|'portal'|'drip'|'leaf'|
   *   'ember'|'explosion'|'rain'|'snow'|'cloud'|'lava'`, or a
   *   {@link PARTICLE_TYPES} id
   * @param {number} x world X of the burst centre
   * @param {number} y world Y of the burst centre
   * @param {number} z world Z of the burst centre
   * @param {{count?:number, scale?:number, spread?:number, speed?:number,
   *          size?:number, life?:number, alpha?:number, color?:ArrayLike<number>,
   *          velocity?:ArrayLike<number>, blockId?:number, face?:number,
   *          power?:number, gravityScale?:number}} [opts={}] overrides
   * @returns {number} how many particles were actually created
   */
  spawn(type, x, y, z, opts = {}) {
    if (this._disposed || this.capacity === 0) return 0;
    const id = typeof type === 'number'
      ? (type | 0)
      : (TYPE_BY_NAME.get(String(type).toLowerCase()) ?? -1);
    if (id < 0 || id >= TYPE_COUNT) return 0;
    if (id === P.EXPLOSION) return this._spawnExplosion(x, y, z, opts);

    const d = TYPE_DEFS[id];
    let count = opts.count === undefined ? d.count : opts.count;
    count = Math.round(count * this._spawnScale * (opts.scale === undefined ? 1 : opts.scale));
    if (!(count > 0)) return 0;
    return this._emit(id, x, y, z, count, opts);
  }

  /**
   * Low-level emitter: creates `count` particles of one archetype.
   * @param {number} id numeric type id
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {number} count number of particles
   * @param {Object} opts overrides (see {@link ParticleSystem#spawn})
   * @returns {number} particles created
   * @private
   */
  _emit(id, x, y, z, count, opts) {
    const d = TYPE_DEFS[id];
    const rng = this._rng;
    const world = this._world;

    const spread = opts.spread === undefined ? d.spread : opts.spread;
    const speed = opts.speed === undefined ? d.speed : opts.speed;
    const baseSize = opts.size === undefined ? d.size : opts.size;
    const baseLife = opts.life === undefined ? d.life : opts.life;
    const baseAlpha = opts.alpha === undefined ? d.alpha : opts.alpha;
    const boost = d.emissive > 0 ? d.emissive : 1;
    const vel = opts.velocity || null;
    const override = opts.color || null;
    const c1 = override || d.color;
    const c2 = override ? null : d.color2;

    // Break chips need a real texture layer; without a block there is nothing to
    // sample, so the archetype falls back to a plain soft blob.
    let chip = false;
    let blockId = 0;
    if (d.sprite === SPRITE.CHIP) {
      blockId = opts.blockId | 0;
      chip = blockId > 0;
    }
    const spriteKind = (d.sprite === SPRITE.CHIP && !chip) ? SPRITE.BLOB : d.sprite;

    let tintR = 1;
    let tintG = 1;
    let tintB = 1;
    if (chip) {
      const t = this._blockTint(blockId, x, z);
      tintR = t[0]; tintG = t[1]; tintB = t[2];
    }

    const maxLayer = MATERIALS.length - 1;
    let made = 0;
    for (let k = 0; k < count; k++) {
      const i = this._alloc();
      if (i < 0) break;
      made++;

      const r0 = rng();
      const r1 = rng();
      const r2 = rng();

      this.posX[i] = x + (r0 - 0.5) * 2 * spread;
      this.posY[i] = y + (r1 - 0.5) * 2 * spread;
      this.posZ[i] = z + (r2 - 0.5) * 2 * spread;

      // Random direction on the unit sphere, biased upward by `rise`.
      const theta = rng() * Math.PI * 2;
      const cosPhi = rng() * 2 - 1;
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
      const mag = speed * (0.35 + 0.65 * rng());
      let vx = Math.cos(theta) * sinPhi * mag;
      let vy = cosPhi * mag + d.rise * (0.6 + 0.8 * rng());
      let vz = Math.sin(theta) * sinPhi * mag;
      if (vel) { vx += vel[0] || 0; vy += vel[1] || 0; vz += vel[2] || 0; }
      this.velX[i] = vx;
      this.velY[i] = vy;
      this.velZ[i] = vz;

      const life = Math.max(0.03, baseLife * (1 - d.lifeVar + 2 * d.lifeVar * rng()));
      this.life[i] = life;
      this.maxLife[i] = life;

      const size = Math.max(0.002, baseSize * (1 - d.sizeVar + 2 * d.sizeVar * rng()));
      this.szX[i] = size;
      this.szY[i] = size * d.aspect;

      this.rot[i] = rng() * Math.PI * 2;
      this.seed[i] = rng();

      let cr = c1[0];
      let cg = c1[1];
      let cb = c1[2];
      if (c2) {
        const m = rng();
        cr += (c2[0] - cr) * m;
        cg += (c2[1] - cg) * m;
        cb += (c2[2] - cb) * m;
      }
      const shade = 0.88 + 0.24 * rng();
      this.colR[i] = cr * tintR * boost * shade;
      this.colG[i] = cg * tintG * boost * shade;
      this.colB[i] = cb * tintB * boost * shade;
      this.alpha[i] = baseAlpha;

      this.type[i] = id;
      this.sprite[i] = spriteKind;
      this.flags[i] = d.flags;

      if (chip) {
        const face = opts.face === undefined ? (rng() * 6) | 0 : (opts.face | 0);
        const layer = faceMaterial(blockId, face < 0 || face > 5 ? 0 : face);
        this.layer[i] = layer < 0 ? 0 : (layer > maxLayer ? maxLayer : layer);
        this.subU[i] = (rng() * 255) | 0;
        this.subV[i] = (rng() * 255) | 0;
      } else {
        this.layer[i] = 0;
        this.subU[i] = 0;
        this.subV[i] = 0;
      }

      this._sampleLight(world, i);
    }
    return made;
  }

  /**
   * Sample the baked voxel light at a particle's block and store block light and
   * sky light separately, so a day/night change needs no resample.
   * @param {?Object} world the world, or null
   * @param {number} i slot index
   * @returns {void}
   * @private
   */
  _sampleLight(world, i) {
    if (!world || typeof world.getLightPacked !== 'function') {
      this.lgtR[i] = 0; this.lgtG[i] = 0; this.lgtB[i] = 0; this.lgtS[i] = 1;
      return;
    }
    const packed = world.getLightPacked(
      Math.floor(this.posX[i]), Math.floor(this.posY[i]), Math.floor(this.posZ[i])) | 0;
    const inv = 1 / 15;
    this.lgtR[i] = (packed & 15) * inv;
    this.lgtG[i] = ((packed >> 4) & 15) * inv;
    this.lgtB[i] = ((packed >> 8) & 15) * inv;
    this.lgtS[i] = ((packed >> 12) & 15) * inv;
  }

  /**
   * Biome tint that must be multiplied onto a block's albedo (grass, leaves,
   * water). Returns a shared scratch triple — copy it if you keep it.
   * @param {number} blockId block id
   * @param {number} x world X of the block
   * @param {number} z world Z of the block
   * @returns {Float32Array} linear rgb multiplier
   * @private
   */
  _blockTint(blockId, x, z) {
    const out = this._tint;
    out[0] = 1; out[1] = 1; out[2] = 1;
    const kind = blockTint(blockId);
    if (!kind) return out;
    const world = this._world;
    if (!world || typeof world.getBiome !== 'function') return out;
    let c = null;
    try {
      const biome = world.getBiome(Math.floor(x), Math.floor(z)) | 0;
      if (kind === 'grass') c = biomeGrassColor(biome);
      else if (kind === 'foliage') c = biomeFoliageColor(biome);
      else if (kind === 'water') c = biomeWaterColor(biome);
    } catch (err) {
      c = null;
    }
    if (c && c.length >= 3) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; }
    return out;
  }

  /**
   * 20-40 chips of the block that was just destroyed, using that block's real
   * per-face textures and biome tint.
   * @param {number} x world X of the block's minimum corner
   * @param {number} y world Y of the block's minimum corner
   * @param {number} z world Z of the block's minimum corner
   * @param {number} blockId the block that broke
   * @returns {number} particles created
   */
  spawnBlockBreak(x, y, z, blockId) {
    if (this._disposed || this.capacity === 0 || !(blockId > 0)) return 0;
    const rng = this._rng;
    const count = Math.round((20 + rng() * 20) * this._spawnScale);
    if (!(count > 0)) return 0;
    // Chips start inside the block volume, not on a sphere around its corner.
    return this._emit(P.BREAK, x + 0.5, y + 0.5, z + 0.5, count, {
      blockId,
      spread: 0.42,
      speed: 2.4,
    });
  }

  /**
   * A few chips knocked off the face the player is hitting.
   * @param {number} x world X of the block's minimum corner
   * @param {number} y world Y of the block's minimum corner
   * @param {number} z world Z of the block's minimum corner
   * @param {number} blockId the block being hit
   * @param {ArrayLike<number>} faceNormal outward normal of the hit face
   * @returns {number} particles created
   */
  spawnBlockHit(x, y, z, blockId, faceNormal) {
    if (this._disposed || this.capacity === 0 || !(blockId > 0)) return 0;
    const rng = this._rng;
    const nx = faceNormal ? (faceNormal[0] || 0) : 0;
    const ny = faceNormal ? (faceNormal[1] || 0) : 1;
    const nz = faceNormal ? (faceNormal[2] || 0) : 0;

    // Direction byte of ARCHITECTURE.md 3.1: 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z.
    let face = 2;
    if (nx > 0.5) face = 0;
    else if (nx < -0.5) face = 1;
    else if (ny > 0.5) face = 2;
    else if (ny < -0.5) face = 3;
    else if (nz > 0.5) face = 4;
    else if (nz < -0.5) face = 5;

    const count = Math.max(1, Math.round((2 + rng() * 4) * this._spawnScale));
    const px = x + 0.5 + nx * 0.53;
    const py = y + 0.5 + ny * 0.53;
    const pz = z + 0.5 + nz * 0.53;
    return this._emit(P.BREAK, px, py, pz, count, {
      blockId,
      face,
      spread: 0.22,
      speed: 1.3,
      velocity: [nx * 1.6, ny * 1.6 + 0.9, nz * 1.6],
      life: 0.7,
      size: 0.085,
    });
  }

  /**
   * Smoke, fire and debris for an explosion.
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {{power?:number, blockId?:number, scale?:number}} [opts={}] options
   * @returns {number} particles created
   * @private
   */
  _spawnExplosion(x, y, z, opts = {}) {
    const power = clamp(opts.power === undefined ? 3 : opts.power, 0.5, 16);
    const s = this._spawnScale * (opts.scale === undefined ? 1 : opts.scale);
    if (!(s > 0)) return 0;
    const radius = 0.5 + power * 0.42;
    let made = 0;

    made += this._emit(P.EXPLOSION, x, y, z,
      Math.max(1, Math.round((3 + power) * s)),
      { spread: radius * 0.55, speed: power * 0.5, size: 0.55 + power * 0.30 });

    made += this._emit(P.FLAME, x, y, z,
      Math.max(1, Math.round((5 + power * 2) * s)),
      { spread: radius * 0.7, speed: power * 0.9, size: 0.3 + power * 0.06 });

    made += this._emit(P.SMOKE, x, y, z,
      Math.max(1, Math.round((8 + power * 3) * s)),
      { spread: radius, speed: power * 0.7, size: 0.45 + power * 0.12, life: 3.2 });

    made += this._emit(P.SPARK, x, y, z,
      Math.max(1, Math.round((10 + power * 3) * s)),
      { spread: radius * 0.4, speed: 3 + power * 1.6 });

    const blockId = opts.blockId | 0;
    if (blockId > 0) {
      made += this._emit(P.BREAK, x, y, z,
        Math.max(1, Math.round(power * 4 * s)),
        { blockId, spread: radius * 0.6, speed: 3 + power * 1.2, life: 1.8 });
    }
    return made;
  }

  /* ======================================================================== */
  /* Lightning                                                                */
  /* ======================================================================== */

  /**
   * Fire a lightning bolt: a bright emissive column, sparks at the impact point
   * and a screen-wide flash value other passes can read from
   * {@link ParticleSystem#lightningFlash}.
   * @param {number} x world X of the strike
   * @param {number} y world Y of the ground at the strike
   * @param {number} z world Z of the strike
   * @param {number} [strength=1] flash intensity, 0..1
   * @returns {void}
   */
  triggerLightning(x, y, z, strength = 1) {
    const s = clamp(strength, 0, 1);
    this._lightning = Math.max(this._lightning, s);
    if (this.capacity === 0 || this._disposed) {
      if (typeof this.onLightning === 'function') {
        try { this.onLightning(x, y, z, s); } catch (err) { /* listener problem */ }
      }
      return;
    }
    const rng = this._rng;
    const height = 46;
    const segments = Math.max(4, Math.round(24 * this._spawnScale));
    let bx = x;
    let bz = z;
    for (let k = 0; k < segments; k++) {
      const t = k / segments;
      bx += (rng() - 0.5) * 1.6;
      bz += (rng() - 0.5) * 1.6;
      this._emit(P.SPARK, bx, y + t * height, bz, 2, {
        spread: 0.15,
        speed: 1.2,
        size: 0.28 - 0.12 * t,
        life: 0.24,
        color: [1.0, 0.95, 1.0],
      });
    }
    this._emit(P.SPARK, x, y + 0.2, z, Math.max(4, Math.round(24 * this._spawnScale)), {
      spread: 0.5, speed: 7, color: [1.0, 0.92, 0.78],
    });
    this._emit(P.SMOKE, x, y + 0.4, z, Math.max(2, Math.round(8 * this._spawnScale)), {
      spread: 0.7, speed: 1.2,
    });
    if (typeof this.onLightning === 'function') {
      try { this.onLightning(x, y, z, s); } catch (err) { /* listener problem */ }
    }
  }

  /**
   * The current lightning flash, 0 when nothing is striking. Decays over ~0.3 s
   * with a flicker so the sky/lighting passes can modulate exposure.
   * @returns {number} flash intensity, 0..1
   */
  get lightningFlash() {
    if (this._lightning <= 0) return 0;
    const flicker = 0.65 + 0.35 * Math.sin(this._time * 92);
    return clamp(this._lightning * flicker, 0, 1);
  }

  /* ======================================================================== */
  /* Weather                                                                  */
  /* ======================================================================== */

  /**
   * Maintain the persistent cylinder of rain or snow around the camera.
   *
   * Particles are allocated once and recycled in place as the player moves, so
   * there is no spawn/despawn churn. Density follows `environment.rainStrength`,
   * cold biomes get slow drifting snow instead of rain, raindrops become
   * splashes where they meet the ground, and standing under a solid block thins
   * the population out.
   *
   * Call this once per frame; it also runs the recycle pass.
   *
   * @param {?{rainStrength?:number, weather?:string, thunderStrength?:number}} environment
   *   world weather state (5.37)
   * @param {ArrayLike<number>} cameraPos world-space camera position
   * @param {number} dt seconds since the last call
   * @returns {number} live weather particles
   */
  spawnWeather(environment, cameraPos, dt) {
    if (this._disposed || this._failed) return 0;
    if (this.capacity === 0 || this._weatherScale <= 0) {
      this._releaseWeather();
      return 0;
    }
    const step = clamp(dt, 0, 0.25);
    const camX = cameraPos ? (cameraPos[0] || 0) : 0;
    const camY = cameraPos ? (cameraPos[1] || 0) : 0;
    const camZ = cameraPos ? (cameraPos[2] || 0) : 0;
    const world = this._world;

    let rain = 0;
    let thunder = 0;
    let weatherName = 'clear';
    if (environment) {
      rain = clamp(Number.isFinite(environment.rainStrength) ? environment.rainStrength : 0, 0, 1);
      thunder = clamp(Number.isFinite(environment.thunderStrength) ? environment.thunderStrength : 0, 0, 1);
      weatherName = typeof environment.weather === 'string' ? environment.weather : 'clear';
      if (rain <= 0 && (weatherName === 'rain' || weatherName === 'snow' || weatherName === 'thunder')) {
        rain = 1;
      }
    }

    // Decide rain vs. snow from the biome under the camera, re-checked at 4 Hz
    // so a biome border does not make the weather flicker.
    this._precipTimer -= step;
    if (this._precipTimer <= 0) {
      this._precipTimer = COVERAGE_INTERVAL;
      let kind = 0;
      if (rain > 0.001) {
        let precip = weatherName === 'snow' ? 'snow' : 'rain';
        if (world && typeof world.getBiome === 'function') {
          try {
            const biome = world.getBiome(Math.floor(camX), Math.floor(camZ)) | 0;
            precip = biomePrecipitationAt(biome, Math.floor(camY));
          } catch (err) {
            precip = 'rain';
          }
        }
        kind = precip === 'snow' ? 2 : (precip === 'none' ? 0 : 1);
      }
      if (kind !== this._weatherKind) {
        this._releaseWeather();
        this._weatherKind = kind;
      }
      this._sampleCoverage(world, camX, camY, camZ);
    }

    const kind = this._weatherKind;
    if (kind === 0 || rain <= 0.001) {
      this._releaseWeather();
      this._maybeLightning(thunder, step, camX, camY, camZ);
      return 0;
    }

    // Population target: density * quality * how much sky is actually visible.
    const base = kind === 2 ? 900 : 1700;
    const openness = 0.10 + 0.90 * this._coverage;
    const limit = Math.min(this._weatherIdx.length, Math.floor(this.capacity * 0.6));
    let target = Math.round(base * rain * this._weatherScale * openness);
    if (target > limit) target = limit;
    if (target < 0) target = 0;

    while (this._weatherCount > target) {
      const i = this._weatherIdx[--this._weatherCount];
      this._free(i);
    }
    while (this._weatherCount < target) {
      const i = this._alloc();
      if (i < 0) break;
      this._initWeatherParticle(i, kind, camX, camY, camZ, rain, false);
      this._weatherIdx[this._weatherCount++] = i;
    }

    this._recycleWeather(kind, camX, camY, camZ, rain, world);
    this._maybeLightning(thunder, step, camX, camY, camZ);
    return this._weatherCount;
  }

  /**
   * Set up (or reset) one weather particle inside the cylinder.
   * @param {number} i slot index
   * @param {number} kind 1 = rain, 2 = snow
   * @param {number} camX camera X
   * @param {number} camY camera Y
   * @param {number} camZ camera Z
   * @param {number} rain rain strength 0..1
   * @param {boolean} atTop place it at the top of the cylinder instead of anywhere
   * @returns {void}
   * @private
   */
  _initWeatherParticle(i, kind, camX, camY, camZ, rain, atTop) {
    const rng = this._rng;
    const d = TYPE_DEFS[kind === 2 ? P.SNOW : P.RAIN];
    const ang = rng() * Math.PI * 2;
    const r = WEATHER_RADIUS * Math.sqrt(rng());

    this.posX[i] = camX + Math.cos(ang) * r;
    this.posZ[i] = camZ + Math.sin(ang) * r;
    this.posY[i] = atTop
      ? camY + WEATHER_TOP + rng() * 8
      : camY - WEATHER_BOTTOM + rng() * (WEATHER_TOP + WEATHER_BOTTOM);

    if (kind === 2) {
      this.velX[i] = this.windX * 0.22 + (rng() - 0.5) * 0.5;
      this.velZ[i] = this.windZ * 0.22 + (rng() - 0.5) * 0.5;
      this.velY[i] = -(1.0 + rng() * 0.9);
    } else {
      this.velX[i] = this.windX * 0.28;
      this.velZ[i] = this.windZ * 0.28;
      this.velY[i] = -(21 + rng() * 8);
    }

    const size = Math.max(0.004, d.size * (1 - d.sizeVar + 2 * d.sizeVar * rng()));
    this.szX[i] = size;
    this.szY[i] = size * d.aspect;
    this.rot[i] = rng() * Math.PI * 2;
    this.seed[i] = rng();
    this.life[i] = 1e9;
    this.maxLife[i] = 1e9;

    const shade = 0.9 + 0.2 * rng();
    this.colR[i] = d.color[0] * shade;
    this.colG[i] = d.color[1] * shade;
    this.colB[i] = d.color[2] * shade;
    this.alpha[i] = d.alpha * (0.45 + 0.55 * rain);

    this.type[i] = d.id;
    this.sprite[i] = d.sprite;
    this.flags[i] = d.flags;
    this.layer[i] = 0;
    this.subU[i] = 0;
    this.subV[i] = 0;

    this._sampleLight(this._world, i);
  }

  /**
   * Re-place every weather particle that left the cylinder, and turn landing
   * raindrops into splashes.
   * @param {number} kind 1 = rain, 2 = snow
   * @param {number} camX camera X
   * @param {number} camY camera Y
   * @param {number} camZ camera Z
   * @param {number} rain rain strength 0..1
   * @param {?Object} world the world, or null
   * @returns {void}
   * @private
   */
  _recycleWeather(kind, camX, camY, camZ, rain, world) {
    const idx = this._weatherIdx;
    const n = this._weatherCount;
    const rng = this._rng;
    const r2 = (WEATHER_RADIUS + 2) * (WEATHER_RADIUS + 2);
    const canGround = kind === 1 && world && typeof world.getHeight === 'function';
    const splashChance = this._splashChance;

    for (let k = 0; k < n; k++) {
      const i = idx[k];
      if (this.alive[i] === 0) continue;
      const px = this.posX[i];
      const py = this.posY[i];
      const pz = this.posZ[i];
      const dx = px - camX;
      const dz = pz - camZ;
      let recycle = false;

      if (py < camY - WEATHER_BOTTOM || py > camY + WEATHER_TOP + 12) recycle = true;
      else if (dx * dx + dz * dz > r2) recycle = true;
      else if (canGround) {
        let ground = -1024;
        try {
          ground = world.getHeight(Math.floor(px), Math.floor(pz));
        } catch (err) {
          ground = -1024;
        }
        if (py <= ground) {
          recycle = true;
          if (splashChance > 0 && rng() < splashChance) {
            this._emit(P.RAIN_SPLASH, px, ground + 0.03, pz, 1, { spread: 0.06 });
          }
        }
      }

      if (recycle) this._initWeatherParticle(i, kind, camX, camY, camZ, rain, true);
    }

    // Snow drifts: a slow horizontal wobble driven by the particle's own seed.
    if (kind === 2) {
      const t = this._time;
      for (let k = 0; k < n; k++) {
        const i = idx[k];
        if (this.alive[i] === 0) continue;
        const s = this.seed[i] * 6.2831853;
        this.velX[i] = this.windX * 0.22 + Math.sin(t * 0.8 + s) * 0.55;
        this.velZ[i] = this.windZ * 0.22 + Math.cos(t * 0.63 + s * 1.7) * 0.55;
      }
    }
  }

  /**
   * Free every weather particle and reset the cylinder.
   * @returns {void}
   * @private
   */
  _releaseWeather() {
    for (let k = 0; k < this._weatherCount; k++) {
      const i = this._weatherIdx[k];
      if (this.alive && this.alive[i]) this._free(i);
    }
    this._weatherCount = 0;
  }

  /**
   * Estimate how much of the sky is visible above the camera by testing a 3x3
   * grid of column heights. Standing in a cave or under a roof thins the rain.
   * @param {?Object} world the world, or null
   * @param {number} camX camera X
   * @param {number} camY camera Y
   * @param {number} camZ camera Z
   * @returns {void}
   * @private
   */
  _sampleCoverage(world, camX, camY, camZ) {
    if (!world || typeof world.getHeight !== 'function') {
      this._coverage = 1;
      return;
    }
    const cx = Math.floor(camX);
    const cy = Math.floor(camY);
    const cz = Math.floor(camZ);
    let open = 0;
    try {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (world.getHeight(cx + dx * 2, cz + dz * 2) <= cy + 1) open++;
        }
      }
    } catch (err) {
      this._coverage = 1;
      return;
    }
    const target = open / 9;
    this._coverage += (target - this._coverage) * 0.5;
  }

  /**
   * Randomly strike lightning while a thunderstorm is running.
   * @param {number} thunder thunder strength 0..1
   * @param {number} dt seconds since the last call
   * @param {number} camX camera X
   * @param {number} camY camera Y
   * @param {number} camZ camera Z
   * @returns {void}
   * @private
   */
  _maybeLightning(thunder, dt, camX, camY, camZ) {
    if (thunder <= 0.01) return;
    if (this._rng() >= dt * thunder * 0.09) return;
    const rng = this._rng;
    const ang = rng() * Math.PI * 2;
    const dist = 34 + rng() * 60;
    const x = camX + Math.cos(ang) * dist;
    const z = camZ + Math.sin(ang) * dist;
    let y = camY;
    const world = this._world;
    if (world && typeof world.getHeight === 'function') {
      try { y = world.getHeight(Math.floor(x), Math.floor(z)); } catch (err) { y = camY; }
    }
    this.triggerLightning(x, y, z, 0.55 + 0.45 * thunder);
  }

  /* ======================================================================== */
  /* Simulation                                                               */
  /* ======================================================================== */

  /**
   * Advance the simulation by `dt` seconds.
   *
   * Integrates gravity and drag, applies wind, ages particles, refreshes a
   * sixteenth of the population's voxel light, and runs the cheap 3-axis voxel
   * collision for heavy types so break chips bounce and settle.
   *
   * @param {number} dt seconds since the previous update
   * @param {?Object} world the world (5.14), used for collision and lighting
   * @param {?Object} [frame] the render frame; `frame.environment` drives wind
   *   and the sky-light level
   * @returns {void}
   */
  update(dt, world, frame) {
    if (this._disposed) return;
    if (world) this._world = world;
    const step = clamp(dt, 0, 0.1);
    if (step <= 0 || this.capacity === 0) return;

    this._time += step;
    this._frame++;
    if (this._lightning > 0) this._lightning = Math.max(0, this._lightning - step * 3.4);

    const env = (frame && frame.environment) || null;
    this._updateWind(env);
    this._updateSkyLevel(env);

    const w = this._world;
    const canCollide = !!(w && typeof w.getBlock === 'function');
    const phase = this._frame & 15;
    const top = this._top;

    for (let i = 0; i < top; i++) {
      if (this.alive[i] === 0) continue;
      const fl = this.flags[i];
      const weather = (fl & F.WEATHER) !== 0;

      if (!weather) {
        const life = this.life[i] - step;
        if (life <= 0) { this._free(i); continue; }
        this.life[i] = life;
      }

      const t = this.type[i];
      let vx = this.velX[i];
      let vy = this.velY[i];
      let vz = this.velZ[i];

      if (!weather) {
        vy -= T_GRAVITY[t] * step;
        const damp = 1 - T_DRAG[t] * step;
        const k = damp < 0 ? 0 : damp;
        vx *= k; vy *= k; vz *= k;
        if ((fl & F.WIND) !== 0) {
          const wind = T_WIND[t] * step * 2.2;
          vx += (this.windX - vx) * (wind > 1 ? 1 : wind);
          vz += (this.windZ - vz) * (wind > 1 ? 1 : wind);
        }
      }

      let px = this.posX[i];
      let py = this.posY[i];
      let pz = this.posZ[i];
      let nx = px + vx * step;
      let ny = py + vy * step;
      let nz = pz + vz * step;

      if (canCollide && (fl & F.COLLIDE) !== 0) {
        const bounce = T_BOUNCE[t];
        if (solidAt(w, px, ny, pz)) {
          if (vy < 0) {
            ny = Math.floor(ny) + 1.001;
            if (-vy < 1.1) {
              vy = 0;
              this.flags[i] = fl | F.SETTLED;
            } else {
              vy = -vy * bounce;
            }
          } else {
            ny = Math.ceil(ny) - 1.001;
            vy = -vy * bounce;
          }
          vx *= 0.62;
          vz *= 0.62;
        }
        if (solidAt(w, nx, ny, pz)) { nx = px; vx = -vx * bounce * 0.5; }
        if (solidAt(w, nx, ny, nz)) { nz = pz; vz = -vz * bounce * 0.5; }
      }

      this.velX[i] = vx;
      this.velY[i] = vy;
      this.velZ[i] = vz;
      this.posX[i] = nx;
      this.posY[i] = ny;
      this.posZ[i] = nz;

      const grow = T_GROW[t];
      if (grow !== 0) {
        const scale = 1 + grow * step;
        const s = scale < 0.02 ? 0.02 : scale;
        const sx = this.szX[i] * s;
        const sy = this.szY[i] * s;
        this.szX[i] = sx < 0.0005 ? 0.0005 : sx;
        this.szY[i] = sy < 0.0005 ? 0.0005 : sy;
      }
      const spin = T_SPIN[t];
      if (spin !== 0) this.rot[i] += (this.seed[i] * 2 - 1) * spin * step;

      // Refresh the baked light for 1/16 of the population per frame, staggered
      // by slot index — roughly four full refreshes a second at 60 fps.
      if ((i & 15) === phase) this._sampleLight(w, i);
    }

    // Shrink the scan range when the tail of the pool went quiet.
    let newTop = this._top;
    while (newTop > 0 && this.alive[newTop - 1] === 0) newTop--;
    this._top = newTop;
  }

  /**
   * Recompute the wind vector from the weather state.
   * @param {?Object} env the environment (5.37), or null
   * @returns {void}
   * @private
   */
  _updateWind(env) {
    const rain = env && Number.isFinite(env.rainStrength) ? clamp(env.rainStrength, 0, 1) : 0;
    const t = this._time;
    const strength = 0.55 + rain * 3.6;
    this.windX = (Math.sin(t * 0.13) + 0.4 * Math.sin(t * 0.37 + 1.7)) * strength;
    this.windZ = (Math.cos(t * 0.11 + 0.6) + 0.35 * Math.sin(t * 0.29 + 3.1)) * strength;
  }

  /**
   * Recompute the sky-light scale and ambient tint from the environment.
   * @param {?Object} env the environment (5.37), or null
   * @returns {void}
   * @private
   */
  _updateSkyLevel(env) {
    let sky = 1;
    if (env) {
      if (typeof env.getLightLevel === 'function') {
        try { sky = clamp(env.getLightLevel() / 15, 0, 1); } catch (err) { sky = 1; }
      } else if (Number.isFinite(env.timeOfDay)) {
        sky = clamp(Math.sin(env.timeOfDay * Math.PI * 2) * 1.6 + 0.4, 0, 1);
      }
      const rain = Number.isFinite(env.rainStrength) ? clamp(env.rainStrength, 0, 1) : 0;
      sky *= 1 - 0.35 * rain;
    }
    this._skyLevel = 0.06 + 0.94 * sky;

    const amb = env && env.skyAmbient;
    if (amb && amb.length >= 3) {
      // Normalize so the tint only changes the hue, not the overall brightness.
      const m = Math.max(amb[0], amb[1], amb[2], 1e-4);
      this._ambient[0] = clamp(amb[0] / m, 0, 1);
      this._ambient[1] = clamp(amb[1] / m, 0, 1);
      this._ambient[2] = clamp(amb[2] / m, 0, 1);
    } else {
      this._ambient[0] = 1; this._ambient[1] = 1; this._ambient[2] = 1;
    }
  }

  /* ======================================================================== */
  /* Packing & rendering                                                      */
  /* ======================================================================== */

  /**
   * Grow a bucket's staging array and GPU buffer, rebuilding its VAO.
   * @param {number} bucket 0 = alpha, 1 = additive
   * @param {number} instances number of instances that must fit
   * @returns {boolean} true when the bucket is usable
   * @private
   */
  _ensureBucket(bucket, instances) {
    const gl = this.device.gl;
    const cap = bucket === 0 ? this._alphaCap : this._addCap;
    if (cap >= instances && (bucket === 0 ? this._alphaVAO : this._addVAO)) return true;
    const want = growCapacity(instances, Math.max(MIN_INSTANCES, this.capacity));
    if (want <= cap && (bucket === 0 ? this._alphaVAO : this._addVAO)) return true;

    try {
      const oldBuffer = bucket === 0 ? this._alphaBuffer : this._addBuffer;
      const oldVAO = bucket === 0 ? this._alphaVAO : this._addVAO;
      if (oldVAO) {
        this.device.bindVertexArray(null);
        gl.deleteVertexArray(oldVAO);
      }
      if (oldBuffer) gl.deleteBuffer(oldBuffer);

      const buffer = this.device.createBuffer(
        gl.ARRAY_BUFFER, want * INSTANCE_STRIDE, gl.DYNAMIC_DRAW);
      const vao = this.device.createVertexArray({
        attributes: [
          { location: 0, buffer: this._quadBuffer, size: 2, type: gl.FLOAT, stride: 8, offset: 0 },
          { location: 1, buffer, size: 3, type: gl.FLOAT, stride: INSTANCE_STRIDE, offset: 0, divisor: 1 },
          { location: 2, buffer, size: 4, type: gl.FLOAT, stride: INSTANCE_STRIDE, offset: 12, divisor: 1 },
          { location: 3, buffer, size: 4, type: gl.FLOAT, stride: INSTANCE_STRIDE, offset: 28, divisor: 1 },
          { location: 4, buffer, size: 4, type: gl.FLOAT, stride: INSTANCE_STRIDE, offset: 44, divisor: 1 },
          { location: 5, buffer, size: 4, type: gl.FLOAT, stride: INSTANCE_STRIDE, offset: 60, divisor: 1 },
        ],
        indexBuffer: this._indexBuffer,
        indexType: gl.UNSIGNED_SHORT,
      });

      const data = new Float32Array(want * INSTANCE_FLOATS);
      if (bucket === 0) {
        this._alphaBuffer = buffer;
        this._alphaVAO = vao;
        this._alphaCap = want;
        this._alphaData = data;
      } else {
        this._addBuffer = buffer;
        this._addVAO = vao;
        this._addCap = want;
        this._addData = data;
      }
      return true;
    } catch (err) {
      this._reportFailure(err);
      return false;
    }
  }

  /**
   * Collect the visible particles into the two bucket index lists, optionally
   * sorting the alpha bucket back to front.
   * @param {number} camX camera X
   * @param {number} camY camera Y
   * @param {number} camZ camera Z
   * @param {number} maxDist maximum draw distance in blocks
   * @param {?Object} frustum a `Frustum` with `containsSphere`, or null
   * @returns {void}
   * @private
   */
  _collect(camX, camY, camZ, maxDist, frustum) {
    const maxSq = maxDist * maxDist;
    const alphaIdx = this._alphaIdx;
    const addIdx = this._addIdx;
    const key = this._sortKey;
    const useFrustum = !!(frustum && typeof frustum.containsSphere === 'function');
    let na = 0;
    let nb = 0;

    for (let i = 0, top = this._top; i < top; i++) {
      if (this.alive[i] === 0) continue;
      const dx = this.posX[i] - camX;
      const dy = this.posY[i] - camY;
      const dz = this.posZ[i] - camZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > maxSq) continue;
      if (useFrustum) {
        const r = (this.szX[i] > this.szY[i] ? this.szX[i] : this.szY[i]) * 2;
        if (!frustum.containsSphere(this.posX[i], this.posY[i], this.posZ[i], r)) continue;
      }
      if ((this.flags[i] & F.ADDITIVE) !== 0) {
        addIdx[nb++] = i;
      } else {
        key[i] = d2;
        alphaIdx[na++] = i;
      }
    }

    if (this._sortEnabled && na > 1 && na <= SORT_LIMIT) {
      if (!this._sortCmp) {
        const k = this._sortKey;
        this._sortCmp = (a, b) => k[b] - k[a];
      }
      // A subarray shares storage with `_alphaIdx`, so this sorts in place.
      alphaIdx.subarray(0, na).sort(this._sortCmp);
    }

    this._alphaN = na;
    this._addN = nb;
  }

  /**
   * Write one bucket's instances into its staging array.
   * @param {Int32Array} idx slot indices to write
   * @param {number} n number of instances
   * @param {Float32Array} dest staging array
   * @param {number} camX camera X (centres are stored relative to it)
   * @param {number} camY camera Y
   * @param {number} camZ camera Z
   * @returns {number} floats written
   * @private
   */
  _packBucket(idx, n, dest, camX, camY, camZ) {
    const sky = this._skyLevel;
    const ambR = this._ambient[0];
    const ambG = this._ambient[1];
    const ambB = this._ambient[2];
    const subScale = (1 - CHIP_UV_SCALE) / 255;
    let o = 0;

    for (let k = 0; k < n; k++) {
      const i = idx[k];
      const fl = this.flags[i];
      const t = this.type[i];

      dest[o++] = this.posX[i] - camX;
      dest[o++] = this.posY[i] - camY;
      dest[o++] = this.posZ[i] - camZ;

      dest[o++] = this.szX[i];
      dest[o++] = this.szY[i];
      dest[o++] = this.rot[i];
      dest[o++] = this.seed[i];

      let r = this.colR[i];
      let g = this.colG[i];
      let b = this.colB[i];
      if ((fl & F.EMISSIVE) === 0) {
        const s = this.lgtS[i] * sky;
        let lr = this.lgtR[i] * 1.15;
        let lg = this.lgtG[i] * 1.15;
        let lb = this.lgtB[i] * 1.15;
        const sr = s * ambR;
        const sg = s * ambG;
        const sb = s * ambB;
        if (sr > lr) lr = sr;
        if (sg > lg) lg = sg;
        if (sb > lb) lb = sb;
        r *= lr + AMBIENT_FLOOR;
        g *= lg + AMBIENT_FLOOR;
        b *= lb + AMBIENT_FLOOR;
      }
      dest[o++] = r;
      dest[o++] = g;
      dest[o++] = b;

      let a = this.alpha[i];
      const fadeIn = T_FADE_IN[t];
      const fadeOut = T_FADE_OUT[t];
      if (fadeIn > 0 || fadeOut > 0) {
        const lifeT = this.maxLife[i] > 0 ? this.life[i] / this.maxLife[i] : 0;
        if (fadeOut > 0) {
          const f = lifeT / fadeOut;
          if (f < 1) a *= f < 0 ? 0 : f;
        }
        if (fadeIn > 0) {
          const f = (1 - lifeT) / fadeIn;
          if (f < 1) a *= f < 0 ? 0 : f;
        }
      }
      dest[o++] = a;

      dest[o++] = this.sprite[i];
      dest[o++] = this.layer[i];
      dest[o++] = this.subU[i] * subScale;
      dest[o++] = this.subV[i] * subScale;

      dest[o++] = this.velX[i];
      dest[o++] = this.velY[i];
      dest[o++] = this.velZ[i];
      dest[o++] = (fl & F.STRETCH) !== 0 ? 1 : ((fl & F.AXIS) !== 0 ? 2 : 0);
    }
    return o;
  }

  /**
   * Draw every live particle into the currently bound render target.
   *
   * Two instanced draw calls: the alpha bucket (depth-sorted when the quality
   * step allows it) and the additive bucket. Depth testing is on, depth writes
   * are off, faces are not culled.
   *
   * @param {Object} frame the render frame (5.26); `frame.camera` supplies the
   *   position and frustum
   * @param {?Object} [gbufferOrForward] the G-buffer (or anything carrying a
   *   `depth` texture) used for the soft-particle fade; may be null when
   *   {@link ParticleSystem#setDepthTexture} was called
   * @returns {void}
   */
  render(frame, gbufferOrForward) {
    if (this._disposed || this._failed || this.capacity === 0) return;
    if (this._count === 0) return;
    const program = this._program;
    if (!program || !program.program) return;

    try {
      const device = this.device;
      const gl = device.gl;
      const camera = (frame && frame.camera) || null;
      const pos = (camera && camera.position) || null;
      const camX = pos ? (pos[0] || 0) : 0;
      const camY = pos ? (pos[1] || 0) : 0;
      const camZ = pos ? (pos[2] || 0) : 0;

      const frameIndex = frame && Number.isFinite(frame.frameIndex) ? frame.frameIndex | 0 : -1;
      if (frameIndex < 0 || frameIndex !== this._packedFrame) {
        const rd = clamp(Number(readSetting(this.settings, 'renderDistance', 10)) || 10, 2, 64);
        const ed = clamp(Number(readSetting(this.settings, 'entityDistance', 1)) || 1, 0.25, 4);
        const maxDist = clamp(rd * 16 * ed, 24, 320);
        this._collect(camX, camY, camZ, maxDist, camera ? camera.frustum : null);

        this._origin[0] = camX;
        this._origin[1] = camY;
        this._origin[2] = camZ;

        if (this._alphaN > 0 && this._ensureBucket(0, this._alphaN)) {
          const floats = this._packBucket(this._alphaIdx, this._alphaN, this._alphaData, camX, camY, camZ);
          gl.bindBuffer(gl.ARRAY_BUFFER, this._alphaBuffer);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._alphaData, 0, floats);
        } else if (this._alphaN > 0) {
          this._alphaN = 0;
        }
        if (this._addN > 0 && this._ensureBucket(1, this._addN)) {
          const floats = this._packBucket(this._addIdx, this._addN, this._addData, camX, camY, camZ);
          gl.bindBuffer(gl.ARRAY_BUFFER, this._addBuffer);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._addData, 0, floats);
        } else if (this._addN > 0) {
          this._addN = 0;
        }
        this._packedFrame = frameIndex;
      }

      if (this._alphaN === 0 && this._addN === 0) return;

      const albedo = this._resolveAlbedo(gbufferOrForward);
      const depthTex = this._resolveDepth(gbufferOrForward);
      const soft = this._softEnabled && !!depthTex;

      program.use();
      program.bindUBO('Frame', FRAME_BINDING);
      program.setVec3('u_origin', this._origin[0], this._origin[1], this._origin[2]);
      program.setFloat('u_stretch', this.stretch);
      program.setFloat('u_softDistance', this.softDistance);
      program.setFloat('u_chipScale', CHIP_UV_SCALE);
      program.setFloat('u_fadeNear', this.nearFade);
      program.setInt('u_soft', soft ? 1 : 0);
      program.setInt('u_hasAlbedo', albedo ? 1 : 0);
      program.setTexture('u_albedoArray', albedo, UNIT_ALBEDO_ARRAY, gl.TEXTURE_2D_ARRAY);
      program.setTexture('u_gDepth', depthTex, UNIT_DEPTH, gl.TEXTURE_2D);

      device.setDepthTest(true);
      device.setDepthWrite(false);
      device.setDepthFunc(gl.LEQUAL);
      device.setCull('none');
      device.setColorMask(true, true, true, true);

      if (this._alphaN > 0 && this._alphaVAO) {
        program.setFloat('u_premultiply', 0);
        device.setBlend('alpha');
        device.bindVertexArray(this._alphaVAO);
        gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this._alphaN);
      }
      if (this._addN > 0 && this._addVAO) {
        program.setFloat('u_premultiply', 1);
        device.setBlend('add');
        device.bindVertexArray(this._addVAO);
        gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this._addN);
      }

      device.bindVertexArray(null);
      device.setBlend('none');
      device.setDepthWrite(true);
    } catch (err) {
      this._reportFailure(err);
    }
  }

  /**
   * Resolve the block albedo texture array (unit 0).
   * @param {*} src the object handed to {@link ParticleSystem#render}
   * @returns {?WebGLTexture} the array texture, or null
   * @private
   */
  _resolveAlbedo(src) {
    if (isTexture(this._albedoOverride)) return this._albedoOverride;
    if (this._textures && isTexture(this._textures.albedoArray)) return this._textures.albedoArray;
    if (src && isTexture(src.albedoArray)) return src.albedoArray;
    if (src && src.textures && isTexture(src.textures.albedoArray)) return src.textures.albedoArray;
    return null;
  }

  /**
   * Resolve the sampled scene depth texture (unit 7).
   * @param {*} src the object handed to {@link ParticleSystem#render}
   * @returns {?WebGLTexture} the depth texture, or null
   * @private
   */
  _resolveDepth(src) {
    if (isTexture(this._depthOverride)) return this._depthOverride;
    if (!src) return null;
    if (isTexture(src.depth)) return src.depth;
    if (isTexture(src.depthTexture)) return src.depthTexture;
    if (isTexture(src.gDepth)) return src.gDepth;
    if (src.framebuffer && isTexture(src.framebuffer.depth)) return src.framebuffer.depth;
    return null;
  }

  /* ======================================================================== */
  /* Wiring                                                                   */
  /* ======================================================================== */

  /**
   * Supply the `TextureManager` whose `albedoArray` break chips sample.
   * The manager is queried every frame, so `regenerate()` is picked up for free.
   * @param {?Object} textures a `TextureManager` (5.16), or null
   * @returns {void}
   */
  setTextureManager(textures) {
    this._textures = textures || null;
  }

  /**
   * Bind an explicit block albedo array, overriding the texture manager.
   * @param {?WebGLTexture} texture a `TEXTURE_2D_ARRAY`, or null to clear
   * @returns {void}
   */
  setAlbedoArray(texture) {
    this._albedoOverride = isTexture(texture) ? texture : null;
  }

  /**
   * Bind the scene depth texture used by the soft-particle fade.
   *
   * Pass a texture that is **not** the depth attachment of the framebuffer the
   * particles draw into unless you rely on the depth-write-disabled feedback
   * carve-out; particles never write depth, so that is the normal case. Pass
   * `null` to turn the soft fade off.
   *
   * @param {?WebGLTexture} texture depth texture, or null
   * @returns {void}
   */
  setDepthTexture(texture) {
    this._depthOverride = isTexture(texture) ? texture : null;
  }

  /**
   * Record the render target size. The system owns no sized GPU resources, so
   * this only keeps the reported dimensions in sync.
   * @param {number} w width in pixels
   * @param {number} h height in pixels
   * @returns {void}
   */
  resize(w, h) {
    this.width = Math.max(1, w | 0);
    this.height = Math.max(1, h | 0);
  }

  /**
   * Live particle count.
   * @returns {number} number of simulated particles
   */
  get count() {
    return this._count;
  }

  /**
   * Instances issued by the last {@link ParticleSystem#render}, per bucket.
   * @returns {{alpha:number, additive:number, weather:number, capacity:number}} stats
   */
  get stats() {
    return {
      alpha: this._alphaN,
      additive: this._addN,
      weather: this._weatherCount,
      capacity: this.capacity,
    };
  }

  /**
   * Kill every particle and reset the free list.
   * @returns {void}
   */
  clear() {
    const cap = this.capacity;
    this._count = 0;
    this._top = 0;
    this._weatherCount = 0;
    this._weatherKind = 0;
    this._alphaN = 0;
    this._addN = 0;
    this._packedFrame = -1;
    this._lightning = 0;
    if (!cap || !this._freeList) {
      this._freeTop = 0;
      return;
    }
    this.alive.fill(0);
    this.flags.fill(0);
    for (let i = 0; i < cap; i++) this._freeList[i] = cap - 1 - i;
    this._freeTop = cap;
  }

  /**
   * Release every GPU resource and detach the settings listener.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const gl = this.device ? this.device.gl : null;

    if (this.settings && this._onSettingsChange && typeof this.settings.off === 'function') {
      try { this.settings.off('change', this._onSettingsChange); } catch (err) { /* gone */ }
    }
    this._onSettingsChange = null;

    try {
      if (this._program && typeof this._program.dispose === 'function') this._program.dispose();
    } catch (err) { /* already gone */ }
    this._program = null;

    if (gl) {
      try {
        this.device.bindVertexArray(null);
        if (this._alphaVAO) gl.deleteVertexArray(this._alphaVAO);
        if (this._addVAO) gl.deleteVertexArray(this._addVAO);
        if (this._alphaBuffer) gl.deleteBuffer(this._alphaBuffer);
        if (this._addBuffer) gl.deleteBuffer(this._addBuffer);
        if (this._quadBuffer) gl.deleteBuffer(this._quadBuffer);
        if (this._indexBuffer) gl.deleteBuffer(this._indexBuffer);
      } catch (err) { /* context lost */ }
    }
    this._alphaVAO = null;
    this._addVAO = null;
    this._alphaBuffer = null;
    this._addBuffer = null;
    this._quadBuffer = null;
    this._indexBuffer = null;
    this._alphaData = new Float32Array(0);
    this._addData = new Float32Array(0);
    this._alphaCap = 0;
    this._addCap = 0;

    this._world = null;
    this._textures = null;
    this._albedoOverride = null;
    this._depthOverride = null;
    this._count = 0;
    this._top = 0;
    this._freeTop = 0;
    this._weatherCount = 0;
  }
}

export default ParticleSystem;
