/**
 * Audio Engine Type Definitions
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 */

/**
 * Represents a slice of an audio file
 */
export interface AudioSlice {
  /** Audio buffer containing the slice data */
  buffer: AudioBuffer
  /** Start time of the slice within the original file (in seconds) */
  startTime: number
  /** Duration of the slice (in seconds) */
  duration: number
  /** 1-indexed slice number */
  sliceNumber: number
}

/**
 * Options for playing an audio slice
 */
export interface PlaySliceOptions {
  /** Tempo adjustment (1.0 = normal speed) */
  tempo?: number
  /** Pitch shift in semitones (not yet implemented) */
  pitch?: number
  /** When to start playing (audio context time in seconds) */
  startTime?: number
}

/**
 * Options for playing a sequence of slices
 */
export interface PlaySequenceOptions {
  /** Tempo adjustment (1.0 = normal speed) */
  tempo?: number
  /** Pitch shift in semitones (not yet implemented) */
  pitch?: number
  /** Whether to loop the sequence indefinitely */
  loop?: boolean
}

/**
 * Audio context initialization options
 */
export interface AudioContextOptions {
  /** Sample rate in Hz (default: 48000) */
  sampleRate?: number
  /** Latency hint ('interactive', 'balanced', or 'playback') */
  latencyHint?: AudioContextLatencyCategory
}
