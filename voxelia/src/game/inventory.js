/**
 * VOXELIA — item stacks, inventories and containers (ARCHITECTURE.md § 5.32).
 *
 * ============================================================================
 * WHAT LIVES HERE
 * ============================================================================
 * `ItemStack`        one stack of items + optional `meta` (durability,
 *                    enchantments, custom name, lore).
 * `Inventory`        a flat, event-emitting array of slots with the merge /
 *                    fill / remove semantics every other system relies on.
 * `PlayerInventory`  the 46-slot player layout (see `SLOT`), hotbar-first
 *                    pickup, tool damage and armour handling.
 * `Container`        chests, barrels, hoppers, dispensers and furnaces. The UI
 *                    drives it through the exact same `Inventory` API.
 *
 * ============================================================================
 * EMPTY SLOTS ARE `null`
 * ============================================================================
 * A slot is either `null` or a **non-empty** `ItemStack`. The inventory never
 * stores a stack with `count <= 0`; `set()`/`add()`/`remove()` normalise that
 * away. Code that reads `slots[i]` therefore only ever has to check for `null`.
 *
 * ============================================================================
 * EVENTS (so the UI never has to poll)
 * ============================================================================
 *   `change`   (index, stack, previous, inventory)  one slot changed
 *   `changed`  (inventory)                          coalesced "something moved"
 *   `select`   (index, inventory)                   PlayerInventory only
 *   `break`    (index, itemId, inventory)           a tool broke, slot cleared
 *   `equip`    (armorSlot, stack, inventory)        PlayerInventory only
 *   `furnace`  (container)                          furnace state advanced
 *
 * Multi-slot operations are wrapped in `beginBatch()`/`endBatch()` so `changed`
 * fires exactly once per logical operation while `change` still fires per slot.
 * `version` is bumped on every mutation — cheap for "did anything change?".
 *
 * ============================================================================
 * NO CYCLES
 * ============================================================================
 * This module must not import `game/crafting.js` (crafting imports us). The
 * furnace therefore takes its smelting/fuel lookups as injected callbacks —
 * see {@link Container#setResolvers}. `game/game.js` wires them once:
 *
 *   container.setResolvers(smeltResult, fuelValue);
 *
 * All user-facing strings are German.
 *
 * @module game/inventory
 */

import { EventBus } from '../core/util.js';
import {
  I, ARMOR_SLOT, getItem, itemStackSize, itemDurability, itemDisplay, armorSlot
} from './items.js';

// ---------------------------------------------------------------------------
// Diagnostics — never throw during a tick, log each distinct problem once.
// ---------------------------------------------------------------------------

/** Keys of problems already reported. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a message at most once per key. Used instead of throwing so a corrupt
 * save or a bad slot index degrades instead of killing the tick.
 * @param {string} key de-duplication key
 * @param {string} message human readable message
 * @returns {void}
 */
function warnOnce(key, message) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  console.warn(`[inventory] ${message}`);
}

// ---------------------------------------------------------------------------
// Slot layout
// ---------------------------------------------------------------------------

/**
 * Slot indices of the player inventory. The layout is fixed by the
 * architecture contract and shared with `ui/inventory_ui.js` and `game/save.js`.
 *
 * `0..8` hotbar, `9..35` main storage, `36..39` armour (head, chest, legs,
 * feet), `40` off-hand, `41..44` the 2x2 crafting grid, `45` its result.
 *
 * @type {Readonly<Object<string, number>>}
 */
export const SLOT = Object.freeze({
  HOTBAR_START: 0,
  HOTBAR_END: 8,
  MAIN_START: 9,
  MAIN_END: 35,
  ARMOR_START: 36,
  ARMOR_END: 39,
  OFFHAND: 40,
  CRAFT_START: 41,
  CRAFT_END: 44,
  CRAFT_RESULT: 45,
  /** Total number of player slots (`45` is the last valid index). */
  COUNT: 46,
  /** First slot `add()`/`addPickup()` may fill. */
  STORAGE_START: 0,
  /** Last slot `add()`/`addPickup()` may fill. */
  STORAGE_END: 35
});

/**
 * Number of slots in the player's 2x2 crafting grid.
 * @type {number}
 */
export const PLAYER_CRAFT_SIZE = 4;

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

/**
 * Stack metadata. Every field always exists so hot code can read it unguarded.
 * `durability` is the **remaining** durability; `-1` means "untracked / full".
 *
 * @typedef {Object} StackMeta
 * @property {number} durability remaining durability points, `-1` when untracked
 * @property {{id:string, level:number}[]} enchantments applied enchantments
 * @property {(string|null)} name custom (anvil) name, `null` for the default
 * @property {string[]} lore extra tooltip lines
 */

/**
 * Build a complete {@link StackMeta} from a partial object. Tolerates the
 * shapes produced by old saves and by hand written call sites.
 * @param {?Object} raw partial metadata, or null
 * @returns {?StackMeta} normalised metadata, or `null` when `raw` is empty
 */
export function normalizeMeta(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  /** @type {{id:string, level:number}[]} */
  const enchantments = [];
  const src = Array.isArray(raw.enchantments) ? raw.enchantments : [];
  for (let i = 0; i < src.length; i++) {
    const e = src[i];
    if (e === null || typeof e !== 'object') continue;
    const id = typeof e.id === 'string' ? e.id : null;
    if (id === null) continue;
    const level = Number.isFinite(e.level) ? Math.max(1, Math.min(255, e.level | 0)) : 1;
    enchantments.push({ id, level });
  }
  /** @type {string[]} */
  const lore = [];
  if (Array.isArray(raw.lore)) {
    for (let i = 0; i < raw.lore.length; i++) {
      if (typeof raw.lore[i] === 'string') lore.push(raw.lore[i]);
    }
  }
  const durability = Number.isFinite(raw.durability) ? raw.durability | 0 : -1;
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null;
  return { durability, enchantments, name, lore };
}

/**
 * Deep copy of a {@link StackMeta}.
 * @param {?StackMeta} meta metadata to copy
 * @returns {?StackMeta} an independent copy, or `null`
 */
export function cloneMeta(meta) {
  if (meta === null || meta === undefined) return null;
  const enchantments = new Array(meta.enchantments.length);
  for (let i = 0; i < meta.enchantments.length; i++) {
    enchantments[i] = { id: meta.enchantments[i].id, level: meta.enchantments[i].level };
  }
  return {
    durability: meta.durability,
    enchantments,
    name: meta.name,
    lore: meta.lore.length === 0 ? [] : meta.lore.slice()
  };
}

/**
 * Is this metadata indistinguishable from "no metadata at all" for `itemId`?
 * Undamaged, unenchanted, unnamed stacks must merge with plain ones.
 * @param {number} itemId item the metadata belongs to
 * @param {?StackMeta} meta metadata to test
 * @returns {boolean} true when the metadata carries no information
 */
export function isDefaultMeta(itemId, meta) {
  if (meta === null || meta === undefined) return true;
  if (meta.enchantments.length !== 0) return false;
  if (meta.name !== null) return false;
  if (meta.lore.length !== 0) return false;
  if (meta.durability < 0) return true;
  return meta.durability === itemDurability(itemId);
}

/**
 * Do two stack metadata blobs describe the same item variant? Enchantment order
 * is ignored, everything else must match exactly.
 * @param {number} itemId item both metadata blobs belong to
 * @param {?StackMeta} a first metadata
 * @param {?StackMeta} b second metadata
 * @returns {boolean} true when the two stacks may merge
 */
export function metaEquals(itemId, a, b) {
  const aDefault = isDefaultMeta(itemId, a);
  const bDefault = isDefaultMeta(itemId, b);
  if (aDefault && bDefault) return true;
  if (aDefault !== bDefault) return false;
  // Both carry information — compare field by field.
  const max = itemDurability(itemId);
  const da = a.durability < 0 ? max : a.durability;
  const db = b.durability < 0 ? max : b.durability;
  if (da !== db) return false;
  if (a.name !== b.name) return false;
  if (a.lore.length !== b.lore.length) return false;
  for (let i = 0; i < a.lore.length; i++) if (a.lore[i] !== b.lore[i]) return false;
  if (a.enchantments.length !== b.enchantments.length) return false;
  for (let i = 0; i < a.enchantments.length; i++) {
    const ea = a.enchantments[i];
    let found = false;
    for (let j = 0; j < b.enchantments.length; j++) {
      const eb = b.enchantments[j];
      if (eb.id === ea.id && eb.level === ea.level) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// ItemStack
// ---------------------------------------------------------------------------

/**
 * One stack of items. The only mutable fields are `count` and `meta`; `itemId`
 * is treated as immutable (build a new stack for a different item).
 */
export class ItemStack {
  /**
   * @param {number} itemId item id from `game/items.js`
   * @param {number} [count] number of items in the stack
   * @param {?Object} [meta] optional {@link StackMeta} (partial objects are normalised)
   */
  constructor(itemId, count = 1, meta = null) {
    /** @type {number} item id (0 = empty) */
    this.itemId = itemId | 0;
    /** @type {number} number of items */
    this.count = count | 0;
    /** @type {?StackMeta} durability / enchantments / custom name */
    this.meta = normalizeMeta(meta);
  }

  /**
   * Convenience factory, mainly so call sites read nicely.
   * @param {number} itemId item id
   * @param {number} [count] stack size
   * @param {?Object} [meta] optional metadata
   * @returns {ItemStack} the new stack
   */
  static of(itemId, count = 1, meta = null) {
    return new ItemStack(itemId, count, meta);
  }

  /**
   * Build a stack from an item *name*. Unknown names yield an empty stack.
   * @param {string} name snake_case item name from `game/items.js`
   * @param {number} [count] stack size
   * @param {?Object} [meta] optional metadata
   * @returns {ItemStack} the new stack (empty when the name is unknown)
   */
  static fromName(name, count = 1, meta = null) {
    const id = I[String(name).toUpperCase()];
    if (id === undefined) {
      warnOnce(`name:${name}`, `unknown item name "${name}"`);
      return new ItemStack(0, 0, null);
    }
    return new ItemStack(id, count, meta);
  }

  /**
   * Rebuild a stack from {@link ItemStack#serialize} output. Accepts both the
   * compact save format (`{i,c,m}`) and the verbose one (`{itemId,count,meta}`).
   * @param {?Object} o serialised stack, or null
   * @returns {?ItemStack} the stack, or `null` for empty/invalid input
   */
  static deserialize(o) {
    if (o === null || o === undefined || typeof o !== 'object') return null;
    const itemId = Number.isFinite(o.i) ? o.i | 0 : (Number.isFinite(o.itemId) ? o.itemId | 0 : 0);
    const count = Number.isFinite(o.c) ? o.c | 0 : (Number.isFinite(o.count) ? o.count | 0 : 0);
    if (itemId <= 0 || count <= 0) return null;
    const meta = o.m !== undefined ? o.m : (o.meta !== undefined ? o.meta : null);
    const stack = new ItemStack(itemId, count, meta);
    return stack.isEmpty() ? null : stack;
  }

  /**
   * Independent copy of this stack (metadata included).
   * @returns {ItemStack} the copy
   */
  clone() {
    const copy = new ItemStack(this.itemId, this.count, null);
    copy.meta = cloneMeta(this.meta);
    return copy;
  }

  /**
   * Copy of this stack with a different count.
   * @param {number} count new stack size
   * @returns {ItemStack} the copy
   */
  withCount(count) {
    const copy = this.clone();
    copy.count = count | 0;
    return copy;
  }

  /**
   * Is this stack empty (no item or no items left)?
   * @returns {boolean} true when the stack holds nothing
   */
  isEmpty() {
    return this.itemId <= 0 || this.count <= 0;
  }

  /** @returns {number} maximum stack size of the contained item */
  get maxStack() {
    return itemStackSize(this.itemId);
  }

  /** @returns {string} German display name (custom name wins) */
  get displayName() {
    if (this.meta !== null && this.meta.name !== null) return this.meta.name;
    return itemDisplay(this.itemId);
  }

  /**
   * Can `other` be poured into this stack (same item, same variant, stackable)?
   * @param {?ItemStack} other candidate stack
   * @returns {boolean} true when both stacks may merge
   */
  canStackWith(other) {
    if (other === null || other === undefined) return false;
    if (other.itemId !== this.itemId) return false;
    if (this.isEmpty() || other.isEmpty()) return false;
    if (itemStackSize(this.itemId) <= 1) return false;
    return metaEquals(this.itemId, this.meta, other.meta);
  }

  /**
   * Are the two stacks fully identical (item, count and variant)?
   * @param {?ItemStack} other stack to compare against
   * @returns {boolean} true when identical
   */
  equals(other) {
    if (other === null || other === undefined) return false;
    if (this.isEmpty() && other.isEmpty()) return true;
    return this.itemId === other.itemId && this.count === other.count
      && metaEquals(this.itemId, this.meta, other.meta);
  }

  /**
   * Take `n` items off this stack. Mutates this stack and returns the removed
   * part; the caller must drop this stack when it became empty.
   * @param {number} n number of items to take
   * @returns {?ItemStack} the removed part, or `null` when nothing was taken
   */
  split(n) {
    const take = Math.min(n | 0, this.count);
    if (take <= 0) return null;
    const part = new ItemStack(this.itemId, take, null);
    part.meta = cloneMeta(this.meta);
    this.count -= take;
    return part;
  }

  /**
   * Grow the stack, clamped to the item's maximum stack size.
   * @param {number} n items to add
   * @returns {number} how many items actually fit
   */
  grow(n) {
    const limit = itemStackSize(this.itemId);
    const added = Math.max(0, Math.min(n | 0, limit - this.count));
    this.count += added;
    return added;
  }

  /**
   * Shrink the stack, never below zero.
   * @param {number} n items to remove
   * @returns {number} how many items were actually removed
   */
  shrink(n) {
    const removed = Math.max(0, Math.min(n | 0, this.count));
    this.count -= removed;
    return removed;
  }

  /** @returns {boolean} true when the item has a durability bar */
  isDamageable() {
    return itemDurability(this.itemId) > 0;
  }

  /** @returns {number} maximum durability of the item (0 when not damageable) */
  get maxDurability() {
    return itemDurability(this.itemId);
  }

  /** @returns {number} remaining durability (equals `maxDurability` when untracked) */
  get durability() {
    const max = itemDurability(this.itemId);
    if (max <= 0) return 0;
    if (this.meta === null || this.meta.durability < 0) return max;
    return Math.max(0, Math.min(max, this.meta.durability));
  }

  /**
   * Set the remaining durability. Values outside `0..maxDurability` are clamped.
   * @param {number} value remaining durability points
   */
  set durability(value) {
    const max = itemDurability(this.itemId);
    if (max <= 0) return;
    this.ensureMeta().durability = Math.max(0, Math.min(max, value | 0));
  }

  /** @returns {number} damage taken (`maxDurability - durability`) */
  get damage() {
    const max = itemDurability(this.itemId);
    return max <= 0 ? 0 : max - this.durability;
  }

  /**
   * Apply wear to the item.
   * @param {number} [amount] durability points to consume
   * @returns {boolean} true when the item just broke (durability reached 0)
   */
  damageBy(amount = 1) {
    const max = itemDurability(this.itemId);
    if (max <= 0) return false;
    const wear = Math.max(0, amount | 0);
    if (wear === 0) return false;
    const left = Math.max(0, this.durability - wear);
    this.ensureMeta().durability = left;
    return left <= 0;
  }

  /**
   * Restore durability (anvil / grindstone).
   * @param {number} amount durability points to restore
   * @returns {number} the new remaining durability
   */
  repair(amount) {
    const max = itemDurability(this.itemId);
    if (max <= 0) return 0;
    const left = Math.max(0, Math.min(max, this.durability + Math.max(0, amount | 0)));
    this.ensureMeta().durability = left;
    return left;
  }

  /**
   * Metadata of this stack, created on demand.
   * @returns {StackMeta} the (now guaranteed) metadata object
   */
  ensureMeta() {
    if (this.meta === null) {
      this.meta = { durability: itemDurability(this.itemId) || -1, enchantments: [], name: null, lore: [] };
    }
    return this.meta;
  }

  /** @returns {{id:string, level:number}[]} enchantments (empty array when none) */
  get enchantments() {
    return this.meta === null ? EMPTY_ENCHANTMENTS : this.meta.enchantments;
  }

  /** @returns {boolean} true when the stack should render with an enchant glint */
  isEnchanted() {
    if (this.meta !== null && this.meta.enchantments.length > 0) return true;
    return getItem(this.itemId).glint;
  }

  /**
   * Level of one enchantment on this stack.
   * @param {string} id enchantment id, e.g. `'efficiency'`
   * @returns {number} level, `0` when the enchantment is absent
   */
  getEnchantmentLevel(id) {
    if (this.meta === null) return 0;
    const list = this.meta.enchantments;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i].level;
    return 0;
  }

  /**
   * Add or upgrade an enchantment.
   * @param {string} id enchantment id
   * @param {number} [level] enchantment level (1..255)
   * @returns {ItemStack} `this`, for chaining
   */
  addEnchantment(id, level = 1) {
    if (typeof id !== 'string' || id.length === 0) return this;
    const lvl = Math.max(1, Math.min(255, level | 0));
    const meta = this.ensureMeta();
    for (let i = 0; i < meta.enchantments.length; i++) {
      if (meta.enchantments[i].id === id) {
        if (meta.enchantments[i].level < lvl) meta.enchantments[i].level = lvl;
        return this;
      }
    }
    meta.enchantments.push({ id, level: lvl });
    return this;
  }

  /**
   * Remove one enchantment.
   * @param {string} id enchantment id
   * @returns {boolean} true when the enchantment was present
   */
  removeEnchantment(id) {
    if (this.meta === null) return false;
    const list = this.meta.enchantments;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) { list.splice(i, 1); return true; }
    }
    return false;
  }

  /**
   * Give the stack a custom (anvil) name.
   * @param {?string} name custom name, `null` to clear it
   * @returns {ItemStack} `this`, for chaining
   */
  setCustomName(name) {
    if (name === null || name === undefined || name === '') {
      if (this.meta !== null) this.meta.name = null;
      return this;
    }
    this.ensureMeta().name = String(name);
    return this;
  }

  /**
   * Compact save representation. Default metadata is dropped so plain stacks
   * cost three fields.
   * @returns {{i:number, c:number, m?:StackMeta}} plain, structured-clone-safe object
   */
  serialize() {
    /** @type {{i:number, c:number, m?:StackMeta}} */
    const out = { i: this.itemId, c: this.count };
    if (!isDefaultMeta(this.itemId, this.meta)) out.m = cloneMeta(this.meta);
    return out;
  }
}

/** Shared empty enchantment list; never mutated. @type {{id:string, level:number}[]} */
const EMPTY_ENCHANTMENTS = Object.freeze([]);

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * A flat array of slots with merge/fill semantics and change events.
 *
 * `add()` first tops up partial stacks and only then fills empty slots, exactly
 * like vanilla, and returns whatever did not fit as a fresh {@link ItemStack}.
 * The stack passed in is never mutated, so callers can safely keep using it.
 */
export class Inventory extends EventBus {
  /**
   * @param {number} size number of slots
   * @param {Object} [opts] optional configuration
   * @param {string} [opts.title] German window title used by the UI
   * @param {number} [opts.storageStart] first slot `add()` may fill
   * @param {number} [opts.storageEnd] last slot `add()` may fill
   * @param {number} [opts.maxStackPerSlot] per-slot cap (hoppers/furnaces keep 64)
   */
  constructor(size, opts = {}) {
    super();
    const n = Math.max(0, size | 0);
    /** @type {number} number of slots */
    this.size = n;
    /** @type {(ItemStack|null)[]} slot storage; `null` means empty */
    this.slots = new Array(n).fill(null);
    /** @type {string} German window title */
    this.title = opts.title ?? 'Inventar';
    /** @type {number} first slot `add()` may fill */
    this.storageStart = clampIndex(opts.storageStart ?? 0, 0, n - 1);
    /** @type {number} last slot `add()` may fill */
    this.storageEnd = clampIndex(opts.storageEnd ?? n - 1, 0, n - 1);
    /** @type {number} per-slot stack cap, further limited by the item itself */
    this.maxStackPerSlot = Math.max(1, Math.min(64, (opts.maxStackPerSlot ?? 64) | 0));
    /** @type {number} bumped on every mutation; cheap change detection */
    this.version = 0;
    /** @type {number} nesting depth of `beginBatch()` @protected */
    this._batch = 0;
    /** @type {boolean} a `changed` event is pending @protected */
    this._dirty = false;
    /** @type {Int32Array} scratch slot order, reused by `add()` @protected */
    this._order = new Int32Array(n);
  }

  // -- basic access ---------------------------------------------------------

  /**
   * Stack in a slot.
   * @param {number} i slot index
   * @returns {?ItemStack} the stack, or `null` when the slot is empty/invalid
   */
  get(i) {
    const stack = this.slots[i];
    return stack === undefined ? null : stack;
  }

  /**
   * Replace the contents of a slot. Empty stacks are stored as `null`.
   * @param {number} i slot index
   * @param {?ItemStack} stack new contents (taken by reference, not copied)
   * @returns {boolean} true when the slot was written
   */
  set(i, stack) {
    if (i < 0 || i >= this.size) {
      warnOnce(`set:${i}`, `set() on out-of-range slot ${i} (size ${this.size})`);
      return false;
    }
    const next = (stack === null || stack === undefined || stack.isEmpty()) ? null : stack;
    const prev = this.slots[i];
    if (prev === next) return true;
    this.slots[i] = next;
    this._changed(i, prev);
    return true;
  }

  /**
   * Total number of items of one kind across all slots.
   * @param {number} itemId item id to count
   * @returns {number} total item count
   */
  count(itemId) {
    let total = 0;
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s !== null && s.itemId === itemId) total += s.count;
    }
    return total;
  }

  /**
   * Does the inventory hold at least `n` of an item?
   * @param {number} itemId item id
   * @param {number} [n] required amount
   * @returns {boolean} true when enough items are present
   */
  has(itemId, n = 1) {
    if (n <= 0) return true;
    let total = 0;
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s !== null && s.itemId === itemId) {
        total += s.count;
        if (total >= n) return true;
      }
    }
    return false;
  }

  /**
   * First slot containing an item.
   * @param {number} itemId item id
   * @param {number} [from] index to start searching at
   * @returns {number} slot index, `-1` when absent
   */
  findSlot(itemId, from = 0) {
    for (let i = Math.max(0, from); i < this.size; i++) {
      const s = this.slots[i];
      if (s !== null && s.itemId === itemId) return i;
    }
    return -1;
  }

  /**
   * First slot that could still take items from `stack`.
   * @param {ItemStack} stack stack to merge
   * @param {number} [from] index to start searching at
   * @returns {number} slot index, `-1` when there is no partial stack
   */
  findPartial(stack, from = 0) {
    if (stack === null || stack.isEmpty()) return -1;
    const limit = Math.min(itemStackSize(stack.itemId), this.maxStackPerSlot);
    if (limit <= 1) return -1;
    for (let i = Math.max(0, from); i < this.size; i++) {
      const s = this.slots[i];
      if (s !== null && s.count < limit && s.canStackWith(stack)) return i;
    }
    return -1;
  }

  /**
   * First empty slot within a range.
   * @param {number} [from] first index to consider
   * @param {number} [to] last index to consider (inclusive)
   * @returns {number} slot index, `-1` when the range is full
   */
  firstEmpty(from = 0, to = this.size - 1) {
    const lo = Math.max(0, from);
    const hi = Math.min(this.size - 1, to);
    for (let i = lo; i <= hi; i++) if (this.slots[i] === null) return i;
    return -1;
  }

  /** @returns {boolean} true when every slot is empty */
  isEmpty() {
    for (let i = 0; i < this.size; i++) if (this.slots[i] !== null) return false;
    return true;
  }

  /**
   * Total number of items in the whole inventory.
   * @returns {number} item count over all slots
   */
  countAll() {
    let total = 0;
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s !== null) total += s.count;
    }
    return total;
  }

  /**
   * Number of occupied slots.
   * @returns {number} how many slots hold a stack
   */
  usedSlots() {
    let used = 0;
    for (let i = 0; i < this.size; i++) if (this.slots[i] !== null) used++;
    return used;
  }

  // -- rules ----------------------------------------------------------------

  /**
   * Effective stack limit of one slot for a given item. Subclasses narrow this
   * (a furnace fuel slot still holds 64, a shulker-style slot might not).
   * @param {number} i slot index
   * @param {?ItemStack} [stack] stack about to be placed
   * @returns {number} maximum number of items the slot may hold
   */
  slotLimit(i, stack = null) {
    const itemMax = stack === null ? 64 : itemStackSize(stack.itemId);
    return Math.min(this.maxStackPerSlot, itemMax);
  }

  /**
   * May a stack be placed into a slot? Overridden by `PlayerInventory` (armour
   * slots, crafting result) and by `Container` (furnace slots).
   * @param {number} i slot index
   * @param {?ItemStack} stack stack about to be placed
   * @returns {boolean} true when the slot accepts the stack
   */
  canPlaceIn(i, stack) {
    return i >= 0 && i < this.size && stack !== null && !stack.isEmpty();
  }

  // -- mutation -------------------------------------------------------------

  /**
   * Insert a stack: top up matching partial stacks first, then fill empty
   * slots. The input stack is left untouched.
   *
   * @param {?ItemStack} stack stack to insert
   * @param {number} [from] first slot to consider (defaults to `storageStart`)
   * @param {number} [to] last slot to consider, inclusive (defaults to `storageEnd`)
   * @returns {?ItemStack} what did not fit, or `null` when everything was stored
   */
  add(stack, from = this.storageStart, to = this.storageEnd) {
    if (stack === null || stack === undefined || stack.isEmpty()) return null;
    const lo = Math.max(0, from);
    const hi = Math.min(this.size - 1, to);
    if (lo > hi) return stack.clone();
    let n = 0;
    const order = this._order;
    for (let i = lo; i <= hi; i++) order[n++] = i;
    return this._insertOrdered(stack, order, n);
  }

  /**
   * Insert into one specific slot.
   * @param {number} i slot index
   * @param {?ItemStack} stack stack to insert (not mutated)
   * @returns {?ItemStack} what did not fit, or `null`
   */
  addAt(i, stack) {
    if (stack === null || stack === undefined || stack.isEmpty()) return null;
    if (i < 0 || i >= this.size) return stack.clone();
    if (!this.canPlaceIn(i, stack)) return stack.clone();
    const limit = this.slotLimit(i, stack);
    const cur = this.slots[i];
    if (cur === null) {
      const move = Math.min(limit, stack.count);
      const prev = null;
      this.slots[i] = new ItemStack(stack.itemId, move, cloneMeta(stack.meta));
      this._changed(i, prev);
      return move >= stack.count ? null : new ItemStack(stack.itemId, stack.count - move, cloneMeta(stack.meta));
    }
    if (!cur.canStackWith(stack)) return stack.clone();
    const space = limit - cur.count;
    if (space <= 0) return stack.clone();
    const move = Math.min(space, stack.count);
    const prev = cur.clone();
    cur.count += move;
    this._changed(i, prev);
    return move >= stack.count ? null : new ItemStack(stack.itemId, stack.count - move, cloneMeta(stack.meta));
  }

  /**
   * Core insertion routine used by `add()` and `PlayerInventory.addPickup()`.
   * Walks `order` twice: merge pass, then fill pass.
   * @param {ItemStack} stack stack to insert (not mutated)
   * @param {Int32Array} order slot indices in insertion priority order
   * @param {number} n number of valid entries in `order`
   * @returns {?ItemStack} leftover stack, or `null`
   * @protected
   */
  _insertOrdered(stack, order, n) {
    const itemId = stack.itemId;
    let remaining = stack.count;
    this.beginBatch();

    if (itemStackSize(itemId) > 1) {
      for (let k = 0; k < n && remaining > 0; k++) {
        const i = order[k];
        const cur = this.slots[i];
        if (cur === null || !cur.canStackWith(stack)) continue;
        if (!this.canPlaceIn(i, stack)) continue;
        const space = this.slotLimit(i, stack) - cur.count;
        if (space <= 0) continue;
        const move = Math.min(space, remaining);
        const prev = cur.clone();
        cur.count += move;
        remaining -= move;
        this._changed(i, prev);
      }
    }

    for (let k = 0; k < n && remaining > 0; k++) {
      const i = order[k];
      if (this.slots[i] !== null) continue;
      if (!this.canPlaceIn(i, stack)) continue;
      const move = Math.min(this.slotLimit(i, stack), remaining);
      if (move <= 0) continue;
      this.slots[i] = new ItemStack(itemId, move, cloneMeta(stack.meta));
      remaining -= move;
      this._changed(i, null);
    }

    this.endBatch();
    if (remaining <= 0) return null;
    return new ItemStack(itemId, remaining, cloneMeta(stack.meta));
  }

  /**
   * Take items out of a slot.
   * @param {number} i slot index
   * @param {number} [count] how many items to take
   * @returns {?ItemStack} the removed items, or `null` when nothing was taken
   */
  remove(i, count = 1) {
    const cur = this.slots[i];
    if (cur === null || cur === undefined) return null;
    const take = Math.min(count | 0, cur.count);
    if (take <= 0) return null;
    const prev = cur.clone();
    const taken = new ItemStack(cur.itemId, take, cloneMeta(cur.meta));
    cur.count -= take;
    if (cur.count <= 0) this.slots[i] = null;
    this._changed(i, prev);
    return taken;
  }

  /**
   * Remove up to `count` items of one kind, scanning from slot 0.
   * @param {number} itemId item id to consume
   * @param {number} [count] how many to consume
   * @returns {number} how many items were actually removed
   */
  removeItem(itemId, count = 1) {
    let left = Math.max(0, count | 0);
    if (left === 0) return 0;
    let removed = 0;
    this.beginBatch();
    for (let i = 0; i < this.size && left > 0; i++) {
      const s = this.slots[i];
      if (s === null || s.itemId !== itemId) continue;
      const take = Math.min(left, s.count);
      const prev = s.clone();
      s.count -= take;
      if (s.count <= 0) this.slots[i] = null;
      left -= take;
      removed += take;
      this._changed(i, prev);
    }
    this.endBatch();
    return removed;
  }

  /**
   * Take the whole stack out of a slot.
   * @param {number} i slot index
   * @returns {?ItemStack} the stack that was there, or `null`
   */
  take(i) {
    const cur = this.slots[i];
    if (cur === null || cur === undefined) return null;
    this.slots[i] = null;
    this._changed(i, cur);
    return cur;
  }

  /**
   * Take half of a slot, rounded up — the right-click behaviour.
   * @param {number} i slot index
   * @returns {?ItemStack} the removed half, or `null`
   */
  takeHalf(i) {
    const cur = this.slots[i];
    if (cur === null || cur === undefined) return null;
    return this.remove(i, Math.ceil(cur.count / 2));
  }

  /**
   * Exchange the contents of two slots.
   * @param {number} a first slot index
   * @param {number} b second slot index
   * @returns {boolean} true when the swap happened
   */
  swap(a, b) {
    if (a === b) return true;
    if (a < 0 || a >= this.size || b < 0 || b >= this.size) {
      warnOnce(`swap:${a}:${b}`, `swap() with out-of-range slots ${a}/${b}`);
      return false;
    }
    const sa = this.slots[a];
    const sb = this.slots[b];
    if (sa !== null && !this.canPlaceIn(b, sa)) return false;
    if (sb !== null && !this.canPlaceIn(a, sb)) return false;
    this.beginBatch();
    this.slots[a] = sb;
    this.slots[b] = sa;
    this._changed(a, sa);
    this._changed(b, sb);
    this.endBatch();
    return true;
  }

  /**
   * Empty every slot.
   * @returns {void}
   */
  clear() {
    this.beginBatch();
    for (let i = 0; i < this.size; i++) {
      const prev = this.slots[i];
      if (prev === null) continue;
      this.slots[i] = null;
      this._changed(i, prev);
    }
    this.endBatch();
  }

  /**
   * Apply wear to the item in a slot and clear the slot when it breaks.
   * @param {number} i slot index
   * @param {number} [amount] durability points to consume
   * @returns {boolean} true when the item broke
   */
  damageSlot(i, amount = 1) {
    const cur = this.slots[i];
    if (cur === null || cur === undefined) return false;
    if (!cur.isDamageable()) return false;
    const prev = cur.clone();
    const broke = cur.damageBy(amount);
    if (broke) {
      const itemId = cur.itemId;
      this.slots[i] = null;
      this._changed(i, prev);
      this.emit('break', i, itemId, this);
      return true;
    }
    this._changed(i, prev);
    return false;
  }

  // -- iteration & queries --------------------------------------------------

  /**
   * Call `fn(stack, index)` for every non-empty slot.
   * @param {function(ItemStack, number):void} fn visitor
   * @returns {void}
   */
  forEach(fn) {
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s !== null) fn(s, i);
    }
  }

  /**
   * Item id -> total count over the slots `add()` may use. This is what
   * `game/crafting.js#craftableFrom` consumes.
   * @param {Map<number, number>} [out] map to fill (cleared first)
   * @returns {Map<number, number>} `out`
   */
  tally(out = new Map()) {
    out.clear();
    const lo = Math.max(0, this.storageStart);
    const hi = Math.min(this.size - 1, this.storageEnd);
    for (let i = lo; i <= hi; i++) {
      const s = this.slots[i];
      if (s === null) continue;
      out.set(s.itemId, (out.get(s.itemId) ?? 0) + s.count);
    }
    return out;
  }

  // -- events ---------------------------------------------------------------

  /**
   * Start coalescing `changed` events. Always pair with {@link endBatch}.
   * @returns {void}
   */
  beginBatch() {
    this._batch++;
  }

  /**
   * End a batch and emit the pending `changed` event.
   * @returns {void}
   */
  endBatch() {
    if (this._batch > 0) this._batch--;
    this._flush();
  }

  /**
   * Record and announce a slot change.
   * @param {number} i slot index
   * @param {?ItemStack} prev previous contents
   * @returns {void}
   * @protected
   */
  _changed(i, prev) {
    this.version++;
    this._dirty = true;
    this.emit('change', i, this.slots[i], prev, this);
    if (this._batch === 0) this._flush();
  }

  /**
   * Emit the pending `changed` event when no batch is open.
   * @returns {void}
   * @protected
   */
  _flush() {
    if (this._batch !== 0 || !this._dirty) return;
    this._dirty = false;
    this.emit('changed', this);
  }

  // -- persistence ----------------------------------------------------------

  /**
   * Sparse save representation — only occupied slots are written.
   * @returns {{size:number, slots:Array<Array<*>>}} structured-clone-safe object
   */
  serialize() {
    /** @type {Array<Array<*>>} */
    const list = [];
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s !== null) list.push([i, s.serialize()]);
    }
    return { size: this.size, slots: list };
  }

  /**
   * Restore from {@link Inventory#serialize} output. Unknown or out-of-range
   * slots are skipped with a single warning instead of throwing.
   * @param {?Object} o serialised inventory
   * @returns {Inventory} `this`, for chaining
   */
  deserialize(o) {
    this.beginBatch();
    this.clear();
    if (o !== null && o !== undefined && Array.isArray(o.slots)) {
      for (let k = 0; k < o.slots.length; k++) {
        const entry = o.slots[k];
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const index = entry[0] | 0;
        if (index < 0 || index >= this.size) {
          warnOnce('deser:range', `save contains slot ${index} outside 0..${this.size - 1}`);
          continue;
        }
        const stack = ItemStack.deserialize(entry[1]);
        if (stack === null) continue;
        const prev = this.slots[index];
        this.slots[index] = stack;
        this._changed(index, prev);
      }
    }
    this.endBatch();
    return this;
  }
}

// ---------------------------------------------------------------------------
// PlayerInventory
// ---------------------------------------------------------------------------

/**
 * The player's 46-slot inventory: 9 hotbar + 27 main + 4 armour + 1 off-hand +
 * 4 crafting + 1 crafting result. See {@link SLOT} for the exact layout.
 */
export class PlayerInventory extends Inventory {
  constructor() {
    super(SLOT.COUNT, {
      title: 'Inventar',
      storageStart: SLOT.STORAGE_START,
      storageEnd: SLOT.STORAGE_END
    });
    /** @type {number} currently selected hotbar slot (0..8) @protected */
    this._selected = 0;
    /** @type {Int32Array} scratch pickup order, reused every pickup @protected */
    this._pickupOrder = new Int32Array(SLOT.STORAGE_END - SLOT.STORAGE_START + 1);
  }

  // -- hotbar ---------------------------------------------------------------

  /** @returns {number} index of the selected hotbar slot (0..8) */
  get selected() {
    return this._selected;
  }

  /**
   * Select a hotbar slot. Out-of-range values wrap, so a mouse wheel can feed
   * it directly.
   * @param {number} value hotbar index
   */
  set selected(value) {
    const span = SLOT.HOTBAR_END - SLOT.HOTBAR_START + 1;
    let next = value | 0;
    next = ((next % span) + span) % span;
    if (next === this._selected) return;
    this._selected = next;
    this.emit('select', next, this);
  }

  /**
   * Select a hotbar slot (method form of the `selected` setter).
   * @param {number} index hotbar index (wraps)
   * @returns {number} the selected index
   */
  setSelected(index) {
    this.selected = index;
    return this._selected;
  }

  /**
   * Move the hotbar selection by `delta` slots, wrapping around.
   * @param {number} delta number of slots to move (mouse wheel direction)
   * @returns {number} the new selected index
   */
  cycleSelected(delta) {
    this.selected = this._selected + (delta | 0);
    return this._selected;
  }

  /**
   * Stack in a hotbar slot.
   * @param {number} i hotbar index 0..8
   * @returns {?ItemStack} the stack, or `null`
   */
  hotbar(i) {
    if (i < 0 || i > SLOT.HOTBAR_END) return null;
    return this.slots[SLOT.HOTBAR_START + i];
  }

  /**
   * Stack the player is currently holding in the main hand.
   * @returns {?ItemStack} the held stack, or `null`
   */
  getSelected() {
    return this.slots[SLOT.HOTBAR_START + this._selected];
  }

  /** @returns {number} absolute slot index of the held item */
  get selectedSlot() {
    return SLOT.HOTBAR_START + this._selected;
  }

  /**
   * First hotbar slot holding an item, used by "pick block".
   * @param {number} itemId item id to look for
   * @returns {number} hotbar index 0..8, or `-1`
   */
  hotbarSlotOf(itemId) {
    for (let i = SLOT.HOTBAR_START; i <= SLOT.HOTBAR_END; i++) {
      const s = this.slots[i];
      if (s !== null && s.itemId === itemId) return i - SLOT.HOTBAR_START;
    }
    return -1;
  }

  // -- armour & off-hand ----------------------------------------------------

  /**
   * Stack in an armour slot.
   * @param {number} i armour slot 0..3 (head, chest, legs, feet)
   * @returns {?ItemStack} the piece, or `null`
   */
  armor(i) {
    if (i < 0 || i > SLOT.ARMOR_END - SLOT.ARMOR_START) return null;
    return this.slots[SLOT.ARMOR_START + i];
  }

  /**
   * Put a piece into an armour slot.
   * @param {number} i armour slot 0..3
   * @param {?ItemStack} stack the piece
   * @returns {?ItemStack} whatever was in the slot before
   */
  setArmor(i, stack) {
    if (i < 0 || i > SLOT.ARMOR_END - SLOT.ARMOR_START) return stack;
    const index = SLOT.ARMOR_START + i;
    const prev = this.slots[index];
    this.set(index, stack);
    this.emit('equip', i, this.slots[index], this);
    return prev;
  }

  /** @returns {?ItemStack} the off-hand stack */
  get offhand() {
    return this.slots[SLOT.OFFHAND];
  }

  /** @param {?ItemStack} stack new off-hand contents */
  set offhand(stack) {
    this.set(SLOT.OFFHAND, stack);
  }

  /**
   * Swap main hand and off-hand (the F key).
   * @returns {void}
   */
  swapOffhand() {
    this.swap(this.selectedSlot, SLOT.OFFHAND);
  }

  /**
   * Try to wear a piece of armour, swapping out whatever is already there.
   * @param {?ItemStack} stack piece to equip
   * @returns {?ItemStack} the replaced piece, or the input when it is not armour
   */
  equipArmor(stack) {
    if (stack === null || stack === undefined || stack.isEmpty()) return null;
    const slot = armorSlot(stack.itemId);
    if (slot === ARMOR_SLOT.NONE) return stack;
    return this.setArmor(slot, stack);
  }

  /**
   * Sum of the armour points of all four worn pieces.
   * @returns {number} total armour points
   */
  totalArmorPoints() {
    let total = 0;
    for (let i = SLOT.ARMOR_START; i <= SLOT.ARMOR_END; i++) {
      const s = this.slots[i];
      if (s !== null) total += getItem(s.itemId).armorPoints;
    }
    return total;
  }

  /**
   * Sum of the armour toughness of all four worn pieces.
   * @returns {number} total toughness
   */
  totalArmorToughness() {
    let total = 0;
    for (let i = SLOT.ARMOR_START; i <= SLOT.ARMOR_END; i++) {
      const s = this.slots[i];
      if (s !== null) total += getItem(s.itemId).armorToughness;
    }
    return total;
  }

  // -- crafting grid --------------------------------------------------------

  /**
   * Stack in the 2x2 crafting grid.
   * @param {number} i grid index 0..3
   * @returns {?ItemStack} the stack, or `null`
   */
  craftingSlot(i) {
    if (i < 0 || i >= PLAYER_CRAFT_SIZE) return null;
    return this.slots[SLOT.CRAFT_START + i];
  }

  /** @returns {?ItemStack} the current crafting result preview */
  getCraftResult() {
    return this.slots[SLOT.CRAFT_RESULT];
  }

  /**
   * Write the crafting result preview. Bypasses `canPlaceIn` on purpose — the
   * crafting system owns this slot.
   * @param {?ItemStack} stack result preview, or `null`
   * @returns {void}
   */
  setCraftResult(stack) {
    const next = (stack === null || stack === undefined || stack.isEmpty()) ? null : stack;
    const prev = this.slots[SLOT.CRAFT_RESULT];
    if (prev === next) return;
    this.slots[SLOT.CRAFT_RESULT] = next;
    this._changed(SLOT.CRAFT_RESULT, prev);
  }

  /**
   * Empty the crafting grid and return everything that was in it — call this
   * when the inventory screen closes so nothing is lost.
   * @returns {ItemStack[]} the stacks taken out of the grid (may be empty)
   */
  clearCrafting() {
    /** @type {ItemStack[]} */
    const out = [];
    this.beginBatch();
    for (let i = SLOT.CRAFT_START; i <= SLOT.CRAFT_END; i++) {
      const s = this.slots[i];
      if (s === null) continue;
      this.slots[i] = null;
      this._changed(i, s);
      const leftover = this.add(s);
      if (leftover !== null) out.push(leftover);
    }
    this.setCraftResult(null);
    this.endBatch();
    return out;
  }

  // -- rules ----------------------------------------------------------------

  /**
   * Armour slots only take the matching piece (plus a carved pumpkin on the
   * head), and the crafting result is never a drop target.
   * @param {number} i slot index
   * @param {?ItemStack} stack stack about to be placed
   * @returns {boolean} true when the slot accepts the stack
   */
  canPlaceIn(i, stack) {
    if (!super.canPlaceIn(i, stack)) return false;
    if (i === SLOT.CRAFT_RESULT) return false;
    if (i >= SLOT.ARMOR_START && i <= SLOT.ARMOR_END) {
      const wanted = i - SLOT.ARMOR_START;
      if (armorSlot(stack.itemId) === wanted) return true;
      return wanted === ARMOR_SLOT.HEAD && stack.itemId === I.CARVED_PUMPKIN;
    }
    return true;
  }

  // -- pickup ---------------------------------------------------------------

  /**
   * Insert a picked-up stack, preferring the hotbar: the held slot first, then
   * the rest of the hotbar, then main storage. Partial stacks are topped up
   * before empty slots are used, in that same order.
   *
   * @param {?ItemStack} stack stack to pick up (not mutated)
   * @returns {?ItemStack} what did not fit, or `null` when all of it was stored
   */
  addPickup(stack) {
    if (stack === null || stack === undefined || stack.isEmpty()) return null;
    const order = this._pickupOrder;
    let n = 0;
    const held = SLOT.HOTBAR_START + this._selected;
    order[n++] = held;
    for (let i = SLOT.HOTBAR_START; i <= SLOT.HOTBAR_END; i++) {
      if (i !== held) order[n++] = i;
    }
    for (let i = SLOT.MAIN_START; i <= SLOT.MAIN_END; i++) order[n++] = i;
    return this._insertOrdered(stack, order, n);
  }

  // -- held item ------------------------------------------------------------

  /**
   * Wear down the held item by `amount` and break it at zero durability.
   * Breaking clears the slot and emits `break` so `game/audio.js` can play the
   * snap and `ui/hud.js` can flash the hotbar.
   *
   * @param {number} [amount] durability points to consume
   * @returns {boolean} true when the tool broke
   */
  damageSelected(amount = 1) {
    return this.damageSlot(this.selectedSlot, amount);
  }

  /**
   * Consume items from the held stack (eating, placing blocks, throwing).
   * @param {number} [n] how many items to consume
   * @returns {number} how many items were actually consumed
   */
  consumeSelected(n = 1) {
    const index = this.selectedSlot;
    const cur = this.slots[index];
    if (cur === null) return 0;
    const take = Math.min(Math.max(0, n | 0), cur.count);
    if (take === 0) return 0;
    const prev = cur.clone();
    cur.count -= take;
    if (cur.count <= 0) this.slots[index] = null;
    this._changed(index, prev);
    return take;
  }

  // -- persistence ----------------------------------------------------------

  /**
   * @returns {{size:number, slots:Array<Array<*>>, selected:number}} save object
   */
  serialize() {
    const base = super.serialize();
    return { size: base.size, slots: base.slots, selected: this._selected };
  }

  /**
   * @param {?Object} o serialised player inventory
   * @returns {PlayerInventory} `this`, for chaining
   */
  deserialize(o) {
    super.deserialize(o);
    if (o !== null && o !== undefined && Number.isFinite(o.selected)) {
      this.selected = o.selected | 0;
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/**
 * Furnace slot indices, shared with `ui/inventory_ui.js`.
 * @type {Readonly<{INPUT:number, FUEL:number, OUTPUT:number}>}
 */
export const FURNACE_SLOT = Object.freeze({ INPUT: 0, FUEL: 1, OUTPUT: 2 });

/**
 * Layout of every container kind: slot count, grid shape, German window title
 * and whether the container smelts.
 * @type {Readonly<Object<string, {size:number, cols:number, rows:number, title:string, furnace:boolean, speed:number}>>}
 */
export const CONTAINER_TYPES = Object.freeze({
  chest: { size: 27, cols: 9, rows: 3, title: 'Truhe', furnace: false, speed: 1 },
  large_chest: { size: 54, cols: 9, rows: 6, title: 'Große Truhe', furnace: false, speed: 1 },
  barrel: { size: 27, cols: 9, rows: 3, title: 'Fass', furnace: false, speed: 1 },
  hopper: { size: 5, cols: 5, rows: 1, title: 'Trichter', furnace: false, speed: 1 },
  dispenser: { size: 9, cols: 3, rows: 3, title: 'Werfer', furnace: false, speed: 1 },
  furnace: { size: 3, cols: 1, rows: 3, title: 'Ofen', furnace: true, speed: 1 },
  blast_furnace: { size: 3, cols: 1, rows: 3, title: 'Schmelzofen', furnace: true, speed: 2 },
  smoker: { size: 3, cols: 1, rows: 3, title: 'Räucherofen', furnace: true, speed: 2 }
});

/**
 * A block-backed inventory: chests, barrels, hoppers, dispensers and furnaces.
 *
 * Because it extends {@link Inventory} the whole UI (drag, shift-click, split)
 * works on it without a single special case. Furnaces additionally carry burn
 * and cook state; they get their smelting/fuel tables injected via
 * {@link Container#setResolvers} so this module never imports `crafting.js`.
 */
export class Container extends Inventory {
  /**
   * @param {string} [kind] a key of {@link CONTAINER_TYPES}
   * @param {Object} [opts] optional configuration
   * @param {number} [opts.x] block X of the container (for sounds/saving)
   * @param {number} [opts.y] block Y
   * @param {number} [opts.z] block Z
   * @param {string} [opts.title] override the German window title
   */
  constructor(kind = 'chest', opts = {}) {
    const type = CONTAINER_TYPES[kind] ?? CONTAINER_TYPES.chest;
    if (CONTAINER_TYPES[kind] === undefined) {
      warnOnce(`kind:${kind}`, `unknown container kind "${kind}", falling back to chest`);
    }
    super(type.size, { title: opts.title ?? type.title, storageStart: 0, storageEnd: type.size - 1 });

    /** @type {string} container kind, a key of {@link CONTAINER_TYPES} */
    this.kind = CONTAINER_TYPES[kind] === undefined ? 'chest' : kind;
    /** @type {number} UI grid columns */
    this.cols = type.cols;
    /** @type {number} UI grid rows */
    this.rows = type.rows;
    /** @type {boolean} does this container smelt? */
    this.isFurnace = type.furnace;
    /** @type {number} cook speed multiplier (blast furnace / smoker are 2x) */
    this.speed = type.speed;
    /** @type {number} block X, `NaN` for containers that are not placed */
    this.x = Number.isFinite(opts.x) ? opts.x | 0 : NaN;
    /** @type {number} block Y */
    this.y = Number.isFinite(opts.y) ? opts.y | 0 : NaN;
    /** @type {number} block Z */
    this.z = Number.isFinite(opts.z) ? opts.z | 0 : NaN;
    /** @type {number} how many screens currently show this container */
    this.viewers = 0;

    // Furnace state (all zero for non-furnaces).
    /** @type {number} remaining burn ticks of the current fuel */
    this.burnTime = 0;
    /** @type {number} burn ticks the current fuel started with (progress bar) */
    this.burnTimeTotal = 0;
    /** @type {number} ticks already spent on the current smelt */
    this.cookTime = 0;
    /** @type {number} ticks needed for the current smelt */
    this.cookTimeTotal = 200;
    /** @type {number} experience banked for the next output pickup */
    this.storedXp = 0;

    /** @type {?function(number):?{result:number, xp:number, time:number}} injected smelting lookup @protected */
    this._smeltFn = null;
    /** @type {?function(number):number} injected fuel lookup @protected */
    this._fuelFn = null;

    // Furnaces insert into the input slot only; the fuel slot is handled by
    // `quickInsert`, the output slot is never an insertion target.
    if (this.isFurnace) {
      this.storageStart = FURNACE_SLOT.INPUT;
      this.storageEnd = FURNACE_SLOT.INPUT;
    }
  }

  /**
   * Inject the smelting and fuel tables from `game/crafting.js`. Without them a
   * furnace simply never advances (it degrades, it does not throw).
   * @param {?function(number):?{result:number, xp:number, time:number}} smeltFn `smeltResult`
   * @param {?function(number):number} fuelFn `fuelValue`
   * @returns {Container} `this`, for chaining
   */
  setResolvers(smeltFn, fuelFn) {
    this._smeltFn = typeof smeltFn === 'function' ? smeltFn : null;
    this._fuelFn = typeof fuelFn === 'function' ? fuelFn : null;
    return this;
  }

  /**
   * Burn time of an item according to the injected fuel table.
   * @param {?ItemStack} stack stack to test
   * @returns {number} burn ticks, `0` when the item is not a fuel
   */
  fuelTicks(stack) {
    if (stack === null || stack === undefined || stack.isEmpty()) return 0;
    if (this._fuelFn === null) return 0;
    const ticks = this._fuelFn(stack.itemId);
    return Number.isFinite(ticks) && ticks > 0 ? ticks : 0;
  }

  /**
   * The output slot is never a drop target; the fuel slot only accepts fuels.
   * @param {number} i slot index
   * @param {?ItemStack} stack stack about to be placed
   * @returns {boolean} true when the slot accepts the stack
   */
  canPlaceIn(i, stack) {
    if (!super.canPlaceIn(i, stack)) return false;
    if (!this.isFurnace) return true;
    if (i === FURNACE_SLOT.OUTPUT) return false;
    if (i === FURNACE_SLOT.FUEL) return this.fuelTicks(stack) > 0;
    return true;
  }

  /**
   * Shift-click insertion: fuels go to the fuel slot of a furnace, everything
   * else into the normal storage range.
   * @param {?ItemStack} stack stack to insert (not mutated)
   * @returns {?ItemStack} leftover, or `null`
   */
  quickInsert(stack) {
    if (stack === null || stack === undefined || stack.isEmpty()) return null;
    if (!this.isFurnace) return this.add(stack);
    if (this.fuelTicks(stack) > 0 && this._smeltFn !== null && this._smeltFn(stack.itemId) === null) {
      return this.addAt(FURNACE_SLOT.FUEL, stack);
    }
    if (this.fuelTicks(stack) > 0 && this._smeltFn === null) {
      return this.addAt(FURNACE_SLOT.FUEL, stack);
    }
    const leftover = this.addAt(FURNACE_SLOT.INPUT, stack);
    if (leftover === null) return null;
    if (this.fuelTicks(leftover) > 0) return this.addAt(FURNACE_SLOT.FUEL, leftover);
    return leftover;
  }

  // -- viewers --------------------------------------------------------------

  /**
   * Register a viewer (opens the lid, plays the chest sound).
   * @returns {number} the new viewer count
   */
  open() {
    this.viewers++;
    if (this.viewers === 1) this.emit('open', this);
    return this.viewers;
  }

  /**
   * Unregister a viewer.
   * @returns {number} the new viewer count
   */
  close() {
    if (this.viewers > 0) this.viewers--;
    if (this.viewers === 0) this.emit('close', this);
    return this.viewers;
  }

  // -- furnace --------------------------------------------------------------

  /**
   * Can the current input be smelted into the current output right now?
   * @returns {?{result:number, xp:number, time:number}} the recipe, or `null`
   * @protected
   */
  _activeSmelt() {
    if (!this.isFurnace || this._smeltFn === null) return null;
    const input = this.slots[FURNACE_SLOT.INPUT];
    if (input === null) return null;
    const recipe = this._smeltFn(input.itemId);
    if (recipe === null || recipe === undefined) return null;
    const output = this.slots[FURNACE_SLOT.OUTPUT];
    if (output === null) return recipe;
    if (output.itemId !== recipe.result) return null;
    if (output.count >= this.slotLimit(FURNACE_SLOT.OUTPUT, output)) return null;
    return recipe;
  }

  /**
   * Advance the furnace by `ticks` game ticks (20 per second). Safe to call on
   * a non-furnace container — it simply does nothing.
   *
   * @param {number} [ticks] number of 50 ms game ticks to simulate
   * @returns {boolean} true when any state changed (so the UI can repaint)
   */
  tickFurnace(ticks = 1) {
    if (!this.isFurnace) return false;
    const steps = Math.max(0, ticks | 0);
    if (steps === 0) return false;
    let changed = false;
    const wasBurning = this.burnTime > 0;

    if (this.burnTime > 0) {
      this.burnTime = Math.max(0, this.burnTime - steps);
      changed = true;
    }

    let recipe = this._activeSmelt();

    // Light a new piece of fuel when there is something to smelt.
    if (this.burnTime <= 0 && recipe !== null) {
      const fuel = this.slots[FURNACE_SLOT.FUEL];
      const ticksFromFuel = this.fuelTicks(fuel);
      if (ticksFromFuel > 0) {
        this.burnTime = ticksFromFuel;
        this.burnTimeTotal = ticksFromFuel;
        const prev = fuel.clone();
        const container = FUEL_CONTAINER[fuel.itemId];
        fuel.count -= 1;
        if (fuel.count <= 0) {
          this.slots[FURNACE_SLOT.FUEL] = container === undefined ? null : new ItemStack(container, 1, null);
        }
        this._changed(FURNACE_SLOT.FUEL, prev);
        changed = true;
      }
    }

    if (this.burnTime > 0 && recipe !== null) {
      this.cookTimeTotal = Math.max(1, Math.round((recipe.time > 0 ? recipe.time : 200) / this.speed));
      this.cookTime += steps;
      changed = true;
      while (this.cookTime >= this.cookTimeTotal) {
        this.cookTime -= this.cookTimeTotal;
        this._finishSmelt(recipe);
        recipe = this._activeSmelt();
        if (recipe === null) { this.cookTime = 0; break; }
      }
    } else if (this.cookTime > 0) {
      this.cookTime = Math.max(0, this.cookTime - steps * 2);
      changed = true;
    }

    if (wasBurning !== (this.burnTime > 0)) changed = true;
    if (changed) this.emit('furnace', this);
    return changed;
  }

  /**
   * Move one item from input to output and bank the experience.
   * @param {{result:number, xp:number, time:number}} recipe the active smelting recipe
   * @returns {void}
   * @protected
   */
  _finishSmelt(recipe) {
    const input = this.slots[FURNACE_SLOT.INPUT];
    if (input === null) return;
    const prevIn = input.clone();
    input.count -= 1;
    if (input.count <= 0) this.slots[FURNACE_SLOT.INPUT] = null;
    this._changed(FURNACE_SLOT.INPUT, prevIn);

    const out = this.slots[FURNACE_SLOT.OUTPUT];
    if (out === null) {
      this.slots[FURNACE_SLOT.OUTPUT] = new ItemStack(recipe.result, 1, null);
      this._changed(FURNACE_SLOT.OUTPUT, null);
    } else {
      const prevOut = out.clone();
      out.count += 1;
      this._changed(FURNACE_SLOT.OUTPUT, prevOut);
    }
    this.storedXp += recipe.xp > 0 ? recipe.xp : 0;
  }

  /**
   * Take the finished goods out and collect the banked experience.
   * @returns {{stack:?ItemStack, xp:number}} the output and the XP to award
   */
  takeFurnaceOutput() {
    if (!this.isFurnace) return { stack: null, xp: 0 };
    const stack = this.take(FURNACE_SLOT.OUTPUT);
    const xp = this.storedXp;
    this.storedXp = 0;
    return { stack, xp: Math.floor(xp) };
  }

  /** @returns {number} burn progress 0..1 for the flame icon */
  get burnProgress() {
    return this.burnTimeTotal > 0 ? Math.max(0, Math.min(1, this.burnTime / this.burnTimeTotal)) : 0;
  }

  /** @returns {number} cook progress 0..1 for the arrow */
  get cookProgress() {
    return this.cookTimeTotal > 0 ? Math.max(0, Math.min(1, this.cookTime / this.cookTimeTotal)) : 0;
  }

  // -- persistence ----------------------------------------------------------

  /**
   * @returns {Object} structured-clone-safe save object including furnace state
   */
  serialize() {
    const base = super.serialize();
    return {
      size: base.size,
      slots: base.slots,
      kind: this.kind,
      x: Number.isFinite(this.x) ? this.x : null,
      y: Number.isFinite(this.y) ? this.y : null,
      z: Number.isFinite(this.z) ? this.z : null,
      burnTime: this.burnTime,
      burnTimeTotal: this.burnTimeTotal,
      cookTime: this.cookTime,
      cookTimeTotal: this.cookTimeTotal,
      storedXp: this.storedXp
    };
  }

  /**
   * @param {?Object} o serialised container
   * @returns {Container} `this`, for chaining
   */
  deserialize(o) {
    super.deserialize(o);
    if (o === null || o === undefined) return this;
    if (Number.isFinite(o.x)) this.x = o.x | 0;
    if (Number.isFinite(o.y)) this.y = o.y | 0;
    if (Number.isFinite(o.z)) this.z = o.z | 0;
    this.burnTime = Number.isFinite(o.burnTime) ? Math.max(0, o.burnTime | 0) : 0;
    this.burnTimeTotal = Number.isFinite(o.burnTimeTotal) ? Math.max(0, o.burnTimeTotal | 0) : 0;
    this.cookTime = Number.isFinite(o.cookTime) ? Math.max(0, o.cookTime | 0) : 0;
    this.cookTimeTotal = Number.isFinite(o.cookTimeTotal) && o.cookTimeTotal > 0 ? o.cookTimeTotal | 0 : 200;
    this.storedXp = Number.isFinite(o.storedXp) ? Math.max(0, o.storedXp) : 0;
    return this;
  }

  /**
   * Rebuild a container (including its kind) from save data.
   * @param {?Object} o serialised container
   * @returns {Container} the restored container
   */
  static deserialize(o) {
    const kind = (o !== null && o !== undefined && typeof o.kind === 'string') ? o.kind : 'chest';
    const c = new Container(kind, {
      x: (o && Number.isFinite(o.x)) ? o.x : undefined,
      y: (o && Number.isFinite(o.y)) ? o.y : undefined,
      z: (o && Number.isFinite(o.z)) ? o.z : undefined
    });
    c.deserialize(o);
    return c;
  }
}

/**
 * Fuels that leave an empty container behind when they burn up.
 * @type {Object<number, number>}
 */
const FUEL_CONTAINER = Object.create(null);
FUEL_CONTAINER[I.LAVA_BUCKET] = I.BUCKET;

/**
 * Build a container for the block at a position.
 * @param {string} kind a key of {@link CONTAINER_TYPES}
 * @param {number} [x] block X
 * @param {number} [y] block Y
 * @param {number} [z] block Z
 * @returns {Container} the new container
 */
export function createContainer(kind, x, y, z) {
  return new Container(kind, { x, y, z });
}

// ---------------------------------------------------------------------------
// Free functions used by the inventory UI
// ---------------------------------------------------------------------------

/**
 * Clamp an index into a range, tolerating `NaN`.
 * @param {number} v candidate index
 * @param {number} lo lowest allowed value
 * @param {number} hi highest allowed value
 * @returns {number} the clamped index
 */
function clampIndex(v, lo, hi) {
  const n = Number.isFinite(v) ? v | 0 : lo;
  if (hi < lo) return lo;
  return n < lo ? lo : (n > hi ? hi : n);
}

/**
 * Shift-click one slot from `source` into `target` (they may be the same
 * inventory, e.g. hotbar <-> main storage).
 *
 * @param {Inventory} source inventory the stack is taken from
 * @param {number} index slot index inside `source`
 * @param {Inventory} target inventory the stack is moved into
 * @param {number} [from] first target slot (defaults to the target's storage range)
 * @param {number} [to] last target slot, inclusive
 * @returns {number} how many items were moved
 */
export function moveStack(source, index, target, from = target.storageStart, to = target.storageEnd) {
  const stack = source.get(index);
  if (stack === null) return 0;
  const before = stack.count;
  const leftover = target.add(stack, from, to);
  const moved = before - (leftover === null ? 0 : leftover.count);
  if (moved <= 0) return 0;
  source.remove(index, moved);
  return moved;
}

/**
 * Spread a held stack evenly over the slots the player dragged across — the
 * left-drag distribution of the inventory screen.
 *
 * @param {Inventory} inventory inventory being dragged over
 * @param {number[]} indices slot indices touched by the drag
 * @param {ItemStack} stack stack held by the cursor (not mutated)
 * @returns {?ItemStack} what is left on the cursor afterwards, or `null`
 */
export function distributeStack(inventory, indices, stack) {
  if (stack === null || stack === undefined || stack.isEmpty()) return null;
  if (!Array.isArray(indices) || indices.length === 0) return stack.clone();
  /** @type {number[]} */
  const targets = [];
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (i < 0 || i >= inventory.size) continue;
    const cur = inventory.get(i);
    if (cur !== null && !cur.canStackWith(stack)) continue;
    if (!inventory.canPlaceIn(i, stack)) continue;
    if (targets.indexOf(i) === -1) targets.push(i);
  }
  if (targets.length === 0) return stack.clone();

  const each = Math.max(1, Math.floor(stack.count / targets.length));
  let remaining = stack.count;
  inventory.beginBatch();
  for (let k = 0; k < targets.length && remaining > 0; k++) {
    const give = Math.min(each, remaining);
    const part = new ItemStack(stack.itemId, give, cloneMeta(stack.meta));
    const leftover = inventory.addAt(targets[k], part);
    remaining -= give - (leftover === null ? 0 : leftover.count);
  }
  inventory.endBatch();
  if (remaining <= 0) return null;
  return new ItemStack(stack.itemId, remaining, cloneMeta(stack.meta));
}

/**
 * Count how many of an item a *tally-able* source holds. Accepts an
 * {@link Inventory}, a `Map<itemId, count>` or an array of stacks, which is
 * what the recipe book and the quest/advancement checks need.
 *
 * @param {(Inventory|Map<number, number>|Array<?ItemStack>)} source item source
 * @param {number} itemId item id to count
 * @returns {number} total item count
 */
export function countItems(source, itemId) {
  if (source === null || source === undefined) return 0;
  if (source instanceof Inventory) return source.count(itemId);
  if (source instanceof Map) return source.get(itemId) ?? 0;
  if (Array.isArray(source)) {
    let total = 0;
    for (let i = 0; i < source.length; i++) {
      const s = source[i];
      if (s !== null && s !== undefined && s.itemId === itemId) total += s.count;
    }
    return total;
  }
  return 0;
}
