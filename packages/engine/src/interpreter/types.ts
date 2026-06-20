/**
 * Type definitions for Interpreter V2
 */

import { Global } from '../core/global'
import { Sequence } from '../core/sequence'
import { AudioEngineBackend } from '../audio/engine-backend'
import { SessionLogWriter } from '../core/session-log/session-log-writer'

/**
 * Interpreter state containing globals and sequences
 */
export interface InterpreterState {
  globals: Map<string, Global>
  sequences: Map<string, Sequence>
  currentGlobal?: Global
  audioEngine: AudioEngineBackend
  isBooted: boolean

  // Unidirectional toggle groups (DSL v3.0)
  runGroup: Set<string> // Sequences in RUN playback
  loopGroup: Set<string> // Sequences in LOOP playback
  muteGroup: Set<string> // Sequences with MUTE flag ON (persistent)

  // §L1 (#229) session log — present ONLY when explicitly enabled at a real
  // entry point (CLI / REPL). Absent in unit-test paths, so logging is inert.
  sessionLog?: SessionLogWriter
  engineT0: number // epoch ms at interpreter construction = rolling-buffer origin (§3 wall)
  // The .orbs the current eval came from — read by the transport-hook closures
  // when start()/stop() fire synchronously within that eval (§3 sourceFile / §2 naming).
  currentSourceFile?: string | null
}

/**
 * Options for interpreter initialization
 */
export interface InterpreterOptions {
  audioDevice?: string
}
