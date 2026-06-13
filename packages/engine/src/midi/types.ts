/**
 * MIDI symbolic pitch types — Phase 1 (Issue #228)
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §2.1, §2.4, §7-0
 *
 * §7-0 (記譜対応の前提): the pipeline MUST preserve symbolic pitch information
 * (degree, alteration, octave shift, resolution context, tie/legato attributes)
 * and resolve to a MIDI note number ONLY at the output adapter's final stage.
 * Propagating resolved note numbers alone is forbidden — note-name spelling
 * (D#/Eb), ties, and slurs are lost irreversibly once numbered, and the future
 * real-time score-rendering epic (#240) depends on this information surviving.
 *
 * This file defines the §7-0 contract. Everything downstream (timing pipeline,
 * MIDI scheduler, output adapter) carries these structures, not bare numbers.
 */

/**
 * Accidental offset in semitones, from `b` / `#` / `bb` / `##` prefixes.
 * `b` = -1, `#` = +1, `bb` = -2, `##` = +2. 0 = natural.
 */
export type Alteration = number

/**
 * A symbolic pitch as written in the DSL, BEFORE resolution to a MIDI number.
 *
 * `degree === 0` denotes a rest (musical silence), per the OrbitScore degree
 * philosophy — 0 is a musical value, not merely "no sound".
 */
export interface SymbolicPitch {
  /**
   * Scale degree. 1+ = pitched, interpreted as the Ionian-based interval
   * vocabulary (§2.1). 0 = rest. Degrees above 7 (9, 11, 13, 15, ...) are
   * valid and fold to the next octave naturally via the resolution formula.
   */
  degree: number
  /** Accidental offset in semitones (`b`/`#`/`bb`/`##`). Default 0. */
  alteration: Alteration
  /** Octave shift from the `^` modifier (e.g. `3^+1` → +1). Default 0. */
  octaveShift: number
  /**
   * Detune in semitones from the `~` modifier (e.g. `b7~-0.25` → -0.25).
   * Realized via pitch bend at the output stage. Default 0.
   */
  detune: number
}

/**
 * The pitch context (root scope) against which a degree resolves.
 *
 * Phase 1 supports root scope only, set per-sequence via `seq.root()`.
 * Group-level lexical scoping (`(...).root()` chains) is Phase 2; the
 * user-defined mode lattice (§2.2) is Phase 2.2.
 */
export interface RootContext {
  /** Root pitch class, 0..11 (C=0, C#=1, ..., B=11). */
  rootPitchClass: number
  /**
   * Base octave from `seq.octave()`. Determines the MIDI note of degree 1:
   *   rootPitch = 12 * (octave + 1) + rootPitchClass   (C4 = 60 convention).
   */
  octave: number
}

/**
 * The result of resolving a {@link SymbolicPitch} against a {@link RootContext}.
 *
 * Carries the final MIDI note number AND the preserved symbolic information
 * (§7-0). The resolver returns `null` for rests (degree 0).
 */
export interface ResolvedPitch {
  /**
   * Final MIDI note number, computed at the output stage only. May fall
   * outside 0..127 for extreme octave/degree combinations; clamping or
   * warning is the output adapter's responsibility, not the resolver's.
   */
  midiNote: number
  /** Detune in semitones, to be realized via pitch bend. */
  detune: number
  /** §7-0: the original symbolic pitch, preserved verbatim. */
  symbolic: SymbolicPitch
  /** §7-0: the context used for resolution, preserved verbatim. */
  context: RootContext
}
