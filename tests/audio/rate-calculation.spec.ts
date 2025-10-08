/**
 * Rate calculation tests
 *
 * Validates that playback rate is correctly calculated based on:
 * - Audio file duration
 * - Chop divisions
 * - Sequence length
 * - Tempo and time signature
 */

import { describe, it, expect } from 'vitest'

/**
 * Calculate expected rate
 *
 * @param audioFileDuration - Audio file duration in seconds
 * @param chopDivisions - Number of slices
 * @param eventDurationMs - Event duration in milliseconds
 * @returns Expected playback rate
 */
function calculateRate(
  audioFileDuration: number,
  chopDivisions: number,
  eventDurationMs: number,
): number {
  const sliceDuration = audioFileDuration / chopDivisions
  return (sliceDuration * 1000) / eventDurationMs
}

describe('Rate Calculation', () => {
  describe('Basic rate calculation', () => {
    it('should calculate rate = 1.0 when slice duration equals event duration', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 4 // 4 slices of 250ms each
      const eventDurationMs = 250 // 250ms event

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(1.0)
    })

    it('should calculate rate = 0.5 when event duration is double slice duration', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 4 // 4 slices of 250ms each
      const eventDurationMs = 500 // 500ms event

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(0.5)
    })

    it('should calculate rate = 2.0 when event duration is half slice duration', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 4 // 4 slices of 250ms each
      const eventDurationMs = 125 // 125ms event

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(2.0)
    })
  })

  describe('Tempo 120 BPM, 4/4 time signature', () => {
    // At 120 BPM:
    // - 1 beat = 500ms
    // - 1 bar (4 beats) = 2000ms

    it('should calculate rate = 0.5 for length(1) with 1-second audio chopped to 4', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 4 // 4 slices
      const beatsPerBar = 4
      const beatDurationMs = 500 // 120 BPM

      // With length(1), 4 slices spread across 4 beats
      const eventDurationMs = (beatsPerBar * beatDurationMs) / chopDivisions // 2000 / 4 = 500ms

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(0.5)
    })

    it('should calculate rate = 0.25 for length(2) with 1-second audio chopped to 4', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 4 // 4 slices
      const beatsPerBar = 4
      const beatDurationMs = 500 // 120 BPM
      // const length = 2

      // With length(2), 4 slices spread across 8 beats (2 bars)
      const totalBeats = beatsPerBar * 2 // 8 beats
      const eventDurationMs = (totalBeats * beatDurationMs) / chopDivisions // 4000 / 4 = 1000ms

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(0.25)
    })

    it('should calculate rate = 0.125 for length(4) with 1-second audio chopped to 4', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 4 // 4 slices
      const beatsPerBar = 4
      const beatDurationMs = 500 // 120 BPM
      // const length = 4

      // With length(4), 4 slices spread across 16 beats (4 bars)
      const totalBeats = beatsPerBar * 4 // 16 beats
      const eventDurationMs = (totalBeats * beatDurationMs) / chopDivisions // 8000 / 4 = 2000ms

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(0.125)
    })
  })

  describe('Different tempo scenarios', () => {
    it('should calculate rate = 0.5 for length(1) at tempo 140 BPM', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 4 // 4 slices
      const beatsPerBar = 4
      const tempo = 140
      const beatDurationMs = 60000 / tempo // ~428.57ms

      const eventDurationMs = (beatsPerBar * beatDurationMs) / chopDivisions // ~428.57ms

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBeCloseTo(0.583, 2) // 250 / 428.57 ≈ 0.583
    })

    it('should calculate rate = 0.5 for length(1) at tempo 90 BPM', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 4 // 4 slices
      const beatsPerBar = 4
      const tempo = 90
      const beatDurationMs = 60000 / tempo // ~666.67ms

      const eventDurationMs = (beatsPerBar * beatDurationMs) / chopDivisions // ~666.67ms

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBeCloseTo(0.375, 2) // 250 / 666.67 ≈ 0.375
    })
  })

  describe('Different chop divisions', () => {
    it('should calculate rate = 1.0 for chop(2) with length(1) at 120 BPM', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 2 // 2 slices of 500ms each
      const beatsPerBar = 4
      const beatDurationMs = 500 // 120 BPM
      // const length = 1

      const eventDurationMs = (beatsPerBar * beatDurationMs) / chopDivisions // 2000 / 2 = 1000ms

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(0.5)
    })

    it('should calculate rate = 0.25 for chop(8) with length(1) at 120 BPM', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 8 // 8 slices of 125ms each
      const beatsPerBar = 4
      const beatDurationMs = 500 // 120 BPM
      // const length = 1

      const eventDurationMs = (beatsPerBar * beatDurationMs) / chopDivisions // 2000 / 8 = 250ms

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(0.5)
    })
  })

  describe('Nested patterns - rate adjustment', () => {
    it('should calculate rate = 1.0 for nested pattern that doubles speed', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 4 // 4 slices of 250ms each
      // Nested pattern like play(1, 2, (3, 4)) where (3, 4) splits 1 beat into 2 events
      const eventDurationMs = 250 // Half of a normal beat (500ms)

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(1.0)
    })

    it('should calculate rate = 1.5 for triple subdivision', () => {
      const audioFileDuration = 1.0 // 1 second
      const chopDivisions = 4 // 4 slices of 250ms each
      // Triple subdivision: (1, 2, 3) splitting 1 beat (500ms) into 3 events
      const eventDurationMs = 500 / 3 // ~166.67ms

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBeCloseTo(1.5, 2) // 250 / 166.67 ≈ 1.5
    })
  })

  describe('Edge cases', () => {
    it('should handle chop(1) - no division', () => {
      const audioFileDuration = 0.5 // 500ms kick drum sample
      const chopDivisions = 1 // No division
      const eventDurationMs = 500 // 1 beat at 120 BPM

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(1.0) // Play at natural speed
    })

    it('should handle very short audio files', () => {
      const audioFileDuration = 0.1 // 100ms
      const chopDivisions = 4 // 4 slices of 25ms each
      const eventDurationMs = 500 // 1 beat

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(0.05) // Very slow playback to stretch
    })

    it('should handle very long audio files', () => {
      const audioFileDuration = 10.0 // 10 seconds
      const chopDivisions = 4 // 4 slices of 2.5s each
      const eventDurationMs = 500 // 1 beat

      const rate = calculateRate(audioFileDuration, chopDivisions, eventDurationMs)

      expect(rate).toBe(5.0) // Fast playback to compress
    })
  })
})
