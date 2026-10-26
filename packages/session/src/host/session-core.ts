/**
 * 層 2 の真実を持つもの（設計 848 §3 の「2 セッション」の行）: engine・評価の受付口・log ring・
 * transport の状態・クライアントの一覧。RPC サーバに渡すメソッドの実装もここに置く。
 *
 * このビルドが実装しているメソッド: `session.*`・`engine.*`・`audio.*`・`plugin.*`（`openUiAtCursor` を
 * 除く）・`docs.*`（後の 3 群は `layer2-methods.ts`）・`editor.did*` と `editor.getState` /
 * `getDocumentText`（同期済みの写しから）。残り（`editor.complete` / `getDiagnostics` と逆方向の
 * `editor.*`・`plugin.openUiAtCursor`）は束 S-editor の後続の小 PR が足す（台帳 P-19）。
 */
import crypto from 'node:crypto'

import type { AudioIR } from '@orbitscore/engine/dist/parser/audio-parser'

import {
  createEvaluationIntake,
  type EvaluationIntake,
  type IntakeContext,
  type IntakeExecuteOptions,
} from '../eval/evaluation-intake'
import { LanguageServices, type DiagnosticEntry } from '../language/language-services'
import { RpcError, PROTOCOL_VERSION } from '../rpc/protocol'
import type { AttachedClient, NotificationHandler, RequestHandler } from '../rpc/server'

import { captureConsole, parseStepLine, transportChange } from './console-capture'
import type { DocsSites } from './docs-sites'
import {
  DocumentStore,
  editorStateOf,
  documentPath,
  type Position,
  type Range,
  type TextChange,
} from './document-store'
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
  /** エディタのクライアントが開いている document の写し（§5.5）。 */
  readonly documents: DocumentStore
  /** 補完と診断（凍結版のコードを層 2 で走らせる・§5.3.4）。 */
  private readonly language: LanguageServices
  private readonly intake: EvaluationIntake
  private readonly targets = new Map<string, EvaluateTarget>()
  private playing = false
  /** いま `execute()` の中にいる評価の帰属（console の行に `evalId` を付けるため）。 */
  private executing: IntakeContext | null = null
  private releaseConsole: (() => void) | null = null
  readonly handlers: Readonly<Record<string, RequestHandler>>
  readonly notificationHandlers: Readonly<Record<string, NotificationHandler>>

  constructor(private readonly options: SessionCoreOptions) {
    this.logs = new LogHub(
      (line: LogLineNotification) => options.broadcast('log.line', line),
      () => options.engine.debug,
    )
    this.documents = new DocumentStore((level, text) => this.sessionLog(level, text))
    this.language = new LanguageServices({
      log: (level, text) => this.sessionLog(level, text),
      workspaceRoot: options.workspaceRoot,
    })
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
      'editor.getState': () => editorStateOf(this.requireEditor().active()),
      'editor.getDiagnostics': (params: { path?: string }) => this.getDiagnostics(params.path),
      'editor.complete': async (params: { uri: string; position: Position }) => {
        const document = this.documents.get(params.uri)
        return { items: document ? await this.language.complete(document, params.position) : [] }
      },
      'editor.getDocumentText': () => {
        const active = this.requireEditor().active()
        return active
          ? { path: documentPath(active.uri), text: active.text }
          : { path: null, text: null }
      },
      ...audioMethods(layer2),
      ...pluginMethods(layer2),
      ...docsMethods(layer2),
    }
    this.notificationHandlers = this.editorNotifications()
  }

  /** エディタが付いていなければ `NO_EDITOR_ATTACHED`（設計 §5.3.4・D-3）。 */
  private requireEditor(): DocumentStore {
    if (!this.options.editorAttached()) {
      throw new RpcError(
        'NO_EDITOR_ATTACHED',
        'no editor is attached to this session — open a document window in OrbitStudio, or use evaluate_orbitscore',
      )
    }
    return this.documents
  }

  /**
   * `editor.did*`（§5.5）。`editor` capability を持つクライアントの通知だけを受ける（エディタは
   * 同時に 1 つ・§5.4）。それ以外のクライアントの通知は捨てて理由を残す。
   */
  private editorNotifications(): Record<string, NotificationHandler> {
    const fromEditor =
      <P>(method: string, apply: (params: P) => void): NotificationHandler =>
      (params: P, client: AttachedClient) => {
        if (!client.capabilities.has('editor')) {
          this.sessionLog('warn', `[session] ${method} from a client without the editor capability`)
          return
        }
        apply(params)
      }
    return {
      'editor.didOpen': fromEditor(
        'editor.didOpen',
        (params: {
          uri: string
          version: number
          text: string
          documentDirectory: string | null
        }) => {
          this.documents.open(params.uri, params.version, params.text, params.documentDirectory)
          void this.publishDiagnostics(params.uri)
        },
      ),
      'editor.didChange': fromEditor(
        'editor.didChange',
        (params: { uri: string; version: number; changes: TextChange[] }) => {
          if (this.documents.change(params.uri, params.version, params.changes)) {
            void this.publishDiagnostics(params.uri)
          }
        },
      ),
      'editor.didClose': fromEditor('editor.didClose', (params: { uri: string }) => {
        this.documents.close(params.uri)
        // 閉じた文書のマーカーを消す（凍結版は DiagnosticCollection から消した）。
        this.options.broadcast('editor.diagnostics', { uri: params.uri, items: [] })
      }),
      'editor.didChangeSelection': fromEditor(
        'editor.didChangeSelection',
        (params: { uri: string; range: Range; cursor?: Position }) =>
          this.documents.select(params.uri, params.range, params.cursor),
      ),
      'editor.didChangeActive': fromEditor(
        'editor.didChangeActive',
        (params: { uri: string | null }) => this.documents.setActive(params.uri),
      ),
    }
  }

  /**
   * 文書の診断を計算して `editor.diagnostics` で送る（§5.5）。計算の間に文書が変われば、古い版の
   * 結果は送らない（後の変更がもう 1 回計算する）。
   */
  private async publishDiagnostics(uri: string): Promise<void> {
    const document = this.documents.get(uri)
    if (!document) return
    const version = document.version
    let items: DiagnosticEntry[]
    try {
      items = await this.language.diagnose(document)
    } catch (error) {
      this.sessionLog('error', `[session] diagnostics failed for ${uri}: ${String(error)}`)
      return
    }
    if (this.documents.get(uri)?.version !== version) return
    this.options.broadcast('editor.diagnostics', { uri, items })
  }

  /**
   * MCP `get_diagnostics`（凍結版 `getDiagnosticsForAgent` と同じ規則）: パスを渡せばその 1 件を必ず
   * 返し（診断が無くても空の配列で）、渡さなければ診断が 1 件以上ある文書だけを返す。対象は同期済みの
   * 文書（エディタが付いていなければ空）。
   */
  private async getDiagnostics(filePath?: string) {
    if (filePath !== undefined) {
      const document = this.documents
        .all()
        .find((candidate) => documentPath(candidate.uri) === filePath)
      return {
        files: [
          { path: filePath, diagnostics: document ? await this.language.diagnose(document) : [] },
        ],
      }
    }
    const files = []
    for (const document of this.documents.all()) {
      const diagnostics = await this.language.diagnose(document)
      if (diagnostics.length > 0) files.push({ path: documentPath(document.uri), diagnostics })
    }
    return { files }
  }

  /** クライアントが離れた時。エディタなら写しを捨てる（再接続で `didOpen` が再送される・F-12）。 */
  onClientDetached(client: AttachedClient): void {
    if (client.capabilities.has('editor')) this.documents.clear()
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
      documents: this.documents.list(),
      activeUri: this.documents.activeUriValue,
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
