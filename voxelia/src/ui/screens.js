/**
 * @file ui/screens.js — VOXELIA full-screen menus (ARCHITECTURE.md section 5.41).
 *
 * Every screen in this module is a plain DOM overlay that lives inside the
 * `#ui` root and floats above the WebGL canvas. Nothing here ever touches the
 * GPU: the world keeps rendering behind the menus (the main menu runs a slow
 * orbiting camera, the pause screen blurs the live frame), so all screens are
 * translucent by design and never paint an opaque page over the canvas.
 *
 * The module owns eight screens:
 *
 * | key           | class            | purpose                                  |
 * |---------------|------------------|------------------------------------------|
 * | `mainmenu`    | {@link MainMenu} | title, subtitle, four entry buttons      |
 * | `worldcreate` | {@link WorldCreate} | name / seed / mode / world type       |
 * | `worldlist`   | {@link WorldList}| saved worlds as cards, delete + confirm  |
 * | `settings`    | {@link SettingsScreen} | built from `settings.getSchema()`  |
 * | `controls`    | {@link ControlsScreen} | rebindable action list             |
 * | `pause`       | {@link PauseScreen}    | resume / settings / save & quit    |
 * | `death`       | {@link DeathScreen}    | cause of death, score, respawn     |
 * | `loading`     | {@link LoadingScreen}  | progress bar, step name, tips      |
 *
 * **Keyboard navigation** is handled centrally by {@link ScreenManager}: every
 * focusable control carries `data-nav`, the arrow keys and Tab walk that ring,
 * Enter/Space activate the native `<button>` underneath and Escape asks the
 * current screen to go back. Text fields swallow the arrow keys but never
 * Escape, and while one has focus `input.typing` is raised so holding `W` in
 * the world-name box cannot walk the player.
 *
 * **Styling** comes from `ui/style.css` using the `vox-<screen>-<part>` class
 * convention. A compact fallback stylesheet is *prepended* to `<head>` (so the
 * real stylesheet, which is linked later, always wins) purely so the menus stay
 * usable if a class is missing.
 *
 * All user-facing strings are German.
 *
 * @module ui/screens
 */

import { CATEGORIES, QUALITY_PRESETS, DEFAULTS } from '../core/settings.js';
import { ACTIONS, ACTION_LABELS, codeLabel } from '../core/input.js';
import { clamp } from '../core/math.js';

/* ------------------------------------------------------------------------- */
/* Constants                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * `localStorage` key the {@link ControlsScreen} persists key bindings under.
 * @type {string}
 */
export const BINDINGS_STORAGE_KEY = 'voxelia.bindings';

/**
 * German labels for the quality presets exported by `core/settings.js`.
 * @type {Readonly<Object<string, string>>}
 */
export const PRESET_LABELS = Object.freeze({
  potato: 'Kartoffel',
  low: 'Niedrig',
  medium: 'Mittel',
  high: 'Hoch',
  ultra: 'Ultra',
  cinematic: 'Kino',
});

/**
 * Short German explanation per quality preset, shown under the buttons.
 * @type {Readonly<Object<string, string>>}
 */
export const PRESET_HINTS = Object.freeze({
  potato: 'Alles Optionale aus. Für integrierte Grafik und schwache Geräte.',
  low: 'Schatten an, Bildschirmeffekte aus. Für ältere Notebooks.',
  medium: 'Ausgewogene Mischung — die Voreinstellung für mittlere Hardware.',
  high: 'Volle Beleuchtung, weiche Schatten, Bloom und TAA.',
  ultra: 'Alles an, hohe Auflösungen. Für aktuelle Desktop-Grafikkarten.',
  cinematic: 'Maximale Qualität inklusive Tiefenschärfe. Nicht für 60 FPS gedacht.',
});

/**
 * Selectable game modes on the world-creation screen.
 * @type {ReadonlyArray<{value:string, label:string, description:string}>}
 */
export const GAME_MODE_OPTIONS = Object.freeze([
  Object.freeze({
    value: 'survival',
    label: 'Überleben',
    description: 'Leben, Hunger, Werkzeugverschleiß und Kreaturen. Blöcke müssen abgebaut werden.',
  }),
  Object.freeze({
    value: 'creative',
    label: 'Kreativ',
    description: 'Fliegen, unbegrenzte Blöcke, kein Schaden. Zum Bauen ohne Zeitdruck.',
  }),
]);

/**
 * Selectable world types. `options` is forwarded to `WorldGenerator` through
 * `game.startWorld({ generatorOptions })` — the names match the generator's
 * real switches, so nothing here is decorative.
 * @type {ReadonlyArray<{value:string, label:string, description:string,
 *   options:Object<string, boolean>}>}
 */
export const WORLD_TYPE_OPTIONS = Object.freeze([
  Object.freeze({
    value: 'default',
    label: 'Standard',
    description: 'Vollständige Weltgenerierung: Biome, Höhlen, Erze, Bäume und Bauwerke.',
    options: Object.freeze({}),
  }),
  Object.freeze({
    value: 'no_structures',
    label: 'Ohne Bauwerke',
    description: 'Gleiches Terrain, aber keine Dörfer, Minen oder Ruinen.',
    options: Object.freeze({ structures: false }),
  }),
  Object.freeze({
    value: 'solid',
    label: 'Massiver Untergrund',
    description: 'Keine Höhlen und Schluchten — der Untergrund bleibt durchgehend fest.',
    options: Object.freeze({ caves: false, caveDecoration: false }),
  }),
  Object.freeze({
    value: 'barren',
    label: 'Karge Welt',
    description: 'Nacktes Terrain ohne Bäume, Pflanzen und Bauwerke. Erze bleiben erhalten.',
    options: Object.freeze({ features: false, structures: false }),
  }),
]);

/**
 * Tips rotated on the loading screen, one every few seconds.
 * @type {ReadonlyArray<string>}
 */
export const LOADING_TIPS = Object.freeze([
  'Halte die Umschalttaste beim Klicken gedrückt, um Stapel zwischen Truhe und Inventar zu schieben.',
  'Mit F3 öffnest du die Debug-Anzeige mit Position, Biom und Bildraten.',
  'Fackeln halten Kreaturen fern — Licht ab Stufe 8 verhindert das Spawnen.',
  'Ein Rechtsklick auf einen Stapel im Inventar nimmt genau die Hälfte auf.',
  'Wasser fällt neben Lava zu Stein — praktisch beim Bergbau.',
  'Werkzeuge aus Gold bauen am schnellsten ab, halten aber am kürzesten.',
  'Betten gibt es noch nicht — überstehe die Nacht lieber unter der Erde.',
  'Mit dem Mausrad wechselst du die Schnellzugriffsleiste, mit 1–9 direkt.',
  'Sand und Kies fallen herunter. Grabe nie senkrecht nach oben.',
  'Das Rezeptbuch im Inventar zeigt nur, was du gerade wirklich bauen kannst.',
  'Schleichen verhindert, dass du über eine Kante läufst.',
  'Die Sichtweite ist der teuerste Regler in den Grafikeinstellungen.',
]);

/** Seconds one loading tip stays on screen. @type {number} */
const TIP_INTERVAL = 7;

/** Fallback stylesheet element id. @type {string} */
const STYLE_ID = 'vox-screens-fallback';

/**
 * Minimal structural fallback CSS. It is inserted as the **first** child of
 * `<head>` so `ui/style.css` (linked later in the document) always overrides it.
 * @type {string}
 */
const FALLBACK_CSS = `
.vox-screen{position:absolute;inset:0;pointer-events:auto;display:flex;align-items:center;
 justify-content:center;color:#e8eef7;font:14px/1.5 "Inter","Segoe UI",system-ui,sans-serif;
 overflow:auto;padding:24px;box-sizing:border-box;z-index:50}
.vox-screen--mainmenu{background:linear-gradient(180deg,rgba(4,7,14,.72),rgba(4,7,14,.42) 45%,rgba(4,7,14,.86))}
.vox-screen--pause,.vox-screen--death{background:rgba(4,7,14,.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.vox-screen--worldcreate,.vox-screen--worldlist,.vox-screen--settings,.vox-screen--controls
 {background:rgba(4,7,14,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);align-items:flex-start}
.vox-screen--loading{background:radial-gradient(120% 90% at 50% 0%,#12203a,#04060a);flex-direction:column;gap:22px}
.vox-panel{width:min(880px,100%);background:rgba(12,18,30,.72);border:1px solid rgba(150,190,255,.14);
 border-radius:16px;padding:26px 28px;box-shadow:0 24px 70px rgba(0,0,0,.55);box-sizing:border-box;margin:auto}
.vox-panel--narrow{width:min(460px,100%)}
.vox-panel h2{margin:0 0 4px;font-size:22px;font-weight:700;letter-spacing:.02em}
.vox-panel-sub{margin:0 0 20px;opacity:.62;font-size:13px}
.vox-btn{display:block;width:100%;box-sizing:border-box;margin:0;padding:11px 16px;text-align:center;
 font:inherit;font-weight:600;color:#e8eef7;background:rgba(255,255,255,.07);cursor:pointer;
 border:1px solid rgba(150,190,255,.18);border-radius:10px;transition:background .12s,border-color .12s}
.vox-btn:hover{background:rgba(120,180,255,.18)}
.vox-btn:focus-visible,.vox-btn.is-focus{outline:2px solid #6cb6ff;outline-offset:2px;background:rgba(120,180,255,.22)}
.vox-btn[disabled]{opacity:.4;cursor:not-allowed}
.vox-btn--primary{background:linear-gradient(180deg,#3f86e0,#2b62ac);border-color:rgba(160,210,255,.4)}
.vox-btn--danger{background:rgba(190,60,60,.24);border-color:rgba(255,120,120,.32)}
.vox-btn--ghost{background:transparent}
.vox-btn--inline{display:inline-block;width:auto}
.vox-row{display:flex;gap:10px;align-items:center}
.vox-menu-inner{display:flex;flex-direction:column;align-items:center;gap:26px;text-align:center}
.vox-menu-title{margin:0;font-size:clamp(42px,9vw,96px);font-weight:800;letter-spacing:.2em;
 background:linear-gradient(180deg,#fff,#8fd0ff 60%,#3f7fd0);-webkit-background-clip:text;background-clip:text;color:transparent}
.vox-menu-subtitle{margin:-14px 0 0;opacity:.6;letter-spacing:.36em;text-transform:uppercase;font-size:12px}
.vox-menu-buttons{display:flex;flex-direction:column;gap:10px;width:min(320px,80vw)}
.vox-menu-footer{opacity:.42;font-size:11px;letter-spacing:.08em}
.vox-field{margin:0 0 16px}
.vox-field-label{display:block;margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.06em;
 text-transform:uppercase;opacity:.7}
.vox-field-hint{margin:6px 0 0;font-size:12px;opacity:.55}
.vox-input{width:100%;box-sizing:border-box;padding:10px 12px;font:inherit;color:#e8eef7;
 background:rgba(0,0,0,.34);border:1px solid rgba(150,190,255,.2);border-radius:9px}
.vox-input:focus{outline:2px solid #6cb6ff;outline-offset:1px}
.vox-choice{display:flex;gap:8px;flex-wrap:wrap}
.vox-choice .vox-btn{width:auto;flex:1 1 120px}
.vox-choice .vox-btn.is-active{background:rgba(120,180,255,.28);border-color:#6cb6ff}
.vox-list-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.vox-list-card{display:flex;flex-direction:column;gap:6px;padding:14px;text-align:left;
 background:rgba(255,255,255,.05);border:1px solid rgba(150,190,255,.14);border-radius:12px}
.vox-list-card.is-focus{outline:2px solid #6cb6ff;outline-offset:2px}
.vox-list-name{font-size:16px;font-weight:700}
.vox-list-meta{font-size:12px;opacity:.6;display:flex;flex-wrap:wrap;gap:4px 14px}
.vox-list-actions{display:flex;gap:8px;margin-top:6px}
.vox-list-actions .vox-btn{width:auto;flex:1;padding:8px 10px;font-size:13px}
.vox-list-empty{padding:40px 0;text-align:center;opacity:.55}
.vox-settings-tabs,.vox-book-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 18px}
.vox-settings-tab{width:auto;padding:8px 16px;font-size:13px}
.vox-settings-tab.is-active{background:rgba(120,180,255,.26);border-color:#6cb6ff}
.vox-settings-list{display:flex;flex-direction:column;gap:2px;max-height:52vh;overflow:auto;padding-right:6px}
.vox-settings-item{display:grid;grid-template-columns:1fr 220px;gap:8px 18px;align-items:center;
 padding:10px 8px;border-radius:9px;border-bottom:1px solid rgba(255,255,255,.05)}
.vox-settings-item.is-focus{outline:2px solid #6cb6ff;outline-offset:-2px}
.vox-settings-name{font-weight:600}
.vox-settings-desc{grid-column:1;font-size:12px;opacity:.52;margin-top:2px}
.vox-settings-widget{grid-row:1/span 2;display:flex;align-items:center;gap:10px;justify-content:flex-end}
.vox-settings-value{min-width:74px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;opacity:.85}
.vox-settings-restart{font-size:11px;color:#ffcc77;opacity:.9}
.vox-settings-foot{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}
.vox-settings-foot .vox-btn{width:auto}
.vox-slider{width:130px;accent-color:#6cb6ff}
.vox-toggle{width:56px;padding:7px 0;font-size:12px}
.vox-toggle.is-on{background:rgba(90,200,140,.26);border-color:rgba(120,240,180,.4)}
.vox-select{padding:8px 10px;font:inherit;color:#e8eef7;background:rgba(0,0,0,.4);
 border:1px solid rgba(150,190,255,.2);border-radius:8px;min-width:120px}
.vox-controls-list{display:flex;flex-direction:column;gap:2px;max-height:56vh;overflow:auto;padding-right:6px}
.vox-controls-row{display:grid;grid-template-columns:1fr 190px 120px;gap:12px;align-items:center;
 width:100%;padding:9px 10px;text-align:left;font:inherit;color:inherit;background:none;
 border:0;border-bottom:1px solid rgba(255,255,255,.05);border-radius:8px;cursor:pointer}
.vox-controls-row:hover{background:rgba(120,180,255,.12)}
.vox-controls-row.is-focus{outline:2px solid #6cb6ff;outline-offset:-2px}
.vox-controls-key{padding:5px 10px;text-align:center;border-radius:7px;font-size:13px;
 background:rgba(0,0,0,.35);border:1px solid rgba(150,190,255,.22)}
.vox-controls-row.is-capturing .vox-controls-key{background:rgba(255,190,80,.3);border-color:#ffbe50}
.vox-controls-row.is-conflict .vox-controls-key{border-color:#ff7676;color:#ffb4b4}
.vox-controls-pad{font-size:12px;opacity:.45;text-align:right}
.vox-death-inner{text-align:center;display:flex;flex-direction:column;gap:16px;align-items:center}
.vox-death-title{margin:0;font-size:44px;font-weight:800;color:#ff6b6b;letter-spacing:.04em}
.vox-death-cause{margin:0;font-size:16px;opacity:.85}
.vox-death-score{margin:0;font-size:13px;opacity:.6}
.vox-death-buttons{display:flex;flex-direction:column;gap:10px;width:min(280px,70vw)}
.vox-loading-title{margin:0;font-size:clamp(30px,7vw,64px);font-weight:800;letter-spacing:.2em;opacity:.92}
.vox-loading-bar{width:min(460px,72vw);height:5px;border-radius:4px;background:rgba(255,255,255,.09);overflow:hidden}
.vox-loading-fill{display:block;height:100%;width:0;border-radius:4px;
 background:linear-gradient(90deg,#4ea3ff,#7ce0c0);box-shadow:0 0 18px rgba(78,163,255,.6);transition:width .2s ease}
.vox-loading-step{opacity:.75;font-variant-numeric:tabular-nums;min-height:20px}
.vox-loading-tip{max-width:min(560px,80vw);text-align:center;font-size:13px;opacity:.5;min-height:38px;
 transition:opacity .35s ease}
.vox-loading-tip.is-fading{opacity:0}
.vox-confirm{display:flex;gap:8px;align-items:center;font-size:13px}
.vox-confirm .vox-btn{width:auto;padding:7px 12px;font-size:13px}
`;

/* ------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* ------------------------------------------------------------------------- */

/** True once the fallback stylesheet has been inserted. @type {boolean} */
let stylesInstalled = false;

/**
 * Insert the fallback stylesheet exactly once, before every other stylesheet.
 * @returns {void}
 */
function ensureStyles() {
  if (stylesInstalled) return;
  stylesInstalled = true;
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = FALLBACK_CSS;
  document.head.insertBefore(style, document.head.firstChild);
}

/**
 * Create an element with a class list and optional text content.
 * @param {string} tag Tag name.
 * @param {string} [cls] Space separated class list.
 * @param {string} [text] Text content.
 * @returns {HTMLElement} The new element.
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * Create a navigable button.
 * @param {string} label German button caption.
 * @param {string} cls Extra classes appended to `vox-btn`.
 * @param {function(MouseEvent):void} onClick Click handler.
 * @returns {HTMLButtonElement} The button.
 */
function makeButton(label, cls, onClick) {
  const b = /** @type {HTMLButtonElement} */ (el('button', `vox-btn ${cls || ''}`.trim(), label));
  b.type = 'button';
  b.setAttribute('data-nav', '1');
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Format a duration in seconds as a compact German string.
 * @param {number} seconds Play time in seconds.
 * @returns {string} `'2 h 14 min'`, `'37 min'` or `'unter 1 min'`.
 */
export function formatPlayTime(seconds) {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (s < 60) return 'unter 1 min';
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Cached date formatter, built lazily because `Intl` is not free. @type {*} */
let dateFormatter = null;

/**
 * Format a `Date.now()` timestamp for the world list.
 * @param {number} timestamp Milliseconds since the epoch.
 * @returns {string} German date/time, or `'nie'` for a missing value.
 */
export function formatTimestamp(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'nie';
  try {
    if (dateFormatter === null) {
      dateFormatter = new Intl.DateTimeFormat('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    }
    return dateFormatter.format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Turn free text into a deterministic 32-bit world seed. Pure numbers are used
 * as-is, everything else is folded with FNV-1a plus a final avalanche so
 * "Voxelia" and "voxelia" land far apart.
 * @param {string|number|null|undefined} text Seed text typed by the player.
 * @returns {number} Signed 32-bit seed; a random one for empty input.
 */
export function hashSeed(text) {
  const s = String(text === null || text === undefined ? '' : text).trim();
  if (s.length === 0) return (Math.random() * 4294967296) | 0;
  if (/^-?\d{1,10}$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n | 0;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return h | 0;
}

/**
 * Persist the current key bindings so they survive a reload.
 * @param {*} input The `Input` instance.
 * @returns {boolean} True when the write succeeded.
 */
export function saveBindings(input) {
  if (!input || typeof input.serialize !== 'function') return false;
  try {
    window.localStorage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(input.serialize()));
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore persisted key bindings. Call this once during boot, before the first
 * frame, so the controls screen shows what the player actually configured.
 * @param {*} input The `Input` instance.
 * @returns {boolean} True when stored bindings were applied.
 */
export function loadBindings(input) {
  if (!input || typeof input.deserialize !== 'function') return false;
  try {
    const raw = window.localStorage.getItem(BINDINGS_STORAGE_KEY);
    if (!raw) return false;
    return input.deserialize(JSON.parse(raw));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* Screen base class                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Base class for every screen. Subclasses build their DOM in
 * {@link Screen#mount} and release listeners in {@link Screen#unmount}; the
 * container element itself is created and removed by {@link ScreenManager}.
 */
export class Screen {
  /**
   * @param {ScreenManager} manager Owning manager.
   */
  constructor(manager) {
    /** @type {ScreenManager} Owning manager. */
    this.manager = manager;
    /** @type {*} The `Game` instance (may be a stub in tests). */
    this.game = manager.game;
    /** @type {HTMLElement|null} Container assigned on mount. */
    this.root = null;
    /** @type {boolean} True while the screen is mounted. */
    this.mounted = false;
    /** @type {boolean} Should the manager release pointer lock for this screen? */
    this.releasesPointerLock = true;
  }

  /**
   * Build the screen's DOM into `container`.
   * @param {HTMLElement} container Empty container owned by the manager.
   * @param {Object} [data] Payload passed to `ScreenManager#show`.
   * @returns {void}
   */
  // eslint-disable-next-line no-unused-vars
  mount(container, data) {
    this.root = container;
    this.mounted = true;
  }

  /**
   * Detach listeners. The container is emptied by the manager afterwards.
   * @returns {void}
   */
  unmount() {
    this.mounted = false;
    this.root = null;
  }

  /**
   * Per-frame update; only screens with animation override this.
   * @param {number} dt Seconds since the previous frame.
   * @returns {void}
   */
  // eslint-disable-next-line no-unused-vars
  update(dt) {}

  /**
   * Escape was pressed.
   * @returns {boolean} `true` when the manager should perform the default back
   *   navigation, `false` when the screen already handled the key.
   */
  onEscape() {
    return true;
  }

  /**
   * Convenience: play a UI sound if the audio engine is up.
   * @param {string} name Sound name (`'click'`, `'ui_back'`, `'ui_error'`, …).
   * @returns {void}
   * @protected
   */
  _sound(name) {
    const audio = this.game && this.game.audio;
    if (audio && typeof audio.playUI === 'function') {
      try { audio.playUI(name); } catch { /* audio never breaks the UI */ }
    }
  }

  /**
   * Convenience: the settings instance, or `null`.
   * @returns {*} The `Settings` instance.
   * @protected
   */
  _settings() {
    return (this.game && this.game.settings) || null;
  }
}

/* ------------------------------------------------------------------------- */
/* MainMenu                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Title screen. Rendered as a translucent overlay so the slowly orbiting menu
 * world stays visible behind it.
 */
export class MainMenu extends Screen {
  /**
   * @param {HTMLElement} container Container element.
   * @param {Object} [data] Unused.
   * @returns {void}
   */
  mount(container, data) {
    super.mount(container, data);
    const inner = el('div', 'vox-menu-inner');

    inner.appendChild(el('h1', 'vox-menu-title', 'VOXELIA'));
    inner.appendChild(el('p', 'vox-menu-subtitle', 'Unendliche Welten'));

    const buttons = el('div', 'vox-menu-buttons');
    buttons.appendChild(makeButton('Welt erstellen', 'vox-btn--primary vox-menu-button', () => {
      this._sound('ui_select');
      this.manager.show('worldcreate');
    }));
    buttons.appendChild(makeButton('Welt laden', 'vox-menu-button', () => {
      this._sound('click');
      this.manager.show('worldlist');
    }));
    buttons.appendChild(makeButton('Einstellungen', 'vox-menu-button', () => {
      this._sound('click');
      this.manager.show('settings');
    }));
    buttons.appendChild(makeButton('Steuerung', 'vox-menu-button', () => {
      this._sound('click');
      this.manager.show('controls');
    }));
    inner.appendChild(buttons);

    inner.appendChild(el('div', 'vox-menu-footer',
      'WebGL2 · prozedurale Texturen · farbiges Voxellicht'));

    container.appendChild(inner);
  }

  /**
   * The main menu is the root — Escape does nothing.
   * @returns {boolean} Always `false`.
   */
  onEscape() {
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* WorldCreate                                                                */
/* ------------------------------------------------------------------------- */

/**
 * World creation form: name, seed (with a dice button and free-text hashing),
 * game mode and world type.
 */
export class WorldCreate extends Screen {
  /**
   * @param {ScreenManager} manager Owning manager.
   */
  constructor(manager) {
    super(manager);
    /** @type {string} Selected game mode value. @private */
    this._mode = 'survival';
    /** @type {string} Selected world type value. @private */
    this._type = 'default';
    /** @type {HTMLInputElement|null} @private */
    this._nameInput = null;
    /** @type {HTMLInputElement|null} @private */
    this._seedInput = null;
    /** @type {HTMLElement|null} @private */
    this._seedHint = null;
    /** @type {HTMLElement|null} @private */
    this._modeHint = null;
    /** @type {HTMLElement|null} @private */
    this._typeHint = null;
    /** @type {boolean} Guard against a double submit. @private */
    this._busy = false;
  }

  /**
   * @param {HTMLElement} container Container element.
   * @param {Object} [data] Optional `{name, seed, gameMode, worldType}` prefill.
   * @returns {void}
   */
  mount(container, data) {
    super.mount(container, data);
    this._busy = false;
    const panel = el('div', 'vox-panel vox-panel--narrow vox-create-panel');
    panel.appendChild(el('h2', 'vox-create-title', 'Neue Welt erstellen'));
    panel.appendChild(el('p', 'vox-panel-sub',
      'Gleicher Startwert und gleicher Welttyp erzeugen immer dieselbe Welt.'));

    /* -- name ------------------------------------------------------------- */
    const nameField = el('div', 'vox-field vox-create-field');
    const nameLabel = el('label', 'vox-field-label', 'Weltname');
    nameLabel.htmlFor = 'vox-create-name';
    nameField.appendChild(nameLabel);
    const nameInput = /** @type {HTMLInputElement} */ (el('input', 'vox-input vox-create-name'));
    nameInput.id = 'vox-create-name';
    nameInput.type = 'text';
    nameInput.maxLength = 64;
    nameInput.placeholder = 'Neue Welt';
    nameInput.value = (data && typeof data.name === 'string') ? data.name : this._defaultName();
    nameInput.setAttribute('data-nav', '1');
    nameField.appendChild(nameInput);
    this._nameInput = nameInput;
    panel.appendChild(nameField);

    /* -- seed ------------------------------------------------------------- */
    const seedField = el('div', 'vox-field vox-create-field');
    const seedLabel = el('label', 'vox-field-label', 'Startwert (Seed)');
    seedLabel.htmlFor = 'vox-create-seed';
    seedField.appendChild(seedLabel);
    const seedRow = el('div', 'vox-row vox-create-seedrow');
    const seedInput = /** @type {HTMLInputElement} */ (el('input', 'vox-input vox-create-seed'));
    seedInput.id = 'vox-create-seed';
    seedInput.type = 'text';
    seedInput.maxLength = 48;
    seedInput.placeholder = 'leer lassen für Zufall';
    seedInput.value = (data && data.seed !== undefined && data.seed !== null) ? String(data.seed) : '';
    seedInput.setAttribute('data-nav', '1');
    seedInput.addEventListener('input', () => this._refreshSeedHint());
    seedRow.appendChild(seedInput);
    this._seedInput = seedInput;

    const dice = makeButton('🎲', 'vox-btn--inline vox-create-dice', () => {
      seedInput.value = String((Math.random() * 4294967296) | 0);
      this._refreshSeedHint();
      this._sound('click');
    });
    dice.title = 'Zufälligen Startwert würfeln';
    dice.setAttribute('aria-label', 'Zufälligen Startwert würfeln');
    seedRow.appendChild(dice);
    seedField.appendChild(seedRow);

    this._seedHint = el('p', 'vox-field-hint vox-create-seedhint', '');
    seedField.appendChild(this._seedHint);
    panel.appendChild(seedField);
    this._refreshSeedHint();

    /* -- game mode -------------------------------------------------------- */
    if (data && typeof data.gameMode === 'string') this._mode = data.gameMode;
    const modeField = el('div', 'vox-field vox-create-field');
    modeField.appendChild(el('span', 'vox-field-label', 'Spielmodus'));
    const modeChoice = el('div', 'vox-choice vox-create-modes');
    for (const opt of GAME_MODE_OPTIONS) {
      const b = makeButton(opt.label, 'vox-create-mode', () => {
        this._mode = opt.value;
        this._syncChoice(modeChoice, opt.value);
        if (this._modeHint) this._modeHint.textContent = opt.description;
        this._sound('click');
      });
      b.dataset.value = opt.value;
      modeChoice.appendChild(b);
    }
    modeField.appendChild(modeChoice);
    this._modeHint = el('p', 'vox-field-hint vox-create-modehint', '');
    modeField.appendChild(this._modeHint);
    panel.appendChild(modeField);
    this._syncChoice(modeChoice, this._mode);
    this._modeHint.textContent = this._describe(GAME_MODE_OPTIONS, this._mode);

    /* -- world type ------------------------------------------------------- */
    if (data && typeof data.worldType === 'string') this._type = data.worldType;
    const typeField = el('div', 'vox-field vox-create-field');
    typeField.appendChild(el('span', 'vox-field-label', 'Welttyp'));
    const typeChoice = el('div', 'vox-choice vox-create-types');
    for (const opt of WORLD_TYPE_OPTIONS) {
      const b = makeButton(opt.label, 'vox-create-type', () => {
        this._type = opt.value;
        this._syncChoice(typeChoice, opt.value);
        if (this._typeHint) this._typeHint.textContent = opt.description;
        this._sound('click');
      });
      b.dataset.value = opt.value;
      typeChoice.appendChild(b);
    }
    typeField.appendChild(typeChoice);
    this._typeHint = el('p', 'vox-field-hint vox-create-typehint', '');
    typeField.appendChild(this._typeHint);
    panel.appendChild(typeField);
    this._syncChoice(typeChoice, this._type);
    this._typeHint.textContent = this._describe(WORLD_TYPE_OPTIONS, this._type);

    /* -- actions ---------------------------------------------------------- */
    const actions = el('div', 'vox-row vox-create-actions');
    const create = makeButton('Erstellen', 'vox-btn--primary vox-create-submit', () => this._submit());
    const back = makeButton('Zurück', 'vox-btn--ghost vox-create-back', () => {
      this._sound('ui_back');
      this.manager.back();
    });
    actions.appendChild(back);
    actions.appendChild(create);
    panel.appendChild(actions);

    container.appendChild(panel);
  }

  /**
   * Mark the active button of a choice group.
   * @param {HTMLElement} group The `.vox-choice` container.
   * @param {string} value Active value.
   * @returns {void}
   * @private
   */
  _syncChoice(group, value) {
    const kids = group.children;
    for (let i = 0; i < kids.length; i++) {
      const child = /** @type {HTMLElement} */ (kids[i]);
      child.classList.toggle('is-active', child.dataset.value === value);
      child.setAttribute('aria-pressed', child.dataset.value === value ? 'true' : 'false');
    }
  }

  /**
   * Description of a selected option.
   * @param {ReadonlyArray<{value:string, description:string}>} list Option list.
   * @param {string} value Selected value.
   * @returns {string} The description, or `''`.
   * @private
   */
  _describe(list, value) {
    for (const opt of list) if (opt.value === value) return opt.description;
    return '';
  }

  /**
   * Update the live "wird zu …" hint under the seed field.
   * @returns {void}
   * @private
   */
  _refreshSeedHint() {
    if (!this._seedHint || !this._seedInput) return;
    const raw = this._seedInput.value.trim();
    if (raw.length === 0) {
      this._seedHint.textContent = 'Leer: es wird ein zufälliger Startwert gewürfelt.';
      return;
    }
    this._seedHint.textContent = `Startwert: ${hashSeed(raw)}`;
  }

  /**
   * A reasonable default world name (`Neue Welt`, `Neue Welt (2)`, …).
   * @returns {string} The suggestion.
   * @private
   */
  _defaultName() {
    const known = this.manager.knownWorldNames;
    let name = 'Neue Welt';
    let n = 2;
    while (known.has(name) && n < 999) {
      name = `Neue Welt (${n})`;
      n++;
    }
    return name;
  }

  /**
   * Validate and hand the world off to `game.startWorld()`.
   * @returns {void}
   * @private
   */
  _submit() {
    if (this._busy) return;
    const nameRaw = this._nameInput ? this._nameInput.value.trim() : '';
    const name = nameRaw.length === 0 ? 'Neue Welt' : nameRaw.slice(0, 64);
    const seedText = this._seedInput ? this._seedInput.value.trim() : '';
    const seed = hashSeed(seedText);
    const type = WORLD_TYPE_OPTIONS.find((o) => o.value === this._type) || WORLD_TYPE_OPTIONS[0];

    this._busy = true;
    this._sound('ui_select');
    const payload = {
      name,
      seed,
      seedText,
      gameMode: this._mode,
      generator: type.value,
      generatorOptions: { ...type.options },
    };
    this.manager.show('loading', { title: 'Welt wird erzeugt', step: `„${name}" wird vorbereitet…` });
    this.manager.startWorld(payload).catch((err) => {
      this._busy = false;
      this.manager.reportError('Die Welt konnte nicht erstellt werden.', err);
    });
  }
}

/* ------------------------------------------------------------------------- */
/* WorldList                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Saved-world browser. Cards show name, seed, last played and play time and
 * carry a delete button that asks for confirmation inline.
 */
export class WorldList extends Screen {
  /**
   * @param {ScreenManager} manager Owning manager.
   */
  constructor(manager) {
    super(manager);
    /** @type {HTMLElement|null} Grid the cards live in. @private */
    this._grid = null;
    /** @type {number} Increments per mount; stale async loads are dropped. @private */
    this._loadToken = 0;
    /** @type {boolean} Guard against double activation. @private */
    this._busy = false;
  }

  /**
   * @param {HTMLElement} container Container element.
   * @param {Object} [data] Unused.
   * @returns {void}
   */
  mount(container, data) {
    super.mount(container, data);
    this._busy = false;
    const panel = el('div', 'vox-panel vox-list-panel');
    panel.appendChild(el('h2', 'vox-list-title', 'Welt laden'));
    panel.appendChild(el('p', 'vox-panel-sub', 'Gespeicherte Welten aus dem lokalen Speicher.'));

    this._grid = el('div', 'vox-list-grid');
    this._grid.appendChild(el('div', 'vox-list-empty', 'Welten werden geladen…'));
    panel.appendChild(this._grid);

    const actions = el('div', 'vox-row vox-list-footer');
    actions.appendChild(makeButton('Zurück', 'vox-btn--ghost vox-list-back', () => {
      this._sound('ui_back');
      this.manager.back();
    }));
    actions.appendChild(makeButton('Neue Welt', 'vox-btn--primary vox-list-new', () => {
      this._sound('click');
      this.manager.show('worldcreate');
    }));
    panel.appendChild(actions);
    container.appendChild(panel);

    this._reload();
  }

  /**
   * Fetch the world list and rebuild the grid.
   * @returns {void}
   * @private
   */
  _reload() {
    const token = ++this._loadToken;
    const save = this.game && this.game.save;
    if (!save || typeof save.listWorlds !== 'function') {
      this._render([]);
      return;
    }
    Promise.resolve()
      .then(() => (typeof save.open === 'function' ? save.open() : null))
      .then(() => save.listWorlds())
      .then((worlds) => {
        if (token !== this._loadToken || !this.mounted) return;
        this._render(Array.isArray(worlds) ? worlds : []);
      })
      .catch((err) => {
        if (token !== this._loadToken || !this.mounted) return;
        console.warn('[VOXELIA] screens: listWorlds failed', err);
        this._render([]);
      });
  }

  /**
   * Build the card grid.
   * @param {Array<Object>} worlds World metadata records.
   * @returns {void}
   * @private
   */
  _render(worlds) {
    const grid = this._grid;
    if (!grid) return;
    grid.textContent = '';
    this.manager.knownWorldNames.clear();

    if (worlds.length === 0) {
      grid.appendChild(el('div', 'vox-list-empty',
        'Noch keine Welt gespeichert. Erstelle eine neue Welt, um loszulegen.'));
      this.manager.refreshFocusRing();
      return;
    }

    for (const meta of worlds) {
      if (!meta || typeof meta.id !== 'string') continue;
      this.manager.knownWorldNames.add(String(meta.name || ''));
      grid.appendChild(this._card(meta));
    }
    this.manager.refreshFocusRing();
  }

  /**
   * Build one world card.
   * @param {Object} meta World metadata.
   * @returns {HTMLElement} The card element.
   * @private
   */
  _card(meta) {
    const card = el('div', 'vox-list-card');
    card.appendChild(el('div', 'vox-list-name', String(meta.name || 'Unbenannt')));

    const modeLabel = meta.gameMode === 'creative' ? 'Kreativ'
      : (meta.gameMode === 'spectator' ? 'Zuschauer' : 'Überleben');
    const metaRow = el('div', 'vox-list-meta');
    metaRow.appendChild(el('span', 'vox-list-mode', modeLabel));
    metaRow.appendChild(el('span', 'vox-list-seed', `Seed ${meta.seed | 0}`));
    metaRow.appendChild(el('span', 'vox-list-played', `Zuletzt: ${formatTimestamp(meta.lastPlayed)}`));
    metaRow.appendChild(el('span', 'vox-list-time', `Spielzeit: ${formatPlayTime(meta.playTime)}`));
    card.appendChild(metaRow);

    const actions = el('div', 'vox-list-actions');
    const play = makeButton('Spielen', 'vox-btn--primary vox-list-play', () => this._play(meta));
    actions.appendChild(play);

    const del = makeButton('Löschen', 'vox-btn--danger vox-list-delete', () => {
      this._sound('click');
      this._confirmDelete(card, actions, meta);
    });
    actions.appendChild(del);
    card.appendChild(actions);
    return card;
  }

  /**
   * Swap the card's action row for an inline confirmation.
   * @param {HTMLElement} card The card element.
   * @param {HTMLElement} actions The action row to replace.
   * @param {Object} meta World metadata.
   * @returns {void}
   * @private
   */
  _confirmDelete(card, actions, meta) {
    const confirm = el('div', 'vox-confirm vox-list-confirm');
    confirm.appendChild(el('span', 'vox-confirm-text', 'Wirklich unwiderruflich löschen?'));
    const yes = makeButton('Löschen', 'vox-btn--danger', () => {
      confirm.textContent = '';
      confirm.appendChild(el('span', 'vox-confirm-text', 'Wird gelöscht…'));
      this._delete(meta);
    });
    const no = makeButton('Abbrechen', 'vox-btn--ghost', () => {
      card.replaceChild(actions, confirm);
      this.manager.refreshFocusRing();
      this._sound('ui_back');
    });
    confirm.appendChild(yes);
    confirm.appendChild(no);
    card.replaceChild(confirm, actions);
    this.manager.refreshFocusRing();
    no.focus();
  }

  /**
   * Delete a world through the save manager and reload the list.
   * @param {Object} meta World metadata.
   * @returns {void}
   * @private
   */
  _delete(meta) {
    const save = this.game && this.game.save;
    if (!save || typeof save.deleteWorld !== 'function') {
      this._reload();
      return;
    }
    Promise.resolve(save.deleteWorld(meta.id))
      .then(() => { if (this.mounted) this._reload(); })
      .catch((err) => {
        console.warn('[VOXELIA] screens: deleteWorld failed', err);
        if (this.mounted) this._reload();
      });
  }

  /**
   * Load a world.
   * @param {Object} meta World metadata.
   * @returns {void}
   * @private
   */
  _play(meta) {
    if (this._busy) return;
    this._busy = true;
    this._sound('ui_select');
    this.manager.show('loading', {
      title: 'Welt wird geladen',
      step: `„${String(meta.name || 'Welt')}" wird geladen…`,
    });
    this.manager.loadWorld(meta.id).catch((err) => {
      this._busy = false;
      this.manager.reportError('Die Welt konnte nicht geladen werden.', err);
    });
  }
}

/* ------------------------------------------------------------------------- */
/* SettingsScreen                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Settings screen. Everything on it is generated from `settings.getSchema()`
 * — the key list is **never** hard-coded, so a new schema entry shows up here
 * automatically with its German label, description, bounds and widget type.
 */
export class SettingsScreen extends Screen {
  /**
   * @param {ScreenManager} manager Owning manager.
   */
  constructor(manager) {
    super(manager);
    /** @type {string} Active category tab. @private */
    this._tab = CATEGORIES[0];
    /** @type {HTMLElement|null} @private */
    this._list = null;
    /** @type {HTMLElement|null} @private */
    this._tabs = null;
    /** @type {HTMLElement|null} @private */
    this._presetHint = null;
    /** @type {Map<string, {sync:function():void, item:HTMLElement}>} Widgets by key. @private */
    this._widgets = new Map();
    /** @type {function(string, *):void|null} Settings change listener. @private */
    this._onChange = null;
    /** @type {function():void|null} Preset/reset listener. @private */
    this._onBulk = null;
  }

  /**
   * @param {HTMLElement} container Container element.
   * @param {Object} [data] Optional `{tab}` to preselect a category.
   * @returns {void}
   */
  mount(container, data) {
    super.mount(container, data);
    const settings = this._settings();
    if (data && typeof data.tab === 'string' && CATEGORIES.indexOf(data.tab) !== -1) {
      this._tab = data.tab;
    }

    const panel = el('div', 'vox-panel vox-settings-panel');
    panel.appendChild(el('h2', 'vox-settings-title', 'Einstellungen'));
    panel.appendChild(el('p', 'vox-panel-sub',
      'Änderungen greifen sofort und werden automatisch gespeichert.'));

    /* -- tabs ------------------------------------------------------------- */
    this._tabs = el('div', 'vox-settings-tabs');
    for (const category of CATEGORIES) {
      const b = makeButton(category, 'vox-settings-tab', () => {
        if (this._tab === category) return;
        this._tab = category;
        this._syncTabs();
        this._buildList();
        this._sound('click');
        this.manager.refreshFocusRing();
      });
      b.dataset.tab = category;
      this._tabs.appendChild(b);
    }
    panel.appendChild(this._tabs);
    this._syncTabs();

    /* -- list ------------------------------------------------------------- */
    this._list = el('div', 'vox-settings-list');
    panel.appendChild(this._list);
    this._buildList();

    /* -- presets ---------------------------------------------------------- */
    const presetRow = el('div', 'vox-settings-foot vox-settings-presets');
    presetRow.appendChild(el('span', 'vox-field-label vox-settings-presetlabel', 'Voreinstellung'));
    for (const name of Object.keys(QUALITY_PRESETS)) {
      const label = PRESET_LABELS[name] || name;
      const b = makeButton(label, 'vox-settings-preset', () => {
        if (settings && typeof settings.applyPreset === 'function') settings.applyPreset(name);
        this._syncAll();
        this._syncPresetHint();
        this._sound('ui_select');
      });
      b.dataset.preset = name;
      b.title = PRESET_HINTS[name] || '';
      presetRow.appendChild(b);
    }
    panel.appendChild(presetRow);
    this._presetHint = el('p', 'vox-field-hint vox-settings-presethint', '');
    panel.appendChild(this._presetHint);
    this._syncPresetHint();

    /* -- footer ----------------------------------------------------------- */
    const foot = el('div', 'vox-settings-foot');
    foot.appendChild(makeButton('Zurück', 'vox-btn--ghost vox-settings-back', () => {
      this._sound('ui_back');
      this.manager.back();
    }));
    foot.appendChild(makeButton('Alles zurücksetzen', 'vox-btn--danger vox-settings-reset', () => {
      if (settings && typeof settings.reset === 'function') settings.reset();
      this._syncAll();
      this._syncPresetHint();
      this._sound('ui_back');
    }));
    panel.appendChild(foot);

    container.appendChild(panel);

    /* -- external changes ------------------------------------------------- */
    if (settings && typeof settings.on === 'function') {
      this._onChange = (key) => {
        const entry = this._widgets.get(key);
        if (entry) entry.sync();
      };
      this._onBulk = () => { this._syncAll(); this._syncPresetHint(); };
      settings.on('change', this._onChange);
      settings.on('preset', this._onBulk);
      settings.on('reset', this._onBulk);
    }
  }

  /**
   * @returns {void}
   */
  unmount() {
    const settings = this._settings();
    if (settings && typeof settings.off === 'function') {
      if (this._onChange) settings.off('change', this._onChange);
      if (this._onBulk) {
        settings.off('preset', this._onBulk);
        settings.off('reset', this._onBulk);
      }
      if (typeof settings.save === 'function') settings.save();
    }
    this._onChange = null;
    this._onBulk = null;
    this._widgets.clear();
    this._list = null;
    this._tabs = null;
    this._presetHint = null;
    super.unmount();
  }

  /**
   * Highlight the active tab button.
   * @returns {void}
   * @private
   */
  _syncTabs() {
    if (!this._tabs) return;
    const kids = this._tabs.children;
    for (let i = 0; i < kids.length; i++) {
      const child = /** @type {HTMLElement} */ (kids[i]);
      child.classList.toggle('is-active', child.dataset.tab === this._tab);
      child.setAttribute('aria-selected', child.dataset.tab === this._tab ? 'true' : 'false');
    }
  }

  /**
   * Rebuild the widget list for the active category.
   * @returns {void}
   * @private
   */
  _buildList() {
    const list = this._list;
    if (!list) return;
    list.textContent = '';
    this._widgets.clear();

    const settings = this._settings();
    const schema = (settings && typeof settings.getSchema === 'function') ? settings.getSchema() : [];
    let count = 0;
    for (const entry of schema) {
      if (!entry || entry.category !== this._tab) continue;
      const row = this._buildRow(entry, settings);
      if (row !== null) {
        list.appendChild(row);
        count++;
      }
    }
    if (count === 0) {
      list.appendChild(el('div', 'vox-list-empty', 'In dieser Kategorie gibt es nichts einzustellen.'));
    }
  }

  /**
   * Build one settings row: label, description and the widget for its type.
   * @param {Object} entry Schema entry.
   * @param {*} settings The `Settings` instance.
   * @returns {HTMLElement|null} The row, or `null` for an unsupported type.
   * @private
   */
  _buildRow(entry, settings) {
    const item = el('div', `vox-settings-item vox-settings-item--${entry.type}`);
    item.dataset.key = entry.key;

    const name = el('div', 'vox-settings-name', entry.label || entry.key);
    if (entry.restart) {
      const flag = el('span', 'vox-settings-restart', ' · Neustart nötig');
      name.appendChild(flag);
    }
    item.appendChild(name);
    item.appendChild(el('div', 'vox-settings-desc', entry.description || ''));

    const widget = el('div', 'vox-settings-widget');
    item.appendChild(widget);

    const read = () => (settings && typeof settings.get === 'function' ? settings.get(entry.key) : entry.default);
    const write = (value) => {
      if (settings && typeof settings.set === 'function') settings.set(entry.key, value);
    };

    /** @type {function():void} */
    let sync = () => {};

    if (entry.type === 'bool') {
      const toggle = makeButton('', 'vox-toggle vox-settings-toggle', () => {
        write(!read());
        sync();
        this._syncPresetHint();
        this._sound('ui_toggle');
      });
      toggle.setAttribute('role', 'switch');
      widget.appendChild(toggle);
      sync = () => {
        const on = !!read();
        toggle.textContent = on ? 'An' : 'Aus';
        toggle.classList.toggle('is-on', on);
        toggle.setAttribute('aria-checked', on ? 'true' : 'false');
        this._markDefault(item, entry, read());
      };
    } else if (entry.type === 'enum') {
      const select = /** @type {HTMLSelectElement} */ (el('select', 'vox-select vox-settings-select'));
      select.setAttribute('data-nav', '1');
      const options = (settings && typeof settings.getOptions === 'function')
        ? settings.getOptions(entry.key)
        : (entry.options || []);
      for (const opt of options) {
        const o = /** @type {HTMLOptionElement} */ (el('option', '', opt.label));
        o.value = String(opt.value);
        select.appendChild(o);
      }
      select.addEventListener('change', () => {
        const raw = select.value;
        const match = options.find((o) => String(o.value) === raw);
        write(match ? match.value : raw);
        sync();
        this._syncPresetHint();
        this._sound('click');
      });
      widget.appendChild(select);
      sync = () => {
        select.value = String(read());
        this._markDefault(item, entry, read());
      };
    } else if (entry.type === 'int' || entry.type === 'float') {
      const slider = /** @type {HTMLInputElement} */ (el('input', 'vox-slider vox-settings-slider'));
      slider.type = 'range';
      slider.min = String(Number.isFinite(entry.min) ? entry.min : 0);
      slider.max = String(Number.isFinite(entry.max) ? entry.max : 1);
      slider.step = String(Number.isFinite(entry.step) ? entry.step : (entry.type === 'int' ? 1 : 0.01));
      slider.setAttribute('data-nav', '1');
      const value = el('span', 'vox-settings-value', '');
      slider.addEventListener('input', () => {
        write(entry.type === 'int' ? Math.round(Number(slider.value)) : Number(slider.value));
        sync();
      });
      slider.addEventListener('change', () => this._syncPresetHint());
      widget.appendChild(slider);
      widget.appendChild(value);
      sync = () => {
        const current = Number(read());
        if (Number.isFinite(current)) slider.value = String(current);
        value.textContent = (settings && typeof settings.formatValue === 'function')
          ? settings.formatValue(entry.key)
          : String(read());
        this._markDefault(item, entry, read());
      };
    } else {
      return null;
    }

    sync();
    this._widgets.set(entry.key, { sync, item });
    return item;
  }

  /**
   * Flag a row whose value differs from the shipped default.
   * @param {HTMLElement} item The row element.
   * @param {Object} entry Schema entry.
   * @param {*} value Current value.
   * @returns {void}
   * @private
   */
  _markDefault(item, entry, value) {
    const def = DEFAULTS[entry.key];
    item.classList.toggle('is-modified', def !== undefined && !Object.is(def, value));
  }

  /**
   * Refresh every widget from the settings store.
   * @returns {void}
   * @private
   */
  _syncAll() {
    for (const entry of this._widgets.values()) entry.sync();
  }

  /**
   * Update the preset hint line and the active preset button.
   * @returns {void}
   * @private
   */
  _syncPresetHint() {
    const settings = this._settings();
    const detected = (settings && typeof settings.detectPreset === 'function')
      ? settings.detectPreset() : null;
    if (this._presetHint) {
      this._presetHint.textContent = detected
        ? (PRESET_HINTS[detected] || `Voreinstellung: ${PRESET_LABELS[detected] || detected}`)
        : 'Eigene Konfiguration — keine Voreinstellung aktiv.';
    }
    const root = this.root;
    if (!root) return;
    const buttons = root.querySelectorAll('.vox-settings-preset');
    for (let i = 0; i < buttons.length; i++) {
      const b = /** @type {HTMLElement} */ (buttons[i]);
      b.classList.toggle('is-active', b.dataset.preset === detected);
    }
  }
}

/* ------------------------------------------------------------------------- */
/* ControlsScreen                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Rebindable key list driven by the input action map. Clicking a row captures
 * the next key, mouse button or Escape (which cancels).
 */
export class ControlsScreen extends Screen {
  /**
   * @param {ScreenManager} manager Owning manager.
   */
  constructor(manager) {
    super(manager);
    /** @type {string|null} Action currently waiting for a key. @private */
    this._capturing = null;
    /** @type {Map<string, {row:HTMLElement, key:HTMLElement, pad:HTMLElement}>} @private */
    this._rows = new Map();
    /** @type {function(KeyboardEvent):void|null} @private */
    this._keyHandler = null;
    /** @type {function(MouseEvent):void|null} @private */
    this._mouseHandler = null;
    /** @type {HTMLElement|null} @private */
    this._status = null;
  }

  /**
   * @param {HTMLElement} container Container element.
   * @param {Object} [data] Unused.
   * @returns {void}
   */
  mount(container, data) {
    super.mount(container, data);
    const panel = el('div', 'vox-panel vox-controls-panel');
    panel.appendChild(el('h2', 'vox-controls-title', 'Steuerung'));
    panel.appendChild(el('p', 'vox-panel-sub',
      'Eine Zeile anklicken und die neue Taste drücken. Escape bricht ab, Entf löscht die Belegung.'));

    const list = el('div', 'vox-controls-list');
    const input = this.game && this.game.input;
    const actions = (input && Array.isArray(input._actionList)) ? ACTIONS : ACTIONS;
    for (const action of actions) {
      list.appendChild(this._row(action, input));
    }
    panel.appendChild(list);

    this._status = el('p', 'vox-field-hint vox-controls-status', '');
    panel.appendChild(this._status);

    const foot = el('div', 'vox-settings-foot vox-controls-footer');
    foot.appendChild(makeButton('Zurück', 'vox-btn--ghost vox-controls-back', () => {
      this._sound('ui_back');
      this.manager.back();
    }));
    foot.appendChild(makeButton('Standard wiederherstellen', 'vox-btn--danger vox-controls-reset', () => {
      if (input && typeof input.resetBindings === 'function') input.resetBindings();
      saveBindings(input);
      this._syncAll();
      this._setStatus('Standardbelegung wiederhergestellt.');
      this._sound('ui_back');
    }));
    panel.appendChild(foot);

    container.appendChild(panel);
    this._syncAll();
  }

  /**
   * @returns {void}
   */
  unmount() {
    this._stopCapture(false);
    this._rows.clear();
    this._status = null;
    super.unmount();
  }

  /**
   * Build one action row.
   * @param {string} action Action name.
   * @param {*} input The `Input` instance.
   * @returns {HTMLElement} The row button.
   * @private
   */
  _row(action, input) {
    const row = /** @type {HTMLButtonElement} */ (el('button', 'vox-controls-row'));
    row.type = 'button';
    row.setAttribute('data-nav', '1');
    row.dataset.action = action;
    row.appendChild(el('span', 'vox-controls-label', ACTION_LABELS[action] || action));
    const key = el('span', 'vox-controls-key', '');
    row.appendChild(key);
    const pad = el('span', 'vox-controls-pad', '');
    row.appendChild(pad);
    row.addEventListener('click', () => this._startCapture(action));
    this._rows.set(action, { row, key, pad });
    void input;
    return row;
  }

  /**
   * Begin capturing the next key for an action.
   * @param {string} action Action name.
   * @returns {void}
   * @private
   */
  _startCapture(action) {
    if (this._capturing === action) {
      this._stopCapture(true);
      return;
    }
    this._stopCapture(false);
    this._capturing = action;
    const entry = this._rows.get(action);
    if (entry) {
      entry.row.classList.add('is-capturing');
      entry.key.textContent = 'Taste drücken…';
    }
    this._setStatus(`„${ACTION_LABELS[action] || action}" wartet auf eine Eingabe.`);
    this._sound('ui_open');

    this._keyHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        this._stopCapture(true);
        return;
      }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        this._apply(action, null);
        return;
      }
      if (!e.code) return;
      this._apply(action, e.code);
    };
    this._mouseHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._apply(action, `Mouse${e.button}`);
    };
    window.addEventListener('keydown', this._keyHandler, true);
    window.addEventListener('mousedown', this._mouseHandler, true);
  }

  /**
   * Stop capturing.
   * @param {boolean} announce Whether to write a status line.
   * @returns {void}
   * @private
   */
  _stopCapture(announce) {
    if (this._keyHandler) {
      window.removeEventListener('keydown', this._keyHandler, true);
      this._keyHandler = null;
    }
    if (this._mouseHandler) {
      window.removeEventListener('mousedown', this._mouseHandler, true);
      this._mouseHandler = null;
    }
    const action = this._capturing;
    this._capturing = null;
    if (action !== null) {
      const entry = this._rows.get(action);
      if (entry) entry.row.classList.remove('is-capturing');
      if (announce) this._setStatus('Abgebrochen.');
    }
    this._syncAll();
  }

  /**
   * Write a binding, resolving conflicts by unbinding the other actions.
   * @param {string} action Action name.
   * @param {string|null} code Binding code, or `null` to unbind.
   * @returns {void}
   * @private
   */
  _apply(action, code) {
    const input = this.game && this.game.input;
    if (!input || typeof input.bind !== 'function') {
      this._stopCapture(false);
      return;
    }
    if (code === null) {
      input.bind(action, null);
      saveBindings(input);
      this._stopCapture(false);
      this._setStatus(`„${ACTION_LABELS[action] || action}" ist jetzt unbelegt.`);
      this._sound('ui_back');
      return;
    }
    /** @type {string[]} */
    const conflicts = typeof input.findConflicts === 'function' ? input.findConflicts(code, action) : [];
    for (const other of conflicts) input.bind(other, null);
    input.bind(action, code);
    saveBindings(input);
    this._stopCapture(false);
    if (conflicts.length > 0) {
      const names = conflicts.map((a) => ACTION_LABELS[a] || a).join(', ');
      this._setStatus(`${codeLabel(code)} zugewiesen. Belegung entfernt bei: ${names}.`);
      this._sound('ui_error');
    } else {
      this._setStatus(`${codeLabel(code)} zugewiesen.`);
      this._sound('ui_select');
    }
  }

  /**
   * Refresh every row from the input binding maps.
   * @returns {void}
   * @private
   */
  _syncAll() {
    const input = this.game && this.game.input;
    for (const [action, entry] of this._rows) {
      if (this._capturing === action) continue;
      const code = (input && typeof input.getBinding === 'function') ? input.getBinding(action) : null;
      entry.key.textContent = codeLabel(code);
      const padCode = (input && typeof input.getGamepadBinding === 'function')
        ? input.getGamepadBinding(action) : null;
      entry.pad.textContent = padCode ? codeLabel(padCode) : '';
      const conflicted = code !== null && input && typeof input.findConflicts === 'function'
        && input.findConflicts(code, action).length > 0;
      entry.row.classList.toggle('is-conflict', !!conflicted);
    }
  }

  /**
   * Write the status line under the list.
   * @param {string} text German status text.
   * @returns {void}
   * @private
   */
  _setStatus(text) {
    if (this._status) this._status.textContent = text;
  }

  /**
   * Escape cancels an active capture instead of leaving the screen.
   * @returns {boolean} `true` when the manager should navigate back.
   */
  onEscape() {
    if (this._capturing !== null) {
      this._stopCapture(true);
      return false;
    }
    return true;
  }
}

/* ------------------------------------------------------------------------- */
/* PauseScreen                                                                */
/* ------------------------------------------------------------------------- */

/**
 * In-game pause menu. The world keeps rendering behind a backdrop blur.
 */
export class PauseScreen extends Screen {
  /**
   * @param {HTMLElement} container Container element.
   * @param {Object} [data] Unused.
   * @returns {void}
   */
  mount(container, data) {
    super.mount(container, data);
    const panel = el('div', 'vox-panel vox-panel--narrow vox-pause-panel');
    panel.appendChild(el('h2', 'vox-pause-title', 'Pause'));

    const world = this.game && this.game.world;
    const name = world && typeof world.name === 'string' ? world.name : '';
    panel.appendChild(el('p', 'vox-panel-sub', name ? `Welt: ${name}` : 'Das Spiel ist angehalten.'));

    const buttons = el('div', 'vox-menu-buttons vox-pause-buttons');
    buttons.appendChild(makeButton('Weiterspielen', 'vox-btn--primary vox-pause-resume', () => {
      this._sound('ui_close');
      this.manager.resumeGame();
    }));
    buttons.appendChild(makeButton('Einstellungen', 'vox-pause-settings', () => {
      this._sound('click');
      this.manager.show('settings');
    }));
    buttons.appendChild(makeButton('Steuerung', 'vox-pause-controls', () => {
      this._sound('click');
      this.manager.show('controls');
    }));
    const quit = makeButton('Speichern und beenden', 'vox-btn--danger vox-pause-quit', () => {
      quit.disabled = true;
      quit.textContent = 'Wird gespeichert…';
      this._sound('ui_back');
      this.manager.saveAndQuit().catch((err) => {
        this.manager.reportError('Die Welt konnte nicht gespeichert werden.', err);
      });
    });
    buttons.appendChild(quit);
    panel.appendChild(buttons);

    container.appendChild(panel);
  }

  /**
   * Escape resumes instead of navigating back.
   * @returns {boolean} Always `false`.
   */
  onEscape() {
    this._sound('ui_close');
    this.manager.resumeGame();
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* DeathScreen                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Death screen: the German cause of death, the score and two buttons.
 */
export class DeathScreen extends Screen {
  /**
   * @param {HTMLElement} container Container element.
   * @param {Object} [data] `{message, label, source, score, xp, level}` — the
   *   payload of the combat system's `'death'` event works unchanged.
   * @returns {void}
   */
  mount(container, data) {
    super.mount(container, data);
    const payload = data || {};
    const player = this.game && this.game.player;

    const inner = el('div', 'vox-death-inner');
    inner.appendChild(el('h2', 'vox-death-title', 'Du bist gestorben'));

    const message = typeof payload.message === 'string' && payload.message.length > 0
      ? payload.message
      : 'ist gestorben';
    const cause = typeof payload.label === 'string' && payload.label.length > 0
      ? `${message} · ${payload.label}`
      : message;
    inner.appendChild(el('p', 'vox-death-cause', `Du ${cause}.`));

    const score = Number.isFinite(payload.score) ? payload.score
      : (Number.isFinite(payload.xp) ? payload.xp
        : (player && Number.isFinite(player.xp) ? player.xp : 0));
    const level = Number.isFinite(payload.level) ? payload.level
      : (player && Number.isFinite(player.xpLevel) ? player.xpLevel : 0);
    inner.appendChild(el('p', 'vox-death-score',
      `Punkte: ${Math.max(0, Math.round(score))} · Stufe: ${Math.max(0, Math.round(level))}`));

    const buttons = el('div', 'vox-death-buttons');
    buttons.appendChild(makeButton('Wiederbeleben', 'vox-btn--primary vox-death-respawn', () => {
      this._sound('ui_select');
      this.manager.respawn();
    }));
    buttons.appendChild(makeButton('Zum Hauptmenü', 'vox-death-menu', () => {
      this._sound('ui_back');
      this.manager.saveAndQuit().catch((err) => {
        this.manager.reportError('Die Welt konnte nicht gespeichert werden.', err);
      });
    }));
    inner.appendChild(buttons);
    container.appendChild(inner);
  }

  /**
   * Escape must not dismiss the death screen.
   * @returns {boolean} Always `false`.
   */
  onEscape() {
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* LoadingScreen                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Progress screen shown while the renderer builds its textures and the world
 * streams its first chunks. Drive it with {@link LoadingScreen#setProgress} or
 * — more conveniently — with `ScreenManager#setProgress`, which is also wired
 * to the game's `'progress'` event.
 */
export class LoadingScreen extends Screen {
  /**
   * @param {ScreenManager} manager Owning manager.
   */
  constructor(manager) {
    super(manager);
    this.releasesPointerLock = true;
    /** @type {HTMLElement|null} @private */
    this._fill = null;
    /** @type {HTMLElement|null} @private */
    this._step = null;
    /** @type {HTMLElement|null} @private */
    this._tip = null;
    /** @type {number} Seconds until the next tip. @private */
    this._tipTimer = 0;
    /** @type {number} Index of the visible tip. @private */
    this._tipIndex = 0;
    /** @type {number} Current progress 0..1. @private */
    this._progress = 0;
  }

  /**
   * @param {HTMLElement} container Container element.
   * @param {Object} [data] `{title, step, progress}`.
   * @returns {void}
   */
  mount(container, data) {
    super.mount(container, data);
    const payload = data || {};
    container.appendChild(el('h2', 'vox-loading-title',
      typeof payload.title === 'string' ? payload.title : 'VOXELIA'));

    const bar = el('div', 'vox-loading-bar');
    this._fill = el('i', 'vox-loading-fill');
    bar.appendChild(this._fill);
    container.appendChild(bar);

    this._step = el('div', 'vox-loading-step',
      typeof payload.step === 'string' ? payload.step : 'Initialisiere…');
    container.appendChild(this._step);

    this._tipIndex = (Math.random() * LOADING_TIPS.length) | 0;
    this._tip = el('div', 'vox-loading-tip', LOADING_TIPS[this._tipIndex]);
    container.appendChild(this._tip);
    this._tipTimer = TIP_INTERVAL;

    this._progress = 0;
    if (Number.isFinite(payload.progress)) this.setProgress(payload.progress, null);
  }

  /**
   * @returns {void}
   */
  unmount() {
    this._fill = null;
    this._step = null;
    this._tip = null;
    super.unmount();
  }

  /**
   * Update the bar and (optionally) the step caption.
   * @param {number} fraction Progress 0..1.
   * @param {string|null} [step] German name of the current step.
   * @returns {void}
   */
  setProgress(fraction, step) {
    const value = clamp(Number.isFinite(fraction) ? fraction : 0, 0, 1);
    this._progress = value;
    if (this._fill) this._fill.style.width = `${(value * 100).toFixed(1)}%`;
    if (this._step && typeof step === 'string' && step.length > 0) {
      this._step.textContent = `${step} · ${Math.round(value * 100)}%`;
    } else if (this._step) {
      const base = this._step.textContent.split(' · ')[0];
      this._step.textContent = `${base} · ${Math.round(value * 100)}%`;
    }
  }

  /**
   * Rotate the tip line.
   * @param {number} dt Seconds since the previous frame.
   * @returns {void}
   */
  update(dt) {
    if (!this._tip) return;
    this._tipTimer -= Number.isFinite(dt) ? dt : 0;
    if (this._tipTimer > 0) return;
    this._tipTimer = TIP_INTERVAL;
    this._tipIndex = (this._tipIndex + 1) % LOADING_TIPS.length;
    const tip = this._tip;
    tip.classList.add('is-fading');
    window.setTimeout(() => {
      if (!this.mounted || this._tip !== tip) return;
      tip.textContent = LOADING_TIPS[this._tipIndex];
      tip.classList.remove('is-fading');
    }, 320);
  }

  /**
   * Escape must not cancel a load in progress.
   * @returns {boolean} Always `false`.
   */
  onEscape() {
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* ScreenManager                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Owns the screen stack, the container DOM, the shared keyboard navigation and
 * the small bridge into the `Game` class.
 *
 * @example
 * const screens = new ScreenManager(game, document.getElementById('ui'));
 * screens.show('mainmenu');
 * // …later, from the fixed-step loop:
 * screens.update(dt);
 */
export class ScreenManager {
  /**
   * @param {*} game The `Game` instance (only duck-typed access is used, so a
   *   partially built game during boot is fine).
   * @param {HTMLElement} root The `#ui` root element.
   */
  constructor(game, root) {
    ensureStyles();

    /** @type {*} The game. */
    this.game = game;
    /** @type {HTMLElement} UI root. */
    this.root = root;
    /** @type {HTMLElement} Layer every screen container is appended to. */
    this.layer = el('div', 'vox-screens');
    this.layer.style.position = 'absolute';
    this.layer.style.inset = '0';
    this.layer.style.pointerEvents = 'none';
    if (root) root.appendChild(this.layer);

    /** @type {Map<string, Screen>} Registered screens by key. */
    this.screens = new Map();
    /** @type {string|null} Key of the mounted screen. @private */
    this._currentName = null;
    /** @type {Screen|null} The mounted screen. @private */
    this._current = null;
    /** @type {HTMLElement|null} Container of the mounted screen. @private */
    this._container = null;
    /** @type {Array<{name:string, data:Object|undefined}>} Back stack. @private */
    this._history = [];
    /** @type {HTMLElement[]} Focus ring of the mounted screen. @private */
    this._focusRing = [];
    /** @type {number} Index into {@link ScreenManager#_focusRing}. @private */
    this._focusIndex = 0;
    /** @type {boolean} True once {@link ScreenManager#dispose} ran. @private */
    this._disposed = false;
    /** @type {Set<string>} Names of known worlds, for the create-screen default. */
    this.knownWorldNames = new Set();

    /* -- global listeners -------------------------------------------------- */
    /** @type {function(KeyboardEvent):void} @private */
    this._onKeyDown = (e) => this._handleKey(e);
    /** @type {function(FocusEvent):void} @private */
    this._onFocusIn = (e) => this._handleFocus(e, true);
    /** @type {function(FocusEvent):void} @private */
    this._onFocusOut = (e) => this._handleFocus(e, false);
    window.addEventListener('keydown', this._onKeyDown, true);
    this.layer.addEventListener('focusin', this._onFocusIn);
    this.layer.addEventListener('focusout', this._onFocusOut);

    /** @type {function(number, string):void} @private */
    this._onGameProgress = (fraction, step) => this.setProgress(fraction, step);
    if (game && typeof game.on === 'function') game.on('progress', this._onGameProgress);

    this.registerScreen('mainmenu', new MainMenu(this));
    this.registerScreen('worldcreate', new WorldCreate(this));
    this.registerScreen('worldlist', new WorldList(this));
    this.registerScreen('settings', new SettingsScreen(this));
    this.registerScreen('controls', new ControlsScreen(this));
    this.registerScreen('pause', new PauseScreen(this));
    this.registerScreen('death', new DeathScreen(this));
    this.registerScreen('loading', new LoadingScreen(this));
  }

  /**
   * The mounted screen instance.
   * @returns {Screen|null} The screen, or `null` when nothing is shown.
   */
  get current() {
    return this._current;
  }

  /**
   * Key of the mounted screen.
   * @returns {string|null} The key, or `null`.
   */
  get currentName() {
    return this._currentName;
  }

  /**
   * Whether any screen is currently visible.
   * @returns {boolean} True when a screen is mounted.
   */
  get isOpen() {
    return this._current !== null;
  }

  /**
   * Register (or replace) a screen under a key.
   * @param {string} name Screen key.
   * @param {Screen} screen Screen instance.
   * @returns {ScreenManager} `this`, for chaining.
   */
  registerScreen(name, screen) {
    if (typeof name !== 'string' || name.length === 0 || !screen) return this;
    this.screens.set(name, screen);
    return this;
  }

  /**
   * Show a screen, pushing the previous one onto the back stack.
   * @param {string} name Screen key.
   * @param {Object} [data] Payload handed to the screen's `mount`.
   * @returns {boolean} True when the screen was mounted.
   */
  show(name, data) {
    if (this._disposed) return false;
    const screen = this.screens.get(name);
    if (!screen) {
      console.warn(`[VOXELIA] screens: unknown screen "${name}"`);
      return false;
    }
    if (this._currentName !== null && this._currentName !== name) {
      this._history.push({ name: this._currentName, data: this._currentData });
      if (this._history.length > 16) this._history.shift();
    }
    this._mount(name, screen, data);
    return true;
  }

  /**
   * Replace the current screen without touching the back stack.
   * @param {string} name Screen key.
   * @param {Object} [data] Payload handed to the screen's `mount`.
   * @returns {boolean} True when the screen was mounted.
   */
  replace(name, data) {
    if (this._disposed) return false;
    const screen = this.screens.get(name);
    if (!screen) return false;
    this._mount(name, screen, data);
    return true;
  }

  /**
   * Pop the back stack; hides everything when it is empty.
   * @returns {boolean} True when a previous screen was restored.
   */
  back() {
    const previous = this._history.pop();
    if (!previous) {
      this.hide();
      return false;
    }
    const screen = this.screens.get(previous.name);
    if (!screen) {
      this.hide();
      return false;
    }
    this._mount(previous.name, screen, previous.data);
    return true;
  }

  /**
   * Unmount the current screen and clear the back stack.
   * @returns {void}
   */
  hide() {
    this._unmount();
    this._history.length = 0;
  }

  /**
   * Forward the frame tick to the mounted screen.
   * @param {number} dt Seconds since the previous frame.
   * @returns {void}
   */
  update(dt) {
    if (this._current === null) return;
    try {
      this._current.update(dt);
    } catch (err) {
      this._reportOnce('update', err);
    }
  }

  /**
   * Drive the loading bar. Safe to call at any time — it is a no-op unless the
   * loading screen is mounted.
   * @param {number} fraction Progress 0..1.
   * @param {string} [step] German name of the current step.
   * @returns {void}
   */
  setProgress(fraction, step) {
    const screen = this.screens.get('loading');
    if (screen instanceof LoadingScreen && screen.mounted) {
      screen.setProgress(fraction, step === undefined ? null : step);
    }
  }

  /**
   * Rebuild the focus ring after a screen changed its DOM.
   * @returns {void}
   */
  refreshFocusRing() {
    if (this._container === null) {
      this._focusRing = [];
      return;
    }
    const nodes = this._container.querySelectorAll('[data-nav]');
    /** @type {HTMLElement[]} */
    const ring = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = /** @type {HTMLElement} */ (nodes[i]);
      if (node.hasAttribute('disabled')) continue;
      if (node.offsetParent === null && node.getClientRects().length === 0) continue;
      ring.push(node);
    }
    this._focusRing = ring;
    if (this._focusIndex >= ring.length) this._focusIndex = Math.max(0, ring.length - 1);
  }

  /* ---------------------------------------------------------- game bridge -- */

  /**
   * Start a freshly configured world through the game.
   * @param {Object} payload `{name, seed, gameMode, generator, generatorOptions}`.
   * @returns {Promise<*>} Resolves once the game accepted the world.
   */
  startWorld(payload) {
    const game = this.game;
    if (game && typeof game.startWorld === 'function') {
      return Promise.resolve(game.startWorld(payload));
    }
    if (game && typeof game.emit === 'function') game.emit('startWorld', payload);
    return Promise.resolve(null);
  }

  /**
   * Load a stored world through the game.
   * @param {string} id World id.
   * @returns {Promise<*>} Resolves once the game accepted the world.
   */
  loadWorld(id) {
    const game = this.game;
    if (game && typeof game.loadWorld === 'function') {
      return Promise.resolve(game.loadWorld(id));
    }
    if (game && typeof game.emit === 'function') game.emit('loadWorld', id);
    return Promise.resolve(null);
  }

  /**
   * Leave the pause screen and hand control back to the game.
   * @returns {void}
   */
  resumeGame() {
    this.hide();
    const game = this.game;
    if (game && typeof game.resume === 'function') {
      try { game.resume(); } catch (err) { this._reportOnce('resume', err); }
    } else if (game && typeof game.setState === 'function') {
      game.setState('playing');
    }
  }

  /**
   * Respawn the player after death.
   * @returns {void}
   */
  respawn() {
    this.hide();
    const game = this.game;
    if (game && typeof game.respawn === 'function') {
      try { game.respawn(); return; } catch (err) { this._reportOnce('respawn', err); }
    }
    if (game && typeof game.emit === 'function') game.emit('respawn');
  }

  /**
   * Save the world and return to the main menu.
   * @returns {Promise<void>} Resolves once the main menu is up.
   */
  saveAndQuit() {
    const game = this.game;
    const world = game && game.world;
    const saving = (world && typeof world.save === 'function')
      ? Promise.resolve(world.save()).catch((err) => {
        console.warn('[VOXELIA] screens: world save failed', err);
      })
      : Promise.resolve();

    return saving.then(() => {
      const save = game && game.save;
      if (save && typeof save.flush === 'function') {
        return Promise.resolve(save.flush()).catch(() => undefined);
      }
      return undefined;
    }).then(() => {
      if (game && typeof game.quitToMenu === 'function') {
        game.quitToMenu();
      } else if (game && typeof game.setState === 'function') {
        game.setState('menu');
      }
      if (game && typeof game.emit === 'function') game.emit('quitToMenu');
      this.hide();
      this.show('mainmenu');
    });
  }

  /**
   * Surface a failure to the player without ever throwing.
   * @param {string} message German message.
   * @param {*} [error] The underlying error, logged to the console.
   * @returns {void}
   */
  reportError(message, error) {
    if (error !== undefined) console.error(`[VOXELIA] screens: ${message}`, error);
    const game = this.game;
    if (game && typeof game.emit === 'function') game.emit('error', message, error);
    if (this._currentName === 'loading') {
      const screen = this.screens.get('loading');
      if (screen instanceof LoadingScreen) screen.setProgress(0, message);
      window.setTimeout(() => {
        if (this._currentName === 'loading') this.replace('mainmenu');
      }, 2200);
    }
  }

  /**
   * Detach everything.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._unmount();
    window.removeEventListener('keydown', this._onKeyDown, true);
    this.layer.removeEventListener('focusin', this._onFocusIn);
    this.layer.removeEventListener('focusout', this._onFocusOut);
    const game = this.game;
    if (game && typeof game.off === 'function') game.off('progress', this._onGameProgress);
    if (this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this.screens.clear();
    this._history.length = 0;
    this._focusRing = [];
  }

  /* -------------------------------------------------------------- internal -- */

  /**
   * Mount a screen into a fresh container.
   * @param {string} name Screen key.
   * @param {Screen} screen Screen instance.
   * @param {Object|undefined} data Mount payload.
   * @returns {void}
   * @private
   */
  _mount(name, screen, data) {
    this._unmount();

    const container = el('div', `vox-screen vox-screen--${name}`);
    container.style.pointerEvents = 'auto';
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-modal', 'true');
    this.layer.appendChild(container);
    this.layer.style.pointerEvents = 'auto';

    this._container = container;
    this._current = screen;
    this._currentName = name;
    this._currentData = data;

    if (screen.releasesPointerLock) {
      const input = this.game && this.game.input;
      if (input && typeof input.exitLock === 'function') {
        try { input.exitLock(); } catch { /* ignore */ }
      }
    }

    try {
      screen.mount(container, data);
    } catch (err) {
      this._reportOnce(`mount:${name}`, err);
    }

    this.refreshFocusRing();
    this._focusIndex = 0;
    const first = this._focusRing[0];
    if (first && typeof first.focus === 'function') {
      try { first.focus({ preventScroll: true }); } catch { first.focus(); }
    }
  }

  /**
   * Unmount the current screen and drop its container.
   * @returns {void}
   * @private
   */
  _unmount() {
    if (this._current !== null) {
      try {
        this._current.unmount();
      } catch (err) {
        this._reportOnce('unmount', err);
      }
    }
    if (this._container && this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
    this._container = null;
    this._current = null;
    this._currentName = null;
    this._currentData = undefined;
    this._focusRing = [];
    this._focusIndex = 0;
    this.layer.style.pointerEvents = 'none';
    const input = this.game && this.game.input;
    if (input) input.typing = false;
  }

  /**
   * Raise `input.typing` while a text field owns the focus.
   * @param {FocusEvent} e The focus event.
   * @param {boolean} entering True on `focusin`.
   * @returns {void}
   * @private
   */
  _handleFocus(e, entering) {
    const input = this.game && this.game.input;
    if (!input) return;
    const target = /** @type {HTMLElement|null} */ (e.target);
    const isText = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      && /** @type {HTMLInputElement} */ (target).type !== 'range';
    if (entering) {
      if (isText) input.typing = true;
      const index = target ? this._focusRing.indexOf(target) : -1;
      if (index >= 0) this._focusIndex = index;
    } else if (isText) {
      input.typing = false;
    }
  }

  /**
   * Central keyboard handling: Escape goes back, the arrow keys and Tab walk
   * the focus ring.
   * @param {KeyboardEvent} e The event.
   * @returns {void}
   * @private
   */
  _handleKey(e) {
    if (this._current === null) return;
    const code = e.code;

    if (code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      let goBack = true;
      try {
        goBack = this._current.onEscape() !== false;
      } catch (err) {
        this._reportOnce('escape', err);
      }
      if (goBack) this.back();
      return;
    }

    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const inField = !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
      || active.tagName === 'SELECT');
    const isRange = !!active && active.tagName === 'INPUT'
      && /** @type {HTMLInputElement} */ (active).type === 'range';

    if (code === 'Tab') {
      e.preventDefault();
      this._moveFocus(e.shiftKey ? -1 : 1);
      return;
    }
    if (code === 'ArrowDown' || code === 'ArrowUp') {
      if (inField && !isRange && active.tagName === 'SELECT') return;
      e.preventDefault();
      this._moveFocus(code === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((code === 'ArrowLeft' || code === 'ArrowRight') && !inField) {
      e.preventDefault();
      this._moveFocus(code === 'ArrowRight' ? 1 : -1);
    }
  }

  /**
   * Move the focus by `delta` positions inside the ring.
   * @param {number} delta `+1` or `-1`.
   * @returns {void}
   * @private
   */
  _moveFocus(delta) {
    this.refreshFocusRing();
    const ring = this._focusRing;
    if (ring.length === 0) return;
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    let index = active ? ring.indexOf(active) : -1;
    if (index < 0) index = this._focusIndex;
    index = (index + delta + ring.length) % ring.length;
    this._focusIndex = index;
    const next = ring[index];
    if (!next) return;
    try { next.focus({ preventScroll: false }); } catch { next.focus(); }
  }

  /**
   * Log a subsystem failure exactly once per tag (hard rule 8).
   * @param {string} tag Failure tag.
   * @param {*} err The error.
   * @returns {void}
   * @private
   */
  _reportOnce(tag, err) {
    if (!this._warned) this._warned = new Set();
    if (this._warned.has(tag)) return;
    this._warned.add(tag);
    console.error(`[VOXELIA] screens: "${tag}" failed; the UI keeps running.`, err);
  }
}

export default ScreenManager;
