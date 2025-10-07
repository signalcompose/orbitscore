/**
 * Audio type definitions
 * Maintained for backward compatibility
 */

/**
 * Audio slice interface
 * Note: SuperCollider uses file paths and slice numbers directly,
 * but this interface is kept for backward compatibility with the Sequence API
 */
export interface AudioSlice {
  /** Slice number (0-based) */
  sliceNumber: number
  /** Start time in seconds */
  startTime: number
  /** Duration in seconds */
  duration: number
  /** File path (for SuperCollider) */
  filepath?: string
}

/**
 * Play slice options
 */
export interface PlaySliceOptions {
  /** Tempo adjustment factor (default: 1.0) */
  tempo?: number
  /** Pitch shift in semitones */
  pitch?: number
  /** Start time for scheduling */
  startTime?: number
}

/**
 * Play sequence options
 */
export interface PlaySequenceOptions {
  /** Tempo adjustment factor (default: 1.0) */
  tempo?: number
  /** Pitch shift in semitones */
  pitch?: number
  /** Whether to loop the sequence */
  loop?: boolean
}
