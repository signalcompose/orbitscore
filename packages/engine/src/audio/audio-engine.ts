/**
 * Audio Engine for OrbitScore
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 *
 * This is a thin wrapper that maintains backward compatibility while
 * delegating to modular implementations.
 */

// Type exports
export type { AudioSlice, PlaySliceOptions, PlaySequenceOptions } from './types'

// Type imports for internal use
import type { AudioSlice, PlaySliceOptions, PlaySequenceOptions } from './types'

// Engine module imports
import {
  createAudioContext,
  getCurrentTime as getTime,
  getSampleRate as getRate,
  suspendContext,
  resumeContext,
  closeContext,
} from './engine/audio-context-manager'
import { createMasterGain, setMasterVolume as setVolume } from './engine/master-gain-controller'
import { loadAudioFile as loadFile } from './loading/audio-file-loader'
import { createSlices, getSlice as findSlice } from './slicing/slice-manager'
import { playSlice as playAudioSlice } from './playback/slice-player'
import { playSequence as playAudioSequence } from './playback/sequence-player'

/**
 * Audio file with slicing capability
 * Maintains backward compatibility with the original AudioFile class
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
    this.buffer = await loadFile(this.audioContext, this.filePath)
  }

  /**
   * Slice the audio file into equal parts
   */
  chop(numSlices: number): AudioSlice[] {
    if (!this.buffer) {
      throw new Error('Audio file not loaded')
    }

    this.slices = createSlices(this.buffer, numSlices)
    return this.slices
  }

  /**
   * Get a specific slice
   */
  getSlice(sliceNumber: number): AudioSlice | undefined {
    return findSlice(this.slices, sliceNumber)
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
 * Maintains backward compatibility with the original AudioEngine class
 */
export class AudioEngine {
  private audioContext: AudioContext
  private masterGain: GainNode
  private audioFiles: Map<string, AudioFile>
  private isPlaying: boolean = false

  constructor() {
    // Initialize audio context
    this.audioContext = createAudioContext({
      sampleRate: 48000,
      latencyHint: 'interactive',
    })

    // Create master gain node
    this.masterGain = createMasterGain(this.audioContext)

    // Create audio file cache (stores AudioFile instances)
    this.audioFiles = new Map<string, AudioFile>()
  }

  /**
   * Load an audio file
   * Uses cache to avoid reloading the same file
   */
  async loadAudioFile(filePath: string): Promise<AudioFile> {
    // Check cache first
    const cached = this.audioFiles.get(filePath)
    if (cached) {
      return cached
    }

    // Load and cache if not found
    const audioFile = new AudioFile(this.audioContext, filePath)
    await audioFile.load()

    // Store in cache
    this.audioFiles.set(filePath, audioFile)

    return audioFile
  }

  /**
   * Play an audio slice
   */
  playSlice(slice: AudioSlice, options: PlaySliceOptions = {}): AudioBufferSourceNode {
    return playAudioSlice(this.audioContext, this.masterGain, slice, options)
  }

  /**
   * Play a sequence of slices
   */
  playSequence(slices: AudioSlice[], options: PlaySequenceOptions = {}): void {
    playAudioSequence(this.audioContext, this.masterGain, slices, options)
  }

  /**
   * Stop all playback
   */
  stop(): void {
    // In a real implementation, we would track all active sources
    // and stop them individually
    this.isPlaying = false

    // Suspend audio context to stop all playback
    suspendContext(this.audioContext)
  }

  /**
   * Resume playback
   */
  resume(): void {
    resumeContext(this.audioContext)
    this.isPlaying = true
  }

  /**
   * Set master volume
   */
  setMasterVolume(volume: number): void {
    setVolume(this.masterGain, volume)
  }

  /**
   * Get current time
   */
  getCurrentTime(): number {
    return getTime(this.audioContext)
  }

  /**
   * Get sample rate
   */
  getSampleRate(): number {
    return getRate(this.audioContext)
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
    await closeContext(this.audioContext)
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
