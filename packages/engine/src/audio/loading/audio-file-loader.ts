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
 * Check if a file exists at the given path
 * @param filePath Path to the file
 * @returns True if the file exists
 */
export function fileExists(filePath: string): boolean {
  const fullPath = path.resolve(filePath)
  return fs.existsSync(fullPath)
}

/**
 * Get the file extension from a path
 * @param filePath Path to the file
 * @returns Lowercase file extension (e.g., '.wav')
 */
export function getFileExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase()
}

/**
 * Check if the file format is supported
 * @param extension File extension
 * @returns True if the format is supported for decoding
 */
export function isSupportedFormat(extension: string): boolean {
  return SUPPORTED_EXTENSIONS.wav.includes(extension as '.wav')
}

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
  if (!fileExists(filePath)) {
    throw new Error(`Audio file not found: ${fullPath}`)
  }

  // Check file format
  const ext = getFileExtension(fullPath)

  if (!isSupportedFormat(ext)) {
    if (
      SUPPORTED_EXTENSIONS.unsupported.includes(ext as '.mp3' | '.mp4' | '.m4a' | '.aiff' | '.aif')
    ) {
      throw new Error(`Format ${ext} not yet implemented. Please use WAV files.`)
    }
    throw new Error(`Unsupported audio format: ${ext}`)
  }

  // Read file into buffer
  const fileBuffer = fs.readFileSync(fullPath)

  // Decode based on format
  if (ext === '.wav') {
    return decodeWav(context, fileBuffer)
  }

  // This should never be reached due to format checks above
  throw new Error(`Unsupported audio format: ${ext}`)
}
