/**
 * @file core/settings.js — VOXELIA persisted settings, quality presets and
 * change events (spec 5.4).
 *
 * The `Settings` instance is the single source of truth for every tunable in
 * the engine. Modules read values by their exact key (`settings.get('ssao')`)
 * and react to `'change'` events instead of polling. Every value is validated
 * and clamped against a schema, so a corrupted `localStorage` entry, a stale
 * save from an older build or a hand-edited JSON blob can never feed a
 * nonsensical value (a negative render distance, a 0.01 render scale, an
 * unknown quality string) into the renderer.
 *
 * There is no DOM access here, so the module can also be imported from a
 * worker — `localStorage` is feature-detected and every access is wrapped.
 */

import { EventBus } from './util.js';

/* ------------------------------------------------------------------------- */
/* Constants                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * `localStorage` key the whole settings blob is persisted under.
 * @type {string}
 */
export const STORAGE_KEY = 'voxelia.settings';

/**
 * Schema version written with every save. Bump when a stored value changes
 * meaning; `Settings` drops values it cannot migrate and falls back to
 * {@link DEFAULTS}.
 * @type {number}
 */
export const SETTINGS_VERSION = 1;

/**
 * Ordered category list used by the settings UI to build its tabs. Labels are
 * German because they are user facing; the keys themselves stay English.
 * @type {ReadonlyArray<'Grafik'|'Audio'|'Steuerung'|'Spiel'>}
 */
export const CATEGORIES = Object.freeze(['Grafik', 'Audio', 'Steuerung', 'Spiel']);

/**
 * Default value for every setting. **Every key in this object is part of the
 * module contract** — other modules read them by exact name.
 * @type {Readonly<Object<string, (number|boolean|string)>>}
 */
export const DEFAULTS = Object.freeze({
  // -- Grafik ---------------------------------------------------------------
  renderDistance: 10,
  fov: 75,
  renderScale: 1,
  textureResolution: 256,
  shadows: true,
  shadowResolution: 2048,
  shadowCascades: 3,
  softShadows: true,
  ssao: true,
  ssaoQuality: 'high',
  bloom: true,
  taa: true,
  motionBlur: true,
  dof: false,
  ssr: true,
  volumetricLight: true,
  volumetricClouds: true,
  parallax: true,
  waterQuality: 'high',
  anisotropy: 8,
  particles: 'high',
  viewBobbing: true,
  fancyLeaves: true,
  smoothLighting: true,
  cloudQuality: 'high',
  waveAnimation: true,
  exposure: 1.0,
  saturation: 1.05,
  contrast: 1.02,
  chromaticAberration: true,
  filmGrain: true,
  vignette: true,
  guiScale: 1,
  maxFps: 0,
  entityDistance: 1.0,
  // -- Audio ----------------------------------------------------------------
  masterVolume: 0.8,
  musicVolume: 0.4,
  sfxVolume: 0.9,
  // -- Steuerung ------------------------------------------------------------
  mouseSensitivity: 0.15,
  invertY: false,
  // -- Spiel ----------------------------------------------------------------
  showFps: false,
  autoSave: true,
});

/**
 * @typedef {Object} SettingOption
 * @property {number|string} value Stored value.
 * @property {string} label Human readable (German) label for the option.
 */

/**
 * @typedef {Object} SettingSchema
 * @property {string} key Setting key (English identifier).
 * @property {'bool'|'int'|'float'|'enum'} type Value type; drives the widget.
 * @property {number|boolean|string} default Default value (from {@link DEFAULTS}).
 * @property {'Grafik'|'Audio'|'Steuerung'|'Spiel'} category UI grouping.
 * @property {string} label German label shown next to the widget.
 * @property {string} description German help text / tooltip.
 * @property {number} [min] Inclusive lower bound for `int`/`float`.
 * @property {number} [max] Inclusive upper bound for `int`/`float`.
 * @property {number} [step] Suggested slider step for `int`/`float`.
 * @property {SettingOption[]} [options] Allowed values for `enum`.
 * @property {string} [unit] Suffix rendered after the numeric value.
 * @property {boolean} [restart] Value only takes effect after a world reload.
 * @property {boolean} [preset] Value participates in the quality presets.
 */

/** Reusable option lists. @type {SettingOption[]} */
const QUALITY_STEPS = [
  { value: 'low', label: 'Niedrig' },
  { value: 'medium', label: 'Mittel' },
  { value: 'high', label: 'Hoch' },
  { value: 'ultra', label: 'Ultra' },
];

/** @type {SettingOption[]} */
const QUALITY_STEPS_OFF = [
  { value: 'off', label: 'Aus' },
  { value: 'low', label: 'Niedrig' },
  { value: 'medium', label: 'Mittel' },
  { value: 'high', label: 'Hoch' },
  { value: 'ultra', label: 'Ultra' },
];

/**
 * Schema declarations in display order. `default` is filled in from
 * {@link DEFAULTS} while building {@link SETTINGS_SCHEMA} so the two can never
 * drift apart.
 * @type {Array<Omit<SettingSchema, 'default'>>}
 */
const SCHEMA_LIST = [
  /* ---------------------------------------------------------------- Grafik */
  {
    key: 'renderDistance', type: 'int', category: 'Grafik',
    min: 2, max: 32, step: 1, unit: ' Chunks', preset: true,
    label: 'Sichtweite',
    description: 'Radius der geladenen und gezeichneten Chunks um den Spieler. Der mit Abstand teuerste Regler.',
  },
  {
    key: 'fov', type: 'int', category: 'Grafik',
    min: 30, max: 120, step: 1, unit: '°', preset: true,
    label: 'Sichtfeld',
    description: 'Vertikales Sichtfeld der Kamera in Grad. Sprinten und Fliegen erhöhen es kurzzeitig.',
  },
  {
    key: 'renderScale', type: 'float', category: 'Grafik',
    min: 0.5, max: 2, step: 0.05, preset: true,
    label: 'Renderauflösung',
    description: 'Interne Auflösung als Faktor der Fenstergröße. Unter 1 rendert deutlich schneller, über 1 glättet per Supersampling.',
  },
  {
    key: 'textureResolution', type: 'enum', category: 'Grafik', restart: true, preset: true,
    options: [
      { value: 128, label: '128 px' },
      { value: 256, label: '256 px' },
      { value: 512, label: '512 px' },
      { value: 1024, label: '1024 px' },
    ],
    label: 'Texturauflösung',
    description: 'Kantenlänge der auf der GPU erzeugten Blocktexturen. Wird beim nächsten Weltstart neu generiert.',
  },
  {
    key: 'shadows', type: 'bool', category: 'Grafik', preset: true,
    label: 'Schatten',
    description: 'Kaskadierte Schattenkarten für Sonne und Mond.',
  },
  {
    key: 'shadowResolution', type: 'enum', category: 'Grafik', preset: true,
    options: [
      { value: 512, label: '512 px' },
      { value: 1024, label: '1024 px' },
      { value: 1536, label: '1536 px' },
      { value: 2048, label: '2048 px' },
      { value: 3072, label: '3072 px' },
      { value: 4096, label: '4096 px' },
    ],
    label: 'Schattenauflösung',
    description: 'Kantenlänge einer Schattenkaskade. Höhere Werte schärfen die Schattenkanten.',
  },
  {
    key: 'shadowCascades', type: 'int', category: 'Grafik',
    min: 1, max: 4, step: 1, preset: true,
    label: 'Schattenkaskaden',
    description: 'Anzahl der Schattenstufen zwischen Nah- und Fernbereich. Mehr Kaskaden bedeuten schärfere Schatten in der Ferne.',
  },
  {
    key: 'softShadows', type: 'bool', category: 'Grafik', preset: true,
    label: 'Weiche Schatten',
    description: 'PCSS-Filterung: Schattenränder werden mit wachsendem Abstand zum Objekt weicher.',
  },
  {
    key: 'ssao', type: 'bool', category: 'Grafik', preset: true,
    label: 'Umgebungsverdeckung',
    description: 'Screen-Space Ambient Occlusion — verdunkelt Ecken, Kanten und Kontaktflächen.',
  },
  {
    key: 'ssaoQuality', type: 'enum', category: 'Grafik', options: QUALITY_STEPS, preset: true,
    label: 'Qualität der Verdeckung',
    description: 'Anzahl der SSAO-Abtastungen und Stärke des bilateralen Weichzeichners.',
  },
  {
    key: 'bloom', type: 'bool', category: 'Grafik', preset: true,
    label: 'Bloom',
    description: 'Weiches Leuchten um helle Bildbereiche wie Lava, Fackeln und die Sonne.',
  },
  {
    key: 'taa', type: 'bool', category: 'Grafik', preset: true,
    label: 'Temporales Anti-Aliasing',
    description: 'Glättet Kanten über mehrere Bilder hinweg und stabilisiert Rauschen aus SSAO und Reflexionen.',
  },
  {
    key: 'motionBlur', type: 'bool', category: 'Grafik', preset: true,
    label: 'Bewegungsunschärfe',
    description: 'Verwischt schnelle Kamera- und Objektbewegungen anhand der Bewegungsvektoren.',
  },
  {
    key: 'dof', type: 'bool', category: 'Grafik', preset: true,
    label: 'Tiefenschärfe',
    description: 'Unscharfer Hintergrund hinter dem Fokuspunkt. Vor allem für Screenshots gedacht.',
  },
  {
    key: 'ssr', type: 'bool', category: 'Grafik', preset: true,
    label: 'Screen-Space-Reflexionen',
    description: 'Echte Spiegelungen auf Wasser und nassen Oberflächen anstelle der einfachen Himmelsspiegelung.',
  },
  {
    key: 'volumetricLight', type: 'bool', category: 'Grafik', preset: true,
    label: 'Volumetrisches Licht',
    description: 'Sichtbare Lichtstrahlen (Gottesstrahlen) in Nebel, Regen und unter Wasser.',
  },
  {
    key: 'volumetricClouds', type: 'bool', category: 'Grafik', preset: true,
    label: 'Volumetrische Wolken',
    description: 'Raymarching durch echte 3D-Wolken statt einer flachen Wolkenebene.',
  },
  {
    key: 'cloudQuality', type: 'enum', category: 'Grafik', options: QUALITY_STEPS_OFF, preset: true,
    label: 'Wolkenqualität',
    description: 'Schrittanzahl und Auflösung des Wolken-Raymarchings.',
  },
  {
    key: 'parallax', type: 'bool', category: 'Grafik', preset: true,
    label: 'Parallax-Mapping',
    description: 'Nutzt die Höhenkarte der Blocktexturen für echte Tiefe an Steinen, Ziegeln und Rinde.',
  },
  {
    key: 'waterQuality', type: 'enum', category: 'Grafik', options: QUALITY_STEPS, preset: true,
    label: 'Wasserqualität',
    description: 'Wellen, Brechung, Kaustiken und Unterwasser-Effekte.',
  },
  {
    key: 'anisotropy', type: 'enum', category: 'Grafik', preset: true,
    options: [
      { value: 1, label: 'Aus' },
      { value: 2, label: '2×' },
      { value: 4, label: '4×' },
      { value: 8, label: '8×' },
      { value: 16, label: '16×' },
    ],
    label: 'Anisotrope Filterung',
    description: 'Schärft Texturen, die in flachem Winkel betrachtet werden — etwa Böden bis zum Horizont.',
  },
  {
    key: 'particles', type: 'enum', category: 'Grafik', options: QUALITY_STEPS_OFF, preset: true,
    label: 'Partikel',
    description: 'Menge der Partikel für Abbau, Regen, Rauch, Funken und Blasen.',
  },
  {
    key: 'entityDistance', type: 'float', category: 'Grafik',
    min: 0.5, max: 3, step: 0.25, unit: '×', preset: true,
    label: 'Objektdistanz',
    description: 'Multiplikator für die Sichtweite von Kreaturen, Items und Partikeln.',
  },
  {
    key: 'viewBobbing', type: 'bool', category: 'Grafik',
    label: 'Kameraschwingen',
    description: 'Leichtes Wippen der Kamera beim Gehen, Sprinten und Landen.',
  },
  {
    key: 'fancyLeaves', type: 'bool', category: 'Grafik', preset: true,
    label: 'Detaillierte Blätter',
    description: 'Blätter werden durchsichtig gerendert, sodass man in die Baumkrone hineinsieht.',
  },
  {
    key: 'smoothLighting', type: 'bool', category: 'Grafik', preset: true,
    label: 'Weiches Licht',
    description: 'Interpoliert Licht und Umgebungsverdeckung pro Eckpunkt statt pro Fläche.',
  },
  {
    key: 'waveAnimation', type: 'bool', category: 'Grafik', preset: true,
    label: 'Wellenanimation',
    description: 'Gras, Blätter, Wasser und Fackeln bewegen sich im Wind.',
  },
  {
    key: 'exposure', type: 'float', category: 'Grafik',
    min: 0.2, max: 3, step: 0.01, preset: true,
    label: 'Belichtung',
    description: 'Helligkeit vor dem ACES-Tonemapping.',
  },
  {
    key: 'saturation', type: 'float', category: 'Grafik',
    min: 0, max: 2, step: 0.01, preset: true,
    label: 'Sättigung',
    description: 'Farbintensität der Endbildkorrektur. 0 ergibt Schwarzweiß.',
  },
  {
    key: 'contrast', type: 'float', category: 'Grafik',
    min: 0.5, max: 2, step: 0.01, preset: true,
    label: 'Kontrast',
    description: 'Kontrastkurve der Endbildkorrektur.',
  },
  {
    key: 'chromaticAberration', type: 'bool', category: 'Grafik', preset: true,
    label: 'Chromatische Aberration',
    description: 'Leichte Farbsäume am Bildrand, wie bei einem echten Objektiv.',
  },
  {
    key: 'filmGrain', type: 'bool', category: 'Grafik', preset: true,
    label: 'Filmkorn',
    description: 'Feines animiertes Korn, das Farbverläufe im Nachthimmel aufbricht.',
  },
  {
    key: 'vignette', type: 'bool', category: 'Grafik', preset: true,
    label: 'Vignette',
    description: 'Abdunklung zu den Bildrändern hin.',
  },
  {
    key: 'guiScale', type: 'float', category: 'Grafik',
    min: 0.5, max: 2.5, step: 0.25, unit: '×',
    label: 'Oberflächenskalierung',
    description: 'Größe von Fadenkreuz, Leisten, Menüs und Inventar.',
  },
  {
    key: 'maxFps', type: 'int', category: 'Grafik',
    min: 0, max: 360, step: 5, unit: ' FPS', preset: true,
    label: 'Bildratenbegrenzung',
    description: '0 bedeutet unbegrenzt (VSync des Browsers). Ein Limit spart Strom und hält die Bildzeiten gleichmäßig.',
  },
  /* ----------------------------------------------------------------- Audio */
  {
    key: 'masterVolume', type: 'float', category: 'Audio',
    min: 0, max: 1, step: 0.01,
    label: 'Gesamtlautstärke',
    description: 'Pegel der Summe. Alle anderen Regler wirken zusätzlich.',
  },
  {
    key: 'musicVolume', type: 'float', category: 'Audio',
    min: 0, max: 1, step: 0.01,
    label: 'Musik',
    description: 'Lautstärke der adaptiven, prozedural erzeugten Musik.',
  },
  {
    key: 'sfxVolume', type: 'float', category: 'Audio',
    min: 0, max: 1, step: 0.01,
    label: 'Effekte',
    description: 'Lautstärke von Schritten, Abbau, Kreaturen und Umgebung.',
  },
  /* ------------------------------------------------------------ Steuerung  */
  {
    key: 'mouseSensitivity', type: 'float', category: 'Steuerung',
    min: 0.01, max: 1, step: 0.005,
    label: 'Mausempfindlichkeit',
    description: 'Grad Kameradrehung pro Pixel Mausbewegung.',
  },
  {
    key: 'invertY', type: 'bool', category: 'Steuerung',
    label: 'Y-Achse invertieren',
    description: 'Maus und rechter Stick nach oben lassen die Kamera nach unten schauen.',
  },
  /* ------------------------------------------------------------------ Spiel */
  {
    key: 'showFps', type: 'bool', category: 'Spiel',
    label: 'FPS anzeigen',
    description: 'Blendet Bildrate und Bildzeit dauerhaft oben links ein.',
  },
  {
    key: 'autoSave', type: 'bool', category: 'Spiel',
    label: 'Automatisch speichern',
    description: 'Sichert veränderte Chunks und den Spielerzustand regelmäßig in die IndexedDB.',
  },
];

/**
 * Every schema entry, in display order, frozen. The array additionally carries
 * a non-enumerable property per setting key, so both access styles work:
 * `for (const e of SETTINGS_SCHEMA)` and `SETTINGS_SCHEMA.renderDistance`.
 * @type {ReadonlyArray<SettingSchema>}
 */
export const SETTINGS_SCHEMA = (() => {
  /** @type {SettingSchema[]} */
  const list = [];
  for (const raw of SCHEMA_LIST) {
    const entry = /** @type {SettingSchema} */ ({ ...raw, default: DEFAULTS[raw.key] });
    if (entry.options) entry.options = Object.freeze(entry.options.map((o) => Object.freeze({ ...o })));
    list.push(Object.freeze(entry));
  }
  for (const entry of list) {
    Object.defineProperty(list, entry.key, { value: entry, enumerable: false, configurable: false, writable: false });
  }
  return Object.freeze(list);
})();

/** Fast key -> schema lookup. @type {Map<string, SettingSchema>} */
const SCHEMA_BY_KEY = new Map(SETTINGS_SCHEMA.map((e) => [e.key, e]));

// Consistency guard: a key present in DEFAULTS but missing from the schema
// could never be validated, a schema entry without a default could never be
// reset. Both are authoring bugs, so shout once at module load.
for (const key of Object.keys(DEFAULTS)) {
  if (!SCHEMA_BY_KEY.has(key)) console.warn(`[VOXELIA] settings: no schema entry for default "${key}"`);
}
for (const entry of SETTINGS_SCHEMA) {
  if (!(entry.key in DEFAULTS)) console.warn(`[VOXELIA] settings: schema key "${entry.key}" has no default`);
}

/**
 * Quality presets. Each preset overrides a coherent subset of the graphics
 * settings and never touches audio, controls or gameplay keys.
 * @type {Readonly<Object<string, Readonly<Object<string, (number|boolean|string)>>>>}
 */
export const QUALITY_PRESETS = Object.freeze({
  /** Integrated GPUs and phones: everything optional switched off. */
  potato: Object.freeze({
    renderDistance: 4,
    renderScale: 0.6,
    textureResolution: 128,
    shadows: false,
    shadowResolution: 512,
    shadowCascades: 1,
    softShadows: false,
    ssao: false,
    ssaoQuality: 'low',
    bloom: false,
    taa: false,
    motionBlur: false,
    dof: false,
    ssr: false,
    volumetricLight: false,
    volumetricClouds: false,
    cloudQuality: 'off',
    parallax: false,
    waterQuality: 'low',
    anisotropy: 1,
    particles: 'off',
    fancyLeaves: false,
    smoothLighting: false,
    waveAnimation: false,
    chromaticAberration: false,
    filmGrain: false,
    vignette: false,
    entityDistance: 0.5,
    exposure: 1.0,
    saturation: 1.0,
    contrast: 1.0,
    maxFps: 60,
  }),
  /** Old laptops: shadows on, screen-space effects off. */
  low: Object.freeze({
    renderDistance: 6,
    renderScale: 0.75,
    textureResolution: 128,
    shadows: true,
    shadowResolution: 1024,
    shadowCascades: 2,
    softShadows: false,
    ssao: false,
    ssaoQuality: 'low',
    bloom: false,
    taa: false,
    motionBlur: false,
    dof: false,
    ssr: false,
    volumetricLight: false,
    volumetricClouds: false,
    cloudQuality: 'low',
    parallax: false,
    waterQuality: 'low',
    anisotropy: 2,
    particles: 'low',
    fancyLeaves: false,
    smoothLighting: true,
    waveAnimation: false,
    chromaticAberration: false,
    filmGrain: false,
    vignette: true,
    entityDistance: 0.75,
    exposure: 1.0,
    saturation: 1.02,
    contrast: 1.0,
    maxFps: 0,
  }),
  /** The safe default for unknown hardware. */
  medium: Object.freeze({
    renderDistance: 8,
    renderScale: 1,
    textureResolution: 256,
    shadows: true,
    shadowResolution: 1024,
    shadowCascades: 3,
    softShadows: false,
    ssao: true,
    ssaoQuality: 'medium',
    bloom: true,
    taa: true,
    motionBlur: false,
    dof: false,
    ssr: false,
    volumetricLight: true,
    volumetricClouds: false,
    cloudQuality: 'medium',
    parallax: false,
    waterQuality: 'medium',
    anisotropy: 4,
    particles: 'medium',
    fancyLeaves: true,
    smoothLighting: true,
    waveAnimation: true,
    chromaticAberration: false,
    filmGrain: true,
    vignette: true,
    entityDistance: 1.0,
    exposure: 1.0,
    saturation: 1.05,
    contrast: 1.02,
    maxFps: 0,
  }),
  /** Mid-range desktop GPU — matches DEFAULTS. */
  high: Object.freeze({
    renderDistance: 12,
    renderScale: 1,
    textureResolution: 256,
    shadows: true,
    shadowResolution: 2048,
    shadowCascades: 3,
    softShadows: true,
    ssao: true,
    ssaoQuality: 'high',
    bloom: true,
    taa: true,
    motionBlur: true,
    dof: false,
    ssr: true,
    volumetricLight: true,
    volumetricClouds: true,
    cloudQuality: 'high',
    parallax: true,
    waterQuality: 'high',
    anisotropy: 8,
    particles: 'high',
    fancyLeaves: true,
    smoothLighting: true,
    waveAnimation: true,
    chromaticAberration: true,
    filmGrain: true,
    vignette: true,
    entityDistance: 1.0,
    exposure: 1.0,
    saturation: 1.05,
    contrast: 1.02,
    maxFps: 0,
  }),
  /** Everything on, still aimed at 60 FPS. */
  ultra: Object.freeze({
    renderDistance: 16,
    renderScale: 1,
    textureResolution: 512,
    shadows: true,
    shadowResolution: 4096,
    shadowCascades: 4,
    softShadows: true,
    ssao: true,
    ssaoQuality: 'ultra',
    bloom: true,
    taa: true,
    motionBlur: true,
    dof: false,
    ssr: true,
    volumetricLight: true,
    volumetricClouds: true,
    cloudQuality: 'ultra',
    parallax: true,
    waterQuality: 'ultra',
    anisotropy: 16,
    particles: 'ultra',
    fancyLeaves: true,
    smoothLighting: true,
    waveAnimation: true,
    chromaticAberration: true,
    filmGrain: true,
    vignette: true,
    entityDistance: 1.5,
    exposure: 1.0,
    saturation: 1.06,
    contrast: 1.03,
    maxFps: 0,
  }),
  /** Screenshot/video mode: supersampling, depth of field, no FPS budget. */
  cinematic: Object.freeze({
    renderDistance: 20,
    fov: 70,
    renderScale: 1.25,
    textureResolution: 1024,
    shadows: true,
    shadowResolution: 4096,
    shadowCascades: 4,
    softShadows: true,
    ssao: true,
    ssaoQuality: 'ultra',
    bloom: true,
    taa: true,
    motionBlur: true,
    dof: true,
    ssr: true,
    volumetricLight: true,
    volumetricClouds: true,
    cloudQuality: 'ultra',
    parallax: true,
    waterQuality: 'ultra',
    anisotropy: 16,
    particles: 'ultra',
    fancyLeaves: true,
    smoothLighting: true,
    waveAnimation: true,
    chromaticAberration: true,
    filmGrain: true,
    vignette: true,
    entityDistance: 2.0,
    exposure: 1.05,
    saturation: 1.1,
    contrast: 1.06,
    maxFps: 0,
  }),
});

/* ------------------------------------------------------------------------- */
/* Storage helpers (worker safe)                                              */
/* ------------------------------------------------------------------------- */

/**
 * Resolve the storage backend, or `null` when unavailable (worker, `file://`
 * with disabled storage, Safari private mode).
 * @returns {Storage|null} A storage-like object or `null`.
 */
function getStorage() {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Clamp a number into `[min, max]`, tolerating missing bounds.
 * @param {number} v Value.
 * @param {number} [min] Lower bound.
 * @param {number} [max] Upper bound.
 * @returns {number} Clamped value.
 */
function clampTo(v, min, max) {
  let out = v;
  if (typeof min === 'number' && out < min) out = min;
  if (typeof max === 'number' && out > max) out = max;
  return out;
}

/**
 * Round a float to 4 decimals so slider drags do not accumulate binary dust in
 * the persisted JSON.
 * @param {number} v Value.
 * @returns {number} Rounded value.
 */
function tidyFloat(v) {
  return Math.round(v * 10000) / 10000;
}

/* ------------------------------------------------------------------------- */
/* Settings                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Persisted, validated engine settings with change notifications.
 *
 * Events:
 * * `'change'` — `(key, value, oldValue)` for every accepted value change.
 * * `'change:<key>'` — `(value, oldValue)` for listeners that only care about one key.
 * * `'preset'` — `(name, values)` after {@link Settings#applyPreset}.
 * * `'reset'` — `()` after {@link Settings#reset}.
 * * `'load'` — `(values)` after settings were read from storage.
 * * `'save'` — `(values)` after settings were written to storage.
 *
 * @example
 * const settings = new Settings();
 * settings.on('change', (key, value) => { if (key === 'renderDistance') world.setViewDistance(value); });
 * settings.applyPreset('ultra');
 */
export class Settings extends EventBus {
  /**
   * @param {{storageKey?: string, autoLoad?: boolean, saveDelayMs?: number}} [options]
   *   `storageKey` overrides {@link STORAGE_KEY} (useful for tests),
   *   `autoLoad` (default `true`) reads persisted values in the constructor,
   *   `saveDelayMs` (default `250`) debounces writes while a slider is dragged.
   */
  constructor(options = {}) {
    super();
    /** @type {string} Storage key this instance persists to. */
    this.storageKey = options.storageKey || STORAGE_KEY;
    /** @type {number} Debounce for automatic writes, in milliseconds. */
    this.saveDelayMs = Number.isFinite(options.saveDelayMs) ? Math.max(0, options.saveDelayMs) : 250;
    /** @type {Object<string, (number|boolean|string)>} Current values. @private */
    this._values = { ...DEFAULTS };
    /** @type {string|null} Name of the last applied preset, `null` when custom. @private */
    this._preset = null;
    /** @type {boolean} True while {@link Settings#applyPreset} is running. @private */
    this._applyingPreset = false;
    /** @type {*} Pending debounced save timer handle. @private */
    this._saveTimer = null;
    /** @type {Set<string>} Keys already reported as unknown (warn once). @private */
    this._warned = new Set();
    if (options.autoLoad !== false) this.load();
  }

  /**
   * Name of the quality preset the current values came from, or `null` when
   * the user changed something afterwards.
   * @returns {string|null} Preset name or `null`.
   */
  get preset() {
    return this._preset;
  }

  /**
   * Read a setting.
   * @param {string} key Setting key.
   * @returns {number|boolean|string|undefined} Current value, or `undefined`
   *   for an unknown key (with a one-time console warning).
   */
  get(key) {
    if (!SCHEMA_BY_KEY.has(key)) {
      this._warnUnknown(key);
      return undefined;
    }
    return this._values[key];
  }

  /**
   * Whether a key exists in the schema.
   * @param {string} key Setting key.
   * @returns {boolean} True when the key is known.
   */
  has(key) {
    return SCHEMA_BY_KEY.has(key);
  }

  /**
   * Validate, clamp and store a value. Emits `'change'` and `'change:<key>'`
   * when the stored value actually changed, and schedules a persist.
   * @param {string} key Setting key.
   * @param {number|boolean|string} value New value; coerced to the schema type.
   * @returns {boolean} True when the value changed.
   */
  set(key, value) {
    const entry = SCHEMA_BY_KEY.get(key);
    if (!entry) {
      this._warnUnknown(key);
      return false;
    }
    const next = this._coerce(entry, value);
    if (next === undefined) {
      console.warn(`[VOXELIA] settings: rejected value for "${key}":`, value);
      return false;
    }
    const old = this._values[key];
    if (Object.is(old, next)) return false;
    this._values[key] = next;
    if (!this._applyingPreset) this._preset = null;
    this.emit('change', key, next, old);
    this.emit(`change:${key}`, next, old);
    this._scheduleSave();
    return true;
  }

  /**
   * Apply many values at once. Each one goes through {@link Settings#set}, so
   * invalid entries are dropped individually instead of failing the batch.
   * @param {Object<string, (number|boolean|string)>} values Key/value map.
   * @returns {number} How many values actually changed.
   */
  setMany(values) {
    let changed = 0;
    for (const key of Object.keys(values)) {
      if (this.set(key, values[key])) changed++;
    }
    return changed;
  }

  /**
   * Flip a boolean setting.
   * @param {string} key Setting key of type `bool`.
   * @returns {boolean} The new value (or the unchanged one for non-booleans).
   */
  toggle(key) {
    const entry = SCHEMA_BY_KEY.get(key);
    if (!entry || entry.type !== 'bool') {
      this._warnUnknown(key);
      return false;
    }
    const next = !this._values[key];
    this.set(key, next);
    return /** @type {boolean} */ (this._values[key]);
  }

  /**
   * Apply a quality preset. Only the keys the preset declares are touched;
   * audio, control and gameplay settings keep their values.
   * @param {'potato'|'low'|'medium'|'high'|'ultra'|'cinematic'|string} name Preset name.
   * @returns {boolean} True when the preset exists and was applied.
   */
  applyPreset(name) {
    const preset = QUALITY_PRESETS[name];
    if (!preset) {
      console.warn(`[VOXELIA] settings: unknown quality preset "${name}"`);
      return false;
    }
    this._applyingPreset = true;
    try {
      for (const key of Object.keys(preset)) this.set(key, preset[key]);
    } finally {
      this._applyingPreset = false;
    }
    this._preset = name;
    this.emit('preset', name, { ...preset });
    this.save();
    return true;
  }

  /**
   * Find the preset whose declared values all match the current state.
   * @returns {string|null} Preset name or `null` when the state is custom.
   */
  detectPreset() {
    for (const name of Object.keys(QUALITY_PRESETS)) {
      const preset = QUALITY_PRESETS[name];
      let match = true;
      for (const key of Object.keys(preset)) {
        if (!Object.is(this._values[key], preset[key])) {
          match = false;
          break;
        }
      }
      if (match) return name;
    }
    return null;
  }

  /**
   * Restore every setting to its default and persist immediately.
   * @returns {Settings} `this`.
   */
  reset() {
    for (const key of Object.keys(DEFAULTS)) this.set(key, DEFAULTS[key]);
    this._preset = null;
    this.emit('reset');
    this.save();
    return this;
  }

  /**
   * Restore a single setting to its default value.
   * @param {string} key Setting key.
   * @returns {boolean} True when the value changed.
   */
  resetKey(key) {
    if (!SCHEMA_BY_KEY.has(key)) {
      this._warnUnknown(key);
      return false;
    }
    return this.set(key, DEFAULTS[key]);
  }

  /**
   * Read persisted values from storage, validating every entry. Unknown keys
   * are dropped, out-of-range values clamped, wrong types coerced or replaced
   * by the default. Never throws.
   * @returns {boolean} True when a stored blob was found and parsed.
   */
  load() {
    const storage = getStorage();
    if (!storage) return false;
    let raw = null;
    try {
      raw = storage.getItem(this.storageKey);
    } catch {
      return false;
    }
    if (!raw) return false;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[VOXELIA] settings: stored JSON is corrupt, falling back to defaults');
      return false;
    }
    if (!parsed || typeof parsed !== 'object') return false;
    const values = (parsed.values && typeof parsed.values === 'object') ? parsed.values : parsed;
    for (const key of Object.keys(values)) {
      const entry = SCHEMA_BY_KEY.get(key);
      if (!entry) continue;
      const next = this._coerce(entry, values[key]);
      if (next !== undefined) this._values[key] = next;
    }
    this._preset = typeof parsed.preset === 'string' && QUALITY_PRESETS[parsed.preset] ? parsed.preset : null;
    this.emit('load', this.all());
    return true;
  }

  /**
   * Persist the current values synchronously and cancel any pending debounced
   * write. Storage failures are logged once and otherwise ignored.
   * @returns {boolean} True when the write succeeded.
   */
  save() {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    const storage = getStorage();
    if (!storage) return false;
    const blob = { version: SETTINGS_VERSION, preset: this._preset, values: this._values };
    try {
      storage.setItem(this.storageKey, JSON.stringify(blob));
    } catch (err) {
      if (!this._warned.has('__storage')) {
        this._warned.add('__storage');
        console.warn('[VOXELIA] settings: could not persist to localStorage:', err);
      }
      return false;
    }
    this.emit('save', this.all());
    return true;
  }

  /**
   * Snapshot of every current value.
   * @returns {Object<string, (number|boolean|string)>} A shallow copy.
   */
  all() {
    return { ...this._values };
  }

  /**
   * Schema for the settings UI: widget type, bounds, options, German label,
   * category and description. The returned objects are frozen — treat them as
   * read-only.
   * @param {string} [key] Optional single key.
   * @returns {SettingSchema|ReadonlyArray<SettingSchema>|undefined} One entry
   *   when `key` is given (or `undefined` if unknown), otherwise the full
   *   ordered list (which also exposes each entry as a property by key).
   */
  getSchema(key) {
    if (key === undefined) return SETTINGS_SCHEMA;
    return SCHEMA_BY_KEY.get(key);
  }

  /**
   * Schema entries belonging to one UI category, in display order.
   * @param {'Grafik'|'Audio'|'Steuerung'|'Spiel'|string} category Category name.
   * @returns {SettingSchema[]} Matching entries (a fresh array).
   */
  getCategory(category) {
    return SETTINGS_SCHEMA.filter((e) => e.category === category);
  }

  /**
   * Selectable options of an `enum` setting.
   * @param {string} key Setting key.
   * @returns {SettingOption[]} Options, or an empty array for non-enums.
   */
  getOptions(key) {
    const entry = SCHEMA_BY_KEY.get(key);
    return entry && entry.options ? /** @type {SettingOption[]} */ (entry.options.slice()) : [];
  }

  /**
   * Human readable German rendering of the current value, for the settings UI
   * and the debug overlay.
   * @param {string} key Setting key.
   * @returns {string} Formatted value, `''` for unknown keys.
   */
  formatValue(key) {
    const entry = SCHEMA_BY_KEY.get(key);
    if (!entry) return '';
    const value = this._values[key];
    if (entry.type === 'bool') return value ? 'An' : 'Aus';
    if (entry.type === 'enum' && entry.options) {
      const opt = entry.options.find((o) => o.value === value);
      return opt ? opt.label : String(value);
    }
    if (entry.key === 'maxFps' && value === 0) return 'Unbegrenzt';
    const num = /** @type {number} */ (value);
    const text = entry.type === 'int' ? String(num) : String(tidyFloat(num));
    return entry.unit ? text + entry.unit : text;
  }

  /**
   * Drop this instance's listeners and flush any pending write.
   * @returns {void}
   */
  dispose() {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.save();
    }
    this.removeAllListeners();
  }

  /* ----------------------------------------------------------- internals -- */

  /**
   * Coerce and clamp a raw value against a schema entry.
   * @param {SettingSchema} entry Schema entry.
   * @param {*} value Raw value from the UI, storage or a preset.
   * @returns {number|boolean|string|undefined} A valid value, or `undefined`
   *   when the input cannot be interpreted at all.
   * @private
   */
  _coerce(entry, value) {
    switch (entry.type) {
      case 'bool': {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
          const s = value.toLowerCase();
          if (s === 'true' || s === '1' || s === 'on' || s === 'an') return true;
          if (s === 'false' || s === '0' || s === 'off' || s === 'aus') return false;
        }
        return undefined;
      }
      case 'int': {
        const n = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
        if (!Number.isFinite(n)) return undefined;
        return clampTo(Math.round(n), entry.min, entry.max);
      }
      case 'float': {
        const n = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
        if (!Number.isFinite(n)) return undefined;
        return tidyFloat(clampTo(n, entry.min, entry.max));
      }
      case 'enum': {
        const options = entry.options || [];
        for (const opt of options) if (opt.value === value) return opt.value;
        // Tolerate '512' for 512 and 512 for '512' (URL params, old saves).
        for (const opt of options) if (String(opt.value) === String(value)) return opt.value;
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * Warn once per unknown key so a typo in a consumer does not spam the console
   * every frame.
   * @param {string} key Offending key.
   * @returns {void}
   * @private
   */
  _warnUnknown(key) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(`[VOXELIA] settings: unknown key "${key}"`);
  }

  /**
   * Debounce a persist so dragging a slider writes once, not sixty times.
   * @returns {void}
   * @private
   */
  _scheduleSave() {
    if (this.saveDelayMs <= 0) {
      this.save();
      return;
    }
    if (this._saveTimer !== null) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, this.saveDelayMs);
  }
}
