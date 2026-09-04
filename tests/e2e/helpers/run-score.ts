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

import { analyzeWavBuffer } from '../../../packages/vscode-extension/src/wav-analysis'

import {
  captureWindowsFrom,
  createCaptureClock,
  prepareCapturePath,
  readCaptureForAnalysis,
  waitForSound,
  type CaptureSegment,
  type CaptureWindows,
} from './capture-windows'
import type { GatedSession } from './gated-session'
import { sleep, waitUntil, type McpClient } from './mcp-client'

export type { CaptureWindows } from './capture-windows'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const LIVE_MODE_MARKER = '🎵 Live coding mode'
const STARTUP_TIMEOUT_MARKER = 'daemon ready line timeout after 10000ms'

/**
 * 起動判定の錨に使う `get_log` 末尾の長さ（文字）。
 *
 * daemon の起動で増えるのは十数行なので、この長さがあれば錨は 500 行窓に残る。
 */
const LOG_ANCHOR_CHARS = 400

/**
 * 🔴 `get_log` は**固定 500 行の窓**なので、「マーカーの件数が増えたか」では再起動を判定できない。
 *
 * 窓が飽和すると、新しい `🎵 Live coding mode` を 1 行足しても**古いマーカーが同時に押し出される**ため
 * 件数が増えない（減ることさえある）。#611 PR-O0 の実測: 既存 20 本を走らせた後の O0-3 / O0-4 が
 * 「daemon-backed REPL ready after 30000ms」で必ずタイムアウトした。engine 自体は起動していた。
 * ERROR 件数を厳密等価で見ない規律（`gated-assertion-hygiene.spec.ts`）と**同じ理由**である。
 *
 * 代わりに **`start_engine` の直前のログ末尾を錨**にして、その後ろに現れた分だけを新しい出力と見る。
 *
 * 🔴 **錨が見つからないときはログ全体が新しい出力である。** 錨は前の窓の**末尾**から取り、
 * 窓は**先頭から**落ちる。したがって末尾が消えているなら、それより古い行はすべて消えている —
 * 今の窓に残っているのは起動後に出た分だけ、ということになる。だから全体を返すのが正しく、
 * 「判定できない」として待つのは**誤り**である。
 *
 * ⚠️ 一度 `undefined` を返す実装にしたところ、`#628 R28` が
 * 「daemon-backed REPL ready after 30000ms」で落ちた（2026-09-04 実機・PR-O0）。
 * ラック child の起動で 500 行以上が流れ、錨が窓から出ただけだったのに、
 * 「まだ起動していない」と判定して待ち続けていた。
 */
export function logAppendedSince(anchor: string, log: string): string {
  if (anchor.length === 0) return log
  const index = log.lastIndexOf(anchor)
  return index === -1 ? log : log.slice(index + anchor.length)
}

/** `logAppendedSince` に渡す錨を作る（末尾 `LOG_ANCHOR_CHARS` 文字）。 */
export function logAnchor(log: string): string {
  return log.slice(-LOG_ANCHOR_CHARS)
}

/**
 * 相対差（`|actual - expected| / |expected|`）。capture の窓 RMS を golden と突き合わせる時の唯一の正本。
 *
 * gated spec に同名のローカル定義が **2 つ**あり（式はどちらも `… / expected` で同一）、
 * ここへ 1 本化した。ついでに分母を `Math.abs(expected)` にして期待値が負の場面にも耐えるようにした
 * — 今の期待値はすべて正なので**挙動は変わらない**。
 *
 * ⚠️ 「3 つあって式が食い違っていた」と書いていたのは**誤り**だった（レビューで判明）。
 * 3 つ目の食い違う定義は、この共通化で新しく作った**この関数自身**である。
 */
export function relativeDelta(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected)
}

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

export interface ScoreRunContext {
  readonly session: GatedSession
  /** 追加評価（`evaluate_orbitscore`）。`ok` に assert しない — 診断は engine-log helper で見る。 */
  evaluate(code: string): Promise<void>
  /** 名前つき区間を録る（初回だけ発音待ち → settle → duration）。 */
  captureSegment(name: string, durationMs?: number, settleMs?: number): Promise<void>
}

// #645 PR-D0 (post-hoc fix): exported so a caller that needs staged run_selection
// calls at specific line ranges — not the whole-file-at-once flow `runScore()`
// provides — can still get the SAME hardened engine-(re)start (guaranteed clean
// process for `capture_wav`, retry-once on the known daemon-ready timeout, and a
// "🎵 Live coding mode" marker wait instead of a bare `get_engine_state.running`
// check) without duplicating it.
export async function waitForEngineState(
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
export async function startEngineForRun(
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
    const anchor = logAnchor(beforeLog)
    const started = await client.call(
      'start_engine',
      captureWav === undefined ? {} : { capture_wav: captureWav },
    )
    if (started.isError) throw new Error(`${label} did not start: ${started.text}`)
    try {
      await waitUntil(
        async () => {
          const log = (await client.call('get_log', { lines: 500 })).text
          // 🔴 件数比較ではなく「錨より後ろに出たか」を見る（`logAppendedSince` の注記）。
          return logAppendedSince(anchor, log).includes(LIVE_MODE_MARKER)
        },
        { intervalMs: 200, timeoutMs: 30_000, label: `${label} daemon-backed REPL ready` },
      )
      return
    } catch (error) {
      const startupLog = (await client.call('get_log', { lines: 500 })).text
      // retry するかの判定も同じ窓の問題を持つので、同じ錨方式で見る。
      const sawFreshKnownTimeout = logAppendedSince(anchor, startupLog).includes(
        STARTUP_TIMEOUT_MARKER,
      )
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

  if (capturePath !== undefined) prepareCapturePath(capturePath)
  await startEngineForRun(client, `runScore ${source.slug}`, capturePath)

  const segments: Record<string, CaptureSegment> = {}
  let captureClock: (() => number) | undefined
  let soundReady = false

  const evaluate = async (code: string): Promise<void> => {
    // 🔴 **`ok` / `isError` に assert しない**（設計 §4.2）。診断は `engine-log.ts` の
    // `expectNoNewErrors` / `expectLogMarkerAtLeast` で見る。
    //
    // なぜ assert しないか: **診断が出ることを確かめる E2E がある**（doc 610 の異常系は
    // 「この譜面は診断を出す」が判定条件）。ここで弾くと、そちらが `runScore` を使えない。
    // 逆に #614 以降 `ok` は「評価完了までに診断が無かった」までしか保証しないので、
    // 正常系でも `ok` は十分条件にならない（評価後に非同期で起きる失敗は `get_log` だけに出る）。
    //
    // 🔴 **ただし「assert しない」は「握り潰す」ではない**（silent-failure レビュー 2026-09-04）。
    // `ok` は**必要条件**で、`ok: false` は `get_log` を漁らずその場で取れる一次シグナルである
    // （パース / 実行時診断・`mcp-server.ts` の tool 説明）。捨てると、セットアップの typo が
    // **後段の「音が鳴っていない」というアサーション失敗として現れる** — 書いた本人は
    // オーディオの不具合を疑って延々探すことになる。**assert はせず、見えるようにする。**
    const result = await client.call('evaluate_orbitscore', { code })
    if (result.isError) {
      // eslint-disable-next-line no-console
      console.warn(
        `[runScore ${source.slug}] evaluate_orbitscore reported a diagnostic (not asserted — ` +
          `a test may be verifying it on purpose):\n${result.text}`,
      )
    }
  }
  const captureSegment = async (name: string, durationMs = 2000, settleMs = 400): Promise<void> => {
    if (capturePath === undefined) {
      throw new Error(`runScore ${source.slug}: captureSegment requires { capture: true }`)
    }
    const clock = (captureClock ??= createCaptureClock(capturePath))
    if (!soundReady) {
      await waitForSound(capturePath, {
        floor: 0.01,
        intervalMs: 250,
        timeoutMs: 20_000,
        label: `runScore ${source.slug}`,
      })
      soundReady = true
    }
    if (settleMs > 0) await sleep(settleMs)
    const fromWall = Date.now()
    const fromSec = clock()
    await sleep(durationMs)
    const toSec = clock()
    const toWall = Date.now()
    segments[name] = { fromSec, toSec, fromWall, toWall }
  }

  let bodyError: unknown
  let cleanupFailure: unknown
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
  } catch (error) {
    bodyError = error
    throw error
  } finally {
    // 🔴 **cleanup の失敗が本来の失敗を隠さないようにする**（silent-failure レビュー 2026-09-04）。
    // JS では `finally` が投げると `try` 側の例外を**完全に置き換える**。よりによって
    // 「エンジンが落ちる」ことを検証するテストほど `stop_engine` / 停止待ちも一緒に転ぶので、
    // 書いた本人に見えるのが本質と無関係な「停止待ちタイムアウト」だけ、という事故が起きる。
    try {
      await client.call('evaluate_orbitscore', { code: 'global.stop()' })
      const stopped = await client.call('stop_engine')
      expect(stopped.isError, stopped.text).toBe(false)
      await waitForEngineState(client, false, 15_000, `runScore ${source.slug} engine stopped`)
      await sleep(1000)
    } catch (cleanupError) {
      if (bodyError === undefined) {
        // 本体は通ったのに片付けだけ失敗した — これは本物の失敗なので後で投げる。
        cleanupFailure = cleanupError
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[runScore ${source.slug}] cleanup also failed; reporting the original failure instead:` +
            `\n${String(cleanupError)}`,
        )
      }
    }
  }
  // 🔴 `finally` の中で throw すると `try` の例外を**置き換えてしまう**（lint の
  // `no-unsafe-finally` が指すとおり）。片付けだけが失敗した場合は、ブロックを抜けてから投げる。
  if (cleanupFailure !== undefined) throw cleanupFailure

  if (!wantsCapture || capturePath === undefined) return undefined

  const capture = readCaptureForAnalysis(capturePath)
  const analysis = analyzeWavBuffer(capture, { windowMs: 20, perChannel: true })
  return captureWindowsFrom(analysis, segments, `runScore ${source.slug}`, capturePath)
}
