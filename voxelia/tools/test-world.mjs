#!/usr/bin/env node
/**
 * Headless functional test of the world pipeline: generator -> chunk storage ->
 * lighting -> greedy mesher. Runs entirely in node (no GPU, no DOM) and prints
 * a terrain cross-section so the result can be eyeballed, plus hard assertions
 * on the binary mesh layout.
 *
 * usage: node tools/test-world.mjs [seed] [chunks]
 */
import { WorldGenerator } from '../src/world/worldgen.js'
import { Chunk, packLight, unpackLight } from '../src/world/chunk.js'
import { LightEngine } from '../src/world/lighting.js'
import { meshSection, VERTEX_STRIDE } from '../src/world/mesher.js'
import { BLOCKS, getBlock, B } from '../src/world/blocks.js'
import { BIOMES } from '../src/world/biomes.js'
import { MATERIALS } from '../src/world/materials.js'

const SEED = Number(process.argv[2] ?? 1337)
const N = Number(process.argv[3] ?? 5)
const fails = []
const check = (cond, msg) => { if (!cond) fails.push(msg) }

const gen = new WorldGenerator(SEED)
const chunks = new Map()
const t0 = performance.now()

const R = Math.floor(N / 2)
for (let cx = -R; cx <= R; cx++) {
  for (let cz = -R; cz <= R; cz++) {
    const data = gen.generateChunk(cx, cz)
    const ch = new Chunk(cx, cz)
    for (let sy = 0; sy < data.sections.length; sy++) {
      const blocks = data.sections[sy]
      if (!blocks) continue
      const sec = ch.getSection(sy, true)
      for (let i = 0; i < 4096; i++) {
        const id = blocks[i]
        if (id) sec.set(i & 15, (i >> 8) & 15, (i >> 4) & 15, id)
      }
    }
    ch.heightmap.set(data.heightmap)
    ch.biomes.set(data.biomes)
    ch.generated = true
    chunks.set(`${cx},${cz}`, ch)
  }
}
const genMs = performance.now() - t0

// Apply structure spill-over so trees are not cut in half.
const pending = gen.takePendingEdits?.() ?? new Map()
let applied = 0, dropped = 0
for (const [key, edits] of pending) {
  const ch = chunks.get(key)
  for (const e of edits) {
    const [x, y, z, id] = Array.isArray(e) ? e : [e.x, e.y, e.z, e.id ?? e.blockId]
    if (!ch) { dropped++; continue }
    ch.setBlock(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16, id)
    applied++
  }
}

// ---------------------------------------------------------------- statistics
const hist = new Map()
let solid = 0, air = 0, minY = 1e9, maxY = -1e9
const biomeSet = new Set()
for (const ch of chunks.values()) {
  for (let i = 0; i < 256; i++) { biomeSet.add(ch.biomes[i]); minY = Math.min(minY, ch.heightmap[i]); maxY = Math.max(maxY, ch.heightmap[i]) }
  for (let sy = 0; sy < 24; sy++) {
    const sec = ch.sections[sy]
    if (!sec || !sec.blocks) { air += 4096; continue }
    for (let i = 0; i < 4096; i++) {
      const id = sec.blocks[i]
      if (!id) { air++; continue }
      solid++
      hist.set(id, (hist.get(id) || 0) + 1)
    }
  }
}
const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)
  .map(([id, n]) => `${getBlock(id).name}:${n}`)

check(solid > 0, 'generator produced no solid blocks at all')
check(biomeSet.size >= 2, `only ${biomeSet.size} biome(s) across ${N}x${N} chunks`)
check(maxY - minY > 4, `terrain is flat (height range ${minY}..${maxY})`)
check(maxY < 320 && minY >= -64, `heightmap out of world bounds (${minY}..${maxY})`)
const airFrac = air / (air + solid)
check(airFrac > 0.3 && airFrac < 0.98, `suspicious air fraction ${(airFrac * 100).toFixed(1)}%`)
for (const ore of ['coal_ore', 'iron_ore', 'diamond_ore']) {
  const id = B[ore.toUpperCase()]
  check(hist.get(id) > 0, `no ${ore} generated in ${N * N} chunks`)
}
check((hist.get(B.WATER) || 0) > 0, 'no water generated')

// ---------------------------------------------------------------- lighting
const world = {
  chunks,
  getChunk: (cx, cz) => chunks.get(`${cx},${cz}`) || null,
  getBlock(x, y, z) {
    const ch = chunks.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
    return ch ? ch.getBlock(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16) : 0
  },
  isLoaded: (cx, cz) => chunks.has(`${cx},${cz}`),
  markDirty() {},
}
const tl = performance.now()
let lightMs = 0, lightNodes = 0
try {
  const le = new LightEngine(world)
  for (const ch of chunks.values()) le.initChunkSkylight(ch)
  for (const ch of chunks.values()) le.queueChunkBorders?.(ch)
  let guard = 0
  while (le.pending > 0 && guard++ < 400) lightNodes += le.process(50)
  lightMs = performance.now() - tl
  check(le.pending === 0, `lighting did not converge, ${le.pending} nodes left`)
} catch (e) { fails.push('LIGHTING THREW: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')) }

// Sky light sanity: the block directly above the surface must be lit.
let litSamples = 0, litOk = 0
const c0 = chunks.get('0,0')
for (let x = 0; x < 16; x += 3) for (let z = 0; z < 16; z += 3) {
  const h = c0.heightmap[z * 16 + x]
  if (h < -60 || h > 310) continue
  const [, , , sky] = unpackLight(c0.getLightPacked(x, h + 1, z))
  litSamples++
  if (sky >= 14) litOk++
}
check(litSamples === 0 || litOk / litSamples > 0.6, `sky light wrong above surface (${litOk}/${litSamples} lit)`)

// ---------------------------------------------------------------- meshing
const padBlocks = new Uint16Array(18 * 18 * 18)
const padLight = new Uint16Array(18 * 18 * 18)
const padBiome = new Uint8Array(18 * 18)
function buildPadded(cx, cz, sy) {
  padBlocks.fill(0); padLight.fill(0)
  const baseY = -64 + sy * 16
  for (let y = -1; y <= 16; y++) for (let z = -1; z <= 16; z++) for (let x = -1; x <= 16; x++) {
    const wx = cx * 16 + x, wy = baseY + y, wz = cz * 16 + z
    const ch = chunks.get(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`)
    const i = ((y + 1) * 18 + (z + 1)) * 18 + (x + 1)
    if (!ch) continue
    const lx = ((wx % 16) + 16) % 16, lz = ((wz % 16) + 16) % 16
    padBlocks[i] = ch.getBlock(lx, wy, lz)
    padLight[i] = ch.getLightPacked(lx, wy, lz)
  }
  for (let z = -1; z <= 16; z++) for (let x = -1; x <= 16; x++) {
    const wx = cx * 16 + x, wz = cz * 16 + z
    const ch = chunks.get(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`)
    padBiome[(z + 1) * 18 + (x + 1)] = ch ? ch.biomes[(((wz % 16) + 16) % 16) * 16 + (((wx % 16) + 16) % 16)] : 0
  }
}

let totalVerts = 0, totalTris = 0, meshedSections = 0, meshMs = 0
let badLayer = 0, badPos = 0
const tm = performance.now()
for (let sy = 0; sy < 24; sy++) {
  buildPadded(0, 0, sy)
  let has = false
  for (let i = 0; i < padBlocks.length; i++) if (padBlocks[i]) { has = true; break }
  if (!has) continue
  let r
  try {
    r = meshSection({ blocks: padBlocks, light: padLight, biomes: padBiome, sy, smoothLighting: true, fancyLeaves: true })
  } catch (e) { fails.push(`mesher threw on section ${sy}: ${(e.stack || e.message).split('\n')[0]}`); continue }
  meshedSections++
  for (const key of ['opaque', 'cutout', 'water']) {
    const b = r[key]
    if (!b || !b.vertices || b.vertices.byteLength === 0) continue
    check(b.vertices.byteLength % VERTEX_STRIDE === 0, `${key} section ${sy}: vertex buffer not a multiple of ${VERTEX_STRIDE}`)
    const nv = b.vertices.byteLength / VERTEX_STRIDE
    const idx = new Uint32Array(b.indices)
    totalVerts += nv
    totalTris += idx.length / 3
    check(idx.length % 3 === 0, `${key} section ${sy}: index count not a multiple of 3`)
    let maxIdx = 0
    for (let i = 0; i < idx.length; i++) if (idx[i] > maxIdx) maxIdx = idx[i]
    check(maxIdx < nv, `${key} section ${sy}: index ${maxIdx} out of range (${nv} vertices)`)
    const dv = new DataView(b.vertices)
    for (let v = 0; v < nv; v++) {
      const o = v * VERTEX_STRIDE
      const px = dv.getFloat32(o, true), py = dv.getFloat32(o + 4, true), pz = dv.getFloat32(o + 8, true)
      if (!(px >= -1.01 && px <= 17.01 && py >= -1.01 && py <= 17.01 && pz >= -1.01 && pz <= 17.01)) badPos++
      const layer = dv.getUint16(o + 20, true)
      if (layer >= MATERIALS.length) badLayer++
      const face = dv.getUint8(o + 22)
      check(face <= 5, `${key} section ${sy} vertex ${v}: face dir ${face} > 5`)
    }
  }
}
meshMs = performance.now() - tm
check(badLayer === 0, `${badLayer} vertices reference a texture layer >= ${MATERIALS.length}`)
check(badPos === 0, `${badPos} vertices have out-of-range positions`)
check(totalTris > 100, `mesher produced almost nothing (${totalTris} triangles)`)

// ---------------------------------------------------------------- visual
const GLYPH = id => {
  if (!id) return ' '
  const n = getBlock(id).name
  if (n === 'water') return '~'
  if (n === 'lava') return '!'
  if (n.includes('leaves')) return '%'
  if (n.includes('log')) return '|'
  if (n === 'grass_block') return '#'
  if (n === 'sand' || n === 'red_sand') return '.'
  if (n === 'snow_block' || n === 'snow' || n.includes('snow')) return '*'
  if (n.includes('ore')) return '$'
  if (n === 'dirt' || n.includes('dirt') || n === 'podzol' || n === 'mycelium') return ':'
  if (n === 'bedrock') return '@'
  if (n.includes('deepslate')) return '='
  if (n === 'stone' || n.includes('stone') || n === 'gravel' || n === 'granite' || n === 'diorite' || n === 'andesite') return '-'
  return '+'
}
const lines = []
const TOP = 150, BOT = -64
for (let y = TOP; y >= BOT; y -= 2) {
  let row = ''
  for (let wx = -R * 16; wx < (R + 1) * 16; wx++) row += GLYPH(world.getBlock(wx, y, 0))
  if (row.trim() || (y % 20 === 0)) lines.push(String(y).padStart(4) + ' |' + row)
}

console.log(`seed=${SEED}  ${N}x${N} chunks`)
console.log(`generation : ${genMs.toFixed(0)} ms  (${(genMs / (N * N)).toFixed(1)} ms/chunk)`)
console.log(`lighting   : ${lightMs.toFixed(0)} ms  (${lightNodes} nodes)`)
console.log(`meshing    : ${meshMs.toFixed(0)} ms  (${meshedSections} sections, ${totalVerts} verts, ${totalTris | 0} tris)`)
console.log(`structures : ${applied} spill-over edits applied, ${dropped} outside the test area`)
console.log(`height     : ${minY} .. ${maxY}   air ${(airFrac * 100).toFixed(1)}%`)
console.log(`biomes     : ${[...biomeSet].map(b => BIOMES[b]?.name ?? '?' + b).join(', ')}`)
console.log(`top blocks : ${top.join('  ')}`)
console.log('\ncross-section at z=0 (# grass  : dirt  - stone  = deepslate  ~ water  | log  % leaves  $ ore  . sand  * snow  @ bedrock)')
console.log(lines.join('\n'))

if (fails.length) { console.log(`\nFAILURES (${fails.length}):`); fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
console.log('\nAll world-pipeline checks passed.')
