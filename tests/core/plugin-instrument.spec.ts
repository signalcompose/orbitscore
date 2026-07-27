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
  it('accepts VST3 instruments and passes their resolved path + instance to the engine', async () => {
    const { global, loadPlugin } = makeGlobal()
    await expect(global.instrument('kick', './synth.vst3', 'synth-id')).resolves.toBe(global)
    // #540 P1: instance は note 側 port と同じ `plugin:<seqName>` 規約（5引数目）。
    expect(loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'synth.vst3'),
      'synth-id',
      'instrument',
      undefined,
      'plugin:kick',
    )
  })

  it('continues to reject AU instruments', async () => {
    const { global } = makeGlobal()
    await expect(global.instrument('kick', 'synth.component')).rejects.toThrow('not yet supported')
  })

  it('eagerly loads once and shares concurrent identical declarations', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((r) => (resolve = r))
    const loadPlugin = vi.fn(() => pending)
    const { global } = makeGlobal(loadPlugin)
    const first = global.instrument('kick', './synth.clap', 'synth-id')
    const second = global.instrument('kick', 'synth.clap', 'synth-id')
    resolve()
    await Promise.all([first, second])
    expect(loadPlugin).toHaveBeenCalledTimes(1)
    expect(loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'synth.clap'),
      'synth-id',
      'instrument',
      undefined,
      'plugin:kick',
    )
  })

  it('gives independent sequences independent instrument instances (#540 P1)', async () => {
    const { global, loadPlugin } = makeGlobal()
    await global.instrument('kick', 'synth.clap', 'one')
    await global.instrument('lead', 'synth.clap', 'one')
    // 同じ plugin でも sequence が違えば別インスタンス（別 instance ID で 2 回ロード）。
    expect(loadPlugin).toHaveBeenCalledTimes(2)
    expect(loadPlugin).toHaveBeenNthCalledWith(
      1,
      path.resolve('/songs/session', 'synth.clap'),
      'one',
      'instrument',
      undefined,
      'plugin:kick',
    )
    expect(loadPlugin).toHaveBeenNthCalledWith(
      2,
      path.resolve('/songs/session', 'synth.clap'),
      'one',
      'instrument',
      undefined,
      'plugin:lead',
    )
  })

  it('rejects a different path or plugin id after declaration for the same sequence', async () => {
    const { global, loadPlugin } = makeGlobal()
    await global.instrument('kick', 'synth.clap', 'one')
    await expect(global.instrument('kick', 'other.clap', 'one')).rejects.toThrow(
      "Sequence 'kick' already has an instrument instance",
    )
    await expect(global.instrument('kick', 'synth.clap', 'two')).rejects.toThrow(
      "Sequence 'kick' already has an instrument instance",
    )
    expect(loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('spells out the v1 replacement restriction and its workaround in the error', async () => {
    const { global } = makeGlobal()
    await global.instrument('kick', 'synth.clap', 'one')
    // Explicit, not just a substring incidentally still matching: pins the
    // workaround text itself — a regression that dropped the guidance but kept
    // the leading phrase must fail this assertion.
    await expect(global.instrument('kick', 'other.clap', 'one')).rejects.toThrow(
      /v1 does not support replacing it \(restart the engine to change the plugin\)\./,
    )
  })

  it('rolls back a failed eager load and permits retry', async () => {
    const failure = new Error('load failed')
    const loadPlugin = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({})
    const { global } = makeGlobal(loadPlugin)
    await expect(global.instrument('kick', 'synth.clap')).rejects.toBe(failure)
    await expect(global.instrument('kick', 'synth.clap')).resolves.toBe(global)
    expect(loadPlugin).toHaveBeenCalledTimes(2)
  })

  it('self-heals an inactive idempotent declaration', async () => {
    const { global, loadPlugin } = makeGlobal(vi.fn().mockResolvedValue({}), false)
    await global.instrument('kick', 'synth.clap')
    await global.instrument('kick', 'synth.clap')
    expect(loadPlugin).toHaveBeenCalledTimes(2)
  })

  it('allows effect and instrument declarations in both orders, including the same path', async () => {
    const first = makeGlobal().global
    await first.effect('shared.clap')
    await expect(first.instrument('kick', 'shared.clap')).resolves.toBe(first)

    const second = makeGlobal().global
    await second.instrument('kick', 'shared.clap')
    await expect(second.effect('shared.clap')).resolves.toBe(second)
  })

  it('rejects LinkAudio in both declaration orders', async () => {
    const first = makeGlobal().global
    first.linkAudio()
    await expect(first.instrument('kick', 'synth.clap')).rejects.toThrow('LinkAudio')

    const second = makeGlobal().global
    await second.instrument('kick', 'synth.clap')
    expect(() => second.linkAudio()).toThrow('plugin hosting')
  })
})
