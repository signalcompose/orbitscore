import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Phase 2 (#230) — group-scope dispatch (§3): a `.root()` group resolves to a
 * RootContext per event (inner→outer→seq→error), degrees number against it.
 */

const T0 = 1_000_000

function mockMidiOutput(): MidiOutput {
  return {
    ensurePort: vi.fn((q: string) => (/iac/i.test(q) ? 'IACドライバ バス1' : q)),
    noteOn: vi.fn(),
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

function notesOf(out: MidiOutput): number[] {
  return (out.noteOn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])
}

/** Build a started, keyed MIDI sequence (octave 4) and play a parsed pattern. */
async function playKeyed(src: string, key = 'C'): Promise<MidiOutput> {
  vi.setSystemTime(T0)
  const sched = mockScheduler()
  const out = mockMidiOutput()
  const global = new Global(sched, new MidiManager(() => out))
  global.key(key)
  global.start()
  const seq = new Sequence(global, sched)
  seq.setName('piano')
  seq.midi('iac', 1).octave(4)
  const args = parseAudioDSL(`p.play(${src})`).statements[0].args
  seq.play(...(args as never[]))
  await seq.run()
  await vi.advanceTimersByTimeAsync(2100)
  return out
}

describe('Sequence group-scope dispatch (§3)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('note-name root: (1, 3, 5).root(F#) → F#4, A#4, C#5', async () => {
    const out = await playKeyed('(1, 3, 5).root(F#)')
    // F#4 = 66; degree 3 = +4 = 70; degree 5 = +7 = 73
    expect(notesOf(out)).toEqual(expect.arrayContaining([66, 70, 73]))
    expect(notesOf(out)).toHaveLength(3)
  })

  it('degree root: (1).root(3) in C → E4 (root = III of C)', async () => {
    const out = await playKeyed('(1).root(3)')
    expect(notesOf(out)).toContain(64) // E4
  })

  it('juxtaposition shares the root: (1)(5).root(2) in C → both at root D', async () => {
    const out = await playKeyed('(1)(5).root(2)')
    // root D (pc 2), octave 4 → rootPitch 62; degree 1 = 62, degree 5 = 69
    expect(notesOf(out)).toEqual(expect.arrayContaining([62, 69]))
    expect(notesOf(out)).toHaveLength(2)
  })

  it('inner .root() overrides outer: ((1).root(b6), 5).root(2) in C', async () => {
    const out = await playKeyed('((1).root(b6), 5).root(2)')
    // inner: 1 at b6 = Ab(pc8) → 68; outer: 5 at root 2 = D(pc2) → 62 + 7 = 69
    expect(notesOf(out)).toEqual(expect.arrayContaining([68, 69]))
    expect(notesOf(out)).toHaveLength(2)
  })

  it('unscoped event still uses the sequence default (key tonic)', async () => {
    const out = await playKeyed('1, (5).root(2)')
    // bare 1 → C4(60) via key tonic; (5).root(2) → 5 at D → 69
    expect(notesOf(out)).toEqual(expect.arrayContaining([60, 69]))
  })

  it('note-name root needs NO global.key() (only numeric roots require a key)', async () => {
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    const out = mockMidiOutput()
    const g = new Global(sched, new MidiManager(() => out)) // no global.key()
    g.start()
    const seq = new Sequence(g, sched)
    seq.setName('lead')
    seq.midi('iac', 1).octave(4)
    const args = parseAudioDSL('p.play((1, 5).root(C))').statements[0].args
    seq.play(...(args as never[]))
    await expect(seq.run()).resolves.toBeDefined()
    await vi.advanceTimersByTimeAsync(2100)
    // root C (pc 0), octave 4 → 60; degree 5 = 67
    expect(notesOf(out)).toEqual(expect.arrayContaining([60, 67]))
  })

  it('a degree root with no global.key() rejects run()', async () => {
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    const out = mockMidiOutput()
    const g = new Global(sched, new MidiManager(() => out)) // no key
    g.start()
    const seq = new Sequence(g, sched)
    seq.setName('lead')
    seq.midi('iac', 1).octave(4)
    const args = parseAudioDSL('p.play((1).root(3))').statements[0].args
    seq.play(...(args as never[]))
    await expect(seq.run()).rejects.toThrow(/key|root/i)
  })

  it('.mode() with an undefined mode rejects run() (E6, §2.2)', async () => {
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    const out = mockMidiOutput()
    const g = new Global(sched, new MidiManager(() => out))
    g.key('C')
    g.start()
    const seq = new Sequence(g, sched)
    seq.setName('lead')
    seq.midi('iac', 1).octave(4)
    const args = parseAudioDSL('p.play((1).mode(dorian))').statements[0].args
    seq.play(...(args as never[]))
    await expect(seq.run()).rejects.toThrow(/no such mode/i)
  })

  it('.oct(N) composes additively with the sticky ^N range (§9.3)', async () => {
    const out = await playKeyed('3^1, (1).oct(1)')
    // 3^1 → E5 (range +1: 64 + 12 = 76); (1).oct(1) → range(+1)+oct(+1)=+2 → C6 (84)
    expect(notesOf(out)).toEqual(expect.arrayContaining([76, 84]))
    expect(notesOf(out)).toHaveLength(2)
  })

  it('.oct(N) alone lifts the group register', async () => {
    const out = await playKeyed('(1, 5).oct(1)')
    // range 0 + oct +1 → degree 1 = C5 (72), degree 5 = G5 (79)
    expect(notesOf(out)).toEqual(expect.arrayContaining([72, 79]))
    expect(notesOf(out)).toHaveLength(2)
  })

  it('^N persists past a .oct() group; the group oct does not leak out (§9.4)', async () => {
    const out = await playKeyed('3^1, (1).oct(2), 1')
    // 3^1 → E5 (76, range +1); (1).oct(2) → +1+2 = +3 → C7 (96);
    // trailing 1 → range +1 persists, oct gone → C5 (72)
    expect(notesOf(out)).toEqual(expect.arrayContaining([76, 96, 72]))
    expect(notesOf(out)).toHaveLength(3)
    expect(notesOf(out)).not.toContain(60) // would be C4 if ^N had been reset by the group
  })

  it('inner .oct() + outer .root() resolve from different frames (independent axes)', async () => {
    // ((1, 5).oct(2)).root(3): outer root = III of C = E (64); inner oct = +2.
    const out = await playKeyed('((1, 5).oct(2)).root(3)')
    expect(notesOf(out)).toEqual(expect.arrayContaining([88, 95])) // E6(64+24), B6(64+7+24)
    expect(notesOf(out)).toHaveLength(2)
  })

  it('.oct(-N) offsets downward', async () => {
    const out = await playKeyed('(1).oct(-2)')
    expect(notesOf(out)).toContain(36) // C2 = C4(60) - 24
  })

  it('a bare degree alongside a note-rooted group still needs global.key()', async () => {
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    const out = mockMidiOutput()
    const g = new Global(sched, new MidiManager(() => out)) // no key
    g.start()
    const seq = new Sequence(g, sched)
    seq.setName('lead')
    seq.midi('iac', 1).octave(4)
    // (1).root(C) needs no key, but the bare 5 falls back to the seq default → needs key
    const args = parseAudioDSL('p.play((1).root(C), 5)').statements[0].args
    seq.play(...(args as never[]))
    await expect(seq.run()).rejects.toThrow(/key|root/i)
  })
})
