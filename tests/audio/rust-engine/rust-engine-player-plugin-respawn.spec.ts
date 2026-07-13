import { afterEach, describe, expect, it, vi } from 'vitest'

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

function createHarness() {
  const player = new RustEnginePlayer()
  const daemon: FakeDaemon = {
    start: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ uptime_sec: 0 }),
    isRunning: vi.fn().mockReturnValue(true),
    off: vi.fn(),
    on: vi.fn(),
    loadPlugin: vi.fn().mockResolvedValue({
      pluginId: 'echo-id',
      pluginName: 'Echo',
      notePortIndex: 0,
    }),
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
  })

  it('logs a reload failure and retains the plugin for the next respawn retry', async () => {
    const { player, daemon } = createHarness()
    players.push(player)
    await player.loadPlugin('/plugins/echo.clap', 'echo-id')
    daemon.loadPlugin.mockClear()
    daemon.loadPlugin.mockRejectedValueOnce(new Error('reload failed')).mockResolvedValueOnce({
      pluginId: 'echo-id',
      pluginName: 'Echo',
      notePortIndex: 0,
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (player as any).respawnLoop()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'), expect.any(Error))

    await (player as any).respawnLoop()
    expect(daemon.loadPlugin).toHaveBeenCalledTimes(2)
    expect(daemon.loadPlugin).toHaveBeenLastCalledWith('/plugins/echo.clap', 'echo-id')
  })
})
