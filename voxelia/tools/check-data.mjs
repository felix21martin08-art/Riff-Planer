#!/usr/bin/env node
/**
 * Cross-module data consistency checker for VOXELIA.
 *
 * Dynamically imports the pure-data modules (which are required to be
 * worker-safe, i.e. free of DOM access at module scope) and verifies that the
 * registries agree with each other: block faces point at real materials,
 * materials use real patterns, B/I constants match names, biomes reference
 * real blocks, recipes/items reference real ids.
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []
/** Accepts plain arrays and typed arrays alike. */
const isVec = (v, n = 3) => !!v && typeof v.length === 'number' && v.length >= n && typeof v[0] === 'number'
const ok = m => notes.push(m)

async function load(rel) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) return null
  try { return await import(pathToFileURL(p).href) }
  catch (e) { problems.push(`IMPORT ${rel}: ${e.message.split('\n')[0]}`); return null }
}

const materials = await load('src/world/materials.js')
const blocks = await load('src/world/blocks.js')
const biomes = await load('src/world/biomes.js')
const items = await load('src/game/items.js')
const crafting = await load('src/game/crafting.js')

if (materials) {
  const { MATERIALS, MATERIAL_INDEX, PATTERNS } = materials
  ok(`materials: ${MATERIALS?.length ?? 0} entries, ${PATTERNS?.length ?? 0} patterns`)
  const pat = new Set(PATTERNS || [])
  const seen = new Set()
  for (const [i, m] of (MATERIALS || []).entries()) {
    if (!m.name) problems.push(`materials[${i}] has no name`)
    if (seen.has(m.name)) problems.push(`materials: duplicate name '${m.name}'`)
    seen.add(m.name)
    if (!pat.has(m.pattern)) problems.push(`materials '${m.name}': unknown pattern '${m.pattern}'`)
    if (!isVec(m.color)) problems.push(`materials '${m.name}': bad color`)
    else if ([...m.color].some(c => typeof c !== 'number' || c < 0 || c > 1.001)) problems.push(`materials '${m.name}': color not in 0..1 linear`)
    if (typeof m.roughness !== 'number') problems.push(`materials '${m.name}': missing roughness`)
    if (MATERIAL_INDEX && MATERIAL_INDEX.get(m.name) !== i) problems.push(`materials '${m.name}': MATERIAL_INDEX mismatch (${MATERIAL_INDEX?.get(m.name)} != ${i})`)
  }
}

if (blocks) {
  const { BLOCKS, B, getBlock } = blocks
  ok(`blocks: ${BLOCKS?.length ?? 0} entries`)
  const names = new Set()
  for (const [i, b] of (BLOCKS || []).entries()) {
    if (!b) { problems.push(`blocks[${i}] is empty (ids must be dense)`); continue }
    if (b.id !== i) problems.push(`blocks '${b.name}': id ${b.id} != index ${i}`)
    if (names.has(b.name)) problems.push(`blocks: duplicate name '${b.name}'`)
    names.add(b.name)
    const key = String(b.name).toUpperCase()
    if (B && B[key] === undefined) problems.push(`blocks: B.${key} missing for '${b.name}'`)
    else if (B && B[key] !== b.id) problems.push(`blocks: B.${key} = ${B[key]} but id = ${b.id}`)
    if (materials?.MATERIAL_INDEX && b.textures) {
      for (const [face, mat] of Object.entries(b.textures)) {
        if (typeof mat === 'string' && !materials.MATERIAL_INDEX.has(mat)) {
          problems.push(`blocks '${b.name}'.${face}: material '${mat}' does not exist`)
        }
      }
    }
    if (typeof b.hardness !== 'number') problems.push(`blocks '${b.name}': missing hardness`)
    if (!isVec(b.emission)) problems.push(`blocks '${b.name}': emission must be [r,g,b]`)
    else if ([...b.emission].some(v => v < 0 || v > 15)) problems.push(`blocks '${b.name}': emission out of 0..15`)
  }
  if (getBlock) {
    const air = getBlock(0)
    if (!air || air.name !== 'air') problems.push(`blocks: id 0 must be 'air' (got '${air?.name}')`)
    if (getBlock(999999)?.id !== 0) problems.push('blocks: getBlock(unknown) must return AIR')
  }
}

if (biomes) {
  const { BIOMES, selectBiome, getBiome } = biomes
  ok(`biomes: ${BIOMES?.length ?? 0} entries`)
  const bn = blocks ? new Set(blocks.BLOCKS.map(b => b?.name)) : null
  for (const [i, b] of (BIOMES || []).entries()) {
    if (b.id !== i) problems.push(`biomes '${b.name}': id ${b.id} != index ${i}`)
    for (const k of ['surfaceBlock', 'subSurfaceBlock', 'underwaterBlock']) {
      const v = b[k]
      if (typeof v === 'string' && bn && !bn.has(v)) problems.push(`biomes '${b.name}'.${k}: unknown block '${v}'`)
    }
    for (const k of ['grassColor', 'foliageColor', 'waterColor', 'fogColor']) {
      if (!isVec(b[k])) problems.push(`biomes '${b.name}'.${k}: expected [r,g,b]`)
    }
  }
  if (selectBiome) {
    let undef = 0
    for (let i = 0; i < 2000; i++) {
      const r = () => Math.sin(i * 12.9898 + Math.random()) // deterministic-ish spread
      const v = selectBiome(r(), r(), r(), r(), r(), r())
      if (v === undefined || v === null || !getBiome || !getBiome(v)) undef++
    }
    if (undef) problems.push(`biomes: selectBiome returned an invalid biome ${undef}/2000 times`)
  }
}

if (items) {
  const { ITEMS, I } = items
  ok(`items: ${ITEMS?.length ?? 0} entries`)
  const bn = blocks ? new Set(blocks.BLOCKS.map(b => b?.name)) : null
  for (const [i, it] of (ITEMS || []).entries()) {
    if (!it) { problems.push(`items[${i}] is empty (ids must be dense)`); continue }
    if (it.id !== i) problems.push(`items '${it.name}': id ${it.id} != index ${i}`)
    if (I && I[String(it.name).toUpperCase()] === undefined) problems.push(`items: I.${String(it.name).toUpperCase()} missing`)
    if (it.blockId !== undefined && blocks && !blocks.BLOCKS[it.blockId]) problems.push(`items '${it.name}': blockId ${it.blockId} does not exist`)
  }
}

if (crafting && items) {
  const { RECIPES, SMELTING, FUELS } = crafting
  ok(`crafting: ${RECIPES?.length ?? 0} recipes, ${SMELTING?.size ?? 0} smelting, ${FUELS?.size ?? 0} fuels`)
  const valid = id => items.ITEMS[id] !== undefined
  for (const r of RECIPES || []) {
    const res = r.result?.item ?? r.result
    if (typeof res === 'number' && !valid(res)) problems.push(`recipe '${r.id}': result item ${res} does not exist`)
    for (const ing of [...(r.ingredients || []), ...Object.values(r.key || {})].flat()) {
      const id = typeof ing === 'object' ? (ing?.item ?? ing?.id) : ing
      if (typeof id === 'number' && !valid(id)) problems.push(`recipe '${r.id}': ingredient ${id} does not exist`)
    }
  }
}

console.log(notes.join('\n'))
if (problems.length) {
  const grouped = {}
  for (const p of problems) { const k = p.split(':')[0].split(' ')[0]; (grouped[k] ||= []).push(p) }
  console.log(`\nPROBLEMS (${problems.length}):`)
  for (const [k, list] of Object.entries(grouped)) {
    console.log(`\n  -- ${k} (${list.length})`)
    list.slice(0, 25).forEach(p => console.log('    ' + p))
    if (list.length > 25) console.log(`    … ${list.length - 25} more`)
  }
  process.exit(1)
}
console.log('\nAll registries consistent.')
