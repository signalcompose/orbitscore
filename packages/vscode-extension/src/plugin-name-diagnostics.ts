/**
 * Edit-time validation of catalog plugin names (#638).
 *
 * Without this, `effect(["存在しない名前"])` looks fine until the sequence is
 * evaluated — the catalog lookup only happens in the engine, at runtime. With
 * 342 entries in a real catalog, a typo is the common case, not the edge case.
 *
 * 🔴 This module deliberately MIRRORS the engine's resolution rules
 * (`packages/engine/src/core/global/plugin-resolver.ts`) rather than importing
 * them: the extension ships as a standalone `.vsix` and must not depend on the
 * engine package at runtime. The duplication is pinned by an agreement test
 * (`tests/vscode-extension/plugin-name-diagnostics.spec.ts`) that drives BOTH
 * implementations over one corpus and asserts they accept and reject the same
 * specs — so a change to either side that drifts becomes a red test rather than
 * a silent divergence. This follows the existing precedent in
 * `tests/vscode-extension/dsl-method-catalog.spec.ts`.
 *
 * When #610 unifies diagnostics onto the engine parser, this module is the
 * thing that goes away.
 */

import * as path from 'path'

import { collectDerivedMixerBuses, type DiagnosticIssue } from './diagnostics-analysis'
import { normalizeCatalogKey } from './plugin-catalog-completion'
import type { PluginCatalogEntry } from './plugin-catalog-reader'

/** Structural words that carry the enclosing verb's role into a nested region. */
const STRUCTURAL_WORDS = new Set(['layer', 'chain'])

// 🔴 語彙の集合はここに並べて置く。#940 のレビューまで、同じ語（`effect` / `instrument` /
// `layer` / `chain` / `plugin`）に対する判定が 4 箇所に**それぞれ違う集合**でインライン展開
// されていた。5 つ目の構造語が増えた時、どれか 1 箇所を直し忘れる形だった。
// 集合が並んでいれば、意図的な差（`layer` だけ透過にしない等）も見比べられる。

/** カタログ名の解決文脈を**開く**呼び出し語。ここが receiver とチェーンの起点になる。 */
const CATALOG_ROOT_WORDS = new Set(['effect', 'instrument'])

/** 直下の `,` が**要素の区切り**になる呼び出し語（`plugin(...)` や `Gain(...)` の中は数えない）。 */
const ELEMENT_SEPARATOR_WORDS = new Set(['effect', 'instrument', 'layer', 'chain'])

/** Tokenizer keywords are syntax (`var`/`init`/`import`), modifiers, literals, or commands—not sequence/bus names. */
const DSL_KEYWORDS = new Set([
  'var',
  'init',
  'by',
  'GLOBAL',
  'force',
  'RUN',
  'LOOP',
  'MUTE',
  'import',
])

const STATEMENT_DECLARATION_PREFIX = new RegExp(String.raw`^\s*var\s+[A-Za-z_$][\w$]*\s*=\s*`)
const STATEMENT_BUS_RECEIVER = new RegExp(
  String.raw`^\s*(?:global\.)?(sum|aux)\(\s*(["'])(.*?)\2\s*\)`,
)
const STATEMENT_IDENTIFIER_RECEIVER = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\b/

/** Mirrors `plugin-resolver.ts` `PATH_DIRECT_PREFIXES`. */
const PATH_DIRECT_PREFIXES = ['./', '../', '~/', '/']
/** Mirrors `plugin-resolver.ts` `KNOWN_PLUGIN_EXTENSIONS`. */
const KNOWN_PLUGIN_EXTENSIONS = ['.clap', '.vst3', '.component']
/** Mirrors `plugin-resolver.ts` `KNOWN_PLUGIN_FORMATS`. */
const KNOWN_PLUGIN_FORMATS = ['clap', 'vst3']
/** Mirrors `acceptedFormatsForRole()` — the formats v1 can actually host. */
const HOSTABLE_FORMATS = ['clap', 'vst3']

/** Mirrors `plugin-resolver.ts` `isPluginPathSpec` (PC.2 discriminator). */
export function isPluginPathSpec(spec: string): boolean {
  if (PATH_DIRECT_PREFIXES.some((prefix) => spec.startsWith(prefix))) return true
  const lower = spec.toLowerCase()
  return KNOWN_PLUGIN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Mirrors `plugin-resolver.ts` `isStateFileSpec` (#540 P2 — a saved tone, not a name). */
export function isStateFileSpec(value: string): boolean {
  return /\.(vstpreset|state)$/i.test(value)
}

/** Mirrors engine `normalizePluginInstanceName` for the UI expected-name guard. */
export function normalizePluginInstanceNameForGuard(spec: string): string {
  const normalized = spec.trim().normalize('NFC').replace(/\\/g, '/')
  const unqualified = path.basename(normalized)
  const extension = path.extname(unqualified).toLowerCase()
  return KNOWN_PLUGIN_EXTENSIONS.includes(extension)
    ? unqualified.slice(0, -extension.length)
    : unqualified
}

export type CatalogSpecRole = 'effect' | 'instrument'

export type CatalogSpecVerdict =
  | { readonly kind: 'ok' }
  /** Not a catalog name at all (path spec / state file) — nothing to check here. */
  | { readonly kind: 'not-a-catalog-name' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'ambiguous-vendor'; readonly matches: readonly string[] }
  | { readonly kind: 'ambiguous-qualifier' }
  | { readonly kind: 'wrong-role'; readonly foundRoles: readonly string[] }
  | { readonly kind: 'unhostable-format'; readonly foundFormats: readonly string[] }

/**
 * Classifies one spec string the way the engine's `resolveCatalogSpec` would,
 * without throwing. The order of the checks is load-bearing: it reproduces the
 * engine's, so the first failure reported here is the first one the engine would
 * hit. See the agreement test for the pin.
 */
export function classifyCatalogSpec(
  entries: readonly PluginCatalogEntry[],
  spec: string,
  role: CatalogSpecRole,
): CatalogSpecVerdict {
  if (isPluginPathSpec(spec) || isStateFileSpec(spec)) return { kind: 'not-a-catalog-name' }

  const slashIndex = spec.indexOf('/')
  const qualifierKey =
    slashIndex === -1 ? undefined : normalizeCatalogKey(spec.slice(0, slashIndex))
  const formatKey =
    qualifierKey !== undefined && KNOWN_PLUGIN_FORMATS.includes(qualifierKey)
      ? qualifierKey
      : undefined
  const vendorKey = formatKey === undefined ? qualifierKey : undefined
  const bareName = slashIndex === -1 ? spec : spec.slice(slashIndex + 1)

  // 🔴 `bareName` の正規化はループ不変。ここは**打鍵ごと**に走る診断経路なので、
  // 342 件のカタログに対して毎回 `trim().normalize('NFC').toLowerCase()` を呼び直さない。
  const normalizedBareName = normalizeCatalogKey(bareName)
  let candidates = entries.filter((entry) => normalizeCatalogKey(entry.name) === normalizedBareName)

  if (formatKey !== undefined) {
    const byFormat = candidates.filter((e) => normalizeCatalogKey(e.format) === formatKey)
    const byVendor = candidates.filter((e) => normalizeCatalogKey(e.vendor) === qualifierKey)
    if (byFormat.length > 0 && byVendor.length > 0) return { kind: 'ambiguous-qualifier' }
    candidates = byFormat.length > 0 ? byFormat : byVendor
  } else if (vendorKey !== undefined) {
    candidates = candidates.filter((e) => normalizeCatalogKey(e.vendor) === vendorKey)
  }

  if (candidates.length === 0) return { kind: 'unknown' }

  if (vendorKey === undefined) {
    const vendors = new Set(candidates.map((e) => normalizeCatalogKey(e.vendor)))
    if (vendors.size > 1) {
      return {
        kind: 'ambiguous-vendor',
        matches: candidates.map((e) => `"${e.vendor}/${e.name}" (${e.format})`),
      }
    }
  }

  const roleCandidates = candidates.filter((e) => e.roles.includes(role))
  if (roleCandidates.length === 0) {
    return {
      kind: 'wrong-role',
      foundRoles: [...new Set(candidates.flatMap((e) => e.roles))],
    }
  }

  const hostable = roleCandidates.filter((e) => HOSTABLE_FORMATS.includes(e.format.toLowerCase()))
  if (hostable.length === 0) {
    return {
      kind: 'unhostable-format',
      foundFormats: [...new Set(roleCandidates.map((e) => e.format))],
    }
  }

  return { kind: 'ok' }
}

// ──────────────────────────────────────────────────────────────────────
// 文書スキャナ
// ──────────────────────────────────────────────────────────────────────

/** One catalog-name string literal found in the document, with where it sits. */
export interface CatalogSpecSite {
  readonly spec: string
  readonly role: CatalogSpecRole
  readonly line: number
  /** Column of the opening quote (0-based). */
  readonly startCol: number
  /** Column just past the closing quote (0-based). */
  readonly endCol: number
  /** UIH.5 receiver notation; undefined when the owner cannot be resolved on this line. */
  readonly receiver: string | undefined
  /** Position within the enclosing effect/instrument chain, before conversion to an index. */
  readonly chainPath: readonly number[]
}

interface CallFrame {
  /** The role catalog names in this frame resolve against; undefined = not a catalog context. */
  readonly role: CatalogSpecRole | undefined
  readonly word: string
  readonly receiver: string | undefined
  readonly elementCounters: number[] | undefined
}

interface BracketFrame {
  readonly owner: CallFrame | undefined
  readonly pushedCounter: boolean
}

/**
 * Finds every string literal that the engine would resolve as a catalog name.
 *
 * The frame stack is what keeps this honest. `effect([...])` and
 * `instrument([...])` open a catalog context; `plugin` / `layer` / `chain`
 * inherit it (they are structure, not a new namespace — SC.10.1); **every other
 * call closes it**. That last rule is load-bearing: standard plugins are
 * capitalized calls that are resolved from the language's own vocabulary and
 * **never hit the catalog** (SC.10.8 規範 4), so a string argument inside
 * `Gain(...)` must not be validated against it. Defaulting unknown words to
 * "not a catalog context" also keeps unrelated calls like `seq.audio("path")`
 * out of scope.
 */
export function findCatalogSpecSites(text: string): CatalogSpecSite[] {
  const sites: CatalogSpecSite[] = []
  const stack: CallFrame[] = []
  const brackets: BracketFrame[] = []
  const derivedReceivers = collectDerivedReceivers(text)
  let line = 0
  let lineStart = 0
  let i = 0

  const currentRole = (): CatalogSpecRole | undefined =>
    stack.length === 0 ? undefined : stack[stack.length - 1]?.role
  const currentFrame = (): CallFrame | undefined => stack[stack.length - 1]

  while (i < text.length) {
    const ch = text[i]

    if (ch === '\n') {
      line += 1
      i += 1
      lineStart = i
      continue
    }

    // Line comment: skip to end of line (the newline is handled next iteration).
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }

    if (ch === '"' || ch === "'") {
      const quote = ch
      const startCol = i - lineStart
      const startLine = line
      let value = ''
      i += 1
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < text.length) {
          value += text[i + 1]
          i += 2
          continue
        }
        // An unterminated literal ends at the newline; do not run into the next line.
        if (text[i] === '\n') break
        value += text[i]
        i += 1
      }
      if (text[i] === quote) {
        i += 1
        const role = currentRole()
        const frame = currentFrame()
        if (role !== undefined) {
          sites.push({
            spec: value,
            role,
            line: startLine,
            startCol,
            endCol: i - lineStart,
            receiver: frame?.receiver,
            chainPath: [...(frame?.elementCounters ?? [0])],
          })
        }
      }
      continue
    }

    if (ch === '(') {
      const call = callWordBefore(text, i)
      const parent = currentFrame()
      const role = roleForCallWord(call.word, parent?.role)
      const isCatalogRoot = CATALOG_ROOT_WORDS.has(call.word)
      stack.push({
        role,
        word: call.word,
        receiver: isCatalogRoot
          ? receiverBefore(text, call.start, derivedReceivers)
          : role === undefined
            ? undefined
            : parent?.receiver,
        elementCounters: isCatalogRoot
          ? [0]
          : role === undefined
            ? undefined
            : parent?.elementCounters,
      })
      i += 1
      continue
    }

    if (ch === ')') {
      stack.pop()
      i += 1
      continue
    }

    if (ch === '[') {
      const frame = currentFrame()
      let pushedCounter = false
      if (frame?.elementCounters) {
        // Mirrors engine `resolveRackValue`: every plain array and chain() is
        // flattened into its parent, regardless of nesting depth. Only an
        // array whose nearest enclosing call is layer() creates a path level.
        if (frame.word === 'layer') {
          frame.elementCounters.push(0)
          pushedCounter = true
        }
      }
      brackets.push({ owner: frame, pushedCounter })
      i += 1
      continue
    }

    if (ch === ']') {
      const bracket = brackets.pop()
      if (bracket?.pushedCounter) bracket.owner?.elementCounters?.pop()
      i += 1
      continue
    }

    if (ch === ',') {
      const frame = currentFrame()
      if (frame?.elementCounters && ELEMENT_SEPARATOR_WORDS.has(frame.word)) {
        const last = frame.elementCounters.length - 1
        frame.elementCounters[last] = (frame.elementCounters[last] ?? 0) + 1
      }
      i += 1
      continue
    }

    i += 1
  }

  return sites
}

/** The identifier immediately preceding `parenIndex`, ignoring whitespace. */
function callWordBefore(text: string, parenIndex: number): { word: string; start: number } {
  let end = parenIndex
  while (end > 0 && /\s/.test(text[end - 1] ?? '')) end -= 1
  let start = end
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1] ?? '')) start -= 1
  return { word: text.slice(start, end), start }
}

/**
 * `var d = mix.sum` / `.aux` の派生宣言を receiver 表記へ写す。
 *
 * 🔴 検出そのものは `diagnostics-analysis` の [`collectDerivedMixerBuses`] に委譲する。
 * #940 のレビューまでここに 3 本目の独自正規表現を持っており、既存 2 本と文字集合も
 * アンカリングも違っていた（同じ楽譜が 3 通りに読まれうる状態だった）。
 */
function collectDerivedReceivers(text: string): ReadonlyMap<string, string> {
  const receivers = new Map<string, string>()
  for (const [name, kind] of collectDerivedMixerBuses(text)) {
    receivers.set(name, `${kind}:${name}`)
  }
  return receivers
}

/** Resolve the receiver from the start of the statement containing effect/instrument. */
function receiverBefore(
  text: string,
  wordStart: number,
  derivedReceivers: ReadonlyMap<string, string>,
): string | undefined {
  const lineStart = text.lastIndexOf('\n', wordStart - 1) + 1
  const prefix = text.slice(lineStart, wordStart)
  const declaration = prefix.match(STATEMENT_DECLARATION_PREFIX)
  const expressionPrefix = declaration ? prefix.slice(declaration[0].length) : prefix
  const busCall = expressionPrefix.match(STATEMENT_BUS_RECEIVER)
  if (busCall?.[1] && busCall[3] !== undefined) return `${busCall[1]}:${busCall[3]}`

  const ident = expressionPrefix.match(STATEMENT_IDENTIFIER_RECEIVER)?.[1]
  if (!ident || DSL_KEYWORDS.has(ident)) return undefined
  if (ident === 'global') return 'master'
  return derivedReceivers.get(ident) ?? ident
}

function roleForCallWord(
  word: string,
  inherited: CatalogSpecRole | undefined,
): CatalogSpecRole | undefined {
  if (word === 'effect') return 'effect'
  if (word === 'instrument') return 'instrument'
  if (word === 'plugin' || STRUCTURAL_WORDS.has(word)) return inherited
  // Everything else — standard plugins (`Gain(...)`), unrelated calls, bare
  // parens — is not a catalog context.
  return undefined
}

/**
 * Diagnostics for plugin names that the catalog cannot resolve.
 *
 * Returns nothing when the catalog is unavailable: a missing or not-yet-scanned
 * catalog is not evidence that a name is wrong, and flagging every name in the
 * file would be worse than staying quiet.
 */
export function analyzeUnknownPluginNames(
  text: string,
  entries: readonly PluginCatalogEntry[] | undefined,
): DiagnosticIssue[] {
  if (entries === undefined || entries.length === 0) return []
  const issues: DiagnosticIssue[] = []
  for (const site of findCatalogSpecSites(text)) {
    const verdict = classifyCatalogSpec(entries, site.spec, site.role)
    const message = messageFor(site, verdict)
    if (message === undefined) continue
    issues.push({ line: site.line, startCol: site.startCol, endCol: site.endCol, message })
  }
  return issues
}

function messageFor(site: CatalogSpecSite, verdict: CatalogSpecVerdict): string | undefined {
  switch (verdict.kind) {
    case 'ok':
    case 'not-a-catalog-name':
      return undefined
    case 'unknown':
      return (
        `No plugin named "${site.spec}" is in the plugin catalog. Check the spelling, or run ` +
        '`orbit-plugin-scan --probe-artifacts` to regenerate the catalog if the plugin is newly installed.'
      )
    case 'ambiguous-vendor':
      return (
        `Plugin name "${site.spec}" is ambiguous across multiple vendors: ` +
        `${verdict.matches.join(', ')}. Qualify it as "vendor/name" to disambiguate.`
      )
    case 'ambiguous-qualifier':
      return (
        `"${site.spec}" is ambiguous: the qualifier matches both a format and a vendor. ` +
        'Use the full vendor name, or a path spec.'
      )
    case 'wrong-role':
      return (
        `Plugin "${site.spec}" does not support the "${site.role}" role ` +
        `(catalog roles: ${verdict.foundRoles.join(', ') || 'none'}).`
      )
    case 'unhostable-format':
      return (
        `Plugin "${site.spec}" is in the catalog only as [${verdict.foundFormats.join(', ')}], ` +
        `which ${site.role}() cannot host in v1 (accepts: ${HOSTABLE_FORMATS.join(', ')}).`
      )
  }
}
