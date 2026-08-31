/**
 * VOXELIA — procedural material table (ARCHITECTURE.md section 5.5).
 *
 * There is NO image data in this engine. Every entry below is one layer of the
 * three texture arrays built by `render/textures.js`:
 *
 *   ALBEDO  rgb = linear albedo, a = coverage/opacity mask
 *   NORMAL  rgb = tangent-space normal * 0.5 + 0.5, a = height (parallax)
 *   MRAE    r = metallic, g = roughness, b = baked AO/cavity, a = emissive
 *
 * The layer index of a material is simply its position in `MATERIALS`.
 * NEVER reorder or splice this table — append new materials at the end only.
 *
 * Layer/VRAM budget for `render/textures.js`: the arrays need
 * `MATERIAL_COUNT` layers each, so the context must report
 * `MAX_ARRAY_TEXTURE_LAYERS >= MATERIAL_COUNT` (2048 on every desktop WebGL2
 * driver). Cost is `MATERIAL_COUNT * 3 * res * res * 4 * 1.33` bytes with
 * mipmaps — about 285 MB at the default 256 px, 1.1 GB at 512 px. Clamp
 * `settings.textureResolution` accordingly rather than trimming this table.
 * Many names resolve to a shared layer through the alias list at the bottom,
 * which is why `MATERIAL_INDEX.size > MATERIAL_COUNT`.
 *
 * =====================================================================
 * FIELD REFERENCE
 * =====================================================================
 *  name       unique key, `<block>` or `<block>_top|_bottom|_side|_front`.
 *  pattern    id from `PATTERNS`; selects the generator branch (`u_pattern`).
 *  color      primary base colour, **LINEAR** 0..1 (already de-gamma'd).
 *  color2     secondary colour: shadow/variance target, host rock, dark stripe,
 *             mortar substrate, dirt half of a side texture, patina, …
 *  color3     accent colour: highlight, mortar, veins, flame, moss, decal, …
 *  roughness  base perceptual roughness written to MRAE.g (0 mirror .. 1 chalk).
 *             The generator may modulate it by ±0.15 using the detail noise.
 *  metallic   0 for dielectrics, 1 for metals. For `ore`/`gem_ore` this is the
 *             metalness of the MINERAL blobs only; the host rock is always 0.
 *  emissive   MRAE.a base emissive strength 0..1 (1 = full lamp).
 *  height     peak-to-trough parallax depth as a fraction of one block face
 *             (0.03 = 3 cm relief). Written to NORMAL.a and used for POM.
 *  alpha      true => the material is cutout or translucent; the generator must
 *             write a real coverage/opacity mask into ALBEDO.a. Cutout families
 *             (plants, rails, bars, torches, webs) produce a hard 0/1 mask,
 *             translucent families (see below) a smooth opacity.
 *  seed       deterministic per-material hash seed. All hash/noise calls in the
 *             generator must be offset by it so two materials sharing a pattern
 *             never produce identical texels.
 *  scale      UV frequency multiplier. 1 = features authored for exactly one
 *             block face. 2 = twice as fine, 0.5 = twice as coarse.
 *  params     up to 8 floats, see the conventions below. Missing slots are 0.
 *
 * Materials whose block carries a biome tint (`blockTint()` -> 'grass' |
 * 'foliage' | 'water') are authored BRIGHT and low-saturation, because the
 * mesher multiplies the biome tint on top of the sampled albedo.
 *
 * =====================================================================
 * params[0..7] — BASE CONVENTION (valid for every pattern unless a family
 * override below re-defines a slot). All slots are 0..1 except p6 and p7.
 * =====================================================================
 *  p0 grain     amplitude of the high-frequency surface grain applied to both
 *               albedo luminance and the normal (0 = perfectly flat).
 *  p1 structure density of the family's PRIMARY structural feature (cracks,
 *               mortar lines, veins, rings, blades, fibres). 0 = none, 1 = max.
 *  p2 cavity    depth of that feature in height/normal and its darkening in the
 *               baked AO channel. 0..1 maps to 0..0.5 of `height`.
 *  p3 wear      edge erosion, chipping, rounding and border darkening.
 *  p4 hueVar    per-cell blend toward `color2` (and `color3` where a family
 *               says so). 0 = flat colour, 1 = full swing.
 *  p5 sparkle   density of isolated specular flecks: raises albedo and lowers
 *               roughness in single texels.
 *  p6 tiling    cell frequency multiplier. Feature count per texture edge is
 *               `round(baseCells * p6)`; each family documents its baseCells.
 *               Range 0.25..8, 1 = the authored default.
 *  p7 contrast  final albedo contrast about the tile mean:
 *               `rgb = mix(mean, rgb, p7)`. 1 = neutral, <1 flatter, >1 punchier.
 *
 * =====================================================================
 * FAMILY OVERRIDES — read these; they are binding for the GLSL generator.
 * =====================================================================
 *
 * AGGREGATE ROCK — solid, stone, granite, andesite, diorite, deepslate, tuff,
 *   calcite, blackstone, basalt, end_stone, quartz, netherrack, purpur,
 *   obsidian, bedrock, magma, prismarine.  baseCells = 8 blobs/edge.
 *   p1 = hairline fissure density (fissures = round(12 * p1)).
 *   p5 = mineral fleck density (flecks = round(3000 * p5) per 256x256).
 *   `basalt` additionally: p1 drives vertical columnar striations
 *   (round(14 * p1) per edge) and p3 = vesicle (gas bubble) density.
 *   `obsidian`: p1 = conchoidal fracture lines, p3 = flow banding amount.
 *   `bedrock`: p3 = void-hole density; use p7 > 1.3 for the chaotic look.
 *   `magma`: p1 = glowing fissure density, p3 = crust coverage
 *   (0 = fully molten, 1 = fully crusted), p7 = pulse speed multiplier.
 *   `prismarine`: baseCells = 6 scales/edge, p3 = animated shimmer amount.
 *   `quartz`: p1 = crystal streak density, p3 = chisel line width fraction.
 *
 * RUBBLE — cobble, gravel, mossy.  baseCells = 5 stones/edge.
 *   p1 = gap (mortar) width, 0..1 -> 0.5..3.0 texels at 256 px.
 *   p3 = pebble rounding / chipping.
 *   `mossy`: p3 instead selects the SUBSTRATE, 0 = cobblestone, 1 = stone
 *   bricks (`int sub = int(p3 + 0.5)`), p5 = moss coverage 0..1, color3 = moss.
 *
 * MASONRY — bricks, stone_bricks, deepslate_bricks.  baseCells = 4 courses.
 *   p1 = mortar width as a fraction of a brick (0..1 -> 0.02..0.14).
 *   p3 = fraction of bricks that are chipped/cracked.
 *   color3 = mortar colour. `bricks` offsets every second course by half a
 *   brick; `stone_bricks`/`deepslate_bricks` use a square running bond.
 *
 * SOIL — dirt, clay, mud, moss, path, podzol, mycelium, soul_sand, grass_top.
 *   baseCells = 6 clods/edge.
 *   p1 = pebble/inclusion density, p3 = compaction (0 loose .. 1 packed),
 *   p5 = root/fibre density (replaces sparkle).
 *   `grass_top`: p1 = blade density, p5 = dry-patch amount, color3 = dry tips.
 *   `podzol`/`mycelium`: color2 = the fuzzy top layer, p5 = its speck density.
 *   `mud`: p1 = dessication-polygon crack density, p3 = wetness (also darkens
 *   albedo and lowers roughness by 0.25 * p3).
 *   `soul_sand`: p1 = face-imprint density, p2 = imprint depth.
 *   `farmland`: p6 -> furrows = round(4 * p6) rows, p2 = furrow depth,
 *   p1 = seed-hole density, p3 = moisture darkening.
 *   `path`: p3 = trampled-edge amount.
 *
 * SIDE TEXTURES — grass_side, podzol (side use), mycelium (side use).
 *   color = the top material, color2 = the dirt body, color3 = top shadow.
 *   p1 = border jaggedness, p2 = border relief, p3 = overhang length as a
 *   fraction of the tile height (0..1 -> 0..0.45).
 *
 * GRANULAR — sand, sandstone, snow.  baseCells = 128 grains/edge.
 *   `sand`: p1 = wind-ripple density (ripples = round(10 * p1)),
 *           p5 = quartz glitter density.
 *   `sandstone`: p1 = stratum line count (= round(8 * p1)), p3 = weathering.
 *   `snow`: p1 = crust crack density, p3 = drift bump amplitude,
 *           p5 = glitter density.
 *
 * WOOD — log_side, log_top, planks, plank_dark, bookshelf, crafting_table,
 *   chest, noteblock, ladder.
 *   `log_side`: p1 -> bark ridges = round(10 * p1) per edge, p3 = lenticel /
 *   knot density, p5 = lichen speckle, color3 = lenticel/lichen accent.
 *   `log_top`: p1 -> growth rings = round(14 * p1), p3 -> radial cracks =
 *   round(6 * p3), p4 = heart(color) to sap(color2) gradient strength,
 *   p5 = pith off-centre amount, color3 = bark rim.
 *   `planks`/`plank_dark`: p6 -> plank rows = round(4 * p6),
 *   p1 -> grain lines per plank = round(24 * p1), p2 = seam depth,
 *   p3 = knot/nail density, p4 = per-plank hue variance, p5 = bevel highlight.
 *   `plank_dark` is the same generator with a darker, more saturated response
 *   curve and doubled grain contrast.
 *   `bookshelf`: p6 -> shelf rows = round(2 * p6), p1 -> books per shelf =
 *   round(7 * p1), p2 = book recess depth, p3 = frame width fraction,
 *   p4 = book hue spread around color3.
 *   `crafting_table`: p1 = grid line density, p3 = decal amount, color3 = decal.
 *   `chest`: p1 = plank line density, p2 = panel inset depth, p3 = metal band
 *   width fraction, p5 = metal sparkle, color3 = latch/band metal colour.
 *   `noteblock`: planks plus p3 = speaker-dot density.
 *   `ladder`: cutout. p6 -> vertical rails = round(2 * p6), p1 -> rungs =
 *   round(6 * p1) (0 = none, which yields plain vertical bars — used by
 *   iron_bars and scaffolding), p2 = rail thickness fraction of the tile.
 *
 * FOLIAGE (all cutout) — leaves, grass_plant, flower, wheat, vine, kelp,
 *   cactus, azalea, mushroom, coral, moss.
 *   `leaves`: p1 -> leaf clusters = round(10 * p1), p3 = gap fraction (how much
 *   of the tile is punched out), p4 = leaf hue variance toward color2,
 *   p5 = bright translucent tip amount (fake subsurface), color3 = tip colour.
 *   `grass_plant`: p1 -> blades = round(14 * p1), p2 = blade width fraction,
 *   p3 = bend/curvature, p4 = base(color) to tip(color2) gradient,
 *   p5 = tip highlight; for stalk-like plants (p1 <= 0.25: bamboo, sugar cane)
 *   p5 instead is the contrast of node rings drawn every 1/8 tile height.
 *   `flower`: p1 -> petals = round(8 * p1), p2 = petal radius fraction
 *   (0..1 -> 0.10..0.50), p3 = stem height fraction, p5 = pistil radius,
 *   p6 = stem thickness. color = petal, color2 = pistil, color3 = stem/leaf.
 *   `wheat`: p1 -> stalks = round(6 * p1), p2 = seed-head length fraction
 *   (this encodes the growth stage), p3 = droop, p5 = awn/bristle density.
 *   Root crops (carrots/potatoes/beetroot) reuse this pattern: p2 then means
 *   leaf-mass fraction and color2 is the exposed root colour.
 *   `vine`: p1 -> strands = round(9 * p1), p2 = leaf density along a strand,
 *   p3 = length variance.
 *   `kelp`: p1 -> blades = round(5 * p1), p2 = ripple amplitude,
 *   p3 = translucent band strength.
 *   `cactus`: p1 -> ribs = round(6 * p1), p2 = rib depth, p3 = areole/spine
 *   density, color3 = spine colour.
 *   `azalea`: p1 = leaf cluster density, p3 = blossom fraction, color3 = blossom.
 *   `mushroom`: p1 = cap spot density, p2 = cap dome curvature, p3 = stem width
 *   fraction, color2 = spot colour, color3 = gill colour.
 *   `coral`: p1 -> branches = round(7 * p1), p2 = polyp bump density,
 *   p3 = branch thickness, p5 = fluorescent rim strength.
 *   `moss`: p1 = tuft density, p3 = dry-patch amount, p5 = highlight tips.
 *
 * FRUIT — melon, pumpkin.
 *   `melon`: p1 -> stripes = round(8 * p1), p2 = stripe wobble, p3 = rind pit
 *   density, color2 = dark stripe, color3 = flesh/stem scar (top face).
 *   `pumpkin`: p1 -> ribs = round(6 * p1), p2 = rib depth, p3 = stem/scar size,
 *   p5 = carved-face amount (0 = plain, 1 = full jack-o'-lantern face; the face
 *   glows with `emissive`), color3 = stem colour.
 *
 * CLOTH & CERAMIC — wool, cloth, concrete, terracotta, glazed, hay, sponge.
 *   `wool`: p1 -> fibre strands = round(60 * p1), p2 = fluff relief,
 *   p3 = pilling, p5 = lint highlight.
 *   `cloth`: woven twill. p1 -> weave threads per edge = round(16 * p1),
 *   p2 = weave depth, p3 = fray amount, p5 = sheen. p4 is NOT hue variance
 *   here: it is the width of an inset trim border drawn in color3 over a
 *   color2 ground (0..1 -> 0..0.25 of the tile), used for altar/table cloth.
 *   `concrete`: p1 = air-bubble/pinhole density, p3 = edge chipping,
 *   p4 = mottling toward color2, p6 -> mottle cells = round(3 * p6).
 *   `terracotta`: p1 -> stratum bands = round(6 * p1), p3 = scuffing,
 *   p5 = residual glaze sheen.
 *   `glazed`: p1 = MOTIF SELECTOR, `int motif = int(p1 * 8.0)` picks one of the
 *   eight built-in geometric motifs, p2 = motif relief, p3 = crackle-glaze
 *   density, p5 = gloss strength, p6 = motif tiling. color2 = motif colour,
 *   color3 = accent colour.
 *   `hay`: p1 -> straw strands = round(40 * p1), p3 = binding twine width
 *   (side faces only), color3 = twine colour.
 *   `sponge`: p1 = pore density, p2 = pore depth, p3 = pore size variance.
 *
 * METAL & GEM — metal, gold_block, diamond_block, emerald_block, copper,
 *   copper_oxidized, amethyst.
 *   `metal`: p1 -> brushed scratch strokes = round(200 * p1), p2 = dent depth,
 *   p3 = oxidation/grime blotch coverage (mix toward color2),
 *   p5 = anisotropic highlight strength, p6 -> panels = round(2 * p6).
 *   `gold_block`/`diamond_block`/`emerald_block`: faceted mineral blocks.
 *   p6 -> facet cells per edge = round(3 * p6), p1 = bevel width fraction,
 *   p2 = facet depth, p3 = wear, p5 = internal sparkle density.
 *   color2 = facet shade, color3 = specular/inclusion tint.
 *   `copper`/`copper_oxidized`: p1 = streak density, p2 = pit depth,
 *   p3 = oxidation coverage 0..1 (color2 = patina), p5 = sheen. `cut_copper`
 *   style tiling comes from p6 (-> tiles = round(2 * p6)).
 *   `amethyst`: p1 -> crystal clusters = round(9 * p1), p2 = crystal height,
 *   p3 = host matrix roughness, p5 = internal refraction glints.
 *
 * ORE — ore, gem_ore.  color = mineral, color2 = HOST ROCK, color3 = mineral rim.
 *   p1 -> mineral blobs = round(10 * p1).
 *   p2  = blob radius as a fraction of the tile (0..1 -> 0.02..0.16).
 *   p3  = HOST ROCK STYLE INDEX, integer valued: 0 = stone, 1 = deepslate,
 *         2 = netherrack, 3 = blackstone/basalt, 4 = end_stone.
 *         `int host = int(p3 + 0.5)` — this slot is NOT wear for this family.
 *   p4  = per-blob hue variance, p5 = mineral sparkle, p6 = host tiling.
 *   `gem_ore` draws faceted crystals with a rim lit by `emissive` and an
 *   internal refraction glint scaled by p5.
 *
 * TRANSLUCENT — glass, ice, packed_ice, water, slime, honey.
 *   p5 = BASE OPACITY written to ALBEDO.a (0 invisible .. 1 opaque); it is NOT
 *   sparkle for this family. Borders, frost, foam and cracks are always opaque.
 *   `glass`: p1 = frame/border width fraction (0..1 -> 0..0.12), p2 = bevel
 *   depth, p3 = smudge/dust density.
 *   `ice`/`packed_ice`: p1 = fracture line density, p2 = fracture depth,
 *   p3 = frost/air-bubble density, p4 = tint variance toward color2.
 *   `slime`/`honey`: p1 -> inner blobs = round(5 * p1), p2 = blob relief,
 *   p3 = surface wobble, color2 = inner core colour.
 *   `water`: p1 -> wave crests = round(4 * p1), p2 = normal steepness,
 *   p3 = foam amount, p7 = ANIMATION SPEED multiplier (not contrast).
 *
 * FLUID — lava (see also `magma` above).
 *   color = cooled crust, color2 = hot flow, color3 = white-hot core.
 *   p1 = glowing fissure density, p2 = crust relief, p3 = crust coverage,
 *   p5 = ember spark density, p7 = flow speed multiplier (not contrast).
 *
 * LIGHT — glowstone, sea_lantern, redstone_lamp, torch, lantern.
 *   p5 = GLOW FALLOFF EXPONENT scaled 0..1 -> 1..8 (sharper core when higher);
 *   it is not sparkle for this family.
 *   `glowstone`: p6 -> nodules = round(5 * p6), p1 = nodule radius fraction,
 *   p2 = nodule relief, p3 = crust darkness between nodules.
 *   `sea_lantern`: p6 -> cells = round(4 * p6), p1 = cell inset,
 *   p3 = fraction of cells that pulse.
 *   `redstone_lamp`: p1 = lattice line density, p2 = lattice depth,
 *   p3 = bulb radius fraction. The on/off variants differ only in `emissive`.
 *   `torch`: cutout. p1 = stick width fraction, p2 = head radius fraction,
 *   p3 = flame flicker amplitude (animated by u_time),
 *   color = stick, color2 = head/base, color3 = flame.
 *   `lantern`: cutout. p1 -> cage bars = round(6 * p1), p2 = bar depth,
 *   p3 = glowing core radius fraction, color3 = metal cage colour.
 *
 * LINEAR / TRACK — rail, cobweb.
 *   `rail`: cutout. p1 -> sleepers = round(8 * p1); p1 == 0 disables sleepers
 *   entirely and leaves two bare parallel lines — that is how redstone wire is
 *   drawn. p2 = rail head height, p3 = ballast amount, p5 = metal sparkle,
 *   color = rail metal, color2 = sleeper wood, color3 = powered/glow accent.
 *   `cobweb`: cutout. p1 -> radial strands = round(12 * p1), p2 -> spiral rings
 *   = round(6 * p2), p3 = strand thickness, p5 = dew sparkle.
 *
 * FURNACE — furnace_front, furnace_side.  Machine faces on a stone body.
 *   p1 = stone speckle density, p2 = recess depth of the opening,
 *   p3 = frame width fraction, p5 = grate bar count normalised (bars =
 *   round(8 * p5)), color2 = the dark opening, color3 = grate/hinge metal.
 *
 * @module world/materials
 */

/**
 * Ordered list of procedural pattern ids. The index of a pattern is the value
 * passed to the texture generator as `u_pattern`, so this order is frozen.
 * @type {readonly string[]}
 */
export const PATTERNS = Object.freeze([
  'solid', 'stone', 'cobble', 'granite', 'andesite', 'diorite', 'deepslate',
  'dirt', 'grass_top', 'grass_side', 'sand', 'gravel', 'clay', 'snow', 'ice',
  'log_side', 'log_top', 'planks', 'leaves', 'plank_dark', 'bricks',
  'stone_bricks', 'mossy', 'sandstone', 'obsidian', 'netherrack', 'ore',
  'gem_ore', 'glass', 'water', 'lava', 'magma', 'glowstone', 'redstone_lamp',
  'torch', 'crafting_table', 'furnace_front', 'furnace_side', 'wool', 'cloth',
  'bookshelf', 'tnt', 'melon', 'pumpkin', 'cactus', 'wheat', 'flower',
  'grass_plant', 'mushroom', 'sponge', 'hay', 'metal', 'gold_block',
  'diamond_block', 'emerald_block', 'bedrock', 'soul_sand', 'quartz',
  'concrete', 'terracotta', 'glazed', 'coral', 'kelp', 'mycelium', 'podzol',
  'path', 'farmland', 'noteblock', 'chest', 'ladder', 'rail', 'cobweb', 'vine',
  'lantern', 'amethyst', 'copper', 'copper_oxidized', 'deepslate_bricks',
  'calcite', 'tuff', 'basalt', 'blackstone', 'packed_ice', 'end_stone',
  'purpur', 'prismarine', 'sea_lantern', 'slime', 'honey', 'mud', 'moss',
  'azalea'
]);

/** @type {Map<string, number>} pattern id -> index in PATTERNS */
const PATTERN_INDEX = new Map(PATTERNS.map((p, i) => [p, i]));

/** @type {Set<string>} names already reported as missing (warn only once) */
const warnedPatterns = new Set();

/**
 * Index of a pattern id inside `PATTERNS`.
 * Never throws: unknown ids warn once and fall back to `solid` (0).
 * @param {string} name pattern id, e.g. `'stone'`
 * @returns {number} index into PATTERNS
 */
export function patternId(name) {
  const id = PATTERN_INDEX.get(name);
  if (id !== undefined) return id;
  if (!warnedPatterns.has(name)) {
    warnedPatterns.add(name);
    console.warn(`[materials] unknown pattern "${name}" -> falling back to "solid"`);
  }
  return 0;
}

/**
 * @typedef {{name:string, pattern:string, color:[number,number,number],
 *   color2?:[number,number,number], color3?:[number,number,number],
 *   roughness:number, metallic:number, emissive?:number, height?:number,
 *   alpha?:boolean, seed?:number, scale?:number, params?:number[]}} Material
 */

/**
 * Multiply a linear colour, clamped to 0..1.
 * @param {[number,number,number]} c
 * @param {number} k
 * @returns {[number,number,number]}
 */
function tone(c, k) {
  return [
    Math.min(1, Math.max(0, c[0] * k)),
    Math.min(1, Math.max(0, c[1] * k)),
    Math.min(1, Math.max(0, c[2] * k))
  ];
}

/**
 * The raw table. Order is the texture-array layer order; append only.
 * @type {Material[]}
 */
const TABLE = [
  // ---------------------------------------------------------------- rock ---
  { name: 'stone', pattern: 'stone', color: [0.175, 0.175, 0.180], color2: [0.112, 0.112, 0.118], color3: [0.245, 0.243, 0.236],
    roughness: 0.92, metallic: 0, height: 0.028, seed: 1013, scale: 1,
    params: [0.55, 0.32, 0.45, 0.28, 0.26, 0.06, 1.0, 1.06] },
  { name: 'cobblestone', pattern: 'cobble', color: [0.152, 0.152, 0.157], color2: [0.090, 0.090, 0.096], color3: [0.062, 0.062, 0.066],
    roughness: 0.94, metallic: 0, height: 0.105, seed: 1021, scale: 1,
    params: [0.62, 0.42, 0.88, 0.55, 0.34, 0.05, 1.0, 1.14] },
  { name: 'mossy_cobblestone', pattern: 'mossy', color: [0.138, 0.140, 0.140], color2: [0.082, 0.086, 0.082], color3: [0.052, 0.118, 0.030],
    roughness: 0.95, metallic: 0, height: 0.110, seed: 1031, scale: 1,
    params: [0.60, 0.42, 0.88, 0.0, 0.32, 0.58, 1.0, 1.10] },
  { name: 'stone_bricks', pattern: 'stone_bricks', color: [0.186, 0.184, 0.180], color2: [0.132, 0.130, 0.127], color3: [0.078, 0.078, 0.080],
    roughness: 0.90, metallic: 0, height: 0.072, seed: 1039, scale: 1,
    params: [0.34, 0.26, 0.70, 0.18, 0.22, 0.05, 1.0, 1.05] },
  { name: 'mossy_stone_bricks', pattern: 'mossy', color: [0.170, 0.172, 0.166], color2: [0.118, 0.122, 0.116], color3: [0.048, 0.112, 0.028],
    roughness: 0.93, metallic: 0, height: 0.076, seed: 1049, scale: 1,
    params: [0.34, 0.26, 0.70, 1.0, 0.24, 0.52, 1.0, 1.06] },
  { name: 'cracked_stone_bricks', pattern: 'stone_bricks', color: [0.178, 0.176, 0.170], color2: [0.120, 0.118, 0.114], color3: [0.070, 0.070, 0.072],
    roughness: 0.93, metallic: 0, height: 0.086, seed: 1051, scale: 1,
    params: [0.48, 0.30, 0.80, 0.85, 0.28, 0.04, 1.0, 1.12] },
  { name: 'granite', pattern: 'granite', color: [0.232, 0.128, 0.104], color2: [0.318, 0.226, 0.198], color3: [0.086, 0.082, 0.080],
    roughness: 0.88, metallic: 0, height: 0.026, seed: 1061, scale: 1,
    params: [0.50, 0.22, 0.35, 0.20, 0.62, 0.34, 1.2, 1.10] },
  { name: 'polished_granite', pattern: 'granite', color: [0.248, 0.138, 0.112], color2: [0.336, 0.240, 0.210], color3: [0.092, 0.088, 0.086],
    roughness: 0.36, metallic: 0, height: 0.006, seed: 1063, scale: 1,
    params: [0.22, 0.05, 0.10, 0.04, 0.58, 0.42, 1.2, 1.14] },
  { name: 'diorite', pattern: 'diorite', color: [0.520, 0.516, 0.506], color2: [0.196, 0.196, 0.202], color3: [0.720, 0.718, 0.706],
    roughness: 0.86, metallic: 0, height: 0.024, seed: 1069, scale: 1,
    params: [0.52, 0.24, 0.36, 0.20, 0.70, 0.30, 1.1, 1.16] },
  { name: 'polished_diorite', pattern: 'diorite', color: [0.548, 0.544, 0.534], color2: [0.212, 0.212, 0.218], color3: [0.760, 0.758, 0.746],
    roughness: 0.34, metallic: 0, height: 0.005, seed: 1087, scale: 1,
    params: [0.24, 0.05, 0.10, 0.04, 0.64, 0.36, 1.1, 1.18] },
  { name: 'andesite', pattern: 'andesite', color: [0.190, 0.194, 0.190], color2: [0.114, 0.117, 0.115], color3: [0.302, 0.304, 0.300],
    roughness: 0.90, metallic: 0, height: 0.026, seed: 1091, scale: 1,
    params: [0.56, 0.26, 0.38, 0.22, 0.44, 0.16, 1.0, 1.08] },
  { name: 'polished_andesite', pattern: 'andesite', color: [0.206, 0.210, 0.206], color2: [0.126, 0.129, 0.127], color3: [0.324, 0.326, 0.322],
    roughness: 0.35, metallic: 0, height: 0.005, seed: 1093, scale: 1,
    params: [0.26, 0.05, 0.10, 0.04, 0.40, 0.20, 1.0, 1.10] },
  { name: 'deepslate', pattern: 'deepslate', color: [0.048, 0.049, 0.055], color2: [0.026, 0.027, 0.032], color3: [0.086, 0.087, 0.096],
    roughness: 0.88, metallic: 0, height: 0.034, seed: 1097, scale: 1,
    params: [0.58, 0.55, 0.50, 0.24, 0.30, 0.08, 1.0, 1.12] },
  { name: 'deepslate_top', pattern: 'deepslate', color: [0.052, 0.053, 0.059], color2: [0.028, 0.029, 0.034], color3: [0.092, 0.093, 0.102],
    roughness: 0.89, metallic: 0, height: 0.030, seed: 1103, scale: 1,
    params: [0.60, 0.22, 0.42, 0.26, 0.32, 0.08, 1.3, 1.10] },
  { name: 'cobbled_deepslate', pattern: 'cobble', color: [0.046, 0.047, 0.053], color2: [0.024, 0.025, 0.030], color3: [0.016, 0.016, 0.020],
    roughness: 0.93, metallic: 0, height: 0.108, seed: 1109, scale: 1,
    params: [0.60, 0.44, 0.90, 0.58, 0.30, 0.06, 1.0, 1.14] },
  { name: 'deepslate_bricks', pattern: 'deepslate_bricks', color: [0.052, 0.053, 0.060], color2: [0.032, 0.033, 0.038], color3: [0.018, 0.018, 0.022],
    roughness: 0.89, metallic: 0, height: 0.070, seed: 1117, scale: 1,
    params: [0.36, 0.24, 0.72, 0.22, 0.24, 0.06, 1.0, 1.08] },
  { name: 'tuff', pattern: 'tuff', color: [0.112, 0.116, 0.100], color2: [0.072, 0.075, 0.064], color3: [0.164, 0.168, 0.150],
    roughness: 0.94, metallic: 0, height: 0.040, seed: 1123, scale: 1,
    params: [0.66, 0.34, 0.55, 0.46, 0.42, 0.05, 1.4, 1.10] },
  { name: 'calcite', pattern: 'calcite', color: [0.700, 0.700, 0.682], color2: [0.556, 0.556, 0.540], color3: [0.868, 0.868, 0.856],
    roughness: 0.52, metallic: 0, height: 0.018, seed: 1129, scale: 1,
    params: [0.34, 0.30, 0.28, 0.10, 0.30, 0.46, 1.2, 1.06] },
  { name: 'dripstone', pattern: 'stone', color: [0.190, 0.140, 0.114], color2: [0.118, 0.086, 0.070], color3: [0.262, 0.202, 0.166],
    roughness: 0.90, metallic: 0, height: 0.052, seed: 1151, scale: 1,
    params: [0.62, 0.62, 0.60, 0.34, 0.40, 0.06, 0.7, 1.12] },
  { name: 'bedrock', pattern: 'bedrock', color: [0.070, 0.070, 0.073], color2: [0.018, 0.018, 0.020], color3: [0.152, 0.152, 0.155],
    roughness: 0.95, metallic: 0, height: 0.090, seed: 1153, scale: 1,
    params: [0.70, 0.40, 0.85, 0.60, 0.55, 0.04, 0.8, 1.45] },
  { name: 'bricks', pattern: 'bricks', color: [0.292, 0.104, 0.074], color2: [0.196, 0.072, 0.052], color3: [0.330, 0.320, 0.300],
    roughness: 0.88, metallic: 0, height: 0.066, seed: 1163, scale: 1,
    params: [0.40, 0.30, 0.65, 0.30, 0.35, 0.03, 1.0, 1.08] },
  { name: 'gravel', pattern: 'gravel', color: [0.130, 0.128, 0.124], color2: [0.072, 0.071, 0.068], color3: [0.202, 0.198, 0.190],
    roughness: 0.96, metallic: 0, height: 0.088, seed: 1171, scale: 1,
    params: [0.72, 0.50, 0.80, 0.70, 0.48, 0.07, 1.6, 1.16] },
  { name: 'clay', pattern: 'clay', color: [0.248, 0.260, 0.284], color2: [0.176, 0.186, 0.208], color3: [0.312, 0.322, 0.344],
    roughness: 0.84, metallic: 0, height: 0.016, seed: 1181, scale: 1,
    params: [0.34, 0.18, 0.22, 0.14, 0.20, 0.02, 1.0, 1.02] },
  { name: 'obsidian', pattern: 'obsidian', color: [0.014, 0.010, 0.022], color2: [0.030, 0.020, 0.056], color3: [0.076, 0.050, 0.132],
    roughness: 0.10, metallic: 0, height: 0.030, seed: 1187, scale: 1,
    params: [0.30, 0.45, 0.40, 0.55, 0.50, 0.30, 1.0, 1.25] },
  { name: 'crying_obsidian', pattern: 'obsidian', color: [0.016, 0.010, 0.030], color2: [0.040, 0.020, 0.090], color3: [0.300, 0.050, 0.560],
    roughness: 0.12, metallic: 0, emissive: 0.35, height: 0.034, seed: 1193, scale: 1,
    params: [0.32, 0.50, 0.45, 0.60, 0.62, 0.34, 1.0, 1.30] },
  { name: 'blackstone', pattern: 'blackstone', color: [0.044, 0.042, 0.050], color2: [0.024, 0.023, 0.029], color3: [0.080, 0.076, 0.090],
    roughness: 0.91, metallic: 0, height: 0.032, seed: 1201, scale: 1,
    params: [0.60, 0.34, 0.50, 0.30, 0.34, 0.10, 1.1, 1.14] },
  { name: 'basalt_top', pattern: 'basalt', color: [0.070, 0.070, 0.078], color2: [0.038, 0.038, 0.044], color3: [0.112, 0.112, 0.122],
    roughness: 0.90, metallic: 0, height: 0.046, seed: 1213, scale: 1,
    params: [0.58, 0.20, 0.60, 0.55, 0.30, 0.05, 1.0, 1.16] },
  { name: 'basalt_side', pattern: 'basalt', color: [0.066, 0.066, 0.074], color2: [0.034, 0.034, 0.040], color3: [0.106, 0.106, 0.116],
    roughness: 0.91, metallic: 0, height: 0.052, seed: 1217, scale: 1,
    params: [0.54, 0.85, 0.66, 0.35, 0.28, 0.05, 1.0, 1.18] },
  { name: 'netherrack', pattern: 'netherrack', color: [0.146, 0.044, 0.040], color2: [0.084, 0.024, 0.022], color3: [0.232, 0.080, 0.070],
    roughness: 0.93, metallic: 0, height: 0.050, seed: 1223, scale: 1,
    params: [0.68, 0.60, 0.62, 0.44, 0.46, 0.04, 1.3, 1.14] },
  { name: 'nether_bricks', pattern: 'bricks', color: [0.054, 0.028, 0.032], color2: [0.034, 0.017, 0.020], color3: [0.076, 0.040, 0.046],
    roughness: 0.90, metallic: 0, height: 0.062, seed: 1229, scale: 1,
    params: [0.44, 0.22, 0.72, 0.24, 0.30, 0.03, 1.0, 1.12] },
  { name: 'soul_sand', pattern: 'soul_sand', color: [0.086, 0.062, 0.048], color2: [0.044, 0.032, 0.025], color3: [0.150, 0.120, 0.100],
    roughness: 0.95, metallic: 0, height: 0.120, seed: 1231, scale: 1,
    params: [0.62, 0.55, 0.90, 0.30, 0.34, 0.03, 1.0, 1.18] },
  { name: 'soul_soil', pattern: 'soul_sand', color: [0.068, 0.048, 0.038], color2: [0.036, 0.026, 0.020], color3: [0.120, 0.096, 0.080],
    roughness: 0.96, metallic: 0, height: 0.086, seed: 1237, scale: 1,
    params: [0.70, 0.25, 0.70, 0.55, 0.30, 0.02, 1.2, 1.14] },
  { name: 'magma', pattern: 'magma', color: [0.086, 0.030, 0.012], color2: [0.900, 0.280, 0.030], color3: [1.000, 0.660, 0.220],
    roughness: 0.76, metallic: 0, emissive: 0.55, height: 0.060, seed: 1249, scale: 1,
    params: [0.60, 0.70, 0.75, 0.62, 0.50, 0.10, 1.0, 0.35] },
  { name: 'quartz_block', pattern: 'quartz', color: [0.760, 0.742, 0.712], color2: [0.640, 0.622, 0.596], color3: [0.884, 0.872, 0.852],
    roughness: 0.52, metallic: 0, height: 0.014, seed: 1259, scale: 1,
    params: [0.30, 0.45, 0.22, 0.10, 0.24, 0.38, 1.0, 1.04] },
  { name: 'end_stone', pattern: 'end_stone', color: [0.640, 0.628, 0.428], color2: [0.470, 0.460, 0.300], color3: [0.766, 0.752, 0.560],
    roughness: 0.86, metallic: 0, height: 0.034, seed: 1277, scale: 1,
    params: [0.58, 0.42, 0.44, 0.26, 0.40, 0.08, 1.2, 1.10] },
  { name: 'purpur', pattern: 'purpur', color: [0.320, 0.200, 0.332], color2: [0.234, 0.146, 0.244], color3: [0.428, 0.292, 0.436],
    roughness: 0.80, metallic: 0, height: 0.030, seed: 1279, scale: 1,
    params: [0.52, 0.36, 0.40, 0.20, 0.36, 0.22, 1.1, 1.08] },
  { name: 'prismarine', pattern: 'prismarine', color: [0.110, 0.290, 0.264], color2: [0.068, 0.198, 0.188], color3: [0.192, 0.402, 0.360],
    roughness: 0.55, metallic: 0, height: 0.042, seed: 1283, scale: 1,
    params: [0.40, 0.62, 0.55, 0.45, 0.55, 0.26, 1.0, 1.10] },
  { name: 'dark_prismarine', pattern: 'prismarine', color: [0.030, 0.090, 0.074], color2: [0.017, 0.054, 0.046], color3: [0.062, 0.150, 0.126],
    roughness: 0.60, metallic: 0, height: 0.030, seed: 1289, scale: 1,
    params: [0.36, 0.30, 0.42, 0.12, 0.40, 0.16, 1.8, 1.14] },
  { name: 'sea_lantern', pattern: 'sea_lantern', color: [0.620, 0.780, 0.762], color2: [0.396, 0.556, 0.548], color3: [0.900, 0.980, 0.960],
    roughness: 0.34, metallic: 0, emissive: 0.90, height: 0.026, seed: 1291, scale: 1,
    params: [0.26, 0.40, 0.34, 0.35, 0.30, 0.55, 1.0, 1.06] },
  { name: 'amethyst_block', pattern: 'amethyst', color: [0.330, 0.170, 0.520], color2: [0.190, 0.090, 0.330], color3: [0.640, 0.420, 0.850],
    roughness: 0.28, metallic: 0, emissive: 0.03, height: 0.070, seed: 1297, scale: 1,
    params: [0.30, 0.55, 0.65, 0.50, 0.45, 0.60, 1.0, 1.12] },
  { name: 'budding_amethyst', pattern: 'amethyst', color: [0.300, 0.150, 0.480], color2: [0.170, 0.078, 0.300], color3: [0.720, 0.500, 0.940],
    roughness: 0.26, metallic: 0, emissive: 0.07, height: 0.100, seed: 1301, scale: 1,
    params: [0.34, 0.85, 0.85, 0.55, 0.50, 0.72, 1.0, 1.18] },
  { name: 'glowstone', pattern: 'glowstone', color: [0.680, 0.470, 0.190], color2: [0.300, 0.180, 0.066], color3: [1.000, 0.860, 0.550],
    roughness: 0.60, metallic: 0, emissive: 1.00, height: 0.080, seed: 1303, scale: 1,
    params: [0.44, 0.55, 0.70, 0.50, 0.40, 0.62, 1.0, 1.10] },
  // ------------------------------------------------------- soil & surface ---
  { name: 'dirt', pattern: 'dirt', color: [0.116, 0.068, 0.038], color2: [0.074, 0.043, 0.024], color3: [0.162, 0.100, 0.058],
    roughness: 0.95, metallic: 0, height: 0.048, seed: 1307, scale: 1,
    params: [0.66, 0.34, 0.55, 0.30, 0.38, 0.12, 1.0, 1.10] },
  { name: 'coarse_dirt', pattern: 'dirt', color: [0.098, 0.058, 0.032], color2: [0.062, 0.036, 0.020], color3: [0.148, 0.092, 0.052],
    roughness: 0.97, metallic: 0, height: 0.062, seed: 1319, scale: 1,
    params: [0.74, 0.62, 0.70, 0.18, 0.44, 0.16, 1.3, 1.16] },
  { name: 'grass_block_top', pattern: 'grass_top', color: [0.240, 0.360, 0.114], color2: [0.148, 0.248, 0.070], color3: [0.360, 0.470, 0.180],
    roughness: 0.90, metallic: 0, height: 0.038, seed: 1321, scale: 1,
    params: [0.52, 0.78, 0.45, 0.30, 0.42, 0.22, 1.4, 1.08] },
  { name: 'grass_block_side', pattern: 'grass_side', color: [0.240, 0.360, 0.114], color2: [0.116, 0.068, 0.038], color3: [0.140, 0.232, 0.062],
    roughness: 0.92, metallic: 0, height: 0.050, seed: 1327, scale: 1,
    params: [0.60, 0.62, 0.50, 0.34, 0.36, 0.10, 1.0, 1.08] },
  { name: 'podzol_top', pattern: 'podzol', color: [0.156, 0.094, 0.034], color2: [0.088, 0.054, 0.020], color3: [0.232, 0.160, 0.070],
    roughness: 0.95, metallic: 0, height: 0.055, seed: 1361, scale: 1,
    params: [0.70, 0.40, 0.52, 0.25, 0.46, 0.55, 1.2, 1.12] },
  { name: 'podzol_side', pattern: 'grass_side', color: [0.156, 0.094, 0.034], color2: [0.108, 0.062, 0.034], color3: [0.088, 0.054, 0.020],
    roughness: 0.95, metallic: 0, height: 0.048, seed: 1367, scale: 1,
    params: [0.66, 0.55, 0.45, 0.28, 0.34, 0.10, 1.0, 1.10] },
  { name: 'mycelium_top', pattern: 'mycelium', color: [0.160, 0.128, 0.150], color2: [0.098, 0.078, 0.094], color3: [0.302, 0.252, 0.292],
    roughness: 0.93, metallic: 0, height: 0.044, seed: 1373, scale: 1,
    params: [0.72, 0.35, 0.44, 0.22, 0.52, 0.62, 1.5, 1.10] },
  { name: 'mycelium_side', pattern: 'grass_side', color: [0.160, 0.128, 0.150], color2: [0.116, 0.068, 0.038], color3: [0.098, 0.078, 0.094],
    roughness: 0.94, metallic: 0, height: 0.046, seed: 1381, scale: 1,
    params: [0.68, 0.50, 0.42, 0.24, 0.34, 0.12, 1.0, 1.08] },
  { name: 'dirt_path_top', pattern: 'path', color: [0.146, 0.100, 0.052], color2: [0.094, 0.064, 0.033], color3: [0.192, 0.140, 0.076],
    roughness: 0.93, metallic: 0, height: 0.030, seed: 1399, scale: 1,
    params: [0.48, 0.28, 0.35, 0.72, 0.30, 0.06, 1.0, 1.06] },
  { name: 'farmland', pattern: 'farmland', color: [0.096, 0.058, 0.032], color2: [0.062, 0.037, 0.020], color3: [0.140, 0.090, 0.050],
    roughness: 0.94, metallic: 0, height: 0.130, seed: 1409, scale: 1,
    params: [0.58, 0.30, 0.85, 0.10, 0.32, 0.08, 1.0, 1.10] },
  { name: 'farmland_moist', pattern: 'farmland', color: [0.048, 0.029, 0.016], color2: [0.030, 0.018, 0.010], color3: [0.078, 0.050, 0.028],
    roughness: 0.78, metallic: 0, height: 0.130, seed: 1423, scale: 1,
    params: [0.54, 0.34, 0.85, 0.72, 0.30, 0.10, 1.0, 1.06] },
  { name: 'mud', pattern: 'mud', color: [0.055, 0.042, 0.038], color2: [0.033, 0.025, 0.023], color3: [0.090, 0.072, 0.065],
    roughness: 0.70, metallic: 0, height: 0.040, seed: 1427, scale: 1,
    params: [0.42, 0.55, 0.45, 0.80, 0.26, 0.04, 1.1, 1.04] },
  { name: 'moss_block', pattern: 'moss', color: [0.056, 0.130, 0.030], color2: [0.030, 0.078, 0.017], color3: [0.104, 0.204, 0.058],
    roughness: 0.96, metallic: 0, height: 0.072, seed: 1429, scale: 1,
    params: [0.74, 0.82, 0.60, 0.18, 0.44, 0.40, 1.6, 1.10] },
  { name: 'sand', pattern: 'sand', color: [0.520, 0.450, 0.268], color2: [0.418, 0.348, 0.198], color3: [0.640, 0.572, 0.380],
    roughness: 0.90, metallic: 0, height: 0.036, seed: 1433, scale: 1,
    params: [0.48, 0.55, 0.30, 0.30, 0.26, 0.30, 1.0, 1.04] },
  { name: 'red_sand', pattern: 'sand', color: [0.400, 0.156, 0.055], color2: [0.300, 0.110, 0.038], color3: [0.520, 0.232, 0.092],
    roughness: 0.91, metallic: 0, height: 0.036, seed: 1439, scale: 1,
    params: [0.50, 0.58, 0.32, 0.30, 0.30, 0.24, 1.0, 1.06] },
  { name: 'sandstone_top', pattern: 'sandstone', color: [0.530, 0.468, 0.300], color2: [0.420, 0.362, 0.222], color3: [0.640, 0.580, 0.400],
    roughness: 0.88, metallic: 0, height: 0.022, seed: 1447, scale: 1,
    params: [0.44, 0.12, 0.25, 0.22, 0.26, 0.18, 1.0, 1.05] },
  { name: 'sandstone_side', pattern: 'sandstone', color: [0.528, 0.464, 0.296], color2: [0.402, 0.344, 0.208], color3: [0.646, 0.586, 0.406],
    roughness: 0.89, metallic: 0, height: 0.048, seed: 1451, scale: 1,
    params: [0.46, 0.80, 0.60, 0.28, 0.34, 0.16, 1.0, 1.08] },
  { name: 'red_sandstone_top', pattern: 'sandstone', color: [0.396, 0.158, 0.058], color2: [0.300, 0.116, 0.042], color3: [0.500, 0.222, 0.090],
    roughness: 0.88, metallic: 0, height: 0.022, seed: 1453, scale: 1,
    params: [0.44, 0.14, 0.26, 0.22, 0.28, 0.16, 1.0, 1.06] },
  { name: 'red_sandstone_side', pattern: 'sandstone', color: [0.392, 0.154, 0.056], color2: [0.288, 0.108, 0.038], color3: [0.510, 0.230, 0.096],
    roughness: 0.89, metallic: 0, height: 0.048, seed: 1459, scale: 1,
    params: [0.46, 0.82, 0.62, 0.30, 0.36, 0.14, 1.0, 1.10] },
  { name: 'snow', pattern: 'snow', color: [0.900, 0.920, 0.960], color2: [0.740, 0.775, 0.845], color3: [1.000, 1.000, 1.000],
    roughness: 0.72, metallic: 0, height: 0.030, seed: 1471, scale: 1,
    params: [0.30, 0.18, 0.28, 0.40, 0.18, 0.75, 1.6, 1.02] },
  { name: 'ice', pattern: 'ice', color: [0.480, 0.640, 0.780], color2: [0.290, 0.470, 0.660], color3: [0.860, 0.940, 1.000],
    roughness: 0.05, metallic: 0, height: 0.026, seed: 1481, scale: 1, alpha: true,
    params: [0.22, 0.50, 0.45, 0.35, 0.45, 0.55, 1.0, 1.06] },
  { name: 'packed_ice', pattern: 'packed_ice', color: [0.400, 0.560, 0.740], color2: [0.230, 0.400, 0.620], color3: [0.800, 0.900, 1.000],
    roughness: 0.12, metallic: 0, height: 0.030, seed: 1483, scale: 1, alpha: true,
    params: [0.28, 0.42, 0.40, 0.62, 0.42, 0.90, 1.2, 1.08] },
  { name: 'ice_blue', pattern: 'packed_ice', color: [0.150, 0.380, 0.720], color2: [0.080, 0.240, 0.560], color3: [0.640, 0.840, 1.000],
    roughness: 0.08, metallic: 0, height: 0.024, seed: 1487, scale: 1, alpha: true,
    params: [0.20, 0.34, 0.34, 0.45, 0.50, 0.96, 1.0, 1.10] },
  // ---------------------------------------------------------------- wood ---
  { name: 'oak_log', pattern: 'log_side', color: [0.076, 0.052, 0.028], color2: [0.040, 0.027, 0.014], color3: [0.124, 0.108, 0.070],
    roughness: 0.92, metallic: 0, height: 0.056, seed: 1489, scale: 1,
    params: [0.58, 0.62, 0.60, 0.35, 0.34, 0.05, 1.0, 1.10] },
  { name: 'oak_log_top', pattern: 'log_top', color: [0.230, 0.152, 0.076], color2: [0.160, 0.102, 0.050], color3: [0.076, 0.052, 0.028],
    roughness: 0.90, metallic: 0, height: 0.028, seed: 1493, scale: 1,
    params: [0.42, 0.62, 0.35, 0.30, 0.55, 0.30, 1.0, 1.08] },
  { name: 'oak_planks', pattern: 'planks', color: [0.230, 0.150, 0.075], color2: [0.166, 0.106, 0.052], color3: [0.300, 0.208, 0.110],
    roughness: 0.80, metallic: 0, height: 0.020, seed: 1499, scale: 1,
    params: [0.40, 0.55, 0.45, 0.22, 0.30, 0.06, 1.0, 1.06] },
  { name: 'oak_leaves', pattern: 'leaves', color: [0.100, 0.240, 0.055], color2: [0.048, 0.128, 0.026], color3: [0.220, 0.400, 0.110],
    roughness: 0.86, metallic: 0, height: 0.060, seed: 1511, scale: 1, alpha: true,
    params: [0.55, 0.70, 0.55, 0.30, 0.50, 0.45, 1.2, 1.12] },
  { name: 'spruce_log', pattern: 'log_side', color: [0.046, 0.030, 0.018], color2: [0.024, 0.015, 0.009], color3: [0.086, 0.070, 0.048],
    roughness: 0.94, metallic: 0, height: 0.070, seed: 1523, scale: 1,
    params: [0.66, 0.82, 0.75, 0.42, 0.36, 0.06, 1.0, 1.16] },
  { name: 'spruce_log_top', pattern: 'log_top', color: [0.115, 0.070, 0.036], color2: [0.078, 0.046, 0.023], color3: [0.046, 0.030, 0.018],
    roughness: 0.91, metallic: 0, height: 0.026, seed: 1531, scale: 1,
    params: [0.46, 0.78, 0.38, 0.34, 0.55, 0.26, 1.0, 1.10] },
  { name: 'spruce_planks', pattern: 'plank_dark', color: [0.112, 0.070, 0.035], color2: [0.074, 0.045, 0.022], color3: [0.160, 0.106, 0.056],
    roughness: 0.82, metallic: 0, height: 0.020, seed: 1543, scale: 1,
    params: [0.44, 0.58, 0.45, 0.24, 0.32, 0.05, 1.0, 1.10] },
  { name: 'spruce_leaves', pattern: 'leaves', color: [0.040, 0.115, 0.048], color2: [0.020, 0.062, 0.026], color3: [0.096, 0.200, 0.086],
    roughness: 0.88, metallic: 0, height: 0.068, seed: 1549, scale: 1, alpha: true,
    params: [0.60, 0.85, 0.60, 0.38, 0.46, 0.36, 1.5, 1.14] },
  { name: 'birch_log', pattern: 'log_side', color: [0.640, 0.622, 0.560], color2: [0.470, 0.456, 0.404], color3: [0.048, 0.044, 0.040],
    roughness: 0.90, metallic: 0, height: 0.034, seed: 1553, scale: 1,
    params: [0.40, 0.30, 0.35, 0.62, 0.30, 0.04, 1.0, 1.22] },
  { name: 'birch_log_top', pattern: 'log_top', color: [0.480, 0.400, 0.250], color2: [0.360, 0.296, 0.180], color3: [0.640, 0.622, 0.560],
    roughness: 0.88, metallic: 0, height: 0.024, seed: 1559, scale: 1,
    params: [0.38, 0.55, 0.30, 0.24, 0.48, 0.26, 1.0, 1.06] },
  { name: 'birch_planks', pattern: 'planks', color: [0.480, 0.400, 0.250], color2: [0.372, 0.304, 0.184], color3: [0.580, 0.500, 0.336],
    roughness: 0.78, metallic: 0, height: 0.018, seed: 1567, scale: 1,
    params: [0.34, 0.48, 0.40, 0.16, 0.24, 0.06, 1.0, 1.04] },
  { name: 'birch_leaves', pattern: 'leaves', color: [0.140, 0.270, 0.075], color2: [0.070, 0.150, 0.038], color3: [0.280, 0.440, 0.150],
    roughness: 0.86, metallic: 0, height: 0.056, seed: 1571, scale: 1, alpha: true,
    params: [0.52, 0.66, 0.52, 0.32, 0.48, 0.50, 1.2, 1.10] },
  { name: 'jungle_log', pattern: 'log_side', color: [0.096, 0.070, 0.044], color2: [0.052, 0.036, 0.022], color3: [0.150, 0.140, 0.086],
    roughness: 0.93, metallic: 0, height: 0.062, seed: 1579, scale: 1,
    params: [0.62, 0.70, 0.66, 0.36, 0.40, 0.16, 1.0, 1.12] },
  { name: 'jungle_log_top', pattern: 'log_top', color: [0.290, 0.180, 0.114], color2: [0.196, 0.120, 0.074], color3: [0.096, 0.070, 0.044],
    roughness: 0.90, metallic: 0, height: 0.028, seed: 1583, scale: 1,
    params: [0.44, 0.70, 0.36, 0.30, 0.52, 0.30, 1.0, 1.08] },
  { name: 'jungle_planks', pattern: 'planks', color: [0.290, 0.180, 0.114], color2: [0.208, 0.126, 0.078], color3: [0.376, 0.246, 0.164],
    roughness: 0.79, metallic: 0, height: 0.020, seed: 1597, scale: 1,
    params: [0.42, 0.52, 0.44, 0.20, 0.32, 0.06, 1.0, 1.06] },
  { name: 'jungle_leaves', pattern: 'leaves', color: [0.075, 0.230, 0.040], color2: [0.036, 0.124, 0.020], color3: [0.180, 0.400, 0.090],
    roughness: 0.85, metallic: 0, height: 0.066, seed: 1601, scale: 1, alpha: true,
    params: [0.58, 0.86, 0.60, 0.26, 0.52, 0.52, 1.4, 1.14] },
  { name: 'acacia_log', pattern: 'log_side', color: [0.100, 0.076, 0.056], color2: [0.056, 0.040, 0.028], color3: [0.170, 0.150, 0.110],
    roughness: 0.93, metallic: 0, height: 0.058, seed: 1607, scale: 1,
    params: [0.60, 0.72, 0.62, 0.40, 0.38, 0.08, 1.0, 1.14] },
  { name: 'acacia_log_top', pattern: 'log_top', color: [0.400, 0.160, 0.060], color2: [0.276, 0.112, 0.042], color3: [0.100, 0.076, 0.056],
    roughness: 0.90, metallic: 0, height: 0.026, seed: 1609, scale: 1,
    params: [0.44, 0.64, 0.34, 0.28, 0.56, 0.28, 1.0, 1.10] },
  { name: 'acacia_planks', pattern: 'planks', color: [0.400, 0.160, 0.060], color2: [0.286, 0.114, 0.042], color3: [0.500, 0.222, 0.096],
    roughness: 0.80, metallic: 0, height: 0.020, seed: 1613, scale: 1,
    params: [0.42, 0.55, 0.44, 0.22, 0.34, 0.06, 1.0, 1.08] },
  { name: 'acacia_leaves', pattern: 'leaves', color: [0.140, 0.250, 0.055], color2: [0.072, 0.140, 0.028], color3: [0.280, 0.420, 0.120],
    roughness: 0.87, metallic: 0, height: 0.058, seed: 1619, scale: 1, alpha: true,
    params: [0.56, 0.62, 0.54, 0.38, 0.50, 0.44, 1.2, 1.12] },
  { name: 'dark_oak_log', pattern: 'log_side', color: [0.036, 0.024, 0.015], color2: [0.019, 0.013, 0.008], color3: [0.070, 0.058, 0.040],
    roughness: 0.94, metallic: 0, height: 0.066, seed: 1621, scale: 1,
    params: [0.64, 0.76, 0.70, 0.40, 0.34, 0.06, 1.0, 1.18] },
  { name: 'dark_oak_log_top', pattern: 'log_top', color: [0.076, 0.046, 0.023], color2: [0.050, 0.030, 0.015], color3: [0.036, 0.024, 0.015],
    roughness: 0.91, metallic: 0, height: 0.026, seed: 1627, scale: 1,
    params: [0.46, 0.72, 0.36, 0.32, 0.52, 0.24, 1.0, 1.12] },
  { name: 'dark_oak_planks', pattern: 'plank_dark', color: [0.076, 0.045, 0.022], color2: [0.048, 0.028, 0.014], color3: [0.118, 0.074, 0.038],
    roughness: 0.82, metallic: 0, height: 0.020, seed: 1637, scale: 1,
    params: [0.46, 0.60, 0.46, 0.24, 0.34, 0.05, 1.0, 1.12] },
  { name: 'dark_oak_leaves', pattern: 'leaves', color: [0.060, 0.170, 0.040], color2: [0.028, 0.090, 0.020], color3: [0.140, 0.290, 0.078],
    roughness: 0.87, metallic: 0, height: 0.062, seed: 1657, scale: 1, alpha: true,
    params: [0.58, 0.80, 0.58, 0.30, 0.48, 0.40, 1.3, 1.14] },
  { name: 'cherry_log', pattern: 'log_side', color: [0.062, 0.040, 0.045], color2: [0.034, 0.021, 0.024], color3: [0.130, 0.100, 0.100],
    roughness: 0.92, metallic: 0, height: 0.050, seed: 1663, scale: 1,
    params: [0.56, 0.66, 0.58, 0.34, 0.36, 0.06, 1.0, 1.12] },
  { name: 'cherry_log_top', pattern: 'log_top', color: [0.480, 0.300, 0.290], color2: [0.340, 0.204, 0.196], color3: [0.062, 0.040, 0.045],
    roughness: 0.88, metallic: 0, height: 0.024, seed: 1667, scale: 1,
    params: [0.40, 0.60, 0.32, 0.26, 0.50, 0.26, 1.0, 1.06] },
  { name: 'cherry_planks', pattern: 'planks', color: [0.480, 0.300, 0.290], color2: [0.356, 0.216, 0.208], color3: [0.590, 0.400, 0.386],
    roughness: 0.76, metallic: 0, height: 0.018, seed: 1669, scale: 1,
    params: [0.36, 0.50, 0.40, 0.16, 0.28, 0.07, 1.0, 1.04] },
  { name: 'cherry_leaves', pattern: 'leaves', color: [0.640, 0.330, 0.420], color2: [0.440, 0.190, 0.270], color3: [0.900, 0.640, 0.720],
    roughness: 0.84, metallic: 0, height: 0.058, seed: 1693, scale: 1, alpha: true,
    params: [0.50, 0.90, 0.52, 0.28, 0.55, 0.60, 1.5, 1.08] },
  // ---------------------------------------------------------------- ores ---
  // color = mineral, color2 = host rock, color3 = mineral rim. params[3] = host id.
  { name: 'coal_ore', pattern: 'ore', color: [0.013, 0.013, 0.014], color2: [0.175, 0.175, 0.180], color3: [0.060, 0.060, 0.063],
    roughness: 0.74, metallic: 0, height: 0.034, seed: 1697, scale: 1,
    params: [0.55, 0.60, 0.42, 0.0, 0.22, 0.14, 1.0, 1.14] },
  { name: 'iron_ore', pattern: 'ore', color: [0.420, 0.300, 0.220], color2: [0.175, 0.175, 0.180], color3: [0.620, 0.470, 0.360],
    roughness: 0.62, metallic: 0, height: 0.032, seed: 1699, scale: 1,
    params: [0.55, 0.55, 0.40, 0.0, 0.30, 0.30, 1.0, 1.10] },
  { name: 'copper_ore', pattern: 'ore', color: [0.310, 0.470, 0.372], color2: [0.175, 0.175, 0.180], color3: [0.560, 0.700, 0.560],
    roughness: 0.58, metallic: 0, height: 0.032, seed: 1709, scale: 1,
    params: [0.55, 0.58, 0.42, 0.0, 0.34, 0.26, 1.0, 1.10] },
  { name: 'gold_ore', pattern: 'ore', color: [0.900, 0.640, 0.120], color2: [0.175, 0.175, 0.180], color3: [1.000, 0.850, 0.400],
    roughness: 0.30, metallic: 1, height: 0.030, seed: 1721, scale: 1,
    params: [0.55, 0.52, 0.38, 0.0, 0.22, 0.55, 1.0, 1.12] },
  { name: 'redstone_ore', pattern: 'ore', color: [0.520, 0.020, 0.018], color2: [0.175, 0.175, 0.180], color3: [0.900, 0.100, 0.080],
    roughness: 0.52, metallic: 0, emissive: 0.06, height: 0.030, seed: 1723, scale: 1,
    params: [0.55, 0.72, 0.32, 0.0, 0.26, 0.40, 1.0, 1.14] },
  { name: 'lapis_ore', pattern: 'ore', color: [0.030, 0.088, 0.420], color2: [0.175, 0.175, 0.180], color3: [0.150, 0.300, 0.700],
    roughness: 0.44, metallic: 0, height: 0.030, seed: 1733, scale: 1,
    params: [0.55, 0.60, 0.40, 0.0, 0.36, 0.44, 1.0, 1.12] },
  { name: 'diamond_ore', pattern: 'gem_ore', color: [0.180, 0.700, 0.700], color2: [0.175, 0.175, 0.180], color3: [0.620, 0.960, 0.960],
    roughness: 0.15, metallic: 0, emissive: 0.04, height: 0.036, seed: 1741, scale: 1,
    params: [0.55, 0.50, 0.44, 0.0, 0.24, 0.72, 1.0, 1.16] },
  { name: 'emerald_ore', pattern: 'gem_ore', color: [0.040, 0.520, 0.150], color2: [0.175, 0.175, 0.180], color3: [0.300, 0.900, 0.400],
    roughness: 0.18, metallic: 0, emissive: 0.03, height: 0.036, seed: 1747, scale: 1,
    params: [0.55, 0.42, 0.46, 0.0, 0.26, 0.66, 1.0, 1.16] },
  { name: 'deepslate_coal_ore', pattern: 'ore', color: [0.011, 0.011, 0.012], color2: [0.048, 0.049, 0.055], color3: [0.070, 0.070, 0.074],
    roughness: 0.74, metallic: 0, height: 0.034, seed: 1753, scale: 1,
    params: [0.58, 0.60, 0.42, 1.0, 0.22, 0.14, 1.0, 1.20] },
  { name: 'deepslate_iron_ore', pattern: 'ore', color: [0.400, 0.286, 0.208], color2: [0.048, 0.049, 0.055], color3: [0.600, 0.450, 0.340],
    roughness: 0.62, metallic: 0, height: 0.032, seed: 1759, scale: 1,
    params: [0.58, 0.55, 0.40, 1.0, 0.30, 0.30, 1.0, 1.16] },
  { name: 'deepslate_copper_ore', pattern: 'ore', color: [0.296, 0.450, 0.356], color2: [0.048, 0.049, 0.055], color3: [0.540, 0.680, 0.540],
    roughness: 0.58, metallic: 0, height: 0.032, seed: 1777, scale: 1,
    params: [0.58, 0.58, 0.42, 1.0, 0.34, 0.26, 1.0, 1.16] },
  { name: 'deepslate_gold_ore', pattern: 'ore', color: [0.880, 0.620, 0.110], color2: [0.048, 0.049, 0.055], color3: [1.000, 0.840, 0.390],
    roughness: 0.30, metallic: 1, height: 0.030, seed: 1783, scale: 1,
    params: [0.58, 0.52, 0.38, 1.0, 0.22, 0.55, 1.0, 1.18] },
  { name: 'deepslate_redstone_ore', pattern: 'ore', color: [0.500, 0.018, 0.016], color2: [0.048, 0.049, 0.055], color3: [0.880, 0.095, 0.075],
    roughness: 0.52, metallic: 0, emissive: 0.07, height: 0.030, seed: 1787, scale: 1,
    params: [0.58, 0.72, 0.32, 1.0, 0.26, 0.40, 1.0, 1.20] },
  { name: 'deepslate_lapis_ore', pattern: 'ore', color: [0.028, 0.082, 0.400], color2: [0.048, 0.049, 0.055], color3: [0.160, 0.310, 0.720],
    roughness: 0.44, metallic: 0, height: 0.030, seed: 1789, scale: 1,
    params: [0.58, 0.60, 0.40, 1.0, 0.36, 0.44, 1.0, 1.18] },
  { name: 'deepslate_diamond_ore', pattern: 'gem_ore', color: [0.170, 0.680, 0.680], color2: [0.048, 0.049, 0.055], color3: [0.640, 0.980, 0.980],
    roughness: 0.15, metallic: 0, emissive: 0.05, height: 0.036, seed: 1801, scale: 1,
    params: [0.58, 0.50, 0.44, 1.0, 0.24, 0.72, 1.0, 1.22] },
  { name: 'deepslate_emerald_ore', pattern: 'gem_ore', color: [0.038, 0.500, 0.145], color2: [0.048, 0.049, 0.055], color3: [0.320, 0.920, 0.420],
    roughness: 0.18, metallic: 0, emissive: 0.04, height: 0.036, seed: 1811, scale: 1,
    params: [0.58, 0.42, 0.46, 1.0, 0.26, 0.66, 1.0, 1.22] },
  { name: 'ancient_debris_top', pattern: 'ore', color: [0.180, 0.110, 0.092], color2: [0.044, 0.042, 0.050], color3: [0.360, 0.256, 0.222],
    roughness: 0.45, metallic: 1, height: 0.040, seed: 1823, scale: 1,
    params: [0.60, 0.36, 0.62, 3.0, 0.30, 0.34, 1.0, 1.18] },
  { name: 'ancient_debris_side', pattern: 'ore', color: [0.170, 0.104, 0.086], color2: [0.042, 0.040, 0.048], color3: [0.340, 0.240, 0.208],
    roughness: 0.48, metallic: 1, height: 0.040, seed: 1831, scale: 1,
    params: [0.60, 0.28, 0.54, 3.0, 0.30, 0.30, 1.0, 1.16] },
  // ------------------------------------------------- metal & mineral blocks ---
  { name: 'iron_block', pattern: 'metal', color: [0.560, 0.560, 0.570], color2: [0.380, 0.378, 0.386], color3: [0.780, 0.780, 0.790],
    roughness: 0.25, metallic: 1, height: 0.014, seed: 1847, scale: 1,
    params: [0.20, 0.55, 0.25, 0.18, 0.14, 0.35, 1.0, 1.05] },
  { name: 'gold_block', pattern: 'gold_block', color: [1.000, 0.766, 0.336], color2: [0.700, 0.520, 0.200], color3: [1.000, 0.900, 0.620],
    roughness: 0.17, metallic: 1, height: 0.018, seed: 1861, scale: 1,
    params: [0.16, 0.30, 0.45, 0.12, 0.22, 0.45, 1.0, 1.06] },
  { name: 'diamond_block', pattern: 'diamond_block', color: [0.300, 0.850, 0.860], color2: [0.150, 0.560, 0.580], color3: [0.820, 1.000, 1.000],
    roughness: 0.11, metallic: 0, emissive: 0.02, height: 0.024, seed: 1867, scale: 1,
    params: [0.18, 0.28, 0.55, 0.08, 0.30, 0.80, 1.0, 1.10] },
  { name: 'emerald_block', pattern: 'emerald_block', color: [0.050, 0.620, 0.180], color2: [0.020, 0.360, 0.100], color3: [0.420, 0.960, 0.520],
    roughness: 0.14, metallic: 0, emissive: 0.02, height: 0.026, seed: 1871, scale: 1,
    params: [0.20, 0.34, 0.58, 0.08, 0.34, 0.70, 1.0, 1.12] },
  { name: 'lapis_block', pattern: 'diamond_block', color: [0.030, 0.110, 0.480], color2: [0.014, 0.058, 0.300], color3: [0.260, 0.420, 0.860],
    roughness: 0.42, metallic: 0, height: 0.020, seed: 1873, scale: 1,
    params: [0.34, 0.40, 0.40, 0.18, 0.42, 0.36, 1.3, 1.10] },
  { name: 'redstone_block', pattern: 'emerald_block', color: [0.480, 0.020, 0.015], color2: [0.276, 0.010, 0.008], color3: [0.920, 0.130, 0.090],
    roughness: 0.58, metallic: 0, emissive: 0.07, height: 0.024, seed: 1877, scale: 1,
    params: [0.36, 0.46, 0.50, 0.20, 0.36, 0.28, 1.2, 1.14] },
  { name: 'coal_block', pattern: 'solid', color: [0.014, 0.014, 0.015], color2: [0.007, 0.007, 0.008], color3: [0.058, 0.058, 0.062],
    roughness: 0.60, metallic: 0, height: 0.030, seed: 1879, scale: 1,
    params: [0.62, 0.42, 0.45, 0.30, 0.30, 0.32, 1.4, 1.30] },
  { name: 'netherite_block', pattern: 'metal', color: [0.076, 0.062, 0.068], color2: [0.044, 0.035, 0.039], color3: [0.152, 0.130, 0.136],
    roughness: 0.42, metallic: 1, height: 0.026, seed: 1889, scale: 1,
    params: [0.34, 0.40, 0.50, 0.30, 0.24, 0.22, 1.0, 1.16] },
  { name: 'raw_iron_block', pattern: 'ore', color: [0.330, 0.230, 0.170], color2: [0.216, 0.148, 0.108], color3: [0.480, 0.360, 0.280],
    roughness: 0.70, metallic: 0, height: 0.050, seed: 1901, scale: 1,
    params: [0.55, 1.00, 0.90, 0.0, 0.38, 0.22, 1.4, 1.10] },
  { name: 'copper_block', pattern: 'copper', color: [0.640, 0.300, 0.170], color2: [0.130, 0.470, 0.395], color3: [0.900, 0.560, 0.360],
    roughness: 0.30, metallic: 1, height: 0.016, seed: 1907, scale: 1,
    params: [0.24, 0.45, 0.25, 0.05, 0.20, 0.40, 1.0, 1.06] },
  { name: 'oxidized_copper', pattern: 'copper_oxidized', color: [0.128, 0.470, 0.396], color2: [0.320, 0.180, 0.110], color3: [0.260, 0.640, 0.560],
    roughness: 0.80, metallic: 0, height: 0.034, seed: 1913, scale: 1,
    params: [0.52, 0.60, 0.50, 0.92, 0.42, 0.06, 1.1, 1.08] },
  { name: 'cut_copper', pattern: 'copper', color: [0.616, 0.288, 0.164], color2: [0.130, 0.470, 0.395], color3: [0.880, 0.540, 0.340],
    roughness: 0.32, metallic: 1, height: 0.030, seed: 1931, scale: 1,
    params: [0.26, 0.40, 0.62, 0.12, 0.22, 0.34, 2.0, 1.08] },
  // ------------------------------------------------- fluids & translucent ---
  { name: 'water_still', pattern: 'water', color: [0.010, 0.055, 0.090], color2: [0.020, 0.112, 0.150], color3: [0.620, 0.800, 0.900],
    roughness: 0.02, metallic: 0, height: 0.020, seed: 1933, scale: 1, alpha: true,
    params: [0.30, 0.55, 0.40, 0.20, 0.35, 0.62, 1.0, 1.00] },
  { name: 'lava_still', pattern: 'lava', color: [0.120, 0.030, 0.006], color2: [1.000, 0.300, 0.020], color3: [1.000, 0.800, 0.350],
    roughness: 0.66, metallic: 0, emissive: 1.00, height: 0.046, seed: 1949, scale: 1,
    params: [0.52, 0.72, 0.55, 0.55, 0.50, 0.35, 1.0, 0.28] },
  { name: 'glass', pattern: 'glass', color: [0.850, 0.900, 0.920], color2: [0.600, 0.700, 0.750], color3: [0.960, 0.985, 1.000],
    roughness: 0.04, metallic: 0, height: 0.008, seed: 1951, scale: 1, alpha: true,
    params: [0.10, 0.55, 0.40, 0.18, 0.10, 0.10, 1.0, 1.02] },
  { name: 'tinted_glass', pattern: 'glass', color: [0.060, 0.052, 0.070], color2: [0.030, 0.026, 0.038], color3: [0.220, 0.200, 0.250],
    roughness: 0.05, metallic: 0, height: 0.008, seed: 1973, scale: 1, alpha: true,
    params: [0.12, 0.55, 0.40, 0.15, 0.14, 0.72, 1.0, 1.04] },
  { name: 'slime_block', pattern: 'slime', color: [0.240, 0.520, 0.200], color2: [0.110, 0.300, 0.090], color3: [0.560, 0.860, 0.460],
    roughness: 0.30, metallic: 0, height: 0.055, seed: 1979, scale: 1, alpha: true,
    params: [0.26, 0.60, 0.55, 0.45, 0.34, 0.62, 1.0, 1.06] },
  { name: 'honey_block', pattern: 'honey', color: [0.700, 0.360, 0.040], color2: [0.450, 0.200, 0.020], color3: [1.000, 0.720, 0.260],
    roughness: 0.16, metallic: 0, height: 0.048, seed: 1987, scale: 1, alpha: true,
    params: [0.22, 0.45, 0.50, 0.40, 0.30, 0.76, 1.0, 1.04] },
  { name: 'nether_portal', pattern: 'water', color: [0.220, 0.030, 0.360], color2: [0.480, 0.100, 0.700], color3: [0.860, 0.560, 1.000],
    roughness: 0.30, metallic: 0, emissive: 0.65, height: 0.012, seed: 1993, scale: 1, alpha: true,
    params: [0.55, 0.85, 0.30, 0.35, 0.60, 0.70, 1.5, 1.60] },
  { name: 'end_portal', pattern: 'solid', color: [0.004, 0.004, 0.012], color2: [0.030, 0.020, 0.090], color3: [0.760, 0.860, 1.000],
    roughness: 0.30, metallic: 0, emissive: 0.80, height: 0.004, seed: 1997, scale: 1,
    params: [0.20, 0.15, 0.05, 0.05, 0.50, 0.90, 2.0, 1.60] },
  { name: 'beacon', pattern: 'glass', color: [0.600, 0.900, 0.950], color2: [0.050, 0.300, 0.350], color3: [1.000, 1.000, 1.000],
    roughness: 0.06, metallic: 0, emissive: 0.75, height: 0.026, seed: 1999, scale: 1, alpha: true,
    params: [0.14, 0.80, 0.70, 0.10, 0.35, 0.55, 1.0, 1.10] },
  // ---------------------------------------------------- crafting & storage ---
  { name: 'crafting_table_top', pattern: 'crafting_table', color: [0.182, 0.116, 0.056], color2: [0.108, 0.066, 0.030], color3: [0.058, 0.036, 0.018],
    roughness: 0.82, metallic: 0, height: 0.026, seed: 2003, scale: 1,
    params: [0.40, 0.75, 0.55, 0.20, 0.26, 0.05, 1.0, 1.08] },
  { name: 'crafting_table_front', pattern: 'crafting_table', color: [0.206, 0.132, 0.064], color2: [0.126, 0.078, 0.036], color3: [0.340, 0.290, 0.180],
    roughness: 0.83, metallic: 0, height: 0.024, seed: 2011, scale: 1,
    params: [0.42, 0.35, 0.45, 0.62, 0.28, 0.06, 1.0, 1.10] },
  { name: 'crafting_table_side', pattern: 'crafting_table', color: [0.196, 0.126, 0.060], color2: [0.120, 0.074, 0.034], color3: [0.290, 0.240, 0.150],
    roughness: 0.83, metallic: 0, height: 0.024, seed: 2017, scale: 1,
    params: [0.42, 0.30, 0.45, 0.45, 0.28, 0.05, 1.0, 1.08] },
  { name: 'furnace_front', pattern: 'furnace_front', color: [0.150, 0.150, 0.153], color2: [0.018, 0.017, 0.016], color3: [0.070, 0.068, 0.066],
    roughness: 0.88, metallic: 0, height: 0.060, seed: 2027, scale: 1,
    params: [0.50, 0.30, 0.80, 0.30, 0.24, 0.55, 1.0, 1.12] },
  { name: 'furnace_side', pattern: 'furnace_side', color: [0.152, 0.152, 0.156], color2: [0.096, 0.096, 0.100], color3: [0.066, 0.064, 0.062],
    roughness: 0.90, metallic: 0, height: 0.040, seed: 2029, scale: 1,
    params: [0.52, 0.40, 0.55, 0.25, 0.26, 0.10, 1.0, 1.08] },
  { name: 'furnace_top', pattern: 'stone', color: [0.148, 0.148, 0.152], color2: [0.094, 0.094, 0.098], color3: [0.210, 0.208, 0.204],
    roughness: 0.89, metallic: 0, height: 0.026, seed: 2039, scale: 1,
    params: [0.50, 0.24, 0.40, 0.24, 0.24, 0.06, 1.0, 1.06] },
  { name: 'chest_front', pattern: 'chest', color: [0.230, 0.145, 0.062], color2: [0.128, 0.078, 0.034], color3: [0.300, 0.250, 0.100],
    roughness: 0.78, metallic: 0, height: 0.034, seed: 2053, scale: 1,
    params: [0.42, 0.55, 0.60, 0.30, 0.28, 0.35, 1.0, 1.10] },
  { name: 'chest_side', pattern: 'chest', color: [0.222, 0.140, 0.060], color2: [0.124, 0.075, 0.032], color3: [0.280, 0.234, 0.094],
    roughness: 0.79, metallic: 0, height: 0.032, seed: 2063, scale: 1,
    params: [0.42, 0.50, 0.58, 0.18, 0.28, 0.22, 1.0, 1.08] },
  { name: 'chest_top', pattern: 'chest', color: [0.238, 0.150, 0.066], color2: [0.134, 0.082, 0.036], color3: [0.290, 0.242, 0.098],
    roughness: 0.78, metallic: 0, height: 0.030, seed: 2069, scale: 1,
    params: [0.40, 0.48, 0.50, 0.16, 0.26, 0.25, 1.0, 1.08] },
  { name: 'barrel_top', pattern: 'chest', color: [0.190, 0.120, 0.056], color2: [0.108, 0.066, 0.030], color3: [0.120, 0.092, 0.050],
    roughness: 0.82, metallic: 0, height: 0.036, seed: 2081, scale: 1,
    params: [0.46, 0.65, 0.65, 0.40, 0.30, 0.12, 1.2, 1.10] },
  { name: 'barrel_side', pattern: 'chest', color: [0.182, 0.115, 0.052], color2: [0.102, 0.062, 0.028], color3: [0.112, 0.086, 0.046],
    roughness: 0.83, metallic: 0, height: 0.040, seed: 2083, scale: 1,
    params: [0.48, 0.80, 0.70, 0.42, 0.30, 0.10, 1.0, 1.12] },
  { name: 'bookshelf', pattern: 'bookshelf', color: [0.230, 0.150, 0.075], color2: [0.024, 0.017, 0.011], color3: [0.350, 0.120, 0.100],
    roughness: 0.86, metallic: 0, height: 0.070, seed: 2087, scale: 1,
    params: [0.44, 0.80, 0.85, 0.28, 0.85, 0.14, 1.0, 1.12] },
  { name: 'tnt_top', pattern: 'tnt', color: [0.480, 0.120, 0.090], color2: [0.280, 0.062, 0.046], color3: [0.720, 0.700, 0.660],
    roughness: 0.86, metallic: 0, height: 0.022, seed: 2089, scale: 1,
    params: [0.38, 0.30, 0.35, 0.20, 0.24, 0.05, 1.0, 1.10] },
  { name: 'tnt_side', pattern: 'tnt', color: [0.470, 0.115, 0.086], color2: [0.270, 0.058, 0.044], color3: [0.740, 0.720, 0.680],
    roughness: 0.87, metallic: 0, height: 0.024, seed: 2099, scale: 1,
    params: [0.40, 0.70, 0.40, 0.22, 0.26, 0.05, 1.0, 1.14] },
  { name: 'tnt_bottom', pattern: 'tnt', color: [0.300, 0.190, 0.110], color2: [0.190, 0.116, 0.062], color3: [0.420, 0.300, 0.190],
    roughness: 0.90, metallic: 0, height: 0.020, seed: 2111, scale: 1,
    params: [0.44, 0.20, 0.30, 0.30, 0.22, 0.04, 1.0, 1.06] },
  { name: 'note_block', pattern: 'noteblock', color: [0.140, 0.086, 0.040], color2: [0.084, 0.050, 0.023], color3: [0.048, 0.030, 0.014],
    roughness: 0.84, metallic: 0, height: 0.024, seed: 2113, scale: 1,
    params: [0.44, 0.55, 0.45, 0.55, 0.28, 0.06, 1.0, 1.10] },
  { name: 'anvil_top', pattern: 'metal', color: [0.076, 0.076, 0.080], color2: [0.040, 0.040, 0.043], color3: [0.190, 0.190, 0.196],
    roughness: 0.45, metallic: 1, height: 0.036, seed: 2129, scale: 1,
    params: [0.30, 0.70, 0.60, 0.45, 0.20, 0.25, 1.5, 1.14] },
  { name: 'enchanting_table_top', pattern: 'cloth', color: [0.460, 0.030, 0.055], color2: [0.018, 0.012, 0.028], color3: [0.700, 0.520, 0.180],
    roughness: 0.72, metallic: 0, emissive: 0.06, height: 0.022, seed: 2131, scale: 1,
    params: [0.44, 0.70, 0.38, 0.18, 0.20, 0.12, 1.0, 1.10] },
  { name: 'enchanting_table_side', pattern: 'obsidian', color: [0.016, 0.011, 0.026], color2: [0.040, 0.022, 0.082], color3: [0.520, 0.110, 0.620],
    roughness: 0.18, metallic: 0, emissive: 0.08, height: 0.028, seed: 2137, scale: 1,
    params: [0.28, 0.45, 0.45, 0.40, 0.50, 0.34, 1.0, 1.22] },
  { name: 'brewing_stand', pattern: 'metal', color: [0.180, 0.180, 0.186], color2: [0.100, 0.100, 0.104], color3: [0.480, 0.400, 0.180],
    roughness: 0.50, metallic: 1, height: 0.030, seed: 2141, scale: 1, alpha: true,
    params: [0.30, 0.55, 0.45, 0.35, 0.20, 0.28, 1.0, 1.12] },
  { name: 'cauldron_top', pattern: 'metal', color: [0.056, 0.056, 0.059], color2: [0.030, 0.030, 0.032], color3: [0.150, 0.150, 0.156],
    roughness: 0.55, metallic: 1, height: 0.038, seed: 2143, scale: 1,
    params: [0.34, 0.60, 0.70, 0.50, 0.20, 0.18, 1.2, 1.16] },
  { name: 'cauldron_side', pattern: 'metal', color: [0.052, 0.052, 0.055], color2: [0.028, 0.028, 0.030], color3: [0.140, 0.140, 0.146],
    roughness: 0.56, metallic: 1, height: 0.036, seed: 2153, scale: 1,
    params: [0.34, 0.55, 0.62, 0.52, 0.20, 0.16, 1.0, 1.14] },
  { name: 'spawner', pattern: 'metal', color: [0.056, 0.062, 0.058], color2: [0.030, 0.040, 0.030], color3: [0.100, 0.140, 0.090],
    roughness: 0.68, metallic: 1, height: 0.050, seed: 2161, scale: 1, alpha: true,
    params: [0.44, 0.60, 0.70, 0.70, 0.30, 0.10, 2.0, 1.20] },
  { name: 'scaffolding', pattern: 'ladder', color: [0.400, 0.330, 0.140], color2: [0.260, 0.208, 0.086], color3: [0.520, 0.450, 0.220],
    roughness: 0.88, metallic: 0, height: 0.030, seed: 2179, scale: 1, alpha: true,
    params: [0.44, 0.35, 0.45, 0.25, 0.26, 0.06, 1.5, 1.08] },
  { name: 'ladder', pattern: 'ladder', color: [0.220, 0.145, 0.070], color2: [0.140, 0.088, 0.040], color3: [0.300, 0.208, 0.108],
    roughness: 0.86, metallic: 0, height: 0.034, seed: 2203, scale: 1, alpha: true,
    params: [0.42, 0.62, 0.40, 0.28, 0.28, 0.05, 1.0, 1.08] },
  { name: 'oak_door_top', pattern: 'planks', color: [0.228, 0.148, 0.074], color2: [0.160, 0.102, 0.050], color3: [0.620, 0.720, 0.760],
    roughness: 0.80, metallic: 0, height: 0.026, seed: 2207, scale: 1, alpha: true,
    params: [0.40, 0.50, 0.55, 0.60, 0.28, 0.10, 0.75, 1.08] },
  { name: 'oak_door_bottom', pattern: 'planks', color: [0.228, 0.148, 0.074], color2: [0.160, 0.102, 0.050], color3: [0.300, 0.250, 0.110],
    roughness: 0.80, metallic: 0, height: 0.026, seed: 2213, scale: 1,
    params: [0.40, 0.50, 0.55, 0.35, 0.28, 0.10, 0.75, 1.08] },
  { name: 'oak_trapdoor', pattern: 'ladder', color: [0.212, 0.138, 0.068], color2: [0.134, 0.084, 0.038], color3: [0.290, 0.200, 0.104],
    roughness: 0.82, metallic: 0, height: 0.030, seed: 2221, scale: 1, alpha: true,
    params: [0.40, 0.45, 0.62, 0.30, 0.26, 0.05, 1.5, 1.08] },
  { name: 'iron_bars', pattern: 'ladder', color: [0.400, 0.400, 0.410], color2: [0.240, 0.240, 0.248], color3: [0.600, 0.600, 0.612],
    roughness: 0.35, metallic: 1, height: 0.024, seed: 2237, scale: 1, alpha: true,
    params: [0.22, 0.00, 0.22, 0.25, 0.14, 0.30, 2.0, 1.06] },
  { name: 'cobweb', pattern: 'cobweb', color: [0.800, 0.820, 0.850], color2: [0.500, 0.520, 0.560], color3: [0.960, 0.980, 1.000],
    roughness: 0.62, metallic: 0, height: 0.008, seed: 2239, scale: 1, alpha: true,
    params: [0.24, 0.90, 0.55, 0.35, 0.20, 0.35, 1.0, 1.04] },
  { name: 'vine', pattern: 'vine', color: [0.056, 0.150, 0.030], color2: [0.026, 0.078, 0.014], color3: [0.120, 0.250, 0.062],
    roughness: 0.90, metallic: 0, height: 0.024, seed: 2243, scale: 1, alpha: true,
    params: [0.52, 0.72, 0.65, 0.55, 0.44, 0.30, 1.0, 1.12] },
  { name: 'sponge', pattern: 'sponge', color: [0.560, 0.520, 0.180], color2: [0.330, 0.300, 0.096], color3: [0.700, 0.660, 0.280],
    roughness: 0.98, metallic: 0, height: 0.160, seed: 2251, scale: 1,
    params: [0.60, 0.80, 0.90, 0.55, 0.30, 0.02, 1.2, 1.14] },
  { name: 'wet_sponge', pattern: 'sponge', color: [0.290, 0.290, 0.116], color2: [0.160, 0.160, 0.060], color3: [0.400, 0.410, 0.190],
    roughness: 0.68, metallic: 0, height: 0.130, seed: 2267, scale: 1,
    params: [0.55, 0.80, 0.80, 0.60, 0.34, 0.04, 1.2, 1.10] },
  { name: 'hay_block_top', pattern: 'hay', color: [0.480, 0.380, 0.090], color2: [0.300, 0.230, 0.048], color3: [0.600, 0.500, 0.160],
    roughness: 0.95, metallic: 0, height: 0.060, seed: 2269, scale: 1,
    params: [0.62, 0.70, 0.55, 0.20, 0.40, 0.06, 1.4, 1.12] },
  { name: 'hay_block_side', pattern: 'hay', color: [0.470, 0.372, 0.086], color2: [0.290, 0.222, 0.046], color3: [0.190, 0.140, 0.040],
    roughness: 0.96, metallic: 0, height: 0.066, seed: 2273, scale: 1,
    params: [0.64, 0.85, 0.62, 0.55, 0.42, 0.05, 1.0, 1.14] },
  // --------------------------------------------------- light & redstone ---
  { name: 'torch', pattern: 'torch', color: [0.180, 0.120, 0.055], color2: [0.400, 0.300, 0.120], color3: [1.000, 0.700, 0.250],
    roughness: 0.80, metallic: 0, emissive: 0.90, height: 0.030, seed: 2281, scale: 1, alpha: true,
    params: [0.30, 0.22, 0.30, 0.45, 0.20, 0.70, 1.0, 1.10] },
  { name: 'soul_torch', pattern: 'torch', color: [0.170, 0.115, 0.052], color2: [0.140, 0.320, 0.400], color3: [0.200, 0.700, 0.950],
    roughness: 0.80, metallic: 0, emissive: 0.80, height: 0.030, seed: 2287, scale: 1, alpha: true,
    params: [0.30, 0.22, 0.30, 0.55, 0.22, 0.65, 1.0, 1.10] },
  { name: 'lantern', pattern: 'lantern', color: [0.230, 0.180, 0.090], color2: [0.120, 0.092, 0.044], color3: [1.000, 0.850, 0.450],
    roughness: 0.40, metallic: 1, emissive: 0.95, height: 0.040, seed: 2293, scale: 1, alpha: true,
    params: [0.26, 0.66, 0.50, 0.55, 0.20, 0.62, 1.0, 1.12] },
  { name: 'redstone_lamp_on', pattern: 'redstone_lamp', color: [0.680, 0.400, 0.150], color2: [0.320, 0.170, 0.060], color3: [1.000, 0.800, 0.480],
    roughness: 0.55, metallic: 0, emissive: 0.85, height: 0.034, seed: 2297, scale: 1,
    params: [0.34, 0.55, 0.50, 0.42, 0.30, 0.55, 1.0, 1.10] },
  { name: 'redstone_lamp_off', pattern: 'redstone_lamp', color: [0.150, 0.096, 0.046], color2: [0.078, 0.048, 0.022], color3: [0.230, 0.160, 0.090],
    roughness: 0.72, metallic: 0, emissive: 0.00, height: 0.034, seed: 2309, scale: 1,
    params: [0.34, 0.55, 0.50, 0.42, 0.26, 0.20, 1.0, 1.08] },
  { name: 'redstone_dust', pattern: 'rail', color: [0.320, 0.020, 0.016], color2: [0.180, 0.010, 0.008], color3: [0.900, 0.100, 0.055],
    roughness: 0.70, metallic: 0, emissive: 0.15, height: 0.006, seed: 2311, scale: 1, alpha: true,
    params: [0.30, 0.00, 0.15, 0.00, 0.35, 0.10, 1.0, 1.20] },
  { name: 'redstone_torch', pattern: 'torch', color: [0.180, 0.120, 0.055], color2: [0.320, 0.040, 0.030], color3: [0.950, 0.100, 0.060],
    roughness: 0.80, metallic: 0, emissive: 0.45, height: 0.030, seed: 2333, scale: 1, alpha: true,
    params: [0.30, 0.22, 0.28, 0.20, 0.24, 0.55, 1.0, 1.14] },
  { name: 'lever', pattern: 'torch', color: [0.140, 0.140, 0.145], color2: [0.190, 0.120, 0.060], color3: [0.300, 0.220, 0.120],
    roughness: 0.86, metallic: 0, height: 0.036, seed: 2339, scale: 1, alpha: true,
    params: [0.42, 0.30, 0.45, 0.00, 0.26, 0.10, 1.0, 1.08] },
  { name: 'rail', pattern: 'rail', color: [0.330, 0.300, 0.270], color2: [0.150, 0.098, 0.048], color3: [0.480, 0.450, 0.410],
    roughness: 0.32, metallic: 1, height: 0.026, seed: 2341, scale: 1, alpha: true,
    params: [0.30, 0.75, 0.55, 0.40, 0.22, 0.40, 1.0, 1.10] },
  { name: 'powered_rail', pattern: 'rail', color: [0.800, 0.620, 0.180], color2: [0.150, 0.098, 0.048], color3: [1.000, 0.300, 0.100],
    roughness: 0.28, metallic: 1, emissive: 0.20, height: 0.026, seed: 2347, scale: 1, alpha: true,
    params: [0.28, 0.75, 0.55, 0.35, 0.26, 0.50, 1.0, 1.12] },
  { name: 'piston_top', pattern: 'planks', color: [0.330, 0.250, 0.130], color2: [0.230, 0.170, 0.086], color3: [0.400, 0.394, 0.382],
    roughness: 0.74, metallic: 0, height: 0.024, seed: 2351, scale: 1,
    params: [0.36, 0.45, 0.55, 0.35, 0.24, 0.16, 0.5, 1.08] },
  { name: 'piston_side', pattern: 'planks', color: [0.300, 0.230, 0.120], color2: [0.206, 0.156, 0.078], color3: [0.180, 0.178, 0.176],
    roughness: 0.78, metallic: 0, height: 0.026, seed: 2357, scale: 1,
    params: [0.38, 0.55, 0.50, 0.42, 0.26, 0.12, 1.25, 1.10] },
  { name: 'piston_front', pattern: 'planks', color: [0.350, 0.266, 0.140], color2: [0.244, 0.184, 0.094], color3: [0.520, 0.500, 0.470],
    roughness: 0.72, metallic: 0, height: 0.030, seed: 2371, scale: 1,
    params: [0.36, 0.40, 0.60, 0.55, 0.24, 0.22, 0.5, 1.10] },
  { name: 'observer_top', pattern: 'stone', color: [0.120, 0.120, 0.126], color2: [0.070, 0.070, 0.075], color3: [0.200, 0.198, 0.200],
    roughness: 0.72, metallic: 0, height: 0.022, seed: 2377, scale: 1,
    params: [0.34, 0.30, 0.42, 0.20, 0.24, 0.10, 1.0, 1.08] },
  { name: 'observer_front', pattern: 'stone', color: [0.110, 0.110, 0.116], color2: [0.028, 0.028, 0.030], color3: [0.650, 0.050, 0.030],
    roughness: 0.70, metallic: 0, emissive: 0.05, height: 0.030, seed: 2381, scale: 1,
    params: [0.32, 0.55, 0.70, 0.25, 0.60, 0.12, 1.0, 1.16] },
  { name: 'observer_back', pattern: 'stone', color: [0.110, 0.110, 0.116], color2: [0.030, 0.030, 0.032], color3: [0.880, 0.120, 0.060],
    roughness: 0.70, metallic: 0, emissive: 0.10, height: 0.030, seed: 2383, scale: 1,
    params: [0.32, 0.45, 0.65, 0.25, 0.62, 0.20, 1.0, 1.18] },
  { name: 'hopper_top', pattern: 'metal', color: [0.100, 0.100, 0.105], color2: [0.052, 0.052, 0.056], color3: [0.220, 0.220, 0.228],
    roughness: 0.50, metallic: 1, height: 0.040, seed: 2389, scale: 1,
    params: [0.30, 0.60, 0.75, 0.45, 0.20, 0.20, 1.0, 1.16] },
  { name: 'hopper_side', pattern: 'metal', color: [0.096, 0.096, 0.100], color2: [0.050, 0.050, 0.054], color3: [0.210, 0.210, 0.218],
    roughness: 0.52, metallic: 1, height: 0.034, seed: 2393, scale: 1,
    params: [0.30, 0.55, 0.60, 0.45, 0.20, 0.18, 1.0, 1.14] },
  { name: 'repeater', pattern: 'stone', color: [0.480, 0.480, 0.476], color2: [0.330, 0.330, 0.328], color3: [0.800, 0.080, 0.050],
    roughness: 0.66, metallic: 0, emissive: 0.10, height: 0.028, seed: 2399, scale: 1,
    params: [0.28, 0.30, 0.50, 0.15, 0.55, 0.14, 1.0, 1.10] },
  // -------------------------------------------------------------- plants ---
  { name: 'short_grass', pattern: 'grass_plant', color: [0.240, 0.380, 0.110], color2: [0.380, 0.520, 0.190], color3: [0.130, 0.230, 0.060],
    roughness: 0.88, metallic: 0, height: 0.010, seed: 2411, scale: 1, alpha: true,
    params: [0.30, 0.85, 0.22, 0.35, 0.55, 0.45, 1.0, 1.06] },
  { name: 'tall_grass_top', pattern: 'grass_plant', color: [0.250, 0.390, 0.115], color2: [0.400, 0.545, 0.200], color3: [0.140, 0.240, 0.065],
    roughness: 0.88, metallic: 0, height: 0.010, seed: 2417, scale: 1, alpha: true,
    params: [0.30, 0.72, 0.20, 0.45, 0.60, 0.55, 1.0, 1.06] },
  { name: 'tall_grass_bottom', pattern: 'grass_plant', color: [0.220, 0.350, 0.100], color2: [0.300, 0.440, 0.150], color3: [0.120, 0.210, 0.055],
    roughness: 0.89, metallic: 0, height: 0.010, seed: 2423, scale: 1, alpha: true,
    params: [0.30, 0.80, 0.24, 0.25, 0.45, 0.35, 1.0, 1.06] },
  { name: 'fern', pattern: 'grass_plant', color: [0.180, 0.320, 0.100], color2: [0.290, 0.450, 0.170], color3: [0.100, 0.190, 0.052],
    roughness: 0.90, metallic: 0, height: 0.010, seed: 2437, scale: 1, alpha: true,
    params: [0.34, 0.95, 0.18, 0.55, 0.50, 0.40, 1.0, 1.08] },
  { name: 'dead_bush', pattern: 'grass_plant', color: [0.180, 0.110, 0.040], color2: [0.260, 0.170, 0.070], color3: [0.100, 0.060, 0.022],
    roughness: 0.96, metallic: 0, height: 0.010, seed: 2441, scale: 1, alpha: true,
    params: [0.42, 0.60, 0.16, 0.65, 0.40, 0.10, 1.0, 1.12] },
  { name: 'dandelion', pattern: 'flower', color: [0.900, 0.780, 0.120], color2: [0.600, 0.450, 0.050], color3: [0.120, 0.260, 0.060],
    roughness: 0.82, metallic: 0, height: 0.008, seed: 2447, scale: 1, alpha: true,
    params: [0.22, 0.75, 0.28, 0.45, 0.30, 0.20, 1.0, 1.06] },
  { name: 'poppy', pattern: 'flower', color: [0.700, 0.030, 0.028], color2: [0.030, 0.018, 0.010], color3: [0.110, 0.240, 0.055],
    roughness: 0.80, metallic: 0, height: 0.008, seed: 2459, scale: 1, alpha: true,
    params: [0.22, 0.50, 0.34, 0.45, 0.28, 0.16, 1.0, 1.10] },
  { name: 'blue_orchid', pattern: 'flower', color: [0.100, 0.500, 0.850], color2: [0.850, 0.850, 0.300], color3: [0.120, 0.280, 0.070],
    roughness: 0.78, metallic: 0, height: 0.008, seed: 2467, scale: 1, alpha: true,
    params: [0.22, 0.62, 0.30, 0.42, 0.32, 0.14, 1.0, 1.08] },
  { name: 'allium', pattern: 'flower', color: [0.520, 0.300, 0.700], color2: [0.700, 0.550, 0.850], color3: [0.110, 0.240, 0.058],
    roughness: 0.82, metallic: 0, height: 0.008, seed: 2473, scale: 1, alpha: true,
    params: [0.24, 0.95, 0.24, 0.48, 0.36, 0.22, 1.0, 1.06] },
  { name: 'cornflower', pattern: 'flower', color: [0.080, 0.180, 0.620], color2: [0.300, 0.350, 0.750], color3: [0.100, 0.220, 0.055],
    roughness: 0.82, metallic: 0, height: 0.008, seed: 2477, scale: 1, alpha: true,
    params: [0.22, 0.70, 0.26, 0.45, 0.34, 0.18, 1.0, 1.08] },
  { name: 'oxeye_daisy', pattern: 'flower', color: [0.900, 0.900, 0.870], color2: [0.900, 0.700, 0.100], color3: [0.110, 0.230, 0.058],
    roughness: 0.84, metallic: 0, height: 0.008, seed: 2503, scale: 1, alpha: true,
    params: [0.20, 0.88, 0.28, 0.45, 0.24, 0.24, 1.0, 1.06] },
  { name: 'sunflower_top', pattern: 'flower', color: [0.950, 0.700, 0.060], color2: [0.180, 0.100, 0.030], color3: [0.130, 0.280, 0.070],
    roughness: 0.84, metallic: 0, height: 0.014, seed: 2521, scale: 1, alpha: true,
    params: [0.26, 1.00, 0.46, 0.20, 0.30, 0.30, 1.0, 1.10] },
  { name: 'brown_mushroom', pattern: 'mushroom', color: [0.180, 0.110, 0.070], color2: [0.260, 0.180, 0.120], color3: [0.480, 0.440, 0.380],
    roughness: 0.88, metallic: 0, height: 0.014, seed: 2531, scale: 1, alpha: true,
    params: [0.34, 0.35, 0.55, 0.30, 0.28, 0.06, 1.0, 1.08] },
  { name: 'red_mushroom', pattern: 'mushroom', color: [0.620, 0.040, 0.030], color2: [0.900, 0.880, 0.850], color3: [0.520, 0.480, 0.420],
    roughness: 0.86, metallic: 0, height: 0.014, seed: 2539, scale: 1, alpha: true,
    params: [0.32, 0.62, 0.60, 0.32, 0.30, 0.05, 1.0, 1.12] },
  { name: 'sugar_cane', pattern: 'grass_plant', color: [0.300, 0.520, 0.180], color2: [0.400, 0.560, 0.230], color3: [0.180, 0.340, 0.090],
    roughness: 0.86, metallic: 0, height: 0.012, seed: 2543, scale: 1, alpha: true,
    params: [0.28, 0.16, 0.42, 0.10, 0.35, 0.45, 1.0, 1.06] },
  { name: 'bamboo', pattern: 'grass_plant', color: [0.320, 0.480, 0.100], color2: [0.180, 0.300, 0.060], color3: [0.420, 0.560, 0.180],
    roughness: 0.84, metallic: 0, height: 0.014, seed: 2549, scale: 1, alpha: true,
    params: [0.26, 0.14, 0.30, 0.08, 0.40, 0.62, 1.0, 1.10] },
  { name: 'cactus_top', pattern: 'cactus', color: [0.062, 0.180, 0.046], color2: [0.034, 0.104, 0.026], color3: [0.480, 0.460, 0.320],
    roughness: 0.84, metallic: 0, height: 0.030, seed: 2551, scale: 1,
    params: [0.36, 0.55, 0.45, 0.45, 0.30, 0.08, 1.0, 1.08] },
  { name: 'cactus_side', pattern: 'cactus', color: [0.058, 0.170, 0.042], color2: [0.030, 0.096, 0.022], color3: [0.500, 0.480, 0.340],
    roughness: 0.85, metallic: 0, height: 0.044, seed: 2557, scale: 1,
    params: [0.36, 0.85, 0.62, 0.62, 0.30, 0.06, 1.0, 1.12] },
  { name: 'wheat_stage0', pattern: 'wheat', color: [0.100, 0.220, 0.060], color2: [0.140, 0.280, 0.080], color3: [0.180, 0.330, 0.100],
    roughness: 0.90, metallic: 0, height: 0.008, seed: 2579, scale: 1, alpha: true,
    params: [0.28, 0.55, 0.05, 0.10, 0.30, 0.05, 1.0, 1.06] },
  { name: 'wheat_stage1', pattern: 'wheat', color: [0.140, 0.260, 0.070], color2: [0.200, 0.330, 0.090], color3: [0.240, 0.380, 0.110],
    roughness: 0.90, metallic: 0, height: 0.010, seed: 2591, scale: 1, alpha: true,
    params: [0.30, 0.70, 0.24, 0.16, 0.32, 0.12, 1.0, 1.06] },
  { name: 'wheat_stage2', pattern: 'wheat', color: [0.300, 0.320, 0.090], color2: [0.480, 0.420, 0.120], color3: [0.560, 0.500, 0.160],
    roughness: 0.91, metallic: 0, height: 0.012, seed: 2593, scale: 1, alpha: true,
    params: [0.32, 0.85, 0.55, 0.24, 0.40, 0.24, 1.0, 1.08] },
  { name: 'wheat_stage3', pattern: 'wheat', color: [0.620, 0.480, 0.120], color2: [0.780, 0.620, 0.180], color3: [0.860, 0.740, 0.300],
    roughness: 0.93, metallic: 0, height: 0.014, seed: 2609, scale: 1, alpha: true,
    params: [0.34, 1.00, 0.85, 0.35, 0.45, 0.40, 1.0, 1.10] },
  { name: 'carrots', pattern: 'wheat', color: [0.090, 0.230, 0.055], color2: [0.750, 0.300, 0.030], color3: [0.160, 0.320, 0.080],
    roughness: 0.89, metallic: 0, height: 0.012, seed: 2617, scale: 1, alpha: true,
    params: [0.32, 0.80, 0.62, 0.30, 0.42, 0.10, 1.0, 1.10] },
  { name: 'potatoes', pattern: 'wheat', color: [0.110, 0.240, 0.065], color2: [0.480, 0.380, 0.150], color3: [0.180, 0.330, 0.090],
    roughness: 0.90, metallic: 0, height: 0.012, seed: 2621, scale: 1, alpha: true,
    params: [0.32, 0.75, 0.58, 0.28, 0.40, 0.08, 1.0, 1.08] },
  { name: 'beetroot', pattern: 'wheat', color: [0.150, 0.220, 0.070], color2: [0.450, 0.040, 0.060], color3: [0.260, 0.320, 0.100],
    roughness: 0.90, metallic: 0, height: 0.012, seed: 2633, scale: 1, alpha: true,
    params: [0.32, 0.72, 0.52, 0.26, 0.48, 0.08, 1.0, 1.12] },
  { name: 'pumpkin_top', pattern: 'pumpkin', color: [0.520, 0.230, 0.030], color2: [0.330, 0.140, 0.018], color3: [0.220, 0.180, 0.060],
    roughness: 0.80, metallic: 0, height: 0.036, seed: 2647, scale: 1,
    params: [0.38, 0.85, 0.45, 0.55, 0.28, 0.00, 1.0, 1.08] },
  { name: 'pumpkin_side', pattern: 'pumpkin', color: [0.560, 0.250, 0.035], color2: [0.360, 0.150, 0.020], color3: [0.240, 0.200, 0.070],
    roughness: 0.80, metallic: 0, height: 0.048, seed: 2657, scale: 1,
    params: [0.36, 1.00, 0.70, 0.10, 0.30, 0.00, 1.0, 1.10] },
  { name: 'pumpkin_front', pattern: 'pumpkin', color: [0.560, 0.250, 0.035], color2: [0.030, 0.014, 0.005], color3: [0.240, 0.200, 0.070],
    roughness: 0.80, metallic: 0, height: 0.050, seed: 2659, scale: 1,
    params: [0.36, 1.00, 0.70, 0.10, 0.30, 1.00, 1.0, 1.12] },
  { name: 'jack_o_lantern', pattern: 'pumpkin', color: [0.560, 0.250, 0.035], color2: [1.000, 0.750, 0.250], color3: [0.240, 0.200, 0.070],
    roughness: 0.78, metallic: 0, emissive: 0.95, height: 0.050, seed: 2663, scale: 1,
    params: [0.36, 1.00, 0.70, 0.10, 0.40, 1.00, 1.0, 1.14] },
  { name: 'melon_top', pattern: 'melon', color: [0.180, 0.320, 0.070], color2: [0.090, 0.200, 0.040], color3: [0.520, 0.150, 0.140],
    roughness: 0.74, metallic: 0, height: 0.026, seed: 2671, scale: 1,
    params: [0.34, 0.55, 0.35, 0.40, 0.34, 0.08, 1.0, 1.10] },
  { name: 'melon_side', pattern: 'melon', color: [0.180, 0.320, 0.070], color2: [0.086, 0.190, 0.038], color3: [0.240, 0.400, 0.110],
    roughness: 0.74, metallic: 0, height: 0.030, seed: 2677, scale: 1,
    params: [0.34, 1.00, 0.45, 0.35, 0.36, 0.10, 1.0, 1.12] },
  { name: 'kelp', pattern: 'kelp', color: [0.070, 0.180, 0.060], color2: [0.036, 0.100, 0.030], color3: [0.140, 0.290, 0.110],
    roughness: 0.62, metallic: 0, height: 0.010, seed: 2683, scale: 1, alpha: true,
    params: [0.30, 0.65, 0.45, 0.55, 0.42, 0.20, 1.0, 1.08] },
  { name: 'seagrass', pattern: 'grass_plant', color: [0.060, 0.220, 0.100], color2: [0.110, 0.320, 0.160], color3: [0.036, 0.140, 0.070],
    roughness: 0.60, metallic: 0, height: 0.008, seed: 2687, scale: 1, alpha: true,
    params: [0.30, 0.75, 0.26, 0.60, 0.50, 0.30, 1.0, 1.06] },
  { name: 'azalea_top', pattern: 'azalea', color: [0.150, 0.330, 0.090], color2: [0.075, 0.190, 0.045], color3: [0.750, 0.400, 0.620],
    roughness: 0.86, metallic: 0, height: 0.050, seed: 2689, scale: 1,
    params: [0.50, 0.80, 0.55, 0.40, 0.44, 0.30, 1.2, 1.10] },
  { name: 'azalea_side', pattern: 'azalea', color: [0.140, 0.310, 0.082], color2: [0.070, 0.175, 0.042], color3: [0.720, 0.380, 0.600],
    roughness: 0.87, metallic: 0, height: 0.046, seed: 2693, scale: 1,
    params: [0.52, 0.70, 0.52, 0.30, 0.44, 0.24, 1.0, 1.10] },
  { name: 'coral_tube', pattern: 'coral', color: [0.070, 0.150, 0.780], color2: [0.030, 0.070, 0.420], color3: [0.320, 0.480, 1.000],
    roughness: 0.55, metallic: 0, emissive: 0.04, height: 0.040, seed: 2699, scale: 1, alpha: true,
    params: [0.36, 0.72, 0.50, 0.45, 0.36, 0.55, 1.0, 1.12] },
  { name: 'coral_brain', pattern: 'coral', color: [0.800, 0.200, 0.450], color2: [0.480, 0.100, 0.260], color3: [1.000, 0.520, 0.700],
    roughness: 0.60, metallic: 0, emissive: 0.04, height: 0.050, seed: 2707, scale: 1, alpha: true,
    params: [0.40, 0.35, 0.85, 0.62, 0.40, 0.45, 1.4, 1.14] },
  { name: 'coral_bubble', pattern: 'coral', color: [0.520, 0.050, 0.600], color2: [0.300, 0.020, 0.340], color3: [0.860, 0.320, 0.940],
    roughness: 0.52, metallic: 0, emissive: 0.05, height: 0.044, seed: 2711, scale: 1, alpha: true,
    params: [0.36, 0.62, 0.70, 0.40, 0.42, 0.60, 1.0, 1.14] },
  { name: 'coral_fire', pattern: 'coral', color: [0.850, 0.120, 0.100], color2: [0.500, 0.055, 0.045], color3: [1.000, 0.420, 0.280],
    roughness: 0.56, metallic: 0, emissive: 0.05, height: 0.042, seed: 2713, scale: 1, alpha: true,
    params: [0.38, 0.80, 0.55, 0.40, 0.38, 0.50, 1.0, 1.14] },
  { name: 'coral_horn', pattern: 'coral', color: [0.900, 0.750, 0.150], color2: [0.560, 0.440, 0.070], color3: [1.000, 0.920, 0.480],
    roughness: 0.58, metallic: 0, emissive: 0.04, height: 0.042, seed: 2719, scale: 1, alpha: true,
    params: [0.38, 0.68, 0.52, 0.42, 0.36, 0.48, 1.0, 1.12] },
  // ------------------------------------------------- terracotta & glazed ---
  { name: 'terracotta', pattern: 'terracotta', color: [0.232, 0.130, 0.096], color2: [0.160, 0.086, 0.062], color3: [0.300, 0.190, 0.146],
    roughness: 0.82, metallic: 0, height: 0.016, seed: 2729, scale: 1,
    params: [0.36, 0.30, 0.25, 0.30, 0.30, 0.10, 1.0, 1.06] },
  { name: 'white_terracotta', pattern: 'terracotta', color: [0.520, 0.442, 0.400], color2: [0.400, 0.330, 0.294], color3: [0.620, 0.550, 0.510],
    roughness: 0.80, metallic: 0, height: 0.016, seed: 2731, scale: 1,
    params: [0.34, 0.62, 0.30, 0.26, 0.36, 0.12, 1.0, 1.08] },
  { name: 'orange_terracotta', pattern: 'terracotta', color: [0.330, 0.140, 0.056], color2: [0.230, 0.092, 0.034], color3: [0.430, 0.210, 0.096],
    roughness: 0.81, metallic: 0, height: 0.016, seed: 2741, scale: 1,
    params: [0.34, 0.70, 0.30, 0.26, 0.38, 0.10, 1.0, 1.10] },
  { name: 'yellow_terracotta', pattern: 'terracotta', color: [0.480, 0.330, 0.080], color2: [0.350, 0.234, 0.052], color3: [0.590, 0.430, 0.140],
    roughness: 0.81, metallic: 0, height: 0.016, seed: 2749, scale: 1,
    params: [0.34, 0.66, 0.30, 0.26, 0.36, 0.10, 1.0, 1.08] },
  { name: 'brown_terracotta', pattern: 'terracotta', color: [0.130, 0.080, 0.050], color2: [0.086, 0.052, 0.032], color3: [0.190, 0.126, 0.084],
    roughness: 0.83, metallic: 0, height: 0.016, seed: 2753, scale: 1,
    params: [0.36, 0.58, 0.30, 0.26, 0.34, 0.08, 1.0, 1.08] },
  { name: 'red_terracotta', pattern: 'terracotta', color: [0.230, 0.070, 0.050], color2: [0.156, 0.044, 0.031], color3: [0.310, 0.116, 0.088],
    roughness: 0.82, metallic: 0, height: 0.016, seed: 2767, scale: 1,
    params: [0.34, 0.62, 0.30, 0.26, 0.36, 0.09, 1.0, 1.10] },
  { name: 'light_gray_terracotta', pattern: 'terracotta', color: [0.230, 0.200, 0.196], color2: [0.160, 0.138, 0.135], color3: [0.310, 0.278, 0.272],
    roughness: 0.82, metallic: 0, height: 0.016, seed: 2777, scale: 1,
    params: [0.34, 0.55, 0.28, 0.26, 0.30, 0.10, 1.0, 1.06] },
  { name: 'cyan_terracotta', pattern: 'terracotta', color: [0.060, 0.114, 0.114], color2: [0.038, 0.074, 0.074], color3: [0.100, 0.176, 0.176],
    roughness: 0.83, metallic: 0, height: 0.016, seed: 2789, scale: 1,
    params: [0.34, 0.55, 0.28, 0.26, 0.32, 0.08, 1.0, 1.08] },
  { name: 'green_terracotta', pattern: 'terracotta', color: [0.076, 0.100, 0.040], color2: [0.048, 0.064, 0.024], color3: [0.126, 0.160, 0.072],
    roughness: 0.83, metallic: 0, height: 0.016, seed: 2791, scale: 1,
    params: [0.34, 0.52, 0.28, 0.26, 0.32, 0.08, 1.0, 1.08] },
  { name: 'white_glazed_terracotta', pattern: 'glazed', color: [0.700, 0.720, 0.700], color2: [0.180, 0.320, 0.520], color3: [0.480, 0.560, 0.640],
    roughness: 0.18, metallic: 0, height: 0.012, seed: 2797, scale: 1,
    params: [0.06, 0.35, 0.20, 0.30, 0.75, 0.55, 1.0, 1.08] },
  { name: 'cyan_glazed_terracotta', pattern: 'glazed', color: [0.080, 0.280, 0.320], color2: [0.700, 0.780, 0.760], color3: [0.180, 0.480, 0.500],
    roughness: 0.20, metallic: 0, height: 0.012, seed: 2801, scale: 1,
    params: [0.06, 0.42, 0.24, 0.34, 0.70, 0.50, 1.0, 1.10] },
  { name: 'magenta_glazed_terracotta', pattern: 'glazed', color: [0.520, 0.120, 0.480], color2: [0.900, 0.750, 0.880], color3: [0.300, 0.060, 0.280],
    roughness: 0.19, metallic: 0, height: 0.012, seed: 2803, scale: 1,
    params: [0.06, 0.62, 0.22, 0.32, 0.72, 0.52, 1.0, 1.10] },
  { name: 'lime_glazed_terracotta', pattern: 'glazed', color: [0.300, 0.560, 0.100], color2: [0.850, 0.900, 0.500], color3: [0.160, 0.340, 0.050],
    roughness: 0.20, metallic: 0, height: 0.012, seed: 2819, scale: 1,
    params: [0.06, 0.88, 0.22, 0.30, 0.70, 0.48, 1.0, 1.08] }
];

/**
 * The 16 vanilla dye colours in LINEAR space, converted from the canonical
 * wool / concrete sRGB hexes. `weave` drives the wool fibre density and the
 * concrete mottle amount, `gloss` is a small per-dye roughness offset (heavier
 * pigment loads sit slightly smoother on the fibre).
 * @type {{name:string, wool:[number,number,number], concrete:[number,number,number],
 *   weave:number, gloss:number}[]}
 */
const DYES = [
  { name: 'white', wool: [0.821, 0.842, 0.842], concrete: [0.629, 0.668, 0.675], weave: 0.62, gloss: 0.00 },
  { name: 'orange', wool: [0.874, 0.184, 0.003], concrete: [0.745, 0.118, 0.002], weave: 0.58, gloss: -0.01 },
  { name: 'magenta', wool: [0.517, 0.055, 0.459], concrete: [0.405, 0.025, 0.354], weave: 0.60, gloss: -0.01 },
  { name: 'light_blue', wool: [0.039, 0.437, 0.701], concrete: [0.013, 0.250, 0.579], weave: 0.56, gloss: -0.02 },
  { name: 'yellow', wool: [0.942, 0.572, 0.016], concrete: [0.882, 0.437, 0.004], weave: 0.64, gloss: 0.00 },
  { name: 'lime', wool: [0.164, 0.493, 0.006], concrete: [0.112, 0.405, 0.006], weave: 0.58, gloss: -0.01 },
  { name: 'pink', wool: [0.851, 0.272, 0.421], concrete: [0.675, 0.129, 0.280], weave: 0.62, gloss: 0.00 },
  { name: 'gray', wool: [0.045, 0.055, 0.060], concrete: [0.034, 0.038, 0.045], weave: 0.54, gloss: -0.02 },
  { name: 'light_gray', wool: [0.276, 0.276, 0.242], concrete: [0.208, 0.208, 0.173], weave: 0.58, gloss: -0.01 },
  { name: 'cyan', wool: [0.004, 0.250, 0.289], concrete: [0.004, 0.187, 0.250], weave: 0.56, gloss: -0.02 },
  { name: 'purple', wool: [0.194, 0.019, 0.421], concrete: [0.127, 0.010, 0.340], weave: 0.60, gloss: -0.02 },
  { name: 'blue', wool: [0.032, 0.037, 0.344], concrete: [0.022, 0.024, 0.280], weave: 0.54, gloss: -0.03 },
  { name: 'brown', wool: [0.170, 0.060, 0.017], concrete: [0.116, 0.041, 0.010], weave: 0.62, gloss: -0.01 },
  { name: 'green', wool: [0.086, 0.154, 0.007], concrete: [0.064, 0.104, 0.013], weave: 0.58, gloss: -0.01 },
  { name: 'red', wool: [0.363, 0.016, 0.012], concrete: [0.276, 0.011, 0.011], weave: 0.60, gloss: -0.01 },
  { name: 'black', wool: [0.004, 0.004, 0.006], concrete: [0.001, 0.002, 0.003], weave: 0.52, gloss: -0.03 }
];

for (let i = 0; i < DYES.length; i++) {
  const d = DYES[i];
  TABLE.push({
    name: `wool_${d.name}`,
    pattern: 'wool',
    color: d.wool,
    color2: tone(d.wool, 0.58),
    color3: tone(d.wool, 1.42),
    roughness: 0.96 + d.gloss,
    metallic: 0,
    height: 0.055,
    seed: 3001 + i * 17,
    scale: 1,
    params: [0.70, d.weave, 0.55, 0.28, 0.18, 0.05, 1.0, 1.04]
  });
}

for (let i = 0; i < DYES.length; i++) {
  const d = DYES[i];
  TABLE.push({
    name: `concrete_${d.name}`,
    pattern: 'concrete',
    color: d.concrete,
    color2: tone(d.concrete, 0.80),
    color3: tone(d.concrete, 1.16),
    roughness: 0.88 + d.gloss,
    metallic: 0,
    height: 0.010,
    seed: 3301 + i * 23,
    scale: 1,
    params: [0.28, 0.45, 0.22, 0.16, d.weave * 0.3, 0.02, 1.0, 1.00]
  });
}

/**
 * Every procedural material. `MATERIALS[i]` is texture-array layer `i`.
 * Append-only: existing indices are baked into meshed chunks and saves.
 * @type {readonly Material[]}
 */
export const MATERIALS = Object.freeze(TABLE.map((m) => Object.freeze(m)));

/** Number of layers in each of the three texture arrays. @type {number} */
export const MATERIAL_COUNT = MATERIALS.length;

/**
 * Material name -> texture-array layer. Also holds the alias names below, so
 * `MATERIAL_INDEX.size` can exceed `MATERIAL_COUNT`.
 * @type {Map<string, number>}
 */
export const MATERIAL_INDEX = new Map();
for (let i = 0; i < MATERIALS.length; i++) MATERIAL_INDEX.set(MATERIALS[i].name, i);

/**
 * Alternative spellings and legitimate texture reuses. Each entry maps an extra
 * name onto an EXISTING layer, so it costs no VRAM. Keeps `blocks.js` from
 * falling back to layer 0 when it asks for a vanilla-style name.
 * @type {[string, string][]}
 */
const ALIASES = [
  ['smooth_stone', 'stone'], ['chiseled_stone_bricks', 'stone_bricks'],
  ['polished_deepslate', 'deepslate_top'], ['deepslate_tiles', 'deepslate_bricks'],
  ['polished_blackstone', 'blackstone'], ['polished_basalt_side', 'basalt_side'],
  ['polished_basalt_top', 'basalt_top'], ['dripstone_block', 'dripstone'],
  ['smooth_sandstone', 'sandstone_top'], ['cut_sandstone', 'sandstone_side'],
  ['sandstone_bottom', 'sandstone_top'], ['red_sandstone_bottom', 'red_sandstone_top'],
  ['smooth_red_sandstone', 'red_sandstone_top'], ['cut_red_sandstone', 'red_sandstone_side'],
  ['grass_block_bottom', 'dirt'], ['dirt_path_side', 'dirt'], ['farmland_dry', 'farmland'],
  ['snow_block', 'snow'], ['snow_layer', 'snow'], ['powder_snow', 'snow'],
  ['blue_ice', 'ice_blue'], ['frosted_ice', 'ice'],
  ['quartz_pillar', 'quartz_block'], ['quartz_pillar_top', 'quartz_block'],
  ['chiseled_quartz_block', 'quartz_block'], ['purpur_pillar', 'purpur'],
  ['prismarine_bricks', 'prismarine'], ['end_portal_frame_top', 'end_stone'],
  ['end_portal_frame_side', 'end_stone'], ['end_stone_bricks', 'end_stone'],
  ['water_flow', 'water_still'], ['lava_flow', 'lava_still'],
  ['glass_pane', 'glass'], ['glass_pane_top', 'glass'],
  ['raw_copper_block', 'copper_block'], ['exposed_copper', 'copper_block'],
  ['weathered_copper', 'oxidized_copper'], ['raw_gold_block', 'gold_block'],
  ['furnace_bottom', 'furnace_top'], ['blast_furnace_front', 'furnace_front'],
  ['blast_furnace_side', 'furnace_side'], ['blast_furnace_top', 'furnace_top'],
  ['smoker_front', 'furnace_front'], ['smoker_side', 'furnace_side'],
  ['dispenser_front', 'furnace_front'], ['dropper_front', 'furnace_front'],
  ['chest_bottom', 'chest_top'], ['barrel_bottom', 'barrel_top'],
  ['jukebox_top', 'note_block'], ['jukebox_side', 'note_block'],
  ['anvil_side', 'anvil_top'], ['enchanting_table_bottom', 'obsidian'],
  ['cauldron_bottom', 'cauldron_side'], ['cauldron_inner', 'cauldron_side'],
  ['comparator', 'repeater'], ['observer_side', 'observer_top'],
  ['piston_bottom', 'piston_top'], ['sticky_piston_front', 'slime_block'],
  ['hopper_inside', 'hopper_top'], ['hopper_bottom', 'hopper_side'],
  ['iron_trapdoor', 'iron_bars'], ['oak_door', 'oak_door_bottom'],
  ['soul_lantern', 'lantern'], ['campfire_log', 'oak_log'], ['campfire_fire', 'torch'],
  ['button', 'stone'], ['pressure_plate', 'stone'],
  ['grass', 'short_grass'], ['tall_grass', 'tall_grass_top'],
  ['large_fern_top', 'fern'], ['large_fern_bottom', 'fern'],
  ['sunflower_bottom', 'tall_grass_bottom'], ['wheat', 'wheat_stage3'],
  ['cactus_bottom', 'cactus_top'], ['melon_stem', 'wheat_stage1'],
  ['carved_pumpkin', 'pumpkin_front'], ['cave_vines', 'vine'],
  ['moss_carpet', 'moss_block'], ['nether_wart_block', 'netherrack'],
  ['ancient_debris', 'ancient_debris_side'], ['nether_gold_ore', 'gold_ore'],
  ['nether_quartz_ore', 'coal_ore'], ['spawner_side', 'spawner']
];
for (const [alias, target] of ALIASES) {
  const layer = MATERIAL_INDEX.get(target);
  if (layer !== undefined && !MATERIAL_INDEX.has(alias)) MATERIAL_INDEX.set(alias, layer);
}
for (const d of DYES) {
  MATERIAL_INDEX.set(`${d.name}_wool`, /** @type {number} */ (MATERIAL_INDEX.get(`wool_${d.name}`)));
  MATERIAL_INDEX.set(`${d.name}_concrete`, /** @type {number} */ (MATERIAL_INDEX.get(`concrete_${d.name}`)));
}

/** @type {Set<string>} material names already reported as missing */
const warnedMaterials = new Set();

/**
 * Texture-array layer index for a material name.
 * Never throws: an unknown name warns once and resolves to layer 0 (`stone`).
 * @param {string} name material or alias name, e.g. `'grass_block_side'`
 * @returns {number} layer index into the albedo/normal/mrae texture arrays
 */
export function materialLayer(name) {
  const layer = MATERIAL_INDEX.get(name);
  if (layer !== undefined) return layer;
  if (!warnedMaterials.has(name)) {
    warnedMaterials.add(name);
    console.warn(`[materials] unknown material "${name}" -> falling back to layer 0`);
  }
  return 0;
}

/**
 * All materials that use a given procedural pattern. Allocates — call it during
 * setup (texture generation, tooling), never per frame.
 * @param {string} pattern pattern id from `PATTERNS`
 * @returns {Material[]} materials using it, in layer order (empty if none)
 */
export function materialsForPattern(pattern) {
  const out = [];
  for (let i = 0; i < MATERIALS.length; i++) {
    if (MATERIALS[i].pattern === pattern) out.push(MATERIALS[i]);
  }
  return out;
}

// One-time integrity check: every material must name a pattern the generator
// implements. Reported once at import time, never during a frame.
{
  const bad = [];
  for (const m of MATERIALS) {
    if (!PATTERN_INDEX.has(m.pattern)) bad.push(`${m.name}:${m.pattern}`);
  }
  if (bad.length) console.warn(`[materials] materials with unknown patterns: ${bad.join(', ')}`);
}
