import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import {
  createImportContext,
  declaredNames,
  processFileImports,
} from '../../packages/engine/src/interpreter/process-file-import'
import {
  processGlobalInit,
  processSequenceInit,
} from '../../packages/engine/src/interpreter/process-initialization'
import {
  processGlobalStatement,
  processSequenceStatement,
  processStatement,
} from '../../packages/engine/src/interpreter/process-statement'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import {
  createMixerRuntimeRegistry,
  resolveMixerNode,
} from '../../packages/engine/src/signal-chain/runtime'
import { RecordingScheduler } from '../audio/verify/recording-scheduler'

function stateWith(global: Global) {
  return {
    globals: new Map([['global', global]]),
    sequences: new Map(),
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

async function run(source: string, state: ReturnType<typeof stateWith>): Promise<void> {
  const ir = parseAudioDSL(source)
  if (ir.globalInit) await processGlobalInit(ir.globalInit, state)
  for (const init of ir.sequenceInits) await processSequenceInit(init, state)
  for (const statement of ir.statements) {
    await processStatement(statement, state)
  }
}

describe('Signal Chain mixer runtime namespace (SC.2)', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('maps mixer handles and sum/aux nodes onto the existing Global primitives idempotently', async () => {
    const global = new Global(new RecordingScheduler())
    const sum = vi.spyOn(global, 'sum')
    const aux = vi.spyOn(global, 'aux')
    const state = stateWith(global)

    await run('var mix = init global.mixer\nvar drums = mix.sum\nvar verb = mix.aux', state)
    const firstHandle = state.mixers.handles.get('mix')
    const firstSum = state.mixers.nodes.get('drums')
    await run('var mix = init global.mixer\nvar drums = mix.sum\nvar verb = mix.aux', state)

    expect(state.mixers.handles.get('mix')).toBe(firstHandle)
    expect(state.mixers.nodes.get('drums')).toBe(firstSum)
    expect(sum).toHaveBeenCalledTimes(1)
    expect(aux).toHaveBeenCalledTimes(1)
  })

  it('resolves implicit master lazily across incremental evaluations', async () => {
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)

    expect(resolveMixerNode(state.mixers, 'master', global)).toMatchObject({
      kind: 'output',
      channels: [1, 2],
    })
    await run('var mix = init global.mixer', state)
    expect(resolveMixerNode(state.mixers, 'master', global)).toBeDefined()
    await run('var verb = mix.aux', state)
    expect(resolveMixerNode(state.mixers, 'master', global)).toBeUndefined()
  })

  it('dispatches a declared bus receiver and throws for unknown receivers', async () => {
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    await run('var mix = init global.mixer\nvar verb = mix.aux', state)
    const node = state.mixers.nodes.get('verb')
    expect(node?.kind).toBe('aux')
    const effect = vi.spyOn((node as Extract<typeof node, { kind: 'aux' }>).handle, 'effect')
    effect.mockResolvedValue((node as Extract<typeof node, { kind: 'aux' }>).handle)

    await run('verb.effect("Reverb.clap")', state)
    expect(effect).toHaveBeenCalledWith('Reverb.clap')
    await expect(run('missing.effect("x")', state)).rejects.toThrow('Variable not found: missing')
  })

  it.each(['sum', 'aux'] as const)(
    'rejects unsupported methods on a declared %s bus, including chained calls',
    async (kind) => {
      const global = new Global(new RecordingScheduler())
      const state = stateWith(global)
      await run(`var mix = init global.mixer\nvar bus = mix.${kind}`, state)

      await expect(run('bus.gain(0.5)', state)).rejects.toThrow(/S2.*S3.*#517/)
      await expect(run('bus.effect("x").gain(0.5)', state)).rejects.toThrow(/S2.*S3.*#517/)
    },
  )

  it.each(['sum', 'aux'] as const)(
    'rejects unsupported methods on a string-form %s bus',
    async (kind) => {
      const global = new Global(new RecordingScheduler())
      const state = stateWith(global)

      await expect(run(`${kind}("bus").gain(0.5)`, state)).rejects.toThrow(/S2.*S3.*#517/)
    },
  )

  it.each(['sum', 'aux'] as const)(
    'rejects unsupported methods on a target-prefixed %s bus',
    async (kind) => {
      const global = new Global(new RecordingScheduler())
      const state = stateWith(global)

      await expect(run(`global.${kind}("bus").gain(0.5)`, state)).rejects.toThrow(/S2.*S3.*#517/)
    },
  )

  it('dispatches effect() on target-prefixed sum and aux buses', async () => {
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    const sumHandle = global.sum('drums')
    const auxHandle = global.aux('verb')
    const sumEffect = vi.spyOn(sumHandle, 'effect').mockResolvedValue(sumHandle)
    const auxEffect = vi.spyOn(auxHandle, 'effect').mockResolvedValue(auxHandle)
    vi.spyOn(global, 'sum').mockReturnValue(sumHandle)
    vi.spyOn(global, 'aux').mockReturnValue(auxHandle)

    await run('global.sum("drums").effect("Comp.clap")', state)
    await run('global.aux("verb").effect("Reverb.clap")', state)

    expect(sumEffect).toHaveBeenCalledWith('Comp.clap')
    expect(auxEffect).toHaveBeenCalledWith('Reverb.clap')
  })

  it('rejects a bus chain before any of its calls run, on every entry form', async () => {
    // The gate is atomic: nothing in the chain executes when a later method is
    // unsupported, so no plugin is loaded and no bus pool slot is consumed.
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    await run('var mix = init global.mixer\nvar verb = mix.aux', state)
    const node = state.mixers.nodes.get('verb')
    const declaredEffect = vi.spyOn(
      (node as Extract<typeof node, { kind: 'aux' }>).handle,
      'effect',
    )

    await expect(run('verb.effect("Reverb.clap").gain(0.5)', state)).rejects.toThrow(/#517/)
    expect(declaredEffect).not.toHaveBeenCalled()

    const sum = vi.spyOn(global, 'sum')
    await expect(run('sum("drums").gain(0.5)', state)).rejects.toThrow(/#517/)
    await expect(run('global.sum("drums").gain(0.5)', state)).rejects.toThrow(/#517/)
    expect(sum).not.toHaveBeenCalled()
  })

  it('leaves non-bus chains untouched by the bus gate', async () => {
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    await run('var kick = init global.seq', state)

    // `gain` is unsupported on a bus but must stay a plain (non-throwing) call
    // everywhere else: the gate keys off the receiver, not the method name.
    await run('global.tempo(120).beat(4 by 4)', state)
    await run('kick.gain(0.5)', state)
    expect(global.tempo()).toBe(120)
  })

  it('dispatches effect() on string-form sum and aux buses', async () => {
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    const sumHandle = global.sum('drums')
    const auxHandle = global.aux('verb')
    const sumEffect = vi.spyOn(sumHandle, 'effect').mockResolvedValue(sumHandle)
    const auxEffect = vi.spyOn(auxHandle, 'effect').mockResolvedValue(auxHandle)
    vi.spyOn(global, 'sum').mockReturnValue(sumHandle)
    vi.spyOn(global, 'aux').mockReturnValue(auxHandle)

    await run('sum("drums").effect("Comp.clap")', state)
    await run('aux("verb").effect("Reverb.clap")', state)

    expect(sumEffect).toHaveBeenCalledWith('Comp.clap')
    expect(auxEffect).toHaveBeenCalledWith('Reverb.clap')
  })

  it('refuses to use any output endpoint as a receiver, including the implicit master', async () => {
    // SC.3.3 forbids swallowing what the user wrote: an output endpoint has no
    // receiver surface until #484 D4, so it must throw rather than resolve to an
    // inert object that callMethod would silently no-op on.
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    await expect(run('master.effect("Reverb.clap")', state)).rejects.toThrow('#484 D4')

    await run('var mix = init global.mixer\nvar main = mix.output(1, 2)', state)
    await expect(run('main.effect("Reverb.clap")', state)).rejects.toThrow('#484 D4')
  })

  it('rejects invalid bases, duplicate kinds, and methods on declared output endpoints', async () => {
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    await expect(run('var verb = nope.aux', state)).rejects.toThrow('not a mixer handle')
    await run('var mix = init global.mixer\nvar bus = mix.sum', state)
    await expect(run('var bus = mix.aux', state)).rejects.toThrow('cannot be redeclared')
    await run('var alt = mix.output(3, 4)', state)
    await expect(run('alt.effect("x")', state)).rejects.toThrow('#484 D4')
  })

  it('resolves a declared master output instead of the implicit fallback', async () => {
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    await run('var mix = init global.mixer\nvar master = mix.output(3, 4)', state)

    expect(resolveMixerNode(state.mixers, 'master', global)).toBe(state.mixers.nodes.get('master'))
    expect(resolveMixerNode(state.mixers, 'master', global)).toMatchObject({
      kind: 'output',
      channels: [3, 4],
    })
  })

  it('keeps implicit master fallback independent across Globals', async () => {
    const g1 = new Global(new RecordingScheduler())
    const g2 = new Global(new RecordingScheduler())
    const state = stateWith(g1)
    state.globals.set('g1', g1)
    state.globals.set('g2', g2)
    await run('var mix = init g1.mixer\nvar drums = mix.sum', state)

    expect(resolveMixerNode(state.mixers, 'master', g1)).toBeUndefined()
    expect(resolveMixerNode(state.mixers, 'master', g2)).toMatchObject({
      kind: 'output',
      global: g2,
      channels: [1, 2],
    })
  })

  it('executes mixer declarations through named and star file imports', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-mixer-import-'))
    temporaryDirectories.push(directory)
    fs.writeFileSync(
      path.join(directory, 'mixer.orbs'),
      'var global = init GLOBAL\nvar mix = init global.mixer\nvar drums = mix.sum\n',
    )

    for (const importClause of ['{ mix, drums }', '*']) {
      const entry = path.join(directory, `main-${importClause === '*' ? 'star' : 'named'}.orbs`)
      fs.writeFileSync(entry, `import ${importClause} from "./mixer.orbs"\n`)
      const importedState = stateWith(new Global(new RecordingScheduler()))
      const ir = parseAudioDSL(fs.readFileSync(entry, 'utf8'))
      await processFileImports(
        ir.fileImports ?? [],
        directory,
        importedState,
        createImportContext(entry),
      )
      expect(importedState.mixers.handles.has('mix')).toBe(true)
      expect(importedState.mixers.nodes.get('drums')).toMatchObject({ kind: 'sum' })
    }
  })

  it('rejects rebinding a mixer handle to another Global', async () => {
    const g1 = new Global(new RecordingScheduler())
    const g2 = new Global(new RecordingScheduler())
    const state = stateWith(g1)
    state.globals.set('g1', g1)
    state.globals.set('g2', g2)
    await run('var mix = init g1.mixer', state)
    await expect(run('var mix = init g2.mixer', state)).rejects.toThrow('different Global')
  })

  it('rejects redeclaring a mixer node against a handle for another Global', async () => {
    const g1 = new Global(new RecordingScheduler())
    const g2 = new Global(new RecordingScheduler())
    const state = stateWith(g1)
    state.globals.set('g1', g1)
    state.globals.set('g2', g2)
    await run('var m1 = init g1.mixer\nvar m2 = init g2.mixer\nvar bus = m1.sum', state)
    await expect(run('var bus = m2.sum', state)).rejects.toThrow('cannot be redeclared')
  })

  it('treats repeated output declaration with the same channels as idempotent', async () => {
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    await run('var mix = init global.mixer\nvar out = mix.output(3, 4)', state)
    const first = state.mixers.nodes.get('out')
    await run('var out = mix.output(3, 4)', state)
    expect(state.mixers.nodes.get('out')).toBe(first)
  })

  it('reports both old and newly requested channels on output redeclaration', async () => {
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    await run('var mix = init global.mixer\nvar out = mix.output(1, 2)', state)
    await expect(run('var out = mix.output(3, 4)', state)).rejects.toThrow(
      'already declared for channels (1, 2); cannot redeclare for (3, 4)',
    )
  })

  it('rejects mixer names that collide with sequence/global names in every declaration order', async () => {
    const global = new Global(new RecordingScheduler())

    const sequenceBeforeHandle = stateWith(global)
    await run('var kick = init global.seq', sequenceBeforeHandle)
    await expect(run('var kick = init global.mixer', sequenceBeforeHandle)).rejects.toThrow(
      /mixer.*sequence namespace/i,
    )
    await expect(
      run(
        'var kick = init global.seq\nvar mix = init global.mixer\nvar kick = mix.sum',
        stateWith(global),
      ),
    ).rejects.toThrow(/mixer.*sequence namespace/i)
    const mixerBeforeSequence = stateWith(global)
    await run('var mix = init global.mixer\nvar kick = mix.sum', mixerBeforeSequence)
    await expect(run('var kick = init global.seq', mixerBeforeSequence)).rejects.toThrow(
      /sequence.*mixer namespace/i,
    )
    await expect(run('var global = init global.mixer', stateWith(global))).rejects.toThrow(
      /mixer.*global namespace/i,
    )
    const globalBeforeNode = stateWith(global)
    await run('var mix = init global.mixer', globalBeforeNode)
    await expect(run('var global = mix.sum', globalBeforeNode)).rejects.toThrow(
      /mixer.*global namespace/i,
    )
    const handleBeforeGlobal = stateWith(global)
    await run('var reserved = init global.mixer', handleBeforeGlobal)
    await expect(
      processGlobalInit({ type: 'global_init', variableName: 'reserved' }, handleBeforeGlobal),
    ).rejects.toThrow(/global.*mixer namespace/i)
    const handleBeforeSequence = stateWith(global)
    await run('var reserved = init global.mixer', handleBeforeSequence)
    await expect(run('var reserved = init global.seq', handleBeforeSequence)).rejects.toThrow(
      /sequence.*mixer namespace/i,
    )
    const mixerFirst = stateWith(global)
    await run('var mix = init global.mixer\nvar later = mix.aux', mixerFirst)
    await expect(
      processGlobalInit({ type: 'global_init', variableName: 'later' }, mixerFirst),
    ).rejects.toThrow(/global.*mixer namespace/i)
  })

  it('rejects mixer handle and node names that collide in either declaration order', async () => {
    const global = new Global(new RecordingScheduler())
    const nodeBeforeHandle = stateWith(global)
    await run('var mix = init global.mixer\nvar bus = mix.sum', nodeBeforeHandle)
    // Anchored on the leading noun: both messages contain both words, so an
    // unanchored /mixer.*node/ would also match the node-side message (and vice
    // versa), letting a swap of the two messages pass unnoticed.
    await expect(run('var bus = init global.mixer', nodeBeforeHandle)).rejects.toThrow(
      /^Mixer handle .* existing mixer node namespace/i,
    )

    const handleBeforeNode = stateWith(global)
    await run('var first = init global.mixer\nvar reserved = init global.mixer', handleBeforeNode)
    await expect(run('var reserved = first.aux', handleBeforeNode)).rejects.toThrow(
      /^Mixer node .* existing mixer handle namespace/i,
    )
  })

  it('rejects a mixer node declaration that uses its own handle name as the base', async () => {
    const state = stateWith(new Global(new RecordingScheduler()))
    await run('var mix = init global.mixer', state)

    await expect(run('var mix = mix.sum', state)).rejects.toThrow(
      /^Mixer node .* existing mixer handle namespace/i,
    )
  })

  it('throws from exported global/sequence handlers when their target is absent', async () => {
    const state = stateWith(new Global(new RecordingScheduler()))
    await expect(
      processGlobalStatement(
        { type: 'global', target: 'missing', method: 'tempo', args: [] },
        state,
      ),
    ).rejects.toThrow('Variable not found: missing')
    await expect(
      processSequenceStatement(
        { type: 'sequence', target: 'missing', method: 'play', args: [] },
        state,
      ),
    ).rejects.toThrow('Variable not found: missing')
  })

  it('keeps every mixer declaration mutually exclusive with LinkAudio', async () => {
    const before = new Global(new RecordingScheduler())
    before.linkAudio()
    await expect(run('var mix = init global.mixer', stateWith(before))).rejects.toThrow(/LinkAudio/)

    const after = new Global(new RecordingScheduler())
    const state = stateWith(after)
    await run('var mix = init global.mixer\nvar master = mix.output(1, 2)', state)
    expect(() => after.linkAudio()).toThrow(/plugin hosting/)
  })

  it('includes mixer handles and nodes in import declaration contracts', () => {
    const names = declaredNames(
      parseAudioDSL(
        'var global = init GLOBAL\nvar mix = init global.mixer\nvar master = mix.output(1, 2)',
      ),
    )
    expect(names).toEqual(new Set(['global', 'mix', 'master']))
  })
})
