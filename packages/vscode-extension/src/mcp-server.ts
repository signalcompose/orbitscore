import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'

import {
  contentTypeForDocsFile,
  DOCS_PUBLIC_BASE,
  isDocsDistStale,
  matchDocsRequest,
  resolveDocsFilePath,
  resolveDocsRoot,
  resolveUserDocsRoot,
  USER_DOCS_PUBLIC_BASE,
} from './mcp-docs'
import {
  McpServer,
  type McpServerLike,
  type McpServerHandle,
  StreamableHTTPServerTransport,
  type TransportLike,
} from './mcp-sdk'
import { registerEditorTools } from './mcp-tools-editor'
import { registerEngineTools } from './mcp-tools-engine'
import { registerPluginTools } from './mcp-tools-plugins'
import type { OrbitScoreToolHandlers } from './mcp-types'

/**
 * OrbitScore MCP control server — the "Agent Bridge" of WCTM_SYSTEM_SPEC §3.
 *
 * Hosts an MCP server (Streamable HTTP) inside the extension host so an external
 * agent can drive OrbitScore operations for E2E testing. The same tool surface
 * is intended for reuse by the WCTM performance runtime.
 *
 * Only started when `orbitscore.mcpServer.port` is a nonzero port. Binds
 * 127.0.0.1 only.
 */

export {
  DOCS_PUBLIC_BASE,
  isDocsDistStale,
  matchDocsRequest,
  readDevDoc,
  resolveDocsFilePath,
  resolveDocsRoot,
  resolveUserDocsRoot,
  searchDevDocs,
  USER_DOCS_PUBLIC_BASE,
} from './mcp-docs'
export { resolveMcpPluginUiIndex } from './mcp-sdk'
export type { McpServerHandle } from './mcp-sdk'
export type {
  AnalyzeAudioResult,
  AudioDeviceInfo,
  AudioDevicesResult,
  CommandResult,
  DevDocSearchMatch,
  DiagnosticEntry,
  DiagnosticSeverityLabel,
  DocumentText,
  EditReplaceInput,
  EditorState,
  EngineState,
  EvaluateResult,
  FileDiagnostics,
  FlashConfig,
  FlashConfigInput,
  FlashConfigResult,
  ListPluginsResult,
  OrbitScoreToolHandlers,
  PluginCatalogEntryInfo,
  PluginUiResult,
  RegisterMcpServerInput,
  RescanPluginsResult,
  SavePluginStateResult,
  SelectionInput,
} from './mcp-types'

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

  registerEngineTools(server, handlers)
  registerEditorTools(server, handlers, docsSourceRoot)
  registerPluginTools(server, handlers)

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
