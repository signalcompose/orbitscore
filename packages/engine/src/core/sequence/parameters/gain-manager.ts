/**
 * Gain parameter manager for Sequence
 * Handles gain value setting, random generation, and seamless updates
 */

import { RandomValue } from '../../../parser/audio-parser'
import { GainOptions } from '../types'

/**
 * Generate a random value based on the random spec
 */
function generateRandomValue(spec: RandomValue, min: number, max: number): number {
  if (spec.type === 'full-random') {
    // Full random within min-max range
    return Math.random() * (max - min) + min
  } else {
    // Random walk: center ± range
    const value = spec.center + (Math.random() * 2 - 1) * spec.range
    // Clamp to valid range
    return Math.max(min, Math.min(max, value))
  }
}

/**
 * Gain parameter manager
 */
export class GainManager {
  private _gainDb: number = 0 // Gain in dB, default 0 dB (100%)
  private _gainRandom?: RandomValue // Random spec for gain

  /**
   * Set gain value
   */
  setGain(options: GainOptions): { gainDb: number; gainRandom?: RandomValue } {
    const { valueDb } = options

    // Check if it's a random value spec
    if (typeof valueDb === 'object' && 'type' in valueDb) {
      this._gainRandom = valueDb
      // Set a default value for display (center if random-walk, 0 if full-random)
      if (valueDb.type === 'random-walk') {
        this._gainDb = Math.max(-60, Math.min(12, valueDb.center))
      } else {
        this._gainDb = 0 // Default to 0 dB for full-random
      }
    } else {
      // Fixed value
      this._gainRandom = undefined
      // Clamp to -60 dB (effectively silent) to +12 dB (prevent clipping)
      // -Infinity is allowed for complete silence
      if (valueDb === -Infinity) {
        this._gainDb = -Infinity
      } else {
        this._gainDb = Math.max(-60, Math.min(12, valueDb))
      }
    }

    return {
      gainDb: this._gainDb,
      gainRandom: this._gainRandom,
    }
  }

  /**
   * Get current gain value
   */
  getGain(): { gainDb: number; gainRandom?: RandomValue } {
    return {
      gainDb: this._gainDb,
      gainRandom: this._gainRandom,
    }
  }

  /**
   * Generate random gain value for event
   */
  generateEventGain(): number {
    if (this._gainRandom) {
      return generateRandomValue(this._gainRandom, -60, 12)
    }
    return this._gainDb
  }

  /**
   * Calculate final gain including master gain and mute state
   */
  calculateFinalGain(masterGainDb: number, isMuted: boolean): number {
    const sequenceGainDb = this.generateEventGain()

    if (isMuted) {
      return -Infinity
    } else if (sequenceGainDb === -Infinity || masterGainDb === -Infinity) {
      return -Infinity
    } else {
      return sequenceGainDb + masterGainDb
    }
  }

  /**
   * Get gain description for logging
   */
  getGainDescription(): string {
    if (this._gainRandom) {
      return this._gainRandom.type === 'full-random'
        ? 'random'
        : `random(${this._gainRandom.center}±${this._gainRandom.range})`
    }
    return `${this._gainDb} dB`
  }
}
