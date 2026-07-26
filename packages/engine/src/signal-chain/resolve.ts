/**
 * Signal Chain shared name-resolution module (#514 notation layer).
 *
 * Spec: docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md — SC.3.1 "grammar is static,
 * vocabulary is dynamic": the parser accepts any method name; what a chain method
 * MEANS is decided here, and this decision must be identical everywhere it is
 * asked — the staged #517 interpreter mapping, diagnostics, and editor completion (#495)
 * all call these pure functions.
 *
 * Resolution order (SC.2 norm 3): known DSL method > declared mixer name >
 * plugin-catalog name. DSL methods win so a bus named `play` can never shadow
 * the built-in vocabulary. Ties across the remaining two are reported as
 * `collisions` for the language service to warn about.
 *
 * The caller supplies the name tables. For the #517 runtime stages, the declared-mixer-name
 * table must include the implicit `master(1,2)` of a file that declares no mixer
 * (SC.2 norm 6) — that defaulting is the caller's responsibility, not this module's.
 *
 * Landed ahead of its first caller ON PURPOSE: #514 locks the notation and
 * resolution-order contract early; the first consumers are the #517 staged
 * interpreter mapping and the #495 language service.
 */

/** What one chain-method name resolves to. */
export type ChainNameResolution = {
  kind: 'dsl-method' | 'mixer-name' | 'plugin' | 'unknown'
  /**
   * Lower-priority meanings the name ALSO matched (SC.2 norm 3: the language
   * service warns on these). Empty when the resolution is unambiguous.
   */
  collisions: Array<'mixer-name' | 'plugin'>
}

export type ChainNameTables = {
  /** Public DSL method names of the receiver (Sequence / Global / bus handle). */
  dslMethods: ReadonlySet<string>
  /** Declared mixer-node names (output / sum / aux variables), implicit master included. */
  mixerNames: ReadonlySet<string>
  /** Normalized plugin-catalog names (see {@link normalizeCatalogName}). */
  pluginNames: ReadonlySet<string>
}

/**
 * Normalize a plugin-catalog display name to its DSL method form (SC.3.2):
 * keep alphanumerics only ("TAL Reverb 4" → "TALReverb4"), prefix `_` when the
 * result starts with a digit. Returns null when nothing normalizable remains
 * (e.g. a name of only non-alphanumerics) — such plugins are reachable through
 * the string escape hatch (`effect("名前")`, SC.8) only.
 */
export function normalizeCatalogName(displayName: string): string | null {
  const normalized = displayName.replace(/[^A-Za-z0-9]/g, '')
  if (normalized === '') return null
  return /^[0-9]/.test(normalized) ? `_${normalized}` : normalized
}

/**
 * Resolve one chain-method name against the dynamic vocabulary (SC.2 norm 3).
 * Pure and total: unknown names resolve to `kind: 'unknown'` (the caller decides
 * whether that is an error, a diagnostic, or a completion no-op).
 */
export function resolveChainName(name: string, tables: ChainNameTables): ChainNameResolution {
  const inMixer = tables.mixerNames.has(name)
  const inPlugins = tables.pluginNames.has(name)

  if (tables.dslMethods.has(name)) {
    const collisions: ChainNameResolution['collisions'] = []
    if (inMixer) collisions.push('mixer-name')
    if (inPlugins) collisions.push('plugin')
    return { kind: 'dsl-method', collisions }
  }
  if (inMixer) {
    return { kind: 'mixer-name', collisions: inPlugins ? ['plugin'] : [] }
  }
  if (inPlugins) {
    return { kind: 'plugin', collisions: [] }
  }
  return { kind: 'unknown', collisions: [] }
}
