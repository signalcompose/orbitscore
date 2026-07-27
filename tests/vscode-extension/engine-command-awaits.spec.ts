import type { ChildProcess } from 'child_process'

import type { ExtensionContext, WorkspaceConfiguration } from 'vscode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) }
})

vi.mock('../../packages/vscode-extension/src/engine-startup-runtime', () => ({
  extensionEngineFileExists: vi.fn(() => true),
  resolveDaemonBinaryForExtension: vi.fn(() => ({
    path: '/unit-test/orbit-audio-daemon',
    source: 'unit-test',
  })),
}))

let child_process: typeof import('child_process')
let ext: typeof import('../../packages/vscode-extension/src/extension')
let vscode: typeof import('vscode')
let vscodeMock: typeof import('../mocks/vscode')

function fakeSpawnedProcess(stdinWritable = false): ChildProcess {
  const proc: Partial<ChildProcess> = {
    killed: false,
    kill: (() => {
      proc.killed = true
      return true
    }) as ChildProcess['kill'],
    on: (() => proc) as ChildProcess['on'],
    stdout: { on: () => {} } as unknown as ChildProcess['stdout'],
    stderr: { on: () => {} } as unknown as ChildProcess['stderr'],
    stdin: {
      on: () => {},
      writable: stdinWritable,
      write: () => true,
    } as unknown as ChildProcess['stdin'],
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

async function expectSelectDeviceRestartFailure(
  bridgeResult: { ok: false; error: string } | undefined,
  expectedBranchLine: string,
  restartFailure: string,
): Promise<void> {
  vi.useFakeTimers()
  await activateForCommands()
  ext.__setEngineProcessForTest(fakeSpawnedProcess(bridgeResult !== undefined))
  const appendedLines: string[] = []
  ext.__setOutputChannelForTest({
    appendLine: (value: string) => appendedLines.push(value),
    append: () => {},
  })
  const warning = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Restart Engine')

  const commandPromise = handler('orbitscore.engineViewSelectDevice')({
    id: 'device:Test Device',
    kind: 'device',
    label: 'Test Device',
    collapsible: false,
  }) as Promise<void>
  if (bridgeResult) {
    const bridge = ext.__getDeviceSwitchBridgeForTest()
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.pendingCount).toBe(1)
    expect(bridge.handleLine(JSON.stringify({ selectAudioDevice: bridgeResult }))).toBe(true)
  }
  await commandPromise

  expect(
    warning.mock.calls.some(([message, choice]) => {
      return String(message).includes(expectedBranchLine) && choice === 'Restart Engine'
    }),
  ).toBe(true)

  ext.__setEngineViewProviderForTest({
    refresh: () => {
      throw new Error(restartFailure)
    },
  })
  await vi.advanceTimersByTimeAsync(2200)

  expect(
    appendedLines.some(
      (line) =>
        line.includes('internal error in engineViewSelectDevice') && line.includes(restartFailure),
    ),
    appendedLines.join('\n'),
  ).toBe(true)
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

  it('engineViewSelectDevice unavailable recovery logs its rejected restart', async () => {
    await expectSelectDeviceRestartFailure(
      {
        ok: false,
        error: 'AUDIO_DEVICE_SWITCH_UNAVAILABLE: recording is active',
      },
      '録音中は切替できません',
      'unavailable recovery restart failed',
    )
  })

  it('engineViewSelectDevice failed-result recovery logs its rejected restart', async () => {
    await expectSelectDeviceRestartFailure(
      {
        ok: false,
        error: 'requested device disappeared',
      },
      'live device switch failed: requested device disappeared',
      'failed-result recovery restart failed',
    )
  })

  it('engineViewSelectDevice bridge-exception recovery logs its rejected restart', async () => {
    await expectSelectDeviceRestartFailure(
      undefined,
      'live device switch bridge error: engine stdin is not writable',
      'bridge-exception recovery restart failed',
    )
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
    const restartFailure = 'toggle-debug recovery restart failed'
    ext.__setEngineViewProviderForTest({
      refresh: () => {
        throw new Error(restartFailure)
      },
    })
    await vi.advanceTimersByTimeAsync(2200)

    expect(
      appendedLines.some(
        (line) =>
          line.includes('internal error in engineViewToggleDebug') && line.includes(restartFailure),
      ),
    ).toBe(true)
  })
})
