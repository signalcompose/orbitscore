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
    it('falls back to orbitPlayBuf (no channel arg) and warns once per session', async () => {
      // plugin not marked available — default false
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
