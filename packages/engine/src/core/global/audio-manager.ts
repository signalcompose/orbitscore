/**
 * Audio path and device management for Global class
 */

import path from 'node:path'

import type { AudioEngine } from '../../audio/types'

import { expandHome, resolveAudio } from './audio-resolver'

export class AudioManager {
  private _audioPaths: string[] = []
  private audioEngine: AudioEngine
  private _documentDirectory: string = ''
  private _resolveCache: Map<string, string> = new Map()

  constructor(audioEngine: AudioEngine) {
    this.audioEngine = audioEngine
  }

  /**
   * Set the directory of the currently evaluated .orbs file
   * This is used as the base for relative path resolution in audioPath()
   * @internal - Called by the engine when evaluating a document
   */
  setDocumentDirectory(dirPath: string): void {
    if (this._documentDirectory !== dirPath) {
      this._resolveCache.clear()
    }
    this._documentDirectory = dirPath
  }

  /**
   * Set or get the audio search path(s).
   *
   * Forms:
   * - `audioPath()`                     — getter, returns the first entry (legacy: a single string)
   * - `audioPath("path")`               — single search path
   * - `audioPath("a", "b", "c")`        — variadic, multiple search paths (Unix `$PATH` order)
   * - `audioPath(["a", "b"])`           — array form (TypeScript ergonomic)
   *
   * Each entry may use `~/` for home directory expansion. Relative entries
   * are resolved against the .orbs file's directory.
   *
   * Setting the path(s) invalidates the resolution cache.
   */
  audioPath(...values: (string | string[])[]): string | this {
    if (values.length === 0) {
      return this._audioPaths[0] ?? ''
    }

    const inputs: string[] = []
    for (const v of values) {
      if (Array.isArray(v)) {
        inputs.push(...v)
      } else {
        inputs.push(v)
      }
    }

    const resolved: string[] = []
    for (const input of inputs) {
      const expanded = expandHome(input)
      if (path.isAbsolute(expanded)) {
        resolved.push(expanded)
      } else if (this._documentDirectory) {
        resolved.push(path.resolve(this._documentDirectory, expanded))
      } else {
        throw new Error(
          `Cannot resolve relative audioPath("${input}"): no document context. ` +
            `Save the .orbs file first, or use an absolute path.`,
        )
      }
    }

    // Singleton behavior: only invalidate cache if entries changed
    if (
      this._audioPaths.length === resolved.length &&
      this._audioPaths.every((p, i) => p === resolved[i])
    ) {
      return this
    }

    this._resolveCache.clear()
    if (resolved.length === 1) {
      console.log(`📂 audioPath: ${inputs[0]} → ${resolved[0]}`)
      console.log(`📂 base: ${this._documentDirectory} (.orbs file directory)`)
    } else {
      console.log(`📂 audioPath: ${resolved.length} entries`)
      resolved.forEach((p, i) => console.log(`   [${i}]: ${p}`))
    }

    this._audioPaths = resolved
    return this
  }

  /** Read-only view of all configured audio search paths. */
  getAudioPaths(): readonly string[] {
    return this._audioPaths
  }

  /**
   * Resolve a sample spec to an absolute file path using the configured
   * audioPath(s) and document directory. Throws on resolution failure.
   */
  resolve(spec: string): string {
    return resolveAudio({
      spec,
      audioPaths: this._audioPaths,
      documentDirectory: this._documentDirectory,
      cache: this._resolveCache,
    })
  }

  /** Test-only: clear the resolution cache. */
  clearResolveCache(): void {
    this._resolveCache.clear()
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
      audioPath: this._audioPaths[0] ?? '',
      audioPaths: [...this._audioPaths],
      documentDirectory: this._documentDirectory,
    }
  }
}
