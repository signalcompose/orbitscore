import * as path from 'path'

import type { Scheduler } from '../../global/types'

/**
 * Result of playback preparation
 */
export interface PlaybackPreparation {
  scheduler: Scheduler
  currentTime: number
}

/**
 * Options for playback preparation
 */
export interface PreparePlaybackOptions {
  sequenceName: string
  audioFilePath?: string
  chopDivisions?: number
  loopTimer?: NodeJS.Timeout
  prepareSlicesFn: () => Promise<void>
  getScheduler: () => Scheduler
}

/**
 * Prepare common setup for both run() and loop() playback
 *
 * This function handles:
 * - Scheduler validation
 * - Slice preparation (if chop() was called)
 * - Audio buffer preloading
 * - Clearing existing loop timers
 * - Getting current scheduler time
 *
 * @param options - Preparation options
 * @returns Prepared scheduler and current time, or null if scheduler not running
 */
export async function preparePlayback(
  options: PreparePlaybackOptions,
): Promise<PlaybackPreparation | null> {
  const { sequenceName, audioFilePath, loopTimer, prepareSlicesFn, getScheduler } = options

  // Get and validate scheduler
  const scheduler = getScheduler()
  const isRunning = scheduler.isRunning

  if (!isRunning) {
    console.log(`⚠️ ${sequenceName} - scheduler not running. Use global.start() first.`)
    return null
  }

  // Prepare slices if chop() was called
  prepareSlicesFn()

  // Preload buffer to get correct duration
  if (audioFilePath && scheduler.loadBuffer) {
    const resolvedPath = path.isAbsolute(audioFilePath)
      ? audioFilePath
      : path.resolve(process.cwd(), audioFilePath)
    await scheduler.loadBuffer(resolvedPath)
  }

  // Clear existing loop timer if any
  if (loopTimer) {
    clearInterval(loopTimer)
  }

  // Get current scheduler time
  const schedulerStartTime = scheduler.startTime
  const now = Date.now()
  const currentTime = now - schedulerStartTime

  return { scheduler, currentTime }
}
