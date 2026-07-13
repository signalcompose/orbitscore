import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'

function makeGlobal(loadPlugin = vi.fn().mockResolvedValue({}), active?: boolean) {
  const engine = {
    loadPlugin,
    pluginNoteOn: vi.fn().mockResolvedValue(undefined),
    pluginNoteOff: vi.fn().mockResolvedValue(undefined),
    ...(active === undefined ? {} : { isPluginActive: vi.fn(() => active) }),
    boot: vi.fn(),
    quit: vi.fn(),
    isRunning: true,
  } as any
  const global = new Global(engine)
  global.setDocumentDirectory('/songs/session')
  return { global, loadPlugin }
}

describe('PluginInstrumentManager', () => {
  it('eagerly loads once and shares concurrent identical declarations', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((r) => (resolve = r))
    const loadPlugin = vi.fn(() => pending)
    const { global } = makeGlobal(loadPlugin)
    const manager = global.getPluginInstrumentManager()
    const first = manager.instrument('./synth.clap', 'synth-id')
    const second = manager.instrument('synth.clap', 'synth-id')
    resolve()
    await Promise.all([first, second])
    expect(loadPlugin).toHaveBeenCalledTimes(1)
    expect(loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'synth.clap'),
      'synth-id',
      'instrument',
    )
  })

  it('rejects a different path or plugin id after declaration', async () => {
    const { global, loadPlugin } = makeGlobal()
    const manager = global.getPluginInstrumentManager()
    await manager.instrument('synth.clap', 'one')
    await expect(manager.instrument('other.clap', 'one')).rejects.toThrow('one instrument')
    await expect(manager.instrument('synth.clap', 'two')).rejects.toThrow('one instrument')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('rolls back a failed eager load and permits retry', async () => {
    const failure = new Error('load failed')
    const loadPlugin = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({})
    const { global } = makeGlobal(loadPlugin)
    const manager = global.getPluginInstrumentManager()
    await expect(manager.instrument('synth.clap')).rejects.toBe(failure)
    await expect(manager.instrument('synth.clap')).resolves.toBeUndefined()
    expect(loadPlugin).toHaveBeenCalledTimes(2)
  })

  it('self-heals an inactive idempotent declaration', async () => {
    const { global, loadPlugin } = makeGlobal(vi.fn().mockResolvedValue({}), false)
    const manager = global.getPluginInstrumentManager()
    await manager.instrument('synth.clap')
    await manager.instrument('synth.clap')
    expect(loadPlugin).toHaveBeenCalledTimes(2)
  })

  it('rejects effect and instrument in both declaration orders, including the same path', async () => {
    const first = makeGlobal().global
    await first.effect('shared.clap')
    await expect(first.getPluginInstrumentManager().instrument('shared.clap')).rejects.toThrow(
      '#431',
    )

    const second = makeGlobal().global
    await second.getPluginInstrumentManager().instrument('shared.clap')
    await expect(second.effect('shared.clap')).rejects.toThrow('#431')
  })

  it('rejects LinkAudio in both declaration orders', async () => {
    const first = makeGlobal().global
    first.linkAudio()
    await expect(first.getPluginInstrumentManager().instrument('synth.clap')).rejects.toThrow(
      'LinkAudio',
    )

    const second = makeGlobal().global
    await second.getPluginInstrumentManager().instrument('synth.clap')
    expect(() => second.linkAudio()).toThrow('plugin hosting')
  })
})
