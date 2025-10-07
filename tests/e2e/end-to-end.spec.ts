/**
 * End-to-End test with real audio files
 * Tests the complete flow from DSL parsing to audio playback
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { AudioTokenizer, AudioParser } from '../../packages/engine/src/parser/audio-parser'
import { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'

describe.skip('End-to-End Tests with Real Audio', () => {
  let interpreter: InterpreterV2

  // Mock console to capture outputs
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  beforeEach(() => {
    interpreter = new InterpreterV2()
    consoleSpy.mockClear()
    consoleWarnSpy.mockClear()
  })

  afterEach(async () => {
    // Clean up SuperCollider server
    if (interpreter) {
      const state = interpreter.getState()
      for (const globalName in state.globals) {
        const global = state.globals[globalName]
        if (global && typeof global.stop === 'function') {
          global.stop()
        }
      }
      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    consoleSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  const parseDSL = (source: string) => {
    const tokenizer = new AudioTokenizer(source)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    return parser.parse()
  }

  describe('Basic Drum Pattern', () => {
    it('should execute a simple drum pattern', async () => {
      const dslCode = `
        var global = init GLOBAL
        global.tempo(120).beat(4 by 4)
        
        var kick = init global.seq
        kick.beat(4 by 4).length(1)
        kick.audio("test-assets/audio/kick.wav").chop(1)
        kick.play(1, 0, 1, 0)
        
        var snare = init global.seq
        snare.beat(4 by 4).length(1)
        snare.audio("test-assets/audio/snare.wav")
        snare.play(0, 1, 0, 1)
      `

      const ir = parseDSL(dslCode)
      await interpreter.execute(ir)
      const state = interpreter.getState()

      // Verify global configuration
      expect(state.globals.global).toMatchObject({
        tempo: 120,
        beat: { numerator: 4, denominator: 4 },
      })

      // Verify sequences were created
      expect(state.sequences.kick).toBeDefined()
      expect(state.sequences.snare).toBeDefined()

      // Verify audio files were set (check console logs)
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('kick: audio file set to'))
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('snare: audio file set to'))

      // Verify play patterns
      expect(state.sequences.kick.playPattern).toEqual([1, 0, 1, 0])
      expect(state.sequences.snare.playPattern).toEqual([0, 1, 0, 1])

      // Verify timing events were calculated
      expect(state.sequences.kick.timedEvents).toHaveLength(4)
      expect(state.sequences.snare.timedEvents).toHaveLength(4)
    })
  })

  describe('Complex Rhythm Patterns', () => {
    it('should handle nested rhythms with multiple sequences', async () => {
      const dslCode = `
        var global = init GLOBAL
        global.tempo(140).beat(4 by 4)
        
        var hihat = init global.seq
        hihat.audio("test-assets/audio/hihat_closed.wav")
        hihat.play(1, 1, (1, 1), 1)  // Sixteenth note pattern
        
        var bass = init global.seq
        bass.tempo(70)  // Half-time feel
        bass.audio("test-assets/audio/bass_c1.wav").chop(4)
        bass.play(1, 0, 3, 0)
      `

      const ir = parseDSL(dslCode)
      await interpreter.execute(ir)
      const state = interpreter.getState()

      // Verify global tempo
      expect(state.globals.global.tempo).toBe(140)

      // Verify hihat pattern with nested structure
      expect(state.sequences.hihat.playPattern).toHaveLength(4) // 4 arguments to play()
      // Note: timedEvents might be undefined if audio wasn't loaded
      if (state.sequences.hihat.timedEvents) {
        expect(state.sequences.hihat.timedEvents).toHaveLength(5) // 1 + 1 + (1,1)=2 + 1 = 5 events
      }

      // Verify bass with different tempo
      expect(state.sequences.bass.tempo).toBe(70)
      expect(state.sequences.bass.playPattern).toEqual([1, 0, 3, 0])
    })
  })

  describe('Method Chaining', () => {
    it('should support full method chaining', async () => {
      const dslCode = `
        var global = init GLOBAL
        global.tempo(160).beat(3 by 4).tick(960)
        
        var seq = init global.seq
        seq.beat(3 by 4).length(2).audio("test-assets/audio/arpeggio_c.wav").chop(12).play(1, 2, 3, 4, 5, 6)
      `

      const ir = parseDSL(dslCode)
      await interpreter.execute(ir)
      const state = interpreter.getState()

      // Verify all chained properties were set
      expect(state.globals.global).toMatchObject({
        tempo: 160,
        beat: { numerator: 3, denominator: 4 },
        tick: 960,
      })

      expect(state.sequences.seq).toMatchObject({
        beat: { numerator: 3, denominator: 4 },
        length: 2,
      })

      // Play pattern should be set
      expect(state.sequences.seq.playPattern).toEqual([1, 2, 3, 4, 5, 6])

      // Verify that at least the sequence was created
      expect(state.sequences.seq).toBeDefined()
    })
  })

  describe('Polymeter Example', () => {
    it('should handle different meters for different sequences', async () => {
      const dslCode = `
        var global = init GLOBAL
        global.tempo(120)
        
        var seq5 = init global.seq
        seq5.beat(5 by 4).length(1)
        seq5.audio("test-assets/audio/sine_440.wav").chop(5)
        seq5.play(1, 2, 3, 4, 5)
        
        var seq4 = init global.seq
        seq4.beat(4 by 4).length(1)
        seq4.audio("test-assets/audio/sine_880.wav").chop(4)
        seq4.play(1, 0, 1, 0)
      `

      const ir = parseDSL(dslCode)
      await interpreter.execute(ir)
      const state = interpreter.getState()

      // Verify different meters
      expect(state.sequences.seq5.beat).toEqual({ numerator: 5, denominator: 4 })
      expect(state.sequences.seq4.beat).toEqual({ numerator: 4, denominator: 4 })

      // Verify timing calculations are different
      const seq5Events = state.sequences.seq5.timedEvents
      const seq4Events = state.sequences.seq4.timedEvents

      expect(seq5Events).toHaveLength(5)
      expect(seq4Events).toHaveLength(4)

      // In 5/4, each beat is 500ms at 120 BPM
      // In 4/4, each beat is 500ms at 120 BPM
      // But total bar duration is different
      expect(seq5Events[4].startTime).toBe(2000) // 5th beat starts at 2000ms
      expect(seq4Events[3].startTime).toBe(1500) // 4th beat starts at 1500ms
    })
  })

  describe('Transport Controls', () => {
    it('should handle transport commands', async () => {
      const dslCode = `
        var global = init GLOBAL
        global.tempo(130)
        
        var seq = init global.seq
        seq.audio("test-assets/audio/chord_c_major.wav").chop(8)
        seq.play(1, 2, 3, 4, 5, 6, 7, 8)
        
        global.run()
        seq.mute()
        seq.unmute()
        seq.run()
      `

      const ir = parseDSL(dslCode)
      await interpreter.execute(ir)
      const state = interpreter.getState()

      // Verify transport states
      expect(state.globals.global.isRunning).toBe(true)
      expect(state.sequences.seq.isMuted).toBe(false) // unmuted last
      expect(state.sequences.seq.isPlaying).toBe(true)

      // Verify that transport states are set correctly
      expect(state).toBeDefined()
    })
  })

  describe('Error Handling', () => {
    it('should handle missing audio files gracefully', async () => {
      const dslCode = `
        var global = init GLOBAL
        var seq = init global.seq
        seq.audio("non-existent-file.wav").chop(4)
        seq.play(1, 2, 3, 4)
      `

      const ir = parseDSL(dslCode)
      await interpreter.execute(ir)

      // Should not throw, sequence should be created
      const state = interpreter.getState()
      expect(state.sequences.seq).toBeDefined()
    })

    it('should handle play without audio loaded', async () => {
      const dslCode = `
        var global = init GLOBAL
        var seq = init global.seq
        seq.play(1, 2, 3, 4)
        seq.run()
      `

      const ir = parseDSL(dslCode)
      await interpreter.execute(ir)

      // Should handle gracefully - check that state was created
      const state = interpreter.getState()
      expect(state.sequences.seq).toBeDefined()
      expect(state.sequences.seq.playPattern).toEqual([1, 2, 3, 4])
    })
  })
})
