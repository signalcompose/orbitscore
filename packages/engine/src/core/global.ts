/**
 * Global class for OrbitScore - Refactored version
 * Represents the global transport and configuration
 */

import { AudioEngine } from '../audio/types'

import { Sequence } from './sequence'
import { Scheduler, GlobalState } from './global/types'
import { TempoManager } from './global/tempo-manager'
import { AudioManager } from './global/audio-manager'
import { EffectsManager } from './global/effects-manager'
import { TransportControl } from './global/transport-control'
import { SequenceRegistry } from './global/sequence-registry'
import { LinkAudioManager } from './global/link-audio-manager'
import { QuantizeManager, QuantizeValue } from './global/quantize-manager'

export class Global {
  // Manager instances for different responsibilities
  private tempoManager: TempoManager
  private audioManager: AudioManager
  private effectsManager: EffectsManager
  private transportControl: TransportControl
  private sequenceRegistry: SequenceRegistry
  private linkAudioManager: LinkAudioManager
  private quantizeManager: QuantizeManager

  // Core dependencies
  private audioEngine: AudioEngine
  private globalScheduler: Scheduler

  /**
   * Creates a new Global instance with all manager components
   * @param audioEngine - The audio engine instance
   */
  constructor(audioEngine: AudioEngine) {
    this.audioEngine = audioEngine
    // Type assertion: AudioEngine implementations must also implement Scheduler
    // This is true for SuperColliderPlayer
    this.globalScheduler = audioEngine as unknown as Scheduler

    // Initialize managers
    this.tempoManager = new TempoManager()
    this.audioManager = new AudioManager(audioEngine)
    this.linkAudioManager = new LinkAudioManager()
    this.quantizeManager = new QuantizeManager()
    this.sequenceRegistry = new SequenceRegistry(audioEngine, this)
    this.effectsManager = new EffectsManager(
      this.globalScheduler,
      this.sequenceRegistry.getAllSequences(),
    )
    this.transportControl = new TransportControl(
      this.globalScheduler,
      this.sequenceRegistry.getAllSequences(),
    )
  }

  // Tempo and meter management
  tempo(value?: number): number | this {
    const result = this.tempoManager.tempo(value)
    if (typeof result === 'number') {
      return result
    }

    // Notify all sequences that inherit global tempo
    const sequences = this.sequenceRegistry.getAllSequences()
    for (const [, seq] of sequences) {
      seq.notifyGlobalTempoChange()
    }

    return this
  }

  beat(numerator: number, denominator: number): this {
    this.tempoManager.beat(numerator, denominator)

    // Notify all sequences that inherit global beat
    const sequences = this.sequenceRegistry.getAllSequences()
    for (const [, seq] of sequences) {
      seq.notifyGlobalBeatChange()
    }

    return this
  }

  // Note: tick() and key() have been removed
  // - tick(): MIDI resolution, not needed for audio-only implementation
  // - key(): Will be added when MIDI support is implemented
  //   For audio, key detection feature needs to be implemented first

  // Audio path and device management
  audioPath(value?: string): string | this {
    const result = this.audioManager.audioPath(value)
    if (typeof result === 'string') {
      return result
    }
    return this
  }

  audioDevice(deviceName: string): this {
    this.audioManager.audioDevice(deviceName)
    return this
  }

  /**
   * Enable LinkAudio output mode. Once declared, all sequences route through
   * Ableton Link Audio instead of the hardware bus. Hardware output and
   * LinkAudio cannot coexist within the same .orbs file.
   *
   * @param targetSampleRate Optional explicit target SR for plugin-side
   *                         resampling. Auto-detect with 48000 fallback when
   *                         omitted.
   */
  linkAudio(targetSampleRate?: number): this {
    this.linkAudioManager.linkAudio(targetSampleRate)
    return this
  }

  isLinkAudioEnabled(): boolean {
    return this.linkAudioManager.isEnabled()
  }

  /**
   * Set the global launch-quantize value.
   *
   * Controls when LOOP() starts and when LOOP-time play() updates take
   * effect, by waiting until the next quantized boundary derived from the
   * global tempo and meter. RUN() (one-shot) is unaffected and stays
   * immediate. Sequences may override this with `seq.quantize("...")`.
   *
   * Accepted values: "off" | "beat" | "bar" | "2bar" | "4bar" | "8bar".
   * Default: "bar".
   */
  quantize(value: QuantizeValue): this {
    this.quantizeManager.setQuantize(value)
    return this
  }

  getQuantize(): QuantizeValue {
    return this.quantizeManager.getQuantize()
  }

  /**
   * Set the directory of the currently evaluated .orbs file
   * Used for relative path resolution in audioPath()
   * @internal - Called by the engine when evaluating a document
   */
  setDocumentDirectory(dirPath: string): void {
    this.audioManager.setDocumentDirectory(dirPath)
  }

  // Master effects management
  gain(valueDb?: number): number | this {
    const result = this.effectsManager.gain(valueDb)
    if (typeof result === 'number') {
      return result
    }
    return this
  }

  getMasterGainDb(): number {
    return this.effectsManager.getMasterGainDb()
  }

  compressor(
    threshold = 0.5,
    ratio = 0.5,
    attack = 0.01,
    release = 0.1,
    makeupGain = 1.0,
    enabled = true,
  ): this {
    this.effectsManager.compressor(threshold, ratio, attack, release, makeupGain, enabled)
    return this
  }

  limiter(level = 0.99, duration = 0.01, enabled = true): this {
    this.effectsManager.limiter(level, duration, enabled)
    return this
  }

  normalizer(level = 1.0, duration = 0.01, enabled = true): this {
    this.effectsManager.normalizer(level, duration, enabled)
    return this
  }

  // Transport control
  start(): this {
    this.transportControl.start()
    this.effectsManager.setRunningState(true)
    return this
  }

  /**
   * @deprecated Not needed. Use LOOP(seq) for sequences instead.
   */
  loop(): this {
    this.transportControl.loop()
    this.effectsManager.setRunningState(true)
    return this
  }

  stop(): this {
    this.transportControl.stop()
    this.effectsManager.setRunningState(false)
    return this
  }

  // Sequence management
  get seq(): Sequence {
    return this.sequenceRegistry.seq
  }

  registerSequence(name: string, sequence: Sequence): void {
    this.sequenceRegistry.registerSequence(name, sequence)
  }

  getSequence(name: string): Sequence | undefined {
    return this.sequenceRegistry.getSequence(name)
  }

  // Get the global scheduler (used by sequences for scheduling)
  getScheduler(): Scheduler {
    return this.globalScheduler
  }

  // Get internal state for compatibility
  getState(): GlobalState {
    return {
      ...this.tempoManager.getState(),
      ...this.audioManager.getState(),
      ...this.effectsManager.getState(),
      ...this.transportControl.getState(),
      ...this.linkAudioManager.getState(),
    }
  }
}

// Export a singleton factory
export function createGlobal(audioEngine: AudioEngine): Global {
  return new Global(audioEngine)
}
