import { describe, it, expect } from 'vitest'

import { parseSourceToIR } from '../../packages/engine/src/parser/parser'
import {
  barDurationSeconds,
  durationToSeconds,
  nextBoundaryAcrossSequences,
  Scheduler,
} from '../../packages/engine/src/scheduler'
import { TestMidiSink } from '../../packages/engine/src/midi'

const src = `
key C
tempo 120
meter 4/4 shared

sequence a {
  channel 1
  tempo 90
  meter 5/4 independent
}

sequence b {
  channel 2
  tempo 140
  meter 4/4 shared
}
`

describe('polymeter with different tempos (independent vs shared)', () => {
  it('computes bar durations correctly per align/tempo', () => {
    const ir = parseSourceToIR(src)
    const [seqA, seqB] = ir.sequences

    const barA = barDurationSeconds(seqA, ir) // independent uses seq tempo (90bpm) and meter (5/4)
    const barB = barDurationSeconds(seqB, ir) // shared uses global tempo (120bpm) and meter (4/4)

    // 90bpm: sec/quarter = 60/90 = 0.666..., 5/4 bar = 5 * 0.666... = 3.333...
    expect(barA).toBeCloseTo(60 / 90 * 5, 5)
    // 120bpm: sec/quarter = 0.5, 4/4 bar = 4 * 0.5 = 2.0
    expect(barB).toBeCloseTo(2.0, 5)
  })

  it('quantizes next boundary across sequences with mixed align/tempos', () => {
    const ir = parseSourceToIR(src)
    const sched = new Scheduler(new TestMidiSink() as any, ir)

    sched.setCurrentTimeSec(1.9)
    const b1 = nextBoundaryAcrossSequences(1.9 + 1e-9, ir)
    expect(b1).toBeCloseTo(2.0, 5) // seqB boundary at 2.0 is min

    sched.setCurrentTimeSec(3.9)
    const b2 = nextBoundaryAcrossSequences(3.9 + 1e-9, ir)
    expect(b2).toBeCloseTo(4.0, 5) // seqB boundary at 4.0 is min vs seqA 3.333->6.666
  })

  it('converts unit and percent durations with correct tempo base', () => {
    const ir = parseSourceToIR(src)
    const [seqA, seqB] = ir.sequences

    // U1: independent uses seq tempo (90bpm) => 0.666...
    expect(durationToSeconds({ kind: 'unit', value: 1 }, seqA, ir)).toBeCloseTo(60 / 90, 5)

    // U1: shared uses global tempo (120bpm) => 0.5 (even if seq tempo=140)
    expect(durationToSeconds({ kind: 'unit', value: 1 }, seqB, ir)).toBeCloseTo(0.5, 5)

    // percent: independent uses seq meter/tempo (90bpm, 5/4) => 50% of 2 bars = 3.333...
    expect(
      durationToSeconds({ kind: 'percent', percent: 50, bars: 2 }, seqA, ir),
    ).toBeCloseTo((60 / 90) * 5 * 1, 5)

    // percent: shared uses global meter/tempo => 25% of 1 bar = 0.5
    expect(
      durationToSeconds({ kind: 'percent', percent: 25, bars: 1 }, seqB, ir),
    ).toBeCloseTo(0.5, 5)
  })
})
