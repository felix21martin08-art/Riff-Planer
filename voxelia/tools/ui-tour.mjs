#!/usr/bin/env node
/**
 * UI tour + particle check.
 *
 * Opens every screen in turn and screenshots it, then spawns block-break
 * particles and photographs them from a fixed angle. One browser session, so
 * the expensive boot is paid once.
 *
 * Every screenshot is preceded by several forced composites: under a software
 * rasteriser a frame can take ~20 s, and a CSS transition that has not been
 * given a frame yet photographs as an empty screen — which already fooled an
 * earlier run of this project's playtest.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import { serve, CHROME_ARGS, waitAlive } from './harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] || '/tmp/uitour'
fs.mkdirSync(OUT, { recursive: true })
const { server, base } = await serve(ROOT)
const browser = await chromium.launch({ args: CHROME_ARGS })
// Screens fade in over ~200 ms, but a frame here takes ~20 s, so whether a
// screenshot catches the transition is pure chance — that lottery already made
// two screens look broken in one run and fine in the next. Emulating
// reduced-motion disables the transitions instead of guessing at timing.
const page = await browser.newPage({ viewport: { width: 1024, height: 576 }, reducedMotion: 'reduce' })
const msgs = []
page.on('pageerror', e => msgs.push('PAGEERROR ' + e.message.slice(0, 200)))
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(m.type().toUpperCase() + ' ' + m.text().slice(0, 200)) })

/** Force n compositor frames, then screenshot. */
async function settleShot(name, note, frames = 5) {
  for (let i = 0; i < frames; i++) {
    await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => {})
    await page.waitForTimeout(900)
  }
  try {
    await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 300000 })
    console.log(`  ${name.padEnd(16)} ok    ${note}`)
  } catch (e) { console.log(`  ${name.padEnd(16)} FAIL  ${e.message.split('\n')[0]}`) }
}

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 })
await waitAlive(page, () => window.game && window.game.state === 'menu', { label: 'menu', verbose: true })
console.log('screens:')
await settleShot('01-menu', 'Hauptmenü')

/** Open a screen through the ScreenManager, whatever it is called. */
const show = (name) => page.evaluate(n => {
  const g = window.game
  const sm = g.ui && g.ui.screens ? g.ui.screens : g.screens
  if (!sm || typeof sm.show !== 'function') return 'no ScreenManager'
  try { sm.show(n, null); return sm.current || n } catch (e) { return 'ERR ' + e.message }
}, name)

for (const [id, screen, note] of [
  ['02-create', 'worldcreate', 'Welt erstellen'],
  ['03-worlds', 'worldlist', 'Welt laden'],
  ['04-settings', 'settings', 'Einstellungen'],
  ['05-controls', 'controls', 'Steuerung'],
]) {
  const r = await show(screen)
  if (String(r).startsWith('no ') || String(r).startsWith('ERR')) { console.log(`  ${id.padEnd(16)} skip  ${screen}: ${r}`); continue }
  await settleShot(id, note)
}

console.log('\nparticles:')
await page.evaluate(() => {
  const sm = window.game.ui && window.game.ui.screens
  if (sm && typeof sm.hide === 'function') sm.hide()
})
await page.evaluate(() => window.game.startWorld({ seed: 4242, name: 'fx', gameMode: 'creative' }))
await waitAlive(page, () => window.game.state === 'playing', { label: 'playing', verbose: true })
await page.evaluate(async () => {
  const g = window.game
  const dl = performance.now() + 25000
  while (performance.now() < dl) {
    for (let i = 0; i < 24; i++) g.world.update(1 / 60, g.player.position, g.player.camera.frustum)
    const s = g.world.getStats()
    if (s.queued === 0 && s.meshing === 0 && s.lightQueue === 0) break
    await new Promise(r => setTimeout(r, 0))
  }
})
// Look at the ground a few blocks ahead, then burst particles from one block.
const fx = await page.evaluate(() => {
  const g = window.game, p = g.player
  p.pitch = -0.55
  const x = Math.floor(p.position[0]), z = Math.floor(p.position[2])
  let y = Math.floor(p.position[1])
  while (y > -60 && g.world.getBlock(x, y, z) === 0) y--
  const id = g.world.getBlock(x, y, z)
  if (g.particles && typeof g.particles.spawnBlockBreak === 'function') {
    for (let i = 0; i < 3; i++) g.particles.spawnBlockBreak(x + 0.5, y + 0.5, z + 0.5 - i, id)
  }
  return { block: [x, y, z], id, count: g.particles ? g.particles.count : null }
})
console.log('  spawned at', JSON.stringify(fx))
await settleShot('06-particles', 'Abbau-Partikel', 2)

await browser.close(); server.close()
if (msgs.length) { console.log('\nmessages:'); [...new Set(msgs)].slice(0, 12).forEach(m => console.log('  ' + m)) }
