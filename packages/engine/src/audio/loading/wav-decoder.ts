/**
 * WAV Decoder
 * Handles decoding of WAV audio files
 */

import { WaveFile } from 'wavefile'

/**
 * Decode a WAV file buffer into an AudioBuffer
 * @param context AudioContext for creating the buffer
 * @param fileBuffer Raw file data
 * @returns AudioBuffer containing decoded audio data
 */
export function decodeWav(context: AudioContext, fileBuffer: Buffer): AudioBuffer {
  const wav = new WaveFile(fileBuffer)

  // Get format info before conversion (cast to any for now, wavefile typings are incomplete)
  const fmt = wav.fmt as any
  const originalChannels = fmt.numChannels

  // Convert to standard format
  wav.toBitDepth('32f') // Convert to 32-bit float
  wav.toSampleRate(48000) // Convert to 48kHz

  // Get audio data - returns interleaved samples for multi-channel
  const samples = wav.getSamples(false) as unknown as Float32Array

  // Get updated format info after conversion
  const sampleRate = (fmt.sampleRate || 48000) as number
  const numberOfChannels = (fmt.numChannels || originalChannels || 1) as number
  const samplesPerChannel = Math.floor(samples.length / numberOfChannels)

  // Create AudioBuffer
  const buffer = context.createBuffer(numberOfChannels, samplesPerChannel, sampleRate)

  // De-interleave and copy samples to buffer
  if (numberOfChannels === 1) {
    copyMonoSamples(buffer, samples)
  } else {
    copyMultiChannelSamples(buffer, samples, numberOfChannels, samplesPerChannel)
  }

  return buffer
}

/**
 * Copy mono audio samples to an AudioBuffer
 * @param buffer Target AudioBuffer
 * @param samples Source sample data
 */
function copyMonoSamples(buffer: AudioBuffer, samples: Float32Array): void {
  // Mono: direct copy
  const channelData = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    channelData[i] = samples[i] || 0
  }
  buffer.copyToChannel(channelData, 0)
}

/**
 * Copy multi-channel (stereo or more) audio samples to an AudioBuffer
 * @param buffer Target AudioBuffer
 * @param samples Source sample data (interleaved)
 * @param numberOfChannels Number of audio channels
 * @param samplesPerChannel Number of samples per channel
 */
function copyMultiChannelSamples(
  buffer: AudioBuffer,
  samples: Float32Array,
  numberOfChannels: number,
  samplesPerChannel: number,
): void {
  // Stereo or multi-channel: de-interleave
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = new Float32Array(samplesPerChannel)
    for (let i = 0; i < samplesPerChannel; i++) {
      channelData[i] = samples[i * numberOfChannels + channel] || 0
    }
    buffer.copyToChannel(channelData, channel)
  }
}
