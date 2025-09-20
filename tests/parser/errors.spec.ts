import { describe, it, expect } from 'vitest'

import { parseSourceToIR } from '../../packages/engine/src/parser/parser'

describe('Parser - error messages', () => {
  it('reports length for invalid tuplet base identifier', () => {
    const src = `
key C
tempo 120
meter 4/4 shared
sequence s { channel 1 bus "IAC"
  5@[3:2]*X1
}
`

    try {
      parseSourceToIR(src)
      expect.fail('should have thrown')
    } catch (error: any) {
      const s = String(error)
      expect(s).toMatch(
        /Expected U<value> after tuplet, got 'X1' at line \d+, column \d+, length 2/,
      )
    }
  })

  it('reports column/length when number after % is missing', () => {
    const src = `
key C
tempo 120
meter 4/4 shared
sequence s { channel 1 bus "IAC"
  5@25%bars
}
`

    try {
      parseSourceToIR(src)
      expect.fail('should have thrown')
    } catch (error: any) {
      const s = String(error)
      // Expect NUMBER here, got IDENTIFIER 'bars'
      expect(s).toMatch(
        /Expected NUMBER, got IDENTIFIER \('bars'\) at line \d+, column \d+, length 4/,
      )
    }
  })
})
