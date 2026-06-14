import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Phase R (#227) — `var NAME = <play-expr>` pattern-binding parsing (§6.5). Statement
 * shape only; splice/dispatch is in tests/core/sequence-pattern-dispatch.spec.ts.
 */

describe('Phase R — pattern binding parsing (§6.5)', () => {
  it('var riff = (1, 0, (3, 5), 7) → pattern_binding with one nested element', () => {
    const stmt = parseAudioDSL('var riff = (1, 0, (3, 5), 7)').statements[0] as any
    expect(stmt.type).toBe('pattern_binding')
    expect(stmt.variableName).toBe('riff')
    expect(stmt.elements).toHaveLength(1)
    expect(stmt.elements[0]).toMatchObject({ type: 'nested' })
    expect(stmt.elements[0].elements[2]).toMatchObject({ type: 'nested', elements: [3, 5] })
  })

  it('var A = (1, 0, 5, 0).root(3) → a chained value (one scoped element)', () => {
    const stmt = parseAudioDSL('var A = (1, 0, 5, 0).root(3)').statements[0] as any
    expect(stmt.type).toBe('pattern_binding')
    expect(stmt.elements).toHaveLength(1)
    expect(stmt.elements[0]).toMatchObject({ type: 'scoped', root: { kind: 'degree', degree: 3 } })
  })

  it('var AA = (1, 0, 5, 0)(0, 5, 1, 0) → a juxtaposition binding (two siblings)', () => {
    const stmt = parseAudioDSL('var AA = (1, 0, 5, 0)(0, 5, 1, 0)').statements[0] as any
    expect(stmt.type).toBe('pattern_binding')
    expect(stmt.elements).toHaveLength(2)
    expect(stmt.elements[0]).toMatchObject({ type: 'nested', elements: [1, 0, 5, 0] })
    expect(stmt.elements[1]).toMatchObject({ type: 'nested', elements: [0, 5, 1, 0] })
  })

  it('a top-level comma in a binding is rejected (§6.5 — use juxtaposition)', () => {
    expect(() => parseAudioDSL('var x = (1, 0), (5, 0)')).toThrow(/juxtaposition|single cell/)
  })

  it('init declarations are unaffected (regression)', () => {
    expect(parseAudioDSL('var g = init GLOBAL').globalInit).toMatchObject({ type: 'global_init' })
  })
})
