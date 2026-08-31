/**
 * VOXELIA — cube-based skeletal entity renderer, held item, block outline and
 * break overlay (ARCHITECTURE.md 5.25).
 *
 * Everything here is procedural: the mob "skins" are generated on the GPU into a
 * private `TEXTURE_2D_ARRAY` at init time, the item icons are generated the same
 * way, and the geometry of every model is built once from the {@link MODELS}
 * table into a static VBO. A whole mob is therefore **one draw call**: all the
 * parts of a model live in the same buffer and each vertex carries the index of
 * the bone that moves it, so the animator only uploads `u_bones[24]`.
 *
 * ### Model format
 * A model is a tree of parts:
 * ```js
 * { name, parent, pivot:[x,y,z], offset:[x,y,z], size:[sx,sy,sz],
 *   uv:[u,v], rot:[rx,ry,rz], inflate, kind, children:[] }
 * ```
 * All lengths are **model units**, `16 units = 1 block`, `+Y` up, `+Z` forward,
 * origin at the entity's feet. `pivot` is the absolute rest position of the
 * joint, `offset` the box's minimum corner relative to that pivot, `uv` the
 * top-left corner of the box's unwrap inside the model's skin (default 64x64,
 * overridable with `uvSize`). Face unwrap follows the classic box layout:
 * ```
 *        [top ][bot ]
 *  [ -X ][ +Z ][ +X ][ -Z ]
 * ```
 *
 * ### Texture units
 * * `0/1/2` — block albedo / normal / MRAE arrays, used by held blocks, dropped
 *   block items and the break overlay (bound through `TextureManager`).
 * * `15` — **this module's own arrays** (the free per-pass unit of 3.5): the mob
 *   skin array while entities draw, the item icon array while sprites draw.
 *
 * Nothing in this file throws during a frame: program builds, texture generation
 * and every draw loop are wrapped, a failure is logged exactly once and the pass
 * degrades to a no-op.
 *
 * @module render/entities
 */

import { FULLSCREEN_VS } from '../core/gl.js';
import { mat4, vec3, clamp, lerp, damp } from '../core/math.js';
import {
  RENDER, blockRender, blockAABBs, faceMaterial, blockTint, getBlock,
} from '../world/blocks.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

/** Frame UBO binding point (ARCHITECTURE.md 3.3). @type {number} */
const FRAME_BINDING = 0;

/** Texture unit of the block albedo array (ARCHITECTURE.md 3.5). @type {number} */
const UNIT_ALBEDO_ARRAY = 0;

/** Free per-pass texture unit used for the skin / item icon arrays. @type {number} */
const UNIT_ENTITY = 15;

/** Maximum bones per model — matches `uniform mat4 u_bones[24]`. @type {number} */
export const MAX_BONES = 24;

/** Model units per block. @type {number} */
const MODEL_UNIT = 1 / 16;

/** Default skin unwrap size in model-UV pixels. @type {number} */
const DEFAULT_UV_W = 64;
/** Default skin unwrap height in model-UV pixels. @type {number} */
const DEFAULT_UV_H = 64;

/** Rendered resolution of one mob skin layer, in texels. @type {number} */
const SKIN_TEX_SIZE = 128;

/** Rendered resolution of one item icon layer, in texels. @type {number} */
const ITEM_TEX_SIZE = 64;

/** Interior slice count of an extruded item sprite. @type {number} */
const SPRITE_SLICES = 9;

/** Thickness of an extruded item sprite, in blocks. @type {number} */
const SPRITE_THICKNESS = 1 / 16;

/** Bytes per skinned entity vertex: 3+3+2 floats + 1 byte bone + 3 pad. @type {number} */
const ENTITY_VERTEX_STRIDE = 36;

/** Reference walking speed (blocks/second) that maps to a full-amplitude gait. @type {number} */
const WALK_REFERENCE_SPEED = 4.3;

/** Window-depth slice reserved for the first-person hand. @type {number} */
const HAND_DEPTH_RANGE = 0.05;

/** Fixed foliage tints used by held/dropped block items (no biome context). */
const ITEM_TINTS = Object.freeze({
  grass: Object.freeze([0.49, 0.75, 0.35]),
  foliage: Object.freeze([0.41, 0.67, 0.28]),
  water: Object.freeze([0.24, 0.46, 0.90]),
});

/* ========================================================================== */
/* Model authoring helpers                                                    */
/* ========================================================================== */

/**
 * Build one part of a model.
 *
 * @param {string} name unique part name (also the bone name)
 * @param {?string} parent parent part name, or null for a root part
 * @param {number[]} pivot absolute rest pivot `[x,y,z]` in model units
 * @param {number[]} offset box minimum corner relative to `pivot`
 * @param {number[]} size box size `[sx,sy,sz]` in model units
 * @param {number[]} uv unwrap origin `[u,v]` in model-UV pixels
 * @param {{rot?:number[], inflate?:number, kind?:('box'|'plane')}} [extra] options
 * @returns {{name:string, parent:?string, pivot:number[], offset:number[],
 *            size:number[], uv:number[], rot:number[], inflate:number,
 *            kind:string, children:string[]}} the part
 */
function part(name, parent, pivot, offset, size, uv, extra) {
  const e = extra || {};
  return {
    name,
    parent: parent || null,
    pivot: [pivot[0], pivot[1], pivot[2]],
    offset: [offset[0], offset[1], offset[2]],
    size: [size[0], size[1], size[2]],
    uv: [uv[0], uv[1]],
    rot: e.rot ? [e.rot[0], e.rot[1], e.rot[2]] : [0, 0, 0],
    inflate: e.inflate === undefined ? 0 : e.inflate,
    kind: e.kind === 'plane' ? 'plane' : 'box',
    children: [],
  };
}

/** Shorthand for the eight radial tentacle/leg angles of the squid. @type {number[]} */
const OCTO_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * Build the eight tentacles of the squid model.
 * @returns {Object[]} tentacle parts
 */
function squidTentacles() {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const a = (OCTO_ANGLES[i] * Math.PI) / 180;
    const px = Math.cos(a) * 4;
    const pz = Math.sin(a) * 4;
    out.push(part(`tentacle_${i}`, 'body', [px, 4, pz], [-1, -14, -1], [2, 14, 2], [0, 26], {
      rot: [Math.sin(a) * 0.18, -a, -Math.cos(a) * 0.18],
    }));
  }
  return out;
}

/**
 * Build the eight legs of the spider model.
 * @returns {Object[]} leg parts
 */
function spiderLegs() {
  const out = [];
  const zs = [4, 1, -2, -5];
  const yaws = [-0.55, -0.19, 0.19, 0.55];
  for (let i = 0; i < 4; i++) {
    out.push(part(`leg_l${i}`, 'thorax', [3, 9, zs[i]], [0, -1, -1], [14, 2, 2], [0, 38], {
      rot: [0, yaws[i], -0.45],
    }));
    out.push(part(`leg_r${i}`, 'thorax', [-3, 9, zs[i]], [-14, -1, -1], [14, 2, 2], [0, 38], {
      rot: [0, -yaws[i], 0.45],
    }));
  }
  return out;
}

/* ========================================================================== */
/* MODELS                                                                     */
/* ========================================================================== */

/**
 * The cube-model library. Every entry is
 * `{ parts:Object[], uvSize?:[w,h], height:number, width:number, radius:number }`
 * where `height`/`width` are the entity's nominal size in blocks (used for the
 * light probe) and `radius` is the culling sphere radius in blocks.
 *
 * @type {Object<string, {parts:Object[], uvSize?:number[], height:number,
 *                        width:number, radius:number, billboard?:boolean}>}
 */
export const MODELS = {
  /* ---------------------------------------------------------------- biped */
  humanoid: {
    height: 1.8,
    width: 0.6,
    radius: 1.3,
    parts: [
      part('body', null, [0, 12, 0], [-4, 0, -2], [8, 12, 4], [16, 16]),
      part('head', 'body', [0, 24, 0], [-4, 0, -4], [8, 8, 8], [0, 0]),
      part('arm_r', 'body', [-6, 22, 0], [-2, -10, -2], [4, 12, 4], [40, 16]),
      part('arm_l', 'body', [6, 22, 0], [-2, -10, -2], [4, 12, 4], [32, 48]),
      part('leg_r', 'body', [-2, 12, 0], [-2, -12, -2], [4, 12, 4], [0, 16]),
      part('leg_l', 'body', [2, 12, 0], [-2, -12, -2], [4, 12, 4], [16, 48]),
    ],
  },

  humanoid_slim: {
    height: 1.99,
    width: 0.6,
    radius: 1.4,
    parts: [
      part('body', null, [0, 12, 0], [-4, 0, -2], [8, 12, 4], [16, 16]),
      part('head', 'body', [0, 24, 0], [-4, 0, -4], [8, 8, 8], [0, 0]),
      part('arm_r', 'body', [-5, 22, 0], [-1, -10, -1], [2, 12, 2], [40, 16]),
      part('arm_l', 'body', [5, 22, 0], [-1, -10, -1], [2, 12, 2], [48, 16]),
      part('leg_r', 'body', [-2, 12, 0], [-1, -12, -1], [2, 12, 2], [0, 16]),
      part('leg_l', 'body', [2, 12, 0], [-1, -12, -1], [2, 12, 2], [8, 16]),
    ],
  },

  villager: {
    height: 1.95,
    width: 0.6,
    radius: 1.4,
    parts: [
      part('body', null, [0, 12, 0], [-4, 0, -3], [8, 12, 6], [16, 20]),
      part('robe', 'body', [0, 12, 0], [-4.5, -10, -3.5], [9, 10, 7], [0, 38]),
      part('head', 'body', [0, 24, 0], [-4, 0, -4], [8, 8, 8], [0, 0]),
      part('nose', 'head', [0, 26, 4], [-1, -2, 0], [2, 4, 2], [44, 32]),
      part('arm_r', 'body', [-6, 22, 0], [-2, -10, -2], [4, 12, 4], [44, 16]),
      part('arm_l', 'body', [6, 22, 0], [-2, -10, -2], [4, 12, 4], [44, 16]),
      part('leg_r', 'body', [-2, 12, 0], [-2, -12, -2], [4, 12, 4], [0, 20]),
      part('leg_l', 'body', [2, 12, 0], [-2, -12, -2], [4, 12, 4], [0, 20]),
    ],
  },

  /* -------------------------------------------------------------- creeper */
  creeper: {
    height: 1.7,
    width: 0.6,
    radius: 1.2,
    parts: [
      part('body', null, [0, 6, 0], [-4, 0, -2], [8, 12, 4], [16, 16]),
      part('head', 'body', [0, 18, 0], [-4, 0, -4], [8, 8, 8], [0, 0]),
      part('leg_fr', 'body', [-2, 6, 4], [-2, -6, -2], [4, 6, 4], [0, 16]),
      part('leg_fl', 'body', [2, 6, 4], [-2, -6, -2], [4, 6, 4], [0, 16]),
      part('leg_br', 'body', [-2, 6, -4], [-2, -6, -2], [4, 6, 4], [0, 16]),
      part('leg_bl', 'body', [2, 6, -4], [-2, -6, -2], [4, 6, 4], [0, 16]),
    ],
  },

  /* --------------------------------------------------------------- spider */
  spider: {
    height: 0.9,
    width: 1.4,
    radius: 1.5,
    parts: [
      part('thorax', null, [0, 9, 0], [-3, -3, -3], [6, 6, 6], [0, 0]),
      part('body', 'thorax', [0, 9, -6], [-5, -5, -6], [10, 10, 12], [0, 16]),
      part('head', 'thorax', [0, 9, 3], [-4, -4, 0], [8, 8, 8], [24, 0]),
    ].concat(spiderLegs()),
  },

  /* ------------------------------------------------------------- enderman */
  enderman: {
    height: 2.9,
    width: 0.6,
    radius: 2.0,
    parts: [
      part('body', null, [0, 20, 0], [-4, 0, -2], [8, 12, 4], [16, 16]),
      part('head', 'body', [0, 32, 0], [-4, 0, -4], [8, 8, 8], [0, 0]),
      part('arm_r', 'body', [-5, 31, 0], [-2, -24, -1], [2, 30, 2], [40, 16]),
      part('arm_l', 'body', [5, 31, 0], [0, -24, -1], [2, 30, 2], [48, 16]),
      part('leg_r', 'body', [-2, 20, 0], [-1, -20, -1], [2, 20, 2], [0, 32]),
      part('leg_l', 'body', [2, 20, 0], [-1, -20, -1], [2, 20, 2], [8, 32]),
    ],
  },

  /* ------------------------------------------------------------ quadruped */
  quadruped: {
    height: 1.4,
    width: 0.9,
    radius: 1.5,
    parts: [
      part('body', null, [0, 14, 0], [-5, -5, -8], [10, 10, 16], [0, 20]),
      part('head', 'body', [0, 18, 8], [-4, -4, 0], [8, 8, 8], [0, 0]),
      part('snout', 'head', [0, 16, 16], [-3, -2, -1], [6, 4, 4], [32, 0]),
      part('horn_l', 'head', [3, 22, 10], [-1, 0, -1], [2, 3, 2], [52, 0], { rot: [0, 0, 0.35] }),
      part('horn_r', 'head', [-3, 22, 10], [-1, 0, -1], [2, 3, 2], [52, 0], { rot: [0, 0, -0.35] }),
      part('ear_l', 'head', [4, 20, 9], [0, -1, -1], [4, 2, 2], [52, 6], { rot: [0, 0, 0.2] }),
      part('ear_r', 'head', [-4, 20, 9], [-4, -1, -1], [4, 2, 2], [52, 6], { rot: [0, 0, -0.2] }),
      part('leg_fl', 'body', [3, 10, 6], [-2, -10, -2], [4, 10, 4], [0, 48]),
      part('leg_fr', 'body', [-3, 10, 6], [-2, -10, -2], [4, 10, 4], [0, 48]),
      part('leg_bl', 'body', [3, 10, -6], [-2, -10, -2], [4, 10, 4], [0, 48]),
      part('leg_br', 'body', [-3, 10, -6], [-2, -10, -2], [4, 10, 4], [0, 48]),
      part('udder', 'body', [0, 9, -2], [-2, -2, -3], [4, 2, 6], [16, 48]),
    ],
  },

  /* -------------------------------------------------------------- chicken */
  chicken: {
    height: 0.7,
    width: 0.4,
    radius: 0.8,
    parts: [
      part('body', null, [0, 7, 0], [-3, -3, -4], [6, 6, 8], [0, 16]),
      part('head', 'body', [0, 10, 3], [-2, -2, 0], [4, 6, 3], [0, 0]),
      part('beak', 'head', [0, 11, 6], [-2, -1, 0], [4, 2, 2], [14, 0]),
      part('wattle', 'head', [0, 10, 6], [-1, -2, 0], [2, 2, 2], [14, 5]),
      part('comb', 'head', [0, 13, 3], [-1, 0, -1], [2, 2, 4], [26, 0]),
      part('wing_l', 'body', [3, 9, 0], [0, -4, -3], [1, 4, 6], [28, 16]),
      part('wing_r', 'body', [-3, 9, 0], [-1, -4, -3], [1, 4, 6], [28, 16]),
      part('leg_l', 'body', [2, 4, 0], [-1, -4, -2], [2, 4, 4], [42, 16]),
      part('leg_r', 'body', [-2, 4, 0], [-1, -4, -2], [2, 4, 4], [42, 16]),
      part('tail', 'body', [0, 9, -4], [-2, -1, -4], [4, 4, 4], [0, 32], { rot: [0.5, 0, 0] }),
    ],
  },

  /* ----------------------------------------------------------------- wolf */
  wolf: {
    height: 0.85,
    width: 0.6,
    radius: 1.0,
    parts: [
      part('body', null, [0, 13, 0], [-4, -4, -8], [8, 8, 16], [0, 12]),
      part('mane', 'body', [0, 14, -1], [-5, -5, -4], [10, 10, 8], [0, 36]),
      part('head', 'body', [0, 15, 8], [-3, -3, 0], [6, 6, 6], [0, 0]),
      part('snout', 'head', [0, 15, 14], [-2, -2, 0], [4, 3, 3], [24, 0]),
      part('ear_l', 'head', [2, 21, 10], [0, 0, -1], [2, 3, 1], [38, 0], { rot: [0, 0, 0.2] }),
      part('ear_r', 'head', [-2, 21, 10], [-2, 0, -1], [2, 3, 1], [38, 0], { rot: [0, 0, -0.2] }),
      part('tail', 'body', [0, 15, -8], [-1, -8, -2], [2, 8, 2], [44, 0], { rot: [-0.6, 0, 0] }),
      part('leg_fl', 'body', [2, 8, 5], [-1, -8, -1], [2, 8, 2], [52, 0]),
      part('leg_fr', 'body', [-2, 8, 5], [-1, -8, -1], [2, 8, 2], [52, 0]),
      part('leg_bl', 'body', [2, 8, -5], [-1, -8, -1], [2, 8, 2], [52, 0]),
      part('leg_br', 'body', [-2, 8, -5], [-1, -8, -1], [2, 8, 2], [52, 0]),
    ],
  },

  /* ------------------------------------------------------------------ cat */
  cat: {
    height: 0.7,
    width: 0.6,
    radius: 0.9,
    parts: [
      part('body', null, [0, 9, 0], [-3, -3, -8], [6, 6, 16], [0, 10]),
      part('head', 'body', [0, 11, 8], [-2.5, -2, 0], [5, 4, 5], [0, 0]),
      part('ear_l', 'head', [1.8, 13, 9], [-1, 0, -0.5], [2, 2, 1], [20, 0], { rot: [0, 0, 0.25] }),
      part('ear_r', 'head', [-1.8, 13, 9], [-1, 0, -0.5], [2, 2, 1], [20, 0], { rot: [0, 0, -0.25] }),
      part('snout', 'head', [0, 10.5, 13], [-1.5, -1, 0], [3, 2, 2], [26, 0]),
      part('tail', 'body', [0, 10, -8], [-1, -10, -1], [2, 10, 2], [44, 10], { rot: [-1.1, 0, 0] }),
      part('leg_fl', 'body', [2, 7, 5], [-1, -7, -1], [2, 7, 2], [0, 34]),
      part('leg_fr', 'body', [-2, 7, 5], [-1, -7, -1], [2, 7, 2], [0, 34]),
      part('leg_bl', 'body', [2, 7, -5], [-1, -7, -1], [2, 7, 2], [0, 34]),
      part('leg_br', 'body', [-2, 7, -5], [-1, -7, -1], [2, 7, 2], [0, 34]),
    ],
  },

  /* ------------------------------------------------------------------ bat */
  bat: {
    height: 0.9,
    width: 0.5,
    radius: 1.4,
    parts: [
      part('body', null, [0, 10, 0], [-3, -4, -2], [6, 8, 4], [0, 0]),
      part('head', 'body', [0, 18, 0], [-3, -3, -3], [6, 6, 6], [20, 0]),
      part('ear_l', 'head', [2, 21, -1], [0, 0, -1], [2, 4, 1], [44, 0], { rot: [0, 0, 0.25] }),
      part('ear_r', 'head', [-2, 21, -1], [-2, 0, -1], [2, 4, 1], [44, 0], { rot: [0, 0, -0.25] }),
      part('wing_l', 'body', [3, 16, 0], [0, -8, -0.5], [10, 10, 1], [0, 14]),
      part('wing_r', 'body', [-3, 16, 0], [-10, -8, -0.5], [10, 10, 1], [0, 14]),
      part('wingtip_l', 'wing_l', [13, 16, 0], [0, -8, -0.5], [10, 10, 1], [22, 14]),
      part('wingtip_r', 'wing_r', [-13, 16, 0], [-10, -8, -0.5], [10, 10, 1], [22, 14]),
    ],
  },

  /* ---------------------------------------------------------------- squid */
  squid: {
    height: 0.8,
    width: 0.8,
    radius: 1.3,
    parts: [
      part('body', null, [0, 10, 0], [-6, -6, -6], [12, 12, 12], [0, 0]),
    ].concat(squidTentacles()),
  },

  /* ---------------------------------------------------------------- slime */
  slime: {
    height: 1.0,
    width: 1.0,
    radius: 1.2,
    parts: [
      part('body', null, [0, 0, 0], [-4, 0, -4], [8, 8, 8], [0, 0]),
      part('inner', 'body', [0, 0, 0], [-3, 1, -3], [6, 6, 6], [32, 0]),
      part('eye_l', 'inner', [0, 0, 0], [1.5, 4, 3], [2, 2, 2], [32, 14]),
      part('eye_r', 'inner', [0, 0, 0], [-3.5, 4, 3], [2, 2, 2], [32, 14]),
      part('mouth', 'inner', [0, 0, 0], [-1, 2, 3], [2, 1, 2], [40, 14]),
    ],
  },

  /* ----------------------------------------------------------- iron golem */
  iron_golem: {
    uvSize: [128, 128],
    height: 2.7,
    width: 1.4,
    radius: 2.2,
    parts: [
      part('waist', null, [0, 16, 0], [-4.5, 0, -3], [9, 6, 6], [0, 0]),
      part('body', 'waist', [0, 22, 0], [-9, 0, -3], [18, 12, 6], [0, 40]),
      part('head', 'body', [0, 34, 0], [-4, 0, -4], [8, 10, 8], [30, 0]),
      part('nose', 'head', [0, 36, 4], [-1, 0, 0], [2, 4, 2], [62, 0]),
      part('arm_r', 'body', [-10, 33, 0], [-4, -26, -2], [4, 30, 4], [70, 0]),
      part('arm_l', 'body', [10, 33, 0], [0, -26, -2], [4, 30, 4], [70, 0]),
      part('leg_r', 'waist', [-4, 16, 0], [-3, -16, -3], [6, 16, 6], [0, 60]),
      part('leg_l', 'waist', [4, 16, 0], [-3, -16, -3], [6, 16, 6], [0, 60]),
    ],
  },

  /* ---------------------------------------------------------------- horse */
  horse: {
    uvSize: [128, 128],
    height: 1.6,
    width: 1.4,
    radius: 1.8,
    parts: [
      part('body', null, [0, 16, 0], [-4, -4, -9], [8, 8, 18], [0, 32]),
      part('neck', 'body', [0, 19, 7], [-2, 0, -2], [4, 12, 5], [0, 0], { rot: [-0.5, 0, 0] }),
      part('head', 'neck', [0, 29, 12], [-3, -3, -1], [6, 6, 9], [18, 0], { rot: [0.35, 0, 0] }),
      part('ear_l', 'head', [2, 32, 8], [-1, 0, -1], [2, 3, 2], [48, 0], { rot: [0, 0, 0.2] }),
      part('ear_r', 'head', [-2, 32, 8], [-1, 0, -1], [2, 3, 2], [48, 0], { rot: [0, 0, -0.2] }),
      part('mane', 'neck', [0, 19, 7], [-1, 0, -3], [2, 12, 5], [56, 0], { rot: [-0.5, 0, 0] }),
      part('tail', 'body', [0, 19, -9], [-1.5, -12, -3], [3, 12, 3], [70, 0], { rot: [-0.9, 0, 0] }),
      part('leg_fl', 'body', [3, 12, 6], [-2, -12, -2], [4, 12, 4], [82, 0]),
      part('leg_fr', 'body', [-3, 12, 6], [-2, -12, -2], [4, 12, 4], [82, 0]),
      part('leg_bl', 'body', [3, 12, -6], [-2, -12, -2], [4, 12, 4], [82, 0]),
      part('leg_br', 'body', [-3, 12, -6], [-2, -12, -2], [4, 12, 4], [82, 0]),
    ],
  },

  /* ------------------------------------------------------------------ fox */
  fox: {
    height: 0.7,
    width: 0.6,
    radius: 1.1,
    parts: [
      part('body', null, [0, 10, 0], [-3, -3, -7], [6, 6, 14], [0, 14]),
      part('head', 'body', [0, 11, 7], [-4, -3, 0], [8, 6, 6], [0, 0]),
      part('snout', 'head', [0, 10, 13], [-2, -1.5, 0], [4, 3, 4], [28, 0]),
      part('ear_l', 'head', [3, 14, 8], [0, 0, -0.5], [2, 3, 1], [44, 0], { rot: [0, 0, 0.25] }),
      part('ear_r', 'head', [-3, 14, 8], [-2, 0, -0.5], [2, 3, 1], [44, 0], { rot: [0, 0, -0.25] }),
      part('tail', 'body', [0, 10, -7], [-2.5, -2.5, -12], [5, 5, 12], [0, 36], { rot: [0.35, 0, 0] }),
      part('leg_fl', 'body', [2, 7, 5], [-1, -7, -1], [2, 7, 2], [44, 6]),
      part('leg_fr', 'body', [-2, 7, 5], [-1, -7, -1], [2, 7, 2], [44, 6]),
      part('leg_bl', 'body', [2, 7, -5], [-1, -7, -1], [2, 7, 2], [44, 6]),
      part('leg_br', 'body', [-2, 7, -5], [-1, -7, -1], [2, 7, 2], [44, 6]),
    ],
  },

  /* --------------------------------------------------------------- rabbit */
  rabbit: {
    height: 0.5,
    width: 0.4,
    radius: 0.7,
    parts: [
      part('body', null, [0, 7, 0], [-3, -2.5, -5], [6, 5, 10], [0, 10]),
      part('head', 'body', [0, 10, 5], [-2.5, -2, 0], [5, 4, 4], [0, 0]),
      part('ear_l', 'head', [1.5, 13, 5], [-1, 0, -0.5], [2, 5, 1], [18, 0], { rot: [-0.15, 0, 0.18] }),
      part('ear_r', 'head', [-1.5, 13, 5], [-1, 0, -0.5], [2, 5, 1], [18, 0], { rot: [-0.15, 0, -0.18] }),
      part('nose', 'head', [0, 10, 9], [-1, -0.5, 0], [2, 1, 1], [24, 0]),
      part('tail', 'body', [0, 8, -5], [-1.5, -1.5, -2], [3, 3, 2], [30, 0]),
      part('foot_l', 'body', [2, 2, -2], [-1, -2, -3], [2, 2, 6], [0, 26]),
      part('foot_r', 'body', [-2, 2, -2], [-1, -2, -3], [2, 2, 6], [0, 26]),
      part('leg_fl', 'body', [2, 4, 3], [-1, -4, -1], [2, 4, 2], [16, 26]),
      part('leg_fr', 'body', [-2, 4, 3], [-1, -4, -1], [2, 4, 2], [16, 26]),
    ],
  },

  /* ---------------------------------------------------------------- arrow */
  arrow: {
    height: 0.5,
    width: 0.5,
    radius: 0.6,
    parts: [
      part('shaft', null, [0, 0, 0], [-0.5, -0.5, -8], [1, 1, 16], [0, 0]),
      part('fletch_v', 'shaft', [0, 0, -6], [-0.5, -2.5, -4], [1, 5, 5], [0, 18]),
      part('fletch_h', 'shaft', [0, 0, -6], [-2.5, -0.5, -4], [5, 1, 5], [14, 18]),
    ],
  },

  /* ------------------------------------------------- flat item billboard */
  item: {
    billboard: true,
    height: 0.5,
    width: 0.5,
    radius: 0.5,
    parts: [
      part('quad', null, [0, 0, 0], [-8, -8, 0], [16, 16, 0], [0, 0], { kind: 'plane' }),
    ],
  },
};

/* ========================================================================== */
/* Skins & per-type visuals                                                   */
/* ========================================================================== */

/**
 * Procedural mob skins, in generation order. `model` names the model whose head
 * and body unwrap rectangles the generator uses to place eyes and clothing.
 * @type {ReadonlyArray<{name:string, model:string}>}
 */
export const SKINS = Object.freeze([
  { name: 'player', model: 'humanoid' },
  { name: 'zombie', model: 'humanoid' },
  { name: 'husk', model: 'humanoid' },
  { name: 'drowned', model: 'humanoid' },
  { name: 'skeleton', model: 'humanoid_slim' },
  { name: 'creeper', model: 'creeper' },
  { name: 'spider', model: 'spider' },
  { name: 'enderman', model: 'enderman' },
  { name: 'villager', model: 'villager' },
  { name: 'witch', model: 'villager' },
  { name: 'pig', model: 'quadruped' },
  { name: 'cow', model: 'quadruped' },
  { name: 'sheep', model: 'quadruped' },
  { name: 'chicken', model: 'chicken' },
  { name: 'wolf', model: 'wolf' },
  { name: 'cat', model: 'cat' },
  { name: 'horse', model: 'horse' },
  { name: 'iron_golem', model: 'iron_golem' },
  { name: 'bat', model: 'bat' },
  { name: 'squid', model: 'squid' },
  { name: 'slime', model: 'slime' },
  { name: 'fox', model: 'fox' },
  { name: 'rabbit', model: 'rabbit' },
  { name: 'arrow', model: 'arrow' },
  { name: 'generic', model: 'item' },
]);

/** Skin name -> layer index. @type {Map<string, number>} */
const SKIN_INDEX = new Map();
for (let i = 0; i < SKINS.length; i++) SKIN_INDEX.set(SKINS[i].name, i);

/**
 * Per entity-type render description.
 *
 * * `model` / `skin` — geometry and skin layer.
 * * `anim` — animation profile driven by {@link EntityAnimator}.
 * * `scale` — uniform model scale multiplier.
 * * `stride` — radians of gait phase per block walked.
 * * `hide` — bone names collapsed to zero scale (species variations).
 * * `glow` — emissive strength written into `o_extra.b`.
 *
 * @type {Object<string, Object>}
 */
export const ENTITY_VISUALS = {
  player: { model: 'humanoid', skin: 'player', anim: 'biped', stride: 2.66 },
  zombie: { model: 'humanoid', skin: 'zombie', anim: 'biped', stride: 2.4, armsUp: 1 },
  husk: { model: 'humanoid', skin: 'husk', anim: 'biped', stride: 2.4, armsUp: 1 },
  drowned: { model: 'humanoid', skin: 'drowned', anim: 'biped', stride: 2.4, armsUp: 0.8 },
  skeleton: { model: 'humanoid_slim', skin: 'skeleton', anim: 'biped', stride: 2.9 },
  stray: { model: 'humanoid_slim', skin: 'skeleton', anim: 'biped', stride: 2.9 },
  villager: { model: 'villager', skin: 'villager', anim: 'biped', stride: 2.2, armsCrossed: 1 },
  witch: { model: 'villager', skin: 'witch', anim: 'biped', stride: 2.2, armsCrossed: 1 },
  creeper: { model: 'creeper', skin: 'creeper', anim: 'creeper', stride: 3.2 },
  spider: { model: 'spider', skin: 'spider', anim: 'spider', stride: 3.6, scale: 1.0 },
  cave_spider: { model: 'spider', skin: 'spider', anim: 'spider', stride: 4.0, scale: 0.7 },
  enderman: { model: 'enderman', skin: 'enderman', anim: 'biped', stride: 1.8, glow: 0.15 },
  pig: { model: 'quadruped', skin: 'pig', anim: 'quadruped', stride: 3.4, scale: 0.82,
    hide: ['horn_l', 'horn_r', 'udder'] },
  cow: { model: 'quadruped', skin: 'cow', anim: 'quadruped', stride: 3.0 },
  sheep: { model: 'quadruped', skin: 'sheep', anim: 'quadruped', stride: 3.2, scale: 0.92,
    hide: ['horn_l', 'horn_r', 'udder'] },
  mooshroom: { model: 'quadruped', skin: 'cow', anim: 'quadruped', stride: 3.0 },
  chicken: { model: 'chicken', skin: 'chicken', anim: 'chicken', stride: 5.0, scale: 0.85 },
  wolf: { model: 'wolf', skin: 'wolf', anim: 'wolf', stride: 3.8, scale: 0.95 },
  cat: { model: 'cat', skin: 'cat', anim: 'wolf', stride: 4.2, scale: 0.85 },
  ocelot: { model: 'cat', skin: 'cat', anim: 'wolf', stride: 4.2, scale: 0.9 },
  horse: { model: 'horse', skin: 'horse', anim: 'quadruped', stride: 2.8, scale: 0.9 },
  iron_golem: { model: 'iron_golem', skin: 'iron_golem', anim: 'golem', stride: 1.6 },
  bat: { model: 'bat', skin: 'bat', anim: 'bat', stride: 1.0, scale: 0.6 },
  squid: { model: 'squid', skin: 'squid', anim: 'squid', stride: 1.0 },
  glow_squid: { model: 'squid', skin: 'squid', anim: 'squid', stride: 1.0, glow: 0.8 },
  slime: { model: 'slime', skin: 'slime', anim: 'slime', stride: 1.0 },
  magma_cube: { model: 'slime', skin: 'slime', anim: 'slime', stride: 1.0, glow: 0.7 },
  fox: { model: 'fox', skin: 'fox', anim: 'wolf', stride: 4.0, scale: 0.9 },
  rabbit: { model: 'rabbit', skin: 'rabbit', anim: 'rabbit', stride: 5.0, scale: 0.9 },
  arrow: { model: 'arrow', skin: 'arrow', anim: 'projectile', stride: 0 },
};

/**
 * Visual used for an entity type nobody registered: the flat billboard model
 * with the neutral skin, so an unknown mob is visible instead of invisible.
 * @type {Object}
 */
const FALLBACK_VISUAL = Object.freeze({
  model: 'item', skin: 'generic', anim: 'projectile', stride: 0, scale: 1,
});

/** Entity types drawn as a rotating item instead of a skinned model. */
const ITEM_ENTITY_TYPES = new Set(['item', 'item_entity', 'dropped_item', 'xp_orb', 'experience_orb']);

/** Entity types drawn as a solid block cube. */
const BLOCK_ENTITY_TYPES = new Set(['tnt', 'primed_tnt', 'falling_block']);

/* ========================================================================== */
/* Geometry construction                                                      */
/* ========================================================================== */

/**
 * Append one axis-aligned quad (4 vertices, 6 indices) to the scratch arrays.
 *
 * @param {Object} acc accumulator `{pos, nrm, uv, bone, idx, count}`
 * @param {number} bone bone index of every vertex
 * @param {number[]} c four corners, flattened `[x,y,z] * 4`, CCW seen from outside
 * @param {number[]} t four UV pairs in model-UV pixels, matching the corners
 * @param {number} nx normal X
 * @param {number} ny normal Y
 * @param {number} nz normal Z
 * @param {number} uvW model-UV width
 * @param {number} uvH model-UV height
 * @returns {void}
 */
function pushQuad(acc, bone, c, t, nx, ny, nz, uvW, uvH) {
  const base = acc.count;
  for (let i = 0; i < 4; i++) {
    acc.pos.push(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
    acc.nrm.push(nx, ny, nz);
    acc.uv.push(t[i * 2] / uvW, 1 - t[i * 2 + 1] / uvH);
    acc.bone.push(bone);
  }
  acc.count += 4;
  acc.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Append the six faces of a box using the classic model unwrap.
 *
 * @param {Object} acc accumulator
 * @param {number} bone bone index
 * @param {number} x0 box min X
 * @param {number} y0 box min Y
 * @param {number} z0 box min Z
 * @param {number} sx box size X
 * @param {number} sy box size Y
 * @param {number} sz box size Z
 * @param {number} u unwrap origin U in model-UV pixels
 * @param {number} v unwrap origin V in model-UV pixels
 * @param {number} tw texture width of the unwrap (box X extent in pixels)
 * @param {number} th texture height of the unwrap (box Y extent in pixels)
 * @param {number} td texture depth of the unwrap (box Z extent in pixels)
 * @param {number} uvW model-UV width
 * @param {number} uvH model-UV height
 * @returns {void}
 */
function pushBox(acc, bone, x0, y0, z0, sx, sy, sz, u, v, tw, th, td, uvW, uvH) {
  const x1 = x0 + sx;
  const y1 = y0 + sy;
  const z1 = z0 + sz;

  // +Z front
  pushQuad(acc, bone,
    [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
    [u + td, v + td + th, u + td + tw, v + td + th, u + td + tw, v + td, u + td, v + td],
    0, 0, 1, uvW, uvH);
  // -Z back
  pushQuad(acc, bone,
    [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0],
    [u + 2 * td + tw, v + td + th, u + 2 * td + 2 * tw, v + td + th,
      u + 2 * td + 2 * tw, v + td, u + 2 * td + tw, v + td],
    0, 0, -1, uvW, uvH);
  // +X left
  pushQuad(acc, bone,
    [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1],
    [u + td + tw, v + td + th, u + 2 * td + tw, v + td + th,
      u + 2 * td + tw, v + td, u + td + tw, v + td],
    1, 0, 0, uvW, uvH);
  // -X right
  pushQuad(acc, bone,
    [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0],
    [u, v + td + th, u + td, v + td + th, u + td, v + td, u, v + td],
    -1, 0, 0, uvW, uvH);
  // +Y top
  pushQuad(acc, bone,
    [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0],
    [u + td, v + td, u + td + tw, v + td, u + td + tw, v, u + td, v],
    0, 1, 0, uvW, uvH);
  // -Y bottom
  pushQuad(acc, bone,
    [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1],
    [u + td + tw, v, u + td + 2 * tw, v, u + td + 2 * tw, v + td, u + td + tw, v + td],
    0, -1, 0, uvW, uvH);
}

/**
 * Append a double-sided flat quad in the XY plane (used by the `item` model).
 *
 * @param {Object} acc accumulator
 * @param {number} bone bone index
 * @param {number} x0 min X
 * @param {number} y0 min Y
 * @param {number} z0 plane Z
 * @param {number} sx width
 * @param {number} sy height
 * @param {number} u unwrap origin U
 * @param {number} v unwrap origin V
 * @param {number} uvW model-UV width
 * @param {number} uvH model-UV height
 * @returns {void}
 */
function pushPlane(acc, bone, x0, y0, z0, sx, sy, u, v, uvW, uvH) {
  const x1 = x0 + sx;
  const y1 = y0 + sy;
  pushQuad(acc, bone,
    [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0],
    [u, v + sy, u + sx, v + sy, u + sx, v, u, v],
    0, 0, 1, uvW, uvH);
  pushQuad(acc, bone,
    [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0],
    [u + sx, v + sy, u, v + sy, u, v, u + sx, v],
    0, 0, -1, uvW, uvH);
}

/** Monotonic id handed to each compiled model, used as a draw-sort key. @type {number} */
let MODEL_UID = 0;

/**
 * Compile a model definition into a flat bone list plus interleaved geometry.
 *
 * @param {string} name model name
 * @param {Object} def model definition from {@link MODELS}
 * @returns {?Object} compiled model, or null when the definition is unusable
 */
function compileModel(name, def) {
  if (!def || !Array.isArray(def.parts) || def.parts.length === 0) return null;
  const uvW = def.uvSize ? def.uvSize[0] : DEFAULT_UV_W;
  const uvH = def.uvSize ? def.uvSize[1] : DEFAULT_UV_H;

  const src = def.parts;
  const index = new Map();
  for (let i = 0; i < src.length; i++) index.set(src[i].name, i);

  // Topological order: a parent always precedes its children.
  const order = [];
  const mark = new Uint8Array(src.length);
  const visit = (i, depth) => {
    if (mark[i] === 2 || depth > MAX_BONES) return;
    if (mark[i] === 1) { mark[i] = 2; order.push(i); return; }
    mark[i] = 1;
    const p = src[i].parent === null ? -1 : (index.has(src[i].parent) ? index.get(src[i].parent) : -1);
    if (p >= 0 && p !== i && mark[p] !== 2) visit(p, depth + 1);
    if (mark[i] !== 2) { mark[i] = 2; order.push(i); }
  };
  for (let i = 0; i < src.length; i++) visit(i, 0);

  const parts = [];
  const remap = new Map();
  for (let k = 0; k < order.length && parts.length < MAX_BONES; k++) {
    const p = src[order[k]];
    remap.set(p.name, parts.length);
    parts.push(p);
  }
  if (parts.length < src.length) {
    console.warn(`[entities] model "${name}" has ${src.length} parts; only the first ${MAX_BONES} bones are used.`);
  }

  const parentIndex = new Int32Array(parts.length);
  const boneIndex = new Map();
  for (let i = 0; i < parts.length; i++) {
    boneIndex.set(parts[i].name, i);
    const pn = parts[i].parent;
    parentIndex[i] = pn !== null && remap.has(pn) ? remap.get(pn) : -1;
    if (parentIndex[i] === i) parentIndex[i] = -1;
  }
  for (let i = 0; i < parts.length; i++) {
    parts[i].children.length = 0;
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parentIndex[i];
    if (p >= 0) parts[p].children.push(parts[i].name);
  }

  const acc = { pos: [], nrm: [], uv: [], bone: [], idx: [], count: 0 };
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const inf = p.inflate || 0;
    const bx = p.pivot[0] + p.offset[0] - inf;
    const by = p.pivot[1] + p.offset[1] - inf;
    const bz = p.pivot[2] + p.offset[2] - inf;
    const sx = p.size[0] + inf * 2;
    const sy = p.size[1] + inf * 2;
    const sz = p.size[2] + inf * 2;
    if (p.kind === 'plane') {
      pushPlane(acc, i, bx, by, bz, p.size[0], p.size[1], p.uv[0], p.uv[1], uvW, uvH);
    } else {
      pushBox(acc, i, bx, by, bz, sx, sy, sz,
        p.uv[0], p.uv[1], p.size[0], p.size[1], p.size[2], uvW, uvH);
    }
    if (bx < minX) minX = bx;
    if (by < minY) minY = by;
    if (bz < minZ) minZ = bz;
    if (bx + sx > maxX) maxX = bx + sx;
    if (by + sy > maxY) maxY = by + sy;
    if (bz + sz > maxZ) maxZ = bz + sz;
  }

  const vertexCount = acc.count;
  const buffer = new ArrayBuffer(vertexCount * ENTITY_VERTEX_STRIDE);
  const f32 = new Float32Array(buffer);
  const u8 = new Uint8Array(buffer);
  const words = ENTITY_VERTEX_STRIDE / 4;
  for (let i = 0; i < vertexCount; i++) {
    const o = i * words;
    f32[o] = acc.pos[i * 3];
    f32[o + 1] = acc.pos[i * 3 + 1];
    f32[o + 2] = acc.pos[i * 3 + 2];
    f32[o + 3] = acc.nrm[i * 3];
    f32[o + 4] = acc.nrm[i * 3 + 1];
    f32[o + 5] = acc.nrm[i * 3 + 2];
    f32[o + 6] = acc.uv[i * 2];
    f32[o + 7] = acc.uv[i * 2 + 1];
    u8[i * ENTITY_VERTEX_STRIDE + 32] = acc.bone[i] & 255;
  }

  // Front-face unwrap rectangles of the head and the body, in model-UV pixels.
  const rectOf = (partName) => {
    const idx = boneIndex.has(partName) ? boneIndex.get(partName) : -1;
    if (idx < 0) return [0, 0, 0, 0];
    const p = parts[idx];
    return [p.uv[0] + p.size[2], p.uv[1] + p.size[2], p.size[0], p.size[1]];
  };

  const radius = def.radius !== undefined
    ? def.radius
    : Math.max(maxX - minX, maxY - minY, maxZ - minZ) * MODEL_UNIT * 0.75;

  MODEL_UID += 1;
  return {
    name,
    uid: MODEL_UID,
    def,
    parts,
    parentIndex,
    boneIndex,
    boneCount: parts.length,
    uvW,
    uvH,
    headRect: rectOf('head'),
    bodyRect: rectOf('body'),
    vertexData: buffer,
    vertexCount,
    indexData: new Uint16Array(acc.idx),
    indexCount: acc.idx.length,
    bounds: [minX, minY, minZ, maxX, maxY, maxZ],
    radius,
    height: def.height === undefined ? (maxY - minY) * MODEL_UNIT : def.height,
    width: def.width === undefined ? (maxX - minX) * MODEL_UNIT : def.width,
    billboard: !!def.billboard,
    vao: null,
    vbo: null,
    ibo: null,
  };
}

/* ========================================================================== */
/* Shared GLSL                                                                */
/* ========================================================================== */

/**
 * Minecraft-style light falloff shared by every entity shader. Identical to the
 * curve used by the terrain pass so a mob and the floor it stands on match.
 * @type {string}
 */
const LIGHT_CURVE_GLSL = `
const float VOX_LIGHT_FLOOR = 0.035184372088832;
const float VOX_LIGHT_NORM  = 1.0 / (1.0 - VOX_LIGHT_FLOOR);

vec3 entLightCurve(vec3 level01) {
  vec3 lv = clamp(level01, 0.0, 1.0) * 15.0;
  vec3 t = pow(vec3(0.8), vec3(15.0) - lv);
  return max((t - vec3(VOX_LIGHT_FLOOR)) * VOX_LIGHT_NORM, vec3(0.0));
}

float entLightCurve(float level01) {
  float lv = clamp(level01, 0.0, 1.0) * 15.0;
  float t = pow(0.8, 15.0 - lv);
  return max((t - VOX_LIGHT_FLOOR) * VOX_LIGHT_NORM, 0.0);
}
`;

/**
 * The four G-buffer outputs of ARCHITECTURE.md 3.2, declared identically in
 * every geometry shader of this module.
 * @type {string}
 */
const GBUFFER_OUTPUTS_GLSL = `
layout(location = 0) out vec4 o_albedo;
layout(location = 1) out vec4 o_normal;
layout(location = 2) out vec4 o_light;
layout(location = 3) out vec4 o_extra;
`;

/**
 * Per-face orthonormal basis for a unit cube, matching the face-direction
 * convention of 3.1 (`0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z`).
 * @type {string}
 */
const FACE_BASIS_GLSL = `
void entFaceBasis(int f, out vec3 n, out vec3 t, out vec3 b) {
  if (f == 0)      { n = vec3( 1.0, 0.0, 0.0); t = vec3(0.0, 0.0,-1.0); b = vec3(0.0,-1.0, 0.0); }
  else if (f == 1) { n = vec3(-1.0, 0.0, 0.0); t = vec3(0.0, 0.0, 1.0); b = vec3(0.0,-1.0, 0.0); }
  else if (f == 2) { n = vec3( 0.0, 1.0, 0.0); t = vec3(1.0, 0.0, 0.0); b = vec3(0.0, 0.0, 1.0); }
  else if (f == 3) { n = vec3( 0.0,-1.0, 0.0); t = vec3(1.0, 0.0, 0.0); b = vec3(0.0, 0.0,-1.0); }
  else if (f == 4) { n = vec3( 0.0, 0.0, 1.0); t = vec3(1.0, 0.0, 0.0); b = vec3(0.0,-1.0, 0.0); }
  else             { n = vec3( 0.0, 0.0,-1.0); t = vec3(-1.0,0.0, 0.0); b = vec3(0.0,-1.0, 0.0); }
}
`;

/* -------------------------------------------------------------------------- */
/* Skinned model                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader for every cube-skeletal model. One draw call per mob: the bone
 * index rides along in the vertex stream and `u_bones` carries the pose.
 * @type {string}
 */
const ENTITY_VS = `
#include <frame>

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
layout(location = 3) in uint a_bone;

uniform mat4 u_renderProj;
uniform mat4 u_model;
uniform mat4 u_bones[24];
uniform float u_jitterAmount;

out vec2 v_uv;
out vec3 v_worldPos;
out vec3 v_normal;

void main() {
  mat4 bone = u_bones[int(a_bone)];
  vec4 local = bone * vec4(a_position, 1.0);
  vec4 world = u_model * local;
  v_uv = a_uv;
  v_worldPos = world.xyz;
  v_normal = mat3(u_model) * (mat3(bone) * a_normal);
  vec4 clip = u_renderProj * world;
  clip.xy += u_jitter.xy * clip.w * u_jitterAmount;
  gl_Position = clip;
}
`;

/**
 * Fragment shader for skinned models. Writes the standard G-buffer contract;
 * when `u_depthOnly` is 1 it only performs the alpha test (shadow cascades).
 * @type {string}
 */
const ENTITY_FS = `
#include <frame>
#include <math>
#include <color>

uniform sampler2DArray u_skins;
uniform int u_skinLayer;
uniform int u_skinCount;
uniform int u_depthOnly;
uniform vec4 u_light;     // rgb block light levels 0..1, a = sky light 0..1
uniform vec4 u_overlay;   // rgb flash colour, a = flash amount
uniform vec4 u_material;  // x = alpha cutoff, y = emissive, z = subsurface, w = alpha

in vec2 v_uv;
in vec3 v_worldPos;
in vec3 v_normal;

${GBUFFER_OUTPUTS_GLSL}
${LIGHT_CURVE_GLSL}

void main() {
  vec4 skin = texture(u_skins, vec3(v_uv, float(u_skinLayer)));
  float alpha = skin.a * clamp(u_material.w, 0.0, 1.0);
  if (alpha < u_material.x) discard;

  if (u_depthOnly == 1) {
    o_albedo = vec4(0.0);
    o_normal = vec4(0.0);
    o_light = vec4(0.0);
    o_extra = vec4(0.0);
    return;
  }

  vec4 mrae = texture(u_skins, vec3(v_uv, float(u_skinLayer + u_skinCount)));
  vec3 albedo = srgbToLinear(skin.rgb);
  albedo = mix(albedo, u_overlay.rgb, saturate(u_overlay.a));

  vec3 N = safeNormalize(v_normal);
  if (!gl_FrontFacing) N = -N;

  float metallic = clamp(mrae.r, 0.0, 1.0);
  float roughness = clamp(mrae.g, 0.05, 1.0);
  float ao = clamp(mrae.b, 0.0, 1.0);
  float emissive = clamp(mrae.a + u_material.y, 0.0, 1.0);

  o_albedo = vec4(saturate(albedo), metallic);
  o_normal = vec4(N * 0.5 + 0.5, roughness);
  o_light = vec4(entLightCurve(u_light.rgb), entLightCurve(u_light.a));
  o_extra = vec4(ao, 0.0, emissive, clamp(u_material.z, 0.0, 1.0));
}
`;

/* -------------------------------------------------------------------------- */
/* Break (crack) overlay                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Procedural ten-stage crack field, shared by the cube shader.
 *
 * Twelve radial branches whose angular position and length are hashed per face
 * and per block, wiggled by a hash of the radius, plus two shorter fork layers
 * and a stage-driven speckle. `stage` (0.1 .. 1.0) grows the branch length and
 * widens the strokes, giving the familiar ten destroy stages with no texture.
 * @type {string}
 */
const CRACK_GLSL = `
float entCrackBranch(vec2 p, float seed, float stage) {
  float r = length(p);
  if (r < 0.02) return 1.0;
  float a = atan(p.y, p.x) / TAU + 0.5;

  const float BRANCHES = 12.0;
  float cell = floor(a * BRANCHES);
  float local = fract(a * BRANCHES) - 0.5;

  float jitter = hash21(vec2(cell, seed)) - 0.5;
  float len = 0.28 + 0.72 * hash21(vec2(cell + 17.0, seed));
  len *= stage * 1.15;

  float wig = (hash21(vec2(cell + 3.0, floor(r * 9.0) + seed)) - 0.5) * 0.36;
  float d = abs(local + jitter * 0.30 + wig * r);

  float width = (0.055 + 0.10 * stage) / max(r * BRANCHES * 0.8, 0.35);
  float stroke = 1.0 - smoothstep(width * 0.55, width, d);
  float reach = 1.0 - smoothstep(len * 0.85, len, r);
  return stroke * reach;
}

float entCrackMask(vec2 uv, float seed, float stage) {
  vec2 p = uv * 2.0 - 1.0;
  float m = entCrackBranch(p, seed, stage);
  m = max(m, entCrackBranch(p * 1.7 + vec2(0.21, -0.13), seed + 5.0, stage * 0.72) * 0.8);
  m = max(m, entCrackBranch(p * 2.6 - vec2(0.17, 0.29), seed + 11.0, stage * 0.5) * 0.6);
  float speckle = smoothstep(0.86 - stage * 0.30, 1.0, hash21(floor(uv * 32.0) + seed));
  return clamp(max(m, speckle * stage * 0.55), 0.0, 1.0);
}
`;

/* -------------------------------------------------------------------------- */
/* Textured cube (held blocks, dropped block items, block entities)           */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader for a unit cube whose faces sample the block texture arrays.
 * Positions live in `[0,1]^3` and are remapped by `u_boxMin`/`u_boxMax`, so the
 * same VAO also draws arbitrary block AABBs (used by the break overlay).
 * @type {string}
 */
const CUBE_VS = `
#include <frame>

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
layout(location = 3) in uint a_face;

uniform mat4 u_renderProj;
uniform mat4 u_model;
uniform vec3 u_boxMin;
uniform vec3 u_boxMax;
uniform float u_jitterAmount;
uniform float u_expand;

out vec2 v_uv;
out vec3 v_worldPos;
flat out int v_face;

void main() {
  vec3 local = mix(u_boxMin, u_boxMax, a_position) + a_normal * u_expand;
  vec4 world = u_model * vec4(local, 1.0);
  v_uv = a_uv;
  v_worldPos = world.xyz;
  v_face = int(a_face);
  vec4 clip = u_renderProj * world;
  clip.xy += u_jitter.xy * clip.w * u_jitterAmount;
  gl_Position = clip;
}
`;

/**
 * Fragment shader for textured block cubes: full PBR from the three block
 * texture arrays, tangent-space normal rebuilt from the cube face basis.
 * @type {string}
 */
const CUBE_FS = `
#include <frame>
#include <math>

uniform mat4 u_model;
uniform sampler2DArray u_albedoArray;
uniform sampler2DArray u_normalArray;
uniform sampler2DArray u_mraeArray;
uniform float u_faceLayer[6];
uniform vec3 u_tint;
uniform int u_depthOnly;
uniform vec4 u_light;
uniform vec4 u_overlay;
uniform vec4 u_material;
uniform float u_crackStage;

in vec2 v_uv;
in vec3 v_worldPos;
flat in int v_face;

${GBUFFER_OUTPUTS_GLSL}
${LIGHT_CURVE_GLSL}
${FACE_BASIS_GLSL}
${CRACK_GLSL}

void main() {
  int f = clamp(v_face, 0, 5);
  float layer = u_faceLayer[f];
  vec4 alb = texture(u_albedoArray, vec3(v_uv, layer));
  if (alb.a < u_material.x) discard;

  // Break overlay: multiplied straight onto the block's own faces, so the
  // G-buffer stays a single opaque write instead of a blended patch.
  float crack = 0.0;
  if (u_crackStage > 0.0) {
    float seed = float(f) * 7.0
               + floor(v_worldPos.x) * 3.0
               + floor(v_worldPos.y) * 11.0
               + floor(v_worldPos.z) * 23.0;
    crack = entCrackMask(v_uv, seed, clamp(u_crackStage, 0.0, 1.0));
    if (crack < 0.02) discard;
  }

  if (u_depthOnly == 1) {
    o_albedo = vec4(0.0);
    o_normal = vec4(0.0);
    o_light = vec4(0.0);
    o_extra = vec4(0.0);
    return;
  }

  vec3 n, t, b;
  entFaceBasis(f, n, t, b);
  vec3 nm = texture(u_normalArray, vec3(v_uv, layer)).xyz * 2.0 - 1.0;
  vec3 localN = normalize(t * nm.x + b * nm.y + n * max(nm.z, 0.05));
  vec3 N = normalize(mat3(u_model) * localN);
  if (!gl_FrontFacing) N = -N;

  vec4 mrae = texture(u_mraeArray, vec3(v_uv, layer));
  vec3 albedo = mix(alb.rgb * u_tint, u_overlay.rgb, saturate(u_overlay.a));
  float roughness = clamp(mrae.g, 0.05, 1.0);
  float ao = clamp(mrae.b, 0.0, 1.0);
  float emissive = clamp(mrae.a + u_material.y, 0.0, 1.0);

  if (crack > 0.0) {
    albedo *= mix(1.0, 0.10, crack);
    roughness = mix(roughness, 0.95, crack);
    ao = mix(ao, 0.35, crack);
    emissive *= 1.0 - crack;
  }

  o_albedo = vec4(saturate(albedo), clamp(mrae.r, 0.0, 1.0) * (1.0 - crack));
  o_normal = vec4(N * 0.5 + 0.5, roughness);
  o_light = vec4(entLightCurve(u_light.rgb), entLightCurve(u_light.a));
  o_extra = vec4(ao, 0.0, emissive, clamp(u_material.z, 0.0, 1.0));
}
`;

/* -------------------------------------------------------------------------- */
/* Extruded item sprite                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader for the sliced sprite used by flat items. The mesh is a stack of
 * `SPRITE_SLICES + 2` quads; the two caps carry `a_slice` 0.0 / 1.0 and the
 * interior slices 0.5, which the fragment stage uses to keep only the rim.
 * @type {string}
 */
const SPRITE_VS = `
#include <frame>

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in float a_slice;

uniform mat4 u_renderProj;
uniform mat4 u_model;
uniform float u_jitterAmount;

out vec2 v_uv;
out vec3 v_worldPos;
flat out float v_slice;

void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  v_uv = a_uv;
  v_worldPos = world.xyz;
  v_slice = a_slice;
  vec4 clip = u_renderProj * world;
  clip.xy += u_jitter.xy * clip.w * u_jitterAmount;
  gl_Position = clip;
}
`;

/**
 * Fragment shader for extruded item sprites.
 *
 * `u_spriteMode` selects the source: `0` reads this module's procedural item
 * icon array (unit 15, `r` = colour zone, `g` = shading, `b` = specular hint,
 * `a` = coverage), `1` reads a real block texture layer from the block albedo
 * array (unit 0) so non-cube blocks drop as flat sprites of their own texture.
 * The rim normal is rebuilt from the coverage gradient, which is exactly the
 * "extrude the icon from its alpha" trick.
 * @type {string}
 */
const SPRITE_FS = `
#include <frame>
#include <math>
#include <color>

uniform sampler2DArray u_icons;
uniform sampler2DArray u_albedoArray;
uniform mat4 u_model;
uniform int u_spriteMode;
uniform float u_spriteLayer;
uniform float u_texel;
uniform vec3 u_itemColors[3];
uniform vec3 u_tint;
uniform int u_depthOnly;
uniform vec4 u_light;
uniform vec4 u_overlay;
uniform vec4 u_material;

in vec2 v_uv;
in vec3 v_worldPos;
flat in float v_slice;

${GBUFFER_OUTPUTS_GLSL}
${LIGHT_CURVE_GLSL}

vec4 spriteFetch(vec2 uv) {
  if (u_spriteMode == 1) return texture(u_albedoArray, vec3(uv, u_spriteLayer));
  return texture(u_icons, vec3(uv, u_spriteLayer));
}

void main() {
  vec4 src = spriteFetch(v_uv);
  if (src.a < 0.5) discard;

  float aL = spriteFetch(v_uv + vec2(-u_texel, 0.0)).a;
  float aR = spriteFetch(v_uv + vec2( u_texel, 0.0)).a;
  float aD = spriteFetch(v_uv + vec2(0.0, -u_texel)).a;
  float aU = spriteFetch(v_uv + vec2(0.0,  u_texel)).a;
  float coverage = min(min(aL, aR), min(aD, aU));
  float edge = 1.0 - smoothstep(0.2, 0.8, coverage);

  bool isCap = (v_slice < 0.25 || v_slice > 0.75);
  if (!isCap && edge < 0.35) discard;

  if (u_depthOnly == 1) {
    o_albedo = vec4(0.0);
    o_normal = vec4(0.0);
    o_light = vec4(0.0);
    o_extra = vec4(0.0);
    return;
  }

  vec3 albedo;
  float metallic = 0.0;
  float roughness = 0.75;
  float ao = 1.0;
  float emissive = 0.0;

  if (u_spriteMode == 1) {
    albedo = src.rgb * u_tint;
    roughness = 0.8;
  } else {
    float zone = src.r;
    vec3 base = u_itemColors[0];
    if (zone > 0.66) base = u_itemColors[2];
    else if (zone > 0.33) base = u_itemColors[1];
    float shade = 0.55 + 0.75 * src.g;
    albedo = srgbToLinear(base) * shade;
    metallic = src.b * 0.9;
    roughness = mix(0.85, 0.18, src.b);
    ao = mix(0.65, 1.0, src.g);
  }
  albedo = mix(albedo, u_overlay.rgb, saturate(u_overlay.a));

  // Rim normal from the coverage gradient; the caps stay flat.
  vec2 grad = vec2(aR - aL, aU - aD);
  float faceSign = v_slice > 0.75 ? 1.0 : (v_slice < 0.25 ? -1.0 : 0.0);
  vec3 localN;
  if (isCap) {
    localN = normalize(vec3(-grad * edge * 1.2, faceSign));
  } else {
    localN = normalize(vec3(-grad, 0.0) + vec3(0.0, 0.0, 0.0001));
  }
  vec3 N = normalize(mat3(u_model) * localN);
  if (!gl_FrontFacing) N = -N;

  o_albedo = vec4(saturate(albedo), metallic);
  o_normal = vec4(N * 0.5 + 0.5, clamp(roughness, 0.05, 1.0));
  o_light = vec4(entLightCurve(u_light.rgb), entLightCurve(u_light.a));
  o_extra = vec4(ao, 0.0, clamp(emissive + u_material.y, 0.0, 1.0),
                 clamp(u_material.z, 0.0, 1.0));
}
`;

/* -------------------------------------------------------------------------- */
/* Block selection outline                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader for the selection wireframe. Lines cannot use
 * `POLYGON_OFFSET_FILL`, so the bias is applied straight to clip Z — a constant
 * pull toward the camera that is proportional to `w`, hence stable at any range.
 * @type {string}
 */
const OUTLINE_VS = `
layout(location = 0) in vec3 a_position;

uniform mat4 u_renderProj;
uniform float u_depthBias;

void main() {
  vec4 clip = u_renderProj * vec4(a_position, 1.0);
  clip.z -= u_depthBias * clip.w;
  gl_Position = clip;
}
`;

/**
 * Fragment shader for the selection wireframe.
 *
 * `u_forward == 1` writes a plain blended colour (for a forward pass over the
 * lit scene); otherwise it writes the G-buffer contract with a near-black,
 * fully rough albedo, which resolves to the same crisp dark line after lighting.
 * @type {string}
 */
const OUTLINE_FS = `
uniform vec4 u_color;
uniform int u_forward;

${GBUFFER_OUTPUTS_GLSL}

void main() {
  if (u_forward == 1) {
    o_albedo = u_color;
  } else {
    o_albedo = vec4(u_color.rgb, 0.0);
  }
  o_normal = vec4(0.5, 1.0, 0.5, 1.0);
  o_light = vec4(0.0, 0.0, 0.0, 0.0);
  o_extra = vec4(1.0, 0.0, 0.0, 0.0);
}
`;


/* -------------------------------------------------------------------------- */
/* Procedural mob skin generator                                              */
/* -------------------------------------------------------------------------- */

/**
 * Uber fragment shader that paints one mob skin layer.
 *
 * It runs once per skin at init time into two layers of the private skin array
 * (albedo + metallic/roughness/AO/emissive). Instead of hard-coding pixel
 * rectangles per mob it receives the model's own unwrap blocks as
 * `u_zoneRect[i]` with a semantic id in `u_zoneId[i]`
 * (`0` head, `1` body, `2` arm/wing, `3` leg/tentacle, `4` accessory, `5` other)
 * plus `u_headRect`, the head's front face — that is where the eyes go. Every
 * mob is therefore painted in the right place on any model geometry.
 *
 * @type {string}
 */
const SKIN_FS = `
#include <math>
#include <noise>

uniform int u_skin;
uniform vec2 u_uvSize;
uniform vec4 u_headRect;
uniform vec4 u_zoneRect[12];
uniform int u_zoneId[12];
uniform int u_zoneCount;
uniform float u_seed;

in vec2 v_uv;

layout(location = 0) out vec4 o_albedo;
layout(location = 1) out vec4 o_mrae;

float inBox(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c) - h;
  return (max(d.x, d.y) <= 0.0) ? 1.0 : 0.0;
}

int entZone(vec2 px, out vec2 zp) {
  zp = px / max(u_uvSize, vec2(1.0));
  for (int i = 0; i < 12; i++) {
    if (i >= u_zoneCount) break;
    vec4 r = u_zoneRect[i];
    if (r.z <= 0.0) continue;
    if (px.x >= r.x && px.x < r.x + r.z && px.y >= r.y && px.y < r.y + r.w) {
      zp = (px - r.xy) / max(r.zw, vec2(1.0));
      return u_zoneId[i];
    }
  }
  return 5;
}

/** Eyes + brow + mouth on the head's front face. Returns 0..3 feature id. */
int faceFeature(vec2 hp) {
  if (hp.x < 0.0 || hp.x > 1.0 || hp.y < 0.0 || hp.y > 1.0) return 0;
  float eyeL = inBox(hp, vec2(0.30, 0.44), vec2(0.105, 0.075));
  float eyeR = inBox(hp, vec2(0.70, 0.44), vec2(0.105, 0.075));
  if (eyeL + eyeR > 0.0) {
    float pupilL = inBox(hp, vec2(0.335, 0.45), vec2(0.055, 0.060));
    float pupilR = inBox(hp, vec2(0.665, 0.45), vec2(0.055, 0.060));
    return (pupilL + pupilR > 0.0) ? 2 : 1;
  }
  if (inBox(hp, vec2(0.5, 0.72), vec2(0.20, 0.045)) > 0.0) return 3;
  return 0;
}

void main() {
  vec2 px = vec2(v_uv.x, 1.0 - v_uv.y) * u_uvSize;
  vec2 zp;
  int zone = entZone(px, zp);
  vec2 hp = (px - u_headRect.xy) / max(u_headRect.zw, vec2(1.0));
  int feat = faceFeature(hp);

  float n1 = fbm3(vec3(px * 0.22, u_seed), 4) * 0.5 + 0.5;
  float n2 = fbm3(vec3(px * 0.75 + 31.0, u_seed * 1.7), 3) * 0.5 + 0.5;
  float n3 = hash21(floor(px) + u_seed);
  float cell = worley3(vec3(px * 0.30, u_seed * 0.5));

  vec3 col = vec3(0.7);
  float rough = 0.80;
  float metal = 0.0;
  float ao = 1.0;
  float emis = 0.0;
  float alpha = 1.0;

  if (u_skin == 0) {                                   // player
    vec3 skin = vec3(0.80, 0.60, 0.44) * (0.94 + 0.10 * n2);
    vec3 hair = vec3(0.26, 0.17, 0.10) * (0.85 + 0.30 * n2);
    if (zone == 0) { col = (zp.y < 0.30) ? hair : skin; if (hp.y < 0.22 && hp.x >= 0.0 && hp.x <= 1.0) col = hair; }
    else if (zone == 1) col = vec3(0.09, 0.60, 0.62) * (0.92 + 0.14 * n1);
    else if (zone == 2) col = (zp.y < 0.62) ? vec3(0.09, 0.60, 0.62) * (0.92 + 0.14 * n1) : skin;
    else if (zone == 3) col = (zp.y > 0.86) ? vec3(0.28, 0.26, 0.26) : vec3(0.22, 0.27, 0.56) * (0.90 + 0.18 * n1);
    else col = skin;
    rough = 0.72;
  } else if (u_skin == 1 || u_skin == 2 || u_skin == 3) {  // zombie / husk / drowned
    vec3 flesh = vec3(0.34, 0.55, 0.28);
    vec3 cloth = vec3(0.16, 0.24, 0.42);
    if (u_skin == 2) { flesh = vec3(0.60, 0.55, 0.36); cloth = vec3(0.72, 0.67, 0.48); }
    if (u_skin == 3) { flesh = vec3(0.27, 0.52, 0.47); cloth = vec3(0.17, 0.33, 0.36); }
    float rot = smoothstep(0.48, 0.70, n1);
    vec3 skin = mix(flesh, flesh * vec3(0.62, 0.72, 0.55), rot);
    skin *= 0.90 + 0.20 * n2;
    float torn = smoothstep(0.58, 0.78, fbm3(vec3(px * 0.16 + 7.0, u_seed), 3) * 0.5 + 0.5);
    if (zone == 0) col = skin;
    else if (zone == 1 || zone == 2 || zone == 3) col = mix(cloth * (0.88 + 0.22 * n1), skin, torn);
    else col = skin;
    if (feat == 1 || feat == 2) col = vec3(0.02, 0.03, 0.02);
    if (u_skin == 3 && (feat == 1 || feat == 2)) { col = vec3(0.30, 0.95, 1.0); emis = 0.9; }
    rough = (u_skin == 3) ? 0.32 : 0.88;
    ao = 0.85 + 0.15 * n2;
  } else if (u_skin == 4) {                            // skeleton
    float groove = smoothstep(0.35, 0.05, cell);
    col = mix(vec3(0.87, 0.86, 0.80), vec3(0.60, 0.58, 0.50), groove * 0.8);
    col *= 0.92 + 0.14 * n2;
    if (feat == 1 || feat == 2) col = vec3(0.02, 0.02, 0.02);
    if (feat == 3) col = vec3(0.28, 0.27, 0.24);
    rough = 0.70;
    ao = mix(1.0, 0.65, groove);
  } else if (u_skin == 5) {                            // creeper
    float blotch = smoothstep(0.44, 0.56, n1);
    col = mix(vec3(0.20, 0.46, 0.17), vec3(0.36, 0.72, 0.30), blotch);
    col *= 0.92 + 0.16 * n2;
    if (hp.x >= 0.0 && hp.x <= 1.0 && hp.y >= 0.0 && hp.y <= 1.0) {
      float eyes = max(inBox(hp, vec2(0.30, 0.34), vec2(0.115, 0.115)),
                       inBox(hp, vec2(0.70, 0.34), vec2(0.115, 0.115)));
      float mouth = inBox(hp, vec2(0.50, 0.62), vec2(0.115, 0.175));
      mouth = max(mouth, inBox(hp, vec2(0.32, 0.80), vec2(0.11, 0.12)));
      mouth = max(mouth, inBox(hp, vec2(0.68, 0.80), vec2(0.11, 0.12)));
      if (eyes + mouth > 0.0) col = vec3(0.015, 0.02, 0.015);
    }
    rough = 0.82;
  } else if (u_skin == 6) {                            // spider
    float hair = smoothstep(0.40, 0.75, n2);
    col = mix(vec3(0.11, 0.10, 0.10), vec3(0.22, 0.14, 0.12), hair);
    if (zone == 0) col = mix(col, vec3(0.30, 0.09, 0.07), 0.55);
    if (hp.x >= 0.0 && hp.x <= 1.0 && hp.y >= 0.0 && hp.y <= 1.0) {
      float e = 0.0;
      e = max(e, inBox(hp, vec2(0.28, 0.40), vec2(0.075, 0.075)));
      e = max(e, inBox(hp, vec2(0.72, 0.40), vec2(0.075, 0.075)));
      e = max(e, inBox(hp, vec2(0.40, 0.58), vec2(0.055, 0.055)));
      e = max(e, inBox(hp, vec2(0.60, 0.58), vec2(0.055, 0.055)));
      if (e > 0.0) { col = vec3(0.85, 0.10, 0.06); emis = 0.55; }
    }
    rough = 0.90;
  } else if (u_skin == 7) {                            // enderman
    col = vec3(0.030, 0.028, 0.038) * (0.7 + 0.8 * n2);
    float spark = smoothstep(0.965, 1.0, n3);
    col = mix(col, vec3(0.55, 0.25, 0.85), spark * 0.7);
    emis = spark * 0.5;
    if (feat == 1 || feat == 2) { col = vec3(0.85, 0.35, 1.0); emis = 1.0; }
    rough = 0.55;
  } else if (u_skin == 8 || u_skin == 9) {             // villager / witch
    vec3 robe = (u_skin == 9) ? vec3(0.30, 0.19, 0.36) : vec3(0.43, 0.30, 0.20);
    vec3 skin = (u_skin == 9) ? vec3(0.55, 0.62, 0.47) : vec3(0.74, 0.57, 0.44);
    if (zone == 0) col = skin * (0.94 + 0.10 * n2);
    else if (zone == 4) col = skin * 1.02;
    else if (zone == 1) col = mix(robe, robe * 0.7, step(0.55, zp.y)) * (0.92 + 0.14 * n1);
    else if (zone == 2) col = (zp.y < 0.55) ? robe * (0.92 + 0.14 * n1) : skin;
    else col = robe * 0.78 * (0.92 + 0.14 * n1);
    if (feat == 1) col = vec3(0.92, 0.92, 0.90);
    if (feat == 2) col = vec3(0.10, 0.08, 0.06);
    if (u_skin == 9 && zone == 0 && hp.y < 0.10) col = vec3(0.16, 0.09, 0.20);
    if (u_skin == 9 && smoothstep(0.86, 1.0, n3) > 0.0 && zone == 0) col *= 0.75;
    rough = 0.80;
  } else if (u_skin == 10) {                           // pig
    col = vec3(0.94, 0.62, 0.62) * (0.94 + 0.10 * n2);
    if (zone == 4) col = vec3(0.83, 0.46, 0.49);
    if (feat == 1 || feat == 2) col = vec3(0.05, 0.04, 0.04);
    rough = 0.78;
  } else if (u_skin == 11) {                           // cow
    float blotch = smoothstep(0.50, 0.58, fbm3(vec3(px * 0.13 + 3.0, u_seed), 4) * 0.5 + 0.5);
    col = mix(vec3(0.92, 0.90, 0.88), vec3(0.13, 0.11, 0.10), blotch);
    col *= 0.94 + 0.10 * n2;
    if (zone == 4) col = mix(vec3(0.86, 0.62, 0.60), vec3(0.88, 0.86, 0.80), 0.35);
    if (feat == 1 || feat == 2) col = vec3(0.04, 0.03, 0.03);
    rough = 0.80;
  } else if (u_skin == 12) {                           // sheep
    float curl = smoothstep(0.60, 0.10, cell);
    if (zone == 1) { col = mix(vec3(0.93, 0.92, 0.90), vec3(0.76, 0.75, 0.72), curl); ao = mix(1.0, 0.62, curl); rough = 0.95; }
    else { col = vec3(0.64, 0.56, 0.52) * (0.94 + 0.10 * n2); rough = 0.82; }
    if (feat == 1 || feat == 2) col = vec3(0.05, 0.04, 0.04);
  } else if (u_skin == 13) {                           // chicken
    col = vec3(0.94, 0.93, 0.90) * (0.93 + 0.12 * n2);
    if (zone == 3) col = vec3(0.95, 0.62, 0.15);
    if (zone == 4) col = (zp.y < 0.5) ? vec3(0.80, 0.14, 0.12) : vec3(0.96, 0.66, 0.12);
    if (feat == 1 || feat == 2) col = vec3(0.05, 0.04, 0.04);
    rough = 0.85;
  } else if (u_skin == 14) {                           // wolf
    float streak = smoothstep(0.45, 0.70, fbm3(vec3(px * vec2(0.9, 0.25) + 5.0, u_seed), 3) * 0.5 + 0.5);
    col = mix(vec3(0.66, 0.64, 0.61), vec3(0.42, 0.40, 0.38), streak);
    if (zone == 0 || zone == 4) col = mix(col, vec3(0.90, 0.89, 0.86), 0.45);
    if (feat == 1) col = vec3(0.90, 0.88, 0.84);
    if (feat == 2) col = vec3(0.08, 0.06, 0.05);
    rough = 0.92; ao = 0.88 + 0.12 * n2;
  } else if (u_skin == 15) {                           // cat
    float stripe = smoothstep(0.35, 0.65, sin(px.y * 0.9 + n1 * 3.0) * 0.5 + 0.5);
    col = mix(vec3(0.74, 0.46, 0.18), vec3(0.45, 0.26, 0.10), stripe);
    if (zone == 4) col = vec3(0.92, 0.88, 0.82);
    if (feat == 1) { col = vec3(0.55, 0.85, 0.35); emis = 0.20; }
    if (feat == 2) col = vec3(0.05, 0.05, 0.05);
    rough = 0.88;
  } else if (u_skin == 16) {                           // horse
    col = vec3(0.44, 0.27, 0.14) * (0.90 + 0.18 * n1);
    if (zone == 4 || zone == 1) col = mix(col, vec3(0.17, 0.11, 0.07), smoothstep(0.6, 0.9, n2) * 0.6);
    if (zone == 3 && zp.y > 0.80) col = vec3(0.12, 0.09, 0.07);
    if (feat == 1 || feat == 2) col = vec3(0.05, 0.04, 0.03);
    rough = 0.70;
  } else if (u_skin == 17) {                           // iron golem
    float plate = smoothstep(0.35, 0.65, n1);
    col = mix(vec3(0.58, 0.58, 0.56), vec3(0.72, 0.72, 0.70), plate);
    float rivet = smoothstep(0.94, 1.0, n3);
    col = mix(col, vec3(0.40, 0.40, 0.39), rivet);
    float vine = smoothstep(0.74, 0.90, fbm3(vec3(px * 0.5 + 13.0, u_seed), 3) * 0.5 + 0.5);
    col = mix(col, vec3(0.22, 0.42, 0.16), vine * 0.7);
    metal = 0.85 * (1.0 - vine);
    rough = mix(0.42, 0.85, vine);
    if (feat == 1 || feat == 2) { col = vec3(0.75, 0.30, 0.30); metal = 0.0; }
  } else if (u_skin == 18) {                           // bat
    col = vec3(0.23, 0.17, 0.19) * (0.85 + 0.30 * n2);
    if (zone == 2) col = vec3(0.34, 0.20, 0.22) * (0.85 + 0.25 * n1);
    if (feat == 1 || feat == 2) { col = vec3(0.85, 0.18, 0.14); emis = 0.35; }
    rough = 0.88;
  } else if (u_skin == 19) {                           // squid
    col = vec3(0.20, 0.22, 0.46) * (0.88 + 0.22 * n1);
    col = mix(col, vec3(0.32, 0.24, 0.48), smoothstep(0.55, 0.85, n2) * 0.6);
    if (feat == 1 || feat == 2) col = vec3(0.85, 0.85, 0.88);
    rough = 0.22; ao = 0.92;
  } else if (u_skin == 20) {                           // slime
    col = vec3(0.42, 0.82, 0.36) * (0.90 + 0.18 * n1);
    if (zone == 4) col = vec3(0.10, 0.16, 0.09);
    rough = 0.16; ao = 0.95;
  } else if (u_skin == 21) {                           // fox
    col = vec3(0.79, 0.43, 0.16) * (0.92 + 0.14 * n2);
    if (zone == 4) col = vec3(0.94, 0.92, 0.88);
    if (zone == 3) col = mix(col, vec3(0.14, 0.11, 0.10), smoothstep(0.35, 0.9, zp.y));
    if (feat == 1) col = vec3(0.92, 0.90, 0.85);
    if (feat == 2) col = vec3(0.06, 0.05, 0.04);
    rough = 0.90;
  } else if (u_skin == 22) {                           // rabbit
    col = vec3(0.58, 0.45, 0.33) * (0.92 + 0.14 * n2);
    if (zone == 4) col = mix(vec3(0.88, 0.66, 0.66), col, 0.35);
    if (zone == 3) col = mix(col, vec3(0.86, 0.82, 0.76), 0.4);
    if (feat == 1 || feat == 2) col = vec3(0.10, 0.06, 0.05);
    rough = 0.92;
  } else if (u_skin == 23) {                           // arrow
    if (zone == 4) { col = vec3(0.92, 0.92, 0.90); rough = 0.85; }
    else { col = vec3(0.46, 0.32, 0.18) * (0.9 + 0.2 * n2); rough = 0.75; }
    // The +Z end cap of the shaft's unwrap is the arrowhead: make it steel.
    if (zone == 1 && zp.x > 0.46 && zp.x < 0.51) {
      col = vec3(0.55, 0.56, 0.58); metal = 0.8; rough = 0.35;
    }
  } else {                                             // generic fallback
    float checker = mod(floor(px.x / 8.0) + floor(px.y / 8.0), 2.0);
    col = mix(vec3(0.72, 0.72, 0.74), vec3(0.52, 0.52, 0.56), checker);
    col = mix(col, vec3(0.70, 0.30, 0.65), smoothstep(0.80, 0.95, n1) * 0.5);
    rough = 0.80;
  }

  col *= 0.97 + 0.06 * n3;
  o_albedo = vec4(clamp(col, vec3(0.0), vec3(1.0)), alpha);
  o_mrae = vec4(clamp(metal, 0.0, 1.0), clamp(rough, 0.04, 1.0),
                clamp(ao, 0.0, 1.0), clamp(emis, 0.0, 1.0));
}
`;

/* -------------------------------------------------------------------------- */
/* Procedural item icon generator                                             */
/* -------------------------------------------------------------------------- */

/**
 * Ordered item icon patterns. The index is the layer in the icon array and the
 * value of `u_pattern` in {@link ITEM_FS}.
 * @type {ReadonlyArray<string>}
 */
export const ITEM_PATTERNS = Object.freeze([
  'generic', 'sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'stick', 'ingot',
  'nugget', 'gem', 'dust', 'rod', 'bow', 'arrow', 'bucket', 'apple', 'bread',
  'meat', 'fish', 'seed', 'egg', 'bone', 'helmet', 'chestplate', 'leggings',
  'boots', 'bottle', 'book', 'paper', 'shears', 'shield', 'torch', 'orb',
]);

/** Pattern name -> layer index. @type {Map<string, number>} */
const ITEM_PATTERN_INDEX = new Map();
for (let i = 0; i < ITEM_PATTERNS.length; i++) ITEM_PATTERN_INDEX.set(ITEM_PATTERNS[i], i);

/**
 * Fallback palettes, one `[zone0, zone1, zone2]` triple per pattern, used when
 * `items.js` does not supply `itemIcon().colors`.
 * @type {Object<string, number[][]>}
 */
const ITEM_PATTERN_COLORS = {
  generic: [[0.72, 0.72, 0.76], [0.45, 0.45, 0.50], [0.85, 0.62, 0.20]],
  sword: [[0.80, 0.82, 0.86], [0.45, 0.31, 0.17], [0.62, 0.50, 0.22]],
  pickaxe: [[0.80, 0.82, 0.86], [0.45, 0.31, 0.17], [0.62, 0.50, 0.22]],
  axe: [[0.80, 0.82, 0.86], [0.45, 0.31, 0.17], [0.62, 0.50, 0.22]],
  shovel: [[0.80, 0.82, 0.86], [0.45, 0.31, 0.17], [0.62, 0.50, 0.22]],
  hoe: [[0.80, 0.82, 0.86], [0.45, 0.31, 0.17], [0.62, 0.50, 0.22]],
  stick: [[0.52, 0.36, 0.18], [0.38, 0.25, 0.12], [0.62, 0.45, 0.24]],
  ingot: [[0.86, 0.86, 0.90], [0.62, 0.62, 0.66], [0.95, 0.95, 0.98]],
  nugget: [[0.95, 0.82, 0.30], [0.72, 0.58, 0.18], [1.00, 0.92, 0.55]],
  gem: [[0.42, 0.90, 0.88], [0.20, 0.62, 0.66], [0.80, 0.98, 0.98]],
  dust: [[0.85, 0.12, 0.12], [0.55, 0.06, 0.06], [1.00, 0.35, 0.30]],
  rod: [[0.95, 0.68, 0.12], [0.62, 0.38, 0.05], [1.00, 0.90, 0.45]],
  bow: [[0.55, 0.38, 0.20], [0.86, 0.84, 0.78], [0.35, 0.24, 0.12]],
  arrow: [[0.62, 0.62, 0.66], [0.52, 0.36, 0.18], [0.92, 0.92, 0.90]],
  bucket: [[0.78, 0.79, 0.82], [0.52, 0.53, 0.56], [0.30, 0.55, 0.90]],
  apple: [[0.86, 0.16, 0.12], [0.35, 0.60, 0.20], [0.45, 0.30, 0.15]],
  bread: [[0.78, 0.55, 0.25], [0.56, 0.36, 0.14], [0.92, 0.74, 0.42]],
  meat: [[0.78, 0.30, 0.28], [0.92, 0.80, 0.74], [0.55, 0.18, 0.16]],
  fish: [[0.62, 0.68, 0.75], [0.35, 0.42, 0.52], [0.88, 0.60, 0.45]],
  seed: [[0.55, 0.68, 0.28], [0.38, 0.48, 0.18], [0.80, 0.85, 0.50]],
  egg: [[0.92, 0.88, 0.78], [0.72, 0.66, 0.52], [0.55, 0.45, 0.32]],
  bone: [[0.92, 0.90, 0.84], [0.70, 0.68, 0.60], [0.98, 0.97, 0.94]],
  helmet: [[0.78, 0.79, 0.82], [0.52, 0.53, 0.56], [0.30, 0.32, 0.36]],
  chestplate: [[0.78, 0.79, 0.82], [0.52, 0.53, 0.56], [0.30, 0.32, 0.36]],
  leggings: [[0.78, 0.79, 0.82], [0.52, 0.53, 0.56], [0.30, 0.32, 0.36]],
  boots: [[0.78, 0.79, 0.82], [0.52, 0.53, 0.56], [0.30, 0.32, 0.36]],
  bottle: [[0.70, 0.86, 0.92], [0.45, 0.62, 0.70], [0.85, 0.55, 0.20]],
  book: [[0.68, 0.28, 0.20], [0.92, 0.90, 0.82], [0.85, 0.72, 0.25]],
  paper: [[0.94, 0.94, 0.90], [0.76, 0.76, 0.70], [0.60, 0.60, 0.55]],
  shears: [[0.82, 0.83, 0.86], [0.35, 0.36, 0.40], [0.55, 0.56, 0.60]],
  shield: [[0.52, 0.36, 0.18], [0.72, 0.73, 0.76], [0.80, 0.20, 0.18]],
  torch: [[0.52, 0.36, 0.18], [0.98, 0.78, 0.30], [1.00, 0.55, 0.10]],
  orb: [[0.55, 0.95, 0.35], [0.25, 0.70, 0.20], [0.95, 1.00, 0.70]],
};

/**
 * Uber fragment shader that paints one 16x16 item icon.
 *
 * The icons are pure signed-distance art evaluated on a quantised 16x16 grid, so
 * they read as crisp pixel sprites. The output is a *material* image, not a
 * finished colour: `r` picks one of three tint zones, `g` is the baked
 * bevel/shading, `b` is the metal hint and `a` the coverage that
 * {@link SPRITE_FS} extrudes into a solid 3D sprite.
 *
 * @type {string}
 */
const ITEM_FS = `
#include <math>

uniform int u_pattern;
uniform float u_seed;

in vec2 v_uv;

layout(location = 0) out vec4 o_icon;

float sdBox(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c) - h;
  return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0);
}

float sdSeg(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1.0e-5), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdCircle(vec2 p, vec2 c, float r) { return length(p - c) - r; }

float sdRing(vec2 p, vec2 c, float r, float t) { return abs(length(p - c) - r) - t; }

void main() {
  // Quantise to a 16x16 grid: crisp pixel-art icons at any texture resolution.
  vec2 p = floor(vec2(v_uv.x, 1.0 - v_uv.y) * 16.0) + 0.5;

  float dA = 1.0e5;
  float dB = 1.0e5;
  float dC = 1.0e5;
  float spec = 0.0;

  if (u_pattern == 1) {                                   // sword
    dA = sdSeg(p, vec2(5.5, 10.5), vec2(12.5, 3.5), 1.0);
    dB = min(sdSeg(p, vec2(2.5, 13.5), vec2(5.0, 11.0), 0.85),
             sdSeg(p, vec2(3.2, 9.8), vec2(6.8, 13.4), 0.75));
    spec = 0.85;
  } else if (u_pattern == 2) {                            // pickaxe
    dA = min(sdSeg(p, vec2(3.0, 5.0), vec2(13.0, 5.0), 0.95),
             min(sdSeg(p, vec2(3.0, 5.0), vec2(4.5, 3.0), 0.85),
                 sdSeg(p, vec2(13.0, 5.0), vec2(11.5, 3.0), 0.85)));
    dB = sdSeg(p, vec2(8.0, 5.5), vec2(3.5, 13.5), 0.85);
    spec = 0.85;
  } else if (u_pattern == 3) {                            // axe
    dA = min(sdBox(p, vec2(10.0, 5.0), vec2(2.6, 2.6)),
             sdSeg(p, vec2(7.4, 3.0), vec2(7.4, 8.0), 1.0));
    dB = sdSeg(p, vec2(8.5, 6.0), vec2(3.5, 13.5), 0.85);
    spec = 0.85;
  } else if (u_pattern == 4) {                            // shovel
    dA = sdBox(p, vec2(11.0, 4.5), vec2(2.2, 2.6));
    dB = sdSeg(p, vec2(10.0, 6.0), vec2(3.5, 13.5), 0.85);
    spec = 0.85;
  } else if (u_pattern == 5) {                            // hoe
    dA = min(sdBox(p, vec2(10.5, 3.8), vec2(3.0, 1.2)), sdBox(p, vec2(8.0, 4.6), vec2(0.9, 1.6)));
    dB = sdSeg(p, vec2(8.5, 5.5), vec2(3.5, 13.5), 0.85);
    spec = 0.85;
  } else if (u_pattern == 6) {                            // stick
    dA = sdSeg(p, vec2(11.5, 3.5), vec2(4.5, 12.5), 0.95);
  } else if (u_pattern == 7) {                            // ingot
    dA = sdBox(p, vec2(8.0, 8.5), vec2(4.6, 2.4));
    dB = sdBox(p, vec2(8.0, 6.6), vec2(3.4, 0.9));
    spec = 0.95;
  } else if (u_pattern == 8) {                            // nugget
    dA = sdCircle(p, vec2(8.0, 8.5), 3.1);
    dC = sdCircle(p, vec2(6.9, 7.2), 1.1);
    spec = 0.95;
  } else if (u_pattern == 9) {                            // gem
    dA = max(sdBox(p, vec2(8.0, 8.0), vec2(4.2, 4.2)),
             -sdBox(p - vec2(8.0, 8.0), vec2(0.0, 6.0), vec2(6.0, 1.2)));
    dA = min(dA, sdCircle(p, vec2(8.0, 8.0), 3.6));
    dC = sdCircle(p, vec2(6.7, 6.6), 1.2);
    spec = 0.55;
  } else if (u_pattern == 10) {                           // dust
    float h = hash21(floor(p) + u_seed);
    dA = sdCircle(p, vec2(8.0, 8.5), 4.2) + (h - 0.5) * 1.6;
    dC = sdCircle(p, vec2(6.6, 6.8), 1.0);
  } else if (u_pattern == 11) {                           // rod
    dA = sdSeg(p, vec2(11.5, 3.0), vec2(4.5, 13.0), 1.15);
    dC = sdCircle(p, vec2(11.0, 4.0), 1.3);
  } else if (u_pattern == 12) {                           // bow
    dA = max(sdRing(p, vec2(4.5, 8.0), 7.0, 0.85), -sdBox(p, vec2(1.0, 8.0), vec2(6.0, 9.0)));
    dB = sdSeg(p, vec2(10.6, 2.4), vec2(10.6, 13.6), 0.45);
    dC = sdSeg(p, vec2(4.0, 8.0), vec2(10.6, 8.0), 0.45);
  } else if (u_pattern == 13) {                           // arrow
    dA = min(sdSeg(p, vec2(12.0, 3.0), vec2(10.0, 5.0), 1.2), sdCircle(p, vec2(11.6, 3.6), 1.5));
    dB = sdSeg(p, vec2(11.0, 4.5), vec2(4.0, 12.0), 0.55);
    dC = min(sdSeg(p, vec2(4.5, 11.0), vec2(2.5, 13.5), 0.9),
             sdSeg(p, vec2(6.0, 12.5), vec2(3.5, 14.5), 0.9));
    spec = 0.7;
  } else if (u_pattern == 14) {                           // bucket
    dA = max(sdBox(p, vec2(8.0, 10.0), vec2(4.4, 3.6)), -sdBox(p, vec2(8.0, 6.2), vec2(3.2, 1.0)));
    dB = sdRing(p, vec2(8.0, 6.6), 4.2, 0.5);
    dC = sdBox(p, vec2(8.0, 7.4), vec2(3.2, 0.9));
    spec = 0.9;
  } else if (u_pattern == 15) {                           // apple
    dA = sdCircle(p, vec2(8.0, 9.2), 4.4);
    dB = sdSeg(p, vec2(8.0, 5.0), vec2(9.6, 2.8), 0.9);
    dC = sdCircle(p, vec2(6.4, 7.6), 1.0);
  } else if (u_pattern == 16) {                           // bread
    dA = sdBox(p, vec2(8.0, 8.5), vec2(5.0, 3.0));
    dB = min(sdSeg(p, vec2(5.5, 6.6), vec2(6.5, 10.4), 0.4),
             sdSeg(p, vec2(9.0, 6.6), vec2(10.0, 10.4), 0.4));
  } else if (u_pattern == 17) {                           // meat
    dA = sdCircle(p, vec2(8.0, 9.0), 4.4);
    dB = sdRing(p, vec2(8.0, 9.0), 4.2, 0.7);
    dC = sdCircle(p, vec2(6.5, 7.5), 1.1);
  } else if (u_pattern == 18) {                           // fish
    dA = max(sdCircle(p, vec2(7.5, 8.0), 4.6), -sdBox(p, vec2(13.0, 8.0), vec2(3.0, 8.0)));
    dC = min(sdSeg(p, vec2(11.0, 8.0), vec2(14.0, 5.0), 0.7),
             sdSeg(p, vec2(11.0, 8.0), vec2(14.0, 11.0), 0.7));
    dB = sdCircle(p, vec2(5.5, 6.8), 0.9);
  } else if (u_pattern == 19) {                           // seed
    dA = min(sdCircle(p, vec2(6.5, 9.5), 1.7), sdCircle(p, vec2(9.6, 7.4), 1.7));
    dB = sdCircle(p, vec2(9.0, 11.0), 1.4);
  } else if (u_pattern == 20) {                           // egg
    dA = sdCircle(p * vec2(1.0, 0.82) + vec2(0.0, 1.6), vec2(8.0, 8.4), 4.0);
    dB = sdCircle(p, vec2(9.6, 10.4), 1.2);
  } else if (u_pattern == 21) {                           // bone
    dA = sdSeg(p, vec2(4.0, 12.0), vec2(12.0, 4.0), 1.1);
    dC = min(min(sdCircle(p, vec2(3.4, 12.8), 1.5), sdCircle(p, vec2(5.0, 13.4), 1.4)),
             min(sdCircle(p, vec2(12.6, 3.2), 1.5), sdCircle(p, vec2(11.0, 2.6), 1.4)));
  } else if (u_pattern == 22) {                           // helmet
    dA = max(sdRing(p, vec2(8.0, 9.0), 4.6, 1.5), -sdBox(p, vec2(8.0, 14.0), vec2(9.0, 2.0)));
    dC = sdBox(p, vec2(8.0, 9.6), vec2(2.6, 1.0));
    spec = 0.9;
  } else if (u_pattern == 23) {                           // chestplate
    dA = max(sdBox(p, vec2(8.0, 9.0), vec2(4.8, 4.4)), -sdBox(p, vec2(8.0, 4.0), vec2(1.8, 1.6)));
    dC = sdBox(p, vec2(8.0, 9.4), vec2(1.0, 3.6));
    spec = 0.9;
  } else if (u_pattern == 24) {                           // leggings
    dA = min(sdBox(p, vec2(5.6, 10.0), vec2(2.0, 4.4)), sdBox(p, vec2(10.4, 10.0), vec2(2.0, 4.4)));
    dA = min(dA, sdBox(p, vec2(8.0, 5.6), vec2(4.4, 1.6)));
    spec = 0.9;
  } else if (u_pattern == 25) {                           // boots
    dA = min(max(sdBox(p, vec2(5.6, 10.4), vec2(2.0, 3.4)), -sdBox(p, vec2(3.0, 8.0), vec2(1.0, 3.0))),
             sdBox(p, vec2(10.4, 10.4), vec2(2.0, 3.4)));
    dC = sdBox(p, vec2(8.0, 13.4), vec2(5.0, 1.0));
    spec = 0.9;
  } else if (u_pattern == 26) {                           // bottle
    dA = sdCircle(p, vec2(8.0, 10.4), 3.6);
    dB = sdBox(p, vec2(8.0, 5.2), vec2(1.3, 2.6));
    dC = sdBox(p, vec2(8.0, 2.8), vec2(1.8, 0.9));
  } else if (u_pattern == 27) {                           // book
    dA = sdBox(p, vec2(8.0, 8.0), vec2(4.6, 5.2));
    dB = sdBox(p, vec2(9.0, 8.0), vec2(3.2, 4.4));
    dC = sdBox(p, vec2(4.0, 8.0), vec2(0.9, 5.2));
  } else if (u_pattern == 28) {                           // paper
    dA = sdBox(p, vec2(8.0, 8.0), vec2(4.2, 5.0));
    dB = min(sdSeg(p, vec2(5.2, 6.4), vec2(10.8, 6.4), 0.35),
             min(sdSeg(p, vec2(5.2, 8.4), vec2(10.8, 8.4), 0.35),
                 sdSeg(p, vec2(5.2, 10.4), vec2(9.0, 10.4), 0.35)));
  } else if (u_pattern == 29) {                           // shears
    dA = min(sdSeg(p, vec2(5.0, 3.0), vec2(9.5, 9.5), 0.85),
             sdSeg(p, vec2(11.0, 3.0), vec2(6.5, 9.5), 0.85));
    dB = min(sdRing(p, vec2(6.0, 12.2), 2.0, 0.6), sdRing(p, vec2(10.0, 12.2), 2.0, 0.6));
    spec = 0.9;
  } else if (u_pattern == 30) {                           // shield
    dA = max(sdBox(p, vec2(8.0, 7.4), vec2(4.6, 4.4)), sdCircle(p, vec2(8.0, 5.0), 9.6));
    dB = sdBox(p, vec2(8.0, 7.4), vec2(3.4, 3.2));
    dC = sdBox(p, vec2(8.0, 7.4), vec2(1.0, 3.2));
  } else if (u_pattern == 31) {                           // torch
    dA = sdSeg(p, vec2(8.0, 14.0), vec2(8.0, 7.0), 1.0);
    dB = sdCircle(p, vec2(8.0, 5.4), 1.9);
    dC = sdCircle(p, vec2(8.0, 4.6), 1.1);
  } else if (u_pattern == 32) {                           // xp orb
    dA = sdCircle(p, vec2(8.0, 8.0), 4.2);
    dB = sdRing(p, vec2(8.0, 8.0), 3.6, 0.8);
    dC = sdCircle(p, vec2(6.6, 6.6), 1.3);
  } else {                                                // generic
    dA = sdBox(p, vec2(8.0, 8.0), vec2(4.4, 4.4));
    dB = sdRing(p, vec2(8.0, 8.0), 3.4, 0.8);
    dC = sdCircle(p, vec2(8.0, 8.0), 1.4);
  }

  float d = min(dA, min(dB, dC));
  float alpha = (d <= 0.0) ? 1.0 : 0.0;

  float zone = 0.0;
  if (dB <= dA && dB <= dC) zone = 0.5;
  if (dC < dA && dC < dB) zone = 1.0;

  float bevel = smoothstep(0.0, 2.2, -d);
  float grain = hash21(floor(p) * 1.7 + u_seed) * 0.12;
  float shade = clamp(0.24 + 0.52 * bevel + 0.34 * (1.0 - p.y / 16.0) + grain, 0.0, 1.0);

  o_icon = vec4(zone, shade, spec * alpha, alpha);
}
`;

/* ========================================================================== */
/* Pose & animation                                                           */
/* ========================================================================== */

/**
 * Write `T(pivot + translation) * Rz * Ry * Rx * S * T(-pivot)` into a bone slot.
 *
 * @param {Float32Array} out destination matrix array
 * @param {number} o element offset of the 16-float slot
 * @param {number} px pivot X
 * @param {number} py pivot Y
 * @param {number} pz pivot Z
 * @param {number} rx rotation about X in radians
 * @param {number} ry rotation about Y in radians
 * @param {number} rz rotation about Z in radians
 * @param {number} sx scale X
 * @param {number} sy scale Y
 * @param {number} sz scale Z
 * @param {number} tx extra translation X
 * @param {number} ty extra translation Y
 * @param {number} tz extra translation Z
 * @returns {void}
 */
function composeBone(out, o, px, py, pz, rx, ry, rz, sx, sy, sz, tx, ty, tz) {
  const cx = Math.cos(rx); const sxr = Math.sin(rx);
  const cy = Math.cos(ry); const syr = Math.sin(ry);
  const cz = Math.cos(rz); const szr = Math.sin(rz);

  const m00 = cz * cy;
  const m01 = cz * syr * sxr - szr * cx;
  const m02 = cz * syr * cx + szr * sxr;
  const m10 = szr * cy;
  const m11 = szr * syr * sxr + cz * cx;
  const m12 = szr * syr * cx - cz * sxr;
  const m20 = -syr;
  const m21 = cy * sxr;
  const m22 = cy * cx;

  out[o] = m00 * sx; out[o + 1] = m10 * sx; out[o + 2] = m20 * sx; out[o + 3] = 0;
  out[o + 4] = m01 * sy; out[o + 5] = m11 * sy; out[o + 6] = m21 * sy; out[o + 7] = 0;
  out[o + 8] = m02 * sz; out[o + 9] = m12 * sz; out[o + 10] = m22 * sz; out[o + 11] = 0;
  out[o + 12] = px + tx - (m00 * sx * px + m01 * sy * py + m02 * sz * pz);
  out[o + 13] = py + ty - (m10 * sx * px + m11 * sy * py + m12 * sz * pz);
  out[o + 14] = pz + tz - (m20 * sx * px + m21 * sy * py + m22 * sz * pz);
  out[o + 15] = 1;
}

/**
 * `dst[od..] = a[oa..] * b[ob..]` for column-major 4x4 matrices, allocation free.
 *
 * @param {Float32Array} dst destination array
 * @param {number} od destination element offset
 * @param {Float32Array} a left operand array
 * @param {number} oa left operand element offset
 * @param {Float32Array} b right operand array
 * @param {number} ob right operand element offset
 * @returns {void}
 */
function mulBone(dst, od, a, oa, b, ob) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[ob + c * 4];
    const b1 = b[ob + c * 4 + 1];
    const b2 = b[ob + c * 4 + 2];
    const b3 = b[ob + c * 4 + 3];
    dst[od + c * 4] = a[oa] * b0 + a[oa + 4] * b1 + a[oa + 8] * b2 + a[oa + 12] * b3;
    dst[od + c * 4 + 1] = a[oa + 1] * b0 + a[oa + 5] * b1 + a[oa + 9] * b2 + a[oa + 13] * b3;
    dst[od + c * 4 + 2] = a[oa + 2] * b0 + a[oa + 6] * b1 + a[oa + 10] * b2 + a[oa + 14] * b3;
    dst[od + c * 4 + 3] = a[oa + 3] * b0 + a[oa + 7] * b1 + a[oa + 11] * b2 + a[oa + 15] * b3;
  }
}

/**
 * A reusable animation pose: per-bone euler rotation, translation, scale and a
 * hidden flag, plus the resolved hierarchical bone matrices.
 */
class Pose {
  constructor() {
    /** @type {Float32Array} per-bone `[rx,ry,rz]`. */
    this.rot = new Float32Array(MAX_BONES * 3);
    /** @type {Float32Array} per-bone extra translation. */
    this.pos = new Float32Array(MAX_BONES * 3);
    /** @type {Float32Array} per-bone scale. */
    this.scale = new Float32Array(MAX_BONES * 3);
    /** @type {Float32Array} resolved model-space bone matrices. */
    this.bones = new Float32Array(MAX_BONES * 16);
    /** @type {Float32Array} scratch for one local matrix. */
    this._local = new Float32Array(16);
    /** @type {?Object} model this pose was reset for. */
    this.model = null;
    for (let i = 0; i < MAX_BONES * 16; i += 16) this.bones[i] = this.bones[i + 5] = this.bones[i + 10] = this.bones[i + 15] = 1;
  }

  /**
   * Reset every bone to the model's rest pose.
   * @param {Object} model compiled model
   * @returns {void}
   */
  reset(model) {
    this.model = model;
    const parts = model.parts;
    for (let i = 0; i < parts.length; i++) {
      const r = parts[i].rot;
      this.rot[i * 3] = r[0];
      this.rot[i * 3 + 1] = r[1];
      this.rot[i * 3 + 2] = r[2];
      this.pos[i * 3] = 0;
      this.pos[i * 3 + 1] = 0;
      this.pos[i * 3 + 2] = 0;
      this.scale[i * 3] = 1;
      this.scale[i * 3 + 1] = 1;
      this.scale[i * 3 + 2] = 1;
    }
  }

  /**
   * Bone index of a part name.
   * @param {string} name part name
   * @returns {number} index, or -1
   */
  bone(name) {
    const m = this.model;
    if (!m) return -1;
    const i = m.boneIndex.get(name);
    return i === undefined ? -1 : i;
  }

  /**
   * Add euler rotation to a bone.
   * @param {string} name part name
   * @param {number} x radians about X
   * @param {number} y radians about Y
   * @param {number} z radians about Z
   * @returns {void}
   */
  rotate(name, x, y, z) {
    const i = this.bone(name);
    if (i < 0) return;
    this.rot[i * 3] += x;
    this.rot[i * 3 + 1] += y;
    this.rot[i * 3 + 2] += z;
  }

  /**
   * Add a translation (model units) to a bone.
   * @param {string} name part name
   * @param {number} x offset X
   * @param {number} y offset Y
   * @param {number} z offset Z
   * @returns {void}
   */
  translate(name, x, y, z) {
    const i = this.bone(name);
    if (i < 0) return;
    this.pos[i * 3] += x;
    this.pos[i * 3 + 1] += y;
    this.pos[i * 3 + 2] += z;
  }

  /**
   * Multiply a bone's scale.
   * @param {string} name part name
   * @param {number} x scale X
   * @param {number} y scale Y
   * @param {number} z scale Z
   * @returns {void}
   */
  scaleBone(name, x, y, z) {
    const i = this.bone(name);
    if (i < 0) return;
    this.scale[i * 3] *= x;
    this.scale[i * 3 + 1] *= y;
    this.scale[i * 3 + 2] *= z;
  }

  /**
   * Collapse a bone (and therefore its geometry) to nothing.
   * @param {string} name part name
   * @returns {void}
   */
  hide(name) {
    const i = this.bone(name);
    if (i < 0) return;
    this.scale[i * 3] = 0;
    this.scale[i * 3 + 1] = 0;
    this.scale[i * 3 + 2] = 0;
  }

  /**
   * Resolve the hierarchy into {@link Pose#bones}.
   * @returns {Float32Array} the bone matrices
   */
  build() {
    const model = this.model;
    if (!model) return this.bones;
    const parts = model.parts;
    const parent = model.parentIndex;
    const local = this._local;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const o = i * 16;
      composeBone(local, 0,
        p.pivot[0], p.pivot[1], p.pivot[2],
        this.rot[i * 3], this.rot[i * 3 + 1], this.rot[i * 3 + 2],
        this.scale[i * 3], this.scale[i * 3 + 1], this.scale[i * 3 + 2],
        this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      const pi = parent[i];
      if (pi < 0) {
        for (let k = 0; k < 16; k++) this.bones[o + k] = local[k];
      } else {
        mulBone(this.bones, o, this.bones, pi * 16, local, 0);
      }
    }
    return this.bones;
  }
}

/**
 * Per-entity animation memory: smoothed gait, look-at, light probe and the
 * accumulated phases that make motion continuous between the 20 Hz ticks.
 * @returns {Object} a fresh state record
 */
function newAnimState() {
  return {
    walkPhase: 0,
    limbAmount: 0,
    speed: 0,
    idle: Math.random() * 100,
    headYaw: 0,
    headPitch: 0,
    bodyYaw: 0,
    swing: 0,
    swingActive: false,
    spin: Math.random() * Math.PI * 2,
    lastX: 0,
    lastY: 0,
    lastZ: 0,
    hasLast: false,
    lastFrame: -1,
    light: new Float32Array([0.0, 0.0, 0.0, 1.0]),
    lightReady: false,
    lightTimer: 0,
  };
}

/**
 * Wrap an angle into `[-PI, PI]`.
 * @param {number} a angle in radians
 * @returns {number} wrapped angle
 */
function wrapAngle(a) {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/**
 * Read a numeric field from the first object that has it.
 * @param {Object} obj source object
 * @param {string[]} names candidate field names
 * @param {number} fallback value when none is present
 * @returns {number} the value
 */
function numField(obj, names, fallback) {
  if (!obj) return fallback;
  for (let i = 0; i < names.length; i++) {
    const v = obj[names[i]];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}

/**
 * Drives the bone pose of one entity from its gameplay state.
 *
 * Every profile is written against the part names of {@link MODELS}; a missing
 * part is simply skipped, so a custom model registered through
 * {@link EntityRenderer#registerModel} animates as far as its naming matches.
 */
class EntityAnimator {
  constructor() {
    /** @type {WeakMap<Object, Object>} per-entity animation memory. */
    this.states = new WeakMap();
    /** Extra per-entity render parameters produced by the last {@link EntityAnimator#animate}. */
    this.result = {
      bodyYaw: 0,
      deathAngle: 0,
      hurtTilt: 0,
      overlay: new Float32Array(4),
      scale: 1,
      emissive: 0,
      subsurface: 0,
      yOffset: 0,
    };
  }

  /**
   * Fetch (or create) the animation memory of an entity.
   * @param {Object} entity entity or player
   * @returns {Object} state record
   */
  state(entity) {
    let st = this.states.get(entity);
    if (st === undefined) {
      st = newAnimState();
      this.states.set(entity, st);
    }
    return st;
  }

  /**
   * Pose one entity.
   *
   * The same entity is posed several times per frame (once per shadow cascade
   * and once for the G-buffer). Only the first visit of a frame advances the
   * state: later visits run with `dt = 0`, which leaves every phase, damped
   * value and light probe untouched and therefore reproduces the *identical*
   * pose — so a mob's shadow always matches the mob.
   *
   * @param {Object} model compiled model
   * @param {Object} visual entry from {@link ENTITY_VISUALS}
   * @param {Object} entity entity (or player) being drawn
   * @param {{time:number, dt:number, frameId:number,
   *          camX:number, camY:number, camZ:number}} ctx frame context
   * @param {Pose} pose pose to fill
   * @param {number} x interpolated world X
   * @param {number} y interpolated world Y
   * @param {number} z interpolated world Z
   * @returns {Object} {@link EntityAnimator#result}
   */
  animate(model, visual, entity, ctx, pose, x, y, z) {
    const st = this.state(entity);
    const res = this.result;
    const repeat = st.lastFrame === ctx.frameId;
    st.lastFrame = ctx.frameId;
    const dt = repeat ? 0 : clamp(ctx.dt, 0, 0.1);
    const t = ctx.time;

    /* ---- ground speed ------------------------------------------------- */
    let vx = 0;
    let vz = 0;
    let vy = 0;
    if (st.hasLast && dt > 1e-5) {
      vx = (x - st.lastX) / dt;
      vy = (y - st.lastY) / dt;
      vz = (z - st.lastZ) / dt;
    } else if (entity.velocity && entity.velocity.length >= 3) {
      vx = entity.velocity[0];
      vy = entity.velocity[1];
      vz = entity.velocity[2];
    }
    st.lastX = x; st.lastY = y; st.lastZ = z; st.hasLast = true;

    const speed = Math.hypot(vx, vz);
    st.speed = damp(st.speed, speed, 12, dt);
    const stride = visual.stride === undefined ? 2.66 : visual.stride;
    st.walkPhase += st.speed * stride * dt;
    if (st.walkPhase > 1e6) st.walkPhase -= 1e6;
    const targetAmount = clamp(st.speed / WALK_REFERENCE_SPEED, 0, 1);
    st.limbAmount = damp(st.limbAmount, targetAmount, 10, dt);
    st.idle += dt;

    /* ---- facing -------------------------------------------------------- */
    let bodyYaw = st.bodyYaw;
    if (typeof entity.modelYaw === 'number') {
      bodyYaw = entity.modelYaw;
    } else if (speed > 0.08) {
      bodyYaw = st.bodyYaw + wrapAngle(Math.atan2(vx, vz) - st.bodyYaw) * clamp(dt * 12, 0, 1);
    } else {
      const y0 = numField(entity, ['bodyYaw', 'yaw'], NaN);
      if (Number.isFinite(y0)) bodyYaw = y0;
      else if (entity.rotation && entity.rotation.length >= 1
               && Number.isFinite(entity.rotation[0])) bodyYaw = entity.rotation[0];
    }
    st.bodyYaw = bodyYaw;

    /* ---- head look-at --------------------------------------------------- */
    const eyeY = y + model.height * 0.85;
    let tx = ctx.camX;
    let ty = ctx.camY;
    let tz = ctx.camZ;
    const target = entity.target;
    if (target && target.position && target.position.length >= 3) {
      tx = target.position[0];
      ty = target.position[1] + 1.2;
      tz = target.position[2];
    }
    const dx = tx - x;
    const dz = tz - z;
    const flat = Math.hypot(dx, dz);
    let wantYaw = 0;
    let wantPitch = 0;
    if (flat > 0.001 && flat < 24) {
      wantYaw = clamp(wrapAngle(Math.atan2(dx, dz) - bodyYaw), -1.25, 1.25);
      wantPitch = clamp(-Math.atan2(ty - eyeY, flat), -0.7, 0.7);
    }
    st.headYaw = damp(st.headYaw, wantYaw, 7, dt);
    st.headPitch = damp(st.headPitch, wantPitch, 7, dt);

    /* ---- damage / death / attack --------------------------------------- */
    const hurtTicks = numField(entity, ['hurtTime', 'hurtTicks', 'hurtTimer'], 0);
    const hurt = clamp(hurtTicks / 10, 0, 1);
    const deathTicks = numField(entity, ['deathTime', 'deathTicks'], 0);
    const dead = !!entity.dead || (entity.health !== undefined && entity.health <= 0);
    const deathT = dead ? clamp(deathTicks > 0 ? deathTicks / 20 : 1, 0, 1) : 0;

    let swing = numField(entity, ['swingProgress', 'attackAnim', 'swingTime'], -1);
    if (swing < 0) {
      if (entity.swinging || (entity.animation && entity.animation.attack)) st.swingActive = true;
      if (st.swingActive) {
        st.swing += dt * 3.2;
        if (st.swing >= 1) { st.swing = 0; st.swingActive = false; }
      }
      swing = st.swing;
    }
    swing = clamp(swing, 0, 1);

    res.bodyYaw = bodyYaw;
    res.deathAngle = deathT * Math.PI * 0.5;
    res.hurtTilt = hurt * 0.22;
    res.scale = visual.scale === undefined ? 1 : visual.scale;
    res.emissive = visual.glow === undefined ? 0 : visual.glow;
    res.subsurface = 0;
    res.yOffset = 0;
    res.overlay[0] = 1; res.overlay[1] = 0.16; res.overlay[2] = 0.14;
    res.overlay[3] = hurt * 0.55;

    /* ---- pose ----------------------------------------------------------- */
    pose.reset(model);
    const hide = visual.hide;
    if (hide) for (let i = 0; i < hide.length; i++) pose.hide(hide[i]);

    const phase = st.walkPhase;
    const amt = st.limbAmount;
    const profile = visual.anim || 'biped';

    switch (profile) {
      case 'biped': this._biped(pose, visual, st, phase, amt, t, swing, entity); break;
      case 'quadruped': this._quadruped(pose, visual, st, phase, amt, t); break;
      case 'creeper': this._creeper(pose, visual, st, phase, amt, t, entity, res); break;
      case 'spider': this._spider(pose, st, phase, amt, t); break;
      case 'chicken': this._chicken(pose, st, phase, amt, t, vy); break;
      case 'wolf': this._wolf(pose, st, phase, amt, t); break;
      case 'bat': this._bat(pose, st, t); break;
      case 'squid': this._squid(pose, st, t, res); break;
      case 'slime': this._slime(pose, st, phase, amt, t, res); break;
      case 'golem': this._golem(pose, st, phase, amt, t, swing); break;
      case 'rabbit': this._rabbit(pose, st, phase, amt, t); break;
      case 'projectile': break;
      default: this._biped(pose, visual, st, phase, amt, t, swing, entity); break;
    }

    if (profile !== 'projectile') {
      pose.rotate('head', st.headPitch, st.headYaw, 0);
    }
    return res;
  }

  /**
   * Two-legged gait: counter-swinging limbs, idle breathing, attack swing,
   * sneak crouch and the zombie/villager arm poses.
   * @param {Pose} p pose
   * @param {Object} visual visual descriptor
   * @param {Object} st animation state
   * @param {number} phase gait phase
   * @param {number} amt gait amplitude 0..1
   * @param {number} t seconds
   * @param {number} swing attack swing 0..1
   * @param {Object} entity entity
   * @returns {void}
   */
  _biped(p, visual, st, phase, amt, t, swing, entity) {
    const s = Math.cos(phase) * 1.30 * amt;
    p.rotate('leg_r', s, 0, 0);
    p.rotate('leg_l', -s, 0, 0);
    p.rotate('arm_r', -s * 0.85, 0, 0.05 + Math.cos(t * 1.3) * 0.03);
    p.rotate('arm_l', s * 0.85, 0, -0.05 - Math.cos(t * 1.3 + 1.7) * 0.03);

    const breathe = Math.sin(t * 1.6) * 0.05 * (1 - amt);
    p.rotate('body', breathe * 0.4, 0, 0);
    p.translate('head', 0, breathe * 0.6, 0);

    if (visual.armsUp) {
      p.rotate('arm_r', -1.45 * visual.armsUp, 0, -0.06);
      p.rotate('arm_l', -1.45 * visual.armsUp, 0, 0.06);
      p.rotate('arm_r', Math.sin(t * 1.1) * 0.08, 0, 0);
      p.rotate('arm_l', Math.sin(t * 1.1 + 1.0) * 0.08, 0, 0);
    }
    if (visual.armsCrossed) {
      p.rotate('arm_r', -0.62, 0, -0.42);
      p.rotate('arm_l', -0.62, 0, 0.42);
    }
    if (entity && entity.sneaking) {
      p.rotate('body', 0.5, 0, 0);
      p.translate('body', 0, -2, 0);
      p.translate('head', 0, -1.2, 1.2);
    }
    if (swing > 0) {
      const a = Math.sin(swing * Math.PI);
      p.rotate('arm_r', -a * 2.1, -a * 0.45, 0);
      p.rotate('body', 0, a * 0.22, 0);
    }
    p.rotate('robe', Math.cos(phase + 0.4) * 0.10 * amt, 0, 0);
  }

  /**
   * Four-legged diagonal gait plus head bob, ear flick and tail sway.
   * @param {Pose} p pose
   * @param {Object} visual visual descriptor
   * @param {Object} st animation state
   * @param {number} phase gait phase
   * @param {number} amt gait amplitude
   * @param {number} t seconds
   * @returns {void}
   */
  _quadruped(p, visual, st, phase, amt, t) {
    const a = Math.cos(phase) * 1.05 * amt;
    const b = Math.cos(phase + Math.PI) * 1.05 * amt;
    p.rotate('leg_fl', a, 0, 0);
    p.rotate('leg_br', a, 0, 0);
    p.rotate('leg_fr', b, 0, 0);
    p.rotate('leg_bl', b, 0, 0);
    const bob = Math.sin(phase * 2) * 0.07 * amt + Math.sin(t * 1.4) * 0.03 * (1 - amt);
    p.rotate('body', bob * 0.3, 0, 0);
    p.translate('body', 0, Math.abs(Math.sin(phase)) * 0.35 * amt, 0);
    p.rotate('head', bob, 0, 0);
    p.rotate('neck', bob * 0.5, 0, 0);
    p.rotate('mane', bob * 0.5, 0, 0);
    p.rotate('ear_l', Math.sin(t * 2.7) * 0.12, 0, 0);
    p.rotate('ear_r', Math.sin(t * 2.7 + 1.3) * 0.12, 0, 0);
    p.rotate('tail', Math.sin(t * 2.2) * 0.20 * (0.4 + amt), Math.sin(t * 1.7) * 0.25, 0);
  }

  /**
   * Creeper: stiff four-legged shuffle plus the fuse inflation and white flash.
   * @param {Pose} p pose
   * @param {Object} visual visual descriptor
   * @param {Object} st animation state
   * @param {number} phase gait phase
   * @param {number} amt gait amplitude
   * @param {number} t seconds
   * @param {Object} entity entity
   * @param {Object} res result record to fill
   * @returns {void}
   */
  _creeper(p, visual, st, phase, amt, t, entity, res) {
    const a = Math.cos(phase) * 1.0 * amt;
    const b = Math.cos(phase + Math.PI) * 1.0 * amt;
    p.rotate('leg_fl', a, 0, 0);
    p.rotate('leg_br', a, 0, 0);
    p.rotate('leg_fr', b, 0, 0);
    p.rotate('leg_bl', b, 0, 0);
    p.rotate('body', Math.sin(t * 1.5) * 0.02 * (1 - amt), 0, 0);

    let fuse = numField(entity, ['swell', 'fuse', 'fuseProgress'], -1);
    if (fuse < 0) {
      const fuseTicks = numField(entity, ['fuseTime', 'fuseTicks'], -1);
      fuse = fuseTicks >= 0 ? clamp(1 - fuseTicks / 30, 0, 1) : 0;
    }
    fuse = clamp(fuse, 0, 1);
    if (fuse > 0) {
      const pulse = 1 + fuse * 0.35 * (0.6 + 0.4 * Math.sin(t * (8 + fuse * 22)));
      res.scale *= pulse;
      const flash = fuse * (0.5 + 0.5 * Math.sin(t * (10 + fuse * 26)));
      res.overlay[0] = 1; res.overlay[1] = 1; res.overlay[2] = 1;
      res.overlay[3] = Math.max(res.overlay[3], flash * 0.85);
      res.emissive = Math.max(res.emissive, flash * 0.6);
    }
  }

  /**
   * Eight-leg spider gait: four alternating pairs, each with a yaw sweep and a
   * lift, plus a body sway.
   * @param {Pose} p pose
   * @param {Object} st animation state
   * @param {number} phase gait phase
   * @param {number} amt gait amplitude
   * @param {number} t seconds
   * @returns {void}
   */
  _spider(p, st, phase, amt, t) {
    const idle = 0.12 + amt * 0.9;
    for (let i = 0; i < 4; i++) {
      const ph = phase * 2 + i * Math.PI * 0.5;
      const sweep = Math.cos(ph) * 0.36 * idle;
      const lift = Math.max(0, Math.sin(ph)) * 0.42 * idle;
      p.rotate(`leg_l${i}`, 0, sweep, -lift);
      p.rotate(`leg_r${i}`, 0, -sweep, lift);
    }
    p.rotate('thorax', Math.sin(t * 1.1) * 0.03, 0, Math.sin(phase) * 0.05 * amt);
    p.rotate('body', Math.sin(t * 0.9) * 0.04, 0, 0);
  }

  /**
   * Chicken: quick alternating legs, a wing flap that ramps up while falling and
   * a head bob synced to the stride.
   * @param {Pose} p pose
   * @param {Object} st animation state
   * @param {number} phase gait phase
   * @param {number} amt gait amplitude
   * @param {number} t seconds
   * @param {number} vy vertical velocity
   * @returns {void}
   */
  _chicken(p, st, phase, amt, t, vy) {
    const s = Math.cos(phase) * 1.1 * amt;
    p.rotate('leg_l', s, 0, 0);
    p.rotate('leg_r', -s, 0, 0);
    const flap = vy < -0.4 ? 1 : 0.12;
    const f = Math.sin(t * (vy < -0.4 ? 26 : 3)) * flap;
    p.rotate('wing_l', 0, 0, -0.15 - f);
    p.rotate('wing_r', 0, 0, 0.15 + f);
    p.rotate('head', Math.sin(phase) * 0.16 * amt, 0, 0);
    p.translate('head', 0, 0, Math.sin(phase) * 0.5 * amt);
    p.rotate('tail', Math.sin(t * 1.9) * 0.08, 0, 0);
  }

  /**
   * Canine/feline gait: bounding legs, a wagging tail and ear flicks.
   * @param {Pose} p pose
   * @param {Object} st animation state
   * @param {number} phase gait phase
   * @param {number} amt gait amplitude
   * @param {number} t seconds
   * @returns {void}
   */
  _wolf(p, st, phase, amt, t) {
    const a = Math.cos(phase) * 1.15 * amt;
    const b = Math.cos(phase + Math.PI) * 1.15 * amt;
    p.rotate('leg_fl', a, 0, 0);
    p.rotate('leg_br', a * 0.9, 0, 0);
    p.rotate('leg_fr', b, 0, 0);
    p.rotate('leg_bl', b * 0.9, 0, 0);
    p.translate('body', 0, Math.abs(Math.sin(phase)) * 0.5 * amt, 0);
    p.rotate('body', Math.sin(phase * 2) * 0.05 * amt, 0, 0);
    const wag = Math.sin(t * (5 + amt * 6));
    p.rotate('tail', Math.sin(t * 2.0) * 0.10, wag * 0.55, 0);
    p.rotate('head', Math.sin(t * 1.3) * 0.04, 0, 0);
    p.rotate('ear_l', Math.sin(t * 3.1) * 0.14, 0, 0);
    p.rotate('ear_r', Math.sin(t * 3.1 + 1.1) * 0.14, 0, 0);
    p.rotate('mane', Math.sin(t * 1.1) * 0.03, 0, 0);
  }

  /**
   * Bat: continuous wing flap with a two-segment membrane and a body bob.
   * @param {Pose} p pose
   * @param {Object} st animation state
   * @param {number} t seconds
   * @returns {void}
   */
  _bat(p, st, t) {
    const f = Math.sin(t * 11.0);
    const g = Math.sin(t * 11.0 - 0.7);
    p.rotate('wing_l', 0, f * 0.35, -0.35 - f * 0.85);
    p.rotate('wing_r', 0, -f * 0.35, 0.35 + f * 0.85);
    p.rotate('wingtip_l', 0, g * 0.4, -g * 0.6);
    p.rotate('wingtip_r', 0, -g * 0.4, g * 0.6);
    p.translate('body', 0, Math.sin(t * 5.5) * 0.7, 0);
    p.rotate('body', Math.sin(t * 2.0) * 0.10, 0, 0);
  }

  /**
   * Squid: slow body pulse and eight tentacles undulating out of phase.
   * @param {Pose} p pose
   * @param {Object} st animation state
   * @param {number} t seconds
   * @param {Object} res result record
   * @returns {void}
   */
  _squid(p, st, t, res) {
    const pulse = Math.sin(t * 1.8);
    p.scaleBone('body', 1 + pulse * 0.05, 1 - pulse * 0.07, 1 + pulse * 0.05);
    for (let i = 0; i < 8; i++) {
      const ph = t * 2.2 + i * 0.78;
      p.rotate(`tentacle_${i}`, Math.sin(ph) * 0.45, 0, Math.cos(ph * 0.7) * 0.25);
    }
    p.translate('body', 0, Math.sin(t * 1.1) * 0.6, 0);
    res.subsurface = 0.5;
  }

  /**
   * Slime: squash and stretch driven by the hop phase, more subsurface the
   * bigger the squash.
   * @param {Pose} p pose
   * @param {Object} st animation state
   * @param {number} phase gait phase
   * @param {number} amt gait amplitude
   * @param {number} t seconds
   * @param {Object} res result record
   * @returns {void}
   */
  _slime(p, st, phase, amt, t, res) {
    const wob = Math.sin(t * 3.4 + phase) * (0.10 + amt * 0.16);
    p.scaleBone('body', 1 + wob * 0.8, 1 - wob, 1 + wob * 0.8);
    p.scaleBone('inner', 1 - wob * 0.4, 1 + wob * 0.5, 1 - wob * 0.4);
    res.subsurface = 0.85;
    res.yOffset = -Math.min(0, wob) * 0.5;
  }

  /**
   * Iron golem: heavy slow stride, arms hanging forward, a big overhead attack.
   * @param {Pose} p pose
   * @param {Object} st animation state
   * @param {number} phase gait phase
   * @param {number} amt gait amplitude
   * @param {number} t seconds
   * @param {number} swing attack swing 0..1
   * @returns {void}
   */
  _golem(p, st, phase, amt, t, swing) {
    const s = Math.cos(phase) * 0.75 * amt;
    p.rotate('leg_r', s, 0, 0);
    p.rotate('leg_l', -s, 0, 0);
    p.rotate('arm_r', -0.25 - s * 0.4, 0, 0.05);
    p.rotate('arm_l', -0.25 + s * 0.4, 0, -0.05);
    p.rotate('body', 0, Math.cos(phase) * 0.08 * amt, 0);
    p.rotate('head', Math.sin(t * 0.7) * 0.03, 0, 0);
    if (swing > 0) {
      const a = Math.sin(swing * Math.PI);
      p.rotate('arm_r', -a * 2.4, 0, 0);
      p.rotate('arm_l', -a * 2.4, 0, 0);
    }
  }

  /**
   * Rabbit: hop cycle — the body arcs while the long back feet fold under.
   * @param {Pose} p pose
   * @param {Object} st animation state
   * @param {number} phase gait phase
   * @param {number} amt gait amplitude
   * @param {number} t seconds
   * @returns {void}
   */
  _rabbit(p, st, phase, amt, t) {
    const hop = Math.abs(Math.sin(phase)) * amt;
    p.translate('body', 0, hop * 2.2, 0);
    p.rotate('body', -hop * 0.45, 0, 0);
    p.rotate('foot_l', hop * 1.2, 0, 0);
    p.rotate('foot_r', hop * 1.2, 0, 0);
    p.rotate('leg_fl', -hop * 1.4, 0, 0);
    p.rotate('leg_fr', -hop * 1.4, 0, 0);
    p.rotate('ear_l', Math.sin(t * 2.3) * 0.12 - hop * 0.4, 0, 0);
    p.rotate('ear_r', Math.sin(t * 2.3 + 0.9) * 0.12 - hop * 0.4, 0, 0);
    p.rotate('tail', hop * 0.3, 0, 0);
  }
}

/* ========================================================================== */
/* EntityRenderer                                                             */
/* ========================================================================== */

/**
 * Unit-cube geometry shared by held blocks, dropped block items, block entities
 * and the break overlay. Positions are in `[0,1]^3` and every vertex carries the
 * face direction byte of ARCHITECTURE.md 3.1.
 * @returns {{data:ArrayBuffer, indices:Uint16Array, count:number}} interleaved mesh
 */
function buildUnitCube() {
  const faces = [
    { f: 0, n: [1, 0, 0], c: [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1] },
    { f: 1, n: [-1, 0, 0], c: [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0] },
    { f: 2, n: [0, 1, 0], c: [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0] },
    { f: 3, n: [0, -1, 0], c: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1] },
    { f: 4, n: [0, 0, 1], c: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1] },
    { f: 5, n: [0, 0, -1], c: [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0] },
  ];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1];
  const vertexCount = 24;
  const buffer = new ArrayBuffer(vertexCount * 36);
  const f32 = new Float32Array(buffer);
  const u8 = new Uint8Array(buffer);
  const idx = new Uint16Array(36);
  let v = 0;
  let ii = 0;
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    const base = v;
    for (let k = 0; k < 4; k++) {
      const o = v * 9;
      f32[o] = face.c[k * 3];
      f32[o + 1] = face.c[k * 3 + 1];
      f32[o + 2] = face.c[k * 3 + 2];
      f32[o + 3] = face.n[0];
      f32[o + 4] = face.n[1];
      f32[o + 5] = face.n[2];
      f32[o + 6] = uv[k * 2];
      f32[o + 7] = uv[k * 2 + 1];
      u8[v * 36 + 32] = face.f;
      v++;
    }
    idx[ii++] = base; idx[ii++] = base + 1; idx[ii++] = base + 2;
    idx[ii++] = base; idx[ii++] = base + 2; idx[ii++] = base + 3;
  }
  return { data: buffer, indices: idx, count: 36 };
}

/**
 * Sliced quad stack used to extrude a flat item icon into a solid 3D sprite.
 * The two outer slices are the caps (`a_slice` 0 and 1); every slice in between
 * carries 0.5 and is clipped to the icon's rim by the fragment stage.
 * @returns {{data:Float32Array, indices:Uint16Array, count:number}} interleaved mesh
 */
function buildSpriteSlices() {
  const total = SPRITE_SLICES + 2;
  const verts = [];
  const idx = [];
  const half = SPRITE_THICKNESS * 0.5;
  for (let i = 0; i < total; i++) {
    const tf = total === 1 ? 0 : i / (total - 1);
    const z = -half + SPRITE_THICKNESS * tf;
    const slice = i === 0 ? 0 : (i === total - 1 ? 1 : 0.5);
    const flip = i === 0;
    const corners = flip
      ? [[0.5, -0.5], [-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]
      : [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    const base = verts.length / 6;
    for (let k = 0; k < 4; k++) {
      const cx = corners[k][0];
      const cy = corners[k][1];
      verts.push(cx, cy, z, cx + 0.5, cy + 0.5, slice);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { data: new Float32Array(verts), indices: new Uint16Array(idx), count: idx.length };
}

/**
 * Classify a part name into one of the six skin zones consumed by
 * {@link SKIN_FS} (`0` head, `1` body, `2` arm/wing, `3` leg, `4` accessory).
 * @param {string} name part name
 * @returns {number} zone id 0..5
 */
function zoneForPart(name) {
  if (name === 'head') return 0;
  if (name === 'body' || name === 'thorax' || name === 'waist' || name === 'robe'
      || name === 'mane' || name === 'inner' || name === 'neck' || name === 'shaft') return 1;
  if (name.indexOf('arm') >= 0 || name.indexOf('wing') >= 0) return 2;
  if (name.indexOf('leg') >= 0 || name.indexOf('foot') >= 0 || name.indexOf('tentacle') >= 0) return 3;
  if (name.indexOf('ear') >= 0 || name.indexOf('horn') >= 0 || name.indexOf('snout') >= 0
      || name.indexOf('nose') >= 0 || name.indexOf('beak') >= 0 || name.indexOf('wattle') >= 0
      || name.indexOf('comb') >= 0 || name.indexOf('tail') >= 0 || name.indexOf('eye') >= 0
      || name.indexOf('mouth') >= 0 || name.indexOf('udder') >= 0
      || name.indexOf('fletch') >= 0) return 4;
  return 5;
}

/**
 * Draws mobs, dropped items, block entities, the first-person hand, the block
 * selection outline and the break overlay (ARCHITECTURE.md 5.25).
 *
 * Lifecycle: `new EntityRenderer(gl, settings, textures)` →
 * `render(entities, player, frame, world, {pass})` once per G-buffer pass and
 * once per shadow cascade → `renderHeldItem` / `renderBlockOutline` /
 * `renderBreakOverlay` → `dispose()`.
 */
export class EntityRenderer {
  /**
   * @param {import('../core/gl.js').GL} gl VOXELIA device wrapper
   * @param {Object} settings settings store (`get(key)`)
   * @param {Object} [textureManager] `TextureManager`, for the block texture arrays
   */
  constructor(gl, settings, textureManager) {
    /** @type {import('../core/gl.js').GL} */
    this.device = gl;
    /** @type {WebGL2RenderingContext} */
    this.raw = gl.gl;
    /** @type {Object} */
    this.settings = settings || null;
    /** @type {?Object} */
    this.textures = textureManager || null;

    /** Registered model definitions by name. @type {Map<string, Object>} */
    this.modelDefs = new Map();
    for (const key of Object.keys(MODELS)) this.modelDefs.set(key, MODELS[key]);
    /** Compiled + uploaded models by name. @type {Map<string, Object>} */
    this.models = new Map();
    /** Per entity-type visual descriptors. @type {Map<string, Object>} */
    this.visuals = new Map();
    for (const key of Object.keys(ENTITY_VISUALS)) this.visuals.set(key, ENTITY_VISUALS[key]);

    /** @type {Object<string, ?Object>} */
    this.programs = {
      entity: null, cube: null, sprite: null, outline: null, skinGen: null, iconGen: null,
    };

    /** @type {?WebGLTexture} mob skin array (albedo layers then MRAE layers). */
    this.skinArray = null;
    /** @type {?WebGLTexture} item icon array. */
    this.iconArray = null;
    /** @type {number} */
    this.skinCount = SKINS.length;

    this._cube = null;
    this._sprite = null;
    this._outlineVBO = null;
    this._outlineVAO = null;
    this._outlineData = new Float32Array(24 * 3 * 8);
    this._outlineCapacity = 24 * 8;

    this._animator = new EntityAnimator();
    this._pose = new Pose();

    // Scratch — never allocate inside a frame.
    this._model = mat4.create();
    this._scratchA = mat4.create();
    this._scratchB = mat4.create();
    this._invView = mat4.create();
    this._handProj = mat4.create();
    this._handVP = mat4.create();
    this._identity = mat4.identity(mat4.create());
    this._light = new Float32Array(4);
    this._faceLayers = new Float32Array(6);
    this._itemColors = new Float32Array(9);
    this._zoneRects = new Float32Array(48);
    this._zoneIds = new Int32Array(12);
    this._lightRGB = [0, 0, 0];
    this._tmpVec = vec3.create();

    /** @type {Object[]} reusable draw records. */
    this._records = [];
    /** @type {Object[]} this frame's visible list. */
    this._list = [];
    this._playerProxy = {
      type: 'player', position: [0, 0, 0], velocity: [0, 0, 0], modelYaw: 0,
      health: 20, dead: false, hurtTime: 0, sneaking: false, target: null,
    };

    /** First-person hand animation memory. */
    this._hand = {
      bob: 0, bobAmount: 0, swing: 0, swinging: false, sway: 0, swayY: 0,
      lastYaw: 0, lastPitch: 0, hasLast: false, equip: 1, lastItemKey: -1,
    };

    /** @type {?Object} world used by {@link EntityRenderer#renderBreakOverlay}. */
    this._lastWorld = null;
    /** Last player-camera position, reused by the shadow pass. @type {Float32Array} */
    this._lastCamPos = new Float32Array(3);
    /** True once {@link EntityRenderer#render} has seen a real camera. @type {boolean} */
    this._hasCamPos = false;
    /** Fallback frame counter when the frame carries no `frameIndex`. @type {number} */
    this._frameCounter = 0;
    /** @type {number} */
    this.width = 1;
    /** @type {number} */
    this.height = 1;

    /** Draw statistics for the frame. */
    this.stats = { drawCalls: 0, entities: 0, triangles: 0 };

    this._ready = false;
    this._failed = false;
    this._logged = false;
    /** Lazily imported `game/items.js`, when it exists. @type {?Object} */
    this._items = null;
    this._itemsRequested = false;
  }

  /**
   * Read a setting with a fallback; never throws.
   * @param {string} key setting key
   * @param {*} fallback default
   * @returns {*} the value
   */
  _setting(key, fallback) {
    const s = this.settings;
    if (!s) return fallback;
    try {
      if (typeof s.get === 'function') {
        const v = s.get(key);
        return v === undefined || v === null ? fallback : v;
      }
      const v = s[key];
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  /**
   * Log a subsystem failure exactly once and disable the renderer.
   * @param {string} what what failed
   * @param {*} err the error
   * @returns {void}
   */
  _fail(what, err) {
    this._failed = true;
    if (this._logged) return;
    this._logged = true;
    console.error(`[VOXELIA] entities: ${what} — entity rendering disabled.`, err);
  }

  /**
   * Register (or replace) a cube-skeletal model.
   * @param {string} name model name
   * @param {{parts:Object[], uvSize?:number[], height?:number, width?:number,
   *          radius?:number, billboard?:boolean}} modelDef model definition
   * @returns {boolean} true when the definition was accepted
   */
  registerModel(name, modelDef) {
    if (!name || !modelDef || !Array.isArray(modelDef.parts) || modelDef.parts.length === 0) {
      console.warn(`[entities] registerModel("${name}") ignored: a model needs a non-empty parts array.`);
      return false;
    }
    const existing = this.models.get(name);
    if (existing) {
      this._disposeModel(existing);
      this.models.delete(name);
    }
    this.modelDefs.set(name, modelDef);
    return true;
  }

  /**
   * Register (or replace) the visual descriptor of an entity type.
   * @param {string} type entity type name
   * @param {Object} visual `{model, skin, anim, scale, stride, hide, glow}`
   * @returns {void}
   */
  registerVisual(type, visual) {
    if (!type || !visual || !visual.model) return;
    this.visuals.set(type, visual);
  }

  /**
   * Compile and upload a model on first use.
   * @param {string} name model name
   * @returns {?Object} compiled model, or null
   */
  _getModel(name) {
    let m = this.models.get(name);
    if (m !== undefined) return m;
    const def = this.modelDefs.get(name);
    if (!def) return null;
    try {
      m = compileModel(name, def);
      if (!m) return null;
      const device = this.device;
      const gl = this.raw;
      m.vbo = device.createBuffer(gl.ARRAY_BUFFER, m.vertexData, gl.STATIC_DRAW);
      m.ibo = device.createBuffer(gl.ELEMENT_ARRAY_BUFFER, m.indexData, gl.STATIC_DRAW);
      m.vao = device.createVertexArray({
        attributes: [
          { location: 0, buffer: m.vbo, size: 3, type: gl.FLOAT, stride: ENTITY_VERTEX_STRIDE, offset: 0 },
          { location: 1, buffer: m.vbo, size: 3, type: gl.FLOAT, stride: ENTITY_VERTEX_STRIDE, offset: 12 },
          { location: 2, buffer: m.vbo, size: 2, type: gl.FLOAT, stride: ENTITY_VERTEX_STRIDE, offset: 24 },
          { location: 3, buffer: m.vbo, size: 1, type: gl.UNSIGNED_BYTE, integer: true, stride: ENTITY_VERTEX_STRIDE, offset: 32 },
        ],
        indexBuffer: m.ibo,
        indexType: gl.UNSIGNED_SHORT,
      });
      m.vertexData = null;
      this.models.set(name, m);
      return m;
    } catch (err) {
      this._fail(`model "${name}" could not be built`, err);
      this.models.set(name, null);
      return null;
    }
  }

  /**
   * Release one compiled model's GPU resources.
   * @param {?Object} m compiled model
   * @returns {void}
   */
  _disposeModel(m) {
    if (!m) return;
    const gl = this.raw;
    if (m.vao) gl.deleteVertexArray(m.vao);
    if (m.vbo) gl.deleteBuffer(m.vbo);
    if (m.ibo) gl.deleteBuffer(m.ibo);
    m.vao = null; m.vbo = null; m.ibo = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Resources                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Build every program, static VAO and procedural texture array. Runs once,
   * lazily, on the first draw; a failure disables the whole module rather than
   * throwing inside a frame.
   * @returns {boolean} true when the renderer is usable
   */
  _ensureResources() {
    if (this._ready) return true;
    if (this._failed) return false;
    try {
      const device = this.device;
      const gl = this.raw;

      this.programs.entity = device.createProgram('entity.model', ENTITY_VS, ENTITY_FS);
      this.programs.cube = device.createProgram('entity.cube', CUBE_VS, CUBE_FS);
      this.programs.sprite = device.createProgram('entity.sprite', SPRITE_VS, SPRITE_FS);
      this.programs.outline = device.createProgram('entity.outline', OUTLINE_VS, OUTLINE_FS);
      this.programs.skinGen = device.createProgram('entity.skingen', FULLSCREEN_VS, SKIN_FS);
      this.programs.iconGen = device.createProgram('entity.icongen', FULLSCREEN_VS, ITEM_FS);
      device.flushPrograms([
        this.programs.entity, this.programs.cube, this.programs.sprite,
        this.programs.outline, this.programs.skinGen, this.programs.iconGen,
      ]);
      for (const key of ['entity', 'cube', 'sprite', 'outline']) {
        const p = this.programs[key];
        if (p && p.program) p.bindUBO('Frame', FRAME_BINDING);
      }
      if (!this.programs.entity || !this.programs.entity.program) {
        this._fail('the skinned model program failed to build', new Error('program link failed'));
        return false;
      }

      const cube = buildUnitCube();
      this._cube = {
        vbo: device.createBuffer(gl.ARRAY_BUFFER, cube.data, gl.STATIC_DRAW),
        ibo: device.createBuffer(gl.ELEMENT_ARRAY_BUFFER, cube.indices, gl.STATIC_DRAW),
        count: cube.count,
        vao: null,
      };
      this._cube.vao = device.createVertexArray({
        attributes: [
          { location: 0, buffer: this._cube.vbo, size: 3, type: gl.FLOAT, stride: 36, offset: 0 },
          { location: 1, buffer: this._cube.vbo, size: 3, type: gl.FLOAT, stride: 36, offset: 12 },
          { location: 2, buffer: this._cube.vbo, size: 2, type: gl.FLOAT, stride: 36, offset: 24 },
          { location: 3, buffer: this._cube.vbo, size: 1, type: gl.UNSIGNED_BYTE, integer: true, stride: 36, offset: 32 },
        ],
        indexBuffer: this._cube.ibo,
        indexType: gl.UNSIGNED_SHORT,
      });

      const slices = buildSpriteSlices();
      this._sprite = {
        vbo: device.createBuffer(gl.ARRAY_BUFFER, slices.data, gl.STATIC_DRAW),
        ibo: device.createBuffer(gl.ELEMENT_ARRAY_BUFFER, slices.indices, gl.STATIC_DRAW),
        count: slices.count,
        vao: null,
      };
      this._sprite.vao = device.createVertexArray({
        attributes: [
          { location: 0, buffer: this._sprite.vbo, size: 3, type: gl.FLOAT, stride: 24, offset: 0 },
          { location: 1, buffer: this._sprite.vbo, size: 2, type: gl.FLOAT, stride: 24, offset: 12 },
          { location: 2, buffer: this._sprite.vbo, size: 1, type: gl.FLOAT, stride: 24, offset: 20 },
        ],
        indexBuffer: this._sprite.ibo,
        indexType: gl.UNSIGNED_SHORT,
      });

      this._outlineVBO = device.createBuffer(gl.ARRAY_BUFFER,
        this._outlineData.byteLength, gl.DYNAMIC_DRAW);
      this._outlineVAO = device.createVertexArray({
        attributes: [
          { location: 0, buffer: this._outlineVBO, size: 3, type: gl.FLOAT, stride: 12, offset: 0 },
        ],
      });

      // Generation binds its own framebuffers; the caller may be mid-pass, so
      // the previous target and viewport are restored exactly.
      const state = device._state;
      const prevFbo = state.fbo;
      const vx = state.vx; const vy = state.vy; const vw = state.vw; const vh = state.vh;
      this._generateSkins();
      this._generateIcons();
      device._bindFramebufferRaw(prevFbo === undefined ? null : prevFbo);
      if (vw > 0 && vh > 0) device.setViewport(vx, vy, vw, vh);

      this._ready = true;
      return true;
    } catch (err) {
      this._fail('initialisation failed', err);
      return false;
    }
  }

  /**
   * Collect the unwrap rectangles of a model, deduplicated and capped at the 12
   * slots {@link SKIN_FS} accepts.
   * @param {Object} model compiled model
   * @returns {number} number of zones written into `this._zoneRects`
   */
  _buildZones(model) {
    const rects = this._zoneRects;
    const ids = this._zoneIds;
    let n = 0;
    for (let i = 0; i < model.parts.length && n < 12; i++) {
      const p = model.parts[i];
      const w = 2 * (p.size[0] + p.size[2]);
      const h = p.size[1] + p.size[2];
      if (w <= 0 || h <= 0) continue;
      const zone = zoneForPart(p.name);
      let dup = false;
      for (let k = 0; k < n; k++) {
        if (rects[k * 4] === p.uv[0] && rects[k * 4 + 1] === p.uv[1]
            && rects[k * 4 + 2] === w && ids[k] === zone) { dup = true; break; }
      }
      if (dup) continue;
      rects[n * 4] = p.uv[0];
      rects[n * 4 + 1] = p.uv[1];
      rects[n * 4 + 2] = w;
      rects[n * 4 + 3] = h;
      ids[n] = zone;
      n++;
    }
    for (let k = n; k < 12; k++) {
      rects[k * 4] = 0; rects[k * 4 + 1] = 0; rects[k * 4 + 2] = 0; rects[k * 4 + 3] = 0;
      ids[k] = 5;
    }
    return n;
  }

  /**
   * Render every mob skin into the private texture array: layer `i` is the
   * albedo, layer `i + skinCount` the metallic/roughness/AO/emissive image.
   * @returns {void}
   */
  _generateSkins() {
    const device = this.device;
    const gl = this.raw;
    const program = this.programs.skinGen;
    if (!program || !program.program) return;

    this.skinArray = device.createTexture({
      target: gl.TEXTURE_2D_ARRAY,
      width: SKIN_TEX_SIZE,
      height: SKIN_TEX_SIZE,
      depth: SKINS.length * 2,
      internalFormat: gl.RGBA8,
      min: 'linear',
      mag: 'linear',
      wrap: 'clamp',
    });

    const fbo = device.createFramebuffer({
      name: 'entity.skins',
      color: [{ tex: this.skinArray, layer: 0 }, { tex: this.skinArray, layer: SKINS.length }],
      width: SKIN_TEX_SIZE,
      height: SKIN_TEX_SIZE,
    });

    try {
      device.setDepthTest(false);
      device.setDepthWrite(false);
      device.setBlend('none');
      device.setCull('none');
      device.setColorMask(true, true, true, true);
      program.use();

      for (let i = 0; i < SKINS.length; i++) {
        const model = this._getModel(SKINS[i].model) || this._getModel('humanoid');
        const uvW = model ? model.uvW : DEFAULT_UV_W;
        const uvH = model ? model.uvH : DEFAULT_UV_H;
        const count = model ? this._buildZones(model) : 0;
        const head = model ? model.headRect : [0, 0, 0, 0];

        program.setInt('u_skin', i);
        program.setVec2('u_uvSize', uvW, uvH);
        program.setVec4('u_headRect', head[0], head[1], head[2], head[3]);
        program.setVec4Array('u_zoneRect[0]', this._zoneRects);
        const loc = program.uniform('u_zoneId[0]');
        if (loc !== null) gl.uniform1iv(loc, this._zoneIds);
        program.setInt('u_zoneCount', count);
        program.setFloat('u_seed', i * 17.31 + 3.7);

        fbo.setColorLayer(0, i);
        fbo.setColorLayer(1, SKINS.length + i);
        device.bindFramebuffer(fbo);
        device.setViewport(0, 0, SKIN_TEX_SIZE, SKIN_TEX_SIZE);
        device.drawFullscreen();
      }
    } finally {
      fbo.dispose();
      device.bindFramebuffer(null);
    }
  }

  /**
   * Render every item icon into the private icon array.
   * @returns {void}
   */
  _generateIcons() {
    const device = this.device;
    const gl = this.raw;
    const program = this.programs.iconGen;
    if (!program || !program.program) return;

    this.iconArray = device.createTexture({
      target: gl.TEXTURE_2D_ARRAY,
      width: ITEM_TEX_SIZE,
      height: ITEM_TEX_SIZE,
      depth: ITEM_PATTERNS.length,
      internalFormat: gl.RGBA8,
      min: 'linear',
      mag: 'linear',
      wrap: 'clamp',
    });

    const fbo = device.createFramebuffer({
      name: 'entity.icons',
      color: [{ tex: this.iconArray, layer: 0 }],
      width: ITEM_TEX_SIZE,
      height: ITEM_TEX_SIZE,
    });

    try {
      device.setDepthTest(false);
      device.setDepthWrite(false);
      device.setBlend('none');
      device.setCull('none');
      device.setColorMask(true, true, true, true);
      program.use();
      for (let i = 0; i < ITEM_PATTERNS.length; i++) {
        program.setInt('u_pattern', i);
        program.setFloat('u_seed', i * 5.13 + 1.9);
        fbo.setColorLayer(0, i);
        device.bindFramebuffer(fbo);
        device.setViewport(0, 0, ITEM_TEX_SIZE, ITEM_TEX_SIZE);
        device.drawFullscreen();
      }
    } finally {
      fbo.dispose();
      device.bindFramebuffer(null);
    }
  }

  /**
   * Kick off the one-shot dynamic import of `game/items.js`. The module is
   * optional: without it, held and dropped items fall back to the block cube
   * path (or the generic icon), so nothing ever breaks.
   * @returns {void}
   */
  _requestItems() {
    if (this._itemsRequested) return;
    this._itemsRequested = true;
    try {
      import('../game/items.js').then((mod) => {
        this._items = mod || null;
      }).catch(() => { this._items = null; });
    } catch (e) {
      this._items = null;
    }
  }

  /**
   * Build every GPU resource up front instead of on the first frame.
   * @returns {boolean} true when the renderer is usable
   */
  prepare() {
    this._requestItems();
    return this._ensureResources();
  }

  /**
   * Record the render target size (used as the aspect fallback for the hand).
   * @param {number} width target width in pixels
   * @param {number} height target height in pixels
   * @returns {void}
   */
  resize(width, height) {
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
  }

  /* ---------------------------------------------------------------------- */
  /* Frame helpers                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolve the world-to-clip matrix for a pass.
   * @param {Object} frame frame descriptor (or a shadow light frame)
   * @param {boolean} shadow true for the shadow pass
   * @returns {?ArrayLike<number>} column-major matrix, or null
   */
  _resolveMatrix(frame, shadow) {
    if (!frame) return null;
    if (shadow) {
      if (frame.length === 16) return frame;
      const singles = [frame.lightViewProj, frame.matrix, frame.viewProj, frame.csmMatrix];
      for (let i = 0; i < singles.length; i++) {
        if (singles[i] && singles[i].length === 16) return singles[i];
      }
      const idx = frame.cascade === undefined ? 0 : frame.cascade | 0;
      const lists = [frame.matrices, frame.csmMatrices];
      for (let i = 0; i < lists.length; i++) {
        const l = lists[i];
        if (l && l.length > idx && l[idx] && l[idx].length === 16) return l[idx];
      }
    }
    if (frame.camera && frame.camera.viewProj && frame.camera.viewProj.length === 16) {
      return frame.camera.viewProj;
    }
    if (frame.viewProj && frame.viewProj.length === 16) return frame.viewProj;
    return null;
  }

  /**
   * Resolve the culling frustum of a pass.
   * @param {Object} frame frame descriptor
   * @returns {?Object} object with `containsSphere`, or null
   */
  _resolveFrustum(frame) {
    if (!frame) return null;
    if (frame.frustum && typeof frame.frustum.containsSphere === 'function') return frame.frustum;
    if (frame.camera && frame.camera.frustum
        && typeof frame.camera.frustum.containsSphere === 'function') return frame.camera.frustum;
    return null;
  }

  /**
   * Interpolated world position of an entity, using `prevPosition` when the
   * caller supplies a render alpha.
   * @param {Object} entity entity
   * @param {number} alpha interpolation factor 0..1
   * @param {number[]} out receiver `[x,y,z]`
   * @returns {boolean} true when a position was found
   */
  _entityPosition(entity, alpha, out) {
    const p = entity.position;
    if (!p || p.length < 3) return false;
    const prev = entity.prevPosition || entity.lastPosition || entity.previousPosition;
    if (prev && prev.length >= 3 && alpha < 1) {
      out[0] = lerp(prev[0], p[0], alpha);
      out[1] = lerp(prev[1], p[1], alpha);
      out[2] = lerp(prev[2], p[2], alpha);
    } else {
      out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
    }
    return Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]);
  }

  /**
   * Sample and smooth the voxel light at a world position.
   * @param {Object} world chunk manager
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {Object} st per-entity animation state
   * @param {number} dt seconds since the last frame
   * @returns {Float32Array} `[r, g, b, sky]` in 0..1
   */
  _sampleLight(world, x, y, z, st, dt) {
    let r = 0; let g = 0; let b = 0; let s = 1;
    if (world && typeof world.getBlockLight === 'function') {
      const bx = Math.floor(x);
      const by = Math.floor(y);
      const bz = Math.floor(z);
      const l = world.getBlockLight(bx, by, bz, this._lightRGB);
      r = l[0] / 15; g = l[1] / 15; b = l[2] / 15;
      s = (typeof world.getSkyLight === 'function' ? world.getSkyLight(bx, by, bz) : 15) / 15;
    }
    const st4 = st.light;
    if (!st.lightReady) {
      st4[0] = r; st4[1] = g; st4[2] = b; st4[3] = s;
      st.lightReady = true;
    } else {
      st4[0] = damp(st4[0], r, 9, dt);
      st4[1] = damp(st4[1], g, 9, dt);
      st4[2] = damp(st4[2], b, 9, dt);
      st4[3] = damp(st4[3], s, 9, dt);
    }
    const out = this._light;
    out[0] = st4[0]; out[1] = st4[1]; out[2] = st4[2]; out[3] = st4[3];
    return out;
  }

  /**
   * Compose an entity's model matrix: translate, face, tip over on death, tilt
   * on damage, then scale from model units to blocks.
   * @param {Float32Array} out receiver
   * @param {number} x world X
   * @param {number} y world Y
   * @param {number} z world Z
   * @param {number} yaw body yaw in radians (`+Z` at 0)
   * @param {number} deathAngle death roll in radians
   * @param {number} hurtTilt hurt pitch in radians
   * @param {number} scale uniform model scale
   * @returns {Float32Array} `out`
   */
  _modelMatrix(out, x, y, z, yaw, deathAngle, hurtTilt, scale) {
    mat4.identity(out);
    out[12] = x; out[13] = y; out[14] = z;
    if (yaw) mat4.rotateY(out, out, yaw);
    if (deathAngle) mat4.rotateZ(out, out, deathAngle);
    if (hurtTilt) mat4.rotateX(out, out, hurtTilt);
    const s = scale * MODEL_UNIT;
    this._tmpVec[0] = s; this._tmpVec[1] = s; this._tmpVec[2] = s;
    mat4.scale(out, out, this._tmpVec);
    return out;
  }

  /**
   * Fetch a pooled draw record.
   * @param {number} i record index
   * @returns {Object} the record
   */
  _record(i) {
    let r = this._records[i];
    if (r === undefined) {
      r = {
        entity: null, kind: 0, visual: null, model: null, skinLayer: 0,
        blockId: 0, spriteLayer: 0, colors: null, count: 1, spin: 0,
        x: 0, y: 0, z: 0, dist: 0, key: 0, billboard: false,
      };
      this._records[i] = r;
    }
    return r;
  }

  /**
   * Map an entity type to a visual descriptor, falling back to the billboard
   * `item` model so an unknown mob still shows up.
   * @param {string} type entity type
   * @returns {?Object} visual descriptor
   */
  _visualFor(type) {
    const v = this.visuals.get(type);
    if (v) return v;
    return null;
  }

  /**
   * Resolve what a dropped/held item stack should look like.
   *
   * Uses `game/items.js` when it is available (`itemIcon()`, `itemToBlock()`),
   * and otherwise falls back to whatever the stack itself carries.
   *
   * @param {Object} stack an `ItemStack`-like object
   * @param {Object} out receiver `{kind, blockId, spriteLayer, colors}`
   * @returns {boolean} true when something drawable was resolved
   */
  _resolveIcon(stack, out) {
    out.kind = -1;
    out.blockId = 0;
    out.spriteLayer = 0;
    out.colors = null;
    if (!stack) return false;
    const items = this._items;
    const itemId = numField(stack, ['itemId', 'id', 'item'], -1);

    let icon = null;
    if (items && typeof items.itemIcon === 'function' && itemId >= 0) {
      try { icon = items.itemIcon(itemId); } catch (e) { icon = null; }
    }
    if (!icon && stack.icon) icon = stack.icon;

    if (icon && icon.type === 'block' && icon.blockId !== undefined) {
      out.kind = 1;
      out.blockId = icon.blockId | 0;
    } else if (icon && icon.type === 'sprite') {
      out.kind = 2;
      out.spriteLayer = this._spriteLayerFor(icon.pattern, stack.name || (icon.name || ''));
      out.colors = Array.isArray(icon.colors) ? icon.colors : null;
    } else if (items && typeof items.isBlockItem === 'function'
               && typeof items.itemToBlock === 'function' && itemId >= 0) {
      try {
        if (items.isBlockItem(itemId)) { out.kind = 1; out.blockId = items.itemToBlock(itemId) | 0; }
      } catch (e) { out.kind = -1; }
    }

    if (out.kind < 0) {
      const bid = numField(stack, ['blockId', 'block'], -1);
      if (bid > 0) { out.kind = 1; out.blockId = bid | 0; }
    }
    if (out.kind < 0) {
      out.kind = 2;
      out.spriteLayer = this._spriteLayerFor(null, String(stack.name || ''));
    }
    if (out.kind === 1 && (out.blockId | 0) <= 0) {
      out.kind = 2;
      out.spriteLayer = this._spriteLayerFor(null, String(stack.name || ''));
    }
    // Non-cube blocks look wrong as a cube; extrude their own texture instead.
    if (out.kind === 1 && blockRender(out.blockId) !== RENDER.CUBE) {
      out.kind = 3;
      out.spriteLayer = faceMaterial(out.blockId, 4);
    }
    return true;
  }

  /**
   * Pick an icon layer from a pattern name, falling back to keyword matching on
   * the item's name so unknown patterns still get a sensible sprite.
   * @param {?string} pattern pattern name from `itemIcon()`
   * @param {string} name item name
   * @returns {number} icon array layer
   */
  _spriteLayerFor(pattern, name) {
    if (pattern) {
      const direct = ITEM_PATTERN_INDEX.get(String(pattern));
      if (direct !== undefined) return direct;
    }
    const hay = `${pattern || ''} ${name || ''}`.toLowerCase();
    for (let i = ITEM_PATTERNS.length - 1; i >= 1; i--) {
      if (hay.indexOf(ITEM_PATTERNS[i]) >= 0) return i;
    }
    if (hay.indexOf('pick') >= 0) return ITEM_PATTERN_INDEX.get('pickaxe');
    if (hay.indexOf('shovel') >= 0 || hay.indexOf('spade') >= 0) return ITEM_PATTERN_INDEX.get('shovel');
    if (hay.indexOf('beef') >= 0 || hay.indexOf('pork') >= 0 || hay.indexOf('mutton') >= 0
        || hay.indexOf('chicken') >= 0) return ITEM_PATTERN_INDEX.get('meat');
    if (hay.indexOf('cod') >= 0 || hay.indexOf('salmon') >= 0) return ITEM_PATTERN_INDEX.get('fish');
    if (hay.indexOf('redstone') >= 0 || hay.indexOf('glowstone') >= 0
        || hay.indexOf('powder') >= 0) return ITEM_PATTERN_INDEX.get('dust');
    if (hay.indexOf('diamond') >= 0 || hay.indexOf('emerald') >= 0 || hay.indexOf('lapis') >= 0
        || hay.indexOf('quartz') >= 0 || hay.indexOf('amethyst') >= 0) return ITEM_PATTERN_INDEX.get('gem');
    if (hay.indexOf('ingot') >= 0 || hay.indexOf('scrap') >= 0) return ITEM_PATTERN_INDEX.get('ingot');
    return 0;
  }

  /**
   * Fill `this._itemColors` with the three tint zones of an item icon.
   * @param {?Array} colors colours from `itemIcon()`, or null
   * @param {number} layer icon layer, used to pick the fallback palette
   * @returns {Float32Array} nine floats, three RGB triples
   */
  _itemPalette(colors, layer) {
    const out = this._itemColors;
    const fallback = ITEM_PATTERN_COLORS[ITEM_PATTERNS[layer] || 'generic']
      || ITEM_PATTERN_COLORS.generic;
    for (let i = 0; i < 3; i++) {
      const c = colors && colors[i] && colors[i].length >= 3 ? colors[i] : fallback[i];
      out[i * 3] = c[0];
      out[i * 3 + 1] = c[1];
      out[i * 3 + 2] = c[2];
    }
    return out;
  }

  /**
   * Fixed item tint for a block (no biome context outside the world).
   * @param {number} blockId block id
   * @returns {ReadonlyArray<number>} `[r,g,b]`
   */
  _blockTint(blockId) {
    const t = blockTint(blockId);
    if (t && ITEM_TINTS[t]) return ITEM_TINTS[t];
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* Main entity pass                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Draw every visible entity.
   *
   * Frustum culls against a per-model sphere, drops anything beyond
   * `settings.entityDistance * renderDistance`, sorts by model so the VAO and
   * the skin binding change as rarely as possible, and writes the standard
   * G-buffer outputs with the voxel light sampled at the entity's own position
   * (so a mob in a cave really is dark). `pass:'shadow'` writes depth only and
   * takes its matrix from the light frame supplied by `render/shadows.js`.
   *
   * @param {Object|Array} entities entity manager, or a plain array of entities
   * @param {?Object} player the local player (drawn in third person, and always
   *        as a shadow caster)
   * @param {Object} frame the frame descriptor, or a shadow light frame
   * @param {Object} world chunk manager, for the voxel light probe
   * @param {{pass?:('gbuffer'|'shadow')}} [options] pass selector
   * @returns {number} draw calls issued
   */
  render(entities, player, frame, world, options) {
    const pass = options && options.pass ? options.pass : 'gbuffer';
    const shadow = pass === 'shadow';
    if (!this._ensureResources()) return 0;
    this._requestItems();
    if (world) this._lastWorld = world;

    const matrix = this._resolveMatrix(frame, shadow);
    if (!matrix) return 0;

    const camera = frame && frame.camera ? frame.camera : null;
    const camPos = camera && camera.position && camera.position.length >= 3
      ? camera.position : null;
    // In the shadow pass `camera.position` is the light's eye, which is useless
    // both for distance culling and for head look-at: reuse the player camera
    // the last G-buffer pass saw, so both passes agree on the pose.
    if (!shadow && camPos) {
      this._lastCamPos[0] = camPos[0];
      this._lastCamPos[1] = camPos[1];
      this._lastCamPos[2] = camPos[2];
      this._hasCamPos = true;
    }
    const ref = shadow ? this._lastCamPos : (camPos || this._lastCamPos);
    const cx = ref[0];
    const cy = ref[1];
    const cz = ref[2];

    const renderDistance = Number(this._setting('renderDistance', 10)) || 10;
    const entityScale = Number(this._setting('entityDistance', 1)) || 1;
    const maxDist = Math.max(32, renderDistance * 16 * entityScale);
    // Without a known player camera the cascade frustum is the only bound.
    const maxDistSq = (shadow && !this._hasCamPos) ? Infinity : maxDist * maxDist;
    const frustum = this._resolveFrustum(frame);
    const alpha = frame && typeof frame.alpha === 'number' ? clamp(frame.alpha, 0, 1) : 1;
    const dt = frame && typeof frame.dt === 'number' ? clamp(frame.dt, 0, 0.1) : 0.016;
    const time = frame && typeof frame.time === 'number' ? frame.time : 0;

    if (!shadow) this._frameCounter++;
    const frameId = frame && Number.isFinite(frame.frameIndex)
      ? (frame.frameIndex | 0) : this._frameCounter;

    const ctx = this._ctx
      || (this._ctx = { time: 0, dt: 0, frameId: 0, camX: 0, camY: 0, camZ: 0 });
    ctx.time = time; ctx.dt = dt; ctx.frameId = frameId;
    ctx.camX = cx; ctx.camY = cy; ctx.camZ = cz;

    if (!shadow) { this.stats.drawCalls = 0; this.stats.entities = 0; this.stats.triangles = 0; }

    const list = this._list;
    list.length = 0;
    let n = 0;

    const pos = this._tmpPos || (this._tmpPos = [0, 0, 0]);
    const icon = this._tmpIcon || (this._tmpIcon = { kind: -1, blockId: 0, spriteLayer: 0, colors: null });

    /* -------- collect ------------------------------------------------- */
    const push = (entity, forcedType) => {
      if (!entity || entity.removed === true) return;
      if (!this._entityPosition(entity, alpha, pos)) return;
      const dx = pos[0] - cx;
      const dy = pos[1] - cy;
      const dz = pos[2] - cz;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > maxDistSq) return;

      const type = String(forcedType || entity.type || 'unknown');
      const rec = this._record(n);
      rec.entity = entity;
      rec.x = pos[0]; rec.y = pos[1]; rec.z = pos[2];
      rec.dist = distSq;
      rec.colors = null;
      rec.count = 1;
      rec.billboard = false;

      if (ITEM_ENTITY_TYPES.has(type)) {
        const stack = entity.stack || entity.itemStack || entity.item || null;
        if (type === 'xp_orb' || type === 'experience_orb') {
          rec.kind = 2;
          rec.spriteLayer = ITEM_PATTERN_INDEX.get('orb');
          rec.colors = null;
        } else {
          if (!this._resolveIcon(stack, icon)) return;
          rec.kind = icon.kind === 1 ? 1 : (icon.kind === 3 ? 3 : 2);
          rec.blockId = icon.blockId;
          rec.spriteLayer = icon.spriteLayer;
          rec.colors = icon.colors;
          rec.count = clamp(numField(stack, ['count'], 1) | 0, 1, 64);
        }
        rec.model = null;
        rec.visual = null;
        rec.spin = 1;
        if (frustum && !frustum.containsSphere(rec.x, rec.y + 0.2, rec.z, 0.6)) return;
      } else if (BLOCK_ENTITY_TYPES.has(type)) {
        const bid = numField(entity, ['blockId', 'block'], 0) | 0;
        if (bid <= 0) return;
        rec.kind = 1;
        rec.blockId = bid;
        rec.model = null;
        rec.visual = null;
        rec.spin = 0;
        if (frustum && !frustum.containsSphere(rec.x, rec.y + 0.5, rec.z, 1.1)) return;
      } else {
        const visual = this._visualFor(type) || FALLBACK_VISUAL;
        const model = this._getModel(visual.model);
        if (!model) return;
        const scale = visual.scale === undefined ? 1 : visual.scale;
        if (frustum && !frustum.containsSphere(rec.x, rec.y + model.height * 0.5, rec.z,
          model.radius * scale + 0.5)) return;
        rec.kind = 0;
        rec.visual = visual;
        rec.model = model;
        rec.skinLayer = SKIN_INDEX.has(visual.skin) ? SKIN_INDEX.get(visual.skin) : SKIN_INDEX.get('generic');
        rec.billboard = model.billboard;
      }

      rec.key = rec.kind * 1048576
        + (rec.kind === 0 ? (rec.model ? rec.model.uid : 0) * 256 + rec.skinLayer
          : (rec.kind === 1 ? rec.blockId : rec.spriteLayer));
      list.push(rec);
      n++;
    };

    if (Array.isArray(entities)) {
      for (let i = 0; i < entities.length; i++) push(entities[i], null);
    } else if (entities && entities.entities && typeof entities.entities.forEach === 'function') {
      entities.entities.forEach((e) => push(e, null));
    } else if (entities && typeof entities.forEach === 'function') {
      entities.forEach((e) => push(e, null));
    }

    // The player: visible in third person, and always a shadow caster.
    if (player && player.position) {
      const perspective = numField(player, ['perspective', 'cameraMode', 'view'], 0) | 0;
      if (shadow || perspective !== 0) {
        const proxy = this._playerProxy;
        proxy.position = player.position;
        proxy.prevPosition = player.prevPosition || player.lastPosition || null;
        proxy.velocity = player.velocity || proxy.velocity;
        proxy.health = player.health === undefined ? 20 : player.health;
        proxy.dead = !!player.dead || (player.health !== undefined && player.health <= 0);
        proxy.hurtTime = numField(player, ['hurtTime', 'hurtTicks'], 0);
        proxy.sneaking = !!player.sneaking;
        proxy.swinging = !!player.swinging;
        proxy.swingProgress = numField(player, ['swingProgress', 'attackAnim'], -1);
        proxy.target = null;
        const fwd = camera && camera.forward && camera.forward.length >= 3 ? camera.forward : null;
        proxy.modelYaw = fwd ? Math.atan2(fwd[0], fwd[2])
          : numField(player, ['yaw'], this._playerProxy.modelYaw);
        push(proxy, 'player');
      }
    }

    if (list.length === 0) return 0;

    list.sort(compareRecords);

    /* -------- draw ---------------------------------------------------- */
    const device = this.device;
    const gl = this.raw;
    let draws = 0;
    try {
      device.setDepthTest(true);
      device.setDepthFunc(gl.LEQUAL);
      device.setDepthWrite(true);
      device.setBlend('none');
      device.setCull('back');
      draws = this._drawList(list, matrix, shadow, world, ctx, dt, time);
    } catch (err) {
      if (!this._logged) {
        this._logged = true;
        console.error('[VOXELIA] entities: the entity pass failed; entities will not draw.', err);
      }
      this._failed = true;
    } finally {
      device.bindVertexArray(null);
    }

    if (!shadow) {
      this.stats.drawCalls = draws;
      this.stats.entities = list.length;
    }
    return draws;
  }

  /**
   * Issue the sorted draw list.
   * @param {Object[]} list sorted records
   * @param {ArrayLike<number>} matrix world-to-clip matrix
   * @param {boolean} shadow depth-only pass
   * @param {Object} world chunk manager
   * @param {Object} ctx frame context for the animator
   * @param {number} dt seconds since the last frame
   * @param {number} time seconds
   * @returns {number} draw calls issued
   */
  _drawList(list, matrix, shadow, world, ctx, dt, time) {
    const device = this.device;
    const jitter = shadow ? 0 : 1;
    const depthOnly = shadow ? 1 : 0;
    let draws = 0;
    let currentKind = -1;
    let currentModel = null;
    let program = null;

    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      if (rec.kind !== currentKind) {
        currentKind = rec.kind;
        currentModel = null;
        program = this._beginKind(rec.kind, matrix, jitter, depthOnly);
        if (!program) continue;
      }
      if (!program) continue;

      if (rec.kind === 0) {
        if (rec.model !== currentModel) {
          currentModel = rec.model;
          device.bindVertexArray(rec.model.vao);
        }
        draws += this._drawSkinned(program, rec, world, ctx, dt);
      } else if (rec.kind === 1) {
        if (currentModel !== this._cube) { currentModel = this._cube; device.bindVertexArray(this._cube.vao); }
        draws += this._drawBlockItem(program, rec, world, ctx, dt, time);
      } else {
        if (currentModel !== this._sprite) { currentModel = this._sprite; device.bindVertexArray(this._sprite.vao); }
        draws += this._drawSpriteItem(program, rec, world, ctx, dt, time);
      }
    }
    device.setCull('back');
    return draws;
  }

  /**
   * Bind the program and the constant per-pass uniforms for one record kind.
   * @param {number} kind `0` skinned, `1` block cube, `2`/`3` sprite
   * @param {ArrayLike<number>} matrix world-to-clip matrix
   * @param {number} jitter 1 to apply the TAA jitter, 0 otherwise
   * @param {number} depthOnly 1 for the shadow pass
   * @returns {?Object} the bound program
   */
  _beginKind(kind, matrix, jitter, depthOnly) {
    const device = this.device;
    const gl = this.raw;
    let program = null;
    if (kind === 0) {
      program = this.programs.entity;
      if (!program || !program.use()) return null;
      program.bindUBO('Frame', FRAME_BINDING);
      program.setMat4('u_renderProj', matrix);
      program.setFloat('u_jitterAmount', jitter);
      program.setInt('u_depthOnly', depthOnly);
      program.setInt('u_skinCount', SKINS.length);
      program.setTexture('u_skins', this.skinArray, UNIT_ENTITY, gl.TEXTURE_2D_ARRAY);
      device.setCull('back');
    } else if (kind === 1) {
      program = this.programs.cube;
      if (!program || !program.use()) return null;
      program.bindUBO('Frame', FRAME_BINDING);
      program.setMat4('u_renderProj', matrix);
      program.setFloat('u_jitterAmount', jitter);
      program.setInt('u_depthOnly', depthOnly);
      program.setFloat('u_expand', 0);
      program.setFloat('u_crackStage', 0);
      program.setVec3('u_boxMin', 0, 0, 0);
      program.setVec3('u_boxMax', 1, 1, 1);
      if (this.textures && typeof this.textures.bindArrays === 'function') this.textures.bindArrays(program);
      device.setCull('back');
    } else {
      program = this.programs.sprite;
      if (!program || !program.use()) return null;
      program.bindUBO('Frame', FRAME_BINDING);
      program.setMat4('u_renderProj', matrix);
      program.setFloat('u_jitterAmount', jitter);
      program.setInt('u_depthOnly', depthOnly);
      program.setFloat('u_texel', kind === 3 ? 1 / 32 : 1 / 16);
      program.setTexture('u_icons', this.iconArray, UNIT_ENTITY, gl.TEXTURE_2D_ARRAY);
      if (this.textures && typeof this.textures.bindArrays === 'function') this.textures.bindArrays(program);
      device.setCull('none');
    }
    return program;
  }

  /**
   * Draw one skinned mob: pose, bone upload, light probe, one `drawElements`.
   * @param {Object} program the skinned program
   * @param {Object} rec draw record
   * @param {Object} world chunk manager
   * @param {Object} ctx frame context
   * @param {number} dt seconds since the last frame
   * @returns {number} draw calls issued
   */
  _drawSkinned(program, rec, world, ctx, dt) {
    const gl = this.raw;
    const model = rec.model;
    const entity = rec.entity;
    const st = this._animator.state(entity);
    const res = this._animator.animate(model, rec.visual, entity, ctx, this._pose, rec.x, rec.y, rec.z);
    const bones = this._pose.build();

    let yaw = res.bodyYaw;
    if (rec.billboard) yaw = Math.atan2(ctx.camX - rec.x, ctx.camZ - rec.z);
    this._modelMatrix(this._model, rec.x, rec.y + res.yOffset, rec.z,
      yaw, res.deathAngle, res.hurtTilt, res.scale);

    const light = this._sampleLight(world, rec.x, rec.y + model.height * 0.5, rec.z, st, dt);
    program.setMat4('u_model', this._model);
    program.setMat4Array('u_bones[0]', bones);
    program.setInt('u_skinLayer', rec.skinLayer);
    program.setVec4('u_light', light[0], light[1], light[2], light[3]);
    program.setVec4('u_overlay', res.overlay[0], res.overlay[1], res.overlay[2], res.overlay[3]);
    program.setVec4('u_material', 0.5, res.emissive, res.subsurface, 1);
    gl.drawElements(gl.TRIANGLES, model.indexCount, gl.UNSIGNED_SHORT, 0);
    this.stats.triangles += model.indexCount / 3;
    return 1;
  }

  /**
   * Upload the six texture-array layers of a block into `u_faceLayer`.
   * @param {Object} program the cube program
   * @param {number} blockId block id
   * @returns {void}
   */
  _bindBlockFaces(program, blockId) {
    for (let f = 0; f < 6; f++) this._faceLayers[f] = faceMaterial(blockId, f);
    program.setFloatArray('u_faceLayer[0]', this._faceLayers);
    const tint = this._blockTint(blockId);
    if (tint) program.setVec3('u_tint', tint[0], tint[1], tint[2]);
    else program.setVec3('u_tint', 1, 1, 1);
  }

  /**
   * Draw a block as a solid cube: dropped block items spin and bob and stack up
   * to three overlapping copies; block entities (TNT, falling blocks) draw at
   * full size on the spot.
   * @param {Object} program the cube program
   * @param {Object} rec draw record
   * @param {Object} world chunk manager
   * @param {Object} ctx frame context
   * @param {number} dt seconds since the last frame
   * @param {number} time seconds
   * @returns {number} draw calls issued
   */
  _drawBlockItem(program, rec, world, ctx, dt, time) {
    const gl = this.raw;
    const st = this._animator.state(rec.entity);
    const drop = rec.spin === 1;
    this._bindBlockFaces(program, rec.blockId);

    const def = getBlock(rec.blockId);
    const cutout = def && def.cutout ? 0.5 : 0.02;
    const light = this._sampleLight(world, rec.x, rec.y + 0.4, rec.z, st, dt);
    program.setVec4('u_light', light[0], light[1], light[2], light[3]);
    program.setVec4('u_material', cutout, 0, 0, 1);

    let flash = 0;
    if (!drop) {
      const fuse = numField(rec.entity, ['fuseTime', 'fuse'], -1);
      if (fuse >= 0) flash = (Math.floor(time * 10) % 2) === 0 ? 0.85 : 0;
    }
    program.setVec4('u_overlay', 1, 1, 1, flash);

    const copies = drop ? (rec.count >= 32 ? 3 : (rec.count >= 5 ? 2 : 1)) : 1;
    const size = drop ? 0.32 : 0.99;
    const angle = drop ? time * 1.4 + st.spin : 0;
    const bob = drop ? Math.sin(time * 2.1 + st.spin) * 0.055 : 0;
    let draws = 0;
    for (let c = 0; c < copies; c++) {
      const ox = drop ? (c - (copies - 1) * 0.5) * 0.09 : 0;
      const oz = drop ? (c % 2 === 0 ? 0.05 : -0.05) : 0;
      const m = this._model;
      mat4.identity(m);
      m[12] = rec.x + ox;
      m[13] = rec.y + (drop ? 0.22 + bob + c * 0.035 : 0);
      m[14] = rec.z + oz;
      if (angle) mat4.rotateY(m, m, angle + c * 0.35);
      this._tmpVec[0] = size; this._tmpVec[1] = size; this._tmpVec[2] = size;
      mat4.scale(m, m, this._tmpVec);
      this._tmpVec[0] = -0.5; this._tmpVec[1] = drop ? -0.5 : 0; this._tmpVec[2] = -0.5;
      mat4.translate(m, m, this._tmpVec);
      program.setMat4('u_model', m);
      gl.drawElements(gl.TRIANGLES, this._cube.count, gl.UNSIGNED_SHORT, 0);
      draws++;
      this.stats.triangles += this._cube.count / 3;
    }
    return draws;
  }

  /**
   * Draw a flat item as an extruded sprite: a stack of alpha-tested slices whose
   * rim normal comes from the icon's own coverage gradient.
   * @param {Object} program the sprite program
   * @param {Object} rec draw record
   * @param {Object} world chunk manager
   * @param {Object} ctx frame context
   * @param {number} dt seconds since the last frame
   * @param {number} time seconds
   * @returns {number} draw calls issued
   */
  _drawSpriteItem(program, rec, world, ctx, dt, time) {
    const gl = this.raw;
    const st = this._animator.state(rec.entity);
    const blockSource = rec.kind === 3;

    program.setInt('u_spriteMode', blockSource ? 1 : 0);
    program.setFloat('u_spriteLayer', rec.spriteLayer);
    if (blockSource) {
      const tint = this._blockTint(rec.blockId);
      program.setVec3('u_tint', tint ? tint[0] : 1, tint ? tint[1] : 1, tint ? tint[2] : 1);
    } else {
      program.setVec3Array('u_itemColors[0]', this._itemPalette(rec.colors, rec.spriteLayer));
      program.setVec3('u_tint', 1, 1, 1);
    }

    const isOrb = !blockSource && rec.spriteLayer === ITEM_PATTERN_INDEX.get('orb');
    const light = this._sampleLight(world, rec.x, rec.y + 0.3, rec.z, st, dt);
    program.setVec4('u_light', light[0], light[1], light[2], light[3]);
    program.setVec4('u_material', 0.5, isOrb ? 0.85 : 0, 0, 1);
    program.setVec4('u_overlay', 1, 1, 1, 0);

    const copies = rec.count >= 32 ? 3 : (rec.count >= 5 ? 2 : 1);
    const angle = time * 1.4 + st.spin;
    const bob = Math.sin(time * 2.1 + st.spin) * 0.055;
    let draws = 0;
    for (let c = 0; c < copies; c++) {
      const m = this._model;
      mat4.identity(m);
      m[12] = rec.x;
      m[13] = rec.y + 0.25 + bob;
      m[14] = rec.z;
      mat4.rotateY(m, m, angle);
      this._tmpVec[0] = 0.5; this._tmpVec[1] = 0.5; this._tmpVec[2] = 1;
      mat4.scale(m, m, this._tmpVec);
      this._tmpVec[0] = 0; this._tmpVec[1] = 0; this._tmpVec[2] = (c - (copies - 1) * 0.5) * 0.09;
      mat4.translate(m, m, this._tmpVec);
      program.setMat4('u_model', m);
      gl.drawElements(gl.TRIANGLES, this._sprite.count, gl.UNSIGNED_SHORT, 0);
      draws++;
      this.stats.triangles += this._sprite.count / 3;
    }
    return draws;
  }

  /* ---------------------------------------------------------------------- */
  /* First-person hand                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Start (or restart) the first-person swing animation.
   * @returns {void}
   */
  triggerSwing() {
    this._hand.swinging = true;
    this._hand.swing = 0;
  }

  /**
   * Find the stack the player is holding, whatever inventory shape is in use.
   * @param {Object} player the player
   * @returns {?Object} the held `ItemStack`, or null
   */
  _heldStack(player) {
    if (!player) return null;
    try {
      if (typeof player.getHeldItem === 'function') return player.getHeldItem();
      const inv = player.inventory;
      if (inv) {
        if (typeof inv.getSelected === 'function') return inv.getSelected();
        const slot = numField(player, ['selectedSlot'], numField(inv, ['selected'], 0)) | 0;
        if (typeof inv.get === 'function') return inv.get(slot);
        if (Array.isArray(inv.slots)) return inv.slots[slot] || null;
      }
      if (typeof player.getSelected === 'function') return player.getSelected();
    } catch (e) {
      return null;
    }
    return null;
  }

  /**
   * Draw the first-person arm and the held item.
   *
   * Uses its own narrow projection (fov 70, near 0.01) and a reserved window
   * depth slice, so the hand can never be clipped by the world's near plane nor
   * hidden by geometry, while still writing a coherent G-buffer. The light comes
   * from the player's own position, and blocks draw as real textured cubes while
   * everything else is an extruded sprite of the item icon.
   *
   * @param {Object} player the local player
   * @param {Object} frame the frame descriptor
   * @param {Object} world chunk manager
   * @returns {number} draw calls issued
   */
  renderHeldItem(player, frame, world) {
    if (!player || !frame || !frame.camera) return 0;
    if (!this._ensureResources()) return 0;
    this._requestItems();
    if (world) this._lastWorld = world;

    const perspective = numField(player, ['perspective', 'cameraMode', 'view'], 0) | 0;
    if (perspective !== 0) return 0;

    const camera = frame.camera;
    if (!camera.view || camera.view.length !== 16) return 0;
    if (!mat4.invert(this._invView, camera.view)) return 0;

    const dt = typeof frame.dt === 'number' ? clamp(frame.dt, 0, 0.1) : 0.016;
    const time = typeof frame.time === 'number' ? frame.time : 0;
    const hand = this._hand;

    /* -------- bob, sway, swing, equip --------------------------------- */
    const vel = player.velocity;
    let speed = 0;
    if (vel && vel.length >= 3) speed = Math.hypot(vel[0], vel[2]);
    const bobbing = this._setting('viewBobbing', true) ? 1 : 0;
    hand.bob += speed * dt * 2.6;
    hand.bobAmount = damp(hand.bobAmount, clamp(speed / WALK_REFERENCE_SPEED, 0, 1) * bobbing, 8, dt);

    const yaw = numField(camera, ['yaw'], numField(player, ['yaw'], 0));
    const pitch = numField(camera, ['pitch'], numField(player, ['pitch'], 0));
    if (!hand.hasLast) { hand.lastYaw = yaw; hand.lastPitch = pitch; hand.hasLast = true; }
    const dYaw = clamp(wrapAngle(yaw - hand.lastYaw) / Math.max(dt, 1e-4) * 0.02, -0.5, 0.5);
    const dPitch = clamp((pitch - hand.lastPitch) / Math.max(dt, 1e-4) * 0.02, -0.5, 0.5);
    hand.lastYaw = yaw; hand.lastPitch = pitch;
    hand.sway = damp(hand.sway, dYaw, 12, dt);
    hand.swayY = damp(hand.swayY, dPitch, 12, dt);

    let swing = numField(player, ['swingProgress', 'attackAnim'], -1);
    if (swing < 0) {
      if (player.swinging) hand.swinging = true;
      if (hand.swinging) {
        hand.swing += dt * 3.4;
        if (hand.swing >= 1) { hand.swing = 0; hand.swinging = false; }
      }
      swing = hand.swing;
    }
    swing = clamp(swing, 0, 1);

    const stack = this._heldStack(player);
    const icon = this._tmpIcon || (this._tmpIcon = { kind: -1, blockId: 0, spriteLayer: 0, colors: null });
    const hasItem = !!stack && !(typeof stack.isEmpty === 'function' && stack.isEmpty());
    if (hasItem) this._resolveIcon(stack, icon); else icon.kind = -1;
    const itemKey = hasItem ? (icon.kind * 65536 + (icon.kind === 1 || icon.kind === 3 ? icon.blockId : icon.spriteLayer)) : -1;
    if (itemKey !== hand.lastItemKey) { hand.lastItemKey = itemKey; hand.equip = 0; }
    hand.equip = Math.min(1, hand.equip + dt * 5.5);

    const bobX = Math.sin(hand.bob) * 0.055 * hand.bobAmount;
    const bobY = -Math.abs(Math.cos(hand.bob)) * 0.045 * hand.bobAmount;
    const s1 = Math.sin(swing * Math.PI);
    const s2 = Math.sin(Math.sqrt(swing) * Math.PI);
    const equipDrop = (1 - hand.equip) * 0.55;

    /* -------- projection ---------------------------------------------- */
    const aspect = camera.aspect && camera.aspect > 0 ? camera.aspect : this.width / Math.max(1, this.height);
    mat4.perspective(this._handProj, 70 * Math.PI / 180, aspect, 0.01, 16);
    mat4.multiply(this._handVP, this._handProj, camera.view);

    const device = this.device;
    const gl = this.raw;
    const eyeY = numField(player, ['eyeHeight'], 1.62);
    const px = player.position ? player.position[0] : 0;
    const py = (player.position ? player.position[1] : 0) + eyeY;
    const pz = player.position ? player.position[2] : 0;
    const st = this._animator.state(player);
    const light = this._sampleLight(world, px, py, pz, st, dt);

    let draws = 0;
    try {
      gl.depthRange(0, HAND_DEPTH_RANGE);
      device.setDepthTest(true);
      device.setDepthFunc(gl.LEQUAL);
      device.setDepthWrite(true);
      device.setBlend('none');
      device.setCull('back');

      /* ---- the arm --------------------------------------------------- */
      const armModel = this._getModel('humanoid');
      const armProgram = this.programs.entity;
      if (armModel && armProgram && armProgram.use()) {
        armProgram.bindUBO('Frame', FRAME_BINDING);
        armProgram.setMat4('u_renderProj', this._handVP);
        armProgram.setFloat('u_jitterAmount', 1);
        armProgram.setInt('u_depthOnly', 0);
        armProgram.setInt('u_skinCount', SKINS.length);
        armProgram.setInt('u_skinLayer', SKIN_INDEX.get('player'));
        armProgram.setTexture('u_skins', this.skinArray, UNIT_ENTITY, gl.TEXTURE_2D_ARRAY);

        const pose = this._pose;
        pose.reset(armModel);
        for (let i = 0; i < armModel.parts.length; i++) {
          if (armModel.parts[i].name !== 'arm_r') pose.hide(armModel.parts[i].name);
        }
        pose.rotate('arm_r', Math.sin(time * 1.4) * 0.03, 0, 0);
        const bones = pose.build();

        const a = this._scratchA;
        mat4.identity(a);
        a[12] = 0.62 + bobX + hand.sway * 0.35 - s2 * 0.24;
        a[13] = -0.66 + bobY + hand.swayY * 0.30 + s1 * 0.20 - equipDrop;
        a[14] = -0.70 - s1 * 0.24;
        mat4.rotateY(a, a, -0.28 + s2 * 0.55);
        mat4.rotateX(a, a, 1.18 - s1 * 0.95);
        mat4.rotateZ(a, a, 0.22);
        this._tmpVec[0] = MODEL_UNIT; this._tmpVec[1] = MODEL_UNIT; this._tmpVec[2] = MODEL_UNIT;
        mat4.scale(a, a, this._tmpVec);
        this._tmpVec[0] = 6; this._tmpVec[1] = -22; this._tmpVec[2] = 0;
        mat4.translate(a, a, this._tmpVec);
        mat4.multiply(this._model, this._invView, a);

        armProgram.setMat4('u_model', this._model);
        armProgram.setMat4Array('u_bones[0]', bones);
        armProgram.setVec4('u_light', light[0], light[1], light[2], light[3]);
        armProgram.setVec4('u_overlay', 1, 1, 1, 0);
        armProgram.setVec4('u_material', 0.5, 0, 0, 1);
        device.bindVertexArray(armModel.vao);
        gl.drawElements(gl.TRIANGLES, armModel.indexCount, gl.UNSIGNED_SHORT, 0);
        draws++;
      }

      /* ---- the held item --------------------------------------------- */
      if (hasItem && icon.kind >= 0) {
        const a = this._scratchA;
        mat4.identity(a);
        a[12] = 0.46 + bobX * 0.8 + hand.sway * 0.30 - s2 * 0.20;
        a[13] = -0.44 + bobY * 0.8 + hand.swayY * 0.26 + s1 * 0.16 - equipDrop;
        a[14] = -0.62 - s1 * 0.20;
        mat4.rotateY(a, a, -0.55 + s2 * 0.45);
        mat4.rotateX(a, a, 0.15 - s1 * 0.85);

        if (icon.kind === 1) {
          const program = this.programs.cube;
          if (program && program.use()) {
            program.bindUBO('Frame', FRAME_BINDING);
            program.setMat4('u_renderProj', this._handVP);
            program.setFloat('u_jitterAmount', 1);
            program.setInt('u_depthOnly', 0);
            program.setFloat('u_expand', 0);
            program.setFloat('u_crackStage', 0);
            program.setVec3('u_boxMin', 0, 0, 0);
            program.setVec3('u_boxMax', 1, 1, 1);
            if (this.textures && typeof this.textures.bindArrays === 'function') this.textures.bindArrays(program);
            this._bindBlockFaces(program, icon.blockId);
            const def = getBlock(icon.blockId);
            program.setVec4('u_material', def && def.cutout ? 0.5 : 0.02, 0, 0, 1);
            program.setVec4('u_light', light[0], light[1], light[2], light[3]);
            program.setVec4('u_overlay', 1, 1, 1, 0);
            mat4.rotateY(a, a, 0.55);
            this._tmpVec[0] = 0.42; this._tmpVec[1] = 0.42; this._tmpVec[2] = 0.42;
            mat4.scale(a, a, this._tmpVec);
            this._tmpVec[0] = -0.5; this._tmpVec[1] = -0.5; this._tmpVec[2] = -0.5;
            mat4.translate(a, a, this._tmpVec);
            mat4.multiply(this._model, this._invView, a);
            program.setMat4('u_model', this._model);
            device.bindVertexArray(this._cube.vao);
            gl.drawElements(gl.TRIANGLES, this._cube.count, gl.UNSIGNED_SHORT, 0);
            draws++;
          }
        } else {
          const program = this.programs.sprite;
          if (program && program.use()) {
            const blockSource = icon.kind === 3;
            program.bindUBO('Frame', FRAME_BINDING);
            program.setMat4('u_renderProj', this._handVP);
            program.setFloat('u_jitterAmount', 1);
            program.setInt('u_depthOnly', 0);
            program.setFloat('u_texel', blockSource ? 1 / 32 : 1 / 16);
            program.setInt('u_spriteMode', blockSource ? 1 : 0);
            program.setFloat('u_spriteLayer', icon.spriteLayer);
            program.setTexture('u_icons', this.iconArray, UNIT_ENTITY, gl.TEXTURE_2D_ARRAY);
            if (this.textures && typeof this.textures.bindArrays === 'function') this.textures.bindArrays(program);
            if (blockSource) {
              const tint = this._blockTint(icon.blockId);
              program.setVec3('u_tint', tint ? tint[0] : 1, tint ? tint[1] : 1, tint ? tint[2] : 1);
            } else {
              program.setVec3Array('u_itemColors[0]', this._itemPalette(icon.colors, icon.spriteLayer));
              program.setVec3('u_tint', 1, 1, 1);
            }
            program.setVec4('u_light', light[0], light[1], light[2], light[3]);
            program.setVec4('u_material', 0.5, 0, 0, 1);
            program.setVec4('u_overlay', 1, 1, 1, 0);
            mat4.rotateZ(a, a, 0.62);
            mat4.rotateY(a, a, 0.30);
            this._tmpVec[0] = 0.62; this._tmpVec[1] = 0.62; this._tmpVec[2] = 1.4;
            mat4.scale(a, a, this._tmpVec);
            mat4.multiply(this._model, this._invView, a);
            program.setMat4('u_model', this._model);
            device.setCull('none');
            device.bindVertexArray(this._sprite.vao);
            gl.drawElements(gl.TRIANGLES, this._sprite.count, gl.UNSIGNED_SHORT, 0);
            device.setCull('back');
            draws++;
          }
        }
      }
    } catch (err) {
      if (!this._logged) {
        this._logged = true;
        console.error('[VOXELIA] entities: the held-item pass failed.', err);
      }
    } finally {
      gl.depthRange(0, 1);
      device.bindVertexArray(null);
    }
    this.stats.drawCalls += draws;
    return draws;
  }

  /* ---------------------------------------------------------------------- */
  /* Selection outline & break overlay                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Draw the selection wireframe around the targeted block.
   *
   * The box list comes from `blockAABBs()`, so slabs, stairs, torches, fences
   * and plants outline their real shape instead of a full cube. Lines cannot use
   * a polygon offset in WebGL2, so the geometry is inflated by a hair and the
   * vertex stage pulls clip Z toward the camera — together that removes the
   * z-fighting with the block face behind it.
   *
   * @param {?Object} hit raycast hit `{x,y,z,blockId,state?}` from `world.raycast`
   * @param {Object} frame the frame descriptor
   * @param {{pass?:('gbuffer'|'forward'), color?:number[], width?:number}} [options]
   *        `pass` defaults to `'gbuffer'` (write the deferred contract); use
   *        `'forward'` when drawing over an already-lit target
   * @returns {number} draw calls issued
   */
  renderBlockOutline(hit, frame, options) {
    if (!hit || !frame) return 0;
    if (!this._ensureResources()) return 0;
    const matrix = this._resolveMatrix(frame, false);
    if (!matrix) return 0;
    const program = this.programs.outline;
    if (!program || !program.use()) return 0;

    const blockId = numField(hit, ['blockId', 'block', 'id'], 0) | 0;
    const state = numField(hit, ['state'], 0) | 0;
    let boxes = null;
    try { boxes = blockAABBs(blockId, state); } catch (e) { boxes = null; }
    if (!boxes || boxes.length === 0) boxes = UNIT_AABB;

    const ox = Math.floor(numField(hit, ['x'], 0));
    const oy = Math.floor(numField(hit, ['y'], 0));
    const oz = Math.floor(numField(hit, ['z'], 0));
    const data = this._outlineData;
    const pad = 0.0022;
    let v = 0;
    const boxCount = Math.min(boxes.length, this._outlineCapacity / 24);
    for (let b = 0; b < boxCount; b++) {
      const box = boxes[b];
      if (!box || box.length < 6) continue;
      const x0 = ox + box[0] - pad;
      const y0 = oy + box[1] - pad;
      const z0 = oz + box[2] - pad;
      const x1 = ox + box[3] + pad;
      const y1 = oy + box[4] + pad;
      const z1 = oz + box[5] + pad;
      for (let e = 0; e < 12; e++) {
        const ei = EDGE_TABLE[e];
        for (let k = 0; k < 2; k++) {
          const c = ei[k];
          data[v++] = (c & 1) ? x1 : x0;
          data[v++] = (c & 2) ? y1 : y0;
          data[v++] = (c & 4) ? z1 : z0;
        }
      }
    }
    if (v === 0) return 0;

    const device = this.device;
    const gl = this.raw;
    const forward = options && options.pass === 'forward' ? 1 : 0;
    const color = (options && options.color) || OUTLINE_COLOR;
    let draws = 0;
    try {
      device.updateBuffer(this._outlineVBO, gl.ARRAY_BUFFER, data.subarray(0, v), 0);
      program.bindUBO('Frame', FRAME_BINDING);
      program.setMat4('u_renderProj', matrix);
      program.setFloat('u_depthBias', 0.00035);
      program.setInt('u_forward', forward);
      program.setVec4('u_color', color[0], color[1], color[2], color.length > 3 ? color[3] : 1);
      device.setDepthTest(true);
      device.setDepthFunc(gl.LEQUAL);
      device.setDepthWrite(false);
      device.setBlend(forward ? 'alpha' : 'none');
      device.setCull('none');
      device.bindVertexArray(this._outlineVAO);
      gl.drawArrays(gl.LINES, 0, v / 3);
      draws = 1;
      this.stats.drawCalls += 1;
    } catch (err) {
      if (!this._logged) {
        this._logged = true;
        console.error('[VOXELIA] entities: the block outline failed to draw.', err);
      }
    } finally {
      device.bindVertexArray(null);
      device.setDepthWrite(true);
      device.setBlend('none');
    }
    return draws;
  }

  /**
   * Draw the ten-stage break overlay over the block being mined.
   *
   * The block's own faces are re-rendered from its real AABBs with the
   * procedural crack field multiplied onto the albedo, so the overlay is a
   * single opaque G-buffer write (no blending, no separate texture) and slabs
   * and torches crack in the right shape.
   *
   * @param {?Object} hit raycast hit `{x,y,z,blockId,state?}`
   * @param {number} progress break progress 0..1
   * @param {Object} frame the frame descriptor
   * @returns {number} draw calls issued
   */
  renderBreakOverlay(hit, progress, frame) {
    if (!hit || !frame || !(progress > 0)) return 0;
    if (!this._ensureResources()) return 0;
    const matrix = this._resolveMatrix(frame, false);
    if (!matrix) return 0;
    const program = this.programs.cube;
    if (!program || !program.use()) return 0;

    const blockId = numField(hit, ['blockId', 'block', 'id'], 0) | 0;
    if (blockId <= 0) return 0;
    const state = numField(hit, ['state'], 0) | 0;
    let boxes = null;
    try { boxes = blockAABBs(blockId, state); } catch (e) { boxes = null; }
    if (!boxes || boxes.length === 0) boxes = UNIT_AABB;

    const ox = Math.floor(numField(hit, ['x'], 0));
    const oy = Math.floor(numField(hit, ['y'], 0));
    const oz = Math.floor(numField(hit, ['z'], 0));
    const stage = (Math.min(9, Math.floor(clamp(progress, 0, 1) * 10)) + 1) / 10;

    const device = this.device;
    const gl = this.raw;
    let draws = 0;
    try {
      program.bindUBO('Frame', FRAME_BINDING);
      program.setMat4('u_renderProj', matrix);
      program.setFloat('u_jitterAmount', 1);
      program.setInt('u_depthOnly', 0);
      program.setFloat('u_expand', 0.0016);
      program.setFloat('u_crackStage', stage);
      if (this.textures && typeof this.textures.bindArrays === 'function') this.textures.bindArrays(program);
      this._bindBlockFaces(program, blockId);

      const def = getBlock(blockId);
      program.setVec4('u_material', def && def.cutout ? 0.5 : 0.02, 0, 0, 1);
      program.setVec4('u_overlay', 1, 1, 1, 0);

      const world = this._lastWorld;
      let r = 0; let g = 0; let b = 0; let s = 1;
      if (world && typeof world.getBlockLight === 'function') {
        const l = world.getBlockLight(ox, oy, oz, this._lightRGB);
        r = l[0] / 15; g = l[1] / 15; b = l[2] / 15;
        s = (typeof world.getSkyLight === 'function' ? world.getSkyLight(ox, oy, oz) : 15) / 15;
      }
      program.setVec4('u_light', r, g, b, s);

      const m = this._model;
      mat4.identity(m);
      m[12] = ox; m[13] = oy; m[14] = oz;
      program.setMat4('u_model', m);

      device.setDepthTest(true);
      device.setDepthFunc(gl.LEQUAL);
      device.setDepthWrite(false);
      device.setBlend('none');
      device.setCull('back');
      device.bindVertexArray(this._cube.vao);

      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (!box || box.length < 6) continue;
        program.setVec3('u_boxMin', box[0], box[1], box[2]);
        program.setVec3('u_boxMax', box[3], box[4], box[5]);
        gl.drawElements(gl.TRIANGLES, this._cube.count, gl.UNSIGNED_SHORT, 0);
        draws++;
      }
      this.stats.drawCalls += draws;
    } catch (err) {
      if (!this._logged) {
        this._logged = true;
        console.error('[VOXELIA] entities: the break overlay failed to draw.', err);
      }
    } finally {
      device.bindVertexArray(null);
      device.setDepthWrite(true);
      program.setFloat('u_crackStage', 0);
      program.setFloat('u_expand', 0);
    }
    return draws;
  }

  /* ---------------------------------------------------------------------- */
  /* Teardown                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Release every GPU resource owned by this renderer.
   * @returns {void}
   */
  dispose() {
    const device = this.device;
    const gl = this.raw;
    try {
      for (const key of Object.keys(this.programs)) {
        const p = this.programs[key];
        if (p && typeof p.dispose === 'function') p.dispose();
        this.programs[key] = null;
      }
      for (const m of this.models.values()) this._disposeModel(m);
      this.models.clear();
      if (this._cube) {
        if (this._cube.vao) gl.deleteVertexArray(this._cube.vao);
        if (this._cube.vbo) gl.deleteBuffer(this._cube.vbo);
        if (this._cube.ibo) gl.deleteBuffer(this._cube.ibo);
        this._cube = null;
      }
      if (this._sprite) {
        if (this._sprite.vao) gl.deleteVertexArray(this._sprite.vao);
        if (this._sprite.vbo) gl.deleteBuffer(this._sprite.vbo);
        if (this._sprite.ibo) gl.deleteBuffer(this._sprite.ibo);
        this._sprite = null;
      }
      if (this._outlineVAO) { gl.deleteVertexArray(this._outlineVAO); this._outlineVAO = null; }
      if (this._outlineVBO) { gl.deleteBuffer(this._outlineVBO); this._outlineVBO = null; }
      if (this.skinArray) { device.deleteTexture(this.skinArray); this.skinArray = null; }
      if (this.iconArray) { device.deleteTexture(this.iconArray); this.iconArray = null; }
    } catch (err) {
      console.warn('[VOXELIA] entities: dispose() hit an error; resources may leak.', err);
    }
    this._list.length = 0;
    this._records.length = 0;
    this._lastWorld = null;
    this._ready = false;
  }
}

/* ========================================================================== */
/* Module helpers                                                             */
/* ========================================================================== */

/** Full-block AABB used when a block reports no boxes. @type {number[][]} */
const UNIT_AABB = [[0, 0, 0, 1, 1, 1]];

/** Default selection-outline colour (near black, slightly transparent). */
const OUTLINE_COLOR = Object.freeze([0.02, 0.02, 0.025, 0.85]);

/**
 * The twelve edges of a box as pairs of corner bitmasks
 * (`bit0` = max X, `bit1` = max Y, `bit2` = max Z).
 * @type {ReadonlyArray<number[]>}
 */
const EDGE_TABLE = Object.freeze([
  [0, 1], [1, 3], [3, 2], [2, 0],
  [4, 5], [5, 7], [7, 6], [6, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
]);

/**
 * Sort comparator: group by bucket key (program, model, skin), then draw the
 * nearest entities first so early-Z does the most work.
 * @param {Object} a first record
 * @param {Object} b second record
 * @returns {number} sort order
 */
function compareRecords(a, b) {
  if (a.key !== b.key) return a.key - b.key;
  return a.dist - b.dist;
}

export default EntityRenderer;
