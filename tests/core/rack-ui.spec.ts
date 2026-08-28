import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginUiTarget } from '../../packages/engine/src/audio/types'
import { Global } from '../../packages/engine/src/core/global'
import type { RackRecipe } from '../../packages/engine/src/signal-chain/rack'

const temporaryDirectories: string[] = []

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-rack-ui-'))
  temporaryDirectories.push(directory)
  let safepointSaver: ((target: PluginUiTarget) => Promise<void>) | undefined
  const applyEffectChain = vi.fn(async (request: any) => {
    const dropped = []
    for (const save of request.saveDropped) {
      await fs.promises.writeFile(save.path, 'drop-state')
      dropped.push({ prevIndex: save.prev_index, path: save.path, bytesWritten: 10 })
    }
    return { status: 'applied' as const, childPid: 32, dropped }
  })
  const openPluginUi = vi.fn().mockResolvedValue(undefined)
  const savePluginState = vi.fn(async (_target: unknown, absolutePath: string) => {
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.promises.writeFile(absolutePath, 'ui-state')
    return { path: absolutePath, bytesWritten: 8 }
  })
  const closePluginUi = vi.fn(async (target: any, index: number) => {
    await safepointSaver?.({
      role: 'effect',
      ...(target.bus === undefined ? {} : { bus: target.bus }),
      index,
    })
    return 'safepoint-completed' as const
  })
  const audio = {
    applyEffectChain,
    openPluginUi,
    closePluginUi,
    savePluginState,
    setPluginUiSafepointSaver: vi.fn((saver) => {
      safepointSaver = saver
    }),
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
  return { directory, global, applyEffectChain, openPluginUi, closePluginUi, savePluginState }
}

function rack(...names: string[]): RackRecipe {
  return names.map((name) => ({ kind: 'catalog', spec: `/${name}.clap`, enabled: true }))
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('#628 rack UI identity and name addressing', () => {
  it('T14 keeps an open occurrence attached to its instance when a preceding stage is removed', async () => {
    const { directory, global, openPluginUi, closePluginUi, savePluginState } = harness()
    const bus = global.sum('drums')
    await bus.effect(rack('A', 'B'))
    await global.openPluginUi('sum:drums', 2, 'B')
    await bus.effect(rack('B'))
    await global.closePluginUi('sum:drums', 1)

    expect(openPluginUi).toHaveBeenCalledTimes(1)
    expect(openPluginUi).toHaveBeenCalledWith(
      { role: 'effect', bus: 'sum-bus-0', chainPath: [1] },
      2,
      'OrbitScore — B (sum:drums:2)',
    )
    expect(closePluginUi).toHaveBeenCalledTimes(1)
    expect(closePluginUi).toHaveBeenCalledWith(
      { role: 'effect', bus: 'sum-bus-0', chainPath: [0] },
      1,
    )
    expect(savePluginState).toHaveBeenCalledTimes(1)
    expect(savePluginState.mock.calls[0]![0]).toEqual({
      role: 'effect',
      bus: 'sum-bus-0',
      chainPath: [0],
    })
    const manifest = fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8')
    expect(manifest).toContain('sum:drums/effect/B/0')
  })

  it('T26 maps the second element to chain_path [1] and rejects stale expected text before opening', async () => {
    const { global, openPluginUi } = harness()
    await global.sum('drums').effect(rack('A', 'B'))
    await global.openPluginUi('sum:drums', 2, 'B')
    expect(openPluginUi).toHaveBeenCalledWith(
      { role: 'effect', bus: 'sum-bus-0', chainPath: [1] },
      2,
      'OrbitScore — B (sum:drums:2)',
    )
    openPluginUi.mockClear()

    await expect(global.openPluginUi('sum:drums', 2, 'A')).rejects.toThrow('re-evaluate first')
    expect(openPluginUi).toHaveBeenCalledTimes(0)
  })

  it('T27 opens every same-name catalog stage and rejects numeric ui indexes', async () => {
    const { global, openPluginUi } = harness()
    const bus = global.sum('drums')
    await bus.effect(rack('A', 'B', 'A'))
    await bus.ui('A')

    expect(openPluginUi).toHaveBeenCalledTimes(2)
    expect(openPluginUi).toHaveBeenNthCalledWith(
      1,
      { role: 'effect', bus: 'sum-bus-0', chainPath: [0] },
      1,
      'OrbitScore — A (sum:drums:1)',
    )
    expect(openPluginUi).toHaveBeenNthCalledWith(
      2,
      { role: 'effect', bus: 'sum-bus-0', chainPath: [2] },
      3,
      'OrbitScore — A (sum:drums:3)',
    )
    await expect(bus.ui(1 as any)).rejects.toThrow('numeric indexes are not supported')
    expect(openPluginUi).toHaveBeenCalledTimes(2)
  })

  it('T28 reports missing inserts and standard plugins without issuing an open', async () => {
    const { global, openPluginUi } = harness()
    const bus = global.sum('drums')
    await bus.effect([
      ...rack('A', 'B'),
      { kind: 'standard', name: 'Gain', params: { db: -6 }, enabled: true },
    ])

    await expect(bus.ui('Missing')).rejects.toThrow('Declared inserts: A, B, Gain')
    await expect(bus.ui('Gain')).rejects.toThrow(
      'standard plugins have no UI/state; parameters live in the DSL (SC.10.8)',
    )
    expect(openPluginUi).toHaveBeenCalledTimes(0)
  })
})
