import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DaemonProtocolError } from '../../packages/engine/src/audio/rust-engine/errors'
import { Global } from '../../packages/engine/src/core/global'
import {
  EffectChainMap,
  type CatalogElementSpec,
  type StandardElementSpec,
} from '../../packages/engine/src/core/global/effect-slot'
import {
  ProjectStateStore,
  stateFileNameForIdentity,
} from '../../packages/engine/src/core/project-state-store'
import type { RackRecipe } from '../../packages/engine/src/signal-chain/rack'

const temporaryDirectories: string[] = []

function catalog(name: string, resolvedPath = `/${name}.clap`): CatalogElementSpec {
  return {
    kind: 'catalog',
    normalizedName: name,
    resolvedPath,
    pluginId: `${name}-id`,
    enabled: true,
  }
}

function gain(db = 0, enabled = true): StandardElementSpec {
  return { kind: 'standard', name: 'Gain', params: { db }, enabled }
}

function effectMap(
  options: {
    directory?: string
    fallback?: ReturnType<typeof vi.fn>
    beforeReplace?: ReturnType<typeof vi.fn>
  } = {},
) {
  const applyEffectChain = vi.fn(async (request: any) => {
    const dropped = []
    for (const save of request.saveDropped) {
      await fs.promises.writeFile(save.path, 'state')
      dropped.push({ prevIndex: save.prev_index, path: save.path, bytesWritten: 5 })
    }
    return { status: 'applied' as const, childPid: 71, dropped }
  })
  const audio = { applyEffectChain } as any
  const map = new EffectChainMap<string>(audio, (key) => key, {
    externalReceiverId: (key) => key,
    effectBus: (key) => (key === 'master' ? undefined : `${key}-bus`),
    projectDirectory: () => options.directory ?? '',
    statePathFallback: options.fallback,
    replacement: {
      beforeReplace: options.beforeReplace ?? vi.fn().mockResolvedValue(undefined),
      failurePolicy: 'retain-on-reject',
    },
  })
  return { map, audio, applyEffectChain }
}

function globalHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-rack-global-'))
  temporaryDirectories.push(directory)
  const applyEffectChain = vi.fn(async (request: any) => {
    const dropped = []
    for (const save of request.saveDropped) {
      await fs.promises.writeFile(save.path, 'state')
      dropped.push({ prevIndex: save.prev_index, path: save.path, bytesWritten: 5 })
    }
    return { status: 'applied' as const, childPid: 19, dropped }
  })
  const audio = {
    applyEffectChain,
    isRunning: false,
    startTime: 0,
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    getAudioDuration: vi.fn(() => 1),
    getMasterGainDb: vi.fn(() => 0),
  } as any
  const global = new Global(audio)
  global.setDocumentDirectory(directory)
  return { global, audio, applyEffectChain }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('#628 effect rack LCS and identity registry', () => {
  it('T3 binds rack recipes by value so rebinding does not reapply an existing receiver', async () => {
    const { global, applyEffectChain } = globalHarness()
    const source: RackRecipe = [{ kind: 'catalog', spec: '/A.clap', enabled: true }]
    global.defineRack('rack', source)
    ;(source[0] as { spec: string }).spec = '/mutated-source.clap'
    const first = global.getRack('rack')!
    ;(first[0] as { spec: string }).spec = '/mutated-read.clap'
    expect(global.getRack('rack')).toEqual([{ kind: 'catalog', spec: '/A.clap', enabled: true }])
    const applied = global.getRack('rack')!
    await global.effect(applied)
    global.defineRack('rack', [{ kind: 'catalog', spec: '/B.clap', enabled: true }])

    expect(applyEffectChain).toHaveBeenCalledTimes(1)
    expect(applied).toEqual([{ kind: 'catalog', spec: '/A.clap', enabled: true }])
    expect(global.getRack('rack')).toEqual([{ kind: 'catalog', spec: '/B.clap', enabled: true }])
  })

  it('T4 applies one rack variable to two receivers as two independent daemon racks', async () => {
    const { global, applyEffectChain } = globalHarness()
    const recipe: RackRecipe = [{ kind: 'catalog', spec: '/A.clap', enabled: true }]
    await global.effect(recipe)
    await global.sum('drums').effect(recipe)

    expect(applyEffectChain).toHaveBeenCalledTimes(2)
    expect(applyEffectChain).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        mode: 'diff',
        chain: [expect.objectContaining({ path: '/A.clap' })],
      }),
    )
    expect(applyEffectChain).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        bus: 'sum-bus-0',
        chain: [expect.objectContaining({ path: '/A.clap' })],
      }),
    )
  })

  it('T5 uses LCS for [A,B,C] -> [A,C], dropping only B and keeping A/C', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-rack-t5-'))
    temporaryDirectories.push(directory)
    const { map, applyEffectChain } = effectMap({ directory })
    await map.applyRack('lead', [catalog('A'), catalog('B'), catalog('C')])
    await map.applyRack('lead', [catalog('A'), catalog('C')])

    const request = applyEffectChain.mock.calls[1]![0]
    expect(request.chain).toEqual([
      { op: 'keep', prev_index: 0, enabled: true },
      { op: 'keep', prev_index: 2, enabled: true },
    ])
    const identity = {
      receiver: 'lead',
      role: 'effect' as const,
      normalizedName: 'B',
      occurrence: 0,
    }
    expect(request.saveDropped).toEqual([
      {
        prev_index: 1,
        path: path.join(directory, 'states', stateFileNameForIdentity(identity)),
      },
    ])
  })

  it('T6 preserves a surviving duplicate occurrence instead of recounting text positions', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-rack-t6-'))
    temporaryDirectories.push(directory)
    const { map, applyEffectChain } = effectMap({ directory })
    await map.applyRack('lead', [
      catalog('A', '/first.clap'),
      catalog('B'),
      catalog('A', '/last.clap'),
    ])
    await map.applyRack('lead', [catalog('B'), catalog('A', '/last.clap')])

    expect(
      map.rackFor('lead').map(({ normalizedName, occurrence }) => [normalizedName, occurrence]),
    ).toEqual([
      ['B', 0],
      ['A', 1],
    ])
    await map.applyRack('lead', [catalog('B')])
    expect(applyEffectChain.mock.calls[2]![0].saveDropped).toEqual([
      {
        prev_index: 1,
        path: path.join(
          directory,
          'states',
          stateFileNameForIdentity({
            receiver: 'lead',
            role: 'effect',
            normalizedName: 'A',
            occurrence: 1,
          }),
        ),
      },
    ])
  })

  it('T7 reallocates freed duplicate occurrences from zero in position order and resolves fallback identities', async () => {
    const fallback = vi.fn(async (identity) => `/state/${identity.occurrence}.state`)
    const { map } = effectMap({ fallback })
    await map.applyRack('lead', [catalog('A'), catalog('A')])
    await map.applyRack('lead', [])
    fallback.mockClear()
    await map.applyRack('lead', [catalog('A'), catalog('A')])

    expect(map.rackFor('lead').map((element) => element.occurrence)).toEqual([0, 1])
    expect(fallback).toHaveBeenCalledTimes(2)
    expect(fallback).toHaveBeenNthCalledWith(1, {
      receiver: 'lead',
      role: 'effect',
      normalizedName: 'A',
      occurrence: 0,
    })
    expect(fallback).toHaveBeenNthCalledWith(2, {
      receiver: 'lead',
      role: 'effect',
      normalizedName: 'A',
      occurrence: 1,
    })
  })

  it('T8 replaces a same-name catalog stage when its resolved spec changes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-rack-t8-'))
    temporaryDirectories.push(directory)
    const { map, applyEffectChain } = effectMap({ directory })
    await map.applyRack('lead', [catalog('A', '/A.clap')])
    await map.applyRack('lead', [catalog('A', '/A.vst3')])

    expect(applyEffectChain.mock.calls[1]![0]).toEqual({
      bus: 'lead-bus',
      mode: 'diff',
      chain: [
        {
          op: 'load',
          kind: 'catalog',
          path: '/A.vst3',
          plugin_id: 'A-id',
          state: expect.stringContaining(`${path.sep}states${path.sep}`),
          enabled: true,
        },
      ],
      saveDropped: [
        { prev_index: 0, path: expect.stringContaining(`${path.sep}states${path.sep}`) },
      ],
    })
    expect(map.rackFor('lead')[0]!.occurrence).toBe(0)
  })

  it('T9 updates enabled and standard params through keep without a load', async () => {
    const { map, applyEffectChain } = effectMap()
    await map.applyRack('lead', [gain(-6, true)])
    await map.applyRack('lead', [gain(-12, false)])

    expect(applyEffectChain.mock.calls[1]![0].chain).toEqual([
      { op: 'keep', prev_index: 0, enabled: false, params: { db: -12 } },
    ])
  })

  it('T10 desugars string effect declarations through ApplyEffectChain, including idempotence and replacement', async () => {
    const { global, applyEffectChain } = globalHarness()
    await global.effect('/A.clap')
    await global.effect('/A.clap')
    await global.effect('/B.clap')
    await global.effect('/A.clap')

    expect(applyEffectChain).toHaveBeenCalledTimes(4)
    expect(applyEffectChain.mock.calls[1]![0].chain).toEqual([
      { op: 'keep', prev_index: 0, enabled: true },
    ])
    expect(applyEffectChain.mock.calls[2]![0].chain).toEqual([
      expect.objectContaining({
        op: 'load',
        kind: 'catalog',
        path: '/B.clap',
      }),
    ])
    expect(applyEffectChain.mock.calls[2]![0].saveDropped).toEqual([
      { prev_index: 0, path: expect.stringMatching(/\/states\/.+\.state$/) },
    ])
    expect(applyEffectChain.mock.calls[3]![0].chain).toEqual([
      expect.objectContaining({
        op: 'load',
        kind: 'catalog',
        path: '/A.clap',
        state: expect.stringMatching(/\/states\/.+\.state$/),
      }),
    ])
  })

  it('T11 keeps the LinkAudio gate closed after applying an intentional empty master rack', async () => {
    const { global, applyEffectChain } = globalHarness()
    await global.effect([])

    expect(applyEffectChain).toHaveBeenCalledTimes(1)
    expect(applyEffectChain).toHaveBeenCalledWith({ mode: 'diff', chain: [], saveDropped: [] })
    expect(() => global.linkAudio()).toThrow(
      'cannot be used after plugin hosting has been declared',
    )
  })

  it('T12 retains the registry after a definitive daemon rejection and retries in diff mode', async () => {
    const { map, applyEffectChain } = effectMap()
    await map.applyRack('lead', [catalog('A')])
    applyEffectChain.mockRejectedValueOnce(new DaemonProtocolError('BAD_STAGE', 'index 0 rejected'))
    await expect(map.applyRack('lead', [catalog('B')])).rejects.toThrow(
      'effect chain apply failed at index 0 (B): index 0 rejected; the previous chain is kept',
    )
    expect(map.rackFor('lead')).toMatchObject([
      { kind: 'catalog', normalizedName: 'A', resolvedPath: '/A.clap' },
    ])
    applyEffectChain.mockResolvedValueOnce({ status: 'applied', childPid: 4, dropped: [] })
    await map.applyRack('lead', [catalog('B')])

    expect(applyEffectChain.mock.calls[2]![0].mode).toBe('diff')
    expect(applyEffectChain.mock.calls[2]![0].chain[0]).toEqual(
      expect.objectContaining({ op: 'load', path: '/B.clap' }),
    )
  })

  it('T13 forgets an ambiguous transport outcome and converges with a rebuild', async () => {
    const { map, applyEffectChain } = effectMap()
    await map.applyRack('lead', [catalog('A')])
    applyEffectChain.mockRejectedValueOnce(new Error('socket closed'))
    await expect(map.applyRack('lead', [catalog('B')])).rejects.toThrow('socket closed')
    applyEffectChain.mockResolvedValueOnce({ status: 'applied', childPid: 4, dropped: [] })
    await map.applyRack('lead', [catalog('B')])

    expect(applyEffectChain.mock.calls[2]![0]).toEqual(
      expect.objectContaining({
        mode: 'rebuild',
        chain: [expect.objectContaining({ op: 'load', path: '/B.clap' })],
      }),
    )
  })

  it('T20 uses the identity filename and registers a dropped state only after APPLY succeeds', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-rack-t20-'))
    temporaryDirectories.push(directory)
    const register = vi.spyOn(ProjectStateStore.prototype, 'registerSavedState')
    const { map, applyEffectChain } = effectMap({ directory })
    await map.applyRack('lead', [catalog('A')])
    await map.applyRack('lead', [])

    const identity = {
      receiver: 'lead',
      role: 'effect' as const,
      normalizedName: 'A',
      occurrence: 0,
    }
    const relative = `states/${stateFileNameForIdentity(identity)}`
    expect(applyEffectChain.mock.calls[1]![0].saveDropped).toEqual([
      { prev_index: 0, path: path.join(directory, ...relative.split('/')) },
    ])
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(identity, relative, 5, {
      resolvedPath: '/A.clap',
      pluginId: 'A-id',
    })
    expect(applyEffectChain.mock.invocationCallOrder[1]).toBeLessThan(
      register.mock.invocationCallOrder[0]!,
    )
  })

  it('T21 always issues ApplyEffectChain for an all-keep empty diff', async () => {
    const { map, applyEffectChain } = effectMap()
    await map.applyRack('lead', [catalog('A')])
    applyEffectChain.mockClear()
    await map.applyRack('lead', [catalog('A')])

    expect(applyEffectChain).toHaveBeenCalledTimes(1)
    expect(applyEffectChain).toHaveBeenCalledWith({
      bus: 'lead-bus',
      mode: 'diff',
      chain: [{ op: 'keep', prev_index: 0, enabled: true }],
      saveDropped: [],
    })
  })

  it('T23 excludes standard stages from state fallback and save_dropped', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-rack-t23-'))
    temporaryDirectories.push(directory)
    const fallback = vi.fn().mockResolvedValue(undefined)
    const { map, applyEffectChain } = effectMap({ directory, fallback })
    await map.applyRack('lead', [catalog('A'), gain(-6)])
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledWith({
      receiver: 'lead',
      role: 'effect',
      normalizedName: 'A',
      occurrence: 0,
    })
    await map.applyRack('lead', [])

    expect(applyEffectChain.mock.calls[1]![0].saveDropped).toHaveLength(1)
    expect(applyEffectChain.mock.calls[1]![0].saveDropped[0].prev_index).toBe(0)
  })
})
