import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('Global.linkAudio() — Link Audio mode declaration', () => {
  let global: Global
  let mockPlayer: SuperColliderPlayer

  beforeEach(() => {
    mockPlayer = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
    } as any

    global = new Global(mockPlayer)
  })

  it('should not be enabled by default', () => {
    expect(global.isLinkAudioEnabled()).toBe(false)
    const state = global.getState()
    expect(state.linkAudioEnabled).toBe(false)
    expect(state.linkAudioTargetSampleRate).toBeUndefined()
  })

  it('should enable LinkAudio mode when called without arguments (auto-detect SR)', () => {
    global.linkAudio()
    expect(global.isLinkAudioEnabled()).toBe(true)
    const state = global.getState()
    expect(state.linkAudioEnabled).toBe(true)
    // undefined => plugin-side auto-detect with 48k fallback
    expect(state.linkAudioTargetSampleRate).toBeUndefined()
  })

  it('should enable LinkAudio mode with an explicit target sample rate', () => {
    global.linkAudio(48000)
    expect(global.isLinkAudioEnabled()).toBe(true)
    const state = global.getState()
    expect(state.linkAudioTargetSampleRate).toBe(48000)
  })

  it('should accept non-default sample rates like 44100', () => {
    global.linkAudio(44100)
    const state = global.getState()
    expect(state.linkAudioTargetSampleRate).toBe(44100)
  })

  it('should be method-chainable (returns this)', () => {
    const result = global.linkAudio()
    expect(result).toBe(global)
  })

  it('should overwrite the explicit target SR on subsequent calls', () => {
    global.linkAudio(48000)
    global.linkAudio(96000)
    expect(global.getState().linkAudioTargetSampleRate).toBe(96000)
  })

  it('should clear explicit target SR when called without arg after a previous explicit call', () => {
    global.linkAudio(48000)
    global.linkAudio()
    expect(global.getState().linkAudioTargetSampleRate).toBeUndefined()
    expect(global.isLinkAudioEnabled()).toBe(true)
  })

  describe('targetSampleRate validation', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    it('should warn and drop SR override for negative values, but still enable mode', () => {
      global.linkAudio(-1)
      expect(global.isLinkAudioEnabled()).toBe(true)
      expect(global.getState().linkAudioTargetSampleRate).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('invalid target sample rate')
    })

    it('should warn and drop SR override for zero', () => {
      global.linkAudio(0)
      expect(global.getState().linkAudioTargetSampleRate).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it('should warn and drop SR override for non-integer values', () => {
      global.linkAudio(48000.5)
      expect(global.getState().linkAudioTargetSampleRate).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it('should warn and drop SR override for NaN', () => {
      global.linkAudio(Number.NaN)
      expect(global.getState().linkAudioTargetSampleRate).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it('should accept common rates without warning', () => {
      for (const sr of [44100, 48000, 88200, 96000, 176400, 192000]) {
        warnSpy.mockClear()
        global.linkAudio(sr)
        expect(global.getState().linkAudioTargetSampleRate).toBe(sr)
        expect(warnSpy).not.toHaveBeenCalled()
      }
    })

    it('should accept uncommon-but-positive integer rates with a hint', () => {
      // Plugin can resample any positive integer rate; we hint, not block.
      global.linkAudio(32000)
      expect(global.getState().linkAudioTargetSampleRate).toBe(32000)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('non-standard sample rate')
    })
  })
})

describe('Global — Link tempo leader (#283)', () => {
  let global: Global
  let mockPlayer: SuperColliderPlayer
  let setLinkTempo: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setLinkTempo = vi.fn().mockResolvedValue(undefined)
    mockPlayer = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
      // start() routes through TransportControl → globalScheduler.start()
      // (globalScheduler === the audio engine cast as Scheduler).
      start: vi.fn(),
      setLinkTempo,
    } as any
    global = new Global(mockPlayer)
  })

  it('pushes the tempo to the Link session when tempo() is set in LinkAudio mode', () => {
    global.linkAudio()
    setLinkTempo.mockClear() // ignore the linkAudio()-time push of the default
    global.tempo(72)
    expect(setLinkTempo).toHaveBeenCalledWith(72)
  })

  it('does NOT push tempo when LinkAudio mode is off', () => {
    global.tempo(72)
    expect(setLinkTempo).not.toHaveBeenCalled()
  })

  it('pushes the already-set tempo when linkAudio() is called (file order: tempo then linkAudio)', () => {
    global.tempo(60) // before linkAudio(): no push yet
    expect(setLinkTempo).not.toHaveBeenCalled()
    global.linkAudio() // now captures the standing tempo
    expect(setLinkTempo).toHaveBeenCalledWith(60)
  })

  it('re-asserts leadership on start() in LinkAudio mode', () => {
    global.tempo(90)
    global.linkAudio()
    setLinkTempo.mockClear()
    global.start()
    expect(setLinkTempo).toHaveBeenCalledWith(90)
  })

  it('does not throw when the engine lacks setLinkTempo (optional capability)', () => {
    const bare = new Global({
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
    } as any)
    bare.linkAudio()
    expect(() => bare.tempo(120)).not.toThrow()
  })
})
