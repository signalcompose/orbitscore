/**
 * Audio File Cache Manager
 * Manages caching of loaded audio files to avoid redundant loading
 */

import type { AudioSlice } from '../types'

/**
 * Cached audio file data
 */
export interface CachedAudioFile {
  /** Audio buffer containing the full audio file */
  buffer: AudioBuffer
  /** Slices created from this audio file */
  slices: AudioSlice[]
}

/**
 * Create a new audio file cache
 * @returns Map-based cache for audio files
 */
export function createAudioFileCache(): Map<string, CachedAudioFile> {
  return new Map<string, CachedAudioFile>()
}

/**
 * Check if an audio file is already cached
 * @param cache Audio file cache
 * @param filePath Path to the audio file
 * @returns True if the file is cached
 */
export function isCached(cache: Map<string, CachedAudioFile>, filePath: string): boolean {
  return cache.has(filePath)
}

/**
 * Get a cached audio file
 * @param cache Audio file cache
 * @param filePath Path to the audio file
 * @returns Cached audio file data, or undefined if not found
 */
export function getCached(
  cache: Map<string, CachedAudioFile>,
  filePath: string,
): CachedAudioFile | undefined {
  return cache.get(filePath)
}

/**
 * Store an audio file in the cache
 * @param cache Audio file cache
 * @param filePath Path to the audio file
 * @param buffer Audio buffer
 * @param slices Slices created from the audio file
 */
export function setCached(
  cache: Map<string, CachedAudioFile>,
  filePath: string,
  buffer: AudioBuffer,
  slices: AudioSlice[] = [],
): void {
  cache.set(filePath, { buffer, slices })
}

/**
 * Update slices for a cached audio file
 * @param cache Audio file cache
 * @param filePath Path to the audio file
 * @param slices New slices array
 */
export function updateSlices(
  cache: Map<string, CachedAudioFile>,
  filePath: string,
  slices: AudioSlice[],
): void {
  const cached = cache.get(filePath)
  if (cached) {
    cached.slices = slices
  }
}

/**
 * Clear all cached audio files
 * @param cache Audio file cache
 */
export function clearCache(cache: Map<string, CachedAudioFile>): void {
  cache.clear()
}
