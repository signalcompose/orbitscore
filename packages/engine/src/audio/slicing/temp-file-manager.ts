/**
 * Temporary file management for audio slices
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Manages temporary files for audio slices
 */
export class TempFileManager {
  private tempDir: string
  private createdFiles: Set<string> = new Set()

  constructor() {
    // Use system temp directory
    this.tempDir = os.tmpdir()
  }

  /**
   * Generate filename for a slice
   */
  generateSliceFilename(
    originalFilepath: string,
    sliceNumber: number,
    totalSlices: number,
  ): string {
    const basename = path.basename(originalFilepath, path.extname(originalFilepath))
    return `${basename}_slice${sliceNumber}_of_${totalSlices}.wav`
  }

  /**
   * Get full path for a slice file
   */
  getSliceFilepath(originalFilepath: string, sliceNumber: number, totalSlices: number): string {
    const filename = this.generateSliceFilename(originalFilepath, sliceNumber, totalSlices)
    return path.join(this.tempDir, filename)
  }

  /**
   * Write buffer to temporary file
   */
  writeSliceFile(filepath: string, buffer: Buffer): void {
    try {
      fs.writeFileSync(filepath, buffer)
      // Track this file for cleanup
      this.createdFiles.add(filepath)
    } catch (error) {
      throw new Error(`Failed to write slice file ${filepath}: ${error}`)
    }
  }

  /**
   * Clean up only the temporary files created by this instance
   * This prevents accidentally deleting files from other processes
   */
  cleanup(): void {
    for (const filepath of this.createdFiles) {
      try {
        if (fs.existsSync(filepath)) {
          fs.unlinkSync(filepath)
        }
      } catch (error) {
        console.warn(`Failed to delete temp file ${filepath}: ${error}`)
      }
    }
    // Clear the tracking set after cleanup
    this.createdFiles.clear()
  }
}
