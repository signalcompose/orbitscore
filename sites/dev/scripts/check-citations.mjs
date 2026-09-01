#!/usr/bin/env node
/**
 * Dev learning site — verbatim citation checker.
 *
 * STYLE_GUIDE.md §5-bis requires every fenced code block whose first line is
 *   // <file>:<start>-<end>
 * (or `# <file>:<start>-<end>` for shell / TOML / YAML) to match the referenced
 * line range character for character. Omissions must be marked with a bare
 * `// ...` (or `# ...`) line. This script enforces that mechanically so that
 * drift between the site and the code (the SoT) is red instead of silent.
 *
 * Usage (from repo root or sites/dev):
 *   node sites/dev/scripts/check-citations.mjs            # check ja + en
 *   node sites/dev/scripts/check-citations.mjs --verbose  # list every OK block too
 *   node sites/dev/scripts/check-citations.mjs --fix      # re-anchor headers whose snippet moved (line shift only)
 *   node sites/dev/scripts/check-citations.mjs sites/dev/rust-engine/index.md
 *
 * Exit code 1 when any citation fails.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const siteRoot = path.resolve(here, '..')
const repoRoot = path.resolve(siteRoot, '..', '..')

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const fix = argv.includes('--fix')
const explicit = argv.filter((a) => !a.startsWith('--'))

const SKIP_DIRS = new Set(['node_modules', '.vitepress', '.plan', '.audit', 'public', 'scripts'])

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
    } else if (
      entry.name.endsWith('.md') &&
      !entry.name.startsWith('.') &&
      !['STYLE_GUIDE.md', 'README.md'].includes(entry.name)
    ) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

const HEADER_RE = /^\s*(?:\/\/|#|--|;)\s*([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]+):(\d+)-(\d+)\b/
const OMISSION_RE = /^\s*(?:\/\/|#|--|;)\s*\.\.\.\s*$/
const SEARCH_ROOTS = [
  'packages',
  'rust',
  'tests',
  'scripts',
  'sites',
  'docs',
  'examples',
  '.github',
]

const fileIndex = new Map() // basename -> [relative paths]
function indexRepo() {
  const skip = new Set(['node_modules', 'dist', 'target', '.git', 'out', '.vitepress'])
  const visit = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue
        visit(path.join(dir, e.name))
      } else {
        const rel = path.relative(repoRoot, path.join(dir, e.name))
        const list = fileIndex.get(e.name) ?? []
        list.push(rel)
        fileIndex.set(e.name, list)
      }
    }
  }
  for (const root of SEARCH_ROOTS) visit(path.join(repoRoot, root))
  for (const top of fs.readdirSync(repoRoot)) {
    if (fs.statSync(path.join(repoRoot, top)).isFile()) fileIndex.set(top, [top])
  }
}

function resolveSource(ref) {
  const direct = path.join(repoRoot, ref)
  if (fs.existsSync(direct)) return ref
  const candidates = (fileIndex.get(path.basename(ref)) ?? []).filter((rel) => rel.endsWith(ref))
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) return { ambiguous: candidates }
  return undefined
}

const sourceCache = new Map()
function readSource(rel) {
  if (!sourceCache.has(rel)) {
    sourceCache.set(rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8').split('\n'))
  }
  return sourceCache.get(rel)
}

/**
 * Match snippet lines (with `// ...` wildcards) against source[start-1 .. end-1].
 * Returns null on success, or a human-readable reason.
 */
function matchSnippet(snippet, source, start, end) {
  if (start < 1 || end > source.length || start > end) {
    return `range ${start}-${end} is outside the file (${source.length} lines)`
  }
  const target = source.slice(start - 1, end)
  const segments = []
  let cur = []
  let leadingWildcard = false
  let trailingWildcard = false
  for (const line of snippet) {
    if (OMISSION_RE.test(line)) {
      if (cur.length) segments.push(cur)
      else if (!segments.length) leadingWildcard = true
      cur = []
      trailingWildcard = true
    } else {
      cur.push(line)
      trailingWildcard = false
    }
  }
  if (cur.length) segments.push(cur)
  if (!segments.length) return 'snippet has no content lines'

  const findFrom = (seg, from) => {
    for (let i = from; i + seg.length <= target.length; i++) {
      let ok = true
      for (let j = 0; j < seg.length; j++) {
        if (target[i + j] !== seg[j]) {
          ok = false
          break
        }
      }
      if (ok) return i
    }
    return -1
  }

  let pos = 0
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]
    const at = findFrom(seg, pos)
    if (at < 0) {
      // Locate first differing line for a helpful message.
      const probe = s === 0 && !leadingWildcard ? 0 : pos
      for (let j = 0; j < seg.length; j++) {
        const actual = target[probe + j]
        if (actual !== seg[j]) {
          return (
            `line ${start + probe + j}: expected (snippet) ${JSON.stringify(seg[j])}` +
            ` / actual ${JSON.stringify(actual ?? '<EOF>')}`
          )
        }
      }
      return `segment ${s + 1} not found after line ${start + pos}`
    }
    if (s === 0 && !leadingWildcard && at !== 0) {
      return `snippet starts at line ${start + at}, header says ${start}`
    }
    if (s > 0 && at === pos && !leadingWildcard) {
      // A wildcard that omits zero lines is fine; nothing to do.
    }
    pos = at + seg.length
  }
  if (!trailingWildcard && pos !== target.length) {
    return `snippet ends at line ${start + pos - 1}, header says ${end} (missing trailing "// ..."?)`
  }
  return null
}

/**
 * --fix helper: try to find the snippet anywhere in `source` (all wildcard
 * segments in order, first segment anchored). Returns [start, end] (1-based)
 * of the occurrence closest to `preferStart`, or null.
 */
function relocateSnippet(snippet, source, preferStart) {
  const segments = []
  let cur = []
  let trailingWildcard = false
  for (const line of snippet) {
    if (OMISSION_RE.test(line)) {
      if (cur.length) segments.push(cur)
      cur = []
      trailingWildcard = true
    } else {
      cur.push(line)
      trailingWildcard = false
    }
  }
  if (cur.length) segments.push(cur)
  if (!segments.length) return null
  const first = segments[0]
  const hits = []
  for (let i = 0; i + first.length <= source.length; i++) {
    let ok = true
    for (let j = 0; j < first.length; j++) {
      if (source[i + j] !== first[j]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    // verify remaining segments in order
    let pos = i + first.length
    let good = true
    for (let s = 1; s < segments.length; s++) {
      const seg = segments[s]
      let at = -1
      for (let k = pos; k + seg.length <= source.length; k++) {
        let m = true
        for (let j = 0; j < seg.length; j++) {
          if (source[k + j] !== seg[j]) {
            m = false
            break
          }
        }
        if (m) {
          at = k
          break
        }
      }
      if (at < 0) {
        good = false
        break
      }
      pos = at + seg.length
    }
    if (!good) continue
    // end line: if trailing wildcard we cannot know; keep old length heuristic (end = pos)
    hits.push([i + 1, pos, trailingWildcard])
  }
  if (!hits.length) return null
  hits.sort((a, b) => Math.abs(a[0] - preferStart) - Math.abs(b[0] - preferStart))
  return hits[0]
}

function checkFile(mdPath) {
  const text = fs.readFileSync(mdPath, 'utf8')
  const lines = text.split('\n')
  const results = []
  const fixed = []
  let i = 0
  while (i < lines.length) {
    const fence = lines[i].match(/^(\s*)(`{3,}|~{3,})/)
    if (!fence) {
      i++
      continue
    }
    const indent = fence[1]
    const marker = fence[2]
    const startLine = i
    const body = []
    i++
    while (i < lines.length && !lines[i].startsWith(indent + marker)) {
      body.push(indent ? lines[i].replace(new RegExp(`^${indent}`), '') : lines[i])
      i++
    }
    i++
    if (!body.length) continue
    const header = body[0].match(HEADER_RE)
    if (!header) continue
    const [, ref, s, e] = header
    const start = Number(s)
    const end = Number(e)
    const resolved = resolveSource(ref)
    const where = `${path.relative(repoRoot, mdPath)}:${startLine + 1}`
    const headerLineIdx = startLine + 1
    if (!resolved) {
      results.push({ where, ref: `${ref}:${s}-${e}`, error: 'source file not found' })
      continue
    }
    const candidates = typeof resolved === 'object' ? resolved.ambiguous : [resolved]
    let reason
    if (candidates.length === 1) {
      reason = matchSnippet(body.slice(1), readSource(resolved), start, end)
    } else {
      reason = `ambiguous basename, candidates: ${candidates.join(', ')}`
    }
    if (reason && fix) {
      const found = []
      for (const cand of candidates) {
        const hit = relocateSnippet(body.slice(1), readSource(cand), start)
        if (hit) found.push([cand, hit])
      }
      if (found.length === 1) {
        const [cand, [ns, ne, trailing]] = found[0]
        // With a trailing wildcard the true end is unknown; keep the old span length
        // if it still fits, otherwise use the last matched line.
        let newEnd = ne
        if (trailing) {
          const oldSpan = end - start
          newEnd = ns + oldSpan <= readSource(cand).length ? ns + oldSpan : ne
        }
        const oldHeader = lines[headerLineIdx]
        const newHeader = oldHeader.replace(HEADER_RE, (m, r) =>
          m.replace(`${r}:${s}-${e}`, `${cand}:${ns}-${newEnd}`),
        )
        if (newHeader !== oldHeader) {
          lines[headerLineIdx] = newHeader
          fixed.push({ where, from: `${ref}:${s}-${e}`, to: `${cand}:${ns}-${newEnd}` })
          reason = matchSnippet(body.slice(1), readSource(cand), ns, newEnd)
          results.push({ where, ref: `${cand}:${ns}-${newEnd}`, error: reason })
          continue
        }
      } else if (found.length > 1) {
        reason += ` [fix: matches in ${found.map((f) => f[0]).join(', ')}]`
      }
    }
    results.push({
      where,
      ref: `${candidates.length === 1 ? resolved : ref}:${s}-${e}`,
      error: reason,
    })
  }
  if (fix && fixed.length) fs.writeFileSync(mdPath, lines.join('\n'))
  allFixed.push(...fixed)
  return results
}

indexRepo()
const targets = explicit.length
  ? explicit.map((p) => path.resolve(process.cwd(), p))
  : walk(siteRoot, []).sort()

let ok = 0
let bad = 0
const failures = []
const allFixed = []
for (const md of targets) {
  for (const r of checkFile(md)) {
    if (r.error) {
      bad++
      failures.push(r)
    } else {
      ok++
      if (verbose) console.log(`OK   ${r.where}  ${r.ref}`)
    }
  }
}

for (const f of allFixed) {
  console.log(`FIXED ${f.where}  ${f.from} -> ${f.to}`)
}
for (const f of failures) {
  console.log(`FAIL ${f.where}  ${f.ref}\n     ${f.error}`)
}
console.log(`\n${ok} citation(s) verified, ${bad} failed, ${targets.length} file(s) scanned`)
process.exit(bad ? 1 : 0)
