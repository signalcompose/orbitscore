/**
 * Tempo and meter management for Global class
 */

import { Meter } from './types'

export class TempoManager {
  private _tempo: number = 120
  private _beat: Meter = { numerator: 4, denominator: 4 }

  // Note: tick and key have been removed
  // - tick: MIDI resolution, not needed for audio implementation
  // - key: Will be added when MIDI support is implemented

  // Property accessors with method chaining
  tempo(value?: number): number | this {
    if (value === undefined) {
      return this._tempo
    }
    this._tempo = value
    return this
  }

  beat(numerator: number, denominator: number): this {
    this._beat = { numerator, denominator }
    return this
  }

  // Get current state
  getState() {
    return {
      tempo: this._tempo,
      beat: this._beat,
    }
  }
}
