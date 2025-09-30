/**
 * Audio file slicer for chop() functionality
 * Splits audio files into segments and saves them as temporary files
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { WaveFile } from 'wavefile'

export interface AudioSliceInfo {
  sliceNumber: number
  filepath: string
  startSample: number
  endSample: number
  duration: number // in ms
}

export class AudioSlicer {
  private tempDir: string
  private sliceCache: Map<string, AudioSliceInfo[]> = new Map()

  constructor() {
    // Use system temp directory without creating subdirectories
    this.tempDir = os.tmpdir()
  }

  /**
   * Slice an audio file into n equal parts
   */
  async sliceAudioFile(filepath: string, divisions: number): Promise<AudioSliceInfo[]> {
    // Check cache first
    const cacheKey = `${filepath}-${divisions}`
    if (this.sliceCache.has(cacheKey)) {
      return this.sliceCache.get(cacheKey)!
    }

    // Read the original WAV file
    const buffer = fs.readFileSync(filepath)
    const wav = new WaveFile(buffer)

    // Get audio properties
    const fmt = wav.fmt as any
    const sampleRate = fmt.sampleRate as number
    const numChannels = fmt.numChannels as number
    const samples = wav.getSamples() as unknown as Float32Array
    const totalSamples = samples.length / numChannels
    const samplesPerSlice = Math.floor(totalSamples / divisions)

    const slices: AudioSliceInfo[] = []

    for (let i = 0; i < divisions; i++) {
      const startSample = i * samplesPerSlice
      const endSample = i === divisions - 1 ? totalSamples : (i + 1) * samplesPerSlice
      const sliceSamples = endSample - startSample

      // Extract samples for this slice (interleaved)
      const slicedSamples: number[] = []

      for (let s = startSample; s < endSample; s++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const sampleIndex = s * numChannels + ch
          if (sampleIndex < samples.length) {
            slicedSamples.push(samples[sampleIndex] || 0)
          }
        }
      }

      // Create a new WAV for this slice with samples
      const sliceWav = new WaveFile()
      sliceWav.fromScratch(numChannels, sampleRate, wav.bitDepth as string, slicedSamples)

      // Generate filename for this slice
      const basename = path.basename(filepath, path.extname(filepath))
      const sliceFilename = `${basename}_slice${i + 1}_of_${divisions}.wav`
      const sliceFilepath = path.join(this.tempDir, sliceFilename)

      // Write the slice to a temporary file
      try {
        fs.writeFileSync(sliceFilepath, sliceWav.toBuffer())
        console.log(`✅ Successfully created slice ${i + 1}/${divisions}: ${sliceFilepath}`)
      } catch (error) {
        console.error(`❌ Failed to create slice ${i + 1}/${divisions}: ${error}`)
        continue
      }

      slices.push({
        sliceNumber: i + 1,
        filepath: sliceFilepath,
        startSample,
        endSample,
        duration: (sliceSamples / sampleRate) * 1000, // Convert to ms
      })

      const duration = (sliceSamples / sampleRate) * 1000
      console.log(
        `Created slice ${i + 1}/${divisions}: ${sliceFilename} (${Math.round(duration)}ms)`,
      )
    }

    // Cache the result
    this.sliceCache.set(cacheKey, slices)

    return slices
  }

  /**
   * Get a specific slice filepath
   */
  getSliceFilepath(originalPath: string, divisions: number, sliceNumber: number): string | null {
    const cacheKey = `${originalPath}-${divisions}`
    const slices = this.sliceCache.get(cacheKey)

    if (!slices || sliceNumber < 1 || sliceNumber > slices.length) {
      return null
    }

    const slice = slices[sliceNumber - 1]
    return slice ? slice.filepath : null
  }

  /**
   * Clean up temporary files
   */
  cleanup() {
    // Remove all temp files
    if (fs.existsSync(this.tempDir)) {
      const files = fs.readdirSync(this.tempDir)
      for (const file of files) {
        fs.unlinkSync(path.join(this.tempDir, file))
      }
    }
    this.sliceCache.clear()
  }
}

// Global instance
export const audioSlicer = new AudioSlicer()
