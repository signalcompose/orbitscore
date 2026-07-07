import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  LOOP_TIMER_LEAD_MS,
  loopSequence,
} from '../../packages/engine/src/core/sequence/playback/loop-sequence'

/**
 * Deferred-scheduling error resilience (§2.1 / live-coding).
 *
 * The loop's next-cycle scheduling runs inside a setTimeout callback, detached
 * from any awaited chain. A throw there — e.g. a rejected degree introduced via
 * a mid-loop play() — must NOT crash the process (unhandled exception / rejection
 * on Node>=22); it must be logged and the loop must survive. run()/loop() ENTRY
 * is validated eagerly elsewhere, so this guards only the deferred path.
 */
describe('loopSequence — deferred scheduling error resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  it('a throw from the next-cycle scheduleEventsFn is logged, not crashed; loop continues', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    let looping = true
    let calls = 0
    // First (synchronous) iteration succeeds; the next cycle throws, simulating
    // a mid-loop play() that introduced a rejected degree.
    const scheduleEventsFn = vi.fn(() => {
      calls += 1
      if (calls >= 2) throw new Error('degree 10 は受理されません')
    })

    loopSequence({
      sequenceName: 'piano',
      scheduler: { startTime: 0 } as never,
      currentTime: 0,
      startTime: 0,
      scheduleEventsFn,
      scheduleEventsFromTimeFn: vi.fn(),
      getPatternDurationFn: () => 1000,
      clearSequenceEventsFn: vi.fn(),
      getIsLoopingFn: () => looping,
      getIsMutedFn: () => false,
    })

    // First iteration ran synchronously (no throw).
    expect(scheduleEventsFn).toHaveBeenCalledTimes(1)

    // Advancing into the next cycle fires the setTimeout callback, whose
    // scheduleEventsFn throws — safeSchedule must swallow+log, not propagate.
    expect(() => vi.advanceTimersByTime(1100)).not.toThrow()
    expect(scheduleEventsFn).toHaveBeenCalledTimes(2)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('loop scheduling error'),
      expect.anything(),
    )

    // The loop survived (a further iteration was scheduled). Stop it cleanly.
    looping = false
    expect(() => vi.advanceTimersByTime(1100)).not.toThrow()

    errSpy.mockRestore()
  })
})

/**
 * Grid-anchored loop timer with lead (#389 mechanism A).
 *
 * The old re-arm (`setTimeout(patternDuration)` from the callback's actual
 * fire time) accumulated event-loop lag forever (~+0.2ms/bar), and enqueued
 * the bar-head event exactly AT the boundary — already in the past by the
 * callback's lateness, so beat 0 dispatched audibly late. The fix computes
 * each delay from the absolute grid and fires LOOP_TIMER_LEAD_MS early.
 */
describe('loopSequence — grid-anchored timer with lead (#389)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function startLoop(baseTimes: number[], onSchedule?: () => void) {
    let looping = true
    loopSequence({
      sequenceName: 'drum',
      scheduler: { startTime: 0 } as never,
      currentTime: 0,
      startTime: 0,
      scheduleEventsFn: vi.fn((_s, _o, baseTime: number) => {
        baseTimes.push(baseTime)
        onSchedule?.()
      }),
      scheduleEventsFromTimeFn: vi.fn(),
      getPatternDurationFn: () => 1000,
      clearSequenceEventsFn: vi.fn(),
      getIsLoopingFn: () => looping,
      getIsMutedFn: () => false,
    })
    return () => {
      looping = false
    }
  }

  it('fires LOOP_TIMER_LEAD_MS before each boundary; baseTime stays on the grid', () => {
    const baseTimes: number[] = []
    const stop = startLoop(baseTimes)
    expect(baseTimes).toEqual([0]) // bar 0 scheduled synchronously

    // Bar 1 is scheduled at boundary−lead (900ms), not at the boundary itself…
    vi.advanceTimersByTime(1000 - LOOP_TIMER_LEAD_MS - 1)
    expect(baseTimes).toEqual([0])
    vi.advanceTimersByTime(1)
    // …and its baseTime is the exact grid boundary.
    expect(baseTimes).toEqual([0, 1000])

    // Subsequent iterations keep the same phase (1900, 2900, … fire times).
    vi.advanceTimersByTime(1000)
    expect(baseTimes).toEqual([0, 1000, 2000])
    stop()
  })

  it('does not accumulate callback lag: the next delay is recomputed from the grid', () => {
    const baseTimes: number[] = []
    // Simulate 30ms of synchronous work in every scheduling callback by
    // advancing the mocked wall clock — under the old fixed re-arm this lag
    // would push every later boundary by +30ms each.
    const stop = startLoop(baseTimes, () => {
      vi.setSystemTime(Date.now() + 30)
    })
    expect(baseTimes).toEqual([0])

    // Fire bar 1 (timer armed for 900; clock is 30 from bar 0's work).
    vi.advanceTimersByTime(900 - 30)
    expect(baseTimes).toEqual([0, 1000])
    // The callback saw now=900+30(lag) → re-arm delay 1900−930=970, NOT 1000:
    // bar 2 still fires at wall 1900 and lands on grid 2000.
    vi.advanceTimersByTime(969)
    expect(baseTimes).toEqual([0, 1000])
    vi.advanceTimersByTime(1)
    expect(baseTimes).toEqual([0, 1000, 2000])
    stop()
  })

  it('a mid-loop patternDuration change re-anchors the grid from the next bar', () => {
    const baseTimes: number[] = []
    let duration = 1000
    let looping = true
    loopSequence({
      sequenceName: 'drum',
      scheduler: { startTime: 0 } as never,
      currentTime: 0,
      startTime: 0,
      scheduleEventsFn: vi.fn((_s, _o, baseTime: number) => baseTimes.push(baseTime)),
      scheduleEventsFromTimeFn: vi.fn(),
      getPatternDurationFn: () => duration,
      clearSequenceEventsFn: vi.fn(),
      getIsLoopingFn: () => looping,
      getIsMutedFn: () => false,
    })
    expect(baseTimes).toEqual([0])

    // Tempo change lands before the bar-1 callback: the NEXT cycle uses 500ms.
    duration = 500
    vi.advanceTimersByTime(900) // bar 1 fires at 1000−lead
    expect(baseTimes).toEqual([0, 1000]) // boundary still = old grid (prev duration 1000)

    // Re-arm used the NEW duration: next boundary 1000+500, fired at 1400 (lead 100).
    vi.advanceTimersByTime(499)
    expect(baseTimes).toEqual([0, 1000])
    vi.advanceTimersByTime(1)
    expect(baseTimes).toEqual([0, 1000, 1500])
    looping = false
  })

  it('shrinks the lead for sub-lead patterns instead of zero-delay spinning', () => {
    const baseTimes: number[] = []
    let looping = true
    loopSequence({
      sequenceName: 'drum',
      scheduler: { startTime: 0 } as never,
      currentTime: 0,
      startTime: 0,
      scheduleEventsFn: vi.fn((_s, _o, baseTime: number) => baseTimes.push(baseTime)),
      scheduleEventsFromTimeFn: vi.fn(),
      getPatternDurationFn: () => 60, // patternDuration < LOOP_TIMER_LEAD_MS
      clearSequenceEventsFn: vi.fn(),
      getIsLoopingFn: () => looping,
      getIsMutedFn: () => false,
    })
    expect(baseTimes).toEqual([0])

    // Effective lead = min(100, 60/2) = 30 → first re-fire at 30ms, not 0ms.
    vi.advanceTimersByTime(29)
    expect(baseTimes).toEqual([0])
    vi.advanceTimersByTime(1)
    expect(baseTimes).toEqual([0, 60])
    looping = false
  })
})
