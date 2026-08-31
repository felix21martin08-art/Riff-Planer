# VOXELIA — Engine Architecture & Module Contract (v1)

> **This document is the binding contract.** Every module MUST match the exported
> names, signatures and data layouts described here *exactly*. Do not invent
> alternative names. Do not change shared layouts. If something is missing from
> this spec, implement it inside your own file and export it — never change
> another module's contract.

VOXELIA is a Minecraft-2.0-class voxel game: WebGL2, deferred PBR renderer,
procedural GPU-generated 4K-class textures, colored voxel lighting, cascaded
shadows, volumetric sky + clouds, screen-space reflections, TAA + bloom + ACES,
infinite procedural worlds, full survival gameplay.

## 0. Hard rules

1. **Pure ES modules.** No build step, no bundler, no npm dependencies, no CDN.
   Every file is loaded via `<script type="module">` / `import`.
2. **Zero external assets.** No image files, no audio files, no fonts to fetch.
   All textures are generated on the GPU, all sounds synthesised with WebAudio,
   all UI uses system font stacks. The game must run from `file://`-like static
   hosting with no network access.
3. **WebGL2 only.** Assume: MRT >= 4 draw buffers, `EXT_color_buffer_float`,
   `EXT_texture_filter_anisotropic`, `OES_texture_float_linear`. Guard optional
   extensions (`WEBGL_debug_renderer_info`, `EXT_disjoint_timer_query_webgl2`).
4. **Workers are module workers**: `new Worker(url, {type:'module'})`. Workers
   import `world/*.js` directly — no duplicated block tables.
5. **No `Date.now()` drift assumptions**: use `performance.now()`.
6. **Everything must degrade**: if a quality feature is disabled in settings the
   pipeline must still render correctly.
7. **Style**: modern JS (classes, `const`/`let`, optional chaining). 2-space
   indent. JSDoc on every exported symbol. No TypeScript syntax.
8. Never `throw` during a frame; log once and disable the failing subsystem.

## 1. Directory layout & ownership

```
voxelia/
  index.html                 entry page
  src/main.js                bootstrap
  src/core/gl.js             WebGL2 context, program/VAO/FBO/texture helpers, GLSL #include
  src/core/math.js           vec3/mat4/quat/frustum/aabb/PRNG
  src/core/input.js          keyboard/mouse/pointerlock/touch/gamepad + action map
  src/core/settings.js       persisted settings + quality presets + change events
  src/core/util.js           event bus, object pool, priority queue, time budget, LRU
  src/world/materials.js     procedural material table (texture array layers)
  src/world/blocks.js        block registry (~110 blocks)
  src/world/noise.js         seeded perlin/simplex/worley/fbm/domain-warp
  src/world/biomes.js        biome table, climate mapping, tint colors
  src/world/worldgen.js      terrain/caves/ores/surface generation
  src/world/structures.js    trees, ruins, dungeons, mineshafts, villages
  src/world/chunk.js         Chunk/Section storage (blocks + colored light)
  src/world/lighting.js      colored flood-fill light engine (sky + RGB)
  src/world/mesher.js        greedy mesher with AO + smooth light + biome tint
  src/world/world.js         chunk manager, worker pool, streaming, raycast
  src/world/worker.js        worker entry point (gen + mesh jobs)
  src/render/shaders/common.glsl.js   shared GLSL chunks (registered as #include)
  src/render/textures.js     GPU procedural texture arrays + block icons
  src/render/gbuffer.js      G-buffer targets + terrain geometry pass
  src/render/shadows.js      cascaded shadow maps
  src/render/ssao.js         ground-truth-ish AO + bilateral blur
  src/render/sky.js          atmospheric scattering, sun/moon/stars, volumetric clouds
  src/render/lightingpass.js deferred PBR composite + fog + god rays
  src/render/water.js        water surface, SSR, refraction, caustics, underwater
  src/render/post.js         bloom, TAA, motion blur, DOF, ACES, grade, FXAA
  src/render/particles.js    GPU-instanced particles + weather
  src/render/entities.js     mob/item/skeletal model renderer + held item
  src/render/renderer.js     pipeline orchestrator
  src/render/debug.js        wireframe, chunk borders, perf graphs
  src/game/physics.js        swept AABB voxel physics
  src/game/player.js         player controller + camera
  src/game/interaction.js    raycast, break/place, block outline
  src/game/items.js          item registry, tools, armor, food
  src/game/inventory.js      inventory/containers/stack logic
  src/game/crafting.js       shaped/shapeless recipes, smelting, fuels
  src/game/entities.js       entity manager, dropped items, projectiles, TNT
  src/game/mobs.js           mob defs, AI state machines, A* pathfinding, spawning
  src/game/combat.js         health/hunger/armor/damage/XP/death
  src/game/environment.js    time of day, weather state machine, moon phases
  src/game/audio.js          procedural WebAudio SFX + adaptive music
  src/game/save.js           IndexedDB persistence
  src/game/game.js           Game class: wires everything, fixed-step loop
  src/ui/style.css           all UI styling
  src/ui/hud.js              crosshair, bars, hotbar, tooltips
  src/ui/screens.js          menu, world select, settings, pause, death, loading
  src/ui/inventory_ui.js     inventory/crafting/furnace/chest screens
  src/ui/debugoverlay.js     F3 overlay
```

## 2. Coordinate system & world constants

Right-handed, **Y up**. `+X` east, `+Z` south. Blocks are unit cubes; block
`(x,y,z)` occupies AABB `[x,x+1] x [y,y+1] x [z,z+1]`.

```js
export const CHUNK_SIZE   = 16;   // X and Z
export const SECTION_SIZE = 16;   // Y per section
export const SECTION_COUNT= 24;   // sections per chunk
export const WORLD_HEIGHT = 384;  // 24 * 16
export const WORLD_MIN_Y  = -64;  // world Y range is [-64, 320)
export const SEA_LEVEL    = 62;
```
Section index `sy` is `0..23`; its world Y base is `WORLD_MIN_Y + sy*16`.

Index inside a section: `idx = (y * SECTION_SIZE + z) * SECTION_SIZE + x` with
`x,y,z in 0..15`.

## 3. Shared binary layouts (DO NOT DEVIATE)

### 3.1 Terrain vertex — 32 bytes, interleaved

| offset | attr | GLSL | GL type | notes |
|---|---|---|---|---|
| 0  | loc 0 `a_position` | `vec3`  | 3 x FLOAT | chunk-local, X/Z in 0..16, Y in 0..16 relative to the **section** base |
| 12 | loc 1 `a_uv`       | `vec2`  | 2 x FLOAT | tiled UV, may exceed 1 for greedy quads |
| 20 | loc 2 `a_texLayer` | `uint`  | 1 x UNSIGNED_SHORT, **IPointer** | texture-array layer |
| 22 | loc 3 `a_faceAO`   | `uvec2` | 2 x UNSIGNED_BYTE, **IPointer** | `.x` = face dir 0..5, `.y` = AO 0..255 |
| 24 | loc 4 `a_light`    | `vec4`  | 4 x UNSIGNED_BYTE **normalized** | R,G,B block light + sky light |
| 28 | loc 5 `a_tint`     | `vec4`  | 4 x UNSIGNED_BYTE **normalized** | biome tint rgb, `.a` = material flag byte/255 |

Stride is **32**. Indices are `Uint32Array`. Face dirs:
`0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z`.

Material flag byte (`a_tint.a * 255`, rounded): bit0 = waves (foliage sway),
bit1 = emissive, bit2 = wet-capable, bit3 = parallax on.

### 3.2 G-buffer fragment outputs — every geometry shader MUST write these

```glsl
layout(location=0) out vec4 o_albedo;  // rgb linear albedo, a = metallic
layout(location=1) out vec4 o_normal;  // rgb world normal*0.5+0.5, a = roughness
layout(location=2) out vec4 o_light;   // rgb baked voxel light (linear), a = sky light 0..1
layout(location=3) out vec4 o_extra;   // r = AO, g = matFlags/255, b = emissive, a = subsurface
```
Attachment formats: RT0 `RGBA8`, RT1 `RGBA16F`, RT2 `RGBA8`, RT3 `RGBA8`,
depth `DEPTH_COMPONENT32F` (sampled as texture).

### 3.3 Frame UBO — binding **0**, block name `Frame`

```glsl
layout(std140) uniform Frame {
  mat4 u_view;
  mat4 u_proj;
  mat4 u_viewProj;
  mat4 u_invView;
  mat4 u_invProj;
  mat4 u_invViewProj;
  mat4 u_prevViewProj;
  vec4 u_camPos;      // xyz world camera, w = near
  vec4 u_camDir;      // xyz forward,      w = far
  vec4 u_sunDir;      // xyz to-sun,       w = timeOfDay 0..1
  vec4 u_sunColor;    // rgb linear,       w = sun intensity
  vec4 u_moonDir;     // xyz to-moon,      w = moon phase 0..1
  vec4 u_skyAmbient;  // rgb ambient,      w = ambient intensity
  vec4 u_fogColor;    // rgb,              w = fog density
  vec4 u_screen;      // w, h, 1/w, 1/h
  vec4 u_time;        // seconds, dt, frameIndex, rainStrength
  vec4 u_params;      // renderDistanceBlocks, seaLevel, exposure, underwater(0/1)
  vec4 u_jitter;      // TAA jitter xy in NDC, prev jitter zw
};
```
Total 7 mat4 + 11 vec4 = 448 + 176 = **624 bytes**.

### 3.4 Shadow UBO — binding **1**, block name `Shadows`

```glsl
layout(std140) uniform Shadows {
  mat4 u_csmMatrix[4];
  vec4 u_csmSplits;    // view-space far distance per cascade
  vec4 u_csmTexel;     // world units per shadow texel per cascade
  vec4 u_shadowParams; // x=cascadeCount, y=depthBias, z=normalBias, w=softness
};
```

### 3.5 Fixed texture units

```
0  u_albedoArray  sampler2DArray   8  u_sceneColor      sampler2D
1  u_normalArray  sampler2DArray   9  u_ssao            sampler2D
2  u_mraeArray    sampler2DArray   10 u_skyLUT          sampler2D
3  u_gAlbedo      sampler2D        11 u_blueNoise       sampler2D
4  u_gNormal      sampler2D        12 u_shadowMap       sampler2DArray
5  u_gLight       sampler2D        13 u_cloudNoise      sampler3D
6  u_gExtra       sampler2D        14 u_sceneCopy       sampler2D
7  u_gDepth       sampler2D        15 free / per-pass
```

### 3.6 Texture arrays

Three `TEXTURE_2D_ARRAY`, all `RGBA8`, size `settings.textureResolution`
(128/256/512/1024, default 256), one layer per material:

* `ALBEDO`: rgb linear-ish albedo, a = alpha (cutout mask).
* `NORMAL`: rgb tangent-space normal (`n*0.5+0.5`), a = height (for parallax).
* `MRAE`:  r = metallic, g = roughness, b = baked AO/cavity, a = emissive strength.

Layer index for a material name comes from `materialLayer(name)` in
`world/materials.js` — the index is simply the material's position in
`MATERIALS`.

## 4. GLSL include chunks (registered by `core/gl.js` from `render/shaders/common.glsl.js`)

Use `#include <name>` on its own line. Available chunks and the functions they
guarantee:

* `frame`  — the Frame UBO (3.3) exactly as written above.
* `shadows`— the Shadows UBO (3.4) + `uniform sampler2DArray u_shadowMap;` +
  `float sampleShadow(vec3 worldPos, float NdotL, float viewDepth);`
  (returns 1 = lit, 0 = fully shadowed; does cascade selection + PCF/PCSS).
* `math`   — `PI`, `TAU`, `saturate(x)`, `sq(x)`, `remap(v,a,b,c,d)`,
  `hash11/hash21/hash31(...)`, `rotate2(vec2,float)`, `maxComp/minComp`.
* `noise`  — `float valueNoise3(vec3)`, `float simplex3(vec3)`,
  `float fbm3(vec3 p, int octaves)`, `float worley3(vec3)`, `float curlY(vec3)`.
* `color`  — `vec3 srgbToLinear(vec3)`, `vec3 linearToSrgb(vec3)`,
  `float luminance(vec3)`, `vec3 acesFitted(vec3)`, `vec3 reinhardJodie(vec3)`.
* `depth`  — `float linearizeDepth(float d)`, `vec3 worldFromDepth(vec2 uv,float d)`,
  `vec3 viewFromDepth(vec2 uv,float d)`, `float depthFromWorld(vec3 p)`.
* `pbr`    — `float D_GGX(float NoH,float a)`, `float V_SmithGGX(float NoV,float NoL,float a)`,
  `vec3 F_Schlick(float u, vec3 f0)`, `float Fd_Burley(float NoV,float NoL,float LoH,float a)`,
  `vec3 evalDirect(vec3 albedo,float metal,float rough,vec3 N,vec3 V,vec3 L,vec3 lightColor)`,
  `vec3 evalAmbient(vec3 albedo,float metal,float rough,vec3 N,vec3 V,vec3 skyCol,vec3 groundCol,float ao)`.
* `fog`    — `vec3 applyFog(vec3 color, vec3 worldPos, vec3 viewDir, float dist)`,
  `float fogFactor(float dist)`.
* `sky`    — `vec3 analyticSky(vec3 dir)` (cheap, used by fog/ambient/reflection
  fallback), `vec3 sunDiskColor(vec3 dir)`.
* `packing`— `vec2 octEncode(vec3)`, `vec3 octDecode(vec2)`, `float packColor(vec3)`.

`common.glsl.js` exports `export const GLSL_CHUNKS = { frame, shadows, math, ... }`
(name -> source string, **without** `#version`), and
`export function registerCommonChunks(gl)` which calls `gl.registerInclude(...)`
for each. Shader sources passed to `createProgram` must NOT contain `#version`
— `core/gl.js` prepends `#version 300 es` and precision qualifiers.

## 5. Module APIs

Only the **exported surface** is specified; internals are yours.

### 5.1 `core/gl.js`
```js
export class GL {
  constructor(canvas, opts = {})           // creates webgl2 ctx (antialias:false, alpha:false, depth:true, powerPreference:'high-performance')
  gl; canvas; caps; ext;                    // caps: {maxAniso,maxTexSize,maxLayers,maxDrawBuffers,timerQuery,floatBlend,rendererName}
  registerInclude(name, source)
  createProgram(name, vsSource, fsSource, options = {})  // options: {defines:{}, feedback:[], transform:false}
  // -> Program { name, program, use(), uniform(name), setInt/setFloat/setVec2/setVec3/setVec4/setMat4/setIVec2,
  //              setTexture(name, texture, unit, target=TEXTURE_2D), bindUBO(blockName, bindingPoint), dispose() }
  createBuffer(target, dataOrSize, usage = STATIC_DRAW)
  updateBuffer(buffer, target, data, offset = 0)
  createVertexArray(spec)   // spec: { attributes:[{location,buffer,size,type,normalized,integer,stride,offset,divisor}], indexBuffer, indexType }
  createTexture(desc)       // desc: {target,width,height,depth,internalFormat,format,type,data,min,mag,wrap,mips,aniso,compare}
  createFramebuffer(desc)   // desc: {color:[tex|{tex,level,layer}], depth:tex|null, name}
                            // -> { fbo, color, depth, bind(), width, height, resize(w,h), dispose() }
  resizeCanvas()            // handles devicePixelRatio * settings.renderScale, returns true if changed
  // state cache helpers (all no-op if unchanged):
  setViewport(x,y,w,h); setDepthTest(on); setDepthWrite(on); setDepthFunc(f);
  setCull(mode /* 'back'|'front'|'none' */); setBlend(mode /* 'none'|'alpha'|'add'|'premult' */);
  setColorMask(r,g,b,a); bindFramebuffer(fboOrNull); clear(color, depth, stencil);
  drawFullscreen()          // draws a fullscreen triangle with the currently bound program (owns its own VAO)
  beginTimer(label); endTimer(label); getTimings()   // no-ops when the extension is missing
  createUBO(name, sizeBytes, bindingPoint) // -> { buffer, bind(), update(float32Array), bindingPoint }
}
export const FULLSCREEN_VS;  // vertex shader source for fullscreen triangle; provides `out vec2 v_uv`
```

### 5.2 `core/math.js`
Exports plain-array based math (arrays are `Float32Array` or regular arrays of
length 3/4/16, **column-major** matrices, matching GLSL/`uniformMatrix4fv`).
```js
export const vec3 = { create,set,copy,add,sub,mul,scale,dot,cross,len,lenSq,normalize,lerp,dist,distSq,negate,min,max,transformMat4,transformDir,floor,fromValues };
export const vec4 = { create,set,copy,add,sub,scale,dot,transformMat4,fromValues };
export const mat4 = { create,identity,copy,multiply,invert,transpose,perspective,ortho,lookAt,fromTranslation,fromRotationXY,translate,rotateX,rotateY,rotateZ,scale,getTranslation,fromQuat,targetTo,equals };
export const quat = { create,identity,setAxisAngle,multiply,slerp,normalize,fromEuler };
export class Frustum { constructor(); fromViewProj(m); containsAABB(minX,minY,minZ,maxX,maxY,maxZ) /* bool */; containsSphere(x,y,z,r); }
export class AABB { constructor(minX,minY,minZ,maxX,maxY,maxZ); expand(d); offset(x,y,z); intersects(o); contains(x,y,z); clone(); set(...); }
export function clamp(v,a,b); export function lerp(a,b,t); export function smoothstep(e0,e1,x);
export function mulberry32(seed);      // -> ()=>float 0..1
export function xxhash32(x,y,z,seed);  // -> uint32
export function damp(current,target,lambda,dt);
export const DEG2RAD, RAD2DEG;
```

### 5.3 `core/util.js`
```js
export class EventBus { on(evt,fn); off(evt,fn); once(evt,fn); emit(evt,...args); }
export class PriorityQueue { constructor(cmp); push(item,priority); pop(); peek(); get size(); clear(); remove(pred); }
export class ObjectPool { constructor(factory,reset,initial=0); get(); release(obj); }
export class TimeBudget { constructor(ms); start(); expired(); remaining(); }
export class LRU { constructor(limit); get(k); set(k,v); has(k); delete(k); get size(); keys(); }
export function throttle(fn,ms); export function debounce(fn,ms);
export function formatBytes(n); export function nowMs();
export async function nextFrame();
```

### 5.4 `core/settings.js`
```js
export const QUALITY_PRESETS = { potato, low, medium, high, ultra, cinematic };
export class Settings extends EventBus {
  constructor()               // loads from localStorage key 'voxelia.settings'
  get(key); set(key, value); applyPreset(name); reset(); save(); all();
}
export const DEFAULTS = { /* see below */ };
```
Required keys (with sane defaults) — other modules read these by name:
`renderDistance`(10), `fov`(75), `renderScale`(1), `textureResolution`(256),
`shadows`(true), `shadowResolution`(2048), `shadowCascades`(3), `softShadows`(true),
`ssao`(true), `ssaoQuality`('high'), `bloom`(true), `taa`(true), `motionBlur`(true),
`dof`(false), `ssr`(true), `volumetricLight`(true), `volumetricClouds`(true),
`parallax`(true), `waterQuality`('high'), `anisotropy`(8), `particles`('high'),
`viewBobbing`(true), `fancyLeaves`(true), `smoothLighting`(true),
`masterVolume`(0.8), `musicVolume`(0.4), `sfxVolume`(0.9),
`mouseSensitivity`(0.15), `invertY`(false), `guiScale`(1), `showFps`(false),
`exposure`(1.0), `saturation`(1.05), `contrast`(1.02), `chromaticAberration`(true),
`filmGrain`(true), `vignette`(true), `autoSave`(true), `maxFps`(0),
`entityDistance`(1.0), `cloudQuality`('high'), `waveAnimation`(true).

### 5.5 `world/materials.js`
```js
/** @typedef {{name:string, pattern:string, color:[number,number,number],
 *   color2?:[number,number,number], color3?:[number,number,number],
 *   roughness:number, metallic:number, emissive?:number, height?:number,
 *   alpha?:boolean, seed?:number, scale?:number, params?:number[]}} Material */
export const MATERIALS = [ /* ~110 entries, index == texture-array layer */ ];
export const MATERIAL_INDEX = new Map(); // name -> layer
export function materialLayer(name);     // -> int (throws-free: returns 0 + console.warn if missing)
export const PATTERNS = [ /* ordered list of pattern ids; index used by the generator shader */ ];
export function patternId(name);         // -> int
```
`pattern` selects the procedural generator branch in `render/textures.js`.
Required pattern ids (the texture generator must implement all of them):
`solid, stone, cobble, granite, andesite, diorite, deepslate, dirt, grass_top,
grass_side, sand, gravel, clay, snow, ice, log_side, log_top, planks, leaves,
plank_dark, bricks, stone_bricks, mossy, sandstone, obsidian, netherrack,
ore, gem_ore, glass, water, lava, magma, glowstone, redstone_lamp, torch,
crafting_table, furnace_front, furnace_side, wool, cloth, bookshelf, tnt,
melon, pumpkin, cactus, wheat, flower, grass_plant, mushroom, sponge, hay,
metal, gold_block, diamond_block, emerald_block, bedrock, soul_sand, quartz,
concrete, terracotta, glazed, coral, kelp, mycelium, podzol, path, farmland,
noteblock, chest, ladder, rail, cobweb, vine, lantern, amethyst, copper,
copper_oxidized, deepslate_bricks, calcite, tuff, basalt, blackstone, packed_ice,
end_stone, purpur, prismarine, sea_lantern, slime, honey, mud, moss, azalea`.

### 5.6 `world/blocks.js`
```js
export const B = { AIR:0, STONE:1, /* ... every block as a named constant ... */ };
/** @typedef {{ id:number, name:string, display:string, ... }} BlockDef */
export const BLOCKS = [];            // dense array indexed by id
export const BLOCK_BY_NAME = new Map();
export function getBlock(id);        // -> BlockDef (AIR for unknown)
export function isSolid(id); export function isOpaque(id); export function isLiquid(id);
export function isCutout(id); export function isTransparent(id); export function isReplaceable(id);
export function lightEmission(id);   // -> [r,g,b] each 0..15
export function lightAbsorb(id);     // -> 0..15
export function faceMaterial(id, face);   // face 0..5 -> material layer index (precomputed)
export function blockTint(id);       // -> 'grass'|'foliage'|'water'|null
export function blockFlags(id);      // -> material flag byte (see 3.1)
export function blockDrops(id, toolType, toolTier, fortune, rng); // -> [{item, count}]
export function breakTime(id, toolType, toolTier, efficiency, onGround, inWater); // seconds
export const RENDER = { CUBE:0, CROSS:1, FLUID:2, SLAB:3, STAIRS:4, TORCH:5, PANE:6, NONE:7, MODEL:8 };
export function blockRender(id);
export function blockAABBs(id, state); // -> array of [minX,minY,minZ,maxX,maxY,maxZ] in block-local space
export function blockSound(id);        // -> 'stone'|'wood'|'grass'|'gravel'|'sand'|'glass'|'metal'|'wool'|'snow'|'water'
```
BlockDef fields: `id, name, display, render, solid, opaque, cutout, transparent,
liquid, replaceable, hardness (-1 = unbreakable), toolType, toolTier, emission[3],
absorb, textures{all|top|bottom|side|north|south|east|west}, tint, flags, drops[],
maxStack, sound, gravity, flammable, waterloggable, aabbs`.

**Required block set (>= 110)**: air, stone, granite/polished, diorite/polished,
andesite/polished, deepslate, cobbled_deepslate, deepslate_bricks, tuff, calcite,
cobblestone, mossy_cobblestone, stone_bricks, mossy_stone_bricks, cracked_stone_bricks,
bedrock, dirt, coarse_dirt, podzol, mycelium, grass_block, farmland, dirt_path,
mud, moss_block, sand, red_sand, sandstone, red_sandstone, gravel, clay,
oak/spruce/birch/jungle/acacia/dark_oak logs + planks + leaves (6 species),
glass, tinted_glass, glass_pane, water, lava, ice, packed_ice, blue_ice, snow_block,
snow_layer, obsidian, crying_obsidian, netherrack, soul_sand, soul_soil, basalt,
blackstone, magma_block, glowstone, nether_bricks, quartz_block, end_stone,
purpur_block, prismarine, dark_prismarine, sea_lantern, coal_ore, iron_ore,
copper_ore, gold_ore, redstone_ore, lapis_ore, diamond_ore, emerald_ore,
+ deepslate variants of all 8 ores, ancient_debris, amethyst_block, budding_amethyst,
coal/iron/copper/gold/redstone/lapis/diamond/emerald blocks, netherite_block,
raw_iron_block, oxidized_copper, cut_copper, crafting_table, furnace, blast_furnace,
chest, barrel, bookshelf, torch, soul_torch, lantern, campfire, tnt, note_block,
jukebox, ladder, scaffolding, cobweb, vine, sponge, wet_sponge, hay_bale,
wool (16 colors), concrete (16 colors) OR concrete (8) + terracotta (8),
short_grass, tall_grass, fern, dead_bush, dandelion, poppy, blue_orchid,
allium, cornflower, oxeye_daisy, sunflower, brown_mushroom, red_mushroom,
sugar_cane, cactus, bamboo, wheat (age states), carrots, potatoes, beetroot,
pumpkin, carved_pumpkin, jack_o_lantern, melon, kelp, seagrass, coral (5 colors),
slime_block, honey_block, redstone_lamp, redstone_wire, redstone_torch, lever,
button, pressure_plate, piston, sticky_piston, observer, repeater, comparator,
dispenser, hopper, rail, powered_rail, door/trapdoor (oak), fence, fence_gate,
stairs + slabs for stone/cobble/planks, iron_bars, anvil, enchanting_table,
brewing_stand, cauldron, beacon, spawner, portal_frame, nether_portal, end_portal.
(If a block's mechanic is not implemented yet it still must exist as a placing/
mining-capable block with correct textures.)

### 5.7 `world/noise.js`
```js
export class Noise { constructor(seed);
  perlin2(x,y); perlin3(x,y,z); simplex2(x,y); simplex3(x,y,z);
  fbm2(x,y,oct,lac=2,gain=0.5); fbm3(x,y,z,oct,lac=2,gain=0.5);
  ridged2(x,y,oct); ridged3(x,y,z,oct); billow3(x,y,z,oct);
  worley2(x,y); worley3(x,y,z);            // -> {f1,f2,cellX,cellY[,cellZ]}
  domainWarp2(x,y,strength,scale);         // -> [wx,wy]
  value3(x,y,z);
}
export function splineCurve(points);       // points [[x,y],...] -> (t)=>number, monotone cubic
export class OctaveNoise { constructor(noise, octaves, freq, amp, lac, gain); sample2(x,y); sample3(x,y,z); }
```

### 5.8 `world/biomes.js`
```js
export const BIOMES = [ /* index == biome id, >= 24 biomes */ ];
export const BIOME_INDEX = new Map();
export function getBiome(id);
/** climate -> biome id */
export function selectBiome(continentalness, erosion, temperature, humidity, weirdness, depth);
export function biomeGrassColor(id);    // -> [r,g,b] 0..1
export function biomeFoliageColor(id);
export function biomeWaterColor(id);
export function biomeFogColor(id);
export function biomeSkyTint(id);
```
BiomeDef: `{ id, name, display, temperature, humidity, baseHeight, heightVariation,
surfaceBlock, subSurfaceBlock, underwaterBlock, grassColor, foliageColor,
waterColor, fogColor, skyTint, treeDensity, treeTypes[], grassDensity,
flowerTypes[], features[], mobs[], musicMood, precipitation:'none'|'rain'|'snow' }`.
Required biomes: plains, sunflower_plains, forest, birch_forest, dark_forest,
taiga, snowy_taiga, snowy_plains, ice_spikes, mountains, snowy_slopes, jagged_peaks,
meadow, savanna, savanna_plateau, desert, badlands, jungle, bamboo_jungle, swamp,
mangrove_swamp, beach, stony_shore, ocean, deep_ocean, warm_ocean, frozen_ocean,
river, mushroom_fields, cherry_grove, lush_caves, dripstone_caves, deep_dark.

### 5.9 `world/worldgen.js`
```js
export class WorldGenerator {
  constructor(seed, options = {})
  /** Generate a whole chunk column. Must be deterministic and side-effect free. */
  generateChunk(cx, cz);   // -> { sections: (Uint16Array|null)[24], heightmap: Int16Array(256),
                           //      biomes: Uint8Array(256), oceanFloor: Int16Array(256) }
  getBiomeAt(x, z);        // -> biome id
  getHeightAt(x, z);       // -> surface y
  /** Structures that cross chunk borders are handled via deferred edits: */
  takePendingEdits();      // -> Map<string 'cx,cz', Array<[x,y,z,blockId]>>
}
export const GEN_VERSION = 1;
```
Generation requirements: 3D density terrain with continentalness/erosion/
peaks-and-valleys splines, overhangs, aquifers, cheese+spaghetti+noodle caves,
ravines, ore distribution per height band with deepslate variants, surface rules
per biome, beaches, rivers, lakes, lava pools below y=0, bedrock roughness,
and calls into `structures.js` for trees/plants/structures.

### 5.10 `world/structures.js`
```js
export const STRUCTURES = { /* name -> generator fn */ };
export function placeTree(setBlock, rng, x, y, z, type);   // type: 'oak'|'big_oak'|'spruce'|'tall_spruce'|'birch'|'jungle'|'big_jungle'|'acacia'|'dark_oak'|'cherry'|'mangrove'|'azalea'
export function placeVegetation(setBlock, rng, x, y, z, biome);
export function placeOreVein(setBlock, rng, x, y, z, blockId, size);
export function placeDungeon(setBlock, rng, x, y, z);
export function placeRuins(setBlock, rng, x, y, z, biome);
export function placeMineshaft(setBlock, rng, x, y, z, rngSeed);
export function placeVillage(setBlock, rng, x, y, z, biome);
export function placeDesertPyramid(setBlock, rng, x, y, z);
export function placeAmethystGeode(setBlock, rng, x, y, z);
export function placeStrongholdRoom(setBlock, rng, x, y, z);
```
`setBlock(x, y, z, id)` uses **absolute world coordinates**; the generator routes
out-of-chunk writes into pending edits automatically.

### 5.11 `world/chunk.js`
```js
export class Section {
  constructor(sy); sy; blocks; /* Uint16Array(4096) | null when uniform air */ light; /* Uint16Array(4096) 4b R,G,B,Sky */
  isEmpty; nonAirCount; dirty; meshVersion;
  get(x,y,z); set(x,y,z,id);
  getLight(x,y,z); setLight(x,y,z,packed);
  getBlockLight(x,y,z); /* ->[r,g,b] */ setBlockLight(x,y,z,r,g,b);
  getSkyLight(x,y,z); setSkyLight(x,y,z,v);
  allocate(); dispose();
}
export class Chunk {
  constructor(cx, cz);
  cx; cz; key; sections; /* (Section|null)[24] */ heightmap; /* Int16Array(256) */
  biomes; /* Uint8Array(256) */ state; /* 'empty'|'generating'|'generated'|'lit'|'meshing'|'ready' */
  generated; lit; dirtySections; /* Set<number> */ meshes; /* (SectionMesh|null)[24] */
  entities; blockEntities; /* Map<string, object> */ modified;
  getBlock(x,y,z);          // chunk-local x,z 0..15, world y
  setBlock(x,y,z,id);       // returns previous id
  getLightPacked(x,y,z); setLightPacked(x,y,z,v);
  getSection(sy, create=false);
  getHeight(x,z); recomputeHeight(x,z);
  serialize();              // -> transferable-friendly plain object
  static deserialize(obj);
  dispose();
}
export function chunkKey(cx, cz);        // -> `${cx},${cz}`
export function packLight(r,g,b,sky);    // -> uint16
export function unpackLight(v);          // -> [r,g,b,sky]
```

### 5.12 `world/lighting.js`
```js
export class LightEngine {
  constructor(world);
  initChunkSkylight(chunk);          // column-based sky light seeding
  queueChunkBorders(chunk);          // re-propagate into neighbours
  onBlockChanged(x, y, z, oldId, newId);
  process(budgetMs);                 // -> number of nodes processed; marks sections dirty
  get pending();                     // queued node count
  clear();
}
```
Colored light: block light is stored as 3 x 4-bit channels; propagation
decrements each channel by 1 per block (more for translucent absorbers).
Sky light: 4 bits, no decrement straight down through transparent blocks.

### 5.13 `world/mesher.js`
```js
/** Pure function, safe to call in a worker. */
export function meshSection(input);
/* input: { blocks: Uint16Array(18*18*18), light: Uint16Array(18*18*18),
            biomes: Uint8Array(18*18), sy:number, smoothLighting:boolean, fancyLeaves:boolean }
   index for blocks/light: ((y*18)+z)*18+x  with x,y,z 0..17 => world offset -1..16
   index for biomes: z*18+x
   returns { opaque:{vertices:ArrayBuffer, indices:ArrayBuffer, count:number},
             cutout:{...}, water:{...} }   (empty buffers when nothing to draw) */
export const VERTEX_STRIDE = 32;
```
Must implement greedy meshing (merge coplanar same-material quads with identical
AO/light/tint), Minecraft-style 4-sample vertex AO, smooth per-vertex light from
the 8 surrounding voxels, biome tint blending over a 3x3 neighbourhood, cross
models for plants, and a proper fluid surface (height from neighbour fluid
levels, top face lowered to 14/16, no faces between water blocks).

### 5.14 `world/world.js`
```js
export class World extends EventBus {
  constructor(gl, settings, { seed, name, dimension = 'overworld' });
  seed; name; chunks; /* Map<string, Chunk> */ generator; lighting; entities;
  async init();
  update(dt, cameraPos, frustum);     // streaming, worker dispatch, mesh upload (time-budgeted)
  getBlock(x,y,z);                    // world coords, 0 (air) outside loaded area
  setBlock(x,y,z,id, {noRelight=false, noSave=false} = {});
  getLightPacked(x,y,z); getSkyLight(x,y,z); getBlockLight(x,y,z);
  getBiome(x,z); getHeight(x,z);
  isLoaded(cx,cz); getChunk(cx,cz);
  raycast(origin, dir, maxDist, opts = {}); // -> null | {x,y,z,face,faceNormal:[3],point:[3],dist,blockId}
  getCollisionAABBs(aabb, out = []);  // -> array of [minx,miny,minz,maxx,maxy,maxz]
  isAreaLoaded(aabb);
  iterateRenderList(frustum, cb);     // cb(sectionMesh) for visible sections, front-to-back
  markDirty(x,y,z);
  getStats();                         // { loaded, meshing, generating, queued, vertices, triangles, memoryMB }
  save(); load();
  dispose();
}
export const SectionMeshShape = { /* documentation only */ };
```
`SectionMesh`: `{ cx, cz, sy, originX, originY, originZ, aabb:[6],
opaque:{vao,indexCount}|null, cutout:{...}|null, water:{...}|null, version }`.

### 5.15 `world/worker.js`
Module worker. Handles `{type:'init', seed, options}`, `{type:'gen', id, cx, cz}`,
`{type:'mesh', id, cx, cz, sy, blocks, light, biomes, smoothLighting, fancyLeaves}`,
`{type:'dispose'}`. Posts back the shapes defined in 5.9/5.13 with all
`ArrayBuffer`s transferred.

### 5.16 `render/textures.js`
```js
export class TextureManager {
  constructor(gl, settings);
  albedoArray; normalArray; mraeArray;   // GL textures
  blueNoise; cloudNoise;                 // 2D blue noise, 3D cloud noise (generated)
  async generate(onProgress);            // renders every material layer on the GPU
  regenerate(resolution);
  bindArrays(program);                   // binds units 0,1,2
  async renderBlockIcons(blockIds, size = 64); // -> Map<blockId, string dataURL> (3D isometric preview)
  dispose();
}
```
Texture generation runs a single "uber" fragment shader with a `u_pattern` int
uniform and material parameter uniforms; it renders to each array layer through
an FBO, then builds mipmaps and applies anisotropy. It must produce **albedo +
tangent-space normal + metallic/roughness/AO/emissive** for every pattern in
`PATTERNS`, with per-material detail noise, cavity, edge wear and dirt so the
result reads as high-end PBR at 256-1024px.

### 5.17 `render/gbuffer.js`
```js
export class GBuffer {
  constructor(gl, settings);
  targets; depth; framebuffer; width; height;
  resize(w,h);
  bindForWriting(); bindForReading(startUnit = 3);
  renderTerrain(world, frame, { pass:'opaque'|'cutout' });
  renderShadowDepth(world, lightFrame, cascadeIndex);   // depth-only variant
  dispose();
}
```

### 5.18 `render/shadows.js`
```js
export class ShadowMapper {
  constructor(gl, settings);
  texture;             // sampler2DArray depth
  matrices; splits;
  update(frame, world, entities);   // renders all cascades
  uploadUBO(ubo);      // fills the Shadows UBO (binding 1)
  resize(res, cascades);
  dispose();
}
```

### 5.19 `render/ssao.js`
```js
export class SSAO { constructor(gl, settings); texture; resize(w,h); render(gbuffer, frame); dispose(); }
```

### 5.20 `render/sky.js`
```js
export class Sky {
  constructor(gl, settings);
  lut;                                  // sky/transmittance LUT texture (unit 10)
  update(frame, environment);           // recompute LUTs when the sun moves enough
  renderBackground(frame, environment); // full-screen sky where depth == 1 (sun, moon, stars, clouds)
  getAmbient();                         // -> {skyColor:[3], groundColor:[3], sunColor:[3], intensity}
  dispose();
}
```
Must implement analytic multi-scatter atmospheric scattering (Rayleigh + Mie),
a physically-plausible sun disk with limb darkening, moon with phases, ~2000
procedural stars with twinkle, aurora at high latitudes/night, and raymarched
volumetric clouds (2 layers: cumulus + cirrus) with light scattering.

### 5.21 `render/lightingpass.js`
```js
export class LightingPass {
  constructor(gl, settings);
  render(gbuffer, shadows, ssao, sky, frame, environment, targetFBO);
  dispose();
}
```
Deferred composite: PBR direct sun (CSM shadows), colored voxel light with
proper falloff, sky ambient + ground bounce, AO, emissive, subsurface for
foliage, height fog + biome fog, and raymarched volumetric sun shafts.

### 5.22 `render/water.js`
```js
export class WaterRenderer {
  constructor(gl, settings);
  render(world, frame, gbuffer, sceneColorTex, sceneDepthTex, targetFBO);
  renderUnderwaterOverlay(frame, targetFBO);
  dispose();
}
```
Gerstner + FBM waves, screen-space reflections with a sky fallback, depth-based
refraction and absorption, foam at intersections, caustics projected onto the
floor, and an underwater fog/godray/distortion overlay.

### 5.23 `render/post.js`
```js
export class PostProcess {
  constructor(gl, settings);
  resize(w,h);
  render(sceneTex, depthTex, frame, outputToScreen = true);  // -> final texture when not drawing to screen
  dispose();
}
```
Order: TAA resolve (with velocity from depth + prevViewProj, neighbourhood
clamping) -> motion blur -> DOF (optional) -> bloom (5-step down/upsample,
karis average) -> exposure/auto-exposure -> ACES tonemap -> color grade
(saturation/contrast/lift-gamma-gain, day/night grading) -> chromatic aberration
-> vignette -> film grain -> FXAA (only when TAA is off) -> sRGB out.

### 5.24 `render/particles.js`
```js
export class ParticleSystem {
  constructor(gl, settings);
  spawn(type, x, y, z, opts = {});   // 'break'|'dust'|'splash'|'bubble'|'smoke'|'flame'|'spark'|'crit'|'heart'|'note'|'portal'|'drip'|'leaf'|'ember'|'explosion'
  spawnBlockBreak(x, y, z, blockId); spawnBlockHit(x,y,z,blockId,faceNormal);
  spawnWeather(environment, cameraPos, dt);
  update(dt, world, frame);
  render(frame, gbufferOrForward);
  get count();
  clear(); dispose();
}
```
GPU-instanced, up to 100k particles, with lighting from the voxel light grid,
soft-depth fade, and collision against the world for heavy particles.

### 5.25 `render/entities.js`
```js
export class EntityRenderer {
  constructor(gl, settings, textureManager);
  registerModel(name, modelDef);       // cube-based skeletal model
  render(entities, player, frame, world, { pass:'gbuffer'|'shadow' });
  renderHeldItem(player, frame, world);
  renderBlockOutline(hit, frame);
  renderBreakOverlay(hit, progress, frame);
  dispose();
}
export const MODELS = { /* humanoid, quadruped, creeper, spider, chicken, item, ... */ };
```

### 5.26 `render/renderer.js`
```js
export class Renderer {
  constructor(gl, settings);
  async init(onProgress);              // builds textures, FBOs, all sub-passes
  resize(width, height);
  render(frame);                       // the one entry point per game frame
  setQuality(preset);
  textures;                            // TextureManager (UI needs block icons)
  stats;                               // { drawCalls, triangles, gpuMs, passes:{} }
  dispose();
}
/** The frame object passed to render() — built by game/game.js */
export const FrameShape = {
  camera: { position:[3], forward:[3], up:[3], right:[3], yaw:0, pitch:0, fov:75,
            near:0.05, far:1000, aspect:1, view:mat4, proj:mat4, viewProj:mat4,
            prevViewProj:mat4, frustum:Frustum, underwater:false },
  world: null, entities: null, player: null, environment: null, particles: null,
  hit: null,        // current raycast hit or null
  breakProgress: 0, // 0..1
  time: 0, dt: 0, frameIndex: 0
};
```

### 5.27 `render/debug.js`
```js
export class DebugRenderer { constructor(gl,settings); drawAABB(aabb,color); drawLine(a,b,color);
  drawChunkBorders(world,cameraPos); render(frame); clear(); setEnabled(flag,on); dispose(); }
```

### 5.28 `game/physics.js`
```js
export function moveWithCollisions(world, aabb, velocity, dt, out);
// -> { onGround, hitX, hitY, hitZ, position:[3], velocity:[3], stepped }
export function isInLiquid(world, aabb);       // -> {water:boolean, lava:boolean, submerged:number 0..1}
export function applyGravity(velocity, dt, gravity, terminal);
export function resolveEntityPush(entities, dt);
export const GRAVITY = 32.0, TERMINAL_VELOCITY = 78.4;
export function sweepAABB(aabb, velocity, boxes); // -> {t, normal:[3]}
```

### 5.29 `game/player.js`
```js
export class Player {
  constructor(world, settings, input);
  position; velocity; yaw; pitch; aabb; onGround; sprinting; sneaking; flying;
  gameMode; /* 'survival'|'creative'|'spectator' */ health; hunger; saturation;
  air; xp; xpLevel; armor; selectedSlot; inventory; camera; perspective; /* 0|1|2 */
  update(dt, world);
  updateCamera(alpha);        // interpolation for smooth rendering
  getEyePosition(); getLookDirection();
  damage(amount, source); heal(amount); addExhaustion(v); eat(item);
  respawn(); setGameMode(m); teleport(x,y,z);
  serialize(); deserialize(obj);
}
```
Must implement: acceleration-based movement with friction, sprint + FOV kick,
sneak with ledge protection, jump/auto-step (0.6), swimming + swim sprint,
ladders, cobweb slowdown, slime bounce, honey slow, fall damage, creative fly
(double-tap space), head bob, camera roll on strafe, 1st/3rd person/front views,
and smooth interpolated camera at render time.

### 5.30 `game/interaction.js`
```js
export class Interaction {
  constructor(world, player, input, audio, particles, entities);
  hit; breakProgress; placeCooldown;
  update(dt);
  tryBreak(); tryPlace(); tryUse(); pickBlock();
  getPlacementState(blockId, hit, player);  // orientation for logs/stairs/etc.
  dispose();
}
```

### 5.31 `game/items.js`
```js
export const ITEMS = [];                 // dense by item id
export const I = { /* named constants */ };
export function getItem(id); export function itemByName(name);
export function isBlockItem(id); export function itemToBlock(id); export function blockToItem(blockId);
export function toolPower(itemId, blockId); export function toolTier(itemId); export function toolType(itemId);
export function itemDurability(id); export function armorPoints(id); export function armorSlot(id);
export function foodValue(id);           // -> {hunger, saturation, eatTime, effects[]}
export function itemStackSize(id);
export function itemIcon(id);            // -> {type:'block', blockId} | {type:'sprite', pattern, colors}
```
Required items: all block items + wooden/stone/iron/golden/diamond/netherite
(pickaxe, axe, shovel, sword, hoe), bow, arrow, crossbow, shield, fishing_rod,
flint_and_steel, bucket (empty/water/lava/milk), shears, all 5 armor tiers x 4
slots, sticks, coal, charcoal, raw+ingot for iron/gold/copper, diamond, emerald,
lapis, redstone, quartz, netherite scrap/ingot, string, feather, leather,
gunpowder, bone, bone_meal, slimeball, ender_pearl, blaze_rod, blaze_powder,
glass_bottle, all foods (apple, golden_apple, bread, raw/cooked beef/porkchop/
chicken/mutton/cod/salmon, carrot, potato, baked_potato, beetroot, melon_slice,
cookie, cake, stew, berries), paper, book, enchanted_book, map, compass, clock,
name_tag, saddle, boat, minecart, torch items, redstone components, music discs.

### 5.32 `game/inventory.js`
```js
export class ItemStack { constructor(itemId, count = 1, meta = null);
  itemId; count; meta; /* {durability, enchantments:[], name, lore} */
  clone(); isEmpty(); canStackWith(other); split(n); serialize(); static deserialize(o); }
export class Inventory extends EventBus {
  constructor(size); slots; /* (ItemStack|null)[] */
  get(i); set(i, stack); add(stack);        // -> leftover ItemStack|null
  remove(i, count); swap(a,b); count(itemId); has(itemId, n);
  findSlot(itemId); firstEmpty(); clear(); serialize(); deserialize(o);
}
export class PlayerInventory extends Inventory {
  constructor();                            // 36 main (9 hotbar) + 4 armor + 1 offhand + 4 crafting + 1 result
  hotbar(i); selected; getSelected(); armor(i); offhand;
  addPickup(stack);                         // hotbar-first insertion
  damageSelected(amount); consumeSelected(n);
}
export const SLOT = { HOTBAR_START:0, HOTBAR_END:8, MAIN_START:9, MAIN_END:35,
  ARMOR_START:36, ARMOR_END:39, OFFHAND:40, CRAFT_START:41, CRAFT_END:44, CRAFT_RESULT:45 };
```

### 5.33 `game/crafting.js`
```js
export const RECIPES = [];                 // >= 130 recipes
export const SMELTING = new Map();         // inputItemId -> {result, xp, time}
export const FUELS = new Map();            // itemId -> burnTicks
export function findRecipe(grid, width, height);   // -> {result: ItemStack, consumed:[...]} | null
export function craftableFrom(inventory);          // -> Recipe[] (for the recipe book)
export function smeltResult(itemId);
export function fuelValue(itemId);
export function registerRecipe(recipe);
```
Recipe: `{ id, type:'shaped'|'shapeless', pattern:[...], key:{}, ingredients:[], result:{item,count}, category }`.
Must cover the full vanilla progression: planks, sticks, crafting table, all tools
and armor tiers, furnace, chest, torches, doors, fences, stairs, slabs, beds,
bows, arrows, buckets, shears, TNT, enchanting table, anvil, hoppers, rails,
redstone components, dyes and wool/concrete colors, food recipes.

### 5.34 `game/entities.js`
```js
export class Entity {
  constructor(type, x, y, z);
  id; type; position; velocity; rotation; aabb; onGround; health; maxHealth;
  age; dead; noClip; gravityScale; drag;
  update(dt, world, ctx); onCollide(face); damage(amount, source); kill();
  serialize(); static deserialize(o);
}
export class ItemEntity extends Entity { constructor(x,y,z,stack); stack; pickupDelay; }
export class ArrowEntity extends Entity {}
export class TNTEntity extends Entity {}
export class XPOrbEntity extends Entity {}
export class FallingBlockEntity extends Entity {}
export class EntityManager extends EventBus {
  constructor(world);
  entities; /* Map<id, Entity> */
  spawn(entity); remove(id); get(id);
  update(dt, player, ctx);
  queryAABB(aabb, out = []); queryRadius(x,y,z,r,out = []);
  getRenderList(cameraPos, maxDist);
  dropItem(x,y,z,stack,velocity); explode(x,y,z,power, {fire=false, destroy=true} = {});
  serialize(); deserialize(o); clear();
}
```

### 5.35 `game/mobs.js`
```js
export const MOB_TYPES = { /* zombie, skeleton, creeper, spider, enderman, witch, slime,
                              drowned, husk, pig, cow, sheep, chicken, wolf, cat, horse,
                              villager, iron_golem, bat, squid, fox, rabbit */ };
export class Mob extends Entity {
  constructor(type, x, y, z);
  ai; target; path; pathIndex; state; animation;
  update(dt, world, ctx);
  setTarget(entity); findPath(tx,ty,tz); attack(target); onHurt(source);
}
export class MobSpawner {
  constructor(world, entityManager);
  update(dt, player, environment);     // light/biome/time based spawning + despawn
  spawnMob(type, x, y, z);
  getMobCap(category);
}
export function pathfind(world, from, to, maxNodes = 2000, capabilities); // A* -> [[x,y,z],...] | null
```
Required AI behaviours: wander, look-at, flee, follow-player-holding-item, melee
attack with cooldown, ranged attack (skeleton bow), creeper fuse + explode,
spider wall climb, enderman teleport + block pickup, slime split, panic on hurt,
day burn for undead, breeding, baby variants, herd grouping, water avoidance.

### 5.36 `game/combat.js`
```js
export class CombatSystem {
  constructor(world, entityManager, player, audio, particles);
  update(dt, environment);
  playerAttack(target); dealDamage(entity, amount, source, knockbackDir);
  updateHunger(dt); updateHealth(dt); updateAir(dt); updateFallDamage(entity);
  applyArmor(entity, amount, source); addXP(amount); levelFromXP(xp);
  onPlayerDeath(); getDamageSources();
}
export const DAMAGE = { FALL:'fall', DROWN:'drown', LAVA:'lava', FIRE:'fire', VOID:'void',
  MOB:'mob', PLAYER:'player', EXPLOSION:'explosion', STARVE:'starve', SUFFOCATE:'suffocate', CACTUS:'cactus' };
```

### 5.37 `game/environment.js`
```js
export class Environment extends EventBus {
  constructor(settings, seed);
  timeOfDay;   /* 0..1, 0 = sunrise */ dayCount; ticks;
  weather;     /* 'clear'|'rain'|'thunder'|'snow' */ rainStrength; thunderStrength;
  moonPhase;   /* 0..7 */ sunDir; moonDir; sunColor; skyAmbient; fogColor; fogDensity;
  update(dt, player, world);
  setTime(t); setWeather(w, duration); getLightLevel(); // 0..15 sky light multiplier
  isDay(); isNight(); serialize(); deserialize(o);
}
```
A full day is 20 real minutes (1200 s) by default.

### 5.38 `game/audio.js`
```js
export class AudioEngine {
  constructor(settings);
  async init();                       // must be called from a user gesture
  play(name, opts = {});              // {x,y,z,volume,pitch,loop}
  playBlockSound(action, blockId, x, y, z);  // action: 'break'|'place'|'step'|'hit'
  playUI(name); setListener(position, forward, up);
  startMusic(mood); stopMusic(); setAmbience(biomeId, isNight, weather, underground);
  dispose();
}
```
Everything synthesised (noise bursts + filters + FM + karplus-strong). Required
sounds: dig/step/place per material class, hurt, death, eat, drink, explode,
bow, arrow hit, door, chest, click, level-up, xp pickup, item pickup, mob idle/
hurt/death per mob, water/lava ambience, rain, thunder, wind, cave ambience,
plus 4 generative ambient music moods (calm, night, cave, danger).

### 5.39 `game/save.js`
```js
export class SaveManager {
  constructor(dbName = 'voxelia');
  async open(); async listWorlds(); async createWorld(meta); async deleteWorld(id);
  async saveChunk(worldId, cx, cz, data); async loadChunk(worldId, cx, cz);
  async savePlayer(worldId, data); async loadPlayer(worldId);
  async saveMeta(worldId, meta); async loadMeta(worldId);
  async flush(); close();
}
```
Only *modified* chunks are stored (delta over the generator).

### 5.40 `game/game.js`
```js
export class Game extends EventBus {
  constructor(canvas);
  gl; settings; input; renderer; world; player; entities; mobs; combat;
  environment; audio; save; interaction; particles; ui; state;
  /* state: 'boot'|'menu'|'loading'|'playing'|'paused'|'dead'|'inventory' */
  async boot(onProgress);
  async startWorld({ seed, name, gameMode, generator });
  async loadWorld(id);
  start(); stop(); pause(); resume();
  tick(dt);        // fixed 50 ms game tick
  frame(now);      // rAF: variable-step update + render
  setState(s);
  dispose();
}
```
Loop: accumulator, fixed 20 TPS logic tick, variable-rate camera/render with
interpolation alpha, `maxFps` limiter, `document.hidden` pause.

### 5.41 `ui/*`
```js
// ui/hud.js
export class HUD { constructor(game, root); update(dt); show(); hide(); setMessage(text, ms);
  showToast(title, subtitle, icon); flashDamage(); dispose(); }
// ui/screens.js
export class ScreenManager { constructor(game, root); show(name, data); hide(); get current();
  registerScreen(name, screen); update(dt); dispose(); }
// ui/inventory_ui.js
export class InventoryUI { constructor(game, root); open(kind, container); close(); isOpen; update(dt); dispose(); }
// ui/debugoverlay.js
export class DebugOverlay { constructor(game, root); toggle(); update(dt); dispose(); }
```
All UI is DOM based (absolutely positioned over the canvas), styled by
`ui/style.css`, using CSS custom properties, backdrop blur, and crisp SVG icons
generated inline. Block/item icons come from
`renderer.textures.renderBlockIcons()`.

## 6. Integration rules

* `index.html` loads `src/main.js` as a module and contains only the canvas +
  `<div id="ui">` root + a boot splash.
* Nothing imports from `render/*` inside `world/*` or `game/*` except types.
* `world/*` must be usable inside a worker: no `document`, no `window` at import
  time (guard with `typeof window !== 'undefined'`).
* Every class with GPU resources implements `dispose()`.
* All hot-path code avoids per-frame allocation: reuse scratch arrays.
* Errors: wrap subsystem init in try/catch, report via `game.emit('error', ...)`.

## 7. Performance targets

60 FPS at 1080p, render distance 12, on a mid-range GPU. Chunk mesh upload is
time-budgeted (<= 3 ms/frame). Worldgen + meshing run on `min(4, hardwareConcurrency-1)`
workers. Draw calls for terrain <= ~1500 at RD 12 (one per non-empty section pass).
