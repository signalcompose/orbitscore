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
  replacePlugin: ReturnType<typeof vi.fn>
  pluginNoteOn: ReturnType<typeof vi.fn>
  pluginNoteOff: ReturnType<typeof vi.fn>
  savePluginState: ReturnType<typeof vi.fn>
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
    replacePlugin: vi.fn().mockResolvedValue({ ...ECHO_LOAD_RESULT, quarantinedSlot: false }),
    pluginNoteOn: vi.fn().mockResolvedValue(undefined),
    pluginNoteOff: vi.fn().mockResolvedValue(undefined),
    savePluginState: vi.fn().mockImplementation((_target, absolutePath) =>
      Promise.resolve({
        path: absolutePath,
        bytesWritten: 12,
      }),
    ),
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
    // #542: 警告は instance を名指しする（instance 未指定は 'default' 表記）。
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("instrument 'default'"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not restored'))
  })

  it('warns per instance, not once globally, when different instruments are inactive (#542)', async () => {
    const { player } = createHarness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // どちらの instance もロード成功していない → 両方 drop されるが、警告は instance ごとに1回ずつ。
    await player.pluginNoteOn(60, 0, 1, 'plugin:kick')
    await player.pluginNoteOn(60, 0, 1, 'plugin:kick')
    await player.pluginNoteOn(60, 0, 1, 'plugin:lead')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("instrument 'plugin:kick'"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("instrument 'plugin:lead'"))
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

  it('reissues two instrument instances independently with their own instance+statePath (#540 P1/P2)', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:kick',
      '/songs/kick.vstpreset',
    )
    await player.loadPlugin(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      '/songs/lead.vstpreset',
    )
    daemon.loadPlugin.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    // instance キーが退行して片方が cache を上書きすると、ここが 1 回になり検出される。
    expect(daemon.loadPlugin).toHaveBeenCalledTimes(2)
    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:kick',
      '/songs/kick.vstpreset',
    )
    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      '/songs/lead.vstpreset',
    )
  })

  it('T8 reloads the replacement spec after a daemon respawn', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin(
      '/plugins/old.clap',
      'old-id',
      'instrument',
      undefined,
      'plugin:kick',
      '/songs/old.state',
    )
    await player.replacePlugin(
      '/plugins/new.vst3',
      'new-id',
      'instrument',
      undefined,
      'plugin:kick',
      '/songs/new.state',
    )
    expect(daemon.replacePlugin).toHaveBeenCalledTimes(1)
    expect(daemon.replacePlugin).toHaveBeenCalledWith(
      '/plugins/new.vst3',
      'new-id',
      'instrument',
      undefined,
      'plugin:kick',
      '/songs/new.state',
    )
    daemon.loadPlugin.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    expect(daemon.loadPlugin).toHaveBeenCalledTimes(1)
    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/new.vst3',
      'new-id',
      'instrument',
      undefined,
      'plugin:kick',
      '/songs/new.state',
    )
    expect(daemon.replacePlugin.mock.invocationCallOrder[0]).toBeLessThan(
      daemon.loadPlugin.mock.invocationCallOrder[0]!,
    )
  })

  it('preserves a definitive ReplacePlugin rejection and the old respawn cache', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/old.clap', 'old-id', 'instrument', undefined, 'plugin:kick')
    const rejection = new DaemonProtocolError('OUTPROC_ATTACH_FAILED', 'prepare failed')
    daemon.replacePlugin.mockRejectedValueOnce(rejection)

    await expect(
      player.replacePlugin('/plugins/new.vst3', 'new-id', 'instrument', undefined, 'plugin:kick'),
    ).rejects.toBe(rejection)
    expect(player.isPluginActive('instrument', undefined, 'plugin:kick')).toBe(true)

    daemon.loadPlugin.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await (player as any).respawnLoop()
    expect(daemon.loadPlugin).toHaveBeenCalledTimes(1)
    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/old.clap',
      'old-id',
      'instrument',
      undefined,
      'plugin:kick',
      undefined,
    )
  })

  it('forgets the respawn cache when ReplacePlugin has an ambiguous transport failure', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/old.clap', 'old-id', 'instrument', undefined, 'plugin:kick')
    const transportFailure = new Error('socket closed before ReplacePlugin response')
    daemon.replacePlugin.mockRejectedValueOnce(transportFailure)

    await expect(
      player.replacePlugin('/plugins/new.vst3', 'new-id', 'instrument', undefined, 'plugin:kick'),
    ).rejects.toBe(transportFailure)
    expect(player.isPluginActive('instrument', undefined, 'plugin:kick')).toBe(false)

    daemon.loadPlugin.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await (player as any).respawnLoop()

    // The daemon may have committed either tenant, so replaying the cached old
    // spec would silently choose A after an A -> B request. Recovery must wait
    // for the next explicit seq.instrument(...) declaration instead.
    expect(daemon.loadPlugin).toHaveBeenCalledTimes(0)
  })

  it('uses the daemon-returned saved path when reloading the cached plugin after respawn', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    const requestedStatePath = '/songs/states/requested-lead.state'
    const savedStatePath = '/daemon/states/actual-lead.state'
    daemon.savePluginState.mockResolvedValueOnce({
      path: savedStatePath,
      bytesWritten: 12,
    })

    await player.savePluginState(
      { role: 'instrument', instance: 'plugin:lead' },
      requestedStatePath,
    )

    expect(daemon.savePluginState).toHaveBeenCalledTimes(1)
    expect(daemon.savePluginState).toHaveBeenCalledWith(
      { role: 'instrument', instance: 'plugin:lead' },
      requestedStatePath,
    )
    daemon.loadPlugin.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    expect(daemon.loadPlugin).toHaveBeenCalledTimes(1)
    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      savedStatePath,
    )
  })

  it('does not update the respawn cache when saving plugin state fails', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    daemon.savePluginState.mockRejectedValueOnce(new Error('state save failed'))

    await expect(
      player.savePluginState(
        { role: 'instrument', instance: 'plugin:lead' },
        '/songs/states/failed.state',
      ),
    ).rejects.toThrow('state save failed')

    daemon.loadPlugin.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await (player as any).respawnLoop()

    expect(daemon.loadPlugin).toHaveBeenCalledTimes(1)
    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      undefined,
    )
  })

  it('does not update the respawn cache when saving plugin state writes zero bytes', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    const failedStatePath = '/songs/states/zero-byte.state'
    daemon.savePluginState.mockResolvedValueOnce({
      path: failedStatePath,
      bytesWritten: 0,
    })

    await expect(
      player.savePluginState({ role: 'instrument', instance: 'plugin:lead' }, failedStatePath),
    ).resolves.toEqual({
      path: failedStatePath,
      bytesWritten: 0,
    })

    daemon.loadPlugin.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await (player as any).respawnLoop()

    expect(daemon.loadPlugin).toHaveBeenCalledTimes(1)
    expect(daemon.loadPlugin).toHaveBeenCalledWith(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      undefined,
    )
  })

  it('one instrument reload failure flips only that instance inactive; the other keeps playing (#540 P1)', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:kick',
    )
    await player.loadPlugin(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    daemon.loadPlugin.mockClear()
    // Map 挿入順で kick が先に再ロードされ、その1回目だけ失敗させる。
    daemon.loadPlugin
      .mockRejectedValueOnce(new Error('kick reload failed'))
      .mockResolvedValueOnce(ECHO_LOAD_RESULT)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()

    // active フラグは instance ごとに独立（片方の失敗が他方に波及しない）。
    expect(player.isPluginActive('instrument', undefined, 'plugin:kick')).toBe(false)
    expect(player.isPluginActive('instrument', undefined, 'plugin:lead')).toBe(true)

    // 失敗した instance への note は drop、成功した instance への note は通る。
    daemon.pluginNoteOn.mockClear()
    await player.pluginNoteOn(60, 0, 0.8, 'plugin:kick')
    expect(daemon.pluginNoteOn).not.toHaveBeenCalled()
    await player.pluginNoteOn(60, 0, 0.8, 'plugin:lead')
    expect(daemon.pluginNoteOn).toHaveBeenCalledTimes(1)
    expect(daemon.pluginNoteOn).toHaveBeenCalledWith(60, 0, 0.8, 'plugin:lead')
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
