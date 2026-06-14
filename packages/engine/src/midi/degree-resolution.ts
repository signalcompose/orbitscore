/**
 * Degree resolution — root scope semantics (§2.1)
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §2.1
 *
 * Pure function. The spec formula is the complete contract:
 *
 *   IONIAN = [0, 2, 4, 5, 7, 9, 11]   // semitones for degrees 1..7
 *
 *   resolve(degree n, alteration a, range o):
 *     semitones = IONIAN[(n-1) mod 7] + 12 * floor((n-1) / 7) + a
 *     pitch     = rootPitch + semitones + 12 * o   // o = running pitch range (§2.4)
 *
 *   rootPitch = 12 * (octave + 1) + rootPitchClass    // C4 = 60
 *
 * Accepted degrees are {1-9, 11, 13}: scale degrees 1-7, the octave 8, and the
 * odd tensions 9/11/13 (which fold naturally: 9 = IONIAN[1] + 12, etc.).
 * 10/12/14 and ≥15 are rejected — non-musical linear numbers; octave register
 * is written with the `^N` pitch range (§2.4), e.g. 3 an octave up is `3^1`.
 * Degree 0 is a rest (returns null).
 */

import { ResolvedPitch, RootContext, SymbolicPitch } from './types'

/** Semitone offsets for degrees 1..7 in the Ionian reference (§2.1). */
export const IONIAN = [0, 2, 4, 5, 7, 9, 11] as const

/**
 * The root-relative semitone of a bare degree (§2.1): `IONIAN[(d-1)%7] + 12·⌊(d-1)/7⌋`
 * plus optional accidental / structural octave. The shared kernel of the degree formula —
 * used by chord-voicing position math (§12) and mode-lattice construction (§2.2).
 */
export function degreeToSemitone(degree: number, alteration = 0, octaveShift = 0): number {
  return (
    IONIAN[(degree - 1) % 7] + 12 * Math.floor((degree - 1) / 7) + alteration + 12 * octaveShift
  )
}

/**
 * Accepted degrees (§2.1): scale 1-7, octave 8, odd tensions 9/11/13. 0 = rest.
 * Octave-up chord tones (10/12/14) and higher linear numbers (≥15) are rejected
 * to keep the notation musical and readable — use the `^N` pitch range instead.
 */
const ACCEPTED_DEGREES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13])

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

  // §2.2 mode scope: a melodic degree is a pure index into the user lattice (any length;
  // the {1-9,11,13} acceptance does NOT apply). Alteration applies after the lookup, and
  // the 2↔9 tension wrap-around does not hold (the lattice need not be 7 notes).
  if (context.modeLattice && context.modeLattice.length > 0) {
    const lat = context.modeLattice
    const len = lat.length
    const period = context.modePeriod ?? 12
    const semitones =
      lat[(degree - 1) % len]! + period * Math.floor((degree - 1) / len) + pitch.alteration
    const rootPitch = 12 * (context.octave + 1) + context.rootPitchClass
    return {
      midiNote: rootPitch + semitones + 12 * pitch.octaveShift,
      detune: pitch.detune,
      symbolic: pitch,
      context,
    }
  }

  // §2.1 degree acceptance: only {1-9, 11, 13} are musical. 10/12/14 and ≥15 are
  // non-musical linear numbers — reject with a hint to use the `^N` pitch range.
  if (!ACCEPTED_DEGREES.has(degree)) {
    throw new Error(
      `resolveDegree: degree ${degree} は受理されません (受理: 1-9, 11, 13; 0=休符)。` +
        `オクターブ上は ^N pitch range で書いてください — 例: 度数3の1オクターブ上は 3^1、3オクターブ上は 3^3。`,
    )
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
