import type { Scheduler } from '../../global/types'

/**
 * Options for loop sequence playback
 */
export interface LoopSequenceOptions {
  sequenceName: string
  scheduler: Scheduler
  /** Wall-clock-relative time (ms since scheduler.startTime) when loop() was invoked. */
  currentTime: number
  /**
   * Quantized start time (ms since scheduler.startTime). When omitted or
   * equal to `currentTime`, the loop starts immediately. When greater, the
   * first iteration is scheduled at this time and the first inter-iteration
   * timer is delayed by `startTime - currentTime` so subsequent boundaries
   * land on `startTime + n × patternDuration`.
   */
  startTime?: number
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
    startTime,
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

  // Calculate initial pattern duration
  let patternDuration = getPatternDurationFn()

  // Quantized start: if startTime is in the future, the first iteration is
  // scheduled at startTime and the first wait is reduced from one full
  // patternDuration to (patternDuration - leadIn) so subsequent boundaries
  // stay on startTime + n × patternDuration.
  const effectiveStart =
    startTime !== undefined && startTime > currentTime ? startTime : currentTime
  const leadInMs = effectiveStart - currentTime

  if (leadInMs > 0) {
    console.log(
      `🔄 ${sequenceName} (loop queued, +${Math.round(leadInMs)}ms to next quantize boundary)`,
    )
  } else {
    console.log(`🔄 ${sequenceName} (loop started)`)
  }

  // Track next scheduled time (cumulative, to avoid drift)
  let nextScheduleTime = effectiveStart

  // Schedule first iteration at the quantized start
  scheduleEventsFn(scheduler, 0, nextScheduleTime)

  // Track previous mute state for transition detection
  let wasMuted = getIsMutedFn()

  // Use setTimeout-based loop to allow dynamic pattern duration
  // (setInterval can't change its interval after creation)
  let loopTimer: NodeJS.Timeout = undefined as unknown as NodeJS.Timeout

  const scheduleNextIteration = (delayMs: number) => {
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
        const now = Date.now() - scheduler.startTime
        console.log(`🔓 ${sequenceName}: detected unmute in LOOP timer, rescheduling from ${now}ms`)

        // Clear old events (if any)
        clearSequenceEventsFn(sequenceName)

        // Reinitialize tracking so new events won't be skipped
        scheduler.reinitializeSequenceTracking(sequenceName)

        // Schedule events from current time (seamless resume)
        scheduleEventsFromTimeFn(scheduler, now)

        // Update nextScheduleTime to align with current time
        nextScheduleTime = now
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
      scheduleNextIteration(patternDuration)
    }, delayMs)
    // Update stateManager with current timer ID so stop() can cancel it
    setLoopTimerFn?.(loopTimer)
  }

  // First wait absorbs the lead-in to the quantize boundary plus one pattern,
  // so iteration 1 events land at effectiveStart + patternDuration.
  scheduleNextIteration(leadInMs + patternDuration)

  return {
    isPlaying: true,
    isLooping: true,
    loopStartTime: effectiveStart,
    loopTimer,
  }
}
