/**
 * Random value generation utilities
 * Shared utilities for generating random values based on RandomValue specs
 */

import { RandomValue } from '../../../parser/audio-parser'

/**
 * Generate a random value based on the random spec
 *
 * @param spec - Random value specification (full-random or random-walk)
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value
 * @returns Generated random value within the specified range
 */
export function generateRandomValue(spec: RandomValue, min: number, max: number): number {
  if (spec.type === 'full-random') {
    // Full random within min-max range
    return Math.random() * (max - min) + min
  } else {
    // Random walk: center ± range
    const value = spec.center + (Math.random() * 2 - 1) * spec.range
    // Clamp to valid range
    return Math.max(min, Math.min(max, value))
  }
}
