#!/usr/bin/env node
/** Runs tools/dump-textures.html headless and writes each layer as a PNG. */
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const OUT = arg('out', '/tmp/tex'); const TEX = arg('tex', 128); const NAMES = arg('names', '')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' }
const server = http.createServer((q, r) => {
  const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]))
  fs.readFile(f, (e, d) => e ? r.writeHead(404).end() : r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }).end(d))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const b = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle'] })
const p = await b.newPage()
p.on('pageerror', e => console.error('PAGEERROR', e.message))
p.on('console', m => { if (m.type() === 'error') console.error('CONSOLE', m.text().slice(0, 300)) })
await p.goto(`http://127.0.0.1:${server.address().port}/tools/dump-textures.html?tex=${TEX}${NAMES ? '&names=' + NAMES : ''}`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.__dump && (window.__dump.ready || window.__dump.error), null, { timeout: 600000, polling: 1000 })
const d = await p.evaluate(() => window.__dump)
if (d.error) { console.error('DUMP FAILED:', d.error); process.exit(1) }
fs.mkdirSync(OUT, { recursive: true })
for (const [name, url] of Object.entries(d.images)) {
  if (!url) { console.log(`  ${name}: MISSING MATERIAL`); continue }
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(url.split(',')[1], 'base64'))
  console.log(`  ${name}.png`)
}
await b.close(); server.close()
