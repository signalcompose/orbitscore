/**
 * `OrbitScoreToolHandlers` を層 2 の RPC で満たす実装（設計 848 §6）を、端から端まで確かめる:
 * MCP のクライアント → `buildServer` → RPC のハンドラ → UDS の RPC クライアント → 本物の RPC サーバ
 * → `SessionCore`（偽の interpreter・本物の評価の受付口とパーサ）。
 *
 * daemon も音も無い（Linux で完結）。中継のプロセス（stdio・呼び出しごとの接続）は束 S-mcp の N1-b2。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveDocsSites } from '../../packages/session/src/host/docs-sites'
import { EngineHost, type EngineInterpreter } from '../../packages/session/src/host/engine-host'
import { SessionCore } from '../../packages/session/src/host/session-core'
import { buildServer } from '../../packages/session/src/mcp/build-server'
import {
  createRpcDocsSource,
  createRpcToolHandlers,
  type SessionCall,
} from '../../packages/session/src/mcp/rpc-tool-handlers'
import {
  connectSession,
  ProtocolMismatchError,
  RpcCallError,
  RpcConnectionClosedError,
  type SessionConnection,
} from '../../packages/session/src/rpc/client'
import {
  claimSocketPath,
  prepareRuntimeDir,
  resolveSocketPath,
} from '../../packages/session/src/rpc/runtime-dir'
import { startRpcServer, type RpcServer } from '../../packages/session/src/rpc/server'

import { connectMcp, type McpTestClient } from './helpers/mcp-test-client'

let tmp: string
let server: RpcServer | null
let core: SessionCore | null
let connection: SessionConnection | null
let mcp: McpTestClient | null

interface Harness {
  executed: string[]
  calls: Array<{ method: string; params: unknown }>
  mcp: McpTestClient
  socketPath: string
}

async function startHarness(
  options: { workspaceRoot?: string | null; docsDirs?: string[] } = {},
): Promise<Harness> {
  const executed: string[] = []
  const interpreter = {
    boot: async () => {},
    execute: async (_ir: unknown, opts: { source?: string }) => {
      executed.push(opts.source ?? '')
    },
    getGlobals: () => [{ stop: () => {}, saveAllPluginStates: async () => ({}) }],
    audioEngine: {
      quit: async () => {},
      getDaemonStatus: async () => ({ output: { device: 'x' }, callback: { n: 1 } }),
    },
  } as unknown as EngineInterpreter
  const dir = path.join(tmp, 'run')
  prepareRuntimeDir(dir)
  const socket = resolveSocketPath(dir)
  if (!socket.ok) throw new Error(socket.reason)
  await claimSocketPath(socket.socketPath)
  const host = new EngineHost({
    createInterpreter: () => interpreter,
    env: {},
    sessionLogCwd: tmp,
    sessionLogEnabled: false,
    log: (level, text) => core?.sessionLog(level, text),
  })
  let rpc: RpcServer | null = null
  core = new SessionCore({
    engine: host,
    workspaceRoot: options.workspaceRoot === undefined ? null : options.workspaceRoot,
    broadcast: (method, params) => rpc?.broadcast(method, params),
    editorAttached: () => false,
    captureConsole: false,
    docs: resolveDocsSites(options.docsDirs ?? []),
    // 🔴 本物の `claude` CLI を決して呼ばない（呼ぶと利用者の ~/.claude.json に登録が残る）。
    registerMcp: { execFile: claudeNotInstalled },
  })
  rpc = await startRpcServer({
    socketPath: socket.socketPath,
    sessionVersion: 'test',
    handlers: core.handlers,
    log: (level, text) => core!.sessionLog(level, text),
  })
  server = rpc
  connection = await connectSession(socket.socketPath, {
    client: { name: 'rpc-tool-handlers-test', version: '0.0.0' },
  })
  const calls: Harness['calls'] = []
  const call: SessionCall = (method, params) => {
    calls.push({ method, params })
    return connection!.call(method, params)
  }
  mcp = await connectMcp(
    buildServer('0.0.0-test', createRpcToolHandlers(call), createRpcDocsSource(call)),
  )
  return { executed, calls, mcp, socketPath: socket.socketPath }
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0]!.text

/** `which claude` が失敗する execFile（登録の検査で CLI に届かないことを保証する）。 */
const claudeNotInstalled = ((file: string, _args: string[], ...rest: unknown[]) => {
  const callback = rest.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
  callback(new Error(`${file}: not available in tests`), '', '')
  return undefined as never
}) as unknown as typeof import('node:child_process').execFile

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-mcp-'))
  server = null
  core = null
  connection = null
  mcp = null
})

afterEach(async () => {
  await mcp?.close()
  connection?.close()
  core?.dispose()
  await server?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('evaluate_orbitscore through layer 2 (design 848 §5.3.1 / IM.6)', () => {
  it('refuses before the engine starts and checks that before IM.6 (frozen order)', async () => {
    const harness = await startHarness()
    const result = await harness.mcp.call('evaluate_orbitscore', {
      code: 'global.tempo(120)',
      document_path: 'relative/without/workspace.orbs',
    })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'error: engine is not running — start the engine first' }],
      isError: true,
    })
    expect(harness.calls.map((c) => c.method)).toEqual(['session.getState'])
  })

  it('evaluates with no base when there is no workspace and no editor', async () => {
    const harness = await startHarness()
    expect(text(await harness.mcp.call('start_engine'))).toBe('engine started')
    const result = await harness.mcp.call('evaluate_orbitscore', { code: 'global.tempo(120)' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok (documentDirectory: none)' }] })
    expect(harness.executed).toEqual(['global.tempo(120)'])
    const evaluate = harness.calls.find((c) => c.method === 'session.evaluate')
    // 文書が分からない評価には target を付けない（§5.3.1）。
    expect(evaluate?.params).toEqual({
      code: 'global.tempo(120)',
      documentDirectory: null,
      source: 'agent',
    })
  })

  it('uses --workspace-root as the base when no document_path and no editor', async () => {
    const harness = await startHarness({ workspaceRoot: tmp })
    await harness.mcp.call('start_engine')
    expect(text(await harness.mcp.call('evaluate_orbitscore', { code: 'global.tempo(90)' }))).toBe(
      `ok (documentDirectory: ${tmp})`,
    )
  })

  it('resolves a relative document_path against the workspace and sends target.uri', async () => {
    fs.mkdirSync(path.join(tmp, 'piece'))
    const file = path.join(tmp, 'piece', 'piece.orbs')
    fs.writeFileSync(file, '')
    const harness = await startHarness({ workspaceRoot: tmp })
    await harness.mcp.call('start_engine')
    expect(
      text(
        await harness.mcp.call('evaluate_orbitscore', {
          code: 'global.tempo(100)',
          document_path: 'piece/piece.orbs',
        }),
      ),
    ).toBe(`ok (documentDirectory: ${path.join(tmp, 'piece')})`)
    expect(harness.calls.find((c) => c.method === 'session.evaluate')?.params).toEqual({
      code: 'global.tempo(100)',
      documentDirectory: path.join(tmp, 'piece'),
      source: 'agent',
      target: { uri: pathToFileURL(file).href },
    })
  })

  it('resolves an existing document_path whose directory has a line break (§6.1 exception)', async () => {
    const odd = path.join(tmp, 'odd\nname')
    fs.mkdirSync(odd)
    fs.writeFileSync(path.join(odd, 'p.orbs'), '')
    const harness = await startHarness()
    await harness.mcp.call('start_engine')
    expect(
      text(
        await harness.mcp.call('evaluate_orbitscore', {
          code: 'global.tempo(100)',
          document_path: path.join(odd, 'p.orbs'),
        }),
      ),
    ).toBe(`ok (documentDirectory: ${odd})`)
  })

  it('keeps the frozen IM.6 error wording and sends nothing for a missing file', async () => {
    const harness = await startHarness({ workspaceRoot: tmp })
    await harness.mcp.call('start_engine')
    const missing = path.join(tmp, 'typo.orbs')
    expect(
      await harness.mcp.call('evaluate_orbitscore', { code: 'x', document_path: missing }),
    ).toEqual({
      content: [
        { type: 'text', text: `error: document_path "${missing}" is not an existing file` },
      ],
      isError: true,
    })
    expect(harness.calls.map((c) => c.method)).not.toContain('session.evaluate')
    expect(harness.executed).toEqual([])
  })

  it('reports a parse failure with the diagnostics and the base it used', async () => {
    const harness = await startHarness({ workspaceRoot: tmp })
    await harness.mcp.call('start_engine')
    const result = await harness.mcp.call('evaluate_orbitscore', {
      code: 'global.play(([1, 5, 9]@v+10, 0))',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^error: evaluation failed: \[parse\] .+/)
    expect(text(result).endsWith(` (documentDirectory: ${tmp})`)).toBe(true)
  })
})

describe('IM.6 active editor input (design 848 §6)', () => {
  /** `editor.*` は束 S-editor。ここでは RPC の答えを差し替えて、中継側の組み立てだけを見る。 */
  function fakeCall(answers: Record<string, unknown | Error>): {
    call: SessionCall
    sent: Array<{ method: string; params: unknown }>
  } {
    const sent: Array<{ method: string; params: unknown }> = []
    const call = (async (method: string, params?: unknown) => {
      sent.push({ method, params })
      const answer = answers[method]
      if (answer instanceof Error) throw answer
      return answer
    }) as SessionCall
    return { call, sent }
  }
  const running = (activeUri: string | null) => ({
    engine: { running: true },
    activeUri,
    workspaceRoot: '/ws',
  })
  const evaluated = { ok: true, evalId: 'e1', diagnostics: [], documentDirectory: 'echo' }

  it('uses the active .orbs (file: uri) before the workspace', async () => {
    const { call, sent } = fakeCall({
      'session.getState': running('file:///ws/piece/a.orbs'),
      'editor.getState': { path: '/ws/piece/a.orbs', languageId: 'orbitscore' },
      'session.evaluate': evaluated,
    })
    await createRpcToolHandlers(call).evaluate('x')
    expect(sent.at(-1)?.params).toMatchObject({ documentDirectory: '/ws/piece' })
  })

  it.each([
    [
      'an untitled document',
      'untitled:Untitled-1',
      { path: 'Untitled-1', languageId: 'orbitscore' },
    ],
    ['a non-OrbitScore document', 'file:///ws/x.md', { path: '/ws/x.md', languageId: 'markdown' }],
  ])('falls back to the workspace for %s', async (_label, activeUri, editor) => {
    const { call, sent } = fakeCall({
      'session.getState': running(activeUri),
      'editor.getState': editor,
      'session.evaluate': evaluated,
    })
    await createRpcToolHandlers(call).evaluate('x')
    expect(sent.at(-1)?.params).toMatchObject({ documentDirectory: '/ws' })
  })

  it.each(['NO_EDITOR_ATTACHED', 'METHOD_NOT_FOUND'])(
    'treats %s from editor.getState as "no active editor"',
    async (errorName) => {
      const { call, sent } = fakeCall({
        'session.getState': running('file:///ws/piece/a.orbs'),
        'editor.getState': new RpcCallError(-32012, errorName, 'no editor'),
        'session.evaluate': evaluated,
      })
      await createRpcToolHandlers(call).evaluate('x')
      expect(sent.at(-1)?.params).toMatchObject({ documentDirectory: '/ws' })
    },
  )

  it('does not ask the editor when no document is active, and rethrows other failures', async () => {
    const idle = fakeCall({ 'session.getState': running(null), 'session.evaluate': evaluated })
    await createRpcToolHandlers(idle.call).evaluate('x')
    expect(idle.sent.map((s) => s.method)).toEqual(['session.getState', 'session.evaluate'])

    const broken = fakeCall({
      'session.getState': running('file:///ws/a.orbs'),
      'editor.getState': new RpcConnectionClosedError('editor.getState'),
    })
    await expect(createRpcToolHandlers(broken.call).evaluate('x')).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    )
  })
})

describe('the other tools through layer 2 (design 848 §6 / D-4)', () => {
  it('start / stop / get_engine_state / get_log answer from layer 2', async () => {
    const harness = await startHarness()
    expect(text(await harness.mcp.call('start_engine'))).toBe('engine started')
    expect(JSON.parse(text(await harness.mcp.call('get_engine_state')))).toEqual({
      running: true,
      liveCoding: true,
      output: { device: 'x' },
      callback: { n: 1 },
    })
    core!.sessionLog('info', 'hello from layer 2')
    expect(text(await harness.mcp.call('get_log', { lines: 1 }))).toBe('hello from layer 2')
    expect(text(await harness.mcp.call('stop_engine'))).toBe('engine stopped')
    expect(harness.calls.find((c) => c.method === 'session.getLog')?.params).toEqual({ lines: 1 })
  })

  it('get_log keeps the frozen handling of fractional and non-positive line counts', async () => {
    const harness = await startHarness()
    for (const line of ['a', 'b', 'c']) core!.sessionLog('info', line)
    expect(text(await harness.mcp.call('get_log', { lines: 2.5 }))).toBe('b\nc')
    expect(text(await harness.mcp.call('get_log', { lines: 0 }))).toBe('c')
    expect(text(await harness.mcp.call('get_log', { lines: -3 }))).toBe('c')
  })

  it('list_audio_devices keeps the frozen Rust-engine gap as isError', async () => {
    const harness = await startHarness()
    expect(await harness.mcp.call('list_audio_devices')).toEqual({
      content: [
        {
          type: 'text',
          text: 'error: audio device selection is not supported with the Rust engine; the system default output device is used',
        },
      ],
      isError: true,
    })
  })

  it('docs tools read layer 2 docs.*; a missing dev site answers the frozen message', async () => {
    const bundle = path.join(tmp, 'docs')
    fs.mkdirSync(path.join(bundle, 'user'), { recursive: true })
    fs.writeFileSync(path.join(bundle, 'user', 'start.md'), '# start\nplay the kick\n')
    const harness = await startHarness({ docsDirs: [bundle] })
    expect(text(await harness.mcp.call('get_user_doc', { path: 'start.md' }))).toBe(
      '# start\nplay the kick\n',
    )
    expect(JSON.parse(text(await harness.mcp.call('search_user_docs', { query: 'kick' })))).toEqual(
      [{ path: 'start.md', line: 2, excerpt: 'play the kick' }],
    )
    const dev = await harness.mcp.call('get_dev_doc', { path: 'start.md' })
    expect(dev.isError).toBe(true)
    expect(text(dev)).toMatch(/^error: Development docs are only available in the monorepo/)
    expect(await harness.mcp.call('get_user_doc', { path: '' })).toEqual({
      content: [{ type: 'text', text: 'error: user document not found' }],
      isError: true,
    })
  })

  it('analyze_audio keeps the frozen acceptance of a zero window (no windows, not an error)', async () => {
    const harness = await startHarness()
    const missing = await harness.mcp.call('analyze_audio', {
      wav_path: path.join(tmp, 'none.wav'),
      window_ms: 0,
    })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('ENOENT')
    expect(harness.calls.find((c) => c.method === 'audio.analyze')?.params).toEqual({
      wavPath: path.join(tmp, 'none.wav'),
      windowMs: 0,
    })
  })

  it('save_plugin_state maps the compatible sequence field to receiver', async () => {
    const harness = await startHarness()
    const result = await harness.mcp.call('save_plugin_state', { sequence: 'drums', index: 1 })
    // 凍結版の save_plugin_state は失敗を `{error, code?, details?}` の JSON で返す（写しのまま）。
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: `error: ${JSON.stringify({ error: 'engine is not running — start the engine first' })}`,
        },
      ],
      isError: true,
    })
    expect(harness.calls.at(-1)).toEqual({
      method: 'plugin.saveState',
      params: { receiver: 'drums', index: 1 },
    })
  })

  it('tools whose layer-2 method is not built yet answer isError, not a crash (ledger P-19)', async () => {
    const harness = await startHarness()
    for (const [tool, args] of [
      ['open_file', { path: '/ws/a.orbs' }],
      ['get_editor_state', {}],
    ] as const) {
      const result = await harness.mcp.call(tool, args)
      expect(result.isError, tool).toBe(true)
      expect(text(result), tool).toMatch(/^error: /)
    }
  })
})

describe('register_mcp_server through layer 2 (design 848 §6.3)', () => {
  it('reaches session.registerMcp; the claude CLI is never run from tests', async () => {
    const harness = await startHarness()
    expect(await harness.mcp.call('register_mcp_server', { scope: 'user', port: 1 })).toEqual({
      content: [
        {
          type: 'text',
          text: 'error: claude CLI not found on PATH — install the Claude Code CLI, or use Project scope (.mcp.json) instead',
        },
      ],
      isError: true,
    })
    expect(harness.calls.at(-1)).toEqual({
      method: 'session.registerMcp',
      params: { scope: 'user', port: 1 },
    })
  })
})

describe('the session RPC client (design 848 §4.7 / §5.2)', () => {
  it('rejects a socket nobody listens on with the connect error (RL-3 decides the wording)', async () => {
    await expect(
      connectSession(path.join(tmp, 'absent.sock'), { client: { name: 't', version: '0' } }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a session with a different MAJOR before attaching (RL-5)', async () => {
    const { WebSocketServer } = await import('ws')
    const http = await import('node:http')
    const socketPath = path.join(tmp, 'major.sock')
    const httpServer = http.createServer()
    const wss = new WebSocketServer({ server: httpServer })
    const received: string[] = []
    wss.on('connection', (ws) => {
      ws.on('message', (data) => received.push(data.toString()))
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session.hello',
          params: { protocol_version: '2.0', session_version: 'future', capabilities: [] },
        }),
      )
    })
    await new Promise<void>((resolve) => httpServer.listen(socketPath, resolve))
    await expect(
      connectSession(socketPath, { client: { name: 't', version: '0' } }),
    ).rejects.toBeInstanceOf(ProtocolMismatchError)
    expect(received).toEqual([])
    wss.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })

  it('a call in flight when the connection drops rejects as "result unknown" (RL-4)', async () => {
    const harness = await startHarness()
    const pending = connection!.call('engine.getState')
    connection!.close()
    await expect(pending).rejects.toBeInstanceOf(RpcConnectionClosedError)
    expect(harness.socketPath).toBeTruthy()
  })
})
