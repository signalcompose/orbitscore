/**
 * Plugin catalog reader (#463 C2 — spec `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §PC.1/PC.2).
 *
 * Reads the daemon-generated catalog (`~/.orbitscore/plugin-catalog.json`, default location;
 * overridable via the `ORBIT_PLUGIN_CATALOG` env var so tests can point at a fixture) and
 * caches it in memory keyed by mtime, so repeated `effect()`/`instrument()` name-lookups in a
 * long-running daemon session don't re-parse the file on every call while still picking up a
 * rescan without a process restart.
 *
 * This module is pure I/O + typing; the matching/resolution rules (PC.2) live in
 * `plugin-resolver.ts`, which is the only intended caller.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface PluginCatalogEntry {
  readonly name: string
  readonly vendor: string
  /** Raw catalog format tag (C1 scanner emits lowercase `clap` / `vst3` / `component`). */
  readonly format: string
  readonly path: string
  readonly pluginId: string
  readonly roles: readonly string[]
}

export interface PluginCatalogFile {
  readonly version: number
  readonly scannedAt: string
  readonly plugins: readonly PluginCatalogEntry[]
  /** catalog v2 diagnostics; ignored by resolution and optional for v1 compatibility. */
  readonly artifacts?: readonly PluginCatalogArtifact[]
}

export interface PluginCatalogArtifact {
  readonly format: string
  readonly path: string
  readonly status: 'staticSuccess' | 'probePending' | 'probeSucceeded' | 'probeFailed'
  readonly reason?: string
  readonly durationMs?: number
  readonly failure?: {
    readonly code: string
    readonly message: string
    readonly exitCode?: number
    readonly signal?: number
  }
  readonly plugins?: readonly PluginCatalogEntry[]
}

function defaultCatalogPath(): string {
  return path.join(os.homedir(), '.orbitscore', 'plugin-catalog.json')
}

/** Resolves the catalog file path: explicit override > `ORBIT_PLUGIN_CATALOG` env > default. */
export function resolveCatalogPath(override?: string): string {
  return override ?? process.env.ORBIT_PLUGIN_CATALOG ?? defaultCatalogPath()
}

interface CacheEntry {
  readonly mtimeMs: number
  readonly catalog: PluginCatalogFile
}

const cache = new Map<string, CacheEntry>()

/**
 * Loads and parses the plugin catalog, or returns `undefined` if it doesn't exist yet
 * (not-yet-scanned — caller turns this into an actionable "run orbit-plugin-scan" error).
 * Malformed JSON is allowed to throw — that's a real corruption the caller should surface.
 */
export function loadPluginCatalog(catalogPathOverride?: string): PluginCatalogFile | undefined {
  const catalogPath = resolveCatalogPath(catalogPathOverride)

  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(catalogPath).mtimeMs
  } catch {
    cache.delete(catalogPath)
    return undefined
  }

  const cached = cache.get(catalogPath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.catalog

  const raw = fs.readFileSync(catalogPath, 'utf8')
  const catalog = JSON.parse(raw) as PluginCatalogFile
  cache.set(catalogPath, { mtimeMs, catalog })
  return catalog
}

/** Test-only: forces the next `loadPluginCatalog()` call to re-read from disk. */
export function clearPluginCatalogCache(): void {
  cache.clear()
}
