import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { processStatement } from '../../packages/engine/src/interpreter/process-statement'
import { InterpreterState } from '../../packages/engine/src/interpreter/types'

/**
 * Phase 3 (#231) — chord values end to end (§6): the global chord namespace,
 * Sequence.play spread/removal/`^N` resolution, and the interpreter routing for
 * `import chords` / `var = chord([...])`. Built on the direct Global+Sequence MIDI
 * harness (the interpreter's full path needs SuperCollider and is skipped).
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

/** Raw `[ ]` voices of a `chord([...])` expression, for direct defineChord() calls. */
function chordVoices(expr: string): any[] {
  return (parseAudioDSL(`var _ = ${expr}`).statements[0] as any).voices
}

/** Build a keyed MIDI sequence, run `setup(global)` (e.g. importChords), play `src`. */
async function playChords(setup: (g: Global) => void, src: string, key = 'C'): Promise<MidiOutput> {
  vi.setSystemTime(T0)
  const sched = mockScheduler()
  const out = mockMidiOutput()
  const global = new Global(sched, new MidiManager(() => out))
  global.key(key)
  setup(global)
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

describe('Phase 3 — chord values dispatch (§6)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('import chords + [m7] in C oct4 → C, Eb, G, Bb (60, 63, 67, 70)', async () => {
    const out = await playChords((g) => g.importChords(), '[m7]')
    expect(notesOf(out)).toEqual(expect.arrayContaining([60, 63, 67, 70]))
    expect(notesOf(out)).toHaveLength(4)
  })

  it('bare chord names as group elements: (0, m7, 0, m7).root(3)', async () => {
    const out = await playChords((g) => g.importChords(), '(0, m7, 0, m7).root(3)')
    // root degree 3 of C = E (64). m7 on E → 64, 67, 71, 74. Two chords (slots 2, 4).
    expect(notesOf(out)).toEqual([64, 67, 71, 74, 64, 67, 71, 74])
  })

  it('spread + add: [m7, 9] in C → m7 plus the 9th (74)', async () => {
    const out = await playChords((g) => g.importChords(), '[m7, 9]')
    expect(notesOf(out).sort((a, b) => a - b)).toEqual([60, 63, 67, 70, 74])
  })

  it('spread + removal: [m7, -5] in C drops the 5 (67)', async () => {
    const out = await playChords((g) => g.importChords(), '[m7, -5]')
    expect(notesOf(out).sort((a, b) => a - b)).toEqual([60, 63, 70])
  })

  it('whole-chord `^+1`: a bare m7^+1 lifts the chord an octave', async () => {
    const out = await playChords((g) => g.importChords(), '(m7^+1, 0, 0, 0).root(1)')
    // root degree 1 of C = C (60). m7 +1 octave → 72, 75, 79, 82.
    expect(notesOf(out).sort((a, b) => a - b)).toEqual([72, 75, 79, 82])
  })

  it('a user chord built by spread+removal plays back', async () => {
    const out = await playChords((g) => {
      g.importChords()
      g.defineChord('m7omit5', chordVoices('chord([m7, -5])'))
    }, '[m7omit5]')
    expect(notesOf(out).sort((a, b) => a - b)).toEqual([60, 63, 70])
  })

  it('§9.1 bar 3 (normative): (0, [m7, 9], 0, [m7, 9]).root(2) in C', async () => {
    const out = await playChords((g) => g.importChords(), '(0, [m7, 9], 0, [m7, 9]).root(2)')
    // root degree 2 of C = D (62). m7 on D → 62, 65, 69, 72; + 9 = IONIAN[1]+12 = 14 → 76.
    // Two chords (slots 2 and 4); slots 1 and 3 are rests.
    expect(notesOf(out)).toEqual([62, 65, 69, 72, 76, 62, 65, 69, 72, 76])
  })

  it('an unknown chord name warns and plays nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await playChords(() => {}, '[mystery]')
    expect(notesOf(out)).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown name "mystery"/))
    warn.mockRestore()
  })
})

describe('Phase 3 — chord namespace registry (§6, §10-4)', () => {
  function freshGlobal(): Global {
    return new Global(mockScheduler(), new MidiManager(() => mockMidiOutput()))
  }

  it('importChords binds the stdlib (m7 = 1, b3, 5, b7)', () => {
    const g = freshGlobal()
    g.importChords()
    expect(g.getChordVoices('m7')).toEqual([
      { degree: 1, alteration: 0, octaveShift: 0, detune: 0 },
      { degree: 3, alteration: -1, octaveShift: 0, detune: 0 },
      { degree: 5, alteration: 0, octaveShift: 0, detune: 0 },
      { degree: 7, alteration: -1, octaveShift: 0, detune: 0 },
    ])
  })

  it('redefining a bound name warns (last-write-wins, §10-4)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = freshGlobal()
    g.importChords()
    g.defineChord('m7', chordVoices('chord([1, 3, 5, 7])')) // shadow stdlib m7 with maj7 voicing
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"m7" redefined/))
    expect(g.getChordVoices('m7')).toEqual([
      { degree: 1, alteration: 0, octaveShift: 0, detune: 0 },
      { degree: 3, alteration: 0, octaveShift: 0, detune: 0 },
      { degree: 5, alteration: 0, octaveShift: 0, detune: 0 },
      { degree: 7, alteration: 0, octaveShift: 0, detune: 0 },
    ])
    warn.mockRestore()
  })
})

describe('Phase 3 — interpreter routing for import / chord_binding (§6)', () => {
  function stateWith(global: Global): InterpreterState {
    return {
      globals: new Map([['g', global]]),
      sequences: new Map(),
      currentGlobal: global,
      audioEngine: undefined as never,
      isBooted: true,
      runGroup: new Set(),
      loopGroup: new Set(),
      muteGroup: new Set(),
    }
  }

  it('`import chords` populates the active global namespace', async () => {
    const g = new Global(mockScheduler(), new MidiManager(() => mockMidiOutput()))
    const state = stateWith(g)
    await processStatement({ type: 'import', module: 'chords' } as never, state)
    expect(g.getChordVoices('maj7')).toBeDefined()
  })

  it('`var X = chord([...])` binds via the interpreter', async () => {
    const g = new Global(mockScheduler(), new MidiManager(() => mockMidiOutput()))
    const state = stateWith(g)
    const binding = parseAudioDSL('var triad = chord([1, 3, 5])').statements[0]
    await processStatement(binding as never, state)
    expect(g.getChordVoices('triad')).toEqual([
      { degree: 1, alteration: 0, octaveShift: 0, detune: 0 },
      { degree: 3, alteration: 0, octaveShift: 0, detune: 0 },
      { degree: 5, alteration: 0, octaveShift: 0, detune: 0 },
    ])
  })
})
