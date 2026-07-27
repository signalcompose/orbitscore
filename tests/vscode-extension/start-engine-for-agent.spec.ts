/**
 * Integration test for `startEngineForAgent`'s post-spawn detection of a
 * `ChildProcess` `'error'` event (#533).
 *
 * Unlike extension-wiring.spec.ts (which calls the exported setup*Handler
 * functions directly, bypassing `startEngine()`'s pre-flight entirely), this
 * spec mocks `child_process.spawn` plus the extension build-artifact boundary,
 * then exercises the REAL `startEngine()` pre-flight and spawn-confirmation
 * path. The boundary mock supplies a resolved daemon and confirms the
 * extension-local CLI path is present; assertions below prove both pre-flight
 * checks still ran. Engine-kind resolution remains real (and intentionally
 * exercises its production fallback when ignored build artifacts are absent).
 * This is the only way to prove `startEngineForAgent` itself (not just
 * `applyEngineError`'s pure logic, covered in engine-lifecycle.spec.ts)
 * detects a spawn failure without making the unit test depend on a prior
 * extension build.
 *
 * #533's core claim: `engineProcess.killed` cannot detect a spawn failure —
 * it only reflects whether WE sent a signal, and we never do on failure. A
 * spawn failure instead surfaces as an `'error'` event, which Node defers
 * via `process.nextTick()` specifically so a listener attached synchronously
 * right after `spawn()` (as `setupErrorHandler` is, inside `startEngine()`)
 * still catches it. `fakeSpawnedProcess.fireError` below mimics that exact
 * deferred-via-nextTick scheduling — a synchronous `emit` would not
 * reproduce the race `startEngineForAgent`'s fix targets.
 */
import * as child_process from 'child_process'

import * as vscode from 'vscode'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  extensionEngineFileExists,
  resolveDaemonBinaryForExtension,
} from '../../packages/vscode-extension/src/engine-startup-runtime'
import * as ext from '../../packages/vscode-extension/src/extension'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  }
})

vi.mock('../../packages/vscode-extension/src/engine-startup-runtime', () => ({
  extensionEngineFileExists: vi.fn(() => true),
  resolveDaemonBinaryForExtension: vi.fn(() => ({
    path: '/unit-test/orbit-audio-daemon',
    source: 'unit-test',
  })),
}))

interface FakeSpawnedProcess {
  proc: child_process.ChildProcess
  fireError: (err: Error) => void
}

function fakeSpawnedProcess(): FakeSpawnedProcess {
  const errorListeners: Array<(err: Error) => void> = []
  const proc: Partial<child_process.ChildProcess> = {
    killed: false,
    on: ((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'error') errorListeners.push(cb as (err: Error) => void)
      return proc
    }) as child_process.ChildProcess['on'],
    stdout: { on: () => {} } as unknown as child_process.ChildProcess['stdout'],
    stderr: { on: () => {} } as unknown as child_process.ChildProcess['stderr'],
    stdin: { on: () => {} } as unknown as child_process.ChildProcess['stdin'],
  }
  return {
    proc: proc as child_process.ChildProcess,
    fireError: (err) => {
      process.nextTick(() => errorListeners.forEach((cb) => cb(err)))
    },
  }
}

describe('startEngineForAgent post-spawn detection (#533)', () => {
  let showInformationMessage: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.mocked(extensionEngineFileExists).mockClear()
    vi.mocked(resolveDaemonBinaryForExtension).mockClear()
    ext.__setEngineProcessForTest(null)
    ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
    ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
    ext.__setEngineViewProviderForTest({ refresh: () => {} })
    showInformationMessage = vi
      .spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.mocked(child_process.spawn).mockReset()
    showInformationMessage.mockRestore()
  })

  it('reports ok:false when the spawned process emits "error" shortly after spawn (e.g. ENOENT)', async () => {
    const { proc, fireError } = fakeSpawnedProcess()
    vi.mocked(child_process.spawn).mockImplementation(() => {
      fireError(new Error('spawn node ENOENT'))
      return proc
    })

    const result = await ext.startEngineForAgent()

    expect(result).toEqual({
      ok: false,
      error: 'engine failed to start — see the OrbitScore output channel',
    })
    expect(showInformationMessage).not.toHaveBeenCalled()
    // setupErrorHandler's identity-guarded teardown actually ran — proves
    // this isn't a hang/timeout being misread as detection.
    expect(ext.__getEngineProcessForTest()).toBeNull()
  })

  it('contains a synchronous spawn throw and leaves engine state clean', async () => {
    vi.mocked(child_process.spawn).mockImplementation(() => {
      throw new Error('spawn node ENOTDIR')
    })

    const result = await ext.startEngineForAgent()

    expect(result).toEqual({
      ok: false,
      error: 'engine failed to start — see the OrbitScore output channel',
    })
    expect(ext.__getEngineProcessForTest()).toBeNull()
    expect(showInformationMessage).not.toHaveBeenCalled()
  })

  it('reports ok:true and shows the unchanged debug success toast once after spawn confirmation', async () => {
    const { proc } = fakeSpawnedProcess()
    vi.mocked(child_process.spawn).mockImplementation(() => proc)

    const result = await ext.startEngineForAgent({ debug: true })

    expect(result).toEqual({ ok: true, message: 'engine starting' })
    expect(resolveDaemonBinaryForExtension).toHaveBeenCalledOnce()
    expect(extensionEngineFileExists).toHaveBeenCalledOnce()
    expect(extensionEngineFileExists).toHaveBeenCalledWith(
      expect.stringContaining('packages/vscode-extension/engine/dist/cli-audio.js'),
    )
    expect(showInformationMessage).toHaveBeenCalledTimes(1)
    expect(showInformationMessage).toHaveBeenCalledWith('✅ Engine started (Debug)')
  })

  it('does not show a success toast on spawn failure through the palette toggle command', async () => {
    const { proc, fireError } = fakeSpawnedProcess()
    vi.mocked(child_process.spawn).mockImplementation(() => {
      fireError(new Error('spawn node ENOENT'))
      return proc
    })

    await ext.toggleEngine()

    expect(showInformationMessage).not.toHaveBeenCalled()
    expect(ext.__getEngineProcessForTest()).toBeNull()
  })
})
