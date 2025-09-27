import * as fs from 'fs'

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AudioContext } from 'node-web-audio-api'
import { WaveFile } from 'wavefile'

import { AudioFile } from '../../packages/engine/src/audio/audio-engine'

// Mock fs module
vi.mock('fs')

describe('Chop Default Behavior', () => {
  let audioContext: AudioContext
  let audioFile: AudioFile

  // Create a test WAV file
  const createTestWav = () => {
    const sampleRate = 48000
    const duration = 1 // 1 second
    const numSamples = sampleRate * duration
    const samples = new Float32Array(numSamples)

    // Generate a simple sine wave
    for (let i = 0; i < numSamples; i++) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5
    }

    const wav = new WaveFile()
    wav.fromScratch(1, sampleRate, '32f', samples)
    return Buffer.from(wav.toBuffer())
  }

  beforeEach(() => {
    audioContext = new AudioContext()

    // Mock fs.existsSync to return true
    vi.mocked(fs.existsSync).mockReturnValue(true)

    // Mock fs.readFileSync to return test WAV
    vi.mocked(fs.readFileSync).mockReturnValue(createTestWav())
  })

  it('should treat chop(1) as no division', async () => {
    audioFile = new AudioFile(audioContext, 'test.wav')
    await audioFile.load()

    const slices = audioFile.chop(1)

    expect(slices).toHaveLength(1)
    expect(slices[0].sliceNumber).toBe(1)
    expect(slices[0].startTime).toBe(0)
    // Duration should be the entire file
    expect(slices[0].duration).toBeGreaterThan(0)
  })

  it('should create equal slices with chop(n)', async () => {
    audioFile = new AudioFile(audioContext, 'test.wav')
    await audioFile.load()

    const slices = audioFile.chop(4)

    expect(slices).toHaveLength(4)

    // Check that slices are numbered 1-4
    expect(slices[0].sliceNumber).toBe(1)
    expect(slices[1].sliceNumber).toBe(2)
    expect(slices[2].sliceNumber).toBe(3)
    expect(slices[3].sliceNumber).toBe(4)

    // Check that slices have equal duration
    const sliceDuration = slices[0].duration
    expect(slices[1].duration).toBeCloseTo(sliceDuration)
    expect(slices[2].duration).toBeCloseTo(sliceDuration)
    expect(slices[3].duration).toBeCloseTo(sliceDuration)

    // Check that slices cover the entire file
    expect(slices[0].startTime).toBe(0)
    expect(slices[1].startTime).toBeCloseTo(sliceDuration)
    expect(slices[2].startTime).toBeCloseTo(sliceDuration * 2)
    expect(slices[3].startTime).toBeCloseTo(sliceDuration * 3)
  })

  it('should handle chop(1) for drum samples', async () => {
    // Simulating a kick drum sample
    audioFile = new AudioFile(audioContext, 'kick.wav')
    await audioFile.load()

    // Using chop(1) for a drum hit - entire sample is slice 1
    const slices = audioFile.chop(1)

    expect(slices).toHaveLength(1)
    expect(slices[0].sliceNumber).toBe(1)

    // In a play pattern like play(1, 0, 1, 0)
    // This would play: kick, silence, kick, silence
    const playPattern = [1, 0, 1, 0]
    const playableSlices = playPattern
      .map((num) => slices.find((s) => s.sliceNumber === num))
      .filter((s) => s !== undefined)

    // Should have 2 playable events (the 1s)
    expect(playableSlices).toHaveLength(2)
    expect(playableSlices[0]).toBe(slices[0])
    expect(playableSlices[1]).toBe(slices[0]) // Same slice played twice
  })

  it('should handle chop(8) for break slicing', async () => {
    // Simulating a drum break loop
    audioFile = new AudioFile(audioContext, 'break.wav')
    await audioFile.load()

    // Using chop(8) for slicing and rearrangement
    const slices = audioFile.chop(8)

    expect(slices).toHaveLength(8)

    // In a play pattern like play(1, 3, 2, 1, 5, 7, 0, 4)
    // This would rearrange the slices
    const playPattern = [1, 3, 2, 1, 5, 7, 0, 4]
    const playableSlices = playPattern.map((num) => slices.find((s) => s.sliceNumber === num))

    // Check the rearrangement
    expect(playableSlices[0]).toBe(slices[0]) // Slice 1
    expect(playableSlices[1]).toBe(slices[2]) // Slice 3
    expect(playableSlices[2]).toBe(slices[1]) // Slice 2
    expect(playableSlices[3]).toBe(slices[0]) // Slice 1 again
    expect(playableSlices[4]).toBe(slices[4]) // Slice 5
    expect(playableSlices[5]).toBe(slices[6]) // Slice 7
    expect(playableSlices[6]).toBeUndefined() // 0 = silence
    expect(playableSlices[7]).toBe(slices[3]) // Slice 4
  })
})
