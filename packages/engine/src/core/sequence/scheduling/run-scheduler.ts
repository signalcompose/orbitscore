/**
 * Run scheduler for Sequence
 * Handles one-shot playback scheduling
 */

import { Scheduler } from '../../global/types'

/**
 * Run sequence options
 */
export interface RunSequenceOptions {
  sequenceName: string
  scheduler: Scheduler
  currentTime: number
  isPlaying: boolean
  scheduleEventsFn: (sched: Scheduler, offset: number, baseTime: number) => Promise<void>
  getPatternDurationFn: () => number
  clearSequenceEventsFn: (name: string) => void
}

/**
 * Run sequence result
 */
export interface RunSequenceResult {
  isPlaying: boolean
  isLooping: boolean
}

/**
 * Run sequence (one-shot playback)
 */
export async function runSequence(options: RunSequenceOptions): Promise<RunSequenceResult> {
  const {
    sequenceName,
    scheduler,
    currentTime,
    scheduleEventsFn,
    getPatternDurationFn,
    clearSequenceEventsFn,
  } = options

  // Clear any existing events for this sequence
  clearSequenceEventsFn(sequenceName)

  // Schedule events for one iteration
  await scheduleEventsFn(scheduler, 0, currentTime)

  // Calculate when playback should end
  const patternDuration = getPatternDurationFn()

  // Set up auto-stop mechanism
  const autoStopTimeout = setTimeout(() => {
    clearSequenceEventsFn(sequenceName)
  }, patternDuration)

  // Store timeout reference for potential cleanup
  ;(scheduler as any).sequenceTimeouts = (scheduler as any).sequenceTimeouts || {}
  ;(scheduler as any).sequenceTimeouts[sequenceName] = autoStopTimeout

  return {
    isPlaying: true,
    isLooping: false,
  }
}
