/**
 * #390 live playhead — rest (0) slots schedule marker-only step events.
 *
 * `scheduleEvents` / `scheduleEventsFromTime` drop `sliceNumber === 0` from
 * audio dispatch ("0 is silence") but must still surface the slot to the
 * playhead via the optional `scheduler.scheduleStepMarker` — the sequence is
 * processing the silence, so the highlight steps through it. The stub
 * scheduler here verifies the wiring without any audio backend.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Scheduler } from '../../packages/engine/src/core/global/types'
import {
  scheduleEvents,
  scheduleEventsFromTime,
} from '../../packages/engine/src/core/sequence/scheduling/event-scheduler'
import type { TimedEvent } from '../../packages/engine/src/timing/calculation/types'

function stubScheduler(): Scheduler & {
  scheduleEvent: ReturnType<typeof vi.fn>
  scheduleStepMarker: ReturnType<typeof vi.fn>
} {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    scheduleStepMarker: vi.fn(),
    getAudioDuration: vi.fn(() => 1),
  }
}

// play(1, 0): one note, one rest — both argPath-tagged like TempoManager does.
const NOTE_THEN_REST: TimedEvent[] = [
  { sliceNumber: 1, startTime: 0, duration: 250, depth: 0, argPath: '0' },
  { sliceNumber: 0, startTime: 250, duration: 250, depth: 0, argPath: '1' },
]

const BASE_OPTIONS = {
  audioFilePath: '/audio/kick.wav',
  gainDb: 0,
  pan: 0,
  isMuted: false,
  sequenceName: 'drum',
  masterGainDb: 0,
  patternDuration: 500,
}

describe('scheduleEvents rest markers (#390)', () => {
  it('schedules a marker-only event for the rest slot (audio only for the note)', async () => {
    const scheduler = stubScheduler()
    await scheduleEvents({ ...BASE_OPTIONS, scheduler, timedEvents: NOTE_THEN_REST, baseTime: 100 })
    expect(scheduler.scheduleEvent).toHaveBeenCalledTimes(1)
    expect(scheduler.scheduleStepMarker).toHaveBeenCalledTimes(1)
    expect(scheduler.scheduleStepMarker).toHaveBeenCalledWith(350, 'drum', '1', 0) // 100 + 250
  })

  it('passes -Infinity for muted sequences so the backend can skip the marker', async () => {
    const scheduler = stubScheduler()
    await scheduleEvents({
      ...BASE_OPTIONS,
      scheduler,
      timedEvents: NOTE_THEN_REST,
      isMuted: true,
    })
    expect(scheduler.scheduleStepMarker).toHaveBeenCalledWith(250, 'drum', '1', -Infinity)
  })

  it('skips rest slots without argPath (pre-#390 events) and tolerates schedulers without the hook', async () => {
    const scheduler = stubScheduler()
    await scheduleEvents({
      ...BASE_OPTIONS,
      scheduler,
      timedEvents: [{ sliceNumber: 0, startTime: 0, duration: 250, depth: 0 }],
    })
    expect(scheduler.scheduleStepMarker).not.toHaveBeenCalled()

    // Optional-chained call: a Scheduler without scheduleStepMarker must not throw.
    const bare = stubScheduler() as Scheduler
    delete bare.scheduleStepMarker
    await expect(
      scheduleEvents({ ...BASE_OPTIONS, scheduler: bare, timedEvents: NOTE_THEN_REST }),
    ).resolves.toBeUndefined()
  })
})

describe('scheduleEventsFromTime rest markers (#390)', () => {
  it('schedules future rest markers and applies the same past-event guard as notes', () => {
    const scheduler = stubScheduler()
    scheduleEventsFromTime({
      ...BASE_OPTIONS,
      scheduler,
      timedEvents: NOTE_THEN_REST,
      fromTime: 260, // iteration 0 の rest (250ms) は過去 → skip される
      loopStartTime: 0,
    })
    const markerTimes = scheduler.scheduleStepMarker.mock.calls.map((c) => c[0] as number)
    expect(markerTimes.length).toBeGreaterThan(0)
    for (const time of markerTimes) {
      expect(time).toBeGreaterThan(260)
    }
    expect(markerTimes).toContain(750) // iteration 1 の rest (500 + 250)
  })
})
