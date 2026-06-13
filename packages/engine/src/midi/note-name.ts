/**
 * Note-name → pitch-class parsing
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §1 (global.key), §2.3
 *
 * Used by `global.key("C")` and (in Phase 2) `seq.root(F#)`. Accepts a letter
 * A–G with any number of trailing `#` / `b` accidentals (case-insensitive
 * letter; accidentals are case-sensitive: `#` sharp, `b` flat).
 */

/** Semitone offset of the natural note letters from C. */
const LETTER_SEMITONES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
}

/**
 * Parse a note name (e.g. "C", "F#", "Bb", "C##") to a pitch class 0..11.
 *
 * @throws if the string is empty, the first character is not A–G, or it
 *         contains characters other than trailing `#` / `b`.
 */
export function noteNameToPitchClass(name: string): number {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw new Error('noteNameToPitchClass: empty note name')
  }

  const letter = trimmed[0]!.toUpperCase()
  const base = LETTER_SEMITONES[letter]
  if (base === undefined) {
    throw new Error(`noteNameToPitchClass: "${name}" must start with a note letter A–G`)
  }

  let alteration = 0
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '#') {
      alteration += 1
    } else if (ch === 'b') {
      alteration -= 1
    } else {
      throw new Error(
        `noteNameToPitchClass: "${name}" has an invalid accidental "${ch}" (only # and b allowed)`,
      )
    }
  }

  // Wrap into 0..11 (handles e.g. Cb = 11, B# = 0).
  return (((base + alteration) % 12) + 12) % 12
}
