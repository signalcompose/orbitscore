import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('Sequence.output() — LinkAudio channel binding', () => {
  let global: Global
  let seq: Sequence
  let mockPlayer: SuperColliderPlayer
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockPlayer = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
    } as any

    global = new Global(mockPlayer)
    seq = new Sequence(global, mockPlayer)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('should have no output channel by default', () => {
    expect(seq.getOutputChannel()).toBeUndefined()
    const state = seq.getState()
    expect(state.outputChannel).toBeUndefined()
  })

  it('should record the channel name when output() is called', () => {
    global.linkAudio()
    seq.output('kick')
    expect(seq.getOutputChannel()).toBe('kick')
    expect(seq.getState().outputChannel).toBe('kick')
  })

  it('should be method-chainable (returns this)', () => {
    global.linkAudio()
    const result = seq.output('snare')
    expect(result).toBe(seq)
  })

  it('should overwrite the channel name on subsequent calls', () => {
    global.linkAudio()
    seq.output('kick')
    seq.output('kick-2')
    expect(seq.getOutputChannel()).toBe('kick-2')
  })

  it('should warn when called without Global.linkAudio() but still record the value', () => {
    seq.output('orphan-channel')
    expect(seq.getOutputChannel()).toBe('orphan-channel')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('init global.linkAudio()')
  })

  it('should not warn when Global.linkAudio() is enabled before output()', () => {
    global.linkAudio()
    seq.output('kick')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('should accept channel names with hyphens and underscores', () => {
    global.linkAudio()
    seq.output('drum-bus_01')
    expect(seq.getOutputChannel()).toBe('drum-bus_01')
  })
})
