/**
 * Slice Player
 * Handles playback of individual audio slices
 */

import type { AudioSlice, PlaySliceOptions } from '../types'

/**
 * Play an audio slice
 * @param context AudioContext for playback
 * @param masterGain Master gain node to connect to
 * @param slice Audio slice to play
 * @param options Playback options
 * @returns AudioBufferSourceNode for the playback
 */
export function playSlice(
  context: AudioContext,
  masterGain: GainNode,
  slice: AudioSlice,
  options: PlaySliceOptions = {},
): AudioBufferSourceNode {
  const source = createAudioSource(context, slice, options)

  // Connect to master gain
  source.connect(masterGain)

  // Start playback
  const when = options.startTime || context.currentTime
  source.start(when, slice.startTime, slice.duration)

  return source
}

/**
 * Create an audio buffer source node configured for the slice
 * @param context AudioContext
 * @param slice Audio slice
 * @param options Playback options
 * @returns Configured AudioBufferSourceNode
 */
function createAudioSource(
  context: AudioContext,
  slice: AudioSlice,
  options: PlaySliceOptions,
): AudioBufferSourceNode {
  const source = context.createBufferSource()
  source.buffer = slice.buffer

  // Apply tempo adjustment (affects playback rate)
  if (options.tempo) {
    source.playbackRate.value = options.tempo
  }

  // Note: Pitch shifting without affecting tempo requires more complex processing
  // For now, playbackRate affects both tempo and pitch
  // True pitch shifting would require a pitch shift node or granular synthesis

  return source
}
