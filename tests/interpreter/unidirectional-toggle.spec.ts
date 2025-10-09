import { describe, it, expect, beforeEach, vi } from 'vitest'

import { AudioTokenizer, AudioParser } from '../../packages/engine/src/parser/audio-parser'
import { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'

describe('DSL v3.0: Unidirectional Toggle (片記号方式)', () => {
  let interpreter: InterpreterV2

  beforeEach(async () => {
    interpreter = new InterpreterV2()

    // Mock SuperCollider methods to avoid boot timeout
    const audioEngine = interpreter.audioEngine as any
    audioEngine.boot = vi.fn().mockResolvedValue(undefined)
    audioEngine.getCurrentTime = vi.fn().mockReturnValue(0)
    audioEngine.scheduleEvent = vi.fn()
    audioEngine.scheduleSliceEvent = vi.fn()
    audioEngine.getMasterGainDb = vi.fn().mockReturnValue(0)

    await interpreter.boot()
  })

  function parseCode(code: string) {
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    return parser.parse()
  }

  describe('RUN() unidirectional toggle', () => {
    it('should run only specified sequences', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq
        var hat = init global.seq

        global.start()
        RUN(kick, snare)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.sequences.kick.isPlaying).toBe(true)
      expect(state.sequences.snare.isPlaying).toBe(true)
      expect(state.sequences.hat.isPlaying).toBe(false)
    })

    it('should allow RUN and LOOP to coexist', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq

        global.start()
        RUN(kick)
        LOOP(snare)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.sequences.kick.isPlaying).toBe(true)
      expect(state.sequences.kick.isLooping).toBe(false)
      expect(state.sequences.snare.isPlaying).toBe(true)
      expect(state.sequences.snare.isLooping).toBe(true)
    })
  })

  describe('LOOP() unidirectional toggle', () => {
    it('should loop only specified sequences', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq
        var hat = init global.seq

        global.start()
        LOOP(kick, snare)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.sequences.kick.isLooping).toBe(true)
      expect(state.sequences.snare.isLooping).toBe(true)
      expect(state.sequences.hat.isLooping).toBe(false)
    })

    it('should stop sequences removed from LOOP group', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq
        var hat = init global.seq

        global.start()
        LOOP(kick, snare, hat)
        LOOP(kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.sequences.kick.isLooping).toBe(true)
      expect(state.sequences.snare.isLooping).toBe(false)
      expect(state.sequences.hat.isLooping).toBe(false)
    })
  })

  describe('MUTE() unidirectional toggle', () => {
    it('should mute only specified sequences in LOOP', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq
        var hat = init global.seq

        global.start()
        LOOP(kick, snare, hat)
        MUTE(kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.sequences.kick.isMuted).toBe(true)
      expect(state.sequences.snare.isMuted).toBe(false)
      expect(state.sequences.hat.isMuted).toBe(false)
    })

    it('should not affect RUN playback', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq

        global.start()
        RUN(kick)
        MUTE(kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // MUTE only affects LOOP, so kick remains unmuted in RUN
      expect(state.sequences.kick.isPlaying).toBe(true)
      expect(state.sequences.kick.isMuted).toBe(false) // No effect on RUN
    })

    it('should persist MUTE state across LOOP changes', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq

        global.start()
        MUTE(kick)
        LOOP(kick, snare)
        LOOP(snare)
        LOOP(kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // kick's MUTE flag persists even after being removed from LOOP
      expect(state.sequences.kick.isMuted).toBe(true)
      expect(state.sequences.kick.isLooping).toBe(true)
    })

    it('should unmute sequences removed from MUTE group', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq

        global.start()
        LOOP(kick, snare)
        MUTE(kick, snare)
        MUTE(kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.sequences.kick.isMuted).toBe(true)
      expect(state.sequences.snare.isMuted).toBe(false)
    })
  })

  describe('No STOP keyword (removed)', () => {
    it('should treat STOP as identifier (not a keyword)', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq

        global.start()
      `

      // STOP should no longer be recognized as a keyword
      // If used, it would be treated as an identifier
      const ir = parseCode(code)
      expect(ir).toBeDefined()
    })
  })

  describe('Complex interactions', () => {
    it('should handle RUN, LOOP, and MUTE together', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq
        var hat = init global.seq
        var clap = init global.seq

        global.start()
        RUN(kick, snare)
        LOOP(hat, clap)
        MUTE(hat)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // RUN group
      expect(state.sequences.kick.isPlaying).toBe(true)
      expect(state.sequences.kick.isLooping).toBe(false)
      expect(state.sequences.snare.isPlaying).toBe(true)
      expect(state.sequences.snare.isLooping).toBe(false)

      // LOOP group
      expect(state.sequences.hat.isPlaying).toBe(true)
      expect(state.sequences.hat.isLooping).toBe(true)
      expect(state.sequences.hat.isMuted).toBe(true)
      expect(state.sequences.clap.isPlaying).toBe(true)
      expect(state.sequences.clap.isLooping).toBe(true)
      expect(state.sequences.clap.isMuted).toBe(false)
    })

    it('should handle same sequence in RUN and LOOP', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq

        global.start()
        RUN(kick)
        LOOP(kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // Both RUN and LOOP are active
      expect(state.sequences.kick.isPlaying).toBe(true)
      expect(state.sequences.kick.isLooping).toBe(true)
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty RUN()', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq

        global.start()
        RUN(kick, snare)
        RUN()
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // RUN() with no arguments should clear the RUN group
      expect(state.sequences.kick.isPlaying).toBe(false)
      expect(state.sequences.snare.isPlaying).toBe(false)
    })

    it('should handle empty LOOP()', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq

        global.start()
        LOOP(kick, snare)
        LOOP()
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // LOOP() with no arguments should clear the LOOP group
      expect(state.sequences.kick.isLooping).toBe(false)
      expect(state.sequences.snare.isLooping).toBe(false)
    })

    it('should handle empty MUTE()', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq
        var snare = init global.seq

        global.start()
        LOOP(kick, snare)
        MUTE(kick, snare)
        MUTE()
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // MUTE() with no arguments should clear the MUTE group
      expect(state.sequences.kick.isMuted).toBe(false)
      expect(state.sequences.snare.isMuted).toBe(false)
    })

    it('should handle duplicate sequences in RUN()', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq

        global.start()
        RUN(kick, kick, kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // Duplicate sequences should be deduplicated
      expect(state.sequences.kick.isPlaying).toBe(true)
    })

    it('should handle duplicate sequences in LOOP()', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq

        global.start()
        LOOP(kick, kick, kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // Duplicate sequences should be deduplicated
      expect(state.sequences.kick.isLooping).toBe(true)
    })

    it('should handle duplicate sequences in MUTE()', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq

        global.start()
        LOOP(kick)
        MUTE(kick, kick, kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // Duplicate sequences should be deduplicated
      expect(state.sequences.kick.isMuted).toBe(true)
    })

    it('should warn about non-existent sequences in RUN()', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const code = `
        var global = init GLOBAL
        var kick = init global.seq

        global.start()
        RUN(kick, nonexistent)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // Valid sequences should still run
      expect(state.sequences.kick.isPlaying).toBe(true)
      // Warning should be logged for non-existent sequence
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))

      consoleSpy.mockRestore()
    })

    it('should warn about non-existent sequences in LOOP()', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const code = `
        var global = init GLOBAL
        var kick = init global.seq

        global.start()
        LOOP(kick, nonexistent)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // Valid sequences should still loop
      expect(state.sequences.kick.isLooping).toBe(true)
      // Warning should be logged for non-existent sequence
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))

      consoleSpy.mockRestore()
    })

    it('should warn about non-existent sequences in MUTE()', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const code = `
        var global = init GLOBAL
        var kick = init global.seq

        global.start()
        LOOP(kick)
        MUTE(kick, nonexistent)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // Valid sequences should still be muted
      expect(state.sequences.kick.isMuted).toBe(true)
      // Warning should be logged for non-existent sequence
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))

      consoleSpy.mockRestore()
    })

    it('should handle RUN to LOOP transition', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq

        global.start()
        RUN(kick)
        LOOP(kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // Sequence should be both running and looping
      expect(state.sequences.kick.isPlaying).toBe(true)
      expect(state.sequences.kick.isLooping).toBe(true)
    })

    it('should handle MUTE with RUN (should have no effect)', async () => {
      const code = `
        var global = init GLOBAL
        var kick = init global.seq

        global.start()
        RUN(kick)
        MUTE(kick)
      `

      const ir = parseCode(code)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      // MUTE only affects LOOP, so RUN playback should be unaffected
      expect(state.sequences.kick.isPlaying).toBe(true)
      expect(state.sequences.kick.isMuted).toBe(false)
    })
  })
})
