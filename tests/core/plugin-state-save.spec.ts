import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { stateFileNameForIdentity } from '../../packages/engine/src/core/project-state-store'

const temporaryDirectories: string[] = []

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-plugin-state-'))
  temporaryDirectories.push(directory)
  const audio = {
    isRunning: true,
    startTime: 0,
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    getAudioDuration: vi.fn(() => 1),
    getMasterGainDb: () => 0,
    loadPlugin: vi.fn().mockResolvedValue({}),
    savePluginState: vi.fn(async (_target, statePath: string) => {
      await fs.promises.writeFile(statePath, Buffer.from('oracle-state'))
      return { path: statePath, bytesWritten: 12 }
    }),
  } as any
  const global = new Global(audio)
  global.setDocumentDirectory(directory)
  const sequence = new Sequence(global, audio)
  sequence.setName('lead')
  return { directory, audio, global, sequence }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('plugin state address resolution and project registration (#562)', () => {
  it('resolves instrument index 0 to SC.5 identity and the daemon instance', async () => {
    const { global } = harness()
    await global.instrument('lead', './Massive-X.clap')

    expect(global.resolvePluginStateTarget('lead', 0)).toEqual({
      identity: {
        receiver: 'lead',
        role: 'instrument',
        normalizedName: 'Massive-X',
        occurrence: 0,
      },
      daemonTarget: { role: 'instrument', instance: 'plugin:lead' },
    })
  })

  it('offsets per-sequence effect indices after the instrument source slot', async () => {
    const { global } = harness()
    await global.instrument('lead', './Massive-X.clap')
    await global.sequenceEffect('lead', './Echo.clap')

    const effectManager = (global as any).sequenceEffectManager
    const firstEffect = effectManager.chainFor('lead')[0]
    expect(firstEffect).toBeDefined()
    vi.spyOn(effectManager, 'chainFor').mockReturnValue([
      firstEffect,
      {
        ...firstEffect,
        occurrence: 1,
        instanceId: 'seq:lead/Echo#2',
      },
    ])

    expect(global.resolvePluginStateTarget('lead', 0)).toEqual({
      identity: {
        receiver: 'lead',
        role: 'instrument',
        normalizedName: 'Massive-X',
        occurrence: 0,
      },
      daemonTarget: { role: 'instrument', instance: 'plugin:lead' },
    })
    expect(global.resolvePluginStateTarget('lead', 1)).toEqual({
      identity: {
        receiver: 'lead',
        role: 'effect',
        normalizedName: 'Echo',
        occurrence: 0,
      },
      daemonTarget: { role: 'effect', bus: 'seq-bus-0' },
    })
    expect(global.resolvePluginStateTarget('lead', 2)).toEqual({
      identity: {
        receiver: 'lead',
        role: 'effect',
        normalizedName: 'Echo',
        occurrence: 1,
      },
      daemonTarget: { role: 'effect', bus: 'seq-bus-0' },
    })
  })

  it('saves non-empty state then atomically registers the SC.5 key in project.yaml', async () => {
    const { directory, audio, global } = harness()
    await global.instrument('lead', './Massive-X.clap')

    const saved = await global.savePluginState('lead', 0)
    const identity = {
      receiver: 'lead',
      role: 'instrument' as const,
      normalizedName: 'Massive-X',
      occurrence: 0,
    }
    const expectedRelative = `states/${stateFileNameForIdentity(identity)}`
    expect(saved.identityKey).toBe('lead/instrument/Massive-X/0')
    expect(saved.projectStatePath).toBe(expectedRelative)
    expect(audio.savePluginState).toHaveBeenCalledTimes(1)
    expect(audio.savePluginState).toHaveBeenCalledWith(
      { role: 'instrument', instance: 'plugin:lead' },
      path.join(directory, ...expectedRelative.split('/')),
    )
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('oracle-state')
    expect(parse(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8'))).toEqual({
      version: 1,
      states: { 'lead/instrument/Massive-X/0': expectedRelative },
    })
    expect(fs.readdirSync(directory).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('uses master index 1 and reports valid role/name indices on a loud miss', async () => {
    const { global } = harness()
    await global.effect('./Limiter.vst3')
    expect(global.resolvePluginStateTarget('master', 1)).toEqual({
      identity: {
        receiver: 'master',
        role: 'effect',
        normalizedName: 'Limiter',
        occurrence: 0,
      },
      daemonTarget: { role: 'effect' },
    })
    expect(() => global.resolvePluginStateTarget('master', 0)).toThrow(
      /Valid indices: 1 \(effect, Limiter\)/,
    )
  })

  it('does not expose the built-in audio source at sequence index 0', () => {
    const { global, sequence } = harness()
    sequence.audio('./kick.wav')

    expect(() => global.resolvePluginStateTarget('lead', 0)).toThrow(
      /built-in audio source is not a plugin.*Valid indices: <none>/,
    )
  })

  it('reports that a MIDI source is not a hosted plugin at sequence index 0', () => {
    const { global, sequence } = harness()
    vi.spyOn(sequence, 'isMidi').mockReturnValue(true)

    expect(() => global.resolvePluginStateTarget('lead', 0)).toThrow(
      /MIDI source is not a hosted plugin.*Valid indices: <none>/,
    )
  })

  it.each([
    ['drum', 'sum'],
    ['reverb', 'aux'],
  ] as const)(
    'reports declared %s mixer buses as unsupported instead of unknown sequences',
    (name, kind) => {
      const { global } = harness()
      global[kind](name)

      expect(() => global.resolvePluginStateTarget(name, 1)).toThrow(
        `'${name}' is a ${kind} bus; saving state for mixer-bus inserts is not supported in v1 (see PLUGIN_UI_HOSTING_SPEC_v1 UIH.5).`,
      )
    },
  )

  it('does not update project.yaml when the daemon state save fails', async () => {
    const { directory, audio, global } = harness()
    await global.instrument('lead', './Massive-X.clap')
    fs.writeFileSync(
      path.join(directory, 'project.yaml'),
      'version: 1\nstates:\n  old/effect/state/0: states/old.state\n',
    )
    audio.savePluginState.mockRejectedValueOnce(new Error('plugin refused state'))

    await expect(global.savePluginState('lead', 0)).rejects.toThrow('plugin refused state')
    expect(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8')).toContain(
      'old/effect/state/0',
    )
    expect(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8')).not.toContain(
      'lead/instrument',
    )
  })

  it.each([
    ['missing', undefined],
    ['non-numeric', Number.NaN],
    ['zero', 0],
  ])(
    'does not update project.yaml when the daemon returns a %s byte count',
    async (_label, bytesWritten) => {
      const { directory, audio, global } = harness()
      await global.instrument('lead', './Massive-X.clap')
      const manifestPath = path.join(directory, 'project.yaml')
      const originalManifest = 'version: 1\nstates:\n  old/effect/state/0: states/old.state\n'
      fs.writeFileSync(manifestPath, originalManifest)
      audio.savePluginState.mockResolvedValueOnce({
        path: path.join(directory, 'states', 'invalid.state'),
        bytesWritten,
      })

      await expect(global.savePluginState('lead', 0)).rejects.toThrow('invalid byte count')
      expect(audio.savePluginState).toHaveBeenCalledTimes(1)
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(originalManifest)
    },
  )

  it('rejects on the TS side while transport is running without calling the daemon', async () => {
    const { audio, global } = harness()
    await global.instrument('lead', './Massive-X.clap')
    global.start()

    await expect(global.savePluginState('lead', 0)).rejects.toThrow('transport is running')
    expect(audio.savePluginState).not.toHaveBeenCalled()
    expect(audio.stop).not.toHaveBeenCalled()
  })
})
