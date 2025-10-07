/**
 * Convert bar-relative timing to absolute timing
 */

import { TimedEvent } from './types'

/**
 * Convert bar-relative timing to absolute timing
 *
 * This function takes events with timing relative to a bar start
 * and converts them to absolute timing by adding the bar offset.
 *
 * @param events - Events with bar-relative timing
 * @param barNumber - Which bar (0-indexed)
 * @param barDuration - Duration of one bar in ms
 * @returns Events with absolute timing
 */
export function convertToAbsoluteTiming(
  events: TimedEvent[],
  barNumber: number,
  barDuration: number,
): TimedEvent[] {
  const barOffset = barNumber * barDuration

  return events.map((event) => ({
    ...event,
    startTime: event.startTime + barOffset,
  }))
}
