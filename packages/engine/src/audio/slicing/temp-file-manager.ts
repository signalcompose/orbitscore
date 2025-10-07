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
    } catch (error) {
      throw new Error(`Failed to write slice file ${filepath}: ${error}`)
    }
  }

  /**
   * Clean up all temporary slice files
   */
  cleanup(): void {
    if (!fs.existsSync(this.tempDir)) {
      return
    }

    const files = fs.readdirSync(this.tempDir)
    for (const file of files) {
      // Only delete files that match our slice pattern
      if (file.includes('_slice') && file.endsWith('.wav')) {
        try {
          fs.unlinkSync(path.join(this.tempDir, file))
        } catch (error) {
          console.warn(`Failed to delete temp file ${file}: ${error}`)
        }
      }
    }
  }
}
