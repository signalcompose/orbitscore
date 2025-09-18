import { describe, it, expect } from 'vitest'

import { parseSourceToIR } from '../../packages/engine/src/parser/parser'
import { Scheduler } from '../../packages/engine/src/scheduler'
import { TestMidiSink } from '../../packages/engine/src/midi'

const src = `
key C
tempo 120
meter 4/4 shared

sequence s {
  channel 1
  tempo 120
  meter 4/4 shared
}
`

describe('Scheduler transport minimal state', () => {
  it('applies jump at next bar and loops at endBar', () => {
    const ir = parseSourceToIR(src)
    const sched = new Scheduler(new TestMidiSink() as any, ir)

    // set time near 1st bar end
    sched.setCurrentTimeSec(1.9) // bar=2.0

    // request jump to bar 5 (=> 10.0s)
    sched.requestJump(5)
    sched.simulateTransportAdvance(0.2) // reach boundary (2.0)
    expect(sched.getCurrentTimeSec()).toBeCloseTo(10.0, 3)

    // set loop 2..4 bars (4.0..8.0)
    sched.setLoop({ enabled: true, startBar: 2, endBar: 4 })
    sched.setCurrentTimeSec(7.9) // next boundary = 8.0 => wraps to 4.0
    sched.simulateTransportAdvance(0.2)
    expect(sched.getCurrentTimeSec()).toBeCloseTo(4.0, 3)
  })
})
