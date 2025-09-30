/**
 * Tests for nested play scheduling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Sequence } from '../../packages/engine/src/core/sequence'
import { Global } from '../../packages/engine/src/core/global'
import { AudioEngine } from '../../packages/engine/src/audio/audio-engine'
import { AdvancedAudioPlayer } from '../../packages/engine/src/audio/advanced-player'

// Mock dependencies
vi.mock('../../packages/engine/src/audio/audio-engine')
vi.mock('../../packages/engine/src/audio/advanced-player')

describe('Nested Play Scheduling', () => {
  let sequence: Sequence
  let global: Global
  let audioEngine: AudioEngine
  let mockScheduler: AdvancedAudioPlayer

  beforeEach(() => {
    vi.clearAllMocks()

    // Mock AudioEngine
    audioEngine = new AudioEngine()

    // Mock Global
    global = new Global(audioEngine)

    // Mock AdvancedAudioPlayer
    mockScheduler = new AdvancedAudioPlayer()
    mockScheduler.scheduleSliceEvent = vi.fn()

    // Create sequence
    sequence = new Sequence(global, audioEngine)
    sequence.setName('test')
  })

  describe('play(1, (2, 3), 2, (3, 4, 1))', () => {
    it('should schedule all 7 events including the last slice 1', async () => {
      // Set up sequence with nested play pattern
      sequence.audio('test.wav').chop(4).play(1, [2, 3], 2, [3, 4, 1])

      // Schedule events
      await sequence.scheduleEvents(mockScheduler)

      // Should call scheduleSliceEvent 7 times
      expect(mockScheduler.scheduleSliceEvent).toHaveBeenCalledTimes(7)

      // Get all calls
      const calls = mockScheduler.scheduleSliceEvent.mock.calls

      // Check the sequence of slice numbers
      const sliceNumbers = calls.map((call) => call[2]) // sliceNumber is 3rd argument
      console.log('Scheduled slice numbers:', sliceNumbers)

      // Should be: 1, 2, 3, 2, 3, 4, 1
      expect(sliceNumbers).toEqual([1, 2, 3, 2, 3, 4, 1])

      // Last call should be slice 1
      const lastCall = calls[calls.length - 1]
      expect(lastCall[2]).toBe(1) // sliceNumber
    })
  })

  describe('play(1, (2, 3, 4), 5)', () => {
    it('should schedule all 5 events including the last slice 5', async () => {
      // Set up sequence with nested play pattern
      sequence.audio('test.wav').chop(5).play(1, [2, 3, 4], 5)

      // Schedule events
      await sequence.scheduleEvents(mockScheduler)

      // Should call scheduleSliceEvent 5 times
      expect(mockScheduler.scheduleSliceEvent).toHaveBeenCalledTimes(5)

      // Get all calls
      const calls = mockScheduler.scheduleSliceEvent.mock.calls

      // Check the sequence of slice numbers
      const sliceNumbers = calls.map((call) => call[2]) // sliceNumber is 3rd argument
      console.log('Scheduled slice numbers:', sliceNumbers)

      // Should be: 1, 2, 3, 4, 5
      expect(sliceNumbers).toEqual([1, 2, 3, 4, 5])

      // Last call should be slice 5
      const lastCall = calls[calls.length - 1]
      expect(lastCall[2]).toBe(5) // sliceNumber
    })
  })
})
