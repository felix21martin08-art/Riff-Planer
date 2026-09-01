/**
 * @file ui/stations_ui.js — VOXELIA workstation screens (ARCHITECTURE.md § 5.41).
 *
 * One class, {@link StationsUI}, renders the four "advanced" stations that are
 * not plain containers. It is the sibling of `ui/inventory_ui.js` and shares
 * its whole vocabulary — the same `vx-gui` window, the same `vx-cell` slots,
 * the same drag-and-drop, the same tooltip — so a player never notices they
 * left one screen family for another.
 *
 * | `open(kind)`   | window                                                   |
 * |----------------|----------------------------------------------------------|
 * | `enchanting`   | item + lapis slot, three offers, bookshelf power         |
 * | `anvil`        | two inputs, output preview, rename field, level cost     |
 * | `brewing`      | three bottles, ingredient, blaze fuel gauge, progress    |
 * | `trading`      | villager offer list, detail panel, profession XP bar     |
 *
 * ============================================================================
 * WHAT THIS MODULE OWNS
 * ============================================================================
 * * **The same pointer model as the inventory screen.** Left click takes a
 *   stack, right click takes half, right click while carrying places one item,
 *   dragging across slots distributes evenly (left) or one-by-one (right),
 *   shift-click quick-moves between the station and the player, and releasing
 *   outside the window throws the stack into the world.
 * * **Enchanting.** The three offers of {@link EnchantingTable} rendered as
 *   rows with a deterministic fake-glyph line (derived from the table seed, so
 *   it is stable while the player looks at it), the level requirement, the
 *   lapis cost, a hover reveal of the first enchantment and a hard disabled
 *   state for anything the player cannot pay. The bookshelf power is printed
 *   as a plain number, exactly as `table.bookshelves` reports it.
 * * **The anvil.** Both inputs, the live preview from {@link Anvil#refresh},
 *   the rename field wired to {@link Anvil#setName}, the level cost and the
 *   unmistakable `Zu teuer!` state when the prior-work penalty runs away.
 * * **The brewing stand.** Three bottle slots, the ingredient slot, a blaze
 *   powder gauge fed by `stand.fuelProgress`, bubbles and an arrow driven by
 *   `stand.progress`, and — the part that actually helps — the German name of
 *   the potion each bottle is about to become.
 * * **Villager trading.** {@link TradingSession} rendered as input → output
 *   rows, with the selected trade's detail, disabled rows for unaffordable or
 *   sold-out offers, the profession and trade level with an experience bar,
 *   and a take-trade button that also does bulk trades on shift.
 *
 * ============================================================================
 * COST
 * ============================================================================
 * The DOM is built once per `open()`. After that only values that actually
 * changed are written: slots repaint from the inventory's `change` event,
 * offer and trade lists rebuild only when their structural signature differs,
 * and every numeric readout is compared before it touches the DOM. A closed
 * screen returns on the first line of `update()`.
 *
 * Nothing here throws during a frame: every foreign call is guarded and each
 * distinct failure is logged exactly once.
 *
 * Styling uses `ui/style.css` (`vx-gui`, `vx-cell`, `vx-item`, `vx-arrow`,
 * `vx-xp`, `vx-tooltip`, …). The classes the stylesheet does not define yet —
 * the station layer and the four panel layouts — are added by a small
 * stylesheet that is *prepended* to `<head>`, exactly like `inventory_ui.js`
 * does it, so `ui/style.css` always wins. There is no second prefix.
 *
 * All player-visible text is German.
 *
 * @module ui/stations_ui
 */

import {
  CATEGORY_LABELS, RARITY,
  getItem, itemDisplay, itemTooltip, itemDurability, itemStackSize,
  itemRarity, itemCategory,
} from '../game/items.js';
import { ItemStack, SLOT, cloneMeta } from '../game/inventory.js';
import {
  TABLE_SLOT, ANVIL_SLOT, OFFER_COUNT, MAX_BOOKSHELVES, ANVIL_LEVEL_LIMIT,
  describeEnchantments,
} from '../game/enchanting.js';
import {
  BREW_SLOT, readPotion, brewResult, potionDisplayName, potionColor,
} from '../game/brewing.js';
import {
  MAX_TRADE_LEVEL, professionLabel, levelLabel,
} from '../game/villagers.js';
import { itemIconURL, prepareBlockIcons } from './inventory_ui.js';
import { clamp, mulberry32 } from '../core/math.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Id of the injected supplementary stylesheet. @type {string} */
const STYLE_ID = 'vx-stations-css';

/** Window kinds {@link StationsUI#open} understands. @type {ReadonlyArray<string>} */
export const STATION_KINDS = Object.freeze(['enchanting', 'anvil', 'brewing', 'trading']);

/** German window titles per kind. @type {Readonly<Object<string, string>>} */
const KIND_TITLES = Object.freeze({
  enchanting: 'Zaubertisch',
  anvil: 'Amboss',
  brewing: 'Braustand',
  trading: 'Handel',
});

/** German hint line per kind. @type {Readonly<Object<string, string>>} */
const KIND_HINTS = Object.freeze({
  enchanting: 'Klick: Stapel nehmen · Umschalt+Klick: verschieben · '
    + 'Angebot anklicken: verzaubern · Zeigen: erste Verzauberung',
  anvil: 'Klick: Stapel nehmen · Umschalt+Klick: verschieben · '
    + 'Name eintippen: umbenennen · Ergebnis anklicken: schmieden',
  brewing: 'Klick: Stapel nehmen · Umschalt+Klick: verschieben · '
    + 'Lohenstaub heizt den Stand, jede Zutat braucht 20 Sekunden',
  trading: 'Angebot anklicken: auswählen · Handeln: einmal tauschen · '
    + 'Umschalt+Handeln: so oft wie möglich',
});

/** German names of the four brewing slot roles. @type {ReadonlyArray<string>} */
const BOTTLE_LABELS = Object.freeze(['Flasche 1', 'Flasche 2', 'Flasche 3']);

/** Seconds between two trading-session refreshes. @type {number} */
const TRADE_INTERVAL = 0.2;

/** Seconds between two brewing readout safety refreshes. @type {number} */
const BREW_INTERVAL = 0.5;

/** Highest bulk trade one shift-click may execute. @type {number} */
const MAX_BULK_TRADE = 64;

/**
 * The alphabet the enchanting table's unreadable offer line is drawn from.
 * Deliberately restricted to Greek letters and mathematical operators: those
 * live in every system font stack the game may end up with, so the line never
 * degrades into a row of replacement boxes — and no font has to be fetched.
 * @type {string}
 */
const GLYPH_ALPHABET = 'ΓΔΘΛΞΠΣΦΨΩαβγδεζηθκλμνξπρστυφχψω†‡§¶∆∇∑∏√∞≈≡⊕⊗';

/** Supplementary CSS: only classes `ui/style.css` does not define. @type {string} */
const EXTRA_CSS = `
style.vx-stations-css{display:none}
.vx-stations{position:absolute;inset:0;z-index:var(--z-container);display:flex;
 align-items:center;justify-content:center;padding:var(--sp-4);box-sizing:border-box;
 background:rgba(4,7,12,.44);-webkit-backdrop-filter:blur(11px) saturate(112%);
 backdrop-filter:blur(11px) saturate(112%);opacity:0;visibility:hidden;pointer-events:none;
 transition:opacity var(--dur-2) var(--ease),visibility 0s linear var(--dur-2)}
.vx-stations.is-open{opacity:1;visibility:visible;pointer-events:auto;transition-delay:0s}
.vx-stations__stage{display:flex;align-items:stretch;gap:var(--sp-3);max-width:100%;max-height:100%;
 transform:translateY(calc(10px * var(--gui-scale))) scale(.985);opacity:0;
 transition:transform var(--dur-3) var(--ease-out),opacity var(--dur-3) var(--ease-out)}
.vx-stations.is-open .vx-stations__stage{transform:none;opacity:1}
.vx-stations__side{width:calc(268px * var(--gui-scale));display:flex;flex-direction:column;
 gap:var(--sp-3);padding:var(--sp-4);border-radius:var(--r-lg);background:var(--surface-2);
 border:var(--hair) solid var(--line-1);box-shadow:var(--sh-3),var(--sh-inset);
 -webkit-backdrop-filter:var(--blur-lg);backdrop-filter:var(--blur-lg);
 max-height:min(94vh,calc(880px * var(--gui-scale)));min-height:0}
.vx-station__body{display:flex;flex-direction:column;gap:var(--sp-4);min-height:0;
 overflow-y:auto;overflow-x:hidden;padding:var(--sp-05)}
.vx-station__top{display:flex;align-items:flex-start;justify-content:center;
 gap:var(--sp-5);flex-wrap:wrap}
.vx-station__stack{display:flex;flex-direction:column;align-items:center;gap:var(--sp-2)}
.vx-station__actions{display:flex;align-items:center;gap:var(--sp-2)}
.vx-station__hint{font-size:var(--fs-2xs);color:var(--text-3);text-align:center;line-height:1.5}
.vx-station__meta{display:flex;align-items:baseline;justify-content:space-between;
 gap:var(--sp-3);font-size:var(--fs-xs);color:var(--text-2)}
.vx-station__value{font-family:var(--font-mono);font-variant-numeric:tabular-nums;
 color:var(--text-0);font-weight:var(--fw-semi)}
.vx-station__cost{display:flex;align-items:center;justify-content:center;gap:var(--sp-2);
 font-size:var(--fs-sm);color:var(--text-1);text-align:center;min-height:calc(20px * var(--gui-scale))}
.vx-station__cost b{color:#8fe04a;font-weight:var(--fw-bold)}
.vx-station__cost.is-bad{color:var(--danger)}
.vx-station__cost.is-bad b{color:var(--danger)}
.vx-station__empty{font-size:var(--fs-xs);color:var(--text-3);text-align:center;
 padding:var(--sp-4) var(--sp-2);line-height:1.5}

.vx-ench{display:flex;flex-direction:column;gap:var(--sp-2);
 min-width:calc(300px * var(--gui-scale));flex:1 1 calc(300px * var(--gui-scale))}
.vx-ench__power{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-2);
 padding:var(--sp-2) var(--sp-3);border-radius:var(--r-sm);background:var(--surface-sunken);
 border:var(--hair) solid var(--line-0);font-size:var(--fs-xs);color:var(--text-2)}
.vx-ench__power b{font-family:var(--font-mono);font-size:var(--fs-md);color:var(--accent-soft)}
.vx-ench__offers{display:flex;flex-direction:column;gap:var(--sp-1)}
.vx-offer{position:relative;display:grid;grid-template-columns:calc(34px * var(--gui-scale)) 1fr;
 align-items:center;gap:var(--sp-3);padding:var(--sp-2) var(--sp-3);border-radius:var(--r-sm);
 background:rgba(6,10,16,.55);box-shadow:inset 0 0 0 var(--hair) rgba(255,255,255,.07);
 cursor:pointer;transition:background-color var(--dur-1) var(--ease),
 box-shadow var(--dur-1) var(--ease)}
.vx-offer:hover{background:rgba(78,163,255,.14);box-shadow:inset 0 0 0 var(--hair) var(--accent-a55)}
.vx-offer.is-disabled{opacity:.42;pointer-events:auto;cursor:default}
.vx-offer.is-disabled:hover{background:rgba(255,85,102,.10);
 box-shadow:inset 0 0 0 var(--hair) rgba(255,85,102,.35)}
.vx-offer__level{display:grid;place-items:center;width:calc(34px * var(--gui-scale));
 height:calc(34px * var(--gui-scale));border-radius:var(--r-sm);
 background:radial-gradient(circle at 50% 30%,rgba(143,224,74,.28),rgba(143,224,74,.08));
 box-shadow:inset 0 0 0 var(--hair) rgba(143,224,74,.4);color:#b7f277;
 font-family:var(--font-mono);font-size:var(--fs-md);font-weight:var(--fw-bold)}
.vx-offer__main{display:flex;flex-direction:column;gap:calc(2px * var(--gui-scale));min-width:0}
.vx-offer__glyphs{font-size:var(--fs-sm);letter-spacing:.14em;color:rgba(190,150,255,.82);
 text-shadow:0 0 calc(9px * var(--gui-scale)) rgba(150,100,255,.35);
 overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vx-offer__reveal{font-size:var(--fs-2xs);color:var(--accent-soft);opacity:0;
 transition:opacity var(--dur-1) var(--ease);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vx-offer:hover .vx-offer__reveal{opacity:1}
.vx-offer__cost{font-size:var(--fs-2xs);color:var(--text-3);
 overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vx-offer.is-disabled .vx-offer__cost{color:var(--danger)}

.vx-anvil{display:flex;align-items:center;justify-content:center;gap:var(--sp-3);flex-wrap:wrap}
.vx-anvil__plus{font-size:var(--fs-xl);color:var(--text-3);line-height:1;flex:none}
.vx-anvil__name{display:flex;flex-direction:column;gap:var(--sp-1);
 max-width:calc(360px * var(--gui-scale));margin:0 auto;width:100%}

.vx-brew{display:flex;align-items:flex-start;justify-content:center;gap:var(--sp-5);flex-wrap:wrap}
.vx-brew__col{display:flex;flex-direction:column;align-items:center;gap:var(--sp-2)}
.vx-brew__gauge{position:relative;width:calc(12px * var(--gui-scale));
 height:calc(56px * var(--gui-scale));border-radius:var(--r-pill);
 background:rgba(4,7,12,.7);box-shadow:inset 0 0 0 var(--hair) rgba(255,255,255,.09);
 overflow:hidden;flex:none}
.vx-brew__gaugefill{position:absolute;inset:auto 0 0 0;height:calc(var(--f, 0) * 100%);
 background:linear-gradient(180deg,#ffd166,#ff7a2f);
 box-shadow:0 0 calc(10px * var(--gui-scale)) rgba(255,160,60,.45);
 transition:height 180ms linear}
.vx-brew__bubbles{display:flex;align-items:flex-end;justify-content:center;gap:var(--sp-1);
 height:calc(22px * var(--gui-scale))}
.vx-brew__bubbles i{display:block;width:calc(5px * var(--gui-scale));
 height:calc(5px * var(--gui-scale));border-radius:50%;background:rgba(160,200,255,.25)}
.vx-brew__bubbles.is-on i{animation:vx-brewbubble 1.15s ease-in-out infinite;
 background:rgba(180,215,255,.85);box-shadow:0 0 calc(7px * var(--gui-scale)) rgba(140,190,255,.6)}
.vx-brew__bubbles.is-on i:nth-child(2){animation-delay:.28s}
.vx-brew__bubbles.is-on i:nth-child(3){animation-delay:.56s}
@keyframes vx-brewbubble{0%{transform:translateY(0) scale(.7);opacity:.25}
 45%{opacity:1}100%{transform:translateY(calc(-16px * var(--gui-scale))) scale(1.15);opacity:0}}
.vx-brew__out{display:flex;flex-direction:column;gap:var(--sp-1)}
.vx-brew__row{display:grid;grid-template-columns:calc(10px * var(--gui-scale)) calc(64px * var(--gui-scale)) 1fr;
 align-items:center;gap:var(--sp-2);padding:var(--sp-1) var(--sp-2);border-radius:var(--r-xs);
 background:rgba(6,10,16,.4);font-size:var(--fs-2xs);color:var(--text-2)}
.vx-brew__dot{width:calc(10px * var(--gui-scale));height:calc(10px * var(--gui-scale));
 border-radius:50%;background:var(--c, #385dc6);box-shadow:inset 0 0 0 var(--hair) rgba(0,0,0,.45)}
.vx-brew__text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-1)}
.vx-brew__text em{font-style:normal;color:var(--accent-soft)}

.vx-trade__head{display:flex;flex-direction:column;gap:var(--sp-2);padding:var(--sp-3);
 border-radius:var(--r-sm);background:var(--surface-sunken);border:var(--hair) solid var(--line-0)}
.vx-trade__list{display:flex;flex-direction:column;gap:var(--sp-1);min-height:0;
 overflow-y:auto;max-height:min(34vh,calc(300px * var(--gui-scale)));padding-right:var(--sp-1)}
.vx-trade{display:flex;align-items:center;gap:var(--sp-2);padding:var(--sp-1) var(--sp-2);
 border-radius:var(--r-sm);background:rgba(6,10,16,.5);
 box-shadow:inset 0 0 0 var(--hair) rgba(255,255,255,.06);cursor:pointer;
 transition:background-color var(--dur-1) var(--ease),box-shadow var(--dur-1) var(--ease)}
.vx-trade:hover{background:rgba(78,163,255,.13)}
.vx-trade.is-selected{background:var(--accent-a18);box-shadow:inset 0 0 0 var(--hair) var(--accent-a55)}
.vx-trade.is-disabled{opacity:.45;pointer-events:auto;cursor:default}
.vx-trade .vx-badge{flex:none;margin-left:auto}
.vx-trade .vx-badge + .vx-trade__uses{margin-left:var(--sp-2)}
.vx-trade__uses{margin-left:auto;flex:none;font-family:var(--font-mono);font-size:var(--fs-2xs);
 color:var(--text-3);white-space:nowrap}
.vx-trade__detail{display:flex;flex-direction:column;gap:var(--sp-2);font-size:var(--fs-xs);
 color:var(--text-2);flex:1 1 auto;min-height:0;overflow-y:auto}
.vx-trade__name{font-size:var(--fs-sm);font-weight:var(--fw-semi);color:var(--text-0);
 line-height:1.35}
@media (max-width:900px){.vx-stations__stage{flex-direction:column;overflow-y:auto}
 .vx-stations__side{width:auto}}
`;

/* ========================================================================== */
/* Diagnostics                                                                */
/* ========================================================================== */

/** Keys of problems already reported. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a message at most once per key — a broken frame must never spam.
 * @param {string} key de-duplication key
 * @param {string} message human readable message
 * @param {*} [err] optional underlying error
 * @returns {void}
 */
function warnOnce(key, message, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err === undefined) console.warn(`[stations-ui] ${message}`);
  else console.warn(`[stations-ui] ${message}`, err);
}

/* ========================================================================== */
/* DOM helpers                                                                */
/* ========================================================================== */

/** True once the supplementary stylesheet has been inserted. @type {boolean} */
let stylesInstalled = false;

/**
 * Insert the supplementary stylesheet exactly once, as the first child of
 * `<head>` so `ui/style.css` always overrides it.
 * @returns {void}
 */
function ensureStyles() {
  if (stylesInstalled) return;
  stylesInstalled = true;
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.className = STYLE_ID;
  style.textContent = EXTRA_CSS;
  document.head.insertBefore(style, document.head.firstChild);
}

/**
 * Create an element with a class list and optional text.
 * @param {string} tag tag name
 * @param {string} [cls] space separated class list
 * @param {string} [text] text content
 * @returns {HTMLElement} the new element
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * Create an inline SVG element from a viewBox and a list of path definitions.
 * @param {string} cls class list
 * @param {string} viewBox SVG `viewBox` attribute
 * @param {ReadonlyArray<{d:string, fill?:string, stroke?:string, width?:number}>} paths shapes
 * @returns {SVGElement} the SVG node
 */
function svgIcon(cls, viewBox, paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  for (let i = 0; i < paths.length; i++) {
    const spec = paths[i];
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', spec.d);
    path.setAttribute('fill', spec.fill === undefined ? 'currentColor' : spec.fill);
    if (spec.stroke) {
      path.setAttribute('stroke', spec.stroke);
      path.setAttribute('stroke-width', String(spec.width === undefined ? 1.6 : spec.width));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    }
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Write text into a node only when it actually changed.
 * @param {?HTMLElement} node target node (may be null)
 * @param {string} value new text
 * @returns {void}
 */
function setText(node, value) {
  if (node === null || node === undefined) return;
  if (node.__vxText === value) return;
  node.__vxText = value;
  node.textContent = value;
}

/**
 * Toggle a class only when the state actually changed.
 * @param {?HTMLElement} node target node
 * @param {string} cls class name
 * @param {boolean} on desired state
 * @returns {void}
 */
function setClass(node, cls, on) {
  if (node === null || node === undefined) return;
  if (node.classList.contains(cls) === on) return;
  node.classList.toggle(cls, on);
}

/**
 * Write a CSS custom property only when the rounded value changed. The
 * comparison is numeric on purpose: formatting the value on every frame would
 * allocate a string per frame per bar, which is exactly what the hot-path rule
 * forbids.
 * @param {?HTMLElement} node target node
 * @param {string} name property name, including the leading dashes
 * @param {number} value the value, written with three decimals
 * @returns {void}
 */
function setVar(node, name, value) {
  if (node === null || node === undefined) return;
  const rounded = Math.round((Number.isFinite(value) ? value : 0) * 1000) / 1000;
  if (node.__vxVars === undefined) node.__vxVars = Object.create(null);
  if (node.__vxVars[name] === rounded) return;
  node.__vxVars[name] = rounded;
  node.style.setProperty(name, rounded.toFixed(3));
}

/** Finite number or fallback.
 * @param {*} v candidate
 * @param {number} fallback replacement for non-numbers
 * @returns {number} a usable number
 */
function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/* ========================================================================== */
/* Fake enchantment script                                                    */
/* ========================================================================== */

/**
 * Build the unreadable rune line an enchanting table shows above an offer.
 *
 * It is deterministic in `(seed, slot)`: the same table shows the same line
 * for as long as the same item lies on it, and a different line the moment the
 * offers are re-rolled — which is exactly the feedback the player expects.
 *
 * @param {number} seed the table's 32-bit seed
 * @param {number} slot offer index `0..2`
 * @returns {string} a line of glyphs, three to five "words" long
 */
export function fakeGlyphLine(seed, slot) {
  const rng = mulberry32((((seed >>> 0) + (slot | 0) * 0x9e3779b9 + 0x51ed270b) >>> 0) || 1);
  const words = 3 + ((rng() * 3) | 0);
  const n = GLYPH_ALPHABET.length;
  let out = '';
  for (let w = 0; w < words; w++) {
    if (w > 0) out += ' ';
    const length = 2 + ((rng() * 4) | 0);
    for (let i = 0; i < length; i++) out += GLYPH_ALPHABET.charAt((rng() * n) | 0);
  }
  return out;
}

/* ========================================================================== */
/* Ghost glyphs for typed slots                                               */
/* ========================================================================== */

/** Path data for the ghost glyph of every typed slot, in a 24x24 box. */
const GHOSTS = Object.freeze({
  enchant: 'M12 2l2.2 5.4L20 9.2l-4.4 3.6L16.8 19 12 15.9 7.2 19l1.2-6.2L4 9.2l5.8-1.8L12 2z',
  lapis: 'M12 3l7 5-2.6 9H7.6L5 8l7-5zm0 2.6L7.4 8.9l1.8 6.1h5.6l1.8-6.1L12 5.6z',
  hammer: 'M14.5 2l7.5 7.5-3 3-2-2-7 7 1 1-3.5 3.5L2 17l3.5-3.5 1 1 7-7-2-2 3-3z',
  material: 'M12 2l9 5v10l-9 5-9-5V7l9-5zm0 2.3L5 8v8l7 3.9 7-3.9V8l-7-3.7z',
  result: 'M4 12h13m0 0l-5-5m5 5l-5 5',
  bottle: 'M10 2h4v3.4l3 4.2V21a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9.6l3-4.2V2zm-1 9v10h6V11H9z',
  ingredient: 'M12 2c1.6 3.2 5 4.6 5 8.6A5 5 0 0 1 12 16a5 5 0 0 1-5-5.4C7 6.6 10.4 5.2 12 2zM8 19h8v3H8v-3z',
  fuel: 'M12 23c-4.4 0-7.6-3-7.6-7.2 0-4.4 3.4-6.6 4.4-11.2.3-1.3.2-2.6-.2-3.6 3.8 1.8 6 4.8 6.4 8.2.9-.8 1.4-1.9 1.5-3.2 2.4 2.4 3.5 5.8 3.5 9 0 4.8-3.2 8-8 8z',
});

/**
 * Build the ghost glyph shown in an empty typed slot.
 * @param {string} name a key of the ghost table
 * @returns {?SVGElement} the glyph, or `null` for an unknown name
 */
function ghostGlyph(name) {
  const d = GHOSTS[name];
  if (d === undefined) return null;
  const stroked = name === 'result';
  return svgIcon('vx-cell__ghost', '0 0 24 24', [
    stroked ? { d, fill: 'none', stroke: 'currentColor', width: 2 } : { d },
  ]);
}

/* ========================================================================== */
/* StationsUI                                                                 */
/* ========================================================================== */

/**
 * The workstation screen: enchanting table, anvil, brewing stand and villager
 * trading.
 *
 * Created once during boot and reused for every station; a closed screen costs
 * nothing per frame. The lifecycle matches `InventoryUI` exactly, so the game
 * can treat both the same way.
 */
export class StationsUI {
  /**
   * @param {*} game the `Game` instance (duck-typed: `player`, `world`,
   *   `entities`, `renderer`, `input`, `audio`, `ui`, `settings`, and
   *   optionally `enchanting` / `villagers` managers)
   * @param {HTMLElement} root the `#ui` root element
   */
  constructor(game, root) {
    ensureStyles();

    /** @type {*} the game */
    this.game = game || null;
    /** @type {?HTMLElement} the UI root */
    this.root = root || null;

    /** @type {boolean} is a station window on screen? @private */
    this._open = false;
    /** @type {string} the kind currently shown. @private */
    this._kind = 'enchanting';
    /** @type {boolean} set by {@link StationsUI#dispose}. @private */
    this._disposed = false;

    /** @type {?Object} the station inventory (null while trading) */
    this.container = null;
    /** @type {?Object} the enchanting table currently shown */
    this.table = null;
    /** @type {?Object} the anvil currently shown */
    this.anvil = null;
    /** @type {?Object} the brewing stand currently shown */
    this.stand = null;
    /** @type {?Object} the trading session currently shown */
    this.session = null;
    /** @type {?Object} the player inventory the screen is bound to */
    this.playerInv = null;

    /* ---- layer ---------------------------------------------------------- */

    /** @type {HTMLElement} modal layer holding the window and the drag ghost */
    this.layer = el('div', 'vx-layer vx-stations');
    /** @type {HTMLElement} flex stage: window plus optional side panel */
    this.stage = el('div', 'vx-stations__stage');
    this.layer.appendChild(this.stage);

    /** @type {HTMLElement} the station window itself */
    this.win = el('div', 'vx-gui');
    this.win.setAttribute('role', 'dialog');
    this.win.setAttribute('aria-modal', 'true');
    this.stage.appendChild(this.win);

    /** @type {HTMLElement} window header @private */
    this._head = el('div', 'vx-gui__head');
    /** @type {HTMLElement} window title @private */
    this._title = el('h2', 'vx-gui__title', KIND_TITLES.enchanting);
    /** @type {HTMLElement} header buttons @private */
    this._actions = el('div', 'vx-station__actions');
    /** @type {HTMLElement} experience-level readout @private */
    this._levelBadge = el('span', 'vx-badge vx-badge--muted', 'Stufe 0');
    /** @type {HTMLButtonElement} close button @private */
    this._closeBtn = /** @type {HTMLButtonElement} */ (el('button', 'vx-gui__close'));
    this._closeBtn.type = 'button';
    this._closeBtn.title = 'Schließen';
    this._closeBtn.setAttribute('aria-label', 'Schließen');
    this._closeBtn.appendChild(svgIcon('', '0 0 24 24', [
      { d: 'M6 6l12 12M18 6L6 18', fill: 'none', stroke: 'currentColor', width: 2 },
    ]));
    this._actions.appendChild(this._levelBadge);
    this._actions.appendChild(this._closeBtn);
    this._head.appendChild(this._title);
    this._head.appendChild(this._actions);
    this.win.appendChild(this._head);

    /** @type {HTMLElement} scrolling window body @private */
    this._body = el('div', 'vx-station__body vx-scroll');
    this.win.appendChild(this._body);

    /** @type {HTMLElement} keyboard/mouse hint line @private */
    this._hint = el('div', 'vx-station__hint', KIND_HINTS.enchanting);
    this.win.appendChild(this._hint);

    /** @type {HTMLElement} side panel, only used while trading @private */
    this._side = el('aside', 'vx-stations__side is-hidden');
    this.stage.appendChild(this._side);

    /* ---- drag ghost & tooltip ------------------------------------------- */

    /** @type {HTMLElement} stack that follows the cursor @private */
    this._dragEl = el('div', 'vx-drag is-hidden');
    /** @type {HTMLImageElement} @private */
    this._dragImg = /** @type {HTMLImageElement} */ (el('img', 'vx-item__icon'));
    this._dragImg.alt = '';
    this._dragImg.decoding = 'async';
    /** @type {HTMLElement} @private */
    this._dragCount = el('span', 'vx-item__count');
    this._dragEl.appendChild(this._dragImg);
    this._dragEl.appendChild(this._dragCount);
    this.layer.appendChild(this._dragEl);

    /** @type {HTMLElement} item tooltip @private */
    this._tip = el('div', 'vx-tooltip');
    /** @type {HTMLElement} @private */
    this._tipName = el('div', 'vx-tooltip__name');
    /** @type {HTMLElement} @private */
    this._tipRows = el('div', 'vx-col');
    /** @type {HTMLElement} @private */
    this._tipLore = el('div', 'vx-tooltip__lore');
    this._tip.appendChild(this._tipName);
    this._tip.appendChild(this._tipRows);
    this._tip.appendChild(this._tipLore);
    this.layer.appendChild(this._tip);

    if (this.root) this.root.appendChild(this.layer);

    /* ---- slot & pointer state ------------------------------------------- */

    /** @type {Array<Object>} every slot view currently mounted. @private */
    this._slots = [];
    /** @type {Map<Object, Map<number, Object>>} inventory -> index -> view. @private */
    this._byInv = new Map();
    /** @type {Set<Object>} slot views waiting for a repaint. @private */
    this._dirty = new Set();
    /** @type {Array<Function>} teardown callbacks for event subscriptions. @private */
    this._unsub = [];

    /** @type {?ItemStack} the stack on the cursor */
    this.held = null;
    /** @type {?Object} active paint-drag: `{button, views}`. @private */
    this._paint = null;
    /** @type {number} last pointer X in viewport pixels. @private */
    this._px = 0;
    /** @type {number} last pointer Y in viewport pixels. @private */
    this._py = 0;
    /** @type {?Object} slot view under the cursor. @private */
    this._hover = null;
    /** @type {?HTMLElement} cell marked as the selected hotbar slot. @private */
    this._selCell = null;
    /** @type {number} last experience level written into the header. @private */
    this._lastLevel = -1;

    /* ---- enchanting state ------------------------------------------------ */

    /** @type {Array<Object>} the three offer rows. @private */
    this._offerRows = [];
    /** @type {?HTMLElement} bookshelf power readout. @private */
    this._powerValue = null;
    /** @type {?HTMLElement} "put an item in" placeholder. @private */
    this._enchEmpty = null;
    /** @type {boolean} the offer rows must be rewritten. @private */
    this._enchDirty = true;
    /** @type {number} bookshelf count the rows were written for. @private */
    this._eShelves = -1;
    /** @type {number} experience level the rows were written for. @private */
    this._eLevels = -1;
    /** @type {number} lapis count the rows were written for. @private */
    this._eLapis = -1;

    /* ---- anvil state ----------------------------------------------------- */

    /** @type {?HTMLInputElement} rename field. @private */
    this._nameInput = null;
    /** @type {?HTMLElement} level-cost readout. @private */
    this._costNode = null;
    /** @type {?HTMLElement} level-cost value. @private */
    this._costValue = null;
    /** @type {?HTMLElement} anvil explanation line. @private */
    this._anvilNote = null;
    /** @type {boolean} the anvil readout must be rewritten. @private */
    this._anvilDirty = true;
    /** @type {number} level cost the readout was written for. @private */
    this._aCost = -1;
    /** @type {boolean} "too expensive" state the readout was written for. @private */
    this._aTooMuch = false;
    /** @type {number} experience level the readout was written for. @private */
    this._aLevels = -1;
    /** @type {number} result item id the readout was written for. @private */
    this._aResult = -1;
    /** @type {?string} anvil message the readout was written for. @private */
    this._aMessage = null;

    /* ---- brewing state --------------------------------------------------- */

    /** @type {?HTMLElement} blaze powder gauge fill. @private */
    this._fuelFill = null;
    /** @type {?HTMLElement} fuel readout text. @private */
    this._fuelText = null;
    /** @type {?HTMLElement} bubble column. @private */
    this._bubbles = null;
    /** @type {?HTMLElement} brewing progress arrow. @private */
    this._brewArrow = null;
    /** @type {Array<Object>} the three potion readout rows. @private */
    this._brewRows = [];
    /** @type {number} inventory version the readouts were built from. @private */
    this._brewVersion = -1;
    /** @type {number} seconds until the next brewing readout refresh. @private */
    this._brewTimer = 0;
    /** @type {number} blaze-powder uses the fuel line was written for. @private */
    this._brewFuelUses = -1;

    /* ---- trading state --------------------------------------------------- */

    /** @type {Array<Object>} the mounted trade rows. @private */
    this._tradeRows = [];
    /** @type {?HTMLElement} trade list container. @private */
    this._tradeList = null;
    /** @type {?HTMLElement} "no offers" placeholder. @private */
    this._tradeEmpty = null;
    /** @type {?HTMLElement} profession line. @private */
    this._tradeWho = null;
    /** @type {?HTMLElement} level line. @private */
    this._tradeLevel = null;
    /** @type {?HTMLElement} xp bar fill. @private */
    this._tradeXpFill = null;
    /** @type {?HTMLElement} xp readout. @private */
    this._tradeXpText = null;
    /** @type {?HTMLElement} detail body. @private */
    this._tradeDetail = null;
    /** @type {?HTMLElement} detail headline. @private */
    this._tradeName = null;
    /** @type {?HTMLButtonElement} take-trade button. @private */
    this._tradeBtn = null;
    /** @type {string} signature of the trade rows currently rendered. @private */
    this._tradeSig = '';
    /** @type {number} seconds until the next trading refresh. @private */
    this._tradeTimer = 0;
    /** @type {boolean} the trading session must be re-read. @private */
    this._tradeDirty = true;

    /** @type {?string} game state active before the screen opened. @private */
    this._prevState = null;

    /* ---- listeners ------------------------------------------------------ */

    /** @type {function(PointerEvent):void} @private */
    this._onPointerDown = (e) => this._guard('pointerdown', () => this._handleDown(e));
    /** @type {function(PointerEvent):void} @private */
    this._onPointerMove = (e) => this._guard('pointermove', () => this._handleMove(e));
    /** @type {function(PointerEvent):void} @private */
    this._onPointerUp = (e) => this._guard('pointerup', () => this._handleUp(e));
    /** @type {function(KeyboardEvent):void} @private */
    this._onKeyDown = (e) => this._guard('keydown', () => this._handleKey(e));
    /** @type {function(Event):void} @private */
    this._onContextMenu = (e) => e.preventDefault();

    this.layer.addEventListener('pointerdown', this._onPointerDown);
    this.layer.addEventListener('contextmenu', this._onContextMenu);
    this._closeBtn.addEventListener('click', () => this.close());
    window.addEventListener('pointermove', this._onPointerMove, true);
    window.addEventListener('pointerup', this._onPointerUp, true);
    window.addEventListener('keydown', this._onKeyDown, true);
  }

  /* ====================================================================== */
  /* Public API                                                             */
  /* ====================================================================== */

  /**
   * Whether a station window is currently on screen.
   * @returns {boolean} true while open
   */
  get isOpen() {
    return this._open;
  }

  /**
   * The kind of window currently shown.
   * @returns {string} one of {@link STATION_KINDS}
   */
  get kind() {
    return this._kind;
  }

  /**
   * Open a station window.
   *
   * @param {string} [kind] `'enchanting'`, `'anvil'`, `'brewing'` or
   *   `'trading'`; anything else is derived from the block entity
   * @param {?Object} [blockEntity] the `EnchantingTable`, `Anvil`,
   *   `BrewingStand` or `TradingSession` to show
   * @returns {boolean} true when the window is now open
   */
  open(kind, blockEntity) {
    if (this._disposed) return false;
    const player = this.game && this.game.player;
    const inv = player && player.inventory;
    if (!inv || typeof inv.get !== 'function') {
      warnOnce('noinv', 'open() without a player inventory; the screen stays closed.');
      return false;
    }
    const entity = (blockEntity === undefined || blockEntity === null) ? null : blockEntity;
    const resolved = this._resolveKind(kind, entity);
    if (resolved === null) {
      warnOnce('nokind', 'open() with an unknown station kind; the screen stays closed.');
      return false;
    }
    if (this._open) this.close();

    this.playerInv = inv;
    this._kind = resolved;
    this.table = null;
    this.anvil = null;
    this.stand = null;
    this.session = null;
    this.container = null;

    if (resolved === 'trading') {
      if (entity === null || typeof entity.takeTrade !== 'function') {
        warnOnce('nosession', 'the trading screen needs a TradingSession; it stays closed.');
        return false;
      }
      this.session = entity;
    } else {
      if (entity === null || typeof entity.get !== 'function') {
        warnOnce(`noentity:${resolved}`,
          `the ${resolved} screen needs its block entity; it stays closed.`);
        return false;
      }
      this.container = entity;
      if (resolved === 'enchanting') this.table = entity;
      else if (resolved === 'anvil') this.anvil = entity;
      else this.stand = entity;
    }

    prepareBlockIcons(this.game && this.game.renderer).then(() => {
      if (this._open) this._refreshAll();
    }).catch(() => undefined);

    this._build();
    this._subscribe();

    this._open = true;
    this.layer.style.pointerEvents = 'auto';
    setClass(this.layer, 'is-open', true);
    this._lastLevel = -1;
    this._enchDirty = true;
    this._eShelves = -1;
    this._eLevels = -1;
    this._eLapis = -1;
    this._anvilDirty = true;
    this._aCost = -1;
    this._aLevels = -1;
    this._aResult = -1;
    this._aMessage = null;
    this._brewVersion = -1;
    this._brewTimer = 0;
    this._brewFuelUses = -1;
    this._tradeSig = '';
    this._tradeTimer = 0;
    this._tradeDirty = true;

    if (this.container !== null && typeof this.container.open === 'function') {
      try { this.container.open(); } catch (err) { warnOnce('copen', 'station.open() failed.', err); }
    }
    this._primeStation();

    this._releasePointer();
    this._pushState();
    this._playUI('ui_open');
    this._refreshAll();
    this._refreshStation(true);
    return true;
  }

  /**
   * Close the window, returning the cursor stack to the player. Anything that
   * no longer fits is thrown into the world.
   * @returns {void}
   */
  close() {
    if (!this._open) return;
    this._open = false;
    this._paint = null;
    this._hover = null;

    this._returnHeld();

    if (this.container !== null && typeof this.container.close === 'function') {
      try { this.container.close(); } catch (err) { warnOnce('cclose', 'station.close() failed.', err); }
    }
    if (this.session !== null && typeof this.session.close === 'function') {
      try { this.session.close(); } catch (err) { warnOnce('sclose', 'session.close() failed.', err); }
    }

    this._unsubscribe();
    setClass(this.layer, 'is-open', false);
    setClass(this._tip, 'is-on', false);
    setClass(this._dragEl, 'is-hidden', true);
    this.layer.style.pointerEvents = 'none';
    this._setTyping(false);

    this.container = null;
    this.table = null;
    this.anvil = null;
    this.stand = null;
    this.session = null;

    this._popState();
    this._grabPointer();
    this._playUI('ui_close');
  }

  /**
   * Per-frame refresh. Costs nothing while the screen is closed.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   */
  update(dt) {
    if (!this._open || this._disposed) return;
    const step = num(dt, 0);
    this._guard('update', () => {
      this._flushDirty();
      this._syncSelection();
      this._syncLevelBadge();
      this._brewTimer -= step;
      this._tradeTimer -= step;
      this._refreshStation(false);
    });
  }

  /**
   * Detach every listener and remove the DOM.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    if (this._open) this.close();
    this._disposed = true;
    this.layer.removeEventListener('pointerdown', this._onPointerDown);
    this.layer.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('pointermove', this._onPointerMove, true);
    window.removeEventListener('pointerup', this._onPointerUp, true);
    window.removeEventListener('keydown', this._onKeyDown, true);
    this._unsubscribe();
    if (this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this._slots.length = 0;
    this._byInv.clear();
    this._dirty.clear();
    this._offerRows.length = 0;
    this._brewRows.length = 0;
    this._tradeRows.length = 0;
  }

  /* ====================================================================== */
  /* Layout                                                                 */
  /* ====================================================================== */

  /**
   * Normalise the requested window kind.
   * @param {*} kind requested kind
   * @param {?Object} entity the block entity or session, when one was passed
   * @returns {?string} a value of {@link STATION_KINDS}, or `null`
   * @private
   */
  _resolveKind(kind, entity) {
    const raw = typeof kind === 'string' ? kind.toLowerCase() : '';
    if (raw === 'enchanting' || raw === 'enchanting_table' || raw === 'enchantment_table') {
      return 'enchanting';
    }
    if (raw === 'anvil' || raw === 'chipped_anvil' || raw === 'damaged_anvil') return 'anvil';
    if (raw === 'brewing' || raw === 'brewing_stand' || raw === 'brewstand') return 'brewing';
    if (raw === 'trading' || raw === 'trade' || raw === 'villager' || raw === 'merchant') {
      return 'trading';
    }
    if (entity !== null) {
      const own = typeof entity.kind === 'string' ? entity.kind.toLowerCase() : '';
      if (own === 'enchanting_table') return 'enchanting';
      if (own === 'anvil') return 'anvil';
      if (own === 'brewing_stand') return 'brewing';
      if (typeof entity.takeTrade === 'function') return 'trading';
    }
    return null;
  }

  /**
   * Rebuild the window body for the active kind.
   * @returns {void}
   * @private
   */
  _build() {
    this._slots.length = 0;
    this._byInv.clear();
    this._dirty.clear();
    this._body.textContent = '';
    this._side.textContent = '';
    this._selCell = null;

    this._offerRows.length = 0;
    this._powerValue = null;
    this._enchEmpty = null;
    this._nameInput = null;
    this._costNode = null;
    this._costValue = null;
    this._anvilNote = null;
    this._fuelFill = null;
    this._fuelText = null;
    this._bubbles = null;
    this._brewArrow = null;
    this._brewRows.length = 0;
    this._tradeRows.length = 0;
    this._tradeList = null;
    this._tradeEmpty = null;
    this._tradeWho = null;
    this._tradeLevel = null;
    this._tradeXpFill = null;
    this._tradeXpText = null;
    this._tradeDetail = null;
    this._tradeName = null;
    this._tradeBtn = null;

    let title = KIND_TITLES[this._kind] || 'Station';
    if (this.container !== null && typeof this.container.title === 'string'
      && this.container.title.length > 0) {
      title = this.container.title;
    }
    setText(this._title, title);
    setText(this._hint, KIND_HINTS[this._kind] || '');

    if (this._kind === 'enchanting') this._buildEnchanting();
    else if (this._kind === 'anvil') this._buildAnvil();
    else if (this._kind === 'brewing') this._buildBrewing();
    else this._buildTrading();

    setClass(this._side, 'is-hidden', this._kind !== 'trading');
    this._buildBackpack();
  }

  /**
   * Item slot, lapis slot, bookshelf power and the three offer rows.
   * @returns {void}
   * @private
   */
  _buildEnchanting() {
    const table = this.table;
    const top = el('div', 'vx-station__top');

    const slots = el('div', 'vx-station__stack');
    slots.appendChild(el('div', 'vx-gui__legend', 'Gegenstand'));
    const itemGrid = el('div', 'vx-grid vx-grid--armor');
    itemGrid.appendChild(this._makeCell(table, TABLE_SLOT.ITEM, 'normal', 'enchant'));
    slots.appendChild(itemGrid);
    slots.appendChild(el('div', 'vx-gui__legend', 'Lapislazuli'));
    const lapisGrid = el('div', 'vx-grid vx-grid--armor');
    lapisGrid.appendChild(this._makeCell(table, TABLE_SLOT.LAPIS, 'normal', 'lapis'));
    slots.appendChild(lapisGrid);
    top.appendChild(slots);

    const panel = el('div', 'vx-ench');
    const power = el('div', 'vx-ench__power');
    power.appendChild(el('span', '', 'Bücherregale in Reichweite'));
    this._powerValue = el('b', 'vx-mono', '0');
    power.appendChild(this._powerValue);
    panel.appendChild(power);

    const offers = el('div', 'vx-ench__offers');
    for (let i = 0; i < OFFER_COUNT; i++) {
      const row = el('div', 'vx-offer is-hidden');
      row.setAttribute('role', 'button');
      row.tabIndex = -1;
      const level = el('div', 'vx-offer__level', '0');
      const main = el('div', 'vx-offer__main');
      const glyphs = el('div', 'vx-offer__glyphs', '');
      const reveal = el('div', 'vx-offer__reveal', '');
      const cost = el('div', 'vx-offer__cost', '');
      main.appendChild(glyphs);
      main.appendChild(reveal);
      main.appendChild(cost);
      row.appendChild(level);
      row.appendChild(main);
      row.__vxOffer = i;
      offers.appendChild(row);
      this._offerRows.push({ el: row, level, glyphs, reveal, cost, index: i });
    }
    panel.appendChild(offers);

    this._enchEmpty = el('div', 'vx-station__empty',
      'Lege einen verzauberbaren Gegenstand und Lapislazuli ein. '
      + 'Bücherregale rund um den Tisch heben die Stufen.');
    panel.appendChild(this._enchEmpty);
    top.appendChild(panel);

    this._body.appendChild(top);
  }

  /**
   * Two inputs, the preview, the rename field and the level cost.
   * @returns {void}
   * @private
   */
  _buildAnvil() {
    const anvil = this.anvil;
    const top = el('div', 'vx-station__top');
    const row = el('div', 'vx-anvil');

    const left = el('div', 'vx-station__stack');
    left.appendChild(el('div', 'vx-gui__legend', 'Gegenstand'));
    const leftGrid = el('div', 'vx-grid vx-grid--armor');
    leftGrid.appendChild(this._makeCell(anvil, ANVIL_SLOT.LEFT, 'normal', 'hammer'));
    left.appendChild(leftGrid);
    row.appendChild(left);

    row.appendChild(el('div', 'vx-anvil__plus', '+'));

    const right = el('div', 'vx-station__stack');
    right.appendChild(el('div', 'vx-gui__legend', 'Material'));
    const rightGrid = el('div', 'vx-grid vx-grid--armor');
    rightGrid.appendChild(this._makeCell(anvil, ANVIL_SLOT.RIGHT, 'normal', 'material'));
    right.appendChild(rightGrid);
    row.appendChild(right);

    row.appendChild(this._makeArrow());

    const out = el('div', 'vx-station__stack');
    out.appendChild(el('div', 'vx-gui__legend', 'Ergebnis'));
    const outGrid = el('div', 'vx-grid vx-grid--armor');
    outGrid.appendChild(this._makeCell(anvil, ANVIL_SLOT.RESULT, 'anvil_out', 'result'));
    out.appendChild(outGrid);
    row.appendChild(out);

    top.appendChild(row);
    this._body.appendChild(top);

    const name = el('div', 'vx-anvil__name');
    name.appendChild(el('div', 'vx-gui__legend', 'Name'));
    const input = /** @type {HTMLInputElement} */ (el('input', 'vx-input'));
    input.type = 'text';
    input.maxLength = 48;
    input.placeholder = 'Neuer Name…';
    input.setAttribute('aria-label', 'Gegenstand umbenennen');
    input.addEventListener('input', () => this._guard('rename', () => this._applyName()));
    input.addEventListener('focus', () => this._setTyping(true));
    input.addEventListener('blur', () => this._setTyping(false));
    this._nameInput = input;
    name.appendChild(input);
    this._body.appendChild(name);

    this._costNode = el('div', 'vx-station__cost');
    this._costNode.appendChild(el('span', '', 'Kosten'));
    this._costValue = el('b', 'vx-mono', '0');
    this._costNode.appendChild(this._costValue);
    this._body.appendChild(this._costNode);

    this._anvilNote = el('div', 'vx-station__empty', '');
    this._body.appendChild(this._anvilNote);
  }

  /**
   * Fuel column, ingredient with bubbles and arrow, the three bottles and the
   * resulting potion names.
   * @returns {void}
   * @private
   */
  _buildBrewing() {
    const stand = this.stand;
    const top = el('div', 'vx-station__top');
    const brew = el('div', 'vx-brew');

    const fuelCol = el('div', 'vx-brew__col');
    fuelCol.appendChild(el('div', 'vx-gui__legend', 'Lohenstaub'));
    const fuelGrid = el('div', 'vx-grid vx-grid--armor');
    fuelGrid.appendChild(this._makeCell(stand, BREW_SLOT.FUEL, 'normal', 'fuel'));
    fuelCol.appendChild(fuelGrid);
    const gauge = el('div', 'vx-brew__gauge');
    this._fuelFill = el('div', 'vx-brew__gaugefill');
    gauge.appendChild(this._fuelFill);
    fuelCol.appendChild(gauge);
    this._fuelText = el('div', 'vx-station__hint', '0 Brauvorgänge');
    fuelCol.appendChild(this._fuelText);
    brew.appendChild(fuelCol);

    const midCol = el('div', 'vx-brew__col');
    midCol.appendChild(el('div', 'vx-gui__legend', 'Zutat'));
    const ingGrid = el('div', 'vx-grid vx-grid--armor');
    ingGrid.appendChild(this._makeCell(stand, BREW_SLOT.INGREDIENT, 'normal', 'ingredient'));
    midCol.appendChild(ingGrid);
    this._bubbles = el('div', 'vx-brew__bubbles');
    this._bubbles.appendChild(el('i'));
    this._bubbles.appendChild(el('i'));
    this._bubbles.appendChild(el('i'));
    midCol.appendChild(this._bubbles);
    this._brewArrow = el('div', 'vx-arrow vx-arrow--progress');
    this._brewArrow.appendChild(el('i'));
    midCol.appendChild(this._brewArrow);
    brew.appendChild(midCol);

    const bottleCol = el('div', 'vx-brew__col');
    bottleCol.appendChild(el('div', 'vx-gui__legend', 'Flaschen'));
    const bottleGrid = el('div', 'vx-grid vx-grid--craft3');
    for (let i = 0; i < 3; i++) {
      bottleGrid.appendChild(this._makeCell(stand, BREW_SLOT.BOTTLE_0 + i, 'normal', 'bottle'));
    }
    bottleCol.appendChild(bottleGrid);
    brew.appendChild(bottleCol);

    top.appendChild(brew);
    this._body.appendChild(top);

    const section = el('div', 'vx-gui__section');
    section.appendChild(el('div', 'vx-gui__legend', 'Ergebnis'));
    const list = el('div', 'vx-brew__out');
    for (let i = 0; i < 3; i++) {
      const row = el('div', 'vx-brew__row');
      const dot = el('span', 'vx-brew__dot');
      const label = el('span', '', BOTTLE_LABELS[i]);
      const text = el('span', 'vx-brew__text', '—');
      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(text);
      list.appendChild(row);
      this._brewRows.push({ el: row, dot, text, cCurrent: null, cNext: undefined, cColor: '' });
    }
    section.appendChild(list);
    this._body.appendChild(section);
  }

  /**
   * Profession header with the XP bar, the offer list and the detail panel.
   * @returns {void}
   * @private
   */
  _buildTrading() {
    const head = el('div', 'vx-trade__head');
    const who = el('div', 'vx-station__meta');
    this._tradeWho = el('span', '', 'Dorfbewohner');
    this._tradeLevel = el('span', 'vx-station__value', 'Neuling');
    who.appendChild(this._tradeWho);
    who.appendChild(this._tradeLevel);
    head.appendChild(who);

    const xp = el('div', 'vx-xp');
    const track = el('div', 'vx-xp__track');
    this._tradeXpFill = el('div', 'vx-xp__fill');
    track.appendChild(this._tradeXpFill);
    xp.appendChild(track);
    this._tradeXpText = el('span', 'vx-station__value', '0 / 0');
    xp.appendChild(this._tradeXpText);
    head.appendChild(xp);
    this._body.appendChild(head);

    const section = el('div', 'vx-gui__section');
    section.appendChild(el('div', 'vx-gui__legend', 'Angebote'));
    this._tradeList = el('div', 'vx-trade__list vx-scroll');
    section.appendChild(this._tradeList);
    this._tradeEmpty = el('div', 'vx-station__empty',
      'Dieser Dorfbewohner hat gerade nichts anzubieten.');
    section.appendChild(this._tradeEmpty);
    this._body.appendChild(section);

    this._side.appendChild(el('div', 'vx-gui__legend', 'Ausgewähltes Angebot'));
    this._tradeName = el('div', 'vx-trade__name', '—');
    this._side.appendChild(this._tradeName);
    this._tradeDetail = el('div', 'vx-trade__detail vx-scroll');
    this._side.appendChild(this._tradeDetail);
    const btn = /** @type {HTMLButtonElement} */ (el('button', 'vx-btn vx-btn--primary', 'Handeln'));
    btn.type = 'button';
    btn.addEventListener('click', (e) => this._guard('trade', () => {
      this._takeTrade(e.shiftKey === true ? MAX_BULK_TRADE : 1);
    }));
    this._tradeBtn = btn;
    this._side.appendChild(btn);
  }

  /**
   * The 27 main slots and the hotbar, present in every station window.
   * @returns {void}
   * @private
   */
  _buildBackpack() {
    const inv = this.playerInv;
    const section = el('div', 'vx-gui__section');
    section.appendChild(el('div', 'vx-gui__legend', 'Inventar'));
    const main = el('div', 'vx-grid vx-grid--inv');
    for (let i = SLOT.MAIN_START; i <= SLOT.MAIN_END; i++) {
      main.appendChild(this._makeCell(inv, i, 'normal'));
    }
    section.appendChild(main);
    const hotbar = el('div', 'vx-grid vx-grid--hotbar');
    for (let i = SLOT.HOTBAR_START; i <= SLOT.HOTBAR_END; i++) {
      hotbar.appendChild(this._makeCell(inv, i, 'hotbar'));
    }
    section.appendChild(hotbar);
    this._body.appendChild(section);
  }

  /**
   * Build the static "ingredients become result" arrow.
   * @returns {HTMLElement} the arrow element
   * @private
   */
  _makeArrow() {
    const wrap = el('div', 'vx-arrow');
    wrap.appendChild(svgIcon('', '0 0 40 20', [
      { d: 'M3 10h27M23 4l8 6-8 6', fill: 'none', stroke: 'currentColor', width: 2 },
    ]));
    return wrap;
  }

  /**
   * Create one slot view and register it.
   * @param {?Object} inv inventory the slot belongs to, `null` for a display
   *   cell that is never a drag target
   * @param {number} index slot index inside `inv`
   * @param {string} type `'normal'|'hotbar'|'anvil_out'|'static'`
   * @param {string} [ghost] ghost glyph key for the empty state
   * @returns {HTMLElement} the cell element
   * @private
   */
  _makeCell(inv, index, type, ghost) {
    const cell = el('div', 'vx-cell is-empty');
    if (type === 'anvil_out') cell.classList.add('is-result');
    cell.setAttribute('role', 'button');
    cell.tabIndex = -1;

    if (ghost) {
      const glyph = ghostGlyph(ghost);
      if (glyph !== null) cell.appendChild(glyph);
    }

    const item = el('div', 'vx-item');
    const img = /** @type {HTMLImageElement} */ (el('img', 'vx-item__icon'));
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.classList.add('is-hidden');
    const count = el('span', 'vx-item__count');
    const dura = el('div', 'vx-item__dura is-hidden');
    dura.appendChild(el('i'));
    item.appendChild(img);
    item.appendChild(count);
    item.appendChild(dura);
    cell.appendChild(item);

    /** @type {Object} */
    const view = {
      inv: inv || null,
      index: index | 0,
      type,
      stack: null,
      el: cell,
      item,
      img,
      count,
      dura,
      cId: -1,
      cCount: -1,
      cDur: -2,
      cEnch: false,
      cIcon: false,
    };
    cell.__vxSlot = view;
    this._slots.push(view);
    if (inv) {
      let map = this._byInv.get(inv);
      if (map === undefined) {
        map = new Map();
        this._byInv.set(inv, map);
      }
      map.set(view.index, view);
    }
    this._dirty.add(view);
    return cell;
  }

  /* ====================================================================== */
  /* Painting                                                               */
  /* ====================================================================== */

  /**
   * Repaint every mounted slot plus the cursor ghost.
   * @returns {void}
   * @private
   */
  _refreshAll() {
    for (let i = 0; i < this._slots.length; i++) this._paintSlot(this._slots[i]);
    this._dirty.clear();
    this._paintDrag();
  }

  /**
   * Repaint the slots marked dirty since the previous frame.
   * @returns {void}
   * @private
   */
  _flushDirty() {
    if (this._dirty.size === 0) return;
    for (const view of this._dirty) this._paintSlot(view);
    this._dirty.clear();
  }

  /**
   * The stack a slot view shows: from its inventory, or the fixed stack of a
   * display-only cell.
   * @param {Object} view slot view
   * @returns {?ItemStack} the stack, or `null`
   * @private
   */
  _stackOf(view) {
    if (view.inv !== null && typeof view.inv.get === 'function') return view.inv.get(view.index);
    return view.stack;
  }

  /**
   * Write one slot to the DOM, but only the parts that actually changed.
   * @param {Object} view slot view
   * @returns {void}
   * @private
   */
  _paintSlot(view) {
    const stack = this._stackOf(view);
    const id = stack === null || stack === undefined ? 0 : stack.itemId;
    const count = stack === null || stack === undefined ? 0 : stack.count;
    const maxDur = id > 0 ? itemDurability(id) : 0;
    const dur = (stack !== null && stack !== undefined && maxDur > 0) ? stack.durability : -1;
    let ench = false;
    if (stack !== null && stack !== undefined && typeof stack.isEnchanted === 'function') {
      ench = stack.isEnchanted() === true;
    }

    if (view.cId === id && view.cCount === count && view.cDur === dur
      && view.cEnch === ench && view.cIcon) {
      return;
    }

    if (view.cId !== id || !view.cIcon) {
      const url = itemIconURL(id);
      if (url === null) {
        view.img.classList.add('is-hidden');
        view.img.removeAttribute('src');
        view.cIcon = id <= 0;
      } else {
        view.img.src = url;
        view.img.classList.remove('is-hidden');
        view.cIcon = true;
      }
      view.img.alt = id > 0 ? itemDisplay(id) : '';
    }

    setText(view.count, count > 1 ? String(count) : '');
    setClass(view.el, 'is-empty', id <= 0);
    setClass(view.item, 'vx-item--glint', ench);

    if (dur >= 0 && maxDur > 0 && dur < maxDur) {
      view.dura.classList.remove('is-hidden');
      view.dura.style.setProperty('--d', (dur / maxDur).toFixed(3));
    } else {
      view.dura.classList.add('is-hidden');
    }

    view.cId = id;
    view.cCount = count;
    view.cDur = dur;
    view.cEnch = ench;
  }

  /**
   * Keep the frame around the selected hotbar slot in sync.
   * @returns {void}
   * @private
   */
  _syncSelection() {
    const inv = this.playerInv;
    if (inv === null || !Number.isFinite(inv.selected)) return;
    const map = this._byInv.get(inv);
    if (map === undefined) return;
    const view = map.get(SLOT.HOTBAR_START + (inv.selected | 0));
    const next = view === undefined ? null : view.el;
    if (next === this._selCell) return;
    setClass(this._selCell, 'is-selected', false);
    this._selCell = next;
    setClass(next, 'is-selected', true);
  }

  /**
   * Keep the experience-level badge in the header in sync.
   * @returns {void}
   * @private
   */
  _syncLevelBadge() {
    const player = this.game && this.game.player;
    const level = player ? Math.max(0, Math.floor(num(player.xpLevel, 0))) : 0;
    if (level === this._lastLevel) return;
    this._lastLevel = level;
    setText(this._levelBadge, `Stufe ${level}`);
  }

  /**
   * Update the stack that follows the cursor.
   * @returns {void}
   * @private
   */
  _paintDrag() {
    const stack = this.held;
    if (stack === null || stack.isEmpty()) {
      setClass(this._dragEl, 'is-hidden', true);
      this._dragEl.__vxId = -1;
      return;
    }
    setClass(this._dragEl, 'is-hidden', false);
    setClass(this._tip, 'is-on', false);
    if (this._dragEl.__vxId !== stack.itemId) {
      const url = itemIconURL(stack.itemId);
      if (url === null) {
        this._dragImg.classList.add('is-hidden');
      } else {
        this._dragImg.src = url;
        this._dragImg.classList.remove('is-hidden');
        this._dragEl.__vxId = stack.itemId;
      }
    }
    setText(this._dragCount, stack.count > 1 ? String(stack.count) : '');
    this._dragEl.style.left = `${this._px}px`;
    this._dragEl.style.top = `${this._py}px`;
  }

  /* ====================================================================== */
  /* Event wiring                                                           */
  /* ====================================================================== */

  /**
   * Subscribe to the inventories and block entities currently shown.
   * @returns {void}
   * @private
   */
  _subscribe() {
    for (const inv of this._byInv.keys()) {
      if (!inv || typeof inv.on !== 'function') continue;
      const handler = (index) => {
        const map = this._byInv.get(inv);
        if (map === undefined) return;
        const view = map.get(index | 0);
        if (view !== undefined) this._dirty.add(view);
        if (inv === this.playerInv) this._tradeDirty = true;
        if (inv === this.container) this._onStationChanged();
      };
      inv.on('change', handler);
      this._unsub.push(() => {
        if (typeof inv.off === 'function') inv.off('change', handler);
      });
    }

    const table = this.table;
    if (table !== null && typeof table.on === 'function') {
      const onOffers = () => { this._enchDirty = true; };
      table.on('offers', onOffers);
      this._unsub.push(() => {
        if (typeof table.off === 'function') table.off('offers', onOffers);
      });
    }
    const anvil = this.anvil;
    if (anvil !== null && typeof anvil.on === 'function') {
      const onResult = () => { this._anvilDirty = true; };
      anvil.on('result', onResult);
      this._unsub.push(() => {
        if (typeof anvil.off === 'function') anvil.off('result', onResult);
      });
    }
    const stand = this.stand;
    if (stand !== null && typeof stand.on === 'function') {
      const onBrewing = () => { this._brewVersion = -1; };
      stand.on('brewing', onBrewing);
      this._unsub.push(() => {
        if (typeof stand.off === 'function') stand.off('brewing', onBrewing);
      });
    }
  }

  /**
   * Drop every subscription.
   * @returns {void}
   * @private
   */
  _unsubscribe() {
    for (let i = 0; i < this._unsub.length; i++) {
      try { this._unsub[i](); } catch (err) { warnOnce('unsub', 'listener teardown failed.', err); }
    }
    this._unsub.length = 0;
  }

  /**
   * A slot of the open station changed: invalidate the derived readouts.
   * @returns {void}
   * @private
   */
  _onStationChanged() {
    if (this._kind === 'enchanting') this._enchDirty = true;
    else if (this._kind === 'anvil') this._anvilDirty = true;
    else if (this._kind === 'brewing') this._brewVersion = -1;
  }

  /* ====================================================================== */
  /* Pointer interaction                                                    */
  /* ====================================================================== */

  /**
   * Find the slot view under an event target.
   * @param {?EventTarget} target the event target
   * @returns {?Object} the slot view, or `null`
   * @private
   */
  _slotOf(target) {
    const node = /** @type {?Element} */ (target);
    if (node === null || typeof node.closest !== 'function') return null;
    const cell = node.closest('.vx-cell');
    if (cell === null) return null;
    const view = cell.__vxSlot;
    return view === undefined ? null : view;
  }

  /**
   * Find the index of the offer row under an event target.
   * @param {?EventTarget} target the event target
   * @returns {number} the offer index, or `-1`
   * @private
   */
  _offerOf(target) {
    const node = /** @type {?Element} */ (target);
    if (node === null || typeof node.closest !== 'function') return -1;
    const row = node.closest('.vx-offer');
    if (row === null || row.__vxOffer === undefined) return -1;
    return row.__vxOffer | 0;
  }

  /**
   * Find the index of the trade row under an event target.
   * @param {?EventTarget} target the event target
   * @returns {number} the trade index, or `-1`
   * @private
   */
  _tradeOf(target) {
    const node = /** @type {?Element} */ (target);
    if (node === null || typeof node.closest !== 'function') return -1;
    const row = node.closest('.vx-trade');
    if (row === null || row.__vxTrade === undefined) return -1;
    return row.__vxTrade | 0;
  }

  /**
   * Pointer down: pick up, place, split, buy an offer or select a trade.
   * @param {PointerEvent} e the event
   * @returns {void}
   * @private
   */
  _handleDown(e) {
    if (!this._open) return;
    this._px = e.clientX;
    this._py = e.clientY;

    const node = /** @type {?Element} */ (e.target);
    if (node !== null && typeof node.closest === 'function'
      && node.closest('input, button, textarea') !== null) {
      return;
    }

    const offer = this._offerOf(e.target);
    if (offer >= 0) {
      e.preventDefault();
      this._buyOffer(offer);
      return;
    }

    const trade = this._tradeOf(e.target);
    if (trade >= 0) {
      e.preventDefault();
      this._selectTrade(trade, e.shiftKey === true);
      return;
    }

    const view = this._slotOf(e.target);
    if (view === null) {
      const inWindow = this.win.contains(/** @type {Node} */ (e.target))
        || this._side.contains(/** @type {Node} */ (e.target));
      if (!inWindow && this.held !== null) {
        e.preventDefault();
        this._throwHeld(e.button !== 2);
      }
      return;
    }
    e.preventDefault();

    if (e.button !== 0 && e.button !== 2) return;

    if (this.held !== null && !this.held.isEmpty()) {
      this._paint = { button: e.button, views: [view] };
      return;
    }
    if (e.shiftKey && e.button === 0) {
      this._quickMove(view);
      return;
    }
    this._pickUp(view, e.button === 2, e.shiftKey);
  }

  /**
   * Pointer move: track the cursor, extend a distribution drag, update the
   * hover tooltip.
   * @param {PointerEvent} e the event
   * @returns {void}
   * @private
   */
  _handleMove(e) {
    if (!this._open) return;
    this._px = e.clientX;
    this._py = e.clientY;

    if (this.held !== null) {
      this._dragEl.style.left = `${this._px}px`;
      this._dragEl.style.top = `${this._py}px`;
    }

    const view = this._slotOf(e.target);
    if (this._paint !== null && view !== null && this._paint.views.indexOf(view) === -1) {
      if (this._canAccept(view, this.held)) this._paint.views.push(view);
    }

    if (view !== this._hover) {
      this._hover = view;
      this._showTooltip(view);
    } else if (view !== null && this._tip.classList.contains('is-on')) {
      this._positionTooltip();
    }
  }

  /**
   * Pointer up: finish a click or apply the distribution.
   * @param {PointerEvent} e the event
   * @returns {void}
   * @private
   */
  _handleUp(e) {
    if (!this._open) return;
    const paint = this._paint;
    if (paint === null) return;
    if (e.button !== paint.button) return;
    this._paint = null;
    e.preventDefault();

    if (paint.views.length > 1) {
      this._distribute(paint.views, paint.button === 2);
      return;
    }
    const node = /** @type {?Node} */ (e.target);
    const inside = node !== null
      && (this.win.contains(node) || this._side.contains(node));
    if (!inside) {
      this._throwHeld(paint.button !== 2);
      return;
    }
    this._place(paint.views[0], paint.button === 2, e.shiftKey);
  }

  /**
   * Escape and the inventory key close the screen.
   * @param {KeyboardEvent} e the event
   * @returns {void}
   * @private
   */
  _handleKey(e) {
    if (!this._open) return;
    const code = e.code;
    if (code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active !== null && active === this._nameInput) {
      if (code === 'Enter' || code === 'NumpadEnter') {
        e.preventDefault();
        e.stopPropagation();
        this._nameInput.blur();
      }
      return;
    }
    let closeCode = 'KeyE';
    const input = this.game && this.game.input;
    if (input && typeof input.getBinding === 'function') {
      const bound = input.getBinding('inventory');
      if (typeof bound === 'string' && bound.length > 0 && !bound.startsWith('Mouse')) {
        closeCode = bound;
      }
    }
    if (code === closeCode) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  /* ====================================================================== */
  /* Slot operations                                                        */
  /* ====================================================================== */

  /**
   * May a stack be placed into a slot right now?
   * @param {Object} view slot view
   * @param {?ItemStack} stack candidate stack
   * @returns {boolean} true when the slot accepts it
   * @private
   */
  _canAccept(view, stack) {
    if (stack === null || stack.isEmpty()) return false;
    if (view.type === 'anvil_out' || view.type === 'static') return false;
    const inv = view.inv;
    if (inv === null) return false;
    if (typeof inv.canPlaceIn === 'function' && !inv.canPlaceIn(view.index, stack)) return false;
    const cur = inv.get(view.index);
    if (cur === null) return true;
    return cur.canStackWith(stack);
  }

  /**
   * Take a stack (or half of it) onto the cursor.
   * @param {Object} view slot view
   * @param {boolean} half take only half
   * @param {boolean} shift shift held
   * @returns {void}
   * @private
   */
  _pickUp(view, half, shift) {
    if (view.type === 'static') return;
    if (view.type === 'anvil_out') {
      this._takeAnvilResult(shift);
      return;
    }
    const inv = view.inv;
    if (inv === null) return;
    const stack = inv.get(view.index);
    if (stack === null) return;

    const taken = half ? inv.takeHalf(view.index) : inv.take(view.index);
    if (taken === null) return;
    this.held = taken;
    this._paintDrag();
    this._playUI('click');
  }

  /**
   * Put the cursor stack (or one item of it) into a slot; swap when the slot
   * holds a different item.
   * @param {Object} view slot view
   * @param {boolean} single place a single item only
   * @param {boolean} shift shift held while releasing
   * @returns {void}
   * @private
   */
  _place(view, single, shift) {
    const held = this.held;
    if (held === null || held.isEmpty()) return;
    if (view.type === 'anvil_out' || view.type === 'static') return;
    const inv = view.inv;
    if (inv === null) return;
    if (typeof inv.canPlaceIn === 'function' && !inv.canPlaceIn(view.index, held)) return;

    const cur = inv.get(view.index);
    const limit = typeof inv.slotLimit === 'function'
      ? inv.slotLimit(view.index, held)
      : itemStackSize(held.itemId);

    if (cur !== null && !cur.canStackWith(held)) {
      if (single) return;
      if (held.count > limit) return;
      inv.set(view.index, held);
      this.held = cur;
      this._paintDrag();
      this._playUI('click');
      return;
    }

    const space = limit - (cur === null ? 0 : cur.count);
    if (space <= 0) return;
    const move = single ? Math.min(1, space) : Math.min(space, held.count);
    if (move <= 0) return;

    const part = new ItemStack(held.itemId, move, cloneMeta(held.meta));
    const leftover = inv.addAt(view.index, part);
    const placed = move - (leftover === null ? 0 : leftover.count);
    if (placed <= 0) return;
    held.count -= placed;
    if (held.count <= 0) this.held = null;
    this._paintDrag();
    if (shift) this._playUI('click');
  }

  /**
   * Spread the cursor stack over every slot the drag touched.
   * @param {Array<Object>} views slots visited by the drag
   * @param {boolean} single right-button drag
   * @returns {void}
   * @private
   */
  _distribute(views, single) {
    const held = this.held;
    if (held === null || held.isEmpty()) return;

    /** @type {Array<Object>} */
    const targets = [];
    for (let i = 0; i < views.length; i++) {
      if (this._canAccept(views[i], held)) targets.push(views[i]);
    }
    if (targets.length === 0) return;

    const each = single ? 1 : Math.max(1, Math.floor(held.count / targets.length));
    let remaining = held.count;
    for (let i = 0; i < targets.length && remaining > 0; i++) {
      const view = targets[i];
      const give = Math.min(each, remaining);
      const part = new ItemStack(held.itemId, give, cloneMeta(held.meta));
      const leftover = view.inv.addAt(view.index, part);
      remaining -= give - (leftover === null ? 0 : leftover.count);
    }
    if (remaining <= 0) this.held = null;
    else held.count = remaining;
    this._paintDrag();
    this._playUI('click');
  }

  /**
   * Shift-click: move a stack between the player and the station.
   * @param {Object} view the clicked slot
   * @returns {void}
   * @private
   */
  _quickMove(view) {
    if (view.type === 'static') return;
    if (view.type === 'anvil_out') {
      this._takeAnvilResult(true);
      return;
    }
    const inv = view.inv;
    if (inv === null) return;
    const stack = inv.get(view.index);
    if (stack === null) return;

    const player = this.playerInv;
    const container = this.container;

    if (inv !== player) {
      const moved = this._moveInto(inv, view.index, (part) => this._addToPlayer(part));
      if (moved > 0) this._playUI('click');
      return;
    }

    if (container !== null) {
      const moved = this._moveInto(inv, view.index, (part) => {
        if (typeof container.quickInsert === 'function') return container.quickInsert(part);
        return container.add(part);
      });
      if (moved > 0) this._playUI('click');
      return;
    }

    const toHotbar = view.index >= SLOT.MAIN_START && view.index <= SLOT.MAIN_END;
    const from = toHotbar ? SLOT.HOTBAR_START : SLOT.MAIN_START;
    const to = toHotbar ? SLOT.HOTBAR_END : SLOT.MAIN_END;
    const moved = this._moveInto(player, view.index, (part) => player.add(part, from, to));
    if (moved > 0) this._playUI('click');
  }

  /**
   * Hand the contents of one slot to an insertion function and remove whatever
   * was accepted.
   * @param {Object} inv source inventory
   * @param {number} index source slot
   * @param {function(ItemStack):?ItemStack} insert insertion function
   * @returns {number} how many items were moved
   * @private
   */
  _moveInto(inv, index, insert) {
    const stack = inv.get(index);
    if (stack === null) return 0;
    const before = stack.count;
    const leftover = insert(stack);
    const moved = before - (leftover === null || leftover === undefined ? 0 : leftover.count);
    if (moved <= 0) return 0;
    inv.remove(index, moved);
    return moved;
  }

  /**
   * Insert a stack into the player's storage: main slots first, hotbar second.
   * @param {ItemStack} stack stack to insert (not mutated)
   * @param {boolean} [hotbarFirst] fill the hotbar first instead
   * @returns {?ItemStack} what did not fit
   * @private
   */
  _addToPlayer(stack, hotbarFirst) {
    const player = this.playerInv;
    if (player === null) return stack;
    const first = hotbarFirst
      ? player.add(stack, SLOT.HOTBAR_START, SLOT.HOTBAR_END)
      : player.add(stack, SLOT.MAIN_START, SLOT.MAIN_END);
    if (first === null) return null;
    return hotbarFirst
      ? player.add(first, SLOT.MAIN_START, SLOT.MAIN_END)
      : player.add(first, SLOT.HOTBAR_START, SLOT.HOTBAR_END);
  }

  /* ====================================================================== */
  /* Station refresh                                                        */
  /* ====================================================================== */

  /**
   * Give the station one nudge right after it was opened: rescan bookshelves,
   * recompute an anvil preview, mirror an existing rename.
   * @returns {void}
   * @private
   */
  _primeStation() {
    if (this._kind === 'enchanting' && this.table !== null) {
      const manager = this._enchantManager();
      if (manager !== null && typeof manager.rescanTable === 'function') {
        try { manager.rescanTable(this.table); } catch (err) {
          warnOnce('rescan', 'the bookshelf rescan failed.', err);
        }
      }
      if (typeof this.table.refresh === 'function') {
        try { this.table.refresh(); } catch (err) {
          warnOnce('trefresh', 'the table could not roll its offers.', err);
        }
      }
    } else if (this._kind === 'anvil' && this.anvil !== null) {
      if (this._nameInput !== null) {
        const name = typeof this.anvil.itemName === 'string' ? this.anvil.itemName : '';
        if (this._nameInput.value !== name) this._nameInput.value = name;
      }
      if (typeof this.anvil.refresh === 'function') {
        try { this.anvil.refresh(); } catch (err) {
          warnOnce('arefresh', 'the anvil preview failed.', err);
        }
      }
    } else if (this._kind === 'trading' && this.session !== null) {
      if (typeof this.session.refresh === 'function') {
        try { this.session.refresh(); } catch (err) {
          warnOnce('srefresh', 'the trading session could not refresh.', err);
        }
      }
    }
  }

  /**
   * Run the readout refresh of the active station.
   * @param {boolean} force refresh even when nothing looks changed
   * @returns {void}
   * @private
   */
  _refreshStation(force) {
    if (this._kind === 'enchanting') this._refreshEnchanting(force);
    else if (this._kind === 'anvil') this._refreshAnvil(force);
    else if (this._kind === 'brewing') this._refreshBrewing(force);
    else this._refreshTrading(force);
  }

  /* -- enchanting ---------------------------------------------------------- */

  /**
   * The enchanting manager, when the game wired one up.
   * @returns {?Object} the manager, or `null`
   * @private
   */
  _enchantManager() {
    const game = this.game;
    if (!game) return null;
    const direct = game.enchanting || game.enchantingManager || null;
    if (direct && typeof direct.enchant === 'function') return direct;
    return null;
  }

  /**
   * Repaint the offer rows and the bookshelf power.
   *
   * The change detection is deliberately allocation-free: the table announces
   * a new offer list through its `'offers'` event, and everything else that
   * can move a row between "affordable" and "too expensive" — the bookshelf
   * count, the player's levels, the lapis on the table — is a plain number
   * that can be compared without building a signature string every frame.
   *
   * @param {boolean} force refresh even when nothing looks changed
   * @returns {void}
   * @private
   */
  _refreshEnchanting(force) {
    const table = this.table;
    if (table === null) return;
    const player = this.game && this.game.player;
    const levels = player ? Math.max(0, Math.floor(num(player.xpLevel, 0))) : 0;
    const shelves = clamp(Math.round(num(table.bookshelves, 0)), 0, MAX_BOOKSHELVES);
    const offers = Array.isArray(table.offers) ? table.offers : [];
    const lapis = num(table.lapis, 0);

    const dirty = force || this._enchDirty || shelves !== this._eShelves
      || levels !== this._eLevels || lapis !== this._eLapis;
    if (!dirty) return;
    this._enchDirty = false;
    this._eShelves = shelves;
    this._eLevels = levels;
    this._eLapis = lapis;

    setText(this._powerValue, String(shelves));

    for (let i = 0; i < this._offerRows.length; i++) {
      const row = this._offerRows[i];
      const offer = offers[i];
      if (offer === undefined) {
        setClass(row.el, 'is-hidden', true);
        continue;
      }
      setClass(row.el, 'is-hidden', false);
      setText(row.level, String(offer.level));
      setText(row.glyphs, fakeGlyphLine(table.seed, offer.slot));

      const list = Array.isArray(offer.enchantments) ? offer.enchantments : [];
      const first = list.length > 0 ? describeEnchantments([list[0]]) : '';
      const more = list.length > 1 ? ' …?' : '';
      setText(row.reveal, first.length > 0 ? `${first}${more}` : 'Unbekannte Verzauberung');

      const check = this._affordOffer(i);
      const cost = `${offer.lapis} Lapislazuli · ${offer.level} Stufen`;
      setText(row.cost, check.ok ? cost : `${cost} — ${check.reason}`);
      setClass(row.el, 'is-disabled', !check.ok);
      row.el.title = check.ok ? 'Verzaubern' : check.reason;
    }

    const hasItem = table.item !== null && table.item !== undefined;
    setClass(this._enchEmpty, 'is-hidden', offers.length > 0);
    if (offers.length === 0) {
      setText(this._enchEmpty, hasItem
        ? 'Dieser Gegenstand lässt sich nicht verzaubern.'
        : 'Lege einen verzauberbaren Gegenstand und Lapislazuli ein. '
          + 'Bücherregale rund um den Tisch heben die Stufen.');
    }
  }

  /**
   * Whether the player can pay for an offer, with a German reason.
   * @param {number} index offer index
   * @returns {{ok:boolean, reason:string}} the verdict
   * @private
   */
  _affordOffer(index) {
    const table = this.table;
    if (table === null) return { ok: false, reason: 'Kein Zaubertisch' };
    const player = this.game && this.game.player;
    if (typeof table.canAfford === 'function') {
      try {
        const check = table.canAfford(index, player || null);
        if (check && typeof check.ok === 'boolean') return check;
      } catch (err) {
        warnOnce('afford', 'canAfford() failed on the enchanting table.', err);
      }
    }
    return { ok: false, reason: 'Nicht verfügbar' };
  }

  /**
   * Buy one offer.
   * @param {number} index offer index `0..2`
   * @returns {void}
   * @private
   */
  _buyOffer(index) {
    const table = this.table;
    if (table === null) return;
    const player = this.game && this.game.player;
    const check = this._affordOffer(index);
    if (!check.ok) {
      this._message(check.reason);
      this._playUI('ui_error');
      return;
    }
    let result = null;
    const manager = this._enchantManager();
    try {
      result = manager !== null
        ? manager.enchant(table, index, player || null)
        : table.enchant(index, player || null);
    } catch (err) {
      warnOnce('enchant', 'the enchantment could not be applied.', err);
      this._playUI('ui_error');
      return;
    }
    if (result === null || result === undefined || result.ok !== true) {
      this._message(result && result.message ? result.message : 'Verzaubern nicht möglich');
      this._playUI('ui_error');
      return;
    }
    this._enchDirty = true;
    this._lastLevel = -1;
    this._message(result.message || 'Verzaubert');
    if (manager === null) this._playUI('enchanting');
    this._refreshEnchanting(true);
  }

  /* -- anvil --------------------------------------------------------------- */

  /**
   * Push the rename field into the anvil.
   * @returns {void}
   * @private
   */
  _applyName() {
    const anvil = this.anvil;
    if (anvil === null || this._nameInput === null) return;
    const value = this._nameInput.value;
    if (typeof anvil.setName !== 'function') return;
    anvil.setName(value.length === 0 ? null : value);
    this._anvilDirty = true;
    this._refreshAnvil(true);
  }

  /**
   * Repaint the anvil cost line and its explanation. Like the enchanting
   * refresh this compares plain fields instead of building a signature string
   * on every frame.
   * @param {boolean} force refresh even when nothing looks changed
   * @returns {void}
   * @private
   */
  _refreshAnvil(force) {
    const anvil = this.anvil;
    if (anvil === null) return;
    const cost = Math.max(0, Math.round(num(anvil.cost, 0)));
    const tooMuch = anvil.tooExpensive === true;
    const message = typeof anvil.message === 'string' ? anvil.message : '';
    const player = this.game && this.game.player;
    const levels = player ? Math.max(0, Math.floor(num(player.xpLevel, 0))) : 0;
    const creative = player !== null && player !== undefined && player.gameMode === 'creative';
    const result = typeof anvil.get === 'function' ? anvil.get(ANVIL_SLOT.RESULT) : null;

    const resultId = result === null || result === undefined ? 0 : result.itemId;
    const dirty = force || this._anvilDirty || cost !== this._aCost
      || tooMuch !== this._aTooMuch || levels !== this._aLevels
      || resultId !== this._aResult || message !== this._aMessage;
    if (!dirty) return;
    this._anvilDirty = false;
    this._aCost = cost;
    this._aTooMuch = tooMuch;
    this._aLevels = levels;
    this._aResult = resultId;
    this._aMessage = message;

    if (tooMuch) {
      setText(this._costValue, 'Zu teuer!');
      setClass(this._costNode, 'is-bad', true);
    } else {
      setText(this._costValue, `${cost} ${cost === 1 ? 'Stufe' : 'Stufen'}`);
      setClass(this._costNode, 'is-bad', !creative && cost > 0 && levels < cost);
    }

    let note = message;
    if (tooMuch) {
      note = `Die Reparaturkosten haben ${ANVIL_LEVEL_LIMIT} Stufen erreicht. `
        + 'Nutze einen frischeren Gegenstand.';
    } else if (result !== null && !creative && cost > levels) {
      note = `Du brauchst ${cost} Erfahrungsstufen, hast aber nur ${levels}.`;
    } else if (result !== null) {
      note = 'Klicke das Ergebnis an, um es zu schmieden.';
    } else if (note.length === 0) {
      note = 'Lege links den Gegenstand und rechts Material, ein gleiches Werkzeug '
        + 'oder ein verzaubertes Buch ein.';
    }
    setText(this._anvilNote, note);
  }

  /**
   * Take the anvil result: pay the levels and hand the item over.
   * @param {boolean} toInventory put the result straight into the inventory
   * @returns {void}
   * @private
   */
  _takeAnvilResult(toInventory) {
    const anvil = this.anvil;
    if (anvil === null || typeof anvil.takeResult !== 'function') return;
    const player = this.game && this.game.player;
    let result = null;
    try {
      result = anvil.takeResult(player || null);
    } catch (err) {
      warnOnce('takeresult', 'the anvil could not hand over its result.', err);
      return;
    }
    if (result === null || result.ok !== true || result.stack === null) {
      this._message(result && result.message ? result.message : 'Nicht kombinierbar');
      this._playUI('ui_error');
      return;
    }
    if (toInventory || (this.held !== null && !this.held.isEmpty())) {
      const rest = this._addToPlayer(result.stack);
      if (rest !== null) this._dropStack(rest);
    } else {
      this.held = result.stack;
      this._paintDrag();
    }
    if (this._nameInput !== null) this._nameInput.value = '';
    this._lastLevel = -1;
    this._anvilDirty = true;
    this._playUI('anvil');
    this._refreshAnvil(true);
  }

  /* -- brewing ------------------------------------------------------------- */

  /**
   * Repaint the fuel gauge, the bubbles, the arrow and the potion names.
   * @param {boolean} force refresh even when nothing looks changed
   * @returns {void}
   * @private
   */
  _refreshBrewing(force) {
    const stand = this.stand;
    if (stand === null) return;

    const progress = clamp(num(stand.progress, 0), 0, 1);
    const fuel = clamp(num(stand.fuelProgress, 0), 0, 1);
    setVar(this._brewArrow, '--p', progress);
    setVar(this._fuelFill, '--f', fuel);
    setClass(this._bubbles, 'is-on', stand.brewing === true);

    const uses = Math.max(0, Math.round(num(stand.fuel, 0)));
    if (uses !== this._brewFuelUses) {
      this._brewFuelUses = uses;
      setText(this._fuelText, uses === 1 ? '1 Brauvorgang' : `${uses} Brauvorgänge`);
    }

    // The potion names only move when a slot moves, which bumps the
    // inventory's version counter. The timer is a cheap safety net for a stand
    // that was mutated without one.
    const version = num(stand.version, 0);
    if (!force && version === this._brewVersion && this._brewTimer > 0) return;
    this._brewTimer = BREW_INTERVAL;
    this._brewVersion = version;

    const ingredient = typeof stand.get === 'function' ? stand.get(BREW_SLOT.INGREDIENT) : null;
    const ingredientId = (ingredient === null || ingredient === undefined) ? 0 : ingredient.itemId;

    for (let i = 0; i < this._brewRows.length; i++) {
      const row = this._brewRows[i];
      const bottle = typeof stand.get === 'function' ? stand.get(BREW_SLOT.BOTTLE_0 + i) : null;
      let state = null;
      try {
        state = readPotion(bottle);
      } catch (err) {
        warnOnce('readpotion', 'a bottle could not be decoded.', err);
      }

      if (bottle === null || bottle === undefined) {
        this._paintBrewRow(row, '—', null, 'rgba(255,255,255,0.12)');
        continue;
      }
      const current = state === null
        ? 'Leere Flasche'
        : potionDisplayName(state.potion, state.variant, state.kind);
      const color = state === null ? 'rgba(255,255,255,0.18)' : potionColor(state);

      let next = null;
      if (state !== null && ingredientId > 0) {
        try {
          next = brewResult(state, ingredientId);
        } catch (err) {
          warnOnce('brewresult', 'a brewing step could not be resolved.', err);
        }
      }
      const name = next === null
        ? null : potionDisplayName(next.potion, next.variant, next.kind);
      this._paintBrewRow(row, current, name, color);
    }
  }

  /**
   * Write one potion readout row, skipping the DOM entirely when neither the
   * current potion nor the brew result changed.
   * @param {Object} row the readout row
   * @param {string} current German name of what is in the bottle
   * @param {?string} next German name of what it becomes, or `null`
   * @param {string} color CSS colour of the potion dot
   * @returns {void}
   * @private
   */
  _paintBrewRow(row, current, next, color) {
    if (row.cColor !== color) {
      row.cColor = color;
      row.dot.style.setProperty('--c', color);
    }
    if (row.cCurrent === current && row.cNext === next) return;
    row.cCurrent = current;
    row.cNext = next;
    if (next === null) {
      row.text.textContent = current;
    } else {
      row.text.textContent = '';
      row.text.appendChild(document.createTextNode(`${current} → `));
      row.text.appendChild(el('em', '', next));
    }
    row.text.__vxText = undefined;
  }

  /* -- trading ------------------------------------------------------------- */

  /**
   * Repaint the trade list, the header and the detail panel.
   * @param {boolean} force refresh even when nothing looks changed
   * @returns {void}
   * @private
   */
  _refreshTrading(force) {
    const session = this.session;
    if (session === null) return;
    if (!force && !this._tradeDirty && this._tradeTimer > 0) return;
    this._tradeTimer = TRADE_INTERVAL;
    this._tradeDirty = false;

    /** @type {Array<Object>} */
    let views = [];
    try {
      views = typeof session.refresh === 'function' ? session.refresh() : (session.offers || []);
    } catch (err) {
      warnOnce('trefreshv', 'the trading session could not refresh.', err);
      views = Array.isArray(session.views) ? session.views : [];
    }
    if (!Array.isArray(views)) views = [];

    const data = session.data || null;
    const profession = data !== null ? professionLabel(data.profession) : 'Dorfbewohner';
    const level = Math.max(1, Math.min(MAX_TRADE_LEVEL, num(session.level, 1) | 0));
    setText(this._tradeWho, profession);
    setText(this._tradeLevel, levelLabel(level));
    setVar(this._tradeXpFill, '--v', clamp(num(session.xpProgress, 0), 0, 1));
    const xp = Math.max(0, num(session.xp, 0) | 0);
    const next = Math.max(0, num(session.xpForNext, 0) | 0);
    setText(this._tradeXpText, level >= MAX_TRADE_LEVEL ? `${xp} XP` : `${xp} / ${next} XP`);

    let sig = '';
    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      sig += `${v.priceItem}:${v.resultItem}:${v.resultCount}:`;
      sig += `${v.second === null ? 0 : v.second.itemId}x${v.second === null ? 0 : v.second.count}:`;
      sig += `${v.enchant === null ? '' : v.enchant.label};`;
    }
    if (sig !== this._tradeSig) {
      this._tradeSig = sig;
      this._buildTradeRows(views);
    }

    const selected = Math.max(0, num(session.selectedIndex, 0) | 0);
    for (let i = 0; i < this._tradeRows.length; i++) {
      const row = this._tradeRows[i];
      const v = views[i];
      if (v === undefined) {
        setClass(row.el, 'is-hidden', true);
        continue;
      }
      setClass(row.el, 'is-hidden', false);
      setClass(row.el, 'is-selected', i === selected);
      const blocked = v.outOfStock === true || v.affordable !== true;
      setClass(row.el, 'is-disabled', blocked);
      setClass(row.stock, 'is-hidden', v.outOfStock !== true);
      const left = Math.max(0, v.maxUses - v.uses);
      if (row.cLeft !== left) {
        row.cLeft = left;
        setText(row.uses, `${left} / ${v.maxUses}`);
      }
      if (row.priceView.cCount !== v.price || row.priceView.cId !== v.priceItem) {
        row.priceView.stack = this._displayStack(v.priceItem, v.price, null);
        this._dirty.add(row.priceView);
      }
    }

    setClass(this._tradeEmpty, 'is-hidden', views.length > 0);
    this._refreshTradeDetail(views, selected);
    this._flushDirty();
  }

  /**
   * Rebuild the trade rows from scratch.
   * @param {Array<Object>} views the offer views
   * @returns {void}
   * @private
   */
  _buildTradeRows(views) {
    if (this._tradeList === null) return;
    for (let i = 0; i < this._tradeRows.length; i++) {
      const row = this._tradeRows[i];
      const idx = this._slots.indexOf(row.priceView);
      if (idx >= 0) this._slots.splice(idx, 1);
      const idx2 = this._slots.indexOf(row.resultView);
      if (idx2 >= 0) this._slots.splice(idx2, 1);
      if (row.secondView !== null) {
        const idx3 = this._slots.indexOf(row.secondView);
        if (idx3 >= 0) this._slots.splice(idx3, 1);
      }
      this._dirty.delete(row.priceView);
      this._dirty.delete(row.resultView);
      if (row.secondView !== null) this._dirty.delete(row.secondView);
    }
    this._tradeRows.length = 0;
    this._tradeList.textContent = '';

    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      const rowEl = el('div', 'vx-trade');
      rowEl.setAttribute('role', 'button');
      rowEl.tabIndex = -1;
      rowEl.__vxTrade = i;

      const priceCell = this._makeCell(null, -1, 'static');
      const priceView = priceCell.__vxSlot;
      priceView.stack = this._displayStack(v.priceItem, v.price, null);
      rowEl.appendChild(priceCell);

      let secondView = null;
      if (v.second !== null && v.second !== undefined) {
        rowEl.appendChild(el('span', 'vx-anvil__plus', '+'));
        const secondCell = this._makeCell(null, -1, 'static');
        secondView = secondCell.__vxSlot;
        secondView.stack = this._displayStack(v.second.itemId, v.second.count, null);
        rowEl.appendChild(secondCell);
      }

      rowEl.appendChild(this._makeArrow());

      const resultCell = this._makeCell(null, -1, 'static');
      const resultView = resultCell.__vxSlot;
      resultView.stack = this._displayStack(v.resultItem, v.resultCount, v.enchant);
      rowEl.appendChild(resultCell);

      const stock = el('span', 'vx-badge vx-badge--warn is-hidden', 'Ausverkauft');
      rowEl.appendChild(stock);
      const uses = el('span', 'vx-trade__uses', '');
      rowEl.appendChild(uses);

      this._tradeList.appendChild(rowEl);
      this._tradeRows.push({
        el: rowEl, priceView, secondView, resultView, stock, uses, index: i,
      });
    }
  }

  /**
   * Build a display-only stack for a trade row.
   * @param {number} itemId item id
   * @param {number} count stack size
   * @param {?{id:string, level:number, label:string}} enchant enchantment shown on it
   * @returns {?ItemStack} the stack, or `null` for an unknown item
   * @private
   */
  _displayStack(itemId, count, enchant) {
    const id = itemId | 0;
    if (id <= 0) return null;
    try {
      const stack = new ItemStack(id, Math.max(1, count | 0), null);
      if (enchant !== null && enchant !== undefined && typeof enchant.id === 'string') {
        stack.addEnchantment(enchant.id, Math.max(1, enchant.level | 0));
      }
      return stack;
    } catch (err) {
      warnOnce('display', 'a trade preview stack could not be built.', err);
      return null;
    }
  }

  /**
   * Write the detail panel of the selected trade.
   * @param {Array<Object>} views the offer views
   * @param {number} index selected index
   * @returns {void}
   * @private
   */
  _refreshTradeDetail(views, index) {
    if (this._tradeDetail === null || this._tradeName === null) return;
    const v = views[index];
    this._tradeDetail.textContent = '';
    if (v === undefined) {
      setText(this._tradeName, '—');
      this._tradeDetail.appendChild(el('div', 'vx-station__empty',
        'Wähle links ein Angebot aus.'));
      if (this._tradeBtn !== null) {
        this._tradeBtn.disabled = true;
        setClass(this._tradeBtn, 'is-disabled', true);
      }
      return;
    }

    this._tradeName.textContent = v.text;
    this._tradeName.__vxText = undefined;

    this._detailRow('Preis', v.priceLabel);
    if (v.second !== null && v.second !== undefined) this._detailRow('Dazu', v.second.label);
    this._detailRow('Erhältst', v.resultLabel);
    if (v.enchant !== null && v.enchant !== undefined) {
      this._detailRow('Verzauberung', v.enchant.label);
    }
    this._detailRow('Vorrat', `${Math.max(0, v.maxUses - v.uses)} von ${v.maxUses}`);
    const session = this.session;
    if (session !== null) {
      const rep = Math.round(num(session.reputation, 0));
      this._detailRow('Ansehen', rep > 0 ? `+${rep}` : String(rep));
    }
    if (v.basePrice !== v.price) {
      this._detailRow('Grundpreis', `${v.basePrice}x ${itemDisplay(v.priceItem)}`);
    }

    let note = '';
    if (v.outOfStock === true) note = 'Ausverkauft — der Händler füllt später auf.';
    else if (v.affordable !== true) note = 'Du kannst diesen Preis gerade nicht bezahlen.';
    if (note.length > 0) {
      this._tradeDetail.appendChild(el('div', 'vx-station__empty', note));
    }

    if (this._tradeBtn !== null) {
      const blocked = v.outOfStock === true || v.affordable !== true;
      this._tradeBtn.disabled = blocked;
      setClass(this._tradeBtn, 'is-disabled', blocked);
      setText(this._tradeBtn, v.outOfStock === true ? 'Ausverkauft' : 'Handeln');
    }
  }

  /**
   * Append one label/value row to the trade detail panel.
   * @param {string} label German label
   * @param {string} value the value
   * @returns {void}
   * @private
   */
  _detailRow(label, value) {
    const row = el('div', 'vx-station__meta');
    row.appendChild(el('span', '', label));
    row.appendChild(el('span', 'vx-station__value', value));
    this._tradeDetail.appendChild(row);
  }

  /**
   * Select a trade row, optionally trading immediately.
   * @param {number} index trade index
   * @param {boolean} trade also execute the trade
   * @returns {void}
   * @private
   */
  _selectTrade(index, trade) {
    const session = this.session;
    if (session === null || typeof session.select !== 'function') return;
    if (!session.select(index)) return;
    this._tradeDirty = true;
    this._tradeTimer = 0;
    this._playUI('ui_select');
    if (trade) this._takeTrade(1);
    else this._refreshTrading(true);
  }

  /**
   * Execute the selected trade.
   * @param {number} count how many times to trade
   * @returns {void}
   * @private
   */
  _takeTrade(count) {
    const session = this.session;
    if (session === null || typeof session.takeTrade !== 'function') return;
    let result = null;
    try {
      result = session.takeTrade(Math.max(1, Math.min(MAX_BULK_TRADE, count | 0)));
    } catch (err) {
      warnOnce('taketrade', 'the trade could not be executed.', err);
      return;
    }
    this._tradeDirty = true;
    this._tradeTimer = 0;
    if (result === null || result === undefined || result.ok !== true) {
      this._message(result && result.message ? result.message : 'Handel nicht möglich');
      this._playUI('ui_error');
      this._refreshTrading(true);
      return;
    }
    const traded = Math.max(1, result.traded | 0);
    this._message(traded > 1 ? `${traded}x gehandelt.` : (result.message || 'Handel abgeschlossen.'));
    this._playUI('ui_select');
    this._refreshTrading(true);
  }

  /* ====================================================================== */
  /* Tooltips                                                               */
  /* ====================================================================== */

  /**
   * Show (or hide) the tooltip for a slot.
   * @param {?Object} view slot view under the cursor
   * @returns {void}
   * @private
   */
  _showTooltip(view) {
    if (this.held !== null && !this.held.isEmpty()) {
      setClass(this._tip, 'is-on', false);
      return;
    }
    const stack = view === null ? null : this._stackOf(view);
    if (stack === null || stack === undefined) {
      setClass(this._tip, 'is-on', false);
      return;
    }
    this._fillTooltip(stack);
    setClass(this._tip, 'is-on', true);
    this._positionTooltip();
  }

  /**
   * Write the tooltip body for a stack.
   * @param {ItemStack} stack the hovered stack
   * @returns {void}
   * @private
   */
  _fillTooltip(stack) {
    const id = stack.itemId;
    const def = getItem(id);
    setText(this._tipName, stack.displayName);
    const rarity = itemRarity(id);
    if (this._tipName.getAttribute('data-rarity') !== rarity) {
      this._tipName.setAttribute('data-rarity', rarity === RARITY.COMMON ? '' : rarity);
    }

    this._tipRows.textContent = '';

    if (stack.count > 1) this._tipRow('Anzahl', String(stack.count));
    const maxDur = itemDurability(id);
    if (maxDur > 0) this._tipRow('Haltbarkeit', `${stack.durability} / ${maxDur}`);

    const list = stack.enchantments;
    for (let i = 0; i < list.length; i++) {
      const label = describeEnchantments([list[i]]);
      this._tipRows.appendChild(el('div', 'vx-tooltip__ench', label));
    }
    if (stack.meta !== null && stack.meta !== undefined && Array.isArray(stack.meta.lore)) {
      for (let i = 0; i < stack.meta.lore.length; i++) {
        this._tipRows.appendChild(el('div', 'vx-tooltip__meta', stack.meta.lore[i]));
      }
    }

    let lore = itemTooltip(id);
    if (typeof lore !== 'string' || lore.length === 0) {
      lore = CATEGORY_LABELS[itemCategory(id)] || def.name;
    }
    setText(this._tipLore, lore);
  }

  /**
   * Append one label/value row to the tooltip.
   * @param {string} label German label
   * @param {string} value the value
   * @returns {void}
   * @private
   */
  _tipRow(label, value) {
    const row = el('div', 'vx-tooltip__row');
    row.appendChild(el('span', '', label));
    row.appendChild(el('b', '', value));
    this._tipRows.appendChild(row);
  }

  /**
   * Keep the tooltip next to the cursor and inside the viewport.
   * @returns {void}
   * @private
   */
  _positionTooltip() {
    const tip = this._tip;
    const w = tip.offsetWidth || 200;
    const h = tip.offsetHeight || 80;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 720;
    let x = this._px + 18;
    let y = this._py + 18;
    if (x + w > vw - 8) x = Math.max(8, this._px - w - 18);
    if (y + h > vh - 8) y = Math.max(8, vh - h - 8);
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  }

  /* ====================================================================== */
  /* World interaction                                                      */
  /* ====================================================================== */

  /**
   * Throw the cursor stack (or one item of it) into the world.
   * @param {boolean} all throw the whole stack instead of a single item
   * @returns {void}
   * @private
   */
  _throwHeld(all) {
    const held = this.held;
    if (held === null || held.isEmpty()) return;
    const stack = all ? held : held.split(1);
    if (all) this.held = null;
    else if (held.count <= 0) this.held = null;
    if (stack === null) return;
    this._dropStack(stack);
    this._paintDrag();
  }

  /**
   * Spawn a dropped-item entity in front of the player. Without an entity
   * manager the stack goes back into the inventory instead of vanishing.
   * @param {?ItemStack} stack the stack to drop
   * @returns {void}
   * @private
   */
  _dropStack(stack) {
    if (stack === null || stack === undefined || stack.isEmpty()) return;
    const game = this.game;
    const player = game && game.player;
    const entities = game && game.entities;
    if (!player || !entities || typeof entities.dropItem !== 'function') {
      const rest = this._addToPlayer(stack);
      if (rest !== null) warnOnce('lost', 'no entity manager: a dropped stack stayed in the inventory.');
      return;
    }
    try {
      const cp = Math.cos(player.pitch || 0);
      const fx = Math.sin(player.yaw || 0) * cp;
      const fy = Math.sin(player.pitch || 0);
      const fz = -Math.cos(player.yaw || 0) * cp;
      const eye = typeof player.getEyePosition === 'function'
        ? player.getEyePosition()
        : [player.position[0], player.position[1] + 1.62, player.position[2]];
      entities.dropItem(
        eye[0] + fx * 0.5, eye[1] - 0.25 + fy * 0.5, eye[2] + fz * 0.5,
        stack,
        [fx * 5 + (Math.random() - 0.5) * 0.4, fy * 5 + 1.2, fz * 5 + (Math.random() - 0.5) * 0.4],
      );
      this._playUI('toss');
    } catch (err) {
      warnOnce('drop', 'dropItem() failed; the stack went back into the inventory.', err);
      this._addToPlayer(stack);
    }
  }

  /**
   * Put the cursor stack back into the inventory when the screen closes.
   * @returns {void}
   * @private
   */
  _returnHeld() {
    const held = this.held;
    this.held = null;
    if (held === null || held.isEmpty()) return;
    const rest = this._addToPlayer(held);
    if (rest !== null) this._dropStack(rest);
    this._paintDrag();
  }

  /* ====================================================================== */
  /* Game bridge                                                            */
  /* ====================================================================== */

  /**
   * Run a callback and report a failure at most once — never throw in a frame.
   * @param {string} tag failure tag
   * @param {Function} fn the callback
   * @returns {void}
   * @private
   */
  _guard(tag, fn) {
    try {
      fn();
    } catch (err) {
      warnOnce(tag, `"${tag}" failed; the station screen keeps running.`, err);
    }
  }

  /**
   * Show a short German line on the HUD.
   * @param {string} text the message
   * @returns {void}
   * @private
   */
  _message(text) {
    if (typeof text !== 'string' || text.length === 0) return;
    const hud = this.game && this.game.ui ? this.game.ui.hud : null;
    if (hud && typeof hud.setMessage === 'function') {
      try { hud.setMessage(text, 2400); } catch (err) {
        warnOnce('message', 'setMessage() failed.', err);
      }
    }
  }

  /**
   * Raise or clear `input.typing` so typing a name cannot walk the player.
   * @param {boolean} on desired state
   * @returns {void}
   * @private
   */
  _setTyping(on) {
    const input = this.game && this.game.input;
    if (input) input.typing = on === true;
  }

  /**
   * Release pointer lock so the cursor becomes usable.
   * @returns {void}
   * @private
   */
  _releasePointer() {
    const input = this.game && this.game.input;
    if (input && typeof input.exitLock === 'function') {
      try { input.exitLock(); } catch (err) { warnOnce('unlock', 'exitLock() failed.', err); }
    }
  }

  /**
   * Re-acquire pointer lock after closing, but only while actually playing.
   * @returns {void}
   * @private
   */
  _grabPointer() {
    const game = this.game;
    if (!game) return;
    if (game.state !== undefined && game.state !== 'playing' && game.state !== 'inventory') return;
    const input = game.input;
    if (input && typeof input.requestLock === 'function') {
      try { input.requestLock(); } catch (err) { warnOnce('lock', 'requestLock() failed.', err); }
    }
  }

  /**
   * Remember the game state and switch it to `'inventory'`.
   * @returns {void}
   * @private
   */
  _pushState() {
    const game = this.game;
    if (!game || typeof game.setState !== 'function') return;
    if (game.state === 'inventory') { this._prevState = null; return; }
    this._prevState = typeof game.state === 'string' ? game.state : null;
    try { game.setState('inventory'); } catch (err) { warnOnce('state', 'setState() failed.', err); }
  }

  /**
   * Restore the state remembered by {@link StationsUI#_pushState}.
   * @returns {void}
   * @private
   */
  _popState() {
    const game = this.game;
    const previous = this._prevState;
    this._prevState = null;
    if (!game || typeof game.setState !== 'function') return;
    if (game.state !== 'inventory') return;
    try { game.setState(previous === null ? 'playing' : previous); } catch (err) {
      warnOnce('state2', 'setState() failed while closing.', err);
    }
  }

  /**
   * Play a UI sound, guarded.
   * @param {string} name sound name understood by `game/audio.js`
   * @returns {void}
   * @private
   */
  _playUI(name) {
    const audio = this.game && this.game.audio;
    if (audio && typeof audio.playUI === 'function') {
      try { audio.playUI(name); } catch (err) { warnOnce('audio', 'playUI() failed.', err); }
    }
  }
}

export default StationsUI;
