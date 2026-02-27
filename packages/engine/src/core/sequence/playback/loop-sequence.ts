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
  setLoopTimerFn?: (timer: NodeJS.Timeout) => void
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
    setLoopTimerFn,
  } = options

  // Clear old events for this sequence first
  clearSequenceEventsFn(sequenceName)

  console.log(`🔄 ${sequenceName} (loop started)`)

  // Calculate initial pattern duration
  let patternDuration = getPatternDurationFn()

  // Track next scheduled time (cumulative, to avoid drift)
  let nextScheduleTime = currentTime

  // Schedule first iteration
  scheduleEventsFn(scheduler, 0, nextScheduleTime)

  // Track previous mute state for transition detection
  let wasMuted = getIsMutedFn()

  // Use setTimeout-based loop to allow dynamic pattern duration
  // (setInterval can't change its interval after creation)
  let loopTimer: NodeJS.Timeout = undefined as unknown as NodeJS.Timeout

  const scheduleNextIteration = () => {
    loopTimer = setTimeout(() => {
      const isMuted = getIsMutedFn()
      const isLooping = getIsLoopingFn()

      if (!isLooping) {
        return // Stop the loop
      }

      // Save the duration that this setTimeout was based on
      // (the setTimeout interval matched this value)
      const previousDuration = patternDuration

      // Recalculate pattern duration for the NEXT cycle
      // (may have changed due to tempo/beat/length changes)
      patternDuration = getPatternDurationFn()

      // Detect mute -> unmute transition
      if (wasMuted && !isMuted) {
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
      } else if (!isMuted) {
        // Advance by the PREVIOUS duration (matches the setTimeout interval)
        // This keeps the bar boundary aligned with when the callback actually fired
        nextScheduleTime += previousDuration
        // Clear old scheduled events for this sequence before scheduling new ones
        clearSequenceEventsFn(sequenceName)
        scheduleEventsFn(scheduler, 0, nextScheduleTime)
      }

      // Update previous mute state for next iteration
      wasMuted = isMuted

      // Schedule next iteration with current pattern duration
      scheduleNextIteration()
    }, patternDuration)
    // Update stateManager with current timer ID so stop() can cancel it
    setLoopTimerFn?.(loopTimer)
  }

  scheduleNextIteration()

  return {
    isPlaying: true,
    isLooping: true,
    loopStartTime: currentTime,
    loopTimer,
  }
}
