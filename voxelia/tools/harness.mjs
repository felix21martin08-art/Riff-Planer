/**
 * Shared helpers for the headless test tools.
 *
 * Headless Chromium throttles requestAnimationFrame whenever no compositor
 * frame is being demanded, which stalls any rAF-driven game loop between
 * screenshots. A visible tab never does this, so it is purely a testing
 * artifact — but every wait in these tools has to survive it. `waitAlive`
 * therefore forces a tiny composite between polls.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
}

/** Serve `root` on a random loopback port. @returns {Promise<{server:http.Server, base:string}>} */
export async function serve(root) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    const file = path.join(root, url === '/' ? '/index.html' : url)
    if (!file.startsWith(root)) { res.writeHead(403).end(); return }
    fs.readFile(file, (err, data) => err
      ? res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + url)
      : res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

/** Chromium flags that give a working WebGL2 stack without a GPU. */
export const CHROME_ARGS = [
  '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--use-gl=angle', '--disable-dev-shm-usage',
]

/**
 * Wait for `predicate` to be true in the page, forcing a composite between
 * polls so a throttled rAF loop keeps running.
 * @param {import('playwright').Page} page
 * @param {Function} predicate evaluated in the page, must return truthy
 * @param {{timeout?:number, poll?:number, label?:string, onTick?:Function}} [opts]
 * @returns {Promise<any>} the predicate's truthy value
 */
export async function waitAlive(page, predicate, opts = {}) {
  const timeout = opts.timeout ?? 900000
  const poll = opts.poll ?? 1500
  const deadline = Date.now() + timeout
  let ticks = 0
  while (Date.now() < deadline) {
    let v
    try { v = await page.evaluate(predicate) } catch { v = null }
    if (v) return v
    // A 1x1 screenshot is the cheapest way to demand a compositor frame.
    try { await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 }, timeout: 60000 }) } catch {}
    if (opts.onTick && (++ticks % 10 === 0)) await opts.onTick(ticks)
    await page.waitForTimeout(poll)
  }
  throw new Error(`waitAlive timed out after ${(timeout / 1000) | 0}s${opts.label ? ': ' + opts.label : ''}`)
}

/**
 * Advance the page by at least `n` rendered frames, keeping the loop alive.
 * @param {import('playwright').Page} page
 * @param {number} n
 * @param {Function} counter evaluated in the page, returns the frame count
 */
export async function pumpFrames(page, n, counter, timeout = 600000) {
  const start = await page.evaluate(counter).catch(() => 0)
  await waitAlive(page, new Function(`return (${counter.toString()})() >= ${(start || 0) + n}`), { timeout, label: `${n} frames` })
}
