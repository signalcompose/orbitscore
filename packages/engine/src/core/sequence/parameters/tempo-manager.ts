/**
 * Tempo parameter manager for Sequence
 * Handles tempo, beat, and length parameter management
 */

import { Meter } from '../../global/types'
import { PlayElement } from '../../../parser/audio-parser'
import { TimedEvent, calculateEventTiming } from '../../../timing/calculation'

/**
 * Tempo parameter manager
 */
export class TempoManager {
  private _tempo?: number
  private _beat?: Meter
  private _length?: number // Loop length in bars

  /**
   * Set tempo value
   */
  setTempo(tempo: number): void {
    this._tempo = tempo
  }

  /**
   * Set beat (meter) value
   */
  setBeat(numerator: number, denominator: number): void {
    this._beat = { numerator, denominator }
  }

  /**
   * Set length value
   */
  setLength(bars: number): void {
    this._length = bars
  }

  /**
   * Get current tempo value
   */
  getTempo(): number | undefined {
    return this._tempo
  }

  /**
   * Get current beat value
   */
  getBeat(): Meter | undefined {
    return this._beat
  }

  /**
   * Get current length value
   */
  getLength(): number | undefined {
    return this._length
  }

  /**
   * Calculate bar duration in milliseconds
   * @private
   */
  private calculateBarDuration(tempo: number, meter: Meter): number {
    // 1小節の長さ = 4分音符の長さ × (分子 / 分母 × 4)
    const quarterNoteDuration = 60000 / tempo
    return quarterNoteDuration * ((meter.numerator / meter.denominator) * 4)
  }

  /**
   * Calculate pattern duration
   */
  calculatePatternDuration(globalTempo: number, globalBeat: Meter): number {
    const tempo = this._tempo || globalTempo
    const meter = this._beat || globalBeat
    const barDuration = this.calculateBarDuration(tempo, meter)

    // length() multiplies the duration of each event, not the number of bars
    // So the pattern duration is: 1 bar × length multiplier
    return barDuration * (this._length || 1)
  }

  /**
   * Calculate event timing for play pattern
   */
  calculateEventTiming(
    elements: PlayElement[],
    globalTempo: number,
    globalBeat: Meter,
  ): TimedEvent[] {
    const tempo = this._tempo || globalTempo
    const meter = this._beat || globalBeat

    // これにより、シーケンスごとに異なる拍子で1小節の長さを変えられる（ポリメーター）
    // 例: global.beat(4 by 4) = 2000ms, seq.beat(5 by 4) = 2500ms, seq.beat(9 by 8) = 2250ms
    const barDuration = this.calculateBarDuration(tempo, meter)

    // Apply length multiplier to bar duration (stretches each event)
    const effectiveBarDuration = barDuration * (this._length || 1)

    const events = calculateEventTiming(elements, effectiveBarDuration)

    // #390 live playhead: tag each event with the TOP-LEVEL play() arg index it
    // derives from. The timing walk divides the bar equally among top-level
    // elements and every nested event stays inside its parent's slot, so
    // floor(startTime / slotDuration) recovers the exact top-level index — no
    // change to the walk itself (emission-only). The tiny epsilon absorbs float
    // error at slot boundaries (the first event of arg i sits exactly at
    // i*slotDuration). Dot-joined deeper paths ("1.0") are reserved for the
    // nested phase.
    if (elements.length > 0) {
      const slotDuration = effectiveBarDuration / elements.length
      const lastIndex = elements.length - 1
      for (const event of events) {
        const index = Math.floor(event.startTime / slotDuration + 1e-9)
        event.argPath = String(Math.min(lastIndex, Math.max(0, index)))
      }
    }

    return events
  }
}
