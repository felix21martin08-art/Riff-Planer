#!/usr/bin/env node
/**
 * VOXELIA headless smoke test.
 *
 * Serves the game over http, loads it in headless Chromium with a software GL
 * backend, drives it for a while, and reports every console error, page error,
 * failed request and WebGL/shader problem. Optionally writes screenshots.
 *
 * usage: node tools/smoke.mjs [--seconds 12] [--shots out/dir] [--url /index.html]
 *                            [--script path/to/inject.js] [--keep]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def
}
const SECONDS = Number(arg('seconds', 12))
const SHOTS = arg('shots', null)
const URL_PATH = arg('url', '/index.html')
const INJECT = arg('script', null)
/** Substrings of request paths whose 404s are expected (module not built yet). */
const ALLOW_404 = String(arg('allow404', '')).split(',').filter(Boolean)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon',
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  const file = path.join(ROOT, url === '/' ? '/index.html' : url)
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + url); return }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    })
    res.end(data)
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const browser = await chromium.launch({
  args: [
    '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--use-gl=angle', '--enable-webgl',
    '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=4096',
    '--enable-features=SharedArrayBuffer',
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })

const errors = []
const warnings = []
const logs = []
const failedRequests = []

const allowed = u => ALLOW_404.some(a => String(u).includes(a))
page.on('console', msg => {
  const t = msg.type()
  const text = msg.text()
  const loc = msg.location()
  const where = loc && loc.url ? ` (${loc.url.replace(base, '')}:${loc.lineNumber})` : ''
  if (t === 'error') { if (!allowed(text) && !allowed(where)) errors.push(text + where) }
  else if (t === 'warning') warnings.push(text + where)
  else logs.push(`[${t}] ${text}`)
})
page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.stack || e.message)))
page.on('requestfailed', r => {
  const u = r.url().replace(base, '')
  if (!allowed(u)) failedRequests.push(`${r.method()} ${u} :: ${r.failure()?.errorText}`)
})
page.on('response', r => {
  const u = r.url().replace(base, '')
  if (r.status() >= 400 && !allowed(u)) failedRequests.push(`${r.status()} ${u}`)
})

// Surface uncaught promise rejections and WebGL errors from inside the page.
await page.addInitScript(() => {
  window.__voxSmoke = { glErrors: [], shaderErrors: [], marks: [] }
  addEventListener('unhandledrejection', e => {
    console.error('UNHANDLED REJECTION: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason))
  })
  const origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs)
    if (ctx && /webgl2?/.test(type)) {
      const origShaderSource = ctx.shaderSource.bind(ctx)
      const sources = new WeakMap()
      ctx.shaderSource = (sh, src) => { sources.set(sh, src); return origShaderSource(sh, src) }
      const origCompile = ctx.compileShader.bind(ctx)
      ctx.compileShader = sh => {
        origCompile(sh)
        if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) {
          const log = ctx.getShaderInfoLog(sh) || ''
          const src = sources.get(sh) || ''
          const lines = src.split('\n')
          const detail = log.split('\n').slice(0, 12).map(l => {
            const m = l.match(/^\w+:\s*\d+:(\d+)/)
            return m ? `${l}\n      >>> ${lines[Number(m[1]) - 1] || ''}` : l
          }).join('\n')
          window.__voxSmoke.shaderErrors.push(detail)
          console.error('SHADER COMPILE FAILED:\n' + detail)
        }
      }
      const origLink = ctx.linkProgram.bind(ctx)
      ctx.linkProgram = p => {
        origLink(p)
        if (!ctx.getProgramParameter(p, ctx.LINK_STATUS)) {
          const log = ctx.getProgramInfoLog(p) || ''
          window.__voxSmoke.shaderErrors.push('LINK: ' + log)
          console.error('PROGRAM LINK FAILED: ' + log)
        }
      }
    }
    return ctx
  }
})

if (INJECT && INJECT !== true) await page.addInitScript({ path: INJECT })

const t0 = Date.now()
try {
  await page.goto(base + URL_PATH, { waitUntil: 'domcontentloaded', timeout: 60000 })
} catch (e) {
  errors.push('NAVIGATION: ' + e.message)
}

// Let the game boot and run.
const deadline = Date.now() + SECONDS * 1000
let shot = 0
if (SHOTS && SHOTS !== true) fs.mkdirSync(SHOTS, { recursive: true })
while (Date.now() < deadline) {
  await page.waitForTimeout(1000)
  if (SHOTS && SHOTS !== true && (Date.now() - t0) > 3000) {
    const p = path.join(SHOTS, `frame-${String(++shot).padStart(2, '0')}.png`)
    try { await page.screenshot({ path: p, timeout: 120000, animations: 'allow' }) }
    catch (e) { warnings.push('screenshot failed: ' + e.message.split('\n')[0]) }
  }
}

const probe = await page.evaluate(() => {
  const g = window.game || window.__game || null
  const canvas = document.querySelector('canvas')
  let pixels = null
  try {
    const gl = canvas && canvas.getContext('webgl2')
    if (gl) {
      const buf = new Uint8Array(4 * 64)
      gl.readPixels(canvas.width / 2 | 0, canvas.height / 2 | 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      let sum = 0, distinct = new Set()
      for (let i = 0; i < buf.length; i += 4) { sum += buf[i] + buf[i + 1] + buf[i + 2]; distinct.add(buf[i] * 65536 + buf[i + 1] * 256 + buf[i + 2]) }
      pixels = { avg: sum / 64 / 3, distinct: distinct.size }
    }
  } catch (e) { pixels = { error: String(e) } }
  return {
    probe: window.__probe ? {
      stage: window.__probe.stage, ready: window.__probe.ready,
      frames: window.__probe.frames, fps: window.__probe.fps,
      avgFrameMs: window.__probe.avgFrameMs, initMs: Math.round(window.__probe.initMs || 0),
      camera: window.__probe.camera, chunks: window.__probe.chunks,
      errors: window.__probe.errors.slice(0, 8),
      settleIterations: window.__probe.settleIterations,
    } : null,
    hasGame: !!g,
    state: g && g.state,
    fps: g && g.stats && g.stats.fps,
    chunks: g && g.world && g.world.getStats && (() => { try { return g.world.getStats() } catch { return null } })(),
    canvasSize: canvas ? [canvas.width, canvas.height] : null,
    shaderErrors: window.__voxSmoke.shaderErrors,
    marks: window.__voxSmoke.marks,
    pixels,
    bootError: window.__voxBootError || null,
  }
})

if (SHOTS && SHOTS !== true) {
  try { await page.screenshot({ path: path.join(SHOTS, 'final.png'), timeout: 120000 }) }
  catch (e) { warnings.push('final screenshot failed: ' + e.message.split('\n')[0]) }
}

await browser.close()
server.close()

const dedupe = a => [...new Set(a)]
const rendered = probe.pixels && !probe.pixels.error && probe.pixels.distinct > 1
const report = {
  ok: errors.length === 0 && failedRequests.length === 0 && rendered,
  rendered,
  durationS: ((Date.now() - t0) / 1000).toFixed(1),
  errors: dedupe(errors).slice(0, 60),
  failedRequests: dedupe(failedRequests).slice(0, 40),
  warnings: dedupe(warnings).slice(0, 25),
  logs: logs.slice(-40),
  probe,
}
console.log(JSON.stringify(report, null, 1))
process.exit(report.ok ? 0 : 1)
