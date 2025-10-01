/**
 * Tests for AdvancedAudioPlayer with sox integration
 */

import { execSync, spawn } from 'child_process'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { AdvancedAudioPlayer } from '../../packages/engine/src/audio/advanced-player'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

describe('AdvancedAudioPlayer', () => {
  let player: AdvancedAudioPlayer

  beforeEach(() => {
    // Mock child_process methods
    vi.mocked(execSync).mockReturnValue('1.0' as any)
    vi.mocked(spawn).mockReturnValue({
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    } as any)

    player = new AdvancedAudioPlayer()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('sox detection', () => {
    it('should detect sox when available', () => {
      // Mock successful sox detection
      vi.mocked(execSync).mockReturnValueOnce('' as any)

      const newPlayer = new AdvancedAudioPlayer()
      expect(newPlayer).toBeDefined()
    })

    it('should fallback when sox is not available', () => {
      // Mock failed sox detection
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('Command failed')
      })

      const newPlayer = new AdvancedAudioPlayer()
      expect(newPlayer).toBeDefined()
    })
  })

  describe('playSlice', () => {
    it('should calculate correct trim parameters for slice 1', () => {
      const filepath = '/path/to/test.wav'
      const sliceNumber = 1
      const totalSlices = 4

      // Mock console.log to capture scheduling logs
      const consoleSpy = vi.spyOn(console, 'log')

      player.playSlice(filepath, sliceNumber, totalSlices, {}, 'test')

      // Verify the slice info was logged (scheduling, not execution)
      expect(consoleSpy).toHaveBeenCalledWith('🔍 playSlice called: test, slice 1/4, hasSox: true')
      expect(consoleSpy).toHaveBeenCalledWith('🎵 test (sox slice 1/4: 0.00s-0.25s)')

      consoleSpy.mockRestore()
    })

    it('should calculate correct trim parameters for slice 2', () => {
      const filepath = '/path/to/test.wav'
      const sliceNumber = 2
      const totalSlices = 4

      const consoleSpy = vi.spyOn(console, 'log')

      player.playSlice(filepath, sliceNumber, totalSlices, {}, 'test')

      expect(consoleSpy).toHaveBeenCalledWith('🔍 playSlice called: test, slice 2/4, hasSox: true')
      expect(consoleSpy).toHaveBeenCalledWith('🎵 test (sox slice 2/4: 0.25s-0.50s)')

      consoleSpy.mockRestore()
    })

    it('should calculate correct trim parameters for slice 4', () => {
      const filepath = '/path/to/test.wav'
      const sliceNumber = 4
      const totalSlices = 4

      const consoleSpy = vi.spyOn(console, 'log')

      player.playSlice(filepath, sliceNumber, totalSlices, {}, 'test')

      expect(consoleSpy).toHaveBeenCalledWith('🔍 playSlice called: test, slice 4/4, hasSox: true')
      expect(consoleSpy).toHaveBeenCalledWith('🎵 test (sox slice 4/4: 0.75s-1.00s)')

      consoleSpy.mockRestore()
    })

    it('should schedule slice with custom volume', () => {
      const filepath = '/path/to/test.wav'
      const sliceNumber = 1
      const totalSlices = 4
      const options = { volume: 50 }

      const consoleSpy = vi.spyOn(console, 'log')

      player.playSlice(filepath, sliceNumber, totalSlices, options, 'test')

      // Verify scheduling (volume is passed in options, applied during execution)
      expect(consoleSpy).toHaveBeenCalledWith('🔍 playSlice called: test, slice 1/4, hasSox: true')
      expect(consoleSpy).toHaveBeenCalledWith('🎵 test (sox slice 1/4: 0.00s-0.25s)')

      consoleSpy.mockRestore()
    })
  })

  describe('scheduleSliceEvent', () => {
    it('should schedule slice events with correct timing', () => {
      const filepath = '/path/to/test.wav'
      const startTimeMs = 1000
      const sliceNumber = 2
      const totalSlices = 4
      const options = { volume: 60 }

      const consoleSpy = vi.spyOn(console, 'log')

      player.scheduleSliceEvent(filepath, startTimeMs, sliceNumber, totalSlices, options, 'test')

      // Should log the slice information (scheduling doesn't immediately execute sox)
      expect(consoleSpy).toHaveBeenCalledWith('🎵 test (sox slice 2/4: 0.25s-0.50s)')

      consoleSpy.mockRestore()
    })
  })

  describe('getAudioDuration', () => {
    it('should get audio duration using sox', () => {
      const mockExecSync = vi.mocked(execSync)
      mockExecSync.mockReturnValueOnce('2.5')

      const filepath = '/path/to/test.wav'

      // Access private method through any cast
      const duration = (player as any).getAudioDuration(filepath)

      expect(mockExecSync).toHaveBeenCalledWith(`sox --info -D "${filepath}"`, { encoding: 'utf8' })
      expect(duration).toBe(2.5)
    })

    it('should return default duration on error', () => {
      const mockExecSync = vi.mocked(execSync)
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('Command failed')
      })

      const filepath = '/path/to/test.wav'
      const duration = (player as any).getAudioDuration(filepath)

      expect(duration).toBe(1.0)
    })
  })
})
