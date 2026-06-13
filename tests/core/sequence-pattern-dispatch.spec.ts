import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { processStatement } from '../../packages/engine/src/interpreter/process-statement'
import { InterpreterState } from '../../packages/engine/src/interpreter/types'

/**
 * Phase R (#227) — pattern variables end to end (§6.5): namespace splice, `*n` on a
 * pattern ref, `.root()` over a pattern, chord/pattern coexistence, value-pass
 * (resolution at play() time), and the interpreter routing. Direct Global+Sequence
 * MIDI harness (the full interpreter path needs SuperCollider and is skipped).
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

/** The raw bound elements of a `var NAME = <play-expr>` statement, for definePattern(). */
function patternElements(rhs: string): any[] {
  return (parseAudioDSL(`var tmp = ${rhs}`).statements[0] as any).elements
}

async function playWith(setup: (g: Global) => void, src: string, key = 'C'): Promise<MidiOutput> {
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

describe('Phase R — pattern variables dispatch (§6.5)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a single-group pattern occupies one slot: play(riff), riff = (1, 5)', async () => {
    const out = await playWith((g) => g.definePattern('riff', patternElements('(1, 5)')), 'riff')
    // one slot (whole bar) split in 2: degree 1 → 60, degree 5 → 67
    expect(notesOf(out)).toEqual([60, 67])
  })

  it('a juxtaposition pattern splices as multiple siblings: AA = (1,0)(5,0)', async () => {
    const out = await playWith((g) => g.definePattern('aa', patternElements('(1, 0)(5, 0)')), 'aa')
    // two slots; rests (0) emit no note → degree 1 (60), degree 5 (67)
    expect(notesOf(out)).toEqual([60, 67])
  })

  it('`*n` on a pattern ref repeats the splice: riff*3, riff = (1, 5)', async () => {
    const out = await playWith((g) => g.definePattern('riff', patternElements('(1, 5)')), 'riff*3')
    expect(notesOf(out)).toEqual([60, 67, 60, 67, 60, 67])
  })

  it('`.root()` applies over a pattern ref: riff.root(3), riff = (1, 5)', async () => {
    const out = await playWith(
      (g) => g.definePattern('riff', patternElements('(1, 5)')),
      'riff.root(3)',
    )
    // root degree 3 of C = E (64): degree 1 → 64, degree 5 → 71
    expect(notesOf(out)).toEqual([64, 71])
  })

  it('chords and patterns coexist in one namespace', async () => {
    const out = await playWith((g) => {
      g.importChords()
      g.definePattern('lick', patternElements('(1, 5)'))
    }, '[m7], lick')
    // [m7] in C → 60,63,67,70 (one slot); lick → 1,5 → 60,67 (next slot)
    expect(notesOf(out)).toEqual([60, 63, 67, 70, 60, 67])
  })

  it('value-pass: redefining a pattern only affects the next play() (§6.5.2)', async () => {
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    const out = mockMidiOutput()
    const global = new Global(sched, new MidiManager(() => out))
    global.key('C')
    global.definePattern('riff', patternElements('(1)'))
    global.start()
    const seq = new Sequence(global, sched)
    seq.setName('piano')
    seq.midi('iac', 1).octave(4)
    seq.play(...(parseAudioDSL('p.play(riff)').statements[0].args as never[]))
    // redefine AFTER play() resolved — the stored pattern keeps the old value
    global.definePattern('riff', patternElements('(5)'))
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)
    expect(notesOf(out)).toEqual([60]) // degree 1, not the redefined 5
  })

  it('an unknown name warns and plays nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await playWith(() => {}, 'mystery')
    expect(notesOf(out)).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown name "mystery"/))
    warn.mockRestore()
  })
})

describe('Phase R — interpreter routing for pattern_binding (§6.5)', () => {
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

  it('`var riff = (1, 0, 5, 0)` binds a pattern via the interpreter', async () => {
    const g = new Global(mockScheduler(), new MidiManager(() => mockMidiOutput()))
    const state = stateWith(g)
    const binding = parseAudioDSL('var riff = (1, 0, 5, 0)').statements[0]
    await processStatement(binding as never, state)
    const bound = g.getBinding('riff')
    expect(bound?.kind).toBe('pattern')
  })
})
