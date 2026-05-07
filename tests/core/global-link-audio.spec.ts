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
})
