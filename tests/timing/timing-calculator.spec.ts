import { describe, it, expect } from 'vitest'

import { TimingCalculator } from '../../packages/engine/src/timing/timing-calculator'

describe('TimingCalculator', () => {
  describe('calculateTiming', () => {
    it('should calculate simple flat timing', () => {
      // play(1, 2, 3, 4) in a 1000ms bar
      const elements = [1, 2, 3, 4]
      const events = TimingCalculator.calculateTiming(elements, 1000)

      expect(events).toHaveLength(4)
      expect(events[0]).toEqual({
        sliceNumber: 1,
        startTime: 0,
        duration: 250,
        depth: 0,
      })
      expect(events[1]).toEqual({
        sliceNumber: 2,
        startTime: 250,
        duration: 250,
        depth: 0,
      })
      expect(events[2]).toEqual({
        sliceNumber: 3,
        startTime: 500,
        duration: 250,
        depth: 0,
      })
      expect(events[3]).toEqual({
        sliceNumber: 4,
        startTime: 750,
        duration: 250,
        depth: 0,
      })
    })

    it('should handle silence (0)', () => {
      // play(1, 0, 2) - middle element is silence
      const elements = [1, 0, 2]
      const events = TimingCalculator.calculateTiming(elements, 900)

      expect(events).toHaveLength(3)
      expect(events[1]).toEqual({
        sliceNumber: 0,
        startTime: 300,
        duration: 300,
        depth: 0,
      })
    })

    it('should calculate nested timing', () => {
      // play(1, (2, 3)) - 1 gets first half, 2 and 3 split second half
      const elements = [
        1,
        {
          type: 'nested' as const,
          elements: [2, 3],
        },
      ]
      const events = TimingCalculator.calculateTiming(elements, 1000)

      expect(events).toHaveLength(3)

      // Slice 1 gets first 500ms
      expect(events[0]).toEqual({
        sliceNumber: 1,
        startTime: 0,
        duration: 500,
        depth: 0,
      })

      // Slice 2 gets 500-750ms (first quarter of second half)
      expect(events[1]).toEqual({
        sliceNumber: 2,
        startTime: 500,
        duration: 250,
        depth: 1,
      })

      // Slice 3 gets 750-1000ms (second quarter of second half)
      expect(events[2]).toEqual({
        sliceNumber: 3,
        startTime: 750,
        duration: 250,
        depth: 1,
      })
    })

    it('should calculate complex nested timing', () => {
      // play((1, 2), (3, 4, 5))
      // First half: 1 and 2 each get 250ms
      // Second half: 3, 4, 5 each get 166.67ms
      const elements = [
        {
          type: 'nested' as const,
          elements: [1, 2],
        },
        {
          type: 'nested' as const,
          elements: [3, 4, 5],
        },
      ]
      const events = TimingCalculator.calculateTiming(elements, 1000)

      expect(events).toHaveLength(5)

      // First half - divided into 2
      expect(events[0].sliceNumber).toBe(1)
      expect(events[0].startTime).toBe(0)
      expect(events[0].duration).toBe(250)
      expect(events[0].depth).toBe(1)

      expect(events[1].sliceNumber).toBe(2)
      expect(events[1].startTime).toBe(250)
      expect(events[1].duration).toBe(250)
      expect(events[1].depth).toBe(1)

      // Second half - divided into 3
      expect(events[2].sliceNumber).toBe(3)
      expect(events[2].startTime).toBe(500)
      expect(events[2].duration).toBeCloseTo(166.67, 1)
      expect(events[2].depth).toBe(1)

      expect(events[3].sliceNumber).toBe(4)
      expect(events[3].startTime).toBeCloseTo(666.67, 1)
      expect(events[3].duration).toBeCloseTo(166.67, 1)
      expect(events[3].depth).toBe(1)

      expect(events[4].sliceNumber).toBe(5)
      expect(events[4].startTime).toBeCloseTo(833.33, 1)
      expect(events[4].duration).toBeCloseTo(166.67, 1)
      expect(events[4].depth).toBe(1)
    })

    it('should handle 5-tuplet pattern', () => {
      // play(1, (0, 1, 2, 3, 4)) - like "2 beats + 5-tuplet"
      const elements = [
        1,
        {
          type: 'nested' as const,
          elements: [0, 1, 2, 3, 4],
        },
      ]
      const events = TimingCalculator.calculateTiming(elements, 2000) // 4/4 at 120 BPM

      expect(events).toHaveLength(6)

      // First element gets 1000ms (first half)
      expect(events[0]).toEqual({
        sliceNumber: 1,
        startTime: 0,
        duration: 1000,
        depth: 0,
      })

      // 5-tuplet in second half (each gets 200ms)
      for (let i = 0; i < 5; i++) {
        expect(events[i + 1].sliceNumber).toBe(i) // 0, 1, 2, 3, 4
        expect(events[i + 1].startTime).toBe(1000 + i * 200)
        expect(events[i + 1].duration).toBe(200)
        expect(events[i + 1].depth).toBe(1)
      }
    })

    it('should handle deeply nested structures', () => {
      // play(1, (2, (3, 4)))
      // 1 gets first half
      // 2 gets first quarter of second half
      // 3 and 4 split last quarter of second half
      const elements = [
        1,
        {
          type: 'nested' as const,
          elements: [
            2,
            {
              type: 'nested' as const,
              elements: [3, 4],
            },
          ],
        },
      ]
      const events = TimingCalculator.calculateTiming(elements, 1000)

      expect(events).toHaveLength(4)

      // 1 gets 0-500ms
      expect(events[0]).toEqual({
        sliceNumber: 1,
        startTime: 0,
        duration: 500,
        depth: 0,
      })

      // 2 gets 500-750ms
      expect(events[1]).toEqual({
        sliceNumber: 2,
        startTime: 500,
        duration: 250,
        depth: 1,
      })

      // 3 gets 750-875ms
      expect(events[2]).toEqual({
        sliceNumber: 3,
        startTime: 750,
        duration: 125,
        depth: 2,
      })

      // 4 gets 875-1000ms
      expect(events[3]).toEqual({
        sliceNumber: 4,
        startTime: 875,
        duration: 125,
        depth: 2,
      })
    })
  })

  describe('formatTiming', () => {
    it('should format timing as readable beats', () => {
      const events = [
        { sliceNumber: 1, startTime: 0, duration: 500, depth: 0 },
        { sliceNumber: 2, startTime: 500, duration: 250, depth: 1 },
        { sliceNumber: 3, startTime: 750, duration: 250, depth: 1 },
      ]

      const formatted = TimingCalculator.formatTiming(events, 120)

      expect(formatted).toContain('Slice 1 @ beat 0.00 for 1.00 beats')
      expect(formatted).toContain('  Slice 2 @ beat 1.00 for 0.50 beats')
      expect(formatted).toContain('  Slice 3 @ beat 1.50 for 0.50 beats')
    })

    it('should format silence', () => {
      const events = [{ sliceNumber: 0, startTime: 0, duration: 500, depth: 0 }]

      const formatted = TimingCalculator.formatTiming(events, 120)

      expect(formatted).toContain('[silence] @ beat 0.00 for 1.00 beats')
    })
  })
})
