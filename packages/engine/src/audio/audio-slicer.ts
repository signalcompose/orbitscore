/**
 * Audio file slicer for chop() functionality
 * Simple wrapper around slicing module for easier usage
 */

import {
  AudioSliceInfo,
  SliceCache,
  TempFileManager,
  WavProcessor,
  sliceAudioFile,
} from './slicing'

/**
 * Audio slicer class with singleton pattern
 */
export class AudioSlicer {
  private cache: SliceCache
  private fileManager: TempFileManager
  private wavProcessor: WavProcessor

  constructor() {
    this.cache = new SliceCache()
    this.fileManager = new TempFileManager()
    this.wavProcessor = new WavProcessor()
  }

  /**
   * Slice audio file into equal parts
   */
  sliceAudioFile(filepath: string, divisions: number): AudioSliceInfo[] {
    return sliceAudioFile(filepath, divisions, this.cache, this.fileManager, this.wavProcessor)
  }

  /**
   * Get slice filepath (for backward compatibility)
   */
  getSliceFilepath(filepath: string, divisions: number, sliceNumber: number): string | null {
    const slices = this.cache.get(filepath, divisions)
    if (!slices) return null

    const slice = slices.find((s) => s.sliceNumber === sliceNumber)
    return slice?.filepath || null
  }

  /**
   * Clean up temporary files (for testing)
   */
  cleanup(): void {
    // Clear the cache to remove references to temporary files
    this.cache.clear()

    // Clean up temporary files created by this instance
    this.fileManager.cleanup()
  }
}

// Global instance for convenience
export const audioSlicer = new AudioSlicer()
