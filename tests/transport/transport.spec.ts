import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Transport, TransportSequence } from '../../packages/engine/src/transport/transport'
import { AudioEngine } from '../../packages/engine/src/audio/audio-engine'

describe('Transport', () => {
  let transport: Transport
  let audioEngine: AudioEngine

  beforeEach(() => {
    audioEngine = new AudioEngine()
    transport = new Transport(audioEngine)

    // Mock console to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    transport.dispose()
    await audioEngine.dispose()
    vi.restoreAllMocks()
  })

  describe('Basic functionality', () => {
    it('should initialize with default settings', () => {
      const state = transport.getState()
      expect(state.isRunning).toBe(false)
      expect(state.tempo).toBe(120)
      expect(state.meter).toEqual({ numerator: 4, denominator: 4 })
      expect(state.position.bar).toBe(1)
      expect(state.position.beat).toBe(1)
    })

    it('should set tempo', () => {
      transport.setTempo(140)
      const state = transport.getState()
      expect(state.tempo).toBe(140)
    })

    it('should set meter', () => {
      transport.setMeter({ numerator: 5, denominator: 4 })
      const state = transport.getState()
      expect(state.meter).toEqual({ numerator: 5, denominator: 4 })
    })

    it('should clamp tempo to valid range', () => {
      transport.setTempo(10)
      expect(transport.getState().tempo).toBe(20)

      transport.setTempo(1000)
      expect(transport.getState().tempo).toBe(999)
    })
  })

  describe('Sequence management', () => {
    it('should add sequences', () => {
      const seq: TransportSequence = {
        id: 'seq1',
        slices: [],
        loop: false,
        muted: false,
        state: 'stopped',
      }

      transport.addSequence(seq)
      const state = transport.getState()
      expect(state.sequences).toHaveLength(1)
      expect(state.sequences[0].id).toBe('seq1')
    })

    it('should remove sequences', () => {
      const seq: TransportSequence = {
        id: 'seq1',
        slices: [],
        loop: false,
        muted: false,
        state: 'stopped',
      }

      transport.addSequence(seq)
      transport.removeSequence('seq1')

      const state = transport.getState()
      expect(state.sequences).toHaveLength(0)
    })

    it('should handle multiple sequences', () => {
      const seq1: TransportSequence = {
        id: 'seq1',
        slices: [],
        tempo: 140,
        loop: false,
        muted: false,
        state: 'stopped',
      }

      const seq2: TransportSequence = {
        id: 'seq2',
        slices: [],
        tempo: 120,
        meter: { numerator: 5, denominator: 4 },
        loop: false,
        muted: false,
        state: 'stopped',
      }

      transport.addSequence(seq1)
      transport.addSequence(seq2)

      const state = transport.getState()
      expect(state.sequences).toHaveLength(2)
      expect(state.sequences[0].tempo).toBe(140)
      expect(state.sequences[1].meter).toEqual({ numerator: 5, denominator: 4 })
    })
  })

  describe('Transport controls', () => {
    it('should start transport immediately', () => {
      transport.start(true)
      const state = transport.getState()
      expect(state.isRunning).toBe(true)
    })

    it('should stop transport', () => {
      transport.start(true)
      transport.stop(true)

      const state = transport.getState()
      expect(state.isRunning).toBe(false)
      expect(state.position.bar).toBe(1)
      expect(state.position.beat).toBe(1)
    })

    it('should schedule start at next bar', () => {
      transport.start(false)
      // Transport should not be running immediately
      const state = transport.getState()
      expect(state.isRunning).toBe(true) // But marked as running
    })
  })

  describe('Sequence controls', () => {
    let seq: TransportSequence

    beforeEach(() => {
      seq = {
        id: 'seq1',
        slices: [],
        loop: false,
        muted: false,
        state: 'stopped',
      }
      transport.addSequence(seq)
    })

    it('should start sequence immediately', () => {
      transport.startSequence('seq1', true)
      const state = transport.getState()
      expect(state.sequences[0].state).toBe('playing')
    })

    it('should schedule sequence start', () => {
      transport.startSequence('seq1', false)
      const state = transport.getState()
      expect(state.sequences[0].state).toBe('scheduled')
    })

    it('should stop sequence', () => {
      transport.startSequence('seq1', true)
      transport.stopSequence('seq1', true)

      const state = transport.getState()
      expect(state.sequences[0].state).toBe('stopped')
    })

    it('should mute sequence', () => {
      transport.muteSequence('seq1', true)
      const state = transport.getState()
      expect(state.sequences[0].muted).toBe(true)
    })

    it('should unmute sequence', () => {
      transport.muteSequence('seq1', true)
      transport.muteSequence('seq1', false)

      const state = transport.getState()
      expect(state.sequences[0].muted).toBe(false)
    })

    it('should not start muted sequence', () => {
      transport.muteSequence('seq1', true)
      transport.startSequence('seq1', true)

      const state = transport.getState()
      expect(state.sequences[0].state).toBe('stopped')
    })
  })

  describe('Looping', () => {
    it('should enable loop for all sequences', () => {
      const seq1: TransportSequence = {
        id: 'seq1',
        slices: [],
        loop: false,
        muted: false,
        state: 'stopped',
      }

      const seq2: TransportSequence = {
        id: 'seq2',
        slices: [],
        loop: false,
        muted: false,
        state: 'stopped',
      }

      transport.addSequence(seq1)
      transport.addSequence(seq2)

      transport.loop(undefined, true)

      const state = transport.getState()
      expect(state.sequences[0].loop).toBe(true)
      expect(state.sequences[1].loop).toBe(true)
    })

    it('should enable loop for specific sequences', () => {
      const seq1: TransportSequence = {
        id: 'seq1',
        slices: [],
        loop: false,
        muted: false,
        state: 'stopped',
      }

      const seq2: TransportSequence = {
        id: 'seq2',
        slices: [],
        loop: false,
        muted: false,
        state: 'stopped',
      }

      transport.addSequence(seq1)
      transport.addSequence(seq2)

      transport.loop(['seq1'], true)

      const state = transport.getState()
      expect(state.sequences[0].loop).toBe(true)
      expect(state.sequences[1].loop).toBe(false)
    })

    it('should start transport if not running when loop is called', () => {
      transport.loop(undefined, true)
      const state = transport.getState()
      expect(state.isRunning).toBe(true)
    })
  })

  describe('Position tracking', () => {
    it('should track current position', () => {
      const position = transport.getPosition()
      expect(position.bar).toBe(1)
      expect(position.beat).toBe(1)
      expect(position.tick).toBe(0)
      expect(position.absoluteTicks).toBe(0)
    })

    it('should jump to specific bar immediately', () => {
      transport.jumpToBar(5, true)
      const position = transport.getPosition()
      expect(position.bar).toBe(5)
      expect(position.beat).toBe(1)
      expect(position.tick).toBe(0)
    })

    it('should schedule jump to bar', () => {
      transport.jumpToBar(5, false)
      // Position should not change immediately
      const position = transport.getPosition()
      expect(position.bar).toBe(1)
    })
  })

  describe('Polymeter support', () => {
    it('should handle sequences with different meters', () => {
      const seq1: TransportSequence = {
        id: 'seq1',
        slices: [],
        meter: { numerator: 4, denominator: 4 },
        loop: false,
        muted: false,
        state: 'stopped',
      }

      const seq2: TransportSequence = {
        id: 'seq2',
        slices: [],
        meter: { numerator: 5, denominator: 4 },
        loop: false,
        muted: false,
        state: 'stopped',
      }

      transport.addSequence(seq1)
      transport.addSequence(seq2)

      const state = transport.getState()
      expect(state.sequences[0].meter).toEqual({ numerator: 4, denominator: 4 })
      expect(state.sequences[1].meter).toEqual({ numerator: 5, denominator: 4 })
    })

    it('should handle sequences with different tempos', () => {
      const seq1: TransportSequence = {
        id: 'seq1',
        slices: [],
        tempo: 120,
        loop: false,
        muted: false,
        state: 'stopped',
      }

      const seq2: TransportSequence = {
        id: 'seq2',
        slices: [],
        tempo: 140,
        loop: false,
        muted: false,
        state: 'stopped',
      }

      transport.addSequence(seq1)
      transport.addSequence(seq2)

      const state = transport.getState()
      expect(state.sequences[0].tempo).toBe(120)
      expect(state.sequences[1].tempo).toBe(140)
    })
  })
})
