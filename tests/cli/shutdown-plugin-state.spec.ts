import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { shutdown } from '../../packages/engine/src/cli/shutdown'
import { Global } from '../../packages/engine/src/core/global'

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
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
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

  it('T3: awaits each global snapshot sequentially', async () => {
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
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
    expect(events).toEqual(['first:start'])
    releaseFirst?.()
    await vi.waitFor(() => expect(releaseSecond).toBeTypeOf('function'))
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
    releaseSecond?.()
    await pending

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('continues to quit when the snapshot exceeds its shutdown budget', async () => {
    vi.useFakeTimers()
    mockExit()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const audioEngine = makeAudioEngine()
    const global = harness(audioEngine).global
    const snapshot = vi
      .spyOn(global, 'saveAllPluginStates')
      .mockImplementation(() => new Promise<never>(() => {}))
    const interpreter = {
      getGlobals: () => [global],
      audioEngine,
    }

    const pending = shutdown(interpreter as never)
    await vi.advanceTimersByTimeAsync(1_200)
    await pending

    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(audioEngine.quit).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(
      '[plugin-state] shutdown snapshot timed out after 1200ms',
    )
  })
})
