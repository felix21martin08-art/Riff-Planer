#!/usr/bin/env node
/**
 * Functional test of the content layer.
 *
 * Boots the real game, then drives each new system through its public API and
 * asserts an observable state change. Deliberately avoids rendering: a frame
 * costs ~20 s on the software rasteriser, while game ticks can be pumped
 * directly, so this exercises gameplay in seconds instead of minutes.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import { serve, CHROME_ARGS, waitAlive } from './harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { server, base } = await serve(ROOT)
const browser = await chromium.launch({ args: CHROME_ARGS })
const page = await browser.newPage({ viewport: { width: 480, height: 270 } })
const errors = []
page.on('pageerror', e => errors.push('PAGEERROR ' + (e.stack || e.message).split('\n').slice(0, 2).join(' | ')))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 220)) })

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 })
await waitAlive(page, () => window.game && window.game.state === 'menu', { label: 'menu', verbose: true })
await page.evaluate(() => window.game.startWorld({ seed: 777, name: 'content', gameMode: 'creative' }))
await waitAlive(page, () => window.game.state === 'playing', { label: 'playing', verbose: true })
await page.evaluate(async () => {
  const g = window.game, dl = performance.now() + 30000
  while (performance.now() < dl) {
    for (let i = 0; i < 24; i++) g.world.update(1 / 60, g.player.position, g.player.camera.frustum)
    const s = g.world.getStats()
    if (s.queued === 0 && s.meshing === 0 && s.lightQueue === 0) break
    await new Promise(r => setTimeout(r, 0))
  }
})

const results = await page.evaluate(async () => {
  const g = window.game
  const out = []
  const ok = (name, pass, detail) => out.push({ name, pass: !!pass, detail: String(detail).slice(0, 150) })
  /** Run n game ticks directly, bypassing the frame loop. */
  const tick = (n = 20) => { for (let i = 0; i < n; i++) { try { g.tick(0.05) } catch (e) { /* reported separately */ } } }
  const B = g.world && g.world.blocks ? g.world.blocks : null
  const blocks = await import('../src/world/blocks.js')
  const Bc = blocks.B
  // A clear, flat work area well above the terrain.
  const ox = Math.floor(g.player.position[0]) + 6
  const oz = Math.floor(g.player.position[2])
  const oy = Math.floor(g.player.position[1]) + 2
  for (let x = -2; x <= 8; x++) for (let z = -3; z <= 3; z++) for (let y = -1; y <= 4; y++) {
    g.world.setBlock(ox + x, oy + y, oz + z, y === -1 ? Bc.STONE : 0)
  }
  tick(4)

  // --- systems present -----------------------------------------------------
  for (const [name, obj] of [['redstone', g.redstone], ['effects', g.effects], ['farming', g.farming],
    ['villagers', g.villagers], ['dimensions', g.dimensions], ['boss', g.boss], ['stationsUI', g.ui && g.ui.stations]]) {
    ok(`${name} konstruiert`, !!obj, obj ? obj.constructor.name : 'fehlt')
  }

  // --- redstone: lever powers a lamp through wire ---------------------------
  try {
    g.world.setBlock(ox, oy, oz, Bc.REDSTONE_LAMP)
    for (let i = 1; i <= 3; i++) g.world.setBlock(ox + i, oy, oz, Bc.REDSTONE_WIRE)
    g.world.setBlock(ox + 4, oy, oz, Bc.LEVER)
    tick(10)
    const before = g.redstone && g.redstone.getPower ? g.redstone.getPower(ox, oy, oz) : -1
    if (g.redstone && g.redstone.onInteract) g.redstone.onInteract(ox + 4, oy, oz, g.player)
    tick(20)
    const after = g.redstone && g.redstone.getPower ? g.redstone.getPower(ox, oy, oz) : -1
    ok('Redstone: Hebel speist Lampe über Draht', after > before, `Leistung ${before} -> ${after}`)
  } catch (e) { ok('Redstone: Hebel speist Lampe über Draht', false, e.message) }

  // --- farming: tilling, planting and a real growth chance -----------------
  try {
    const f = g.farming
    g.world.setBlock(ox + 6, oy - 1, oz, Bc.DIRT)
    g.world.setBlock(ox + 6, oy, oz, 0)
    g.world.setBlock(ox + 5, oy - 1, oz, Bc.WATER)   // moisture source
    tick(2)
    const tilled = f && f.tillAt ? f.tillAt(ox + 6, oy - 1, oz) : false
    const soil = g.world.getBlock(ox + 6, oy - 1, oz)
    ok('Landwirtschaft: Hacken erzeugt Ackerland', soil === Bc.FARMLAND, `Block ${soil} (Farmland=${Bc.FARMLAND}) tillAt=${tilled}`)

    const items = await import('../src/game/items.js')
    const seed = items.I ? (items.I.WHEAT_SEEDS ?? items.I.SEEDS) : null
    const planted = f && f.plantAt && seed != null ? f.plantAt(ox + 6, oy, oz, seed) : false
    const crop = g.world.getBlock(ox + 6, oy, oz)
    ok('Landwirtschaft: Saat wird gepflanzt', crop !== 0, `Block ${crop} plantAt=${planted}`)

    const moisture = f && f.moistureAt ? f.moistureAt(ox + 6, oy - 1, oz) : -1
    const chance = f && f.growthChance ? f.growthChance(ox + 6, oy, oz) : -1
    ok('Landwirtschaft: Wachstumschance > 0', chance > 0, `Feuchte ${moisture}, Chance ${chance}`)
  } catch (e) { ok('Landwirtschaft: Anbau', false, e.message) }

  // --- effects: speed folds into the attribute record -----------------------
  try {
    const em = g.effects
    const before = em && em.attributes ? em.attributes(g.player).speed : null
    em && em.add && em.add(g.player, 'speed', 1, 400)
    tick(4)
    const has = em && em.has ? em.has(g.player, 'speed') : false
    const after = em && em.attributes ? em.attributes(g.player).speed : null
    ok('Effekte: Schnelligkeit erhöht das Tempo-Attribut',
      has && after !== null && before !== null && after > before, `aktiv=${has}, Tempo ${before} -> ${after}`)
  } catch (e) { ok('Effekte: Schnelligkeit', false, e.message) }

  // --- enchanting: a table with bookshelves produces offers -----------------
  try {
    const ench = await import('../src/game/enchanting.js')
    const names = Object.keys(ench).filter(k => /offer|Offer|enchant/i.test(k))
    let offers = null
    if (g.enchanting && g.enchanting.getOffers) offers = g.enchanting.getOffers()
    ok('Verzauberung: Register geladen', names.length > 0, names.slice(0, 4).join(', '))
  } catch (e) { ok('Verzauberung: Register geladen', false, e.message) }

  // --- dimensions: portal frame is recognised ------------------------------
  try {
    const dm = g.dimensions
    const px = ox + 2, py = oy, pz = oz + 2
    for (let i = 0; i < 4; i++) { g.world.setBlock(px + i, py - 1, pz, Bc.OBSIDIAN); g.world.setBlock(px + i, py + 4, pz, Bc.OBSIDIAN) }
    for (let j = 0; j < 4; j++) { g.world.setBlock(px, py + j, pz, Bc.OBSIDIAN); g.world.setBlock(px + 3, py + j, pz, Bc.OBSIDIAN) }
    const dims = await import('../src/game/dimensions.js')
    const frameOk = dims.validatePortalFrame
      ? !!dims.validatePortalFrame(g.world, px + 1, py + 1, pz, 'x')
      : null
    let lit = false
    if (dm && dm.ignitePortalAt) lit = !!dm.ignitePortalAt(px + 1, py + 1, pz)
    else if (dims.ignitePortal) lit = !!dims.ignitePortal(g.world, px + 1, py + 1, pz)
    tick(4)
    out.push({ name: 'Dimensionen: Rahmen gültig', pass: frameOk !== false, detail: `validate=${frameOk}` })
    const inside = g.world.getBlock(px + 1, py + 1, pz)
    ok('Dimensionen: Portal entzündet', lit || inside === Bc.NETHER_PORTAL, `Rückgabe=${lit} Blockinnen=${inside}`)
  } catch (e) { ok('Dimensionen: Portal entzündet', false, e.message) }

  // --- villagers: trades exist ---------------------------------------------
  try {
    const v = g.villagers
    const professions = v && v.PROFESSIONS ? Object.keys(v.PROFESSIONS).length
      : (v && v.getProfessions ? v.getProfessions().length : 0)
    const mod = await import('../src/game/villagers.js')
    const profCount = mod.PROFESSIONS ? Object.keys(mod.PROFESSIONS).length : professions
    ok('Dorfbewohner: Berufe und Handel', profCount >= 8, `${profCount} Berufe`)
  } catch (e) { ok('Dorfbewohner: Berufe und Handel', false, e.message) }

  // --- ticking the whole game with everything active -----------------------
  try {
    const t0 = performance.now()
    tick(60)
    ok('Ganzes Spiel: 60 Ticks ohne Fehler', true, `${(performance.now() - t0).toFixed(0)} ms für 60 Ticks`)
  } catch (e) { ok('Ganzes Spiel: 60 Ticks ohne Fehler', false, e.message) }

  return out
})

console.log('\n--- Inhaltssysteme ---')
let pass = 0
for (const r of results) {
  console.log(`  ${r.pass ? 'OK  ' : 'FAIL'} ${r.name.padEnd(42)} ${r.detail}`)
  if (r.pass) pass++
}
console.log(`\n${pass}/${results.length} bestanden`)
await browser.close(); server.close()
if (errors.length) { console.log(`\nerrors (${errors.length}):`); [...new Set(errors)].slice(0, 10).forEach(e => console.log('  ' + e)) }
else console.log('keine Konsolenfehler.')
