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

/**
 * 親 scanner 全体の固定上限。per-artifact 20s × 261件 / 同時4件 ≒ 22分の人工的な
 * worst case を覆う30分にする。完全撤去すると network volume の stat や supervisor /
 * catalog write 自体のハングで palette/MCP が永久に固まるため、過去レビュー Important
 * の防護は残す。進捗 protocol を増やす inactivity timeout より B1 の表面を狭く保てる。
 */
const SCAN_TIMEOUT_MS = 30 * 60_000
/** Rust scanner supervision's `PROCESS_KILL_WAIT_TIMEOUT`と同じ意味の二段目上限。 */
const PROCESS_KILL_WAIT_TIMEOUT = 2_000

const activePluginScans = new Set<child_process.ChildProcess>()

function killPluginScanProcessGroup(child: child_process.ChildProcess): void {
  if (process.platform === 'win32') {
    child.kill('SIGKILL')
  } else if (child.pid !== undefined) {
    process.kill(-child.pid, 'SIGKILL')
  }
}

/**
 * Best-effort shutdown for extension deactivation. On Unix each scanner is detached so its
 * native-probe descendants can be killed with the scanner's negative process-group id.
 */
export function terminateActivePluginScans(): void {
  for (const child of activePluginScans) {
    try {
      killPluginScanProcessGroup(child)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        activePluginScans.delete(child)
      }
    }
  }
}

export interface PluginCatalogEntry {
  readonly name: string
  readonly vendor: string
  /** Raw scanner format tag: lowercase `clap` / `vst3` (AU is not scanned). */
  readonly format: string
  readonly path: string
  readonly pluginId: string
  readonly roles: readonly string[]
}

export interface PluginCatalogFile {
  readonly version: number
  readonly scannedAt: string
  readonly plugins: readonly PluginCatalogEntry[]
  /** catalog v2 diagnostics; optional so v1 files remain readable during upgrades. */
  readonly artifacts?: readonly PluginCatalogArtifact[]
}

export interface PluginCatalogArtifact {
  readonly format: string
  readonly path: string
  readonly fingerprint?: {
    readonly scannerSchemaVersion: number
    readonly format: string
    readonly canonicalBundlePath: string
    readonly executableRelativePath: string
    readonly executableResolution?:
      | 'directFile'
      | 'coreFoundation'
      | 'infoPlistXml'
      | 'convention'
      | 'directoryScan'
    readonly executableSize?: number
    readonly executableModifiedNs?: string
    readonly infoPlistSize?: number
    readonly infoPlistModifiedNs?: string
  }
  readonly status: 'staticSuccess' | 'probePending' | 'probeSucceeded' | 'probeFailed'
  readonly source?: string
  readonly reason?: string
  readonly durationMs?: number
  readonly descriptorApis?: readonly string[]
  readonly failure?: {
    readonly code: string
    readonly message: string
    readonly hostArch?: string
    readonly slices?: readonly string[]
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
  readonly artifactCount: number
  readonly cachePath: string
  readonly skipped: readonly string[]
  readonly failures: readonly PluginScanFailure[]
  readonly summary: PluginScanSummary
}

export interface PluginScanFailure {
  readonly path: string
  readonly code: string
  readonly message: string
  readonly hostArch?: string
  readonly slices?: readonly string[]
}

export interface PluginScanSummary {
  readonly success: number
  readonly pending: number
  readonly failure: number
  readonly failureReasons: Readonly<Record<string, number>>
  readonly durationMs: {
    readonly p50: number | null
    readonly p95: number | null
    readonly max: number | null
  }
  readonly timeouts: number
  readonly crashes: number
  readonly factoryVersions: Readonly<Record<string, number>>
  readonly cacheHits: number
  readonly probeAttempts: number
}

export type RunPluginScanResult = ({ ok: true } & PluginScanOutcome) | { ok: false; error: string }

/**
 * Spawns `orbit-plugin-scan`, parses its single-line JSON stdout summary, and
 * invalidates the in-memory catalog cache on success so the next
 * `loadPluginCatalog()` call picks up the fresh scan without a process restart.
 */
export function runPluginScan(
  explicitBinaryPath?: string,
  timeoutMs = SCAN_TIMEOUT_MS,
  killWaitTimeout = PROCESS_KILL_WAIT_TIMEOUT,
): Promise<RunPluginScanResult> {
  return new Promise((resolve) => {
    let binaryPath: string
    try {
      binaryPath = resolvePluginScanBinaryPath(explicitBinaryPath)
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }

    // `detached` makes the scanner its own process-group leader on Unix. A scanner supervises
    // native probe children (which can spawn helpers), so a parent timeout must kill the negative
    // process-group id rather than only the scanner PID or those descendants become orphans.
    const child = child_process.spawn(binaryPath, ['--probe-artifacts'], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activePluginScans.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let terminationError: string | undefined
    let killWaitTimer: NodeJS.Timeout | undefined
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const finish = (result: RunPluginScanResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killWaitTimer) clearTimeout(killWaitTimer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        killPluginScanProcessGroup(child)
      } catch (error) {
        const systemError = error as NodeJS.ErrnoException
        if (systemError.code !== 'ESRCH') {
          terminationError = error instanceof Error ? error.message : String(error)
        }
      }
      killWaitTimer = setTimeout(() => {
        const terminationDetail = terminationError ? `; group kill failed: ${terminationError}` : ''
        finish({
          ok: false,
          error: `plugin scan did not exit within ${killWaitTimeout / 1000} seconds after process-group SIGKILL${terminationDetail}`,
        })
      }, killWaitTimeout)
    }, timeoutMs)

    child.once('error', (error) => {
      activePluginScans.delete(child)
      finish({ ok: false, error: error.message })
    })
    child.once('close', (code, signal) => {
      activePluginScans.delete(child)
      if (timedOut) {
        const terminationDetail = terminationError ? `; group kill failed: ${terminationError}` : ''
        finish({
          ok: false,
          error: `plugin scan timed out after ${timeoutMs / 1000}s (a plugin may be hanging during metadata read) — binary: ${binaryPath}${terminationDetail}`,
        })
        return
      }
      if (code !== 0) {
        finish({
          ok: false,
          error:
            stderr.trim() || `plugin scanner exited with code ${code} (signal ${signal ?? 'none'})`,
        })
        return
      }
      try {
        const parsed = JSON.parse(stdout) as PluginScanOutcome
        clearPluginCatalogCache()
        finish({
          ok: true,
          count: parsed.count,
          artifactCount: parsed.artifactCount,
          cachePath: parsed.cachePath,
          skipped: parsed.skipped,
          failures: parsed.failures,
          summary: parsed.summary,
        })
      } catch (parseError) {
        const reason = parseError instanceof Error ? parseError.message : String(parseError)
        finish({ ok: false, error: `failed to parse orbit-plugin-scan output: ${reason}` })
      }
    })
  })
}
