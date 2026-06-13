import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Phase 4 (#236) — tie / voice-tie / legato / hold MIDI dispatch (§5/§4). A
 * recording backend logs note-on/off in FIRE order (fake timers advance the
 * scheduler in time order), so we can assert legato overlap ordering and the
 * note-on suppression / hanging-note invariant (every on has exactly one off).
 */

const T0 = 1_000_000
type Ev = { type: 'on' | 'off'; note: number }

function recordingOutput(log: Ev[]): MidiOutput {
  return {
    ensurePort: vi.fn((q: string) => (/iac/i.test(q) ? 'IACドライバ バス1' : q)),
    noteOn: vi.fn((_p: string, _c: number, note: number) => {
      log.push({ type: 'on', note })
    }),
    noteOff: vi.fn((_p: string, _c: number, note: number) => {
      log.push({ type: 'off', note })
    }),
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

async function playLog(src: string, configure: (s: Sequence) => void = () => {}): Promise<Ev[]> {
  vi.setSystemTime(T0)
  const sched = mockScheduler()
  const log: Ev[] = []
  const global = new Global(sched, new MidiManager(() => recordingOutput(log)))
  global.key('C')
  global.start()
  const seq = new Sequence(global, sched)
  seq.setName('piano')
  seq.midi('iac', 1).octave(4)
  configure(seq)
  seq.play(...(parseAudioDSL(`p.play(${src})`).statements[0].args as never[]))
  await seq.run()
  await vi.advanceTimersByTimeAsync(3000)
  return log
}

const ons = (log: Ev[]) => log.filter((e) => e.type === 'on').map((e) => e.note)
const offs = (log: Ev[]) => log.filter((e) => e.type === 'off').map((e) => e.note)
const firstIdx = (log: Ev[], type: 'on' | 'off', note: number) =>
  log.findIndex((e) => e.type === type && e.note === note)

/** The hanging-note invariant: every note-on has exactly one matching note-off. */
function expectBalanced(log: Ev[]) {
  const on = ons(log)
    .slice()
    .sort((a, b) => a - b)
  const off = offs(log)
    .slice()
    .sort((a, b) => a - b)
  expect(off).toEqual(on)
}

describe('Phase 4 — legato `{ }` dispatch (§4)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('legato delays the note-off PAST the next note-on (overlap)', async () => {
    const log = await playLog('{1, 2, 3}')
    // C(60) D(62) E(64). Interior note-offs overlap the next note-on:
    expect(firstIdx(log, 'off', 60)).toBeGreaterThan(firstIdx(log, 'on', 62))
    expect(firstIdx(log, 'off', 62)).toBeGreaterThan(firstIdx(log, 'on', 64))
    expectBalanced(log)
  })

  it('a plain `( )` group does NOT overlap (note-off before next note-on)', async () => {
    const log = await playLog('(1, 2, 3)')
    expect(firstIdx(log, 'off', 60)).toBeLessThan(firstIdx(log, 'on', 62))
    expectBalanced(log)
  })
})

describe('Phase 4 — `_` event tie (§5.1)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('`1, _, 3` plays TWO notes (the `_` extends the 1, no retrigger)', async () => {
    const log = await playLog('1, _, 3')
    expect(ons(log)).toEqual([60, 64]) // C then E — no second C
    expectBalanced(log)
  })

  it('a pattern-leading `_` is a rest (no carryover on RUN)', async () => {
    const log = await playLog('_, 3')
    expect(ons(log)).toEqual([64]) // only E
    expectBalanced(log)
  })
})

describe('Phase 4 — `_n` voice tie + `.hold()` (§5.2/§5.3)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('`_5` holds the common 5 across two stacks (one note-on, not two)', async () => {
    const log = await playLog('[1, 3, 5], [1, 3, _5]')
    // stack1: 60,64,67 ; stack2: 60,64 retrigger, 67 held (suppressed)
    expect(ons(log).filter((n) => n === 67)).toEqual([67]) // G sounds once
    expect(ons(log).filter((n) => n === 60)).toEqual([60, 60]) // C retriggers
    expectBalanced(log)
  })

  it('`_5` with no matching previous pitch falls back to a normal note-on', async () => {
    const log = await playLog('[1, 3], [1, _5]')
    // no 5 in the previous stack → the _5 just plays (fallback)
    expect(ons(log).filter((n) => n === 67)).toEqual([67])
    expectBalanced(log)
  })

  it('`.hold()` auto-ties common tones between consecutive stacks', async () => {
    const log = await playLog('[1, 3, 5], [1, 3, 5]', (s) => s.hold())
    // all three are common → second stack fully suppressed: 3 note-ons total
    expect(
      ons(log)
        .slice()
        .sort((a, b) => a - b),
    ).toEqual([60, 64, 67])
    expectBalanced(log)
  })

  it('`.hold()` does NOT tie repeated single notes (rhythm preserved, decision #8)', async () => {
    const log = await playLog('1, 1', (s) => s.hold())
    expect(ons(log)).toEqual([60, 60]) // two separate C note-ons
    expectBalanced(log)
  })
})

/**
 * A `_` event tie extends the previous EVENT (§5.1). For a `[ ]` stack that is the
 * whole chord (all voices share one onset, §4), so these tests assert FIRE TIME, not
 * just order: the recording backend stamps `Date.now() - T0` (fake-timer time) on
 * each note so we can prove every voice extends together rather than just the last.
 */
describe('Phase 4 — `_` after a stack / a rest (§5.1)', () => {
  type EvT = { type: 'on' | 'off'; note: number; t: number }
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function recordingOutputT(log: EvT[]): MidiOutput {
    return {
      ensurePort: vi.fn((q: string) => (/iac/i.test(q) ? 'IACドライバ バス1' : q)),
      noteOn: vi.fn((_p: string, _c: number, note: number) =>
        log.push({ type: 'on', note, t: Date.now() - T0 }),
      ),
      noteOff: vi.fn((_p: string, _c: number, note: number) =>
        log.push({ type: 'off', note, t: Date.now() - T0 }),
      ),
      pitchBend: vi.fn(),
      releaseOwner: vi.fn(),
      panic: vi.fn(),
      getActiveNotes: vi.fn(() => []),
      listPorts: vi.fn(() => ['IACドライバ バス1']),
      closeAll: vi.fn(),
    }
  }

  async function playLogT(src: string): Promise<EvT[]> {
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    const log: EvT[] = []
    const global = new Global(sched, new MidiManager(() => recordingOutputT(log)))
    global.key('C')
    global.start()
    const seq = new Sequence(global, sched)
    seq.setName('piano')
    seq.midi('iac', 1).octave(4)
    seq.play(...(parseAudioDSL(`p.play(${src})`).statements[0].args as never[]))
    await seq.run()
    await vi.advanceTimersByTimeAsync(3000)
    return log
  }

  const offTimeOf = (log: EvT[], note: number) =>
    log.find((e) => e.type === 'off' && e.note === note)?.t ?? -1

  it('`[1, 3, 5], _` sustains the WHOLE chord, not just one voice', async () => {
    const log = await playLogT('[1, 3, 5], _')
    // No retrigger: each of C/E/G sounds exactly once.
    expect(
      log
        .filter((e) => e.type === 'on')
        .map((e) => e.note)
        .sort((a, b) => a - b),
    ).toEqual([60, 64, 67])
    expect(
      log
        .filter((e) => e.type === 'off')
        .map((e) => e.note)
        .sort((a, b) => a - b),
    ).toEqual([60, 64, 67])
    // All three note-offs fire at the same extended time. Under the single-voice
    // bug the lower two would cut a full slot (~900ms) early — so they cluster.
    const offT = log.filter((e) => e.type === 'off').map((e) => e.t)
    expect(Math.max(...offT) - Math.min(...offT)).toBeLessThan(150)
  })

  it('`_` after a rest extends nothing — the rest breaks the tie chain', async () => {
    // 1, 0, _, 5 (4 slots of 500ms): the rest (0) clears the chain, so the `_`
    // extends nothing and the C is NOT sustained across it.
    const tied = await playLogT('1, _, 0, 5') // `_` right after C → C spans 2 slots
    const broken = await playLogT('1, 0, _, 5') // rest before `_` → C spans 1 slot
    expect(offTimeOf(tied, 60)).toBeGreaterThan(offTimeOf(broken, 60) + 200)
  })

  it('`_` after a stack carrying a voice tie also extends the held note (§5.1+§5.2)', async () => {
    // [3,5],[3,_5],_ : the 5 is held from stack 1 across stack 2 (`_5`), and the
    // trailing `_` must extend that held note too. Compare against `,0` (a rest in
    // the same slot, which must NOT extend it) at an identical 3-slot grid.
    const tied = await playLogT('[3, 5], [3, _5], _')
    const rested = await playLogT('[3, 5], [3, _5], 0')
    // G (67) sounds once (held), and the trailing `_` pushes its note-off later.
    expect(tied.filter((e) => e.type === 'on' && e.note === 67)).toHaveLength(1)
    expect(offTimeOf(tied, 67)).toBeGreaterThan(offTimeOf(rested, 67) + 200)
  })
})
