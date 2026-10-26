/**
 * 中継 `orbitscore relay` を**実際のプロセス**として起こし、stdio の MCP で確かめる
 * （設計 848 §6.2 の RL-1〜RL-7・§4.7.1 の D-12・D-10 の (6)）。
 *
 * build 前でも回るように vite-node で `packages/session/src/cli.ts` を起こす。層 2 は本物の
 * `orbitscore session`（engine は起動しない）か、テストの中の偽の層 2（WebSocket サーバ）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  NOT_RUNNING_MESSAGE,
  unknownOutcomeMessage,
  updatedMessage,
} from '../../packages/session/src/relay/relay-main'

const repoRoot = path.resolve(__dirname, '../..')
const VITE_NODE = path.join(repoRoot, 'node_modules/.bin/vite-node')
const CLI = path.join(repoRoot, 'packages/session/src/cli.ts')

/** 設計 848 §6 の 28 本（中継がビルドに埋めて持つ一覧・RL-2）。 */
const TOOLS_28 = [
  'evaluate_orbitscore',
  'start_engine',
  'stop_engine',
  'get_engine_state',
  'list_audio_devices',
  'select_audio_device',
  'configure_flash',
  'open_file',
  'set_selection',
  'run_selection',
  'edit_replace',
  'get_editor_state',
  'save_file',
  'get_document_text',
  'get_diagnostics',
  'get_log',
  'save_plugin_state',
  'open_plugin_ui',
  'close_plugin_ui',
  'open_plugin_ui_at_cursor',
  'analyze_audio',
  'list_plugins',
  'rescan_plugins',
  'get_dev_doc',
  'search_dev_docs',
  'get_user_doc',
  'search_user_docs',
  'register_mcp_server',
]

const children: ChildProcess[] = []
const servers: Array<{ close(): Promise<void> }> = []

interface JsonRpcMessage {
  jsonrpc: string
  id?: number
  result?: any
  error?: { code: number; message: string }
}

interface RelayProcess {
  child: ChildProcess
  stdoutLines: string[]
  stderr: () => string
  request(method: string, params?: unknown): Promise<JsonRpcMessage>
  tool(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

async function spawnRelay(runtimeDir: string): Promise<RelayProcess> {
  const child = spawn(
    VITE_NODE,
    ['--config', 'vitest.config.ts', CLI, 'relay', '--runtime-dir', runtimeDir],
    {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  let stderr = ''
  child.stderr!.on('data', (chunk) => (stderr += chunk))
  const stdoutLines: string[] = []
  const pending = new Map<number, (message: JsonRpcMessage) => void>()
  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    stdoutLines.push(line)
    try {
      const message = JSON.parse(line) as JsonRpcMessage
      if (message.id !== undefined) pending.get(message.id)?.(message)
    } catch {
      // RL-7 の検査は stdoutLines をあとで全部読む。
    }
  })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  )
  let nextId = 1
  const request = (method: string, params: unknown = {}) =>
    new Promise<JsonRpcMessage>((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const relay: RelayProcess = {
    child,
    stdoutLines,
    stderr: () => stderr,
    request,
    tool: async (name, args = {}) => {
      const response = await request('tools/call', { name, arguments: args })
      return {
        text: response.result.content[0].text as string,
        isError: response.result.isError === true,
      }
    },
    exit,
  }
  const init = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'relay-process-test', version: '0.0.0' },
  })
  expect(init.result.serverInfo.name).toBe('orbitscore')
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  return relay
}

function spawnSession(runtimeDir: string, extra: string[] = []) {
  const child = spawn(
    VITE_NODE,
    ['--config', 'vitest.config.ts', CLI, 'session', '--runtime-dir', runtimeDir, ...extra],
    {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ORBIT_AUDIO_DAEMON_PATH: '/usr/bin/false' },
    },
  )
  children.push(child)
  let stderr = ''
  child.stderr!.on('data', (chunk) => (stderr += chunk))
  const ready = new Promise<Record<string, any>>((resolve, reject) => {
    readline
      .createInterface({ input: child.stdout! })
      .once('line', (line) => resolve(JSON.parse(line)))
    child.once('exit', () => reject(new Error(`session exited before ready: ${stderr}`)))
  })
  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return { child, ready, exit }
}

/** 偽の層 2: `session.hello` を送り、要求ごとの答えをテストが決める。 */
async function fakeSession(
  socketPath: string,
  helloVersion: string,
  answer: (method: string, ws: WebSocket, id: number) => void,
): Promise<{ received: string[] }> {
  const received: string[] = []
  const httpServer = http.createServer()
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as { id: number; method: string }
      received.push(message.method)
      if (message.method === 'session.attach') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { clientId: 'c1' } }))
      } else {
        answer(message.method, ws, message.id)
      }
    })
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session.hello',
        params: { protocol_version: helloVersion, session_version: 'fake', capabilities: [] },
      }),
    )
  })
  await new Promise<void>((resolve) => httpServer.listen(socketPath, resolve))
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        wss.close()
        httpServer.close(() => resolve())
      }),
  })
  return { received }
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null

let tmp: string
let runtimeDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-relay-'))
  runtimeDir = path.join(tmp, 'r')
})

afterEach(async () => {
  for (const child of children.splice(0)) if (alive(child)) child.kill('SIGKILL')
  for (const server of servers.splice(0)) await server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('RL-2 — the relay answers without layer 2 (design 848 §6.2)', () => {
  it('lists the 28 tools in order and answers server/discover at once', async () => {
    const relay = await spawnRelay(runtimeDir)
    const list = await relay.request('tools/list')
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOLS_28)
    const started = performance.now()
    const discover = await relay.request('server/discover')
    const elapsed = performance.now() - started
    // この SDK（1.29）は MCP 2026-07-28 を話さないので、即座に method-not-found。
    expect(discover.error).toMatchObject({ code: -32601 })
    expect(elapsed).toBeLessThan(200)
  }, 30_000)
})

describe('RL-1 / RL-3 / D-10 (6) — layer 2 going away and coming back (design 848 §6.2 / §4.7.1)', () => {
  it('reports "not running", survives kill -9 of layer 2, and serves the restarted one with the same PID', async () => {
    const relay = await spawnRelay(runtimeDir)
    const pid = relay.child.pid

    expect(await relay.tool('get_engine_state')).toEqual({
      text: `error: ${NOT_RUNNING_MESSAGE}`,
      isError: true,
    })

    const first = spawnSession(runtimeDir)
    await first.ready
    expect(JSON.parse((await relay.tool('get_engine_state')).text)).toEqual({
      running: false,
      liveCoding: false,
    })

    first.child.kill('SIGKILL')
    await first.exit
    expect(await relay.tool('get_engine_state')).toEqual({
      text: `error: ${NOT_RUNNING_MESSAGE}`,
      isError: true,
    })
    expect(alive(relay.child)).toBe(true)

    // 取り残しのソケットは session が起動時に片付ける（§4.7）。クライアントは何もしない。
    const second = spawnSession(runtimeDir)
    await second.ready
    expect(JSON.parse((await relay.tool('get_engine_state')).text)).toMatchObject({
      running: false,
    })
    expect(relay.child.pid).toBe(pid)
    expect(alive(relay.child)).toBe(true)
  }, 60_000)
})

describe('RL-4 / RL-5 — against a fake layer 2 (design 848 §6.2)', () => {
  it('RL-4: does not resend session.evaluate when layer 2 drops before answering', async () => {
    fs.mkdirSync(runtimeDir, { mode: 0o700 })
    const fake = await fakeSession(
      path.join(runtimeDir, 'session.sock'),
      '1.0',
      (method, ws, id) => {
        if (method === 'session.getState') {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: { engine: { running: true }, activeUri: null, workspaceRoot: null },
            }),
          )
        } else if (method === 'session.evaluate') {
          ws.terminate() // 受け取った後、答える前に落ちる
        }
      },
    )
    const relay = await spawnRelay(runtimeDir)
    expect(await relay.tool('evaluate_orbitscore', { code: 'global.tempo(120)' })).toEqual({
      text: `error: ${unknownOutcomeMessage('session.evaluate')}`,
      isError: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(fake.received.filter((method) => method === 'session.evaluate')).toHaveLength(1)
    expect(alive(relay.child)).toBe(true)
  }, 30_000)

  it('RL-5: a different MAJOR answers "updated — reconnect" and never attaches', async () => {
    fs.mkdirSync(runtimeDir, { mode: 0o700 })
    const fake = await fakeSession(path.join(runtimeDir, 'session.sock'), '2.0', () => {})
    const relay = await spawnRelay(runtimeDir)
    expect(await relay.tool('get_engine_state')).toEqual({
      text: `error: ${updatedMessage('2.0')}`,
      isError: true,
    })
    expect(fake.received).toEqual([])
    expect(alive(relay.child)).toBe(true)
  }, 30_000)
})

describe('RL-7 — stdio discipline and stopping (design 848 §6.2)', () => {
  it('writes only MCP frames to stdout and ends within 100 ms of SIGINT', async () => {
    const relay = await spawnRelay(runtimeDir)
    await relay.request('tools/list')
    await relay.tool('get_log')
    for (const line of relay.stdoutLines) {
      expect(JSON.parse(line), line).toMatchObject({ jsonrpc: '2.0' })
    }
    expect(relay.stderr()).toContain('[relay] serving MCP on stdio')
    const started = performance.now()
    relay.child.kill('SIGINT')
    const exit = await relay.exit
    expect(performance.now() - started).toBeLessThan(100)
    expect(exit).toEqual({ code: 0, signal: null })
  }, 30_000)

  it('ends when its stdin closes (the LLM client went away)', async () => {
    const relay = await spawnRelay(runtimeDir)
    relay.child.stdin!.end()
    expect(await relay.exit).toEqual({ code: 0, signal: null })
  }, 30_000)
})

// 🔴 ここの session は本物のプロセスで、`claude` CLI を差し替えられない。user scope を呼ぶと
// 利用者の ~/.claude.json に登録が残るので、project scope（一時ディレクトリの .mcp.json）だけを使う。
describe('register_mcp_server through the relay (design 848 §6.3 / §6.1)', () => {
  it('writes the stub stdio entry into the workspace .mcp.json and says the port is not used', async () => {
    const workspace = path.join(tmp, 'ws')
    fs.mkdirSync(workspace)
    fs.writeFileSync(
      path.join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: { orbitscore: { type: 'http', url: 'http://127.0.0.1:39123/mcp' } },
      }),
    )
    const session = spawnSession(runtimeDir, ['--workspace-root', workspace])
    await session.ready
    const relay = await spawnRelay(runtimeDir)
    const result = await relay.tool('register_mcp_server', { scope: 'project', port: 39123 })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('port 39123 is not used')
    const written = JSON.parse(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8'))
    expect(written.mcpServers.orbitscore).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:39123/mcp',
    })
    expect(written.mcpServers.orbitstudio).toEqual({
      type: 'stdio',
      command:
        process.platform === 'darwin'
          ? '${HOME}/Library/Application Support/OrbitStudio/bin/orbitstudio-mcp'
          : '${HOME}/.orbitstudio/bin/orbitstudio-mcp',
      args: [],
    })
    // 鍵もポートも書かない（§6.3）。
    expect(JSON.stringify(written.mcpServers.orbitstudio)).not.toMatch(/39123|token/)
  }, 60_000)
})
