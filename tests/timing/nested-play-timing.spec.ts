/**
 * Tests for nested play timing calculation
 */

import { describe, it, expect } from 'vitest'

import { TimingCalculator } from '../../packages/engine/src/timing/timing-calculator'

describe('Nested Play Timing Calculation', () => {
  describe('play(1, (2, 3), 2, (3, 4, 1))', () => {
    it('should end with slice 1 at correct timing', () => {
      const elements = [
        1,
        { type: 'nested', elements: [2, 3] },
        2,
        { type: 'nested', elements: [3, 4, 1] },
      ]

      const barDuration = 4000 // 4 seconds
      const events = TimingCalculator.calculateTiming(elements, barDuration)

      console.log(
        'Events:',
        events.map((e) => ({ slice: e.sliceNumber, time: e.startTime })),
      )

      // Should have 7 events total
      expect(events).toHaveLength(7)

      // Last event should be slice 1
      const lastEvent = events[events.length - 1]
      expect(lastEvent.sliceNumber).toBe(1)

      // Check timing sequence
      expect(events[0].sliceNumber).toBe(1) // First element
      expect(events[1].sliceNumber).toBe(2) // First nested element
      expect(events[2].sliceNumber).toBe(3) // Second nested element
      expect(events[3].sliceNumber).toBe(2) // Third element
      expect(events[4].sliceNumber).toBe(3) // First of last nested
      expect(events[5].sliceNumber).toBe(4) // Second of last nested
      expect(events[6].sliceNumber).toBe(1) // Last element (should be 1)
    })
  })

  describe('play(1, (2, 3, 4), 5)', () => {
    it('should end with slice 5 at correct timing', () => {
      const elements = [1, { type: 'nested', elements: [2, 3, 4] }, 5]

      const barDuration = 3000 // 3 seconds
      const events = TimingCalculator.calculateTiming(elements, barDuration)

      console.log(
        'Events:',
        events.map((e) => ({ slice: e.sliceNumber, time: e.startTime })),
      )

      // Should have 5 events total
      expect(events).toHaveLength(5)

      // Last event should be slice 5
      const lastEvent = events[events.length - 1]
      expect(lastEvent.sliceNumber).toBe(5)
    })
  })
})
