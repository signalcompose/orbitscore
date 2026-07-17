/**
 * Plugin catalog reader for the VS Code extension (#463 C1b/C3).
 *
 * Deliberately independent from `packages/engine/src/core/global/plugin-catalog.ts`
 * (same JSON shape, same mtime-cache idea) rather than a cross-package import:
 * the extension and engine are separate build targets (engine ships as compiled
 * JS copied into `engine/dist/`, see `scripts/copy-daemon-bin.sh` / build:engine),
 * so this module reads the on-disk cache file directly instead of reaching into
 * engine source.
 *
 * Catalog file: `~/.orbitscore/plugin-catalog.json`, written by the
 * `orbit-plugin-scan` binary (rust/crates/orbit-plugin-scan). Consumers here
 * only read it — the extension's job is completion (C3) + MCP tools (PC.4) +
 * spawning a rescan (C1b), never writing the catalog itself.
 */

import * as child_process from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface PluginCatalogEntry {
  readonly name: string
  readonly vendor: string
  /** Raw scanner format tag: lowercase `clap` / `vst3` / `component`. */
  readonly format: string
  readonly path: string
  readonly pluginId: string
  readonly roles: readonly string[]
}

export interface PluginCatalogFile {
  readonly version: number
  readonly scannedAt: string
  readonly plugins: readonly PluginCatalogEntry[]
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
 * Loads and parses the plugin catalog, or returns `undefined` if it doesn't
 * exist yet (not-yet-scanned — callers turn this into an actionable "run
 * rescan" message/error). Malformed JSON is allowed to throw.
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

/** Forces the next `loadPluginCatalog()` call to re-read from disk (used after a rescan, and by tests). */
export function clearPluginCatalogCache(): void {
  cache.clear()
}

function isExecutableFile(candidatePath: string): boolean {
  try {
    const stat = fs.statSync(candidatePath)
    if (!stat.isFile()) return false
    return (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export class PluginScanBinaryNotFoundError extends Error {
  constructor(readonly searched: readonly string[]) {
    super(`orbit-plugin-scan binary not found. Searched: ${searched.join(', ')}`)
    this.name = 'PluginScanBinaryNotFoundError'
  }
}

/**
 * Resolve the `orbit-plugin-scan` binary path. Candidate order mirrors
 * `resolveDaemonBinaryPath` in `packages/engine/src/audio/rust-engine/daemon-client.ts`:
 * explicit override → `ORBIT_PLUGIN_SCAN_PATH` env → monorepo release build
 * (dev workflow) → .vsix-bundled binary (scripts/copy-daemon-bin.sh).
 */
export function resolvePluginScanBinaryPath(explicitPath?: string): string {
  const searched: string[] = []
  const candidates: string[] = []
  if (explicitPath) candidates.push(explicitPath)
  const envPath = process.env.ORBIT_PLUGIN_SCAN_PATH
  if (envPath) candidates.push(envPath)

  // This compiled file sits at `<extension>/dist/plugin-catalog-reader.js` once
  // built (mirrors extension.ts's __dirname convention); monorepo root is 3
  // levels up: dist -> vscode-extension -> packages -> root.
  const monorepoRoot = path.resolve(__dirname, '../../../')
  candidates.push(path.join(monorepoRoot, 'rust/target/release/orbit-plugin-scan'))
  candidates.push(path.join(monorepoRoot, 'rust/target/debug/orbit-plugin-scan'))

  const platform = `${process.platform}-${process.arch}`
  candidates.push(path.join(__dirname, '../engine/bin', platform, 'orbit-plugin-scan'))

  for (const candidate of candidates) {
    searched.push(candidate)
    if (isExecutableFile(candidate)) return candidate
  }
  throw new PluginScanBinaryNotFoundError(searched)
}

export interface PluginScanOutcome {
  readonly count: number
  readonly cachePath: string
  readonly skipped: readonly string[]
}

export type RunPluginScanResult = ({ ok: true } & PluginScanOutcome) | { ok: false; error: string }

/**
 * Spawns `orbit-plugin-scan`, parses its single-line JSON stdout summary, and
 * invalidates the in-memory catalog cache on success so the next
 * `loadPluginCatalog()` call picks up the fresh scan without a process restart.
 */
export function runPluginScan(explicitBinaryPath?: string): Promise<RunPluginScanResult> {
  return new Promise((resolve) => {
    let binaryPath: string
    try {
      binaryPath = resolvePluginScanBinaryPath(explicitBinaryPath)
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }

    child_process.execFile(binaryPath, [], (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: stderr?.trim() || error.message })
        return
      }
      try {
        const parsed = JSON.parse(stdout) as PluginScanOutcome
        clearPluginCatalogCache()
        resolve({
          ok: true,
          count: parsed.count,
          cachePath: parsed.cachePath,
          skipped: parsed.skipped,
        })
      } catch (parseError) {
        const reason = parseError instanceof Error ? parseError.message : String(parseError)
        resolve({ ok: false, error: `failed to parse orbit-plugin-scan output: ${reason}` })
      }
    })
  })
}
