/**
 * Pan parameter manager for Sequence
 * Handles pan value setting, random generation, and seamless updates
 */

import { RandomValue } from '../../../parser/audio-parser'
import { PanOptions } from '../types'

import { generateRandomValue } from './random-utils'

/**
 * Pan parameter manager
 */
export class PanManager {
  private _pan: number = 0 // -100 (left) to 100 (right), default 0 (center)
  private _panRandom?: RandomValue // Random spec for pan

  /**
   * Set pan value
   */
  setPan(options: PanOptions): { pan: number; panRandom?: RandomValue } {
    const { value } = options

    // Check if it's a random value spec
    if (typeof value === 'object' && 'type' in value) {
      this._panRandom = value
      // Set a default value for display (center if random-walk, 0 if full-random)
      if (value.type === 'random-walk') {
        this._pan = Math.max(-100, Math.min(100, value.center))
      } else {
        this._pan = 0 // Default to center for full-random
      }
    } else {
      // Fixed value
      this._panRandom = undefined
      this._pan = Math.max(-100, Math.min(100, value))
    }

    return {
      pan: this._pan,
      panRandom: this._panRandom,
    }
  }

  /**
   * Get current pan value
   */
  getPan(): { pan: number; panRandom?: RandomValue } {
    return {
      pan: this._pan,
      panRandom: this._panRandom,
    }
  }

  /**
   * Generate random pan value for event
   */
  generateEventPan(): number {
    if (this._panRandom) {
      return generateRandomValue(this._panRandom, -100, 100)
    }
    return this._pan
  }

  /**
   * Get pan description for logging
   */
  getPanDescription(): string {
    if (this._panRandom) {
      return this._panRandom.type === 'full-random'
        ? 'random'
        : `random(${this._panRandom.center}±${this._panRandom.range})`
    }
    return this._pan.toString()
  }
}
