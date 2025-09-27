/**
 * Timing Calculator for Hierarchical Play Structures
 * Calculates exact timing for nested play() patterns
 */

import { PlayElement } from '../parser/audio-parser'

/**
 * Represents a scheduled playback event
 */
export interface TimedEvent {
  sliceNumber: number // 0 for silence, 1-n for slice
  startTime: number // Start time in milliseconds relative to bar start
  duration: number // Duration in milliseconds
  depth: number // Nesting depth (for debugging)
}

/**
 * Calculates timing for hierarchical play structures
 */
export class TimingCalculator {
  /**
   * Calculate timing for play() arguments
   * @param elements Array of play elements (numbers or nested structures)
   * @param barDuration Total bar duration in milliseconds
   * @param startTime Start time offset (default 0)
   * @param depth Current nesting depth (for debugging)
   * @returns Array of timed events
   */
  static calculateTiming(
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
      } else if (element && typeof element === 'object') {
        if (element.type === 'nested') {
          // Recursively calculate timing for nested elements
          const nestedEvents = this.calculateTiming(
            element.elements,
            elementDuration, // Nested elements split their parent's duration
            elementStartTime, // Start at parent's position
            depth + 1,
          )
          events.push(...nestedEvents)
        } else if (element.type === 'modified') {
          // Modified element (e.g., with .time(), .fixpitch())
          // For now, treat the value as a simple number
          // TODO: Apply time modifications
          if (typeof element.value === 'number') {
            events.push({
              sliceNumber: element.value,
              startTime: elementStartTime,
              duration: elementDuration,
              depth,
            })
          } else if (element.value && element.value.type === 'nested') {
            // Modified nested structure
            const nestedEvents = this.calculateTiming(
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

  /**
   * Convert bar-relative timing to absolute timing
   * @param events Events with bar-relative timing
   * @param barNumber Which bar (0-indexed)
   * @param barDuration Duration of one bar in ms
   * @returns Events with absolute timing
   */
  static toAbsoluteTiming(
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

  /**
   * Debug helper: format timing as readable string
   */
  static formatTiming(events: TimedEvent[], bpm: number = 120): string {
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
}
