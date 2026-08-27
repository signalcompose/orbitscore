import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DaemonProtocolError } from '../../packages/engine/src/audio/rust-engine/errors'
import { RustEnginePlayer } from '../../packages/engine/src/audio/rust-engine/rust-engine-player'
import { Global } from '../../packages/engine/src/core/global'
import { ProjectStateStore } from '../../packages/engine/src/core/project-state-store'

const REPLACE_RESULT = {
  pluginId: 'replacement-id',
  pluginName: 'Replacement',
  notePortIndex: 0,
  quarantinedSlot: false,
}

function makeGlobal(
  options: {
    documentDirectory?: string | false
    loadPlugin?: ReturnType<typeof vi.fn>
    replacePlugin?: ReturnType<typeof vi.fn>
    unloadPlugin?: ReturnType<typeof vi.fn>
    closePluginUi?: ReturnType<typeof vi.fn>
    openPluginUi?: ReturnType<typeof vi.fn>
  } = {},
) {
  const loadPlugin = options.loadPlugin ?? vi.fn().mockResolvedValue({})
  const replacePlugin = options.replacePlugin ?? vi.fn().mockResolvedValue(REPLACE_RESULT)
  const unloadPlugin =
    options.unloadPlugin ?? vi.fn().mockResolvedValue({ status: 'unloaded' as const })
  const closePluginUi = options.closePluginUi ?? vi.fn().mockResolvedValue('safepoint-completed')
  const openPluginUi = options.openPluginUi ?? vi.fn().mockResolvedValue(undefined)
  const engine = {
    loadPlugin,
    replacePlugin,
    unloadPlugin,
    savePluginState: vi.fn().mockResolvedValue({
      path: '/songs/session/states/old.state',
      bytesWritten: 12,
    }),
    closePluginUi,
    openPluginUi,
    boot: vi.fn(),
    quit: vi.fn(),
    isRunning: true,
  } as any
  const global = new Global(engine)
  if (options.documentDirectory !== false) {
    global.setDocumentDirectory(options.documentDirectory ?? '/songs/session')
  }
  return {
    global,
    engine,
    loadPlugin,
    replacePlugin,
    unloadPlugin,
    closePluginUi,
    openPluginUi,
  }
}

function mockStateSave() {
  return vi
    .spyOn(ProjectStateStore.prototype, 'save')
    .mockImplementation(async (identity, daemonTarget) => ({
      path: '/songs/session/states/old.state',
      bytesWritten: 12,
      identity,
      identityKey: [
        identity.receiver,
        identity.role,
        identity.normalizedName,
        identity.occurrence,
      ].join('/'),
      projectFile: '/songs/session/project.yaml',
      projectStatePath: 'states/old.state',
      daemonTarget,
    }))
}

function masterChain(global: Global) {
  return (global as any).pluginEffectManager.chain() as Array<{
    normalizedName: string
    resolvedPath: string
    pluginId?: string
  }>
}

afterEach(() => vi.restoreAllMocks())

describe('effect plugin replacement (#625 Stage B)', () => {
  it('R2 uses ReplacePlugin with the resolved effect target and never LoadPlugin for a different spec', async () => {
    mockStateSave()
    const { global, loadPlugin, replacePlugin } = makeGlobal()
    await global.effect('old.clap', 'old-id')
    loadPlugin.mockClear()

    await expect(global.effect('new.vst3', 'new-id')).resolves.toBe(global)

    expect(loadPlugin).toHaveBeenCalledTimes(0)
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'new.vst3'),
      'new-id',
      'effect',
    )
    expect(masterChain(global)).toMatchObject([
      {
        normalizedName: 'new',
        resolvedPath: path.resolve('/songs/session', 'new.vst3'),
        pluginId: 'new-id',
      },
    ])
  })

  it('R6 keeps an identical effect declaration idempotent without replacing', async () => {
    const save = mockStateSave()
    const { global, loadPlugin, replacePlugin } = makeGlobal()
    await global.effect('same.clap', 'same-id')
    loadPlugin.mockClear()

    await expect(global.effect('./same.clap', 'same-id')).resolves.toBe(global)

    expect(loadPlugin).toHaveBeenCalledTimes(0)
    expect(replacePlugin).toHaveBeenCalledTimes(0)
    expect(save).toHaveBeenCalledTimes(0)
  })

  it.each([
    ['the same spec', 'new.vst3', 'new-id'],
    ['a different spec', 'third.clap', 'third-id'],
  ])(
    'R9 forgets a protocol-rejected effect and ensures %s with ReplacePlugin',
    async (_case, retrySpec, retryId) => {
      mockStateSave()
      const rejection = new DaemonProtocolError(
        'OUTPROC_ATTACH_FAILED',
        'replacement attach failed after teardown',
      )
      const replacePlugin = vi
        .fn()
        .mockRejectedValueOnce(rejection)
        .mockResolvedValueOnce(REPLACE_RESULT)
      const { global, loadPlugin } = makeGlobal({ replacePlugin })
      await global.effect('old.clap', 'old-id')
      loadPlugin.mockClear()

      await expect(global.effect('new.vst3', 'new-id')).rejects.toBe(rejection)
      expect(masterChain(global)).toEqual([])
      await expect(global.effect(retrySpec, retryId)).resolves.toBe(global)

      expect(loadPlugin).toHaveBeenCalledTimes(0)
      expect(replacePlugin).toHaveBeenCalledTimes(2)
      expect(replacePlugin).toHaveBeenNthCalledWith(
        1,
        path.resolve('/songs/session', 'new.vst3'),
        'new-id',
        'effect',
      )
      expect(replacePlugin).toHaveBeenNthCalledWith(
        2,
        path.resolve('/songs/session', retrySpec),
        retryId,
        'effect',
      )
    },
  )

  it('R10 removes a protocol-rejected effect from both respawn ledgers', async () => {
    const player = new RustEnginePlayer()
    const rejection = new DaemonProtocolError(
      'OUTPROC_ATTACH_FAILED',
      'replacement attach failed after teardown',
    )
    const daemon = {
      loadPlugin: vi.fn().mockResolvedValue({
        pluginId: 'old-id',
        pluginName: 'Old',
        notePortIndex: 0,
      }),
      replacePlugin: vi.fn().mockRejectedValue(rejection),
    }
    Object.defineProperty(player, 'daemon', { value: daemon })
    await player.loadPlugin('/plugins/old.clap', 'old-id', 'effect', 'seq-bus-0')
    daemon.loadPlugin.mockClear()

    await expect(
      player.replacePlugin('/plugins/new.vst3', 'new-id', 'effect', 'seq-bus-0'),
    ).rejects.toBe(rejection)

    expect(daemon.replacePlugin).toHaveBeenCalledTimes(1)
    expect(daemon.replacePlugin).toHaveBeenCalledWith(
      '/plugins/new.vst3',
      'new-id',
      'effect',
      'seq-bus-0',
      undefined,
      undefined,
    )
    expect((player as any).loadedPlugins.has('effect:seq-bus-0')).toBe(false)
    expect((player as any).pluginActiveByKey.has('effect:seq-bus-0')).toBe(false)

    await (player as any).reloadPluginsAfterRespawn()
    expect(daemon.loadPlugin).toHaveBeenCalledTimes(0)
  })

  it('R11 keeps the master LinkAudio exclusion gate closed after replacement failure', async () => {
    mockStateSave()
    const rejection = new DaemonProtocolError(
      'OUTPROC_ATTACH_FAILED',
      'replacement attach failed after teardown',
    )
    const { global, replacePlugin } = makeGlobal({
      replacePlugin: vi.fn().mockRejectedValue(rejection),
    })
    await global.effect('old.clap')

    await expect(global.effect('new.vst3')).rejects.toBe(rejection)
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'new.vst3'),
      undefined,
      'effect',
    )
    expect(() => global.linkAudio()).toThrow(
      'global.linkAudio() cannot be used after plugin hosting has been declared in v1.',
    )
  })

  it('R12 saves the old effect identity before issuing replacement', async () => {
    const save = mockStateSave()
    const { global, replacePlugin } = makeGlobal()
    await global.effect('old.clap', 'old-id')

    await global.effect('new.vst3', 'new-id')

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      {
        receiver: 'master',
        role: 'effect',
        normalizedName: 'old',
        occurrence: 0,
      },
      { role: 'effect' },
    )
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'new.vst3'),
      'new-id',
      'effect',
    )
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      replacePlugin.mock.invocationCallOrder[0]!,
    )
  })

  it('R13 aborts replacement and retains the old effect when automatic save fails', async () => {
    const saveFailure = new Error('state save failed')
    const save = vi.spyOn(ProjectStateStore.prototype, 'save').mockRejectedValue(saveFailure)
    const { global, replacePlugin } = makeGlobal()
    await global.effect('old.clap', 'old-id')

    await expect(global.effect('new.vst3', 'new-id')).rejects.toBe(saveFailure)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      {
        receiver: 'master',
        role: 'effect',
        normalizedName: 'old',
        occurrence: 0,
      },
      { role: 'effect' },
    )
    expect(replacePlugin).toHaveBeenCalledTimes(0)
    expect(masterChain(global)).toMatchObject([
      {
        normalizedName: 'old',
        resolvedPath: path.resolve('/songs/session', 'old.clap'),
        pluginId: 'old-id',
      },
    ])
  })

  it('R14 warns once and continues replacement when the document directory is unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { global, replacePlugin } = makeGlobal({ documentDirectory: false })
    await global.effect('/plugins/old.clap', 'old-id')

    await expect(global.effect('/plugins/new.vst3', 'new-id')).resolves.toBe(global)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('document directory'))
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith('/plugins/new.vst3', 'new-id', 'effect')
  })

  it('R15 closes an open effect UI before saving and replacing', async () => {
    const save = mockStateSave()
    const { global, closePluginUi, replacePlugin } = makeGlobal()
    await global.effect('old.clap', 'old-id')
    await global.openPluginUi('master', 1)

    await global.effect('new.vst3', 'new-id')

    expect(closePluginUi).toHaveBeenCalledTimes(1)
    expect(closePluginUi).toHaveBeenCalledWith({ role: 'effect' }, 1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      {
        receiver: 'master',
        role: 'effect',
        normalizedName: 'old',
        occurrence: 0,
      },
      { role: 'effect' },
    )
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'new.vst3'),
      'new-id',
      'effect',
    )
    expect(closePluginUi.mock.invocationCallOrder[0]).toBeLessThan(
      save.mock.invocationCallOrder[0]!,
    )
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      replacePlugin.mock.invocationCallOrder[0]!,
    )
  })

  it('R16 serializes same-key replacement bursts and commits the last effect', async () => {
    mockStateSave()
    let concurrent = 0
    let maxConcurrent = 0
    const releases: Array<() => void> = []
    const replacePlugin = vi.fn().mockImplementation(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise<void>((resolve) => releases.push(resolve))
      concurrent -= 1
      return REPLACE_RESULT
    })
    const { global } = makeGlobal({ replacePlugin })
    await global.effect('old.clap', 'old-id')

    const toB = global.effect('b.vst3', 'b-id')
    const toC = global.effect('c.clap', 'c-id')
    await vi.waitFor(() => expect(replacePlugin).toHaveBeenCalledTimes(1))
    expect(replacePlugin).toHaveBeenNthCalledWith(
      1,
      path.resolve('/songs/session', 'b.vst3'),
      'b-id',
      'effect',
    )
    releases.shift()!()
    await vi.waitFor(() => expect(replacePlugin).toHaveBeenCalledTimes(2))
    expect(replacePlugin).toHaveBeenNthCalledWith(
      2,
      path.resolve('/songs/session', 'c.clap'),
      'c-id',
      'effect',
    )
    releases.shift()!()
    await Promise.all([toB, toC])

    expect(maxConcurrent).toBe(1)
    expect(masterChain(global)).toMatchObject([
      {
        normalizedName: 'c',
        resolvedPath: path.resolve('/songs/session', 'c.clap'),
        pluginId: 'c-id',
      },
    ])
  })

  it('R17 retries an ambiguous effect transport failure with ReplacePlugin ensure', async () => {
    mockStateSave()
    const transportFailure = new Error('socket closed after ReplacePlugin was sent')
    const replacePlugin = vi
      .fn()
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce(REPLACE_RESULT)
    const { global, loadPlugin } = makeGlobal({ replacePlugin })
    await global.effect('old.clap', 'old-id')
    loadPlugin.mockClear()

    await expect(global.effect('new.vst3', 'new-id')).rejects.toBe(transportFailure)
    expect(masterChain(global)).toEqual([])
    await expect(global.effect('new.vst3', 'new-id')).resolves.toBe(global)

    expect(loadPlugin).toHaveBeenCalledTimes(0)
    expect(replacePlugin).toHaveBeenCalledTimes(2)
    expect(replacePlugin).toHaveBeenNthCalledWith(
      1,
      path.resolve('/songs/session', 'new.vst3'),
      'new-id',
      'effect',
    )
    expect(replacePlugin).toHaveBeenNthCalledWith(
      2,
      path.resolve('/songs/session', 'new.vst3'),
      'new-id',
      'effect',
    )
  })

  it('I-1 retries forgotten-slot cleanup best-effort before recovery replacement', async () => {
    const save = mockStateSave()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const quiesceTimeout = new DaemonProtocolError(
      'OUTPROC_EFFECT_RUNTIME',
      'effect replacement quiesce ack timed out; the previous effect is kept',
    )
    const replacePlugin = vi
      .fn()
      .mockRejectedValueOnce(quiesceTimeout)
      .mockResolvedValueOnce(REPLACE_RESULT)
    const { global } = makeGlobal({ replacePlugin })
    await global.effect('old.clap', 'old-id')

    await expect(global.effect('new.vst3', 'new-id')).rejects.toBe(quiesceTimeout)
    expect(masterChain(global)).toEqual([])
    const recoverySaveFailure = new Error('old effect is already unavailable')
    save.mockRejectedValueOnce(recoverySaveFailure)

    await expect(global.effect('new.vst3', 'new-id')).resolves.toBe(global)

    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(
      2,
      { receiver: 'master', role: 'effect', normalizedName: 'old', occurrence: 0 },
      { role: 'effect' },
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Best-effort cleanup of the uncertain old effect'),
    )
    expect(replacePlugin).toHaveBeenCalledTimes(2)
    expect(masterChain(global)).toMatchObject([{ normalizedName: 'new' }])
  })

  it('I-2 keeps the master LinkAudio exclusion sticky after remove succeeds', async () => {
    mockStateSave()
    const { global } = makeGlobal()
    await global.effect('old.clap', 'old-id')

    await global.remove('old')

    expect(masterChain(global)).toEqual([])
    expect(() => global.linkAudio()).toThrow(
      'global.linkAudio() cannot be used after plugin hosting has been declared in v1.',
    )
  })

  // 🔴 以下2件は main の変異検証が見つけた穴を塞ぐ（2026-08-27）。I-1 の修正本体は
  // 「差し替えでの1回の復旧」しか固定しておらず、次の2つの壊し方が全件 green のまま
  // 生き残った:
  //   (a) `remove()` が忘れられた slot を無視するようにする
  //   (b) 復旧の catch の `existing ?? forgottenSlot` を `existing` に落とす
  // どちらも「保存されるはずの音色が黙って失われる」= I-1 と同じ故障クラスである。

  it('I-1b removes a forgotten slot: it still validates the name and saves the old state', async () => {
    const save = mockStateSave()
    const quiesceTimeout = new DaemonProtocolError(
      'OUTPROC_EFFECT_RUNTIME',
      'effect replacement quiesce ack timed out; the previous effect is kept',
    )
    const replacePlugin = vi.fn().mockRejectedValueOnce(quiesceTimeout)
    const { global, unloadPlugin } = makeGlobal({ replacePlugin })
    await global.effect('old.clap', 'old-id')

    await expect(global.effect('new.vst3', 'new-id')).rejects.toBe(quiesceTimeout)
    expect(masterChain(global)).toEqual([])
    save.mockClear()

    // 登記を忘れていても、消す対象の名前は依然として検証される。
    await expect(global.remove('not-the-old-one')).rejects.toThrow(
      `remove("not-the-old-one") does not match the declared insert 'old'.`,
    )
    expect(save).toHaveBeenCalledTimes(0)
    expect(unloadPlugin).toHaveBeenCalledTimes(0)

    await expect(global.remove('old')).resolves.toBe(global)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      { receiver: 'master', role: 'effect', normalizedName: 'old', occurrence: 0 },
      { role: 'effect' },
    )
    expect(unloadPlugin).toHaveBeenCalledTimes(1)
    expect(unloadPlugin).toHaveBeenCalledWith('effect', undefined)
  })

  it('I-1c keeps the forgotten slot across a second consecutive failure', async () => {
    const save = mockStateSave()
    const quiesceTimeout = new DaemonProtocolError(
      'OUTPROC_EFFECT_RUNTIME',
      'effect replacement quiesce ack timed out; the previous effect is kept',
    )
    const replacePlugin = vi
      .fn()
      .mockRejectedValueOnce(quiesceTimeout)
      .mockRejectedValueOnce(quiesceTimeout)
      .mockResolvedValueOnce(REPLACE_RESULT)
    const { global } = makeGlobal({ replacePlugin })
    await global.effect('old.clap', 'old-id')

    await expect(global.effect('new.vst3', 'new-id')).rejects.toBe(quiesceTimeout)
    await expect(global.effect('newer.vst3', 'newer-id')).rejects.toBe(quiesceTimeout)

    await expect(global.effect('newest.vst3', 'newest-id')).resolves.toBe(global)

    // 2回目の失敗で旧 slot を落とすと、この3回目の保存が起きない。
    expect(save).toHaveBeenCalledTimes(3)
    expect(save).toHaveBeenNthCalledWith(
      3,
      { receiver: 'master', role: 'effect', normalizedName: 'old', occurrence: 0 },
      { role: 'effect' },
    )
    expect(masterChain(global)).toMatchObject([{ normalizedName: 'newest' }])
  })

  it('R12a saves the master replacement identity and daemon target', async () => {
    const save = mockStateSave()
    const { global } = makeGlobal()
    await global.effect('old.clap', 'old-id')

    await global.effect('new.vst3', 'new-id')

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      {
        receiver: 'master',
        role: 'effect',
        normalizedName: 'old',
        occurrence: 0,
      },
      { role: 'effect' },
    )
  })

  it('R12b saves the sequence replacement identity and daemon target', async () => {
    const save = mockStateSave()
    const { global } = makeGlobal()
    await global.sequenceEffect('kick', 'old.clap', 'old-id')

    await global.sequenceEffect('kick', 'new.vst3', 'new-id')

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      {
        receiver: 'kick',
        role: 'effect',
        normalizedName: 'old',
        occurrence: 0,
      },
      { role: 'effect', bus: 'seq-bus-0' },
    )
  })

  it('R12c saves the sum replacement identity and daemon target', async () => {
    const save = mockStateSave()
    const { global } = makeGlobal()
    const drums = global.sum('drums')
    await drums.effect('old.clap', 'old-id')

    await drums.effect('new.vst3', 'new-id')

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      {
        receiver: 'sum:drums',
        role: 'effect',
        normalizedName: 'old',
        occurrence: 0,
      },
      { role: 'effect', bus: 'sum-bus-0' },
    )
  })

  it('R12d saves the aux replacement identity and daemon target', async () => {
    const save = mockStateSave()
    const { global } = makeGlobal()
    const reverb = global.aux('rev')
    await reverb.effect('old.clap', 'old-id')

    await reverb.effect('new.vst3', 'new-id')

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      {
        receiver: 'aux:rev',
        role: 'effect',
        normalizedName: 'old',
        occurrence: 0,
      },
      { role: 'effect', bus: 'aux-bus-0' },
    )
  })

  it('R19 keeps the sequence bus allocation and declaration bookkeeping after remove', async () => {
    mockStateSave()
    const { global, unloadPlugin } = makeGlobal()
    const bus = await global.sequenceEffect('kick', 'old.clap', 'old-id')

    await global.sequenceEffectRemove('kick', 'old')

    const manager = (global as any).sequenceEffectManager
    expect(unloadPlugin).toHaveBeenCalledTimes(1)
    expect(unloadPlugin).toHaveBeenCalledWith('effect', bus)
    expect(manager.getBus('kick')).toBe(bus)
    expect(manager.hasDeclaration('kick')).toBe(true)
    expect(manager.chainFor('kick')).toEqual([])
  })

  it('R21 rejects a mismatched remove name before unload and retains the declaration', async () => {
    mockStateSave()
    const { global, unloadPlugin } = makeGlobal()
    await global.effect('old.clap', 'old-id')

    await expect(global.remove('wrong')).rejects.toThrow(
      `master: remove("wrong") does not match the declared insert 'old'.`,
    )

    expect(unloadPlugin).toHaveBeenCalledTimes(0)
    expect(masterChain(global)).toMatchObject([{ normalizedName: 'old' }])
  })

  it('R22a saves the master identity before unloading the master target', async () => {
    const save = mockStateSave()
    const { global, unloadPlugin } = makeGlobal()
    await global.effect('old.clap', 'old-id')

    await global.remove('old')

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      { receiver: 'master', role: 'effect', normalizedName: 'old', occurrence: 0 },
      { role: 'effect' },
    )
    expect(unloadPlugin).toHaveBeenCalledTimes(1)
    expect(unloadPlugin).toHaveBeenCalledWith('effect', undefined)
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(unloadPlugin.mock.invocationCallOrder[0]!)
  })

  it('R22b saves the sequence identity before unloading its daemon bus', async () => {
    const save = mockStateSave()
    const { global, unloadPlugin } = makeGlobal()
    await global.sequenceEffect('kick', 'old.clap', 'old-id')

    await global.sequenceEffectRemove('kick', 'old')

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      { receiver: 'kick', role: 'effect', normalizedName: 'old', occurrence: 0 },
      { role: 'effect', bus: 'seq-bus-0' },
    )
    expect(unloadPlugin).toHaveBeenCalledTimes(1)
    expect(unloadPlugin).toHaveBeenCalledWith('effect', 'seq-bus-0')
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(unloadPlugin.mock.invocationCallOrder[0]!)
  })

  it('R22c saves the sum identity before unloading its daemon bus', async () => {
    const save = mockStateSave()
    const { global, unloadPlugin } = makeGlobal()
    const drums = global.sum('drums')
    await drums.effect('old.clap', 'old-id')

    await drums.remove('old')

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      { receiver: 'sum:drums', role: 'effect', normalizedName: 'old', occurrence: 0 },
      { role: 'effect', bus: 'sum-bus-0' },
    )
    expect(unloadPlugin).toHaveBeenCalledTimes(1)
    expect(unloadPlugin).toHaveBeenCalledWith('effect', 'sum-bus-0')
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(unloadPlugin.mock.invocationCallOrder[0]!)
  })

  it('R22d saves the aux identity before unloading its daemon bus', async () => {
    const save = mockStateSave()
    const { global, unloadPlugin } = makeGlobal()
    const reverb = global.aux('rev')
    await reverb.effect('old.clap', 'old-id')

    await reverb.remove('old')

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      { receiver: 'aux:rev', role: 'effect', normalizedName: 'old', occurrence: 0 },
      { role: 'effect', bus: 'aux-bus-0' },
    )
    expect(unloadPlugin).toHaveBeenCalledTimes(1)
    expect(unloadPlugin).toHaveBeenCalledWith('effect', 'aux-bus-0')
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(unloadPlugin.mock.invocationCallOrder[0]!)
  })
})
