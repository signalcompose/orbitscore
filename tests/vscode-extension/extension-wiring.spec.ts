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
import * as ext from '../../packages/vscode-extension/src/extension'
// Resolves to the SAME module instance `extension.ts`'s `import * as vscode
// from 'vscode'` gets via the root vitest.config.ts alias — pushing into
// `vscodeMock.window.visibleTextEditors` is observed by extension.ts's own
// `vscode.window.visibleTextEditors` reads (round 3 Critical #1).
import * as vscodeMock from '../mocks/vscode'

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
    ext.__resetPlayheadStateForTest()
    vscodeMock.window.visibleTextEditors.length = 0
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

    // #527 review round 3 Critical #1: clearEngineState and clearAllPlayheads
    // are both unconditionally-invoked `() => void` effects with NO
    // interdependency, so swapping which real implementation lands under
    // which key produces an IDENTICAL final state (engineProcess still ends
    // up null, playhead ranges still end up cleared) — the test above and
    // "final state" assertions in general cannot see the swap. What DOES
    // differ under a swap is ORDER: applyEngineExit always calls the
    // `clearEngineState` key before the `clearAllPlayheads` key, so swapping
    // which real body sits behind each key swaps WHICH observable side
    // effect happens FIRST. This test seeds a playhead range against a fake
    // editor and, at the exact moment the real `clearAllPlayheadDecorations`
    // reaches `editor.setDecorations` (its own, independent observable
    // effect — round 3 Critical #1's second complaint, that it had no
    // assertion anywhere), snapshots whether `engineProcess` has ALREADY
    // been nulled. Correct wiring: yes (clearEngineState ran first). Swapped:
    // no (the null-out closure hasn't run yet, because it's now called
    // second).
    it('wires clearEngineState and clearAllPlayheads to the correct effect, in the declared order', () => {
      const { proc, fireExit } = fakeChildProcess()
      const docUriString = 'file:///order-test.orbs'
      const decorationCalls: Array<{ rangesLength: number; engineProcessWasNull: boolean }> = []
      const fakeEditor = {
        document: { uri: { toString: () => docUriString } },
        setDecorations: (_type: unknown, ranges: unknown[]) => {
          decorationCalls.push({
            rangesLength: ranges.length,
            engineProcessWasNull: ext.__getEngineProcessForTest() === null,
          })
        },
      }
      vscodeMock.window.visibleTextEditors.push(fakeEditor)

      ext.__setEngineProcessForTest(proc)
      ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
      ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
      ext.__setEngineViewProviderForTest({ refresh: () => {} })
      ext.__setPlayheadActiveRangeForTest(
        'seqOrder',
        docUriString,
        new vscodeMock.Range(new vscodeMock.Position(0, 0), new vscodeMock.Position(0, 1)),
      )
      expect(ext.__getPlayheadActiveRangeCountForTest()).toBe(1)

      ext.setupExitHandler(proc)
      fireExit(0)

      // Independent assertion on clearAllPlayheadDecorations's OWN effect:
      // it ran exactly once and actually cleared (empty ranges array), not
      // merely "some callback fired".
      expect(decorationCalls).toHaveLength(1)
      expect(decorationCalls[0].rangesLength).toBe(0)
      // Order assertion: this is what a clearEngineState/clearAllPlayheads
      // swap flips.
      expect(decorationCalls[0].engineProcessWasNull).toBe(true)
      expect(ext.__getEngineProcessForTest()).toBeNull()
      expect(ext.__getPlayheadActiveRangeCountForTest()).toBe(0)
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
  })

  it('sanity: DeviceSwitchBridge is the real vscode-free class (bridge assertions above are not vacuous)', () => {
    expect(ext.__getDeviceSwitchBridgeForTest()).toBeInstanceOf(DeviceSwitchBridge)
  })
})
