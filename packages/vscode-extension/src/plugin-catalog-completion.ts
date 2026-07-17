/**
 * Pure completion-context helpers for plugin catalog name completion
 * (#463 C3, spec `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §PC.3).
 *
 * Deliberately vscode-free (unlike completion-context.ts, which constructs
 * `vscode.CompletionItem`) so the extension's provider can build the actual
 * `vscode.CompletionItem[]` (with `range` etc.) itself while this module stays
 * unit-testable without a vscode mock.
 *
 * Owner requirement (2026-07-17): candidates must filter as the user keeps
 * typing inside the string, not only at the `"` trigger — so `detectPluginArgContext`
 * matches a PARTIAL string (no closing quote required) and returns the typed
 * prefix so far, and `filterCatalogEntries` narrows by that prefix.
 */

import type { PluginCatalogEntry } from './plugin-catalog-reader'

export type PluginVerb = 'effect' | 'instrument'

export interface PluginArgContext {
  readonly verb: PluginVerb
  /** Text typed so far between the opening quote and the cursor (no closing quote required). */
  readonly typed: string
  /** 0-based character offset of the opening quote's content start (i.e. right after `"`). */
  readonly quoteStartChar: number
}

export interface PluginCatalogCompletionCandidate {
  readonly entry: PluginCatalogEntry
  readonly label: string
  readonly insertText: string
}

// Matches `.effect("` / `.instrument("` immediately followed by an in-progress
// string (no closing quote yet) ending at the cursor. `[^"\n]*$` anchors to the
// end of the prefix, so this matches `effect("Sca` (partial) just as well as
// the freshly-triggered `effect("`.
const PLUGIN_ARG_RE = /\.(effect|instrument)\(\s*"([^"\n]*)$/

/**
 * Detects whether `position` (0-based character offset into `lineText`) sits
 * inside the first string argument of `effect(` / `instrument(`. Returns the
 * verb, the partial typed text, and where that text starts — regardless of
 * whether the string's closing quote is present later on the line.
 */
export function detectPluginArgContext(
  lineText: string,
  position: number,
): PluginArgContext | null {
  const prefix = lineText.slice(0, position)
  const match = PLUGIN_ARG_RE.exec(prefix)
  if (!match) return null
  const verb = match[1] as PluginVerb
  const typed = match[2] ?? ''
  return { verb, typed, quoteStartChar: position - typed.length }
}

/**
 * Filters catalog entries for a completion request:
 * - role match (PC.3: `instrument(` → roles includes `instrument`; `effect(` → roles includes `effect`)
 * - both verbs accept CLAP and VST3 entries (PH.3); catalog name resolution prefers CLAP on a same-name tie
 * - same-vendor cross-format collisions become `format/name` candidates; remaining label collisions use `vendor/name`
 * - typed-prefix narrowing (case-insensitive substring match against the candidate or `vendor/name`)
 */
export function filterCatalogEntries(
  entries: readonly PluginCatalogEntry[],
  verb: PluginVerb,
  typed: string,
): PluginCatalogCompletionCandidate[] {
  const needle = typed.trim().toLowerCase()
  const roleEntries = entries.filter((entry) => entry.roles.includes(verb))
  const formatsByVendorAndName = new Map<string, Set<string>>()
  for (const entry of roleEntries) {
    const key = vendorAndNameKey(entry)
    const formats = formatsByVendorAndName.get(key) ?? new Set<string>()
    formats.add(normalizeCatalogKey(entry.format))
    formatsByVendorAndName.set(key, formats)
  }

  const baseCandidates = roleEntries.map((entry) => {
    const hasFormatCollision = (formatsByVendorAndName.get(vendorAndNameKey(entry))?.size ?? 0) > 1
    return {
      entry,
      label: hasFormatCollision ? `${entry.format.toLowerCase()}/${entry.name}` : entry.name,
    }
  })
  const vendorsByLabel = new Map<string, Set<string>>()
  for (const { entry, label } of baseCandidates) {
    const vendors = vendorsByLabel.get(normalizeCatalogKey(label)) ?? new Set<string>()
    vendors.add(normalizeCatalogKey(entry.vendor))
    vendorsByLabel.set(normalizeCatalogKey(label), vendors)
  }

  return baseCandidates.flatMap(({ entry, label: baseLabel }) => {
    const label =
      (vendorsByLabel.get(normalizeCatalogKey(baseLabel))?.size ?? 0) > 1
        ? `${entry.vendor}/${entry.name}`
        : baseLabel
    if (needle === '') return [{ entry, label, insertText: label }]
    const qualified = `${entry.vendor}/${entry.name}`.toLowerCase()
    if (!label.toLowerCase().includes(needle) && !qualified.includes(needle)) return []
    return [{ entry, label, insertText: label }]
  })
}

function normalizeCatalogKey(value: string): string {
  return value.trim().normalize('NFC').toLowerCase()
}

function vendorAndNameKey(entry: PluginCatalogEntry): string {
  return `${normalizeCatalogKey(entry.vendor)}\u0000${normalizeCatalogKey(entry.name)}`
}
