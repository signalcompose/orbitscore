/**
 * VS Code wiring for MCP agent handlers.
 *
 * Function bodies are moved unchanged from extension.ts. Helpers that were
 * module-private are exported only so the extension root can preserve its
 * existing wiring across the new module boundary.
 */
import * as fs from 'fs'
import { randomUUID } from 'crypto'

import * as vscode from 'vscode'

import { resolveEngineState } from './engine-state-bridge'
import { decideStartEngineForAgent } from './engine-lifecycle'
import { resolveDeviceClickAction, translateSelectAudioDeviceError } from './engine-view'
import { writeAudioDeviceSetting } from './engine-view-provider'
import {
  resolveAudioDeviceSetting,
  sendEngineStateMeta,
  sendPluginStateMeta,
  sendPluginUiMeta,
  sendSelectAudioDeviceMeta,
  startEngine,
  stopEngine,
  writeCodeToEngine,
} from './engine-process'
import {
  engineProcess,
  evalMarkBridge,
  isEngineRunning,
  isLiveCodingMode,
  outputChannel,
  outputLogRing,
  transportPlaying,
} from './extension-state'
import { selectLogLines } from './log-ring'
import type {
  AnalyzeAudioResult,
  AudioDevicesResult,
  CommandResult,
  DiagnosticSeverityLabel,
  DocumentText,
  EditReplaceInput,
  EditorState,
  EngineState,
  EvaluateResult,
  FileDiagnostics,
  PluginUiResult,
  SavePluginStateResult,
  SelectionInput,
} from './mcp-server'
import type { PluginUiAction } from './plugin-ui-bridge'
import { analyzeWavBuffer } from './wav-analysis'

/** `pluginUiForAgent` is module-private (only `activate()` wires it into MCP);
 * this seam lets a spec drive the real engine-guard + meta-line round-trip. */
export function __pluginUiForAgentForTest(
  action: PluginUiAction,
  receiver: string,
  index: number,
  expectedName?: string,
): ReturnType<typeof pluginUiForAgent> {
  return pluginUiForAgent(action, receiver, index, expectedName)
}

/**
 * Evaluate agent-supplied OrbitScore source (MCP `evaluate_orbitscore` tool).
 * Mirrors the engine-running guard in `runSelection` and reuses
 * `writeCodeToEngine`. Relative audio paths resolve against the first workspace
 * folder, since the agent has no "active editor".
 */
async function evaluateForAgent(code: string): Promise<EvaluateResult> {
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    return { ok: false, error: 'engine is not running — start the engine first' }
  }
  const documentDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!writeCodeToEngine(code, documentDir)) {
    return { ok: false, error: 'engine stdin is not writable — the engine may have just died' }
  }
  // 🔴 #614: 以前はここで `{ ok: true }` を返していた。しかしその ok は
  // 「**stdin へ届いた**」までしか意味せず、パース/実行エラーは engine が stderr へ
  // 非同期に出すだけだった。LLM は ok を成功と解釈するので、実機で
  // `Variable not found: global` が出ていても先へ進んでしまう（実測）。
  //
  // REPL は行を FIFO で処理するので、コードの直後にマーカーを送れば
  // **マーカーに到達した時点で評価は完了している**。時間で待つ必要はない。
  const stdin = engineProcess.stdin
  if (!stdin || !stdin.writable) {
    return { ok: false, error: 'engine stdin is not writable — the engine may have just died' }
  }
  const result = await evalMarkBridge.send((line, onError) => {
    // 既存 bridge（pluginUi）と同じ書き方に揃える。error は null 込みで来る。
    stdin.write(line, (error) => {
      if (error) {
        outputChannel?.appendLine(`⚠️ failed to write //#evalMark to stdin: ${error.message}`)
        onError(error)
      }
    })
  }, randomUUID())
  if (result.ok) return { ok: true }
  const detail = result.diagnostics.length
    ? result.diagnostics.map((d) => `[${d.kind}] ${d.message}`).join('; ')
    : (result.error ?? 'engine reported an evaluation failure')
  return {
    ok: false,
    error: `evaluation failed: ${detail}`,
    ...(result.diagnostics.length ? { diagnostics: result.diagnostics } : {}),
  }
}

async function savePluginStateForAgent(
  sequence: string,
  index: number,
): Promise<SavePluginStateResult> {
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    return { ok: false, error: 'engine is not running — start the engine first' }
  }
  if (transportPlaying) {
    return {
      ok: false,
      error: 'plugin state cannot be saved while the transport is running; stop first',
    }
  }
  try {
    const result = await sendPluginStateMeta(sequence, index)
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.details === undefined ? {} : { details: result.details }),
      }
    }
    return { ok: true, saved: result.saved }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function pluginUiForAgent(
  action: PluginUiAction,
  receiver: string,
  index: number,
  expectedName?: string,
): Promise<PluginUiResult> {
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    return { ok: false, error: 'engine is not running — start the engine first' }
  }
  try {
    const response = await sendPluginUiMeta(action, receiver, index, expectedName)
    if (!response.ok) {
      return {
        ok: false,
        error: response.error,
        ...(response.code ? { code: response.code } : {}),
        ...(response.details === undefined ? {} : { details: response.details }),
      }
    }
    return { ok: true, result: response.result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Start the engine for the MCP `start_engine` tool (mirrors the palette command). */
export async function startEngineForAgent(options?: {
  captureWav?: string
  debug?: boolean
}): Promise<CommandResult> {
  const decision = decideStartEngineForAgent(isEngineRunning() && isLiveCodingMode, options)
  // `isEngineRunning() && isLiveCodingMode` can already be true here without this
  // call having spawned anything: autoStartConfiguredRustEngine() calls
  // startEngine() directly on activation when a saved audio device setting is
  // configured (and, unless it is `__default__`, that device is present in the
  // enumerated device list) — see the config gate there. Callers may also have
  // started the engine explicitly via an earlier start_engine call.
  if (decision.kind === 'reject') return { ok: false, error: decision.error }
  if (decision.kind === 'already-running') return { ok: true, message: 'engine already running' }
  if (!(await startEngine(options?.debug === true, options))) {
    return { ok: false, error: 'engine failed to start — see the OrbitScore output channel' }
  }
  return {
    ok: true,
    message: options?.captureWav
      ? `engine starting (capturing to ${options.captureWav})`
      : 'engine starting',
  }
}

/** Stop the engine for the MCP `stop_engine` tool (mirrors the palette command). */
function stopEngineForAgent(): CommandResult {
  if (!engineProcess || engineProcess.killed) {
    return { ok: true, message: 'engine already stopped' }
  }
  stopEngine()
  return { ok: true, message: 'engine stopping' }
}

/**
 * `get_engine_state` が daemon の状態を待つ予算。
 *
 * 🔴 **長くしても取れるようにはならない。** `//#getEngineState` は REPL の `handleLine` の中で
 * 処理され、`createReplSession` の `pushLine` は全行を**単一の FIFO promise チェーン**に載せる
 * （`packages/engine/src/cli/repl-mode.ts` の「直列化の根拠 — #476」）。つまり長い await
 * （instrument の attach は実測 30 秒超）の最中は、**どんな予算でも答えは返らない**。
 * 予算を伸ばして得られるのは「同じ `statusError` を返すまでに何秒ブロックするか」だけで、
 * 対話的なツール呼び出しとしては短く degrade する方が良い。
 *
 * `running` は同期に分かるので、状態が取れなくても `{running, statusError}` は必ず返る。
 * **長い処理の最中にも状態を見せたいなら、必要なのは予算ではなく `//#getEngineState` を
 * キューの外で処理すること**（別 issue）。
 */
const ENGINE_STATE_QUERY_BUDGET_MS = 2_500

/**
 * Report engine state for the MCP `get_engine_state` tool. 判定そのものは
 * `resolveEngineState`（`engine-state-bridge.ts`）にあり、ここは配線だけ。
 */
function getEngineStateForAgent(): Promise<EngineState> {
  return resolveEngineState(
    {
      running: Boolean(engineProcess && !engineProcess.killed),
      liveCoding: isLiveCodingMode,
    },
    () => sendEngineStateMeta(ENGINE_STATE_QUERY_BUDGET_MS),
  )
}

/**
 * List audio devices for the MCP `list_audio_devices` tool. The Rust engine
 * has no device-enumeration API today (tracked separately — doc 662 §6 /
 * #660), so this always reports the gap rather than pretending to probe.
 */
async function listAudioDevicesForAgent(): Promise<AudioDevicesResult> {
  return {
    ok: false,
    error:
      'audio device selection is not supported with the Rust engine; the system default output device is used',
  }
}

/**
 * Write the selected device for the MCP `select_audio_device` tool. Mirrors
 * the Engine view's device-click flow (D2.5 live bridge / next-start
 * settings write).
 */
async function selectAudioDeviceForAgent(device: string): Promise<CommandResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
  const action = resolveDeviceClickAction(
    device,
    resolveAudioDeviceSetting(workspaceRoot),
    isEngineRunning(),
  )
  if (action === 'deselect-stop') {
    await writeAudioDeviceSetting('')
    if (isEngineRunning() && !stopEngine()) {
      return { ok: false, error: 'engine failed to stop — see the OrbitScore output channel' }
    }
    return { ok: true, message: 'audio device deselected and engine stopped' }
  }
  if (action === 'start') {
    await writeAudioDeviceSetting(device)
    if (!(await startEngine())) {
      return { ok: false, error: 'engine failed to start — see the OrbitScore output channel' }
    }
    return { ok: true, message: `audio device selected: ${device}; engine starting` }
  }
  try {
    const result = await sendSelectAudioDeviceMeta(device)
    if (result.ok) {
      await writeAudioDeviceSetting(result.device ?? device)
      return {
        ok: true,
        message: `audio device switched to: ${result.device ?? device} (persisted for next start)`,
      }
    }
    return { ok: false, error: translateSelectAudioDeviceError(result.error) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Open a file for the MCP `open_file` tool (the "Go to File" equivalent). */
async function openFileForAgent(filePath: string): Promise<CommandResult> {
  try {
    const doc = await vscode.workspace.openTextDocument(filePath)
    await vscode.window.showTextDocument(doc, { preview: false })
    return { ok: true, message: `opened (languageId: ${doc.languageId})` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Set the active editor's selection for the MCP `set_selection` tool. The
 * schema is 1-based (matches the editor gutter); converted to 0-based
 * `vscode.Position` here. Omitting both `endLine` and `endChar` collapses the
 * selection to a cursor at the start position.
 */
function setSelectionForAgent(range: SelectionInput): CommandResult {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return { ok: false, error: 'no active editor — open a file first' }
  }
  const collapse = range.endLine === undefined && range.endChar === undefined
  const startPos = editor.document.validatePosition(
    new vscode.Position(range.startLine - 1, (range.startChar ?? 1) - 1),
  )
  const endPos = collapse
    ? startPos
    : editor.document.validatePosition(
        new vscode.Position((range.endLine ?? range.startLine) - 1, (range.endChar ?? 1) - 1),
      )
  editor.selection = new vscode.Selection(startPos, endPos)
  editor.revealRange(new vscode.Range(startPos, endPos))
  return { ok: true, message: 'selection set' }
}

/** Literal (non-regex) find/replace in the active document for the MCP `edit_replace` tool. */
async function editReplaceForAgent(args: EditReplaceInput): Promise<CommandResult> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return { ok: false, error: 'no active editor' }
  }
  if (!args.find) {
    return { ok: false, error: 'find must not be empty' }
  }
  const text = editor.document.getText()
  const offsets: number[] = []
  let idx = text.indexOf(args.find)
  while (idx !== -1) {
    offsets.push(idx)
    if (!args.all) break
    idx = text.indexOf(args.find, idx + args.find.length)
  }
  if (offsets.length === 0) {
    return { ok: false, error: `no match for ${JSON.stringify(args.find)}` }
  }
  const applied = await editor.edit((editBuilder) => {
    for (const offset of offsets) {
      const start = editor.document.positionAt(offset)
      const end = editor.document.positionAt(offset + args.find.length)
      editBuilder.replace(new vscode.Range(start, end), args.replace)
    }
  })
  if (!applied) {
    return { ok: false, error: 'edit was rejected by the editor' }
  }
  return { ok: true, message: `replaced ${offsets.length} occurrence(s)` }
}

/** Snapshot the active editor for the MCP `get_editor_state` tool. All positions are 1-based. Fields are null when no editor is active. */
function getEditorStateForAgent(): EditorState {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return {
      path: null,
      languageId: null,
      cursor: null,
      selection: null,
      lineCount: null,
      isDirty: null,
    }
  }
  const doc = editor.document
  const toPos = (p: vscode.Position) => ({ line: p.line + 1, character: p.character + 1 })
  return {
    path: doc.uri.fsPath,
    languageId: doc.languageId,
    cursor: toPos(editor.selection.active),
    selection: { start: toPos(editor.selection.start), end: toPos(editor.selection.end) },
    lineCount: doc.lineCount,
    isDirty: doc.isDirty,
  }
}

/**
 * Save the active document to disk for the MCP `save_file` tool. edit_replace
 * only mutates the in-memory buffer, so this is the only way an agent can
 * persist a live-edited or live-played file (#392). A no-op when the document
 * has no unsaved changes, since `document.save()` resolving `false` is
 * ambiguous between "nothing to save" and "save failed" — checking `isDirty`
 * first sidesteps that ambiguity.
 *
 * Rejects a document with no on-disk path (uri.scheme !== 'file', e.g. an
 * untitled buffer): `document.save()` on such a document pops an interactive
 * "Save As" dialog and never resolves in a headless/agent-driven session — the
 * exact live-jam recovery scenario this tool exists for. Fail loudly instead of
 * hanging silently. Save failures (false return or a thrown error) are logged
 * to the output channel so `get_log` surfaces why a persist did not happen.
 *
 * Known limitation: the scheme guard does not cover every dialog path — a
 * file-scheme document can still block on an interactive prompt when
 * `save()` detects a disk conflict (the file changed on disk since load) or
 * an overwrite confirmation. No timeout is implemented; this path is
 * unreachable through the current MCP tool surface (all edits flow through
 * `open_file` → `edit_replace`), so re-evaluate if the tool surface widens.
 */
async function saveFileForAgent(): Promise<CommandResult> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return { ok: false, error: 'no active editor' }
  }
  const doc = editor.document
  if (doc.uri.scheme !== 'file') {
    return {
      ok: false,
      error: `cannot save — document has no file path (scheme: ${doc.uri.scheme})`,
    }
  }
  if (!doc.isDirty) {
    return { ok: true, message: `no changes to save (already saved): ${doc.uri.fsPath}` }
  }
  try {
    const saved = await doc.save()
    if (!saved) {
      outputChannel?.appendLine(
        `❌ save_file: document.save() returned false for ${doc.uri.fsPath}`,
      )
      return { ok: false, error: `save failed: ${doc.uri.fsPath}` }
    }
    return { ok: true, message: `saved: ${doc.uri.fsPath}` }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ save_file: ${reason} (${doc.uri.fsPath})`)
    return { ok: false, error: `save failed: ${reason}` }
  }
}

/** Full text of the active document for the MCP `get_document_text` tool. Fields are null when no editor is active. */
function getDocumentTextForAgent(): DocumentText {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return { path: null, text: null }
  }
  const doc = editor.document
  return { path: doc.uri.fsPath, text: doc.getText() }
}

/**
 * Report diagnostics for the MCP `get_diagnostics` tool
 * (`vscode.languages.getDiagnostics`). Without a path, only files that
 * currently have at least one diagnostic are included; with a path, the
 * single file is always included (even with an empty diagnostics array), so
 * the agent can distinguish "no diagnostics" from "file not checked".
 */
function getDiagnosticsForAgent(filePath?: string): FileDiagnostics[] {
  const severityLabel = (s: vscode.DiagnosticSeverity): DiagnosticSeverityLabel => {
    switch (s) {
      case vscode.DiagnosticSeverity.Error:
        return 'error'
      case vscode.DiagnosticSeverity.Warning:
        return 'warning'
      case vscode.DiagnosticSeverity.Information:
        return 'info'
      default:
        return 'hint'
    }
  }
  const toEntries = (diagnostics: readonly vscode.Diagnostic[]) =>
    diagnostics.map((d) => ({
      line: d.range.start.line + 1,
      character: d.range.start.character + 1,
      severity: severityLabel(d.severity),
      message: d.message,
      ...(typeof d.code === 'string' || typeof d.code === 'number' ? { code: d.code } : {}),
    }))

  if (filePath) {
    const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(filePath))
    return [{ path: filePath, diagnostics: toEntries(diagnostics) }]
  }
  return vscode.languages
    .getDiagnostics()
    .filter(([, diagnostics]) => diagnostics.length > 0)
    .map(([uri, diagnostics]) => ({ path: uri.fsPath, diagnostics: toEntries(diagnostics) }))
}

/**
 * Return the last N lines of the output-channel ring buffer for the MCP `get_log` tool.
 * 選択ロジックは `log-ring.ts`（vscode 非依存・テスト可能）に持たせている（#567）。
 */
function getLogForAgent(lines?: number): string[] {
  return selectLogLines(outputLogRing, lines)
}

/** Parse a captured WAV for the MCP `analyze_audio` tool. */
function analyzeAudioForAgent(
  wavPath: string,
  windowMs?: number,
  perChannel?: boolean,
): AnalyzeAudioResult {
  try {
    const buf = fs.readFileSync(wavPath)
    return { ok: true, analysis: analyzeWavBuffer(buf, { windowMs, perChannel }) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export {
  analyzeAudioForAgent,
  editReplaceForAgent,
  evaluateForAgent,
  getDiagnosticsForAgent,
  getDocumentTextForAgent,
  getEditorStateForAgent,
  getEngineStateForAgent,
  getLogForAgent,
  listAudioDevicesForAgent,
  openFileForAgent,
  pluginUiForAgent,
  saveFileForAgent,
  savePluginStateForAgent,
  selectAudioDeviceForAgent,
  setSelectionForAgent,
  stopEngineForAgent,
}
