/**
 * VOXELIA — item registry, tools, armour and food (ARCHITECTURE.md section 5.31).
 *
 * Every other gameplay system indexes into this registry: the inventory stores
 * item ids, crafting produces them, interaction places them, combat reads their
 * damage/armour numbers and the UI draws their icons. The module therefore has
 * to be complete, dense and allocation free on the hot paths.
 *
 * ============================================================================
 * ID LAYOUT
 * ============================================================================
 * Item ids are dense from 0 and assigned in exactly this order:
 *
 *   0                    `air` — the "empty stack" sentinel. Never held.
 *   1 .. BLOCK_ITEM_END  auto-generated block items, in block-id order,
 *                        skipping everything in `NON_ITEM_BLOCKS`.
 *   after that           hand written items: tools, weapons, armour,
 *                        materials, seeds, dyes, food, misc, discs, spawn eggs.
 *
 * Because block items are generated from `world/blocks.js` the two registries
 * can never drift apart. `blockToItem()` / `itemToBlock()` are O(1) typed-array
 * lookups in both directions.
 *
 * ============================================================================
 * TOOL TIERS — READ THIS BEFORE CALLING `toolTier()`
 * ============================================================================
 * `world/blocks.js` owns the tier enum and the two tables derived from it:
 *
 *   TOOL_TIER    NONE 0, WOOD 1, GOLD 2, STONE 3, IRON 4, DIAMOND 5, NETHERITE 6
 *   TIER_SPEED   [1, 2, 12, 4, 6, 8, 9]   mining speed multiplier
 *   TIER_HARVEST [0, 1,  1, 2, 3, 4, 5]   harvest level ("mining level")
 *
 * `toolTier(itemId)` returns the **TOOL_TIER enum value** — that is what
 * `breakTime()`, `canHarvest()` and `blockDrops()` expect, so it can be passed
 * straight through. The familiar "wood 1, stone 2, iron 3, diamond 4,
 * netherite 5, gold 1" numbers are the *harvest levels*; they are available
 * from `toolHarvestLevel(itemId)`. Do not mix the two up: feeding a harvest
 * level into `breakTime()` would make golden tools mine like wooden ones.
 *
 * `toolPower(itemId, blockId)` yields the speed multiplier — 2 / 4 / 6 / 8 / 9
 * for wood / stone / iron / diamond / netherite and 12 for gold — but only when
 * the tool actually matches the block, otherwise 1. The shears and sword
 * special cases mirror `world/blocks.js` exactly so mining times stay
 * consistent between the two modules.
 *
 * ============================================================================
 * ICONS
 * ============================================================================
 * `itemIcon(id)` never touches the GPU. Block items return
 * `{type:'block', blockId}` so the UI can use the renderer's real isometric 3D
 * previews (`render/textures.js#renderBlockIcons`). Everything else returns
 * `{type:'sprite', pattern, colors}` where `pattern` names a drawable shape
 * family and `colors` are the tints for that tier. The UI draws those
 * procedurally on a 2D canvas — no external assets, ever.
 *
 * All user-facing strings (`display`) are German.
 *
 * @module game/items
 */

import {
  BLOCKS, BLOCK_COUNT, RENDER, TOOL_TIER, TIER_SPEED, TIER_HARVEST,
  getBlock, blockByName
} from '../world/blocks.js';

// ---------------------------------------------------------------------------
// Enums & small constants
// ---------------------------------------------------------------------------

/**
 * Armour slot indices. They match the four armour slots of
 * `game/inventory.js` (`SLOT.ARMOR_START + armorSlot(id)`).
 * @type {{HEAD:number, CHEST:number, LEGS:number, FEET:number, NONE:number}}
 */
export const ARMOR_SLOT = Object.freeze({ HEAD: 0, CHEST: 1, LEGS: 2, FEET: 3, NONE: -1 });

/**
 * Tool classes understood by `world/blocks.js#breakTime`. `null` means the item
 * is not a tool at all.
 * @type {Readonly<string[]>}
 */
export const TOOL_TYPES = Object.freeze(['pickaxe', 'axe', 'shovel', 'sword', 'hoe', 'shears']);

/**
 * Creative-menu / recipe-book categories.
 * @type {{BLOCKS:string, DECORATION:string, REDSTONE:string, TOOLS:string,
 *   COMBAT:string, FOOD:string, MATERIALS:string, MISC:string}}
 */
export const ITEM_CATEGORY = Object.freeze({
  BLOCKS: 'blocks', DECORATION: 'decoration', REDSTONE: 'redstone', TOOLS: 'tools',
  COMBAT: 'combat', FOOD: 'food', MATERIALS: 'materials', MISC: 'misc'
});

/**
 * German labels for `ITEM_CATEGORY`, used by the creative inventory tabs.
 * @type {Object<string, string>}
 */
export const CATEGORY_LABELS = Object.freeze({
  blocks: 'Baublöcke',
  decoration: 'Dekoration',
  redstone: 'Redstone',
  tools: 'Werkzeuge',
  combat: 'Kampf',
  food: 'Nahrung',
  materials: 'Materialien',
  misc: 'Verschiedenes'
});

/**
 * Item rarity, used for the tooltip name colour.
 * @type {{COMMON:string, UNCOMMON:string, RARE:string, EPIC:string}}
 */
export const RARITY = Object.freeze({
  COMMON: 'common', UNCOMMON: 'uncommon', RARE: 'rare', EPIC: 'epic'
});

/** Default time in seconds it takes to eat one food item. @type {number} */
export const DEFAULT_EAT_TIME = 1.6;

// ---------------------------------------------------------------------------
// Typedefs
// ---------------------------------------------------------------------------

/**
 * One status effect granted (or risked) by eating an item.
 * `duration` is in seconds, `amplifier` is 0-based (0 = level I) and `chance`
 * is the probability 0..1 that the effect is applied at all.
 * @typedef {{type:string, duration:number, amplifier:number, chance:number}} ItemEffect
 */

/**
 * Nutrition record returned by {@link foodValue}.
 * `saturation` is the total saturation restored (not the vanilla modifier).
 * `alwaysEdible` items can be eaten with a full hunger bar.
 * @typedef {{hunger:number, saturation:number, eatTime:number,
 *   effects:readonly ItemEffect[], alwaysEdible:boolean, drink:boolean,
 *   container:number}} FoodDef
 */

/**
 * Drawable icon descriptor returned by {@link itemIcon}.
 * @typedef {{type:'block', blockId:number}|
 *   {type:'sprite', pattern:string, colors:readonly string[]}} ItemIcon
 */

/**
 * A single item definition. Every field always exists — no optional properties,
 * so hot code can read them without guards.
 *
 * @typedef {Object} ItemDef
 * @property {number} id dense item id (0 = air / empty)
 * @property {string} name unique snake_case identifier
 * @property {string} display German display name shown in the UI
 * @property {number} maxStack maximum stack size (1..64)
 * @property {number} blockId block represented by a block item, else 0
 * @property {number} placeBlock block placed when the item is used, else 0
 * @property {boolean} isBlock true when the item was generated from a block
 * @property {number} durability maximum durability, 0 = not damageable
 * @property {(string|null)} toolType `'pickaxe'|'axe'|'shovel'|'sword'|'hoe'|'shears'`
 * @property {number} tier a `TOOL_TIER` value (0 when the item is not a tool)
 * @property {number} attackDamage total melee damage in half-hearts (1 = fist)
 * @property {number} attackSpeed attacks per second
 * @property {number} armorSlot an `ARMOR_SLOT` value, `-1` when not armour
 * @property {number} armorPoints armour points granted by the piece
 * @property {number} armorToughness armour toughness of the piece
 * @property {number} knockbackResistance knockback resistance 0..1
 * @property {(FoodDef|null)} food nutrition record, or null
 * @property {number} burnTicks furnace burn time in ticks (0 = not a fuel)
 * @property {ItemIcon} icon frozen icon descriptor
 * @property {string} category an `ITEM_CATEGORY` value
 * @property {string} rarity a `RARITY` value
 * @property {boolean} enchantable can the item receive enchantments?
 * @property {boolean} glint does the item always render with an enchant glint?
 * @property {boolean} offhand can the item be equipped in the off-hand slot?
 * @property {number} repairItem item id of the anvil repair material, else 0
 * @property {(string|null)} spawnMob mob type spawned by a spawn egg
 * @property {(string|null)} musicTrack `game/audio.js` track for music discs
 * @property {(string|null)} dyeColor CSS hex colour of a dye, else null
 * @property {string} tooltip short German flavour/usage line ('' when none)
 */

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

/**
 * Dense item table indexed by item id. `ITEMS[0]` is always the air/empty item.
 * @type {ItemDef[]}
 */
export const ITEMS = [];

/**
 * Item name -> definition. Also holds the alias names registered at the bottom
 * of this file (`raw_beef` -> the `beef` definition, …).
 * @type {Map<string, ItemDef>}
 */
export const ITEM_BY_NAME = new Map();

/**
 * SCREAMING_SNAKE_CASE item constants, same convention as `B.*` in
 * `world/blocks.js`: `I.DIAMOND_PICKAXE === itemByName('diamond_pickaxe').id`.
 * @type {Object<string, number>}
 */
export const I = Object.create(null);

/**
 * Blocks that must never become a held item: air, the fluids, the technical
 * portal blocks, the lit lamp variant, the redstone wire (its item is the
 * `redstone` dust) and every crop growth stage (their items are the seeds).
 * @type {Set<string>}
 */
const NON_ITEM_BLOCKS = new Set([
  'air', 'water', 'lava', 'nether_portal', 'end_portal',
  'lit_redstone_lamp', 'redstone_wire'
]);
for (const crop of ['wheat', 'carrots', 'potatoes', 'beetroot']) {
  for (let s = 0; s < 4; s++) NON_ITEM_BLOCKS.add(`${crop}_stage${s}`);
}

/**
 * Blocks whose *item* is a different, hand written item. Used by
 * {@link blockToItem} so mining a skipped block still resolves to something.
 * @type {Object<string, string>}
 */
const BLOCK_ITEM_ALIAS = Object.freeze({
  lit_redstone_lamp: 'redstone_lamp',
  redstone_wire: 'redstone',
  wheat_stage0: 'wheat_seeds', wheat_stage1: 'wheat_seeds',
  wheat_stage2: 'wheat_seeds', wheat_stage3: 'wheat',
  carrots_stage0: 'carrot', carrots_stage1: 'carrot',
  carrots_stage2: 'carrot', carrots_stage3: 'carrot',
  potatoes_stage0: 'potato', potatoes_stage1: 'potato',
  potatoes_stage2: 'potato', potatoes_stage3: 'potato',
  beetroot_stage0: 'beetroot_seeds', beetroot_stage1: 'beetroot_seeds',
  beetroot_stage2: 'beetroot_seeds', beetroot_stage3: 'beetroot'
});

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------

/**
 * Build a frozen procedural sprite icon descriptor.
 * @param {string} pattern shape family name (see the module header)
 * @param {...string} colors CSS hex tints, most important first
 * @returns {{type:'sprite', pattern:string, colors:readonly string[]}} frozen icon
 */
function sprite(pattern, ...colors) {
  return Object.freeze({ type: 'sprite', pattern, colors: Object.freeze(colors) });
}

/**
 * Build a frozen block-preview icon descriptor.
 * @param {number} blockId block whose 3D preview represents the item
 * @returns {{type:'block', blockId:number}} frozen icon
 */
function blockIcon(blockId) {
  return Object.freeze({ type: 'block', blockId });
}

/** Icon used by the empty/air item. @type {ItemIcon} */
const EMPTY_ICON = sprite('empty');

// ---------------------------------------------------------------------------
// Food helpers
// ---------------------------------------------------------------------------

/**
 * Build one status effect record.
 * @param {string} type effect name, e.g. `'regeneration'`
 * @param {number} duration duration in seconds
 * @param {number} [amplifier] 0-based level (0 = level I)
 * @param {number} [chance] probability 0..1 that the effect applies
 * @returns {ItemEffect} frozen effect record
 */
function fx(type, duration, amplifier = 0, chance = 1) {
  return Object.freeze({ type, duration, amplifier, chance });
}

/**
 * Build one nutrition record.
 * @param {number} hunger hunger points restored (2 = one drumstick)
 * @param {number} saturation total saturation restored
 * @param {Object} [opts] extra options
 * @param {number} [opts.eatTime] seconds needed to consume the item
 * @param {ItemEffect[]} [opts.effects] status effects applied on consumption
 * @param {boolean} [opts.alwaysEdible] edible on a full hunger bar
 * @param {boolean} [opts.drink] drinking animation/sound instead of eating
 * @param {string} [opts.container] item name returned after consumption
 * @returns {Object} raw food record (resolved and frozen by `defineItem`)
 */
function food(hunger, saturation, opts = {}) {
  return {
    hunger,
    saturation,
    eatTime: opts.eatTime ?? DEFAULT_EAT_TIME,
    effects: opts.effects ?? [],
    alwaysEdible: opts.alwaysEdible ?? false,
    drink: opts.drink ?? false,
    container: opts.container ?? null
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Names of repair materials, resolved to ids after registration. @type {string[]} */
const REPAIR_NAMES = [];
/** Names of food container items, resolved after registration. @type {(string|null)[]} */
const CONTAINER_NAMES = [];

/**
 * Register one item. Defaults are chosen so a plain material needs nothing but
 * a name and a German display string.
 *
 * @param {string} name unique snake_case item name
 * @param {string} display German display name
 * @param {Object} [opts] overrides for any `ItemDef` field
 * @returns {number} the freshly assigned item id
 */
function defineItem(name, display, opts = {}) {
  const existing = ITEM_BY_NAME.get(name);
  if (existing !== undefined) {
    console.warn(`[items] duplicate item "${name}" ignored`);
    return existing.id;
  }
  const id = ITEMS.length;
  const blockId = opts.blockId ?? 0;
  const isBlock = opts.isBlock ?? false;
  const durability = opts.durability ?? 0;
  const type = opts.toolType ?? null;
  const slot = opts.armorSlot ?? ARMOR_SLOT.NONE;
  const rawFood = opts.food ?? null;

  /** @type {ItemDef} */
  const def = {
    id,
    name,
    display,
    maxStack: opts.maxStack ?? (durability > 0 ? 1 : 64),
    blockId,
    placeBlock: opts.placeBlock ?? blockId,
    isBlock,
    durability,
    toolType: type,
    tier: opts.tier ?? TOOL_TIER.NONE,
    attackDamage: opts.attackDamage ?? 1,
    attackSpeed: opts.attackSpeed ?? 4,
    armorSlot: slot,
    armorPoints: opts.armorPoints ?? 0,
    armorToughness: opts.armorToughness ?? 0,
    knockbackResistance: opts.knockbackResistance ?? 0,
    food: rawFood === null ? null : Object.freeze({
      hunger: rawFood.hunger,
      saturation: rawFood.saturation,
      eatTime: rawFood.eatTime,
      effects: Object.freeze(rawFood.effects.slice()),
      alwaysEdible: rawFood.alwaysEdible,
      drink: rawFood.drink,
      container: 0
    }),
    burnTicks: opts.burnTicks ?? 0,
    icon: opts.icon ?? EMPTY_ICON,
    category: opts.category ?? ITEM_CATEGORY.MATERIALS,
    rarity: opts.rarity ?? RARITY.COMMON,
    enchantable: opts.enchantable ?? (durability > 0),
    glint: opts.glint ?? false,
    offhand: opts.offhand ?? false,
    repairItem: 0,
    spawnMob: opts.spawnMob ?? null,
    musicTrack: opts.musicTrack ?? null,
    dyeColor: opts.dyeColor ?? null,
    tooltip: opts.tooltip ?? ''
  };

  REPAIR_NAMES.push(opts.repair ?? null);
  CONTAINER_NAMES.push(rawFood === null ? null : rawFood.container);

  ITEMS.push(def);
  ITEM_BY_NAME.set(name, def);
  I[name.toUpperCase()] = id;
  return id;
}

// ---------------------------------------------------------------------------
// German naming tables
// ---------------------------------------------------------------------------

/**
 * The 16 dye colours with their German adjective forms (feminine, masculine,
 * neuter) and the CSS tint used for dye icons and coloured particles.
 * @type {readonly {key:string, f:string, m:string, n:string, noun:string, hex:string}[]}
 */
const COLORS = Object.freeze([
  { key: 'white', f: 'Weiße', m: 'Weißer', n: 'Weißes', noun: 'Weiß', hex: '#f9fffe' },
  { key: 'orange', f: 'Orangene', m: 'Orangener', n: 'Orangenes', noun: 'Orange', hex: '#f9801d' },
  { key: 'magenta', f: 'Magenta', m: 'Magenta', n: 'Magenta', noun: 'Magenta', hex: '#c74ebd' },
  { key: 'light_blue', f: 'Hellblaue', m: 'Hellblauer', n: 'Hellblaues', noun: 'Hellblau', hex: '#3ab3da' },
  { key: 'yellow', f: 'Gelbe', m: 'Gelber', n: 'Gelbes', noun: 'Gelb', hex: '#fed83d' },
  { key: 'lime', f: 'Hellgrüne', m: 'Hellgrüner', n: 'Hellgrünes', noun: 'Hellgrün', hex: '#80c71f' },
  { key: 'pink', f: 'Rosa', m: 'Rosa', n: 'Rosa', noun: 'Rosa', hex: '#f38baa' },
  { key: 'gray', f: 'Graue', m: 'Grauer', n: 'Graues', noun: 'Grau', hex: '#474f52' },
  { key: 'light_gray', f: 'Hellgraue', m: 'Hellgrauer', n: 'Hellgraues', noun: 'Hellgrau', hex: '#9d9d97' },
  { key: 'cyan', f: 'Türkise', m: 'Türkiser', n: 'Türkises', noun: 'Türkis', hex: '#169c9c' },
  { key: 'purple', f: 'Violette', m: 'Violetter', n: 'Violettes', noun: 'Violett', hex: '#8932b8' },
  { key: 'blue', f: 'Blaue', m: 'Blauer', n: 'Blaues', noun: 'Blau', hex: '#3c44aa' },
  { key: 'brown', f: 'Braune', m: 'Brauner', n: 'Braunes', noun: 'Braun', hex: '#835432' },
  { key: 'green', f: 'Grüne', m: 'Grüner', n: 'Grünes', noun: 'Grün', hex: '#5e7c16' },
  { key: 'red', f: 'Rote', m: 'Roter', n: 'Rotes', noun: 'Rot', hex: '#b02e26' },
  { key: 'black', f: 'Schwarze', m: 'Schwarzer', n: 'Schwarzes', noun: 'Schwarz', hex: '#1d1d21' }
]);

/**
 * German compounding stem per wood species (`oak` -> `Eichen` -> `Eichenholz`).
 * @type {Object<string, string>}
 */
const WOOD_DE = Object.freeze({
  oak: 'Eichen', spruce: 'Fichten', birch: 'Birken', jungle: 'Tropen',
  acacia: 'Akazien', dark_oak: 'Schwarzeichen', cherry: 'Kirsch'
});

/**
 * German name per wood part, appended to the species stem.
 * @type {Object<string, string>}
 */
const WOOD_PART_DE = Object.freeze({
  log: 'stamm', planks: 'holzbretter', leaves: 'laub', sapling: 'setzling',
  stairs: 'holztreppe', slab: 'holzstufe', door: 'holztür',
  trapdoor: 'holzfalltür', fence: 'zaun', fence_gate: 'zauntor', boat: 'boot'
});

/**
 * Explicit German names for every block that is not part of a generated family.
 * @type {Object<string, string>}
 */
const BLOCK_DE = {
  stone: 'Stein', granite: 'Granit', polished_granite: 'Polierter Granit',
  diorite: 'Diorit', polished_diorite: 'Polierter Diorit',
  andesite: 'Andesit', polished_andesite: 'Polierter Andesit',
  cobblestone: 'Bruchstein', mossy_cobblestone: 'Bemooster Bruchstein',
  smooth_stone: 'Glatter Stein', stone_bricks: 'Steinziegel',
  mossy_stone_bricks: 'Bemooste Steinziegel', cracked_stone_bricks: 'Rissige Steinziegel',
  chiseled_stone_bricks: 'Gemeißelte Steinziegel',
  deepslate: 'Tiefenschiefer', cobbled_deepslate: 'Tiefenschieferbruchstein',
  polished_deepslate: 'Polierter Tiefenschiefer', deepslate_bricks: 'Tiefenschieferziegel',
  deepslate_tiles: 'Tiefenschieferfliesen', tuff: 'Tuffstein', calcite: 'Kalzit',
  dripstone_block: 'Tropfsteinblock', bedrock: 'Grundgestein', bricks: 'Ziegel',
  nether_bricks: 'Netherziegel', blackstone: 'Schwarzstein',
  polished_blackstone: 'Polierter Schwarzstein', basalt: 'Basalt',
  obsidian: 'Obsidian', crying_obsidian: 'Weinender Obsidian',
  netherrack: 'Netherrack', soul_sand: 'Seelensand', soul_soil: 'Seelenerde',
  magma_block: 'Magmablock', glowstone: 'Glowstone', quartz_block: 'Quarzblock',
  quartz_pillar: 'Quarzsäule', chiseled_quartz_block: 'Gemeißelter Quarzblock',
  end_stone: 'Endstein', end_stone_bricks: 'Endsteinziegel',
  purpur_block: 'Purpurblock', purpur_pillar: 'Purpursäule',
  prismarine: 'Prismarin', prismarine_bricks: 'Prismarinziegel',
  dark_prismarine: 'Dunkles Prismarin', sea_lantern: 'Seelaterne',
  amethyst_block: 'Amethystblock', budding_amethyst: 'Knospender Amethyst',
  amethyst_cluster: 'Amethystcluster',
  dirt: 'Erde', coarse_dirt: 'Grobe Erde', podzol: 'Podsol', mycelium: 'Myzel',
  grass_block: 'Grasblock', farmland: 'Ackerboden', dirt_path: 'Trampelpfad',
  mud: 'Schlamm', moss_block: 'Moosblock', moss_carpet: 'Moosteppich',
  sand: 'Sand', red_sand: 'Roter Sand', sandstone: 'Sandstein',
  smooth_sandstone: 'Glatter Sandstein', cut_sandstone: 'Geschnittener Sandstein',
  red_sandstone: 'Roter Sandstein', smooth_red_sandstone: 'Glatter roter Sandstein',
  cut_red_sandstone: 'Geschnittener roter Sandstein',
  gravel: 'Kies', clay: 'Ton', snow_block: 'Schneeblock', snow_layer: 'Schneedecke',
  ice: 'Eis', packed_ice: 'Packeis', blue_ice: 'Blaueis',
  azalea: 'Azalee', glass: 'Glas', tinted_glass: 'Getöntes Glas',
  glass_pane: 'Glasscheibe', iron_bars: 'Eisengitter',
  coal_ore: 'Kohleerz', deepslate_coal_ore: 'Tiefenschiefer-Kohleerz',
  iron_ore: 'Eisenerz', deepslate_iron_ore: 'Tiefenschiefer-Eisenerz',
  copper_ore: 'Kupfererz', deepslate_copper_ore: 'Tiefenschiefer-Kupfererz',
  gold_ore: 'Golderz', deepslate_gold_ore: 'Tiefenschiefer-Golderz',
  redstone_ore: 'Redstone-Erz', deepslate_redstone_ore: 'Tiefenschiefer-Redstone-Erz',
  lapis_ore: 'Lapislazulierz', deepslate_lapis_ore: 'Tiefenschiefer-Lapislazulierz',
  diamond_ore: 'Diamanterz', deepslate_diamond_ore: 'Tiefenschiefer-Diamanterz',
  emerald_ore: 'Smaragderz', deepslate_emerald_ore: 'Tiefenschiefer-Smaragderz',
  ancient_debris: 'Alter Schutt',
  coal_block: 'Kohleblock', iron_block: 'Eisenblock', copper_block: 'Kupferblock',
  oxidized_copper: 'Oxidiertes Kupfer', cut_copper: 'Geschnittenes Kupfer',
  raw_iron_block: 'Roheisenblock', gold_block: 'Goldblock',
  diamond_block: 'Diamantblock', emerald_block: 'Smaragdblock',
  lapis_block: 'Lapislazuliblock', redstone_block: 'Redstone-Block',
  netherite_block: 'Netheritblock',
  crafting_table: 'Werkbank', furnace: 'Ofen', blast_furnace: 'Schmelzofen',
  chest: 'Truhe', barrel: 'Fass', bookshelf: 'Bücherregal',
  note_block: 'Notenblock', jukebox: 'Plattenspieler', tnt: 'TNT',
  dispenser: 'Werfer', piston: 'Kolben', sticky_piston: 'Klebriger Kolben',
  observer: 'Beobachter', hopper: 'Trichter', anvil: 'Amboss',
  enchanting_table: 'Zaubertisch', brewing_stand: 'Braustand', cauldron: 'Kessel',
  beacon: 'Leuchtfeuer', spawner: 'Monsterspawner', end_portal_frame: 'Endportalrahmen',
  torch: 'Fackel', soul_torch: 'Seelenfackel', redstone_torch: 'Redstone-Fackel',
  lantern: 'Laterne', soul_lantern: 'Seelenlaterne', campfire: 'Lagerfeuer',
  redstone_lamp: 'Redstone-Lampe', repeater: 'Redstone-Verstärker',
  comparator: 'Redstone-Komparator', lever: 'Hebel', stone_button: 'Steinknopf',
  stone_pressure_plate: 'Steindruckplatte', rail: 'Schiene',
  powered_rail: 'Antriebsschiene', ladder: 'Leiter', scaffolding: 'Gerüst',
  stone_stairs: 'Steintreppe', stone_slab: 'Steinstufe',
  cobblestone_stairs: 'Bruchsteintreppe', cobblestone_slab: 'Bruchsteinstufe',
  terracotta: 'Terrakotta',
  short_grass: 'Gras', tall_grass: 'Hohes Gras', fern: 'Farn',
  dead_bush: 'Toter Busch', dandelion: 'Löwenzahn', poppy: 'Mohn',
  blue_orchid: 'Blaue Orchidee', allium: 'Zierlauch', cornflower: 'Kornblume',
  oxeye_daisy: 'Margerite', sunflower: 'Sonnenblume',
  brown_mushroom: 'Brauner Pilz', red_mushroom: 'Roter Pilz',
  sugar_cane: 'Zuckerrohr', bamboo: 'Bambus', kelp: 'Seetang',
  seagrass: 'Seegras', vine: 'Ranken', cobweb: 'Spinnennetz', cactus: 'Kaktus',
  pumpkin: 'Kürbis', carved_pumpkin: 'Geschnitzter Kürbis',
  jack_o_lantern: 'Kürbislaterne', melon: 'Melone',
  tube_coral_block: 'Orgelkorallenblock', brain_coral_block: 'Hirnkorallenblock',
  bubble_coral_block: 'Blasenkorallenblock', fire_coral_block: 'Feuerkorallenblock',
  horn_coral_block: 'Geweihkorallenblock',
  sponge: 'Schwamm', wet_sponge: 'Nasser Schwamm', hay_block: 'Heuballen',
  slime_block: 'Schleimblock', honey_block: 'Honigblock'
};

// Generated colour families.
for (const c of COLORS) {
  BLOCK_DE[`${c.key}_wool`] = `${c.f} Wolle`;
  BLOCK_DE[`${c.key}_concrete`] = `${c.m} Beton`;
  BLOCK_DE[`${c.key}_terracotta`] = `${c.f} Terrakotta`;
  BLOCK_DE[`${c.key}_glazed_terracotta`] = `${c.f} glasierte Terrakotta`;
}
// Generated wood families.
for (const species of Object.keys(WOOD_DE)) {
  for (const part of Object.keys(WOOD_PART_DE)) {
    BLOCK_DE[`${species}_${part}`] = WOOD_DE[species] + WOOD_PART_DE[part];
  }
}

/**
 * German display name for a block. Falls back to a title-cased English name and
 * records the miss so the integrity check at the bottom can report it.
 * @param {string} name snake_case block name
 * @returns {string} German display name
 */
function germanBlockName(name) {
  const de = BLOCK_DE[name];
  if (de !== undefined) return de;
  UNTRANSLATED.push(name);
  return name.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

/** Block names without a German translation (should stay empty). @type {string[]} */
const UNTRANSLATED = [];

// ---------------------------------------------------------------------------
// 0. The empty item
// ---------------------------------------------------------------------------

defineItem('air', 'Leer', {
  maxStack: 0, icon: EMPTY_ICON, category: ITEM_CATEGORY.MISC
});

// ---------------------------------------------------------------------------
// 1. Auto-generated block items
// ---------------------------------------------------------------------------

/**
 * Redstone-flavoured blocks that belong in the redstone creative tab.
 * @type {Set<string>}
 */
const REDSTONE_BLOCKS = new Set([
  'redstone_block', 'redstone_lamp', 'redstone_torch', 'repeater', 'comparator',
  'lever', 'stone_button', 'stone_pressure_plate', 'rail', 'powered_rail',
  'piston', 'sticky_piston', 'observer', 'hopper', 'dispenser', 'note_block',
  'tnt', 'oak_door', 'oak_trapdoor', 'oak_fence_gate', 'jukebox'
]);

/**
 * Furnace burn time of a block item, in ticks. Wood burns, stone does not.
 * @param {Object} def block definition from `world/blocks.js`
 * @returns {number} burn time in ticks (0 = not a fuel)
 */
function blockBurnTicks(def) {
  const n = def.name;
  if (n === 'coal_block') return 16000;
  if (n === 'scaffolding') return 400;
  if (n === 'bamboo') return 50;
  if (n === 'ladder') return 300;
  if (n === 'bookshelf' || n === 'crafting_table' || n === 'chest' || n === 'barrel'
    || n === 'jukebox' || n === 'note_block') return 300;
  if (n.endsWith('_door')) return 200;
  if (n.endsWith('_trapdoor')) return 300;
  if (n.endsWith('_slab')) return 150;
  if (n.endsWith('_planks') || n.endsWith('_log') || n.endsWith('_stairs')
    || n.endsWith('_fence') || n.endsWith('_fence_gate')) return 300;
  if (def.sound === 'wool') return 100;
  return 0;
}

/**
 * Creative-tab category for a block item.
 * @param {Object} def block definition from `world/blocks.js`
 * @returns {string} an `ITEM_CATEGORY` value
 */
function blockCategory(def) {
  if (REDSTONE_BLOCKS.has(def.name)) return ITEM_CATEGORY.REDSTONE;
  if (def.emission[0] > 0 || def.emission[1] > 0 || def.emission[2] > 0) {
    return ITEM_CATEGORY.DECORATION;
  }
  if (def.render === RENDER.CROSS || def.render === RENDER.PANE
    || def.render === RENDER.TORCH) return ITEM_CATEGORY.DECORATION;
  if (def.sound === 'wool' || def.name.endsWith('_leaves')) return ITEM_CATEGORY.DECORATION;
  return ITEM_CATEGORY.BLOCKS;
}

/** First block-item id (always 1). @type {number} */
const BLOCK_ITEM_START = ITEMS.length;

for (let b = 0; b < BLOCKS.length; b++) {
  const def = BLOCKS[b];
  if (NON_ITEM_BLOCKS.has(def.name)) continue;
  const stack = Math.min(64, def.maxStack > 0 ? def.maxStack : 64);
  defineItem(def.name, germanBlockName(def.name), {
    maxStack: stack,
    blockId: def.id,
    isBlock: true,
    icon: blockIcon(def.id),
    category: blockCategory(def),
    burnTicks: blockBurnTicks(def),
    rarity: def.name === 'netherite_block' || def.name === 'ancient_debris'
      ? RARITY.UNCOMMON : RARITY.COMMON
  });
}

/** Last block-item id (inclusive). @type {number} */
const BLOCK_ITEM_END = ITEMS.length - 1;

// ---------------------------------------------------------------------------
// 2. Tools — 6 materials x 5 tool types
// ---------------------------------------------------------------------------

/**
 * Tool material descriptors. `damage` is the melee bonus added to the base
 * damage of the tool type; `durability` and the tier enum come from vanilla.
 * @type {readonly {key:string, de:string, tier:number, durability:number,
 *   damage:number, axeDamage:number, axeSpeed:number, hoeSpeed:number,
 *   colors:readonly string[], repair:string}[]}
 */
const TOOL_MATERIALS = Object.freeze([
  {
    key: 'wooden', de: 'Holz', tier: TOOL_TIER.WOOD, durability: 59, damage: 0,
    axeDamage: 7, axeSpeed: 0.8, hoeSpeed: 1,
    colors: Object.freeze(['#9c7a4b', '#6b4a2a']), repair: 'oak_planks'
  },
  {
    key: 'stone', de: 'Stein', tier: TOOL_TIER.STONE, durability: 131, damage: 1,
    axeDamage: 9, axeSpeed: 0.8, hoeSpeed: 2,
    colors: Object.freeze(['#8d8d8d', '#6b4a2a']), repair: 'cobblestone'
  },
  {
    key: 'iron', de: 'Eisen', tier: TOOL_TIER.IRON, durability: 250, damage: 2,
    axeDamage: 9, axeSpeed: 0.9, hoeSpeed: 3,
    colors: Object.freeze(['#d8d8d8', '#6b4a2a']), repair: 'iron_ingot'
  },
  {
    key: 'golden', de: 'Gold', tier: TOOL_TIER.GOLD, durability: 32, damage: 0,
    axeDamage: 7, axeSpeed: 1, hoeSpeed: 4,
    colors: Object.freeze(['#fbe14a', '#6b4a2a']), repair: 'gold_ingot'
  },
  {
    key: 'diamond', de: 'Diamant', tier: TOOL_TIER.DIAMOND, durability: 1561, damage: 3,
    axeDamage: 9, axeSpeed: 1, hoeSpeed: 4,
    colors: Object.freeze(['#4aedd9', '#6b4a2a']), repair: 'diamond'
  },
  {
    key: 'netherite', de: 'Netherit', tier: TOOL_TIER.NETHERITE, durability: 2031, damage: 4,
    axeDamage: 10, axeSpeed: 1, hoeSpeed: 4,
    colors: Object.freeze(['#4a4247', '#6b4a2a']), repair: 'netherite_ingot'
  }
]);

/**
 * Tool type descriptors: German compound suffix, icon pattern and the base
 * melee numbers the material bonus is added to.
 * @type {readonly {key:string, de:string, type:string, pattern:string,
 *   base:number, speed:number}[]}
 */
const TOOL_KINDS = Object.freeze([
  { key: 'pickaxe', de: 'spitzhacke', type: 'pickaxe', pattern: 'pickaxe', base: 2, speed: 1.2 },
  { key: 'axe', de: 'axt', type: 'axe', pattern: 'axe', base: 0, speed: 0 },
  { key: 'shovel', de: 'schaufel', type: 'shovel', pattern: 'shovel', base: 2.5, speed: 1 },
  { key: 'sword', de: 'schwert', type: 'sword', pattern: 'sword', base: 4, speed: 1.6 },
  { key: 'hoe', de: 'hacke', type: 'hoe', pattern: 'hoe', base: 1, speed: 0 }
]);

for (const mat of TOOL_MATERIALS) {
  for (const kind of TOOL_KINDS) {
    let damage;
    let speed;
    if (kind.key === 'axe') {
      damage = mat.axeDamage;
      speed = mat.axeSpeed;
    } else if (kind.key === 'hoe') {
      damage = 1;
      speed = mat.hoeSpeed;
    } else {
      damage = kind.base + mat.damage;
      speed = kind.speed;
    }
    defineItem(`${mat.key}_${kind.key}`, mat.de + kind.de, {
      maxStack: 1,
      durability: mat.durability,
      toolType: kind.type,
      tier: mat.tier,
      attackDamage: damage,
      attackSpeed: speed,
      icon: sprite(kind.pattern, mat.colors[0], mat.colors[1]),
      category: kind.key === 'sword' ? ITEM_CATEGORY.COMBAT : ITEM_CATEGORY.TOOLS,
      repair: mat.repair,
      burnTicks: mat.key === 'wooden' ? 200 : 0,
      rarity: mat.key === 'netherite' ? RARITY.UNCOMMON : RARITY.COMMON,
      tooltip: kind.key === 'sword' ? 'Nahkampfwaffe' : 'Werkzeug'
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Weapons & utility items
// ---------------------------------------------------------------------------

defineItem('bow', 'Bogen', {
  maxStack: 1, durability: 384, attackDamage: 1, attackSpeed: 1,
  icon: sprite('bow', '#8b6a3f', '#dcd3c4'),
  category: ITEM_CATEGORY.COMBAT, repair: 'string',
  burnTicks: 300, tooltip: 'Fernkampfwaffe — gedrückt halten zum Spannen'
});

defineItem('crossbow', 'Armbrust', {
  maxStack: 1, durability: 465, attackDamage: 1, attackSpeed: 1,
  icon: sprite('crossbow', '#8b6a3f', '#b0b0b0'),
  category: ITEM_CATEGORY.COMBAT, repair: 'string',
  burnTicks: 300, tooltip: 'Lädt einen Pfeil und hält ihn bereit'
});

defineItem('arrow', 'Pfeil', {
  maxStack: 64, icon: sprite('arrow', '#8b6a3f', '#d8d8d8', '#f2f2f2'),
  category: ITEM_CATEGORY.COMBAT, tooltip: 'Munition für Bogen und Armbrust'
});

defineItem('shield', 'Schild', {
  maxStack: 1, durability: 336, offhand: true,
  icon: sprite('shield', '#8b6a3f', '#b0b0b0'),
  category: ITEM_CATEGORY.COMBAT, repair: 'oak_planks',
  tooltip: 'Blockt Nahkampf- und Projektilschaden'
});

defineItem('fishing_rod', 'Angel', {
  maxStack: 1, durability: 64, icon: sprite('fishing_rod', '#8b6a3f', '#eeeeee'),
  category: ITEM_CATEGORY.TOOLS, repair: 'string', burnTicks: 300
});

defineItem('flint_and_steel', 'Feuerzeug', {
  maxStack: 1, durability: 64, icon: sprite('flint_and_steel', '#d8d8d8', '#6b6b6b'),
  category: ITEM_CATEGORY.TOOLS, repair: 'iron_ingot',
  tooltip: 'Entzündet Blöcke und TNT'
});

defineItem('shears', 'Schere', {
  maxStack: 1, durability: 238, toolType: 'shears', tier: TOOL_TIER.IRON,
  attackDamage: 1, attackSpeed: 2,
  icon: sprite('shears', '#d8d8d8', '#6b4a2a'),
  category: ITEM_CATEGORY.TOOLS, repair: 'iron_ingot',
  tooltip: 'Erntet Laub, Ranken, Gras und Wolle'
});

defineItem('bucket', 'Eimer', {
  maxStack: 16, icon: sprite('bucket', '#c8c8c8', '#8a8a8a'),
  category: ITEM_CATEGORY.TOOLS, tooltip: 'Nimmt Flüssigkeiten auf'
});

defineItem('water_bucket', 'Wassereimer', {
  maxStack: 1, placeBlock: blockByName('water').id,
  icon: sprite('bucket', '#c8c8c8', '#3b6ede'),
  category: ITEM_CATEGORY.TOOLS, tooltip: 'Platziert eine Wasserquelle'
});

defineItem('lava_bucket', 'Lavaeimer', {
  maxStack: 1, placeBlock: blockByName('lava').id, burnTicks: 20000,
  icon: sprite('bucket', '#c8c8c8', '#e8712a'),
  category: ITEM_CATEGORY.TOOLS, tooltip: 'Platziert eine Lavaquelle — brennt sehr lange'
});

defineItem('milk_bucket', 'Milcheimer', {
  maxStack: 1, icon: sprite('bucket', '#c8c8c8', '#f7f7f7'),
  category: ITEM_CATEGORY.FOOD,
  food: food(0, 0, {
    eatTime: 1.6, drink: true, container: 'bucket',
    alwaysEdible: true, effects: [fx('clear_effects', 0, 0, 1)]
  }),
  tooltip: 'Entfernt alle Statuseffekte'
});

// ---------------------------------------------------------------------------
// 4. Armour — 6 materials x 4 slots
// ---------------------------------------------------------------------------

/**
 * Armour material descriptors. `points`, `durability` and `names` are indexed
 * by `ARMOR_SLOT` (head, chest, legs, feet) and use the vanilla numbers.
 * @type {readonly {key:string, names:readonly string[], points:readonly number[],
 *   durability:readonly number[], toughness:number, knockback:number,
 *   colors:readonly string[], repair:string}[]}
 */
const ARMOR_MATERIALS = Object.freeze([
  {
    key: 'leather',
    names: Object.freeze(['Lederkappe', 'Lederjacke', 'Lederhose', 'Lederstiefel']),
    points: Object.freeze([1, 3, 2, 1]),
    durability: Object.freeze([55, 80, 75, 65]),
    toughness: 0, knockback: 0,
    colors: Object.freeze(['#a06540', '#7a4a2c']), repair: 'leather'
  },
  {
    key: 'chainmail',
    names: Object.freeze(['Kettenhelm', 'Kettenhemd', 'Kettenhose', 'Kettenstiefel']),
    points: Object.freeze([2, 5, 4, 1]),
    durability: Object.freeze([165, 240, 225, 195]),
    toughness: 0, knockback: 0,
    colors: Object.freeze(['#a8a8a8', '#787878']), repair: 'iron_ingot'
  },
  {
    key: 'iron',
    names: Object.freeze(['Eisenhelm', 'Eisenbrustpanzer', 'Eisenhose', 'Eisenstiefel']),
    points: Object.freeze([2, 6, 5, 2]),
    durability: Object.freeze([165, 240, 225, 195]),
    toughness: 0, knockback: 0,
    colors: Object.freeze(['#d8d8d8', '#9a9a9a']), repair: 'iron_ingot'
  },
  {
    key: 'golden',
    names: Object.freeze(['Goldhelm', 'Goldbrustpanzer', 'Goldhose', 'Goldstiefel']),
    points: Object.freeze([2, 5, 3, 1]),
    durability: Object.freeze([77, 112, 105, 91]),
    toughness: 0, knockback: 0,
    colors: Object.freeze(['#fbe14a', '#c9a52c']), repair: 'gold_ingot'
  },
  {
    key: 'diamond',
    names: Object.freeze(['Diamanthelm', 'Diamantbrustpanzer', 'Diamanthose', 'Diamantstiefel']),
    points: Object.freeze([3, 8, 6, 3]),
    durability: Object.freeze([363, 528, 495, 429]),
    toughness: 2, knockback: 0,
    colors: Object.freeze(['#4aedd9', '#2fbfae']), repair: 'diamond'
  },
  {
    key: 'netherite',
    names: Object.freeze(['Netherithelm', 'Netheritbrustpanzer', 'Netherithose', 'Netheritstiefel']),
    points: Object.freeze([3, 8, 6, 3]),
    durability: Object.freeze([407, 592, 555, 481]),
    toughness: 3, knockback: 0.1,
    colors: Object.freeze(['#4a4247', '#7a6a5f']), repair: 'netherite_ingot'
  }
]);

/** English slot suffixes, indexed by `ARMOR_SLOT`. @type {readonly string[]} */
const ARMOR_SUFFIX = Object.freeze(['helmet', 'chestplate', 'leggings', 'boots']);
/** Icon patterns, indexed by `ARMOR_SLOT`. @type {readonly string[]} */
const ARMOR_PATTERN = Object.freeze(['helmet', 'chestplate', 'leggings', 'boots']);

for (const mat of ARMOR_MATERIALS) {
  for (let slot = 0; slot < 4; slot++) {
    defineItem(`${mat.key}_${ARMOR_SUFFIX[slot]}`, mat.names[slot], {
      maxStack: 1,
      durability: mat.durability[slot],
      armorSlot: slot,
      armorPoints: mat.points[slot],
      armorToughness: mat.toughness,
      knockbackResistance: mat.knockback,
      icon: sprite(ARMOR_PATTERN[slot], mat.colors[0], mat.colors[1]),
      category: ITEM_CATEGORY.COMBAT,
      repair: mat.repair,
      rarity: mat.key === 'netherite' ? RARITY.UNCOMMON : RARITY.COMMON,
      tooltip: `Rüstung: ${mat.points[slot]} Rüstungspunkte`
    });
  }
}

// ---------------------------------------------------------------------------
// 5. Materials
// ---------------------------------------------------------------------------

defineItem('stick', 'Stock', {
  icon: sprite('stick', '#8b6a3f'), burnTicks: 100,
  tooltip: 'Griff für fast jedes Werkzeug'
});
defineItem('coal', 'Kohle', {
  icon: sprite('coal', '#2b2b2b'), burnTicks: 1600, tooltip: 'Brennstoff für den Ofen'
});
defineItem('charcoal', 'Holzkohle', {
  icon: sprite('coal', '#3a332e'), burnTicks: 1600, tooltip: 'Brennstoff für den Ofen'
});
defineItem('flint', 'Feuerstein', { icon: sprite('flint', '#4a4a4a') });
defineItem('raw_iron', 'Roheisen', { icon: sprite('ball', '#d8a17a', '#9a6a4a') });
defineItem('raw_copper', 'Rohkupfer', { icon: sprite('ball', '#e07b52', '#a3512f') });
defineItem('raw_gold', 'Rohgold', { icon: sprite('ball', '#f5d24a', '#b28f1c') });
defineItem('iron_ingot', 'Eisenbarren', { icon: sprite('ingot', '#d8d8d8', '#9a9a9a') });
defineItem('copper_ingot', 'Kupferbarren', { icon: sprite('ingot', '#e07b52', '#a3512f') });
defineItem('gold_ingot', 'Goldbarren', { icon: sprite('ingot', '#fbe14a', '#c9a52c') });
defineItem('iron_nugget', 'Eisenklumpen', { icon: sprite('nugget', '#d8d8d8', '#9a9a9a') });
defineItem('gold_nugget', 'Goldklumpen', { icon: sprite('nugget', '#fbe14a', '#c9a52c') });
defineItem('netherite_scrap', 'Netheritstück', {
  icon: sprite('shard', '#7a5c4a', '#4a3a30'), rarity: RARITY.UNCOMMON
});
defineItem('netherite_ingot', 'Netheritbarren', {
  icon: sprite('ingot', '#4a4247', '#7a6a5f'), rarity: RARITY.RARE,
  tooltip: 'Veredelt Diamantausrüstung im Schmiedetisch'
});
defineItem('diamond', 'Diamant', {
  icon: sprite('gem', '#4aedd9', '#2fbfae'), rarity: RARITY.UNCOMMON
});
defineItem('emerald', 'Smaragd', {
  icon: sprite('gem', '#3ec46d', '#1f8a48'), rarity: RARITY.UNCOMMON
});
defineItem('lapis_lazuli', 'Lapislazuli', { icon: sprite('gem', '#1f4fbf', '#12307a') });
defineItem('redstone', 'Redstone', {
  placeBlock: blockByName('redstone_wire').id,
  icon: sprite('dust', '#d42a2a', '#8a1414'),
  category: ITEM_CATEGORY.REDSTONE, tooltip: 'Legt eine Redstone-Leitung'
});
defineItem('quartz', 'Netherquarz', { icon: sprite('gem', '#e8e0d8', '#b8a898') });
defineItem('amethyst_shard', 'Amethystscherbe', { icon: sprite('shard', '#a678e2', '#7a4fbd') });
defineItem('glowstone_dust', 'Glowstonestaub', { icon: sprite('dust', '#f7e58c', '#c9b04a') });
defineItem('prismarine_shard', 'Prismarinscherbe', { icon: sprite('shard', '#8fd3c4', '#4f9c8c') });
defineItem('prismarine_crystals', 'Prismarinkristalle', {
  icon: sprite('shard', '#d8f3e8', '#8fd3c4')
});
defineItem('string', 'Faden', {
  icon: sprite('string', '#e8e8e8'), tooltip: 'Für Bögen, Angeln und Wolle'
});
defineItem('feather', 'Feder', { icon: sprite('feather', '#f2f2f2', '#c8c8c8') });
defineItem('leather', 'Leder', { icon: sprite('leather', '#a06540', '#7a4a2c') });
defineItem('rabbit_hide', 'Kaninchenfell', { icon: sprite('leather', '#c9a06a', '#9a7448') });
defineItem('gunpowder', 'Schwarzpulver', {
  icon: sprite('dust', '#6e6e6e', '#3a3a3a'), tooltip: 'Bestandteil von TNT'
});
defineItem('bone', 'Knochen', { icon: sprite('bone', '#e8e4d8', '#b8b0a0') });
defineItem('bone_meal', 'Knochenmehl', {
  icon: sprite('dust', '#e8e4d8', '#c8c0b0'), category: ITEM_CATEGORY.MISC,
  tooltip: 'Lässt Pflanzen sofort wachsen'
});
defineItem('slimeball', 'Schleimball', { icon: sprite('ball', '#7fc45a', '#4f8c36') });
defineItem('magma_cream', 'Magmacreme', { icon: sprite('ball', '#e8912a', '#8a4a12') });
defineItem('ender_pearl', 'Endperle', {
  maxStack: 16, icon: sprite('ball', '#12b58c', '#0a6a52'),
  rarity: RARITY.UNCOMMON, tooltip: 'Wirf sie, um dich zu teleportieren'
});
defineItem('ender_eye', 'Enderauge', {
  icon: sprite('ball', '#3ecf9e', '#c9a02a'), rarity: RARITY.UNCOMMON
});
defineItem('blaze_rod', 'Lohenrute', {
  icon: sprite('rod', '#f7c44a', '#c98a1c'), burnTicks: 2400, rarity: RARITY.UNCOMMON
});
defineItem('blaze_powder', 'Lohenstaub', { icon: sprite('dust', '#f7c44a', '#c95a1c') });
defineItem('ghast_tear', 'Ghastträne', {
  icon: sprite('gem', '#e8f7f2', '#a8c8c0'), rarity: RARITY.UNCOMMON
});
defineItem('ink_sac', 'Tintenbeutel', { icon: sprite('ball', '#1d1d21', '#000000') });
defineItem('honeycomb', 'Honigwabe', { icon: sprite('shard', '#e8a032', '#b06a12') });
defineItem('clay_ball', 'Tonklumpen', { icon: sprite('ball', '#a0a7b4', '#767c88') });
defineItem('brick', 'Lehmziegel', { icon: sprite('brick', '#a35d4a', '#7a3f30') });
defineItem('nether_brick', 'Netherziegelstein', { icon: sprite('brick', '#442228', '#2a1418') });
defineItem('paper', 'Papier', { icon: sprite('paper', '#f2f2ea', '#d0d0c4') });
defineItem('book', 'Buch', {
  icon: sprite('book', '#a05a30', '#f2f2ea'), category: ITEM_CATEGORY.MISC
});
defineItem('enchanted_book', 'Verzaubertes Buch', {
  maxStack: 1, icon: sprite('book', '#c9a02a', '#f2f2ea'),
  category: ITEM_CATEGORY.MISC, rarity: RARITY.RARE, glint: true,
  tooltip: 'Überträgt seine Verzauberung am Amboss'
});
defineItem('glass_bottle', 'Glasflasche', {
  icon: sprite('bottle', '#cfe8ee', '#8fb4bd'), category: ITEM_CATEGORY.MISC
});
defineItem('bowl', 'Schüssel', {
  icon: sprite('bowl', '#8b6a3f', '#6b4a2a'), burnTicks: 100
});
defineItem('sugar', 'Zucker', { icon: sprite('dust', '#f7f7f7', '#d8d8d8') });
defineItem('wheat', 'Weizen', {
  icon: sprite('wheat', '#d8b84a', '#a8862a'),
  tooltip: 'Grundlage für Brot und Kuchen'
});
defineItem('egg', 'Ei', {
  maxStack: 16, icon: sprite('egg', '#f2e8d8', '#c8b89a'),
  category: ITEM_CATEGORY.MISC, tooltip: 'Kann geworfen werden'
});

// Saplings and seeds ---------------------------------------------------------

for (const species of Object.keys(WOOD_DE)) {
  defineItem(`${species}_sapling`, `${WOOD_DE[species]}setzling`, {
    icon: sprite('sapling', '#4f8c36', '#8b6a3f'),
    category: ITEM_CATEGORY.DECORATION,
    burnTicks: 100,
    tooltip: 'Wächst zu einem Baum heran'
  });
}

defineItem('wheat_seeds', 'Weizensamen', {
  placeBlock: blockByName('wheat_stage0').id,
  icon: sprite('seed', '#8cae4a', '#5f7a2a'),
  category: ITEM_CATEGORY.MISC, tooltip: 'Auf Ackerboden aussäen'
});
defineItem('pumpkin_seeds', 'Kürbiskerne', {
  icon: sprite('seed', '#e8dcae', '#b8a878'),
  category: ITEM_CATEGORY.MISC
});
defineItem('melon_seeds', 'Melonenkerne', {
  icon: sprite('seed', '#dce8ae', '#a8b878'),
  category: ITEM_CATEGORY.MISC
});
defineItem('beetroot_seeds', 'Rote-Bete-Samen', {
  placeBlock: blockByName('beetroot_stage0').id,
  icon: sprite('seed', '#c46a8c', '#8a3a5a'),
  category: ITEM_CATEGORY.MISC, tooltip: 'Auf Ackerboden aussäen'
});

// Dyes ----------------------------------------------------------------------

for (const c of COLORS) {
  defineItem(`${c.key}_dye`, `${c.m} Farbstoff`, {
    icon: sprite('dye', c.hex),
    dyeColor: c.hex,
    category: ITEM_CATEGORY.MATERIALS,
    tooltip: 'Färbt Wolle, Beton und Rüstung'
  });
}

// ---------------------------------------------------------------------------
// 6. Food
// ---------------------------------------------------------------------------

defineItem('apple', 'Apfel', {
  food: food(4, 2.4), icon: sprite('food_round', '#c4342a', '#4f8c36'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('golden_apple', 'Goldener Apfel', {
  food: food(4, 9.6, {
    alwaysEdible: true,
    effects: [fx('regeneration', 5, 1), fx('absorption', 120, 0)]
  }),
  icon: sprite('food_round', '#fbe14a', '#c9a52c'),
  category: ITEM_CATEGORY.FOOD, rarity: RARITY.RARE, glint: true,
  tooltip: 'Regeneration II und Absorption'
});
defineItem('enchanted_golden_apple', 'Verzauberter goldener Apfel', {
  maxStack: 1,
  food: food(4, 9.6, {
    alwaysEdible: true,
    effects: [
      fx('regeneration', 20, 1), fx('absorption', 120, 3),
      fx('resistance', 300, 0), fx('fire_resistance', 300, 0)
    ]
  }),
  icon: sprite('food_round', '#fbe14a', '#c46ae2'),
  category: ITEM_CATEGORY.FOOD, rarity: RARITY.EPIC, glint: true,
  tooltip: 'Regeneration II, Absorption IV, Resistenz und Feuerresistenz'
});
defineItem('bread', 'Brot', {
  food: food(5, 6), icon: sprite('bread', '#c9924a', '#8a5f2a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('beef', 'Rohes Rindfleisch', {
  food: food(3, 1.8), icon: sprite('meat', '#d06a6a', '#a03a3a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('cooked_beef', 'Steak', {
  food: food(8, 12.8), icon: sprite('meat', '#8a4a2a', '#5f2f18'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('porkchop', 'Rohes Schweinefleisch', {
  food: food(3, 1.8), icon: sprite('meat', '#e89a9a', '#b86a6a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('cooked_porkchop', 'Gebratenes Schweinefleisch', {
  food: food(8, 12.8), icon: sprite('meat', '#c9834a', '#8a552a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('chicken', 'Rohes Hühnchen', {
  food: food(2, 1.2, { effects: [fx('hunger', 30, 0, 0.3)] }),
  icon: sprite('meat', '#e8c4a0', '#b8906a'),
  category: ITEM_CATEGORY.FOOD, tooltip: '30 % Risiko auf Hunger'
});
defineItem('cooked_chicken', 'Gebratenes Hühnchen', {
  food: food(6, 7.2), icon: sprite('meat', '#c9924a', '#8a5f2a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('mutton', 'Rohes Hammelfleisch', {
  food: food(2, 1.2), icon: sprite('meat', '#d87a7a', '#a84a4a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('cooked_mutton', 'Gebratenes Hammelfleisch', {
  food: food(6, 9.6), icon: sprite('meat', '#a35a32', '#6f3a1e'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('rabbit', 'Rohes Kaninchen', {
  food: food(3, 1.8), icon: sprite('meat', '#e0938c', '#b0635c'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('cooked_rabbit', 'Gebratenes Kaninchen', {
  food: food(5, 6), icon: sprite('meat', '#b06a42', '#7a4225'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('cod', 'Roher Kabeljau', {
  food: food(2, 0.4), icon: sprite('fish', '#c9b48c', '#8a7a5a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('cooked_cod', 'Gebratener Kabeljau', {
  food: food(5, 6), icon: sprite('fish', '#d8a45a', '#a8742a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('salmon', 'Roher Lachs', {
  food: food(2, 0.4), icon: sprite('fish', '#e07a5a', '#a84a2a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('cooked_salmon', 'Gebratener Lachs', {
  food: food(6, 9.6), icon: sprite('fish', '#d86a3a', '#9a3f1a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('tropical_fish', 'Tropenfisch', {
  food: food(1, 0.2), icon: sprite('fish', '#f0a02a', '#e04a4a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('carrot', 'Karotte', {
  placeBlock: blockByName('carrots_stage0').id,
  food: food(3, 3.6), icon: sprite('carrot', '#e8801d', '#4f8c36'),
  category: ITEM_CATEGORY.FOOD, tooltip: 'Auf Ackerboden pflanzbar'
});
defineItem('golden_carrot', 'Goldene Karotte', {
  food: food(6, 14.4), icon: sprite('carrot', '#fbe14a', '#4f8c36'),
  category: ITEM_CATEGORY.FOOD, rarity: RARITY.UNCOMMON
});
defineItem('potato', 'Kartoffel', {
  placeBlock: blockByName('potatoes_stage0').id,
  food: food(1, 0.6), icon: sprite('potato', '#d8a45a', '#a8742a'),
  category: ITEM_CATEGORY.FOOD, tooltip: 'Auf Ackerboden pflanzbar'
});
defineItem('baked_potato', 'Ofenkartoffel', {
  food: food(5, 6), icon: sprite('potato', '#e0b06a', '#a8742a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('poisonous_potato', 'Giftige Kartoffel', {
  food: food(2, 1.2, { effects: [fx('poison', 5, 0, 0.6)] }),
  icon: sprite('potato', '#8cae4a', '#4f6a2a'),
  category: ITEM_CATEGORY.FOOD, tooltip: '60 % Risiko auf Vergiftung'
});
defineItem('beetroot', 'Rote Bete', {
  food: food(1, 1.2), icon: sprite('food_round', '#a3243a', '#4f8c36'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('melon_slice', 'Melonenscheibe', {
  food: food(2, 1.2), icon: sprite('slice', '#d84a4a', '#4f8c36'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('cookie', 'Keks', {
  food: food(2, 0.4), icon: sprite('cookie', '#c9924a', '#5a3a1a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('cake', 'Kuchen', {
  maxStack: 1, food: food(2, 0.4), icon: sprite('cake', '#f2f2ea', '#d84a4a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('pumpkin_pie', 'Kürbiskuchen', {
  food: food(8, 4.8), icon: sprite('pie', '#e8a032', '#c9924a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('mushroom_stew', 'Pilzsuppe', {
  maxStack: 1, food: food(6, 7.2, { container: 'bowl' }),
  icon: sprite('stew', '#8b6a3f', '#c9924a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('rabbit_stew', 'Kaninchenragout', {
  maxStack: 1, food: food(10, 12, { container: 'bowl' }),
  icon: sprite('stew', '#8b6a3f', '#a35a32'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('beetroot_soup', 'Rote-Bete-Suppe', {
  maxStack: 1, food: food(6, 7.2, { container: 'bowl' }),
  icon: sprite('stew', '#8b6a3f', '#a3243a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('dried_kelp', 'Getrockneter Seetang', {
  food: food(1, 0.6, { eatTime: 0.865 }), icon: sprite('slice', '#3a5a2a', '#24401a'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('sweet_berries', 'Süßbeeren', {
  food: food(2, 0.4), icon: sprite('food_round', '#c4243a', '#7a1424'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('glow_berries', 'Leuchtbeeren', {
  food: food(2, 0.4), icon: sprite('food_round', '#f0a83a', '#b06a12'),
  category: ITEM_CATEGORY.FOOD
});
defineItem('rotten_flesh', 'Verrottetes Fleisch', {
  food: food(4, 0.8, { effects: [fx('hunger', 30, 0, 0.8)] }),
  icon: sprite('meat', '#7a5a3a', '#4a3520'),
  category: ITEM_CATEGORY.FOOD, tooltip: '80 % Risiko auf Hunger'
});
defineItem('spider_eye', 'Spinnenauge', {
  food: food(2, 3.2, { effects: [fx('poison', 4, 0)] }),
  icon: sprite('food_round', '#6a2a2a', '#c4342a'),
  category: ITEM_CATEGORY.FOOD, tooltip: 'Vergiftet beim Verzehr'
});
defineItem('honey_bottle', 'Honigflasche', {
  maxStack: 16,
  food: food(6, 1.2, { drink: true, container: 'glass_bottle', effects: [fx('cure_poison', 0, 0)] }),
  icon: sprite('bottle', '#e8a032', '#b06a12'),
  category: ITEM_CATEGORY.FOOD, tooltip: 'Hebt Vergiftung auf'
});
defineItem('chorus_fruit', 'Chorusfrucht', {
  food: food(4, 2.4, { alwaysEdible: true, effects: [fx('teleport', 0, 0)] }),
  icon: sprite('food_round', '#8a5aa3', '#5a2a7a'),
  category: ITEM_CATEGORY.FOOD, tooltip: 'Teleportiert dich beim Essen'
});

// ---------------------------------------------------------------------------
// 7. Misc & transport
// ---------------------------------------------------------------------------

defineItem('snowball', 'Schneeball', {
  maxStack: 16, icon: sprite('snowball', '#f2fbff', '#c8dbe8'),
  category: ITEM_CATEGORY.COMBAT, tooltip: 'Wirfbar, richtet kaum Schaden an'
});
defineItem('name_tag', 'Namensschild', {
  maxStack: 1, icon: sprite('name_tag', '#d8c8a0', '#8a7a52'),
  category: ITEM_CATEGORY.MISC, rarity: RARITY.UNCOMMON,
  tooltip: 'Benennt ein Wesen dauerhaft'
});
defineItem('saddle', 'Sattel', {
  maxStack: 1, icon: sprite('saddle', '#8a5a32', '#5a3a1a'),
  category: ITEM_CATEGORY.MISC, tooltip: 'Zum Reiten von Pferden'
});
defineItem('compass', 'Kompass', {
  icon: sprite('compass', '#d8d8d8', '#c4342a'),
  category: ITEM_CATEGORY.MISC, tooltip: 'Zeigt zum Weltspawn'
});
defineItem('clock', 'Uhr', {
  icon: sprite('clock', '#fbe14a', '#3c44aa'),
  category: ITEM_CATEGORY.MISC, tooltip: 'Zeigt die Tageszeit'
});
defineItem('map', 'Karte', {
  maxStack: 1, icon: sprite('map', '#f2f2ea', '#8a7a52'),
  category: ITEM_CATEGORY.MISC, tooltip: 'Zeichnet die Umgebung auf'
});
defineItem('minecart', 'Lore', {
  maxStack: 1, icon: sprite('minecart', '#9a9a9a', '#6b6b6b'),
  category: ITEM_CATEGORY.MISC, tooltip: 'Fährt auf Schienen'
});

for (const species of Object.keys(WOOD_DE)) {
  defineItem(`${species}_boat`, `${WOOD_DE[species]}boot`, {
    maxStack: 1, icon: sprite('boat', '#8b6a3f', '#6b4a2a'),
    category: ITEM_CATEGORY.MISC, burnTicks: 1200,
    tooltip: 'Fährt auf Wasser'
  });
}

// ---------------------------------------------------------------------------
// 8. Music discs
// ---------------------------------------------------------------------------

/**
 * Music discs. `track` is the generative track name `game/audio.js` plays when
 * the disc is inserted into a jukebox; `hex` tints the disc icon.
 * @type {readonly {key:string, label:string, track:string, hex:string}[]}
 */
const MUSIC_DISCS = Object.freeze([
  { key: '13', label: '13', track: 'disc_13', hex: '#8a8a8a' },
  { key: 'cat', label: 'Cat', track: 'disc_cat', hex: '#7fc45a' },
  { key: 'blocks', label: 'Blocks', track: 'disc_blocks', hex: '#c9924a' },
  { key: 'chirp', label: 'Chirp', track: 'disc_chirp', hex: '#c4342a' },
  { key: 'far', label: 'Far', track: 'disc_far', hex: '#4f8c36' },
  { key: 'mall', label: 'Mall', track: 'disc_mall', hex: '#3ab3da' },
  { key: 'mellohi', label: 'Mellohi', track: 'disc_mellohi', hex: '#c74ebd' },
  { key: 'stal', label: 'Stal', track: 'disc_stal', hex: '#474f52' },
  { key: 'strad', label: 'Strad', track: 'disc_strad', hex: '#f9801d' },
  { key: 'ward', label: 'Ward', track: 'disc_ward', hex: '#1f8a48' },
  { key: '11', label: '11', track: 'disc_11', hex: '#2b2b2b' },
  { key: 'wait', label: 'Wait', track: 'disc_wait', hex: '#169c9c' },
  { key: 'pigstep', label: 'Pigstep', track: 'disc_pigstep', hex: '#8932b8' }
]);

for (const disc of MUSIC_DISCS) {
  defineItem(`music_disc_${disc.key}`, `Schallplatte ${disc.label}`, {
    maxStack: 1, icon: sprite('disc', disc.hex, '#1d1d21'),
    category: ITEM_CATEGORY.MISC, rarity: RARITY.RARE,
    musicTrack: disc.track, tooltip: 'In den Plattenspieler einlegen'
  });
}

// ---------------------------------------------------------------------------
// 9. Spawn eggs
// ---------------------------------------------------------------------------

/**
 * Spawn eggs, one per mob type of `game/mobs.js#MOB_TYPES`. `base` and `spots`
 * are the two tints the egg icon is drawn with.
 * @type {readonly {mob:string, de:string, base:string, spots:string}[]}
 */
const SPAWN_EGGS = Object.freeze([
  { mob: 'zombie', de: 'Zombie', base: '#00afaf', spots: '#799c65' },
  { mob: 'skeleton', de: 'Skelett', base: '#c1c1c1', spots: '#494949' },
  { mob: 'creeper', de: 'Creeper', base: '#0da70b', spots: '#000000' },
  { mob: 'spider', de: 'Spinne', base: '#342d27', spots: '#a80e0e' },
  { mob: 'enderman', de: 'Enderman', base: '#161616', spots: '#0f8577' },
  { mob: 'witch', de: 'Hexe', base: '#340000', spots: '#51a03e' },
  { mob: 'slime', de: 'Schleim', base: '#51a03e', spots: '#7ebf6e' },
  { mob: 'drowned', de: 'Ertrunkener', base: '#8f8f48', spots: '#799c65' },
  { mob: 'husk', de: 'Wüstenzombie', base: '#7a7a5a', spots: '#e6d78a' },
  { mob: 'pig', de: 'Schwein', base: '#f0a5a2', spots: '#db635f' },
  { mob: 'cow', de: 'Kuh', base: '#443626', spots: '#a1a1a1' },
  { mob: 'sheep', de: 'Schaf', base: '#e7e7e7', spots: '#ffb5b5' },
  { mob: 'chicken', de: 'Huhn', base: '#a1a1a1', spots: '#ff0000' },
  { mob: 'wolf', de: 'Wolf', base: '#d7d3d3', spots: '#ccaa91' },
  { mob: 'cat', de: 'Katze', base: '#efc88e', spots: '#957256' },
  { mob: 'horse', de: 'Pferd', base: '#c09e7d', spots: '#eee500' },
  { mob: 'villager', de: 'Dorfbewohner', base: '#563c33', spots: '#bd8b72' },
  { mob: 'iron_golem', de: 'Eisengolem', base: '#dbc9c3', spots: '#8fa54a' },
  { mob: 'bat', de: 'Fledermaus', base: '#4c3e30', spots: '#0f0f0f' },
  { mob: 'squid', de: 'Tintenfisch', base: '#223b4d', spots: '#708899' },
  { mob: 'fox', de: 'Fuchs', base: '#d5b69f', spots: '#ea9c46' },
  { mob: 'rabbit', de: 'Kaninchen', base: '#995f40', spots: '#734b32' }
]);

for (const egg of SPAWN_EGGS) {
  defineItem(`${egg.mob}_spawn_egg`, `${egg.de}-Spawn-Ei`, {
    maxStack: 64, icon: sprite('spawn_egg', egg.base, egg.spots),
    category: ITEM_CATEGORY.MISC, rarity: RARITY.UNCOMMON,
    spawnMob: egg.mob, tooltip: 'Erschafft ein Wesen dieses Typs'
  });
}

// ---------------------------------------------------------------------------
// Post-processing: aliases, lookup tables, freezing
// ---------------------------------------------------------------------------

/**
 * Alternative names resolved by {@link itemByName}. They point at the very same
 * definition — the registry stays dense and no id is duplicated.
 * @type {Object<string, string>}
 */
const ITEM_ALIASES = Object.freeze({
  raw_beef: 'beef', raw_porkchop: 'porkchop', raw_chicken: 'chicken',
  raw_mutton: 'mutton', raw_rabbit: 'rabbit', raw_cod: 'cod', raw_salmon: 'salmon',
  steak: 'cooked_beef', fish: 'cod',
  lapis: 'lapis_lazuli', nether_quartz: 'quartz', redstone_dust: 'redstone',
  seeds: 'wheat_seeds', hay_bale: 'hay_block', snow: 'snow_layer',
  grass: 'short_grass', boat: 'oak_boat', sapling: 'oak_sapling',
  planks: 'oak_planks', log: 'oak_log', leaves: 'oak_leaves',
  door: 'oak_door', trapdoor: 'oak_trapdoor', fence: 'oak_fence',
  fence_gate: 'oak_fence_gate', wool: 'white_wool', dye: 'white_dye',
  music_disc: 'music_disc_13', empty_bucket: 'bucket'
});

for (const alias of Object.keys(ITEM_ALIASES)) {
  const target = ITEM_BY_NAME.get(ITEM_ALIASES[alias]);
  if (target === undefined) {
    console.warn(`[items] alias "${alias}" points at unknown item "${ITEM_ALIASES[alias]}"`);
    continue;
  }
  if (!ITEM_BY_NAME.has(alias)) ITEM_BY_NAME.set(alias, target);
  const key = alias.toUpperCase();
  if (I[key] === undefined) I[key] = target.id;
}

/**
 * Number of registered items, including the air/empty item at id 0.
 * @type {number}
 */
export const ITEM_COUNT = ITEMS.length;

// Resolve repair materials and food containers now that every name exists.
for (let i = 0; i < ITEM_COUNT; i++) {
  const def = ITEMS[i];
  const repairName = REPAIR_NAMES[i];
  if (repairName) {
    const target = ITEM_BY_NAME.get(repairName);
    if (target !== undefined) def.repairItem = target.id;
    else console.warn(`[items] unknown repair material "${repairName}" for ${def.name}`);
  }
  const containerName = CONTAINER_NAMES[i];
  if (containerName && def.food !== null) {
    const target = ITEM_BY_NAME.get(containerName);
    if (target !== undefined) {
      // `def.food` is frozen, so rebuild it with the resolved container id.
      def.food = Object.freeze({
        hunger: def.food.hunger,
        saturation: def.food.saturation,
        eatTime: def.food.eatTime,
        effects: def.food.effects,
        alwaysEdible: def.food.alwaysEdible,
        drink: def.food.drink,
        container: target.id
      });
    }
  }
}

/** Stack size per item id. @type {Uint8Array} */
const STACK_TABLE = new Uint8Array(ITEM_COUNT);
/** Maximum durability per item id (0 = not damageable). @type {Uint16Array} */
const DURABILITY_TABLE = new Uint16Array(ITEM_COUNT);
/** `TOOL_TIER` value per item id. @type {Uint8Array} */
const TIER_TABLE = new Uint8Array(ITEM_COUNT);
/** Armour slot per item id, offset by 1 so 0 means "no armour". @type {Uint8Array} */
const ARMOR_SLOT_TABLE = new Uint8Array(ITEM_COUNT);
/** Armour points per item id. @type {Uint8Array} */
const ARMOR_POINT_TABLE = new Uint8Array(ITEM_COUNT);
/** Block placed per item id. @type {Int32Array} */
const ITEM_TO_BLOCK = new Int32Array(ITEM_COUNT);
/** Item id per block id. @type {Int32Array} */
const BLOCK_TO_ITEM = new Int32Array(BLOCK_COUNT);

for (let i = 0; i < ITEM_COUNT; i++) {
  const def = ITEMS[i];
  STACK_TABLE[i] = Math.max(0, Math.min(64, def.maxStack | 0));
  DURABILITY_TABLE[i] = Math.max(0, Math.min(65535, def.durability | 0));
  TIER_TABLE[i] = def.tier;
  ARMOR_SLOT_TABLE[i] = def.armorSlot < 0 ? 0 : def.armorSlot + 1;
  ARMOR_POINT_TABLE[i] = def.armorPoints;
  ITEM_TO_BLOCK[i] = def.placeBlock;
  if (def.isBlock) BLOCK_TO_ITEM[def.blockId] = def.id;
  Object.freeze(def);
}

// Blocks without their own item resolve to the hand written substitute.
for (const blockName of Object.keys(BLOCK_ITEM_ALIAS)) {
  const block = blockByName(blockName);
  const item = ITEM_BY_NAME.get(BLOCK_ITEM_ALIAS[blockName]);
  if (block.id !== 0 && item !== undefined) BLOCK_TO_ITEM[block.id] = item.id;
}

Object.freeze(I);
Object.freeze(ITEMS);

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Definition of an item id. Never throws — unknown ids resolve to the empty
 * air item so callers can read fields unguarded.
 * @param {number} id item id
 * @returns {ItemDef} the item definition (air for unknown ids)
 */
export function getItem(id) {
  const def = ITEMS[id];
  return def !== undefined ? def : ITEMS[0];
}

/**
 * Definition for an item name or alias.
 * @param {string} name snake_case item name
 * @returns {ItemDef} the item definition (air for unknown names)
 */
export function itemByName(name) {
  const def = ITEM_BY_NAME.get(name);
  return def !== undefined ? def : ITEMS[0];
}

/**
 * Item id for a name or alias, `0` when unknown.
 * @param {string} name snake_case item name
 * @returns {number} item id
 */
export function itemIdByName(name) {
  const def = ITEM_BY_NAME.get(name);
  return def !== undefined ? def.id : 0;
}

/**
 * German display name of an item.
 * @param {number} id item id
 * @returns {string} localised name
 */
export function itemDisplay(id) {
  return getItem(id).display;
}

/**
 * Short German flavour/usage line for the tooltip, `''` when the item has none.
 * @param {number} id item id
 * @returns {string} tooltip text
 */
export function itemTooltip(id) {
  return getItem(id).tooltip;
}

/**
 * Was the item auto-generated from a block (and can therefore be placed as a
 * full block and drawn with the renderer's 3D preview)?
 * @param {number} id item id
 * @returns {boolean} true for block items
 */
export function isBlockItem(id) {
  const def = ITEMS[id];
  return def !== undefined && def.isBlock;
}

/**
 * Block that using this item places. Covers block items as well as the special
 * placers (seeds -> crops, redstone -> wire, buckets -> fluids).
 * @param {number} id item id
 * @returns {number} block id, `0` (air) when the item places nothing
 */
export function itemToBlock(id) {
  const b = ITEM_TO_BLOCK[id];
  return b === undefined ? 0 : b;
}

/**
 * Item that represents a block in the inventory.
 * @param {number} blockId block id
 * @returns {number} item id, `0` when the block has no item form
 */
export function blockToItem(blockId) {
  const it = BLOCK_TO_ITEM[blockId];
  return it === undefined ? 0 : it;
}

/**
 * Tool class of an item, as understood by `world/blocks.js#breakTime`.
 * @param {number} id item id
 * @returns {(string|null)} `'pickaxe'|'axe'|'shovel'|'sword'|'hoe'|'shears'` or null
 */
export function toolType(id) {
  return getItem(id).toolType;
}

/**
 * Tool tier of an item as a **`TOOL_TIER` enum value** (NONE 0, WOOD 1, GOLD 2,
 * STONE 3, IRON 4, DIAMOND 5, NETHERITE 6). Pass this straight into
 * `breakTime()`, `canHarvest()` and `blockDrops()`. For the human-facing
 * "mining level" use {@link toolHarvestLevel} instead.
 * @param {number} id item id
 * @returns {number} a `TOOL_TIER` value
 */
export function toolTier(id) {
  const t = TIER_TABLE[id];
  return t === undefined ? TOOL_TIER.NONE : t;
}

/**
 * Harvest level ("mining level") of an item: wood 1, gold 1, stone 2, iron 3,
 * diamond 4, netherite 5, non-tools 0. A block only drops when this value is
 * at least the block's own harvest level.
 * @param {number} id item id
 * @returns {number} harvest level 0..5
 */
export function toolHarvestLevel(id) {
  const level = TIER_HARVEST[toolTier(id)];
  return level === undefined ? 0 : level;
}

/**
 * Is `type` an appropriate tool class for the block? Mirrors the private
 * helper in `world/blocks.js`, including the `altTools` list.
 * @param {Object} def block definition
 * @param {(string|null)} type tool class of the held item
 * @returns {boolean} true when the tool matches
 */
function matchesTool(def, type) {
  if (!type) return false;
  if (type === def.toolType) return true;
  return def.altTools !== null && def.altTools.indexOf(type) !== -1;
}

/**
 * Mining speed multiplier of an item against a block, before enchantments.
 * Returns the tier speed (2 wood, 4 stone, 6 iron, 8 diamond, 9 netherite,
 * 12 gold) when the tool matches the block's tool type, otherwise 1. The shears
 * and sword special cases match `world/blocks.js` exactly so both modules agree
 * on mining times.
 *
 * @param {number} itemId held item id
 * @param {number} blockId block being mined
 * @returns {number} speed multiplier (1 = bare hand)
 */
export function toolPower(itemId, blockId) {
  const item = getItem(itemId);
  const type = item.toolType;
  if (type === null) return 1;
  const def = getBlock(blockId);

  if (type === 'shears') {
    if (def.name === 'cobweb' || def.name.endsWith('_leaves')) return 15;
    if (def.sound === 'wool') return 5;
    if (def.render === RENDER.CROSS) return 5;
    return 1;
  }
  if (type === 'sword') {
    if (def.name === 'cobweb') return 15;
    if (def.name === 'bamboo') return 30;
    return 1.5;
  }
  if (!matchesTool(def, type)) return 1;
  const speed = TIER_SPEED[item.tier];
  return speed === undefined ? 1 : speed;
}

/**
 * Will mining `blockId` with `itemId` actually yield drops? Thin convenience
 * wrapper so callers do not have to unpack the tool type and tier themselves.
 * @param {number} itemId held item id (0 = bare hand)
 * @param {number} blockId block being mined
 * @returns {boolean} true when the block drops its items
 */
export function canHarvestWith(itemId, blockId) {
  const def = getBlock(blockId);
  if (def.hardness < 0) return false;
  if (!def.requiresTool) return true;
  const item = getItem(itemId);
  if (!matchesTool(def, item.toolType)) return false;
  return toolHarvestLevel(itemId) >= (TIER_HARVEST[def.toolTier] ?? 0);
}

/**
 * Maximum durability of an item.
 * @param {number} id item id
 * @returns {number} durability points, `0` when the item cannot be damaged
 */
export function itemDurability(id) {
  const d = DURABILITY_TABLE[id];
  return d === undefined ? 0 : d;
}

/**
 * Armour slot an item is worn in.
 * @param {number} id item id
 * @returns {number} an `ARMOR_SLOT` value, `-1` when the item is not armour
 */
export function armorSlot(id) {
  const s = ARMOR_SLOT_TABLE[id];
  return s === undefined || s === 0 ? ARMOR_SLOT.NONE : s - 1;
}

/**
 * Armour points granted by a piece.
 * @param {number} id item id
 * @returns {number} armour points (0 when not armour)
 */
export function armorPoints(id) {
  const p = ARMOR_POINT_TABLE[id];
  return p === undefined ? 0 : p;
}

/**
 * Armour toughness of a piece — reduces how quickly high damage cuts through
 * the armour bar (diamond 2, netherite 3, everything else 0).
 * @param {number} id item id
 * @returns {number} toughness
 */
export function armorToughness(id) {
  return getItem(id).armorToughness;
}

/**
 * Knockback resistance of a piece, 0..1 (netherite armour grants 0.1 each).
 * @param {number} id item id
 * @returns {number} knockback resistance
 */
export function knockbackResistance(id) {
  return getItem(id).knockbackResistance;
}

/**
 * Nutrition record of an item.
 * @param {number} id item id
 * @returns {(FoodDef|null)} frozen food record, or null when inedible
 */
export function foodValue(id) {
  return getItem(id).food;
}

/**
 * Can the item be eaten or drunk at all?
 * @param {number} id item id
 * @returns {boolean} true for food and drinks
 */
export function isFood(id) {
  return getItem(id).food !== null;
}

/**
 * Maximum stack size of an item.
 * @param {number} id item id
 * @returns {number} stack size 1..64 (0 only for the air item)
 */
export function itemStackSize(id) {
  const s = STACK_TABLE[id];
  return s === undefined ? 64 : s;
}

/**
 * Icon descriptor for an item: a real 3D block preview for block items, a
 * procedural sprite for everything else. The returned object is frozen and
 * shared — never mutate it.
 * @param {number} id item id
 * @returns {ItemIcon} frozen icon descriptor
 */
export function itemIcon(id) {
  return getItem(id).icon;
}

/**
 * Total melee damage of an item in half-hearts, including the 1 point of bare
 * fist damage (wooden sword 4, netherite axe 10, plain material 1).
 * @param {number} id item id
 * @returns {number} attack damage
 */
export function attackDamage(id) {
  return getItem(id).attackDamage;
}

/**
 * Attack speed in swings per second (used for the cooldown bar).
 * @param {number} id item id
 * @returns {number} attacks per second
 */
export function attackSpeed(id) {
  return getItem(id).attackSpeed;
}

/**
 * Furnace burn time of an item.
 * @param {number} id item id
 * @returns {number} burn time in ticks, `0` when the item is not a fuel
 */
export function itemFuel(id) {
  return getItem(id).burnTicks;
}

/**
 * Is the item a tool or weapon with a tool class?
 * @param {number} id item id
 * @returns {boolean} true for tools, weapons and shears
 */
export function isTool(id) {
  return getItem(id).toolType !== null;
}

/**
 * Is the item a wearable armour piece?
 * @param {number} id item id
 * @returns {boolean} true for armour
 */
export function isArmor(id) {
  return armorSlot(id) !== ARMOR_SLOT.NONE;
}

/**
 * Creative-tab / recipe-book category of an item.
 * @param {number} id item id
 * @returns {string} an `ITEM_CATEGORY` value
 */
export function itemCategory(id) {
  return getItem(id).category;
}

/**
 * Rarity of an item, used for the tooltip colour.
 * @param {number} id item id
 * @returns {string} a `RARITY` value
 */
export function itemRarity(id) {
  return getItem(id).rarity;
}

/**
 * Anvil repair material for a damageable item.
 * @param {number} id item id
 * @returns {number} item id of the repair material, `0` when not repairable
 */
export function repairMaterial(id) {
  return getItem(id).repairItem;
}

/**
 * Mob type a spawn egg creates.
 * @param {number} id item id
 * @returns {(string|null)} mob type name, or null when the item is not an egg
 */
export function spawnEggMob(id) {
  return getItem(id).spawnMob;
}

/**
 * Generative music track a disc plays in the jukebox.
 * @param {number} id item id
 * @returns {(string|null)} track name for `game/audio.js`, or null
 */
export function musicDiscTrack(id) {
  return getItem(id).musicTrack;
}

/**
 * CSS hex colour of a dye item.
 * @param {number} id item id
 * @returns {(string|null)} colour string, or null when the item is not a dye
 */
export function dyeColor(id) {
  return getItem(id).dyeColor;
}

/**
 * Can the item be held in the off-hand slot?
 * @param {number} id item id
 * @returns {boolean} true for shields and other off-hand items
 */
export function isOffhandItem(id) {
  return getItem(id).offhand;
}

/**
 * Every item id of one category, ordered by id. Allocates — call it once when
 * the creative inventory is built, never per frame.
 * @param {string} category an `ITEM_CATEGORY` value
 * @returns {number[]} matching item ids
 */
export function itemsInCategory(category) {
  const out = [];
  for (let i = 1; i < ITEM_COUNT; i++) {
    if (ITEMS[i].category === category) out.push(i);
  }
  return out;
}

/**
 * Id range of the auto-generated block items, useful for the creative menu.
 * @returns {{start:number, end:number, count:number}} inclusive id range
 */
export function blockItemRange() {
  return { start: BLOCK_ITEM_START, end: BLOCK_ITEM_END, count: BLOCK_ITEM_END - BLOCK_ITEM_START + 1 };
}

// ---------------------------------------------------------------------------
// One-time integrity report. Runs at import time only and never throws.
// ---------------------------------------------------------------------------

{
  const problems = [];
  if (ITEMS[0].name !== 'air') problems.push('item 0 is not air');
  for (let i = 0; i < ITEM_COUNT; i++) {
    const def = ITEMS[i];
    if (def.id !== i) problems.push(`id mismatch at ${i}`);
    if (I[def.name.toUpperCase()] !== i) problems.push(`I constant mismatch for ${def.name}`);
    if (def.maxStack < 0 || def.maxStack > 64) problems.push(`bad stack size for ${def.name}`);
    if (def.isBlock && BLOCK_TO_ITEM[def.blockId] !== i) {
      problems.push(`block<->item mismatch for ${def.name}`);
    }
  }
  // Every name a block can drop must exist as an item, otherwise mining a block
  // would silently produce nothing.
  const missingDrops = new Set();
  for (const def of BLOCKS) {
    const candidates = [def.dropItem, def.shearDrop, def.saplingItem,
      def.cropSeed, def.cropProduct, def.cropExtra];
    for (const d of def.drops) candidates.push(d.item);
    for (const name of candidates) {
      if (name && !ITEM_BY_NAME.has(name) && !NON_ITEM_BLOCKS.has(name)) missingDrops.add(name);
    }
  }
  for (const extra of ['apple', 'stick', 'string', 'flint', 'wheat_seeds', 'snowball']) {
    if (!ITEM_BY_NAME.has(extra)) missingDrops.add(extra);
  }
  if (missingDrops.size) problems.push(`missing drop items: ${[...missingDrops].join(', ')}`);
  if (UNTRANSLATED.length) problems.push(`untranslated blocks: ${UNTRANSLATED.join(', ')}`);
  if (problems.length) console.warn(`[items] registry problems: ${problems.join(' | ')}`);
}
