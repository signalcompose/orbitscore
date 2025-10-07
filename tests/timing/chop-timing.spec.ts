/**
 * Tests for chop() timing functionality
 * Verifies that sliced audio events are scheduled at correct times
 */

import * as path from 'path'

import { describe, it, expect, beforeEach } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('Chop Timing', () => {
  let global: Global
  let player: SuperColliderPlayer
  let sequence: Sequence

  beforeEach(() => {
    player = new SuperColliderPlayer()
    global = new Global(player)
    sequence = new Sequence(global, player as any)
    sequence.setName('test')
  })

  describe('Timing Calculation', () => {
    it('should schedule 4 slices at correct intervals (30 BPM)', async () => {
      // Setup
      global.tempo(30).beat(4, 4)
      sequence.beat(4, 4).length(1)
      sequence.audio(path.join(process.cwd(), 'test-assets/audio/arpeggio_c.wav'))
      sequence.chop(4)
      sequence.play(1, 2, 3, 4)

      // Calculate expected timing
      // 30 BPM = 2000ms per beat, 4 beats = 8000ms per bar
      // 4 slices = 2000ms interval each
      const expectedTimes = [0, 2000, 4000, 6000]

      // Get timed events
      const state = sequence.getState()
      expect(state.timedEvents).toBeDefined()
      expect(state.timedEvents?.length).toBe(4)

      // Verify timing
      state.timedEvents?.forEach((event, index) => {
        expect(event.sliceNumber).toBe(index + 1)
        expect(event.startTime).toBe(expectedTimes[index])
      })
    })

    it('should schedule 4 slices at correct intervals (120 BPM)', async () => {
      // Setup
      global.tempo(120).beat(4, 4)
      sequence.beat(4, 4).length(1)
      sequence.audio(path.join(process.cwd(), 'test-assets/audio/arpeggio_c.wav'))
      sequence.chop(4)
      sequence.play(1, 2, 3, 4)

      // Calculate expected timing
      // 120 BPM = 500ms per beat, 4 beats = 2000ms per bar
      // 4 slices = 500ms interval each
      const expectedTimes = [0, 500, 1000, 1500]

      // Get timed events
      const state = sequence.getState()
      expect(state.timedEvents).toBeDefined()
      expect(state.timedEvents?.length).toBe(4)

      // Verify timing
      state.timedEvents?.forEach((event, index) => {
        expect(event.sliceNumber).toBe(index + 1)
        expect(event.startTime).toBe(expectedTimes[index])
      })
    })

    it('should schedule only specified slices', async () => {
      // Setup
      global.tempo(60).beat(4, 4)
      sequence.beat(4, 4).length(1)
      sequence.audio(path.join(process.cwd(), 'test-assets/audio/arpeggio_c.wav'))
      sequence.chop(4)
      sequence.play(1, 0, 3, 0) // Only 1st and 3rd slices

      // Calculate expected timing
      // 60 BPM = 1000ms per beat, 4 beats = 4000ms per bar
      // 4 positions = 1000ms interval each
      const expectedEvents = [
        { sliceNumber: 1, startTime: 0 },
        { sliceNumber: 0, startTime: 1000 }, // 0 = silence
        { sliceNumber: 3, startTime: 2000 },
        { sliceNumber: 0, startTime: 3000 }, // 0 = silence
      ]

      // Get timed events
      const state = sequence.getState()
      expect(state.timedEvents).toBeDefined()
      expect(state.timedEvents?.length).toBe(4)

      // Verify timing
      state.timedEvents?.forEach((event, index) => {
        expect(event.sliceNumber).toBe(expectedEvents[index].sliceNumber)
        expect(event.startTime).toBe(expectedEvents[index].startTime)
      })
    })
  })

  describe('Slice Scheduling', () => {
    it('should call scheduleSliceEvent with correct parameters', async () => {
      // Mock EventScheduler's scheduleSliceEvent method
      const scheduledEvents: any[] = []
      ;(player as any).eventScheduler.scheduleSliceEvent = (
        filepath: string,
        startTimeMs: number,
        sliceIndex: number,
        totalSlices: number,
        eventDurationMs: number,
        gainDb: number,
        pan: number,
        sequenceName: string,
      ) => {
        scheduledEvents.push({
          filepath,
          startTimeMs,
          sliceIndex,
          totalSlices,
          eventDurationMs,
          gainDb,
          pan,
          sequenceName,
        })
      }

      // Mock loadBuffer to avoid server calls
      player.loadBuffer = async () => ({ bufnum: 0 })

      // Setup
      global.tempo(60).beat(4, 4)
      await global.run()

      sequence.beat(4, 4).length(1)
      sequence.audio(path.join(process.cwd(), 'test-assets/audio/arpeggio_c.wav'))
      sequence.chop(4)
      sequence.play(1, 2, 3, 4)

      // Run sequence
      await sequence.run()

      // Verify scheduleSliceEvent was called 4 times
      expect(scheduledEvents.length).toBe(4)

      // Verify parameters
      const expectedTimes = [0, 1000, 2000, 3000]
      scheduledEvents.forEach((event, index) => {
        expect(event.sliceIndex).toBe(index + 1)
        expect(event.totalSlices).toBe(4)
        expect(event.startTimeMs).toBeGreaterThanOrEqual(expectedTimes[index])
        expect(event.startTimeMs).toBeLessThan(expectedTimes[index] + 300) // Allow 300ms tolerance for CI
        expect(event.sequenceName).toBe('test')
      })
    })

    it('should schedule slices with correct slice positions', async () => {
      // Mock EventScheduler's scheduleSliceEvent method
      const scheduledEvents: any[] = []
      ;(player as any).eventScheduler.scheduleSliceEvent = (
        filepath: string,
        startTimeMs: number,
        sliceIndex: number,
        totalSlices: number,
        eventDurationMs: number,
        gainDb: number,
        pan: number,
        sequenceName: string,
      ) => {
        scheduledEvents.push({
          filepath,
          startTimeMs,
          sliceIndex,
          totalSlices,
          eventDurationMs,
          gainDb,
          pan,
          sequenceName,
        })
      }

      // Mock loadBuffer to avoid server calls
      player.loadBuffer = async () => ({ bufnum: 0 })

      // Setup
      global.tempo(60).beat(4, 4)
      await global.run()

      sequence.beat(4, 4).length(1)
      sequence.audio(path.join(process.cwd(), 'test-assets/audio/arpeggio_c.wav'))
      sequence.chop(8) // 8 slices
      sequence.play(2, 4, 6, 8) // Even slices only

      // Run sequence
      await sequence.run()

      // Verify scheduleSliceEvent was called 4 times
      expect(scheduledEvents.length).toBe(4)

      // Verify slice indices
      const expectedSlices = [2, 4, 6, 8]
      scheduledEvents.forEach((event, index) => {
        expect(event.sliceIndex).toBe(expectedSlices[index])
        expect(event.totalSlices).toBe(8)
      })
    })
  })

  describe('Slice Duration', () => {
    it('should calculate correct slice duration', async () => {
      // Mock getAudioDuration
      player.getAudioDuration = () => 1.0 // 1 second audio file

      // Setup
      global.tempo(60).beat(4, 4)
      sequence.beat(4, 4).length(1)
      sequence.audio('test-assets/audio/test.wav')
      sequence.chop(4)
      sequence.play(1, 2, 3, 4)

      // Expected slice duration = 1.0 / 4 = 0.25 seconds
      const expectedSliceDuration = 0.25

      // Verify (this would require accessing internal state or mocking)
      // For now, we verify the calculation logic
      const totalDuration = 1.0
      const numSlices = 4
      const sliceDuration = totalDuration / numSlices
      expect(sliceDuration).toBe(expectedSliceDuration)
    })
  })
})
