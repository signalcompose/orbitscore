/**
 * SuperColliderイベントスケジューラー
 */

import { ScheduledPlay, PlaybackOptions } from './types'
import { BufferManager } from './buffer-manager'
import { OSCClient } from './osc-client'

export class EventScheduler {
  public isRunning = false
  public startTime = 0
  private scheduledPlays: ScheduledPlay[] = []
  private sequenceEvents: Map<string, ScheduledPlay[]> = new Map()
  private intervalId: NodeJS.Timeout | null = null

  constructor(
    private bufferManager: BufferManager,
    private oscClient: OSCClient,
  ) {}

  /**
   * 再生イベントをスケジュール
   */
  scheduleEvent(
    filepath: string,
    startTimeMs: number,
    gainDb = 0,
    pan = 0,
    sequenceName = '',
  ): void {
    const play: ScheduledPlay = {
      time: startTimeMs,
      filepath,
      options: { gainDb, pan },
      sequenceName,
    }

    this.scheduledPlays.push(play)
    this.scheduledPlays.sort((a, b) => a.time - b.time)

    // Track sequence events
    if (sequenceName) {
      if (!this.sequenceEvents.has(sequenceName)) {
        this.sequenceEvents.set(sequenceName, [])
      }
      this.sequenceEvents.get(sequenceName)!.push(play)
    }
  }

  /**
   * スライスイベントをスケジュール（chop用）
   */
  scheduleSliceEvent(
    filepath: string,
    startTimeMs: number,
    sliceIndex: number,
    totalSlices: number,
    eventDurationMs: number | undefined,
    gainDb = 0,
    pan = 0,
    sequenceName = '',
  ): void {
    const duration = this.bufferManager.getAudioDuration(filepath)
    const sliceDuration = duration / totalSlices
    // sliceIndex is 1-based from DSL, convert to 0-based
    const startPos = (sliceIndex - 1) * sliceDuration

    // Calculate playback rate to fit slice into event duration
    // rate = actual slice duration / desired event duration
    // If eventDurationMs is undefined or 0, use natural rate (1.0)
    // If slice is shorter than event, we need to slow down (rate < 1.0) to stretch it
    // If slice is longer than event, we need to speed up (rate > 1.0) to compress it
    let rate = 1.0
    if (eventDurationMs && eventDurationMs > 0) {
      rate = (sliceDuration * 1000) / eventDurationMs
    }

    const play: ScheduledPlay = {
      time: startTimeMs,
      filepath,
      options: {
        gainDb,
        pan,
        startPos,
        duration: sliceDuration,
        rate,
      },
      sequenceName,
    }

    this.scheduledPlays.push(play)
    this.scheduledPlays.sort((a, b) => a.time - b.time)

    // Track sequence events
    if (sequenceName) {
      if (!this.sequenceEvents.has(sequenceName)) {
        this.sequenceEvents.set(sequenceName, [])
      }
      this.sequenceEvents.get(sequenceName)!.push(play)
    }
  }

  /**
   * スケジューラーを開始
   */
  start(): void {
    if (this.isRunning) {
      return
    }

    this.isRunning = true
    this.startTime = Date.now()

    console.log('✅ Global running')

    this.scheduledPlays.sort((a, b) => a.time - b.time)

    this.intervalId = setInterval(() => {
      const now = Date.now() - this.startTime

      while (this.scheduledPlays.length > 0 && this.scheduledPlays[0].time <= now) {
        const play = this.scheduledPlays.shift()!
        this.executePlayback(play.filepath, play.options, play.sequenceName, play.time)
      }
    }, 1)
  }

  /**
   * スケジューラーを停止
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.isRunning = false
    console.log('✅ Global stopped')
  }

  /**
   * すべてを停止してイベントをクリア
   */
  stopAll(): void {
    this.stop()
    this.scheduledPlays = []
    this.sequenceEvents.clear()
  }

  /**
   * 特定のシーケンスのイベントをクリア
   */
  clearSequenceEvents(sequenceName: string): void {
    const beforeCount = this.scheduledPlays.length
    this.scheduledPlays = this.scheduledPlays.filter((play) => play.sequenceName !== sequenceName)
    const afterCount = this.scheduledPlays.length
    const cleared = beforeCount - afterCount
    if (cleared > 0) {
      console.log(`🗑️  Cleared ${cleared} events for ${sequenceName} (${afterCount} remaining)`)
    }
    this.sequenceEvents.delete(sequenceName)
  }

  /**
   * 再生を実行
   */
  private async executePlayback(
    filepath: string,
    options: PlaybackOptions,
    sequenceName: string,
    scheduledTime: number,
  ): Promise<void> {
    const launchTime = Date.now()
    const actualStartTime = launchTime - this.startTime
    const drift = actualStartTime - scheduledTime

    if ((globalThis as any).ORBITSCORE_DEBUG) {
      console.log(
        `🔊 Playing: ${sequenceName} at ${actualStartTime}ms (scheduled: ${scheduledTime}ms, drift: ${drift}ms)`,
      )
    }

    const { bufnum } = await this.bufferManager.loadBuffer(filepath)

    // Convert dB to amplitude: amplitude = 10^(dB/20)
    // Default: 0 dB = 1.0 (100%)
    let amplitude: number
    if (options.gainDb === undefined) {
      amplitude = 1.0 // 0 dB default
    } else if (options.gainDb === -Infinity) {
      amplitude = 0.0 // Complete silence
    } else {
      amplitude = Math.pow(10, options.gainDb / 20)
    }

    const pan = options.pan !== undefined ? options.pan / 100 : 0.0 // -100..100 -> -1.0..1.0
    const startPos = options.startPos ?? 0
    const duration = options.duration ?? 0
    const rate = options.rate ?? 1.0

    await this.oscClient.sendMessage([
      '/s_new',
      'orbitPlayBuf',
      -1,
      0,
      0,
      'bufnum',
      bufnum,
      'amp',
      amplitude,
      'pan',
      pan,
      'rate',
      rate,
      'startPos',
      startPos,
      'duration',
      duration,
    ])
  }

  /**
   * スケジュールされたイベント数を取得
   */
  getScheduledEventCount(): number {
    return this.scheduledPlays.length
  }

  /**
   * テスト用: 再生を実行（内部メソッドを公開）
   */
  async testExecutePlayback(
    filepath: string,
    options: PlaybackOptions,
    sequenceName: string,
    scheduledTime: number,
  ): Promise<void> {
    return this.executePlayback(filepath, options, sequenceName, scheduledTime)
  }
}
