import { afterEach, describe, expect, it, vi } from 'vitest'

import { DaemonProtocolError } from '../../../packages/engine/src/audio/rust-engine/errors'
import { RustEnginePlayer } from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'

interface FakeDaemon {
  start: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  isRunning: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  loadPlugin: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
}

const ECHO_LOAD_RESULT = {
  pluginId: 'echo-id',
  pluginName: 'Echo',
  notePortIndex: 0,
}

function createHarness() {
  const player = new RustEnginePlayer()
  const daemon: FakeDaemon = {
    start: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ uptime_sec: 0 }),
    isRunning: vi.fn().mockReturnValue(true),
    off: vi.fn(),
    on: vi.fn(),
    loadPlugin: vi.fn().mockResolvedValue(ECHO_LOAD_RESULT),
    quit: vi.fn().mockResolvedValue(undefined),
  }
  Object.defineProperty(player, 'daemon', { value: daemon })
  return { player, daemon }
}

describe('RustEnginePlayer plugin recovery after daemon respawn', () => {
  const players: RustEnginePlayer[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(players.splice(0).map((player) => player.quit()))
  })

  it('reissues every successfully loaded plugin after respawn', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/echo.clap', 'echo-id')
    daemon.loadPlugin.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    expect(daemon.loadPlugin).toHaveBeenCalledWith('/plugins/echo.clap', 'echo-id')
    // C1: a successful reload must flip pluginActive back to true, so
    // PluginEffectManager's self-heal check doesn't mistake this recovery
    // for a still-stale cache.
    expect(player.isPluginActive()).toBe(true)
  })

  it('logs a reload failure and retains the plugin for the next respawn retry', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/echo.clap', 'echo-id')
    daemon.loadPlugin.mockClear()
    daemon.loadPlugin
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce(ECHO_LOAD_RESULT)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('❌ [rust-engine] failed to reload plugin'),
      expect.any(Error),
    )
    // C1: a failed reload must flip pluginActive to false — this is the
    // signal PluginEffectManager uses to detect the silent-failure cache.
    expect(player.isPluginActive()).toBe(false)

    await (player as any).respawnLoop()
    expect(daemon.loadPlugin).toHaveBeenCalledTimes(2)
    expect(daemon.loadPlugin).toHaveBeenLastCalledWith('/plugins/echo.clap', 'echo-id')
    expect(player.isPluginActive()).toBe(true)
  })
})

describe('RustEnginePlayer.loadPlugin() error conversion', () => {
  const players: RustEnginePlayer[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(players.splice(0).map((player) => player.quit()))
  })

  it('converts CLAP_UNAVAILABLE into a build-hint error', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    daemon.loadPlugin.mockRejectedValueOnce(
      new DaemonProtocolError('CLAP_UNAVAILABLE', 'clap host is unavailable'),
    )

    await expect(player.loadPlugin('/plugins/echo.clap', 'echo-id')).rejects.toThrow(
      '--features clap-host',
    )
  })

  it('wraps other DaemonProtocolError codes with a generic "Failed to load plugin" message', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    daemon.loadPlugin.mockRejectedValueOnce(
      new DaemonProtocolError('PLUGIN_LOAD_FAILED', 'the plugin crashed on init'),
    )

    await expect(player.loadPlugin('/plugins/echo.clap', 'echo-id')).rejects.toThrow(
      /^Failed to load plugin:/,
    )
  })

  it('passes through non-DaemonProtocolError failures unchanged', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    const original = new Error('unexpected transport failure')
    daemon.loadPlugin.mockRejectedValueOnce(original)

    await expect(player.loadPlugin('/plugins/echo.clap', 'echo-id')).rejects.toBe(original)
  })

  it('flips pluginActive to false when a subsequent loadPlugin call fails', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/echo.clap', 'echo-id')
    expect(player.isPluginActive()).toBe(true)

    daemon.loadPlugin.mockRejectedValueOnce(new Error('daemon transport failure'))

    await expect(player.loadPlugin('/plugins/echo.clap', 'echo-id')).rejects.toThrow(
      'daemon transport failure',
    )
    // The catch block must not rely on callers guaranteeing false-on-entry —
    // it must flip pluginActive to false itself on every failure path.
    expect(player.isPluginActive()).toBe(false)
  })
})
