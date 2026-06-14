import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/**
 * E6 (mode scope, §2.2) — `var X = mode(1, 2, b3, …)` builds a pitch lattice (semitone
 * offsets, degree 1 = lattice[0]); `(...).mode(X)` indexes the lattice instead of Ionian.
 * `.period(n)` overrides the default repeat period (octave boundary above the last element).
 */

describe('E6 — mode binding parse (§2.2)', () => {
  it('`mode(1,2,b3,4,5,6,b7)` → the dorian lattice [0,2,3,5,7,9,10], period 12', () => {
    const stmt = parseAudioDSL('var dorian = mode(1, 2, b3, 4, 5, 6, b7)').statements[0] as any
    expect(stmt).toMatchObject({ type: 'mode_binding', variableName: 'dorian', period: 12 })
    expect(stmt.lattice).toEqual([0, 2, 3, 5, 7, 9, 10])
  })

  it('`.period(19)` overrides the default period', () => {
    const stmt = parseAudioDSL('var bohlen = mode(1, 2, b3).period(19)').statements[0] as any
    expect(stmt.period).toBe(19)
    expect(stmt.lattice).toEqual([0, 2, 3])
  })

  it('a two-octave mode rounds the default period up to the next octave boundary', () => {
    // last element 7^+1 = 11 + 12 = 23 → default period = 24
    const stmt = parseAudioDSL('var wide = mode(1, 3, 5, 7^+1)').statements[0] as any
    expect(stmt.lattice).toEqual([0, 4, 7, 23])
    expect(stmt.period).toBe(24)
  })

  it('a below-tonic last element does not yield a zero/negative default period', () => {
    // 7^-1 = -1 (a below-tonic element); the default period must use the max (0) → 12, not 0
    const stmt = parseAudioDSL('var m = mode(1, 7^-1)').statements[0] as any
    expect(stmt.lattice).toEqual([0, -1])
    expect(stmt.period).toBe(12)
  })
})

// ── dispatch harness: define a mode, play degrees under `.mode()` ──
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
/** key C, octave 4; define `dorian`; play `src`; return the note-ons. */
async function playInDorian(src: string): Promise<number[]> {
  vi.setSystemTime(T0)
  const sched = mockScheduler()
  const ons: number[] = []
  const global = new Global(sched, new MidiManager(() => recordingOutput(ons)))
  global.key('C')
  global.defineMode('dorian', [0, 2, 3, 5, 7, 9, 10], 12)
  global.start()
  const seq = new Sequence(global, sched)
  seq.setName('lead')
  seq.midi('iac', 1).octave(4)
  seq.play(...(parseAudioDSL(`p.play(${src})`).statements[0].args as never[]))
  await seq.run()
  await vi.advanceTimersByTimeAsync(2100)
  return ons
}

describe('E6 — mode scope dispatch (§2.2)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('in C dorian, degrees index the lattice: 3 = Eb (63), 7 = Bb (70)', async () => {
    // Ionian would give degree 3 = E (64), 7 = B (71); dorian gives the b3 / b7.
    expect(await playInDorian('(1, 3, 5, 7).mode(dorian)')).toEqual([60, 63, 67, 70])
  })

  it('degree 8 wraps to the next period (C5 = 72)', async () => {
    expect(await playInDorian('(8).mode(dorian)')).toEqual([72]) // lattice[0] + period
  })

  it('an accidental in a mode scope alters the lattice tone (#3 in dorian = E)', async () => {
    // dorian degree 3 = Eb(63); #3 raises it a semitone → E (64)
    expect(await playInDorian('(#3).mode(dorian)')).toEqual([64])
  })
})
