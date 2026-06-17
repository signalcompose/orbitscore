import { describe, it, expect, beforeEach, vi } from 'vitest'

import { EventScheduler } from '../../packages/engine/src/audio/supercollider/event-scheduler'
import { BufferManager } from '../../packages/engine/src/audio/supercollider/buffer-manager'
import { OSCClient } from '../../packages/engine/src/audio/supercollider/osc-client'

describe('EventScheduler — LinkAudio SynthDef dispatch', () => {
  let scheduler: EventScheduler
  let mockBuffer: BufferManager
  let mockOsc: OSCClient
  let sentMessages: any[][]
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    sentMessages = []
    mockOsc = {
      sendMessage: vi.fn().mockImplementation((msg: any[]) => {
        sentMessages.push(msg)
        return Promise.resolve()
      }),
      // #209: channel registration / plugin-presence probe. Returns true so the
      // link path is taken; tracked separately from sentMessages (s_new only).
      registerLinkAudioChannel: vi.fn().mockResolvedValue(true),
      // booted by default — eager registration (ensureLinkAudioChannelRegistered)
      // only proceeds when the server is running.
      isRunning: vi.fn().mockReturnValue(true),
    } as any
    mockBuffer = {
      loadBuffer: vi.fn().mockResolvedValue({ bufnum: 42, duration: 1.0 }),
      getAudioDuration: vi.fn().mockReturnValue(1.0),
    } as any
    scheduler = new EventScheduler(mockBuffer, mockOsc)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  describe('hardware path (no outputChannel)', () => {
    it('uses orbitPlayBuf SynthDef', async () => {
      await scheduler.testExecutePlayback('/audio/kick.wav', { gainDb: 0, pan: 0 }, '', 0)
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]?.[1]).toBe('orbitPlayBuf')
      // Must NOT include 'channel' arg
      expect(sentMessages[0]).not.toContain('channel')
    })
  })

  describe('LinkAudio path (outputChannel set, plugin available)', () => {
    beforeEach(() => {
      scheduler.setLinkAudioPluginAvailable(true)
    })

    it('uses orbitPlayBufLink SynthDef + channel arg', async () => {
      await scheduler.testExecutePlayback(
        '/audio/kick.wav',
        { gainDb: 0, pan: 0, outputChannel: 'kick' },
        '',
        0,
      )
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]?.[1]).toBe('orbitPlayBufLink')
      const channelIdx = sentMessages[0]!.indexOf('channel')
      expect(channelIdx).toBeGreaterThan(0)
      expect(sentMessages[0]![channelIdx + 1]).toBe(1) // first acquired id
    })

    it('reuses the same channel id for the same channel name (sum)', async () => {
      await scheduler.testExecutePlayback(
        '/a.wav',
        { gainDb: 0, pan: 0, outputChannel: 'drums' },
        '',
        0,
      )
      await scheduler.testExecutePlayback(
        '/b.wav',
        { gainDb: 0, pan: 0, outputChannel: 'drums' },
        '',
        0,
      )
      const idA = sentMessages[0]![sentMessages[0]!.indexOf('channel') + 1]
      const idB = sentMessages[1]![sentMessages[1]!.indexOf('channel') + 1]
      expect(idA).toBe(idB)
    })

    it('assigns distinct ids for distinct channel names', async () => {
      await scheduler.testExecutePlayback(
        '/a.wav',
        { gainDb: 0, pan: 0, outputChannel: 'kick' },
        '',
        0,
      )
      await scheduler.testExecutePlayback(
        '/b.wav',
        { gainDb: 0, pan: 0, outputChannel: 'snare' },
        '',
        0,
      )
      const idA = sentMessages[0]![sentMessages[0]!.indexOf('channel') + 1]
      const idB = sentMessages[1]![sentMessages[1]!.indexOf('channel') + 1]
      expect(idA).not.toBe(idB)
    })

    it('does NOT warn while the plugin is available', async () => {
      await scheduler.testExecutePlayback(
        '/a.wav',
        { gainDb: 0, pan: 0, outputChannel: 'kick' },
        '',
        0,
      )
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('registers each distinct channel with the plugin exactly once (#209)', async () => {
      await scheduler.testExecutePlayback(
        '/a.wav',
        { gainDb: 0, pan: 0, outputChannel: 'drums' },
        '',
        0,
      )
      await scheduler.testExecutePlayback(
        '/b.wav',
        { gainDb: 0, pan: 0, outputChannel: 'drums' },
        '',
        0,
      )
      await scheduler.testExecutePlayback(
        '/c.wav',
        { gainDb: 0, pan: 0, outputChannel: 'bass' },
        '',
        0,
      )
      // 'drums' registered once (not per-note), 'bass' once → 2 registrations,
      // but 3 synths dispatched.
      expect(mockOsc.registerLinkAudioChannel).toHaveBeenCalledTimes(2)
      expect(sentMessages).toHaveLength(3)
      expect(sentMessages.every((m) => m[1] === 'orbitPlayBufLink')).toBe(true)
    })
  })

  describe('eager channel registration (#209 / Sequence.output pre-routing)', () => {
    it('registers the channel with the plugin before any playback dispatch', async () => {
      await scheduler.ensureLinkAudioChannelRegistered('snare')
      expect(mockOsc.registerLinkAudioChannel).toHaveBeenCalledWith(1, 'snare')
      expect(scheduler.isLinkAudioPluginAvailable()).toBe(true)
    })

    it('does not re-register on the later dispatch (idempotent)', async () => {
      await scheduler.ensureLinkAudioChannelRegistered('snare')
      ;(mockOsc.registerLinkAudioChannel as any).mockClear()
      await scheduler.testExecutePlayback(
        '/a.wav',
        { gainDb: 0, pan: 0, outputChannel: 'snare' },
        '',
        0,
      )
      expect(mockOsc.registerLinkAudioChannel).not.toHaveBeenCalled()
      expect(sentMessages.some((m) => m[1] === 'orbitPlayBufLink')).toBe(true)
    })

    it('is a no-op when the server is not booted (dispatch path registers later)', async () => {
      ;(mockOsc.isRunning as any).mockReturnValue(false)
      await scheduler.ensureLinkAudioChannelRegistered('snare')
      expect(mockOsc.registerLinkAudioChannel).not.toHaveBeenCalled()
    })
  })

  describe('lazy plugin detection (availability not set explicitly)', () => {
    it('detects the plugin via the registration /done and takes the link path', async () => {
      // mockOsc.registerLinkAudioChannel resolves true → detected as present.
      await scheduler.testExecutePlayback(
        '/a.wav',
        { gainDb: 0, pan: 0, outputChannel: 'kick' },
        '',
        0,
      )
      expect(sentMessages[0]?.[1]).toBe('orbitPlayBufLink')
      expect(scheduler.isLinkAudioPluginAvailable()).toBe(true)
    })

    it('falls back to hardware when the plugin does not answer (no /done)', async () => {
      ;(mockOsc.registerLinkAudioChannel as any).mockResolvedValue(false)
      await scheduler.testExecutePlayback(
        '/a.wav',
        { gainDb: 0, pan: 0, outputChannel: 'kick' },
        '',
        0,
      )
      expect(sentMessages[0]?.[1]).toBe('orbitPlayBuf') // hardware fallback
      expect(scheduler.isLinkAudioPluginAvailable()).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('stopAll() channel registry lifecycle', () => {
    it('clears the channel registry so the next acquire after stopAll gets id 1 again', async () => {
      scheduler.setLinkAudioPluginAvailable(true)
      // First session: acquire 'kick' → id 1
      await scheduler.testExecutePlayback(
        '/audio/kick.wav',
        { gainDb: 0, pan: 0, outputChannel: 'kick' },
        '',
        0,
      )
      expect(scheduler.getLinkAudioChannelRegistry().lookup('kick')).toBe(1)

      // Engine restart equivalent
      scheduler.stopAll()
      expect(scheduler.getLinkAudioChannelRegistry().size()).toBe(0)

      // Next session: registry cleared — fresh acquire should return 1 again
      await scheduler.testExecutePlayback(
        '/audio/kick.wav',
        { gainDb: 0, pan: 0, outputChannel: 'kick' },
        '',
        0,
      )
      expect(scheduler.getLinkAudioChannelRegistry().lookup('kick')).toBe(1)
    })
  })

  describe('LinkAudio fallback (outputChannel set, plugin missing)', () => {
    beforeEach(() => {
      // "plugin missing" now = the registration probe gets no /done → false.
      ;(mockOsc.registerLinkAudioChannel as any).mockResolvedValue(false)
    })

    it('falls back to orbitPlayBuf (no channel arg) and warns once per session', async () => {
      // plugin probe returns false → lazy detection concludes absent
      await scheduler.testExecutePlayback(
        '/audio/kick.wav',
        { gainDb: 0, pan: 0, outputChannel: 'kick' },
        '',
        0,
      )
      await scheduler.testExecutePlayback(
        '/audio/snare.wav',
        { gainDb: 0, pan: 0, outputChannel: 'snare' },
        '',
        0,
      )

      expect(sentMessages).toHaveLength(2)
      expect(sentMessages[0]?.[1]).toBe('orbitPlayBuf')
      expect(sentMessages[1]?.[1]).toBe('orbitPlayBuf')
      // fallback path must NOT include 'channel' arg in the OSC message
      expect(sentMessages[0]).not.toContain('channel')
      expect(sentMessages[1]).not.toContain('channel')
      // warned exactly once across the two events
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('LinkAudio plugin not loaded')
    })

    it('still acquires the channel id so subsequent plugin availability finds the same id', async () => {
      await scheduler.testExecutePlayback(
        '/a.wav',
        { gainDb: 0, pan: 0, outputChannel: 'kick' },
        '',
        0,
      )
      // Plugin becomes available — registry already has 'kick' → 1
      scheduler.setLinkAudioPluginAvailable(true)
      const id = scheduler.getLinkAudioChannelRegistry().lookup('kick')
      expect(id).toBe(1)
    })

    it('resets the warning flag when plugin becomes available again', async () => {
      await scheduler.testExecutePlayback(
        '/a.wav',
        { gainDb: 0, pan: 0, outputChannel: 'kick' },
        '',
        0,
      )
      expect(warnSpy).toHaveBeenCalledTimes(1)

      scheduler.setLinkAudioPluginAvailable(true)
      // back to unavailable — should warn again
      scheduler.setLinkAudioPluginAvailable(false)
      await scheduler.testExecutePlayback(
        '/b.wav',
        { gainDb: 0, pan: 0, outputChannel: 'snare' },
        '',
        0,
      )
      expect(warnSpy).toHaveBeenCalledTimes(2)
    })
  })
})
