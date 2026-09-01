/**
 * VOXELIA — block registry (ARCHITECTURE.md section 5.6).
 *
 * This module is the backbone of the whole engine: worldgen, the mesher, the
 * lighting engine, physics, interaction, items and the UI all read their block
 * facts from here. It is imported directly by `world/worker.js`, so it must stay
 * free of any `document`/`window` access at module scope.
 *
 * ============================================================================
 * DESIGN
 * ============================================================================
 * Every block is created through the compact `defineBlock()` helper, which fills
 * in sensible defaults so the table below stays readable. After the table is
 * built the module precomputes flat typed arrays so the hot paths are O(1) and
 * allocation free:
 *
 *   FACE_MATERIAL  Uint16Array(count * 6)  face -> texture-array layer
 *   FLAGS          Uint8Array(count)       material flag byte (see 3.1)
 *   ABSORB         Uint8Array(count)       light absorption 0..15
 *   EMISSION_RGB   Uint8Array(count * 3)   colored emission, each 0..15
 *   RENDER_KIND    Uint8Array(count)       RENDER.* value
 *   BITS           Uint8Array(count)       solid/opaque/liquid/... bit set
 *
 * `faceMaterial()`, `blockFlags()`, `lightAbsorb()`, `isSolid()` … only index
 * these arrays; they never allocate and never branch on strings.
 *
 * ============================================================================
 * BLOCK STATE CONVENTIONS (the `state` argument of `blockAABBs`)
 * ============================================================================
 * A block state is a small integer stored next to the block id by the game
 * layer. Only the shapes below actually read it:
 *
 *   slab         bits0-1  0 = bottom, 1 = top, 2/3 = double (full cube)
 *   stairs       bits0-1  facing (0 = +X, 1 = -X, 2 = +Z, 3 = -Z)
 *                bit2     1 = upside down
 *   torch        0 = standing, 1 = on -X wall, 2 = +X, 3 = -Z, 4 = +Z
 *   fence/pane   bit0 = connected +X, bit1 = -X, bit2 = +Z, bit3 = -Z
 *   door         bit0 = open, bit1 = upper half, bits2-3 = facing
 *   trapdoor     bit0 = open, bit1 = top half,  bits2-3 = facing
 *   fence_gate   bit0 = open,                   bits2-3 = facing
 *   ladder       bits0-1 = wall the ladder hangs on (0 = +X, 1 = -X, 2 = +Z, 3 = -Z)
 *   snow_layer   0..7 -> (state + 1) * 2/16 blocks tall
 *
 * Everything else ignores `state` and returns its single static box list.
 * Facing indices always match the face directions of 3.1: 0 = +X, 1 = -X,
 * 2 = +Y, 3 = -Y, 4 = +Z, 5 = -Z (horizontal facings use 0,1,4,5 collapsed to
 * 0,1,2,3 as documented above).
 *
 * ============================================================================
 * TOOLS
 * ============================================================================
 * `toolTier` values come from `TOOL_TIER`. Two parallel tables translate a tier
 * into gameplay numbers: `TIER_SPEED` (mining speed multiplier, vanilla values)
 * and `TIER_HARVEST` (harvest level — gold shares wood's level despite being the
 * fastest tool). `game/items.js` must report the same enum from `toolTier()`.
 *
 * @module world/blocks
 */

import { materialLayer } from './materials.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Render kind of a block. The mesher branches on this value.
 * @type {{CUBE:number, CROSS:number, FLUID:number, SLAB:number, STAIRS:number,
 *   TORCH:number, PANE:number, NONE:number, MODEL:number}}
 */
export const RENDER = Object.freeze({
  CUBE: 0, CROSS: 1, FLUID: 2, SLAB: 3, STAIRS: 4,
  TORCH: 5, PANE: 6, NONE: 7, MODEL: 8
});

/**
 * Tool material tiers. Also used by `game/items.js` for `toolTier(itemId)`.
 * Gold is its own tier because it mines fastest but harvests like wood.
 * @type {{NONE:number, WOOD:number, GOLD:number, STONE:number, IRON:number,
 *   DIAMOND:number, NETHERITE:number}}
 */
export const TOOL_TIER = Object.freeze({
  NONE: 0, WOOD: 1, GOLD: 2, STONE: 3, IRON: 4, DIAMOND: 5, NETHERITE: 6
});

/**
 * Mining speed multiplier per `TOOL_TIER` value (vanilla numbers).
 * @type {Readonly<number[]>}
 */
export const TIER_SPEED = Object.freeze([1, 2, 12, 4, 6, 8, 9]);

/**
 * Harvest level per `TOOL_TIER` value. A block only drops when the held tool's
 * harvest level is >= the block's.
 * @type {Readonly<number[]>}
 */
export const TIER_HARVEST = Object.freeze([0, 1, 1, 2, 3, 4, 5]);

/**
 * Material flag byte bits, packed into `a_tint.a * 255` by the mesher (3.1).
 * @type {{WAVES:number, EMISSIVE:number, WET:number, PARALLAX:number}}
 */
export const FLAG = Object.freeze({ WAVES: 1, EMISSIVE: 2, WET: 4, PARALLAX: 8 });

/** Bit flags packed into the `BITS` lookup table. @type {Readonly<Object>} */
const BIT = Object.freeze({
  SOLID: 1, OPAQUE: 2, CUTOUT: 4, TRANSPARENT: 8,
  LIQUID: 16, REPLACEABLE: 32, GRAVITY: 64, WATERLOGGABLE: 128
});

/** Number of horizontal facings used by state-driven shapes. @type {number} */
const FACINGS = 4;

// ---------------------------------------------------------------------------
// AABB shape library
// ---------------------------------------------------------------------------

/**
 * Freeze one axis-aligned box in block-local space.
 * @param {number} a minX
 * @param {number} b minY
 * @param {number} c minZ
 * @param {number} d maxX
 * @param {number} e maxY
 * @param {number} f maxZ
 * @returns {readonly number[]} frozen `[minX,minY,minZ,maxX,maxY,maxZ]`
 */
function bx(a, b, c, d, e, f) {
  return Object.freeze([a, b, c, d, e, f]);
}

/**
 * Freeze a list of boxes into an immutable AABB set.
 * @param {...readonly number[]} list boxes produced by `bx()`
 * @returns {readonly (readonly number[])[]} frozen box list
 */
function boxes(...list) {
  return Object.freeze(list);
}

/** Full unit cube. @type {readonly (readonly number[])[]} */
const FULL_CUBE = boxes(bx(0, 0, 0, 1, 1, 1));
/** No collision at all. @type {readonly (readonly number[])[]} */
const NO_BOX = Object.freeze([]);

const P = 1 / 16;

/** Slab states: bottom, top, double, double. @type {readonly (readonly (readonly number[])[])[]} */
const SLAB_STATES = Object.freeze([
  boxes(bx(0, 0, 0, 1, 0.5, 1)),
  boxes(bx(0, 0.5, 0, 1, 1, 1)),
  FULL_CUBE,
  FULL_CUBE
]);

/**
 * Horizontal half of a block per facing, as `[x0, z0, x1, z1]`.
 * @type {readonly number[][]}
 */
const HALF_BY_FACING = Object.freeze([
  [0.5, 0, 1, 1],
  [0, 0, 0.5, 1],
  [0, 0.5, 1, 1],
  [0, 0, 1, 0.5]
]);

/** Stairs states, index `top * 4 + facing`. @type {readonly (readonly (readonly number[])[])[]} */
const STAIRS_STATES = Object.freeze((() => {
  const out = [];
  for (let top = 0; top < 2; top++) {
    for (let f = 0; f < FACINGS; f++) {
      const h = HALF_BY_FACING[f];
      const base = top ? bx(0, 0.5, 0, 1, 1, 1) : bx(0, 0, 0, 1, 0.5, 1);
      const step = top
        ? bx(h[0], 0, h[1], h[2], 0.5, h[3])
        : bx(h[0], 0.5, h[1], h[2], 1, h[3]);
      out.push(boxes(base, step));
    }
  }
  return out;
})());

/** Torch states: standing plus four wall mounts. @type {readonly (readonly (readonly number[])[])[]} */
const TORCH_STATES = Object.freeze([
  boxes(bx(7 * P, 0, 7 * P, 9 * P, 10 * P, 9 * P)),
  boxes(bx(0, 3 * P, 6 * P, 5 * P, 13 * P, 10 * P)),
  boxes(bx(11 * P, 3 * P, 6 * P, 1, 13 * P, 10 * P)),
  boxes(bx(6 * P, 3 * P, 0, 10 * P, 13 * P, 5 * P)),
  boxes(bx(6 * P, 3 * P, 11 * P, 10 * P, 13 * P, 1))
]);

/**
 * Build the 16 connection states of a post-and-arm shape (fences, panes, bars).
 * @param {readonly number[]} post the centre post box
 * @param {readonly number[][]} arms four arm boxes ordered +X, -X, +Z, -Z
 * @returns {readonly (readonly (readonly number[])[])[]} 16 frozen box lists
 */
function connectionStates(post, arms) {
  const out = [];
  for (let s = 0; s < 16; s++) {
    const list = [post];
    for (let i = 0; i < 4; i++) if (s & (1 << i)) list.push(arms[i]);
    out.push(Object.freeze(list));
  }
  return Object.freeze(out);
}

/** Fence connection states (posts are 1.5 blocks tall). @type {readonly (readonly (readonly number[])[])[]} */
const FENCE_STATES = connectionStates(
  bx(6 * P, 0, 6 * P, 10 * P, 1.5, 10 * P),
  [
    bx(10 * P, 5 * P, 7 * P, 1, 15 * P, 9 * P),
    bx(0, 5 * P, 7 * P, 6 * P, 15 * P, 9 * P),
    bx(7 * P, 5 * P, 10 * P, 9 * P, 15 * P, 1),
    bx(7 * P, 5 * P, 0, 9 * P, 15 * P, 6 * P)
  ]
);

/** Glass pane / iron bar connection states. @type {readonly (readonly (readonly number[])[])[]} */
const PANE_STATES = connectionStates(
  bx(7 * P, 0, 7 * P, 9 * P, 1, 9 * P),
  [
    bx(9 * P, 0, 7 * P, 1, 1, 9 * P),
    bx(0, 0, 7 * P, 7 * P, 1, 9 * P),
    bx(7 * P, 0, 9 * P, 9 * P, 1, 1),
    bx(7 * P, 0, 0, 9 * P, 1, 7 * P)
  ]
);

/** Thin vertical slab pressed against one side, indexed by facing. @type {readonly number[][]} */
const SIDE_SLAB = Object.freeze([
  bx(13 * P, 0, 0, 1, 1, 1),
  bx(0, 0, 0, 3 * P, 1, 1),
  bx(0, 0, 13 * P, 1, 1, 1),
  bx(0, 0, 0, 1, 1, 3 * P)
]);

/** Door states: bit0 open, bit1 upper (no shape change), bits2-3 facing. */
const DOOR_STATES = Object.freeze((() => {
  const out = [];
  for (let s = 0; s < 16; s++) {
    const facing = (s >> 2) & 3;
    const open = (s & 1) !== 0;
    out.push(boxes(SIDE_SLAB[open ? (facing + 3) & 3 : facing]));
  }
  return out;
})());

/** Trapdoor states: bit0 open, bit1 top, bits2-3 facing. */
const TRAPDOOR_STATES = Object.freeze((() => {
  const bottom = bx(0, 0, 0, 1, 3 * P, 1);
  const top = bx(0, 13 * P, 0, 1, 1, 1);
  const out = [];
  for (let s = 0; s < 16; s++) {
    const facing = (s >> 2) & 3;
    if (s & 1) out.push(boxes(SIDE_SLAB[facing]));
    else out.push(boxes((s & 2) ? top : bottom));
  }
  return out;
})());

/** Fence gate states: bit0 open (no collision), bits2-3 facing. */
const FENCE_GATE_STATES = Object.freeze((() => {
  const alongZ = bx(6 * P, 0, 0, 10 * P, 1.5, 1);
  const alongX = bx(0, 0, 6 * P, 1, 1.5, 10 * P);
  const out = [];
  for (let s = 0; s < 16; s++) {
    if (s & 1) { out.push(NO_BOX); continue; }
    const facing = (s >> 2) & 3;
    out.push(boxes(facing < 2 ? alongZ : alongX));
  }
  return out;
})());

/** Ladder states, indexed by the wall it hangs on. */
const LADDER_STATES = Object.freeze([
  boxes(bx(13 * P, 0, 0, 1, 1, 1)),
  boxes(bx(0, 0, 0, 3 * P, 1, 1)),
  boxes(bx(0, 0, 13 * P, 1, 1, 1)),
  boxes(bx(0, 0, 0, 1, 1, 3 * P))
]);

/** Snow layer states 0..7 -> 2/16 .. 16/16 tall. */
const SNOW_LAYER_STATES = Object.freeze((() => {
  const out = [];
  for (let s = 0; s < 8; s++) out.push(boxes(bx(0, 0, 0, 1, (s + 1) * 2 * P, 1)));
  return out;
})());

/** Named static shapes. `states` non-null means the shape reads the block state. */
const SHAPES = Object.freeze({
  cube: { aabbs: FULL_CUBE, states: null },
  empty: { aabbs: NO_BOX, states: null },
  slab: { aabbs: SLAB_STATES[0], states: SLAB_STATES },
  stairs: { aabbs: STAIRS_STATES[0], states: STAIRS_STATES },
  torch: { aabbs: TORCH_STATES[0], states: TORCH_STATES },
  fence: { aabbs: FENCE_STATES[0], states: FENCE_STATES },
  fence_gate: { aabbs: FENCE_GATE_STATES[0], states: FENCE_GATE_STATES },
  pane: { aabbs: PANE_STATES[0], states: PANE_STATES },
  door: { aabbs: DOOR_STATES[0], states: DOOR_STATES },
  trapdoor: { aabbs: TRAPDOOR_STATES[0], states: TRAPDOOR_STATES },
  ladder: { aabbs: LADDER_STATES[0], states: LADDER_STATES },
  snow_layer: { aabbs: SNOW_LAYER_STATES[0], states: SNOW_LAYER_STATES },
  carpet: { aabbs: boxes(bx(0, 0, 0, 1, P, 1)), states: null },
  flat: { aabbs: boxes(bx(0, 0, 0, 1, P, 1)), states: null },
  plate: { aabbs: boxes(bx(P, 0, P, 15 * P, P, 15 * P)), states: null },
  button: { aabbs: boxes(bx(5 * P, 0, 6 * P, 11 * P, P, 10 * P)), states: null },
  lever: { aabbs: boxes(bx(5 * P, 0, 4 * P, 11 * P, 6 * P, 12 * P)), states: null },
  repeater: { aabbs: boxes(bx(0, 0, 0, 1, 2 * P, 1)), states: null },
  cactus: { aabbs: boxes(bx(P, 0, P, 15 * P, 1, 15 * P)), states: null },
  lowered: { aabbs: boxes(bx(0, 0, 0, 1, 15 * P, 1)), states: null },
  soul_sand: { aabbs: boxes(bx(0, 0, 0, 1, 14 * P, 1)), states: null },
  bamboo: { aabbs: boxes(bx(6.5 * P, 0, 6.5 * P, 9.5 * P, 1, 9.5 * P)), states: null },
  chest: { aabbs: boxes(bx(P, 0, P, 15 * P, 14 * P, 15 * P)), states: null },
  lantern: { aabbs: boxes(bx(5 * P, 0, 5 * P, 11 * P, 7 * P, 11 * P)), states: null },
  campfire: { aabbs: boxes(bx(0, 0, 0, 1, 7 * P, 1)), states: null },
  anvil: { aabbs: boxes(bx(2 * P, 0, 0, 14 * P, 1, 1)), states: null },
  enchanting_table: { aabbs: boxes(bx(0, 0, 0, 1, 12 * P, 1)), states: null },
  portal_frame: { aabbs: boxes(bx(0, 0, 0, 1, 13 * P, 1)), states: null },
  brewing_stand: {
    aabbs: boxes(bx(0, 0, 0, 1, 2 * P, 1), bx(7 * P, 0, 7 * P, 9 * P, 14 * P, 9 * P)),
    states: null
  },
  cauldron: {
    aabbs: boxes(
      bx(0, 0, 0, 1, 3 * P, 1),
      bx(0, 3 * P, 0, 2 * P, 1, 1),
      bx(14 * P, 3 * P, 0, 1, 1, 1),
      bx(2 * P, 3 * P, 0, 14 * P, 1, 2 * P),
      bx(2 * P, 3 * P, 14 * P, 14 * P, 1, 1)
    ),
    states: null
  },
  hopper: {
    aabbs: boxes(
      bx(0, 10 * P, 0, 1, 1, 1),
      bx(4 * P, 4 * P, 4 * P, 12 * P, 10 * P, 12 * P)
    ),
    states: null
  },
  scaffolding: {
    aabbs: boxes(
      bx(0, 14 * P, 0, 1, 1, 1),
      bx(0, 0, 0, 2 * P, 14 * P, 2 * P),
      bx(14 * P, 0, 0, 1, 14 * P, 2 * P),
      bx(0, 0, 14 * P, 2 * P, 14 * P, 1),
      bx(14 * P, 0, 14 * P, 1, 14 * P, 1)
    ),
    states: null
  }
});

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   id:number, name:string, display:string, render:number,
 *   solid:boolean, opaque:boolean, cutout:boolean, transparent:boolean,
 *   liquid:boolean, replaceable:boolean, hardness:number,
 *   toolType:(string|null), toolTier:number, requiresTool:boolean,
 *   altTools:(readonly string[]|null),
 *   emission:readonly number[], absorb:number,
 *   textures:{all?:string, top?:string, bottom?:string, side?:string,
 *             north?:string, south?:string, east?:string, west?:string},
 *   tint:(string|null), flags:number,
 *   drops:{item:string, count:number}[],
 *   maxStack:number, sound:string, gravity:boolean, flammable:boolean,
 *   waterloggable:boolean, waves:boolean, fluidLevel:number,
 *   aabbs:readonly (readonly number[])[],
 *   aabbsByState:(readonly (readonly (readonly number[])[])[]|null),
 *   dropKind:string, dropItem:(string|null), dropMin:number, dropMax:number,
 *   shearDrop:(string|null), saplingItem:(string|null), appleDrop:boolean,
 *   rareSapling:boolean, cropMature:boolean, cropSeed:(string|null),
 *   cropProduct:(string|null), cropExtra:(string|null)
 * }} BlockDef
 */

/**
 * Dense block table indexed by block id. `BLOCKS[0]` is always air.
 * @type {BlockDef[]}
 */
export const BLOCKS = [];

/**
 * Block name -> definition.
 * @type {Map<string, BlockDef>}
 */
export const BLOCK_BY_NAME = new Map();

/**
 * SCREAMING_SNAKE_CASE constants. The key is always the block name uppercased
 * (`B.GRASS_BLOCK === BLOCK_BY_NAME.get('grass_block').id`). A handful of extra
 * convenience aliases are appended at the bottom of this file; they never break
 * that derivation because no block is named after them.
 * @type {Object<string, number>}
 */
export const B = Object.create(null);

/**
 * Turn `dark_oak_planks` into `Dark Oak Planks`.
 * @param {string} name snake_case block name
 * @returns {string} human readable display name
 */
function titleCase(name) {
  const parts = name.split('_');
  for (let i = 0; i < parts.length; i++) {
    parts[i] = parts[i].charAt(0).toUpperCase() + parts[i].slice(1);
  }
  return parts.join(' ');
}

/**
 * Normalise the `tex` option into the BlockDef `textures` record.
 * @param {string|Object|undefined} tex string (all faces) or a per-face record
 * @param {string} name block name, used as the implicit default
 * @returns {Object} textures record
 */
function normaliseTextures(tex, name) {
  if (tex === null) return {};
  if (tex === undefined) return { all: name };
  if (typeof tex === 'string') return { all: tex };
  return tex;
}

/**
 * Register one block. Returns the freshly assigned id so the table can capture
 * it directly. Defaults are chosen so a plain opaque stone-like cube needs
 * nothing but a name.
 *
 * @param {string} name unique snake_case block name
 * @param {Object} [opts] overrides for any BlockDef field (see the typedef)
 * @returns {number} the new block id
 */
function defineBlock(name, opts = {}) {
  if (BLOCK_BY_NAME.has(name)) {
    console.warn(`[blocks] duplicate block "${name}" ignored`);
    return /** @type {BlockDef} */ (BLOCK_BY_NAME.get(name)).id;
  }
  const id = BLOCKS.length;
  const render = opts.render ?? RENDER.CUBE;
  const isFullShape = render === RENDER.CUBE;
  const liquid = opts.liquid ?? false;
  const cutout = opts.cutout ?? false;
  const transparent = opts.transparent ?? (cutout || liquid || !isFullShape);
  const solid = opts.solid ?? (!liquid && render !== RENDER.NONE && render !== RENDER.CROSS);
  const opaque = opts.opaque ?? (isFullShape && solid && !cutout && !transparent);
  const hardness = opts.hardness ?? 1;
  const toolType = opts.toolType ?? null;
  const toolTier = opts.toolTier ?? TOOL_TIER.NONE;
  const requiresTool = opts.requiresTool ?? (toolTier > TOOL_TIER.NONE);
  const emission = Object.freeze(opts.emission ? opts.emission.slice(0, 3) : [0, 0, 0]);
  const emissive = emission[0] > 0 || emission[1] > 0 || emission[2] > 0;
  const absorb = opts.absorb ?? (opaque ? 15 : 0);
  const waves = opts.waves ?? false;
  const shapeName = opts.shape ?? (render === RENDER.CROSS || render === RENDER.NONE ? 'empty' : 'cube');
  const shape = SHAPES[shapeName] ?? SHAPES.cube;
  const wet = opts.wet ?? (opaque && !liquid && !emissive);
  const parallax = opts.parallax
    ?? (render === RENDER.CUBE || render === RENDER.SLAB || render === RENDER.STAIRS);

  let flags = 0;
  if (waves) flags |= FLAG.WAVES;
  if (emissive) flags |= FLAG.EMISSIVE;
  if (wet) flags |= FLAG.WET;
  if (parallax) flags |= FLAG.PARALLAX;

  /** @type {{item:string, count:number}[]} */
  let drops;
  if (opts.drops === null) drops = [];
  else if (opts.drops === undefined) drops = [{ item: name, count: 1 }];
  else if (typeof opts.drops === 'string') drops = [{ item: opts.drops, count: 1 }];
  else if (Array.isArray(opts.drops)) drops = opts.drops.map((d) => (typeof d === 'string' ? { item: d, count: 1 } : { item: d.item, count: d.count ?? 1 }));
  else drops = [{ item: opts.drops.item, count: opts.drops.count ?? 1 }];

  /** @type {BlockDef} */
  const def = {
    id,
    name,
    display: opts.display ?? titleCase(name),
    render,
    solid,
    opaque,
    cutout,
    transparent,
    liquid,
    replaceable: opts.replaceable ?? (liquid || render === RENDER.NONE),
    hardness,
    toolType,
    toolTier,
    requiresTool,
    altTools: opts.altTools ? Object.freeze(opts.altTools.slice()) : null,
    emission,
    absorb,
    textures: normaliseTextures(opts.tex, name),
    tint: opts.tint ?? null,
    flags,
    drops,
    maxStack: opts.maxStack ?? 64,
    sound: opts.sound ?? 'stone',
    gravity: opts.gravity ?? false,
    flammable: opts.flammable ?? false,
    waterloggable: opts.waterloggable ?? (render === RENDER.PANE || render === RENDER.SLAB
      || render === RENDER.STAIRS || shapeName === 'fence' || shapeName === 'ladder'),
    waves,
    fluidLevel: opts.fluidLevel ?? 0,
    aabbs: opts.aabbs ? Object.freeze(opts.aabbs.map((b) => Object.freeze(b.slice()))) : shape.aabbs,
    aabbsByState: opts.aabbs ? null : shape.states,
    dropKind: opts.dropKind ?? 'simple',
    dropItem: opts.dropItem ?? null,
    dropMin: opts.dropMin ?? 1,
    dropMax: opts.dropMax ?? 1,
    shearDrop: opts.shearDrop ?? null,
    saplingItem: opts.saplingItem ?? null,
    appleDrop: opts.appleDrop ?? false,
    rareSapling: opts.rareSapling ?? false,
    cropMature: opts.cropMature ?? false,
    cropSeed: opts.cropSeed ?? null,
    cropProduct: opts.cropProduct ?? null,
    cropExtra: opts.cropExtra ?? null
  };

  BLOCKS.push(def);
  BLOCK_BY_NAME.set(name, def);
  B[name.toUpperCase()] = id;
  return id;
}

// --- compact family helpers ------------------------------------------------

/**
 * Pickaxe-mined rock cube.
 * @param {string} name block name
 * @param {Object} [opts] extra BlockDef overrides
 * @returns {number} block id
 */
const rock = (name, opts = {}) => defineBlock(name, {
  hardness: 1.5, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'stone', ...opts
});

/**
 * Axe-mined wooden cube.
 * @param {string} name block name
 * @param {Object} [opts] extra BlockDef overrides
 * @returns {number} block id
 */
const timber = (name, opts = {}) => defineBlock(name, {
  hardness: 2, toolType: 'axe', sound: 'wood', flammable: true, ...opts
});

/**
 * Shovel-mined soil cube.
 * @param {string} name block name
 * @param {Object} [opts] extra BlockDef overrides
 * @returns {number} block id
 */
const soil = (name, opts = {}) => defineBlock(name, {
  hardness: 0.5, toolType: 'shovel', sound: 'gravel', ...opts
});

/**
 * Cross-rendered plant with no collision.
 * @param {string} name block name
 * @param {Object} [opts] extra BlockDef overrides
 * @returns {number} block id
 */
const plant = (name, opts = {}) => defineBlock(name, {
  hardness: 0, render: RENDER.CROSS, shape: 'empty', cutout: true, transparent: true,
  solid: false, opaque: false, replaceable: true, absorb: 0, waves: true,
  sound: 'grass', flammable: true, ...opts
});

/**
 * Mineral storage block (iron/gold/diamond …).
 * @param {string} name block name
 * @param {Object} [opts] extra BlockDef overrides
 * @returns {number} block id
 */
const mineralBlock = (name, opts = {}) => defineBlock(name, {
  hardness: 5, toolType: 'pickaxe', toolTier: TOOL_TIER.STONE, sound: 'metal', ...opts
});

/**
 * Ore block. `dropKind: 'ore'` routes it through the fortune-aware drop path.
 * @param {string} name block name
 * @param {Object} [opts] extra BlockDef overrides
 * @returns {number} block id
 */
const oreBlock = (name, opts = {}) => defineBlock(name, {
  hardness: 3, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'stone',
  dropKind: 'ore', ...opts
});

// ---------------------------------------------------------------------------
// 1. Air & fluids
// ---------------------------------------------------------------------------

defineBlock('air', {
  render: RENDER.NONE, solid: false, opaque: false, transparent: true,
  replaceable: true, hardness: 0, absorb: 0, tex: null, drops: null,
  wet: false, parallax: false
});

defineBlock('water', {
  render: RENDER.FLUID, liquid: true, solid: false, opaque: false, transparent: true,
  replaceable: true, hardness: -1, absorb: 1, tex: 'water_still', tint: 'water',
  sound: 'water', drops: null, wet: true, parallax: false, fluidLevel: 8
});

defineBlock('lava', {
  render: RENDER.FLUID, liquid: true, solid: false, opaque: false, transparent: true,
  replaceable: true, hardness: -1, absorb: 15, tex: 'lava_still',
  emission: [15, 9, 3], sound: 'stone', drops: null, parallax: false, fluidLevel: 8
});

// ---------------------------------------------------------------------------
// 2. Stone family
// ---------------------------------------------------------------------------

rock('stone', { drops: 'cobblestone' });
rock('granite');
rock('polished_granite');
rock('diorite');
rock('polished_diorite');
rock('andesite');
rock('polished_andesite');
rock('cobblestone', { hardness: 2 });
rock('mossy_cobblestone', { hardness: 2 });
rock('smooth_stone', { hardness: 2 });
rock('stone_bricks');
rock('mossy_stone_bricks');
rock('cracked_stone_bricks');
rock('chiseled_stone_bricks');

rock('deepslate', {
  hardness: 3, drops: 'cobbled_deepslate',
  tex: { side: 'deepslate', top: 'deepslate_top', bottom: 'deepslate_top' }
});
rock('cobbled_deepslate', { hardness: 3.5 });
rock('polished_deepslate', { hardness: 3.5 });
rock('deepslate_bricks', { hardness: 3.5 });
rock('deepslate_tiles', { hardness: 3.5 });
rock('tuff');
rock('calcite', { hardness: 0.75 });
rock('dripstone_block');

defineBlock('bedrock', {
  hardness: -1, toolType: 'pickaxe', toolTier: TOOL_TIER.NETHERITE, requiresTool: true,
  sound: 'stone', drops: null
});

rock('bricks', { hardness: 2 });
rock('nether_bricks', { hardness: 2 });
rock('blackstone');
rock('polished_blackstone', { hardness: 2 });
rock('basalt', {
  hardness: 1.25,
  tex: { side: 'basalt_side', top: 'basalt_top', bottom: 'basalt_top' }
});

rock('obsidian', { hardness: 50, toolTier: TOOL_TIER.DIAMOND });
rock('crying_obsidian', {
  hardness: 50, toolTier: TOOL_TIER.DIAMOND, emission: [7, 0, 10]
});

rock('netherrack', { hardness: 0.4 });
defineBlock('soul_sand', {
  hardness: 0.5, toolType: 'shovel', sound: 'sand', shape: 'soul_sand'
});
defineBlock('soul_soil', { hardness: 0.5, toolType: 'shovel', sound: 'sand' });
rock('magma_block', { hardness: 0.5, tex: 'magma', emission: [3, 1, 0] });

defineBlock('glowstone', {
  hardness: 0.3, toolType: 'pickaxe', sound: 'glass', emission: [15, 13, 9],
  dropKind: 'range', dropItem: 'glowstone_dust', dropMin: 2, dropMax: 4
});

rock('quartz_block', { hardness: 0.8 });
rock('quartz_pillar', {
  hardness: 0.8, tex: { side: 'quartz_pillar', top: 'quartz_pillar_top', bottom: 'quartz_pillar_top' }
});
rock('chiseled_quartz_block', { hardness: 0.8 });
rock('end_stone', { hardness: 3 });
rock('end_stone_bricks', { hardness: 3 });
rock('purpur_block', { tex: 'purpur' });
rock('purpur_pillar');
rock('prismarine');
rock('prismarine_bricks');
rock('dark_prismarine');

defineBlock('sea_lantern', {
  hardness: 0.3, toolType: 'pickaxe', sound: 'glass', emission: [11, 14, 15],
  dropKind: 'range', dropItem: 'prismarine_crystals', dropMin: 2, dropMax: 3
});

rock('amethyst_block');
rock('budding_amethyst', { drops: null });
plant('amethyst_cluster', {
  hardness: 1.5, toolType: 'pickaxe', tex: 'budding_amethyst', sound: 'glass',
  emission: [3, 1, 5], flammable: false, waves: false, replaceable: false,
  dropKind: 'range', dropItem: 'amethyst_shard', dropMin: 2, dropMax: 4
});

// ---------------------------------------------------------------------------
// 3. Soil, sand & surface
// ---------------------------------------------------------------------------

soil('dirt');
soil('coarse_dirt');
soil('podzol', {
  sound: 'grass',
  tex: { top: 'podzol_top', side: 'podzol_side', bottom: 'dirt' },
  drops: 'dirt'
});
soil('mycelium', {
  hardness: 0.6, sound: 'grass',
  tex: { top: 'mycelium_top', side: 'mycelium_side', bottom: 'dirt' },
  drops: 'dirt'
});
soil('grass_block', {
  hardness: 0.6, sound: 'grass', tint: 'grass',
  tex: { top: 'grass_block_top', side: 'grass_block_side', bottom: 'grass_block_bottom' },
  drops: 'dirt'
});
soil('farmland', {
  hardness: 0.6, shape: 'lowered', absorb: 15,
  tex: { top: 'farmland', side: 'dirt', bottom: 'dirt' }, drops: 'dirt'
});
soil('dirt_path', {
  hardness: 0.65, sound: 'grass', shape: 'lowered', absorb: 15,
  tex: { top: 'dirt_path_top', side: 'dirt_path_side', bottom: 'dirt' }, drops: 'dirt'
});
soil('mud');
defineBlock('moss_block', {
  hardness: 0.1, toolType: 'hoe', altTools: ['shears'], sound: 'grass'
});
defineBlock('moss_carpet', {
  hardness: 0.1, toolType: 'hoe', altTools: ['shears'], sound: 'grass',
  render: RENDER.MODEL, shape: 'carpet', cutout: true, absorb: 0, tex: 'moss_carpet'
});

soil('sand', { sound: 'sand', gravity: true });
soil('red_sand', { sound: 'sand', gravity: true });
rock('sandstone', {
  hardness: 0.8,
  tex: { top: 'sandstone_top', side: 'sandstone_side', bottom: 'sandstone_bottom' }
});
rock('smooth_sandstone', { hardness: 2, tex: 'smooth_sandstone' });
rock('cut_sandstone', { hardness: 0.8, tex: 'cut_sandstone' });
rock('red_sandstone', {
  hardness: 0.8,
  tex: { top: 'red_sandstone_top', side: 'red_sandstone_side', bottom: 'red_sandstone_bottom' }
});
rock('smooth_red_sandstone', { hardness: 2, tex: 'smooth_red_sandstone' });
rock('cut_red_sandstone', { hardness: 0.8, tex: 'cut_red_sandstone' });

soil('gravel', { hardness: 0.6, gravity: true, dropKind: 'gravel' });
soil('clay', {
  hardness: 0.6, dropKind: 'range', dropItem: 'clay_ball', dropMin: 4, dropMax: 4
});

defineBlock('snow_block', {
  hardness: 0.2, toolType: 'shovel', toolTier: TOOL_TIER.WOOD, sound: 'snow',
  tex: 'snow_block', dropKind: 'range', dropItem: 'snowball', dropMin: 4, dropMax: 4
});
defineBlock('snow_layer', {
  hardness: 0.1, toolType: 'shovel', toolTier: TOOL_TIER.WOOD, sound: 'snow',
  render: RENDER.SLAB, shape: 'snow_layer', tex: 'snow_layer',
  solid: true, opaque: false, transparent: true, cutout: true, absorb: 0,
  replaceable: true, drops: 'snowball'
});
defineBlock('ice', {
  hardness: 0.5, toolType: 'pickaxe', sound: 'glass', tex: 'ice',
  opaque: false, transparent: true, cutout: false, absorb: 1, drops: null
});
defineBlock('packed_ice', {
  hardness: 0.5, toolType: 'pickaxe', sound: 'glass', tex: 'packed_ice', drops: null
});
defineBlock('blue_ice', {
  hardness: 2.8, toolType: 'pickaxe', sound: 'glass', tex: 'blue_ice', drops: null
});

// ---------------------------------------------------------------------------
// 4. Wood species — logs, planks, leaves
// ---------------------------------------------------------------------------

/**
 * Species that get a log/planks/leaves triple. `tint` is null for species whose
 * leaves have a fixed colour in vanilla (birch, spruce, cherry).
 * @type {readonly {name:string, tint:(string|null), sapling:string, apple:boolean, rare:boolean}[]}
 */
const WOOD_SPECIES = Object.freeze([
  { name: 'oak', tint: 'foliage', sapling: 'oak_sapling', apple: true, rare: false },
  { name: 'spruce', tint: null, sapling: 'spruce_sapling', apple: false, rare: false },
  { name: 'birch', tint: null, sapling: 'birch_sapling', apple: false, rare: false },
  { name: 'jungle', tint: 'foliage', sapling: 'jungle_sapling', apple: false, rare: true },
  { name: 'acacia', tint: 'foliage', sapling: 'acacia_sapling', apple: false, rare: false },
  { name: 'dark_oak', tint: 'foliage', sapling: 'dark_oak_sapling', apple: true, rare: false },
  { name: 'cherry', tint: null, sapling: 'cherry_sapling', apple: false, rare: false }
]);

for (const s of WOOD_SPECIES) {
  timber(`${s.name}_log`, {
    tex: { side: `${s.name}_log`, top: `${s.name}_log_top`, bottom: `${s.name}_log_top` }
  });
  timber(`${s.name}_planks`);
  defineBlock(`${s.name}_leaves`, {
    hardness: 0.2, toolType: 'hoe', altTools: ['shears', 'sword'], sound: 'grass',
    cutout: true, transparent: true, opaque: false, absorb: 1, waves: true,
    flammable: true, tint: s.tint, tex: `${s.name}_leaves`,
    dropKind: 'leaves', saplingItem: s.sapling, appleDrop: s.apple, rareSapling: s.rare,
    shearDrop: `${s.name}_leaves`
  });
}

defineBlock('azalea', {
  hardness: 0.2, toolType: 'hoe', altTools: ['shears'], sound: 'grass',
  cutout: true, transparent: true, opaque: false, absorb: 1, waves: true,
  tex: { top: 'azalea_top', side: 'azalea_side', bottom: 'azalea_side' }
});

// ---------------------------------------------------------------------------
// 5. Glass & panes
// ---------------------------------------------------------------------------

defineBlock('glass', {
  hardness: 0.3, sound: 'glass', cutout: true, transparent: true, opaque: false,
  absorb: 0, drops: null
});
defineBlock('tinted_glass', {
  hardness: 0.3, sound: 'glass', cutout: true, transparent: true, opaque: false,
  absorb: 15
});
defineBlock('glass_pane', {
  hardness: 0.3, sound: 'glass', render: RENDER.PANE, shape: 'pane',
  cutout: true, transparent: true, opaque: false, absorb: 0, tex: 'glass_pane',
  drops: null
});
defineBlock('iron_bars', {
  hardness: 5, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'metal',
  render: RENDER.PANE, shape: 'pane', cutout: true, transparent: true,
  opaque: false, absorb: 0
});

// ---------------------------------------------------------------------------
// 6. Ores
// ---------------------------------------------------------------------------

/**
 * Ore definitions shared by the stone and deepslate variants.
 * @type {readonly {name:string, tier:number, item:string, min:number, max:number}[]}
 */
const ORES = Object.freeze([
  { name: 'coal', tier: TOOL_TIER.WOOD, item: 'coal', min: 1, max: 1 },
  { name: 'iron', tier: TOOL_TIER.STONE, item: 'raw_iron', min: 1, max: 1 },
  { name: 'copper', tier: TOOL_TIER.STONE, item: 'raw_copper', min: 2, max: 5 },
  { name: 'gold', tier: TOOL_TIER.IRON, item: 'raw_gold', min: 1, max: 1 },
  { name: 'redstone', tier: TOOL_TIER.IRON, item: 'redstone', min: 4, max: 5 },
  { name: 'lapis', tier: TOOL_TIER.STONE, item: 'lapis_lazuli', min: 4, max: 9 },
  { name: 'diamond', tier: TOOL_TIER.IRON, item: 'diamond', min: 1, max: 1 },
  { name: 'emerald', tier: TOOL_TIER.IRON, item: 'emerald', min: 1, max: 1 }
]);

for (const o of ORES) {
  oreBlock(`${o.name}_ore`, {
    toolTier: o.tier, dropItem: o.item, dropMin: o.min, dropMax: o.max
  });
  oreBlock(`deepslate_${o.name}_ore`, {
    hardness: 4.5, toolTier: o.tier, dropItem: o.item, dropMin: o.min, dropMax: o.max
  });
}

oreBlock('ancient_debris', {
  hardness: 30, toolTier: TOOL_TIER.DIAMOND, dropKind: 'simple',
  tex: { top: 'ancient_debris_top', side: 'ancient_debris_side', bottom: 'ancient_debris_top' }
});

// ---------------------------------------------------------------------------
// 7. Mineral storage blocks
// ---------------------------------------------------------------------------

mineralBlock('coal_block', { toolTier: TOOL_TIER.WOOD, sound: 'stone' });
mineralBlock('iron_block');
mineralBlock('copper_block', { hardness: 3 });
mineralBlock('oxidized_copper', { hardness: 3 });
mineralBlock('cut_copper', { hardness: 3 });
mineralBlock('raw_iron_block');
mineralBlock('gold_block', { hardness: 3, toolTier: TOOL_TIER.IRON });
mineralBlock('diamond_block', { toolTier: TOOL_TIER.IRON });
mineralBlock('emerald_block', { toolTier: TOOL_TIER.IRON });
mineralBlock('lapis_block', { hardness: 3, sound: 'stone' });
mineralBlock('redstone_block', { hardness: 5, sound: 'stone' });
mineralBlock('netherite_block', { hardness: 50, toolTier: TOOL_TIER.DIAMOND });

// ---------------------------------------------------------------------------
// 8. Utility blocks (crafting, storage, machines)
// ---------------------------------------------------------------------------

timber('crafting_table', {
  hardness: 2.5,
  tex: {
    top: 'crafting_table_top', bottom: 'oak_planks', side: 'crafting_table_side',
    north: 'crafting_table_front', south: 'crafting_table_front'
  }
});
rock('furnace', {
  hardness: 3.5,
  tex: { top: 'furnace_top', bottom: 'furnace_bottom', side: 'furnace_side', north: 'furnace_front' }
});
rock('blast_furnace', {
  hardness: 3.5,
  tex: {
    top: 'blast_furnace_top', bottom: 'blast_furnace_top',
    side: 'blast_furnace_side', north: 'blast_furnace_front'
  }
});
timber('chest', {
  hardness: 2.5, shape: 'chest', opaque: false, transparent: true, absorb: 0,
  tex: { top: 'chest_top', bottom: 'chest_bottom', side: 'chest_side', north: 'chest_front' }
});
timber('barrel', {
  hardness: 2.5,
  tex: { top: 'barrel_top', bottom: 'barrel_bottom', side: 'barrel_side' }
});
timber('bookshelf', {
  hardness: 1.5, tex: { side: 'bookshelf', top: 'oak_planks', bottom: 'oak_planks' },
  dropKind: 'range', dropItem: 'book', dropMin: 3, dropMax: 3
});
timber('note_block', { hardness: 0.8 });
timber('jukebox', {
  hardness: 2, tex: { top: 'jukebox_top', side: 'jukebox_side', bottom: 'jukebox_side' }
});
defineBlock('tnt', {
  hardness: 0, sound: 'grass', flammable: true,
  tex: { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' }
});
rock('dispenser', {
  hardness: 3.5,
  tex: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', north: 'dispenser_front' }
});
rock('piston', {
  hardness: 1.5,
  tex: { top: 'piston_front', bottom: 'piston_bottom', side: 'piston_side' }
});
rock('sticky_piston', {
  hardness: 1.5,
  tex: { top: 'sticky_piston_front', bottom: 'piston_bottom', side: 'piston_side' }
});
timber('observer', {
  hardness: 3, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'stone',
  flammable: false,
  tex: {
    top: 'observer_top', bottom: 'observer_top', north: 'observer_front',
    south: 'observer_back', east: 'observer_side', west: 'observer_side'
  }
});
defineBlock('hopper', {
  hardness: 3, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'metal',
  render: RENDER.MODEL, shape: 'hopper', opaque: false, transparent: true, absorb: 0,
  tex: { top: 'hopper_top', side: 'hopper_side', bottom: 'hopper_bottom' }
});
defineBlock('anvil', {
  hardness: 5, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'metal',
  render: RENDER.MODEL, shape: 'anvil', opaque: false, transparent: true, absorb: 0,
  tex: { top: 'anvil_top', side: 'anvil_side', bottom: 'anvil_side' }
});
defineBlock('enchanting_table', {
  hardness: 5, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'stone',
  render: RENDER.MODEL, shape: 'enchanting_table', opaque: false, transparent: true,
  absorb: 0,
  tex: {
    top: 'enchanting_table_top', side: 'enchanting_table_side',
    bottom: 'enchanting_table_bottom'
  }
});
defineBlock('brewing_stand', {
  hardness: 0.5, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'metal',
  render: RENDER.MODEL, shape: 'brewing_stand', cutout: true, opaque: false,
  transparent: true, absorb: 0, emission: [1, 1, 1], tex: 'brewing_stand'
});
defineBlock('cauldron', {
  hardness: 2, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'metal',
  render: RENDER.MODEL, shape: 'cauldron', opaque: false, transparent: true, absorb: 0,
  tex: { top: 'cauldron_top', side: 'cauldron_side', bottom: 'cauldron_bottom' }
});
defineBlock('beacon', {
  hardness: 3, sound: 'glass', cutout: true, transparent: true, opaque: false,
  absorb: 0, emission: [15, 15, 15], tex: 'beacon'
});
defineBlock('spawner', {
  hardness: 5, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'metal',
  cutout: true, transparent: true, opaque: false, absorb: 0, drops: null,
  tex: 'spawner'
});
defineBlock('end_portal_frame', {
  hardness: -1, sound: 'glass', render: RENDER.MODEL, shape: 'portal_frame',
  opaque: false, transparent: true, absorb: 0, emission: [1, 1, 1], drops: null,
  tex: { top: 'end_portal_frame_top', side: 'end_portal_frame_side', bottom: 'end_stone' }
});
defineBlock('nether_portal', {
  hardness: -1, render: RENDER.MODEL, shape: 'empty', solid: false, opaque: false,
  transparent: true, cutout: true, absorb: 0, replaceable: true,
  emission: [8, 3, 11], tex: 'nether_portal', drops: null, sound: 'glass'
});
defineBlock('end_portal', {
  hardness: -1, render: RENDER.MODEL, shape: 'empty', solid: false, opaque: false,
  transparent: true, absorb: 0, replaceable: true, emission: [15, 15, 15],
  tex: 'end_portal', drops: null, sound: 'glass'
});

// ---------------------------------------------------------------------------
// 9. Light sources & small models
// ---------------------------------------------------------------------------

defineBlock('torch', {
  hardness: 0, render: RENDER.TORCH, shape: 'torch', solid: false, opaque: false,
  transparent: true, cutout: true, absorb: 0, sound: 'wood', flammable: false,
  emission: [14, 11, 7], tex: 'torch'
});
defineBlock('soul_torch', {
  hardness: 0, render: RENDER.TORCH, shape: 'torch', solid: false, opaque: false,
  transparent: true, cutout: true, absorb: 0, sound: 'wood',
  emission: [4, 8, 10], tex: 'soul_torch'
});
defineBlock('redstone_torch', {
  hardness: 0, render: RENDER.TORCH, shape: 'torch', solid: false, opaque: false,
  transparent: true, cutout: true, absorb: 0, sound: 'wood',
  emission: [7, 0, 0], tex: 'redstone_torch'
});
defineBlock('lantern', {
  hardness: 3.5, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'metal',
  render: RENDER.MODEL, shape: 'lantern', solid: true, opaque: false,
  transparent: true, cutout: true, absorb: 0, emission: [15, 13, 10], tex: 'lantern'
});
defineBlock('soul_lantern', {
  hardness: 3.5, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'metal',
  render: RENDER.MODEL, shape: 'lantern', solid: true, opaque: false,
  transparent: true, cutout: true, absorb: 0, emission: [4, 8, 10], tex: 'soul_lantern'
});
defineBlock('campfire', {
  hardness: 2, toolType: 'axe', sound: 'wood', flammable: false,
  render: RENDER.MODEL, shape: 'campfire', solid: true, opaque: false,
  transparent: true, cutout: true, absorb: 0, emission: [15, 11, 5],
  tex: { top: 'campfire_fire', side: 'campfire_log', bottom: 'campfire_log' },
  dropKind: 'range', dropItem: 'charcoal', dropMin: 2, dropMax: 2
});
defineBlock('redstone_lamp', {
  hardness: 0.3, sound: 'glass', tex: 'redstone_lamp_off'
});
defineBlock('lit_redstone_lamp', {
  hardness: 0.3, sound: 'glass', tex: 'redstone_lamp_on', emission: [15, 12, 8],
  drops: 'redstone_lamp'
});

// ---------------------------------------------------------------------------
// 10. Redstone components
// ---------------------------------------------------------------------------

defineBlock('redstone_wire', {
  hardness: 0, render: RENDER.MODEL, shape: 'flat', solid: false, opaque: false,
  transparent: true, cutout: true, absorb: 0, tex: 'redstone_dust',
  drops: 'redstone', sound: 'stone'
});
defineBlock('repeater', {
  hardness: 0, render: RENDER.MODEL, shape: 'repeater', solid: false, opaque: false,
  transparent: true, cutout: true, absorb: 0, tex: 'repeater', sound: 'stone'
});
defineBlock('comparator', {
  hardness: 0, render: RENDER.MODEL, shape: 'repeater', solid: false, opaque: false,
  transparent: true, cutout: true, absorb: 0, tex: 'comparator', sound: 'stone'
});
defineBlock('lever', {
  hardness: 0.5, render: RENDER.MODEL, shape: 'lever', solid: false, opaque: false,
  transparent: true, cutout: true, absorb: 0, tex: 'lever', sound: 'wood'
});
defineBlock('stone_button', {
  hardness: 0.5, toolType: 'pickaxe', render: RENDER.MODEL, shape: 'button',
  solid: false, opaque: false, transparent: true, cutout: true, absorb: 0,
  tex: 'button', sound: 'stone'
});
defineBlock('stone_pressure_plate', {
  hardness: 0.5, toolType: 'pickaxe', render: RENDER.MODEL, shape: 'plate',
  solid: false, opaque: false, transparent: true, cutout: true, absorb: 0,
  tex: 'pressure_plate', sound: 'stone'
});
defineBlock('rail', {
  hardness: 0.7, toolType: 'pickaxe', render: RENDER.MODEL, shape: 'flat',
  solid: false, opaque: false, transparent: true, cutout: true, absorb: 0,
  tex: 'rail', sound: 'metal'
});
defineBlock('powered_rail', {
  hardness: 0.7, toolType: 'pickaxe', render: RENDER.MODEL, shape: 'flat',
  solid: false, opaque: false, transparent: true, cutout: true, absorb: 0,
  tex: 'powered_rail', sound: 'metal', emission: [2, 0, 0]
});

// ---------------------------------------------------------------------------
// 11. Doors, trapdoors, fences, ladders, scaffolding
// ---------------------------------------------------------------------------

defineBlock('oak_door', {
  hardness: 3, toolType: 'axe', sound: 'wood', flammable: true,
  render: RENDER.MODEL, shape: 'door', opaque: false, transparent: true,
  cutout: true, absorb: 0, maxStack: 64,
  tex: { all: 'oak_door_bottom', top: 'oak_door_top' }
});
defineBlock('oak_trapdoor', {
  hardness: 3, toolType: 'axe', sound: 'wood', flammable: true,
  render: RENDER.MODEL, shape: 'trapdoor', opaque: false, transparent: true,
  cutout: true, absorb: 0, tex: 'oak_trapdoor'
});
defineBlock('oak_fence', {
  hardness: 2, toolType: 'axe', sound: 'wood', flammable: true,
  render: RENDER.MODEL, shape: 'fence', opaque: false, transparent: true,
  cutout: true, absorb: 0, tex: 'oak_planks'
});
defineBlock('oak_fence_gate', {
  hardness: 2, toolType: 'axe', sound: 'wood', flammable: true,
  render: RENDER.MODEL, shape: 'fence_gate', opaque: false, transparent: true,
  cutout: true, absorb: 0, tex: 'oak_planks'
});
defineBlock('ladder', {
  hardness: 0.4, toolType: 'axe', sound: 'wood', flammable: true,
  render: RENDER.MODEL, shape: 'ladder', solid: false, opaque: false,
  transparent: true, cutout: true, absorb: 0, tex: 'ladder'
});
defineBlock('scaffolding', {
  hardness: 0, toolType: 'axe', sound: 'wood', flammable: true,
  render: RENDER.MODEL, shape: 'scaffolding', opaque: false, transparent: true,
  cutout: true, absorb: 0, tex: 'scaffolding'
});

// ---------------------------------------------------------------------------
// 12. Stairs & slabs (stone / cobblestone / oak planks)
// ---------------------------------------------------------------------------

/**
 * Register the stairs + slab pair of a base block.
 * @param {string} prefix name prefix, e.g. `'cobblestone'`
 * @param {string} texture material name for every face
 * @param {Object} base shared BlockDef overrides (hardness, tool, sound …)
 * @returns {void}
 */
function defineStairsAndSlab(prefix, texture, base) {
  defineBlock(`${prefix}_stairs`, {
    ...base, render: RENDER.STAIRS, shape: 'stairs', tex: texture,
    opaque: false, transparent: true, absorb: 15
  });
  defineBlock(`${prefix}_slab`, {
    ...base, render: RENDER.SLAB, shape: 'slab', tex: texture,
    opaque: false, transparent: true, absorb: 15
  });
}

defineStairsAndSlab('stone', 'stone', {
  hardness: 1.5, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'stone'
});
defineStairsAndSlab('cobblestone', 'cobblestone', {
  hardness: 2, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'stone'
});
defineStairsAndSlab('oak', 'oak_planks', {
  hardness: 2, toolType: 'axe', sound: 'wood', flammable: true
});

// ---------------------------------------------------------------------------
// 13. Wool, concrete, terracotta
// ---------------------------------------------------------------------------

/**
 * The 16 vanilla dye colours, in the order used by `world/materials.js`.
 * @type {readonly string[]}
 */
export const DYE_COLORS = Object.freeze([
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
]);

for (const c of DYE_COLORS) {
  defineBlock(`${c}_wool`, {
    hardness: 0.8, toolType: 'shears', sound: 'wool', flammable: true,
    tex: `${c}_wool`
  });
}
for (const c of DYE_COLORS) {
  defineBlock(`${c}_concrete`, {
    hardness: 1.8, toolType: 'pickaxe', toolTier: TOOL_TIER.WOOD, sound: 'stone',
    tex: `${c}_concrete`
  });
}

/** Terracotta colours that have their own material layer. @type {readonly string[]} */
const TERRACOTTA_COLORS = Object.freeze([
  'white', 'orange', 'yellow', 'brown', 'red', 'light_gray', 'cyan', 'green'
]);

rock('terracotta', { hardness: 1.25 });
for (const c of TERRACOTTA_COLORS) {
  rock(`${c}_terracotta`, { hardness: 1.25, tex: `${c}_terracotta` });
}
for (const c of ['white', 'cyan', 'magenta', 'lime']) {
  rock(`${c}_glazed_terracotta`, { hardness: 1.4, tex: `${c}_glazed_terracotta` });
}

// ---------------------------------------------------------------------------
// 14. Plants, flowers, crops
// ---------------------------------------------------------------------------

plant('short_grass', {
  tint: 'grass', tex: 'short_grass', dropKind: 'grass_plant', shearDrop: 'short_grass'
});
plant('tall_grass', {
  tint: 'grass', tex: 'tall_grass_top', dropKind: 'grass_plant', shearDrop: 'tall_grass'
});
plant('fern', {
  tint: 'grass', tex: 'fern', dropKind: 'grass_plant', shearDrop: 'fern'
});
plant('dead_bush', {
  tex: 'dead_bush', dropKind: 'dead_bush', shearDrop: 'dead_bush'
});
plant('dandelion', { tex: 'dandelion' });
plant('poppy', { tex: 'poppy' });
plant('blue_orchid', { tex: 'blue_orchid' });
plant('allium', { tex: 'allium' });
plant('cornflower', { tex: 'cornflower' });
plant('oxeye_daisy', { tex: 'oxeye_daisy' });
plant('sunflower', { tex: 'sunflower_top' });
plant('brown_mushroom', {
  tex: 'brown_mushroom', waves: false, emission: [1, 1, 1], sound: 'grass'
});
plant('red_mushroom', { tex: 'red_mushroom', waves: false, sound: 'grass' });
plant('sugar_cane', { tex: 'sugar_cane', replaceable: false });
plant('bamboo', {
  tex: 'bamboo', shape: 'bamboo', solid: true, replaceable: false, sound: 'wood',
  dropKind: 'range', dropItem: 'bamboo', dropMin: 1, dropMax: 2
});
plant('kelp', {
  tex: 'kelp', tint: 'water', waterloggable: true, sound: 'grass', flammable: false
});
plant('seagrass', {
  tex: 'seagrass', tint: 'water', waterloggable: true, sound: 'grass',
  flammable: false, dropKind: 'shear_only', shearDrop: 'seagrass'
});
plant('vine', {
  tex: 'vine', tint: 'foliage', dropKind: 'shear_only', shearDrop: 'vine',
  replaceable: false
});
defineBlock('cobweb', {
  hardness: 4, toolType: 'shears', altTools: ['sword'], requiresTool: true,
  render: RENDER.CROSS, shape: 'empty', solid: false, opaque: false,
  transparent: true, cutout: true, absorb: 1, sound: 'wool', tex: 'cobweb',
  dropKind: 'cobweb', shearDrop: 'cobweb'
});

defineBlock('cactus', {
  hardness: 0.4, sound: 'wool', shape: 'cactus', cutout: true, transparent: true,
  opaque: false, absorb: 15,
  tex: { top: 'cactus_top', side: 'cactus_side', bottom: 'cactus_bottom' }
});

/**
 * Register a four-stage crop. Stage 3 is mature.
 * @param {string} prefix crop name prefix, e.g. `'carrots'`
 * @param {readonly string[]} textures four material names, one per stage
 * @param {string} seed item dropped as seed
 * @param {string} product item dropped when mature
 * @param {string|null} extra rare extra drop when mature (poisonous potato)
 * @returns {void}
 */
function defineCrop(prefix, textures, seed, product, extra) {
  for (let stage = 0; stage < 4; stage++) {
    plant(`${prefix}_stage${stage}`, {
      tex: textures[stage], replaceable: false, tint: null, flammable: false,
      dropKind: 'crop', cropMature: stage === 3, cropSeed: seed,
      cropProduct: product, cropExtra: stage === 3 ? extra : null
    });
  }
}

defineCrop('wheat', ['wheat_stage0', 'wheat_stage1', 'wheat_stage2', 'wheat_stage3'],
  'wheat_seeds', 'wheat', null);
defineCrop('carrots', ['wheat_stage0', 'wheat_stage1', 'carrots', 'carrots'],
  'carrot', 'carrot', null);
defineCrop('potatoes', ['wheat_stage0', 'wheat_stage1', 'potatoes', 'potatoes'],
  'potato', 'potato', 'poisonous_potato');
defineCrop('beetroot', ['wheat_stage0', 'wheat_stage1', 'beetroot', 'beetroot'],
  'beetroot_seeds', 'beetroot', null);

// ---------------------------------------------------------------------------
// 15. Fruit, coral & misc natural blocks
// ---------------------------------------------------------------------------

timber('pumpkin', {
  hardness: 1, tex: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side' }
});
timber('carved_pumpkin', {
  hardness: 1,
  tex: {
    top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side',
    north: 'carved_pumpkin'
  }
});
timber('jack_o_lantern', {
  hardness: 1, emission: [15, 12, 6],
  tex: {
    top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side',
    north: 'jack_o_lantern'
  }
});
timber('melon', {
  hardness: 1, tex: { top: 'melon_top', bottom: 'melon_top', side: 'melon_side' },
  dropKind: 'range', dropItem: 'melon_slice', dropMin: 3, dropMax: 7
});

for (const coral of ['tube', 'brain', 'bubble', 'fire', 'horn']) {
  rock(`${coral}_coral_block`, { tex: `coral_${coral}`, drops: null });
}

defineBlock('sponge', { hardness: 0.6, toolType: 'hoe', sound: 'grass' });
defineBlock('wet_sponge', { hardness: 0.6, toolType: 'hoe', sound: 'grass' });
defineBlock('hay_block', {
  hardness: 0.5, toolType: 'hoe', sound: 'grass', flammable: true,
  tex: { top: 'hay_block_top', bottom: 'hay_block_top', side: 'hay_block_side' }
});
defineBlock('slime_block', {
  hardness: 0, sound: 'wool', cutout: false, transparent: true, opaque: false,
  absorb: 0, tex: 'slime_block'
});
defineBlock('honey_block', {
  hardness: 0, sound: 'wool', cutout: false, transparent: true, opaque: false,
  absorb: 0, tex: 'honey_block'
});

// ---------------------------------------------------------------------------
// Precomputed lookup tables
// ---------------------------------------------------------------------------

/** Number of registered blocks. @type {number} */
export const BLOCK_COUNT = BLOCKS.length;

/** Face order used everywhere: 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z. @type {number} */
export const FACE_COUNT = 6;

/**
 * Resolve which material name a face uses, honouring the all/side/top fallbacks.
 * @param {Object} t textures record from a BlockDef
 * @param {number} face face index 0..5
 * @returns {string|null} material name or null when the face is untextured
 */
function faceTextureName(t, face) {
  switch (face) {
    case 0: return t.east ?? t.side ?? t.all ?? null;
    case 1: return t.west ?? t.side ?? t.all ?? null;
    case 2: return t.top ?? t.all ?? null;
    case 3: return t.bottom ?? t.top ?? t.all ?? null;
    case 4: return t.south ?? t.side ?? t.all ?? null;
    case 5: return t.north ?? t.side ?? t.all ?? null;
    default: return t.all ?? null;
  }
}

/** face -> texture-array layer, `id * 6 + face`. @type {Uint16Array} */
const FACE_MATERIAL = new Uint16Array(BLOCK_COUNT * FACE_COUNT);
/** material flag byte per block. @type {Uint8Array} */
const FLAGS = new Uint8Array(BLOCK_COUNT);
/** light absorption per block, 0..15. @type {Uint8Array} */
const ABSORB = new Uint8Array(BLOCK_COUNT);
/** colored emission per block, `id * 3 + channel`, each 0..15. @type {Uint8Array} */
const EMISSION = new Uint8Array(BLOCK_COUNT * 3);
/** RENDER.* per block. @type {Uint8Array} */
const RENDER_KIND = new Uint8Array(BLOCK_COUNT);
/** packed boolean properties per block (see `BIT`). @type {Uint8Array} */
const BITS = new Uint8Array(BLOCK_COUNT);

for (let i = 0; i < BLOCK_COUNT; i++) {
  const def = BLOCKS[i];
  for (let f = 0; f < FACE_COUNT; f++) {
    const texName = faceTextureName(def.textures, f);
    FACE_MATERIAL[i * FACE_COUNT + f] = texName ? materialLayer(texName) : 0;
  }
  FLAGS[i] = def.flags;
  ABSORB[i] = Math.max(0, Math.min(15, def.absorb | 0));
  EMISSION[i * 3] = Math.max(0, Math.min(15, def.emission[0] | 0));
  EMISSION[i * 3 + 1] = Math.max(0, Math.min(15, def.emission[1] | 0));
  EMISSION[i * 3 + 2] = Math.max(0, Math.min(15, def.emission[2] | 0));
  RENDER_KIND[i] = def.render;
  let bits = 0;
  if (def.solid) bits |= BIT.SOLID;
  if (def.opaque) bits |= BIT.OPAQUE;
  if (def.cutout) bits |= BIT.CUTOUT;
  if (def.transparent) bits |= BIT.TRANSPARENT;
  if (def.liquid) bits |= BIT.LIQUID;
  if (def.replaceable) bits |= BIT.REPLACEABLE;
  if (def.gravity) bits |= BIT.GRAVITY;
  if (def.waterloggable) bits |= BIT.WATERLOGGABLE;
  BITS[i] = bits;
  Object.freeze(def.textures);
  Object.freeze(def.drops);
  Object.freeze(def);
}

/**
 * Flat `id * 6 + face` texture-array layer table. Exposed so the mesher can
 * index it directly in its inner loop instead of calling `faceMaterial()`.
 * @type {Uint16Array}
 */
export const FACE_MATERIAL_TABLE = FACE_MATERIAL;

/**
 * Flat `id * 3 + channel` emission table (each channel 0..15) for the light
 * engine's inner loop.
 * @type {Uint8Array}
 */
export const EMISSION_RGB = EMISSION;

/**
 * Flat light-absorption table indexed by block id.
 * @type {Uint8Array}
 */
export const ABSORB_TABLE = ABSORB;

/**
 * Flat material-flag-byte table indexed by block id (see 3.1).
 * @type {Uint8Array}
 */
export const FLAG_TABLE = FLAGS;

// Extra convenience aliases. Every one of these points at a real block whose
// own uppercased name is already present, so the `B.NAME === id of 'name'`
// derivation stays intact.
B.WHEAT = B.WHEAT_STAGE3;
B.CARROTS = B.CARROTS_STAGE3;
B.POTATOES = B.POTATOES_STAGE3;
B.BEETROOT = B.BEETROOT_STAGE3;
B.HAY_BALE = B.HAY_BLOCK;
B.GRASS = B.SHORT_GRASS;
B.SNOW = B.SNOW_LAYER;
B.MAGMA = B.MAGMA_BLOCK;
B.PORTAL_FRAME = B.END_PORTAL_FRAME;
B.BUTTON = B.STONE_BUTTON;
B.PRESSURE_PLATE = B.STONE_PRESSURE_PLATE;
B.DOOR = B.OAK_DOOR;
B.TRAPDOOR = B.OAK_TRAPDOOR;
B.FENCE = B.OAK_FENCE;
B.FENCE_GATE = B.OAK_FENCE_GATE;
B.PLANKS = B.OAK_PLANKS;
B.LOG = B.OAK_LOG;
B.LEAVES = B.OAK_LEAVES;
B.SAND_BLOCK = B.SAND;
B.STILL_WATER = B.WATER;
B.STILL_LAVA = B.LAVA;
Object.freeze(B);

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Definition of a block id. Never throws — unknown ids resolve to air.
 * @param {number} id block id
 * @returns {BlockDef} the block definition (air for unknown ids)
 */
export function getBlock(id) {
  const def = BLOCKS[id];
  return def !== undefined ? def : BLOCKS[0];
}

/**
 * Definition of a block name.
 * @param {string} name snake_case block name
 * @returns {BlockDef} the block definition (air for unknown names)
 */
export function blockByName(name) {
  return BLOCK_BY_NAME.get(name) ?? BLOCKS[0];
}

/**
 * Does the block have a collision shape entities must resolve against?
 * @param {number} id block id
 * @returns {boolean} true for solid blocks
 */
export function isSolid(id) {
  return (BITS[id] & BIT.SOLID) !== 0;
}

/**
 * Is the block a full, fully occluding cube? Used by the mesher for face
 * culling and by the light engine for sky-light termination.
 * @param {number} id block id
 * @returns {boolean} true when fully opaque
 */
export function isOpaque(id) {
  return (BITS[id] & BIT.OPAQUE) !== 0;
}

/**
 * Is the block a fluid (water/lava)?
 * @param {number} id block id
 * @returns {boolean} true for fluids
 */
export function isLiquid(id) {
  return (BITS[id] & BIT.LIQUID) !== 0;
}

/**
 * Does the block render with alpha testing (hard cutout mask)?
 * @param {number} id block id
 * @returns {boolean} true for cutout blocks
 */
export function isCutout(id) {
  return (BITS[id] & BIT.CUTOUT) !== 0;
}

/**
 * Does light and sight pass through the block at all (i.e. it is not a full
 * opaque cube)?
 * @param {number} id block id
 * @returns {boolean} true for non-opaque blocks
 */
export function isTransparent(id) {
  return (BITS[id] & BIT.TRANSPARENT) !== 0;
}

/**
 * Can a placement overwrite this block (air, fluids, grass, snow layers)?
 * @param {number} id block id
 * @returns {boolean} true when replaceable
 */
export function isReplaceable(id) {
  return (BITS[id] & BIT.REPLACEABLE) !== 0;
}

/**
 * Does the block fall when unsupported (sand, gravel)?
 * @param {number} id block id
 * @returns {boolean} true for gravity-affected blocks
 */
export function hasGravity(id) {
  return (BITS[id] & BIT.GRAVITY) !== 0;
}

/**
 * Can the block hold water in the same voxel (fences, slabs, panes)?
 * @param {number} id block id
 * @returns {boolean} true when waterloggable
 */
export function isWaterloggable(id) {
  return (BITS[id] & BIT.WATERLOGGABLE) !== 0;
}

/**
 * Colored light emitted by the block. The returned array is the block's shared
 * frozen triple — read it, never mutate it. Use `EMISSION_RGB` for hot loops.
 * @param {number} id block id
 * @returns {readonly number[]} `[r, g, b]`, each 0..15
 */
export function lightEmission(id) {
  return getBlock(id).emission;
}

/**
 * How much a light level is reduced when crossing this block: 0 for glass and
 * air, 1 for water/ice/leaves/cobweb, 15 for solid opaque blocks.
 * @param {number} id block id
 * @returns {number} absorption 0..15
 */
export function lightAbsorb(id) {
  const a = ABSORB[id];
  return a === undefined ? 0 : a;
}

/**
 * Texture-array layer for one face of a block. O(1), allocation free.
 * @param {number} id block id
 * @param {number} face face direction 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z
 * @returns {number} layer index into the albedo/normal/mrae texture arrays
 */
export function faceMaterial(id, face) {
  const i = id * FACE_COUNT + face;
  const layer = FACE_MATERIAL[i];
  return layer === undefined ? 0 : layer;
}

/**
 * Which biome tint the mesher must multiply onto this block's albedo.
 * @param {number} id block id
 * @returns {('grass'|'foliage'|'water'|null)} tint channel name, or null
 */
export function blockTint(id) {
  return /** @type {('grass'|'foliage'|'water'|null)} */ (getBlock(id).tint);
}

/**
 * Material flag byte written into `a_tint.a` by the mesher: bit0 waves,
 * bit1 emissive, bit2 wet-capable, bit3 parallax.
 * @param {number} id block id
 * @returns {number} flag byte 0..255
 */
export function blockFlags(id) {
  const f = FLAGS[id];
  return f === undefined ? 0 : f;
}

/**
 * Render kind of the block.
 * @param {number} id block id
 * @returns {number} one of the `RENDER` values
 */
export function blockRender(id) {
  const r = RENDER_KIND[id];
  return r === undefined ? RENDER.NONE : r;
}

/**
 * Collision / selection boxes in block-local space. The returned array is a
 * shared frozen table — copy it before mutating.
 * @param {number} id block id
 * @param {number} [state] block state (see the state conventions at the top)
 * @returns {readonly (readonly number[])[]} list of `[minX,minY,minZ,maxX,maxY,maxZ]`
 */
export function blockAABBs(id, state = 0) {
  const def = getBlock(id);
  const table = def.aabbsByState;
  if (table === null) return def.aabbs;
  const n = table.length;
  let s = (state | 0) % n;
  if (s < 0) s += n;
  return table[s];
}

/**
 * Sound group used by `game/audio.js` for dig/step/place/hit sounds.
 * @param {number} id block id
 * @returns {('stone'|'wood'|'grass'|'gravel'|'sand'|'glass'|'metal'|'wool'|'snow'|'water')} group
 */
export function blockSound(id) {
  return /** @type {any} */ (getBlock(id).sound);
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

/**
 * Harvest level of a tool tier.
 * @param {number} tier a `TOOL_TIER` value
 * @returns {number} harvest level 0..5
 */
function harvestLevel(tier) {
  const h = TIER_HARVEST[tier | 0];
  return h === undefined ? 0 : h;
}

/**
 * Is `toolType` an appropriate tool for this block (so its tier speed and any
 * Efficiency enchantment apply)?
 * @param {BlockDef} def block definition
 * @param {string|null} toolType held tool class
 * @returns {boolean} true when the tool is the correct one
 */
function isCorrectTool(def, toolType) {
  if (!toolType) return false;
  if (toolType === def.toolType) return true;
  return def.altTools !== null && def.altTools.indexOf(toolType) !== -1;
}

/**
 * Can the held tool actually harvest this block (i.e. will it drop items)?
 * @param {number} id block id
 * @param {string|null} toolType tool class, e.g. `'pickaxe'`
 * @param {number} toolTier a `TOOL_TIER` value
 * @returns {boolean} true when the block drops its items
 */
export function canHarvest(id, toolType, toolTier) {
  const def = getBlock(id);
  if (def.hardness < 0) return false;
  if (!def.requiresTool) return true;
  if (!isCorrectTool(def, toolType)) return false;
  return harvestLevel(toolTier) >= harvestLevel(def.toolTier);
}

/**
 * Raw mining speed multiplier of a tool against a block, before Efficiency.
 * Mirrors the vanilla special cases for shears and swords.
 * @param {BlockDef} def block definition
 * @param {string|null} toolType tool class
 * @param {number} toolTier a `TOOL_TIER` value
 * @returns {number} speed multiplier (1 = bare hand)
 */
function baseToolSpeed(def, toolType, toolTier) {
  if (toolType === 'shears') {
    if (def.name === 'cobweb' || def.name.endsWith('_leaves')) return 15;
    if (def.sound === 'wool') return 5;
    if (def.render === RENDER.CROSS) return 5;
    return 1;
  }
  if (toolType === 'sword') {
    if (def.name === 'cobweb') return 15;
    if (def.name === 'bamboo') return 30;
    return 1.5;
  }
  if (!isCorrectTool(def, toolType)) return 1;
  const speed = TIER_SPEED[toolTier | 0];
  return speed === undefined ? 1 : speed;
}

/**
 * Time in seconds to break a block, using the vanilla formula:
 *
 *   `base = hardness * (canHarvest ? 1.5 : 5)`
 *   `time = base / speed`, where `speed` is the tool multiplier, raised by
 *   `efficiency^2 + 1` when the tool is the correct one, then divided by 5
 *   while airborne and again by 5 while in water without Aqua Affinity.
 *
 * Unbreakable blocks (`hardness < 0`) return `Infinity`; instant blocks return 0.
 * The result is quantised to whole game ticks, like the real game.
 *
 * @param {number} id block id
 * @param {string|null} toolType held tool class (`'pickaxe'`, `'axe'`, …) or null
 * @param {number} toolTier a `TOOL_TIER` value for the held tool
 * @param {number} [efficiency] Efficiency enchantment level (0 = none)
 * @param {boolean} [onGround] is the miner standing on the ground?
 * @param {boolean} [inWater] is the miner's head in water?
 * @param {boolean} [aquaAffinity] does the helmet have Aqua Affinity?
 * @returns {number} seconds needed to break the block
 */
export function breakTime(id, toolType, toolTier, efficiency = 0, onGround = true,
  inWater = false, aquaAffinity = false) {
  const def = getBlock(id);
  if (def.hardness < 0) return Infinity;
  if (def.hardness === 0) return 0;

  let speed = baseToolSpeed(def, toolType, toolTier);
  const eff = efficiency | 0;
  if (eff > 0 && speed > 1 && isCorrectTool(def, toolType)) speed += eff * eff + 1;
  if (inWater && !aquaAffinity) speed /= 5;
  if (!onGround) speed /= 5;
  if (speed <= 0) return Infinity;

  const base = def.hardness * (canHarvest(id, toolType, toolTier) ? 1.5 : 5);
  const seconds = base / speed;
  // Quantise to whole ticks; a block always takes at least one tick.
  return Math.max(0.05, Math.ceil(seconds * 20) / 20);
}

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

/**
 * Vanilla `ApplyBonusCount(oreDrops)`: fortune F rolls `rand(0..F+1) - 1` and
 * multiplies the base count by `max(0, roll) + 1`.
 * @param {number} fortune Fortune enchantment level
 * @param {() => number} rng random source returning 0..1
 * @returns {number} integer multiplier >= 1
 */
function fortuneOreMultiplier(fortune, rng) {
  if (fortune <= 0) return 1;
  const roll = Math.floor(rng() * (fortune + 2)) - 1;
  return 1 + (roll > 0 ? roll : 0);
}

/**
 * Uniform integer in `[min, max]`.
 * @param {number} min inclusive lower bound
 * @param {number} max inclusive upper bound
 * @param {() => number} rng random source returning 0..1
 * @returns {number} random integer
 */
function randInt(min, max, rng) {
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

/** Flint chance from gravel per Fortune level 0..3. @type {readonly number[]} */
const FLINT_CHANCE = Object.freeze([0.1, 0.14, 0.25, 1.0]);
/** Sapling chance from leaves per Fortune level 0..3. @type {readonly number[]} */
const SAPLING_CHANCE = Object.freeze([1 / 20, 1 / 16, 1 / 12, 1 / 10]);
/** Jungle sapling chance per Fortune level 0..3. @type {readonly number[]} */
const JUNGLE_SAPLING_CHANCE = Object.freeze([1 / 40, 1 / 36, 1 / 32, 1 / 24]);
/** Apple chance from oak/dark oak leaves per Fortune level 0..3. @type {readonly number[]} */
const APPLE_CHANCE = Object.freeze([1 / 200, 1 / 180, 1 / 160, 1 / 120]);
/** Stick chance from leaves per Fortune level 0..3. @type {readonly number[]} */
const STICK_CHANCE = Object.freeze([1 / 50, 1 / 45, 1 / 40, 1 / 30]);

/**
 * Pick a chance from a Fortune-indexed table, clamping the level to the table.
 * @param {readonly number[]} table chance per fortune level
 * @param {number} fortune Fortune level
 * @returns {number} probability 0..1
 */
function fortuneChance(table, fortune) {
  const i = fortune < 0 ? 0 : (fortune > table.length - 1 ? table.length - 1 : fortune | 0);
  return table[i];
}

/**
 * Items a block drops when mined, with vanilla no-silk-touch behaviour:
 * `grass_block` -> dirt, `stone` -> cobblestone, ores -> raw items or gems with
 * Fortune multipliers, leaves -> rare saplings/apples/sticks, gravel -> flint,
 * crops by growth stage, and `requiresTool` gating (a wrong or too-weak tool
 * yields nothing).
 *
 * @param {number} id block id
 * @param {string|null} toolType held tool class, or null for a bare hand
 * @param {number} toolTier a `TOOL_TIER` value for the held tool
 * @param {number} [fortune] Fortune enchantment level
 * @param {() => number} [rng] deterministic random source returning 0..1
 * @returns {{item:string, count:number}[]} freshly allocated drop list
 */
export function blockDrops(id, toolType, toolTier, fortune = 0, rng = Math.random) {
  /** @type {{item:string, count:number}[]} */
  const out = [];
  const def = getBlock(id);
  if (def.id === 0 || def.hardness < 0) return out;

  const rand = typeof rng === 'function' ? rng : Math.random;
  const f = fortune > 0 ? (fortune | 0) : 0;
  if (!canHarvest(id, toolType, toolTier)) return out;

  const sheared = toolType === 'shears';

  switch (def.dropKind) {
    case 'ore': {
      const item = def.dropItem;
      if (!item) break;
      const base = randInt(def.dropMin, def.dropMax, rand);
      out.push({ item, count: base * fortuneOreMultiplier(f, rand) });
      break;
    }
    case 'range': {
      const item = def.dropItem;
      if (!item) break;
      let count = randInt(def.dropMin, def.dropMax, rand);
      if (f > 0) count += randInt(0, f, rand);
      out.push({ item, count });
      break;
    }
    case 'gravel': {
      if (sheared) { out.push({ item: 'gravel', count: 1 }); break; }
      if (rand() < fortuneChance(FLINT_CHANCE, f)) out.push({ item: 'flint', count: 1 });
      else out.push({ item: 'gravel', count: 1 });
      break;
    }
    case 'leaves': {
      if (sheared) {
        out.push({ item: def.shearDrop ?? def.name, count: 1 });
        break;
      }
      const table = def.rareSapling ? JUNGLE_SAPLING_CHANCE : SAPLING_CHANCE;
      if (def.saplingItem && rand() < fortuneChance(table, f)) {
        out.push({ item: def.saplingItem, count: 1 });
      }
      if (def.appleDrop && rand() < fortuneChance(APPLE_CHANCE, f)) {
        out.push({ item: 'apple', count: 1 });
      }
      if (rand() < fortuneChance(STICK_CHANCE, f)) {
        out.push({ item: 'stick', count: randInt(1, 2, rand) });
      }
      break;
    }
    case 'crop': {
      if (!def.cropMature) {
        if (def.cropSeed) out.push({ item: def.cropSeed, count: 1 });
        break;
      }
      if (def.cropProduct) {
        let count = 1;
        if (def.cropProduct === def.cropSeed) count = randInt(1, 4, rand) + (f > 0 ? randInt(0, f, rand) : 0);
        out.push({ item: def.cropProduct, count });
      }
      if (def.cropSeed && def.cropSeed !== def.cropProduct) {
        out.push({ item: def.cropSeed, count: randInt(1, 4, rand) + (f > 0 ? randInt(0, f, rand) : 0) });
      }
      if (def.cropExtra && rand() < 0.02) out.push({ item: def.cropExtra, count: 1 });
      break;
    }
    case 'grass_plant': {
      if (sheared) { out.push({ item: def.shearDrop ?? def.name, count: 1 }); break; }
      const chance = 0.125 + f * 0.0625;
      if (rand() < chance) out.push({ item: 'wheat_seeds', count: 1 });
      break;
    }
    case 'dead_bush': {
      if (sheared) { out.push({ item: 'dead_bush', count: 1 }); break; }
      const sticks = randInt(0, 2, rand);
      if (sticks > 0) out.push({ item: 'stick', count: sticks });
      break;
    }
    case 'shear_only': {
      if (sheared) out.push({ item: def.shearDrop ?? def.name, count: 1 });
      break;
    }
    case 'cobweb': {
      if (sheared) out.push({ item: 'cobweb', count: 1 });
      else out.push({ item: 'string', count: 1 });
      break;
    }
    default: {
      for (let i = 0; i < def.drops.length; i++) {
        out.push({ item: def.drops[i].item, count: def.drops[i].count });
      }
      break;
    }
  }
  return out;
}

// One-time integrity report: catches typos in the table above without ever
// throwing during play. Runs at import time only.
{
  const seen = new Set();
  const problems = [];
  for (const def of BLOCKS) {
    if (seen.has(def.name)) problems.push(`duplicate name ${def.name}`);
    seen.add(def.name);
    if (B[def.name.toUpperCase()] !== def.id) problems.push(`B constant mismatch for ${def.name}`);
  }
  if (BLOCK_COUNT < 110) problems.push(`only ${BLOCK_COUNT} blocks registered, expected >= 110`);
  if (problems.length) console.warn(`[blocks] registry problems: ${problems.join(', ')}`);
}
