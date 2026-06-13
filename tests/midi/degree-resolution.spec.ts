import { describe, it, expect } from 'vitest'

import { resolveDegree } from '../../packages/engine/src/midi/degree-resolution'
import { RootContext, SymbolicPitch } from '../../packages/engine/src/midi/types'

/**
 * Phase 1 (#228) — degree resolution, root scope semantics
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §2.1, §7-0
 */

// C4 = 60: octave 4, root pitch class 0 (C).
const C4_CONTEXT: RootContext = { rootPitchClass: 0, octave: 4 }

/** Build a SymbolicPitch with sensible defaults (no alteration/shift/detune). */
function pitch(degree: number, overrides: Partial<SymbolicPitch> = {}): SymbolicPitch {
  return { degree, alteration: 0, octaveShift: 0, detune: 0, ...overrides }
}

describe('resolveDegree — root scope (§2.1)', () => {
  describe('degree 0 = rest', () => {
    it('returns null for a rest', () => {
      expect(resolveDegree(pitch(0), C4_CONTEXT)).toBeNull()
    })
  })

  describe('C4 = 60 convention, diatonic degrees 1..7 in C', () => {
    // Ionian: C D E F G A B → 60 62 64 65 67 69 71
    const expected: Record<number, number> = {
      1: 60, // C4
      2: 62, // D4
      3: 64, // E4
      4: 65, // F4
      5: 67, // G4
      6: 69, // A4
      7: 71, // B4
    }
    for (const [deg, midi] of Object.entries(expected)) {
      it(`degree ${deg} → MIDI ${midi}`, () => {
        const r = resolveDegree(pitch(Number(deg)), C4_CONTEXT)
        expect(r?.midiNote).toBe(midi)
      })
    }
  })

  describe('tension degrees fold to the next octave (9, 11, 13)', () => {
    // 9 = D5 (62+12=74), 11 = F5 (65+12=77), 13 = A5 (69+12=81)
    it('degree 9 = degree 2 + 12 (D5 = 74)', () => {
      expect(resolveDegree(pitch(9), C4_CONTEXT)?.midiNote).toBe(74)
      expect(resolveDegree(pitch(9), C4_CONTEXT)!.midiNote).toBe(
        resolveDegree(pitch(2), C4_CONTEXT)!.midiNote + 12,
      )
    })
    it('degree 11 = degree 4 + 12 (F5 = 77)', () => {
      expect(resolveDegree(pitch(11), C4_CONTEXT)?.midiNote).toBe(77)
    })
    it('degree 13 = degree 6 + 12 (A5 = 81)', () => {
      expect(resolveDegree(pitch(13), C4_CONTEXT)?.midiNote).toBe(81)
    })
  })

  describe('degree acceptance (§2.1): {1-9, 11, 13}; 10/12/14/≥15 rejected', () => {
    it('degree 8 = octave-up root (C5 = 72), equivalent to 1^1', () => {
      expect(resolveDegree(pitch(8), C4_CONTEXT)?.midiNote).toBe(72)
      expect(resolveDegree(pitch(8), C4_CONTEXT)!.midiNote).toBe(
        resolveDegree(pitch(1, { octaveShift: 1 }), C4_CONTEXT)!.midiNote,
      )
    })
    for (const ok of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13]) {
      it(`accepts degree ${ok}`, () => {
        expect(() => resolveDegree(pitch(ok), C4_CONTEXT)).not.toThrow()
      })
    }
    for (const bad of [10, 12, 14, 15, 16, 20]) {
      it(`rejects degree ${bad} (octave register is written with ^N)`, () => {
        expect(() => resolveDegree(pitch(bad), C4_CONTEXT)).toThrow(/受理されません|\^N/)
      })
    }
  })

  describe('alterations (b = -1, # = +1, bb/## = ±2)', () => {
    it('b3 = Eb4 (63)', () => {
      expect(resolveDegree(pitch(3, { alteration: -1 }), C4_CONTEXT)?.midiNote).toBe(63)
    })
    it('#4 = F#4 (66)', () => {
      expect(resolveDegree(pitch(4, { alteration: 1 }), C4_CONTEXT)?.midiNote).toBe(66)
    })
    it('b5 = Gb4 (66)', () => {
      expect(resolveDegree(pitch(5, { alteration: -1 }), C4_CONTEXT)?.midiNote).toBe(66)
    })
    it('bb7 = double-flat (69)', () => {
      expect(resolveDegree(pitch(7, { alteration: -2 }), C4_CONTEXT)?.midiNote).toBe(69)
    })
    it('##1 = double-sharp (62)', () => {
      expect(resolveDegree(pitch(1, { alteration: 2 }), C4_CONTEXT)?.midiNote).toBe(62)
    })
  })

  describe('octave shift (^)', () => {
    it('1^+1 = C5 (72)', () => {
      expect(resolveDegree(pitch(1, { octaveShift: 1 }), C4_CONTEXT)?.midiNote).toBe(72)
    })
    it('1^-1 = C3 (48)', () => {
      expect(resolveDegree(pitch(1, { octaveShift: -1 }), C4_CONTEXT)?.midiNote).toBe(48)
    })
  })

  describe('root context (octave + rootPitchClass)', () => {
    it('octave shifts the whole grid: degree 1 at octave 3 = C3 (48)', () => {
      expect(resolveDegree(pitch(1), { rootPitchClass: 0, octave: 3 })?.midiNote).toBe(48)
    })
    it('non-C root: degree 1 in F (rootPitchClass 5) at octave 4 = F4 (65)', () => {
      expect(resolveDegree(pitch(1), { rootPitchClass: 5, octave: 4 })?.midiNote).toBe(65)
    })
    it('degree resolution is relative to root: b3 in F = Ab4 (68)', () => {
      // F=65, minor third above = Ab = 65 + 3 = 68
      expect(
        resolveDegree(pitch(3, { alteration: -1 }), { rootPitchClass: 5, octave: 4 })?.midiNote,
      ).toBe(68)
    })
  })

  describe('§7-0 — symbolic information is preserved through resolution', () => {
    it('carries the original symbolic pitch and context verbatim', () => {
      const p = pitch(3, { alteration: -1, octaveShift: 1, detune: -0.25 })
      const r = resolveDegree(p, C4_CONTEXT)
      expect(r?.symbolic).toBe(p)
      expect(r?.context).toBe(C4_CONTEXT)
      expect(r?.detune).toBe(-0.25)
    })
  })

  describe('detune passes through for pitch bend', () => {
    it('b7~-0.25 keeps detune -0.25', () => {
      const r = resolveDegree(pitch(7, { alteration: -1, detune: -0.25 }), C4_CONTEXT)
      expect(r?.detune).toBe(-0.25)
      expect(r?.midiNote).toBe(70) // Bb4
    })
  })

  describe('exhaustive: accepted degrees × alterations × octaves match the formula', () => {
    const IONIAN = [0, 2, 4, 5, 7, 9, 11]
    for (const degree of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13]) {
      for (const alteration of [-2, -1, 0, 1, 2]) {
        for (const octave of [2, 3, 4, 5]) {
          it(`degree ${degree} alt ${alteration} octave ${octave}`, () => {
            const ctx: RootContext = { rootPitchClass: 0, octave }
            const semitones =
              IONIAN[(degree - 1) % 7] + 12 * Math.floor((degree - 1) / 7) + alteration
            const expected = 12 * (octave + 1) + 0 + semitones
            expect(resolveDegree(pitch(degree, { alteration }), ctx)?.midiNote).toBe(expected)
          })
        }
      }
    }
  })

  describe('validation', () => {
    it('throws on negative degree', () => {
      expect(() => resolveDegree(pitch(-1), C4_CONTEXT)).toThrow()
    })
    it('throws on non-integer degree', () => {
      expect(() => resolveDegree(pitch(1.5), C4_CONTEXT)).toThrow()
    })
  })
})
