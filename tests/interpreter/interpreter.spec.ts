import * as fs from 'fs'
import * as path from 'path'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Interpreter } from '../../packages/engine/src/interpreter/interpreter'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

// Create test WAV file
function createTestWav(filePath: string): void {
  const sampleRate = 48000
  const duration = 0.1 // Short duration for testing
  const numSamples = sampleRate * duration
  const samples = new Int16Array(numSamples)

  // Generate simple sine wave
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16383
  }

  const bufferLength = 44 + samples.byteLength
  const buffer = Buffer.alloc(bufferLength)

  // Write WAV header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(bufferLength - 8, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // Mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // Byte rate
  buffer.writeUInt16LE(2, 32) // Block align
  buffer.writeUInt16LE(16, 34) // Bits per sample
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.byteLength, 40)

  // Write samples
  const dataView = new DataView(buffer.buffer, buffer.byteOffset + 44)
  for (let i = 0; i < samples.length; i++) {
    dataView.setInt16(i * 2, samples[i], true)
  }

  fs.writeFileSync(filePath, buffer)
}

describe('Interpreter', () => {
  let interpreter: Interpreter
  const testAudioPath = path.join(process.cwd(), 'test-interpreter.wav')

  beforeEach(() => {
    interpreter = new Interpreter()
    createTestWav(testAudioPath)

    // Mock console.log to reduce noise in tests
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    if (interpreter) {
      await interpreter.dispose()
    }
    if (fs.existsSync(testAudioPath)) {
      fs.unlinkSync(testAudioPath)
    }
    vi.restoreAllMocks()
  })

  describe('Initialization', () => {
    it('should process global initialization', async () => {
      const source = 'var global = init GLOBAL'
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.global).toBeDefined()
      expect(state.global.tempo).toBe(120) // Default
    })

    it('should process sequence initialization', async () => {
      const source = `
        var seq1 = init GLOBAL.seq
        var seq2 = init GLOBAL.seq
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.sequences).toHaveLength(2)
      expect(state.sequences[0].name).toBe('seq1')
      expect(state.sequences[1].name).toBe('seq2')
    })
  })

  describe('Global parameters', () => {
    it('should set global tempo', async () => {
      const source = `
        var global = init GLOBAL
        global.tempo(140)
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.global.tempo).toBe(140)
    })

    it('should set global beat', async () => {
      const source = `
        var global = init GLOBAL
        global.beat(5 by 4)
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.global.beat).toEqual({ numerator: 5, denominator: 4 })
    })

    it('should set global key', async () => {
      const source = `
        var global = init GLOBAL
        global.key(G)
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.global.key).toBe('G')
    })
  })

  describe('Sequence configuration', () => {
    it('should set sequence tempo', async () => {
      const source = `
        var seq1 = init GLOBAL.seq
        seq1.tempo(130)
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.sequences[0].tempo).toBe(130)
    })

    it('should load and chop audio', async () => {
      const source = `
        var seq1 = init GLOBAL.seq
        seq1.audio("${testAudioPath}").chop(4)
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.sequences[0].slices).toHaveLength(4)
    })
  })

  describe('Play functionality', () => {
    it('should play simple slices', async () => {
      const source = `
        var seq1 = init GLOBAL.seq
        seq1.audio("${testAudioPath}").chop(4)
        seq1.play(1, 2, 3)
      `
      const ir = parseAudioDSL(source)

      // Execute should not throw
      await expect(interpreter.execute(ir)).resolves.not.toThrow()

      // Verify console.log was called with play message
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Playing seq1: slices [1, 2, 3]'),
      )
    })

    it('should handle nested play structures', async () => {
      const source = `
        var seq1 = init GLOBAL.seq
        seq1.audio("${testAudioPath}").chop(4)
        seq1.play((1)(2))
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Playing seq1: slices [1, 2]'),
      )
    })

    it('should handle modified play elements', async () => {
      const source = `
        var seq1 = init GLOBAL.seq
        seq1.audio("${testAudioPath}").chop(8)
        seq1.play(1.chop(2), 3.time(2))
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Playing seq1: slices [1, 3]'),
      )
    })
  })

  describe('Transport controls', () => {
    it('should start global transport', async () => {
      const source = `
        var global = init GLOBAL
        global.run()
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.global.isRunning).toBe(true)
    })

    it('should stop global transport', async () => {
      const source = `
        var global = init GLOBAL
        global.run()
        global.stop()
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.global.isRunning).toBe(false)
    })

    it('should mute and unmute sequences', async () => {
      const source = `
        var seq1 = init GLOBAL.seq
        seq1.mute()
      `
      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.sequences[0].isMuted).toBe(true)

      // Test unmute
      const unmuteSrc = 'seq1.unmute()'
      const unmuteIr = parseAudioDSL(unmuteSrc)
      await interpreter.execute(unmuteIr)

      const newState = interpreter.getState()
      expect(newState.sequences[0].isMuted).toBe(false)
    })
  })

  describe('Complete example', () => {
    it('should execute a full program', async () => {
      const source = `
        // Initialize
        var global = init GLOBAL
        var seq1 = init GLOBAL.seq
        var seq2 = init GLOBAL.seq
        
        // Configure global
        global.tempo(140)
        global.beat(4 by 4)
        
        // Configure sequences
        seq1.tempo(140)
        seq1.audio("${testAudioPath}").chop(16)
        
        seq2.tempo(120)
        seq2.audio("${testAudioPath}").chop(8)
        
        // Play patterns
        seq1.play(1, 2, 3, 4)
        seq2.play((1)(2))
        
        // Start transport
        global.run()
      `

      const ir = parseAudioDSL(source)
      await interpreter.execute(ir)

      const state = interpreter.getState()
      expect(state.global.isRunning).toBe(true)
      expect(state.global.tempo).toBe(140)
      expect(state.sequences).toHaveLength(2)
      expect(state.sequences[0].slices).toHaveLength(16)
      expect(state.sequences[1].slices).toHaveLength(8)
    })
  })
})
