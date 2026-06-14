/**
 * Type definitions for Interpreter V2
 */

import { Global } from '../core/global'
import { Sequence } from '../core/sequence'
import { SuperColliderPlayer } from '../audio/supercollider-player'
import { SessionLogWriter, EvalSource } from '../core/session-log/session-log-writer'

/**
 * Interpreter state containing globals and sequences
 */
export interface InterpreterState {
  globals: Map<string, Global>
  sequences: Map<string, Sequence>
  currentGlobal?: Global
  audioEngine: SuperColliderPlayer
  isBooted: boolean

  // Unidirectional toggle groups (DSL v3.0)
  runGroup: Set<string> // Sequences in RUN playback
  loopGroup: Set<string> // Sequences in LOOP playback
  muteGroup: Set<string> // Sequences with MUTE flag ON (persistent)

  // §L1 (#229) session log — present ONLY when explicitly enabled at a real
  // entry point (CLI / REPL). Absent in unit-test paths, so logging is inert.
  sessionLog?: SessionLogWriter
  engineT0?: number // epoch ms at interpreter construction = rolling-buffer origin (§3 wall)
  currentSourceFile?: string | null // the .orbs the current eval came from (§3 sourceFile / §2 naming)
  currentEvalSource?: EvalSource // provenance of the current eval (§3 evalSource)
}

/**
 * Options for interpreter initialization
 */
export interface InterpreterOptions {
  audioDevice?: string
}
