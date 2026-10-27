/**
 * Generated from protocol/session/v1/session.schema.json by scripts/protocol/generate.mjs — do not edit.
 * Regenerate with `npm run protocol:generate`; `npm run protocol:check` verifies it is up to date.
 *
 * Licensed under the Apache License, Version 2.0 (protocol/LICENSE).
 */

/** The protocol version these types describe (x-protocol-version). */
export type ProtocolVersionLiteral = '1.0'

/**
 * A document URI as the editor client knows it (file: for saved documents).
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DocumentUri".
 */
export type DocumentUri = string
/**
 * An absolute POSIX path. Values are records and are not trimmed or normalized on the wire.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "AbsolutePath".
 */
export type AbsolutePath = string
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ClientCapability".
 */
export type ClientCapability = 'editor' | 'observer'
/**
 * MAJOR.MINOR. MINOR follows x-compatibility and adds only; MAJOR breaks. The protocol_version properties in session.hello and session.attach retain this shape in every MAJOR.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ProtocolVersion".
 */
export type ProtocolVersion = string
/**
 * A request id. null is never a valid request id.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "JsonRpcId".
 */
export type JsonRpcId = string | number
/**
 * A symbolic key of x-errors. Receivers fall back to the numeric JSON-RPC code for unknown names.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ErrorName".
 */
export type ErrorName =
  | 'PARSE_ERROR'
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'INTERNAL_ERROR'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'EDITOR_ALREADY_ATTACHED'
  | 'NO_EDITOR_ATTACHED'
  | 'EDITOR_TIMEOUT'
  | 'DOC_NOT_FOUND'
  | 'DOCS_UNAVAILABLE'
  | 'SHUTTING_DOWN'
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "JsonRpcResponse".
 */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse
/**
 * A startup failure name. Hosts must retain unknown names and show the accompanying message.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "StartupErrorCode".
 */
export type StartupErrorCode =
  | 'BAD_ARGUMENTS'
  | 'RUNTIME_DIR_UNSAFE'
  | 'SOCKET_PATH_TOO_LONG'
  | 'SESSION_ALREADY_RUNNING'
  | 'TOKEN_FILE_UNSAFE'
  | 'LISTEN_FAILED'
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ReadyLine".
 */
export type ReadyLine = ReadyLineOk | ReadyLineError
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "CommandResult".
 */
export type CommandResult = SuccessResult | ErrorResult
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EvaluationSource".
 */
export type EvaluationSource = 'human' | 'agent'
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EvalId".
 */
export type EvalId = string
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "AudioDevicesResult".
 */
export type AudioDevicesResult =
  | {
      ok: true
      devices: AudioDeviceInfo[]
    }
  | ErrorResult
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "AnalyzeAudioResult".
 */
export type AnalyzeAudioResult =
  | {
      ok: true
      analysis: WavAnalysis
    }
  | ErrorResult
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "SavePluginStateResult".
 */
export type SavePluginStateResult =
  | {
      ok: true
      saved: unknown
    }
  | DetailedErrorResult
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "PluginUiResult".
 */
export type PluginUiResult =
  | {
      ok: true
      result: unknown
    }
  | DetailedErrorResult
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "PluginUiAtCursorResult".
 */
export type PluginUiAtCursorResult =
  | {
      ok: true
      receiver: string
      index: number
      chain_path: number[]
      normalizedName: string
      site: Range
    }
  | DetailedErrorResult
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ListPluginsResult".
 */
export type ListPluginsResult =
  | {
      ok: true
      plugins: PluginCatalogEntry[]
    }
  | ErrorResult
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "RescanPluginsResult".
 */
export type RescanPluginsResult =
  | {
      ok: true
      count: number
      artifactCount: number
      skipped: string[]
      failures: PluginScanFailure[]
      summary: PluginScanSummary
    }
  | ErrorResult
/**
 * LSP diagnostic tags, represented by stable names on the wire.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DiagnosticTag".
 */
export type DiagnosticTag = 'unnecessary' | 'deprecated'
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "FlashConfigResult".
 */
export type FlashConfigResult =
  | {
      ok: true
      config: FlashConfig
    }
  | ErrorResult
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DocsSite".
 */
export type DocsSite = 'user' | 'dev'
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "LogLevel".
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "LogKind".
 */
export type LogKind = 'diagnostic' | 'engine' | 'daemon' | 'stall' | 'session'

/**
 * OrbitScore session protocol v1: JSON-RPC 2.0 over WebSocket (/rpc). One text frame carries one message. Design: docs/design/848-native-orbitstudio-design.md section 5. This file is the single source of truth; protocol/gen/ is generated from it (npm run protocol:generate).
 */
export interface OrbitScoreSessionProtocol {
  [k: string]: unknown | undefined
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EmptyObject".
 */
export interface EmptyObject {}
/**
 * 0-based line and UTF-16 character offset (LSP).
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "Position".
 */
export interface Position {
  line: number
  character: number
}
/**
 * LSP range; end is exclusive.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "Range".
 */
export interface Range {
  start: Position
  end: Position
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ClientInfo".
 */
export interface ClientInfo {
  name: string
  version: string
}
/**
 * A single JSON-RPC request. Batch arrays are rejected as INVALID_REQUEST.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "JsonRpcRequest".
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: {}
}
/**
 * A single JSON-RPC notification. It has no id and never receives a response.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "JsonRpcNotification".
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: {}
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "JsonRpcSuccessResponse".
 */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result: unknown
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "JsonRpcError".
 */
export interface JsonRpcError {
  code: number
  message: string
  data?: ErrorData
}
/**
 * The data member of a JSON-RPC error object. code is a symbolic key of x-errors; its numeric peer is authoritative.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ErrorData".
 */
export interface ErrorData {
  code: ErrorName
  detail?: string
}
/**
 * id is null only when no request id can be recovered (PARSE_ERROR or INVALID_REQUEST).
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "JsonRpcErrorResponse".
 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: string | number | null
  error: JsonRpcError
}
/**
 * The only stdout line emitted when the session has bound its listeners.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ReadyLineOk".
 */
export interface ReadyLineOk {
  ready: true
  socket: AbsolutePath
  protocol_version: ProtocolVersion
  port: number | null
  token: string | null
}
/**
 * The single stderr line emitted when session startup fails; it never contains a secret.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ReadyLineError".
 */
export interface ReadyLineError {
  ready: false
  error: {
    code: StartupErrorCode
    message: string
  }
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "SuccessResult".
 */
export interface SuccessResult {
  ok: true
  message?: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ErrorResult".
 */
export interface ErrorResult {
  ok: false
  error: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DetailedErrorResult".
 */
export interface DetailedErrorResult {
  ok: false
  error: string
  code?: string
  details?: unknown
}
/**
 * Handshake sent first by the server. The protocol_version property keeps this name and ProtocolVersion shape in every MAJOR.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "HelloParams".
 */
export interface HelloParams {
  protocol_version: ProtocolVersion
  session_version: string
  capabilities: string[]
}
/**
 * Handshake request sent first by the client. The protocol_version property keeps this name and ProtocolVersion shape in every MAJOR; a different MAJOR is rejected with PROTOCOL_VERSION_MISMATCH.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "AttachParams".
 */
export interface AttachParams {
  protocol_version: ProtocolVersion
  /**
   * Required on the TCP listener (WebView only). Secret: never log it.
   */
  token?: string
  client: ClientInfo
  capabilities: ClientCapability[]
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "AttachResult".
 */
export interface AttachResult {
  clientId: string
}
/**
 * Which document and range this evaluation came from. v1 uses it for attribution only; code stays the text that is evaluated.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EvaluateTarget".
 */
export interface EvaluateTarget {
  uri: DocumentUri
  /**
   * The editor.didChange version the range refers to. Required with range.
   */
  version?: number
  range?: Range
}
/**
 * Extra attributes for the session log frame (.orbslog).
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EvaluateFrame".
 */
export interface EvaluateFrame {
  [k: string]: (string | number | boolean | null) | undefined
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EvaluateParams".
 */
export interface EvaluateParams {
  code: string
  /**
   * Required on every call. null = no base (clears the previous base).
   */
  documentDirectory: AbsolutePath | null
  source: EvaluationSource
  target?: EvaluateTarget
  frame?: EvaluateFrame
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EvaluateDiagnostic".
 */
export interface EvaluateDiagnostic {
  kind: 'parse' | 'runtime'
  message: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EvaluateResult".
 */
export interface EvaluateResult {
  /**
   * true only when diagnostics is empty.
   */
  ok: boolean
  evalId: EvalId
  diagnostics: EvaluateDiagnostic[]
  /**
   * The value that was actually used.
   */
  documentDirectory: AbsolutePath | null
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "SyncedDocument".
 */
export interface SyncedDocument {
  uri: DocumentUri
  version: number
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "SessionState".
 */
export interface SessionState {
  protocolVersion: ProtocolVersion
  engine: EngineState
  transport: TransportState
  documents: SyncedDocument[]
  activeUri: DocumentUri | null
  /**
   * --workspace-root, or null when it was not given.
   */
  workspaceRoot: AbsolutePath | null
  editorAttached: boolean
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EngineState".
 */
export interface EngineState {
  running: boolean
  liveCoding: boolean
  output?: {}
  callback?: {}
  statusError?: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "TransportState".
 */
export interface TransportState {
  playing: boolean
  tempo?: number
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "GetLogParams".
 */
export interface GetLogParams {
  /**
   * Trailing lines to return (default 50, capped at the ring capacity).
   */
  lines?: number
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "GetLogResult".
 */
export interface GetLogResult {
  lines: string[]
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "RegisterMcpParams".
 */
export interface RegisterMcpParams {
  /**
   * user (default) or project.
   */
  scope: string
  /**
   * Accepted for the v1 MCP tool shape and not used (the relay finds the session by its socket).
   */
  port?: number
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "StartEngineParams".
 */
export interface StartEngineParams {
  captureWav?: AbsolutePath
  audioDevice?: string
  debug?: boolean
  /**
   * Defaults to the session's --host-bundle-id (the app's own bundle id).
   */
  hostBundleId?: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "SelectDeviceParams".
 */
export interface SelectDeviceParams {
  /**
   * Empty = the system default.
   */
  device: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "AudioDeviceInfo".
 */
export interface AudioDeviceInfo {
  label: string
  id: number
  description: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "AnalyzeAudioParams".
 */
export interface AnalyzeAudioParams {
  wavPath: AbsolutePath
  windowMs?: number
  perChannel?: boolean
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "WavFormat".
 */
export interface WavFormat {
  audioFormat: number
  channels: number
  sampleRate: number
  bitsPerSample: number
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "AudioWindow".
 */
export interface AudioWindow {
  startSec: number
  peak: number
  rms: number
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "WavAnalysis".
 */
export interface WavAnalysis {
  format: WavFormat
  frames: number
  durationSec: number
  peak: number
  rms: number
  onsets: number[]
  onsetGaps: number[]
  soundDetected: boolean
  windows?: AudioWindow[]
  channelWindows?: AudioWindow[][]
  channelRms?: number[]
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "PluginTarget".
 */
export interface PluginTarget {
  receiver: string
  index: number
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "OpenPluginUiParams".
 */
export interface OpenPluginUiParams {
  receiver: string
  index: number
  expectedName?: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "PluginCatalogEntry".
 */
export interface PluginCatalogEntry {
  name: string
  vendor: string
  format: string
  path: string
  pluginId: string
  roles: string[]
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "PluginScanFailure".
 */
export interface PluginScanFailure {
  path: string
  code: string
  message: string
  hostArch?: string
  slices?: string[]
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "ScanDuration".
 */
export interface ScanDuration {
  p50: number | null
  p95: number | null
  max: number | null
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "PluginScanSummary".
 */
export interface PluginScanSummary {
  success: number
  pending: number
  failure: number
  failureReasons: {
    [k: string]: number | undefined
  }
  durationMs: ScanDuration
  timeouts: number
  crashes: number
  factoryVersions: {
    [k: string]: number | undefined
  }
  cacheHits: number
  probeAttempts: number
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DidOpenParams".
 */
export interface DidOpenParams {
  uri: DocumentUri
  version: number
  text: string
  /**
   * Where the document lives. A record, not the evaluation base.
   */
  documentDirectory: AbsolutePath | null
}
/**
 * LSP TextDocumentContentChangeEvent: a range replacement, or the full text when range is absent.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "TextChange".
 */
export interface TextChange {
  range?: Range
  text: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DidChangeParams".
 */
export interface DidChangeParams {
  uri: DocumentUri
  version: number
  changes: TextChange[]
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DidCloseParams".
 */
export interface DidCloseParams {
  uri: DocumentUri
}
/**
 * The range and optional caret use 0-based LSP coordinates. cursor is the active end and defaults to range.end.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DidChangeSelectionParams".
 */
export interface DidChangeSelectionParams {
  uri: DocumentUri
  range: Range
  cursor?: Position
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DidChangeActiveParams".
 */
export interface DidChangeActiveParams {
  uri: DocumentUri | null
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "CompleteParams".
 */
export interface CompleteParams {
  uri: DocumentUri
  position: Position
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "CompletionItem".
 */
export interface CompletionItem {
  label: string
  kind?: string
  detail?: string
  documentation?: string
  insertText?: string
  sortText?: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "CompleteResult".
 */
export interface CompleteResult {
  items: CompletionItem[]
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "GetDiagnosticsParams".
 */
export interface GetDiagnosticsParams {
  uri?: DocumentUri
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "Diagnostic".
 */
export interface Diagnostic {
  range: Range
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  code?: string | number
  source?: string
  tags?: DiagnosticTag[]
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "GetDiagnosticsResult".
 */
export interface GetDiagnosticsResult {
  files: EditorDiagnosticsParams[]
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EditorDiagnosticsParams".
 */
export interface EditorDiagnosticsParams {
  uri: DocumentUri
  version: number
  items: Diagnostic[]
}
/**
 * The MCP get_editor_state shape. Fields are null when no document is active.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EditorState".
 */
export interface EditorState {
  path: string | null
  languageId: string | null
  cursor: Position | null
  selection: Range | null
  lineCount: number | null
  isDirty: boolean | null
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DocumentText".
 */
export interface DocumentText {
  path: string | null
  text: string | null
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "OpenFileParams".
 */
export interface OpenFileParams {
  path: AbsolutePath
}
/**
 * What the editor client returns for editor.runSelection: where its selection is. Layer 2 reads the text from its synced copy at that version.
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "SelectionSnapshot".
 */
export interface SelectionSnapshot {
  uri: DocumentUri
  version: number
  range: Range
  documentDirectory: AbsolutePath | null
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "EditReplaceParams".
 */
export interface EditReplaceParams {
  find: string
  replace: string
  all?: boolean
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "FlashConfigInput".
 */
export interface FlashConfigInput {
  count?: number
  duration?: number
  color?: string
  customColor?: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "FlashConfig".
 */
export interface FlashConfig {
  count: number
  duration: number
  color: string
  customColor: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DocsGetParams".
 */
export interface DocsGetParams {
  site: DocsSite
  path: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DocsGetResult".
 */
export interface DocsGetResult {
  text: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DocsSearchParams".
 */
export interface DocsSearchParams {
  site: DocsSite
  query: string
  /**
   * Default 10. Fractions are truncated and negatives become 0.
   */
  limit?: number
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DocsSearchMatch".
 */
export interface DocsSearchMatch {
  path: string
  line: number
  excerpt: string
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "DocsSearchResult".
 */
export interface DocsSearchResult {
  matches: DocsSearchMatch[]
}
/**
 * Where the sounding call is, in the coordinates of the evalId request's code (0-based, UTF-16, end exclusive).
 *
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "StepSource".
 */
export interface StepSource {
  evalId: EvalId
  start: Position
  end: Position
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "TransportStepParams".
 */
export interface TransportStepParams {
  seq: string
  argPath: string
  atEpochMs: number
  /**
   * Omitted or null = outside a document (MCP evaluation, an imported file, or not yet known).
   */
  source?: StepSource | null
}
/**
 * This interface was referenced by `OrbitScoreSessionProtocol`'s JSON-Schema
 * via the `definition` "LogLineParams".
 */
export interface LogLineParams {
  level: LogLevel
  kind: LogKind
  text: string
  /**
   * Epoch milliseconds.
   */
  ts: number
  clientId?: string
  evalId?: EvalId
}

/** JSON-RPC error numbers (the declaration-file equivalent of an `as const` object). */
export declare const ErrorCodes: {
  readonly PARSE_ERROR: -32700
  readonly INVALID_REQUEST: -32600
  readonly METHOD_NOT_FOUND: -32601
  readonly INVALID_PARAMS: -32602
  readonly INTERNAL_ERROR: -32603
  readonly PROTOCOL_VERSION_MISMATCH: -32010
  readonly EDITOR_ALREADY_ATTACHED: -32011
  readonly NO_EDITOR_ATTACHED: -32012
  readonly EDITOR_TIMEOUT: -32013
  readonly DOC_NOT_FOUND: -32020
  readonly DOCS_UNAVAILABLE: -32021
  readonly SHUTTING_DOWN: -32030
}

/** Requests any attached client sends to layer 2 (method name → params / result). */
export interface ClientRequests {
  'session.attach': { params: AttachParams; result: AttachResult }
  'session.evaluate': { params: EvaluateParams; result: EvaluateResult }
  'session.getState': { params: EmptyObject; result: SessionState }
  'session.getLog': { params: GetLogParams; result: GetLogResult }
  'session.registerMcp': { params: RegisterMcpParams; result: CommandResult }
  'session.shutdown': { params: EmptyObject; result: EmptyObject }
  'engine.start': { params: StartEngineParams; result: CommandResult }
  'engine.stop': { params: EmptyObject; result: CommandResult }
  'engine.getState': { params: EmptyObject; result: EngineState }
  'audio.listDevices': { params: EmptyObject; result: AudioDevicesResult }
  'audio.selectDevice': { params: SelectDeviceParams; result: CommandResult }
  'audio.analyze': { params: AnalyzeAudioParams; result: AnalyzeAudioResult }
  'plugin.saveState': { params: PluginTarget; result: SavePluginStateResult }
  'plugin.openUi': { params: OpenPluginUiParams; result: PluginUiResult }
  'plugin.closeUi': { params: PluginTarget; result: PluginUiResult }
  'plugin.openUiAtCursor': { params: EmptyObject; result: PluginUiAtCursorResult }
  'plugin.list': { params: EmptyObject; result: ListPluginsResult }
  'plugin.rescan': { params: EmptyObject; result: RescanPluginsResult }
  'editor.complete': { params: CompleteParams; result: CompleteResult }
  'editor.getDiagnostics': { params: GetDiagnosticsParams; result: GetDiagnosticsResult }
  'editor.getState': { params: EmptyObject; result: EditorState }
  'editor.getDocumentText': { params: EmptyObject; result: DocumentText }
  'editor.openFile': { params: OpenFileParams; result: CommandResult }
  'editor.setSelection': { params: Range; result: CommandResult }
  'editor.runSelection': { params: EmptyObject; result: CommandResult }
  'editor.editReplace': { params: EditReplaceParams; result: CommandResult }
  'editor.saveFile': { params: EmptyObject; result: CommandResult }
  'editor.configureFlash': { params: FlashConfigInput; result: FlashConfigResult }
  'docs.get': { params: DocsGetParams; result: DocsGetResult }
  'docs.search': { params: DocsSearchParams; result: DocsSearchResult }
}

/** Notifications the editor client sends to layer 2. */
export interface ClientNotifications {
  'editor.didOpen': DidOpenParams
  'editor.didChange': DidChangeParams
  'editor.didClose': DidCloseParams
  'editor.didChangeSelection': DidChangeSelectionParams
  'editor.didChangeActive': DidChangeActiveParams
}

/** Notifications layer 2 sends to clients. */
export interface ServerNotifications {
  'session.hello': HelloParams
  'engine.state': EngineState
  'editor.diagnostics': EditorDiagnosticsParams
  'transport.step': TransportStepParams
  'transport.state': TransportState
  'log.line': LogLineParams
}

/** Requests layer 2 sends to the attached editor client (the x-editor-request leg of a client request). */
export interface EditorRequests {
  'editor.openFile': { params: OpenFileParams; result: CommandResult }
  'editor.setSelection': { params: Range; result: CommandResult }
  'editor.runSelection': { params: EmptyObject; result: SelectionSnapshot }
  'editor.editReplace': { params: EditReplaceParams; result: CommandResult }
  'editor.saveFile': { params: EmptyObject; result: CommandResult }
  'editor.configureFlash': { params: FlashConfigInput; result: FlashConfigResult }
}
