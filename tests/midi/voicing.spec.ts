import { describe, it, expect } from 'vitest'

import { resolveChords, BindingLookup } from '../../packages/engine/src/midi/chord/resolve-chords'
import { PREDEFINED_CHORDS } from '../../packages/engine/src/midi/chord/predefined-chords'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * E2 (#257) — voicing operators (§12, decisions #49/#51): `.drop(n...)`, `.invert(n)`,
 * `.open()`, `.close()`, `.shell()`, `.rootless()`. They are symbolic `^N` / filter
 * transforms applied at resolve time; here we parse a `play(...)` arg and resolve it,
 * asserting the resulting stack voices as (degree, octaveShift) pairs.
 */

const lookup: BindingLookup = (name) =>
  PREDEFINED_CHORDS[name] ? { kind: 'chord', voices: PREDEFINED_CHORDS[name]! } : undefined

/** Parse `play(<src>)`, resolve, return the first element (a stack) + warnings. */
function voice(src: string): { stack: any; warnings: string[] } {
  const args = (parseAudioDSL(`p.play(${src})`).statements[0] as any).args
  const { elements, warnings } = resolveChords(args, lookup)
  return { stack: elements[0], warnings }
}

/** Voices as (degree, octaveShift) pairs — a bare number is degree at octave 0. */
const pairs = (stack: any): Array<[number, number]> =>
  stack.voices.map((v: any) => (typeof v === 'number' ? [v, 0] : [v.degree, v.octaveShift]))

describe('E2 — voicing parse shape (§12)', () => {
  it('`[1,3,5,7].drop(2,4)` parses to a voicing node wrapping the stack', () => {
    const arg = (parseAudioDSL('p.play([1,3,5,7].drop(2,4))').statements[0] as any).args[0]
    expect(arg).toMatchObject({ type: 'voicing', op: 'drop', args: [2, 4] })
    expect(arg.target).toMatchObject({ type: 'stack' })
  })

  it('`.invert(2)` rejects extra args; `.drop()` needs a position; `.open(1)` rejects args', () => {
    expect(() => parseAudioDSL('p.play([1,3,5].invert(2,3))')).toThrow(/invert\(\) takes 1/)
    expect(() => parseAudioDSL('p.play([1,3,5].drop())')).toThrow(/takes 1\+ position/)
    expect(() => parseAudioDSL('p.play([1,3,5].open(1))')).toThrow(/no arguments/)
  })
})

describe('E2 — deterministic voicing transforms (§12.3)', () => {
  it('`.drop(2)` drops the 2nd-from-top voice an octave', () => {
    expect(pairs(voice('[1,3,5,7].drop(2)').stack)).toEqual([
      [1, 0],
      [3, 0],
      [5, -1],
      [7, 0],
    ])
  })

  it('`.drop(2,4)` drops the 2nd and 4th from the top (drop2&4)', () => {
    expect(pairs(voice('[1,3,5,7].drop(2,4)').stack)).toEqual([
      [1, -1],
      [3, 0],
      [5, -1],
      [7, 0],
    ])
  })

  it('`.invert(2)` raises the bottom two voices an octave', () => {
    expect(pairs(voice('[1,3,5,7].invert(2)').stack)).toEqual([
      [1, 1],
      [3, 1],
      [5, 0],
      [7, 0],
    ])
  })

  it('`.shell()` keeps only root / 3rd / 7th (guide tones)', () => {
    expect(pairs(voice('[1,3,5,7].shell()').stack)).toEqual([
      [1, 0],
      [3, 0],
      [7, 0],
    ])
  })

  it('`.rootless()` drops the root', () => {
    expect(pairs(voice('[1,3,5,7].rootless()').stack)).toEqual([
      [3, 0],
      [5, 0],
      [7, 0],
    ])
  })

  it('`.close()` repacks an out-of-order chord into closest ascending position', () => {
    // [1,5,3] → semitones 0,7,4 → closest ascending = 1,3,5 all within an octave (oct 0)
    expect(pairs(voice('[1,5,3].close()').stack)).toEqual([
      [1, 0],
      [3, 0],
      [5, 0],
    ])
  })

  it('`.open()` = close then drop the 2nd-from-top an octave (>1 octave span)', () => {
    // close([1,3,5,7]) = oct0; drop 2nd-from-top (5) an octave; re-sort by pitch
    expect(pairs(voice('[1,3,5,7].open()').stack)).toEqual([
      [5, -1],
      [1, 0],
      [3, 0],
      [7, 0],
    ])
  })

  it('a voicing applies to a chord variable too (`m7.drop(2)`)', () => {
    // m7 = [1, b3, 5, b7]; drop(2) = 2nd-from-top = 5 down an octave
    const { stack } = voice('m7.drop(2)')
    expect(stack.type).toBe('stack')
    expect(pairs(stack)).toEqual([
      [1, 0],
      [3, 0], // b3 stays (pairs() tracks degree+octave; the alteration is carried separately)
      [5, -1],
      [7, 0],
    ])
  })

  it('`.drop(9)` on a 4-voice chord warns (position out of range) and skips it', () => {
    const { warnings } = voice('[1,3,5,7].drop(9)')
    expect(warnings.some((w) => /4 voices/.test(w))).toBe(true)
  })

  it('a voicing preserves a chained `.r` thinning (random survives the transform)', () => {
    const { stack } = voice('[1,3,5,7].r.drop(2)')
    expect(stack.type).toBe('stack')
    expect(stack.random).toBe(0.5) // .r thinning must not be dropped by applyVoicing
  })

  it('a voicing preserves per-voice expression on the moved voice (`@v` survives `.drop`)', () => {
    // [1, 3@v100, 5].drop(2): position 2 from top = the 3 voice → octave -1, BUT @v100 kept
    const { stack } = voice('[1, 3@v100, 5].drop(2)')
    expect(stack.voices[1]).toMatchObject({ degree: 3, octaveShift: -1, velocity: 100 })
  })
})
