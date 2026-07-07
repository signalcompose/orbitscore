import { randomUUID } from 'crypto'
import * as http from 'http'

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
interface ZodStringLike {
  describe(description: string): ZodStringLike
  optional(): unknown
}
const { z } = require('zod') as {
  z: { string: () => ZodStringLike }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/** Result of evaluating agent-supplied OrbitScore source. */
export type EvaluateResult = { ok: true } | { ok: false; error: string }

/** Result of a lifecycle command (start/stop engine). */
export type CommandResult = { ok: true; message?: string } | { ok: false; error: string }

/** Snapshot of the engine process state. */
export interface EngineState {
  running: boolean
  liveCoding: boolean
}

/**
 * VSCode-agnostic handler seam. Keeping the tool implementations behind this
 * interface (rather than reaching into the extension directly) means the same
 * handlers can be re-hosted later by the WCTM pi harness (spec §3/§4.2).
 */
export interface OrbitScoreToolHandlers {
  evaluate(code: string): Promise<EvaluateResult> | EvaluateResult
  startEngine(options?: { captureWav?: string }): Promise<CommandResult> | CommandResult
  stopEngine(): Promise<CommandResult> | CommandResult
  getEngineState(): EngineState
}

function toToolResult(result: CommandResult): ToolResult {
  if (result.ok) {
    return { content: [{ type: 'text', text: result.message ?? 'ok' }] }
  }
  return { content: [{ type: 'text', text: `error: ${result.error}` }], isError: true }
}

export interface McpServerHandle {
  readonly port: number
  dispose(): Promise<void>
}

/**
 * Build a per-session McpServer with the OrbitScore tool surface registered.
 * One instance per MCP session (see `startOrbitScoreMcpServer` for routing).
 */
function buildServer(version: string, handlers: OrbitScoreToolHandlers): McpServerLike {
  const server = new McpServer({ name: 'orbitscore', version })

  server.registerTool(
    'evaluate_orbitscore',
    {
      title: 'Evaluate OrbitScore',
      description:
        'Send OrbitScore (.orbs) source to the running engine live-coding session — ' +
        'the equivalent of "Run Selection" in the editor. The engine must be started ' +
        'first (via the Start Engine command). Returns ok once the code was accepted ' +
        'and written to the engine.',
      inputSchema: { code: z.string().describe('OrbitScore source to evaluate') },
    },
    async (args) => {
      const code = typeof args.code === 'string' ? args.code : ''
      const result = await handlers.evaluate(code)
      if (result.ok) {
        return { content: [{ type: 'text', text: 'ok' }] }
      }
      return { content: [{ type: 'text', text: `error: ${result.error}` }], isError: true }
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
        'so the produced audio can be verified without listening.',
      inputSchema: {
        capture_wav: z
          .string()
          .describe('Absolute path to write a whole-stream WAV capture of the master output')
          .optional(),
      },
    },
    async (args) => {
      const captureWav = typeof args.capture_wav === 'string' ? args.capture_wav : undefined
      return toToolResult(await handlers.startEngine(captureWav ? { captureWav } : undefined))
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
 * Stateless mode drops the "initialized" state between requests and rejects
 * everything after initialize with a 500 (verified against SDK 1.29.0).
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
    const server = buildServer(version, handlers)
    entry.transport = transport
    entry.server = server
    await server.connect(transport)
    return entry as SessionEntry
  }

  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const pathname = (req.url ?? '').split('?')[0]
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
      for (const [, session] of sessions) {
        await session.transport.close().catch(() => undefined)
        await session.server.close().catch(() => undefined)
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
