import { afterEach, describe, expect, it, vi } from 'vitest'

import { shutdown } from '../../packages/engine/src/cli/shutdown'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mockExit(): void {
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
}

describe('shutdown plugin-state snapshot (#577)', () => {
  it('stops and awaits every global snapshot before quitting the audio engine', async () => {
    mockExit()
    const first = {
      stop: vi.fn(),
      saveAllPluginStates: vi.fn().mockResolvedValue({ saved: 1, failures: 0 }),
    }
    const second = {
      stop: vi.fn(),
      saveAllPluginStates: vi.fn().mockResolvedValue({ saved: 1, failures: 0 }),
    }
    const quit = vi.fn().mockResolvedValue(undefined)
    const interpreter = {
      getGlobals: () => [first, second],
      audioEngine: { quit },
    }

    await shutdown(interpreter as never)

    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(second.stop).toHaveBeenCalledTimes(1)
    expect(first.saveAllPluginStates).toHaveBeenCalledTimes(1)
    expect(second.saveAllPluginStates).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(first.saveAllPluginStates.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0],
    )
    expect(second.saveAllPluginStates.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0],
    )
  })

  it('continues to quit when the snapshot exceeds its shutdown budget', async () => {
    vi.useFakeTimers()
    mockExit()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const snapshot = vi.fn(() => new Promise<never>(() => {}))
    const quit = vi.fn().mockResolvedValue(undefined)
    const interpreter = {
      getGlobals: () => [{ stop: vi.fn(), saveAllPluginStates: snapshot }],
      audioEngine: { quit },
    }

    const pending = shutdown(interpreter as never)
    await vi.advanceTimersByTimeAsync(1_200)
    await pending

    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(
      '[plugin-state] shutdown snapshot timed out after 1200ms',
    )
  })
})
