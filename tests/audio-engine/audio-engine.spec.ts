import * as fs from 'fs'
import * as path from 'path'

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { AudioEngine } from '../../packages/engine/src/audio/audio-engine'

// Create a simple test WAV file
function createTestWavFile(filePath: string): void {
  // WAV file header for a simple sine wave
  const sampleRate = 48000
  const numChannels = 1
  const bitsPerSample = 16
  const duration = 1 // 1 second
  const numSamples = sampleRate * duration
  const frequency = 440 // A4 note

  // Generate sine wave samples
  const samples = new Int16Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const value = Math.sin(2 * Math.PI * frequency * t)
    samples[i] = value * 32767 // Convert to 16-bit integer
  }

  // Create WAV file buffer
  const bufferLength = 44 + samples.byteLength
  const buffer = Buffer.alloc(bufferLength)

  // Write WAV header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(bufferLength - 8, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // PCM format
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE((sampleRate * numChannels * bitsPerSample) / 8, 28) // byte rate
  buffer.writeUInt16LE((numChannels * bitsPerSample) / 8, 32) // block align
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.byteLength, 40)

  // Write samples
  const dataView = new DataView(buffer.buffer, buffer.byteOffset + 44)
  for (let i = 0; i < samples.length; i++) {
    dataView.setInt16(i * 2, samples[i], true) // little-endian
  }

  // Write file
  fs.writeFileSync(filePath, buffer)
}

describe('AudioEngine', () => {
  const testAudioPath = path.join(process.cwd(), 'test-audio.wav')
  let engine: AudioEngine

  beforeAll(() => {
    // Create test audio file
    createTestWavFile(testAudioPath)

    // Initialize engine
    engine = new AudioEngine()
  })

  afterAll(async () => {
    // Clean up test file
    if (fs.existsSync(testAudioPath)) {
      fs.unlinkSync(testAudioPath)
    }

    // Dispose engine
    if (engine) {
      await engine.dispose()
    }
  })

  describe('Basic functionality', () => {
    it('should initialize audio engine', () => {
      expect(engine).toBeDefined()
      expect(engine.getSampleRate()).toBe(48000)
    })

    it('should set master volume', () => {
      engine.setMasterVolume(0.5)
      // No error thrown
      expect(true).toBe(true)
    })

    it('should get current time', () => {
      const time = engine.getCurrentTime()
      expect(time).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Audio file loading', () => {
    it('should load WAV file', async () => {
      const audioFile = await engine.loadAudioFile(testAudioPath)
      expect(audioFile).toBeDefined()
      expect(audioFile.getBuffer()).not.toBeNull()
    })

    it('should throw error for non-existent file', async () => {
      await expect(engine.loadAudioFile('non-existent.wav')).rejects.toThrow('Audio file not found')
    })

    it('should throw error for unsupported format', async () => {
      const unsupportedPath = 'test.xyz'
      fs.writeFileSync(unsupportedPath, 'dummy')

      await expect(engine.loadAudioFile(unsupportedPath)).rejects.toThrow(
        'Unsupported audio format',
      )

      fs.unlinkSync(unsupportedPath)
    })
  })

  describe('Audio slicing', () => {
    it('should chop audio file into slices', async () => {
      const audioFile = await engine.loadAudioFile(testAudioPath)
      const slices = audioFile.chop(4)

      expect(slices).toHaveLength(4)
      expect(slices[0].sliceNumber).toBe(1)
      expect(slices[3].sliceNumber).toBe(4)
    })

    it('should get specific slice', async () => {
      const audioFile = await engine.loadAudioFile(testAudioPath)
      audioFile.chop(4)

      const slice = audioFile.getSlice(2)
      expect(slice).toBeDefined()
      expect(slice?.sliceNumber).toBe(2)
    })

    it('should calculate correct slice durations', async () => {
      const audioFile = await engine.loadAudioFile(testAudioPath)
      const slices = audioFile.chop(4)

      const totalDuration = slices.reduce((sum, s) => sum + s.duration, 0)
      const bufferDuration = audioFile.getBuffer()?.duration || 0

      // Total duration should match buffer duration (within small tolerance)
      expect(Math.abs(totalDuration - bufferDuration)).toBeLessThan(0.001)
    })
  })

  describe('Audio playback', () => {
    it('should play a slice', async () => {
      const audioFile = await engine.loadAudioFile(testAudioPath)
      const slices = audioFile.chop(4)

      const source = engine.playSlice(slices[0])
      expect(source).toBeDefined()

      // Stop the source to clean up
      source.stop()
    })

    it('should play with tempo adjustment', async () => {
      const audioFile = await engine.loadAudioFile(testAudioPath)
      const slices = audioFile.chop(4)

      const source = engine.playSlice(slices[0], { tempo: 2.0 })
      expect(source.playbackRate.value).toBe(2.0)

      source.stop()
    })

    it('should play a sequence', async () => {
      const audioFile = await engine.loadAudioFile(testAudioPath)
      const slices = audioFile.chop(4)

      // Play first two slices
      engine.playSequence([slices[0], slices[1]], { tempo: 2.0 })

      // No error thrown
      expect(true).toBe(true)
    })
  })

  describe('Transport controls', () => {
    it('should stop playback', () => {
      engine.stop()
      // No error thrown
      expect(true).toBe(true)
    })

    it('should resume playback', () => {
      engine.resume()
      // No error thrown
      expect(true).toBe(true)
    })
  })
})

describe('AudioFile', () => {
  // Note: These tests require AudioContext which is provided by node-web-audio-api
  // The actual AudioFile tests are covered in the AudioEngine tests above

  it('should be tested through AudioEngine', () => {
    expect(true).toBe(true)
  })
})
