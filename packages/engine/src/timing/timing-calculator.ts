/**
 * Timing Calculator for Hierarchical Play Structures
 * Wrapper class for backward compatibility
 *
 * @deprecated Use calculation module directly for new code
 */

import { PlayElement } from '../parser/audio-parser'

import {
  TimedEvent,
  calculateEventTiming,
  convertToAbsoluteTiming,
  formatTiming,
} from './calculation'

export { TimedEvent }

/**
 * Calculates timing for hierarchical play structures (backward compatibility wrapper)
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
    return calculateEventTiming(elements, barDuration, startTime, depth)
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
    return convertToAbsoluteTiming(events, barNumber, barDuration)
  }

  /**
   * Debug helper: format timing as readable string
   */
  static formatTiming(events: TimedEvent[], bpm: number = 120): string {
    return formatTiming(events, bpm)
  }
}
