/**
 * #311 phase 2 tier(c) 検証ハーネスの共有ユーティリティ。
 *
 * - fixture `.orbs` を RecordingScheduler 注入の InterpreterV2 で実行し、生の構造スケジュール
 *   （= Leg 2 の DUT）を得る。
 * - その構造スケジュールを RustEnginePlayer の **production `toDaemonParams`**（本番発火と
 *   共有の変換）で解決し、golden schedule JSON（= Leg 1 の GRM）を組み立てる。
 * - golden JSON は committed。Leg 2 テストが「生成 == コミット済み」を assert して drift を
 *   検出する。`UPDATE_GOLDEN=1` で上書き生成する（標準 golden パターン）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

import { vi } from 'vitest'

import { parseAudioDSL } from '../../../packages/engine/src/parser/audio-parser'
import { InterpreterV2 } from '../../../packages/engine/src/interpreter/interpreter-v2'
import {
  RustEnginePlayer,
  type ScheduledPlay,
} from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'

import { RecordingScheduler } from './recording-scheduler'

/**
 * RUN()（one-shot）が付与する先読みバッファ（ms）。`runSequence` の `currentTime + 100`
 * 由来で、fake timers で `Date.now()` を凍結すると `currentTime=0` になり、記録される
 * `time` = `musical onset + 100` の定数オフセットになる。Leg 2 オラクルはこの定数を足す。
 */
export const RUN_SCHEDULE_BUFFER_MS = 100

/** 凍結する system time（任意の固定値。fake timers で決定論化するための anchor）。 */
const FROZEN_NOW_MS = 1_000_000

export const VERIFY_FIXTURES_DIR = resolve(__dirname, '../../../test-assets/verify-fixtures')

/**
 * fixture 相対の尺キーを絶対パスに直す（audio() が documentDirectory 基準で絶対化するため、
 * seed 側も絶対パスで揃える）。`recordSchedule` と `resolveGolden` が共有する。
 */
function toAbsDurations(durations: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(durations).map(([rel, sec]) => [resolve(VERIFY_FIXTURES_DIR, rel), sec]),
  )
}

/** golden schedule JSON の 1 イベント（Leg 1 が消費する解決済み daemon params）。 */
export interface GoldenEvent {
  /** 発音 onset（秒・相対）。`time/1000`。 */
  onsetSec: number
  /** WAV の basename（Rust は test-assets/audio/<sample> で解決）。 */
  sample: string
  /** linear amplitude（`toDaemonParams` 経由）。 */
  gain: number
  /** daemon pan [-1,1]。 */
  pan: number
  /** slice 領域開始（秒）。0 = 先頭。 */
  offsetSec: number
  /** slice 領域長（秒）。0 = offset 以降すべて。 */
  durationSec: number
  /** トレーサビリティ用の生値。 */
  gainDb: number
  panRaw: number
  sequenceName: string
}

export interface GoldenSchedule {
  fixture: string
  sampleRate: number
  events: GoldenEvent[]
}

/**
 * fixture を RecordingScheduler 注入で実行し、生の構造スケジュール（time 昇順）を返す。
 * fake timers で `Date.now()` を凍結し、記録 `time` を決定論化する。呼び出し側は
 * `vi.useRealTimers()` を afterEach 等で戻すこと。
 */
export async function recordSchedule(
  fixtureName: string,
  durations: Record<string, number>,
): Promise<ScheduledPlay[]> {
  vi.useFakeTimers()
  vi.setSystemTime(FROZEN_NOW_MS)
  const fixturePath = resolve(VERIFY_FIXTURES_DIR, `${fixtureName}.orbs`)
  const source = readFileSync(fixturePath, 'utf8')
  const ir = parseAudioDSL(source)
  const recording = new RecordingScheduler(toAbsDurations(durations))
  const interp = new InterpreterV2({ audioEngine: recording })
  await interp.execute(ir, { documentDirectory: dirname(fixturePath) })
  return recording.getRecorded()
}

/**
 * 構造スケジュールを RustEnginePlayer の `toDaemonParams`（本番共有変換）で解決し、
 * golden schedule を組み立てる。**領域・gain・pan の変換は本番経路と同一コード**を通すので、
 * 検証が test double を見て緑になる drift を防ぐ（GRM 独立性は Leg 2 のオラクルが担保）。
 */
export function resolveGolden(
  fixtureName: string,
  recorded: ScheduledPlay[],
  durations: Record<string, number>,
  sampleRate = 48_000,
): GoldenSchedule {
  const player = new RustEnginePlayer()
  for (const [abs, sec] of Object.entries(toAbsDurations(durations))) {
    player.seedDuration(abs, sec)
  }
  const events: GoldenEvent[] = recorded.map((play) => {
    const { gain, pan, offsetSec, durationSec } = player.toDaemonParams(play)
    return {
      onsetSec: play.time / 1000,
      sample: basename(play.filepath),
      gain,
      pan,
      offsetSec,
      durationSec,
      gainDb: play.gainDb,
      panRaw: play.pan,
      sequenceName: play.sequenceName,
    }
  })
  return { fixture: fixtureName, sampleRate, events }
}

/** golden JSON のパス。 */
export function goldenPath(fixtureName: string): string {
  return resolve(VERIFY_FIXTURES_DIR, `${fixtureName}.schedule.json`)
}

/**
 * golden を committed JSON と突き合わせる（staleness 検出）。`UPDATE_GOLDEN=1` の時は
 * 上書き生成する。戻り値は「committed と一致したか」（UPDATE 時は常に true）。
 */
export function reconcileGolden(golden: GoldenSchedule): {
  updated: boolean
  committed: GoldenSchedule | null
} {
  const path = goldenPath(golden.fixture)
  const serialized = JSON.stringify(golden, null, 2) + '\n'
  if (process.env.UPDATE_GOLDEN === '1') {
    // CI で誤って UPDATE_GOLDEN が立つと staleness 検出が無言で死に、committed を
    // 上書きしてしまう。意図（ローカル再生成専用）を機械強制し、ローカルでも上書きはログに残す。
    if (process.env.CI) {
      throw new Error(
        'UPDATE_GOLDEN=1 は CI では使用不可です（golden staleness 検出を無効化し commit を上書きするため）',
      )
    }
    console.warn(`[UPDATE_GOLDEN] committed golden を上書き: ${path}`)
    writeFileSync(path, serialized)
    return { updated: true, committed: golden }
  }
  let committed: GoldenSchedule | null = null
  try {
    committed = JSON.parse(readFileSync(path, 'utf8')) as GoldenSchedule
  } catch (err) {
    // ENOENT（未生成）は null で正しい。それ以外（JSON 破損 / truncate / merge conflict
    // marker 等）を null 扱いすると「破損」を「未生成」と取り違え、UPDATE_GOLDEN でバグを
    // 焼き込む経路になるため re-throw して loud に落とす。
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      committed = null
    } else {
      throw err
    }
  }
  return { updated: false, committed }
}
