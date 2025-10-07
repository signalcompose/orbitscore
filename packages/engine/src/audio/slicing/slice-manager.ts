/**
 * Slice Manager
 * Handles slicing of audio buffers into equal parts
 */

import type { AudioSlice } from '../types'

/**
 * Slice an audio buffer into equal parts
 * @param buffer Audio buffer to slice
 * @param numSlices Number of slices to create
 * @returns Array of audio slices
 */
export function createSlices(buffer: AudioBuffer, numSlices: number): AudioSlice[] {
  const totalDuration = buffer.duration
  const sliceDuration = totalDuration / numSlices

  const slices: AudioSlice[] = []

  for (let i = 0; i < numSlices; i++) {
    const startTime = i * sliceDuration

    slices.push({
      buffer,
      startTime,
      duration: sliceDuration,
      sliceNumber: i + 1, // 1-indexed
    })
  }

  return slices
}

/**
 * Get a specific slice from an array of slices
 * @param slices Array of audio slices
 * @param sliceNumber 1-indexed slice number
 * @returns The requested slice, or undefined if not found
 */
export function getSlice(slices: AudioSlice[], sliceNumber: number): AudioSlice | undefined {
  return slices.find((s) => s.sliceNumber === sliceNumber)
}

/**
 * Get all slices
 * @param slices Array of audio slices
 * @returns All slices
 */
export function getAllSlices(slices: AudioSlice[]): AudioSlice[] {
  return slices
}
