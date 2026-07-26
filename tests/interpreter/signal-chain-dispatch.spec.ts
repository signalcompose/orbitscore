import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { EffectSlotLimitError } from '../../packages/engine/src/core/global/effect-slot'
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
          name: 'TAL-Reverb-4',
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

  it('dispatches normalized plugin method names across divergent per-format display names', async () => {
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

    expect(effect.mock.calls).toEqual([['TAL Reverb 4'], ['vst3/TAL-Reverb-4'], ['B/Twin']])
    expect(busEffect).toHaveBeenCalledWith('TAL Reverb 4')
  })

  it('requires quoted string selectors and rejects duplicate reserved arguments', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq', state)
    const effect = vi
      .spyOn(state.sequences.get('kick')!, 'effect')
      .mockResolvedValue(state.sequences.get('kick')!)

    await expect(run('kick.TALReverb4(format: vst3)', state)).rejects.toThrow(
      /format:.*string literal.*format: "vst3"/i,
    )
    expect(effect).not.toHaveBeenCalled()

    await run('kick.TALReverb4(format: "vst3")', state)
    expect(effect).toHaveBeenCalledWith('vst3/TAL-Reverb-4')

    await expect(run('kick.TALReverb4(format: "clap", format: "vst3")', state)).rejects.toThrow(
      /duplicate named argument "format:"/i,
    )
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
      /named argument "format:".*string-form effect\(\).*Name\(format: "vst3"\)/i,
    )
    // `sidechain:` / `outs:` on a curated DSL method take the same route
    // (resolveChainDispatch → callMethod → processArguments), but were only
    // covered by a direct processArguments() unit call. Exercising them through
    // run() catches a future resolver-wiring change that diverts named args
    // before they reach processArguments — which the unit test cannot see.
    await expect(run('kick.gain(sidechain: duck)', state)).rejects.toThrow(
      /sidechain routing arrives in #409/,
    )
    await expect(run('kick.gain(outs: 4)', state)).rejects.toThrow(
      /multi-output routing arrives in #409/,
    )
  })

  it('distinguishes a missing plugin catalog from an unknown plugin method', async () => {
    process.env.ORBIT_PLUGIN_CATALOG = path.join(directory, 'missing-catalog.json')
    clearPluginCatalogCache()
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq', state)

    await expect(run('kick.TALReverb4()', state)).rejects.toThrow(
      /Plugin catalog not found.*orbit-plugin-scan.*typo/,
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
      .mockRejectedValueOnce(new EffectSlotLimitError('one insert per bus in v1'))

    await expect(run('kick.NoSuch()', state)).rejects.toThrow(/Unknown chain method "NoSuch"/)
    await expect(run('kick.TALReverb4(mix: 0.5)', state)).rejects.toThrow(/S4/)
    await expect(run('kick.TALReverb4(preset: "Wide")', state)).rejects.toThrow(/S4/)
    await expect(run('kick.TALReverb4(enabled: false)', state)).rejects.toThrow(/S4/)
    await expect(run('kick.TALReverb4(sidechain: missing)', state)).rejects.toThrow(
      /not a declared aux/,
    )
    await expect(run('kick.TALReverb4(sidechain: "duck")', state)).rejects.toThrow(
      /sidechain:.*identifier.*sidechain: duck/i,
    )
    // Anchored on the argument name, not just the issue number: both cite #409
    // (it covers sidechain AND multi-out), so a bare /#409/ would still pass if
    // the two branches' messages were swapped.
    await expect(run('kick.TALReverb4(sidechain: duck)', state)).rejects.toThrow(
      /^sidechain:.*#409/,
    )
    await expect(run('kick.TALReverb4(outs: 4)', state)).rejects.toThrow(/^outs:.*#409/)
    await expect(run('kick.drums()', state)).rejects.toThrow(/sum.*send|send.*sum/i)
    await run('kick.TALReverb4()', state)
    await expect(run('kick.TALReverb4()', state)).rejects.toThrow(/S4.*multiple insert/i)
  })

  it('routes bare sum/output and called aux names, awaiting the daemon result', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run(
      'var kick = init global.seq\nvar mix = init global.mixer\nvar master = mix.output(1, 2)\nvar drums = mix.sum\nvar verb = mix.aux',
      state,
    )
    const routing = vi.spyOn(global, 'setBusRouting').mockResolvedValue(undefined)

    await run('kick.verb(0.37).drums\nkick.master', state)

    expect(routing.mock.calls).toEqual([
      ['seq-bus-0', undefined, [{ bus: 'aux-bus-0', gain: 0.37 }]],
      ['seq-bus-0', 'sum-bus-0', [{ bus: 'aux-bus-0', gain: 0.37 }]],
      ['seq-bus-0', 'master', [{ bus: 'aux-bus-0', gain: 0.37 }]],
    ])
  })

  it('supports named send arguments and routing from a mixer bus receiver', async () => {
    const scheduler = new RecordingScheduler() as RecordingScheduler & {
      setBusRouting: ReturnType<typeof vi.fn>
      loadPlugin: ReturnType<typeof vi.fn>
    }
    scheduler.setBusRouting = vi.fn().mockResolvedValue(undefined)
    scheduler.loadPlugin = vi.fn().mockResolvedValue({})
    const global = new Global(scheduler)
    const state = makeState(global)
    await run(
      'var kick = init global.seq\nvar mix = init global.mixer\nvar master = mix.output(1, 2)\nvar drums = mix.sum\nvar verb = mix.aux',
      state,
    )
    await run('kick.verb(amount: 0.8, enabled: false)\nverb.TALReverb4().master', state)

    expect(scheduler.setBusRouting).toHaveBeenNthCalledWith(1, 'seq-bus-0', undefined, [
      { bus: 'aux-bus-0', gain: 0 },
    ])
    expect(scheduler.setBusRouting).toHaveBeenNthCalledWith(2, 'aux-bus-0', 'master', [])
  })

  it('keeps bare DSL methods on callMethod while rejecting bare plugin and kind mismatches', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run(
      'var kick = init global.seq\nvar mix = init global.mixer\nvar drums = mix.sum\nvar verb = mix.aux',
      state,
    )
    const unmute = vi.spyOn(state.sequences.get('kick')!, 'unmute')

    await run('kick.unmute', state)
    expect(unmute).toHaveBeenCalledOnce()
    await expect(run('kick.TALReverb4', state)).rejects.toThrow(/TALReverb4\(\)/)
    await expect(run('kick.verb', state)).rejects.toThrow(/aux.*parentheses|parentheses.*aux/i)
    await expect(run('kick.drums(0.3)', state)).rejects.toThrow(/sum.*send|send.*sum/i)
  })

  it('makes string-form bus declarations visible only to their owning Global', async () => {
    const g1 = new Global(new RecordingScheduler())
    const g2 = new Global(new RecordingScheduler())
    const state = makeState(g1)
    state.globals.set('g1', g1)
    state.globals.set('g2', g2)
    await run('var kick = init g1.seq\ng1.sum("drums")\ng2.sum("other")', state)
    const routing = vi.spyOn(g1, 'setBusRouting').mockResolvedValue(undefined)

    await run('kick.drums', state)
    expect(routing).toHaveBeenCalledWith('seq-bus-0', 'sum-bus-0', [])
    await expect(run('kick.other', state)).rejects.toThrow(/Unknown chain method "other"/)
  })

  it('requires an explicit amount on an aux send rather than defaulting one', async () => {
    // SC.4 norm 1 calls an aux-name method "the one that takes a quantity". A
    // silent default would make `kick.verb()` mean something the user never
    // wrote, so the omission is an error (SC.3.3).
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq\nvar mix = init global.mixer\nvar verb = mix.aux', state)
    const routing = vi.spyOn(global, 'setBusRouting').mockResolvedValue(undefined)

    await expect(run('kick.verb()', state)).rejects.toThrow(/requires a numeric amount/)
    await expect(run('kick.verb(enabled: false)', state)).rejects.toThrow(
      /requires a numeric amount/,
    )
    expect(routing).not.toHaveBeenCalled()

    await run('kick.verb(0.3)', state)
    expect(routing).toHaveBeenCalledOnce()
  })

  it('lets a string-form bus declaration coexist with the implicit master', async () => {
    // The implicit master(1,2) is suppressed only by an EXPLICIT mixer node
    // (SC.2 norm 6). Counting string-form declarations as "explicit" would make
    // `global.sum("drums")` silently remove `master` from the chain vocabulary
    // of a file that never declared a mixer — a compatibility break.
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq\nglobal.sum("drums")', state)
    const routing = vi.spyOn(global, 'setBusRouting').mockResolvedValue(undefined)

    await run('kick.drums', state)
    await run('kick.master', state)
    expect(routing.mock.calls).toEqual([
      ['seq-bus-0', 'sum-bus-0', []],
      ['seq-bus-0', 'master', []],
    ])
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
      'getGlobal',
      'routeOutputFromDsl',
      'routeSendFromDsl',
      'pushBusRouting',
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
      'resolveMixerBus',
      'ownsMixerBus',
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
