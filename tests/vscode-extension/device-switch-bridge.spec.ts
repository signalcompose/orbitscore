/**
 * `DeviceSwitchBridge` (#484 D2.5, extracted in PR #501 review Important #8) —
 * the FIFO/timeout/drain logic for the `//#selectAudioDevice` live bridge, kept
 * vscode-free so it's unit testable without mocking `vscode` or spawning a real
 * engine process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { DeviceSwitchBridge } from '../../packages/vscode-extension/src/device-switch-bridge'

describe('DeviceSwitchBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('matches results to requests in FIFO order across two in-flight requests', async () => {
    const bridge = new DeviceSwitchBridge()
    const written: string[] = []
    const p1 = bridge.send((line) => {
      written.push(line)
      return true
    }, 'Device A')
    const p2 = bridge.send((line) => {
      written.push(line)
      return true
    }, 'Device B')

    expect(bridge.pendingCount).toBe(2)

    // Results arrive in the same order the requests were sent (FIFO — see
    // resolvePendingSelectAudioDevice's comment on the engine's serialized stdin queue).
    bridge.handleLine('{"selectAudioDevice":{"ok":true,"device":"Device A"}}')
    bridge.handleLine('{"selectAudioDevice":{"ok":true,"device":"Device B"}}')

    await expect(p1).resolves.toEqual({ ok: true, device: 'Device A' })
    await expect(p2).resolves.toEqual({ ok: true, device: 'Device B' })
    expect(bridge.pendingCount).toBe(0)
  })

  it('timeout removes only the timed-out entry — a later request still matches its own result', async () => {
    const bridge = new DeviceSwitchBridge()
    const p1 = bridge.send(() => true, 'Device A', 1000)

    vi.advanceTimersByTime(1000)
    await expect(p1).resolves.toEqual({
      ok: false,
      error: 'timed out waiting for engine response to //#selectAudioDevice',
    })
    expect(bridge.pendingCount).toBe(0)

    const p2 = bridge.send(() => true, 'Device B', 1000)
    bridge.handleLine('{"selectAudioDevice":{"ok":true,"device":"Device B"}}')
    await expect(p2).resolves.toEqual({ ok: true, device: 'Device B' })
  })

  it('drainAll resolves every pending request with the given error', async () => {
    const bridge = new DeviceSwitchBridge()
    const p1 = bridge.send(() => true, 'Device A')
    const p2 = bridge.send(() => true, 'Device B')
    expect(bridge.pendingCount).toBe(2)

    bridge.drainAll('engine process exited before responding to //#selectAudioDevice')

    await expect(p1).resolves.toEqual({
      ok: false,
      error: 'engine process exited before responding to //#selectAudioDevice',
    })
    await expect(p2).resolves.toEqual({
      ok: false,
      error: 'engine process exited before responding to //#selectAudioDevice',
    })
    expect(bridge.pendingCount).toBe(0)

    // A stale resolver drained here must never fire again for a later, unrelated line.
    bridge.handleLine('{"selectAudioDevice":{"ok":true,"device":"should not be delivered"}}')
    await expect(p1).resolves.toEqual({
      ok: false,
      error: 'engine process exited before responding to //#selectAudioDevice',
    })
  })

  it('a synchronous write failure (writeLine returns false) resolves with a synthetic ok:false', async () => {
    const bridge = new DeviceSwitchBridge()
    const p = bridge.send(() => false, 'Device A')
    await expect(p).resolves.toEqual({
      ok: false,
      error: 'failed to write //#selectAudioDevice to engine stdin',
    })
    expect(bridge.pendingCount).toBe(0)
  })

  it('an asynchronous write failure via onError resolves the specific pending entry', async () => {
    const bridge = new DeviceSwitchBridge()
    let capturedOnError: ((err: Error) => void) | undefined
    const p = bridge.send((_line, onError) => {
      capturedOnError = onError
      return true
    }, 'Device A')

    expect(bridge.pendingCount).toBe(1)
    capturedOnError?.(new Error('EPIPE'))

    await expect(p).resolves.toEqual({ ok: false, error: 'EPIPE' })
    expect(bridge.pendingCount).toBe(0)
  })

  it('ignores unrelated stdout lines', () => {
    const bridge = new DeviceSwitchBridge()
    expect(bridge.handleLine('some unrelated log line')).toBe(false)
    expect(bridge.handleLine('✅ Global running')).toBe(false)
  })

  it('returns false for a malformed/partial JSON line that looks like the bridge shape', () => {
    const bridge = new DeviceSwitchBridge()
    // Simulates a chunk-boundary split: the line looks like the bridge's JSON
    // but is truncated, so JSON.parse fails.
    expect(bridge.handleLine('{"selectAudioDevice":{"ok":true,"dev')).toBe(false)
  })
})
