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
  octave 0.0
  1@U1 1@U1 1@U1 1@U1
}
`

describe('reschedule without duplicates', () => {
  it('avoids duplicates after resetSchedule and re-schedule', () => {
    const ir = parseSourceToIR(src)
    const sink = new TestMidiSink()
    const sched = new Scheduler(sink as any, ir)

    sched.scheduleThrough(600)
    const firstCount = sink.sent.length

    // simulate jump: reset and re-schedule overlapping window (keep sent cache)
    sched.resetSchedule(0)
    sched.scheduleThrough(600)

    // count should not double
    expect(sink.sent.length).toBe(firstCount)
  })
})
