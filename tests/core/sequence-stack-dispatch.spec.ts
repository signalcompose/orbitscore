import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Phase 3 (#231) — `[ ]` stack dispatch (§4): simultaneous note-on, scope
 * composition, structural octave shift, and the audio-vs-MIDI rejection (§10-5).
 *
 * Stack voices share the same TimedEvent.startTime (proven in stack-timing.spec),
 * so the deterministic onTime formula yields a simultaneous note-on. These tests
 * assert the resolved MIDI numbers (degree + scope + structural `^N` all compose).
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

describe('Phase 3 — stack MIDI dispatch (§4)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('[1, 3, 5] in C oct4 → simultaneous note-on 60, 64, 67', async () => {
    const out = await playKeyed('[1, 3, 5]')
    expect(notesOf(out)).toEqual(expect.arrayContaining([60, 64, 67]))
    expect(notesOf(out)).toHaveLength(3)
  })

  it('a stack resolves against the enclosing group scope: ([1,3,5]).root(2) in C', async () => {
    const out = await playKeyed('([1, 3, 5]).root(2)')
    // root D (pc 2), oct 4 → 62; degree 3 = +4 = 66; degree 5 = +7 = 69
    expect(notesOf(out)).toEqual(expect.arrayContaining([62, 66, 69]))
    expect(notesOf(out)).toHaveLength(3)
  })

  it('a voice `^+1` adds an octave on top of the degree: [1, b7^+1] in C oct4', async () => {
    const out = await playKeyed('[1, b7^+1]')
    // degree 1 → 60; b7 = +10 → 70, structural +1 octave → 82
    expect(notesOf(out)).toEqual(expect.arrayContaining([60, 82]))
    expect(notesOf(out)).toHaveLength(2)
  })

  it('whole-stack `^+1` lifts every voice an octave: [1, 3, 5]^+1 in C oct4', async () => {
    const out = await playKeyed('[1, 3, 5]^+1')
    expect(notesOf(out)).toEqual(expect.arrayContaining([72, 76, 79]))
    expect(notesOf(out)).toHaveLength(3)
  })

  it('a stack does NOT perturb the running range of a following melodic note', async () => {
    // 3^1 sets range +1 (E5=76); the stack voices carry structural-only shifts and
    // must not move the running range; the trailing 1 stays at range +1 (C5=72).
    const out = await playKeyed('3^1, [1, 5], 1')
    expect(notesOf(out)).toEqual(expect.arrayContaining([76, 72, 79, 72]))
    // 3^1 → 76; stack [1,5] at range +1 → C5(72), G5(79); trailing 1 → C5(72)
    expect(notesOf(out)).toHaveLength(4)
    expect(notesOf(out)).not.toContain(60) // would be C4 if the stack had reset the range
  })
})

describe('Phase 3 — `[ ]` rejected in audio sequences (§10-5)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a non-MIDI (audio-domain) sequence with a `[ ]` rejects run()', async () => {
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    const out = mockMidiOutput()
    const global = new Global(sched, new MidiManager(() => out))
    global.start()
    const seq = new Sequence(global, sched) // no .midi() → non-MIDI
    seq.setName('drums')
    const args = parseAudioDSL('p.play([1, 3, 5])').statements[0].args
    seq.play(...(args as never[]))
    await expect(seq.run()).rejects.toThrow(/audio sequences.*reserved|§10-5/i)
  })

  it('the rejection finds a `[ ]` nested inside a `( )` group', async () => {
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    const out = mockMidiOutput()
    const global = new Global(sched, new MidiManager(() => out))
    global.start()
    const seq = new Sequence(global, sched)
    seq.setName('drums')
    const args = parseAudioDSL('p.play((1, [1, 3, 5]))').statements[0].args
    seq.play(...(args as never[]))
    await expect(seq.run()).rejects.toThrow(/audio sequences.*reserved|§10-5/i)
  })
})
