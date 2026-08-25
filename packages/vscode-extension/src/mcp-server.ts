import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'

import type { PluginScanFailure, PluginScanSummary } from './plugin-catalog-reader'
import type { WavAnalysis } from './wav-analysis'

/**
 * OrbitScore MCP control server — the "Agent Bridge" of WCTM_SYSTEM_SPEC §3.
 *
 * Hosts an MCP server (Streamable HTTP) inside the extension host so an external
 * agent (e.g. Claude Code via `.mcp.json`) can drive OrbitScore operations for
 * E2E testing. The same tool surface is intended for reuse by the WCTM
 * performance runtime (pi harness — spec §4.2 "Bridge は harness-neutral").
 *
 * Only started when `orbitscore.mcpServer.port` is a nonzero port (see
 * extension.ts activate()). Binds 127.0.0.1 only.
 *
 * ── SDK loading ──
 * `@modelcontextprotocol/sdk` is an exports-only dual (ESM/CJS) package. This
 * extension compiles with `moduleResolution: "node"` (node10), which cannot
 * resolve the SDK's subpath exports for a static `import`. We therefore load it
 * via runtime `require` — the same idiom this extension already uses for engine
 * modules — which resolves to the CJS build through the package "exports" map.
 * The local interfaces below mirror `@modelcontextprotocol/sdk@1.29.0`
 * (verified against dist/esm/server/*.d.ts, 2026-07-07).
 */

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

interface McpServerLike {
  registerTool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: Record<string, unknown> },
    cb: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): unknown
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
}

interface TransportLike {
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse, body?: unknown): Promise<void>
  close(): Promise<void>
  sessionId?: string
  onclose?: () => void
}

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js') as {
  McpServer: new (info: { name: string; version: string }) => McpServerLike
}
const { StreamableHTTPServerTransport } =
  require('@modelcontextprotocol/sdk/server/streamableHttp.js') as {
    StreamableHTTPServerTransport: new (opts: {
      sessionIdGenerator?: (() => string) | undefined
      enableJsonResponse?: boolean
      onsessioninitialized?: (sessionId: string) => void | Promise<void>
      onsessionclosed?: (sessionId: string) => void | Promise<void>
    }) => TransportLike
  }
interface ZodTypeLike {
  describe(description: string): ZodTypeLike
  optional(): unknown
}
const { z } = require('zod') as {
  z: { string: () => ZodTypeLike; number: () => ZodTypeLike; boolean: () => ZodTypeLike }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

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
}

/** One SuperCollider-reported audio device (list_audio_devices / select_audio_device). */
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
  getEngineState(): EngineState
  forceKillScsynth(): Promise<CommandResult> | CommandResult
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
  analyzeAudio(wavPath: string, windowMs?: number): Promise<AnalyzeAudioResult> | AnalyzeAudioResult
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

/** The single error-envelope shape for every tool (change here, not per tool). */
function errorResult(error: string): ToolResult {
  return { content: [{ type: 'text', text: `error: ${error}` }], isError: true }
}

function toToolResult(result: CommandResult): ToolResult {
  if (result.ok) {
    return { content: [{ type: 'text', text: result.message ?? 'ok' }] }
  }
  return errorResult(result.error)
}

export interface McpServerHandle {
  readonly port: number
  dispose(): Promise<void>
}

/**
 * Public URL prefix the built dev site is served under. Must equal SITE_BASE in
 * sites/dev/.vitepress/config.ts (minus the trailing slash): the dist's asset and
 * navigation URLs are absolute under that base, so serving at any other prefix
 * breaks every asset request.
 */
export const DOCS_PUBLIC_BASE = '/orbitscore/dev'

/**
 * Public URL prefix for the END-USER learning site (sites/user — VitePress base
 * `/orbitscore/`). The dev base above lives INSIDE this prefix, so routing must
 * check the dev prefix first (longest-prefix wins); asset URLs never collide
 * (`/orbitscore/assets/...` vs `/orbitscore/dev/assets/...`).
 */
export const USER_DOCS_PUBLIC_BASE = '/orbitscore'

/** Resolve the built VitePress site from a repository/workspace base directory. */
export function resolveDocsRoot(baseDir: string): string {
  return path.resolve(baseDir, 'sites/dev/.vitepress/dist')
}

/** Resolve the built end-user site from a repository/workspace base directory. */
export function resolveUserDocsRoot(baseDir: string): string {
  return path.resolve(baseDir, 'sites/user/.vitepress/dist')
}

/**
 * Resolve a docs-relative URL path without allowing it to escape docsRoot.
 * Directory URLs (including the root URL) serve their index.html.
 */
export function resolveDocsFilePath(docsRoot: string, urlPath: string): string | null {
  return resolveSafePath(docsRoot, urlPath, (decodedPath, relativePath) =>
    decodedPath.endsWith('/') || !path.extname(relativePath)
      ? path.join(relativePath, 'index.html')
      : relativePath,
  )
}

/**
 * Shared traversal guard for every docs path lookup: decode → reject `..`/`\` →
 * resolve against root → containment check. This is the security boundary for the
 * locally-bound HTTP server and the MCP doc tools — keep it single-sourced so a
 * future tightening applies everywhere at once. `mapTarget` lets callers layer
 * their own URL→file mapping (e.g. directory → index.html) on the decoded path
 * before resolution; the containment check always runs on the mapped result.
 */
function resolveSafePath(
  root: string,
  rawPath: string,
  mapTarget: (decodedPath: string, relativePath: string) => string = (_, relativePath) =>
    relativePath,
): string | null {
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (decodedPath.includes('\\') || decodedPath.includes('..')) {
    return null
  }
  const relativePath = decodedPath.replace(/^\/+/, '')
  const filePath = path.resolve(root, mapTarget(decodedPath, relativePath))
  const normalizedRoot = path.resolve(root)
  if (filePath !== normalizedRoot && !filePath.startsWith(`${normalizedRoot}${path.sep}`)) {
    return null
  }
  return filePath
}

function resolvePathWithinRoot(root: string, relativePath: string): string | null {
  if (!relativePath) return null
  const filePath = resolveSafePath(root, relativePath)
  // The bare root is a valid *directory* answer for the docs file server (mapped to
  // index.html) but never a valid document path for readDevDoc/searchDevDocs.
  return filePath !== null && filePath !== path.resolve(root) ? filePath : null
}

export function readDevDoc(sourceRoot: string, relativePath: string): string | null {
  const filePath = resolvePathWithinRoot(sourceRoot, relativePath)
  if (!filePath || path.extname(filePath) !== '.md' || !fs.existsSync(filePath)) {
    return null
  }
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    // TOCTOU: the file could vanish (docs rebuild) between existsSync and read.
    return null
  }
}

export interface DevDocSearchMatch {
  path: string
  line: number
  excerpt: string
}

export function searchDevDocs(sourceRoot: string, query: string, limit = 10): DevDocSearchMatch[] {
  if (!query) return []
  const matches: DevDocSearchMatch[] = []
  const needle = query.toLowerCase()
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.vitepress' || entry.name === 'node_modules') continue
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(entryPath)
      } else if (entry.isFile() && path.extname(entry.name) === '.md') {
        let lines: string[]
        try {
          lines = fs.readFileSync(entryPath, 'utf8').split(/\r?\n/)
        } catch {
          // Skip a file that becomes unreadable mid-walk rather than aborting the search.
          continue
        }
        for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
          if (lines[index].toLowerCase().includes(needle)) {
            matches.push({
              path: path.relative(sourceRoot, entryPath).split(path.sep).join('/'),
              line: index + 1,
              excerpt: lines[index].trim(),
            })
          }
        }
      }
      if (matches.length >= limit) return
    }
  }
  if (fs.existsSync(sourceRoot)) walk(sourceRoot)
  return matches
}

function contentTypeForDocsFile(filePath: string): string {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  }
  return types[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** 配信対象サイト（dev / user）のルーティング候補。 */
interface DocsSite {
  base: string
  root: string
  buildHint: string
}

/** pathname が候補のどのサイトに属すか（配列順 = 優先順・最長プレフィックスを先に置く）。 */
export function matchDocsRequest(pathname: string, sites: DocsSite[]): DocsSite | null {
  for (const site of sites) {
    if (pathname === site.base || pathname.startsWith(`${site.base}/`)) return site
  }
  return null
}

/**
 * dist が「存在するが base 不一致の stale ビルド」でないか検査する（#480）。
 * VitePress は SITE_BASE をアセット URL に焼き込むため、base 変更前の古い dist を
 * 配信すると全アセットが 404 になり素 HTML が出る（実害 2026-07-17）。index.html に
 * `base + '/assets/'` への参照が含まれることを鮮度の代理指標とし、不一致なら
 * 未ビルト時と同じ actionable メッセージ（rebuild 手順）に落とす。結果は
 * index.html の mtime でキャッシュ（リクエスト毎の同期 read を避ける）。
 */
export function isDocsDistStale(root: string, base: string): boolean {
  const indexPath = path.join(root, 'index.html')
  try {
    const mtime = fs.statSync(indexPath).mtimeMs
    const cached = staleCheckCache.get(indexPath)
    if (cached && cached.mtime === mtime) return cached.stale
    const html = fs.readFileSync(indexPath, 'utf8')
    const stale = !html.includes(`${base}/assets/`)
    staleCheckCache.set(indexPath, { mtime, stale })
    return stale
  } catch {
    // index.html が読めない = 未ビルト相当。呼び出し側の existsSync ガードに任せる。
    return false
  }
}
const staleCheckCache = new Map<string, { mtime: number; stale: boolean }>()

/**
 * Build a per-session McpServer with the OrbitScore tool surface registered.
 * One instance per MCP session (see `startOrbitScoreMcpServer` for routing).
 */
function buildServer(
  version: string,
  handlers: OrbitScoreToolHandlers,
  docsRoot: string,
): McpServerLike {
  const server = new McpServer({ name: 'orbitscore', version })
  const docsSourceRoot = path.resolve(docsRoot, '../..')

  server.registerTool(
    'evaluate_orbitscore',
    {
      title: 'Evaluate OrbitScore',
      description:
        'Send OrbitScore (.orbs) source to the running engine live-coding session — ' +
        'the equivalent of "Run Selection" in the editor. The engine must be started ' +
        'first (via the Start Engine command). Waits for the engine to finish evaluating ' +
        'the submitted code and reports the result: ok only when the engine raised no parse ' +
        'or runtime diagnostics. A failure lists the diagnostics, so you do NOT need to poll ' +
        'get_log to find out whether your score was accepted.',
      inputSchema: { code: z.string().describe('OrbitScore source to evaluate') },
    },
    async (args) => {
      const code = typeof args.code === 'string' ? args.code : ''
      return toToolResult(await handlers.evaluate(code))
    },
  )

  server.registerTool(
    'start_engine',
    {
      title: 'Start Engine',
      description:
        'Start the OrbitScore audio engine (the native Rust daemon). Equivalent to ' +
        'the "Start Engine" command. Must be called before evaluate_orbitscore. ' +
        'Pass capture_wav to record the master output to a WAV file (capture seam) ' +
        'so the produced audio can be verified without listening. Pass debug: true ' +
        'for the "Start Engine (Debug)" command variant (verbose engine logging).',
      inputSchema: {
        capture_wav: z
          .string()
          .describe('Absolute path to write a whole-stream WAV capture of the master output')
          .optional(),
        debug: z
          .boolean()
          .describe('Start in debug mode, equivalent to "Start Engine (Debug)"')
          .optional(),
      },
    },
    async (args) => {
      const captureWav = typeof args.capture_wav === 'string' ? args.capture_wav : undefined
      const debug = args.debug === true
      const options = captureWav || debug ? { captureWav, debug } : undefined
      return toToolResult(await handlers.startEngine(options))
    },
  )

  server.registerTool(
    'stop_engine',
    {
      title: 'Stop Engine',
      description: 'Stop the OrbitScore audio engine. Equivalent to the "Stop Engine" command.',
    },
    async () => toToolResult(await handlers.stopEngine()),
  )

  server.registerTool(
    'get_engine_state',
    {
      title: 'Get Engine State',
      description: 'Report whether the OrbitScore engine process is currently running.',
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(handlers.getEngineState()) }] }),
  )

  server.registerTool(
    'force_kill_scsynth',
    {
      title: 'Force Kill scsynth',
      description:
        'Force-kill any stray scsynth processes (killall scsynth). Equivalent to the ' +
        '"Force Kill scsynth" command — an escape hatch for orphaned processes, not ' +
        'part of normal start/stop.',
    },
    async () => toToolResult(await handlers.forceKillScsynth()),
  )

  server.registerTool(
    'list_audio_devices',
    {
      title: 'List Audio Devices',
      description:
        'List audio output devices detected via SuperCollider — the same device list ' +
        'shown by "Select Audio Device". Not implemented for the Rust engine ' +
        '(orbitscore.engine: "rust"); returns an error explaining that the system ' +
        'default output is used instead.',
    },
    async () => {
      const result = await handlers.listAudioDevices()
      if (!result.ok) {
        return errorResult(result.error)
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.devices) }] }
    },
  )

  server.registerTool(
    'select_audio_device',
    {
      title: 'Select Audio Device',
      description:
        'Select the audio output device. For the SuperCollider backend, writes to ' +
        '.orbitscore.json (restart the engine to apply). For the Rust engine (default), ' +
        'selects a device and powers on the engine if it is off, switches live if it is ' +
        'already running, and deselects/stops when the selected device is submitted again. ' +
        'The choice is persisted to "orbitscore.audioDevice".',
      inputSchema: {
        device: z.string().describe('Device name as reported by list_audio_devices'),
      },
    },
    async (args) => {
      const device = typeof args.device === 'string' ? args.device : ''
      return toToolResult(await handlers.selectAudioDevice(device))
    },
  )

  server.registerTool(
    'configure_flash',
    {
      title: 'Configure Flash',
      description:
        'Set the "Run Selection" flash feedback settings (count, duration, color, ' +
        'custom_color) — equivalent to "Configure Flash" in the command palette. ' +
        'Only provided fields are changed; omitted fields keep their current value. ' +
        'Returns the resulting effective configuration.',
      inputSchema: {
        count: z.number().describe('Number of flashes (1-5)').optional(),
        duration: z.number().describe('Duration of each flash in milliseconds (50-500)').optional(),
        color: z
          .string()
          .describe('Flash color theme: selection | error | warning | info | custom')
          .optional(),
        custom_color: z
          .string()
          .describe('Custom flash color in hex format, e.g. #ff6b6b (used when color: "custom")')
          .optional(),
      },
    },
    async (args) => {
      const result = await handlers.configureFlash({
        count: typeof args.count === 'number' ? args.count : undefined,
        duration: typeof args.duration === 'number' ? args.duration : undefined,
        color: typeof args.color === 'string' ? args.color : undefined,
        customColor: typeof args.custom_color === 'string' ? args.custom_color : undefined,
      })
      if (!result.ok) {
        return errorResult(result.error)
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.config) }] }
    },
  )

  server.registerTool(
    'open_file',
    {
      title: 'Open File',
      description:
        'Open a file in the editor (vscode.workspace.openTextDocument + ' +
        'showTextDocument). Required before set_selection, run_selection, ' +
        'edit_replace, or get_editor_state can target it.',
      inputSchema: {
        path: z.string().describe('Absolute or workspace-relative path to the file to open'),
      },
    },
    async (args) => {
      const filePath = typeof args.path === 'string' ? args.path : ''
      return toToolResult(await handlers.openFile(filePath))
    },
  )

  server.registerTool(
    'set_selection',
    {
      title: 'Set Selection',
      description:
        "Set the active editor's selection/cursor by line and character (1-based, " +
        'matching the editor gutter). Reveals the range. Omit end_line and end_char ' +
        'to collapse the selection to a cursor at the start position.',
      inputSchema: {
        start_line: z.number().describe('1-based start line'),
        start_char: z.number().describe('1-based start character (column). Default: 1').optional(),
        end_line: z
          .number()
          .describe(
            '1-based end line. Omit together with end_char to collapse to a cursor at start',
          )
          .optional(),
        end_char: z
          .number()
          .describe('1-based end character (column). Default: 1 when end_line is given')
          .optional(),
      },
    },
    async (args) => {
      const startLine = typeof args.start_line === 'number' ? args.start_line : NaN
      if (!Number.isFinite(startLine)) {
        return errorResult('start_line is required')
      }
      return toToolResult(
        handlers.setSelection({
          startLine,
          startChar: typeof args.start_char === 'number' ? args.start_char : undefined,
          endLine: typeof args.end_line === 'number' ? args.end_line : undefined,
          endChar: typeof args.end_char === 'number' ? args.end_char : undefined,
        }),
      )
    },
  )

  server.registerTool(
    'run_selection',
    {
      title: 'Run Selection',
      description:
        "Execute the active editor's current selection (or the subject-block under " +
        'the cursor) against the running engine — the real "Run Selection" command ' +
        '(Cmd+Enter), including subject-block collection, setDocumentDirectory ' +
        'injection, and the flash animation. The engine must already be running ' +
        '(start_engine) and the active editor must be an OrbitScore (.orbs) file.',
    },
    async () => toToolResult(await handlers.runSelection()),
  )

  server.registerTool(
    'edit_replace',
    {
      title: 'Edit Replace',
      description:
        'Literal (non-regex) find/replace in the active document. Replaces the ' +
        'first occurrence by default; pass all: true to replace every occurrence. ' +
        'Returns the number of occurrences replaced.',
      inputSchema: {
        find: z.string().describe('Literal text to search for'),
        replace: z.string().describe('Replacement text'),
        all: z
          .boolean()
          .describe('Replace every occurrence instead of only the first. Default: false')
          .optional(),
      },
    },
    async (args) => {
      const find = typeof args.find === 'string' ? args.find : ''
      const replace = typeof args.replace === 'string' ? args.replace : ''
      const all = args.all === true
      return toToolResult(await handlers.editReplace({ find, replace, all }))
    },
  )

  server.registerTool(
    'get_editor_state',
    {
      title: 'Get Editor State',
      description:
        'Report the active editor: file path, language, cursor position, selection ' +
        'range (all 1-based), line count, and dirty state. Fields are null when no ' +
        'editor is active.',
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(handlers.getEditorState()) }] }),
  )

  server.registerTool(
    'save_file',
    {
      title: 'Save File',
      description:
        'Save the active document to disk (document.save()). edit_replace only ' +
        'rewrites the in-memory editor buffer — it does not persist to disk (auto-save ' +
        'is off) — so use save_file to persist the state played during a live session ' +
        'or the result of an edit. A no-op (returns ok) when the document has no ' +
        'unsaved changes.',
    },
    async () => toToolResult(await handlers.saveFile()),
  )

  server.registerTool(
    'get_document_text',
    {
      title: 'Get Document Text',
      description:
        'Return the full text of the active document. get_editor_state only reports ' +
        'metadata (path, language, cursor, selection, line count, dirty state) — use ' +
        'get_document_text to confirm an edit_replace was applied or to diff the ' +
        'buffer against the file on disk. path and text are both null when no editor ' +
        'is active.',
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(handlers.getDocumentText()) }] }),
  )

  server.registerTool(
    'get_diagnostics',
    {
      title: 'Get Diagnostics',
      description:
        'Report OrbitScore diagnostics (errors/warnings) currently shown by the ' +
        'editor (vscode.languages.getDiagnostics) — computed by the same analyzers ' +
        'that run on open/edit, so no need to trigger an edit first. Pass path to ' +
        'scope to one file; omit to list every file that currently has diagnostics.',
      inputSchema: {
        path: z.string().describe('Absolute path to scope diagnostics to a single file').optional(),
      },
    },
    async (args) => {
      const filePath = typeof args.path === 'string' ? args.path : undefined
      return {
        content: [{ type: 'text', text: JSON.stringify(handlers.getDiagnostics(filePath)) }],
      }
    },
  )

  server.registerTool(
    'get_log',
    {
      title: 'Get Log',
      description:
        'Return the last N lines of the OrbitScore output channel (engine ' +
        'stdout/stderr, MCP session log, etc.) — the same content as "OrbitScore" ' +
        'in the Output panel. Default 50 lines, capped at the ring buffer capacity (1000). ' +
        'If more lines are requested than the buffer holds, the first returned line is an ' +
        'explicit "[get_log] truncated: ..." notice — the request is never silently shortened.',
      inputSchema: {
        lines: z
          .number()
          .describe('Number of trailing lines to return (default 50, capped at 1000)')
          .optional(),
      },
    },
    async (args) => {
      const lines = typeof args.lines === 'number' ? args.lines : undefined
      return { content: [{ type: 'text', text: handlers.getLog(lines).join('\n') }] }
    },
  )

  const savePluginState = handlers.savePluginState?.bind(handlers)
  if (savePluginState) {
    server.registerTool(
      'save_plugin_state',
      {
        title: 'Save Plugin State',
        description:
          'Save the current state of a running plugin into the project states directory and ' +
          'register it in project.yaml. Address the current chain with receiver and index ' +
          '(the input field remains named sequence for compatibility): plain names select ' +
          'sequences, "master" selects the master output endpoint, and "sum:<name>"/' +
          '"aux:<name>" select mixer buses. Index 0 is a note-sequence instrument; effects ' +
          'start at index 1. ' +
          'Playback must be stopped.',
        inputSchema: {
          sequence: z
            .string()
            .describe('Receiver: sequence name, "master", "sum:<bus-name>", or "aux:<bus-name>"'),
          index: z.number().describe('UIH.5 chain index (instrument 0, effects 1-based)'),
        },
      },
      async (args) => {
        const sequence = typeof args.sequence === 'string' ? args.sequence : ''
        const index = typeof args.index === 'number' ? args.index : NaN
        if (!sequence || !Number.isInteger(index) || index < 0) {
          return errorResult('sequence and a non-negative integer index are required')
        }
        const result = await savePluginState(sequence, index)
        if (!result.ok) {
          return errorResult(
            JSON.stringify({
              error: result.error,
              ...(result.code ? { code: result.code } : {}),
              ...(result.details === undefined ? {} : { details: result.details }),
            }),
          )
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.saved) }] }
      },
    )
  }

  const openPluginUi = handlers.openPluginUi?.bind(handlers)
  const closePluginUi = handlers.closePluginUi?.bind(handlers)
  if (openPluginUi && closePluginUi) {
    const pluginUiError = (result: Extract<PluginUiResult, { ok: false }>): ToolResult =>
      errorResult(
        JSON.stringify({
          error: result.error,
          ...(result.code ? { code: result.code } : {}),
          ...(result.details === undefined ? {} : { details: result.details }),
        }),
      )
    const receiverSchema = z
      .string()
      .describe('Receiver: sequence name, "master", "sum:<bus-name>", or "aux:<bus-name>"')
    const indexSchema = z.number().describe('UIH.5 chain index (instrument 0, effects 1-based)')

    server.registerTool(
      'open_plugin_ui',
      {
        title: 'Open Plugin UI',
        description:
          'Open and attach the current plugin window addressed by receiver and chain index. ' +
          'Returns only after the window exists. expectedName is an optional normalized-name ' +
          'guard that prevents opening a different plugin after chain indices shift.',
        inputSchema: {
          receiver: receiverSchema,
          index: indexSchema,
          expectedName: z
            .string()
            .describe('Optional normalized plugin name that must match the current slot')
            .optional(),
        },
      },
      async (args) => {
        const receiver = typeof args.receiver === 'string' ? args.receiver : ''
        const index = typeof args.index === 'number' ? args.index : NaN
        const expectedName = typeof args.expectedName === 'string' ? args.expectedName : undefined
        if (!receiver || !Number.isInteger(index) || index < 0) {
          return errorResult('receiver and a non-negative integer index are required')
        }
        const result = await openPluginUi(receiver, index, expectedName)
        return result.ok
          ? { content: [{ type: 'text', text: JSON.stringify(result.result) }] }
          : pluginUiError(result)
      },
    )

    server.registerTool(
      'close_plugin_ui',
      {
        title: 'Close Plugin UI',
        description:
          'Close the plugin window addressed by receiver and chain index. Returns only after ' +
          'UI_CLOSED_DONE, including the close-time state-save safepoint; the command ack alone ' +
          'is not completion.',
        inputSchema: { receiver: receiverSchema, index: indexSchema },
      },
      async (args) => {
        const receiver = typeof args.receiver === 'string' ? args.receiver : ''
        const index = typeof args.index === 'number' ? args.index : NaN
        if (!receiver || !Number.isInteger(index) || index < 0) {
          return errorResult('receiver and a non-negative integer index are required')
        }
        const result = await closePluginUi(receiver, index)
        return result.ok
          ? { content: [{ type: 'text', text: JSON.stringify(result.result) }] }
          : pluginUiError(result)
      },
    )
  }

  server.registerTool(
    'analyze_audio',
    {
      title: 'Analyze Audio',
      description:
        'Parse a WAV file (e.g. a capture_wav produced by start_engine) and report ' +
        'peak, RMS, and onset timing so audio can be verified objectively without ' +
        'listening. Pass window_ms to also get a per-window peak/RMS time series ' +
        '(for verifying temporal structure such as dry-first / steady-state).',
      inputSchema: {
        wav_path: z.string().describe('Absolute path to the WAV file to analyze'),
        window_ms: z
          .number()
          .describe('Optional window size in ms for a per-window peak/RMS series (e.g. 10)')
          .optional(),
      },
    },
    async (args) => {
      const wavPath = typeof args.wav_path === 'string' ? args.wav_path : ''
      const windowMs = typeof args.window_ms === 'number' ? args.window_ms : undefined
      const result = await handlers.analyzeAudio(wavPath, windowMs)
      if (!result.ok) {
        return errorResult(result.error)
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.analysis) }] }
    },
  )

  server.registerTool(
    'list_plugins',
    {
      title: 'List Plugins',
      description:
        'List the installed CLAP/VST3 plugin catalog (#463 PC.1) — name, vendor, format, ' +
        'and roles (effect/instrument) for each entry — so an agent can pick real ' +
        'plugin names when composing effect()/instrument() calls. Returns an error ' +
        '(with a rescan hint) if the catalog has not been scanned yet.',
    },
    async () => {
      const result = await handlers.listPlugins()
      if (!result.ok) {
        return errorResult(result.error)
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.plugins) }] }
    },
  )

  server.registerTool(
    'rescan_plugins',
    {
      title: 'Rescan Plugins',
      description:
        'Scan the OS plugin directories (and ORBIT_PLUGIN_PATH) and rewrite the plugin ' +
        'catalog using explicit child probes. Equivalent to the "Rescan Plugin Catalog" ' +
        'command. Returns per-artifact failure diagnostics, success/pending/failure counts, ' +
        'failure reasons, duration percentiles, timeout/crash counts, and factory descriptor versions.',
    },
    async () => {
      const result = await handlers.rescanPlugins()
      if (!result.ok) {
        return errorResult(result.error)
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              count: result.count,
              artifactCount: result.artifactCount,
              skipped: result.skipped,
              failures: result.failures,
              summary: result.summary,
            }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'get_dev_doc',
    {
      title: 'Get Dev Doc',
      description: 'Read a development-site Markdown document by its site-relative path.',
      inputSchema: {
        path: z.string().describe('Site-relative Markdown path, e.g. pipeline/text-to-ast.md'),
      },
    },
    async (args) => {
      const relativePath = typeof args.path === 'string' ? args.path : ''
      const content = readDevDoc(docsSourceRoot, relativePath)
      return content === null
        ? errorResult('development document not found')
        : { content: [{ type: 'text', text: content }] }
    },
  )

  server.registerTool(
    'search_dev_docs',
    {
      title: 'Search Dev Docs',
      description: 'Search development-site Markdown documents for a case-insensitive substring.',
      inputSchema: {
        query: z.string().describe('Text to search for'),
        limit: z.number().describe('Maximum matches to return (default 10)').optional(),
      },
    },
    async (args) => {
      const query = typeof args.query === 'string' ? args.query : ''
      const requestedLimit = typeof args.limit === 'number' ? args.limit : 10
      const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 10
      return {
        content: [
          { type: 'text', text: JSON.stringify(searchDevDocs(docsSourceRoot, query, limit)) },
        ],
      }
    },
  )

  // Optional handler (see OrbitScoreToolHandlers.registerMcpServer): the tool
  // only exists on hosts that can register themselves into Claude Code.
  const registerMcpServer = handlers.registerMcpServer?.bind(handlers)
  if (registerMcpServer) {
    server.registerTool(
      'register_mcp_server',
      {
        title: 'Register Claude Code MCP Server',
        description:
          'Register this OrbitScore MCP server into Claude Code — equivalent to the ' +
          '"Register Claude Code MCP Server" command. scope "project" merges an ' +
          'orbitscore entry into .mcp.json at the workspace root (shareable, ' +
          'per-repo); scope "user" registers for all projects by running ' +
          '`claude mcp add --transport http --scope user`. Omit port to register ' +
          'the port this server is currently running on.',
        inputSchema: {
          scope: z
            .string()
            .describe(
              'Registration scope: "project" (write .mcp.json in the workspace) or ' +
                '"user" (register for all projects via the claude CLI)',
            ),
          port: z
            .number()
            .describe("MCP server port to register. Default: this server's running port")
            .optional(),
        },
      },
      async (args) => {
        const scope = typeof args.scope === 'string' ? args.scope : ''
        const port = typeof args.port === 'number' ? args.port : undefined
        return toToolResult(await registerMcpServer({ scope, port }))
      },
    )
  }

  return server
}

/** One live MCP session: its transport plus the server instance bound to it. */
interface SessionEntry {
  transport: TransportLike
  server: McpServerLike
}

/**
 * Start the OrbitScore MCP server on `127.0.0.1:<port>/mcp`.
 *
 * Stateful Streamable HTTP with JSON responses: the MCP lifecycle
 * (initialize → tools/list → tools/call) spans multiple POSTs, so a session id
 * is issued on `initialize` and echoed by the client on later requests.
 * Stateless mode is not viable here (verified against SDK 1.29.0): reusing one
 * stateless transport across requests throws ("Stateless transport cannot be
 * reused across requests"), which our catch-all surfaces as a 500; and a
 * stale/missing session on a stateful transport gets the SDK's own
 * 400 "Bad Request: Server not initialized".
 *
 * Sessions are created **per initialize request** and routed by the
 * `mcp-session-id` header. A single shared transport would permanently consume
 * its one session slot on the first client — any later client (or a Claude Code
 * reconnect) would get "Bad Request: Mcp-Session-Id header is required"
 * (observed live, 2026-07-07). Tool handlers stay shared — they close over the
 * same extension state regardless of which session invokes them.
 */
export async function startOrbitScoreMcpServer(opts: {
  port: number
  version: string
  handlers: OrbitScoreToolHandlers
  log: (message: string) => void
}): Promise<McpServerHandle> {
  const { port, version, handlers, log } = opts

  const sessions = new Map<string, SessionEntry>()
  const docsRoot = resolveDocsRoot(path.resolve(__dirname, '../../..'))
  const userDocsRoot = resolveUserDocsRoot(path.resolve(__dirname, '../../..'))

  // DNS-rebinding protection: the server binds 127.0.0.1, but a malicious page
  // can point its own domain at 127.0.0.1 (short-TTL rebind) and then fetch()
  // same-origin — reaching this port from a browser with full response access.
  // The Host header still carries the attacker's domain in that case, so an
  // exact-match allowlist of loopback hosts closes the hole. (SDK 1.29.0 has
  // allowedHosts/enableDnsRebindingProtection but marks them deprecated in
  // favor of doing exactly this in the HTTP layer we already own.)
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])

  const createSession = async (): Promise<SessionEntry> => {
    const entry: Partial<SessionEntry> = {}
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true, // respond to each POST with a single JSON body
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, entry as SessionEntry)
        log(`MCP session opened: ${sessionId.slice(0, 8)}… (${sessions.size} active)`)
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId)
        log(`MCP session closed: ${sessionId.slice(0, 8)}… (${sessions.size} active)`)
      },
    })
    // Also reap on transport-level close (covers non-DELETE teardown paths).
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId)
      }
    }
    const server = buildServer(version, handlers, docsRoot)
    entry.transport = transport
    entry.server = server
    await server.connect(transport)
    return entry as SessionEntry
  }

  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const host = req.headers.host
      if (!host || !allowedHosts.has(host)) {
        log(`MCP request rejected — invalid Host header: ${host ?? '(none)'}`)
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden: invalid Host header' }))
        return
      }
      const pathname = (req.url ?? '').split('?')[0]
      // Human-friendly alias: the VitePress dist is built with SITE_BASE
      // (`/orbitscore/dev/` — sites/dev/.vitepress/config.ts), so all asset /
      // navigation URLs inside the built pages are absolute under that base.
      // Serving the dist at any other prefix would 404 every asset; instead
      // `/docs` redirects to the canonical base and only the base serves files.
      if (pathname === '/docs' || pathname === '/docs/') {
        res.writeHead(302, { Location: `${DOCS_PUBLIC_BASE}/` })
        res.end()
        return
      }
      // Longest-prefix first: the dev base lives inside the user base.
      const docsMatch = matchDocsRequest(pathname, [
        {
          base: DOCS_PUBLIC_BASE,
          root: docsRoot,
          buildHint:
            'Development docs are not built. Run npm run docs:build -w @orbitscore/dev-site',
        },
        {
          base: USER_DOCS_PUBLIC_BASE,
          root: userDocsRoot,
          buildHint: 'User docs are not built. Run npm run docs:build -w @orbitscore/user-site',
        },
      ])
      if (docsMatch) {
        if (req.method !== 'GET') {
          res.writeHead(405, { Allow: 'GET', 'content-type': 'text/plain; charset=utf-8' })
          res.end('Method Not Allowed')
          return
        }
        if (!fs.existsSync(docsMatch.root)) {
          log(`docs not built — root missing: ${docsMatch.root}`)
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(docsMatch.buildHint)
          return
        }
        if (isDocsDistStale(docsMatch.root, docsMatch.base)) {
          log(`docs dist is stale (base mismatch) — ${docsMatch.root}`)
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`Docs build is stale (built with a different base path). ${docsMatch.buildHint}`)
          return
        }
        const filePath = resolveDocsFilePath(docsMatch.root, pathname.slice(docsMatch.base.length))
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          log(`docs file not found for pathname: ${pathname}`)
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Not Found')
          return
        }
        const contentType = contentTypeForDocsFile(filePath)
        if (contentType === 'application/octet-stream') {
          log(
            `docs file served with fallback content-type (unknown extension ${path.extname(filePath)}): ${filePath}`,
          )
        }
        res.writeHead(200, { 'content-type': contentType })
        const stream = fs.createReadStream(filePath)
        stream.on('error', (err) => {
          log(`docs file stream error for ${filePath}: ${err}`)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          }
          res.end('Internal Server Error')
        })
        stream.pipe(res)
        return
      }
      if (pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      const sessionId = req.headers['mcp-session-id']
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
      if (existing) {
        await existing.transport.handleRequest(req, res, body)
        return
      }
      if (isInitializeRequest(body)) {
        // New session: the transport issues the session id while handling
        // this request and onsessioninitialized registers it in the map.
        const session = await createSession()
        await session.transport.handleRequest(req, res, body)
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found — send initialize first' },
          id: null,
        }),
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log(`MCP request error: ${reason}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: reason }))
      }
    }
  }

  const httpServer = http.createServer((req, res) => {
    void handleHttp(req, res)
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, '127.0.0.1', () => resolve())
  })
  log(`OrbitScore MCP server listening on http://127.0.0.1:${port}/mcp`)

  return {
    port,
    dispose: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      for (const [sessionId, session] of sessions) {
        // teardown 失敗は握り潰さずログに残す（EDH reload を繰り返す agent 駆動
        // 開発で close が系統的に失敗し始めた場合、ここが唯一の手掛かりになる）。
        await session.transport
          .close()
          .catch((err) =>
            log(`MCP session ${sessionId.slice(0, 8)}… transport close failed: ${err}`),
          )
        await session.server
          .close()
          .catch((err) => log(`MCP session ${sessionId.slice(0, 8)}… server close failed: ${err}`))
      }
      sessions.clear()
    },
  }
}

/** JSON-RPC initialize detection (single message or batch). */
function isInitializeRequest(body: unknown): boolean {
  const isInit = (m: unknown): boolean =>
    typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'initialize'
  return Array.isArray(body) ? body.some(isInit) : isInit(body)
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    req.on('error', reject)
  })
}
