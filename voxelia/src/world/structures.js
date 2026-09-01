/**
 * VOXELIA — `world/structures.js` (spec 5.10)
 *
 * Every structure, tree and plant the world generator can stamp into the
 * world. All generators are **pure writers**: they receive a
 * `setBlock(x, y, z, id)` callback that takes **absolute world coordinates**
 * and never read the world back. `world/worldgen.js` owns that callback and
 * routes writes that leave the chunk currently being generated into its
 * pending-edit map, so a tree straddling a chunk border is always complete.
 *
 * ## Conventions
 *
 * - `(x, y, z)` passed to `placeTree` / `placeVegetation` is the **ground
 *   block** — the topmost solid voxel. The plant/trunk starts at `y + 1`.
 * - `(x, y, z)` passed to the room-like generators (`placeDungeon`,
 *   `placeStrongholdRoom`, `placeRuins`, ...) is the **floor centre**: the
 *   first walkable air voxel. Floors are written at `y - 1`.
 * - Leaves are always written **before** logs so a trunk is never eaten by its
 *   own canopy (the callback cannot be queried, so ordering is the only
 *   defence).
 * - Every generator is deterministic in `rng`: the same seeded generator
 *   always produces the same blocks, in the same order.
 *
 * ## Block palette substitutions
 *
 * `world/blocks.js` has no mangrove wood, no mushroom-block family and no
 * powder snow, so a few structures use documented stand-ins (oak for mangrove,
 * quartz + terracotta for giant mushroom caps). Everything else uses the real
 * block.
 *
 * No `window`/`document` access — safe to import inside a module Web Worker.
 *
 * @module world/structures
 */

import { B, BLOCK_BY_NAME } from './blocks.js';
import { getBiome } from './biomes.js';
import { SEA_LEVEL } from './chunk.js';
import { mulberry32, xxhash32, clamp } from '../core/math.js';

/* -------------------------------------------------------------------------- */
/* Block lookup helpers                                                        */
/* -------------------------------------------------------------------------- */

/** @type {Map<string, number>} memoised `name -> id`, `-1` when unknown */
const NAME_CACHE = new Map();

/**
 * Resolve a block name to its id, with a fallback for names that this build's
 * block registry does not define.
 * @param {string} name snake_case block name
 * @param {number} [fallback=0] id returned when the block does not exist
 * @returns {number} block id
 */
function blockId(name, fallback = 0) {
  let v = NAME_CACHE.get(name);
  if (v === undefined) {
    const def = BLOCK_BY_NAME.get(name);
    v = def === undefined ? -1 : def.id;
    NAME_CACHE.set(name, v);
  }
  return v < 0 ? fallback : v;
}

/** Air. @type {number} */
const AIR = B.AIR;

/** Per-species trunk block ids. @type {Object<string, number>} */
const LOG_OF = Object.freeze({
  oak: B.OAK_LOG,
  spruce: B.SPRUCE_LOG,
  birch: B.BIRCH_LOG,
  jungle: B.JUNGLE_LOG,
  acacia: B.ACACIA_LOG,
  dark_oak: B.DARK_OAK_LOG,
  cherry: B.CHERRY_LOG,
});

/** Per-species leaf block ids. @type {Object<string, number>} */
const LEAF_OF = Object.freeze({
  oak: B.OAK_LEAVES,
  spruce: B.SPRUCE_LEAVES,
  birch: B.BIRCH_LEAVES,
  jungle: B.JUNGLE_LEAVES,
  acacia: B.ACACIA_LEAVES,
  dark_oak: B.DARK_OAK_LEAVES,
  cherry: B.CHERRY_LEAVES,
});

/** Coral block palette used by warm-ocean reefs. @type {number[]} */
const CORAL_BLOCKS = [
  B.TUBE_CORAL_BLOCK, B.BRAIN_CORAL_BLOCK, B.BUBBLE_CORAL_BLOCK,
  B.FIRE_CORAL_BLOCK, B.HORN_CORAL_BLOCK,
];

/** Berry bush stand-in — this registry has no `sweet_berry_bush`. @type {number} */
const BERRY_BUSH = blockId('sweet_berry_bush', B.SHORT_GRASS);

/* -------------------------------------------------------------------------- */
/* Small numeric helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Uniform integer in `[lo, hi]`.
 * @param {() => number} rng random source in `[0, 1)`
 * @param {number} lo inclusive lower bound
 * @param {number} hi inclusive upper bound
 * @returns {number} random integer
 */
function randInt(rng, lo, hi) {
  if (hi <= lo) return lo;
  const v = lo + ((rng() * (hi - lo + 1)) | 0);
  return v > hi ? hi : v;
}

/**
 * Pick a uniformly random element of an array.
 * @template T
 * @param {() => number} rng random source
 * @param {readonly T[]} arr non-empty array
 * @returns {T} random element
 */
function pick(rng, arr) {
  const n = arr.length;
  if (n === 0) return undefined;
  const i = (rng() * n) | 0;
  return arr[i < n ? i : n - 1];
}

/**
 * Deterministic hash-driven float in `[0, 1)` for per-voxel variation that must
 * not consume RNG state (used for weathering patterns).
 * @param {number} x world x
 * @param {number} y world y
 * @param {number} z world z
 * @param {number} salt arbitrary integer salt
 * @returns {number} pseudo-random float
 */
function voxelRandom(x, y, z, salt) {
  return xxhash32(x | 0, y | 0, z | 0, salt | 0) / 4294967296;
}

/**
 * Feature-tag test against a biome's advisory `features` list.
 * @param {readonly string[]} features feature list
 * @param {string} tag tag to look for
 * @returns {boolean} whether the tag is present
 */
function hasFeature(features, tag) {
  for (let i = 0; i < features.length; i++) if (features[i] === tag) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Primitive writers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Fill an axis-aligned box (inclusive bounds) with one block id.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} x0 min x
 * @param {number} y0 min y
 * @param {number} z0 min z
 * @param {number} x1 max x
 * @param {number} y1 max y
 * @param {number} z1 max z
 * @param {number} id block id
 * @returns {void}
 */
function fillBox(setBlock, x0, y0, z0, x1, y1, z1, id) {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) setBlock(x, y, z, id);
    }
  }
}

/**
 * Draw the hollow shell of an axis-aligned box (walls, floor and ceiling).
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} x0 min x
 * @param {number} y0 min y
 * @param {number} z0 min z
 * @param {number} x1 max x
 * @param {number} y1 max y
 * @param {number} z1 max z
 * @param {number} id block id
 * @returns {void}
 */
function shellBox(setBlock, x0, y0, z0, x1, y1, z1, id) {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1) {
          setBlock(x, y, z, id);
        }
      }
    }
  }
}

/**
 * Fill an axis-aligned ellipsoid.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {number} cz centre z
 * @param {number} rx radius along x
 * @param {number} ry radius along y
 * @param {number} rz radius along z
 * @param {number} id block id
 * @returns {void}
 */
function fillEllipsoid(setBlock, cx, cy, cz, rx, ry, rz, id) {
  const ix = Math.ceil(rx);
  const iy = Math.ceil(ry);
  const iz = Math.ceil(rz);
  const ax = 1 / (rx * rx);
  const ay = 1 / (ry * ry);
  const az = 1 / (rz * rz);
  for (let dy = -iy; dy <= iy; dy++) {
    for (let dz = -iz; dz <= iz; dz++) {
      for (let dx = -ix; dx <= ix; dx++) {
        if (dx * dx * ax + dy * dy * ay + dz * dz * az <= 1.0) {
          setBlock(cx + dx, cy + dy, cz + dz, id);
        }
      }
    }
  }
}

/**
 * Draw a 3D line of blocks between two points (DDA on the dominant axis).
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} x0 start x
 * @param {number} y0 start y
 * @param {number} z0 start z
 * @param {number} x1 end x
 * @param {number} y1 end y
 * @param {number} z1 end z
 * @param {number} id block id
 * @param {number} [thickness=0] extra radius; `1` gives a chunky beam
 * @returns {void}
 */
function drawLine(setBlock, x0, y0, z0, x1, y1, z1, id, thickness = 0) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))));
  const inv = 1 / steps;
  for (let i = 0; i <= steps; i++) {
    const t = i * inv;
    const px = Math.round(x0 + dx * t);
    const py = Math.round(y0 + dy * t);
    const pz = Math.round(z0 + dz * t);
    if (thickness <= 0) {
      setBlock(px, py, pz, id);
    } else {
      for (let ox = -thickness; ox <= thickness; ox++) {
        for (let oz = -thickness; oz <= thickness; oz++) {
          setBlock(px + ox, py, pz + oz, id);
        }
      }
    }
  }
}

/**
 * Place a horizontal disc of leaves with randomised nibbles along the rim.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} cx centre x
 * @param {number} y layer y
 * @param {number} cz centre z
 * @param {number} radius disc radius in blocks
 * @param {number} leafId leaf block id
 * @param {number} [cutChance=0.35] probability a rim block is skipped
 * @returns {void}
 */
function leafDisc(setBlock, rng, cx, y, cz, radius, leafId, cutChance = 0.35) {
  if (radius < 0) return;
  const ir = Math.ceil(radius);
  const outer = (radius + 0.45) * (radius + 0.45);
  const inner = radius <= 1 ? -1 : (radius - 0.55) * (radius - 0.55);
  for (let dz = -ir; dz <= ir; dz++) {
    for (let dx = -ir; dx <= ir; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > outer) continue;
      if (d2 > inner && rng() < cutChance) continue;
      setBlock(cx + dx, y, cz + dz, leafId);
    }
  }
}

/**
 * Place a rounded leaf blob with randomised surface nibbles.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {number} cz centre z
 * @param {number} rx radius along x
 * @param {number} ry radius along y
 * @param {number} rz radius along z
 * @param {number} leafId leaf block id
 * @param {number} [cutChance=0.3] probability a surface block is skipped
 * @returns {void}
 */
function leafBlob(setBlock, rng, cx, cy, cz, rx, ry, rz, leafId, cutChance = 0.3) {
  const ix = Math.ceil(rx);
  const iy = Math.ceil(ry);
  const iz = Math.ceil(rz);
  const ax = 1 / (rx * rx);
  const ay = 1 / (ry * ry);
  const az = 1 / (rz * rz);
  for (let dy = -iy; dy <= iy; dy++) {
    for (let dz = -iz; dz <= iz; dz++) {
      for (let dx = -ix; dx <= ix; dx++) {
        const d = dx * dx * ax + dy * dy * ay + dz * dz * az;
        if (d > 1.0) continue;
        if (d > 0.62 && rng() < cutChance) continue;
        setBlock(cx + dx, cy + dy, cz + dz, leafId);
      }
    }
  }
}

/**
 * Hang vines off the underside/sides of a canopy.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} cx canopy centre x
 * @param {number} cy canopy base y
 * @param {number} cz canopy centre z
 * @param {number} radius canopy radius
 * @param {number} strands number of vine strands to try
 * @returns {void}
 */
function drapeVines(setBlock, rng, cx, cy, cz, radius, strands) {
  for (let i = 0; i < strands; i++) {
    const a = rng() * Math.PI * 2;
    const r = radius * (0.55 + rng() * 0.5);
    const vx = cx + Math.round(Math.cos(a) * r);
    const vz = cz + Math.round(Math.sin(a) * r);
    const len = randInt(rng, 2, 7);
    for (let k = 0; k < len; k++) setBlock(vx, cy - k, vz, B.VINE);
  }
}

/**
 * Write a vertical trunk run.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} x trunk x
 * @param {number} y0 first trunk y (inclusive)
 * @param {number} y1 last trunk y (inclusive)
 * @param {number} z trunk z
 * @param {number} logId log block id
 * @returns {void}
 */
function trunkColumn(setBlock, x, y0, y1, z, logId) {
  for (let y = y0; y <= y1; y++) setBlock(x, y, z, logId);
}

/**
 * Add a root flare / buttress at the base of a large trunk so it does not look
 * like a pole stuck in the ground.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x
 * @param {number} y base y (first trunk block)
 * @param {number} z trunk z
 * @param {number} logId log block id
 * @param {number} [reach=1] how far the flare spreads
 * @returns {void}
 */
function trunkFlare(setBlock, rng, x, y, z, logId, reach = 1) {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 0; i < dirs.length; i++) {
    if (rng() < 0.25) continue;
    const h = randInt(rng, 0, reach);
    for (let k = 0; k <= h; k++) {
      setBlock(x + dirs[i][0], y + k, z + dirs[i][1], logId);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Loot                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} LootEntry
 * @property {string} item item name (matches `game/items.js`)
 * @property {number} weight relative draw weight
 * @property {number} min minimum stack size
 * @property {number} max maximum stack size
 */

/**
 * Loot tables for every chest this module places. `world/worldgen.js` cannot
 * attach block entities through `setBlock`, so the table name is what the game
 * layer should use when it materialises a chest's contents.
 * @type {Object<string, {rolls:[number,number], entries: LootEntry[]}>}
 */
export const LOOT_TABLES = Object.freeze({
  dungeon: {
    rolls: [3, 5],
    entries: [
      { item: 'bone', weight: 10, min: 1, max: 8 },
      { item: 'gunpowder', weight: 10, min: 1, max: 8 },
      { item: 'rotten_flesh', weight: 10, min: 1, max: 8 },
      { item: 'string', weight: 10, min: 1, max: 8 },
      { item: 'wheat', weight: 8, min: 1, max: 4 },
      { item: 'bread', weight: 8, min: 1, max: 1 },
      { item: 'iron_ingot', weight: 6, min: 1, max: 4 },
      { item: 'gold_ingot', weight: 3, min: 1, max: 4 },
      { item: 'redstone', weight: 4, min: 1, max: 4 },
      { item: 'bucket', weight: 2, min: 1, max: 1 },
      { item: 'saddle', weight: 2, min: 1, max: 1 },
      { item: 'golden_apple', weight: 1, min: 1, max: 1 },
      { item: 'enchanted_book', weight: 1, min: 1, max: 1 },
      { item: 'diamond', weight: 1, min: 1, max: 1 },
    ],
  },
  mineshaft: {
    rolls: [3, 5],
    entries: [
      { item: 'rail', weight: 20, min: 4, max: 8 },
      { item: 'powered_rail', weight: 5, min: 1, max: 4 },
      { item: 'torch', weight: 15, min: 1, max: 16 },
      { item: 'bread', weight: 15, min: 1, max: 3 },
      { item: 'coal', weight: 10, min: 3, max: 8 },
      { item: 'iron_ingot', weight: 10, min: 1, max: 5 },
      { item: 'gold_ingot', weight: 5, min: 1, max: 3 },
      { item: 'lapis_lazuli', weight: 5, min: 4, max: 9 },
      { item: 'redstone', weight: 5, min: 4, max: 9 },
      { item: 'diamond', weight: 3, min: 1, max: 2 },
      { item: 'name_tag', weight: 1, min: 1, max: 1 },
      { item: 'golden_apple', weight: 1, min: 1, max: 1 },
    ],
  },
  desert_pyramid: {
    rolls: [2, 4],
    entries: [
      { item: 'bone', weight: 25, min: 1, max: 8 },
      { item: 'rotten_flesh', weight: 25, min: 1, max: 8 },
      { item: 'gunpowder', weight: 25, min: 1, max: 8 },
      { item: 'sand', weight: 20, min: 1, max: 8 },
      { item: 'string', weight: 20, min: 1, max: 8 },
      { item: 'gold_ingot', weight: 15, min: 2, max: 7 },
      { item: 'iron_ingot', weight: 15, min: 1, max: 5 },
      { item: 'emerald', weight: 15, min: 1, max: 3 },
      { item: 'diamond', weight: 5, min: 1, max: 3 },
      { item: 'enchanted_book', weight: 5, min: 1, max: 1 },
      { item: 'golden_apple', weight: 2, min: 1, max: 1 },
    ],
  },
  ruins: {
    rolls: [1, 3],
    entries: [
      { item: 'stone_axe', weight: 8, min: 1, max: 1 },
      { item: 'coal', weight: 15, min: 1, max: 4 },
      { item: 'bread', weight: 12, min: 1, max: 2 },
      { item: 'wheat', weight: 12, min: 1, max: 5 },
      { item: 'iron_ingot', weight: 8, min: 1, max: 3 },
      { item: 'gold_ingot', weight: 3, min: 1, max: 2 },
      { item: 'emerald', weight: 4, min: 1, max: 2 },
      { item: 'paper', weight: 10, min: 1, max: 5 },
      { item: 'book', weight: 5, min: 1, max: 1 },
    ],
  },
  stronghold: {
    rolls: [2, 4],
    entries: [
      { item: 'ender_pearl', weight: 10, min: 1, max: 1 },
      { item: 'iron_ingot', weight: 10, min: 1, max: 5 },
      { item: 'gold_ingot', weight: 5, min: 1, max: 3 },
      { item: 'redstone', weight: 5, min: 4, max: 9 },
      { item: 'bread', weight: 15, min: 1, max: 3 },
      { item: 'apple', weight: 15, min: 1, max: 3 },
      { item: 'book', weight: 10, min: 1, max: 3 },
      { item: 'enchanted_book', weight: 5, min: 1, max: 1 },
      { item: 'diamond', weight: 3, min: 1, max: 3 },
      { item: 'emerald', weight: 3, min: 1, max: 3 },
    ],
  },
  village: {
    rolls: [2, 4],
    entries: [
      { item: 'wheat', weight: 20, min: 1, max: 7 },
      { item: 'bread', weight: 15, min: 1, max: 4 },
      { item: 'potato', weight: 15, min: 1, max: 7 },
      { item: 'carrot', weight: 15, min: 1, max: 7 },
      { item: 'beetroot', weight: 10, min: 1, max: 5 },
      { item: 'emerald', weight: 8, min: 1, max: 3 },
      { item: 'iron_ingot', weight: 6, min: 1, max: 3 },
      { item: 'oak_sapling', weight: 8, min: 1, max: 3 },
      { item: 'stick', weight: 12, min: 1, max: 6 },
    ],
  },
});

/**
 * Roll a loot table into an array of `{ item, count }` records.
 * @param {string} table one of the keys of {@link LOOT_TABLES}
 * @param {() => number} rng random source
 * @param {{item:string,count:number}[]} [out] destination (cleared first)
 * @returns {{item:string,count:number}[]} rolled stacks
 */
export function rollLoot(table, rng, out = []) {
  out.length = 0;
  const def = LOOT_TABLES[table];
  if (def === undefined) return out;
  const entries = def.entries;
  let total = 0;
  for (let i = 0; i < entries.length; i++) total += entries[i].weight;
  if (total <= 0) return out;
  const rolls = randInt(rng, def.rolls[0], def.rolls[1]);
  for (let r = 0; r < rolls; r++) {
    let pickWeight = rng() * total;
    for (let i = 0; i < entries.length; i++) {
      pickWeight -= entries[i].weight;
      if (pickWeight <= 0) {
        const e = entries[i];
        out.push({ item: e.item, count: randInt(rng, e.min, e.max) });
        break;
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Trees                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Classic small oak/birch shape: straight trunk, four-layer canopy with
 * nibbled corners and a single-block cap.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x
 * @param {number} y ground y (trunk starts at `y + 1`)
 * @param {number} z trunk z
 * @param {number} logId trunk block id
 * @param {number} leafId leaf block id
 * @param {number} minH minimum trunk height
 * @param {number} maxH maximum trunk height
 * @returns {boolean} always `true`
 */
function smallTree(setBlock, rng, x, y, z, logId, leafId, minH, maxH) {
  const h = randInt(rng, minH, maxH);
  const base = y + 1;
  const top = base + h - 1;

  // Canopy first — the trunk is written over it afterwards.
  leafDisc(setBlock, rng, x, top - 2, z, 2, leafId, 0.28);
  leafDisc(setBlock, rng, x, top - 1, z, 2, leafId, 0.36);
  leafDisc(setBlock, rng, x, top, z, 1, leafId, 0.14);
  leafDisc(setBlock, rng, x, top + 1, z, 1, leafId, 0.6);
  setBlock(x, top + 1, z, leafId);

  trunkColumn(setBlock, x, base, top, z, logId);
  if (rng() < 0.35) trunkFlare(setBlock, rng, x, base, z, logId, 0);
  return true;
}

/**
 * Large branching oak: tall tapered trunk, three to five upward branches, each
 * capped with its own leaf blob plus a crowning blob on top.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x
 * @param {number} y ground y
 * @param {number} z trunk z
 * @param {number} logId trunk block id
 * @param {number} leafId leaf block id
 * @returns {boolean} always `true`
 */
function bigOak(setBlock, rng, x, y, z, logId, leafId) {
  const h = randInt(rng, 9, 15);
  const base = y + 1;
  const top = base + h - 1;
  const branches = randInt(rng, 3, 5);

  /** @type {number[]} flat list of branch end points, x,y,z triples */
  const ends = [];
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rng() * 0.9;
    const len = 2.5 + rng() * 3.2;
    const startY = base + Math.floor(h * (0.42 + 0.5 * (i / branches)) + rng() * 1.5);
    const ey = Math.min(top + 1, startY + Math.round(1 + rng() * 2.5));
    const ex = x + Math.round(Math.cos(a) * len);
    const ez = z + Math.round(Math.sin(a) * len);
    ends.push(ex, ey, ez, startY);
  }

  // Leaves (blobs at every branch tip + the crown).
  for (let i = 0; i < ends.length; i += 4) {
    leafBlob(setBlock, rng, ends[i], ends[i + 1], ends[i + 2], 2.7, 2.0, 2.7, leafId, 0.3);
  }
  leafBlob(setBlock, rng, x, top, z, 3.1, 2.4, 3.1, leafId, 0.26);
  leafDisc(setBlock, rng, x, top + 2, z, 1, leafId, 0.3);

  // Wood.
  trunkColumn(setBlock, x, base, top, z, logId);
  trunkFlare(setBlock, rng, x, base, z, logId, 1);
  for (let i = 0; i < ends.length; i += 4) {
    drawLine(setBlock, x, ends[i + 3], z, ends[i], ends[i + 1], ends[i + 2], logId, 0);
  }
  return true;
}

/**
 * Conifer: monotonically widening tiers toward the ground, sharp tip and a
 * podzol/coarse-dirt litter ring at the base.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x
 * @param {number} y ground y
 * @param {number} z trunk z
 * @param {number} minH minimum trunk height
 * @param {number} maxH maximum trunk height
 * @param {boolean} thick whether to grow a 2x2 trunk with a wide skirt
 * @returns {boolean} always `true`
 */
function spruceTree(setBlock, rng, x, y, z, minH, maxH, thick) {
  const logId = B.SPRUCE_LOG;
  const leafId = B.SPRUCE_LEAVES;
  const h = randInt(rng, minH, maxH);
  const base = y + 1;
  const top = base + h - 1;
  const leafBottom = base + Math.max(1, Math.floor(h * (thick ? 0.42 : 0.24)));
  const maxR = thick ? 3 : 2;

  // Tip.
  setBlock(x, top + 1, z, leafId);
  leafDisc(setBlock, rng, x, top, z, 1, leafId, 0.1);

  // Tiers: radius grows with distance from the top, with a one-block notch
  // every third layer so the silhouette is stepped like a real conifer.
  for (let ly = top - 1; ly >= leafBottom; ly--) {
    const d = top - ly;
    let r = Math.min(maxR, 1 + Math.floor(d / 3));
    if (d % 3 === 0 && r > 1) r -= 1;
    leafDisc(setBlock, rng, x, ly, z, r, leafId, r >= 2 ? 0.3 : 0.08);
  }
  // Wide skirt for the tall variant.
  if (thick) {
    leafDisc(setBlock, rng, x, leafBottom, z, maxR + 1, leafId, 0.5);
  }

  trunkColumn(setBlock, x, base, top, z, logId);
  if (thick) {
    trunkColumn(setBlock, x + 1, base, top - 2, z, logId);
    trunkColumn(setBlock, x, base, top - 2, z + 1, logId);
    trunkColumn(setBlock, x + 1, base, top - 2, z + 1, logId);
  }

  // Litter ring.
  const litter = rng() < 0.6 ? B.PODZOL : B.COARSE_DIRT;
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx * dx + dz * dz > 5) continue;
      if (rng() < 0.45) setBlock(x + dx, y, z + dz, litter);
    }
  }
  return true;
}

/**
 * Jungle tree: tall bare trunk, compact crown and hanging vines.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x
 * @param {number} y ground y
 * @param {number} z trunk z
 * @returns {boolean} always `true`
 */
function jungleTree(setBlock, rng, x, y, z) {
  const logId = B.JUNGLE_LOG;
  const leafId = B.JUNGLE_LEAVES;
  const h = randInt(rng, 8, 13);
  const base = y + 1;
  const top = base + h - 1;

  leafDisc(setBlock, rng, x, top - 2, z, 2, leafId, 0.35);
  leafDisc(setBlock, rng, x, top - 1, z, 2, leafId, 0.25);
  leafDisc(setBlock, rng, x, top, z, 1, leafId, 0.1);
  setBlock(x, top + 1, z, leafId);

  trunkColumn(setBlock, x, base, top, z, logId);

  // Vines climbing the trunk.
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let s = 0; s < sides.length; s++) {
    if (rng() < 0.45) continue;
    const y0 = base + randInt(rng, 1, Math.max(1, h - 4));
    const len = randInt(rng, 2, h - 2);
    for (let k = 0; k < len; k++) {
      setBlock(x + sides[s][0], y0 + k, z + sides[s][1], B.VINE);
    }
  }
  drapeVines(setBlock, rng, x, top - 2, z, 2, 3);
  return true;
}

/**
 * Giant jungle tree: 2x2 trunk, buttress roots, mid-height branches and a very
 * wide crown that rains vines.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x (south-west corner of the 2x2)
 * @param {number} y ground y
 * @param {number} z trunk z
 * @returns {boolean} always `true`
 */
function bigJungleTree(setBlock, rng, x, y, z) {
  const logId = B.JUNGLE_LOG;
  const leafId = B.JUNGLE_LEAVES;
  const h = randInt(rng, 15, 25);
  const base = y + 1;
  const top = base + h - 1;

  /** @type {number[]} branch endpoints, x,y,z,startY quadruples */
  const ends = [];
  const branches = randInt(rng, 2, 4);
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rng() * 1.1;
    const len = 3 + rng() * 3;
    const startY = base + Math.floor(h * (0.55 + 0.32 * rng()));
    ends.push(
      x + Math.round(Math.cos(a) * len),
      Math.min(top, startY + randInt(rng, 1, 3)),
      z + Math.round(Math.sin(a) * len),
      startY,
    );
  }

  for (let i = 0; i < ends.length; i += 4) {
    leafBlob(setBlock, rng, ends[i], ends[i + 1], ends[i + 2], 2.6, 1.7, 2.6, leafId, 0.32);
  }
  leafBlob(setBlock, rng, x, top - 1, z, 4.2, 2.6, 4.2, leafId, 0.3);
  leafDisc(setBlock, rng, x, top + 1, z, 2, leafId, 0.4);

  for (let dx = 0; dx <= 1; dx++) {
    for (let dz = 0; dz <= 1; dz++) trunkColumn(setBlock, x + dx, base, top, z + dz, logId);
  }
  // Buttress roots.
  for (let i = 0; i < 6; i++) {
    const a = rng() * Math.PI * 2;
    const rx = x + Math.round(Math.cos(a) * 2.2);
    const rz = z + Math.round(Math.sin(a) * 2.2);
    drawLine(setBlock, rx, y, rz, x, base + 2, z, logId, 0);
  }
  for (let i = 0; i < ends.length; i += 4) {
    drawLine(setBlock, x, ends[i + 3], z, ends[i], ends[i + 1], ends[i + 2], logId, 0);
  }
  drapeVines(setBlock, rng, x, top - 3, z, 4, 10);
  return true;
}

/**
 * Acacia: trunk that kinks diagonally partway up, one or two arms, each
 * carrying a flat two-block-thick canopy plate.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x
 * @param {number} y ground y
 * @param {number} z trunk z
 * @returns {boolean} always `true`
 */
function acaciaTree(setBlock, rng, x, y, z) {
  const logId = B.ACACIA_LOG;
  const leafId = B.ACACIA_LEAVES;
  const base = y + 1;
  const straight = randInt(rng, 3, 5);
  const kinkY = base + straight;

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const d0 = pick(rng, dirs);
  const run0 = randInt(rng, 3, 5);
  const armX = x + d0[0] * run0;
  const armZ = z + d0[1] * run0;
  const armY = kinkY + randInt(rng, 1, 3);

  const second = rng() < 0.65;
  let arm2X = 0;
  let arm2Y = 0;
  let arm2Z = 0;
  if (second) {
    let d1 = pick(rng, dirs);
    if (d1[0] === d0[0] && d1[1] === d0[1]) d1 = dirs[(dirs.indexOf(d0) + 3) % dirs.length];
    const run1 = randInt(rng, 2, 4);
    arm2X = x + d1[0] * run1;
    arm2Z = z + d1[1] * run1;
    arm2Y = kinkY + randInt(rng, 0, 2);
  }

  // Flat plates.
  leafDisc(setBlock, rng, armX, armY + 1, armZ, 3.4, leafId, 0.3);
  leafDisc(setBlock, rng, armX, armY + 2, armZ, 2.2, leafId, 0.45);
  leafDisc(setBlock, rng, armX, armY, armZ, 2.0, leafId, 0.55);
  if (second) {
    leafDisc(setBlock, rng, arm2X, arm2Y + 1, arm2Z, 2.6, leafId, 0.32);
    leafDisc(setBlock, rng, arm2X, arm2Y + 2, arm2Z, 1.5, leafId, 0.5);
  }

  trunkColumn(setBlock, x, base, kinkY, z, logId);
  drawLine(setBlock, x, kinkY, z, armX, armY, armZ, logId, 0);
  if (second) drawLine(setBlock, x, kinkY - 1, z, arm2X, arm2Y, arm2Z, logId, 0);
  return true;
}

/**
 * Dark oak: 2x2 trunk, short and stout, with a wide flat double-layer canopy
 * and stubby side branches.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x (south-west corner of the 2x2)
 * @param {number} y ground y
 * @param {number} z trunk z
 * @returns {boolean} always `true`
 */
function darkOakTree(setBlock, rng, x, y, z) {
  const logId = B.DARK_OAK_LOG;
  const leafId = B.DARK_OAK_LEAVES;
  const h = randInt(rng, 6, 10);
  const base = y + 1;
  const top = base + h - 1;

  leafDisc(setBlock, rng, x, top - 1, z, 3.6, leafId, 0.22);
  leafDisc(setBlock, rng, x, top, z, 3.9, leafId, 0.2);
  leafDisc(setBlock, rng, x, top + 1, z, 2.6, leafId, 0.34);
  leafDisc(setBlock, rng, x, top + 2, z, 1.4, leafId, 0.5);
  leafDisc(setBlock, rng, x, top - 2, z, 2.2, leafId, 0.6);

  for (let dx = 0; dx <= 1; dx++) {
    for (let dz = 0; dz <= 1; dz++) trunkColumn(setBlock, x + dx, base, top, z + dz, logId);
  }
  trunkFlare(setBlock, rng, x, base, z, logId, 1);

  const arms = randInt(rng, 2, 4);
  for (let i = 0; i < arms; i++) {
    const a = rng() * Math.PI * 2;
    const len = 2 + rng() * 2;
    drawLine(
      setBlock,
      x, top - randInt(rng, 0, 2), z,
      x + Math.round(Math.cos(a) * len), top + randInt(rng, 0, 1), z + Math.round(Math.sin(a) * len),
      logId, 0,
    );
  }
  return true;
}

/**
 * Cherry blossom: short branching trunk crowned by an overlapping pink dome of
 * flattened blobs.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x
 * @param {number} y ground y
 * @param {number} z trunk z
 * @returns {boolean} always `true`
 */
function cherryTree(setBlock, rng, x, y, z) {
  const logId = B.CHERRY_LOG;
  const leafId = B.CHERRY_LEAVES;
  const h = randInt(rng, 5, 9);
  const base = y + 1;
  const top = base + h - 1;
  const arms = randInt(rng, 2, 4);

  /** @type {number[]} arm tips, x,y,z,startY quadruples */
  const ends = [];
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + rng() * 0.8;
    const len = 2 + rng() * 2.4;
    const startY = top - randInt(rng, 0, 2);
    ends.push(
      x + Math.round(Math.cos(a) * len),
      startY + randInt(rng, 1, 2),
      z + Math.round(Math.sin(a) * len),
      startY,
    );
  }

  // Dome: one big flattened blob plus a puff at every arm tip.
  leafBlob(setBlock, rng, x, top + 2, z, 3.4, 1.9, 3.4, leafId, 0.2);
  leafBlob(setBlock, rng, x, top + 3, z, 2.2, 1.4, 2.2, leafId, 0.28);
  for (let i = 0; i < ends.length; i += 4) {
    leafBlob(setBlock, rng, ends[i], ends[i + 1] + 1, ends[i + 2], 2.5, 1.6, 2.5, leafId, 0.26);
  }

  trunkColumn(setBlock, x, base, top, z, logId);
  for (let i = 0; i < ends.length; i += 4) {
    drawLine(setBlock, x, ends[i + 3], z, ends[i], ends[i + 1], ends[i + 2], logId, 0);
  }
  // Fallen petals on the ground read as pink grass in the biome tint.
  for (let i = 0; i < 5; i++) {
    setBlock(x + randInt(rng, -3, 3), y + 1, z + randInt(rng, -3, 3), B.SHORT_GRASS);
  }
  return true;
}

/**
 * Mangrove: trunk lifted clear of the water on splayed prop roots with a
 * rounded crown. Uses oak wood — this build has no mangrove species.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x
 * @param {number} y ground y
 * @param {number} z trunk z
 * @returns {boolean} always `true`
 */
function mangroveTree(setBlock, rng, x, y, z) {
  const logId = B.OAK_LOG;
  const leafId = B.OAK_LEAVES;
  const rootH = randInt(rng, 2, 4);
  const base = y + rootH;
  const h = randInt(rng, 5, 9);
  const top = base + h;

  leafBlob(setBlock, rng, x, top, z, 3.2, 2.3, 3.2, leafId, 0.26);
  leafDisc(setBlock, rng, x, top + 2, z, 1.6, leafId, 0.4);

  trunkColumn(setBlock, x, base, top, z, logId);

  // Prop roots: diagonal legs from the mud up into the trunk.
  const legs = randInt(rng, 4, 7);
  for (let i = 0; i < legs; i++) {
    const a = (i / legs) * Math.PI * 2 + rng() * 0.5;
    const r = 1.6 + rng() * 1.4;
    const fx = x + Math.round(Math.cos(a) * r);
    const fz = z + Math.round(Math.sin(a) * r);
    drawLine(setBlock, fx, y, fz, x, base, z, logId, 0);
  }
  drapeVines(setBlock, rng, x, base - 1, z, 2, 3);
  return true;
}

/**
 * Azalea tree: a dirt root wad, a stubby trunk and an azalea-leaf bush,
 * the lush-cave surface marker.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x trunk x
 * @param {number} y ground y
 * @param {number} z trunk z
 * @returns {boolean} always `true`
 */
function azaleaTree(setBlock, rng, x, y, z) {
  const logId = B.OAK_LOG;
  const bushId = B.AZALEA;
  const leafId = B.OAK_LEAVES;
  const h = randInt(rng, 2, 4);
  const base = y + 1;
  const top = base + h - 1;

  leafBlob(setBlock, rng, x, top + 1, z, 2.4, 1.8, 2.4, bushId, 0.28);
  for (let i = 0; i < 6; i++) {
    setBlock(
      x + randInt(rng, -2, 2), top + randInt(rng, 0, 2), z + randInt(rng, -2, 2), leafId,
    );
  }
  trunkColumn(setBlock, x, base, top, z, logId);

  // Root wad reaching down into the ceiling/floor it grew from.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (rng() < 0.4) continue;
      const d = randInt(rng, 1, 3);
      for (let k = 0; k < d; k++) setBlock(x + dx, y - k, z + dz, B.DIRT);
    }
  }
  for (let i = 0; i < 4; i++) {
    setBlock(x + randInt(rng, -2, 2), y, z + randInt(rng, -2, 2), B.MOSS_BLOCK);
  }
  return true;
}

/**
 * Grow a tree of the requested archetype.
 *
 * `(x, y, z)` is the **ground block** the tree grows on; the first trunk voxel
 * is written at `y + 1`. All writes go through `setBlock` in absolute world
 * coordinates, so the caller decides what happens at chunk borders.
 *
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source in `[0, 1)`
 * @param {number} x world x of the ground block
 * @param {number} y world y of the ground block
 * @param {number} z world z of the ground block
 * @param {'oak'|'big_oak'|'spruce'|'tall_spruce'|'birch'|'jungle'|'big_jungle'|'acacia'|'dark_oak'|'cherry'|'mangrove'|'azalea'} type
 *   tree archetype
 * @returns {boolean} `true` when a tree was written
 */
export function placeTree(setBlock, rng, x, y, z, type) {
  switch (type) {
    case 'oak':
      return smallTree(setBlock, rng, x, y, z, LOG_OF.oak, LEAF_OF.oak, 4, 6);
    case 'big_oak':
      return bigOak(setBlock, rng, x, y, z, LOG_OF.oak, LEAF_OF.oak);
    case 'birch':
      return smallTree(setBlock, rng, x, y, z, LOG_OF.birch, LEAF_OF.birch, 5, 8);
    case 'spruce':
      return spruceTree(setBlock, rng, x, y, z, 7, 12, false);
    case 'tall_spruce':
      return spruceTree(setBlock, rng, x, y, z, 14, 22, true);
    case 'jungle':
      return jungleTree(setBlock, rng, x, y, z);
    case 'big_jungle':
      return bigJungleTree(setBlock, rng, x, y, z);
    case 'acacia':
      return acaciaTree(setBlock, rng, x, y, z);
    case 'dark_oak':
      return darkOakTree(setBlock, rng, x, y, z);
    case 'cherry':
      return cherryTree(setBlock, rng, x, y, z);
    case 'mangrove':
      return mangroveTree(setBlock, rng, x, y, z);
    case 'azalea':
      return azaleaTree(setBlock, rng, x, y, z);
    default:
      return smallTree(setBlock, rng, x, y, z, LOG_OF.oak, LEAF_OF.oak, 4, 6);
  }
}

/* -------------------------------------------------------------------------- */
/* Vegetation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Place a vertical stack of one block (cactus, sugar cane, bamboo, kelp).
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} x world x
 * @param {number} y ground y (first block goes to `y + 1`)
 * @param {number} z world z
 * @param {number} height stack height in blocks
 * @param {number} id block id
 * @returns {void}
 */
function stack(setBlock, x, y, z, height, id) {
  for (let k = 1; k <= height; k++) setBlock(x, y + k, z, id);
}

/**
 * Scatter a small patch of ground cover around a point.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x patch centre x
 * @param {number} y ground y
 * @param {number} z patch centre z
 * @param {number} id plant block id
 * @param {number} count number of placement attempts
 * @param {number} radius patch radius
 * @returns {void}
 */
function scatterPatch(setBlock, rng, x, y, z, id, count, radius) {
  for (let i = 0; i < count; i++) {
    const dx = Math.round((rng() * 2 - 1) * radius);
    const dz = Math.round((rng() * 2 - 1) * radius);
    setBlock(x + dx, y + 1, z + dz, id);
  }
}

/**
 * Underwater flora for ocean and river columns.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x world x
 * @param {number} y sea-floor y
 * @param {number} z world z
 * @param {*} def biome definition
 * @param {number} waterTop y of the water surface
 * @returns {boolean} whether anything was placed
 */
function placeUnderwaterPlant(setBlock, rng, x, y, z, def, waterTop) {
  const depth = waterTop - y;
  if (depth < 2) return false;
  const feats = def.features;
  const roll = rng();

  // Reefs, where the biome asks for them.
  if (hasFeature(feats, 'coral_reef') && depth >= 3 && roll < 0.30) {
    const mounds = randInt(rng, 2, 5);
    for (let i = 0; i < mounds; i++) {
      const coral = pick(rng, CORAL_BLOCKS);
      const cx = x + randInt(rng, -2, 2);
      const cz = z + randInt(rng, -2, 2);
      const hgt = randInt(rng, 1, Math.min(3, depth - 1));
      stack(setBlock, cx, y, cz, hgt, coral);
    }
    return true;
  }

  // Kelp forests, likewise.
  if (hasFeature(feats, 'kelp_forest') && roll < 0.55 && depth >= 5) {
    const h = randInt(rng, 3, Math.min(depth - 1, 18));
    stack(setBlock, x, y, z, h, B.KELP);
    return true;
  }
  if (!hasFeature(feats, 'coral_reef') && roll < 0.25 && depth >= 6) {
    const h = randInt(rng, 3, Math.min(depth - 1, 12));
    stack(setBlock, x, y, z, h, B.KELP);
    return true;
  }

  // Seagrass meadows: one or two blocks tall, clustered.
  const n = randInt(rng, 2, 6);
  for (let i = 0; i < n; i++) {
    const gx = x + randInt(rng, -2, 2);
    const gz = z + randInt(rng, -2, 2);
    setBlock(gx, y + 1, gz, B.SEAGRASS);
    if (depth > 3 && rng() < 0.4) setBlock(gx, y + 2, gz, B.SEAGRASS);
  }
  return true;
}

/**
 * Place biome-appropriate ground vegetation on a surface block.
 *
 * Covers grass and ferns, flowers, mushrooms, cactus, sugar cane, bamboo,
 * kelp, seagrass, coral, berry bushes and dead bushes. `(x, y, z)` is the
 * ground block; plants are written at `y + 1` and upward.
 *
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x world x of the ground block
 * @param {number} y world y of the ground block
 * @param {number} z world z of the ground block
 * @param {number} biome biome id
 * @param {number} [waterTop=SEA_LEVEL] y of the local water surface, used by
 *   the underwater flora branch
 * @returns {boolean} whether anything was placed
 */
export function placeVegetation(setBlock, rng, x, y, z, biome, waterTop = SEA_LEVEL) {
  const def = getBiome(biome);
  const cat = def.category;

  if (cat === 'ocean' || cat === 'river') {
    return placeUnderwaterPlant(setBlock, rng, x, y, z, def, waterTop);
  }

  const feats = def.features;
  const name = def.name;

  // --- Special, biome-defining plants ------------------------------------
  if (hasFeature(feats, 'cactus') && rng() < 0.32) {
    stack(setBlock, x, y, z, randInt(rng, 1, 3), B.CACTUS);
    return true;
  }
  if (hasFeature(feats, 'bamboo') && rng() < 0.4) {
    const clumps = randInt(rng, 2, 5);
    for (let i = 0; i < clumps; i++) {
      stack(
        setBlock, x + randInt(rng, -2, 2), y, z + randInt(rng, -2, 2),
        randInt(rng, 5, 15), B.BAMBOO,
      );
    }
    return true;
  }
  // Sugar cane only wants the shoreline. `waterTop` is the column's own water
  // table, which sits far below the world on dry land, so the sea level acts
  // as the floor of the test — the effect is that cane appears on terrain at
  // the water line and nowhere else.
  const shoreline = (waterTop > SEA_LEVEL ? waterTop : SEA_LEVEL) + 2;
  if (hasFeature(feats, 'sugar_cane') && y <= shoreline && rng() < 0.30) {
    stack(setBlock, x, y, z, randInt(rng, 2, 4), B.SUGAR_CANE);
    return true;
  }
  if (hasFeature(feats, 'melons') && rng() < 0.03) {
    setBlock(x, y + 1, z, B.MELON);
    return true;
  }
  if (hasFeature(feats, 'pumpkins') && rng() < 0.02) {
    setBlock(x, y + 1, z, B.PUMPKIN);
    return true;
  }
  if (hasFeature(feats, 'vines') && rng() < 0.05) {
    stack(setBlock, x, y, z, randInt(rng, 1, 3), B.VINE);
    return true;
  }
  if (hasFeature(feats, 'lush_cave_vegetation') && rng() < 0.35) {
    scatterPatch(setBlock, rng, x, y, z, B.MOSS_CARPET, randInt(rng, 4, 9), 2);
    return true;
  }
  if (hasFeature(feats, 'mushrooms') && rng() < 0.06) {
    const shroom = rng() < 0.6 ? B.BROWN_MUSHROOM : B.RED_MUSHROOM;
    scatterPatch(setBlock, rng, x, y, z, shroom, randInt(rng, 1, 4), 2);
    return true;
  }
  if (BERRY_BUSH !== B.SHORT_GRASS && name.indexOf('taiga') >= 0 && rng() < 0.06) {
    scatterPatch(setBlock, rng, x, y, z, BERRY_BUSH, randInt(rng, 2, 5), 2);
    return true;
  }

  // --- Generic ground cover ----------------------------------------------
  const flowerWeight = def.flowerDensity;
  const grassWeight = def.grassDensity;
  const total = flowerWeight + grassWeight;
  if (total <= 0) return false;

  if (rng() * total < flowerWeight) {
    const list = def.flowerTypes;
    if (list.length === 0) return false;
    const id = blockId(pick(rng, list), B.DANDELION);
    scatterPatch(setBlock, rng, x, y, z, id, randInt(rng, 2, 6), 2);
    return true;
  }

  const glist = def.grassTypes;
  if (glist.length === 0) return false;
  const gid = blockId(pick(rng, glist), B.SHORT_GRASS);
  scatterPatch(setBlock, rng, x, y, z, gid, randInt(rng, 3, 8), 2);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Ores                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Place one ore vein using the classic "swept sphere along a tilted segment"
 * algorithm: a short random line is drawn through `(x, y, z)` and a sphere
 * whose radius peaks in the middle is stamped at `size` positions along it.
 *
 * The caller's `setBlock` is expected to reject targets that are not stone-like
 * (the generator's ore writer does exactly that and also swaps in the
 * deepslate variant below the deepslate line).
 *
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x vein centre x
 * @param {number} y vein centre y
 * @param {number} z vein centre z
 * @param {number} blockId ore block id to write
 * @param {number} size nominal vein size (block count target, 1..64)
 * @returns {number} number of `setBlock` calls issued
 */
export function placeOreVein(setBlock, rng, x, y, z, blockId, size) {
  const n = clamp(size | 0, 1, 64);
  if (n <= 2) {
    setBlock(x, y, z, blockId);
    return 1;
  }

  const angle = rng() * Math.PI;
  const spread = n / 8;
  const x0 = x + Math.sin(angle) * spread;
  const x1 = x - Math.sin(angle) * spread;
  const z0 = z + Math.cos(angle) * spread;
  const z1 = z - Math.cos(angle) * spread;
  const y0 = y + randInt(rng, -2, 2);
  const y1 = y + randInt(rng, -2, 2);

  let written = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const cx = x0 + (x1 - x0) * t;
    const cy = y0 + (y1 - y0) * t;
    const cz = z0 + (z1 - z0) * t;
    // Vanilla-shaped bulge: the radius peaks in the middle of the segment.
    // Stamped from the rounded centre so even a sub-unit sphere writes at
    // least one block (size-3 veins would otherwise vanish entirely).
    const r = (Math.sin(Math.PI * t) * n / 16 + 1) * 0.5;
    const bcx = Math.round(cx);
    const bcy = Math.round(cy);
    const bcz = Math.round(cz);
    const ir = Math.ceil(r);
    const r2 = r * r;
    for (let dy = -ir; dy <= ir; dy++) {
      const y2 = dy * dy;
      if (y2 > r2) continue;
      for (let dz = -ir; dz <= ir; dz++) {
        const yz2 = y2 + dz * dz;
        if (yz2 > r2) continue;
        for (let dx = -ir; dx <= ir; dx++) {
          if (yz2 + dx * dx > r2) continue;
          setBlock(bcx + dx, bcy + dy, bcz + dz, blockId);
          written++;
        }
      }
    }
  }
  return written;
}

/* -------------------------------------------------------------------------- */
/* Dungeon                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Carve a mossy cobblestone dungeon: a hollow room with a monster spawner in
 * the middle and one or two loot chests along the walls.
 *
 * `(x, y, z)` is the floor centre — the floor slab is written at `y - 1` and
 * the interior occupies `y .. y + 2`.
 *
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x room centre x
 * @param {number} y room floor y
 * @param {number} z room centre z
 * @returns {boolean} always `true`
 */
export function placeDungeon(setBlock, rng, x, y, z) {
  const hx = randInt(rng, 2, 3);
  const hz = randInt(rng, 2, 3);
  const x0 = x - hx - 1;
  const x1 = x + hx + 1;
  const z0 = z - hz - 1;
  const z1 = z + hz + 1;
  const y0 = y - 1;
  const y1 = y + 3;

  // Shell of cobble with a mossy speckle, then hollow out the interior.
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        const edge = bx === x0 || bx === x1 || bz === z0 || bz === z1
          || by === y0 || by === y1;
        if (!edge) continue;
        const mossy = voxelRandom(bx, by, bz, 0x51a7) < 0.32;
        setBlock(bx, by, bz, mossy ? B.MOSSY_COBBLESTONE : B.COBBLESTONE);
      }
    }
  }
  fillBox(setBlock, x0 + 1, y, z0 + 1, x1 - 1, y1 - 1, z1 - 1, AIR);

  // Random holes punched in the walls make it feel connected to the caves.
  const holes = randInt(rng, 1, 3);
  for (let i = 0; i < holes; i++) {
    const side = (rng() * 4) | 0;
    const hy = y + randInt(rng, 0, 1);
    if (side === 0) setBlock(x0, hy, z + randInt(rng, -hz, hz), AIR);
    else if (side === 1) setBlock(x1, hy, z + randInt(rng, -hz, hz), AIR);
    else if (side === 2) setBlock(x + randInt(rng, -hx, hx), hy, z0, AIR);
    else setBlock(x + randInt(rng, -hx, hx), hy, z1, AIR);
  }

  setBlock(x, y, z, B.SPAWNER);

  // One or two chests, hugged against opposite walls.
  const chests = rng() < 0.55 ? 2 : 1;
  const spots = [
    [x0 + 1, z0 + 1], [x1 - 1, z0 + 1], [x0 + 1, z1 - 1], [x1 - 1, z1 - 1],
    [x0 + 1, z], [x1 - 1, z], [x, z0 + 1], [x, z1 - 1],
  ];
  for (let i = 0; i < chests; i++) {
    const s = pick(rng, spots);
    setBlock(s[0], y, s[1], B.CHEST);
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Ruins                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Stamp a small crumbling ruin: a broken floor slab, a few standing pillars,
 * partial walls and scattered rubble. Palette follows the biome (sandstone in
 * deserts and badlands, prismarine below the sea, mossy stone brick elsewhere).
 *
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x ruin centre x
 * @param {number} y ground y (the floor slab is written at this level)
 * @param {number} z ruin centre z
 * @param {number} biome biome id, selects the palette
 * @returns {boolean} always `true`
 */
export function placeRuins(setBlock, rng, x, y, z, biome) {
  const def = getBiome(biome);
  const arid = def.name === 'desert' || def.name.indexOf('badlands') >= 0;
  const sunken = def.category === 'ocean';

  const main = arid ? B.SANDSTONE : (sunken ? B.PRISMARINE : B.STONE_BRICKS);
  const worn = arid ? B.CUT_SANDSTONE : (sunken ? B.DARK_PRISMARINE : B.MOSSY_STONE_BRICKS);
  const broken = arid ? B.SMOOTH_SANDSTONE : (sunken ? B.PRISMARINE_BRICKS : B.CRACKED_STONE_BRICKS);
  const rubble = arid ? B.SAND : B.COBBLESTONE;

  const hx = randInt(rng, 3, 6);
  const hz = randInt(rng, 3, 6);
  const wallH = randInt(rng, 2, 4);

  // Floor with erosion holes.
  for (let bz = -hz; bz <= hz; bz++) {
    for (let bx = -hx; bx <= hx; bx++) {
      const r = voxelRandom(x + bx, y, z + bz, 0x9c31);
      if (r < 0.18) continue;
      setBlock(x + bx, y, z + bz, r < 0.5 ? worn : (r < 0.8 ? main : broken));
    }
  }

  // Partial perimeter walls: each wall segment survives to a random height.
  for (let bx = -hx; bx <= hx; bx++) {
    for (let s = 0; s < 2; s++) {
      const bz = s === 0 ? -hz : hz;
      const h = Math.round(wallH * (0.2 + rng() * 1.0));
      for (let k = 1; k <= h; k++) {
        if (rng() < 0.16) continue;
        const r = voxelRandom(x + bx, y + k, z + bz, 0x1f77);
        setBlock(x + bx, y + k, z + bz, r < 0.45 ? worn : (r < 0.85 ? main : broken));
      }
    }
  }
  for (let bz = -hz + 1; bz <= hz - 1; bz++) {
    for (let s = 0; s < 2; s++) {
      const bx = s === 0 ? -hx : hx;
      const h = Math.round(wallH * (0.2 + rng() * 1.0));
      for (let k = 1; k <= h; k++) {
        if (rng() < 0.16) continue;
        const r = voxelRandom(x + bx, y + k, z + bz, 0x1f77);
        setBlock(x + bx, y + k, z + bz, r < 0.45 ? worn : (r < 0.85 ? main : broken));
      }
    }
  }

  // Standing pillars.
  const pillars = randInt(rng, 2, 5);
  for (let i = 0; i < pillars; i++) {
    const px = x + randInt(rng, -hx + 1, hx - 1);
    const pz = z + randInt(rng, -hz + 1, hz - 1);
    const ph = randInt(rng, 2, wallH + 3);
    for (let k = 1; k <= ph; k++) {
      setBlock(px, y + k, pz, voxelRandom(px, y + k, pz, 0x77a3) < 0.4 ? worn : main);
    }
    if (rng() < 0.5) setBlock(px, y + ph + 1, pz, broken);
  }

  // Rubble scatter.
  const rubbleCount = randInt(rng, 6, 16);
  for (let i = 0; i < rubbleCount; i++) {
    setBlock(
      x + randInt(rng, -hx - 1, hx + 1), y + 1, z + randInt(rng, -hz - 1, hz + 1), rubble,
    );
  }

  // A single chest tucked into a corner.
  if (rng() < 0.75) {
    setBlock(x + randInt(rng, -hx + 1, hx - 1), y + 1, z + randInt(rng, -hz + 1, hz - 1), B.CHEST);
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Mineshaft                                                                   */
/* -------------------------------------------------------------------------- */

/** Cardinal directions used by the mineshaft walker. @type {number[][]} */
const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Carve one straight mineshaft corridor, with wooden supports, a plank floor,
 * rails, cobwebs and the occasional torch or chest.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rand random source
 * @param {number} sx corridor start x
 * @param {number} sy corridor floor y
 * @param {number} sz corridor start z
 * @param {number} dx step x (`-1`, `0` or `1`)
 * @param {number} dz step z (`-1`, `0` or `1`)
 * @param {number} length corridor length in blocks
 * @returns {number[]} the corridor end point, `[x, y, z]`
 */
function mineshaftCorridor(setBlock, rand, sx, sy, sz, dx, dz, length) {
  // Perpendicular axis for the 3-wide profile.
  const px = dz;
  const pz = dx;
  let cx = sx;
  let cy = sy;
  let cz = sz;

  for (let i = 0; i < length; i++) {
    // Gentle vertical drift keeps corridors from looking machine-made.
    if (i > 0 && rand() < 0.08) cy += rand() < 0.5 ? -1 : 1;

    for (let o = -1; o <= 1; o++) {
      const bx = cx + px * o;
      const bz = cz + pz * o;
      // Hollow the 3x3 profile.
      setBlock(bx, cy, bz, AIR);
      setBlock(bx, cy + 1, bz, AIR);
      setBlock(bx, cy + 2, bz, AIR);
      // Floor: planks under the rail line, dirt-free elsewhere.
      if (rand() < 0.88) setBlock(bx, cy - 1, bz, B.OAK_PLANKS);
    }

    // Support frame every few blocks.
    if (i % 5 === 0 && i > 0) {
      for (let o = -1; o <= 1; o += 2) {
        const bx = cx + px * o;
        const bz = cz + pz * o;
        setBlock(bx, cy, bz, B.OAK_FENCE);
        setBlock(bx, cy + 1, bz, B.OAK_FENCE);
        setBlock(bx, cy + 2, bz, B.OAK_PLANKS);
      }
      setBlock(cx, cy + 2, cz, B.OAK_PLANKS);
      if (rand() < 0.35) setBlock(cx + px, cy + 2, cz + pz, B.TORCH);
    }

    // Rails down the centre, with occasional missing sections.
    if (rand() < 0.72) {
      setBlock(cx, cy, cz, rand() < 0.06 ? B.POWERED_RAIL : B.RAIL);
    }

    // Cobwebs and cave-ins.
    if (rand() < 0.05) {
      setBlock(cx + px * (rand() < 0.5 ? 1 : -1), cy + 1 + ((rand() * 2) | 0), cz + pz, B.COBWEB);
    }
    if (rand() < 0.02) {
      fillBox(setBlock, cx - 1, cy, cz - 1, cx + 1, cy + 1, cz + 1, B.GRAVEL);
    }
    if (rand() < 0.012) {
      setBlock(cx + px, cy, cz + pz, B.CHEST);
    }

    cx += dx;
    cz += dz;
  }
  return [cx, cy, cz];
}

/**
 * Generate an abandoned mineshaft: a network of supported corridors radiating
 * from `(x, y, z)`, with rails, cobwebs, torches, loot chests and a small
 * central cavern.
 *
 * `rngSeed` makes the layout reproducible independently of how much of `rng`
 * the caller has already consumed; pass a per-structure seed.
 *
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng fallback random source when `rngSeed` is not given
 * @param {number} x start x
 * @param {number} y start floor y
 * @param {number} z start z
 * @param {number} rngSeed integer seed for the layout
 * @returns {boolean} always `true`
 */
export function placeMineshaft(setBlock, rng, x, y, z, rngSeed) {
  const rand = Number.isFinite(rngSeed) ? mulberry32(rngSeed | 0) : rng;

  // Central cavern / staging room.
  fillBox(setBlock, x - 3, y, z - 3, x + 3, y + 3, z + 3, AIR);
  for (let bz = -3; bz <= 3; bz++) {
    for (let bx = -3; bx <= 3; bx++) {
      setBlock(x + bx, y - 1, z + bz, rand() < 0.7 ? B.OAK_PLANKS : B.COBBLESTONE);
    }
  }
  for (let o = 0; o < 4; o++) {
    const cxp = x + (o < 2 ? -3 : 3);
    const czp = z + (o % 2 === 0 ? -3 : 3);
    setBlock(cxp, y, czp, B.OAK_FENCE);
    setBlock(cxp, y + 1, czp, B.OAK_FENCE);
    setBlock(cxp, y + 2, czp, B.OAK_PLANKS);
    setBlock(cxp, y + 3, czp, B.TORCH);
  }
  setBlock(x + 2, y, z + 2, B.CHEST);
  setBlock(x - 2, y, z - 2, B.CRAFTING_TABLE);

  /** @type {number[][]} pending corridors: `[x, y, z, dirIndex, depth]` */
  const stack = [];
  const startDirs = randInt(rand, 2, 4);
  for (let i = 0; i < startDirs; i++) {
    stack.push([x, y, z, (rand() * 4) | 0, 0]);
  }

  let carved = 0;
  const maxCorridors = 14;
  while (stack.length > 0 && carved < maxCorridors) {
    const job = stack.pop();
    const dir = CARDINALS[job[3] % 4];
    const len = randInt(rand, 10, 34);
    const end = mineshaftCorridor(setBlock, rand, job[0], job[1], job[2], dir[0], dir[1], len);
    carved++;

    if (job[4] >= 3) continue;
    const branches = rand() < 0.65 ? 2 : 1;
    for (let i = 0; i < branches; i++) {
      if (rand() < 0.3) continue;
      // Branch perpendicular to the corridor just carved: indices 0/1 run
      // along X, 2/3 along Z, so flipping that pair turns the corner.
      const nd = (job[3] < 2 ? 2 : 0) + ((rand() * 2) | 0);
      const along = randInt(rand, 4, Math.max(5, len - 2));
      const bx = job[0] + dir[0] * along;
      const bz = job[2] + dir[1] * along;
      stack.push([bx, end[1], bz, nd, job[4] + 1]);
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Village                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} VillagePalette
 * @property {number} wall primary wall block
 * @property {number} trim corner/post block
 * @property {number} roof roof block
 * @property {number} roofEdge roof edge / stairs block
 * @property {number} floor interior floor block
 * @property {number} ground plot ground block
 * @property {number} path road block
 * @property {number} foundation block used below the plot surface
 * @property {number} fence fence block
 */

/**
 * Choose a village building palette for a biome.
 * @param {number} biome biome id
 * @returns {VillagePalette} palette
 */
function villagePalette(biome) {
  const def = getBiome(biome);
  const name = def.name;
  if (name === 'desert' || name.indexOf('badlands') >= 0) {
    return {
      wall: B.SANDSTONE, trim: B.CUT_SANDSTONE, roof: B.SMOOTH_SANDSTONE,
      roofEdge: B.CUT_SANDSTONE, floor: B.SMOOTH_SANDSTONE, ground: B.SAND,
      path: B.SMOOTH_SANDSTONE, foundation: B.SANDSTONE, fence: B.OAK_FENCE,
    };
  }
  if (name.indexOf('savanna') >= 0) {
    return {
      wall: B.ACACIA_PLANKS, trim: B.ACACIA_LOG, roof: B.ACACIA_PLANKS,
      roofEdge: B.COBBLESTONE, floor: B.ACACIA_PLANKS, ground: B.GRASS_BLOCK,
      path: B.DIRT_PATH, foundation: B.DIRT, fence: B.OAK_FENCE,
    };
  }
  if (name.indexOf('taiga') >= 0 || name.indexOf('snowy') >= 0
      || name === 'grove' || name === 'meadow') {
    return {
      wall: B.SPRUCE_PLANKS, trim: B.SPRUCE_LOG, roof: B.SPRUCE_PLANKS,
      roofEdge: B.COBBLESTONE, floor: B.SPRUCE_PLANKS, ground: B.GRASS_BLOCK,
      path: B.DIRT_PATH, foundation: B.DIRT, fence: B.OAK_FENCE,
    };
  }
  return {
    wall: B.OAK_PLANKS, trim: B.OAK_LOG, roof: B.OAK_PLANKS,
    roofEdge: B.COBBLESTONE, floor: B.OAK_PLANKS, ground: B.GRASS_BLOCK,
    path: B.DIRT_PATH, foundation: B.DIRT, fence: B.OAK_FENCE,
  };
}

/**
 * Flatten a rectangular plot: solid foundation below, one clean ground layer,
 * and clear air above.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} x plot centre x
 * @param {number} y plot surface y (ground layer is written here)
 * @param {number} z plot centre z
 * @param {number} hx half width on x
 * @param {number} hz half width on z
 * @param {VillagePalette} pal palette
 * @param {number} clearHeight how much air to carve above the plot
 * @returns {void}
 */
function flattenPlot(setBlock, x, y, z, hx, hz, pal, clearHeight) {
  fillBox(setBlock, x - hx, y - 4, z - hz, x + hx, y - 1, z + hz, pal.foundation);
  fillBox(setBlock, x - hx, y, z - hz, x + hx, y, z + hz, pal.ground);
  fillBox(setBlock, x - hx, y + 1, z - hz, x + hx, y + clearHeight, z + hz, AIR);
}

/**
 * Build a gabled roof over a rectangular footprint.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} x building centre x
 * @param {number} y eaves y (first roof layer)
 * @param {number} z building centre z
 * @param {number} hx half width on x (including walls)
 * @param {number} hz half width on z (including walls)
 * @param {VillagePalette} pal palette
 * @returns {void}
 */
function gableRoof(setBlock, x, y, z, hx, hz, pal) {
  const span = Math.min(hx, hz);
  for (let k = 0; k <= span; k++) {
    const rx = hx - k + 1;
    const rz = hz - k + 1;
    if (rx < 0 || rz < 0) break;
    for (let bz = -rz; bz <= rz; bz++) {
      for (let bx = -rx; bx <= rx; bx++) {
        const rim = bx === -rx || bx === rx || bz === -rz || bz === rz;
        // Only the overhanging eaves course uses the contrasting edge block;
        // every step above it is roof material, so the silhouette reads as a
        // stepped wooden roof rather than a stone ziggurat.
        if (k === 0) setBlock(x + bx, y, z + bz, rim ? pal.roofEdge : pal.roof);
        else if (rim) setBlock(x + bx, y + k, z + bz, pal.roof);
      }
    }
  }
}

/**
 * Build one village house: walls, door, windows, floor, roof and a small
 * interior fit-out.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x building centre x
 * @param {number} y ground y
 * @param {number} z building centre z
 * @param {number} hx interior half width on x
 * @param {number} hz interior half width on z
 * @param {number} wallH interior wall height
 * @param {VillagePalette} pal palette
 * @returns {void}
 */
function villageHouse(setBlock, rng, x, y, z, hx, hz, wallH, pal) {
  const x0 = x - hx;
  const x1 = x + hx;
  const z0 = z - hz;
  const z1 = z + hz;
  const top = y + wallH;

  // Floor and walls.
  fillBox(setBlock, x0, y, z0, x1, y, z1, pal.floor);
  for (let by = y + 1; by <= top; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        if (bx !== x0 && bx !== x1 && bz !== z0 && bz !== z1) continue;
        const corner = (bx === x0 || bx === x1) && (bz === z0 || bz === z1);
        setBlock(bx, by, bz, corner ? pal.trim : pal.wall);
      }
    }
  }
  // Ceiling.
  fillBox(setBlock, x0, top + 1, z0, x1, top + 1, z1, pal.wall);
  gableRoof(setBlock, x, top + 1, z, hx, hz, pal);

  // Door on a random wall.
  const side = (rng() * 4) | 0;
  let dxp = x;
  let dzp = z;
  if (side === 0) dzp = z0;
  else if (side === 1) dzp = z1;
  else if (side === 2) dxp = x0;
  else dxp = x1;
  setBlock(dxp, y + 1, dzp, B.OAK_DOOR);
  setBlock(dxp, y + 2, dzp, B.OAK_DOOR);
  setBlock(dxp, y + 3 > top ? top : y + 3, dzp, pal.wall);

  // Windows at eye height.
  const wy = y + 2;
  for (let bx = x0 + 1; bx <= x1 - 1; bx += 2) {
    if (rng() < 0.45) continue;
    setBlock(bx, wy, z0, B.GLASS_PANE);
    setBlock(bx, wy, z1, B.GLASS_PANE);
  }
  for (let bz = z0 + 1; bz <= z1 - 1; bz += 2) {
    if (rng() < 0.45) continue;
    setBlock(x0, wy, bz, B.GLASS_PANE);
    setBlock(x1, wy, bz, B.GLASS_PANE);
  }

  // Interior: bed, work station, storage, light. This block set has no bed,
  // so a red/white wool pair stands in for one.
  const bedFoot = z0 + 2 <= z1 - 1 ? z0 + 2 : z0 + 1;
  setBlock(x0 + 1, y + 1, z0 + 1, B.RED_WOOL);
  setBlock(x0 + 1, y + 1, bedFoot, B.WHITE_WOOL);
  setBlock(x1 - 1, y + 1, z1 - 1, rng() < 0.5 ? B.CRAFTING_TABLE : B.FURNACE);
  setBlock(x1 - 1, y + 1, z0 + 1, rng() < 0.5 ? B.BARREL : B.CHEST);
  if (hx >= 3 && rng() < 0.5) setBlock(x0 + 1, y + 1, z1 - 1, B.BOOKSHELF);
  setBlock(x, top, z, B.LANTERN);
  setBlock(x0 + 1, y + 1, z, B.TORCH);
}

/**
 * Build a fenced village farm: raised soil beds, a central water channel and
 * four crop rows.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x farm centre x
 * @param {number} y ground y
 * @param {number} z farm centre z
 * @param {number} hx half width on x
 * @param {number} hz half width on z
 * @param {VillagePalette} pal palette
 * @returns {void}
 */
function villageFarm(setBlock, rng, x, y, z, hx, hz, pal) {
  const crops = [B.WHEAT_STAGE3, B.CARROTS_STAGE3, B.POTATOES_STAGE3, B.BEETROOT_STAGE3];
  const crop = pick(rng, crops);

  for (let bz = -hz; bz <= hz; bz++) {
    for (let bx = -hx; bx <= hx; bx++) {
      const border = bx === -hx || bx === hx || bz === -hz || bz === hz;
      if (border) {
        setBlock(x + bx, y, z + bz, pal.ground);
        setBlock(x + bx, y + 1, z + bz, pal.fence);
        continue;
      }
      if (bz === 0) {
        setBlock(x + bx, y, z + bz, B.WATER);
        continue;
      }
      setBlock(x + bx, y, z + bz, B.FARMLAND);
      if (rng() < 0.86) {
        setBlock(x + bx, y + 1, z + bz, rng() < 0.15 ? crops[(rng() * 4) | 0] : crop);
      }
    }
  }
  // Lantern post at a corner.
  setBlock(x - hx, y + 1, z - hz, pal.fence);
  setBlock(x - hx, y + 2, z - hz, pal.fence);
  setBlock(x - hx, y + 3, z - hz, B.LANTERN);
}

/**
 * Build the village well: a cobblestone rim, a water shaft and a roofed frame.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} x well centre x
 * @param {number} y ground y
 * @param {number} z well centre z
 * @param {VillagePalette} pal palette
 * @returns {void}
 */
function villageWell(setBlock, x, y, z, pal) {
  shellBox(setBlock, x - 2, y, z - 2, x + 2, y + 1, z + 2, B.COBBLESTONE);
  fillBox(setBlock, x - 1, y - 6, z - 1, x + 1, y + 0, z + 1, B.WATER);
  fillBox(setBlock, x - 1, y - 7, z - 1, x + 1, y - 7, z + 1, B.COBBLESTONE);
  for (let dx = -2; dx <= 2; dx += 4) {
    for (let dz = -2; dz <= 2; dz += 4) {
      setBlock(x + dx, y + 2, z + dz, pal.fence);
      setBlock(x + dx, y + 3, z + dz, pal.fence);
    }
  }
  fillBox(setBlock, x - 2, y + 4, z - 2, x + 2, y + 4, z + 2, pal.roof);
  setBlock(x, y + 5, z, B.LANTERN);
}

/**
 * Build the village watchtower: a square shaft with a ladder and a lit crown.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} x tower centre x
 * @param {number} y ground y
 * @param {number} z tower centre z
 * @param {number} height tower height above ground
 * @param {VillagePalette} pal palette
 * @returns {void}
 */
function villageTower(setBlock, x, y, z, height, pal) {
  for (let k = 1; k <= height; k++) {
    shellBox(setBlock, x - 1, y + k, z - 1, x + 1, y + k, z + 1, k % 4 === 0 ? pal.trim : B.COBBLESTONE);
    setBlock(x, y + k, z, AIR);
    setBlock(x, y + k, z - 1, B.LADDER);
  }
  fillBox(setBlock, x - 2, y + height + 1, z - 2, x + 2, y + height + 1, z + 2, B.COBBLESTONE);
  for (let dx = -2; dx <= 2; dx++) {
    setBlock(x + dx, y + height + 2, z - 2, pal.fence);
    setBlock(x + dx, y + height + 2, z + 2, pal.fence);
  }
  for (let dz = -1; dz <= 1; dz++) {
    setBlock(x - 2, y + height + 2, z + dz, pal.fence);
    setBlock(x + 2, y + height + 2, z + dz, pal.fence);
  }
  setBlock(x, y + height + 2, z, B.LANTERN);
}

/**
 * Build an open-fronted barn stacked with hay.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng random source
 * @param {number} x barn centre x
 * @param {number} y ground y
 * @param {number} z barn centre z
 * @param {number} hx half width on x
 * @param {number} hz half width on z
 * @param {VillagePalette} pal palette
 * @returns {void}
 */
function villageBarn(setBlock, rng, x, y, z, hx, hz, pal) {
  fillBox(setBlock, x - hx, y, z - hz, x + hx, y, z + hz, pal.floor);
  for (let by = y + 1; by <= y + 4; by++) {
    for (let bz = -hz; bz <= hz; bz++) {
      for (let bx = -hx; bx <= hx; bx++) {
        const rim = bx === -hx || bx === hx || bz === -hz || bz === hz;
        if (!rim) continue;
        if (bz === hz && bx > -hx + 1 && bx < hx - 1 && by <= y + 3) continue; // open front
        const corner = (bx === -hx || bx === hx) && (bz === -hz || bz === hz);
        setBlock(x + bx, by, z + bz, corner ? pal.trim : pal.wall);
      }
    }
  }
  fillBox(setBlock, x - hx, y + 5, z - hz, x + hx, y + 5, z + hz, pal.roof);
  gableRoof(setBlock, x, y + 5, z, hx, hz, pal);

  const bales = randInt(rng, 4, 10);
  for (let i = 0; i < bales; i++) {
    const bx = x + randInt(rng, -hx + 1, hx - 1);
    const bz = z + randInt(rng, -hz + 1, hz - 1);
    const h = randInt(rng, 1, 3);
    for (let k = 1; k <= h; k++) setBlock(bx, y + k, bz, B.HAY_BLOCK);
  }
  setBlock(x - hx + 1, y + 4, z, B.LANTERN);
}

/**
 * Lay an L-shaped village road between two points, flattening as it goes.
 * Cells inside the guard square are skipped so the road never eats the well.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {number} ax start x
 * @param {number} ay road surface y
 * @param {number} az start z
 * @param {number} bx end x
 * @param {number} bz end z
 * @param {VillagePalette} pal palette
 * @param {number} gx guard centre x
 * @param {number} gz guard centre z
 * @param {number} gr guard half-size (Chebyshev radius); `0` disables it
 * @returns {void}
 */
function villagePath(setBlock, ax, ay, az, bx, bz, pal, gx, gz, gr) {
  const stepX = bx >= ax ? 1 : -1;
  const stepZ = bz >= az ? 1 : -1;

  /**
   * Write one road cell unless it falls inside the guard square.
   * @param {number} px cell x
   * @param {number} pz cell z
   * @returns {void}
   */
  const cell = (px, pz) => {
    if (gr > 0 && Math.abs(px - gx) <= gr && Math.abs(pz - gz) <= gr) return;
    setBlock(px, ay - 1, pz, pal.foundation);
    setBlock(px, ay, pz, pal.path);
    setBlock(px, ay + 1, pz, AIR);
    setBlock(px, ay + 2, pz, AIR);
  };

  for (let px = ax; px !== bx + stepX; px += stepX) {
    for (let o = -1; o <= 1; o++) cell(px, az + o);
  }
  for (let pz = az; pz !== bz + stepZ; pz += stepZ) {
    for (let o = -1; o <= 1; o++) cell(bx + o, pz);
  }
}

/**
 * Generate a village: a central well, five to twelve buildings drawn from a
 * small template set placed on flattened plots, roads linking them, farms and
 * lantern posts. Palette and crops follow the biome.
 *
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x village centre x
 * @param {number} y village ground y
 * @param {number} z village centre z
 * @param {number} biome biome id
 * @returns {boolean} always `true`
 */
export function placeVillage(setBlock, rng, x, y, z, biome) {
  const pal = villagePalette(biome);
  const wanted = randInt(rng, 5, 12);
  const kinds = ['house', 'house', 'house', 'big_house', 'farm', 'farm', 'barn', 'tower'];

  /** @type {number[][]} chosen plots: `[cx, cz, hx, hz, kindIndex, lanternSide]` */
  const plots = [];
  /** @type {number[][]} occupancy including the central square */
  const taken = [[x, z, 5, 5]];

  // --- 1. Lay out plots ---------------------------------------------------
  let attempts = 0;
  while (plots.length < wanted && attempts < 160) {
    attempts++;
    const kindIndex = (rng() * kinds.length) | 0;
    const kind = kinds[kindIndex < kinds.length ? kindIndex : kinds.length - 1];
    let hx = 3;
    let hz = 3;
    if (kind === 'big_house') { hx = 4; hz = 4; }
    else if (kind === 'farm') { hx = 4; hz = 3; }
    else if (kind === 'barn') { hx = 5; hz = 3; }
    else if (kind === 'tower') { hx = 2; hz = 2; }

    const angle = rng() * Math.PI * 2;
    const radius = 10 + rng() * 26;
    const px = x + Math.round(Math.cos(angle) * radius);
    const pz = z + Math.round(Math.sin(angle) * radius);
    const lanternSide = rng() < 0.5 ? 1 : -1;

    let clash = false;
    for (let i = 0; i < taken.length; i++) {
      const p = taken[i];
      if (Math.abs(px - p[0]) < hx + p[2] + 3 && Math.abs(pz - p[1]) < hz + p[3] + 3) {
        clash = true;
        break;
      }
    }
    if (clash) continue;

    taken.push([px, pz, hx, hz]);
    plots.push([px, pz, hx, hz, kindIndex < kinds.length ? kindIndex : kinds.length - 1,
      lanternSide]);
  }

  // --- 2. Flatten every plot before anything is built ---------------------
  flattenPlot(setBlock, x, y, z, 5, 5, pal, 8);
  for (let i = 0; i < plots.length; i++) {
    const p = plots[i];
    flattenPlot(setBlock, p[0], y, p[1], p[2] + 1, p[3] + 1, pal, 10);
  }

  // --- 3. Roads (drawn before buildings so they never cut through one) ----
  fillBox(setBlock, x - 5, y, z - 5, x + 5, y, z + 5, pal.path);
  for (let i = 0; i < plots.length; i++) {
    villagePath(setBlock, x, y, z, plots[i][0], plots[i][1], pal, x, z, 3);
  }

  // --- 4. Buildings -------------------------------------------------------
  villageWell(setBlock, x, y, z, pal);
  for (let i = 0; i < plots.length; i++) {
    const p = plots[i];
    const px = p[0];
    const pz = p[1];
    const hx = p[2];
    const hz = p[3];
    const kind = kinds[p[4]];

    if (kind === 'farm') {
      villageFarm(setBlock, rng, px, y, pz, hx, hz, pal);
    } else if (kind === 'barn') {
      villageBarn(setBlock, rng, px, y, pz, hx, hz, pal);
    } else if (kind === 'tower') {
      villageTower(setBlock, px, y, pz, randInt(rng, 7, 11), pal);
    } else {
      villageHouse(setBlock, rng, px, y, pz, hx, hz, kind === 'big_house' ? 5 : 4, pal);
    }

    // Lantern post beside the plot entrance.
    const lx = px + p[5] * (hx + 2);
    setBlock(lx, y + 1, pz, pal.fence);
    setBlock(lx, y + 2, pz, pal.fence);
    setBlock(lx, y + 3, pz, B.LANTERN);
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Desert pyramid                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a desert pyramid: a 21x21 stepped sandstone mass with terracotta
 * ornament, two crown towers, a hollow upper chamber and a buried treasure
 * room holding four chests around a TNT-trapped pressure plate.
 *
 * `(x, y, z)` is the centre of the pyramid's base course.
 *
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x centre x
 * @param {number} y base y (sand level)
 * @param {number} z centre z
 * @returns {boolean} always `true`
 */
export function placeDesertPyramid(setBlock, rng, x, y, z) {
  const half = 10;
  const levels = 10;

  // Foundation so the pyramid never floats over a dune slope.
  fillBox(setBlock, x - half, y - 5, z - half, x + half, y - 1, z + half, B.SANDSTONE);

  // Stepped mass.
  for (let k = 0; k < levels; k++) {
    const h = half - k;
    if (h < 1) break;
    for (let bz = -h; bz <= h; bz++) {
      for (let bx = -h; bx <= h; bx++) {
        const rim = bx === -h || bx === h || bz === -h || bz === h;
        const r = voxelRandom(x + bx, y + k, z + bz, 0x2ce1);
        let id = B.SANDSTONE;
        if (rim) id = r < 0.25 ? B.CUT_SANDSTONE : B.SANDSTONE;
        else if (r < 0.12) id = B.SMOOTH_SANDSTONE;
        setBlock(x + bx, y + k, z + bz, id);
      }
    }
  }

  // Crown towers.
  for (let s = 0; s < 2; s++) {
    const tx = x + (s === 0 ? -half + 1 : half - 1);
    for (let k = 0; k < 5; k++) {
      shellBox(setBlock, tx - 1, y + levels - 1 + k, z - 1, tx + 1, y + levels - 1 + k, z + 1,
        k === 4 ? B.CUT_SANDSTONE : B.SANDSTONE);
    }
    setBlock(tx, y + levels + 4, z, B.ORANGE_TERRACOTTA);
  }

  // Terracotta ornament on the four faces.
  for (let s = 0; s < 4; s++) {
    const dx = s === 0 ? -half : (s === 1 ? half : 0);
    const dz = s === 2 ? -half : (s === 3 ? half : 0);
    const alongX = s < 2 ? 0 : 1;
    const alongZ = s < 2 ? 1 : 0;
    for (let k = 1; k <= 4; k++) {
      for (let o = -2; o <= 2; o++) {
        const id = (o === 0) ? B.CYAN_TERRACOTTA
          : (Math.abs(o) === 1 ? B.ORANGE_TERRACOTTA : B.CUT_SANDSTONE);
        setBlock(x + dx + alongX * o, y + k, z + dz + alongZ * o, id);
      }
    }
  }

  // Hollow upper chamber with a hidden shaft.
  fillBox(setBlock, x - 3, y + 1, z - 3, x + 3, y + 4, z + 3, AIR);
  shellBox(setBlock, x - 4, y, z - 4, x + 4, y + 5, z + 4, B.SANDSTONE);
  fillBox(setBlock, x - 3, y + 1, z - 3, x + 3, y + 4, z + 3, AIR);
  setBlock(x, y + 5, z, B.CUT_SANDSTONE);
  setBlock(x - 3, y + 1, z - 3, B.TORCH);
  setBlock(x + 3, y + 1, z + 3, B.TORCH);

  // Shaft down to the treasure room.
  const roomY = y - 13;
  fillBox(setBlock, x, roomY + 1, z, x, y, z, AIR);

  // Treasure room.
  shellBox(setBlock, x - 5, roomY - 1, z - 5, x + 5, roomY + 4, z + 5, B.SANDSTONE);
  fillBox(setBlock, x - 4, roomY, z - 4, x + 4, roomY + 3, z + 4, AIR);
  fillBox(setBlock, x - 4, roomY - 1, z - 4, x + 4, roomY - 1, z + 4, B.CUT_SANDSTONE);

  // Chessboard floor accent around the trap.
  for (let bz = -2; bz <= 2; bz++) {
    for (let bx = -2; bx <= 2; bx++) {
      setBlock(x + bx, roomY - 1, z + bz,
        ((bx + bz) & 1) === 0 ? B.ORANGE_TERRACOTTA : B.CYAN_TERRACOTTA);
    }
  }

  // TNT trap under the plate.
  for (let k = 1; k <= 3; k++) {
    fillBox(setBlock, x - 1, roomY - 1 - k, z - 1, x + 1, roomY - 1 - k, z + 1, B.TNT);
  }
  setBlock(x, roomY - 1, z, B.STONE_PRESSURE_PLATE);

  // Four chests, one per corner of the trap.
  setBlock(x - 2, roomY, z, B.CHEST);
  setBlock(x + 2, roomY, z, B.CHEST);
  setBlock(x, roomY, z - 2, B.CHEST);
  setBlock(x, roomY, z + 2, B.CHEST);
  setBlock(x - 4, roomY + 2, z - 4, B.TORCH);
  setBlock(x + 4, roomY + 2, z + 4, B.TORCH);
  if (rng() < 0.5) setBlock(x - 4, roomY, z + 4, B.CHEST);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Amethyst geode                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Carve an amethyst geode: a hollow lens with concentric amethyst, calcite and
 * basalt shells, budding amethyst studded across the inner wall and clusters
 * growing into the cavity.
 *
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x geode centre x
 * @param {number} y geode centre y
 * @param {number} z geode centre z
 * @returns {boolean} always `true`
 */
export function placeAmethystGeode(setBlock, rng, x, y, z) {
  const inner = 3.2 + rng() * 2.2;
  const amethyst = inner + 1.0;
  const calcite = amethyst + 1.0;
  const basalt = calcite + 1.0;
  const outer = Math.ceil(basalt) + 1;

  // Per-geode wobble phases keep the shell irregular but deterministic.
  const p1 = rng() * 6.2831853;
  const p2 = rng() * 6.2831853;
  const p3 = rng() * 6.2831853;

  for (let dy = -outer; dy <= outer; dy++) {
    for (let dz = -outer; dz <= outer; dz++) {
      for (let dx = -outer; dx <= outer; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy * 1.25 + dz * dz);
        if (d > basalt + 1.2) continue;
        const wobble = 0.55 * Math.sin(dx * 0.9 + p1)
          + 0.45 * Math.sin(dy * 1.1 + p2)
          + 0.5 * Math.sin(dz * 0.8 + p3);
        const r = d + wobble;
        const bx = x + dx;
        const by = y + dy;
        const bz = z + dz;

        if (r < inner) {
          setBlock(bx, by, bz, AIR);
        } else if (r < amethyst) {
          const budding = voxelRandom(bx, by, bz, 0x7e11) < 0.14;
          setBlock(bx, by, bz, budding ? B.BUDDING_AMETHYST : B.AMETHYST_BLOCK);
        } else if (r < calcite) {
          setBlock(bx, by, bz, B.CALCITE);
        } else if (r < basalt) {
          setBlock(bx, by, bz, B.BASALT);
        }
      }
    }
  }

  // Clusters growing off the inner shell into the cavity.
  const clusters = randInt(rng, 10, 26);
  for (let i = 0; i < clusters; i++) {
    const a = rng() * Math.PI * 2;
    const e = (rng() * 2 - 1) * Math.PI * 0.5;
    const r = inner - 0.6;
    const cx = x + Math.round(Math.cos(a) * Math.cos(e) * r);
    const cy = y + Math.round(Math.sin(e) * r * 0.85);
    const cz = z + Math.round(Math.sin(a) * Math.cos(e) * r);
    setBlock(cx, cy, cz, B.AMETHYST_CLUSTER);
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Stronghold room                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a stronghold room: weathered stone-brick shell, corner pillars, iron
 * bar windows, torches and either a library fit-out (bookshelves plus a
 * walkway) or an empty hall with a loot chest.
 *
 * `(x, y, z)` is the floor centre; the floor slab is written at `y - 1`.
 *
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x room centre x
 * @param {number} y room floor y
 * @param {number} z room centre z
 * @returns {boolean} always `true`
 */
export function placeStrongholdRoom(setBlock, rng, x, y, z) {
  const hx = randInt(rng, 4, 6);
  const hz = randInt(rng, 4, 6);
  const h = randInt(rng, 4, 6);
  const x0 = x - hx;
  const x1 = x + hx;
  const z0 = z - hz;
  const z1 = z + hz;
  const y0 = y - 1;
  const y1 = y + h;

  // Weathered shell.
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        const edge = bx === x0 || bx === x1 || bz === z0 || bz === z1
          || by === y0 || by === y1;
        if (!edge) continue;
        const r = voxelRandom(bx, by, bz, 0x3d5b);
        let id = B.STONE_BRICKS;
        if (r < 0.18) id = B.MOSSY_STONE_BRICKS;
        else if (r < 0.30) id = B.CRACKED_STONE_BRICKS;
        else if (r < 0.33) id = B.CHISELED_STONE_BRICKS;
        setBlock(bx, by, bz, id);
      }
    }
  }
  fillBox(setBlock, x0 + 1, y, z0 + 1, x1 - 1, y1 - 1, z1 - 1, AIR);

  // Corner pillars.
  const corners = [[x0 + 1, z0 + 1], [x1 - 1, z0 + 1], [x0 + 1, z1 - 1], [x1 - 1, z1 - 1]];
  for (let i = 0; i < corners.length; i++) {
    for (let by = y; by < y1; by++) {
      setBlock(corners[i][0], by, corners[i][1], B.STONE_BRICKS);
    }
    setBlock(corners[i][0], y1 - 1, corners[i][1], B.CHISELED_STONE_BRICKS);
  }

  // Iron bar windows and torches.
  for (let bx = x0 + 2; bx <= x1 - 2; bx += 3) {
    setBlock(bx, y + 2, z0, B.IRON_BARS);
    setBlock(bx, y + 2, z1, B.IRON_BARS);
    setBlock(bx, y + 3, z0 + 1, B.TORCH);
  }
  for (let bz = z0 + 2; bz <= z1 - 2; bz += 3) {
    setBlock(x0, y + 2, bz, B.IRON_BARS);
    setBlock(x1, y + 2, bz, B.IRON_BARS);
    setBlock(x1 - 1, y + 3, bz, B.TORCH);
  }

  if (rng() < 0.5) {
    // Library variant: shelves along the walls plus a wooden walkway.
    for (let bx = x0 + 2; bx <= x1 - 2; bx++) {
      for (let by = y; by <= y + 2; by++) {
        setBlock(bx, by, z0 + 1, B.BOOKSHELF);
        setBlock(bx, by, z1 - 1, B.BOOKSHELF);
      }
    }
    for (let bx = x0 + 1; bx <= x1 - 1; bx++) {
      setBlock(bx, y + 3, z, B.OAK_PLANKS);
      if ((bx & 1) === 0) setBlock(bx, y + 4, z, B.LANTERN);
    }
    setBlock(x0 + 2, y + 3, z + 1, B.LADDER);
    setBlock(x, y, z, B.CHEST);
    setBlock(x + 1, y, z, B.ENCHANTING_TABLE);
  } else {
    // Hall variant: central plinth, chest and a cauldron.
    fillBox(setBlock, x - 1, y, z - 1, x + 1, y, z + 1, B.STONE_BRICKS);
    setBlock(x, y + 1, z, B.CHEST);
    setBlock(x - 2, y, z - 2, B.CAULDRON);
    setBlock(x + 2, y, z + 2, B.CRAFTING_TABLE);
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Small scatter features                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Drop a mossy boulder on the surface (taiga / stony biomes).
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x centre x
 * @param {number} y ground y
 * @param {number} z centre z
 * @returns {boolean} always `true`
 */
export function placeBoulder(setBlock, rng, x, y, z) {
  const lumps = randInt(rng, 1, 3);
  for (let i = 0; i < lumps; i++) {
    const r = 1.4 + rng() * 1.6;
    const cx = x + randInt(rng, -2, 2);
    const cz = z + randInt(rng, -2, 2);
    const cy = y + randInt(rng, 0, 1);
    const ir = Math.ceil(r);
    for (let dy = -ir; dy <= ir; dy++) {
      for (let dz = -ir; dz <= ir; dz++) {
        for (let dx = -ir; dx <= ir; dx++) {
          if (dx * dx + dy * dy + dz * dz > r * r) continue;
          const moss = voxelRandom(cx + dx, cy + dy, cz + dz, 0x4411) < 0.35;
          setBlock(cx + dx, cy + dy, cz + dz, moss ? B.MOSSY_COBBLESTONE : B.COBBLESTONE);
        }
      }
    }
  }
  return true;
}

/**
 * Build a desert well: a sandstone rim, a water basin and four pillars under a
 * slab roof.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x centre x
 * @param {number} y ground y
 * @param {number} z centre z
 * @returns {boolean} always `true`
 */
export function placeDesertWell(setBlock, rng, x, y, z) {
  fillBox(setBlock, x - 2, y - 1, z - 2, x + 2, y - 1, z + 2, B.SANDSTONE);
  shellBox(setBlock, x - 2, y, z - 2, x + 2, y, z + 2, B.SANDSTONE);
  fillBox(setBlock, x - 1, y - 3, z - 1, x + 1, y, z + 1, B.WATER);
  fillBox(setBlock, x - 1, y - 4, z - 1, x + 1, y - 4, z + 1, B.SANDSTONE);
  for (let dx = -2; dx <= 2; dx += 4) {
    for (let dz = -2; dz <= 2; dz += 4) {
      for (let k = 1; k <= 3; k++) setBlock(x + dx, y + k, z + dz, B.CUT_SANDSTONE);
    }
  }
  fillBox(setBlock, x - 2, y + 4, z - 2, x + 2, y + 4, z + 2, B.SMOOTH_SANDSTONE);
  if (rng() < 0.4) setBlock(x, y + 5, z, B.CUT_SANDSTONE);
  return true;
}

/**
 * Grow a giant mushroom. This registry has no mushroom-block family, so the
 * stem uses quartz and the cap uses red or brown terracotta.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x stem x
 * @param {number} y ground y
 * @param {number} z stem z
 * @param {boolean} [red] `true` for the red variant; random when omitted
 * @returns {boolean} always `true`
 */
export function placeGiantMushroom(setBlock, rng, x, y, z, red) {
  const isRed = red === undefined ? rng() < 0.5 : red;
  const capId = isRed ? B.RED_TERRACOTTA : B.BROWN_TERRACOTTA;
  const stemId = B.QUARTZ_BLOCK;
  const h = randInt(rng, 5, 9);
  const base = y + 1;
  const top = base + h - 1;

  if (isRed) {
    // Domed cap with a skirt.
    leafDisc(setBlock, rng, x, top, z, 3, capId, 0.0);
    leafDisc(setBlock, rng, x, top + 1, z, 2.2, capId, 0.0);
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > 10 || d2 < 5) continue;
        setBlock(x + dx, top - 1, z + dz, capId);
      }
    }
  } else {
    // Flat plate cap.
    leafDisc(setBlock, rng, x, top + 1, z, 4, capId, 0.0);
    leafDisc(setBlock, rng, x, top, z, 2.2, capId, 0.0);
  }
  trunkColumn(setBlock, x, base, top, z, stemId);
  return true;
}

/**
 * Raise a packed-ice spike (ice spikes biome).
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x spike x
 * @param {number} y ground y
 * @param {number} z spike z
 * @returns {boolean} always `true`
 */
export function placeIceSpike(setBlock, rng, x, y, z) {
  const h = randInt(rng, 7, 24);
  const baseR = 1 + (h > 16 ? 1 : 0) + (rng() < 0.3 ? 1 : 0);
  for (let k = 0; k <= h; k++) {
    const t = k / h;
    const r = baseR * (1 - t * t);
    const ir = Math.round(r);
    for (let dz = -ir; dz <= ir; dz++) {
      for (let dx = -ir; dx <= ir; dx++) {
        if (dx * dx + dz * dz > r * r + 0.4) continue;
        setBlock(x + dx, y + k, z + dz, B.PACKED_ICE);
      }
    }
  }
  setBlock(x, y + h + 1, z, B.PACKED_ICE);
  // Frozen apron.
  for (let dz = -baseR - 1; dz <= baseR + 1; dz++) {
    for (let dx = -baseR - 1; dx <= baseR + 1; dx++) {
      if (rng() < 0.4) setBlock(x + dx, y, z + dz, B.PACKED_ICE);
    }
  }
  return true;
}

/**
 * Lay a mossy fallen log with a couple of mushrooms growing on it.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x log start x
 * @param {number} y ground y
 * @param {number} z log start z
 * @param {number} [logId=B.OAK_LOG] log block id
 * @returns {boolean} always `true`
 */
export function placeFallenLog(setBlock, rng, x, y, z, logId = B.OAK_LOG) {
  const dir = pick(rng, CARDINALS);
  // Perpendicular offset so the log can be two blocks wide in places.
  const px = dir[1];
  const pz = dir[0];
  const len = randInt(rng, 3, 7);
  for (let i = 0; i < len; i++) {
    const bx = x + dir[0] * i;
    const bz = z + dir[1] * i;
    setBlock(bx, y + 1, bz, logId);
    if (rng() < 0.3) setBlock(bx + px, y + 1, bz + pz, logId);
    if (rng() < 0.22) setBlock(bx, y + 2, bz, rng() < 0.5 ? B.BROWN_MUSHROOM : B.RED_MUSHROOM);
    if (rng() < 0.3) setBlock(bx, y, bz, B.MOSS_BLOCK);
  }
  return true;
}

/**
 * Build a swamp witch hut on stilts.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x hut centre x
 * @param {number} y water/ground level
 * @param {number} z hut centre z
 * @returns {boolean} always `true`
 */
export function placeWitchHut(setBlock, rng, x, y, z) {
  const floorY = y + 4;
  // Stilts.
  for (let dx = -3; dx <= 3; dx += 2) {
    for (let dz = -3; dz <= 3; dz += 2) {
      if (Math.abs(dx) !== 3 && Math.abs(dz) !== 3) continue;
      for (let k = 0; k < 5; k++) setBlock(x + dx, y + k, z + dz, B.OAK_FENCE);
    }
  }
  fillBox(setBlock, x - 3, floorY, z - 3, x + 3, floorY, z + 3, B.SPRUCE_PLANKS);
  for (let by = floorY + 1; by <= floorY + 3; by++) {
    for (let bz = -3; bz <= 3; bz++) {
      for (let bx = -3; bx <= 3; bx++) {
        const rim = bx === -3 || bx === 3 || bz === -3 || bz === 3;
        if (!rim) continue;
        const corner = Math.abs(bx) === 3 && Math.abs(bz) === 3;
        setBlock(x + bx, by, z + bz, corner ? B.SPRUCE_LOG : B.SPRUCE_PLANKS);
      }
    }
  }
  setBlock(x, floorY + 1, z + 3, AIR);
  setBlock(x, floorY + 2, z + 3, AIR);
  fillBox(setBlock, x - 4, floorY + 4, z - 4, x + 4, floorY + 4, z + 4, B.SPRUCE_PLANKS);
  setBlock(x - 2, floorY + 1, z - 2, B.CAULDRON);
  setBlock(x + 2, floorY + 1, z - 2, B.CRAFTING_TABLE);
  setBlock(x + 2, floorY + 1, z + 2, B.BREWING_STAND);
  setBlock(x - 2, floorY + 3, z + 2, B.TORCH);
  if (rng() < 0.6) setBlock(x - 2, floorY + 1, z + 2, B.RED_MUSHROOM);
  return true;
}

/**
 * Carve a small surface pond and fill it with a fluid.
 * @param {(x:number,y:number,z:number,id:number)=>void} setBlock world writer
 * @param {() => number} rng seeded random source
 * @param {number} x pond centre x
 * @param {number} y pond surface y (fluid top)
 * @param {number} z pond centre z
 * @param {number} [fluid=B.WATER] fluid block id
 * @param {number} [rim=0] optional rim block id, `0` leaves the terrain alone
 * @returns {boolean} always `true`
 */
export function placeLakePocket(setBlock, rng, x, y, z, fluid = B.WATER, rim = 0) {
  const rx = 2.5 + rng() * 3.5;
  const rz = 2.5 + rng() * 3.5;
  const depth = randInt(rng, 2, 4);
  const ix = Math.ceil(rx) + 1;
  const iz = Math.ceil(rz) + 1;

  for (let dz = -iz; dz <= iz; dz++) {
    for (let dx = -ix; dx <= ix; dx++) {
      const n = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
      if (n > 1.0) continue;
      const localDepth = Math.max(1, Math.round(depth * (1 - n)));
      // Air above the pond so it is not buried.
      for (let k = 1; k <= 3; k++) setBlock(x + dx, y + k, z + dz, AIR);
      for (let k = 0; k < localDepth; k++) setBlock(x + dx, y - k, z + dz, fluid);
      if (rim !== 0) setBlock(x + dx, y - localDepth, z + dz, rim);
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Name -> generator registry. Every entry has the signature
 * `(setBlock, rng, x, y, z, arg)` where `arg` is the extra parameter the
 * specific generator documents (biome id, tree type, seed, block id, ...) and
 * may be omitted for the generators that take none.
 * @type {Object<string, Function>}
 */
export const STRUCTURES = Object.freeze({
  tree: placeTree,
  vegetation: placeVegetation,
  ore_vein: placeOreVein,
  dungeon: placeDungeon,
  ruins: placeRuins,
  mineshaft: placeMineshaft,
  village: placeVillage,
  desert_pyramid: placeDesertPyramid,
  amethyst_geode: placeAmethystGeode,
  stronghold_room: placeStrongholdRoom,
  boulder: placeBoulder,
  desert_well: placeDesertWell,
  giant_mushroom: placeGiantMushroom,
  ice_spike: placeIceSpike,
  fallen_log: placeFallenLog,
  witch_hut: placeWitchHut,
  lake_pocket: placeLakePocket,
});
