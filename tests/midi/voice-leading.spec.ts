import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { voiceLeadOctaves } from '../../packages/engine/src/midi/voice-leading'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/**
 * C1 (#269) — auto voice-leading `.voicelead()` / `.vl()` (§6.3). Successive chord
 * stacks are octave-placed to minimize total voice motion (Tymoczko L1). Deterministic,
 * computed once; pitch classes preserved (only octave changes). The pure kernel is
 * asserted directly; the wiring is asserted at dispatch over the note-ons.
 */

describe('C1 — voiceLeadOctaves kernel (§6.3)', () => {
  it('the first chord (no previous) gets no shift', () => {
    expect(voiceLeadOctaves([], [60, 64, 67])).toEqual([0, 0, 0])
  })

  it('an already-aligned chord is left in place', () => {
    expect(voiceLeadOctaves([60, 64, 67], [60, 64, 67])).toEqual([0, 0, 0])
  })

  it('retains common tones / pulls an octave-low chord up (distance 0)', () => {
    expect(voiceLeadOctaves([60, 64, 67], [48, 52, 55])).toEqual([1, 1, 1])
  })

  it('pulls an octave-high chord down', () => {
    expect(voiceLeadOctaves([60, 64, 67], [72, 76, 79])).toEqual([-1, -1, -1])
  })

  it('C→G: the B drops an octave to stay near C/E/G (min motion picks a rotation)', () => {
    // prev C E G [60,64,67]; cur G B D base [67,71,62] → G stays, B(71)→59, D stays
    expect(voiceLeadOctaves([60, 64, 67], [67, 71, 62])).toEqual([0, -1, 0])
  })

  it('unequal cardinality: leads min(n,m) voices, extras stay at octave 0', () => {
    expect(voiceLeadOctaves([60], [48, 52, 55])).toEqual([1, 0, 0]) // only the lowest is led
    expect(voiceLeadOctaves([60, 64, 67], [48, 52])).toEqual([1, 1]) // both led, no extras
  })
})

// ── dispatch harness: capture note-ons over the bar ──
const T0 = 1_000_000
function recordingOutput(log: number[]): MidiOutput {
  return {
    ensurePort: vi.fn((q: string) => (/iac/i.test(q) ? 'IACドライバ バス1' : q)),
    noteOn: vi.fn((_p: string, _c: number, note: number) => log.push(note)),
    noteOff: vi.fn(),
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
/** key C, octave 4; play `src`; return the note-ons (one bar). */
async function ons(src: string): Promise<number[]> {
  vi.setSystemTime(T0)
  const sched = mockScheduler()
  const log: number[] = []
  const global = new Global(sched, new MidiManager(() => recordingOutput(log)))
  global.key('C')
  global.start()
  const seq = new Sequence(global, sched)
  seq.setName('piano')
  seq.midi('iac', 1).octave(4)
  seq.play(...(parseAudioDSL(`p.play(${src})`).statements[0].args as never[]))
  await seq.run()
  await vi.advanceTimersByTimeAsync(2100)
  return log
}

describe('C1 — voice-leading dispatch (§6.3)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('parses `.voicelead()` / `.vl()` as a group scope', () => {
    const a = (parseAudioDSL('p.play(([1,3,5], [5,7,2]).voicelead())').statements[0] as any).args[0]
    expect(a).toMatchObject({ type: 'scoped', voicelead: true })
    const b = (parseAudioDSL('p.play(([1,3,5]).vl())').statements[0] as any).args[0]
    expect(b).toMatchObject({ type: 'scoped', voicelead: true })
  })

  it('C→G under `.voicelead()`: the B is voice-led down an octave (B3=59, not B4=71)', async () => {
    const led = await ons('([1,3,5], [5,7,2]).voicelead()')
    expect(led).toContain(59) // B3 — voice-led down
    expect(led).not.toContain(71) // not B4
    expect(led).toContain(67) // G common tone retained
    // baseline without voice-leading keeps the B at B4 (71)
    const plain = await ons('([1,3,5], [5,7,2])')
    expect(plain).toContain(71)
    expect(plain).not.toContain(59)
  })

  it('`seq.voicelead()` as a sequence default voice-leads every chord', async () => {
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    const log: number[] = []
    const global = new Global(sched, new MidiManager(() => recordingOutput(log)))
    global.key('C')
    global.start()
    const seq = new Sequence(global, sched)
    seq.setName('piano')
    seq.midi('iac', 1).octave(4).voicelead()
    seq.play(...(parseAudioDSL('p.play([1,3,5], [5,7,2])').statements[0].args as never[]))
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)
    expect(log).toContain(59) // B voice-led down even with seq-level .voicelead()
  })

  it('the first chord keeps its authored octave; only later chords are re-placed', async () => {
    // chord1 [1,3,5] anchors at C4/E4/G4 (60/64/67); chord2 leads from it.
    const led = await ons('([1,3,5], [5,7,2]).voicelead()')
    expect(led).toContain(60) // C4 anchor
    expect(led).toContain(64) // E4 anchor
    expect(led).toContain(67) // G4 anchor
  })

  it('without `.voicelead()` the kernel does not run (chords stay at authored octave)', async () => {
    const plain = await ons('([1,3,5], [4,6,1])')
    // F major [4,6,1] at base = F4(65) A4(69) C4(60); unchanged without VL
    expect(plain).toEqual(expect.arrayContaining([60, 64, 67, 65, 69, 60]))
  })
})
