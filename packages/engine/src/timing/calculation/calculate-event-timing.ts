/**
 * Event timing calculation for hierarchical play structures
 */

import { PlayElement } from '../../parser/audio-parser'

import { TimedEvent } from './types'

/**
 * Calculate timing for play() arguments
 *
 * This function recursively processes nested play() patterns and calculates
 * the exact start time and duration for each slice playback event.
 *
 * @param elements - Array of play elements (numbers or nested structures)
 * @param barDuration - Total bar duration in milliseconds
 * @param startTime - Start time offset (default 0)
 * @param depth - Current nesting depth (for debugging)
 * @returns Array of timed events
 */
export function calculateEventTiming(
  elements: PlayElement[],
  barDuration: number,
  startTime: number = 0,
  depth: number = 0,
): TimedEvent[] {
  const events: TimedEvent[] = []

  // If no elements, return empty
  if (elements.length === 0) {
    return events
  }

  // Calculate duration for each element at this level
  const elementDuration = barDuration / elements.length

  // Process each element
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]
    const elementStartTime = startTime + i * elementDuration

    if (typeof element === 'number') {
      // Simple slice number
      events.push({
        sliceNumber: element,
        startTime: elementStartTime,
        duration: elementDuration,
        depth,
      })
    } else if (Array.isArray(element)) {
      // Array of elements (nested structure)
      const nestedEvents = calculateEventTiming(
        element,
        elementDuration, // Nested elements split their parent's duration
        elementStartTime, // Start at parent's position
        depth + 1,
      )
      events.push(...nestedEvents)
    } else if (element && typeof element === 'object') {
      if (element.type === 'nested') {
        // Recursively calculate timing for nested elements
        const nestedEvents = calculateEventTiming(
          element.elements,
          elementDuration, // Nested elements split their parent's duration
          elementStartTime, // Start at parent's position
          depth + 1,
        )
        events.push(...nestedEvents)
      } else if (element.type === 'modified') {
        // Modified element (e.g., with .chop())
        // For now, treat the value as a simple number
        // TODO: Apply chop modifications
        if (typeof element.value === 'number') {
          events.push({
            sliceNumber: element.value,
            startTime: elementStartTime,
            duration: elementDuration,
            depth,
          })
        } else if (element.value && element.value.type === 'nested') {
          // Modified nested structure
          const nestedEvents = calculateEventTiming(
            element.value.elements,
            elementDuration,
            elementStartTime,
            depth + 1,
          )
          events.push(...nestedEvents)
        }
      }
    }
  }

  return events
}
