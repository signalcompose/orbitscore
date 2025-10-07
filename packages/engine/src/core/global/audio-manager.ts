/**
 * Audio path and device management for Global class
 */

export class AudioManager {
  private _audioPath: string = '' // Base path for audio files
  private audioEngine: any // Can be AudioEngine or SuperColliderPlayer

  constructor(audioEngine: any) {
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
    if (typeof (this.audioEngine as any).getCurrentOutputDevice === 'function') {
      const currentDevice = (this.audioEngine as any).getCurrentOutputDevice()
      if (currentDevice === deviceName) {
        console.log(`🔊 Already using device: ${deviceName}`)
        return this
      }

      console.warn(`⚠️  Audio device can only be set before engine starts`)
      console.warn(`⚠️  Current device: ${currentDevice || 'default'}`)
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
