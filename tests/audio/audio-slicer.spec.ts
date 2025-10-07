/**
 * Tests for AudioSlicer - file slicing functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock fs and os BEFORE importing AudioSlicer
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(),
  rmSync: vi.fn(),
}))

vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}))

import * as fs from 'fs'
import * as os from 'os'
import { AudioSlicer } from '../../packages/engine/src/audio/audio-slicer'

// Mock wavefile with inline class definition to avoid hoisting issues
vi.mock('wavefile', () => ({
  WaveFile: class MockWaveFile {
    fmt: any
    bitDepth: string = '16'
    private samples: Float32Array

    constructor() {
      // Set up the fmt object with proper structure
      this.fmt = {
        sampleRate: 48000,
        numChannels: 2,
        bitDepth: '16',
      }
      this.samples = new Float32Array(96000) // 1 second of stereo audio at 48kHz
    }

    fromBuffer() {
      // Mock implementation
    }

    getSamples() {
      return this.samples
    }

    fromScratch(numChannels: number, sampleRate: number, bitDepth: string) {
      // Mock implementation
      this.fmt = {
        sampleRate,
        numChannels,
        bitDepth,
      }
    }

    toBuffer() {
      return Buffer.from('mock-wav-data')
    }
  },
}))

describe('AudioSlicer', () => {
  let slicer: AudioSlicer
  let mockFs: any
  let mockOs: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockFs = vi.mocked(fs)
    mockOs = vi.mocked(os)

    // Mock temp directory
    mockOs.tmpdir.mockReturnValue('/tmp')

    // Mock file operations
    mockFs.readFileSync.mockReturnValue(Buffer.from('mock-wav-data'))
    mockFs.writeFileSync.mockImplementation(() => {})
    mockFs.existsSync.mockReturnValue(false) // Instance directory doesn't exist yet
    mockFs.mkdirSync = vi.fn() // Mock directory creation
    mockFs.readdirSync.mockReturnValue([])
    mockFs.unlinkSync.mockImplementation(() => {})
    mockFs.statSync = vi.fn().mockReturnValue({ isDirectory: () => true, mtimeMs: Date.now() })
    mockFs.rmSync = vi.fn() // Mock directory removal

    slicer = new AudioSlicer()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('sliceAudioFile', () => {
    it('should slice audio file into 4 equal parts', async () => {
      const filepath = '/path/to/test.wav'
      const divisions = 4

      const slices = await slicer.sliceAudioFile(filepath, divisions)

      expect(slices).toHaveLength(4)
      expect(slices[0].sliceNumber).toBe(1)
      expect(slices[1].sliceNumber).toBe(2)
      expect(slices[2].sliceNumber).toBe(3)
      expect(slices[3].sliceNumber).toBe(4)
    })

    it('should create slice files in temp directory', async () => {
      const filepath = '/path/to/test.wav'
      const divisions = 4

      await slicer.sliceAudioFile(filepath, divisions)

      // Should create 4 slice files
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(4)

      // Check file paths
      const expectedPaths = [
        '/tmp/test_slice1_of_4.wav',
        '/tmp/test_slice2_of_4.wav',
        '/tmp/test_slice3_of_4.wav',
        '/tmp/test_slice4_of_4.wav',
      ]

      expectedPaths.forEach((expectedPath, index) => {
        expect(mockFs.writeFileSync).toHaveBeenNthCalledWith(
          index + 1,
          expectedPath,
          Buffer.from('mock-wav-data'),
        )
      })
    })

    it('should calculate correct slice durations', async () => {
      const filepath = '/path/to/test.wav'
      const divisions = 4

      const slices = await slicer.sliceAudioFile(filepath, divisions)

      // Each slice should be 250ms (1000ms / 4)
      slices.forEach((slice) => {
        expect(slice.duration).toBe(250)
      })
    })

    it('should cache slices for same file and divisions', async () => {
      const filepath = '/path/to/test.wav'
      const divisions = 4

      // First call
      const slices1 = await slicer.sliceAudioFile(filepath, divisions)

      // Second call should return cached result
      const slices2 = await slicer.sliceAudioFile(filepath, divisions)

      expect(slices1).toBe(slices2) // Same reference
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(4) // Only called once
    })

    it('should handle single division (no slicing)', async () => {
      const filepath = '/path/to/test.wav'
      const divisions = 1

      const slices = await slicer.sliceAudioFile(filepath, divisions)

      expect(slices).toHaveLength(1)
      expect(slices[0].sliceNumber).toBe(1)
      expect(slices[0].duration).toBe(1000) // Full duration
    })
  })

  describe('getSliceFilepath', () => {
    it('should return correct slice filepath', async () => {
      const filepath = '/path/to/test.wav'
      const divisions = 4

      // First slice the file
      await slicer.sliceAudioFile(filepath, divisions)

      // Then get slice filepath
      const slicePath = slicer.getSliceFilepath(filepath, divisions, 2)

      expect(slicePath).toBe('/tmp/test_slice2_of_4.wav')
    })

    it('should return null for non-existent slice', () => {
      const filepath = '/path/to/test.wav'
      const divisions = 4
      const sliceNumber = 5 // Non-existent slice

      const slicePath = slicer.getSliceFilepath(filepath, divisions, sliceNumber)

      expect(slicePath).toBeNull()
    })

    it('should return null for non-sliced file', () => {
      const filepath = '/path/to/test.wav'
      const divisions = 4
      const sliceNumber = 1

      // Don't slice the file first
      const slicePath = slicer.getSliceFilepath(filepath, divisions, sliceNumber)

      expect(slicePath).toBeNull()
    })
  })

  describe('cleanup', () => {
    it('should clean up temporary files', async () => {
      const filepath = '/path/to/test.wav'
      const divisions = 4

      // Slice the file
      await slicer.sliceAudioFile(filepath, divisions)

      // Cleanup
      slicer.cleanup()

      // Should clear cache
      const slicePath = slicer.getSliceFilepath(filepath, divisions, 1)
      expect(slicePath).toBeNull()
    })
  })
})
