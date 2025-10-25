/**
 * Master effects management for Global class
 */

import { MasterEffect, Scheduler } from './types'

export class EffectsManager {
  private _masterGainDb: number = 0 // Master volume in dB, default 0 dB (100%)
  private _masterEffects: MasterEffect[] = [] // Master effect chain
  private globalScheduler: Scheduler
  private sequences: Map<string, any> // For rescheduling sequences when gain changes
  private _isRunning: boolean = false

  constructor(globalScheduler: Scheduler, sequences: Map<string, any>) {
    this.globalScheduler = globalScheduler
    this.sequences = sequences
  }

  setRunningState(isRunning: boolean): void {
    this._isRunning = isRunning
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
      for (const [, sequence] of this.sequences.entries()) {
        const state = sequence.getState() as any
        if (state.isPlaying || state.isLooping) {
          // Trigger reschedule by calling the sequence's gain with its current value
          // This will cause the sequence to recalculate with the new master gain
          const currentGainDb = state.gainDb ?? 0
          sequence.gain(currentGainDb)
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
   * Helper method to remove an effect from the master effect chain
   * @param effectType - Type of effect to remove
   * @private
   */
  private removeEffect(effectType: string): void {
    const existingIndex = this._masterEffects.findIndex((e) => e.type === effectType)
    if (existingIndex >= 0) {
      this._masterEffects.splice(existingIndex, 1)
    }

    if (this.globalScheduler.removeEffect) {
      this.globalScheduler.removeEffect('master', effectType)
    }

    const seamless = this._isRunning ? ' (seamless)' : ''
    console.log(`🎛️ Global: ${effectType} off${seamless}`)
  }

  /**
   * Helper method to add or update an effect in the master effect chain
   * @param effectType - Type of effect to add/update
   * @param params - Effect parameters
   * @param logMessage - Message to log
   * @private
   */
  private addOrUpdateEffect(effectType: string, params: any, logMessage: string): void {
    const existingIndex = this._masterEffects.findIndex((e) => e.type === effectType)
    if (existingIndex >= 0) {
      this._masterEffects[existingIndex] = { type: effectType, params }
    } else {
      this._masterEffects.push({ type: effectType, params })
    }

    // Send OSC message to SuperCollider
    if (this.globalScheduler.addEffect) {
      this.globalScheduler.addEffect('master', effectType, params)
    }

    const seamless = this._isRunning ? ' (seamless)' : ''
    console.log(`🎛️ Global: ${logMessage}${seamless}`)
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
  compressor(
    threshold = 0.5,
    ratio = 0.5,
    attack = 0.01,
    release = 0.1,
    makeupGain = 1.0,
    enabled = true,
  ): this {
    if (!enabled) {
      this.removeEffect('compressor')
      return this
    }

    // Validate parameters
    const params = {
      threshold: Math.max(0, Math.min(1.0, threshold)),
      ratio: Math.max(0, Math.min(1.0, ratio)),
      attack: Math.max(0.001, Math.min(1.0, attack)),
      release: Math.max(0.01, Math.min(5.0, release)),
      makeupGain: Math.max(0, Math.min(2.0, makeupGain)),
    }

    const logMessage = `compressor(threshold=${params.threshold}, ratio=${params.ratio}, attack=${params.attack}s, release=${params.release}s, gain=${params.makeupGain})`
    this.addOrUpdateEffect('compressor', params, logMessage)
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
      this.removeEffect('limiter')
      return this
    }

    // Validate parameters
    const params = {
      level: Math.max(0.1, Math.min(1.0, level)),
      duration: Math.max(0.001, Math.min(0.1, duration)),
    }

    const logMessage = `limiter(level=${params.level}, duration=${params.duration}s)`
    this.addOrUpdateEffect('limiter', params, logMessage)
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
      this.removeEffect('normalizer')
      return this
    }

    // Validate parameters
    const params = {
      level: Math.max(0.1, Math.min(1.0, level)),
      duration: Math.max(0.001, Math.min(0.1, duration)),
    }

    const logMessage = `normalizer(level=${params.level}, duration=${params.duration}s)`
    this.addOrUpdateEffect('normalizer', params, logMessage)
    return this
  }

  // Get current state
  getState() {
    return {
      masterGainDb: this._masterGainDb,
      masterEffects: this._masterEffects,
    }
  }
}
