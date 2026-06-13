import { describe, it, expect, vi } from 'vitest'

import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/** Phase 1 (#228) — MidiManager: key / latency / lazy output (§1, §9) */

function mockOutput(): MidiOutput {
  return {
    ensurePort: vi.fn((p: string) => p),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    pitchBend: vi.fn(),
    releaseOwner: vi.fn(),
    panic: vi.fn(),
    getActiveNotes: vi.fn(() => []),
    listPorts: vi.fn(() => []),
    closeAll: vi.fn(),
  }
}

describe('MidiManager', () => {
  it('does not create the output until MIDI is used (lazy)', () => {
    const factory = vi.fn(() => mockOutput())
    const mm = new MidiManager(factory)
    expect(mm.isActive()).toBe(false)
    expect(factory).not.toHaveBeenCalled()

    mm.getScheduler() // first MIDI use
    expect(factory).toHaveBeenCalledTimes(1)
    expect(mm.isActive()).toBe(true)
  })

  it('global.key sets the key pitch class; undefined before', () => {
    const mm = new MidiManager(() => mockOutput())
    expect(mm.getKeyPitchClass()).toBeUndefined()
    mm.key('F#')
    expect(mm.getKeyPitchClass()).toBe(6)
  })

  it('midiLatency is stored and reported', () => {
    const mm = new MidiManager(() => mockOutput())
    expect(mm.getMidiLatency()).toBe(0)
    mm.midiLatency(20)
    expect(mm.getMidiLatency()).toBe(20)
  })

  it('per-port lead offsets the send delay (§9)', () => {
    const mm = new MidiManager(() => mockOutput())
    mm.midiLatency(20)
    expect(mm.sendDelayFor('IAC')).toBe(20) // no lead
    mm.setPortLead('IAC', 50) // Disklavier mechanical latency → send 50ms earlier
    expect(mm.sendDelayFor('IAC')).toBe(-30) // 20 - 50
  })

  it('start/stop delegate to the scheduler only when active', () => {
    const out = mockOutput()
    const mm = new MidiManager(() => out)
    // No scheduler yet → stop is a no-op (no panic)
    mm.stop()
    expect(out.panic).not.toHaveBeenCalled()

    mm.getScheduler() // activate
    mm.stop()
    expect(out.panic).toHaveBeenCalledTimes(1) // scheduler.stop() panics
  })
})
