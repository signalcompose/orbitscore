/**
 * #316 Leg 2（interpreter がスケジュールを正しく計算するか）— examples/22 (#304) parity。
 *
 * fixture `examples22_parity.orbs`（examples/22 の #304 パラメータを de-overlap したもの）を
 * RecordingScheduler 注入の InterpreterV2 で実行し、生の構造スケジュールを **.orbs と DSL 仕様
 * から人手で導いた音楽単位オラクル** と突き合わせる（解決済み daemon param に変換しない＝
 * トートロジー回避・GRM 独立性）。あわせて Leg 1 用の golden schedule JSON を本番共有の
 * `toDaemonParams` で生成し committed と一致するか検証する。
 *
 * オラクルの手計算（.orbs を読んで）:
 *   tempo 120 / beat 4/4 / length 4 → 8.0s。play 16 要素 → subdivision = 8.0/16 = 0.5s 刻み
 *   （spec: length(2)→8要素 と同型。subdivision は play 要素数で決まり chop とは独立）。
 *     kick  play step0  → onset 0ms    / gainDb -3 / pan -60 / chop(1) 全体（slice なし）
 *     snare play step4  → onset 2000ms / gainDb -6 / pan +60 / chop(1) 全体
 *     hat   play step8  → onset 4000ms / gainDb -9 / pan   0 / chop(1) 全体
 *     chopd play step12 → onset 6000ms / gainDb -4 / pan +20 / chop(2) slice index=1
 *           play step14 → onset 7000ms / gainDb -4 / pan +20 / chop(2) slice index=2
 *   記録 time = musical onset + RUN_SCHEDULE_BUFFER_MS(100)（RUN one-shot の先読み）。
 *   golden offsetSec: slice1=(1-1)*0.5=0.0s、slice2=(2-1)*0.5=0.5s。durationSec=0.5s 各。
 *   ※ length>1（=4）を harness で初めて通す。interpreter が length>1 を別解釈するなら、この
 *      独立オラクルとの不一致でここが落ちる（verification が仕事をする）。
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

import {
  recordSchedule,
  resolveGolden,
  reconcileGolden,
  RUN_SCHEDULE_BUFFER_MS,
} from './schedule-golden'

const FIXTURE = 'examples22_parity'
/** 全サンプル尺（f32 mono 48k）。slice scheduling（chopd）が getAudioDuration を要求する。 */
const DURATIONS = {
  '../audio/kick.wav': 0.5,
  '../audio/snare.wav': 0.2,
  '../audio/hihat_closed.wav': 0.05,
  '../audio/arpeggio_c.wav': 1.0,
}

/** .orbs + DSL 仕様から手書きした期待スケジュール（interpreter で計算しない）。time 昇順。 */
const ORACLE = [
  { onsetMs: 0, gainDb: -3, pan: -60, sequenceName: 'kick', sliceIndex: undefined },
  { onsetMs: 2000, gainDb: -6, pan: 60, sequenceName: 'snare', sliceIndex: undefined },
  { onsetMs: 4000, gainDb: -9, pan: 0, sequenceName: 'hat', sliceIndex: undefined },
  { onsetMs: 6000, gainDb: -4, pan: 20, sequenceName: 'chopd', sliceIndex: 1 },
  { onsetMs: 7000, gainDb: -4, pan: 20, sequenceName: 'chopd', sliceIndex: 2 },
]

describe('#316 Leg 2 — examples22_parity: interpreter schedule vs hand oracle', () => {
  afterEach(() => vi.useRealTimers())

  it('records the structurally-correct schedule (onset / gainDb / pan / slice)', async () => {
    const recorded = await recordSchedule(FIXTURE, DURATIONS)

    expect(recorded).toHaveLength(ORACLE.length)
    recorded.forEach((play, i) => {
      const exp = ORACLE[i]
      // onset: 記録 time === 音楽 onset + RUN buffer（fake timers で厳密）。
      expect(play.time).toBe(exp.onsetMs + RUN_SCHEDULE_BUFFER_MS)
      expect(play.gainDb).toBe(exp.gainDb)
      expect(play.pan).toBe(exp.pan)
      expect(play.sequenceName).toBe(exp.sequenceName)
      if (exp.sliceIndex === undefined) {
        // chop(1) = 全体再生 → slice は付かない。
        expect(play.slice).toBeUndefined()
      } else {
        expect(play.slice).toBeDefined()
        expect(play.slice!.index).toBe(exp.sliceIndex)
        expect(play.slice!.total).toBe(2)
      }
    })
  })

  it('golden schedule JSON matches committed (Leg 1 GRM・staleness guard)', async () => {
    const recorded = await recordSchedule(FIXTURE, DURATIONS)
    const golden = resolveGolden(FIXTURE, recorded, DURATIONS)
    // chopd の slice 領域を**手計算定数**で直接検証する（toDaemonParams 自己参照の式バグを
    // GRM 独立に捕まえる）。arpeggio_c 1.0s / chop(2): slice1 offset 0.0s / slice2 0.5s、各 dur 0.5s。
    const chopd = golden.events.filter((e) => e.sequenceName === 'chopd')
    expect(chopd).toHaveLength(2)
    expect(chopd[0].offsetSec).toBeCloseTo(0.0, 5)
    expect(chopd[1].offsetSec).toBeCloseTo(0.5, 5)
    expect(chopd[0].durationSec).toBeCloseTo(0.5, 5)
    expect(chopd[1].durationSec).toBeCloseTo(0.5, 5)
    // chop(1) 全体再生は領域を持たない（offset 0 / dur 0）。
    const whole = golden.events.filter((e) => e.sequenceName !== 'chopd')
    whole.forEach((e) => {
      expect(e.offsetSec).toBeCloseTo(0.0, 5)
      expect(e.durationSec).toBeCloseTo(0.0, 5)
    })
    const { updated, committed } = reconcileGolden(golden)
    if (updated) return // UPDATE_GOLDEN=1 で再生成した場合は突き合わせをスキップ。
    expect(committed, 'golden JSON missing — run with UPDATE_GOLDEN=1 to generate').not.toBeNull()
    expect(golden).toEqual(committed)
  })
})
