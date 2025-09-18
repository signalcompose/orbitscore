import { describe, it, expect } from 'vitest'
import { parseSourceToIR } from '../../packages/engine/src/parser/parser'
import { Scheduler } from '../../packages/engine/src/scheduler'
import { TestMidiSink } from '../../packages/engine/src/midi'

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

describe('transport across sequences', () => {
  it('advances to min boundary across sequences with jump/loop application', () => {
    const ir = parseSourceToIR(src)
    const sched = new Scheduler(new TestMidiSink() as any, ir)

    sched.setCurrentTimeSec(2.1)
    // next min boundary = 2.5 (a)
    sched.simulateTransportAdvanceAcrossSequences(0.6)
    expect(sched.getCurrentTimeSec()).toBeCloseTo(2.5, 3)

    // jump at next boundary
    sched.setCurrentTimeSec(3.9)
    sched.requestJump(5)
    sched.simulateTransportAdvanceAcrossSequences(0.2) // boundary 4.0 -> jump to 10.0
    expect(sched.getCurrentTimeSec()).toBeCloseTo(10.0, 3)

    // loop 2..4 bars (global shared) → boundary at 8.0 wraps to 4.0
    sched.setLoop({ enabled: true, startBar: 2, endBar: 4 })
    sched.setCurrentTimeSec(7.9)
    sched.simulateTransportAdvanceAcrossSequences(0.2)
    expect(sched.getCurrentTimeSec()).toBeCloseTo(4.0, 3)
  })
})
