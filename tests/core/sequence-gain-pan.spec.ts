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
    } as any

    global = new Global(mockPlayer)
    seq = new Sequence(global, mockPlayer)
  })

  describe('gain() method', () => {
    it('should set volume to 80', () => {
      seq.gain(80)
      const state = seq.getState()
      expect(state.volume).toBe(80)
    })

    it('should clamp volume to 0 minimum', () => {
      seq.gain(-50)
      const state = seq.getState()
      expect(state.volume).toBe(0)
    })

    it('should clamp volume to 100 maximum', () => {
      seq.gain(150)
      const state = seq.getState()
      expect(state.volume).toBe(100)
    })

    it('should allow chaining', () => {
      const result = seq.gain(80)
      expect(result).toBe(seq)
    })

    it('should have default volume of 80', () => {
      const state = seq.getState()
      expect(state.volume).toBe(80)
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
      seq.gain(80).pan(-50)
      const state = seq.getState()
      expect(state.volume).toBe(80)
      expect(state.pan).toBe(-50)
    })

    it('should allow pan().gain() chaining', () => {
      seq.pan(100).gain(60)
      const state = seq.getState()
      expect(state.volume).toBe(60)
      expect(state.pan).toBe(100)
    })

    it('should allow multiple updates', () => {
      seq.gain(80)
      seq.pan(-100)
      seq.gain(40)
      seq.pan(50)

      const state = seq.getState()
      expect(state.volume).toBe(40)
      expect(state.pan).toBe(50)
    })
  })
})
