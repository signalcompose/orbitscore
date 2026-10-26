/**
 * セッションプロトコルのサーバ（`packages/session/src/rpc/`）— D-10 の (1)〜(4)・握手・振り分け。
 *
 * HTTP / WebSocket / UDS を**実際に開いて**確かめる（設計 848 §1.2 D-10・Linux で完結）。
 *
 * D-10:
 * (1) TCP の `/rpc` は Host 許可外・Origin 許可外・`Origin: null`・Origin なし・トークンなし・
 *     トークン違いの 6 通りを拒否し（upgrade で 403 か attach で close 1008）、許可された Origin +
 *     正しいトークンは通す
 * (2) TCP に `/mcp` は無い（`POST /mcp` → 404）
 * (3) runtime-dir が 0700 で自分の所有でなければ起動しない・ソケットは 0600
 * (4) UDS の `/rpc` はトークンなしで attach できる
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { allowedOrigin } from '../../packages/session/src/rpc/http-guard'
import { RpcError } from '../../packages/session/src/rpc/protocol'
import {
  claimSocketPath,
  prepareRuntimeDir,
  resolveSocketPath,
} from '../../packages/session/src/rpc/runtime-dir'
import { startRpcServer, type RpcServer } from '../../packages/session/src/rpc/server'

import { RpcTestClient } from './helpers/rpc-test-client'

const TOKEN = 'test-token-0123456789abcdef'

let tmp: string
let server: RpcServer | null
let logs: string[]

async function start(tcp = true): Promise<RpcServer> {
  const dir = path.join(tmp, 'run')
  const prepared = prepareRuntimeDir(dir)
  if (!prepared.ok) throw new Error(prepared.reason)
  const socket = resolveSocketPath(dir)
  if (!socket.ok) throw new Error(socket.reason)
  const claimed = await claimSocketPath(socket.socketPath)
  if (!claimed.ok) throw new Error(claimed.reason)
  server = await startRpcServer({
    socketPath: socket.socketPath,
    tcp: tcp ? { port: 0, token: TOKEN } : undefined,
    sessionVersion: '0.0.1-test',
    handlers: {
      'session.getLog': () => ({ lines: ['a', 'b'] }),
      'engine.getState': () => ({ running: false, liveCoding: false }),
      'engine.stop': () => ({ bogus: true }),
      'session.getState': () => {
        throw new RpcError('ENGINE_NOT_RUNNING', 'engine is not running')
      },
    },
    log: (_level, text) => logs.push(text),
  })
  return server
}

const tcpUrl = (port: number) => `ws://127.0.0.1:${port}/rpc`
const okHeaders = (port: number) => ({ Origin: allowedOrigin(port) })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-rpc-'))
  logs = []
  server = null
})

afterEach(async () => {
  await server?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('D-10 (1) — the TCP /rpc rejects six ways and admits one', () => {
  it('rejects a Host outside the allow list at upgrade (403)', async () => {
    const { tcpPort } = await start()
    await expect(
      RpcTestClient.connect(tcpUrl(tcpPort!), {
        ...okHeaders(tcpPort!),
        Host: `evil.example:${tcpPort}`,
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('rejects an Origin outside the allow list at upgrade (403)', async () => {
    const { tcpPort } = await start()
    await expect(
      RpcTestClient.connect(tcpUrl(tcpPort!), { Origin: 'http://evil.example' }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('rejects Origin: null at upgrade (403)', async () => {
    const { tcpPort } = await start()
    await expect(RpcTestClient.connect(tcpUrl(tcpPort!), { Origin: 'null' })).rejects.toMatchObject(
      {
        status: 403,
      },
    )
  })

  it('rejects a missing Origin at upgrade (403)', async () => {
    const { tcpPort } = await start()
    await expect(RpcTestClient.connect(tcpUrl(tcpPort!))).rejects.toMatchObject({ status: 403 })
  })

  it('closes with 1008 when session.attach carries no token', async () => {
    const { tcpPort } = await start()
    const client = await RpcTestClient.connect(tcpUrl(tcpPort!), okHeaders(tcpPort!))
    await client.hello
    void client.attach()
    expect(await client.closed).toEqual({ code: 1008, reason: 'token missing' })
  })

  it('closes with 1008 when session.attach carries a wrong token', async () => {
    const { tcpPort } = await start()
    const client = await RpcTestClient.connect(tcpUrl(tcpPort!), okHeaders(tcpPort!))
    void client.attach({ token: 'wrong' })
    expect(await client.closed).toEqual({ code: 1008, reason: 'token mismatch' })
  })

  it('admits the allowed Origin with the right token', async () => {
    const { tcpPort } = await start()
    const client = await RpcTestClient.connect(tcpUrl(tcpPort!), okHeaders(tcpPort!))
    const attached = await client.attach({ token: TOKEN })
    expect(attached.result).toMatchObject({ clientId: expect.any(String) })
    expect((await client.request('session.getLog', {})).result).toEqual({ lines: ['a', 'b'] })
    client.close()
  })

  it('never writes the token into its own log lines', async () => {
    const { tcpPort } = await start()
    const wrong = await RpcTestClient.connect(tcpUrl(tcpPort!), okHeaders(tcpPort!))
    void wrong.attach({ token: `${TOKEN}-x` })
    await wrong.closed
    await expect(RpcTestClient.connect(tcpUrl(tcpPort!), { Origin: 'null' })).rejects.toThrow()
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })
})

describe('D-10 (2) — there is no /mcp on TCP', () => {
  const httpStatus = (port: number, method: string, urlPath: string) =>
    new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: urlPath,
          headers: { Origin: allowedOrigin(port) },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        },
      )
      request.on('error', reject)
      request.end(method === 'POST' ? '{"jsonrpc":"2.0","id":1,"method":"initialize"}' : undefined)
    })

  it('POST /mcp → 404 and GET /mcp → 404', async () => {
    const { tcpPort } = await start()
    expect(await httpStatus(tcpPort!, 'POST', '/mcp')).toBe(404)
    expect(await httpStatus(tcpPort!, 'GET', '/mcp')).toBe(404)
  })

  it('a WebSocket upgrade to /mcp is 404, not a session', async () => {
    const { tcpPort } = await start()
    await expect(
      RpcTestClient.connect(`ws://127.0.0.1:${tcpPort}/mcp`, okHeaders(tcpPort!)),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('D-10 (3) — runtime-dir and socket permissions', () => {
  it('refuses a runtime dir that group or others can read', () => {
    const dir = path.join(tmp, 'wide')
    fs.mkdirSync(dir, { mode: 0o755 })
    fs.chmodSync(dir, 0o755)
    const checked = prepareRuntimeDir(dir)
    expect(checked.ok).toBe(false)
    expect(!checked.ok && checked.reason).toContain('must be mode 0700 (got 755)')
  })

  it('creates a missing runtime dir as 0700', () => {
    const dir = path.join(tmp, 'a', 'b')
    expect(prepareRuntimeDir(dir).ok).toBe(true)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('refuses a runtime dir that is a symbolic link', () => {
    fs.mkdirSync(path.join(tmp, 'real'), { mode: 0o700 })
    fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'))
    expect(prepareRuntimeDir(path.join(tmp, 'link')).ok).toBe(false)
  })

  it('creates the socket as 0600', async () => {
    const { socketPath } = await start(false)
    const stat = fs.statSync(socketPath)
    expect(stat.isSocket()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})

describe('D-10 (4) — the Unix socket /rpc needs no token', () => {
  it('attaches over UDS without a token (and ignores one if sent)', async () => {
    const { socketPath } = await start()
    const client = await RpcTestClient.uds(socketPath)
    expect((await client.attach()).result).toMatchObject({ clientId: expect.any(String) })
    const second = await RpcTestClient.uds(socketPath)
    expect((await second.attach({ token: 'anything' })).result).toBeDefined()
    client.close()
    second.close()
  })

  it('UDS answers 404 to anything but the /rpc upgrade', async () => {
    const { socketPath } = await start(false)
    await expect(RpcTestClient.connect(`ws+unix:${socketPath}:/other`)).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe('handshake and dispatch (design 848 §5.2)', () => {
  it('sends session.hello first, without any secret', async () => {
    const { socketPath } = await start()
    const client = await RpcTestClient.uds(socketPath)
    expect(await client.hello).toEqual({
      protocol_version: '1.0',
      session_version: '0.0.1-test',
      capabilities: [],
    })
    expect(JSON.stringify(await client.hello)).not.toContain(TOKEN)
    client.close()
  })

  it('closes with 1008 when a method arrives before session.attach (on UDS too)', async () => {
    const { socketPath } = await start(false)
    const client = await RpcTestClient.uds(socketPath)
    void client.request('session.getLog', {})
    expect(await client.closed).toEqual({
      code: 1008,
      reason: 'session.getLog before session.attach',
    })
  })

  it('rejects a different MAJOR with PROTOCOL_VERSION_MISMATCH and closes', async () => {
    const { socketPath } = await start(false)
    const client = await RpcTestClient.uds(socketPath)
    const response = await client.attach({ protocol_version: '2.0' })
    expect(response.error).toMatchObject({
      code: -32010,
      data: { code: 'PROTOCOL_VERSION_MISMATCH' },
    })
    expect((await client.closed).code).toBe(1008)
  })

  it('accepts a different MINOR (additions only · RL-5)', async () => {
    const { socketPath } = await start(false)
    const client = await RpcTestClient.uds(socketPath)
    expect((await client.attach({ protocol_version: '1.7' })).result).toBeDefined()
    client.close()
  })

  it('lets two clients attach at once, but only one editor', async () => {
    const { socketPath } = await start(false)
    const editor = await RpcTestClient.uds(socketPath)
    const other = await RpcTestClient.uds(socketPath)
    const third = await RpcTestClient.uds(socketPath)
    const [a, b] = await Promise.all([
      editor.attach({ capabilities: ['editor'] }),
      other.attach({ capabilities: ['observer'] }),
    ])
    expect(a.result).toBeDefined()
    expect(b.result).toBeDefined()
    expect(server!.clients()).toHaveLength(2)
    expect((await third.attach({ capabilities: ['editor'] })).error).toMatchObject({
      code: -32011,
      data: { code: 'EDITOR_ALREADY_ATTACHED' },
    })
    editor.close()
    await editor.closed
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await third.attach({ capabilities: ['editor'] })).result).toBeDefined()
    other.close()
    third.close()
  })

  it('answers unknown, unimplemented and invalid calls with structured errors', async () => {
    const { socketPath } = await start(false)
    const client = await RpcTestClient.uds(socketPath)
    await client.attach()
    expect((await client.request('no.such.method')).error).toMatchObject({ code: -32601 })
    expect((await client.request('plugin.list')).error).toMatchObject({
      code: -32601,
      data: { code: 'METHOD_NOT_FOUND', detail: expect.stringContaining('without a handler') },
    })
    // `lines` は小数・0・負も受ける（凍結版の get_log と同じ・S-mcp の N1-b1）。型の違いは拒む。
    expect((await client.request('session.getLog', { lines: 'ten' })).error).toMatchObject({
      code: -32602,
      data: { code: 'INVALID_PARAMS' },
    })
    expect((await client.request('session.getState')).error).toMatchObject({
      code: -32031,
      data: { code: 'ENGINE_NOT_RUNNING' },
    })
    client.close()
  })

  it('refuses to put a result outside the schema on the wire', async () => {
    const { socketPath } = await start(false)
    const client = await RpcTestClient.uds(socketPath)
    await client.attach()
    expect((await client.request('engine.stop')).error).toMatchObject({ code: -32603 })
    expect(logs.join('\n')).toContain('engine.stop produced a result outside the schema')
    client.close()
  })

  it('answers a frame that is not JSON-RPC with PARSE_ERROR / INVALID_REQUEST', async () => {
    const { socketPath } = await start(false)
    const client = await RpcTestClient.uds(socketPath)
    const replies: any[] = []
    client.ws.on('message', (data) => replies.push(JSON.parse(data.toString())))
    client.ws.send('not json')
    client.ws.send(JSON.stringify({ id: 1, method: 'x' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(replies.map((reply) => reply.error?.code).filter(Boolean)).toEqual([-32700, -32600])
    client.close()
  })

  it('broadcasts notifications to attached clients only, and only in the schema shape', async () => {
    const { socketPath } = await start(false)
    const attached = await RpcTestClient.uds(socketPath)
    const waiting = await RpcTestClient.uds(socketPath)
    await attached.attach()
    await waiting.hello
    server!.broadcast('transport.state', { playing: true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(attached.notifications.filter((n) => n.method === 'transport.state')).toEqual([
      { method: 'transport.state', params: { playing: true } },
    ])
    expect(waiting.notifications.filter((n) => n.method === 'transport.state')).toEqual([])
    expect(() => server!.broadcast('transport.state', { playing: 'yes' })).toThrow(
      /outside the schema/,
    )
    attached.close()
    waiting.close()
  })
})

describe('runtime dir — stale and live sockets, path length (design 848 §4.7)', () => {
  it('replaces a socket left behind by a crashed session', async () => {
    const dir = path.join(tmp, 'run')
    prepareRuntimeDir(dir)
    const stale = path.join(dir, 'session.sock')
    // 正常に閉じると libuv がソケットのファイルを消すので、listen したプロセスを SIGKILL で落とす。
    const child = spawn(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(stale)}, () => console.log('up'))`,
    ])
    await new Promise((resolve) => child.stdout.once('data', resolve))
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
    expect(fs.lstatSync(stale).isSocket()).toBe(true)
    expect(await claimSocketPath(stale)).toEqual({ ok: true })
    expect(fs.existsSync(stale)).toBe(false)
  })

  it('refuses to start when another session answers on the socket', async () => {
    const { socketPath } = await start(false)
    const claimed = await claimSocketPath(socketPath)
    expect(claimed.ok).toBe(false)
    expect(!claimed.ok && claimed.reason).toContain('another session is already running')
  })

  it('refuses a socket path longer than the platform limit, and falls back on macOS', () => {
    const long = path.join('/tmp', 'x'.repeat(120))
    expect(resolveSocketPath(long, { platform: 'linux' }).ok).toBe(false)
    const fallback = resolveSocketPath(long, {
      platform: 'darwin',
      darwinUserTempDir: () => '/var/folders/ab/cd/T',
    })
    expect(fallback).toEqual({
      ok: true,
      socketPath: '/var/folders/ab/cd/T/OrbitStudio/session.sock',
      dir: '/var/folders/ab/cd/T/OrbitStudio',
    })
    const limitHit = resolveSocketPath(long, {
      platform: 'darwin',
      darwinUserTempDir: () => path.join('/v', 'y'.repeat(100)),
    })
    expect(!limitHit.ok && limitHit.reason).toContain('longer than 103 bytes')
  })
})
