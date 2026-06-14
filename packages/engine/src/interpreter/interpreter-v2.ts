/**
 * Interpreter V2 for OrbitScore Audio DSL
 * Object-oriented implementation with proper class instantiation
 *
 * @deprecated This class is now a thin wrapper around the interpreter modules.
 * For new code, consider using the modules directly from './interpreter/'.
 */

import { AudioIR } from '../parser/audio-parser'
import { SuperColliderPlayer } from '../audio/supercollider-player'
import { Global } from '../core/global'
import {
  SessionLogWriter,
  EvalSource,
  formatLogStamp,
} from '../core/session-log/session-log-writer'

import { InterpreterState } from './types'
import { processGlobalInit, processSequenceInit } from './process-initialization'
import { processStatement } from './process-statement'

/**
 * Interpreter V2 - Object-oriented approach
 *
 * This class serves as a backward compatibility wrapper around the new
 * interpreter modules. For new code, consider using the modules directly.
 */
export class InterpreterV2 {
  private state: InterpreterState

  constructor() {
    this.state = {
      audioEngine: new SuperColliderPlayer(),
      globals: new Map(),
      sequences: new Map(),
      currentGlobal: undefined,
      isBooted: false,
      // Initialize unidirectional toggle groups
      runGroup: new Set(),
      loopGroup: new Set(),
      muteGroup: new Set(),
      // §L1: the rolling-buffer origin (§3 wall). The writer itself stays absent
      // until enableSessionLog() — so logging is inert in unit-test paths.
      engineT0: Date.now(),
    }
  }

  /**
   * §L1 (#229): install a session-log writer (opt-in — call ONLY at a real entry
   * point: CLI / REPL). Until called, `global.start()` writes no `.orbslog`, so
   * the engine's own test suite stays file-free. `cwd` is the untitled-fallback
   * directory; `engineVersion`/`dslVersion` go in the meta header.
   */
  enableSessionLog(opts: { engineVersion: string; dslVersion: string; cwd: string }): void {
    if (this.state.sessionLog) return // idempotent — keep the existing rolling buffer
    this.state.sessionLog = new SessionLogWriter(
      { engineVersion: opts.engineVersion, dslVersion: opts.dslVersion },
      opts.cwd,
    )
  }

  /**
   * §L1: wire the global's transport start/stop to the session log. Closures
   * read live `state` (sourceFile / engineT0) so each start/stop logs against
   * the context of the eval that triggered it.
   */
  private installSessionHooks(global: Global): void {
    const state = this.state
    global.setTransportHooks({
      onStart: () => {
        const now = new Date()
        state.sessionLog!.start({
          startedAtISO: now.toISOString(),
          stamp: formatLogStamp(now),
          wall: Date.now() - (state.engineT0 ?? Date.now()),
          sourceFile: state.currentSourceFile ?? null,
        })
      },
      onStop: () => {
        state.sessionLog!.stop(
          Date.now() - (state.engineT0 ?? Date.now()),
          global.getTransportPosition(),
        )
      },
    })
  }

  /**
   * Boot SuperCollider server (public method for explicit boot)
   */
  async boot(audioDevice?: string): Promise<void> {
    if (!this.state.isBooted) {
      await this.state.audioEngine.boot(audioDevice)
      this.state.isBooted = true
    }
  }

  /**
   * Boot SuperCollider server (ensure it's booted)
   */
  private async ensureBooted(): Promise<void> {
    await this.boot()
  }

  /**
   * Execute parsed IR
   * @param ir - Parsed intermediate representation
   * @param options - Execution options
   * @param options.skipTransportCommands - If true, skip RUN/LOOP/MUTE commands (used on file save)
   */
  async execute(
    ir: AudioIR,
    options?: {
      skipTransportCommands?: boolean
      documentDirectory?: string
      /** §L1: the verbatim evaluated source (the `code` field). */
      source?: string
      /** §L1: the originating `.orbs` (drives `sourceFile` + filename). */
      sourceFile?: string | null
      /** §L1: who evaluated this (default `human`). */
      evalSource?: EvalSource
    },
  ): Promise<void> {
    const skipTransport = options?.skipTransportCommands ?? false

    // §L1 (#229): record this eval at occurrence. The interceptor is HERE — the
    // single funnel every eval path passes through. `recordEval` buffers until
    // global.start() (preamble) then appends; the start/stop transport records
    // are emitted by the Global transport hooks (installSessionHooks). Guarded by
    // `sessionLog` so the engine test suite (which never enables it) is unaffected.
    this.state.currentSourceFile = options?.sourceFile ?? null
    this.state.currentEvalSource = options?.evalSource ?? 'human'
    if (this.state.sessionLog && options?.source !== undefined) {
      const g = this.state.currentGlobal
      const hasLoop = ir.statements.some((s) => s.type === 'transport' && s.command === 'loop')
      this.state.sessionLog.recordEval({
        code: options.source,
        wall: Date.now() - (this.state.engineT0 ?? Date.now()),
        transport: g?.getTransportPosition() ?? null,
        effect: hasLoop ? (g?.getQuantizedEffectPosition() ?? null) : null,
        sourceFile: this.state.currentSourceFile,
        evalSource: this.state.currentEvalSource,
      })
    }

    // Ensure SuperCollider is booted
    await this.ensureBooted()

    // Process global initialization
    if (ir.globalInit) {
      await processGlobalInit(ir.globalInit, this.state)
    }

    // §L1: install the session-log transport hooks on the global once it exists.
    // The closures read live state (sourceFile / engineT0) at fire time, so a
    // start/stop in a later eval logs against that eval's context. Idempotent.
    if (this.state.sessionLog && this.state.currentGlobal) {
      this.installSessionHooks(this.state.currentGlobal)
    }

    // Set documentDirectory on global so audioPath() / audio() can resolve relative paths
    if (options?.documentDirectory && this.state.currentGlobal) {
      this.state.currentGlobal.setDocumentDirectory(options.documentDirectory)
    }

    // Process sequence initializations
    for (const seqInit of ir.sequenceInits) {
      await processSequenceInit(seqInit, this.state)
    }

    // Process statements
    for (const statement of ir.statements) {
      // Skip transport commands if requested (e.g., on file save)
      if (skipTransport && statement.type === 'transport') {
        continue
      }
      await processStatement(statement, this.state)
    }
  }

  /**
   * Get state for testing/debugging
   */
  getState() {
    const state: any = {
      globals: {},
      sequences: {},
    }

    // Convert Map to plain object for easier inspection
    for (const [name, global] of this.state.globals.entries()) {
      state.globals[name] = global.getState()
    }

    for (const [name, sequence] of this.state.sequences.entries()) {
      state.sequences[name] = sequence.getState()
    }

    return state
  }

  /**
   * Get audio engine for testing/debugging
   * @deprecated Direct access to audioEngine. Use getState() instead.
   */
  get audioEngine(): SuperColliderPlayer {
    return this.state.audioEngine
  }
}

/**
 * Factory function to create a new interpreter instance
 *
 * @returns New InterpreterV2 instance
 *
 * @example
 * ```typescript
 * const interpreter = createInterpreter()
 * await interpreter.boot()
 * await interpreter.execute(ir)
 * ```
 */
export function createInterpreter(): InterpreterV2 {
  return new InterpreterV2()
}
