/**
 * #311 phase 2 tier(c) — Leg 2（interpreter がスケジュールを正しく計算するか）。
 *
 * fixture `pan_three_voices.orbs` を RecordingScheduler 注入の InterpreterV2 で実行し、
 * 生の構造スケジュールを **.orbs と DSL 仕様から人手で導いた音楽単位オラクル** と突き合わせる
 * （解決済み daemon param には変換しない＝トートロジー回避・GRM 独立性）。あわせて Leg 1 用の
 * golden schedule JSON を本番共有の `toDaemonParams` で生成し、committed と一致するか検証する。
 *
 * オラクルの手計算（.orbs を読んで）:
 *   tempo 60 / beat 4/4 / length 1 → bar = 4 beats × (60/60)s = 4.0s、play() 4 要素 →
 *   subdivision = 1.0s。各 voice の play パターン:
 *     left  play(1,0,0,0) → step0 = 0ms   / gainDb -3 / pan -100（hard-left）
 *     mid   play(0,0,1,0) → step2 = 2000ms / gainDb -3 / pan -50（中間・判別の鍵）
 *     right play(0,0,0,1) → step3 = 3000ms / gainDb -3 / pan +100（hard-right）
 *   記録 time = musical onset + RUN_SCHEDULE_BUFFER_MS(100)（RUN one-shot の先読み）。
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

import {
  recordSchedule,
  resolveGolden,
  reconcileGolden,
  RUN_SCHEDULE_BUFFER_MS,
} from './schedule-golden'

const FIXTURE = 'pan_three_voices'
/** kick.wav = 0.5s mono（slice 無しなので尺は使わないが seed 経路を通す）。 */
const DURATIONS = { '../audio/kick.wav': 0.5 }

/** .orbs + DSL 仕様から手書きした期待スケジュール（interpreter で計算しない）。 */
const ORACLE = [
  { onsetMs: 0, gainDb: -3, pan: -100, sequenceName: 'left' },
  { onsetMs: 2000, gainDb: -3, pan: -50, sequenceName: 'mid' },
  { onsetMs: 3000, gainDb: -3, pan: 100, sequenceName: 'right' },
]

describe('#311 Leg 2 — pan_three_voices: interpreter schedule vs hand oracle', () => {
  afterEach(() => vi.useRealTimers())

  it('records the structurally-correct schedule (onset / gainDb / pan / no-slice)', async () => {
    const recorded = await recordSchedule(FIXTURE, DURATIONS)

    expect(recorded).toHaveLength(ORACLE.length)
    recorded.forEach((play, i) => {
      const exp = ORACLE[i]
      // onset: 記録 time === 音楽 onset + RUN buffer（fake timers で厳密）。
      expect(play.time).toBe(exp.onsetMs + RUN_SCHEDULE_BUFFER_MS)
      expect(play.gainDb).toBe(exp.gainDb)
      expect(play.pan).toBe(exp.pan)
      expect(play.sequenceName).toBe(exp.sequenceName)
      // chop(1) = 全体再生なので slice は付かない。
      expect(play.slice).toBeUndefined()
    })
  })

  it('golden schedule JSON matches committed (Leg 1 GRM・staleness guard)', async () => {
    const recorded = await recordSchedule(FIXTURE, DURATIONS)
    const golden = resolveGolden(FIXTURE, recorded, DURATIONS)
    const { updated, committed } = reconcileGolden(golden)
    if (updated) return // UPDATE_GOLDEN=1 で再生成した場合は突き合わせをスキップ。
    expect(committed, 'golden JSON missing — run with UPDATE_GOLDEN=1 to generate').not.toBeNull()
    expect(golden).toEqual(committed)
  })
})
