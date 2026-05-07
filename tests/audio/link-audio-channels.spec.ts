import { describe, it, expect, beforeEach } from 'vitest'

import { LinkAudioChannelRegistry } from '../../packages/engine/src/audio/supercollider/link-audio-channels'

describe('LinkAudioChannelRegistry', () => {
  let registry: LinkAudioChannelRegistry

  beforeEach(() => {
    registry = new LinkAudioChannelRegistry()
  })

  it('starts empty', () => {
    expect(registry.size()).toBe(0)
    expect(registry.lookup('kick')).toBeUndefined()
  })

  it('assigns sequential ids starting at 1', () => {
    expect(registry.acquire('kick')).toBe(1)
    expect(registry.acquire('snare')).toBe(2)
    expect(registry.acquire('hat')).toBe(3)
  })

  it('returns the same id for repeated acquire of the same name (sum-by-name)', () => {
    const a = registry.acquire('kick')
    const b = registry.acquire('kick')
    expect(a).toBe(b)
    expect(registry.size()).toBe(1)
  })

  it('lookup returns the assigned id without allocating', () => {
    registry.acquire('kick')
    expect(registry.lookup('kick')).toBe(1)
    expect(registry.lookup('unknown')).toBeUndefined()
    expect(registry.size()).toBe(1)
  })

  it('clear() drops every mapping and resets the id counter', () => {
    registry.acquire('kick')
    registry.acquire('snare')
    registry.clear()
    expect(registry.size()).toBe(0)
    expect(registry.lookup('kick')).toBeUndefined()
    expect(registry.acquire('kick')).toBe(1)
  })

  it('treats names with hyphen / underscore as distinct from a similar name', () => {
    expect(registry.acquire('drum-bus')).toBe(1)
    expect(registry.acquire('drum_bus')).toBe(2)
    expect(registry.acquire('drum-bus')).toBe(1)
  })
})
