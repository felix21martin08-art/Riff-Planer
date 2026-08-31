#!/usr/bin/env node
/**
 * Focused inventory-visibility probe: boot, create a world, open the inventory,
 * then dump the whole container subtree with computed styles and geometry and
 * take a screenshot. Skips streaming and combat, so it runs in a few minutes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import { serve, CHROME_ARGS, waitAlive } from './harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] || '/tmp/inv'
fs.mkdirSync(OUT, { recursive: true })
const { server, base } = await serve(ROOT)
const browser = await chromium.launch({ args: CHROME_ARGS })
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } })
const msgs = []
page.on('pageerror', e => msgs.push('PAGEERROR ' + e.message.slice(0, 200)))
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(m.type().toUpperCase() + ' ' + m.text().slice(0, 220)) })

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 })
await waitAlive(page, () => window.game && window.game.state === 'menu', { label: 'menu', verbose: true })
await page.evaluate(() => window.game.startWorld({ seed: 4242, name: 'inv', gameMode: 'creative' }))
await waitAlive(page, () => window.game.state === 'playing', { label: 'playing', verbose: true })

// Put something in the inventory so the panel has content to lay out.
await page.evaluate(() => {
  const g = window.game
  try {
    const { ItemStack } = window.__voxInv || {}
    const inv = g.player.inventory
    if (inv && inv.slots) {
      for (let i = 0; i < 6; i++) {
        const s = inv.get(i)
        if (!s) inv.set(i, { itemId: 1 + i, count: 8 + i, meta: null, isEmpty: () => false, clone() { return { ...this } } })
      }
    }
  } catch (e) { console.warn('seed inventory failed: ' + e.message) }
})

await page.keyboard.press('KeyE')
await waitAlive(page, () => window.game.state === 'inventory', { label: 'inventory state', timeout: 120000 })
// Give the open transition a few real frames.
for (let i = 0; i < 4; i++) { await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => {}); await page.waitForTimeout(1200) }

const report = await page.evaluate(() => {
  const walk = (el, depth = 0, out = []) => {
    if (!el || depth > 4 || out.length > 80) return out
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    out.push({
      d: depth, tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 46),
      display: cs.display, vis: cs.visibility, op: cs.opacity, z: cs.zIndex,
      pos: cs.position, overflow: cs.overflow,
      w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
      kids: el.children.length,
    })
    for (const c of [...el.children].slice(0, 5)) walk(c, depth + 1, out)
    return out
  }
  const layer = document.querySelector('.vx-containers')
  const root = document.getElementById('ui')
  return {
    state: window.game.state,
    hasLayer: !!layer,
    layerClass: layer ? layer.className : null,
    uiRect: root ? (({ width, height }) => ({ width, height }))(root.getBoundingClientRect()) : null,
    uiPointer: root ? getComputedStyle(root).pointerEvents : null,
    subtree: layer ? walk(layer) : null,
    invOpen: !!(window.game.ui && window.game.ui.inventory && window.game.ui.inventory.isOpen),
    slotsFilled: (() => { try { return window.game.player.inventory.slots.filter(Boolean).length } catch { return null } })(),
  }
})
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1))
await page.screenshot({ path: path.join(OUT, 'inventory.png'), timeout: 300000 }).catch(e => msgs.push('shot failed ' + e.message))

console.log('state:', report.state, '| layer:', report.hasLayer, '| open flag:', report.invOpen, '| slots filled:', report.slotsFilled)
console.log('layer class:', report.layerClass)
console.log('#ui rect:', JSON.stringify(report.uiRect), 'pointer-events:', report.uiPointer)
console.log('\nsubtree:')
for (const n of (report.subtree || []).slice(0, 24)) {
  console.log(`  ${'  '.repeat(n.d)}${n.tag} .${n.cls}`.padEnd(58) + `${n.display}/${n.vis} op=${n.op} z=${n.z} ${n.pos} ${n.w}x${n.h} @${n.x},${n.y} kids=${n.kids}`)
}
if (msgs.length) { console.log('\nmessages:'); [...new Set(msgs)].slice(0, 15).forEach(m => console.log('  ' + m)) }
await browser.close(); server.close()
