/**
 * 検証ハーネス（#311 phase 2・tier(c) Leg 2）用の音声バックエンド。
 *
 * SuperCollider / daemon を一切立てずに、interpreter が `.orbs` から計算した発音
 * スケジュール（`scheduleEvent` / `scheduleSliceEvent` の引数）を**そのまま記録**する。
 * `boot()` は no-op なので `InterpreterV2.execute()` が device 無しで完走し、`execute()`
 * 後に `getRecorded()` で生の構造スケジュール（onset / gainDb / pan / slice）を得られる。
 *
 * これが Leg 2 の DUT（= interpreter の計算）であり、手書きの音楽単位オラクルと突き合わせる。
 * **発火（start/poll）はしない** — 記録だけが目的。
 */

import type { AudioEngineBackend } from '../../../packages/engine/src/audio/engine-backend'
import type { ScheduledPlay } from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'

export class RecordingScheduler implements AudioEngineBackend {
  isRunning = false
  startTime = 0

  private readonly recorded: ScheduledPlay[] = []
  /** filepath → 尺（秒）。slice scheduling が `getAudioDuration` を要求する場合に返す。 */
  private readonly durations = new Map<string, number>()

  constructor(durations?: Record<string, number>) {
    if (durations) {
      for (const [filepath, seconds] of Object.entries(durations)) {
        this.durations.set(filepath, seconds)
      }
    }
  }

  /** 記録した発音スケジュール（time 昇順のコピー）。 */
  getRecorded(): ScheduledPlay[] {
    return [...this.recorded].sort((a, b) => a.time - b.time)
  }

  // --- Scheduler 面（記録のみ・RustEnginePlayer.scheduleEvent と同じ引数） ---

  scheduleEvent(
    filepath: string,
    time: number,
    gainDb: number,
    pan: number,
    sequenceName: string,
    _outputChannel?: string,
  ): void {
    this.recorded.push({ time, filepath, gainDb, pan, sequenceName })
  }

  scheduleSliceEvent(
    filepath: string,
    time: number,
    sliceIndex: number,
    totalSlices: number,
    eventDurationMs: number | undefined,
    gainDb: number,
    pan: number,
    sequenceName: string,
    _outputChannel?: string,
  ): void {
    this.recorded.push({
      time,
      filepath,
      gainDb,
      pan,
      sequenceName,
      slice: { index: sliceIndex, total: totalSlices, eventDurationMs },
    })
  }

  getAudioDuration(filepath: string): number {
    return this.durations.get(filepath) ?? 0
  }

  // --- 発火しないので no-op（記録のみ） ---
  // ただし start() は isRunning を立てる: preparePlayback が `scheduler.isRunning` を
  // 要求し、false だと run() が早期 return して何も記録されないため。startTime も設定する
  // （runSequence の baseTime = (Date.now() - startTime) + 100 に効く。テストは fake timers
  // で Date.now() を凍結し baseTime を決定論化する）。
  start(): void {
    this.isRunning = true
    this.startTime = Date.now()
  }
  stop(): void {
    this.isRunning = false
  }
  stopAll(): void {}
  clearSequenceEvents(_name: string): void {}
  reinitializeSequenceTracking(_name: string): void {}
  async loadBuffer(_filepath: string): Promise<{ sampleId: string }> {
    return { sampleId: 'recording' }
  }

  // --- AudioEngineBackend 面（no-op・device/daemon 不要） ---
  async boot(_outputDevice?: string): Promise<void> {}
  async quit(): Promise<void> {}
}
