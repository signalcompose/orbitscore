import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Phase 2 (#230) — `.root()` / `.mode()` / `.oct()` group-scope chain parsing.
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §2.3, §3
 *
 * Parser-level (this file): the PlayScoped AST shape, note-name reassembly,
 * degree roots, .oct, duplicate/conflict diagnostics, "chain closes the run",
 * and that no-chain juxtaposition is unaffected. Scope RESOLUTION (dispatch)
 * and juxtaposition-run grouping are covered separately.
 */
function firstArg(src: string): any {
  return parseAudioDSL(src).statements[0].args[0]
}

describe('Phase 2 — .root() scope chain parsing (single group)', () => {
  it('note-name root `.root(F#)` → PlayScoped with pitchClass + spelling', () => {
    expect(firstArg('seq1.play((1, 3, 5).root(F#))')).toMatchObject({
      type: 'scoped',
      root: { kind: 'note', pitchClass: 6, spelling: 'F#' },
      groups: [{ type: 'nested' }],
    })
  })

  it('flat note-name `.root(Bb)` (b stays in the identifier) → pitchClass 10', () => {
    expect(firstArg('seq1.play((1).root(Bb))')).toMatchObject({
      type: 'scoped',
      root: { kind: 'note', pitchClass: 10, spelling: 'Bb' },
    })
  })

  it('natural note-name `.root(C)` → pitchClass 0', () => {
    expect(firstArg('seq1.play((1).root(C))')).toMatchObject({
      type: 'scoped',
      root: { kind: 'note', pitchClass: 0, spelling: 'C' },
    })
  })

  it('numeric degree root `.root(3)` → degree 3 (resolved against key at dispatch)', () => {
    expect(firstArg('seq1.play((1).root(3))')).toMatchObject({
      type: 'scoped',
      root: { kind: 'degree', degree: 3, alteration: 0 },
    })
  })

  it('non-diatonic degree root `.root(b6)` → degree 6, alteration -1', () => {
    expect(firstArg('seq1.play((1).root(b6))')).toMatchObject({
      type: 'scoped',
      root: { kind: 'degree', degree: 6, alteration: -1 },
    })
  })

  it('the group is preserved in groups[] (single-element run)', () => {
    const scoped = firstArg('seq1.play((1, 0, 5).root(2))')
    expect(scoped.groups).toHaveLength(1)
    expect(scoped.groups[0]).toMatchObject({
      type: 'nested',
      elements: [1, 0, 5],
    })
  })
})

describe('Phase 2 — .oct() scope chain parsing', () => {
  it('`.oct(1)` → oct +1', () => {
    expect(firstArg('seq1.play((1).oct(1))')).toMatchObject({ type: 'scoped', oct: 1 })
  })
  it('`.oct(-2)` → oct -2 (downward)', () => {
    expect(firstArg('seq1.play((1).oct(-2))')).toMatchObject({ type: 'scoped', oct: -2 })
  })
  it('`.root(3).oct(1)` → root and oct coexist on one group', () => {
    expect(firstArg('seq1.play((1).root(3).oct(1))')).toMatchObject({
      type: 'scoped',
      root: { kind: 'degree', degree: 3 },
      oct: 1,
    })
  })
})

describe('Phase 2 — .mode() reserved (parsed, dispatch throws later)', () => {
  it('`.mode(dorian)` parses to an unimplemented scope marker', () => {
    expect(firstArg('seq1.play((1).mode(dorian))')).toMatchObject({
      type: 'scoped',
      mode: { kind: 'unimplemented' },
    })
  })
})

describe('Phase 2 — scope-chain diagnostics (§3, no last-wins)', () => {
  it('duplicate .root() is an error', () => {
    expect(() => parseAudioDSL('seq1.play((1).root(2).root(5))')).toThrow(/duplicate .root/)
  })
  it('.root() + .mode() on the same group is an error', () => {
    expect(() => parseAudioDSL('seq1.play((1).root(2).mode(dorian))')).toThrow(
      /root.*mode.*cannot both/,
    )
  })
  it('a chain followed by `(` with no comma is an error ("chain closes the run")', () => {
    expect(() => parseAudioDSL('seq1.play((1).root(3)(2))')).toThrow(/expected comma after chained/)
  })
})

describe('Phase 2 — juxtaposition run shares one scope (§3)', () => {
  it('(A)(B).root(X) collapses to one PlayScoped covering both groups', () => {
    const scoped = firstArg('seq1.play((1, 0)(0, 1).root(3))')
    expect(scoped).toMatchObject({ type: 'scoped', root: { kind: 'degree', degree: 3 } })
    expect(scoped.groups).toHaveLength(2)
    expect(scoped.groups[0]).toMatchObject({ type: 'nested', elements: [1, 0] })
    expect(scoped.groups[1]).toMatchObject({ type: 'nested', elements: [0, 1] })
  })

  it('three-group run (A)(B)(C).root(X) covers all three', () => {
    const scoped = firstArg('seq1.play((1)(2)(3).root(5))')
    expect(scoped.type).toBe('scoped')
    expect(scoped.groups).toHaveLength(3)
  })

  it('the run is bounded by a preceding comma (the 0 is not pulled in)', () => {
    const args = parseAudioDSL('seq1.play(0, (1)(2).root(3))').statements[0].args
    expect(args).toHaveLength(2)
    expect(args[0]).toBe(0)
    expect(args[1]).toMatchObject({ type: 'scoped' })
    expect((args[1] as any).groups).toHaveLength(2)
  })

  it('nested inner .root() sits inside an outer .root() group (§3 example)', () => {
    const scoped = firstArg('seq1.play(((1, b3).root(b6), 5, 1).root(2))')
    expect(scoped).toMatchObject({ type: 'scoped', root: { kind: 'degree', degree: 2 } })
    const outer = (scoped.groups[0] as any).elements
    expect(outer[0]).toMatchObject({
      type: 'scoped',
      root: { kind: 'degree', degree: 6, alteration: -1 },
    })
    expect(outer[1]).toBe(5)
    expect(outer[2]).toBe(1)
  })

  it('chain closes the run: (A)(B).root(3)(C) is an error', () => {
    expect(() => parseAudioDSL('seq1.play((1)(2).root(3)(3))')).toThrow(
      /expected comma after chained/,
    )
  })
})

describe('Phase 2 — no-chain juxtaposition is unaffected (regression guard)', () => {
  it('a bare group stays a plain nested node (not scoped)', () => {
    expect(firstArg('seq1.play((1, 3, 5))')).toMatchObject({ type: 'nested' })
  })
  it('no-chain juxtaposition (1)(2) stays separate sibling args', () => {
    const args = parseAudioDSL('seq1.play((1)(2))').statements[0].args
    expect(args).toHaveLength(2)
    expect(args[0]).toMatchObject({ type: 'nested' })
    expect(args[1]).toMatchObject({ type: 'nested' })
  })
})
