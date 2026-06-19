/**
 * SuperCollider audio player with low-latency scheduling
 * リファクタリング後の薄いラッパー（後方互換性を維持）
 */

import { AudioDevice, BootOptions, EffectParams } from './supercollider/types'
import { OSCClient } from './supercollider/osc-client'
import { BufferManager } from './supercollider/buffer-manager'
import { EventScheduler } from './supercollider/event-scheduler'
import { SynthDefLoader } from './supercollider/synthdef-loader'
import { resolveScsynthPath } from './supercollider/scsynth-resolver'

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
   * Boot SuperCollider server and load SynthDef.
   *
   * `BootOptions.scsynth` 未指定時は `resolveScsynthPath()` で
   * explicit / env / bundle の順に解決する (strict mode、Issue #136)。
   * SC.app / Spotlight への暗黙 fallback は持たない — bundle が無ければ
   * `ScsynthNotFoundError` で fail loud。dev 環境で SC.app を使う場合は
   * `ORBIT_SCSYNTH_PATH` env を経由すること。
   */
  async boot(outputDevice?: string, options?: BootOptions): Promise<void> {
    const mergedOptions: BootOptions = { ...options }
    if (!mergedOptions.scsynth) {
      const resolution = resolveScsynthPath()
      mergedOptions.scsynth = resolution.path
      if (process.env.ORBITSCORE_DEBUG) {
        console.log(`🔍 scsynth resolved via ${resolution.source}: ${resolution.path}`)
      }
    }
    await this.oscClient.boot(outputDevice, mergedOptions)
    await this.synthDefLoader.loadMainSynthDef()
    await this.synthDefLoader.loadMasteringEffectSynthDefs()
    // LinkAudio (#209): load the orbitPlayBufLink SynthDef so sample playback can
    // route to Ableton via the OrbitLinkAudio plugin. Best-effort — a missing
    // .scsyndef or load error must not break boot.
    //
    // When the SynthDef is absent (false) LinkAudio cannot work, so eagerly mark
    // the plugin unavailable: this short-circuits the lazy /done probe and avoids
    // a 2000ms timeout on the first outputChannel dispatch in hardware-only
    // builds. When it loads (true) we leave availability as `null` so the lazy
    // probe still confirms actual plugin presence on first dispatch (SynthDef
    // presence ≠ plugin presence).
    try {
      const linkAudioLoaded = await this.synthDefLoader.loadLinkAudioSynthDef()
      if (!linkAudioLoaded) {
        this.eventScheduler.setLinkAudioPluginAvailable(false)
      }
    } catch (e) {
      this.eventScheduler.setLinkAudioPluginAvailable(false)
      console.warn(
        '⚠️  LinkAudio SynthDef load failed — continuing with hardware-only playback:',
        e,
      )
    }
  }

  /**
   * Get list of available audio devices
   */
  getAvailableDevices(): AudioDevice[] {
    return this.oscClient.getAvailableDevices()
  }

  /**
   * Eagerly register a LinkAudio channel with the plugin (AudioEngine surface).
   * Called from Sequence.output() so the channel's source appears in Live before
   * playback. Delegates to the event scheduler; best-effort.
   */
  async registerLinkAudioChannel(channelName: string): Promise<void> {
    await this.eventScheduler.ensureLinkAudioChannelRegistered(channelName)
  }

  /**
   * Push a tempo to the Link session so OrbitScore leads (#283, AudioEngine
   * surface). Called from Global when `global.tempo()` is set / linkAudio() is
   * enabled / start() runs, in LinkAudio mode. Delegates to the event
   * scheduler; best-effort.
   */
  async setLinkTempo(bpm: number): Promise<void> {
    await this.eventScheduler.setLinkTempo(bpm)
  }

  /**
   * Get current output device
   */
  getCurrentOutputDevice(): AudioDevice | undefined {
    const deviceName = this.oscClient.getCurrentOutputDevice()
    if (!deviceName) {
      return undefined
    }

    // Find the device in available devices
    const devices = this.getAvailableDevices()
    return devices.find((device) => device.name === deviceName)
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
    outputChannel?: string,
  ): void {
    this.eventScheduler.scheduleEvent(
      filepath,
      startTimeMs,
      gainDb,
      pan,
      sequenceName,
      outputChannel,
    )
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
    outputChannel?: string,
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
      outputChannel,
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
   * Reinitialize sequence tracking (for unmute)
   */
  reinitializeSequenceTracking(sequenceName: string): void {
    this.eventScheduler.reinitializeSequenceTracking(sequenceName)
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

  // AudioEngine interface implementation
  get isRunning(): boolean {
    return this.eventScheduler.isRunning
  }

  get startTime(): number {
    return this.eventScheduler.startTime
  }

  /**
   * Test-only accessor — forwards to `EventScheduler.testExecutePlayback`
   * so unit tests can drive the dispatch path directly without standing up
   * the scheduling loop. Not part of the public API.
   *
   * @internal
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
