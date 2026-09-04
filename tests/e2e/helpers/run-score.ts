/**
 * 譜面を work copy にして実機で評価する 1 関数（#668 設計 §4.2）。
 *
 * work copy → open_file → set_selection（全体）→ run_selection → body → stop → capture 解析。
 * capture を要求すると engine を一度落として `capture_wav` 付きで起動し直す（spawn 専用
 * オプション。`orbitstudio-mcp-gated.spec.ts` の `startR28Engine` と同じ retry-once
 * パターン — #640 実測: 負荷時に「daemon ready line timeout」が起きうる）。
 *
 * 🔴 `captureInstrumentScenario`（gated spec `:475-604`）を置き換えない。あちらは 7 つの
 * #643 シナリオが依存する用途特化のまま残す。こちらはより薄い層で、将来はあちらの内部で
 * 使われうる（本 PR では寄せない — 既存 20 本の意味を変えないことを優先する）。
 */
import * as fs from 'fs'
import * as path from 'path'

import { expect } from 'vitest'

import {
  analyzeWavBuffer,
  type WavAnalysis,
} from '../../../packages/vscode-extension/src/wav-analysis'

import type { GatedSession } from './gated-session'
import { sleep, waitUntil, type McpClient } from './mcp-client'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const LIVE_MODE_MARKER = '🎵 Live coding mode'
const STARTUP_TIMEOUT_MARKER = 'daemon ready line timeout after 10000ms'

export interface ScoreSource {
  /** 一時ファイル名の元。capture / work copy の basename に使う。 */
  readonly slug: string
  /** 譜面。行配列（テスト内で組む）か、リポジトリの fixture パス。 */
  readonly lines?: readonly string[]
  readonly fixturePath?: string
  /**
   * 🔴 fixture のリポジトリ相対**深さ**を tmpRoot 配下に再現する（既定 true）。
   * #528: フラットな tmpRoot へ写すと `audioPath("../../../…")` が外へ出て
   * `[SAMPLE_NOT_FOUND]` になり、capture が無音のまま緑になった。
   */
  readonly preserveDepth?: boolean
}

interface CaptureSegment {
  readonly from: number
  readonly to: number
}

export interface CaptureWindows {
  readonly analysis: WavAnalysis
  readonly capturePath: string
  /** 区間名 → その区間の窓を二乗平均した RMS。`captureInstrumentScenario` と同一計算。 */
  rms(segment: string, guardSec?: number): number
  /** 区間の窓列（peak を見たい時・不連続の検査）。 */
  windows(
    segment: string,
    guardSec?: number,
  ): ReadonlyArray<{ startSec: number; peak: number; rms: number }>
  /** 区間内のオンセット時刻（時間構造）。`analysis.onsets` の絞り込み。 */
  onsets(segment: string): readonly number[]
  /** 区間 × チャンネルの RMS。pan / 分離 / stem の判定はここを使う（#668 §10）。 */
  channelRms(segment: string, channel: number, guardSec?: number): number
}

export interface ScoreRunContext {
  readonly session: GatedSession
  /** 追加評価（`evaluate_orbitscore`）。`ok` に assert しない — 診断は engine-log helper で見る。 */
  evaluate(code: string): Promise<void>
  /** 名前つき区間を録る（settle → duration）。`captureInstrumentScenario` の同名関数と同型。 */
  captureSegment(name: string, durationMs?: number, settleMs?: number): Promise<void>
}

function markerCount(log: string, marker: string): number {
  return log.split(marker).length - 1
}

async function waitForEngineState(
  client: McpClient,
  running: boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  await waitUntil(
    async () => {
      const stateRes = await client.call('get_engine_state')
      return (JSON.parse(stateRes.text) as { running: boolean }).running === running
    },
    { intervalMs: 500, timeoutMs, label },
  )
}

/**
 * capture 付きで engine を (再) 起動する。既に別テストがエンジンを起動していると
 * `capture_wav` は spawn 専用オプションなので弾かれる — capture を要求する時は必ず
 * 一度落としてから起動する（#643 の教訓）。
 */
async function startEngineForRun(
  client: McpClient,
  label: string,
  captureWav: string | undefined,
): Promise<void> {
  if (captureWav !== undefined) {
    await client.call('stop_engine')
    await waitForEngineState(client, false, 15_000, `${label} stopped before capture start`)
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const beforeLog = (await client.call('get_log', { lines: 500 })).text
    const liveModeBefore = markerCount(beforeLog, LIVE_MODE_MARKER)
    const startupTimeoutsBefore = markerCount(beforeLog, STARTUP_TIMEOUT_MARKER)
    const started = await client.call(
      'start_engine',
      captureWav === undefined ? {} : { capture_wav: captureWav },
    )
    if (started.isError) throw new Error(`${label} did not start: ${started.text}`)
    try {
      await waitUntil(
        async () => {
          const log = (await client.call('get_log', { lines: 500 })).text
          return markerCount(log, LIVE_MODE_MARKER) > liveModeBefore
        },
        { intervalMs: 200, timeoutMs: 30_000, label: `${label} daemon-backed REPL ready` },
      )
      return
    } catch (error) {
      const startupLog = (await client.call('get_log', { lines: 500 })).text
      const sawFreshKnownTimeout =
        markerCount(startupLog, STARTUP_TIMEOUT_MARKER) > startupTimeoutsBefore
      if (attempt === 1 && sawFreshKnownTimeout) {
        const stopped = await client.call('stop_engine')
        expect(stopped.isError, stopped.text).toBe(false)
        await waitForEngineState(
          client,
          false,
          15_000,
          `${label} timed-out attempt stopped before retry`,
        )
        continue
      }
      throw new Error(`${String(error)}\n--- OrbitScore output channel ---\n${startupLog}`)
    }
  }
}

/** work copy の絶対パスと、選択範囲を組むための行数を用意する。 */
function prepareWorkCopy(
  tmpRoot: string,
  source: ScoreSource,
): { path: string; lineCount: number } {
  if (source.fixturePath !== undefined) {
    const preserveDepth = source.preserveDepth ?? true
    const absFixture = path.isAbsolute(source.fixturePath)
      ? source.fixturePath
      : path.join(REPO_ROOT, source.fixturePath)
    const content = fs.readFileSync(absFixture, 'utf8')
    const destDir = preserveDepth
      ? path.join(tmpRoot, path.dirname(path.relative(REPO_ROOT, absFixture)))
      : tmpRoot
    fs.mkdirSync(destDir, { recursive: true })
    const dest = path.join(destDir, path.basename(absFixture))
    fs.writeFileSync(dest, content)
    return { path: dest, lineCount: content.split('\n').length }
  }
  const lines = source.lines ?? []
  const dest = path.join(tmpRoot, `${source.slug}.orbs`)
  fs.writeFileSync(dest, lines.join('\n') + '\n')
  return { path: dest, lineCount: lines.length }
}

/**
 * 譜面を work copy にして実機で評価する。`opts.capture` が true の時だけ WAV を解析して返す。
 */
export async function runScore(
  session: GatedSession,
  source: ScoreSource,
  body?: (ctx: ScoreRunContext) => Promise<void>,
  opts?: { capture?: boolean },
): Promise<CaptureWindows | undefined> {
  const { client, tmpRoot } = session
  const wantsCapture = opts?.capture === true
  const capturePath = wantsCapture ? session.captureWavPath(source.slug) : undefined

  const { path: workPath, lineCount } = prepareWorkCopy(tmpRoot, source)

  await startEngineForRun(client, `runScore ${source.slug}`, capturePath)

  const segments: Record<string, CaptureSegment> = {}
  let stopWall = Date.now()

  const evaluate = async (code: string): Promise<void> => {
    // 🔴 **`ok` / `isError` に assert しない**（設計 §4.2）。診断は `engine-log.ts` の
    // `expectNoNewErrors` / `expectLogMarkerAtLeast` で見る。
    //
    // なぜ assert しないか: **診断が出ることを確かめる E2E がある**（doc 610 の異常系は
    // 「この譜面は診断を出す」が判定条件）。ここで弾くと、そちらが `runScore` を使えない。
    // 逆に #614 以降 `ok` は「評価完了までに診断が無かった」までしか保証しないので、
    // 正常系でも `ok` は十分条件にならない（評価後に非同期で起きる失敗は `get_log` だけに出る）。
    await client.call('evaluate_orbitscore', { code })
  }
  const captureSegment = async (name: string, durationMs = 2000, settleMs = 400): Promise<void> => {
    if (settleMs > 0) await sleep(settleMs)
    const from = Date.now()
    await sleep(durationMs)
    segments[name] = { from, to: Date.now() }
  }

  try {
    const opened = await client.call('open_file', { path: workPath })
    expect(opened.isError, opened.text).toBe(false)
    // 「全体を選択する」= 現行 `orbitstudio-mcp-gated.spec.ts` と同じ範囲指定。
    // エディタ経路を通すので拡張が注入する `global.setDocumentDirectory(...)` が乗る
    // （#528 / #630 が守りたい経路そのもの）。
    const selected = await client.call('set_selection', {
      start_line: 1,
      start_char: 1,
      end_line: Math.max(1, lineCount),
      end_char: 999_999,
    })
    expect(selected.isError, selected.text).toBe(false)
    const run = await client.call('run_selection')
    expect(run.isError, run.text).toBe(false)

    if (body) await body({ session, evaluate, captureSegment })
  } finally {
    await client.call('evaluate_orbitscore', { code: 'global.stop()' })
    const stopped = await client.call('stop_engine')
    expect(stopped.isError, stopped.text).toBe(false)
    stopWall = Date.now()
    await waitForEngineState(client, false, 15_000, `runScore ${source.slug} engine stopped`)
    await sleep(1000)
  }

  if (!wantsCapture || capturePath === undefined) return undefined

  const capture = fs.readFileSync(capturePath)
  const analysis = analyzeWavBuffer(capture, { windowMs: 20, perChannel: true })
  const range = (segment: CaptureSegment, guardSec: number) => ({
    fromSec: Math.max(0, analysis.durationSec - (stopWall - segment.from) / 1000 + guardSec),
    toSec: Math.min(
      analysis.durationSec,
      analysis.durationSec - (stopWall - segment.to) / 1000 - guardSec,
    ),
  })
  const requireSegment = (name: string): CaptureSegment => {
    const segment = segments[name]
    expect(segment, `runScore ${source.slug} segment '${name}' must exist`).toBeDefined()
    return segment as CaptureSegment
  }
  const windowsFor = (
    name: string,
    guardSec = 0.15,
  ): ReadonlyArray<{ startSec: number; peak: number; rms: number }> => {
    const requested = range(requireSegment(name), guardSec)
    const selected = (analysis.windows ?? []).filter(
      (window) => window.startSec >= requested.fromSec && window.startSec < requested.toSec,
    )
    expect(
      selected.length,
      `runScore ${source.slug} segment '${name}' must contain windows`,
    ).toBeGreaterThan(0)
    return selected
  }
  const rms = (name: string, guardSec = 0.15): number => {
    const selected = windowsFor(name, guardSec)
    return Math.sqrt(
      selected.reduce((sum, window) => sum + window.rms * window.rms, 0) / selected.length,
    )
  }
  const onsets = (name: string): readonly number[] => {
    const requested = range(requireSegment(name), 0)
    return analysis.onsets.filter((t) => t >= requested.fromSec && t < requested.toSec)
  }
  const channelRms = (name: string, channel: number, guardSec = 0.15): number => {
    const perChannel = analysis.channelWindows?.[channel]
    expect(
      perChannel,
      `runScore ${source.slug} channelWindows must exist for channel ${channel} ` +
        `(analysis.format.channels=${analysis.format.channels})`,
    ).toBeDefined()
    const requested = range(requireSegment(name), guardSec)
    const selected = (perChannel ?? []).filter(
      (window) => window.startSec >= requested.fromSec && window.startSec < requested.toSec,
    )
    expect(
      selected.length,
      `runScore ${source.slug} segment '${name}' channel ${channel} must contain windows`,
    ).toBeGreaterThan(0)
    return Math.sqrt(
      selected.reduce((sum, window) => sum + window.rms * window.rms, 0) / selected.length,
    )
  }

  return { analysis, capturePath, rms, windows: windowsFor, onsets, channelRms }
}
