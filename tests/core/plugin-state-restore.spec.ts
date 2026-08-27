import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { stringify } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioManager } from '../../packages/engine/src/core/global/audio-manager'
import { LinkAudioManager } from '../../packages/engine/src/core/global/link-audio-manager'
import { MixerManager } from '../../packages/engine/src/core/global/mixer-manager'
import { PluginEffectManager } from '../../packages/engine/src/core/global/plugin-effect-manager'
import { PluginInstrumentManager } from '../../packages/engine/src/core/global/plugin-instrument-manager'
import { SequenceEffectManager } from '../../packages/engine/src/core/global/sequence-effect-manager'
import { installEffectChainMock } from '../helpers/effect-chain-mock'

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix = 'orbit-plugin-state-restore-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function harness(options: { documentDirectory?: boolean; active?: boolean } = {}) {
  const directory = temporaryDirectory()
  const audio = {
    loadPlugin: vi.fn().mockResolvedValue({}),
    ...(options.active === undefined
      ? {}
      : { isPluginActive: vi.fn().mockReturnValue(options.active) }),
  } as any
  installEffectChainMock(audio)
  const audioManager = new AudioManager(audio)
  if (options.documentDirectory !== false) audioManager.setDocumentDirectory(directory)
  const linkAudioManager = new LinkAudioManager()
  return {
    directory,
    audio,
    instrument: new PluginInstrumentManager(audio, audioManager, linkAudioManager),
    masterEffect: new PluginEffectManager(audio, audioManager, linkAudioManager),
    sequenceEffect: new SequenceEffectManager(audio, audioManager, linkAudioManager),
    mixer: new MixerManager(audio, audioManager, linkAudioManager),
  }
}

function register(
  directory: string,
  entries: Record<string, string>,
  existingStatePaths: readonly string[] = Object.values(entries),
): void {
  for (const relativeStatePath of existingStatePaths) {
    const absoluteStatePath = path.resolve(directory, relativeStatePath)
    fs.mkdirSync(path.dirname(absoluteStatePath), { recursive: true })
    fs.writeFileSync(absoluteStatePath, 'non-default-oracle-state')
  }
  fs.writeFileSync(path.join(directory, 'project.yaml'), stringify({ version: 1, states: entries }))
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('project.yaml plugin state auto-restore (#541)', () => {
  const managerCases = [
    {
      label: 'PluginInstrumentManager.instrument',
      key: 'lead/instrument/Synth/0',
      wrongKey: 'seq:lead/instrument/Synth/0',
      declare: async (h: ReturnType<typeof harness>) =>
        h.instrument.instrument('lead', './Synth.clap'),
      expectedArgs: (directory: string, statePath: string) => [
        path.join(directory, 'Synth.clap'),
        undefined,
        'instrument',
        undefined,
        'plugin:lead',
        statePath,
      ],
    },
    {
      label: 'PluginEffectManager.effect',
      key: 'master/effect/Limiter/0',
      wrongKey: 'seq:master/effect/Limiter/0',
      declare: async (h: ReturnType<typeof harness>) => h.masterEffect.effect('./Limiter.clap'),
      expectedArgs: (directory: string, statePath: string) => [
        path.join(directory, 'Limiter.clap'),
        undefined,
        'effect',
        undefined,
        undefined,
        statePath,
      ],
    },
    {
      label: 'SequenceEffectManager.effect',
      key: 'lead/effect/Echo/0',
      wrongKey: 'seq:lead/effect/Echo/0',
      declare: async (h: ReturnType<typeof harness>) =>
        h.sequenceEffect.effect('lead', './Echo.clap'),
      expectedArgs: (directory: string, statePath: string) => [
        path.join(directory, 'Echo.clap'),
        undefined,
        'effect',
        'seq-bus-0',
        undefined,
        statePath,
      ],
    },
  ]

  it.each(managerCases)(
    'U1 restores registered state through $label',
    async ({ key, declare, expectedArgs }) => {
      const h = harness()
      const relativeStatePath = 'states/non-default.state'
      const absoluteStatePath = path.join(h.directory, 'states', 'non-default.state')
      register(h.directory, { [key]: relativeStatePath })

      await declare(h)

      expect(h.audio.loadPlugin).toHaveBeenCalledWith(
        ...expectedArgs(h.directory, absoluteStatePath),
      )
      expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
      expect(console.log).toHaveBeenCalledWith(
        `[plugin-state] restoring '${key}' from ${absoluteStatePath}`,
      )
      expect(console.log).toHaveBeenCalledTimes(1)
    },
  )

  it('U2 gives an explicitly declared statePath priority over project.yaml registration', async () => {
    const h = harness()
    const registeredStatePath = 'states/registered.state'
    const explicitStatePath = path.join(h.directory, 'explicit.state')
    register(h.directory, { 'lead/instrument/Synth/0': registeredStatePath })
    fs.writeFileSync(explicitStatePath, 'explicit-non-default-state')

    await h.instrument.instrument('lead', './Synth.clap', undefined, explicitStatePath)

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      explicitStatePath,
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledTimes(0)
  })

  it('U3 treats repeated declarations as idempotent using only the declared statePath', async () => {
    const h = harness()
    const relativeStatePath = 'states/registered.state'
    const absoluteStatePath = path.join(h.directory, 'states', 'registered.state')
    register(h.directory, { 'lead/instrument/Synth/0': relativeStatePath })

    await h.instrument.instrument('lead', './Synth.clap')
    await expect(h.instrument.instrument('lead', './Synth.clap')).resolves.toBeUndefined()

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      absoluteStatePath,
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)

    // Live-coding regression case: the first declaration predates project.yaml, then a save
    // registers state before the same source line is evaluated again. Manifest fallback must
    // not be resolved for the already-existing slot.
    const registeredLater = harness()
    await registeredLater.instrument.instrument('lead', './Synth.clap')
    register(registeredLater.directory, {
      'lead/instrument/Synth/0': 'states/registered-later.state',
    })
    await expect(
      registeredLater.instrument.instrument('lead', './Synth.clap'),
    ).resolves.toBeUndefined()
    expect(registeredLater.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(registeredLater.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    expect(registeredLater.audio.loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('U4 degrades loudly when a registered state file is missing', async () => {
    const h = harness()
    const relativeStatePath = 'states/missing.state'
    const absoluteStatePath = path.join(h.directory, 'states', 'missing.state')
    register(h.directory, { 'lead/instrument/Synth/0': relativeStatePath }, [])
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await h.instrument.instrument('lead', './Synth.clap')

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Registered plugin state '${absoluteStatePath}' for 'lead/instrument/Synth/0' does not exist`,
      ),
    )
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('U4b degrades loudly when a registered state file is not readable', async () => {
    const h = harness()
    const relativeStatePath = 'states/unreadable.state'
    const absoluteStatePath = path.join(h.directory, 'states', 'unreadable.state')
    register(h.directory, { 'lead/instrument/Synth/0': relativeStatePath })
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const access = vi.spyOn(fs.promises, 'access').mockRejectedValueOnce(permissionError)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await h.instrument.instrument('lead', './Synth.clap')

    expect(access).toHaveBeenCalledWith(absoluteStatePath, fs.constants.R_OK)
    expect(access).toHaveBeenCalledTimes(1)
    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Registered plugin state '${absoluteStatePath}' for 'lead/instrument/Synth/0' is not readable (EACCES: permission denied)`,
      ),
    )
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('U4c reports a registered state file removed before access as missing', async () => {
    const h = harness()
    const relativeStatePath = 'states/removed-before-access.state'
    const absoluteStatePath = path.join(h.directory, 'states', 'removed-before-access.state')
    register(h.directory, { 'lead/instrument/Synth/0': relativeStatePath })
    const missingError = Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })
    const access = vi.spyOn(fs.promises, 'access').mockRejectedValueOnce(missingError)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await h.instrument.instrument('lead', './Synth.clap')

    expect(access).toHaveBeenCalledWith(absoluteStatePath, fs.constants.R_OK)
    expect(access).toHaveBeenCalledTimes(1)
    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Registered plugin state '${absoluteStatePath}' for 'lead/instrument/Synth/0' does not exist`,
      ),
    )
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('U4d degrades loudly when a registered state path is a directory', async () => {
    const h = harness()
    const relativeStatePath = 'states/not-a-file.state'
    const absoluteStatePath = path.join(h.directory, 'states', 'not-a-file.state')
    fs.mkdirSync(absoluteStatePath, { recursive: true })
    register(h.directory, { 'lead/instrument/Synth/0': relativeStatePath }, [])
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await h.instrument.instrument('lead', './Synth.clap')

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Registered plugin state '${absoluteStatePath}' for 'lead/instrument/Synth/0' is not a file`,
      ),
    )
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('U4e degrades loudly when the registered state path is empty', async () => {
    const h = harness()
    register(h.directory, { 'lead/instrument/Synth/0': '' }, [])
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await h.instrument.instrument('lead', './Synth.clap')

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Registered plugin state '${h.directory}' for 'lead/instrument/Synth/0' is not a file`,
      ),
    )
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('U5 throws with the manifest path when project.yaml is malformed', async () => {
    const h = harness()
    const manifestPath = path.join(h.directory, 'project.yaml')
    fs.writeFileSync(manifestPath, 'version: 1\nstates: [\n')

    const failure = await h.masterEffect.effect('./Limiter.clap').catch((error) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('Cannot parse plugin state manifest')
    expect((failure as Error).message).not.toContain('Cannot read plugin state manifest')
    expect((failure as Error).message).toContain(manifestPath)
    expect(h.audio.loadPlugin).not.toHaveBeenCalled()
  })

  it('U5c wraps a non-ENOENT manifest read failure with the manifest path and identity', async () => {
    const h = harness()
    const manifestPath = path.join(h.directory, 'project.yaml')
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(permissionError)

    const failure = await h.instrument.instrument('lead', './Synth.clap').catch((error) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('Cannot read plugin state manifest')
    expect((failure as Error).message).toContain(manifestPath)
    expect((failure as Error).message).toContain('lead/instrument/Synth/0')
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(0)
  })

  it('U5b isolates an explicitly declared statePath from a malformed project.yaml', async () => {
    const h = harness()
    const explicitStatePath = path.join(h.directory, 'explicit.state')
    fs.writeFileSync(explicitStatePath, 'explicit-non-default-state')
    fs.writeFileSync(path.join(h.directory, 'project.yaml'), 'version: 1\nstates: [\n')

    await expect(
      h.instrument.instrument('lead', './Synth.clap', undefined, explicitStatePath),
    ).resolves.toBeUndefined()

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      explicitStatePath,
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
  })

  it.each(managerCases)(
    'U6 uses the external receiver namespace for $label',
    async ({ key, wrongKey, declare, expectedArgs }) => {
      const h = harness()
      const correctStatePath = `states/${key.replaceAll('/', '-')}.state`
      const wrongStatePath = `states/${wrongKey.replaceAll('/', '-')}.state`
      register(h.directory, { [key]: correctStatePath, [wrongKey]: wrongStatePath })

      await declare(h)

      expect(h.audio.loadPlugin).toHaveBeenCalledWith(
        ...expectedArgs(h.directory, path.resolve(h.directory, correctStatePath)),
      )
      expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
    },
  )

  it('U7 includes occurrence and role in the registration key', async () => {
    const h = harness()
    register(h.directory, {
      'lead/Synth/0': 'states/role-omitted.state',
      'lead/instrument/Synth': 'states/occurrence-omitted.state',
      'lead/effect/Synth/0': 'states/wrong-role.state',
      'lead/instrument/Synth/1': 'states/wrong-occurrence.state',
    })

    await h.instrument.instrument('lead', './Synth.clap')

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('U8 ignores a cwd project.yaml when documentDirectory is unset', async () => {
    const h = harness({ documentDirectory: false })
    const decoyDirectory = temporaryDirectory('orbit-plugin-state-cwd-decoy-')
    register(decoyDirectory, {
      'lead/instrument/Synth/0': 'states/cwd-decoy.state',
    })
    const originalCwd = process.cwd()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      process.chdir(decoyDirectory)
      await h.instrument.instrument('lead', '/plugins/Synth.clap')
    } finally {
      process.chdir(originalCwd)
    }

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      '/plugins/Synth.clap',
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledTimes(0)
  })

  it('U9 silently skips restoration when project.yaml does not exist', async () => {
    const h = harness()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await h.instrument.instrument('lead', './Synth.clap')

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledTimes(0)
  })

  it('U10 reuses the initial effective statePath during respawn self-heal', async () => {
    const h = harness({ active: false })
    const initialRelativeStatePath = 'states/initial.state'
    const replacementRelativeStatePath = 'states/replacement.state'
    const initialStatePath = path.join(h.directory, 'states', 'initial.state')
    register(h.directory, {
      'lead/instrument/Synth/0': initialRelativeStatePath,
    })

    await h.instrument.instrument('lead', './Synth.clap')
    register(h.directory, {
      'lead/instrument/Synth/0': replacementRelativeStatePath,
    })
    await h.instrument.instrument('lead', './Synth.clap')

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      initialStatePath,
    )
    expect(h.audio.loadPlugin).toHaveBeenNthCalledWith(
      2,
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      initialStatePath,
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(2)
  })

  it('U11 preserves an absolute state path registered in project.yaml', async () => {
    const h = harness()
    const externalDirectory = temporaryDirectory('orbit-plugin-state-absolute-')
    const absoluteStatePath = path.join(externalDirectory, 'absolute.state')
    register(h.directory, { 'lead/instrument/Synth/0': absoluteStatePath })

    await h.instrument.instrument('lead', './Synth.clap')

    expect(h.audio.loadPlugin).toHaveBeenCalledWith(
      path.join(h.directory, 'Synth.clap'),
      undefined,
      'instrument',
      undefined,
      'plugin:lead',
      absoluteStatePath,
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('U12 restores same-named sum/aux inserts only from their prefixed receiver keys', async () => {
    const h = harness()
    const sumStatePath = 'states/sum-correct.state'
    const auxStatePath = 'states/aux-correct.state'
    register(h.directory, {
      'sum:drum/effect/GlueComp/0': sumStatePath,
      'aux:drum/effect/GlueComp/0': auxStatePath,
      'drum/effect/GlueComp/0': 'states/unprefixed-decoy.state',
    })

    // The sum/aux pair on one name intentionally exercises the #579 ambiguous
    // fixture; silence its declaration warning (restored by afterEach).
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await h.mixer.sum('drum').effect('./GlueComp.clap')
    await h.mixer.aux('drum').effect('./GlueComp.clap')

    expect(h.audio.loadPlugin).toHaveBeenNthCalledWith(
      1,
      path.join(h.directory, 'GlueComp.clap'),
      undefined,
      'effect',
      'sum-bus-0',
      undefined,
      path.resolve(h.directory, sumStatePath),
    )
    expect(h.audio.loadPlugin).toHaveBeenNthCalledWith(
      2,
      path.join(h.directory, 'GlueComp.clap'),
      undefined,
      'effect',
      'aux-bus-0',
      undefined,
      path.resolve(h.directory, auxStatePath),
    )
    expect(h.audio.loadPlugin).toHaveBeenCalledTimes(2)
    expect(console.log).toHaveBeenCalledWith(
      `[plugin-state] restoring 'sum:drum/effect/GlueComp/0' from ${path.resolve(
        h.directory,
        sumStatePath,
      )}`,
    )
    expect(console.log).toHaveBeenCalledWith(
      `[plugin-state] restoring 'aux:drum/effect/GlueComp/0' from ${path.resolve(
        h.directory,
        auxStatePath,
      )}`,
    )
    expect(console.log).toHaveBeenCalledTimes(2)
  })
})
