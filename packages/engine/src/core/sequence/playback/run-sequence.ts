import type { Scheduler } from '../../global/types'

/**
 * Options for one-shot sequence playback
 */
export interface RunSequenceOptions {
  sequenceName: string
  scheduler: Scheduler
  currentTime: number
  isPlaying: boolean
  scheduleEventsFn: (scheduler: Scheduler, offset: number, baseTime: number) => void
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

  // RUN() is imperative: always execute immediately, even if already playing
  // Clear existing events first to prevent overlap
  if (isPlaying) {
    clearSequenceEventsFn(sequenceName)
  }

  console.log(`▶ ${sequenceName} (one-shot)`)

  // Schedule events from current time with a small buffer (100ms) to ensure they're in the future
  const scheduleTime = currentTime + 100
  scheduleEventsFn(scheduler, 0, scheduleTime)

  // Auto-stop after pattern duration
  const patternDuration = getPatternDurationFn()
  setTimeout(() => {
    clearSequenceEventsFn(sequenceName)
    console.log(`⏹ ${sequenceName} (finished)`)
  }, patternDuration)

  return { isPlaying: true, isLooping: false }
}
