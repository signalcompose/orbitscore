/**
 * Type definitions for timing calculation
 */

import { SymbolicPitch } from '../../midi/types'

/**
 * Represents a scheduled playback event.
 *
 * The rhythm tree (`(...)` nesting) determines `startTime` / `duration` for
 * both audio and MIDI; the *value* differs by domain — a slice number for
 * audio, a degree for MIDI. Per §7-0, MIDI events carry the unresolved
 * {@link SymbolicPitch} here and are numbered to a MIDI note only at the
 * output adapter's final stage.
 */
export interface TimedEvent {
  sliceNumber: number // 0 for silence, 1-n for slice (audio); = degree as a fallback for pitched MIDI events
  startTime: number // Start time in milliseconds relative to bar start
  duration: number // Duration in milliseconds
  depth: number // Nesting depth (for debugging)
  /**
   * §7-0: the symbolic pitch for MIDI events (degree / alteration / octave
   * shift / detune), preserved unresolved. Absent for plain audio slice
   * events. Resolution to a MIDI note number happens at the output stage,
   * using the sequence's root context.
   */
  pitch?: SymbolicPitch
}
