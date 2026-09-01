#!/usr/bin/env node
/**
 * VOXELIA scene capture.
 *
 * Boots the render probe once, waits for the world to finish streaming, then
 * renders a list of scene variants and writes a PNG for each. Init and
 * streaming are paid once, so comparing ten looks costs barely more than one.
 *
 * usage: node tools/capture.mjs --out DIR [--rd 5] [--tex 256] [--w 960] [--h 540]
 *                               [--settle 90000] [--frames 3] [--scenes a,b,c]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }

const OUT = arg('out', path.join(ROOT, 'docs/shots'))
const W = Number(arg('w', 960)), H = Number(arg('h', 540))
const RD = arg('rd', 5), TEX = arg('tex', 256), SETTLE = arg('settle', 90000)
const FRAMES = Number(arg('frames', 3))
const ONLY = arg('scenes', null)?.split(',')

/** Scene variants. Each applies a config and gets one screenshot. */
const SCENES = [
  { id: 'noon',        cfg: { time: 0.25, yaw: -35, pitch: -8 },                     note: 'Mittag' },
  { id: 'noon-nofog',  cfg: { time: 0.25, yaw: -35, pitch: -8, fogDensity: 0 },      note: 'Mittag ohne Nebel' },
  { id: 'sunrise',     cfg: { time: 0.03, yaw: 90,  pitch: 2 },                      note: 'Sonnenaufgang' },
  { id: 'golden',      cfg: { time: 0.46, yaw: -95, pitch: 0, fogDensity: 0.0006 },  note: 'Abendlicht' },
  { id: 'night',       cfg: { time: 0.78, yaw: -35, pitch: 6, fogDensity: 0.0004 },  note: 'Nacht' },
  { id: 'rain',        cfg: { time: 0.30, yaw: -35, pitch: -8, rain: 1, weather: 'rain' }, note: 'Regen' },
  { id: 'down',        cfg: { time: 0.25, yaw: -35, pitch: -55, fogDensity: 0.0004 }, note: 'Blick nach unten' },
  { id: 'up',          cfg: { time: 0.25, yaw: -35, pitch: 40, fogDensity: 0.0004 }, note: 'Himmel' },
  { id: 'high',        cfg: { time: 0.25, yaw: -35, pitch: -25, dy: 40, fogDensity: 0.0005 }, note: 'Aus der Höhe' },
]
const scenes = ONLY ? SCENES.filter(s => ONLY.includes(s.id)) : SCENES

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  const file = path.join(ROOT, url === '/' ? '/index.html' : url)
  if (!file.startsWith(ROOT)) return res.writeHead(403).end()
  fs.readFile(file, (e, d) => e
    ? res.writeHead(404).end('404')
    : res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(d))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', e => errors.push(String(e.message)))
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('items.js')) errors.push(m.text().slice(0, 200)) })

const url = `${base}/tools/render-probe.html?rd=${RD}&tex=${TEX}&settle=${SETTLE}&w=${W}&h=${H}&hud=0`
console.log('booting', url)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

// Wait for init + streaming to finish.
const t0 = Date.now()
await page.waitForFunction(() => window.__probe && window.__probe.stage === 'rendering', null, { timeout: 900000, polling: 2000 })
const stats = await page.evaluate(() => window.__probeStats())
console.log(`settled in ${((Date.now() - t0) / 1000).toFixed(0)}s ::`, JSON.stringify(stats))

// The HUD would sit in every screenshot.
await page.evaluate(() => { const h = document.getElementById('hud'); if (h) h.style.display = 'none' })

const results = []
for (const scene of scenes) {
  const applied = await page.evaluate(cfg => window.__probeApply(cfg), scene.cfg)
  if (applied.inSolid) console.log(`  ! ${scene.id}: camera is inside a solid block — the shot will show back-face holes`)
  const before = await page.evaluate(() => window.__probe.frames)
  // Let several full frames render so TAA converges and history settles.
  await page.waitForFunction(n => window.__probe.frames >= n, before + FRAMES, { timeout: 600000, polling: 1000 })
  const file = path.join(OUT, `${scene.id}.png`)
  try {
    await page.screenshot({ path: file, timeout: 300000 })
    const kb = (fs.statSync(file).size / 1024) | 0
    console.log(`  ${scene.id.padEnd(12)} ${String(kb).padStart(5)} KB  ${scene.note}`)
    results.push({ id: scene.id, file, kb, applied })
  } catch (e) {
    console.log(`  ${scene.id.padEnd(12)} SCREENSHOT FAILED: ${e.message.split('\n')[0]}`)
  }
}

await browser.close()
server.close()
console.log(`\n${results.length}/${scenes.length} scenes captured into ${OUT}`)
if (errors.length) { console.log(`errors (${errors.length}):`); [...new Set(errors)].slice(0, 10).forEach(e => console.log('  ' + e)) }
process.exit(results.length === scenes.length && errors.length === 0 ? 0 : 1)
