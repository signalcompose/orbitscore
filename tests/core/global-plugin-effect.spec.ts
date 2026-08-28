import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { ProjectStateStore } from '../../packages/engine/src/core/project-state-store'
import { installEffectChainMock } from '../helpers/effect-chain-mock'

const REPLACE_RESULT = {
  pluginId: 'replacement-id',
  pluginName: 'Replacement',
  notePortIndex: 0,
  quarantinedSlot: false,
}

const temporaryDirectories: string[] = []

function makeGlobal(loadPlugin = vi.fn().mockResolvedValue({})) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-global-effect-'))
  temporaryDirectories.push(directory)
  const replacePlugin = vi.fn().mockResolvedValue(REPLACE_RESULT)
  const engine = {
    loadPlugin,
    replacePlugin,
    boot: vi.fn(),
    quit: vi.fn(),
    isRunning: true,
  } as any
  const applyEffectChain = installEffectChainMock(engine)
  const global = new Global(engine)
  global.setDocumentDirectory(directory)
  return { global, loadPlugin, replacePlugin, applyEffectChain, directory }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Global.effect()', () => {
  it.each(['synth.component'])('rejects reserved format %s', async (spec) => {
    const { global } = makeGlobal()
    await expect(global.effect(spec)).rejects.toThrow('not yet supported')
  })

  // #504: VST3 effects are wired end-to-end (daemon vst3-effect-child) — the old
  // effect=CLAP-only gate is gone, so a .vst3 path now loads as an effect.
  it('accepts a .vst3 path for effect (#504)', async () => {
    const { global, loadPlugin } = makeGlobal()
    await global.effect('synth.vst3')
    expect(loadPlugin).toHaveBeenCalled()
  })

  // Bare names (no `./`-style prefix, no known plugin extension) are now catalog names
  // per #463 C2's PC.2 discriminator — use a path-direct prefix to keep exercising the
  // path-side "unknown extension" validation.
  it.each(['./effect.wav', './effect'])('rejects unknown extension %s', async (spec) => {
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
    const { global, loadPlugin, directory } = makeGlobal()
    await expect(global.effect('./echo.clap', 'echo-id')).resolves.toBe(global)
    await global.effect('./echo.clap', 'echo-id')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
    expect(loadPlugin).toHaveBeenCalledWith(
      path.resolve(directory, 'echo.clap'),
      'echo-id',
      'effect',
    )
  })

  it('treats different spec spellings that resolve to the same path as idempotent', async () => {
    // Regression guard: the idempotent cache-hit compares `resolvedPath`, not the raw
    // spec string, so a spelling change alone (leading `./` vs bare name) must not
    // trigger a second load.
    const { global, loadPlugin } = makeGlobal()
    await global.effect('./echo.clap', 'echo-id')
    await global.effect('echo.clap', 'echo-id')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('replaces a second effect with a different path without issuing another load', async () => {
    vi.spyOn(ProjectStateStore.prototype, 'save').mockResolvedValue({} as any)
    const { global, loadPlugin, replacePlugin, directory } = makeGlobal()
    await global.effect('echo.clap')

    await expect(global.effect('reverb.clap')).resolves.toBe(global)

    expect(loadPlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith(
      path.resolve(directory, 'reverb.clap'),
      undefined,
      'effect',
    )
  })

  it('replaces the same path with a different plugin id without issuing another load', async () => {
    vi.spyOn(ProjectStateStore.prototype, 'save').mockResolvedValue({} as any)
    const { global, loadPlugin, replacePlugin, directory } = makeGlobal()
    await global.effect('bundle.clap', 'first-id')

    await expect(global.effect('bundle.clap', 'second-id')).resolves.toBe(global)

    expect(loadPlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledTimes(1)
    expect(replacePlugin).toHaveBeenCalledWith(
      path.resolve(directory, 'bundle.clap'),
      'second-id',
      'effect',
      undefined,
      undefined,
      expect.stringMatching(/\/states\/.*\.state$/),
    )
  })

  it('rejects a backend without plugin hosting support', async () => {
    const engine = { boot: vi.fn(), quit: vi.fn(), isRunning: true } as any
    const global = new Global(engine)
    global.setDocumentDirectory('/songs/session')
    await expect(global.effect('echo.clap')).rejects.toThrow(
      'Effect rack hosting requires the Rust engine backend',
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

  it('rejects with a LinkAudio error, not a resolve error, when no document context is set', async () => {
    // C2 regression: a relative spec with no documentDirectory/audioPath makes
    // resolvePluginPath throw "cannot resolve"; the LinkAudio gate must run
    // before resolution so this scenario surfaces the more relevant LinkAudio
    // conflict instead of a confusing resolve failure.
    const engine = {
      loadPlugin: vi.fn().mockResolvedValue({}),
      boot: vi.fn(),
      quit: vi.fn(),
      isRunning: true,
    } as any
    const global = new Global(engine)
    global.linkAudio()
    await expect(global.effect('rel.clap')).rejects.toThrow('LinkAudio')
  })

  it('re-evaluates an identical rack through ApplyEffectChain without reloading it', async () => {
    const { global, loadPlugin, applyEffectChain } = makeGlobal()
    await global.effect('./echo.clap', 'echo-id')
    await global.effect('./echo.clap', 'echo-id')
    expect(applyEffectChain).toHaveBeenCalledTimes(2)
    expect(loadPlugin).toHaveBeenCalledTimes(1)
  })
})
