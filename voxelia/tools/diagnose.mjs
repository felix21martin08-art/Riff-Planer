#!/usr/bin/env node
/**
 * Targeted gameplay diagnostic.
 *
 * Boots the real game, spawns into a streamed world, aims at the ground and
 * attacks, recording the camera basis, the raycast target, break progress,
 * particle count and inventory UI state before, during and after. Used to turn
 * "the picture looks wrong" into concrete numbers.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import { serve, CHROME_ARGS, waitAlive } from './harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { server, base } = await serve(ROOT)
const browser = await chromium.launch({ args: CHROME_ARGS })
const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
const errors = []
page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.stack || e.message).split('\n').slice(0, 2).join(' | ')))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 250)) })

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 })
console.log('waiting for the menu …')
await waitAlive(page, () => window.game && window.game.state === 'menu', {
  label: 'menu', verbose: true,
  status: () => ({ ready: !!window.game, state: window.game && window.game.state, boot: (document.getElementById('boot-status') || {}).textContent }),
})
console.log('menu reached; creating world …')
await page.evaluate(() => window.game.startWorld({ seed: 1337, name: 'diag', gameMode: 'survival' }))
await waitAlive(page, () => window.game.state === 'playing', {
  label: 'playing', verbose: true,
  status: () => ({ state: window.game.state, chunks: (() => { try { return window.game.world.getStats().loaded } catch { return null } })() }),
})

console.log('streaming …')
await page.evaluate(async () => {
  const g = window.game
  const dl = performance.now() + 30000
  while (performance.now() < dl) {
    for (let i = 0; i < 24; i++) g.world.update(1 / 60, g.player.position, g.player.camera.frustum)
    const s = g.world.getStats()
    if (s.queued === 0 && s.meshing === 0 && s.lightQueue === 0) break
    await new Promise(r => setTimeout(r, 0))
  }
})

const probe = () => page.evaluate(() => {
  const g = window.game, pl = g.player, c = pl.camera
  const rollKeys = ['roll', 'cameraRoll', '_roll', 'tilt', '_cameraRoll', 'bobRoll', '_bob']
  const roll = {}
  for (const k of rollKeys) if (pl[k] !== undefined) roll[k] = typeof pl[k] === 'number' ? +pl[k].toFixed(4) : String(pl[k])
  const it = g.interaction
  return {
    up: [...c.up].map(v => +v.toFixed(4)),
    forward: [...c.forward].map(v => +v.toFixed(4)),
    yaw: +pl.yaw.toFixed(3), pitch: +pl.pitch.toFixed(3), roll,
    perspective: pl.perspective,
    hit: it && it.hit ? { x: it.hit.x, y: it.hit.y, z: it.hit.z, face: it.hit.face, dist: +(it.hit.dist ?? 0).toFixed(2), blockId: it.hit.blockId } : null,
    breakProgress: it ? +(it.breakProgress ?? 0).toFixed(3) : null,
    particles: g.particles ? g.particles.count : null,
    frameHit: g._frame && g._frame.hit ? 'set' : 'null',
  }
})

const line = async (label) => console.log(label.padEnd(9), JSON.stringify(await probe()))
await line('BEFORE')
console.log('aiming straight down …')
await page.evaluate(() => { window.game.player.pitch = -1.45 })
await waitAlive(page, () => true, { timeout: 8000, poll: 1500 }).catch(() => {})
await line('AIMED')
await page.mouse.down({ button: 'left' })
for (let i = 0; i < 4; i++) { await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => {}); await page.waitForTimeout(1500) }
await line('HOLDING')
await page.mouse.up({ button: 'left' })
await page.waitForTimeout(1500)
await line('AFTER')

console.log('opening the inventory …')
await page.keyboard.press('KeyE')
for (let i = 0; i < 3; i++) { await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => {}); await page.waitForTimeout(1200) }
const inv = await page.evaluate(() => {
  /** Walk the inventory subtree and report why it is (not) visible. */
  const dump = (el, depth = 0, out = []) => {
    if (!el || depth > 3) return out
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    out.push({
      d: depth, tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 48),
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      z: cs.zIndex, transform: cs.transform === 'none' ? 'none' : 'set',
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      children: el.children.length,
    })
    for (const c of [...el.children].slice(0, 4)) dump(c, depth + 1, out)
    return out
  }
  window.__invDump = (() => {
    const layer = document.querySelector('.vx-containers')
    return layer ? dump(layer) : null
  })()
  return (() => {
  const root = document.getElementById('ui')
  const all = [...document.querySelectorAll('*')]
  const invish = all.filter(e => typeof e.className === 'string' && /invent/i.test(e.className))
  const visible = invish.filter(e => e.offsetParent !== null || getComputedStyle(e).display !== 'none')
  return {
    state: window.game.state,
    uiChildren: root ? root.children.length : -1,
    uiChildClasses: root ? [...root.children].map(c => c.className || c.id || c.tagName).slice(0, 12) : [],
    inventoryNodes: invish.length,
    inventoryVisible: visible.length,
    gameKeys: Object.keys(window.game).filter(k => /ui|hud|screen|invent|overlay/i.test(k)),
    cssVars: (() => {
      const cs = getComputedStyle(document.documentElement)
      return ['--z-container', '--gui-scale', '--cell'].map(v => v + '=' + (cs.getPropertyValue(v).trim() || 'UNDEFINED')).join(' ')
    })(),
    subtree: window.__invDump,
  }
})()
})
console.log('INVENTORY', JSON.stringify(inv, null, 1))

await browser.close(); server.close()
if (errors.length) { console.log(`\nerrors (${errors.length}):`); [...new Set(errors)].slice(0, 10).forEach(e => console.log('  ' + e)) }
else console.log('\nno console or page errors.')
