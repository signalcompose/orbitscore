import { describe, it, expect } from 'vitest'

import { parseSourceToIR } from '../../packages/engine/src/parser/parser'
import { nextBoundaryAcrossSequences } from '../../packages/engine/src/scheduler'

const src = `
key C
tempo 120
meter 4/4 shared

sequence a {
  channel 1
  tempo 120
  meter 5/4 independent
}

sequence b {
  channel 2
  tempo 120
  meter 4/4 shared
}
`

describe('nextBoundaryAcrossSequences', () => {
  it('returns min of per-sequence next bar heads', () => {
    const ir = parseSourceToIR(src)
    // at t=2.1s: a(independent 5/4)=>2.5, b(shared 4/4)=>4.0 → min=2.5
    const next = nextBoundaryAcrossSequences(2.1, ir)
    expect(next).toBeCloseTo(2.5, 3)
  })
})
