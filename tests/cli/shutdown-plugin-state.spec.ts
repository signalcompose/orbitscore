import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { shutdown } from '../../packages/engine/src/cli/shutdown'
import { Global } from '../../packages/engine/src/core/global'
import { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function mockExit(): void {
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
}

function makeAudioEngine() {
  return {
    isRunning: true,
    startTime: 0,
    boot: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    getAudioDuration: vi.fn(() => 1),
    quit: vi.fn().mockResolvedValue(undefined),
  }
}

function harness(audioEngine = makeAudioEngine()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-shutdown-plugin-state-'))
  temporaryDirectories.push(directory)
  const global = new Global(audioEngine as never)
  global.setDocumentDirectory(directory)
  return { audioEngine, directory, global }
}

describe('shutdown plugin-state snapshot (#577)', () => {
  it('uses the real InterpreterV2 global registry during shutdown', async () => {
    mockExit()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const audioEngine = makeAudioEngine()
    const interpreter = new InterpreterV2({ audioEngine: audioEngine as never })
    await interpreter.execute({
      globalInit: { type: 'global_init', variableName: 'global' },
      sequenceInits: [],
      statements: [],
    })
    const snapshot = vi
      .spyOn(Global.prototype, 'saveAllPluginStates')
      .mockResolvedValue({ saved: 0, failures: 0 })

    await shutdown(interpreter)

    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(audioEngine.quit).toHaveBeenCalledTimes(1)
  })

  it('stops and awaits every global snapshot before quitting the audio engine', async () => {
    mockExit()
    const audioEngine = makeAudioEngine()
    const first = harness(audioEngine).global
    const second = harness(audioEngine).global
    const firstStop = vi.spyOn(first, 'stop')
    const secondStop = vi.spyOn(second, 'stop')
    const firstSnapshot = vi
      .spyOn(first, 'saveAllPluginStates')
      .mockResolvedValue({ saved: 1, failures: 0 })
    const secondSnapshot = vi
      .spyOn(second, 'saveAllPluginStates')
      .mockResolvedValue({ saved: 1, failures: 0 })
    const interpreter = {
      getGlobals: () => [first, second],
      audioEngine,
    }

    await shutdown(interpreter as never)

    expect(firstStop).toHaveBeenCalledTimes(1)
    expect(secondStop).toHaveBeenCalledTimes(1)
    expect(firstSnapshot).toHaveBeenCalledTimes(1)
    expect(secondSnapshot).toHaveBeenCalledTimes(1)
    expect(audioEngine.quit).toHaveBeenCalledTimes(1)
    expect(firstSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      audioEngine.quit.mock.invocationCallOrder[0],
    )
    expect(secondSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      audioEngine.quit.mock.invocationCallOrder[0],
    )
  })

  it('T2: snapshots exactly once through shutdown while the transport is running', async () => {
    mockExit()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const audioEngine = makeAudioEngine()
    const first = harness(audioEngine).global
    const second = harness(audioEngine).global
    const firstSnapshot = vi
      .spyOn(first, 'saveAllPluginStates')
      .mockResolvedValue({ saved: 1, failures: 0 })
    const secondSnapshot = vi
      .spyOn(second, 'saveAllPluginStates')
      .mockResolvedValue({ saved: 1, failures: 0 })
    first.start()
    second.start()

    await shutdown({
      getGlobals: () => [first, second],
      audioEngine,
    } as never)

    expect(firstSnapshot).toHaveBeenCalledTimes(1)
    expect(secondSnapshot).toHaveBeenCalledTimes(1)
  })

  it('T3: starts every global snapshot concurrently', async () => {
    mockExit()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const audioEngine = makeAudioEngine()
    const first = harness(audioEngine).global
    const second = harness(audioEngine).global
    const events: string[] = []
    let releaseFirst: (() => void) | undefined
    let releaseSecond: (() => void) | undefined
    vi.spyOn(first, 'saveAllPluginStates').mockImplementation(async () => {
      events.push('first:start')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      events.push('first:end')
      return { saved: 1, failures: 0 }
    })
    vi.spyOn(second, 'saveAllPluginStates').mockImplementation(async () => {
      events.push('second:start')
      await new Promise<void>((resolve) => {
        releaseSecond = resolve
      })
      events.push('second:end')
      return { saved: 1, failures: 0 }
    })
    first.start()
    second.start()

    const pending = shutdown({
      getGlobals: () => [first, second],
      audioEngine,
    } as never)
    await vi.waitFor(() => {
      expect(releaseFirst).toBeTypeOf('function')
      expect(releaseSecond).toBeTypeOf('function')
    })
    expect(events).toEqual(['first:start', 'second:start'])
    releaseSecond?.()
    releaseFirst?.()
    await pending

    expect(events).toEqual(['first:start', 'second:start', 'second:end', 'first:end'])
  })

  it('reports confirmed target progress and continues to quit after the shutdown budget', async () => {
    vi.useFakeTimers()
    mockExit()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const audioEngine = makeAudioEngine()
    const first = harness(audioEngine).global
    const second = harness(audioEngine).global
    vi.spyOn(first, 'listPluginStateTargets').mockReturnValue([{} as never, {} as never])
    vi.spyOn(second, 'listPluginStateTargets').mockReturnValue([{} as never])
    const firstSnapshot = vi
      .spyOn(first, 'saveAllPluginStates')
      .mockResolvedValue({ saved: 1, failures: 1 })
    const secondSnapshot = vi
      .spyOn(second, 'saveAllPluginStates')
      .mockImplementation(() => new Promise<never>(() => {}))
    const interpreter = {
      getGlobals: () => [first, second],
      audioEngine,
    }

    const pending = shutdown(interpreter as never)
    await vi.advanceTimersByTimeAsync(1_200)
    await pending

    expect(firstSnapshot).toHaveBeenCalledTimes(1)
    expect(secondSnapshot).toHaveBeenCalledTimes(1)
    expect(audioEngine.quit).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(
      '[plugin-state] shutdown snapshot timed out after 1200ms (2/3 targets confirmed)',
    )
  })
})
