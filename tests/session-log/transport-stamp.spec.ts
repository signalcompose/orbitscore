import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/**
 * L1 (#229) — the bar:beat math behind the session-log triple stamp
 * (`Global.getTransportPosition` / `getQuantizedEffectPosition`). Asserted by
 * VALUE with fake timers (not just shape), so a regression in the meter-beat
 * formula or the 1-based bar/beat indexing is caught. Spec §3.
 */

const T0 = 1_000_000
function midiOutput(): MidiOutput {
  return {
    ensurePort: vi.fn((q: string) => q),
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
function makeGlobal(): Global {
  return new Global(mockScheduler(), new MidiManager(() => midiOutput()))
}

describe('L1 — transport bar:beat math (§3)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns null before start() and after stop() (preamble / stopped)', () => {
    const g = makeGlobal()
    expect(g.getTransportPosition()).toBeNull()
    vi.setSystemTime(T0)
    g.start()
    expect(g.getTransportPosition()).not.toBeNull()
    g.stop()
    expect(g.getTransportPosition()).toBeNull()
  })

  it('4/4 @120bpm: 3000ms after start = bar 2, beat 3.0', () => {
    const g = makeGlobal()
    g.tempo(120) // quarter = 500ms; 4/4 bar = 2000ms
    vi.setSystemTime(T0)
    g.start()
    vi.advanceTimersByTime(3000) // 6 beats in → bar 2 (beats 5,6,7,8), beat 3
    expect(g.getTransportPosition()).toBe('2:3.000')
  })

  it('3/4 @120bpm: 1500ms after start = bar 2, beat 1.0 (meter-beat math)', () => {
    const g = makeGlobal()
    g.tempo(120)
    g.beat(3, 4) // beat unit = 500ms; bar = 1500ms
    vi.setSystemTime(T0)
    g.start()
    vi.advanceTimersByTime(1500) // exactly one 3/4 bar → bar 2, beat 1.0
    expect(g.getTransportPosition()).toBe('2:1.000')
  })

  it('getQuantizedEffectPosition resolves the next bar boundary (quantize "bar")', () => {
    const g = makeGlobal()
    g.tempo(120) // 4/4 bar = 2000ms
    g.quantize('bar')
    vi.setSystemTime(T0)
    g.start()
    vi.advanceTimersByTime(500) // 0.25 bar in → next "bar" boundary is bar 2 beat 1.0
    expect(g.getQuantizedEffectPosition()).toBe('2:1.000')
  })

  it('getQuantizedEffectPosition is null when quantize is off', () => {
    const g = makeGlobal()
    g.quantize('off')
    vi.setSystemTime(T0)
    g.start()
    vi.advanceTimersByTime(500)
    expect(g.getQuantizedEffectPosition()).toBeNull()
  })
})
