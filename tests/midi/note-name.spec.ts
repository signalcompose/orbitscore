import { describe, it, expect } from 'vitest'

import { noteNameToPitchClass } from '../../packages/engine/src/midi/note-name'

/** Phase 1 (#228) — note-name → pitch-class parsing (§1, §2.3) */
describe('noteNameToPitchClass', () => {
  it('parses natural letters C..B', () => {
    const expected: Record<string, number> = {
      C: 0,
      D: 2,
      E: 4,
      F: 5,
      G: 7,
      A: 9,
      B: 11,
    }
    for (const [name, pc] of Object.entries(expected)) {
      expect(noteNameToPitchClass(name)).toBe(pc)
    }
  })

  it('applies sharps and flats', () => {
    expect(noteNameToPitchClass('C#')).toBe(1)
    expect(noteNameToPitchClass('Db')).toBe(1)
    expect(noteNameToPitchClass('F#')).toBe(6)
    expect(noteNameToPitchClass('Bb')).toBe(10)
    expect(noteNameToPitchClass('C##')).toBe(2)
    expect(noteNameToPitchClass('Dbb')).toBe(0)
  })

  it('wraps across the octave boundary (Cb, B#)', () => {
    expect(noteNameToPitchClass('Cb')).toBe(11)
    expect(noteNameToPitchClass('B#')).toBe(0)
  })

  it('is case-insensitive on the letter', () => {
    expect(noteNameToPitchClass('c')).toBe(0)
    expect(noteNameToPitchClass('f#')).toBe(6)
  })

  it('throws on invalid input', () => {
    expect(() => noteNameToPitchClass('')).toThrow()
    expect(() => noteNameToPitchClass('H')).toThrow()
    expect(() => noteNameToPitchClass('Cx')).toThrow()
  })
})
