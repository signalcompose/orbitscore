/**
 * Audio file slicer for chop() functionality
 * Wrapper class for backward compatibility
 *
 * @deprecated Use slicing module directly for new code
 */

import {
  AudioSliceInfo,
  SliceCache,
  TempFileManager,
  WavProcessor,
  sliceAudioFile,
} from './slicing'

export { AudioSliceInfo }

/**
 * Audio slicer class (backward compatibility wrapper)
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
   * Slice an audio file into n equal parts
   */
  sliceAudioFile(filepath: string, divisions: number): AudioSliceInfo[] {
    return sliceAudioFile(filepath, divisions, this.cache, this.fileManager, this.wavProcessor)
  }

  /**
   * Get a specific slice filepath
   */
  getSliceFilepath(originalPath: string, divisions: number, sliceNumber: number): string | null {
    return this.cache.getSliceFilepath(originalPath, divisions, sliceNumber)
  }

  /**
   * Clean up temporary files
   */
  cleanup(): void {
    this.fileManager.cleanup()
    this.cache.clear()
  }
}

// Global instance for backward compatibility
export const audioSlicer = new AudioSlicer()
