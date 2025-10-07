import { audioSlicer } from '../../../audio/audio-slicer'

/**
 * Options for slice preparation
 */
export interface PrepareSlicesOptions {
  sequenceName: string
  audioFilePath?: string
  chopDivisions?: number
}

/**
 * Prepare audio slices for chop() functionality
 * 
 * This function:
 * - Checks if slicing is needed (chopDivisions > 1)
 * - Uses audioSlicer to create slice files
 * - Handles errors gracefully
 * 
 * @param options - Slice preparation options
 */
export async function prepareSlices(options: PrepareSlicesOptions): Promise<void> {
  const { sequenceName, audioFilePath, chopDivisions } = options

  // Skip if no audio file or no chopping needed
  if (!audioFilePath || !chopDivisions || chopDivisions <= 1) {
    return
  }

  try {
    await audioSlicer.sliceAudioFile(audioFilePath, chopDivisions)
    // Successfully prepared slices
  } catch (err: any) {
    console.error(`${sequenceName}: failed to prepare slices - ${err.message}`)
  }
}
