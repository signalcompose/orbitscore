/**
 * Audio path and device management for Global class
 */

import type { AudioEngine } from '../../audio/types'

export class AudioManager {
  private _audioPath: string = '' // Base path for audio files
  private audioEngine: AudioEngine

  constructor(audioEngine: AudioEngine) {
    this.audioEngine = audioEngine
  }

  audioPath(value?: string): string | this {
    if (value === undefined) {
      return this._audioPath
    }
    this._audioPath = value
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
    }
  }
}
