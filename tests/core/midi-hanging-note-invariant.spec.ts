import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { RtMidiOutput } from '../../packages/engine/src/midi/rtmidi-output'
import { MidiBackend, MidiBackendPort } from '../../packages/engine/src/midi/midi-output'

/**
 * Phase 1 (#228) — acceptance: hanging-note invariant (§7-2)
 *
 * The gate criterion: across LOOP play() swaps / MUTE / stop, note-on count
 * must equal note-off count and no note may be left sounding. Uses the REAL
 * RtMidiOutput (with a recording mock backend) so the actual tracking +
 * releaseOwner + panic paths are exercised, plus fake timers for the scheduler.
 */

const T0 = 2_000_000

/** A recording backend: every sent message is logged per port. */
function recordingBackend(): { backend: MidiBackend; messages: number[][] } {
  const messages: number[][] = []
  const port: MidiBackendPort = {
    sendMessage: (m: number[]) => messages.push(m),
    closePort: () => {},
  }
  return {
    messages,
    backend: {
      listPortNames: () => ['IACドライバ バス1'],
      openPort: () => port,
    },
  }
}

/** Count note-on (0x90, vel>0) and note-off (0x80, or 0x90 vel 0) messages. */
function countNotes(messages: number[][]): { on: number; off: number } {
  let on = 0
  let off = 0
  for (const m of messages) {
    const status = m[0]! & 0xf0
    if (status === 0x90 && m[2]! > 0) on++
    else if (status === 0x80 || (status === 0x90 && m[2] === 0)) off++
  }
  return { on, off }
}

function mockScheduler() {
  return {
    isRunning: true,
    startTime: T0,
    getCurrentTime: () => 0,
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    getMasterGainDb: () => 0,
    stopAll: vi.fn(),
  } as never
}

describe('MIDI hanging-note invariant (§7-2 acceptance)', () => {
  let global: Global
  let seq: Sequence
  let out: RtMidiOutput
  let rec: ReturnType<typeof recordingBackend>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    rec = recordingBackend()
    out = new RtMidiOutput(rec.backend)
    const sched = mockScheduler()
    global = new Global(sched, new MidiManager(() => out))
    global.key('C')
    seq = new Sequence(global, sched)
    seq.setName('piano')
    seq.midi('iac', 1)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('100 LOOP play() swaps leave zero hanging notes', async () => {
    seq.play(1, 3, 5, 7) // a chord arpeggio across the bar
    await seq.loop()

    // Hammer play() 100 times, advancing the clock a bit between each so notes
    // actually fire and get released before the next swap.
    for (let i = 0; i < 100; i++) {
      seq.play((i % 7) + 1, ((i + 2) % 7) + 1, ((i + 4) % 7) + 1)
      await vi.advanceTimersByTimeAsync(250)
    }

    // Let any in-flight notes finish, then stop.
    await vi.advanceTimersByTimeAsync(3000)
    seq.stop()

    // Invariant 1: nothing is left sounding.
    expect(out.getActiveNotes()).toHaveLength(0)

    // Invariant 2: every note-on was matched by a note-off (release path).
    const { on, off } = countNotes(rec.messages)
    expect(off).toBeGreaterThanOrEqual(on)
    expect(on).toBeGreaterThan(0) // sanity: notes actually played
  })

  it('MUTE during a LOOP releases all sounding notes', async () => {
    seq.play(1, 3, 5)
    await seq.loop()
    await vi.advanceTimersByTimeAsync(200) // let some notes sound
    seq.mute()
    expect(out.getActiveNotes()).toHaveLength(0)
  })

  it('global.stop() panics — CC123 + CC120 on all channels, no active notes', async () => {
    seq.play(1, 3, 5)
    await seq.loop()
    await vi.advanceTimersByTimeAsync(200)
    global.stop()

    expect(out.getActiveNotes()).toHaveLength(0)
    // Panic sends CC123 and CC120 (controllers 123 / 120).
    const cc123 = rec.messages.some((m) => (m[0]! & 0xf0) === 0xb0 && m[1] === 123)
    const cc120 = rec.messages.some((m) => (m[0]! & 0xf0) === 0xb0 && m[1] === 120)
    expect(cc123).toBe(true)
    expect(cc120).toBe(true)
  })
})
