/**
 * Options for loop sequence playback
 */
export interface LoopSequenceOptions {
  sequenceName: string
  scheduler: any
  currentTime: number
  scheduleEventsFn: (scheduler: any, offset: number, baseTime: number) => void
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
    getPatternDurationFn,
    clearSequenceEventsFn,
    getIsLoopingFn,
    getIsMutedFn,
  } = options

  // Clear old events for this sequence first
  clearSequenceEventsFn(sequenceName)

  // Calculate pattern duration
  const patternDuration = getPatternDurationFn()

  // Track next scheduled time (cumulative, to avoid drift)
  let nextScheduleTime = currentTime

  // Schedule first iteration
  scheduleEventsFn(scheduler, 0, nextScheduleTime)

  // Set up loop timer
  // Note: isLooping and isMuted are checked via getter functions to reflect current state
  const loopTimer = setInterval(() => {
    if (getIsLoopingFn() && !getIsMutedFn()) {
      nextScheduleTime += patternDuration // Cumulative time, no drift
      // Clear old scheduled events for this sequence before scheduling new ones
      clearSequenceEventsFn(sequenceName)
      scheduleEventsFn(scheduler, 0, nextScheduleTime)
    }
  }, patternDuration)

  return {
    isPlaying: true,
    isLooping: true,
    loopStartTime: currentTime,
    loopTimer,
  }
}
