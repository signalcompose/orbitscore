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
    const first = global.instrument('./synth.clap', 'synth-id')
    const second = global.instrument('synth.clap', 'synth-id')
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
    await global.instrument('synth.clap', 'one')
    await expect(global.instrument('other.clap', 'one')).rejects.toThrow('one instrument')
    await expect(global.instrument('synth.clap', 'two')).rejects.toThrow('one instrument')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('rolls back a failed eager load and permits retry', async () => {
    const failure = new Error('load failed')
    const loadPlugin = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({})
    const { global } = makeGlobal(loadPlugin)
    await expect(global.instrument('synth.clap')).rejects.toBe(failure)
    await expect(global.instrument('synth.clap')).resolves.toBe(global)
    expect(loadPlugin).toHaveBeenCalledTimes(2)
  })

  it('self-heals an inactive idempotent declaration', async () => {
    const { global, loadPlugin } = makeGlobal(vi.fn().mockResolvedValue({}), false)
    await global.instrument('synth.clap')
    await global.instrument('synth.clap')
    expect(loadPlugin).toHaveBeenCalledTimes(2)
  })

  it('allows effect and instrument declarations in both orders, including the same path', async () => {
    const first = makeGlobal().global
    await first.effect('shared.clap')
    await expect(first.instrument('shared.clap')).resolves.toBe(first)

    const second = makeGlobal().global
    await second.instrument('shared.clap')
    await expect(second.effect('shared.clap')).resolves.toBe(second)
  })

  it('rejects LinkAudio in both declaration orders', async () => {
    const first = makeGlobal().global
    first.linkAudio()
    await expect(first.instrument('synth.clap')).rejects.toThrow('LinkAudio')

    const second = makeGlobal().global
    await second.instrument('synth.clap')
    expect(() => second.linkAudio()).toThrow('plugin hosting')
  })
})
