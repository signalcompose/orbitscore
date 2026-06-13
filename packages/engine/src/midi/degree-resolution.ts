/**
 * Degree resolution — root scope semantics (§2.1)
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §2.1
 *
 * Pure function. The spec formula is the complete contract:
 *
 *   IONIAN = [0, 2, 4, 5, 7, 9, 11]   // semitones for degrees 1..7
 *
 *   resolve(degree n, alteration a, octaveShift o):
 *     semitones = IONIAN[(n-1) mod 7] + 12 * floor((n-1) / 7) + a
 *     pitch     = rootPitch + semitones + 12 * o
 *
 *   rootPitch = 12 * (octave + 1) + rootPitchClass    // C4 = 60
 *
 * Degrees above 7 fold naturally: 9 = IONIAN[1] + 12, 11 = IONIAN[3] + 12,
 * 13 = IONIAN[5] + 12, 15 = IONIAN[0] + 24 (two octaves up from the root).
 * Degree 0 is a rest (returns null).
 */

import { ResolvedPitch, RootContext, SymbolicPitch } from './types'

/** Semitone offsets for degrees 1..7 in the Ionian reference (§2.1). */
const IONIAN = [0, 2, 4, 5, 7, 9, 11] as const

/**
 * Resolve a symbolic pitch against a root context to a MIDI note number,
 * preserving the symbolic information (§7-0).
 *
 * @returns the resolved pitch, or `null` when the degree is a rest (0).
 * @throws if the degree is negative or non-integer (degrees must be 0 or 1+).
 */
export function resolveDegree(pitch: SymbolicPitch, context: RootContext): ResolvedPitch | null {
  const { degree } = pitch

  if (!Number.isInteger(degree) || degree < 0) {
    throw new Error(
      `resolveDegree: degree must be a non-negative integer (0 = rest, 1+ = pitched), got ${degree}`,
    )
  }

  // 0 = rest (musical silence). No note is produced.
  if (degree === 0) {
    return null
  }

  // §2.1 interval formula. (degree - 1) indexes the Ionian vocabulary;
  // every 7 degrees adds an octave. Alteration applies after the lookup.
  const scaleIndex = (degree - 1) % 7
  const octaveFromDegree = Math.floor((degree - 1) / 7)
  const semitones = IONIAN[scaleIndex] + 12 * octaveFromDegree + pitch.alteration

  // rootPitch places degree 1 at the configured root + octave (C4 = 60).
  const rootPitch = 12 * (context.octave + 1) + context.rootPitchClass
  const midiNote = rootPitch + semitones + 12 * pitch.octaveShift

  return {
    midiNote,
    detune: pitch.detune,
    symbolic: pitch,
    context,
  }
}
