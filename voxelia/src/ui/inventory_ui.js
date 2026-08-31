/**
 * @file ui/inventory_ui.js — VOXELIA container screens (ARCHITECTURE.md § 5.41).
 *
 * One class, {@link InventoryUI}, renders every container the player can open:
 *
 * | `open(kind)`  | window                                                      |
 * |---------------|-------------------------------------------------------------|
 * | `inventory`   | armour + off-hand, the 2x2 grid, 27 main slots, the hotbar   |
 * | `crafting`    | the 3x3 crafting-table grid on top of the player inventory   |
 * | `furnace`     | input / fuel / output with a live flame and progress arrow   |
 * | `chest`       | any {@link Container} grid (chest, barrel, hopper, dispenser)|
 *
 * ============================================================================
 * WHAT THIS MODULE OWNS
 * ============================================================================
 * * **Real pointer drag and drop.** Left click picks a stack up, right click
 *   takes half, right click while holding drops a single item, dragging across
 *   several slots with the button held distributes the held stack evenly (left)
 *   or one item per slot (right), shift-click quick-moves between the player
 *   and the open container, and releasing outside the window throws the stack
 *   into the world through `game/entities.js`.
 * * **A live crafting result.** Every grid mutation re-runs
 *   `crafting.findRecipe()`; taking the result consumes exactly one set of
 *   ingredients (remainders — buckets, bottles — are handed back), and
 *   shift-clicking the result crafts until the materials or the free inventory
 *   space run out.
 * * **The recipe book.** `crafting.craftableFrom()` drives a searchable,
 *   category-tabbed panel; clicking an entry lays the ingredients into the grid
 *   when they are actually present, and rolls back cleanly when they are not.
 * * **Item icons without a single external asset.** Block items use the
 *   renderer's real isometric previews (`renderer.textures.renderBlockIcons()`),
 *   everything else is drawn procedurally on a 2D canvas from the
 *   `{type:'sprite', pattern, colors}` descriptor `items.itemIcon()` returns.
 *   Both end up as cached `data:` URLs, so a slot is a plain `<img>`.
 * * **Tooltips** with name, tier, damage, durability, enchantments and the
 *   German description line from `items.itemTooltip()`.
 *
 * ============================================================================
 * COST
 * ============================================================================
 * The DOM is built once per `open()` and then only *written when a value
 * actually changed*: inventories are watched through their `change` event,
 * which marks a slot dirty; `update()` flushes the dirty set. The recipe book
 * is rebuilt only when the set of craftable recipes really differs. When the
 * screen is closed `update()` returns on its first line.
 *
 * Nothing here throws during a frame: every foreign call is guarded and each
 * distinct failure is logged exactly once.
 *
 * Styling comes from `ui/style.css` (`vx-gui`, `vx-grid`, `vx-cell`, `vx-item`,
 * `vx-drag`, `vx-flame`, `vx-arrow`, `vx-tooltip`, …). The handful of classes
 * the stylesheet does not define yet — the modal layer, the two-pane stage and
 * the recipe book — are added by a small stylesheet that is *prepended* to
 * `<head>`, so `ui/style.css` always wins.
 *
 * All player-visible text is German.
 *
 * @module ui/inventory_ui
 */

import {
  ITEMS, ARMOR_SLOT, CATEGORY_LABELS, RARITY,
  getItem, itemIcon, itemDisplay, itemTooltip, itemDurability, itemStackSize,
  toolTier, toolType, armorSlot, armorPoints, armorToughness,
  attackDamage, attackSpeed, foodValue, itemRarity, itemCategory, itemFuel,
} from '../game/items.js';
import {
  ItemStack, Inventory, SLOT, FURNACE_SLOT, cloneMeta,
} from '../game/inventory.js';
import {
  findRecipe, consumeIngredients, craftableFrom, smeltResult, fuelValue,
  RECIPE_CATEGORIES, RECIPE_CATEGORY_LABELS,
} from '../game/crafting.js';
import { TOOL_TIER } from '../world/blocks.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Edge length in pixels of every generated item icon. @type {number} */
export const ICON_PX = 64;

/** Id of the injected supplementary stylesheet. @type {string} */
const STYLE_ID = 'vx-inventory-css';

/** Window kinds {@link InventoryUI#open} understands. @type {ReadonlyArray<string>} */
export const GUI_KINDS = Object.freeze(['inventory', 'crafting', 'furnace', 'chest']);

/** German window titles per kind, used when the container has none. */
const KIND_TITLES = Object.freeze({
  inventory: 'Inventar',
  crafting: 'Werkbank',
  furnace: 'Ofen',
  chest: 'Truhe',
});

/** German names of the six tool tiers, indexed by a `TOOL_TIER` value. */
const TIER_LABELS = Object.freeze([
  '—', 'Holz', 'Gold', 'Stein', 'Eisen', 'Diamant', 'Netherit',
]);

/** German names of the tool types. */
const TOOL_TYPE_LABELS = Object.freeze({
  pickaxe: 'Spitzhacke', axe: 'Axt', shovel: 'Schaufel',
  sword: 'Schwert', hoe: 'Hacke', shears: 'Schere',
});

/** German names of the four armour slots. */
const ARMOR_LABELS = Object.freeze(['Helm', 'Brustpanzer', 'Beinschutz', 'Stiefel']);

/** German names of every enchantment `game/combat.js` understands. */
const ENCHANT_LABELS = Object.freeze({
  protection: 'Schutz',
  fire_protection: 'Feuerschutz',
  blast_protection: 'Explosionsschutz',
  projectile_protection: 'Geschossschutz',
  feather_falling: 'Federfall',
  respiration: 'Atmung',
  thorns: 'Dornen',
  sharpness: 'Schärfe',
  smite: 'Bann',
  bane_of_arthropods: 'Nemesis der Gliederfüßer',
  knockback: 'Rückstoß',
  fire_aspect: 'Verbrennung',
  looting: 'Plünderung',
  unbreaking: 'Haltbarkeit',
  efficiency: 'Effizienz',
  silk_touch: 'Behutsamkeit',
  fortune: 'Glück',
  aqua_affinity: 'Wasseraffinität',
  power: 'Stärke',
  punch: 'Schlag',
  flame: 'Flamme',
  infinity: 'Unendlichkeit',
  mending: 'Reparatur',
});

/** Roman numerals for enchantment levels 1..10. @type {ReadonlyArray<string>} */
const ROMAN = Object.freeze(['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']);

/** Seconds between two recipe-book refreshes. @type {number} */
const BOOK_INTERVAL = 0.25;

/** Hard cap on one shift-click crafting burst, so a bug can never hang a frame. */
const MAX_BULK_CRAFT = 2048;

/** Supplementary CSS: only classes `ui/style.css` does not define. @type {string} */
const EXTRA_CSS = `
.vx-containers{position:absolute;inset:0;z-index:var(--z-container);display:flex;
 align-items:center;justify-content:center;padding:var(--sp-4);box-sizing:border-box;
 background:rgba(4,7,12,.44);-webkit-backdrop-filter:blur(11px) saturate(112%);
 backdrop-filter:blur(11px) saturate(112%);opacity:0;visibility:hidden;pointer-events:none;
 transition:opacity var(--dur-2) var(--ease),visibility 0s linear var(--dur-2)}
.vx-containers.is-open{opacity:1;visibility:visible;pointer-events:auto;transition-delay:0s}
.vx-containers__stage{display:flex;align-items:stretch;gap:var(--sp-3);max-width:100%;max-height:100%;
 transform:translateY(calc(10px * var(--gui-scale))) scale(.985);opacity:0;
 transition:transform var(--dur-3) var(--ease-out),opacity var(--dur-3) var(--ease-out)}
.vx-containers.is-open .vx-containers__stage{transform:none;opacity:1}
.vx-gui__body{display:flex;flex-direction:column;gap:var(--sp-4);min-height:0;overflow-y:auto;
 overflow-x:hidden;padding:var(--sp-05)}
.vx-gui__top{display:flex;align-items:flex-start;justify-content:center;gap:var(--sp-5);flex-wrap:wrap}
.vx-gui__stack{display:flex;flex-direction:column;align-items:center;gap:var(--sp-2)}
.vx-gui__hint{font-size:var(--fs-2xs);color:var(--text-3);text-align:center;line-height:1.5}
.vx-gui__actions{display:flex;align-items:center;gap:var(--sp-2)}
.vx-recipes{width:calc(292px * var(--gui-scale));display:flex;flex-direction:column;gap:var(--sp-3);
 padding:var(--sp-4);border-radius:var(--r-lg);background:var(--surface-2);
 border:var(--hair) solid var(--line-1);box-shadow:var(--sh-3),var(--sh-inset);
 -webkit-backdrop-filter:var(--blur-lg);backdrop-filter:var(--blur-lg);
 max-height:min(94vh,calc(880px * var(--gui-scale)));min-height:0}
.vx-recipes__tabs{flex-wrap:wrap}
.vx-tab--sm{flex:0 0 auto;padding:calc(3px * var(--gui-scale)) var(--sp-2);font-size:var(--fs-2xs)}
.vx-recipes__list{display:grid;grid-template-columns:repeat(auto-fill,var(--cell));gap:var(--sp-1);
 justify-content:center;align-content:start;flex:1 1 auto;min-height:calc(120px * var(--gui-scale));
 max-height:min(56vh,calc(520px * var(--gui-scale)));padding-right:var(--sp-1)}
.vx-recipes__empty{font-size:var(--fs-xs);color:var(--text-3);text-align:center;padding:var(--sp-4) 0}
.vx-cell--recipe.is-unfit{opacity:.38}
.vx-btn.is-active{background:var(--accent-a18);border-color:var(--accent-a55);color:var(--text-0)}
@media (max-width:900px){.vx-containers__stage{flex-direction:column;overflow-y:auto}
 .vx-recipes{width:auto}}
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
  if (err === undefined) console.warn(`[inventory-ui] ${message}`);
  else console.warn(`[inventory-ui] ${message}`, err);
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

/* ========================================================================== */
/* Procedural item sprites                                                    */
/* ========================================================================== */

/**
 * Shape primitives used by {@link SPRITES}. All coordinates live in a 16x16
 * space; `c` is either an index into the item's colour list or a literal CSS
 * colour string.
 *
 * ```
 * ['r', x, y, w, h, c]                axis-aligned rectangle
 * ['p', c, x1,y1, x2,y2, …]           filled polygon (auto dark outline)
 * ['o', c, x1,y1, x2,y2, …]           filled polygon without the outline
 * ['c', cx, cy, r, c]                 filled circle
 * ['e', cx, cy, rx, ry, c]            filled ellipse
 * ['l', x1, y1, x2, y2, w, c]         round-capped line
 * ['a', cx, cy, r, from, to, w, c]    stroked arc (radians)
 * ```
 * @typedef {Array<(string|number)>} SpriteOp
 */

/** Fallback colours when an item supplies fewer than a pattern needs. */
const FALLBACK_COLORS = Object.freeze(['#b7ccea', '#6d86a8', '#eef3fa']);

/** Outline colour drawn around every `p` polygon. @type {string} */
const OUTLINE = 'rgba(0,0,0,0.42)';

/** Highlight used by several patterns. @type {string} */
const HILITE = 'rgba(255,255,255,0.26)';

/** Shadow used by several patterns. @type {string} */
const SHADE = 'rgba(0,0,0,0.24)';

/** Two pi. @type {number} */
const TAU = Math.PI * 2;

/**
 * Every procedural sprite family `game/items.js` can ask for. The key set is
 * exactly the `pattern` values used by `items.itemIcon()`.
 * @type {Readonly<Object<string, ReadonlyArray<SpriteOp>>>}
 */
const SPRITES = Object.freeze({
  empty: [],

  /* -- tools --------------------------------------------------------------- */
  pickaxe: [
    ['l', 11.4, 4.6, 4.4, 12.6, 1.8, 1],
    ['p', 0, 3.0, 5.2, 5.6, 2.8, 9.2, 2.2, 12.8, 3.2, 14.2, 5.2, 12.2, 4.7, 9.0, 3.9, 6.0, 4.3, 4.3, 6.2],
  ],
  axe: [
    ['l', 11.2, 4.2, 4.6, 12.6, 1.8, 1],
    ['p', 0, 10.2, 3.0, 12.4, 1.6, 14.4, 3.6, 14.2, 7.2, 11.6, 8.6, 9.4, 6.2, 9.0, 4.2],
  ],
  shovel: [
    ['l', 11.4, 4.4, 4.4, 12.6, 1.7, 1],
    ['p', 0, 10.4, 1.4, 13.8, 1.2, 14.6, 4.6, 12.4, 6.6, 9.8, 5.2, 9.4, 2.6],
  ],
  sword: [
    ['l', 4.0, 11.6, 2.0, 14.0, 1.7, 1],
    ['c', 1.8, 14.2, 1.0, 1],
    ['p', 0, 3.2, 10.4, 4.8, 8.8, 8.2, 12.4, 6.6, 14.0],
    ['p', 0, 12.6, 1.4, 14.6, 3.4, 7.2, 11.0, 5.2, 9.0],
  ],
  hoe: [
    ['l', 11.6, 4.4, 4.4, 12.6, 1.7, 1],
    ['p', 0, 9.2, 2.0, 14.4, 2.0, 14.4, 4.2, 11.6, 4.2, 11.6, 5.8, 9.4, 5.8],
  ],

  /* -- armour -------------------------------------------------------------- */
  helmet: [
    ['p', 0, 2.8, 11.4, 2.8, 7.4, 4.8, 4.4, 8.0, 3.2, 11.2, 4.4, 13.2, 7.4, 13.2, 11.4,
      10.6, 11.4, 10.6, 8.6, 5.4, 8.6, 5.4, 11.4],
    ['r', 2.6, 11.0, 10.8, 1.5, 1],
  ],
  chestplate: [
    ['p', 0, 3.4, 4.0, 6.0, 2.8, 10.0, 2.8, 12.6, 4.0, 13.6, 7.2, 12.0, 7.8, 12.0, 13.2,
      4.0, 13.2, 4.0, 7.8, 2.4, 7.2],
    ['o', 1, 6.4, 2.9, 9.6, 2.9, 9.6, 4.8, 6.4, 4.8],
  ],
  leggings: [
    ['p', 0, 3.4, 4.0, 12.6, 4.0, 12.6, 6.6, 11.0, 6.6, 11.0, 13.6, 8.8, 13.6, 8.8, 8.2,
      7.2, 8.2, 7.2, 13.6, 5.0, 13.6, 5.0, 6.6, 3.4, 6.6],
    ['r', 3.2, 3.6, 9.6, 1.4, 1],
  ],
  boots: [
    ['p', 0, 2.6, 4.6, 6.2, 4.6, 6.2, 10.0, 7.6, 10.0, 7.6, 12.4, 2.6, 12.4],
    ['p', 0, 9.8, 4.6, 13.4, 4.6, 13.4, 12.4, 8.4, 12.4, 8.4, 10.0, 9.8, 10.0],
    ['r', 2.3, 12.1, 5.6, 1.5, 1],
    ['r', 8.1, 12.1, 5.6, 1.5, 1],
  ],

  /* -- weapons & gear ------------------------------------------------------ */
  arrow: [
    ['l', 3.6, 12.6, 12.0, 4.2, 1.2, 0],
    ['p', 1, 12.0, 1.8, 14.4, 4.2, 11.2, 5.0],
    ['p', 2, 1.6, 14.4, 2.4, 10.2, 6.0, 13.6],
  ],
  bow: [
    ['a', 3.4, 8.0, 8.0, -0.95, 0.95, 1.7, 0],
    ['l', 8.1, 1.5, 8.1, 14.5, 0.65, 1],
  ],
  crossbow: [
    ['l', 2.6, 13.4, 12.0, 4.0, 2.0, 0],
    ['l', 6.2, 4.4, 12.2, 10.4, 0.6, 2],
    ['l', 8.0, 2.0, 14.0, 8.0, 1.4, 1],
  ],
  shield: [
    ['p', 1, 2.6, 2.2, 13.4, 2.2, 13.4, 9.0, 8.0, 14.2, 2.6, 9.0],
    ['o', 0, 4.2, 3.8, 11.8, 3.8, 11.8, 8.5, 8.0, 12.4, 4.2, 8.5],
  ],
  fishing_rod: [
    ['l', 3.0, 13.2, 12.0, 3.4, 1.4, 0],
    ['l', 12.0, 3.4, 13.8, 8.6, 0.5, 1],
    ['l', 13.8, 8.6, 12.6, 12.4, 0.5, 1],
    ['c', 12.5, 13.2, 1.1, '#e0384a'],
  ],
  flint_and_steel: [
    ['p', 0, 3.0, 5.4, 9.6, 3.0, 10.8, 5.4, 5.2, 7.8],
    ['p', 1, 5.8, 8.8, 11.0, 7.8, 13.2, 11.0, 9.0, 13.8, 5.8, 12.4],
  ],
  shears: [
    ['l', 4.2, 3.8, 11.0, 10.2, 1.3, 0],
    ['l', 11.8, 3.8, 5.0, 10.2, 1.3, 0],
    ['a', 4.4, 12.4, 1.7, 0, TAU, 1.0, 1],
    ['a', 11.6, 12.4, 1.7, 0, TAU, 1.0, 1],
    ['c', 8.0, 7.4, 0.9, 1],
  ],
  saddle: [
    ['p', 0, 2.8, 6.6, 13.2, 6.6, 12.2, 11.4, 3.8, 11.4],
    ['e', 8.0, 7.2, 4.6, 2.2, 0],
    ['r', 6.4, 11.0, 1.3, 2.6, 1],
    ['r', 8.3, 11.0, 1.3, 2.6, 1],
  ],
  minecart: [
    ['p', 0, 2.4, 5.4, 13.6, 5.4, 12.6, 11.2, 3.4, 11.2],
    ['o', SHADE, 4.0, 6.4, 12.0, 6.4, 11.4, 10.0, 4.6, 10.0],
    ['c', 5.4, 12.4, 1.6, 1],
    ['c', 10.6, 12.4, 1.6, 1],
  ],
  boat: [
    ['p', 0, 1.4, 8.0, 14.6, 8.0, 13.0, 13.2, 3.0, 13.2],
    ['r', 1.2, 7.0, 13.6, 1.6, 0],
    ['l', 3.2, 6.4, 7.4, 2.6, 1.1, 1],
  ],

  /* -- materials ----------------------------------------------------------- */
  stick: [
    ['l', 4.4, 13.0, 11.6, 3.4, 1.8, 0],
    ['l', 5.6, 11.4, 10.2, 5.0, 0.5, SHADE],
  ],
  rod: [
    ['l', 4.0, 12.6, 12.0, 3.4, 2.3, 0],
    ['l', 4.8, 12.0, 11.4, 4.4, 0.9, HILITE],
    ['l', 5.6, 11.0, 10.6, 5.4, 0.5, 1],
  ],
  coal: [
    ['p', 0, 3.6, 8.8, 5.8, 4.6, 10.4, 3.6, 13.2, 6.4, 12.6, 10.8, 9.4, 13.2, 5.2, 12.4],
    ['o', HILITE, 6.4, 7.0, 8.8, 5.8, 9.6, 7.6, 7.2, 8.6],
  ],
  flint: [
    ['p', 0, 3.4, 9.0, 6.0, 4.8, 10.6, 4.4, 13.2, 8.0, 10.0, 12.6, 5.4, 12.6],
    ['o', HILITE, 6.4, 7.4, 9.4, 6.4, 9.8, 8.4, 6.8, 9.0],
  ],
  ingot: [
    ['p', 0, 4.6, 5.8, 11.4, 5.8, 13.2, 9.6, 2.8, 9.6],
    ['p', 1, 2.8, 9.6, 13.2, 9.6, 12.4, 12.4, 3.6, 12.4],
    ['o', HILITE, 5.6, 6.6, 10.4, 6.6, 11.2, 8.4, 4.8, 8.4],
  ],
  nugget: [
    ['p', 0, 6.2, 5.6, 9.8, 6.2, 10.8, 9.0, 8.6, 11.2, 5.8, 10.2, 5.2, 7.8],
    ['o', HILITE, 6.8, 7.2, 8.6, 7.0, 8.8, 8.4, 7.0, 8.6],
  ],
  gem: [
    ['p', 0, 8.0, 2.2, 13.6, 6.6, 11.0, 13.6, 5.0, 13.6, 2.4, 6.6],
    ['o', HILITE, 8.0, 2.2, 11.2, 6.6, 4.8, 6.6],
    ['o', 1, 5.0, 13.6, 11.0, 13.6, 9.6, 9.0, 6.4, 9.0],
  ],
  shard: [
    ['p', 0, 8.0, 1.8, 11.8, 7.0, 9.6, 14.2, 6.2, 12.2, 4.4, 6.4],
    ['o', HILITE, 8.0, 1.8, 9.8, 7.0, 7.2, 7.6],
  ],
  ball: [
    ['c', 8.0, 8.0, 5.2, 1],
    ['c', 7.6, 7.6, 4.2, 0],
    ['c', 6.4, 6.4, 1.5, HILITE],
  ],
  dust: [
    ['c', 5.2, 6.2, 1.6, 0],
    ['c', 9.6, 4.8, 1.2, 1],
    ['c', 7.2, 9.6, 1.9, 0],
    ['c', 11.2, 8.8, 1.4, 1],
    ['c', 5.4, 11.8, 1.2, 0],
    ['c', 10.0, 12.2, 1.1, 1],
  ],
  dye: [
    ['p', 0, 3.6, 12.6, 12.4, 12.6, 10.2, 6.6, 5.8, 6.6],
    ['e', 8.0, 7.0, 2.4, 1.2, HILITE],
  ],
  leather: [
    ['p', 0, 3.0, 4.4, 12.0, 3.6, 13.4, 8.0, 11.6, 12.6, 4.4, 12.4, 2.6, 8.4],
    ['o', 1, 5.2, 6.2, 10.6, 5.8, 11.4, 8.2, 10.2, 10.8, 5.6, 10.6, 4.6, 8.2],
  ],
  string: [
    ['a', 6.0, 5.6, 3.2, 0.5, 3.7, 0.9, 0],
    ['a', 10.0, 10.6, 3.2, 3.6, 6.8, 0.9, 0],
  ],
  feather: [
    ['l', 11.6, 3.4, 4.4, 13.2, 0.9, 1],
    ['p', 0, 11.8, 2.8, 13.4, 6.4, 10.6, 10.4, 6.4, 13.0, 5.4, 10.8, 8.0, 7.4],
  ],
  bone: [
    ['l', 4.4, 8.0, 11.6, 8.0, 2.4, 0],
    ['c', 4.0, 6.5, 1.5, 0],
    ['c', 4.0, 9.5, 1.5, 0],
    ['c', 12.0, 6.5, 1.5, 0],
    ['c', 12.0, 9.5, 1.5, 0],
    ['l', 5.4, 8.0, 10.6, 8.0, 0.6, 1],
  ],
  brick: [
    ['r', 2.0, 5.0, 12.0, 6.2, 0],
    ['l', 2.0, 8.1, 14.0, 8.1, 0.7, 1],
    ['l', 8.0, 5.0, 8.0, 8.1, 0.7, 1],
    ['l', 5.0, 8.1, 5.0, 11.2, 0.7, 1],
    ['l', 11.0, 8.1, 11.0, 11.2, 0.7, 1],
  ],
  paper: [
    ['r', 3.0, 2.8, 10.2, 10.6, 0],
    ['o', SHADE, 10.2, 2.8, 13.2, 2.8, 13.2, 5.8],
    ['l', 4.6, 6.2, 11.4, 6.2, 0.5, 1],
    ['l', 4.6, 8.4, 10.4, 8.4, 0.5, 1],
    ['l', 4.6, 10.6, 11.6, 10.6, 0.5, 1],
  ],
  book: [
    ['p', 0, 2.6, 2.4, 13.4, 2.4, 13.4, 13.6, 2.6, 13.6],
    ['r', 4.6, 3.4, 8.4, 9.2, 1],
    ['r', 2.6, 2.4, 2.0, 11.2, SHADE],
  ],
  map: [
    ['r', 2.6, 3.0, 10.8, 10.2, 0],
    ['l', 4.4, 6.0, 11.6, 6.0, 0.6, 1],
    ['l', 4.4, 8.4, 10.0, 8.4, 0.6, 1],
    ['l', 4.4, 10.6, 11.2, 10.6, 0.6, 1],
    ['c', 10.8, 10.6, 1.1, '#e0384a'],
  ],
  name_tag: [
    ['p', 0, 4.2, 4.4, 13.6, 4.4, 13.6, 11.6, 4.2, 11.6, 2.2, 8.0],
    ['c', 4.8, 8.0, 0.9, SHADE],
    ['l', 4.6, 7.6, 1.6, 4.6, 0.7, 1],
  ],
  clock: [
    ['c', 8.0, 8.0, 6.0, 0],
    ['c', 8.0, 8.0, 4.6, 1],
    ['l', 8.0, 8.0, 8.0, 4.8, 0.8, '#101828'],
    ['l', 8.0, 8.0, 10.6, 8.8, 0.7, '#101828'],
    ['c', 8.0, 8.0, 0.7, '#101828'],
  ],
  compass: [
    ['c', 8.0, 8.0, 6.0, 0],
    ['c', 8.0, 8.0, 4.6, '#1b2436'],
    ['o', 1, 8.0, 3.8, 9.4, 8.0, 8.0, 7.2],
    ['o', '#eef3fa', 8.0, 12.2, 6.6, 8.0, 8.0, 8.8],
  ],
  disc: [
    ['c', 8.0, 8.0, 6.2, 1],
    ['a', 8.0, 8.0, 4.6, 0, TAU, 0.6, 'rgba(255,255,255,0.13)'],
    ['c', 8.0, 8.0, 2.3, 0],
    ['c', 8.0, 8.0, 0.6, '#0b0b0d'],
  ],
  bucket: [
    ['a', 8.0, 5.2, 4.2, Math.PI, TAU, 0.8, 0],
    ['p', 0, 3.4, 4.6, 12.6, 4.6, 11.0, 13.6, 5.0, 13.6],
    ['o', 1, 4.6, 6.4, 11.4, 6.4, 10.3, 12.6, 5.7, 12.6],
    ['r', 3.1, 4.0, 9.8, 1.5, 0],
  ],
  bottle: [
    ['r', 6.6, 1.8, 2.8, 3.4, 0],
    ['p', 0, 4.8, 5.6, 11.2, 5.6, 12.2, 9.0, 12.2, 13.4, 3.8, 13.4, 3.8, 9.0],
    ['o', 1, 4.4, 9.4, 11.6, 9.4, 11.6, 12.8, 4.4, 12.8],
    ['r', 6.2, 1.0, 3.6, 1.6, '#c9a05a'],
  ],
  snowball: [
    ['c', 8.0, 8.0, 5.2, 1],
    ['c', 7.7, 7.7, 4.4, 0],
    ['c', 6.3, 6.4, 1.6, '#ffffff'],
  ],
  egg: [
    ['e', 8.0, 8.8, 4.2, 5.2, 0],
    ['c', 6.4, 7.4, 0.9, 1],
    ['c', 9.6, 9.8, 0.8, 1],
  ],
  spawn_egg: [
    ['e', 8.0, 8.8, 4.4, 5.4, 0],
    ['c', 6.2, 6.8, 1.1, 1],
    ['c', 9.6, 8.4, 1.3, 1],
    ['c', 7.0, 11.2, 1.1, 1],
  ],
  seed: [
    ['e', 5.8, 7.4, 1.5, 2.3, 0],
    ['e', 10.0, 6.6, 1.5, 2.3, 0],
    ['e', 8.0, 11.0, 1.5, 2.3, 0],
    ['e', 5.8, 7.0, 0.6, 1.0, 1],
    ['e', 10.0, 6.2, 0.6, 1.0, 1],
    ['e', 8.0, 10.6, 0.6, 1.0, 1],
  ],
  sapling: [
    ['l', 8.0, 13.6, 8.0, 8.2, 1.1, 1],
    ['c', 8.0, 6.4, 3.2, 0],
    ['c', 5.2, 8.4, 2.2, 0],
    ['c', 10.8, 8.4, 2.2, 0],
  ],
  wheat: [
    ['l', 8.0, 14.0, 8.0, 5.0, 1.0, 0],
    ['e', 6.2, 6.2, 1.3, 2.0, 1],
    ['e', 9.8, 6.2, 1.3, 2.0, 1],
    ['e', 6.2, 9.2, 1.3, 2.0, 1],
    ['e', 9.8, 9.2, 1.3, 2.0, 1],
    ['e', 8.0, 4.2, 1.3, 2.0, 0],
  ],

  /* -- food ---------------------------------------------------------------- */
  bread: [
    ['e', 8.0, 9.0, 6.0, 4.0, 1],
    ['e', 8.0, 8.4, 5.2, 3.3, 0],
    ['l', 5.6, 7.4, 6.8, 9.6, 0.7, 1],
    ['l', 8.0, 6.8, 9.2, 9.0, 0.7, 1],
    ['l', 10.2, 7.4, 11.2, 9.4, 0.7, 1],
  ],
  cookie: [
    ['c', 8.0, 8.0, 5.4, 0],
    ['c', 6.0, 6.6, 0.9, 1],
    ['c', 10.0, 7.0, 0.9, 1],
    ['c', 7.6, 10.2, 0.9, 1],
    ['c', 10.4, 10.2, 0.8, 1],
  ],
  cake: [
    ['r', 2.6, 7.0, 10.8, 6.2, 1],
    ['r', 2.6, 4.4, 10.8, 2.9, 0],
    ['c', 5.0, 4.0, 1.0, '#e0384a'],
    ['c', 8.0, 3.6, 1.0, '#e0384a'],
    ['c', 11.0, 4.0, 1.0, '#e0384a'],
  ],
  pie: [
    ['e', 8.0, 9.6, 5.8, 3.6, 1],
    ['e', 8.0, 8.4, 5.2, 2.9, 0],
    ['c', 3.4, 9.2, 1.0, 1],
    ['c', 6.4, 11.4, 1.0, 1],
    ['c', 9.6, 11.4, 1.0, 1],
    ['c', 12.6, 9.2, 1.0, 1],
  ],
  slice: [
    ['p', 0, 2.4, 12.2, 13.6, 12.2, 8.0, 3.4],
    ['r', 2.0, 12.0, 12.0, 1.8, 1],
    ['e', 6.6, 10.2, 0.7, 1.0, '#20160f'],
    ['e', 9.4, 10.2, 0.7, 1.0, '#20160f'],
    ['e', 8.0, 7.6, 0.7, 1.0, '#20160f'],
  ],
  food_round: [
    ['c', 8.0, 8.8, 5.0, 0],
    ['e', 6.2, 6.8, 1.6, 1.0, HILITE],
    ['l', 8.0, 4.2, 8.0, 2.2, 0.9, 1],
    ['e', 9.9, 2.6, 1.9, 1.0, 1],
  ],
  meat: [
    ['e', 8.4, 9.2, 5.0, 4.0, 0],
    ['e', 8.4, 9.0, 3.6, 2.6, 1],
    ['l', 3.2, 4.4, 6.2, 7.4, 2.0, '#efece2'],
    ['c', 3.0, 4.2, 1.4, '#efece2'],
  ],
  fish: [
    ['e', 7.4, 8.4, 5.0, 3.2, 0],
    ['p', 0, 12.0, 8.4, 14.8, 5.6, 14.8, 11.2],
    ['o', 1, 7.0, 5.4, 9.8, 5.2, 8.4, 6.8],
    ['c', 4.8, 7.4, 0.8, '#141821'],
  ],
  carrot: [
    ['p', 0, 6.6, 5.6, 10.0, 5.0, 8.7, 14.2, 7.6, 14.0],
    ['l', 7.5, 5.6, 5.4, 2.4, 1.2, 1],
    ['l', 8.2, 5.4, 8.2, 1.8, 1.2, 1],
    ['l', 9.0, 5.6, 11.2, 2.8, 1.2, 1],
  ],
  potato: [
    ['e', 8.0, 8.6, 4.8, 4.0, 0],
    ['c', 6.2, 7.4, 0.7, 1],
    ['c', 9.6, 9.6, 0.6, 1],
    ['c', 9.2, 6.6, 0.5, 1],
  ],
  bowl: [
    ['p', 0, 2.4, 7.6, 13.6, 7.6, 11.4, 12.8, 4.6, 12.8],
    ['r', 2.1, 6.8, 11.8, 1.5, 0],
  ],
  stew: [
    ['e', 8.0, 8.0, 5.3, 1.7, 1],
    ['p', 0, 2.4, 8.0, 13.6, 8.0, 11.4, 13.0, 4.6, 13.0],
    ['r', 2.1, 7.0, 11.8, 1.5, 0],
    ['e', 8.0, 7.4, 4.6, 1.4, 1],
  ],
});

/** Item icons already rendered, keyed by item id. @type {Map<number, string>} */
const ICON_CACHE = new Map();

/** Block previews delivered by the renderer, keyed by block id. @type {Map<number, string>} */
const BLOCK_ICONS = new Map();

/** True once the block-icon batch settled (successfully or not). @type {boolean} */
let blockIconsReady = false;

/** The running block-icon batch, so it is requested exactly once. @type {?Promise<void>} */
let blockIconJob = null;

/** Reused offscreen canvas for sprite rasterisation. @type {?HTMLCanvasElement} */
let spriteCanvas = null;

/** 2D context of {@link spriteCanvas}. @type {?CanvasRenderingContext2D} */
let spriteCtx = null;

/**
 * Resolve a colour slot of a sprite pattern.
 * @param {ReadonlyArray<string>} colors colours supplied by the item
 * @param {(number|string)} slot colour index or literal CSS colour
 * @returns {string} a CSS colour
 */
function pickColor(colors, slot) {
  if (typeof slot === 'string') return slot;
  const index = slot | 0;
  const value = colors[index];
  if (typeof value === 'string' && value.length > 0) return value;
  return FALLBACK_COLORS[index] || FALLBACK_COLORS[0];
}

/**
 * Draw one sprite family into a 2D context. The context must already be scaled
 * so that the 16x16 design space fills the target.
 *
 * @param {CanvasRenderingContext2D} ctx destination context, scaled to 16x16
 * @param {string} pattern a key of the internal sprite table
 * @param {ReadonlyArray<string>} colors colours from `items.itemIcon().colors`
 * @returns {boolean} true when the pattern was known and drawn
 */
export function drawItemSprite(ctx, pattern, colors) {
  const ops = SPRITES[pattern];
  if (ops === undefined) return false;
  const list = colors || FALLBACK_COLORS;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const kind = op[0];
    if (kind === 'r') {
      ctx.fillStyle = pickColor(list, /** @type {number|string} */ (op[5]));
      ctx.fillRect(+op[1], +op[2], +op[3], +op[4]);
    } else if (kind === 'p' || kind === 'o') {
      ctx.beginPath();
      ctx.moveTo(+op[2], +op[3]);
      for (let k = 4; k + 1 < op.length; k += 2) ctx.lineTo(+op[k], +op[k + 1]);
      ctx.closePath();
      ctx.fillStyle = pickColor(list, /** @type {number|string} */ (op[1]));
      ctx.fill();
      if (kind === 'p') {
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 0.55;
        ctx.stroke();
      }
    } else if (kind === 'c') {
      ctx.beginPath();
      ctx.arc(+op[1], +op[2], +op[3], 0, TAU);
      ctx.fillStyle = pickColor(list, /** @type {number|string} */ (op[4]));
      ctx.fill();
    } else if (kind === 'e') {
      ctx.beginPath();
      ctx.ellipse(+op[1], +op[2], +op[3], +op[4], 0, 0, TAU);
      ctx.fillStyle = pickColor(list, /** @type {number|string} */ (op[5]));
      ctx.fill();
    } else if (kind === 'l') {
      ctx.beginPath();
      ctx.moveTo(+op[1], +op[2]);
      ctx.lineTo(+op[3], +op[4]);
      ctx.lineWidth = +op[5];
      ctx.strokeStyle = pickColor(list, /** @type {number|string} */ (op[6]));
      ctx.stroke();
    } else if (kind === 'a') {
      ctx.beginPath();
      ctx.arc(+op[1], +op[2], +op[3], +op[4], +op[5]);
      ctx.lineWidth = +op[6];
      ctx.strokeStyle = pickColor(list, /** @type {number|string} */ (op[7]));
      ctx.stroke();
    }
  }
  return true;
}

/**
 * Make sure the shared rasterisation canvas exists.
 * @returns {?CanvasRenderingContext2D} the context, or `null` without a DOM
 */
function ensureSpriteCanvas() {
  if (spriteCtx !== null) return spriteCtx;
  if (typeof document === 'undefined') return null;
  spriteCanvas = document.createElement('canvas');
  spriteCanvas.width = ICON_PX;
  spriteCanvas.height = ICON_PX;
  const ctx = spriteCanvas.getContext('2d');
  if (ctx === null) {
    warnOnce('canvas', 'no 2D context available; item sprites stay blank.');
    return null;
  }
  spriteCtx = ctx;
  return spriteCtx;
}

/**
 * Rasterise a sprite pattern into a PNG data URL.
 * @param {string} pattern pattern name
 * @param {ReadonlyArray<string>} colors item colours
 * @returns {?string} the data URL, or `null` when rasterisation is impossible
 */
function rasterizeSprite(pattern, colors) {
  const ctx = ensureSpriteCanvas();
  if (ctx === null) return null;
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ICON_PX, ICON_PX);
    ctx.setTransform(ICON_PX / 16, 0, 0, ICON_PX / 16, 0, 0);
    const drawn = drawItemSprite(ctx, pattern, colors);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!drawn) return null;
    return spriteCanvas.toDataURL('image/png');
  } catch (err) {
    warnOnce(`raster:${pattern}`, `could not rasterise sprite "${pattern}".`, err);
    return null;
  }
}

/**
 * Deterministic hue for a block id, used by the fallback cube preview when the
 * renderer cannot produce real icons.
 * @param {number} blockId block id
 * @returns {number} hue in degrees
 */
function blockHue(blockId) {
  let h = Math.imul(blockId + 0x9e3779b9, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h >>> 8) % 360;
}

/**
 * Draw a flat isometric cube as the fallback preview of a block item.
 * @param {number} blockId block id
 * @returns {?string} the data URL, or `null`
 */
function rasterizeCube(blockId) {
  const ctx = ensureSpriteCanvas();
  if (ctx === null) return null;
  try {
    const hue = blockHue(blockId);
    const top = `hsl(${hue} 34% 62%)`;
    const left = `hsl(${hue} 32% 44%)`;
    const right = `hsl(${hue} 30% 34%)`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ICON_PX, ICON_PX);
    ctx.setTransform(ICON_PX / 16, 0, 0, ICON_PX / 16, 0, 0);
    ctx.lineJoin = 'round';
    const face = (color, points) => {
      ctx.beginPath();
      ctx.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 0.4;
      ctx.stroke();
    };
    face(top, [8, 1.6, 14.2, 5.2, 8, 8.8, 1.8, 5.2]);
    face(left, [1.8, 5.2, 8, 8.8, 8, 14.4, 1.8, 10.8]);
    face(right, [14.2, 5.2, 14.2, 10.8, 8, 14.4, 8, 8.8]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return spriteCanvas.toDataURL('image/png');
  } catch (err) {
    warnOnce('cube', 'could not rasterise the fallback block preview.', err);
    return null;
  }
}

/**
 * Data URL of an item's icon, or `null` while a block preview is still being
 * rendered by the GPU. Results are cached forever — icons never change.
 *
 * @param {number} itemId item id
 * @returns {?string} `data:image/png;base64,…`, or `null` when not ready
 */
export function itemIconURL(itemId) {
  if (!(itemId > 0)) return null;
  const cached = ICON_CACHE.get(itemId);
  if (cached !== undefined) return cached;

  const icon = itemIcon(itemId);
  if (icon === null || icon === undefined) return null;

  if (icon.type === 'block') {
    const url = BLOCK_ICONS.get(icon.blockId);
    if (typeof url === 'string') {
      ICON_CACHE.set(itemId, url);
      return url;
    }
    if (!blockIconsReady) return null;
    const fallback = rasterizeCube(icon.blockId);
    if (fallback === null) return null;
    ICON_CACHE.set(itemId, fallback);
    return fallback;
  }

  const url = rasterizeSprite(icon.pattern, icon.colors);
  if (url === null) return null;
  ICON_CACHE.set(itemId, url);
  return url;
}

/**
 * Ask the renderer for the isometric preview of every block item, exactly once
 * per page. Failure is not fatal: {@link itemIconURL} then falls back to a
 * procedurally shaded cube.
 *
 * @param {*} renderer the `render/renderer.js` Renderer (duck-typed)
 * @returns {Promise<void>} resolves once previews are available (or gave up)
 */
export function prepareBlockIcons(renderer) {
  if (blockIconJob !== null) return blockIconJob;
  const textures = renderer && renderer.textures;
  if (!textures || typeof textures.renderBlockIcons !== 'function') {
    blockIconsReady = true;
    blockIconJob = Promise.resolve();
    return blockIconJob;
  }
  /** @type {number[]} */
  const ids = [];
  const seen = new Set();
  for (let i = 1; i < ITEMS.length; i++) {
    const icon = ITEMS[i].icon;
    if (icon === undefined || icon === null || icon.type !== 'block') continue;
    const blockId = icon.blockId | 0;
    if (blockId <= 0 || seen.has(blockId)) continue;
    seen.add(blockId);
    ids.push(blockId);
  }
  blockIconJob = Promise.resolve()
    .then(() => textures.renderBlockIcons(ids, ICON_PX))
    .then((map) => {
      if (map && typeof map.forEach === 'function') {
        map.forEach((url, blockId) => {
          if (typeof url === 'string' && url.length > 0) BLOCK_ICONS.set(blockId | 0, url);
        });
      }
    })
    .catch((err) => {
      warnOnce('icons', 'the renderer could not draw block previews; using flat cubes.', err);
    })
    .then(() => {
      blockIconsReady = true;
    });
  return blockIconJob;
}

/* ========================================================================== */
/* Ghost glyphs for typed slots                                               */
/* ========================================================================== */

/** Path data for the ghost glyph of every typed slot, in a 24x24 box. */
const GHOSTS = Object.freeze({
  helmet: 'M4 19v-6a8 8 0 0 1 16 0v6h-4v-4H8v4H4z',
  chestplate: 'M5 4l4-2h6l4 2 1 5-2 1v12H6V10L4 9l1-5z',
  leggings: 'M5 2h14v5h-3v15h-3V12h-2v10H8V7H5V2z',
  boots: 'M3 4h5v10h3v6H3V4zm10 0h5v16h-8v-6h3V4z',
  offhand: 'M12 2l8 3v7c0 5-3.6 8.6-8 10-4.4-1.4-8-5-8-10V5l8-3z',
  fuel: 'M12 23c-4.4 0-7.6-3-7.6-7.2 0-4.4 3.4-6.6 4.4-11.2.3-1.3.2-2.6-.2-3.6 3.8 1.8 6 4.8 6.4 8.2.9-.8 1.4-1.9 1.5-3.2 2.4 2.4 3.5 5.8 3.5 9 0 4.8-3.2 8-8 8z',
  smelt: 'M12 3v13m0 0l-5-5m5 5l5-5M4 21h16',
  result: 'M4 12h13m0 0l-5-5m5 5l-5 5',
});

/**
 * Build the ghost glyph shown in an empty typed slot.
 * @param {string} name a key of the ghost table
 * @returns {?SVGElement} the glyph, or `null` for an unknown name
 */
function ghostGlyph(name) {
  const d = GHOSTS[name];
  if (d === undefined) return null;
  const stroked = name === 'smelt' || name === 'result';
  return svgIcon('vx-cell__ghost', '0 0 24 24', [
    stroked ? { d, fill: 'none', stroke: 'currentColor', width: 2 } : { d },
  ]);
}

/* ========================================================================== */
/* InventoryUI                                                                */
/* ========================================================================== */

/**
 * The container screen: player inventory, crafting grids, furnace and chest.
 *
 * The class is created once during boot and reused for every container; a
 * closed screen costs nothing per frame.
 */
export class InventoryUI {
  /**
   * @param {*} game the `Game` instance (duck-typed: `player`, `world`,
   *   `entities`, `renderer`, `input`, `audio`, `combat`, `settings`)
   * @param {HTMLElement} root the `#ui` root element
   */
  constructor(game, root) {
    ensureStyles();

    /** @type {*} the game */
    this.game = game || null;
    /** @type {?HTMLElement} the UI root */
    this.root = root || null;

    /** @type {boolean} is a container window on screen? @private */
    this._open = false;
    /** @type {string} the kind currently shown. @private */
    this._kind = 'inventory';
    /** @type {?Object} the open container, or `null` for the plain inventory */
    this.container = null;
    /** @type {?Object} the player inventory the screen is bound to */
    this.playerInv = null;
    /** @type {boolean} set by {@link InventoryUI#dispose}. @private */
    this._disposed = false;

    /* ---- layer ---------------------------------------------------------- */

    /** @type {HTMLElement} modal layer holding the window and the drag ghost */
    this.layer = el('div', 'vx-layer vx-containers');
    /** @type {HTMLElement} flex stage: window plus optional recipe book */
    this.stage = el('div', 'vx-containers__stage');
    this.layer.appendChild(this.stage);

    /** @type {HTMLElement} the container window itself */
    this.win = el('div', 'vx-gui');
    this.win.setAttribute('role', 'dialog');
    this.win.setAttribute('aria-modal', 'true');
    this.stage.appendChild(this.win);

    /** @type {HTMLElement} window header @private */
    this._head = el('div', 'vx-gui__head');
    /** @type {HTMLElement} window title @private */
    this._title = el('h2', 'vx-gui__title', 'Inventar');
    /** @type {HTMLElement} header buttons @private */
    this._actions = el('div', 'vx-gui__actions');
    /** @type {HTMLButtonElement} recipe-book toggle @private */
    this._bookBtn = /** @type {HTMLButtonElement} */ (el('button', 'vx-btn vx-btn--sm', 'Rezeptbuch'));
    this._bookBtn.type = 'button';
    /** @type {HTMLButtonElement} close button @private */
    this._closeBtn = /** @type {HTMLButtonElement} */ (el('button', 'vx-gui__close'));
    this._closeBtn.type = 'button';
    this._closeBtn.title = 'Schließen';
    this._closeBtn.setAttribute('aria-label', 'Schließen');
    this._closeBtn.appendChild(svgIcon('', '0 0 24 24', [
      { d: 'M6 6l12 12M18 6L6 18', fill: 'none', stroke: 'currentColor', width: 2 },
    ]));
    this._actions.appendChild(this._bookBtn);
    this._actions.appendChild(this._closeBtn);
    this._head.appendChild(this._title);
    this._head.appendChild(this._actions);
    this.win.appendChild(this._head);

    /** @type {HTMLElement} scrolling window body @private */
    this._body = el('div', 'vx-gui__body vx-scroll');
    this.win.appendChild(this._body);

    /** @type {HTMLElement} keyboard/mouse hint line @private */
    this._hint = el('div', 'vx-gui__hint',
      'Klick: Stapel nehmen · Rechtsklick: Hälfte · Umschalt+Klick: verschieben · '
      + 'Ziehen: gleichmäßig verteilen · außerhalb loslassen: wegwerfen');
    this.win.appendChild(this._hint);

    /* ---- recipe book ---------------------------------------------------- */

    /** @type {HTMLElement} recipe-book panel @private */
    this._book = el('aside', 'vx-recipes is-hidden');
    /** @type {HTMLElement} @private */
    this._bookTabs = el('div', 'vx-tabs vx-recipes__tabs');
    /** @type {HTMLElement} @private */
    this._bookSearch = el('div', 'vx-search');
    /** @type {HTMLInputElement} @private */
    this._bookInput = /** @type {HTMLInputElement} */ (el('input'));
    this._bookInput.type = 'search';
    this._bookInput.placeholder = 'Rezept suchen…';
    this._bookInput.setAttribute('aria-label', 'Rezept suchen');
    this._bookSearch.appendChild(svgIcon('vx-btn__icon', '0 0 24 24', [
      { d: 'M10.5 3a7.5 7.5 0 1 0 4.55 13.45L20 21.4 21.4 20l-4.95-4.95A7.5 7.5 0 0 0 10.5 3zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z' },
    ]));
    this._bookSearch.appendChild(this._bookInput);
    /** @type {HTMLElement} @private */
    this._bookList = el('div', 'vx-recipes__list vx-scroll');
    /** @type {HTMLElement} @private */
    this._bookEmpty = el('div', 'vx-recipes__empty',
      'Keine passenden Rezepte. Sammle mehr Rohstoffe.');
    this._book.appendChild(el('div', 'vx-gui__legend', 'Rezeptbuch'));
    this._book.appendChild(this._bookSearch);
    this._book.appendChild(this._bookTabs);
    this._book.appendChild(this._bookList);
    this._book.appendChild(this._bookEmpty);
    this.stage.appendChild(this._book);

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

    /* ---- slot & state --------------------------------------------------- */

    /** @type {Array<Object>} every slot view currently mounted. @private */
    this._slots = [];
    /** @type {Map<Object, Map<number, Object>>} inventory -> index -> slot view. @private */
    this._byInv = new Map();
    /** @type {Set<Object>} slot views waiting for a repaint. @private */
    this._dirty = new Set();
    /** @type {Array<Function>} teardown callbacks for event subscriptions. @private */
    this._unsub = [];

    /** @type {?ItemStack} the stack on the cursor */
    this.held = null;
    /** @type {?Object} active paint-drag: `{button, slots, moved}`. @private */
    this._paint = null;
    /** @type {number} last pointer X in viewport pixels. @private */
    this._px = 0;
    /** @type {number} last pointer Y in viewport pixels. @private */
    this._py = 0;
    /** @type {?Object} slot view under the cursor. @private */
    this._hover = null;
    /** @type {?HTMLElement} cell marked as the selected hotbar slot. @private */
    this._selCell = null;

    /** @type {?Inventory} 3x3 crafting grid of the crafting table. @private */
    this._tableGrid = null;
    /** @type {?Inventory} single-slot result inventory of the table. @private */
    this._tableResult = null;
    /** @type {?Inventory} inventory holding the active crafting grid. @private */
    this._gridInv = null;
    /** @type {number} slot index of grid cell 0. @private */
    this._gridOffset = 0;
    /** @type {number} crafting grid width. @private */
    this._gridW = 0;
    /** @type {number} crafting grid height. @private */
    this._gridH = 0;
    /** @type {?Object} the current `CraftMatch`, or null. @private */
    this._match = null;
    /** @type {number} grid version the match was computed from. @private */
    this._matchVersion = -1;

    /** @type {?HTMLElement} furnace flame. @private */
    this._flame = null;
    /** @type {?HTMLElement} furnace progress bar. @private */
    this._cookBar = null;
    /** @type {number} last flame fill written to the DOM. @private */
    this._lastBurn = -1;
    /** @type {number} last cook progress written to the DOM. @private */
    this._lastCook = -1;

    /** @type {boolean} is the recipe book visible? @private */
    this._bookOpen = false;
    /** @type {string} active recipe-book category, `'all'` for everything. @private */
    this._bookCategory = 'all';
    /** @type {string} lower-cased search text. @private */
    this._bookQuery = '';
    /** @type {string} signature of the recipes currently rendered. @private */
    this._bookSignature = '';
    /** @type {Array<Object>} recipes rendered, parallel to the cells. @private */
    this._bookRecipes = [];
    /** @type {HTMLElement[]} pooled recipe cells. @private */
    this._bookCells = [];
    /** @type {number} seconds until the next recipe-book refresh. @private */
    this._bookTimer = 0;
    /** @type {boolean} the recipe book must be recomputed. @private */
    this._bookDirty = true;

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
    /** @type {function(Event):void} @private */
    this._onBookInput = () => {
      this._bookQuery = this._bookInput.value.trim().toLowerCase();
      this._bookSignature = '';
      this._bookDirty = true;
    };

    this.layer.addEventListener('pointerdown', this._onPointerDown);
    this.layer.addEventListener('contextmenu', this._onContextMenu);
    this._bookInput.addEventListener('input', this._onBookInput);
    this._bookInput.addEventListener('focus', () => this._setTyping(true));
    this._bookInput.addEventListener('blur', () => this._setTyping(false));
    this._bookBtn.addEventListener('click', () => this.toggleRecipeBook());
    this._closeBtn.addEventListener('click', () => this.close());
    window.addEventListener('pointermove', this._onPointerMove, true);
    window.addEventListener('pointerup', this._onPointerUp, true);
    window.addEventListener('keydown', this._onKeyDown, true);

    this._buildBookTabs();
  }

  /* ====================================================================== */
  /* Public API                                                             */
  /* ====================================================================== */

  /**
   * Whether a container window is currently on screen.
   * @returns {boolean} true while open
   */
  get isOpen() {
    return this._open;
  }

  /**
   * The kind of window currently shown.
   * @returns {string} one of {@link GUI_KINDS}
   */
  get kind() {
    return this._kind;
  }

  /**
   * Open a container window.
   *
   * @param {string} [kind] `'inventory'`, `'crafting'`, `'furnace'` or
   *   `'chest'`; anything else is derived from `container.kind`
   * @param {?Object} [container] the {@link Inventory}/`Container` to show
   * @returns {boolean} true when the window is now open
   */
  open(kind, container) {
    if (this._disposed) return false;
    const player = this.game && this.game.player;
    const inv = player && player.inventory;
    if (!inv || typeof inv.get !== 'function') {
      warnOnce('noinv', 'open() without a player inventory; the screen stays closed.');
      return false;
    }
    if (this._open) this.close();

    this.playerInv = inv;
    this.container = (container && typeof container.get === 'function') ? container : null;
    this._kind = this._resolveKind(kind, this.container);

    prepareBlockIcons(this.game && this.game.renderer).then(() => {
      if (this._open) this._refreshAll();
    }).catch(() => undefined);

    if (this.container !== null && this.container.isFurnace
      && typeof this.container.setResolvers === 'function') {
      try { this.container.setResolvers(smeltResult, fuelValue); } catch (err) {
        warnOnce('resolvers', 'the furnace could not receive its smelting tables.', err);
      }
    }

    this._build();
    this._subscribe();

    this._open = true;
    this.layer.style.pointerEvents = 'auto';
    setClass(this.layer, 'is-open', true);
    this._bookDirty = true;
    this._bookSignature = '';
    this._bookTimer = 0;
    this._lastBurn = -1;
    this._lastCook = -1;
    this._matchVersion = -1;

    setClass(this._bookBtn, 'is-hidden', !this._hasCrafting());
    setClass(this._book, 'is-hidden', !(this._bookOpen && this._hasCrafting()));

    if (this.container !== null && typeof this.container.open === 'function') {
      try { this.container.open(); } catch (err) { warnOnce('copen', 'container.open() failed.', err); }
    }

    this._releasePointer();
    this._pushState();
    this._playUI('click');
    this._refreshAll();
    this._updateCraftResult(true);
    return true;
  }

  /**
   * Close the window, returning the cursor stack and the crafting grid to the
   * player. Anything that no longer fits is thrown into the world.
   * @returns {void}
   */
  close() {
    if (!this._open) return;
    this._open = false;
    this._paint = null;
    this._hover = null;

    this._returnHeld();
    this._returnGrid();

    if (this.container !== null && typeof this.container.close === 'function') {
      try { this.container.close(); } catch (err) { warnOnce('cclose', 'container.close() failed.', err); }
    }

    this._unsubscribe();
    setClass(this.layer, 'is-open', false);
    setClass(this._tip, 'is-on', false);
    setClass(this._dragEl, 'is-hidden', true);
    this.layer.style.pointerEvents = 'none';
    this._setTyping(false);

    this.container = null;
    this._tableGrid = null;
    this._tableResult = null;
    this._gridInv = null;
    this._match = null;
    this._flame = null;
    this._cookBar = null;

    this._popState();
    this._grabPointer();
    this._playUI('click');
  }

  /**
   * Show or hide the recipe book.
   * @param {boolean} [force] desired state; toggles when omitted
   * @returns {boolean} the new state
   */
  toggleRecipeBook(force) {
    const want = force === undefined ? !this._bookOpen : force === true;
    this._bookOpen = want && this._hasCrafting();
    setClass(this._book, 'is-hidden', !this._bookOpen);
    setClass(this._bookBtn, 'is-active', this._bookOpen);
    if (this._bookOpen) {
      this._bookDirty = true;
      this._bookSignature = '';
      this._bookTimer = 0;
    }
    return this._bookOpen;
  }

  /**
   * Per-frame refresh. Costs nothing while the screen is closed.
   * @param {number} dt seconds since the previous frame
   * @returns {void}
   */
  update(dt) {
    if (!this._open || this._disposed) return;
    const step = Number.isFinite(dt) ? dt : 0;
    this._guard('update', () => {
      this._flushDirty();
      this._syncSelection();
      this._updateCraftResult(false);
      this._updateFurnace();
      this._bookTimer -= step;
      if (this._bookOpen && this._bookDirty && this._bookTimer <= 0) {
        this._bookTimer = BOOK_INTERVAL;
        this._bookDirty = false;
        this._rebuildBook();
      }
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
    this._bookCells.length = 0;
    this._bookRecipes.length = 0;
  }

  /* ====================================================================== */
  /* Layout                                                                 */
  /* ====================================================================== */

  /**
   * Normalise the requested window kind.
   * @param {*} kind requested kind
   * @param {?Object} container the container, when one was passed
   * @returns {string} a value of {@link GUI_KINDS}
   * @private
   */
  _resolveKind(kind, container) {
    const raw = typeof kind === 'string' ? kind.toLowerCase() : '';
    if (raw === 'inventory' || raw === 'player') return 'inventory';
    if (raw === 'crafting' || raw === 'crafting_table' || raw === 'workbench' || raw === 'table') {
      return 'crafting';
    }
    if (container !== null) {
      if (container.isFurnace === true) return 'furnace';
      return 'chest';
    }
    if (raw === 'furnace' || raw === 'blast_furnace' || raw === 'smoker') return 'furnace';
    if (raw === 'chest') return 'chest';
    return 'inventory';
  }

  /** @returns {boolean} does the open window have a crafting grid? @private */
  _hasCrafting() {
    return this._kind === 'inventory' || this._kind === 'crafting';
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
    this._gridInv = null;
    this._gridOffset = 0;
    this._gridW = 0;
    this._gridH = 0;
    this._match = null;
    this._flame = null;
    this._cookBar = null;
    this._selCell = null;

    const container = this.container;
    let title = KIND_TITLES[this._kind] || 'Inventar';
    if (container !== null && typeof container.title === 'string' && container.title.length > 0) {
      title = container.title;
    } else if (this._kind === 'crafting') {
      title = KIND_TITLES.crafting;
    }
    setText(this._title, title);

    if (this._kind === 'inventory') this._buildPlayerTop();
    else if (this._kind === 'crafting') this._buildTableTop();
    else if (this._kind === 'furnace') this._buildFurnaceTop();
    else this._buildChestTop();

    this._buildBackpack();
  }

  /**
   * Armour column, off-hand and the 2x2 grid.
   * @returns {void}
   * @private
   */
  _buildPlayerTop() {
    const inv = this.playerInv;
    const top = el('div', 'vx-gui__top');

    const armorCol = el('div', 'vx-gui__stack');
    armorCol.appendChild(el('div', 'vx-gui__legend', 'Rüstung'));
    const armorGrid = el('div', 'vx-grid vx-grid--armor');
    const ghosts = ['helmet', 'chestplate', 'leggings', 'boots'];
    for (let i = 0; i < 4; i++) {
      armorGrid.appendChild(this._makeCell(inv, SLOT.ARMOR_START + i, 'armor', ghosts[i]));
    }
    armorCol.appendChild(armorGrid);
    armorCol.appendChild(el('div', 'vx-gui__legend', 'Zweite Hand'));
    const offGrid = el('div', 'vx-grid vx-grid--armor');
    offGrid.appendChild(this._makeCell(inv, SLOT.OFFHAND, 'normal', 'offhand'));
    armorCol.appendChild(offGrid);
    top.appendChild(armorCol);

    this._gridInv = inv;
    this._gridOffset = SLOT.CRAFT_START;
    this._gridW = 2;
    this._gridH = 2;

    const craft = el('div', 'vx-crafting');
    const gridCol = el('div', 'vx-gui__stack');
    gridCol.appendChild(el('div', 'vx-gui__legend', 'Handwerk'));
    const grid = el('div', 'vx-grid vx-grid--craft2');
    for (let i = 0; i < 4; i++) {
      grid.appendChild(this._makeCell(inv, SLOT.CRAFT_START + i, 'grid'));
    }
    gridCol.appendChild(grid);
    craft.appendChild(gridCol);
    craft.appendChild(this._makeArrow());
    const resultCol = el('div', 'vx-gui__stack');
    resultCol.appendChild(el('div', 'vx-gui__legend', 'Ergebnis'));
    const resultGrid = el('div', 'vx-grid vx-grid--armor');
    resultGrid.appendChild(this._makeCell(inv, SLOT.CRAFT_RESULT, 'result', 'result'));
    resultCol.appendChild(resultGrid);
    craft.appendChild(resultCol);
    top.appendChild(craft);

    this._body.appendChild(top);
  }

  /**
   * The 3x3 crafting-table grid on its own scratch inventory.
   * @returns {void}
   * @private
   */
  _buildTableTop() {
    this._tableGrid = new Inventory(9, { title: 'Werkbank' });
    this._tableResult = new Inventory(1, { title: 'Ergebnis' });
    this._gridInv = this._tableGrid;
    this._gridOffset = 0;
    this._gridW = 3;
    this._gridH = 3;

    const top = el('div', 'vx-gui__top');
    const craft = el('div', 'vx-crafting');
    const gridCol = el('div', 'vx-gui__stack');
    gridCol.appendChild(el('div', 'vx-gui__legend', 'Handwerk'));
    const grid = el('div', 'vx-grid vx-grid--craft3');
    for (let i = 0; i < 9; i++) grid.appendChild(this._makeCell(this._tableGrid, i, 'grid'));
    gridCol.appendChild(grid);
    craft.appendChild(gridCol);
    craft.appendChild(this._makeArrow());
    const resultCol = el('div', 'vx-gui__stack');
    resultCol.appendChild(el('div', 'vx-gui__legend', 'Ergebnis'));
    const resultGrid = el('div', 'vx-grid vx-grid--armor');
    resultGrid.appendChild(this._makeCell(this._tableResult, 0, 'result', 'result'));
    resultCol.appendChild(resultGrid);
    craft.appendChild(resultCol);
    top.appendChild(craft);
    this._body.appendChild(top);
  }

  /**
   * Input / fuel column with the animated flame, then the progress arrow and
   * the output slot.
   * @returns {void}
   * @private
   */
  _buildFurnaceTop() {
    const container = this.container;
    const top = el('div', 'vx-gui__top');
    const furnace = el('div', 'vx-furnace');

    const inputCol = el('div', 'vx-furnace__col');
    inputCol.appendChild(el('div', 'vx-gui__legend', 'Schmelzgut'));
    const inGrid = el('div', 'vx-grid vx-grid--furnace');
    inGrid.appendChild(this._makeCell(container, FURNACE_SLOT.INPUT, 'normal', 'smelt'));
    inputCol.appendChild(inGrid);

    this._flame = el('div', 'vx-flame');
    const flamePath = 'M11 26C5.5 26 2 22.3 2 17.2 2 12 6 9.4 7.2 4.2 7.5 2.8 7.4 1.4 7 0'
      + 'c4.4 2 7 5.6 7.4 9.3 1-.9 1.6-2.2 1.7-3.6C19 8.6 20 12.6 20 16.2 20 21.9 16.2 26 11 26Z';
    this._flame.appendChild(svgIcon('', '0 0 22 26', [{ d: flamePath }]));
    const flameFill = el('div', 'vx-flame__fill');
    flameFill.appendChild(svgIcon('', '0 0 22 26', [{ d: flamePath }]));
    this._flame.appendChild(flameFill);
    inputCol.appendChild(this._flame);

    const fuelGrid = el('div', 'vx-grid vx-grid--furnace');
    fuelGrid.appendChild(this._makeCell(container, FURNACE_SLOT.FUEL, 'normal', 'fuel'));
    inputCol.appendChild(fuelGrid);
    inputCol.appendChild(el('div', 'vx-gui__legend', 'Brennstoff'));
    furnace.appendChild(inputCol);

    const arrowCol = el('div', 'vx-furnace__col');
    arrowCol.appendChild(this._makeArrow());
    this._cookBar = el('div', 'vx-arrow vx-arrow--progress');
    this._cookBar.appendChild(el('i'));
    arrowCol.appendChild(this._cookBar);
    furnace.appendChild(arrowCol);

    const outCol = el('div', 'vx-furnace__col');
    outCol.appendChild(el('div', 'vx-gui__legend', 'Ergebnis'));
    const outGrid = el('div', 'vx-grid vx-grid--armor');
    outGrid.appendChild(this._makeCell(container, FURNACE_SLOT.OUTPUT, 'furnace_out', 'result'));
    outCol.appendChild(outGrid);
    furnace.appendChild(outCol);

    top.appendChild(furnace);
    this._body.appendChild(top);
  }

  /**
   * A plain container grid (chest, barrel, hopper, dispenser).
   * @returns {void}
   * @private
   */
  _buildChestTop() {
    const container = this.container;
    if (container === null) return;
    const cols = Number.isFinite(container.cols) && container.cols > 0 ? container.cols | 0 : 9;
    const section = el('div', 'vx-gui__section');
    section.appendChild(el('div', 'vx-gui__legend', container.title || 'Behälter'));
    const grid = el('div', 'vx-grid vx-grid--chest');
    grid.style.setProperty('--cols', String(cols));
    const size = Number.isFinite(container.size) ? container.size | 0 : 0;
    for (let i = 0; i < size; i++) grid.appendChild(this._makeCell(container, i, 'normal'));
    section.appendChild(grid);
    this._body.appendChild(section);
  }

  /**
   * The 27 main slots and the hotbar, present in every window.
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
   * @param {?Object} inv inventory the slot belongs to
   * @param {number} index slot index inside `inv`
   * @param {string} type `'normal'|'hotbar'|'armor'|'grid'|'result'|'furnace_out'`
   * @param {string} [ghost] ghost glyph key for the empty state
   * @returns {HTMLElement} the cell element
   * @private
   */
  _makeCell(inv, index, type, ghost) {
    const cell = el('div', 'vx-cell is-empty');
    if (type === 'result' || type === 'furnace_out') cell.classList.add('is-result');
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
   * Write one slot to the DOM, but only the parts that actually changed.
   * @param {Object} view slot view
   * @returns {void}
   * @private
   */
  _paintSlot(view) {
    const inv = view.inv;
    const stack = (inv !== null && typeof inv.get === 'function') ? inv.get(view.index) : null;
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
   * Keep the frame around the selected hotbar slot in sync. Writes to the DOM
   * only when the selection actually moved.
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
   * Subscribe to the inventories currently shown.
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
        if (inv === this.playerInv) this._bookDirty = true;
        if (inv === this._gridInv || inv === this._tableGrid) this._matchVersion = -1;
      };
      inv.on('change', handler);
      this._unsub.push(() => {
        if (typeof inv.off === 'function') inv.off('change', handler);
      });
    }
  }

  /**
   * Drop every inventory subscription.
   * @returns {void}
   * @private
   */
  _unsubscribe() {
    for (let i = 0; i < this._unsub.length; i++) {
      try { this._unsub[i](); } catch (err) { warnOnce('unsub', 'listener teardown failed.', err); }
    }
    this._unsub.length = 0;
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
   * Pointer down: pick up, place, split or begin a distribution drag.
   * @param {PointerEvent} e the event
   * @returns {void}
   * @private
   */
  _handleDown(e) {
    if (!this._open) return;
    this._px = e.clientX;
    this._py = e.clientY;

    const recipeCell = this._recipeCellOf(e.target);
    if (recipeCell !== null) {
      e.preventDefault();
      this._applyRecipe(recipeCell);
      return;
    }

    const view = this._slotOf(e.target);
    if (view === null) {
      const inWindow = this.win.contains(/** @type {Node} */ (e.target))
        || this._book.contains(/** @type {Node} */ (e.target));
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
    // Released outside the window while carrying a stack: throw it instead.
    const node = /** @type {?Node} */ (e.target);
    const inside = node !== null
      && (this.win.contains(node) || this._book.contains(node));
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
    const active = document.activeElement;
    if (active === this._bookInput) return;
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
    if (view.type === 'result' || view.type === 'furnace_out') return false;
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
   * @param {boolean} shift shift held (crafts the maximum on a result slot)
   * @returns {void}
   * @private
   */
  _pickUp(view, half, shift) {
    const inv = view.inv;
    if (inv === null) return;
    const stack = inv.get(view.index);
    if (stack === null) return;

    if (view.type === 'result') {
      this._takeCraftResult(shift);
      return;
    }
    if (view.type === 'furnace_out') {
      this._takeFurnaceOutput(shift);
      return;
    }

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
    const inv = view.inv;
    if (inv === null) return;

    if (view.type === 'result' || view.type === 'furnace_out') return;
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
   * Spread the cursor stack over every slot the drag touched: evenly with the
   * left button, one item per slot with the right button.
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
   * Shift-click: move a stack between the player and the open container, or
   * between the hotbar and main storage when no container is open.
   * @param {Object} view the clicked slot
   * @returns {void}
   * @private
   */
  _quickMove(view) {
    const inv = view.inv;
    if (inv === null) return;
    const stack = inv.get(view.index);
    if (stack === null) return;

    if (view.type === 'result') {
      this._takeCraftResult(true);
      return;
    }
    if (view.type === 'furnace_out') {
      this._takeFurnaceOutput(true);
      return;
    }

    const player = this.playerInv;
    const container = this.container;

    if (inv !== player) {
      const moved = this._moveInto(inv, view.index, (part) => this._addToPlayer(part));
      if (moved > 0) this._playUI('click');
      return;
    }

    // From the player's side.
    if (view.type === 'grid') {
      const moved = this._moveInto(inv, view.index, (part) => this._addToPlayer(part, true));
      if (moved > 0) this._playUI('click');
      return;
    }

    if (container !== null) {
      const moved = this._moveInto(inv, view.index, (part) => {
        if (container.isFurnace && typeof container.quickInsert === 'function') {
          return container.quickInsert(part);
        }
        return container.add(part);
      });
      if (moved > 0) this._playUI('click');
      return;
    }

    // No container: armour first, then hotbar <-> main storage.
    const slot = armorSlot(stack.itemId);
    if (slot !== ARMOR_SLOT.NONE && (view.index < SLOT.ARMOR_START || view.index > SLOT.ARMOR_END)) {
      const target = SLOT.ARMOR_START + slot;
      if (player.get(target) === null) {
        const taken = player.take(view.index);
        if (taken !== null) {
          player.set(target, taken);
          this._playUI('click');
          return;
        }
      }
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
   * @param {function(ItemStack):?ItemStack} insert insertion function; returns leftovers
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
   * Insert a stack into the player's storage: main slots first, hotbar second
   * — the vanilla shift-click order.
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
  /* Crafting                                                               */
  /* ====================================================================== */

  /**
   * Re-run {@link findRecipe} when the grid changed and mirror the result into
   * the preview slot.
   * @param {boolean} force recompute even when the version looks unchanged
   * @returns {void}
   * @private
   */
  _updateCraftResult(force) {
    const grid = this._gridInv;
    if (grid === null || !this._hasCrafting()) return;
    if (!force && this._matchVersion === grid.version) return;

    let match = null;
    try {
      match = findRecipe(grid, this._gridW, this._gridH, this._gridOffset);
    } catch (err) {
      warnOnce('find', 'findRecipe() failed; the crafting preview is disabled.', err);
      match = null;
    }
    this._match = match;

    // Write the preview only when it really differs — the result slot lives in
    // the same inventory, so an unconditional write would bump `version` every
    // frame and re-run the matcher forever.
    const preview = match === null ? null : match.result;
    const isPlayerGrid = this._kind === 'inventory';
    const holder = isPlayerGrid ? grid : this._tableResult;
    const index = isPlayerGrid ? SLOT.CRAFT_RESULT : 0;
    if (holder !== null) {
      const current = holder.get(index);
      const same = (current === null && preview === null)
        || (current !== null && preview !== null && current.equals(preview));
      if (!same) {
        const copy = preview === null ? null : preview.clone();
        if (isPlayerGrid && typeof holder.setCraftResult === 'function') holder.setCraftResult(copy);
        else holder.set(index, copy);
      }
    }
    this._matchVersion = grid.version;
  }

  /**
   * Take the crafting result: one craft on a click, as many as the materials
   * and the free space allow on a shift-click.
   * @param {boolean} bulk shift was held
   * @returns {void}
   * @private
   */
  _takeCraftResult(bulk) {
    const grid = this._gridInv;
    if (grid === null) return;
    this._updateCraftResult(true);
    let match = this._match;
    if (match === null) return;

    if (!bulk) {
      const result = match.result.clone();
      if (this.held !== null && !this.held.isEmpty()) {
        if (!this.held.canStackWith(result)) return;
        const limit = itemStackSize(this.held.itemId);
        if (this.held.count + result.count > limit) return;
      }
      const applied = consumeIngredients(grid, this._gridOffset, match, 1);
      if (applied.crafted <= 0) return;
      this._spillLeftovers(applied.leftovers);
      if (this.held === null || this.held.isEmpty()) this.held = result;
      else this.held.count += result.count;
      this._paintDrag();
      this._updateCraftResult(true);
      this._playUI('click');
      return;
    }

    let crafted = 0;
    for (let guard = 0; guard < MAX_BULK_CRAFT; guard++) {
      this._updateCraftResult(true);
      match = this._match;
      if (match === null) break;
      const result = match.result;
      if (!this._roomFor(result)) break;
      const applied = consumeIngredients(grid, this._gridOffset, match, 1);
      if (applied.crafted <= 0) break;
      this._spillLeftovers(applied.leftovers);
      const rest = this._addToPlayer(result.clone());
      if (rest !== null) this._dropStack(rest);
      crafted++;
    }
    this._updateCraftResult(true);
    if (crafted > 0) this._playUI('click');
  }

  /**
   * Does the player's storage still have room for a whole stack? Checked
   * before a bulk craft so nothing has to be rolled back.
   * @param {ItemStack} stack the stack that would be produced
   * @returns {boolean} true when it fits completely
   * @private
   */
  _roomFor(stack) {
    const player = this.playerInv;
    if (player === null) return false;
    const limit = itemStackSize(stack.itemId);
    let space = 0;
    for (let i = SLOT.STORAGE_START; i <= SLOT.STORAGE_END; i++) {
      const cur = player.get(i);
      if (cur === null) space += limit;
      else if (cur.count < limit && cur.canStackWith(stack)) space += limit - cur.count;
      if (space >= stack.count) return true;
    }
    return space >= stack.count;
  }

  /**
   * Put remainder stacks (empty buckets, bottles) that no longer fit into the
   * grid back into the player's inventory, throwing anything left over.
   * @param {Array<ItemStack>} leftovers stacks handed back by `consumeIngredients`
   * @returns {void}
   * @private
   */
  _spillLeftovers(leftovers) {
    if (!Array.isArray(leftovers) || leftovers.length === 0) return;
    for (let i = 0; i < leftovers.length; i++) {
      const rest = this._addToPlayer(leftovers[i]);
      if (rest !== null) this._dropStack(rest);
    }
  }

  /**
   * Take the finished goods out of the furnace and award the banked XP.
   * @param {boolean} bulk shift was held (move straight into the inventory)
   * @returns {void}
   * @private
   */
  _takeFurnaceOutput(bulk) {
    const container = this.container;
    if (container === null || typeof container.takeFurnaceOutput !== 'function') return;
    const out = container.takeFurnaceOutput();
    const stack = out && out.stack;
    if (stack === null || stack === undefined) return;

    if (out.xp > 0) {
      const combat = this.game && this.game.combat;
      if (combat && typeof combat.addXP === 'function') {
        try { combat.addXP(out.xp); } catch (err) { warnOnce('xp', 'addXP() failed.', err); }
      }
    }

    if (bulk || (this.held !== null && !this.held.isEmpty() && !this.held.canStackWith(stack))) {
      const rest = this._addToPlayer(stack);
      if (rest !== null) this._dropStack(rest);
    } else if (this.held === null || this.held.isEmpty()) {
      this.held = stack;
    } else {
      const limit = itemStackSize(this.held.itemId);
      const space = limit - this.held.count;
      const move = Math.min(space, stack.count);
      this.held.count += move;
      stack.count -= move;
      if (stack.count > 0) {
        const rest = this._addToPlayer(stack);
        if (rest !== null) this._dropStack(rest);
      }
    }
    this._paintDrag();
    this._playUI('click');
  }

  /**
   * Empty the crafting grid back into the player's inventory.
   * @returns {void}
   * @private
   */
  _returnGrid() {
    const player = this.playerInv;
    if (player === null) return;
    if (this._kind === 'inventory' && typeof player.clearCrafting === 'function') {
      const spill = player.clearCrafting();
      for (let i = 0; i < spill.length; i++) this._dropStack(spill[i]);
      return;
    }
    const grid = this._tableGrid;
    if (grid === null) return;
    for (let i = 0; i < grid.size; i++) {
      const stack = grid.take(i);
      if (stack === null) continue;
      const rest = this._addToPlayer(stack);
      if (rest !== null) this._dropStack(rest);
    }
    if (this._tableResult !== null) this._tableResult.clear();
  }

  /* ====================================================================== */
  /* Furnace animation                                                      */
  /* ====================================================================== */

  /**
   * Mirror the block-entity burn and cook state into the DOM, writing only
   * when a value actually moved.
   * @returns {void}
   * @private
   */
  _updateFurnace() {
    const container = this.container;
    if (container === null || this._flame === null || this._cookBar === null) return;
    if (container.isFurnace !== true) return;

    const burn = Number.isFinite(container.burnProgress) ? container.burnProgress : 0;
    const cook = Number.isFinite(container.cookProgress) ? container.cookProgress : 0;

    if (Math.abs(burn - this._lastBurn) > 0.004) {
      this._lastBurn = burn;
      this._flame.style.setProperty('--f', burn.toFixed(3));
    }
    if (Math.abs(cook - this._lastCook) > 0.004) {
      this._lastCook = cook;
      this._cookBar.style.setProperty('--p', cook.toFixed(3));
    }
  }

  /* ====================================================================== */
  /* Recipe book                                                            */
  /* ====================================================================== */

  /**
   * Build the category tab row once.
   * @returns {void}
   * @private
   */
  _buildBookTabs() {
    const makeTab = (value, label) => {
      const tab = /** @type {HTMLButtonElement} */ (el('button', 'vx-tab vx-tab--sm', label));
      tab.type = 'button';
      tab.addEventListener('click', () => {
        this._bookCategory = value;
        this._bookSignature = '';
        this._bookDirty = true;
        this._bookTimer = 0;
        const tabs = this._bookTabs.children;
        for (let i = 0; i < tabs.length; i++) {
          setClass(/** @type {HTMLElement} */ (tabs[i]), 'is-active', tabs[i] === tab);
        }
      });
      return tab;
    };
    const all = makeTab('all', 'Alle');
    all.classList.add('is-active');
    this._bookTabs.appendChild(all);
    for (let i = 0; i < RECIPE_CATEGORIES.length; i++) {
      const key = RECIPE_CATEGORIES[i];
      this._bookTabs.appendChild(makeTab(key, RECIPE_CATEGORY_LABELS[key] || key));
    }
  }

  /**
   * Recompute the craftable list and update the panel — but only touch the DOM
   * when the filtered result really changed.
   * @returns {void}
   * @private
   */
  _rebuildBook() {
    const player = this.playerInv;
    if (player === null) return;

    /** @type {Array<Object>} */
    let recipes = [];
    try {
      recipes = craftableFrom(player);
    } catch (err) {
      warnOnce('book', 'craftableFrom() failed; the recipe book stays empty.', err);
      recipes = [];
    }

    const cells = this._gridW * this._gridH;
    /** @type {Array<Object>} */
    const filtered = [];
    for (let i = 0; i < recipes.length; i++) {
      const recipe = recipes[i];
      if (this._bookCategory !== 'all' && recipe.category !== this._bookCategory) continue;
      if (this._bookQuery.length > 0) {
        const name = String(recipe.display || '').toLowerCase();
        if (name.indexOf(this._bookQuery) === -1 && recipe.id.indexOf(this._bookQuery) === -1) {
          continue;
        }
      }
      filtered.push(recipe);
    }

    let signature = `${this._bookCategory}|${this._bookQuery}|${cells}|`;
    for (let i = 0; i < filtered.length; i++) signature += `${filtered[i].id},`;
    if (signature === this._bookSignature) return;
    this._bookSignature = signature;
    this._bookRecipes = filtered;

    setClass(this._bookEmpty, 'is-hidden', filtered.length > 0);

    while (this._bookCells.length < filtered.length) {
      const cell = el('div', 'vx-cell vx-cell--recipe');
      cell.setAttribute('role', 'button');
      const item = el('div', 'vx-item');
      const img = /** @type {HTMLImageElement} */ (el('img', 'vx-item__icon'));
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      const count = el('span', 'vx-item__count');
      item.appendChild(img);
      item.appendChild(count);
      cell.appendChild(item);
      cell.__vxImg = img;
      cell.__vxCount = count;
      this._bookCells.push(cell);
      this._bookList.appendChild(cell);
    }
    while (this._bookCells.length > filtered.length) {
      const cell = this._bookCells.pop();
      if (cell && cell.parentNode) cell.parentNode.removeChild(cell);
    }

    for (let i = 0; i < filtered.length; i++) {
      const recipe = filtered[i];
      const cell = this._bookCells[i];
      cell.__vxRecipe = recipe;
      const url = itemIconURL(recipe.result.item);
      if (url === null) {
        cell.__vxImg.classList.add('is-hidden');
      } else if (cell.__vxImg.getAttribute('src') !== url) {
        cell.__vxImg.src = url;
        cell.__vxImg.classList.remove('is-hidden');
      }
      cell.__vxImg.alt = recipe.display;
      setText(cell.__vxCount, recipe.result.count > 1 ? String(recipe.result.count) : '');
      const fits = this._recipeFits(recipe);
      setClass(cell, 'is-unfit', !fits);
      cell.title = fits
        ? `${recipe.display} — klicken zum Anlegen`
        : `${recipe.display} — braucht eine Werkbank`;
    }
  }

  /**
   * Does a recipe fit into the crafting grid that is currently open?
   * @param {Object} recipe recipe to test
   * @returns {boolean} true when it fits
   * @private
   */
  _recipeFits(recipe) {
    if (recipe.type === 'shapeless') return recipe.ingredients.length <= this._gridW * this._gridH;
    return recipe.width <= this._gridW && recipe.height <= this._gridH;
  }

  /**
   * Find the recipe attached to a clicked element.
   * @param {?EventTarget} target the event target
   * @returns {?Object} the recipe, or `null`
   * @private
   */
  _recipeCellOf(target) {
    const node = /** @type {?Element} */ (target);
    if (node === null || typeof node.closest !== 'function') return null;
    const cell = node.closest('.vx-cell--recipe');
    if (cell === null) return null;
    const recipe = cell.__vxRecipe;
    return recipe === undefined ? null : recipe;
  }

  /**
   * Lay the ingredients of a recipe into the grid, taking them out of the
   * player's storage. Rolls back completely when something is missing.
   * @param {Object} recipe recipe to apply
   * @returns {boolean} true when the grid was filled
   * @private
   */
  _applyRecipe(recipe) {
    const grid = this._gridInv;
    const player = this.playerInv;
    if (grid === null || player === null) return false;
    if (!this._recipeFits(recipe)) {
      this._playUI('click');
      return false;
    }

    this._returnGridToPlayer();

    /** @type {Map<number, number>} */
    const tally = new Map();
    for (let i = SLOT.STORAGE_START; i <= SLOT.STORAGE_END; i++) {
      const stack = player.get(i);
      if (stack === null) continue;
      tally.set(stack.itemId, (tally.get(stack.itemId) || 0) + stack.count);
    }

    /** @type {Array<{cell:number, itemId:number}>} */
    const plan = [];
    const push = (cell, ingredient) => {
      const ids = ingredient.ids;
      for (let k = 0; k < ids.length; k++) {
        const have = tally.get(ids[k]) || 0;
        if (have > 0) {
          tally.set(ids[k], have - 1);
          plan.push({ cell, itemId: ids[k] });
          return true;
        }
      }
      return false;
    };

    let ok = true;
    if (recipe.type === 'shaped') {
      for (let r = 0; r < recipe.height && ok; r++) {
        for (let c = 0; c < recipe.width && ok; c++) {
          const ingredient = recipe.cells[r * recipe.width + c];
          if (ingredient === null) continue;
          ok = push(r * this._gridW + c, ingredient);
        }
      }
    } else {
      for (let i = 0; i < recipe.ingredients.length && ok; i++) {
        ok = push(i, recipe.ingredients[i]);
      }
    }
    if (!ok) {
      this._playUI('click');
      return false;
    }

    grid.beginBatch();
    for (let i = 0; i < plan.length; i++) {
      const taken = this._takeOne(player, plan[i].itemId);
      if (taken === null) continue;
      const leftover = grid.addAt(this._gridOffset + plan[i].cell, taken);
      if (leftover !== null) this._addToPlayer(leftover);
    }
    grid.endBatch();
    this._updateCraftResult(true);
    this._playUI('click');
    return true;
  }

  /**
   * Move whatever is in the crafting grid back into the player's storage.
   * @returns {void}
   * @private
   */
  _returnGridToPlayer() {
    const grid = this._gridInv;
    if (grid === null) return;
    const cells = this._gridW * this._gridH;
    grid.beginBatch();
    for (let i = 0; i < cells; i++) {
      const stack = grid.take(this._gridOffset + i);
      if (stack === null) continue;
      const rest = this._addToPlayer(stack);
      if (rest !== null) grid.addAt(this._gridOffset + i, rest);
    }
    grid.endBatch();
  }

  /**
   * Take exactly one item of a kind out of the player's storage range.
   * @param {Object} inv the player inventory
   * @param {number} itemId item id to take
   * @returns {?ItemStack} a one-item stack, or `null`
   * @private
   */
  _takeOne(inv, itemId) {
    for (let i = SLOT.STORAGE_START; i <= SLOT.STORAGE_END; i++) {
      const stack = inv.get(i);
      if (stack === null || stack.itemId !== itemId) continue;
      return inv.remove(i, 1);
    }
    return null;
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
    // A stack on the cursor already tells the player what they carry; a second
    // floating panel next to it would only be in the way.
    if (this.held !== null && !this.held.isEmpty()) {
      setClass(this._tip, 'is-on', false);
      return;
    }
    const stack = (view !== null && view.inv !== null) ? view.inv.get(view.index) : null;
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

    const type = toolType(id);
    if (type !== null) {
      this._tipRow('Werkzeug', TOOL_TYPE_LABELS[type] || type);
      const tier = toolTier(id);
      if (tier > TOOL_TIER.NONE) this._tipRow('Stufe', TIER_LABELS[tier] || String(tier));
    }
    const slot = armorSlot(id);
    if (slot !== ARMOR_SLOT.NONE) {
      this._tipRow('Rüstungsteil', ARMOR_LABELS[slot] || '—');
      this._tipRow('Rüstung', `${armorPoints(id)}`);
      const tough = armorToughness(id);
      if (tough > 0) this._tipRow('Robustheit', tough.toFixed(1));
    }
    const damage = attackDamage(id);
    if (damage > 1) {
      this._tipRow('Schaden', `${damage % 1 === 0 ? damage : damage.toFixed(1)} ♥`);
      this._tipRow('Angriffstempo', `${attackSpeed(id).toFixed(1)} /s`);
    }
    const maxDur = itemDurability(id);
    if (maxDur > 0) this._tipRow('Haltbarkeit', `${stack.durability} / ${maxDur}`);
    const food = foodValue(id);
    if (food !== null && food !== undefined) {
      this._tipRow('Nahrung', `${food.hunger} · Sättigung ${food.saturation.toFixed(1)}`);
    }
    const burn = itemFuel(id);
    if (burn > 0) this._tipRow('Brenndauer', `${(burn / 20).toFixed(0)} s`);

    const list = stack.enchantments;
    for (let i = 0; i < list.length; i++) {
      const label = ENCHANT_LABELS[list[i].id] || list[i].id;
      const level = ROMAN[list[i].level] || String(list[i].level);
      const row = el('div', 'vx-tooltip__ench', `${label} ${level}`.trim());
      this._tipRows.appendChild(row);
    }
    if (stack.meta !== null && stack.meta.lore.length > 0) {
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
   * Spawn a dropped-item entity in front of the player. When there is no entity
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
      this._playUI('click');
    } catch (err) {
      warnOnce('drop', 'dropItem() failed; the stack went back into the inventory.', err);
      this._addToPlayer(stack);
    }
  }

  /**
   * Put the cursor stack back where it came from when the screen closes.
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
      warnOnce(tag, `"${tag}" failed; the container screen keeps running.`, err);
    }
  }

  /**
   * Raise or clear `input.typing` so holding a movement key inside the search
   * box cannot walk the player.
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
   * Restore the state remembered by {@link InventoryUI#_pushState}.
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

export default InventoryUI;
