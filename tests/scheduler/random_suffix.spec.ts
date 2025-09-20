import { describe, it, expect } from 'vitest'

import { parseSourceToIR } from '../../packages/engine/src/parser/parser'
import { Scheduler } from '../../packages/engine/src/scheduler'
import { TestMidiSink } from '../../packages/engine/src/midi'

const srcWithR = `
key C
tempo 120
meter 4/4 shared
randseed 12345

sequence lead {
  channel 1
  tempo 120
  meter 4/4 shared
  octave 4.0
  1.0r@U1  1.0r@U1
}
`

const srcWithoutR = `
key C
tempo 120
meter 4/4 shared

sequence lead {
  channel 1
  tempo 120
  meter 4/4 shared
  octave 4.0
  1.0@U1  1.0@U1
}
`

function extractNoteOn(messages: any[]) {
  return messages.filter((m) => (m.status & 0xf0) === 0x90)
}

describe('Scheduler - random suffix end-to-end', () => {
  it('applies deterministic randomness for degree with r suffix using randseed', () => {
    const ir = parseSourceToIR(srcWithR)
    const sink = new TestMidiSink()
    const sched = new Scheduler(sink as any, ir)
    const msgs = sched.renderOffline()
    const noteOns = extractNoteOn(msgs)

    expect(noteOns.length).toBe(2)
    // 同じrandseedと同じ '1.0r' は、音高/ピッチベンドが一致する（時間だけ異なる）
    const first = noteOns[0]
    const second = noteOns[1]
    expect(first.data1).toBe(second.data1)
    // 直前にPitchBendが送られているはずなので、NoteOn直前のPitchBend値も確認
    const firstBend = msgs
      .filter((m) => m.timeMs === first.timeMs && (m.status & 0xf0) === 0xe0)
      .at(0)
    const secondBend = msgs
      .filter((m) => m.timeMs === second.timeMs && (m.status & 0xf0) === 0xe0)
      .at(0)
    expect(firstBend?.data1).toBe(secondBend?.data1)
    expect(firstBend?.data2).toBe(secondBend?.data2)
  })

  it('does not randomize without r suffix', () => {
    const ir = parseSourceToIR(srcWithoutR)
    const sink = new TestMidiSink()
    const sched = new Scheduler(sink as any, ir)
    const msgs = sched.renderOffline()
    const noteOns = extractNoteOn(msgs)

    expect(noteOns.length).toBe(2)
    // ランダムなし→2発とも同じ度数→同じノート。ただしPitchBendは0のはず（detuneなし）
    expect(noteOns[0].data1).toBe(noteOns[1].data1)
    // 同時刻PitchBendの有無を軽く確認（存在しても0近辺に丸められる）
    const bends = msgs.filter((m) => (m.status & 0xf0) === 0xe0)
    // detuneがなければPitchBendは送られない想定
    expect(bends.length).toBe(0)
  })
})
