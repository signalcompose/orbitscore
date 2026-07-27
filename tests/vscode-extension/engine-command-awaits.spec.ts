import * as child_process from 'child_process'

import * as vscode from 'vscode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as ext from '../../packages/vscode-extension/src/extension'
import * as vscodeMock from '../mocks/vscode'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) }
})

function fakeSpawnedProcess(): child_process.ChildProcess {
  const proc: Partial<child_process.ChildProcess> = {
    killed: false,
    kill: (() => {
      proc.killed = true
      return true
    }) as child_process.ChildProcess['kill'],
    on: (() => proc) as child_process.ChildProcess['on'],
    stdout: { on: () => {} } as unknown as child_process.ChildProcess['stdout'],
    stderr: { on: () => {} } as unknown as child_process.ChildProcess['stderr'],
    stdin: { on: () => {} } as unknown as child_process.ChildProcess['stdin'],
  }
  return proc as child_process.ChildProcess
}

async function activateForCommands(): Promise<void> {
  vscodeMock.resetRegisteredCommandHandlers()
  await ext.activate({ subscriptions: [] } as unknown as vscode.ExtensionContext)
}

function handler(command: string): (...args: unknown[]) => unknown {
  const registered = vscodeMock.registeredCommandHandlers.get(command)
  expect(registered, `${command} was not registered`).toBeDefined()
  return registered!
}

describe('registered command startEngine awaits', () => {
  beforeEach(() => {
    // Defensive isolation. `--pool=forks --poolOptions.forks.singleFork=true`
    // means every spec file shares ONE `extension.ts` module instance, so
    // module-level engine state and `vi` spies survive across files. These
    // tests make `startEngine()` reject by nulling `statusBarItem`, which a
    // leftover `engineProcess` (early "already running" return) or a leftover
    // spy can defeat — so reset both rather than trusting other specs to clean
    // up after themselves.
    //
    // Honest note: two of these tests once failed in the full suite while
    // passing in isolation, but that observation was made while this file was
    // being edited concurrently, so the failing state is not reproducible and
    // the exact leak was never isolated. Measured afterwards: removing any ONE
    // of these three resets (this line, the `restoreAllMocks` above, or the
    // whole `afterEach`) still leaves the suite green — none is individually
    // load-bearing today. They are kept as cheap insurance against a future
    // spec leaking state into this one, not as a fix for a known culprit.
    vi.restoreAllMocks()
    vi.useRealTimers()
    ext.__setEngineProcessForTest(null)
    vi.mocked(child_process.spawn).mockReset()
    vi.mocked(child_process.spawn).mockReturnValue(fakeSpawnedProcess())
    vi.mocked(child_process.execFile).mockReset()
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
      update: async () => undefined,
      inspect: (key: string) => ({
        globalValue: key === 'audioDevice' ? '__default__' : undefined,
        workspaceValue: undefined,
      }),
    } as unknown as vscode.WorkspaceConfiguration)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    ext.__setEngineProcessForTest(null)
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
      return {} as child_process.ChildProcess
    }) as typeof child_process.execFile)
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
      update: async () => undefined,
      inspect: (key: string) => ({
        globalValue: key === 'audioDevice' ? '__default__' : undefined,
        workspaceValue: undefined,
      }),
    } as unknown as vscode.WorkspaceConfiguration)
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
