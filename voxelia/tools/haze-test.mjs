#!/usr/bin/env node
/**
 * Isolates the milky slab seen over the lower screen by re-rendering the exact
 * same view with individual render features switched off. Whatever removes the
 * haze names the pass responsible.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import { serve, CHROME_ARGS, waitAlive } from './harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] || '/tmp/haze'
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
async function shot(name, note) {
  for (let r = 0; r < 5; r++) {
    for (let i = 0; i < 4; i++) { await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => {}); await page.waitForTimeout(800) }
    if (await variety() > 1) break
  }
  await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 300000 })
  console.log(`  ${name.padEnd(18)} ${String((fs.statSync(path.join(OUT, name + '.png')).size / 1024) | 0).padStart(4)} KB  ${note}`)
}

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 })
await waitAlive(page, () => window.game && window.game.state === 'menu', { label: 'menu', verbose: true })
await page.evaluate(() => window.game.startWorld({ seed: 4242, name: 'haze', gameMode: 'creative' }))
await waitAlive(page, () => window.game.state === 'playing', { label: 'playing', verbose: true })
await page.evaluate(async () => {
  const g = window.game; const dl = performance.now() + 30000
  while (performance.now() < dl) {
    for (let i = 0; i < 24; i++) g.world.update(1 / 60, g.player.position, g.player.camera.frustum)
    const s = g.world.getStats(); if (s.queued === 0 && s.meshing === 0 && s.lightQueue === 0) break
    await new Promise(r => setTimeout(r, 0))
  }
})

// What is actually around and below the camera?
const ctx = await page.evaluate(() => {
  const g = window.game, p = g.player
  p.pitch = -0.35; p.yaw = 0
  const eye = p.getEyePosition ? p.getEyePosition() : p.position
  const at = (dx, dy, dz) => {
    const id = g.world.getBlock(Math.floor(eye[0] + dx), Math.floor(eye[1] + dy), Math.floor(eye[2] + dz))
    return id
  }
  return {
    eye: [...eye].map(v => +v.toFixed(2)),
    underwater: !!p.camera.underwater,
    blockAtEye: at(0, 0, 0), below: at(0, -1, 0), below2: at(0, -2, 0),
    ahead: [1, 2, 3, 4, 5].map(d => at(0, -1, -d)),
    seaLevel: g.environment ? g.environment.seaLevel : null,
    waterId: 1,
  }
})
console.log('scene:', JSON.stringify(ctx))

console.log('variants:')
await shot('01-default', 'alles an')
await page.evaluate(() => window.game.settings.set('ssr', false))
await shot('02-no-ssr', 'ohne Screen-Space-Reflexionen')
await page.evaluate(() => window.game.settings.set('waterQuality', 'low'))
await shot('03-water-low', 'Wasser auf niedrig')
await page.evaluate(() => { window.game.settings.set('ssr', true); window.game.settings.set('waterQuality', 'high'); window.game.settings.set('volumetricLight', false) })
await shot('04-no-volumetrics', 'ohne Lichtschächte')
await page.evaluate(() => { window.game.settings.set('volumetricLight', true); window.game.settings.set('bloom', false) })
await shot('05-no-bloom', 'ohne Bloom')

await browser.close(); server.close()
