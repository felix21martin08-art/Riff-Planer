/**
 * @file game/environment.js — VOXELIA world clock, sky driver and weather (spec 5.37).
 *
 * The environment is the single source of truth for *when* and *what weather*
 * the world is in. It owns three things:
 *
 *  1. **The clock.** A full day is {@link DAY_LENGTH_SECONDS} (1200 s = 20 real
 *     minutes) or {@link DAY_TICKS} (24000) game ticks. `timeOfDay` runs `0..1`
 *     with `0` = sunrise, `0.25` = noon, `0.5` = sunset, `0.75` = midnight.
 *     From it come `sunDir` / `moonDir` on a tilted arc (the sun never passes
 *     exactly through the zenith) and an eight-day moon phase cycle.
 *
 *  2. **The lighting values the renderer reads.** `render/sky.js`,
 *     `render/renderer.js`, `render/lightingpass.js`, `render/water.js` and
 *     `render/particles.js` probe a fixed set of properties on this object
 *     every frame — `sunColor`, `sunIntensity`, `skyAmbient`, `groundColor`,
 *     `fogColor`, `biomeFogColor`, `fogDensity`, `rainStrength`,
 *     `thunderStrength`, `moonPhase`, `latitude`, `aurora`, `auroraIntensity`,
 *     `seaLevel`, `weather`, `dayCount`, `grassColor`, `windStrength`. All of
 *     them are recomputed here once per game tick, into **reused**
 *     `Float32Array`s, so the render path never allocates and never has to
 *     guess a fallback.
 *
 *  3. **The weather state machine.** `clear -> rain -> thunder -> clear` with
 *     plausible durations, ramped with smooth `0..1` transitions instead of
 *     instant switches. Rain becomes snow wherever the biome under the player
 *     is cold enough, and thunder throws real lightning strikes that emit an
 *     event (flash + sound + optional fire).
 *
 * Nothing in this file is tied to the frame rate: `update(dt, player, world)`
 * integrates whatever `dt` it is handed and is meant to run inside the fixed
 * 20 TPS tick. It never throws — a bad world, a missing player or a broken
 * biome lookup degrades to the last good value and is logged once.
 *
 * @module game/environment
 */

import { EventBus } from '../core/util.js';
import { clamp, lerp, smoothstep, damp, mulberry32 } from '../core/math.js';
import { SEA_LEVEL } from '../world/chunk.js';
import {
  biomeFogColor,
  biomeGrassColor,
  biomePrecipitationAt,
  biomeTemperatureAt,
} from '../world/biomes.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Length of one full day/night cycle in seconds. @type {number} */
export const DAY_LENGTH_SECONDS = 1200;

/** Length of one full day/night cycle in game ticks. @type {number} */
export const DAY_TICKS = 24000;

/** Game ticks per second — the fixed logic rate of the whole engine. @type {number} */
export const TICKS_PER_SECOND = DAY_TICKS / DAY_LENGTH_SECONDS;

/** Number of distinct moon phases; the cycle repeats every 8 in-game days. @type {number} */
export const MOON_PHASE_COUNT = 8;

/**
 * Weather states. `snow` is not a state of the machine — it is what `rain`
 * renders as in a cold biome — but it is a valid value of `weather` and a valid
 * argument to {@link Environment#setWeather}.
 * @type {Readonly<{CLEAR:string, RAIN:string, THUNDER:string, SNOW:string}>}
 */
export const WEATHER = Object.freeze({
  CLEAR: 'clear', RAIN: 'rain', THUNDER: 'thunder', SNOW: 'snow',
});

/**
 * German labels for the four weather values, for the debug overlay and the HUD.
 * @type {Readonly<Object<string, string>>}
 */
export const WEATHER_LABELS = Object.freeze({
  clear: 'Klar',
  rain: 'Regen',
  thunder: 'Gewitter',
  snow: 'Schnee',
});

/**
 * German labels for the four coarse parts of the day, used by the debug
 * overlay and the ambience selector in `game/audio.js`.
 * @type {Readonly<Object<string, string>>}
 */
export const PHASE_LABELS = Object.freeze({
  morning: 'Morgen',
  day: 'Tag',
  evening: 'Abend',
  night: 'Nacht',
});

/** Inclusive `[min, max]` duration of a clear spell, in seconds. @type {Readonly<number[]>} */
export const CLEAR_DURATION = Object.freeze([300, 1200]);

/** Inclusive `[min, max]` duration of a rain spell, in seconds. @type {Readonly<number[]>} */
export const RAIN_DURATION = Object.freeze([300, 900]);

/** Inclusive `[min, max]` duration of a thunderstorm, in seconds. @type {Readonly<number[]>} */
export const THUNDER_DURATION = Object.freeze([60, 180]);

/** Chance that a rain spell escalates into a thunderstorm instead of clearing. @type {number} */
export const THUNDER_CHANCE = 0.35;

/** Seconds a weather transition takes to ramp from 0 to 1. @type {number} */
export const WEATHER_FADE = 6;

/** Expected lightning strikes per second at full thunder strength. @type {number} */
export const LIGHTNING_RATE = 0.09;

/** Closest a lightning bolt may strike to the player, in blocks. @type {number} */
export const LIGHTNING_MIN_DISTANCE = 18;

/** Furthest a lightning bolt may strike from the player, in blocks. @type {number} */
export const LIGHTNING_MAX_DISTANCE = 110;

/** Chance that a bolt sets its impact point on fire (needs a fire block). @type {number} */
export const LIGHTNING_FIRE_CHANCE = 0.22;

/** Peak HDR intensity of the sun at noon under a clear sky. @type {number} */
const SUN_PEAK = 3.2;

/** Peak HDR intensity of full moonlight — deliberately tiny. @type {number} */
const MOON_PEAK = 0.055;

/** Sun tint with the sun high in the sky (linear rgb). @type {Readonly<number[]>} */
const SUN_TINT_DAY = Object.freeze([1.0, 0.975, 0.94]);

/** Sun tint on the horizon (linear rgb) — the sunrise/sunset red. @type {Readonly<number[]>} */
const SUN_TINT_HORIZON = Object.freeze([1.0, 0.42, 0.16]);

/** Key-light tint at night, i.e. moonlight (linear rgb). @type {Readonly<number[]>} */
const SUN_TINT_NIGHT = Object.freeze([0.46, 0.60, 1.0]);

/** Hemispheric sky ambient at noon (linear rgb). @type {Readonly<number[]>} */
const SKY_AMBIENT_DAY = Object.freeze([0.200, 0.340, 0.520]);

/** Hemispheric sky ambient at twilight (linear rgb). @type {Readonly<number[]>} */
const SKY_AMBIENT_DUSK = Object.freeze([0.185, 0.115, 0.105]);

/** Hemispheric sky ambient on a moonless night (linear rgb). @type {Readonly<number[]>} */
const SKY_AMBIENT_NIGHT = Object.freeze([0.0090, 0.0130, 0.0320]);

/** Extra ambient contributed by a full moon (linear rgb). @type {Readonly<number[]>} */
const SKY_AMBIENT_MOON = Object.freeze([0.0130, 0.0180, 0.0400]);

/** Distance fog at noon (linear rgb). @type {Readonly<number[]>} */
const FOG_DAY = Object.freeze([0.550, 0.660, 0.820]);

/** Distance fog at twilight (linear rgb). @type {Readonly<number[]>} */
const FOG_DUSK = Object.freeze([0.560, 0.360, 0.280]);

/** Distance fog at night (linear rgb). @type {Readonly<number[]>} */
const FOG_NIGHT = Object.freeze([0.0180, 0.0260, 0.0560]);

/** Fallback grass tint when no world or biome is available (linear rgb). @type {Readonly<number[]>} */
const GRASS_FALLBACK = Object.freeze([0.216, 0.404, 0.145]);

/** Fallback biome fog tint (linear rgb). @type {Readonly<number[]>} */
const BIOME_FOG_FALLBACK = Object.freeze([0.470, 0.600, 0.780]);

/** Temperature below which precipitation falls as snow (matches `world/biomes.js`). @type {number} */
const SNOW_TEMPERATURE = 0.15;

/** How fast the biome-driven colours follow the player across a border, in 1/s. @type {number} */
const BIOME_BLEND_RATE = 1.6;

/** Seconds between two biome samples under the player. @type {number} */
const BIOME_SAMPLE_INTERVAL = 0.25;

/** Luminance weights (Rec. 709) used when greying colours out under rain. @type {Readonly<number[]>} */
const LUMA = Object.freeze([0.2126729, 0.7151522, 0.0721750]);

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/** Names already reported by {@link warnOnce}. @type {Set<string>} */
const warned = new Set();

/**
 * Log a problem exactly once per key. The environment runs inside the game
 * tick, so a broken world must never spam the console or throw.
 * @param {string} key de-duplication key
 * @param {string} message human readable message
 * @param {*} [err] the original error, if any
 * @returns {void}
 */
function warnOnce(key, message, err) {
  if (warned.has(key)) return;
  warned.add(key);
  if (err !== undefined) console.warn(`[VOXELIA] environment: ${message}`, err);
  else console.warn(`[VOXELIA] environment: ${message}`);
}

/**
 * Coerce anything into a finite number.
 * @param {*} v candidate value
 * @param {number} fallback value to use when `v` is not finite
 * @returns {number} a finite number
 */
function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Positive fractional part, so a negative time still wraps correctly.
 * @param {number} v any number
 * @returns {number} `v - floor(v)`, always in `[0, 1)`
 */
function fract(v) {
  return v - Math.floor(v);
}

/**
 * Read `[x, y, z]` out of anything array-like.
 * @param {*} v candidate
 * @param {number} i component index
 * @param {number} fallback value when the component is missing
 * @returns {number} the component
 */
function comp(v, i, fallback) {
  if (v === null || v === undefined) return fallback;
  const c = v[i];
  return Number.isFinite(c) ? c : fallback;
}

/**
 * Write `a * (1 - t) + b * t` into a target triple.
 * @param {Float32Array} out receiver
 * @param {ArrayLike<number>} a first colour
 * @param {ArrayLike<number>} b second colour
 * @param {number} t blend factor
 * @returns {Float32Array} `out`
 */
function mix3(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/**
 * Add `b * scale` onto a triple.
 * @param {Float32Array} out receiver, modified in place
 * @param {ArrayLike<number>} b colour to add
 * @param {number} scale scale applied to `b`
 * @returns {Float32Array} `out`
 */
function addScaled3(out, b, scale) {
  out[0] += b[0] * scale;
  out[1] += b[1] * scale;
  out[2] += b[2] * scale;
  return out;
}

/**
 * Pull a triple toward its own luminance and dim it — what rain does to every
 * colour in the frame.
 * @param {Float32Array} out colour, modified in place
 * @param {number} grey how far to desaturate, `0..1`
 * @param {number} dim multiplicative brightness, `0..1`
 * @returns {Float32Array} `out`
 */
function greyOut(out, grey, dim) {
  const lum = LUMA[0] * out[0] + LUMA[1] * out[1] + LUMA[2] * out[2];
  out[0] = lerp(out[0], lum * 0.94, grey) * dim;
  out[1] = lerp(out[1], lum * 0.98, grey) * dim;
  out[2] = lerp(out[2], lum * 1.06, grey) * dim;
  return out;
}

/**
 * Normalize a vector in place, falling back to a default direction.
 * @param {Float32Array} v vector to normalize
 * @param {number} fx fallback X
 * @param {number} fy fallback Y
 * @param {number} fz fallback Z
 * @returns {Float32Array} `v`
 */
function normalize3(v, fx, fy, fz) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len > 1e-6) {
    const inv = 1 / len;
    v[0] *= inv; v[1] *= inv; v[2] *= inv;
  } else {
    v[0] = fx; v[1] = fy; v[2] = fz;
  }
  return v;
}

/* ========================================================================== */
/* Environment                                                                */
/* ========================================================================== */

/**
 * The world's clock, sky state and weather machine.
 *
 * Emitted events:
 * - `'weather'` `(weather, previous)` — whenever the machine changes state.
 * - `'lightning'` `(x, y, z, strength)` — a bolt struck; the game turns this
 *   into a flash, a thunder clap and (optionally) a fire.
 * - `'newDay'` `(dayCount)` — the clock wrapped past sunrise.
 * - `'day'` / `'night'` — sunrise and nightfall, for music and mob logic.
 * - `'time'` `(timeOfDay)` — after {@link Environment#setTime} was called.
 *
 * @augments EventBus
 */
export class Environment extends EventBus {
  /**
   * @param {?Object} settings settings instance (`core/settings.js`); only
   *   `renderDistance` is read, and only to scale the fog density
   * @param {number} [seed] world seed; drives the latitude, the moon phase
   *   offset and every weather roll so a world always has the same climate
   */
  constructor(settings, seed = 0) {
    super();

    /** @type {?Object} settings instance, may be null */
    this.settings = settings || null;

    /** @type {number} world seed (uint32) */
    this.seed = (Number.isFinite(seed) ? seed : 0) >>> 0;

    /** @type {() => number} deterministic 0..1 generator for every weather roll */
    this._rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);

    /* ---- clock ---------------------------------------------------------- */

    /** @type {number} total elapsed game ticks since the world was created */
    this.ticks = 0;
    /** @type {number} fractional tick carry, so `dt` never quantises the clock */
    this._tickCarry = 0;
    /** @type {number} position inside the current day, `0..1` (`0` = sunrise) */
    this.timeOfDay = 0;
    /** @type {number} completed in-game days */
    this.dayCount = 0;
    /** @type {number} seconds of world time; the render frame uses the same scale */
    this.time = 0;
    /** @type {boolean} `true` freezes the clock (the `doDaylightCycle` rule) */
    this.frozen = false;

    /* ---- celestial ------------------------------------------------------ */

    /**
     * Latitude of this world in degrees. Derived from the seed, kept in a band
     * that produces a believable solar arc and lets `render/sky.js` decide
     * whether aurorae are possible at all.
     * @type {number}
     */
    this.latitude = 34 + this._rng() * 34;

    /** @type {number} tilt of the solar arc in radians, derived from the latitude */
    this._tilt = clamp(this.latitude, 0, 80) * (Math.PI / 180) * 0.62;

    /** @type {number} whole-day offset of the moon cycle, from the seed */
    this._moonOffset = Math.floor(this._rng() * MOON_PHASE_COUNT);

    /** @type {Float32Array} unit vector pointing **toward** the sun */
    this.sunDir = new Float32Array([1, 0, 0]);
    /** @type {Float32Array} unit vector pointing **toward** the moon */
    this.moonDir = new Float32Array([-1, 0, 0]);
    /** @type {number} moon phase `0..7`; `0` is full moon, `4` is new moon */
    this.moonPhase = 0;
    /** @type {number} lit fraction of the moon disk, `0..1` */
    this.moonIllumination = 1;

    /* ---- weather -------------------------------------------------------- */

    /**
     * The state the machine is actually in: `'clear'`, `'rain'` or
     * `'thunder'`. {@link Environment#weather} additionally reports `'snow'`
     * when the biome under the player is cold.
     * @type {string}
     */
    this.weatherState = WEATHER.CLEAR;
    /** @type {string} `'clear'|'rain'|'thunder'|'snow'` — what the renderer draws */
    this.weather = WEATHER.CLEAR;
    /** @type {number} seconds left in the current weather state */
    this.weatherTimer = this._rollDuration(CLEAR_DURATION);
    /** @type {number} smooth rain amount, `0..1` */
    this.rainStrength = 0;
    /** @type {number} smooth thunder amount, `0..1` */
    this.thunderStrength = 0;
    /** @type {number} smooth snow amount, `0..1` (a subset of `rainStrength`) */
    this.snowStrength = 0;
    /** @type {boolean} `true` when the local precipitation falls as snow */
    this.snowing = false;
    /** @type {number} wind strength `0..1`; `render/water.js` reads this */
    this.windStrength = 0.25;
    /** @type {number} alias of {@link Environment#windStrength} */
    this.wind = 0.25;
    /** @type {number} seconds since the last lightning bolt */
    this.timeSinceLightning = 0;

    /* ---- derived render values ------------------------------------------ */

    /** @type {Float32Array} linear sun/moon key-light tint (peak ≈ 1) */
    this.sunColor = new Float32Array([1, 0.975, 0.94]);
    /** @type {number} HDR magnitude of the key light; near zero at night */
    this.sunIntensity = 0;
    /** @type {Float32Array} linear hemispheric sky ambient */
    this.skyAmbient = new Float32Array(SKY_AMBIENT_NIGHT);
    /** @type {Float32Array} linear albedo of the ground for the ambient bounce */
    this.groundColor = new Float32Array([0.12, 0.16, 0.09]);
    /** @type {Float32Array} linear distance-fog colour */
    this.fogColor = new Float32Array(FOG_NIGHT);
    /** @type {Float32Array} linear biome-tinted fog colour */
    this.biomeFogColor = new Float32Array(BIOME_FOG_FALLBACK);
    /** @type {number} exponential fog density per block */
    this.fogDensity = 0.008;
    /** @type {Float32Array} linear grass tint of the biome under the player */
    this.grassColor = new Float32Array(GRASS_FALLBACK);
    /** @type {number} aurora strength `0..1` */
    this.aurora = 0;
    /** @type {number} alias of {@link Environment#aurora} that `render/sky.js` reads first */
    this.auroraIntensity = 0;
    /** @type {number} world sea level, mirrored for the render passes */
    this.seaLevel = SEA_LEVEL;

    /* ---- biome sampling ------------------------------------------------- */

    /** @type {number} biome id under the player */
    this.biome = 0;
    /** @type {number} effective temperature under the player */
    this.temperature = 0.8;
    /** @type {number} seconds until the next biome sample */
    this._biomeTimer = 0;
    /** @type {Float32Array} unsmoothed biome grass tint */
    this._targetGrass = new Float32Array(GRASS_FALLBACK);
    /** @type {Float32Array} unsmoothed biome fog tint */
    this._targetBiomeFog = new Float32Array(BIOME_FOG_FALLBACK);
    /** @type {Float32Array} smoothed biome fog tint, before the time-of-day gate */
    this._biomeFogBase = new Float32Array(BIOME_FOG_FALLBACK);

    /* ---- scratch (never allocate in the tick) --------------------------- */

    /** @type {Float32Array} scratch triple used while blending the key-light tint */
    this._scratchA = new Float32Array(3);
    /** @type {number[]} scratch position of the player */
    this._playerPos = [0, SEA_LEVEL, 0];

    /** @type {boolean} whether the last tick saw daylight, for the day/night events */
    this._wasDay = true;

    /** @type {number} cached `renderDistance` used for the fog density */
    this._renderDistance = 10;

    // Fill every derived value once so the very first frame is already correct.
    this._updateCelestial();
    this._updateColors();
  }

  /* ====================================================================== */
  /* Settings                                                               */
  /* ====================================================================== */

  /**
   * Read a setting with a fallback; never throws.
   * @param {string} key setting key
   * @param {*} fallback value when the setting is missing
   * @returns {*} the setting value
   * @private
   */
  _setting(key, fallback) {
    const s = this.settings;
    if (!s || typeof s.get !== 'function') return fallback;
    try {
      const v = s.get(key);
      return v === undefined || v === null ? fallback : v;
    } catch (err) {
      warnOnce(`setting:${key}`, `settings.get("${key}") failed`, err);
      return fallback;
    }
  }

  /* ====================================================================== */
  /* Tick                                                                   */
  /* ====================================================================== */

  /**
   * Advance the clock, the weather and every derived render value.
   *
   * Call once per fixed game tick. Safe to call with a null player or a null
   * world — the biome-driven colours then simply keep their last value.
   *
   * @param {number} dt seconds since the previous tick
   * @param {?Object} player the local player (`game/player.js`), or null
   * @param {?Object} world the chunk manager (`world/world.js`), or null
   * @returns {void}
   */
  update(dt, player, world) {
    const step = clamp(num(dt, 0), 0, 0.25);
    if (step <= 0) return;

    try {
      this._readPlayer(player);
      this._advanceClock(step);
      this._sampleBiome(step, world);
      this._updateWeather(step, player, world);
      this._updateCelestial();
      this._updateColors();
    } catch (err) {
      warnOnce('update', 'the environment tick failed; state is frozen', err);
    }
  }

  /**
   * Cache the player position used by the biome sample and by lightning.
   * @param {?Object} player the player
   * @returns {void}
   * @private
   */
  _readPlayer(player) {
    const p = player && player.position ? player.position : null;
    if (p === null) return;
    this._playerPos[0] = comp(p, 0, this._playerPos[0]);
    this._playerPos[1] = comp(p, 1, this._playerPos[1]);
    this._playerPos[2] = comp(p, 2, this._playerPos[2]);
  }

  /**
   * Move the clock forward and raise the day/night events.
   * @param {number} dt seconds
   * @returns {void}
   * @private
   */
  _advanceClock(dt) {
    this.time += dt;
    if (this.frozen) return;

    const advance = dt * TICKS_PER_SECOND + this._tickCarry;
    const whole = Math.floor(advance);
    this._tickCarry = advance - whole;
    this.ticks += whole;

    const previousDay = this.dayCount;
    const total = (this.ticks + this._tickCarry) / DAY_TICKS;
    this.dayCount = Math.floor(total);
    this.timeOfDay = fract(total);

    if (this.dayCount !== previousDay) this.emit('newDay', this.dayCount);

    const day = this.isDay();
    if (day !== this._wasDay) {
      this._wasDay = day;
      this.emit(day ? 'day' : 'night');
    }
  }

  /* ====================================================================== */
  /* Biome sampling                                                         */
  /* ====================================================================== */

  /**
   * Re-read the biome under the player every {@link BIOME_SAMPLE_INTERVAL} and
   * ease the biome-driven colours toward it so a border crossing does not pop.
   * @param {number} dt seconds
   * @param {?Object} world the world
   * @returns {void}
   * @private
   */
  _sampleBiome(dt, world) {
    this._biomeTimer -= dt;
    if (this._biomeTimer <= 0) {
      this._biomeTimer = BIOME_SAMPLE_INTERVAL;
      this._resampleBiome(world);
    }
    const rate = BIOME_BLEND_RATE;
    for (let c = 0; c < 3; c++) {
      this.grassColor[c] = damp(this.grassColor[c], this._targetGrass[c], rate, dt);
      this._biomeFogBase[c] = damp(this._biomeFogBase[c], this._targetBiomeFog[c], rate, dt);
    }
  }

  /**
   * Look up the biome under the player and refresh the colour targets.
   * @param {?Object} world the world
   * @returns {void}
   * @private
   */
  _resampleBiome(world) {
    if (!world || typeof world.getBiome !== 'function') return;
    const x = Math.floor(this._playerPos[0]);
    const y = Math.floor(this._playerPos[1]);
    const z = Math.floor(this._playerPos[2]);
    let id = this.biome;
    try {
      id = world.getBiome(x, z) | 0;
    } catch (err) {
      warnOnce('biome', 'world.getBiome failed; keeping the previous biome', err);
      return;
    }
    this.biome = id;

    try {
      this.temperature = biomeTemperatureAt(id, y);
      const grass = biomeGrassColor(id);
      const fog = biomeFogColor(id);
      this._targetGrass[0] = comp(grass, 0, GRASS_FALLBACK[0]);
      this._targetGrass[1] = comp(grass, 1, GRASS_FALLBACK[1]);
      this._targetGrass[2] = comp(grass, 2, GRASS_FALLBACK[2]);
      this._targetBiomeFog[0] = comp(fog, 0, BIOME_FOG_FALLBACK[0]);
      this._targetBiomeFog[1] = comp(fog, 1, BIOME_FOG_FALLBACK[1]);
      this._targetBiomeFog[2] = comp(fog, 2, BIOME_FOG_FALLBACK[2]);
      this.snowing = biomePrecipitationAt(id, y) === 'snow';
    } catch (err) {
      warnOnce('biomeTint', 'a biome lookup failed; keeping the previous tints', err);
    }
  }

  /* ====================================================================== */
  /* Weather                                                                */
  /* ====================================================================== */

  /**
   * Pick a duration inside an inclusive `[min, max]` band.
   * @param {ArrayLike<number>} band the band
   * @returns {number} seconds
   * @private
   */
  _rollDuration(band) {
    return band[0] + this._rng() * (band[1] - band[0]);
  }

  /**
   * Run the weather state machine and ramp `rainStrength` / `thunderStrength`
   * toward their targets.
   * @param {number} dt seconds
   * @param {?Object} player the player
   * @param {?Object} world the world
   * @returns {void}
   * @private
   */
  _updateWeather(dt, player, world) {
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) this._advanceWeatherState();

    /* ---- smooth transitions --------------------------------------------- */
    const rainTarget = this.weatherState === WEATHER.CLEAR ? 0 : 1;
    const thunderTarget = this.weatherState === WEATHER.THUNDER ? 1 : 0;
    const rate = dt / WEATHER_FADE;

    this.rainStrength = this._approach(this.rainStrength, rainTarget, rate);
    this.thunderStrength = this._approach(this.thunderStrength, thunderTarget, rate);

    /* ---- snow vs. rain --------------------------------------------------- */
    const cold = this.snowing || this.temperature < SNOW_TEMPERATURE;
    const snowTarget = cold ? this.rainStrength : 0;
    this.snowStrength = this._approach(this.snowStrength, snowTarget, rate * 1.5);

    if (this.rainStrength <= 0.001 && this.weatherState === WEATHER.CLEAR) {
      this.weather = WEATHER.CLEAR;
    } else if (cold) {
      this.weather = WEATHER.SNOW;
    } else {
      this.weather = this.weatherState;
    }

    /* ---- wind ------------------------------------------------------------ */
    const gust = 0.5 + 0.5 * Math.sin(this.time * 0.083) * Math.cos(this.time * 0.031 + 1.4);
    this.windStrength = clamp(0.12 + 0.24 * gust + 0.62 * this.rainStrength, 0, 1);
    this.wind = this.windStrength;

    /* ---- lightning -------------------------------------------------------- */
    this.timeSinceLightning += dt;
    if (this.thunderStrength > 0.15) this._maybeStrike(dt, player, world);
  }

  /**
   * Move a value toward a target by at most `step`, without overshooting.
   * @param {number} current current value
   * @param {number} target target value
   * @param {number} step maximum change this tick
   * @returns {number} the new value
   * @private
   */
  _approach(current, target, step) {
    if (current < target) return Math.min(target, current + step);
    if (current > target) return Math.max(target, current - step);
    return target;
  }

  /**
   * Choose the next weather state: `clear -> rain -> (thunder ->) clear`.
   * @returns {void}
   * @private
   */
  _advanceWeatherState() {
    const previous = this.weatherState;
    if (previous === WEATHER.CLEAR) {
      this.weatherState = WEATHER.RAIN;
      this.weatherTimer = this._rollDuration(RAIN_DURATION);
    } else if (previous === WEATHER.RAIN) {
      if (this._rng() < THUNDER_CHANCE) {
        this.weatherState = WEATHER.THUNDER;
        this.weatherTimer = this._rollDuration(THUNDER_DURATION);
      } else {
        this.weatherState = WEATHER.CLEAR;
        this.weatherTimer = this._rollDuration(CLEAR_DURATION);
      }
    } else {
      // A storm always rains itself out for a short while before it clears.
      this.weatherState = WEATHER.RAIN;
      this.weatherTimer = RAIN_DURATION[0] * 0.25 + this._rng() * RAIN_DURATION[0] * 0.5;
    }
    if (this.weatherState !== previous) this.emit('weather', this.weatherState, previous);
  }

  /**
   * Roll for a lightning strike and, on a hit, resolve where it lands.
   * @param {number} dt seconds
   * @param {?Object} player the player
   * @param {?Object} world the world
   * @returns {void}
   * @private
   */
  _maybeStrike(dt, player, world) {
    const chance = dt * LIGHTNING_RATE * this.thunderStrength;
    if (this._rng() >= chance) return;
    void player;

    const angle = this._rng() * Math.PI * 2;
    const span = LIGHTNING_MAX_DISTANCE - LIGHTNING_MIN_DISTANCE;
    const dist = LIGHTNING_MIN_DISTANCE + this._rng() * span;
    const x = Math.floor(this._playerPos[0] + Math.cos(angle) * dist);
    const z = Math.floor(this._playerPos[2] + Math.sin(angle) * dist);
    let y = Math.floor(this._playerPos[1]);
    if (world && typeof world.getHeight === 'function') {
      try {
        y = world.getHeight(x, z) | 0;
      } catch (err) {
        warnOnce('strikeHeight', 'world.getHeight failed while placing a bolt', err);
      }
    }
    this.strikeLightning(x + 0.5, y, z + 0.5);
  }

  /**
   * Fire a lightning bolt at a world position: raise the `'lightning'` event
   * and reset the strike timer. The game turns the event into the flash, the
   * thunder clap, the fire and any entity damage.
   *
   * @param {number} x world X of the impact point
   * @param {number} y world Y of the impact point
   * @param {number} z world Z of the impact point
   * @param {number} [strength] bolt strength `0..1`; defaults to the storm
   * @returns {{x:number, y:number, z:number, strength:number, fire:boolean}}
   *   a description of the bolt (also the event payload)
   */
  strikeLightning(x, y, z, strength = -1) {
    const s = strength >= 0
      ? clamp(strength, 0, 1)
      : clamp(0.55 + 0.45 * this.thunderStrength, 0, 1);
    const bolt = {
      x: num(x, this._playerPos[0]),
      y: num(y, this._playerPos[1]),
      z: num(z, this._playerPos[2]),
      strength: s,
      fire: this._rng() < LIGHTNING_FIRE_CHANCE,
    };
    this.timeSinceLightning = 0;
    this.emit('lightning', bolt.x, bolt.y, bolt.z, bolt.strength, bolt.fire);
    return bolt;
  }

  /* ====================================================================== */
  /* Celestial bodies                                                       */
  /* ====================================================================== */

  /**
   * Recompute `sunDir`, `moonDir`, `moonPhase` and the moon illumination from
   * `timeOfDay` and `dayCount`.
   *
   * The arc is tilted by the world's latitude, so the sun sweeps a plausible
   * inclined path and never passes exactly through the zenith. Phase `0` is a
   * full moon (opposite the sun), phase `4` a new moon (with the sun) — the
   * same convention `render/sky.js` decodes.
   *
   * @returns {void}
   * @private
   */
  _updateCelestial() {
    const a = this.timeOfDay * Math.PI * 2;
    const ct = Math.cos(this._tilt);
    const st = Math.sin(this._tilt);

    this.sunDir[0] = Math.cos(a);
    this.sunDir[1] = Math.sin(a) * ct;
    this.sunDir[2] = Math.sin(a) * st;
    normalize3(this.sunDir, 1, 0, 0);

    this.moonPhase = (this.dayCount + this._moonOffset) % MOON_PHASE_COUNT;
    const phase = this.moonPhase / MOON_PHASE_COUNT;

    // A full moon rides exactly opposite the sun; every phase step shifts the
    // moon another eighth of a turn along the same arc, so a new moon rises
    // and sets with the sun.
    const am = a + Math.PI + phase * Math.PI * 2;
    this.moonDir[0] = Math.cos(am);
    this.moonDir[1] = Math.sin(am) * ct;
    this.moonDir[2] = Math.sin(am) * st;
    normalize3(this.moonDir, -1, 0, 0);

    this.moonIllumination = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2);
  }

  /* ====================================================================== */
  /* Derived render values                                                  */
  /* ====================================================================== */

  /**
   * Recompute every colour and scalar the render pipeline reads. Allocation
   * free: everything lands in the `Float32Array`s created by the constructor.
   * @returns {void}
   * @private
   */
  _updateColors() {
    const h = this.sunDir[1];
    const rain = this.rainStrength;
    const thunder = this.thunderStrength;
    const snow = this.snowStrength;

    /* ---- day / twilight / night weights ---------------------------------- */
    // Three different ramps, because they answer three different questions:
    //   sunGate  — how much direct sunlight reaches the ground (matches the
    //              gate `render/sky.js` uses, so both agree on "the sun is up")
    //   dayLevel — how "daylit" the whole scene reads, for ambient and fog
    //   lit      — whether the key light is still the sun or already the moon
    // `twilight` is a bell centred on the horizon crossing.
    const sunGate = smoothstep(-0.055, 0.075, h);
    const dayLevel = smoothstep(-0.100, 0.220, h);
    const lit = smoothstep(-0.150, 0.050, h);
    const twilight = Math.max(0, 1 - Math.abs(h) / 0.30);
    const moonUp = smoothstep(-0.060, 0.220, this.moonDir[1]);
    const moonAmt = moonUp * (0.08 + 0.92 * this.moonIllumination) * (1 - 0.85 * rain);

    /* ---- key light ------------------------------------------------------- */
    const tint = this._scratchA;
    mix3(tint, SUN_TINT_NIGHT, SUN_TINT_DAY, lit);
    mix3(tint, tint, SUN_TINT_HORIZON, twilight * 0.90 * lit);
    greyOut(tint, rain * 0.55, 1 - 0.20 * rain);
    // Renormalise so the tint stays a tint: the magnitude lives in sunIntensity.
    const peak = Math.max(tint[0], tint[1], tint[2], 1e-4);
    this.sunColor[0] = tint[0] / peak;
    this.sunColor[1] = tint[1] / peak;
    this.sunColor[2] = tint[2] / peak;

    const sunLight = SUN_PEAK * Math.pow(sunGate, 1.15) *
      (1 - 0.70 * rain) * (1 - 0.22 * thunder);
    const moonLight = MOON_PEAK * moonAmt;
    // The floor is integrated starlight: a new moon on an overcast night is
    // very dark, but never mathematically zero.
    this.sunIntensity = Math.max(sunLight, moonLight, 0.002);

    /* ---- hemispheric ambient --------------------------------------------- */
    const amb = this.skyAmbient;
    mix3(amb, SKY_AMBIENT_NIGHT, SKY_AMBIENT_DAY, dayLevel);
    addScaled3(amb, SKY_AMBIENT_DUSK, twilight * 0.55 * (1 - 0.35 * dayLevel));
    addScaled3(amb, SKY_AMBIENT_MOON, moonAmt * (1 - dayLevel));
    greyOut(amb, rain * 0.55, 1 - 0.42 * rain - 0.12 * thunder);
    if (snow > 0) {
      amb[0] += 0.012 * snow;
      amb[1] += 0.014 * snow;
      amb[2] += 0.018 * snow;
    }

    /* ---- ground bounce albedo -------------------------------------------- */
    // An albedo, not a radiance: the lighting pass multiplies it by its own
    // bounce strength. Snow cover makes the ground far more reflective.
    const g = this.groundColor;
    const snowLift = 1 + 1.15 * snow;
    g[0] = clamp((this.grassColor[0] * 0.62 + 0.030) * snowLift, 0, 1);
    g[1] = clamp((this.grassColor[1] * 0.62 + 0.034) * snowLift, 0, 1);
    g[2] = clamp((this.grassColor[2] * 0.62 + 0.028) * snowLift, 0, 1);

    /* ---- biome fog -------------------------------------------------------- */
    const bf = this.biomeFogColor;
    const gate = 0.055 + 0.945 * dayLevel;
    bf[0] = this._biomeFogBase[0] * gate;
    bf[1] = this._biomeFogBase[1] * gate;
    bf[2] = this._biomeFogBase[2] * gate;
    greyOut(bf, rain * 0.72, 1 - 0.38 * rain);

    /* ---- distance fog ----------------------------------------------------- */
    const fog = this.fogColor;
    mix3(fog, FOG_NIGHT, FOG_DAY, dayLevel);
    addScaled3(fog, FOG_DUSK, twilight * 0.60 * (0.30 + 0.70 * lit));
    addScaled3(fog, SKY_AMBIENT_MOON, moonAmt * 0.9 * (1 - dayLevel));
    // Blend a third of the way toward the biome's own fog so a swamp or a
    // desert still reads as itself at midday.
    mix3(fog, fog, bf, 0.34);
    greyOut(fog, rain * 0.72, 1 - 0.38 * rain);
    if (snow > 0) {
      const s = snow * 0.6;
      fog[0] = lerp(fog[0], fog[0] * 1.25 + 0.020, s);
      fog[1] = lerp(fog[1], fog[1] * 1.25 + 0.022, s);
      fog[2] = lerp(fog[2], fog[2] * 1.22 + 0.026, s);
    }

    /* ---- fog density ------------------------------------------------------ */
    this._renderDistance = Math.max(2, num(this._setting('renderDistance', 10), 10));
    const blocks = Math.max(32, this._renderDistance * 16);
    let density = 1.15 / blocks;
    density *= 1 + 1.35 * rain + 0.55 * snow + 0.25 * thunder;
    this.fogDensity = clamp(density, 0.0008, 0.09);

    /* ---- aurora ----------------------------------------------------------- */
    this.aurora = this._computeAurora(rain);
    this.auroraIntensity = this.aurora;

    /* ---- constants the render passes still want to read ------------------- */
    this.seaLevel = SEA_LEVEL;
  }

  /**
   * Decide tonight's aurora strength: possible only at high latitudes, only at
   * night, stable for a whole in-game day, and washed out by cloud cover.
   * @param {number} rain rain strength `0..1`
   * @returns {number} aurora strength `0..1`
   * @private
   */
  _computeAurora(rain) {
    const band = clamp((Math.abs(this.latitude) - 48) / 22, 0, 1);
    if (band <= 0) return 0;
    // A stable hash of the day: the aurora shows on roughly one night in three.
    const hash = fract(Math.sin((this.dayCount + this._moonOffset) * 127.1 + 311.7) * 43758.5453);
    const nightly = hash > 0.62 ? 0.25 + ((hash - 0.62) / 0.38) * 0.75 : 0;
    const night = smoothstep(0.05, -0.16, this.sunDir[1]);
    return clamp(band * nightly * night * (1 - 0.9 * rain), 0, 1);
  }

  /* ====================================================================== */
  /* Queries                                                                */
  /* ====================================================================== */

  /**
   * Sky-light multiplier the mob spawner and the particle system use: `15` in
   * bright daylight, `4` on a clear night, lower under rain and thunder.
   * @returns {number} `0..15`
   */
  getLightLevel() {
    const day = smoothstep(-0.09, 0.12, this.sunDir[1]);
    let level = 4 + 11 * day;
    level -= this.rainStrength * 3;
    level -= this.thunderStrength * 5;
    return clamp(level, 0, 15);
  }

  /**
   * Is it daytime? True from a little before sunrise to a little after sunset.
   * @returns {boolean} `true` while the sun is up
   */
  isDay() {
    return this.sunDir[1] > 0.0;
  }

  /**
   * Is it night? The complement of {@link Environment#isDay}.
   * @returns {boolean} `true` while the sun is down
   */
  isNight() {
    return !this.isDay();
  }

  /**
   * Is precipitation falling at all (rain, snow or a thunderstorm)?
   * @returns {boolean} `true` when it is not clear
   */
  isRaining() {
    return this.rainStrength > 0.01;
  }

  /**
   * Is a thunderstorm running?
   * @returns {boolean} `true` during thunder
   */
  isThundering() {
    return this.thunderStrength > 0.01;
  }

  /**
   * Does precipitation actually reach a given block — i.e. is it raining, is
   * the column open to the sky and is the biome one that gets weather at all?
   * @param {?Object} world the world
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @returns {boolean} `true` when rain or snow hits that block
   */
  isPrecipitatingAt(world, x, y, z) {
    if (this.rainStrength <= 0.05) return false;
    if (!world) return true;
    try {
      if (typeof world.getBiome === 'function') {
        const id = world.getBiome(Math.floor(x), Math.floor(z)) | 0;
        if (biomePrecipitationAt(id, Math.floor(y)) === 'none') return false;
      }
      if (typeof world.getHeight === 'function') {
        if (world.getHeight(Math.floor(x), Math.floor(z)) > Math.floor(y) + 1) return false;
      }
    } catch (err) {
      warnOnce('precipitation', 'the precipitation query failed', err);
      return true;
    }
    return true;
  }

  /**
   * Coarse part of the day, for music moods and the debug overlay.
   * @returns {'morning'|'day'|'evening'|'night'} the phase key
   */
  getPhase() {
    const t = this.timeOfDay;
    if (t < 0.06) return 'morning';
    if (t < 0.42) return 'day';
    if (t < 0.56) return 'evening';
    return 'night';
  }

  /**
   * The current in-game clock as `HH:MM`, with `06:00` at sunrise — handy for
   * the debug overlay.
   * @returns {string} the formatted time
   */
  getClockString() {
    const hours = fract(this.timeOfDay + 0.25) * 24;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
  }

  /* ====================================================================== */
  /* Mutators                                                               */
  /* ====================================================================== */

  /**
   * Jump the clock to a position inside the day.
   * @param {number} t time of day `0..1` (`0` = sunrise, `0.25` = noon); values
   *   outside the range wrap, so `1.25` is the same as `0.25`
   * @returns {void}
   */
  setTime(t) {
    const v = num(t, this.timeOfDay);
    this.timeOfDay = fract(v);
    this.ticks = Math.round((this.dayCount + this.timeOfDay) * DAY_TICKS);
    this._tickCarry = 0;
    this._updateCelestial();
    this._updateColors();
    this._wasDay = this.isDay();
    this.emit('time', this.timeOfDay);
  }

  /**
   * Jump the clock to an absolute tick count (day plus time of day).
   * @param {number} ticks absolute game ticks since world creation
   * @returns {void}
   */
  setTicks(ticks) {
    const v = Math.max(0, Math.round(num(ticks, this.ticks)));
    this.ticks = v;
    this._tickCarry = 0;
    this.dayCount = Math.floor(v / DAY_TICKS);
    this.timeOfDay = fract(v / DAY_TICKS);
    this._updateCelestial();
    this._updateColors();
    this._wasDay = this.isDay();
  }

  /**
   * Force a weather state. `'snow'` is accepted and starts a rain spell — the
   * biome under the player decides whether it falls as snow.
   *
   * @param {'clear'|'rain'|'thunder'|'snow'} w the state to switch to
   * @param {number} [duration] how long it should last, in seconds; omit for a
   *   random duration from the usual band
   * @returns {boolean} `true` when the state changed
   */
  setWeather(w, duration = -1) {
    const name = String(w);
    let state;
    let band;
    if (name === WEATHER.CLEAR) {
      state = WEATHER.CLEAR;
      band = CLEAR_DURATION;
    } else if (name === WEATHER.THUNDER) {
      state = WEATHER.THUNDER;
      band = THUNDER_DURATION;
    } else if (name === WEATHER.RAIN || name === WEATHER.SNOW) {
      state = WEATHER.RAIN;
      band = RAIN_DURATION;
    } else {
      warnOnce(`weather:${name}`, `unknown weather "${name}"; ignored`);
      return false;
    }

    const previous = this.weatherState;
    this.weatherState = state;
    this.weatherTimer = duration > 0 ? duration : this._rollDuration(band);
    if (state !== previous) this.emit('weather', state, previous);
    return state !== previous;
  }

  /**
   * Stop or resume the day/night cycle (the `doDaylightCycle` game rule).
   * @param {boolean} frozen `true` to freeze the clock
   * @returns {void}
   */
  setFrozen(frozen) {
    this.frozen = frozen === true;
  }

  /* ====================================================================== */
  /* Persistence                                                            */
  /* ====================================================================== */

  /**
   * Snapshot the environment for `game/save.js`.
   * @returns {Object} a plain, JSON-safe record
   */
  serialize() {
    return {
      version: 1,
      seed: this.seed,
      ticks: this.ticks,
      dayCount: this.dayCount,
      timeOfDay: this.timeOfDay,
      time: this.time,
      frozen: this.frozen,
      latitude: this.latitude,
      moonOffset: this._moonOffset,
      weatherState: this.weatherState,
      weatherTimer: this.weatherTimer,
      rainStrength: this.rainStrength,
      thunderStrength: this.thunderStrength,
      snowStrength: this.snowStrength,
    };
  }

  /**
   * Restore a snapshot produced by {@link Environment#serialize}. Missing or
   * broken fields keep their current value, so a partial record is safe.
   * @param {?Object} o the record
   * @returns {void}
   */
  deserialize(o) {
    if (o === null || o === undefined || typeof o !== 'object') return;
    try {
      if (Number.isFinite(o.seed)) {
        this.seed = o.seed >>> 0;
        this._rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);
      }
      if (Number.isFinite(o.latitude)) {
        this.latitude = clamp(o.latitude, -89, 89);
        this._tilt = clamp(Math.abs(this.latitude), 0, 80) * (Math.PI / 180) * 0.62;
      }
      if (Number.isFinite(o.moonOffset)) {
        this._moonOffset = ((o.moonOffset | 0) % MOON_PHASE_COUNT + MOON_PHASE_COUNT)
          % MOON_PHASE_COUNT;
      }
      if (Number.isFinite(o.ticks)) {
        this.setTicks(o.ticks);
      } else {
        if (Number.isFinite(o.dayCount)) this.dayCount = Math.max(0, o.dayCount | 0);
        if (Number.isFinite(o.timeOfDay)) this.timeOfDay = fract(o.timeOfDay);
        this.ticks = Math.round((this.dayCount + this.timeOfDay) * DAY_TICKS);
      }
      if (Number.isFinite(o.time)) this.time = Math.max(0, o.time);
      this.frozen = o.frozen === true;

      const state = String(o.weatherState || WEATHER.CLEAR);
      this.weatherState = (state === WEATHER.RAIN || state === WEATHER.THUNDER)
        ? state : WEATHER.CLEAR;
      this.weatherTimer = Number.isFinite(o.weatherTimer) && o.weatherTimer > 0
        ? o.weatherTimer
        : this._rollDuration(this.weatherState === WEATHER.CLEAR ? CLEAR_DURATION
          : (this.weatherState === WEATHER.RAIN ? RAIN_DURATION : THUNDER_DURATION));
      this.rainStrength = clamp(num(o.rainStrength, this.weatherState === WEATHER.CLEAR ? 0 : 1), 0, 1);
      this.thunderStrength = clamp(num(o.thunderStrength,
        this.weatherState === WEATHER.THUNDER ? 1 : 0), 0, 1);
      this.snowStrength = clamp(num(o.snowStrength, 0), 0, 1);
      this.weather = this.weatherState === WEATHER.CLEAR ? WEATHER.CLEAR : this.weatherState;

      this._updateCelestial();
      this._updateColors();
      this._wasDay = this.isDay();
    } catch (err) {
      warnOnce('deserialize', 'the environment snapshot could not be restored', err);
    }
  }

  /**
   * Drop every listener. The environment owns no GPU resource, so this is all
   * `dispose()` has to do.
   * @returns {void}
   */
  dispose() {
    if (this._listeners && typeof this._listeners.clear === 'function') {
      this._listeners.clear();
    }
  }
}

export default Environment;
