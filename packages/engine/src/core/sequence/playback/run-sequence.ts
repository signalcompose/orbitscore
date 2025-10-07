/**
 * Options for one-shot sequence playback
 */
export interface RunSequenceOptions {
  sequenceName: string
  scheduler: any
  currentTime: number
  isPlaying: boolean
  scheduleEventsFn: (scheduler: any, offset: number, baseTime: number) => void
  getPatternDurationFn: () => number
  clearSequenceEventsFn: (sequenceName: string) => void
}

/**
 * Result of run sequence operation
 */
export interface RunSequenceResult {
  isPlaying: boolean
  isLooping: boolean
}

/**
 * Execute one-shot playback of a sequence
 *
 * This function:
 * - Schedules events once from current time
 * - Auto-stops after pattern duration
 * - Clears scheduled events on completion
 *
 * @param options - Run sequence options
 * @returns Updated playback state
 */
export function runSequence(options: RunSequenceOptions): RunSequenceResult {
  const {
    sequenceName,
    scheduler,
    currentTime,
    isPlaying,
    scheduleEventsFn,
    getPatternDurationFn,
    clearSequenceEventsFn,
  } = options

  // Skip if already playing
  if (isPlaying) {
    return { isPlaying: true, isLooping: false }
  }

  console.log(`▶ ${sequenceName} (one-shot)`)

  // Schedule events from current time
  scheduleEventsFn(scheduler, 0, currentTime)

  // Auto-stop after pattern duration
  const patternDuration = getPatternDurationFn()
  setTimeout(() => {
    clearSequenceEventsFn(sequenceName)
    console.log(`⏹ ${sequenceName} (finished)`)
  }, patternDuration)

  return { isPlaying: true, isLooping: false }
}
