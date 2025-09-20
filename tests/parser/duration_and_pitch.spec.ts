import { describe, it, expect } from 'vitest'

import { parseSourceToIR } from '../../packages/engine/src/parser/parser'

describe('Parser - duration tuplet and pitch suffix', () => {
  it('parses tuplet @[3:2]*U1 and unit/second/percent correctly', () => {
    const src = `
key C
tempo 120
meter 4/4 shared
sequence s { channel 1 bus "IAC"
  5@U1  5@2s  5@25%2bars  5@[3:2]*U1
}
`
    const ir = parseSourceToIR(src)
    expect(ir.sequences).toHaveLength(1)
    const evs = ir.sequences[0]!.events
    expect(evs).toHaveLength(4)
    expect(evs[0]!.kind).toBe('note')
    expect((evs[0] as any).dur).toEqual({ kind: 'unit', value: 1 })
    expect((evs[1] as any).dur).toEqual({ kind: 'sec', value: 2 })
    expect((evs[2] as any).dur).toEqual({ kind: 'percent', percent: 25, bars: 2 })
    expect((evs[3] as any).dur).toEqual({
      kind: 'tuplet',
      a: 3,
      b: 2,
      base: { kind: 'unit', value: 1 },
    })
  })

  it('accepts singular "bar" in percent duration', () => {
    const src = `
key C
tempo 120
meter 4/4 shared
sequence s { channel 1 bus "IAC"
  5@25%1bar
}
`
    const ir = parseSourceToIR(src)
    const evs = ir.sequences[0]!.events
    expect((evs[0] as any).dur).toEqual({ kind: 'percent', percent: 25, bars: 1 })
  })

  it('parses single-note detune (~) and octave shift (^) suffixes', () => {
    const src = `
key C
tempo 120
meter 4/4 shared
sequence s { channel 1 bus "IAC"
  3~+0.5^+1@U1  0@U1
}
`
    const ir = parseSourceToIR(src)
    const evs = ir.sequences[0]!.events
    expect(evs[0]!.kind).toBe('note')
    const note = evs[0] as any
    expect(note.pitches[0]).toEqual({ degree: 3, degreeRaw: '3', detune: 0.5, octaveShift: 1 })
    expect(evs[1]!.kind).toBe('rest')
  })
})
