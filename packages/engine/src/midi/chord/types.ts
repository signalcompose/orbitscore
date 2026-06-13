/**
 * Chord-value types (§6 / DESIGN_DISCUSSION_RECORD §9).
 *
 * A chord value is a ROOT-UNBOUND degree stack — a vertical value resolved against
 * the scope (root/mode) where it is placed, distinct from the placement context
 * itself (§6: "root はコンテキスト、chord は値"). Chord values live in a runtime
 * namespace (Global), populated by `import chords` and `var X = chord([...])`.
 */

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
 * A bound value in the chord namespace. The `kind` discriminant keeps the
 * namespace shared-ready: Phase R (#227) adds its own value kind (e.g. a tree
 * pattern variable) to the same table without disturbing chord values.
 */
export type BoundValue = { kind: 'chord'; voices: ChordVoice[] }
