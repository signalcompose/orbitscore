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
import {
  ProjectStateStore,
  stateFileNameForIdentity,
} from '../../packages/engine/src/core/project-state-store'
import { installEffectChainMock } from '../helpers/effect-chain-mock'

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
    openPluginUi: vi.fn().mockResolvedValue(undefined),
    closePluginUi: vi.fn().mockResolvedValue('safepoint-completed'),
    // Global のコンストラクタが safepoint saver を登録する。テストは
    // mock.calls[<n>][0] で saver を取り出し、daemon の PluginUiClosed 相当を直接叩く。
    setPluginUiSafepointSaver: vi.fn(),
    savePluginState: vi.fn(async (_target, statePath: string) => {
      await fs.promises.writeFile(statePath, Buffer.from('oracle-state'))
      return { path: statePath, bytesWritten: 12 }
    }),
  } as any
  installEffectChainMock(audio)
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
  it('snapshots every loaded plugin target exactly once without a dirty gate', async () => {
    const { directory, audio, global } = harness()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await global.effect('./MasterLimiter.vst3')
    await global.sum('drum').effect('./SumGlue.clap')
    await global.aux('wet').effect('./AuxVerb.clap')
    await global.sequenceEffect('lead', './LeadEcho.clap')
    await global.instrument('lead', './LeadSynth.clap')

    const result = await global.saveAllPluginStates()
    const identities = [
      {
        receiver: 'master',
        role: 'effect' as const,
        normalizedName: 'MasterLimiter',
        occurrence: 0,
      },
      {
        receiver: 'sum:drum',
        role: 'effect' as const,
        normalizedName: 'SumGlue',
        occurrence: 0,
      },
      {
        receiver: 'aux:wet',
        role: 'effect' as const,
        normalizedName: 'AuxVerb',
        occurrence: 0,
      },
      {
        receiver: 'lead',
        role: 'effect' as const,
        normalizedName: 'LeadEcho',
        occurrence: 0,
      },
      {
        receiver: 'lead',
        role: 'instrument' as const,
        normalizedName: 'LeadSynth',
        occurrence: 0,
      },
    ]
    const expectedStates = Object.fromEntries(
      identities.map((identity) => [
        `${identity.receiver}/${identity.role}/${identity.normalizedName}/${identity.occurrence}`,
        `states/${stateFileNameForIdentity(identity)}`,
      ]),
    )

    expect(parse(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8'))).toEqual({
      version: 1,
      states: expectedStates,
    })
    expect(audio.savePluginState).toHaveBeenCalledTimes(5)
    expect(audio.savePluginState).toHaveBeenNthCalledWith(
      1,
      { role: 'effect', chainPath: [0] },
      path.join(directory, ...expectedStates['master/effect/MasterLimiter/0'].split('/')),
    )
    expect(audio.savePluginState).toHaveBeenNthCalledWith(
      2,
      { role: 'effect', bus: 'sum-bus-0', chainPath: [0] },
      path.join(directory, ...expectedStates['sum:drum/effect/SumGlue/0'].split('/')),
    )
    expect(audio.savePluginState).toHaveBeenNthCalledWith(
      3,
      { role: 'effect', bus: 'aux-bus-0', chainPath: [0] },
      path.join(directory, ...expectedStates['aux:wet/effect/AuxVerb/0'].split('/')),
    )
    expect(audio.savePluginState).toHaveBeenNthCalledWith(
      4,
      { role: 'effect', bus: 'seq-bus-0', chainPath: [0] },
      path.join(directory, ...expectedStates['lead/effect/LeadEcho/0'].split('/')),
    )
    expect(audio.savePluginState).toHaveBeenNthCalledWith(
      5,
      { role: 'instrument', instance: 'plugin:lead' },
      path.join(directory, ...expectedStates['lead/instrument/LeadSynth/0'].split('/')),
    )
    expect(result).toEqual({ saved: 5, failures: 0 })
    expect(console.log).toHaveBeenCalledWith(
      '[plugin-state] auto-snapshot complete (5 saved, 0 failed)',
    )
  })

  it('does not require a dirty notification to snapshot a loaded target', async () => {
    const { audio, global } = harness()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await global.instrument('lead', './NeverMarkedDirty.clap')

    await global.saveAllPluginStates()

    expect(audio.savePluginState).toHaveBeenCalledTimes(1)
  })

  it('continues after one target fails and reports the partial result as an error', async () => {
    const { directory, audio, global } = harness()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await global.effect('./MasterLimiter.vst3')
    await global.sum('drum').effect('./SumGlue.clap')
    await global.aux('wet').effect('./AuxVerb.clap')
    audio.savePluginState.mockRejectedValueOnce(new Error('master refused state'))

    await expect(global.saveAllPluginStates()).resolves.toEqual({ saved: 2, failures: 1 })

    expect(audio.savePluginState).toHaveBeenCalledTimes(3)
    const states = (
      parse(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8')) as {
        states: Record<string, string>
      }
    ).states
    expect(states).not.toHaveProperty('master/effect/MasterLimiter/0')
    expect(states).toHaveProperty('sum:drum/effect/SumGlue/0')
    expect(states).toHaveProperty('aux:wet/effect/AuxVerb/0')
    expect(error).toHaveBeenCalledWith(
      "[plugin-state] auto-snapshot failed for 'master/effect/MasterLimiter/0': master refused state",
    )
    expect(error).toHaveBeenCalledWith('[plugin-state] auto-snapshot complete (2 saved, 1 failed)')
  })

  it('shares a store across Globals by engine and absolute directory, but not across engines', async () => {
    const { directory, audio, global: first } = harness()
    const second = new Global(audio)
    second.setDocumentDirectory(path.join(directory, '.'))
    const otherHarness = harness()
    const third = otherHarness.global
    third.setDocumentDirectory(directory)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await first.instrument('first', './First.clap')
    await second.instrument('second', './Second.clap')
    await third.instrument('third', './Third.clap')
    const save = vi.spyOn(ProjectStateStore.prototype, 'save')

    await first.saveAllPluginStates()
    await second.saveAllPluginStates()
    await third.saveAllPluginStates()

    expect(save.mock.instances[0]).toBe(save.mock.instances[1])
    expect(save.mock.instances[2]).not.toBe(save.mock.instances[0])
  })

  it('preserves both registrations when two Globals save the same project concurrently', async () => {
    const { directory, audio, global: first } = harness()
    const second = new Global(audio)
    second.setDocumentDirectory(directory)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await first.instrument('first', './First.clap')
    await second.instrument('second', './Second.clap')

    await Promise.all([first.saveAllPluginStates(), second.saveAllPluginStates()])

    const states = (
      parse(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8')) as {
        states: Record<string, string>
      }
    ).states
    expect(states).toHaveProperty('first/instrument/First/0')
    expect(states).toHaveProperty('second/instrument/Second/0')
  })

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
      daemonTarget: { role: 'effect', bus: 'seq-bus-0', chainPath: [0] },
    })
    expect(global.resolvePluginStateTarget('lead', 2)).toEqual({
      identity: {
        receiver: 'lead',
        role: 'effect',
        normalizedName: 'Echo',
        occurrence: 1,
      },
      daemonTarget: { role: 'effect', bus: 'seq-bus-0', chainPath: [1] },
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
      daemonTarget: { role: 'effect', chainPath: [0] },
    })
    expect(() => global.resolvePluginStateTarget('master', 0)).toThrow(
      /Valid indices: 1 \(effect, Limiter\)/,
    )
  })

  it('resolves explicitly prefixed sum/aux receivers to distinct identities and daemon buses', async () => {
    const { global } = harness()
    // The sum/aux pair on one name intentionally exercises the #579 ambiguous
    // fixture; silence its declaration warning (restored by afterEach).
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await global.sum('x').effect('./SumTone.clap')
    await global.aux('x').effect('./AuxTone.clap')

    expect(global.resolvePluginStateTarget('sum:x', 1)).toEqual({
      identity: {
        receiver: 'sum:x',
        role: 'effect',
        normalizedName: 'SumTone',
        occurrence: 0,
      },
      daemonTarget: { role: 'effect', bus: 'sum-bus-0', chainPath: [0] },
    })
    expect(global.resolvePluginStateTarget('aux:x', 1)).toEqual({
      identity: {
        receiver: 'aux:x',
        role: 'effect',
        normalizedName: 'AuxTone',
        occurrence: 0,
      },
      daemonTarget: { role: 'effect', bus: 'aux-bus-0', chainPath: [0] },
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
      { role: 'effect', bus: 'sum-bus-0', chainPath: [0] },
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
    // The sum/aux pair on one name intentionally exercises the #579 ambiguous
    // fixture; silence its declaration warning (restored by afterEach).
    vi.spyOn(console, 'warn').mockImplementation(() => {})
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

describe('plugin UI address guard and loud diagnostics (#474 P4c)', () => {
  it('opens the expected normalized plugin exactly once with the resolved daemon target', async () => {
    const { audio, global } = harness()
    await global.instrument('lead', './Massive-X.clap')

    await expect(global.openPluginUi('lead', 0, 'Massive-X')).resolves.toEqual({
      receiver: 'lead',
      index: 0,
      role: 'instrument',
      normalizedName: 'Massive-X',
    })

    expect(audio.openPluginUi).toHaveBeenCalledTimes(1)
    expect(audio.openPluginUi).toHaveBeenCalledWith(
      { role: 'instrument', instance: 'plugin:lead' },
      0,
      'OrbitScore — Massive-X (lead:0)',
      expect.any(Number),
    )
  })

  it('refuses an expectedName mismatch before opening and explains the current valid slot', async () => {
    const { audio, global } = harness()
    await global.instrument('lead', './Massive-X.clap')

    await expect(global.openPluginUi('lead', 0, 'WrongSynth')).rejects.toThrow(
      /expected normalized name 'WrongSynth' but the current slot is 'Massive-X'; re-evaluate first; the UI was not opened.*Valid indices: 0 \(instrument, Massive-X\)/,
    )
    expect(audio.openPluginUi).toHaveBeenCalledTimes(0)
  })

  it('keeps the expectedName comparison canonically normalized but does not accept another name', async () => {
    const { audio, global } = harness()
    await global.instrument('lead', './Cafe\u0301.clap')

    await global.openPluginUi('lead', 0, 'Café')

    expect(audio.openPluginUi).toHaveBeenCalledTimes(1)
    expect(audio.openPluginUi).toHaveBeenCalledWith(
      { role: 'instrument', instance: 'plugin:lead' },
      0,
      'OrbitScore — Café (lead:0)',
      expect.any(Number),
    )
  })

  it('adds every valid role/name index when the daemon reports an unloaded or UI-less plugin', async () => {
    const { audio, global } = harness()
    await global.instrument('lead', './Massive-X.clap')
    await global.sequenceEffect('lead', './Echo.clap')
    audio.openPluginUi.mockRejectedValueOnce(new Error('CAP-UI-OPEN is unavailable'))

    await expect(global.openPluginUi('lead', 1, 'Echo')).rejects.toThrow(
      /CAP-UI-OPEN is unavailable.*Valid indices: 0 \(instrument, Massive-X\), 1 \(effect, Echo\)/,
    )
    expect(audio.openPluginUi).toHaveBeenCalledTimes(1)
  })

  it('closes once with the exact target and exposes only DONE completion', async () => {
    const { audio, global } = harness()
    await global.sum('drum').effect('./GlueComp.clap')
    await global.openPluginUi('sum:drum', 1, 'GlueComp')

    await expect(global.closePluginUi('sum:drum', 1)).resolves.toEqual({
      receiver: 'sum:drum',
      index: 1,
      role: 'effect',
      normalizedName: 'GlueComp',
      completion: 'safepoint-completed',
    })
    expect(audio.closePluginUi).toHaveBeenCalledTimes(1)
    expect(audio.closePluginUi).toHaveBeenCalledWith(
      { role: 'effect', bus: 'sum-bus-0', chainPath: [0] },
      1,
      expect.any(Number),
    )
  })

  it('reports a DONE timeout-without-save loudly with the valid role/name list', async () => {
    const { audio, global } = harness()
    await global.sequenceEffect('lead', './Echo.clap')
    await global.openPluginUi('lead', 1, 'Echo')
    audio.closePluginUi.mockResolvedValueOnce('timeout-without-save')

    await expect(global.closePluginUi('lead', 1)).rejects.toThrow(
      /UI_CLOSED_DONE reported timeout-without-save.*Valid indices: 1 \(effect, Echo\)/,
    )
    expect(audio.closePluginUi).toHaveBeenCalledTimes(1)
  })
})

describe('plugin UI open-time identity policy (#601 I1/I2)', () => {
  /** Global コンストラクタが登録した safepoint saver（daemon の PluginUiClosed 相当）。 */
  function safepointSaver(audio: any, callIndex = 0) {
    return audio.setPluginUiSafepointSaver.mock.calls[callIndex][0] as (
      target: unknown,
    ) => Promise<void>
  }

  it('saves the open-time identity, not the current chain, after a swap while the UI is open', async () => {
    const { directory, audio, global } = harness()
    await global.sequenceEffect('lead', './Serum.clap')
    await global.openPluginUi('lead', 1, 'Serum')

    // UI を開いている間に DSL 再評価で同じ slot が別プラグインに差し替わった状況。
    const effectManager = (global as any).sequenceEffectManager
    const serumSlot = effectManager.chainFor('lead')[0]
    expect(serumSlot).toBeDefined()
    vi.spyOn(effectManager, 'chainFor').mockReturnValue([{ ...serumSlot, normalizedName: 'Diva' }])

    const window = audio.openPluginUi.mock.calls[0]![3]
    await safepointSaver(audio)({ role: 'effect', bus: serumSlot.bus, index: 999, window })

    // 実際に編集していたのは open 時の Serum。差し替え後の Diva に保存してはならない。
    expect(audio.savePluginState).toHaveBeenCalledTimes(1)
    const serumIdentity = {
      receiver: 'lead',
      role: 'effect' as const,
      normalizedName: 'Serum',
      occurrence: 0,
    }
    expect(audio.savePluginState).toHaveBeenCalledWith(
      { role: 'effect', bus: serumSlot.bus, chainPath: [0] },
      path.join(directory, 'states', stateFileNameForIdentity(serumIdentity)),
    )
    const manifest = parse(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8')) as {
      states: Record<string, string>
    }
    expect(manifest.states).toHaveProperty('lead/effect/Serum/0')
    expect(manifest.states).not.toHaveProperty('lead/effect/Diva/0')
  })

  it('closes with the open-time daemon target and reports the open-time plugin after a swap', async () => {
    const { audio, global } = harness()
    await global.sequenceEffect('lead', './Serum.clap')
    await global.openPluginUi('lead', 1, 'Serum')
    const effectManager = (global as any).sequenceEffectManager
    const serumSlot = effectManager.chainFor('lead')[0]
    vi.spyOn(effectManager, 'chainFor').mockReturnValue([{ ...serumSlot, normalizedName: 'Diva' }])

    await expect(global.closePluginUi('lead', 1)).resolves.toEqual({
      receiver: 'lead',
      index: 1,
      role: 'effect',
      normalizedName: 'Serum',
      completion: 'safepoint-completed',
    })
    expect(audio.closePluginUi).toHaveBeenCalledTimes(1)
    expect(audio.closePluginUi).toHaveBeenCalledWith(
      { role: 'effect', bus: serumSlot.bus, chainPath: [0] },
      1,
      expect.any(Number),
    )
  })

  it('S3 resolves an ambiguous same-bus safepoint by window even when target.index is unrelated', async () => {
    const { directory, audio, global } = harness()
    await global.sequenceEffect('lead', './Echo.clap')
    const effectManager = (global as any).sequenceEffectManager
    const firstEcho = effectManager.chainFor('lead')[0]
    expect(firstEcho).toBeDefined()
    // 同一 bus に同名プラグインが2つ並ぶチェーン。index だけが両者を区別する。
    vi.spyOn(effectManager, 'chainFor').mockReturnValue([
      firstEcho,
      { ...firstEcho, occurrence: 1, instanceId: 'seq:lead/Echo#2' },
    ])
    await global.openPluginUi('lead', 1, 'Echo')
    await global.openPluginUi('lead', 2, 'Echo')

    const firstWindow = audio.openPluginUi.mock.calls[0]![3]
    await safepointSaver(audio)({
      role: 'effect',
      bus: firstEcho.bus,
      index: 999,
      window: firstWindow,
    })

    expect(audio.savePluginState).toHaveBeenCalledTimes(1)
    const occurrenceZero = {
      receiver: 'lead',
      role: 'effect' as const,
      normalizedName: 'Echo',
      occurrence: 0,
    }
    expect(audio.savePluginState).toHaveBeenCalledWith(
      { role: 'effect', bus: firstEcho.bus, chainPath: [0] },
      path.join(directory, 'states', stateFileNameForIdentity(occurrenceZero)),
    )
    const manifest = parse(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8')) as {
      states: Record<string, string>
    }
    expect(manifest.states).toHaveProperty('lead/effect/Echo/0')
    expect(manifest.states).not.toHaveProperty('lead/effect/Echo/1')
  })

  it('refuses a safepoint save with no recorded open session and saves nothing', async () => {
    const { audio, global } = harness()
    await global.sequenceEffect('lead', './Serum.clap')
    const bus = (global as any).sequenceEffectManager.chainFor('lead')[0].bus

    await expect(
      safepointSaver(audio)({ role: 'effect', bus, index: 1, window: 999 }),
    ).rejects.toThrow(/no recorded open session; refusing to guess a save identity/)
    expect(audio.savePluginState).toHaveBeenCalledTimes(0)
  })

  it('refuses a safepoint save before the document has a directory and saves nothing', async () => {
    const { directory, audio } = harness()
    // directory 未設定の Global（.orbs 未保存の状態）。saver は2回目の登録分。
    // 相対パス解決は documentDirectory を要求するので絶対パスで宣言する。
    const bare = new Global(audio)
    const sequence = new Sequence(bare, audio)
    sequence.setName('lead')
    await bare.sequenceEffect('lead', path.join(directory, 'Serum.clap'))
    await bare.openPluginUi('lead', 1, 'Serum')
    const bus = (bare as any).sequenceEffectManager.chainFor('lead')[0].bus

    const window = audio.openPluginUi.mock.calls.at(-1)![3]
    await expect(
      safepointSaver(audio, 1)({ role: 'effect', bus, index: 1, window }),
    ).rejects.toThrow(/before the document has a directory/)
    expect(audio.savePluginState).toHaveBeenCalledTimes(0)
  })

  it('rejects a second close after the session is consumed by the first', async () => {
    const { audio, global } = harness()
    await global.sequenceEffect('lead', './Serum.clap')
    await global.openPluginUi('lead', 1, 'Serum')

    await global.closePluginUi('lead', 1)

    await expect(global.closePluginUi('lead', 1)).rejects.toThrow(
      /no plugin UI opened via open_plugin_ui is recorded for this target/,
    )
    expect(audio.closePluginUi).toHaveBeenCalledTimes(1)
  })

  // 保存時の破棄（close 完了時の破棄とは別の地点）。main の変異検証で
  // `savePluginUiStateAtSafepoint` 末尾の delete を消しても全テスト green だった
  // 生存変異を塞ぐ: 保存済みセッションが残ると、後続の close_plugin_ui が
  // 「保存済みの古いセッション」を掴んで二重保存・誤 close の起点になる。
  it('consumes the session at a successful safepoint save so a later close cannot reuse it', async () => {
    const { audio, global } = harness()
    await global.sequenceEffect('lead', './Serum.clap')
    await global.openPluginUi('lead', 1, 'Serum')
    const bus = (global as any).sequenceEffectManager.chainFor('lead')[0].bus

    // ユーザーがウィンドウを手で閉じた → daemon の safepoint で保存完了
    const window = audio.openPluginUi.mock.calls[0]![3]
    await safepointSaver(audio)({ role: 'effect', bus, index: 1, window })
    expect(audio.savePluginState).toHaveBeenCalledTimes(1)

    // 窓はもう無い。保存時に破棄されていなければここが成功してしまう。
    await expect(global.closePluginUi('lead', 1)).rejects.toThrow(
      /no plugin UI opened via open_plugin_ui is recorded for this target/,
    )
    expect(audio.closePluginUi).toHaveBeenCalledTimes(0)
  })

  // close 側の照合地点（セッションキーとは別）。main の変異検証で close の `find`
  // から `candidate.index === index` を消しても全テスト green だった生存変異を塞ぐ:
  // 同一 receiver に複数 index のセッションがあると、最初の一致が別 index の窓を閉じる。
  // 変異を観測可能にするため、index 1 と 2 に**別名**のプラグインを置く
  // （同名だと戻り値の normalizedName も daemonTarget も一致して変異が見えない）。
  it('closes the session selected by index when the same receiver has several open UIs', async () => {
    const { audio, global } = harness()
    await global.sequenceEffect('lead', './Echo.clap')
    const effectManager = (global as any).sequenceEffectManager
    const echoSlot = effectManager.chainFor('lead')[0]
    expect(echoSlot).toBeDefined()
    vi.spyOn(effectManager, 'chainFor').mockReturnValue([
      echoSlot,
      { ...echoSlot, normalizedName: 'Reverb', instanceId: 'seq:lead/Reverb#2' },
    ])
    await global.openPluginUi('lead', 1, 'Echo')
    await global.openPluginUi('lead', 2, 'Reverb')

    await expect(global.closePluginUi('lead', 2)).resolves.toEqual({
      receiver: 'lead',
      index: 2,
      role: 'effect',
      normalizedName: 'Reverb',
      completion: 'safepoint-completed',
    })
    expect(audio.closePluginUi).toHaveBeenCalledTimes(1)
    expect(audio.closePluginUi).toHaveBeenCalledWith(
      { role: 'effect', bus: echoSlot.bus, chainPath: [1] },
      2,
      expect.any(Number),
    )

    // index 1 のセッションは無傷で残っている（誤って選ばれ消費されていない）。
    await expect(global.closePluginUi('lead', 1)).resolves.toMatchObject({
      index: 1,
      normalizedName: 'Echo',
    })
    expect(audio.closePluginUi).toHaveBeenCalledTimes(2)
  })

  // #601 確認レビュー Important: 「同一 (receiverId, index) に高々1セッション」の不変条件。
  // daemonTarget が変わる再 open は複合キーが別になり `set` では上書きされないため、
  // openPluginUi 側の evict が無いと closePluginUi の find が Map の挿入順＝stale 側を
  // 掴む（現行 v1 API では踏めないが、undeclare/release API が1つ足された瞬間に
  // 無警告で生きたバグになる）。
  it('keeps at most one session per (receiver, index): re-opening with a different daemon target evicts the stale one', async () => {
    const { audio, global } = harness()
    await global.sequenceEffect('lead', './Serum.clap')
    const effectManager = (global as any).sequenceEffectManager
    const serumSlot = effectManager.chainFor('lead')[0]
    expect(serumSlot).toBeDefined()
    await global.openPluginUi('lead', 1, 'Serum')

    // 将来の undeclare/release 相当で同じ slot の bus が変わった状況（レビュアーと同じ
    // chainFor mock の手法）。複合キーが旧セッションと別になる再 open。
    vi.spyOn(effectManager, 'chainFor').mockReturnValue([
      { ...serumSlot, bus: 'seq-bus-9-different', normalizedName: 'Diva' },
    ])
    await global.openPluginUi('lead', 1, 'Diva')

    // Map に残るのは新しい方の1つだけ。
    expect((global as any).openPluginUiSessions.size).toBe(1)

    // close は新しい方（いまユーザーが見ている窓）を掴む。
    await expect(global.closePluginUi('lead', 1)).resolves.toMatchObject({
      index: 1,
      normalizedName: 'Diva',
    })
    expect(audio.closePluginUi).toHaveBeenCalledTimes(1)
    expect(audio.closePluginUi).toHaveBeenCalledWith(
      { role: 'effect', bus: 'seq-bus-9-different', chainPath: [0] },
      1,
      expect.any(Number),
    )
  })

  it('requires the Rust engine backend for both open and close, before contacting the daemon', async () => {
    const { audio, global } = harness()
    await global.sequenceEffect('lead', './Echo.clap')

    const openImpl = audio.openPluginUi
    delete audio.openPluginUi
    await expect(global.openPluginUi('lead', 1, 'Echo')).rejects.toThrow(
      /plugin UI hosting requires the Rust engine backend/,
    )

    audio.openPluginUi = openImpl
    await global.openPluginUi('lead', 1, 'Echo')
    delete audio.closePluginUi
    await expect(global.closePluginUi('lead', 1)).rejects.toThrow(
      /plugin UI hosting requires the Rust engine backend/,
    )
  })
})

describe('plugin state automatic snapshot wiring (#577)', () => {
  it('T1: keeps zero-target skips quiet and makes unsaved loaded targets visible', async () => {
    const { audio, global } = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(global.saveAllPluginStates()).resolves.toEqual({ saved: 0, failures: 0 })
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      '[plugin-state] auto-snapshot skipped: no loaded plugin targets',
    )
    expect(log.mock.calls[0]?.[0]).not.toContain('⚠️')

    const globalWithoutDirectory = new Global(audio)
    const sequence = new Sequence(globalWithoutDirectory, audio)
    sequence.setName('lead-without-directory')
    await globalWithoutDirectory.instrument('lead-without-directory', '/LeadSynth.clap')
    warn.mockClear()
    log.mockClear()

    await expect(globalWithoutDirectory.saveAllPluginStates()).resolves.toEqual({
      saved: 0,
      failures: 0,
    })
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      '[plugin-state] ⚠️ auto-snapshot skipped: document directory is not set; ' +
        "unsaved targets: 'lead-without-directory/instrument/LeadSynth/0'",
    )
  })

  it('fires exactly once on a running-to-stopped transition', async () => {
    const { global } = harness()
    const snapshot = vi
      .spyOn(global, 'saveAllPluginStates')
      .mockResolvedValue({ saved: 0, failures: 0 })

    global.start()
    global.stop()
    global.stop()

    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1))
  })

  it('does not fire when stop is called while already stopped', async () => {
    const { global } = harness()
    const snapshot = vi
      .spyOn(global, 'saveAllPluginStates')
      .mockResolvedValue({ saved: 0, failures: 0 })

    global.stop()

    await Promise.resolve()
    expect(snapshot).not.toHaveBeenCalled()
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
