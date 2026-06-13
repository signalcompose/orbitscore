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

  it('§2.4 sticky pitch range: `^N` persists to following degrees (not one-shot)', async () => {
    const { parseAudioDSL } = await import('../../packages/engine/src/parser/audio-parser')
    // play(1, 3^1, 5): 1=C4(60); 3^1 enters +1 → E5(76); 5 INHERITS +1 → G5(79).
    // A one-shot `^` would give the trailing 5 = G4(67); sticky gives G5(79).
    const args = parseAudioDSL('p.play(1, 3^1, 5)').statements[0].args
    seq.play(...(args as never[]))
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)

    const notes = (out.noteOn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])
    expect(notes).toContain(60) // 1 = C4 (base range)
    expect(notes).toContain(76) // 3^1 = E5 (range +1 set here)
    expect(notes).toContain(79) // 5 = G5 (range +1 persists) ← sticky proof
    expect(notes).not.toContain(67) // would be G4 if one-shot
    expect(notes).toHaveLength(3)
  })

  it('§2.4 `^0` resets the range; `0^N` moves the range silently on a rest', async () => {
    const { parseAudioDSL } = await import('../../packages/engine/src/parser/audio-parser')
    // play(0^2, 1, 1^0, 1): 0^2 = rest that sets range +2 (no note);
    // 1 = C6(84); 1^0 resets → C4(60); trailing 1 = C4(60).
    const args = parseAudioDSL('p.play(0^2, 1, 1^0, 1)').statements[0].args
    seq.play(...(args as never[]))
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)

    const notes = (out.noteOn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])
    expect(notes).toContain(84) // 1 at range +2 = C6 (0^2 moved the range, fired nothing)
    expect(notes).toContain(60) // after 1^0 → C4
    expect(notes).not.toContain(72) // never C5 — range went +2 then straight to 0
    expect(notes).toHaveLength(3) // C6, C4, C4 — the 0^2 rest produced no note
  })

  it('§2.4 running range persists PAST a nested group boundary (linear, not lexical)', async () => {
    const { parseAudioDSL } = await import('../../packages/engine/src/parser/audio-parser')
    // play((1, 5^1, 1), 1, 5): 5^1 sets +1 inside the tuple; the trailing 1 and 5
    // are OUTSIDE the tuple. Linear (confirmed): range +1 persists past the group →
    // trailing 5 = G5(79). Lexical would reset at the group exit → trailing 5 = G4(67).
    // Flattened reading order: [1, 5^1, 1, 1, 5] → 60, 79(G5), 72(C5), 72(C5), 79(G5).
    const args = parseAudioDSL('p.play((1, 5^1, 1), 1, 5)').statements[0].args
    seq.play(...(args as never[]))
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)

    const notes = (out.noteOn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])
    expect(notes).toContain(60) // first 1 = C4 (base, before ^1)
    expect(notes).toContain(79) // 5^1 = G5, AND trailing 5 = G5 (range persisted)
    expect(notes).toContain(72) // 1 at range +1 = C5
    expect(notes).not.toContain(67) // never G4 — proves the trailing 5 kept +1 past the group
    expect(notes).toHaveLength(5)
  })

  it('§2.1 rejected degree 10 propagates as a run() rejection (not swallowed at dispatch)', async () => {
    seq.play(10) // outside {1-9, 11, 13}
    await expect(seq.run()).rejects.toThrow(/受理されません|\^N/)
  })

  it('§2.1 rejected degree 15 propagates as a run() rejection', async () => {
    seq.play(15)
    await expect(seq.run()).rejects.toThrow()
  })

  it('§2.4 tension degrees 9/11/13 inherit the running range', async () => {
    const { parseAudioDSL } = await import('../../packages/engine/src/parser/audio-parser')
    // 9^1 sets range +1 → D6 (base D5 74 + 12 = 86); 11 inherits +1 → F6 (77 + 12 = 89)
    const args = parseAudioDSL('p.play(9^1, 11)').statements[0].args
    seq.play(...(args as never[]))
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)

    const notes = (out.noteOn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])
    expect(notes).toContain(86) // D6 = tension 9 at range +1
    expect(notes).toContain(89) // F6 = tension 11 inheriting range +1
    expect(notes).not.toContain(74) // D5 would mean range was not applied
    expect(notes).toHaveLength(2)
  })

  it('§2.4 altered degree inherits the running range (play(3^1, b5) → E5, Gb5)', async () => {
    const { parseAudioDSL } = await import('../../packages/engine/src/parser/audio-parser')
    // 3^1 sets range +1 → E5 (76); b5 has rangeSet:false, inherits +1 → Gb5 (66 + 12 = 78)
    const args = parseAudioDSL('p.play(3^1, b5)').statements[0].args
    seq.play(...(args as never[]))
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)

    const notes = (out.noteOn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])
    expect(notes).toContain(76) // E5 = degree 3 at range +1
    expect(notes).toContain(78) // Gb5 = b5 inheriting range +1
    expect(notes).not.toContain(66) // Gb4 would mean range was not inherited
    expect(notes).toHaveLength(2)
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
