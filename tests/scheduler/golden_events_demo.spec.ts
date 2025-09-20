import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, it, expect } from 'vitest'

import { parseSourceToIR } from '../../packages/engine/src/parser/parser'
import { Scheduler } from '../../packages/engine/src/scheduler'
import { TestMidiSink } from '../../packages/engine/src/midi'

const demoPath = path.resolve(__dirname, '../../examples/demo.osc')
const goldenPath = path.resolve(__dirname, 'golden_events_demo.json')

describe('demo.osc golden events validation (±5ms precision)', () => {
  it('generates expected MIDI events for demo.osc', () => {
    const src = fs.readFileSync(demoPath, 'utf8')
    const ir = parseSourceToIR(src)
    const sink = new TestMidiSink()
    const sched = new Scheduler(sink as any, ir)

    // Render all events offline
    const messages = sched.renderOffline()

    // Expected events based on demo.osc:
    // - Chord: (1@U0.5, 5@U1, 8@U0.25) at t=0
    //   * 1@U0.5: degree=1, duration=0.5 units at 132bpm independent
    //   * 5@U1: degree=5, duration=1 unit at 132bpm independent
    //   * 8@U0.25: degree=8, duration=0.25 units at 132bpm independent
    // - Rest: 0@U0.5 at t=chord_end
    // - Note: 3@2s at t=rest_end
    // - Note: 12@25%2bars at t=note_end

    // Calculate expected timings:
    // 132bpm independent: sec/unit = 60/132 = 0.4545...
    // Chord durations: 0.5*0.4545=0.227, 1*0.4545=0.4545, 0.25*0.4545=0.1136
    // Group duration = max(0.227, 0.4545, 0.1136) = 0.4545
    // Rest: 0.5*0.4545 = 0.227
    // Note1: 2s
    // Note2: 25% of 2 bars at 132bpm independent 5/4 = 25% of 2*5*0.4545 = 25% of 4.545 = 1.136

    const expectedEvents = [
      // Chord at t=0 - NoteOn events
      // With octave=4.0: base MIDI = 60 + degree_semitones + 4*12 = 60 + degree_semitones + 48
      // degree=1 (C) -> 60+0+48 = 108
      // degree=5 (E) -> 60+4+48 = 112
      // degree=8 (G) -> 60+7+48 = 115
      { timeMs: 0, status: 0x90, data1: 108, data2: 100 }, // NoteOn: degree=1 -> C8
      { timeMs: 0, status: 0x90, data1: 112, data2: 100 }, // NoteOn: degree=5 -> E8
      { timeMs: 0, status: 0x90, data1: 115, data2: 100 }, // NoteOn: degree=8 -> G8

      // Chord NoteOff events (sorted by duration: 0.25, 0.5, 1.0 units)
      { timeMs: 114, status: 0x80, data1: 115, data2: 0 }, // NoteOff: degree=8 (0.25 units)
      { timeMs: 227, status: 0x80, data1: 108, data2: 0 }, // NoteOff: degree=1 (0.5 units)
      { timeMs: 455, status: 0x80, data1: 112, data2: 0 }, // NoteOff: degree=5 (1.0 units)

      // Rest: 0@U0.5 (no MIDI events)

      // Note: 3@2s at t=0.4545+0.227=0.6815
      // degree=3 (D) -> 60+2+48 = 110
      { timeMs: 682, status: 0x90, data1: 110, data2: 100 }, // NoteOn: degree=3 -> D8
      { timeMs: 2682, status: 0x80, data1: 110, data2: 0 }, // NoteOff: degree=3 (2s later)

      // Note: 12@25%2bars at t=0.6815+2000=2681.5
      // degree=12 (B) -> 60+11+48 = 119
      { timeMs: 2682, status: 0x90, data1: 119, data2: 100 }, // NoteOn: degree=12 -> B8
      { timeMs: 3818, status: 0x80, data1: 119, data2: 0 }, // NoteOff: degree=12 (25% of 2 bars later)
    ]

    // Validate message count
    expect(messages.length).toBe(expectedEvents.length)

    // Validate each event with ±5ms tolerance
    for (let i = 0; i < expectedEvents.length; i++) {
      const expected = expectedEvents[i]
      const actual = messages[i]

      expect(actual.timeMs).toBeCloseTo(expected.timeMs, 0) // ±5ms = 0 decimal places
      expect(actual.status).toBe(expected.status)
      expect(actual.data1).toBe(expected.data1)
      expect(actual.data2).toBe(expected.data2)
    }

    // Save golden file for future reference
    const goldenData = {
      source: 'demo.osc',
      generated: new Date().toISOString(),
      events: messages.map((m) => ({
        timeMs: m.timeMs,
        status: m.status,
        data1: m.data1,
        data2: m.data2,
        description: getEventDescription(m),
      })),
    }

    fs.writeFileSync(goldenPath, JSON.stringify(goldenData, null, 2))
    console.log(`Golden events saved to: ${goldenPath}`)
  })
})

function getEventDescription(msg: any): string {
  const channel = (msg.status & 0x0f) + 1
  const isNoteOn = (msg.status & 0xf0) === 0x90
  const isNoteOff = (msg.status & 0xf0) === 0x80

  if (isNoteOn) {
    return `NoteOn Ch${channel} Note${msg.data1} Vel${msg.data2}`
  } else if (isNoteOff) {
    return `NoteOff Ch${channel} Note${msg.data1} Vel${msg.data2}`
  }
  return `MIDI ${msg.status.toString(16)} ${msg.data1} ${msg.data2}`
}
