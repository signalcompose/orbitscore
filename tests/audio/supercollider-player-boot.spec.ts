/**
 * TA6 — SuperColliderPlayer.boot() sets linkAudioPluginAvailable(false)
 *
 * Verifies the two cases where boot() calls setLinkAudioPluginAvailable(false):
 *   (a) loadLinkAudioSynthDef() returns false → available set to false, no warn
 *   (b) loadLinkAudioSynthDef() throws → available set to false AND warns
 *
 * All I/O-touching methods are replaced with vi.fn() spies injected via
 * `(player as any)` private-access. The `{ scsynth: '/fake' }` option bypasses
 * resolveScsynthPath() which would throw ScsynthNotFoundError in strict mode.
 *
 * This file intentionally does NOT use `describe.skipIf(CI)` — it is fully
 * mocked and must pass in CI alongside every other unit test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

/** Build a fully-mocked player with all I/O calls stubbed. */
function makeMockedPlayer() {
  const player = new SuperColliderPlayer()

  // Replace real OSCClient.boot with a no-op so it never touches the network.
  vi.spyOn((player as any).oscClient, 'boot').mockResolvedValue(undefined)

  // Stub the SynthDef loaders that run before loadLinkAudioSynthDef.
  const synthDefLoader = (player as any).synthDefLoader
  vi.spyOn(synthDefLoader, 'loadMainSynthDef').mockResolvedValue(undefined)
  vi.spyOn(synthDefLoader, 'loadMasteringEffectSynthDefs').mockResolvedValue(undefined)

  // Spy on the scheduler's setLinkAudioPluginAvailable so we can assert calls.
  const schedulerSpy = vi.spyOn((player as any).eventScheduler, 'setLinkAudioPluginAvailable')

  return { player, synthDefLoader, schedulerSpy }
}

describe('SuperColliderPlayer.boot() — LinkAudio SynthDef load outcome', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('(a) sets linkAudioPluginAvailable(false) when loadLinkAudioSynthDef returns false, without warning', async () => {
    const { player, synthDefLoader, schedulerSpy } = makeMockedPlayer()
    vi.spyOn(synthDefLoader, 'loadLinkAudioSynthDef').mockResolvedValue(false)

    await player.boot(undefined, { scsynth: '/fake/scsynth' })

    expect(schedulerSpy).toHaveBeenCalledWith(false)
    // The returns-false branch must NOT warn (only the catch does).
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('(b) sets linkAudioPluginAvailable(false) and warns when loadLinkAudioSynthDef throws', async () => {
    const { player, synthDefLoader, schedulerSpy } = makeMockedPlayer()
    vi.spyOn(synthDefLoader, 'loadLinkAudioSynthDef').mockRejectedValue(new Error('read error'))

    await player.boot(undefined, { scsynth: '/fake/scsynth' })

    expect(schedulerSpy).toHaveBeenCalledWith(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('LinkAudio SynthDef load failed')
  })

  it('does NOT call setLinkAudioPluginAvailable when loadLinkAudioSynthDef returns true', async () => {
    const { player, synthDefLoader, schedulerSpy } = makeMockedPlayer()
    vi.spyOn(synthDefLoader, 'loadLinkAudioSynthDef').mockResolvedValue(true)

    await player.boot(undefined, { scsynth: '/fake/scsynth' })

    // When the SynthDef loads, boot leaves availability=null so the lazy probe
    // confirms actual plugin presence on first dispatch. setLinkAudioPluginAvailable
    // must NOT be called (not even with true).
    expect(schedulerSpy).not.toHaveBeenCalled()
  })
})
