/**
 * Plugin path resolver.
 *
 * Shared role-aware extension-validation + path-resolution logic for plugin
 * specs, plus (#463 C2) catalog name resolution — spec
 * `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §PC.2 is the source of truth for the
 * discriminator and matching rules implemented here.
 *
 * `resolvePluginPath` validates the extension first, then resolves the path
 * (`resolvePathDirect`) — this single entry point always does both, in that
 * order, so callers can't accidentally skip validation. Callers that also
 * need to gate on other state (e.g. `PluginEffectManager.effect()` rejecting
 * while LinkAudio is enabled) should run that check *between* validation and
 * resolution — call `validatePluginExtension(spec, role)` directly first, do the
 * gating check, then call `resolvePluginPath` (which re-validates; the
 * function is pure so the repeat call is harmless).
 *
 * `resolvePluginSpec` is the catalog-aware entry point callers should use for
 * `effect()`/`instrument()`: it runs the PC.2 discriminator first (path-direct
 * specs fall through to `resolvePluginPath`, unchanged) and only reaches the
 * catalog for bare names.
 */

import path from 'node:path'

import { resolvePathDirect } from './audio-resolver'
import { loadPluginCatalog, resolveCatalogPath, type PluginCatalogEntry } from './plugin-catalog'

export function resolvePluginPath(
  spec: string,
  audioPaths: readonly string[],
  documentDirectory: string,
  role: PluginRole,
): string {
  validatePluginExtension(spec, role)
  return resolvePathDirect(spec, audioPaths, documentDirectory)
}

export type PluginRole = 'effect' | 'instrument'

export function validatePluginExtension(spec: string, role: PluginRole): void {
  const extension = path.extname(spec).toLowerCase()
  if (extension === '.clap') return
  if (extension === '.vst3') return
  if (extension === '.component') {
    throw new Error(
      `${extension} plugins are not yet supported for ${role} (reserved for future AU support).`,
    )
  }
  const expected = '.clap or .vst3'
  throw new Error(`Unknown plugin extension "${extension || '(none)'}"; expected ${expected}.`)
}

const PATH_DIRECT_PREFIXES = ['./', '../', '~/', '/']
const KNOWN_PLUGIN_EXTENSIONS = ['.clap', '.vst3', '.component']
const KNOWN_PLUGIN_FORMATS = ['clap', 'vst3']

/**
 * PC.2 discriminator: path-direct specs start with `./`/`../`/`~/`/`/` or end with a known
 * plugin extension; everything else is a catalog name. Deliberately does NOT reuse audio's
 * `looksLikePath()` ("contains `/`" = path) — a vendor-qualified catalog name like
 * `"TAL Software/TAL Reverb 4"` contains `/` but is not a path.
 */
export function isPluginPathSpec(spec: string): boolean {
  if (PATH_DIRECT_PREFIXES.some((prefix) => spec.startsWith(prefix))) return true
  const lower = spec.toLowerCase()
  return KNOWN_PLUGIN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function normalizeCatalogKey(value: string): string {
  return value.trim().normalize('NFC').toLowerCase()
}

function acceptedFormatsForRole(): readonly string[] {
  return ['clap', 'vst3']
}

const RESCAN_HINT = 'Run `orbit-plugin-scan` to (re)generate the plugin catalog, then retry.'

export interface ResolvedCatalogPlugin {
  readonly path: string
  readonly pluginId: string
  readonly entries: readonly PluginCatalogEntry[]
  readonly entry: PluginCatalogEntry
}

type CatalogQualifier = {
  readonly qualifierKey: string | undefined
  readonly formatKey: string | undefined
  readonly vendorKey: string | undefined
}

function catalogQualifier(spec: string): CatalogQualifier {
  const slashIndex = spec.indexOf('/')
  const qualifierKey =
    slashIndex === -1 ? undefined : normalizeCatalogKey(spec.slice(0, slashIndex))
  const formatKey =
    qualifierKey !== undefined && KNOWN_PLUGIN_FORMATS.includes(qualifierKey)
      ? qualifierKey
      : undefined
  return {
    qualifierKey,
    formatKey,
    vendorKey: formatKey === undefined ? qualifierKey : undefined,
  }
}

function resolveCatalogCandidates(
  spec: string,
  initialCandidates: readonly PluginCatalogEntry[],
  role: PluginRole | undefined,
  catalogPath: string,
): ResolvedCatalogPlugin {
  const { qualifierKey, formatKey, vendorKey } = catalogQualifier(spec)
  let candidates = [...initialCandidates]

  if (formatKey !== undefined) {
    const formatCandidates = candidates.filter(
      (entry) => normalizeCatalogKey(entry.format) === formatKey,
    )
    const vendorCandidates = candidates.filter(
      (entry) => normalizeCatalogKey(entry.vendor) === qualifierKey,
    )
    if (formatCandidates.length > 0 && vendorCandidates.length > 0) {
      throw new Error(
        `"${spec}" is ambiguous: matches format qualifier and vendor "${qualifierKey}" — ` +
          'use a path spec or full vendor name.',
      )
    }
    candidates = formatCandidates.length > 0 ? formatCandidates : vendorCandidates
  } else if (vendorKey !== undefined) {
    candidates = candidates.filter((entry) => normalizeCatalogKey(entry.vendor) === vendorKey)
  }

  if (candidates.length === 0) {
    throw new Error(
      `No plugin named "${spec}" found in the plugin catalog (${catalogPath}). ${RESCAN_HINT}`,
    )
  }

  if (vendorKey === undefined) {
    const distinctVendors = new Set(candidates.map((entry) => normalizeCatalogKey(entry.vendor)))
    if (distinctVendors.size > 1) {
      const listed = candidates.map((entry) => `"${entry.vendor}/${entry.name}" (${entry.format})`)
      throw new Error(
        `Plugin name "${spec}" is ambiguous across multiple vendors: ${listed.join(', ')}. ` +
          'Qualify it as "vendor/name" to disambiguate.',
      )
    }
  }

  const roleCandidates =
    role === undefined ? candidates : candidates.filter((entry) => entry.roles.includes(role))
  if (role !== undefined && roleCandidates.length === 0) {
    const foundRoles = [...new Set(candidates.flatMap((entry) => entry.roles))].join(', ') || 'none'
    throw new Error(
      `Plugin "${spec}" does not support the "${role}" role (catalog roles: ${foundRoles}).`,
    )
  }

  const accepted = acceptedFormatsForRole()
  const formatCandidates = roleCandidates.filter((entry) =>
    accepted.includes(entry.format.toLowerCase()),
  )
  if (formatCandidates.length === 0) {
    const foundFormats = [...new Set(roleCandidates.map((entry) => entry.format))].join(', ')
    throw new Error(
      `Plugin "${spec}" was found in the catalog only as [${foundFormats}], which ${role}() ` +
        `cannot host in v1 (accepts: ${accepted.join(', ')}).`,
    )
  }

  const chosen =
    formatCandidates.find((entry) => entry.format.toLowerCase() === 'clap') ?? formatCandidates[0]

  return { path: chosen.path, pluginId: chosen.pluginId, entries: candidates, entry: chosen }
}

/**
 * Resolves a method-form plugin against candidates already matched by normalized
 * method name. Qualification, ambiguity, role, and format precedence stay in the
 * same implementation used by string-form catalog resolution.
 */
export function resolveCatalogMethodCandidates(
  methodName: string,
  candidates: readonly PluginCatalogEntry[],
  format: string | undefined,
  vendor: string | undefined,
  role: PluginRole | undefined,
  catalogPathOverride?: string,
): ResolvedCatalogPlugin {
  const displayName = candidates[0]?.name ?? methodName
  const spec =
    format !== undefined
      ? `${format}/${displayName}`
      : vendor !== undefined
        ? `${vendor}/${displayName}`
        : displayName
  return resolveCatalogCandidates(spec, candidates, role, resolveCatalogPath(catalogPathOverride))
}

/**
 * Resolves a catalog (non-path) spec to its path, plugin ID, and matching catalog
 * entries per PC.2: exact name match (case-insensitive/trim/NFC), optional
 * `"vendor/name"` or `"format/name"` qualification, conditional role check, then
 * format preference (CLAP > VST3) among the formats the verb accepts (PH.3).
 * Passing `role: undefined` skips role filtering and returns all selected entries
 * so public callers can perform receiver-specific role dispatch themselves.
 */
export function resolveCatalogSpec(
  spec: string,
  role: PluginRole | undefined,
  catalogPathOverride: string | undefined,
): ResolvedCatalogPlugin {
  const catalogPath = resolveCatalogPath(catalogPathOverride)
  const catalog = loadPluginCatalog(catalogPathOverride)
  if (!catalog) {
    throw new Error(`Plugin catalog not found at ${catalogPath}. ${RESCAN_HINT}`)
  }

  const slashIndex = spec.indexOf('/')
  const nameKey = normalizeCatalogKey(slashIndex === -1 ? spec : spec.slice(slashIndex + 1))
  const candidates = catalog.plugins.filter((entry) => normalizeCatalogKey(entry.name) === nameKey)
  return resolveCatalogCandidates(spec, candidates, role, catalogPath)
}

export interface ResolvedPluginSpec {
  readonly path: string
  readonly pluginId: string | undefined
}

/**
 * Catalog-aware entry point for `effect()`/`instrument()` spec resolution (#463 C2). Path-direct
 * specs (PC.2 discriminator) resolve exactly as before via `resolvePluginPath`, and the caller's
 * `pluginIdArg` passes through untouched. Catalog names resolve `(path, pluginId)` together —
 * pairing a catalog name with an explicit `pluginIdArg` is an error, since the name already
 * pins a single pluginId (PC.2: "カタログ名指しと第2引数 pluginId の併用はエラー").
 */
export function resolvePluginSpec(
  spec: string,
  pluginIdArg: string | undefined,
  audioPaths: readonly string[],
  documentDirectory: string,
  role: PluginRole,
  catalogPathOverride?: string,
): ResolvedPluginSpec {
  if (isPluginPathSpec(spec)) {
    return {
      path: resolvePluginPath(spec, audioPaths, documentDirectory, role),
      pluginId: pluginIdArg,
    }
  }
  if (pluginIdArg !== undefined) {
    throw new Error(
      `A catalog plugin name ("${spec}") resolves its pluginId automatically; do not pass a ` +
        'second pluginId argument together with it (explicit pluginId is only for path specs).',
    )
  }
  const resolved = resolveCatalogSpec(spec, role, catalogPathOverride)
  return { path: resolved.path, pluginId: resolved.pluginId }
}
