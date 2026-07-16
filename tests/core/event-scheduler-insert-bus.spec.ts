/**
 * #434 S3 — seq.effect() per-sequence insert routing.
 *
 * `scheduleEvents` / `scheduleEventsFromTime` forward `insertBus` to
 * `scheduler.scheduleEvent`/`scheduleSliceEvent` as a trailing param, mirroring
 * the existing `outputChannel` (LinkAudio) wiring. This spec verifies the
 * wiring at the event-scheduler level, without any audio backend.
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
  scheduleSliceEvent: ReturnType<typeof vi.fn>
} {
  return {
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

const ONE_NOTE: TimedEvent[] = [{ sliceNumber: 1, startTime: 0, duration: 250, depth: 0 }]

const BASE_OPTIONS = {
  audioFilePath: '/audio/kick.wav',
  gainDb: 0,
  pan: 0,
  isMuted: false,
  sequenceName: 'drum',
  masterGainDb: 0,
  patternDuration: 500,
}

describe('scheduleEvents insertBus wiring (#434 S3)', () => {
  it('forwards insertBus as the trailing scheduleEvent arg', async () => {
    const scheduler = stubScheduler()
    await scheduleEvents({
      ...BASE_OPTIONS,
      scheduler,
      timedEvents: ONE_NOTE,
      insertBus: 'seq-bus-0',
    })
    expect(scheduler.scheduleEvent).toHaveBeenCalledWith(
      '/audio/kick.wav',
      0,
      0,
      0,
      'drum',
      undefined, // outputChannel
      undefined, // argPath
      'seq-bus-0',
    )
  })

  it('omits insertBus when the sequence has no insert declared', async () => {
    const scheduler = stubScheduler()
    await scheduleEvents({ ...BASE_OPTIONS, scheduler, timedEvents: ONE_NOTE })
    expect(scheduler.scheduleEvent).toHaveBeenCalledWith(
      '/audio/kick.wav',
      0,
      0,
      0,
      'drum',
      undefined,
      undefined,
      undefined,
    )
  })

  it('forwards insertBus for chopped (scheduleSliceEvent) dispatch too', async () => {
    const scheduler = stubScheduler()
    await scheduleEvents({
      ...BASE_OPTIONS,
      scheduler,
      timedEvents: ONE_NOTE,
      chopDivisions: 4,
      insertBus: 'seq-bus-1',
    })
    expect(scheduler.scheduleSliceEvent).toHaveBeenCalledWith(
      '/audio/kick.wav',
      0,
      1,
      4,
      250,
      0,
      0,
      'drum',
      undefined,
      undefined,
      'seq-bus-1',
    )
  })

  it('scheduleEventsFromTime also forwards insertBus', () => {
    const scheduler = stubScheduler()
    scheduleEventsFromTime({
      ...BASE_OPTIONS,
      scheduler,
      fromTime: -1,
      timedEvents: ONE_NOTE,
      insertBus: 'seq-bus-2',
    })
    expect(scheduler.scheduleEvent).toHaveBeenCalledWith(
      '/audio/kick.wav',
      0,
      0,
      0,
      'drum',
      undefined,
      undefined,
      'seq-bus-2',
    )
  })
})
