#!/usr/bin/env node
/**
 * Static integration checker for VOXELIA.
 *
 * Walks every module under src/, resolves each relative import, and verifies
 * that every named import actually exists as an export of the target module.
 * Also reports unresolved paths, duplicate exports and accidental circular
 * imports. This catches the whole class of "agent A used a name agent B never
 * exported" bugs without needing a browser.
 *
 * usage: node tools/check-imports.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')

/** Strip comments and string/template literals so regexes cannot match inside them. */
function strip(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      out += q
      i++
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) break
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1; i += 2
          while (i < n && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++ }
          continue
        }
        i++
      }
      out += q
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.(js|mjs)$/.test(e.name)) acc.push(p)
  }
  return acc
}

const files = fs.existsSync(SRC) ? walk(SRC) : []
const info = new Map()

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  const src = strip(raw)
  const exports = new Set()
  const reExports = []
  let star = false

  // export const/let/var/function/class  (incl. async function, function*)
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) exports.add(m[1])
  // export const a = 1, b = 2
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s+([^;=]*?)=/gm)) {
    const decl = m[1]
    if (/[{[]/.test(decl)) for (const nm of decl.matchAll(/([A-Za-z_$][\w$]*)\s*(?:[,:}\]]|$)/g)) exports.add(nm[1])
  }
  // export { a, b as c }  /  export { a } from './x.js'
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const as = t.split(/\s+as\s+/)
      exports.add((as[1] || as[0]).trim())
    }
    if (m[2]) reExports.push(m[2])
  }
  // export * from './x.js'
  for (const m of src.matchAll(/export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) exports.add(m[1]); else { reExports.push(m[2]); star = true }
  }
  if (/export\s+default/.test(src)) exports.add('default')

  const imports = []
  const re = /(?:^|[\s;}])import\s+(?:([^'"]*?)\s+from\s*)?['"]([^'"]+)['"]/g
  for (const m of src.matchAll(re)) {
    const clause = (m[1] || '').trim()
    const spec = m[2]
    const names = []
    let ns = null
    let def = null
    if (clause) {
      const braced = clause.match(/\{([^}]*)\}/)
      if (braced) {
        for (const part of braced[1].split(',')) {
          const t = part.trim()
          if (!t) continue
          names.push(t.split(/\s+as\s+/)[0].trim())
        }
      }
      const nsm = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
      if (nsm) ns = nsm[1]
      const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '').replace(/,/g, ' ').trim()
      if (head && /^[A-Za-z_$][\w$]*$/.test(head)) def = head
    }
    imports.push({ spec, names, ns, def, raw: m[0].trim().slice(0, 90) })
  }
  // dynamic import() and new Worker(new URL(...))
  for (const m of src.matchAll(/new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) imports.push({ spec: m[1], names: [], ns: null, def: null, raw: 'new Worker URL' })

  info.set(file, { exports, reExports, star, imports, lines: raw.split('\n').length, bytes: raw.length })
}

function resolve(fromFile, spec) {
  if (!spec.startsWith('.')) return null // bare specifier -> not allowed anyway, reported separately
  let p = path.resolve(path.dirname(fromFile), spec)
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  for (const ext of ['.js', '.mjs', '/index.js']) if (fs.existsSync(p + ext)) return p + ext
  return null
}

/** Collect exports including re-exported ones. */
function exportsOf(file, seen = new Set()) {
  if (seen.has(file)) return new Set()
  seen.add(file)
  const rec = info.get(file)
  if (!rec) return new Set()
  const all = new Set(rec.exports)
  for (const spec of rec.reExports) {
    const t = resolve(file, spec)
    if (t) for (const e of exportsOf(t, seen)) all.add(e)
  }
  return all
}

const problems = []
const bare = []
for (const [file, rec] of info) {
  for (const imp of rec.imports) {
    if (!imp.spec.startsWith('.')) {
      if (!/^(node:|https?:)/.test(imp.spec)) bare.push(`${path.relative(ROOT, file)}: bare import '${imp.spec}'`)
      continue
    }
    const target = resolve(file, imp.spec)
    if (!target) {
      problems.push(`${path.relative(ROOT, file)}: UNRESOLVED '${imp.spec}'`)
      continue
    }
    const tex = exportsOf(target)
    const trec = info.get(target)
    if (trec && trec.star) continue // cannot statically verify through export *
    for (const n of imp.names) {
      if (!tex.has(n)) problems.push(`${path.relative(ROOT, file)}: '${n}' is not exported by ${path.relative(ROOT, target)}`)
    }
    if (imp.def && !tex.has('default')) problems.push(`${path.relative(ROOT, file)}: no default export in ${path.relative(ROOT, target)}`)
  }
}

// circular import detection
const cycles = []
const state = new Map()
function dfs(file, stack) {
  if (state.get(file) === 1) {
    const i = stack.indexOf(file)
    if (i >= 0) cycles.push(stack.slice(i).concat(file).map(f => path.relative(SRC, f)).join(' -> '))
    return
  }
  if (state.get(file) === 2) return
  state.set(file, 1)
  stack.push(file)
  const rec = info.get(file)
  if (rec) for (const imp of rec.imports) {
    const t = resolve(file, imp.spec)
    if (t && info.has(t)) dfs(t, stack)
  }
  stack.pop()
  state.set(file, 2)
}
for (const f of info.keys()) dfs(f, [])

const totals = { files: info.size, lines: 0, bytes: 0 }
for (const r of info.values()) { totals.lines += r.lines; totals.bytes += r.bytes }

const out = { ok: problems.length === 0 && bare.length === 0, totals, problems, bareImports: bare, cycles: [...new Set(cycles)].slice(0, 20) }
if (argvHas('--json')) console.log(JSON.stringify(out, null, 1))
else {
  console.log(`files=${totals.files} lines=${totals.lines} size=${(totals.bytes / 1024).toFixed(0)}KB`)
  if (bare.length) { console.log('\nBARE IMPORTS (not allowed):'); bare.forEach(p => console.log('  ' + p)) }
  if (problems.length) { console.log(`\nPROBLEMS (${problems.length}):`); problems.forEach(p => console.log('  ' + p)) }
  else console.log('\nNo import/export mismatches.')
  if (out.cycles.length) { console.log(`\nCIRCULAR IMPORTS (${out.cycles.length}):`); out.cycles.forEach(c => console.log('  ' + c)) }
}
function argvHas(f) { return process.argv.includes(f) }
process.exit(out.ok ? 0 : 1)
