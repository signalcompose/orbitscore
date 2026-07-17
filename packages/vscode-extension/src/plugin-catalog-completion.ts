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
 * - format restriction for effects (PH.3: only CLAP effects are accepted today; instruments have no such restriction)
 * - typed-prefix narrowing (case-insensitive substring match against `name` or `vendor/name`)
 */
export function filterCatalogEntries(
  entries: readonly PluginCatalogEntry[],
  verb: PluginVerb,
  typed: string,
): PluginCatalogEntry[] {
  const needle = typed.trim().toLowerCase()
  return entries.filter((entry) => {
    if (!entry.roles.includes(verb)) return false
    if (verb === 'effect' && entry.format.toLowerCase() !== 'clap') return false
    if (needle === '') return true
    const qualified = `${entry.vendor}/${entry.name}`.toLowerCase()
    return entry.name.toLowerCase().includes(needle) || qualified.includes(needle)
  })
}
