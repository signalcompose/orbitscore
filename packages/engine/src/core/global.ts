/**
 * Global class for OrbitScore
 * Represents the global transport and configuration
 */

import { AudioEngine } from '../audio/audio-engine'

import { Sequence } from './sequence'

export interface Meter {
  numerator: number
  denominator: number
}

// Common scheduler interface
export interface Scheduler {
  isRunning: boolean
  start(): void
  stop(): void
  stopAll(): void
  clearSequenceEvents(name: string): void
  scheduleEvent(filepath: string, time: number, gainDb: number, pan: number, sequenceName: string): void
  scheduleSliceEvent(filepath: string, time: number, sliceIndex: number, totalSlices: number, gainDb: number, pan: number, sequenceName: string): void
  getAudioDuration(filepath: string): number
  loadBuffer?(filepath: string): Promise<any>
}

export class Global {
  private _tempo: number = 120
  private _tick: number = 480
  private _beat: Meter = { numerator: 4, denominator: 4 }
  private _key: string = 'C'
  private _audioPath: string = '' // Base path for audio files
  private _masterGainDb: number = 0 // Master volume in dB, default 0 dB (100%)
  private _masterEffects: Array<{type: string, params: any}> = [] // Master effect chain
  private _isRunning: boolean = false
  private _isLooping: boolean = false

  private sequences: Map<string, Sequence> = new Map()
  private audioEngine: any // Can be AudioEngine or SuperColliderPlayer
  private globalScheduler: Scheduler

  constructor(audioEngine: any) {
    this.audioEngine = audioEngine
    this.globalScheduler = audioEngine as Scheduler
  }

  // Property accessors with method chaining
  tempo(value?: number): number | this {
    if (value === undefined) {
      return this._tempo
    }
    this._tempo = value
    return this
  }

  tick(value?: number): number | this {
    if (value === undefined) {
      return this._tick
    }
    this._tick = value
    return this
  }

  beat(numerator: number, denominator: number): this {
    this._beat = { numerator, denominator }
    return this
  }

  key(value?: string): string | this {
    if (value === undefined) {
      return this._key
    }
    this._key = value
    return this
  }

  audioPath(value?: string): string | this {
    if (value === undefined) {
      return this._audioPath
    }
    this._audioPath = value
    // audioPath: ${value}
    return this
  }

  /**
   * Set audio output device
   * @param deviceName - Name of the output device to use
   */
  audioDevice(deviceName: string): this {
    // Check if audioEngine has device selection support (SuperColliderPlayer)
    if (typeof (this.audioEngine as any).getCurrentOutputDevice === 'function') {
      const currentDevice = (this.audioEngine as any).getCurrentOutputDevice()
      if (currentDevice === deviceName) {
        console.log(`🔊 Already using device: ${deviceName}`)
        return this
      }
      
      console.warn(`⚠️  Audio device can only be set before engine starts`)
      console.warn(`⚠️  Current device: ${currentDevice || 'default'}`)
      console.warn(`⚠️  Requested device: ${deviceName}`)
      console.warn(`⚠️  Restart the engine to change audio device`)
    } else {
      console.warn('⚠️  Audio device selection not available')
    }
    return this
  }

  gain(valueDb?: number): number | this {
    if (valueDb === undefined) {
      return this._masterGainDb
    }
    
    // Clamp to -60 dB to +12 dB
    // -Infinity is allowed for complete silence
    if (valueDb === -Infinity) {
      this._masterGainDb = -Infinity
    } else {
      this._masterGainDb = Math.max(-60, Math.min(12, valueDb))
    }
    
    // If global is running, reschedule all playing sequences with new master gain
    if (this._isRunning) {
      for (const [name, sequence] of this.sequences.entries()) {
        const state = sequence.getState() as any
        if (state.isPlaying || state.isLooping) {
          // Trigger reschedule by calling the sequence's gain with its current value
          // This will cause the sequence to recalculate with the new master gain
          const currentGainDb = state.gainDb ?? 0
          ;(sequence as any).gain(currentGainDb)
        }
      }
      console.log(`🎚️ Global: master gain=${valueDb} dB`)
    }
    
    return this
  }

  // Get master gain in dB (used by sequences to calculate final gain)
  getMasterGainDb(): number {
    return this._masterGainDb
  }

  /**
   * Add compressor effect to master output (mastering)
   * @param threshold - Compression threshold 0-1 (default: 0.5)
   * @param ratio - Compression ratio 0-1 (default: 0.5, 0=1:1, 1=inf:1)
   * @param attack - Attack time in seconds (default: 0.01)
   * @param release - Release time in seconds (default: 0.1)
   * @param makeupGain - Makeup gain 0-2 (default: 1.0)
   * @param enabled - Enable/disable effect (default: true)
   */
  compressor(threshold = 0.5, ratio = 0.5, attack = 0.01, release = 0.1, makeupGain = 1.0, enabled = true): this {
    if (!enabled) {
      const existingIndex = this._masterEffects.findIndex(e => e.type === 'compressor')
      if (existingIndex >= 0) {
        this._masterEffects.splice(existingIndex, 1)
      }
      
      if ((this.globalScheduler as any).removeEffect) {
        (this.globalScheduler as any).removeEffect('master', 'compressor')
      }
      
      const seamless = this._isRunning ? ' (seamless)' : ''
      console.log(`🎛️ Global: compressor off${seamless}`)
      return this
    }
    
    // Validate parameters
    const validThreshold = Math.max(0, Math.min(1.0, threshold))
    const validRatio = Math.max(0, Math.min(1.0, ratio))
    const validAttack = Math.max(0.001, Math.min(1.0, attack))
    const validRelease = Math.max(0.01, Math.min(5.0, release))
    const validMakeupGain = Math.max(0, Math.min(2.0, makeupGain))
    
    // Update or add to master effect chain
    const existingIndex = this._masterEffects.findIndex(e => e.type === 'compressor')
    if (existingIndex >= 0) {
      this._masterEffects[existingIndex] = {
        type: 'compressor',
        params: { threshold: validThreshold, ratio: validRatio, attack: validAttack, release: validRelease, makeupGain: validMakeupGain }
      }
    } else {
      this._masterEffects.push({
        type: 'compressor',
        params: { threshold: validThreshold, ratio: validRatio, attack: validAttack, release: validRelease, makeupGain: validMakeupGain }
      })
    }
    
    // Send OSC message to SuperCollider
    if ((this.globalScheduler as any).addEffect) {
      (this.globalScheduler as any).addEffect('master', 'compressor', { 
        threshold: validThreshold, 
        ratio: validRatio, 
        attack: validAttack, 
        release: validRelease, 
        makeupGain: validMakeupGain 
      })
    }
    
    const seamless = this._isRunning ? ' (seamless)' : ''
    console.log(`🎛️ Global: compressor(threshold=${validThreshold}, ratio=${validRatio}, attack=${validAttack}s, release=${validRelease}s, gain=${validMakeupGain})${seamless}`)
    return this
  }

  /**
   * Add limiter effect to master output (mastering)
   * @param level - Limiter level 0-1 (default: 0.99)
   * @param duration - Lookahead time in seconds (default: 0.01)
   * @param enabled - Enable/disable effect (default: true)
   */
  limiter(level = 0.99, duration = 0.01, enabled = true): this {
    if (!enabled) {
      const existingIndex = this._masterEffects.findIndex(e => e.type === 'limiter')
      if (existingIndex >= 0) {
        this._masterEffects.splice(existingIndex, 1)
      }
      
      if ((this.globalScheduler as any).removeEffect) {
        (this.globalScheduler as any).removeEffect('master', 'limiter')
      }
      
      const seamless = this._isRunning ? ' (seamless)' : ''
      console.log(`🎛️ Global: limiter off${seamless}`)
      return this
    }
    
    // Validate parameters
    const validLevel = Math.max(0.1, Math.min(1.0, level))
    const validDuration = Math.max(0.001, Math.min(0.1, duration))
    
    // Update or add to master effect chain
    const existingIndex = this._masterEffects.findIndex(e => e.type === 'limiter')
    if (existingIndex >= 0) {
      this._masterEffects[existingIndex] = {
        type: 'limiter',
        params: { level: validLevel, duration: validDuration }
      }
    } else {
      this._masterEffects.push({
        type: 'limiter',
        params: { level: validLevel, duration: validDuration }
      })
    }
    
    // Send OSC message to SuperCollider
    if ((this.globalScheduler as any).addEffect) {
      (this.globalScheduler as any).addEffect('master', 'limiter', { level: validLevel, duration: validDuration })
    }
    
    const seamless = this._isRunning ? ' (seamless)' : ''
    console.log(`🎛️ Global: limiter(level=${validLevel}, duration=${validDuration}s)${seamless}`)
    return this
  }

  /**
   * Add normalizer effect to master output (mastering)
   * @param level - Normalization level 0-1 (default: 1.0)
   * @param duration - Lookahead time in seconds (default: 0.01)
   * @param enabled - Enable/disable effect (default: true)
   */
  normalizer(level = 1.0, duration = 0.01, enabled = true): this {
    if (!enabled) {
      const existingIndex = this._masterEffects.findIndex(e => e.type === 'normalizer')
      if (existingIndex >= 0) {
        this._masterEffects.splice(existingIndex, 1)
      }
      
      if ((this.globalScheduler as any).removeEffect) {
        (this.globalScheduler as any).removeEffect('master', 'normalizer')
      }
      
      const seamless = this._isRunning ? ' (seamless)' : ''
      console.log(`🎛️ Global: normalizer off${seamless}`)
      return this
    }
    
    // Validate parameters
    const validLevel = Math.max(0.1, Math.min(1.0, level))
    const validDuration = Math.max(0.001, Math.min(0.1, duration))
    
    // Update or add to master effect chain
    const existingIndex = this._masterEffects.findIndex(e => e.type === 'normalizer')
    if (existingIndex >= 0) {
      this._masterEffects[existingIndex] = {
        type: 'normalizer',
        params: { level: validLevel, duration: validDuration }
      }
    } else {
      this._masterEffects.push({
        type: 'normalizer',
        params: { level: validLevel, duration: validDuration }
      })
    }
    
    // Send OSC message to SuperCollider
    if ((this.globalScheduler as any).addEffect) {
      (this.globalScheduler as any).addEffect('master', 'normalizer', { level: validLevel, duration: validDuration })
    }
    
    const seamless = this._isRunning ? ' (seamless)' : ''
    console.log(`🎛️ Global: normalizer(level=${validLevel}, duration=${validDuration}s)${seamless}`)
    return this
  }

  // Transport control methods
  run(): this {
    // If already running, do nothing (idempotent)
    if (this._isRunning) {
      return this
    }
    
    this._isRunning = true

    // Start the global scheduler (will restart if needed)
    this.globalScheduler.start()
    console.log('✅ Global running')
    
    return this
  }

  loop(): this {
    if (!this._isLooping) {
      this._isLooping = true
      this._isRunning = true
      // Global: loop
    }
    return this
  }

  stop(): this {
    // Stop all sequences first
    for (const [name, sequence] of this.sequences.entries()) {
      sequence.stop()
    }
    
    // Stop the scheduler
    this.globalScheduler.stopAll()
    
    // Stop transport
    if (this._isRunning) {
      this._isRunning = false
      this._isLooping = false
      console.log('✅ Global stopped')
    }
    return this
  }

  // Sequence creation - DSL: var seq = init global.seq
  get seq(): Sequence {
    const sequence = new Sequence(this, this.audioEngine)
    return sequence
  }
  
  // Get the global scheduler (used by sequences for scheduling)
  getScheduler(): Scheduler {
    return this.globalScheduler
  }

  // Register a sequence (called by Sequence constructor)
  registerSequence(name: string, sequence: Sequence): void {
    this.sequences.set(name, sequence)
  }

  // Get sequence by name
  getSequence(name: string): Sequence | undefined {
    return this.sequences.get(name)
  }

  // Get internal state for compatibility
  getState() {
    return {
      tempo: this._tempo,
      tick: this._tick,
      beat: this._beat,
      key: this._key,
      audioPath: this._audioPath,
      masterGainDb: this._masterGainDb,
      masterEffects: this._masterEffects,
      isRunning: this._isRunning,
      isLooping: this._isLooping,
    }
  }

}

// Export a singleton factory
export function createGlobal(audioEngine: AudioEngine): Global {
  return new Global(audioEngine)
}
