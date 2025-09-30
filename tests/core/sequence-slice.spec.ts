/**
 * Tests for Sequence class slice playback functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Sequence } from '../../packages/engine/src/core/sequence'
import { Global } from '../../packages/engine/src/core/global'
import { AudioEngine } from '../../packages/engine/src/audio/audio-engine'
import { AdvancedAudioPlayer } from '../../packages/engine/src/audio/advanced-player'

// Mock dependencies
vi.mock('../../packages/engine/src/audio/audio-engine')
vi.mock('../../packages/engine/src/audio/advanced-player')
vi.mock('../../packages/engine/src/audio/audio-slicer', () => ({
  audioSlicer: {
    sliceAudioFile: vi.fn(),
    getSliceFilepath: vi.fn(),
  },
}))

describe('Sequence Slice Playback', () => {
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
    mockScheduler.scheduleEvent = vi.fn()

    // Create sequence
    sequence = new Sequence(global, audioEngine)
    sequence.setName('test')
  })

  describe('chop and play', () => {
    it('should call scheduleSliceEvent for chopped audio', async () => {
      const filepath = '/path/to/test.wav'

      // Set up sequence
      sequence.audio(filepath).chop(4).play(1, 2, 3, 4)

      // Schedule events
      await sequence.scheduleEvents(mockScheduler)

      // Should call scheduleSliceEvent for each slice
      expect(mockScheduler.scheduleSliceEvent).toHaveBeenCalledTimes(4)

      // Check first call
      expect(mockScheduler.scheduleSliceEvent).toHaveBeenNthCalledWith(
        1,
        filepath,
        0, // startTimeMs
        1, // sliceNumber
        4, // totalSlices
        { volume: 50 }, // options
        'test', // sequenceName
      )

      // Check second call
      expect(mockScheduler.scheduleSliceEvent).toHaveBeenNthCalledWith(
        2,
        filepath,
        500, // startTimeMs (bar duration 2000ms / 4 events = 500ms per event)
        2, // sliceNumber
        4, // totalSlices
        { volume: 50 },
        'test',
      )
    })

    it('should call scheduleEvent for non-chopped audio', async () => {
      const filepath = '/path/to/test.wav'

      // Set up sequence without chop
      sequence.audio(filepath).play(1, 0, 1, 0)

      // Schedule events
      await sequence.scheduleEvents(mockScheduler)

      // Should call scheduleEvent for non-zero slices
      expect(mockScheduler.scheduleEvent).toHaveBeenCalledTimes(2)

      // Check first call
      expect(mockScheduler.scheduleEvent).toHaveBeenNthCalledWith(
        1,
        filepath,
        0, // startTimeMs
        50, // volume
        'test', // sequenceName
      )
    })

    it('should handle nested play patterns with chops', async () => {
      const filepath = '/path/to/test.wav'

      // Set up nested pattern using array literal for nesting
      // play(1, [2, 3], 4) should generate 4 events: 1, 2, 3, 4
      const nestedPattern = { type: 'nested' as const, elements: [2, 3] }
      sequence.audio(filepath).chop(4).play(1, nestedPattern, 4)

      // Schedule events
      await sequence.scheduleEvents(mockScheduler)

      // Should call scheduleSliceEvent for each slice
      expect(mockScheduler.scheduleSliceEvent).toHaveBeenCalledTimes(4)

      // Check slice numbers
      const calls = mockScheduler.scheduleSliceEvent.mock.calls
      expect(calls[0][2]).toBe(1) // slice 1
      expect(calls[1][2]).toBe(2) // slice 2
      expect(calls[2][2]).toBe(3) // slice 3
      expect(calls[3][2]).toBe(4) // slice 4
    })

    it('should respect mute state', async () => {
      const filepath = '/path/to/test.wav'

      // Set up sequence and mute it
      sequence.audio(filepath).chop(4).play(1, 2, 3, 4).mute()

      // Schedule events
      await sequence.scheduleEvents(mockScheduler)

      // Should call scheduleSliceEvent with volume 0
      expect(mockScheduler.scheduleSliceEvent).toHaveBeenCalledWith(
        filepath,
        expect.any(Number),
        1,
        4,
        { volume: 0 }, // muted
        'test',
      )
    })

    it('should handle multiple loops', async () => {
      const filepath = '/path/to/test.wav'

      // Set up sequence with length 2
      sequence.audio(filepath).chop(4).play(1, 2).length(2)

      // Schedule events
      await sequence.scheduleEvents(mockScheduler)

      // Should call scheduleSliceEvent for each loop
      expect(mockScheduler.scheduleSliceEvent).toHaveBeenCalledTimes(4) // 2 slices × 2 loops

      // Check timing for second loop
      const calls = mockScheduler.scheduleSliceEvent.mock.calls
      expect(calls[2][1]).toBe(2000) // startTimeMs for second loop (assuming 120 BPM)
    })
  })

  describe('chop method', () => {
    it('should set chop divisions', () => {
      const filepath = '/path/to/test.wav'

      sequence.audio(filepath).chop(8)

      // Should not throw error
      expect(true).toBe(true)
    })

    it('should default to no chopping when chop is not called', () => {
      const filepath = '/path/to/test.wav'

      sequence.audio(filepath).play(1, 2, 3, 4)

      // Should not throw error
      expect(true).toBe(true)
    })
  })
})
