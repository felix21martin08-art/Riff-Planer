#!/usr/bin/env node
/**
 * Isolates the block-break particles by differencing two frames of the exact
 * same scene: one before spawning and one after. Whatever changes IS the
 * particle system — no squinting at a screenshot required.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import { serve, CHROME_ARGS, waitAlive } from './harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] || '/tmp/ptest'
fs.mkdirSync(OUT, { recursive: true })
const { server, base } = await serve(ROOT)
const browser = await chromium.launch({ args: CHROME_ARGS })
const page = await browser.newPage({ viewport: { width: 800, height: 450 }, reducedMotion: 'reduce' })
page.on('pageerror', e => console.error('PAGEERROR', e.message.slice(0, 160)))

const variety = () => page.evaluate(() => {
  const c = document.querySelector('canvas'); const gl = c && c.getContext('webgl2')
  if (!gl) return -1
  const b = new Uint8Array(24 * 14 * 4); const s = new Set()
  try { gl.readPixels((c.width - 24) >> 1, (c.height - 14) >> 1, 24, 14, gl.RGBA, gl.UNSIGNED_BYTE, b) } catch { return -1 }
  for (let i = 0; i < b.length; i += 4) s.add((b[i] << 16) | (b[i + 1] << 8) | b[i + 2])
  return s.size
})
async function pump(rounds = 6, frames = 4) {
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < frames; i++) { await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => {}); await page.waitForTimeout(800) }
    if (await variety() > 1) return true
  }
  return false
}

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 })
await waitAlive(page, () => window.game && window.game.state === 'menu', { label: 'menu', verbose: true })
await page.evaluate(() => window.game.startWorld({ seed: 4242, name: 'ptest', gameMode: 'creative' }))
await waitAlive(page, () => window.game.state === 'playing', { label: 'playing', verbose: true })
await page.evaluate(async () => {
  const g = window.game; const dl = performance.now() + 30000
  while (performance.now() < dl) {
    for (let i = 0; i < 24; i++) g.world.update(1 / 60, g.player.position, g.player.camera.frustum)
    const s = g.world.getStats(); if (s.queued === 0 && s.meshing === 0 && s.lightQueue === 0) break
    await new Promise(r => setTimeout(r, 0))
  }
})

// Aim at a block a realistic 4 blocks away rather than at the player's feet.
const aim = await page.evaluate(() => {
  const g = window.game, p = g.player
  p.pitch = -0.35; p.yaw = 0
  g.particles && g.particles.clear && g.particles.clear()
  const dir = p.getLookDirection ? p.getLookDirection() : [0, -0.34, -0.94]
  const eye = p.getEyePosition ? p.getEyePosition() : p.position
  const hit = g.world.raycast(eye, dir, 8, {})
  return { hit: hit ? { x: hit.x, y: hit.y, z: hit.z, id: hit.blockId, dist: +hit.dist.toFixed(2) } : null, particles: g.particles ? g.particles.count : null }
})
console.log('aim:', JSON.stringify(aim))
await pump()
await page.screenshot({ path: path.join(OUT, 'a-before.png'), timeout: 300000 })

const spawned = await page.evaluate(t => {
  const g = window.game
  if (!t.hit) return { spawned: 0 }
  g.particles.spawnBlockBreak(t.hit.x + 0.5, t.hit.y + 0.5, t.hit.z + 0.5, t.hit.id)
  return { spawned: g.particles.count }
}, aim)
console.log('after spawn:', JSON.stringify(spawned))
// One short pump only: the chips must still be alive when photographed.
for (let i = 0; i < 2; i++) { await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => {}); await page.waitForTimeout(500) }
await page.screenshot({ path: path.join(OUT, 'b-after.png'), timeout: 300000 })
console.log('alive at capture:', await page.evaluate(() => window.game.particles.count))

await browser.close(); server.close()
console.log('wrote', OUT)
