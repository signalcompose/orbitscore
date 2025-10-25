import type { Scheduler } from '../../global/types'

/**
 * Options for loop sequence playback
 */
export interface LoopSequenceOptions {
  sequenceName: string
  scheduler: Scheduler
  currentTime: number
  scheduleEventsFn: (scheduler: Scheduler, offset: number, baseTime: number) => void
  scheduleEventsFromTimeFn: (scheduler: Scheduler, fromTime: number) => void
  getPatternDurationFn: () => number
  clearSequenceEventsFn: (sequenceName: string) => void
  getIsLoopingFn: () => boolean
  getIsMutedFn: () => boolean
}

/**
 * Result of loop sequence operation
 */
export interface LoopSequenceResult {
  isPlaying: boolean
  isLooping: boolean
  loopStartTime: number
  loopTimer: NodeJS.Timeout
}

/**
 * Execute loop playback of a sequence
 *
 * This function:
 * - Schedules first iteration immediately
 * - Sets up interval timer for subsequent iterations
 * - Tracks cumulative time to avoid drift
 * - Respects mute state
 *
 * @param options - Loop sequence options
 * @returns Updated playback state and loop timer
 */
export function loopSequence(options: LoopSequenceOptions): LoopSequenceResult {
  const {
    sequenceName,
    scheduler,
    currentTime,
    scheduleEventsFn,
    scheduleEventsFromTimeFn,
    getPatternDurationFn,
    clearSequenceEventsFn,
    getIsLoopingFn,
    getIsMutedFn,
  } = options

  // Clear old events for this sequence first
  clearSequenceEventsFn(sequenceName)

  console.log(`🔄 ${sequenceName} (loop started)`)

  // Calculate pattern duration
  const patternDuration = getPatternDurationFn()

  // Track next scheduled time (cumulative, to avoid drift)
  let nextScheduleTime = currentTime

  // Schedule first iteration
  scheduleEventsFn(scheduler, 0, nextScheduleTime)

  // Track previous mute state for transition detection
  let wasMuted = getIsMutedFn()

  // Set up loop timer
  // Note: isLooping and isMuted are checked via getter functions to reflect current state
  const loopTimer = setInterval(() => {
    const isMuted = getIsMutedFn()
    const isLooping = getIsLoopingFn()

    // Detect mute -> unmute transition
    if (wasMuted && !isMuted && isLooping) {
      // Just unmuted! Reschedule events from current time
      const currentTime = Date.now() - scheduler.startTime
      console.log(
        `🔓 ${sequenceName}: detected unmute in LOOP timer, rescheduling from ${currentTime}ms`,
      )

      // Clear old events (if any)
      clearSequenceEventsFn(sequenceName)

      // Reinitialize tracking so new events won't be skipped
      scheduler.reinitializeSequenceTracking(sequenceName)

      // Schedule events from current time (seamless resume)
      scheduleEventsFromTimeFn(scheduler, currentTime)

      // Update nextScheduleTime to align with current time
      nextScheduleTime = currentTime
    } else if (isLooping && !isMuted) {
      // Normal loop: not muted, continue scheduling
      nextScheduleTime += patternDuration // Cumulative time, no drift
      // Clear old scheduled events for this sequence before scheduling new ones
      clearSequenceEventsFn(sequenceName)
      scheduleEventsFn(scheduler, 0, nextScheduleTime)
    }

    // Update previous mute state for next iteration
    wasMuted = isMuted
  }, patternDuration)

  return {
    isPlaying: true,
    isLooping: true,
    loopStartTime: currentTime,
    loopTimer,
  }
}
