/**
 * Type definitions for timing calculation
 */

import { SymbolicPitch } from '../../midi/types'
import { ScopeRoot, ScopeMode } from '../../parser/types'

/**
 * The lexical pitch scope (§2.3, §3) resolved for a MIDI event during the
 * timing walk — the nearest enclosing `.root()`/`.mode()` (one axis) and the
 * nearest enclosing `.oct()` (independent axis). Resolved to a RootContext /
 * octave offset at the output stage. Absent = sequence default.
 */
export interface TimedEventScope {
  root?: ScopeRoot
  mode?: ScopeMode
  groupOct?: number
  hold?: boolean // §5.3 group-level `.hold()` — auto common-tone tie between stacks
}

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
  /**
   * Phase 2 (§3): the lexical group scope (`.root()`/`.mode()`/`.oct()`) in
   * effect for this event, resolved inner→outer during the timing walk. Absent
   * = sequence default. Consumed at the output stage to build the RootContext
   * and the group-octave offset (independent of the sticky `^N` running range).
   */
  scope?: TimedEventScope
  /**
   * Phase 4 (§5/§4) articulation/tie attributes, realized at the output stage:
   * - `tie`: a `_` event-tie marker — occupies a slot, carries no pitch; extends
   *   the previous emitting note (no retrigger).
   * - `legato`: an interior `{ }` note — its note-off is delayed past the next
   *   note-on (overlap). The group-tail note is NOT tagged (normal gate).
   * - `voiceTie`: a `_n` stack voice — if its resolved pitch is sounding from the
   *   previous stack, suppress the off/on and extend; else play normally.
   */
  tie?: boolean
  legato?: boolean
  voiceTie?: boolean
  /**
   * §12 randomness, rolled per cycle at the output stage (decisions #50/#52/#53):
   * - `random`: presence probability (0..1) — the note has this chance to sound this
   *   cycle, else it is silent (a rest). No minimum-voice guarantee (silence allowed).
   * - `randomOctave`: pick a random octave shift in {-1, 0, +1} for this note this cycle.
   */
  random?: number
  randomOctave?: boolean
}
