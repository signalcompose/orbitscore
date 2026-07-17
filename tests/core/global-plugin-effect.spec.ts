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
    const { global, loadPlugin } = makeGlobal()
    await expect(global.effect('./echo.clap', 'echo-id')).resolves.toBe(global)
    await global.effect('./echo.clap', 'echo-id')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
    expect(loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'echo.clap'),
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

  describe('self-heal after a stale idempotent cache', () => {
    function makeSelfHealingGlobal(loadPlugin: ReturnType<typeof vi.fn>, isPluginActive: boolean) {
      const engine = {
        loadPlugin,
        isPluginActive: vi.fn().mockReturnValue(isPluginActive),
        boot: vi.fn(),
        quit: vi.fn(),
        isRunning: true,
      } as any
      const global = new Global(engine)
      global.setDocumentDirectory('/songs/session')
      return global
    }

    it('re-issues the load when the engine reports the plugin inactive', async () => {
      const loadPlugin = vi.fn().mockResolvedValue({})
      const global = makeSelfHealingGlobal(loadPlugin, false)

      await global.effect('./echo.clap', 'echo-id')
      await expect(global.effect('./echo.clap', 'echo-id')).resolves.toBe(global)

      expect(loadPlugin).toHaveBeenCalledTimes(2)
      expect(loadPlugin).toHaveBeenNthCalledWith(
        2,
        path.resolve('/songs/session', 'echo.clap'),
        'echo-id',
        'effect',
      )
    })

    it('throws and clears the declaration when the re-issue itself fails, permitting a further retry', async () => {
      const failure = new Error('daemon rejected the reissue')
      const loadPlugin = vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({})
      const global = makeSelfHealingGlobal(loadPlugin, false)

      await global.effect('echo.clap', 'echo-id')
      await expect(global.effect('echo.clap', 'echo-id')).rejects.toBe(failure)
      // Declaration was cleared on failure, so a further call retries the load
      // (same semantics as an initial-load failure) rather than being treated
      // as a "different declaration" conflict.
      await expect(global.effect('echo.clap', 'echo-id')).resolves.toBe(global)
      expect(loadPlugin).toHaveBeenCalledTimes(3)
    })

    it('stays a no-op idempotent cache hit when isPluginActive is undefined (back-compat)', async () => {
      // Covered structurally by the existing "eagerly loads once..." test above
      // (its mock engine has no isPluginActive), asserted again here to make the
      // back-compat guarantee explicit for this describe block.
      const { global, loadPlugin } = makeGlobal()
      await global.effect('./echo.clap', 'echo-id')
      await global.effect('./echo.clap', 'echo-id')
      expect(loadPlugin).toHaveBeenCalledTimes(1)
    })
  })
})
