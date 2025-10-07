/**
 * Sequence Player
 * Handles playback of sequences of audio slices
 */

import type { AudioSlice, PlaySequenceOptions } from '../types'

import { playSlice } from './slice-player'

/**
 * Play a sequence of slices
 * @param context AudioContext for playback
 * @param masterGain Master gain node to connect to
 * @param slices Array of audio slices to play in sequence
 * @param options Playback options
 */
export function playSequence(
  context: AudioContext,
  masterGain: GainNode,
  slices: AudioSlice[],
  options: PlaySequenceOptions = {},
): void {
  let currentTime = context.currentTime

  // Schedule all slices in sequence
  for (const slice of slices) {
    playSlice(context, masterGain, slice, {
      tempo: options.tempo,
      pitch: options.pitch,
      startTime: currentTime,
    })

    // Calculate next start time based on slice duration and tempo
    const adjustedDuration = calculateAdjustedDuration(slice.duration, options.tempo)
    currentTime += adjustedDuration
  }

  // Handle looping if requested
  if (options.loop) {
    scheduleLoopIteration(context, masterGain, slices, options)
  }
}

/**
 * Calculate the adjusted duration of a slice based on tempo
 * @param duration Original duration in seconds
 * @param tempo Tempo adjustment factor (default: 1.0)
 * @returns Adjusted duration in seconds
 */
function calculateAdjustedDuration(duration: number, tempo?: number): number {
  return duration / (tempo || 1.0)
}

/**
 * Calculate the total duration of a sequence
 * @param slices Array of audio slices
 * @param tempo Tempo adjustment factor
 * @returns Total duration in seconds
 */
function calculateTotalDuration(slices: AudioSlice[], tempo?: number): number {
  return slices.reduce((sum, slice) => sum + calculateAdjustedDuration(slice.duration, tempo), 0)
}

/**
 * Schedule the next iteration of a looping sequence
 * @param context AudioContext
 * @param masterGain Master gain node
 * @param slices Array of audio slices
 * @param options Playback options
 */
function scheduleLoopIteration(
  context: AudioContext,
  masterGain: GainNode,
  slices: AudioSlice[],
  options: PlaySequenceOptions,
): void {
  const totalDuration = calculateTotalDuration(slices, options.tempo)

  // Schedule next iteration
  setTimeout(() => {
    playSequence(context, masterGain, slices, options)
  }, totalDuration * 1000)
}
