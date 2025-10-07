/**
 * Audio Context Manager
 * Handles AudioContext initialization and lifecycle management
 */

import type { AudioContextOptions } from '../types'

/**
 * Create and configure an AudioContext
 * @param options AudioContext configuration options
 * @returns Configured AudioContext instance
 */
export function createAudioContext(options: AudioContextOptions = {}): AudioContext {
  const { sampleRate = 48000, latencyHint = 'interactive' } = options

  return new AudioContext({
    sampleRate,
    latencyHint,
  })
}

/**
 * Get the current time from an AudioContext
 * @param context AudioContext instance
 * @returns Current time in seconds
 */
export function getCurrentTime(context: AudioContext): number {
  return context.currentTime
}

/**
 * Get the sample rate from an AudioContext
 * @param context AudioContext instance
 * @returns Sample rate in Hz
 */
export function getSampleRate(context: AudioContext): number {
  return context.sampleRate
}

/**
 * Suspend an AudioContext (pause all audio processing)
 * @param context AudioContext instance
 * @returns Promise that resolves when suspended
 */
export async function suspendContext(context: AudioContext): Promise<void> {
  await context.suspend()
}

/**
 * Resume an AudioContext (resume audio processing)
 * @param context AudioContext instance
 * @returns Promise that resolves when resumed
 */
export async function resumeContext(context: AudioContext): Promise<void> {
  await context.resume()
}

/**
 * Close an AudioContext and release all resources
 * @param context AudioContext instance
 * @returns Promise that resolves when closed
 */
export async function closeContext(context: AudioContext): Promise<void> {
  await context.close()
}
