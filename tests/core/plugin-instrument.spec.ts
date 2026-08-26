import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DaemonProtocolError } from '../../packages/engine/src/audio/rust-engine/errors'
import { Global } from '../../packages/engine/src/core/global'
import { EffectSlotLimitError } from '../../packages/engine/src/core/global/effect-slot'
import { ProjectStateStore } from '../../packages/engine/src/core/project-state-store'

const REPLACE_RESULT = {
  pluginId: 'replacement-id',
  pluginName: 'Replacement',
  notePortIndex: 0,
  quarantinedSlot: false,
}

function makeGlobal(
  loadPlugin = vi.fn().mockResolvedValue({}),
  active?: boolean,
  options: {
    documentDirectory?: string | false
    replacePlugin?: ReturnType<typeof vi.fn>
    closePluginUi?: ReturnType<typeof vi.fn>
    openPluginUi?: ReturnType<typeof vi.fn>
  } = {},
) {
  const replacePlugin = options.replacePlugin ?? vi.fn().mockResolvedValue(REPLACE_RESULT)
  const engine = {
    loadPlugin,
    replacePlugin,
    pluginNoteOn: vi.fn().mockResolvedValue(undefined),
    pluginNoteOff: vi.fn().mockResolvedValue(undefined),
    savePluginState: vi.fn().mockResolvedValue({ path: '/saved/old.state', bytesWritten: 12 }),
    closePluginUi: options.closePluginUi ?? vi.fn().mockResolvedValue('safepoint-completed'),
    openPluginUi: options.openPluginUi ?? vi.fn().mockResolvedValue(undefined),
    ...(active === undefined ? {} : { isPluginActive: vi.fn(() => active) }),
    boot: vi.fn(),
    quit: vi.fn(),
    isRunning: true,
  } as any
  const global = new Global(engine)
  if (options.documentDirectory !== false) {
    global.setDocumentDirectory(options.documentDirectory ?? '/songs/session')
  }
  return { global, loadPlugin, replacePlugin, engine }
}

function instrumentChain(global: Global, sequenceName = 'kick') {
  return (global as any).pluginInstrumentManager.chainFor(sequenceName) as Array<{
    resolvedPath: string
    pluginId?: string
    normalizedName: string
    statePath?: string
  }>
}

function mockStateSave() {
  return vi.spyOn(ProjectStateStore.prototype, 'save').mockResolvedValue({
    path: '/songs/session/states/old.state',
    bytesWritten: 12,
    identity: {
      receiver: 'kick',
      role: 'instrument',
      normalizedName: 'synth',
      occurrence: 0,
    },
    identityKey: 'kick/instrument/synth/0',
    projectFile: '/songs/session/project.yaml',
    projectStatePath: 'states/old.state',
  })
}

afterEach(() => vi.restoreAllMocks())

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

  it('T1 replaces a different spec exactly once without issuing another load and commits the new chain entry', async () => {
    const save = mockStateSave()
    const { global, loadPlugin, replacePlugin } = makeGlobal()
    await global.instrument('kick', 'synth.clap', 'one')
    loadPlugin.mockClear()

    await expect(global.instrument('kick', 'other.vst3', 'two')).resolves.toBe(global)

    expect(loadPlugin).toHaveBeenCalledTimes(0)
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'other.vst3'),
      'two',
      'instrument',
      undefined,
      'plugin:kick',
    )
    expect(save).toHaveBeenCalledTimes(1)
    expect(instrumentChain(global)).toMatchObject([
      {
        resolvedPath: path.resolve('/songs/session', 'other.vst3'),
        pluginId: 'two',
        normalizedName: 'other',
      },
    ])
  })

  it('T2 closes an open UI, saves the old identity once, then replaces in that order', async () => {
    const save = mockStateSave()
    const closePluginUi = vi.fn().mockResolvedValue('safepoint-completed')
    const openPluginUi = vi.fn().mockResolvedValue(undefined)
    const { global, replacePlugin } = makeGlobal(vi.fn().mockResolvedValue({}), undefined, {
      closePluginUi,
      openPluginUi,
    })
    global.registerSequence('kick', global.seq)
    await global.instrument('kick', 'synth.clap', 'old-id')
    await global.openPluginUi('kick', 0)
    closePluginUi.mockClear()
    save.mockClear()
    replacePlugin.mockClear()

    await global.instrument('kick', 'other.vst3', 'new-id')

    expect(closePluginUi).toHaveBeenCalledTimes(1)
    expect(closePluginUi).toHaveBeenCalledWith({ role: 'instrument', instance: 'plugin:kick' }, 0)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      {
        receiver: 'kick',
        role: 'instrument',
        normalizedName: 'synth',
        occurrence: 0,
      },
      { role: 'instrument', instance: 'plugin:kick' },
    )
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'other.vst3'),
      'new-id',
      'instrument',
      undefined,
      'plugin:kick',
    )
    expect(closePluginUi.mock.invocationCallOrder[0]).toBeLessThan(
      save.mock.invocationCallOrder[0]!,
    )
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      replacePlugin.mock.invocationCallOrder[0]!,
    )
  })

  it('forgets an uncertain UI session so a failed replacement can retry opening it', async () => {
    mockStateSave()
    const closeFailure = new Error('CLOSE_UI transport disconnected')
    const closePluginUi = vi.fn().mockRejectedValue(closeFailure)
    const openPluginUi = vi.fn().mockResolvedValue(undefined)
    const { global, replacePlugin } = makeGlobal(vi.fn().mockResolvedValue({}), undefined, {
      closePluginUi,
      openPluginUi,
    })
    const sequence = global.seq.setName('kick')
    await global.instrument('kick', 'synth.clap', 'old-id')
    await sequence.ui()
    openPluginUi.mockClear()

    await expect(global.instrument('kick', 'other.vst3', 'new-id')).rejects.toThrow(
      'CLOSE_UI transport disconnected',
    )

    expect(replacePlugin).toHaveBeenCalledTimes(0)
    expect(global.hasOpenPluginUi('kick', 0)).toBe(false)
    await sequence.ui()
    expect(openPluginUi).toHaveBeenCalledTimes(1)
    expect(openPluginUi).toHaveBeenCalledWith(
      { role: 'instrument', instance: 'plugin:kick' },
      0,
      'OrbitScore — synth (kick:0)',
    )
    expect(global.hasOpenPluginUi('kick', 0)).toBe(true)
  })

  it('T3 aborts replacement and keeps the old chain when automatic state saving fails', async () => {
    const failure = new Error('state mailbox failed')
    const save = vi.spyOn(ProjectStateStore.prototype, 'save').mockRejectedValue(failure)
    const { global, replacePlugin } = makeGlobal()
    await global.instrument('kick', 'synth.clap', 'one')
    await expect(global.instrument('kick', 'other.clap', 'two')).rejects.toBe(failure)
    expect(save).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledTimes(0)
    expect(instrumentChain(global)).toMatchObject([
      { resolvedPath: path.resolve('/songs/session', 'synth.clap'), pluginId: 'one' },
    ])
  })

  it('T4 warns and continues replacement without saving when no document directory is set', async () => {
    const save = mockStateSave()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { global, replacePlugin } = makeGlobal(vi.fn().mockResolvedValue({}), undefined, {
      documentDirectory: false,
    })
    await global.instrument('kick', '/plugins/synth.clap', 'one')

    await expect(global.instrument('kick', '/plugins/other.vst3', 'two')).resolves.toBe(global)

    expect(save).toHaveBeenCalledTimes(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('document directory is not set'))
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith(
      '/plugins/other.vst3',
      'two',
      'instrument',
      undefined,
      'plugin:kick',
    )
  })

  it('T5 keeps the old chain when ReplacePlugin definitively rejects the request', async () => {
    mockStateSave()
    const rejection = new DaemonProtocolError('OUTPROC_ATTACH_FAILED', 'prepare failed')
    const replacePlugin = vi.fn().mockRejectedValue(rejection)
    const { global } = makeGlobal(vi.fn().mockResolvedValue({}), undefined, { replacePlugin })
    await global.instrument('kick', 'synth.clap', 'one')

    await expect(global.instrument('kick', 'other.vst3', 'two')).rejects.toBe(rejection)

    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(instrumentChain(global)).toMatchObject([
      { resolvedPath: path.resolve('/songs/session', 'synth.clap'), pluginId: 'one' },
    ])
  })

  it('T6 keeps identical declarations idempotent without saving or replacing', async () => {
    const save = mockStateSave()
    const { global, loadPlugin, replacePlugin } = makeGlobal()
    await global.instrument('kick', 'synth.clap', 'one')
    await global.instrument('kick', './synth.clap', 'one')

    expect(loadPlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledTimes(0)
    expect(save).toHaveBeenCalledTimes(0)
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

  it('resolves a relative state path against the document directory and passes it to the engine (#540 P2)', async () => {
    const { global, loadPlugin } = makeGlobal()
    await global.instrument('kick', 'synth.vst3', undefined, 'sounds/kick.vstpreset')
    expect(loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'synth.vst3'),
      undefined,
      'instrument',
      undefined,
      'plugin:kick',
      path.resolve('/songs/session', 'sounds/kick.vstpreset'),
    )
  })

  it('passes an absolute state path through unchanged (#540 P2)', async () => {
    const { global, loadPlugin } = makeGlobal()
    await global.instrument('kick', 'synth.vst3', undefined, '/presets/kick.vstpreset')
    expect(loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'synth.vst3'),
      undefined,
      'instrument',
      undefined,
      'plugin:kick',
      '/presets/kick.vstpreset',
    )
  })

  it('rejects a relative state path when no document directory is set (#540 P2)', async () => {
    // 回帰ピン: getDocumentDirectory() は未設定時 undefined でなく空文字列を返す。
    // 旧実装の `=== undefined` ガードは死んでいて cwd 相対に silent フォールバックしていた
    // （/simplify reuse レビュー検出の実バグ）。明示エラーになること・ロードに進まないこと。
    const loadPlugin = vi.fn().mockResolvedValue({})
    const engine = { loadPlugin, boot: vi.fn(), quit: vi.fn(), isRunning: true } as any
    const global = new Global(engine) // setDocumentDirectory を意図的に呼ばない
    await expect(
      global.instrument('kick', '/plugins/synth.vst3', undefined, 'kick.vstpreset'),
    ).rejects.toThrow('no document directory is set')
    expect(loadPlugin).not.toHaveBeenCalled()
  })

  it('replaces the same plugin when its explicitly declared state changes (#618)', async () => {
    mockStateSave()
    const { global, loadPlugin, replacePlugin } = makeGlobal()
    await global.instrument('kick', 'synth.vst3', undefined, 'a.vstpreset')
    // 同一 state の再宣言は冪等（ロードは 1 回のまま）。
    await global.instrument('kick', 'synth.vst3', undefined, 'a.vstpreset')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
    await expect(global.instrument('kick', 'synth.vst3', undefined, 'b.vstpreset')).resolves.toBe(
      global,
    )
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'synth.vst3'),
      undefined,
      'instrument',
      undefined,
      'plugin:kick',
      path.resolve('/songs/session', 'b.vstpreset'),
    )
    expect(loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('T7 restores the new plugin fallback state from project.yaml during replacement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitscore-replace-state-'))
    const statePath = path.join(root, 'states/new.state')
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, 'new-state')
    fs.writeFileSync(
      path.join(root, 'project.yaml'),
      ['version: 1', 'states:', '  kick/instrument/other/0: states/new.state', ''].join('\n'),
    )
    const save = mockStateSave()
    const { global, replacePlugin } = makeGlobal(vi.fn().mockResolvedValue({}), undefined, {
      documentDirectory: root,
    })
    try {
      await global.instrument('kick', 'synth.clap', 'one')
      save.mockClear()
      await global.instrument('kick', 'other.vst3', 'two')

      expect(save).toHaveBeenCalledTimes(1)
      expect(replacePlugin).toHaveBeenCalledTimes(1)
      expect(replacePlugin).toHaveBeenCalledWith(
        path.join(root, 'other.vst3'),
        'two',
        'instrument',
        undefined,
        'plugin:kick',
        statePath,
      )
      expect(instrumentChain(global)[0]?.statePath).toBe(statePath)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('T9 serializes replacement bursts for the same sequence and commits the last spec', async () => {
    const save = mockStateSave()
    let concurrent = 0
    let maxConcurrent = 0
    const releases: Array<() => void> = []
    const replacePlugin = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          concurrent += 1
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          releases.push(() => {
            concurrent -= 1
            resolve(REPLACE_RESULT)
          })
        }),
    )
    const { global } = makeGlobal(vi.fn().mockResolvedValue({}), undefined, { replacePlugin })
    await global.instrument('kick', 'a.clap', 'a')

    const toB = global.instrument('kick', 'b.clap', 'b')
    const toC = global.instrument('kick', 'c.vst3', 'c')
    await vi.waitFor(() => expect(replacePlugin).toHaveBeenCalledTimes(1))
    expect(replacePlugin).toHaveBeenNthCalledWith(
      1,
      path.resolve('/songs/session', 'b.clap'),
      'b',
      'instrument',
      undefined,
      'plugin:kick',
    )
    releases.shift()!()
    await vi.waitFor(() => expect(replacePlugin).toHaveBeenCalledTimes(2))
    expect(replacePlugin).toHaveBeenNthCalledWith(
      2,
      path.resolve('/songs/session', 'c.vst3'),
      'c',
      'instrument',
      undefined,
      'plugin:kick',
    )
    releases.shift()!()
    await Promise.all([toB, toC])

    expect(maxConcurrent).toBe(1)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      replacePlugin.mock.invocationCallOrder[0]!,
    )
    expect(save.mock.invocationCallOrder[1]).toBeLessThan(
      replacePlugin.mock.invocationCallOrder[1]!,
    )
    expect(instrumentChain(global)).toMatchObject([
      { resolvedPath: path.resolve('/songs/session', 'c.vst3'), pluginId: 'c' },
    ])
  })

  it('retries an ambiguous transport failure with ReplacePlugin ensure instead of LoadPlugin', async () => {
    const save = mockStateSave()
    const transportFailure = new Error('socket closed after send')
    const replacePlugin = vi
      .fn()
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce(REPLACE_RESULT)
    const { global, loadPlugin } = makeGlobal(vi.fn().mockResolvedValue({}), undefined, {
      replacePlugin,
    })
    await global.instrument('kick', 'old.clap', 'old')
    loadPlugin.mockClear()

    await expect(global.instrument('kick', 'new.vst3', 'new')).rejects.toBe(transportFailure)
    expect(instrumentChain(global)).toEqual([])
    await expect(global.instrument('kick', 'new.vst3', 'new')).resolves.toBe(global)

    expect(save).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledTimes(2)
    expect(replacePlugin).toHaveBeenNthCalledWith(
      2,
      path.resolve('/songs/session', 'new.vst3'),
      'new',
      'instrument',
      undefined,
      'plugin:kick',
    )
    expect(loadPlugin).toHaveBeenCalledTimes(0)
  })

  it('surfaces a quarantined old slot as a visible warning after successful replacement', async () => {
    mockStateSave()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const replacePlugin = vi.fn().mockResolvedValue({ ...REPLACE_RESULT, quarantinedSlot: true })
    const { global } = makeGlobal(vi.fn().mockResolvedValue({}), undefined, { replacePlugin })
    await global.instrument('kick', 'old.clap')
    await global.instrument('kick', 'new.vst3')

    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quarantined'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Sequence 'kick'"))
  })

  it('T11 keeps replacement disabled for master, sequence, and mixer effect managers', async () => {
    const { global, replacePlugin } = makeGlobal()
    await global.effect('master-a.clap')
    await expect(global.effect('master-b.clap')).rejects.toBeInstanceOf(EffectSlotLimitError)

    await global.sequenceEffect('kick', 'sequence-a.clap')
    await expect(global.sequenceEffect('kick', 'sequence-b.clap')).rejects.toBeInstanceOf(
      EffectSlotLimitError,
    )

    await global.sum('drums').effect('mixer-a.clap')
    await expect(global.sum('drums').effect('mixer-b.clap')).rejects.toBeInstanceOf(
      EffectSlotLimitError,
    )

    expect(replacePlugin).toHaveBeenCalledTimes(0)
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
