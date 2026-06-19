/**
 * TA2 — SynthDefLoader.loadLinkAudioSynthDef behaviour
 *
 * Tests three scenarios for the LinkAudio SynthDef load:
 *   (a) primary .scsyndef absent → returns false, zero /d_recv calls
 *   (b) primary + keepalive present → returns true, two /d_recv calls (in order)
 *   (c) primary present, keepalive absent → returns true, one /d_recv, warns
 *
 * Uses vi.mock('fs') at module level (required for ESM namespaces) to control
 * filesystem existence without touching disk.
 *
 * Note: loadLinkAudioSynthDef calls sleep(100) twice in the happy path (~200ms
 * per test) — no timer faking; the real sleeps are fine at this scale.
 */

// vi.mock must be hoisted BEFORE any imports that reach 'fs'
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

import * as fs from 'fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SynthDefLoader } from '../../packages/engine/src/audio/supercollider/synthdef-loader'
import { OSCClient } from '../../packages/engine/src/audio/supercollider/osc-client'

const mockedExistsSync = vi.mocked(fs.existsSync)
const mockedReadFileSync = vi.mocked(fs.readFileSync)

describe('SynthDefLoader.loadLinkAudioSynthDef', () => {
  let fakeOscClient: Pick<OSCClient, 'isRunning' | 'sendMessage'>
  let loader: SynthDefLoader
  let sendMessage: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    sendMessage = vi.fn().mockResolvedValue(undefined)
    fakeOscClient = {
      isRunning: () => true,
      sendMessage,
    }
    loader = new SynthDefLoader(fakeOscClient as OSCClient)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.clearAllMocks()
    // Restore warn spy after clearAllMocks (clearAllMocks resets mock state but
    // not the spy binding — just re-suppress to be safe).
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Also re-stub sendMessage since clearAllMocks reset it.
    sendMessage = vi.fn().mockResolvedValue(undefined)
    ;(fakeOscClient as any).sendMessage = sendMessage
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('(a) returns false and sends zero /d_recv when the primary .scsyndef is absent', async () => {
    mockedExistsSync.mockReturnValue(false)

    const result = await loader.loadLinkAudioSynthDef()

    expect(result).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('(b) returns true and sends two /d_recv calls (primary then keepalive) when both files are present', async () => {
    mockedExistsSync.mockReturnValue(true)
    // Return distinguishable buffers per path so we can assert ordering.
    mockedReadFileSync.mockImplementation((p: any) => {
      const pathStr = String(p)
      if (pathStr.includes('orbitLinkAudioKeepalive')) {
        return Buffer.from('KEEPALIVE_DATA') as any
      }
      return Buffer.from('LINK_DATA') as any
    })

    const result = await loader.loadLinkAudioSynthDef()

    expect(result).toBe(true)
    expect(sendMessage).toHaveBeenCalledTimes(2)

    // First call: primary SynthDef
    const firstCallData = sendMessage.mock.calls[0]![0]![1] as Buffer
    expect(firstCallData.toString()).toBe('LINK_DATA')

    // Second call: keepalive SynthDef
    const secondCallData = sendMessage.mock.calls[1]![0]![1] as Buffer
    expect(secondCallData.toString()).toBe('KEEPALIVE_DATA')

    // Both calls must use /d_recv
    expect(sendMessage.mock.calls[0]![0]![0]).toBe('/d_recv')
    expect(sendMessage.mock.calls[1]![0]![0]).toBe('/d_recv')
  })

  it('(c) returns true, sends exactly one /d_recv, and warns when keepalive is absent', async () => {
    mockedExistsSync.mockImplementation(
      (p: any) =>
        // Primary present, keepalive absent
        !String(p).includes('orbitLinkAudioKeepalive'),
    )
    mockedReadFileSync.mockReturnValue(Buffer.from('LINK_DATA') as any)

    const result = await loader.loadLinkAudioSynthDef()

    expect(result).toBe(true)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]![0]![0]).toBe('/d_recv')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('orbitLinkAudioKeepalive')
  })
})
