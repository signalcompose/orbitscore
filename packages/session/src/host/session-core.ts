/**
 * 層 2 の真実を持つもの（設計 848 §3 の「2 セッション」の行）: engine・評価の受付口・log ring・
 * transport の状態・クライアントの一覧。RPC サーバに渡すメソッドの実装もここに置く。
 *
 * このビルドが実装しているメソッド: `session.*`・`engine.*`・`audio.*`・`plugin.*`（`openUiAtCursor` を
 * 除く）・`docs.*`（後の 3 群は `layer2-methods.ts`）。残り（`editor.*`・`plugin.openUiAtCursor`）は
 * 束 S-editor が足す（台帳 P-19）。
 */
import crypto from 'node:crypto'

import type { AudioIR } from '@orbitscore/engine/dist/parser/audio-parser'

import {
  createEvaluationIntake,
  type EvaluationIntake,
  type IntakeContext,
  type IntakeExecuteOptions,
} from '../eval/evaluation-intake'
import { RpcError, PROTOCOL_VERSION } from '../rpc/protocol'
import type { AttachedClient, RequestHandler } from '../rpc/server'

import { captureConsole, parseStepLine, transportChange } from './console-capture'
import type { DocsSites } from './docs-sites'
import type { EngineHost, StartEngineParams } from './engine-host'
import { audioMethods, docsMethods, pluginMethods, type Layer2MethodDeps } from './layer2-methods'
import { registerMcp, type RegisterMcpDeps, type RegisterMcpParams } from './mcp-registration'
import { classifyEngineLine, classifySessionLine, type OutputStream } from './log-classify'
import { LogHub, type LogLineNotification } from './log-hub'

export interface EvaluateTarget {
  uri: string
  version?: number
  range?: { start: { line: number; character: number }; end: { line: number; character: number } }
}

export interface EvaluateParams {
  code: string
  documentDirectory: string | null
  source: 'human' | 'agent'
  target?: EvaluateTarget
  frame?: Record<string, string | number | boolean | null>
}

export interface SessionCoreOptions {
  engine: EngineHost
  workspaceRoot: string | null
  /** 通知をクライアントへ送る口（RPC サーバの `broadcast`）。 */
  broadcast(method: string, params: unknown): void
  /** クライアントの一覧（`session.getState` の `editorAttached` のため）。 */
  editorAttached(): boolean
  /** `session.shutdown` を受けた時（CLI が畳む経路へ回す）。 */
  onShutdownRequested?(): void
  /** console の横取り（テストでは false にして偽の console を渡す）。 */
  captureConsole?: boolean
  /** headless の CLI で、横取りした行を元の console にも書くか。 */
  consolePassthrough?: boolean
  stallReportMs?: number
  /** `--docs-dir` から決めた docs の在りか（既定は両方なし）。 */
  docs?: DocsSites
  /** `session.registerMcp` の外への手（`claude` CLI・ホーム）。テストで差し替える。 */
  registerMcp?: Omit<RegisterMcpDeps, 'workspaceRoot'>
}

/** 評価の帰属を覚えておく件数の上限（`evalId` → `target`）。 */
const TARGET_MEMORY = 256

export class SessionCore {
  readonly logs: LogHub
  private readonly intake: EvaluationIntake
  private readonly targets = new Map<string, EvaluateTarget>()
  private playing = false
  /** いま `execute()` の中にいる評価の帰属（console の行に `evalId` を付けるため）。 */
  private executing: IntakeContext | null = null
  private releaseConsole: (() => void) | null = null
  readonly handlers: Readonly<Record<string, RequestHandler>>

  constructor(private readonly options: SessionCoreOptions) {
    this.logs = new LogHub(
      (line: LogLineNotification) => options.broadcast('log.line', line),
      () => options.engine.debug,
    )
    this.intake = createEvaluationIntake({
      execute: (ir: AudioIR, executeOptions: IntakeExecuteOptions, context: IntakeContext) =>
        this.execute(ir, executeOptions, context),
      log: (line, context) =>
        this.logs.emit(classifySessionLine(line.kind, line.level, line.text), context),
      stallReportMs: options.stallReportMs,
    })
    if (options.captureConsole !== false) {
      this.releaseConsole = captureConsole((stream, text) => this.onEngineLine(stream, text), {
        passthrough: options.consolePassthrough,
      })
    }
    const startEngine = async (params: StartEngineParams) => {
      const result = await options.engine.start(params)
      if (result.ok) await this.broadcastEngineState()
      return result
    }
    const stopEngine = async () => {
      const result = await options.engine.stop()
      if (this.playing) {
        this.playing = false
        options.broadcast('transport.state', { playing: false })
      }
      await this.broadcastEngineState()
      return result
    }
    const layer2: Layer2MethodDeps = {
      engine: options.engine,
      startEngine,
      stopEngine,
      transportPlaying: () => this.playing,
      docs: options.docs ?? { user: null, dev: null },
      log: (level, text) => this.sessionLog(level, text),
    }
    this.handlers = {
      'session.evaluate': (params: EvaluateParams, client: AttachedClient) =>
        this.evaluate(params, client),
      'session.getState': () => this.getState(),
      'session.getLog': (params: { lines?: number }) => ({ lines: this.logs.select(params.lines) }),
      'session.shutdown': () => {
        options.onShutdownRequested?.()
        return {}
      },
      'session.registerMcp': (params: RegisterMcpParams) =>
        registerMcp(params, { workspaceRoot: options.workspaceRoot, ...options.registerMcp }),
      'engine.start': startEngine,
      'engine.stop': stopEngine,
      'engine.getState': () => options.engine.getState(),
      ...audioMethods(layer2),
      ...pluginMethods(layer2),
      ...docsMethods(layer2),
    }
  }

  /** console の横取りを外す（shutdown・テスト）。 */
  dispose(): void {
    this.releaseConsole?.()
    this.releaseConsole = null
  }

  /** 層 2 自身の行（RPC サーバの拒否の理由など）。 */
  sessionLog(level: 'error' | 'warn' | 'info', text: string): void {
    this.logs.emit(classifySessionLine('session', level, text))
  }

  /** engine が console に書いた 1 行（P-07 の横取り・テストからも直接呼ぶ）。 */
  onEngineLine(stream: OutputStream, text: string): void {
    const step = stream === 'stdout' ? parseStepLine(text) : null
    if (step) {
      this.logs.recordStep(text)
      this.options.broadcast('transport.step', { ...step, source: null })
      return
    }
    const change = stream === 'stdout' ? transportChange(text) : null
    if (change && (change === 'playing') !== this.playing) {
      this.playing = change === 'playing'
      this.options.broadcast('transport.state', { playing: this.playing })
    }
    this.logs.emit(classifyEngineLine(stream, text), this.executing ?? {})
  }

  /** 帰属を覚えた評価の `target`（`.orbslog` の `sourceFile` への写しは設計 §5.3.1 (a)）。 */
  targetOf(evalId: string): EvaluateTarget | undefined {
    return this.targets.get(evalId)
  }

  async evaluate(params: EvaluateParams, client: AttachedClient) {
    if (!this.options.engine.running) {
      throw new RpcError('ENGINE_NOT_RUNNING', 'engine is not running — start the engine first')
    }
    const evalId = crypto.randomBytes(9).toString('base64url')
    if (params.target) this.remember(evalId, params.target)
    const outcome = await this.intake.evaluate(
      { code: params.code, documentDirectory: params.documentDirectory, source: params.source },
      { evalId, clientId: client.clientId },
    )
    return {
      ok: outcome.ok,
      evalId,
      diagnostics: outcome.diagnostics,
      documentDirectory: outcome.documentDirectory,
    }
  }

  async getState() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      engine: await this.options.engine.getState(),
      transport: { playing: this.playing },
      // 文書の同期は束 S-editor（`editor.did*`）。それまでは空。
      documents: [],
      activeUri: null,
      workspaceRoot: this.options.workspaceRoot,
      editorAttached: this.options.editorAttached(),
    }
  }

  /** キューが空になるまで待つ（shutdown の前・テスト）。 */
  idle(): Promise<void> {
    return this.intake.idle()
  }

  private async execute(
    ir: AudioIR,
    options: IntakeExecuteOptions,
    context: IntakeContext,
  ): Promise<void> {
    const interpreter = this.options.engine.current()
    if (!interpreter) throw new Error('engine is not running — start the engine first')
    this.executing = context
    try {
      await interpreter.execute(ir, options)
    } finally {
      this.executing = null
    }
  }

  private remember(evalId: string, target: EvaluateTarget): void {
    this.targets.set(evalId, target)
    if (this.targets.size > TARGET_MEMORY) {
      const oldest = this.targets.keys().next().value
      if (oldest !== undefined) this.targets.delete(oldest)
    }
  }

  private async broadcastEngineState(): Promise<void> {
    this.options.broadcast('engine.state', await this.options.engine.getState())
  }
}
