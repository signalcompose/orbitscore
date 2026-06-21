/**
 * #311 phase 2 tier(c) — Leg 2（interpreter がスケジュールを正しく計算するか）。
 *
 * fixture `per_event_gain.orbs` を RecordingScheduler 注入の InterpreterV2 で実行し、
 * 生の構造スケジュールを **.orbs と DSL 仕様から人手で導いた音楽単位オラクル** と突き合わせる。
 * あわせて Leg 1 用の golden schedule JSON を本番共有の `toDaemonParams` で生成し、
 * committed と一致するか検証する。
 *
 * オラクルの手計算（.orbs を読んで）:
 *   tempo 60 / beat 4/4 / length 1 → bar = 4 beats × (60/60)s = 4.0s、play() 4 要素 →
 *   subdivision = 1.0s。
 *   loud  sequence: play(1,0,0,0) → step0 = 0ms、gainDb -3、pan 0（中央）
 *   quiet sequence: play(0,0,0,1) → step3 = 3000ms、gainDb -9、pan 0（中央）
 *   記録 time = musical onset + RUN_SCHEDULE_BUFFER_MS(100)。
 *   kick.wav = 0.5s → loud 終端 0.5s, quiet 開始 3.0s → 2.5s 以上の無音あり。
 *   slice 無し: scheduleEvent が呼ばれる（play.slice は undefined）。
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

import {
  recordSchedule,
  resolveGolden,
  reconcileGolden,
  RUN_SCHEDULE_BUFFER_MS,
} from './schedule-golden'

const FIXTURE = 'per_event_gain'
/** kick.wav = 0.5s mono 48k。 */
const DURATIONS = { '../audio/kick.wav': 0.5 }

/** .orbs + DSL 仕様から手書きした期待スケジュール（interpreter で計算しない）。 */
const ORACLE = [
  { onsetMs: 0, gainDb: -3, pan: 0, sequenceName: 'loud' },
  { onsetMs: 3000, gainDb: -9, pan: 0, sequenceName: 'quiet' },
]

describe('#311 Leg 2 — per_event_gain: interpreter schedule vs hand oracle', () => {
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
      // slice 無し: scheduleEvent が呼ばれる。
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
