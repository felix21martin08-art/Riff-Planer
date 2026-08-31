/**
 * VOXELIA — procedural audio engine (ARCHITECTURE.md section 5.38).
 *
 * ============================================================================
 * DESIGN
 * ============================================================================
 * There are no audio files anywhere in this project. Every single sound — the
 * click of a button, a creeper hiss, a thunderstorm, the ambient music — is
 * built at run time out of oscillators, noise buffers, biquad filters and
 * envelopes on the Web Audio graph.
 *
 * The signal flow is:
 *
 *     voice ─┬─▶ distance low-pass ─▶ panner ─┬─▶ sfx bus ─▶ muffle ─┐
 *            │                                └─▶ reverb send ─┐     │
 *     bed  ──┴─▶ ambience bus ──────────────────────────────┐  │     │
 *     note ────▶ music layer ─▶ music duck ─▶ music bus ─┐  │  │     │
 *                                                        │  │  │     │
 *                                reverb send ─▶ convolver A/B ─▶ return
 *                                                        │  │  │     │
 *                                                        ▼  ▼  ▼     ▼
 *                                                   master ─▶ compressor ─▶ out
 *
 * * **Voices** are short lived one-shots. They are allocated from a pool that is
 *   hard-capped at {@link AudioEngine#maxVoices} (32 by default). When the cap
 *   is reached the quietest/oldest voice is faded out in 20 ms and recycled, so
 *   a cascade of falling gravel can never lock up the audio thread.
 * * **Beds** are long running ambience loops (wind, rain, cave, water, lava,
 *   crickets). They are built lazily, crossfaded with time constants and torn
 *   down again once they have been silent for a few seconds.
 * * **Music** is generative: a scale, a chord progression, a pad, a bass and a
 *   sparse probabilistic melody per mood, scheduled with a 2 s lookahead against
 *   the audio clock (never the frame clock). Moods crossfade over ~7 s, pieces
 *   last 70–140 s and are followed by 90–240 s of silence so the score never
 *   becomes intrusive.
 * * **Reverb** uses two convolvers with impulse responses that are *generated*
 *   (decaying, filtered, stereo-decorrelated noise plus discrete early taps).
 *   Switching preset crossfades A→B instead of swapping a buffer, so there is
 *   no click.
 *
 * ============================================================================
 * ROBUSTNESS
 * ============================================================================
 * Hard rule 8 of the architecture: never throw during a tick. If the
 * `AudioContext` cannot be created or resumed, {@link AudioEngine#init} returns
 * `false`, `ready` stays `false` and *every* public method becomes a silent
 * no-op. Every public entry point is additionally wrapped in a try/catch that
 * logs once per failure key and degrades.
 *
 * @module game/audio
 */

import { clamp, lerp, mulberry32 } from '../core/math.js';
import { blockSound } from '../world/blocks.js';
import { getBiome } from '../world/biomes.js';

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/** Smallest value an `exponentialRampToValueAtTime` may target. @type {number} */
const EPS = 1e-4;

/** Dedupe keys for {@link warnOnce}. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a message exactly once per key so a broken node cannot spam the console.
 * @param {string} key dedupe key
 * @param {string} message human readable message
 * @param {*} [detail] optional error or value
 * @returns {void}
 */
function warnOnce(key, message, detail) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  try {
    if (detail === undefined) console.warn(`[VOXELIA] audio: ${message}`);
    else console.warn(`[VOXELIA] audio: ${message}`, detail);
  } catch (_err) { /* console is optional */ }
}

/**
 * Coerce to a finite number.
 * @param {*} value candidate
 * @param {number} fallback used when `value` is not a finite number
 * @returns {number} a finite number
 */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Clamp a frequency into the safe biquad/oscillator range.
 * @param {number} f frequency in Hz
 * @returns {number} frequency in `[20, 18000]`
 */
function clampFreq(f) {
  if (!Number.isFinite(f)) return 1000;
  return f < 20 ? 20 : (f > 18000 ? 18000 : f);
}

/**
 * Equal-tempered MIDI note number to frequency.
 * @param {number} midi MIDI note number (69 = A4 = 440 Hz)
 * @returns {number} frequency in Hz
 */
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/* ========================================================================== */
/* Static tables                                                              */
/* ========================================================================== */

/**
 * Material sound classes understood by {@link AudioEngine#playBlockSound}.
 * They mirror the `sound` field of `world/blocks.js`, plus `dirt` as an alias.
 * @type {readonly string[]}
 */
export const SOUND_GROUPS = Object.freeze([
  'stone', 'wood', 'grass', 'dirt', 'gravel', 'sand',
  'glass', 'metal', 'wool', 'snow', 'water',
]);

/**
 * Sound kinds accepted by the `mob.<type>.<kind>` event names built by
 * `game/mobs.js#mobSound`.
 * @type {readonly string[]}
 */
export const MOB_SOUND_KINDS = Object.freeze([
  'idle', 'hurt', 'death', 'attack', 'step', 'special',
]);

/**
 * The four generative music moods of {@link AudioEngine#startMusic}.
 * @type {readonly string[]}
 */
export const MUSIC_MOOD_NAMES = Object.freeze(['calm', 'night', 'cave', 'danger']);

/**
 * Per-material synthesis recipe for dig / step / place / break / hit sounds.
 *
 * * `filter`/`freq`/`q` — the character band of the noise burst.
 * * `hp` — a high-pass in front of it, removes mud.
 * * `dur`/`gain` — base length and level.
 * * `grains`/`grainSpread` — several tiny impulses instead of one (gravel, snow).
 * * `body`/`bodyFreq`/`bodyDecay` — the pitched thump underneath.
 * * `partialBase`/`partials` — inharmonic sine partials (glass, metal).
 * * `ring` — high-Q resonant tail in seconds (metal).
 * * `sweep` — sweep the band downwards while it decays (water).
 * @type {Readonly<Object<string, Object>>}
 */
const GROUPS = Object.freeze({
  stone: {
    filter: 'bandpass', freq: 2000, q: 3.2, hp: 300, dur: 0.16, gain: 0.55,
    grains: 1, grainSpread: 0, body: 0.35, bodyFreq: 172, bodyDecay: 0.09,
    partialBase: 0, partials: null, partialDecay: 0, ring: 0, sweep: 0,
  },
  wood: {
    filter: 'bandpass', freq: 430, q: 6.5, hp: 120, dur: 0.19, gain: 0.6,
    grains: 1, grainSpread: 0, body: 0.55, bodyFreq: 205, bodyDecay: 0.14,
    partialBase: 400, partials: [1, 2.42, 3.87], partialDecay: 0.16, ring: 0, sweep: 0,
  },
  grass: {
    filter: 'lowpass', freq: 950, q: 0.9, hp: 90, dur: 0.19, gain: 0.5,
    grains: 2, grainSpread: 0.022, body: 0.32, bodyFreq: 124, bodyDecay: 0.1,
    partialBase: 0, partials: null, partialDecay: 0, ring: 0, sweep: 0,
  },
  dirt: {
    filter: 'lowpass', freq: 700, q: 0.9, hp: 70, dur: 0.2, gain: 0.52,
    grains: 2, grainSpread: 0.024, body: 0.4, bodyFreq: 108, bodyDecay: 0.11,
    partialBase: 0, partials: null, partialDecay: 0, ring: 0, sweep: 0,
  },
  gravel: {
    filter: 'bandpass', freq: 1250, q: 2.2, hp: 250, dur: 0.2, gain: 0.5,
    grains: 4, grainSpread: 0.028, body: 0.38, bodyFreq: 150, bodyDecay: 0.09,
    partialBase: 0, partials: null, partialDecay: 0, ring: 0, sweep: 0,
  },
  sand: {
    filter: 'highpass', freq: 2600, q: 0.8, hp: 1500, dur: 0.26, gain: 0.42,
    grains: 1, grainSpread: 0, body: 0.12, bodyFreq: 140, bodyDecay: 0.06,
    partialBase: 0, partials: null, partialDecay: 0, ring: 0, sweep: 0,
  },
  glass: {
    filter: 'highpass', freq: 3200, q: 0.9, hp: 2400, dur: 0.15, gain: 0.5,
    grains: 2, grainSpread: 0.012, body: 0.1, bodyFreq: 260, bodyDecay: 0.05,
    partialBase: 1560, partials: [1, 2.76, 5.4, 8.93], partialDecay: 0.34, ring: 0, sweep: 0,
  },
  metal: {
    filter: 'bandpass', freq: 1900, q: 9, hp: 400, dur: 0.15, gain: 0.5,
    grains: 1, grainSpread: 0, body: 0.25, bodyFreq: 190, bodyDecay: 0.08,
    partialBase: 880, partials: [1, 2.09, 3.71], partialDecay: 0.42, ring: 0.42, sweep: 0,
  },
  wool: {
    filter: 'lowpass', freq: 420, q: 0.8, hp: 60, dur: 0.15, gain: 0.45,
    grains: 1, grainSpread: 0, body: 0.2, bodyFreq: 92, bodyDecay: 0.08,
    partialBase: 0, partials: null, partialDecay: 0, ring: 0, sweep: 0,
  },
  snow: {
    filter: 'lowpass', freq: 1500, q: 1.1, hp: 200, dur: 0.15, gain: 0.45,
    grains: 3, grainSpread: 0.02, body: 0.25, bodyFreq: 132, bodyDecay: 0.07,
    partialBase: 0, partials: null, partialDecay: 0, ring: 0, sweep: 0,
  },
  water: {
    filter: 'bandpass', freq: 820, q: 1.6, hp: 200, dur: 0.3, gain: 0.5,
    grains: 1, grainSpread: 0, body: 0.15, bodyFreq: 180, bodyDecay: 0.12,
    partialBase: 0, partials: null, partialDecay: 0, ring: 0, sweep: 1,
  },
});

/**
 * How the five block actions modulate a {@link GROUPS} recipe.
 * @type {Readonly<Object<string, {gain:number, dur:number, pitch:number, body:number, tail:number}>>}
 */
const ACTIONS = Object.freeze({
  hit: { gain: 0.42, dur: 0.72, pitch: 1.06, body: 0.35, tail: 0.1 },
  dig: { gain: 0.58, dur: 0.9, pitch: 1.0, body: 0.5, tail: 0.12 },
  step: { gain: 0.5, dur: 0.8, pitch: 0.94, body: 0.65, tail: 0.1 },
  place: { gain: 0.72, dur: 0.62, pitch: 1.14, body: 0.75, tail: 0.12 },
  break: { gain: 1.0, dur: 1.3, pitch: 0.95, body: 1.6, tail: 0.4 },
});

/**
 * Reverb presets. `wet` is the level of the convolver return, everything else
 * feeds the generated impulse response.
 * @type {Readonly<Object<string, Object>>}
 */
const REVERB_PRESETS = Object.freeze({
  outdoors: { duration: 1.15, decay: 2.8, lowpass: 3600, highpass: 180, predelay: 0.012, taps: 3, wet: 0.16 },
  room: { duration: 0.62, decay: 3.4, lowpass: 5200, highpass: 220, predelay: 0.006, taps: 5, wet: 0.2 },
  cave: { duration: 3.4, decay: 1.9, lowpass: 2100, highpass: 110, predelay: 0.028, taps: 7, wet: 0.44 },
  underwater: { duration: 1.7, decay: 2.4, lowpass: 620, highpass: 60, predelay: 0.02, taps: 4, wet: 0.38 },
});

/**
 * Maps the fourteen `world/biomes.js` music moods onto the four moods the
 * generative engine actually knows.
 * @type {Readonly<Object<string, string>>}
 */
const BIOME_MOOD = Object.freeze({
  pastoral: 'calm', wooded: 'calm', floral: 'calm', boreal: 'calm',
  frozen: 'night', alpine: 'calm', arid: 'calm', jungle: 'calm',
  swamp: 'night', aquatic: 'calm', abyssal: 'cave', mysterious: 'night',
  ominous: 'danger', serene: 'calm',
});

/**
 * Pick the generative music mood for a situation.
 * @param {number} biomeId biome id from `world/biomes.js`
 * @param {boolean} isNight true between dusk and dawn
 * @param {boolean} underground true when the player is in a cave
 * @param {boolean} [danger=false] true while hostile mobs are engaging
 * @returns {('calm'|'night'|'cave'|'danger')} mood name
 */
export function moodForBiome(biomeId, isNight, underground, danger = false) {
  if (danger) return 'danger';
  if (underground) return 'cave';
  let mood = 'calm';
  try {
    mood = BIOME_MOOD[getBiome(biomeId).musicMood] || 'calm';
  } catch (_err) {
    mood = 'calm';
  }
  if (isNight && mood === 'calm') return 'night';
  return /** @type {any} */ (mood);
}

/* ========================================================================== */
/* Voice                                                                      */
/* ========================================================================== */

/**
 * One pooled polyphonic voice. Holds every node a single sound created so the
 * engine can disconnect them in one go when the sound is over or stolen.
 */
class Voice {
  constructor() {
    /** @type {number} monotonic handle returned by {@link AudioEngine#play}. */
    this.id = 0;
    /** @type {string} event name, for debugging and stealing heuristics. */
    this.name = '';
    /** @type {?GainNode} per-voice output gain; recipes connect into this. */
    this.out = null;
    /** @type {AudioNode[]} every node to disconnect when the voice ends. */
    this.nodes = [];
    /** @type {AudioScheduledSourceNode[]} every source to stop when stolen. */
    this.sources = [];
    /** @type {number} `ctx.currentTime` at which the voice started. */
    this.startTime = 0;
    /** @type {number} `ctx.currentTime` at which the voice may be recycled. */
    this.endTime = 0;
    /** @type {number} perceived loudness 0..1, drives voice stealing. */
    this.audible = 1;
    /** @type {number} 0 = steal me first, 2 = important. */
    this.priority = 1;
    /** @type {boolean} true for looping voices that must be stopped manually. */
    this.loop = false;
  }

  /**
   * Clear the voice for reuse.
   * @returns {void}
   */
  reset() {
    this.id = 0;
    this.name = '';
    this.out = null;
    this.nodes.length = 0;
    this.sources.length = 0;
    this.startTime = 0;
    this.endTime = 0;
    this.audible = 1;
    this.priority = 1;
    this.loop = false;
  }
}

/* ========================================================================== */
/* AudioEngine                                                                */
/* ========================================================================== */

/**
 * The whole audio subsystem: synthesis, positional playback, ambience beds and
 * the generative score.
 *
 * @example
 * const audio = new AudioEngine(settings);
 * document.addEventListener('pointerdown', () => audio.init(), { once: true });
 * audio.setListener(camera.position, camera.forward, camera.up);
 * audio.playBlockSound('break', blockId, x + 0.5, y + 0.5, z + 0.5);
 */
export class AudioEngine {
  /**
   * @param {?Object} [settings] a `core/settings.js` {@link Settings} instance;
   *   `null` falls back to `masterVolume 0.8 / musicVolume 0.4 / sfxVolume 0.9`.
   */
  constructor(settings = null) {
    /** @type {?Object} the settings store, or null. */
    this.settings = settings || null;
    /** @type {?AudioContext} the context, `null` until {@link AudioEngine#init}. */
    this.ctx = null;
    /** @type {boolean} true once the graph is live and sounds can play. */
    this.ready = false;
    /** @type {boolean} true when audio was permanently disabled after an error. */
    this.failed = false;
    /** @type {boolean} when true every playback call is skipped. */
    this.muted = false;
    /** @type {number} hard polyphony cap for one-shot sound effects. */
    this.maxVoices = 32;
    /** @type {number} sounds further away than this are dropped entirely. */
    this.maxDistance = 72;

    /** @type {?Promise<boolean>} in-flight init promise. @private */
    this._initPromise = null;
    /** @type {Voice[]} currently sounding voices. @private */
    this._voices = [];
    /** @type {Voice[]} stolen voices still fading out. @private */
    this._dying = [];
    /** @type {Voice[]} recycled voice objects. @private */
    this._pool = [];
    /** @type {number} handle counter. @private */
    this._nextId = 1;
    /** @type {{end:number, h:{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}}[]} @private */
    this._scheduled = [];

    /* ---- graph ---------------------------------------------------------- */
    /** @type {?GainNode} @private */ this._master = null;
    /** @type {?DynamicsCompressorNode} @private */ this._compressor = null;
    /** @type {?GainNode} @private */ this._sfxBus = null;
    /** @type {?BiquadFilterNode} @private */ this._muffle = null;
    /** @type {?GainNode} @private */ this._musicBus = null;
    /** @type {?GainNode} @private */ this._musicDuck = null;
    /** @type {?GainNode} @private */ this._ambienceBus = null;
    /** @type {?GainNode} @private */ this._reverbSend = null;
    /** @type {?GainNode} @private */ this._reverbReturn = null;
    /** @type {ConvolverNode[]} @private */ this._convolvers = [];
    /** @type {GainNode[]} @private */ this._convGains = [];
    /** @type {number} index of the convolver currently carrying the tail. @private */
    this._convActive = 0;
    /** @type {Map<string, AudioBuffer>} generated impulse responses. @private */
    this._irCache = new Map();
    /** @type {string} current reverb preset name. @private */
    this._reverbPreset = 'outdoors';
    /** @type {number} wet amount of the current preset. @private */
    this._reverbWet = REVERB_PRESETS.outdoors.wet;

    /** @type {?AudioBuffer} 2 s of white noise. @private */ this._white = null;
    /** @type {?AudioBuffer} 2 s of brown noise. @private */ this._brown = null;
    /** @type {?AudioBuffer} 1.6 s Karplus-Strong pluck at 220 Hz. @private */ this._pluck = null;

    /* ---- listener ------------------------------------------------------- */
    /** @type {Float32Array} listener position. @private */
    this._lisPos = new Float32Array([0, 0, 0]);
    /** @type {Float32Array} listener forward. @private */
    this._lisFwd = new Float32Array([0, 0, -1]);
    /** @type {Float32Array} listener up. @private */
    this._lisUp = new Float32Array([0, 1, 0]);

    /* ---- ambience ------------------------------------------------------- */
    /** @type {Map<string, Object>} live ambience beds by name. @private */
    this._beds = new Map();
    /** @type {Object<string, number>} target gain per bed name. @private */
    this._bedTargets = Object.create(null);
    /** @type {number} biome the ambience was last configured for. @private */
    this._biomeId = 0;
    /** @type {boolean} @private */ this._isNight = false;
    /** @type {string} @private */ this._weather = 'clear';
    /** @type {boolean} @private */ this._underground = false;
    /** @type {boolean} @private */ this._submerged = false;
    /** @type {boolean} @private */ this._nearLava = false;
    /** @type {number} next distant-thunder time on the audio clock. @private */
    this._nextThunder = 0;

    /* ---- music ---------------------------------------------------------- */
    /** @type {Object[]} active generative layers. @private */
    this._layers = [];
    /** @type {?string} the mood the engine wants to be playing. @private */
    this._mood = null;
    /** @type {boolean} true when {@link AudioEngine#startMusic} was called. @private */
    this._musicOn = false;
    /** @type {boolean} pick the mood from {@link AudioEngine#setAmbience}. */
    this.autoMood = true;
    /** @type {number} audio-clock time before which no new piece may start. @private */
    this._musicIdleUntil = 0;
    /** @type {number} combat duck expiry on the audio clock. @private */
    this._combatUntil = 0;
    /** @type {boolean} current duck state. @private */
    this._ducked = false;
    /** @type {() => number} deterministic PRNG for the score. @private */
    this._rng = mulberry32((Date.now() & 0x7fffffff) ^ 0x9e3779b9);
    /** @type {number} disc pieces stop after this audio-clock time. @private */
    this._discUntil = 0;

    /** @type {*} interval handle of the 100 ms pump. @private */
    this._pumpTimer = null;
    /** @type {?Function} settings change handler. @private */
    this._onSettingsChange = null;
    /** @type {?Function} user-gesture unlock handler. @private */
    this._unlock = null;
  }

  /* ====================================================================== */
  /* Lifecycle                                                              */
  /* ====================================================================== */

  /**
   * Create and resume the `AudioContext` and build the mixing graph. Must be
   * called from a user gesture (click, key press, touch) — browsers refuse to
   * start audio otherwise. Safe to call repeatedly; the same promise is reused.
   * @returns {Promise<boolean>} `true` when audio is live, `false` when the
   *   engine permanently degraded to a silent no-op.
   */
  async init() {
    if (this.ready) return true;
    if (this.failed) return false;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  /**
   * Build everything. Never rejects.
   * @returns {Promise<boolean>} success flag
   * @private
   */
  async _doInit() {
    try {
      const scope = typeof window !== 'undefined' ? window : /** @type {*} */ (globalThis);
      const Ctor = scope.AudioContext || scope.webkitAudioContext;
      if (!Ctor) {
        this.failed = true;
        warnOnce('noctx', 'the browser has no Web Audio API — the game stays silent');
        return false;
      }
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;

      /* master chain: everything → master → compressor → speakers */
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.knee.value = 24;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.22;
      compressor.connect(ctx.destination);
      this._compressor = compressor;

      const master = ctx.createGain();
      master.gain.value = this._setting('masterVolume', 0.8);
      master.connect(compressor);
      this._master = master;

      /* sfx bus with a global muffle filter (underwater / helmet effect) */
      const muffle = ctx.createBiquadFilter();
      muffle.type = 'lowpass';
      muffle.frequency.value = 18000;
      muffle.Q.value = 0.7;
      muffle.connect(master);
      this._muffle = muffle;

      const sfx = ctx.createGain();
      sfx.gain.value = this._setting('sfxVolume', 0.9);
      sfx.connect(muffle);
      this._sfxBus = sfx;

      const ambience = ctx.createGain();
      ambience.gain.value = this._setting('sfxVolume', 0.9) * 0.85;
      ambience.connect(muffle);
      this._ambienceBus = ambience;

      /* music bus with its own combat duck */
      const music = ctx.createGain();
      music.gain.value = this._setting('musicVolume', 0.4);
      music.connect(master);
      this._musicBus = music;

      const duck = ctx.createGain();
      duck.gain.value = 1;
      duck.connect(music);
      this._musicDuck = duck;

      /* reverb: send → A/B convolvers → return → master */
      const send = ctx.createGain();
      send.gain.value = 1;
      this._reverbSend = send;

      const ret = ctx.createGain();
      ret.gain.value = 1;
      ret.connect(master);
      this._reverbReturn = ret;

      for (let i = 0; i < 2; i++) {
        const conv = ctx.createConvolver();
        conv.normalize = true;
        const g = ctx.createGain();
        g.gain.value = 0;
        send.connect(conv);
        conv.connect(g);
        g.connect(ret);
        this._convolvers.push(conv);
        this._convGains.push(g);
      }
      this._convolvers[0].buffer = this._impulse('outdoors');
      this._convGains[0].gain.value = REVERB_PRESETS.outdoors.wet;
      this._convActive = 0;

      /* the ambience bus also feeds the reverb, at a fixed modest amount */
      const ambSend = ctx.createGain();
      ambSend.gain.value = 0.25;
      ambience.connect(ambSend);
      ambSend.connect(send);

      const musicSend = ctx.createGain();
      musicSend.gain.value = 0.4;
      music.connect(musicSend);
      musicSend.connect(send);

      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (_err) { /* handled by the unlock hook */ }
      }

      this.ready = true;
      this._bindSettings();
      this._installUnlock();
      this._startPump();
      this._applyVolumes(0);
      return true;
    } catch (err) {
      this.failed = true;
      this.ready = false;
      warnOnce('init', 'the audio context could not be started — the game stays silent', err);
      return false;
    }
  }

  /**
   * Read a setting with a fallback, tolerating a missing settings object.
   * @param {string} key setting key
   * @param {number} fallback default value
   * @returns {number} the value
   * @private
   */
  _setting(key, fallback) {
    const s = this.settings;
    if (!s || typeof s.get !== 'function') return fallback;
    try {
      return num(s.get(key), fallback);
    } catch (_err) {
      return fallback;
    }
  }

  /**
   * Subscribe to volume changes.
   * @returns {void}
   * @private
   */
  _bindSettings() {
    const s = this.settings;
    if (!s || typeof s.on !== 'function' || this._onSettingsChange) return;
    this._onSettingsChange = (key) => {
      if (key === 'masterVolume' || key === 'musicVolume' || key === 'sfxVolume') {
        this._applyVolumes(0.08);
      }
    };
    try { s.on('change', this._onSettingsChange); } catch (_err) { this._onSettingsChange = null; }
  }

  /**
   * Push the three volume settings into the bus gains.
   * @param {number} [glide=0.05] ramp time in seconds
   * @returns {void}
   * @private
   */
  _applyVolumes(glide = 0.05) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const master = this._setting('masterVolume', 0.8);
    const sfx = this._setting('sfxVolume', 0.9);
    const music = this._setting('musicVolume', 0.4);
    this._ramp(this._master.gain, this.muted ? 0 : master, t, glide);
    this._ramp(this._sfxBus.gain, sfx, t, glide);
    this._ramp(this._ambienceBus.gain, sfx * 0.85, t, glide);
    this._ramp(this._musicBus.gain, music, t, glide);
  }

  /**
   * Linear ramp helper that first pins the current value, so overlapping ramps
   * never jump.
   * @param {AudioParam} param the parameter
   * @param {number} value target value
   * @param {number} t start time on the audio clock
   * @param {number} glide ramp length in seconds
   * @returns {void}
   * @private
   */
  _ramp(param, value, t, glide) {
    try {
      const now = Math.max(t, this.ctx.currentTime);
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      if (glide > 0.001) param.linearRampToValueAtTime(value, now + glide);
      else param.setValueAtTime(value, now);
    } catch (err) {
      warnOnce('ramp', 'a volume ramp failed', err);
    }
  }

  /**
   * Install one-shot listeners that resume a context the browser suspended.
   * @returns {void}
   * @private
   */
  _installUnlock() {
    if (typeof window === 'undefined' || this._unlock) return;
    this._unlock = () => {
      const ctx = this.ctx;
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        try { ctx.resume(); } catch (_err) { /* nothing else we can do */ }
      }
    };
    const opts = { passive: true };
    try {
      window.addEventListener('pointerdown', this._unlock, opts);
      window.addEventListener('keydown', this._unlock, opts);
      window.addEventListener('touchend', this._unlock, opts);
    } catch (_err) { this._unlock = null; }
  }

  /**
   * Start the 100 ms housekeeping timer that reaps voices and schedules music
   * and ambience against the audio clock.
   * @returns {void}
   * @private
   */
  _startPump() {
    if (this._pumpTimer !== null || typeof setInterval !== 'function') return;
    this._pumpTimer = setInterval(() => this._pump(), 100);
  }

  /**
   * Suspend the context (the Game calls this while the tab is hidden).
   * @returns {void}
   */
  suspend() {
    if (!this.ready) return;
    try { this.ctx.suspend(); } catch (err) { warnOnce('suspend', 'suspending failed', err); }
  }

  /**
   * Resume a suspended context.
   * @returns {void}
   */
  resume() {
    if (!this.ready) return;
    try { this.ctx.resume(); } catch (err) { warnOnce('resume', 'resuming failed', err); }
  }

  /**
   * Mute or unmute everything without touching the user's volume settings.
   * @param {boolean} muted `true` to silence the master gain
   * @returns {void}
   */
  setMuted(muted) {
    this.muted = muted === true;
    this._applyVolumes(0.12);
  }

  /**
   * Release every node, timer and listener. The engine is unusable afterwards.
   * @returns {void}
   */
  dispose() {
    if (this._pumpTimer !== null) {
      try { clearInterval(this._pumpTimer); } catch (_err) { /* ignore */ }
      this._pumpTimer = null;
    }
    if (this._onSettingsChange && this.settings && typeof this.settings.off === 'function') {
      try { this.settings.off('change', this._onSettingsChange); } catch (_err) { /* ignore */ }
    }
    this._onSettingsChange = null;
    if (this._unlock && typeof window !== 'undefined') {
      try {
        window.removeEventListener('pointerdown', this._unlock);
        window.removeEventListener('keydown', this._unlock);
        window.removeEventListener('touchend', this._unlock);
      } catch (_err) { /* ignore */ }
      this._unlock = null;
    }
    try {
      for (const v of this._voices) this._releaseVoice(v);
      for (const v of this._dying) this._releaseVoice(v);
      for (const s of this._scheduled) this._disconnectHolder(s.h);
      for (const bed of this._beds.values()) this._destroyBed(bed);
      for (const layer of this._layers) this._destroyLayer(layer);
    } catch (err) {
      warnOnce('dispose', 'tearing down the audio graph failed', err);
    }
    this._voices.length = 0;
    this._dying.length = 0;
    this._pool.length = 0;
    this._scheduled.length = 0;
    this._beds.clear();
    this._layers.length = 0;
    this._irCache.clear();
    this.ready = false;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && typeof ctx.close === 'function') {
      try { ctx.close(); } catch (_err) { /* ignore */ }
    }
  }

  /**
   * Counters for the F3 overlay.
   * @returns {{voices:number, dying:number, scheduled:number, beds:number,
   *   layers:number, state:string, mood:(string|null)}} live statistics
   */
  getStats() {
    return {
      voices: this._voices.length,
      dying: this._dying.length,
      scheduled: this._scheduled.length,
      beds: this._beds.size,
      layers: this._layers.length,
      state: this.ctx ? this.ctx.state : (this.failed ? 'failed' : 'closed'),
      mood: this._mood,
    };
  }

  /* ====================================================================== */
  /* Buffers                                                                */
  /* ====================================================================== */

  /**
   * A random float in `[0, 1)`. Used for sound-effect variation.
   * @returns {number} random number
   */
  rand() {
    return Math.random();
  }

  /**
   * Two seconds of cached white noise.
   * @returns {AudioBuffer} mono noise buffer
   * @private
   */
  _whiteBuffer() {
    if (this._white) return this._white;
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 2);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._white = buf;
    return buf;
  }

  /**
   * Two seconds of cached brown (integrated) noise, normalised to ±1.
   * @returns {AudioBuffer} mono noise buffer
   * @private
   */
  _brownBuffer() {
    if (this._brown) return this._brown;
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 2);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let last = 0;
    let peak = 1e-6;
    for (let i = 0; i < len; i++) {
      last = (last + (Math.random() * 2 - 1) * 0.035) * 0.997;
      d[i] = last;
      const a = last < 0 ? -last : last;
      if (a > peak) peak = a;
    }
    const inv = 0.98 / peak;
    for (let i = 0; i < len; i++) d[i] *= inv;
    /* fade the seam so the loop does not click */
    const fade = Math.min(1024, len >> 4);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] *= k;
      d[len - 1 - i] *= k;
    }
    this._brown = buf;
    return buf;
  }

  /**
   * A Karplus-Strong pluck at 220 Hz. Recipes pitch it with `playbackRate`,
   * so one buffer serves every plucked string in the game.
   * @returns {AudioBuffer} mono pluck buffer
   * @private
   */
  _pluckBuffer() {
    if (this._pluck) return this._pluck;
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 1.6);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const n = Math.max(2, Math.round(sr / 220));
    const line = new Float32Array(n);
    for (let i = 0; i < n; i++) line[i] = Math.random() * 2 - 1;
    let idx = 0;
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const cur = line[idx];
      const avg = (cur + prev) * 0.5 * 0.9975;
      line[idx] = avg;
      prev = cur;
      d[i] = cur;
      idx = idx + 1 === n ? 0 : idx + 1;
    }
    /* gentle overall decay so the tail never sits at a constant level */
    for (let i = 0; i < len; i++) d[i] *= Math.exp(-3.2 * (i / len));
    this._pluck = buf;
    return buf;
  }

  /**
   * Generate (and cache) a reverb impulse response: exponentially decaying
   * stereo noise, one-pole low-passed for air absorption, high-passed to keep
   * the low end clean, with a pre-delay and a handful of discrete early taps.
   * @param {string} preset a key of {@link REVERB_PRESETS}
   * @returns {AudioBuffer} stereo impulse response
   * @private
   */
  _impulse(preset) {
    const cached = this._irCache.get(preset);
    if (cached) return cached;
    const p = REVERB_PRESETS[preset] || REVERB_PRESETS.outdoors;
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = Math.max(64, Math.floor(sr * p.duration));
    const buf = ctx.createBuffer(2, len, sr);
    const pre = Math.floor(sr * p.predelay);
    const lpA = Math.exp(-2 * Math.PI * p.lowpass / sr);
    const hpA = Math.exp(-2 * Math.PI * p.highpass / sr);

    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      let hp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / (len - pre);
        const env = Math.pow(1 - t, p.decay);
        const x = (Math.random() * 2 - 1) * env;
        lp = lp * lpA + x * (1 - lpA);
        hp = hp * hpA + lp * (1 - hpA);
        d[i] = lp - hp;
      }
      /* early reflections — this is what makes a cave read as a cave */
      for (let k = 0; k < p.taps; k++) {
        const pos = pre + Math.floor((0.004 + Math.random() * 0.09) * sr);
        if (pos < len) d[pos] += (Math.random() * 2 - 1) * 0.55 * Math.pow(0.72, k);
      }
      /* short fade-in kills the click of the first sample */
      const fade = Math.min(64, len);
      for (let i = 0; i < fade; i++) d[pre + i < len ? pre + i : len - 1] *= i / fade;
    }
    this._irCache.set(preset, buf);
    return buf;
  }

  /* ====================================================================== */
  /* Node factories used by the synthesis recipes                           */
  /* ====================================================================== */

  /**
   * Create a gain node owned by a holder (voice, bed, layer or transient).
   * @param {{nodes:AudioNode[]}} h owner
   * @param {number} value initial gain
   * @returns {GainNode} the node
   */
  gainNode(h, value) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    h.nodes.push(g);
    return g;
  }

  /**
   * Create a biquad filter owned by a holder.
   * @param {{nodes:AudioNode[]}} h owner
   * @param {BiquadFilterType} type filter type
   * @param {number} freq cutoff/centre frequency in Hz
   * @param {number} [q=1] quality factor
   * @returns {BiquadFilterNode} the node
   */
  biquad(h, type, freq, q = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = clampFreq(freq);
    f.Q.value = clamp(q, 0.0001, 40);
    h.nodes.push(f);
    return f;
  }

  /**
   * Start an oscillator owned by a holder.
   * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
   * @param {OscillatorType} type waveform
   * @param {number} freq frequency in Hz
   * @param {number} t start time on the audio clock
   * @param {number} dur length in seconds; `Infinity` keeps it running
   * @param {number} [detune=0] detune in cents
   * @returns {OscillatorNode} the node
   */
  oscNode(h, type, freq, t, dur, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = clampFreq(freq);
    if (detune) o.detune.value = detune;
    o.start(t);
    if (Number.isFinite(dur)) o.stop(t + Math.max(0.01, dur));
    h.nodes.push(o);
    h.sources.push(o);
    return o;
  }

  /**
   * Start a noise source owned by a holder. The buffer is looped from a random
   * offset, so two identical calls never produce the same waveform.
   * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
   * @param {number} t start time on the audio clock
   * @param {number} dur length in seconds; `Infinity` loops forever
   * @param {number} [rate=1] playback rate (raises/lowers the spectrum)
   * @param {boolean} [brown=false] use brown instead of white noise
   * @returns {AudioBufferSourceNode} the node
   */
  noiseNode(h, t, dur, rate = 1, brown = false) {
    const src = this.ctx.createBufferSource();
    const buf = brown ? this._brownBuffer() : this._whiteBuffer();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = clamp(rate, 0.06, 8);
    const offset = Math.random() * (buf.duration * 0.5);
    if (Number.isFinite(dur)) src.start(t, offset, Math.max(0.005, dur));
    else src.start(t, offset);
    h.nodes.push(src);
    h.sources.push(src);
    return src;
  }

  /**
   * Start a pitched Karplus-Strong pluck owned by a holder.
   * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
   * @param {number} t start time on the audio clock
   * @param {number} freq pitch in Hz
   * @param {number} dur length in seconds
   * @returns {AudioBufferSourceNode} the node
   */
  pluckNode(h, t, freq, dur) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._pluckBuffer();
    src.playbackRate.value = clamp(freq / 220, 0.06, 8);
    src.start(t, 0, Math.max(0.02, dur));
    h.nodes.push(src);
    h.sources.push(src);
    return src;
  }

  /**
   * Connect a chain of nodes left to right.
   * @param {...AudioNode} nodes at least two nodes
   * @returns {void}
   */
  chain(...nodes) {
    for (let i = 0; i + 1 < nodes.length; i++) {
      try { nodes[i].connect(nodes[i + 1]); } catch (err) { warnOnce('chain', 'connecting nodes failed', err); }
    }
  }

  /**
   * Attack/decay envelope on a gain parameter (exponential, so it sounds right).
   * @param {AudioParam} param the gain parameter
   * @param {number} t start time
   * @param {number} peak peak level
   * @param {number} attack attack length in seconds
   * @param {number} decay decay length in seconds
   * @returns {void}
   */
  envAD(param, t, peak, attack, decay) {
    const p = Math.max(EPS * 2, peak);
    const a = Math.max(0.0008, attack);
    const d = Math.max(0.002, decay);
    param.setValueAtTime(EPS, t);
    param.exponentialRampToValueAtTime(p, t + a);
    param.exponentialRampToValueAtTime(EPS, t + a + d);
  }

  /**
   * Attack/hold/decay envelope on a gain parameter.
   * @param {AudioParam} param the gain parameter
   * @param {number} t start time
   * @param {number} peak peak level
   * @param {number} attack attack length in seconds
   * @param {number} hold sustain length in seconds
   * @param {number} decay decay length in seconds
   * @returns {void}
   */
  envAHD(param, t, peak, attack, hold, decay) {
    const p = Math.max(EPS * 2, peak);
    const a = Math.max(0.0008, attack);
    const h = Math.max(0, hold);
    const d = Math.max(0.002, decay);
    param.setValueAtTime(EPS, t);
    param.exponentialRampToValueAtTime(p, t + a);
    param.setValueAtTime(p, t + a + h);
    param.exponentialRampToValueAtTime(EPS, t + a + h + d);
  }

  /**
   * Exponential glide of a frequency-like parameter.
   * @param {AudioParam} param the parameter
   * @param {number} t start time
   * @param {number} from start value
   * @param {number} to end value
   * @param {number} dur glide length in seconds
   * @returns {void}
   */
  sweep(param, t, from, to, dur) {
    param.setValueAtTime(Math.max(EPS, from), t);
    param.exponentialRampToValueAtTime(Math.max(EPS, to), t + Math.max(0.005, dur));
  }

  /**
   * Three-point exponential glide (`from` → `mid` at 40 % → `to`). This is what
   * turns a flat tone into a "meow" or a "neigh".
   * @param {AudioParam} param the parameter
   * @param {number} t start time
   * @param {number} from start value
   * @param {number} mid value at 40 % of the duration
   * @param {number} to end value
   * @param {number} dur total length in seconds
   * @returns {void}
   */
  sweep3(param, t, from, mid, to, dur) {
    const d = Math.max(0.01, dur);
    param.setValueAtTime(Math.max(EPS, from), t);
    param.exponentialRampToValueAtTime(Math.max(EPS, mid), t + d * 0.4);
    param.exponentialRampToValueAtTime(Math.max(EPS, to), t + d);
  }

  /**
   * Add a vibrato LFO to an oscillator's detune parameter.
   * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
   * @param {OscillatorNode} osc target oscillator
   * @param {number} t start time
   * @param {number} dur length in seconds
   * @param {number} rate vibrato rate in Hz
   * @param {number} depth vibrato depth in cents
   * @returns {void}
   */
  vibrato(h, osc, t, dur, rate, depth) {
    if (depth <= 0 || rate <= 0) return;
    const lfo = this.oscNode(h, 'sine', rate, t, dur);
    const amt = this.gainNode(h, depth);
    lfo.connect(amt);
    try { amt.connect(osc.detune); } catch (err) { warnOnce('vibrato', 'the vibrato LFO could not be attached', err); }
  }

  /**
   * A short-lived node holder that the pump disconnects automatically. Used by
   * ambience events and music notes, which are not pooled voices.
   * @param {number} end audio-clock time after which the nodes are dropped
   * @returns {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} holder
   */
  transient(end) {
    const h = { nodes: [], sources: [] };
    this._scheduled.push({ end: end + 0.25, h });
    return h;
  }

  /**
   * Disconnect every node of a holder.
   * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h holder
   * @returns {void}
   * @private
   */
  _disconnectHolder(h) {
    const nodes = h.nodes;
    for (let i = 0; i < nodes.length; i++) {
      try { nodes[i].disconnect(); } catch (_err) { /* already gone */ }
    }
    nodes.length = 0;
    h.sources.length = 0;
  }
}
