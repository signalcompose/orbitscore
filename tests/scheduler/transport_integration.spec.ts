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
  meter 4/4 shared
  octave 0.0
  1@U1 1@U1 1@U1 1@U1
}

sequence b {
  channel 2
  tempo 120
  meter 4/4 shared
  octave 0.0
  5@U1 5@U1 5@U1 5@U1
}
`

describe('transport integration with real-time scheduling', () => {
  it('applies jump at bar boundary during real-time playback', () => {
    const ir = parseSourceToIR(src)
    const sink = new TestMidiSink()
    const sched = new Scheduler(sink as any, ir)

    // Set up jump to bar 2
    sched.setCurrentTimeSec(0.5) // mid-bar
    sched.requestJump(2) // jump to bar 2

    // Simulate transport advance (should apply jump at bar 1 boundary)
    sched.simulateTransportAdvanceAcrossSequences(3.0) // advance enough to reach bar 1 boundary

    // Should have jumped to bar 2 (bar indexing starts from 0, so bar 2 = 4.0s)
    expect(sched.getCurrentTimeSec()).toBeCloseTo(4.0, 3) // bar 2 = 4.0s at 120bpm
    expect(sched.getGlobalPlayheadBarBeat().bar).toBe(2)
  })

  it('applies loop at bar boundary during real-time playback', () => {
    const ir = parseSourceToIR(src)
    const sink = new TestMidiSink()
    const sched = new Scheduler(sink as any, ir)

    // Set up loop from bar 1 to bar 2
    sched.setLoop({ enabled: true, startBar: 1, endBar: 2 })

    // Start at bar 1.5 (3.0s) and advance to cross bar 2 boundary (4.0s)
    sched.setCurrentTimeSec(3.5) // bar 1.75 (between bar 1 and bar 2)
    sched.simulateTransportAdvanceAcrossSequences(0.6) // advance past bar 2 boundary at 4.0s

    // Should have looped back to bar 1 (bar indexing starts from 0, so bar 1 = 2.0s)
    // When hitting loop boundary, we just jump back without overflow
    expect(sched.getCurrentTimeSec()).toBeCloseTo(2.0, 3) // bar 1 exactly
    expect(sched.getGlobalPlayheadBarBeat().bar).toBe(1)
  })

  it('handles mixed shared/independent sequences with transport', () => {
    const mixedSrc = `
key C
tempo 120
meter 4/4 shared

sequence sharedSeq {
  channel 1
  meter 4/4 shared
  octave 0.0
  1@U1 1@U1 1@U1 1@U1
}

sequence indepSeq {
  channel 2
  tempo 90
  meter 5/4 independent
  octave 0.0
  5@U1 5@U1 5@U1 5@U1 5@U1
}
`

    const ir = parseSourceToIR(mixedSrc)
    const sink = new TestMidiSink()
    const sched = new Scheduler(sink as any, ir)

    // Set up jump
    sched.setCurrentTimeSec(1.0)
    sched.requestJump(3)

    // Advance - should jump at next boundary (shared=2.0s, independent=3.33s)
    sched.simulateTransportAdvanceAcrossSequences(1.5)

    // Should jump to bar 3 (6.0s at 120bpm shared)
    expect(sched.getCurrentTimeSec()).toBeCloseTo(6.0, 3)
    expect(sched.getGlobalPlayheadBarBeat().bar).toBe(3)
  })
})
