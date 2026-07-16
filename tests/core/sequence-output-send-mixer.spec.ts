/**
 * seq.output(sumName) / seq.send(auxName, amount) — mixer routing (MX.2/MX.3/MX.4, #459/#453 M3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import type { MidiOutput } from '../../packages/engine/src/midi/midi-output'

const T0 = 1_000_000

// Mirrors tests/core/sequence-effect.spec.ts's harness: seq.midi() must not hit the real
// RtMidi binding (crashes the sandbox / CI worker with no OS MIDI client available).
function mockMidiOutput(): MidiOutput {
  return {
    ensurePort: vi.fn(() => 'IAC'),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    pitchBend: vi.fn(),
    releaseOwner: vi.fn(),
    panic: vi.fn(),
    getActiveNotes: vi.fn(() => []),
    listPorts: vi.fn(() => ['IAC']),
    closeAll: vi.fn(),
  } as unknown as MidiOutput
}

function harness(setBusRouting = vi.fn().mockResolvedValue(undefined)) {
  const audio = {
    isRunning: true,
    startTime: T0,
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    getAudioDuration: vi.fn(() => 1),
    getMasterGainDb: () => 0,
    loadPlugin: vi.fn().mockResolvedValue({}),
    setBusRouting,
  } as any
  const midiOutput = mockMidiOutput()
  const global = new Global(audio, new MidiManager(() => midiOutput))
  global.setDocumentDirectory('/songs')
  const seq = new Sequence(global, audio)
  seq.setName('kick')
  return { audio, global, seq, setBusRouting }
}

describe('Sequence.output() → sum bus routing (MX.2/MX.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('auto-allocates a per-seq insert bus and issues SetBusRouting(output=<sum bus>) when no seq.effect() was declared', async () => {
    const { global, seq, setBusRouting } = harness()
    global.sum('drum')
    seq.output('drum')
    await vi.waitFor(() => expect(setBusRouting).toHaveBeenCalled())
    expect(seq.getInsertBus()).toBe('seq-bus-0')
    expect(setBusRouting).toHaveBeenCalledWith('seq-bus-0', 'sum-bus-0', [])
  })

  it('reuses the existing insert bus when seq.effect() was already declared', async () => {
    const { global, seq, setBusRouting } = harness()
    global.sum('drum')
    await seq.effect('./reverb.clap')
    expect(seq.getInsertBus()).toBe('seq-bus-0')
    seq.output('drum')
    await vi.waitFor(() => expect(setBusRouting).toHaveBeenCalled())
    expect(setBusRouting).toHaveBeenCalledWith('seq-bus-0', 'sum-bus-0', [])
  })

  it('falls back to the LinkAudio/warn behavior for a name that is not a declared sum bus', () => {
    const { seq, setBusRouting } = harness()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seq.output('not-a-sum')
    expect(seq.getOutputChannel()).toBe('not-a-sum')
    expect(setBusRouting).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('is method-chainable (returns this)', () => {
    const { global, seq } = harness()
    global.sum('drum')
    expect(seq.output('drum')).toBe(seq)
  })

  it('rejects sum routing on a note (midi) sequence', () => {
    const { global, seq } = harness()
    global.sum('drum')
    seq.midi('iac', 1)
    expect(() => seq.output('drum')).toThrow('only supported on audio sequences')
  })

  it('logs a warning but does not throw when SetBusRouting rejects', async () => {
    const setBusRouting = vi.fn().mockRejectedValue(new Error('kind mismatch'))
    const { global, seq } = harness(setBusRouting)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    global.sum('drum')
    expect(() => seq.output('drum')).not.toThrow()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
  })
})

describe('Sequence.send() → aux bus routing (MX.3/MX.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('auto-allocates a per-seq insert bus and issues SetBusRouting(sends=[{bus, gain}])', async () => {
    const { global, seq, setBusRouting } = harness()
    global.aux('rev')
    seq.send('rev', 0.3)
    await vi.waitFor(() => expect(setBusRouting).toHaveBeenCalled())
    expect(seq.getInsertBus()).toBe('seq-bus-0')
    expect(setBusRouting).toHaveBeenCalledWith('seq-bus-0', undefined, [
      { bus: 'aux-bus-0', gain: 0.3 },
    ])
  })

  it('accumulates multiple sends (fan-out) and re-sends the full set each time', async () => {
    const { global, seq, setBusRouting } = harness()
    global.aux('rev')
    global.aux('delay')
    seq.send('rev', 0.3)
    seq.send('delay', 0.5)
    await vi.waitFor(() => expect(setBusRouting).toHaveBeenCalledTimes(2))
    expect(setBusRouting).toHaveBeenLastCalledWith('seq-bus-0', undefined, [
      { bus: 'aux-bus-0', gain: 0.3 },
      { bus: 'aux-bus-1', gain: 0.5 },
    ])
  })

  it('combines an existing sum output with sends in the re-issued SetBusRouting', async () => {
    const { global, seq, setBusRouting } = harness()
    global.sum('drum')
    global.aux('rev')
    seq.output('drum')
    seq.send('rev', 0.3)
    await vi.waitFor(() => expect(setBusRouting).toHaveBeenCalledTimes(2))
    expect(setBusRouting).toHaveBeenLastCalledWith('seq-bus-0', 'sum-bus-0', [
      { bus: 'aux-bus-0', gain: 0.3 },
    ])
  })

  it('rejects send() to an undeclared aux bus', () => {
    const { seq } = harness()
    expect(() => seq.send('nope', 0.5)).toThrow('undeclared aux bus')
  })

  it('rejects non-finite gain', () => {
    const { global, seq } = harness()
    global.aux('rev')
    expect(() => seq.send('rev', NaN)).toThrow('must be finite')
  })

  it('rejects send() on a note (midi) sequence', () => {
    const { global, seq } = harness()
    global.aux('rev')
    seq.midi('iac', 1)
    expect(() => seq.send('rev', 0.5)).toThrow('only supported on audio sequences')
  })

  it('is method-chainable (returns this)', () => {
    const { global, seq } = harness()
    global.aux('rev')
    expect(seq.send('rev', 0.5)).toBe(seq)
  })
})
