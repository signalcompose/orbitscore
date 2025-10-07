/**
 * WAV file processing for audio slicing
 */

import * as fs from 'fs'

import { WaveFile } from 'wavefile'

import { AudioProperties } from './types'

/**
 * Processes WAV files for slicing
 */
export class WavProcessor {
  /**
   * Read and parse WAV file
   */
  readWavFile(filepath: string): AudioProperties {
    try {
      const buffer = fs.readFileSync(filepath)
      const wav = new WaveFile(buffer)

      const fmt = wav.fmt as any
      const sampleRate = fmt.sampleRate as number
      const numChannels = fmt.numChannels as number
      const samples = wav.getSamples() as unknown as Float32Array
      const totalSamples = samples.length / numChannels

      return {
        sampleRate,
        numChannels,
        bitDepth: wav.bitDepth as string,
        totalSamples,
        samples,
      }
    } catch (error) {
      throw new Error(`Failed to read WAV file ${filepath}: ${error}`)
    }
  }

  /**
   * Extract samples for a specific slice
   */
  extractSliceSamples(
    samples: Float32Array,
    startSample: number,
    endSample: number,
    numChannels: number,
  ): number[] {
    const slicedSamples: number[] = []

    for (let s = startSample; s < endSample; s++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sampleIndex = s * numChannels + ch
        if (sampleIndex < samples.length) {
          slicedSamples.push(samples[sampleIndex] || 0)
        }
      }
    }

    return slicedSamples
  }

  /**
   * Create WAV buffer from samples
   */
  createWavBuffer(
    samples: number[],
    numChannels: number,
    sampleRate: number,
    bitDepth: string,
  ): Buffer {
    try {
      const sliceWav = new WaveFile()
      sliceWav.fromScratch(numChannels, sampleRate, bitDepth, samples)
      return sliceWav.toBuffer()
    } catch (error) {
      throw new Error(`Failed to create WAV buffer: ${error}`)
    }
  }
}
