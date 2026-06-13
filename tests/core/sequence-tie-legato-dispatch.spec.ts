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
