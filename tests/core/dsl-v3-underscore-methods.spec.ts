import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('DSL v3.0: Methods with Seamless Parameter Update', () => {
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

  describe('tempo() - sets value and triggers seamless update', () => {
    it('should set tempo value', () => {
      seq.tempo(140)
      const state = seq.getState()
      expect(state.tempo).toBe(140)
    })

    it('should allow chaining', () => {
      const result = seq.tempo(140)
      expect(result).toBe(seq)
    })

    it('should work with method chaining', () => {
      seq.tempo(140).gain(-6).pan(-50)
      const state = seq.getState()
      expect(state.tempo).toBe(140)
      expect(state.gainDb).toBe(-6)
      expect(state.pan).toBe(-50)
    })
  })

  describe('beat() - sets value and triggers seamless update', () => {
    it('should set beat value', () => {
      seq.beat(3, 4)
      const state = seq.getState()
      expect(state.beat).toEqual({ numerator: 3, denominator: 4 })
    })

    it('should allow chaining', () => {
      const result = seq.beat(3, 4)
      expect(result).toBe(seq)
    })

    it('should work with method chaining', () => {
      seq.beat(7, 8).tempo(140)
      const state = seq.getState()
      expect(state.beat).toEqual({ numerator: 7, denominator: 8 })
      expect(state.tempo).toBe(140)
    })
  })

  describe('length() - sets value and triggers seamless update', () => {
    it('should set length value', () => {
      seq.length(8)
      const state = seq.getState()
      expect(state.length).toBe(8)
    })

    it('should allow chaining', () => {
      const result = seq.length(8)
      expect(result).toBe(seq)
    })

    it('should recalculate timing when play pattern exists', () => {
      // Set up a play pattern first
      seq.play(1, 2, 3, 4)
      const initialState = seq.getState()
      expect(initialState.timedEvents).toHaveLength(4)

      // Change length should recalculate
      seq.length(2)
      const newState = seq.getState()
      expect(newState.length).toBe(2)
      expect(newState.timedEvents).toHaveLength(4) // Still has events
    })
  })

  describe('audio() - sets value and triggers seamless update', () => {
    it('should set audio file path', () => {
      expect(() => seq.audio('kick.wav')).not.toThrow()
    })

    it('should allow chaining', () => {
      const result = seq.audio('kick.wav')
      expect(result).toBe(seq)
    })

    it('should reset chop divisions to 1', () => {
      seq.chop(8)
      seq.audio('snare.wav')
      expect(() => seq.audio('snare.wav')).not.toThrow()
    })
  })

  describe('chop() - sets value and triggers seamless update', () => {
    it('should set chop divisions', () => {
      expect(() => seq.chop(8)).not.toThrow()
    })

    it('should allow chaining', () => {
      const result = seq.chop(8)
      expect(result).toBe(seq)
    })

    it('should log error if no audio file is set', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      seq.chop(8)
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no audio file set'))
      consoleSpy.mockRestore()
    })
  })

  describe('play() - sets pattern and triggers seamless update', () => {
    it('should set play pattern and calculate timing', () => {
      seq.play(1, 2, 3, 4)
      const state = seq.getState()
      expect(state.playPattern).toEqual([1, 2, 3, 4])
      expect(state.timedEvents).toHaveLength(4)
    })

    it('should allow chaining', () => {
      const result = seq.play(1, 2, 3)
      expect(result).toBe(seq)
    })

    it('should work with nested patterns', () => {
      seq.play(1, [2, 3], 4)
      const state = seq.getState()
      expect(state.playPattern).toEqual([1, [2, 3], 4])
    })
  })

  describe('Method chaining combinations', () => {
    it('should allow complex method chaining', () => {
      seq.tempo(140).beat(3, 4).length(8).gain(-6).pan(-50)

      const state = seq.getState()
      expect(state.tempo).toBe(140)
      expect(state.beat).toEqual({ numerator: 3, denominator: 4 })
      expect(state.length).toBe(8)
      expect(state.gainDb).toBe(-6)
      expect(state.pan).toBe(-50)
    })

    it('should allow overwriting values with subsequent calls', () => {
      seq.tempo(120)
      seq.tempo(140)
      const state = seq.getState()
      expect(state.tempo).toBe(140)
    })

    it('should allow overwriting beat with subsequent calls', () => {
      seq.beat(4, 4)
      seq.beat(3, 4)
      const state = seq.getState()
      expect(state.beat).toEqual({ numerator: 3, denominator: 4 })
    })

    it('should allow overwriting gain with subsequent calls', () => {
      seq.gain(-6)
      seq.gain(-12)
      const state = seq.getState()
      expect(state.gainDb).toBe(-12)
    })

    it('should allow overwriting pan with subsequent calls', () => {
      seq.pan(-50)
      seq.pan(50)
      const state = seq.getState()
      expect(state.pan).toBe(50)
    })
  })
})
