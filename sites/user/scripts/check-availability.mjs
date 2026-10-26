#!/usr/bin/env node
/**
 * User learning site — availability notation linter.
 *
 * Enforces the fixed grammar of STYLE_GUIDE.md「可用性表記」(design:
 * docs/design/848-docs-structure-design.md §3.4 / §5). The site is one body
 * of text for two distribution lines — OrbitScore (the frozen VS Code
 * extension) and OrbitStudio (the native macOS app) — so the
 * notation that tells them apart must be greppable by one fixed anchor and
 * must never let an extension reader take OrbitStudio text as their own
 * instructions (owner ruling (20) / ledger P-13).
 *
 * Rules (the ID is printed with every finding; the native provisional-ledger
 * spec looks for AV-HOST-SCOPE in this file):
 *
 *   AV-HOST        frontmatter `host:` is present and is one of both | app |
 *                  ext | both+split. A split-section marker `<!-- host: ext -->`
 *                  / `<!-- host: app -->` sits on the line right after a
 *                  heading, and only in a `both+split` chapter.
 *   AV-SYNTAX      every `> **対応**:` (ja) / `> **Availability**:` (en) line is
 *                  one of the five fixed forms, uses its chapter's language,
 *                  and is followed by a blank line (a following text line would
 *                  be pulled into the blockquote). Near misses (full-width
 *                  colon, missing `>`) are errors, so a grep on the anchor
 *                  finds every line.
 *   AV-PLACE       an availability line directly follows a heading (or the
 *                  heading's split-section marker) — one line per feature.
 *   AV-UNRELEASED  `未リリース（…）` / `Unreleased (…)`. A warning normally (main
 *                  may carry unreleased features); an error with --release
 *                  (the release preflight).
 *   AV-I18N        a ja chapter and its en translation have the same `host`,
 *                  the same number of availability lines and of split-section
 *                  markers.
 *   AV-HOST-SCOPE  in a `both` or `both+split` chapter, a line that mentions
 *                  OrbitStudio is either a parallel line starting with
 *                  `- **OrbitStudio**:` or inside a section whose availability
 *                  line names OrbitStudio. Applies to every line, code blocks
 *                  and frontmatter included.
 *   AV-TERM        the lines are named OrbitScore and OrbitStudio (owner,
 *                  2026-10-26). Never call the extension "OrbitStudio（凍結版" /
 *                  "OrbitStudio (frozen" (the 2026-09-18 interim wording), and
 *                  never label a parallel line `- **拡張版**:` / `- **Extension**:`.
 *
 * Usage (from repo root or sites/user):
 *   node sites/user/scripts/check-availability.mjs             # ja + en
 *   node sites/user/scripts/check-availability.mjs --release   # AV-UNRELEASED is an error
 *   node sites/user/scripts/check-availability.mjs --root <dir> # lint another site root (tests)
 *
 * Exit code 1 when any error is found.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultSiteRoot = path.resolve(here, '..')

const argv = process.argv.slice(2)
const release = argv.includes('--release')
const rootIndex = argv.indexOf('--root')
const siteRoot = rootIndex === -1 ? defaultSiteRoot : path.resolve(argv[rootIndex + 1])

const HOST_VALUES = ['both', 'app', 'ext', 'both+split']
const SCOPED_HOSTS = new Set(['both', 'both+split'])

const V = String.raw`\d+\.\d+\.\d+`

/** The five fixed forms (STYLE_GUIDE.md「可用性表記」). Regex sources, anchored at both ends. */
const AVAILABILITY = {
  ja: {
    anchor: '> **対応**: ',
    forms: [
      String.raw`OrbitScore ${V} 以降 / OrbitStudio ${V} 以降`,
      String.raw`OrbitStudio ${V} 以降（OrbitScore には入りません）`,
      String.raw`OrbitScore ${V} 以降（OrbitStudio では ${V} から動作が変わります — 下記）`,
      String.raw`未リリース（OrbitStudio）— main にマージ済み・次のリリースから`,
      String.raw`未リリース（OrbitScore ${V}）— 凍結版の bug fix`,
    ],
    unreleased: '未リリース（',
  },
  en: {
    anchor: '> **Availability**: ',
    forms: [
      String.raw`OrbitScore ${V} and later / OrbitStudio ${V} and later`,
      String.raw`OrbitStudio ${V} and later \(not in OrbitScore\)`,
      String.raw`OrbitScore ${V} and later \(behaves differently in OrbitStudio from ${V} — see below\)`,
      String.raw`Unreleased \(OrbitStudio\) — merged to main, ships in the next release`,
      String.raw`Unreleased \(OrbitScore ${V}\) — bug fix for the frozen line`,
    ],
    unreleased: 'Unreleased (',
  },
}
for (const lang of Object.values(AVAILABILITY)) {
  lang.formRes = lang.forms.map((f) => new RegExp(`^${f}$`))
}

/** Anything that looks like an availability anchor, including near misses. */
const ANCHOR_LIKE_RE = /\*\*(対応|Availability)\*\*\s*[:：]/
const HEADING_RE = /^(#{1,6})\s+\S/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const HOST_MARKER_LIKE_RE = /^<!--\s*host\s*:/
const HOST_MARKER_RE = /^<!-- host: (ext|app) -->$/
const PARALLEL_ORBITSTUDIO_RE = /^\s*- \*\*OrbitStudio\*\*:/
const ORBITSTUDIO_RE = /orbitstudio/i
/**
 * Identifiers that still say "orbitstudio" but name the VS Code extension's
 * test harness (CLAUDE.md, 2026-09-18: kept as they are until the harness is
 * made target-neutral — design 848 §10.2). They carry no information about
 * OrbitStudio the app, so AV-HOST-SCOPE does not count them.
 */
const LEGACY_EXTENSION_IDENTIFIERS = ['orbitstudio-mcp-gated.spec.ts', 'ORBIT_GATED_ORBITSTUDIO']
const mentionsOrbitStudio = (line) =>
  ORBITSTUDIO_RE.test(LEGACY_EXTENSION_IDENTIFIERS.reduce((t, id) => t.split(id).join(''), line))
const FROZEN_TERM_RE = /OrbitStudio（凍結版|OrbitStudio \(frozen/
/** The earlier labels for the extension line; the line is called OrbitScore now. */
const OLD_LABEL_RE = /^\s*- \*\*(拡張版|Extension)\*\*:/

const SKIP_DIRS = new Set(['node_modules', '.vitepress', 'public', 'scripts'])
const SKIP_FILES = new Set(['STYLE_GUIDE.md', 'README.md'])

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out)
    } else if (entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const errors = []
const warnings = []
const report = (list, rel, line, rule, message) => list.push({ rel, line, rule, message })

/** Parse one chapter into the facts the rules need. */
function readChapter(full) {
  const rel = path.relative(siteRoot, full).split(path.sep).join('/')
  const lang = rel.startsWith('en/') ? 'en' : 'ja'
  const lines = fs.readFileSync(full, 'utf8').split('\n')

  let fmEnd = -1
  if (lines[0] === '---') {
    fmEnd = lines.indexOf('---', 1)
  }
  const hosts = []
  for (let i = 1; i < fmEnd; i++) {
    const m = /^host:\s*(.*?)\s*$/.exec(lines[i])
    if (m) hosts.push({ value: m[1], line: i + 1 })
  }

  // Classify body lines once; code-fence contents are text, not structure.
  const kinds = new Array(lines.length).fill('frontmatter')
  let fence = null
  for (let i = fmEnd + 1; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE_RE.exec(line)
    if (fence) {
      kinds[i] = 'code'
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) {
        fence = null
      }
      continue
    }
    if (f) {
      fence = f[1]
      kinds[i] = 'code'
    } else if (HEADING_RE.test(line)) kinds[i] = 'heading'
    else if (line.trim() === '') kinds[i] = 'blank'
    else if (HOST_MARKER_LIKE_RE.test(line)) kinds[i] = 'marker'
    else if (ANCHOR_LIKE_RE.test(line)) kinds[i] = 'anchor'
    else kinds[i] = 'text'
  }
  return { rel, lang, lines, kinds, hosts, hasFrontmatter: fmEnd > 0 }
}

/** The line right after a heading may hold its split-section marker; skip it. */
function firstBodyLineAfterHeading(ch, i) {
  let j = i + 1
  if (ch.kinds[j] === 'marker') j++
  while (j < ch.lines.length && ch.kinds[j] === 'blank') j++
  return j
}

function checkHost(ch) {
  if (!ch.hasFrontmatter || ch.hosts.length === 0) {
    report(
      errors,
      ch.rel,
      1,
      'AV-HOST',
      `frontmatter has no \`host:\` (${HOST_VALUES.join(' | ')})`,
    )
    return null
  }
  if (ch.hosts.length > 1) {
    report(errors, ch.rel, ch.hosts[1].line, 'AV-HOST', '`host:` appears more than once')
  }
  const { value, line } = ch.hosts[0]
  if (!HOST_VALUES.includes(value)) {
    report(
      errors,
      ch.rel,
      line,
      'AV-HOST',
      `\`host: ${value}\` is not one of ${HOST_VALUES.join(' | ')}`,
    )
    return null
  }
  return value
}

function checkMarkers(ch, host) {
  let count = 0
  ch.kinds.forEach((kind, i) => {
    if (kind !== 'marker') return
    count++
    if (!HOST_MARKER_RE.test(ch.lines[i])) {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-HOST',
        'split-section marker must be exactly `<!-- host: ext -->` or `<!-- host: app -->`',
      )
    } else if (host !== 'both+split') {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-HOST',
        `split-section marker in a \`host: ${host ?? '(none)'}\` chapter (only \`both+split\` has split sections)`,
      )
    }
    if (ch.kinds[i - 1] !== 'heading') {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-HOST',
        'split-section marker must be on the line right after a heading',
      )
    }
  })
  return count
}

function checkAvailabilityLines(ch) {
  const grammar = AVAILABILITY[ch.lang]
  const other = AVAILABILITY[ch.lang === 'ja' ? 'en' : 'ja']
  let count = 0
  ch.kinds.forEach((kind, i) => {
    if (kind !== 'anchor') return
    count++
    const line = ch.lines[i].replace(/\s+$/, '')
    if (line.startsWith(other.anchor)) {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-SYNTAX',
        `this ${ch.lang} chapter uses \`${other.anchor.trim()}\` — use \`${grammar.anchor.trim()}\``,
      )
      return
    }
    if (!line.startsWith(grammar.anchor)) {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-SYNTAX',
        `the anchor must be exactly \`${grammar.anchor.trim()}\` at the start of the line (half-width colon, then one space)`,
      )
      return
    }
    const rest = line.slice(grammar.anchor.length)
    if (!grammar.formRes.some((re) => re.test(rest))) {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-SYNTAX',
        `not one of the five fixed forms (STYLE_GUIDE.md「可用性表記」): ${rest}`,
      )
    }
    if (i + 1 < ch.lines.length && ch.kinds[i + 1] !== 'blank') {
      report(
        errors,
        ch.rel,
        i + 2,
        'AV-SYNTAX',
        'the availability line must be followed by a blank line',
      )
    }
    let prev = i - 1
    while (prev >= 0 && ch.kinds[prev] === 'blank') prev--
    const underHeading =
      ch.kinds[prev] === 'heading' ||
      (ch.kinds[prev] === 'marker' && ch.kinds[prev - 1] === 'heading')
    if (!underHeading) {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-PLACE',
        'an availability line goes right under the heading of its feature (one line per feature)',
      )
    }
    if (rest.startsWith(grammar.unreleased)) {
      report(
        release ? errors : warnings,
        ch.rel,
        i + 1,
        'AV-UNRELEASED',
        release
          ? 'unreleased marker at release time — replace it with the version'
          : 'unreleased marker (fine on main; the release preflight turns this into an error)',
      )
    }
  })
  return count
}

function checkHostScope(ch, host) {
  if (!SCOPED_HOSTS.has(host)) return
  const stack = [] // { level, scoped }
  ch.lines.forEach((line, i) => {
    if (ch.kinds[i] === 'heading') {
      const level = HEADING_RE.exec(line)[1].length
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      const j = firstBodyLineAfterHeading(ch, i)
      const scoped = ch.kinds[j] === 'anchor' && ORBITSTUDIO_RE.test(ch.lines[j])
      stack.push({ level, scoped })
    }
    if (!mentionsOrbitStudio(line)) return
    if (PARALLEL_ORBITSTUDIO_RE.test(line)) return
    if (stack.some((s) => s.scoped)) return
    report(
      errors,
      ch.rel,
      i + 1,
      'AV-HOST-SCOPE',
      `OrbitStudio is mentioned in a \`host: ${host}\` chapter outside a \`- **OrbitStudio**:\` parallel line and outside a section whose availability line names OrbitStudio — an extension reader would take it as their own instructions`,
    )
  })
}

function checkTerms(ch) {
  ch.lines.forEach((line, i) => {
    if (FROZEN_TERM_RE.test(line)) {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-TERM',
        'OrbitStudio is the native app; the frozen VS Code extension is OrbitScore',
      )
    }
    if (OLD_LABEL_RE.test(line)) {
      report(errors, ch.rel, i + 1, 'AV-TERM', 'label the extension line `- **OrbitScore**:`')
    }
  })
}

const chapters = walk(siteRoot, []).sort().map(readChapter)
const facts = new Map()
for (const ch of chapters) {
  const host = checkHost(ch)
  const markers = checkMarkers(ch, host)
  const anchors = checkAvailabilityLines(ch)
  checkHostScope(ch, host)
  checkTerms(ch)
  facts.set(ch.rel, { host: ch.hosts[0]?.value ?? null, anchors, markers })
}

for (const [rel, ja] of facts) {
  if (rel.startsWith('en/')) continue
  const en = facts.get(`en/${rel}`)
  if (!en) continue
  const pairs = [
    ['host', ja.host, en.host],
    ['availability lines', ja.anchors, en.anchors],
    ['split-section markers', ja.markers, en.markers],
  ]
  for (const [what, a, b] of pairs) {
    if (a !== b)
      report(
        errors,
        `en/${rel}`,
        1,
        'AV-I18N',
        `${what}: ja ${a} / en ${b} — the translation must match the ja chapter`,
      )
  }
}

const byPlace = (a, b) => a.rel.localeCompare(b.rel) || a.line - b.line
const print = (tag, f) => console.log(`${tag} ${f.rel}:${f.line}  [${f.rule}] ${f.message}`)
warnings.sort(byPlace).forEach((f) => print('WARN', f))
errors.sort(byPlace).forEach((f) => print('FAIL', f))
const ja = chapters.filter((c) => c.lang === 'ja').length
console.log(
  `\n${chapters.length} chapter(s) checked (ja ${ja} / en ${chapters.length - ja}), ` +
    `${errors.length} error(s), ${warnings.length} warning(s)${release ? ' [--release]' : ''}`,
)
process.exit(errors.length > 0 ? 1 : 0)
