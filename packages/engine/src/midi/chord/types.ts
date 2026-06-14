/**
 * Chord-value types (§6 / DESIGN_DISCUSSION_RECORD §9).
 *
 * A chord value is a ROOT-UNBOUND degree stack — a vertical value resolved against
 * the scope (root/mode) where it is placed, distinct from the placement context
 * itself (§6: "root はコンテキスト、chord は値"). Chord values live in a runtime
 * namespace (Global), populated by `import chords` and `var X = [...]` (§6, #48).
 */

import { PlayElement } from '../../parser/types'

/**
 * One voice of a chord: a symbolic degree against the (later) placement scope.
 * Mirrors the pitched subset of {@link import('../types').SymbolicPitch} — but
 * `octaveShift` here is STRUCTURAL voicing (a voice placed an octave up, §6 So What),
 * layered on the running range at dispatch and never a running-range set point (§2.4).
 */
export interface ChordVoice {
  degree: number
  alteration: number
  octaveShift: number // structural voicing octave; 0 for a close-position voice
  detune: number // semitones (`~`); 0 for an untuned voice
}

/**
 * A bound value in the namespace (§6 / §6.5). The `kind` discriminant lets one
 * registry hold both vertical chord values and horizontal pattern variables; a
 * bare name reference dispatches on `kind` at evaluation.
 * - `chord`: a vertical degree stack (resolved against the placement scope)
 * - `pattern` (§6.5): a horizontal/tree value — 1+ top-level play siblings, spliced
 *   at the use site (length > 1 = a juxtaposition binding)
 * - `mode` (§2.2): a user pitch lattice (semitone offsets) referenced by `.mode(name)`
 */
export type BoundValue =
  | { kind: 'chord'; voices: ChordVoice[] }
  | { kind: 'pattern'; elements: PlayElement[] }
  | { kind: 'mode'; lattice: number[]; period: number }
