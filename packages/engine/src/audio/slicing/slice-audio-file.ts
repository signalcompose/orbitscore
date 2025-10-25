/**
 * Main audio slicing orchestration
 * Coordinates WAV processing, file management, and caching
 */

import { AudioSliceInfo } from './types'
import { SliceCache } from './slice-cache'
import { TempFileManager } from './temp-file-manager'
import { WavProcessor } from './wav-processor'

/**
 * Slice an audio file into equal parts
 *
 * @param filepath - Path to the audio file
 * @param divisions - Number of slices to create
 * @param cache - Slice cache instance
 * @param fileManager - Temporary file manager instance
 * @param wavProcessor - WAV processor instance
 * @returns Array of slice information
 */
export function sliceAudioFile(
  filepath: string,
  divisions: number,
  cache: SliceCache,
  fileManager: TempFileManager,
  wavProcessor: WavProcessor,
): AudioSliceInfo[] {
  // Check cache first - use single get() call to avoid race condition
  const cached = cache.get(filepath, divisions)
  if (cached) {
    return cached
  }

  // Read and parse WAV file
  const audioProps = wavProcessor.readWavFile(filepath)
  const { sampleRate, numChannels, bitDepth, totalSamples, samples } = audioProps

  // Calculate samples per slice
  const samplesPerSlice = Math.floor(totalSamples / divisions)

  const slices: AudioSliceInfo[] = []

  // Create each slice
  for (let i = 0; i < divisions; i++) {
    const sliceNumber = i + 1
    const startSample = i * samplesPerSlice
    const endSample = i === divisions - 1 ? totalSamples : (i + 1) * samplesPerSlice
    const sliceSamples = endSample - startSample

    // Extract samples for this slice
    const slicedSamples = wavProcessor.extractSliceSamples(
      samples,
      startSample,
      endSample,
      numChannels,
    )

    // Create WAV buffer
    const buffer = wavProcessor.createWavBuffer(slicedSamples, numChannels, sampleRate, bitDepth)

    // Get filepath and write
    const sliceFilepath = fileManager.getSliceFilepath(filepath, sliceNumber, divisions)

    try {
      fileManager.writeSliceFile(sliceFilepath, buffer)
      if (process.env.ORBITSCORE_DEBUG) {
        console.log(`✅ Successfully created slice ${sliceNumber}/${divisions}: ${sliceFilepath}`)
      }
    } catch (error) {
      console.error(`❌ Failed to create slice ${sliceNumber}/${divisions}: ${error}`)
      continue
    }

    // Calculate duration
    const duration = (sliceSamples / sampleRate) * 1000 // Convert to ms

    slices.push({
      sliceNumber,
      filepath: sliceFilepath,
      startSample,
      endSample,
      duration,
    })

    if (process.env.ORBITSCORE_DEBUG) {
      console.log(
        `Created slice ${sliceNumber}/${divisions}: ${fileManager.generateSliceFilename(filepath, sliceNumber, divisions)} (${Math.round(duration)}ms)`,
      )
    }
  }

  // Cache the result
  cache.set(filepath, divisions, slices)

  return slices
}
