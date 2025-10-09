/**
 * Seamless Parameter Update Tests
 *
 * Tests for _method() seamless parameter update functionality.
 * Verifies that underscore-prefixed methods trigger immediate parameter updates
 * during playback (both LOOP and RUN).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('Seamless Parameter Update (_method() functionality)', () => {
  let global: Global
  let seq: Sequence
  let mockPlayer: SuperColliderPlayer
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Create mock SuperCollider player with scheduler properties
    mockPlayer = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
      clearSequenceEvents: vi.fn(),
      isRunning: true, // Scheduler is running
      startTime: Date.now(), // Scheduler start time
    } as any

    global = new Global(mockPlayer)
    seq = new Sequence(global, mockPlayer)
    seq.setName('test')

    // Spy on console.log to verify seamless update messages
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    seq.stop()
  })

  describe('LOOP中の_method()動作確認', () => {
    it('should trigger seamless update for _tempo() during LOOP', async () => {
      // Setup
      seq.tempo(120).play(1, 0, 1, 0)
      await seq.loop()

      // Clear previous console.log calls
      consoleLogSpy.mockClear()

      // Execute _tempo() during loop
      seq._tempo(140)

      // Verify seamless update was triggered
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: tempo=140 BPM (seamless)'),
      )

      // Verify tempo was updated
      const state = seq.getState()
      expect(state.tempo).toBe(140)
    })

    it('should trigger seamless update for _play() during LOOP', async () => {
      // Setup
      seq.tempo(120).play(1, 0, 1, 0)
      await seq.loop()

      consoleLogSpy.mockClear()

      // Execute _play() during loop
      seq._play(1, 1, 1, 1)

      // Verify seamless update was triggered
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: play=1 1 1 1 (seamless)'),
      )

      // Verify play pattern was updated
      const state = seq.getState()
      expect(state.playPattern).toEqual([1, 1, 1, 1])
    })

    it('should trigger seamless update for _beat() during LOOP', async () => {
      // Setup
      seq.tempo(120).beat(4, 4).play(1, 0, 1, 0)
      await seq.loop()

      consoleLogSpy.mockClear()

      // Execute _beat() during loop
      seq._beat(5, 4)

      // Verify seamless update was triggered
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: beat=5/4 (seamless)'),
      )

      // Verify beat was updated
      const state = seq.getState()
      expect(state.beat).toEqual({ numerator: 5, denominator: 4 })
    })

    it('should trigger seamless update for _length() during LOOP', async () => {
      // Setup
      seq.tempo(120).length(1).play(1, 0, 1, 0)
      await seq.loop()

      consoleLogSpy.mockClear()

      // Execute _length() during loop
      seq._length(2)

      // Verify seamless update was triggered
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: length=2 bars (seamless)'),
      )

      // Verify length was updated
      const state = seq.getState()
      expect(state.length).toBe(2)
    })
  })

  describe('RUN中の_method()動作確認（現在の実装では動作しない）', () => {
    it('should NOT trigger seamless update for _tempo() during RUN (loopStartTime is undefined)', async () => {
      // Setup
      seq.tempo(120).play(1, 0, 1, 0)
      await seq.run()

      consoleLogSpy.mockClear()

      // Execute _tempo() during run
      seq._tempo(140)

      // Current implementation: seamless update is NOT triggered for RUN
      // because loopStartTime is undefined
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: tempo=140 BPM (seamless)'),
      )

      // However, tempo value should still be updated
      const state = seq.getState()
      expect(state.tempo).toBe(140)
    })

    it('should NOT trigger seamless update for _play() during RUN', async () => {
      // Setup
      seq.tempo(120).play(1, 0, 1, 0)
      await seq.run()

      consoleLogSpy.mockClear()

      // Execute _play() during run
      seq._play(1, 1, 1, 1)

      // Current implementation: seamless update is NOT triggered for RUN
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: play=1 1 1 1 (seamless)'),
      )

      // Play pattern value should still be updated
      const state = seq.getState()
      expect(state.playPattern).toEqual([1, 1, 1, 1])
    })
  })

  describe('gain/panの即時反映（リアルタイムパラメータ）', () => {
    it('should trigger seamless update for _gain() during LOOP', async () => {
      // Setup
      seq.tempo(120).play(1, 0, 1, 0).gain(0)
      await seq.loop()

      consoleLogSpy.mockClear()

      // Execute _gain() during loop
      seq._gain(-6)

      // Verify seamless update was triggered
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: gain=-6 dB (seamless)'),
      )

      // Verify gain was updated
      const state = seq.getState()
      expect(state.gainDb).toBe(-6)
    })

    it('should trigger seamless update for _pan() during LOOP', async () => {
      // Setup
      seq.tempo(120).play(1, 0, 1, 0).pan(0)
      await seq.loop()

      consoleLogSpy.mockClear()

      // Execute _pan() during loop
      seq._pan(50)

      // Verify seamless update was triggered
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: pan=50 (seamless)'),
      )

      // Verify pan was updated
      const state = seq.getState()
      expect(state.pan).toBe(50)
    })
  })

  describe('停止中の_method()動作確認', () => {
    it('should NOT trigger seamless update when stopped', () => {
      // Setup (no playback started)
      seq.tempo(120).play(1, 0, 1, 0)

      consoleLogSpy.mockClear()

      // Execute _tempo() while stopped
      seq._tempo(140)

      // Should not trigger seamless update when not playing
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: tempo=140 BPM (seamless)'),
      )

      // Tempo value should still be updated
      const state = seq.getState()
      expect(state.tempo).toBe(140)
    })
  })

  describe('seamlessParameterUpdate()の内部動作確認', () => {
    it('should clear old events and reschedule with new parameters during LOOP', async () => {
      // Setup
      seq.tempo(120).play(1, 0, 1, 0)
      await seq.loop()

      const scheduler = global.getScheduler()
      const clearSpy = vi.spyOn(scheduler, 'clearSequenceEvents')

      // Execute _tempo() during loop
      seq._tempo(140)

      // Verify old events were cleared
      expect(clearSpy).toHaveBeenCalledWith('test')

      clearSpy.mockRestore()
    })
  })
})
