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
  private instanceDir: string
  private createdFiles: Set<string> = new Set()

  constructor() {
    // Create instance-specific subdirectory to isolate files from other processes
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 9)
    const instanceId = `orbitscore_${timestamp}_${random}`

    this.tempDir = os.tmpdir()
    this.instanceDir = path.join(this.tempDir, instanceId)

    // Create instance directory
    if (!fs.existsSync(this.instanceDir)) {
      fs.mkdirSync(this.instanceDir, { recursive: true })
    }

    // Clean up old orphaned directories on startup (older than 1 hour)
    this.cleanupOldDirectories()

    // Register cleanup on process exit
    this.registerExitHandler()
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
    return path.join(this.instanceDir, filename)
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

  /**
   * Clean up old orphaned directories (older than 1 hour)
   */
  private cleanupOldDirectories(): void {
    try {
      const oneHourAgo = Date.now() - 3600 * 1000 // 1 hour in ms
      const files = fs.readdirSync(this.tempDir)

      for (const file of files) {
        if (file.startsWith('orbitscore_')) {
          const dirPath = path.join(this.tempDir, file)
          const stats = fs.statSync(dirPath)
          if (stats.isDirectory() && stats.mtimeMs < oneHourAgo) {
            fs.rmSync(dirPath, { recursive: true, force: true })
          }
        }
      }
    } catch (error) {
      // Ignore errors during cleanup of old directories
      console.warn(`Failed to cleanup old directories: ${error}`)
    }
  }

  /**
   * Register cleanup handler on process exit
   */
  private registerExitHandler(): void {
    process.on('exit', () => {
      try {
        if (fs.existsSync(this.instanceDir)) {
          fs.rmSync(this.instanceDir, { recursive: true, force: true })
        }
      } catch (error) {
        // Ignore errors during exit cleanup
      }
    })
  }
}
