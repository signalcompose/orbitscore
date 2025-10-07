/**
 * Type definitions for timing calculation
 */

/**
 * Represents a scheduled playback event
 */
export interface TimedEvent {
  sliceNumber: number // 0 for silence, 1-n for slice
  startTime: number // Start time in milliseconds relative to bar start
  duration: number // Duration in milliseconds
  depth: number // Nesting depth (for debugging)
}
