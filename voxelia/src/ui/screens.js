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
 * **Styling** is the shared design system in `ui/style.css` — the `vx-`
 * primitives of section 04 (`vx-panel`, `vx-btn`, `vx-field`, `vx-input`,
 * `vx-select`, `vx-slider`, `vx-toggle`, `vx-tabs`) and the screen components
 * of section 08 (`vx-screen`, `vx-menu`, `vx-world`, `vx-settings`, `vx-key`,
 * `vx-pause`, `vx-death`, `vx-loading`). This module deliberately ships **no
 * stylesheet of its own**: a second, parallel set of class names is exactly how
 * these screens ended up unstyled once already. A screen becomes visible when
 * the manager raises `is-open` on its container, which is also what opts the
 * overlay back into pointer events.
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
 * German labels for the game modes a stored world can carry.
 * @type {Readonly<Object<string, string>>}
 */
export const GAME_MODE_LABELS = Object.freeze({
  survival: 'Überleben',
  creative: 'Kreativ',
  spectator: 'Zuschauer',
});

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

/** SVG namespace for the few inline icons this module draws. @type {string} */
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* ------------------------------------------------------------------------- */

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
 * Add or remove a state class.
 *
 * Written with a computed method name on purpose: it keeps the DOM mutation in
 * one place and stays readable at the call sites, which pass a plain boolean.
 * @param {Element|null} node Target element.
 * @param {string} name State class, e.g. `'is-active'`.
 * @param {boolean} on Whether the state applies.
 * @returns {void}
 */
function setState(node, name, on) {
  if (node) node.classList[on ? 'add' : 'remove'](name);
}

/**
 * Create a navigable design-system button.
 * @param {string} label German button caption.
 * @param {string} cls Extra classes appended to `vx-btn`.
 * @param {function(MouseEvent):void} onClick Click handler.
 * @returns {HTMLButtonElement} The button.
 */
function makeButton(label, cls, onClick) {
  const classes = cls ? 'vx-btn ' + cls : 'vx-btn';
  const b = /** @type {HTMLButtonElement} */ (el('button', classes, label));
  b.type = 'button';
  b.setAttribute('data-nav', '1');
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Build a stacked form field: caption above, control below, hint underneath.
 * @param {string} caption German field caption.
 * @param {string} [forId] `id` of the control the caption labels.
 * @returns {{field:HTMLElement, control:HTMLElement, hint:HTMLElement}} The
 *   field wrapper, the row the control goes into and the hint paragraph.
 */
function makeField(caption, forId) {
  const field = el('div', 'vx-field vx-field--stack');
  const label = el(forId ? 'label' : 'span', 'vx-field__label', caption);
  if (forId) /** @type {HTMLLabelElement} */ (label).htmlFor = forId;
  const control = el('div', 'vx-field__control');
  const hint = el('p', 'vx-field__desc', '');
  field.appendChild(label);
  field.appendChild(control);
  field.appendChild(hint);
  return { field, control, hint };
}

/**
 * A segmented control built from the design system's tab component.
 * @param {ReadonlyArray<{value:string, label:string}>} options Choices.
 * @param {function(string):void} onPick Called with the picked value.
 * @returns {HTMLElement} The `.vx-tabs` group; sync it with {@link syncSegment}.
 */
function makeSegment(options, onPick) {
  const group = el('div', 'vx-tabs vx-tabs--wrap');
  group.setAttribute('role', 'radiogroup');
  for (const opt of options) {
    const b = /** @type {HTMLButtonElement} */ (el('button', 'vx-tab', opt.label));
    b.type = 'button';
    b.setAttribute('data-nav', '1');
    b.setAttribute('role', 'radio');
    b.dataset.value = opt.value;
    b.addEventListener('click', () => onPick(opt.value));
    group.appendChild(b);
  }
  return group;
}

/**
 * Mark the active button of a {@link makeSegment} group.
 * @param {HTMLElement} group The `.vx-tabs` container.
 * @param {string} value Active value.
 * @returns {void}
 */
function syncSegment(group, value) {
  const kids = group.children;
  for (let i = 0; i < kids.length; i++) {
    const child = /** @type {HTMLElement} */ (kids[i]);
    const active = child.dataset.value === value;
    setState(child, 'is-active', active);
    child.setAttribute('aria-checked', active ? 'true' : 'false');
  }
}

/**
 * Inline dice icon for the "roll a seed" button. Drawn as SVG so it needs
 * neither an image file nor an emoji font.
 * @returns {SVGElement} A 24×24 icon carrying the `vx-btn__icon` class.
 */
function diceIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'vx-btn__icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const body = document.createElementNS(SVG_NS, 'rect');
  body.setAttribute('x', '3');
  body.setAttribute('y', '3');
  body.setAttribute('width', '18');
  body.setAttribute('height', '18');
  body.setAttribute('rx', '4.5');
  body.setAttribute('fill', 'none');
  body.setAttribute('stroke', 'currentColor');
  body.setAttribute('stroke-width', '1.8');
  svg.appendChild(body);
  for (const [cx, cy] of [[8, 8], [16, 8], [12, 12], [8, 16], [16, 16]]) {
    const pip = document.createElementNS(SVG_NS, 'circle');
    pip.setAttribute('cx', String(cx));
    pip.setAttribute('cy', String(cy));
    pip.setAttribute('r', '1.9');
    pip.setAttribute('fill', 'currentColor');
    svg.appendChild(pip);
  }
  return svg;
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
    /**
     * Backdrop variant appended as `vx-screen--<variant>`, or `null` for the
     * default translucent backdrop. Only variants the stylesheet defines are
     * used — an unknown modifier would be a class nothing styles.
     * @type {string|null}
     */
    this.variant = null;
    /**
     * Column width of `.vx-screen__inner`: `'narrow'`, `'wide'` or `null` for
     * the default 880 px card.
     * @type {string|null}
     */
    this.width = null;
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

  /**
   * Build the standard card skeleton: a glass panel with a head (title and
   * subtitle), a body and a foot, inside the animated screen column.
   * @param {HTMLElement} container The screen container.
   * @param {string} title German screen title.
   * @param {string} subtitle German one-line explanation.
   * @returns {{panel:HTMLElement, head:HTMLElement, body:HTMLElement, foot:HTMLElement}}
   *   The freshly appended parts.
   * @protected
   */
  _buildCard(container, title, subtitle) {
    const inner = el('div', 'vx-screen__inner');
    const panel = el('div', 'vx-panel');

    const head = el('div', 'vx-panel__head');
    const heading = el('div', 'vx-col');
    heading.appendChild(el('h2', 'vx-title', title));
    if (subtitle) heading.appendChild(el('p', 'vx-subtitle', subtitle));
    head.appendChild(heading);
    panel.appendChild(head);

    const body = el('div', 'vx-panel__body');
    panel.appendChild(body);

    const foot = el('div', 'vx-panel__foot');
    panel.appendChild(foot);

    inner.appendChild(panel);
    container.appendChild(inner);
    return { panel, head, body, foot };
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
   * @param {ScreenManager} manager Owning manager.
   */
  constructor(manager) {
    super(manager);
    this.variant = 'menu';
  }

  /**
   * @param {HTMLElement} container Container element.
   * @param {Object} [data] Unused.
   * @returns {void}
   */
  mount(container, data) {
    super.mount(container, data);
    const inner = el('div', 'vx-screen__inner');
    const menu = el('div', 'vx-menu');

    menu.appendChild(el('h1', 'vx-menu__logo', 'VOXELIA'));
    menu.appendChild(el('p', 'vx-menu__tag', 'Unendliche Welten'));

    const nav = el('div', 'vx-menu__nav');
    nav.appendChild(makeButton('Welt erstellen', 'vx-btn--primary vx-btn--lg vx-btn--block', () => {
      this._sound('ui_select');
      this.manager.show('worldcreate');
    }));
    nav.appendChild(makeButton('Welt laden', 'vx-btn--block', () => {
      this._sound('click');
      this.manager.show('worldlist');
    }));

    const row = el('div', 'vx-menu__row');
    row.appendChild(makeButton('Einstellungen', 'vx-btn--ghost', () => {
      this._sound('click');
      this.manager.show('settings');
    }));
    row.appendChild(makeButton('Steuerung', 'vx-btn--ghost', () => {
      this._sound('click');
      this.manager.show('controls');
    }));
    nav.appendChild(row);

    menu.appendChild(nav);
    inner.appendChild(menu);
    container.appendChild(inner);

    container.appendChild(el('p', 'vx-menu__version',
      'WebGL2 · prozedurale Texturen · farbiges Voxellicht'));
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
    this.width = 'narrow';
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
    const { body, foot } = this._buildCard(container, 'Neue Welt erstellen',
      'Gleicher Startwert und gleicher Welttyp erzeugen immer dieselbe Welt.');

    const form = el('div', 'vx-col vx-scroll');
    body.appendChild(form);

    /* -- name ------------------------------------------------------------- */
    const name = makeField('Weltname', 'voxelia-world-name');
    const nameInput = /** @type {HTMLInputElement} */ (el('input', 'vx-input'));
    nameInput.id = 'voxelia-world-name';
    nameInput.type = 'text';
    nameInput.maxLength = 64;
    nameInput.placeholder = 'Neue Welt';
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.value = (data && typeof data.name === 'string') ? data.name : this._defaultName();
    nameInput.setAttribute('data-nav', '1');
    name.control.appendChild(nameInput);
    name.hint.textContent = 'Höchstens 64 Zeichen. Der Name erscheint in der Weltliste.';
    this._nameInput = nameInput;
    form.appendChild(name.field);

    /* -- seed ------------------------------------------------------------- */
    const seed = makeField('Startwert (Seed)', 'voxelia-world-seed');
    const seedInput = /** @type {HTMLInputElement} */ (el('input', 'vx-input'));
    seedInput.id = 'voxelia-world-seed';
    seedInput.type = 'text';
    seedInput.maxLength = 48;
    seedInput.placeholder = 'leer lassen für Zufall';
    seedInput.autocomplete = 'off';
    seedInput.spellcheck = false;
    seedInput.value = (data && data.seed !== undefined && data.seed !== null) ? String(data.seed) : '';
    seedInput.setAttribute('data-nav', '1');
    seedInput.addEventListener('input', () => this._refreshSeedHint());
    seed.control.appendChild(seedInput);
    this._seedInput = seedInput;

    const dice = makeButton('', 'vx-btn--icon', () => {
      seedInput.value = String((Math.random() * 4294967296) | 0);
      this._refreshSeedHint();
      this._sound('click');
    });
    dice.appendChild(diceIcon());
    dice.title = 'Zufälligen Startwert würfeln';
    dice.setAttribute('aria-label', 'Zufälligen Startwert würfeln');
    seed.control.appendChild(dice);
    this._seedHint = seed.hint;
    form.appendChild(seed.field);
    this._refreshSeedHint();

    /* -- game mode -------------------------------------------------------- */
    if (data && typeof data.gameMode === 'string') this._mode = data.gameMode;
    const mode = makeField('Spielmodus');
    const modeSegment = makeSegment(GAME_MODE_OPTIONS, (value) => {
      this._mode = value;
      syncSegment(modeSegment, value);
      mode.hint.textContent = this._describe(GAME_MODE_OPTIONS, value);
      this._sound('click');
    });
    mode.control.appendChild(modeSegment);
    this._modeHint = mode.hint;
    form.appendChild(mode.field);
    syncSegment(modeSegment, this._mode);
    mode.hint.textContent = this._describe(GAME_MODE_OPTIONS, this._mode);

    /* -- world type ------------------------------------------------------- */
    if (data && typeof data.worldType === 'string') this._type = data.worldType;
    const type = makeField('Welttyp');
    const typeSegment = makeSegment(WORLD_TYPE_OPTIONS, (value) => {
      this._type = value;
      syncSegment(typeSegment, value);
      type.hint.textContent = this._describe(WORLD_TYPE_OPTIONS, value);
      this._sound('click');
    });
    type.control.appendChild(typeSegment);
    this._typeHint = type.hint;
    form.appendChild(type.field);
    syncSegment(typeSegment, this._type);
    type.hint.textContent = this._describe(WORLD_TYPE_OPTIONS, this._type);

    /* -- actions ---------------------------------------------------------- */
    foot.appendChild(makeButton('Zurück', 'vx-btn--ghost', () => {
      this._sound('ui_back');
      this.manager.back();
    }));
    foot.appendChild(el('div', 'vx-spacer'));
    foot.appendChild(makeButton('Erstellen', 'vx-btn--primary', () => this._submit()));
  }

  /**
   * @returns {void}
   */
  unmount() {
    this._nameInput = null;
    this._seedInput = null;
    this._seedHint = null;
    this._modeHint = null;
    this._typeHint = null;
    super.unmount();
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
    /** @type {HTMLElement|null} List the cards live in. @private */
    this._list = null;
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
    const { body, foot } = this._buildCard(container, 'Welt laden',
      'Gespeicherte Welten aus dem lokalen Speicher.');

    this._list = el('div', 'vx-worldlist vx-scroll');
    this._list.appendChild(el('div', 'vx-worldlist__empty', 'Welten werden geladen…'));
    body.appendChild(this._list);

    foot.appendChild(makeButton('Zurück', 'vx-btn--ghost', () => {
      this._sound('ui_back');
      this.manager.back();
    }));
    foot.appendChild(el('div', 'vx-spacer'));
    foot.appendChild(makeButton('Neue Welt', 'vx-btn--primary', () => {
      this._sound('click');
      this.manager.show('worldcreate');
    }));

    this._reload();
  }

  /**
   * @returns {void}
   */
  unmount() {
    this._list = null;
    super.unmount();
  }

  /**
   * Fetch the world list and rebuild the cards.
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
   * Build the card list.
   * @param {Array<Object>} worlds World metadata records.
   * @returns {void}
   * @private
   */
  _render(worlds) {
    const list = this._list;
    if (!list) return;
    list.textContent = '';
    this.manager.knownWorldNames.clear();

    const usable = worlds.filter((meta) => meta && typeof meta.id === 'string');
    if (usable.length === 0) {
      list.appendChild(el('div', 'vx-worldlist__empty',
        'Noch keine Welt gespeichert. Erstelle eine neue Welt, um loszulegen.'));
      this.manager.refreshFocusRing();
      return;
    }

    for (const meta of usable) {
      this.manager.knownWorldNames.add(String(meta.name || ''));
      list.appendChild(this._card(meta));
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
    const name = String(meta.name || 'Unbenannt');
    const card = el('div', 'vx-world');
    card.dataset.world = String(meta.id);

    const thumb = el('div', 'vx-world__thumb', name.trim().slice(0, 1).toUpperCase() || '?');
    thumb.setAttribute('aria-hidden', 'true');
    card.appendChild(thumb);

    const info = el('div', 'vx-world__info');
    info.appendChild(el('div', 'vx-world__name vx-truncate', name));

    const modeLabel = GAME_MODE_LABELS[meta.gameMode] || GAME_MODE_LABELS.survival;
    const metaRow = el('div', 'vx-world__meta');
    metaRow.appendChild(el('span', 'vx-badge vx-badge--muted', modeLabel));
    metaRow.appendChild(el('span', 'vx-mono', `Seed ${meta.seed | 0}`));
    metaRow.appendChild(el('span', '', `Zuletzt: ${formatTimestamp(meta.lastPlayed)}`));
    metaRow.appendChild(el('span', '', `Spielzeit: ${formatPlayTime(meta.playTime)}`));
    info.appendChild(metaRow);
    card.appendChild(info);

    const actions = el('div', 'vx-world__actions');
    actions.appendChild(makeButton('Spielen', 'vx-btn--sm vx-btn--primary', () => this._play(meta)));
    actions.appendChild(makeButton('Löschen', 'vx-btn--sm vx-btn--danger', () => {
      this._sound('click');
      this._confirmDelete(card, actions, meta);
    }));
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
      if (card.dataset.confirm === '1') return;
      const target = /** @type {HTMLElement|null} */ (e.target);
      if (target && target.closest('button')) return;
      this._play(meta);
    });
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
    card.dataset.confirm = '1';
    setState(card, 'is-selected', true);
    const confirm = el('div', 'vx-world__actions');
    confirm.appendChild(el('span', 'vx-hint', 'Wirklich löschen?'));

    const yes = makeButton('Ja, löschen', 'vx-btn--sm vx-btn--danger', () => {
      confirm.textContent = '';
      confirm.appendChild(el('span', 'vx-hint', 'Wird gelöscht…'));
      this._delete(meta);
    });
    const no = makeButton('Abbrechen', 'vx-btn--sm vx-btn--ghost', () => {
      card.dataset.confirm = '0';
      setState(card, 'is-selected', false);
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
    this.width = 'wide';
    /** @type {string} Active category tab. @private */
    this._tab = CATEGORIES[0];
    /** @type {HTMLElement|null} @private */
    this._list = null;
    /** @type {HTMLElement|null} @private */
    this._cats = null;
    /** @type {HTMLElement|null} @private */
    this._presets = null;
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

    const { panel, body, foot } = this._buildCard(container, 'Einstellungen',
      'Änderungen greifen sofort und werden automatisch gespeichert.');

    /* -- category rail + list --------------------------------------------- */
    const split = el('div', 'vx-settings');
    this._cats = el('div', 'vx-settings__cats');
    this._cats.setAttribute('role', 'tablist');
    for (const category of CATEGORIES) {
      const b = /** @type {HTMLButtonElement} */ (el('button', 'vx-settings__cat', category));
      b.type = 'button';
      b.setAttribute('data-nav', '1');
      b.setAttribute('role', 'tab');
      b.dataset.tab = category;
      const count = this._schema().filter((e) => e && e.category === category).length;
      b.appendChild(el('span', 'vx-badge vx-badge--muted', String(count)));
      b.addEventListener('click', () => {
        if (this._tab === category) return;
        this._tab = category;
        this._syncTabs();
        this._buildList();
        this._sound('click');
        this.manager.refreshFocusRing();
      });
      this._cats.appendChild(b);
    }
    split.appendChild(this._cats);

    this._list = el('div', 'vx-settings__list vx-scroll');
    this._list.setAttribute('role', 'tabpanel');
    split.appendChild(this._list);
    body.appendChild(split);

    this._syncTabs();
    this._buildList();

    /* -- quality presets --------------------------------------------------- */
    const presetBar = el('div', 'vx-settings__presets');
    presetBar.appendChild(el('span', 'vx-caps', 'Voreinstellung'));
    this._presets = el('div', 'vx-presets');
    for (const name of Object.keys(QUALITY_PRESETS)) {
      const b = makeButton(PRESET_LABELS[name] || name, 'vx-btn--sm', () => {
        if (settings && typeof settings.applyPreset === 'function') settings.applyPreset(name);
        this._syncAll();
        this._syncPresetHint();
        this._sound('ui_select');
      });
      b.dataset.preset = name;
      b.title = PRESET_HINTS[name] || '';
      this._presets.appendChild(b);
    }
    presetBar.appendChild(this._presets);
    this._presetHint = el('p', 'vx-hint', '');
    presetBar.appendChild(this._presetHint);
    panel.insertBefore(presetBar, foot);
    this._syncPresetHint();

    /* -- footer ------------------------------------------------------------ */
    foot.appendChild(makeButton('Zurück', 'vx-btn--ghost', () => {
      this._sound('ui_back');
      this.manager.back();
    }));
    foot.appendChild(el('div', 'vx-spacer'));
    foot.appendChild(makeButton('Alles zurücksetzen', 'vx-btn--danger vx-btn--sm', () => {
      if (settings && typeof settings.reset === 'function') settings.reset();
      this._syncAll();
      this._syncPresetHint();
      this._sound('ui_back');
    }));

    /* -- external changes -------------------------------------------------- */
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
    this._cats = null;
    this._presets = null;
    this._presetHint = null;
    super.unmount();
  }

  /**
   * The settings schema as a plain array, whatever the store hands back.
   *
   * `Settings#getSchema()` returns the frozen `SETTINGS_SCHEMA` array; a stub
   * game in a test may return nothing at all. Normalising here is what keeps
   * the screen from silently rendering an empty card.
   * @returns {Array<Object>} Schema entries, possibly empty.
   * @private
   */
  _schema() {
    const settings = this._settings();
    if (!settings || typeof settings.getSchema !== 'function') return [];
    let raw = null;
    try {
      raw = settings.getSchema();
    } catch (err) {
      console.warn('[VOXELIA] screens: getSchema failed', err);
      return [];
    }
    if (Array.isArray(raw)) return raw.slice();
    if (raw && typeof raw === 'object') {
      if (typeof raw[Symbol.iterator] === 'function') return Array.from(raw);
      return Object.keys(raw).map((key) => raw[key]).filter((e) => e && typeof e === 'object');
    }
    return [];
  }

  /**
   * Highlight the active category button.
   * @returns {void}
   * @private
   */
  _syncTabs() {
    if (!this._cats) return;
    const kids = this._cats.children;
    for (let i = 0; i < kids.length; i++) {
      const child = /** @type {HTMLElement} */ (kids[i]);
      const active = child.dataset.tab === this._tab;
      setState(child, 'is-active', active);
      child.setAttribute('aria-selected', active ? 'true' : 'false');
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
    const schema = this._schema();
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
      list.appendChild(el('p', 'vx-hint', schema.length === 0
        ? 'Die Einstellungen sind noch nicht verfügbar.'
        : 'In dieser Kategorie gibt es nichts einzustellen.'));
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
    const item = el('div', 'vx-field');
    item.dataset.key = entry.key;

    const label = el('div', 'vx-field__label', entry.label || entry.key);
    if (entry.restart) label.appendChild(el('span', 'vx-badge vx-badge--warn', 'Neustart'));
    item.appendChild(label);

    const control = el('div', 'vx-field__control');
    item.appendChild(control);
    item.appendChild(el('p', 'vx-field__desc', entry.description || ''));

    const read = () => (settings && typeof settings.get === 'function' ? settings.get(entry.key) : entry.default);
    const write = (value) => {
      if (settings && typeof settings.set === 'function') settings.set(entry.key, value);
    };
    const format = (value) => ((settings && typeof settings.formatValue === 'function')
      ? settings.formatValue(entry.key)
      : String(value));

    /** @type {function():void} */
    let sync = () => {};

    if (entry.type === 'bool') {
      const toggle = /** @type {HTMLButtonElement} */ (el('button', 'vx-toggle'));
      toggle.type = 'button';
      toggle.setAttribute('data-nav', '1');
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-label', entry.label || entry.key);
      const value = el('span', 'vx-field__value', '');
      toggle.addEventListener('click', () => {
        write(!read());
        sync();
        this._syncPresetHint();
        this._sound('ui_toggle');
      });
      control.appendChild(value);
      control.appendChild(toggle);
      sync = () => {
        const on = !!read();
        setState(toggle, 'is-on', on);
        toggle.setAttribute('aria-checked', on ? 'true' : 'false');
        value.textContent = on ? 'An' : 'Aus';
        this._markDefault(item, entry, read());
      };
    } else if (entry.type === 'enum') {
      const select = /** @type {HTMLSelectElement} */ (el('select', 'vx-select'));
      select.setAttribute('data-nav', '1');
      select.setAttribute('aria-label', entry.label || entry.key);
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
      control.appendChild(select);
      sync = () => {
        select.value = String(read());
        this._markDefault(item, entry, read());
      };
    } else if (entry.type === 'int' || entry.type === 'float') {
      const min = Number.isFinite(entry.min) ? entry.min : 0;
      const max = Number.isFinite(entry.max) ? entry.max : 1;
      const slider = /** @type {HTMLInputElement} */ (el('input', 'vx-slider'));
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(Number.isFinite(entry.step) ? entry.step : (entry.type === 'int' ? 1 : 0.01));
      slider.setAttribute('data-nav', '1');
      slider.setAttribute('aria-label', entry.label || entry.key);
      const value = el('span', 'vx-field__value', '');
      slider.addEventListener('input', () => {
        write(entry.type === 'int' ? Math.round(Number(slider.value)) : Number(slider.value));
        sync();
      });
      slider.addEventListener('change', () => this._syncPresetHint());
      control.appendChild(slider);
      control.appendChild(value);
      sync = () => {
        const current = Number(read());
        if (Number.isFinite(current)) slider.value = String(current);
        // The track gradient is painted from `--fill`; without it the filled
        // part of the slider would never move in WebKit/Blink.
        const span = max - min;
        const fill = span > 0 ? clamp((Number(slider.value) - min) / span, 0, 1) : 0;
        slider.style.setProperty('--fill', `${(fill * 100).toFixed(2)}%`);
        value.textContent = format(read());
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
    const fallback = DEFAULTS[entry.key];
    setState(item, 'is-changed', fallback !== undefined && !Object.is(fallback, value));
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
    const active = (settings && typeof settings.detectPreset === 'function')
      ? settings.detectPreset() : null;
    if (this._presetHint) {
      this._presetHint.textContent = active
        ? (PRESET_HINTS[active] || `Voreinstellung: ${PRESET_LABELS[active] || active}`)
        : 'Eigene Konfiguration — keine Voreinstellung aktiv.';
    }
    if (!this._presets) return;
    const buttons = this._presets.children;
    for (let i = 0; i < buttons.length; i++) {
      const b = /** @type {HTMLElement} */ (buttons[i]);
      setState(b, 'is-active', b.dataset.preset === active);
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
    const { body, foot } = this._buildCard(container, 'Steuerung',
      'Eine Zeile anklicken und die neue Taste drücken. Escape bricht ab, Entf löscht die Belegung.');

    const stack = el('div', 'vx-col');
    const list = el('div', 'vx-keylist vx-scroll');
    for (const action of ACTIONS) {
      list.appendChild(this._row(action));
    }
    stack.appendChild(list);

    this._status = el('p', 'vx-hint', 'Doppelbelegungen werden rot markiert und beim Zuweisen aufgelöst.');
    this._status.setAttribute('role', 'status');
    stack.appendChild(this._status);
    body.appendChild(stack);

    foot.appendChild(makeButton('Zurück', 'vx-btn--ghost', () => {
      this._sound('ui_back');
      this.manager.back();
    }));
    foot.appendChild(el('div', 'vx-spacer'));
    foot.appendChild(makeButton('Standard wiederherstellen', 'vx-btn--danger vx-btn--sm', () => {
      const input = this.game && this.game.input;
      if (input && typeof input.resetBindings === 'function') input.resetBindings();
      saveBindings(input);
      this._syncAll();
      this._setStatus('Standardbelegung wiederhergestellt.');
      this._sound('ui_back');
    }));

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
   * @returns {HTMLElement} The row button.
   * @private
   */
  _row(action) {
    const row = /** @type {HTMLButtonElement} */ (el('button', 'vx-key'));
    row.type = 'button';
    row.setAttribute('data-nav', '1');
    row.dataset.action = action;
    row.appendChild(el('span', 'vx-key__label', ACTION_LABELS[action] || action));
    const key = el('span', 'vx-key__bind vx-kbd', '');
    row.appendChild(key);
    const pad = el('span', 'vx-key__pad', '');
    row.appendChild(pad);
    row.addEventListener('click', () => this._startCapture(action));
    this._rows.set(action, { row, key, pad });
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
      setState(entry.row, 'is-capturing', true);
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
      if (entry) setState(entry.row, 'is-capturing', false);
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
      setState(entry.row, 'is-unbound', !code);
      const padCode = (input && typeof input.getGamepadBinding === 'function')
        ? input.getGamepadBinding(action) : null;
      entry.pad.textContent = padCode ? codeLabel(padCode) : '';
      const conflicted = !!code && !!input && typeof input.findConflicts === 'function'
        && input.findConflicts(code, action).length > 0;
      setState(entry.row, 'is-conflict', conflicted);
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
   * @param {ScreenManager} manager Owning manager.
   */
  constructor(manager) {
    super(manager);
    this.variant = 'pause';
    this.width = 'narrow';
  }

  /**
   * @param {HTMLElement} container Container element.
   * @param {Object} [data] Unused.
   * @returns {void}
   */
  mount(container, data) {
    super.mount(container, data);
    const inner = el('div', 'vx-screen__inner');
    const pause = el('div', 'vx-pause');

    pause.appendChild(el('h2', 'vx-pause__title', 'Pause'));

    const world = this.game && this.game.world;
    const meta = (this.game && this.game.worldMeta) || null;
    const name = (meta && typeof meta.name === 'string' && meta.name)
      || (world && typeof world.name === 'string' ? world.name : '');
    pause.appendChild(el('p', 'vx-subtitle', name ? `Welt: ${name}` : 'Das Spiel ist angehalten.'));

    const stats = this._stats(meta, world);
    if (stats.length > 0) {
      const grid = el('div', 'vx-pause__stats');
      for (const [value, label] of stats) {
        const card = el('div', 'vx-stat');
        card.appendChild(el('div', 'vx-stat__value', value));
        card.appendChild(el('div', 'vx-stat__label', label));
        grid.appendChild(card);
      }
      pause.appendChild(grid);
    }

    const grid = el('div', 'vx-pause__grid');
    grid.appendChild(makeButton('Weiterspielen', 'vx-btn--primary vx-btn--block', () => {
      this._sound('ui_close');
      this.manager.resumeGame();
    }));
    grid.appendChild(makeButton('Einstellungen', 'vx-btn--ghost', () => {
      this._sound('click');
      this.manager.show('settings');
    }));
    grid.appendChild(makeButton('Steuerung', 'vx-btn--ghost', () => {
      this._sound('click');
      this.manager.show('controls');
    }));
    const quit = makeButton('Speichern und beenden', 'vx-btn--danger vx-btn--block', () => {
      quit.disabled = true;
      quit.textContent = 'Wird gespeichert…';
      this._sound('ui_back');
      this.manager.saveAndQuit().catch((err) => {
        this.manager.reportError('Die Welt konnte nicht gespeichert werden.', err);
      });
    });
    grid.appendChild(quit);
    pause.appendChild(grid);

    inner.appendChild(pause);
    container.appendChild(inner);
  }

  /**
   * Collect the little stat cards above the buttons. Only values the running
   * game genuinely carries are listed, so the row shrinks (or disappears)
   * instead of showing a placeholder.
   * @param {Object|null} meta `game.worldMeta`, when a world is loaded.
   * @param {*} world The `World` instance.
   * @returns {Array<[string, string]>} `[value, German label]` pairs.
   * @private
   */
  _stats(meta, world) {
    /** @type {Array<[string, string]>} */
    const out = [];
    const player = this.game && this.game.player;
    const mode = (player && typeof player.gameMode === 'string' && player.gameMode)
      || (meta && typeof meta.gameMode === 'string' ? meta.gameMode : '');
    if (mode) out.push([GAME_MODE_LABELS[mode] || mode, 'Modus']);

    const generator = meta && typeof meta.generator === 'string' ? meta.generator : '';
    if (generator) {
      const type = WORLD_TYPE_OPTIONS.find((o) => o.value === generator);
      out.push([type ? type.label : generator, 'Welttyp']);
    }

    const seed = (meta && Number.isFinite(meta.seed)) ? meta.seed
      : (world && Number.isFinite(world.seed) ? world.seed : null);
    if (seed !== null) out.push([String(seed | 0), 'Startwert']);
    return out;
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
   * @param {ScreenManager} manager Owning manager.
   */
  constructor(manager) {
    super(manager);
    this.variant = 'death';
    this.width = 'narrow';
  }

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

    const inner = el('div', 'vx-screen__inner');
    const death = el('div', 'vx-death');
    death.appendChild(el('h2', 'vx-death__title', 'Du bist gestorben'));

    const message = typeof payload.message === 'string' && payload.message.length > 0
      ? payload.message
      : 'ist gestorben';
    const cause = typeof payload.label === 'string' && payload.label.length > 0
      ? `${message} · ${payload.label}`
      : message;
    death.appendChild(el('p', 'vx-death__cause', `Du ${cause}.`));

    const score = Number.isFinite(payload.score) ? payload.score
      : (Number.isFinite(payload.xp) ? payload.xp
        : (player && Number.isFinite(player.xp) ? player.xp : 0));
    const level = Number.isFinite(payload.level) ? payload.level
      : (player && Number.isFinite(player.xpLevel) ? player.xpLevel : 0);
    death.appendChild(el('p', 'vx-death__score',
      `Punkte: ${Math.max(0, Math.round(score))} · Stufe: ${Math.max(0, Math.round(level))}`));

    const actions = el('div', 'vx-death__actions');
    actions.appendChild(makeButton('Wiederbeleben', 'vx-btn--primary vx-btn--lg', () => {
      this._sound('ui_select');
      this.manager.respawn();
    }));
    actions.appendChild(makeButton('Zum Hauptmenü', 'vx-btn--ghost vx-btn--lg', () => {
      this._sound('ui_back');
      this.manager.saveAndQuit().catch((err) => {
        this.manager.reportError('Die Welt konnte nicht gespeichert werden.', err);
      });
    }));
    death.appendChild(actions);

    inner.appendChild(death);
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
    this.variant = 'loading';
    this.width = 'narrow';
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
    const inner = el('div', 'vx-screen__inner');
    const loading = el('div', 'vx-loading');

    loading.appendChild(el('h2', 'vx-loading__title',
      typeof payload.title === 'string' ? payload.title : 'VOXELIA'));

    const bar = el('div', 'vx-loading__bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    this._fill = el('i');
    bar.appendChild(this._fill);
    loading.appendChild(bar);

    this._step = el('div', 'vx-loading__status',
      typeof payload.step === 'string' ? payload.step : 'Initialisiere…');
    loading.appendChild(this._step);

    this._tipIndex = (Math.random() * LOADING_TIPS.length) | 0;
    this._tip = el('div', 'vx-loading__tip', LOADING_TIPS[this._tipIndex]);
    loading.appendChild(this._tip);
    this._tipTimer = TIP_INTERVAL;

    inner.appendChild(loading);
    container.appendChild(inner);

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
    if (this._fill) {
      this._fill.style.width = `${(value * 100).toFixed(1)}%`;
      const bar = this._fill.parentNode;
      if (bar && bar.setAttribute) bar.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    }
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
    setState(tip, 'is-fading', true);
    window.setTimeout(() => {
      if (!this.mounted || this._tip !== tip) return;
      tip.textContent = LOADING_TIPS[this._tipIndex];
      setState(tip, 'is-fading', false);
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
    /** @type {*} The game. */
    this.game = game;
    /** @type {HTMLElement} UI root. */
    this.root = root;
    /** @type {HTMLElement} Layer every screen container is appended to. */
    this.layer = el('div', 'vx-screens');
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

    const classes = ['vx-screen'];
    if (screen.variant) classes.push(`vx-screen--${screen.variant}`);
    if (screen.width) classes.push(`vx-screen--${screen.width}`);
    const container = el('div', classes.join(' '));
    container.dataset.screen = name;
    container.style.pointerEvents = 'auto';
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-modal', 'true');
    this.layer.appendChild(container);

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

    // Resolve the closed state once, then open: the forced reflow gives the
    // opacity/transform transition a start value without waiting for a frame,
    // so the screen still animates even when rAF is throttled.
    void container.offsetWidth;
    setState(container, 'is-open', true);

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
