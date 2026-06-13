import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MidiOutput } from '../../packages/engine/src/midi/midi-output'
import {
  MidiScheduler,
  MidiSchedulerOptions,
  ScheduledMidiNote,
} from '../../packages/engine/src/midi/midi-scheduler'

/**
 * MidiScheduler tests (#221)
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §7-3, §7-4
 *
 * All tests use vitest fake timers and a mock MidiOutput that records calls
 * into a shared ordered call-log so cross-method ordering can be asserted.
 */

// ---------------------------------------------------------------------------
// Mock MidiOutput
// ---------------------------------------------------------------------------

interface CallRecord {
  method: string
  args: unknown[]
}

interface MockMidiOutput extends MidiOutput {
  calls: CallRecord[]
  callsFor(method: string): CallRecord[]
}

function makeMockOutput(): MockMidiOutput {
  const calls: CallRecord[] = []

  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args })
    }

  return {
    calls,

    callsFor(method: string): CallRecord[] {
      return calls.filter((c) => c.method === method)
    },

    ensurePort: (portName: string) => portName,
    noteOn: record('noteOn') as MidiOutput['noteOn'],
    noteOff: record('noteOff') as MidiOutput['noteOff'],
    pitchBend: record('pitchBend') as MidiOutput['pitchBend'],
    releaseOwner: record('releaseOwner') as MidiOutput['releaseOwner'],
    panic: record('panic') as MidiOutput['panic'],
    getActiveNotes: () => [],
    listPorts: () => [],
    closeAll: record('closeAll') as MidiOutput['closeAll'],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIME = 1_000_000

function makeNote(overrides: Partial<ScheduledMidiNote> = {}): ScheduledMidiNote {
  return {
    owner: 'seq1',
    port: 'TestPort',
    channel: 1,
    note: 60,
    velocity: 100,
    detune: 0,
    onTime: BASE_TIME + 100,
    offTime: BASE_TIME + 500,
    ...overrides,
  }
}

function makeScheduler(output: MidiOutput, options?: MidiSchedulerOptions): MidiScheduler {
  return new MidiScheduler(output, options)
}

// ---------------------------------------------------------------------------
// Fake timer sanity check (confirms Date.now() advances with advanceTimersByTime)
// ---------------------------------------------------------------------------

describe('fake timer sanity check', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Date.now() advances with advanceTimersByTime', () => {
    expect(Date.now()).toBe(BASE_TIME)
    vi.advanceTimersByTime(50)
    expect(Date.now()).toBe(BASE_TIME + 50)
  })
})

// ---------------------------------------------------------------------------
// Basic note scheduling
// ---------------------------------------------------------------------------

describe('MidiScheduler — basic note scheduling', () => {
  let output: MockMidiOutput
  let scheduler: MidiScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    output = makeMockOutput()
    scheduler = makeScheduler(output, { tickMs: 5 })
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('fires note-on at onTime and note-off at offTime (call order and args)', () => {
    const n = makeNote({ onTime: BASE_TIME + 100, offTime: BASE_TIME + 500 })
    scheduler.scheduleNote(n)
    scheduler.start()

    // Before onTime — nothing should fire
    vi.advanceTimersByTime(90)
    expect(output.callsFor('noteOn')).toHaveLength(0)
    expect(output.callsFor('noteOff')).toHaveLength(0)

    // Advance to just past onTime
    vi.advanceTimersByTime(15) // now at BASE_TIME + 105
    expect(output.callsFor('noteOn')).toHaveLength(1)
    expect(output.callsFor('noteOn')[0]?.args).toEqual(['TestPort', 1, 60, 100, 'seq1'])
    expect(output.callsFor('noteOff')).toHaveLength(0)

    // Advance to just past offTime
    vi.advanceTimersByTime(400) // now at BASE_TIME + 505
    expect(output.callsFor('noteOff')).toHaveLength(1)
    expect(output.callsFor('noteOff')[0]?.args).toEqual(['TestPort', 1, 60, 'seq1'])
  })

  it('nothing fires before onTime (advance to just before onTime)', () => {
    const n = makeNote({ onTime: BASE_TIME + 100, offTime: BASE_TIME + 200 })
    scheduler.scheduleNote(n)
    scheduler.start()

    vi.advanceTimersByTime(95) // BASE_TIME + 95 < onTime
    expect(output.callsFor('noteOn')).toHaveLength(0)
  })

  it('action scheduled in the past fires on the next tick, not dropped', () => {
    // Note already past-due relative to current system time
    const pastNote = makeNote({
      onTime: BASE_TIME - 1000,
      offTime: BASE_TIME - 500,
    })
    scheduler.scheduleNote(pastNote)
    scheduler.start()

    // Advance one tick — both should fire
    vi.advanceTimersByTime(5)
    expect(output.callsFor('noteOn')).toHaveLength(1)
    expect(output.callsFor('noteOff')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Pitch bend (detune)
// ---------------------------------------------------------------------------

describe('MidiScheduler — detune / pitch bend', () => {
  let output: MockMidiOutput
  let scheduler: MidiScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    output = makeMockOutput()
    scheduler = makeScheduler(output, { tickMs: 5 })
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('detune !== 0 sends pitchBend immediately before note-on (same tick)', () => {
    const n = makeNote({ detune: 1, onTime: BASE_TIME + 100 })
    scheduler.scheduleNote(n)
    scheduler.start()

    vi.advanceTimersByTime(105)

    expect(output.callsFor('pitchBend')).toHaveLength(1)
    expect(output.callsFor('noteOn')).toHaveLength(1)

    // pitchBend must appear before noteOn in the shared call log
    const bendIdx = output.calls.findIndex((c) => c.method === 'pitchBend')
    const onIdx = output.calls.findIndex((c) => c.method === 'noteOn')
    expect(bendIdx).toBeLessThan(onIdx)

    // Check pitchBend args: port, channel, detune
    expect(output.callsFor('pitchBend')[0]?.args).toEqual(['TestPort', 1, 1])
  })

  it('detune === 0 sends no pitchBend', () => {
    const n = makeNote({ detune: 0, onTime: BASE_TIME + 50 })
    scheduler.scheduleNote(n)
    scheduler.start()

    vi.advanceTimersByTime(60)

    expect(output.callsFor('pitchBend')).toHaveLength(0)
    expect(output.callsFor('noteOn')).toHaveLength(1)
  })

  it('detune !== 0 resets pitch bend to center after note-off (no residual on the channel)', () => {
    const n = makeNote({ detune: 1, onTime: BASE_TIME + 100, offTime: BASE_TIME + 300 })
    scheduler.scheduleNote(n)
    scheduler.start()

    // Advance past offTime so both the detune bend (at onTime) and the reset
    // (at offTime) fire.
    vi.advanceTimersByTime(310)

    const bends = output.callsFor('pitchBend')
    expect(bends).toHaveLength(2)
    expect(bends[0]?.args).toEqual(['TestPort', 1, 1]) // detune at note-on
    expect(bends[1]?.args).toEqual(['TestPort', 1, 0]) // reset to center after note-off

    // The reset must come after the note-off, leaving the channel centered.
    const offIdx = output.calls.findIndex((c) => c.method === 'noteOff')
    const resetIdx = output.calls.map((c) => c.method).lastIndexOf('pitchBend')
    expect(offIdx).toBeLessThan(resetIdx)
  })
})

// ---------------------------------------------------------------------------
// Multiple notes, time ordering
// ---------------------------------------------------------------------------

describe('MidiScheduler — multiple notes fire in time order', () => {
  let output: MockMidiOutput
  let scheduler: MidiScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    output = makeMockOutput()
    scheduler = makeScheduler(output, { tickMs: 5 })
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('two notes with different onTimes fire in chronological order', () => {
    const earlyNote = makeNote({ note: 60, onTime: BASE_TIME + 50, offTime: BASE_TIME + 300 })
    const lateNote = makeNote({ note: 64, onTime: BASE_TIME + 200, offTime: BASE_TIME + 400 })

    scheduler.scheduleNote(earlyNote)
    scheduler.scheduleNote(lateNote)
    scheduler.start()

    // Advance just past the early note's onTime but before late note's onTime
    vi.advanceTimersByTime(60) // BASE_TIME + 60
    expect(output.callsFor('noteOn')).toHaveLength(1)
    expect(output.callsFor('noteOn')[0]?.args[2]).toBe(60)

    // Advance past the late note's onTime
    vi.advanceTimersByTime(150) // BASE_TIME + 210
    expect(output.callsFor('noteOn')).toHaveLength(2)
    expect(output.callsFor('noteOn')[1]?.args[2]).toBe(64)
  })

  it('actions that fall in the same tick are fired in (time, seq) order', () => {
    // Both notes have the same onTime → seq determines order; bend should precede note-on
    const onTime = BASE_TIME + 100
    const n1 = makeNote({ note: 60, detune: 0.5, onTime, offTime: onTime + 200 })
    const n2 = makeNote({ note: 64, detune: 0, onTime: onTime + 1, offTime: onTime + 200 })

    scheduler.scheduleNote(n1)
    scheduler.scheduleNote(n2)
    scheduler.start()

    vi.advanceTimersByTime(110)

    // pitchBend for n1 should appear before noteOn for n1
    const bendIdx = output.calls.findIndex((c) => c.method === 'pitchBend')
    const onIdx1 = output.calls.findIndex(
      (c) => c.method === 'noteOn' && (c.args[2] as number) === 60,
    )
    expect(bendIdx).toBeLessThan(onIdx1)

    // Both notes' noteOns have fired
    const noteOns = output.callsFor('noteOn')
    expect(noteOns).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// clearOwner
// ---------------------------------------------------------------------------

describe('MidiScheduler — clearOwner', () => {
  let output: MockMidiOutput
  let scheduler: MidiScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    output = makeMockOutput()
    scheduler = makeScheduler(output, { tickMs: 5 })
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('removes pending actions for the given owner — they never fire', () => {
    const n = makeNote({ owner: 'seqA', note: 60, onTime: BASE_TIME + 100 })
    scheduler.scheduleNote(n)
    scheduler.start()

    // Clear before onTime
    scheduler.clearOwner('seqA')

    vi.advanceTimersByTime(200) // past onTime
    expect(output.callsFor('noteOn')).toHaveLength(0)
    expect(output.callsFor('noteOff')).toHaveLength(0)
  })

  it('calls output.releaseOwner(owner)', () => {
    const n = makeNote({ owner: 'seqA' })
    scheduler.scheduleNote(n)
    scheduler.start()

    scheduler.clearOwner('seqA')

    expect(output.callsFor('releaseOwner')).toHaveLength(1)
    expect(output.callsFor('releaseOwner')[0]?.args).toEqual(['seqA'])
  })

  it("other owners' pending notes still fire after clearOwner", () => {
    const nA = makeNote({ owner: 'seqA', note: 60, onTime: BASE_TIME + 100 })
    const nB = makeNote({ owner: 'seqB', note: 64, onTime: BASE_TIME + 100 })

    scheduler.scheduleNote(nA)
    scheduler.scheduleNote(nB)
    scheduler.start()

    scheduler.clearOwner('seqA')

    vi.advanceTimersByTime(200)

    // seqA's note should not have fired
    const noteOns = output.callsFor('noteOn')
    expect(noteOns).toHaveLength(1)
    expect(noteOns[0]?.args[4]).toBe('seqB') // 5th arg of noteOn is owner
  })

  it('pendingCount drops to 0 after clearOwner removes all', () => {
    scheduler.scheduleNote(
      makeNote({ owner: 'seqA', onTime: BASE_TIME + 100, offTime: BASE_TIME + 500 }),
    )
    expect(scheduler.pendingCount()).toBe(2) // on + off

    scheduler.clearOwner('seqA')
    expect(scheduler.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('MidiScheduler — stop()', () => {
  let output: MockMidiOutput
  let scheduler: MidiScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    output = makeMockOutput()
    scheduler = makeScheduler(output, { tickMs: 5 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears the interval so pending notes do not fire afterward', () => {
    const n = makeNote({ onTime: BASE_TIME + 100, offTime: BASE_TIME + 500 })
    scheduler.scheduleNote(n)
    scheduler.start()

    scheduler.stop()

    vi.advanceTimersByTime(600) // well past both times
    expect(output.callsFor('noteOn')).toHaveLength(0)
    expect(output.callsFor('noteOff')).toHaveLength(0)
  })

  it('calls output.panic()', () => {
    scheduler.start()
    scheduler.stop()
    expect(output.callsFor('panic')).toHaveLength(1)
  })

  it('sets isRunning to false', () => {
    scheduler.start()
    expect(scheduler.isRunning).toBe(true)
    scheduler.stop()
    expect(scheduler.isRunning).toBe(false)
  })

  it('clears the queue (pendingCount = 0 after stop)', () => {
    scheduler.scheduleNote(makeNote())
    expect(scheduler.pendingCount()).toBeGreaterThan(0)
    scheduler.start()
    scheduler.stop()
    expect(scheduler.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// start() idempotency
// ---------------------------------------------------------------------------

describe('MidiScheduler — start() idempotency', () => {
  let output: MockMidiOutput
  let scheduler: MidiScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    output = makeMockOutput()
    scheduler = makeScheduler(output, { tickMs: 5 })
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('calling start() twice does not double-fire actions', () => {
    const n = makeNote({ onTime: BASE_TIME + 100 })
    scheduler.scheduleNote(n)

    scheduler.start()
    scheduler.start() // second call is a no-op

    vi.advanceTimersByTime(110)

    // noteOn must fire exactly once
    expect(output.callsFor('noteOn')).toHaveLength(1)
  })

  it('isRunning is true after start() and remains true after redundant start()', () => {
    expect(scheduler.isRunning).toBe(false)
    scheduler.start()
    expect(scheduler.isRunning).toBe(true)
    scheduler.start()
    expect(scheduler.isRunning).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isRunning reflects start/stop
// ---------------------------------------------------------------------------

describe('MidiScheduler — isRunning', () => {
  let output: MockMidiOutput
  let scheduler: MidiScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    output = makeMockOutput()
    scheduler = makeScheduler(output)
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('is false before start()', () => {
    expect(scheduler.isRunning).toBe(false)
  })

  it('is true after start()', () => {
    scheduler.start()
    expect(scheduler.isRunning).toBe(true)
  })

  it('is false after stop()', () => {
    scheduler.start()
    scheduler.stop()
    expect(scheduler.isRunning).toBe(false)
  })
})
