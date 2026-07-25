import { describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { declaredNames } from '../../packages/engine/src/interpreter/process-file-import'
import { processStatement } from '../../packages/engine/src/interpreter/process-statement'
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
  for (const statement of parseAudioDSL(source).statements) {
    await processStatement(statement, state)
  }
}

describe('Signal Chain mixer runtime namespace (SC.2)', () => {
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

  it('rejects invalid bases, duplicate kinds, and use of non-default output endpoints', async () => {
    const global = new Global(new RecordingScheduler())
    const state = stateWith(global)
    await expect(run('var verb = nope.aux', state)).rejects.toThrow('not a mixer handle')
    await run('var mix = init global.mixer\nvar bus = mix.sum', state)
    await expect(run('var bus = mix.aux', state)).rejects.toThrow('cannot be redeclared')
    await run('var alt = mix.output(3, 4)', state)
    await expect(run('alt.effect("x")', state)).rejects.toThrow('#484 D4')
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
