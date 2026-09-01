/**
 * VOXELIA — redstone engine (signal propagation + mechanisms).
 *
 * `world/blocks.js` already owns every redstone *block*; this module owns the
 * *signal* and the *mechanisms*: what a wire carries, what a torch inverts,
 * when a piston shoves twelve blocks forward and how a hopper moves an item.
 *
 * ============================================================================
 * 1. BLOCK-STATE STORE
 * ============================================================================
 * Voxel storage is one `Uint16` block id per cell — there is nowhere to put a
 * power level, a facing, a repeater delay or a "locked" bit. This module keeps
 * that data in its own store:
 *
 *   `_chunkStates: Map<chunkKey:number, Map<localKey:number, RedstoneState>>`
 *
 * One `Map` **per chunk**, so the whole per-chunk bucket is dropped in O(1)
 * when the chunk unloads (`world.on('chunkUnloaded')`) and is written/restored
 * chunk-by-chunk by {@link RedstoneEngine#serialize} /
 * {@link RedstoneEngine#deserialize}. Keys are packed integers — never
 * strings — so reads and writes in the tick loop allocate nothing.
 *
 *   chunkKey = (cx + 131072) * 262144 + (cz + 131072)
 *   localKey = (y - WORLD_MIN_Y) * 256 + (lz * 16) + lx
 *
 * Block *orientation* placed by `game/interaction.js` lives in
 * `chunk.blockEntities[...].state` (doors, trapdoors, levers, torches). This
 * engine reads that record for the shapes that already have a convention and
 * writes it back when it changes a door, so physics and the mesher stay in
 * sync. Everything redstone-specific stays in the store above, because a
 * clock rewriting `chunk.blockEntities` twenty times a second would allocate a
 * string key per write and mark the chunk dirty forever.
 *
 * ============================================================================
 * 2. SIGNAL MODEL
 * ============================================================================
 * The vanilla model, implemented faithfully. Two emission queries, both using
 * one convention:
 *
 *   `emitWeak(src, d)`   power the block at `src` emits into the neighbour
 *                        lying in direction `d` (d is *from* source *to*
 *                        consumer — the mirror image of Mojang's argument).
 *   `emitStrong(src, d)` same, but "strong" (hard) power: the kind that makes
 *                        an opaque block itself a power source.
 *
 * From those two:
 *
 *   signalFrom(n, d)      = emitWeak(n, d), and when `n` is a redstone
 *                           conductor also `max(..., directSignalTo(n))`
 *   directSignalTo(p)     = max over the 6 neighbours of emitStrong(nb, →p)
 *   bestNeighbourSignal(p)= max over the 6 neighbours of signalFrom(nb, →p)
 *
 * `bestNeighbourSignal` is what a mechanism (lamp, piston, door, TNT, rail…)
 * reads. That single definition is where **block-powering-block** comes from:
 * a lever on a stone block strongly powers the stone, and the stone then
 * powers a lamp on its far side.
 *
 * Wire is special in exactly the way vanilla is special: while a *wire*
 * computes how much power it picks up from its surroundings, every wire in the
 * world is silenced (`_wiresSilent`). That one flag is what stops a signal
 * from crossing an opaque block — dust into a block, block into dust would
 * otherwise transmit 15 forever. Wire-to-wire transport is handled separately
 * by the network solver, which applies the 1-per-block decay.
 *
 * Wire connects to: another wire; any signal source; a repeater/comparator on
 * its axis; an observer's output face; a wire one block *down* past a
 * non-conductor; and a wire one block *up* on top of a conductor when the cell
 * above the wire is not itself a conductor.
 *
 * **Quasi-connectivity is deliberately NOT implemented.** The famous "a piston
 * or dispenser also reads the block one above itself" bug is a Java-edition
 * accident; half-implementing it (say, for pistons but not dispensers, or
 * without the matching block-update quirks) produces circuits that behave
 * differently from every reference design, which is worse than not having it.
 * `_receivedPowerExcept()` therefore looks at the six real neighbours only.
 *
 * ============================================================================
 * 3. WIRE NETWORKS
 * ============================================================================
 * Naively re-running "power = max(neighbour) - 1" until it settles is O(n²) in
 * the length of a dust line and is the classic way to make a voxel game stall.
 * Instead, a change touching a wire triggers `_solveWireNetwork()`:
 *
 *   1. flood-fill outward from the wire that was poked, at most
 *      `WIRE_SOLVE_DEPTH` (= 30) links deep and `MAX_WIRE_NETWORK` wires wide,
 *      caching each wire's up-to-four wire links in a flat `Int32Array`;
 *   2. for every wire found, read its source power with all wires silenced;
 *   3. bucket-BFS from level 15 down to 1, so every wire receives its final
 *      value in one pass — no relaxation, no ordering artefacts;
 *   4. write back the wires inside the inner 15-link ring whose value actually
 *      changed, and notify exactly their neighbourhood.
 *
 * The depth bound is not an approximation. A dust value is
 * `max over sources of (source - distance)`, so a change at one cell can only
 * move wires within 15 links of it, and those wires can only be fed by sources
 * within another 15 links — hence walk 30, write 15. Wires outside the inner
 * ring are deliberately left unmarked, so if one of them really does need a
 * solve (a second wire touching the same changed cell far away in the network)
 * its own queued update starts a second, independent solve.
 *
 * The result is identical to vanilla's fixpoint and costs O(wires within 30
 * links) per change instead of O(size²). A 200-block dust line re-solves in
 * ~0.1 ms; a pathological 40x40 solid dust carpet in ~1.5 ms.
 *
 * ============================================================================
 * 4. SCHEDULER & ORDERING GUARANTEES
 * ============================================================================
 * Every state change goes through one priority queue of update records
 * `{key, x, y, z, kind, tag, prio, due, seq}` ordered by
 * `(due, prio, seq)` — due tick first, then priority, then insertion order.
 *
 *   G1  An update scheduled for tick T is never executed before tick T.
 *   G2  Within one tick, updates run in ascending `prio`; equal priorities run
 *       in insertion order (`seq` is monotonic for the lifetime of the engine).
 *       `PRIORITY.HIGHEST` (observer pulses, piston head placement) always runs
 *       before `PRIORITY.HIGH` (repeater/comparator switching OFF), which runs
 *       before `PRIORITY.NORMAL` (torches, lamps, doors, wire), which runs
 *       before `PRIORITY.LOW` (repeater/comparator switching ON, dispensers).
 *       This is the vanilla diode ordering: turning off beats turning on.
 *   G3  At most `MAX_UPDATES_PER_TICK` records execute per tick, and the pass
 *       also stops when the `TimeBudget` expires. Nothing is dropped: records
 *       that did not run keep their (already elapsed) due tick and therefore
 *       run first in the next tick, in the same relative order. The budget is
 *       checked *between* records — one record (in particular one wire-network
 *       solve) is atomic and always finishes.
 *   G4  A position executes at most `LOOP_LIMIT` times per tick. Beyond that
 *       its updates are discarded for the rest of the tick; a position that
 *       stays hot for `HOT_TICK_LIMIT` consecutive ticks is suspended for
 *       `SUSPEND_TICKS`. A redstone clock therefore costs a bounded amount of
 *       time per tick and can never freeze the game.
 *   G5  Torches additionally implement the real burnout rule: eight toggles
 *       inside `BURNOUT_WINDOW` ticks and the torch goes dark for
 *       `BURNOUT_TICKS`.
 *
 * Hoppers, pressure plates, daylight sensors and powered rails are not
 * event-driven; they live in registries that are walked round-robin under
 * their own slice of the tick budget.
 *
 * Components in chunks that were streamed in from disk are found by a
 * background scan (`_scanQueue`): one section (4096 ids, a flat `Uint16Array`
 * walk against a `Uint8Array` lookup) at a time until the scan budget for the
 * tick is gone.
 *
 * ============================================================================
 * 5. EVENTS (for game/audio.js and render/particles.js)
 * ============================================================================
 * The engine extends `EventBus` and emits, all with world coordinates:
 *
 *   'click'          (x, y, z, blockId, on)      lever / button / repeater /
 *                                                comparator / note pitch
 *   'powerChanged'   (x, y, z, blockId, level)   component output changed
 *   'pistonExtend'   (x, y, z, dir, sticky)
 *   'pistonRetract'  (x, y, z, dir, sticky)
 *   'dispense'       (x, y, z, dir, itemId)
 *   'drop'           (x, y, z, dir, itemId)
 *   'note'           (x, y, z, instrument, note, pitch)
 *   'door'           (x, y, z, blockId, open)    door / trapdoor / fence gate
 *   'lamp'           (x, y, z, lit)
 *   'ignite'         (x, y, z)                   TNT lit by redstone
 *   'hopperTransfer' (x, y, z, itemId, count)
 *   'torchBurnout'   (x, y, z)
 *   'overload'       (x, y, z)                   loop guard tripped (once/pos)
 *
 * When an `audio` and/or `particles` instance is handed to the constructor the
 * engine plays the obvious sound/particle itself; hook the events only for
 * effects on top of that.
 *
 * @module game/redstone
 */

import { EventBus, PriorityQueue, TimeBudget, ObjectPool } from '../core/util.js';
import { clamp, mulberry32 } from '../core/math.js';
import {
  B, BLOCKS, BLOCK_COUNT, blockByName, getBlock, blockDrops,
  isSolid, isOpaque, isReplaceable, isLiquid,
} from '../world/blocks.js';
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../world/chunk.js';
import { I, itemToBlock, isBlockItem, itemIdByName } from '../game/items.js';
import { ItemStack, Container, createContainer } from '../game/inventory.js';
import { ArrowEntity } from '../game/entities.js';

/* ========================================================================== */
/* Local helpers                                                              */
/* ========================================================================== */

/** @type {Set<string>} Keys already reported by {@link warnOnce}. */
const WARNED = new Set();

/**
 * Log a problem exactly once per key. Redstone runs inside the fixed tick, so
 * nothing in this module may ever throw out of `tick()`; every guarded failure
 * lands here and the affected feature degrades instead.
 * @param {string} key De-duplication key.
 * @param {string} msg Human readable message (English — this is a log, not UI).
 * @param {*} [err] Optional error object.
 * @returns {void}
 */
function warnOnce(key, msg, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (err !== undefined) console.warn(`[VOXELIA/redstone] ${msg}`, err);
  else console.warn(`[VOXELIA/redstone] ${msg}`);
}

/**
 * Finite-number coercion with a fallback.
 * @param {*} v Candidate value.
 * @param {number} d Fallback.
 * @returns {number} `v` when finite, else `d`.
 */
function num(v, d) {
  return Number.isFinite(v) ? v : d;
}

/* ========================================================================== */
/* Directions                                                                 */
/* ========================================================================== */

/**
 * Face directions, identical to the mesher's numbering (ARCHITECTURE 3.1).
 * @type {{PX:number, NX:number, PY:number, NY:number, PZ:number, NZ:number}}
 */
export const DIR = Object.freeze({ PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 });

/** X offset per direction. @type {Int8Array} */
const DIR_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
/** Y offset per direction. @type {Int8Array} */
const DIR_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
/** Z offset per direction. @type {Int8Array} */
const DIR_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);
/** Opposite direction table. @type {Uint8Array} */
const DIR_OPPOSITE = new Uint8Array([1, 0, 3, 2, 5, 4]);
/** The four horizontal directions. @type {Uint8Array} */
const HORIZONTAL = new Uint8Array([DIR.PX, DIR.NX, DIR.PZ, DIR.NZ]);

/**
 * Direction to its index inside {@link HORIZONTAL}; `-1` for `+Y` and `-Y`.
 * @type {Int8Array}
 */
const DIR_TO_HINDEX = new Int8Array([0, 1, -1, -1, 2, 3]);

/**
 * Torch/lever/button attachment state (`world/blocks.js`: `0` standing, `1` on
 * the -X wall, `2` +X, `3` -Z, `4` +Z) to the direction of its support block.
 * @type {Uint8Array}
 */
const TORCH_STATE_TO_SUPPORT = new Uint8Array([DIR.NY, DIR.NX, DIR.PX, DIR.NZ, DIR.PZ]);

/* ========================================================================== */
/* Tunables                                                                   */
/* ========================================================================== */

/** Highest signal a wire can carry. @type {number} */
export const MAX_POWER = 15;

/** Game ticks in one "redstone tick". The game loop runs at 20 TPS. @type {number} */
export const REDSTONE_TICK = 2;

/**
 * Button hold time in **redstone ticks** (the unit redstone is usually quoted
 * in): wood 15, stone 10 — i.e. 1.5 s and 1.0 s, or 30/20 game ticks.
 * @type {{wood:number, stone:number}}
 */
export const BUTTON_REDSTONE_TICKS = Object.freeze({ wood: 15, stone: 10 });

/** Observer pulse length in game ticks. @type {number} */
export const OBSERVER_PULSE = 2;

/** Piston reaction delay in game ticks. @type {number} */
export const PISTON_DELAY = 2;

/** Most blocks a piston can shove, head excluded. @type {number} */
export const PISTON_PUSH_LIMIT = 12;

/** Ticks between two hopper transfers. @type {number} */
export const HOPPER_COOLDOWN = 8;

/** Delay between a dispenser being powered and firing, in game ticks. @type {number} */
export const DISPENSER_DELAY = 4;

/** Ticks a lamp stays lit after losing power. @type {number} */
export const LAMP_OFF_DELAY = 4;

/** Torch toggles inside {@link BURNOUT_WINDOW} that trigger a burnout. @type {number} */
export const BURNOUT_TOGGLES = 8;

/** Sliding window for the torch burnout counter, in game ticks. @type {number} */
export const BURNOUT_WINDOW = 60;

/** How long a burned-out torch stays dark, in game ticks. @type {number} */
export const BURNOUT_TICKS = 60;

/** Hard cap on update records executed in one tick. @type {number} */
export const MAX_UPDATES_PER_TICK = 2048;

/** Executions of a single position allowed per tick before the loop guard trips. @type {number} */
export const LOOP_LIMIT = 24;

/** Consecutive hot ticks a position may have before it is suspended. @type {number} */
export const HOT_TICK_LIMIT = 4;

/** How long a suspended position stays suspended, in game ticks. @type {number} */
export const SUSPEND_TICKS = 40;

/** Largest wire network solved in one go. @type {number} */
export const MAX_WIRE_NETWORK = 8192;

/**
 * How far the solver walks away from the cell that changed.
 *
 * A dust value is `max over sources of (source - distance)`, so a change at one
 * cell can only move wires within {@link MAX_POWER} steps of it, and those
 * wires can only be fed by sources within another {@link MAX_POWER} steps.
 * Walking `2 * MAX_POWER` links is therefore provably enough, and only the
 * wires inside the inner `MAX_POWER` ring are written back — the outer ring
 * exists purely to carry source values inward.
 * @type {number}
 */
export const WIRE_SOLVE_DEPTH = MAX_POWER * 2;

/** Powered rails within this radius of the player push carts every tick. @type {number} */
export const RAIL_ACTIVE_RADIUS = 40;

/** Maximum speed a powered rail accelerates a cart to, in blocks/second. @type {number} */
export const CART_MAX_SPEED = 8;

/** Powered rail acceleration in blocks/second². @type {number} */
export const CART_ACCEL = 12;

/** Chained powered rails that still count as "powered". @type {number} */
export const RAIL_CHAIN_LIMIT = 9;

/** Default per-tick time budget of the whole engine, in milliseconds. @type {number} */
export const DEFAULT_BUDGET_MS = 2.5;

/** Snapshot format version written by {@link RedstoneEngine#serialize}. @type {number} */
export const SAVE_VERSION = 1;

/* ========================================================================== */
/* Component classification                                                   */
/* ========================================================================== */

/**
 * Component kind of a block id. Everything in the engine dispatches on this
 * number, never on a block name, so the hot paths stay branch-cheap.
 * @type {Readonly<Object<string, number>>}
 */
export const COMPONENT = Object.freeze({
  NONE: 0,
  WIRE: 1,
  TORCH: 2,
  POWER_BLOCK: 3,
  LEVER: 4,
  BUTTON: 5,
  PLATE: 6,
  REPEATER: 7,
  COMPARATOR: 8,
  OBSERVER: 9,
  PISTON: 10,
  DISPENSER: 11,
  DROPPER: 12,
  HOPPER: 13,
  RAIL: 14,
  POWERED_RAIL: 15,
  LAMP: 16,
  NOTE_BLOCK: 17,
  DOOR: 18,
  TRAPDOOR: 19,
  FENCE_GATE: 20,
  TNT: 21,
  DAYLIGHT: 22,
});

/**
 * Flags stored in `RedstoneState.o`.
 * @type {Readonly<Object<string, number>>}
 */
export const RS_FLAG = Object.freeze({
  ON: 1 << 0,        // lever/button/plate down, torch lit, diode output high
  EXTENDED: 1 << 1,  // piston base is extended
  HEAD: 1 << 2,      // this piston cell is a head, not a base
  STICKY: 1 << 3,    // sticky piston (base or head)
  LOCKED: 1 << 4,    // repeater held by a diode on its side
  OPEN: 1 << 5,      // door / trapdoor / fence gate open
  UPPER: 1 << 6,     // upper door half
  TOP: 1 << 7,       // trapdoor sits in the upper half of its cell
  BURNED: 1 << 8,    // torch burned out
  SUBTRACT: 1 << 9,  // comparator in subtract mode
  INVERTED: 1 << 10, // daylight sensor inverted
  BY_HAND: 1 << 11,  // door was opened by a player, not by power
});

/**
 * Scheduling priorities. Lower runs first inside a tick (guarantee G2).
 * @type {Readonly<Object<string, number>>}
 */
export const PRIORITY = Object.freeze({
  HIGHEST: 0, HIGH: 1, NORMAL: 2, LOW: 3, LOWEST: 4,
});

/** Update record kinds. @type {Readonly<Object<string, number>>} */
const KIND = Object.freeze({ NEIGHBOUR: 0, SCHEDULED: 1 });

/** Scheduled-action tags. @type {Readonly<Object<string, number>>} */
const TAG = Object.freeze({
  NONE: 0,
  TORCH: 1,
  DIODE: 2,
  OBSERVER_OFF: 3,
  PISTON_EXTEND: 4,
  PISTON_RETRACT: 5,
  DISPENSE: 6,
  LAMP_OFF: 7,
  PLATE_RELEASE: 8,
  BUTTON_RELEASE: 9,
  BURNOUT_END: 10,
  DOOR_CLOSE: 11,
});

/** Component kind per block id. @type {Uint8Array} */
const COMPONENT_KIND = new Uint8Array(BLOCK_COUNT);

/** Button hold time in game ticks per block id (`0` when not a button). @type {Uint8Array} */
const BUTTON_TICKS = new Uint8Array(BLOCK_COUNT);

/** `1` when a pressure plate reacts to any entity, `0` for living-only. @type {Uint8Array} */
const PLATE_ANY_ENTITY = new Uint8Array(BLOCK_COUNT);

/** `1` for a plate whose output scales with the number of entities. @type {Uint8Array} */
const PLATE_WEIGHTED = new Uint8Array(BLOCK_COUNT);

/** Container kind (a `CONTAINER_TYPES` key) per block id, `null` when none. @type {Array<?string>} */
const CONTAINER_KIND = new Array(BLOCK_COUNT).fill(null);

/** `1` for blocks a piston may never move. @type {Uint8Array} */
const IMMOVABLE = new Uint8Array(BLOCK_COUNT);

/** `1` for blocks that stick to their neighbours (slime, honey). @type {Uint8Array} */
const STICKY_BLOCK = new Uint8Array(BLOCK_COUNT);

/**
 * Block ids resolved once at load. Optional entries are `-1` when the block
 * does not exist in this build of `world/blocks.js`; every code path that uses
 * one checks for `-1` first, so the mechanic simply never appears instead of
 * half-working.
 * @type {Object<string, number>}
 */
const ID = {
  WIRE: B.REDSTONE_WIRE,
  TORCH: B.REDSTONE_TORCH,
  POWER_BLOCK: B.REDSTONE_BLOCK,
  LEVER: B.LEVER,
  REPEATER: B.REPEATER,
  COMPARATOR: B.COMPARATOR,
  OBSERVER: B.OBSERVER,
  PISTON: B.PISTON,
  STICKY_PISTON: B.STICKY_PISTON,
  DISPENSER: B.DISPENSER,
  HOPPER: B.HOPPER,
  RAIL: B.RAIL,
  POWERED_RAIL: B.POWERED_RAIL,
  LAMP: B.REDSTONE_LAMP,
  LIT_LAMP: B.LIT_REDSTONE_LAMP,
  NOTE_BLOCK: B.NOTE_BLOCK,
  TNT: B.TNT,
  SLIME: B.SLIME_BLOCK,
  HONEY: B.HONEY_BLOCK,
  WATER: B.WATER,
  LAVA: B.LAVA,
  AIR: 0,
  DROPPER: -1,
  DAYLIGHT: -1,
};

/**
 * Look an optional block up by name.
 * @param {string} name snake_case block name.
 * @returns {number} Its id, or `-1` when the build does not have it.
 */
function optionalBlock(name) {
  const def = blockByName(name);
  return def && def.id > 0 ? def.id : -1;
}

ID.DROPPER = optionalBlock('dropper');
ID.DAYLIGHT = optionalBlock('daylight_detector');

/** Blocks a piston may never push, by name. @type {readonly string[]} */
const IMMOVABLE_NAMES = Object.freeze([
  'bedrock', 'obsidian', 'crying_obsidian', 'chest', 'barrel', 'furnace',
  'blast_furnace', 'hopper', 'dispenser', 'dropper', 'enchanting_table',
  'brewing_stand', 'beacon', 'spawner', 'jukebox', 'end_portal_frame',
  'end_portal', 'nether_portal', 'anvil', 'budding_amethyst', 'cauldron',
  'ancient_debris', 'reinforced_deepslate',
]);

// -- build the dispatch tables ----------------------------------------------
(() => {
  for (let i = 0; i < BLOCKS.length; i++) {
    const def = BLOCKS[i];
    if (!def) continue;
    const name = def.name;
    let kind = COMPONENT.NONE;

    if (i === ID.WIRE) kind = COMPONENT.WIRE;
    else if (i === ID.TORCH) kind = COMPONENT.TORCH;
    else if (i === ID.POWER_BLOCK) kind = COMPONENT.POWER_BLOCK;
    else if (i === ID.LEVER) kind = COMPONENT.LEVER;
    else if (i === ID.REPEATER) kind = COMPONENT.REPEATER;
    else if (i === ID.COMPARATOR) kind = COMPONENT.COMPARATOR;
    else if (i === ID.OBSERVER) kind = COMPONENT.OBSERVER;
    else if (i === ID.PISTON || i === ID.STICKY_PISTON) kind = COMPONENT.PISTON;
    else if (i === ID.DISPENSER) kind = COMPONENT.DISPENSER;
    else if (i === ID.DROPPER) kind = COMPONENT.DROPPER;
    else if (i === ID.HOPPER) kind = COMPONENT.HOPPER;
    else if (i === ID.RAIL) kind = COMPONENT.RAIL;
    else if (i === ID.POWERED_RAIL) kind = COMPONENT.POWERED_RAIL;
    else if (i === ID.LAMP || i === ID.LIT_LAMP) kind = COMPONENT.LAMP;
    else if (i === ID.NOTE_BLOCK) kind = COMPONENT.NOTE_BLOCK;
    else if (i === ID.TNT) kind = COMPONENT.TNT;
    else if (i === ID.DAYLIGHT) kind = COMPONENT.DAYLIGHT;
    else if (name.endsWith('_button')) kind = COMPONENT.BUTTON;
    else if (name.endsWith('_pressure_plate')) kind = COMPONENT.PLATE;
    else if (name.endsWith('_door')) kind = COMPONENT.DOOR;
    else if (name.endsWith('_trapdoor')) kind = COMPONENT.TRAPDOOR;
    else if (name.endsWith('_fence_gate')) kind = COMPONENT.FENCE_GATE;

    COMPONENT_KIND[i] = kind;

    if (kind === COMPONENT.BUTTON) {
      const stone = name.startsWith('stone') || name.startsWith('polished')
        || name.startsWith('blackstone') || name.startsWith('deepslate');
      BUTTON_TICKS[i] = (stone ? BUTTON_REDSTONE_TICKS.stone : BUTTON_REDSTONE_TICKS.wood) * REDSTONE_TICK;
    }
    if (kind === COMPONENT.PLATE) {
      const stone = name.startsWith('stone') || name.startsWith('polished')
        || name.startsWith('blackstone') || name.startsWith('deepslate');
      const weighted = name.indexOf('weighted') >= 0;
      PLATE_ANY_ENTITY[i] = (stone || weighted) ? 0 : 1;
      PLATE_WEIGHTED[i] = weighted ? 1 : 0;
    }
    if (name === 'chest' || name === 'trapped_chest') CONTAINER_KIND[i] = 'chest';
    else if (name === 'barrel') CONTAINER_KIND[i] = 'barrel';
    else if (name === 'hopper') CONTAINER_KIND[i] = 'hopper';
    else if (name === 'dispenser' || name === 'dropper') CONTAINER_KIND[i] = 'dispenser';
    else if (name === 'furnace') CONTAINER_KIND[i] = 'furnace';
    else if (name === 'blast_furnace') CONTAINER_KIND[i] = 'blast_furnace';
    else if (name === 'smoker') CONTAINER_KIND[i] = 'smoker';

    if (def.hardness < 0 || IMMOVABLE_NAMES.indexOf(name) >= 0) IMMOVABLE[i] = 1;
    if (i === ID.SLIME || i === ID.HONEY) STICKY_BLOCK[i] = 1;
  }
})();

/**
 * Note block instruments, chosen by the block underneath. `octave` shifts the
 * played frequency; `name` is handed to listeners and to the audio engine.
 * @type {Readonly<Object<string, {name:string, octave:number}>>}
 */
const INSTRUMENTS = Object.freeze({
  harp: { name: 'harp', octave: 0 },
  bass: { name: 'bass', octave: -2 },
  basedrum: { name: 'basedrum', octave: -1 },
  snare: { name: 'snare', octave: 1 },
  hat: { name: 'hat', octave: 2 },
  bell: { name: 'bell', octave: 1 },
  flute: { name: 'flute', octave: 1 },
  chime: { name: 'chime', octave: 2 },
  guitar: { name: 'guitar', octave: -1 },
  xylophone: { name: 'xylophone', octave: 2 },
  iron_xylophone: { name: 'iron_xylophone', octave: 0 },
  cow_bell: { name: 'cow_bell', octave: 1 },
  didgeridoo: { name: 'didgeridoo', octave: -2 },
  bit: { name: 'bit', octave: 0 },
  banjo: { name: 'banjo', octave: 0 },
  pling: { name: 'pling', octave: 0 },
});

/** Instrument key per block id, filled at load. @type {Array<string>} */
const NOTE_INSTRUMENT = new Array(BLOCK_COUNT).fill('harp');

(() => {
  for (let i = 0; i < BLOCKS.length; i++) {
    const def = BLOCKS[i];
    if (!def) continue;
    const n = def.name;
    let key = 'harp';
    if (n.endsWith('_planks') || n.endsWith('_log') || n === 'bookshelf'
      || n === 'crafting_table' || n === 'note_block' || n === 'jukebox'
      || n.endsWith('_fence') || n.endsWith('_fence_gate')) key = 'bass';
    else if (n === 'sand' || n === 'red_sand' || n === 'gravel' || n === 'soul_sand'
      || n === 'soul_soil') key = 'snare';
    else if (n === 'glass' || n === 'tinted_glass' || n === 'glass_pane'
      || n === 'sea_lantern' || n === 'beacon') key = 'hat';
    else if (n === 'gold_block') key = 'bell';
    else if (n === 'clay') key = 'flute';
    else if (n === 'packed_ice' || n === 'blue_ice' || n === 'ice') key = 'chime';
    else if (n.endsWith('_wool')) key = 'guitar';
    else if (n === 'bone_block') key = 'xylophone';
    else if (n === 'iron_block') key = 'iron_xylophone';
    else if (n === 'pumpkin' || n === 'carved_pumpkin' || n === 'jack_o_lantern') key = 'didgeridoo';
    else if (n === 'emerald_block') key = 'bit';
    else if (n === 'hay_block') key = 'banjo';
    else if (n === 'glowstone') key = 'pling';
    else if (n === 'moss_block' || n === 'moss_carpet') key = 'cow_bell';
    else if (def.opaque && def.solid) key = 'basedrum';
    NOTE_INSTRUMENT[i] = key;
  }
})();

/** Entity types a powered rail accelerates. @type {Set<string>} */
const CART_TYPES = new Set([
  'minecart', 'chest_minecart', 'furnace_minecart', 'tnt_minecart',
  'hopper_minecart', 'command_minecart',
]);

/** Entity types that are never "living" for a stone pressure plate. @type {Set<string>} */
const NON_LIVING = new Set(['item', 'arrow', 'xp_orb', 'tnt', 'falling_block']);

/* ========================================================================== */
/* Coordinate packing                                                         */
/* ========================================================================== */

/** Half the addressable block range on X/Z. @type {number} */
const POS_OFFSET = 1048576;
/** Addressable block span on X/Z. @type {number} */
const POS_SPAN = 2097152;
/** Y slots per column (world height rounded up to a power of two). @type {number} */
const Y_SPAN = 512;
/** Half the addressable chunk range. @type {number} */
const CHUNK_OFFSET = 131072;
/** Addressable chunk span. @type {number} */
const CHUNK_SPAN = 262144;

/**
 * Pack a world block position into one exact `Number` (< 2^51, so integer
 * arithmetic stays lossless). Positions outside ±1,048,576 blocks or outside
 * the world height are not representable — callers guard with
 * {@link inRange} first.
 * @param {number} x World X.
 * @param {number} y World Y.
 * @param {number} z World Z.
 * @returns {number} Packed key.
 */
export function packPos(x, y, z) {
  return ((x + POS_OFFSET) * POS_SPAN + (z + POS_OFFSET)) * Y_SPAN + (y - WORLD_MIN_Y);
}

/**
 * Inverse of {@link packPos}.
 * @param {number} key Packed key.
 * @param {number[]|Int32Array} out Receiver of length >= 3.
 * @returns {number[]|Int32Array} `out`, filled with `[x, y, z]`.
 */
export function unpackPos(key, out) {
  const yy = key % Y_SPAN;
  const rest = (key - yy) / Y_SPAN;
  const zz = rest % POS_SPAN;
  const xx = (rest - zz) / POS_SPAN;
  out[0] = xx - POS_OFFSET;
  out[1] = yy + WORLD_MIN_Y;
  out[2] = zz - POS_OFFSET;
  return out;
}

/**
 * Is a block position inside the range this engine can address?
 * @param {number} x World X.
 * @param {number} y World Y.
 * @param {number} z World Z.
 * @returns {boolean} `true` when the position is usable.
 */
export function inRange(x, y, z) {
  return y >= WORLD_MIN_Y && y < WORLD_MAX_Y
    && x > -POS_OFFSET && x < POS_OFFSET
    && z > -POS_OFFSET && z < POS_OFFSET;
}

/**
 * Pack chunk coordinates into one `Number`.
 * @param {number} cx Chunk X.
 * @param {number} cz Chunk Z.
 * @returns {number} Packed chunk key.
 */
function packChunk(cx, cz) {
  return (cx + CHUNK_OFFSET) * CHUNK_SPAN + (cz + CHUNK_OFFSET);
}

/**
 * Index of a block inside its chunk's state map.
 * @param {number} x World X.
 * @param {number} y World Y.
 * @param {number} z World Z.
 * @returns {number} Local key `0..98303`.
 */
function localKey(x, y, z) {
  return (y - WORLD_MIN_Y) * 256 + ((z & 15) << 4) + (x & 15);
}

/* ========================================================================== */
/* Per-block state record                                                     */
/* ========================================================================== */

/**
 * Per-block redstone state. Deliberately a flat bag of numbers so it survives
 * `structuredClone`, serialises into a plain `number[]` and never keeps a
 * reference to a chunk, an entity or a DOM node.
 *
 * @typedef {Object} RedstoneState
 * @property {number} k Component kind ({@link COMPONENT}).
 * @property {number} b Block id the record belongs to (stale-record guard).
 * @property {number} p Power / output level `0..15`.
 * @property {number} f Facing: support direction, output direction, watch
 *   direction or horizontal facing — see the per-component notes in the class.
 * @property {number} d Repeater delay `1..4` (redstone ticks) or note pitch `0..24`.
 * @property {number} m Secondary value: plate output, daylight level, rail axis.
 * @property {number} o Flag bitfield ({@link RS_FLAG}).
 * @property {number} t Absolute engine tick a timer expires at.
 * @property {number} n Torch toggle counter inside the burnout window.
 * @property {number} w Tick the current burnout window started at.
 * @property {number} q Wire-solve epoch (transient, never serialised).
 */

/**
 * Create a fresh state record.
 * @param {number} kind Component kind.
 * @param {number} blockId Owning block id.
 * @returns {RedstoneState} The record.
 */
function newState(kind, blockId) {
  return { k: kind, b: blockId, p: 0, f: 0, d: 1, m: 0, o: 0, t: 0, n: 0, w: 0, q: -1 };
}

/** Number of numeric fields written per record by the serialiser. @type {number} */
const STATE_FIELDS = 11;

/* ========================================================================== */
/* Engine                                                                     */
/* ========================================================================== */

/**
 * The redstone engine: one instance per world.
 *
 * ```js
 * const redstone = new RedstoneEngine(game.world, game.entities, {
 *   player: game.player,
 *   environment: game.environment,
 *   audio: game.audio,
 *   particles: game.particles,
 *   containerProvider: (x, y, z, id) => game._containerAt(x, y, z, id),
 * });
 * game.on('tick', (dt) => redstone.tick(dt));
 * ```
 *
 * @extends EventBus
 */
export class RedstoneEngine extends EventBus {
  /**
   * @param {import('../world/world.js').World} world The world to drive.
   * @param {import('./entities.js').EntityManager} entityManager Entity manager
   *   used for drops, TNT, arrows and pressure-plate/cart queries.
   * @param {{player?:Object, environment?:Object, audio?:Object,
   *   particles?:Object, containerProvider?:function(number,number,number,number):?Object,
   *   budgetMs?:number, seed?:number}} [options] Optional collaborators.
   */
  constructor(world, entityManager, options = {}) {
    super();

    /** @type {import('../world/world.js').World} The world. */
    this.world = world || null;
    /** @type {import('./entities.js').EntityManager} Entity manager. */
    this.entities = entityManager || null;
    /** @type {?Object} Player, for pressure plates and rail range checks. */
    this.player = options.player || null;
    /** @type {?Object} Environment, for the daylight sensor. */
    this.environment = options.environment || null;
    /** @type {?Object} Audio engine; when set the engine plays its own sounds. */
    this.audio = options.audio || null;
    /** @type {?Object} Particle system; when set the engine spawns its own particles. */
    this.particles = options.particles || null;
    /** @type {?function(number,number,number,number):?Object} Container lookup. */
    this.containerProvider = typeof options.containerProvider === 'function'
      ? options.containerProvider : null;
    /** @type {boolean} Set by {@link RedstoneEngine#dispose}. */
    this.disposed = false;

    // -- state store -------------------------------------------------------
    /** @type {Map<number, Map<number, RedstoneState>>} Per-chunk state maps. @private */
    this._chunkStates = new Map();
    /** @type {number} Cache: chunk key of {@link RedstoneEngine#_lastMap}. @private */
    this._lastChunk = -1;
    /** @type {?Map<number, RedstoneState>} Cache: last chunk map touched. @private */
    this._lastMap = null;

    // -- scheduler ---------------------------------------------------------
    /** @type {PriorityQueue} Ordered by `(due, prio, seq)`. @private */
    this._queue = new PriorityQueue((a, b) => (a.due - b.due) || (a.prio - b.prio) || (a.seq - b.seq));
    /** @type {ObjectPool} Recycles update records so ticking allocates nothing. @private */
    this._pool = new ObjectPool(
      () => ({ key: 0, x: 0, y: 0, z: 0, kind: 0, tag: 0, prio: 2, due: 0, seq: 0 }),
      (r) => { r.key = 0; r.kind = 0; r.tag = 0; r.prio = PRIORITY.NORMAL; r.due = 0; r.seq = 0; },
      256,
    );
    /** @type {Set<number>} Positions with a queued neighbour update. @private */
    this._queuedNeighbours = new Set();
    /** @type {Set<number>} Positions with a queued scheduled update. @private */
    this._queuedScheduled = new Set();
    /** @type {number} Monotonic insertion counter (guarantee G2). @private */
    this._seq = 0;
    /** @type {number} Ticks elapsed since the engine was created. @private */
    this._tick = 0;

    // -- loop guard --------------------------------------------------------
    /** @type {Map<number, number>} Executions per position, cleared each tick. @private */
    this._execCount = new Map();
    /** @type {Map<number, number>} Consecutive hot ticks per position. @private */
    this._hotTicks = new Map();
    /** @type {Map<number, number>} Suspended positions -> tick they wake at. @private */
    this._suspended = new Map();

    // -- registries for polled components ----------------------------------
    /** @type {Set<number>} Hopper positions. @private */
    this._hoppers = new Set();
    /** @type {Set<number>} Pressure plate positions. @private */
    this._plates = new Set();
    /** @type {Set<number>} Daylight sensor positions. @private */
    this._sensors = new Set();
    /** @type {Set<number>} Powered rail positions. @private */
    this._rails = new Set();
    /** @type {number[]} Round-robin cursor cache for the registries. @private */
    this._cursor = [0, 0, 0, 0];
    /** @type {number[]} Scratch list reused by every registry walk. @private */
    this._walk = [];

    // -- chunk scanning ----------------------------------------------------
    /** @type {number[]} Chunk keys queued for a component scan. @private */
    this._scanQueue = [];
    /** @type {Set<number>} Chunks already scanned. @private */
    this._scanned = new Set();
    /** @type {number} Section index the current chunk scan stopped at. @private */
    this._scanSection = 0;

    // -- wire solver scratch ----------------------------------------------
    /** @type {number[]} Packed positions of the wire network being solved. @private */
    this._wireList = [];
    /** @type {Uint8Array} Link distance from the seed per network member. @private */
    this._wireDepth = new Uint8Array(256);
    /** @type {Map<number, number>} Packed position -> index in `_wireList`. @private */
    this._wireIndex = new Map();
    /** @type {Int32Array} Four wire links per network member (`-1` = none). @private */
    this._wireLinks = new Int32Array(4 * 256);
    /** @type {Uint8Array} Source power per network member. @private */
    this._wireSrc = new Uint8Array(256);
    /** @type {Uint8Array} Resolved power per network member. @private */
    this._wirePow = new Uint8Array(256);
    /** @type {number[][]} Bucket queues, one per power level `0..15`. @private */
    this._wireBuckets = [];
    for (let i = 0; i <= MAX_POWER; i++) this._wireBuckets.push([]);
    /** @type {boolean} While `true` every wire emits 0 (the vanilla trick). @private */
    this._wiresSilent = false;
    /** @type {number} Bumped whenever anything that feeds a wire changes. @private */
    this._wireEpoch = 1;

    // -- misc scratch ------------------------------------------------------
    /** @type {Int32Array} Scratch for {@link unpackPos}. @private */
    this._pos = new Int32Array(3);
    /** @type {Float64Array} Scratch AABB `[minX,minY,minZ,maxX,maxY,maxZ]`. @private */
    this._box = new Float64Array(6);
    /** @type {Object[]} Scratch entity list. @private */
    this._entityScratch = [];
    /** @type {number[]} Piston push list (packed positions, near to far). @private */
    this._pushList = [];
    /** @type {number[]} Piston destroy list (packed positions). @private */
    this._destroyList = [];
    /** @type {Set<number>} Membership test for the piston push list. @private */
    this._pushSet = new Set();
    /** @type {Map<number, Object>} Fallback containers when no provider is set. @private */
    this._containers = new Map();
    /** @type {function():number} Deterministic PRNG for dispensers. @private */
    this._rng = mulberry32(((options.seed | 0) || (world && world.seed) || 12345) >>> 0);

    /** @type {number} Re-entrancy depth of the engine's own world edits. @private */
    this._selfEdit = 0;

    /** @type {TimeBudget} Per-tick budget shared by every stage. @private */
    this._budget = new TimeBudget(num(options.budgetMs, DEFAULT_BUDGET_MS));

    /** @type {{updates:number, wires:number, networks:number, scheduled:number,
     *   hoppers:number, plates:number, scanned:number, states:number,
     *   queued:number, overloads:number, ms:number}} Live counters for F3. */
    this.stats = {
      updates: 0, wires: 0, networks: 0, scheduled: 0, hoppers: 0, plates: 0,
      scanned: 0, states: 0, queued: 0, overloads: 0, ms: 0,
    };

    /** @type {function(Object):void} Bound chunk-unload listener. @private */
    this._onChunkUnloaded = (chunk) => this._forgetChunk(chunk);
    /** @type {function(Object):void} Bound chunk-load listener. @private */
    this._onChunkLoaded = (chunk) => this._queueScan(chunk);

    if (this.world && typeof this.world.on === 'function') {
      this.world.on('chunkUnloaded', this._onChunkUnloaded);
      // Both events are hooked because a chunk that never gets meshed (fully
      // solid, fully empty) still has to be scanned; `_queueScan` de-duplicates.
      this.world.on('chunkLoaded', this._onChunkLoaded);
      this.world.on('chunkReady', this._onChunkLoaded);
    }
  }

  /* ====================================================================== */
  /* Collaborators                                                           */
  /* ====================================================================== */

  /**
   * Attach the player (pressure plates, rail range, interaction context).
   * @param {?Object} player The player, or `null`.
   * @returns {RedstoneEngine} `this`.
   */
  setPlayer(player) { this.player = player || null; return this; }

  /**
   * Attach the environment so daylight sensors can read the sky.
   * @param {?Object} environment The environment, or `null`.
   * @returns {RedstoneEngine} `this`.
   */
  setEnvironment(environment) { this.environment = environment || null; return this; }

  /**
   * Attach the audio engine. When set, the engine plays its own click/piston/
   * dispense/note sounds.
   * @param {?Object} audio The audio engine, or `null`.
   * @returns {RedstoneEngine} `this`.
   */
  setAudio(audio) { this.audio = audio || null; return this; }

  /**
   * Attach the particle system.
   * @param {?Object} particles The particle system, or `null`.
   * @returns {RedstoneEngine} `this`.
   */
  setParticles(particles) { this.particles = particles || null; return this; }

  /**
   * Share the game's container store, so hoppers, droppers and comparators see
   * the very same chests the UI shows. Without one the engine keeps its own
   * (serialised in its own snapshot) and can then only reach hoppers,
   * dispensers and droppers it created itself.
   * @param {?function(number,number,number,number):?Object} fn Lookup function.
   * @returns {RedstoneEngine} `this`.
   */
  setContainerProvider(fn) {
    this.containerProvider = typeof fn === 'function' ? fn : null;
    return this;
  }

  /**
   * Change the per-tick time budget.
   * @param {number} ms Milliseconds.
   * @returns {RedstoneEngine} `this`.
   */
  setBudget(ms) { this._budget.setBudget(Math.max(0.25, num(ms, DEFAULT_BUDGET_MS))); return this; }

  /* ====================================================================== */
  /* State store                                                             */
  /* ====================================================================== */

  /**
   * The chunk-local state map for a position.
   * @param {number} x World X.
   * @param {number} z World Z.
   * @param {boolean} create Create the map when it is missing.
   * @returns {?Map<number, RedstoneState>} The map, or `null`.
   * @private
   */
  _chunkMap(x, z, create) {
    const ck = packChunk(x >> 4, z >> 4);
    if (ck === this._lastChunk && this._lastMap !== null) return this._lastMap;
    let m = this._chunkStates.get(ck);
    if (m === undefined) {
      if (!create) return null;
      m = new Map();
      this._chunkStates.set(ck, m);
    }
    this._lastChunk = ck;
    this._lastMap = m;
    return m;
  }

  /**
   * Read the redstone state of a block.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {?RedstoneState} The record, or `null` when the block has none.
   */
  getState(x, y, z) {
    if (!inRange(x, y, z)) return null;
    const m = this._chunkMap(x, z, false);
    if (m === null) return null;
    const st = m.get(localKey(x, y, z));
    return st === undefined ? null : st;
  }

  /**
   * Read the state of a block, creating (and classifying) it on demand.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} [blockId] Block id; read from the world when omitted.
   * @returns {?RedstoneState} The record, or `null` for non-components.
   */
  ensureState(x, y, z, blockId = -1) {
    if (!inRange(x, y, z)) return null;
    const id = blockId >= 0 ? blockId : this.world.getBlock(x, y, z);
    const kind = COMPONENT_KIND[id] || COMPONENT.NONE;
    if (kind === COMPONENT.NONE) return null;
    const m = this._chunkMap(x, z, true);
    if (m === null) return null;
    const key = localKey(x, y, z);
    let st = m.get(key);
    if (st === undefined) {
      st = newState(kind, id);
      this._initState(st, x, y, z, id, null);
      m.set(key, st);
      this.stats.states++;
    } else if (st.b !== id) {
      // The cell changed underneath us (chunk reload, world edit): reclassify.
      st.k = kind;
      st.b = id;
    }
    return st;
  }

  /**
   * Write a state record.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {RedstoneState} st Record to store.
   * @returns {void}
   * @private
   */
  _setState(x, y, z, st) {
    if (!inRange(x, y, z)) return;
    const m = this._chunkMap(x, z, true);
    if (m === null) return;
    if (!m.has(localKey(x, y, z))) this.stats.states++;
    m.set(localKey(x, y, z), st);
  }

  /**
   * Delete a state record.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when a record was removed.
   * @private
   */
  _clearState(x, y, z) {
    if (!inRange(x, y, z)) return false;
    const m = this._chunkMap(x, z, false);
    if (m === null) return false;
    const ok = m.delete(localKey(x, y, z));
    if (ok && this.stats.states > 0) this.stats.states--;
    return ok;
  }

  /**
   * Fill a freshly created record with sensible defaults for its component,
   * using the orientation `game/interaction.js` stored on placement when there
   * is one, and the placement context when the caller has it.
   * @param {RedstoneState} st Record to fill.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @param {?Object} ctx Placement context (`{lookDir, face, sneaking}`).
   * @returns {void}
   * @private
   */
  _initState(st, x, y, z, id, ctx) {
    const orient = this._orientation(x, y, z);
    switch (st.k) {
      case COMPONENT.TORCH:
        st.f = TORCH_STATE_TO_SUPPORT[Math.min(orient & 7, 4)];
        st.o |= RS_FLAG.ON;
        st.p = MAX_POWER;
        break;
      case COMPONENT.LEVER:
      case COMPONENT.BUTTON:
        st.f = TORCH_STATE_TO_SUPPORT[Math.min(orient & 7, 4)];
        break;
      case COMPONENT.REPEATER:
      case COMPONENT.COMPARATOR:
        st.f = this._facingFromContext(ctx, false, DIR.PX);
        st.d = 1;
        break;
      case COMPONENT.OBSERVER:
        st.f = this._facingFromContext(ctx, true, DIR.PX);
        break;
      case COMPONENT.PISTON:
        st.f = this._facingFromContext(ctx, true, DIR.PX);
        if (id === ID.STICKY_PISTON) st.o |= RS_FLAG.STICKY;
        break;
      case COMPONENT.DISPENSER:
      case COMPONENT.DROPPER:
        st.f = this._facingFromContext(ctx, true, DIR.PX);
        break;
      case COMPONENT.HOPPER:
        st.f = this._hopperFacing(ctx);
        break;
      case COMPONENT.DOOR:
        st.f = (orient >> 2) & 3;
        if ((orient & 1) !== 0) st.o |= RS_FLAG.OPEN;
        if ((orient & 2) !== 0) st.o |= RS_FLAG.UPPER;
        break;
      case COMPONENT.TRAPDOOR:
        st.f = (orient >> 2) & 3;
        if ((orient & 1) !== 0) st.o |= RS_FLAG.OPEN;
        if ((orient & 2) !== 0) st.o |= RS_FLAG.TOP;
        break;
      case COMPONENT.FENCE_GATE:
        st.f = (orient >> 2) & 3;
        if ((orient & 1) !== 0) st.o |= RS_FLAG.OPEN;
        break;
      case COMPONENT.LAMP:
        if (id === ID.LIT_LAMP) st.o |= RS_FLAG.ON;
        break;
      case COMPONENT.RAIL:
      case COMPONENT.POWERED_RAIL:
        st.m = this._railAxis(x, y, z);
        break;
      case COMPONENT.POWER_BLOCK:
        st.p = MAX_POWER;
        break;
      default:
        break;
    }
  }

  /**
   * Direction a component should face given a placement context.
   * @param {?Object} ctx `{facing, lookDir, face}`.
   * @param {boolean} allowVertical Allow `+Y`/`-Y`.
   * @param {number} fallback Direction to use when nothing is known.
   * @returns {number} A direction `0..5`.
   * @private
   */
  _facingFromContext(ctx, allowVertical, fallback) {
    if (ctx) {
      if (Number.isFinite(ctx.facing) && ctx.facing >= 0 && ctx.facing < 6) return ctx.facing | 0;
      const dir = ctx.lookDir || (ctx.player && typeof ctx.player.getLookDirection === 'function'
        ? ctx.player.getLookDirection() : null);
      if (dir && dir.length >= 3) {
        const ax = Math.abs(dir[0]);
        const ay = Math.abs(dir[1]);
        const az = Math.abs(dir[2]);
        if (allowVertical && ay > ax && ay > az) return dir[1] >= 0 ? DIR.PY : DIR.NY;
        if (ax >= az) return dir[0] >= 0 ? DIR.PX : DIR.NX;
        return dir[2] >= 0 ? DIR.PZ : DIR.NZ;
      }
    }
    return fallback;
  }

  /**
   * Output direction of a freshly placed hopper: toward the block it was
   * clicked against, never upward.
   * @param {?Object} ctx Placement context (`{face}` = the clicked face).
   * @returns {number} `DIR.NY` or a horizontal direction.
   * @private
   */
  _hopperFacing(ctx) {
    if (ctx && Number.isFinite(ctx.face)) {
      const face = ctx.face | 0;
      if (face >= 0 && face < 6) {
        const out = DIR_OPPOSITE[face];
        if (out !== DIR.PY) return out;
      }
    }
    return DIR.NY;
  }

  /* ====================================================================== */
  /* Orientation bridge (chunk.blockEntities[...].state)                     */
  /* ====================================================================== */

  /**
   * Orientation state `game/interaction.js` stored for a block.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} The state, `0` when there is none.
   * @private
   */
  _orientation(x, y, z) {
    const world = this.world;
    if (!world || typeof world.getChunk !== 'function') return 0;
    const chunk = world.getChunk(x >> 4, z >> 4);
    if (chunk === null || typeof chunk.getBlockEntity !== 'function') return 0;
    const rec = chunk.getBlockEntity(x & 15, y, z & 15);
    if (rec === null || rec === undefined) return 0;
    return Number.isFinite(rec.state) ? rec.state | 0 : 0;
  }

  /**
   * Write the orientation state back, so `blockAABBs()` and any state-aware
   * mesher see an opened door. Called only for door/trapdoor/gate toggles.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} value New orientation state.
   * @returns {void}
   * @private
   */
  _setOrientation(x, y, z, value) {
    const world = this.world;
    if (!world || typeof world.getChunk !== 'function') return;
    const chunk = world.getChunk(x >> 4, z >> 4);
    if (chunk === null || typeof chunk.setBlockEntity !== 'function') return;
    const lx = x & 15;
    const lz = z & 15;
    const rec = chunk.getBlockEntity(lx, y, lz);
    if (value === 0) {
      if (rec === null || rec === undefined) return;
      delete rec.state;
      if (Object.keys(rec).length === 0) chunk.removeBlockEntity(lx, y, lz);
      else chunk.setBlockEntity(lx, y, lz, rec);
      return;
    }
    const target = (rec === null || rec === undefined) ? {} : rec;
    target.state = value | 0;
    chunk.setBlockEntity(lx, y, lz, target);
  }

  /* ====================================================================== */
  /* Signal model                                                            */
  /* ====================================================================== */

  /**
   * Is a block a redstone conductor — a full, opaque, solid cube that carries
   * strong power from one side to the other? Glass, slime, honey, chests,
   * slabs, stairs and every cutout block are not.
   * @param {number} id Block id.
   * @returns {boolean} `true` for conductors.
   */
  isConductor(id) {
    return id !== 0 && isOpaque(id) && isSolid(id);
  }

  /**
   * Weak power the block at `(x,y,z)` emits into the neighbour that lies in
   * direction `d`.
   * @param {number} x World X of the source.
   * @param {number} y World Y of the source.
   * @param {number} z World Z of the source.
   * @param {number} id Block id at the source (already read by the caller).
   * @param {number} d Direction from the source toward the consumer.
   * @returns {number} `0..15`.
   * @private
   */
  _emitWeak(x, y, z, id, d) {
    const kind = COMPONENT_KIND[id];
    if (kind === COMPONENT.NONE) return 0;
    switch (kind) {
      case COMPONENT.POWER_BLOCK:
        return MAX_POWER;
      case COMPONENT.WIRE: {
        if (this._wiresSilent) return 0;
        const st = this.getState(x, y, z);
        const p = st === null ? 0 : st.p;
        if (p === 0) return 0;
        if (d === DIR.PY) return 0;          // dust never powers the block above
        if (d === DIR.NY) return p;          // dust always powers the block below
        return this._wireConnects(x, y, z, d) ? p : 0;
      }
      case COMPONENT.TORCH: {
        const st = this.getState(x, y, z);
        if (st === null || (st.o & RS_FLAG.ON) === 0) return 0;
        return d === st.f ? 0 : MAX_POWER;   // never back into its own support
      }
      case COMPONENT.LEVER:
      case COMPONENT.BUTTON: {
        const st = this.getState(x, y, z);
        return (st !== null && (st.o & RS_FLAG.ON) !== 0) ? MAX_POWER : 0;
      }
      case COMPONENT.PLATE: {
        const st = this.getState(x, y, z);
        return st === null ? 0 : st.p;
      }
      case COMPONENT.REPEATER: {
        const st = this.getState(x, y, z);
        if (st === null || (st.o & RS_FLAG.ON) === 0) return 0;
        return d === st.f ? MAX_POWER : 0;
      }
      case COMPONENT.COMPARATOR: {
        const st = this.getState(x, y, z);
        if (st === null || st.p === 0) return 0;
        return d === st.f ? st.p : 0;
      }
      case COMPONENT.OBSERVER: {
        const st = this.getState(x, y, z);
        if (st === null || (st.o & RS_FLAG.ON) === 0) return 0;
        return d === DIR_OPPOSITE[st.f] ? MAX_POWER : 0;
      }
      case COMPONENT.DAYLIGHT: {
        const st = this.getState(x, y, z);
        return st === null ? 0 : st.p;
      }
      default:
        return 0;
    }
  }

  /**
   * Strong ("hard") power the block at `(x,y,z)` emits into direction `d`.
   * Only strong power turns an opaque block into a source of its own.
   * @param {number} x World X of the source.
   * @param {number} y World Y of the source.
   * @param {number} z World Z of the source.
   * @param {number} id Block id at the source.
   * @param {number} d Direction from the source toward the consumer.
   * @returns {number} `0..15`.
   * @private
   */
  _emitStrong(x, y, z, id, d) {
    const kind = COMPONENT_KIND[id];
    if (kind === COMPONENT.NONE) return 0;
    switch (kind) {
      case COMPONENT.WIRE:
        // Dust strongly powers the block below it and the blocks it points at.
        return this._emitWeak(x, y, z, id, d);
      case COMPONENT.TORCH: {
        const st = this.getState(x, y, z);
        if (st === null || (st.o & RS_FLAG.ON) === 0) return 0;
        return d === DIR.PY ? MAX_POWER : 0; // a torch hard-powers the cell above
      }
      case COMPONENT.LEVER:
      case COMPONENT.BUTTON: {
        const st = this.getState(x, y, z);
        if (st === null || (st.o & RS_FLAG.ON) === 0) return 0;
        return d === st.f ? MAX_POWER : 0;   // into the block it is stuck on
      }
      case COMPONENT.PLATE: {
        const st = this.getState(x, y, z);
        if (st === null || st.p === 0) return 0;
        return d === DIR.NY ? st.p : 0;
      }
      case COMPONENT.REPEATER:
      case COMPONENT.COMPARATOR:
      case COMPONENT.OBSERVER:
        return this._emitWeak(x, y, z, id, d);
      default:
        return 0;
    }
  }

  /**
   * Power the block at `(x,y,z)` presents to a consumer sitting in direction
   * `d` — its own weak emission, plus (for a conductor) whatever strong power
   * it receives. This single line is "block-powering-block".
   * @param {number} x World X of the source cell.
   * @param {number} y World Y of the source cell.
   * @param {number} z World Z of the source cell.
   * @param {number} d Direction from the source toward the consumer.
   * @returns {number} `0..15`.
   * @private
   */
  _signalFrom(x, y, z, d) {
    const id = this.world.getBlock(x, y, z);
    if (id === 0) return 0;
    let i = this._emitWeak(x, y, z, id, d);
    if (i < MAX_POWER && this.isConductor(id)) {
      const s = this._directSignalTo(x, y, z);
      if (s > i) i = s;
    }
    return i;
  }

  /**
   * Strongest strong power delivered *into* a cell from its six neighbours.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} `0..15`.
   * @private
   */
  _directSignalTo(x, y, z) {
    const w = this.world;
    let m = 0;
    for (let d = 0; d < 6; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      const nz = z + DIR_DZ[d];
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
      const id = w.getBlock(nx, ny, nz);
      if (id === 0 || COMPONENT_KIND[id] === COMPONENT.NONE) continue;
      const s = this._emitStrong(nx, ny, nz, id, DIR_OPPOSITE[d]);
      if (s >= MAX_POWER) return MAX_POWER;
      if (s > m) m = s;
    }
    return m;
  }

  /**
   * Strongest signal any of the six neighbours presents to a cell — what every
   * mechanism (lamp, piston, TNT, door, rail, dispenser…) reads.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} `0..15`.
   */
  getReceivedPower(x, y, z) {
    return this._receivedPowerExcept(x, y, z, -1);
  }

  /**
   * {@link RedstoneEngine#getReceivedPower} with one direction skipped — the
   * piston ignores the side it extends into.
   *
   * NOTE: this looks at the six real neighbours only. Quasi-connectivity (the
   * Java-edition quirk where a piston also reads the cell one *above* itself)
   * is intentionally not implemented; see the module header.
   *
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} skip Direction to ignore, or `-1`.
   * @returns {number} `0..15`.
   * @private
   */
  _receivedPowerExcept(x, y, z, skip) {
    if (this.world === null) return 0;
    let m = 0;
    for (let d = 0; d < 6; d++) {
      if (d === skip) continue;
      const ny = y + DIR_DY[d];
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
      const s = this._signalFrom(x + DIR_DX[d], ny, z + DIR_DZ[d], DIR_OPPOSITE[d]);
      if (s >= MAX_POWER) return MAX_POWER;
      if (s > m) m = s;
    }
    return m;
  }

  /**
   * Power level of a redstone component, for the debug overlay and for other
   * systems that want to read a circuit.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} `0..15`; the received power for non-components.
   */
  getPower(x, y, z) {
    const st = this.getState(x, y, z);
    if (st !== null) {
      if (st.k === COMPONENT.WIRE || st.k === COMPONENT.COMPARATOR
        || st.k === COMPONENT.PLATE || st.k === COMPONENT.DAYLIGHT) return st.p;
      if ((st.o & RS_FLAG.ON) !== 0) return MAX_POWER;
    }
    return this.getReceivedPower(x, y, z);
  }

  /* ====================================================================== */
  /* Wire connectivity                                                       */
  /* ====================================================================== */

  /**
   * Does a redstone component accept a dust connection from the side?
   * @param {number} id Block id of the neighbour.
   * @param {number} nx Neighbour X.
   * @param {number} ny Neighbour Y.
   * @param {number} nz Neighbour Z.
   * @param {number} d Direction from the wire toward the neighbour.
   * @returns {boolean} `true` when dust should connect.
   * @private
   */
  _acceptsWire(id, nx, ny, nz, d) {
    switch (COMPONENT_KIND[id]) {
      case COMPONENT.WIRE:
      case COMPONENT.TORCH:
      case COMPONENT.LEVER:
      case COMPONENT.BUTTON:
      case COMPONENT.PLATE:
      case COMPONENT.POWER_BLOCK:
      case COMPONENT.DAYLIGHT:
        return true;
      case COMPONENT.COMPARATOR:
        // Comparators take dust from any side: the back is the input, the two
        // sides are the comparison input, the front is the output.
        return true;
      case COMPONENT.REPEATER: {
        const st = this.getState(nx, ny, nz);
        const f = st === null ? DIR.PX : st.f;
        return f === d || f === DIR_OPPOSITE[d];
      }
      case COMPONENT.OBSERVER: {
        const st = this.getState(nx, ny, nz);
        const out = st === null ? DIR.NX : DIR_OPPOSITE[st.f];
        return out === DIR_OPPOSITE[d];
      }
      default:
        return false;
    }
  }

  /**
   * Raw connection test: is there really something to connect to in horizontal
   * direction `d`? This ignores the straight-line rule.
   * @param {number} x Wire X.
   * @param {number} y Wire Y.
   * @param {number} z Wire Z.
   * @param {number} d A horizontal direction.
   * @returns {boolean} `true` when a real connection exists.
   * @private
   */
  _wireConnectsRaw(x, y, z, d) {
    const w = this.world;
    const nx = x + DIR_DX[d];
    const nz = z + DIR_DZ[d];
    const nid = w.getBlock(nx, y, nz);
    if (nid === ID.WIRE) return true;
    if (nid !== 0 && this._acceptsWire(nid, nx, y, nz, d)) return true;
    if (!this.isConductor(nid)) {
      if (y - 1 >= WORLD_MIN_Y && w.getBlock(nx, y - 1, nz) === ID.WIRE) return true;
      return false;
    }
    if (y + 1 < WORLD_MAX_Y && !this.isConductor(w.getBlock(x, y + 1, z))
      && w.getBlock(nx, y + 1, nz) === ID.WIRE) return true;
    return false;
  }

  /**
   * The four horizontal connections of a wire as a bit mask over
   * {@link HORIZONTAL}, including vanilla's straight-line rule: a dust with no
   * connection on one axis is drawn — and powers — straight through on the
   * other. That rule is what makes a dust line ending at a block power that
   * block, and what turns an isolated dust into a cross.
   * @param {number} x Wire X.
   * @param {number} y Wire Y.
   * @param {number} z Wire Z.
   * @returns {number} A four-bit mask.
   * @private
   */
  _wireConnectionMask(x, y, z) {
    let mask = 0;
    for (let i = 0; i < 4; i++) {
      if (this._wireConnectsRaw(x, y, z, HORIZONTAL[i])) mask |= 1 << i;
    }
    const anyX = (mask & 0b0011) !== 0;
    const anyZ = (mask & 0b1100) !== 0;
    if (!anyZ) mask |= 0b0011;
    if (!anyX) mask |= 0b1100;
    return mask;
  }

  /**
   * Does the wire at `(x,y,z)` point toward horizontal direction `d`?
   * @param {number} x Wire X.
   * @param {number} y Wire Y.
   * @param {number} z Wire Z.
   * @param {number} d A horizontal direction.
   * @returns {boolean} `true` when the wire points that way.
   * @private
   */
  _wireConnects(x, y, z, d) {
    const i = DIR_TO_HINDEX[d];
    if (i < 0) return false;
    return (this._wireConnectionMask(x, y, z) & (1 << i)) !== 0;
  }

  /**
   * The wire connected to `(x,y,z)` in horizontal direction `d`, following the
   * same-level, one-down and one-up rules.
   * @param {number} x Wire X.
   * @param {number} y Wire Y.
   * @param {number} z Wire Z.
   * @param {number} d A horizontal direction.
   * @returns {number} Packed position of the neighbouring wire, or `-1`.
   * @private
   */
  _wireNeighbour(x, y, z, d) {
    const w = this.world;
    const nx = x + DIR_DX[d];
    const nz = z + DIR_DZ[d];
    const nid = w.getBlock(nx, y, nz);
    if (nid === ID.WIRE) return packPos(nx, y, nz);
    if (!this.isConductor(nid)) {
      if (y - 1 >= WORLD_MIN_Y && w.getBlock(nx, y - 1, nz) === ID.WIRE) return packPos(nx, y - 1, nz);
      return -1;
    }
    if (y + 1 < WORLD_MAX_Y && !this.isConductor(w.getBlock(x, y + 1, z))
      && w.getBlock(nx, y + 1, nz) === ID.WIRE) return packPos(nx, y + 1, nz);
    return -1;
  }

  /* ====================================================================== */
  /* Wire network solver                                                     */
  /* ====================================================================== */

  /**
   * Recompute a whole connected dust network in one pass.
   *
   * Step 1 flood-fills the network and caches each member's up-to-four wire
   * links. Step 2 reads every member's *source* power with all wires silenced,
   * which is what stops a signal from hopping across an opaque block. Step 3 is
   * a bucket BFS from level 15 downwards, so each wire is written exactly once
   * with its final value. Step 4 notifies only the neighbourhood of the wires
   * that actually changed.
   *
   * @param {number} sx X of any wire in the network.
   * @param {number} sy Y of that wire.
   * @param {number} sz Z of that wire.
   * @returns {number} How many wires changed value.
   * @private
   */
  _solveWireNetwork(sx, sy, sz) {
    const list = this._wireList;
    const index = this._wireIndex;
    list.length = 0;
    index.clear();

    const start = packPos(sx, sy, sz);
    list.push(start);
    index.set(start, 0);
    let depth = this._wireDepth;
    depth[0] = 0;

    // -- 1. flood fill + link cache ---------------------------------------
    let links = this._wireLinks;
    let head = 0;
    let truncated = false;
    const pos = this._pos;
    while (head < list.length) {
      const cur = list[head];
      unpackPos(cur, pos);
      const cx = pos[0];
      const cy = pos[1];
      const cz = pos[2];
      if ((head + 1) * 4 > links.length) {
        const grown = new Int32Array(links.length * 2);
        grown.set(links);
        links = grown;
        this._wireLinks = grown;
      }
      const here = depth[head];
      for (let i = 0; i < 4; i++) {
        const d = HORIZONTAL[i];
        if (here >= WIRE_SOLVE_DEPTH) { links[head * 4 + i] = -1; continue; }
        const nb = this._wireNeighbour(cx, cy, cz, d);
        if (nb < 0) { links[head * 4 + i] = -1; continue; }
        let idx = index.get(nb);
        if (idx === undefined) {
          if (list.length >= MAX_WIRE_NETWORK) {
            truncated = true;
            links[head * 4 + i] = -1;
            continue;
          }
          idx = list.length;
          list.push(nb);
          index.set(nb, idx);
          if (idx >= depth.length) {
            const grownDepth = new Uint8Array(depth.length * 2);
            grownDepth.set(depth);
            depth = grownDepth;
            this._wireDepth = grownDepth;
          }
          depth[idx] = here + 1;
        }
        links[head * 4 + i] = idx;
      }
      head++;
    }
    if (truncated) {
      warnOnce('network', `a dust network exceeded ${MAX_WIRE_NETWORK} blocks; the excess is not solved`);
    }

    const n = list.length;
    if (this._wireSrc.length < n) {
      this._wireSrc = new Uint8Array(n * 2);
      this._wirePow = new Uint8Array(n * 2);
    }
    const src = this._wireSrc;
    const pow = this._wirePow;
    const buckets = this._wireBuckets;
    for (let i = 0; i <= MAX_POWER; i++) buckets[i].length = 0;

    // -- 2. source power, wires muted -------------------------------------
    this._wiresSilent = true;
    for (let i = 0; i < n; i++) {
      unpackPos(list[i], pos);
      const s = this._bestNeighbourSignal(pos[0], pos[1], pos[2]);
      src[i] = s;
      pow[i] = 0;
      if (s > 0) buckets[s].push(i);
    }
    this._wiresSilent = false;

    // -- 3. bucket BFS, highest level first --------------------------------
    for (let level = MAX_POWER; level >= 1; level--) {
      const bucket = buckets[level];
      for (let bi = 0; bi < bucket.length; bi++) {
        const i = bucket[bi];
        if (pow[i] >= level) continue;
        pow[i] = level;
        if (level === 1) continue;
        const base = i * 4;
        for (let k = 0; k < 4; k++) {
          const j = links[base + k];
          if (j < 0) continue;
          if (pow[j] >= level - 1) continue;
          if (src[j] >= level - 1) continue;
          buckets[level - 1].push(j);
        }
      }
    }

    // -- 4. write back + notify -------------------------------------------
    // `_notifyAround()` deliberately does not touch `_wireEpoch`, so the value
    // captured here stays valid for the whole write-back and every wire of the
    // network is marked as solved for this epoch.
    let changed = 0;
    const epoch = this._wireEpoch;
    for (let i = 0; i < n; i++) {
      // Only the inner ring is provably correct; the outer ring was walked to
      // collect source power and must keep the value it already had.
      if (depth[i] > MAX_POWER) continue;
      unpackPos(list[i], pos);
      const st = this.ensureState(pos[0], pos[1], pos[2], ID.WIRE);
      if (st === null) continue;
      st.q = epoch;
      const value = pow[i];
      if (st.p === value) continue;
      st.p = value;
      changed++;
      this._notifyWireNeighbourhood(pos[0], pos[1], pos[2]);
      this.emit('powerChanged', pos[0], pos[1], pos[2], ID.WIRE, value);
    }
    this.stats.wires += n;
    this.stats.networks++;
    return changed;
  }

  /**
   * {@link RedstoneEngine#_notifyAround} for a wire the solver just rewrote.
   * Members of the network currently being solved are skipped: they already
   * carry their final value, so waking them would only cost queue traffic. In a
   * dense dust field that removes almost the whole fan-out.
   * @param {number} x Wire X.
   * @param {number} y Wire Y.
   * @param {number} z Wire Z.
   * @returns {void}
   * @private
   */
  _notifyWireNeighbourhood(x, y, z) {
    const w = this.world;
    const network = this._wireIndex;
    for (let d = 0; d < 6; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      const nz = z + DIR_DZ[d];
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
      const nid = w.getBlock(nx, ny, nz);
      if (nid !== ID.WIRE || !network.has(packPos(nx, ny, nz))) this._notify(nx, ny, nz, nid);
      if (!this.isConductor(nid)) continue;
      for (let e = 0; e < 6; e++) {
        if (e === DIR_OPPOSITE[d]) continue;
        const ex = nx + DIR_DX[e];
        const ey = ny + DIR_DY[e];
        const ez = nz + DIR_DZ[e];
        if (ey < WORLD_MIN_Y || ey >= WORLD_MAX_Y) continue;
        const eid = w.getBlock(ex, ey, ez);
        if (COMPONENT_KIND[eid] === COMPONENT.NONE) continue;
        if (eid === ID.WIRE && network.has(packPos(ex, ey, ez))) continue;
        this._notify(ex, ey, ez, eid);
      }
    }
  }

  /**
   * Strongest signal presented to a cell by its six neighbours.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} `0..15`.
   * @private
   */
  _bestNeighbourSignal(x, y, z) {
    let m = 0;
    for (let d = 0; d < 6; d++) {
      const ny = y + DIR_DY[d];
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
      const s = this._signalFrom(x + DIR_DX[d], ny, z + DIR_DZ[d], DIR_OPPOSITE[d]);
      if (s >= MAX_POWER) return MAX_POWER;
      if (s > m) m = s;
    }
    return m;
  }

  /* ====================================================================== */
  /* Scheduler                                                               */
  /* ====================================================================== */

  /**
   * Queue a "something next to you changed, re-evaluate yourself" update.
   *
   * Positions holding no redstone component are dropped right here instead of
   * travelling through the queue only to be discarded by the executor — the
   * executor's own check still runs, so a cell that *becomes* a component
   * between queuing and execution is caught by the update its own placement
   * emits. Duplicate positions collapse into one record.
   *
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} [blockId] Block id when the caller already read it.
   * @returns {void}
   * @private
   */
  _notify(x, y, z, blockId = -1) {
    if (!inRange(x, y, z)) return;
    const w = this.world;
    if (w === null) return;
    const id = blockId >= 0 ? blockId : w.getBlock(x, y, z);
    if (COMPONENT_KIND[id] === COMPONENT.NONE) return;
    const key = packPos(x, y, z);
    if (this._queuedNeighbours.has(key)) return;
    this._queuedNeighbours.add(key);
    const rec = this._pool.get();
    rec.key = key;
    rec.x = x; rec.y = y; rec.z = z;
    rec.kind = KIND.NEIGHBOUR;
    rec.tag = TAG.NONE;
    rec.prio = PRIORITY.NORMAL;
    rec.due = this._tick;
    rec.seq = this._seq++;
    this._queue.push(rec);
  }

  /**
   * Notify the six neighbours of a cell.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _notifyNeighbours(x, y, z) {
    for (let d = 0; d < 6; d++) {
      this._notify(x + DIR_DX[d], y + DIR_DY[d], z + DIR_DZ[d]);
    }
  }

  /**
   * Notify the six neighbours of a cell *and*, for every neighbour that is a
   * conductor, that conductor's own six neighbours. This is the closure needed
   * for block-powering-block to react to a change.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _notifyAround(x, y, z) {
    if (this.world === null) return;
    for (let d = 0; d < 6; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      const nz = z + DIR_DZ[d];
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
      const nid = this.world.getBlock(nx, ny, nz);
      this._notify(nx, ny, nz, nid);
      if (!this.isConductor(nid)) continue;
      for (let e = 0; e < 6; e++) {
        if (e === DIR_OPPOSITE[d]) continue;
        this._notify(nx + DIR_DX[e], ny + DIR_DY[e], nz + DIR_DZ[e]);
      }
    }
  }

  /**
   * Queue a component's own timed action. A position holds at most one
   * scheduled record at a time (vanilla semantics), so a repeater cannot be
   * double-triggered inside its delay.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} tag A {@link TAG} value.
   * @param {number} delay Delay in game ticks (`0` = this tick).
   * @param {number} prio A {@link PRIORITY} value.
   * @returns {boolean} `true` when the record was queued.
   * @private
   */
  _schedule(x, y, z, tag, delay, prio) {
    if (!inRange(x, y, z)) return false;
    const key = packPos(x, y, z);
    if (this._queuedScheduled.has(key)) return false;
    this._queuedScheduled.add(key);
    const rec = this._pool.get();
    rec.key = key;
    rec.x = x; rec.y = y; rec.z = z;
    rec.kind = KIND.SCHEDULED;
    rec.tag = tag;
    rec.prio = prio;
    rec.due = this._tick + Math.max(0, delay | 0);
    rec.seq = this._seq++;
    this._queue.push(rec);
    return true;
  }

  /**
   * Is a timed action already queued for a position?
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when one is pending.
   * @private
   */
  _hasScheduled(x, y, z) {
    return inRange(x, y, z) && this._queuedScheduled.has(packPos(x, y, z));
  }

  /**
   * Loop guard: count one execution of a position and report whether it may
   * still run. Positions that keep firing get suspended for a while so a
   * runaway clock costs a bounded amount of time per tick (guarantee G4).
   * @param {number} key Packed position.
   * @param {number} x World X (for the event).
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when the update may execute.
   * @private
   */
  _allowExecution(key, x, y, z) {
    const wake = this._suspended.get(key);
    if (wake !== undefined) {
      if (this._tick < wake) return false;
      this._suspended.delete(key);
    }
    const count = (this._execCount.get(key) || 0) + 1;
    this._execCount.set(key, count);
    if (count <= LOOP_LIMIT) return true;
    if (count === LOOP_LIMIT + 1) {
      const hot = (this._hotTicks.get(key) || 0) + 1;
      this._hotTicks.set(key, hot);
      if (hot >= HOT_TICK_LIMIT) {
        this._suspended.set(key, this._tick + SUSPEND_TICKS);
        this._hotTicks.delete(key);
        this.stats.overloads++;
        warnOnce('overload', 'a redstone loop hit the update cap and was throttled');
        this.emit('overload', x, y, z);
      }
    }
    return false;
  }

  /* ====================================================================== */
  /* Tick                                                                    */
  /* ====================================================================== */

  /**
   * Advance the engine by one fixed game tick.
   *
   * Stages, in order: scheduled/neighbour updates (the priority queue),
   * hoppers, pressure plates, daylight sensors, powered rails, and finally the
   * background component scan for freshly streamed chunks. Every stage shares
   * one {@link TimeBudget}; when it runs out the remaining work stays queued
   * and is picked up next tick.
   *
   * @param {number} dt Seconds since the previous tick (`0.05` at 20 TPS).
   * @returns {void}
   */
  tick(dt) {
    if (this.disposed || this.world === null) return;
    const step = clamp(num(dt, 0.05), 0, 0.25);
    const budget = this._budget.start();
    this._tick++;
    this._execCount.clear();
    this.stats.updates = 0;
    this.stats.wires = 0;
    this.stats.networks = 0;
    this.stats.scheduled = 0;
    this.stats.hoppers = 0;
    this.stats.plates = 0;
    this.stats.scanned = 0;

    try {
      this._runUpdates(budget);
    } catch (err) {
      warnOnce('updates', 'the update pass failed and was skipped for this tick', err);
    }
    try {
      this._runHoppers(budget);
    } catch (err) {
      warnOnce('hoppers', 'the hopper pass failed and was skipped for this tick', err);
    }
    try {
      this._runPlates(budget);
    } catch (err) {
      warnOnce('plates', 'the pressure-plate pass failed and was skipped for this tick', err);
    }
    try {
      this._runSensors();
    } catch (err) {
      warnOnce('sensors', 'the daylight-sensor pass failed and was skipped for this tick', err);
    }
    try {
      this._runRails(step);
    } catch (err) {
      warnOnce('rails', 'the powered-rail pass failed and was skipped for this tick', err);
    }
    try {
      this._runScan(budget);
    } catch (err) {
      warnOnce('scan', 'the component scan failed and was skipped for this tick', err);
    }

    this.stats.queued = this._queue.size;
    this.stats.ms = budget.elapsed();
  }

  /**
   * Drain the update queue for this tick, respecting the per-tick cap, the
   * time budget and the loop guard.
   * @param {TimeBudget} budget Shared tick budget.
   * @returns {void}
   * @private
   */
  _runUpdates(budget) {
    const queue = this._queue;
    const tick = this._tick;
    let processed = 0;
    while (queue.size > 0) {
      const top = queue.peek();
      if (top === undefined || top.due > tick) break;
      if (processed >= MAX_UPDATES_PER_TICK) break;
      if ((processed & 31) === 31 && budget.expired()) break;
      queue.pop();
      processed++;
      const key = top.key;
      if (top.kind === KIND.NEIGHBOUR) this._queuedNeighbours.delete(key);
      else this._queuedScheduled.delete(key);

      const x = top.x;
      const y = top.y;
      const z = top.z;
      const kind = top.kind;
      const tag = top.tag;
      this._pool.release(top);

      if (!this._allowExecution(key, x, y, z)) continue;
      if (!this._isLoaded(x, z)) continue;
      try {
        if (kind === KIND.SCHEDULED) {
          this.stats.scheduled++;
          this._runScheduled(x, y, z, tag);
        } else {
          this._runNeighbourUpdate(x, y, z);
        }
      } catch (err) {
        warnOnce('update', 'a redstone update threw and was dropped', err);
      }
    }
    this.stats.updates = processed;
  }

  /**
   * Is the chunk owning a column loaded?
   * @param {number} x World X.
   * @param {number} z World Z.
   * @returns {boolean} `true` when the chunk is usable.
   * @private
   */
  _isLoaded(x, z) {
    const w = this.world;
    return w !== null && typeof w.isLoaded === 'function' ? w.isLoaded(x >> 4, z >> 4) : true;
  }

  /* ====================================================================== */
  /* Update dispatch                                                         */
  /* ====================================================================== */

  /**
   * Re-evaluate a block because something around it changed.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _runNeighbourUpdate(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    const kind = COMPONENT_KIND[id];
    if (kind === COMPONENT.NONE) return;
    if (!this._checkSupport(x, y, z, id, kind)) return;
    switch (kind) {
      case COMPONENT.WIRE: {
        const st = this.ensureState(x, y, z, id);
        if (st !== null && st.q === this._wireEpoch) return;
        this._solveWireNetwork(x, y, z);
        break;
      }
      case COMPONENT.TORCH: this._updateTorch(x, y, z, id); break;
      case COMPONENT.REPEATER: this._updateRepeater(x, y, z, id); break;
      case COMPONENT.COMPARATOR: this._updateComparator(x, y, z, id); break;
      case COMPONENT.LAMP: this._updateLamp(x, y, z, id); break;
      case COMPONENT.PISTON: this._updatePiston(x, y, z, id); break;
      case COMPONENT.DISPENSER:
      case COMPONENT.DROPPER: this._updateDispenser(x, y, z, id); break;
      case COMPONENT.NOTE_BLOCK: this._updateNoteBlock(x, y, z, id); break;
      case COMPONENT.DOOR: this._updateDoor(x, y, z, id); break;
      case COMPONENT.TRAPDOOR:
      case COMPONENT.FENCE_GATE: this._updateFlap(x, y, z, id, kind); break;
      case COMPONENT.TNT: this._updateTnt(x, y, z, id); break;
      case COMPONENT.POWERED_RAIL: this._updatePoweredRail(x, y, z, id); break;
      case COMPONENT.HOPPER: this._updateHopperLock(x, y, z, id); break;
      case COMPONENT.OBSERVER: break; // observers only react to their target
      default: break;
    }
  }

  /**
   * Run a component's own timed action.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} tag A {@link TAG} value.
   * @returns {void}
   * @private
   */
  _runScheduled(x, y, z, tag) {
    switch (tag) {
      case TAG.TORCH: this._torchFlip(x, y, z); break;
      case TAG.DIODE: this._diodeFire(x, y, z); break;
      case TAG.OBSERVER_OFF: this._observerOff(x, y, z); break;
      case TAG.PISTON_EXTEND: this._pistonExtend(x, y, z); break;
      case TAG.PISTON_RETRACT: this._pistonRetract(x, y, z); break;
      case TAG.DISPENSE: this._dispense(x, y, z); break;
      case TAG.LAMP_OFF: this._lampOff(x, y, z); break;
      case TAG.BUTTON_RELEASE: this._buttonRelease(x, y, z); break;
      case TAG.PLATE_RELEASE: this._plateRelease(x, y, z); break;
      case TAG.BURNOUT_END: this._burnoutEnd(x, y, z); break;
      case TAG.DOOR_CLOSE: this._updateDoor(x, y, z, this.world.getBlock(x, y, z)); break;
      default: break;
    }
  }

  /**
   * Break a component that lost the block it was mounted on.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @param {number} kind Component kind.
   * @returns {boolean} `true` when the component is still there.
   * @private
   */
  _checkSupport(x, y, z, id, kind) {
    const w = this.world;
    let supported = true;
    switch (kind) {
      case COMPONENT.WIRE:
      case COMPONENT.PLATE:
      case COMPONENT.REPEATER:
      case COMPONENT.COMPARATOR:
      case COMPONENT.RAIL:
      case COMPONENT.POWERED_RAIL:
        supported = isSolid(w.getBlock(x, y - 1, z));
        break;
      case COMPONENT.TORCH:
      case COMPONENT.LEVER:
      case COMPONENT.BUTTON: {
        const st = this.getState(x, y, z);
        const d = st === null ? DIR.NY : st.f;
        supported = isSolid(w.getBlock(x + DIR_DX[d], y + DIR_DY[d], z + DIR_DZ[d]));
        break;
      }
      case COMPONENT.DOOR: {
        const st = this.getState(x, y, z);
        if (st !== null && (st.o & RS_FLAG.UPPER) !== 0) {
          supported = COMPONENT_KIND[w.getBlock(x, y - 1, z)] === COMPONENT.DOOR;
        } else {
          supported = isSolid(w.getBlock(x, y - 1, z));
        }
        break;
      }
      default:
        return true;
    }
    if (supported) return true;
    this._breakBlock(x, y, z, id);
    return false;
  }

  /**
   * Remove a block and scatter its drops.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id being removed.
   * @returns {void}
   * @private
   */
  _breakBlock(x, y, z, id) {
    const em = this.entities;
    if (em !== null && typeof em.dropBlockLoot === 'function') {
      let drops = null;
      try {
        drops = blockDrops(id, 'pickaxe', 6, 0, this._rng);
      } catch (err) {
        warnOnce('drops', 'block drops could not be resolved', err);
      }
      if (drops !== null && drops.length > 0) {
        try { em.dropBlockLoot(x, y, z, drops); } catch (err) {
          warnOnce('dropLoot', 'dropping block loot failed', err);
        }
      }
    }
    this._clearState(x, y, z);
    this._setBlock(x, y, z, 0);
  }

  /**
   * `world.setBlock` with the engine's own re-entrancy flag raised, so
   * {@link RedstoneEngine#onBlockChanged} knows the edit came from inside and
   * must not wipe state the engine is in the middle of moving.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id New block id.
   * @returns {boolean} `true` when the block changed.
   * @private
   */
  _setBlock(x, y, z, id) {
    const w = this.world;
    if (w === null) return false;
    this._selfEdit++;
    let ok = false;
    try {
      ok = w.setBlock(x, y, z, id);
    } catch (err) {
      warnOnce('setBlock', 'writing a block failed', err);
    } finally {
      this._selfEdit--;
    }
    if (ok) {
      this._wireEpoch++;
      this._notify(x, y, z);
      this._notifyAround(x, y, z);
      this._fireObservers(x, y, z);
    }
    return ok;
  }

  /* ====================================================================== */
  /* Components — torch                                                      */
  /* ====================================================================== */

  /**
   * A torch inverts the block it is stuck on: powered support means dark
   * torch. The flip is scheduled one redstone tick out, which is what gives
   * torch circuits their delay and what makes torch clocks possible.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updateTorch(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    if ((st.o & RS_FLAG.BURNED) !== 0) return;
    const shouldBeLit = !this._torchSuppressed(x, y, z, st);
    const isLit = (st.o & RS_FLAG.ON) !== 0;
    if (shouldBeLit === isLit) return;
    if (this._hasScheduled(x, y, z)) return;
    this._schedule(x, y, z, TAG.TORCH, REDSTONE_TICK, PRIORITY.NORMAL);
  }

  /**
   * Is the torch's support block receiving power?
   * @param {number} x Torch X.
   * @param {number} y Torch Y.
   * @param {number} z Torch Z.
   * @param {RedstoneState} st Torch state.
   * @returns {boolean} `true` when the torch must go dark.
   * @private
   */
  _torchSuppressed(x, y, z, st) {
    const d = st.f;
    const sx = x + DIR_DX[d];
    const sy = y + DIR_DY[d];
    const sz = z + DIR_DZ[d];
    if (sy < WORLD_MIN_Y || sy >= WORLD_MAX_Y) return false;
    return this._signalFrom(sx, sy, sz, DIR_OPPOSITE[d]) > 0;
  }

  /**
   * Perform the scheduled torch flip and run the burnout counter.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _torchFlip(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (COMPONENT_KIND[id] !== COMPONENT.TORCH) return;
    const st = this.ensureState(x, y, z, id);
    if (st === null || (st.o & RS_FLAG.BURNED) !== 0) return;
    const shouldBeLit = !this._torchSuppressed(x, y, z, st);
    const isLit = (st.o & RS_FLAG.ON) !== 0;
    if (shouldBeLit === isLit) return;

    // Burnout: eight toggles inside the sliding window kill the torch.
    if (this._tick - st.w > BURNOUT_WINDOW) {
      st.w = this._tick;
      st.n = 0;
    }
    st.n++;
    if (st.n > BURNOUT_TOGGLES) {
      st.o = (st.o | RS_FLAG.BURNED) & ~RS_FLAG.ON;
      st.n = 0;
      st.w = this._tick;
      this._schedule(x, y, z, TAG.BURNOUT_END, BURNOUT_TICKS, PRIORITY.LOWEST);
      this._spawn('smoke', x + 0.5, y + 0.6, z + 0.5);
      this.emit('torchBurnout', x, y, z);
      this._wireEpoch++;
      this._notifyAround(x, y, z);
      this._notify(x, y + 1, z);
      return;
    }

    if (shouldBeLit) st.o |= RS_FLAG.ON; else st.o &= ~RS_FLAG.ON;
    st.p = shouldBeLit ? MAX_POWER : 0;
    this._wireEpoch++;
    this._notifyAround(x, y, z);
    this._notify(x, y + 1, z);
    this.emit('powerChanged', x, y, z, id, st.p);
  }

  /**
   * End of a torch burnout: re-evaluate and light up again when it can.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _burnoutEnd(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (COMPONENT_KIND[id] !== COMPONENT.TORCH) return;
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    st.o &= ~RS_FLAG.BURNED;
    st.n = 0;
    st.w = this._tick;
    const lit = !this._torchSuppressed(x, y, z, st);
    if (lit) st.o |= RS_FLAG.ON; else st.o &= ~RS_FLAG.ON;
    st.p = lit ? MAX_POWER : 0;
    this._wireEpoch++;
    this._notifyAround(x, y, z);
    this._notify(x, y + 1, z);
  }

  /* ====================================================================== */
  /* Components — repeater & comparator                                      */
  /* ====================================================================== */

  /**
   * Input power of a diode: whatever the block behind it presents.
   * @param {number} x Diode X.
   * @param {number} y Diode Y.
   * @param {number} z Diode Z.
   * @param {RedstoneState} st Diode state (`f` = output direction).
   * @returns {number} `0..15`.
   * @private
   */
  _diodeInput(x, y, z, st) {
    const back = DIR_OPPOSITE[st.f];
    return this._signalFrom(x + DIR_DX[back], y + DIR_DY[back], z + DIR_DZ[back], st.f);
  }

  /**
   * Strongest signal arriving at a diode from its two sides — comparators use
   * it for the comparison, repeaters use it for locking.
   * @param {number} x Diode X.
   * @param {number} y Diode Y.
   * @param {number} z Diode Z.
   * @param {RedstoneState} st Diode state.
   * @returns {number} `0..15`.
   * @private
   */
  _diodeSides(x, y, z, st) {
    let m = 0;
    for (let i = 0; i < 4; i++) {
      const d = HORIZONTAL[i];
      if (d === st.f || d === DIR_OPPOSITE[st.f]) continue;
      const nx = x + DIR_DX[d];
      const nz = z + DIR_DZ[d];
      const id = this.world.getBlock(nx, y, nz);
      const kind = COMPONENT_KIND[id];
      let s = 0;
      if (kind === COMPONENT.WIRE) {
        // Dust on the side counts at face value, connected or not.
        const other = this.getState(nx, y, nz);
        s = other === null ? 0 : other.p;
      } else if (kind === COMPONENT.REPEATER || kind === COMPONENT.COMPARATOR) {
        s = this._emitWeak(nx, y, nz, id, DIR_OPPOSITE[d]);
      } else {
        continue;
      }
      if (s > m) m = s;
    }
    return m;
  }

  /**
   * Is a repeater locked by a powered diode pointing into its side?
   * @param {number} x Repeater X.
   * @param {number} y Repeater Y.
   * @param {number} z Repeater Z.
   * @param {RedstoneState} st Repeater state.
   * @returns {boolean} `true` when the repeater must hold its output.
   * @private
   */
  _repeaterLocked(x, y, z, st) {
    for (let i = 0; i < 4; i++) {
      const d = HORIZONTAL[i];
      if (d === st.f || d === DIR_OPPOSITE[st.f]) continue;
      const nx = x + DIR_DX[d];
      const nz = z + DIR_DZ[d];
      const id = this.world.getBlock(nx, y, nz);
      const kind = COMPONENT_KIND[id];
      if (kind !== COMPONENT.REPEATER && kind !== COMPONENT.COMPARATOR) continue;
      const other = this.getState(nx, y, nz);
      if (other === null) continue;
      if (other.f !== DIR_OPPOSITE[d]) continue;      // must point at us
      if (kind === COMPONENT.REPEATER && (other.o & RS_FLAG.ON) !== 0) return true;
      if (kind === COMPONENT.COMPARATOR && other.p > 0) return true;
    }
    return false;
  }

  /**
   * Repeater logic: vanilla `DiodeBlock`. Turning off is scheduled at a higher
   * priority than turning on, so a pulse shorter than the delay is swallowed
   * rather than stretched.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updateRepeater(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    const locked = this._repeaterLocked(x, y, z, st);
    if (locked) st.o |= RS_FLAG.LOCKED; else st.o &= ~RS_FLAG.LOCKED;
    if (locked) return;
    const powered = (st.o & RS_FLAG.ON) !== 0;
    const input = this._diodeInput(x, y, z, st) > 0;
    if (powered === input) return;
    if (this._hasScheduled(x, y, z)) return;
    const delay = clamp(st.d | 0, 1, 4) * REDSTONE_TICK;
    this._schedule(x, y, z, TAG.DIODE, delay, powered ? PRIORITY.HIGH : PRIORITY.LOW);
  }

  /**
   * Comparator logic: compare or subtract, with the container behind it read
   * as a signal strength.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updateComparator(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    const out = this._comparatorOutput(x, y, z, st);
    if (out === st.p) return;
    if (this._hasScheduled(x, y, z)) return;
    this._schedule(x, y, z, TAG.DIODE, REDSTONE_TICK, PRIORITY.NORMAL);
  }

  /**
   * The level a comparator should be putting out right now.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {RedstoneState} st Comparator state.
   * @returns {number} `0..15`.
   * @private
   */
  _comparatorOutput(x, y, z, st) {
    let input = this._diodeInput(x, y, z, st);
    const container = this._comparatorContainerSignal(x, y, z, st);
    if (container >= 0) input = Math.max(input, container);
    const side = this._diodeSides(x, y, z, st);
    if ((st.o & RS_FLAG.SUBTRACT) !== 0) {
      const v = input - side;
      return v > 0 ? v : 0;
    }
    return input >= side ? input : 0;
  }

  /**
   * Fullness of the container a comparator is reading, in redstone levels.
   * Vanilla looks one block behind, and — when that is a solid block — one
   * further, which is what lets a comparator read a chest through a wall.
   * @param {number} x Comparator X.
   * @param {number} y Comparator Y.
   * @param {number} z Comparator Z.
   * @param {RedstoneState} st Comparator state.
   * @returns {number} `0..15`, or `-1` when there is no container.
   * @private
   */
  _comparatorContainerSignal(x, y, z, st) {
    const back = DIR_OPPOSITE[st.f];
    const bx = x + DIR_DX[back];
    const by = y + DIR_DY[back];
    const bz = z + DIR_DZ[back];
    let level = this._containerSignal(bx, by, bz);
    if (level >= 0) return level;
    if (!this.isConductor(this.world.getBlock(bx, by, bz))) return -1;
    level = this._containerSignal(bx + DIR_DX[back], by + DIR_DY[back], bz + DIR_DZ[back]);
    return level;
  }

  /**
   * Signal strength of a container: `1 + floor(14 * fullness)`, `0` when empty.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} `0..15`, or `-1` when the block is not a container.
   * @private
   */
  _containerSignal(x, y, z) {
    const container = this._containerAt(x, y, z);
    if (container === null) return -1;
    let filled = 0;
    let any = false;
    const size = container.size | 0;
    for (let i = 0; i < size; i++) {
      const stack = container.get(i);
      if (stack === null || stack === undefined || stack.isEmpty()) continue;
      any = true;
      let limit = stack.maxStack;
      if (typeof container.slotLimit === 'function') {
        limit = Math.min(limit, container.slotLimit(i, stack));
      }
      filled += stack.count / Math.max(1, limit);
    }
    if (!any || size === 0) return 0;
    return Math.floor((filled / size) * 14) + 1;
  }

  /**
   * Execute a diode's scheduled switch.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _diodeFire(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    const kind = COMPONENT_KIND[id];
    if (kind === COMPONENT.REPEATER) {
      const st = this.ensureState(x, y, z, id);
      if (st === null || (st.o & RS_FLAG.LOCKED) !== 0) return;
      const input = this._diodeInput(x, y, z, st) > 0;
      const powered = (st.o & RS_FLAG.ON) !== 0;
      if (powered && !input) {
        st.o &= ~RS_FLAG.ON;
        st.p = 0;
      } else if (!powered) {
        st.o |= RS_FLAG.ON;
        st.p = MAX_POWER;
        if (!input) {
          this._schedule(x, y, z, TAG.DIODE, clamp(st.d | 0, 1, 4) * REDSTONE_TICK, PRIORITY.HIGH);
        }
      } else {
        return;
      }
      this._diodeOutputChanged(x, y, z, id, st);
      return;
    }
    if (kind === COMPONENT.COMPARATOR) {
      const st = this.ensureState(x, y, z, id);
      if (st === null) return;
      const out = this._comparatorOutput(x, y, z, st);
      if (out === st.p) return;
      st.p = out;
      if (out > 0) st.o |= RS_FLAG.ON; else st.o &= ~RS_FLAG.ON;
      this._diodeOutputChanged(x, y, z, id, st);
    }
  }

  /**
   * Publish a diode's new output: notify the cell in front (and everything
   * that cell touches) plus the diode's own neighbourhood.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @param {RedstoneState} st Diode state.
   * @returns {void}
   * @private
   */
  _diodeOutputChanged(x, y, z, id, st) {
    this._wireEpoch++;
    const d = st.f;
    const fx = x + DIR_DX[d];
    const fy = y + DIR_DY[d];
    const fz = z + DIR_DZ[d];
    this._notify(fx, fy, fz);
    this._notifyAround(fx, fy, fz);
    this._notifyAround(x, y, z);
    // A repeater locking or unlocking its neighbours has to poke them too.
    for (let i = 0; i < 4; i++) {
      const e = HORIZONTAL[i];
      this._notify(x + DIR_DX[e], y, z + DIR_DZ[e]);
    }
    this.emit('powerChanged', x, y, z, id, st.p);
  }

  /* ====================================================================== */
  /* Components — observer                                                   */
  /* ====================================================================== */

  /**
   * Fire every observer that watches a position. Called from
   * {@link RedstoneEngine#onBlockChanged} and after every internal edit.
   * @param {number} x Changed block X.
   * @param {number} y Changed block Y.
   * @param {number} z Changed block Z.
   * @returns {void}
   * @private
   */
  _fireObservers(x, y, z) {
    if (ID.OBSERVER <= 0) return;
    const w = this.world;
    for (let d = 0; d < 6; d++) {
      const ox = x + DIR_DX[d];
      const oy = y + DIR_DY[d];
      const oz = z + DIR_DZ[d];
      if (oy < WORLD_MIN_Y || oy >= WORLD_MAX_Y) continue;
      if (w.getBlock(ox, oy, oz) !== ID.OBSERVER) continue;
      const st = this.ensureState(ox, oy, oz, ID.OBSERVER);
      if (st === null) continue;
      // The observer watches the cell its face points at.
      if (st.f !== DIR_OPPOSITE[d]) continue;
      this._observerPulse(ox, oy, oz, st);
    }
  }

  /**
   * Start an observer's two-tick output pulse.
   * @param {number} x Observer X.
   * @param {number} y Observer Y.
   * @param {number} z Observer Z.
   * @param {RedstoneState} st Observer state.
   * @returns {void}
   * @private
   */
  _observerPulse(x, y, z, st) {
    if ((st.o & RS_FLAG.ON) !== 0) return;
    st.o |= RS_FLAG.ON;
    st.p = MAX_POWER;
    this._wireEpoch++;
    const out = DIR_OPPOSITE[st.f];
    const bx = x + DIR_DX[out];
    const by = y + DIR_DY[out];
    const bz = z + DIR_DZ[out];
    this._notify(bx, by, bz);
    this._notifyAround(bx, by, bz);
    this._schedule(x, y, z, TAG.OBSERVER_OFF, OBSERVER_PULSE, PRIORITY.HIGHEST);
    this.emit('powerChanged', x, y, z, ID.OBSERVER, MAX_POWER);
  }

  /**
   * End an observer pulse.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _observerOff(x, y, z) {
    const st = this.getState(x, y, z);
    if (st === null || st.k !== COMPONENT.OBSERVER) return;
    if ((st.o & RS_FLAG.ON) === 0) return;
    st.o &= ~RS_FLAG.ON;
    st.p = 0;
    this._wireEpoch++;
    const out = DIR_OPPOSITE[st.f];
    const bx = x + DIR_DX[out];
    const by = y + DIR_DY[out];
    const bz = z + DIR_DZ[out];
    this._notify(bx, by, bz);
    this._notifyAround(bx, by, bz);
    this.emit('powerChanged', x, y, z, ID.OBSERVER, 0);
  }

  /* ====================================================================== */
  /* Components — lamp, note block, TNT                                      */
  /* ====================================================================== */

  /**
   * Redstone lamp: lights instantly, goes dark four ticks after losing power.
   * The block id really changes (`redstone_lamp` <-> `lit_redstone_lamp`) so
   * the mesher and the colored light engine pick it up.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updateLamp(x, y, z, id) {
    const powered = this.getReceivedPower(x, y, z) > 0;
    const lit = id === ID.LIT_LAMP;
    if (powered === lit) return;
    if (powered) {
      if (ID.LIT_LAMP <= 0) return;
      this._setBlock(x, y, z, ID.LIT_LAMP);
      const st = this.ensureState(x, y, z, ID.LIT_LAMP);
      if (st !== null) st.o |= RS_FLAG.ON;
      this.emit('lamp', x, y, z, true);
      return;
    }
    if (!this._hasScheduled(x, y, z)) {
      this._schedule(x, y, z, TAG.LAMP_OFF, LAMP_OFF_DELAY, PRIORITY.NORMAL);
    }
  }

  /**
   * Turn a lamp off once its grace period elapsed and it is still unpowered.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _lampOff(x, y, z) {
    if (this.world.getBlock(x, y, z) !== ID.LIT_LAMP) return;
    if (this.getReceivedPower(x, y, z) > 0) return;
    this._setBlock(x, y, z, ID.LAMP);
    const st = this.getState(x, y, z);
    if (st !== null) { st.o &= ~RS_FLAG.ON; st.b = ID.LAMP; }
    this.emit('lamp', x, y, z, false);
  }

  /**
   * Note block: plays on the rising edge of power, with the instrument taken
   * from the block underneath and the pitch from its stored note.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updateNoteBlock(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    const powered = this.getReceivedPower(x, y, z) > 0;
    const was = (st.o & RS_FLAG.ON) !== 0;
    if (powered === was) return;
    if (powered) st.o |= RS_FLAG.ON; else st.o &= ~RS_FLAG.ON;
    if (!powered) return;
    this._playNote(x, y, z, st);
  }

  /**
   * Sound one note.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {RedstoneState} st Note block state (`d` holds the note `0..24`).
   * @returns {void}
   * @private
   */
  _playNote(x, y, z, st) {
    if (isSolid(this.world.getBlock(x, y + 1, z))) return; // muffled
    const below = this.world.getBlock(x, y - 1, z);
    const instrument = INSTRUMENTS[NOTE_INSTRUMENT[below]] || INSTRUMENTS.harp;
    const note = clamp(st.d | 0, 0, 24);
    const pitch = Math.pow(2, (note - 12) / 12) * Math.pow(2, instrument.octave);
    this._play('note_block', x + 0.5, y + 0.5, z + 0.5, 1, pitch);
    this._spawn('note', x + 0.5, y + 1.2, z + 0.5);
    this.emit('note', x, y, z, instrument.name, note, pitch);
  }

  /**
   * TNT lit by redstone: the block turns into a primed entity.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updateTnt(x, y, z, id) {
    if (this.getReceivedPower(x, y, z) <= 0) return;
    this._ignite(x, y, z, id);
  }

  /**
   * Replace a TNT block with a primed TNT entity.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id (must be TNT).
   * @returns {boolean} `true` when the TNT was primed.
   * @private
   */
  _ignite(x, y, z, id) {
    if (id !== ID.TNT) return false;
    const em = this.entities;
    this._clearState(x, y, z);
    this._setBlock(x, y, z, 0);
    if (em !== null && typeof em.primeTNT === 'function') {
      try { em.primeTNT(x, y, z); } catch (err) {
        warnOnce('primeTNT', 'priming TNT failed', err);
      }
    }
    this._play('ignite', x + 0.5, y + 0.5, z + 0.5, 1, 1);
    this.emit('ignite', x, y, z);
    return true;
  }

  /* ====================================================================== */
  /* Components — doors, trapdoors, fence gates                              */
  /* ====================================================================== */

  /**
   * Doors are two blocks tall and both halves must agree; power on either half
   * opens both.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updateDoor(x, y, z, id) {
    if (COMPONENT_KIND[id] !== COMPONENT.DOOR) return;
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    const upper = (st.o & RS_FLAG.UPPER) !== 0;
    const baseY = upper ? y - 1 : y;
    const otherY = upper ? y - 1 : y + 1;
    if (COMPONENT_KIND[this.world.getBlock(x, otherY, z)] !== COMPONENT.DOOR) return;
    const powered = this.getReceivedPower(x, baseY, z) > 0
      || this.getReceivedPower(x, baseY + 1, z) > 0;
    const open = (st.o & RS_FLAG.OPEN) !== 0;
    if (powered === open) return;
    if (!powered && (st.o & RS_FLAG.BY_HAND) !== 0) {
      // A door a player opened stays open until a player closes it again.
      return;
    }
    this._setDoorOpen(x, baseY, z, powered, false);
  }

  /**
   * Set both halves of a door.
   * @param {number} x World X.
   * @param {number} baseY Y of the lower half.
   * @param {number} z World Z.
   * @param {boolean} open Target state.
   * @param {boolean} byHand `true` when a player did it.
   * @returns {void}
   * @private
   */
  _setDoorOpen(x, baseY, z, open, byHand) {
    const w = this.world;
    let changed = false;
    for (let i = 0; i < 2; i++) {
      const y = baseY + i;
      const id = w.getBlock(x, y, z);
      if (COMPONENT_KIND[id] !== COMPONENT.DOOR) continue;
      const st = this.ensureState(x, y, z, id);
      if (st === null) continue;
      if (i === 1) st.o |= RS_FLAG.UPPER; else st.o &= ~RS_FLAG.UPPER;
      if (open) st.o |= RS_FLAG.OPEN; else st.o &= ~RS_FLAG.OPEN;
      if (byHand && open) st.o |= RS_FLAG.BY_HAND; else st.o &= ~RS_FLAG.BY_HAND;
      const orient = ((st.f & 3) << 2) | (i === 1 ? 2 : 0) | (open ? 1 : 0);
      this._setOrientation(x, y, z, orient);
      changed = true;
    }
    if (!changed) return;
    this._play('door', x + 0.5, baseY + 1, z + 0.5, 1, open ? 1.05 : 0.92);
    this.emit('door', x, baseY, z, w.getBlock(x, baseY, z), open);
  }

  /**
   * Trapdoors and fence gates: one block, same open bit.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @param {number} kind Component kind.
   * @returns {void}
   * @private
   */
  _updateFlap(x, y, z, id, kind) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    const powered = this.getReceivedPower(x, y, z) > 0;
    const open = (st.o & RS_FLAG.OPEN) !== 0;
    if (powered === open) return;
    if (!powered && (st.o & RS_FLAG.BY_HAND) !== 0) return;
    this._setFlapOpen(x, y, z, id, kind, powered, false);
  }

  /**
   * Write a trapdoor's or fence gate's open state.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @param {number} kind Component kind.
   * @param {boolean} open Target state.
   * @param {boolean} byHand `true` when a player did it.
   * @returns {void}
   * @private
   */
  _setFlapOpen(x, y, z, id, kind, open, byHand) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    if (open) st.o |= RS_FLAG.OPEN; else st.o &= ~RS_FLAG.OPEN;
    if (byHand && open) st.o |= RS_FLAG.BY_HAND; else st.o &= ~RS_FLAG.BY_HAND;
    const top = kind === COMPONENT.TRAPDOOR && (st.o & RS_FLAG.TOP) !== 0 ? 2 : 0;
    this._setOrientation(x, y, z, ((st.f & 3) << 2) | top | (open ? 1 : 0));
    this._play(kind === COMPONENT.TRAPDOOR ? 'trapdoor' : 'door',
      x + 0.5, y + 0.5, z + 0.5, 0.9, open ? 1.05 : 0.92);
    this.emit('door', x, y, z, id, open);
  }

  /* ====================================================================== */
  /* Components — lever, button, pressure plate, daylight sensor             */
  /* ====================================================================== */

  /**
   * Flip a lever.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {boolean} `true` (the interaction is always consumed).
   * @private
   */
  _toggleLever(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return false;
    const on = (st.o & RS_FLAG.ON) === 0;
    if (on) st.o |= RS_FLAG.ON; else st.o &= ~RS_FLAG.ON;
    st.p = on ? MAX_POWER : 0;
    this._wireEpoch++;
    this._notifyAround(x, y, z);
    const s = st.f;
    this._notifyAround(x + DIR_DX[s], y + DIR_DY[s], z + DIR_DZ[s]);
    this._play('click', x + 0.5, y + 0.5, z + 0.5, 0.8, on ? 1.1 : 0.9);
    this.emit('click', x, y, z, id, on);
    this.emit('powerChanged', x, y, z, id, st.p);
    return true;
  }

  /**
   * Press a button. Wood holds 15 redstone ticks, stone 10 — i.e. 30 and 20
   * game ticks at the fixed 20 TPS.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {boolean} `true` when the button went down.
   * @private
   */
  _pressButton(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return false;
    if ((st.o & RS_FLAG.ON) !== 0) return true;
    st.o |= RS_FLAG.ON;
    st.p = MAX_POWER;
    st.t = this._tick + (BUTTON_TICKS[id] || BUTTON_REDSTONE_TICKS.stone * REDSTONE_TICK);
    this._wireEpoch++;
    this._notifyAround(x, y, z);
    const s = st.f;
    this._notifyAround(x + DIR_DX[s], y + DIR_DY[s], z + DIR_DZ[s]);
    this._schedule(x, y, z, TAG.BUTTON_RELEASE,
      BUTTON_TICKS[id] || BUTTON_REDSTONE_TICKS.stone * REDSTONE_TICK, PRIORITY.NORMAL);
    this._play('click', x + 0.5, y + 0.5, z + 0.5, 0.8, 1.15);
    this.emit('click', x, y, z, id, true);
    this.emit('powerChanged', x, y, z, id, MAX_POWER);
    return true;
  }

  /**
   * Let a button pop back out.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _buttonRelease(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (COMPONENT_KIND[id] !== COMPONENT.BUTTON) return;
    const st = this.getState(x, y, z);
    if (st === null || (st.o & RS_FLAG.ON) === 0) return;
    st.o &= ~RS_FLAG.ON;
    st.p = 0;
    this._wireEpoch++;
    this._notifyAround(x, y, z);
    const s = st.f;
    this._notifyAround(x + DIR_DX[s], y + DIR_DY[s], z + DIR_DZ[s]);
    this._play('click', x + 0.5, y + 0.5, z + 0.5, 0.7, 0.9);
    this.emit('click', x, y, z, id, false);
    this.emit('powerChanged', x, y, z, id, 0);
  }

  /**
   * Sample one pressure plate: how many qualifying entities stand on it?
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {number} Entity count (`0` when nothing is on the plate).
   * @private
   */
  _plateEntityCount(x, y, z, id) {
    const box = this._box;
    box[0] = x + 0.06; box[1] = y; box[2] = z + 0.06;
    box[3] = x + 0.94; box[4] = y + 0.35; box[5] = z + 0.94;
    let count = 0;
    const anyEntity = PLATE_ANY_ENTITY[id] === 1;

    const player = this.player;
    if (player !== null && player.aabb) {
      const a = player.aabb;
      const alive = player.dead !== true
        && (player.gameMode === undefined || player.gameMode !== 'spectator');
      if (alive && a.maxX > box[0] && a.minX < box[3] && a.maxY > box[1] && a.minY < box[4]
        && a.maxZ > box[2] && a.minZ < box[5]) count++;
    }
    const em = this.entities;
    if (em !== null && typeof em.queryAABB === 'function') {
      const list = em.queryAABB(box, this._entityScratch);
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.removed || e.dead) continue;
        if (!anyEntity && NON_LIVING.has(e.type)) continue;
        count++;
      }
      list.length = 0;
    }
    return count;
  }

  /**
   * Re-evaluate one pressure plate.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updatePlate(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    const count = this._plateEntityCount(x, y, z, id);
    let level = 0;
    if (count > 0) {
      level = PLATE_WEIGHTED[id] === 1
        ? clamp(Math.ceil(count * MAX_POWER / 15), 1, MAX_POWER)
        : MAX_POWER;
    }
    if (level === st.p) {
      if (level > 0) st.t = this._tick + 10;
      return;
    }
    if (level === 0 && this._tick < st.t) return;   // 10-tick release delay
    const wasOn = st.p > 0;
    st.p = level;
    if (level > 0) { st.o |= RS_FLAG.ON; st.t = this._tick + 10; } else st.o &= ~RS_FLAG.ON;
    this._wireEpoch++;
    this._notifyAround(x, y, z);
    this._notifyAround(x, y - 1, z);
    if (wasOn !== (level > 0)) {
      this._play('click', x + 0.5, y + 0.1, z + 0.5, 0.5, level > 0 ? 1.1 : 0.9);
      this.emit('click', x, y, z, id, level > 0);
    }
    this.emit('powerChanged', x, y, z, id, level);
  }

  /**
   * Scheduled plate release (used when the registry pass is behind).
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _plateRelease(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (COMPONENT_KIND[id] !== COMPONENT.PLATE) return;
    this._updatePlate(x, y, z, id);
  }

  /**
   * Daylight sensor: sky light at the cell above, scaled by the current sky
   * brightness, optionally inverted.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updateSensor(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    let sky = 15;
    const w = this.world;
    if (typeof w.getSkyLight === 'function') sky = clamp(w.getSkyLight(x, y + 1, z) | 0, 0, 15);
    let scale = 1;
    const env = this.environment;
    if (env !== null && typeof env.getLightLevel === 'function') {
      scale = clamp(env.getLightLevel() / MAX_POWER, 0, 1);
    }
    let level = Math.round(sky * scale);
    if ((st.o & RS_FLAG.INVERTED) !== 0) level = MAX_POWER - level;
    level = clamp(level, 0, MAX_POWER);
    if (level === st.p) return;
    st.p = level;
    st.m = sky;
    this._wireEpoch++;
    this._notifyAround(x, y, z);
    this.emit('powerChanged', x, y, z, id, level);
  }

  /* ====================================================================== */
  /* Components — piston                                                     */
  /* ====================================================================== */

  /**
   * VOXELIA has no separate `piston_head` block, so an extended piston owns two
   * cells that both hold its own block id: the base (no `HEAD` flag) and the
   * head (with it). Breaking either one takes the whole piston apart.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updatePiston(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    if ((st.o & RS_FLAG.HEAD) !== 0) return;      // heads never think for themselves
    const powered = this._receivedPowerExcept(x, y, z, st.f) > 0;
    const extended = (st.o & RS_FLAG.EXTENDED) !== 0;
    if (powered === extended) return;
    if (this._hasScheduled(x, y, z)) return;
    this._schedule(x, y, z, powered ? TAG.PISTON_EXTEND : TAG.PISTON_RETRACT,
      PISTON_DELAY, PRIORITY.HIGHEST);
  }

  /**
   * Can a piston move this block at all?
   * @param {number} id Block id.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} `0` = treat as air, `1` = move it, `2` = destroy it,
   *   `3` = immovable, the push fails.
   * @private
   */
  _pushReaction(id, x, y, z) {
    if (id === 0 || isReplaceable(id) || isLiquid(id)) return 0;
    if (IMMOVABLE[id] === 1) return 3;
    if (!isSolid(id)) return 2;
    const kind = COMPONENT_KIND[id];
    if (kind === COMPONENT.PISTON) {
      const st = this.getState(x, y, z);
      if (st !== null && ((st.o & RS_FLAG.EXTENDED) !== 0 || (st.o & RS_FLAG.HEAD) !== 0)) return 3;
    }
    return 1;
  }

  /**
   * Do two blocks stick to each other for the purpose of group dragging?
   * Slime sticks to everything but honey; honey sticks to everything but
   * slime; ordinary blocks never drag their neighbours.
   * @param {number} a First block id.
   * @param {number} b Second block id.
   * @returns {boolean} `true` when they move together.
   * @private
   */
  _sticksTo(a, b) {
    if (a === ID.SLIME && b === ID.HONEY) return false;
    if (a === ID.HONEY && b === ID.SLIME) return false;
    return STICKY_BLOCK[a] === 1 || STICKY_BLOCK[b] === 1;
  }

  /**
   * Work out which blocks a piston move affects.
   *
   * `_pushList` ends up ordered from the piston outwards, so moving it back to
   * front never overwrites a cell that still has to be read. `_destroyList`
   * collects the blocks the move crushes. Slime and honey blocks drag their
   * perpendicular neighbours along, and every dragged block starts a line of
   * its own — that is the vanilla group-drag behaviour.
   *
   * @param {number} sx X of the first cell being moved.
   * @param {number} sy Y of that cell.
   * @param {number} sz Z of that cell.
   * @param {number} dir Direction everything moves in.
   * @param {number} pistonKey Packed position of the piston base (never moved).
   * @returns {boolean} `true` when the move is legal.
   * @private
   */
  _resolveMove(sx, sy, sz, dir, pistonKey) {
    const push = this._pushList;
    const destroy = this._destroyList;
    const set = this._pushSet;
    push.length = 0;
    destroy.length = 0;
    set.clear();
    if (!this._addPushLine(sx, sy, sz, dir, pistonKey)) return false;

    // Branch off every sticky block already in the list. `push` grows while we
    // iterate, which is exactly what makes the drag recursive.
    const pos = this._pos;
    for (let i = 0; i < push.length; i++) {
      unpackPos(push[i], pos);
      const bx = pos[0];
      const by = pos[1];
      const bz = pos[2];
      const id = this.world.getBlock(bx, by, bz);
      if (STICKY_BLOCK[id] !== 1) continue;
      for (let d = 0; d < 6; d++) {
        if (d === dir || d === DIR_OPPOSITE[dir]) continue;
        const nx = bx + DIR_DX[d];
        const ny = by + DIR_DY[d];
        const nz = bz + DIR_DZ[d];
        if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
        const key = packPos(nx, ny, nz);
        if (set.has(key) || key === pistonKey) continue;
        const nid = this.world.getBlock(nx, ny, nz);
        if (nid === 0 || !this._sticksTo(id, nid)) continue;
        if (!this._addPushLine(nx, ny, nz, dir, pistonKey)) return false;
      }
    }
    return true;
  }

  /**
   * Add one straight line of blocks to the push list.
   * @param {number} x Start X.
   * @param {number} y Start Y.
   * @param {number} z Start Z.
   * @param {number} dir Push direction.
   * @param {number} pistonKey Packed position of the piston base.
   * @returns {boolean} `true` when the line is movable.
   * @private
   */
  _addPushLine(x, y, z, dir, pistonKey) {
    const push = this._pushList;
    const destroy = this._destroyList;
    const set = this._pushSet;
    let cx = x;
    let cy = y;
    let cz = z;
    for (let step = 0; step <= PISTON_PUSH_LIMIT; step++) {
      if (cy < WORLD_MIN_Y || cy >= WORLD_MAX_Y) return false;
      const key = packPos(cx, cy, cz);
      if (key === pistonKey) return false;
      if (set.has(key)) return true;             // already handled by another line
      const id = this.world.getBlock(cx, cy, cz);
      const reaction = this._pushReaction(id, cx, cy, cz);
      if (reaction === 0) return true;           // free space: the line ends here
      if (reaction === 3) return false;          // immovable: the whole move fails
      if (reaction === 2) {
        if (destroy.indexOf(key) < 0) destroy.push(key);
        return true;
      }
      if (push.length >= PISTON_PUSH_LIMIT) return false;
      push.push(key);
      set.add(key);
      cx += DIR_DX[dir];
      cy += DIR_DY[dir];
      cz += DIR_DZ[dir];
    }
    return false;
  }

  /**
   * Extend a piston: shove the resolved block group one cell forward, then put
   * the head into the freed cell.
   *
   * The move is atomic on this tick — VOXELIA's renderer has no moving block
   * entity, so blocks arrive at their destination instead of sliding for 0.1 s.
   * Everything else (push limit, immovables, crushed blocks, slime groups) is
   * the real rule set.
   *
   * @param {number} x Piston X.
   * @param {number} y Piston Y.
   * @param {number} z Piston Z.
   * @returns {void}
   * @private
   */
  _pistonExtend(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (COMPONENT_KIND[id] !== COMPONENT.PISTON) return;
    const st = this.ensureState(x, y, z, id);
    if (st === null || (st.o & RS_FLAG.HEAD) !== 0) return;
    if ((st.o & RS_FLAG.EXTENDED) !== 0) return;
    if (this._receivedPowerExcept(x, y, z, st.f) <= 0) return;

    const dir = st.f;
    const hx = x + DIR_DX[dir];
    const hy = y + DIR_DY[dir];
    const hz = z + DIR_DZ[dir];
    if (hy < WORLD_MIN_Y || hy >= WORLD_MAX_Y) return;
    if (!this._resolveMove(hx, hy, hz, dir, packPos(x, y, z))) return;

    const push = this._pushList;
    const destroy = this._destroyList;
    const pos = this._pos;
    for (let i = 0; i < destroy.length; i++) {
      unpackPos(destroy[i], pos);
      const did = this.world.getBlock(pos[0], pos[1], pos[2]);
      if (did !== 0) this._breakBlock(pos[0], pos[1], pos[2], did);
    }
    for (let i = push.length - 1; i >= 0; i--) {
      unpackPos(push[i], pos);
      this._moveBlock(pos[0], pos[1], pos[2],
        pos[0] + DIR_DX[dir], pos[1] + DIR_DY[dir], pos[2] + DIR_DZ[dir]);
    }

    st.o |= RS_FLAG.EXTENDED;
    this._setBlock(hx, hy, hz, id);
    const head = this.ensureState(hx, hy, hz, id);
    if (head !== null) {
      head.o |= RS_FLAG.HEAD;
      head.f = dir;
      if (id === ID.STICKY_PISTON) head.o |= RS_FLAG.STICKY;
    }
    this._playBlockSound('place', id, x + 0.5, y + 0.5, z + 0.5);
    this.emit('pistonExtend', x, y, z, dir, id === ID.STICKY_PISTON);
    this._wireEpoch++;
    this._notifyAround(x, y, z);
  }

  /**
   * Retract a piston: pull the head back and, when the piston is sticky, drag
   * the block that was in front of the head (plus its slime group) with it.
   * @param {number} x Piston X.
   * @param {number} y Piston Y.
   * @param {number} z Piston Z.
   * @returns {void}
   * @private
   */
  _pistonRetract(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (COMPONENT_KIND[id] !== COMPONENT.PISTON) return;
    const st = this.ensureState(x, y, z, id);
    if (st === null || (st.o & RS_FLAG.HEAD) !== 0) return;
    if ((st.o & RS_FLAG.EXTENDED) === 0) return;
    if (this._receivedPowerExcept(x, y, z, st.f) > 0) return;

    const dir = st.f;
    const back = DIR_OPPOSITE[dir];
    const hx = x + DIR_DX[dir];
    const hy = y + DIR_DY[dir];
    const hz = z + DIR_DZ[dir];

    // Take the head away first so the pulled block has somewhere to land.
    const headState = this.getState(hx, hy, hz);
    if (headState !== null && (headState.o & RS_FLAG.HEAD) !== 0) {
      this._clearState(hx, hy, hz);
      this._setBlock(hx, hy, hz, 0);
    }
    st.o &= ~RS_FLAG.EXTENDED;

    if (id === ID.STICKY_PISTON) {
      const px = hx + DIR_DX[dir];
      const py = hy + DIR_DY[dir];
      const pz = hz + DIR_DZ[dir];
      if (py >= WORLD_MIN_Y && py < WORLD_MAX_Y) {
        const pid = this.world.getBlock(px, py, pz);
        if (this._pushReaction(pid, px, py, pz) === 1
          && this._resolveMove(px, py, pz, back, packPos(x, y, z))) {
          const push = this._pushList;
          const pos = this._pos;
          for (let i = 0; i < push.length; i++) {
            unpackPos(push[i], pos);
            this._moveBlock(pos[0], pos[1], pos[2],
              pos[0] + DIR_DX[back], pos[1] + DIR_DY[back], pos[2] + DIR_DZ[back]);
          }
        }
      }
    }

    this._playBlockSound('hit', id, x + 0.5, y + 0.5, z + 0.5);
    this.emit('pistonRetract', x, y, z, dir, id === ID.STICKY_PISTON);
    this._wireEpoch++;
    this._notifyAround(x, y, z);
  }

  /**
   * Move one block (id, redstone state and orientation record) to a new cell.
   * @param {number} fx Source X.
   * @param {number} fy Source Y.
   * @param {number} fz Source Z.
   * @param {number} tx Target X.
   * @param {number} ty Target Y.
   * @param {number} tz Target Z.
   * @returns {void}
   * @private
   */
  _moveBlock(fx, fy, fz, tx, ty, tz) {
    const w = this.world;
    const id = w.getBlock(fx, fy, fz);
    if (id === 0) return;
    const state = this.getState(fx, fy, fz);
    const orient = this._orientation(fx, fy, fz);
    this._clearState(fx, fy, fz);
    this._setBlock(fx, fy, fz, 0);
    if (!this._setBlock(tx, ty, tz, id)) return;
    if (state !== null) {
      state.b = id;
      this._setState(tx, ty, tz, state);
    }
    if (orient !== 0) this._setOrientation(tx, ty, tz, orient);
    this._notify(tx, ty, tz);
  }

  /**
   * Take an extended piston apart when either of its two cells is destroyed.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {RedstoneState} st The state of the cell that went away.
   * @returns {void}
   * @private
   */
  _dismantlePiston(x, y, z, st) {
    if ((st.o & RS_FLAG.HEAD) !== 0) {
      const back = DIR_OPPOSITE[st.f];
      const bx = x + DIR_DX[back];
      const by = y + DIR_DY[back];
      const bz = z + DIR_DZ[back];
      const base = this.getState(bx, by, bz);
      if (base !== null && (base.o & RS_FLAG.EXTENDED) !== 0) {
        base.o &= ~RS_FLAG.EXTENDED;
        this._clearState(bx, by, bz);
        this._setBlock(bx, by, bz, 0);
      }
      return;
    }
    if ((st.o & RS_FLAG.EXTENDED) === 0) return;
    const d = st.f;
    const hx = x + DIR_DX[d];
    const hy = y + DIR_DY[d];
    const hz = z + DIR_DZ[d];
    const head = this.getState(hx, hy, hz);
    if (head !== null && (head.o & RS_FLAG.HEAD) !== 0) {
      this._clearState(hx, hy, hz);
      this._setBlock(hx, hy, hz, 0);
    }
  }

  /* ====================================================================== */
  /* Containers                                                              */
  /* ====================================================================== */

  /**
   * The inventory backing a block. Uses the game's shared container store when
   * one was injected, otherwise the engine's own (which it also serialises).
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {?Object} A `game/inventory.js` `Container`, or `null`.
   * @private
   */
  _containerAt(x, y, z) {
    const w = this.world;
    if (w === null) return null;
    const id = w.getBlock(x, y, z);
    if (id === 0) return null;
    if (this.containerProvider !== null) {
      try {
        return this.containerProvider(x, y, z, id) || null;
      } catch (err) {
        warnOnce('containerProvider', 'the container provider threw', err);
        return null;
      }
    }
    const kind = CONTAINER_KIND[id];
    if (kind === null) return null;
    const key = packPos(x, y, z);
    let container = this._containers.get(key);
    if (container === undefined) {
      try {
        container = createContainer(kind, x, y, z);
      } catch (err) {
        warnOnce('createContainer', 'a container could not be created', err);
        return null;
      }
      this._containers.set(key, container);
    }
    return container;
  }

  /* ====================================================================== */
  /* Components — dispenser & dropper                                        */
  /* ====================================================================== */

  /**
   * Both machines fire on the rising edge of power, four ticks later.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updateDispenser(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    const powered = this.getReceivedPower(x, y, z) > 0;
    const was = (st.o & RS_FLAG.ON) !== 0;
    if (powered === was) return;
    if (powered) st.o |= RS_FLAG.ON; else st.o &= ~RS_FLAG.ON;
    if (!powered) return;
    this._schedule(x, y, z, TAG.DISPENSE, DISPENSER_DELAY, PRIORITY.LOW);
  }

  /**
   * Fire one item out of a dispenser (or push one out of a dropper).
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _dispense(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    const kind = COMPONENT_KIND[id];
    if (kind !== COMPONENT.DISPENSER && kind !== COMPONENT.DROPPER) return;
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    const container = this._containerAt(x, y, z);
    if (container === null) {
      this._play('dispenser', x + 0.5, y + 0.5, z + 0.5, 0.6, 0.8);
      return;
    }

    // Vanilla picks a random non-empty slot.
    let chosen = -1;
    let seen = 0;
    for (let i = 0; i < container.size; i++) {
      const stack = container.get(i);
      if (stack === null || stack === undefined || stack.isEmpty()) continue;
      seen++;
      if (this._rng() < 1 / seen) chosen = i;
    }
    if (chosen < 0) {
      this._play('dispenser', x + 0.5, y + 0.5, z + 0.5, 0.6, 0.8);
      return;
    }

    const dir = st.f;
    const source = container.get(chosen);
    const itemId = source.itemId;
    const isDropper = kind === COMPONENT.DROPPER;
    const single = container.remove(chosen, 1);
    if (single === null || single === undefined) return;
    const stack = single instanceof ItemStack ? single : new ItemStack(itemId, 1, null);

    let handled = false;
    if (isDropper) handled = this._dropperPush(x, y, z, dir, stack);
    else handled = this._dispenseBehaviour(x, y, z, dir, stack, container, chosen);

    if (!handled) this._ejectItem(x, y, z, dir, stack);
    this._play('dispenser', x + 0.5, y + 0.5, z + 0.5, 0.9, 1);
    this._spawn('smoke', x + 0.5 + DIR_DX[dir] * 0.6, y + 0.5 + DIR_DY[dir] * 0.6,
      z + 0.5 + DIR_DZ[dir] * 0.6);
    this.emit(isDropper ? 'drop' : 'dispense', x, y, z, dir, itemId);
  }

  /**
   * Dropper behaviour: feed the container in front, or throw the item out.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} dir Output direction.
   * @param {ItemStack} stack The single item taken out.
   * @returns {boolean} `true` when the item was consumed.
   * @private
   */
  _dropperPush(x, y, z, dir, stack) {
    const tx = x + DIR_DX[dir];
    const ty = y + DIR_DY[dir];
    const tz = z + DIR_DZ[dir];
    const target = this._containerAt(tx, ty, tz);
    if (target === null) return false;
    const leftover = target.add(stack);
    return leftover === null || leftover.isEmpty();
  }

  /**
   * Dispenser behaviour table: arrows are shot, TNT is primed, buckets fill and
   * empty, flint and steel lights TNT, bone meal grows a crop. Everything else
   * is simply thrown.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} dir Output direction.
   * @param {ItemStack} stack The item.
   * @param {Object} container The dispenser inventory.
   * @param {number} slot The slot the item came from.
   * @returns {boolean} `true` when the item was consumed by a behaviour.
   * @private
   */
  _dispenseBehaviour(x, y, z, dir, stack, container, slot) {
    const itemId = stack.itemId;
    const tx = x + DIR_DX[dir];
    const ty = y + DIR_DY[dir];
    const tz = z + DIR_DZ[dir];
    const em = this.entities;

    if (itemId === I.ARROW && em !== null) {
      const speed = 30;
      const spread = 0.06;
      const arrow = new ArrowEntity(
        x + 0.5 + DIR_DX[dir] * 0.7, y + 0.5 + DIR_DY[dir] * 0.7, z + 0.5 + DIR_DZ[dir] * 0.7,
        {
          velocity: [
            DIR_DX[dir] * speed + (this._rng() - 0.5) * spread * speed,
            DIR_DY[dir] * speed + (this._rng() - 0.5) * spread * speed,
            DIR_DZ[dir] * speed + (this._rng() - 0.5) * spread * speed,
          ],
          damage: 2,
        },
      );
      try { em.spawn(arrow); } catch (err) {
        warnOnce('spawnArrow', 'spawning a dispensed arrow failed', err);
        return false;
      }
      this._play('bow_shoot', x + 0.5, y + 0.5, z + 0.5, 0.8, 1);
      return true;
    }

    if (itemId === I.TNT && em !== null) {
      if (this.world.getBlock(tx, ty, tz) !== 0) return false;
      try { em.primeTNT(tx, ty, tz); } catch (err) {
        warnOnce('dispenseTNT', 'priming dispensed TNT failed', err);
        return false;
      }
      this.emit('ignite', tx, ty, tz);
      return true;
    }

    if (itemId === I.FLINT_AND_STEEL) {
      const target = this.world.getBlock(tx, ty, tz);
      const lit = this._ignite(tx, ty, tz, target);
      // The tool is not consumed; it goes back into its slot with one point of
      // wear, exactly like a dispenser in vanilla.
      if (typeof stack.isDamageable === 'function' && stack.isDamageable()) stack.damageBy(1);
      const back = container.addAt(slot, stack);
      if (back !== null && back !== undefined && !back.isEmpty()) container.add(back);
      if (!lit) this._play('ignite', tx + 0.5, ty + 0.5, tz + 0.5, 0.7, 1);
      return true;
    }

    if (itemId === I.WATER_BUCKET || itemId === I.LAVA_BUCKET) {
      const fluid = itemId === I.WATER_BUCKET ? ID.WATER : ID.LAVA;
      const target = this.world.getBlock(tx, ty, tz);
      if (target !== 0 && !isReplaceable(target)) return false;
      this._setBlock(tx, ty, tz, fluid);
      const empty = I.BUCKET !== undefined ? I.BUCKET : itemIdByName('bucket');
      if (empty > 0) {
        const back = container.addAt(slot, new ItemStack(empty, 1, null));
        if (back !== null && back !== undefined && !back.isEmpty()) container.add(back);
      }
      this._play('bucket_empty', tx + 0.5, ty + 0.5, tz + 0.5, 1, 1);
      return true;
    }

    if (itemId === I.BUCKET) {
      const target = this.world.getBlock(tx, ty, tz);
      let filled = 0;
      if (target === ID.WATER) filled = I.WATER_BUCKET;
      else if (target === ID.LAVA) filled = I.LAVA_BUCKET;
      if (filled <= 0) return false;
      this._setBlock(tx, ty, tz, 0);
      const back = container.addAt(slot, new ItemStack(filled, 1, null));
      if (back !== null && back !== undefined && !back.isEmpty()) container.add(back);
      this._play('bucket_fill', tx + 0.5, ty + 0.5, tz + 0.5, 1, 1);
      return true;
    }

    if (itemId === I.BONE_MEAL) {
      if (this._growCrop(tx, ty, tz)) {
        this._spawn('note', tx + 0.5, ty + 0.6, tz + 0.5);
        return true;
      }
      return false;
    }

    // Block items are placed when the cell in front is free.
    if (isBlockItem(itemId)) {
      const blockId = itemToBlock(itemId);
      const target = this.world.getBlock(tx, ty, tz);
      if (blockId > 0 && (target === 0 || isReplaceable(target))
        && COMPONENT_KIND[blockId] === COMPONENT.NONE) {
        if (this._setBlock(tx, ty, tz, blockId)) return true;
      }
      return false;
    }
    return false;
  }

  /**
   * Advance a crop one growth stage (bone meal from a dispenser).
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when a crop grew.
   * @private
   */
  _growCrop(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (id === 0) return false;
    const def = getBlock(id);
    const match = /^(.*)_stage(\d)$/.exec(def.name);
    if (match === null) return false;
    const next = blockByName(`${match[1]}_stage${(match[2] | 0) + 1}`);
    if (next.id === 0) return false;
    return this._setBlock(x, y, z, next.id);
  }

  /**
   * Throw an item out of a dispenser or dropper.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} dir Output direction.
   * @param {ItemStack} stack Item to throw.
   * @returns {void}
   * @private
   */
  _ejectItem(x, y, z, dir, stack) {
    const em = this.entities;
    if (em === null || typeof em.dropItem !== 'function') return;
    const speed = 6;
    try {
      em.dropItem(
        x + 0.5 + DIR_DX[dir] * 0.7, y + 0.4 + DIR_DY[dir] * 0.7, z + 0.5 + DIR_DZ[dir] * 0.7,
        stack,
        [
          DIR_DX[dir] * speed + (this._rng() - 0.5),
          DIR_DY[dir] * speed + 0.4,
          DIR_DZ[dir] * speed + (this._rng() - 0.5),
        ],
      );
    } catch (err) {
      warnOnce('eject', 'ejecting a dispensed item failed', err);
    }
  }

  /* ====================================================================== */
  /* Components — hopper                                                     */
  /* ====================================================================== */

  /**
   * Redstone power locks a hopper.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updateHopperLock(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    const powered = this.getReceivedPower(x, y, z) > 0;
    if (powered) st.o |= RS_FLAG.LOCKED; else st.o &= ~RS_FLAG.LOCKED;
    this._hoppers.add(packPos(x, y, z));
  }

  /**
   * One hopper's transfer step: push a single item into whatever it faces,
   * then pull one in from the container above or from an item lying on top.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {boolean} `true` when the hopper moved something.
   * @private
   */
  _hopperStep(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (COMPONENT_KIND[id] !== COMPONENT.HOPPER) return false;
    const st = this.ensureState(x, y, z, id);
    if (st === null) return false;
    if ((st.o & RS_FLAG.LOCKED) !== 0) return false;
    if (this._tick < st.t) return false;

    const self = this._containerAt(x, y, z);
    if (self === null) return false;
    let moved = this._hopperPush(x, y, z, st, self);
    if (!moved) moved = this._hopperPull(x, y, z, self);
    if (moved) st.t = this._tick + HOPPER_COOLDOWN;
    return moved;
  }

  /**
   * Move one item from a hopper into the container it points at.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {RedstoneState} st Hopper state.
   * @param {Object} self The hopper inventory.
   * @returns {boolean} `true` when an item moved.
   * @private
   */
  _hopperPush(x, y, z, st, self) {
    const d = st.f;
    const target = this._containerAt(x + DIR_DX[d], y + DIR_DY[d], z + DIR_DZ[d]);
    if (target === null) return false;
    for (let i = 0; i < self.size; i++) {
      const stack = self.get(i);
      if (stack === null || stack === undefined || stack.isEmpty()) continue;
      const one = new ItemStack(stack.itemId, 1, stack.meta === null ? null : stack.meta);
      const leftover = target.add(one);
      if (leftover !== null && leftover !== undefined && !leftover.isEmpty()) continue;
      self.remove(i, 1);
      this.emit('hopperTransfer', x, y, z, stack.itemId, 1);
      this._play('hopper', x + 0.5, y + 0.5, z + 0.5, 0.35, 1);
      return true;
    }
    return false;
  }

  /**
   * Pull one item into a hopper from the container above it, or suck up an
   * item entity resting on top.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {Object} self The hopper inventory.
   * @returns {boolean} `true` when an item moved.
   * @private
   */
  _hopperPull(x, y, z, self) {
    const above = this._containerAt(x, y + 1, z);
    if (above !== null) {
      const from = above.isFurnace === true ? 2 : 0;
      const to = above.isFurnace === true ? 2 : above.size - 1;
      for (let i = from; i <= to && i < above.size; i++) {
        const stack = above.get(i);
        if (stack === null || stack === undefined || stack.isEmpty()) continue;
        const one = new ItemStack(stack.itemId, 1, stack.meta === null ? null : stack.meta);
        const leftover = self.add(one);
        if (leftover !== null && leftover !== undefined && !leftover.isEmpty()) continue;
        above.remove(i, 1);
        this.emit('hopperTransfer', x, y, z, stack.itemId, 1);
        return true;
      }
    }
    const em = this.entities;
    if (em === null || typeof em.queryAABB !== 'function') return false;
    const box = this._box;
    box[0] = x; box[1] = y + 1; box[2] = z;
    box[3] = x + 1; box[4] = y + 1.8; box[5] = z + 1;
    const list = em.queryAABB(box, this._entityScratch);
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.type !== 'item' || e.removed) continue;
      if (e.pickupDelay !== undefined && e.pickupDelay > 0) continue;
      const stack = e.stack;
      if (stack === null || stack === undefined || stack.isEmpty()) continue;
      const leftover = self.add(stack.clone());
      const taken = stack.count - (leftover === null || leftover === undefined ? 0 : leftover.count);
      if (taken <= 0) continue;
      stack.shrink(taken);
      if (stack.isEmpty()) e.remove('collected');
      this.emit('hopperTransfer', x, y, z, stack.itemId, taken);
      this._play('hopper', x + 0.5, y + 0.5, z + 0.5, 0.35, 1);
      moved = true;
      break;
    }
    list.length = 0;
    return moved;
  }

  /* ====================================================================== */
  /* Components — rails                                                      */
  /* ====================================================================== */

  /**
   * Axis a rail runs along: `0` = X, `1` = Z. Taken from the neighbouring
   * rails, falling back to Z the way a freshly placed rail does.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {number} `0` or `1`.
   * @private
   */
  _railAxis(x, y, z) {
    const w = this.world;
    let ex = 0;
    let ez = 0;
    if (this._isRail(w.getBlock(x + 1, y, z))) ex++;
    if (this._isRail(w.getBlock(x - 1, y, z))) ex++;
    if (this._isRail(w.getBlock(x, y, z + 1))) ez++;
    if (this._isRail(w.getBlock(x, y, z - 1))) ez++;
    if (ex > ez) return 0;
    if (ez > ex) return 1;
    return 1;
  }

  /**
   * Is this block id any kind of rail?
   * @param {number} id Block id.
   * @returns {boolean} `true` for rails and powered rails.
   * @private
   */
  _isRail(id) {
    const k = COMPONENT_KIND[id];
    return k === COMPONENT.RAIL || k === COMPONENT.POWERED_RAIL;
  }

  /**
   * A powered rail is live when it sees redstone power itself or when it is
   * connected to a live powered rail up to {@link RAIL_CHAIN_LIMIT} rails away.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} axis Rail axis.
   * @returns {boolean} `true` when the rail is live.
   * @private
   */
  _railHasPower(x, y, z, axis) {
    if (this.getReceivedPower(x, y, z) > 0) return true;
    const w = this.world;
    for (let side = 0; side < 2; side++) {
      const dx = axis === 0 ? (side === 0 ? 1 : -1) : 0;
      const dz = axis === 1 ? (side === 0 ? 1 : -1) : 0;
      let cx = x + dx;
      let cz = z + dz;
      for (let step = 1; step < RAIL_CHAIN_LIMIT; step++) {
        if (COMPONENT_KIND[w.getBlock(cx, y, cz)] !== COMPONENT.POWERED_RAIL) break;
        if (this.getReceivedPower(cx, y, cz) > 0) return true;
        cx += dx;
        cz += dz;
      }
    }
    return false;
  }

  /**
   * Re-evaluate a powered rail's own on/off state.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} id Block id.
   * @returns {void}
   * @private
   */
  _updatePoweredRail(x, y, z, id) {
    const st = this.ensureState(x, y, z, id);
    if (st === null) return;
    st.m = this._railAxis(x, y, z);
    const live = this._railHasPower(x, y, z, st.m);
    const was = (st.o & RS_FLAG.ON) !== 0;
    this._rails.add(packPos(x, y, z));
    if (live === was) return;
    if (live) st.o |= RS_FLAG.ON; else st.o &= ~RS_FLAG.ON;
    st.p = live ? MAX_POWER : 0;
    this.emit('powerChanged', x, y, z, id, st.p);
    // Neighbouring powered rails chain off this one.
    for (let i = 0; i < 4; i++) {
      const d = HORIZONTAL[i];
      this._notify(x + DIR_DX[d], y, z + DIR_DZ[d]);
    }
  }

  /**
   * Push (or brake) every cart sitting on a powered rail near the player.
   * @param {number} dt Tick length in seconds.
   * @returns {void}
   * @private
   */
  _runRails(dt) {
    const em = this.entities;
    if (em === null || typeof em.queryAABB !== 'function') return;
    if (this._rails.size === 0) return;
    const player = this.player;
    const px = player && player.position ? player.position[0] : 0;
    const py = player && player.position ? player.position[1] : 0;
    const pz = player && player.position ? player.position[2] : 0;
    const r2 = RAIL_ACTIVE_RADIUS * RAIL_ACTIVE_RADIUS;
    const box = this._box;
    const pos = this._pos;

    for (const key of this._rails) {
      unpackPos(key, pos);
      const x = pos[0];
      const y = pos[1];
      const z = pos[2];
      if (player !== null) {
        const dx = x - px;
        const dy = y - py;
        const dz = z - pz;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
      }
      const id = this.world.getBlock(x, y, z);
      if (COMPONENT_KIND[id] !== COMPONENT.POWERED_RAIL) {
        this._rails.delete(key);
        continue;
      }
      const st = this.getState(x, y, z);
      if (st === null) continue;
      box[0] = x - 0.2; box[1] = y - 0.1; box[2] = z - 0.2;
      box[3] = x + 1.2; box[4] = y + 1.1; box[5] = z + 1.2;
      const list = em.queryAABB(box, this._entityScratch);
      if (list.length === 0) continue;
      const live = (st.o & RS_FLAG.ON) !== 0;
      const axis = st.m === 0 ? 0 : 2;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.removed) continue;
        if (!CART_TYPES.has(e.type) && e.isMinecart !== true) continue;
        const v = e.velocity;
        if (!live) {
          v[0] *= 0.5;
          v[2] *= 0.5;
          continue;
        }
        let along = v[axis];
        if (Math.abs(along) < 0.05) along = this._railLaunchDirection(x, y, z, st.m);
        if (along === 0) continue;
        const sign = along > 0 ? 1 : -1;
        const speed = clamp(Math.abs(v[axis]) + CART_ACCEL * dt, 0, CART_MAX_SPEED);
        v[axis] = sign * speed;
        v[axis === 0 ? 2 : 0] *= 0.6;
      }
      list.length = 0;
    }
  }

  /**
   * Which way a standing cart should be kicked: toward the open end of the
   * track, so a powered rail with a block on one side launches the other way.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} axis Rail axis (`0` = X, `1` = Z).
   * @returns {number} `1`, `-1` or `0` when both sides are blocked.
   * @private
   */
  _railLaunchDirection(x, y, z, axis) {
    const w = this.world;
    const dx = axis === 0 ? 1 : 0;
    const dz = axis === 1 ? 1 : 0;
    const plus = isSolid(w.getBlock(x + dx, y, z + dz));
    const minus = isSolid(w.getBlock(x - dx, y, z - dz));
    if (plus && !minus) return -1;
    if (minus && !plus) return 1;
    return 0;
  }

  /* ====================================================================== */
  /* Registry passes                                                         */
  /* ====================================================================== */

  /**
   * Walk a registry round-robin, calling `fn` until the budget runs out.
   * The cursor is kept between ticks so every member gets its turn.
   * @param {Set<number>} set Registry of packed positions.
   * @param {number} slot Cursor slot in `_cursor`.
   * @param {TimeBudget} budget Shared budget.
   * @param {number} maxPerTick Cap on entries visited this tick.
   * @param {function(number,number,number,number):void} fn Callback
   *   `(x, y, z, key)`.
   * @returns {number} How many entries were visited.
   * @private
   */
  _walkRegistry(set, slot, budget, maxPerTick, fn) {
    const size = set.size;
    if (size === 0) return 0;
    const list = this._walk;
    list.length = 0;
    for (const key of set) list.push(key);
    let cursor = this._cursor[slot] % list.length;
    const limit = Math.min(size, maxPerTick);
    const pos = this._pos;
    let visited = 0;
    for (let i = 0; i < limit; i++) {
      if ((i & 7) === 7 && budget.expired()) break;
      const key = list[cursor];
      cursor = (cursor + 1) % list.length;
      unpackPos(key, pos);
      if (!this._isLoaded(pos[0], pos[2])) { set.delete(key); continue; }
      try {
        fn(pos[0], pos[1], pos[2], key);
      } catch (err) {
        warnOnce('registry', 'a polled redstone component threw and was skipped', err);
      }
      visited++;
    }
    this._cursor[slot] = cursor;
    list.length = 0;
    return visited;
  }

  /**
   * Hopper transfer pass.
   * @param {TimeBudget} budget Shared budget.
   * @returns {void}
   * @private
   */
  _runHoppers(budget) {
    this.stats.hoppers = this._walkRegistry(this._hoppers, 0, budget, 128, (x, y, z, key) => {
      if (COMPONENT_KIND[this.world.getBlock(x, y, z)] !== COMPONENT.HOPPER) {
        this._hoppers.delete(key);
        return;
      }
      this._hopperStep(x, y, z);
    });
  }

  /**
   * Pressure plate pass.
   * @param {TimeBudget} budget Shared budget.
   * @returns {void}
   * @private
   */
  _runPlates(budget) {
    this.stats.plates = this._walkRegistry(this._plates, 1, budget, 96, (x, y, z, key) => {
      const id = this.world.getBlock(x, y, z);
      if (COMPONENT_KIND[id] !== COMPONENT.PLATE) {
        this._plates.delete(key);
        return;
      }
      this._updatePlate(x, y, z, id);
    });
  }

  /**
   * Daylight sensor pass — once a second is plenty.
   * @returns {void}
   * @private
   */
  _runSensors() {
    if (this._sensors.size === 0) return;
    if ((this._tick % 20) !== 0) return;
    const pos = this._pos;
    for (const key of this._sensors) {
      unpackPos(key, pos);
      const id = this.world.getBlock(pos[0], pos[1], pos[2]);
      if (COMPONENT_KIND[id] !== COMPONENT.DAYLIGHT) {
        this._sensors.delete(key);
        continue;
      }
      try {
        this._updateSensor(pos[0], pos[1], pos[2], id);
      } catch (err) {
        warnOnce('sensor', 'a daylight sensor threw and was skipped', err);
      }
    }
  }

  /* ====================================================================== */
  /* Background component scan                                               */
  /* ====================================================================== */

  /**
   * Remember a freshly streamed chunk so its redstone components get found.
   * @param {Object} chunk The chunk.
   * @returns {void}
   * @private
   */
  _queueScan(chunk) {
    if (this.disposed || !chunk) return;
    const key = packChunk(chunk.cx, chunk.cz);
    if (this._scanned.has(key)) return;
    this._scanned.add(key);
    this._scanQueue.push(key);
  }

  /**
   * Scan queued chunks one section at a time. A section is a flat
   * `Uint16Array(4096)` walked against the `COMPONENT_KIND` lookup, so a whole
   * chunk costs on the order of a tenth of a millisecond.
   * @param {TimeBudget} budget Shared budget.
   * @returns {void}
   * @private
   */
  _runScan(budget) {
    const queue = this._scanQueue;
    const w = this.world;
    while (queue.length > 0) {
      if (budget.expired()) return;
      const key = queue[0];
      const cz = (key % CHUNK_SPAN) - CHUNK_OFFSET;
      const cx = ((key - (cz + CHUNK_OFFSET)) / CHUNK_SPAN) - CHUNK_OFFSET;
      const chunk = w.getChunk(cx, cz);
      if (chunk === null || !chunk.generated) {
        queue.shift();
        this._scanSection = 0;
        continue;
      }
      const sections = chunk.sections;
      while (this._scanSection < sections.length) {
        if (budget.expired()) return;
        const section = sections[this._scanSection];
        this._scanSection++;
        if (!section || section.blocks === null || section.nonAirCount === 0) continue;
        this._scanSectionBlocks(chunk, section);
        this.stats.scanned++;
      }
      queue.shift();
      this._scanSection = 0;
    }
  }

  /**
   * Register every redstone component in one section and kick a neighbour
   * update at it, so circuits restored from disk come back to life.
   * @param {Object} chunk Owning chunk.
   * @param {Object} section The section.
   * @returns {void}
   * @private
   */
  _scanSectionBlocks(chunk, section) {
    const blocks = section.blocks;
    const baseX = chunk.cx << 4;
    const baseZ = chunk.cz << 4;
    const baseY = WORLD_MIN_Y + (section.sy << 4);
    for (let i = 0; i < blocks.length; i++) {
      const id = blocks[i];
      if (id === 0) continue;
      const kind = COMPONENT_KIND[id];
      if (kind === COMPONENT.NONE) continue;
      const lx = i & 15;
      const lz = (i >> 4) & 15;
      const ly = i >> 8;
      const x = baseX + lx;
      const y = baseY + ly;
      const z = baseZ + lz;
      switch (kind) {
        case COMPONENT.HOPPER: this._hoppers.add(packPos(x, y, z)); break;
        case COMPONENT.PLATE: this._plates.add(packPos(x, y, z)); break;
        case COMPONENT.DAYLIGHT: this._sensors.add(packPos(x, y, z)); break;
        case COMPONENT.POWERED_RAIL: this._rails.add(packPos(x, y, z)); break;
        default: break;
      }
      this.ensureState(x, y, z, id);
      this._notify(x, y, z);
    }
  }

  /**
   * Drop a chunk's whole state bucket when the chunk unloads.
   * @param {Object} chunk The chunk leaving memory.
   * @returns {void}
   * @private
   */
  _forgetChunk(chunk) {
    if (!chunk) return;
    const key = packChunk(chunk.cx, chunk.cz);
    const map = this._chunkStates.get(key);
    if (map !== undefined) {
      this.stats.states = Math.max(0, this.stats.states - map.size);
      map.clear();
      this._chunkStates.delete(key);
    }
    if (this._lastChunk === key) { this._lastChunk = -1; this._lastMap = null; }
    this._scanned.delete(key);
    const minX = chunk.cx << 4;
    const minZ = chunk.cz << 4;
    this._dropRegistryChunk(this._hoppers, minX, minZ);
    this._dropRegistryChunk(this._plates, minX, minZ);
    this._dropRegistryChunk(this._sensors, minX, minZ);
    this._dropRegistryChunk(this._rails, minX, minZ);
    if (this.containerProvider === null && this._containers.size > 0) {
      const pos = this._pos;
      for (const key2 of this._containers.keys()) {
        unpackPos(key2, pos);
        if ((pos[0] >> 4) === chunk.cx && (pos[2] >> 4) === chunk.cz) this._containers.delete(key2);
      }
    }
  }

  /**
   * Remove every registry entry inside one chunk column.
   * @param {Set<number>} set Registry.
   * @param {number} minX West edge of the chunk.
   * @param {number} minZ North edge of the chunk.
   * @returns {void}
   * @private
   */
  _dropRegistryChunk(set, minX, minZ) {
    if (set.size === 0) return;
    const pos = this._pos;
    for (const key of set) {
      unpackPos(key, pos);
      if (pos[0] >= minX && pos[0] < minX + 16 && pos[2] >= minZ && pos[2] < minZ + 16) {
        set.delete(key);
      }
    }
  }

  /* ====================================================================== */
  /* Effects                                                                 */
  /* ====================================================================== */

  /**
   * Play a sound when an audio engine was handed in. Unknown names degrade to
   * a soft click inside `game/audio.js`, so new effects never break playback.
   * @param {string} name Sound name.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} volume Volume `0..1`.
   * @param {number} pitch Pitch multiplier.
   * @returns {void}
   * @private
   */
  _play(name, x, y, z, volume, pitch) {
    const audio = this.audio;
    if (audio === null || typeof audio.play !== 'function') return;
    try {
      audio.play(name, { x, y, z, volume, pitch });
    } catch (err) {
      warnOnce(`sound:${name}`, `playing "${name}" failed`, err);
    }
  }

  /**
   * Play a block's material sound (used for the piston, which has no dedicated
   * recipe in `game/audio.js`).
   * @param {string} action `'break'`, `'place'`, `'step'`, `'hit'` or `'dig'`.
   * @param {number} blockId Block whose material decides the sound.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _playBlockSound(action, blockId, x, y, z) {
    const audio = this.audio;
    if (audio === null || typeof audio.playBlockSound !== 'function') return;
    try {
      audio.playBlockSound(action, blockId, x, y, z);
    } catch (err) {
      warnOnce(`blockSound:${action}`, `playing the ${action} block sound failed`, err);
    }
  }

  /**
   * Spawn a particle when a particle system was handed in.
   * @param {string} type Particle type.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @returns {void}
   * @private
   */
  _spawn(type, x, y, z) {
    const particles = this.particles;
    if (particles === null || typeof particles.spawn !== 'function') return;
    try {
      particles.spawn(type, x, y, z);
    } catch (err) {
      warnOnce(`particle:${type}`, `spawning "${type}" particles failed`, err);
    }
  }

  /**
   * Live counters for the F3 overlay.
   * @returns {{updates:number, wires:number, networks:number, scheduled:number,
   *   hoppers:number, plates:number, scanned:number, states:number,
   *   queued:number, overloads:number, ms:number}} The `stats` object (live,
   *   not a copy).
   */
  getStats() {
    this.stats.queued = this._queue.size;
    return this.stats;
  }

  /* ====================================================================== */
  /* Public hooks                                                            */
  /* ====================================================================== */

  /**
   * Tell the engine a block changed. Wire this to `world.on('blockChanged')`
   * and every other path is covered automatically.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} oldId Previous block id.
   * @param {number} newId New block id.
   * @returns {void}
   */
  onBlockChanged(x, y, z, oldId, newId) {
    if (this.disposed || this.world === null) return;
    if (!inRange(x, y, z)) return;
    if (oldId === newId) return;

    const internal = this._selfEdit > 0;
    if (!internal) {
      const st = this.getState(x, y, z);
      if (st !== null && st.b !== newId) {
        if (st.k === COMPONENT.PISTON) this._dismantlePiston(x, y, z, st);
        this._clearState(x, y, z);
      }
      const key = packPos(x, y, z);
      if (COMPONENT_KIND[oldId] === COMPONENT.HOPPER) this._hoppers.delete(key);
      if (COMPONENT_KIND[oldId] === COMPONENT.PLATE) this._plates.delete(key);
      if (COMPONENT_KIND[oldId] === COMPONENT.DAYLIGHT) this._sensors.delete(key);
      if (COMPONENT_KIND[oldId] === COMPONENT.POWERED_RAIL) this._rails.delete(key);
      if (COMPONENT_KIND[oldId] === COMPONENT.NONE
        && this.containerProvider === null) this._containers.delete(key);
    }

    const kind = COMPONENT_KIND[newId];
    if (kind !== COMPONENT.NONE) {
      const key = packPos(x, y, z);
      if (kind === COMPONENT.HOPPER) this._hoppers.add(key);
      else if (kind === COMPONENT.PLATE) this._plates.add(key);
      else if (kind === COMPONENT.DAYLIGHT) this._sensors.add(key);
      else if (kind === COMPONENT.POWERED_RAIL) this._rails.add(key);
    }

    this._wireEpoch++;
    this._notify(x, y, z);
    this._notifyAround(x, y, z);
    if (!internal) this._fireObservers(x, y, z);
  }

  /**
   * Tell the engine a block was *placed*, so it can pick the component's
   * facing from the placement. Hook this to
   * `interaction.on('blockPlaced', ...)` and pass the player (or a look vector)
   * along; without a context the component falls back to facing `+X`.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} blockId The block that was placed.
   * @param {number} [state] The orientation `game/interaction.js` computed.
   * @param {{player?:Object, lookDir?:ArrayLike<number>, facing?:number,
   *   face?:number, sneaking?:boolean}} [ctx] Placement context.
   * @returns {void}
   */
  onBlockPlaced(x, y, z, blockId, state = 0, ctx = null) {
    if (this.disposed || this.world === null) return;
    if (!inRange(x, y, z)) return;
    const kind = COMPONENT_KIND[blockId];
    if (kind === COMPONENT.NONE) {
      this.onBlockChanged(x, y, z, 0, blockId);
      return;
    }
    this._clearState(x, y, z);
    const st = newState(kind, blockId);
    this._initState(st, x, y, z, blockId, ctx);
    this._setState(x, y, z, st);

    const key = packPos(x, y, z);
    if (kind === COMPONENT.HOPPER) this._hoppers.add(key);
    else if (kind === COMPONENT.PLATE) this._plates.add(key);
    else if (kind === COMPONENT.DAYLIGHT) this._sensors.add(key);
    else if (kind === COMPONENT.POWERED_RAIL) this._rails.add(key);

    // A freshly laid rail re-shapes its neighbours' axes.
    if (kind === COMPONENT.RAIL || kind === COMPONENT.POWERED_RAIL) {
      for (let i = 0; i < 4; i++) {
        const d = HORIZONTAL[i];
        this._notify(x + DIR_DX[d], y, z + DIR_DZ[d]);
      }
    }

    this._wireEpoch++;
    this._notify(x, y, z);
    this._notifyAround(x, y, z);
    this._fireObservers(x, y, z);
  }

  /**
   * Tell the engine a block was removed by a player or another system.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} blockId The block that was there.
   * @returns {void}
   */
  onBlockRemoved(x, y, z, blockId) {
    if (this.disposed || this.world === null) return;
    if (!inRange(x, y, z)) return;
    const st = this.getState(x, y, z);
    if (st !== null && st.k === COMPONENT.PISTON) this._dismantlePiston(x, y, z, st);
    this._clearState(x, y, z);
    const key = packPos(x, y, z);
    this._hoppers.delete(key);
    this._plates.delete(key);
    this._sensors.delete(key);
    this._rails.delete(key);
    if (this.containerProvider === null) this._containers.delete(key);
    this._wireEpoch++;
    this._notify(x, y, z);
    this._notifyAround(x, y, z);
    this._fireObservers(x, y, z);
  }

  /**
   * Right-click handling for every component that has one: levers, buttons,
   * repeater delay, comparator mode, note pitch, doors, trapdoors, fence gates
   * and the daylight sensor's inversion.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} [blockId] Block id; read from the world when omitted.
   * @param {{player?:Object, sneaking?:boolean}} [ctx] Interaction context.
   * @returns {boolean} `true` when the engine consumed the interaction — the
   *   caller must then not place a block.
   */
  onInteract(x, y, z, blockId = -1, ctx = null) {
    if (this.disposed || this.world === null) return false;
    if (!inRange(x, y, z)) return false;
    if (ctx !== null && ctx.sneaking === true) return false;
    const id = blockId >= 0 ? blockId : this.world.getBlock(x, y, z);
    const kind = COMPONENT_KIND[id];
    switch (kind) {
      case COMPONENT.LEVER:
        return this._toggleLever(x, y, z, id);
      case COMPONENT.BUTTON:
        return this._pressButton(x, y, z, id);
      case COMPONENT.REPEATER: {
        const st = this.ensureState(x, y, z, id);
        if (st === null) return false;
        st.d = (clamp(st.d | 0, 1, 4) % 4) + 1;
        this._play('click', x + 0.5, y + 0.5, z + 0.5, 0.6, 0.9 + st.d * 0.1);
        this.emit('click', x, y, z, id, true);
        this._notify(x, y, z);
        return true;
      }
      case COMPONENT.COMPARATOR: {
        const st = this.ensureState(x, y, z, id);
        if (st === null) return false;
        st.o ^= RS_FLAG.SUBTRACT;
        this._play('click', x + 0.5, y + 0.5, z + 0.5, 0.6,
          (st.o & RS_FLAG.SUBTRACT) !== 0 ? 0.8 : 1.2);
        this.emit('click', x, y, z, id, (st.o & RS_FLAG.SUBTRACT) !== 0);
        this._notify(x, y, z);
        return true;
      }
      case COMPONENT.NOTE_BLOCK: {
        const st = this.ensureState(x, y, z, id);
        if (st === null) return false;
        st.d = ((clamp(st.d | 0, 0, 24) + 1) % 25);
        this._playNote(x, y, z, st);
        return true;
      }
      case COMPONENT.DOOR: {
        const st = this.ensureState(x, y, z, id);
        if (st === null) return false;
        const baseY = (st.o & RS_FLAG.UPPER) !== 0 ? y - 1 : y;
        this._setDoorOpen(x, baseY, z, (st.o & RS_FLAG.OPEN) === 0, true);
        return true;
      }
      case COMPONENT.TRAPDOOR:
      case COMPONENT.FENCE_GATE: {
        const st = this.ensureState(x, y, z, id);
        if (st === null) return false;
        this._setFlapOpen(x, y, z, id, kind, (st.o & RS_FLAG.OPEN) === 0, true);
        return true;
      }
      case COMPONENT.DAYLIGHT: {
        const st = this.ensureState(x, y, z, id);
        if (st === null) return false;
        st.o ^= RS_FLAG.INVERTED;
        this._play('click', x + 0.5, y + 0.5, z + 0.5, 0.6, 1);
        this._updateSensor(x, y, z, id);
        return true;
      }
      case COMPONENT.TNT: {
        // Flint and steel in hand lights the charge; anything else falls
        // through to the normal interaction handling.
        const held = ctx && ctx.heldItem ? ctx.heldItem : null;
        if (held !== null && held.itemId === I.FLINT_AND_STEEL) {
          this._ignite(x, y, z, id);
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  /* ====================================================================== */
  /* Persistence                                                             */
  /* ====================================================================== */

  /**
   * Snapshot the whole engine: every chunk's state bucket, the pending
   * scheduler entries, the polled registries and — when no container provider
   * was injected — the containers the engine owns itself.
   *
   * Timers are written relative to the current tick, so the snapshot survives
   * the engine's tick counter restarting at zero.
   *
   * @returns {{v:number, chunks:Array<[number, number[]]>, queue:number[],
   *   hoppers:number[], plates:number[], sensors:number[], rails:number[],
   *   containers:Array<[number, Object]>}} Structured-clone friendly snapshot.
   */
  serialize() {
    /** @type {Array<[number, number[]]>} */
    const chunks = [];
    for (const [ck, map] of this._chunkStates) {
      if (map.size === 0) continue;
      const flat = new Array(map.size * (STATE_FIELDS + 1));
      let i = 0;
      for (const [lk, st] of map) {
        flat[i++] = lk;
        flat[i++] = st.k;
        flat[i++] = st.b;
        flat[i++] = st.p;
        flat[i++] = st.f;
        flat[i++] = st.d;
        flat[i++] = st.m;
        flat[i++] = st.o;
        flat[i++] = st.t > 0 ? st.t - this._tick : 0;
        flat[i++] = st.n;
        flat[i++] = st.w > 0 ? st.w - this._tick : 0;
        flat[i++] = 0;
      }
      chunks.push([ck, flat]);
    }

    /** @type {number[]} Flat `[key, x, y, z, kind, tag, prio, dueOffset]`. */
    const queue = [];
    const items = this._queue._items;
    for (let i = 0; i < this._queue.size; i++) {
      const rec = items[i];
      if (!rec) continue;
      queue.push(rec.key, rec.x, rec.y, rec.z, rec.kind, rec.tag, rec.prio,
        Math.max(0, rec.due - this._tick));
    }

    /** @type {Array<[number, Object]>} */
    const containers = [];
    if (this.containerProvider === null) {
      for (const [key, container] of this._containers) {
        try {
          if (typeof container.isEmpty === 'function' && container.isEmpty()) continue;
          containers.push([key, container.serialize()]);
        } catch { /* one broken container must not block the save */ }
      }
    }

    return {
      v: SAVE_VERSION,
      chunks,
      queue,
      hoppers: Array.from(this._hoppers),
      plates: Array.from(this._plates),
      sensors: Array.from(this._sensors),
      rails: Array.from(this._rails),
      containers,
    };
  }

  /**
   * Restore a snapshot produced by {@link RedstoneEngine#serialize}. Unknown or
   * malformed payloads are ignored rather than throwing.
   * @param {*} snapshot The snapshot.
   * @returns {boolean} `true` when something was restored.
   */
  deserialize(snapshot) {
    if (this.disposed) return false;
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (snapshot.v !== undefined && snapshot.v !== SAVE_VERSION) {
      warnOnce('save', `ignoring a redstone snapshot of version ${snapshot.v}`);
      return false;
    }
    this._chunkStates.clear();
    this._lastChunk = -1;
    this._lastMap = null;
    this.stats.states = 0;

    const chunks = Array.isArray(snapshot.chunks) ? snapshot.chunks : [];
    for (let c = 0; c < chunks.length; c++) {
      const entry = chunks[c];
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const ck = Number(entry[0]);
      if (!Number.isFinite(ck)) continue;
      const flat = entry[1];
      if (!Array.isArray(flat) && !ArrayBuffer.isView(flat)) continue;
      const map = new Map();
      const stride = STATE_FIELDS + 1;
      for (let i = 0; i + stride <= flat.length; i += stride) {
        const st = newState(flat[i + 1] | 0, flat[i + 2] | 0);
        st.p = clamp(flat[i + 3] | 0, 0, MAX_POWER);
        st.f = clamp(flat[i + 4] | 0, 0, 5);
        st.d = flat[i + 5] | 0;
        st.m = flat[i + 6] | 0;
        st.o = flat[i + 7] | 0;
        const t = flat[i + 8] | 0;
        st.t = t === 0 ? 0 : this._tick + t;
        st.n = flat[i + 9] | 0;
        const wOff = flat[i + 10] | 0;
        st.w = wOff === 0 ? 0 : this._tick + wOff;
        map.set(flat[i] | 0, st);
      }
      if (map.size === 0) continue;
      this._chunkStates.set(ck, map);
      this.stats.states += map.size;
    }

    this._queue.clear();
    this._queuedNeighbours.clear();
    this._queuedScheduled.clear();
    const queue = snapshot.queue;
    if (Array.isArray(queue)) {
      for (let i = 0; i + 8 <= queue.length; i += 8) {
        const rec = this._pool.get();
        rec.key = queue[i];
        rec.x = queue[i + 1] | 0;
        rec.y = queue[i + 2] | 0;
        rec.z = queue[i + 3] | 0;
        rec.kind = queue[i + 4] | 0;
        rec.tag = queue[i + 5] | 0;
        rec.prio = queue[i + 6] | 0;
        rec.due = this._tick + Math.max(0, queue[i + 7] | 0);
        rec.seq = this._seq++;
        if (rec.kind === KIND.NEIGHBOUR) {
          if (this._queuedNeighbours.has(rec.key)) { this._pool.release(rec); continue; }
          this._queuedNeighbours.add(rec.key);
        } else {
          if (this._queuedScheduled.has(rec.key)) { this._pool.release(rec); continue; }
          this._queuedScheduled.add(rec.key);
        }
        this._queue.push(rec);
      }
    }

    this._restoreRegistry(this._hoppers, snapshot.hoppers);
    this._restoreRegistry(this._plates, snapshot.plates);
    this._restoreRegistry(this._sensors, snapshot.sensors);
    this._restoreRegistry(this._rails, snapshot.rails);

    this._containers.clear();
    if (this.containerProvider === null && Array.isArray(snapshot.containers)) {
      for (let i = 0; i < snapshot.containers.length; i++) {
        const pair = snapshot.containers[i];
        if (!Array.isArray(pair) || pair.length < 2) continue;
        try {
          const restored = Container.deserialize(pair[1]);
          this._containers.set(pair[0], restored);
        } catch (err) {
          warnOnce('restoreContainer', 'a redstone container could not be restored', err);
        }
      }
    }

    this._wireEpoch++;
    return true;
  }

  /**
   * Refill one registry from a snapshot array.
   * @param {Set<number>} set Target registry.
   * @param {*} list Array of packed positions.
   * @returns {void}
   * @private
   */
  _restoreRegistry(set, list) {
    set.clear();
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (Number.isFinite(v)) set.add(v);
    }
  }

  /* ====================================================================== */
  /* Teardown                                                                */
  /* ====================================================================== */

  /**
   * Detach every listener and drop all state. Safe to call twice.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.world && typeof this.world.off === 'function') {
      this.world.off('chunkUnloaded', this._onChunkUnloaded);
      this.world.off('chunkLoaded', this._onChunkLoaded);
      this.world.off('chunkReady', this._onChunkLoaded);
    }
    this._queue.clear();
    this._queuedNeighbours.clear();
    this._queuedScheduled.clear();
    this._chunkStates.clear();
    this._execCount.clear();
    this._hotTicks.clear();
    this._suspended.clear();
    this._hoppers.clear();
    this._plates.clear();
    this._sensors.clear();
    this._rails.clear();
    this._containers.clear();
    this._scanQueue.length = 0;
    this._scanned.clear();
    this._wireList.length = 0;
    this._wireIndex.clear();
    this._pushList.length = 0;
    this._destroyList.length = 0;
    this._pushSet.clear();
    this._entityScratch.length = 0;
    this._lastChunk = -1;
    this._lastMap = null;
    this.world = null;
    this.entities = null;
    this.player = null;
    this.environment = null;
    this.audio = null;
    this.particles = null;
    this.containerProvider = null;
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}

export default RedstoneEngine;
