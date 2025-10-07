/**
 * SuperCollider audio player with low-latency scheduling
 * リファクタリング後の薄いラッパー（後方互換性を維持）
 */

import { AudioDevice, BootOptions, EffectParams } from './supercollider/types'
import { OSCClient } from './supercollider/osc-client'
import { BufferManager } from './supercollider/buffer-manager'
import { EventScheduler } from './supercollider/event-scheduler'
import { SynthDefLoader } from './supercollider/synthdef-loader'

/**
 * SuperCollider audio player with low-latency scheduling
 */
export class SuperColliderPlayer {
  private oscClient: OSCClient
  private bufferManager: BufferManager
  private eventScheduler: EventScheduler
  private synthDefLoader: SynthDefLoader

  constructor() {
    this.oscClient = new OSCClient()
    this.bufferManager = new BufferManager(this.oscClient)
    this.eventScheduler = new EventScheduler(this.bufferManager, this.oscClient)
    this.synthDefLoader = new SynthDefLoader(this.oscClient)
  }

  /**
   * Boot SuperCollider server and load SynthDef
   */
  async boot(outputDevice?: string, options?: BootOptions): Promise<void> {
    await this.oscClient.boot(outputDevice, options)
    await this.synthDefLoader.loadMainSynthDef()
    await this.synthDefLoader.loadMasteringEffectSynthDefs()
  }

  /**
   * Get list of available audio devices
   */
  getAvailableDevices(): AudioDevice[] {
    return this.oscClient.getAvailableDevices()
  }

  /**
   * Get current output device name
   */
  getCurrentOutputDevice(): string | null {
    return this.oscClient.getCurrentOutputDevice()
  }

  /**
   * Set available devices (called during boot process)
   */
  setAvailableDevices(devices: AudioDevice[]): void {
    this.oscClient.setAvailableDevices(devices)
  }

  /**
   * Load audio file into buffer
   */
  async loadBuffer(filepath: string) {
    return this.bufferManager.loadBuffer(filepath)
  }

  /**
   * Get audio duration from cache
   */
  getAudioDuration(filepath: string): number {
    return this.bufferManager.getAudioDuration(filepath)
  }

  /**
   * Schedule a play event
   */
  scheduleEvent(
    filepath: string,
    startTimeMs: number,
    gainDb = 0,
    pan = 0,
    sequenceName = '',
  ): void {
    this.eventScheduler.scheduleEvent(filepath, startTimeMs, gainDb, pan, sequenceName)
  }

  /**
   * Schedule a slice event (for chop)
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
    this.eventScheduler.scheduleSliceEvent(
      filepath,
      startTimeMs,
      sliceIndex,
      totalSlices,
      eventDurationMs,
      gainDb,
      pan,
      sequenceName,
    )
  }

  /**
   * Start scheduler
   */
  start(): void {
    this.eventScheduler.start()
  }

  /**
   * Stop scheduler
   */
  stop(): void {
    this.eventScheduler.stop()
  }

  /**
   * Stop all and clear events
   */
  stopAll(): void {
    this.eventScheduler.stopAll()
  }

  /**
   * Clear events for a specific sequence
   */
  clearSequenceEvents(sequenceName: string): void {
    this.eventScheduler.clearSequenceEvents(sequenceName)
  }

  /**
   * Add mastering effect to master output
   */
  async addEffect(target: string, effectType: string, params: EffectParams): Promise<void> {
    return this.synthDefLoader.addEffect(target, effectType, params)
  }

  /**
   * Remove effect from master output
   */
  async removeEffect(target: string, effectType: string): Promise<void> {
    return this.synthDefLoader.removeEffect(target, effectType)
  }

  /**
   * Quit SuperCollider server
   */
  async quit(): Promise<void> {
    this.eventScheduler.stopAll()
    await this.oscClient.quit()
  }

  // デバッグ用のプロパティアクセス（後方互換性）
  get isRunning(): boolean {
    return this.eventScheduler.isRunning
  }

  get startTime(): number {
    return this.eventScheduler.startTime
  }

  /**
   * テスト用: 再生を実行（内部メソッドを公開）
   */
  async testExecutePlayback(
    filepath: string,
    options: any,
    sequenceName: string,
    scheduledTime: number,
  ): Promise<void> {
    return this.eventScheduler.testExecutePlayback(filepath, options, sequenceName, scheduledTime)
  }
}
