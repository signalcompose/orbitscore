/**
 * Audio path and device management for Global class
 */

import path from 'node:path'

import type { AudioEngine } from '../../audio/types'

export class AudioManager {
  private _audioPath: string = '' // Base path for audio files
  private audioEngine: AudioEngine
  private _documentDirectory: string = '' // Directory of the currently evaluated .osc file

  constructor(audioEngine: AudioEngine) {
    this.audioEngine = audioEngine
  }

  /**
   * Set the directory of the currently evaluated .osc file
   * This is used as the base for relative path resolution in audioPath()
   * @internal - Called by the engine when evaluating a document
   */
  setDocumentDirectory(dirPath: string): void {
    this._documentDirectory = dirPath
  }

  audioPath(value?: string): string | this {
    if (value === undefined) {
      return this._audioPath
    }

    // Resolve to absolute path
    let resolved: string
    if (path.isAbsolute(value)) {
      resolved = value
    } else if (this._documentDirectory) {
      resolved = path.resolve(this._documentDirectory, value)
    } else {
      throw new Error(
        `Cannot resolve relative audioPath("${value}"): no document context. ` +
          `Save the .osc file first, or use an absolute path.`,
      )
    }

    // Singleton behavior: only set if different from current value
    if (this._audioPath === resolved) {
      return this
    }

    console.log(`📂 audioPath: ${value} → ${resolved}`)
    console.log(`📂 base: ${this._documentDirectory} (.osc file directory)`)

    this._audioPath = resolved
    return this
  }

  /**
   * Set audio output device
   * @param deviceName - Name of the output device to use
   */
  audioDevice(deviceName: string): this {
    // Check if audioEngine has device selection support (SuperColliderPlayer)
    if (this.audioEngine.getCurrentOutputDevice) {
      const currentDevice = this.audioEngine.getCurrentOutputDevice()
      if (currentDevice && currentDevice.name === deviceName) {
        console.log(`🔊 Already using device: ${deviceName}`)
        return this
      }

      console.warn(`⚠️  Audio device can only be set before engine starts`)
      console.warn(`⚠️  Current device: ${currentDevice?.name || 'default'}`)
      console.warn(`⚠️  Requested device: ${deviceName}`)
      console.warn(`⚠️  Restart the engine to change audio device`)
    } else {
      console.warn('⚠️  Audio device selection not available')
    }
    return this
  }

  // Get current state
  getState() {
    return {
      audioPath: this._audioPath,
      documentDirectory: this._documentDirectory,
    }
  }
}
