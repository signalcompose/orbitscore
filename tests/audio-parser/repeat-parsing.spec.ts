import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Phase R (#227) — `*n` repetition parsing (§6.5). The postfix `*n` and
 * `.root()/.mode()/.oct()` chains apply LEFT TO RIGHT by source order. Parse-shape
 * only; resolution/timing is covered in tests/timing/repeat-timing.spec.ts.
 */
function firstArg(src: string): any {
  return parseAudioDSL(src).statements[0].args[0]
}

describe('Phase R — *n repetition parsing (§6.5)', () => {
  it('1*3 → PlayRepeat of a bare number', () => {
    expect(firstArg('seq.play(1*3)')).toEqual({ type: 'repeat', element: 1, count: 3 })
  })

  it('*0 is a diagnostic error', () => {
    expect(() => parseAudioDSL('seq.play(1*0)')).toThrow(/integer ≥ 1|\*0/)
  })

  it('*1 is identity (still a repeat node, count 1)', () => {
    expect(firstArg('seq.play(5*1)')).toEqual({ type: 'repeat', element: 5, count: 1 })
  })

  it('(1, 0)*4 → PlayRepeat of a group', () => {
    const r = firstArg('seq.play((1, 0)*4)')
    expect(r.type).toBe('repeat')
    expect(r.count).toBe(4)
    expect(r.element).toMatchObject({ type: 'nested', elements: [1, 0] })
  })

  it('riff*4.root(3) → root wraps the repeat (the run shares the root)', () => {
    const r = firstArg('seq.play(riff*4.root(3))')
    expect(r).toMatchObject({ type: 'scoped', root: { kind: 'degree', degree: 3 } })
    expect(r.groups[0]).toMatchObject({ type: 'repeat', count: 4 })
    expect(r.groups[0].element).toEqual({ type: 'chord_ref', name: 'riff', octaveShift: 0 })
  })

  it('(a)(b).root(2)*2 → repeat wraps the rooted cell (left-to-right postfix)', () => {
    const r = firstArg('seq.play((1)(2).root(2)*2)')
    expect(r.type).toBe('repeat')
    expect(r.count).toBe(2)
    expect(r.element).toMatchObject({ type: 'scoped', root: { kind: 'degree', degree: 2 } })
    expect(r.element.groups).toHaveLength(2)
  })

  it('inside a group: (1*2, 5) repeats the 1 within the group', () => {
    const r = firstArg('seq.play((1*2, 5))')
    expect(r.type).toBe('nested')
    expect(r.elements[0]).toEqual({ type: 'repeat', element: 1, count: 2 })
    expect(r.elements[1]).toBe(5)
  })
})
