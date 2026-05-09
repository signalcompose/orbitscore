/**
 * Quantize manager tests
 *
 * Covers the pure timing math in quantize-manager (no scheduler / DSL plumbing).
 */

import { describe, it, expect } from 'vitest'

import {
  QuantizeManager,
  isQuantizeValue,
  nextQuantizedTime,
  quantizeDurationMs,
} from '../../packages/engine/src/core/global/quantize-manager'
import { SequenceQuantizeManager } from '../../packages/engine/src/core/sequence/parameters/quantize-manager'

describe('QuantizeManager', () => {
  it('defaults to "bar"', () => {
    const m = new QuantizeManager()
    expect(m.getQuantize()).toBe('bar')
  })

  it('accepts and persists each valid value', () => {
    const m = new QuantizeManager()
    for (const v of ['off', 'beat', 'bar', '2bar', '4bar', '8bar'] as const) {
      m.setQuantize(v)
      expect(m.getQuantize()).toBe(v)
    }
  })

  it('rejects invalid values with a descriptive error', () => {
    const m = new QuantizeManager()
    expect(() => m.setQuantize('half-bar' as any)).toThrow(/quantize\(\) expects/)
    expect(() => m.setQuantize(2 as any)).toThrow(/quantize\(\) expects/)
  })
})

describe('SequenceQuantizeManager', () => {
  it('returns undefined when no override is set (signals fallback to global)', () => {
    const m = new SequenceQuantizeManager()
    expect(m.getQuantize()).toBeUndefined()
  })

  it('persists explicit overrides', () => {
    const m = new SequenceQuantizeManager()
    m.setQuantize('2bar')
    expect(m.getQuantize()).toBe('2bar')
  })

  it('rejects invalid values', () => {
    const m = new SequenceQuantizeManager()
    expect(() => m.setQuantize('half' as any)).toThrow(/seq\.quantize\(\) expects/)
  })
})

describe('isQuantizeValue', () => {
  it('accepts the exact set of allowed strings', () => {
    expect(isQuantizeValue('off')).toBe(true)
    expect(isQuantizeValue('beat')).toBe(true)
    expect(isQuantizeValue('bar')).toBe(true)
    expect(isQuantizeValue('2bar')).toBe(true)
    expect(isQuantizeValue('4bar')).toBe(true)
    expect(isQuantizeValue('8bar')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isQuantizeValue('half-bar')).toBe(false)
    expect(isQuantizeValue('')).toBe(false)
    expect(isQuantizeValue(0)).toBe(false)
    expect(isQuantizeValue(null)).toBe(false)
    expect(isQuantizeValue(undefined)).toBe(false)
  })
})

describe('quantizeDurationMs', () => {
  // 120 BPM, 4/4: quarter = 500 ms, bar = 2000 ms
  const tempo = 120
  const beat44 = { numerator: 4, denominator: 4 }

  it('returns 0 for "off"', () => {
    expect(quantizeDurationMs('off', tempo, beat44)).toBe(0)
  })

  it('returns one quarter note for "beat"', () => {
    expect(quantizeDurationMs('beat', tempo, beat44)).toBeCloseTo(500, 6)
  })

  it('returns one bar in 4/4', () => {
    expect(quantizeDurationMs('bar', tempo, beat44)).toBeCloseTo(2000, 6)
  })

  it('scales by 2 / 4 / 8 for multi-bar values', () => {
    expect(quantizeDurationMs('2bar', tempo, beat44)).toBeCloseTo(4000, 6)
    expect(quantizeDurationMs('4bar', tempo, beat44)).toBeCloseTo(8000, 6)
    expect(quantizeDurationMs('8bar', tempo, beat44)).toBeCloseTo(16000, 6)
  })

  it('respects polymeter — bar duration depends on numerator and denominator', () => {
    // 5/4 at 120 BPM: 5 * 500 = 2500 ms
    expect(quantizeDurationMs('bar', 120, { numerator: 5, denominator: 4 })).toBeCloseTo(2500, 6)
    // 7/8 at 120 BPM: 7 * 500 * (4/8) = 1750 ms
    expect(quantizeDurationMs('bar', 120, { numerator: 7, denominator: 8 })).toBeCloseTo(1750, 6)
  })
})

describe('nextQuantizedTime', () => {
  const tempo = 120
  const beat44 = { numerator: 4, denominator: 4 }

  it('returns currentTime unchanged when quantize is "off"', () => {
    expect(nextQuantizedTime(1234, 'off', tempo, beat44)).toBe(1234)
  })

  it('snaps to the next bar boundary for "bar"', () => {
    // 4/4 @ 120 BPM → bar = 2000 ms. Boundaries at 0, 2000, 4000, ...
    expect(nextQuantizedTime(0, 'bar', tempo, beat44)).toBe(2000)
    expect(nextQuantizedTime(500, 'bar', tempo, beat44)).toBe(2000)
    expect(nextQuantizedTime(1999, 'bar', tempo, beat44)).toBe(2000)
    expect(nextQuantizedTime(2000, 'bar', tempo, beat44)).toBe(2000)
    expect(nextQuantizedTime(2001, 'bar', tempo, beat44)).toBe(4000)
  })

  it('snaps to multi-bar boundaries', () => {
    // 2bar = 4000 ms. Boundaries at 0, 4000, 8000, ...
    expect(nextQuantizedTime(1, '2bar', tempo, beat44)).toBe(4000)
    expect(nextQuantizedTime(4001, '2bar', tempo, beat44)).toBe(8000)
  })

  it('snaps to beat boundaries for "beat"', () => {
    // beat = 500 ms. Boundaries at 0, 500, 1000, 1500, ...
    expect(nextQuantizedTime(1, 'beat', tempo, beat44)).toBe(500)
    expect(nextQuantizedTime(500, 'beat', tempo, beat44)).toBe(500)
    expect(nextQuantizedTime(501, 'beat', tempo, beat44)).toBe(1000)
  })
})
