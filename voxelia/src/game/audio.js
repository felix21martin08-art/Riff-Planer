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

  /* ====================================================================== */
  /* Voice pool                                                             */
  /* ====================================================================== */

  /**
   * Allocate a voice, wiring its output through the distance filter, the
   * panner and the reverb send. Returns `null` when the sound is inaudible
   * (too far away) or when no voice could be stolen.
   * @param {string} name event name
   * @param {Object} opts play options
   * @returns {?Voice} a ready voice or `null`
   * @private
   */
  _beginVoice(name, opts) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const volume = clamp(num(opts.volume, 1), 0, 4);
    if (volume <= 0.001) return null;

    let positional = false;
    let x = 0;
    let y = 0;
    let z = 0;
    let dist = 0;
    if (opts.x !== undefined && opts.y !== undefined && opts.z !== undefined) {
      x = num(opts.x, 0);
      y = num(opts.y, 0);
      z = num(opts.z, 0);
      const lp = this._lisPos;
      const dx = x - lp[0];
      const dy = y - lp[1];
      const dz = z - lp[2];
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const reach = this.maxDistance * (0.5 + volume * 0.5);
      if (dist > reach) return null;
      positional = true;
    }

    const audible = volume / (1 + dist * 0.14);
    const priority = num(opts.priority, 1);

    if (this._voices.length >= this.maxVoices) {
      const victim = this._pickVictim(audible, priority);
      if (!victim) return null;
      this._steal(victim);
    }

    const v = this._pool.pop() || new Voice();
    v.reset();
    v.id = this._nextId++;
    v.name = name;
    v.startTime = now;
    v.audible = audible;
    v.priority = priority;
    v.loop = opts.loop === true;

    const out = ctx.createGain();
    out.gain.value = volume;
    v.out = out;
    v.nodes.push(out);

    let tail = /** @type {AudioNode} */ (out);
    if (positional) {
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = this._distanceCutoff(dist);
      lpf.Q.value = 0.6;
      v.nodes.push(lpf);
      const panner = this._makePanner(x, y, z);
      v.nodes.push(panner);
      out.connect(lpf);
      lpf.connect(panner);
      panner.connect(this._sfxBus);
      tail = panner;
    } else {
      out.connect(this._sfxBus);
    }

    const wet = this._reverbWet * num(opts.reverb, 1) * (positional ? clamp(0.25 + dist * 0.03, 0.25, 1.4) : 0.45);
    if (wet > 0.01) {
      const send = ctx.createGain();
      send.gain.value = wet;
      v.nodes.push(send);
      tail.connect(send);
      send.connect(this._reverbSend);
    }
    return v;
  }

  /**
   * Register a finished voice so the pump can recycle it.
   * @param {Voice} v the voice
   * @param {number} duration length of the sound in seconds, tail included
   * @returns {number} the voice handle
   * @private
   */
  _endVoice(v, duration) {
    const d = Number.isFinite(duration) ? Math.max(0.02, duration) : Infinity;
    v.endTime = v.loop || !Number.isFinite(d) ? Infinity : v.startTime + d + 0.06;
    this._voices.push(v);
    return v.id;
  }

  /**
   * Choose the voice to sacrifice: the quietest one, biased towards older and
   * lower-priority voices. Returns `null` when everything sounding is more
   * important than the incoming sound.
   * @param {number} audible loudness of the incoming sound
   * @param {number} priority priority of the incoming sound
   * @returns {?Voice} the victim or `null`
   * @private
   */
  _pickVictim(audible, priority) {
    const now = this.ctx.currentTime;
    let worst = null;
    let worstScore = Infinity;
    for (let i = 0; i < this._voices.length; i++) {
      const v = this._voices[i];
      const age = now - v.startTime;
      const score = v.audible * (0.6 + v.priority * 0.4) - age * 0.25 - (v.loop ? -0.5 : 0);
      if (score < worstScore) {
        worstScore = score;
        worst = v;
      }
    }
    if (!worst) return null;
    const incoming = audible * (0.6 + priority * 0.4);
    return worstScore <= incoming ? worst : null;
  }

  /**
   * Fade a voice out in 20 ms and move it to the dying list.
   * @param {Voice} v the voice
   * @returns {void}
   * @private
   */
  _steal(v) {
    const idx = this._voices.indexOf(v);
    if (idx >= 0) this._voices.splice(idx, 1);
    const now = this.ctx.currentTime;
    const fade = 0.02;
    try {
      const g = v.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(EPS, g.value), now);
      g.exponentialRampToValueAtTime(EPS, now + fade);
    } catch (_err) { /* the node may already be finished */ }
    for (let i = 0; i < v.sources.length; i++) {
      try { v.sources[i].stop(now + fade); } catch (_err) { /* already stopped */ }
    }
    v.endTime = now + fade + 0.03;
    this._dying.push(v);
  }

  /**
   * Disconnect a voice and return it to the pool.
   * @param {Voice} v the voice
   * @returns {void}
   * @private
   */
  _releaseVoice(v) {
    this._disconnectHolder(v);
    v.out = null;
    if (this._pool.length < 64) this._pool.push(v);
  }

  /**
   * Stop a looping voice (bow draw, TNT fuse, …).
   * @param {number} id handle returned by {@link AudioEngine#play}
   * @param {number} [fade=0.08] fade-out in seconds
   * @returns {boolean} `true` when a voice was found and stopped
   */
  stop(id, fade = 0.08) {
    if (!this.ready || !id) return false;
    for (let i = 0; i < this._voices.length; i++) {
      const v = this._voices[i];
      if (v.id !== id) continue;
      const now = this.ctx.currentTime;
      const f = Math.max(0.01, fade);
      try {
        const g = v.out.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(Math.max(EPS, g.value), now);
        g.exponentialRampToValueAtTime(EPS, now + f);
      } catch (_err) { /* ignore */ }
      for (let k = 0; k < v.sources.length; k++) {
        try { v.sources[k].stop(now + f); } catch (_err) { /* ignore */ }
      }
      this._voices.splice(i, 1);
      v.endTime = now + f + 0.03;
      this._dying.push(v);
      return true;
    }
    return false;
  }

  /**
   * Stop every sound effect immediately (music and ambience keep playing).
   * @returns {void}
   */
  stopAll() {
    if (!this.ready) return;
    while (this._voices.length > 0) this._steal(this._voices[0]);
  }

  /* ====================================================================== */
  /* Positional audio                                                       */
  /* ====================================================================== */

  /**
   * Low-pass cutoff for a sound at a given distance. Air and geometry swallow
   * the highs long before they swallow the level — this single filter is most
   * of what makes positional audio feel real.
   * @param {number} dist distance in blocks
   * @returns {number} cutoff frequency in Hz
   * @private
   */
  _distanceCutoff(dist) {
    return clampFreq(19000 * Math.exp(-Math.max(0, dist) * 0.045) + 260);
  }

  /**
   * Build a configured panner at a world position.
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @returns {PannerNode} the node
   * @private
   */
  _makePanner(x, y, z) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 3.5;
    p.maxDistance = this.maxDistance;
    p.rolloffFactor = 1.15;
    p.coneInnerAngle = 360;
    p.coneOuterAngle = 360;
    p.coneOuterGain = 1;
    if (p.positionX) {
      const t = this.ctx.currentTime;
      p.positionX.setValueAtTime(x, t);
      p.positionY.setValueAtTime(y, t);
      p.positionZ.setValueAtTime(z, t);
    } else if (typeof p.setPosition === 'function') {
      p.setPosition(x, y, z);
    }
    return p;
  }

  /**
   * Move the listener. Call this once per rendered frame from the camera.
   * @param {ArrayLike<number>} position world position `[x, y, z]`
   * @param {ArrayLike<number>} [forward] unit view direction `[x, y, z]`
   * @param {ArrayLike<number>} [up] unit up vector `[x, y, z]`
   * @returns {void}
   */
  setListener(position, forward, up) {
    if (position && position.length >= 3) {
      this._lisPos[0] = num(position[0], this._lisPos[0]);
      this._lisPos[1] = num(position[1], this._lisPos[1]);
      this._lisPos[2] = num(position[2], this._lisPos[2]);
    }
    if (forward && forward.length >= 3) {
      this._lisFwd[0] = num(forward[0], this._lisFwd[0]);
      this._lisFwd[1] = num(forward[1], this._lisFwd[1]);
      this._lisFwd[2] = num(forward[2], this._lisFwd[2]);
    }
    if (up && up.length >= 3) {
      this._lisUp[0] = num(up[0], this._lisUp[0]);
      this._lisUp[1] = num(up[1], this._lisUp[1]);
      this._lisUp[2] = num(up[2], this._lisUp[2]);
    }
    if (!this.ready) return;
    try {
      const l = this.ctx.listener;
      const t = this.ctx.currentTime;
      const p = this._lisPos;
      const f = this._lisFwd;
      const u = this._lisUp;
      if (l.positionX) {
        l.positionX.setTargetAtTime(p[0], t, 0.015);
        l.positionY.setTargetAtTime(p[1], t, 0.015);
        l.positionZ.setTargetAtTime(p[2], t, 0.015);
        l.forwardX.setTargetAtTime(f[0], t, 0.015);
        l.forwardY.setTargetAtTime(f[1], t, 0.015);
        l.forwardZ.setTargetAtTime(f[2], t, 0.015);
        l.upX.setTargetAtTime(u[0], t, 0.015);
        l.upY.setTargetAtTime(u[1], t, 0.015);
        l.upZ.setTargetAtTime(u[2], t, 0.015);
      } else {
        if (typeof l.setPosition === 'function') l.setPosition(p[0], p[1], p[2]);
        if (typeof l.setOrientation === 'function') l.setOrientation(f[0], f[1], f[2], u[0], u[1], u[2]);
      }
    } catch (err) {
      warnOnce('listener', 'the listener could not be updated', err);
    }
  }

  /**
   * Crossfade to another reverb impulse response. The tail of the old preset
   * is faded out on its own convolver, so switching never clicks.
   * @param {('outdoors'|'room'|'cave'|'underwater'|string)} preset preset name
   * @param {number} [fade=1.5] crossfade time in seconds
   * @returns {void}
   */
  setReverb(preset, fade = 1.5) {
    if (!this.ready) return;
    if (!REVERB_PRESETS[preset] || preset === this._reverbPreset) return;
    try {
      const next = (this._convActive + 1) % 2;
      const p = REVERB_PRESETS[preset];
      this._convolvers[next].buffer = this._impulse(preset);
      const t = this.ctx.currentTime;
      this._ramp(this._convGains[next].gain, p.wet, t, fade);
      this._ramp(this._convGains[this._convActive].gain, 0, t, fade);
      this._convActive = next;
      this._reverbPreset = preset;
      this._reverbWet = p.wet;
    } catch (err) {
      warnOnce('reverb', 'switching the reverb preset failed', err);
    }
  }

  /**
   * Muffle everything, as if the player's head were under water or inside a
   * helmet.
   * @param {boolean} submerged `true` while the camera is inside a fluid
   * @returns {void}
   */
  setSubmerged(submerged) {
    const flag = submerged === true;
    if (flag === this._submerged) return;
    this._submerged = flag;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._ramp(this._muffle.frequency, flag ? 480 : 18000, t, 0.35);
    this.setReverb(flag ? 'underwater' : (this._underground ? 'cave' : 'outdoors'), 0.8);
    this._refreshBedTargets();
  }

  /* ====================================================================== */
  /* Playback                                                               */
  /* ====================================================================== */

  /**
   * Play a synthesised sound.
   *
   * Known names are the keys of the recipe table plus the two generated
   * families `block.<group>.<action>` and `mob.<type>.<kind>`. An unknown name
   * degrades to a soft UI tick and logs once.
   *
   * @param {string} name event name, e.g. `'explode'` or `'mob.zombie.hurt'`
   * @param {{x?:number, y?:number, z?:number, volume?:number, pitch?:number,
   *   loop?:boolean, reverb?:number, priority?:number, delay?:number}} [opts]
   *   `x/y/z` make the sound positional, `volume` defaults to 1, `pitch`
   *   multiplies every frequency, `loop` keeps the sound alive until
   *   {@link AudioEngine#stop}, `delay` postpones it by seconds.
   * @returns {number} a handle usable with {@link AudioEngine#stop}, or `0`
   *   when nothing was played
   */
  play(name, opts = {}) {
    if (!this.ready || this.muted || this.failed) return 0;
    const key = typeof name === 'string' ? name : '';
    if (!key) return 0;
    try {
      const recipe = this._resolve(key);
      if (!recipe) return 0;
      const v = this._beginVoice(key, opts);
      if (!v) return 0;
      const o = {
        t: this.ctx.currentTime + Math.max(0, num(opts.delay, 0)) + 0.005,
        gain: 1,
        pitch: clamp(num(opts.pitch, 1), 0.25, 4),
        loop: opts.loop === true,
        engine: this,
      };
      let dur = 0.4;
      try {
        dur = num(recipe(this, v, o), 0.4);
      } catch (err) {
        warnOnce(`recipe:${key}`, `the sound "${key}" could not be synthesised`, err);
        this._disconnectHolder(v);
        this._pool.push(v);
        return 0;
      }
      return this._endVoice(v, dur + Math.max(0, num(opts.delay, 0)));
    } catch (err) {
      warnOnce(`play:${key}`, `playing "${key}" failed`, err);
      return 0;
    }
  }

  /**
   * Play a non-positional interface sound.
   * @param {string} name event name, e.g. `'click'`, `'ui_open'`, `'levelup'`
   * @param {{volume?:number, pitch?:number}} [opts] optional level and pitch
   * @returns {number} a playback handle, or `0`
   */
  playUI(name, opts = {}) {
    if (!this.ready) return 0;
    return this.play(name, {
      volume: clamp(num(opts.volume, 0.85), 0, 2),
      pitch: num(opts.pitch, 1),
      reverb: 0.25,
      priority: 1.6,
    });
  }

  /**
   * Play the material sound of a block. The block id is mapped to its sound
   * group through `world/blocks.js#blockSound`, and a small random pitch
   * variation is applied so repeated digging never sounds identical.
   * @param {('break'|'place'|'step'|'hit'|'dig'|string)} action what happened
   * @param {number} blockId block id
   * @param {number} x world X of the block centre
   * @param {number} y world Y
   * @param {number} z world Z
   * @returns {number} a playback handle, or `0`
   */
  playBlockSound(action, blockId, x, y, z) {
    if (!this.ready || this.muted) return 0;
    let group = 'stone';
    try {
      group = blockSound(blockId) || 'stone';
    } catch (err) {
      warnOnce('blockSound', 'the block sound group could not be resolved', err);
    }
    if (!GROUPS[group]) group = 'stone';
    const act = ACTIONS[action] ? action : 'hit';
    const jitter = 0.92 + Math.random() * 0.17;
    return this.play(`block.${group}.${act}`, {
      x, y, z,
      pitch: jitter,
      volume: act === 'break' ? 1 : 0.9,
      priority: act === 'hit' || act === 'step' ? 0.6 : 1.1,
    });
  }

  /**
   * Resolve an event name to a synthesis function.
   * @param {string} name event name
   * @returns {?((eng:AudioEngine, v:Object, o:Object) => number)} recipe or null
   * @private
   */
  _resolve(name) {
    const direct = RECIPES[name];
    if (direct) return direct;
    const alias = ALIASES[name];
    if (alias && RECIPES[alias]) return RECIPES[alias];
    if (name.charCodeAt(0) === 98 /* b */ && name.startsWith('block.')) {
      const parts = name.split('.');
      const g = GROUPS[parts[1]] || GROUPS.stone;
      const act = ACTIONS[parts[2]] ? parts[2] : 'hit';
      return (eng, v, o) => digSynth(eng, v, o, g, act);
    }
    if (name.charCodeAt(0) === 109 /* m */ && name.startsWith('mob.')) {
      const parts = name.split('.');
      const voice = MOB_VOICES[parts[1]] || MOB_VOICES.zombie;
      const kind = MOB_KINDS[parts[2]] ? parts[2] : 'idle';
      return (eng, v, o) => mobSynth(eng, v, o, voice, kind);
    }
    warnOnce(`unknown:${name}`, `unknown sound "${name}" — playing a neutral tick instead`);
    return RECIPES.click;
  }

  /* ====================================================================== */
  /* Ambience                                                               */
  /* ====================================================================== */

  /**
   * Crossfade the ambience beds to match the player's surroundings. Also picks
   * the reverb preset and, while {@link AudioEngine#autoMood} is on, the music
   * mood. Cheap enough to call every game tick — nothing happens unless a
   * target actually moved.
   * @param {number} biomeId biome id at the player's position
   * @param {boolean} isNight `true` between dusk and dawn
   * @param {('clear'|'rain'|'thunder'|'snow'|string)} weather current weather
   * @param {boolean} underground `true` when the player has no sky access
   * @returns {void}
   */
  setAmbience(biomeId, isNight, weather, underground) {
    this._biomeId = num(biomeId, 0) | 0;
    this._isNight = isNight === true;
    this._weather = typeof weather === 'string' ? weather : 'clear';
    this._underground = underground === true;
    if (!this.ready) return;
    try {
      this._refreshBedTargets();
      if (!this._submerged) {
        this.setReverb(this._underground ? 'cave' : 'outdoors', 2.5);
      }
      if (this.autoMood && this._musicOn) {
        const mood = moodForBiome(this._biomeId, this._isNight, this._underground,
          this.ctx.currentTime < this._combatUntil);
        if (mood !== this._mood) this._setMood(mood);
      }
    } catch (err) {
      warnOnce('ambience', 'the ambience could not be updated', err);
    }
  }

  /**
   * Report that lava is burning near the player, which enables the lava bed.
   * @param {boolean} near `true` when lava is within earshot
   * @returns {void}
   */
  setNearLava(near) {
    const flag = near === true;
    if (flag === this._nearLava) return;
    this._nearLava = flag;
    if (this.ready) this._refreshBedTargets();
  }

  /**
   * Recompute every bed's target gain from the stored ambience state.
   * @returns {void}
   * @private
   */
  _refreshBedTargets() {
    const t = this._bedTargets;
    const weather = this._weather;
    const raining = weather === 'rain' || weather === 'thunder';
    const snowing = weather === 'snow';
    const under = this._underground;
    const wet = this._submerged;

    let biome = null;
    try { biome = getBiome(this._biomeId); } catch (_err) { biome = null; }
    const exposed = biome ? (biome.category === 'ocean' || biome.humidity < 0.35 ? 1.25 : 1) : 1;
    const temperate = biome ? (biome.temperature > 0.2 && biome.temperature < 1.4) : true;

    t.wind = wet ? 0 : (under ? 0.06 : clamp(0.22 * exposed + (raining ? 0.18 : 0), 0, 0.55));
    t.rain = wet ? 0.1 : (under ? 0.05 : (raining ? (weather === 'thunder' ? 0.85 : 0.7) : (snowing ? 0.12 : 0)));
    t.cave = under && !wet ? 0.65 : 0;
    t.water = wet ? 0.9 : 0;
    t.lava = this._nearLava ? (under ? 0.7 : 0.45) : 0;
    t.night = !wet && !under && this._isNight && !raining && temperate ? 0.32 : 0;

    const now = this.ctx.currentTime;
    for (const name of BED_NAMES) {
      const target = clamp(num(t[name], 0), 0, 1);
      let bed = this._beds.get(name);
      if (!bed && target > 0.005) {
        bed = this._createBed(name);
        if (bed) this._beds.set(name, bed);
      }
      if (!bed) continue;
      bed.target = target;
      bed.idleSince = target > 0.005 ? -1 : (bed.idleSince < 0 ? now : bed.idleSince);
      try {
        bed.gain.gain.cancelScheduledValues(now);
        bed.gain.gain.setValueAtTime(Math.max(EPS, bed.gain.gain.value), now);
        bed.gain.gain.setTargetAtTime(Math.max(EPS, target), now, target > 0.005 ? 1.4 : 2.2);
      } catch (err) {
        warnOnce('bedfade', 'an ambience crossfade failed', err);
      }
    }
  }

  /**
   * Build one ambience bed.
   * @param {string} name a member of {@link BED_NAMES}
   * @returns {?Object} the bed, or `null` when it has no builder
   * @private
   */
  _createBed(name) {
    const build = BED_BUILDERS[name];
    if (!build) return null;
    const bed = {
      name,
      gain: this.ctx.createGain(),
      nodes: [],
      sources: [],
      target: 0,
      nextEvent: this.ctx.currentTime + 0.3,
      idleSince: -1,
    };
    bed.gain.gain.value = EPS;
    bed.gain.connect(this._ambienceBus);
    try {
      build(this, bed);
    } catch (err) {
      warnOnce(`bed:${name}`, `the ambience bed "${name}" could not be built`, err);
    }
    return bed;
  }

  /**
   * Stop and disconnect a bed.
   * @param {Object} bed the bed
   * @returns {void}
   * @private
   */
  _destroyBed(bed) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (let i = 0; i < bed.sources.length; i++) {
      try { bed.sources[i].stop(now); } catch (_err) { /* already stopped */ }
    }
    this._disconnectHolder(bed);
    try { bed.gain.disconnect(); } catch (_err) { /* ignore */ }
  }

  /**
   * Schedule the sparse random events of every audible bed and tear down beds
   * that have been silent for a while.
   * @param {number} now audio-clock time
   * @returns {void}
   * @private
   */
  _pumpAmbience(now) {
    for (const [name, bed] of this._beds) {
      if (bed.target <= 0.005) {
        if (bed.idleSince >= 0 && now - bed.idleSince > 6) {
          this._destroyBed(bed);
          this._beds.delete(name);
        }
        continue;
      }
      const spawn = BED_EVENTS[name];
      if (!spawn) continue;
      let guard = 0;
      while (bed.nextEvent < now + 0.8 && guard++ < 24) {
        const t = Math.max(now + 0.02, bed.nextEvent);
        let delay = 1;
        try {
          delay = num(spawn(this, bed, t), 1);
        } catch (err) {
          warnOnce(`bedevent:${name}`, `an ambience event of "${name}" failed`, err);
          delay = 4;
        }
        bed.nextEvent = t + Math.max(0.04, delay);
      }
    }
  }

  /**
   * Distant thunder while a storm is running.
   * @param {number} now audio-clock time
   * @returns {void}
   * @private
   */
  _pumpWeather(now) {
    if (this._weather !== 'thunder' || this._submerged) {
      if (this._nextThunder === 0) this._nextThunder = now + 8 + Math.random() * 20;
      return;
    }
    if (this._nextThunder === 0) this._nextThunder = now + 6 + Math.random() * 18;
    if (now < this._nextThunder) return;
    this._nextThunder = now + 14 + Math.random() * 46;
    this.play('thunder', {
      volume: 0.35 + Math.random() * 0.35,
      pitch: 0.8 + Math.random() * 0.3,
      priority: 1.4,
    });
  }

  /* ====================================================================== */
  /* Generative music                                                       */
  /* ====================================================================== */

  /**
   * Start (or switch to) a generative music mood. The engine does not begin a
   * piece instantly: it waits for the current silence to expire, so the score
   * stays sparse. Calling it while a piece runs crossfades the mood over ~7 s.
   * @param {('calm'|'night'|'cave'|'danger'|string)} mood mood name
   * @returns {void}
   */
  startMusic(mood) {
    const name = MOODS[mood] ? mood : 'calm';
    this._musicOn = true;
    if (!this.ready) {
      this._mood = name;
      return;
    }
    this._setMood(name);
  }

  /**
   * Switch the active mood, crossfading any running layer.
   * @param {string} mood mood name
   * @returns {void}
   * @private
   */
  _setMood(mood) {
    if (this._mood === mood) return;
    this._mood = mood;
    const now = this.ctx.currentTime;
    let live = 0;
    for (const layer of this._layers) {
      if (layer.dying || layer.disc) continue;
      live++;
      layer.dying = true;
      layer.expires = now + 8;
      this._ramp(layer.gain.gain, 0, now, 7);
    }
    if (live > 0) {
      const next = this._createLayer(mood, MOODS[mood], 0);
      if (next) {
        next.nextBar = now + 0.4;
        next.pieceEnd = now + 70 + this._rng() * 70;
        this._ramp(next.gain.gain, 1, now, 7);
        this._layers.push(next);
      }
    }
  }

  /**
   * Fade the score out and stop scheduling.
   * @returns {void}
   */
  stopMusic() {
    this._musicOn = false;
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    for (const layer of this._layers) {
      layer.dying = true;
      layer.expires = now + 3;
      this._ramp(layer.gain.gain, 0, now, 2.5);
    }
    this._musicIdleUntil = now + 30;
  }

  /**
   * Enable or disable automatic mood selection from
   * {@link AudioEngine#setAmbience}.
   * @param {boolean} enabled `true` to let the ambience drive the mood
   * @returns {void}
   */
  setAutoMood(enabled) {
    this.autoMood = enabled !== false;
  }

  /**
   * Duck the music because combat started. The duck releases on its own.
   * @param {number} [seconds=7] how long the fight is assumed to last
   * @returns {void}
   */
  notifyCombat(seconds = 7) {
    if (!this.ready) return;
    this._combatUntil = this.ctx.currentTime + Math.max(0.5, num(seconds, 7));
    if (!this._ducked) {
      this._ducked = true;
      this._ramp(this._musicDuck.gain, 0.3, this.ctx.currentTime, 0.5);
    }
    if (this.autoMood && this._musicOn && this._mood !== 'danger') this._setMood('danger');
  }

  /**
   * Play one of the thirteen generative music-disc pieces in a jukebox.
   * The piece is deterministic: the same disc always renders the same music.
   * @param {string} track track name from `game/items.js#musicDiscTrack`
   * @param {{x?:number, y?:number, z?:number}} [opts] jukebox position (unused
   *   for the mix, kept for symmetry with {@link AudioEngine#play})
   * @returns {boolean} `true` when the disc started
   */
  playDisc(track, opts = {}) {
    if (!this.ready || typeof track !== 'string') return false;
    try {
      this.stopDisc();
      const seed = hashString(track);
      const profile = DISC_PROFILES[track] || DISC_PROFILES.disc_13;
      const layer = this._createLayer(`disc:${track}`, MOODS[profile.mood], seed);
      if (!layer) return false;
      layer.disc = true;
      layer.profileOverride = profile;
      layer.melodyBoost = 1;
      const now = this.ctx.currentTime;
      layer.nextBar = now + 0.25;
      layer.pieceEnd = now + profile.length;
      layer.gain.gain.value = EPS;
      this._ramp(layer.gain.gain, 1.25, now, 1.5);
      this._layers.push(layer);
      this._discUntil = layer.pieceEnd;
      void opts;
      return true;
    } catch (err) {
      warnOnce('disc', 'the music disc could not be started', err);
      return false;
    }
  }

  /**
   * Stop a running music disc.
   * @returns {void}
   */
  stopDisc() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    for (const layer of this._layers) {
      if (!layer.disc || layer.dying) continue;
      layer.dying = true;
      layer.expires = now + 2.5;
      this._ramp(layer.gain.gain, 0, now, 2);
    }
    this._discUntil = 0;
  }

  /**
   * Create an empty music layer wired to the duck bus.
   * @param {string} mood mood name (or `disc:<track>`)
   * @param {Object} profile a member of {@link MOODS}
   * @param {number} seed PRNG seed; `0` picks a random one
   * @returns {?Object} the layer
   * @private
   */
  _createLayer(mood, profile, seed) {
    if (!profile) return null;
    const gain = this.ctx.createGain();
    gain.gain.value = EPS;
    gain.connect(this._musicDuck);
    return {
      mood,
      profile,
      profileOverride: null,
      gain,
      nodes: [gain],
      sources: [],
      rng: mulberry32(seed || ((Math.random() * 0x7fffffff) | 0)),
      bar: 0,
      chordIndex: 0,
      nextBar: 0,
      pieceEnd: 0,
      dying: false,
      disc: false,
      expires: 0,
      melodyBoost: 0,
    };
  }

  /**
   * Disconnect a music layer.
   * @param {Object} layer the layer
   * @returns {void}
   * @private
   */
  _destroyLayer(layer) {
    this._disconnectHolder(layer);
    try { layer.gain.disconnect(); } catch (_err) { /* ignore */ }
  }

  /**
   * Advance the generative score: retire finished layers, start new pieces
   * after the silence, and schedule bars two seconds ahead of the audio clock.
   * @param {number} now audio-clock time
   * @returns {void}
   * @private
   */
  _pumpMusic(now) {
    /* release the combat duck */
    if (this._ducked && now > this._combatUntil) {
      this._ducked = false;
      this._ramp(this._musicDuck.gain, 1, now, 3.5);
    }

    /* retire layers */
    for (let i = this._layers.length - 1; i >= 0; i--) {
      const layer = this._layers[i];
      if (layer.dying && now > layer.expires) {
        this._destroyLayer(layer);
        this._layers.splice(i, 1);
        continue;
      }
      if (!layer.dying && now > layer.pieceEnd) {
        layer.dying = true;
        layer.expires = now + 12;
        this._ramp(layer.gain.gain, 0, now, 10);
        if (!layer.disc) this._musicIdleUntil = now + 90 + this._rng() * 150;
      }
    }

    if (this._setting('musicVolume', 0.4) <= 0.001) return;

    /* start a new piece after the silence */
    if (this._musicOn && !this._submerged && now > this._musicIdleUntil) {
      let hasLive = false;
      for (const layer of this._layers) if (!layer.dying && !layer.disc) hasLive = true;
      if (!hasLive && this._discUntil < now) {
        const mood = this._mood || 'calm';
        const layer = this._createLayer(mood, MOODS[mood] || MOODS.calm, 0);
        if (layer) {
          layer.nextBar = now + 1.5;
          layer.pieceEnd = now + 70 + this._rng() * 70;
          this._ramp(layer.gain.gain, 1, now, 6);
          this._layers.push(layer);
        }
      }
    }

    /* schedule bars */
    for (const layer of this._layers) {
      if (layer.dying) continue;
      let guard = 0;
      while (layer.nextBar < now + 2 && guard++ < 8) {
        const t = Math.max(now + 0.05, layer.nextBar);
        let barLen = 4;
        try {
          barLen = num(this._scheduleBar(layer, t), 4);
        } catch (err) {
          warnOnce('bar', 'a music bar could not be scheduled', err);
          barLen = 4;
        }
        layer.nextBar = t + barLen;
        layer.bar++;
      }
    }
  }

  /**
   * Render one bar of a layer: pad chord, bass root and a probabilistic melody.
   * @param {Object} layer the layer
   * @param {number} t bar start on the audio clock
   * @returns {number} the bar length in seconds
   * @private
   */
  _scheduleBar(layer, t) {
    const p = layer.profile;
    const ov = layer.profileOverride;
    const tempo = ov ? ov.tempo : p.tempo;
    const bar = (60 / tempo) * 4;
    const rng = layer.rng;
    const chord = p.chords[layer.chordIndex % p.chords.length];
    layer.chordIndex++;

    /* ---- pad: two detuned oscillators per chord tone --------------------- */
    const padGain = ov ? ov.pad : p.pad;
    if (padGain > 0.001) {
      const h = this.transient(t + bar * 1.6);
      const lp = this.biquad(h, 'lowpass', p.padCutoff * 0.7, 3);
      const env = this.gainNode(h, 0);
      this.chain(lp, env, layer.gain);
      this.sweep(lp.frequency, t, p.padCutoff * 0.55, p.padCutoff * 1.25, bar * 0.7);
      this.envAHD(env.gain, t, padGain, bar * 0.3, bar * 0.25, bar * 0.55);
      for (let i = 0; i < chord.length; i++) {
        const oct = i === 0 ? 0 : (rng() < 0.25 ? 12 : 0);
        const f = midiToFreq(p.root + chord[i] + oct);
        const a = this.oscNode(h, p.padWave, f, t, bar * 1.15, -6 - rng() * 5);
        const b = this.oscNode(h, p.padWave, f, t, bar * 1.15, 6 + rng() * 5);
        const mix = this.gainNode(h, 0.32 / chord.length);
        this.chain(a, mix, lp);
        b.connect(mix);
      }
    }

    /* ---- bass ------------------------------------------------------------ */
    if (p.bass > 0.001 && (layer.bar % 2 === 0 || rng() < 0.4)) {
      const h = this.transient(t + bar);
      const f = midiToFreq(p.root + chord[0] - 12);
      const osc = this.oscNode(h, 'sine', f, t, bar * 0.85);
      const sub = this.oscNode(h, 'triangle', f, t, bar * 0.85, 4);
      const env = this.gainNode(h, 0);
      this.chain(osc, env, layer.gain);
      sub.connect(env);
      this.envAHD(env.gain, t, p.bass, 0.12, bar * 0.28, bar * 0.5);
    }

    /* ---- melody ---------------------------------------------------------- */
    const density = clamp((ov ? ov.melody : p.melody) + layer.melodyBoost * 0.3, 0, 1);
    const slots = 8;
    let lastDeg = -99;
    for (let s = 0; s < slots; s++) {
      if (rng() > density * (s % 2 === 0 ? 1 : 0.45)) continue;
      const scale = p.scale;
      let deg;
      if (rng() < 0.6) {
        deg = chord[(rng() * chord.length) | 0];
      } else {
        deg = scale[(rng() * scale.length) | 0];
      }
      if (deg === lastDeg && rng() < 0.7) deg += scale[1] || 2;
      lastDeg = deg;
      const oct = p.melodyOctave + (rng() < 0.22 ? 12 : 0);
      const f = midiToFreq(p.root + deg + oct);
      const nt = t + (s / slots) * bar + (rng() - 0.5) * 0.02;
      const dur = bar / slots * (1.2 + rng() * 2.4);
      this._scheduleNote(layer, f, nt, dur, p.melodyGain * (0.6 + rng() * 0.5), p.melodyWave);
    }
    return bar;
  }

  /**
   * One melodic note: a filtered oscillator pair with a soft bell-like decay.
   * @param {Object} layer owning layer
   * @param {number} freq pitch in Hz
   * @param {number} t start on the audio clock
   * @param {number} dur length in seconds
   * @param {number} level peak gain
   * @param {OscillatorType} wave waveform
   * @returns {void}
   * @private
   */
  _scheduleNote(layer, freq, t, dur, level, wave) {
    const h = this.transient(t + dur + 0.6);
    const osc = this.oscNode(h, wave, freq, t, dur + 0.4);
    const shim = this.oscNode(h, 'sine', freq * 2, t, dur + 0.4);
    const lp = this.biquad(h, 'lowpass', clampFreq(freq * 7 + 900), 1.2);
    const env = this.gainNode(h, 0);
    const shimGain = this.gainNode(h, 0.16);
    this.chain(osc, lp, env, layer.gain);
    this.chain(shim, shimGain, lp);
    this.envAD(env.gain, t, level, 0.035, dur);
  }

  /* ====================================================================== */
  /* Pump                                                                   */
  /* ====================================================================== */

  /**
   * Housekeeping, driven by an internal 100 ms timer against the audio clock.
   * It recycles voices, tears down silent beds and schedules music.
   * @returns {void}
   * @private
   */
  _pump() {
    if (!this.ready || !this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      this._reap(now);
      this._pumpAmbience(now);
      this._pumpWeather(now);
      this._pumpMusic(now);
    } catch (err) {
      warnOnce('pump', 'the audio housekeeping pass failed', err);
    }
  }

  /**
   * Recycle finished voices and disconnect finished transient nodes.
   * @param {number} now audio-clock time
   * @returns {void}
   * @private
   */
  _reap(now) {
    for (let i = this._voices.length - 1; i >= 0; i--) {
      const v = this._voices[i];
      if (v.endTime > now) continue;
      this._voices.splice(i, 1);
      this._releaseVoice(v);
    }
    for (let i = this._dying.length - 1; i >= 0; i--) {
      const v = this._dying[i];
      if (v.endTime > now) continue;
      this._dying.splice(i, 1);
      this._releaseVoice(v);
    }
    for (let i = this._scheduled.length - 1; i >= 0; i--) {
      const s = this._scheduled[i];
      if (s.end > now) continue;
      this._scheduled.splice(i, 1);
      this._disconnectHolder(s.h);
    }
  }

  /**
   * Optional per-frame hook. The engine keeps itself alive with its own timer,
   * so this only exists so the Game can hand over the frame delta without
   * having to special-case audio. It never allocates.
   * @param {number} dt seconds since the previous call
   * @returns {void}
   */
  update(dt) {
    if (!this.ready) return;
    void dt;
  }
}
