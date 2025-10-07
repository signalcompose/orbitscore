/**
 * Loop scheduler for Sequence
 * Handles continuous loop playback scheduling
 */

import { Scheduler } from '../../global/types'

/**
 * Loop sequence options
 */
export interface LoopSequenceOptions {
  sequenceName: string
  scheduler: Scheduler
  currentTime: number
  scheduleEventsFn: (sched: Scheduler, offset: number, baseTime: number) => Promise<void>
  getPatternDurationFn: () => number
  clearSequenceEventsFn: (name: string) => void
  getIsLoopingFn: () => boolean
  getIsMutedFn: () => boolean
}

/**
 * Loop sequence result
 */
export interface LoopSequenceResult {
  isPlaying: boolean
  isLooping: boolean
  loopStartTime: number
  loopTimer: NodeJS.Timeout
}

/**
 * Loop sequence (continuous playback)
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

  // Clear any existing events for this sequence
  clearSequenceEventsFn(sequenceName)

  // Schedule initial events
  scheduleEventsFn(scheduler, 0, currentTime).catch((error) => {
    console.error(`Error scheduling initial events for ${sequenceName}:`, error)
  })

  // Calculate pattern duration
  const patternDuration = getPatternDurationFn()

  // Set up loop timer
  const loopTimer = setInterval(async () => {
    // Check if still looping
    if (!getIsLoopingFn()) {
      clearInterval(loopTimer)
      return
    }

    // Check if muted
    if (getIsMutedFn()) {
      return
    }

    try {
      // Schedule next iteration
      await scheduleEventsFn(scheduler, 0, currentTime)
    } catch (error) {
      console.error(`Error scheduling loop events for ${sequenceName}:`, error)
    }
  }, patternDuration)

  return {
    isPlaying: true,
    isLooping: true,
    loopStartTime: currentTime,
    loopTimer,
  }
}
