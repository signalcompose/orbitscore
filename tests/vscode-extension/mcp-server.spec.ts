import * as http from 'http'

import { describe, it, expect, afterEach } from 'vitest'

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
  type ListPluginsResult,
  type RescanPluginsResult,
} from '../../packages/vscode-extension/src/mcp-server'

/**
 * Protocol + session tests for the OrbitScore Agent Bridge MCP server
 * (#388). Exercises the REAL server over REAL HTTP with stub handlers — no
 * vscode involved (mcp-server.ts is vscode-free by design). Verifies the
 * multi-session regression fixed in WORK_LOG 6.189: a single shared
 * transport permanently consumed its one session slot on the first client,
 * so any later client got "Bad Request: Mcp-Session-Id header is required".
 */

// ── Stub handlers ──────────────────────────────────────────────────────────

interface RecordedCall {
  name: string
  args: unknown[]
}

function createStubHandlers(overrides: Partial<OrbitScoreToolHandlers> = {}): {
  handlers: OrbitScoreToolHandlers
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const record = (name: string, args: unknown[]) => calls.push({ name, args })

  const defaults: OrbitScoreToolHandlers = {
    evaluate: (code) => {
      record('evaluate', [code])
      return { ok: true }
    },
    startEngine: (options) => {
      record('startEngine', [options])
      const result: CommandResult = { ok: true, message: 'started' }
      return result
    },
    stopEngine: () => {
      record('stopEngine', [])
      const result: CommandResult = { ok: true, message: 'stopped' }
      return result
    },
    getEngineState: () => {
      record('getEngineState', [])
      const state: EngineState = { running: true, liveCoding: false }
      return state
    },
    forceKillScsynth: () => {
      record('forceKillScsynth', [])
      const result: CommandResult = { ok: true }
      return result
    },
    listAudioDevices: () => {
      record('listAudioDevices', [])
      const result: AudioDevicesResult = { ok: true, devices: [] }
      return result
    },
    selectAudioDevice: (device) => {
      record('selectAudioDevice', [device])
      const result: CommandResult = { ok: true }
      return result
    },
    configureFlash: (options) => {
      record('configureFlash', [options])
      const result: FlashConfigResult = {
        ok: true,
        config: { count: 3, duration: 150, color: 'selection', customColor: '#ff6b6b' },
      }
      return result
    },
    openFile: (path) => {
      record('openFile', [path])
      const result: CommandResult = { ok: true }
      return result
    },
    setSelection: (range) => {
      record('setSelection', [range])
      const result: CommandResult = { ok: true }
      return result
    },
    runSelection: () => {
      record('runSelection', [])
      const result: CommandResult = { ok: true }
      return result
    },
    editReplace: (args) => {
      record('editReplace', [args])
      const result: CommandResult = { ok: true, message: '1' }
      return result
    },
    getEditorState: () => {
      record('getEditorState', [])
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
      record('saveFile', [])
      const result: CommandResult = { ok: true, message: 'saved: /tmp/stub.orbs' }
      return result
    },
    getDocumentText: () => {
      record('getDocumentText', [])
      const result: DocumentText = { path: null, text: null }
      return result
    },
    getDiagnostics: (path) => {
      record('getDiagnostics', [path])
      return []
    },
    getLog: (lines) => {
      record('getLog', [lines])
      return ['[info] log line 1', '[info] log line 2']
    },
    analyzeAudio: (wavPath) => {
      record('analyzeAudio', [wavPath])
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
    listPlugins: () => {
      record('listPlugins', [])
      const result: ListPluginsResult = { ok: true, plugins: [] }
      return result
    },
    rescanPlugins: () => {
      record('rescanPlugins', [])
      const result: RescanPluginsResult = { ok: true, count: 0, skipped: [] }
      return result
    },
  }

  return { handlers: { ...defaults, ...overrides }, calls }
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

// ── Raw JSON-RPC / MCP client helper ────────────────────────────────────────

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  json: unknown
}

function postJson(
  port: number,
  body: unknown,
  opts: { sessionId?: string; path?: string; hostHeader?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(payload.length),
    }
    if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId
    if (opts.hostHeader) headers.host = opts.hostHeader

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: opts.path ?? '/mcp',
        method: 'POST',
        headers,
      },
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

function getPath(port: number, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
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
    })
    req.on('error', reject)
    req.end()
  })
}

/** One MCP client session: tracks its own session id and JSON-RPC request id counter. */
class McpTestClient {
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
        clientInfo: { name: 'mcp-test-client', version: '0.0.1' },
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

  /** initialize() + initialized() in one shot — the common case. */
  async connect(): Promise<RawResponse> {
    const initRes = await this.initialize()
    if (initRes.status !== 200) return initRes
    await this.initialized()
    return initRes
  }

  async toolsList(): Promise<RawResponse> {
    return postJson(
      this.port,
      { jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} },
      { sessionId: this.sessionId },
    )
  }

  async toolsCall(name: string, args: Record<string, unknown> = {}): Promise<RawResponse> {
    return postJson(
      this.port,
      {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      { sessionId: this.sessionId },
    )
  }
}

type JsonRpcOk<T> = { jsonrpc: '2.0'; id: number; result: T }
type ToolCallResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

// ── Tests ───────────────────────────────────────────────────────────────────

describe('OrbitScore MCP server (real HTTP, stub handlers)', () => {
  let handle: McpServerHandle | undefined

  afterEach(async () => {
    if (handle) {
      await handle.dispose()
      handle = undefined
    }
  })

  it('initialize returns 200, serverInfo.name === orbitscore, and a session id header', async () => {
    const { handlers } = createStubHandlers()
    handle = await startTestServer(handlers)
    const client = new McpTestClient(handle.port)

    const res = await client.initialize()

    expect(res.status).toBe(200)
    const body = res.json as JsonRpcOk<{ serverInfo: { name: string } }>
    expect(body.result.serverInfo.name).toBe('orbitscore')
    expect(typeof res.headers['mcp-session-id']).toBe('string')
    expect((res.headers['mcp-session-id'] as string).length).toBeGreaterThan(0)
  })

  it('tools/list contains all 20 tools; evaluate_orbitscore requires code:string', async () => {
    const { handlers } = createStubHandlers()
    handle = await startTestServer(handlers)
    const client = new McpTestClient(handle.port)
    await client.connect()

    const res = await client.toolsList()
    expect(res.status).toBe(200)
    const body = res.json as JsonRpcOk<{
      tools: Array<{ name: string; inputSchema?: Record<string, unknown> }>
    }>
    const names = body.result.tools.map((t) => t.name)

    const expectedNames = [
      'evaluate_orbitscore',
      'start_engine',
      'stop_engine',
      'get_engine_state',
      'open_file',
      'set_selection',
      'run_selection',
      'edit_replace',
      'get_editor_state',
      'save_file',
      'get_document_text',
      'force_kill_scsynth',
      'list_audio_devices',
      'select_audio_device',
      'configure_flash',
      'get_diagnostics',
      'get_log',
      'analyze_audio',
      'list_plugins',
      'rescan_plugins',
    ]
    for (const name of expectedNames) {
      expect(names, `missing tool: ${name}`).toContain(name)
    }

    const evaluateTool = body.result.tools.find((t) => t.name === 'evaluate_orbitscore')
    expect(evaluateTool).toBeDefined()
    const schema = evaluateTool!.inputSchema as {
      required?: string[]
      properties?: Record<string, { type?: string }>
    }
    expect(schema.required).toContain('code')
    expect(schema.properties?.code?.type).toBe('string')
  })

  it('tools/call evaluate_orbitscore round-trips the exact code string', async () => {
    const { handlers, calls } = createStubHandlers()
    handle = await startTestServer(handlers)
    const client = new McpTestClient(handle.port)
    await client.connect()

    const code = 'global.tempo(140)\nLOOP(drum)'
    const res = await client.toolsCall('evaluate_orbitscore', { code })

    expect(res.status).toBe(200)
    const body = res.json as JsonRpcOk<ToolCallResult>
    expect(body.result.isError).toBeFalsy()
    expect(body.result.content[0]?.text).toBe('ok')

    const call = calls.find((c) => c.name === 'evaluate')
    expect(call?.args[0]).toBe(code)
  })

  it('tools/call get_document_text round-trips path/text and records the call', async () => {
    const docText: DocumentText = { path: '/tmp/session.orbs', text: 'global.tempo(140)\n' }
    let getDocumentTextCalled = false
    const { handlers } = createStubHandlers({
      getDocumentText: () => {
        getDocumentTextCalled = true
        return docText
      },
    })
    handle = await startTestServer(handlers)
    const client = new McpTestClient(handle.port)
    await client.connect()

    const res = await client.toolsCall('get_document_text')

    expect(res.status).toBe(200)
    const body = res.json as JsonRpcOk<ToolCallResult>
    expect(body.result.isError).toBeFalsy()
    expect(JSON.parse(body.result.content[0]!.text)).toEqual(docText)
    expect(getDocumentTextCalled).toBe(true)
  })

  it('tools/call list_plugins round-trips the catalog entries', async () => {
    const plugins: ListPluginsResult = {
      ok: true,
      plugins: [
        {
          name: 'Surge XT',
          vendor: 'Surge Synth Team',
          format: 'clap',
          path: '/clap/SurgeXT.clap',
          pluginId: 'surge-xt',
          roles: ['instrument'],
        },
      ],
    }
    const { handlers } = createStubHandlers({ listPlugins: () => plugins })
    handle = await startTestServer(handlers)
    const client = new McpTestClient(handle.port)
    await client.connect()

    const res = await client.toolsCall('list_plugins')

    expect(res.status).toBe(200)
    const body = res.json as JsonRpcOk<ToolCallResult>
    expect(body.result.isError).toBeFalsy()
    expect(JSON.parse(body.result.content[0]!.text)).toEqual(plugins.plugins)
  })

  it('tools/call list_plugins surfaces isError:true when the catalog is missing', async () => {
    const { handlers } = createStubHandlers({
      listPlugins: () => ({ ok: false, error: 'plugin catalog not found' }),
    })
    handle = await startTestServer(handlers)
    const client = new McpTestClient(handle.port)
    await client.connect()

    const res = await client.toolsCall('list_plugins')

    const body = res.json as JsonRpcOk<ToolCallResult>
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]?.text).toMatch(/^error:/)
  })

  it('tools/call rescan_plugins round-trips the scan summary', async () => {
    let rescanPluginsCalled = false
    const { handlers } = createStubHandlers({
      rescanPlugins: () => {
        rescanPluginsCalled = true
        return { ok: true, count: 12, skipped: ['/vst3/NoMetadata.vst3'] }
      },
    })
    handle = await startTestServer(handlers)
    const client = new McpTestClient(handle.port)
    await client.connect()

    const res = await client.toolsCall('rescan_plugins')

    expect(res.status).toBe(200)
    const body = res.json as JsonRpcOk<ToolCallResult>
    expect(body.result.isError).toBeFalsy()
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({
      count: 12,
      skipped: ['/vst3/NoMetadata.vst3'],
    })
    expect(rescanPluginsCalled).toBe(true)
  })

  it('handler error surfaces as isError:true with text starting with "error:"', async () => {
    const { handlers } = createStubHandlers({
      stopEngine: () => ({ ok: false, error: 'boom' }),
    })
    handle = await startTestServer(handlers)
    const client = new McpTestClient(handle.port)
    await client.connect()

    const res = await client.toolsCall('stop_engine')

    expect(res.status).toBe(200)
    const body = res.json as JsonRpcOk<ToolCallResult>
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]?.text).toMatch(/^error:/)
    expect(body.result.content[0]?.text).toContain('boom')
  })

  it('MULTI-SESSION REGRESSION: three sequential clients each initialize independently with distinct session ids', async () => {
    // WORK_LOG 6.189: a single shared transport permanently consumed its one
    // session slot on the first client — any later client (or a Claude Code
    // reconnect) got "Bad Request: Mcp-Session-Id header is required". This
    // probe is the regression test for the per-session transport fix.
    const { handlers } = createStubHandlers()
    handle = await startTestServer(handlers)

    const sessionIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const client = new McpTestClient(handle.port)
      const initRes = await client.connect()
      expect(initRes.status, `client ${i} initialize`).toBe(200)
      expect(client.sessionId, `client ${i} session id`).toBeTruthy()

      const callRes = await client.toolsCall('get_engine_state')
      expect(callRes.status, `client ${i} tools/call`).toBe(200)
      const body = callRes.json as JsonRpcOk<ToolCallResult>
      expect(body.result.isError, `client ${i} tools/call isError`).toBeFalsy()

      sessionIds.push(client.sessionId!)
    }

    expect(new Set(sessionIds).size).toBe(3)
  })

  it('tools/call without initialize (no session header) returns 404 "Session not found"', async () => {
    const { handlers } = createStubHandlers()
    handle = await startTestServer(handlers)

    const res = await postJson(handle.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_engine_state', arguments: {} },
    })

    expect(res.status).toBe(404)
    const body = res.json as { error?: { message?: string } }
    expect(body.error?.message).toContain('Session not found')
  })

  it('non-/mcp path returns 404', async () => {
    const { handlers } = createStubHandlers()
    handle = await startTestServer(handlers)

    const res = await getPath(handle.port, '/not-mcp')
    expect(res.status).toBe(404)
  })

  it('after dispose(), connections are refused', async () => {
    const { handlers } = createStubHandlers()
    const server = await startTestServer(handlers)
    const port = server.port
    await server.dispose()
    handle = undefined // already disposed — nothing left for afterEach to do

    await expect(getPath(port, '/mcp')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('rejects a non-loopback Host header with 403 (DNS-rebinding protection)', async () => {
    const { handlers } = createStubHandlers()
    handle = await startTestServer(handlers)

    // Simulates a DNS-rebound page: the socket reaches 127.0.0.1 but the
    // browser sends the attacker's domain in Host.
    const res = await postJson(
      handle.port,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { hostHeader: 'evil.example:39123' },
    )
    expect(res.status).toBe(403)
    expect((res.json as { error?: string }).error).toContain('Host')
  })

  it('register_mcp_server is listed ONLY when the optional handler is provided, and round-trips args', async () => {
    // Without the handler (the stub default): tool absent.
    const { handlers: bare } = createStubHandlers()
    const bareServer = await startTestServer(bare)
    const bareClient = new McpTestClient(bareServer.port)
    await bareClient.connect()
    const bareList = (await bareClient.toolsList()).json as JsonRpcOk<{
      tools: Array<{ name: string }>
    }>
    expect(bareList.result.tools.map((t) => t.name)).not.toContain('register_mcp_server')
    await bareServer.dispose()

    // With the handler: tool present, scope/port marshalled through JSON args.
    const registerCalls: unknown[] = []
    const { handlers } = createStubHandlers({
      registerMcpServer: (args) => {
        registerCalls.push(args)
        return { ok: true, message: 'registered (project)' }
      },
    })
    handle = await startTestServer(handlers)
    const client = new McpTestClient(handle.port)
    await client.connect()

    const list = (await client.toolsList()).json as JsonRpcOk<{ tools: Array<{ name: string }> }>
    expect(list.result.tools.map((t) => t.name)).toContain('register_mcp_server')

    const res = await client.toolsCall('register_mcp_server', { scope: 'project', port: 39123 })
    expect(res.status).toBe(200)
    const body = res.json as JsonRpcOk<{ content: Array<{ text: string }>; isError?: boolean }>
    expect(body.result.isError).toBeUndefined()
    expect(body.result.content[0].text).toBe('registered (project)')
    expect(registerCalls).toEqual([{ scope: 'project', port: 39123 }])
  })
})
