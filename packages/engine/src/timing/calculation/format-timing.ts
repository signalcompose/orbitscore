/**
 * Debug helper for formatting timing information
 */

import { TimedEvent } from './types'

/**
 * Format timing as readable string for debugging
 *
 * This function converts timing events into a human-readable format
 * showing beat positions and durations.
 *
 * @param events - Array of timed events
 * @param bpm - Beats per minute (default 120)
 * @returns Formatted string representation
 */
export function formatTiming(events: TimedEvent[], bpm: number = 120): string {
  const lines: string[] = []
  const beatDuration = 60000 / bpm // ms per beat

  for (const event of events) {
    const startBeat = event.startTime / beatDuration
    const durationBeats = event.duration / beatDuration
    const indent = '  '.repeat(event.depth)

    if (event.sliceNumber === 0) {
      lines.push(
        `${indent}[silence] @ beat ${startBeat.toFixed(2)} for ${durationBeats.toFixed(2)} beats`,
      )
    } else {
      lines.push(
        `${indent}Slice ${event.sliceNumber} @ beat ${startBeat.toFixed(2)} for ${durationBeats.toFixed(2)} beats`,
      )
    }
  }

  return lines.join('\n')
}
