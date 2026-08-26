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

  it('rejects an ambiguous bare mixer receiver declared by both string forms', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await run('global.sum("drum")\nglobal.aux("drum")', state)

      await expect(run('drum.TALReverb4()', state)).rejects.toThrow(
        /global\.sum\("drum"\).*global\.aux\("drum"\)/,
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects an ambiguous bare mixer name reached as a sequence chain method (#579)', async () => {
    // Third resolution path to MixerManager.resolveNode(): a sequence chaining
    // to the bare bus name (`kick.drum()`), dispatched via resolveChainDispatch
    // — distinct from the statement-target path (`drum.TALReverb4()`, above)
    // and the `sidechain:` path (below). Review round 1 proved by mutation
    // that swallowing the resolver throw at this call site left the entire
    // suite green: this test is the only guard on that path.
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await run('var kick = init global.seq\nglobal.sum("drum")\nglobal.aux("drum")', state)

      await expect(run('kick.drum()', state)).rejects.toThrow(
        /global\.sum\("drum"\).*global\.aux\("drum"\)/,
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('warns once and keeps the resolver loud when the sum half comes from a node declaration (#579 mixed form)', async () => {
    // `var drum = mix.sum` goes through the same Global.sum() the string form
    // uses, so declaring the OTHER kind as a string afterwards must trip the
    // same second-kind warning and the same resolveNode() ambiguity throw —
    // "one check covers both the string form and the node-declaration form".
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await run(
        'var kick = init global.seq\nvar mix = init global.mixer\nvar drum = mix.sum\nglobal.aux("drum")',
        state,
      )

      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ambiguous.*both sum and aux/i))
      // The string-form resolver throws even though the sum half was declared
      // via the node form. The DSL chain path cannot reach this throw while
      // the node variable is registered — the runtime registry wins (that
      // shadowing is the escape hatch; the rescue test below pins it down).
      expect(() => global.resolveMixerBus('drum')).toThrow(
        /global\.sum\("drum"\).*global\.aux\("drum"\)/,
      )
      // And the node variable keeps the bare name usable: it resolves to the
      // kind the variable picked, not to an error.
      const routing = vi.spyOn(global, 'setBusRouting').mockResolvedValue(undefined)
      await run('kick.drum', state)
      expect(routing).toHaveBeenCalledTimes(1)
      expect(routing).toHaveBeenCalledWith('seq-bus-0', 'sum-bus-0', [])
    } finally {
      warn.mockRestore()
    }
  })

  it('declaring a kind-specific node variable rescues an ambiguous bare name (#579 registry priority)', async () => {
    // The ambiguity diagnostic promises two escape hatches; the node-variable
    // one works because resolveMixerNode() consults the runtime registry
    // BEFORE the throwing string-form resolver (signal-chain/runtime.ts). This
    // is the only test standing on that half of the promise — the string-form
    // half is covered by the explicit resolveSumBus()/resolveAuxBus() suites.
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await run('var kick = init global.seq\nglobal.sum("drums")\nglobal.aux("drums")', state)
      await expect(run('kick.drums', state)).rejects.toThrow(
        /global\.sum\("drums"\).*global\.aux\("drums"\)/,
      )

      await run('var mix = init global.mixer\nvar drums = mix.sum', state)
      const routing = vi.spyOn(global, 'setBusRouting').mockResolvedValue(undefined)
      await run('kick.drums', state)
      expect(routing).toHaveBeenCalledTimes(1)
      expect(routing).toHaveBeenCalledWith('seq-bus-0', 'sum-bus-0', [])
    } finally {
      warn.mockRestore()
    }
  })

  it('reports an ambiguous sidechain name before the aux-only validation error', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await run('var kick = init global.seq\nglobal.sum("drum")\nglobal.aux("drum")', state)

      let thrown: unknown
      try {
        await run('kick.TALReverb4(sidechain: drum)', state)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(/global\.sum\("drum"\).*global\.aux\("drum"\)/)
      expect((thrown as Error).message).not.toMatch(/not a declared aux/i)
    } finally {
      warn.mockRestore()
    }
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

  it('replaces a second real effect declaration instead of reaching the S4 limit rewrite', async () => {
    // Stage B makes every production effect manager replacement-enabled, so a
    // different second spec can no longer reach EffectSlotLimitError. Keep the
    // synthetic typed-error rewrite coverage above, and pin the now-real path here.
    const scheduler = new RecordingScheduler() as RecordingScheduler & {
      loadPlugin: ReturnType<typeof vi.fn>
      replacePlugin: ReturnType<typeof vi.fn>
    }
    scheduler.loadPlugin = vi.fn().mockResolvedValue({})
    scheduler.replacePlugin = vi.fn().mockResolvedValue({
      pluginId: 'replacement-id',
      pluginName: 'Replacement',
      notePortIndex: 0,
      quarantinedSlot: false,
    })
    const global = new Global(scheduler)
    const state = makeState(global)
    await run('var kick = init global.seq', state)

    await run('kick.TALReverb4()', state)
    await expect(run('kick.Twin(vendor: "A")', state)).resolves.toBeUndefined()
    expect(scheduler.loadPlugin).toHaveBeenCalledTimes(1)
    expect(scheduler.replacePlugin).toHaveBeenCalledTimes(1)
    expect(scheduler.replacePlugin).toHaveBeenCalledWith('/a.clap', 'a', 'effect', 'seq-bus-0')
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

  it('rejects routing to a declared non-master output instead of silently rerouting to master', async () => {
    // Regression (#523 CRITICAL 2): the output-endpoint branch used to look only
    // at `dispatch.node.kind === 'output'` and always route to 'master',
    // ignoring the node's declared channels. A user routing to a physical
    // multi-output endpoint (channels other than 1,2) would have their audio
    // silently sent to master instead of erroring.
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run(
      'var kick = init global.seq\nvar mix = init global.mixer\nvar hp1 = mix.output(3, 4)',
      state,
    )
    const routing = vi.spyOn(global, 'setBusRouting').mockResolvedValue(undefined)

    await expect(run('kick.hp1', state)).rejects.toThrow(/hp1.*3.*4.*#484 D4/s)
    expect(routing).not.toHaveBeenCalled()

    // The master endpoint (channels 1,2) is the only one allowed in S3.
    await run('var master = mix.output(1, 2)\nkick.master', state)
    expect(routing).toHaveBeenCalledWith('seq-bus-0', 'master', [])
  })

  it('requires parentheses for a bare Global DSL method, but keeps transport bare', async () => {
    // Regression (#523, bot review): before S3, a bare non-transport call on a
    // Global hit `handleGlobalTransportCommand`'s `default` arm, which warned and
    // never invoked the method. S3 routes every bare first hop through the chain
    // dispatcher, so a dropped `(20)` in `global.midiLatency(20)` silently called
    // `midiLatency(undefined)` — reproduced, along with `global.key` crashing
    // inside `name.match(...)`. Sequences must keep bare DSL methods working
    // (`kick.unmute`), so the guard is Global-only.
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)

    await expect(run('global.midiLatency', state)).rejects.toThrow(/requires parentheses/)
    await expect(run('global.key', state)).rejects.toThrow(/requires parentheses/)
    await expect(run('global.audioDevice', state)).rejects.toThrow(/requires parentheses/)

    // Transport stays bare, and the parenthesised form is unaffected.
    await expect(run('global.tempo(120)', state)).resolves.not.toThrow()
  })

  it('accepts the host-injected global.setDocumentDirectory(...) as DSL', async () => {
    // Regression (#523, from #519 S2): the extension prepends
    // `global.setDocumentDirectory("<dir>")` to every evaluation so `audio()`
    // resolves relative to the edited file, and the MCP evaluate path mirrors it.
    // `setDocumentDirectory` was classified as an internal API rather than DSL
    // vocabulary, so S2's "unknown method is an explicit error" rejected the
    // injected line — breaking EVERY editor evaluation while the suite stayed
    // green (the reverse-direction test only checks that each method is
    // classified, not that the classification is right). Found by driving the
    // real app, not by a test.
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await expect(
      run('global.setDocumentDirectory("/tmp/orbitscore-doc-dir")', state),
    ).resolves.not.toThrow()
  })

  it('rejects an output whose left channel is 1 but whose right channel is not 2', async () => {
    // The case above only exercises `left !== 1` (channels 3,4), so relaxing the
    // guard to `if (left !== 1)` alone leaves the suite green — the right-channel
    // half of the comparison goes unverified (found by mutating it in review
    // round 2). `mix.output(1, 3)` shares master's left channel without being
    // master, so it pins the other half.
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run(
      'var kick = init global.seq\nvar mix = init global.mixer\nvar odd = mix.output(1, 3)',
      state,
    )
    const routing = vi.spyOn(global, 'setBusRouting').mockResolvedValue(undefined)

    await expect(run('kick.odd', state)).rejects.toThrow(/odd.*1.*3.*#484 D4/s)
    expect(routing).not.toHaveBeenCalled()
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

  it('forwards invocation on the Global receiver path, rejecting a bare plugin name', async () => {
    // Regression (#523 CRITICAL 1): processGlobalStatement used to call
    // applyMethodChain without forwarding `invocation`, so a bare Global plugin
    // reference silently defaulted to 'call' and skipped the parentheses guard.
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    const effect = vi.spyOn(global, 'effect')

    await expect(run('global.TALReverb4', state)).rejects.toThrow(/TALReverb4\(\)/)
    expect(effect).not.toHaveBeenCalled()
  })

  it('forwards invocation on the mixer-node receiver path, accepting a bare master hop', async () => {
    // Regression (#523 CRITICAL 1): processMixerNodeStatement used to call
    // applyMethodChain without forwarding `invocation`, so a legitimate bare
    // `verb.master` (verb itself being the statement target, a declared mixer
    // node) was wrongly rejected as "an output, not a send."
    const scheduler = new RecordingScheduler() as RecordingScheduler & {
      setBusRouting: ReturnType<typeof vi.fn>
    }
    scheduler.setBusRouting = vi.fn().mockResolvedValue(undefined)
    const global = new Global(scheduler)
    const state = makeState(global)
    await run(
      'var mix = init global.mixer\nvar master = mix.output(1, 2)\nvar verb = mix.aux',
      state,
    )

    await run('verb.master', state)
    expect(scheduler.setBusRouting).toHaveBeenCalledWith('aux-bus-0', 'master', [])

    // The called form must still be rejected: master is an output, not a send.
    await expect(run('verb.master()', state)).rejects.toThrow(
      /output.*not a send|not a send.*output/i,
    )
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

  it('rejects a duplicate aux amount instead of silently letting one overwrite the other', async () => {
    // Regression (#523 CRITICAL 4): the aux-send arg loop assigned `amount`
    // unconditionally whenever it saw a bare number or a named `amount:`, so a
    // second specification silently won — with the two call orders disagreeing
    // about which value survived.
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq\nvar mix = init global.mixer\nvar verb = mix.aux', state)
    const routing = vi.spyOn(global, 'setBusRouting').mockResolvedValue(undefined)

    await expect(run('kick.verb(0.3, amount: 0.9)', state)).rejects.toThrow(/duplicate.*amount/i)
    await expect(run('kick.verb(amount: 0.9, 0.3)', state)).rejects.toThrow(/duplicate.*amount/i)
    await expect(run('kick.verb(amount: 0.3, amount: 0.5)', state)).rejects.toThrow(
      /duplicate.*amount/i,
    )
    await expect(run('kick.verb(0.3, enabled: false, enabled: true)', state)).rejects.toThrow(
      /duplicate.*enabled/i,
    )
    expect(routing).not.toHaveBeenCalled()
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

  it('rejects a Global routing to a bus by bare bus name as a permanent, non-staged error (#523 MINOR 10)', async () => {
    // Sources of mixer routing are Sequences and mixer buses only
    // (SIGNAL_CHAIN_DSL_SPEC_v1 §SC.0/SC.4); a Global is the console itself
    // and never a routing source, so `global.drums` must reject permanently
    // rather than with a staged "#517" message this PR itself is part of.
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var mix = init global.mixer\nvar drums = mix.sum', state)

    await expect(run('global.drums', state)).rejects.toThrow(
      /Sequences and mixer buses only.*Global.*drums/i,
    )
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

  it('R23a dispatches global.remove through the Global DSL vocabulary', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    const remove = vi.spyOn(global, 'remove').mockResolvedValue(global)

    await run('global.remove("old")', state)

    expect(remove).toHaveBeenCalledWith('old')
  })

  it('R23b dispatches kick.remove through the Sequence DSL vocabulary', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    await run('var kick = init global.seq', state)
    const kick = state.sequences.get('kick')!
    const remove = vi.spyOn(kick, 'remove').mockResolvedValue(kick)

    await run('kick.remove("old")', state)

    expect(remove).toHaveBeenCalledWith('old')
  })

  it('R23c dispatches sum.remove through the bus DSL vocabulary', async () => {
    const global = new Global(new RecordingScheduler())
    const state = makeState(global)
    const bus = global.sum('drums')
    const remove = vi.spyOn(bus, 'remove').mockResolvedValue(bus)
    vi.spyOn(global, 'sum').mockReturnValue(bus)

    await run('global.sum("drums").remove("old")', state)

    expect(remove).toHaveBeenCalledWith('old')
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
      // #598 P1: 数値 output(1..16) が選んだ score-mode の render bus を読む純アクセサ。
      // `output()` という DSL 語彙が書き込み、RenderScore manifest の生成側が読む
      // （インタプリタからの参照はゼロ）。DSL 語彙ではない。
      'getRenderBus',
      'getGlobal',
      'routeOutputFromDsl',
      'routeSendFromDsl',
      'pushBusRouting',
      'syncBusRouting',
      'isMidi',
      'isInstrument',
      // #562: index 0 が組み込みオーディオソースに占有されているかの判定。
      // UIH.5「audio シーケンスの index 0 はアドレス不可」のエラー理由を出し分けるために
      // global.ts が呼ぶ内部ヘルパで、DSL 語彙ではない（インタプリタからの参照はゼロ）。
      'hasAudioSource',
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
      // #562: plugin state の明示保存経路。**DSL 語彙ではない** —
      // REPL のメタ行 `//#savePluginState`（MCP bridge が発行）からのみ入る。
      // DSL から書けてしまうと「保存」という副作用が楽譜に紛れ込むため、意図的に語彙にしない。
      'savePluginState',
      // #474 P4c: UI 開閉。同じく DSL 語彙ではないが、入口は別のメタ行
      // `//#pluginUi`（JSON payload の action で open/close を区別。MCP bridge が発行）。
      'openPluginUi',
      'closePluginUi',
      // #619: `seq.ui()` の冪等判定に使う問い合わせ。DSL から直接は呼ばせない。
      'hasOpenPluginUi',
      // #619 R2: 冪等 open の集約実装。seq.ui() / //#pluginUi の両方がここへ委譲する。
      'openPluginUiIdempotent',
      // #618 PR-2: 差し替え前の後始末（UI close → state 保存）。private だが
      // Object.getOwnPropertyNames には現れる（他の private 同様に除外）。
      // PluginInstrumentManager からコールバック注入で呼ばれ、DSL からは到達しない。
      'prepareInstrumentReplacement',
      // #625 Stage B: effect manager 3系統へ注入する差し替え前処理。
      // private で、DSL / interpreter からは直接呼ばれない。
      'prepareEffectReplacement',
      // #618 PR-2: 曖昧な close 失敗で UI 簿記を忘れるヘルパ。fast-path が stale を
      // 恒久的に信じるのを防ぐ（#619 と同型の穴）。DSL 語彙ではない。
      'forgetPluginUiSession',
      // #618 PR-2 R2: 「already open を成功扱い」した時に簿記を戻すヘルパ。
      // 忘れた後の回復経路を実在させるためのもの。DSL 語彙ではない。
      'recordPluginUiSession',
      // (sequence, index) を SC.5 インスタンス同一性 + daemon target へ解決する内部 API。
      // UIH.5 の index 規則を実装する。インタプリタからの参照はゼロ。
      'resolvePluginStateTarget',
      // private だが Object.getOwnPropertyNames には現れる（他の private 同様に除外）。
      'pluginIndexError',
      'formatPluginIndices',
      'pluginUiOperationError',
      // resolvePluginStateTarget の bus 分岐（master / sum: / aux:）を担う private ヘルパー。
      'pluginStateBusChain',
      // #577 PR-A: 停止時 auto-snapshot のホスト API。どちらも `this` 経由で
      // 各 manager を読むためクラス外へ出せない（純関数の
      // `pluginStateTargetForSlot` はモジュール関数として分類対象外にしてある）。
      'listPluginStateTargets',
      // PluginUiClosed の daemon target/index を現在の chain に照合し、同じ保存経路へ渡す
      // safepoint conductor 内部 API。DSL 語彙としては公開しない。
      'listPluginUiStateTargets',
      'savePluginUiStateAtSafepoint',
      'saveAllPluginStates',
      // 同上。`this.projectStateStores` の Map をキャッシュとして読むため純関数化できない。
      'projectStateStore',
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
      'sequenceEffectRemove',
      'ensureSequenceInsertBus',
      'resolveSumBus',
      'resolveAuxBus',
      'resolveMixerBus',
      'ownsMixerBus',
      'setBusRouting',
      // Transport timing and host integration.
      'pushLinkTempoIfLeading',
      'getQuantize',
      // `setDocumentDirectory` deliberately NOT listed here: the host injects it
      // as DSL source, so it belongs to GLOBAL_DSL_METHODS. Listing it here is
      // what let the runtime break while this test stayed green (#523).
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

    expect(
      [...GLOBAL_DSL_METHODS].filter((name) => globalInternalMethods.has(name)),
      'Global DSL vocabulary and internal-only API classifications must be disjoint',
    ).toEqual([])
  })

  it('keeps plugin-state host APIs out of the Global DSL vocabulary', () => {
    const internalOnlyNames = [
      'savePluginState',
      'openPluginUi',
      'closePluginUi',
      // #619: `seq.ui()` の冪等判定に使う問い合わせ。DSL から直接は呼ばせない。
      'hasOpenPluginUi',
      // #619 R2: 冪等 open の集約実装。seq.ui() / //#pluginUi の両方がここへ委譲する。
      'openPluginUiIdempotent',
      // #618 PR-2: 差し替え前の後始末（UI close → state 保存）。private だが
      // Object.getOwnPropertyNames には現れる（他の private 同様に除外）。
      // PluginInstrumentManager からコールバック注入で呼ばれ、DSL からは到達しない。
      'prepareInstrumentReplacement',
      // #625 Stage B: private な effect 差し替え前処理。DSL 語彙ではない。
      'prepareEffectReplacement',
      // #618 PR-2: 曖昧な close 失敗で UI 簿記を忘れるヘルパ。fast-path が stale を
      // 恒久的に信じるのを防ぐ（#619 と同型の穴）。DSL 語彙ではない。
      'forgetPluginUiSession',
      // #618 PR-2 R2: 「already open を成功扱い」した時に簿記を戻すヘルパ。
      // 忘れた後の回復経路を実在させるためのもの。DSL 語彙ではない。
      'recordPluginUiSession',
      'resolvePluginStateTarget',
      'pluginIndexError',
    ] as const

    for (const name of internalOnlyNames) {
      expect(GLOBAL_DSL_METHODS.has(name), `${name} must remain an internal-only API`).toBe(false)
    }
  })
})
