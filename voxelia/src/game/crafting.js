/**
 * VOXELIA — recipes, smelting and fuels (ARCHITECTURE.md § 5.33).
 *
 * ============================================================================
 * WHAT THIS MODULE GUARANTEES
 * ============================================================================
 * * ~280 registered recipes covering the whole vanilla progression: planks and
 *   sticks, every tool and armour tier, furnaces, chests, torches, doors,
 *   fences, stairs, slabs, bows, arrows, buckets, shears, TNT, the enchanting
 *   table, anvils, hoppers, rails, the redstone components, all 16 dyes plus
 *   wool/concrete/terracotta colouring, and the food chain.
 * * Correct **shaped** matching: the grid is trimmed to its bounding box and
 *   compared against the recipe pattern *and* its horizontal mirror, exactly
 *   like vanilla, so an axe works "both ways round".
 * * Correct **shapeless** matching: the grid contents and the ingredient list
 *   are compared as multisets via a bipartite matching, which is required as
 *   soon as tags overlap (`#planks` and `oak_planks` in the same recipe).
 * * An **ingredient tag system** (`#planks`, `#logs`, `#wool`, `#coals`, …) so
 *   one recipe covers all seven wood species and all sixteen wool colours.
 * * `craftableFrom()` for the recipe book, fast enough to run on every single
 *   inventory change: recipes are indexed by ingredient, pre-filtered by a
 *   cheap availability test and only then verified with a tiny max-flow (which
 *   is what correctly handles two requirements competing for the same items).
 *
 * ============================================================================
 * DEVIATIONS FROM VANILLA (and why)
 * ============================================================================
 * VOXELIA has no smithing table, no stonecutter, no cocoa beans and no
 * tripwire hook, and only oak has door/fence/stair/slab block variants. Where a
 * vanilla recipe would be uncraftable the recipe was moved into the grid:
 *   * netherite gear   diamond gear + netherite ingot (shapeless "upgrade")
 *   * chainmail armour crafted from iron nuggets
 *   * brown dye        from a brown mushroom (VOXELIA's cocoa substitute)
 *   * cookies          wheat + sugar + wheat
 *   * beacon           netherite ingot instead of a nether star
 *   * crossbow         iron ingot instead of a tripwire hook
 *   * chiseled quartz  two quartz blocks side by side (no quartz slabs exist)
 *   * wooden buildables accept **any** plank species (`#planks`)
 * Every one of these is marked with a `// VOXELIA:` comment at its definition.
 *
 * All user-facing strings are German.
 *
 * @module game/crafting
 */

import { ItemStack, Inventory } from './inventory.js';
import { ITEMS, itemIdByName, itemDisplay, itemStackSize, itemFuel } from './items.js';

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Keys of problems already reported. @type {Set<string>} */
const WARNED = new Set();

/**
 * Log a message at most once per key — registration problems must never throw
 * and must never spam the console.
 * @param {string} key de-duplication key
 * @param {string} message human readable message
 * @returns {void}
 */
function warnOnce(key, message) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  console.warn(`[crafting] ${message}`);
}

/**
 * Resolve an item name to its id, warning once about typos.
 * @param {string} name snake_case item name
 * @returns {number} item id, `0` when the name is unknown
 */
function id(name) {
  const value = itemIdByName(name);
  if (value === 0) warnOnce(`item:${name}`, `unknown item "${name}"`);
  return value;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Recipe-book categories. The UI renders one tab per entry, in this order.
 * @type {Readonly<{TOOLS:string, BUILDING:string, REDSTONE:string,
 *   FOOD:string, MISC:string, COMBAT:string}>}
 */
export const RECIPE_CATEGORY = Object.freeze({
  TOOLS: 'tools',
  BUILDING: 'building',
  REDSTONE: 'redstone',
  FOOD: 'food',
  MISC: 'misc',
  COMBAT: 'combat'
});

/**
 * Tab order used by {@link craftableFrom} when sorting.
 * @type {readonly string[]}
 */
export const RECIPE_CATEGORIES = Object.freeze([
  RECIPE_CATEGORY.BUILDING, RECIPE_CATEGORY.TOOLS, RECIPE_CATEGORY.COMBAT,
  RECIPE_CATEGORY.REDSTONE, RECIPE_CATEGORY.FOOD, RECIPE_CATEGORY.MISC
]);

/**
 * German tab labels for {@link RECIPE_CATEGORIES}.
 * @type {Readonly<Object<string, string>>}
 */
export const RECIPE_CATEGORY_LABELS = Object.freeze({
  building: 'Bauen',
  tools: 'Werkzeuge',
  combat: 'Kampf',
  redstone: 'Redstone',
  food: 'Nahrung',
  misc: 'Verschiedenes'
});

/** category -> sort rank. @type {Map<string, number>} */
const CATEGORY_RANK = new Map();
for (let i = 0; i < RECIPE_CATEGORIES.length; i++) CATEGORY_RANK.set(RECIPE_CATEGORIES[i], i);

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * Ingredient tags: a tag name maps to the list of item ids it accepts. Recipes
 * reference a tag as `'#planks'`. Tags are expanded at registration time, so
 * matching stays a plain `Set.has()` lookup.
 * @type {Map<string, number[]>}
 */
export const TAGS = new Map();

/**
 * Define (or replace) an ingredient tag.
 * @param {string} name tag name without the leading `#`
 * @param {readonly string[]} names item names belonging to the tag
 * @returns {number[]} the resolved item ids
 */
export function registerTag(name, names) {
  /** @type {number[]} */
  const ids = [];
  for (let i = 0; i < names.length; i++) {
    const value = id(names[i]);
    if (value !== 0 && ids.indexOf(value) === -1) ids.push(value);
  }
  if (ids.length === 0) warnOnce(`tag:${name}`, `tag "#${name}" resolved to no items`);
  TAGS.set(name, ids);
  return ids;
}

/**
 * Item ids belonging to a tag.
 * @param {string} name tag name, with or without the leading `#`
 * @returns {number[]} a copy of the tag contents (empty for unknown tags)
 */
export function expandTag(name) {
  const key = name.charCodeAt(0) === 35 ? name.slice(1) : name;
  const ids = TAGS.get(key);
  if (ids === undefined) {
    warnOnce(`tagmiss:${key}`, `unknown tag "#${key}"`);
    return [];
  }
  return ids.slice();
}

/**
 * Is an item part of a tag?
 * @param {string} name tag name, with or without the leading `#`
 * @param {number} itemId item id to test
 * @returns {boolean} true when the tag contains the item
 */
export function tagContains(name, itemId) {
  const key = name.charCodeAt(0) === 35 ? name.slice(1) : name;
  const ids = TAGS.get(key);
  return ids !== undefined && ids.indexOf(itemId) !== -1;
}

/** The seven wood species VOXELIA ships. @type {readonly string[]} */
const WOODS = Object.freeze(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry']);

/** The sixteen dye colours. @type {readonly string[]} */
const COLORS = Object.freeze([
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
]);

/** Terracotta colours that exist as blocks in VOXELIA. @type {readonly string[]} */
const TERRACOTTA_COLORS = Object.freeze([
  'white', 'orange', 'yellow', 'brown', 'red', 'light_gray', 'cyan', 'green'
]);

registerTag('planks', WOODS.map((w) => `${w}_planks`));
registerTag('logs', WOODS.map((w) => `${w}_log`));
registerTag('leaves', WOODS.map((w) => `${w}_leaves`));
registerTag('saplings', WOODS.map((w) => `${w}_sapling`));
registerTag('wool', COLORS.map((c) => `${c}_wool`));
registerTag('coals', ['coal', 'charcoal']);
registerTag('stone_tool_materials', ['cobblestone', 'cobbled_deepslate', 'blackstone']);
registerTag('sand', ['sand', 'red_sand']);
registerTag('soul_fire_base', ['soul_sand', 'soul_soil']);
registerTag('small_flowers', [
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'cornflower', 'oxeye_daisy'
]);
registerTag('fishes', ['cod', 'salmon', 'tropical_fish']);
registerTag('dyes', COLORS.map((c) => `${c}_dye`));

// ---------------------------------------------------------------------------
// Ingredients
// ---------------------------------------------------------------------------

/**
 * One normalised ingredient: the set of item ids that satisfy it.
 * @typedef {Object} Ingredient
 * @property {string} label human readable source spec (`'#planks'`, `'diamond'`)
 * @property {number[]} ids accepted item ids
 * @property {Set<number>} set the same ids as a set, for O(1) matching
 * @property {number} primary first accepted id — used for the recipe-book icon
 */

/**
 * Normalise an ingredient specification.
 * Accepted forms: an item name (`'diamond'`), a tag (`'#planks'`), a numeric
 * item id, or an array mixing any of those.
 *
 * @param {(string|number|Array<string|number>)} spec ingredient specification
 * @returns {?Ingredient} the normalised ingredient, or `null` when it is empty
 */
function makeIngredient(spec) {
  /** @type {number[]} */
  const ids = [];
  const push = (value) => {
    if (value !== 0 && ids.indexOf(value) === -1) ids.push(value);
  };
  const consume = (one) => {
    if (typeof one === 'number') {
      if (one > 0 && one < ITEMS.length) push(one | 0);
      else warnOnce(`ingid:${one}`, `ingredient references invalid item id ${one}`);
      return;
    }
    if (typeof one !== 'string' || one.length === 0) return;
    if (one.charCodeAt(0) === 35) {
      const tagIds = expandTag(one);
      for (let i = 0; i < tagIds.length; i++) push(tagIds[i]);
      return;
    }
    push(id(one));
  };
  if (Array.isArray(spec)) for (let i = 0; i < spec.length; i++) consume(spec[i]);
  else consume(spec);

  if (ids.length === 0) return null;
  const label = Array.isArray(spec) ? spec.join('|') : String(spec);
  return { label, ids, set: new Set(ids), primary: ids[0] };
}

/**
 * Stable key for an ingredient, so identical ingredients in different grid
 * cells collapse into a single requirement.
 * @param {Ingredient} ing ingredient to key
 * @returns {string} the key
 */
function ingredientKey(ing) {
  if (ing.ids.length === 1) return String(ing.ids[0]);
  const sorted = ing.ids.slice().sort((a, b) => a - b);
  return sorted.join(',');
}

// ---------------------------------------------------------------------------
// Recipe storage & indices
// ---------------------------------------------------------------------------

/**
 * A registered, fully normalised recipe.
 *
 * @typedef {Object} Recipe
 * @property {string} id stable, unique string id
 * @property {'shaped'|'shapeless'} type recipe kind
 * @property {string[]} pattern the shaped pattern rows (`[]` for shapeless)
 * @property {Object<string, Ingredient>} key pattern character -> ingredient
 * @property {Ingredient[]} ingredients every ingredient, flattened
 * @property {{item:number, count:number}} result crafted item id and amount
 * @property {string} category a {@link RECIPE_CATEGORY} value
 * @property {string} group recipe-book grouping key (usually the result name)
 * @property {string} display German name of the result
 * @property {number} width pattern width (shapeless: number of ingredients)
 * @property {number} height pattern height (shapeless: 1)
 * @property {(Ingredient|null)[]} cells row-major pattern cells (shaped only)
 * @property {(Ingredient|null)[]} cellsMirrored horizontally mirrored `cells`
 * @property {{ids:number[], set:Set<number>, count:number}[]} requirements
 *   grouped ingredient demands, used by {@link craftableFrom}
 */

/**
 * Every registered recipe, in registration order.
 * @type {Recipe[]}
 */
export const RECIPES = [];

/** Recipe id -> recipe. @type {Map<string, Recipe>} */
export const RECIPE_BY_ID = new Map();

/** Result item id -> recipes producing it. @type {Map<number, Recipe[]>} */
export const RECIPES_BY_RESULT = new Map();

/** Ingredient item id -> recipes that can consume it. @type {Map<number, Recipe[]>} */
export const RECIPES_BY_INGREDIENT = new Map();

/**
 * Working tally reused by `craftableFrom`, so the recipe book allocates nothing
 * per call.
 * @type {Map<number, number>}
 */
const workTally = new Map();

/** Snapshot of the tally the cached result was computed from. @type {Map<number, number>} */
const cacheTally = new Map();

/** Cached craftable list. @type {Recipe[]} */
let cacheResult = [];

/** Is {@link cacheResult} still usable? @type {boolean} */
let cacheValid = false;

/**
 * Drop the recipe-book cache. Called whenever a recipe is registered, because
 * a new recipe can turn a previously "not craftable" inventory into a hit.
 * @returns {void}
 */
function invalidateCraftableCache() {
  cacheValid = false;
}

/**
 * Items that are given back instead of consumed (vanilla "remainder" items).
 * Milk in the cake recipe returns the bucket, honey bottles return the glass.
 * @type {Map<number, number>}
 */
export const REMAINDERS = new Map();

/**
 * Fill {@link REMAINDERS} once every item id is known.
 * @returns {void}
 */
function initRemainders() {
  const pairs = [
    ['water_bucket', 'bucket'], ['lava_bucket', 'bucket'], ['milk_bucket', 'bucket'],
    ['honey_bottle', 'glass_bottle']
  ];
  for (let i = 0; i < pairs.length; i++) {
    const from = id(pairs[i][0]);
    const to = id(pairs[i][1]);
    if (from !== 0 && to !== 0) REMAINDERS.set(from, to);
  }
}
initRemainders();

/**
 * Add a recipe to the ingredient index.
 * @param {Recipe} recipe recipe to index
 * @returns {void}
 */
function indexRecipe(recipe) {
  RECIPE_BY_ID.set(recipe.id, recipe);

  const byResult = RECIPES_BY_RESULT.get(recipe.result.item);
  if (byResult === undefined) RECIPES_BY_RESULT.set(recipe.result.item, [recipe]);
  else byResult.push(recipe);

  const seen = new Set();
  for (let i = 0; i < recipe.ingredients.length; i++) {
    const ids = recipe.ingredients[i].ids;
    for (let k = 0; k < ids.length; k++) {
      const itemId = ids[k];
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      const list = RECIPES_BY_INGREDIENT.get(itemId);
      if (list === undefined) RECIPES_BY_INGREDIENT.set(itemId, [recipe]);
      else list.push(recipe);
    }
  }
}

/**
 * Build the grouped ingredient demands used by {@link craftableFrom}.
 * @param {Ingredient[]} ingredients flattened ingredient list
 * @returns {{ids:number[], set:Set<number>, count:number}[]} grouped demands
 */
function buildRequirements(ingredients) {
  /** @type {Map<string, {ids:number[], set:Set<number>, count:number}>} */
  const groups = new Map();
  for (let i = 0; i < ingredients.length; i++) {
    const ing = ingredients[i];
    const key = ingredientKey(ing);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { ids: ing.ids.slice(), set: ing.set, count: 1 });
    } else {
      existing.count++;
    }
  }
  return [...groups.values()];
}

/**
 * Make a recipe id unique by appending `_2`, `_3`, … when needed.
 * @param {string} base desired id
 * @returns {string} a free id
 */
function uniqueId(base) {
  if (!RECIPE_BY_ID.has(base)) return base;
  let n = 2;
  while (RECIPE_BY_ID.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/**
 * Validate, normalise, index and store a recipe.
 *
 * Input format (everything except `id` and `group` is required):
 * ```js
 * { id?, type:'shaped'|'shapeless',
 *   pattern:['PP','PP'], key:{P:'#planks'},   // shaped
 *   ingredients:['diamond','stick'],          // shapeless
 *   result:{item:'crafting_table', count:1},  // item = name or id
 *   category:'building', group? }
 * ```
 * Invalid recipes are reported once and skipped — registration never throws.
 *
 * @param {Object} recipe recipe definition
 * @returns {?Recipe} the normalised recipe, or `null` when it was rejected
 */
export function registerRecipe(recipe) {
  if (recipe === null || typeof recipe !== 'object') {
    warnOnce('reg:null', 'registerRecipe() called without a recipe object');
    return null;
  }
  const type = recipe.type === 'shapeless' ? 'shapeless' : 'shaped';

  // -- result ---------------------------------------------------------------
  const rawResult = recipe.result;
  if (rawResult === null || typeof rawResult !== 'object') {
    warnOnce(`reg:res:${recipe.id}`, `recipe "${recipe.id}" has no result`);
    return null;
  }
  const resultItem = typeof rawResult.item === 'number' ? rawResult.item | 0 : id(String(rawResult.item));
  if (resultItem <= 0 || resultItem >= ITEMS.length) {
    warnOnce(`reg:resitem:${rawResult.item}`, `recipe result "${rawResult.item}" is not a known item`);
    return null;
  }
  const maxStack = itemStackSize(resultItem);
  let resultCount = Number.isFinite(rawResult.count) ? rawResult.count | 0 : 1;
  if (resultCount < 1) resultCount = 1;
  if (resultCount > maxStack) {
    warnOnce(`reg:count:${resultItem}`,
      `recipe for "${ITEMS[resultItem].name}" yields ${resultCount} > max stack ${maxStack}, clamped`);
    resultCount = maxStack;
  }

  // -- ingredients ----------------------------------------------------------
  /** @type {Ingredient[]} */
  const ingredients = [];
  /** @type {string[]} */
  let pattern = [];
  /** @type {Object<string, Ingredient>} */
  const key = Object.create(null);
  /** @type {(Ingredient|null)[]} */
  let cells = [];
  /** @type {(Ingredient|null)[]} */
  let cellsMirrored = [];
  let width = 0;
  let height = 0;

  if (type === 'shaped') {
    const rows = Array.isArray(recipe.pattern) ? recipe.pattern : null;
    if (rows === null || rows.length === 0 || rows.length > 3) {
      warnOnce(`reg:pat:${recipe.id}`, `shaped recipe "${recipe.id}" needs 1..3 pattern rows`);
      return null;
    }
    width = rows[0].length;
    height = rows.length;
    if (width < 1 || width > 3) {
      warnOnce(`reg:patw:${recipe.id}`, `shaped recipe "${recipe.id}" has a bad pattern width`);
      return null;
    }
    for (let r = 0; r < rows.length; r++) {
      if (typeof rows[r] !== 'string' || rows[r].length !== width) {
        warnOnce(`reg:patr:${recipe.id}`, `shaped recipe "${recipe.id}" has ragged pattern rows`);
        return null;
      }
    }
    const rawKey = (recipe.key !== null && typeof recipe.key === 'object') ? recipe.key : {};
    for (const ch of Object.keys(rawKey)) {
      const ing = makeIngredient(rawKey[ch]);
      if (ing === null) {
        warnOnce(`reg:key:${recipe.id}:${ch}`,
          `shaped recipe "${recipe.id}" key '${ch}' resolves to nothing`);
        return null;
      }
      key[ch] = ing;
    }
    cells = new Array(width * height).fill(null);
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const ch = rows[r][c];
        if (ch === ' ') continue;
        const ing = key[ch];
        if (ing === undefined) {
          warnOnce(`reg:unkkey:${recipe.id}:${ch}`,
            `shaped recipe "${recipe.id}" uses undefined key '${ch}'`);
          return null;
        }
        cells[r * width + c] = ing;
        ingredients.push(ing);
      }
    }
    if (ingredients.length === 0) {
      warnOnce(`reg:empty:${recipe.id}`, `shaped recipe "${recipe.id}" is empty`);
      return null;
    }
    cellsMirrored = new Array(width * height).fill(null);
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) cellsMirrored[r * width + c] = cells[r * width + (width - 1 - c)];
    }
    pattern = rows.slice();
  } else {
    const list = Array.isArray(recipe.ingredients) ? recipe.ingredients : null;
    if (list === null || list.length === 0 || list.length > 9) {
      warnOnce(`reg:sl:${recipe.id}`, `shapeless recipe "${recipe.id}" needs 1..9 ingredients`);
      return null;
    }
    for (let i = 0; i < list.length; i++) {
      const ing = makeIngredient(list[i]);
      if (ing === null) {
        warnOnce(`reg:sling:${recipe.id}:${i}`,
          `shapeless recipe "${recipe.id}" ingredient ${i} resolves to nothing`);
        return null;
      }
      ingredients.push(ing);
    }
    width = ingredients.length;
    height = 1;
  }

  // -- assemble -------------------------------------------------------------
  const category = CATEGORY_RANK.has(recipe.category) ? recipe.category : RECIPE_CATEGORY.MISC;
  if (!CATEGORY_RANK.has(recipe.category)) {
    warnOnce(`reg:cat:${recipe.category}`,
      `recipe category "${recipe.category}" is unknown, using "misc"`);
  }
  const baseId = typeof recipe.id === 'string' && recipe.id.length > 0
    ? recipe.id
    : ITEMS[resultItem].name;

  /** @type {Recipe} */
  const normalised = {
    id: uniqueId(baseId),
    type,
    pattern,
    key,
    ingredients,
    result: { item: resultItem, count: resultCount },
    category,
    group: typeof recipe.group === 'string' && recipe.group.length > 0
      ? recipe.group
      : ITEMS[resultItem].name,
    display: itemDisplay(resultItem),
    width,
    height,
    cells,
    cellsMirrored,
    requirements: buildRequirements(ingredients)
  };

  RECIPES.push(normalised);
  indexRecipe(normalised);
  invalidateCraftableCache();
  return normalised;
}

/**
 * Shorthand for a shaped recipe.
 * @param {string} resultName item name the recipe produces
 * @param {number} count how many items are produced
 * @param {string[]} pattern 1..3 rows of 1..3 characters
 * @param {Object<string, (string|number|Array<string|number>)>} key pattern legend
 * @param {string} category a {@link RECIPE_CATEGORY} value
 * @param {Object} [opts] `{id, group}` overrides
 * @returns {?Recipe} the registered recipe
 */
function shaped(resultName, count, pattern, key, category, opts = {}) {
  return registerRecipe({
    id: opts.id,
    group: opts.group,
    type: 'shaped',
    pattern,
    key,
    result: { item: resultName, count },
    category
  });
}

/**
 * Shorthand for a shapeless recipe.
 * @param {string} resultName item name the recipe produces
 * @param {number} count how many items are produced
 * @param {Array<string|number|Array<string|number>>} ingredients 1..9 ingredients
 * @param {string} category a {@link RECIPE_CATEGORY} value
 * @param {Object} [opts] `{id, group}` overrides
 * @returns {?Recipe} the registered recipe
 */
function shapeless(resultName, count, ingredients, category, opts = {}) {
  return registerRecipe({
    id: opts.id,
    group: opts.group,
    type: 'shapeless',
    ingredients,
    result: { item: resultName, count },
    category
  });
}

/**
 * Repeat one ingredient `n` times — keeps the bulk recipes readable.
 * @param {(string|number|Array<string|number>)} spec ingredient specification
 * @param {number} n repetition count
 * @returns {Array<string|number|Array<string|number>>} the repeated list
 */
function times(spec, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = spec;
  return out;
}

// ===========================================================================
// RECIPE DEFINITIONS
// ===========================================================================

const B = RECIPE_CATEGORY.BUILDING;
const T = RECIPE_CATEGORY.TOOLS;
const C = RECIPE_CATEGORY.COMBAT;
const R = RECIPE_CATEGORY.REDSTONE;
const F = RECIPE_CATEGORY.FOOD;
const M = RECIPE_CATEGORY.MISC;

// --- wood --------------------------------------------------------------------
for (const wood of WOODS) {
  shapeless(`${wood}_planks`, 4, [`${wood}_log`], B, { group: 'planks' });
}
shaped('stick', 4, ['P', 'P'], { P: '#planks' }, M);
shaped('crafting_table', 1, ['PP', 'PP'], { P: '#planks' }, B);
shaped('chest', 1, ['PPP', 'P P', 'PPP'], { P: '#planks' }, B);
// VOXELIA: only oak has slab/door/fence/stair blocks, so those accept any plank.
shaped('barrel', 1, ['PSP', 'P P', 'PSP'], { P: '#planks', S: 'oak_slab' }, B);
shaped('bookshelf', 1, ['PPP', 'BBB', 'PPP'], { P: '#planks', B: 'book' }, B);
shaped('oak_door', 3, ['PP', 'PP', 'PP'], { P: '#planks' }, B);
shaped('oak_trapdoor', 2, ['PPP', 'PPP'], { P: '#planks' }, B);
shaped('oak_fence', 3, ['PSP', 'PSP'], { P: '#planks', S: 'stick' }, B);
shaped('oak_fence_gate', 1, ['SPS', 'SPS'], { P: '#planks', S: 'stick' }, B);
shaped('oak_stairs', 4, ['P  ', 'PP ', 'PPP'], { P: '#planks' }, B);
shaped('oak_slab', 6, ['PPP'], { P: '#planks' }, B);
shaped('ladder', 3, ['S S', 'SSS', 'S S'], { S: 'stick' }, B);
shaped('bowl', 4, ['P P', ' P '], { P: '#planks' }, M);
// VOXELIA: bamboo scaffolding, string instead of the vanilla bamboo-only shape.
shaped('scaffolding', 6, ['BTB', 'B B', 'B B'], { B: 'bamboo', T: 'string' }, B);
for (const wood of WOODS) {
  shaped(`${wood}_boat`, 1, ['P P', 'PPP'], { P: `${wood}_planks` }, M, { group: 'boat' });
}

// --- stone & masonry ---------------------------------------------------------
shaped('furnace', 1, ['SSS', 'S S', 'SSS'], { S: '#stone_tool_materials' }, B);
shaped('blast_furnace', 1, ['III', 'IFI', 'SSS'],
  { I: 'iron_ingot', F: 'furnace', S: 'smooth_stone' }, B);
shaped('stone_stairs', 4, ['S  ', 'SS ', 'SSS'], { S: 'stone' }, B);
shaped('stone_slab', 6, ['SSS'], { S: 'stone' }, B);
shaped('cobblestone_stairs', 4, ['S  ', 'SS ', 'SSS'], { S: 'cobblestone' }, B);
shaped('cobblestone_slab', 6, ['SSS'], { S: 'cobblestone' }, B);
shaped('stone_bricks', 4, ['SS', 'SS'], { S: 'stone' }, B);
shaped('chiseled_stone_bricks', 1, ['S', 'S'], { S: 'stone_slab' }, B);
shapeless('mossy_cobblestone', 1, ['cobblestone', 'vine'], B);
shapeless('mossy_stone_bricks', 1, ['stone_bricks', 'vine'], B);
shaped('polished_granite', 4, ['SS', 'SS'], { S: 'granite' }, B);
shaped('polished_diorite', 4, ['SS', 'SS'], { S: 'diorite' }, B);
shaped('polished_andesite', 4, ['SS', 'SS'], { S: 'andesite' }, B);
shaped('polished_deepslate', 4, ['SS', 'SS'], { S: 'cobbled_deepslate' }, B);
shaped('deepslate_bricks', 4, ['SS', 'SS'], { S: 'polished_deepslate' }, B);
shaped('deepslate_tiles', 4, ['SS', 'SS'], { S: 'deepslate_bricks' }, B);
shaped('polished_blackstone', 4, ['SS', 'SS'], { S: 'blackstone' }, B);
shaped('bricks', 1, ['BB', 'BB'], { B: 'brick' }, B);
shaped('nether_bricks', 1, ['BB', 'BB'], { B: 'nether_brick' }, B);
shaped('sandstone', 1, ['SS', 'SS'], { S: 'sand' }, B);
shaped('cut_sandstone', 4, ['SS', 'SS'], { S: 'sandstone' }, B);
shaped('red_sandstone', 1, ['SS', 'SS'], { S: 'red_sand' }, B);
shaped('cut_red_sandstone', 4, ['SS', 'SS'], { S: 'red_sandstone' }, B);
shaped('quartz_block', 1, ['QQ', 'QQ'], { Q: 'quartz' }, B);
shaped('quartz_pillar', 2, ['Q', 'Q'], { Q: 'quartz_block' }, B);
// VOXELIA: no quartz slabs exist, so chiseled quartz uses two blocks side by side.
shaped('chiseled_quartz_block', 2, ['QQ'], { Q: 'quartz_block' }, B);
shaped('end_stone_bricks', 4, ['EE', 'EE'], { E: 'end_stone' }, B);
shaped('purpur_block', 4, ['CC', 'CC'], { C: 'chorus_fruit' }, B);
shaped('purpur_pillar', 2, ['P', 'P'], { P: 'purpur_block' }, B);
shaped('prismarine', 1, ['SS', 'SS'], { S: 'prismarine_shard' }, B);
shaped('prismarine_bricks', 1, ['SSS', 'SSS', 'SSS'], { S: 'prismarine_shard' }, B);
shaped('dark_prismarine', 1, ['SSS', 'SDS', 'SSS'],
  { S: 'prismarine_shard', D: 'black_dye' }, B);
shaped('sea_lantern', 1, ['SCS', 'CCC', 'SCS'],
  { S: 'prismarine_shard', C: 'prismarine_crystals' }, B);
shaped('glass_pane', 16, ['GGG', 'GGG'], { G: 'glass' }, B);
shaped('iron_bars', 16, ['III', 'III'], { I: 'iron_ingot' }, B);
shaped('tinted_glass', 2, [' A ', 'AGA', ' A '], { A: 'amethyst_shard', G: 'glass' }, B);
shaped('glowstone', 1, ['DD', 'DD'], { D: 'glowstone_dust' }, B);
shaped('magma_block', 1, ['MM', 'MM'], { M: 'magma_cream' }, B);
shaped('snow_block', 1, ['SS', 'SS'], { S: 'snowball' }, B);
shaped('snow_layer', 6, ['SSS'], { S: 'snow_block' }, B);
shaped('clay', 1, ['CC', 'CC'], { C: 'clay_ball' }, B);
shaped('amethyst_block', 1, ['AA', 'AA'], { A: 'amethyst_shard' }, B);
shaped('moss_carpet', 3, ['MM'], { M: 'moss_block' }, B);

// --- storage blocks ----------------------------------------------------------
shaped('coal_block', 1, ['CCC', 'CCC', 'CCC'], { C: 'coal' }, B);
shaped('iron_block', 1, ['III', 'III', 'III'], { I: 'iron_ingot' }, B);
shaped('gold_block', 1, ['GGG', 'GGG', 'GGG'], { G: 'gold_ingot' }, B);
shaped('diamond_block', 1, ['DDD', 'DDD', 'DDD'], { D: 'diamond' }, B);
shaped('emerald_block', 1, ['EEE', 'EEE', 'EEE'], { E: 'emerald' }, B);
shaped('lapis_block', 1, ['LLL', 'LLL', 'LLL'], { L: 'lapis_lazuli' }, B);
shaped('redstone_block', 1, ['RRR', 'RRR', 'RRR'], { R: 'redstone' }, R);
shaped('copper_block', 1, ['CCC', 'CCC', 'CCC'], { C: 'copper_ingot' }, B);
shaped('raw_iron_block', 1, ['RRR', 'RRR', 'RRR'], { R: 'raw_iron' }, B);
shaped('netherite_block', 1, ['NNN', 'NNN', 'NNN'], { N: 'netherite_ingot' }, B);
shaped('slime_block', 1, ['SSS', 'SSS', 'SSS'], { S: 'slimeball' }, B);
shaped('honey_block', 1, ['HH', 'HH'], { H: 'honey_bottle' }, B);
shaped('hay_block', 1, ['WWW', 'WWW', 'WWW'], { W: 'wheat' }, B);
shaped('cut_copper', 4, ['CC', 'CC'], { C: 'copper_block' }, B);

shapeless('coal', 9, ['coal_block'], M, { id: 'coal_from_block' });
shapeless('iron_ingot', 9, ['iron_block'], M, { id: 'iron_ingot_from_block' });
shapeless('gold_ingot', 9, ['gold_block'], M, { id: 'gold_ingot_from_block' });
shapeless('diamond', 9, ['diamond_block'], M, { id: 'diamond_from_block' });
shapeless('emerald', 9, ['emerald_block'], M, { id: 'emerald_from_block' });
shapeless('lapis_lazuli', 9, ['lapis_block'], M, { id: 'lapis_from_block' });
shapeless('redstone', 9, ['redstone_block'], R, { id: 'redstone_from_block' });
shapeless('copper_ingot', 9, ['copper_block'], M, { id: 'copper_ingot_from_block' });
shapeless('raw_iron', 9, ['raw_iron_block'], M, { id: 'raw_iron_from_block' });
shapeless('netherite_ingot', 9, ['netherite_block'], M, { id: 'netherite_ingot_from_block' });
shapeless('slimeball', 9, ['slime_block'], M, { id: 'slimeball_from_block' });
shapeless('wheat', 9, ['hay_block'], F, { id: 'wheat_from_hay_block' });

shapeless('iron_nugget', 9, ['iron_ingot'], M, { id: 'iron_nugget_from_ingot' });
shapeless('gold_nugget', 9, ['gold_ingot'], M, { id: 'gold_nugget_from_ingot' });
shaped('iron_ingot', 1, ['NNN', 'NNN', 'NNN'], { N: 'iron_nugget' }, M,
  { id: 'iron_ingot_from_nuggets' });
shaped('gold_ingot', 1, ['NNN', 'NNN', 'NNN'], { N: 'gold_nugget' }, M,
  { id: 'gold_ingot_from_nuggets' });
shapeless('netherite_ingot', 1,
  [...times('netherite_scrap', 4), ...times('gold_ingot', 4)], M);

// --- light & decoration ------------------------------------------------------
shaped('torch', 4, ['C', 'S'], { C: '#coals', S: 'stick' }, B);
shaped('soul_torch', 4, ['C', 'S', 'U'],
  { C: '#coals', S: 'stick', U: '#soul_fire_base' }, B);
shaped('lantern', 1, ['NNN', 'NTN', 'NNN'], { N: 'iron_nugget', T: 'torch' }, B);
shaped('soul_lantern', 1, ['NNN', 'NTN', 'NNN'], { N: 'iron_nugget', T: 'soul_torch' }, B);
shaped('campfire', 1, [' S ', 'SCS', 'LLL'],
  { S: 'stick', C: '#coals', L: '#logs' }, B);
shaped('jack_o_lantern', 1, ['P', 'T'], { P: 'carved_pumpkin', T: 'torch' }, B);

// --- tools -------------------------------------------------------------------
/** Shaped patterns of the five tool classes. @type {Object<string, string[]>} */
const TOOL_SHAPES = {
  pickaxe: ['MMM', ' S ', ' S '],
  axe: ['MM', 'MS', ' S'],
  shovel: ['M', 'S', 'S'],
  sword: ['M', 'M', 'S'],
  hoe: ['MM', ' S', ' S']
};

/** Tool tier prefix -> head material. @type {Array<[string, string]>} */
const TOOL_TIERS = [
  ['wooden', '#planks'],
  ['stone', '#stone_tool_materials'],
  ['iron', 'iron_ingot'],
  ['golden', 'gold_ingot'],
  ['diamond', 'diamond']
];

for (const [tier, material] of TOOL_TIERS) {
  for (const shape of Object.keys(TOOL_SHAPES)) {
    const category = shape === 'sword' ? C : T;
    shaped(`${tier}_${shape}`, 1, TOOL_SHAPES[shape],
      { M: material, S: 'stick' }, category, { group: shape });
  }
}

// --- armour ------------------------------------------------------------------
/** Shaped patterns of the four armour pieces. @type {Object<string, string[]>} */
const ARMOR_SHAPES = {
  helmet: ['MMM', 'M M'],
  chestplate: ['M M', 'MMM', 'MMM'],
  leggings: ['MMM', 'M M', 'M M'],
  boots: ['M M', 'M M']
};

/** Armour tier prefix -> plate material. @type {Array<[string, string]>} */
const ARMOR_TIERS = [
  ['leather', 'leather'],
  // VOXELIA: chainmail is not craftable in vanilla; here it costs iron nuggets.
  ['chainmail', 'iron_nugget'],
  ['iron', 'iron_ingot'],
  ['golden', 'gold_ingot'],
  ['diamond', 'diamond']
];

for (const [tier, material] of ARMOR_TIERS) {
  for (const piece of Object.keys(ARMOR_SHAPES)) {
    shaped(`${tier}_${piece}`, 1, ARMOR_SHAPES[piece], { M: material }, C, { group: piece });
  }
}

// VOXELIA: no smithing table — netherite gear is a shapeless in-grid upgrade.
for (const piece of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']) {
  shapeless(`netherite_${piece}`, 1, [`diamond_${piece}`, 'netherite_ingot'],
    piece === 'sword' ? C : T, { id: `netherite_${piece}_upgrade`, group: piece });
}
for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
  shapeless(`netherite_${piece}`, 1, [`diamond_${piece}`, 'netherite_ingot'], C,
    { id: `netherite_${piece}_upgrade`, group: piece });
}

// --- combat ------------------------------------------------------------------
shaped('bow', 1, [' SR', 'S R', ' SR'], { S: 'stick', R: 'string' }, C);
// VOXELIA: no tripwire hook — the crossbow uses a second iron ingot instead.
shaped('crossbow', 1, ['SIS', 'TIT', ' S '],
  { S: 'stick', I: 'iron_ingot', T: 'string' }, C);
shaped('arrow', 4, ['F', 'S', 'E'], { F: 'flint', S: 'stick', E: 'feather' }, C);
shaped('shield', 1, ['PIP', 'PPP', ' P '], { P: '#planks', I: 'iron_ingot' }, C);
shaped('tnt', 1, ['GSG', 'SGS', 'GSG'], { G: 'gunpowder', S: '#sand' }, R);

// --- redstone ----------------------------------------------------------------
shaped('redstone_torch', 1, ['R', 'S'], { R: 'redstone', S: 'stick' }, R);
shaped('redstone_lamp', 1, [' R ', 'RGR', ' R '], { R: 'redstone', G: 'glowstone' }, R);
shaped('lever', 1, ['S', 'C'], { S: 'stick', C: 'cobblestone' }, R);
shapeless('stone_button', 1, ['stone'], R);
shaped('stone_pressure_plate', 1, ['SS'], { S: 'stone' }, R);
shaped('repeater', 1, ['TRT', 'SSS'], { T: 'redstone_torch', R: 'redstone', S: 'stone' }, R);
shaped('comparator', 1, [' T ', 'TQT', 'SSS'],
  { T: 'redstone_torch', Q: 'quartz', S: 'stone' }, R);
shaped('piston', 1, ['PPP', 'CIC', 'CRC'],
  { P: '#planks', C: 'cobblestone', I: 'iron_ingot', R: 'redstone' }, R);
shapeless('sticky_piston', 1, ['piston', 'slimeball'], R);
shaped('observer', 1, ['CCC', 'RRQ', 'CCC'],
  { C: 'cobblestone', R: 'redstone', Q: 'quartz' }, R);
shaped('dispenser', 1, ['CCC', 'CBC', 'CRC'],
  { C: 'cobblestone', B: 'bow', R: 'redstone' }, R);
shaped('hopper', 1, ['I I', 'ICI', ' I '], { I: 'iron_ingot', C: 'chest' }, R);
shaped('rail', 16, ['I I', 'ISI', 'I I'], { I: 'iron_ingot', S: 'stick' }, R);
shaped('powered_rail', 6, ['G G', 'GSG', 'GRG'],
  { G: 'gold_ingot', S: 'stick', R: 'redstone' }, R);
shaped('note_block', 1, ['PPP', 'PRP', 'PPP'], { P: '#planks', R: 'redstone' }, R);
shaped('jukebox', 1, ['PPP', 'PDP', 'PPP'], { P: '#planks', D: 'diamond' }, R);

// --- utility -----------------------------------------------------------------
shaped('bucket', 1, ['I I', ' I '], { I: 'iron_ingot' }, T);
shaped('shears', 1, [' I', 'I '], { I: 'iron_ingot' }, T);
shapeless('flint_and_steel', 1, ['iron_ingot', 'flint'], T);
shaped('fishing_rod', 1, ['  S', ' SR', 'S R'], { S: 'stick', R: 'string' }, T);
shaped('compass', 1, [' I ', 'IRI', ' I '], { I: 'iron_ingot', R: 'redstone' }, T);
shaped('clock', 1, [' G ', 'GRG', ' G '], { G: 'gold_ingot', R: 'redstone' }, T);
shaped('map', 1, ['PPP', 'PCP', 'PPP'], { P: 'paper', C: 'compass' }, T);
shaped('paper', 3, ['SSS'], { S: 'sugar_cane' }, M);
shapeless('book', 1, [...times('paper', 3), 'leather'], M);
shaped('glass_bottle', 3, ['G G', ' G '], { G: 'glass' }, M);
shaped('minecart', 1, ['I I', 'III'], { I: 'iron_ingot' }, T);
shaped('anvil', 1, ['BBB', ' I ', 'III'], { B: 'iron_block', I: 'iron_ingot' }, T);
shaped('enchanting_table', 1, [' B ', 'DOD', 'OOO'],
  { B: 'book', D: 'diamond', O: 'obsidian' }, T);
shaped('brewing_stand', 1, [' B ', 'CCC'],
  { B: 'blaze_rod', C: '#stone_tool_materials' }, T);
shaped('cauldron', 1, ['I I', 'I I', 'III'], { I: 'iron_ingot' }, T);
// VOXELIA: no nether star — the beacon core is a netherite ingot instead.
shaped('beacon', 1, ['GGG', 'GNG', 'OOO'],
  { G: 'glass', N: 'netherite_ingot', O: 'obsidian' }, T);
shapeless('blaze_powder', 2, ['blaze_rod'], M);
shapeless('magma_cream', 1, ['blaze_powder', 'slimeball'], M);
shapeless('ender_eye', 1, ['ender_pearl', 'blaze_powder'], M);
shapeless('sugar', 1, ['sugar_cane'], F);
shapeless('bone_meal', 3, ['bone'], M);

// --- food --------------------------------------------------------------------
shaped('bread', 1, ['WWW'], { W: 'wheat' }, F);
// VOXELIA: no cocoa beans — cookies are sweetened with sugar.
shaped('cookie', 8, ['WSW'], { W: 'wheat', S: 'sugar' }, F);
shaped('cake', 1, ['MMM', 'SES', 'WWW'],
  { M: 'milk_bucket', S: 'sugar', E: 'egg', W: 'wheat' }, F);
shapeless('pumpkin_pie', 1, ['pumpkin', 'sugar', 'egg'], F);
shapeless('mushroom_stew', 1, ['brown_mushroom', 'red_mushroom', 'bowl'], F);
shapeless('rabbit_stew', 1,
  ['cooked_rabbit', 'carrot', 'baked_potato', 'brown_mushroom', 'bowl'], F);
shapeless('beetroot_soup', 1, [...times('beetroot', 6), 'bowl'], F);
shaped('golden_apple', 1, ['GGG', 'GAG', 'GGG'], { G: 'gold_ingot', A: 'apple' }, F);
shaped('enchanted_golden_apple', 1, ['GGG', 'GAG', 'GGG'],
  { G: 'gold_block', A: 'apple' }, F);
shaped('golden_carrot', 1, ['NNN', 'NCN', 'NNN'], { N: 'gold_nugget', C: 'carrot' }, F);
shaped('melon', 1, ['SSS', 'SSS', 'SSS'], { S: 'melon_slice' }, F);
shapeless('melon_seeds', 1, ['melon_slice'], F);
shapeless('pumpkin_seeds', 4, ['pumpkin'], F);

// --- dyes --------------------------------------------------------------------
shapeless('white_dye', 1, ['bone_meal'], M, { group: 'dye' });
shapeless('black_dye', 1, ['ink_sac'], M, { group: 'dye' });
shapeless('red_dye', 1, ['poppy'], M, { group: 'dye' });
shapeless('red_dye', 1, ['beetroot'], M, { id: 'red_dye_from_beetroot', group: 'dye' });
shapeless('yellow_dye', 1, ['dandelion'], M, { group: 'dye' });
shapeless('yellow_dye', 2, ['sunflower'], M, { id: 'yellow_dye_from_sunflower', group: 'dye' });
shapeless('blue_dye', 1, ['cornflower'], M, { group: 'dye' });
shapeless('blue_dye', 1, ['lapis_lazuli'], M, { id: 'blue_dye_from_lapis', group: 'dye' });
shapeless('light_blue_dye', 1, ['blue_orchid'], M, { group: 'dye' });
shapeless('light_blue_dye', 2, ['blue_dye', 'white_dye'], M,
  { id: 'light_blue_dye_from_mix', group: 'dye' });
shapeless('magenta_dye', 1, ['allium'], M, { group: 'dye' });
shapeless('magenta_dye', 2, ['purple_dye', 'pink_dye'], M,
  { id: 'magenta_dye_from_mix', group: 'dye' });
shapeless('light_gray_dye', 1, ['oxeye_daisy'], M, { group: 'dye' });
shapeless('light_gray_dye', 2, ['gray_dye', 'white_dye'], M,
  { id: 'light_gray_dye_from_mix', group: 'dye' });
shapeless('gray_dye', 2, ['black_dye', 'white_dye'], M, { group: 'dye' });
shapeless('orange_dye', 2, ['red_dye', 'yellow_dye'], M, { group: 'dye' });
shapeless('lime_dye', 2, ['green_dye', 'white_dye'], M, { group: 'dye' });
shapeless('pink_dye', 2, ['red_dye', 'white_dye'], M, { group: 'dye' });
shapeless('purple_dye', 2, ['red_dye', 'blue_dye'], M, { group: 'dye' });
shapeless('cyan_dye', 2, ['green_dye', 'blue_dye'], M, { group: 'dye' });
// VOXELIA: no cocoa beans — brown dye comes from a brown mushroom.
shapeless('brown_dye', 1, ['brown_mushroom'], M, { group: 'dye' });

// --- wool, concrete, terracotta ---------------------------------------------
shaped('white_wool', 1, ['SS', 'SS'], { S: 'string' }, B, { id: 'white_wool_from_string' });
for (const color of COLORS) {
  shapeless(`${color}_wool`, 1, ['#wool', `${color}_dye`], B,
    { id: `${color}_wool_from_dye`, group: 'wool' });
  // VOXELIA: no concrete powder block — sand + gravel + dye yields concrete directly.
  shapeless(`${color}_concrete`, 8,
    [...times('#sand', 4), ...times('gravel', 4), `${color}_dye`], B,
    { group: 'concrete' });
}
for (const color of TERRACOTTA_COLORS) {
  shaped(`${color}_terracotta`, 8, ['TTT', 'TDT', 'TTT'],
    { T: 'terracotta', D: `${color}_dye` }, B, { group: 'terracotta' });
}

// ===========================================================================
// SMELTING
// ===========================================================================

/**
 * Furnace recipes: input item id -> `{result, xp, time}`.
 * `time` is in game ticks at 20 TPS (200 = 10 s); blast furnaces and smokers
 * halve it through {@link Container#speed} in `game/inventory.js`.
 * @type {Map<number, {result:number, xp:number, time:number}>}
 */
export const SMELTING = new Map();

/**
 * Register one furnace recipe.
 * @param {string} inputName input item name
 * @param {string} resultName smelted item name
 * @param {number} xp experience awarded per smelted item
 * @param {number} [time] cook time in ticks
 * @returns {void}
 */
function smelt(inputName, resultName, xp, time = 200) {
  const input = id(inputName);
  const result = id(resultName);
  if (input === 0 || result === 0) return;
  if (SMELTING.has(input)) {
    warnOnce(`smelt:${inputName}`, `duplicate smelting recipe for "${inputName}"`);
    return;
  }
  SMELTING.set(input, { result, xp, time });
}

// Ores and raw metals.
smelt('coal_ore', 'coal', 0.1);
smelt('deepslate_coal_ore', 'coal', 0.1);
smelt('iron_ore', 'iron_ingot', 0.7);
smelt('deepslate_iron_ore', 'iron_ingot', 0.7);
smelt('raw_iron', 'iron_ingot', 0.7);
smelt('copper_ore', 'copper_ingot', 0.7);
smelt('deepslate_copper_ore', 'copper_ingot', 0.7);
smelt('raw_copper', 'copper_ingot', 0.7);
smelt('gold_ore', 'gold_ingot', 1.0);
smelt('deepslate_gold_ore', 'gold_ingot', 1.0);
smelt('raw_gold', 'gold_ingot', 1.0);
smelt('redstone_ore', 'redstone', 0.7);
smelt('deepslate_redstone_ore', 'redstone', 0.7);
smelt('lapis_ore', 'lapis_lazuli', 0.2);
smelt('deepslate_lapis_ore', 'lapis_lazuli', 0.2);
smelt('diamond_ore', 'diamond', 1.0);
smelt('deepslate_diamond_ore', 'diamond', 1.0);
smelt('emerald_ore', 'emerald', 1.0);
smelt('deepslate_emerald_ore', 'emerald', 1.0);
smelt('ancient_debris', 'netherite_scrap', 2.0);

// Blocks.
smelt('sand', 'glass', 0.1);
smelt('red_sand', 'glass', 0.1);
smelt('cobblestone', 'stone', 0.1);
smelt('stone', 'smooth_stone', 0.1);
smelt('cobbled_deepslate', 'deepslate', 0.1);
smelt('sandstone', 'smooth_sandstone', 0.1);
smelt('red_sandstone', 'smooth_red_sandstone', 0.1);
smelt('stone_bricks', 'cracked_stone_bricks', 0.1);
smelt('clay', 'terracotta', 0.35);
smelt('clay_ball', 'brick', 0.3);
smelt('netherrack', 'nether_brick', 0.1);
smelt('wet_sponge', 'sponge', 0.15);
smelt('cactus', 'green_dye', 1.0);
smelt('kelp', 'dried_kelp', 0.1);
smelt('white_terracotta', 'white_glazed_terracotta', 0.1);
smelt('cyan_terracotta', 'cyan_glazed_terracotta', 0.1);
for (const wood of WOODS) smelt(`${wood}_log`, 'charcoal', 0.15);

// Food.
smelt('beef', 'cooked_beef', 0.35);
smelt('porkchop', 'cooked_porkchop', 0.35);
smelt('chicken', 'cooked_chicken', 0.35);
smelt('mutton', 'cooked_mutton', 0.35);
smelt('rabbit', 'cooked_rabbit', 0.35);
smelt('cod', 'cooked_cod', 0.35);
smelt('salmon', 'cooked_salmon', 0.35);
smelt('potato', 'baked_potato', 0.35);

// Recycling worn gear into nuggets, exactly like vanilla.
for (const piece of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']) {
  smelt(`iron_${piece}`, 'iron_nugget', 0.1);
  smelt(`golden_${piece}`, 'gold_nugget', 0.1);
}
for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
  smelt(`iron_${piece}`, 'iron_nugget', 0.1);
  smelt(`golden_${piece}`, 'gold_nugget', 0.1);
  smelt(`chainmail_${piece}`, 'iron_nugget', 0.1);
}

// ===========================================================================
// FUELS
// ===========================================================================

/**
 * Furnace fuels: item id -> burn time in game ticks.
 * Seeded from the `burnTicks` field of every item in `game/items.js`, then
 * pinned to the values the architecture contract mandates.
 * @type {Map<number, number>}
 */
export const FUELS = new Map();

for (let i = 1; i < ITEMS.length; i++) {
  const ticks = ITEMS[i].burnTicks;
  if (ticks > 0) FUELS.set(i, ticks);
}

/**
 * Burn times fixed by ARCHITECTURE.md § 5.33 plus the derived wood values.
 * @type {Array<[string, number]>}
 */
const REQUIRED_FUELS = [
  ['coal', 1600], ['charcoal', 1600], ['coal_block', 16000],
  ['stick', 100], ['lava_bucket', 20000], ['blaze_rod', 2400],
  ['bamboo', 50], ['scaffolding', 400], ['bowl', 100],
  ['oak_door', 200], ['ladder', 300], ['crafting_table', 300],
  ['chest', 300], ['barrel', 300], ['bookshelf', 300], ['note_block', 300],
  ['jukebox', 300], ['oak_fence', 300], ['oak_fence_gate', 300],
  ['oak_trapdoor', 300], ['oak_stairs', 300], ['oak_slab', 150]
];
for (const wood of WOODS) {
  REQUIRED_FUELS.push([`${wood}_log`, 300], [`${wood}_planks`, 300],
    [`${wood}_sapling`, 100], [`${wood}_boat`, 1200]);
}
for (const color of COLORS) REQUIRED_FUELS.push([`${color}_wool`, 100]);
for (const shape of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']) {
  REQUIRED_FUELS.push([`wooden_${shape}`, 200]);
}
for (const [name, ticks] of REQUIRED_FUELS) {
  const itemId = id(name);
  if (itemId !== 0) FUELS.set(itemId, ticks);
}

// ===========================================================================
// LOOKUPS
// ===========================================================================

/**
 * Furnace recipe for an input item.
 * @param {number} itemId item put into the furnace input slot
 * @returns {?{result:number, xp:number, time:number}} the recipe, or `null`
 */
export function smeltResult(itemId) {
  const recipe = SMELTING.get(itemId);
  return recipe === undefined ? null : recipe;
}

/**
 * Burn time of a fuel item.
 * @param {number} itemId candidate fuel
 * @returns {number} burn time in game ticks, `0` when the item does not burn
 */
export function fuelValue(itemId) {
  const ticks = FUELS.get(itemId);
  if (ticks !== undefined) return ticks;
  // Fall back to the item registry so newly added fuels work without a rebuild.
  const fromItem = itemFuel(itemId);
  return fromItem > 0 ? fromItem : 0;
}

/**
 * Every recipe producing an item — powers "how do I make this?" in the UI.
 * @param {number} itemId result item id
 * @returns {Recipe[]} the recipes (a copy; empty when the item is not craftable)
 */
export function recipesFor(itemId) {
  const list = RECIPES_BY_RESULT.get(itemId);
  return list === undefined ? [] : list.slice();
}

/**
 * Look a recipe up by its stable id.
 * @param {string} recipeId recipe id
 * @returns {?Recipe} the recipe, or `null`
 */
export function recipeById(recipeId) {
  const recipe = RECIPE_BY_ID.get(recipeId);
  return recipe === undefined ? null : recipe;
}

// ===========================================================================
// GRID MATCHING
// ===========================================================================

/** Scratch buffer holding the item id of every grid cell. @type {Int32Array} */
let gridIds = new Int32Array(9);
/** Scratch buffer holding the stack size of every grid cell. @type {Int32Array} */
let gridCounts = new Int32Array(9);

/**
 * Grow the grid scratch buffers when a larger crafting grid shows up.
 * @param {number} n required capacity
 * @returns {void}
 */
function ensureGridScratch(n) {
  if (n <= gridIds.length) return;
  let size = gridIds.length;
  while (size < n) size *= 2;
  gridIds = new Int32Array(size);
  gridCounts = new Int32Array(size);
}

/** Item id of the cell most recently read by {@link readCell}. @type {number} */
let cellItemId = 0;
/** Stack size of the cell most recently read by {@link readCell}. @type {number} */
let cellCountOut = 0;

/**
 * Read one grid cell into {@link cellItemId} / {@link cellCountOut}. Accepts
 * `ItemStack|null`, a bare item id, or an `Inventory` (through its `get()`).
 * Writes to module scratch instead of returning an object so `findRecipe`
 * allocates nothing while scanning.
 *
 * @param {(Array<*>|Inventory|Object)} grid the crafting grid
 * @param {number} index absolute index inside `grid`
 * @returns {void}
 */
function readCell(grid, index) {
  cellItemId = 0;
  cellCountOut = 0;
  const cell = typeof grid.get === 'function' ? grid.get(index) : grid[index];
  if (cell === null || cell === undefined) return;
  if (typeof cell === 'number') {
    if (cell > 0) { cellItemId = cell | 0; cellCountOut = 1; }
    return;
  }
  const itemId = Number.isFinite(cell.itemId) ? cell.itemId | 0 : 0;
  const count = Number.isFinite(cell.count) ? cell.count | 0 : 0;
  if (itemId <= 0 || count <= 0) return;
  cellItemId = itemId;
  cellCountOut = count;
}

/** Item -> ingredient assignment scratch for shapeless matching. @type {Int32Array} */
const assignMatch = new Int32Array(9);
/** Visited flags for the shapeless matching. @type {Uint8Array} */
const assignSeen = new Uint8Array(9);
/** Grid item ids taking part in the shapeless matching. @type {Int32Array} */
const assignItems = new Int32Array(9);

/**
 * Kuhn's augmenting-path step: try to give grid item `i` an unused ingredient.
 * @param {number} i index into {@link assignItems}
 * @param {Ingredient[]} ingredients the recipe ingredients
 * @returns {boolean} true when an assignment was found
 */
function tryAssign(i, ingredients) {
  for (let j = 0; j < ingredients.length; j++) {
    if (assignSeen[j] !== 0) continue;
    if (!ingredients[j].set.has(assignItems[i])) continue;
    assignSeen[j] = 1;
    if (assignMatch[j] === -1 || tryAssign(assignMatch[j], ingredients)) {
      assignMatch[j] = i;
      return true;
    }
  }
  return false;
}

/**
 * Do the `n` grid items form exactly the recipe's ingredient multiset?
 * @param {Recipe} recipe shapeless recipe to test
 * @param {number} n number of non-empty grid cells (already in `assignItems`)
 * @returns {boolean} true when every item maps to a distinct ingredient
 */
function matchShapeless(recipe, n) {
  const ingredients = recipe.ingredients;
  if (ingredients.length !== n) return false;
  for (let j = 0; j < n; j++) assignMatch[j] = -1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) assignSeen[j] = 0;
    if (!tryAssign(i, ingredients)) return false;
  }
  return true;
}

/**
 * Compare a trimmed grid against a shaped pattern.
 * @param {(Ingredient|null)[]} cells recipe cells (normal or mirrored)
 * @param {number} rw recipe width
 * @param {number} rh recipe height
 * @param {number} width grid width
 * @param {number} minX left edge of the trimmed area
 * @param {number} minY top edge of the trimmed area
 * @returns {boolean} true when every cell matches
 */
function matchShapedCells(cells, rw, rh, width, minX, minY) {
  for (let r = 0; r < rh; r++) {
    const rowBase = (minY + r) * width + minX;
    for (let c = 0; c < rw; c++) {
      const ing = cells[r * rw + c];
      const itemId = gridIds[rowBase + c];
      if (ing === null) {
        if (itemId !== 0) return false;
      } else if (itemId === 0 || !ing.set.has(itemId)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Result of a successful {@link findRecipe} call.
 *
 * `consumed[i]` is how many items to take out of grid cell `i` for **one**
 * craft (always 0 or 1). `remainders[i]` is the item left behind in that cell
 * — an empty bucket for milk, an empty bottle for honey — or `null`.
 * `maxCrafts` is how often the recipe could be repeated with the current grid,
 * which is what a shift-click craft needs.
 *
 * @typedef {Object} CraftMatch
 * @property {Recipe} recipe the matched recipe
 * @property {ItemStack} result a fresh result stack (safe to keep and mutate)
 * @property {number[]} consumed items to remove per grid cell
 * @property {(ItemStack|null)[]} remainders items handed back per grid cell
 * @property {number} maxCrafts how many times the recipe fits into the grid
 */

/**
 * Find the recipe a crafting grid currently produces.
 *
 * Shaped recipes are matched against the **trimmed** grid (its bounding box)
 * and against the horizontally mirrored pattern, which is exactly what vanilla
 * does — an axe laid out left-handed still crafts. Shapeless recipes compare
 * the grid contents and the ingredient list as multisets.
 *
 * @param {(Array<*>|Inventory)} grid crafting grid: `ItemStack|null` per cell,
 *   bare item ids, or an `Inventory` (read through `get()`)
 * @param {number} width grid width (2 or 3)
 * @param {number} height grid height (2 or 3)
 * @param {number} [offset] index of the first grid cell inside `grid`
 * @returns {?CraftMatch} the match, or `null` when nothing is craftable
 */
export function findRecipe(grid, width, height, offset = 0) {
  if (grid === null || grid === undefined) return null;
  const w = width | 0;
  const h = height | 0;
  if (w <= 0 || h <= 0) return null;
  const cellCount = w * h;
  ensureGridScratch(cellCount);

  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  let filled = 0;
  let rarestId = 0;
  let rarestLen = Infinity;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const index = y * w + x;
      readCell(grid, offset + index);
      gridIds[index] = cellItemId;
      gridCounts[index] = cellCountOut;
      if (cellItemId === 0) continue;
      filled++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const found = RECIPES_BY_INGREDIENT.get(cellItemId);
      const len = found === undefined ? 0 : found.length;
      if (len < rarestLen) { rarestLen = len; rarestId = cellItemId; }
    }
  }
  if (filled === 0) return null;
  // No recipe uses one of the grid items at all -> nothing can match.
  if (rarestLen === 0) return null;

  const candidates = RECIPES_BY_INGREDIENT.get(rarestId);
  if (candidates === undefined) return null;

  const tw = maxX - minX + 1;
  const th = maxY - minY + 1;

  // Collect the non-empty items once; shapeless matching reuses this.
  if (filled <= assignItems.length) {
    let k = 0;
    for (let i = 0; i < cellCount; i++) {
      if (gridIds[i] !== 0) assignItems[k++] = gridIds[i];
    }
  }

  for (let ci = 0; ci < candidates.length; ci++) {
    const recipe = candidates[ci];
    if (recipe.type === 'shaped') {
      if (recipe.width !== tw || recipe.height !== th) continue;
      if (recipe.ingredients.length !== filled) continue;
      if (matchShapedCells(recipe.cells, tw, th, w, minX, minY)
        || matchShapedCells(recipe.cellsMirrored, tw, th, w, minX, minY)) {
        return buildMatch(recipe, cellCount);
      }
    } else {
      if (recipe.ingredients.length !== filled) continue;
      if (filled > assignItems.length) continue;
      if (matchShapeless(recipe, filled)) return buildMatch(recipe, cellCount);
    }
  }
  return null;
}

/**
 * Build the {@link CraftMatch} for a recipe that just matched the scratch grid.
 * @param {Recipe} recipe the matched recipe
 * @param {number} cellCount number of grid cells
 * @returns {CraftMatch} the match description
 */
function buildMatch(recipe, cellCount) {
  /** @type {number[]} */
  const consumed = new Array(cellCount).fill(0);
  /** @type {(ItemStack|null)[]} */
  const remainders = new Array(cellCount).fill(null);
  let maxCrafts = Infinity;
  for (let i = 0; i < cellCount; i++) {
    const itemId = gridIds[i];
    if (itemId === 0) continue;
    consumed[i] = 1;
    if (gridCounts[i] < maxCrafts) maxCrafts = gridCounts[i];
    const back = REMAINDERS.get(itemId);
    if (back !== undefined) remainders[i] = new ItemStack(back, 1, null);
  }
  if (!Number.isFinite(maxCrafts)) maxCrafts = 0;
  return {
    recipe,
    result: new ItemStack(recipe.result.item, recipe.result.count, null),
    consumed,
    remainders,
    maxCrafts
  };
}

/**
 * Apply a {@link CraftMatch} to the inventory that holds the crafting grid:
 * take the ingredients out and put the remainders (buckets, bottles) back.
 *
 * @param {Inventory} inventory inventory containing the grid
 * @param {number} offset slot index of grid cell 0 (e.g. `SLOT.CRAFT_START`)
 * @param {CraftMatch} match the match returned by {@link findRecipe}
 * @param {number} [repeat] how many times to craft (clamped to `maxCrafts`)
 * @returns {{crafted:number, leftovers:ItemStack[]}} how often it crafted and
 *   the remainder stacks that did not fit back into the grid
 */
export function consumeIngredients(inventory, offset, match, repeat = 1) {
  /** @type {ItemStack[]} */
  const leftovers = [];
  if (inventory === null || match === null || match === undefined) {
    return { crafted: 0, leftovers };
  }
  const runs = Math.max(0, Math.min(repeat | 0, match.maxCrafts));
  if (runs === 0) return { crafted: 0, leftovers };

  inventory.beginBatch();
  for (let i = 0; i < match.consumed.length; i++) {
    const take = match.consumed[i] * runs;
    if (take <= 0) continue;
    const slot = offset + i;
    inventory.remove(slot, take);
    const back = match.remainders[i];
    if (back === null) continue;
    const give = new ItemStack(back.itemId, back.count * runs, null);
    const leftover = inventory.addAt(slot, give);
    if (leftover !== null) leftovers.push(leftover);
  }
  inventory.endBatch();
  return { crafted: runs, leftovers };
}

// ===========================================================================
// RECIPE BOOK — craftableFrom
// ===========================================================================

/** Max-flow node capacity currently allocated. @type {number} */
let flowNodes = 64;
/** Residual capacity matrix, row stride `flowNodes`. @type {Int32Array} */
let flowCap = new Int32Array(flowNodes * flowNodes);
/** BFS predecessor per node. @type {Int32Array} */
let flowPrev = new Int32Array(flowNodes);
/** BFS queue. @type {Int32Array} */
let flowQueue = new Int32Array(flowNodes);
/** BFS visited flags. @type {Uint8Array} */
let flowSeen = new Uint8Array(flowNodes);

/**
 * Make sure the max-flow scratch buffers hold at least `n` nodes.
 * @param {number} n required node count
 * @returns {void}
 */
function ensureFlow(n) {
  if (n <= flowNodes) return;
  let size = flowNodes;
  while (size < n) size *= 2;
  flowNodes = size;
  flowCap = new Int32Array(size * size);
  flowPrev = new Int32Array(size);
  flowQueue = new Int32Array(size);
  flowSeen = new Uint8Array(size);
}

/**
 * Edmonds-Karp max flow on the tiny requirement/item graph.
 * @param {number} nodeCount number of nodes in use
 * @param {number} source source node index
 * @param {number} sink sink node index
 * @returns {number} the maximum flow
 */
function maxFlow(nodeCount, source, sink) {
  let total = 0;
  for (;;) {
    for (let i = 0; i < nodeCount; i++) { flowSeen[i] = 0; flowPrev[i] = -1; }
    let head = 0;
    let tail = 0;
    flowQueue[tail++] = source;
    flowSeen[source] = 1;
    while (head < tail) {
      const u = flowQueue[head++];
      const base = u * flowNodes;
      for (let v = 0; v < nodeCount; v++) {
        if (flowSeen[v] !== 0 || flowCap[base + v] <= 0) continue;
        flowSeen[v] = 1;
        flowPrev[v] = u;
        flowQueue[tail++] = v;
      }
    }
    if (flowSeen[sink] === 0) return total;

    let bottleneck = Infinity;
    for (let v = sink; v !== source; v = flowPrev[v]) {
      const u = flowPrev[v];
      if (u < 0) return total;
      const cap = flowCap[u * flowNodes + v];
      if (cap < bottleneck) bottleneck = cap;
    }
    if (!Number.isFinite(bottleneck) || bottleneck <= 0) return total;
    for (let v = sink; v !== source; v = flowPrev[v]) {
      const u = flowPrev[v];
      flowCap[u * flowNodes + v] -= bottleneck;
      flowCap[v * flowNodes + u] += bottleneck;
    }
    total += bottleneck;
  }
}

/** Reused item-id -> flow-node map. @type {Map<number, number>} */
const flowItemNode = new Map();

/**
 * Can the ingredients of a recipe be paid for out of `tally`?
 *
 * Cheap path first: every requirement must have enough matching items on its
 * own. Only when several requirements can draw from the same items does the
 * exact max-flow run — that is what makes "4 planks + 1 slab" correct when the
 * player owns exactly five oak planks and one slab.
 *
 * @param {Recipe} recipe recipe to test
 * @param {Map<number, number>} tally item id -> available count
 * @returns {boolean} true when the recipe can be crafted right now
 */
export function canCraft(recipe, tally) {
  const reqs = recipe.requirements;
  let demand = 0;
  for (let i = 0; i < reqs.length; i++) {
    const req = reqs[i];
    let available = 0;
    for (let k = 0; k < req.ids.length; k++) available += tally.get(req.ids[k]) ?? 0;
    if (available < req.count) return false;
    demand += req.count;
  }
  if (reqs.length <= 1) return true;

  // Build the flow network: source -> requirement -> item -> sink.
  flowItemNode.clear();
  let nodeCount = 1 + reqs.length;
  for (let i = 0; i < reqs.length; i++) {
    const req = reqs[i];
    for (let k = 0; k < req.ids.length; k++) {
      const itemId = req.ids[k];
      if (flowItemNode.has(itemId)) continue;
      if ((tally.get(itemId) ?? 0) <= 0) continue;
      flowItemNode.set(itemId, nodeCount++);
    }
  }
  const sink = nodeCount++;
  ensureFlow(nodeCount);
  flowCap.fill(0, 0, nodeCount * flowNodes);

  for (let i = 0; i < reqs.length; i++) {
    const reqNode = 1 + i;
    flowCap[0 * flowNodes + reqNode] = reqs[i].count;
    const ids = reqs[i].ids;
    for (let k = 0; k < ids.length; k++) {
      const node = flowItemNode.get(ids[k]);
      if (node === undefined) continue;
      flowCap[reqNode * flowNodes + node] = reqs[i].count;
    }
  }
  for (const [itemId, node] of flowItemNode) {
    flowCap[node * flowNodes + sink] = tally.get(itemId) ?? 0;
  }
  return maxFlow(nodeCount, 0, sink) >= demand;
}

/**
 * Normalise any item source into an item id -> count map.
 * @param {(Inventory|Map<number, number>|Array<*>|Object)} source item source
 * @param {Map<number, number>} out map to fill (cleared first)
 * @returns {Map<number, number>} `out`
 */
function tallyOf(source, out) {
  out.clear();
  if (source === null || source === undefined) return out;
  if (source instanceof Map) {
    for (const [k, v] of source) if (v > 0) out.set(k | 0, v);
    return out;
  }
  if (source instanceof Inventory || typeof source.tally === 'function') return source.tally(out);
  const slots = Array.isArray(source) ? source : source.slots;
  if (Array.isArray(slots)) {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s === null || s === undefined) continue;
      const itemId = Number.isFinite(s.itemId) ? s.itemId | 0 : 0;
      const count = Number.isFinite(s.count) ? s.count | 0 : 0;
      if (itemId <= 0 || count <= 0) continue;
      out.set(itemId, (out.get(itemId) ?? 0) + count);
    }
  }
  return out;
}

/**
 * Do the two tallies describe the same inventory contents?
 * @param {Map<number, number>} a first tally
 * @param {Map<number, number>} b second tally
 * @returns {boolean} true when they are equal
 */
function sameTally(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Recipes the given inventory can craft right now — this is the recipe book.
 *
 * Only recipes that use at least one item actually present are considered, and
 * each is verified with {@link canCraft}. The result is sorted by category (in
 * {@link RECIPE_CATEGORIES} order) and then alphabetically by German name, and
 * it is memoised: calling this on every inventory change is cheap because an
 * unchanged item tally returns the previous list.
 *
 * @param {(Inventory|Map<number, number>|Array<*>)} inventory item source
 * @returns {Recipe[]} the craftable recipes (a fresh array, safe to keep)
 */
export function craftableFrom(inventory) {
  tallyOf(inventory, workTally);
  if (cacheValid && sameTally(workTally, cacheTally)) return cacheResult.slice();

  /** @type {Set<Recipe>} */
  const candidates = new Set();
  for (const [itemId, count] of workTally) {
    if (count <= 0) continue;
    const list = RECIPES_BY_INGREDIENT.get(itemId);
    if (list === undefined) continue;
    for (let i = 0; i < list.length; i++) candidates.add(list[i]);
  }

  /** @type {Recipe[]} */
  const out = [];
  for (const recipe of candidates) {
    if (canCraft(recipe, workTally)) out.push(recipe);
  }

  out.sort((a, b) => {
    const ra = CATEGORY_RANK.get(a.category) ?? 99;
    const rb = CATEGORY_RANK.get(b.category) ?? 99;
    if (ra !== rb) return ra - rb;
    const cmp = a.display.localeCompare(b.display, 'de');
    if (cmp !== 0) return cmp;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });

  cacheTally.clear();
  for (const [k, v] of workTally) cacheTally.set(k, v);
  cacheResult = out;
  cacheValid = true;
  return out.slice();
}

/**
 * How many ingredient slots a recipe needs — used by the recipe book to decide
 * whether a recipe fits into the player's 2x2 grid or needs a crafting table.
 * @param {Recipe} recipe recipe to measure
 * @returns {boolean} true when the recipe fits into a 2x2 grid
 */
export function fitsInPlayerGrid(recipe) {
  if (recipe.type === 'shapeless') return recipe.ingredients.length <= 4;
  return recipe.width <= 2 && recipe.height <= 2;
}

// ---------------------------------------------------------------------------
// One-time integrity report. Runs at import time only and never throws.
// ---------------------------------------------------------------------------

{
  /** @type {string[]} */
  const problems = [];
  if (RECIPES.length < 130) problems.push(`only ${RECIPES.length} recipes registered (need >= 130)`);

  // Two recipes must never share the same shape *and* the same ingredient sets,
  // otherwise findRecipe would silently pick whichever was registered first.
  /** @type {Map<string, string>} */
  const shapes = new Map();
  for (const recipe of RECIPES) {
    let key;
    if (recipe.type === 'shaped') {
      const parts = new Array(recipe.cells.length);
      for (let i = 0; i < recipe.cells.length; i++) {
        parts[i] = recipe.cells[i] === null ? '-' : ingredientKey(recipe.cells[i]);
      }
      key = `s${recipe.width}x${recipe.height}:${parts.join('|')}`;
    } else {
      const parts = recipe.ingredients.map(ingredientKey).sort();
      key = `l:${parts.join('|')}`;
    }
    const other = shapes.get(key);
    if (other !== undefined) problems.push(`ambiguous recipes "${other}" and "${recipe.id}"`);
    else shapes.set(key, recipe.id);
  }

  for (const [input, recipe] of SMELTING) {
    if (input <= 0 || input >= ITEMS.length) problems.push(`smelting input ${input} is not an item`);
    if (recipe.result <= 0 || recipe.result >= ITEMS.length) {
      problems.push(`smelting result ${recipe.result} is not an item`);
    }
    if (!(recipe.time > 0)) problems.push(`smelting time for item ${input} is not positive`);
  }
  for (const [itemId, ticks] of FUELS) {
    if (!(ticks > 0)) problems.push(`fuel ${itemId} has a non-positive burn time`);
  }
  if (problems.length) console.warn(`[crafting] registry problems: ${problems.join(' | ')}`);
}
