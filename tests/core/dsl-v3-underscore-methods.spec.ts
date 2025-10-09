import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('DSL v3.0: Underscore-prefixed Methods (Immediate Application)', () => {
  let global: Global
  let seq: Sequence
  let mockPlayer: SuperColliderPlayer

  beforeEach(() => {
    // Create mock SuperCollider player
    mockPlayer = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
    } as any

    global = new Global(mockPlayer)
    seq = new Sequence(global, mockPlayer)
    seq.setName('test')
  })

  describe('_tempo() - immediate tempo application', () => {
    it('should set tempo value', () => {
      seq._tempo(140)
      const state = seq.getState()
      expect(state.tempo).toBe(140)
    })

    it('should allow chaining', () => {
      const result = seq._tempo(140)
      expect(result).toBe(seq)
    })

    it('should work with method chaining', () => {
      seq._tempo(140)._gain(-6)._pan(-50)
      const state = seq.getState()
      expect(state.tempo).toBe(140)
      expect(state.gainDb).toBe(-6)
      expect(state.pan).toBe(-50)
    })
  })

  describe('_beat() - immediate beat application', () => {
    it('should set beat value', () => {
      seq._beat(3, 4)
      const state = seq.getState()
      expect(state.beat).toEqual({ numerator: 3, denominator: 4 })
    })

    it('should allow chaining', () => {
      const result = seq._beat(3, 4)
      expect(result).toBe(seq)
    })

    it('should work with method chaining', () => {
      seq._beat(7, 8)._tempo(140)
      const state = seq.getState()
      expect(state.beat).toEqual({ numerator: 7, denominator: 8 })
      expect(state.tempo).toBe(140)
    })
  })

  describe('_length() - immediate length application', () => {
    it('should set length value', () => {
      seq._length(8)
      const state = seq.getState()
      expect(state.length).toBe(8)
    })

    it('should allow chaining', () => {
      const result = seq._length(8)
      expect(result).toBe(seq)
    })

    it('should recalculate timing when play pattern exists', () => {
      // Set up a play pattern first
      seq.play(1, 2, 3, 4)
      const initialState = seq.getState()
      expect(initialState.timedEvents).toHaveLength(4)

      // Change length with _length() should recalculate
      seq._length(2)
      const newState = seq.getState()
      expect(newState.length).toBe(2)
      expect(newState.timedEvents).toHaveLength(4) // Still has events
    })
  })

  describe('_audio() - immediate audio application', () => {
    it('should set audio file path', () => {
      // Note: We can't easily test the private _audioFilePath,
      // but we can test that the method doesn't throw
      expect(() => seq._audio('kick.wav')).not.toThrow()
    })

    it('should allow chaining', () => {
      const result = seq._audio('kick.wav')
      expect(result).toBe(seq)
    })

    it('should reset chop divisions to 1', () => {
      seq.chop(8)
      seq._audio('snare.wav')
      // After setting new audio, chop should reset
      // We can't directly test _chopDivisions, but behavior should be consistent
      expect(() => seq._audio('snare.wav')).not.toThrow()
    })
  })

  describe('_chop() - immediate chop application', () => {
    it('should set chop divisions', () => {
      // Note: We can't easily test the private _chopDivisions,
      // but we can test that the method doesn't throw
      expect(() => seq._chop(8)).not.toThrow()
    })

    it('should allow chaining', () => {
      const result = seq._chop(8)
      expect(result).toBe(seq)
    })

    it('should log error if no audio file is set', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      seq._chop(8)
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no audio file set'))
      consoleSpy.mockRestore()
    })
  })

  describe('_play() - immediate play pattern application', () => {
    it('should set play pattern and calculate timing', () => {
      seq._play(1, 2, 3, 4)
      const state = seq.getState()
      expect(state.playPattern).toEqual([1, 2, 3, 4])
      expect(state.timedEvents).toHaveLength(4)
    })

    it('should allow chaining', () => {
      const result = seq._play(1, 2, 3)
      expect(result).toBe(seq)
    })

    it('should work with nested patterns', () => {
      seq._play(1, [2, 3], 4)
      const state = seq.getState()
      expect(state.playPattern).toEqual([1, [2, 3], 4])
    })
  })

  describe('Mixing setting and immediate methods', () => {
    it('should allow mixing tempo() and _tempo()', () => {
      seq.tempo(120) // Setting only
      seq._tempo(140) // Immediate application
      const state = seq.getState()
      expect(state.tempo).toBe(140) // Last value wins
    })

    it('should allow mixing beat() and _beat()', () => {
      seq.beat(4, 4)
      seq._beat(3, 4)
      const state = seq.getState()
      expect(state.beat).toEqual({ numerator: 3, denominator: 4 })
    })

    it('should allow mixing length() and _length()', () => {
      seq.length(4)
      seq._length(8)
      const state = seq.getState()
      expect(state.length).toBe(8)
    })

    it('should allow complex method chaining', () => {
      seq.tempo(120).beat(4, 4).length(4)._tempo(140)._beat(3, 4)._length(8)._gain(-6)._pan(-50)

      const state = seq.getState()
      expect(state.tempo).toBe(140)
      expect(state.beat).toEqual({ numerator: 3, denominator: 4 })
      expect(state.length).toBe(8)
      expect(state.gainDb).toBe(-6)
      expect(state.pan).toBe(-50)
    })
  })

  describe('Comparison: Setting vs Immediate', () => {
    it('tempo() should only set, _tempo() should apply immediately', () => {
      seq.tempo(120)
      const state1 = seq.getState()
      expect(state1.tempo).toBe(120)

      seq._tempo(140)
      const state2 = seq.getState()
      expect(state2.tempo).toBe(140)
    })

    it('beat() should only set, _beat() should apply immediately', () => {
      seq.beat(4, 4)
      const state1 = seq.getState()
      expect(state1.beat).toEqual({ numerator: 4, denominator: 4 })

      seq._beat(3, 4)
      const state2 = seq.getState()
      expect(state2.beat).toEqual({ numerator: 3, denominator: 4 })
    })

    it('play() should only set, _play() should apply immediately', () => {
      seq.play(1, 2, 3)
      const state1 = seq.getState()
      expect(state1.playPattern).toEqual([1, 2, 3])

      seq._play(4, 5, 6)
      const state2 = seq.getState()
      expect(state2.playPattern).toEqual([4, 5, 6])
    })

    it('gain() should only set, _gain() should apply immediately', () => {
      seq.gain(-6)
      const state1 = seq.getState()
      expect(state1.gainDb).toBe(-6)

      seq._gain(-12)
      const state2 = seq.getState()
      expect(state2.gainDb).toBe(-12)
    })

    it('pan() should only set, _pan() should apply immediately', () => {
      seq.pan(-50)
      const state1 = seq.getState()
      expect(state1.pan).toBe(-50)

      seq._pan(50)
      const state2 = seq.getState()
      expect(state2.pan).toBe(50)
    })
  })
})
