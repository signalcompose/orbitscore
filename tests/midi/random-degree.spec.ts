import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'
import { processStatement } from '../../packages/engine/src/interpreter/process-statement'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { createMixerRuntimeRegistry } from '../../packages/engine/src/signal-chain/runtime'
import { calculateEventTiming } from '../../packages/engine/src/timing/calculation'
import { RecordingScheduler } from '../audio/verify/recording-scheduler'

const T0 = 1_000_000
const N = 20

type NoteOn = { note: number; velocity: number; time: number }
type Capture = { ons: NoteOn[]; offs: Map<number, number[]>; bends: number[] }

function recordingOutput(capture: Capture): MidiOutput {
  return {
    ensurePort: vi.fn((q: string) => (/iac/i.test(q) ? 'IACドライバ バス1' : q)),
    noteOn: vi.fn((_p: string, _c: number, note: number, velocity: number) =>
      capture.ons.push({ note, velocity, time: Date.now() - T0 }),
    ),
    noteOff: vi.fn((_p: string, _c: number, note: number) => {
      const times = capture.offs.get(note) ?? []
      times.push(Date.now() - T0)
      capture.offs.set(note, times)
    }),
    pitchBend: vi.fn((_p: string, _c: number, detune: number) => capture.bends.push(detune)),
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

function makeState(global: Global) {
  return {
    globals: new Map([['global', global]]),
    sequences: new Map<string, Sequence>(),
    mixers: createMixerRuntimeRegistry(),
    currentGlobal: global,
    audioEngine: new RecordingScheduler(),
    isBooted: true,
    runGroup: new Set<string>(),
    loopGroup: new Set<string>(),
    muteGroup: new Set<string>(),
    engineT0: Date.now(),
  }
}

async function evaluate(source: string, global = new Global(new RecordingScheduler())) {
  const state = makeState(global)
  for (const statement of parseAudioDSL(source).statements) await processStatement(statement, state)
  return global
}

async function preparePlayback(
  src: string,
  prelude = '',
  configure?: (global: Global, seq: Sequence) => void,
  startGlobal = false,
) {
  vi.setSystemTime(T0)
  const scheduler = mockScheduler()
  const capture: Capture = { ons: [], offs: new Map(), bends: [] }
  const global = new Global(scheduler, new MidiManager(() => recordingOutput(capture)))
  global.key('C')
  if (prelude) await evaluate(prelude, global)
  if (startGlobal) global.start()
  const seq = new Sequence(global, scheduler).setName('piano')
  seq.midi('iac', 1).octave(4)
  configure?.(global, seq)
  seq.play(...(parseAudioDSL(`p.play(${src})`).statements[0]!.args as never[]))
  return { scheduler, capture, seq }
}

async function playOnce(
  src: string,
  prelude = '',
  configure?: (global: Global, seq: Sequence) => void,
): Promise<{ capture: Capture; seq: Sequence }> {
  const { capture, seq } = await preparePlayback(src, prelude, configure, true)
  await seq.run()
  await vi.advanceTimersByTimeAsync(2200)
  return { capture, seq }
}

async function sample(src: string, prelude = '', count = N): Promise<number[]> {
  return (await playCycles(src, prelude, count)).capture.ons.map((on) => on.note)
}

async function playCycles(src: string, prelude: string, count: number) {
  const { scheduler, capture, seq } = await preparePlayback(src, prelude)
  for (let i = 0; i < count; i++) await seq.scheduleEvents(scheduler, i, i * 2500)
  await vi.advanceTimersByTimeAsync(count * 2500 + 2200)
  return { capture, seq }
}

function expectSubsetAndVariety(notes: number[], allowed: readonly number[]): void {
  expect(notes.length).toBeGreaterThan(0)
  for (const note of notes) expect(allowed).toContain(note)
  expect(new Set(notes).size).toBeGreaterThan(1)
}

function soundingAudioEvents(source: string): Array<{
  sliceNumber: number
  startTime: number
  duration: number
}> {
  const audio = new RecordingScheduler()
  const sequence = new Sequence(new Global(audio), audio).setName('kick')
  sequence.play(...(parseAudioDSL(`kick.play(${source})`).statements[0]!.args as never[]))
  return sequence
    .getState()
    .timedEvents!.filter(({ sliceNumber }) => sliceNumber > 0)
    .map(({ sliceNumber, startTime, duration }) => ({ sliceNumber, startTime, duration }))
}

describe('#967 random bindings and deterministic evaluation', () => {
  it('evaluates random_binding by copying the mode lattice and period (K6)', async () => {
    const global = await evaluate(
      'var two = mode(1, 5)\nvar r1 = random.two\nvar two = mode(1, b3, 5)',
    )
    expect(global.getBinding('r1')).toEqual({
      kind: 'random',
      lattice: [0, 7],
      period: 12,
      from: 'two',
    })
  })

  it('E3: rejects an undefined random source at definition time', async () => {
    await expect(evaluate('var r1 = random.nope')).rejects.toThrow(/random\.nope.*mode.*nope/i)
  })

  it('E4: rejects chord and pattern values after random.', async () => {
    await expect(evaluate('var m7 = [1, b3, 5, b7]\nvar r1 = random.m7')).rejects.toThrow(
      /random\.m7.*chord/i,
    )
    await expect(evaluate('var riff = (1, 2)\nvar r1 = random.riff')).rejects.toThrow(
      /random\.riff.*pattern/i,
    )
  })

  it('E6: rejects a copied lattice containing NaN', async () => {
    const global = new Global(new RecordingScheduler())
    global.defineMode('broken', [0, Number.NaN], 12)
    expect(() => (global as any).defineRandom('r1', 'broken')).toThrow(/random\.broken.*格子.*不正/)
  })

  it('resolves a random source name to a lattice-carrying random degree with all modifiers', async () => {
    const global = await evaluate('var two = mode(1, 5)\nvar r1 = random.two')
    const seq = new Sequence(global, new RecordingScheduler()).setName('p')
    seq.play(...(parseAudioDSL('p.play(r1^1^r~0.5@v110@g30)').statements[0]!.args as never[]))
    expect(seq.getState().playPattern).toEqual([
      expect.objectContaining({
        type: 'random_degree',
        lattice: [0, 7],
        period: 12,
        from: 'two',
        octaveShift: 1,
        rangeSet: true,
        randomOctave: true,
        detune: 0.5,
        velocity: 110,
        articulation: 0.3,
      }),
    ])
  })

  it('keeps chord ^N structural and rejects E8 modifiers on chord/pattern refs', () => {
    const global = new Global(new RecordingScheduler())
    global.defineChord('m7', [1, 3, 5, 7])
    global.definePattern('riff', [1, 2])
    const seq = new Sequence(global, new RecordingScheduler()).setName('p')
    seq.play(...(parseAudioDSL('p.play(m7^1)').statements[0]!.args as never[]))
    expect(seq.getState().playPattern).toEqual([expect.objectContaining({ type: 'stack' })])
    expect((seq.getState().playPattern![0] as any).voices).toEqual([
      expect.objectContaining({ type: 'pitch', octaveShift: 1 }),
      expect.objectContaining({ type: 'pitch', octaveShift: 1 }),
      expect.objectContaining({ type: 'pitch', octaveShift: 1 }),
      expect.objectContaining({ type: 'pitch', octaveShift: 1 }),
    ])
    for (const expr of [
      'm7^r',
      'm7~0.5',
      'm7@v100',
      'm7@g30',
      'riff^r',
      'riff~0.5',
      'riff@v100',
      'riff@g30',
    ]) {
      expect(() =>
        seq.play(...(parseAudioDSL(`p.play(${expr})`).statements[0]!.args as never[])),
      ).toThrow(/chord|pattern.*\^r|random/i)
    }
  })

  it('E8 rejects trailing r on chord and pattern references', () => {
    const global = new Global(new RecordingScheduler())
    global.defineChord('m7', [1, 3, 5, 7])
    global.definePattern('riff', [1, 2])
    const seq = new Sequence(global, new RecordingScheduler()).setName('p')
    for (const expr of ['m7 r', 'riff r']) {
      expect(() =>
        seq.play(...(parseAudioDSL(`p.play(${expr})`).statements[0]!.args as never[])),
      ).toThrow(/chord|pattern.*r|ランダム音源/i)
    }
  })

  it('W2 hints that r1r / rrr need dot-r probability syntax', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const seq = new Sequence(
      new Global(new RecordingScheduler()),
      new RecordingScheduler(),
    ).setName('p')
    seq.play(...(parseAudioDSL('p.play(r1r, rrr)').statements[0]!.args as never[]))
    expect(warn.mock.calls.flat().join('\n')).toMatch(/r1\.r.*r1\.r\(0\.3\)/)
  })

  it('W3 gives a random-source hint when a mode is played as a value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const global = new Global(new RecordingScheduler())
    global.defineMode('dorian', [0, 2, 3, 5, 7, 9, 10], 12)
    const seq = new Sequence(global, new RecordingScheduler()).setName('p')
    seq.play(...(parseAudioDSL('p.play(dorian)').statements[0]!.args as never[]))
    expect(warn.mock.calls.flat().join('\n')).toMatch(/var r1 = random\.dorian/)
  })

  it('E5 rejects a random source as a .mode() scope', async () => {
    vi.useFakeTimers()
    try {
      await expect(
        playOnce(
          '(1).mode(r1)',
          'var dorian = mode(1, 2, b3, 4, 5, 6, b7)\nvar r1 = random.dorian',
        ),
      ).rejects.toThrow(/\.mode\(r1\).*ランダム音源/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('#967 chord random voices and voicing rules', () => {
  it('carries r in a chord binding and spreads it as exactly one random voice', async () => {
    const global = await evaluate('var c = [1, r, 5]')
    expect(global.getBinding('c')).toMatchObject({
      kind: 'chord',
      voices: [{ degree: 1 }, { kind: 'random' }, { degree: 5 }],
    })
    const seq = new Sequence(global, new RecordingScheduler()).setName('p')
    seq.play(...(parseAudioDSL('p.play([c])').statements[0]!.args as never[]))
    expect((seq.getState().playPattern![0] as any).voices).toHaveLength(3)
    expect((seq.getState().playPattern![0] as any).voices[1]).toMatchObject({
      type: 'random_degree',
    })
  })

  it('keeps random voices when -1 removes only a literal degree at definition and play time', async () => {
    const global = await evaluate('var c = [1, r, 5, -1]\nvar d = [1, r, 5]\nvar e = [d, -1]')
    for (const name of ['c', 'e']) {
      expect(global.getBinding(name)).toMatchObject({
        kind: 'chord',
        voices: [{ kind: 'random' }, { degree: 5 }],
      })
    }

    const seq = new Sequence(global, new RecordingScheduler()).setName('p')
    seq.play(...(parseAudioDSL('p.play([1, r, 5, -1])').statements[0]!.args as never[]))
    expect((seq.getState().playPattern![0] as any).voices).toEqual([
      expect.objectContaining({ type: 'random_degree' }),
      5,
    ])
  })

  it('allows drop/invert by written position and updates a random voice structurally', () => {
    const global = new Global(new RecordingScheduler())
    const seq = new Sequence(global, new RecordingScheduler()).setName('p')
    seq.play(...(parseAudioDSL('p.play([1, r, 5].drop(2))').statements[0]!.args as never[]))
    expect((seq.getState().playPattern![0] as any).voices[1]).toMatchObject({
      type: 'random_degree',
      octaveShift: -1,
      rangeSet: false,
    })
    seq.play(...(parseAudioDSL('p.play([r, 3, 5].invert(1))').statements[0]!.args as never[]))
    expect((seq.getState().playPattern![0] as any).voices[0]).toMatchObject({
      type: 'random_degree',
      octaveShift: 1,
      rangeSet: false,
    })
  })

  it.each(['close', 'open', 'shell', 'rootless'])('E7: rejects .%s() on a random voice', (op) => {
    const seq = new Sequence(
      new Global(new RecordingScheduler()),
      new RecordingScheduler(),
    ).setName('p')
    expect(() =>
      seq.play(...(parseAudioDSL(`p.play([1, r, 5].${op}())`).statements[0]!.args as never[])),
    ).toThrow(new RegExp(`\\.${op}\\(\\).*ランダム|選ばれる度数`))
  })
})

describe('#967 timing and audio regression', () => {
  it('eagerly validates that a numeric root has a resolvable key before scheduling', async () => {
    vi.useFakeTimers()
    try {
      const scheduler = mockScheduler()
      const capture: Capture = { ons: [], offs: new Map(), bends: [] }
      const global = new Global(scheduler, new MidiManager(() => recordingOutput(capture)))
      global.start()
      const seq = new Sequence(global, scheduler).setName('piano')
      seq.midi('iac', 1).octave(4)
      seq.play(...(parseAudioDSL('p.play((r).root(5))').statements[0]!.args as never[]))
      await expect(seq.run()).rejects.toThrow(/degree root.*global\.key/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns a random degree into one symbolic TimedEvent carrying its lattice source', () => {
    const random = {
      type: 'random_degree',
      octaveShift: 0,
      rangeSet: false,
      detune: 0,
      lattice: [0, 7],
      period: 12,
      from: 'two',
    } as const
    expect(calculateEventTiming([random], 2000)).toEqual([
      expect.objectContaining({
        sliceNumber: 0,
        startTime: 0,
        duration: 2000,
        randomDegree: { lattice: [0, 7], period: 12, from: 'two' },
      }),
    ])
  })

  it('dispatches random pitch when play() precedes midi() and does not emit W4', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const scheduler = mockScheduler()
      const capture: Capture = { ons: [], offs: new Map(), bends: [] }
      const global = new Global(scheduler, new MidiManager(() => recordingOutput(capture)))
      global.key('C').start()
      const seq = new Sequence(global, scheduler).setName('s')
      seq.play(...(parseAudioDSL('s.play(1, r, 4)').statements[0]!.args as never[]))
      seq.midi('iac', 1).octave(4)

      await seq.run()
      await vi.advanceTimersByTimeAsync(2200)

      expect(capture.ons).toHaveLength(3)
      expect([60, 62, 64, 65, 67, 69, 71]).toContain(capture.ons[1]!.note)
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/audio シーケンスでは休符/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps kick.play(1, r, 1) identical to (1, 0, 1) at audio dispatch and warns W4 once per pattern', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const audio = new RecordingScheduler()
    const global = new Global(audio)
    const kick = new Sequence(global, audio).setName('kick')
    kick.audio('/tmp/kick.wav').output()
    kick.play(...(parseAudioDSL('kick.play(1, r, 1)').statements[0]!.args as never[]))
    expect(soundingAudioEvents('1, r, 1')).toEqual(soundingAudioEvents('1, 0, 1'))
    expect(warn).not.toHaveBeenCalled()

    await kick.scheduleEvents(audio)
    await kick.scheduleEvents(audio, 1)
    expect(
      warn.mock.calls
        .flat()
        .join('\n')
        .match(/audio シーケンスでは休符/g),
    ).toHaveLength(1)

    kick.play(...(parseAudioDSL('kick.play(1, r, 1)').statements[0]!.args as never[]))
    await kick.scheduleEvents(audio, 2)
    expect(
      warn.mock.calls
        .flat()
        .join('\n')
        .match(/audio シーケンスでは休符/g),
    ).toHaveLength(2)
  })

  it('keeps kick.play((1, r), 1) identical to ((1, 0), 1) for sounding audio events', () => {
    expect(soundingAudioEvents('(1, r), 1')).toEqual(soundingAudioEvents('(1, 0), 1'))
  })

  it('keeps kick.play({1, r}, 1) identical to ({1, 0}, 1) for sounding audio events', () => {
    expect(soundingAudioEvents('{1, r}, 1')).toEqual(soundingAudioEvents('{1, 0}, 1'))
  })

  it('keeps kick.play([1, r], 1) identical to ([1, 0], 1) for sounding audio events', () => {
    expect(soundingAudioEvents('[1, r], 1')).toEqual(soundingAudioEvents('[1, 0], 1'))
  })
})

describe('#967 random-degree dispatch (statistical)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => vi.useRealTimers())

  it('bare r uses only root-scope Ionian 1..7 and produces variety', async () => {
    expectSubsetAndVariety(await sample('r'), [60, 62, 64, 65, 67, 69, 71])
  }, 30000)

  it('bare r uses the complete mode-scope lattice', async () => {
    const notes = await sample(
      '(r, r, r, r).mode(aeolian)',
      'var aeolian = mode(1, 2, b3, 4, 5, b6, b7)',
    )
    for (const note of notes) expect([60, 62, 63, 65, 67, 68, 70]).toContain(note)
    expect(new Set(notes).size).toBeGreaterThan(1)
  }, 30000)

  it('(r).root(5) chooses from G Ionian', async () => {
    expectSubsetAndVariety(await sample('(r).root(5)'), [67, 69, 71, 72, 74, 76, 78])
  }, 30000)

  it('3^1, r selects r inside the running +1 range', async () => {
    const notes = await sample('3^1, r')
    const randomNotes = notes.filter((_note, index) => index % 2 === 1)
    for (const note of randomNotes) expect([72, 74, 76, 77, 79, 81, 83]).toContain(note)
  }, 30000)

  it('r^1 and r1^1 are both sticky for the following 5 (K7)', async () => {
    const bare = await playOnce('r^1, 5')
    expect(bare.capture.ons.at(-1)?.note).toBe(79)
    const named = await playOnce('r1^1, 5', 'var one = mode(1)\nvar r1 = random.one')
    expect(named.capture.ons.at(-1)?.note).toBe(79)
  })

  it('r1^1.r(1) keeps ^1 sticky for the following 5', async () => {
    const named = await playOnce('r1^1.r(1), 5', 'var one = mode(1)\nvar r1 = random.one')
    expect(named.capture.ons.at(-1)?.note).toBe(79)
  })

  it('r1^1.r(1) in a stack keeps its ^1 structural for sibling and following notes', async () => {
    const named = await playOnce('[r1^1.r(1), 3], 1', 'var one = mode(1)\nvar r1 = random.one')
    expect(named.capture.ons.map(({ note }) => note)).toEqual([72, 64, 60])
  })

  it.each(['lead', 'r1'])(
    '%s.r(1) resolves a named random source structurally inside a stack',
    async (name) => {
      const named = await playOnce(
        `[${name}.r(1), 3]`,
        `var two = mode(1)\nvar ${name} = random.two`,
      )
      expect(named.capture.ons.map(({ note }) => note)).toEqual([60, 64])
    },
  )

  it.each(['chord', 'pattern'])('rejects .r on a %s-bound stack voice at evaluation', (kind) => {
    const global = new Global(new RecordingScheduler())
    if (kind === 'chord') global.importChords()
    else global.definePattern('m7', [1, 2])
    const seq = new Sequence(global, new RecordingScheduler()).setName('p')
    expect(() =>
      seq.play(...(parseAudioDSL('p.play([m7.r, 5])').statements[0]!.args as never[])),
    ).toThrow(
      `"m7" は ${kind} です。[ ] の声部では .r を付けられません（和音全体の間引きは [ … ].r で書きます）`,
    )
  })

  it('random.two chooses both C and G', async () => {
    expectSubsetAndVariety(
      await sample('r1', 'var two = mode(1, 5)\nvar r1 = random.two'),
      [60, 67],
    )
  }, 30000)

  it('a named random lattice overrides an enclosing mode lattice', async () => {
    const notes = await sample(
      '(r1).mode(aeolian)',
      'var two = mode(1, 5)\nvar aeolian = mode(1, 2, b3, 4, 5, b6, b7)\nvar r1 = random.two',
    )
    expectSubsetAndVariety(notes, [60, 67])
  }, 30000)

  it('duplicate lattice entries act as weights within the 99.9% binomial interval', async () => {
    const notes = await sample('rw', 'var w = mode(1, 1, 1, 5)\nvar rw = random.w', 200)
    const tonicCount = notes.filter((note) => note === 60).length
    // Exact equal-tailed 99.9% binomial interval for n=200, p=0.75.
    expect(tonicCount).toBeGreaterThanOrEqual(129)
    expect(tonicCount).toBeLessThanOrEqual(169)
  }, 30000)

  it('a two-octave lattice chooses endpoint and intermediate offsets from 0 through 23', async () => {
    const rolls = [0, 0.25, 0.5, 0.999]
    const random = vi.spyOn(Math, 'random').mockImplementation(() => rolls.shift() ?? 0)
    try {
      const { capture } = await playOnce(
        'rw*4',
        'var wide = mode(1, 3, 5, 7^1)\nvar rw = random.wide',
      )
      expect(capture.ons.map(({ note }) => note)).toEqual([60, 64, 67, 83])
    } finally {
      random.mockRestore()
    }
  }, 30000)

  it('layers group .oct() and per-event ^r on the selected random pitch', async () => {
    expect(await sample('(r1).oct(1)', 'var one = mode(1)\nvar r1 = random.one', 4)).toEqual([
      72, 72, 72, 72,
    ])
    expectSubsetAndVariety(
      await sample('r1^r', 'var one = mode(1)\nvar r1 = random.one'),
      [48, 60, 72],
    )
  }, 30000)

  it('rerolls independently for each TimedEvent and loop iteration (`r*4`)', async () => {
    const { capture } = await playCycles('r*4', '', N)
    const notesByCycle = Array.from({ length: N }, () => [] as number[])
    for (const on of capture.ons) notesByCycle[Math.floor(on.time / 2500)]!.push(on.note)
    expect(notesByCycle.every((notes) => notes.length === 4)).toBe(true)
    for (const notes of notesByCycle) {
      for (const note of notes) expect([60, 62, 64, 65, 67, 69, 71]).toContain(note)
    }
    expect(notesByCycle.some((notes) => new Set(notes).size > 1)).toBe(true)
  }, 30000)

  it('rr and r1.r(0.3) each produce both sounding and silent cycles', async () => {
    for (const [src, prelude] of [
      ['rr', ''],
      ['r1.r(0.3)', 'var two = mode(1, 5)\nvar r1 = random.two'],
    ] as const) {
      const { capture } = await playCycles(src, prelude, N)
      const counts = Array.from({ length: N }, () => 0)
      for (const on of capture.ons) counts[Math.floor(on.time / 2500)]! += 1
      expect(counts).toContain(0)
      expect(counts).toContain(1)
    }
  }, 30000)

  it('[1, r, 5].r(1) always keeps degrees 1 and 5', async () => {
    for (let i = 0; i < N; i++) {
      const notes = (await playOnce('[1, r, 5].r(1)')).capture.ons.map((on) => on.note)
      expect(notes).toContain(60)
      expect(notes).toContain(67)
      expect(notes).toHaveLength(3)
    }
  }, 30000)

  it('(r, _) extends the pitch selected for that cycle', async () => {
    for (let i = 0; i < N; i++) {
      const { capture } = await playOnce('(r, _)')
      expect(capture.ons).toHaveLength(1)
      const selected = capture.ons[0]!.note
      expect(capture.offs.get(selected)?.[0]).toBe(1700)
    }
  }, 30000)

  it('voice-leading excludes a random voice and preserves its authored octaveShift', async () => {
    const { seq } = await playOnce(
      '([1, r1^1, 5], [5, r1^1, 2]).voicelead()',
      'var one = mode(1)\nvar r1 = random.one',
    )
    const randomEvents = seq.getState().timedEvents!.filter((event: any) => event.randomDegree)
    expect(randomEvents).toHaveLength(2)
    for (const event of randomEvents) expect(event.pitch.octaveShift).toBe(1)
  })

  it('applies named-source ~, @v and @g after choosing the pitch', async () => {
    const { capture } = await playOnce('r1~0.5@v110@g20', 'var one = mode(1)\nvar r1 = random.one')
    expect(capture.ons[0]).toMatchObject({ note: 60, velocity: 110 })
    expect(capture.bends).toContain(0.5)
    expect(capture.offs.get(60)?.[0]).toBe(500)
  })

  it('oracle check: the actual one-note lattice fails the two-variety assertion', async () => {
    const notes = await sample('r1', 'var one = mode(1)\nvar r1 = random.one')
    expect(() => expectSubsetAndVariety(notes, [60])).toThrow()
  }, 30000)
})
