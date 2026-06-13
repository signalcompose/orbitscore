/**
 * The `import chords` standard library (§6, §10-4): a table of common chord
 * qualities as root-unbound degree stacks. Degrees are written against the major
 * scale, so the quality lives in the accidentals (m7 = 1, b3, 5, b7).
 *
 * Brought into the global chord namespace by `import chords`; a later `var` of
 * the same name shadows it with a conflict warning (§10-4, last-write-wins).
 */
import { ChordVoice } from './types'

/** Build a close-position voice (no structural octave / detune). */
const v = (degree: number, alteration = 0): ChordVoice => ({
  degree,
  alteration,
  octaveShift: 0,
  detune: 0,
})

export const PREDEFINED_CHORDS: Record<string, ChordVoice[]> = {
  // Triads
  maj: [v(1), v(3), v(5)],
  min: [v(1), v(3, -1), v(5)],
  dim: [v(1), v(3, -1), v(5, -1)],
  aug: [v(1), v(3), v(5, 1)],
  sus4: [v(1), v(4), v(5)],
  sus2: [v(1), v(2), v(5)],
  // Sixths
  '6': [v(1), v(3), v(5), v(6)],
  m6: [v(1), v(3, -1), v(5), v(6)],
  // Sevenths
  maj7: [v(1), v(3), v(5), v(7)],
  m7: [v(1), v(3, -1), v(5), v(7, -1)],
  dom7: [v(1), v(3), v(5), v(7, -1)],
  m7b5: [v(1), v(3, -1), v(5, -1), v(7, -1)],
  dim7: [v(1), v(3, -1), v(5, -1), v(7, -2)],
  mMaj7: [v(1), v(3, -1), v(5), v(7)],
  // Ninths
  maj9: [v(1), v(3), v(5), v(7), v(9)],
  m9: [v(1), v(3, -1), v(5), v(7, -1), v(9)],
  dom9: [v(1), v(3), v(5), v(7, -1), v(9)],
}
