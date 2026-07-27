/**
 * vscode-free engine lifecycle decisions and stdout/exit/stdin intent
 * application.
 *
 * `extension.ts` retains ownership of the process and UI state. This module
 * only classifies engine output/events and applies the resulting decisions
 * through injected callbacks, so stale-process guards are deterministic to
 * unit test.
 */

import { parseSelectAudioDeviceResultLine } from './engine-view'
import { parseStepLine, type StepEvent } from './playhead'

export interface EngineStdoutLineIntent {
  rawLine: string
  step: StepEvent | null
  stoppedSequence: string | null
  globalStopped: boolean
  selectAudioDeviceCandidate: boolean
}

export interface EngineStdoutEffects {
  handleStep(step: StepEvent): void
  clearSequence(seqName: string): void
  clearAllPlayheads(): void
  handleSelectAudioDeviceLine(rawLine: string): boolean
  warnMalformedSelectAudioDeviceLine(rawLine: string, stale: boolean): void
  transcribeLog(): void
  /** #527 review Critical #3: folded from separate setPlayingStatus()/setReadyStatus()
   * siblings — a same-signature `() => void` pair is exactly the shape a wiring mistake
   * (swapping which implementation lands in which slot) can't be caught by the type
   * checker. A single parameterized callback makes that mistake unrepresentable. */
  setTransportStatus(state: 'playing' | 'ready'): void
}

export type StartEngineDecision =
  | { kind: 'reject'; error: string }
  | { kind: 'already-running' }
  | { kind: 'spawn' }

/** Classify one raw stdout line without mutating extension or bridge state. */
export function classifyEngineStdoutLine(rawLine: string): EngineStdoutLineIntent {
  const step = parseStepLine(rawLine)
  return {
    rawLine,
    step,
    stoppedSequence: step ? null : (rawLine.match(/⏹\s+(\S+)/)?.[1] ?? null),
    globalStopped: !step && rawLine.includes('✅ Global stopped'),
    selectAudioDeviceCandidate: !step && rawLine.trim().startsWith('{"selectAudioDevice'),
  }
}

/**
 * Apply one stdout chunk while partitioning state mutations by process identity.
 * Log transcription and malformed-line diagnostics intentionally remain visible
 * for stale engines; playhead, bridge, and status mutations do not.
 *
 * #528: stdout arrives asynchronously, same as the `'exit'` event (see
 * `applyEngineExit`'s docstring). A fast stop_engine → start_engine sequence
 * can deliver a dead process's trailing buffer to this handler after a new
 * engine is already current. Log transcription may as well run unconditionally
 * (a stopped engine's final output is diagnostically useful even when stale),
 * but shared-state mutations — playhead, status bar, the //#selectAudioDevice
 * bridge's FIFO — must stay current-process-only, or stale output clears the
 * new engine's live playhead, rewinds the status bar, or FIFO-matches a stale
 * resolver against the new engine's response (failure direction opposite of
 * #501 review Critical #1, same root cause — module state not partitioned by
 * process identity).
 *
 * #527 review Important #1: whether a `//#selectAudioDevice` result line is
 * malformed is a property of the LINE (checked with the same pure
 * `parseSelectAudioDeviceResultLine` `DeviceSwitchBridge.handleLine` uses) —
 * it must not be conflated with whether this engine is current. The previous
 * shape short-circuited the parse attempt behind `isCurrent`, so a perfectly
 * well-formed result from a stale engine was reported as malformed on every
 * stop→start cycle, drowning out the one signal this diagnostic exists to
 * catch: a genuine chunk-boundary split.
 */
export function applyEngineStdoutChunk(
  output: string,
  lines: readonly string[],
  isCurrent: boolean,
  effects: EngineStdoutEffects,
): void {
  for (const rawLine of lines) {
    const intent = classifyEngineStdoutLine(rawLine)
    if (intent.selectAudioDeviceCandidate) {
      const parses = parseSelectAudioDeviceResultLine(rawLine) !== undefined
      // FIFO consumption is shared, cross-engine state — current only.
      if (isCurrent) effects.handleSelectAudioDeviceLine(rawLine)
      // Malformed-ness is a property of the line, independent of isCurrent.
      if (!parses) effects.warnMalformedSelectAudioDeviceLine(rawLine, !isCurrent)
    }
    if (!isCurrent) continue
    if (intent.step) {
      effects.handleStep(intent.step)
      continue
    }
    if (intent.stoppedSequence) effects.clearSequence(intent.stoppedSequence)
    if (intent.globalStopped) effects.clearAllPlayheads()
    // Mirrors the pre-refactor loop, which called
    // `selectAudioDeviceBridge.handleLine()` unconditionally on every
    // current-engine line (a no-op unless the line actually parses as a
    // bridge result) — split into this branch plus the one above so the
    // malformed-line diagnostic could escape the isCurrent guard (Important
    // #1 above) without changing which lines the bridge itself sees.
    if (!intent.selectAudioDeviceCandidate) effects.handleSelectAudioDeviceLine(rawLine)
  }

  effects.transcribeLog()

  if (!isCurrent) return
  if (output.includes('✅ Global running') || output.includes('▶ Global')) {
    effects.setTransportStatus('playing')
  } else if (output.includes('✅ Global stopped') || output.includes('⏹ Global')) {
    effects.setTransportStatus('ready')
  }
}

export interface EngineExitEffects {
  /** Called unconditionally — a stopped engine's final output is diagnostically useful even when stale. */
  logExit(code: number | null): void
  /** Nulls `engineProcess` and resets `isLiveCodingMode` / `globalInitialized` — current-process only. */
  clearEngineState(): void
  clearAllPlayheads(): void
  drainDeviceBridge(reason: string): void
  showStoppedStatus(): void
  refreshEngineView(): void
}

/**
 * Apply a Node `'exit'` event while partitioning state mutations by process
 * identity.
 *
 * #528: Node's `'exit'` event arrives asynchronously. A fast stop_engine →
 * start_engine sequence can already have spawned a new engine and stored it
 * in `engineProcess` *before* the old process's exit fires. Running the
 * cleanup below without checking identity would null out the live new
 * engine's handle, orphaning its daemon (UI shows "Stopped", stop_engine
 * can't reach it, evaluate goes silent). Only run the current-process-only
 * effects that mutate shared state; the exit is still logged either way.
 */
export function applyEngineExit(
  code: number | null,
  isCurrent: boolean,
  effects: EngineExitEffects,
): void {
  effects.logExit(code)
  if (!isCurrent) return
  effects.clearEngineState()
  effects.clearAllPlayheads() // #390: nothing is sounding anymore
  // #501 review Critical #1: drain any //#selectAudioDevice requests still
  // awaiting a response — otherwise a stale resolver could FIFO-match the
  // next engine instance's response.
  effects.drainDeviceBridge('engine process exited before responding to //#selectAudioDevice')
  effects.showStoppedStatus()
  effects.refreshEngineView()
}

export interface EngineStdinErrorEffects {
  /** Called unconditionally, matching `EngineExitEffects.logExit`. */
  logStdinError(message: string): void
  drainDeviceBridge(reason: string): void
}

/**
 * Apply a stdin `'error'` event (e.g. EPIPE) the same way `applyEngineExit`
 * handles `'exit'`: log unconditionally, mutate shared state only when the
 * process is still current.
 *
 * #501 review Important #2: an unhandled 'error' event on a stream crashes
 * the process, so stdin errors must be handled independently of 'exit'.
 *
 * #528: identity guard for the same reason as `applyEngineExit` — a fast
 * stop → start can produce an EPIPE on the dead engine's stdin *after* a new
 * engine has already been spawned. Draining unconditionally would discard
 * the *new* engine's pending //#selectAudioDevice response (the failure
 * direction is the opposite of #501 review Critical #1, but the root cause —
 * module state not partitioned by process identity — is the same).
 */
export function applyEngineStdinError(
  message: string,
  isCurrent: boolean,
  effects: EngineStdinErrorEffects,
): void {
  effects.logStdinError(message)
  if (!isCurrent) return
  effects.drainDeviceBridge(`engine stdin error: ${message}`)
}

/**
 * Decide whether an agent start request can reuse the current engine.
 * Capture and debug are spawn-only settings — `startEngine()` in `extension.ts`
 * only has a chance to pass `ORBIT_CAPTURE_WAV` (env) and `--debug` (CLI arg) to
 * the daemon at spawn time, so an already-running engine has no way to pick
 * either up retroactively — and must never be silently ignored.
 */
export function decideStartEngineForAgent(
  engineRunning: boolean,
  options?: { captureWav?: string; debug?: boolean },
): StartEngineDecision {
  if (!engineRunning) return { kind: 'spawn' }

  const spawnOnlyOptions = [
    options?.captureWav ? 'capture_wav' : null,
    options?.debug ? 'debug' : null,
  ].filter((option): option is string => option !== null)
  if (spawnOnlyOptions.length > 0) {
    return {
      kind: 'reject',
      error:
        `engine is already running; requested spawn-only option(s): ${spawnOnlyOptions.join(', ')}. ` +
        'The existing engine may already have different spawn settings. Call stop_engine first, ' +
        'then start_engine again with the requested option(s).',
    }
  }
  return { kind: 'already-running' }
}
