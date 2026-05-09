/**
 * LOOP quantize startup integration tests
 *
 * Verifies that `LOOP()` waits for the next quantize boundary (default 1 bar)
 * before scheduling its first iteration, that `seq.quantize()` overrides the
 * global value, and that "off" preserves the legacy immediate behavior.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

interface ScheduledEventArgs {
  filepath: string
  time: number
  sliceIndex: number
  totalSlices: number
}

describe('LOOP quantize startup', () => {
  let global: Global
  let seq: Sequence
  let mockPlayer: SuperColliderPlayer
  // currentTime relative to scheduler start (set per-test).
  let elapsedMs: number
  // Captured calls to scheduleSliceEvent.
  const captured: ScheduledEventArgs[] = []

  beforeEach(() => {
    captured.length = 0
    elapsedMs = 0

    mockPlayer = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn(() => elapsedMs),
      scheduleEvent: vi.fn(
        (filepath: string, time: number) => {
          captured.push({ filepath, time, sliceIndex: 0, totalSlices: 0 })
        },
      ),
      scheduleSliceEvent: vi.fn(
        (
          filepath: string,
          time: number,
          sliceIndex: number,
          totalSlices: number,
        ) => {
          captured.push({ filepath, time, sliceIndex, totalSlices })
        },
      ),
      getMasterGainDb: vi.fn().mockReturnValue(0),
      clearSequenceEvents: vi.fn(),
      reinitializeSequenceTracking: vi.fn(),
      isRunning: true,
      // Force the wall clock to read scheduler-relative `elapsedMs` so
      // sequence.loop() sees `currentTime = elapsedMs`.
      get startTime() {
        return Date.now() - elapsedMs
      },
      loadBuffer: vi.fn().mockResolvedValue(undefined),
    } as any

    global = new Global(mockPlayer)
    seq = new Sequence(global, mockPlayer)
    seq.setName('kick')
    seq.audio('/tmp/kick.wav').play(1, 0, 0, 0)
  })

  afterEach(() => {
    seq.stop()
    vi.restoreAllMocks()
  })

  it('waits for next bar boundary at default quantize="bar"', async () => {
    // 120 BPM, 4/4 → bar = 2000 ms. Mid-bar invocation at 1500 ms should
    // place iteration 0 at the next boundary, 2000 ms.
    elapsedMs = 1500
    await seq.loop()

    expect(captured.length).toBeGreaterThan(0)
    // First scheduled event time === effective start === 2000 ms
    expect(captured[0]!.time).toBeCloseTo(2000, 0)
  })

  it('uses currentTime when quantize="off"', async () => {
    global.quantize('off')

    elapsedMs = 1500
    await seq.loop()

    expect(captured.length).toBeGreaterThan(0)
    // Immediate: first event time matches currentTime
    expect(captured[0]!.time).toBeCloseTo(1500, 0)
  })

  it('lets seq.quantize() override the global value', async () => {
    global.quantize('bar') // default
    seq.quantize('off') // this sequence should fire immediately
    elapsedMs = 1500
    await seq.loop()

    expect(captured[0]!.time).toBeCloseTo(1500, 0)
  })

  it('aligns to multi-bar boundary for quantize="2bar"', async () => {
    global.quantize('2bar') // 4000 ms
    elapsedMs = 100
    await seq.loop()

    expect(captured[0]!.time).toBeCloseTo(4000, 0)
  })

  it('snaps to the same boundary already crossed when currentTime equals a boundary', async () => {
    // currentTime = 2000 (already on a bar boundary). nextQuantizedTime
    // returns 2000 (no skip), so iteration 0 fires immediately at 2000.
    elapsedMs = 2000
    await seq.loop()

    expect(captured[0]!.time).toBeCloseTo(2000, 0)
  })

  it('respects polymeter on the global meter — sequence beat() does not change quantize grid', async () => {
    // Global stays at 4/4 → bar = 2000 ms.
    // The sequence is in 5/4, but quantize is computed from the global grid.
    seq.beat(5, 4)
    elapsedMs = 100
    await seq.loop()

    expect(captured[0]!.time).toBeCloseTo(2000, 0)
  })
})

describe('global.quantize() / seq.quantize() DSL', () => {
  it('exposes a default of "bar" and round-trips updates', () => {
    const player = {
      boot: vi.fn().mockResolvedValue(undefined),
      isRunning: false,
      startTime: Date.now(),
    } as any
    const g = new Global(player)
    expect(g.getQuantize()).toBe('bar')
    g.quantize('2bar')
    expect(g.getQuantize()).toBe('2bar')
    g.quantize('off')
    expect(g.getQuantize()).toBe('off')
  })

  it('throws for invalid quantize values', () => {
    const player = { boot: vi.fn(), isRunning: false, startTime: 0 } as any
    const g = new Global(player)
    expect(() => g.quantize('half-bar' as any)).toThrow(/quantize\(\) expects/)
    const s = new Sequence(g, player)
    expect(() => s.quantize('twobar' as any)).toThrow(/seq\.quantize\(\) expects/)
  })
})
