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

import { describe, it, expect, beforeEach, vi } from 'vitest'

import { DeviceSwitchBridge } from '../../packages/vscode-extension/src/device-switch-bridge'
import * as engineLifecycle from '../../packages/vscode-extension/src/engine-lifecycle'
import * as ext from '../../packages/vscode-extension/src/extension'
// Resolves to the SAME module instance `extension.ts`'s `import * as vscode
// from 'vscode'` gets via the root vitest.config.ts alias — pushing into
// `vscodeMock.window.visibleTextEditors` is observed by extension.ts's own
// `vscode.window.visibleTextEditors` reads (round 3 Critical #1).
import * as vscodeMock from '../mocks/vscode'

// #527 review round 4 Important #2: a pass-through spy on the REAL
// `applyEngineExit`, not a behavior replacement — every export other than
// `applyEngineExit` is untouched, and `applyEngineExit` itself still runs its
// actual body via `vi.fn(actual.applyEngineExit)`. This lets the
// "clearEngineState and clearAllPlayheads" spec below (only) capture the
// `effects` object `setupExitHandler` builds, without disturbing any other
// exitHandler spec in this file, which all still exercise the genuine
// `applyEngineExit` end-to-end exactly as before.
vi.mock('../../packages/vscode-extension/src/engine-lifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../packages/vscode-extension/src/engine-lifecycle')>()
  return {
    ...actual,
    applyEngineExit: vi.fn(actual.applyEngineExit),
  }
})

interface FakeChildProcess {
  proc: ChildProcess
  fireExit: (code: number | null) => void
  fireStdoutData: (chunk: string) => void
  fireStderrData: (chunk: string) => void
  fireStdinError: (err: Error) => void
  fireError: (err: Error) => void
}

function fakeChildProcess(): FakeChildProcess {
  const exitListeners: Array<(code: number | null) => void> = []
  const stdoutListeners: Array<(data: Buffer) => void> = []
  const stderrListeners: Array<(data: Buffer) => void> = []
  const stdinErrorListeners: Array<(err: Error) => void> = []
  const errorListeners: Array<(err: Error) => void> = []

  const proc: Partial<ChildProcess> = {
    on: ((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'exit') exitListeners.push(cb as (code: number | null) => void)
      if (event === 'error') errorListeners.push(cb as (err: Error) => void)
      return proc
    }) as ChildProcess['on'],
    stdout: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'data') stdoutListeners.push(cb as (data: Buffer) => void)
      },
    } as unknown as ChildProcess['stdout'],
    stderr: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'data') stderrListeners.push(cb as (data: Buffer) => void)
      },
    } as unknown as ChildProcess['stderr'],
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
    fireStderrData: (chunk) => stderrListeners.forEach((cb) => cb(Buffer.from(chunk))),
    fireStdinError: (err) => stdinErrorListeners.forEach((cb) => cb(err)),
    fireError: (err) => errorListeners.forEach((cb) => cb(err)),
  }
}

describe('extension.ts wiring (#527 review Critical #3)', () => {
  beforeEach(() => {
    ext.__setEngineProcessForTest(null)
    ext.__setStatusBarItemForTest(null)
    ext.__setOutputChannelForTest(null)
    ext.__setEngineViewProviderForTest(null)
    ext.__resetPlayheadStateForTest()
    vscodeMock.window.visibleTextEditors.length = 0
    vi.mocked(engineLifecycle.applyEngineExit).mockClear()
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

    // #527 review round 3 Critical #2: handleStep / clearSequence /
    // clearAllPlayheads / handleSelectAudioDeviceLine had ZERO wiring
    // coverage — replacing all four with no-ops simultaneously left the
    // existing two setTransportStatus tests above (the only stdout-handler
    // coverage that existed) green. Each test below asserts a signal that
    // ONLY the named effect's real implementation produces, so a no-op
    // substitution of that one effect fails here independent of the other
    // three.
    it('wires handleStep: a [STEP] line schedules a playhead timeout (independent of the other three effects)', () => {
      vi.useFakeTimers()
      try {
        const { proc, fireStdoutData } = fakeChildProcess()
        ext.__setEngineProcessForTest(proc)
        ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
        ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })

        expect(ext.__getPlayheadTimeoutCountForTest()).toBe(0)

        ext.setupStdoutHandler(proc, false)
        fireStdoutData(`[STEP] seqStep 0 ${Date.now()}\n`)

        expect(ext.__getPlayheadTimeoutCountForTest()).toBe(1)
      } finally {
        ext.__resetPlayheadStateForTest()
        vi.useRealTimers()
      }
    })

    it('wires clearSequence: "⏹ <seq>" clears only that seq\'s playhead range', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setPlayheadActiveRangeForTest(
        'seqA',
        'file:///irrelevant.orbs',
        new vscodeMock.Range(new vscodeMock.Position(0, 0), new vscodeMock.Position(0, 1)),
      )
      expect(ext.__getPlayheadActiveRangeCountForTest()).toBe(1)

      ext.setupStdoutHandler(proc, false)
      fireStdoutData('⏹ seqA\n')

      expect(ext.__getPlayheadActiveRangeCountForTest()).toBe(0)
    })

    it('wires clearAllPlayheads: "✅ Global stopped" clears every playhead range', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setPlayheadActiveRangeForTest(
        'seqB',
        'file:///irrelevant.orbs',
        new vscodeMock.Range(new vscodeMock.Position(0, 0), new vscodeMock.Position(0, 1)),
      )
      expect(ext.__getPlayheadActiveRangeCountForTest()).toBe(1)

      ext.setupStdoutHandler(proc, false)
      fireStdoutData('✅ Global stopped\n')

      expect(ext.__getPlayheadActiveRangeCountForTest()).toBe(0)
    })

    it('wires handleSelectAudioDeviceLine: a well-formed //#selectAudioDevice result line resolves a pending send()', async () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })

      const bridge = ext.__getDeviceSwitchBridgeForTest()
      // Short timeout as a safety net only, matching the exit-handler
      // drainDeviceBridge tests below — if handleSelectAudioDeviceLine were
      // a no-op, this resolves via timeout with `ok: false` instead.
      const resultPromise = bridge.send(() => true, 'Device A', 200)

      ext.setupStdoutHandler(proc, false)
      fireStdoutData('{"selectAudioDevice":{"ok":true,"device":"Device A"}}\n')

      const result = await resultPromise
      expect(result).toEqual({ ok: true, device: 'Device A' })
    })

    // #527 review round 3 Important #1: transcribeLog / warnMalformed...
    // (below, under setupExitHandler: logExit; under setupStdinErrorHandler:
    // logStdinError) had no assertion anywhere on the actual output-channel
    // CONTENT — only that `outputChannel` was truthy-safe to call. A no-op
    // substitution of any one of these four passed all 24 pre-existing
    // tests. Assertions below read the real production template strings
    // from extension.ts (not fabricated expected text) so a wording change
    // in the source and a stale test can't silently drift apart unnoticed —
    // each assertion targets a substring stable across such wording tweaks.
    it('wires transcribeLog (non-debug): filters noise but keeps important lines, verbatim', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      const appended: string[] = []
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({
        appendLine: () => {},
        append: (value: string) => {
          appended.push(value)
        },
      })

      ext.setupStdoutHandler(proc, false)
      fireStdoutData('⚠️ Something important\nsendosc: pure noise line\n')

      const combined = appended.join('')
      expect(combined).toContain('⚠️ Something important')
      expect(combined).not.toContain('sendosc: pure noise line')
    })

    it('wires transcribeLog (debug): passes the raw output through unfiltered', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      const appended: string[] = []
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({
        appendLine: () => {},
        append: (value: string) => {
          appended.push(value)
        },
      })

      ext.setupStdoutHandler(proc, true)
      // "sendosc:" is filtered in non-debug mode (see the test above) — debug
      // mode must let it through verbatim.
      fireStdoutData('sendosc: pure noise line\n')

      expect(appended.join('')).toContain('sendosc: pure noise line')
    })

    it('wires warnMalformedSelectAudioDeviceLine: current engine — no "stale" wording', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      const appendedLines: string[] = []
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({
        appendLine: (value: string) => {
          appendedLines.push(value)
        },
        append: () => {},
      })

      const malformedLine = '{"selectAudioDevice":{"ok":true,"dev'
      ext.setupStdoutHandler(proc, false)
      fireStdoutData(malformedLine + '\n')

      const warning = appendedLines.find((line) => line.includes('malformed'))
      expect(warning, appendedLines.join('\n')).toBeDefined()
      expect(warning).toContain(malformedLine)
      expect(warning).not.toContain('stale engine')
    })

    it('wires warnMalformedSelectAudioDeviceLine: stale engine — includes "from a stale engine" (#527 review Important #1)', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      const otherProc = fakeChildProcess().proc
      const appendedLines: string[] = []
      // engineProcess points at a DIFFERENT process than the one whose
      // stdout fires below — the stale-engine case Important #1 fixed.
      ext.__setEngineProcessForTest(otherProc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({
        appendLine: (value: string) => {
          appendedLines.push(value)
        },
        append: () => {},
      })

      const malformedLine = '{"selectAudioDevice":{"ok":true,"dev'
      ext.setupStdoutHandler(proc, false)
      fireStdoutData(malformedLine + '\n')

      const warning = appendedLines.find((line) => line.includes('malformed'))
      expect(warning, appendedLines.join('\n')).toBeDefined()
      expect(warning).toContain(malformedLine)
      expect(warning).toContain('from a stale engine')
    })

    // #527 review round 4 Important #1: NOTHING wraps this listener body —
    // no `process.on('uncaughtException', ...)` exists anywhere in
    // extension.ts — so an exception escaping it used to crash the extension
    // HOST process (every other extension in the window, not just
    // OrbitScore). `statusBarItem` is null here specifically to trigger a
    // REAL exception via the `statusBarItem!.text = ...` non-null assertion
    // inside `setTransportStatus` (reached via a "✅ Global running" line) —
    // not a synthetic throw — proving the try/catch added around the
    // listener body actually contains a genuine failure from this code path.
    it('contains an exception thrown inside the listener body instead of letting it escape (#527 review round 4 Important #1)', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      const appendedLines: string[] = []
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest(null) // statusBarItem!.text throws on null
      ext.__setOutputChannelForTest({
        appendLine: (value: string) => {
          appendedLines.push(value)
        },
        append: () => {},
      })

      ext.setupStdoutHandler(proc, false)

      expect(() => fireStdoutData('✅ Global running\n')).not.toThrow()

      const marker = appendedLines.find((line) => line.includes('setupStdoutHandler'))
      expect(marker, appendedLines.join('\n')).toBeDefined()
      expect(marker).toContain('🛑 internal error in setupStdoutHandler')
      // The stack trace line, logged separately for root-causing.
      expect(appendedLines.some((line) => line.includes('at '))).toBe(true)
    })

    // #527 review round 5 Minor #1: `logHandlerFailure` itself is called from
    // inside the try/catch above — if ITS body threw (here: a fake
    // `outputChannel.appendLine` that throws, standing in for any future
    // change that makes the real one throw), the exception would re-escape
    // the very catch block meant to contain it, defeating the containment
    // this whole describe block exists to prove. `statusBarItem` is null
    // (same trigger as the test above) to reach `logHandlerFailure` via a
    // genuine failure, not a synthetic call.
    it('does not itself throw when outputChannel.appendLine throws — falls back to console.error (#527 review round 5 Minor #1)', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest(null) // statusBarItem!.text throws on null
      ext.__setOutputChannelForTest({
        appendLine: () => {
          throw new Error('outputChannel.appendLine itself is broken')
        },
        append: () => {},
      })
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        ext.setupStdoutHandler(proc, false)
        expect(() => fireStdoutData('✅ Global running\n')).not.toThrow()

        expect(consoleErrorSpy).toHaveBeenCalled()
        const loggedArgs = consoleErrorSpy.mock.calls[0]
        expect(String(loggedArgs[0])).toContain('setupStdoutHandler')
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })

    // #534: a null `outputChannel` is a SEPARATE failure mode from
    // `appendLine` throwing (the test above) — `outputChannel?.appendLine`
    // on a null channel was a silent no-op via optional chaining, so the
    // `catch` block (which only ever sees THROWN exceptions) was never
    // reached, and no `console.error` fallback fired either. `outputChannel`
    // is null here (not just a throwing fake) to reach that exact branch.
    it('falls back to console.error when outputChannel itself is null (#534)', () => {
      const { proc, fireStdoutData } = fakeChildProcess()
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest(null) // statusBarItem!.text throws on null
      ext.__setOutputChannelForTest(null)
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        ext.setupStdoutHandler(proc, false)
        expect(() => fireStdoutData('✅ Global running\n')).not.toThrow()

        expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
        const loggedArgs = consoleErrorSpy.mock.calls[0]
        expect(String(loggedArgs[0])).toContain('setupStdoutHandler')
        expect(String(loggedArgs[0])).toContain('no output channel')
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })
  })

  describe('setupStderrHandler (#527 review round 5 Minor #2)', () => {
    // Symmetry fix: the other three listener bodies (setupStdoutHandler,
    // setupExitHandler, setupStdinErrorHandler) are each wrapped in
    // try/catch + logHandlerFailure per round 4 Important #1, but
    // setupStderrHandler had been left unwrapped. `outputChannel?.append`
    // has no realistic throw path today, so this test injects a throwing
    // fake to prove the containment exists, the same way the other three
    // handlers' round-4 tests do.
    it('contains an exception thrown inside the listener body instead of letting it escape', () => {
      const { proc, fireStderrData } = fakeChildProcess()
      const appendedLines: string[] = []
      ext.__setOutputChannelForTest({
        appendLine: (value: string) => {
          appendedLines.push(value)
        },
        append: () => {
          throw new Error('injected fault in outputChannel.append')
        },
      })

      ext.setupStderrHandler(proc)

      expect(() => fireStderrData('boom\n')).not.toThrow()

      const marker = appendedLines.find((line) => line.includes('setupStderrHandler'))
      expect(marker, appendedLines.join('\n')).toBeDefined()
      expect(marker).toContain('🛑 internal error in setupStderrHandler')
      expect(appendedLines.some((line) => line.includes('at '))).toBe(true)
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

    // #527 review round 3 Critical #1 originally caught this with an
    // ORDER-based assertion: applyEngineExit happens to call the
    // `clearEngineState` key before the `clearAllPlayheads` key today, so a
    // body-swap between the two flips which observable side effect fires
    // first. #527 review round 4 Important #2 found that assertion itself
    // unsound: `applyEngineExit`'s docstring documents ONLY an identity-guard
    // rationale for these two calls — no ordering contract between them is
    // declared anywhere (`clearAllPlayheads`'s only comment is "#390: nothing
    // is sounding anymore"). A future, equally-correct reordering inside
    // `applyEngineExit` (e.g. clearing playheads before nulling
    // `engineProcess`) would flip the order and fail the old test with NO
    // actual defect — a test that fails on correct code is itself a bug.
    //
    // Redesigned to be ORDER-INDEPENDENT: capture the real `effects` object
    // `setupExitHandler` builds (via a pass-through spy on the real
    // `engine-lifecycle` module — see the `vi.mock` above; every other
    // exitHandler spec in this file still exercises the genuine
    // `applyEngineExit`, unaffected), then invoke `clearEngineState` and
    // `clearAllPlayheads` INDIVIDUALLY against freshly-seeded state. This
    // still catches a body-swap (each key's closure no longer produces its
    // documented single-purpose effect) without asserting anything about
    // which one `applyEngineExit` happens to call first.
    it('wires clearEngineState and clearAllPlayheads to their own distinct effects (order-independent)', () => {
      const { proc, fireExit } = fakeChildProcess()
      const docUriString = 'file:///order-independent-test.orbs'
      const fakeEditor = {
        document: { uri: { toString: () => docUriString } },
        setDecorations: () => {},
      }
      vscodeMock.window.visibleTextEditors.push(fakeEditor)

      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setEngineViewProviderForTest({ refresh: () => {} })

      ext.setupExitHandler(proc)
      fireExit(0)

      const applyEngineExitSpy = vi.mocked(engineLifecycle.applyEngineExit)
      expect(applyEngineExitSpy).toHaveBeenCalledTimes(1)
      const effects = applyEngineExitSpy.mock.calls[0][2]

      // --- clearEngineState in isolation: nulls engineProcess, leaves any
      // playhead range untouched ---
      ext.__setEngineProcessForTest(proc)
      ext.__setPlayheadActiveRangeForTest(
        'seqA',
        docUriString,
        new vscodeMock.Range(new vscodeMock.Position(0, 0), new vscodeMock.Position(0, 1)),
      )
      expect(ext.__getPlayheadActiveRangeCountForTest()).toBe(1)

      effects.clearEngineState()

      expect(ext.__getEngineProcessForTest()).toBeNull()
      expect(ext.__getPlayheadActiveRangeCountForTest()).toBe(1)

      // --- clearAllPlayheads in isolation: clears the playhead range, leaves
      // engineProcess untouched ---
      ext.__setEngineProcessForTest(proc)

      effects.clearAllPlayheads()

      expect(ext.__getPlayheadActiveRangeCountForTest()).toBe(0)
      expect(ext.__getEngineProcessForTest()).toBe(proc)
    })

    it('wires logExit: the output channel receives the real exit code, verbatim', () => {
      const { proc, fireExit } = fakeChildProcess()
      const appendedLines: string[] = []
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({
        appendLine: (value: string) => {
          appendedLines.push(value)
        },
        append: () => {},
      })
      ext.__setEngineViewProviderForTest({ refresh: () => {} })

      ext.setupExitHandler(proc)
      fireExit(137)

      expect(appendedLines.some((line) => line.includes('exited with code 137'))).toBe(true)
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

    // #527 review round 4 Important #1: same containment requirement as
    // setupStdoutHandler above. `showStoppedStatus` reaches
    // `statusBarItem!.text = ...` unconditionally for a current process, so a
    // null `statusBarItem` throws a real exception from inside the listener
    // body, which the wrapping try/catch must contain.
    it('contains an exception thrown inside the listener body instead of letting it escape (#527 review round 4 Important #1)', () => {
      const { proc, fireExit } = fakeChildProcess()
      const appendedLines: string[] = []
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest(null) // showStoppedStatus's statusBarItem!.text throws on null
      ext.__setOutputChannelForTest({
        appendLine: (value: string) => {
          appendedLines.push(value)
        },
        append: () => {},
      })
      ext.__setEngineViewProviderForTest({ refresh: () => {} })

      ext.setupExitHandler(proc)

      expect(() => fireExit(0)).not.toThrow()

      // clearEngineState still ran before the fault (proves this isn't a
      // blanket "nothing happened" swallow — it's a real caught exception
      // mid-effects, and the effects that ran before the fault took hold).
      expect(ext.__getEngineProcessForTest()).toBeNull()

      const marker = appendedLines.find((line) => line.includes('setupExitHandler'))
      expect(marker, appendedLines.join('\n')).toBeDefined()
      expect(marker).toContain('🛑 internal error in setupExitHandler')
      expect(appendedLines.some((line) => line.includes('at '))).toBe(true)
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

    it('wires logStdinError: the output channel receives the real error message, verbatim', () => {
      const { proc, fireStdinError } = fakeChildProcess()
      const appendedLines: string[] = []
      ext.__setEngineProcessForTest(proc)
      ext.__setOutputChannelForTest({
        appendLine: (value: string) => {
          appendedLines.push(value)
        },
        append: () => {},
      })

      ext.setupStdinErrorHandler(proc)
      fireStdinError(new Error('boom'))

      expect(appendedLines.some((line) => line.includes('engine stdin error: boom'))).toBe(true)
    })

    // #527 review round 4 Important #1: same containment requirement as the
    // other two handlers. This listener body has no `statusBarItem` access to
    // exploit for a "natural" fault, so the real singleton
    // `DeviceSwitchBridge.drainAll` (reached via `applyEngineStdinError`'s
    // `drainDeviceBridge` effect) is monkey-patched to throw for this one
    // test only, and restored afterward so no other spec in this file (which
    // shares the same module-level bridge instance) is affected.
    it('contains an exception thrown inside the listener body instead of letting it escape (#527 review round 4 Important #1)', () => {
      const { proc, fireStdinError } = fakeChildProcess()
      const appendedLines: string[] = []
      ext.__setEngineProcessForTest(proc)
      ext.__setOutputChannelForTest({
        appendLine: (value: string) => {
          appendedLines.push(value)
        },
        append: () => {},
      })

      const bridge = ext.__getDeviceSwitchBridgeForTest()
      const originalDrainAll = bridge.drainAll
      bridge.drainAll = () => {
        throw new Error('injected fault in drainDeviceBridge')
      }

      try {
        ext.setupStdinErrorHandler(proc)
        expect(() => fireStdinError(new Error('EPIPE'))).not.toThrow()
      } finally {
        bridge.drainAll = originalDrainAll
      }

      // logStdinError still ran before the fault (the effect preceding
      // drainDeviceBridge in applyEngineStdinError), proving this is a real
      // caught mid-effects exception, not a blanket swallow.
      expect(appendedLines.some((line) => line.includes('engine stdin error: EPIPE'))).toBe(true)

      const marker = appendedLines.find((line) => line.includes('setupStdinErrorHandler'))
      expect(marker, appendedLines.join('\n')).toBeDefined()
      expect(marker).toContain('🛑 internal error in setupStdinErrorHandler')
      expect(appendedLines.some((line) => line.includes('at '))).toBe(true)
    })
  })

  describe('setupErrorHandler (#533)', () => {
    it('wires showStoppedStatus and refreshEngineView to the correct effect, in the declared order', () => {
      // Same rationale as the equivalent setupExitHandler test above: both
      // callbacks are unconditionally invoked once for a current-process
      // error, so recording the ORDER the two distinct side effects fire in
      // is what catches a same-signature body swap.
      const { proc, fireError } = fakeChildProcess()
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

      ext.setupErrorHandler(proc)
      fireError(new Error('spawn node ENOENT'))

      expect(statusText).toBe('🎵 OrbitScore: Stopped')
      expect(statusTooltip).toBe('Click to start engine')
      expect(calls).toEqual(['status-stopped', 'refresh'])
    })

    it('wires clearEngineState to null the current engineProcess handle', () => {
      const { proc, fireError } = fakeChildProcess()
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setEngineViewProviderForTest({ refresh: () => {} })

      ext.setupErrorHandler(proc)
      fireError(new Error('spawn node ENOENT'))

      expect(ext.__getEngineProcessForTest()).toBeNull()
    })

    it('wires logError: the output channel receives the real error message, verbatim', () => {
      const { proc, fireError } = fakeChildProcess()
      const appendedLines: string[] = []
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({
        appendLine: (value: string) => {
          appendedLines.push(value)
        },
        append: () => {},
      })
      ext.__setEngineViewProviderForTest({ refresh: () => {} })

      ext.setupErrorHandler(proc)
      fireError(new Error('spawn node ENOENT'))

      expect(appendedLines.some((line) => line.includes('spawn node ENOENT'))).toBe(true)
    })

    it('wires drainDeviceBridge: a pending selectAudioDevice request resolves with the error reason', async () => {
      const { proc, fireError } = fakeChildProcess()
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setEngineViewProviderForTest({ refresh: () => {} })

      const bridge = ext.__getDeviceSwitchBridgeForTest()
      const resultPromise = bridge.send(() => true, 'device-name', 200)

      ext.setupErrorHandler(proc)
      fireError(new Error('spawn node ENOENT'))

      const result = await resultPromise
      expect(result.ok).toBe(false)
      expect(result.error).toBe('engine process error: spawn node ENOENT')
    })

    it('skips every current-process-only effect for a stale process (identity guard still wired end-to-end)', () => {
      const { proc, fireError } = fakeChildProcess()
      const otherProc = fakeChildProcess().proc
      const statusBarItem = { text: 'untouched', tooltip: 'untouched' }
      let refreshCalls = 0
      // engineProcess points at a DIFFERENT process than the one whose
      // 'error' fires below.
      ext.__setEngineProcessForTest(otherProc)
      ext.__setStatusBarItemForTest(statusBarItem)
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setEngineViewProviderForTest({
        refresh: () => {
          refreshCalls += 1
        },
      })

      ext.setupErrorHandler(proc)
      fireError(new Error('spawn node ENOENT'))

      expect(statusBarItem.text).toBe('untouched')
      expect(refreshCalls).toBe(0)
    })

    it('contains an exception thrown inside the listener body instead of letting it escape', () => {
      const { proc, fireError } = fakeChildProcess()
      const appendedLines: string[] = []
      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest(null) // showStoppedStatus's statusBarItem!.text throws on null
      ext.__setOutputChannelForTest({
        appendLine: (value: string) => {
          appendedLines.push(value)
        },
        append: () => {},
      })
      ext.__setEngineViewProviderForTest({ refresh: () => {} })

      ext.setupErrorHandler(proc)

      expect(() => fireError(new Error('spawn node ENOENT'))).not.toThrow()

      // clearEngineState still ran before the fault (proves this isn't a
      // blanket "nothing happened" swallow).
      expect(ext.__getEngineProcessForTest()).toBeNull()

      const marker = appendedLines.find((line) => line.includes('setupErrorHandler'))
      expect(marker, appendedLines.join('\n')).toBeDefined()
      expect(marker).toContain('🛑 internal error in setupErrorHandler')
      expect(appendedLines.some((line) => line.includes('at '))).toBe(true)
    })
  })

  describe('stopEngine SIGKILL escalation (#532)', () => {
    // `proc.killed` means "a signal was successfully SENT to the process",
    // NOT "the process has exited" — `node_modules/@types/node/child_process
    // .d.ts` documents this explicitly. `proc.kill('SIGTERM')` flips
    // `killed` to `true` the instant the signal is delivered, so the old
    // `!proc.killed` escalation check was always false and SIGKILL never
    // fired. This fake mimics that real Node quirk: `kill()` flips `killed`
    // immediately, independent of `exitCode`/`signalCode`, which a test
    // controls separately to simulate whether the process actually exited.
    function fakeStoppableProcess(): {
      proc: ChildProcess
      killCalls: string[]
      setExited: (code: number) => void
    } {
      const killCalls: string[] = []
      const state = {
        killed: false,
        exitCode: null as number | null,
        signalCode: null as string | null,
      }
      const proc = {
        get killed() {
          return state.killed
        },
        get exitCode() {
          return state.exitCode
        },
        get signalCode() {
          return state.signalCode
        },
        kill: vi.fn((signal?: string) => {
          killCalls.push(String(signal))
          state.killed = true
          return true
        }),
      }
      return {
        proc: proc as unknown as ChildProcess,
        killCalls,
        setExited: (code) => {
          state.exitCode = code
        },
      }
    }

    it('escalates to SIGKILL after 2s when the process ignores SIGTERM', () => {
      vi.useFakeTimers()
      try {
        const { proc, killCalls } = fakeStoppableProcess()
        ext.__setEngineProcessForTest(proc)
        ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
        ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
        ext.__setEngineViewProviderForTest({ refresh: () => {} })

        expect(ext.stopEngine()).toBe(true)
        expect(killCalls).toEqual(['SIGTERM'])

        vi.advanceTimersByTime(2000)

        expect(killCalls).toEqual(['SIGTERM', 'SIGKILL'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not send a redundant SIGKILL once the process has actually exited', () => {
      vi.useFakeTimers()
      try {
        const { proc, killCalls, setExited } = fakeStoppableProcess()
        ext.__setEngineProcessForTest(proc)
        ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
        ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
        ext.__setEngineViewProviderForTest({ refresh: () => {} })

        expect(ext.stopEngine()).toBe(true)
        expect(killCalls).toEqual(['SIGTERM'])

        // The process actually terminates in response to SIGTERM before the
        // 2s escalation timer fires.
        setExited(0)
        vi.advanceTimersByTime(2000)

        expect(killCalls).toEqual(['SIGTERM'])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('sanity: DeviceSwitchBridge is the real vscode-free class (bridge assertions above are not vacuous)', () => {
    expect(ext.__getDeviceSwitchBridgeForTest()).toBeInstanceOf(DeviceSwitchBridge)
  })
})
