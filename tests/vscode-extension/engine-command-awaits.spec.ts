import type { ChildProcess } from 'child_process'

import type { ExtensionContext, WorkspaceConfiguration } from 'vscode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) }
})

let child_process: typeof import('child_process')
let ext: typeof import('../../packages/vscode-extension/src/extension')
let vscode: typeof import('vscode')
let vscodeMock: typeof import('../mocks/vscode')

function fakeSpawnedProcess(): ChildProcess {
  const proc: Partial<ChildProcess> = {
    killed: false,
    kill: (() => {
      proc.killed = true
      return true
    }) as ChildProcess['kill'],
    on: (() => proc) as ChildProcess['on'],
    stdout: { on: () => {} } as unknown as ChildProcess['stdout'],
    stderr: { on: () => {} } as unknown as ChildProcess['stderr'],
    stdin: { on: () => {} } as unknown as ChildProcess['stdin'],
  }
  return proc as ChildProcess
}

async function activateForCommands(): Promise<void> {
  vscodeMock.resetRegisteredCommandHandlers()
  await ext.activate({ subscriptions: [] } as unknown as ExtensionContext)
}

function handler(command: string): (...args: unknown[]) => unknown {
  const registered = vscodeMock.registeredCommandHandlers.get(command)
  expect(registered, `${command} was not registered`).toBeDefined()
  return registered!
}

describe('registered command startEngine awaits', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.resetModules()
    ;[child_process, ext, vscode, vscodeMock] = await Promise.all([
      import('child_process'),
      import('../../packages/vscode-extension/src/extension'),
      import('vscode'),
      import('../mocks/vscode'),
    ])
    vi.mocked(child_process.spawn).mockReset()
    vi.mocked(child_process.spawn).mockReturnValue(fakeSpawnedProcess())
    vi.mocked(child_process.execFile).mockReset()
    vi.mocked(child_process.execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(new Error('device enumeration disabled in command-await tests'), '', '')
      return fakeSpawnedProcess()
    }) as typeof child_process.execFile)
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
      update: async () => undefined,
      inspect: (key: string) => ({
        globalValue: key === 'audioDevice' ? '__default__' : undefined,
        workspaceValue: undefined,
      }),
    } as unknown as WorkspaceConfiguration)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('restartEngine awaits startEngine before its registered handler settles', async () => {
    vi.useFakeTimers()
    await activateForCommands()
    ext.__setStatusBarItemForTest(null)

    const result = handler('orbitscore.restartEngine')()
    const rejection = expect(result).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(2200)

    await rejection
  })

  it('engineViewToggleEngine awaits startEngine before its registered handler settles', async () => {
    await activateForCommands()
    ext.__setStatusBarItemForTest(null)

    await expect(handler('orbitscore.engineViewToggleEngine')()).rejects.toThrow()
  })

  it('engineViewSelectDevice awaits startEngine before its registered handler settles', async () => {
    await activateForCommands()
    ext.__setStatusBarItemForTest(null)

    await expect(
      handler('orbitscore.engineViewSelectDevice')({
        id: 'device:Test Device',
        kind: 'device',
        label: 'Test Device',
        collapsible: false,
      }),
    ).rejects.toThrow()
  })

  it('autoStartConfiguredRustEngine awaits startEngine so its rejection reaches its catch', async () => {
    let deviceCallback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    vi.mocked(child_process.execFile).mockImplementation(((_file, _args, _options, callback) => {
      deviceCallback = callback as typeof deviceCallback
      return {} as ChildProcess
    }) as typeof child_process.execFile)
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
      update: async () => undefined,
      inspect: (key: string) => ({
        globalValue: key === 'audioDevice' ? '__default__' : undefined,
        workspaceValue: undefined,
      }),
    } as unknown as WorkspaceConfiguration)
    const warning = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined)

    await activateForCommands()
    ext.__setStatusBarItemForTest(null)
    deviceCallback!(null, '{"devices":[]}', '')
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(warning).toHaveBeenCalled()
  })

  it('engineViewToggleDebug timeout routes a rejected startEngine through logHandlerFailure', async () => {
    vi.useFakeTimers()
    await activateForCommands()
    const running = fakeSpawnedProcess()
    ext.__setEngineProcessForTest(running)
    const appendedLines: string[] = []
    ext.__setOutputChannelForTest({
      appendLine: (value: string) => appendedLines.push(value),
      append: () => {},
    })
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Restart Engine')

    await handler('orbitscore.engineViewToggleDebug')()
    ext.__setStatusBarItemForTest(null)
    await vi.advanceTimersByTimeAsync(2200)

    expect(
      appendedLines.some((line) => line.includes('internal error in engineViewToggleDebug')),
    ).toBe(true)
  })
})
