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
  const closePluginUi = vi.fn(async (target: any, index: number, window: number) => {
    await safepointSaver?.({
      role: 'effect',
      ...(target.bus === undefined ? {} : { bus: target.bus }),
      index,
      window,
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
  it('S1 keeps token identity and uses the current chain_path after a preceding drop', async () => {
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
      expect.any(Number),
    )
    expect(closePluginUi).toHaveBeenCalledTimes(1)
    expect(closePluginUi).toHaveBeenCalledWith(
      { role: 'effect', bus: 'sum-bus-0', chainPath: [0] },
      1,
      openPluginUi.mock.calls[0]![3],
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
      expect.any(Number),
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
      expect.any(Number),
    )
    expect(openPluginUi).toHaveBeenNthCalledWith(
      2,
      { role: 'effect', bus: 'sum-bus-0', chainPath: [2] },
      3,
      'OrbitScore — A (sum:drums:3)',
      expect.any(Number),
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

  it('S7 re-syncs the session to the token the daemon already holds', async () => {
    // 🔴 daemon の binding 検査が「その index は window w1 に束縛済み」と拒否した時、**こちらが
    // 採番した w2 で記録してはいけない**。TS だけが w2 を信じ daemon と child は w1 のままになり、
    // 以後 DSL からの close は binding 不一致で必ず loud に失敗する — **そのウィンドウを二度と
    // 閉じられなくなる**（2026-08-29 Fable 監査 Finding 1）。
    const { global, bus, openPluginUi, closePluginUi } = await (async () => {
      const h = harness()
      const b = h.global.sum('drums')
      await b.effect(rack('A'))
      return { ...h, bus: b }
    })()

    await bus.ui('A')
    const daemonWindow = openPluginUi.mock.calls[0]?.[3] as number
    expect(Number.isSafeInteger(daemonWindow)).toBe(true)

    // TS 側の簿記だけが失われた状態を作る（daemon は w1 を保持し続けている）。
    ;(
      global as unknown as { openPluginUiSessions: Map<number, unknown> }
    ).openPluginUiSessions.clear()

    openPluginUi.mockRejectedValueOnce(
      new Error(
        `OPEN_UI requested while lifecycle is Open (chain index 0 is bound to window ${daemonWindow})`,
      ),
    )
    await bus.ui('A')

    // 再同期できていれば、close は **daemon が持っている token** で発行される。
    closePluginUi.mockClear()
    await bus.ui('A', false)
    expect(closePluginUi).toHaveBeenCalledTimes(1)
    expect(closePluginUi.mock.calls[0]?.[2]).toBe(daemonWindow)
  })

  it('S4 keeps an already-open instance idempotent after its index shifts', async () => {
    const { global, openPluginUi } = harness()
    const bus = global.sum('drums')
    await bus.effect(rack('A', 'B'))
    await bus.ui('B')
    expect(openPluginUi).toHaveBeenCalledTimes(1)

    await bus.effect(rack('B'))
    openPluginUi.mockClear()
    await bus.ui('B')

    expect(openPluginUi).toHaveBeenCalledTimes(0)
  })

  it('S5 completes safepoint save then close before issuing the drop APPLY', async () => {
    const { global, applyEffectChain, openPluginUi, closePluginUi, savePluginState } = harness()
    const bus = global.sum('drums')
    await bus.effect(rack('A', 'B'))
    await global.openPluginUi('sum:drums', 2, 'B')
    const closeImplementation = closePluginUi.getMockImplementation()!
    const closeCompleted = vi.fn()
    closePluginUi.mockImplementation(async (...args: any[]) => {
      const completion = await closeImplementation(...args)
      closeCompleted()
      return completion
    })

    await bus.effect(rack('A'))

    expect(savePluginState).toHaveBeenCalledTimes(1)
    expect(closeCompleted).toHaveBeenCalledTimes(1)
    expect(applyEffectChain).toHaveBeenCalledTimes(2)
    expect(savePluginState.mock.invocationCallOrder[0]).toBeLessThan(
      closeCompleted.mock.invocationCallOrder[0]!,
    )
    expect(closeCompleted.mock.invocationCallOrder[0]).toBeLessThan(
      applyEffectChain.mock.invocationCallOrder[1]!,
    )
    expect(closePluginUi).toHaveBeenCalledWith(
      { role: 'effect', bus: 'sum-bus-0', chainPath: [1] },
      2,
      openPluginUi.mock.calls[0]![3],
    )
  })

  it('S6 makes an APPLY-response race loud and a post-response reevaluation resolves it', async () => {
    const { global, applyEffectChain, closePluginUi } = harness()
    const bus = global.sum('drums')
    await bus.effect(rack('A', 'B'))
    await global.openPluginUi('sum:drums', 2, 'B')
    let finishApply!: () => void
    applyEffectChain.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishApply = () => resolve({ status: 'applied', childPid: 32, dropped: [] })
        }),
    )

    const applying = bus.effect(rack('B'))
    while (applyEffectChain.mock.calls.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    closePluginUi.mockRejectedValueOnce(new Error('window does not match chain index binding'))

    await expect(global.closePluginUi('sum:drums', 2)).rejects.toThrow(
      'window does not match chain index binding',
    )
    finishApply()
    await applying
    await expect(global.closePluginUi('sum:drums', 1)).resolves.toMatchObject({
      receiver: 'sum:drums',
      index: 1,
      completion: 'safepoint-completed',
    })
  })
})
