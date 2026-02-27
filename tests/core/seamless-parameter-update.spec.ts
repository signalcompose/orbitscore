/**
 * Seamless Parameter Update Tests
 *
 * Tests that parameter methods (tempo, beat, gain, pan, etc.) trigger
 * immediate seamless updates during playback (LOOP).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('Seamless Parameter Update', () => {
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

  describe('LOOP中のseamless update動作確認', () => {
    it('should defer tempo change to next loop cycle during LOOP', async () => {
      seq.tempo(120).play(1, 0, 1, 0)
      await seq.loop()
      consoleLogSpy.mockClear()

      seq.tempo(140)

      // Timing changes are deferred to next bar boundary (not immediate)
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: tempo=140 BPM (next cycle)'),
      )
      const state = seq.getState()
      expect(state.tempo).toBe(140)
    })

    it('should trigger seamless update for play() during LOOP', async () => {
      seq.tempo(120).play(1, 0, 1, 0)
      await seq.loop()
      consoleLogSpy.mockClear()

      seq.play(1, 1, 1, 1)

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: play=1 1 1 1 (seamless)'),
      )
      const state = seq.getState()
      expect(state.playPattern).toEqual([1, 1, 1, 1])
    })

    it('should defer beat change to next loop cycle during LOOP', async () => {
      seq.tempo(120).beat(4, 4).play(1, 0, 1, 0)
      await seq.loop()
      consoleLogSpy.mockClear()

      seq.beat(5, 4)

      // Timing changes are deferred to next bar boundary
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: beat=5/4 (next cycle)'),
      )
      const state = seq.getState()
      expect(state.beat).toEqual({ numerator: 5, denominator: 4 })
    })

    it('should defer length change to next loop cycle during LOOP', async () => {
      seq.tempo(120).length(1).play(1, 0, 1, 0)
      await seq.loop()
      consoleLogSpy.mockClear()

      seq.length(2)

      // Timing changes are deferred to next bar boundary
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: length=2 bars (next cycle)'),
      )
      const state = seq.getState()
      expect(state.length).toBe(2)
    })
  })

  describe('gain/panの即時反映（リアルタイムパラメータ）', () => {
    it('should trigger seamless update for gain() during LOOP', async () => {
      seq.tempo(120).play(1, 0, 1, 0).gain(0)
      await seq.loop()
      consoleLogSpy.mockClear()

      seq.gain(-6)

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: gain=-6 dB (seamless)'),
      )
      const state = seq.getState()
      expect(state.gainDb).toBe(-6)
    })

    it('should trigger seamless update for pan() during LOOP', async () => {
      seq.tempo(120).play(1, 0, 1, 0).pan(0)
      await seq.loop()
      consoleLogSpy.mockClear()

      seq.pan(50)

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: pan=50 (seamless)'),
      )
      const state = seq.getState()
      expect(state.pan).toBe(50)
    })
  })

  describe('停止中のmethod()動作確認', () => {
    it('should NOT trigger seamless update when stopped', () => {
      seq.tempo(120).play(1, 0, 1, 0)
      consoleLogSpy.mockClear()

      seq.tempo(140)

      // Should not trigger seamless update when not playing
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('🎚️ test: tempo=140 BPM (seamless)'),
      )

      // Value should still be updated
      const state = seq.getState()
      expect(state.tempo).toBe(140)
    })
  })

  describe('seamlessParameterUpdate()の内部動作確認', () => {
    it('should NOT clear events for timing changes during LOOP (deferred to next cycle)', async () => {
      seq.tempo(120).play(1, 0, 1, 0)
      await seq.loop()

      const scheduler = global.getScheduler()
      const clearSpy = vi.spyOn(scheduler, 'clearSequenceEvents')
      clearSpy.mockClear()

      seq.tempo(140)

      // Timing changes don't clear events - they're deferred to next bar boundary
      expect(clearSpy).not.toHaveBeenCalled()

      clearSpy.mockRestore()
    })

    it('should clear old events and reschedule for non-timing changes during LOOP', async () => {
      seq.tempo(120).play(1, 0, 1, 0)
      await seq.loop()

      const scheduler = global.getScheduler()
      const clearSpy = vi.spyOn(scheduler, 'clearSequenceEvents')
      clearSpy.mockClear()

      seq.gain(-6)

      // Non-timing changes clear and reschedule immediately
      expect(clearSpy).toHaveBeenCalledWith('test')

      clearSpy.mockRestore()
    })
  })
})
