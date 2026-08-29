import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/**
 * #654 — the live playhead (#390) must step for NOTE sequences too.
 *
 * Before this, `[STEP]` was emitted only from the audio backend
 * (rust-engine-player.ts), so `instrument()` / `midi()` sequences never moved
 * the highlight. These tests pin the marker stream produced by the MIDI
 * dispatch path, mirroring the audio-side contract in
 * tests/core/event-scheduler-step-marker.spec.ts.
 *
 * The bar is 2000ms (4/4 @ 120bpm) under fake timers, so an N-slot pattern
 * puts slot i at T0 + round(i * 2000 / N).
 */

const T0 = 1_000_000
const BAR_MS = 2000
/** run() schedules the bar this far ahead (run-sequence.ts). */
const LEAD_IN_MS = 100

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

describe('#654 live playhead markers for note sequences', () => {
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
    global.start()
    seq = new Sequence(global, sched)
    seq.setName('piano')
    seq.midi('iac', 1).octave(4)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Every `[STEP]` line printed so far, parsed into its three fields. */
  function steps(): Array<{ seqName: string; argPath: string; atMs: number }> {
    return (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('[STEP] '))
      .map((l) => {
        const [, seqName, argPath, at] = l.split(/\s+/)
        return { seqName, argPath, atMs: Number(at) }
      })
  }

  async function playDsl(src: string, advanceMs = BAR_MS + 100): Promise<void> {
    const { parseAudioDSL } = await import('../../packages/engine/src/parser/audio-parser')
    seq.play(...(parseAudioDSL(src).statements[0].args as never[]))
    await seq.run()
    await vi.advanceTimersByTimeAsync(advanceMs)
  }

  it('emits one marker per slot, in order, at the slot grid time', async () => {
    await playDsl('p.play(1, 3, 5, 6)')

    expect(steps().map((s) => s.argPath)).toEqual(['0', '1', '2', '3'])
    expect(steps().every((s) => s.seqName === 'piano')).toBe(true)
    // Grid times, not "now": run() schedules the bar 100ms ahead of the call
    // (run-sequence.ts `scheduleTime = currentTime + 100`), then slot i sits at
    // i * 500 inside it. Asserting the absolute values pins BOTH that the
    // marker uses the grid rather than the moment it was queued, and that the
    // four slots stay evenly spaced.
    expect(steps().map((s) => s.atMs)).toEqual([
      T0 + LEAD_IN_MS,
      T0 + LEAD_IN_MS + 500,
      T0 + LEAD_IN_MS + 1000,
      T0 + LEAD_IN_MS + 1500,
    ])
  })

  it('emits no markers for an unnamed sequence (the line would not parse)', async () => {
    // The `[STEP]` grammar takes seqName as `\S+`; an empty name would print
    // "[STEP]  0 …" and be silently dropped by the extension. Skip it at the
    // source instead, as the audio path does.
    seq.setName('')
    await playDsl('p.play(1, 3)')

    expect(steps()).toEqual([])
    expect((out.noteOn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('steps through a rest slot (0) — the sequence is processing the silence', async () => {
    await playDsl('p.play(1, 0, 5)')

    // Three markers though only two notes sound: the audio path does the same
    // (event-scheduler.ts marker-only branch), and without it the highlight
    // would jump over rests instead of keeping time.
    expect(steps().map((s) => s.argPath)).toEqual(['0', '1', '2'])
    expect((out.noteOn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('steps through a tie slot (_) even though it emits no note of its own', async () => {
    await playDsl('p.play(1, _, 5)')

    expect(steps().map((s) => s.argPath)).toEqual(['0', '1', '2'])
    // The tie is absorbed into the preceding note, so only two note-ons fire.
    expect((out.noteOn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('emits exactly ONE marker for a stack slot, not one per voice', async () => {
    await playDsl('p.play([1,3,5], 6)')

    // A `[ ]` stack produces one TimedEvent per voice, all carrying the stack's
    // own argPath. Without dedup this slot would light up three times.
    expect(steps().map((s) => s.argPath)).toEqual(['0', '1'])
    expect((out.noteOn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4) // 3 voices + 1
  })

  it('emits no markers while the sequence is muted', async () => {
    seq.mute()
    await playDsl('p.play(1, 0, 5)')

    expect(steps()).toEqual([])
    expect((out.noteOn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('stops emitting markers once the sequence is stopped mid-bar', async () => {
    // Four slots at +100/600/1100/1600ms. Stop after the first two have fired.
    await playDsl('p.play(1, 3, 5, 6)', 600)
    expect(steps().map((s) => s.argPath)).toEqual(['0', '1'])

    seq.stop()
    await vi.advanceTimersByTimeAsync(2000)

    // The remaining two slots must NOT light up — a playhead that keeps
    // marching after stop is worse than one that never moved.
    expect(steps().map((s) => s.argPath)).toEqual(['0', '1'])
  })
})
