/**
 * REAL OrbitStudio E2E over the Agent Bridge MCP server (#388).
 *
 * Launches an actual OrbitStudio.app (VSCodium-based) Extension Development
 * Host, drives it entirely through MCP tool calls (no vscode API, no
 * keyboard/UI automation), and verifies produced audio objectively via the
 * capture-seam WAV analyzer (wav-analysis.ts) — the same "verify without
 * listening" philosophy as WORK_LOG 6.189.
 *
 * ── Env contract ──
 *   ORBIT_GATED_ORBITSTUDIO=1   Required to enable this suite at all. Unset
 *                               (the default) → the whole describe block is
 *                               skipped via describe.skipIf, so this file
 *                               always parses and collects cleanly in normal
 *                               `npm test` runs.
 *   ORBITSTUDIO_APP=<path>      Overrides the OrbitStudio.app bundle path.
 *                               Default:
 *                               /Users/yamato/Src/proj_orbitscore/orbitstudio-build/vscodium/VSCode-darwin-arm64/OrbitStudio.app
 *                               If the resolved path doesn't exist, the test
 *                               is skipped with a console note (rather than
 *                               failing) even when the gate env var is set.
 *
 * Run gated (this launches a real GUI app and plays audible sound — do NOT
 * run unattended/unprompted):
 *
 *   npm run test:e2e:gated
 *
 * `npm run test:e2e:gated` itself passes a positional pattern
 * (`e2e/orbitstudio-mcp-gated`), but scoped under `--dir tests` — resolved
 * relative to that root, it can only match this one file. The dangerous case
 * is a MANUAL `npx vitest run <pattern>` WITHOUT `--dir tests`: from the repo
 * root, an unscoped positional pattern can glob-match stale copies under
 * .claude/worktrees/ and launch multiple real GUI apps.
 *
 * SAFETY (repeated at the kill call site too): the teardown/setup kill
 * pattern targets `OrbitStudio.app/Contents/MacOS` — a path fragment unique
 * to the OrbitStudio.app bundle. It must NEVER be broadened to something
 * that could match a general "Visual Studio Code" / Electron process —
 * killing the user's actual VS Code is a known past incident.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect, afterAll } from 'vitest'
import { parse, stringify } from 'yaml'

import {
  analyzeWavBuffer,
  estimateFundamentalHz,
} from '../../packages/vscode-extension/src/wav-analysis'

import { McpClient, pollInitialize, sleep, waitUntil } from './helpers/mcp-client'
import { RACK_CHAIN_GAIN_EXPECTATIONS } from './rack-chain-gain-expectations'

const GATE_ENV = 'ORBIT_GATED_ORBITSTUDIO'
const DEFAULT_APP_PATH =
  '/Users/yamato/Src/proj_orbitscore/orbitstudio-build/vscodium/VSCode-darwin-arm64/OrbitStudio.app'

const gated = Boolean(process.env[GATE_ENV])
const appPath = process.env.ORBITSTUDIO_APP?.trim() || DEFAULT_APP_PATH
const appAvailable = fs.existsSync(appPath)

if (gated && !appAvailable) {
  // eslint-disable-next-line no-console
  console.log(
    `[orbitstudio-mcp-gated] OrbitStudio app not found at ${appPath} — SKIPPING. ` +
      'Set ORBITSTUDIO_APP to override the default path.',
  )
}

const REPO_ROOT = path.resolve(__dirname, '../..')
const EXTENSION_DEV_PATH = path.join(REPO_ROOT, 'packages/vscode-extension')
const KICK_LOOP_FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/mcp-e2e/kick_loop.orbs')
const DIAGNOSTIC_FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/mcp-e2e/diagnostic_case.orbs')
// Real built CLAP bundles (rust-spike test fixtures, also used by the Rust-side
// outproc_*_gated tests) — used below so a real instrument declaration can
// actually succeed and stay registered, rather than a made-up path that fails
// to load and rolls back (see EffectChainMap.declareBody in effect-slot.ts).
const CLAP_TEST_SYNTH_PATH = path.join(
  REPO_ROOT,
  'rust-spike/clap-test-synth/target/release/CLAPTestSynth.clap',
)
const CLAP_TEST_EFFECT_PATH = path.join(
  REPO_ROOT,
  'rust-spike/clap-test-effect/target/release/CLAPTestEffect.clap',
)
/// 🔴 CLAP oracle も VST3 と同じく**その場でビルドする**。
///
/// 以前はパス定数を指すだけで、`fs.existsSync` で存在を確認していた。しかし
/// **存在は鮮度を意味しない** — 実際に 2026-07-29、`target/release/` に残っていた
/// 1ヶ月前（#557 で `PluginStateImpl` を足す前）のバンドルを掴み、
/// `plugin が CLAP_EXT_STATE を持たない` で state 保存が落ちた。テストは
/// **1ヶ月前の成果物を検証していた**。
///
/// VST3 側は最初から `package-oracle.sh` をその場で叩いており、CLAP 側だけが
/// 非対称だった。同じ形に揃える。`bundle-macos.sh` は `cd` を持たず cwd 依存なので
/// `cwd` を明示すること。
const CLAP_TEST_SYNTH_BUNDLE_SCRIPT = path.join(
  REPO_ROOT,
  'rust-spike/clap-test-synth/bundle-macos.sh',
)
const CLAP_TEST_EFFECT_BUNDLE_SCRIPT = path.join(
  REPO_ROOT,
  'rust-spike/clap-test-effect/bundle-macos.sh',
)
const VST3_SYNTH_PACKAGE_SCRIPT = path.join(
  REPO_ROOT,
  'rust/crates/orbit-vst3-synth-oracle/package-oracle.sh',
)
const VST3_EFFECT_PACKAGE_SCRIPT = path.join(
  REPO_ROOT,
  'rust/crates/orbit-vst3-gain-oracle/package-oracle.sh',
)

const GATED_PLUGIN_FIXTURE_NAMES = {
  clapSynth: 'CLAPTestSynth.clap',
  clapEffect: 'CLAPTestEffect.clap',
  vst3Synth: 'SynthOracle.vst3',
  vst3Effect: 'GainOracle.vst3',
  brokenClap: 'BrokenCatalogFixture.clap',
} as const
/** リポジトリにチェックインされた「ロードできないバンドル」。tmp を指すと実行後に壊れたリンクが残る。 */
const BROKEN_CATALOG_FIXTURE_SOURCE = path.join(
  REPO_ROOT,
  'tests/fixtures/plugin-catalog/BrokenCatalogFixture.invalid',
)
const USER_CLAP_PLUGIN_DIR = path.join(os.homedir(), 'Library/Audio/Plug-Ins/CLAP')
const USER_VST3_PLUGIN_DIR = path.join(os.homedir(), 'Library/Audio/Plug-Ins/VST3')
const GATED_PLUGIN_FIXTURE_PATHS = {
  clapSynth: path.join(USER_CLAP_PLUGIN_DIR, GATED_PLUGIN_FIXTURE_NAMES.clapSynth),
  clapEffect: path.join(USER_CLAP_PLUGIN_DIR, GATED_PLUGIN_FIXTURE_NAMES.clapEffect),
  vst3Synth: path.join(USER_VST3_PLUGIN_DIR, GATED_PLUGIN_FIXTURE_NAMES.vst3Synth),
  vst3Effect: path.join(USER_VST3_PLUGIN_DIR, GATED_PLUGIN_FIXTURE_NAMES.vst3Effect),
  brokenClap: path.join(USER_CLAP_PLUGIN_DIR, GATED_PLUGIN_FIXTURE_NAMES.brokenClap),
} as const
const GATED_PLUGIN_FIXTURE_PATH_ALLOWLIST = new Set(Object.values(GATED_PLUGIN_FIXTURE_PATHS))

const TEST_TIMEOUT_MS = 120_000
const TEARDOWN_TIMEOUT_MS = 30_000

/**
 * SAFETY: this exact pattern ONLY. `OrbitStudio.app/Contents/MacOS` is a path
 * fragment unique to the OrbitStudio.app bundle — it must never be widened
 * to match "Code" / "Electron" / VSCodium generally. Killing the user's
 * actual VS Code by an overbroad pkill pattern is a known past incident.
 * Uses execFileSync (no shell, fixed argv — not a template-built command
 * string) rather than exec/execSync.
 */
function killOrbitStudio(): void {
  try {
    execFileSync('pkill', ['-f', 'OrbitStudio.app/Contents/MacOS'], { stdio: 'ignore' })
  } catch {
    // pkill exits non-zero when no process matched — not an error here.
  }
}

/**
 * Replace exactly one E2E-owned fixture entry in the user's standard plugin dirs.
 * The runtime allowlist makes broad paths, globs, and unrelated installed plugins
 * impossible targets even if a future call site passes the wrong value.
 */
function replaceGatedPluginFixtureSymlink(sourcePath: string, fixturePath: string): void {
  if (!GATED_PLUGIN_FIXTURE_PATH_ALLOWLIST.has(fixturePath)) {
    throw new Error(`refusing to replace non-E2E plugin path: ${fixturePath}`)
  }
  fs.rmSync(fixturePath, { recursive: true, force: true })
  fs.symlinkSync(sourcePath, fixturePath)
}

/** Child command lines carry `--plugin <absolute path>`; use that tenant identity as the PID oracle. */
function pluginChildPids(pluginPath: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', pluginPath], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

/**
 * rack effect child（#628）の PID を **daemon のログから**読む。
 *
 * 🔴 なぜ `pluginChildPids` を使えないか: あれは child のコマンドラインに
 * `--plugin <絶対パス>` が現れることを前提に `pgrep -f` する。rack child は
 * **`--chain <manifest.json>`** で起動するので、プラグインのパスはコマンドラインに
 * 出ない（manifest はテンポラリファイル）。#628 §6 の R28-E1〜E10 はいずれも
 * 「child PID 不変 = respawn していない」を判定条件にしているため、別経路が要る。
 *
 * daemon は spawn 時に `[orbit-effect-rack] child spawned pid=<n> shm=<path>` を
 * `tracing::info!` で名乗る（`outproc_effect.rs`）。**MCP の tool 表面を増やさず**、
 * ERROR 計数や `[plugin-state]` 行と同じ `get_log` 経路で読めるようにしてある。
 *
 * @returns ログに現れた順の PID 配列（最後の要素が最新の spawn）
 */
export function rackChildPidsFromLog(logText: string): number[] {
  const pids: number[] = []
  for (const match of logText.matchAll(/\[orbit-effect-rack\] child spawned pid=(\d+)/g)) {
    const pid = Number(match[1])
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid)
  }
  return pids
}

/** rack child の最新 PID。spawn がまだならnull。 */
export function latestRackChildPid(logText: string): number | null {
  const pids = rackChildPidsFromLog(logText)
  return pids.length > 0 ? pids[pids.length - 1] : null
}

/**
 * **effect** child の PID を観測する（#628 で rack 化された経路）。
 *
 * 🔴 `pluginChildPids` は使えない。あれは child のコマンドラインに `--plugin <絶対パス>` が
 * 現れることを前提に `pgrep -f` するが、rack child は **`--chain <manifest.json>`** で起動し、
 * プラグインのパスがコマンドラインに出ない。**instrument 経路は従来どおり**なので、
 * `pluginChildPids` はそちら専用として残す。
 *
 * daemon が spawn 時に名乗る行（`outproc_effect.rs` の `tracing::info!`）を読む。
 */
async function effectChildPids(client: McpClient): Promise<number[]> {
  const log = (await client.call('get_log', { lines: 800 })).text
  return rackChildPidsFromLog(log)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Catalog drops create files here; bypass and standard-stage drops must not. */
function stateFileCount(statesDirectory: string): number {
  if (!fs.existsSync(statesDirectory)) return 0
  return fs.readdirSync(statesDirectory, { withFileTypes: true }).filter((entry) => entry.isFile())
    .length
}

type CatalogPluginEntry = {
  name: string
  format: string
  path: string
  pluginId: string
  roles: string[]
}

type CatalogRescanResult = {
  count: number
  artifactCount: number
  failures: Array<{ path: string; code: string; message: string }>
  summary: { success: number; pending: number; failure: number }
}

function catalogPluginsAt(
  plugins: CatalogPluginEntry[],
  pluginPath: string,
  format: string,
  role: 'effect' | 'instrument',
): CatalogPluginEntry[] {
  return plugins.filter(
    (entry) =>
      entry.path === pluginPath &&
      entry.format.toLowerCase() === format &&
      entry.roles.includes(role),
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe.skipIf(!gated)('OrbitStudio Agent Bridge MCP E2E (gated, real app)', () => {
  let child: ChildProcess | undefined
  let client: McpClient | undefined
  let tmpRoot: string | undefined
  // #392: save_file persists to disk (unlike edit_replace, which only touched
  // the in-memory buffer). We open a scratch copy inside tmpRoot — not the
  // tracked repo fixture — so the write lands in the temp dir that afterAll
  // already removes, and never dirties a committed file.
  let kickLoopWorkPath: string | undefined
  let workAudioDir: string | undefined
  let catalogClapSynthPath: string | undefined
  let catalogClapEffectPath: string | undefined
  let catalogVst3SynthPath: string | undefined
  let catalogVst3EffectPath: string | undefined
  let catalogClapSynthName: string | undefined
  let catalogClapEffectName: string | undefined
  let catalogVst3SynthName: string | undefined
  let catalogVst3EffectName: string | undefined
  let catalogRescanResult: CatalogRescanResult | undefined
  let catalogPlugins: CatalogPluginEntry[] | undefined
  let catalogErrorsBefore: number | undefined
  let catalogErrorsAfter: number | undefined
  let brokenCatalogPath: string | undefined

  const requireCatalogFixtures = () => {
    expect(catalogClapSynthPath, 'catalog CLAP synth path must be initialized').toBeDefined()
    expect(catalogClapEffectPath, 'catalog CLAP effect path must be initialized').toBeDefined()
    expect(catalogVst3SynthPath, 'catalog VST3 synth path must be initialized').toBeDefined()
    expect(catalogVst3EffectPath, 'catalog VST3 effect path must be initialized').toBeDefined()
    expect(catalogClapSynthName, 'catalog CLAP synth name must be initialized').toBeDefined()
    expect(catalogClapEffectName, 'catalog CLAP effect name must be initialized').toBeDefined()
    expect(catalogVst3SynthName, 'catalog VST3 synth name must be initialized').toBeDefined()
    expect(catalogVst3EffectName, 'catalog VST3 effect name must be initialized').toBeDefined()
    if (
      !catalogClapSynthPath ||
      !catalogClapEffectPath ||
      !catalogVst3SynthPath ||
      !catalogVst3EffectPath ||
      !catalogClapSynthName ||
      !catalogClapEffectName ||
      !catalogVst3SynthName ||
      !catalogVst3EffectName
    ) {
      throw new Error('main gated phase did not initialize catalog fixture state')
    }
    return {
      clapSynthPath: catalogClapSynthPath,
      clapEffectPath: catalogClapEffectPath,
      vst3SynthPath: catalogVst3SynthPath,
      vst3EffectPath: catalogVst3EffectPath,
      clapSynthName: catalogClapSynthName,
      clapEffectName: catalogClapEffectName,
      vst3SynthName: catalogVst3SynthName,
      vst3EffectName: catalogVst3EffectName,
    }
  }

  const waitForEngine = (running: boolean, timeoutMs: number, label: string) =>
    waitUntil(
      async () => {
        const stateRes = await client!.call('get_engine_state')
        return (JSON.parse(stateRes.text) as { running: boolean }).running === running
      },
      { intervalMs: 500, timeoutMs, label },
    )

  /**
   * R28 の engine start は、負荷時に実測された daemon ready-line timeout だけを 1 回 retry する。
   * app boot は suite 共有のまま。別種の失敗や 2 回目の失敗は output channel 付きで即座に赤にする。
   */
  const startR28Engine = async (
    activeClient: McpClient,
    label: string,
    captureWav?: string,
  ): Promise<void> => {
    const liveModeMarker = '🎵 Live coding mode'
    const startupTimeoutMarker = 'daemon ready line timeout after 10000ms'
    const markerCount = (log: string, marker: string): number => log.split(marker).length - 1
    // 🔴 `capture_wav` は **spawn 専用オプション**（daemon 起動時にしか適用されない）。
    // 既に別テストがエンジンを起動していると
    // 「engine is already running; requested spawn-only option(s): capture_wav」で弾かれる。
    // capture を要求する時は必ず一度落としてから起動する（#643 E2E 7本がこれで全滅した）。
    if (captureWav !== undefined) {
      await activeClient.call('stop_engine')
      await waitForEngine(false, 15_000, `${label} stopped before capture start`)
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const beforeLog = (await activeClient.call('get_log', { lines: 500 })).text
      const liveModeBefore = markerCount(beforeLog, liveModeMarker)
      const startupTimeoutsBefore = markerCount(beforeLog, startupTimeoutMarker)
      const started = await activeClient.call(
        'start_engine',
        captureWav === undefined ? {} : { capture_wav: captureWav },
      )
      if (started.isError) throw new Error(`${label} did not start: ${started.text}`)
      try {
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            return markerCount(log, liveModeMarker) > liveModeBefore
          },
          { intervalMs: 200, timeoutMs: 30_000, label: `${label} daemon-backed REPL ready` },
        )
        return
      } catch (error) {
        const startupLog = (await activeClient.call('get_log', { lines: 500 })).text
        const sawFreshKnownTimeout =
          markerCount(startupLog, startupTimeoutMarker) > startupTimeoutsBefore
        if (attempt === 1 && sawFreshKnownTimeout) {
          const stopped = await activeClient.call('stop_engine')
          expect(stopped.isError, stopped.text).toBe(false)
          await waitForEngine(false, 15_000, `${label} timed-out attempt stopped before retry`)
          continue
        }
        throw new Error(`${String(error)}\n--- OrbitScore output channel ---\n${startupLog}`)
      }
    }
  }

  type InstrumentCaptureSegment = { from: number; to: number }
  type InstrumentCaptureContext = {
    activeClient: McpClient
    catalog: ReturnType<typeof requireCatalogFixtures>
    segments: Record<string, InstrumentCaptureSegment>
    evaluate(code: string): Promise<void>
    captureSegment(name: string, durationMs?: number, settleMs?: number): Promise<void>
  }

  /**
   * 🔴 **これらは #633 が直るまで緑にならない**（2026-08-29 実測）。
   * `UI_CLOSED_DONE seq N has invalid completion` が **25ms 間隔でログを埋め尽くし**、
   * daemon が飽和して effect の適用が届かない（WORK_LOG 6.399 が
   * 「同欠陥のログ洪水による巻き添え」として別テストで記録済みの症状と同型）。
   *
   * 実装側の問題ではない根拠: **同じ実行で audio シーケンスの effect は効いている**
   * （#625 R-E1-R-E7 が緑・`a/dry = 0.323`）。instrument は同じラック機構を通る。
   *
   * #633 の修正後にこの7本を回すこと。**削除しない** — 直れば自動的に検証になる。
   *
   * #643 の7シナリオを、同じ実 OrbitStudio → run_selection → daemon capture → get_log
   * 経路で駆動する。`evaluate_orbitscore` の受理結果は補助的にしか使わず、成功判定は必ず
   * capture の区間 RMS/peak と固定500行窓の ERROR 件数で行う。
   */
  const captureInstrumentScenario = async (
    slug: string,
    initialDsl: readonly string[],
    body: (context: InstrumentCaptureContext) => Promise<void>,
  ) => {
    expect(client, '#643 setup must initialize the MCP client').toBeDefined()
    expect(tmpRoot, '#643 setup must initialize the scratch root').toBeDefined()
    if (!client || !tmpRoot) throw new Error('main gated phase did not initialize suite state')
    const activeClient = client
    const catalog = requireCatalogFixtures()
    const dslPath = path.join(tmpRoot, `643-${slug}.orbs`)
    const capturePath = path.join(tmpRoot, `643-${slug}.wav`)
    const countErrors = (log: string): number => (log.match(/ERROR:/g) ?? []).length
    const readLog = async (): Promise<string> =>
      (await activeClient.call('get_log', { lines: 500 })).text

    fs.writeFileSync(dslPath, initialDsl.join('\n') + '\n')
    await startR28Engine(activeClient, `#643 ${slug} capture engine`, capturePath)
    await sleep(1000)
    const errorsBefore = countErrors(await readLog())
    const segments: Record<string, InstrumentCaptureSegment> = {}
    let stopWall = Date.now()

    const evaluate = async (code: string): Promise<void> => {
      const result = await activeClient.call('evaluate_orbitscore', { code })
      expect(result.isError, result.text).toBe(false)
    }
    const captureSegment = async (
      name: string,
      durationMs = 2000,
      settleMs = 400,
    ): Promise<void> => {
      if (settleMs > 0) await sleep(settleMs)
      const from = Date.now()
      await sleep(durationMs)
      segments[name] = { from, to: Date.now() }
    }

    try {
      const opened = await activeClient.call('open_file', { path: dslPath })
      expect(opened.isError, opened.text).toBe(false)
      const selected = await activeClient.call('set_selection', {
        start_line: 1,
        start_char: 1,
        end_line: initialDsl.length,
        end_char: 999_999,
      })
      expect(selected.isError, selected.text).toBe(false)
      const run = await activeClient.call('run_selection')
      expect(run.isError, run.text).toBe(false)

      await body({ activeClient, catalog, segments, evaluate, captureSegment })
      const finalLog = await readLog()
      expect(
        countErrors(finalLog),
        `#643 ${slug} must add no ERROR lines. Log tail: ${finalLog.slice(-1600)}`,
      ).toBeLessThanOrEqual(errorsBefore)
    } finally {
      await activeClient.call('evaluate_orbitscore', { code: 'global.stop()' })
      const stopped = await activeClient.call('stop_engine')
      expect(stopped.isError, stopped.text).toBe(false)
      stopWall = Date.now()
      await waitForEngine(false, 15_000, `#643 ${slug} capture engine stopped`)
      await sleep(1000)
    }

    const capture = fs.readFileSync(capturePath)
    const analysis = analyzeWavBuffer(capture, { windowMs: 20 })
    const range = (segment: InstrumentCaptureSegment, guardSec = 0.15) => ({
      fromSec: Math.max(0, analysis.durationSec - (stopWall - segment.from) / 1000 + guardSec),
      toSec: Math.min(
        analysis.durationSec,
        analysis.durationSec - (stopWall - segment.to) / 1000 - guardSec,
      ),
    })
    const windows = (name: string, guardSec = 0.15) => {
      const segment = segments[name]
      expect(segment, `#643 ${slug} segment '${name}' must exist`).toBeDefined()
      const requested = range(segment!, guardSec)
      const selected = (analysis.windows ?? []).filter(
        (window) => window.startSec >= requested.fromSec && window.startSec < requested.toSec,
      )
      expect(
        selected.length,
        `#643 ${slug} segment '${name}' must contain windows`,
      ).toBeGreaterThan(0)
      return selected
    }
    const rms = (name: string, guardSec = 0.15): number => {
      const selected = windows(name, guardSec)
      return Math.sqrt(
        selected.reduce((sum, window) => sum + window.rms * window.rms, 0) / selected.length,
      )
    }
    return { analysis, capture, range, windows, rms, segments }
  }

  afterAll(async () => {
    // Teardown: best-effort, always runs, never throws past this hook.
    if (client) {
      try {
        await client.call('stop_engine')
      } catch {
        // best-effort — the process may already be gone.
      }
    }
    killOrbitStudio()
    if (child && !child.killed) {
      try {
        child.kill()
      } catch {
        // best-effort
      }
    }
    // Deliberately keep the five standard-directory fixture symlinks installed.
    // The four real fixtures point at bundles rebuilt in place, so they cannot
    // become stale; the broken fixture intentionally models a broken user install.
    // A later setup removes and recreates only these exact allowlisted names.
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  }, TEARDOWN_TIMEOUT_MS)

  it.skipIf(!appAvailable)(
    'drives real OrbitStudio end-to-end: diagnostics-on-open, run_selection, live edit, capture verification',
    async () => {
      // ── 1. Setup: clear stray instances, fresh isolated dirs, pick a port ──
      killOrbitStudio()
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitstudio-mcp-e2e-'))
      const userDataDir = path.join(tmpRoot, 'user-data')
      const extensionsDir = path.join(tmpRoot, 'extensions')
      fs.mkdirSync(userDataDir, { recursive: true })
      fs.mkdirSync(extensionsDir, { recursive: true })
      // tmpRoot を workspace にしたため、リポジトリの .vscode/settings.json は効かない。
      // autoStartConfiguredRustEngine は保存済み audioDevice が無いと即 return するので、
      // デバイス名の存在確認をスキップするセンチネル __default__ を設定し、
      // マシン固有のデバイス名に依存せず拡張の auto-start を有効化する。
      const workspaceSettingsDir = path.join(tmpRoot, '.vscode')
      fs.mkdirSync(workspaceSettingsDir, { recursive: true })
      fs.writeFileSync(
        path.join(workspaceSettingsDir, 'settings.json'),
        JSON.stringify(
          {
            'orbitscore.audioDevice': '__default__',
            'orbitscore.engineDebug': false,
          },
          null,
          2,
        ) + '\n',
      )
      const captureWavPath = path.join(tmpRoot, 'capture.wav')
      // Scratch copy of the kick-loop fixture (basename preserved so the
      // languageId/path assertions below still hold): save_file writes here,
      // inside the tmpRoot that afterAll removes, instead of the tracked fixture.
      //
      // #528: the copy MUST reproduce the fixture's directory depth. The fixture
      // deliberately uses `audioPath("../../../test-assets/audio")` to prove that
      // `setDocumentDirectory` resolves relative paths against the edited file's
      // own directory — that relative form is the assertion, not an accident.
      // Copying it to a flat tmpRoot (the #392 behaviour) made `../../../` climb
      // out to `/var/folders/<x>/test-assets/audio`, so kick.wav was never found
      // (`[SAMPLE_NOT_FOUND]`) and the capture came back silent — the suite's most
      // valuable assertion was failing for a harness reason, unnoticed.
      //
      // Recreating `tests/fixtures/mcp-e2e/` under tmpRoot keeps the relative
      // resolution genuinely exercised (now rooted at tmpRoot instead of the repo).
      // 実プラグインを attach する前に CLAP oracle を release でビルドし直す
      // （定数の doc を参照 — 古いバンドルを検証してしまう事故が実際に起きた）。
      for (const script of [CLAP_TEST_SYNTH_BUNDLE_SCRIPT, CLAP_TEST_EFFECT_BUNDLE_SCRIPT]) {
        execFileSync('/bin/bash', [script, '--release'], {
          cwd: path.dirname(script),
          encoding: 'utf8',
        })
      }
      const vst3SynthPath = execFileSync(
        '/bin/bash',
        [VST3_SYNTH_PACKAGE_SCRIPT, 'release', 'mcp-e2e'],
        { encoding: 'utf8' },
      ).trim()
      const vst3EffectPath = execFileSync('/bin/bash', [VST3_EFFECT_PACKAGE_SCRIPT, 'release'], {
        encoding: 'utf8',
      }).trim()
      fs.mkdirSync(USER_CLAP_PLUGIN_DIR, { recursive: true })
      fs.mkdirSync(USER_VST3_PLUGIN_DIR, { recursive: true })
      catalogClapSynthPath = GATED_PLUGIN_FIXTURE_PATHS.clapSynth
      catalogClapEffectPath = GATED_PLUGIN_FIXTURE_PATHS.clapEffect
      catalogVst3SynthPath = GATED_PLUGIN_FIXTURE_PATHS.vst3Synth
      catalogVst3EffectPath = GATED_PLUGIN_FIXTURE_PATHS.vst3Effect
      brokenCatalogPath = GATED_PLUGIN_FIXTURE_PATHS.brokenClap
      // 🔴 symlink 先を tmp に置かない: 実行後に tmp が消えると標準ディレクトリに
      // **壊れたリンクが残り**、次回以降のスキャンに出続ける（今回直した stale bundle と
      // 同じ性質）。リポジトリ内のチェックイン済み fixture を指せば、リンクは常に有効な
      // まま「ロードできないバンドル」であり続ける — scanner に見せたい失敗は
      // 「ロード不能」であって「リンク切れ」ではない。
      const brokenCatalogSourcePath = BROKEN_CATALOG_FIXTURE_SOURCE
      replaceGatedPluginFixtureSymlink(CLAP_TEST_SYNTH_PATH, catalogClapSynthPath)
      replaceGatedPluginFixtureSymlink(CLAP_TEST_EFFECT_PATH, catalogClapEffectPath)
      replaceGatedPluginFixtureSymlink(vst3SynthPath, catalogVst3SynthPath)
      replaceGatedPluginFixtureSymlink(vst3EffectPath, catalogVst3EffectPath)
      replaceGatedPluginFixtureSymlink(brokenCatalogSourcePath, brokenCatalogPath)

      const fixtureRelDir = path.dirname(path.relative(REPO_ROOT, KICK_LOOP_FIXTURE))
      const workFixtureDir = path.join(tmpRoot, fixtureRelDir)
      fs.mkdirSync(workFixtureDir, { recursive: true })
      kickLoopWorkPath = path.join(workFixtureDir, path.basename(KICK_LOOP_FIXTURE))
      fs.copyFileSync(KICK_LOOP_FIXTURE, kickLoopWorkPath)
      // The audio the fixture's relative path must land on, mirrored at the same
      // depth from tmpRoot as it sits from REPO_ROOT.
      workAudioDir = path.join(tmpRoot, 'test-assets/audio')
      fs.mkdirSync(workAudioDir, { recursive: true })
      fs.copyFileSync(
        path.join(REPO_ROOT, 'test-assets/audio/kick.wav'),
        path.join(workAudioDir, 'kick.wav'),
      )
      const port = 39400 + Math.floor(Math.random() * 200)
      // Fixtures now live in the standard per-user plugin directories. Remove
      // ORBIT_PLUGIN_PATH even when inherited from the invoking shell so this E2E
      // cannot silently fall back to OrbitScore's extra scan-path escape hatch.
      const appEnv = { ...process.env }
      delete appEnv.ORBIT_PLUGIN_PATH

      // ── 2. Launch: `orbs` CLI with the extension in dev mode ──
      const orbsBin = path.join(appPath, 'Contents/Resources/app/bin/orbs')
      child = spawn(
        orbsBin,
        [
          '--new-window',
          `--extensionDevelopmentPath=${EXTENSION_DEV_PATH}`,
          `--user-data-dir=${userDataDir}`,
          `--extensions-dir=${extensionsDir}`,
          // `evaluate_orbitscore` は workspace root を documentDirectory として渡すので、
          // プロジェクト（project.yaml / states/）を置く tmpRoot を workspace として開く。
          // これはユーザーが曲フォルダを開く実際の使い方とも一致する。
          tmpRoot,
        ],
        {
          env: {
            ...appEnv,
            ORBITSCORE_MCP_PORT: String(port),
          },
          stdio: 'ignore',
          detached: false,
        },
      )

      client = await pollInitialize(port, { intervalMs: 2000, timeoutMs: 60_000 })

      // Every plugin declaration in this gated suite follows the human/LLM path:
      // scan the four real fixtures once, then use the scanner's actual display
      // names everywhere. Exact path + format + role makes a missing or ambiguous
      // fixture a loud setup failure instead of inventing a catalog name here.
      const beforeCatalogLog = (await client.call('get_log', { lines: 500 })).text
      catalogErrorsBefore = (beforeCatalogLog.match(/ERROR:/g) ?? []).length
      const rescanCatalog = await client.call('rescan_plugins')
      expect(rescanCatalog.isError, rescanCatalog.text).toBe(false)
      catalogRescanResult = JSON.parse(rescanCatalog.text) as CatalogRescanResult
      const listedCatalog = await client.call('list_plugins')
      expect(listedCatalog.isError, listedCatalog.text).toBe(false)
      catalogPlugins = JSON.parse(listedCatalog.text) as CatalogPluginEntry[]
      const fixtureEntries = {
        clapSynth: catalogPluginsAt(catalogPlugins, catalogClapSynthPath, 'clap', 'instrument'),
        clapEffect: catalogPluginsAt(catalogPlugins, catalogClapEffectPath, 'clap', 'effect'),
        vst3Synth: catalogPluginsAt(catalogPlugins, catalogVst3SynthPath, 'vst3', 'instrument'),
        vst3Effect: catalogPluginsAt(catalogPlugins, catalogVst3EffectPath, 'vst3', 'effect'),
      }
      expect(fixtureEntries.clapSynth, 'catalog must contain exactly one CLAP synth').toHaveLength(
        1,
      )
      expect(
        fixtureEntries.clapEffect,
        'catalog must contain exactly one CLAP effect',
      ).toHaveLength(1)
      expect(fixtureEntries.vst3Synth, 'catalog must contain exactly one VST3 synth').toHaveLength(
        1,
      )
      expect(
        fixtureEntries.vst3Effect,
        'catalog must contain exactly one VST3 effect',
      ).toHaveLength(1)
      const [clapSynthEntry] = fixtureEntries.clapSynth
      const [clapEffectEntry] = fixtureEntries.clapEffect
      const [vst3SynthEntry] = fixtureEntries.vst3Synth
      const [vst3EffectEntry] = fixtureEntries.vst3Effect
      for (const entry of [clapSynthEntry, clapEffectEntry, vst3SynthEntry, vst3EffectEntry]) {
        expect(
          entry?.name.trim().length,
          'catalog fixture display name must be non-empty',
        ).toBeGreaterThan(0)
        expect(
          entry?.pluginId.length,
          'catalog fixture pluginId must be non-empty',
        ).toBeGreaterThan(0)
      }
      // 🔴 fixture パスに1件在ることだけでは足りない。**同じ表示名を持つ別実体**が
      // カタログに混ざっていると、DSL の名前解決は「カタログ順の先頭」を選ぶため
      // fixture ではない実体がロードされる。実際に起きた（2026-08-26）:
      // `~/Library/Audio/Plug-Ins/CLAP/CLAPTestEffect.clap` に 7/28 の古いビルドが
      // 残留しており、そちらが先勝ちして `clap.state` を持たない実体がロードされ、
      // state 保存だけが `PLUGIN_STATE_UNSUPPORTED` で落ちた。**名前解決が指す実体が
      // 一意であることを setup で loud に検査する。**
      for (const entry of [clapSynthEntry, clapEffectEntry, vst3SynthEntry, vst3EffectEntry]) {
        const sameName = catalogPlugins.filter(
          (candidate) =>
            candidate.name === entry!.name &&
            candidate.format.toLowerCase() === entry!.format.toLowerCase(),
        )
        expect(
          sameName.map((candidate) => candidate.path),
          `catalog display name "${entry!.name}" must resolve to exactly one artifact; ` +
            'a duplicate install shadows the fixture because name resolution takes the ' +
            'first catalog candidate (remove the stale copy from the OS plugin dirs)',
        ).toEqual([entry!.path])
      }
      catalogClapSynthName = clapSynthEntry!.name
      catalogClapEffectName = clapEffectEntry!.name
      catalogVst3SynthName = vst3SynthEntry!.name
      catalogVst3EffectName = vst3EffectEntry!.name
      const afterCatalogLog = (await client.call('get_log', { lines: 500 })).text
      catalogErrorsAfter = (afterCatalogLog.match(/ERROR:/g) ?? []).length
      const catalog = requireCatalogFixtures()

      // ── 3. start_engine with capture_wav, wait for it to come up ──
      // 拡張は activate 時に engine を自動起動する。capture は spawn 時の
      // `ORBIT_CAPTURE_WAV` でしか有効化できない (#528) ので、自動起動した engine を
      // 一度落としてから capture 付きで起動し直す。自動起動の spawn 完了を待たずに
      // stop すると取りこぼすため、running を確認してから止める。
      await waitForEngine(true, 30_000, 'auto-started engine running')
      // #528 回帰ピン: capture は spawn 時にしか有効化できないので、既に走っている
      // engine に対する capture 付き start_engine は **失敗を返さなければならない**。
      // 旧実装はここで `ok: true, 'engine already running'` を返して captureWav を
      // 黙って捨てていた — 呼び出し側は録れていると信じ、capture.wav を読む段で
      // 初めて ENOENT に気づく（agent からは原因の分からない失敗になる）。
      const captureWhileRunning = await client.call('start_engine', {
        capture_wav: captureWavPath,
      })
      expect(captureWhileRunning.isError, captureWhileRunning.text).toBe(true)
      expect(captureWhileRunning.text).toContain('stop_engine')
      const stateAfterCaptureReject = await client.call('get_engine_state')
      expect(
        (JSON.parse(stateAfterCaptureReject.text) as { running: boolean }).running,
        stateAfterCaptureReject.text,
      ).toBe(true)

      const debugWhileRunning = await client.call('start_engine', { debug: true })
      expect(debugWhileRunning.isError, debugWhileRunning.text).toBe(true)
      expect(debugWhileRunning.text).toContain('stop_engine')
      // #527 review round 3 Minor #1: a `running === true` re-check here was
      // removed — capture and debug rejects both fall through
      // decideStartEngineForAgent's SAME single `spawnOnlyOptions.length > 0`
      // branch (engine-lifecycle.ts), which returns before touching engine
      // state either way. The `stateAfterCaptureReject` check above already
      // exercises that exact early-return path end-to-end; repeating it here
      // adds no additional detection power (a mutant that made either reject
      // branch tear the engine down would already be caught above). What
      // DOES still add value for the debug case — and is kept — is the
      // `.toContain('stop_engine')` message-content check just above, which
      // proves the rejection message mentions "debug" rather than being
      // hardcoded to the capture wording (see the unit-level equivalent in
      // engine-lifecycle.spec.ts's `decideStartEngineForAgent` describe).

      const preStopRes = await client.call('stop_engine')
      expect(preStopRes.isError, preStopRes.text).toBe(false)
      await waitForEngine(false, 15_000, 'engine stopped')

      const startRes = await client.call('start_engine', { capture_wav: captureWavPath })
      expect(startRes.isError, startRes.text).toBe(false)

      try {
        await waitForEngine(true, 15_000, 'engine running')
      } catch (err) {
        // engine が上がらなかった理由は output channel にしか出ない（MCP の
        // get_engine_state は running の真偽しか返さない）。タイムアウトだけを
        // 報告すると毎回ここで手動再現する羽目になるので、失敗時にログを添える。
        let logText = '(unable to retrieve OrbitScore output channel)'
        try {
          logText = (await client.call('get_log', { lines: 120 })).text
        } catch (getLogErr) {
          // get_log 自身の失敗理由（例: ECONNREFUSED = 拡張ホストごと落ちた）は
          // 診断上重要なので握り潰さない。元の engine 起動タイムアウトは維持する。
          logText = `(unable to retrieve OrbitScore output channel: ${
            getLogErr instanceof Error ? getLogErr.message : String(getLogErr)
          })`
        }
        throw new Error(`${(err as Error).message}\n--- OrbitScore output channel ---\n${logText}`)
      }
      await sleep(2500) // audio init settle

      // ── 4. #384 behavioral check: diagnostics fire on open, no edit needed ──
      const openDiagRes = await client.call('open_file', { path: DIAGNOSTIC_FIXTURE })
      expect(openDiagRes.isError, openDiagRes.text).toBe(false)
      await sleep(1500)

      const diagRes = await client.call('get_diagnostics', { path: DIAGNOSTIC_FIXTURE })
      const diagList = JSON.parse(diagRes.text) as Array<{
        path: string
        diagnostics: unknown[]
      }>
      // Scoped by `path`, so getDiagnosticsForAgent() returns a single-element
      // array echoing the input path. Sum diagnostics across the returned list
      // rather than re-matching `.path` exactly — robust to any path
      // normalization difference between what we sent and what comes back.
      const totalDiagnostics = diagList.reduce((sum, d) => sum + d.diagnostics.length, 0)
      expect(
        totalDiagnostics,
        `expected >=1 diagnostic for ${DIAGNOSTIC_FIXTURE}, got: ${diagRes.text}`,
      ).toBeGreaterThanOrEqual(1)

      // ── 5. Open kick_loop.orbs, sanity-check editor state, run the whole file ──
      const openKickRes = await client.call('open_file', { path: kickLoopWorkPath })
      expect(openKickRes.isError, openKickRes.text).toBe(false)
      await sleep(500)

      const editorStateRes = await client.call('get_editor_state')
      const editorState = JSON.parse(editorStateRes.text) as {
        path: string | null
        languageId: string | null
        lineCount: number | null
      }
      expect(editorState.languageId).toBe('orbitscore')
      // Both fixtures have languageId 'orbitscore' — also confirm kick_loop.orbs
      // (not diagnostic_case.orbs, opened just before it) is the active document.
      expect(editorState.path?.endsWith('kick_loop.orbs')).toBe(true)

      const kickLoopContent = fs.readFileSync(kickLoopWorkPath, 'utf8')
      const kickLoopLines = kickLoopContent.split('\n')
      const totalLines = kickLoopLines.length

      const selectAllRes = await client.call('set_selection', {
        start_line: 1,
        start_char: 1,
        end_line: totalLines,
        end_char: 999_999, // clamped by editor.document.validatePosition — see extension.ts setSelectionForAgent
      })
      expect(selectAllRes.isError, selectAllRes.text).toBe(false)

      const runAllRes = await client.call('run_selection')
      expect(runAllRes.isError, runAllRes.text).toBe(false)
      await sleep(4000) // sound plays at 120bpm

      // ── 6. Live edit: tempo 120 -> 180, re-run just that line ──
      const editRes = await client.call('edit_replace', {
        find: 'global.tempo(120)',
        replace: 'global.tempo(180)',
      })
      expect(editRes.isError, editRes.text).toBe(false)

      // ── 6a. #392: get_document_text sees the buffer edit; save_file persists it ──
      const docTextRes = await client.call('get_document_text')
      const docTextAfterEdit = JSON.parse(docTextRes.text) as {
        path: string | null
        text: string | null
      }
      expect(docTextAfterEdit.text?.includes('global.tempo(180)')).toBe(true)
      expect(docTextAfterEdit.text?.includes('global.tempo(120)')).toBe(false)

      const saveRes = await client.call('save_file')
      expect(saveRes.isError, saveRes.text).toBe(false)

      const savedFixtureContent = fs.readFileSync(kickLoopWorkPath, 'utf8')
      expect(
        savedFixtureContent.includes('global.tempo(180)'),
        'save_file did not persist the edit_replace change to disk',
      ).toBe(true)

      // Save again with nothing pending: the document is now clean, so this
      // exercises the isDirty no-op branch — the guard's whole reason to exist.
      // It must read as "clean" (ok, no write), NOT as a save failure.
      const saveNoopRes = await client.call('save_file')
      expect(saveNoopRes.isError, saveNoopRes.text).toBe(false)
      expect(saveNoopRes.text).toContain('no changes to save')

      const tempoLineIndex = kickLoopLines.findIndex((line) => line.includes('global.tempo(120)'))
      expect(tempoLineIndex, 'global.tempo(120) line not found in kick_loop.orbs fixture').not.toBe(
        -1,
      )
      const tempoLine1Based = tempoLineIndex + 1

      const selectTempoRes = await client.call('set_selection', {
        start_line: tempoLine1Based,
        start_char: 1,
        end_line: tempoLine1Based,
        end_char: 999_999,
      })
      expect(selectTempoRes.isError, selectTempoRes.text).toBe(false)

      const runTempoRes = await client.call('run_selection')
      expect(runTempoRes.isError, runTempoRes.text).toBe(false)
      await sleep(4000) // sound plays at 180bpm

      // ── 6b. #527 (S4 PR-1a): instrument duplicate declaration carries the S4
      // stage marker. The whole Global has exactly one v1 instrument slot
      // (PluginInstrumentManager — shared across sequences), so declaring a
      // second, different instrument must be rejected with a message that
      // names the follow-on stage (S4 PR-1b / #517 #522), not just a generic
      // "one instrument" message. Uses a dedicated fresh sequence (not `drum`,
      // which already has audio()/chop() — combining that with instrument()
      // hits a different, sequence-level guard first). `evaluate_orbitscore`'s
      // `ok` only means "accepted and written" (packages/vscode-extension/src/
      // extension.ts evaluateForAgent) — the actual accept/reject only shows
      // up in the engine's own stdout/stderr, surfaced here via get_log.
      const declareInstSeqRes = await client.call('evaluate_orbitscore', {
        code: 'var instSeq = init global.seq',
      })
      expect(declareInstSeqRes.isError, declareInstSeqRes.text).toBe(false)

      const firstInstrumentRes = await client.call('evaluate_orbitscore', {
        code: `instSeq.instrument(${JSON.stringify(catalog.clapSynthName)})`,
      })
      expect(firstInstrumentRes.isError, firstInstrumentRes.text).toBe(false)
      await sleep(6000) // real out-of-process CLAP attach: spawn + IPC handshake

      const afterFirstInstrumentLog = (await client.call('get_log', { lines: 500 })).text
      const firstInstrumentAttachFailed =
        afterFirstInstrumentLog.includes('[OUTPROC_ATTACH_FAILED]')
      expect(
        firstInstrumentAttachFailed,
        `the #562 real MCP state path requires a live CLAP instrument. Log tail: ${afterFirstInstrumentLog.slice(-800)}`,
      ).toBe(false)

      if (firstInstrumentAttachFailed) {
        // The real CLAP bundle failed to attach in this environment (e.g. no
        // outproc instrument child binary / codesigning gate in the packaged
        // extension host) — the duplicate-declaration branch requires an
        // existing successful registration to collide with, so it is not
        // reachable here. Recorded rather than silently asserting a vacuous
        // pass; see the invoking report for the actual log line observed.
        // eslint-disable-next-line no-console
        console.log(
          '[orbitstudio-mcp-gated] first instrument() attach failed — duplicate-declaration ' +
            `branch not exercised. Log tail: ${afterFirstInstrumentLog.slice(-400)}`,
        )
      } else {
        // ── #562: the same MCP state-save tool reaches all four hosted forms.
        // Attach one CLAP and one VST3 effect to audio receivers by their
        // scanner-provided catalog names
        // (v1 deliberately rejects seq.effect() on instrument sequences). This
        // stays below the one-instrument/one-effect-per-receiver limits while
        // exercising both daemon role selectors.
        const declareVst3SeqRes = await client.call('evaluate_orbitscore', {
          code: 'var vst3StateSeq = init global.seq',
        })
        expect(declareVst3SeqRes.isError, declareVst3SeqRes.text).toBe(false)
        const attachVst3InstrumentRes = await client.call('evaluate_orbitscore', {
          code: `vst3StateSeq.instrument(${JSON.stringify(catalog.vst3SynthName)})`,
        })
        expect(attachVst3InstrumentRes.isError, attachVst3InstrumentRes.text).toBe(false)
        const attachClapEffectRes = await client.call('evaluate_orbitscore', {
          code: `drum.effect(${JSON.stringify(catalog.clapEffectName)})`,
        })
        expect(attachClapEffectRes.isError, attachClapEffectRes.text).toBe(false)
        const declareVst3EffectSeqRes = await client.call('evaluate_orbitscore', {
          code: 'var vst3EffectSeq = init global.seq',
        })
        expect(declareVst3EffectSeqRes.isError, declareVst3EffectSeqRes.text).toBe(false)
        const attachVst3EffectRes = await client.call('evaluate_orbitscore', {
          code: `vst3EffectSeq.effect(${JSON.stringify(catalog.vst3EffectName)})`,
        })
        expect(attachVst3EffectRes.isError, attachVst3EffectRes.text).toBe(false)
        await sleep(12_000) // three real child spawns + READY handshakes

        const afterFourFormAttachLog = (await client.call('get_log', { lines: 500 })).text
        expect(
          (afterFourFormAttachLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? []).length,
          `all four #562 plugin forms must be live. Log tail: ${afterFourFormAttachLog.slice(-1200)}`,
        ).toBe(0)

        // Playing requests are rejected at the MCP boundary and must not stop
        // transport as a side effect. Count the engine's own stop marker before
        // and after the rejected request rather than inferring from process state.
        const stoppedBeforeRejectedSave = (
          afterFourFormAttachLog.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []
        ).length
        const rejectedWhilePlaying = await client.call('save_plugin_state', {
          sequence: 'instSeq',
          index: 0,
        })
        expect(rejectedWhilePlaying.isError, rejectedWhilePlaying.text).toBe(true)
        expect(rejectedWhilePlaying.text).toContain('transport is running')
        await sleep(500)
        const afterRejectedSaveLog = (await client.call('get_log', { lines: 500 })).text
        expect(
          (afterRejectedSaveLog.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length,
          `save rejection must not auto-stop transport. Log tail: ${afterRejectedSaveLog.slice(-800)}`,
        ).toBe(stoppedBeforeRejectedSave)

        // evaluate_orbitscore normally refreshes the workspace directory. Set
        // the scratch project directory last in this same evaluation so
        // project.yaml and states/ can only be written under tmpRoot.
        const escapedProjectDirectory = tmpRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        const stopForSaveRes = await client.call('evaluate_orbitscore', {
          code: `global.stop()\nglobal.setDocumentDirectory("${escapedProjectDirectory}")`,
        })
        expect(stopForSaveRes.isError, stopForSaveRes.text).toBe(false)
        await waitUntil(
          async () => {
            const log = (await client!.call('get_log', { lines: 500 })).text
            return (
              (log.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length >
              stoppedBeforeRejectedSave
            )
          },
          { intervalMs: 200, timeoutMs: 5_000, label: 'transport stopped before state save' },
        )

        const errorsBeforeStateSave = (
          (await client.call('get_log', { lines: 500 })).text.match(/ERROR:/g) ?? []
        ).length
        const stateRequests = [
          {
            sequence: 'instSeq',
            index: 0,
            identity: `instSeq/instrument/${catalog.clapSynthName}/0`,
          },
          {
            sequence: 'drum',
            index: 1,
            identity: `drum/effect/${catalog.clapEffectName}/0`,
          },
          {
            sequence: 'vst3StateSeq',
            index: 0,
            identity: `vst3StateSeq/instrument/${catalog.vst3SynthName}/0`,
          },
          {
            sequence: 'vst3EffectSeq',
            index: 1,
            identity: `vst3EffectSeq/effect/${catalog.vst3EffectName}/0`,
          },
        ] as const
        for (const request of stateRequests) {
          const response = await client.call('save_plugin_state', request)
          expect(response.isError, response.text).toBe(false)
          const saved = JSON.parse(response.text) as {
            path: string
            bytesWritten: number
            identityKey: string
            projectFile: string
            projectStatePath: string
          }
          expect(saved.bytesWritten).toBeGreaterThan(0)
          expect(saved.identityKey).toBe(request.identity)
          expect(saved.projectFile).toBe(path.join(tmpRoot, 'project.yaml'))
          expect(saved.projectStatePath.startsWith('states/')).toBe(true)
          expect(saved.path.startsWith(path.join(tmpRoot, 'states') + path.sep)).toBe(true)
          expect(fs.statSync(saved.path).size).toBe(saved.bytesWritten)
        }
        const projectYaml = fs.readFileSync(path.join(tmpRoot, 'project.yaml'), 'utf8')
        for (const request of stateRequests) expect(projectYaml).toContain(request.identity)

        const invalidStateIndex = await client.call('save_plugin_state', {
          sequence: 'drum',
          index: 99,
        })
        expect(invalidStateIndex.isError, invalidStateIndex.text).toBe(true)
        expect(invalidStateIndex.text).toContain('Valid indices:')
        expect(invalidStateIndex.text).toContain(`1 (effect, ${catalog.clapEffectName})`)

        // #474 P4c: the guard must fail before a different window can open, and
        // the loud response must carry role/name indices for agent self-correction.
        const guardedUiOpen = await client.call('open_plugin_ui', {
          receiver: 'drum',
          index: 1,
          expectedName: 'NotTheCurrentPlugin',
        })
        expect(guardedUiOpen.isError, guardedUiOpen.text).toBe(true)
        // 🔴 #628 が実装の文言に `re-evaluate first;` を挿入した（`global.ts` の
        // `pluginUiOperationError`）。アンカーは**実装からコピーする**規約なので、ここも追随する。
        // 実機ゲートで捕まえた — 文言を変えた PR がアンカーを更新し忘れていた。
        expect(guardedUiOpen.text).toContain(
          `current slot is '${catalog.clapEffectName}'; re-evaluate first; the UI was not opened`,
        )
        expect(guardedUiOpen.text).toContain(`Valid indices: 1 (effect, ${catalog.clapEffectName})`)

        const openedUi = await client.call('open_plugin_ui', {
          receiver: 'drum',
          index: 1,
          expectedName: catalog.clapEffectName,
        })
        expect(openedUi.isError, openedUi.text).toBe(false)
        expect(JSON.parse(openedUi.text)).toMatchObject({
          receiver: 'drum',
          index: 1,
          normalizedName: catalog.clapEffectName,
        })

        const closedUi = await client.call('close_plugin_ui', { receiver: 'drum', index: 1 })
        expect(closedUi.isError, closedUi.text).toBe(false)
        expect(JSON.parse(closedUi.text)).toMatchObject({
          receiver: 'drum',
          index: 1,
          completion: 'safepoint-completed',
        })
        const afterUiCloseLog = (await client.call('get_log', { lines: 500 })).text
        expect(afterUiCloseLog).not.toContain('timeout-without-save')

        // ── #617: DSL 面（`seq.ui()`）を実機で駆動する ──
        //
        // 🔴 UI の表示は視覚的な副作用なので直接は assert できない。そこで **`close_plugin_ui`
        // をオラクルに使う**: close は `openPluginUiSessions` にセッションが無ければ失敗する
        // （`no plugin UI opened via open_plugin_ui is recorded`）。したがって
        // 「DSL で open → MCP の close が成功する」が通れば、**DSL の呼び出しが本当に
        // `Global.openPluginUi` まで到達してセッションを登録した**ことの証明になる。
        //
        // これが無いと、パーサ/ディスパッチの取り違えをユニットテストは素通しする
        // （#528 / #614 で二度踏んだ形）。
        // 🔴 #628: `ui(数値 index)` は撤回された（SC.10.10.1）。宛先は**カタログ名**で指す。
        const dslUiOpen = await client.call('evaluate_orbitscore', {
          code: `drum.ui(${JSON.stringify(catalog.clapEffectName)})`,
        })
        expect(dslUiOpen.isError, dslUiOpen.text).toBe(false)

        const dslOpenedThenClosed = await client.call('close_plugin_ui', {
          receiver: 'drum',
          index: 1,
        })
        expect(
          dslOpenedThenClosed.isError,
          `DSL 経由の open がセッションを登録していない: ${dslOpenedThenClosed.text}`,
        ).toBe(false)

        // close が no-op でなかったことの確認: セッションは消えているので二度目は失敗する。
        const dslCloseAgain = await client.call('close_plugin_ui', { receiver: 'drum', index: 1 })
        expect(dslCloseAgain.isError, dslCloseAgain.text).toBe(true)
        expect(dslCloseAgain.text).toContain('no plugin UI opened')

        // 🔴 #619 F2b: 楽譜の再評価で二重 open にならない（冪等）。
        // 同じ行を2回評価しても、2回目が `OPEN_UI requested while lifecycle is Open` で
        // 落ちてはいけない — ライブコーディングでは再評価が常態。
        const dslUiReopen1 = await client.call('evaluate_orbitscore', {
          code: `drum.ui(${JSON.stringify(catalog.clapEffectName)})`,
        })
        expect(dslUiReopen1.isError, dslUiReopen1.text).toBe(false)
        const dslUiReopen2 = await client.call('evaluate_orbitscore', {
          code: `drum.ui(${JSON.stringify(catalog.clapEffectName)})`,
        })
        expect(dslUiReopen2.isError, dslUiReopen2.text).toBe(false)
        const afterReopenLog = (await client.call('get_log', { lines: 500 })).text
        expect(afterReopenLog).not.toContain('OPEN_UI requested while lifecycle is Open')

        // DSL 経由の close も同じ簿記に到達する。
        const dslUiClose = await client.call('evaluate_orbitscore', {
          code: `drum.ui(${JSON.stringify(catalog.clapEffectName)}, false)`,
        })
        expect(dslUiClose.isError, dslUiClose.text).toBe(false)
        const afterDslClose = await client.call('close_plugin_ui', { receiver: 'drum', index: 1 })
        expect(
          afterDslClose.isError,
          `DSL 経由の close がセッションを消していない: ${afterDslClose.text}`,
        ).toBe(true)

        const stateSaveLog = (await client.call('get_log', { lines: 500 })).text
        expect(
          (stateSaveLog.match(/ERROR:/g) ?? []).length,
          `successful #562 saves must add no ERROR: lines. Log tail: ${stateSaveLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeStateSave)

        // The human path rejects an effect-only catalog entry at role resolution,
        // before the daemon sees a replacement request. Pin both the loud error
        // and the absence of a new attach failure; daemon rollback remains covered
        // by the path-direct nonexistent-plugin scenarios below and in #618 E4.
        const attachFailuresBeforeRoleMismatch = (
          (await client.call('get_log', { lines: 500 })).text.match(/\[OUTPROC_ATTACH_FAILED\]/g) ??
          []
        ).length
        const secondInstrumentRes = await client.call('evaluate_orbitscore', {
          code: `instSeq.instrument(${JSON.stringify(catalog.clapEffectName)})`,
        })
        expect(secondInstrumentRes.isError, secondInstrumentRes.text).toBe(true)
        expect(secondInstrumentRes.text).toContain(
          `Plugin "${catalog.clapEffectName}" does not support the "instrument" role`,
        )

        const afterSecondInstrumentLog = (await client.call('get_log', { lines: 500 })).text
        expect(
          (afterSecondInstrumentLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? []).length,
          `catalog role rejection must not reach daemon attach. Log tail: ${afterSecondInstrumentLog.slice(-800)}`,
        ).toBe(attachFailuresBeforeRoleMismatch)
        expect(afterSecondInstrumentLog).not.toContain('restart the engine to change the plugin')

        // ── #540 P1 (b): 別シーケンスは自分の独立インスタンスを持てる（旧「エンジン
        // 全体で1台」制限の撤去がこの PR の表面）。同じ synth をもう1台 attach し、
        // 新規の attach 失敗が**増えない**ことを確認する。
        const attachFailuresBeforeSecondSeq = (
          afterSecondInstrumentLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? []
        ).length
        const declareInstSeq2Res = await client.call('evaluate_orbitscore', {
          code: 'var instSeq2 = init global.seq',
        })
        expect(declareInstSeq2Res.isError, declareInstSeq2Res.text).toBe(false)
        const secondSeqInstrumentRes = await client.call('evaluate_orbitscore', {
          code: `instSeq2.instrument(${JSON.stringify(catalog.clapSynthName)})`,
        })
        expect(secondSeqInstrumentRes.isError, secondSeqInstrumentRes.text).toBe(false)
        await sleep(6000) // 2台目の実 out-of-process attach（spawn + IPC handshake）

        const afterSecondSeqLog = (await client.call('get_log', { lines: 500 })).text
        const attachFailuresAfterSecondSeq = (
          afterSecondSeqLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? []
        ).length
        expect(
          attachFailuresAfterSecondSeq,
          `second sequence's own instrument must attach (no new OUTPROC_ATTACH_FAILED). Log tail: ${afterSecondSeqLog.slice(-800)}`,
        ).toBe(attachFailuresBeforeSecondSeq)
        expect(
          afterSecondSeqLog,
          `second sequence must NOT hit the same-sequence duplicate rejection. Log tail: ${afterSecondSeqLog.slice(-800)}`,
        ).not.toContain("Sequence 'instSeq2' already has an instrument instance")
      }

      // ── 6c. #527: a failed plugin declaration surfaces loudly AND the engine
      // remains usable afterward (EffectChainMap rollback path). Uses a
      // deliberately nonexistent plugin path — keep this path-direct so catalog
      // resolution cannot reject it before the daemon attach/rollback path runs.
      // No real plugin binary is needed
      // for this half, since resolvePluginSpec doesn't check fs existence for
      // path-direct specs (only the async out-of-process attach can fail).
      const beforeEffectFailLog = (await client.call('get_log', { lines: 500 })).text
      const attachFailedBefore = (beforeEffectFailLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? [])
        .length

      const badEffectRes = await client.call('evaluate_orbitscore', {
        code: 'global.effect("nonexistent-plugin.clap")',
      })
      // 🔴 #614 以降、`evaluate_orbitscore` は評価結果を返す。out-of-process attach の失敗も
      // 実行時エラーとして呼び出し元へ届くので `isError: true`。
      // （#614 以前は「stdin へ書けた」= ok が返り、失敗は get_log にしか出なかった。
      //  下のログ assert はその時代の名残だが、二重の確認として残す。）
      expect(badEffectRes.isError, badEffectRes.text).toBe(true)
      expect(badEffectRes.text).toContain('OUTPROC_ATTACH_FAILED')
      await sleep(6000) // real out-of-process attach attempt, then failure

      const afterEffectFailLog = (await client.call('get_log', { lines: 500 })).text
      expect(
        afterEffectFailLog,
        `expected an OUTPROC_ATTACH_FAILED error, got log tail: ${afterEffectFailLog.slice(-800)}`,
      ).toContain('[OUTPROC_ATTACH_FAILED] child exited before publishing READY')

      // Engine survives: a normal statement right after the failure must still
      // be accepted, and must not add a NEW attach failure of its own.
      const recoveryRes = await client.call('evaluate_orbitscore', {
        code: 'global.beat(4 by 4)',
      })
      expect(recoveryRes.isError, recoveryRes.text).toBe(false)
      await sleep(1000)

      const engineStateAfterFailure = await client.call('get_engine_state')
      expect(JSON.parse(engineStateAfterFailure.text).running).toBe(true)

      const afterRecoveryLog = (await client.call('get_log', { lines: 500 })).text
      const attachFailedAfterRecovery = (afterRecoveryLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? [])
        .length
      // Exactly one NEW attach failure (the deliberate one above) — the
      // recovery statement must not add another.
      const attachFailureLines = afterRecoveryLog
        .split('\n')
        .filter((line) => line.includes('[OUTPROC_ATTACH_FAILED]'))
      expect(
        attachFailedAfterRecovery,
        `attach-failure lines in window: ${JSON.stringify(attachFailureLines, null, 2)}`,
      ).toBe(attachFailedBefore + 1)

      // ── 6d. #521/#517 S3 regression guard: the mixer/routing DSL (bus-name
      // chain methods — mix.output/sum/aux, `.verb(0.3)` send, `.drums` sum
      // routing, `.master`) still evaluates cleanly through the real app after
      // the four-manager migration (#527). No ERROR: line (packages/vscode-
      // extension/src/extension.ts stderr handler) must appear for this batch.
      const beforeMixerLog = (await client.call('get_log', { lines: 500 })).text
      const errorCountBeforeMixer = (beforeMixerLog.match(/ERROR:/g) ?? []).length

      const mixerRes = await client.call('evaluate_orbitscore', {
        code: [
          'var mix = init global.mixer',
          'var master = mix.output(1, 2)',
          'var drums = mix.sum',
          'var verb = mix.aux',
          'verb.master',
          'drum.verb(0.3).drums',
          'drums.master',
        ].join('\n'),
      })
      expect(mixerRes.isError, mixerRes.text).toBe(false)
      await sleep(1500)

      const afterMixerLog = (await client.call('get_log', { lines: 500 })).text
      const errorCountAfterMixer = (afterMixerLog.match(/ERROR:/g) ?? []).length
      expect(
        errorCountAfterMixer,
        `expected no new ERROR: lines from the mixer/routing DSL, got log tail: ${afterMixerLog.slice(-800)}`,
      ).toBe(errorCountBeforeMixer)

      // ── 7. get_log sanity check — non-empty, evidence of engine activity ──
      const logRes = await client.call('get_log', { lines: 100 })
      expect(logRes.text.length).toBeGreaterThan(0)

      // ── 8. stop_engine, wait for capture to finalize ──
      const stopRes = await client.call('stop_engine')
      expect(stopRes.isError, stopRes.text).toBe(false)
      await sleep(1500)

      // ── 9. Objective audio verification (no listening required) ──
      const wavBuf = fs.readFileSync(captureWavPath)
      const analysis = analyzeWavBuffer(wavBuf)
      expect(analysis.soundDetected, JSON.stringify(analysis)).toBe(true)

      const gapsAt120bpm = analysis.onsetGaps.filter((g) => g >= 0.45 && g <= 0.57)
      const gapsAt180bpm = analysis.onsetGaps.filter((g) => g >= 0.29 && g <= 0.4)
      expect(
        gapsAt120bpm.length,
        `expected >=3 gaps in [0.45,0.57]s (120bpm), got onsetGaps: ${JSON.stringify(analysis.onsetGaps)}`,
      ).toBeGreaterThanOrEqual(3)
      expect(
        gapsAt180bpm.length,
        `expected >=3 gaps in [0.29,0.40]s (180bpm), got onsetGaps: ${JSON.stringify(analysis.onsetGaps)}`,
      ).toBeGreaterThanOrEqual(3)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    '#643 E2E-1 applies global.gain(-6) to a playing instrument at about half the 0 dB RMS',
    async () => {
      const catalog = requireCatalogFixtures()
      const result = await captureInstrumentScenario(
        'global-gain',
        [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.tempo(120)',
          'global.beat(4 by 4)',
          'global.gain(0)',
          'global.start()',
          'var gain643 = init global.seq',
          `gain643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'gain643.gate(1)',
          'gain643.play(1, 1, 1, 1)',
          'LOOP(gain643)',
        ],
        async ({ captureSegment, evaluate }) => {
          await captureSegment('unity')
          await evaluate('global.gain(-6)')
          await captureSegment('half')
        },
      )
      // 🔴 `global.gain()` は **dB**（`gain(valueDb?)`・-60..+12 にクランプ）。線形値ではない。
      // 0 dB -> -6 dB で amplitude は 10^(-6/20) ≈ 0.501 = 約半分。
      const unity = result.rms('unity')
      const half = result.rms('half')
      expect(unity, 'E2E-1 unity instrument must be audible').toBeGreaterThan(0.05)
      expect(half / unity, `E2E-1 half/unity RMS ratio (${half}/${unity})`).toBeGreaterThan(0.45)
      expect(half / unity, `E2E-1 half/unity RMS ratio (${half}/${unity})`).toBeLessThan(0.55)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    '#643 E2E-2 applies a -6 dB sequence rack to an instrument at about half dry RMS',
    async () => {
      const catalog = requireCatalogFixtures()
      const result = await captureInstrumentScenario(
        'sequence-effect',
        [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.tempo(120)',
          'global.beat(4 by 4)',
          'global.start()',
          'var dry643 = init global.seq',
          `dry643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'dry643.gate(1)',
          'dry643.play(1, 1, 1, 1)',
          'var wet643 = init global.seq',
          'wet643.effect([Gain(db: -6)])',
          `wet643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'wet643.gate(1)',
          'wet643.play(1, 1, 1, 1)',
          'LOOP(dry643)',
        ],
        async ({ captureSegment, evaluate }) => {
          await captureSegment('dry')
          await evaluate('dry643.stop()\nLOOP(wet643)')
          await captureSegment('wet')
        },
      )
      const dry = result.rms('dry')
      const wet = result.rms('wet')
      expect(dry, 'E2E-2 dry instrument must be audible').toBeGreaterThan(0.05)
      expect(wet / dry, `E2E-2 wet/dry RMS ratio (${wet}/${dry})`).toBeGreaterThan(0.45)
      expect(wet / dry, `E2E-2 wet/dry RMS ratio (${wet}/${dry})`).toBeLessThan(0.56)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    '#643 E2E-3 attaches effect() during instrument playback without a gap or spike',
    async () => {
      const catalog = requireCatalogFixtures()
      const result = await captureInstrumentScenario(
        'live-effect-attach',
        [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.tempo(120)',
          'global.beat(4 by 4)',
          'global.start()',
          'var live643 = init global.seq',
          `live643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'live643.gate(1)',
          'live643.play(1, 1, 1, 1)',
          'LOOP(live643)',
        ],
        async ({ captureSegment, evaluate, segments }) => {
          await captureSegment('dry')
          const from = Date.now() - 250
          await evaluate('live643.effect([Gain(db: -6)])')
          await sleep(500)
          segments.transition = { from, to: Date.now() }
          await captureSegment('wet')
        },
      )
      const dry = result.rms('dry')
      const wet = result.rms('wet')
      const transition = result.windows('transition', 0)
      const dryPeak = Math.max(...result.windows('dry').map((window) => window.peak))
      const transitionPeak = Math.max(...transition.map((window) => window.peak))
      const transitionFloor = Math.min(...transition.map((window) => window.rms))
      expect(wet / dry, `E2E-3 post-attach wet/dry ratio (${wet}/${dry})`).toBeGreaterThan(0.45)
      expect(wet / dry, `E2E-3 post-attach wet/dry ratio (${wet}/${dry})`).toBeLessThan(0.56)
      expect(
        transitionPeak,
        `E2E-3 transition peak ${transitionPeak} must not spike above dry ${dryPeak}`,
      ).toBeLessThanOrEqual(dryPeak * 1.15)
      expect(
        transitionFloor,
        `E2E-3 transition RMS floor ${transitionFloor} must not contain a dropout`,
      ).toBeGreaterThan(wet * 0.6)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    '#643 E2E-4 preserves instrument contributions through output(sum) plus send(aux, gain)',
    async () => {
      const catalog = requireCatalogFixtures()
      const result = await captureInstrumentScenario(
        'sum-and-aux',
        [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.tempo(120)',
          'global.beat(4 by 4)',
          'global.sum("sum643")',
          'global.aux("aux643")',
          'global.start()',
          'var routeDry643 = init global.seq',
          `routeDry643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'routeDry643.gate(1)',
          'routeDry643.play(1, 1, 1, 1)',
          'var routeWet643 = init global.seq',
          `routeWet643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'routeWet643.output("sum643")',
          'routeWet643.send("aux643", 0.5)',
          'routeWet643.gate(1)',
          'routeWet643.play(1, 1, 1, 1)',
          'LOOP(routeDry643)',
        ],
        async ({ captureSegment, evaluate }) => {
          await captureSegment('dry')
          await evaluate('routeDry643.stop()\nLOOP(routeWet643)')
          await captureSegment('sumAux')
        },
      )
      const dry = result.rms('dry')
      const sumAux = result.rms('sumAux')
      expect(dry, 'E2E-4 dry instrument must be audible').toBeGreaterThan(0.05)
      expect(
        sumAux / dry,
        `E2E-4 sum+aux/dry RMS ratio (${sumAux}/${dry}) must include the 0.5 send`,
      ).toBeGreaterThan(1.35)
      expect(sumAux / dry).toBeLessThan(1.65)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    '#643 E2E-5 keeps the sequence effect applied while replacing a playing instrument',
    async () => {
      const catalog = requireCatalogFixtures()
      const result = await captureInstrumentScenario(
        'replace-with-effect',
        [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.tempo(120)',
          'global.beat(4 by 4)',
          'global.start()',
          'var replace643 = init global.seq',
          'replace643.effect([Gain(db: -6)])',
          `replace643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'replace643.gate(1)',
          'replace643.play(1, 1, 1, 1)',
          'LOOP(replace643)',
        ],
        async ({ captureSegment, evaluate, catalog: activeCatalog }) => {
          await captureSegment('beforeReplace')
          await evaluate(`replace643.instrument(${JSON.stringify(activeCatalog.vst3SynthName)})`)
          await captureSegment('afterReplace')
          await evaluate('replace643.effect([])')
          await captureSegment('replacementDry')
        },
      )
      const before = result.rms('beforeReplace')
      const after = result.rms('afterReplace')
      const dry = result.rms('replacementDry')
      expect(before, 'E2E-5 pre-replacement effect output must be audible').toBeGreaterThan(0.02)
      expect(after, 'E2E-5 replacement must remain audible').toBeGreaterThan(0.02)
      expect(after / dry, `E2E-5 effected replacement/dry ratio (${after}/${dry})`).toBeGreaterThan(
        0.45,
      )
      expect(after / dry, `E2E-5 effected replacement/dry ratio (${after}/${dry})`).toBeLessThan(
        0.56,
      )
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    '#643 E2E-6 resets a released slot so its next instrument tenant starts dry',
    async () => {
      const catalog = requireCatalogFixtures()
      const result = await captureInstrumentScenario(
        'slot-reuse-reset',
        [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.tempo(120)',
          'global.beat(4 by 4)',
          'global.start()',
          'var oldTenant643 = init global.seq',
          'oldTenant643.effect([Gain(db: -6)])',
          `oldTenant643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'oldTenant643.gate(1)',
          'oldTenant643.play(1, 1, 1, 1)',
          'LOOP(oldTenant643)',
        ],
        async ({ captureSegment, evaluate, catalog: activeCatalog }) => {
          await captureSegment('oldWet')
          await evaluate(
            [
              `oldTenant643.instrument(${JSON.stringify(activeCatalog.vst3SynthName)})`,
              'oldTenant643.stop()',
              'var nextTenant643 = init global.seq',
              `nextTenant643.instrument(${JSON.stringify(activeCatalog.clapSynthName)})`,
              'nextTenant643.gate(1)',
              'nextTenant643.play(1, 1, 1, 1)',
              'LOOP(nextTenant643)',
            ].join('\n'),
          )
          await captureSegment('nextDry')
          await evaluate('nextTenant643.effect([Gain(db: -6)])')
          await captureSegment('nextWet')
        },
      )
      const dry = result.rms('nextDry')
      const wet = result.rms('nextWet')
      expect(dry, 'E2E-6 next tenant must produce dry audio').toBeGreaterThan(0.05)
      expect(wet / dry, `E2E-6 next-tenant wet/dry ratio (${wet}/${dry})`).toBeGreaterThan(0.45)
      expect(wet / dry, `E2E-6 next-tenant wet/dry ratio (${wet}/${dry})`).toBeLessThan(0.56)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    '#643 E2E-7 keeps an instrument with no mixer declaration audible at legacy dry RMS',
    async () => {
      const catalog = requireCatalogFixtures()
      const result = await captureInstrumentScenario(
        'default-master',
        [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.tempo(120)',
          'global.beat(4 by 4)',
          'global.start()',
          'var default643 = init global.seq',
          `default643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'default643.gate(1)',
          'default643.play(1, 1, 1, 1)',
          'LOOP(default643)',
        ],
        async ({ captureSegment }) => {
          await captureSegment('dry')
        },
      )
      const dry = result.rms('dry')
      expect(result.analysis.soundDetected, JSON.stringify(result.analysis)).toBe(true)
      expect(
        dry,
        'E2E-7 default-master instrument must match the oracle dry floor',
      ).toBeGreaterThan(0.1)
      expect(
        dry,
        'E2E-7 default-master instrument must remain below the 0.25-peak oracle RMS',
      ).toBeLessThan(0.2)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    'rescans catalog v2 through MCP, reports a broken bundle, and preserves a known CLAP fixture',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(catalogRescanResult, 'main gated phase must retain the rescan result').toBeDefined()
      expect(catalogPlugins, 'main gated phase must retain the catalog listing').toBeDefined()
      expect(
        catalogErrorsBefore,
        'main gated phase must retain the pre-rescan error count',
      ).toBeDefined()
      expect(
        catalogErrorsAfter,
        'main gated phase must retain the post-rescan error count',
      ).toBeDefined()
      expect(
        brokenCatalogPath,
        'main gated phase must create the deliberately broken bundle',
      ).toBeDefined()
      if (
        !client ||
        !catalogRescanResult ||
        !catalogPlugins ||
        catalogErrorsBefore === undefined ||
        catalogErrorsAfter === undefined ||
        !brokenCatalogPath
      ) {
        throw new Error('main gated phase did not initialize catalog fixture state')
      }
      const catalog = requireCatalogFixtures()

      expect(
        catalogRescanResult.summary.success +
          catalogRescanResult.summary.pending +
          catalogRescanResult.summary.failure,
      ).toBe(catalogRescanResult.artifactCount)
      expect(catalogRescanResult.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: brokenCatalogPath,
            code: 'bundleLoad',
          }),
        ]),
      )

      expect(catalogPlugins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: catalog.clapSynthName,
            path: catalog.clapSynthPath,
          }),
          expect.objectContaining({
            name: catalog.clapEffectName,
            path: catalog.clapEffectPath,
          }),
          expect.objectContaining({
            name: catalog.vst3SynthName,
            path: catalog.vst3SynthPath,
          }),
          expect.objectContaining({
            name: catalog.vst3EffectName,
            path: catalog.vst3EffectPath,
          }),
        ]),
      )
      expect(catalogErrorsAfter, 'catalog rescan must add no ERROR: lines').toBe(
        catalogErrorsBefore,
      )
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    'reports an ambiguous bare mixer name through run_selection and get_log',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      if (!client || !tmpRoot) throw new Error('main gated phase did not initialize suite state')
      const activeClient = client
      const dslPath = path.join(tmpRoot, 'ambiguous-mixer-name.orbs')
      const dslLines = [
        'var global = init GLOBAL',
        'global.sum("drum")',
        'global.aux("drum")',
        // Keep this nonexistent bundle path-direct: a catalog miss would fail
        // during TS resolution and never exercise the intended DSL ambiguity.
        'drum.effect("MustNotLoad.clap")',
      ]
      fs.writeFileSync(dslPath, dslLines.join('\n') + '\n')

      const start = await activeClient.call('start_engine')
      expect(start.isError, start.text).toBe(false)
      try {
        await waitForEngine(true, 15_000, 'ambiguous mixer-name E2E engine running')
        const opened = await activeClient.call('open_file', { path: dslPath })
        expect(opened.isError, opened.text).toBe(false)
        const selected = await activeClient.call('set_selection', {
          start_line: 1,
          start_char: 1,
          end_line: dslLines.length,
          end_char: 999_999,
        })
        expect(selected.isError, selected.text).toBe(false)

        const errorPrefix = '[ERROR] Mixer bus name "drum" is ambiguous'
        const beforeLog = (await activeClient.call('get_log', { lines: 500 })).text
        const errorsBefore = beforeLog.split(errorPrefix).length - 1
        const run = await activeClient.call('run_selection')
        expect(run.isError, run.text).toBe(false)
        // 🔴 #628 の実機ゲートで 3 回連続タイムアウトした。手で同じ DSL を評価したところ
        // 診断は期待どおり出る（`ERROR: [ERROR] Mixer bus name "drum" is ambiguous: …`）ので、
        // **機構ではなく待ち時間の問題**。`run_selection` は「選択を渡した」で即座に返り、
        // engine の評価は非同期なので、スイート後半（多数のプラグインをロード済み）では
        // 5 秒では届かない。このスイートの他の待ちは 10〜15 秒。
        //
        // アサーション自体は変えていない（件数の増加を見る）。**待ちを揃え、失敗時に
        // ログ末尾を添える**ようにしただけ — 次に落ちたときに原因が読めるように。
        // 🔴 label のテンプレート文字列は `waitUntil` を呼ぶ**前**に一度だけ評価されるので、
        // そこへログ末尾を埋めても常に空になる（実機ゲートで実際に空だった）。
        // 失敗時の診断は catch 側で組み立てる。
        let ambiguousLogTail = ''
        let ambiguousMatchCount = -1
        try {
          await waitUntil(
            async () => {
              const log = (await activeClient.call('get_log', { lines: 500 })).text
              ambiguousLogTail = log.slice(-2500)
              ambiguousMatchCount = log.split(errorPrefix).length - 1
              return ambiguousMatchCount > errorsBefore
            },
            { intervalMs: 200, timeoutMs: 15_000, label: 'ambiguous mixer-name error in get_log' },
          )
        } catch (error) {
          throw new Error(
            `${String(error)}\n` +
              `errorsBefore=${errorsBefore} lastCount=${ambiguousMatchCount}\n` +
              `--- prefix ---\n${errorPrefix}\n` +
              `--- log tail ---\n${ambiguousLogTail}`,
          )
        }

        const afterLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(afterLog).toContain(errorPrefix)
        expect(afterLog).toContain('global.sum("drum")')
        expect(afterLog).toContain('global.aux("drum")')
      } finally {
        const stop = await activeClient.call('stop_engine')
        expect(stop.isError, stop.text).toBe(false)
        await waitForEngine(false, 15_000, 'ambiguous mixer-name E2E engine stopped')
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    'restores an MCP-saved non-default instrument state across an engine restart with the same measured pitch',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      if (!client || !tmpRoot) throw new Error('main gated phase did not initialize suite state')
      const activeClient = client
      const root = tmpRoot
      const catalog = requireCatalogFixtures()

      // get_log は要求値にかかわらず末尾 500 行へ cap する。ERROR/attach 失敗の前後比較は
      // このスライディングウィンドウ内の補助判定で、復元の主判定は下の pitch assert。
      const RESTORE_LOG_LINES = 500
      const fixturesDir = path.join(root, 'fixtures')
      fs.mkdirSync(fixturesDir, { recursive: true })
      const handStatePath = path.join(fixturesDir, 'orc1-offset7.state')
      const magic = Buffer.alloc(4)
      magic.writeUInt32LE(0x4f52_4331)
      const offset = Buffer.alloc(4)
      offset.writeInt32LE(7)
      const handState = Buffer.concat([magic, offset])
      // This literal is Cycle A input only. If it drifts from clap-test-synth's
      // encode_state, apply_state_bytes rejects ORC1 before READY, attach fails
      // loudly, and a false pass is structurally impossible.
      fs.writeFileSync(handStatePath, handState)

      const shiftedWav = path.join(root, 'shifted.wav')
      const restoredWav = path.join(root, 'restored.wav')
      const countLogMarker = (log: string, marker: RegExp): number =>
        (log.match(marker) ?? []).length
      const countErrors = (log: string): number => countLogMarker(log, /ERROR:/g)
      const countAttachFailures = (log: string): number =>
        countLogMarker(log, /\[OUTPROC_ATTACH_FAILED\]/g)
      const countGlobalStops = (log: string): number =>
        countLogMarker(log, /(?:✅ Global stopped|⏹ Global)/g)

      // ── Cycle A: hand-built non-default state → audible pitch → MCP save.
      const beforeCycleALog = (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES }))
        .text
      const errorsBeforeCycleA = countErrors(beforeCycleALog)
      const startShifted = await activeClient.call('start_engine', { capture_wav: shiftedWav })
      expect(startShifted.isError, startShifted.text).toBe(false)
      await waitForEngine(true, 15_000, 'Cycle A engine running')
      await sleep(2500)

      // A fresh engine has no Global and play() only installs a pattern. The
      // transport setup plus RUN are the minimum executable scaffold around the
      // adjudicated instrument(catalogName, statePath) and play(1) operations.
      const initShifted = await activeClient.call('evaluate_orbitscore', {
        code: [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.start()',
          'var stSeq = init global.seq',
        ].join('\n'),
      })
      expect(initShifted.isError, initShifted.text).toBe(false)
      const attachFailuresBeforeShifted = countAttachFailures(
        (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
      )
      const attachShifted = await activeClient.call('evaluate_orbitscore', {
        code: `stSeq.instrument(${JSON.stringify(catalog.clapSynthName)}, ${JSON.stringify(handStatePath)})`,
      })
      expect(attachShifted.isError, attachShifted.text).toBe(false)
      await sleep(6000)
      const afterShiftedAttachLog = (
        await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })
      ).text
      expect(
        countAttachFailures(afterShiftedAttachLog),
        `Cycle A instrument attach must add no OUTPROC_ATTACH_FAILED. Log tail: ${afterShiftedAttachLog.slice(-1200)}`,
      ).toBe(attachFailuresBeforeShifted)

      const playShifted = await activeClient.call('evaluate_orbitscore', {
        code: ['stSeq.play(1)', 'RUN(stSeq)'].join('\n'),
      })
      expect(playShifted.isError, playShifted.text).toBe(false)
      await sleep(3000)

      const stopsBeforeShifted = countGlobalStops(
        (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
      )
      const stopShifted = await activeClient.call('evaluate_orbitscore', {
        code: ['stSeq.stop()', 'global.stop()'].join('\n'),
      })
      expect(stopShifted.isError, stopShifted.text).toBe(false)
      await waitUntil(
        async () =>
          countGlobalStops(
            (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
          ) > stopsBeforeShifted,
        {
          intervalMs: 200,
          timeoutMs: 5_000,
          label: 'Cycle A transport stopped before state save',
        },
      )

      const saveShifted = await activeClient.call('save_plugin_state', {
        sequence: 'stSeq',
        index: 0,
      })
      expect(saveShifted.isError, saveShifted.text).toBe(false)
      const saved = JSON.parse(saveShifted.text) as {
        path: string
        bytesWritten: number
        identityKey: string
        projectFile: string
        projectStatePath: string
      }
      expect(saved.bytesWritten).toBe(handState.length)
      const instrumentIdentity = `stSeq/instrument/${catalog.clapSynthName}/0`
      expect(saved.identityKey).toBe(instrumentIdentity)
      expect(saved.projectFile).toBe(path.join(root, 'project.yaml'))
      expect(saved.path.startsWith(path.join(root, 'states') + path.sep)).toBe(true)
      expect(
        fs.readFileSync(saved.path).equals(handState),
        'MCP-saved state must be byte-identical to the Cycle A input',
      ).toBe(true)

      const stopCycleAEngine = await activeClient.call('stop_engine')
      expect(stopCycleAEngine.isError, stopCycleAEngine.text).toBe(false)
      await waitForEngine(false, 15_000, 'Cycle A engine stopped')
      await sleep(1500)
      const afterCycleALog = (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text
      expect(
        countErrors(afterCycleALog),
        `Cycle A must add no ERROR: lines. Log tail: ${afterCycleALog.slice(-1200)}`,
      ).toBeLessThanOrEqual(errorsBeforeCycleA)

      // ── Cycle B: project.yaml registration from the MCP save is the restore input.
      const errorsBeforeCycleB = countErrors(afterCycleALog)
      const startRestored = await activeClient.call('start_engine', { capture_wav: restoredWav })
      expect(startRestored.isError, startRestored.text).toBe(false)
      await waitForEngine(true, 15_000, 'Cycle B engine running')
      await sleep(2500)

      const initRestored = await activeClient.call('evaluate_orbitscore', {
        code: [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.start()',
          'var stSeq = init global.seq',
        ].join('\n'),
      })
      expect(initRestored.isError, initRestored.text).toBe(false)
      const attachFailuresBeforeRestored = countAttachFailures(
        (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
      )
      const attachRestored = await activeClient.call('evaluate_orbitscore', {
        code: `stSeq.instrument(${JSON.stringify(catalog.clapSynthName)})`,
      })
      expect(attachRestored.isError, attachRestored.text).toBe(false)
      await sleep(6000)
      const afterRestoredAttachLog = (
        await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })
      ).text
      expect(
        countAttachFailures(afterRestoredAttachLog),
        `Cycle B instrument attach must add no OUTPROC_ATTACH_FAILED. Log tail: ${afterRestoredAttachLog.slice(-1200)}`,
      ).toBe(attachFailuresBeforeRestored)
      expect(
        afterRestoredAttachLog,
        `Cycle B must surface the automatic project-state restore. Log tail: ${afterRestoredAttachLog.slice(-1200)}`,
      ).toMatch(
        new RegExp(`\\[plugin-state\\] restoring[^\\r\\n]*${escapeRegExp(instrumentIdentity)}`),
      )

      const playRestored = await activeClient.call('evaluate_orbitscore', {
        code: ['stSeq.play(1)', 'RUN(stSeq)'].join('\n'),
      })
      expect(playRestored.isError, playRestored.text).toBe(false)
      await sleep(3000)

      const stopsBeforeRestored = countGlobalStops(
        (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
      )
      const stopRestored = await activeClient.call('evaluate_orbitscore', {
        code: ['stSeq.stop()', 'global.stop()'].join('\n'),
      })
      expect(stopRestored.isError, stopRestored.text).toBe(false)
      await waitUntil(
        async () =>
          countGlobalStops(
            (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
          ) > stopsBeforeRestored,
        {
          intervalMs: 200,
          timeoutMs: 5_000,
          label: 'Cycle B transport stopped before engine stop',
        },
      )

      const stopCycleBEngine = await activeClient.call('stop_engine')
      expect(stopCycleBEngine.isError, stopCycleBEngine.text).toBe(false)
      await waitForEngine(false, 15_000, 'Cycle B engine stopped')
      await sleep(1500)
      const afterCycleBLog = (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text
      expect(
        countErrors(afterCycleBLog),
        `Cycle B must add no ERROR: lines. Log tail: ${afterCycleBLog.slice(-1200)}`,
      ).toBeLessThanOrEqual(errorsBeforeCycleB)

      // ── Frequency-only verdict: no state decode is duplicated in the test.
      const shiftedBuf = fs.readFileSync(shiftedWav)
      const restoredBuf = fs.readFileSync(restoredWav)
      const shiftedDuration = analyzeWavBuffer(shiftedBuf).durationSec
      const restoredDuration = analyzeWavBuffer(restoredBuf).durationSec
      const shiftedHz = estimateFundamentalHz(shiftedBuf, {
        fromSec: 0,
        toSec: shiftedDuration,
      })
      const restoredHz = estimateFundamentalHz(restoredBuf, {
        fromSec: 0,
        toSec: restoredDuration,
      })
      expect(shiftedHz, 'Cycle A capture has no measurable steady fundamental').toBeDefined()
      expect(restoredHz, 'Cycle B capture has no measurable steady fundamental').toBeDefined()

      // MIDI-standard pitch formula is the independent musical specification.
      const midiFrequencyHz = (midiNote: number): number => 440 * 2 ** ((midiNote - 69) / 12)
      const expectedDefaultHz = midiFrequencyHz(60)
      const expectedShiftedHz = midiFrequencyHz(60 + 7)
      const shiftedMeasured = shiftedHz!
      const restoredMeasured = restoredHz!
      expect(
        Math.abs(shiftedMeasured - expectedShiftedHz) / expectedShiftedHz,
        `Cycle A ${shiftedMeasured.toFixed(2)}Hz must be offset-7 pitch ${expectedShiftedHz.toFixed(2)}Hz`,
      ).toBeLessThanOrEqual(0.02)
      expect(
        Math.abs(shiftedMeasured - expectedDefaultHz) / expectedDefaultHz,
        `Cycle A ${shiftedMeasured.toFixed(2)}Hz must be clearly distinct from default ${expectedDefaultHz.toFixed(2)}Hz`,
      ).toBeGreaterThan(0.1)
      expect(
        Math.abs(restoredMeasured - shiftedMeasured) / shiftedMeasured,
        `restored ${restoredMeasured.toFixed(2)}Hz must match saved ${shiftedMeasured.toFixed(2)}Hz`,
      ).toBeLessThanOrEqual(0.01)
      expect(
        Math.abs(restoredMeasured - expectedShiftedHz) / expectedShiftedHz,
        `restored ${restoredMeasured.toFixed(2)}Hz must be offset-7 pitch ${expectedShiftedHz.toFixed(2)}Hz`,
      ).toBeLessThanOrEqual(0.02)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    'restores a non-default sum-bus insert across restart through its prefixed receiver identity',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      if (!client || !tmpRoot) throw new Error('main gated phase did not initialize suite state')
      const activeClient = client
      const root = tmpRoot
      const catalog = requireCatalogFixtures()
      expect(
        workAudioDir,
        'main gated phase must initialize the audio fixture directory',
      ).toBeDefined()
      if (!workAudioDir) throw new Error('main gated phase did not initialize audio fixture state')
      const projectFile = path.join(root, 'project.yaml')
      const dslPath = path.join(root, 'sum-bus-state.orbs')
      const audioSearchPath = path.relative(path.dirname(dslPath), workAudioDir)
      const defaultWav = path.join(root, 'sum-bus-default.wav')
      const changedWav = path.join(root, 'sum-bus-changed.wav')
      const restoredWav = path.join(root, 'sum-bus-restored.wav')
      const receiverKey = `sum:drum/effect/${catalog.clapEffectName}/0`
      const unprefixedDecoyKey = `drum/effect/${catalog.clapEffectName}/0`
      const wrongKindDecoyKey = `aux:drum/effect/${catalog.clapEffectName}/0`
      // 音声オラクルは sum 側だけに置く。aux 側は「daemon 往復まで実機で通る」ことを
      // get_log の restore 行で1点だけ証明する（フル音声オラクルの複製はコスト不適合）。
      const auxReceiverKey = `aux:wet/effect/${catalog.clapEffectName}/0`

      const dslLines = [
        'var global = init GLOBAL',
        'global.tempo(120)',
        'global.beat(4 by 4)',
        `global.audioPath(${JSON.stringify(audioSearchPath)})`,
        `global.sum("drum").effect(${JSON.stringify(catalog.clapEffectName)})`,
        `global.aux("wet").effect(${JSON.stringify(catalog.clapEffectName)})`,
        'var busStateSource = init global.seq',
        'busStateSource.audio("kick.wav").chop(1).output("drum")',
        'busStateSource.play(1, 1, 1, 1)',
        'global.start()',
        'LOOP(busStateSource)',
        'busStateSource.stop()',
        'global.stop()',
      ]
      // 1-based line numbers derived from the script so edits cannot silently
      // desynchronize the run_selection ranges below.
      const playEndLine = dslLines.indexOf('LOOP(busStateSource)') + 1
      const stopStartLine = dslLines.indexOf('busStateSource.stop()') + 1
      const stopEndLine = dslLines.indexOf('global.stop()') + 1
      expect(playEndLine).toBeGreaterThan(0)
      expect(stopStartLine).toBe(playEndLine + 1)
      expect(stopEndLine).toBe(stopStartLine + 1)
      fs.writeFileSync(dslPath, dslLines.join('\n') + '\n')
      const openDsl = await activeClient.call('open_file', { path: dslPath })
      expect(openDsl.isError, openDsl.text).toBe(false)

      const runDslLines = async (startLine: number, endLine: number): Promise<void> => {
        const selected = await activeClient.call('set_selection', {
          start_line: startLine,
          start_char: 1,
          end_line: endLine,
          end_char: 999_999,
        })
        expect(selected.isError, selected.text).toBe(false)
        const run = await activeClient.call('run_selection')
        expect(run.isError, run.text).toBe(false)
      }
      const startCapture = async (wavPath: string, label: string): Promise<void> => {
        const started = await activeClient.call('start_engine', { capture_wav: wavPath })
        expect(started.isError, started.text).toBe(false)
        await waitForEngine(true, 15_000, label)
        await sleep(2500)
      }
      const stopTransportThroughDsl = async (label: string): Promise<void> => {
        const before = (await activeClient.call('get_log', { lines: 500 })).text
        const stopsBefore = (before.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length
        await runDslLines(stopStartLine, stopEndLine)
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            return (log.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length > stopsBefore
          },
          { intervalMs: 200, timeoutMs: 5_000, label },
        )
      }
      const stopEngine = async (label: string): Promise<void> => {
        const stopped = await activeClient.call('stop_engine')
        expect(stopped.isError, stopped.text).toBe(false)
        await waitForEngine(false, 15_000, label)
        await sleep(1500)
      }
      const readManifestStates = (): Record<string, string> => {
        if (!fs.existsSync(projectFile)) return {}
        const manifest = parse(fs.readFileSync(projectFile, 'utf8')) as {
          states?: Record<string, string>
        }
        return { ...(manifest.states ?? {}) }
      }
      const writeManifestStates = (states: Record<string, string>): void => {
        fs.writeFileSync(projectFile, stringify({ version: 1, states }))
      }
      const writeEffectState = (relativePath: string, gain: number): void => {
        const absolutePath = path.resolve(root, relativePath)
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
        const bytes = Buffer.alloc(12)
        bytes.writeUInt32LE(0x4f52_4531, 0)
        bytes.writeDoubleLE(gain, 4)
        fs.writeFileSync(absolutePath, bytes)
      }

      // Baseline oracle: the same DSL and source through the effect's default
      // gain (0.5), captured before any receiver-specific state is registered.
      const baselineStates = readManifestStates()
      delete baselineStates[receiverKey]
      delete baselineStates[unprefixedDecoyKey]
      delete baselineStates[wrongKindDecoyKey]
      delete baselineStates[auxReceiverKey]
      writeManifestStates(baselineStates)
      await startCapture(defaultWav, 'sum-bus default capture engine running')
      await runDslLines(1, playEndLine)
      await sleep(4000)
      await stopTransportThroughDsl('sum-bus default transport stopped')
      await stopEngine('sum-bus default capture engine stopped')

      // Bootstrap the non-default 0.125 gain plus two measurable decoys. The
      // correct prefixed key is removed after load below, so only state recording
      // can make the subsequent restart reproduce this sound.
      const correctRelativePath = 'states/e2e-sum-gain-0125.state'
      const unprefixedDecoyPath = 'states/e2e-unprefixed-gain-0900.state'
      const wrongKindDecoyPath = 'states/e2e-aux-gain-0800.state'
      writeEffectState(correctRelativePath, 0.125)
      writeEffectState(unprefixedDecoyPath, 0.9)
      writeEffectState(wrongKindDecoyPath, 0.8)
      writeManifestStates({
        ...readManifestStates(),
        [receiverKey]: correctRelativePath,
        [unprefixedDecoyKey]: unprefixedDecoyPath,
        [wrongKindDecoyKey]: wrongKindDecoyPath,
      })

      // 1. .orbs の sum bus insert を、ユーザーと同じ run_selection で評価する。
      await startCapture(changedWav, 'sum-bus changed capture engine running')
      await runDslLines(1, playEndLine)
      await sleep(4000)

      // 2. 正しい receiver key から非既定 gain が適用済み。bootstrap key を消してから
      // DSL で停止し、保存経路だけが restart 用の登記を作れる状態にする。
      const loadedStates = readManifestStates()
      delete loadedStates[receiverKey]
      writeManifestStates(loadedStates)
      await stopTransportThroughDsl('sum-bus changed transport stopped before state save')

      // 3. 自動記録される。
      // stop() の snapshot は fire-and-forget なので、明示保存を挟まず、両 receiver が
      // committed manifest に登記されるまで待って非同期の daemon 往復を吸収する。
      await waitUntil(
        () => {
          const states = readManifestStates()
          return Boolean(states[receiverKey] && states[auxReceiverKey])
        },
        { intervalMs: 200, timeoutMs: 10_000, label: 'sum/aux auto-snapshot registered' },
      )
      const registeredStates = readManifestStates()
      expect(registeredStates[receiverKey]).toMatch(/^states\//)
      expect(registeredStates[auxReceiverKey]).toMatch(/^states\//)
      expect(registeredStates[unprefixedDecoyKey]).toBe(unprefixedDecoyPath)
      expect(registeredStates[wrongKindDecoyKey]).toBe(wrongKindDecoyPath)

      // 4. エンジンを再起動する。
      await stopEngine('sum-bus changed capture engine stopped')
      await startCapture(restoredWav, 'sum-bus restored capture engine running')

      // 5. 同じ .orbs を run_selection で再評価し、capture で音の一致を確認する。
      await runDslLines(1, playEndLine)
      await sleep(4000)
      // aux 側は restore が daemon まで往復した証拠として engine ログの
      // `[plugin-state] restoring 'aux:wet/…'` 行を確認する。
      await waitUntil(
        async () => {
          const log = (await activeClient.call('get_log', { lines: 1000 })).text
          return log.includes(`[plugin-state] restoring '${auxReceiverKey}'`)
        },
        { intervalMs: 200, timeoutMs: 10_000, label: 'aux-bus insert restored from prefixed key' },
      )
      await stopTransportThroughDsl('sum-bus restored transport stopped')
      await stopEngine('sum-bus restored capture engine stopped')

      const defaultAnalysis = analyzeWavBuffer(fs.readFileSync(defaultWav))
      const changedAnalysis = analyzeWavBuffer(fs.readFileSync(changedWav))
      const restoredAnalysis = analyzeWavBuffer(fs.readFileSync(restoredWav))
      expect(defaultAnalysis.soundDetected, JSON.stringify(defaultAnalysis)).toBe(true)
      expect(changedAnalysis.soundDetected, JSON.stringify(changedAnalysis)).toBe(true)
      expect(restoredAnalysis.soundDetected, JSON.stringify(restoredAnalysis)).toBe(true)

      const peakRatioFromDefault = changedAnalysis.peak / defaultAnalysis.peak
      const rmsRatioFromDefault = changedAnalysis.rms / defaultAnalysis.rms
      expect(
        peakRatioFromDefault,
        `non-default peak ratio ${peakRatioFromDefault} must reflect gain 0.125 / default 0.5`,
      ).toBeGreaterThan(0.15)
      expect(peakRatioFromDefault).toBeLessThan(0.35)
      expect(
        rmsRatioFromDefault,
        `non-default RMS ratio ${rmsRatioFromDefault} must reflect gain 0.125 / default 0.5`,
      ).toBeGreaterThan(0.12)
      expect(rmsRatioFromDefault).toBeLessThan(0.4)

      const restoredPeakDelta =
        Math.abs(restoredAnalysis.peak - changedAnalysis.peak) / changedAnalysis.peak
      const restoredRmsDelta =
        Math.abs(restoredAnalysis.rms - changedAnalysis.rms) / changedAnalysis.rms
      expect(
        restoredPeakDelta,
        `restored peak ${restoredAnalysis.peak} must match pre-restart ${changedAnalysis.peak}`,
      ).toBeLessThanOrEqual(0.08)
      expect(
        restoredRmsDelta,
        `restored RMS ${restoredAnalysis.rms} must match pre-restart ${changedAnalysis.rms}`,
      ).toBeLessThanOrEqual(0.15)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    'auto-records and restores all five plugin receiver kinds across a restart without explicit saves',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      if (!client || !tmpRoot) throw new Error('main gated phase did not initialize suite state')
      const activeClient = client
      const root = tmpRoot
      const catalog = requireCatalogFixtures()
      expect(
        workAudioDir,
        'main gated phase must initialize the audio fixture directory',
      ).toBeDefined()
      if (!workAudioDir) throw new Error('main gated phase did not initialize audio fixture state')
      const projectFile = path.join(root, 'project.yaml')
      const dslPath = path.join(root, 'all-receiver-auto-snapshot.orbs')
      const audioSearchPath = path.relative(path.dirname(dslPath), workAudioDir)
      const defaultWav = path.join(root, 'all-receiver-default.wav')
      const preRestartWav = path.join(root, 'all-receiver-pre-restart.wav')
      const restoredWav = path.join(root, 'all-receiver-restored.wav')
      const receiverKeys = [
        `master/effect/${catalog.clapEffectName}/0`,
        `sum:autoSnapshotSum/effect/${catalog.clapEffectName}/0`,
        `aux:autoSnapshotAux/effect/${catalog.clapEffectName}/0`,
        `autoSnapshotEffect/effect/${catalog.clapEffectName}/0`,
        `autoSnapshotInstrument/instrument/${catalog.clapSynthName}/0`,
      ] as const

      const instrumentDeclaration = `autoSnapshotInstrument.instrument(${JSON.stringify(catalog.clapSynthName)})`
      const dslLines = [
        'var global = init GLOBAL',
        // The solo segment plays `autoSnapshotInstrument.play(1)`, a MIDI
        // degree the engine rejects without a root — keep the key declared
        // (the ERROR-count assertion caught the omission on a real device).
        'global.key("C")',
        'global.tempo(120)',
        'global.beat(4 by 4)',
        `global.audioPath(${JSON.stringify(audioSearchPath)})`,
        'var mix = init global.mixer',
        'var master = mix.output(1, 2)',
        'var autoSnapshotSum = mix.sum',
        'var autoSnapshotAux = mix.aux',
        `global.effect(${JSON.stringify(catalog.clapEffectName)})`,
        `autoSnapshotSum.effect(${JSON.stringify(catalog.clapEffectName)})`,
        `autoSnapshotAux.effect(${JSON.stringify(catalog.clapEffectName)})`,
        'var autoSnapshotEffect = init global.seq',
        'autoSnapshotEffect.audio("kick.wav").chop(1)',
        `autoSnapshotEffect.effect(${JSON.stringify(catalog.clapEffectName)})`,
        'autoSnapshotEffect.autoSnapshotSum',
        'autoSnapshotSum.autoSnapshotAux(1).master',
        'autoSnapshotAux.master',
        'var autoSnapshotInstrument = init global.seq',
        instrumentDeclaration,
        'autoSnapshotEffect.play(1, 1, 1, 1)',
        'global.start()',
        'LOOP(autoSnapshotEffect)',
        // Solo segment: stop the kick loop, then run the synth alone so the
        // capture tail holds a clean fundamental for the pitch oracle.
        'autoSnapshotEffect.stop()',
        'autoSnapshotInstrument.play(1)',
        'RUN(autoSnapshotInstrument)',
        'autoSnapshotInstrument.stop()',
        'global.stop()',
      ]
      const declarationsEndLine = dslLines.indexOf(instrumentDeclaration) + 1
      const playbackStartLine = dslLines.indexOf('autoSnapshotEffect.play(1, 1, 1, 1)') + 1
      const playbackEndLine = dslLines.indexOf('LOOP(autoSnapshotEffect)') + 1
      const soloStartLine = dslLines.indexOf('autoSnapshotEffect.stop()') + 1
      const soloEndLine = dslLines.indexOf('RUN(autoSnapshotInstrument)') + 1
      const stopStartLine = dslLines.indexOf('autoSnapshotInstrument.stop()') + 1
      const stopEndLine = dslLines.indexOf('global.stop()') + 1
      expect(declarationsEndLine).toBeGreaterThan(0)
      expect(playbackStartLine).toBe(declarationsEndLine + 1)
      expect(playbackEndLine).toBe(playbackStartLine + 2)
      expect(soloStartLine).toBe(playbackEndLine + 1)
      expect(soloEndLine).toBe(soloStartLine + 2)
      expect(stopStartLine).toBe(soloEndLine + 1)
      expect(stopEndLine).toBe(stopStartLine + 1)
      fs.writeFileSync(dslPath, dslLines.join('\n') + '\n')
      const openDsl = await activeClient.call('open_file', { path: dslPath })
      expect(openDsl.isError, openDsl.text).toBe(false)

      const runDslLines = async (startLine: number, endLine: number): Promise<void> => {
        const selected = await activeClient.call('set_selection', {
          start_line: startLine,
          start_char: 1,
          end_line: endLine,
          end_char: 999_999,
        })
        expect(selected.isError, selected.text).toBe(false)
        const run = await activeClient.call('run_selection')
        expect(run.isError, run.text).toBe(false)
      }
      const stopTransportThroughDsl = async (label: string): Promise<void> => {
        const before = (await activeClient.call('get_log', { lines: 500 })).text
        const stopsBefore = (before.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length
        await runDslLines(stopStartLine, stopEndLine)
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            return (log.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length > stopsBefore
          },
          { intervalMs: 200, timeoutMs: 5_000, label },
        )
      }
      const stopEngine = async (label: string): Promise<void> => {
        const stopped = await activeClient.call('stop_engine')
        expect(stopped.isError, stopped.text).toBe(false)
        await waitForEngine(false, 15_000, label)
        await sleep(1500)
      }
      const readManifestStates = (): Record<string, string> => {
        if (!fs.existsSync(projectFile)) return {}
        const manifest = parse(fs.readFileSync(projectFile, 'utf8')) as {
          states?: Record<string, string>
        }
        return { ...(manifest.states ?? {}) }
      }
      const writeManifestStates = (states: Record<string, string>): void => {
        fs.writeFileSync(projectFile, stringify({ version: 1, states }))
      }
      // ORE1 magic + f64 LE gain — clap-test-effect's encode_state. Byte
      // equality against auto-recorded files works because both encoders are
      // deterministic.
      const effectStateBytes = (gain: number): Buffer => {
        const bytes = Buffer.alloc(12)
        bytes.writeUInt32LE(0x4f52_4531, 0)
        bytes.writeDoubleLE(gain, 4)
        return bytes
      }
      // ORC1 magic + i32 LE semitone offset — clap-test-synth's encode_state.
      const instrumentStateBytes = (semitoneOffset: number): Buffer => {
        const bytes = Buffer.alloc(8)
        bytes.writeUInt32LE(0x4f52_4331, 0)
        bytes.writeInt32LE(semitoneOffset, 4)
        return bytes
      }
      const writeStateFile = (relativePath: string, bytes: Buffer): void => {
        const absolutePath = path.resolve(root, relativePath)
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
        fs.writeFileSync(absolutePath, bytes)
      }
      const countErrors = (log: string): number => (log.match(/ERROR:/g) ?? []).length
      // ProjectStateStore.stateFileNameForIdentity: the identity tuple as
      // JSON, base64url-encoded. Restated here so the test pins the on-disk
      // contract instead of importing the implementation it verifies.
      const expectedAutoStatePath = (receiverKey: string): string => {
        const [receiver, role, normalizedName, occurrence] = receiverKey.split('/')
        const encoded = Buffer.from(
          JSON.stringify([receiver, role, normalizedName, Number(occurrence)]),
          'utf8',
        ).toString('base64url')
        return `states/${encoded}.state`
      }
      // Path-bound restore-line counter: a matching line proves this receiver
      // was restored FROM this file. The sound oracle cannot see a state swap
      // between the three series receivers (their gains multiply
      // commutatively), so the manifest-level wiring is pinned here instead.
      const countRestoreLines = (log: string, receiverKey: string, statePath: string): number =>
        log
          .split('\n')
          .filter(
            (line) =>
              line.includes(`[plugin-state] restoring '${receiverKey}' from `) &&
              line.trimEnd().endsWith(`/${statePath}`),
          ).length
      // Scan 1 s windows backwards from the end of the capture: the synth solo
      // is the last sounding segment, so the first window with a steady
      // fundamental measures it (tail silence stays under the amplitude floor
      // and yields undefined).
      const lastSteadyFundamentalHz = (buf: Buffer): number | undefined => {
        const { durationSec } = analyzeWavBuffer(buf)
        for (let toSec = durationSec; toSec >= 1; toSec -= 0.25) {
          const hz = estimateFundamentalHz(buf, { fromSec: toSec - 1, toSec })
          if (hz !== undefined) return hz
        }
        return undefined
      }
      let engineRunning = false
      const startCapture = async (wavPath: string, label: string): Promise<void> => {
        const started = await activeClient.call('start_engine', { capture_wav: wavPath })
        expect(started.isError, started.text).toBe(false)
        engineRunning = true
        await waitForEngine(true, 15_000, label)
        await sleep(2500)
      }
      // Keep every cycle's timeline identical so whole-file RMS stays
      // comparable across the three captures.
      const runPlaybackPhases = async (): Promise<void> => {
        await sleep(6000)
        await runDslLines(playbackStartLine, playbackEndLine)
        await sleep(4000)
        await runDslLines(soloStartLine, soloEndLine)
        await sleep(4000)
      }

      const baselineStates = readManifestStates()
      for (const receiverKey of receiverKeys) delete baselineStates[receiverKey]
      writeManifestStates(baselineStates)
      const clearedStates = readManifestStates()
      for (const receiverKey of receiverKeys) {
        expect(clearedStates).not.toHaveProperty(receiverKey)
      }

      // Topology (NOT a series chain): the sum bus feeds master directly AND
      // sends to aux (amount 1), whose return also feeds master. With an ideal
      // zero-latency adder the graph would collapse to
      //   T = g_master · g_sequence · g_sum · (1 + g_aux)
      // Reverting any one SERIES gain to the 0.5 default moves the capture by
      // 44.4% (master), 41.2% (sum) or 37.5% (sequence) — measured on real
      // hardware, red as predicted. The aux term is different: every OOP
      // insert is pipelined (+1 block of latency), so the aux return lags the
      // direct leg by one device block. The kick's file peak lands ~66 samples
      // after onset — inside that block — so the whole-file peak is
      // mathematically insensitive to g_aux at ANY tolerance, and whole-file
      // RMS moves only ~4% (measured signed −4.11% for g_aux 0.95 → 0.0; the
      // ideal 23.1% shrinks under the kick's negative lag-autocorrelation
      // plus silence/synth dilution). That 4.11% is real signal, not noise:
      // the no-mutation noise floor between two same-settings captures is
      // 3.4e-6. So the RMS restore assert below runs at 2% tolerance — tight
      // enough that a lost aux restore goes red — while peak keeps 15% and
      // covers the series gains only (#587: measurement sensitivity, not a
      // signal-path defect). The aux leg itself is pinned at bus level by the
      // daemon gated test set_bus_routing_wires_sum_send_to_aux_and_return
      // (rust/crates/orbit-audio-daemon/tests/outproc_mixer_bus_gated.rs);
      // the committed-bytes equality and the path-bound restore-line assert
      // cover the aux STATE from the manifest side. T is commutative in the
      // series gains, so a state SWAP between them is inaudible; the
      // path-bound restore-line asserts cover that failure class too.
      const effectStates = [
        {
          receiverKey: receiverKeys[0],
          relativePath: 'states/e2e-auto-master-gain-0900.state',
          gain: 0.9,
        },
        {
          receiverKey: receiverKeys[1],
          relativePath: 'states/e2e-auto-sum-gain-0850.state',
          gain: 0.85,
        },
        {
          receiverKey: receiverKeys[2],
          relativePath: 'states/e2e-auto-aux-gain-0950.state',
          gain: 0.95,
        },
        {
          receiverKey: receiverKeys[3],
          relativePath: 'states/e2e-auto-sequence-gain-0800.state',
          gain: 0.8,
        },
      ] as const
      // The gain product cannot see a pitch state, so the instrument carries
      // its own oracle: a non-default semitone offset measured as the solo
      // segment's fundamental (same semantics as the MCP-save instrument test).
      const instrumentState = {
        receiverKey: receiverKeys[4],
        relativePath: 'states/e2e-auto-instrument-offset-0007.state',
        semitoneOffset: 7,
      } as const
      const bootstrapEntries: readonly { receiverKey: string; relativePath: string }[] = [
        ...effectStates,
        instrumentState,
      ]

      try {
        // ── Cycle 0: default baseline. No registered states — every plugin
        // keeps its built-in default (gain 0.5, offset 0). The loaded cycles
        // must differ audibly from this capture; without the baseline, a
        // pipeline that never applied state in either loaded cycle would
        // still pass their mutual match.
        await startCapture(defaultWav, 'all-receiver default-baseline capture engine running')
        const beforeDefaultLog = (await activeClient.call('get_log', { lines: 500 })).text
        const errorsBeforeDefault = countErrors(beforeDefaultLog)
        await runDslLines(1, declarationsEndLine)
        await runPlaybackPhases()
        await stopTransportThroughDsl('all-receiver default-baseline transport stopped')
        const afterDefaultLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterDefaultLog),
          `default-baseline cycle must add no ERROR: lines. Log tail: ${afterDefaultLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeDefault)
        await stopEngine('all-receiver default-baseline engine stopped')
        engineRunning = false

        // Bootstrap: hand-written non-default states stand in for "shape the
        // sound in the plugin UI" until #474 ships an openable UI. This write
        // also overwrites the registrations left by the cycle-0 stop snapshot;
        // the committed registrations consumed by the restart are produced by
        // the cycle-1 stop snapshot alone (asserted below).
        for (const state of effectStates) {
          writeStateFile(state.relativePath, effectStateBytes(state.gain))
        }
        writeStateFile(
          instrumentState.relativePath,
          instrumentStateBytes(instrumentState.semitoneOffset),
        )
        writeManifestStates({
          ...readManifestStates(),
          ...Object.fromEntries(
            bootstrapEntries.map((state) => [state.receiverKey, state.relativePath]),
          ),
        })

        // ── Cycle 1: load the five bootstrap states, prove they are audible,
        // then let the stop snapshot auto-record them.
        await startCapture(preRestartWav, 'all-receiver pre-restart capture engine running')
        const beforeLog = (await activeClient.call('get_log', { lines: 500 })).text
        const errorsBefore = countErrors(beforeLog)
        const bootstrapRestoreCountsBefore = new Map(
          bootstrapEntries.map((state) => [
            state.receiverKey,
            countRestoreLines(beforeLog, state.receiverKey, state.relativePath),
          ]),
        )
        await runDslLines(1, declarationsEndLine)
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            const missing = bootstrapEntries.filter(
              (state) =>
                countRestoreLines(log, state.receiverKey, state.relativePath) <=
                bootstrapRestoreCountsBefore.get(state.receiverKey)!,
            )
            if (missing.length > 0) {
              throw new Error(
                `missing bootstrap restore log lines: ${missing.map((s) => s.receiverKey).join(', ')}`,
              )
            }
            return true
          },
          {
            intervalMs: 200,
            timeoutMs: 10_000,
            label: 'all five bootstrap state restore log lines',
          },
        )
        await runPlaybackPhases()

        // Remove every bootstrap registration after the loaded plugins have
        // applied it. Only the automatic stop snapshot may create the committed
        // registrations consumed by the restart below.
        const loadedStates = readManifestStates()
        for (const receiverKey of receiverKeys) delete loadedStates[receiverKey]
        writeManifestStates(loadedStates)
        const statesBeforeAutoSnapshot = readManifestStates()
        for (const receiverKey of receiverKeys) {
          expect(statesBeforeAutoSnapshot).not.toHaveProperty(receiverKey)
        }
        await stopTransportThroughDsl('all-receiver transport stopped before auto-snapshot')

        await waitUntil(
          () => {
            const states = readManifestStates()
            return receiverKeys.every((receiverKey) => Boolean(states[receiverKey]))
          },
          {
            intervalMs: 200,
            timeoutMs: 10_000,
            label: 'all five receiver auto-snapshots registered',
          },
        )
        const registeredStates = readManifestStates()
        for (const receiverKey of receiverKeys) {
          expect(registeredStates[receiverKey]).toBe(expectedAutoStatePath(receiverKey))
        }
        // The snapshot must have re-saved the LIVE plugin state, not left the
        // cycle-0 default bytes behind: the committed files must equal the
        // exact bytes the plugins loaded from the bootstrap.
        for (const state of effectStates) {
          expect(
            fs
              .readFileSync(path.join(root, expectedAutoStatePath(state.receiverKey)))
              .equals(effectStateBytes(state.gain)),
            `auto-recorded '${state.receiverKey}' must hold the loaded gain ${state.gain}`,
          ).toBe(true)
        }
        expect(
          fs
            .readFileSync(path.join(root, expectedAutoStatePath(instrumentState.receiverKey)))
            .equals(instrumentStateBytes(instrumentState.semitoneOffset)),
          `auto-recorded '${instrumentState.receiverKey}' must hold semitone offset ` +
            `${instrumentState.semitoneOffset}`,
        ).toBe(true)

        const afterRecordLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterRecordLog),
          `all-receiver auto-snapshot must add no ERROR: lines. Log tail: ${afterRecordLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBefore)

        // Restart with only the stop-triggered committed manifest as restore
        // input, then re-declare every receiver. The daemon emits this marker
        // only when the registered state is actually sent back for application.
        await stopEngine('all-receiver auto-snapshot engine stopped before restore')
        engineRunning = false
        await startCapture(restoredWav, 'all-receiver restore capture engine running')

        const restoreBaselineLog = (await activeClient.call('get_log', { lines: 500 })).text
        const errorsBeforeRestore = countErrors(restoreBaselineLog)
        // Path-bound markers: each receiver must be restored from ITS
        // deterministic committed file. Cycle-1 bootstrap lines used the
        // hand-written paths, so they cannot satisfy these counts.
        const restoreCountsBeforeDeclarations = new Map(
          receiverKeys.map((receiverKey) => [
            receiverKey,
            countRestoreLines(restoreBaselineLog, receiverKey, expectedAutoStatePath(receiverKey)),
          ]),
        )

        await runDslLines(1, declarationsEndLine)
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            const missingReceiverKeys = receiverKeys.filter(
              (receiverKey) =>
                countRestoreLines(log, receiverKey, expectedAutoStatePath(receiverKey)) <=
                restoreCountsBeforeDeclarations.get(receiverKey)!,
            )
            if (missingReceiverKeys.length > 0) {
              throw new Error(
                `missing restore log lines for receiver keys: ${missingReceiverKeys.join(', ')}`,
              )
            }
            return true
          },
          {
            intervalMs: 200,
            timeoutMs: 10_000,
            label: 'all five receiver state restore log lines after engine restart',
          },
        )

        await runPlaybackPhases()
        await stopTransportThroughDsl('all-receiver restored transport stopped')

        const afterRestoreLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterRestoreLog),
          `all-receiver restore must not increase ERROR: lines from the post-restart baseline. Log tail: ${afterRestoreLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeRestore)

        await stopEngine('all-receiver restored capture engine stopped')
        engineRunning = false

        const defaultBuf = fs.readFileSync(defaultWav)
        const preRestartBuf = fs.readFileSync(preRestartWav)
        const restoredBuf = fs.readFileSync(restoredWav)
        const defaultAnalysis = analyzeWavBuffer(defaultBuf)
        const preRestartAnalysis = analyzeWavBuffer(preRestartBuf)
        const restoredAnalysis = analyzeWavBuffer(restoredBuf)
        expect(defaultAnalysis.soundDetected, JSON.stringify(defaultAnalysis)).toBe(true)
        expect(preRestartAnalysis.soundDetected, JSON.stringify(preRestartAnalysis)).toBe(true)
        expect(restoredAnalysis.soundDetected, JSON.stringify(restoredAnalysis)).toBe(true)

        // Loaded states must be audibly ABOVE the default baseline. Physics:
        // the kick leg scales by T(loaded)/T(default) = 1.1934/0.1875 ≈ 6.4×
        // and the synth leg (master gain only) by 0.9/0.5 = 1.8×, so the
        // mixed capture gains at least ~44% — assert a 30% floor for margin.
        expect(
          (preRestartAnalysis.rms - defaultAnalysis.rms) / preRestartAnalysis.rms,
          `loaded RMS ${preRestartAnalysis.rms} must clearly exceed default ${defaultAnalysis.rms}`,
        ).toBeGreaterThan(0.3)
        expect(
          (preRestartAnalysis.peak - defaultAnalysis.peak) / preRestartAnalysis.peak,
          `loaded peak ${preRestartAnalysis.peak} must clearly exceed default ${defaultAnalysis.peak}`,
        ).toBeGreaterThan(0.3)

        const restoredPeakDelta =
          Math.abs(restoredAnalysis.peak - preRestartAnalysis.peak) / preRestartAnalysis.peak
        const restoredRmsDelta =
          Math.abs(restoredAnalysis.rms - preRestartAnalysis.rms) / preRestartAnalysis.rms
        expect(
          restoredPeakDelta,
          `restored peak ${restoredAnalysis.peak} must match pre-restart ${preRestartAnalysis.peak}`,
        ).toBeLessThanOrEqual(0.15)
        // RMS tolerance is 3%, not the peak's 15%. Two measured anchors:
        //
        // - Smallest real fault (#587): the aux insert's contribution going
        //   missing moves whole-file RMS by 4.11% (signed, measured for
        //   g_aux 0.95 → 0.0). 3% sits 1.37× under that, so a lost aux
        //   restore still goes red.
        // - No-fault cross-run noise (2026-08-26, n=5 same-day full-harness
        //   runs + 1 historical): deltas {0.17, 0.21, 0.62, 2.09, 2.14}% and
        //   2.15% (2026-07-31). The distribution is bimodal — a ~0.2-0.6%
        //   floor plus a recurring ~2.1% cluster whose sign flips run to run
        //   (both pre and restored captures occasionally measure ~2% low),
        //   i.e. a capture-window quantization artifact (about one kick onset's
        //   worth of energy), not restore infidelity. The former 2% tolerance
        //   sat INSIDE that cluster and failed ~2 in 5 clean runs. 3% clears
        //   the worst observed no-fault delta by 1.4×.
        //
        // (#587's original 3.4e-6 "noise floor" was captured back-to-back
        // without an engine restart — it does not describe this cross-restart
        // comparison.) The peak assert keeps 15%: its cross-run floor is
        // unmeasured, and the whole-file peak is structurally blind to the
        // aux leg (the pipelined aux return lags one device block behind the
        // direct leg, and the kick's peak sits inside that block), so
        // tightening it buys no aux detection — RMS is the discriminating
        // meter here.
        // Record the delta on every run, not just on failure.
        //
        // The assertion below only surfaces this number when it trips, so a rare
        // failure arrives with no baseline to compare against — on 2026-07-31 a
        // single 2.15% delta cost an hour of "regression or noise?" before anyone
        // could say what a passing run normally measures. One log line makes the
        // next such failure readable from the CI output alone.
        console.log(
          `[rms-delta] restored=${restoredAnalysis.rms} pre=${preRestartAnalysis.rms} delta=${restoredRmsDelta}`,
        )
        expect(
          restoredRmsDelta,
          `restored RMS ${restoredAnalysis.rms} must match pre-restart ${preRestartAnalysis.rms}`,
        ).toBeLessThanOrEqual(0.03)

        // Instrument leg: pitch, not level. Thresholds mirror the MCP-save
        // instrument test (±2% against the musical spec, ≤1% across restart).
        const midiFrequencyHz = (midiNote: number): number => 440 * 2 ** ((midiNote - 69) / 12)
        const expectedDefaultHz = midiFrequencyHz(60)
        const expectedShiftedHz = midiFrequencyHz(60 + instrumentState.semitoneOffset)
        const defaultHz = lastSteadyFundamentalHz(defaultBuf)
        const preRestartHz = lastSteadyFundamentalHz(preRestartBuf)
        const restoredHz = lastSteadyFundamentalHz(restoredBuf)
        expect(defaultHz, 'default capture has no measurable solo fundamental').toBeDefined()
        expect(preRestartHz, 'pre-restart capture has no measurable solo fundamental').toBeDefined()
        expect(restoredHz, 'restored capture has no measurable solo fundamental').toBeDefined()
        expect(
          Math.abs(defaultHz! - expectedDefaultHz) / expectedDefaultHz,
          `default solo ${defaultHz!.toFixed(2)}Hz must be the offset-0 pitch ` +
            `${expectedDefaultHz.toFixed(2)}Hz`,
        ).toBeLessThanOrEqual(0.02)
        expect(
          Math.abs(preRestartHz! - expectedShiftedHz) / expectedShiftedHz,
          `loaded solo ${preRestartHz!.toFixed(2)}Hz must be the offset-` +
            `${instrumentState.semitoneOffset} pitch ${expectedShiftedHz.toFixed(2)}Hz`,
        ).toBeLessThanOrEqual(0.02)
        expect(
          Math.abs(restoredHz! - preRestartHz!) / preRestartHz!,
          `restored solo ${restoredHz!.toFixed(2)}Hz must match pre-restart ` +
            `${preRestartHz!.toFixed(2)}Hz`,
        ).toBeLessThanOrEqual(0.01)
        expect(
          Math.abs(restoredHz! - expectedShiftedHz) / expectedShiftedHz,
          `restored solo ${restoredHz!.toFixed(2)}Hz must be the offset-` +
            `${instrumentState.semitoneOffset} pitch ${expectedShiftedHz.toFixed(2)}Hz`,
        ).toBeLessThanOrEqual(0.02)
      } finally {
        if (engineRunning) {
          await stopEngine('all-receiver auto-record/restore engine stopped')
        }
      }
    },
    // Three engine cycles (default / loaded / restored), each with a kick and
    // a solo segment — the shared two-cycle budget is not enough.
    TEST_TIMEOUT_MS * 2,
  )

  it.skipIf(!appAvailable)(
    'replaces a playing instrument across CLAP/VST3 with audio, state, process, failure, and UI oracles (#618 E1-E6)',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      if (!client || !tmpRoot) {
        throw new Error('main gated phase did not initialize suite state')
      }
      const activeClient = client
      const root = tmpRoot
      const catalog = requireCatalogFixtures()
      const capturePath = path.join(root, 'instrument-replace-e1-e6.wav')
      const vst3StatePath = path.join(root, 'fixtures', 'synth-oracle-plus7.state')
      fs.mkdirSync(path.dirname(vst3StatePath), { recursive: true })
      const vst3State = Buffer.alloc(8)
      vst3State.writeUInt32LE(0x4f52_4331, 0)
      vst3State.writeInt32LE(7, 4)
      fs.writeFileSync(vst3StatePath, vst3State)

      const countErrors = (log: string): number => (log.match(/ERROR:/g) ?? []).length
      const start = await activeClient.call('start_engine', { capture_wav: capturePath })
      expect(start.isError, start.text).toBe(false)
      await waitForEngine(true, 15_000, '#618 E1-E6 engine running')
      await sleep(2500)
      const captureWallStart = Date.now()
      let stopWall = captureWallStart
      const segments: Record<string, { from: number; to: number }> = {}
      try {
        const baselineLog = (await activeClient.call('get_log', { lines: 500 })).text
        const errorsBefore = countErrors(baselineLog)

        // E1: A is the CLAP oracle. LOOP keeps producing fresh note lifetimes while replace runs.
        await activeClient.call('evaluate_orbitscore', {
          code: [
            'var global = init GLOBAL',
            'global.key("C")',
            'global.tempo(120)',
            'global.beat(4 by 4)',
            'global.start()',
            'var cb618 = init global.seq',
            `cb618.instrument(${JSON.stringify(catalog.clapSynthName)})`,
            'cb618.play(1, 1, 1, 1)',
            'LOOP(cb618)',
          ].join('\n'),
        })
        await waitUntil(() => Promise.resolve(pluginChildPids(catalog.clapSynthPath).length > 0), {
          intervalMs: 200,
          timeoutMs: 10_000,
          label: '#618 old CLAP child started',
        })
        const oldChildPids = pluginChildPids(catalog.clapSynthPath)
        expect(oldChildPids.length, 'E1 must observe the old CLAP child PID').toBeGreaterThan(0)
        segments.e1 = { from: Date.now(), to: 0 }
        await sleep(3000)
        segments.e1.to = Date.now()

        // E2: replace while the LOOP is actively playing. The VST3 state shifts pitch by +7,
        // giving an independent spectral oracle in addition to non-silent RMS.
        const errorsBeforeReplace = countErrors(
          (await activeClient.call('get_log', { lines: 500 })).text,
        )
        await activeClient.call('evaluate_orbitscore', {
          // The `.state` suffix makes this the state axis, not an explicit pluginId;
          // resolvePluginSpec remains free to obtain pluginId from the catalog entry.
          code: `cb618.instrument(${JSON.stringify(catalog.vst3SynthName)}, ${JSON.stringify(vst3StatePath)})`,
        })
        await waitUntil(() => Promise.resolve(pluginChildPids(catalog.vst3SynthPath).length > 0), {
          intervalMs: 200,
          timeoutMs: 15_000,
          label: '#618 replacement VST3 child started',
        })
        await waitUntil(() => Promise.resolve(oldChildPids.every((pid) => !processExists(pid))), {
          intervalMs: 200,
          timeoutMs: 10_000,
          label: '#618 old CLAP child disappeared',
        })
        const afterReplaceLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterReplaceLog),
          `E2 replacement must add no ERROR lines. Log tail: ${afterReplaceLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeReplace)
        segments.e2 = { from: Date.now(), to: 0 }
        await sleep(3000)
        segments.e2.to = Date.now()

        // E6: the post-replace UI must be the VST3 tenant, not stale bookkeeping for A.
        const errorsBeforeUi = countErrors(afterReplaceLog)
        await activeClient.call('evaluate_orbitscore', { code: 'cb618.ui()' })
        await sleep(1000)
        const closeNewUi = await activeClient.call('close_plugin_ui', {
          receiver: 'cb618',
          index: 0,
        })
        expect(closeNewUi.isError, closeNewUi.text).toBe(false)
        expect(JSON.parse(closeNewUi.text)).toMatchObject({
          receiver: 'cb618',
          index: 0,
          normalizedName: catalog.vst3SynthName,
        })
        const afterUiLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterUiLog),
          `E6 new-tenant UI must add no ERROR lines. Log tail: ${afterUiLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeUi)

        // E7 (owner 指摘 2026-08-26): effect も **カタログ名だけ** で宣言でき、その UI が
        // 開くことを実機で示す。instrument だけ catalog 経路に寄せても、effect 宣言が
        // フルパスのままなら effect 側は本番経路を一度も通らない。
        //
        // 🔴 差し替えは instrument のみ。effect の異 spec 再宣言は今も明示エラー
        //（effect slot は bus 名で位置固定・名前→slot の間接層が無い）。ここは
        // 「名前で挿せて UI が開く」までを示す。差し替えは follow-up issue。
        const errorsBeforeEffect = countErrors(afterUiLog)
        const effectByName = await activeClient.call('evaluate_orbitscore', {
          code: `global.sum("fx618").effect(${JSON.stringify(catalog.clapEffectName)})`,
        })
        expect(effectByName.isError, effectByName.text).toBe(false)
        await sleep(1500)
        const afterEffectLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterEffectLog),
          `E7 catalog-name effect must add no ERROR lines. Log tail: ${afterEffectLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeEffect)
        // UI が開けること = catalog 解決の結果が実 slot として生きている証拠。
        // バスは source slot を持たないので effect は index 1 から（index 0 は明示エラー）。
        const effectUiOpen = await activeClient.call('open_plugin_ui', {
          receiver: 'sum:fx618',
          index: 1,
        })
        expect(effectUiOpen.isError, effectUiOpen.text).toBe(false)
        expect(JSON.parse(effectUiOpen.text)).toMatchObject({
          index: 1,
          normalizedName: catalog.clapEffectName,
        })
        await sleep(800)
        const effectUiClose = await activeClient.call('close_plugin_ui', {
          receiver: 'sum:fx618',
          index: 1,
        })
        expect(effectUiClose.isError, effectUiClose.text).toBe(false)

        // E3: a rest-only pattern must be silent; the old tenant PIDs remain gone.
        await activeClient.call('evaluate_orbitscore', { code: 'cb618.play(0, 0, 0, 0)' })
        await sleep(1000)
        segments.e3 = { from: Date.now(), to: 0 }
        await sleep(2500)
        segments.e3.to = Date.now()
        expect(oldChildPids.every((pid) => !processExists(pid))).toBe(true)
        expect(pluginChildPids(catalog.clapSynthPath)).toEqual([])

        // E4: keep this sole declaration path-direct. A missing catalog name would fail
        // in TS resolution before ReplacePlugin; the nonexistent bundle path reaches the
        // daemon prepare failure whose rollback must leave B producing its shifted tone.
        const beforeFailureLog = (await activeClient.call('get_log', { lines: 500 })).text
        const failedReplace = await activeClient.call('evaluate_orbitscore', {
          code: 'cb618.instrument("/definitely/nonexistent/Issue618.vst3")',
        })
        // The assertion below reports the log we actually settled on, so the poll writes it out
        // instead of keeping it in the closure — a bare `const` inside the predicate left the
        // assertion referencing an undeclared name, and nothing typechecks `tests/`.
        let afterFailureLog = beforeFailureLog
        await waitUntil(
          async () => {
            afterFailureLog = (await activeClient.call('get_log', { lines: 500 })).text
            return (
              failedReplace.isError || countErrors(afterFailureLog) > countErrors(beforeFailureLog)
            )
          },
          { intervalMs: 200, timeoutMs: 10_000, label: '#618 failed replacement surfaced' },
        )
        expect(
          failedReplace.isError || countErrors(afterFailureLog) > countErrors(beforeFailureLog),
          `E4 failure was not surfaced by evaluation or get_log: ${afterFailureLog.slice(-1200)}`,
        ).toBe(true)
        await activeClient.call('evaluate_orbitscore', { code: 'cb618.play(1, 1, 1, 1)' })
        await sleep(1000)
        segments.e4 = { from: Date.now(), to: 0 }
        await sleep(3000)
        segments.e4.to = Date.now()

        // E5: A was automatically registered before A→B; switching back uses that state.
        const projectFile = path.join(root, 'project.yaml')
        const manifest = parse(fs.readFileSync(projectFile, 'utf8')) as {
          states: Record<string, string>
        }
        const aIdentity = `cb618/instrument/${catalog.clapSynthName}/0`
        expect(manifest.states[aIdentity]).toBeDefined()
        expect(fs.existsSync(path.resolve(root, manifest.states[aIdentity]!))).toBe(true)
        const logBeforeRestoreA = (await activeClient.call('get_log', { lines: 500 })).text
        const restoreMarker = `[plugin-state] restoring '${aIdentity}'`
        const restoreMarkersBefore = logBeforeRestoreA.split(restoreMarker).length - 1
        await activeClient.call('evaluate_orbitscore', {
          code: `cb618.instrument(${JSON.stringify(catalog.clapSynthName)})`,
        })
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            return log.split(restoreMarker).length - 1 > restoreMarkersBefore
          },
          { intervalMs: 200, timeoutMs: 15_000, label: '#618 old state restore log' },
        )
        segments.e5 = { from: Date.now(), to: 0 }
        await sleep(3000)
        segments.e5.to = Date.now()

        const finalLog = (await activeClient.call('get_log', { lines: 500 })).text
        // The deliberate E4 error is the only new error in this scenario.
        expect(countErrors(finalLog)).toBeGreaterThanOrEqual(errorsBefore + 1)
      } finally {
        await activeClient.call('evaluate_orbitscore', {
          code: 'cb618.stop()\nglobal.stop()',
        })
        const stopped = await activeClient.call('stop_engine')
        expect(stopped.isError, stopped.text).toBe(false)
        stopWall = Date.now()
        await waitForEngine(false, 15_000, '#618 E1-E6 engine stopped')
        await sleep(1500)
      }

      const capture = fs.readFileSync(capturePath)
      const analysis = analyzeWavBuffer(capture, { windowMs: 100 })
      const audioRange = (segment: { from: number; to: number }) => ({
        fromSec: Math.max(0, analysis.durationSec - (stopWall - segment.from) / 1000),
        toSec: Math.min(
          analysis.durationSec,
          analysis.durationSec - (stopWall - segment.to) / 1000,
        ),
      })
      const segmentRms = (segment: { from: number; to: number }): number => {
        const range = audioRange(segment)
        const windows = (analysis.windows ?? []).filter(
          (window) => window.startSec >= range.fromSec && window.startSec < range.toSec,
        )
        return Math.sqrt(
          windows.reduce((sum, window) => sum + window.rms * window.rms, 0) /
            Math.max(1, windows.length),
        )
      }
      const e1Rms = segmentRms(segments.e1!)
      const e2Rms = segmentRms(segments.e2!)
      const e3Rms = segmentRms(segments.e3!)
      const e4Rms = segmentRms(segments.e4!)
      const e5Rms = segmentRms(segments.e5!)
      expect(e1Rms, 'E1 CLAP baseline must be non-silent').toBeGreaterThan(0.03)
      expect(e2Rms, 'E2 VST3 replacement must be non-silent').toBeGreaterThan(0.03)
      expect(e3Rms, 'E3 rest pattern must be silent').toBeLessThan(0.005)
      expect(e4Rms, 'E4 failed replacement must leave B sounding').toBeGreaterThan(0.03)
      expect(e5Rms, 'E5 restored A must be non-silent').toBeGreaterThan(0.03)

      const e1Hz = estimateFundamentalHz(capture, audioRange(segments.e1!))
      const e2Hz = estimateFundamentalHz(capture, audioRange(segments.e2!))
      const e4Hz = estimateFundamentalHz(capture, audioRange(segments.e4!))
      const e5Hz = estimateFundamentalHz(capture, audioRange(segments.e5!))
      expect(e1Hz, 'E1 CLAP baseline needs a measurable fundamental').toBeDefined()
      expect(e2Hz, 'E2 VST3 replacement needs a measurable fundamental').toBeDefined()
      expect(e4Hz, 'E4 surviving VST3 needs a measurable fundamental').toBeDefined()
      expect(e5Hz, 'E5 restored CLAP needs a measurable fundamental').toBeDefined()
      expect(Math.abs(e2Hz! - e1Hz!) / e1Hz!).toBeGreaterThan(0.25)
      expect(Math.abs(e4Hz! - e2Hz!) / e2Hz!).toBeLessThan(0.02)
      expect(Math.abs(e5Hz! - e1Hz!) / e1Hz!).toBeLessThan(0.02)
      expect(Math.abs(e4Rms - e2Rms) / e2Rms).toBeLessThan(0.15)
    },
    TEST_TIMEOUT_MS * 2,
  )

  it.skipIf(!appAvailable)(
    'replaces and removes playing effects with audio, state, process, failure, routing, and master oracles (#625 R-E1-R-E7)',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      expect(
        workAudioDir,
        'main gated phase must initialize the audio fixture directory',
      ).toBeDefined()
      if (!client || !tmpRoot || !workAudioDir) {
        throw new Error('main gated phase did not initialize suite state')
      }
      const activeClient = client
      const root = tmpRoot
      const audioDir = workAudioDir
      const catalog = requireCatalogFixtures()
      const capturePath = path.join(root, 'effect-replace-remove-r-e1-r-e7.wav')
      const projectFile = path.join(root, 'project.yaml')
      const aIdentity = `fx625/effect/${catalog.clapEffectName}/0`
      const aStateRelativePath = 'states/e2e-effect-gain-025.state'
      const aStatePath = path.resolve(root, aStateRelativePath)
      // 🔴 B にも **非 unity** の gain を登録する。B を unity(1.0) のままにすると、
      // 「B が正しく透過している」と「B がロードされたが一度も適用されていない」が
      // **数値として区別できない**（実測: unity B の RMS は bus-active dry と 10 桁一致した）。
      // 後者は engaged の配線切断そのもので、変異検証で潰した欠陥と同じ症状。
      // A=0.25 / B=0.5 / dry=1.0 にすると 3 状態が相互に区別できる。
      const bIdentity = `fx625/effect/${catalog.vst3EffectName}/0`
      const bStateRelativePath = 'states/e2e-effect-gain-050.state'
      const bStatePath = path.resolve(root, bStateRelativePath)

      // A's state contract is shared by the CLAP/VST3 gain oracles: ORE1 + f64 LE.
      // Register it before the first declaration so R-E1 starts at gain 0.25.
      fs.mkdirSync(path.dirname(aStatePath), { recursive: true })
      const aState = Buffer.alloc(12)
      aState.writeUInt32LE(0x4f52_4531, 0)
      aState.writeDoubleLE(0.25, 4)
      fs.writeFileSync(aStatePath, aState)
      const bState = Buffer.alloc(12)
      bState.writeUInt32LE(0x4f52_4531, 0)
      bState.writeDoubleLE(0.5, 4)
      fs.writeFileSync(bStatePath, bState)
      const manifest = fs.existsSync(projectFile)
        ? (parse(fs.readFileSync(projectFile, 'utf8')) as {
            version?: number
            states?: Record<string, string>
          })
        : { version: 1 }
      fs.writeFileSync(
        projectFile,
        stringify({
          ...manifest,
          version: manifest.version ?? 1,
          states: {
            ...(manifest.states ?? {}),
            [aIdentity]: aStateRelativePath,
            [bIdentity]: bStateRelativePath,
          },
        }),
      )

      const countErrors = (log: string): number => (log.match(/ERROR:/g) ?? []).length
      const start = await activeClient.call('start_engine', { capture_wav: capturePath })
      expect(start.isError, start.text).toBe(false)
      await waitForEngine(true, 15_000, '#625 R-E1-R-E7 engine running')
      await sleep(2500)

      const segments: Record<string, { from: number; to: number }> = {}
      const captureSegment = async (name: string): Promise<void> => {
        await sleep(750)
        segments[name] = { from: Date.now(), to: 0 }
        await sleep(3000)
        segments[name]!.to = Date.now()
      }
      let stopWall = Date.now()
      try {
        // A dry segment with the final sum/aux routing already in place is the
        // reference for both failed replacement (R-E3) and remove (R-E6).
        const sourceSetup = await activeClient.call('evaluate_orbitscore', {
          code: [
            'var global = init GLOBAL',
            'global.tempo(120)',
            'global.beat(4 by 4)',
            `global.audioPath(${JSON.stringify(audioDir)})`,
            'global.sum("fx625out")',
            'global.aux("fx625send")',
            'global.start()',
            'var fx625 = init global.seq',
            'fx625.audio("kick.wav").chop(1)',
            'fx625.output("fx625out")',
            'fx625.send("fx625send", 0.2)',
            'fx625.play(1, 1, 1, 1)',
            'LOOP(fx625)',
          ].join('\n'),
        })
        expect(sourceSetup.isError, sourceSetup.text).toBe(false)
        await captureSegment('dryBaseline')

        // R-E1: A is the catalog-resolved CLAP effect restored at gain 0.25.
        const beforeA = (await activeClient.call('get_log', { lines: 500 })).text
        const declareA = await activeClient.call('evaluate_orbitscore', {
          code: `fx625.effect(${JSON.stringify(catalog.clapEffectName)})`,
        })
        expect(declareA.isError, declareA.text).toBe(false)
        await waitUntil(() => effectChildPids(activeClient).then((pids) => pids.length > 0), {
          intervalMs: 200,
          timeoutMs: 15_000,
          label: '#625 R-E1 CLAP effect child started',
        })
        const aChildPids = await effectChildPids(activeClient)
        expect(
          aChildPids.length,
          'R-E1 must observe the old CLAP effect child PID',
        ).toBeGreaterThan(0)
        const afterA = (await activeClient.call('get_log', { lines: 500 })).text
        // 🔴 厳密等価にしない。`get_log` は**固定 500 行の窓**なので、宣言が非エラー行を
        // 1 行でも足すと古い ERROR が窓から押し出されて**件数が減る**。この判定の意図は
        // 「**新しい ERROR を出していない**」であって「件数が寸分違わない」ではない。
        // #628 の実機ゲートで実際に踏んだ（rack child の spawn 通知 1 行で 477 → 475）。
        expect(
          countErrors(afterA),
          `R-E1 declaration must add no ERROR lines. Log tail: ${afterA.slice(-1200)}`,
        ).toBeLessThanOrEqual(countErrors(beforeA))
        await captureSegment('a')

        // R-E2: replace A with catalog-resolved B while LOOP is producing audio.
        const errorsBeforeB = countErrors((await activeClient.call('get_log', { lines: 500 })).text)
        const declareB = await activeClient.call('evaluate_orbitscore', {
          code: `fx625.effect(${JSON.stringify(catalog.vst3EffectName)})`,
        })
        expect(declareB.isError, declareB.text).toBe(false)
        await waitUntil(() => effectChildPids(activeClient).then((pids) => pids.length > 0), {
          intervalMs: 200,
          timeoutMs: 15_000,
          label: '#625 R-E2 VST3 effect child started',
        })
        // 🔴 #628 で意味論が変わった。**旧 child は消えない。**
        //
        // #625 までは「1 child = 1 プラグイン」だったので差し替え = プロセスの交換であり、
        // ここは「旧 child が消えた」を待っていた。#628 のラック化では **1 child が
        // チェーン全体を持つ**ため、差し替えは同じ child の中で prepare-commit される。
        // **PID が変わらないことこそが「respawn していない = dry 窓が消えた」の実機証明**で、
        // 本 PR の中心的な成果そのもの（設計 §2.2）。
        const bChildPids = await effectChildPids(activeClient)
        expect(bChildPids.length, 'R-E2 must observe the effect child PID').toBeGreaterThan(0)
        expect(
          bChildPids[bChildPids.length - 1],
          'R-E2: 差し替えで child を作り直してはいけない（in-child 編集 = dry 窓なし）',
        ).toBe(aChildPids[aChildPids.length - 1])
        expect(
          processExists(aChildPids[aChildPids.length - 1]),
          'R-E2: 旧 child のプロセスは生き続けていなければならない',
        ).toBe(true)
        const afterB = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterB),
          `R-E2 replacement must add no ERROR lines. Log tail: ${afterB.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeB)
        // 🔴 child PID が出ただけでは「新テナントが state 込みで立ち上がった」ことにならない。
        // 実測では PID 出現直後に測ると窓が遷移期間を拾い、B が 0.5x ではなく 0.6x に見えた
        // （同じ機構で測った recoveredB は 0.5000x ちょうどだった）。盲目的に sleep を伸ばす
        // のではなく、**B の state 復元ログという本物の信号**を待ってから測る。
        const bRestoreMarker = `[plugin-state] restoring '${bIdentity}'`
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            return log.includes(bRestoreMarker)
          },
          { intervalMs: 200, timeoutMs: 15_000, label: '#625 R-E2 B state restored' },
        )
        // 🔴 以前の「b 区間に余剰音が混入する」という仮説は実測で反証された。真因は壁時計と
        // 録音タイムラインの境界スキューによる次区間の混入で、後段の `SEGMENT_GUARD_SEC` が
        // 汚染された端の窓を除外する。この待ちは定常状態の区間幅を確保するために残す。
        await sleep(2500)
        await captureSegment('b')

        // R-E3 is the sole path-direct plugin declaration in this scenario.
        // A nonexistent catalog name would be rejected by TS resolution first;
        // this path must reach the daemon's apply-failure path.
        // 🔴 #628: ERROR 件数の前後比較はもう使わない。prepare-commit では失敗が
        // 旧チェーンを壊さないので、判定は「B が鳴り続けているか」（音）と
        // 「child PID が変わっていないか」（プロセス）で行う。
        const failedReplace = await activeClient.call('evaluate_orbitscore', {
          code: 'fx625.effect("/definitely/nonexistent/Issue625.vst3")',
        })
        // 🔴 #628 で失敗モデルが変わった（設計 §2.2）。
        //
        // #625 は「1 child = 1 プラグイン」だったので、差し替えは**解体してから建て直す**
        // in-place 型だった。解体後に load が失敗すると child が居なくなり dry へ縮退する —
        // だから旧テストは「ERROR が増える」「旧 child が消える」「child が 0 個」を見ていた。
        //
        // ラック化で編集は **prepare-commit** になった。load を全部済ませてから block 境界で
        // 1 回だけ swap するので、**失敗しても旧チェーンが無傷で鳴り続ける**。
        // これは縮退ではなく本 PR の中心的な成果なので、期待を反転させる。
        expect(
          failedReplace.isError,
          'R-E3: 存在しないプラグインへの差し替えは loud に失敗しなければならない',
        ).toBe(true)
        // **child は生き残る。** 旧チェーンがそのまま鳴っている証拠。
        const survivingPids = await effectChildPids(activeClient)
        expect(
          survivingPids[survivingPids.length - 1],
          'R-E3: 失敗しても child を作り直してはいけない（prepare-commit = 旧チェーン無傷）',
        ).toBe(bChildPids[bChildPids.length - 1])
        expect(
          processExists(bChildPids[bChildPids.length - 1]),
          'R-E3: 失敗で旧 child を殺してはいけない',
        ).toBe(true)
        await captureSegment('failedDry')

        // R-E4: no restart or other repair action — redeclaring B alone recovers.
        const errorsBeforeRecovery = countErrors(
          (await activeClient.call('get_log', { lines: 500 })).text,
        )
        const recoverB = await activeClient.call('evaluate_orbitscore', {
          code: `fx625.effect(${JSON.stringify(catalog.vst3EffectName)})`,
        })
        expect(recoverB.isError, recoverB.text).toBe(false)
        await waitUntil(() => effectChildPids(activeClient).then((pids) => pids.length > 0), {
          intervalMs: 200,
          timeoutMs: 15_000,
          label: '#625 R-E4 VST3 effect child recovered',
        })
        const recoveredBChildPids = await effectChildPids(activeClient)
        const afterRecovery = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterRecovery),
          `R-E4 recovery must add no ERROR lines. Log tail: ${afterRecovery.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeRecovery)
        await captureSegment('recoveredB')

        // R-E5: swapping back to A must use the sequence receiver identity and
        // restore its saved 0.25 state, not instantiate A at its default gain.
        const beforeSwapBackLog = (await activeClient.call('get_log', { lines: 500 })).text
        const errorsBeforeSwapBack = countErrors(beforeSwapBackLog)
        const restoreMarker = `[plugin-state] restoring '${aIdentity}'`
        const restoreMarkersBefore = beforeSwapBackLog.split(restoreMarker).length - 1
        const swapBackA = await activeClient.call('evaluate_orbitscore', {
          code: `fx625.effect(${JSON.stringify(catalog.clapEffectName)})`,
        })
        expect(swapBackA.isError, swapBackA.text).toBe(false)
        await waitUntil(() => effectChildPids(activeClient).then((pids) => pids.length > 0), {
          intervalMs: 200,
          timeoutMs: 15_000,
          label: '#625 R-E5 CLAP effect child restored',
        })
        // 🔴 #628: 差し替えは同じ child の中で prepare-commit される。**PID は変わらない。**
        //
        // 🔴 `effectChildPids` は**ログ全体から spawn 行を集める**ので、過去のシナリオで
        // 死んだ PID も含む。比較するのは**最新の 1 個**だけ。
        const afterSwapBackPids = await effectChildPids(activeClient)
        expect(
          afterSwapBackPids[afterSwapBackPids.length - 1],
          'R-E5: 差し替えで child を作り直してはいけない（in-child 編集）',
        ).toBe(recoveredBChildPids[recoveredBChildPids.length - 1])
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            return log.split(restoreMarker).length - 1 > restoreMarkersBefore
          },
          { intervalMs: 200, timeoutMs: 15_000, label: '#625 R-E5 old state restore log' },
        )
        const afterSwapBackLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterSwapBackLog),
          `R-E5 swap-back must add no ERROR lines. Log tail: ${afterSwapBackLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeSwapBack)
        const savedManifest = parse(fs.readFileSync(projectFile, 'utf8')) as {
          states: Record<string, string>
        }
        expect(savedManifest.states[aIdentity]).toBeDefined()
        expect(fs.existsSync(path.resolve(root, savedManifest.states[aIdentity]!))).toBe(true)
        const restoredAChildPids = await effectChildPids(activeClient)
        await captureSegment('restoredA')

        // R-E6: remove A, then re-evaluate both routing declarations. Their
        // ERROR count stays flat and the unchanged LOOP becomes dry again.
        const errorsBeforeRemove = countErrors(
          (await activeClient.call('get_log', { lines: 500 })).text,
        )
        // 🔴 #628: `remove()` は撤回された（SC.10.3c）。**削除は配列から消すこと**であり、
        // 空のラックを適用するのが「外す」の表現になった。
        const removeA = await activeClient.call('evaluate_orbitscore', {
          code: 'fx625.effect([])',
        })
        expect(removeA.isError, removeA.text).toBe(false)
        // チェーンが空になる場合は child が退場する（teardown）— ここは #625 と同じ。
        await waitUntil(
          () => Promise.resolve(restoredAChildPids.every((pid) => !processExists(pid))),
          {
            intervalMs: 200,
            timeoutMs: 10_000,
            label: '#628 R-E6 empty chain tears the effect child down',
          },
        )
        const routingAfterRemove = await activeClient.call('evaluate_orbitscore', {
          code: ['fx625.output("fx625out")', 'fx625.send("fx625send", 0.2)'].join('\n'),
        })
        expect(routingAfterRemove.isError, routingAfterRemove.text).toBe(false)
        const afterRemoveLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterRemoveLog),
          `R-E6 remove/routing must add no ERROR lines. Log tail: ${afterRemoveLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeRemove)
        await captureSegment('removedDry')

        // R-E7: the master slot uses the same catalog-only declaration surface,
        // but has distinct daemon bus semantics. Its minimum real-device oracle
        // is a clean A→B child-process handoff.
        const errorsBeforeMaster = countErrors(
          (await activeClient.call('get_log', { lines: 500 })).text,
        )
        const masterA = await activeClient.call('evaluate_orbitscore', {
          code: `global.effect(${JSON.stringify(catalog.clapEffectName)})`,
        })
        expect(masterA.isError, masterA.text).toBe(false)
        await waitUntil(() => effectChildPids(activeClient).then((pids) => pids.length > 0), {
          intervalMs: 200,
          timeoutMs: 15_000,
          label: '#625 R-E7 master CLAP effect child started',
        })
        const masterAChildPids = await effectChildPids(activeClient)
        const masterB = await activeClient.call('evaluate_orbitscore', {
          code: `global.effect(${JSON.stringify(catalog.vst3EffectName)})`,
        })
        expect(masterB.isError, masterB.text).toBe(false)
        await waitUntil(() => effectChildPids(activeClient).then((pids) => pids.length > 0), {
          intervalMs: 200,
          timeoutMs: 15_000,
          label: '#625 R-E7 master VST3 effect child started',
        })
        // 🔴 #628: master 経路も同じ。差し替えで child は作り直されない。
        // 比較は**最新の 1 個**（ログは過去の spawn も含む）。
        const afterMasterPids = await effectChildPids(activeClient)
        expect(
          afterMasterPids[afterMasterPids.length - 1],
          'R-E7: master の差し替えでも child を作り直してはいけない',
        ).toBe(masterAChildPids[masterAChildPids.length - 1])
        const afterMasterLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterMasterLog),
          `R-E7 master replacement must add no ERROR lines. Log tail: ${afterMasterLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeMaster)
      } finally {
        await activeClient.call('evaluate_orbitscore', {
          code: 'fx625.stop()\nglobal.stop()',
        })
        const stopped = await activeClient.call('stop_engine')
        expect(stopped.isError, stopped.text).toBe(false)
        stopWall = Date.now()
        await waitForEngine(false, 15_000, '#625 R-E1-R-E7 engine stopped')
        await sleep(1500)
      }

      const capture = fs.readFileSync(capturePath)
      const analysis = analyzeWavBuffer(capture, { windowMs: 100 })
      // 🔴 区間の両端に 400ms のガードを入れる。壁時計と録音タイムラインの間にはスキューが
      // あり、**次の操作の効果が窓の末尾に食い込む**。実測: b 区間の最後の 1 窓だけが
      // 0.232（= dry の打点レベル 0.115/0.5）を拾い、それだけで区間 RMS が 1.5 倍に見えた
      // （他の 5 窓は recoveredB と同じ 0.115 で、機構は正しく効いていた）。
      // ガードは「遷移ではなく定常状態を測る」ためのもので、主張そのものは緩めていない。
      const SEGMENT_GUARD_SEC = 0.4
      const audioRange = (segment: { from: number; to: number }) => ({
        fromSec: Math.max(
          0,
          analysis.durationSec - (stopWall - segment.from) / 1000 + SEGMENT_GUARD_SEC,
        ),
        toSec: Math.min(
          analysis.durationSec,
          analysis.durationSec - (stopWall - segment.to) / 1000 - SEGMENT_GUARD_SEC,
        ),
      })
      const segmentRms = (name: string): number => {
        const segment = segments[name]
        expect(segment, `${name} capture segment must exist`).toBeDefined()
        const range = audioRange(segment!)
        const windows = (analysis.windows ?? []).filter(
          (window) => window.startSec >= range.fromSec && window.startSec < range.toSec,
        )
        expect(windows.length, `${name} capture segment must contain RMS windows`).toBeGreaterThan(
          0,
        )
        return Math.sqrt(
          windows.reduce((sum, window) => sum + window.rms * window.rms, 0) / windows.length,
        )
      }
      const relativeDelta = (actual: number, expected: number): number =>
        Math.abs(actual - expected) / expected

      const dryRms = segmentRms('dryBaseline')
      const aRms = segmentRms('a')
      const bRms = segmentRms('b')
      const failedDryRms = segmentRms('failedDry')
      const recoveredBRms = segmentRms('recoveredB')
      const restoredARms = segmentRms('restoredA')
      const removedDryRms = segmentRms('removedDry')
      // 🔴 全区間の実測値を先に出す。1 つの assert で止まると残りの区間が見えず、
      // 高価な実機実行を払い直すことになる（#625 実測で実際に起きた）。
      // eslint-disable-next-line no-console
      console.log(
        '[#625 R-E1-R-E7] segment RMS: ' +
          JSON.stringify(
            {
              dryBaseline: dryRms,
              a: aRms,
              b: bRms,
              failedDry: failedDryRms,
              recoveredB: recoveredBRms,
              restoredA: restoredARms,
              removedDry: removedDryRms,
              'b/a': bRms / aRms,
              'b/dry': bRms / dryRms,
              'a/dry': aRms / dryRms,
              'failedDry/dry': failedDryRms / dryRms,
              'removedDry/dry': removedDryRms / dryRms,
            },
            null,
            0,
          ),
      )
      // 🔴 窓ごとの生系列。区間 RMS が 1.5 倍でも、(a) 全窓が一様に高い＝定常的な増幅 と
      // (b) 一部の窓だけ dry(1.0x) で残りが 0.5x ＝混在 は同じ集計値になる。原因の探索先が
      // まったく違うので、集計だけで判断しない。
      const segmentWindows = (segment: { from: number; to: number }): string => {
        const range = audioRange(segment)
        return (analysis.windows ?? [])
          .filter((w) => w.startSec >= range.fromSec && w.startSec < range.toSec)
          .map((w) => w.rms.toFixed(3))
          .join(',')
      }
      // eslint-disable-next-line no-console
      console.log('[#625 R-E1-R-E7] b windows: ' + segmentWindows(segments.b!))
      // eslint-disable-next-line no-console
      console.log('[#625 R-E1-R-E7] recoveredB windows: ' + segmentWindows(segments.recoveredB!))

      // 🔴 決着させる観測: 区間ごとの onset 数。b が 9/3s なら「余剰イベント」、
      // 6/3s のままなら「1 発あたりのエネルギー増」で、原因の探索先が変わる。
      const segmentOnsets = (segment: { from: number; to: number }): number => {
        const range = audioRange(segment)
        return (analysis.onsets ?? []).filter((t) => t >= range.fromSec && t < range.toSec).length
      }
      // eslint-disable-next-line no-console
      console.log(
        '[#625 R-E1-R-E7] segment onsets/3s: ' +
          JSON.stringify({
            dryBaseline: segmentOnsets(segments.dryBaseline!),
            a: segmentOnsets(segments.a!),
            b: segmentOnsets(segments.b!),
            failedDry: segmentOnsets(segments.failedDry!),
            recoveredB: segmentOnsets(segments.recoveredB!),
            restoredA: segmentOnsets(segments.restoredA!),
            removedDry: segmentOnsets(segments.removedDry!),
          }),
      )
      // 🔴 比較の基準は **bus がアクティブな dry**（= failedDry / removedDry）であって、
      // `dryBaseline` ではない。
      //
      // ⚠️ かつてここには「MX.4 の経路変化で √1.5 の差が出る」と書いていたが**それは誤り**
      // だった。実測を完全グラフモデルと突き合わせると、busDry は
      // `kick.wav の RMS 0.1230601 × 等パワーパン(1/√2) × (sum 1.0 + send 0.2) = 0.1044211`
      // と **6 桁一致**する（実測 0.1044200）。つまり busDry の方が理論値どおりで、
      // `dryBaseline` が低いのは **3 秒窓の先頭 1 秒が LOOP 開始レイテンシで無音**なため
      // （エネルギーがきっかり 2/3 = 振幅 √(2/3)）。経路の違いではない。
      // dryBaseline の待ちを 1 バー分足せば busDry と一致するはずである。
      // 🔴 #628 で `failedDry` は **dry ではなくなった**。
      //
      // #625 は in-place 型だったので、差し替えの失敗は dry 縮退を意味し、`failedDry` は
      // 本物の dry だった。ラック化で編集は prepare-commit になり、**失敗しても旧チェーンが
      // 鳴り続ける**（設計 §2.2）。だから `failedDry` は依然 wet で、この区間を dry の基準に
      // 使うことはできない。実測でも failedDry(0.0498) < removedDry(0.1084) と、
      // **旧チェーン（gain 0.25）が生きているぶん静か**になっている。
      //
      // 空チェーンを適用した `removedDry` が唯一の真の dry なので、基準をそちらへ移す。
      const busDryRms = removedDryRms
      const withinTolerance = 0.15

      // dryBaseline が主張できるのは「宣言前から音が流れている」ことだけ。
      expect(dryRms, 'dry baseline must be audibly non-silent').toBeGreaterThan(0.01)
      // 🔴 失敗が dry に落ちないこと自体を音で pin する（prepare-commit の実機証明）。
      expect(
        failedDryRms,
        `R-E3: 失敗しても旧チェーンが鳴り続ける = dry より静か (failed=${failedDryRms}, dry=${removedDryRms})`,
      ).toBeLessThan(removedDryRms)
      expect(failedDryRms, 'R-E3: 失敗で無音になってはいけない').toBeGreaterThan(0.002)

      // R-E1 / R-E2: gain は bus-active dry に対して素直に乗る（A=0.25 / B=0.5）。
      expect(aRms, 'R-E1 gain-0.25 A must remain audibly non-silent').toBeGreaterThan(0.002)
      expect(
        relativeDelta(aRms / busDryRms, 0.25),
        `R-E1 A must attenuate to 0.25x of bus-active dry (A=${aRms}, busDry=${busDryRms})`,
      ).toBeLessThanOrEqual(withinTolerance)
      expect(
        relativeDelta(bRms / busDryRms, 0.5),
        `R-E2 B must attenuate to 0.5x of bus-active dry (B=${bRms}, busDry=${busDryRms})`,
      ).toBeLessThanOrEqual(withinTolerance)
      expect(
        relativeDelta(bRms / aRms, 2),
        `R-E2 B/A RMS ratio must be about 2x (A=${aRms}, B=${bRms})`,
      ).toBeLessThanOrEqual(withinTolerance)

      // 🔴 R-E3: #628 で**期待が反転した**。失敗後は **B のまま鳴り続ける**。
      //
      // #625（in-place 型）は解体してから建て直すので、失敗すると dry へ縮退した — 旧テストは
      // 「dry であって A でも B でもない」を主張していた。ラック化で編集は **prepare-commit**
      // になり、load を全部済ませてから 1 回だけ swap するので、**失敗すれば旧チェーンが
      // 無傷のまま**である（設計 §2.2）。これは縮退の回避であり、本 PR の中心的な成果。
      //
      // 実測でも failedDry と B が **0.08% 差**で一致した（0.049822 / 0.049780）。
      // B は非 unity（gain 0.5 系）なので、「B のまま」と「dry」は数値で区別できる —
      // この主張が意味を持つのはそのおかげ。
      expect(failedDryRms, 'R-E3 failure must not stop the audio').toBeGreaterThan(0.01)
      expect(
        relativeDelta(failedDryRms, bRms),
        `R-E3: 失敗しても B が鳴り続ける = prepare-commit の実機証明 (failedDry=${failedDryRms}, B=${bRms})`,
      ).toBeLessThanOrEqual(withinTolerance)
      expect(
        relativeDelta(failedDryRms, aRms),
        `R-E3: 失敗後の音が A に戻ってはいけない (failedDry=${failedDryRms}, A=${aRms})`,
      ).toBeGreaterThan(withinTolerance)

      // R-E4 / R-E5: 再宣言だけで B へ戻り、swap-back で保存済みの A の音色が戻る。
      expect(
        relativeDelta(recoveredBRms, bRms),
        `R-E4 recovered B RMS ${recoveredBRms} must match original B ${bRms}`,
      ).toBeLessThanOrEqual(withinTolerance)
      expect(
        relativeDelta(restoredARms, aRms),
        `R-E5 restored A RMS ${restoredARms} must match original A ${aRms}`,
      ).toBeLessThanOrEqual(withinTolerance)

      // R-E6: remove 後は bus-active dry へ戻り、routing は生きたまま音が流れ続ける。
      expect(
        relativeDelta(removedDryRms, bRms),
        `R-E6 removed effect must NOT still sound like B (removedDry=${removedDryRms}, B=${bRms})`,
      ).toBeGreaterThan(withinTolerance)
      expect(removedDryRms, 'R-E6 routing must keep audio flowing after remove').toBeGreaterThan(
        0.01,
      )
    },
    TEST_TIMEOUT_MS * 2,
  )

  it.skipIf(!appAvailable)(
    '#628 R28: rack chain audio mainline',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      expect(
        workAudioDir,
        'main gated phase must initialize the audio fixture directory',
      ).toBeDefined()
      if (!client || !tmpRoot || !workAudioDir) {
        throw new Error('main gated phase did not initialize suite state')
      }

      const activeClient = client
      const root = tmpRoot
      const audioDir = workAudioDir
      const catalog = requireCatalogFixtures()
      const capturePath = path.join(root, 'rack-chain-r28-mainline.wav')
      const projectFile = path.join(root, 'project.yaml')
      const statesDirectory = path.join(root, 'states')
      const { audible, ratios, stages } = RACK_CHAIN_GAIN_EXPECTATIONS
      const aIdentity = `fx628/effect/${catalog.clapEffectName}/0`
      const bIdentity = `fx628/effect/${catalog.vst3EffectName}/0`
      const aStateRelativePath = 'states/e2e-r28-catalog-a.state'
      const bStateRelativePath = 'states/e2e-r28-catalog-b.state'
      const aStatePath = path.resolve(root, aStateRelativePath)
      const bStatePath = path.resolve(root, bStateRelativePath)
      const countErrors = (log: string): number => (log.match(/ERROR:/g) ?? []).length
      const countMarker = (log: string, marker: string): number => log.split(marker).length - 1
      const readLog = async (): Promise<string> =>
        (await activeClient.call('get_log', { lines: 500 })).text
      const assertCurrentPid = async (expectedPid: number, label: string): Promise<void> => {
        const pids = rackChildPidsFromLog(await readLog())
        expect(pids[pids.length - 1], `${label}: rack child PID must stay unchanged`).toBe(
          expectedPid,
        )
        expect(processExists(expectedPid), `${label}: rack child must remain alive`).toBe(true)
      }

      fs.mkdirSync(statesDirectory, { recursive: true })
      const aState = Buffer.alloc(12)
      aState.writeUInt32LE(0x4f52_4531, 0)
      aState.writeDoubleLE(stages.catalogA, 4)
      fs.writeFileSync(aStatePath, aState)
      const bState = Buffer.alloc(12)
      bState.writeUInt32LE(0x4f52_4531, 0)
      bState.writeDoubleLE(stages.catalogB, 4)
      fs.writeFileSync(bStatePath, bState)
      const manifest = fs.existsSync(projectFile)
        ? (parse(fs.readFileSync(projectFile, 'utf8')) as {
            version?: number
            states?: Record<string, string>
          })
        : { version: 1 }
      fs.writeFileSync(
        projectFile,
        stringify({
          ...manifest,
          version: manifest.version ?? 1,
          states: {
            ...(manifest.states ?? {}),
            [aIdentity]: aStateRelativePath,
            [bIdentity]: bStateRelativePath,
          },
        }),
      )

      await startR28Engine(activeClient, '#628 R28 capture engine', capturePath)

      const segments: Record<string, { from: number; to: number }> = {}
      const captureSegment = async (name: string): Promise<void> => {
        await sleep(750)
        segments[name] = { from: Date.now(), to: 0 }
        await sleep(3000)
        segments[name]!.to = Date.now()
      }
      let stopWall = Date.now()

      try {
        // A previous suite block may leave a master declaration in the persistent interpreter
        // registry. Clear it before taking the bus-dry reference so the R28 ratio oracle is local.
        const liveRackPidsAtSetup = (await effectChildPids(activeClient)).filter(processExists)
        const errorsBeforeSource = countErrors(await readLog())
        await activeClient.call('evaluate_orbitscore', {
          code: [
            'var global = init GLOBAL',
            'global.effect([])',
            'global.tempo(120)',
            'global.beat(4 by 4)',
            `global.audioPath(${JSON.stringify(audioDir)})`,
            'global.sum("fx628out")',
            'global.aux("fx628send")',
            'global.start()',
            'var fx628 = init global.seq',
            'fx628.audio("kick.wav").chop(1)',
            'fx628.output("fx628out")',
            'fx628.send("fx628send", 0.2)',
            'fx628.play(1, 1, 1, 1)',
            'LOOP(fx628)',
          ].join('\n'),
        })
        await waitUntil(() => liveRackPidsAtSetup.every((pid) => !processExists(pid)), {
          intervalMs: 200,
          timeoutMs: 15_000,
          label: '#628 R28 stale master rack teardown before dry capture',
        })
        const afterSourceLog = await readLog()
        expect(
          countErrors(afterSourceLog),
          `R28 source setup must add no ERROR lines. Log tail: ${afterSourceLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeSource)
        await sleep(2500)
        await captureSegment('busDry')

        const stateFilesBeforeFull = stateFileCount(statesDirectory)
        const beforeFullLog = await readLog()
        const errorsBeforeFull = countErrors(beforeFullLog)
        const spawnsBeforeFull = rackChildPidsFromLog(beforeFullLog)
        const aRestoreMarker = `[plugin-state] restoring '${aIdentity}'`
        const bRestoreMarker = `[plugin-state] restoring '${bIdentity}'`
        const aRestoresBeforeFull = countMarker(beforeFullLog, aRestoreMarker)
        const bRestoresBeforeFull = countMarker(beforeFullLog, bRestoreMarker)
        await activeClient.call('evaluate_orbitscore', {
          code: [
            `var rack628 = [${JSON.stringify(catalog.clapEffectName)}, ${JSON.stringify(
              catalog.vst3EffectName,
            )}, Gain(db: ${stages.standardDb})]`,
            'fx628.effect(rack628)',
          ].join('\n'),
        })
        await waitUntil(
          async () => {
            const log = await readLog()
            return (
              rackChildPidsFromLog(log).length > spawnsBeforeFull.length &&
              countMarker(log, aRestoreMarker) > aRestoresBeforeFull &&
              countMarker(log, bRestoreMarker) > bRestoresBeforeFull
            )
          },
          {
            intervalMs: 200,
            timeoutMs: 15_000,
            label:
              '#628 R28 seg2 rack child READY; verify bundled std-plugins/Gain.clap if this times out',
          },
        )
        const afterFullLog = await readLog()
        const fullPids = rackChildPidsFromLog(afterFullLog)
        expect(fullPids.length, 'R28 seg2: three stages must spawn exactly one rack child').toBe(
          spawnsBeforeFull.length + 1,
        )
        const rackPid = fullPids[fullPids.length - 1]!
        expect(processExists(rackPid), 'R28 seg2: spawned rack child must be alive').toBe(true)
        expect(
          countMarker(afterFullLog, aRestoreMarker),
          'R28 seg2: A state restore marker must increase exactly once',
        ).toBe(aRestoresBeforeFull + 1)
        expect(
          countMarker(afterFullLog, bRestoreMarker),
          'R28 seg2: B state restore marker must increase exactly once',
        ).toBe(bRestoresBeforeFull + 1)
        expect(
          countErrors(afterFullLog),
          `R28 seg2 full rack must add no ERROR lines. Log tail: ${afterFullLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeFull)
        await captureSegment('full')
        expect(
          stateFileCount(statesDirectory),
          'R28 seg2: loading the full rack must not save state files',
        ).toBe(stateFilesBeforeFull)

        // enabled:false must be a bypass, not a drop+load. Audio distinguishes the bypassed
        // level from a no-op; the state-file snapshot distinguishes bypass from drop.
        const errorsBeforeBypass = countErrors(await readLog())
        await activeClient.call('evaluate_orbitscore', {
          code: `fx628.effect([plugin(${JSON.stringify(
            catalog.clapEffectName,
          )}, enabled: false), ${JSON.stringify(catalog.vst3EffectName)}, Gain(db: ${
            stages.standardDb
          })])`,
        })
        await assertCurrentPid(rackPid, 'R28 seg3 bypass')
        await captureSegment('bypassA')
        const afterBypassLog = await readLog()
        expect(
          countErrors(afterBypassLog),
          `R28 seg3 bypass must add no ERROR lines. Log tail: ${afterBypassLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeBypass)
        expect(
          stateFileCount(statesDirectory),
          'R28 seg3: enabled:false is bypass and must not save a state file',
        ).toBe(stateFilesBeforeFull)

        const errorsBeforeReenable = countErrors(await readLog())
        const aRestoresBeforeReenable = countMarker(await readLog(), aRestoreMarker)
        const bRestoresBeforeReenable = countMarker(await readLog(), bRestoreMarker)
        await activeClient.call('evaluate_orbitscore', {
          code: `fx628.effect([${JSON.stringify(catalog.clapEffectName)}, ${JSON.stringify(
            catalog.vst3EffectName,
          )}, Gain(db: ${stages.standardDb})])`,
        })
        await assertCurrentPid(rackPid, 'R28 seg4 re-enable')
        await captureSegment('reEnabled')
        const afterReenableLog = await readLog()
        expect(
          countErrors(afterReenableLog),
          `R28 seg4 re-enable must add no ERROR lines. Log tail: ${afterReenableLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeReenable)
        expect(
          stateFileCount(statesDirectory),
          'R28 seg4: re-enable must not save a state file',
        ).toBe(stateFilesBeforeFull)
        // This is only the observable shadow of keep (a reload without state restore remains C5's job).
        expect(
          countMarker(afterReenableLog, aRestoreMarker),
          'R28 seg4: re-enable must not restore A again',
        ).toBe(aRestoresBeforeReenable)
        expect(
          countMarker(afterReenableLog, bRestoreMarker),
          'R28 seg4: re-enable must not restore B again',
        ).toBe(bRestoresBeforeReenable)

        // APPLY returns before its dropped-state registration is safely observable at the project
        // boundary. Poll the exact +1 file count AND the rewritten manifest entry; a fixed sleep is
        // the flaky shape this gate is intended to avoid.
        const errorsBeforeDropB = countErrors(await readLog())
        const stateFilesBeforeDropB = stateFileCount(statesDirectory)
        const manifestBPathBeforeDrop = (
          parse(fs.readFileSync(projectFile, 'utf8')) as { states?: Record<string, string> }
        ).states?.[bIdentity]
        await activeClient.call('evaluate_orbitscore', {
          code: `fx628.effect([${JSON.stringify(catalog.clapEffectName)}, Gain(db: ${
            stages.standardDb
          })])`,
        })
        await waitUntil(
          () => {
            if (stateFileCount(statesDirectory) !== stateFilesBeforeDropB + 1) return false
            const registered = (
              parse(fs.readFileSync(projectFile, 'utf8')) as { states?: Record<string, string> }
            ).states?.[bIdentity]
            return (
              typeof registered === 'string' &&
              registered !== manifestBPathBeforeDrop &&
              fs.existsSync(path.resolve(root, registered))
            )
          },
          {
            intervalMs: 200,
            timeoutMs: 15_000,
            label: '#628 R28 seg5 post-APPLY B state file + project.yaml registration',
          },
        )
        await assertCurrentPid(rackPid, 'R28 seg5 drop B')
        await captureSegment('withoutB')
        const afterDropBLog = await readLog()
        expect(
          countErrors(afterDropBLog),
          `R28 seg5 drop B must add no ERROR lines. Log tail: ${afterDropBLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeDropB)
        expect(
          stateFileCount(statesDirectory),
          'R28 seg5: catalog drop must save exactly one state file',
        ).toBe(stateFilesBeforeDropB + 1)
        const savedAfterDrop = parse(fs.readFileSync(projectFile, 'utf8')) as {
          states?: Record<string, string>
        }
        const savedBRelativePath = savedAfterDrop.states?.[bIdentity]
        expect(savedBRelativePath, 'R28 seg5: project.yaml must register B identity').toBeDefined()
        expect(
          fs.existsSync(path.resolve(root, savedBRelativePath!)),
          'R28 seg5: registered B state file must exist',
        ).toBe(true)

        const errorsBeforeReaddB = countErrors(await readLog())
        const beforeReaddBLog = await readLog()
        const bRestoresBeforeReadd = countMarker(beforeReaddBLog, bRestoreMarker)
        await activeClient.call('evaluate_orbitscore', {
          code: `fx628.effect([${JSON.stringify(catalog.clapEffectName)}, ${JSON.stringify(
            catalog.vst3EffectName,
          )}, Gain(db: ${stages.standardDb})])`,
        })
        await waitUntil(
          async () => countMarker(await readLog(), bRestoreMarker) > bRestoresBeforeReadd,
          { intervalMs: 200, timeoutMs: 15_000, label: '#628 R28 seg6 B occurrence-0 restore' },
        )
        await assertCurrentPid(rackPid, 'R28 seg6 re-add B')
        await captureSegment('reAddedB')
        const afterReaddBLog = await readLog()
        expect(
          countMarker(afterReaddBLog, bRestoreMarker),
          'R28 seg6: B occurrence-0 restore marker must increase exactly once',
        ).toBe(bRestoresBeforeReadd + 1)
        expect(
          countErrors(afterReaddBLog),
          `R28 seg6 re-add B must add no ERROR lines. Log tail: ${afterReaddBLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeReaddB)
        expect(
          stateFileCount(statesDirectory),
          'R28 seg6: re-add must reuse the registered B state without another save',
        ).toBe(stateFilesBeforeDropB + 1)

        const errorsBeforeDropGain = countErrors(await readLog())
        const restoreCountBeforeDropGain = countMarker(await readLog(), '[plugin-state] restoring ')
        const stateFilesBeforeDropGain = stateFileCount(statesDirectory)
        await activeClient.call('evaluate_orbitscore', {
          code: `fx628.effect([${JSON.stringify(catalog.clapEffectName)}, ${JSON.stringify(
            catalog.vst3EffectName,
          )}])`,
        })
        await assertCurrentPid(rackPid, 'R28 seg7 drop Gain')
        await captureSegment('withoutGain')
        const afterDropGainLog = await readLog()
        expect(
          countErrors(afterDropGainLog),
          `R28 seg7 drop Gain must add no ERROR lines. Log tail: ${afterDropGainLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeDropGain)
        expect(
          stateFileCount(statesDirectory),
          'R28 seg7: dropping a standard stage must not save state',
        ).toBe(stateFilesBeforeDropGain)
        expect(
          countMarker(afterDropGainLog, '[plugin-state] restoring '),
          'R28 seg7: dropping a standard stage must not restore plugin state',
        ).toBe(restoreCountBeforeDropGain)

        const errorsBeforeReaddGain = countErrors(await readLog())
        const restoreCountBeforeReaddGain = countMarker(
          await readLog(),
          '[plugin-state] restoring ',
        )
        await activeClient.call('evaluate_orbitscore', {
          code: `fx628.effect([${JSON.stringify(catalog.clapEffectName)}, ${JSON.stringify(
            catalog.vst3EffectName,
          )}, Gain(db: ${stages.standardDb})])`,
        })
        await assertCurrentPid(rackPid, 'R28 seg8 re-add Gain')
        await captureSegment('reAddedGain')
        const afterReaddGainLog = await readLog()
        expect(
          countErrors(afterReaddGainLog),
          `R28 seg8 re-add Gain must add no ERROR lines. Log tail: ${afterReaddGainLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeReaddGain)
        expect(
          stateFileCount(statesDirectory),
          'R28 seg8: re-adding a standard stage must not create state',
        ).toBe(stateFilesBeforeDropGain)
        expect(
          countMarker(afterReaddGainLog, '[plugin-state] restoring '),
          'R28 seg8: standard stages have no restore path',
        ).toBe(restoreCountBeforeReaddGain)

        const errorsBeforeParamEdit = countErrors(await readLog())
        await activeClient.call('evaluate_orbitscore', {
          code: `fx628.effect([${JSON.stringify(catalog.clapEffectName)}, ${JSON.stringify(
            catalog.vst3EffectName,
          )}, Gain(db: ${stages.standardUnityDb})])`,
        })
        await assertCurrentPid(rackPid, 'R28 seg9 Gain parameter edit')
        await captureSegment('gainUnity')
        const afterParamEditLog = await readLog()
        expect(
          countErrors(afterParamEditLog),
          `R28 seg9 param edit must add no ERROR lines. Log tail: ${afterParamEditLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeParamEdit)
        expect(
          stateFileCount(statesDirectory),
          'R28 seg9: standard parameter edits must not create state',
        ).toBe(stateFilesBeforeDropGain)

        const failure = await activeClient.call('evaluate_orbitscore', {
          code: `fx628.effect([${JSON.stringify(catalog.clapEffectName)}, ${JSON.stringify(
            catalog.vst3EffectName,
          )}, Gain(db: ${stages.standardUnityDb}), "/nonexistent/Issue628.vst3"])`,
        })
        expect(failure.isError, 'R28 seg10: partial construction failure must be loud').toBe(true)
        // Copied verbatim from effect-slot.ts rackApplyProtocolError's intact-registry outcome.
        expect(failure.text).toContain('the previous chain is kept')
        await assertCurrentPid(rackPid, 'R28 seg10 failed four-stage apply')
        await captureSegment('failedApply')
        expect(
          stateFileCount(statesDirectory),
          'R28 seg10: failed prepare-commit must not save or drop state',
        ).toBe(stateFilesBeforeDropGain)
      } finally {
        await activeClient.call('evaluate_orbitscore', {
          code: 'fx628.effect([])\nfx628.stop()\nglobal.stop()',
        })
        const stopped = await activeClient.call('stop_engine')
        expect(stopped.isError, stopped.text).toBe(false)
        stopWall = Date.now()
        await waitForEngine(false, 15_000, '#628 R28 capture engine stopped')
        await sleep(1500)
      }

      const capture = fs.readFileSync(capturePath)
      const analysis = analyzeWavBuffer(capture, { windowMs: 100 })
      const SEGMENT_GUARD_SEC = 0.4
      const audioRange = (segment: { from: number; to: number }) => ({
        fromSec: Math.max(
          0,
          analysis.durationSec - (stopWall - segment.from) / 1000 + SEGMENT_GUARD_SEC,
        ),
        toSec: Math.min(
          analysis.durationSec,
          analysis.durationSec - (stopWall - segment.to) / 1000 - SEGMENT_GUARD_SEC,
        ),
      })
      const rmsWindows = (name: string) => {
        const segment = segments[name]
        expect(segment, `${name} capture segment must exist`).toBeDefined()
        const range = audioRange(segment!)
        const windows = (analysis.windows ?? []).filter(
          (window) => window.startSec >= range.fromSec && window.startSec < range.toSec,
        )
        expect(windows.length, `${name} must contain guarded RMS windows`).toBeGreaterThan(0)
        return windows
      }
      const segmentRms = (name: string): number => {
        const windows = rmsWindows(name)
        return Math.sqrt(
          windows.reduce((sum, window) => sum + window.rms * window.rms, 0) / windows.length,
        )
      }
      const segmentWindows = (name: string): string =>
        rmsWindows(name)
          .map((window) => window.rms.toFixed(3))
          .join(',')
      const segmentOnsets = (name: string): number => {
        const range = audioRange(segments[name]!)
        return (analysis.onsets ?? []).filter(
          (onset) => onset >= range.fromSec && onset < range.toSec,
        ).length
      }
      const relativeDelta = (actual: number, expected: number): number =>
        Math.abs(actual - expected) / expected
      const rms = {
        busDry: segmentRms('busDry'),
        full: segmentRms('full'),
        bypassA: segmentRms('bypassA'),
        reEnabled: segmentRms('reEnabled'),
        withoutB: segmentRms('withoutB'),
        reAddedB: segmentRms('reAddedB'),
        withoutGain: segmentRms('withoutGain'),
        reAddedGain: segmentRms('reAddedGain'),
        gainUnity: segmentRms('gainUnity'),
        failedApply: segmentRms('failedApply'),
      }
      const segmentNames = Object.keys(rms)

      // Print every expensive observation before the first ratio assertion.
      // eslint-disable-next-line no-console
      console.log(
        '[#628 R28] segment RMS: ' +
          JSON.stringify({
            ...rms,
            'full/dry': rms.full / rms.busDry,
            'bypassA/dry': rms.bypassA / rms.busDry,
            'withoutB/dry': rms.withoutB / rms.busDry,
            'withoutGain/dry': rms.withoutGain / rms.busDry,
            'gainUnity/dry': rms.gainUnity / rms.busDry,
            'failedApply/gainUnity': rms.failedApply / rms.gainUnity,
          }),
      )
      // eslint-disable-next-line no-console
      console.log(
        '[#628 R28] segment windows: ' +
          JSON.stringify(
            Object.fromEntries(segmentNames.map((name) => [name, segmentWindows(name)])),
          ),
      )
      // eslint-disable-next-line no-console
      console.log(
        '[#628 R28] segment onsets/3s: ' +
          JSON.stringify(
            Object.fromEntries(segmentNames.map((name) => [name, segmentOnsets(name)])),
          ),
      )

      const withinTolerance = 0.15
      expect(rms.busDry, 'R28 seg1 routing must produce audible dry audio').toBeGreaterThan(0.01)
      expect(
        rms.full,
        'R28 seg2 full rack must stay at least five times above the audible floor',
      ).toBeGreaterThanOrEqual(audible.floorRms * audible.minimumFloorMultiple)
      const expectedRatios = {
        full: ratios.full,
        bypassA: ratios.withoutCatalogA,
        reEnabled: ratios.full,
        withoutB: ratios.withoutCatalogB,
        reAddedB: ratios.full,
        withoutGain: ratios.withoutStandard,
        reAddedGain: ratios.full,
        gainUnity: ratios.withoutStandard,
      }
      for (const [name, expectedRatio] of Object.entries(expectedRatios)) {
        const actualRatio = rms[name as keyof typeof rms] / rms.busDry
        expect(
          relativeDelta(actualRatio, expectedRatio),
          `R28 ${name} must be ${expectedRatio}x bus dry (actual=${actualRatio})`,
        ).toBeLessThanOrEqual(withinTolerance)
      }
      expect(
        relativeDelta(rms.failedApply, rms.gainUnity),
        'R28 seg10: failed partial construction must leave the previous chain audible',
      ).toBeLessThanOrEqual(withinTolerance)
      expect(
        rms.failedApply,
        'R28 seg10: failed partial construction must not stop audio',
      ).toBeGreaterThan(audible.floorRms)
    },
    TEST_TIMEOUT_MS * 3,
  )

  it.skipIf(!appAvailable)(
    '#628 R28: rack master + MCP standard-element error',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      if (!client) throw new Error('main gated phase did not initialize suite state')
      const activeClient = client
      const catalog = requireCatalogFixtures()
      const { stages } = RACK_CHAIN_GAIN_EXPECTATIONS
      const countErrors = (log: string): number => (log.match(/ERROR:/g) ?? []).length
      const readLog = async (): Promise<string> =>
        (await activeClient.call('get_log', { lines: 500 })).text

      await startR28Engine(activeClient, '#628 R28 master engine')

      let masterPid: number | undefined
      try {
        const beforeMasterLog = await readLog()
        const errorsBeforeMaster = countErrors(beforeMasterLog)
        const spawnsBeforeMaster = rackChildPidsFromLog(beforeMasterLog)
        await activeClient.call('evaluate_orbitscore', {
          code: [
            'var global = init GLOBAL',
            `global.effect([${JSON.stringify(catalog.clapEffectName)}, Gain(db: ${
              stages.standardDb
            })])`,
          ].join('\n'),
        })
        await waitUntil(
          async () => rackChildPidsFromLog(await readLog()).length > spawnsBeforeMaster.length,
          {
            intervalMs: 200,
            timeoutMs: 15_000,
            label:
              '#628 R28 master rack child READY; verify bundled std-plugins/Gain.clap if this times out',
          },
        )
        const afterMasterLog = await readLog()
        const masterPids = rackChildPidsFromLog(afterMasterLog)
        expect(
          masterPids.length,
          'R28 E8: master [catalog, Gain] must spawn exactly one rack child',
        ).toBe(spawnsBeforeMaster.length + 1)
        masterPid = masterPids[masterPids.length - 1]
        expect(processExists(masterPid!), 'R28 E8: master rack child must be alive').toBe(true)
        expect(
          countErrors(afterMasterLog),
          `R28 E8 master apply must add no ERROR lines. Log tail: ${afterMasterLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeMaster)

        const standardUi = await activeClient.call('open_plugin_ui', {
          receiver: 'master',
          chain_path: [1],
        })
        expect(
          standardUi.isError,
          'R28 E10a: the standard Gain stage must reject UI explicitly',
        ).toBe(true)
        // Copied verbatim from global.ts resolvePluginStateEntry's standard-element branch.
        expect(standardUi.text).toContain('parameters live in the DSL')

        const conflictingAddress = await activeClient.call('open_plugin_ui', {
          receiver: 'master',
          chain_path: [1],
          index: 1,
        })
        expect(
          conflictingAddress.isError,
          'R28 E10a: conflicting compatibility index and chain_path must be loud',
        ).toBe(true)
        // Copied from mcp-server.ts resolveMcpPluginUiIndex's conflicting-address branch.
        expect(conflictingAddress.text).toContain(
          'index 1 conflicts with chain_path [1]; chain_path selects compatibility index 2',
        )

        const errorsBeforeMasterEdit = countErrors(await readLog())
        await activeClient.call('evaluate_orbitscore', {
          code: `global.effect([${JSON.stringify(catalog.clapEffectName)}])`,
        })
        const afterMasterEditLog = await readLog()
        const afterMasterEditPids = rackChildPidsFromLog(afterMasterEditLog)
        expect(
          afterMasterEditPids[afterMasterEditPids.length - 1],
          'R28 E8: master rack edit must not respawn its child',
        ).toBe(masterPid)
        expect(processExists(masterPid), 'R28 E8: edited master child must remain alive').toBe(true)
        expect(
          countErrors(afterMasterEditLog),
          `R28 E8 master edit must add no ERROR lines. Log tail: ${afterMasterEditLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeMasterEdit)
      } finally {
        await activeClient.call('evaluate_orbitscore', { code: 'global.effect([])' })
        if (masterPid !== undefined) {
          await waitUntil(() => !processExists(masterPid!), {
            intervalMs: 200,
            timeoutMs: 15_000,
            label: '#628 R28 master rack cleanup',
          })
        }
        const stopped = await activeClient.call('stop_engine')
        expect(stopped.isError, stopped.text).toBe(false)
        await waitForEngine(false, 15_000, '#628 R28 master engine stopped')
      }
    },
    TEST_TIMEOUT_MS,
  )
})
