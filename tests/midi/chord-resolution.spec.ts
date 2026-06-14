import { describe, it, expect } from 'vitest'

import { resolveChords, BindingLookup } from '../../packages/engine/src/midi/chord/resolve-chords'
import { PREDEFINED_CHORDS } from '../../packages/engine/src/midi/chord/predefined-chords'

/**
 * Phase 3 (#231) — chord evaluation (§6): the pure spread / removal / `^N`
 * resolver. Inputs are raw AST fragments (chord refs, removals) built by hand so
 * the evaluator is tested in isolation from the parser and the namespace.
 */

const lookup: BindingLookup = (name) =>
  PREDEFINED_CHORDS[name] ? { kind: 'chord', voices: PREDEFINED_CHORDS[name]! } : undefined

const ref = (name: string, octaveShift = 0) => ({ type: 'chord_ref' as const, name, octaveShift })
const rm = (degree: number, alteration = 0) => ({
  type: 'chord_removal' as const,
  degree,
  alteration,
})
const stack = (voices: any[], octaveShift?: number): any =>
  octaveShift === undefined ? { type: 'stack', voices } : { type: 'stack', voices, octaveShift }

function resolveStack(voices: any[], octaveShift?: number) {
  const { elements, warnings } = resolveChords([stack(voices, octaveShift)], lookup)
  return { stack: elements[0] as any, warnings }
}

describe('Phase 3 — chord resolution (§6)', () => {
  it('the predefined m7 is the root-unbound degree stack [1, b3, 5, b7]', () => {
    expect(PREDEFINED_CHORDS.m7).toEqual([
      { degree: 1, alteration: 0, octaveShift: 0, detune: 0 },
      { degree: 3, alteration: -1, octaveShift: 0, detune: 0 },
      { degree: 5, alteration: 0, octaveShift: 0, detune: 0 },
      { degree: 7, alteration: -1, octaveShift: 0, detune: 0 },
    ])
  })

  it('spread: [m7] expands to its four voices (plain degrees stay numbers)', () => {
    const { stack } = resolveStack([ref('m7')])
    expect(stack.voices).toEqual([
      1,
      { type: 'pitch', degree: 3, alteration: -1, octaveShift: 0, rangeSet: false, detune: 0 },
      5,
      { type: 'pitch', degree: 7, alteration: -1, octaveShift: 0, rangeSet: false, detune: 0 },
    ])
  })

  it('spread + add: [m7, 9] appends the extra degree', () => {
    const { stack } = resolveStack([ref('m7'), 9])
    expect(stack.voices.map((v: any) => (typeof v === 'number' ? v : v.degree))).toEqual([
      1, 3, 5, 7, 9,
    ])
  })

  it('removal `-5`: literal-matches and removes the natural 5 (§6)', () => {
    const { stack, warnings } = resolveStack([ref('m7'), rm(5)])
    expect(stack.voices.map((v: any) => (typeof v === 'number' ? v : v.degree))).toEqual([1, 3, 7])
    expect(warnings).toHaveLength(0)
  })

  it('removal `-b3`: matches the altered voice (degree + alteration)', () => {
    const { stack } = resolveStack([ref('m7'), rm(3, -1)])
    // b3 removed → 1, 5, b7
    expect(stack.voices).toEqual([
      1,
      5,
      { type: 'pitch', degree: 7, alteration: -1, octaveShift: 0, rangeSet: false, detune: 0 },
    ])
  })

  it('removal `-3` (natural) does NOT match m7’s b3 → no-op + warning', () => {
    const { stack, warnings } = resolveStack([ref('m7'), rm(3)])
    expect(stack.voices.map((v: any) => (typeof v === 'number' ? v : v.degree))).toEqual([
      1, 3, 5, 7,
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/matched no voice/)
  })

  it('ref `^+1` shifts every spread voice up an octave (structural)', () => {
    const { stack } = resolveStack([ref('m7', 1)])
    for (const v of stack.voices) {
      expect(v).toMatchObject({ type: 'pitch', octaveShift: 1, rangeSet: false })
    }
    expect(stack.voices.map((v: any) => v.degree)).toEqual([1, 3, 5, 7])
  })

  it('a whole-stack `^N` is preserved on the node (applied at timing)', () => {
    const { stack } = resolveStack([1, 3, 5], 1)
    expect(stack).toEqual({ type: 'stack', voices: [1, 3, 5], octaveShift: 1 })
  })

  it('an unknown chord name resolves to no voices + a warning', () => {
    const { stack, warnings } = resolveStack([ref('nope')])
    expect(stack.voices).toEqual([])
    expect(warnings[0]).toMatch(/unknown name "nope"/)
  })

  it('a bare chord ref as a standalone element becomes a one-slot stack', () => {
    const { elements } = resolveChords([ref('maj') as any], lookup)
    expect(elements[0]).toEqual({ type: 'stack', voices: [1, 3, 5] })
  })

  it('a literal stack with no chord refs is unchanged', () => {
    const { stack, warnings } = resolveStack([1, 3, 5])
    expect(stack).toEqual({ type: 'stack', voices: [1, 3, 5] })
    expect(warnings).toHaveLength(0)
  })
})

describe('Phase R — pattern resolution cycle guard (§6.5)', () => {
  it('a self-referential pattern (`var riff = (riff)`) warns and stops, no overflow', () => {
    const self: BindingLookup = (name) =>
      name === 'riff' ? { kind: 'pattern', elements: [ref('riff')] } : undefined
    const { elements, warnings } = resolveChords([ref('riff') as any], self)
    expect(elements).toEqual([])
    expect(warnings.some((w) => /circular pattern reference "riff"/.test(w))).toBe(true)
  })

  it('mutual recursion (`a → b → a`) is caught, not run to a stack overflow', () => {
    const mutual: BindingLookup = (name) => {
      if (name === 'a') return { kind: 'pattern', elements: [ref('b')] }
      if (name === 'b') return { kind: 'pattern', elements: [ref('a')] }
      return undefined
    }
    const { warnings } = resolveChords([ref('a') as any], mutual)
    expect(warnings.some((w) => /circular pattern reference/.test(w))).toBe(true)
  })

  it('an unbound standalone name resolves to a REST, preserving its slot (#255)', () => {
    // play(1, bogus, 3): bogus is unbound → a rest (0), so the bar stays 3 slots
    // (a typo must not silently re-time the rest of the bar).
    const { elements, warnings } = resolveChords([1, ref('bogus') as any, 3], lookup)
    expect(elements).toEqual([1, 0, 3])
    expect(warnings.some((w) => /rendered as a rest/.test(w))).toBe(true)
  })

  it('legitimate sibling reuse (`play(riff, riff)`) is NOT flagged as circular', () => {
    // visiting is a per-branch set (removed after each expansion), so reusing the
    // same finished pattern as a sibling is fine — only a name on the LIVE branch loops.
    const reuse: BindingLookup = (name) =>
      name === 'riff' ? { kind: 'pattern', elements: [1, 5] } : undefined
    const { elements, warnings } = resolveChords([ref('riff') as any, ref('riff') as any], reuse)
    expect(elements).toEqual([1, 5, 1, 5])
    expect(warnings).toHaveLength(0)
  })
})
