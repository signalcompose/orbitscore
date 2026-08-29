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

import type { DiagnosticIssue } from './diagnostics-analysis'
import { normalizeCatalogKey } from './plugin-catalog-completion'
import type { PluginCatalogEntry } from './plugin-catalog-reader'

/** Structural words that carry the enclosing verb's role into a nested region. */
const STRUCTURAL_WORDS = new Set(['layer', 'chain'])

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
}

interface CallFrame {
  /** The role catalog names in this frame resolve against; undefined = not a catalog context. */
  readonly role: CatalogSpecRole | undefined
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
  let line = 0
  let lineStart = 0
  let i = 0

  const currentRole = (): CatalogSpecRole | undefined =>
    stack.length === 0 ? undefined : stack[stack.length - 1]?.role

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
        if (role !== undefined) {
          sites.push({ spec: value, role, line: startLine, startCol, endCol: i - lineStart })
        }
      }
      continue
    }

    if (ch === '(') {
      stack.push({ role: roleForCallWord(wordBefore(text, i), currentRole()) })
      i += 1
      continue
    }

    if (ch === ')') {
      stack.pop()
      i += 1
      continue
    }

    i += 1
  }

  return sites
}

/** The identifier immediately preceding `parenIndex`, ignoring whitespace. */
function wordBefore(text: string, parenIndex: number): string {
  let end = parenIndex
  while (end > 0 && /\s/.test(text[end - 1] ?? '')) end -= 1
  let start = end
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1] ?? '')) start -= 1
  return text.slice(start, end)
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
