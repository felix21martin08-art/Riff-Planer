/**
 * @file core/input.js — VOXELIA input layer (spec 5.4): keyboard, mouse,
 * pointer lock, wheel, gamepad, touch and the rebindable action map.
 *
 * Design notes
 * ------------
 * * **One code namespace.** Keyboard codes come from `KeyboardEvent.code`
 *   (`'KeyW'`, `'Space'`, `'F3'`). Mouse buttons are `'Mouse0'`…`'Mouse4'` and
 *   gamepad buttons are `'Pad0'`…`'Pad19'`, so a single `Set` holds the whole
 *   "is it down" state and any action can be bound to any device.
 * * **Edge buffering.** Events arrive between frames. Everything that happens
 *   after `endFrame()` is parked in a pending buffer and promoted by the next
 *   `beginFrame()`, so a press is visible for exactly one full frame and can
 *   never be swallowed by unlucky timing.
 * * **No per-frame allocation.** Sets and scratch arrays are reused; the edge
 *   buffers are swapped, not recreated.
 * * **Sensitivity lives in the consumer.** `getLookDelta()` returns raw pixel
 *   deltas (gamepad and touch are converted to pixel-equivalents); the player
 *   controller multiplies by `settings.mouseSensitivity` and applies `invertY`.
 */

import { EventBus } from './util.js';

/* ------------------------------------------------------------------------- */
/* Action map                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Every action the engine knows, in UI display order.
 * @type {ReadonlyArray<string>}
 */
export const ACTIONS = Object.freeze([
  'forward', 'back', 'left', 'right',
  'jump', 'sneak', 'sprint',
  'attack', 'use', 'pick',
  'inventory', 'drop', 'chat',
  'hotbar1', 'hotbar2', 'hotbar3', 'hotbar4', 'hotbar5',
  'hotbar6', 'hotbar7', 'hotbar8', 'hotbar9',
  'perspective', 'debug', 'fullscreen', 'screenshot', 'pause',
]);

/**
 * Default keyboard/mouse binding per action (`action -> code`).
 * @type {Readonly<Object<string, string>>}
 */
export const DEFAULT_BINDINGS = Object.freeze({
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sneak: 'ShiftLeft',
  sprint: 'ControlLeft',
  attack: 'Mouse0',
  use: 'Mouse2',
  pick: 'Mouse1',
  inventory: 'KeyE',
  drop: 'KeyQ',
  chat: 'KeyT',
  hotbar1: 'Digit1',
  hotbar2: 'Digit2',
  hotbar3: 'Digit3',
  hotbar4: 'Digit4',
  hotbar5: 'Digit5',
  hotbar6: 'Digit6',
  hotbar7: 'Digit7',
  hotbar8: 'Digit8',
  hotbar9: 'Digit9',
  perspective: 'F5',
  debug: 'F3',
  fullscreen: 'F11',
  screenshot: 'F2',
  pause: 'Escape',
});

/**
 * Default gamepad binding per action (`action -> 'PadN'`, standard mapping).
 * Shoulder buttons 4/5 are not actions: they emit hotbar wheel steps.
 * @type {Readonly<Object<string, string>>}
 */
export const DEFAULT_GAMEPAD_BINDINGS = Object.freeze({
  jump: 'Pad0',        // A
  sneak: 'Pad1',       // B
  drop: 'Pad2',        // X
  inventory: 'Pad3',   // Y
  use: 'Pad6',         // left trigger
  attack: 'Pad7',      // right trigger
  debug: 'Pad8',       // back / view
  pause: 'Pad9',       // start / menu
  sprint: 'Pad10',     // left stick click
  pick: 'Pad11',       // right stick click
  forward: 'Pad12',    // d-pad up
  back: 'Pad13',       // d-pad down
  left: 'Pad14',       // d-pad left
  right: 'Pad15',      // d-pad right
});

/**
 * Actions whose keyboard/mouse binding is ignored while the pointer is not
 * locked, so clicking around a menu never breaks a block and holding `W` in a
 * text field never walks. Gamepad and touch sources bypass this gate because
 * neither of them uses pointer lock.
 * @type {ReadonlyArray<string>}
 */
export const LOCK_REQUIRED_ACTIONS = Object.freeze([
  'forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint',
  'attack', 'use', 'pick', 'drop',
  'hotbar1', 'hotbar2', 'hotbar3', 'hotbar4', 'hotbar5',
  'hotbar6', 'hotbar7', 'hotbar8', 'hotbar9',
]);

/**
 * German labels for the controls screen (`action -> label`).
 * @type {Readonly<Object<string, string>>}
 */
export const ACTION_LABELS = Object.freeze({
  forward: 'Vorwärts',
  back: 'Rückwärts',
  left: 'Links',
  right: 'Rechts',
  jump: 'Springen',
  sneak: 'Schleichen',
  sprint: 'Sprinten',
  attack: 'Abbauen / Angreifen',
  use: 'Benutzen / Platzieren',
  pick: 'Block aufnehmen',
  inventory: 'Inventar',
  drop: 'Item wegwerfen',
  chat: 'Chat',
  hotbar1: 'Schnellzugriff 1',
  hotbar2: 'Schnellzugriff 2',
  hotbar3: 'Schnellzugriff 3',
  hotbar4: 'Schnellzugriff 4',
  hotbar5: 'Schnellzugriff 5',
  hotbar6: 'Schnellzugriff 6',
  hotbar7: 'Schnellzugriff 7',
  hotbar8: 'Schnellzugriff 8',
  hotbar9: 'Schnellzugriff 9',
  perspective: 'Perspektive wechseln',
  debug: 'Debug-Anzeige',
  fullscreen: 'Vollbild',
  screenshot: 'Screenshot',
  pause: 'Pause / Menü',
});

/** Named keys with a German display label. @type {Readonly<Object<string, string>>} */
const CODE_LABELS = Object.freeze({
  Space: 'Leertaste',
  Escape: 'Esc',
  Enter: 'Eingabe',
  NumpadEnter: 'Num Eingabe',
  Tab: 'Tabulator',
  Backspace: 'Rücktaste',
  CapsLock: 'Feststell',
  ShiftLeft: 'Umschalt links',
  ShiftRight: 'Umschalt rechts',
  ControlLeft: 'Strg links',
  ControlRight: 'Strg rechts',
  AltLeft: 'Alt',
  AltRight: 'Alt Gr',
  MetaLeft: 'Meta links',
  MetaRight: 'Meta rechts',
  ContextMenu: 'Kontextmenü',
  ArrowUp: 'Pfeil hoch',
  ArrowDown: 'Pfeil runter',
  ArrowLeft: 'Pfeil links',
  ArrowRight: 'Pfeil rechts',
  Insert: 'Einfg',
  Delete: 'Entf',
  Home: 'Pos1',
  End: 'Ende',
  PageUp: 'Bild hoch',
  PageDown: 'Bild runter',
  Minus: 'ß / -',
  Equal: '´ / =',
  BracketLeft: 'Ü / [',
  BracketRight: '+ / ]',
  Backslash: '# / \\',
  Semicolon: 'Ö / ;',
  Quote: 'Ä / \'',
  Backquote: '^ / `',
  Comma: 'Komma',
  Period: 'Punkt',
  Slash: '- / /',
  IntlBackslash: '< >',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num ,',
  Mouse0: 'Linke Maustaste',
  Mouse1: 'Mittlere Maustaste',
  Mouse2: 'Rechte Maustaste',
  Mouse3: 'Maustaste 4',
  Mouse4: 'Maustaste 5',
});

/** Standard-mapping gamepad button labels. @type {ReadonlyArray<string>} */
const PAD_LABELS = Object.freeze([
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start',
  'L3', 'R3', 'Steuerkreuz hoch', 'Steuerkreuz runter', 'Steuerkreuz links',
  'Steuerkreuz rechts', 'Home', 'Extra 1', 'Extra 2', 'Extra 3',
]);

/**
 * Human readable German label for a binding code, for the controls UI.
 * @param {string|null|undefined} code Binding code (`'KeyW'`, `'Mouse0'`, `'Pad3'`).
 * @returns {string} Display label, `'Nicht belegt'` for an empty code.
 */
export function codeLabel(code) {
  if (!code) return 'Nicht belegt';
  const named = CODE_LABELS[code];
  if (named) return named;
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code.startsWith('Pad')) {
    const index = Number(code.slice(3));
    const label = Number.isInteger(index) && PAD_LABELS[index] ? PAD_LABELS[index] : `Taste ${code.slice(3)}`;
    return `Gamepad ${label}`;
  }
  return code;
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

/** Largest per-event mouse delta accepted, in pixels — filters driver spikes. */
const MAX_MOUSE_DELTA = 400;

/** Highest gamepad button index polled. */
const MAX_PAD_BUTTONS = 20;

/**
 * Whether an event target is a text entry the user is typing into.
 * @param {EventTarget|null} target Event target.
 * @returns {boolean} True when key events must be left alone.
 */
function isTextTarget(target) {
  const el = /** @type {HTMLElement|null} */ (target);
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (!tag) return false;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Radial deadzone plus response curve for an analog stick.
 * @param {number} x Raw axis X in -1..1.
 * @param {number} y Raw axis Y in -1..1.
 * @param {number} deadzone Radial deadzone in 0..1.
 * @param {number} exponent Response curve exponent (1 = linear, >1 = finer near center).
 * @param {number[]} out Reused 2-element output array.
 * @returns {number[]} `out`, filled with the shaped vector.
 */
function shapeStick(x, y, deadzone, exponent, out) {
  const mag = Math.hypot(x, y);
  if (mag <= deadzone || mag <= 1e-4) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const norm = Math.min(1, (mag - deadzone) / (1 - deadzone));
  const curved = exponent === 1 ? norm : Math.pow(norm, exponent);
  const scale = curved / mag;
  out[0] = x * scale;
  out[1] = y * scale;
  return out;
}

/* ------------------------------------------------------------------------- */
/* Input                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Unified input state for keyboard, mouse, pointer lock, wheel, gamepad and
 * touch, plus a rebindable action map.
 *
 * Events:
 * * `'lockchange'` — `(locked)` whenever pointer lock is gained or lost.
 * * `'lockerror'` — `()` when the browser refused a lock request.
 * * `'rebind'` — `(action, code, oldCode)` after {@link Input#bind}.
 * * `'bindings'` — `(bindings)` after {@link Input#resetBindings}/{@link Input#deserialize}.
 * * `'action'` — `(action)` once per frame for every action pressed this frame.
 * * `'wheel'` — `(steps, delta)` when the frame saw wheel movement.
 * * `'touchmode'` — `(enabled)` the first time a touch is seen.
 * * `'gamepad'` — `(connected, gamepad)` on connect/disconnect.
 * * `'enabled'` — `(flag)` after {@link Input#setEnabled}.
 *
 * @example
 * const input = new Input(canvas);
 * canvas.addEventListener('click', () => input.requestLock());
 * // in the frame loop:
 * input.beginFrame(dt);
 * const [mx, my] = input.getMoveAxis();
 * const [dx, dy] = input.consumeLookDelta();
 * if (input.wasActionPressed('inventory')) ui.toggleInventory();
 * input.endFrame();
 */
export class Input extends EventBus {
  /**
   * @param {HTMLElement|HTMLCanvasElement|null} [element] Element that receives
   *   pointer lock, mouse, wheel and touch events. Defaults to the document
   *   body when a DOM is available.
   * @param {Object} [options] Tuning. A `Settings` instance may be passed here
   *   directly; it is stored as `this.settings` and otherwise unused (all
   *   sensitivity handling lives in the consumer).
   * @param {boolean} [options.preventDefaults=true] Swallow browser shortcuts
   *   for bound keys while the pointer is locked.
   * @param {boolean} [options.requireLock=true] Ignore gameplay keys while the
   *   pointer is unlocked (see {@link LOCK_REQUIRED_ACTIONS}).
   * @param {boolean} [options.rawMouse=true] Ask for unaccelerated pointer input.
   * @param {number} [options.gamepadLookSpeed=900] Pixel-equivalents per second
   *   at full right-stick deflection.
   * @param {number} [options.gamepadDeadzone=0.15] Radial stick deadzone.
   * @param {number} [options.touchLookScale=1] Multiplier for touch look drags.
   * @param {number} [options.joystickRadius=64] Virtual stick radius in CSS pixels.
   */
  constructor(element = null, options = {}) {
    super();
    const opts = (options && typeof options.get === 'function' && typeof options.all === 'function')
      ? { settings: options }
      : (options || {});

    const doc = typeof document !== 'undefined' ? document : null;
    /** @type {HTMLElement|null} Element owning pointer lock and pointer events. */
    this.element = element || (doc ? doc.body : null);
    /** @type {Document|null} Document the listeners are installed on. */
    this.document = doc;
    /** @type {*} Optional settings instance (never read by this module). */
    this.settings = opts.settings || null;

    /* -- configuration ----------------------------------------------------- */
    /** @type {boolean} Swallow browser shortcuts for bound keys while locked. */
    this.preventDefaults = opts.preventDefaults !== false;
    /** @type {boolean} Ignore gameplay keys while the pointer is unlocked. */
    this.requireLock = opts.requireLock !== false;
    /** @type {boolean} Request unadjusted (unaccelerated) mouse movement. */
    this.rawMouse = opts.rawMouse !== false;
    /** @type {number} Pixel-equivalents per second at full right-stick deflection. */
    this.gamepadLookSpeed = Number.isFinite(opts.gamepadLookSpeed) ? opts.gamepadLookSpeed : 900;
    /** @type {number} Radial deadzone for both sticks. */
    this.gamepadDeadzone = Number.isFinite(opts.gamepadDeadzone) ? opts.gamepadDeadzone : 0.15;
    /** @type {number} Response exponent of the look stick (>1 = finer aim near center). */
    this.gamepadLookCurve = Number.isFinite(opts.gamepadLookCurve) ? opts.gamepadLookCurve : 2;
    /** @type {number} Response exponent of the move stick. */
    this.gamepadMoveCurve = Number.isFinite(opts.gamepadMoveCurve) ? opts.gamepadMoveCurve : 1.25;
    /** @type {number} Multiplier applied to touch look drags. */
    this.touchLookScale = Number.isFinite(opts.touchLookScale) ? opts.touchLookScale : 1;
    /** @type {number} Radius of the virtual joystick in CSS pixels. */
    this.joystickRadius = Number.isFinite(opts.joystickRadius) ? opts.joystickRadius : 64;
    /** @type {number} Maximum duration of a tap, in milliseconds. */
    this.tapMs = Number.isFinite(opts.tapMs) ? opts.tapMs : 200;
    /** @type {number} Maximum finger travel of a tap, in CSS pixels. */
    this.tapSlop = Number.isFinite(opts.tapSlop) ? opts.tapSlop : 14;
    /** @type {number} Press duration that turns a touch into "hold to place". */
    this.holdMs = Number.isFinite(opts.holdMs) ? opts.holdMs : 260;

    /* -- public state ------------------------------------------------------ */
    /** @type {boolean} False while the input layer is muted (loading screens). */
    this.enabled = true;
    /** @type {boolean} True while the pointer is locked to {@link Input#element}. */
    this.locked = false;
    /** @type {boolean} True while a text field has focus. */
    this.typing = false;
    /** @type {number} Wheel movement of the current frame, in notches. */
    this.wheel = 0;
    /** @type {number} Whole wheel notches of the current frame (hotbar scrolling). */
    this.wheelSteps = 0;
    /** @type {number} Frames processed since construction. */
    this.frameIndex = 0;
    /** @type {number} Index of the active gamepad, -1 when none. */
    this.gamepadIndex = -1;
    /** @type {Map<string, string>} Keyboard/mouse binding per action. */
    this.bindings = new Map(Object.entries(DEFAULT_BINDINGS));
    /** @type {Map<string, string>} Gamepad binding per action. */
    this.gamepadBindings = new Map(Object.entries(DEFAULT_GAMEPAD_BINDINGS));

    /* -- key/button state -------------------------------------------------- */
    /** @type {Set<string>} Codes currently held. @private */
    this._down = new Set();
    /** @type {Set<string>} Press edges visible this frame. @private */
    this._pressActive = new Set();
    /** @type {Set<string>} Press edges collected for the next frame. @private */
    this._pressPending = new Set();
    /** @type {Set<string>} Release edges visible this frame. @private */
    this._releaseActive = new Set();
    /** @type {Set<string>} Release edges collected for the next frame. @private */
    this._releasePending = new Set();

    /* -- touch action state ------------------------------------------------ */
    /** @type {Set<string>} Actions held by the touch layer. @private */
    this._touchDown = new Set();
    /** @type {Set<string>} Touch press edges visible this frame. @private */
    this._touchPressActive = new Set();
    /** @type {Set<string>} Touch press edges for the next frame. @private */
    this._touchPressPending = new Set();
    /** @type {Set<string>} Touch release edges visible this frame. @private */
    this._touchReleaseActive = new Set();
    /** @type {Set<string>} Touch release edges for the next frame. @private */
    this._touchReleasePending = new Set();
    /** @type {string[]} One-frame action pulses queued by taps. @private */
    this._touchPulseQueue = [];
    /** @type {string[]} Pulses that end at the next frame boundary. @private */
    this._touchPulseActive = [];

    /* -- look / move accumulators ------------------------------------------ */
    /** @type {number} Accumulated look delta X in pixels. @private */
    this._lookX = 0;
    /** @type {number} Accumulated look delta Y in pixels. @private */
    this._lookY = 0;
    /** @type {number[]} Scratch array returned by look queries. @private */
    this._lookDelta = [0, 0];
    /** @type {number[]} Scratch array returned by {@link Input#getMoveAxis}. @private */
    this._moveAxis = [0, 0];
    /** @type {number[]} Scratch array for stick shaping. @private */
    this._stick = [0, 0];
    /** @type {number} Gamepad move axis X of this frame. @private */
    this._padMoveX = 0;
    /** @type {number} Gamepad move axis Y of this frame. @private */
    this._padMoveY = 0;
    /** @type {number} Touch joystick axis X. @private */
    this._touchMoveX = 0;
    /** @type {number} Touch joystick axis Y. @private */
    this._touchMoveY = 0;

    /* -- wheel ------------------------------------------------------------- */
    /** @type {number} Wheel notches collected since the last frame. @private */
    this._wheelPending = 0;
    /** @type {number} Sub-notch remainder for trackpads. @private */
    this._wheelResidue = 0;
    /** @type {number} Whole steps injected by the gamepad shoulder buttons. @private */
    this._padWheelSteps = 0;

    /* -- gamepad ----------------------------------------------------------- */
    /** @type {Uint8Array} Previous gamepad button states. @private */
    this._padButtons = new Uint8Array(MAX_PAD_BUTTONS);
    /** @type {boolean} True while at least one gamepad is connected. @private */
    this._padConnected = false;

    /* -- touch ------------------------------------------------------------- */
    /** @type {boolean} True once a touch event was seen. @private */
    this._touchMode = false;
    /** @type {number} Identifier of the joystick touch, -1 when idle. @private */
    this._moveTouchId = -1;
    /** @type {number} Identifier of the look touch, -1 when idle. @private */
    this._lookTouchId = -1;
    /** @type {number} Joystick origin X in client pixels. @private */
    this._moveOriginX = 0;
    /** @type {number} Joystick origin Y in client pixels. @private */
    this._moveOriginY = 0;
    /** @type {number} Current joystick X in client pixels. @private */
    this._moveCurrentX = 0;
    /** @type {number} Current joystick Y in client pixels. @private */
    this._moveCurrentY = 0;
    /** @type {number} Last look touch X. @private */
    this._lookLastX = 0;
    /** @type {number} Last look touch Y. @private */
    this._lookLastY = 0;
    /** @type {number} Timestamp the look touch started. @private */
    this._lookStartTime = 0;
    /** @type {number} Manhattan travel of the look touch in pixels. @private */
    this._lookTravel = 0;
    /** @type {boolean} True once the look touch turned into a place-hold. @private */
    this._holdFired = false;
    /** @type {{active:boolean,lookActive:boolean,originX:number,originY:number,x:number,y:number,dx:number,dy:number,radius:number}}
     *  Reused touch report for the HUD. @private */
    this._touchState = {
      active: false, lookActive: false, originX: 0, originY: 0,
      x: 0, y: 0, dx: 0, dy: 0, radius: this.joystickRadius,
    };

    /* -- double press ------------------------------------------------------ */
    /** @type {Map<string, number>} Timestamp of the most recent press. @private */
    this._pressLast = new Map();
    /** @type {Map<string, number>} Timestamp of the press before that. @private */
    this._pressPrev = new Map();

    /** @type {boolean} Drop the first mouse move after acquiring lock. @private */
    this._ignoreNextMouseMove = false;
    /** @type {number} Timestamp of the previous `beginFrame`. @private */
    this._lastFrameTime = 0;
    /** @type {boolean} True once {@link Input#destroy} ran. @private */
    this._destroyed = false;
    /** @type {Object<string, Function>} Bound DOM handlers, kept for removal. @private */
    this._handlers = {};
    /** @type {EventTarget|null} Element the pointer/touch listeners sit on. @private */
    this._surface = null;
    /** @type {string[]} Cached action list for the per-frame sweep. @private */
    this._actionList = ACTIONS.slice();
    /** @type {Set<string>} Actions gated behind pointer lock. @private */
    this._lockRequired = new Set(LOCK_REQUIRED_ACTIONS);

    this._install();
  }

  /**
   * True once the user touched the screen; the HUD uses this to show the
   * virtual joystick and the touch buttons.
   * @returns {boolean} Whether the touch layer is active.
   */
  get isTouchMode() {
    return this._touchMode;
  }

  /**
   * True while a text field (chat, world name, …) has focus.
   * @returns {boolean} Whether typing is in progress.
   */
  get isTyping() {
    return this.typing;
  }

  /**
   * True while a gamepad is connected and polled.
   * @returns {boolean} Whether gamepad input is live.
   */
  get hasGamepad() {
    return this._padConnected;
  }

  /* ---------------------------------------------------------------- frame -- */

  /**
   * Promote buffered edges, poll the gamepad, fold the touch state in and
   * refresh derived per-frame values. Call once at the top of every frame.
   * @param {number} [dt] Frame time in seconds; measured internally when omitted.
   * @returns {void}
   */
  beginFrame(dt) {
    const now = this._now();
    let step = dt;
    if (!Number.isFinite(step) || step <= 0) {
      step = this._lastFrameTime > 0 ? Math.min(0.25, (now - this._lastFrameTime) / 1000) : 1 / 60;
    }
    this._lastFrameTime = now;
    this.frameIndex++;

    // Swap key/mouse edge buffers: what happened since endFrame() becomes
    // visible now, and the drained set is reused for the next collection.
    let swap = this._pressActive;
    this._pressActive = this._pressPending;
    this._pressPending = swap;
    this._pressPending.clear();

    swap = this._releaseActive;
    this._releaseActive = this._releasePending;
    this._releasePending = swap;
    this._releasePending.clear();

    // Same for the touch action edges.
    swap = this._touchPressActive;
    this._touchPressActive = this._touchPressPending;
    this._touchPressPending = swap;
    this._touchPressPending.clear();

    swap = this._touchReleaseActive;
    this._touchReleaseActive = this._touchReleasePending;
    this._touchReleasePending = swap;
    this._touchReleasePending.clear();

    this._expireTouchPulses();
    this._startTouchPulses();
    this._updateTouchHold(now);

    this._padWheelSteps = 0;
    this._pollGamepad(step);

    // Wheel: notches collected since the last frame, plus whole steps from the
    // gamepad shoulder buttons. The residue keeps trackpads from skipping
    // several hotbar slots per flick.
    this.wheel = this._wheelPending;
    this._wheelPending = 0;
    this._wheelResidue += this.wheel;
    let steps = Math.trunc(this._wheelResidue);
    this._wheelResidue -= steps;
    steps += this._padWheelSteps;
    this.wheelSteps = steps;
    if (this.wheel !== 0 || steps !== 0) this.emit('wheel', steps, this.wheel);

    // Record press timestamps for wasDoublePressed() and announce the presses.
    for (let i = 0; i < this._actionList.length; i++) {
      const action = this._actionList[i];
      if (!this.wasActionPressed(action)) continue;
      const last = this._pressLast.get(action);
      this._pressPrev.set(action, last === undefined ? -Infinity : last);
      this._pressLast.set(action, now);
      this.emit('action', action);
    }
  }

  /**
   * Drop the edges of the finished frame. Held state, look deltas and bindings
   * survive; only the one-frame signals are cleared.
   * @returns {void}
   */
  endFrame() {
    this._pressActive.clear();
    this._releaseActive.clear();
    this._touchPressActive.clear();
    this._touchReleaseActive.clear();
    this.wheel = 0;
    this.wheelSteps = 0;
  }

  /* ------------------------------------------------------------- keyboard -- */

  /**
   * Whether a raw code is currently held (ungated by pointer lock).
   * @param {string} code `KeyboardEvent.code`, `'MouseN'` or `'PadN'`.
   * @returns {boolean} True while held.
   */
  isDown(code) {
    return this.enabled && this._down.has(code);
  }

  /**
   * Whether a raw code went down during this frame.
   * @param {string} code Binding code.
   * @returns {boolean} True on the press frame.
   */
  wasPressed(code) {
    return this.enabled && this._pressActive.has(code);
  }

  /**
   * Whether a raw code was released during this frame.
   * @param {string} code Binding code.
   * @returns {boolean} True on the release frame.
   */
  wasReleased(code) {
    return this.enabled && this._releaseActive.has(code);
  }

  /* ---------------------------------------------------------------- mouse -- */

  /**
   * Whether a mouse button is held.
   * @param {number} button `MouseEvent.button` (0 = left, 1 = middle, 2 = right).
   * @returns {boolean} True while held.
   */
  isMouseDown(button) {
    return this.isDown(`Mouse${button | 0}`);
  }

  /**
   * Whether a mouse button went down during this frame.
   * @param {number} button `MouseEvent.button`.
   * @returns {boolean} True on the press frame.
   */
  wasMousePressed(button) {
    return this.wasPressed(`Mouse${button | 0}`);
  }

  /**
   * Whether a mouse button was released during this frame.
   * @param {number} button `MouseEvent.button`.
   * @returns {boolean} True on the release frame.
   */
  wasMouseReleased(button) {
    return this.wasReleased(`Mouse${button | 0}`);
  }

  /**
   * Wheel movement of the current frame in notches, normalized across
   * `deltaMode` (pixels, lines, pages). Positive = scrolled down/away.
   * @returns {number} Fractional notches.
   */
  getWheelDelta() {
    return this.enabled ? this.wheel : 0;
  }

  /**
   * Whole wheel notches of the current frame, with sub-notch remainder carried
   * over. This is what hotbar scrolling should use.
   * @returns {number} Integer steps.
   */
  getWheelSteps() {
    return this.enabled ? this.wheelSteps : 0;
  }

  /* --------------------------------------------------------- pointer lock -- */

  /**
   * Request pointer lock on the input element. Must be called from a user
   * gesture; failures are reported through the `'lockerror'` event.
   * @returns {boolean} True when a request was issued.
   */
  requestLock() {
    const el = this.element;
    if (!el || typeof el.requestPointerLock !== 'function') return false;
    if (this.locked || this._touchMode) return false;
    if (!this._requestLockCall(this.rawMouse)) return false;
    return true;
  }

  /**
   * Release pointer lock if this element holds it.
   * @returns {void}
   */
  exitLock() {
    const doc = this.document;
    if (!doc || typeof doc.exitPointerLock !== 'function') return;
    if (!this.locked) return;
    try {
      doc.exitPointerLock();
    } catch {
      /* Nothing to do: the browser already released the lock. */
    }
  }

  /**
   * Accumulated look delta in pixel-equivalents since the last
   * {@link Input#consumeLookDelta}. Mouse pixels, touch drag pixels and gamepad
   * stick motion all end up in the same unit; sensitivity and `invertY` are
   * applied by the caller.
   * @returns {number[]} Reused `[dx, dy]` array — copy it if you keep it.
   */
  getLookDelta() {
    const out = this._lookDelta;
    if (!this.enabled) {
      out[0] = 0;
      out[1] = 0;
      return out;
    }
    out[0] = this._lookX;
    out[1] = this._lookY;
    return out;
  }

  /**
   * Like {@link Input#getLookDelta} but zeroes the accumulator, so the camera
   * consumes every delta exactly once.
   * @returns {number[]} Reused `[dx, dy]` array.
   */
  consumeLookDelta() {
    const out = this.getLookDelta();
    this._lookX = 0;
    this._lookY = 0;
    return out;
  }

  /* --------------------------------------------------------------- actions -- */

  /**
   * Whether an action is currently active on any device.
   * @param {string} action Action name.
   * @returns {boolean} True while held.
   */
  isActionDown(action) {
    if (!this.enabled) return false;
    if (this._touchDown.has(action)) return true;
    const pad = this.gamepadBindings.get(action);
    if (pad !== undefined && this._down.has(pad)) return true;
    const code = this.bindings.get(action);
    if (code !== undefined && this._down.has(code) && this._codeAllowed(action)) return true;
    return false;
  }

  /**
   * Whether an action went down during this frame on any device.
   * @param {string} action Action name.
   * @returns {boolean} True on the press frame.
   */
  wasActionPressed(action) {
    if (!this.enabled) return false;
    if (this._touchPressActive.has(action)) return true;
    const pad = this.gamepadBindings.get(action);
    if (pad !== undefined && this._pressActive.has(pad)) return true;
    const code = this.bindings.get(action);
    if (code !== undefined && this._pressActive.has(code) && this._codeAllowed(action)) return true;
    return false;
  }

  /**
   * Whether an action was released during this frame on any device.
   * @param {string} action Action name.
   * @returns {boolean} True on the release frame.
   */
  wasActionReleased(action) {
    if (!this.enabled) return false;
    if (this._touchReleaseActive.has(action)) return true;
    const pad = this.gamepadBindings.get(action);
    if (pad !== undefined && this._releaseActive.has(pad)) return true;
    const code = this.bindings.get(action);
    if (code !== undefined && this._releaseActive.has(code) && this._codeAllowed(action)) return true;
    return false;
  }

  /**
   * Whether the action was pressed twice within `windowMs`, reported on the
   * frame of the second press. Used for double-tap-to-fly and double-tap-to-sprint.
   * @param {string} action Action name.
   * @param {number} [windowMs=300] Maximum gap between the two presses.
   * @returns {boolean} True on the frame that completes the double press.
   */
  wasDoublePressed(action, windowMs = 300) {
    if (!this.wasActionPressed(action)) return false;
    const last = this._pressLast.get(action);
    const prev = this._pressPrev.get(action);
    if (last === undefined || prev === undefined || !Number.isFinite(prev)) return false;
    return (last - prev) <= windowMs;
  }

  /**
   * Movement axes from keyboard, gamepad stick, d-pad and virtual joystick,
   * combined and clamped to the unit disc.
   * @returns {number[]} Reused `[x, y]`: `x` positive = right/strafe,
   *   `y` positive = forward.
   */
  getMoveAxis() {
    const out = this._moveAxis;
    out[0] = 0;
    out[1] = 0;
    if (!this.enabled) return out;

    if (this.isActionDown('right')) out[0] += 1;
    if (this.isActionDown('left')) out[0] -= 1;
    if (this.isActionDown('forward')) out[1] += 1;
    if (this.isActionDown('back')) out[1] -= 1;

    out[0] += this._padMoveX + this._touchMoveX;
    out[1] += this._padMoveY + this._touchMoveY;

    const mag = Math.hypot(out[0], out[1]);
    if (mag > 1) {
      out[0] /= mag;
      out[1] /= mag;
    }
    return out;
  }

  /* -------------------------------------------------------------- bindings -- */

  /**
   * Rebind an action. Codes starting with `'Pad'` replace the gamepad binding,
   * everything else the keyboard/mouse binding.
   * @param {string} action Action name; must exist in {@link ACTIONS}.
   * @param {string|null} code Binding code, or `null`/`''` to unbind.
   * @returns {boolean} True when the binding changed.
   */
  bind(action, code) {
    if (!this._actionList.includes(action)) {
      console.warn(`[VOXELIA] input: unknown action "${action}"`);
      return false;
    }
    const isPad = typeof code === 'string' && code.startsWith('Pad');
    const map = isPad ? this.gamepadBindings : this.bindings;
    const old = map.get(action);
    if (code === null || code === undefined || code === '') {
      if (old === undefined) return false;
      map.delete(action);
      this.emit('rebind', action, null, old);
      return true;
    }
    if (typeof code !== 'string' || /\s/.test(code)) {
      console.warn(`[VOXELIA] input: invalid binding code for "${action}":`, code);
      return false;
    }
    if (old === code) return false;
    map.set(action, code);
    this.emit('rebind', action, code, old === undefined ? null : old);
    return true;
  }

  /**
   * Current keyboard/mouse binding of an action.
   * @param {string} action Action name.
   * @returns {string|null} Binding code, or `null` when unbound.
   */
  getBinding(action) {
    const code = this.bindings.get(action);
    return code === undefined ? null : code;
  }

  /**
   * Current gamepad binding of an action.
   * @param {string} action Action name.
   * @returns {string|null} Pad code, or `null` when unbound.
   */
  getGamepadBinding(action) {
    const code = this.gamepadBindings.get(action);
    return code === undefined ? null : code;
  }

  /**
   * Actions currently bound to a code — the controls UI uses this to warn
   * about conflicts.
   * @param {string} code Binding code.
   * @param {string} [ignoreAction] Action to exclude from the search.
   * @returns {string[]} Conflicting action names.
   */
  findConflicts(code, ignoreAction) {
    const out = [];
    if (!code) return out;
    const map = code.startsWith('Pad') ? this.gamepadBindings : this.bindings;
    for (const [action, bound] of map) {
      if (bound === code && action !== ignoreAction) out.push(action);
    }
    return out;
  }

  /**
   * Restore the default keyboard and gamepad bindings.
   * @returns {void}
   */
  resetBindings() {
    this.bindings.clear();
    for (const action of Object.keys(DEFAULT_BINDINGS)) this.bindings.set(action, DEFAULT_BINDINGS[action]);
    this.gamepadBindings.clear();
    for (const action of Object.keys(DEFAULT_GAMEPAD_BINDINGS)) {
      this.gamepadBindings.set(action, DEFAULT_GAMEPAD_BINDINGS[action]);
    }
    this.emit('bindings', this.serialize().bindings);
  }

  /**
   * Persistable snapshot of the binding maps.
   * @returns {{version:number, bindings:Object<string,string>, gamepad:Object<string,string>}}
   *   Plain JSON-safe object.
   */
  serialize() {
    /** @type {Object<string, string>} */
    const bindings = {};
    for (const [action, code] of this.bindings) bindings[action] = code;
    /** @type {Object<string, string>} */
    const gamepad = {};
    for (const [action, code] of this.gamepadBindings) gamepad[action] = code;
    return { version: 1, bindings, gamepad };
  }

  /**
   * Restore bindings from {@link Input#serialize}. Unknown actions and
   * malformed codes are ignored; missing actions keep their defaults.
   * @param {{bindings?:Object<string,string>, gamepad?:Object<string,string>}|null} obj Stored snapshot.
   * @returns {boolean} True when at least one binding was applied.
   */
  deserialize(obj) {
    if (!obj || typeof obj !== 'object') return false;
    let applied = 0;
    if (obj.bindings && typeof obj.bindings === 'object') {
      for (const action of Object.keys(obj.bindings)) {
        const code = obj.bindings[action];
        if (!this._actionList.includes(action)) continue;
        if (typeof code !== 'string' || code === '' || /\s/.test(code) || code.startsWith('Pad')) continue;
        this.bindings.set(action, code);
        applied++;
      }
    }
    if (obj.gamepad && typeof obj.gamepad === 'object') {
      for (const action of Object.keys(obj.gamepad)) {
        const code = obj.gamepad[action];
        if (!this._actionList.includes(action)) continue;
        if (typeof code !== 'string' || !code.startsWith('Pad')) continue;
        this.gamepadBindings.set(action, code);
        applied++;
      }
    }
    if (applied > 0) this.emit('bindings', this.serialize().bindings);
    return applied > 0;
  }

  /* ----------------------------------------------------------------- touch -- */

  /**
   * Snapshot of the virtual joystick for the HUD renderer.
   * @returns {{active:boolean, lookActive:boolean, originX:number, originY:number,
   *   x:number, y:number, dx:number, dy:number, radius:number}} Reused object —
   *   `originX/Y` and `x/y` are client pixels, `dx/dy` the normalized stick.
   */
  getTouchState() {
    const s = this._touchState;
    s.active = this._moveTouchId >= 0;
    s.lookActive = this._lookTouchId >= 0;
    s.originX = this._moveOriginX;
    s.originY = this._moveOriginY;
    s.x = this._moveCurrentX;
    s.y = this._moveCurrentY;
    s.dx = this._touchMoveX;
    s.dy = this._touchMoveY;
    s.radius = this.joystickRadius;
    return s;
  }

  /**
   * Drive an action from an on-screen button (jump, sneak, inventory, …). The
   * HUD calls this on `pointerdown`/`pointerup` of its touch controls.
   * @param {string} action Action name.
   * @param {boolean} down Whether the button is held.
   * @returns {void}
   */
  setTouchAction(action, down) {
    if (!this._actionList.includes(action)) return;
    if (down) {
      if (this._touchDown.has(action)) return;
      this._touchDown.add(action);
      this._touchPressPending.add(action);
    } else {
      if (!this._touchDown.has(action)) return;
      this._touchDown.delete(action);
      this._touchReleasePending.add(action);
    }
  }

  /**
   * Fire an action for exactly one frame from the touch layer (tap gestures).
   * @param {string} action Action name.
   * @returns {void}
   */
  pulseTouchAction(action) {
    if (!this._actionList.includes(action)) return;
    this._touchPulseQueue.push(action);
  }

  /* --------------------------------------------------------------- control -- */

  /**
   * Mute or unmute the whole input layer. Muting clears every held key so
   * nothing is stuck when the game resumes.
   * @param {boolean} flag Whether input is accepted.
   * @returns {void}
   */
  setEnabled(flag) {
    const next = !!flag;
    if (next === this.enabled) return;
    this.enabled = next;
    if (!next) this.clear();
    this.emit('enabled', next);
  }

  /**
   * Forget every held key, button, edge and accumulated delta. Called on blur,
   * on tab hide and whenever the input layer is muted.
   * @returns {void}
   */
  clear() {
    this._down.clear();
    this._pressActive.clear();
    this._pressPending.clear();
    this._releaseActive.clear();
    this._releasePending.clear();
    this._touchDown.clear();
    this._touchPressActive.clear();
    this._touchPressPending.clear();
    this._touchReleaseActive.clear();
    this._touchReleasePending.clear();
    this._touchPulseQueue.length = 0;
    this._touchPulseActive.length = 0;
    this._lookX = 0;
    this._lookY = 0;
    this._padMoveX = 0;
    this._padMoveY = 0;
    this._touchMoveX = 0;
    this._touchMoveY = 0;
    this._moveTouchId = -1;
    this._lookTouchId = -1;
    this._holdFired = false;
    this._wheelPending = 0;
    this._wheelResidue = 0;
    this.wheel = 0;
    this.wheelSteps = 0;
    this._padButtons.fill(0);
  }

  /**
   * Detach every DOM listener, release pointer lock and drop all subscribers.
   * @returns {void}
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.exitLock();
    this._uninstall();
    this.clear();
    this.locked = false;
    this.removeAllListeners();
  }

  /* --------------------------------------------------------------- private -- */

  /**
   * Monotonic timestamp in milliseconds.
   * @returns {number} Milliseconds since the time origin.
   * @private
   */
  _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /**
   * Whether the keyboard/mouse binding of an action may act right now.
   * @param {string} action Action name.
   * @returns {boolean} False while gameplay keys are gated by the pointer lock.
   * @private
   */
  _codeAllowed(action) {
    if (!this.requireLock) return true;
    if (!this._lockRequired.has(action)) return true;
    return this.locked || this._touchMode;
  }

  /**
   * Register a press for a code, updating both the held set and the pending
   * edge buffer.
   * @param {string} code Binding code.
   * @returns {void}
   * @private
   */
  _pressCode(code) {
    if (this._down.has(code)) return;
    this._down.add(code);
    this._pressPending.add(code);
  }

  /**
   * Register a release for a code.
   * @param {string} code Binding code.
   * @returns {void}
   * @private
   */
  _releaseCode(code) {
    if (!this._down.delete(code)) return;
    this._releasePending.add(code);
  }

  /**
   * Issue the actual `requestPointerLock` call, retrying without the options
   * dictionary on browsers that reject it.
   * @param {boolean} unadjusted Ask for unaccelerated movement.
   * @returns {boolean} True when a call was made.
   * @private
   */
  _requestLockCall(unadjusted) {
    const el = this.element;
    if (!el) return false;
    try {
      const result = unadjusted
        ? el.requestPointerLock({ unadjustedMovement: true })
        : el.requestPointerLock();
      if (result && typeof result.then === 'function') {
        result.then(undefined, () => {
          if (unadjusted) this._requestLockCall(false);
          else this.emit('lockerror');
        });
      }
      return true;
    } catch {
      if (unadjusted) return this._requestLockCall(false);
      this.emit('lockerror');
      return false;
    }
  }

  /* ------------------------------------------------------- DOM installation -- */

  /**
   * Attach every DOM listener. Safe to call without a DOM (worker, tests): it
   * simply does nothing.
   * @returns {void}
   * @private
   */
  _install() {
    const doc = this.document;
    const el = this.element;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    const h = this._handlers;

    h.keydown = (e) => this._onKeyDown(e);
    h.keyup = (e) => this._onKeyUp(e);
    h.mousedown = (e) => this._onMouseDown(e);
    h.mouseup = (e) => this._onMouseUp(e);
    h.mousemove = (e) => this._onMouseMove(e);
    h.wheel = (e) => this._onWheel(e);
    h.contextmenu = (e) => this._onContextMenu(e);
    h.lockchange = () => this._onPointerLockChange();
    h.lockerror = () => this._onPointerLockError();
    h.blur = () => this._onBlur();
    h.visibility = () => { if (doc.hidden) this._onBlur(); };
    h.focusin = (e) => { this.typing = isTextTarget(e.target); if (this.typing) this._clearKeyboard(); };
    h.focusout = () => { this.typing = false; };
    h.touchstart = (e) => this._onTouchStart(e);
    h.touchmove = (e) => this._onTouchMove(e);
    h.touchend = (e) => this._onTouchEnd(e);
    h.gamepadconnected = (e) => this._onGamepadConnected(e, true);
    h.gamepaddisconnected = (e) => this._onGamepadConnected(e, false);

    doc.addEventListener('keydown', h.keydown, { passive: false });
    doc.addEventListener('keyup', h.keyup, { passive: false });
    doc.addEventListener('mousemove', h.mousemove, { passive: true });
    doc.addEventListener('mouseup', h.mouseup, { passive: true });
    doc.addEventListener('pointerlockchange', h.lockchange);
    doc.addEventListener('pointerlockerror', h.lockerror);
    doc.addEventListener('visibilitychange', h.visibility);
    doc.addEventListener('focusin', h.focusin);
    doc.addEventListener('focusout', h.focusout);

    const surface = el || doc;
    surface.addEventListener('mousedown', h.mousedown, { passive: true });
    surface.addEventListener('wheel', h.wheel, { passive: false });
    surface.addEventListener('contextmenu', h.contextmenu);
    surface.addEventListener('touchstart', h.touchstart, { passive: false });
    surface.addEventListener('touchmove', h.touchmove, { passive: false });
    surface.addEventListener('touchend', h.touchend, { passive: false });
    surface.addEventListener('touchcancel', h.touchend, { passive: false });
    this._surface = surface;

    if (typeof window !== 'undefined') {
      window.addEventListener('blur', h.blur);
      window.addEventListener('gamepadconnected', h.gamepadconnected);
      window.addEventListener('gamepaddisconnected', h.gamepaddisconnected);
    }
  }

  /**
   * Remove every listener installed by {@link Input#_install}.
   * @returns {void}
   * @private
   */
  _uninstall() {
    const doc = this.document;
    const h = this._handlers;
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('keydown', h.keydown);
      doc.removeEventListener('keyup', h.keyup);
      doc.removeEventListener('mousemove', h.mousemove);
      doc.removeEventListener('mouseup', h.mouseup);
      doc.removeEventListener('pointerlockchange', h.lockchange);
      doc.removeEventListener('pointerlockerror', h.lockerror);
      doc.removeEventListener('visibilitychange', h.visibility);
      doc.removeEventListener('focusin', h.focusin);
      doc.removeEventListener('focusout', h.focusout);
    }
    const surface = this._surface;
    if (surface && typeof surface.removeEventListener === 'function') {
      surface.removeEventListener('mousedown', h.mousedown);
      surface.removeEventListener('wheel', h.wheel);
      surface.removeEventListener('contextmenu', h.contextmenu);
      surface.removeEventListener('touchstart', h.touchstart);
      surface.removeEventListener('touchmove', h.touchmove);
      surface.removeEventListener('touchend', h.touchend);
      surface.removeEventListener('touchcancel', h.touchend);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', h.blur);
      window.removeEventListener('gamepadconnected', h.gamepadconnected);
      window.removeEventListener('gamepaddisconnected', h.gamepaddisconnected);
    }
    this._handlers = {};
    this._surface = null;
  }

  /* -------------------------------------------------------- keyboard events -- */

  /**
   * @param {KeyboardEvent} e Key event.
   * @returns {void}
   * @private
   */
  _onKeyDown(e) {
    if (this._destroyed) return;
    if (isTextTarget(e.target)) {
      this.typing = true;
      return;
    }
    this.typing = false;
    if (!this.enabled) return;
    const code = e.code;
    if (!code) return;
    if (this._shouldPreventDefault(code)) e.preventDefault();
    if (e.repeat) return;
    this._pressCode(code);
  }

  /**
   * Key releases are always processed, even while a text field has focus:
   * otherwise a key held before the chat opened would stay stuck down.
   * @param {KeyboardEvent} e Key event.
   * @returns {void}
   * @private
   */
  _onKeyUp(e) {
    if (this._destroyed) return;
    const code = e.code;
    if (!code) return;
    if (this.enabled && this._shouldPreventDefault(code)) e.preventDefault();
    this._releaseCode(code);
  }

  /**
   * Whether a browser default should be swallowed for this code. Only while
   * the pointer is locked or the game runs in touch mode, so `F5`, `F11` and
   * `Tab` keep working in the menus.
   * @param {string} code Key code.
   * @returns {boolean} True when `preventDefault()` should be called.
   * @private
   */
  _shouldPreventDefault(code) {
    if (!this.preventDefaults) return false;
    if (!this.locked && !this._touchMode) return false;
    if (code === 'Tab' || code === 'Space' || code.startsWith('Arrow')) return true;
    for (const bound of this.bindings.values()) {
      if (bound === code) return code !== 'Escape';
    }
    return false;
  }

  /**
   * Drop keyboard state (not mouse) when focus moves into a text field.
   * @returns {void}
   * @private
   */
  _clearKeyboard() {
    for (const code of Array.from(this._down)) {
      if (code.startsWith('Mouse') || code.startsWith('Pad')) continue;
      this._down.delete(code);
      this._releasePending.add(code);
    }
  }

  /* ----------------------------------------------------------- mouse events -- */

  /**
   * @param {MouseEvent} e Mouse event.
   * @returns {void}
   * @private
   */
  _onMouseDown(e) {
    if (this._destroyed || !this.enabled) return;
    if (isTextTarget(e.target)) return;
    this._pressCode(`Mouse${e.button | 0}`);
  }

  /**
   * @param {MouseEvent} e Mouse event.
   * @returns {void}
   * @private
   */
  _onMouseUp(e) {
    if (this._destroyed) return;
    this._releaseCode(`Mouse${e.button | 0}`);
  }

  /**
   * @param {MouseEvent} e Mouse event.
   * @returns {void}
   * @private
   */
  _onMouseMove(e) {
    if (this._destroyed || !this.enabled || !this.locked) return;
    if (this._ignoreNextMouseMove) {
      this._ignoreNextMouseMove = false;
      return;
    }
    let dx = e.movementX || 0;
    let dy = e.movementY || 0;
    if (dx > MAX_MOUSE_DELTA) dx = MAX_MOUSE_DELTA;
    else if (dx < -MAX_MOUSE_DELTA) dx = -MAX_MOUSE_DELTA;
    if (dy > MAX_MOUSE_DELTA) dy = MAX_MOUSE_DELTA;
    else if (dy < -MAX_MOUSE_DELTA) dy = -MAX_MOUSE_DELTA;
    this._lookX += dx;
    this._lookY += dy;
  }

  /**
   * Normalize wheel movement across `deltaMode` into notches.
   * @param {WheelEvent} e Wheel event.
   * @returns {void}
   * @private
   */
  _onWheel(e) {
    if (this._destroyed || !this.enabled) return;
    if (isTextTarget(e.target)) return;
    let delta = e.deltaY;
    if (!Number.isFinite(delta) || delta === 0) {
      delta = Number.isFinite(e.deltaX) ? e.deltaX : 0;
      if (delta === 0) return;
    }
    switch (e.deltaMode) {
      case 1: delta /= 3; break;        // DOM_DELTA_LINE: ~3 lines per notch
      case 2: break;                    // DOM_DELTA_PAGE: one page = one notch
      default: delta /= 100; break;     // DOM_DELTA_PIXEL: ~100 px per notch
    }
    if (delta > 10) delta = 10;
    else if (delta < -10) delta = -10;
    this._wheelPending += delta;
    if (this.locked || this._touchMode) e.preventDefault();
  }

  /**
   * @param {Event} e Context menu event.
   * @returns {void}
   * @private
   */
  _onContextMenu(e) {
    if (this._destroyed) return;
    if (isTextTarget(e.target)) return;
    e.preventDefault();
  }

  /**
   * @returns {void}
   * @private
   */
  _onPointerLockChange() {
    const doc = this.document;
    if (!doc) return;
    const locked = this.element ? doc.pointerLockElement === this.element : !!doc.pointerLockElement;
    if (locked === this.locked) return;
    this.locked = locked;
    if (locked) {
      this._ignoreNextMouseMove = true;
    } else {
      this._lookX = 0;
      this._lookY = 0;
      for (let i = 0; i < 5; i++) this._releaseCode(`Mouse${i}`);
    }
    this.emit('lockchange', locked);
  }

  /**
   * @returns {void}
   * @private
   */
  _onPointerLockError() {
    this.locked = false;
    this.emit('lockerror');
  }

  /**
   * @returns {void}
   * @private
   */
  _onBlur() {
    this.clear();
  }

  /* --------------------------------------------------------- gamepad events -- */

  /**
   * @param {GamepadEvent|Event} e Gamepad connection event.
   * @param {boolean} connected Whether the pad appeared or vanished.
   * @returns {void}
   * @private
   */
  _onGamepadConnected(e, connected) {
    const pad = /** @type {GamepadEvent} */ (e).gamepad || null;
    if (!connected && pad && this.gamepadIndex === pad.index) {
      this.gamepadIndex = -1;
      this._padConnected = false;
      this._releaseAllPadButtons();
    }
    this.emit('gamepad', connected, pad);
  }

  /**
   * Read the active gamepad and fold it into the shared code namespace.
   * @param {number} dt Frame time in seconds.
   * @returns {void}
   * @private
   */
  _pollGamepad(dt) {
    this._padMoveX = 0;
    this._padMoveY = 0;
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || typeof nav.getGamepads !== 'function') return;
    let pads = null;
    try {
      pads = nav.getGamepads();
    } catch {
      return;
    }
    if (!pads || pads.length === 0) {
      if (this._padConnected) {
        this._padConnected = false;
        this._releaseAllPadButtons();
      }
      return;
    }

    /** @type {Gamepad|null} */
    let pad = null;
    if (this.gamepadIndex >= 0 && pads[this.gamepadIndex] && pads[this.gamepadIndex].connected) {
      pad = pads[this.gamepadIndex];
    } else {
      for (let i = 0; i < pads.length; i++) {
        const candidate = pads[i];
        if (candidate && candidate.connected) {
          pad = candidate;
          this.gamepadIndex = i;
          break;
        }
      }
    }
    if (!pad) {
      if (this._padConnected) {
        this._padConnected = false;
        this.gamepadIndex = -1;
        this._releaseAllPadButtons();
      }
      return;
    }
    this._padConnected = true;
    if (!this.enabled) return;

    const buttons = pad.buttons;
    const count = Math.min(buttons.length, MAX_PAD_BUTTONS);
    for (let i = 0; i < count; i++) {
      const button = buttons[i];
      const pressed = button ? (button.pressed || button.value > 0.5) : false;
      const was = this._padButtons[i] === 1;
      if (pressed === was) continue;
      this._padButtons[i] = pressed ? 1 : 0;
      const code = `Pad${i}`;
      if (pressed) {
        this._down.add(code);
        this._pressActive.add(code);
        if (i === 4) this._padWheelSteps -= 1;      // LB: previous hotbar slot
        else if (i === 5) this._padWheelSteps += 1; // RB: next hotbar slot
      } else {
        this._down.delete(code);
        this._releaseActive.add(code);
      }
    }
    for (let i = count; i < MAX_PAD_BUTTONS; i++) {
      if (this._padButtons[i] === 1) {
        this._padButtons[i] = 0;
        this._down.delete(`Pad${i}`);
        this._releaseActive.add(`Pad${i}`);
      }
    }

    const axes = pad.axes;
    if (axes && axes.length >= 2) {
      const stick = shapeStick(axes[0] || 0, axes[1] || 0, this.gamepadDeadzone, this.gamepadMoveCurve, this._stick);
      this._padMoveX = stick[0];
      this._padMoveY = -stick[1];
    }
    if (axes && axes.length >= 4) {
      const stick = shapeStick(axes[2] || 0, axes[3] || 0, this.gamepadDeadzone, this.gamepadLookCurve, this._stick);
      const scale = this.gamepadLookSpeed * dt;
      this._lookX += stick[0] * scale;
      this._lookY += stick[1] * scale;
    }
  }

  /**
   * Release every pad code, e.g. after a disconnect.
   * @returns {void}
   * @private
   */
  _releaseAllPadButtons() {
    for (let i = 0; i < MAX_PAD_BUTTONS; i++) {
      if (this._padButtons[i] !== 1) continue;
      this._padButtons[i] = 0;
      const code = `Pad${i}`;
      this._down.delete(code);
      this._releaseActive.add(code);
    }
  }

  /* ----------------------------------------------------------- touch events -- */

  /**
   * Enter touch mode the first time a finger is seen.
   * @returns {void}
   * @private
   */
  _enterTouchMode() {
    if (this._touchMode) return;
    this._touchMode = true;
    this.emit('touchmode', true);
  }

  /**
   * @param {TouchEvent} e Touch event.
   * @returns {void}
   * @private
   */
  _onTouchStart(e) {
    if (this._destroyed) return;
    if (isTextTarget(e.target)) return;
    this._enterTouchMode();
    e.preventDefault();
    if (!this.enabled) return;
    const split = this._splitX();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (this._moveTouchId < 0 && touch.clientX < split) {
        this._moveTouchId = touch.identifier;
        this._moveOriginX = touch.clientX;
        this._moveOriginY = touch.clientY;
        this._moveCurrentX = touch.clientX;
        this._moveCurrentY = touch.clientY;
        this._touchMoveX = 0;
        this._touchMoveY = 0;
      } else if (this._lookTouchId < 0) {
        this._lookTouchId = touch.identifier;
        this._lookLastX = touch.clientX;
        this._lookLastY = touch.clientY;
        this._lookStartTime = this._now();
        this._lookTravel = 0;
        this._holdFired = false;
      }
    }
  }

  /**
   * @param {TouchEvent} e Touch event.
   * @returns {void}
   * @private
   */
  _onTouchMove(e) {
    if (this._destroyed) return;
    e.preventDefault();
    if (!this.enabled) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === this._moveTouchId) {
        this._moveCurrentX = touch.clientX;
        this._moveCurrentY = touch.clientY;
        const radius = this.joystickRadius > 1 ? this.joystickRadius : 1;
        let nx = (touch.clientX - this._moveOriginX) / radius;
        let ny = (touch.clientY - this._moveOriginY) / radius;
        const mag = Math.hypot(nx, ny);
        if (mag > 1) {
          nx /= mag;
          ny /= mag;
        }
        this._touchMoveX = nx;
        this._touchMoveY = -ny;
      } else if (touch.identifier === this._lookTouchId) {
        const dx = touch.clientX - this._lookLastX;
        const dy = touch.clientY - this._lookLastY;
        this._lookLastX = touch.clientX;
        this._lookLastY = touch.clientY;
        this._lookTravel += Math.abs(dx) + Math.abs(dy);
        this._lookX += dx * this.touchLookScale;
        this._lookY += dy * this.touchLookScale;
      }
    }
  }

  /**
   * @param {TouchEvent} e Touch event.
   * @returns {void}
   * @private
   */
  _onTouchEnd(e) {
    if (this._destroyed) return;
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === this._moveTouchId) {
        this._moveTouchId = -1;
        this._touchMoveX = 0;
        this._touchMoveY = 0;
      } else if (touch.identifier === this._lookTouchId) {
        const duration = this._now() - this._lookStartTime;
        if (this._holdFired) {
          this.setTouchAction('use', false);
        } else if (this.enabled && duration <= this.tapMs && this._lookTravel <= this.tapSlop) {
          this.pulseTouchAction('attack');
        }
        this._lookTouchId = -1;
        this._holdFired = false;
        this._lookTravel = 0;
      }
    }
  }

  /**
   * Turn a stationary look touch into a continuous "place block" press.
   * @param {number} now Current timestamp in milliseconds.
   * @returns {void}
   * @private
   */
  _updateTouchHold(now) {
    if (this._lookTouchId < 0 || this._holdFired || !this.enabled) return;
    if (this._lookTravel > this.tapSlop) return;
    if ((now - this._lookStartTime) < this.holdMs) return;
    this._holdFired = true;
    this._touchDown.add('use');
    this._touchPressActive.add('use');
  }

  /**
   * End the one-frame pulses started by the previous frame.
   * @returns {void}
   * @private
   */
  _expireTouchPulses() {
    for (let i = 0; i < this._touchPulseActive.length; i++) {
      const action = this._touchPulseActive[i];
      this._touchDown.delete(action);
      this._touchReleaseActive.add(action);
    }
    this._touchPulseActive.length = 0;
  }

  /**
   * Promote queued tap pulses so they are held for exactly this frame.
   * @returns {void}
   * @private
   */
  _startTouchPulses() {
    for (let i = 0; i < this._touchPulseQueue.length; i++) {
      const action = this._touchPulseQueue[i];
      this._touchDown.add(action);
      this._touchPressActive.add(action);
      this._touchPulseActive.push(action);
    }
    this._touchPulseQueue.length = 0;
  }

  /**
   * X coordinate that splits the move half from the look half, in client
   * pixels.
   * @returns {number} Split position.
   * @private
   */
  _splitX() {
    const el = this.element;
    if (el && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) return rect.left + rect.width * 0.5;
    }
    if (typeof window !== 'undefined' && window.innerWidth) return window.innerWidth * 0.5;
    return 0;
  }
}
