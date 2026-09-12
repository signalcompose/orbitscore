/**
 * MCP の wire 型と `OrbitScoreToolHandlers`（#887 束 F・`mcp-server.ts` から移した）。
 *
 * 🔴 **`mcp-server.ts` が `export type { … } from './mcp-types'` で再輸出しているので、
 * import 先は変えていない**（設計 `887-extension-split-design.md` §5.2）。
 * `extension.ts` / spec / `engine-state-bridge` / `daemon-client` は今も `mcp-server` から取る。
 */
import type { PluginScanFailure, PluginScanSummary } from './plugin-catalog-reader'
import type { WavAnalysis } from './wav-analysis'

/** Result of evaluating agent-supplied OrbitScore source. */
/**
 * `evaluate_orbitscore` の結果（#614）。
 *
 * 🔴 以前は `{ ok: true }` が「**stdin へ書けた**」しか意味しておらず、パース/実行エラーは
 * stderr へ非同期に出るだけだった。LLM は `ok` を成功と解釈するため、実機で
 * `Variable not found: global` が出ていても先へ進んでしまう。
 * いまは engine の評価結果まで待ち、診断があれば `ok: false` にする。
 */
export type EvaluateResult =
  | { ok: true }
  | { ok: false; error: string; diagnostics?: Array<{ kind: string; message: string }> }

/** Result of a lifecycle command (start/stop engine). */
export type CommandResult = { ok: true; message?: string } | { ok: false; error: string }

/** Snapshot of the engine process state. */
export interface EngineState {
  running: boolean
  liveCoding: boolean
  output?: Record<string, unknown>
  callback?: Record<string, unknown>
  statusError?: string
}

/** One reported audio device (list_audio_devices / select_audio_device). Not populated by the Rust engine today (list_audio_devices always errors — tracked separately, doc 662 §6 / #660); shape kept for a future rust device-enumeration API. */
export interface AudioDeviceInfo {
  label: string
  id: number
  description: string
}
export type AudioDevicesResult =
  | { ok: true; devices: AudioDeviceInfo[] }
  | { ok: false; error: string }

/** Fields accepted by configure_flash; omitted fields keep their current value. */
export interface FlashConfigInput {
  count?: number
  duration?: number
  color?: string
  customColor?: string
}
/** Effective flash configuration, returned after applying a configure_flash call. */
export interface FlashConfig {
  count: number
  duration: number
  color: string
  customColor: string
}
export type FlashConfigResult = { ok: true; config: FlashConfig } | { ok: false; error: string }

/** 1-based selection range for set_selection (matches the editor gutter). */
export interface SelectionInput {
  startLine: number
  startChar?: number
  endLine?: number
  endChar?: number
}

/** Literal find/replace arguments for edit_replace. */
export interface EditReplaceInput {
  find: string
  replace: string
  all?: boolean
}

/** Snapshot of the active editor for get_editor_state. Fields are null when no editor is active. */
export interface EditorState {
  path: string | null
  languageId: string | null
  cursor: { line: number; character: number } | null
  selection: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  } | null
  lineCount: number | null
  isDirty: boolean | null
}

/** Full text of the active document for get_document_text. Fields are null when no editor is active. */
export interface DocumentText {
  path: string | null
  text: string | null
}

/** Diagnostic severities as reported by get_diagnostics, spelled out (not numeric) for agent readability. */
export type DiagnosticSeverityLabel = 'error' | 'warning' | 'info' | 'hint'
export interface DiagnosticEntry {
  line: number
  character: number
  severity: DiagnosticSeverityLabel
  message: string
  code?: string | number
}
export interface FileDiagnostics {
  path: string
  diagnostics: DiagnosticEntry[]
}

/** Result of analyze_audio (wav-analysis.ts is the vscode-free WAV parser). */
export type AnalyzeAudioResult = { ok: true; analysis: WavAnalysis } | { ok: false; error: string }

/** One entry of the plugin catalog (#463 PC.1), as reported by list_plugins. */
export interface PluginCatalogEntryInfo {
  name: string
  vendor: string
  format: string
  path: string
  pluginId: string
  roles: string[]
}
/** Result of list_plugins: the plugin catalog, or an error when it hasn't been scanned yet. */
export type ListPluginsResult =
  | { ok: true; plugins: PluginCatalogEntryInfo[] }
  | { ok: false; error: string }

/** Result of rescan_plugins: the scan summary, or an error. */
export type RescanPluginsResult =
  | {
      ok: true
      count: number
      artifactCount: number
      skipped: string[]
      failures: PluginScanFailure[]
      summary: PluginScanSummary
    }
  | { ok: false; error: string }

export type SavePluginStateResult =
  | { ok: true; saved: unknown }
  | { ok: false; error: string; code?: string; details?: unknown }

export type PluginUiResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code?: string; details?: unknown }

/**
 * Arguments for register_mcp_server. `scope` is a raw string here (rather than
 * the 'project' | 'user' union) so validation lives in one place — the
 * extension-side handler — instead of being split between schema coercion and
 * handler checks.
 */
export interface RegisterMcpServerInput {
  scope: string
  port?: number
}

/**
 * VSCode-agnostic handler seam. Keeping the tool implementations behind this
 * interface (rather than reaching into the extension directly) means the same
 * handlers can be re-hosted later by the WCTM pi harness (spec §3/§4.2).
 */
export interface OrbitScoreToolHandlers {
  evaluate(code: string): Promise<EvaluateResult> | EvaluateResult
  startEngine(options?: {
    captureWav?: string
    debug?: boolean
  }): Promise<CommandResult> | CommandResult
  stopEngine(): Promise<CommandResult> | CommandResult
  getEngineState(): Promise<EngineState> | EngineState
  listAudioDevices(): Promise<AudioDevicesResult> | AudioDevicesResult
  selectAudioDevice(device: string): Promise<CommandResult> | CommandResult
  configureFlash(options: FlashConfigInput): Promise<FlashConfigResult> | FlashConfigResult
  openFile(path: string): Promise<CommandResult> | CommandResult
  setSelection(range: SelectionInput): CommandResult
  runSelection(): Promise<CommandResult> | CommandResult
  editReplace(args: EditReplaceInput): Promise<CommandResult> | CommandResult
  getEditorState(): EditorState
  saveFile(): Promise<CommandResult> | CommandResult
  getDocumentText(): DocumentText
  getDiagnostics(path?: string): FileDiagnostics[]
  getLog(lines?: number): string[]
  analyzeAudio(
    wavPath: string,
    windowMs?: number,
    perChannel?: boolean,
  ): Promise<AnalyzeAudioResult> | AnalyzeAudioResult
  /** list_plugins (#463 PC.4): return the plugin catalog as-is. */
  listPlugins(): Promise<ListPluginsResult> | ListPluginsResult
  /** rescan_plugins (#463 PC.4/C1b): run the scanner and return its summary. */
  rescanPlugins(): Promise<RescanPluginsResult> | RescanPluginsResult
  /** 明示plugin state保存。互換フィールド `sequence` で UIH.5 の `(receiver,index)` を受ける。 */
  savePluginState?(
    sequence: string,
    index: number,
  ): Promise<SavePluginStateResult> | SavePluginStateResult
  openPluginUi?(
    receiver: string,
    index: number,
    expectedName?: string,
  ): Promise<PluginUiResult> | PluginUiResult
  closePluginUi?(receiver: string, index: number): Promise<PluginUiResult> | PluginUiResult
  /**
   * Optional (unlike the members above): only hosts that can register
   * themselves into Claude Code expose the register_mcp_server tool — the
   * tool is skipped when this handler is absent, so existing stub suites and
   * alternative hosts (WCTM pi harness) stay valid without changes.
   */
  registerMcpServer?(args: RegisterMcpServerInput): Promise<CommandResult> | CommandResult
}

export interface DevDocSearchMatch {
  path: string
  line: number
  excerpt: string
}
