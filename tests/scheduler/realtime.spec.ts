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

describe('Scheduler realtime windowing (minimal)', () => {
  it('schedules messages progressively with scheduleThrough', () => {
    const ir = parseSourceToIR(src)
    const sink = new TestMidiSink()
    const sched = new Scheduler(sink as any, ir)

    // first 600ms
    sched['scheduledUntilMs'] = 0 as any // start at 0
    sched.scheduleThrough(600)
    expect(sink.sent.some((m) => m.timeMs === 0)).toBe(true)
    expect(sink.sent.some((m) => m.timeMs === 500)).toBe(true)
    expect(sink.sent.some((m) => m.timeMs === 1000)).toBe(false)

    // next step to 1100ms
    sched.scheduleThrough(1100)
    expect(sink.sent.some((m) => m.timeMs === 1000)).toBe(true)
  })
})
