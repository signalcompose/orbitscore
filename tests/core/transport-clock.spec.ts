import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { TransportClock } from '../../packages/engine/src/core/global/transport-clock'
import { MidiTransportScheduler } from '../../packages/engine/src/core/global/midi-transport-scheduler'
import { Global } from '../../packages/engine/src/core/global'

/**
 * Phase 1 (#228) — TransportClock decoupling (§1)
 *
 * MIDI sequences schedule against a TransportClock-backed transport, not the SC
 * audio engine, so a MIDI-only session never touches SuperCollider — while
 * sharing the same Date.now() origin as audio so the two stay in sync.
 */

const T0 = 5_000_000

describe('TransportClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it('start() stamps the Date.now() origin and marks running', () => {
    const c = new TransportClock()
    expect(c.running).toBe(false)
    expect(c.startTime).toBe(0)
    c.start()
    expect(c.running).toBe(true)
    expect(c.startTime).toBe(T0)
  })

  it('stop() clears running but retains the origin', () => {
    const c = new TransportClock()
    c.start()
    c.stop()
    expect(c.running).toBe(false)
    expect(c.startTime).toBe(T0)
  })

  it('start() is idempotent (origin not re-stamped while running)', () => {
    const c = new TransportClock()
    c.start()
    vi.setSystemTime(T0 + 1234)
    c.start()
    expect(c.startTime).toBe(T0) // unchanged
  })
})

describe('MidiTransportScheduler', () => {
  it('mirrors the clock and no-ops the audio surface', () => {
    const c = new TransportClock()
    const s = new MidiTransportScheduler(c)
    expect(s.isRunning).toBe(false)
    c.start()
    expect(s.isRunning).toBe(true)
    expect(s.startTime).toBe(c.startTime)
    // audio methods are harmless no-ops
    expect(() => {
      s.start()
      s.stop()
      s.stopAll()
      s.clearSequenceEvents()
      s.reinitializeSequenceTracking()
      s.scheduleEvent()
      s.scheduleSliceEvent()
    }).not.toThrow()
    expect(s.getAudioDuration()).toBe(0)
  })
})

describe('Global transport (decoupled MIDI clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it('MIDI transport is independent of the audio engine and shares the start origin', () => {
    // A no-op audio engine with NO startTime of its own — the MIDI transport
    // must still work, proving MIDI does not depend on the audio scheduler.
    const noopEngine = {
      isRunning: false,
      start: vi.fn(),
      stop: vi.fn(),
      stopAll: vi.fn(),
      setRunningState: vi.fn(),
    } as never

    const g = new Global(noopEngine)
    expect(g.isTransportRunning()).toBe(false)
    expect(g.getMidiTransport().isRunning).toBe(false)

    g.start()
    expect(g.isTransportRunning()).toBe(true)
    expect(g.getMidiTransport().isRunning).toBe(true)
    // The MIDI clock origin comes from global.start(), not the audio engine.
    expect(g.getMidiTransport().startTime).toBe(T0)

    g.stop()
    expect(g.getMidiTransport().isRunning).toBe(false)
  })
})
