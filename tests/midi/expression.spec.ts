import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/**
 * E5 (#262) — per-note expression (§10.3): `@v100` absolute velocity / `@v±n` relative
 * (accent) / `@g30` articulation as a gate PERCENT (30 = 0.30, 120 = 1.20). `@v` overrides
 * seq.vel(), `@g` overrides seq.gate() for that note. `@u` absolute duration is rejected (#41).
 */

describe('E5 — expression parse shape (§10.3)', () => {
  const arg = (src: string) => (parseAudioDSL(`p.play(${src})`).statements[0] as any).args[0]

  it('`5@v100` → absolute velocity 100', () => {
    expect(arg('5@v100')).toMatchObject({ type: 'pitch', degree: 5, velocity: 100 })
  })

  it('`5@v+20` / `5@v-30` → relative velocity (accent)', () => {
    expect(arg('5@v+20')).toMatchObject({ degree: 5, velocityDelta: 20 })
    expect(arg('5@v-30')).toMatchObject({ degree: 5, velocityDelta: -30 })
  })

  it('`5@g30` → articulation (gate ratio) 0.3', () => {
    expect(arg('5@g30')).toMatchObject({ degree: 5, articulation: 0.3 })
  })

  it('`5@v100@g30` → velocity and articulation compose', () => {
    expect(arg('5@v100@g30')).toMatchObject({ degree: 5, velocity: 100, articulation: 0.3 })
  })

  it('`@x` is rejected (only @v / @g)', () => {
    expect(() => parseAudioDSL('p.play(5@x9)')).toThrow(/@v.*@g|velocity.*articulation/)
  })
})

// ── dispatch harness: capture note-on velocity + note-off time ──
const T0 = 1_000_000
type On = { note: number; vel: number }
function recordingOutput(on: On[], offT: Record<number, number>): MidiOutput {
  return {
    ensurePort: vi.fn((q: string) => (/iac/i.test(q) ? 'IACドライバ バス1' : q)),
    noteOn: vi.fn((_p: string, _c: number, note: number, vel: number) => on.push({ note, vel })),
    noteOff: vi.fn((_p: string, _c: number, note: number) => (offT[note] = Date.now() - T0)),
    pitchBend: vi.fn(),
    releaseOwner: vi.fn(),
    panic: vi.fn(),
    getActiveNotes: vi.fn(() => []),
    listPorts: vi.fn(() => ['IACドライバ バス1']),
    closeAll: vi.fn(),
  }
}
function mockScheduler() {
  return {
    isRunning: true,
    startTime: T0,
    getCurrentTime: () => 0,
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    getMasterGainDb: () => 0,
  } as never
}
async function play(src: string): Promise<{ on: On[]; offT: Record<number, number> }> {
  vi.setSystemTime(T0)
  const sched = mockScheduler()
  const on: On[] = []
  const offT: Record<number, number> = {}
  const global = new Global(sched, new MidiManager(() => recordingOutput(on, offT)))
  global.key('C')
  global.start()
  const seq = new Sequence(global, sched)
  seq.setName('piano')
  seq.midi('iac', 1).octave(4) // default vel 96, gate 0.8
  seq.play(...(parseAudioDSL(`p.play(${src})`).statements[0].args as never[]))
  await seq.run()
  await vi.advanceTimersByTimeAsync(3000)
  return { on, offT }
}

describe('E5 — expression dispatch (§10.3)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('`@v` sets the MIDI velocity (absolute and relative to seq.vel()=96)', async () => {
    expect((await play('5@v100')).on[0]!.vel).toBe(100)
    expect((await play('5@v+20')).on[0]!.vel).toBe(116) // 96 + 20
    expect((await play('5@v-50')).on[0]!.vel).toBe(46) // 96 - 50
    expect((await play('5')).on[0]!.vel).toBe(96) // default
  })

  it('`@g` shortens (staccato) / lengthens the sounding duration vs the default gate', async () => {
    const stacc = (await play('5@g20')).offT[67]! // G4 = 67, gate 0.20
    const sustained = (await play('5@g90')).offT[67]! // gate 0.90
    expect(stacc).toBeLessThan(sustained) // staccato rings far shorter
  })
})
