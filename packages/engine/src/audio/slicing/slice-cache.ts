/**
 * Cache management for audio slices
 * Stores slice information to avoid re-slicing the same file
 */

import { AudioSliceInfo } from './types'

/**
 * Manages cache of sliced audio files
 */
export class SliceCache {
  private cache: Map<string, AudioSliceInfo[]> = new Map()

  /**
   * Generate cache key from filepath and divisions
   */
  private getCacheKey(filepath: string, divisions: number): string {
    return `${filepath}-${divisions}`
  }

  /**
   * Check if slices are cached
   */
  has(filepath: string, divisions: number): boolean {
    return this.cache.has(this.getCacheKey(filepath, divisions))
  }

  /**
   * Get cached slices
   */
  get(filepath: string, divisions: number): AudioSliceInfo[] | undefined {
    return this.cache.get(this.getCacheKey(filepath, divisions))
  }

  /**
   * Store slices in cache
   */
  set(filepath: string, divisions: number, slices: AudioSliceInfo[]): void {
    this.cache.set(this.getCacheKey(filepath, divisions), slices)
  }

  /**
   * Clear all cached slices
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get slice filepath by number
   */
  getSliceFilepath(originalPath: string, divisions: number, sliceNumber: number): string | null {
    const slices = this.get(originalPath, divisions)

    if (!slices || sliceNumber < 1 || sliceNumber > slices.length) {
      return null
    }

    const slice = slices[sliceNumber - 1]
    return slice ? slice.filepath : null
  }
}
