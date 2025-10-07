/**
 * Audio File Loader
 * Handles loading audio files from disk
 */

import * as fs from 'fs'
import * as path from 'path'

import { decodeWav } from './wav-decoder'

/**
 * Supported audio file extensions
 */
const SUPPORTED_EXTENSIONS = {
  wav: ['.wav'] as const,
  unsupported: ['.mp3', '.mp4', '.m4a', '.aiff', '.aif'] as const,
} as const

/**
 * Load an audio file from disk and decode it
 * @param context AudioContext for decoding
 * @param filePath Path to the audio file
 * @returns AudioBuffer containing decoded audio data
 * @throws Error if file not found or format not supported
 */
export async function loadAudioFile(context: AudioContext, filePath: string): Promise<AudioBuffer> {
  const fullPath = path.resolve(filePath)

  // Check if file exists
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Audio file not found: ${fullPath}`)
  }

  // Check file format
  const ext = path.extname(fullPath).toLowerCase()

  // Check if format is supported
  const isWav = SUPPORTED_EXTENSIONS.wav.includes(ext as '.wav')
  const isUnsupported = SUPPORTED_EXTENSIONS.unsupported.includes(
    ext as '.mp3' | '.mp4' | '.m4a' | '.aiff' | '.aif',
  )

  if (!isWav) {
    if (isUnsupported) {
      throw new Error(`Format ${ext} not yet implemented. Please use WAV files.`)
    }
    throw new Error(`Unsupported audio format: ${ext}`)
  }

  // Read file into buffer
  const fileBuffer = fs.readFileSync(fullPath)

  // Decode WAV file
  return decodeWav(context, fileBuffer)
}
