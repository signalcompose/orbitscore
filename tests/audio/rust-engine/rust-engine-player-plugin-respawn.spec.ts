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
  pluginNoteOn: ReturnType<typeof vi.fn>
  pluginNoteOff: ReturnType<typeof vi.fn>
  setBusRouting: ReturnType<typeof vi.fn>
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
    pluginNoteOn: vi.fn().mockResolvedValue(undefined),
    pluginNoteOff: vi.fn().mockResolvedValue(undefined),
    setBusRouting: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  }
  Object.defineProperty(player, 'daemon', { value: daemon })
  return { player, daemon }
}

describe('RustEnginePlayer plugin note ordering', () => {
  it('issues note sends synchronously with no await boundary before the daemon call', async () => {
    const { player, daemon } = createHarness()
    // pluginActive only flips true after a successful loadPlugin() — mirrors
    // the real seq.instrument() -> daemon.loadPlugin() -> note dispatch order.
    await player.loadPlugin('/plugins/echo.clap', 'echo-id', 'instrument')
    const on = player.pluginNoteOn(60, 0, 0.75)
    const off = player.pluginNoteOff(60, 0)
    expect(daemon.pluginNoteOn).toHaveBeenCalledWith(60, 0, 0.75, undefined)
    expect(daemon.pluginNoteOff).toHaveBeenCalledWith(60, 0, undefined, undefined)
    return Promise.all([on, off])
  })

  it('warns once and drops the note when the daemon is disconnected (C1)', async () => {
    const { player, daemon } = createHarness()
    daemon.isRunning.mockReturnValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await player.pluginNoteOn(60, 0, 1)
    await player.pluginNoteOff(60, 0)
    expect(daemon.pluginNoteOn).not.toHaveBeenCalled()
    expect(daemon.pluginNoteOff).not.toHaveBeenCalled()
    // warn-once: two drops, one warning.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('daemon is not connected'))
  })

  it('warns once and drops the note when pluginActive is false (C2 — respawn restore failed)', async () => {
    const { player, daemon } = createHarness()
    // Daemon is connected, but no successful loadPlugin() has happened, so
    // pluginActive is still false (e.g. after a failed post-respawn reload).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await player.pluginNoteOn(60, 0, 1)
    await player.pluginNoteOff(60, 0)
    expect(daemon.pluginNoteOn).not.toHaveBeenCalled()
    expect(daemon.pluginNoteOff).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not restored'))
  })
})

describe('RustEnginePlayer plugin recovery after daemon respawn', () => {
  const players: RustEnginePlayer[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(players.splice(0).map((player) => player.quit()))
  })

  it('reissues every successfully loaded plugin after respawn', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/echo.clap', 'echo-id', 'effect')
    daemon.loadPlugin.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/echo.clap',
      'echo-id',
      'effect',
      undefined,
      undefined,
      undefined,
    )
    // C1: a successful reload must flip pluginActive back to true, so
    // PluginEffectManager's self-heal check doesn't mistake this recovery
    // for a still-stale cache.
    expect(player.isPluginActive()).toBe(true)
  })

  it('logs a reload failure and retains the plugin for the next respawn retry', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/echo.clap', 'echo-id', 'instrument')
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
    expect(daemon.loadPlugin).toHaveBeenLastCalledWith(
      '/plugins/echo.clap',
      'echo-id',
      'instrument',
      undefined,
      undefined,
      undefined,
    )
    expect(player.isPluginActive()).toBe(true)
  })

  it('reissues a master effect and a per-sequence insert bus independently (#434 S3)', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/master.clap', undefined, 'effect')
    await player.loadPlugin('/plugins/reverb.clap', undefined, 'effect', 'seq-bus-0')
    daemon.loadPlugin.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    expect(daemon.loadPlugin).toHaveBeenCalledTimes(2)
    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/master.clap',
      undefined,
      'effect',
      undefined,
      undefined,
      undefined,
    )
    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/reverb.clap',
      undefined,
      'effect',
      'seq-bus-0',
      undefined,
      undefined,
    )
  })

  it('one bus reload failure does not skip reloading the others', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/master.clap', undefined, 'effect')
    await player.loadPlugin('/plugins/reverb.clap', undefined, 'effect', 'seq-bus-0')
    daemon.loadPlugin.mockClear()
    daemon.loadPlugin
      .mockRejectedValueOnce(new Error('master reload failed'))
      .mockResolvedValueOnce(ECHO_LOAD_RESULT)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    expect(daemon.loadPlugin).toHaveBeenCalledTimes(2)
    // The failing entry does not prevent the other declaration from reloading.
    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/reverb.clap',
      undefined,
      'effect',
      'seq-bus-0',
      undefined,
      undefined,
    )
    expect(player.isPluginActive()).toBe(false)
  })
})

describe('RustEnginePlayer bus routing recovery after daemon respawn (MX.4 M3)', () => {
  const players: RustEnginePlayer[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(players.splice(0).map((player) => player.quit()))
  })

  it('replays the last intended SetBusRouting per seq bus after respawn', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.setBusRouting('seq-bus-0', 'sum-bus-0', [{ bus: 'aux-bus-0', gain: 0.3 }])
    await player.setBusRouting('seq-bus-1', undefined, [{ bus: 'aux-bus-0', gain: 0.5 }])
    daemon.setBusRouting.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    expect(daemon.setBusRouting).toHaveBeenCalledTimes(2)
    expect(daemon.setBusRouting).toHaveBeenCalledWith('seq-bus-0', 'sum-bus-0', [
      { bus: 'aux-bus-0', gain: 0.3 },
    ])
    expect(daemon.setBusRouting).toHaveBeenCalledWith('seq-bus-1', undefined, [
      { bus: 'aux-bus-0', gain: 0.5 },
    ])
  })

  it('keeps the intended routing on a transport failure so the respawn replay restores it', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    daemon.setBusRouting.mockRejectedValueOnce(new Error('socket closed'))
    await expect(player.setBusRouting('seq-bus-0', 'sum-bus-0', [])).rejects.toThrow(
      'socket closed',
    )
    daemon.setBusRouting.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    expect(daemon.setBusRouting).toHaveBeenCalledWith('seq-bus-0', 'sum-bus-0', [])
  })

  it('reverts the cache on a definitive daemon-side rejection (no bad replay after respawn)', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.setBusRouting('seq-bus-0', 'sum-bus-0', [])
    daemon.setBusRouting.mockRejectedValueOnce(
      new DaemonProtocolError('MALFORMED_REQUEST', 'output must target a sum bus'),
    )
    await expect(player.setBusRouting('seq-bus-0', 'aux-bus-0', [])).rejects.toThrow(
      'output must target a sum bus',
    )
    daemon.setBusRouting.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    // The rejected request is NOT replayed; the last accepted routing is.
    expect(daemon.setBusRouting).toHaveBeenCalledTimes(1)
    expect(daemon.setBusRouting).toHaveBeenCalledWith('seq-bus-0', 'sum-bus-0', [])
  })

  it('one routing replay failure logs an error and does not skip the others or fail the respawn', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.setBusRouting('seq-bus-0', 'sum-bus-0', [])
    await player.setBusRouting('seq-bus-1', 'sum-bus-0', [])
    daemon.setBusRouting.mockClear()
    daemon.setBusRouting
      .mockRejectedValueOnce(new Error('replay failed'))
      .mockResolvedValueOnce(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    expect(daemon.setBusRouting).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to restore bus routing'),
      expect.any(Error),
    )
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

    await expect(player.loadPlugin('/plugins/echo.clap', 'echo-id', 'effect')).rejects.toThrow(
      '--features clap-host',
    )
  })

  it('wraps other DaemonProtocolError codes with a generic "Failed to load plugin" message', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    daemon.loadPlugin.mockRejectedValueOnce(
      new DaemonProtocolError('PLUGIN_LOAD_FAILED', 'the plugin crashed on init'),
    )

    await expect(player.loadPlugin('/plugins/echo.clap', 'echo-id', 'effect')).rejects.toThrow(
      /^Failed to load plugin:/,
    )
  })

  it('passes through non-DaemonProtocolError failures unchanged', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    const original = new Error('unexpected transport failure')
    daemon.loadPlugin.mockRejectedValueOnce(original)

    await expect(player.loadPlugin('/plugins/echo.clap', 'echo-id', 'effect')).rejects.toBe(
      original,
    )
  })

  it('flips pluginActive to false when a subsequent loadPlugin call fails', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/echo.clap', 'echo-id', 'effect')
    expect(player.isPluginActive()).toBe(true)

    daemon.loadPlugin.mockRejectedValueOnce(new Error('daemon transport failure'))

    await expect(player.loadPlugin('/plugins/echo.clap', 'echo-id', 'effect')).rejects.toThrow(
      'daemon transport failure',
    )
    // The catch block must not rely on callers guaranteeing false-on-entry —
    // it must flip pluginActive to false itself on every failure path.
    expect(player.isPluginActive()).toBe(false)
  })
})
