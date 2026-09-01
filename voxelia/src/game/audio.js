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
    /** @type {AudioNode[]} fixed sends that dispose() must also release. @private */
    this._fixedSends = [];
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
    /** @type {number} seconds accumulated by {@link AudioEngine#update}. @private */
    this._sincePump = 0;
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
      this._fixedSends.push(ambSend, musicSend);

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
    /* the fixed mixing graph itself */
    const fixed = [this._sfxBus, this._ambienceBus, this._musicDuck, this._musicBus,
      this._muffle, this._reverbSend, this._reverbReturn, this._master, this._compressor];
    for (const node of this._convolvers) fixed.push(node);
    for (const node of this._convGains) fixed.push(node);
    for (const node of this._fixedSends) fixed.push(node);
    for (const node of fixed) {
      if (!node) continue;
      try { node.disconnect(); } catch (_err) { /* already gone */ }
    }
    this._convolvers.length = 0;
    this._convGains.length = 0;
    this._fixedSends.length = 0;
    this._master = null;
    this._compressor = null;
    this._sfxBus = null;
    this._muffle = null;
    this._musicBus = null;
    this._musicDuck = null;
    this._ambienceBus = null;
    this._reverbSend = null;
    this._reverbReturn = null;
    this._white = null;
    this._brown = null;
    this._pluck = null;
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
      const score = v.audible * (0.6 + v.priority * 0.4) - age * 0.25 + (v.loop ? 0.5 : 0);
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
        const produced = recipe(this, v, o);
        if (typeof produced === 'number' && !Number.isNaN(produced)) dur = produced;
      } catch (err) {
        warnOnce(`recipe:${key}`, `the sound "${key}" could not be synthesised`, err);
        this._releaseVoice(v);
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

    const storm = weather === 'thunder' ? 1 : (raining ? 0.65 : (snowing ? 0.4 : 0));
    t.wind = wet ? 0 : (under ? 0.06 : clamp(lerp(0.2, 0.5, storm) * exposed, 0, 0.6));
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
    let hasLive = false;
    for (const layer of this._layers) if (!layer.dying && !layer.disc) hasLive = true;
    if (!hasLive) {
      this._mood = name;
      this._musicIdleUntil = Math.min(this._musicIdleUntil, this.ctx.currentTime + 3);
    } else {
      this._setMood(name);
    }
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
   *
   * A disc obeys the music volume but bypasses the combat duck — a record the
   * player deliberately put on should not dip when a zombie turns up. Passing
   * the jukebox position makes the record audible only around the block, with
   * the same panning and distance rolloff as any other world sound.
   *
   * @param {string} track track name from `game/items.js#musicDiscTrack`
   * @param {{x?:number, y?:number, z?:number}} [opts] jukebox block position;
   *   omit it to play the disc as flat, non-positional music
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
      /* re-route: discs skip the combat duck, and follow the jukebox in space */
      try { layer.gain.disconnect(); } catch (_err) { /* not connected yet */ }
      if (opts && opts.x !== undefined && opts.y !== undefined && opts.z !== undefined) {
        const lpf = this.biquad(layer, 'lowpass', 7000, 0.7);
        const panner = this._makePanner(num(opts.x, 0), num(opts.y, 0), num(opts.z, 0));
        layer.nodes.push(panner);
        this.chain(layer.gain, lpf, panner, this._musicBus);
      } else {
        layer.gain.connect(this._musicBus);
      }
      const now = this.ctx.currentTime;
      layer.nextBar = now + 0.25;
      layer.pieceEnd = now + profile.length;
      layer.gain.gain.value = EPS;
      this._ramp(layer.gain.gain, 1.25, now, 1.5);
      this._layers.push(layer);
      this._discUntil = layer.pieceEnd;
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
   * Per-frame fallback for the housekeeping pass. The engine normally drives
   * itself from a 100 ms timer; where `setInterval` is unavailable this method
   * takes over, running the same pass at most ten times a second. Calling it is
   * always safe and never allocates.
   * @param {number} dt seconds since the previous call
   * @returns {void}
   */
  update(dt) {
    if (!this.ready) return;
    if (this._pumpTimer !== null) return;
    this._sincePump += Math.max(0, num(dt, 0));
    if (this._sincePump < 0.1) return;
    this._sincePump = 0;
    this._pump();
  }
}

/* ========================================================================== */
/* Shared synthesis primitives                                                */
/* ========================================================================== */

/**
 * A filtered noise burst with an attack/decay envelope. Returns the filter so
 * the caller can sweep it.
 * @param {AudioEngine} eng the engine
 * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
 * @param {AudioNode} out destination node
 * @param {number} t start time
 * @param {number} level peak gain
 * @param {number} dur decay length in seconds
 * @param {BiquadFilterType} type filter type
 * @param {number} freq filter frequency
 * @param {number} q filter quality
 * @param {number} [rate=1] noise playback rate
 * @param {number} [attack=0.003] attack length
 * @param {boolean} [brown=false] use brown noise
 * @returns {BiquadFilterNode} the filter, for further modulation
 */
function noiseBurst(eng, h, out, t, level, dur, type, freq, q, rate = 1, attack = 0.003, brown = false) {
  const src = eng.noiseNode(h, t, dur + attack + 0.06, rate, brown);
  const f = eng.biquad(h, type, freq, q);
  const g = eng.gainNode(h, 0);
  eng.chain(src, f, g, out);
  eng.envAD(g.gain, t, level, attack, dur);
  return f;
}

/**
 * A pitched thump: one oscillator sweeping downwards under a fast envelope.
 * @param {AudioEngine} eng the engine
 * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
 * @param {AudioNode} out destination node
 * @param {number} t start time
 * @param {number} level peak gain
 * @param {number} f0 start frequency
 * @param {number} f1 end frequency
 * @param {number} dur decay length
 * @param {OscillatorType} [wave='sine'] waveform
 * @returns {void}
 */
function thump(eng, h, out, t, level, f0, f1, dur, wave = 'sine') {
  const osc = eng.oscNode(h, wave, f0, t, dur + 0.05);
  const g = eng.gainNode(h, 0);
  eng.chain(osc, g, out);
  eng.sweep(osc.frequency, t, f0, f1, dur);
  eng.envAD(g.gain, t, level, 0.004, dur);
}

/**
 * A two-operator FM bell. The modulator index decays faster than the carrier,
 * which is exactly what makes a bell sound like a bell.
 * @param {AudioEngine} eng the engine
 * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
 * @param {AudioNode} out destination node
 * @param {number} t start time
 * @param {number} freq carrier frequency
 * @param {number} dur decay length
 * @param {number} level peak gain
 * @param {number} [ratio=3.51] modulator/carrier frequency ratio
 * @param {number} [index=620] peak modulation depth in Hz
 * @returns {void}
 */
function fmBell(eng, h, out, t, freq, dur, level, ratio = 3.51, index = 620) {
  const car = eng.oscNode(h, 'sine', freq, t, dur + 0.08);
  const mod = eng.oscNode(h, 'sine', freq * ratio, t, dur + 0.08);
  const depth = eng.gainNode(h, 0);
  const g = eng.gainNode(h, 0);
  mod.connect(depth);
  try { depth.connect(car.frequency); } catch (_err) { /* ignore */ }
  eng.chain(car, g, out);
  eng.envAD(depth.gain, t, index, 0.002, dur * 0.35);
  eng.envAD(g.gain, t, level, 0.004, dur);
}

/**
 * A burst of tiny impulses — the basis of rattles, crackles and gravel.
 * @param {AudioEngine} eng the engine
 * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
 * @param {AudioNode} out destination node
 * @param {number} t start time
 * @param {number} count how many impulses
 * @param {number} spread average spacing in seconds
 * @param {number} freq band centre
 * @param {number} q band quality
 * @param {number} level peak gain of the loudest impulse
 * @param {number} [dur=0.03] length of a single impulse
 * @returns {number} total length in seconds
 */
function impulseTrain(eng, h, out, t, count, spread, freq, q, level, dur = 0.03) {
  let cursor = t;
  for (let i = 0; i < count; i++) {
    const f = freq * (0.7 + eng.rand() * 0.75);
    noiseBurst(eng, h, out, cursor, level * (0.45 + eng.rand() * 0.6), dur, 'bandpass', f, q, 1, 0.0015);
    cursor += spread * (0.45 + eng.rand() * 1.2);
  }
  return cursor - t + dur;
}

/**
 * A resonant sweep — used for creaking doors, hisses and whooshes.
 * @param {AudioEngine} eng the engine
 * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
 * @param {AudioNode} out destination node
 * @param {number} t start time
 * @param {number} level peak gain
 * @param {number} dur length in seconds
 * @param {number} f0 start centre frequency
 * @param {number} f1 end centre frequency
 * @param {number} q resonance
 * @param {number} [attack=0.02] attack length
 * @returns {void}
 */
function sweepNoise(eng, h, out, t, level, dur, f0, f1, q, attack = 0.02) {
  const f = noiseBurst(eng, h, out, t, level, dur, 'bandpass', f0, q, 1, attack);
  eng.sweep(f.frequency, t, f0, f1, dur);
}

/**
 * Inharmonic sine partials, the fingerprint of glass and struck metal.
 * @param {AudioEngine} eng the engine
 * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
 * @param {AudioNode} out destination node
 * @param {number} t start time
 * @param {number} base fundamental in Hz
 * @param {readonly number[]} ratios partial frequency ratios
 * @param {number} decay decay of the first partial in seconds
 * @param {number} level peak gain of the first partial
 * @returns {void}
 */
function partials(eng, h, out, t, base, ratios, decay, level) {
  for (let i = 0; i < ratios.length; i++) {
    const f = clampFreq(base * ratios[i]);
    const d = decay * Math.pow(0.72, i);
    const osc = eng.oscNode(h, 'sine', f, t, d + 0.05);
    const g = eng.gainNode(h, 0);
    eng.chain(osc, g, out);
    eng.envAD(g.gain, t, level * Math.pow(0.62, i), 0.002, d);
  }
}

/* ========================================================================== */
/* Block material synthesis                                                   */
/* ========================================================================== */

/**
 * Synthesise a dig / step / place / break / hit sound for one material class.
 * Everything is derived from the {@link GROUPS} descriptor, so the same
 * generator serves all eleven material families.
 * @param {AudioEngine} eng the engine
 * @param {Voice} v the voice being filled
 * @param {Object} o playback options (`t`, `gain`, `pitch`)
 * @param {Object} g a {@link GROUPS} descriptor
 * @param {string} action a key of {@link ACTIONS}
 * @returns {number} the length of the sound in seconds
 */
function digSynth(eng, v, o, g, action) {
  const m = ACTIONS[action] || ACTIONS.hit;
  const t = o.t;
  const out = v.out;
  const pitch = o.pitch * m.pitch;
  const dur = g.dur * m.dur;
  const level = o.gain * g.gain * m.gain;

  const grains = Math.max(1, g.grains | 0);
  for (let i = 0; i < grains; i++) {
    const gt = t + (i === 0 ? 0 : g.grainSpread * i * (0.6 + eng.rand() * 0.9));
    const gd = dur * (grains > 1 ? 0.45 + eng.rand() * 0.55 : 1);
    const gl = level * (i === 0 ? 1 : 0.4 + eng.rand() * 0.45);
    const rate = pitch * (0.9 + eng.rand() * 0.25);
    const src = eng.noiseNode(v, gt, gd + 0.06, rate);
    const hp = eng.biquad(v, 'highpass', clampFreq(g.hp * pitch), 0.7);
    const bp = eng.biquad(v, g.filter, clampFreq(g.freq * pitch * (0.9 + eng.rand() * 0.22)), g.q);
    const env = eng.gainNode(v, 0);
    eng.chain(src, hp, bp, env, out);
    eng.envAD(env.gain, gt, gl, 0.0025, gd);
    if (g.sweep > 0) {
      eng.sweep(bp.frequency, gt, g.freq * pitch * 1.7, g.freq * pitch * 0.5, gd);
    }
  }

  if (g.body > 0) {
    const bf = g.bodyFreq * pitch;
    thump(eng, v, out, t, level * g.body * m.body, bf, bf * 0.55, g.bodyDecay);
  }
  if (g.partials) {
    partials(eng, v, out, t, g.partialBase * pitch, g.partials, g.partialDecay,
      level * (action === 'break' ? 0.45 : 0.28));
  }
  if (g.ring > 0) {
    const f = noiseBurst(eng, v, out, t, level * 0.42, g.ring, 'bandpass',
      clampFreq(g.freq * pitch * 1.2), 20, 1, 0.002);
    eng.sweep(f.frequency, t, g.freq * pitch * 1.25, g.freq * pitch * 1.1, g.ring);
  }
  if (action === 'break') {
    thump(eng, v, out, t + 0.012, level * 0.85, 152 * pitch, 52 * pitch, 0.27);
    impulseTrain(eng, v, out, t + 0.04, 3, 0.035, g.freq * pitch * 0.8, 4, level * 0.3, 0.035);
  }

  const tail = Math.max(dur, g.bodyDecay, g.ring, g.partialDecay);
  return tail + m.tail + 0.12;
}

/* ========================================================================== */
/* Sound effect recipes                                                       */
/* ========================================================================== */

/**
 * Alternative spellings that map onto a real recipe.
 * @type {Readonly<Object<string, string>>}
 */
const ALIASES = Object.freeze({
  fence_gate: 'door',
  craft: 'crafting',
  crafting_table: 'crafting',
  blast_furnace: 'furnace',
  barrel: 'chest',
  lightning: 'thunder',
  xp_orb: 'xp_pickup',
  pickup: 'item_pickup',
  hit: 'attack_hit',
  ui_click: 'click',
  button: 'click',
  lever: 'click',
  level_up: 'levelup',
  break: 'item_break',
  bow: 'bow_shoot',
  shoot: 'bow_shoot',
  arrow: 'bow_shoot',
  tnt: 'fuse',
  beacon_hum: 'beacon',
});

/**
 * Every named sound in the game. A recipe fills a voice with nodes and returns
 * how long the sound lasts, tail included.
 * @type {Readonly<Object<string, (eng:AudioEngine, v:Object, o:Object) => number>>}
 */
const RECIPES = Object.freeze({
  /* ---------------------------------------------------------- interface -- */
  click(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.34, 0.028, 'bandpass', 2400 * o.pitch, 3, 1, 0.001);
    thump(eng, v, v.out, t, o.gain * 0.22, 880 * o.pitch, 520 * o.pitch, 0.035, 'triangle');
    return 0.14;
  },
  ui_hover(eng, v, o) {
    noiseBurst(eng, v, v.out, o.t, o.gain * 0.14, 0.022, 'bandpass', 3600 * o.pitch, 4, 1, 0.001);
    return 0.1;
  },
  ui_select(eng, v, o) {
    const t = o.t;
    fmBell(eng, v, v.out, t, 880 * o.pitch, 0.16, o.gain * 0.22, 2.01, 260);
    fmBell(eng, v, v.out, t + 0.06, 1320 * o.pitch, 0.18, o.gain * 0.17, 2.01, 220);
    return 0.34;
  },
  ui_back(eng, v, o) {
    const t = o.t;
    fmBell(eng, v, v.out, t, 660 * o.pitch, 0.16, o.gain * 0.2, 2.01, 220);
    fmBell(eng, v, v.out, t + 0.06, 440 * o.pitch, 0.2, o.gain * 0.16, 2.01, 200);
    return 0.36;
  },
  ui_error(eng, v, o) {
    const t = o.t;
    const osc = eng.oscNode(v, 'square', 220 * o.pitch, t, 0.24);
    const lp = eng.biquad(v, 'lowpass', 1400, 2);
    const g = eng.gainNode(v, 0);
    eng.chain(osc, lp, g, v.out);
    eng.sweep(osc.frequency, t, 230 * o.pitch, 150 * o.pitch, 0.2);
    eng.envAD(g.gain, t, o.gain * 0.24, 0.006, 0.2);
    return 0.34;
  },
  ui_open(eng, v, o) {
    sweepNoise(eng, v, v.out, o.t, o.gain * 0.25, 0.22, 500 * o.pitch, 1800 * o.pitch, 2.5, 0.01);
    return 0.34;
  },
  ui_close(eng, v, o) {
    sweepNoise(eng, v, v.out, o.t, o.gain * 0.25, 0.22, 1800 * o.pitch, 480 * o.pitch, 2.5, 0.01);
    return 0.34;
  },
  ui_toggle(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.3, 0.03, 'bandpass', 1800 * o.pitch, 5, 1, 0.001);
    noiseBurst(eng, v, v.out, t + 0.05, o.gain * 0.22, 0.03, 'bandpass', 2600 * o.pitch, 5, 1, 0.001);
    return 0.18;
  },

  /* -------------------------------------------------------------- blocks -- */
  door(eng, v, o) {
    const t = o.t;
    const up = o.pitch >= 1;
    /* the creak: a very resonant band sweeping while a rough noise floor
       scrapes underneath it */
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.3, 0.55, 'bandpass',
      up ? 420 : 780, 14, 0.6, 0.05);
    eng.sweep(f.frequency, t, up ? 420 : 820, up ? 900 : 380, 0.5);
    const f2 = noiseBurst(eng, v, v.out, t + 0.02, o.gain * 0.16, 0.5, 'bandpass',
      up ? 1250 : 2100, 9, 0.6, 0.06);
    eng.sweep(f2.frequency, t + 0.02, up ? 1250 : 2200, up ? 2300 : 1050, 0.46);
    /* the latch */
    noiseBurst(eng, v, v.out, t + 0.5, o.gain * 0.3, 0.05, 'bandpass', 1500, 6, 1, 0.001);
    thump(eng, v, v.out, t + 0.5, o.gain * 0.3, 190, 90, 0.11);
    return 0.85;
  },
  trapdoor(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.26, 0.3, 'bandpass', 700, 11, 0.8, 0.03);
    eng.sweep(f.frequency, t, 700, o.pitch >= 1 ? 1200 : 460, 0.28);
    thump(eng, v, v.out, t + 0.26, o.gain * 0.32, 230, 110, 0.12, 'triangle');
    return 0.55;
  },
  chest(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.24, 0.34, 'bandpass', 560, 12, 0.7, 0.04);
    eng.sweep(f.frequency, t, 520, 980, 0.32);
    partials(eng, v, v.out, t, 300, [1, 2.4, 3.9], 0.16, o.gain * 0.16);
    thump(eng, v, v.out, t + 0.3, o.gain * 0.4, 170, 78, 0.16);
    return 0.6;
  },
  crafting(eng, v, o) {
    const t = o.t;
    for (let i = 0; i < 3; i++) {
      const it = t + i * (0.035 + eng.rand() * 0.03);
      noiseBurst(eng, v, v.out, it, o.gain * (0.3 - i * 0.06), 0.09, 'bandpass',
        (420 + eng.rand() * 340) * o.pitch, 6, 1, 0.002);
      thump(eng, v, v.out, it, o.gain * 0.22, 210 * o.pitch, 120 * o.pitch, 0.1);
    }
    return 0.4;
  },
  furnace(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.32, 0.55, 'lowpass', 700, 1.2, 0.7, 0.06, true);
    eng.sweep(f.frequency, t, 380, 1300, 0.5);
    impulseTrain(eng, v, v.out, t + 0.08, 6, 0.06, 2400, 5, o.gain * 0.14, 0.02);
    return 0.8;
  },
  enchanting(eng, v, o) {
    const t = o.t;
    const notes = [880, 1174, 1318, 1760];
    for (let i = 0; i < notes.length; i++) {
      fmBell(eng, v, v.out, t + i * 0.07, notes[i] * o.pitch, 0.7 - i * 0.08,
        o.gain * (0.2 - i * 0.03), 3.51, 900);
    }
    sweepNoise(eng, v, v.out, t, o.gain * 0.1, 0.6, 2400, 6000, 2, 0.15);
    return 1.1;
  },
  anvil(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.55, 0.06, 'bandpass', 2600 * o.pitch, 3, 1, 0.001);
    partials(eng, v, v.out, t, 520 * o.pitch, [1, 2.31, 3.83, 5.9], 0.85, o.gain * 0.4);
    thump(eng, v, v.out, t, o.gain * 0.6, 160 * o.pitch, 62 * o.pitch, 0.24);
    return 1.3;
  },
  brewing(eng, v, o) {
    const t = o.t;
    for (let i = 0; i < 7; i++) {
      const bt = t + i * (0.05 + eng.rand() * 0.09);
      const osc = eng.oscNode(v, 'sine', 300, bt, 0.1);
      const g = eng.gainNode(v, 0);
      eng.chain(osc, g, v.out);
      eng.sweep(osc.frequency, bt, 260 + eng.rand() * 200, 700 + eng.rand() * 500, 0.07);
      eng.envAD(g.gain, bt, o.gain * 0.13, 0.004, 0.07);
    }
    return 0.9;
  },
  beacon(eng, v, o) {
    const t = o.t;
    const a = eng.oscNode(v, 'sine', 110 * o.pitch, t, 1.9);
    const b = eng.oscNode(v, 'sine', 165 * o.pitch, t, 1.9, 7);
    const c = eng.oscNode(v, 'sine', 220 * o.pitch, t, 1.9, -7);
    const lp = eng.biquad(v, 'lowpass', 900, 2);
    const g = eng.gainNode(v, 0);
    eng.chain(a, lp, g, v.out);
    b.connect(lp);
    c.connect(lp);
    eng.sweep(lp.frequency, t, 400, 1800, 1.2);
    eng.envAHD(g.gain, t, o.gain * 0.3, 0.5, 0.4, 0.9);
    return 2.1;
  },
  jukebox(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.3, 0.04, 'bandpass', 1900, 6, 1, 0.001);
    noiseBurst(eng, v, v.out, t + 0.08, o.gain * 0.08, 0.5, 'highpass', 4200, 0.8, 1, 0.02);
    return 0.7;
  },
  note_block(eng, v, o) {
    const t = o.t;
    const scale = [0, 2, 4, 7, 9, 12];
    const step = scale[(eng.rand() * scale.length) | 0];
    const freq = midiToFreq(60 + step) * o.pitch;
    const src = eng.pluckNode(v, t, freq, 1.1);
    const lp = eng.biquad(v, 'lowpass', clampFreq(freq * 6 + 800), 1);
    const g = eng.gainNode(v, 0);
    eng.chain(src, lp, g, v.out);
    eng.envAD(g.gain, t, o.gain * 0.45, 0.004, 0.9);
    return 1.2;
  },
  bed(eng, v, o) {
    noiseBurst(eng, v, v.out, o.t, o.gain * 0.26, 0.4, 'lowpass', 480 * o.pitch, 0.9, 0.8, 0.05);
    return 0.55;
  },
  cauldron(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.3, 0.4, 'bandpass', 700, 1.6, 1, 0.02);
    eng.sweep(f.frequency, t, 900, 420, 0.36);
    thump(eng, v, v.out, t + 0.02, o.gain * 0.2, 220, 120, 0.15);
    return 0.6;
  },
  hopper(eng, v, o) {
    impulseTrain(eng, v, v.out, o.t, 4, 0.04, 2100 * o.pitch, 12, o.gain * 0.3, 0.04);
    return 0.4;
  },
  dispenser(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.36, 0.05, 'bandpass', 1300 * o.pitch, 7, 1, 0.001);
    thump(eng, v, v.out, t + 0.03, o.gain * 0.3, 240, 110, 0.14);
    return 0.35;
  },

  /* -------------------------------------------------------------- tools --- */
  bucket_fill(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.4, 0.55, 'bandpass', 400, 2.2, 1, 0.03);
    eng.sweep(f.frequency, t, 380, 1500, 0.5);
    for (let i = 0; i < 6; i++) {
      const bt = t + 0.05 + i * 0.07;
      const osc = eng.oscNode(v, 'sine', 320, bt, 0.09);
      const g = eng.gainNode(v, 0);
      eng.chain(osc, g, v.out);
      eng.sweep(osc.frequency, bt, 300 + i * 60, 800 + i * 120, 0.06);
      eng.envAD(g.gain, bt, o.gain * 0.12, 0.004, 0.06);
    }
    return 0.8;
  },
  bucket_empty(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.5, 0.5, 'bandpass', 1400, 1.6, 1, 0.005);
    eng.sweep(f.frequency, t, 1600, 420, 0.45);
    thump(eng, v, v.out, t, o.gain * 0.3, 260, 90, 0.2);
    return 0.75;
  },
  ignite(eng, v, o) {
    const t = o.t;
    impulseTrain(eng, v, v.out, t, 3, 0.022, 5200, 6, o.gain * 0.4, 0.018);
    const f = noiseBurst(eng, v, v.out, t + 0.05, o.gain * 0.3, 0.45, 'lowpass', 800, 1, 0.8, 0.05, true);
    eng.sweep(f.frequency, t + 0.05, 500, 1600, 0.4);
    return 0.7;
  },
  hoe(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.42, 0.3, 'lowpass', 900, 1.1, 0.85, 0.006);
    eng.sweep(f.frequency, t, 1400, 500, 0.28);
    thump(eng, v, v.out, t, o.gain * 0.3, 120, 60, 0.16);
    return 0.5;
  },
  shear(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.34, 0.05, 'bandpass', 4200 * o.pitch, 8, 1, 0.001);
    noiseBurst(eng, v, v.out, t + 0.07, o.gain * 0.3, 0.06, 'bandpass', 3400 * o.pitch, 8, 1, 0.001);
    partials(eng, v, v.out, t + 0.07, 2600 * o.pitch, [1, 2.4], 0.12, o.gain * 0.1);
    return 0.3;
  },

  /* -------------------------------------------------------------- player -- */
  eat(eng, v, o) {
    const t = o.t;
    let cursor = t;
    for (let i = 0; i < 4; i++) {
      const f = noiseBurst(eng, v, v.out, cursor, o.gain * (0.3 - i * 0.03), 0.08,
        'lowpass', 700 * o.pitch, 1.4, 0.7, 0.006);
      eng.sweep(f.frequency, cursor, 900 * o.pitch, 380 * o.pitch, 0.07);
      thump(eng, v, v.out, cursor, o.gain * 0.14, 150, 90, 0.06);
      cursor += 0.1 + eng.rand() * 0.05;
    }
    return cursor - t + 0.2;
  },
  drink(eng, v, o) {
    const t = o.t;
    let cursor = t;
    for (let i = 0; i < 3; i++) {
      const osc = eng.oscNode(v, 'sine', 240, cursor, 0.12);
      const lp = eng.biquad(v, 'lowpass', 620, 1.5);
      const g = eng.gainNode(v, 0);
      eng.chain(osc, lp, g, v.out);
      eng.sweep3(osc.frequency, cursor, 200 * o.pitch, 330 * o.pitch, 180 * o.pitch, 0.11);
      eng.envAD(g.gain, cursor, o.gain * 0.3, 0.01, 0.1);
      noiseBurst(eng, v, v.out, cursor, o.gain * 0.1, 0.08, 'lowpass', 900, 1, 0.8, 0.01);
      cursor += 0.16 + eng.rand() * 0.06;
    }
    return cursor - t + 0.2;
  },
  item_pickup(eng, v, o) {
    const t = o.t;
    const osc = eng.oscNode(v, 'triangle', 620 * o.pitch, t, 0.14);
    const g = eng.gainNode(v, 0);
    eng.chain(osc, g, v.out);
    eng.sweep(osc.frequency, t, 560 * o.pitch, 1020 * o.pitch, 0.1);
    eng.envAD(g.gain, t, o.gain * 0.28, 0.005, 0.11);
    return 0.24;
  },
  xp_pickup(eng, v, o) {
    const t = o.t;
    fmBell(eng, v, v.out, t, 1480 * o.pitch, 0.42, o.gain * 0.26, 3.51, 1100);
    fmBell(eng, v, v.out, t + 0.03, 2220 * o.pitch, 0.3, o.gain * 0.12, 2.01, 500);
    return 0.6;
  },
  levelup(eng, v, o) {
    const t = o.t;
    const arp = [0, 4, 7, 12, 16];
    for (let i = 0; i < arp.length; i++) {
      fmBell(eng, v, v.out, t + i * 0.085, midiToFreq(72 + arp[i]) * o.pitch,
        0.9 - i * 0.09, o.gain * (0.24 - i * 0.02), 2.01, 640);
    }
    sweepNoise(eng, v, v.out, t, o.gain * 0.08, 0.7, 1800, 6200, 1.6, 0.2);
    return 1.5;
  },
  item_break(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.4, 0.12, 'bandpass', 1900 * o.pitch, 4, 1, 0.001);
    partials(eng, v, v.out, t, 720 * o.pitch, [1, 2.7, 4.3], 0.22, o.gain * 0.2);
    thump(eng, v, v.out, t, o.gain * 0.3, 200, 80, 0.18);
    return 0.5;
  },
  toss(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.22, 0.24, 'bandpass', 900, 1.4, 1, 0.03);
    eng.sweep(f.frequency, t, 1400 * o.pitch, 500 * o.pitch, 0.22);
    return 0.4;
  },
  hurt(eng, v, o) {
    return formantVoice(eng, v, v.out, o.t, {
      f0: 190 * o.pitch, mid: 210 * o.pitch, end: 140 * o.pitch, dur: 0.3,
      wave: 'sawtooth', level: o.gain * 0.5, noise: 0.22, vib: 7, vibDepth: 22,
      formants: [[620, 7, 1], [1150, 8, 0.55], [2500, 9, 0.22]],
    });
  },
  death(eng, v, o) {
    return formantVoice(eng, v, v.out, o.t, {
      f0: 180 * o.pitch, mid: 150 * o.pitch, end: 82 * o.pitch, dur: 0.95,
      wave: 'sawtooth', level: o.gain * 0.55, noise: 0.3, vib: 5, vibDepth: 30,
      formants: [[560, 6, 1], [1050, 7, 0.5], [2200, 8, 0.18]],
    });
  },
  burn(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.35, 0.6, 'lowpass', 900, 1, 0.8, 0.03, true);
    eng.sweep(f.frequency, t, 1400, 500, 0.55);
    impulseTrain(eng, v, v.out, t, 7, 0.06, 3200, 5, o.gain * 0.12, 0.02);
    return 0.85;
  },
  attack_hit(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.4, 0.09, 'bandpass', 900 * o.pitch, 1.6, 1, 0.002);
    thump(eng, v, v.out, t, o.gain * 0.5, 190 * o.pitch, 70 * o.pitch, 0.16);
    return 0.32;
  },
  attack_crit(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.45, 0.1, 'bandpass', 1500 * o.pitch, 2, 1, 0.001);
    thump(eng, v, v.out, t, o.gain * 0.55, 230 * o.pitch, 78 * o.pitch, 0.18);
    partials(eng, v, v.out, t + 0.02, 2400 * o.pitch, [1, 2.3, 3.6], 0.2, o.gain * 0.14);
    return 0.42;
  },

  /* ---------------------------------------------------------- projectiles - */
  bow_draw(eng, v, o) {
    const t = o.t;
    const dur = o.loop ? Infinity : 1.05;
    const src = eng.noiseNode(v, t, Number.isFinite(dur) ? dur + 0.1 : Infinity, 0.7);
    const bp = eng.biquad(v, 'bandpass', 320, 3.5);
    const g = eng.gainNode(v, 0);
    eng.chain(src, bp, g, v.out);
    eng.sweep(bp.frequency, t, 300, 2400, 1.0);
    if (o.loop) {
      g.gain.setValueAtTime(EPS, t);
      g.gain.exponentialRampToValueAtTime(Math.max(EPS, o.gain * 0.3), t + 0.9);
    } else {
      eng.envAHD(g.gain, t, o.gain * 0.3, 0.85, 0.05, 0.12);
    }
    return o.loop ? Infinity : 1.2;
  },
  bow_shoot(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.5, 0.05, 'bandpass', 2200 * o.pitch, 3, 1, 0.001);
    const f = noiseBurst(eng, v, v.out, t + 0.01, o.gain * 0.3, 0.4, 'bandpass', 1400, 1.4, 1, 0.012);
    eng.sweep(f.frequency, t + 0.01, 1600 * o.pitch, 420 * o.pitch, 0.38);
    thump(eng, v, v.out, t, o.gain * 0.22, 320 * o.pitch, 140 * o.pitch, 0.12, 'triangle');
    return 0.6;
  },
  arrow_hit(eng, v, o) {
    const t = o.t;
    noiseBurst(eng, v, v.out, t, o.gain * 0.35, 0.05, 'highpass', 3800 * o.pitch, 0.9, 1, 0.001);
    thump(eng, v, v.out, t, o.gain * 0.45, 260 * o.pitch, 96 * o.pitch, 0.15);
    partials(eng, v, v.out, t, 430 * o.pitch, [1, 2.42], 0.12, o.gain * 0.14);
    return 0.35;
  },
  fuse(eng, v, o) {
    const t = o.t;
    const dur = o.loop ? Infinity : 1.4;
    const src = eng.noiseNode(v, t, dur, 1.2);
    const bp = eng.biquad(v, 'bandpass', 3200, 1.3);
    const g = eng.gainNode(v, 0);
    eng.chain(src, bp, g, v.out);
    /* the sizzle: a fast LFO flickering the level */
    const lfo = eng.oscNode(v, 'sine', 17, t, dur);
    const lfoAmt = eng.gainNode(v, o.gain * 0.09);
    lfo.connect(lfoAmt);
    try { lfoAmt.connect(g.gain); } catch (_err) { /* ignore */ }
    if (o.loop) {
      g.gain.setValueAtTime(EPS, t);
      g.gain.exponentialRampToValueAtTime(Math.max(EPS, o.gain * 0.2), t + 0.15);
    } else {
      eng.envAHD(g.gain, t, o.gain * 0.2, 0.06, 1.1, 0.2);
    }
    return o.loop ? Infinity : 1.5;
  },
  explode(eng, v, o) {
    const t = o.t;
    const p = o.pitch;
    /* the crack */
    noiseBurst(eng, v, v.out, t, o.gain * 0.75, 0.3, 'bandpass', 420 * p, 0.9, 1, 0.002);
    /* the body: brown noise through a closing low-pass */
    const body = noiseBurst(eng, v, v.out, t, o.gain * 0.95, 1.7, 'lowpass', 900 * p, 1, 0.75, 0.006, true);
    eng.sweep(body.frequency, t, 950 * p, 70 * p, 1.6);
    /* the boom */
    thump(eng, v, v.out, t, o.gain * 0.8, 84 * p, 26 * p, 0.85);
    /* the rumbling tail */
    const tail = noiseBurst(eng, v, v.out, t + 0.06, o.gain * 0.45, 2.2, 'lowpass', 200 * p, 0.9, 0.5, 0.2, true);
    eng.sweep(tail.frequency, t + 0.06, 260 * p, 55 * p, 2.1);
    /* debris */
    impulseTrain(eng, v, v.out, t + 0.1, 8, 0.07, 1800, 4, o.gain * 0.16, 0.03);
    return 3.2;
  },

  /* ---------------------------------------------------------- environment - */
  splash(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.55, 0.45, 'bandpass', 1400, 1.1, 1, 0.004);
    eng.sweep(f.frequency, t, 1900 * o.pitch, 380 * o.pitch, 0.42);
    thump(eng, v, v.out, t, o.gain * 0.3, 240, 90, 0.2);
    impulseTrain(eng, v, v.out, t + 0.05, 5, 0.05, 2600, 6, o.gain * 0.12, 0.03);
    return 0.7;
  },
  swim(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.26, 0.3, 'bandpass', 700, 1.1, 0.9, 0.05);
    eng.sweep(f.frequency, t, 500 * o.pitch, 1100 * o.pitch, 0.28);
    return 0.45;
  },
  thunder(eng, v, o) {
    const t = o.t;
    const p = o.pitch;
    const near = o.gain > 0.7;
    if (near) {
      noiseBurst(eng, v, v.out, t, o.gain * 0.6, 0.25, 'highpass', 1800 * p, 0.8, 1, 0.002);
    }
    const body = noiseBurst(eng, v, v.out, t + (near ? 0.02 : 0.0), o.gain * 0.8, 4.5,
      'lowpass', 260 * p, 0.9, 0.45, near ? 0.02 : 0.5, true);
    eng.sweep(body.frequency, t, 300 * p, 48 * p, 4.2);
    /* slow amplitude wobble makes the rumble roll */
    const lfo = eng.oscNode(v, 'sine', 0.7, t, 4.6);
    const amt = eng.gainNode(v, 26 * p);
    lfo.connect(amt);
    try { amt.connect(body.frequency); } catch (_err) { /* ignore */ }
    thump(eng, v, v.out, t + 0.05, o.gain * 0.5, 60 * p, 22 * p, 2.4);
    return 5.4;
  },
  water_drip(eng, v, o) {
    const t = o.t;
    const osc = eng.oscNode(v, 'sine', 900, t, 0.16);
    const g = eng.gainNode(v, 0);
    eng.chain(osc, g, v.out);
    eng.sweep(osc.frequency, t, 1500 * o.pitch, 620 * o.pitch, 0.12);
    eng.envAD(g.gain, t, o.gain * 0.3, 0.003, 0.13);
    noiseBurst(eng, v, v.out, t, o.gain * 0.1, 0.04, 'bandpass', 3200, 5, 1, 0.001);
    return 0.3;
  },
  lava_pop(eng, v, o) {
    const t = o.t;
    thump(eng, v, v.out, t, o.gain * 0.4, 160 * o.pitch, 55 * o.pitch, 0.2);
    noiseBurst(eng, v, v.out, t, o.gain * 0.18, 0.12, 'lowpass', 700, 1.1, 0.7, 0.004, true);
    return 0.35;
  },
  cricket(eng, v, o) {
    const t = o.t;
    let cursor = t;
    for (let i = 0; i < 4; i++) {
      noiseBurst(eng, v, v.out, cursor, o.gain * 0.16, 0.022, 'bandpass', 4600 * o.pitch, 22, 1, 0.002);
      cursor += 0.055;
    }
    return 0.35;
  },
  wind_gust(eng, v, o) {
    const t = o.t;
    const f = noiseBurst(eng, v, v.out, t, o.gain * 0.2, 2.2, 'bandpass', 700, 1.1, 0.8, 0.9, true);
    eng.sweep(f.frequency, t, 500, 1300, 2);
    return 3.2;
  },
});

/* ========================================================================== */
/* Creature voices                                                            */
/* ========================================================================== */

/**
 * A formant-filtered voice: one oscillator with a three-point pitch glide and
 * optional vibrato, split through a bank of resonant band-passes. This single
 * generator covers every animal and humanoid grunt in the game — only the
 * formant table changes.
 * @param {AudioEngine} eng the engine
 * @param {{nodes:AudioNode[], sources:AudioScheduledSourceNode[]}} h owner
 * @param {AudioNode} out destination node
 * @param {number} t start time
 * @param {{f0:number, mid:number, end:number, dur:number, level:number,
 *   wave?:OscillatorType, noise?:number, vib?:number, vibDepth?:number,
 *   formants:readonly (readonly number[])[]}} p voice parameters
 * @returns {number} the length of the sound in seconds
 */
function formantVoice(eng, h, out, t, p) {
  const dur = Math.max(0.06, p.dur);
  const osc = eng.oscNode(h, p.wave || 'sawtooth', clampFreq(p.f0), t, dur + 0.1);
  eng.sweep3(osc.frequency, t, clampFreq(p.f0), clampFreq(p.mid), clampFreq(p.end), dur);
  if (p.vib) eng.vibrato(h, osc, t, dur + 0.1, p.vib, p.vibDepth || 20);

  const env = eng.gainNode(h, 0);
  env.connect(out);
  eng.envAHD(env.gain, t, p.level, Math.min(0.06, dur * 0.18), dur * 0.22, dur * 0.75);

  for (let i = 0; i < p.formants.length; i++) {
    const fm = p.formants[i];
    const bp = eng.biquad(h, 'bandpass', fm[0], fm[1]);
    const fg = eng.gainNode(h, fm[2]);
    osc.connect(bp);
    bp.connect(fg);
    fg.connect(env);
  }
  if (p.noise && p.noise > 0) {
    const src = eng.noiseNode(h, t, dur + 0.1, 1);
    const bp = eng.biquad(h, 'bandpass', clampFreq(p.formants[0][0] * 1.4), 1.6);
    const ng = eng.gainNode(h, p.noise * 0.5);
    eng.chain(src, bp, ng, env);
  }
  return dur + 0.35;
}

/**
 * How the six sound kinds modulate a creature voice.
 * @type {Readonly<Object<string, {gain:number, pitch:number, dur:number, drop:number}>>}
 */
const MOB_KINDS = Object.freeze({
  idle: { gain: 0.55, pitch: 1.0, dur: 1.0, drop: 1.0 },
  hurt: { gain: 0.95, pitch: 1.2, dur: 0.55, drop: 0.82 },
  death: { gain: 1.0, pitch: 0.9, dur: 1.5, drop: 0.55 },
  attack: { gain: 0.9, pitch: 1.12, dur: 0.6, drop: 1.1 },
  step: { gain: 0.4, pitch: 1.0, dur: 0.5, drop: 1.0 },
  special: { gain: 0.8, pitch: 1.05, dur: 1.15, drop: 1.2 },
});

/**
 * Voice descriptors for every mob type of `game/mobs.js`. `synth` selects the
 * generator, `stepGroup` the material its feet land on, `size` scales both the
 * footstep weight and the pitch.
 * @type {Readonly<Object<string, Object>>}
 */
const MOB_VOICES = Object.freeze({
  zombie: {
    synth: 'formant', dur: 0.85, level: 1, stepGroup: 'grass', size: 1,
    f0: 106, mid: 96, end: 76, wave: 'sawtooth', noise: 0.3, vib: 5, vibDepth: 26,
    formants: [[240, 6, 1], [560, 7, 0.55], [1150, 9, 0.25]],
  },
  husk: {
    synth: 'formant', dur: 0.8, level: 0.95, stepGroup: 'sand', size: 1,
    f0: 96, mid: 88, end: 70, wave: 'sawtooth', noise: 0.5, vib: 4, vibDepth: 20,
    formants: [[280, 5, 1], [640, 6, 0.5], [1400, 8, 0.28]],
  },
  drowned: {
    synth: 'formant', dur: 0.9, level: 0.95, stepGroup: 'water', size: 1,
    f0: 100, mid: 90, end: 68, wave: 'sawtooth', noise: 0.45, vib: 6, vibDepth: 34,
    formants: [[200, 6, 1], [430, 8, 0.6], [880, 10, 0.2]],
  },
  skeleton: { synth: 'rattle', dur: 0.7, level: 1, stepGroup: 'stone', size: 0.9 },
  creeper: { synth: 'hiss', dur: 1.1, level: 1, stepGroup: 'grass', size: 0.9 },
  spider: { synth: 'chitter', dur: 0.5, level: 0.9, stepGroup: 'gravel', size: 1.1 },
  enderman: { synth: 'eerie', dur: 1.6, level: 1, stepGroup: 'stone', size: 1.3 },
  witch: {
    synth: 'formant', dur: 0.6, level: 0.85, stepGroup: 'grass', size: 0.95,
    f0: 330, mid: 470, end: 250, wave: 'sawtooth', noise: 0.2, vib: 11, vibDepth: 75,
    formants: [[780, 7, 1], [1500, 8, 0.55], [2900, 9, 0.2]],
  },
  slime: { synth: 'squelch', dur: 0.55, level: 0.9, stepGroup: 'wool', size: 1 },
  pig: {
    synth: 'formant', dur: 0.36, level: 0.85, stepGroup: 'grass', size: 0.9,
    f0: 215, mid: 265, end: 165, wave: 'sawtooth', noise: 0.22, vib: 9, vibDepth: 40,
    formants: [[500, 5, 1], [1120, 6, 0.45]],
  },
  cow: {
    synth: 'formant', dur: 1.15, level: 0.95, stepGroup: 'grass', size: 1.3,
    f0: 152, mid: 140, end: 108, wave: 'sawtooth', noise: 0.2, vib: 4.5, vibDepth: 20,
    formants: [[420, 4, 1], [900, 5, 0.5], [2100, 7, 0.16]],
  },
  sheep: {
    synth: 'formant', dur: 0.8, level: 0.85, stepGroup: 'wool', size: 1,
    f0: 300, mid: 320, end: 245, wave: 'sawtooth', noise: 0.18, vib: 15, vibDepth: 60,
    formants: [[720, 6, 1], [1400, 6, 0.45], [2600, 8, 0.14]],
  },
  chicken: {
    synth: 'formant', dur: 0.17, level: 0.7, stepGroup: 'grass', size: 0.5,
    f0: 620, mid: 940, end: 500, wave: 'square', noise: 0.15, vib: 0, vibDepth: 0,
    formants: [[1500, 6, 1], [2900, 8, 0.35]],
  },
  wolf: {
    synth: 'formant', dur: 0.42, level: 0.9, stepGroup: 'grass', size: 1,
    f0: 265, mid: 410, end: 180, wave: 'sawtooth', noise: 0.28, vib: 6, vibDepth: 30,
    formants: [[600, 5, 1], [1250, 6, 0.5], [2600, 8, 0.16]],
  },
  cat: {
    synth: 'formant', dur: 0.6, level: 0.75, stepGroup: 'wool', size: 0.6,
    f0: 520, mid: 720, end: 430, wave: 'sawtooth', noise: 0.12, vib: 7, vibDepth: 45,
    formants: [[900, 6, 1], [1900, 7, 0.4]],
  },
  horse: {
    synth: 'formant', dur: 0.95, level: 1, stepGroup: 'stone', size: 1.4,
    f0: 245, mid: 390, end: 150, wave: 'sawtooth', noise: 0.35, vib: 13, vibDepth: 80,
    formants: [[560, 5, 1], [1250, 6, 0.5], [2400, 8, 0.2]],
  },
  villager: {
    synth: 'formant', dur: 0.45, level: 0.8, stepGroup: 'grass', size: 1,
    f0: 180, mid: 205, end: 162, wave: 'triangle', noise: 0.12, vib: 6, vibDepth: 18,
    formants: [[520, 6, 1], [1300, 7, 0.4], [2500, 8, 0.12]],
  },
  iron_golem: { synth: 'clank', dur: 1.1, level: 1, stepGroup: 'stone', size: 1.8 },
  fox: {
    synth: 'formant', dur: 0.28, level: 0.7, stepGroup: 'grass', size: 0.7,
    f0: 520, mid: 820, end: 470, wave: 'sawtooth', noise: 0.2, vib: 8, vibDepth: 40,
    formants: [[1100, 6, 1], [2200, 7, 0.4]],
  },
  rabbit: {
    synth: 'formant', dur: 0.11, level: 0.55, stepGroup: 'grass', size: 0.4,
    f0: 880, mid: 1150, end: 800, wave: 'sine', noise: 0.1, vib: 0, vibDepth: 0,
    formants: [[1600, 7, 1], [3200, 8, 0.3]],
  },
  bat: { synth: 'squeak', dur: 0.2, level: 0.5, stepGroup: 'wool', size: 0.3 },
  squid: { synth: 'squirt', dur: 0.4, level: 0.6, stepGroup: 'water', size: 0.9 },
});

/**
 * Synthesise a creature sound. `mob.<type>.<kind>` names route here.
 * @param {AudioEngine} eng the engine
 * @param {Voice} v the voice being filled
 * @param {Object} o playback options (`t`, `gain`, `pitch`)
 * @param {Object} voice a {@link MOB_VOICES} descriptor
 * @param {string} kindName a key of {@link MOB_KINDS}
 * @returns {number} the length of the sound in seconds
 */
function mobSynth(eng, v, o, voice, kindName) {
  const k = MOB_KINDS[kindName] || MOB_KINDS.idle;
  const t = o.t;
  const out = v.out;
  const size = voice.size || 1;

  if (kindName === 'step') {
    const g = GROUPS[voice.stepGroup] || GROUPS.grass;
    return digSynth(eng, v, {
      t, gain: o.gain * clamp(0.45 + size * 0.4, 0.3, 1.4), pitch: o.pitch / size,
    }, g, 'step');
  }

  const pitch = o.pitch * k.pitch / Math.pow(size, 0.45);
  const level = o.gain * k.gain * (voice.level || 1);
  const dur = (voice.dur || 0.5) * k.dur;

  switch (voice.synth) {
    case 'rattle': {
      /* dry bones: a burst of short, high, resonant impulses */
      const count = kindName === 'death' ? 14 : (kindName === 'hurt' ? 7 : 9);
      const span = impulseTrain(eng, v, out, t, count, dur / count,
        1900 * pitch, 14, level * 0.5, 0.028);
      partials(eng, v, out, t, 640 * pitch, [1, 2.6, 4.1], 0.18, level * 0.12);
      return span + 0.3;
    }
    case 'hiss': {
      /* the fuse-like rising hiss right before it goes off */
      const f = noiseBurst(eng, v, out, t, level * 0.55, dur, 'bandpass',
        700 * pitch, 2.2, 1, dur * 0.25);
      eng.sweep(f.frequency, t, 700 * pitch, 2700 * pitch, dur);
      /* a second, higher band an octave up thickens the hiss */
      const f2 = noiseBurst(eng, v, out, t + dur * 0.1, level * 0.2, dur * 0.8, 'bandpass',
        1800 * pitch, 3, 1, dur * 0.3);
      eng.sweep(f2.frequency, t + dur * 0.1, 1800 * pitch, 5200 * pitch, dur * 0.8);
      return dur + 0.4;
    }
    case 'chitter': {
      let cursor = t;
      const count = kindName === 'death' ? 12 : 8;
      for (let i = 0; i < count; i++) {
        const f = (1200 + eng.rand() * 1500) * pitch;
        const osc = eng.oscNode(v, 'square', f, cursor, 0.035);
        const bp = eng.biquad(v, 'bandpass', f, 6);
        const g = eng.gainNode(v, 0);
        eng.chain(osc, bp, g, out);
        eng.sweep(osc.frequency, cursor, f, f * 0.7, 0.03);
        eng.envAD(g.gain, cursor, level * 0.28, 0.002, 0.028);
        cursor += 0.03 + eng.rand() * 0.05;
      }
      return cursor - t + 0.25;
    }
    case 'eerie': {
      /* two barely detuned sines plus a slow warble — deeply unsettling */
      const base = 168 * pitch;
      const a = eng.oscNode(v, 'sine', base, t, dur + 0.2);
      const b = eng.oscNode(v, 'sine', base * 1.007, t, dur + 0.2, 9);
      const c = eng.oscNode(v, 'triangle', base * 2.41, t, dur + 0.2);
      const lp = eng.biquad(v, 'lowpass', 1200, 3);
      const g = eng.gainNode(v, 0);
      const cg = eng.gainNode(v, 0.18);
      eng.chain(a, lp, g, out);
      b.connect(lp);
      eng.chain(c, cg, lp);
      eng.vibrato(v, a, t, dur + 0.2, 0.9, 45);
      eng.sweep3(a.frequency, t, base, base * 1.18, base * k.drop, dur);
      eng.sweep(lp.frequency, t, 600, 2200, dur * 0.7);
      eng.envAHD(g.gain, t, level * 0.4, dur * 0.25, dur * 0.2, dur * 0.7);
      return dur + 0.6;
    }
    case 'squelch': {
      const f = noiseBurst(eng, v, out, t, level * 0.45, dur, 'lowpass', 900 * pitch, 1.4, 0.8, 0.01);
      eng.sweep(f.frequency, t, 1100 * pitch, 320 * pitch, dur);
      thump(eng, v, out, t, level * 0.35, 140 * pitch, 62 * pitch, dur * 0.7, 'triangle');
      return dur + 0.3;
    }
    case 'clank': {
      noiseBurst(eng, v, out, t, level * 0.4, 0.07, 'bandpass', 2400 * pitch, 4, 1, 0.001);
      partials(eng, v, out, t, 380 * pitch, [1, 2.14, 3.62, 5.1], dur * 0.8, level * 0.42);
      thump(eng, v, out, t, level * 0.5, 118 * pitch, 46 * pitch, 0.34);
      return dur + 0.7;
    }
    case 'squeak': {
      const osc = eng.oscNode(v, 'sine', 3000 * pitch, t, dur + 0.05);
      const g = eng.gainNode(v, 0);
      eng.chain(osc, g, out);
      eng.sweep3(osc.frequency, t, 2600 * pitch, 3600 * pitch, 2200 * pitch, dur);
      eng.envAD(g.gain, t, level * 0.3, 0.008, dur);
      /* wing beats */
      for (let i = 0; i < 3; i++) {
        noiseBurst(eng, v, out, t + i * 0.12, level * 0.12, 0.05, 'lowpass', 600, 1, 0.7, 0.01);
      }
      return dur + 0.45;
    }
    case 'squirt': {
      const f = noiseBurst(eng, v, out, t, level * 0.4, dur, 'bandpass', 900 * pitch, 2.4, 1, 0.006);
      eng.sweep(f.frequency, t, 1500 * pitch, 500 * pitch, dur);
      return dur + 0.25;
    }
    default: {
      return formantVoice(eng, v, out, t, {
        f0: voice.f0 * pitch,
        mid: voice.mid * pitch,
        end: voice.end * pitch * k.drop,
        dur,
        wave: voice.wave || 'sawtooth',
        level: level * 0.55,
        noise: voice.noise || 0,
        vib: voice.vib || 0,
        vibDepth: voice.vibDepth || 0,
        formants: voice.formants,
      });
    }
  }
}

/* ========================================================================== */
/* Ambience beds                                                              */
/* ========================================================================== */

/**
 * Every ambience bed the engine knows, in mix order.
 * @type {readonly string[]}
 */
const BED_NAMES = Object.freeze(['wind', 'rain', 'cave', 'water', 'lava', 'night']);

/**
 * Continuous layers of each bed. Built once per bed and modulated by LFOs, so
 * they cost nothing per frame.
 * @type {Readonly<Object<string, (eng:AudioEngine, bed:Object) => void>>}
 */
const BED_BUILDERS = Object.freeze({
  wind(eng, bed) {
    const t = eng.ctx.currentTime;
    /* body: brown noise through a slowly breathing low-pass */
    const src = eng.noiseNode(bed, t, Infinity, 1, true);
    const hp = eng.biquad(bed, 'highpass', 70, 0.7);
    const lp = eng.biquad(bed, 'lowpass', 430, 0.9);
    const g = eng.gainNode(bed, 0.85);
    eng.chain(src, hp, lp, g, bed.gain);
    const lfo = eng.oscNode(bed, 'sine', 0.037, t, Infinity);
    const amt = eng.gainNode(bed, 250);
    lfo.connect(amt);
    try { amt.connect(lp.frequency); } catch (_err) { /* ignore */ }
    /* whistle: a narrow band that swells now and then */
    const src2 = eng.noiseNode(bed, t, Infinity, 1);
    const bp = eng.biquad(bed, 'bandpass', 950, 1.1);
    const g2 = eng.gainNode(bed, 0.05);
    eng.chain(src2, bp, g2, bed.gain);
    const lfo2 = eng.oscNode(bed, 'sine', 0.019, t, Infinity);
    const amt2 = eng.gainNode(bed, 0.045);
    lfo2.connect(amt2);
    try { amt2.connect(g2.gain); } catch (_err) { /* ignore */ }
  },
  rain(eng, bed) {
    const t = eng.ctx.currentTime;
    const src = eng.noiseNode(bed, t, Infinity, 1);
    const bp = eng.biquad(bed, 'bandpass', 2100, 0.6);
    const g = eng.gainNode(bed, 0.4);
    eng.chain(src, bp, g, bed.gain);
    const src2 = eng.noiseNode(bed, t, Infinity, 1, true);
    const lp = eng.biquad(bed, 'lowpass', 620, 0.8);
    const g2 = eng.gainNode(bed, 0.4);
    eng.chain(src2, lp, g2, bed.gain);
    const lfo = eng.oscNode(bed, 'sine', 0.06, t, Infinity);
    const amt = eng.gainNode(bed, 0.1);
    lfo.connect(amt);
    try { amt.connect(g.gain); } catch (_err) { /* ignore */ }
  },
  cave(eng, bed) {
    const t = eng.ctx.currentTime;
    const src = eng.noiseNode(bed, t, Infinity, 0.6, true);
    const lp = eng.biquad(bed, 'lowpass', 95, 0.9);
    const g = eng.gainNode(bed, 0.9);
    eng.chain(src, lp, g, bed.gain);
    const lfo = eng.oscNode(bed, 'sine', 0.023, t, Infinity);
    const amt = eng.gainNode(bed, 40);
    lfo.connect(amt);
    try { amt.connect(lp.frequency); } catch (_err) { /* ignore */ }
  },
  water(eng, bed) {
    const t = eng.ctx.currentTime;
    const src = eng.noiseNode(bed, t, Infinity, 0.8, true);
    const lp = eng.biquad(bed, 'lowpass', 320, 1.1);
    const g = eng.gainNode(bed, 0.8);
    eng.chain(src, lp, g, bed.gain);
    const lfo = eng.oscNode(bed, 'sine', 0.11, t, Infinity);
    const amt = eng.gainNode(bed, 90);
    lfo.connect(amt);
    try { amt.connect(lp.frequency); } catch (_err) { /* ignore */ }
  },
  lava(eng, bed) {
    const t = eng.ctx.currentTime;
    const src = eng.noiseNode(bed, t, Infinity, 0.5, true);
    const lp = eng.biquad(bed, 'lowpass', 170, 1);
    const g = eng.gainNode(bed, 0.85);
    eng.chain(src, lp, g, bed.gain);
  },
  night(eng, bed) {
    const t = eng.ctx.currentTime;
    const src = eng.noiseNode(bed, t, Infinity, 1, true);
    const lp = eng.biquad(bed, 'lowpass', 240, 0.8);
    const g = eng.gainNode(bed, 0.25);
    eng.chain(src, lp, g, bed.gain);
  },
});

/**
 * Sparse random events per bed. Each call schedules one event at `t` and
 * returns how long to wait before the next one.
 * @type {Readonly<Object<string, (eng:AudioEngine, bed:Object, t:number) => number>>}
 */
const BED_EVENTS = Object.freeze({
  rain(eng, bed, t) {
    const h = eng.transient(t + 0.4);
    noiseBurst(eng, h, bed.gain, t, 0.2 + eng.rand() * 0.3, 0.045, 'bandpass',
      2200 + eng.rand() * 3800, 7, 1 + eng.rand(), 0.0015);
    return 0.07 + eng.rand() * 0.2;
  },
  cave(eng, bed, t) {
    const h = eng.transient(t + 6);
    const r = eng.rand();
    if (r < 0.45) {
      /* a distant, barely tonal groan */
      const base = 46 + eng.rand() * 46;
      const a = eng.oscNode(h, 'sine', base, t, 4.2);
      const b = eng.oscNode(h, 'sine', base * 1.49, t, 4.2, 11);
      const lp = eng.biquad(h, 'lowpass', 320, 2);
      const g = eng.gainNode(h, 0);
      eng.chain(a, lp, g, bed.gain);
      b.connect(lp);
      eng.sweep(a.frequency, t, base, base * 0.86, 4);
      eng.envAHD(g.gain, t, 0.16 + eng.rand() * 0.12, 1.4, 0.6, 2);
    } else if (r < 0.8) {
      /* a drip somewhere behind you */
      const osc = eng.oscNode(h, 'sine', 1200, t, 0.18);
      const g = eng.gainNode(h, 0);
      eng.chain(osc, g, bed.gain);
      eng.sweep(osc.frequency, t, 1400 + eng.rand() * 900, 520, 0.13);
      eng.envAD(g.gain, t, 0.18, 0.003, 0.14);
    } else {
      /* loose gravel falling */
      impulseTrain(eng, h, bed.gain, t, 4, 0.05, 1300, 3, 0.13, 0.03);
    }
    return 5 + eng.rand() * 16;
  },
  water(eng, bed, t) {
    const h = eng.transient(t + 0.5);
    const osc = eng.oscNode(h, 'sine', 320, t, 0.11);
    const g = eng.gainNode(h, 0);
    eng.chain(osc, g, bed.gain);
    eng.sweep(osc.frequency, t, 260 + eng.rand() * 220, 700 + eng.rand() * 600, 0.08);
    eng.envAD(g.gain, t, 0.1 + eng.rand() * 0.1, 0.004, 0.08);
    return 0.2 + eng.rand() * 0.9;
  },
  lava(eng, bed, t) {
    const h = eng.transient(t + 0.8);
    thump(eng, h, bed.gain, t, 0.16 + eng.rand() * 0.14, 150 + eng.rand() * 90, 48, 0.22);
    noiseBurst(eng, h, bed.gain, t, 0.08, 0.14, 'lowpass', 700, 1.1, 0.7, 0.004, true);
    return 0.35 + eng.rand() * 1.3;
  },
  night(eng, bed, t) {
    const h = eng.transient(t + 0.6);
    const f = 4200 + eng.rand() * 1400;
    let cursor = t;
    const chirps = 3 + ((eng.rand() * 3) | 0);
    for (let i = 0; i < chirps; i++) {
      noiseBurst(eng, h, bed.gain, cursor, 0.1 + eng.rand() * 0.06, 0.02, 'bandpass', f, 24, 1, 0.002);
      cursor += 0.05 + eng.rand() * 0.02;
    }
    return 0.5 + eng.rand() * 1.6;
  },
});

/* ========================================================================== */
/* Generative music                                                           */
/* ========================================================================== */

/**
 * The four moods. `root` is a MIDI note, `chords` are semitone offsets from it,
 * `scale` is the melodic vocabulary and `melody` the probability that a given
 * eighth-note slot carries a note.
 * @type {Readonly<Object<string, Object>>}
 */
const MOODS = Object.freeze({
  calm: {
    root: 48, tempo: 50, padWave: 'triangle', padCutoff: 1500, pad: 0.16,
    bass: 0.1, melody: 0.2, melodyGain: 0.1, melodyWave: 'triangle', melodyOctave: 24,
    scale: [0, 2, 4, 7, 9, 11],
    chords: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [2, 5, 9], [0, 4, 9], [5, 9, 14]],
  },
  night: {
    root: 45, tempo: 42, padWave: 'sine', padCutoff: 1000, pad: 0.17,
    bass: 0.11, melody: 0.15, melodyGain: 0.085, melodyWave: 'sine', melodyOctave: 24,
    scale: [0, 2, 3, 5, 7, 8, 10],
    chords: [[0, 3, 7], [8, 12, 15], [5, 8, 12], [0, 3, 10], [3, 7, 10], [0, 5, 8]],
  },
  cave: {
    root: 41, tempo: 34, padWave: 'sine', padCutoff: 620, pad: 0.15,
    bass: 0.13, melody: 0.075, melodyGain: 0.07, melodyWave: 'sine', melodyOctave: 24,
    scale: [0, 1, 3, 5, 6, 8, 10],
    chords: [[0, 7, 12], [1, 8, 13], [0, 5, 10], [3, 10, 14], [0, 6, 11], [1, 6, 13]],
  },
  danger: {
    root: 40, tempo: 66, padWave: 'sawtooth', padCutoff: 900, pad: 0.13,
    bass: 0.15, melody: 0.24, melodyGain: 0.075, melodyWave: 'triangle', melodyOctave: 12,
    scale: [0, 1, 3, 6, 7, 10],
    chords: [[0, 6, 11], [0, 1, 7], [3, 6, 10], [0, 6, 13], [1, 7, 10], [0, 3, 6]],
  },
});

/**
 * The thirteen music discs. Each one renders deterministically from its name,
 * so the same disc always plays the same piece.
 * @type {Readonly<Object<string, {mood:string, tempo:number, pad:number,
 *   melody:number, length:number}>>}
 */
const DISC_PROFILES = Object.freeze({
  disc_13: { mood: 'cave', tempo: 46, pad: 0.2, melody: 0.3, length: 105 },
  disc_cat: { mood: 'calm', tempo: 96, pad: 0.16, melody: 0.55, length: 110 },
  disc_blocks: { mood: 'calm', tempo: 104, pad: 0.14, melody: 0.6, length: 100 },
  disc_chirp: { mood: 'calm', tempo: 88, pad: 0.18, melody: 0.52, length: 96 },
  disc_far: { mood: 'night', tempo: 72, pad: 0.22, melody: 0.42, length: 118 },
  disc_mall: { mood: 'night', tempo: 66, pad: 0.2, melody: 0.4, length: 112 },
  disc_mellohi: { mood: 'night', tempo: 58, pad: 0.24, melody: 0.34, length: 98 },
  disc_stal: { mood: 'danger', tempo: 92, pad: 0.16, melody: 0.5, length: 120 },
  disc_strad: { mood: 'calm', tempo: 78, pad: 0.2, melody: 0.46, length: 116 },
  disc_ward: { mood: 'cave', tempo: 54, pad: 0.22, melody: 0.3, length: 122 },
  disc_11: { mood: 'cave', tempo: 38, pad: 0.1, melody: 0.16, length: 74 },
  disc_wait: { mood: 'calm', tempo: 84, pad: 0.18, melody: 0.5, length: 114 },
  disc_pigstep: { mood: 'danger', tempo: 100, pad: 0.14, melody: 0.58, length: 96 },
});

/**
 * A small, stable string hash — seeds the deterministic disc PRNG.
 * @param {string} s input string
 * @returns {number} a positive 31-bit integer
 */
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 1) || 1;
}

