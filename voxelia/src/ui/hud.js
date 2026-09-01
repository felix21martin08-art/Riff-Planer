/**
 * @file ui/hud.js — VOXELIA in-game overlay (ARCHITECTURE.md section 5.41).
 *
 * ============================================================================
 * WHAT LIVES HERE
 * ============================================================================
 * {@link HUD} owns every piece of DOM that floats over the WebGL canvas while
 * the player is actually playing: the crosshair, the segmented health / hunger
 * / armour / breath bars, the experience track, the nine hotbar slots, the
 * status-effect stack, the pickup ticker, the centre message line, the toast
 * stack and the full-screen damage tints.
 *
 * Two helpers are exported alongside it because `ui/inventory_ui.js` needs the
 * exact same artwork: {@link ItemIconCache} (block previews from the renderer,
 * procedural sprites for everything else) and {@link drawItemSprite} (the raw
 * 2D drawing routine behind those sprites).
 *
 * ============================================================================
 * STYLING
 * ============================================================================
 * Every class name here already exists in `ui/style.css` section 05 — the HUD
 * adds no stylesheet of its own and never rewrites one. The only style property
 * it writes is `--gui-scale` on the document root (mirroring `settings.guiScale`,
 * see {@link HUD#_applyGuiScale}) plus the handful of per-node custom properties
 * the stylesheet reads: `--v`, `--ghost`, `--segs`, `--d`, `--c`, `--fx`.
 *
 * ============================================================================
 * COST
 * ============================================================================
 * The overlay is built exactly once. `update(dt)` walks a fixed set of cached
 * nodes, compares each value against the last one written and touches the DOM
 * only on a real change — a steady frame writes nothing at all. Lists (effects,
 * toasts, pickups) mutate per entry, never by rebuilding.
 *
 * Gameplay *events* (`damage`, `attack`, `kill`, `levelup`, `itemPickup`,
 * `message`, …) drive the one-shot animations; the seven scalars that have no
 * event of their own (health, hunger, armour, air, xp, level, selected slot)
 * are diffed, which is cheaper than an event and cannot desync.
 *
 * Nothing in this file throws during a frame: every foreign call is guarded,
 * each distinct failure is logged once and the affected widget degrades.
 *
 * All player-visible text is German.
 *
 * @module ui/hud
 */

import { clamp } from '../core/math.js';
import { MAX_AIR } from '../game/player.js';
import { itemIcon, itemDisplay, itemRarity } from '../game/items.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Number of hotbar slots. @type {number} */
export const HOTBAR_SIZE = 9;

/** Edge length in pixels of every generated item icon. @type {number} */
export const ICON_SIZE = 64;

/** How long the item name stays on screen after a hotbar change, in seconds. @type {number} */
export const ITEM_NAME_TIME = 2;

/** Default lifetime of a toast, in seconds. @type {number} */
export const TOAST_TIME = 5;

/** Maximum number of toasts shown at once. @type {number} */
export const TOAST_LIMIT = 4;

/** Maximum number of rows in the pickup ticker. @type {number} */
export const PICKUP_LIMIT = 6;

/** Lifetime of one pickup row, in seconds (matches the CSS animation). @type {number} */
export const PICKUP_TIME = 2.4;

/** Health fraction below which the low-health pulse starts. @type {number} */
export const LOW_HEALTH_RATIO = 0.3;

/** Hunger value at or below which the hunger bar starts to wobble. @type {number} */
export const STARVING_HUNGER = 6;

/** Seconds a status effect blinks before it runs out. @type {number} */
export const EFFECT_BLINK_TIME = 6;

/**
 * German names and tint colours of the status effects the game can grant.
 * The tint is written to `--fx` on `.vx-effect__icon`.
 * @type {Readonly<Object<string, {de:string, color:string, glyph:string}>>}
 */
export const EFFECTS = Object.freeze({
  speed: { de: 'Schnelligkeit', color: '#7cafc6', glyph: 'arrow' },
  slowness: { de: 'Langsamkeit', color: '#5a6c81', glyph: 'arrow' },
  haste: { de: 'Eile', color: '#d9c043', glyph: 'pick' },
  mining_fatigue: { de: 'Abbaulähmung', color: '#4a4217', glyph: 'pick' },
  strength: { de: 'Stärke', color: '#932423', glyph: 'fist' },
  weakness: { de: 'Schwäche', color: '#484d48', glyph: 'fist' },
  instant_health: { de: 'Sofortheilung', color: '#f82423', glyph: 'heart' },
  instant_damage: { de: 'Sofortschaden', color: '#430a09', glyph: 'skull' },
  jump_boost: { de: 'Sprungkraft', color: '#22ff4c', glyph: 'arrow' },
  nausea: { de: 'Übelkeit', color: '#551d4a', glyph: 'swirl' },
  regeneration: { de: 'Regeneration', color: '#cd5cab', glyph: 'heart' },
  resistance: { de: 'Widerstand', color: '#99453a', glyph: 'shield' },
  fire_resistance: { de: 'Feuerresistenz', color: '#e49a3a', glyph: 'flame' },
  water_breathing: { de: 'Wasseratmung', color: '#2e5299', glyph: 'drop' },
  invisibility: { de: 'Unsichtbarkeit', color: '#7f8392', glyph: 'eye' },
  blindness: { de: 'Blindheit', color: '#1f1f23', glyph: 'eye' },
  night_vision: { de: 'Nachtsicht', color: '#1f1fa1', glyph: 'eye' },
  hunger: { de: 'Hunger', color: '#587653', glyph: 'food' },
  saturation: { de: 'Sättigung', color: '#f8a423', glyph: 'food' },
  poison: { de: 'Vergiftung', color: '#4e9331', glyph: 'skull' },
  wither: { de: 'Verkümmern', color: '#352a27', glyph: 'skull' },
  absorption: { de: 'Absorption', color: '#2552a5', glyph: 'heart' },
  glowing: { de: 'Leuchten', color: '#94a061', glyph: 'star' },
  levitation: { de: 'Schwebekraft', color: '#a8e6ff', glyph: 'arrow' },
  slow_falling: { de: 'Sanfter Fall', color: '#f7f8e0', glyph: 'arrow' },
  teleport: { de: 'Teleport', color: '#12b58c', glyph: 'star' },
});

/** Roman numerals for status-effect levels 1..10. @type {readonly string[]} */
const ROMAN = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']);

/** Dark outline used by every procedural sprite. @type {string} */
const OUTLINE = 'rgba(0, 0, 0, 0.55)';

/** Two pi. @type {number} */
const TAU = Math.PI * 2;

/* ========================================================================== */
/* Diagnostics                                                                */
/* ========================================================================== */

/** Keys of problems already reported. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a message at most once per key. The HUD never throws out of a frame, so
 * every guard funnels through here instead.
 * @param {string} key de-duplication key
 * @param {string} message human readable message
 * @param {*} [err] optional error object
 * @returns {void}
 */
function warnOnce(key, message, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err === undefined) console.warn(`[hud] ${message}`);
  else console.warn(`[hud] ${message}`, err);
}

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/**
 * Coerce anything to a finite number.
 * @param {*} v candidate value
 * @param {number} d fallback when `v` is not finite
 * @returns {number} a finite number
 */
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
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
 * Build an inline SVG element from static markup.
 * @param {string} markup a complete `<svg>…</svg>` string
 * @returns {SVGElement} the parsed element
 */
function svg(markup) {
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  return /** @type {SVGElement} */ (holder.firstElementChild);
}

/**
 * Toggle a class without touching the DOM when nothing changed.
 * @param {Element} node target element
 * @param {string} cls class name
 * @param {boolean} on desired state
 * @returns {void}
 */
function toggle(node, cls, on) {
  if (node.classList.contains(cls) === on) return;
  node.classList.toggle(cls, on);
}

/**
 * Restart a one-shot CSS animation by alternating two equivalent classes.
 * @param {Element} node the animated element
 * @param {string} a first class
 * @param {string} b second class
 * @returns {void}
 */
function restart(node, a, b) {
  if (node.classList.contains(a)) {
    node.classList.remove(a);
    node.classList.add(b);
  } else {
    node.classList.remove(b);
    node.classList.add(a);
  }
}

/**
 * Roman numeral for a status-effect amplifier (0-based).
 * @param {number} amplifier 0 = level I
 * @returns {string} `''` for level I, `'II'`, `'III'`, …
 */
function roman(amplifier) {
  const i = Math.max(0, Math.min(ROMAN.length - 1, Math.round(num(amplifier, 0))));
  return i === 0 ? '' : ROMAN[i];
}

/**
 * Format a remaining duration the way the effect stack shows it.
 * @param {number} seconds remaining seconds
 * @returns {string} `'1:05'` / `'0:09'`
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.ceil(num(seconds, 0)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/* ========================================================================== */
/* Colour helpers                                                             */
/* ========================================================================== */

/**
 * Parse a `#rgb` / `#rrggbb` colour into byte components.
 * @param {string} hex colour string
 * @returns {number[]} `[r, g, b]`, mid grey for unparseable input
 */
function rgbOf(hex) {
  if (typeof hex !== 'string') return [128, 128, 128];
  let h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) return [128, 128, 128];
  const v = parseInt(h, 16);
  if (!Number.isFinite(v)) return [128, 128, 128];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Lighten (`amount > 0`) or darken (`amount < 0`) a colour.
 * @param {string} hex base colour
 * @param {number} amount `-1..1`
 * @returns {string} a `rgb(...)` string
 */
function shade(hex, amount) {
  const c = rgbOf(hex);
  const t = clamp(num(amount, 0), -1, 1);
  const target = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  const r = Math.round(c[0] + (target - c[0]) * k);
  const g = Math.round(c[1] + (target - c[1]) * k);
  const b = Math.round(c[2] + (target - c[2]) * k);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * A colour with an explicit alpha.
 * @param {string} hex base colour
 * @param {number} alpha `0..1`
 * @returns {string} a `rgba(...)` string
 */
function fade(hex, alpha) {
  const c = rgbOf(hex);
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${clamp(num(alpha, 1), 0, 1)})`;
}

/**
 * Pick a colour from a sprite descriptor's tint list.
 * @param {readonly string[]} colors tint list
 * @param {number} index wanted index
 * @param {string} fallback used when the list is shorter
 * @returns {string} a colour string
 */
function tint(colors, index, fallback) {
  if (!colors || colors.length <= index) return fallback;
  const c = colors[index];
  return typeof c === 'string' && c.length > 0 ? c : fallback;
}

/* ========================================================================== */
/* Canvas primitives — everything is drawn on a 32x32 design grid             */
/* ========================================================================== */

/**
 * Filled axis-aligned rectangle in grid units.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {number} a left
 * @param {number} b top
 * @param {number} w width
 * @param {number} h height
 * @param {string} fill fill colour
 * @returns {void}
 */
function rect(x, u, a, b, w, h, fill) {
  x.fillStyle = fill;
  x.fillRect(a * u, b * u, w * u, h * u);
}

/**
 * Build a closed path from a flat `[x0, y0, x1, y1, …]` point list.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly number[]} pts flat point list
 * @returns {void}
 */
function trace(x, u, pts) {
  x.beginPath();
  x.moveTo(pts[0] * u, pts[1] * u);
  for (let i = 2; i < pts.length; i += 2) x.lineTo(pts[i] * u, pts[i + 1] * u);
  x.closePath();
}

/**
 * Fill (and optionally outline) a polygon.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly number[]} pts flat point list
 * @param {string} fill fill colour
 * @param {string} [stroke] outline colour
 * @param {number} [lw] outline width in grid units
 * @returns {void}
 */
function poly(x, u, pts, fill, stroke, lw) {
  trace(x, u, pts);
  x.fillStyle = fill;
  x.fill();
  if (stroke) {
    x.strokeStyle = stroke;
    x.lineWidth = (lw === undefined ? 1 : lw) * u;
    x.stroke();
  }
}

/**
 * Thick line segment with round caps.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {number} x1 start X
 * @param {number} y1 start Y
 * @param {number} x2 end X
 * @param {number} y2 end Y
 * @param {number} w width in grid units
 * @param {string} color stroke colour
 * @returns {void}
 */
function seg(x, u, x1, y1, x2, y2, w, color) {
  x.beginPath();
  x.moveTo(x1 * u, y1 * u);
  x.lineTo(x2 * u, y2 * u);
  x.strokeStyle = color;
  x.lineWidth = w * u;
  x.stroke();
}

/**
 * Filled circle.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {number} cx centre X
 * @param {number} cy centre Y
 * @param {number} r radius
 * @param {string} fill fill colour
 * @param {string} [stroke] outline colour
 * @returns {void}
 */
function disc(x, u, cx, cy, r, fill, stroke) {
  x.beginPath();
  x.arc(cx * u, cy * u, r * u, 0, TAU);
  x.fillStyle = fill;
  x.fill();
  if (stroke) {
    x.strokeStyle = stroke;
    x.lineWidth = 0.9 * u;
    x.stroke();
  }
}

/**
 * Filled ellipse, implemented with a scaled arc so no `ctx.ellipse` is needed.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {number} cx centre X
 * @param {number} cy centre Y
 * @param {number} rx radius X
 * @param {number} ry radius Y
 * @param {number} rot rotation in radians
 * @param {string} fill fill colour
 * @param {string} [stroke] outline colour
 * @returns {void}
 */
function oval(x, u, cx, cy, rx, ry, rot, fill, stroke) {
  x.save();
  x.translate(cx * u, cy * u);
  if (rot) x.rotate(rot);
  x.scale(rx, ry);
  x.beginPath();
  x.arc(0, 0, u, 0, TAU);
  x.restore();
  x.fillStyle = fill;
  x.fill();
  if (stroke) {
    x.strokeStyle = stroke;
    x.lineWidth = 0.9 * u;
    x.stroke();
  }
}

/**
 * Rounded rectangle path built from `arcTo`, so it works without `roundRect`.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {number} a left
 * @param {number} b top
 * @param {number} w width
 * @param {number} h height
 * @param {number} r corner radius
 * @param {string} fill fill colour
 * @param {string} [stroke] outline colour
 * @returns {void}
 */
function rrect(x, u, a, b, w, h, r, fill, stroke) {
  const l = a * u;
  const t = b * u;
  const rr = (a + w) * u;
  const bb = (b + h) * u;
  const rad = Math.min(r * u, (w * u) / 2, (h * u) / 2);
  x.beginPath();
  x.moveTo(l + rad, t);
  x.arcTo(rr, t, rr, bb, rad);
  x.arcTo(rr, bb, l, bb, rad);
  x.arcTo(l, bb, l, t, rad);
  x.arcTo(l, t, rr, t, rad);
  x.closePath();
  x.fillStyle = fill;
  x.fill();
  if (stroke) {
    x.strokeStyle = stroke;
    x.lineWidth = 0.9 * u;
    x.stroke();
  }
}

/**
 * Stroked quadratic curve.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {number} x0 start X
 * @param {number} y0 start Y
 * @param {number} cx control X
 * @param {number} cy control Y
 * @param {number} x1 end X
 * @param {number} y1 end Y
 * @param {number} w width in grid units
 * @param {string} color stroke colour
 * @returns {void}
 */
function curve(x, u, x0, y0, cx, cy, x1, y1, w, color) {
  x.beginPath();
  x.moveTo(x0 * u, y0 * u);
  x.quadraticCurveTo(cx * u, cy * u, x1 * u, y1 * u);
  x.strokeStyle = color;
  x.lineWidth = w * u;
  x.stroke();
}

/**
 * Stroked circular arc.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {number} cx centre X
 * @param {number} cy centre Y
 * @param {number} r radius
 * @param {number} a0 start angle
 * @param {number} a1 end angle
 * @param {number} w width in grid units
 * @param {string} color stroke colour
 * @returns {void}
 */
function arc(x, u, cx, cy, r, a0, a1, w, color) {
  x.beginPath();
  x.arc(cx * u, cy * u, r * u, a0, a1);
  x.strokeStyle = color;
  x.lineWidth = w * u;
  x.stroke();
}

/* ========================================================================== */
/* Procedural item sprites                                                    */
/* ========================================================================== */

/**
 * Draw the classic tool framing: the whole shape is authored upright (handle
 * pointing down, head at the top) and then rotated 45 degrees so it reads as a
 * held tool, slightly scaled down so the corners stay inside the icon.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {function():void} draw paints the upright shape
 * @returns {void}
 */
function toolFrame(x, u, draw) {
  x.save();
  x.translate(16 * u, 16 * u);
  x.rotate(Math.PI / 4);
  x.scale(0.9, 0.9);
  x.translate(-16 * u, -16 * u);
  draw();
  x.restore();
}

/**
 * The wooden shaft every tool shares, drawn in the upright tool frame.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {string} wood handle colour
 * @param {number} top top edge of the shaft in grid units
 * @returns {void}
 */
function toolShaft(x, u, wood, top) {
  poly(x, u, [14.3, top, 17.7, top, 17.7, 30, 14.3, 30], wood, OUTLINE, 0.9);
  rect(x, u, 16.6, top, 1.1, 30 - top, shade(wood, -0.3));
  rect(x, u, 14.5, top, 0.8, 30 - top, shade(wood, 0.22));
}

/**
 * Paint a pickaxe.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[head, handle]`
 * @returns {void}
 */
function paintPickaxe(x, u, c) {
  const head = tint(c, 0, '#d8d8d8');
  const wood = tint(c, 1, '#6b4a2a');
  toolFrame(x, u, () => {
    toolShaft(x, u, wood, 9);
    const pts = [4.5, 13, 6.6, 8.6, 11, 5.9, 16, 5, 21, 5.9, 25.4, 8.6, 27.5, 13,
      24.4, 12.4, 21, 9, 16, 7.9, 11, 9, 7.6, 12.4];
    poly(x, u, pts, head, OUTLINE, 1);
    poly(x, u, [7.4, 11.2, 11, 8.2, 16, 7.1, 21, 8.2, 24.6, 11.2, 23.2, 10.4,
      21, 9.4, 16, 8.5, 11, 9.4, 8.8, 10.4], shade(head, 0.3));
  });
}

/**
 * Paint an axe.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[head, handle]`
 * @returns {void}
 */
function paintAxe(x, u, c) {
  const head = tint(c, 0, '#d8d8d8');
  const wood = tint(c, 1, '#6b4a2a');
  toolFrame(x, u, () => {
    toolShaft(x, u, wood, 8);
    poly(x, u, [13.4, 8.4, 16.2, 6.4, 21.4, 6, 25.6, 9.2, 26.6, 14, 24.2, 18.6,
      19, 20, 13.4, 18.4], head, OUTLINE, 1);
    poly(x, u, [22.4, 8.2, 25.2, 11, 25.8, 14.4, 23.6, 18, 21.4, 18.8, 23.6, 14.6,
      23.2, 11], shade(head, 0.32));
    rect(x, u, 13.4, 8.4, 2.4, 10, shade(head, -0.22));
  });
}

/**
 * Paint a shovel.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[head, handle]`
 * @returns {void}
 */
function paintShovel(x, u, c) {
  const head = tint(c, 0, '#d8d8d8');
  const wood = tint(c, 1, '#6b4a2a');
  toolFrame(x, u, () => {
    toolShaft(x, u, wood, 13);
    poly(x, u, [11.2, 5, 20.8, 5, 21.8, 11.6, 16, 17.4, 10.2, 11.6], head, OUTLINE, 1);
    poly(x, u, [12.6, 6.6, 16, 6.2, 16, 15.4, 11.8, 11.2], shade(head, 0.28));
    poly(x, u, [14.2, 14.6, 17.8, 14.6, 17.8, 17.4, 14.2, 17.4], shade(head, -0.25));
  });
}

/**
 * Paint a sword.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[blade, grip]`
 * @returns {void}
 */
function paintSword(x, u, c) {
  const blade = tint(c, 0, '#d8d8d8');
  const wood = tint(c, 1, '#6b4a2a');
  toolFrame(x, u, () => {
    poly(x, u, [16, 2.2, 19.3, 7, 19.3, 19.4, 12.7, 19.4, 12.7, 7], blade, OUTLINE, 1);
    poly(x, u, [16, 3.6, 17.7, 7.4, 17.7, 19.4, 16, 19.4], shade(blade, 0.34));
    poly(x, u, [16, 3.6, 14.3, 7.4, 14.3, 19.4, 16, 19.4], shade(blade, -0.16));
    rrect(x, u, 9.4, 19.2, 13.2, 2.8, 0.8, shade(wood, 0.18), OUTLINE);
    rect(x, u, 14.3, 22, 3.4, 6.2, wood);
    rect(x, u, 16.4, 22, 1.3, 6.2, shade(wood, -0.3));
    rrect(x, u, 13.2, 28, 5.6, 2.6, 0.9, shade(wood, 0.24), OUTLINE);
  });
}

/**
 * Paint a hoe.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[head, handle]`
 * @returns {void}
 */
function paintHoe(x, u, c) {
  const head = tint(c, 0, '#d8d8d8');
  const wood = tint(c, 1, '#6b4a2a');
  toolFrame(x, u, () => {
    toolShaft(x, u, wood, 8);
    poly(x, u, [7.2, 5.4, 18.6, 5.4, 18.6, 9.2, 11.4, 9.2, 11.4, 12.6, 7.2, 12.6],
      head, OUTLINE, 1);
    poly(x, u, [8.4, 6.6, 17.4, 6.6, 17.4, 7.8, 8.4, 7.8], shade(head, 0.3));
  });
}

/**
 * Paint a helmet.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[main, shadow]`
 * @returns {void}
 */
function paintHelmet(x, u, c) {
  const a = tint(c, 0, '#d8d8d8');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [5.5, 21, 5.5, 12.4, 7.6, 8.2, 11.2, 5.6, 16, 4.8, 20.8, 5.6, 24.4, 8.2,
    26.5, 12.4, 26.5, 21, 22, 21, 22, 15.4, 10, 15.4, 10, 21], a, OUTLINE, 1);
  poly(x, u, [7.4, 13, 9, 9.2, 12.4, 6.8, 16, 6.1, 16, 8.2, 12.6, 9.2, 10, 12], shade(a, 0.3));
  rect(x, u, 9.6, 13.2, 12.8, 2.4, b);
  rect(x, u, 5.5, 19.4, 21, 1.6, shade(b, -0.15));
}

/**
 * Paint a chestplate.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[main, shadow]`
 * @returns {void}
 */
function paintChestplate(x, u, c) {
  const a = tint(c, 0, '#d8d8d8');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [6.4, 11.6, 10, 7.4, 13.2, 10.4, 18.8, 10.4, 22, 7.4, 25.6, 11.6,
    24.6, 15, 24.2, 25, 7.8, 25, 7.4, 15], a, OUTLINE, 1);
  poly(x, u, [8.2, 12.4, 10.4, 9.4, 12.6, 11.6, 12.6, 24, 9.2, 24, 9, 15], shade(a, 0.26));
  rect(x, u, 15.4, 11.4, 1.4, 13.6, b);
  poly(x, u, [13.2, 10.4, 18.8, 10.4, 17.6, 13, 14.4, 13], shade(b, -0.1));
}

/**
 * Paint leggings.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[main, shadow]`
 * @returns {void}
 */
function paintLeggings(x, u, c) {
  const a = tint(c, 0, '#d8d8d8');
  const b = tint(c, 1, shade(a, -0.3));
  rrect(x, u, 7, 6.6, 18, 5.4, 1, a, OUTLINE);
  poly(x, u, [7.4, 11.6, 14.6, 11.6, 14, 26, 9.6, 26], a, OUTLINE, 1);
  poly(x, u, [17.4, 11.6, 24.6, 11.6, 22.4, 26, 18, 26], a, OUTLINE, 1);
  rect(x, u, 7, 8.4, 18, 1.4, b);
  poly(x, u, [8.4, 12.6, 11, 12.6, 10.8, 24.4, 9.2, 24.4], shade(a, 0.26));
  poly(x, u, [18.4, 12.6, 21, 12.6, 20.4, 24.4, 18.8, 24.4], shade(a, 0.26));
}

/**
 * Paint boots.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[main, shadow]`
 * @returns {void}
 */
function paintBoots(x, u, c) {
  const a = tint(c, 0, '#d8d8d8');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [6.6, 13.6, 12.6, 13.6, 12.6, 21.6, 15.2, 21.6, 15.2, 25.6, 6.6, 25.6],
    a, OUTLINE, 1);
  poly(x, u, [16.8, 13.6, 22.8, 13.6, 22.8, 21.6, 25.4, 21.6, 25.4, 25.6, 16.8, 25.6],
    a, OUTLINE, 1);
  rect(x, u, 6.6, 23.6, 8.6, 2, b);
  rect(x, u, 16.8, 23.6, 8.6, 2, b);
  rect(x, u, 7.8, 14.8, 2, 8, shade(a, 0.26));
  rect(x, u, 18, 14.8, 2, 8, shade(a, 0.26));
}

/**
 * Paint a bow.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[wood, string]`
 * @returns {void}
 */
function paintBow(x, u, c) {
  const wood = tint(c, 0, '#8b6a3f');
  const str = tint(c, 1, '#dcd3c4');
  curve(x, u, 21, 4.5, 30, 16, 21, 27.5, 3.2, OUTLINE);
  curve(x, u, 21, 4.5, 30, 16, 21, 27.5, 2.4, wood);
  curve(x, u, 21, 5.4, 29, 16, 21, 26.6, 0.9, shade(wood, 0.3));
  seg(x, u, 20.6, 4.8, 10.5, 16, 0.95, str);
  seg(x, u, 10.5, 16, 20.6, 27.2, 0.95, str);
  disc(x, u, 20.8, 4.8, 1, shade(wood, -0.3));
  disc(x, u, 20.8, 27.2, 1, shade(wood, -0.3));
}

/**
 * Paint a crossbow.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[wood, metal]`
 * @returns {void}
 */
function paintCrossbow(x, u, c) {
  const wood = tint(c, 0, '#8b6a3f');
  const metal = tint(c, 1, '#b0b0b0');
  curve(x, u, 3.5, 9, 16, 18, 28.5, 9, 3.2, OUTLINE);
  curve(x, u, 3.5, 9, 16, 18, 28.5, 9, 2.4, wood);
  seg(x, u, 3.5, 9, 28.5, 9, 0.8, shade(metal, 0.35));
  poly(x, u, [13.6, 11.5, 18.4, 11.5, 20.4, 27, 15.4, 27], wood, OUTLINE, 0.9);
  rect(x, u, 15, 11.5, 2.4, 11.5, metal);
  rect(x, u, 15, 11.5, 0.9, 11.5, shade(metal, 0.3));
  poly(x, u, [17.4, 21, 21.4, 24.4, 18.6, 24.4], shade(metal, -0.3));
}

/**
 * Paint an arrow.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[shaft, head, fletching]`
 * @returns {void}
 */
function paintArrow(x, u, c) {
  const shaft = tint(c, 0, '#8b6a3f');
  const head = tint(c, 1, '#d8d8d8');
  const vane = tint(c, 2, '#f2f2f2');
  seg(x, u, 7, 25, 22.5, 9.5, 2.2, OUTLINE);
  seg(x, u, 7, 25, 22.5, 9.5, 1.5, shaft);
  poly(x, u, [27, 5, 20.4, 8.2, 23.8, 11.6], head, OUTLINE, 0.9);
  poly(x, u, [26.2, 6.4, 22.6, 8.2, 24.4, 10], shade(head, 0.35));
  poly(x, u, [5, 27, 8.6, 20.4, 11.4, 23.2, 5, 27], vane, OUTLINE, 0.8);
  poly(x, u, [5, 27, 11.6, 23.4, 12.6, 26.6, 5, 27], shade(vane, -0.2), OUTLINE, 0.8);
}

/**
 * Paint a shield.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[wood, metal]`
 * @returns {void}
 */
function paintShield(x, u, c) {
  const wood = tint(c, 0, '#8b6a3f');
  const metal = tint(c, 1, '#b0b0b0');
  poly(x, u, [7.5, 4.5, 24.5, 4.5, 24.5, 17.5, 16, 27.5, 7.5, 17.5], wood, OUTLINE, 1.1);
  poly(x, u, [9, 6, 16, 6, 16, 25.4, 9, 16.8], shade(wood, 0.2));
  rect(x, u, 14.6, 5.2, 2.8, 18.6, metal);
  rect(x, u, 9.2, 11.4, 13.6, 2.8, metal);
  rect(x, u, 14.6, 5.2, 1.1, 18.6, shade(metal, 0.32));
  rect(x, u, 9.2, 11.4, 13.6, 1.1, shade(metal, 0.32));
  disc(x, u, 16, 12.8, 1.6, shade(metal, -0.3));
}

/**
 * Paint shears.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[blade, handle]`
 * @returns {void}
 */
function paintShears(x, u, c) {
  const blade = tint(c, 0, '#d8d8d8');
  const grip = tint(c, 1, '#6b4a2a');
  poly(x, u, [9.6, 3.4, 13.8, 8, 16.4, 17.6, 13, 17.6], blade, OUTLINE, 0.9);
  poly(x, u, [22.4, 3.4, 18.2, 8, 15.6, 17.6, 19, 17.6], blade, OUTLINE, 0.9);
  poly(x, u, [10.4, 5, 13, 8.6, 14.8, 16.4, 13.6, 16.4], shade(blade, 0.32));
  arc(x, u, 11.6, 23.4, 3.6, 0, TAU, 1.7, grip);
  arc(x, u, 20.4, 23.4, 3.6, 0, TAU, 1.7, grip);
  disc(x, u, 16, 17.4, 1.5, shade(blade, -0.4), OUTLINE);
}

/**
 * Paint a fishing rod.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[rod, line]`
 * @returns {void}
 */
function paintFishingRod(x, u, c) {
  const rod = tint(c, 0, '#8b6a3f');
  const line = tint(c, 1, '#eeeeee');
  seg(x, u, 6.5, 27, 23, 7.5, 2.6, OUTLINE);
  seg(x, u, 6.5, 27, 23, 7.5, 1.9, rod);
  seg(x, u, 7.4, 25.8, 15, 16.8, 0.8, shade(rod, 0.3));
  curve(x, u, 23, 7.5, 27.5, 13, 25.5, 20, 0.8, line);
  arc(x, u, 24.4, 21.4, 1.9, -0.5, Math.PI * 0.95, 0.9, shade(line, -0.4));
  disc(x, u, 23, 7.5, 1.1, shade(rod, -0.35));
}

/**
 * Paint flint and steel.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[steel, flint]`
 * @returns {void}
 */
function paintFlintAndSteel(x, u, c) {
  const steel = tint(c, 0, '#d8d8d8');
  const stone = tint(c, 1, '#6b6b6b');
  arc(x, u, 13, 16, 6.6, Math.PI * 0.52, Math.PI * 1.48, 3.4, OUTLINE);
  arc(x, u, 13, 16, 6.6, Math.PI * 0.52, Math.PI * 1.48, 2.6, steel);
  arc(x, u, 13, 16, 6.6, Math.PI * 0.62, Math.PI * 1.05, 0.9, shade(steel, 0.34));
  poly(x, u, [18.6, 11.6, 25, 9.6, 27.4, 15.6, 23.4, 20.6, 18.8, 18.4],
    stone, OUTLINE, 0.9);
  poly(x, u, [19.8, 12.6, 24.4, 11.2, 25.6, 14.8, 21, 15.6], shade(stone, 0.3));
}

/**
 * Paint a bucket, filled with its contents when it has any.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[metal, contents]`
 * @returns {void}
 */
function paintBucket(x, u, c) {
  const metal = tint(c, 0, '#c8c8c8');
  const fluid = tint(c, 1, shade(metal, -0.3));
  arc(x, u, 16, 12.6, 7.4, Math.PI * 1.06, Math.PI * 1.94, 1.1, shade(metal, -0.35));
  poly(x, u, [8, 11, 24, 11, 21.4, 26.2, 10.6, 26.2], metal, OUTLINE, 1);
  poly(x, u, [9.6, 14.6, 22.4, 14.6, 21.6, 19.8, 10.4, 19.8], fluid);
  poly(x, u, [9.8, 12.4, 12.6, 12.4, 11.4, 25, 10.2, 25], shade(metal, 0.32));
  rrect(x, u, 7.2, 9.4, 17.6, 2.4, 0.8, shade(metal, 0.2), OUTLINE);
}

/**
 * Paint a glass bottle with its liquid.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[liquid, shadow]`
 * @returns {void}
 */
function paintBottle(x, u, c) {
  const liquid = tint(c, 0, '#cfe8ee');
  const dark = tint(c, 1, shade(liquid, -0.35));
  poly(x, u, [10.4, 15, 21.6, 15, 22.4, 23.4, 20, 27.2, 12, 27.2, 9.6, 23.4],
    'rgba(226, 240, 246, 0.30)', OUTLINE, 1);
  poly(x, u, [11.2, 18.6, 20.8, 18.6, 21.4, 23.6, 19.2, 26.4, 12.8, 26.4, 10.6, 23.6],
    liquid);
  poly(x, u, [11.2, 18.6, 20.8, 18.6, 20.9, 19.8, 11.1, 19.8], shade(liquid, 0.3));
  poly(x, u, [12.8, 25, 19.2, 25, 19.2, 26.4, 12.8, 26.4], dark);
  rect(x, u, 14.4, 7.4, 3.2, 7.8, 'rgba(226, 240, 246, 0.34)');
  poly(x, u, [14.4, 7.4, 17.6, 7.4, 17.6, 15, 14.4, 15], 'rgba(0,0,0,0)', OUTLINE, 0.9);
  rrect(x, u, 13.6, 5, 4.8, 2.8, 0.7, '#8b6a3f', OUTLINE);
  seg(x, u, 12.2, 20, 12.6, 25, 0.9, 'rgba(255,255,255,0.5)');
}

/**
 * Paint a metal ingot.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[metal, shadow]`
 * @returns {void}
 */
function paintIngot(x, u, c) {
  const a = tint(c, 0, '#d8d8d8');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [6, 15, 26, 15, 23, 22.6, 9, 22.6], b, OUTLINE, 1);
  poly(x, u, [9.2, 10.4, 22.8, 10.4, 26, 15, 6, 15], a, OUTLINE, 1);
  poly(x, u, [10.6, 11.6, 21.4, 11.6, 23.2, 14, 8.8, 14], shade(a, 0.3));
  rect(x, u, 6, 15, 20, 0.9, shade(a, 0.16));
}

/**
 * Paint a metal nugget.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[metal, shadow]`
 * @returns {void}
 */
function paintNugget(x, u, c) {
  const a = tint(c, 0, '#d8d8d8');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [11, 18.6, 12.6, 13.6, 17, 11.6, 21, 14, 21.4, 19, 17.6, 21.6, 13, 21.2],
    a, OUTLINE, 1);
  poly(x, u, [13.6, 15, 17, 13.4, 19.4, 15.4, 16.6, 16.6], shade(a, 0.34));
  poly(x, u, [14.4, 20.2, 20.6, 18.4, 21.4, 19, 17.6, 21.6, 13.6, 21.2], b);
}

/**
 * Paint a cut gem.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[gem, shadow]`
 * @returns {void}
 */
function paintGem(x, u, c) {
  const a = tint(c, 0, '#4aedd9');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [16, 4.6, 25.4, 13, 16, 27.4, 6.6, 13], a, OUTLINE, 1.1);
  poly(x, u, [16, 4.6, 20.4, 13, 16, 17.4, 11.6, 13], shade(a, 0.36));
  poly(x, u, [6.6, 13, 11.6, 13, 16, 17.4, 16, 27.4], b);
  poly(x, u, [20.4, 13, 25.4, 13, 16, 27.4, 16, 17.4], shade(b, -0.14));
  seg(x, u, 12.4, 8.6, 14.6, 12, 0.9, 'rgba(255,255,255,0.55)');
}

/**
 * Paint a crystal shard.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[shard, shadow]`
 * @returns {void}
 */
function paintShard(x, u, c) {
  const a = tint(c, 0, '#a678e2');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [13.4, 3.6, 20.6, 10.4, 22.4, 20.6, 16, 28.4, 10.6, 20.4, 9.6, 11],
    a, OUTLINE, 1.1);
  poly(x, u, [13.4, 3.6, 17.4, 12.4, 14.4, 23, 11, 14], shade(a, 0.32));
  poly(x, u, [17.4, 12.4, 20.6, 10.4, 22.4, 20.6, 16, 28.4, 14.4, 23], b);
}

/**
 * Paint a pile of powder.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[powder, shadow]`
 * @returns {void}
 */
function paintDust(x, u, c) {
  const a = tint(c, 0, '#d42a2a');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [6.6, 24.4, 10, 18.4, 16, 15, 22, 18.4, 25.4, 24.4], b, OUTLINE, 0.9);
  poly(x, u, [9.4, 22.6, 12.2, 18.6, 16, 16.6, 19.8, 18.6, 22.6, 22.6], a);
  disc(x, u, 12.4, 11.8, 1.5, a);
  disc(x, u, 17.6, 9.4, 1.9, a);
  disc(x, u, 21.4, 13.4, 1.3, b);
  disc(x, u, 9.6, 15.4, 1.1, b);
  disc(x, u, 16.4, 20.4, 1.2, shade(a, 0.3));
}

/**
 * Paint a lump of coal or charcoal.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[coal]`
 * @returns {void}
 */
function paintCoal(x, u, c) {
  const a = tint(c, 0, '#2b2b2b');
  poly(x, u, [8.4, 12.6, 12.6, 7.4, 19.6, 6.6, 25, 11.6, 24.2, 19.6, 18.4, 25.4,
    11, 24, 7, 17.6], a, 'rgba(0,0,0,0.7)', 1.1);
  poly(x, u, [11.4, 12.6, 15.4, 9.6, 19.6, 11.4, 17, 15.4, 12.4, 15.6],
    shade(a, 0.28));
  poly(x, u, [13.4, 18.4, 19.4, 17.6, 21, 20.6, 16.4, 23], shade(a, 0.16));
}

/**
 * Paint a flint chip.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[stone]`
 * @returns {void}
 */
function paintFlint(x, u, c) {
  const a = tint(c, 0, '#4a4a4a');
  poly(x, u, [6.6, 20.4, 10.6, 9.6, 19, 6.6, 25.4, 13, 22.4, 22.4, 13, 25.4],
    a, OUTLINE, 1.1);
  poly(x, u, [10.6, 9.6, 19, 6.6, 20.6, 12.4, 12.4, 15.4], shade(a, 0.34));
  poly(x, u, [12.4, 15.4, 20.6, 12.4, 22.4, 22.4, 15.4, 21.4], shade(a, -0.2));
}

/**
 * Paint a round ball (slime, egg-like drops, snowballs, raw ore chunks).
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[main, shadow]`
 * @returns {void}
 */
function paintBall(x, u, c) {
  const a = tint(c, 0, '#7fc45a');
  const b = tint(c, 1, shade(a, -0.35));
  const g = x.createRadialGradient(12.4 * u, 12.4 * u, 0.6 * u, 16 * u, 16 * u, 10.5 * u);
  g.addColorStop(0, shade(a, 0.4));
  g.addColorStop(0.55, a);
  g.addColorStop(1, b);
  disc(x, u, 16, 16.4, 9.4, '#000000');
  x.beginPath();
  x.arc(16 * u, 16.4 * u, 9.4 * u, 0, TAU);
  x.fillStyle = g;
  x.fill();
  disc(x, u, 12.6, 12.8, 2.1, 'rgba(255,255,255,0.4)');
}

/**
 * Paint a glowing rod.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[rod, shadow]`
 * @returns {void}
 */
function paintRod(x, u, c) {
  const a = tint(c, 0, '#f7c44a');
  const b = tint(c, 1, shade(a, -0.32));
  rrect(x, u, 13.2, 4.6, 5.6, 22.8, 1.6, a, OUTLINE);
  rect(x, u, 13.9, 5.4, 1.6, 21.2, shade(a, 0.35));
  rect(x, u, 17.2, 5.4, 1.4, 21.2, b);
  for (let i = 0; i < 4; i++) rect(x, u, 13.2, 8.4 + i * 4.8, 5.6, 1.1, b);
}

/**
 * Paint a stick.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[wood]`
 * @returns {void}
 */
function paintStick(x, u, c) {
  const a = tint(c, 0, '#8b6a3f');
  seg(x, u, 9.6, 26.4, 22.4, 6.6, 3.2, OUTLINE);
  seg(x, u, 9.6, 26.4, 22.4, 6.6, 2.4, a);
  seg(x, u, 10.4, 25.4, 21.4, 8.2, 0.8, shade(a, 0.3));
}

/**
 * Paint a loose length of string.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[string]`
 * @returns {void}
 */
function paintString(x, u, c) {
  const a = tint(c, 0, '#e8e8e8');
  x.beginPath();
  x.moveTo(6 * u, 9 * u);
  x.bezierCurveTo(14 * u, 3 * u, 20 * u, 13 * u, 13 * u, 17 * u);
  x.bezierCurveTo(6 * u, 21 * u, 14 * u, 29 * u, 26 * u, 24 * u);
  x.strokeStyle = OUTLINE;
  x.lineWidth = 2.4 * u;
  x.stroke();
  x.strokeStyle = a;
  x.lineWidth = 1.5 * u;
  x.stroke();
}

/**
 * Paint a feather.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[vane, shaft]`
 * @returns {void}
 */
function paintFeather(x, u, c) {
  const a = tint(c, 0, '#f2f2f2');
  const b = tint(c, 1, shade(a, -0.22));
  poly(x, u, [22.6, 5.4, 24.4, 12.4, 18.4, 20.4, 11.6, 24.4, 12.4, 18, 17.4, 10.6],
    a, OUTLINE, 1);
  poly(x, u, [22.6, 5.4, 24.4, 12.4, 18.4, 20.4, 16.4, 17.4, 20.4, 11.4], b);
  seg(x, u, 8.4, 27.4, 23, 5.6, 1, shade(b, -0.3));
}

/**
 * Paint a piece of leather / hide.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[hide, stitching]`
 * @returns {void}
 */
function paintLeather(x, u, c) {
  const a = tint(c, 0, '#a06540');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [6.6, 10.6, 12.6, 7, 21, 7.6, 26, 12.6, 24.4, 21, 17.4, 25.4, 9.6, 23.4,
    6, 17], a, OUTLINE, 1.1);
  poly(x, u, [9, 11.4, 13.4, 9, 20, 9.6, 22.4, 12.6, 15, 14.6], shade(a, 0.24));
  for (let i = 0; i < 6; i++) disc(x, u, 9.6 + i * 2.5, 20.6 + (i % 2) * 0.9, 0.6, b);
}

/**
 * Paint a bone.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[bone, shadow]`
 * @returns {void}
 */
function paintBone(x, u, c) {
  const a = tint(c, 0, '#e8e4d8');
  const b = tint(c, 1, shade(a, -0.22));
  x.save();
  x.translate(16 * u, 16 * u);
  x.rotate(-Math.PI / 4);
  x.translate(-16 * u, -16 * u);
  rrect(x, u, 10, 14, 12, 4.4, 1.4, a, OUTLINE);
  disc(x, u, 10, 13.4, 3, a, OUTLINE);
  disc(x, u, 10, 19, 3, a, OUTLINE);
  disc(x, u, 22, 13.4, 3, a, OUTLINE);
  disc(x, u, 22, 19, 3, a, OUTLINE);
  rect(x, u, 10, 17, 12, 1.4, b);
  x.restore();
}

/**
 * Paint a brick.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[face, mortar]`
 * @returns {void}
 */
function paintBrick(x, u, c) {
  const a = tint(c, 0, '#a35d4a');
  const b = tint(c, 1, shade(a, -0.3));
  rrect(x, u, 5.6, 10.6, 20.8, 10.8, 1.2, a, OUTLINE);
  rect(x, u, 5.6, 15.4, 20.8, 1.2, b);
  rect(x, u, 5.6, 10.6, 20.8, 1.4, shade(a, 0.26));
  rect(x, u, 5.6, 19.6, 20.8, 1.8, shade(a, -0.18));
}

/**
 * Paint a sheet of paper.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[paper, lines]`
 * @returns {void}
 */
function paintPaper(x, u, c) {
  const a = tint(c, 0, '#f2f2ea');
  const b = tint(c, 1, shade(a, -0.18));
  poly(x, u, [8.6, 5.4, 20.4, 5.4, 23.4, 8.6, 23.4, 26.6, 8.6, 26.6], a, OUTLINE, 1);
  poly(x, u, [20.4, 5.4, 23.4, 8.6, 20.4, 8.6], b);
  for (let i = 0; i < 5; i++) rect(x, u, 11, 12 + i * 3, 9.4, 1, b);
}

/**
 * Paint a book.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[cover, pages]`
 * @returns {void}
 */
function paintBook(x, u, c) {
  const cover = tint(c, 0, '#a05a30');
  const pages = tint(c, 1, '#f2f2ea');
  rrect(x, u, 7.4, 5, 17.6, 22, 1.2, cover, OUTLINE);
  rect(x, u, 11, 6.6, 12.4, 18.8, pages);
  for (let i = 0; i < 4; i++) rect(x, u, 12.4, 9.6 + i * 3.6, 9.6, 0.9, shade(pages, -0.28));
  rect(x, u, 7.4, 5, 3.4, 22, shade(cover, -0.28));
  rect(x, u, 8.2, 5, 0.9, 22, shade(cover, 0.24));
  rect(x, u, 19.4, 4, 2, 9.6, '#c9384a');
}

/**
 * Paint a handful of seeds.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[seed, shadow]`
 * @returns {void}
 */
function paintSeed(x, u, c) {
  const a = tint(c, 0, '#8cae4a');
  const b = tint(c, 1, shade(a, -0.3));
  const at = [11, 13, -0.6, 20.4, 11.4, 0.4, 13.4, 21.4, 0.9, 21, 20, -0.3, 16, 16.4, 0.2];
  for (let i = 0; i < at.length; i += 3) {
    oval(x, u, at[i], at[i + 1], 2.6, 1.6, at[i + 2], a, OUTLINE);
    oval(x, u, at[i] - 0.4, at[i + 1] - 0.4, 1.2, 0.7, at[i + 2], shade(a, 0.3));
  }
  disc(x, u, 24, 24, 1.1, b);
}

/**
 * Paint a bundle of wheat.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[grain, stalk]`
 * @returns {void}
 */
function paintWheat(x, u, c) {
  const a = tint(c, 0, '#d8b84a');
  const b = tint(c, 1, shade(a, -0.3));
  seg(x, u, 16, 28.4, 16, 8, 1.4, b);
  for (let i = 0; i < 6; i++) {
    const y = 9.4 + i * 3.2;
    oval(x, u, 12.4, y, 3, 1.5, -0.5, a, OUTLINE);
    oval(x, u, 19.6, y, 3, 1.5, 0.5, a, OUTLINE);
  }
  oval(x, u, 16, 7.4, 1.8, 3, 0, a, OUTLINE);
}

/**
 * Paint a cut of meat.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[flesh, marbling]`
 * @returns {void}
 */
function paintMeat(x, u, c) {
  const a = tint(c, 0, '#d06a6a');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [7.4, 13, 11, 8, 18.4, 6.6, 25, 10.4, 26, 18, 21.4, 24.4, 13, 25.4,
    6.6, 19.6], a, OUTLINE, 1.1);
  poly(x, u, [9.4, 12.6, 12.4, 9, 18, 8.4, 22, 10.6, 15.4, 14.4], shade(a, 0.26));
  curve(x, u, 10.4, 18.4, 16, 14.4, 22.4, 19.4, 1.5, b);
  curve(x, u, 12, 22.4, 17, 19.4, 22.4, 23, 1.1, b);
  disc(x, u, 13.4, 12.4, 1.1, shade(a, 0.34));
}

/**
 * Paint a round fruit (apple, melon, berries, golden apple, …).
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[flesh, leaf]`
 * @returns {void}
 */
function paintFoodRound(x, u, c) {
  const a = tint(c, 0, '#c4342a');
  const b = tint(c, 1, shade(a, -0.3));
  const g = x.createRadialGradient(12.6 * u, 13.4 * u, 0.8 * u, 16 * u, 17.4 * u, 10 * u);
  g.addColorStop(0, shade(a, 0.36));
  g.addColorStop(0.6, a);
  g.addColorStop(1, shade(a, -0.28));
  disc(x, u, 16, 17.4, 8.8, '#000000');
  x.beginPath();
  x.arc(16 * u, 17.4 * u, 8.8 * u, 0, TAU);
  x.fillStyle = g;
  x.fill();
  seg(x, u, 16, 9.6, 17, 5.4, 1.2, '#6b4a2a');
  oval(x, u, 20.4, 6.8, 3.4, 1.9, -0.5, b, OUTLINE);
  disc(x, u, 12.6, 13.6, 2, 'rgba(255,255,255,0.42)');
}

/**
 * Paint a fish.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[body, fins]`
 * @returns {void}
 */
function paintFish(x, u, c) {
  const a = tint(c, 0, '#d86a3a');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [6.4, 16, 11.6, 9.6, 19.4, 8.4, 25, 12.6, 26.4, 16, 25, 19.4, 19.4, 23.6,
    11.6, 22.4], a, OUTLINE, 1.1);
  poly(x, u, [6.4, 16, 2.4, 10.4, 3.6, 16, 2.4, 21.6], b, OUTLINE, 0.9);
  poly(x, u, [13, 9.4, 19, 8.6, 16, 13.4], b);
  poly(x, u, [12, 22.4, 17.4, 22.6, 14.6, 18.6], b);
  poly(x, u, [8.4, 14.4, 14.4, 10.4, 20.4, 10.4, 23, 13], shade(a, 0.26));
  disc(x, u, 21.6, 13.6, 1.5, '#ffffff');
  disc(x, u, 21.9, 13.7, 0.8, '#1b1b1b');
}

/**
 * Paint a bowl of stew.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[bowl, soup]`
 * @returns {void}
 */
function paintStew(x, u, c) {
  const bowl = tint(c, 0, '#8b6a3f');
  const soup = tint(c, 1, '#a3243a');
  oval(x, u, 16, 17.4, 10.4, 3.4, 0, soup, OUTLINE);
  oval(x, u, 13.4, 16.6, 2.4, 1.1, -0.3, shade(soup, 0.3));
  poly(x, u, [5.6, 17.4, 26.4, 17.4, 23, 26.6, 9, 26.6], bowl, OUTLINE, 1.1);
  rrect(x, u, 5, 15.6, 22, 2.4, 1.1, shade(bowl, 0.18), OUTLINE);
  poly(x, u, [8.4, 19.4, 11, 19.4, 11.6, 25.4, 9.6, 25.4], shade(bowl, 0.26));
}

/**
 * Paint an empty bowl.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[bowl, shadow]`
 * @returns {void}
 */
function paintBowl(x, u, c) {
  const bowl = tint(c, 0, '#8b6a3f');
  const dark = tint(c, 1, shade(bowl, -0.3));
  oval(x, u, 16, 17.4, 10.4, 3.4, 0, dark, OUTLINE);
  poly(x, u, [5.6, 17.4, 26.4, 17.4, 23, 26.6, 9, 26.6], bowl, OUTLINE, 1.1);
  rrect(x, u, 5, 15.6, 22, 2.4, 1.1, shade(bowl, 0.18), OUTLINE);
  poly(x, u, [8.4, 19.4, 11, 19.4, 11.6, 25.4, 9.6, 25.4], shade(bowl, 0.26));
}

/**
 * Paint a potato-like tuber.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[skin, eyes]`
 * @returns {void}
 */
function paintPotato(x, u, c) {
  const a = tint(c, 0, '#e0b06a');
  const b = tint(c, 1, shade(a, -0.3));
  oval(x, u, 16, 16.6, 9.4, 7.4, -0.28, a, OUTLINE);
  oval(x, u, 12.6, 13.2, 3.4, 2, -0.28, shade(a, 0.28));
  disc(x, u, 13.4, 18.4, 1.2, b);
  disc(x, u, 19, 14.4, 1, b);
  disc(x, u, 20.4, 20, 1.3, b);
}

/**
 * Paint a carrot-like root with greens.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[root, greens]`
 * @returns {void}
 */
function paintCarrot(x, u, c) {
  const a = tint(c, 0, '#e8801d');
  const b = tint(c, 1, '#4f8c36');
  poly(x, u, [16, 28.4, 10.6, 12.4, 21.4, 12.4], a, OUTLINE, 1.1);
  poly(x, u, [16, 28.4, 13.4, 12.4, 16, 12.4], shade(a, 0.28));
  for (let i = 0; i < 3; i++) {
    const y = 15.4 + i * 3.6;
    const w = 4.4 - i * 1.1;
    rect(x, u, 16 - w / 2, y, w, 0.9, shade(a, -0.24));
  }
  seg(x, u, 16, 12.6, 10.6, 4.6, 1.8, b);
  seg(x, u, 16, 12.6, 16.4, 3.4, 1.8, b);
  seg(x, u, 16, 12.6, 21.4, 5.4, 1.8, b);
}

/**
 * Paint a melon-style slice.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[flesh, rind]`
 * @returns {void}
 */
function paintSlice(x, u, c) {
  const a = tint(c, 0, '#d84a4a');
  const b = tint(c, 1, '#4f8c36');
  poly(x, u, [4.6, 23, 27.4, 23, 16, 6], a, OUTLINE, 1.1);
  poly(x, u, [8.6, 21.4, 16, 10.4, 16, 21.4], shade(a, 0.24));
  rrect(x, u, 4.2, 22.4, 23.6, 3.6, 1.4, b, OUTLINE);
  rect(x, u, 4.2, 22.6, 23.6, 1, shade(b, 0.28));
  disc(x, u, 13, 18.4, 0.9, '#2b2b2b');
  disc(x, u, 19, 18.4, 0.9, '#2b2b2b');
  disc(x, u, 16, 13.4, 0.9, '#2b2b2b');
}

/**
 * Paint a pie.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[filling, crust]`
 * @returns {void}
 */
function paintPie(x, u, c) {
  const a = tint(c, 0, '#e8a032');
  const b = tint(c, 1, '#c9924a');
  poly(x, u, [5.6, 18, 26.4, 18, 24.4, 25.4, 7.6, 25.4], b, OUTLINE, 1.1);
  oval(x, u, 16, 17.6, 10.4, 5, 0, b, OUTLINE);
  oval(x, u, 16, 16.6, 8.4, 3.8, 0, a);
  oval(x, u, 13, 15.6, 2.4, 1.1, -0.3, shade(a, 0.3));
  for (let i = 0; i < 7; i++) disc(x, u, 6.6 + i * 3.1, 18.6, 1.1, shade(b, 0.22));
}

/**
 * Paint a cake.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[sponge, icing]`
 * @returns {void}
 */
function paintCake(x, u, c) {
  const a = tint(c, 0, '#f2f2ea');
  const b = tint(c, 1, '#d84a4a');
  rrect(x, u, 5.6, 14.4, 20.8, 11, 1, a, OUTLINE);
  rect(x, u, 5.6, 19.4, 20.8, 1.2, shade(a, -0.2));
  rrect(x, u, 5.6, 10.4, 20.8, 4.6, 1, b, OUTLINE);
  for (let i = 0; i < 5; i++) disc(x, u, 7.6 + i * 4.2, 15.2, 1.5, b);
  disc(x, u, 16, 8, 2, shade(b, 0.2), OUTLINE);
  seg(x, u, 16, 7, 17, 5, 0.8, '#4f8c36');
}

/**
 * Paint a loaf of bread.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[crust, score]`
 * @returns {void}
 */
function paintBread(x, u, c) {
  const a = tint(c, 0, '#c9924a');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [6, 20.4, 7.4, 13.4, 12, 9.6, 20, 9.6, 24.6, 13.4, 26, 20.4, 22, 24.4,
    10, 24.4], a, OUTLINE, 1.1);
  poly(x, u, [8.4, 16.4, 10.4, 12, 15, 11, 14, 15.4], shade(a, 0.26));
  seg(x, u, 11.4, 14, 14.4, 20.4, 1.4, b);
  seg(x, u, 15.4, 12.6, 18.4, 19.4, 1.4, b);
  seg(x, u, 19.4, 13.4, 22, 19, 1.4, b);
}

/**
 * Paint a cookie.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[dough, chips]`
 * @returns {void}
 */
function paintCookie(x, u, c) {
  const a = tint(c, 0, '#c9924a');
  const b = tint(c, 1, '#5a3a1a');
  disc(x, u, 16, 16.4, 9.6, a, OUTLINE);
  disc(x, u, 12.6, 12.8, 3.4, shade(a, 0.2));
  const at = [12, 13.4, 19.4, 12, 15.4, 18, 21, 18.6, 13.6, 21, 17.4, 22.6];
  for (let i = 0; i < at.length; i += 2) disc(x, u, at[i], at[i + 1], 1.5, b);
}

/**
 * Paint an egg.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[shell, speckles]`
 * @returns {void}
 */
function paintEgg(x, u, c) {
  const a = tint(c, 0, '#f2e8d8');
  const b = tint(c, 1, shade(a, -0.24));
  poly(x, u, [16, 5.4, 21.4, 12.4, 23.4, 19.4, 20.4, 25.4, 16, 27, 11.6, 25.4,
    8.6, 19.4, 10.6, 12.4], a, OUTLINE, 1.1);
  poly(x, u, [16, 6.6, 12.6, 12.4, 11.4, 19, 13, 24.4, 16, 25.6, 16, 6.6],
    shade(a, 0.2));
  disc(x, u, 19.4, 15.4, 1.2, b);
  disc(x, u, 14.4, 20.4, 1, b);
  disc(x, u, 18.4, 22, 0.9, b);
}

/**
 * Paint a boat.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[hull, trim]`
 * @returns {void}
 */
function paintBoat(x, u, c) {
  const a = tint(c, 0, '#8b6a3f');
  const b = tint(c, 1, shade(a, -0.3));
  seg(x, u, 5.6, 9.6, 20.4, 20.4, 2.6, OUTLINE);
  seg(x, u, 5.6, 9.6, 20.4, 20.4, 1.9, b);
  poly(x, u, [3.6, 14.4, 28.4, 14.4, 24.4, 24.6, 7.6, 24.6], a, OUTLINE, 1.1);
  poly(x, u, [6.6, 16.4, 25.4, 16.4, 23, 21.6, 9, 21.6], b);
  rect(x, u, 3.6, 14.4, 24.8, 1.4, shade(a, 0.26));
  rect(x, u, 12.6, 16.4, 6.8, 2, shade(a, 0.12));
}

/**
 * Paint a minecart.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[body, inside]`
 * @returns {void}
 */
function paintMinecart(x, u, c) {
  const a = tint(c, 0, '#9a9a9a');
  const b = tint(c, 1, shade(a, -0.3));
  poly(x, u, [5.6, 10.6, 26.4, 10.6, 24, 22.4, 8, 22.4], a, OUTLINE, 1.1);
  poly(x, u, [8, 12.4, 24, 12.4, 22.4, 18.4, 9.6, 18.4], b);
  rect(x, u, 5.6, 10.6, 20.8, 1.4, shade(a, 0.3));
  disc(x, u, 11.4, 24.4, 3, shade(a, -0.35), OUTLINE);
  disc(x, u, 20.6, 24.4, 3, shade(a, -0.35), OUTLINE);
  disc(x, u, 11.4, 24.4, 1.1, shade(a, 0.2));
  disc(x, u, 20.6, 24.4, 1.1, shade(a, 0.2));
}

/**
 * Paint a saddle.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[leather, straps]`
 * @returns {void}
 */
function paintSaddle(x, u, c) {
  const a = tint(c, 0, '#8a5a32');
  const b = tint(c, 1, shade(a, -0.32));
  poly(x, u, [6, 15.4, 10, 10, 22, 10, 26, 15.4, 24.4, 20.4, 19, 22.4, 13, 22.4,
    7.6, 20.4], a, OUTLINE, 1.1);
  poly(x, u, [9.4, 13.4, 12.6, 11.4, 19.4, 11.4, 22.6, 13.4, 16, 15.4],
    shade(a, 0.26));
  rect(x, u, 8.6, 20, 3, 6.4, b);
  rect(x, u, 20.4, 20, 3, 6.4, b);
  rrect(x, u, 7.6, 25.4, 5, 2.4, 1, shade(b, 0.3), OUTLINE);
  rrect(x, u, 19.4, 25.4, 5, 2.4, 1, shade(b, 0.3), OUTLINE);
}

/**
 * Paint a map.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[parchment, marks]`
 * @returns {void}
 */
function paintMap(x, u, c) {
  const a = tint(c, 0, '#f2f2ea');
  const b = tint(c, 1, shade(a, -0.4));
  rrect(x, u, 5.6, 7.4, 20.8, 17.2, 0.8, a, OUTLINE);
  rrect(x, u, 4.6, 6.4, 3.4, 19.2, 1.4, shade(a, -0.22), OUTLINE);
  rrect(x, u, 24, 6.4, 3.4, 19.2, 1.4, shade(a, -0.22), OUTLINE);
  curve(x, u, 9.4, 20.4, 14, 12.4, 22.4, 16.4, 1.1, b);
  seg(x, u, 17.4, 10.4, 21, 14, 1.2, '#c4342a');
  seg(x, u, 21, 10.4, 17.4, 14, 1.2, '#c4342a');
  disc(x, u, 11.4, 12.4, 1.2, b);
}

/**
 * Paint a compass.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[case, needle]`
 * @returns {void}
 */
function paintCompass(x, u, c) {
  const a = tint(c, 0, '#d8d8d8');
  const b = tint(c, 1, '#c4342a');
  disc(x, u, 16, 16.4, 10.4, a, OUTLINE);
  disc(x, u, 16, 16.4, 8.4, shade(a, -0.5));
  disc(x, u, 16, 16.4, 7.4, '#1b2a45');
  poly(x, u, [16, 9.4, 18.4, 16.4, 16, 23.4, 13.6, 16.4], shade(a, 0.3), OUTLINE, 0.7);
  poly(x, u, [16, 9.4, 18.4, 16.4, 16, 16.4], b);
  poly(x, u, [16, 9.4, 13.6, 16.4, 16, 16.4], shade(b, -0.3));
  disc(x, u, 16, 16.4, 1.1, a);
  arc(x, u, 16, 16.4, 9.4, Math.PI * 1.1, Math.PI * 1.6, 1, shade(a, 0.35));
}

/**
 * Paint a clock.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[case, face]`
 * @returns {void}
 */
function paintClock(x, u, c) {
  const a = tint(c, 0, '#fbe14a');
  const b = tint(c, 1, '#3c44aa');
  disc(x, u, 16, 16.4, 10.4, a, OUTLINE);
  disc(x, u, 16, 16.4, 8.2, shade(a, -0.3));
  disc(x, u, 16, 16.4, 7.4, b);
  disc(x, u, 16, 16.4, 4.4, shade(a, 0.24));
  poly(x, u, [16, 16.4, 24, 16.4, 16, 20], fade(b, 0.55));
  seg(x, u, 16, 16.4, 16, 10.6, 1.1, shade(a, 0.4));
  arc(x, u, 16, 16.4, 9.3, Math.PI * 1.1, Math.PI * 1.6, 1, shade(a, 0.4));
}

/**
 * Paint a name tag.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[tag, text]`
 * @returns {void}
 */
function paintNameTag(x, u, c) {
  const a = tint(c, 0, '#d8c8a0');
  const b = tint(c, 1, shade(a, -0.4));
  seg(x, u, 9, 16, 3.6, 10.4, 1.1, b);
  rrect(x, u, 7.4, 11.4, 19.4, 10, 1.4, a, OUTLINE);
  disc(x, u, 10, 16.4, 1.4, shade(a, -0.5));
  rect(x, u, 13.4, 14.4, 10.4, 1.4, b);
  rect(x, u, 13.4, 17.6, 7.4, 1.4, b);
  rect(x, u, 7.4, 11.4, 19.4, 1.2, shade(a, 0.24));
}

/**
 * Paint a music disc.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[label, vinyl]`
 * @returns {void}
 */
function paintDisc(x, u, c) {
  const label = tint(c, 0, '#4aedd9');
  const vinyl = tint(c, 1, '#1d1d21');
  disc(x, u, 16, 16.4, 11, vinyl, OUTLINE);
  arc(x, u, 16, 16.4, 9.2, 0, TAU, 0.7, shade(vinyl, 0.28));
  arc(x, u, 16, 16.4, 7.4, 0, TAU, 0.7, shade(vinyl, 0.22));
  arc(x, u, 16, 16.4, 10.4, Math.PI * 1.15, Math.PI * 1.55, 1.2, 'rgba(255,255,255,0.3)');
  disc(x, u, 16, 16.4, 4.4, label, OUTLINE);
  disc(x, u, 16, 16.4, 1.1, shade(vinyl, -0.4));
}

/**
 * Paint a heap of dye powder.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[colour]`
 * @returns {void}
 */
function paintDye(x, u, c) {
  const a = tint(c, 0, '#f9801d');
  poly(x, u, [6.6, 24.6, 9.6, 17.6, 16, 13.6, 22.4, 17.6, 25.4, 24.6],
    shade(a, -0.28), OUTLINE, 1);
  poly(x, u, [9.4, 23, 12, 18.4, 16, 16, 20, 18.4, 22.6, 23], a);
  poly(x, u, [12.4, 20.4, 16, 17.6, 19.6, 20.4], shade(a, 0.3));
  disc(x, u, 11.6, 11.6, 1.4, a);
  disc(x, u, 20.4, 10.4, 1.7, a);
  disc(x, u, 16.4, 8.4, 1.1, shade(a, 0.24));
}

/**
 * Paint a spawn egg.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[base, spots]`
 * @returns {void}
 */
function paintSpawnEgg(x, u, c) {
  const a = tint(c, 0, '#c9c9c9');
  const b = tint(c, 1, '#4a4a4a');
  poly(x, u, [16, 4.4, 22, 12, 24.4, 19.4, 21, 26, 16, 27.6, 11, 26, 7.6, 19.4,
    10, 12], a, OUTLINE, 1.1);
  poly(x, u, [16, 5.6, 12.4, 12, 10.6, 19.4, 12.4, 25, 16, 26.4, 16, 5.6],
    shade(a, 0.18));
  const at = [13, 11.4, 1.7, 19.4, 13.4, 2.1, 12, 17.4, 2.4, 19.4, 20, 1.9,
    15.6, 23.4, 1.5, 21.4, 17, 1.3];
  for (let i = 0; i < at.length; i += 3) disc(x, u, at[i], at[i + 1], at[i + 2], b);
}

/**
 * Paint a sapling.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints `[leaves, stem]`
 * @returns {void}
 */
function paintSapling(x, u, c) {
  const a = tint(c, 0, '#4f8c36');
  const b = tint(c, 1, '#8b6a3f');
  seg(x, u, 16, 27.4, 16, 13.4, 1.6, b);
  seg(x, u, 16, 18.4, 11.4, 15.4, 1.2, b);
  seg(x, u, 16, 17, 20.6, 14, 1.2, b);
  oval(x, u, 16, 10.4, 5.4, 4, 0, a, OUTLINE);
  oval(x, u, 10.4, 14.4, 4.4, 3.2, -0.4, a, OUTLINE);
  oval(x, u, 21.6, 13.4, 4.4, 3.2, 0.4, a, OUTLINE);
  oval(x, u, 14.4, 9, 2.2, 1.5, -0.3, shade(a, 0.3));
}

/**
 * Fallback shape for any pattern the painter table does not know.
 * @param {CanvasRenderingContext2D} x drawing context
 * @param {number} u pixels per grid unit
 * @param {readonly string[]} c tints
 * @returns {void}
 */
function paintGeneric(x, u, c) {
  const a = tint(c, 0, '#9aa4b4');
  const b = tint(c, 1, shade(a, -0.32));
  rrect(x, u, 7.4, 7.4, 17.2, 17.2, 3, a, OUTLINE);
  poly(x, u, [7.4, 24.6, 24.6, 24.6, 24.6, 7.4], b);
  rect(x, u, 9.6, 9.6, 6.4, 2, shade(a, 0.32));
}

/**
 * Pattern name -> painter. Every family named by `game/items.js#itemIcon` has
 * an entry; anything else falls back to {@link paintGeneric}.
 * @type {Readonly<Object<string, function(CanvasRenderingContext2D, number, readonly string[]):void>>}
 */
const PAINTERS = Object.freeze({
  pickaxe: paintPickaxe,
  axe: paintAxe,
  shovel: paintShovel,
  sword: paintSword,
  hoe: paintHoe,
  helmet: paintHelmet,
  chestplate: paintChestplate,
  leggings: paintLeggings,
  boots: paintBoots,
  bow: paintBow,
  crossbow: paintCrossbow,
  arrow: paintArrow,
  shield: paintShield,
  shears: paintShears,
  fishing_rod: paintFishingRod,
  flint_and_steel: paintFlintAndSteel,
  bucket: paintBucket,
  bottle: paintBottle,
  ingot: paintIngot,
  nugget: paintNugget,
  gem: paintGem,
  shard: paintShard,
  dust: paintDust,
  coal: paintCoal,
  flint: paintFlint,
  ball: paintBall,
  snowball: paintBall,
  rod: paintRod,
  stick: paintStick,
  string: paintString,
  feather: paintFeather,
  leather: paintLeather,
  bone: paintBone,
  brick: paintBrick,
  paper: paintPaper,
  book: paintBook,
  seed: paintSeed,
  wheat: paintWheat,
  meat: paintMeat,
  food_round: paintFoodRound,
  fish: paintFish,
  stew: paintStew,
  bowl: paintBowl,
  potato: paintPotato,
  carrot: paintCarrot,
  slice: paintSlice,
  pie: paintPie,
  cake: paintCake,
  bread: paintBread,
  cookie: paintCookie,
  egg: paintEgg,
  boat: paintBoat,
  minecart: paintMinecart,
  saddle: paintSaddle,
  map: paintMap,
  compass: paintCompass,
  clock: paintClock,
  name_tag: paintNameTag,
  disc: paintDisc,
  dye: paintDye,
  spawn_egg: paintSpawnEgg,
  sapling: paintSapling,
});

/**
 * Draw one procedural item sprite onto a 2D context. The context is *not*
 * cleared — callers own that — and the shape is authored on a 32x32 grid that
 * is scaled to `size`.
 *
 * @param {CanvasRenderingContext2D} ctx destination context
 * @param {string} pattern shape family from `game/items.js#itemIcon`
 * @param {readonly string[]} colors tints for the family, most important first
 * @param {number} size edge length of the target square in pixels
 * @returns {void}
 */
export function drawItemSprite(ctx, pattern, colors, size) {
  if (!ctx || !(size > 0)) return;
  if (pattern === 'empty') return;
  const painter = PAINTERS[pattern] || paintGeneric;
  const u = size / 32;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;
  try {
    painter(ctx, u, colors || []);
  } catch (err) {
    warnOnce(`sprite:${pattern}`, `sprite "${pattern}" could not be drawn`, err);
  }
  ctx.restore();
}

/* ========================================================================== */
/* Item icon cache                                                            */
/* ========================================================================== */

/**
 * Data URLs for every item icon the UI needs.
 *
 * Block items are drawn by the renderer as real isometric 3D previews through
 * `render/textures.js#renderBlockIcons`. Requests made in the same frame are
 * collected and answered with a **single** call; the resulting PNG data URLs
 * are cached forever. Everything else is a procedural sprite drawn once onto a
 * shared canvas by {@link drawItemSprite}.
 *
 * The cache is deliberately independent of {@link HUD} so `ui/inventory_ui.js`
 * can share the same instance (`game.ui.hud.icons`).
 */
export class ItemIconCache {
  /**
   * @param {?Object} [renderer] the `Renderer`; may be attached later with
   *   {@link ItemIconCache#setRenderer}
   * @param {number} [size] icon edge length in pixels
   */
  constructor(renderer = null, size = ICON_SIZE) {
    /** @type {?Object} the renderer used for block previews */
    this.renderer = renderer || null;
    /** @type {number} icon edge length in pixels */
    this.size = Math.max(16, Math.min(256, size | 0));
    /**
     * Called after a batch of block icons resolved, so views can re-read the
     * URLs of the slots they already drew.
     * @type {?function():void}
     */
    this.onIconsReady = null;

    /** @type {Map<number,string>} item id -> data URL (`''` = not resolved yet) @private */
    this._byItem = new Map();
    /** @type {Map<string,string>} icon key -> data URL @private */
    this._byKey = new Map();
    /** @type {Set<number>} block ids waiting for the next batch @private */
    this._queue = new Set();
    /** @type {Map<number,number>} item id -> block id it is waiting for @private */
    this._waiting = new Map();
    /** @type {number} pending flush timer id, `0` when idle @private */
    this._timer = 0;
    /** @type {boolean} true while a `renderBlockIcons` call is in flight @private */
    this._busy = false;
    /** @type {number} consecutive attempts made without a usable renderer @private */
    this._retries = 0;
    /** @type {?HTMLCanvasElement} shared sprite canvas @private */
    this._canvas = null;
    /** @type {?CanvasRenderingContext2D} shared sprite context @private */
    this._ctx = null;
    /** @type {boolean} true once disposed @private */
    this._disposed = false;
  }

  /**
   * Attach (or replace) the renderer used for block previews. Any block icons
   * still queued are retried against the new one.
   * @param {?Object} renderer the `Renderer` instance
   * @returns {void}
   */
  setRenderer(renderer) {
    if (this.renderer === renderer) return;
    this.renderer = renderer || null;
    this._retries = 0;
    if (this._queue.size > 0) this._schedule();
  }

  /**
   * Data URL for an item's icon.
   *
   * Block items return `''` until the renderer has produced their preview; the
   * request is queued and {@link ItemIconCache#onIconsReady} fires once it is
   * available. Sprites are always returned immediately.
   *
   * @param {number} itemId item id from `game/items.js`
   * @returns {string} a `data:image/png;base64,…` URL, or `''`
   */
  get(itemId) {
    const id = itemId | 0;
    if (id <= 0 || this._disposed) return '';
    const known = this._byItem.get(id);
    if (known !== undefined && known !== '') return known;

    let icon = null;
    try {
      icon = itemIcon(id);
    } catch (err) {
      warnOnce('icon:lookup', 'an item icon descriptor could not be read', err);
    }
    if (!icon) {
      this._byItem.set(id, '');
      return '';
    }

    if (icon.type === 'block') {
      const key = `b${icon.blockId}`;
      const url = this._byKey.get(key);
      if (url !== undefined) {
        this._byItem.set(id, url);
        return url;
      }
      if (!this._waiting.has(id)) {
        this._waiting.set(id, icon.blockId | 0);
        this._queue.add(icon.blockId | 0);
        this._schedule();
      }
      return '';
    }

    const key = `s${icon.pattern}|${(icon.colors || []).join(',')}`;
    let url = this._byKey.get(key);
    if (url === undefined) {
      url = this._paint(icon.pattern, icon.colors || []);
      this._byKey.set(key, url);
    }
    this._byItem.set(id, url);
    return url;
  }

  /**
   * Request the icons of a whole list of items up front, so the renderer sees
   * one batch instead of one call per slot.
   * @param {Iterable<number>} itemIds item ids to resolve
   * @returns {void}
   */
  warmup(itemIds) {
    if (this._disposed || !itemIds) return;
    for (const id of itemIds) this.get(id);
  }

  /**
   * Draw one procedural sprite and return it as a data URL.
   * @param {string} pattern sprite family
   * @param {readonly string[]} colors tints
   * @returns {string} data URL, `''` when no canvas is available
   * @private
   */
  _paint(pattern, colors) {
    if (typeof document === 'undefined') return '';
    if (this._ctx === null) {
      const canvas = document.createElement('canvas');
      canvas.width = this.size;
      canvas.height = this.size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        warnOnce('icon:2d', 'no 2D context — item sprites are unavailable');
        return '';
      }
      this._canvas = canvas;
      this._ctx = ctx;
    }
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this.size, this.size);
    drawItemSprite(ctx, pattern, colors, this.size);
    try {
      return this._canvas.toDataURL('image/png');
    } catch (err) {
      warnOnce('icon:dataurl', 'a sprite could not be encoded', err);
      return '';
    }
  }

  /**
   * Queue the batched block-icon render for the end of the current task.
   * @returns {void}
   * @private
   */
  _schedule() {
    if (this._disposed || this._busy || this._timer !== 0) return;
    if (typeof setTimeout !== 'function') return;
    this._timer = setTimeout(() => {
      this._timer = 0;
      this._flush();
    }, 0);
  }

  /**
   * Ask the renderer for every queued block preview in one call.
   * @returns {void}
   * @private
   */
  _flush() {
    if (this._disposed || this._busy || this._queue.size === 0) return;
    const textures = this.renderer && this.renderer.textures;
    if (!textures || typeof textures.renderBlockIcons !== 'function' || textures.ready !== true) {
      this._retryLater();
      return;
    }
    const ids = Array.from(this._queue);
    this._queue.clear();
    this._busy = true;
    let promise = null;
    try {
      promise = textures.renderBlockIcons(ids, this.size);
    } catch (err) {
      this._busy = false;
      this._giveUp(ids, 'renderBlockIcons threw', err);
      return;
    }
    Promise.resolve(promise).then((map) => {
      this._busy = false;
      if (this._disposed) return;
      this._absorb(ids, map);
    }).catch((err) => {
      this._busy = false;
      if (this._disposed) return;
      this._giveUp(ids, 'renderBlockIcons rejected', err);
    });
  }

  /**
   * Store a finished batch and notify the views.
   * @param {number[]} ids block ids that were requested
   * @param {?Map<number,string>} map renderer result
   * @returns {void}
   * @private
   */
  _absorb(ids, map) {
    this._retries = 0;
    for (let i = 0; i < ids.length; i++) {
      const blockId = ids[i];
      const url = map && typeof map.get === 'function' ? map.get(blockId) : undefined;
      this._byKey.set(`b${blockId}`, typeof url === 'string' && url.length > 0
        ? url : this._fallbackCube(blockId));
    }
    for (const [itemId, blockId] of this._waiting) {
      const url = this._byKey.get(`b${blockId}`);
      if (url === undefined) continue;
      this._byItem.set(itemId, url);
      this._waiting.delete(itemId);
    }
    if (this._queue.size > 0) this._schedule();
    if (typeof this.onIconsReady === 'function') {
      try {
        this.onIconsReady();
      } catch (err) {
        warnOnce('icon:notify', 'an icon listener failed', err);
      }
    }
  }

  /**
   * Retry a batch a little later while the renderer is still booting.
   * @returns {void}
   * @private
   */
  _retryLater() {
    this._retries++;
    if (this._retries > 80) {
      const ids = Array.from(this._queue);
      this._queue.clear();
      this._giveUp(ids, 'the renderer never produced block icons', null);
      return;
    }
    if (typeof setTimeout !== 'function' || this._timer !== 0) return;
    this._timer = setTimeout(() => {
      this._timer = 0;
      this._flush();
    }, 250);
  }

  /**
   * Fall back to a flat cube for block ids the renderer cannot draw.
   * @param {number[]} ids block ids to resolve with the fallback
   * @param {string} why reason for the log line
   * @param {*} err optional error
   * @returns {void}
   * @private
   */
  _giveUp(ids, why, err) {
    warnOnce('icon:blocks', `${why} — using flat block icons`, err);
    for (let i = 0; i < ids.length; i++) {
      this._byKey.set(`b${ids[i]}`, this._fallbackCube(ids[i]));
    }
    this._absorb([], null);
  }

  /**
   * A neutral isometric cube, used when no GPU preview can be produced.
   * @param {number} blockId block id (only used to vary the hue slightly)
   * @returns {string} data URL, `''` without a canvas
   * @private
   */
  _fallbackCube(blockId) {
    const key = `cube${blockId & 7}`;
    const known = this._byKey.get(key);
    if (known !== undefined) return known;
    if (typeof document === 'undefined') return '';
    const hue = 200 + (blockId & 7) * 12;
    const top = `hsl(${hue}, 12%, 62%)`;
    const left = `hsl(${hue}, 12%, 44%)`;
    const right = `hsl(${hue}, 12%, 33%)`;
    if (this._ctx === null) this._paint('empty', []);
    if (this._ctx === null) return '';
    const ctx = this._ctx;
    const u = this.size / 32;
    ctx.clearRect(0, 0, this.size, this.size);
    ctx.save();
    ctx.lineJoin = 'round';
    poly(ctx, u, [16, 4, 28, 11, 16, 18, 4, 11], top, OUTLINE, 0.8);
    poly(ctx, u, [4, 11, 16, 18, 16, 28, 4, 21], left, OUTLINE, 0.8);
    poly(ctx, u, [28, 11, 28, 21, 16, 28, 16, 18], right, OUTLINE, 0.8);
    ctx.restore();
    let url = '';
    try {
      url = this._canvas.toDataURL('image/png');
    } catch (err) {
      warnOnce('icon:dataurl', 'a fallback cube could not be encoded', err);
    }
    this._byKey.set(key, url);
    return url;
  }

  /**
   * Drop every cached icon and cancel pending work.
   * @returns {void}
   */
  dispose() {
    this._disposed = true;
    if (this._timer !== 0 && typeof clearTimeout === 'function') clearTimeout(this._timer);
    this._timer = 0;
    this._byItem.clear();
    this._byKey.clear();
    this._queue.clear();
    this._waiting.clear();
    this.onIconsReady = null;
    this.renderer = null;
    this._canvas = null;
    this._ctx = null;
  }
}

/* ========================================================================== */
/* Inline SVG glyphs                                                          */
/* ========================================================================== */

/**
 * Bar icons. `fill="currentColor"` picks up `--tint` from `.vx-bar__icon`.
 * @type {Readonly<Object<string, string>>}
 */
const BAR_ICONS = Object.freeze({
  health: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21.2C10.2 19.8 3 15 3 9.7 3 6.6 5.3 4.4 8.1 4.4c1.7 0 3.2.9 3.9 2.2.7-1.3 2.2-2.2 3.9-2.2C18.7 4.4 21 6.6 21 9.7c0 5.3-7.2 10.1-9 11.5z"/></svg>',
  hunger: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.6 3c2.8 0 5 2.3 5 5.1 0 2.5-1.6 4.4-4 5l-1.4 1.4 1.5 1.5c.5.5.5 1.3 0 1.8l-1 1c-.5.5-1.3.5-1.8 0l-1.5-1.5-3.6 3.6c-.9.9-2.3.9-3.2 0l-.5-.5c-.9-.9-.9-2.3 0-3.2l7.7-7.7c.2-.5.3-1 .3-1.5C13.1 5.3 14.2 3 15.6 3z"/></svg>',
  armor: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.2 4 5v6.4c0 5 3.4 9.4 8 10.6 4.6-1.2 8-5.6 8-10.6V5z"/></svg>',
  air: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.4" fill="currentColor"/><circle cx="9.2" cy="9" r="2.1" fill="rgba(255,255,255,.75)"/></svg>',
  mount: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 20c0-4 2-6.6 5-8l-1.4-3L4 8V5.4l5-1.4 2.6 5.2h4.6c2.6 0 4.8 2.2 4.8 4.8V20h-3v-4.6c0-1-.8-1.8-1.8-1.8h-3.3C9.6 13.6 7 16.3 7 20z"/></svg>',
});

/**
 * Glyphs used inside `.vx-effect__icon`.
 * @type {Readonly<Object<string, string>>}
 */
const EFFECT_GLYPHS = Object.freeze({
  arrow: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M12 3 5 12h4v9h6v-9h4z"/></svg>',
  pick: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M3 9c3-4 7-6 11-6-3 1-5 3-6 5l3 3c2-1 4-3 5-6 0 4-2 8-6 11l-1-1-6 6-2-2 6-6z"/></svg>',
  fist: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M6 9h12a3 3 0 0 1 3 3v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-5a2 2 0 0 1 2-2zm2-4h2v3H8zm4-1h2v4h-2zm4 1h2v3h-2z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M12 20.5C10.4 19.2 4 15 4 10.3 4 7.7 5.9 5.9 8.2 5.9c1.5 0 2.9.8 3.8 2 .9-1.2 2.3-2 3.8-2 2.3 0 4.2 1.8 4.2 4.4 0 4.7-6.4 8.9-8 10.2z"/></svg>',
  skull: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M12 3c4.4 0 8 3.3 8 7.4 0 2.5-1.3 4.6-3.3 5.9V19a2 2 0 0 1-2 2h-5.4a2 2 0 0 1-2-2v-2.7C5.3 15 4 12.9 4 10.4 4 6.3 7.6 3 12 3zm-3 7a1.8 1.8 0 1 0 0 3.6A1.8 1.8 0 0 0 9 10zm6 0a1.8 1.8 0 1 0 0 3.6A1.8 1.8 0 0 0 15 10z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M12 2.5 4.5 5v6.2c0 4.7 3.2 8.8 7.5 9.9 4.3-1.1 7.5-5.2 7.5-9.9V5z"/></svg>',
  flame: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M13 2c.6 3.4-1.2 4.8-2.7 6.2C8.6 9.8 7 11.3 7 14.2 7 18 10 21 13 21s5.6-2.6 5.6-6.3c0-4.5-3.2-5.9-3.2-9.1 0 1.9-1 3-2.1 3.7.6-2.4.4-5-.3-7.3z"/></svg>',
  drop: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M12 2.5c3.6 4.6 6.5 8.2 6.5 11.6A6.5 6.5 0 0 1 5.5 14C5.5 10.7 8.4 7.1 12 2.5z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M12 5c5 0 9 4.4 10 7-1 2.6-5 7-10 7S3 14.6 2 12c1-2.6 5-7 10-7zm0 3.4A3.6 3.6 0 1 0 12 15.6 3.6 3.6 0 0 0 12 8.4z"/></svg>',
  food: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M7 2h2v8a2 2 0 0 1-4 0V2h2zm-2 0v6h2V2zm11 0c2 0 3 3 3 7 0 2.4-1 3.6-2 4v9h-2v-9c-1-.4-2-1.6-2-4 0-4 1-7 3-7z"/></svg>',
  swirl: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" d="M12 18a6 6 0 1 1 6-6 4 4 0 1 1-4 4 2.5 2.5 0 1 0 2.5-2.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="m12 2.8 2.7 6.1 6.6.6-5 4.4 1.5 6.5-5.8-3.5-5.8 3.5L7.7 14l-5-4.4 6.6-.6z"/></svg>',
});

/**
 * Glyph markup for an effect type.
 * @param {string} type effect id
 * @returns {string} inline SVG markup
 */
function effectGlyph(type) {
  const meta = EFFECTS[type];
  const key = meta ? meta.glyph : 'star';
  return EFFECT_GLYPHS[key] || EFFECT_GLYPHS.star;
}

/**
 * German display name of a status effect.
 * @param {string} type effect id
 * @returns {string} the German name (the raw id for unknown effects)
 */
function effectName(type) {
  const meta = EFFECTS[type];
  return meta ? meta.de : String(type);
}

/**
 * Tint of a status effect.
 * @param {string} type effect id
 * @returns {string} a CSS colour
 */
function effectColor(type) {
  const meta = EFFECTS[type];
  return meta ? meta.color : '#2b6fd0';
}

/* ========================================================================== */
/* HUD                                                                        */
/* ========================================================================== */

/**
 * The in-game overlay: crosshair, vitals, hotbar, effects, toasts and tints.
 *
 * The whole DOM is built once in the constructor and then only *updated*.
 * `update(dt)` must be called once per rendered frame from `game.frame()`; it
 * never throws and writes to the DOM only where a value actually changed.
 */
export class HUD {
  /**
   * @param {*} game the `Game` instance — duck-typed throughout, so a partially
   *   booted game (no player, no renderer yet) is fine
   * @param {HTMLElement} root the `#ui` root element
   */
  constructor(game, root) {
    /** @type {*} the game */
    this.game = game || null;
    /** @type {?HTMLElement} the `#ui` root */
    this.root = root || null;
    /** @type {boolean} whether the overlay is currently shown */
    this.visible = true;
    /** @type {?ItemIconCache} shared icon cache (also used by the inventory UI) */
    this.icons = null;
    /** @type {?HTMLElement} the overlay root element */
    this.el = null;
    /** @type {boolean} true once {@link HUD#dispose} ran @private */
    this._disposed = false;
    /** @type {boolean} false when there is no DOM to work with @private */
    this._ok = typeof document !== 'undefined' && this.root !== null &&
      typeof this.root.appendChild === 'function';

    if (!this._ok) {
      warnOnce('dom', 'no DOM root — the HUD stays inert');
      return;
    }

    this.icons = new ItemIconCache(game && game.renderer ? game.renderer : null);
    this.icons.onIconsReady = () => { this._iconEpoch++; };

    /** @type {number} bumped whenever new block icons arrived @private */
    this._iconEpoch = 0;
    /** @type {number} icon epoch already applied to the hotbar @private */
    this._iconApplied = -1;

    this._buildDom();
    this._initState();
    this._applyGuiScale();
    this._rebind();
  }

  /* ====================================================================== */
  /* Construction                                                           */
  /* ====================================================================== */

  /**
   * Build the complete overlay. Runs exactly once.
   * @returns {void}
   * @private
   */
  _buildDom() {
    const hud = el('div', 'vx-hud vx-layer');
    this.el = hud;

    /* -- crosshair ------------------------------------------------------- */
    const cross = el('div', 'vx-crosshair');
    const arms = ['n', 's', 'w', 'e'];
    for (let i = 0; i < arms.length; i++) {
      cross.appendChild(el('i', `vx-crosshair__arm vx-crosshair__arm--${arms[i]}`));
    }
    cross.appendChild(el('i', 'vx-crosshair__dot'));
    const hit = svg('<svg class="vx-crosshair__hit" viewBox="0 0 26 26" aria-hidden="true">' +
      '<line x1="5.5" y1="5.5" x2="9.5" y2="9.5"/>' +
      '<line x1="20.5" y1="5.5" x2="16.5" y2="9.5"/>' +
      '<line x1="5.5" y1="20.5" x2="9.5" y2="16.5"/>' +
      '<line x1="20.5" y1="20.5" x2="16.5" y2="16.5"/></svg>');
    cross.appendChild(hit);
    hud.appendChild(cross);
    /** @type {HTMLElement} @private */
    this._cross = cross;
    /** @type {Element} @private */
    this._hit = hit;

    /* -- top left: frame rate -------------------------------------------- */
    const topLeft = el('div', 'vx-hud__topleft');
    const fps = el('div', 'vx-fps is-hidden', '');
    topLeft.appendChild(fps);
    hud.appendChild(topLeft);
    /** @type {HTMLElement} @private */
    this._fpsNode = fps;

    /* -- top right: effects + mount -------------------------------------- */
    const topRight = el('div', 'vx-hud__topright');
    const effects = el('div', 'vx-effects');
    topRight.appendChild(effects);
    const mount = el('div', 'vx-mount is-hidden');
    const mountName = el('div', 'vx-mount__name', '');
    const mountBar = this._makeBar('mount', 'mount', 10, false);
    mount.appendChild(mountName);
    mount.appendChild(mountBar.root);
    topRight.appendChild(mount);
    hud.appendChild(topRight);
    /** @type {HTMLElement} @private */
    this._effectsNode = effects;
    /** @type {HTMLElement} @private */
    this._mountNode = mount;
    /** @type {HTMLElement} @private */
    this._mountName = mountName;
    /** @type {Object} @private */
    this._mountBar = mountBar;

    /* -- pickup ticker & centre message ---------------------------------- */
    const pickups = el('div', 'vx-pickups');
    hud.appendChild(pickups);
    /** @type {HTMLElement} @private */
    this._pickupsNode = pickups;

    const message = el('div', 'vx-message', '');
    hud.appendChild(message);
    /** @type {HTMLElement} @private */
    this._messageNode = message;

    /* -- bottom cluster --------------------------------------------------- */
    const bottom = el('div', 'vx-hud__bottom');

    const bars = el('div', 'vx-bars');
    const left = el('div', 'vx-bars__left');
    const right = el('div', 'vx-bars__right');
    /** @type {Object} @private */
    this._healthBar = this._makeBar('health', 'health', 10, true);
    /** @type {Object} @private */
    this._armorBar = this._makeBar('armor', 'armor', 10, true);
    /** @type {Object} @private */
    this._hungerBar = this._makeBar('hunger', 'hunger', 10, true);
    /** @type {Object} @private */
    this._airBar = this._makeBar('air', 'air', 10, true);
    left.appendChild(this._healthBar.root);
    left.appendChild(this._armorBar.root);
    right.appendChild(this._hungerBar.root);
    right.appendChild(this._airBar.root);
    bars.appendChild(left);
    bars.appendChild(right);
    bottom.appendChild(bars);

    const xp = el('div', 'vx-xp');
    const xpLevel = el('div', 'vx-xp__level is-off', '0');
    const xpTrack = el('div', 'vx-xp__track');
    const xpFill = el('i', 'vx-xp__fill');
    xpTrack.appendChild(xpFill);
    xp.appendChild(xpLevel);
    xp.appendChild(xpTrack);
    bottom.appendChild(xp);
    /** @type {HTMLElement} @private */
    this._xpLevel = xpLevel;
    /** @type {HTMLElement} @private */
    this._xpFill = xpFill;

    const itemName = el('div', 'vx-itemname', '');
    bottom.appendChild(itemName);
    /** @type {HTMLElement} @private */
    this._itemName = itemName;

    const hotbar = el('div', 'vx-hotbar');
    /** @type {Object[]} @private */
    this._slots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = el('div', 'vx-hotbar__slot');
      const key = el('span', 'vx-hotbar__key', String(i + 1));
      const icon = /** @type {HTMLImageElement} */ (el('img', 'vx-hotbar__icon'));
      icon.alt = '';
      icon.decoding = 'async';
      icon.draggable = false;
      icon.hidden = true;
      const count = el('span', 'vx-hotbar__count', '');
      count.classList.add('is-hidden');
      const dura = el('div', 'vx-hotbar__dura is-hidden');
      const duraFill = el('i');
      dura.appendChild(duraFill);
      const cool = el('div', 'vx-hotbar__cool');
      slot.appendChild(key);
      slot.appendChild(icon);
      slot.appendChild(count);
      slot.appendChild(dura);
      slot.appendChild(cool);
      hotbar.appendChild(slot);
      this._slots.push({ root: slot, icon, count, dura, duraFill, cool });
    }
    bottom.appendChild(hotbar);
    hud.appendChild(bottom);
    /** @type {HTMLElement} @private */
    this._hotbar = hotbar;

    /* -- full-screen tints ------------------------------------------------ */
    const fx = el('div', 'vx-fx');
    const wet = el('div', 'vx-vignette vx-vignette--wet');
    const drown = el('div', 'vx-vignette vx-vignette--drown');
    const low = el('div', 'vx-vignette vx-vignette--low');
    const damage = el('div', 'vx-vignette vx-vignette--damage');
    fx.appendChild(wet);
    fx.appendChild(drown);
    fx.appendChild(low);
    fx.appendChild(damage);
    hud.appendChild(fx);
    /** @type {HTMLElement} @private */
    this._wetNode = wet;
    /** @type {HTMLElement} @private */
    this._drownNode = drown;
    /** @type {HTMLElement} @private */
    this._lowNode = low;
    /** @type {HTMLElement} @private */
    this._damageNode = damage;

    this.root.appendChild(hud);

    /* Toasts live outside `.vx-hud` so they keep their own stacking context
       and stay readable while a screen is open. */
    const toasts = el('div', 'vx-toasts');
    this.root.appendChild(toasts);
    /** @type {HTMLElement} @private */
    this._toastsNode = toasts;
  }

  /**
   * Build one segmented stat bar.
   * @param {string} kind modifier suffix (`health`, `hunger`, `armor`, `air`, `mount`)
   * @param {string} icon key into {@link BAR_ICONS}
   * @param {number} segs number of segments
   * @param {boolean} withValue whether the numeric readout is shown
   * @returns {{root:HTMLElement, fill:HTMLElement, ghost:HTMLElement,
   *   flash:HTMLElement, icon:HTMLElement, value:?HTMLElement}} the bar parts
   * @private
   */
  _makeBar(kind, icon, segs, withValue) {
    const root = el('div', `vx-bar vx-bar--${kind}`);
    root.style.setProperty('--segs', String(segs));
    root.style.setProperty('--v', '1');
    root.style.setProperty('--ghost', '1');

    const iconBox = el('div', 'vx-bar__icon');
    iconBox.appendChild(svg(BAR_ICONS[icon] || BAR_ICONS.health));
    root.appendChild(iconBox);

    const track = el('div', 'vx-bar__track');
    const ghost = el('i', 'vx-bar__ghost');
    const fill = el('i', 'vx-bar__fill');
    const segments = el('i', 'vx-bar__segments');
    const flash = el('i', 'vx-bar__flash');
    track.appendChild(ghost);
    track.appendChild(fill);
    track.appendChild(segments);
    track.appendChild(flash);
    root.appendChild(track);

    let value = null;
    if (withValue) {
      value = el('div', 'vx-bar__value', '0');
      root.appendChild(value);
    }
    return { root, fill, ghost, flash, icon: iconBox, value };
  }

  /**
   * Reset every cached view value and timer.
   * @returns {void}
   * @private
   */
  _initState() {
    /**
     * Last value written per widget. `NaN` / `null` force the first write.
     * @type {Object<string, *>}
     * @private
     */
    this._v = {
      health: NaN, healthSegs: -1, hunger: NaN, armor: NaN, air: NaN,
      xp: NaN, level: -1, selected: -1, cool: -1,
      low: null, starving: null, critical: null,
      armorOn: null, airOn: null, levelOff: null,
      focus: null, dim: null, showFps: null, fpsText: '',
      damage: -1, lowTint: -1, drown: -1, wet: -1,
      itemName: '', itemRarity: '', mountShown: null, mountName: '',
    };

    /** @type {string[]} per-slot cache key (item, count, wear) @private */
    this._slotKey = new Array(HOTBAR_SIZE).fill('');
    /** @type {string[]} per-slot icon URL currently assigned @private */
    this._slotIcon = new Array(HOTBAR_SIZE).fill('');

    /** @type {number} remaining seconds of the centre message @private */
    this._messageTimer = 0;
    /** @type {number} remaining seconds of the item-name label @private */
    this._nameTimer = 0;
    /** @type {number} damage vignette intensity `0..1` @private */
    this._damage = 0;
    /** @type {number} seconds until the next FPS readout @private */
    this._fpsTimer = 0;
    /** @type {number} accumulated frame time for the FPS readout @private */
    this._fpsAccum = 0;
    /** @type {number} frames counted for the FPS readout @private */
    this._fpsFrames = 0;
    /** @type {number} seconds until the next external effect poll @private */
    this._effectPoll = 0;
    /** @type {number} item id whose name the label currently shows @private */
    this._nameItem = -1;

    /** @type {Map<string, Object>} live status effects by type @private */
    this._effects = new Map();
    /** @type {Object[]} live toasts @private */
    this._toasts = [];
    /** @type {Object[]} live pickup rows @private */
    this._pickups = [];
    /** @type {Set<number>} pending `setTimeout` ids, cleared on dispose @private */
    this._timers = new Set();
    /** @type {?Object} the entity whose health the mount bar shows @private */
    this._mount = null;

    /** @type {Array<{bus:Object, evt:string, fn:Function}>} subscriptions @private */
    this._subs = [];
    /**
     * Buses this HUD is currently subscribed to, so {@link HUD#_rebind} can
     * detect a swapped world without re-subscribing every frame.
     * @type {Object<string, ?Object>}
     * @private
     */
    this._bound = {
      player: null, inventory: null, combat: null, entities: null,
      interaction: null, settings: null, renderer: null,
    };
  }

  /**
   * Mirror `settings.guiScale` onto the document root, which is what every
   * dimension in `ui/style.css` is expressed in.
   * @returns {void}
   * @private
   */
  _applyGuiScale() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const settings = this.game && this.game.settings ? this.game.settings : null;
    let scale = 1;
    if (settings && typeof settings.get === 'function') {
      scale = num(settings.get('guiScale'), 1);
    }
    scale = clamp(scale, 0.5, 2.5);
    document.documentElement.style.setProperty('--gui-scale', String(scale));
  }

  /* ====================================================================== */
  /* Event wiring                                                           */
  /* ====================================================================== */

  /**
   * Subscribe to an event bus and remember it for {@link HUD#dispose}.
   * @param {?Object} bus anything with `on`/`off`
   * @param {string} evt event name
   * @param {Function} fn handler
   * @returns {void}
   * @private
   */
  _bind(bus, evt, fn) {
    if (!bus || typeof bus.on !== 'function') return;
    try {
      bus.on(evt, fn);
      this._subs.push({ bus, evt, fn });
    } catch (err) {
      warnOnce(`bind:${evt}`, `could not subscribe to "${evt}"`, err);
    }
  }

  /**
   * Drop every subscription made on one bus.
   * @param {?Object} bus the bus to detach from
   * @returns {void}
   * @private
   */
  _unbindBus(bus) {
    if (!bus) return;
    const keep = [];
    for (let i = 0; i < this._subs.length; i++) {
      const sub = this._subs[i];
      if (sub.bus !== bus) {
        keep.push(sub);
        continue;
      }
      try {
        if (typeof bus.off === 'function') bus.off(sub.evt, sub.fn);
      } catch (err) {
        warnOnce('unbind', 'a listener could not be removed', err);
      }
    }
    this._subs = keep;
  }

  /**
   * Drop every subscription.
   * @returns {void}
   * @private
   */
  _unbindAll() {
    for (let i = 0; i < this._subs.length; i++) {
      const sub = this._subs[i];
      try {
        if (sub.bus && typeof sub.bus.off === 'function') sub.bus.off(sub.evt, sub.fn);
      } catch (err) {
        warnOnce('unbind', 'a listener could not be removed', err);
      }
    }
    this._subs.length = 0;
    for (const key in this._bound) this._bound[key] = null;
  }

  /**
   * Attach to whichever subsystems the game currently exposes. Called once per
   * frame; it costs seven reference comparisons unless a world was swapped.
   * @returns {void}
   * @private
   */
  _rebind() {
    const game = this.game;
    if (!game) return;
    const player = game.player || null;
    const inventory = (player && player.inventory) || game.inventory || null;
    const combat = game.combat || null;
    const entities = game.entities || null;
    const interaction = game.interaction || null;
    const settings = game.settings || null;
    const renderer = game.renderer || null;
    const b = this._bound;

    if (b.renderer !== renderer) {
      b.renderer = renderer;
      if (this.icons) this.icons.setRenderer(renderer);
    }

    if (b.player !== player) {
      this._unbindBus(b.player);
      b.player = player;
      this._bind(player, 'damage', this._onPlayerDamage);
      this._bind(player, 'death', this._onPlayerDeath);
      this._bind(player, 'respawn', this._onPlayerRespawn);
      this._bind(player, 'levelup', this._onLevelUp);
      this._bind(player, 'eat', this._onEat);
      this._resetVitalsCache();
    }

    if (b.inventory !== inventory) {
      this._unbindBus(b.inventory);
      b.inventory = inventory;
      this._bind(inventory, 'select', this._onSelect);
      this._bind(inventory, 'break', this._onToolBreak);
      for (let i = 0; i < HOTBAR_SIZE; i++) this._slotKey[i] = '';
    }

    if (b.combat !== combat) {
      this._unbindBus(b.combat);
      b.combat = combat;
      this._bind(combat, 'attack', this._onAttack);
      this._bind(combat, 'kill', this._onKill);
    }

    if (b.entities !== entities) {
      this._unbindBus(b.entities);
      b.entities = entities;
      this._bind(entities, 'itemPickup', this._onItemPickup);
      this._bind(entities, 'xpCollected', this._onXPCollected);
    }

    if (b.interaction !== interaction) {
      this._unbindBus(b.interaction);
      b.interaction = interaction;
      this._bind(interaction, 'message', this._onInteractionMessage);
    }

    if (b.settings !== settings) {
      this._unbindBus(b.settings);
      b.settings = settings;
      this._bind(settings, 'change:guiScale', this._onGuiScale);
      this._applyGuiScale();
    }
  }

  /**
   * Force the next frame to rewrite every vitals widget.
   * @returns {void}
   * @private
   */
  _resetVitalsCache() {
    const v = this._v;
    v.health = NaN;
    v.hunger = NaN;
    v.armor = NaN;
    v.air = NaN;
    v.xp = NaN;
    v.level = -1;
    v.selected = -1;
  }

  /* ---- handlers (bound once so `off()` can find them) ------------------- */

  /**
   * The player took damage: flash the health bar and pulse the vignette.
   * @param {number} amount applied damage in half-hearts
   * @returns {void}
   * @private
   */
  _onPlayerDamage = (amount) => {
    if (this._disposed) return;
    const hit = num(amount, 0);
    if (hit <= 0) return;
    this.flashDamage(clamp(0.45 + hit * 0.08, 0.45, 1));
    restart(this._healthBar.flash, 'flash-a', 'flash-b');
  };

  /**
   * The player died: clear the transient overlays.
   * @returns {void}
   * @private
   */
  _onPlayerDeath = () => {
    if (this._disposed) return;
    this._damage = 1;
    this.setMessage('', 0);
    this.clearEffects();
  };

  /**
   * The player respawned: reset every animated overlay.
   * @returns {void}
   * @private
   */
  _onPlayerRespawn = () => {
    if (this._disposed) return;
    this._damage = 0;
    this._resetVitalsCache();
    this.clearEffects();
  };

  /**
   * A new experience level: pop the level number.
   * @param {number} level the new level
   * @returns {void}
   * @private
   */
  _onLevelUp = (level) => {
    if (this._disposed) return;
    restart(this._xpLevel, 'pop-a', 'pop-b');
    const n = Math.max(0, Math.round(num(level, 0)));
    this.showToast('Stufe ' + n, 'Erfahrungsstufe erreicht', '✨', 'achievement');
  };

  /**
   * Something was eaten: apply the guaranteed status effects of the food.
   * @param {number} itemId the eaten item
   * @param {?Object} food the `FoodDef` of that item
   * @returns {void}
   * @private
   */
  _onEat = (itemId, food) => {
    if (this._disposed || !food || !food.effects) return;
    const list = food.effects;
    for (let i = 0; i < list.length; i++) {
      const fx = list[i];
      if (!fx || typeof fx.type !== 'string') continue;
      if (fx.type === 'clear_effects') {
        this.clearEffects();
        continue;
      }
      if (fx.type === 'cure_poison') {
        this.clearEffect('poison');
        this.clearEffect('wither');
        continue;
      }
      if (fx.type === 'teleport') continue;
      if (num(fx.chance, 1) < 1) continue;
      this.setEffect(fx.type, num(fx.duration, 0), num(fx.amplifier, 0));
    }
  };

  /**
   * The hotbar selection changed: show the item name for a moment.
   * @returns {void}
   * @private
   */
  _onSelect = () => {
    if (this._disposed) return;
    this._nameItem = -1;
  };

  /**
   * A tool broke: tell the player which one.
   * @param {number} index slot index
   * @param {number} itemId the item that broke
   * @returns {void}
   * @private
   */
  _onToolBreak = (index, itemId) => {
    if (this._disposed) return;
    let name = 'Gegenstand';
    try {
      name = itemDisplay(itemId | 0);
    } catch (err) {
      warnOnce('break:name', 'a broken item had no name', err);
    }
    this.showToast(name + ' zerbrochen', 'Die Haltbarkeit ist aufgebraucht.', itemId | 0, 'danger');
  };

  /**
   * A melee hit landed: show the hit marker.
   * @param {Object} victim the entity that was hit
   * @param {number} damage applied damage
   * @param {?Object} info `{charge, critical, knockback}`
   * @returns {void}
   * @private
   */
  _onAttack = (victim, damage, info) => {
    if (this._disposed) return;
    this.hitMarker(info && info.critical === true ? 'crit' : 'hit');
  };

  /**
   * Something died from the player's hit.
   * @returns {void}
   * @private
   */
  _onKill = () => {
    if (this._disposed) return;
    this.hitMarker('kill');
  };

  /**
   * An item was picked up: add a row to the ticker.
   * @param {Object} entity the item entity
   * @param {Object} collector the entity that picked it up
   * @param {number} taken how many items were taken
   * @returns {void}
   * @private
   */
  _onItemPickup = (entity, collector, taken) => {
    if (this._disposed) return;
    const player = this._bound.player;
    if (player && collector && collector !== player) return;
    const stack = entity && entity.stack ? entity.stack : null;
    const itemId = stack ? stack.itemId | 0 : 0;
    if (itemId <= 0) return;
    this.showPickup(itemId, Math.max(1, Math.round(num(taken, 1))));
  };

  /**
   * An experience orb was collected.
   * @param {Object} entity the orb
   * @param {Object} collector the entity that collected it
   * @param {number} value experience points
   * @returns {void}
   * @private
   */
  _onXPCollected = (entity, collector, value) => {
    if (this._disposed) return;
    const player = this._bound.player;
    if (player && collector && collector !== player) return;
    const n = Math.max(0, Math.round(num(value, 0)));
    if (n > 0) this.showPickup(-1, n, `${n} Erfahrung`);
  };

  /**
   * A message from the interaction system.
   * @param {string} text German message
   * @returns {void}
   * @private
   */
  _onInteractionMessage = (text) => {
    if (this._disposed || typeof text !== 'string' || text.length === 0) return;
    this.setMessage(text, 2200);
  };

  /**
   * `settings.guiScale` changed.
   * @returns {void}
   * @private
   */
  _onGuiScale = () => {
    if (this._disposed) return;
    this._applyGuiScale();
  };

  /* ====================================================================== */
  /* Frame update                                                           */
  /* ====================================================================== */

  /**
   * Advance every animation and write the values that actually changed.
   * Called once per rendered frame. Never throws.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   */
  update(dt) {
    if (this._disposed || !this._ok) return;
    const step = clamp(num(dt, 0), 0, 0.25);
    try {
      this._rebind();
      const player = this._bound.player;
      this._updateVitals(player);
      this._updateHotbar(player);
      this._updateCrosshair(player);
      this._updateEffects(step);
      this._updateVignettes(player, step);
      this._updateMessage(step);
      this._updateItemName(step);
      this._updateToasts(step);
      this._updatePickups(step);
      this._updateMount();
      this._updateFps(step);
    } catch (err) {
      warnOnce('update', 'the HUD update failed and was skipped', err);
    }
  }

  /**
   * Whether a full-screen menu or a container UI currently owns the screen.
   * @returns {boolean} true when the crosshair must fade out
   * @private
   */
  _screenOpen() {
    const game = this.game;
    if (!game) return false;
    const ui = game.ui || null;
    const screens = (ui && ui.screens) || game.screens || null;
    if (screens) {
      if (typeof screens.isOpen === 'boolean') {
        if (screens.isOpen) return true;
      } else if (screens.current !== undefined && screens.current !== null) {
        return true;
      }
    }
    const inv = (ui && ui.inventory) || null;
    if (inv && inv.isOpen === true) return true;
    const state = game.state;
    return state === 'paused' || state === 'menu' || state === 'dead' ||
      state === 'loading' || state === 'boot' || state === 'inventory';
  }

  /**
   * Write one bar's fill, ghost and numeric readout when they changed.
   * @param {Object} bar a bar record from {@link HUD#_makeBar}
   * @param {number} value current value
   * @param {number} max maximum value
   * @param {string} [text] readout text; defaults to `ceil(value)`
   * @returns {void}
   * @private
   */
  _writeBar(bar, value, max, text) {
    const span = max > 0 ? max : 1;
    const ratio = clamp(value / span, 0, 1);
    const shown = ratio.toFixed(4);
    bar.root.style.setProperty('--v', shown);
    bar.root.style.setProperty('--ghost', shown);
    if (bar.value !== null) {
      const label = text === undefined ? String(Math.ceil(Math.max(0, value))) : text;
      if (bar.value.textContent !== label) bar.value.textContent = label;
    }
  }

  /**
   * Health, hunger, armour, breath and experience.
   * @param {?Object} player the local player
   * @returns {void}
   * @private
   */
  _updateVitals(player) {
    const v = this._v;
    if (!player) return;

    const maxHealth = Math.max(1, num(player.maxHealth, 20));
    const segs = Math.max(1, Math.round(maxHealth / 2));
    if (segs !== v.healthSegs) {
      v.healthSegs = segs;
      this._healthBar.root.style.setProperty('--segs', String(segs));
    }

    const health = clamp(num(player.health, 0), 0, maxHealth);
    if (health !== v.health) {
      v.health = health;
      this._writeBar(this._healthBar, health, maxHealth);
    }
    const low = health > 0 && health / maxHealth <= LOW_HEALTH_RATIO;
    if (low !== v.low) {
      v.low = low;
      toggle(this._healthBar.root, 'is-low', low);
    }

    const hunger = clamp(num(player.hunger, 20), 0, 20);
    if (hunger !== v.hunger) {
      v.hunger = hunger;
      this._writeBar(this._hungerBar, hunger, 20);
    }
    const starving = hunger <= STARVING_HUNGER;
    if (starving !== v.starving) {
      v.starving = starving;
      toggle(this._hungerBar.root, 'is-starving', starving);
    }
    const critical = hunger <= 0;
    if (critical !== v.critical) {
      v.critical = critical;
      toggle(this._hungerBar.root, 'is-critical', critical);
    }

    const armor = clamp(num(player.armor, 0), 0, 20);
    if (armor !== v.armor) {
      v.armor = armor;
      this._writeBar(this._armorBar, armor, 20);
    }
    const armorOn = armor > 0;
    if (armorOn !== v.armorOn) {
      v.armorOn = armorOn;
      toggle(this._armorBar.root, 'is-off', !armorOn);
    }

    const air = clamp(num(player.air, MAX_AIR), 0, MAX_AIR);
    const airOn = air < MAX_AIR - 0.5 && num(player.health, 1) > 0;
    if (air !== v.air) {
      v.air = air;
      this._writeBar(this._airBar, air, MAX_AIR, `${Math.ceil(air / 20)} s`);
    }
    if (airOn !== v.airOn) {
      v.airOn = airOn;
      toggle(this._airBar.root, 'is-off', !airOn);
    }

    const progress = clamp(num(player.xpProgress, 0), 0, 1);
    if (progress !== v.xp) {
      v.xp = progress;
      this._xpFill.style.setProperty('--v', progress.toFixed(4));
    }
    const level = Math.max(0, Math.round(num(player.xpLevel, 0)));
    if (level !== v.level) {
      v.level = level;
      this._xpLevel.textContent = String(level);
    }
    const levelOff = level <= 0;
    if (levelOff !== v.levelOff) {
      v.levelOff = levelOff;
      toggle(this._xpLevel, 'is-off', levelOff);
    }
  }

  /**
   * Nine hotbar slots: icon, stack count, durability, selection and the attack
   * cooldown sweep on the active slot.
   * @param {?Object} player the local player
   * @returns {void}
   * @private
   */
  _updateHotbar(player) {
    const v = this._v;
    const inv = this._bound.inventory;
    const epochChanged = this._iconApplied !== this._iconEpoch;
    if (epochChanged) this._iconApplied = this._iconEpoch;

    let selected = -1;
    if (inv && Number.isFinite(inv.selected)) selected = inv.selected | 0;
    else if (player && Number.isFinite(player.selectedSlot)) selected = player.selectedSlot | 0;
    selected = selected < 0 || selected >= HOTBAR_SIZE ? 0 : selected;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = this._slots[i];
      let stack = null;
      if (inv) {
        try {
          stack = typeof inv.hotbar === 'function' ? inv.hotbar(i) : inv.get(i);
        } catch (err) {
          warnOnce('hotbar:read', 'a hotbar slot could not be read', err);
          stack = null;
        }
      }
      const itemId = stack && stack.itemId ? stack.itemId | 0 : 0;
      const count = stack ? Math.max(0, stack.count | 0) : 0;
      let wear = -1;
      let maxWear = 0;
      if (stack && itemId > 0) {
        try {
          if (stack.isDamageable && stack.isDamageable()) {
            maxWear = num(stack.maxDurability, 0);
            wear = num(stack.durability, maxWear);
          }
        } catch (err) {
          warnOnce('hotbar:wear', 'a durability value could not be read', err);
        }
      }
      const key = `${itemId}|${count}|${wear}|${maxWear}`;
      if (key !== this._slotKey[i] || epochChanged) {
        this._slotKey[i] = key;
        this._writeSlot(slot, i, itemId, count, wear, maxWear);
      }
    }

    if (selected !== v.selected) {
      const previous = v.selected;
      if (previous >= 0 && previous < HOTBAR_SIZE) {
        this._slots[previous].root.classList.remove('is-selected');
        this._slots[previous].cool.style.setProperty('--c', '0');
      }
      v.selected = selected;
      this._slots[selected].root.classList.add('is-selected');
      v.cool = -1;
      this._nameItem = -1;
    }

    const combat = this._bound.combat;
    let cooldown = 0;
    if (combat && typeof combat.getAttackCharge === 'function') {
      try {
        cooldown = 1 - clamp(num(combat.getAttackCharge(), 1), 0, 1);
      } catch (err) {
        warnOnce('cooldown', 'the attack charge could not be read', err);
        cooldown = 0;
      }
    }
    const quantised = Math.round(cooldown * 50) / 50;
    if (quantised !== v.cool) {
      v.cool = quantised;
      this._slots[selected].cool.style.setProperty('--c', quantised.toFixed(2));
    }
  }

  /**
   * Write the contents of one hotbar slot.
   * @param {Object} slot the slot record
   * @param {number} index slot index
   * @param {number} itemId item id (`0` = empty)
   * @param {number} count stack size
   * @param {number} wear remaining durability, `-1` when not damageable
   * @param {number} maxWear maximum durability
   * @returns {void}
   * @private
   */
  _writeSlot(slot, index, itemId, count, wear, maxWear) {
    if (itemId <= 0 || count <= 0) {
      if (this._slotIcon[index] !== '') {
        this._slotIcon[index] = '';
        slot.icon.removeAttribute('src');
      }
      slot.icon.hidden = true;
      toggle(slot.count, 'is-hidden', true);
      toggle(slot.dura, 'is-hidden', true);
      return;
    }

    const url = this.icons ? this.icons.get(itemId) : '';
    if (url !== this._slotIcon[index]) {
      this._slotIcon[index] = url;
      if (url === '') slot.icon.removeAttribute('src');
      else slot.icon.src = url;
    }
    slot.icon.hidden = url === '';
    if (url !== '') {
      let alt = '';
      try {
        alt = itemDisplay(itemId);
      } catch (err) {
        warnOnce('slot:name', 'an item name could not be read', err);
      }
      if (slot.icon.alt !== alt) slot.icon.alt = alt;
    }

    const label = count > 1 ? String(count) : '';
    if (slot.count.textContent !== label) slot.count.textContent = label;
    toggle(slot.count, 'is-hidden', label === '');

    const damaged = maxWear > 0 && wear >= 0 && wear < maxWear;
    toggle(slot.dura, 'is-hidden', !damaged);
    if (damaged) {
      slot.dura.style.setProperty('--d', clamp(wear / maxWear, 0, 1).toFixed(3));
    }
  }

  /**
   * Crosshair focus and fade.
   * @param {?Object} player the local player
   * @returns {void}
   * @private
   */
  _updateCrosshair(player) {
    const v = this._v;
    const dim = !this.visible || this._screenOpen() ||
      (player !== null && player !== undefined && player.dead === true);
    if (dim !== v.dim) {
      v.dim = dim;
      toggle(this._cross, 'is-dim', dim);
    }
    const interaction = this._bound.interaction;
    const focus = !dim && interaction !== null && interaction !== undefined &&
      interaction.hit !== null && interaction.hit !== undefined;
    if (focus !== v.focus) {
      v.focus = focus;
      toggle(this._cross, 'is-focus', focus);
    }
  }

  /**
   * Full-screen tints: damage pulse, low-health border, drowning and water.
   * @param {?Object} player the local player
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   * @private
   */
  _updateVignettes(player, dt) {
    const v = this._v;
    if (this._damage > 0) {
      this._damage = Math.max(0, this._damage - dt * 1.8);
    }
    const damage = Math.round(this._damage * 100) / 100;
    if (damage !== v.damage) {
      v.damage = damage;
      this._damageNode.style.opacity = damage.toFixed(2);
    }

    let lowTint = 0;
    let drown = 0;
    let wet = 0;
    if (player) {
      const maxHealth = Math.max(1, num(player.maxHealth, 20));
      const ratio = clamp(num(player.health, maxHealth) / maxHealth, 0, 1);
      if (ratio <= LOW_HEALTH_RATIO && num(player.health, 1) > 0) {
        lowTint = clamp((LOW_HEALTH_RATIO - ratio) / LOW_HEALTH_RATIO, 0, 1) * 0.9;
      }
      const air = clamp(num(player.air, MAX_AIR), 0, MAX_AIR);
      if (air < MAX_AIR) drown = clamp(1 - air / MAX_AIR, 0, 1) * 0.85;
      if (player.inWater === true) wet = 0.55 + clamp(num(player.submerged, 0), 0, 1) * 0.35;
    }
    const lowQ = Math.round(lowTint * 100) / 100;
    if (lowQ !== v.lowTint) {
      v.lowTint = lowQ;
      this._lowNode.style.opacity = lowQ.toFixed(2);
    }
    const drownQ = Math.round(drown * 100) / 100;
    if (drownQ !== v.drown) {
      v.drown = drownQ;
      this._drownNode.style.opacity = drownQ.toFixed(2);
    }
    const wetQ = Math.round(wet * 100) / 100;
    if (wetQ !== v.wet) {
      v.wet = wetQ;
      this._wetNode.style.opacity = wetQ.toFixed(2);
    }
  }

  /**
   * Fade the centre message out when its time is up.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   * @private
   */
  _updateMessage(dt) {
    if (this._messageTimer <= 0) return;
    this._messageTimer -= dt;
    if (this._messageTimer <= 0) {
      this._messageTimer = 0;
      toggle(this._messageNode, 'is-on', false);
    }
  }

  /**
   * Show the held item's name for {@link ITEM_NAME_TIME} after a change.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   * @private
   */
  _updateItemName(dt) {
    const inv = this._bound.inventory;
    let itemId = 0;
    if (inv) {
      try {
        const index = this._v.selected < 0 ? 0 : this._v.selected;
        const stack = typeof inv.getSelected === 'function'
          ? inv.getSelected() : inv.get(index);
        itemId = stack && stack.itemId ? stack.itemId | 0 : 0;
      } catch (err) {
        warnOnce('itemname', 'the held item could not be read', err);
        itemId = 0;
      }
    }
    if (itemId !== this._nameItem) {
      this._nameItem = itemId;
      if (itemId > 0) {
        let name = '';
        let rarity = 'common';
        try {
          name = itemDisplay(itemId);
          rarity = itemRarity(itemId);
        } catch (err) {
          warnOnce('itemname:lookup', 'an item name could not be resolved', err);
        }
        if (this._v.itemName !== name) {
          this._v.itemName = name;
          this._itemName.textContent = name;
        }
        if (this._v.itemRarity !== rarity) {
          this._v.itemRarity = rarity;
          this._itemName.setAttribute('data-rarity', rarity);
        }
        this._nameTimer = ITEM_NAME_TIME;
        toggle(this._itemName, 'is-on', true);
      } else {
        this._nameTimer = 0;
        toggle(this._itemName, 'is-on', false);
      }
      return;
    }
    if (this._nameTimer > 0) {
      this._nameTimer -= dt;
      if (this._nameTimer <= 0) {
        this._nameTimer = 0;
        toggle(this._itemName, 'is-on', false);
      }
    }
  }

  /**
   * Mount health, shown only while the player rides something.
   * @returns {void}
   * @private
   */
  _updateMount() {
    const player = this._bound.player;
    const mount = this._mount || (player ? (player.vehicle || player.mount || null) : null);
    const v = this._v;
    const shown = mount !== null && mount !== undefined && num(mount.maxHealth, 0) > 0;
    if (shown !== v.mountShown) {
      v.mountShown = shown;
      toggle(this._mountNode, 'is-hidden', !shown);
    }
    if (!shown) return;
    const name = typeof mount.displayName === 'string' ? mount.displayName
      : (typeof mount.type === 'string' ? mount.type : 'Reittier');
    if (name !== v.mountName) {
      v.mountName = name;
      this._mountName.textContent = name;
    }
    const max = Math.max(1, num(mount.maxHealth, 20));
    this._writeBar(this._mountBar, clamp(num(mount.health, max), 0, max), max);
  }

  /**
   * Optional frame-rate readout, gated by `settings.showFps`.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   * @private
   */
  _updateFps(dt) {
    const v = this._v;
    const settings = this._bound.settings;
    let on = false;
    if (settings && typeof settings.get === 'function') on = settings.get('showFps') === true;
    if (on !== v.showFps) {
      v.showFps = on;
      toggle(this._fpsNode, 'is-hidden', !on);
    }
    if (!on) return;

    this._fpsAccum += dt;
    this._fpsFrames++;
    this._fpsTimer -= dt;
    if (this._fpsTimer > 0) return;
    this._fpsTimer = 0.5;
    const fps = this._fpsAccum > 0 ? this._fpsFrames / this._fpsAccum : 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    const text = `${Math.round(fps)} FPS`;
    if (text !== v.fpsText) {
      v.fpsText = text;
      this._fpsNode.textContent = text;
    }
    toggle(this._fpsNode, 'is-bad', fps < 50 && fps >= 25);
    toggle(this._fpsNode, 'is-terrible', fps < 25);
  }

  /* ====================================================================== */
  /* Status effects                                                         */
  /* ====================================================================== */

  /**
   * Count down every running effect and refresh only the labels that changed.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   * @private
   */
  _updateEffects(dt) {
    this._effectPoll -= dt;
    if (this._effectPoll <= 0) {
      this._effectPoll = 0.25;
      this._pollExternalEffects();
    }
    if (this._effects.size === 0) return;

    for (const [type, entry] of this._effects) {
      entry.remaining -= dt;
      if (entry.remaining <= 0) {
        this._removeEffectNode(entry);
        this._effects.delete(type);
        continue;
      }
      const text = formatDuration(entry.remaining);
      if (text !== entry.text) {
        entry.text = text;
        entry.time.textContent = text;
      }
      const expiring = entry.remaining <= EFFECT_BLINK_TIME;
      if (expiring !== entry.expiring) {
        entry.expiring = expiring;
        toggle(entry.root, 'is-expiring', expiring);
      }
    }
  }

  /**
   * Adopt an effect list the gameplay code may keep on the player
   * (`player.effects` as a `Map` or an array of `{type, duration, amplifier}`).
   * Polled at 4 Hz so a future effect system needs no HUD change.
   * @returns {void}
   * @private
   */
  _pollExternalEffects() {
    const player = this._bound.player;
    const source = player ? player.effects : null;
    if (!source) return;
    try {
      if (typeof source.forEach === 'function' && typeof source.set === 'function') {
        source.forEach((value, key) => this._adoptEffect(
          typeof key === 'string' ? key : (value && value.type), value));
        return;
      }
      if (Array.isArray(source)) {
        for (let i = 0; i < source.length; i++) {
          const fx = source[i];
          if (fx) this._adoptEffect(fx.type, fx);
        }
      }
    } catch (err) {
      warnOnce('effects:poll', 'the external effect list could not be read', err);
    }
  }

  /**
   * Merge one externally owned effect record into the HUD's list.
   * @param {string} type effect id
   * @param {*} value the record `{duration|remaining|time, amplifier|level}`
   * @returns {void}
   * @private
   */
  _adoptEffect(type, value) {
    if (typeof type !== 'string' || type.length === 0) return;
    const seconds = num(value && (value.remaining !== undefined ? value.remaining
      : (value.duration !== undefined ? value.duration : value.time)), -1);
    if (seconds <= 0) return;
    const amplifier = num(value && (value.amplifier !== undefined ? value.amplifier
      : value.level), 0);
    const entry = this._effects.get(type);
    if (entry !== undefined && Math.abs(entry.remaining - seconds) < 0.35 &&
      entry.amplifier === amplifier) {
      return;
    }
    this.setEffect(type, seconds, amplifier);
  }

  /**
   * Start (or refresh) a status effect on the HUD.
   * @param {string} type effect id, e.g. `'regeneration'`
   * @param {number} seconds remaining duration in seconds
   * @param {number} [amplifier] 0-based level (0 = level I)
   * @returns {void}
   */
  setEffect(type, seconds, amplifier = 0) {
    if (this._disposed || !this._ok) return;
    if (typeof type !== 'string' || type.length === 0) return;
    const time = num(seconds, 0);
    if (time <= 0) {
      this.clearEffect(type);
      return;
    }
    const level = Math.max(0, Math.round(num(amplifier, 0)));
    let entry = this._effects.get(type);
    if (entry === undefined) {
      entry = this._makeEffectNode(type, level);
      if (entry === null) return;
      this._effects.set(type, entry);
    } else if (entry.amplifier !== level) {
      entry.amplifier = level;
      const label = effectName(type) + (level > 0 ? ` ${roman(level)}` : '');
      entry.name.textContent = label;
    }
    entry.remaining = time;
    entry.text = '';
  }

  /**
   * Stop one status effect.
   * @param {string} type effect id
   * @returns {void}
   */
  clearEffect(type) {
    if (this._disposed || !this._ok) return;
    const entry = this._effects.get(type);
    if (entry === undefined) return;
    this._removeEffectNode(entry);
    this._effects.delete(type);
  }

  /**
   * Stop every status effect.
   * @returns {void}
   */
  clearEffects() {
    if (this._disposed || !this._ok) return;
    for (const entry of this._effects.values()) this._removeEffectNode(entry);
    this._effects.clear();
  }

  /**
   * Build one effect chip.
   * @param {string} type effect id
   * @param {number} amplifier 0-based level
   * @returns {?Object} the entry record, or null when the DOM is gone
   * @private
   */
  _makeEffectNode(type, amplifier) {
    if (!this._effectsNode) return null;
    const root = el('div', 'vx-effect is-enter');
    const icon = el('div', 'vx-effect__icon');
    icon.style.setProperty('--fx', effectColor(type));
    icon.appendChild(svg(effectGlyph(type)));
    const body = el('div', 'vx-effect__body');
    const name = el('div', 'vx-effect__name',
      effectName(type) + (amplifier > 0 ? ` ${roman(amplifier)}` : ''));
    const time = el('div', 'vx-effect__time', '0:00');
    body.appendChild(name);
    body.appendChild(time);
    root.appendChild(icon);
    root.appendChild(body);
    this._effectsNode.appendChild(root);
    this._nextFrame(() => root.classList.remove('is-enter'));
    return { type, root, name, time, amplifier, remaining: 0, text: '', expiring: false };
  }

  /**
   * Animate one effect chip out and drop it.
   * @param {Object} entry the entry record
   * @returns {void}
   * @private
   */
  _removeEffectNode(entry) {
    const root = entry.root;
    root.classList.add('is-enter');
    this._after(280, () => {
      if (root.parentNode) root.parentNode.removeChild(root);
    });
  }

  /* ====================================================================== */
  /* Toasts, pickups and messages                                           */
  /* ====================================================================== */

  /**
   * Push a toast onto the stack.
   * @param {string} title German headline
   * @param {string} [subtitle] German second line
   * @param {(string|number|null)} [icon] an item id, a data URL or a short text
   *   glyph; `null` uses a neutral mark
   * @param {string} [kind] `'achievement'` or `'danger'` for the tinted variants
   * @returns {?HTMLElement} the toast node, or null when the HUD is inert
   */
  showToast(title, subtitle, icon, kind) {
    if (this._disposed || !this._ok) return null;
    const node = el('div', 'vx-toast' + (kind ? ` vx-toast--${kind}` : ''));
    const iconBox = el('div', 'vx-toast__icon');
    this._fillToastIcon(iconBox, icon);
    const body = el('div', 'vx-toast__body');
    body.appendChild(el('div', 'vx-toast__title', String(title === undefined ? '' : title)));
    if (subtitle !== undefined && subtitle !== null && String(subtitle).length > 0) {
      body.appendChild(el('div', 'vx-toast__sub', String(subtitle)));
    }
    node.appendChild(iconBox);
    node.appendChild(body);
    this._toastsNode.appendChild(node);

    const record = { node, life: TOAST_TIME, out: false };
    this._toasts.push(record);
    while (this._toasts.length > TOAST_LIMIT) {
      const oldest = this._toasts[0];
      if (oldest.out) break;
      oldest.life = 0;
      this._retireToast(oldest);
      this._toasts.shift();
    }
    this._nextFrame(() => node.classList.add('is-in'));
    return node;
  }

  /**
   * Fill a toast's icon box with an image or a text glyph.
   * @param {HTMLElement} box the icon container
   * @param {(string|number|null|undefined)} icon icon descriptor
   * @returns {void}
   * @private
   */
  _fillToastIcon(box, icon) {
    if (typeof icon === 'number' && icon > 0) {
      const url = this.icons ? this.icons.get(icon | 0) : '';
      if (url !== '') {
        const img = /** @type {HTMLImageElement} */ (el('img'));
        img.src = url;
        img.alt = '';
        box.appendChild(img);
        return;
      }
      box.textContent = '◆';
      return;
    }
    if (typeof icon === 'string' && icon.length > 0) {
      if (icon.slice(0, 5) === 'data:') {
        const img = /** @type {HTMLImageElement} */ (el('img'));
        img.src = icon;
        img.alt = '';
        box.appendChild(img);
        return;
      }
      box.textContent = icon;
      return;
    }
    box.textContent = '◆';
  }

  /**
   * Age the toast stack and collapse finished entries.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   * @private
   */
  _updateToasts(dt) {
    if (this._toasts.length === 0) return;
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      if (t.out) continue;
      t.life -= dt;
      if (t.life > 0) continue;
      this._retireToast(t);
      this._toasts.splice(i, 1);
    }
  }

  /**
   * Fade one toast out and collapse the gap it leaves behind.
   * @param {Object} record the toast record
   * @returns {void}
   * @private
   */
  _retireToast(record) {
    if (record.out) return;
    record.out = true;
    const node = record.node;
    const height = node.offsetHeight;
    node.classList.remove('is-in');
    node.classList.add('is-out');
    node.style.marginTop = `${-height}px`;
    this._after(400, () => {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
  }

  /**
   * Add a row to the pickup ticker, merging with a live row for the same item.
   * @param {number} itemId item id, or `-1` for the experience row
   * @param {number} count how many were picked up
   * @param {string} [label] overrides the generated German label
   * @returns {void}
   */
  showPickup(itemId, count, label) {
    if (this._disposed || !this._ok) return;
    const id = itemId | 0;
    const n = Math.max(1, Math.round(num(count, 1)));

    for (let i = 0; i < this._pickups.length; i++) {
      const row = this._pickups[i];
      if (row.itemId !== id) continue;
      row.count += n;
      row.life = PICKUP_TIME;
      row.text.textContent = `${row.count}×`;
      row.node.style.animation = 'none';
      void row.node.offsetWidth;
      row.node.style.animation = '';
      return;
    }

    const node = el('div', 'vx-pickup');
    if (id > 0) {
      const url = this.icons ? this.icons.get(id) : '';
      if (url !== '') {
        const img = /** @type {HTMLImageElement} */ (el('img'));
        img.src = url;
        img.alt = '';
        node.appendChild(img);
      }
    }
    const text = el('b', undefined, `${n}×`);
    node.appendChild(text);
    let name = label;
    if (name === undefined) {
      if (id > 0) {
        try {
          name = itemDisplay(id);
        } catch (err) {
          warnOnce('pickup:name', 'a pickup name could not be read', err);
          name = '';
        }
      } else {
        name = 'Erfahrung';
      }
    }
    node.appendChild(el('span', undefined, String(name)));
    this._pickupsNode.appendChild(node);
    this._pickups.push({ node, text, itemId: id, count: n, life: PICKUP_TIME });

    while (this._pickups.length > PICKUP_LIMIT) {
      const oldest = this._pickups.shift();
      if (oldest.node.parentNode) oldest.node.parentNode.removeChild(oldest.node);
    }
  }

  /**
   * Age the pickup ticker.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   * @private
   */
  _updatePickups(dt) {
    if (this._pickups.length === 0) return;
    for (let i = this._pickups.length - 1; i >= 0; i--) {
      const row = this._pickups[i];
      row.life -= dt;
      if (row.life > 0) continue;
      if (row.node.parentNode) row.node.parentNode.removeChild(row.node);
      this._pickups.splice(i, 1);
    }
  }

  /* ====================================================================== */
  /* Public API                                                             */
  /* ====================================================================== */

  /**
   * Show a line of text above the hotbar.
   * @param {string} text German message; an empty string hides the line
   * @param {number} [ms] how long it stays, in milliseconds
   * @returns {void}
   */
  setMessage(text, ms = 2500) {
    if (this._disposed || !this._ok) return;
    const value = text === undefined || text === null ? '' : String(text);
    if (value.length === 0 || num(ms, 0) <= 0) {
      this._messageTimer = 0;
      toggle(this._messageNode, 'is-on', false);
      return;
    }
    if (this._messageNode.textContent !== value) this._messageNode.textContent = value;
    this._messageTimer = clamp(num(ms, 2500) / 1000, 0.1, 30);
    toggle(this._messageNode, 'is-on', true);
  }

  /**
   * Pulse the red damage vignette.
   * @param {number} [strength] intensity `0..1`
   * @returns {void}
   */
  flashDamage(strength = 0.8) {
    if (this._disposed || !this._ok) return;
    this._damage = Math.max(this._damage, clamp(num(strength, 0.8), 0, 1));
  }

  /**
   * Play the crosshair hit-marker animation.
   * @param {string} [kind] `'hit'`, `'crit'` or `'kill'`
   * @returns {void}
   */
  hitMarker(kind = 'hit') {
    if (this._disposed || !this._ok) return;
    const hit = this._hit;
    toggle(hit, 'is-crit', kind === 'crit');
    toggle(hit, 'is-kill', kind === 'kill');
    restart(hit, 'hit-a', 'hit-b');
  }

  /**
   * Show the overlay.
   * @returns {void}
   */
  show() {
    if (this._disposed || !this._ok) return;
    this.visible = true;
    toggle(this.el, 'is-hiding', false);
  }

  /**
   * Fade the overlay out (screenshots, cinematic camera, menus).
   * @returns {void}
   */
  hide() {
    if (this._disposed || !this._ok) return;
    this.visible = false;
    toggle(this.el, 'is-hiding', true);
  }

  /**
   * Attach or detach the mount health bar.
   * @param {?Object} entity the ridden entity, or null to hide the bar
   * @returns {void}
   */
  setMount(entity) {
    if (this._disposed || !this._ok) return;
    this._mount = entity || null;
    if (this._mount === null) {
      this._v.mountShown = false;
      this._v.mountName = '';
      toggle(this._mountNode, 'is-hidden', true);
    }
  }

  /**
   * Run a callback on the next animation frame (or as a micro-delay when there
   * is no `requestAnimationFrame`), so a freshly inserted node can transition.
   * @param {function():void} fn the callback
   * @returns {void}
   * @private
   */
  _nextFrame(fn) {
    const run = () => {
      if (this._disposed) return;
      try {
        fn();
      } catch (err) {
        warnOnce('raf', 'a deferred UI step failed', err);
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else if (typeof setTimeout === 'function') setTimeout(run, 16);
  }

  /**
   * Run a callback after a delay, guarded against disposal.
   * @param {number} ms delay in milliseconds
   * @param {function():void} fn the callback
   * @returns {void}
   * @private
   */
  _after(ms, fn) {
    if (typeof setTimeout !== 'function') {
      try {
        fn();
      } catch (err) {
        warnOnce('timer', 'a deferred UI step failed', err);
      }
      return;
    }
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (this._disposed) return;
      try {
        fn();
      } catch (err) {
        warnOnce('timer', 'a deferred UI step failed', err);
      }
    }, ms);
    this._timers.add(id);
  }

  /**
   * Remove every listener, timer and node this HUD created.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._unbindAll();
    if (this._timers) {
      for (const id of this._timers) {
        if (typeof clearTimeout === 'function') clearTimeout(id);
      }
      this._timers.clear();
    }
    if (this.icons) {
      this.icons.dispose();
      this.icons = null;
    }
    if (this._effects) this._effects.clear();
    if (this._toasts) this._toasts.length = 0;
    if (this._pickups) this._pickups.length = 0;
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    if (this._toastsNode && this._toastsNode.parentNode) {
      this._toastsNode.parentNode.removeChild(this._toastsNode);
    }
    this.el = null;
    this._toastsNode = null;
    this.game = null;
    this.root = null;
  }
}

export default HUD;
