import * as http from 'http'

/**
 * Minimal raw JSON-RPC / MCP Streamable HTTP client shared by the OrbitStudio
 * gated E2E spec (tests/e2e/orbitstudio-mcp-gated.spec.ts). Deliberately
 * dependency-free (no MCP SDK client) — this talks to the real
 * `packages/vscode-extension/src/mcp-server.ts` the same way `mcp-server.spec.ts`
 * does, just against a real extension host process instead of an in-process
 * stub.
 */

export interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  json: unknown
}

export interface ToolCallResult {
  isError: boolean
  text: string
  raw: RawResponse
}

function postJson(
  port: number,
  body: unknown,
  opts: { sessionId?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(payload.length),
    }
    if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId

    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: raw ? JSON.parse(raw) : undefined,
          })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

/** One MCP session against a real OrbitStudio extension host. */
export class McpClient {
  sessionId: string | undefined
  private nextId = 1

  constructor(private readonly port: number) {}

  async initialize(): Promise<RawResponse> {
    const res = await postJson(this.port, {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'orbitstudio-gated-e2e', version: '0.0.1' },
      },
    })
    const sid = res.headers['mcp-session-id']
    if (typeof sid === 'string') this.sessionId = sid
    return res
  }

  async initialized(): Promise<RawResponse> {
    return postJson(
      this.port,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { sessionId: this.sessionId },
    )
  }

  /** initialize() + initialized() in one shot. */
  async connect(): Promise<RawResponse> {
    const initRes = await this.initialize()
    if (initRes.status !== 200) return initRes
    await this.initialized()
    return initRes
  }

  /** Call a tool and unwrap the MCP `content[0].text` / `isError` shape used by mcp-server.ts. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const res = await postJson(
      this.port,
      {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      { sessionId: this.sessionId },
    )
    const body = res.json as
      | { result?: { content?: Array<{ text?: string }>; isError?: boolean } }
      | undefined
    return {
      isError: body?.result?.isError === true,
      text: body?.result?.content?.[0]?.text ?? '',
      raw: res,
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll `predicate` until it resolves truthy, or throw once `timeoutMs` elapses. */
export async function waitUntil(
  predicate: () => Promise<boolean>,
  opts: { intervalMs: number; timeoutMs: number; label?: string },
): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < opts.timeoutMs) {
    try {
      if (await predicate()) return
    } catch (err) {
      lastErr = err
    }
    await sleep(opts.intervalMs)
  }
  const label = opts.label ?? 'condition'
  throw new Error(
    `timed out waiting for ${label} after ${opts.timeoutMs}ms${lastErr ? `; last error: ${String(lastErr)}` : ''}`,
  )
}

/**
 * Poll `initialize` against a freshly-launched extension host until it comes
 * up (or the budget elapses). Returns a connected client (initialize +
 * initialized already sent).
 */
export async function pollInitialize(
  port: number,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<McpClient> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < opts.timeoutMs) {
    const client = new McpClient(port)
    try {
      const res = await client.connect()
      if (res.status === 200) return client
    } catch (err) {
      lastErr = err
    }
    await sleep(opts.intervalMs)
  }
  throw new Error(
    `MCP server did not become available on 127.0.0.1:${port}/mcp within ${opts.timeoutMs}ms: ${String(lastErr)}`,
  )
}
