import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('SuperColliderPlayer - Volume and Pan Conversion', () => {
  let player: SuperColliderPlayer
  let mockOscClient: any

  beforeEach(() => {
    // Mock OSC client to avoid actual network calls
    mockOscClient = {
      send: vi.fn().mockResolvedValue(undefined),
    }
    
    player = new SuperColliderPlayer()
    ;(player as any).server = {
      send: {
        msg: vi.fn().mockResolvedValue(undefined),
      },
    }
    ;(player as any).isBooted = true
    ;(player as any).bufferCache = new Map()
  })

  afterEach(() => {
    // No need to shutdown in tests
  })

  describe('Volume conversion (0-100 to 0.0-1.0)', () => {
    it('should convert volume 0 to amp 0.0', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache

      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', {
        volume: 0,
      })

      expect(sendMsg).toHaveBeenCalledWith(
        expect.arrayContaining(['amp', 0])
      )
    })

    it('should convert volume 50 to amp 0.5', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache

      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', {
        volume: 50,
      })

      expect(sendMsg).toHaveBeenCalledWith(
        expect.arrayContaining(['amp', 0.5])
      )
    })

    it('should convert volume 80 to amp 0.8', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', { volume: 80 })

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['amp', 0.8]))
    })

    it('should convert volume 100 to amp 1.0', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', { volume: 100 })

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['amp', 1.0]))
    })

    it('should use default volume 80 (amp 0.8) when not specified', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', {})

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['amp', 0.8]))
    })
  })

  describe('Pan conversion (-100..100 to -1.0..1.0)', () => {
    it('should convert pan -100 to -1.0 (full left)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', { pan: -100 })

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', -1.0]))
    })

    it('should convert pan 0 to 0.0 (center)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', { pan: 0 })

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', 0.0]))
    })

    it('should convert pan 100 to 1.0 (full right)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', { pan: 100 })

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', 1.0]))
    })

    it('should convert pan -50 to -0.5 (mid-left)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', { pan: -50 })

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', -0.5]))
    })

    it('should convert pan 50 to 0.5 (mid-right)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', { pan: 50 })

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', 0.5]))
    })

    it('should use default pan 0 (center) when not specified', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', {})

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', 0.0]))
    })
  })

  describe('Combined volume and pan', () => {
    it('should correctly convert both volume and pan', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', { volume: 60, pan: -75 })

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['amp', 0.6, 'pan', -0.75]))
    })

    it('should handle extreme values', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', 0)
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).executePlayback('/path/to/sample.wav', { volume: 100, pan: -100 })

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['amp', 1.0, 'pan', -1.0]))
    })
  })
})
