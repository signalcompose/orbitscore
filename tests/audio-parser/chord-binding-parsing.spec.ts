import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Phase 3 (#231) — `import chords` / `var X = [...]` chord-value parsing + bare
 * chord-name group elements (§6, §9.1). Statement shape only; resolution and MIDI
 * dispatch are covered in tests/core/sequence-chord-dispatch.spec.ts. (§6 decision
 * #48: chord values are bare `[ ]` literals; the `chord([...])` wrapper was removed.)
 */

describe('Phase 3 — import chords parsing', () => {
  it('`import chords` → an import statement', () => {
    expect(parseAudioDSL('import chords').statements[0]).toEqual({
      type: 'import',
      module: 'chords',
    })
  })

  it('an unknown import throws', () => {
    expect(() => parseAudioDSL('import scales')).toThrow(/only.*import chords/i)
  })
})

describe('§6 — bare `[ ]` chord-value parsing (decision #48)', () => {
  it('`var m7 = [1, b3, 5, b7]` → a chord_binding with raw voices', () => {
    const stmt = parseAudioDSL('var m7 = [1, b3, 5, b7]').statements[0] as any
    expect(stmt.type).toBe('chord_binding')
    expect(stmt.variableName).toBe('m7')
    expect(stmt.voices[0]).toBe(1)
    expect(stmt.voices[1]).toMatchObject({
      type: 'pitch',
      degree: 3,
      alteration: -1,
      rangeSet: false,
    })
    expect(stmt.voices[2]).toBe(5)
    expect(stmt.voices[3]).toMatchObject({ type: 'pitch', degree: 7, alteration: -1 })
  })

  it('`var m7omit5 = [m7, -5]` keeps the ref + removal markers raw', () => {
    const stmt = parseAudioDSL('var m7omit5 = [m7, -5]').statements[0] as any
    expect(stmt.type).toBe('chord_binding')
    expect(stmt.voices[0]).toEqual({ type: 'chord_ref', name: 'm7', octaveShift: 0 })
    expect(stmt.voices[1]).toEqual({ type: 'chord_removal', degree: 5, alteration: 0 })
  })

  it('the removed `chord([...])` wrapper throws a migration error', () => {
    expect(() => parseAudioDSL('var m7 = chord([1, b3, 5, b7])')).toThrow(/chord\(\[/)
  })
})

describe('Phase 3 — init declarations are unaffected (regression)', () => {
  it('`var g = init GLOBAL` still parses to a global init', () => {
    expect(parseAudioDSL('var g = init GLOBAL').globalInit).toEqual({
      type: 'global_init',
      variableName: 'g',
    })
  })

  it('`var s = init g.seq` still parses to a sequence init', () => {
    const ir = parseAudioDSL('var g = init GLOBAL\nvar s = init g.seq')
    expect(ir.sequenceInits[0]).toMatchObject({ type: 'seq_init', variableName: 's' })
  })
})

describe('Phase 3 — bare chord name as a group element (§9.1)', () => {
  it('(0, m7, 0, m7).root(3) → chord_ref elements inside the scoped group', () => {
    const scoped = parseAudioDSL('piano.play((0, m7, 0, m7).root(3))').statements[0].args[0] as any
    expect(scoped.type).toBe('scoped')
    const els = scoped.groups[0].elements
    expect(els[0]).toBe(0)
    expect(els[1]).toEqual({ type: 'chord_ref', name: 'm7', octaveShift: 0 })
    expect(els[2]).toBe(0)
    expect(els[3]).toEqual({ type: 'chord_ref', name: 'm7', octaveShift: 0 })
  })
})
