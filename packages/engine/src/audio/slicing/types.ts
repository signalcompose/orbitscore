/**
 * Type definitions for audio slicing
 */

/**
 * Information about a single audio slice
 */
export interface AudioSliceInfo {
  /** Slice number (1-based) */
  sliceNumber: number
  /** Path to the slice file */
  filepath: string
  /** Start sample index in original file */
  startSample: number
  /** End sample index in original file */
  endSample: number
  /** Duration of slice in milliseconds */
  duration: number
}

/**
 * Audio file properties extracted from WAV file
 */
export interface AudioProperties {
  /** Sample rate (e.g., 44100 Hz) */
  sampleRate: number
  /** Number of channels (1 = mono, 2 = stereo) */
  numChannels: number
  /** Bit depth (e.g., '16', '24', '32f') */
  bitDepth: string
  /** Total number of samples per channel */
  totalSamples: number
  /** All samples (interleaved for multi-channel) */
  samples: Float32Array
}
