import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { runSequence } from '../../packages/engine/src/core/sequence/playback/run-sequence'
import type { Scheduler } from '../../packages/engine/src/core/global/types'

const T0 = 1_000_000
const PATTERN_DURATION_MS = 2_000
const SCHEDULE_ORIGIN_OFFSET_MS = 100

/** Scheduler の最小記録実装。clear の回数と owner 名を観測可能にする。 */
function recordingScheduler(): Scheduler {
  return {
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
  }
}

async function runningSequence(scheduler: Scheduler): Promise<{ global: Global; seq: Sequence }> {
  const global = new Global(scheduler)
  const seq = new Sequence(global, scheduler)
  seq.setName('runSeq')
  await seq.run()
  return { global, seq }
}

describe('#606 RUN tail timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('H2: clears only after the scheduled origin plus the full pattern duration', () => {
    const clearSequenceEventsFn = vi.fn()
    const scheduleEventsFn = vi.fn()

    runSequence({
      sequenceName: 'runSeq',
      scheduler: recordingScheduler(),
      currentTime: 250,
      isPlaying: false,
      scheduleEventsFn,
      getPatternDurationFn: () => PATTERN_DURATION_MS,
      clearSequenceEventsFn,
      setRunTimerFn: vi.fn(),
    })

    expect(scheduleEventsFn).toHaveBeenCalledWith(
      expect.anything(),
      0,
      250 + SCHEDULE_ORIGIN_OFFSET_MS,
    )

    vi.advanceTimersByTime(PATTERN_DURATION_MS)
    expect(clearSequenceEventsFn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(SCHEDULE_ORIGIN_OFFSET_MS - 1)
    expect(clearSequenceEventsFn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(clearSequenceEventsFn).toHaveBeenCalledTimes(1)
    expect(clearSequenceEventsFn).toHaveBeenCalledWith('runSeq')
  })

  it('H1: a second RUN cancels the first RUN tail timer without suppressing its own', async () => {
    const scheduler = recordingScheduler()
    const { seq } = await runningSequence(scheduler)

    await vi.advanceTimersByTimeAsync(1_000)
    await seq.run()

    expect(scheduler.clearSequenceEvents).toHaveBeenCalledTimes(1)
    expect(scheduler.clearSequenceEvents).toHaveBeenNthCalledWith(1, 'runSeq')

    // The first RUN would finish here. Its stale timer must not clear the second RUN.
    await vi.advanceTimersByTimeAsync(PATTERN_DURATION_MS + SCHEDULE_ORIGIN_OFFSET_MS - 1_000)
    expect(scheduler.clearSequenceEvents).toHaveBeenCalledTimes(1)

    // The replacement RUN still owns a live tail timer and clears exactly once at its end.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(scheduler.clearSequenceEvents).toHaveBeenCalledTimes(2)
    expect(scheduler.clearSequenceEvents).toHaveBeenNthCalledWith(2, 'runSeq')
  })

  it('cancels a RUN tail timer when LOOP takes ownership of the sequence', async () => {
    const scheduler = recordingScheduler()
    const { seq } = await runningSequence(scheduler)

    await vi.advanceTimersByTimeAsync(1_000)
    await seq.loop()

    expect(scheduler.clearSequenceEvents).toHaveBeenCalledTimes(1)
    expect(scheduler.clearSequenceEvents).toHaveBeenCalledWith('runSeq')

    // Stop before the loop's own first re-arm; only the old RUN timer could fire here.
    await vi.advanceTimersByTimeAsync(PATTERN_DURATION_MS + SCHEDULE_ORIGIN_OFFSET_MS - 1_000)
    expect(scheduler.clearSequenceEvents).toHaveBeenCalledTimes(1)
  })

  it('cancels a RUN tail timer when global.stop() stops the sequence', async () => {
    const scheduler = recordingScheduler()
    const { global } = await runningSequence(scheduler)

    global.stop()
    expect(scheduler.clearSequenceEvents).toHaveBeenCalledTimes(1)
    expect(scheduler.clearSequenceEvents).toHaveBeenCalledWith('runSeq')

    await vi.advanceTimersByTimeAsync(PATTERN_DURATION_MS + SCHEDULE_ORIGIN_OFFSET_MS)
    expect(scheduler.clearSequenceEvents).toHaveBeenCalledTimes(1)
  })
})
