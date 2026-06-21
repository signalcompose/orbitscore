/**
 * #311 phase 2 tier(c) — Leg 2（interpreter がスケジュールを正しく計算するか）。
 *
 * fixture `chop_region.orbs` を RecordingScheduler 注入の InterpreterV2 で実行し、
 * 生の構造スケジュールを **.orbs と DSL 仕様から人手で導いた音楽単位オラクル** と突き合わせる。
 * あわせて Leg 1 用の golden schedule JSON を本番共有の `toDaemonParams` で生成し、
 * committed と一致するか検証する。
 *
 * オラクルの手計算（.orbs を読んで）:
 *   tempo 120 / beat 4/4 / length 1 → bar = 4 beats × (60/120)s = 2.0s、play() 4 要素 →
 *   subdivision = 0.5s。
 *   arpeggio_c.wav = 1.0s / chop(2) → sliceDur = 1.0 / 2 = 0.5s = slot → rate=1.0。
 *   play(1, 0, 2, 0):
 *     step0 = 0ms   → slice index=1 / gainDb -3 / pan 0（中央）
 *     step1 = 500ms → 0（rest・記録なし）
 *     step2 = 1000ms → slice index=2 / gainDb -3 / pan 0
 *     step3 = 1500ms → 0（rest・記録なし）
 *   記録 time = musical onset + RUN_SCHEDULE_BUFFER_MS(100)。
 *   golden offsetSec: slice1=(1-1)*0.5=0.0s、slice2=(2-1)*0.5=0.5s。durationSec=0.5s 各。
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

import {
  recordSchedule,
  resolveGolden,
  reconcileGolden,
  RUN_SCHEDULE_BUFFER_MS,
} from './schedule-golden'

const FIXTURE = 'chop_region'
/** arpeggio_c.wav = 1.0s mono 48k。slice scheduling が getAudioDuration を要求する。 */
const DURATIONS = { '../audio/arpeggio_c.wav': 1.0 }

/** .orbs + DSL 仕様から手書きした期待スケジュール（interpreter で計算しない）。 */
const ORACLE = [
  { onsetMs: 0, gainDb: -3, pan: 0, sliceIndex: 1, sliceTotal: 2 },
  { onsetMs: 1000, gainDb: -3, pan: 0, sliceIndex: 2, sliceTotal: 2 },
]

describe('#311 Leg 2 — chop_region: interpreter schedule vs hand oracle', () => {
  afterEach(() => vi.useRealTimers())

  it('records the structurally-correct schedule (onset / gainDb / pan / slice index+total)', async () => {
    const recorded = await recordSchedule(FIXTURE, DURATIONS)

    expect(recorded).toHaveLength(ORACLE.length)
    recorded.forEach((play, i) => {
      const exp = ORACLE[i]
      // onset: 記録 time === 音楽 onset + RUN buffer（fake timers で厳密）。
      expect(play.time).toBe(exp.onsetMs + RUN_SCHEDULE_BUFFER_MS)
      expect(play.gainDb).toBe(exp.gainDb)
      expect(play.pan).toBe(exp.pan)
      // slice が付いていること（chop(2) → scheduleSliceEvent）。
      expect(play.slice).toBeDefined()
      expect(play.slice!.index).toBe(exp.sliceIndex)
      expect(play.slice!.total).toBe(exp.sliceTotal)
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
