import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { clearPluginCatalogCache } from '../../packages/engine/src/core/global/plugin-catalog'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import type { ChordBinding, ValueArray, ValueCall } from '../../packages/engine/src/parser/types'
import {
  classifyArrayBinding,
  effectArgumentsToRack,
  instrumentArguments,
  resolveRackValue,
  type RackBindingEnvironment,
} from '../../packages/engine/src/signal-chain/rack'

function binding(source: string): ChordBinding {
  return parseAudioDSL(source).statements[0] as ChordBinding
}

function value(source: string): ValueArray {
  return binding(`var value = ${source}`).value
}

function env(
  options: { chords?: string[]; racks?: Record<string, any> } = {},
): RackBindingEnvironment {
  return {
    getBinding: (name) =>
      options.chords?.includes(name) ? { kind: 'chord', voices: [1, 3, 5] } : undefined,
    getRack: (name) => options.racks?.[name],
  }
}

function globalHarness(directory: string) {
  const applyEffectChain = vi.fn().mockResolvedValue({
    status: 'applied',
    childPid: 2,
    dropped: [],
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
  return { global, applyEffectChain }
}

describe('#628 generic array parsing and three-category rack resolution', () => {
  let directory: string
  let previousCatalog: string | undefined

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-rack-values-'))
    previousCatalog = process.env.ORBIT_PLUGIN_CATALOG
    const catalogPath = path.join(directory, 'catalog.json')
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        scannedAt: '2026-08-28T00:00:00Z',
        plugins: [
          {
            name: 'Gain',
            vendor: 'Catalog Vendor',
            format: 'clap',
            path: '/CatalogGain.clap',
            pluginId: 'catalog-gain',
            roles: ['effect'],
          },
        ],
      }),
    )
    process.env.ORBIT_PLUGIN_CATALOG = catalogPath
    clearPluginCatalogCache()
  })

  afterEach(() => {
    if (previousCatalog === undefined) delete process.env.ORBIT_PLUGIN_CATALOG
    else process.env.ORBIT_PLUGIN_CATALOG = previousCatalog
    clearPluginCatalogCache()
    fs.rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('T1 keeps the existing chord AST surface while retaining generic string/call/nested rack values', () => {
    const parsed = binding('var rack = ["A", plugin("B", enabled: false), Gain(db: -6), [["C"]]]')

    expect(parsed.type).toBe('chord_binding')
    expect(parsed.voices).toEqual(parsed.value.elements)
    expect(parsed.value).toEqual({
      type: 'value_array',
      elements: [
        'A',
        {
          type: 'value_call',
          name: 'plugin',
          args: ['B', { type: 'named_arg', name: 'enabled', value: false }],
        },
        { type: 'value_call', name: 'Gain', args: [{ type: 'named_arg', name: 'db', value: -6 }] },
        { type: 'value_array', elements: [{ type: 'value_array', elements: ['C'] }] },
      ],
    })
    expect(binding('var chord = [1, b3, 5]').voices).toHaveLength(3)
  })

  it('T2 classifies identifier-only arrays from bindings and rejects chord/rack mixing', () => {
    const chord = classifyArrayBinding(value('[m7]'), env({ chords: ['m7'] }))
    const rackRecipe = [{ kind: 'catalog' as const, spec: '/Glue.clap', enabled: true }]
    const rack = classifyArrayBinding(value('[glue]'), env({ racks: { glue: rackRecipe } }))

    expect(chord.kind).toBe('chord')
    expect(rack).toEqual({ kind: 'rack', rack: rackRecipe })
    expect(() =>
      classifyArrayBinding(
        value('[m7, glue]'),
        env({ chords: ['m7'], racks: { glue: rackRecipe } }),
      ),
    ).toThrow('array mixes chord variables and rack variables')
  })

  it('T16 parses layer() but rejects parallel application before issuing APPLY', async () => {
    const { global, applyEffectChain } = globalHarness(directory)
    const call = value('[layer(["A", "B"])]').elements[0] as ValueCall
    const rack = effectArgumentsToRack([call], env())

    await expect(global.effect(rack)).rejects.toThrow(
      'layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only',
    )
    expect(applyEffectChain).toHaveBeenCalledTimes(0)
  })

  it('T17 accepts one instrument array and rejects a bare serial multi-instrument array', () => {
    expect(instrumentArguments([value('["A"]')], env())).toEqual(['A'])
    expect(() => instrumentArguments([value('["A", "B"]')], env())).toThrow(
      'multiple instruments need layer([...]); a bare array is serial and instruments cannot be chained (SC.10.6)',
    )
    const layer = value('[layer(["A", "B"])]').elements[0]
    expect(() => instrumentArguments([layer], env())).toThrow(
      'layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only',
    )
  })

  it('T18 keeps standard calls and same-named catalog strings in separate categories without fallback', async () => {
    const { global, applyEffectChain } = globalHarness(directory)
    const standard = resolveRackValue(value('[Gain(db: -6)]').elements[0]!, env())
    await global.effect(standard)
    const catalog = resolveRackValue('Gain', env())
    await global.effect(catalog)

    expect(applyEffectChain).toHaveBeenCalledTimes(2)
    expect(applyEffectChain.mock.calls[0]![0].chain).toEqual([
      { op: 'load', kind: 'standard', name: 'Gain', params: { db: -6 }, enabled: true },
    ])
    expect(applyEffectChain.mock.calls[1]![0].chain).toEqual([
      expect.objectContaining({ op: 'load', kind: 'catalog', path: '/CatalogGain.clap' }),
    ])
    const fake = value('[Fake(x: 1)]').elements[0]!
    expect(() => resolveRackValue(fake, env())).toThrow(
      'no standard plugin named "Fake"; catalog plugins are written as strings: effect("Fake")',
    )
    expect(applyEffectChain).toHaveBeenCalledTimes(2)
  })

  it('T19 rejects lowercase gain with capitalization guidance and no APPLY', () => {
    const { applyEffectChain } = globalHarness(directory)
    const lowercase = value('[gain(db: -6)]').elements[0]!

    expect(() => resolveRackValue(lowercase, env())).toThrow(
      'unknown rack word "gain"; the standard gain plugin is capitalized: Gain(db: -6)',
    )
    expect(applyEffectChain).toHaveBeenCalledTimes(0)
  })

  it('flattens nested serial arrays and resolves rack variables by copied value', () => {
    const rackRecipe = [{ kind: 'catalog' as const, spec: '/A.clap', enabled: true }]
    expect(
      resolveRackValue(value('[[base], ["B"]]'), env({ racks: { base: rackRecipe } })),
    ).toEqual([...rackRecipe, { kind: 'catalog', spec: 'B', enabled: true }])
  })
})
