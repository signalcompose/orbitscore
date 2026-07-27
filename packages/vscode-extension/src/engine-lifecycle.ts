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

/** Transport state driving the status-bar label — see `transportStatusText`. */
export type TransportState = 'playing' | 'ready'

/**
 * Render the status-bar label for a transport state via an EXHAUSTIVE SWITCH,
 * not a ternary (#527 review Important #2).
 *
 * Every caller today passes a literal `'playing'` or `'ready'`, so the type
 * checker already rules out anything else — but `setTransportStatus` exists
 * specifically so a future IPC/JSON/loosely-typed boundary (a wire protocol,
 * a deserialized message) can drive it, and at THAT boundary the compile-time
 * guarantee is gone. A ternary silently folds any unrecognized value into the
 * 'ready' branch: no log, no error, just a status bar that says "Ready" while
 * the engine is actually playing. The `default` branch below assigns `state`
 * to a `never`-typed variable — TypeScript only accepts this if the two
 * `case`s above are truly exhaustive over the declared union, so adding a
 * third `TransportState` member without a matching `case` here is a compile
 * error, and a value that reaches `default` at runtime only despite that
 * (i.e. it arrived via a type-unsafe boundary) throws instead of silently
 * falling through.
 */
export function transportStatusText(state: TransportState, debugMode: boolean): string {
  switch (state) {
    case 'playing':
      return debugMode ? '🎵 OrbitScore: ▶️ Playing 🐛' : '🎵 OrbitScore: ▶️ Playing'
    case 'ready':
      return debugMode ? '🎵 OrbitScore: Ready 🐛' : '🎵 OrbitScore: Ready'
    default: {
      const _exhaustive: never = state
      throw new Error(`Unhandled transport state: ${String(_exhaustive)}`)
    }
  }
}

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
  setTransportStatus(state: TransportState): void
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

export interface EngineErrorEffects extends Omit<EngineExitEffects, 'logExit'> {
  /** Called unconditionally, matching `EngineExitEffects.logExit` / `EngineStdinErrorEffects.logStdinError`. */
  logError(err: Error): void
}

/**
 * Apply a Node `ChildProcess` `'error'` event (e.g. `ENOENT`/`EMFILE`/`EAGAIN`
 * on spawn failure) the same way `applyEngineExit` handles `'exit'`: log
 * unconditionally, mutate shared state only when the process is still
 * current.
 *
 * #533: `ChildProcess` is an `EventEmitter`, and by that contract an
 * `'error'` event with no registered listener is thrown as an uncaught
 * exception — independent of, and prior to, this project's own
 * exception-containment convention for the other four handler bodies (that
 * convention only helps once a listener already exists to catch inside).
 * Node's docs also note `'exit'` may never fire for the same spawn failure
 * that emits `'error'`, so without an identity-guarded handler here,
 * `engineProcess` stays non-null with `killed === false` forever:
 * `isEngineRunning()` keeps reporting `true`, and `get_engine_state` /
 * `start_engine` diverge from reality — the mirror image of #528 (there,
 * `applyEngineExit` lacked the identity guard; here, nothing observes the
 * failure at all). Only run the current-process-only effects that mutate
 * shared state; the error is still logged either way.
 */
export function applyEngineError(
  err: Error,
  isCurrent: boolean,
  effects: EngineErrorEffects,
): void {
  effects.logError(err)
  if (!isCurrent) return
  effects.clearEngineState()
  effects.clearAllPlayheads()
  effects.drainDeviceBridge(`engine process error: ${err.message}`)
  effects.showStoppedStatus()
  effects.refreshEngineView()
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
