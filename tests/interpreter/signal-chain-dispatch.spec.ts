import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { clearPluginCatalogCache } from '../../packages/engine/src/core/global/plugin-catalog'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { processSequenceInit } from '../../packages/engine/src/interpreter/process-initialization'
import { processStatement } from '../../packages/engine/src/interpreter/process-statement'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import {
  BUS_DSL_METHODS,
  createMixerRuntimeRegistry,
  GLOBAL_DSL_METHODS,
  SEQUENCE_DSL_METHODS,
} from '../../packages/engine/src/signal-chain/runtime'
import { RecordingScheduler } from '../audio/verify/recording-scheduler'

function makeState(global: Global) {
  return {
    globals: new Map([['global', global]]),
    sequences: new Map<string, Sequence>(),
    mixers: createMixerRuntimeRegistry(),
    currentGlobal: global,
    audioEngine: new RecordingScheduler(),
    isBooted: true,
    runGroup: new Set<string>(),
    loopGroup: new Set<string>(),
    muteGroup: new Set<string>(),
    engineT0: Date.now(),
  }
}

async function run(source: string, state: ReturnType<typeof makeState>): Promise<void> {
  const ir = parseAudioDSL(source)
  for (const init of ir.sequenceInits) await processSequenceInit(init, state)
  for (const statement of ir.statements) await processStatement(statement, state)
}

describe('Signal Chain runtime resolver dispatch (S2)', () => {
  let directory: string
  let previousCatalog: string | undefined

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-s2-dispatch-'))
    previousCatalog = process.env.ORBIT_PLUGIN_CATALOG
    const catalog = {
      version: 1,
      scannedAt: '2026-07-26T00:00:00Z',
      plugins: [
        {
          name: 'Play',
          vendor: 'Shadow',
          format: 'clap',
          path: '/play.clap',
          pluginId: 'play',
          roles: ['effect'],
        },
        {
          name: 'TAL Reverb 4',
          vendor: 'TAL',
          format: 'clap',
          path: '/tal.clap',
          pluginId: 'tal-clap',
          roles: ['effect'],
        },
        {
          name: 'TAL Reverb 4',
          vendor: 'TAL',
          format: 'vst3',
          path: '/tal.vst3',
          pluginId: 'tal-vst3',
          roles: ['effect'],
        },
        {
          name: 'Twin',
          vendor: 'A',
          format: 'clap',
          path: '/a.clap',
          pluginId: 'a',
          roles: ['effect'],
        },
        {
          name: 'Twin',
          vendor: 'B',
          format: 'clap',
          path: '/b.clap',
          pluginId: 'b',
          roles: ['effect'],
        },
        {
          name: 'Synth',
          vendor: 'Maker',
          format: 'clap',
          path: '/synth.clap',
          pluginId: 'synth',
          roles: ['instrument'],
        },
        {
          name: 'Dual',
          vendor: 'Maker',
          format: 'clap',
          path: '/dual.clap',
          pluginId: 'dual',
          roles: ['effect', 'instrument'],
        },
        {
          name: 'Role Split',
          vendor: 'Effect Vendor',
          format: 'clap',
          path: '/role-split-effect.clap',
          pluginId: 'role-split-effect',
          roles: ['effect'],
        },
        {
          name: 'Role Split',
          vendor: 'Instrument Vendor',
          format: 'clap',
          path: '/role-split-instrument.clap',
          pluginId: 'role-split-instrument',
          roles: ['instrument'],
        },
        {
          name: 'Selector Split',
          vendor: 'Effect Vendor',
          format: 'vst3',
          path: '/selector-split-effect.vst3',
          pluginId: 'selector-split-effect',
          roles: ['effect'],
        },
        {
          name: 'Selector Split',
          vendor: 'Instrument Vendor',
          format: 'vst3',
          path: '/selector-split-instrument.vst3',
          pluginId: 'selector-split-instrument',
          roles: ['instrument'],
        },
      ],
    }
    const catalogPath = path.join(directory, 'plugin-catalog.json')
    fs.writeFileSync(catalogPath, JSON.stringify(catalog))
    process.env.ORBIT_PLUGIN_CATALOG = catalogPath
    clearPluginCatalogCache()
  })

  afterEach(() => {
    if (previousCatalog === undefined) delete process.env.ORBIT_PLUGIN_CATALOG
    else process.env.ORBIT_PLUGIN_CATALOG = previousCatalog
    clearPluginCatalogCache()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('keeps curated DSL methods ahead of mixer and plugin names', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq\nvar mix = init global.mixer\nvar play = mix.aux', state)
    const sequence = state.sequences.get('kick')!
    const play = vi.spyOn(sequence, 'play')
    const effect = vi.spyOn(sequence, 'effect')

    await run('kick.play(1)', state)

    expect(play).toHaveBeenCalledOnce()
    expect(effect).not.toHaveBeenCalled()
  })

  it('dispatches plugin names and maps format/vendor selectors to string-form resolution', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq\nvar mix = init global.mixer\nvar verb = mix.aux', state)
    const sequence = state.sequences.get('kick')!
    const effect = vi.spyOn(sequence, 'effect').mockResolvedValue(sequence)
    const verb = state.mixers.nodes.get('verb')
    const busEffect = vi
      .spyOn((verb as Extract<typeof verb, { kind: 'aux' }>).handle, 'effect')
      .mockResolvedValue((verb as Extract<typeof verb, { kind: 'aux' }>).handle)

    await run(
      'kick.TALReverb4()\nkick.TALReverb4(format: "vst3")\nkick.Twin(vendor: "B")\nverb.TALReverb4()',
      state,
    )

    expect(effect.mock.calls).toEqual([['TAL Reverb 4'], ['vst3/TAL Reverb 4'], ['B/Twin']])
    expect(busEffect).toHaveBeenCalledWith('TAL Reverb 4')
  })

  it('rejects positional plugin arguments instead of silently dropping them', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq', state)
    const effect = vi.spyOn(state.sequences.get('kick')!, 'effect')

    await expect(run('kick.TALReverb4(0.5)', state)).rejects.toThrow(
      /positional argument.*named.*TALReverb4\(mix: 0\.5\)/i,
    )
    expect(effect).not.toHaveBeenCalled()
  })

  it('rejects plugin selectors passed to a string-form DSL method with the staged error', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq', state)

    await expect(run('kick.effect("TAL Reverb 4", format: "vst3")', state)).rejects.toThrow(
      /named argument "format:".*not executable yet.*plugin resolution.*S2/i,
    )
  })

  it('distinguishes a missing plugin catalog from an unknown plugin method', async () => {
    process.env.ORBIT_PLUGIN_CATALOG = path.join(directory, 'missing-catalog.json')
    clearPluginCatalogCache()
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq', state)

    await expect(run('kick.TALReverb4()', state)).rejects.toThrow(
      /Plugin catalog not found.*orbit-plugin-scan/,
    )
  })

  it('dispatches an instrument-only plugin and rejects an ambiguous dual-role plugin', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var lead = init global.seq', state)
    const sequence = state.sequences.get('lead')!
    const instrument = vi.spyOn(sequence, 'instrument').mockResolvedValue(sequence)

    await run('lead.Synth()', state)
    expect(instrument).toHaveBeenCalledWith('Synth')
    await expect(run('lead.Dual()', state)).rejects.toThrow(
      /ambiguous.*effect\("Dual"\).*instrument\("Dual"\)/i,
    )
  })

  it('rejects instrument-only plugins on bus and Global effect receivers', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var mix = init global.mixer\nvar bus = mix.aux', state)

    await expect(run('bus.Synth()', state)).rejects.toThrow(
      /Plugin "Synth" does not support the "effect" role/,
    )
    await expect(run('global.Synth()', state)).rejects.toThrow(
      /Plugin "Synth" does not support the "effect" role/,
    )
  })

  it('dispatches a plugin method directly on Global', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    const effect = vi.spyOn(global, 'effect').mockResolvedValue(global)

    await run('global.TALReverb4()', state)

    expect(effect).toHaveBeenCalledWith('TAL Reverb 4')
  })

  it('matches string-form ambiguity when format and vendor selectors are both present', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var lead = init global.seq', state)
    const sequence = state.sequences.get('lead')!
    const effect = vi.spyOn(sequence, 'effect')
    const instrument = vi.spyOn(sequence, 'instrument')

    let stringError: unknown
    try {
      await sequence.effect('vst3/Selector Split')
    } catch (error) {
      stringError = error
    }

    expect(stringError).toBeInstanceOf(Error)
    await expect(
      run('lead.SelectorSplit(format: "vst3", vendor: "Instrument Vendor")', state),
    ).rejects.toThrow((stringError as Error).message)
    expect(effect).toHaveBeenCalledOnce()
    expect(instrument).not.toHaveBeenCalled()
  })

  it('matches string-form vendor ambiguity before inferring a role', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var lead = init global.seq', state)
    const sequence = state.sequences.get('lead')!

    let stringError: unknown
    try {
      await sequence.effect('Role Split')
    } catch (error) {
      stringError = error
    }

    expect(stringError).toBeInstanceOf(Error)
    await expect(run('lead.RoleSplit()', state)).rejects.toThrow((stringError as Error).message)
  })

  it('throws actionable errors for unknown names, staged args, sidechain, mixer names, and second inserts', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run(
      'var kick = init global.seq\nvar mix = init global.mixer\nvar duck = mix.aux\nvar drums = mix.sum',
      state,
    )
    const sequence = state.sequences.get('kick')!
    vi.spyOn(sequence, 'effect')
      .mockResolvedValueOnce(sequence)
      .mockRejectedValueOnce(new Error('one insert per bus in v1'))

    await expect(run('kick.NoSuch()', state)).rejects.toThrow(/Unknown chain method "NoSuch"/)
    await expect(run('kick.TALReverb4(mix: 0.5)', state)).rejects.toThrow(/S4/)
    await expect(run('kick.TALReverb4(preset: "Wide")', state)).rejects.toThrow(/S4/)
    await expect(run('kick.TALReverb4(enabled: false)', state)).rejects.toThrow(/S4/)
    await expect(run('kick.TALReverb4(sidechain: missing)', state)).rejects.toThrow(
      /not a declared aux/,
    )
    // Anchored on the argument name, not just the issue number: both cite #409
    // (it covers sidechain AND multi-out), so a bare /#409/ would still pass if
    // the two branches' messages were swapped.
    await expect(run('kick.TALReverb4(sidechain: duck)', state)).rejects.toThrow(
      /^sidechain:.*#409/,
    )
    await expect(run('kick.TALReverb4(outs: 4)', state)).rejects.toThrow(/^outs:.*#409/)
    await expect(run('kick.drums()', state)).rejects.toThrow(/S3.*#517/)
    await run('kick.TALReverb4()', state)
    await expect(run('kick.TALReverb4()', state)).rejects.toThrow(/S4.*multiple insert/i)
  })

  it('keeps the branded bus guard ahead of generic resolver errors', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var mix = init global.mixer\nvar bus = mix.aux', state)
    await expect(run('bus.gain(0.5)', state)).rejects.toThrow(/S2.*S3.*#517/)
  })

  it('keeps the branded bus guard when a later chain hop first returns a bus', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    const tempo = vi.spyOn(global, 'tempo')

    await expect(run('global.tempo(120).aux("verb").gain(0.5)', state)).rejects.toThrow(
      /S2.*S3.*#517/,
    )
    expect(tempo).toHaveBeenCalledWith(120)
  })

  it('names a mixer bus in unknown-method errors instead of reporting Object', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var mix = init global.mixer\nvar bus = mix.aux', state)

    await expect(run('bus.NoSuch()', state)).rejects.toThrow(
      /Unknown chain method "NoSuch" on mixer bus "aux-bus-0"/,
    )
  })

  it('keeps every curated DSL name backed by a real receiver method', () => {
    for (const name of SEQUENCE_DSL_METHODS)
      expect(typeof Sequence.prototype[name as keyof Sequence]).toBe('function')
    for (const name of GLOBAL_DSL_METHODS)
      expect(typeof Global.prototype[name as keyof Global]).toBe('function')
    const bus = new Global(new RecordingScheduler()).aux('probe')
    for (const name of BUS_DSL_METHODS)
      expect(typeof bus[name as keyof typeof bus]).toBe('function')
  })

  it('classifies every public receiver method as DSL vocabulary or an explicit internal API', () => {
    const sequenceInternalMethods = new Set([
      'constructor',
      // Timing and loop-scheduling internals.
      'resolveQuantize',
      'nextQuantizedTime',
      'setName',
      'recalculateTiming',
      'seamlessParameterUpdate',
      'restartLoopFromCurrentTime',
      // Output, engine-mode, and audio-buffer internals.
      'getOutputChannel',
      'syncBusRouting',
      'isMidi',
      'isInstrument',
      'getInsertBus',
      'isNoteSequence',
      'loadAudio',
      'prepareSlices',
      'activeScheduler',
      'clearEvents',
      // Tonal-context and voice-leading internals.
      'baseOctave',
      'resolveRootContext',
      'degreeRootToPitchClass',
      'resolveScopeToContext',
      'validateMidiDispatch',
      'applyVoiceLeading',
      'validateNonMidiDispatch',
      'containsStack',
      // MIDI/event scheduling internals.
      'scheduleMidiEvents',
      'resolveNoteTarget',
      'resolveOutputDetune',
      'makeTiePlan',
      'absorbEventTies',
      'applyGateAndLegato',
      'applyVoiceTiesAndHold',
      'scheduleEventsFromTime',
      'resolveDispatchChannel',
      'scheduleEvents',
      // Runtime timing notifications and state inspection.
      'getPatternDuration',
      'notifyGlobalTempoChange',
      'notifyGlobalBeatChange',
      'getState',
    ])
    const globalInternalMethods = new Set([
      'constructor',
      // MIDI, chord, pattern, and mode registries.
      'getMidiManager',
      'importChords',
      'defineChord',
      'setChord',
      'getChordVoices',
      'definePattern',
      'defineMode',
      'getBinding',
      // Audio resolution and mixer-runtime plumbing.
      'resolveAudioSpec',
      'isLinkAudioEnabled',
      'declareMixerRuntime',
      'sequenceEffect',
      'ensureSequenceInsertBus',
      'resolveSumBus',
      'resolveAuxBus',
      'setBusRouting',
      // Transport timing and host integration.
      'pushLinkTempoIfLeading',
      'getQuantize',
      'setDocumentDirectory',
      'getMasterGainDb',
      'setTransportHooks',
      'getTransportPosition',
      'getQuantizedEffectPosition',
      'transportParams',
      'msToBarBeat',
      // Sequence registry, scheduler access, and state inspection.
      'registerSequence',
      'getSequence',
      'seq',
      'getScheduler',
      'getMidiTransport',
      'isTransportRunning',
      'getState',
    ])

    for (const name of Object.getOwnPropertyNames(Sequence.prototype)) {
      expect(
        SEQUENCE_DSL_METHODS.has(name) || sequenceInternalMethods.has(name),
        `unclassified Sequence method: ${name}`,
      ).toBe(true)
    }
    for (const name of Object.getOwnPropertyNames(Global.prototype)) {
      expect(
        GLOBAL_DSL_METHODS.has(name) || globalInternalMethods.has(name),
        `unclassified Global method: ${name}`,
      ).toBe(true)
    }
  })
})
