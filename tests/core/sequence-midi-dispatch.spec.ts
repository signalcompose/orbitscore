import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/**
 * Phase 1 increment 5c (#228) — MIDI dispatch end-to-end
 *
 * A MIDI sequence's play() degrees resolve to MIDI notes (§7-0 output stage)
 * and fire via the MidiScheduler → MidiOutput. Uses fake timers + a mock
 * MidiOutput so no real hardware is touched.
 */

const T0 = 1_000_000 // fixed epoch base for the shared clock

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

describe('Sequence MIDI dispatch (§7-0 output stage)', () => {
  let global: Global
  let seq: Sequence
  let out: MidiOutput

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    out = mockMidiOutput()
    global = new Global(sched, new MidiManager(() => out))
    global.key('C')
    global.start() // stamps the shared TransportClock (Date.now() = T0 under fake timers)
    seq = new Sequence(global, sched)
    seq.setName('piano')
    seq.midi('iac', 1).octave(4)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves degrees to MIDI notes and fires note-on, skipping rests', async () => {
    // play(1, 0, 3) in C, octave 4 → C4(60), rest, E4(64) across a 2000ms bar
    seq.play(1, 0, 3)
    await seq.run()

    // Advance past the whole bar so every scheduled note fires.
    await vi.advanceTimersByTimeAsync(2100)

    const notes = (out.noteOn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])
    expect(notes).toContain(60) // degree 1 = C4
    expect(notes).toContain(64) // degree 3 = E4
    expect(notes).not.toContain(0) // rest produced no note
    expect(notes).toHaveLength(2)

    // velocity + channel + owner threaded through
    const firstCall = (out.noteOn as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(firstCall[1]).toBe(1) // channel
    expect(firstCall[3]).toBe(96) // default velocity
    expect(firstCall[4]).toBe('piano') // owner
  })

  it('applies altered degrees (b3 → Eb4) and octave shift', async () => {
    // Build the pattern via the parser path so PlayPitch nodes flow through.
    const { parseAudioDSL } = await import('../../packages/engine/src/parser/audio-parser')
    const args = parseAudioDSL('p.play(b3, 1^+1)').statements[0].args
    seq.play(...(args as never[]))
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)

    const notes = (out.noteOn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])
    expect(notes).toContain(63) // b3 = Eb4
    expect(notes).toContain(72) // 1^+1 = C5
  })

  it('honors seq.octave for the base register', async () => {
    seq.octave(5) // degree 1 now C5 = 72
    seq.play(1)
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)
    expect((out.noteOn as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(72)
  })

  it('sends a matching note-off for every note-on (gate)', async () => {
    seq.play(1, 5)
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)
    expect((out.noteOn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    expect((out.noteOff as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it('stop() releases the sequence (clearOwner → releaseOwner)', async () => {
    seq.play(1)
    await seq.run()
    seq.stop()
    expect(out.releaseOwner).toHaveBeenCalledWith('piano')
  })

  it('throws when a degree needs a root but no key/root is set', async () => {
    const sched = mockScheduler()
    const out2 = mockMidiOutput()
    const g2 = new Global(sched, new MidiManager(() => out2)) // no global.key()
    const s2 = new Sequence(g2, sched)
    s2.setName('lead')
    s2.midi('iac', 1)
    s2.play(1)
    await expect(s2.run()).rejects.toThrow(/need a root/)
  })
})
