import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('Sequence - gain() and pan()', () => {
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
  })

  describe('gain() method (dB unit)', () => {
    it('should set gain to 0 dB (default, 100%)', () => {
      seq.gain(0)
      const state = seq.getState()
      expect(state.gainDb).toBe(0)
    })

    it('should set gain to -6 dB (~50%)', () => {
      seq.gain(-6)
      const state = seq.getState()
      expect(state.gainDb).toBe(-6)
    })

    it('should set gain to -12 dB (~25%)', () => {
      seq.gain(-12)
      const state = seq.getState()
      expect(state.gainDb).toBe(-12)
    })

    it('should accept decimal dB values like -3.5', () => {
      seq.gain(-3.5)
      const state = seq.getState()
      expect(state.gainDb).toBe(-3.5)
    })

    it('should clamp gain to -60 dB minimum', () => {
      seq.gain(-100)
      const state = seq.getState()
      expect(state.gainDb).toBe(-60)
    })

    it('should clamp gain to +12 dB maximum', () => {
      seq.gain(20)
      const state = seq.getState()
      expect(state.gainDb).toBe(12)
    })

    it('should accept -Infinity for complete silence', () => {
      seq.gain(-Infinity)
      const state = seq.getState()
      expect(state.gainDb).toBe(-Infinity)
    })

    it('should allow positive gain (boost)', () => {
      seq.gain(6)
      const state = seq.getState()
      expect(state.gainDb).toBe(6)
    })

    it('should allow chaining', () => {
      const result = seq.gain(-6)
      expect(result).toBe(seq)
    })

    it('should have default gain of 0 dB', () => {
      const state = seq.getState()
      expect(state.gainDb).toBe(0)
    })
  })

  describe('pan() method', () => {
    it('should set pan to -100 (full left)', () => {
      seq.pan(-100)
      const state = seq.getState()
      expect(state.pan).toBe(-100)
    })

    it('should set pan to 0 (center)', () => {
      seq.pan(0)
      const state = seq.getState()
      expect(state.pan).toBe(0)
    })

    it('should set pan to 100 (full right)', () => {
      seq.pan(100)
      const state = seq.getState()
      expect(state.pan).toBe(100)
    })

    it('should clamp pan to -100 minimum', () => {
      seq.pan(-200)
      const state = seq.getState()
      expect(state.pan).toBe(-100)
    })

    it('should clamp pan to 100 maximum', () => {
      seq.pan(200)
      const state = seq.getState()
      expect(state.pan).toBe(100)
    })

    it('should allow chaining', () => {
      const result = seq.pan(-50)
      expect(result).toBe(seq)
    })

    it('should have default pan of 0 (center)', () => {
      const state = seq.getState()
      expect(state.pan).toBe(0)
    })
  })

  describe('Chaining gain() and pan()', () => {
    it('should allow gain().pan() chaining', () => {
      seq.gain(-6).pan(-50)
      const state = seq.getState()
      expect(state.gainDb).toBe(-6)
      expect(state.pan).toBe(-50)
    })

    it('should allow pan().gain() chaining', () => {
      seq.pan(100).gain(-12)
      const state = seq.getState()
      expect(state.gainDb).toBe(-12)
      expect(state.pan).toBe(100)
    })

    it('should allow multiple updates', () => {
      seq.gain(-3)
      seq.pan(-100)
      seq.gain(-9)
      seq.pan(50)

      const state = seq.getState()
      expect(state.gainDb).toBe(-9)
      expect(state.pan).toBe(50)
    })
  })

  describe('DSL v3.0: Setting vs Immediate Application', () => {
    it('gain() should set value without immediate application', () => {
      seq.gain(-6)
      const state = seq.getState()
      expect(state.gainDb).toBe(-6)
    })

    it('pan() should set value without immediate application', () => {
      seq.pan(-50)
      const state = seq.getState()
      expect(state.pan).toBe(-50)
    })

    it('_gain() should set value with immediate application', () => {
      seq._gain(-12)
      const state = seq.getState()
      expect(state.gainDb).toBe(-12)
    })

    it('_pan() should set value with immediate application', () => {
      seq._pan(30)
      const state = seq.getState()
      expect(state.pan).toBe(30)
    })

    it('should allow mixing setting and immediate methods', () => {
      seq.gain(-6).pan(-50)._gain(-12)._pan(30)
      const state = seq.getState()
      expect(state.gainDb).toBe(-12)
      expect(state.pan).toBe(30)
    })

    it('_gain() should allow chaining', () => {
      const result = seq._gain(-6)
      expect(result).toBe(seq)
    })

    it('_pan() should allow chaining', () => {
      const result = seq._pan(-50)
      expect(result).toBe(seq)
    })
  })
})
