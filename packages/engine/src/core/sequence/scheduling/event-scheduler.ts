/**
 * Event scheduler utilities for Sequence
 * Handles event scheduling logic
 */

import * as path from 'path'

import { ScheduleEventsOptions, ScheduleEventsFromTimeOptions } from '../types'
import { generateRandomValue } from '../parameters/random-utils'

/**
 * Schedule events for sequence
 */
export async function scheduleEvents(options: ScheduleEventsOptions): Promise<void> {
  const {
    scheduler,
    loopIteration = 0,
    baseTime = 0,
    audioFilePath,
    timedEvents,
    chopDivisions,
    gainDb,
    gainRandom,
    pan,
    panRandom,
    isMuted,
    sequenceName,
    masterGainDb,
    patternDuration,
  } = options

  if (!audioFilePath || !timedEvents || timedEvents.length === 0) {
    return
  }

  // Resolve the audio file path to an absolute path
  const resolvedFilePath = path.isAbsolute(audioFilePath)
    ? audioFilePath
    : path.resolve(process.cwd(), audioFilePath)

  // Schedule events for current iteration
  const loopOffset = loopIteration * patternDuration

  for (const event of timedEvents) {
    if (event.sliceNumber > 0) {
      // 0 is silence
      const startTimeMs = baseTime + event.startTime + loopOffset

      // Calculate final gain
      let sequenceGainDb = gainDb

      // Generate random gain if specified
      if (gainRandom) {
        sequenceGainDb = generateRandomValue(gainRandom, -60, 12)
      }

      let finalGainDb: number
      if (isMuted) {
        finalGainDb = -Infinity
      } else if (sequenceGainDb === -Infinity || masterGainDb === -Infinity) {
        finalGainDb = -Infinity
      } else {
        finalGainDb = sequenceGainDb + masterGainDb
      }

      // Generate random pan if specified
      const eventPan = panRandom ? generateRandomValue(panRandom, -100, 100) : pan

      // Schedule event
      if (chopDivisions && chopDivisions > 1) {
        const eventDuration = event.duration && event.duration > 0 ? event.duration : undefined
        scheduler.scheduleSliceEvent(
          resolvedFilePath,
          startTimeMs,
          event.sliceNumber,
          chopDivisions,
          eventDuration,
          finalGainDb,
          eventPan,
          sequenceName,
        )
      } else {
        scheduler.scheduleEvent(resolvedFilePath, startTimeMs, finalGainDb, eventPan, sequenceName)
      }
    }
  }
}

/**
 * Schedule events from a specific time onwards
 */
export function scheduleEventsFromTime(options: ScheduleEventsFromTimeOptions): void {
  const {
    scheduler,
    fromTime,
    audioFilePath,
    timedEvents,
    chopDivisions,
    gainDb,
    gainRandom,
    pan,
    panRandom,
    isMuted,
    sequenceName,
    loopStartTime,
    masterGainDb,
    patternDuration,
  } = options

  if (!timedEvents || !audioFilePath) {
    return
  }

  const resolvedFilePath = path.isAbsolute(audioFilePath)
    ? audioFilePath
    : path.resolve(audioFilePath)

  // Calculate which loop iteration we're in
  const elapsedTime = fromTime - (loopStartTime || 0)
  const currentIteration = Math.floor(elapsedTime / patternDuration)

  // Schedule remaining events in current iteration + next iteration
  for (let iter = currentIteration; iter < currentIteration + 2; iter++) {
    const loopOffset = iter * patternDuration
    const baseTime = (loopStartTime || 0) + loopOffset

    for (const event of timedEvents) {
      if (event.sliceNumber > 0) {
        const startTimeMs = baseTime + event.startTime

        // Skip events that are in the past
        if (startTimeMs <= fromTime) {
          continue
        }

        // Calculate final gain
        let sequenceGainDb = gainDb

        // Generate random gain if specified
        if (gainRandom) {
          sequenceGainDb = generateRandomValue(gainRandom, -60, 12)
        }

        let finalGainDb: number
        if (isMuted) {
          finalGainDb = -Infinity
        } else if (sequenceGainDb === -Infinity || masterGainDb === -Infinity) {
          finalGainDb = -Infinity
        } else {
          finalGainDb = sequenceGainDb + masterGainDb
        }

        // Generate random pan if specified
        const eventPan = panRandom ? generateRandomValue(panRandom, -100, 100) : pan

        // Schedule event
        if (chopDivisions && chopDivisions > 1) {
          const eventDuration = event.duration && event.duration > 0 ? event.duration : undefined
          scheduler.scheduleSliceEvent(
            resolvedFilePath,
            startTimeMs,
            event.sliceNumber,
            chopDivisions,
            eventDuration,
            finalGainDb,
            eventPan,
            sequenceName,
          )
        } else {
          scheduler.scheduleEvent(
            resolvedFilePath,
            startTimeMs,
            finalGainDb,
            eventPan,
            sequenceName,
          )
        }
      }
    }
  }
}
