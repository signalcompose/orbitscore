/**
 * Event scheduler utilities for Sequence
 * Handles event scheduling logic
 */

import * as path from 'path'

import { RandomValue } from '../../../parser/audio-parser'
import { ScheduleEventsOptions, ScheduleEventsFromTimeOptions } from '../types'
import { generateRandomValue } from '../parameters/random-utils'

/**
 * Resolve audio file path to absolute path
 */
function resolveAudioFilePath(audioFilePath: string): string {
  return path.isAbsolute(audioFilePath) ? audioFilePath : path.resolve(process.cwd(), audioFilePath)
}

/**
 * Calculate final gain for event
 * Handles random gain generation, mute state, and master gain
 */
function calculateEventGain(
  gainDb: number,
  gainRandom: RandomValue | undefined,
  masterGainDb: number,
  isMuted: boolean,
): number {
  // Generate random gain if specified
  let sequenceGainDb = gainDb
  if (gainRandom) {
    sequenceGainDb = generateRandomValue(gainRandom, -60, 12)
  }

  // Apply mute and master gain
  if (isMuted) {
    return -Infinity
  } else if (sequenceGainDb === -Infinity || masterGainDb === -Infinity) {
    return -Infinity
  } else {
    return sequenceGainDb + masterGainDb
  }
}

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
  const resolvedFilePath = resolveAudioFilePath(audioFilePath)

  // Schedule events for current iteration
  const loopOffset = loopIteration * patternDuration

  for (const event of timedEvents) {
    if (event.sliceNumber > 0) {
      // 0 is silence
      const startTimeMs = baseTime + event.startTime + loopOffset

      // Calculate final gain using helper function
      const finalGainDb = calculateEventGain(gainDb, gainRandom, masterGainDb, isMuted)

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

  const resolvedFilePath = resolveAudioFilePath(audioFilePath)

  // Calculate which loop iteration we're in
  const elapsedTime = fromTime - (loopStartTime || 0)
  const currentIteration = Math.floor(elapsedTime / patternDuration)

  // Debug logging to understand scheduling behavior
  console.log(
    `🔧 [scheduleFromTime] ${sequenceName}: fromTime=${fromTime}ms, loopStartTime=${loopStartTime}ms, elapsed=${elapsedTime}ms, iteration=${currentIteration}, patternDur=${patternDuration}ms`,
  )

  // Schedule remaining events in current iteration + next iteration
  for (let iter = currentIteration; iter < currentIteration + 2; iter++) {
    const loopOffset = iter * patternDuration
    const baseTime = (loopStartTime || 0) + loopOffset

    for (const event of timedEvents) {
      if (event.sliceNumber > 0) {
        const startTimeMs = baseTime + event.startTime

        // Skip events that are in the past
        if (startTimeMs <= fromTime) {
          console.log(
            `🔧 [scheduleFromTime] ${sequenceName}: SKIP past event at ${startTimeMs}ms (fromTime=${fromTime}ms)`,
          )
          continue
        }

        console.log(
          `🔧 [scheduleFromTime] ${sequenceName}: SCHEDULE event at ${startTimeMs}ms (fromTime=${fromTime}ms)`,
        )

        // Calculate final gain using helper function
        const finalGainDb = calculateEventGain(gainDb, gainRandom, masterGainDb, isMuted)

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
