#!/usr/bin/env node
/**
 * VOXELIA end-to-end play test.
 *
 * Boots the real game, creates a world through the public Game API, waits for
 * the player to spawn into a streamed world, then drives real input (walking,
 * looking, breaking and placing a block, opening the inventory) and screenshots
 * each step. This is the test that proves the game is playable, not just that
 * it renders.
 *
 * usage: node tools/playtest.mjs --out DIR [--seed 1337] [--w 1280] [--h 720]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import { waitAlive } from './harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const OUT = arg('out', '/tmp/play')
const SEED = Number(arg('seed', 1337))
const W = Number(arg('w', 1280)), H = Number(arg('h', 720))

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const server = http.createServer((q, r) => {
  const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]) === '/' ? '/index.html' : decodeURIComponent(q.url.split('?')[0]))
  fs.readFile(f, (e, d) => e ? r.writeHead(404).end('404') : r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(d))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: W, height: H } })
const errors = []
page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })

const steps = []
/** Distinct colours in the middle of the WebGL canvas; 1 means nothing rendered. */
const variety = () => page.evaluate(() => {
  const c = document.querySelector('canvas'); const gl = c && c.getContext('webgl2')
  if (!gl) return -1
  const b = new Uint8Array(24 * 14 * 4); const s = new Set()
  try { gl.readPixels((c.width - 24) >> 1, (c.height - 14) >> 1, 24, 14, gl.RGBA, gl.UNSIGNED_BYTE, b) } catch { return -1 }
  for (let i = 0; i < b.length; i += 4) s.add((b[i] << 16) | (b[i + 1] << 8) | b[i + 2])
  return s.size
})
const shot = async (name, note) => {
  // A frame takes ~20 s on the software rasteriser, so force composites until
  // the canvas actually holds an image. Reporting a blank frame as success is
  // how several phantom "bugs" entered this project's history.
  let distinct = 0
  for (let r = 0; r < 5; r++) {
    for (let i = 0; i < 4; i++) { await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => {}); await page.waitForTimeout(700) }
    distinct = await variety()
    if (distinct > 1) break
  }
  const f = path.join(OUT, name + '.png')
  try {
    await page.screenshot({ path: f, timeout: 300000 })
    steps.push({ name, note, kb: (fs.statSync(f).size / 1024) | 0, distinct })
  } catch (e) { steps.push({ name, note, error: e.message.split('\n')[0] }) }
}
const state = () => page.evaluate(() => window.game && window.game.state)
const snap = () => page.evaluate(() => {
  const g = window.game
  if (!g) return null
  const p = g.player
  const st = (() => { try { return g.world && g.world.getStats() } catch { return null } })()
  return {
    state: g.state,
    pos: p ? [...p.position].map(v => +v.toFixed(1)) : null,
    onGround: p ? !!p.onGround : null,
    health: p ? p.health : null, hunger: p ? p.hunger : null,
    gameMode: p ? p.gameMode : null,
    chunks: st,
    entities: (() => { try { return g.entities && g.entities.entities ? g.entities.entities.size : null } catch { return null } })(),
    fps: g.stats && g.stats.fps,
    tris: g.renderer && g.renderer.stats ? g.renderer.stats.triangles : null,
    drawCalls: g.renderer && g.renderer.stats ? g.renderer.stats.drawCalls : null,
  }
})

console.log('booting the real game …')
await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 })
await waitAlive(page, () => window.game && window.game.state === 'menu', { label: 'menu', verbose: true })
console.log('menu reached')
await shot('01-menu', 'Hauptmenü mit lebender Weltkulisse')

console.log('creating a world …')
await page.evaluate(seed => window.game.startWorld({ seed, name: 'Testwelt', gameMode: 'survival' }), SEED)
await waitAlive(page, () => window.game.state === 'playing', { label: 'playing', verbose: true })
console.log('playing:', JSON.stringify(await snap()))

// The world streams under a per-update time budget; on a software rasteriser a
// frame is slow, so pump the streaming directly until the spawn area is built.
console.log('streaming the spawn area …')
await page.evaluate(async () => {
  const g = window.game
  const deadline = performance.now() + 60000
  while (performance.now() < deadline) {
    for (let i = 0; i < 24; i++) g.world.update(1 / 60, g.player.position, g.player.camera.frustum)
    const s = g.world.getStats()
    if (s.queued === 0 && s.meshing === 0 && s.generating === 0 && s.lightQueue === 0) break
    await new Promise(r => setTimeout(r, 0))
  }
})
console.log('streamed:', JSON.stringify(await snap()))
await shot('02-spawn', 'Spielstart: Spieler, HUD und Welt')

/** Hold a key for a number of milliseconds of game time. */
async function hold(key, ms) {
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
}

console.log('walking …')
await page.evaluate(() => document.querySelector('canvas').focus())
await hold('KeyW', 2500)
console.log('after walking:', JSON.stringify(await snap()))
await shot('03-walk', 'Nach dem Laufen')

console.log('looking around …')
await page.mouse.move(W / 2, H / 2)
await page.mouse.move(W / 2 + 260, H / 2 + 40, { steps: 12 })
await shot('04-look', 'Nach dem Umsehen')

console.log('breaking a block …')
await page.evaluate(() => { window.game.player.pitch = -1.1 })
await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => {})
await page.waitForTimeout(1200)
const before = await page.evaluate(() => {
  const g = window.game
  const hit = g.interaction && g.interaction.hit
  return hit ? { x: hit.x, y: hit.y, z: hit.z, id: g.world.getBlock(hit.x, hit.y, hit.z) } : null
})
await page.mouse.down({ button: 'left' })
// Break progress accrues per game tick, and the loop only runs ticks when a
// frame runs — so force frames while the button is held instead of waiting on
// the wall clock, which would deliver almost no ticks at 20 s per frame.
for (let i = 0; i < 10; i++) {
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => {})
  await page.waitForTimeout(500)
  const p2 = await page.evaluate(() => window.game.interaction ? +(window.game.interaction.breakProgress || 0).toFixed(2) : -1)
  if (p2 === 0 && i > 2) break // the block already broke and the target reset
}
await page.mouse.up({ button: 'left' })
const after = before ? await page.evaluate(t => window.game.world.getBlock(t.x, t.y, t.z), before) : null
console.log('block target:', JSON.stringify(before), '-> now', after)
await shot('05-break', 'Nach dem Blockabbau')

console.log('opening the inventory …')
await page.keyboard.press('KeyE')
await page.waitForTimeout(2000)
await shot('06-inventory', 'Inventar')
const invState = await state()
await page.keyboard.press('Escape')
await page.waitForTimeout(1000)

const final = await snap()
await browser.close(); server.close()

console.log('\n--- result ---')
console.log('final:', JSON.stringify(final, null, 1))
console.log('inventory state:', invState)
console.log('block break:', before ? `${before.id} -> ${after}` : 'no target under the crosshair')
console.log('steps:'); steps.forEach(s => console.log(`  ${s.name.padEnd(14)} ${s.error ? 'FAILED: ' + s.error : String(s.kb).padStart(5) + ' KB  distinct=' + String(s.distinct).padStart(3)}  ${s.note}`))
if (errors.length) { console.log(`\nerrors (${errors.length}):`); [...new Set(errors)].slice(0, 12).forEach(e => console.log('  ' + e)) }
else console.log('\nno console or page errors.')
process.exit(errors.length ? 1 : 0)
