import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('SuperColliderPlayer - dB to Amplitude and Pan Conversion', () => {
  let player: SuperColliderPlayer
  // let mockOscClient: any

  beforeEach(() => {
    // Mock OSC client to avoid actual network calls
    // mockOscClient = {
    //   send: vi.fn().mockResolvedValue(undefined),
    // }

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

  describe('dB to amplitude conversion', () => {
    it('should convert 0 dB to amp 1.0 (100%)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache

      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback(
        '/path/to/sample.wav',
        {
          gainDb: 0,
        },
        '',
        0,
      )

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['amp', 1.0]))
    })

    it('should convert -6 dB to amp ~0.501 (~50%)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache

      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback(
        '/path/to/sample.wav',
        {
          gainDb: -6,
        },
        '',
        0,
      )

      const calls = sendMsg.mock.calls
      const ampIndex = calls[0][0].indexOf('amp')
      const ampValue = calls[0][0][ampIndex + 1]

      // -6 dB = 10^(-6/20) = 0.5011872336272722
      expect(ampValue).toBeCloseTo(0.501, 2)
    })

    it('should convert -12 dB to amp ~0.251 (~25%)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', { gainDb: -12 }, '', 0)

      const calls = sendMsg.mock.calls
      const ampIndex = calls[0][0].indexOf('amp')
      const ampValue = calls[0][0][ampIndex + 1]

      // -12 dB = 10^(-12/20) = 0.25118864315095796
      expect(ampValue).toBeCloseTo(0.251, 2)
    })

    it('should convert +6 dB to amp ~2.0 (200%)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', { gainDb: 6 }, '', 0)

      const calls = sendMsg.mock.calls
      const ampIndex = calls[0][0].indexOf('amp')
      const ampValue = calls[0][0][ampIndex + 1]

      // +6 dB = 10^(6/20) = 1.9952623149688797
      expect(ampValue).toBeCloseTo(1.995, 2)
    })

    it('should convert -Infinity dB to amp 0.0 (silence)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', { gainDb: -Infinity }, '', 0)

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['amp', 0.0]))
    })

    it('should use default 0 dB (amp 1.0) when not specified', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', {}, '', 0)

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['amp', 1.0]))
    })

    it('should handle decimal dB values like -3.5', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', { gainDb: -3.5 }, '', 0)

      const calls = sendMsg.mock.calls
      const ampIndex = calls[0][0].indexOf('amp')
      const ampValue = calls[0][0][ampIndex + 1]

      // -3.5 dB = 10^(-3.5/20) = 0.6683439176841525
      expect(ampValue).toBeCloseTo(0.668, 2)
    })
  })

  describe('Pan conversion (-100..100 to -1.0..1.0)', () => {
    it('should convert pan -100 to -1.0 (full left)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', { pan: -100 }, '', 0)

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', -1.0]))
    })

    it('should convert pan 0 to 0.0 (center)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', { pan: 0 }, '', 0)

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', 0.0]))
    })

    it('should convert pan 100 to 1.0 (full right)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', { pan: 100 }, '', 0)

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', 1.0]))
    })

    it('should convert pan -50 to -0.5 (mid-left)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', { pan: -50 }, '', 0)

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', -0.5]))
    })

    it('should convert pan 50 to 0.5 (mid-right)', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', { pan: 50 }, '', 0)

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', 0.5]))
    })

    it('should use default pan 0 (center) when not specified', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback('/path/to/sample.wav', {}, '', 0)

      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', 0.0]))
    })
  })

  describe('Combined gainDb and pan', () => {
    it('should correctly convert both gainDb and pan', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback(
        '/path/to/sample.wav',
        { gainDb: -6, pan: -75 },
        '',
        0,
      )

      const calls = sendMsg.mock.calls
      const ampIndex = calls[0][0].indexOf('amp')
      const ampValue = calls[0][0][ampIndex + 1]

      expect(ampValue).toBeCloseTo(0.501, 2)
      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', -0.75]))
    })

    it('should handle extreme values', async () => {
      const mockBufferCache = new Map()
      mockBufferCache.set('/path/to/sample.wav', { bufnum: 0, duration: 1.0 })
      ;(player as any).bufferCache = mockBufferCache
      const sendMsg = vi.spyOn((player as any).server.send, 'msg')

      await (player as any).testExecutePlayback(
        '/path/to/sample.wav',
        { gainDb: 12, pan: -100 },
        '',
        0,
      )

      const calls = sendMsg.mock.calls
      const ampIndex = calls[0][0].indexOf('amp')
      const ampValue = calls[0][0][ampIndex + 1]

      // +12 dB = 10^(12/20) = 3.981071705534969
      expect(ampValue).toBeCloseTo(3.981, 2)
      expect(sendMsg).toHaveBeenCalledWith(expect.arrayContaining(['pan', -1.0]))
    })
  })
})
