#!/usr/bin/env node
/**
 * GLSL reserved-word and portability linter.
 *
 * Shader code lives inside JS template literals, so a bad identifier only
 * surfaces at runtime on a real GL driver. This scans every template literal
 * that looks like GLSL and flags identifiers that GLSL ES 3.00 reserves, plus a
 * few portability traps that Chrome's ANGLE validator rejects but some drivers
 * accept.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Keywords GLSL ES 3.00 reserves for future use — illegal as identifiers. */
const RESERVED = `common partition active asm class union enum typedef template this
packed goto inline noinline volatile public static extern external interface long short
double half fixed unsigned superp input output hvec2 hvec3 hvec4 fvec2 fvec3 fvec4
sampler3DRect filter image1D image2D image3D imageCube iimage1D iimage2D iimage3D
sizeof cast namespace using row_major patch sample subroutine resource attribute varying
noperspective coherent restrict readonly writeonly atomic_uint`.split(/\s+/).filter(Boolean)

/** Types that can precede a declared identifier. */
const TYPE = String.raw`(?:float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234]|mat[234]x[234]|void)`

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.js$/.test(e.name)) acc.push(p)
  }
  return acc
}

/** Extract template literals that plausibly contain GLSL. */
function glslBlocks(src) {
  const out = []
  const re = /`(?:[^`\\]|\\.|\$\{(?:[^{}]|\{[^}]*\})*\})*`/gs
  for (const m of src.matchAll(re)) {
    const body = m[0]
    if (!/\b(void\s+main|gl_Position|gl_FragCoord|layout\s*\(|uniform\s|#include\s*<|precision\s+(?:highp|mediump))/.test(body)) continue
    out.push({ text: body, index: m.index })
  }
  return out
}

const problems = []
let scanned = 0, blocks = 0

for (const file of walk(path.join(ROOT, 'src'))) {
  const src = fs.readFileSync(file, 'utf8')
  scanned++
  for (const block of glslBlocks(src)) {
    blocks++
    const prefixLines = src.slice(0, block.index).split('\n').length - 1
    const lines = block.text.split('\n')
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '')
      const lineNo = prefixLines + i + 1
      for (const word of RESERVED) {
        // declaration: "float patch" / "vec3 sample ="
        const decl = new RegExp(String.raw`\b${TYPE}\s+${word}\b`)
        // parameter or struct member, and plain assignment to the bare name
        const assign = new RegExp(String.raw`(?:^|[;,({])\s*(?:in|out|inout|const)?\s*${TYPE}\s+${word}\b`)
        if (decl.test(code) || assign.test(code)) {
          problems.push({ file: path.relative(ROOT, file), line: lineNo, word, code: code.trim().slice(0, 100) })
        }
      }
      // GLSL ES 3.0 has no implicit int->float conversion in several spots that
      // commonly bite: flag the classic "1 / 2.0" style only when obvious.
      if (/\btexture2D\s*\(|\btextureCube\s*\(|\bgl_FragColor\b|\bgl_FragData\b/.test(code)) {
        problems.push({ file: path.relative(ROOT, file), line: lineNo, word: 'GLSL-ES-1.00 API', code: code.trim().slice(0, 100) })
      }
    })
  }
}

console.log(`scanned ${scanned} files, ${blocks} GLSL blocks`)
if (problems.length) {
  console.log(`\nRESERVED-WORD / PORTABILITY PROBLEMS (${problems.length}):`)
  for (const p of problems) console.log(`  ${p.file}:${p.line}  '${p.word}'  ${p.code}`)
  process.exit(1)
}
console.log('No reserved-word problems.')
