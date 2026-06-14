import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Phase 4 (#236) — `_` tie / `_n` voice tie / `{ }` legato / `.hold()` parsing
 * (§5, §4). Parse-shape only; timing in tie-legato-timing.spec.ts, dispatch in
 * sequence-tie-legato-dispatch.spec.ts.
 */
function args(src: string): any[] {
  return parseAudioDSL(src).statements[0].args
}
function firstArg(src: string): any {
  return parseAudioDSL(src).statements[0].args[0]
}

describe('Phase 4 — tie / legato / hold parsing (§5, §4)', () => {
  it('a bare `_` is an event-tie element', () => {
    expect(args('seq.play(1, _, 3)')).toEqual([1, { type: 'tie' }, 3])
  })

  it('`_` works inside a group: (1, (_, 3))', () => {
    const g = firstArg('seq.play((1, (_, 3)))')
    expect(g.elements[1]).toMatchObject({ type: 'nested', elements: [{ type: 'tie' }, 3] })
  })

  it('`{ }` is a legato group with the same elements as `( )`', () => {
    expect(firstArg('seq.play({1, 2, 3})')).toEqual({ type: 'legato', elements: [1, 2, 3] })
  })

  it('a `{ }` containing a `[ ]` stack parses (legato over a chord)', () => {
    const g = firstArg('seq.play({[1, 3, 5], 2})')
    expect(g.type).toBe('legato')
    expect(g.elements[0]).toEqual({ type: 'stack', voices: [1, 3, 5] })
    expect(g.elements[1]).toBe(2)
  })

  it('`_5` / `_b7` inside a stack are voice ties (tie:true PlayPitch), NOT chord refs', () => {
    const stack = firstArg('seq.play([1, _5, _b7])')
    expect(stack.type).toBe('stack')
    expect(stack.voices[0]).toBe(1)
    expect(stack.voices[1]).toMatchObject({ type: 'pitch', degree: 5, alteration: 0, tie: true })
    expect(stack.voices[2]).toMatchObject({ type: 'pitch', degree: 7, alteration: -1, tie: true })
    // crucially NOT a chord_ref named "_5"
    expect(stack.voices[1].type).not.toBe('chord_ref')
  })

  it('`(...).hold()` chains a group-level hold flag', () => {
    expect(firstArg('seq.play((1, 5).hold())')).toMatchObject({ type: 'scoped', hold: true })
  })

  it('`.hold()` composes with `.root()`', () => {
    expect(firstArg('seq.play((1, 5).root(3).hold())')).toMatchObject({
      type: 'scoped',
      root: { kind: 'degree', degree: 3 },
      hold: true,
    })
  })
})
