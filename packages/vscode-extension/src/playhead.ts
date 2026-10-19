/**
 * Live playhead highlight — pure helpers (#390).
 *
 * The engine (rust-engine-player.ts) prints one machine-readable line per
 * dispatched play event:
 *
 *     [STEP] <seqName> <argPath> <atEpochMs>
 *
 * - `argPath`: dot-joined indices into the `play()` argument tree. The MVP
 *   emits the top-level index only ("0", "1", ...); nested subdivision paths
 *   ("1.0") are reserved for a later phase.
 * - `atEpochMs`: absolute epoch ms of the event's GRID time (the scheduler's
 *   intended onset). Play events are dispatched lookahead-early, so the line
 *   arrives EARLIER than this time — the extension must delay the decoration
 *   until `atEpochMs`. Actual audio lands ~one daemon lookahead (~50ms) after
 *   the grid time; that shift is a uniform constant across all sequences, so
 *   the playhead stays mutually consistent (merely uniformly early).
 *
 * This module has NO vscode imports so it is unit-testable with vitest
 * (tests/vscode-extension/playhead.spec.ts). extension.ts converts the
 * character offsets returned here into editor Ranges / decorations.
 */

/** One parsed `[STEP]` line. */
export interface StepEvent {
  seqName: string
  /** Dot-joined play() arg indices ("2"; "1.0" reserved for nesting). */
  argPath: string
  /** Absolute epoch ms when the event becomes audible. */
  atEpochMs: number
}

/** Character-offset range into the document text (start inclusive, end exclusive). */
export interface ArgRange {
  start: number
  end: number
}

/** One `<seqName>.play(` call anchored by character offsets in its document. */
export interface PlayCall {
  seqName: string
  /** Offset of the first character in `seqName`. */
  callStart: number
  /** Offset of the opening parenthesis in `play(`. */
  openParen: number
}

// Grammar: "[STEP] <seqName> <argPath> <atEpochMs>". seqName is a DSL
// identifier (no whitespace); argPath is dot-joined non-negative integers;
// atEpochMs is an integer (the engine rounds fractional bar subdivisions).
const STEP_LINE_RE = /^\s*\[STEP\]\s+(\S+)\s+(\d+(?:\.\d+)*)\s+(\d+)\s*$/

/**
 * Parse one stdout line as a `[STEP]` marker. Returns null for anything that
 * does not match the grammar exactly (the stdout stream is mostly human logs).
 */
export function parseStepLine(line: string): StepEvent | null {
  const m = line.match(STEP_LINE_RE)
  if (!m) return null
  const atEpochMs = Number(m[3])
  if (!Number.isSafeInteger(atEpochMs)) return null
  return { seqName: m[1], argPath: m[2], atEpochMs }
}

/**
 * Per-seq highlight fallback palette (#390). Owner direction (2026-07-07):
 * vivid, wayfinding-grade colors — modeled on the Tokyo subway route map
 * (Metro + Toei line colors, whose palette is designed for at-a-glance line
 * recognition), extended with JR East line colors and high-contrast picks in
 * the spirit of Kelly / Green-Armytage "maximum contrast" sets to reach 32.
 * The order interleaves hue families so consecutively-assigned seqs stay far
 * apart in hue; rendered as a semi-transparent fill plus a solid border, so
 * every entry must remain readable on top of an editor selection. Users can
 * replace the palette via `orbitscore.playheadPalette` — the default in
 * packages/vscode-extension/package.json is asserted in-sync by
 * tests/vscode-extension/playhead.spec.ts. Per-seq pinning is planned as a
 * DSL feature (#391), not a setting.
 */
export const PLAYHEAD_PALETTE = [
  '#F62E36', // red (Marunouchi Line)
  '#009BBF', // sky blue (Tozai Line)
  '#FFD400', // yellow (JR Chuo-Sobu Local)
  '#00BB85', // green (Chiyoda Line)
  '#8F76D6', // purple (Hanzomon Line)
  '#FF9500', // orange (Ginza Line)
  '#0079C2', // blue (Toei Mita Line)
  '#E85298', // rose (Toei Asakusa Line)
  '#6CBB5A', // leaf green (Toei Shinjuku Line)
  '#B6007A', // ruby (Toei Oedo Line)
  '#00E5FF', // neon cyan
  '#F15A22', // vermillion (JR Chuo Rapid)
  '#00AC9B', // emerald (Namboku Line)
  '#B388FF', // lavender
  '#C1A470', // gold (Yurakucho Line)
  '#FF2D75', // neon pink
  '#80C241', // yellow green (JR Yamanote)
  '#3F51B5', // indigo
  '#FF6E40', // coral
  '#1DE9B6', // neon teal
  '#D500F9', // vivid orchid
  '#9C5E31', // brown (Fukutoshin Line)
  '#40C4FF', // sky
  '#76FF03', // neon lime
  '#FF8A80', // salmon
  '#82B1FF', // periwinkle
  '#FFAB40', // apricot
  '#69F0AE', // mint
  '#EA80FC', // light orchid
  '#B5B5AC', // silver (Hibiya Line)
  '#FFF176', // pale yellow
  '#607D8B', // blue gray
] as const

/** User color configuration for the playhead (both fields optional/partial). */
export interface PlayheadColorConfig {
  /** Ordered palette for first-come assignment; invalid entries are skipped. */
  palette?: readonly string[]
  /**
   * Explicit per-seq color overrides ({"drum": "#FF0000"}); win over the
   * palette. No settings surface today (owner dropped `playheadSeqColors`,
   * 2026-07-07) — kept as the seam the planned DSL-level `seq.color()` (#391)
   * will feed.
   */
  seqColors?: Readonly<Record<string, string>>
}

/** Normalize `#RGB` / `#RRGGBB` (any case) to uppercase `#RRGGBB`; null otherwise. */
export function normalizeHexColor(color: string): string | null {
  const trimmed = color.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase()
  const short = trimmed.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/)
  if (!short) return null
  return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase()
}

/**
 * Record (or look up) the first-come ordinal for a seq: the first seq to step
 * gets 0, the next new seq 1, ... The ordinal is intentionally NOT reduced
 * modulo any palette length — `assigned` survives palette re-configuration,
 * so the caller applies `% palette.length` at lookup time. A seq keeps its
 * ordinal for the lifetime of the map (across loop stop/start and engine
 * restarts).
 */
export function paletteIndexForSeq(seqName: string, assigned: Map<string, number>): number {
  let index = assigned.get(seqName)
  if (index === undefined) {
    index = assigned.size
    assigned.set(seqName, index)
  }
  return index
}

/**
 * Resolve the highlight color for a seq (#390 owner request):
 * 1. the explicit `seqColors` override when it parses as a hex color;
 * 2. otherwise first-come assignment from the user palette — falling back to
 *    PLAYHEAD_PALETTE when the user palette has no valid entry. Overridden
 *    seqs do not consume a palette slot.
 */
export function colorForSeq(
  seqName: string,
  config: PlayheadColorConfig,
  assigned: Map<string, number>,
): string {
  const override = config.seqColors?.[seqName]
  if (override) {
    const normalized = normalizeHexColor(override)
    if (normalized) return normalized
  }
  const userPalette = (config.palette ?? [])
    .map(normalizeHexColor)
    .filter((color): color is string => color !== null)
  const palette = userPalette.length > 0 ? userPalette : PLAYHEAD_PALETTE
  return palette[paletteIndexForSeq(seqName, assigned) % palette.length]
}

interface LexicalMap {
  /** 1 for text outside line comments and strings. */
  syntax: Uint8Array
  /** 1 for text inside a `//` line comment. */
  comment: Uint8Array
}

/**
 * Classify the small lexical subset needed by playhead lookup. Unlike the
 * engine tokenizer, an unterminated string ends at the next newline so one
 * half-typed quote cannot hide every later play call in the editor.
 */
function scanLexicalMap(text: string): LexicalMap {
  const syntax = new Uint8Array(text.length)
  const comment = new Uint8Array(text.length)
  let state: 'code' | 'comment' | 'string' = 'code'
  let quote = ''

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (state === 'comment') {
      if (ch === '\n') {
        state = 'code'
        syntax[i] = 1
      } else {
        comment[i] = 1
      }
      continue
    }
    if (state === 'string') {
      if (ch === '\n') {
        state = 'code'
        syntax[i] = 1
      } else if (ch === '\\') {
        if (i + 1 < text.length && text[i + 1] !== '\n') i++
      } else if (ch === quote) {
        state = 'code'
      }
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      state = 'comment'
      comment[i] = 1
      comment[++i] = 1
    } else if (ch === '"' || ch === "'") {
      state = 'string'
      quote = ch
    } else {
      syntax[i] = 1
    }
  }
  return { syntax, comment }
}

/** Return every comment/string-external `<ident>.play(` call in document order. */
export function findPlayCalls(text: string): PlayCall[] {
  const lexical = scanLexicalMap(text)
  // Boundary guard on both sides of the name: `drum.play(` must not match
  // `mydrum.play(` (preceding identifier char) nor `foo.drum.play(` (member
  // access on another object).
  const callRe = /(^|[^A-Za-z0-9_$.])([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*play\s*\(/g
  const calls: PlayCall[] = []
  for (const match of text.matchAll(callRe)) {
    const matchStart = match.index
    const callStart = matchStart + match[1].length
    const openParen = matchStart + match[0].lastIndexOf('(')
    let isCode = true
    for (let i = callStart; i <= openParen; i++) {
      if (!/\s/.test(text[i]) && lexical.syntax[i] === 0) {
        isCode = false
        break
      }
    }
    if (isCode) calls.push({ seqName: match[2], callStart, openParen })
  }
  return calls
}

const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/**
 * Split the bracketed group opening at `documentText[openIndex]` into the
 * trimmed character ranges of its top-level elements. Commas inside nested
 * `()` / `[]` / `{}` do NOT split, so an inner group such as `(1, 2)` or a
 * stack `[1, 3, 5]` counts as ONE element. Returns null when `openIndex` is
 * not an opening bracket or the group never closes; `closeIndex` is the
 * position of the matching closing bracket.
 */
function splitGroupElements(
  documentText: string,
  openIndex: number,
): { elements: ArgRange[]; closeIndex: number } | null {
  const closeCh = CLOSER[documentText[openIndex]]
  if (!closeCh) return null
  const lexical = scanLexicalMap(documentText)

  const elements: ArgRange[] = []
  const pushTrimmed = (start: number, end: number): void => {
    while (start < end && (/\s/.test(documentText[start]) || lexical.comment[start] === 1)) {
      start++
    }
    while (end > start && (/\s/.test(documentText[end - 1]) || lexical.comment[end - 1] === 1)) {
      end--
    }
    if (start < end) elements.push({ start, end })
  }

  let depth = 0
  let segStart = openIndex + 1
  let i = openIndex + 1
  for (; i < documentText.length; i++) {
    if (lexical.syntax[i] === 0) continue
    const ch = documentText[i]
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === closeCh && depth === 0) break // matching close of the group
      depth--
    } else if (ch === ',' && depth === 0) {
      pushTrimmed(segStart, i)
      segStart = i + 1
    }
  }
  if (i >= documentText.length) return null // unbalanced — never closed
  pushTrimmed(segStart, i)
  return { elements, closeIndex: i }
}

/**
 * Locate top-level argument ranges for `<seqName>.play(...)`. Without an
 * anchor, the first call outside comments and strings is used for backwards
 * compatibility. Returns [] when the call is absent, has no arguments, or
 * its parentheses never close.
 */
export function findPlayArgRanges(
  documentText: string,
  seqName: string,
  openParen?: number,
): ArgRange[] {
  const call = findPlayCalls(documentText).find(
    (candidate) =>
      candidate.seqName === seqName &&
      (openParen === undefined || candidate.openParen === openParen),
  )
  if (!call) return []
  return splitGroupElements(documentText, call.openParen)?.elements ?? []
}

/**
 * Resolve a dot-joined argPath (e.g. "1.0") to the character range of that
 * element in an anchored `<seqName>.play(...)` call. Without `openParen`, it
 * falls back to the first call outside comments and strings. Segment 0 indexes
 * the top-level args; each further segment descends into the element's
 * time-dividing group — `( ... )` nested or `{ ... }` legato.
 *
 * Degrades gracefully: when a deeper segment cannot be resolved, the deepest
 * resolvable ANCESTOR range is returned — a stack `[ ... ]` is one visual
 * unit (the engine tags all its voices with the stack's own slot path), a
 * group run like `(A)(B).root(X)` is not descended (the group's close bracket
 * is not the element's last char), and a user may have edited the text away
 * from the sounding pattern. Returns null when the top-level index is out of
 * range OR the argPath is malformed (non-integer / negative segment) —
 * lighting a wrong arg would mislead.
 */
export function findPlayArgRangeForPath(
  documentText: string,
  seqName: string,
  argPath: string,
  openParen?: number,
): ArgRange | null {
  const segments = argPath.split('.').map((s) => Number.parseInt(s, 10))
  if (segments.length === 0 || segments.some((n) => !Number.isInteger(n) || n < 0)) {
    return null
  }
  const topRanges = findPlayArgRanges(documentText, seqName, openParen)
  if (segments[0] >= topRanges.length) return null

  let range = topRanges[segments[0]]
  for (let k = 1; k < segments.length; k++) {
    const ch = documentText[range.start]
    if (ch !== '(' && ch !== '{') return range // leaf or stack — stop here
    const group = splitGroupElements(documentText, range.start)
    // Descend only when the group spans the WHOLE element (excludes group
    // runs / chained modifiers) and the segment exists.
    if (!group || group.closeIndex !== range.end - 1 || segments[k] >= group.elements.length) {
      return range
    }
    range = group.elements[segments[k]]
  }
  return range
}

type PlayheadStepResolution =
  | { kind: 'range'; range: ArgRange }
  | { kind: 'out-of-range' }
  | { kind: 'no-call' }

/** Resolve a step against either an exact recorded call or the first call. */
export function resolvePlayheadStep(
  documentText: string,
  seqName: string,
  argPath: string,
  anchor?: Pick<PlayCall, 'callStart' | 'openParen'>,
): PlayheadStepResolution {
  const call = findPlayCalls(documentText).find(
    (candidate) =>
      candidate.seqName === seqName &&
      (anchor === undefined ||
        (candidate.callStart === anchor.callStart && candidate.openParen === anchor.openParen)),
  )
  if (!call) return { kind: 'no-call' }
  const range = findPlayArgRangeForPath(documentText, seqName, argPath, call.openParen)
  return range ? { kind: 'range', range } : { kind: 'out-of-range' }
}

/** Shift an anchored call through sequential VS Code content changes. */
export function shiftPlayCallAnchor<T extends Pick<PlayCall, 'callStart' | 'openParen'>>(
  anchor: T,
  changes: readonly { rangeOffset: number; rangeLength: number; text: string }[],
): T | null {
  let callStart = anchor.callStart
  let openParen = anchor.openParen
  for (const change of changes) {
    const changeStart = change.rangeOffset
    const changeEnd = changeStart + change.rangeLength
    const protectedEnd = openParen + 1
    if (change.rangeLength > 0 && changeStart < protectedEnd && changeEnd > callStart) {
      return null
    }
    if (change.rangeLength === 0 && changeStart > callStart && changeStart < protectedEnd) {
      return null
    }
    if (changeEnd <= callStart) {
      const delta = change.text.length - change.rangeLength
      callStart += delta
      openParen += delta
    }
  }
  return { ...anchor, callStart, openParen }
}
