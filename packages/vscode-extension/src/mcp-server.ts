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
    }) => TransportLike
  }
const { z } = require('zod') as {
  z: { string: () => { describe: (description: string) => unknown } }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/** Result of evaluating agent-supplied OrbitScore source. */
export type EvaluateResult = { ok: true } | { ok: false; error: string }

/**
 * VSCode-agnostic handler seam. Keeping the tool implementations behind this
 * interface (rather than reaching into the extension directly) means the same
 * handlers can be re-hosted later by the WCTM pi harness (spec §3/§4.2).
 */
export interface OrbitScoreToolHandlers {
  evaluate(code: string): Promise<EvaluateResult> | EvaluateResult
}

export interface McpServerHandle {
  readonly port: number
  dispose(): Promise<void>
}

/**
 * Start the OrbitScore MCP server on `127.0.0.1:<port>/mcp`.
 *
 * Stateful Streamable HTTP with JSON responses: the MCP lifecycle spans multiple
 * POSTs, so a session id is issued on `initialize` and echoed by the client on
 * later requests (see the transport construction below for why stateless fails).
 */
export async function startOrbitScoreMcpServer(opts: {
  port: number
  version: string
  handlers: OrbitScoreToolHandlers
  log: (message: string) => void
}): Promise<McpServerHandle> {
  const { port, version, handlers, log } = opts

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

  // Stateful session: the MCP lifecycle (initialize → tools/list → tools/call)
  // spans multiple HTTP POSTs, so the server must retain "initialized" state
  // across them. Stateless mode drops that state between requests and rejects
  // everything after initialize with a 500. One transport is enough here — the
  // Agent Bridge serves a single agent client at a time.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true, // respond to each POST with a single JSON body
  })
  await server.connect(transport)

  const httpServer = http.createServer((req, res) => {
    void handleHttp(req, res, transport, log)
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
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    },
  }
}

async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  transport: TransportLike,
  log: (message: string) => void,
): Promise<void> {
  try {
    const pathname = (req.url ?? '').split('?')[0]
    if (pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined
    await transport.handleRequest(req, res, body)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log(`MCP request error: ${reason}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: reason }))
    }
  }
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
