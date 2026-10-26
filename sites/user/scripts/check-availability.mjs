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
 *                  be pulled into the blockquote). Near misses (see
 *                  isAnchorCandidate: list items, nested quotes, indentation,
 *                  a colon inside the bold, a missing colon, the bold label in
 *                  mid-line, any case) are errors, so a grep on the anchor
 *                  finds every line. So are an unterminated code fence, a BOM,
 *                  CR line endings and a chapter or directory that cannot be read.
 *   AV-PLACE       an availability line directly follows a heading (or the
 *                  heading's split-section marker) — one line per feature.
 *   AV-UNRELEASED  `未リリース（…）` / `Unreleased (…)` on any line outside code
 *                  (frontmatter and prose too — the lint is the only release
 *                  gate for it). A warning normally (main may carry unreleased
 *                  features); an error with --release (the release preflight).
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
 * Exit code 1 when any lint error is found; exit code 2 for invalid usage
 * (bad arguments, or a --root that is not a readable directory).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultSiteRoot = path.resolve(here, '..')

const usage = 'Usage: check-availability.mjs [--release] [--root <dir>]'

function parseArgs(argv) {
  let release = false
  let root = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--release') {
      if (release) throw new Error('`--release` was specified more than once')
      release = true
    } else if (arg === '--root') {
      if (root !== null) throw new Error('`--root` was specified more than once')
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--'))
        throw new Error('`--root` requires a directory')
      root = argv[++i]
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return { release, siteRoot: root === null ? defaultSiteRoot : path.resolve(root) }
}

let options = null
let argumentError = null
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  argumentError = error.message
}
const release = options?.release ?? false
const siteRoot = options?.siteRoot ?? defaultSiteRoot

const HOST_VALUES = ['both', 'app', 'ext', 'both+split']
const SCOPED_HOSTS = new Set(['both', 'both+split'])

/**
 * D-① only: chapters that predate the `host:` key. They get it in the next PR
 * (docs PR ②), which deletes this list. Shrink-only: an entry whose chapter
 * already has `host:` (or no longer exists) is an error, and a chapter that is
 * not listed must carry `host:`. Applied to the real site only, not to --root.
 */
const HOST_MISSING_BASELINE =
  siteRoot === defaultSiteRoot
    ? [
        'basics/audio-manipulation.md',
        'basics/live-coding.md',
        'basics/multiple-sequences.md',
        'basics/patterns.md',
        'basics/polyrhythm.md',
        'en/basics/audio-manipulation.md',
        'en/basics/live-coding.md',
        'en/basics/multiple-sequences.md',
        'en/basics/patterns.md',
        'en/basics/polyrhythm.md',
        'en/getting-started/engine-settings.md',
        'en/getting-started/first-sound.md',
        'en/getting-started/installation.md',
        'en/index.md',
        'en/midi/index.md',
        'en/midi/link-audio.md',
        'en/midi/mode-scale.md',
        'en/midi/pitch-dsl.md',
        'en/midi/quantize.md',
        'en/midi/voicing.md',
        'en/mixing/effects.md',
        'en/mixing/routing.md',
        'en/plugins/instrument.md',
        'en/projects/import.md',
        'en/reference/methods.md',
        'en/troubleshooting.md',
        'getting-started/engine-settings.md',
        'getting-started/first-sound.md',
        'getting-started/installation.md',
        'index.md',
        'midi/index.md',
        'midi/link-audio.md',
        'midi/mode-scale.md',
        'midi/pitch-dsl.md',
        'midi/quantize.md',
        'midi/voicing.md',
        'mixing/effects.md',
        'mixing/routing.md',
        'plugins/instrument.md',
        'projects/import.md',
        'reference/methods.md',
        'troubleshooting.md',
      ]
    : []

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

/**
 * Availability-line candidates, near misses included. Only the exact anchor at
 * column 0 followed by one of the five forms is valid; every other candidate is
 * an AV-SYNTAX error, so a grep on the anchor finds every line. A line is a
 * candidate when
 *   (a) after its container prefix (indentation, any number of `>`, list
 *       markers) it starts with the label — emphasised or not — and a colon
 *       (`**対応**:`, `**対応:**`, `対応:`, `- **Availability**:`, `>> *対応*:`),
 *   (b) it is a blockquote whose emphasised label is followed by a space or the
 *       end of the line (`> **対応** OrbitScore …` — the colon is missing), or
 *   (c) anywhere in the line, the bold label carries a colon inside or right
 *       after it (`本文 **対応**: …`).
 * Prose that merely contains the word is not a candidate: `入力 -> 対応表`,
 * `<b>対応</b>`, `**対応**していない`, `Availability of plugins varies.`
 */
const LABEL = String.raw`(?:対応|availability)`
const CONTAINER = String.raw`^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)*`
const LEADING_LABEL_COLON_RE = new RegExp(
  String.raw`${CONTAINER}(?:[*_]{1,2}\s*)?${LABEL}\s*(?:[*_]{1,2}\s*)?[:：]`,
  'i',
)
const QUOTED_LABEL_NO_COLON_RE = new RegExp(
  String.raw`^\s*(?:>\s*)+(?:[-*+]\s+|\d+[.)]\s+)*[*_]{1,2}\s*${LABEL}\s*[*_]{1,2}(?:\s|$)`,
  'i',
)
const BOLD_LABEL_COLON_RE = new RegExp(
  String.raw`\*\*\s*${LABEL}\s*(?:[:：]\s*\*\*|\*\*\s*[:：])`,
  'i',
)
const isAnchorCandidate = (line) =>
  LEADING_LABEL_COLON_RE.test(line) ||
  QUOTED_LABEL_NO_COLON_RE.test(line) ||
  BOLD_LABEL_COLON_RE.test(line)
const HEADING_RE = /^(#{1,6})\s+\S/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
/** Anything that tries to be a split-section marker (any case, with or without a colon). */
const HOST_MARKER_LIKE_RE = /<!--\s*host\b/i
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

const errors = []
const warnings = []
const report = (list, rel, line, rule, message) => list.push({ rel, line, rule, message })

const relOf = (full) => path.relative(siteRoot, full).split(path.sep).join('/') || '.'

function walk(dir, out) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    // A directory we cannot read hides its chapters: a lint error, not a usage error.
    report(
      errors,
      relOf(dir),
      1,
      'AV-SYNTAX',
      `cannot read the directory: ${error.code ?? error.message}`,
    )
    return out
  }
  for (const name of names) {
    const full = path.join(dir, name)
    const entry = fs.lstatSync(full)
    const rel = relOf(full)
    const atSiteRoot = !rel.includes('/')
    if (atSiteRoot && name.startsWith('.')) continue
    if (entry.isSymbolicLink()) {
      report(errors, rel, 1, 'AV-HOST', 'symbolic links are not allowed in the chapter tree')
      continue
    }
    if (entry.isDirectory()) {
      if (!(atSiteRoot && SKIP_DIRS.has(name))) walk(full, out)
    } else if (name.endsWith('.md') && !(atSiteRoot && SKIP_FILES.has(name))) {
      out.push(full)
    }
  }
  return out
}

/**
 * Parse one chapter into the facts the rules need. A BOM or CR line endings
 * would make the frontmatter and anchor checks fail with a misleading message
 * (`frontmatter has no host:` with `host:` right there), so they are reported
 * by name and then normalised for the remaining checks.
 */
function readChapter(full, raw) {
  const rel = relOf(full)
  const lang = rel.startsWith('en/') ? 'en' : 'ja'
  let text = raw
  if (text.startsWith('﻿')) {
    report(
      errors,
      rel,
      1,
      'AV-SYNTAX',
      'the file starts with a byte-order mark — save it as UTF-8 without BOM',
    )
    text = text.slice(1)
  }
  const cr = text.indexOf('\r')
  if (cr !== -1) {
    const line = text.slice(0, cr).split('\n').length
    report(
      errors,
      rel,
      line,
      'AV-SYNTAX',
      'CRLF (or CR) line endings — save the file with LF line endings',
    )
    text = text.replace(/\r\n?/g, '\n')
  }
  const lines = text.split('\n')

  let fmEnd = -1
  if (lines[0] === '---') {
    fmEnd = lines.indexOf('---', 1)
  }
  const hosts = []
  for (let i = 1; i < fmEnd; i++) {
    const m = /^host:\s*(.*?)\s*$/.exec(lines[i])
    if (m) {
      let value = m[1].replace(/\s+#.*$/, '').trim()
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1).trim()
      }
      hosts.push({ value, line: i + 1 })
    }
  }

  // Classify body lines once; code-fence contents are text, not structure.
  const kinds = new Array(lines.length).fill('frontmatter')
  for (let i = 0; i <= fmEnd; i++) {
    if (HOST_MARKER_LIKE_RE.test(lines[i])) {
      kinds[i] = 'frontmatter-marker'
    } else if (isAnchorCandidate(lines[i])) {
      kinds[i] = 'anchor'
    }
  }
  let fence = null
  let fenceLine = 0
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
      fenceLine = i + 1
      kinds[i] = 'code'
    } else if (HOST_MARKER_LIKE_RE.test(line) && !HOST_MARKER_RE.test(line)) kinds[i] = 'bad-marker'
    else if (HOST_MARKER_RE.test(line)) kinds[i] = 'marker'
    else if (HEADING_RE.test(line)) kinds[i] = 'heading'
    else if (line.trim() === '') kinds[i] = 'blank'
    else if (isAnchorCandidate(line)) kinds[i] = 'anchor'
    else kinds[i] = 'text'
  }
  if (fence) {
    report(errors, rel, fenceLine, 'AV-SYNTAX', 'unterminated code fence')
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
    if (!HOST_MISSING_BASELINE.includes(ch.rel)) {
      report(
        errors,
        ch.rel,
        1,
        'AV-HOST',
        `frontmatter has no \`host:\` (${HOST_VALUES.join(' | ')})`,
      )
    }
    return null
  }
  if (HOST_MISSING_BASELINE.includes(ch.rel)) {
    report(
      errors,
      ch.rel,
      ch.hosts[0].line,
      'AV-HOST',
      'has `host:` now — remove it from HOST_MISSING_BASELINE',
    )
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
    if (kind !== 'marker' && kind !== 'bad-marker' && kind !== 'frontmatter-marker') return
    count++
    if (kind === 'frontmatter-marker') {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-HOST',
        'split-section marker is only allowed in the body, right after a heading',
      )
      return
    }
    if (kind === 'bad-marker') {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-HOST',
        'split-section marker must be exactly `<!-- host: ext -->` or `<!-- host: app -->`',
      )
      return
    }
    if (host !== 'both+split') {
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
    if (line !== ch.lines[i]) {
      report(errors, ch.rel, i + 1, 'AV-SYNTAX', 'trailing whitespace after the availability line')
    }
    if (line.startsWith(other.anchor)) {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-SYNTAX',
        `this ${ch.lang} chapter uses \`${other.anchor.trim()}\` — use \`${grammar.anchor.trim()}\``,
      )
    } else if (!line.startsWith(grammar.anchor)) {
      report(
        errors,
        ch.rel,
        i + 1,
        'AV-SYNTAX',
        `the anchor must be exactly \`${grammar.anchor.trim()}\` at the start of the line (half-width colon, then one space)`,
      )
    } else {
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
  })
  return count
}

/**
 * Every unreleased marker, wherever it sits (frontmatter and body; not code).
 * The lint is the only release gate for this — the docs no longer carry a grep
 * for it — so a marker in prose or in a malformed line must count too.
 */
function checkUnreleased(ch) {
  ch.lines.forEach((line, i) => {
    if (ch.kinds[i] === 'code') return
    if (!line.includes(AVAILABILITY.ja.unreleased) && !line.includes(AVAILABILITY.en.unreleased))
      return
    const where = ch.kinds[i] === 'anchor' ? '' : ' outside an availability line'
    report(
      release ? errors : warnings,
      ch.rel,
      i + 1,
      'AV-UNRELEASED',
      release
        ? `unreleased marker${where} at release time — replace it with the version`
        : `unreleased marker${where} (fine on main; the release preflight turns this into an error)`,
    )
  })
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

if (argumentError) {
  console.error(`Usage error: ${argumentError}\n${usage}`)
  process.exitCode = 2
} else {
  // Only a --root that is not a readable directory is a usage error (exit 2).
  // A chapter or subdirectory we cannot read is a lint finding (exit 1) and the
  // other chapters are still checked; anything else is a bug and must crash.
  let rootError = null
  try {
    if (!fs.statSync(siteRoot).isDirectory()) rootError = 'not a directory'
  } catch (error) {
    rootError = error.code ?? error.message
  }
  const chapters = []
  if (rootError) {
    console.error(`Usage error: cannot read --root ${siteRoot}: ${rootError}\n${usage}`)
    process.exitCode = 2
  } else {
    for (const full of walk(siteRoot, []).sort()) {
      let raw
      try {
        raw = fs.readFileSync(full, 'utf8')
      } catch (error) {
        report(
          errors,
          relOf(full),
          1,
          'AV-SYNTAX',
          `cannot read the chapter: ${error.code ?? error.message}`,
        )
        continue
      }
      chapters.push(readChapter(full, raw))
    }
  }

  if (process.exitCode !== 2) {
    if (chapters.length === 0) {
      report(
        errors,
        '.',
        0,
        'AV-SYNTAX',
        '対象の章が見つかりません。章の置き場が動いた可能性があります',
      )
    }

    const facts = new Map()
    for (const ch of chapters) {
      const host = checkHost(ch)
      const markers = checkMarkers(ch, host)
      const anchors = checkAvailabilityLines(ch)
      checkUnreleased(ch)
      checkHostScope(ch, host)
      checkTerms(ch)
      facts.set(ch.rel, { host: ch.hosts[0]?.value ?? null, anchors, markers })
    }

    for (const rel of HOST_MISSING_BASELINE) {
      if (!facts.has(rel))
        report(
          errors,
          rel,
          1,
          'AV-HOST',
          'listed in HOST_MISSING_BASELINE but no such chapter — remove the entry',
        )
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
    const exempt = chapters.filter(
      (ch) => HOST_MISSING_BASELINE.includes(ch.rel) && ch.hosts.length === 0,
    ).length
    console.log(
      `\n${chapters.length} chapter(s) checked (ja ${ja} / en ${chapters.length - ja}), ` +
        `${errors.length} error(s), ${warnings.length} warning(s)${release ? ' [--release]' : ''}`,
    )
    console.log(`${exempt} chapter(s) exempt from host-dependent rules via HOST_MISSING_BASELINE`)
    process.exitCode = errors.length > 0 ? 1 : 0
  }
}
