import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'

function makeGlobal(loadPlugin = vi.fn().mockResolvedValue({})) {
  const engine = {
    loadPlugin,
    boot: vi.fn(),
    quit: vi.fn(),
    isRunning: true,
  } as any
  const global = new Global(engine)
  global.setDocumentDirectory('/songs/session')
  return { global, loadPlugin }
}

describe('Global.effect()', () => {
  it.each(['synth.vst3', 'synth.component'])('rejects reserved format %s', async (spec) => {
    const { global } = makeGlobal()
    await expect(global.effect(spec)).rejects.toThrow('not yet supported')
  })

  it.each(['effect.wav', 'effect'])('rejects unknown extension %s', async (spec) => {
    const { global } = makeGlobal()
    await expect(global.effect(spec)).rejects.toThrow('Unknown plugin extension')
  })

  it('rejects effect while LinkAudio is enabled', async () => {
    const { global } = makeGlobal()
    global.linkAudio()
    await expect(global.effect('echo.clap')).rejects.toThrow('LinkAudio')
  })

  it('rejects LinkAudio after an effect declaration', async () => {
    const { global } = makeGlobal()
    await global.effect('echo.clap')
    expect(() => global.linkAudio()).toThrow('plugin hosting')
  })

  it('eagerly loads once and treats the same resolved path and plugin id as idempotent', async () => {
    const { global, loadPlugin } = makeGlobal()
    await expect(global.effect('./echo.clap', 'echo-id')).resolves.toBe(global)
    await global.effect('./echo.clap', 'echo-id')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
    expect(loadPlugin).toHaveBeenCalledWith(path.resolve('/songs/session', 'echo.clap'), 'echo-id')
  })

  it('rejects a second, different effect declaration', async () => {
    const { global, loadPlugin } = makeGlobal()
    await global.effect('echo.clap')
    await expect(global.effect('reverb.clap')).rejects.toThrow('one master insert in v1')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('rejects the same path with a different plugin id', async () => {
    const { global, loadPlugin } = makeGlobal()
    await global.effect('bundle.clap', 'first-id')
    await expect(global.effect('bundle.clap', 'second-id')).rejects.toThrow(
      'one master insert in v1',
    )
    expect(loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('rejects a backend without plugin hosting support', async () => {
    const engine = { boot: vi.fn(), quit: vi.fn(), isRunning: true } as any
    const global = new Global(engine)
    global.setDocumentDirectory('/songs/session')
    await expect(global.effect('echo.clap')).rejects.toThrow(
      'Plugin hosting requires the Rust engine backend',
    )
  })

  it('propagates eager load failures and permits a retry', async () => {
    const failure = new Error('daemon rejected the plugin')
    const loadPlugin = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({})
    const { global } = makeGlobal(loadPlugin)
    await expect(global.effect('echo.clap')).rejects.toBe(failure)
    await expect(global.effect('echo.clap')).resolves.toBe(global)
    expect(loadPlugin).toHaveBeenCalledTimes(2)
  })
})
