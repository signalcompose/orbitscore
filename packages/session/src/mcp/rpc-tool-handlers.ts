/**
 * `OrbitScoreToolHandlers` を層 2 の RPC メソッドで満たす（設計 848 §6・D-4）。
 *
 * MCP ツールは RPC メソッドの薄い写しで、ここは**呼び出しと結果の整形だけ**を持つ — 層 2 に無い
 * 能力をここで足さない（中継は RPC のクライアントでしかない・§6 の D-4）。ツール固有に残る仕事は
 * `evaluate_orbitscore` の IM.6 の解決（§5.3.1）だけで、凍結版の純関数
 * `resolveEvaluateDocumentDirectory` を中継のプロセスで走らせる（ファイルの存在の確認も同じ Mac・
 * 同じユーザーの中継で行う）。
 *
 * 失敗の扱い: RPC のエラー（`RpcCallError`）と接続の失敗は**投げる**。`buildServer` がそれを凍結版の
 * `errorResult` と同じ封筒にする。凍結版と同じ `{ ok: false }` を層 2 が返すメソッドは、その値を
 * そのまま返す（文言は層 2 が凍結版と同じものを持つ）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'

import { RpcCallError } from '../rpc/client'

import { resolveEvaluateDocumentDirectory } from './evaluate-document-directory'
import type { DocsToolSource } from './mcp-tools-editor'
import type {
  AnalyzeAudioResult,
  AudioDevicesResult,
  CommandResult,
  DevDocSearchMatch,
  DocumentText,
  EditorState,
  EngineState,
  EvaluateResult,
  FileDiagnostics,
  FlashConfigResult,
  ListPluginsResult,
  OrbitScoreToolHandlers,
  PluginUiAtCursorResult,
  PluginUiResult,
  RescanPluginsResult,
  SavePluginStateResult,
} from './mcp-types'

/** 層 2 の RPC メソッドを 1 つ呼ぶ（中継は呼び出しのたびにソケットへ繋ぐ・RL-3）。 */
export type SessionCall = <T = unknown>(method: string, params?: unknown) => Promise<T>

interface SessionStateView {
  engine: { running: boolean }
  activeUri: string | null
  workspaceRoot: string | null
}

interface SessionEvaluateResult {
  ok: boolean
  evalId: string
  diagnostics: Array<{ kind: string; message: string }>
  documentDirectory: string | null
}

/** 凍結版 `evaluateForAgent` の engine の確認と同じ文言（`agent-handlers.ts`）。 */
const ENGINE_NOT_RUNNING = 'engine is not running — start the engine first'

/** エディタの状態が無いことを表す RPC のエラー。 */
// PROVISIONAL(P-19): S-editor が `editor.getState` を実装するまで METHOD_NOT_FOUND も「無し」と読む。
const NO_EDITOR = new Set(['NO_EDITOR_ATTACHED', 'METHOD_NOT_FOUND'])

/**
 * 凍結版 `isExistingFileForEvaluation`（`agent-handlers.ts`）の写し。無い・ディレクトリでないだけを
 * 「ファイルでない」とし、それ以外の stat の失敗は理由つきで投げる（IM.6 の `could not inspect`）。
 */
export function isExistingFileForEvaluation(
  absolutePath: string,
  stat: (path: string) => Pick<fs.Stats, 'isFile'> = fs.statSync,
): boolean {
  try {
    return stat(absolutePath).isFile()
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code
    if (errno === 'ENOENT' || errno === 'ENOTDIR') return false
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${errno ?? 'UNKNOWN'} while checking "${absolutePath}": ${message}`)
  }
}

/** 値が undefined のキーを落とす（params のスキーマは `additionalProperties: false`）。 */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export interface RpcToolHandlerOptions {
  isFile?: (absolutePath: string) => boolean
}

export function createRpcToolHandlers(
  call: SessionCall,
  options: RpcToolHandlerOptions = {},
): OrbitScoreToolHandlers {
  const isFile = options.isFile ?? ((absolutePath) => isExistingFileForEvaluation(absolutePath))

  /** IM.6 の「アクティブな OrbitScore エディタ」（エディタが付いていなければ無し）。 */
  const activeEditor = async (activeUri: string | null) => {
    if (activeUri === null) return undefined
    let editor: EditorState
    try {
      editor = await call<EditorState>('editor.getState')
    } catch (error) {
      if (error instanceof RpcCallError && NO_EDITOR.has(error.errorName ?? '')) return undefined
      throw error
    }
    if (editor.path === null) return undefined
    return {
      languageId: editor.languageId ?? '',
      scheme: new URL(activeUri).protocol.replace(/:$/, ''),
      fsPath: editor.path,
    }
  }

  return {
    async evaluate(code, evaluateOptions): Promise<EvaluateResult> {
      const state = await call<SessionStateView>('session.getState')
      // 凍結版と同じ順: engine の確認が IM.6 のエラーより先（`evaluateForAgent`）。
      if (!state.engine.running) return { ok: false, error: ENGINE_NOT_RUNNING }
      const workspaceRoot = state.workspaceRoot ?? undefined
      const documentPath = evaluateOptions?.documentPath
      const base = resolveEvaluateDocumentDirectory({
        documentPath,
        activeEditor: await activeEditor(state.activeUri),
        workspaceRoot,
        isFile,
      })
      if (!base.ok) return base
      // §5.3.1: `document_path` があれば `target: { uri }`（範囲は無し）。無ければ付けない。
      const target =
        documentPath === undefined
          ? undefined
          : {
              uri: pathToFileURL(
                path.isAbsolute(documentPath)
                  ? documentPath
                  : path.resolve(workspaceRoot ?? '', documentPath),
              ).href,
            }
      const result = await call<SessionEvaluateResult>(
        'session.evaluate',
        defined({
          code,
          documentDirectory: base.documentDirectory,
          source: 'agent',
          target,
        }),
      )
      if (result.ok) return { ok: true, documentDirectory: result.documentDirectory }
      // 凍結版 `evaluateForAgent` の整形（`[kind] message` を `; ` で繋ぐ）。
      const detail = result.diagnostics.length
        ? result.diagnostics.map((d) => `[${d.kind}] ${d.message}`).join('; ')
        : 'engine reported an evaluation failure'
      return {
        ok: false,
        error: `evaluation failed: ${detail}`,
        ...(result.diagnostics.length ? { diagnostics: result.diagnostics } : {}),
        documentDirectory: result.documentDirectory,
      }
    },
    startEngine: (start) =>
      call<CommandResult>(
        'engine.start',
        defined({ captureWav: start?.captureWav, debug: start?.debug }),
      ),
    stopEngine: () => call<CommandResult>('engine.stop'),
    getEngineState: () => call<EngineState>('engine.getState'),
    listAudioDevices: () => call<AudioDevicesResult>('audio.listDevices'),
    selectAudioDevice: (device) => call<CommandResult>('audio.selectDevice', { device }),
    configureFlash: (flash) => call<FlashConfigResult>('editor.configureFlash', defined(flash)),
    openFile: (filePath) => call<CommandResult>('editor.openFile', { path: filePath }),
    setSelection: (range) => call<CommandResult>('editor.setSelection', defined(range)),
    runSelection: () => call<CommandResult>('editor.runSelection'),
    editReplace: (args) => call<CommandResult>('editor.editReplace', defined(args)),
    getEditorState: () => call<EditorState>('editor.getState'),
    saveFile: () => call<CommandResult>('editor.saveFile'),
    getDocumentText: () => call<DocumentText>('editor.getDocumentText'),
    getDiagnostics: async (filePath) =>
      (
        await call<{ files: FileDiagnostics[] }>(
          'editor.getDiagnostics',
          defined({ path: filePath }),
        )
      ).files,
    // 凍結版の get_log は小数・0・負も受けた（`selectLogLines`）。層 2 の `session.getLog` も同じ式。
    getLog: async (lines) =>
      (await call<{ lines: string[] }>('session.getLog', defined({ lines }))).lines,
    analyzeAudio: (wavPath, windowMs, perChannel) =>
      call<AnalyzeAudioResult>('audio.analyze', defined({ wavPath, windowMs, perChannel })),
    listPlugins: () => call<ListPluginsResult>('plugin.list'),
    rescanPlugins: () => call<RescanPluginsResult>('plugin.rescan'),
    // §6: 条件付きの 5 本も、ネイティブ版では常に登録する（28 本・同じ順序）。
    savePluginState: (sequence, index) =>
      call<SavePluginStateResult>('plugin.saveState', { receiver: sequence, index }),
    openPluginUi: (receiver, index, expectedName) =>
      call<PluginUiResult>('plugin.openUi', defined({ receiver, index, expectedName })),
    closePluginUi: (receiver, index) => call<PluginUiResult>('plugin.closeUi', { receiver, index }),
    openPluginUiAtCursor: () => call<PluginUiAtCursorResult>('plugin.openUiAtCursor'),
    registerMcpServer: (args) =>
      call<CommandResult>('session.registerMcp', defined({ scope: args.scope, port: args.port })),
  }
}

/** docs 系のツールが読む先（層 2 の `docs.*`・§5.3.5）。 */
export function createRpcDocsSource(call: SessionCall): DocsToolSource {
  return {
    get: async (site, relativePath) =>
      (await call<{ text: string }>('docs.get', { site, path: relativePath })).text,
    search: async (site, query, limit) =>
      (await call<{ matches: DevDocSearchMatch[] }>('docs.search', { site, query, limit })).matches,
  }
}
