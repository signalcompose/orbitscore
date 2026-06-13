import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { loopSequence } from '../../packages/engine/src/core/sequence/playback/loop-sequence'

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
