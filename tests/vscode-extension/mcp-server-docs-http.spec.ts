import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  startOrbitScoreMcpServer,
  type OrbitScoreToolHandlers,
  type McpServerHandle,
  type CommandResult,
  type EngineState,
  type AudioDevicesResult,
  type FlashConfigResult,
  type EditorState,
  type DocumentText,
  type AnalyzeAudioResult,
} from '../../packages/vscode-extension/src/mcp-server'

/**
 * HTTP-level tests for the docs-serving branch of startOrbitScoreMcpServer
 * (#450 round-1 fix F5, pr-test-analyzer). mcp-server-docs.spec.ts covers the
 * pure helpers (resolveDocsFilePath / readDevDoc / searchDevDocs) in
 * isolation; these tests drive the real HTTP handler end to end — redirect,
 * 404 vs 503, traversal through the live request path, and the MCP tool
 * round-trip against the actual sites/dev source tree.
 */

// ── Stub handlers (mirrors mcp-server.spec.ts) ──────────────────────────────

function createStubHandlers(): OrbitScoreToolHandlers {
  return {
    evaluate: () => ({ ok: true }),
    startEngine: () => {
      const result: CommandResult = { ok: true, message: 'started' }
      return result
    },
    stopEngine: () => {
      const result: CommandResult = { ok: true, message: 'stopped' }
      return result
    },
    getEngineState: () => {
      const state: EngineState = { running: true, liveCoding: false }
      return state
    },
    forceKillScsynth: () => {
      const result: CommandResult = { ok: true }
      return result
    },
    listAudioDevices: () => {
      const result: AudioDevicesResult = { ok: true, devices: [] }
      return result
    },
    selectAudioDevice: () => {
      const result: CommandResult = { ok: true }
      return result
    },
    configureFlash: () => {
      const result: FlashConfigResult = {
        ok: true,
        config: { count: 3, duration: 150, color: 'selection', customColor: '#ff6b6b' },
      }
      return result
    },
    openFile: () => {
      const result: CommandResult = { ok: true }
      return result
    },
    setSelection: () => {
      const result: CommandResult = { ok: true }
      return result
    },
    runSelection: () => {
      const result: CommandResult = { ok: true }
      return result
    },
    editReplace: () => {
      const result: CommandResult = { ok: true, message: '1' }
      return result
    },
    getEditorState: () => {
      const state: EditorState = {
        path: null,
        languageId: null,
        cursor: null,
        selection: null,
        lineCount: null,
        isDirty: null,
      }
      return state
    },
    saveFile: () => {
      const result: CommandResult = { ok: true, message: 'saved: /tmp/stub.orbs' }
      return result
    },
    getDocumentText: () => {
      const result: DocumentText = { path: null, text: null }
      return result
    },
    getDiagnostics: () => [],
    getLog: () => ['[info] log line 1'],
    analyzeAudio: async () => {
      const result: AnalyzeAudioResult = {
        ok: true,
        analysis: {
          format: { audioFormat: 3, channels: 2, sampleRate: 48000, bitsPerSample: 32 },
          frames: 0,
          durationSec: 0,
          peak: 0,
          rms: 0,
          onsets: [],
          onsetGaps: [],
          soundDetected: false,
        },
      }
      return result
    },
  }
}

// ── Server bring-up (ephemeral port, retry on EADDRINUSE) ──────────────────

async function startTestServer(handlers: OrbitScoreToolHandlers): Promise<McpServerHandle> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 15; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    try {
      return await startOrbitScoreMcpServer({
        port,
        version: '0.0.0-test',
        handlers,
        log: () => {},
      })
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EADDRINUSE') throw err
    }
  }
  throw new Error(`failed to find a free port after 15 attempts: ${String(lastErr)}`)
}

// ── Raw HTTP / JSON-RPC helpers (mirrors mcp-server.spec.ts) ───────────────

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function getPath(port: number, pathname: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function postJson(port: number, body: unknown, sessionId?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(payload.length),
    }
    if (sessionId) headers['mcp-session-id'] = sessionId

    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

/** initialize → notifications/initialized, returning the session id. */
async function connectMcpSession(port: number): Promise<string> {
  const initRes = await postJson(port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'mcp-docs-http-test', version: '0.0.1' },
    },
  })
  const sessionId = initRes.headers['mcp-session-id']
  if (typeof sessionId !== 'string') {
    throw new Error(`initialize did not return a session id (status ${initRes.status})`)
  }
  await postJson(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
  return sessionId
}

async function toolsCall(
  port: number,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const res = await postJson(
    port,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    sessionId,
  )
  const parsed = JSON.parse(res.body) as {
    result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
  }
  return parsed.result
}

// docsRoot mirrors resolveDocsRoot's derivation from the server module's own
// location, so this reliably reflects whether the dist has actually been built.
const docsDistExists = fs.existsSync(path.resolve(__dirname, '../../sites/dev/.vitepress/dist'))

// ── Tests ───────────────────────────────────────────────────────────────────

describe('OrbitScore MCP server — docs serving (real HTTP)', () => {
  let handle: McpServerHandle | undefined

  afterEach(async () => {
    if (handle) {
      await handle.dispose()
      handle = undefined
    }
  })

  it('GET /docs redirects to the canonical docs base', async () => {
    handle = await startTestServer(createStubHandlers())
    const res = await getPath(handle.port, '/docs')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/orbitscore/dev/')
  })

  it('GET /docs/ also redirects to the canonical docs base', async () => {
    handle = await startTestServer(createStubHandlers())
    const res = await getPath(handle.port, '/docs/')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/orbitscore/dev/')
  })

  if (!docsDistExists) {
    it('docs not built: GET /orbitscore/dev/ returns 503 mentioning docs:build', async () => {
      handle = await startTestServer(createStubHandlers())
      const res = await getPath(handle.port, '/orbitscore/dev/')

      expect(res.status).toBe(503)
      expect(res.body).toContain('docs:build')
    })
  } else {
    // The dist was built locally (e.g. after `npm run docs:build`) — the 503
    // branch isn't reachable, so assert the deterministic 404 case instead.
    it('docs built: a nonexistent page under the docs base returns 404', async () => {
      handle = await startTestServer(createStubHandlers())
      const res = await getPath(handle.port, '/orbitscore/dev/does-not-exist-page/')

      expect(res.status).toBe(404)
    })
  }

  it('rejects path traversal through the live handler (encoded and literal), never 200', async () => {
    handle = await startTestServer(createStubHandlers())
    // Without a built dist, resolution never even reaches the traversal guard
    // (503 "not built" fires first) — assert the deterministic invariant that
    // holds in both cases: traversal must never resolve to 200.
    const expectedStatus = docsDistExists ? 404 : 503

    const encoded = await getPath(handle.port, '/orbitscore/dev/%2e%2e%2fsecret')
    expect(encoded.status).toBe(expectedStatus)

    const literal = await getPath(handle.port, '/orbitscore/dev/..%2fsecret')
    expect(literal.status).toBe(expectedStatus)
  })

  it('MCP get_dev_doc round-trips a real sites/dev document', async () => {
    handle = await startTestServer(createStubHandlers())
    const sessionId = await connectMcpSession(handle.port)

    const result = await toolsCall(handle.port, sessionId, 'get_dev_doc', {
      path: 'glossary.md',
    })

    expect(result.isError).toBeFalsy()
    expect(result.content[0]?.text.length).toBeGreaterThan(0)
  })

  it('MCP search_dev_docs returns a JSON array through the real docsSourceRoot', async () => {
    handle = await startTestServer(createStubHandlers())
    const sessionId = await connectMcpSession(handle.port)

    const result = await toolsCall(handle.port, sessionId, 'search_dev_docs', {
      query: 'OrbitScore',
      limit: 5,
    })

    expect(result.isError).toBeFalsy()
    const matches = JSON.parse(result.content[0]?.text ?? '[]') as unknown[]
    expect(Array.isArray(matches)).toBe(true)
  })
})
