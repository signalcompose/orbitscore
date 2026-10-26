/**
 * 層 2 の真実を持つもの（設計 848 §3 の「2 セッション」の行）: engine・評価の受付口・log ring・
 * transport の状態・クライアントの一覧。RPC サーバに渡すメソッドの実装もここに置く。
 *
 * v1 のスキーマの C→S のメソッドをすべて実装する: `session.*`・`engine.*`・`audio.*` / `plugin.*` /
 * `docs.*`（`layer2-methods.ts`）・`editor.did*` と `editor.getState` / `getDocumentText` /
 * `complete` / `getDiagnostics`（同期済みの写しから）・逆方向の `editor.*`（エディタへ転送・
 * `runSelection` は選択だけを聞いて層 2 が評価する）・`plugin.openUiAtCursor`（同期済みの選択から）。
 */
import crypto from 'node:crypto'

import type { AudioIR } from '@orbitscore/engine/dist/parser/audio-parser'

import {
  createEvaluationIntake,
  type EvaluationIntake,
  type IntakeContext,
  type IntakeExecuteOptions,
} from '../eval/evaluation-intake'
import { LanguageServices, shimDocument, type DiagnosticEntry } from '../language/language-services'
import { openPluginUiAtCursor } from '../language/plugin-ui-at-cursor'
import { withPluginUiOpener } from '../language/plugin-ui-shim'
import type { PluginUiResult } from '../mcp/mcp-types'
import { RpcError, PROTOCOL_VERSION } from '../rpc/protocol'
import type { AttachedClient, NotificationHandler, RequestHandler } from '../rpc/server'

import { captureConsole, parseStepLine, transportChange } from './console-capture'
import type { DocsSites } from './docs-sites'
import {
  DocumentStore,
  editorStateOf,
  documentPath,
  inferLanguageId,
  type Position,
  type Range,
  type TextChange,
} from './document-store'
import type { EngineHost, StartEngineParams } from './engine-host'
import { audioMethods, docsMethods, pluginMethods, type Layer2MethodDeps } from './layer2-methods'
import { registerMcp, type RegisterMcpDeps, type RegisterMcpParams } from './mcp-registration'
import { classifyEngineLine, classifySessionLine, type OutputStream } from './log-classify'
import { LogHub, type LogLineNotification } from './log-hub'
import { oneBasedCursor, resolveSelectionBlock } from './selection-block'

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
  /**
   * エディタのクライアントへ逆方向のリクエストを送る口（RPC サーバの `requestEditor`・§5.4）。
   * エディタが無い・答えない・切れた時は、サーバが `NO_EDITOR_ATTACHED` / `EDITOR_TIMEOUT` で拒む。
   */
  requestEditor(method: string, params: unknown): Promise<unknown>
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

/** エディタが `editor.runSelection` で返す選択の位置（スキーマの `SelectionSnapshot`）。 */
interface SelectionSnapshot {
  uri: string
  version: number
  range: Range
  documentDirectory: string | null
}

/** 凍結版 `runSelectionForAgent`（`run-selection.ts`）と同じ文言。 */
const NO_ORBITSCORE_EDITOR = 'no active OrbitScore editor — open an .orbs file first'
const ENGINE_NOT_RUNNING_MESSAGE = 'engine is not running — start the engine first'

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
    const plugin = pluginMethods(layer2)
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
      ...this.editorRequests(),
      ...audioMethods(layer2),
      ...plugin,
      'plugin.openUiAtCursor': (_params: Record<string, never>, client: AttachedClient) =>
        withPluginUiOpener(
          (receiver, index, expectedName) =>
            plugin['plugin.openUi']!(
              { receiver, index, ...(expectedName === undefined ? {} : { expectedName }) },
              client,
            ) as Promise<PluginUiResult>,
          () => openPluginUiAtCursor(this.pluginCursorEditor()),
        ),
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
   * 逆方向の `editor.*`（§5.3.4・§5.4）: 中継から届いた同名のメソッドを、エディタのクライアントへ
   * そのまま転送する（スキーマの `x-editor-request: same`）。結果の中身はエディタが作る。
   */
  private editorRequests(): Record<string, RequestHandler> {
    const forward = (method: string) => (params: unknown) =>
      this.options.requestEditor(method, params)
    return {
      'editor.openFile': forward('editor.openFile'),
      'editor.setSelection': forward('editor.setSelection'),
      'editor.editReplace': forward('editor.editReplace'),
      'editor.configureFlash': forward('editor.configureFlash'),
      'editor.saveFile': async (params: Record<string, never>) => {
        // 頼んだ時点の版を保存済みにする（答えが来るまでに入った変更を「保存済み」と言わない）。
        const active = this.documents.active()
        const version = active?.version
        const result = (await this.options.requestEditor('editor.saveFile', params)) as {
          ok: boolean
        }
        if (result.ok && active) this.documents.markSaved(active.uri, version)
        return result
      },
      'editor.runSelection': (_params: Record<string, never>, client: AttachedClient) =>
        this.runSelection(client),
    }
  }

  /**
   * `editor.runSelection`（§5.4）: エディタには選択の位置だけを聞き、評価する範囲（subject-block）は
   * 層 2 が同期済みの写しから決めて評価する。検査の順と文言は凍結版 `runSelectionForAgent` と同じ。
   */
  private async runSelection(client: AttachedClient) {
    const active = this.requireEditor().active()
    if (!active || inferLanguageId(active.uri) !== 'orbitscore') {
      return { ok: false, error: NO_ORBITSCORE_EDITOR }
    }
    if (!this.options.engine.running) return { ok: false, error: ENGINE_NOT_RUNNING_MESSAGE }
    const snapshot = (await this.options.requestEditor(
      'editor.runSelection',
      {},
    )) as SelectionSnapshot
    const document = this.documents.get(snapshot.uri)
    if (!document || document.version !== snapshot.version) {
      // 通知と答えは同じ接続で順に届くので、ここに来るのは同期の欠陥。古い写しを評価しない。
      const have = document ? `version ${document.version}` : 'no copy'
      return {
        ok: false,
        error: `the editor selection is on version ${snapshot.version} of ${snapshot.uri}, but layer 2 has ${have} — the document sync fell behind`,
      }
    }
    const block = resolveSelectionBlock(document.text, snapshot.range)
    const source = client.capabilities.has('editor') ? 'human' : 'agent'
    await this.evaluate(
      {
        code: block.code,
        documentDirectory: snapshot.documentDirectory,
        source,
        target: { uri: snapshot.uri, version: snapshot.version, range: block.range },
      },
      client,
    )
    if (source === 'agent') await this.collapseAgentSelection(snapshot)
    return { ok: true, message: 'selection executed' }
  }

  /**
   * LLM が走らせた後に選択をカーソルへ畳む（凍結版の #390: `set_selection` が残した選択が playhead の
   * 強調を覆う）。人の ⌘Enter では畳まない。畳めなくても評価は済んでいるので、失敗はログに残すだけ。
   */
  private async collapseAgentSelection(snapshot: SelectionSnapshot): Promise<void> {
    const { start, end } = snapshot.range
    if (start.line === end.line && start.character === end.character) return
    const cursor = this.documents.get(snapshot.uri)?.cursor ?? end
    try {
      await this.options.requestEditor('editor.setSelection', oneBasedCursor(cursor))
    } catch (error) {
      this.sessionLog('warn', `[session] could not collapse the agent selection: ${String(error)}`)
    }
  }

  /**
   * `plugin.openUiAtCursor`（§5.3.3）に渡すエディタ: 同期済みの前面の文書と選択（`anchor` は選択の
   * カーソルでない側の端）。エディタが付いていなければ `NO_EDITOR_ATTACHED`、前面の文書が無ければ
   * 写しが凍結版と同じ文言で断る。
   */
  private pluginCursorEditor() {
    const active = this.requireEditor().active()
    if (!active) return undefined
    const { start, end } = active.selection
    const cursorAtEnd = active.cursor.line === end.line && active.cursor.character === end.character
    return {
      document: shimDocument(active),
      selection: { active: active.cursor, anchor: cursorAtEnd ? start : end },
    }
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
