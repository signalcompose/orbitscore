/**
 * Relocates documentation citation headers by matching each quoted block's contents against
 * split source files; this is needed because `--fix` can update line numbers but not file paths.
 */
import fs from 'node:fs'
import path from 'node:path'
const HEADER_RE = /^(\s*(?:\/\/|#|--|;)\s*)([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]+):(\d+)-(\d+)\b(.*)$/
const oldPath = process.argv[2]                 // 例: rust/.../output.rs
const candDir = process.argv[3]                 // 例: rust/.../output
const cands = fs.readdirSync(candDir).map((f) => path.join(candDir, f))
             .concat([oldPath])
const srcs = new Map(cands.map((p) => [p, fs.readFileSync(p, 'utf8').split('\n')]))
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!['node_modules', '.vitepress', 'dist'].includes(e.name)) walk(path.join(d, e.name), out) }
    else if (e.name.endsWith('.md')) out.push(path.join(d, e.name))
  }
  return out
}
let fixed = 0, unresolved = []
for (const md of walk('sites/dev')) {
  const lines = fs.readFileSync(md, 'utf8').split('\n')
  let out = [], i = 0, dirty = false
  while (i < lines.length) {
    const m = HEADER_RE.exec(lines[i])
    if (!m || m[2] !== oldPath) { out.push(lines[i++]); continue }
    const [, prefix, , a, b, rest] = m
    const span = Number(b) - Number(a) + 1
    let j = i + 1
    while (j < lines.length && !lines[j].startsWith('```')) j++
    const body = lines.slice(i + 1, j)
    const first = body[0]
    // 先頭行が一意でない場合に備え、先頭から最大 5 行の連続一致で照合する。
    const probe = body.slice(0, Math.min(5, body.length))
    let hit = null
    for (const [p, src] of srcs) {
      const found = []
      for (let k = 0; k + probe.length <= src.length; k++) {
        let ok = true
        // 🔴 分割で `pub(super) ` / `pub ` が前置されうるので、可視性修飾を剥がして比べる。
        const strip = (s) => s.replace(/^(\s*)(?:pub\(super\)\s+|pub\(crate\)\s+|pub\s+)/, '$1')
        for (let t = 0; t < probe.length; t++) if (strip(src[k + t]) !== strip(probe[t])) { ok = false; break }
        if (ok) found.push(k + 1)
      }
      if (found.length === 1) { hit = [p, found[0]]; break }
    }
    if (!hit) { unresolved.push(`${md}: ${a}-${b}`); out.push(lines[i++]); continue }
    const [p, start] = hit
    const fresh = srcs.get(p).slice(start - 1, start - 1 + span)
    out.push(`${prefix}${p}:${start}-${start + span - 1}${rest}`, ...fresh)
    dirty = true; fixed++
    i = j
  }
  if (dirty) fs.writeFileSync(md, out.join('\n'))
}
console.log(`relocated ${fixed}; unresolved ${unresolved.length}`)
unresolved.slice(0, 8).forEach((u) => console.log('  ?', u))
