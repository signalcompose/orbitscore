/**
 * Quantize management for Global
 *
 * LOOP() startup and play() seamless updates wait until the next quantized
 * boundary derived from this setting. RUN() ignores quantize (one-shot).
 */

import { Meter } from './types'

export type QuantizeValue = 'off' | 'beat' | 'bar' | '2bar' | '4bar' | '8bar'

const VALID_VALUES: ReadonlySet<QuantizeValue> = new Set([
  'off',
  'beat',
  'bar',
  '2bar',
  '4bar',
  '8bar',
])

export function isQuantizeValue(value: unknown): value is QuantizeValue {
  return typeof value === 'string' && VALID_VALUES.has(value as QuantizeValue)
}

/**
 * Compute the duration in milliseconds for a quantize value, given the
 * tempo and meter that define the master grid.
 *
 * - "off"   → 0 (caller should treat as immediate)
 * - "beat"  → one quarter-note (60_000 / tempo)
 * - "bar"   → numerator * quarter-note * (4 / denominator)
 * - "2bar"  → 2 × bar
 * - "4bar"  → 4 × bar
 * - "8bar"  → 8 × bar
 */
export function quantizeDurationMs(value: QuantizeValue, tempo: number, beat: Meter): number {
  if (value === 'off') return 0

  const quarterNoteMs = 60_000 / tempo
  const barMs = quarterNoteMs * ((beat.numerator / beat.denominator) * 4)

  switch (value) {
    case 'beat':
      return quarterNoteMs
    case 'bar':
      return barMs
    case '2bar':
      return barMs * 2
    case '4bar':
      return barMs * 4
    case '8bar':
      return barMs * 8
    default: {
      const _exhaustive: never = value
      throw new Error(`quantizeDurationMs: unhandled QuantizeValue ${String(_exhaustive)}`)
    }
  }
}

/**
 * Compute the next quantized boundary at or after `currentTime` (ms since
 * scheduler start). Returns `currentTime` unchanged when quantize is 'off' or
 * the duration is 0.
 */
export function nextQuantizedTime(
  currentTime: number,
  value: QuantizeValue,
  tempo: number,
  beat: Meter,
): number {
  const durationMs = quantizeDurationMs(value, tempo, beat)
  if (durationMs <= 0) return currentTime
  if (currentTime <= 0) return durationMs

  const boundaries = Math.ceil(currentTime / durationMs)
  return boundaries * durationMs
}

export class QuantizeManager {
  private _value: QuantizeValue = 'bar'

  setQuantize(value: QuantizeValue): void {
    if (!isQuantizeValue(value)) {
      throw new Error(
        `quantize() expects one of "off" | "beat" | "bar" | "2bar" | "4bar" | "8bar", got: ${String(value)}`,
      )
    }
    this._value = value
  }

  getQuantize(): QuantizeValue {
    return this._value
  }
}
