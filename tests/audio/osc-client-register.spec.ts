/**
 * TA1 — OSCClient.registerLinkAudioChannel behaviour
 *
 * Tests the three outcome branches of registerLinkAudioChannel:
 *   (a) /done arrives before timeout → returns true, no dangling timer
 *   (b) server never replies within timeoutMs → returns false, no dangling timer
 *   (c) transport error thrown by callAndResponse → rethrows (NOT silently false)
 *
 * Uses a fake `server` injected via `(client as any).server` to avoid
 * needing an actual SuperCollider process.
 *
 * (a): callAndResponse resolves immediately — no fake timers needed; the
 *      finally-block clearTimeout fires synchronously before the resolved
 *      promise settles, so the timer count is 0 at await-time.
 * (b): needs fake timers so the sentinel (50ms) fires without real waiting.
 * (c): needs fake timers to stabilise the reject race without the sentinel
 *      dangling open (the transport error wins the race immediately).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OSCClient } from '../../packages/engine/src/audio/supercollider/osc-client'

describe('OSCClient.registerLinkAudioChannel', () => {
  let client: OSCClient

  beforeEach(() => {
    client = new OSCClient()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('(a) returns true when the server replies /done before the timeout', async () => {
    const fakeServer = {
      callAndResponse: vi.fn().mockResolvedValue(undefined),
    }
    ;(client as any).server = fakeServer

    vi.useFakeTimers()
    const promise = client.registerLinkAudioChannel(1, 'kick', 2000)
    // Flush microtasks so the already-resolved callAndResponse settles the race.
    await vi.advanceTimersByTimeAsync(0)

    const result = await promise
    expect(result).toBe(true)
    // The finally-block clearTimeout should have cleaned up the sentinel.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('(b) returns false and leaves no dangling timer when the server never replies (plugin absent)', async () => {
    const fakeServer = {
      // Never resolves — simulates no /done from the plugin (plugin absent).
      callAndResponse: vi.fn(() => new Promise(() => {})),
    }
    ;(client as any).server = fakeServer

    vi.useFakeTimers()
    const promise = client.registerLinkAudioChannel(1, 'kick', 50)

    // Advance past our sentinel timeout (50ms) so the timeout fires.
    await vi.advanceTimersByTimeAsync(51)

    const result = await promise
    expect(result).toBe(false)

    // After settling, the sentinel timer should be cleared by the finally block.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('(c) rethrows when the transport throws a non-timeout error (e.g. socket closed)', async () => {
    const transportError = new Error('socket closed')
    const fakeServer = {
      callAndResponse: vi.fn().mockRejectedValue(transportError),
    }
    ;(client as any).server = fakeServer

    // Use a very small timeout so the sentinel does not dangle after the test.
    // The transport error wins the Promise.race immediately (microtask), so the
    // sentinel is cleared by the finally block before ever firing.
    const promise = client.registerLinkAudioChannel(1, 'kick', 5)
    await expect(promise).rejects.toThrow('socket closed')
  })

  it('throws "server not running" synchronously when server is null', async () => {
    // (client as any).server is null by default — no fake timers needed.
    await expect(client.registerLinkAudioChannel(1, 'kick')).rejects.toThrow(
      'SuperCollider server not running',
    )
  })
})
