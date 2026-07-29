import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import {
  MIXER_BUS_KINDS,
  formatReceiverId,
  parseReceiverId,
} from '../../packages/engine/src/core/global/mixer-manager'
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

  it('resolves explicitly prefixed sum/aux receivers to distinct identities and daemon buses', async () => {
    const { global } = harness()
    await global.sum('x').effect('./SumTone.clap')
    await global.aux('x').effect('./AuxTone.clap')

    expect(global.resolvePluginStateTarget('sum:x', 1)).toEqual({
      identity: {
        receiver: 'sum:x',
        role: 'effect',
        normalizedName: 'SumTone',
        occurrence: 0,
      },
      daemonTarget: { role: 'effect', bus: 'sum-bus-0' },
    })
    expect(global.resolvePluginStateTarget('aux:x', 1)).toEqual({
      identity: {
        receiver: 'aux:x',
        role: 'effect',
        normalizedName: 'AuxTone',
        occurrence: 0,
      },
      daemonTarget: { role: 'effect', bus: 'aux-bus-0' },
    })
  })

  it.each([
    ['sum', 'drum'],
    ['aux', 'reverb'],
  ] as const)(
    'reports index 0 and a missing effect index loudly for %s buses',
    async (kind, name) => {
      const { global } = harness()
      await global[kind](name).effect('./GlueComp.clap')

      expect(() => global.resolvePluginStateTarget(`${kind}:${name}`, 0)).toThrow(
        new RegExp(
          `${kind}:${name} is a bus and has no source slot; effects start at index 1.*` +
            'Valid indices: 1 \\(effect, GlueComp\\)',
        ),
      )
      expect(() => global.resolvePluginStateTarget(`${kind}:${name}`, 2)).toThrow(
        /requested chain slot does not exist.*Valid indices: 1 \(effect, GlueComp\)/,
      )
    },
  )

  it('saves a sum insert under its prefixed receiver identity', async () => {
    const { directory, audio, global } = harness()
    await global.sum('drum').effect('./GlueComp.clap')

    const saved = await global.savePluginState('sum:drum', 1)
    const identity = {
      receiver: 'sum:drum',
      role: 'effect' as const,
      normalizedName: 'GlueComp',
      occurrence: 0,
    }
    const expectedRelative = `states/${stateFileNameForIdentity(identity)}`

    expect(saved.identityKey).toBe('sum:drum/effect/GlueComp/0')
    expect(saved.projectStatePath).toBe(expectedRelative)
    expect(audio.savePluginState).toHaveBeenCalledWith(
      { role: 'effect', bus: 'sum-bus-0' },
      path.join(directory, ...expectedRelative.split('/')),
    )
    expect(parse(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8'))).toEqual({
      version: 1,
      states: { 'sum:drum/effect/GlueComp/0': expectedRelative },
    })
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

  it('keeps an unprefixed receiver sequence-only even when a same-named bus exists', async () => {
    const { global } = harness()
    await global.instrument('lead', './Massive-X.clap')
    await global.sum('lead').effect('./WrongBusEffect.clap')

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

  it('gives a lexical bus prefix priority over a same-named registered sequence', async () => {
    const { audio, global } = harness()
    const prefixedNameSequence = new Sequence(global, audio)
    prefixedNameSequence.setName('sum:x')
    await global.instrument('sum:x', './SequenceOnlySynth.clap')

    expect(() => global.resolvePluginStateTarget('sum:x', 0)).toThrow(
      "Unknown sum bus 'x'; no plugin chain is registered for 'sum:x'.",
    )
  })

  it('diagnoses every matching bus prefix when an unprefixed sequence is absent', () => {
    const { global } = harness()
    global.sum('x')
    global.aux('x')

    expect(() => global.resolvePluginStateTarget('x', 1)).toThrow(
      "Unknown sequence 'x'; a same-named mixer bus exists. Use 'sum:x' or 'aux:x' to save its insert state.",
    )
  })

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

describe('prefixed receiver id wire format (#564)', () => {
  it.each(MIXER_BUS_KINDS.map((kind) => [kind] as const))(
    'round-trips %s receiver ids for plain, empty, and separator-bearing names',
    (kind) => {
      for (const name of ['drum', '', 'a:b', 'sum', 'aux', 'sum:x']) {
        expect(parseReceiverId(formatReceiverId(kind, name))).toEqual({ kind, name })
      }
    },
  )

  it('keeps everything after the first separator as the bus name', () => {
    expect(parseReceiverId('sum:')).toEqual({ kind: 'sum', name: '' })
    expect(parseReceiverId('sum:a:b')).toEqual({ kind: 'sum', name: 'a:b' })
    expect(parseReceiverId('aux:sum:x')).toEqual({ kind: 'aux', name: 'sum:x' })
  })

  it('returns undefined for ids without a bus prefix', () => {
    expect(parseReceiverId('sum')).toBeUndefined()
    expect(parseReceiverId('aux')).toBeUndefined()
    expect(parseReceiverId('master')).toBeUndefined()
    expect(parseReceiverId('drum')).toBeUndefined()
    expect(parseReceiverId('')).toBeUndefined()
  })

  it('requires the prefix to be anchored at the start of the id', () => {
    // A drifting match (e.g. `includes` instead of `startsWith`) would classify
    // these sequence-shaped names as bus receivers and break sequence saves.
    expect(parseReceiverId('my-sum:x')).toBeUndefined()
    expect(parseReceiverId('my-aux:x')).toBeUndefined()
    expect(parseReceiverId('xsum:x')).toBeUndefined()
    expect(parseReceiverId('lead sum:x')).toBeUndefined()
  })
})
