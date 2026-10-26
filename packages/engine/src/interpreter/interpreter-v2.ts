/**
 * Interpreter V2 for OrbitScore Audio DSL
 * Object-oriented implementation with proper class instantiation
 *
 * @deprecated This class is now a thin wrapper around the interpreter modules.
 * For new code, consider using the modules directly from './interpreter/'.
 */

import * as path from 'path'

import type { AudioIR, ParsedRequest } from '../parser/audio-parser'
import { createAudioEngine } from '../audio/create-audio-engine'
import { AudioEngineBackend } from '../audio/engine-backend'
import { Global } from '../core/global'
import {
  SessionLogWriter,
  EvalSource,
  formatLogStamp,
} from '../core/session-log/session-log-writer'
import { ENGINE_VERSION, DSL_VERSION } from '../version'
import { createMixerRuntimeRegistry } from '../signal-chain/runtime'
import type { SavedProjectPluginState } from '../core/project-state-store'
import type { PluginUiOperationResult } from '../core/global'

import { InterpreterState } from './types'
import { processGlobalInit, processSequenceInit } from './process-initialization'
import { processStatement } from './process-statement'
import { createImportContext, processFileImports } from './process-file-import'

/**
 * Interpreter V2 - Object-oriented approach
 *
 * This class serves as a backward compatibility wrapper around the new
 * interpreter modules. For new code, consider using the modules directly.
 */
export class InterpreterV2 {
  private state: InterpreterState
  /** §L1: guards installing the Global transport hooks exactly once per session. */
  private sessionHooksInstalled = false

  /**
   * @param opts.audioEngine テスト/検証用に音声バックエンドを注入する（既定は
   *   `createAudioEngine()`）。未指定時は唯一のバックエンドである Rust daemon を使う
   *   （cutover #108 で既定化・#502 で他の選択肢を撤去）。#311 の schedule 抽出ハーネスが
   *   recording scheduler を差し込み、daemon を立てずに `.orbs` を実行して interpreter の
   *   計算スケジュールを取り出すために使う。
   */
  constructor(opts?: { audioEngine?: AudioEngineBackend }) {
    this.state = {
      audioEngine: opts?.audioEngine ?? createAudioEngine(),
      globals: new Map(),
      sequences: new Map(),
      mixers: createMixerRuntimeRegistry(),
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
  enableSessionLog(opts: { cwd: string; engineVersion?: string; dslVersion?: string }): void {
    if (this.state.sessionLog) return // idempotent — keep the existing rolling buffer
    this.state.sessionLog = new SessionLogWriter(
      {
        engineVersion: opts.engineVersion ?? ENGINE_VERSION,
        dslVersion: opts.dslVersion ?? DSL_VERSION,
      },
      opts.cwd,
    )
  }

  /** §L1 / §3 wall: ms since the rolling-buffer origin (interpreter construction). */
  private wallMs(): number {
    return Date.now() - this.state.engineT0
  }

  /**
   * §L1: wire the global's transport start/stop to the session log. Closures
   * read live `state.currentSourceFile` so a start/stop logs against the eval
   * that triggered it (start/stop fire synchronously within that eval).
   */
  private installSessionHooks(global: Global): void {
    global.setTransportHooks({
      onStart: () => {
        const now = new Date()
        this.state.sessionLog!.start({
          startedAtISO: now.toISOString(),
          stamp: formatLogStamp(now),
          wall: this.wallMs(),
          sourceFile: this.state.currentSourceFile ?? null,
        })
      },
      onStop: () => {
        this.state.sessionLog!.stop(this.wallMs(), global.getTransportPosition())
      },
    })
  }

  /**
   * Boot the audio engine (public method for explicit boot)
   */
  async boot(audioDevice?: string): Promise<void> {
    if (!this.state.isBooted) {
      await this.state.audioEngine.boot(audioDevice)
      this.state.isBooted = true
    }
  }

  /**
   * Boot the audio engine (ensure it's booted)
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
    // funnel every InterpreterV2.execute() caller passes through (CLI play / REPL;
    // midi-run.ts drives the interpreter modules directly and is not logged in v1).
    // `recordEval` buffers until global.start() (preamble) then appends; the
    // start/stop transport records are emitted by the Global transport hooks
    // (installSessionHooks). Guarded by `sessionLog` so the engine test suite
    // (which never enables it) is unaffected.
    this.state.currentSourceFile = options?.sourceFile ?? null
    // §3.1 v1: `effect` is stamped for LOOP launches only (other quantized
    // swaps are follow-up; replay re-quantizes regardless).
    this.recordEval(
      options,
      ir.statements.some((s) => s.type === 'transport' && s.command === 'loop'),
    )

    // Ensure the audio engine is booted
    await this.ensureBooted()

    // File imports (IM.2, #456): evaluated BEFORE the entry's own declarations, in
    // source order, depth-first. The cache/cycle context lives for this eval only.
    if (ir.fileImports?.length) {
      const baseDir = options?.sourceFile
        ? path.dirname(path.resolve(options.sourceFile))
        : options?.documentDirectory
      if (!baseDir) {
        throw new Error(
          'import: cannot resolve the base directory — no source file or document directory (IM.6).',
        )
      }
      const ctx = createImportContext(options?.sourceFile)
      try {
        await processFileImports(ir.fileImports, baseDir, this.state, ctx)
      } finally {
        // 成功・失敗を問わず基準ディレクトリを entry 側（documentDirectory または
        // sourceFile のディレクトリ = baseDir）へ復元する。復元しないと entry 自身の
        // audio() が最後に評価した module のディレクトリ基準で解決される（IM.4 違反）し、
        // 失敗時は長寿命 interpreter（REPL/live）で次の評価まで基準が腐る。
        this.state.currentGlobal?.setDocumentDirectory(options?.documentDirectory ?? baseDir)
      }
    }

    // Process global initialization
    if (ir.globalInit) {
      await processGlobalInit(ir.globalInit, this.state)
    }

    // §L1: install the session-log transport hooks on the global ONCE, when it
    // first exists. The closures read live state.currentSourceFile at fire time,
    // so a start/stop in a later eval logs against that eval's context.
    // v1 (§3.1) assumes a SINGLE global per session — a second `init GLOBAL`
    // would not get hooked, so its transport would go unlogged (out of v1 scope).
    this.installSessionHooksOnce()

    // Set documentDirectory on global so audioPath() / audio() can resolve relative paths.
    // An explicit empty string clears a previous REPL base (#966 / IM.6).
    if (options?.documentDirectory !== undefined && this.state.currentGlobal) {
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
   * OrbitStudio の層 2 の評価の入口（spec「評価の単位」E-3〜E-6・#997 / #1022）: 範囲つきで読んだ文を
   * **ソースの順に 1 つずつ**実行する。`execute()` と違い、宣言を前へ寄せず、実行時エラーはその文だけを
   * 失敗にして残りを続ける（file import の失敗だけは残りを止める・E-5）。`.orbslog` の記録は 1 件。
   *
   * 基準ディレクトリは文ごとに設定し直す（凍結版の REPL が 1 行ごとの `execute()` でしていたのと同じ）。
   * `hooks.onStatement` は各文の実行の直前に、`hooks.onFailure` は文が失敗したその時に呼ぶ（層 2 が
   * 「いまどの文か」を知り、失敗を凍結版と同じ順でログへ出すため）。
   *
   * @returns 失敗した文（`index` は `request.entries` の添字）。空ならすべて成功
   */
  async executeStatements(
    request: ParsedRequest,
    options: {
      documentDirectory?: string
      source?: string
      sourceFile?: string | null
      evalSource?: EvalSource
    } = {},
    hooks: {
      onStatement?(index: number): void
      onFailure?(index: number, message: string): void
    } = {},
  ): Promise<Array<{ index: number; message: string }>> {
    const { entries } = request
    this.state.currentSourceFile = options.sourceFile ?? null
    this.recordEval(
      options,
      entries.some(
        (e) => e.kind === 'statement' && e.node.type === 'transport' && e.node.command === 'loop',
      ),
    )
    await this.ensureBooted()

    const failures: Array<{ index: number; message: string }> = []
    const fail = (index: number, error: unknown): typeof failures => {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ index, message })
      hooks.onFailure?.(index, message)
      return failures
    }
    const imports = entries.flatMap((entry, index) =>
      entry.kind === 'file_import' ? [{ node: entry.node, index }] : [],
    )
    if (imports.length > 0) {
      const baseDir = options.sourceFile
        ? path.dirname(path.resolve(options.sourceFile))
        : options.documentDirectory
      if (!baseDir) {
        return fail(
          imports[0]!.index,
          'import: cannot resolve the base directory — no source file or document directory (IM.6).',
        )
      }
      // import が 1 つでも失敗したら、その要求の残りは実行しない（E-5）。
      let current = imports[0]!.index
      try {
        const ctx = createImportContext(options.sourceFile)
        for (const { node, index } of imports) {
          current = index
          hooks.onStatement?.(index)
          await processFileImports([node], baseDir, this.state, ctx)
        }
      } catch (error) {
        return fail(current, error)
      } finally {
        // execute() と同じ: 成功・失敗を問わず基準を entry 側へ戻す（IM.4）。
        this.state.currentGlobal?.setDocumentDirectory(options.documentDirectory ?? baseDir)
      }
    }

    for (const [index, entry] of entries.entries()) {
      if (entry.kind === 'file_import') continue
      hooks.onStatement?.(index)
      try {
        if (options.documentDirectory !== undefined) {
          this.state.currentGlobal?.setDocumentDirectory(options.documentDirectory)
        }
        if (entry.kind === 'global_init') {
          await processGlobalInit(entry.node, this.state)
          this.installSessionHooksOnce()
          if (options.documentDirectory !== undefined) {
            this.state.currentGlobal?.setDocumentDirectory(options.documentDirectory)
          }
        } else if (entry.kind === 'seq_init') {
          await processSequenceInit(entry.node, this.state)
        } else {
          await processStatement(entry.node, this.state)
        }
      } catch (error) {
        fail(index, error)
      }
    }
    return failures
  }

  /** §L1 (#229): 評価を 1 件記録する（`execute()` / `executeStatements()` の共通）。 */
  private recordEval(
    options: { source?: string; evalSource?: EvalSource } | undefined,
    hasLoop: boolean,
  ): void {
    if (!this.state.sessionLog || options?.source === undefined) return
    const g = this.state.currentGlobal
    this.state.sessionLog.recordEval({
      code: options.source,
      wall: this.wallMs(),
      transport: g?.getTransportPosition() ?? null,
      effect: hasLoop ? (g?.getQuantizedEffectPosition() ?? null) : null,
      sourceFile: this.state.currentSourceFile ?? null,
      evalSource: options?.evalSource ?? 'human',
    })
  }

  /**
   * §L1: install the session-log transport hooks on the global ONCE, when it
   * first exists. v1 (§3.1) assumes a SINGLE global per session.
   */
  private installSessionHooksOnce(): void {
    if (this.state.sessionLog && this.state.currentGlobal && !this.sessionHooksInstalled) {
      this.installSessionHooks(this.state.currentGlobal)
      this.sessionHooksInstalled = true
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
  get audioEngine(): AudioEngineBackend {
    return this.state.audioEngine
  }

  /** All initialized globals, exposed for graceful shutdown safe-point handling. */
  getGlobals(): readonly Global[] {
    return [...this.state.globals.values()]
  }

  /** REPL/MCP bridgeから現在のchainを解決し、plugin stateとproject.yamlを明示保存する。 */
  async savePluginState(sequence: string, index: number): Promise<SavedProjectPluginState> {
    const global = this.state.currentGlobal
    if (!global) {
      throw new Error('Plugin state cannot be saved before a global has been initialized.')
    }
    return global.savePluginState(sequence, index)
  }

  async openPluginUi(
    receiver: string,
    index: number,
    expectedName?: string,
  ): Promise<PluginUiOperationResult> {
    const global = this.state.currentGlobal
    if (!global) throw new Error('Plugin UI cannot be opened before a global has been initialized.')
    return global.openPluginUi(receiver, index, expectedName)
  }

  async closePluginUi(receiver: string, index: number): Promise<PluginUiOperationResult> {
    const global = this.state.currentGlobal
    if (!global) throw new Error('Plugin UI cannot be closed before a global has been initialized.')
    return global.closePluginUi(receiver, index)
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
export function createInterpreter(opts?: { audioEngine?: AudioEngineBackend }): InterpreterV2 {
  return new InterpreterV2(opts)
}
