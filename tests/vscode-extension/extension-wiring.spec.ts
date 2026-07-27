/**
 * Wiring tests for extension.ts's setup*Handler effects-object literals
 * (#527 review Critical #3).
 *
 * engine-lifecycle.spec.ts proves engine-lifecycle.ts's pure decision logic
 * calls whatever fake effects it's handed, in the right shape — it says
 * NOTHING about whether extension.ts wired the CORRECT real implementation
 * into each same-shaped callback slot (e.g. `showStoppedStatus` vs
 * `refreshEngineView`, both `() => void`). Swapping two same-signature
 * callbacks in extension.ts type-checks fine and leaves the unit suite and
 * the gated E2E green — see the review finding for the concrete example.
 *
 * These specs import extension.ts directly (via the `vscode` alias
 * configured in packages/engine/vitest.config.ts, resolving to
 * tests/mocks/vscode.ts) and drive the exported setupStdoutHandler /
 * setupExitHandler / setupStdinErrorHandler functions with fake
 * ChildProcess-shaped objects plus the extension's test-only
 * `__set*ForTest`/`__getDeviceSwitchBridgeForTest` seams — NOT the full
 * `activate()` flow, which has unrelated side effects (MCP server bring-up,
 * auto-start device probing, command/tree registration).
 */
import type { ChildProcess } from 'child_process'

import { describe, it, expect, beforeEach } from 'vitest'

import { DeviceSwitchBridge } from '../../packages/vscode-extension/src/device-switch-bridge'
import * as ext from '../../packages/vscode-extension/src/extension'

interface FakeChildProcess {
  proc: ChildProcess
  fireExit: (code: number | null) => void
  fireStdoutData: (chunk: string) => void
  fireStdinError: (err: Error) => void
}

function fakeChildProcess(): FakeChildProcess {
  const exitListeners: Array<(code: number | null) => void> = []
  const stdoutListeners: Array<(data: Buffer) => void> = []
  const stdinErrorListeners: Array<(err: Error) => void> = []

  const proc: Partial<ChildProcess> = {
    on: ((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'exit') exitListeners.push(cb as (code: number | null) => void)
      return proc
    }) as ChildProcess['on'],
    stdout: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'data') stdoutListeners.push(cb as (data: Buffer) => void)
      },
    } as unknown as ChildProcess['stdout'],
    stdin: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') stdinErrorListeners.push(cb as (err: Error) => void)
      },
    } as unknown as ChildProcess['stdin'],
  }

  return {
    proc: proc as ChildProcess,
    fireExit: (code) => exitListeners.forEach((cb) => cb(code)),
    fireStdoutData: (chunk) => stdoutListeners.forEach((cb) => cb(Buffer.from(chunk))),
    fireStdinError: (err) => stdinErrorListeners.forEach((cb) => cb(err)),
  }
}

describe('extension.ts wiring (#527 review Critical #3)', () => {
  beforeEach(() => {
    ext.__setEngineProcessForTest(null)
    ext.__setStatusBarItemForTest(null)
    ext.__setOutputChannelForTest(null)
    ext.__setEngineViewProviderForTest(null)
  })

  describe('setupStdoutHandler', () => {
    it('wires setTransportStatus("playing") into the Playing status bar text', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      const statusBarItem = { text: '', tooltip: '' }
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest(statusBarItem)
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })

      ext.setupStdoutHandler(proc, false)
      fireStdoutData('✅ Global running\n')

      expect(statusBarItem.text).toBe('🎵 OrbitScore: ▶️ Playing')
    })

    it('wires setTransportStatus("ready") into the Ready status bar text', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      const statusBarItem = { text: '', tooltip: '' }
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest(statusBarItem)
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })

      ext.setupStdoutHandler(proc, false)
      fireStdoutData('✅ Global stopped\n')

      expect(statusBarItem.text).toBe('🎵 OrbitScore: Ready')
    })
  })

  describe('setupExitHandler', () => {
    it('wires showStoppedStatus and refreshEngineView to the correct effect, in the declared order', () => {
      // Both callbacks are unconditionally invoked once per current-process
      // exit, so asserting each side effect happened is NOT enough to catch
      // a same-signature swap (e.g. showStoppedStatus's body accidentally
      // wired to refresh the tree view, and vice versa) — the aggregate
      // final state looks identical either way. Recording the ORDER the two
      // distinct side effects fire in (via a getter/setter on `text`, since
      // applyEngineExit calls showStoppedStatus() strictly before
      // refreshEngineView()) makes a body-swap observable: it flips the
      // recorded order without changing the final state.
      const { proc, fireExit } = fakeChildProcess()
      const calls: string[] = []
      let statusText = 'untouched'
      let statusTooltip = 'untouched'
      const statusBarItem = {
        get text() {
          return statusText
        },
        set text(value: string) {
          statusText = value
          if (value === '🎵 OrbitScore: Stopped') calls.push('status-stopped')
        },
        get tooltip() {
          return statusTooltip
        },
        set tooltip(value: string) {
          statusTooltip = value
        },
      }
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest(statusBarItem)
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setEngineViewProviderForTest({
        refresh: () => {
          calls.push('refresh')
        },
      })

      ext.setupExitHandler(proc)
      fireExit(0)

      expect(statusText).toBe('🎵 OrbitScore: Stopped')
      expect(statusTooltip).toBe('Click to start engine')
      expect(calls).toEqual(['status-stopped', 'refresh'])
    })

    it('wires clearEngineState to null the current engineProcess handle', () => {
      const { proc, fireExit } = fakeChildProcess()
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setEngineViewProviderForTest({ refresh: () => {} })

      ext.setupExitHandler(proc)
      fireExit(0)

      expect(ext.__getEngineProcessForTest()).toBeNull()
    })

    it('wires drainDeviceBridge: a pending selectAudioDevice request resolves with the exit reason', async () => {
      const { proc, fireExit } = fakeChildProcess()
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setEngineViewProviderForTest({ refresh: () => {} })

      const bridge = ext.__getDeviceSwitchBridgeForTest()
      // Short timeout as a safety net only — drainAll() below must resolve
      // this well before it fires; if wiring is broken, the test still fails
      // fast (with a "timed out" error, not a hang) instead of red-herring
      // green.
      const resultPromise = bridge.send(() => true, 'device-name', 200)

      ext.setupExitHandler(proc)
      fireExit(0)

      const result = await resultPromise
      expect(result.ok).toBe(false)
      expect(result.error).toBe('engine process exited before responding to //#selectAudioDevice')
    })

    it('skips every current-process-only effect for a stale process (identity guard still wired end-to-end)', () => {
      const { proc, fireExit } = fakeChildProcess()
      const otherProc = fakeChildProcess().proc
      const statusBarItem = { text: 'untouched', tooltip: 'untouched' }
      let refreshCalls = 0
      // engineProcess points at a DIFFERENT process than the one whose
      // 'exit' fires below — the #528 stop→start race the identity guard
      // exists for.
      ext.__setEngineProcessForTest(otherProc)
      ext.__setStatusBarItemForTest(statusBarItem)
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setEngineViewProviderForTest({
        refresh: () => {
          refreshCalls += 1
        },
      })

      ext.setupExitHandler(proc)
      fireExit(1)

      expect(statusBarItem.text).toBe('untouched')
      expect(refreshCalls).toBe(0)
    })
  })

  describe('setupStdinErrorHandler', () => {
    it('wires drainDeviceBridge: a pending selectAudioDevice request resolves with the stdin-error reason', async () => {
      const { proc, fireStdinError } = fakeChildProcess()
      ext.__setEngineProcessForTest(proc)
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })

      const bridge = ext.__getDeviceSwitchBridgeForTest()
      const resultPromise = bridge.send(() => true, 'device-name', 200)

      ext.setupStdinErrorHandler(proc)
      fireStdinError(new Error('EPIPE'))

      const result = await resultPromise
      expect(result.ok).toBe(false)
      expect(result.error).toBe('engine stdin error: EPIPE')
    })

    it('does not drain the device bridge for a stale process', async () => {
      const { proc, fireStdinError } = fakeChildProcess()
      const otherProc = fakeChildProcess().proc
      ext.__setEngineProcessForTest(otherProc)
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })

      const bridge = ext.__getDeviceSwitchBridgeForTest()
      // A short real timeout is the only way to observe "did NOT drain" — if
      // this test regresses on a slower machine, raise this value, not the
      // assertion's meaning.
      const resultPromise = bridge.send(() => true, 'device-name', 150)

      ext.setupStdinErrorHandler(proc)
      fireStdinError(new Error('EPIPE'))

      const result = await resultPromise
      expect(result.error).toContain('timed out')
    })
  })

  it('sanity: DeviceSwitchBridge is the real vscode-free class (bridge assertions above are not vacuous)', () => {
    expect(ext.__getDeviceSwitchBridgeForTest()).toBeInstanceOf(DeviceSwitchBridge)
  })
})
