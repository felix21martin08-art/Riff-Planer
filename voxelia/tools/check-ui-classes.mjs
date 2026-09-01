#!/usr/bin/env node
/**
 * UI class-name consistency checker.
 *
 * The UI modules and the stylesheet were written independently, so a module can
 * happily emit a class the stylesheet never defines — the element then renders
 * unstyled (often invisibly) with no error anywhere. This extracts every class
 * name the UI modules put into the DOM and compares it against the selectors
 * `ui/style.css` actually defines.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI = path.join(ROOT, 'src/ui')
const CSS = path.join(UI, 'style.css')

const css = fs.readFileSync(CSS, 'utf8')
/** Class names the stylesheet defines, plus any injected by the modules themselves. */
const defined = new Set()
for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1])

const files = fs.readdirSync(UI).filter(f => /\.js$/.test(f))
const used = new Map() // class -> Set(file)

for (const f of files) {
  const src = fs.readFileSync(path.join(UI, f), 'utf8')
  // Any inline <style> the module injects also counts as defining classes.
  for (const m of src.matchAll(/\.(-?[_a-zA-Z][\w-]*)\s*(?:,|\{|:{1,2}[\w-]+\s*[,{])/g)) defined.add(m[1])
  // className = '…', classList.add('…'), setAttribute('class', '…'), class="…"
  // The modules build DOM through helpers like el('div', 'vx-slot is-active'),
  // so the class names arrive as plain string literals rather than in a
  // className assignment. Harvest every literal that looks like one.
  for (const m of src.matchAll(/['"`]([a-z]{2,4}-[\w-]+(?:\s+[\w-]+)*)['"`]/g)) {
    for (const raw of m[1].split(/\s+/)) {
      if (!/^(vx|vox|is|has)[-\w]*$/.test(raw)) continue
      if (!used.has(raw)) used.set(raw, new Set())
      used.get(raw).add(f)
    }
  }
  const patterns = [
    /className\s*=\s*['"`]([^'"`]+)['"`]/g,
    /classList\.(?:add|remove|toggle)\(([^)]*)\)/g,
    /setAttribute\(\s*['"]class['"]\s*,\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\bclass=\\?["']([^"'\\]+)/g,
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      for (const raw of m[1].split(/[\s,]+/)) {
        const name = raw.replace(/['"`]/g, '').trim()
        if (!name || /[${}()]/.test(name)) continue
        if (!/^-?[_a-zA-Z][\w-]*$/.test(name)) continue
        if (!used.has(name)) used.set(name, new Set())
        used.get(name).add(f)
      }
    }
  }
}

const missing = [...used.entries()].filter(([c]) => !defined.has(c)).sort()
const prefixes = new Map()
for (const [c, fs_] of used) {
  const p = c.split('-')[0]
  if (!prefixes.has(p)) prefixes.set(p, { count: 0, files: new Set(), defined: 0 })
  const e = prefixes.get(p)
  e.count++
  fs_.forEach(f => e.files.add(f))
  if (defined.has(c)) e.defined++
}

console.log(`stylesheet defines ${defined.size} class names; the UI modules use ${used.size}\n`)
console.log('prefix    used  styled  modules')
for (const [p, e] of [...prefixes.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)) {
  console.log(`  ${p.padEnd(8)} ${String(e.count).padStart(4)}  ${String(e.defined).padStart(6)}  ${[...e.files].join(' ')}`)
}

if (missing.length) {
  console.log(`\nCLASSES USED BUT NEVER STYLED (${missing.length}):`)
  for (const [c, f] of missing.slice(0, 60)) console.log(`  .${c.padEnd(30)} ${[...f].join(' ')}`)
  if (missing.length > 60) console.log(`  … ${missing.length - 60} more`)
  process.exit(1)
}
console.log('\nEvery class the UI emits is styled.')
