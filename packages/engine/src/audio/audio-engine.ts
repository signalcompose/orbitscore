/**
 * Audio Engine for OrbitScore
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 *
 * This engine handles audio file loading, slicing, time-stretching,
 * pitch-shifting, and playback.
 */

import * as fs from 'fs'
import * as path from 'path'

// import { AudioContext, AudioBuffer, AudioBufferSourceNode, GainNode } from 'node-web-audio-api'
import { WaveFile } from 'wavefile'

/**
 * Represents a slice of an audio file
 */
export interface AudioSlice {
  buffer: AudioBuffer
  startTime: number // in seconds
  duration: number // in seconds
  sliceNumber: number
}

/**
 * Audio file with slicing capability
 */
export class AudioFile {
  private audioContext: AudioContext
  private buffer: AudioBuffer | null = null
  private slices: AudioSlice[] = []
  private filePath: string

  constructor(audioContext: AudioContext, filePath: string) {
    this.audioContext = audioContext
    this.filePath = filePath
  }

  /**
   * Load audio file into memory
   */
  async load(): Promise<void> {
    const fullPath = path.resolve(this.filePath)

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Audio file not found: ${fullPath}`)
    }

    const fileBuffer = fs.readFileSync(fullPath)

    // Determine file format and decode
    const ext = path.extname(fullPath).toLowerCase()

    if (ext === '.wav') {
      await this.loadWav(fileBuffer)
    } else if (ext === '.mp3' || ext === '.mp4' || ext === '.m4a') {
      // For MP3/MP4, we need additional decoding
      // For now, we'll throw an error - can be implemented later
      throw new Error(`Format ${ext} not yet implemented. Please use WAV files.`)
    } else if (ext === '.aiff' || ext === '.aif') {
      throw new Error(`Format ${ext} not yet implemented. Please use WAV files.`)
    } else {
      throw new Error(`Unsupported audio format: ${ext}`)
    }
  }

  /**
   * Load WAV file
   */
  private async loadWav(fileBuffer: Buffer): Promise<void> {
    const wav = new WaveFile(fileBuffer)

    // Get format info before conversion (cast to any for now, wavefile typings are incomplete)
    const fmt = wav.fmt as any
    const originalChannels = fmt.numChannels

    // Convert to standard format if needed
    wav.toBitDepth('32f') // Convert to 32-bit float
    wav.toSampleRate(48000) // Convert to 48kHz

    // Get audio data - returns interleaved samples for multi-channel
    const samples = wav.getSamples(false) as unknown as Float32Array

    // Get updated format info after conversion
    const sampleRate = (fmt.sampleRate || 48000) as number
    const numberOfChannels = (fmt.numChannels || originalChannels || 1) as number
    const samplesPerChannel = Math.floor(samples.length / numberOfChannels)

    // Create AudioBuffer
    this.buffer = this.audioContext.createBuffer(numberOfChannels, samplesPerChannel, sampleRate)

    // De-interleave and copy samples to buffer
    if (numberOfChannels === 1) {
      // Mono: direct copy
      // Ensure samples is a proper Float32Array
      const channelData = new Float32Array(samples.length)
      for (let i = 0; i < samples.length; i++) {
        channelData[i] = samples[i] || 0
      }
      this.buffer.copyToChannel(channelData, 0)
    } else {
      // Stereo or multi-channel: de-interleave
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = new Float32Array(samplesPerChannel)
        for (let i = 0; i < samplesPerChannel; i++) {
          channelData[i] = samples[i * numberOfChannels + channel] || 0
        }
        this.buffer.copyToChannel(channelData, channel)
      }
    }
  }

  /**
   * Slice the audio file into equal parts
   */
  chop(numSlices: number): AudioSlice[] {
    if (!this.buffer) {
      throw new Error('Audio file not loaded')
    }

    const totalDuration = this.buffer.duration
    const sliceDuration = totalDuration / numSlices

    this.slices = []

    for (let i = 0; i < numSlices; i++) {
      const startTime = i * sliceDuration

      this.slices.push({
        buffer: this.buffer,
        startTime,
        duration: sliceDuration,
        sliceNumber: i + 1, // 1-indexed
      })
    }

    return this.slices
  }

  /**
   * Get a specific slice
   */
  getSlice(sliceNumber: number): AudioSlice | undefined {
    return this.slices.find((s) => s.sliceNumber === sliceNumber)
  }

  /**
   * Get all slices
   */
  getSlices(): AudioSlice[] {
    return this.slices
  }

  /**
   * Get the audio buffer
   */
  getBuffer(): AudioBuffer | null {
    return this.buffer
  }
}

/**
 * Main Audio Engine
 */
export class AudioEngine {
  private audioContext: AudioContext
  private masterGain: GainNode
  private audioFiles: Map<string, AudioFile> = new Map()
  private isPlaying: boolean = false

  constructor() {
    // Initialize audio context with 48kHz sample rate
    this.audioContext = new AudioContext({
      sampleRate: 48000,
      latencyHint: 'interactive',
    })

    // Create master gain node
    this.masterGain = this.audioContext.createGain()
    this.masterGain.connect(this.audioContext.destination)
  }

  /**
   * Load an audio file
   */
  async loadAudioFile(filePath: string): Promise<AudioFile> {
    const audioFile = new AudioFile(this.audioContext, filePath)
    await audioFile.load()

    // Store in cache
    this.audioFiles.set(filePath, audioFile)

    return audioFile
  }

  /**
   * Play an audio slice
   */
  playSlice(
    slice: AudioSlice,
    options: {
      tempo?: number // Tempo adjustment (1.0 = normal)
      pitch?: number // Pitch shift in semitones
      startTime?: number // When to start playing (audio context time)
    } = {},
  ): AudioBufferSourceNode {
    const source = this.audioContext.createBufferSource()
    source.buffer = slice.buffer

    // Apply tempo adjustment (affects playback rate)
    if (options.tempo) {
      source.playbackRate.value = options.tempo
    }

    // Note: Pitch shifting without affecting tempo requires more complex processing
    // For now, playbackRate affects both tempo and pitch
    // True pitch shifting would require a pitch shift node or granular synthesis

    // Connect to master gain
    source.connect(this.masterGain)

    // Start playback
    const when = options.startTime || this.audioContext.currentTime
    source.start(when, slice.startTime, slice.duration)

    return source
  }

  /**
   * Play a sequence of slices
   */
  playSequence(
    slices: AudioSlice[],
    options: {
      tempo?: number
      pitch?: number
      loop?: boolean
    } = {},
  ): void {
    let currentTime = this.audioContext.currentTime

    for (const slice of slices) {
      this.playSlice(slice, {
        ...options,
        startTime: currentTime,
      })

      // Calculate next start time based on slice duration and tempo
      const adjustedDuration = slice.duration / (options.tempo || 1.0)
      currentTime += adjustedDuration
    }

    // Handle looping if requested
    if (options.loop) {
      const totalDuration = slices.reduce(
        (sum, slice) => sum + slice.duration / (options.tempo || 1.0),
        0,
      )

      // Schedule next iteration
      setTimeout(() => {
        this.playSequence(slices, options)
      }, totalDuration * 1000)
    }
  }

  /**
   * Stop all playback
   */
  stop(): void {
    // In a real implementation, we would track all active sources
    // and stop them individually
    this.isPlaying = false

    // Suspend audio context to stop all playback
    this.audioContext.suspend()
  }

  /**
   * Resume playback
   */
  resume(): void {
    this.audioContext.resume()
    this.isPlaying = true
  }

  /**
   * Set master volume
   */
  setMasterVolume(volume: number): void {
    this.masterGain.gain.value = Math.max(0, Math.min(1, volume))
  }

  /**
   * Get current time
   */
  getCurrentTime(): number {
    return this.audioContext.currentTime
  }

  /**
   * Get sample rate
   */
  getSampleRate(): number {
    return this.audioContext.sampleRate
  }

  /**
   * Get the audio context
   */
  getAudioContext(): AudioContext {
    return this.audioContext
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    await this.audioContext.close()
  }
}

/**
 * Time-stretching utilities
 * Note: True time-stretching requires advanced algorithms like PSOLA or phase vocoder
 * This is a placeholder for future implementation
 */
export class TimeStretch {
  /**
   * Apply time-stretch to audio buffer
   * @param buffer Original audio buffer
   * @param _stretchFactor Factor to stretch by (2.0 = twice as long)
   * @returns New stretched audio buffer
   */
  static stretch(buffer: AudioBuffer, _stretchFactor: number): AudioBuffer {
    // Placeholder: For now, just return the original buffer
    // Real implementation would use granular synthesis or PSOLA
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const factor = _stretchFactor // Will be used in future implementation
    console.warn('Time-stretching not yet implemented, returning original buffer')
    return buffer
  }
}

/**
 * Pitch-shifting utilities
 */
export class PitchShift {
  /**
   * Apply pitch shift to audio buffer
   * @param buffer Original audio buffer
   * @param _semitones Number of semitones to shift
   * @returns New pitch-shifted audio buffer
   */
  static shift(buffer: AudioBuffer, _semitones: number): AudioBuffer {
    // Placeholder: For now, just return the original buffer
    // Real implementation would use phase vocoder or granular synthesis
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const semitones = _semitones // Will be used in future implementation
    console.warn('Pitch-shifting not yet implemented, returning original buffer')
    return buffer
  }
}
