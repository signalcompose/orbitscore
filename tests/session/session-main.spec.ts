/**
 * `orbitscore session` の入口（`packages/session/src/session-main.ts`）を in-process で確かめる
 * （設計 848 §4.4 の ready 行・§4.7 のトークンファイル・§12 F-1 の機構・`/app/` の配信）。
 * 実プロセスでの F-1 / F-12 は `session-process.spec.ts`。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { EngineInterpreter } from '../../packages/session/src/host/engine-host'
import { allowedOrigin } from '../../packages/session/src/rpc/http-guard'
import {
  parseSessionArgs,
  PARENT_PID_POLL_MS,
  readTokenFile,
  startSession,
  type RunningSession,
  type SessionIo,
} from '../../packages/session/src/session-main'

import { fakeExecuteStatements } from './helpers/fake-execute-statements'
import { RpcTestClient } from './helpers/rpc-test-client'

interface FakeIo extends SessionIo {
  out: string[]
  err: string[]
  signals: Map<string, () => void>
  stdinStream: PassThrough
  alive: Set<number>
  quits: number
}

function fakeIo(overrides: Partial<SessionIo> = {}): FakeIo {
  const out: string[] = []
  const err: string[] = []
  const signals = new Map<string, () => void>()
  const stdinStream = new PassThrough()
  const alive = new Set<number>()
  const io: FakeIo = {
    out,
    err,
    signals,
    stdinStream,
    alive,
    quits: 0,
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    stdin: stdinStream,
    stdinIsPipe: true,
    env: {},
    onSignal: (signal, handler) => signals.set(signal, handler),
    isAlive: (pid) => alive.has(pid),
    createInterpreter: () =>
      ({
        boot: async () => {},
        executeStatements: fakeExecuteStatements(),
        getGlobals: () => [],
        audioEngine: {
          quit: async () => {
            io.quits++
          },
        },
      }) as unknown as EngineInterpreter,
    sessionVersion: '0.0.1-test',
    ...overrides,
  }
  return io
}

let tmp: string
let running: RunningSession | null

async function start(argv: string[], io = fakeIo()) {
  const started = await startSession(['--runtime-dir', path.join(tmp, 'run'), ...argv], io)
  if (started.ok) running = started.session
  return { started, io }
}

const readyOf = (io: FakeIo) => JSON.parse(io.out[0]!) as Record<string, unknown>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-main-'))
  running = null
})

afterEach(async () => {
  await running?.shutdown('test teardown')
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('parseSessionArgs', () => {
  it('reads every flag and keeps --docs-dir in order (first wins)', () => {
    const parsed = parseSessionArgs([
      '--port',
      '0',
      '--docs-dir',
      '/a',
      '--docs-dir',
      '/b',
      '--parent-pid',
      '42',
      '--workspace-root',
      '/ws',
      '--host-bundle-id',
      'com.x',
      '--web-dir',
      '/web',
    ])
    expect(parsed).toEqual({
      ok: true,
      value: {
        port: 0,
        docsDirs: ['/a', '/b'],
        parentPid: 42,
        workspaceRoot: '/ws',
        hostBundleId: 'com.x',
        webDir: '/web',
      },
    })
  })

  it.each([
    [['--mcp'], 'unknown argument: --mcp'],
    [['--port'], '--port needs a value'],
    [['--port', '70000'], '--port must be an integer from 0 to 65535: 70000'],
    [['--parent-pid', '-1'], '--parent-pid must be a positive integer: -1'],
  ])('rejects %j', (argv, message) => {
    expect(parseSessionArgs(argv)).toEqual({ ok: false, message })
  })
})

describe('the ready line (design 848 §4.4)', () => {
  it('without --port: socket only, port and token are null', async () => {
    const { started, io } = await start([])
    expect(started.ok).toBe(true)
    expect(readyOf(io)).toEqual({
      ready: true,
      socket: path.join(tmp, 'run', 'session.sock'),
      port: null,
      protocol_version: '1.1',
      token: null,
    })
  })

  it('with --port 0: the bound port and a fresh 32-byte token, and nothing else on stdout', async () => {
    const { io } = await start(['--port', '0'])
    const ready = readyOf(io)
    expect(ready.port).toEqual(expect.any(Number))
    expect((ready.port as number) > 0).toBe(true)
    expect(ready.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const client = await RpcTestClient.uds(ready.socket as string)
    await client.attach()
    await client.request('session.getLog', {})
    client.close()
    expect(io.out).toHaveLength(1)
  })

  it('uses the token from --token-file so a restart keeps the same token (F-12)', async () => {
    const tokenFile = path.join(tmp, 'token')
    fs.writeFileSync(tokenFile, 'a'.repeat(40), { mode: 0o600 })
    const { io } = await start(['--port', '0', '--token-file', tokenFile])
    const ready = readyOf(io)
    expect(ready.token).toBe('a'.repeat(40))
    const client = await RpcTestClient.connect(`ws://127.0.0.1:${ready.port}/rpc`, {
      Origin: allowedOrigin(ready.port as number),
    })
    expect((await client.attach({ token: 'a'.repeat(40) })).result).toBeDefined()
    client.close()
  })
})

describe('startup failures go to stderr as {"ready":false} without secrets', () => {
  const failureOf = (io: FakeIo) =>
    JSON.parse(io.err[0]!) as { ready: false; error: { code: string } }

  it('refuses a runtime dir others can read', async () => {
    fs.mkdirSync(path.join(tmp, 'run'), { mode: 0o755 })
    fs.chmodSync(path.join(tmp, 'run'), 0o755)
    const { started, io } = await start([])
    expect(started).toEqual({ ok: false, exitCode: 1 })
    expect(failureOf(io).error.code).toBe('RUNTIME_DIR_UNSAFE')
    expect(io.out).toEqual([])
  })

  it('refuses to start next to a live session on the same runtime dir (E12)', async () => {
    await start([])
    const second = fakeIo()
    const { started } = await start([], second)
    expect(started).toEqual({ ok: false, exitCode: 1 })
    expect(failureOf(second).error.code).toBe('SESSION_ALREADY_RUNNING')
  })

  it('refuses a token file others can read, without echoing its content', async () => {
    const tokenFile = path.join(tmp, 'token')
    fs.writeFileSync(tokenFile, 's'.repeat(40), { mode: 0o644 })
    fs.chmodSync(tokenFile, 0o644)
    const { started, io } = await start(['--port', '0', '--token-file', tokenFile])
    expect(started.ok).toBe(false)
    expect(failureOf(io).error.code).toBe('TOKEN_FILE_UNSAFE')
    expect(io.err.join('')).not.toContain('s'.repeat(40))
  })

  it('reports bad arguments with exit code 2', async () => {
    const { started, io } = await start(['--mcp', 'x'])
    expect(started).toEqual({ ok: false, exitCode: 2 })
    expect(failureOf(io).error.code).toBe('BAD_ARGUMENTS')
  })

  it('a short token file is refused', () => {
    const tokenFile = path.join(tmp, 'short')
    fs.writeFileSync(tokenFile, 'abc', { mode: 0o600 })
    expect(readTokenFile(tokenFile).ok).toBe(false)
  })
})

describe('F-1 — the session ends when its parent is gone (design 848 §4.4)', () => {
  it('stdin EOF on a pipe takes the shutdown path (engine quit, socket removed, exit 0)', async () => {
    const io = fakeIo()
    const { started } = await start([], io)
    if (!started.ok) throw new Error('did not start')
    const client = await RpcTestClient.uds(readyOf(io).socket as string)
    await client.attach()
    await client.request('engine.start', {})
    io.stdinStream.end()
    expect(await started.session.exited).toBe(0)
    expect(io.quits).toBe(1)
    expect(fs.existsSync(readyOf(io).socket as string)).toBe(false)
    running = null
  })

  it('ignores EOF when stdin is not a pipe (a terminal or /dev/null)', async () => {
    const io = fakeIo({ stdinIsPipe: false })
    const { started } = await start([], io)
    if (!started.ok) throw new Error('did not start')
    io.stdinStream.end()
    const outcome = await Promise.race([
      started.session.exited.then(() => 'exited'),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 100)),
    ])
    expect(outcome).toBe('still running')
  })

  it('ends when the --parent-pid process disappears', async () => {
    const io = fakeIo()
    io.alive.add(4242)
    const { started } = await start(['--parent-pid', '4242'], io)
    if (!started.ok) throw new Error('did not start')
    io.alive.delete(4242)
    const code = await Promise.race([
      started.session.exited,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), PARENT_PID_POLL_MS * 3)),
    ])
    expect(code).toBe(0)
    running = null
  }, 10_000)

  it('SIGTERM and session.shutdown take the same path', async () => {
    const io = fakeIo()
    const { started } = await start([], io)
    if (!started.ok) throw new Error('did not start')
    io.signals.get('SIGTERM')!()
    expect(await started.session.exited).toBe(0)

    const io2 = fakeIo()
    const second = await start([], io2)
    if (!second.started.ok) throw new Error('did not start')
    const client = await RpcTestClient.uds(readyOf(io2).socket as string)
    await client.attach()
    expect((await client.request('session.shutdown', {})).result).toEqual({})
    expect(await second.started.session.exited).toBe(0)
    running = null
  })
})

describe('the TCP listener serves the WebView bundle at /app/ (design 848 §7.3)', () => {
  const get = (port: number, urlPath: string, host = `127.0.0.1:${port}`) =>
    new Promise<{ status: number; csp?: string; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: urlPath, headers: { Host: host } }, (response) => {
          let body = ''
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              csp: response.headers['content-security-policy'] as string | undefined,
              body,
            }),
          )
        })
        .on('error', reject)
    })

  it('serves files under --web-dir with frame-ancestors none, and nothing outside it', async () => {
    const web = path.join(tmp, 'web')
    fs.mkdirSync(path.join(web, 'js'), { recursive: true })
    fs.writeFileSync(path.join(web, 'index.html'), '<h1>app</h1>')
    fs.writeFileSync(path.join(web, 'js', 'a.js'), 'x')
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret')
    const { io } = await start(['--port', '0', '--web-dir', web])
    const port = readyOf(io).port as number
    expect(await get(port, '/app/')).toMatchObject({
      status: 200,
      csp: "frame-ancestors 'none'",
      body: '<h1>app</h1>',
    })
    expect((await get(port, '/app/js/a.js')).status).toBe(200)
    expect((await get(port, '/app/../secret.txt')).body).not.toContain('secret')
    expect((await get(port, '/app/%2e%2e/secret.txt')).body).not.toContain('secret')
    expect((await get(port, '/app/', `evil.example:${port}`)).status).toBe(403)
    expect((await get(port, '/mcp')).status).toBe(404)
  })

  it('answers 404 at /app/ without --web-dir', async () => {
    const { io } = await start(['--port', '0'])
    expect((await get(readyOf(io).port as number, '/app/')).status).toBe(404)
  })
})

describe('D-10 (5) — the TCP token appears nowhere but the ready line', () => {
  it('rejected attaches do not put the token into get_log or stderr', async () => {
    const io = fakeIo()
    const { started } = await start(['--port', '0'], io)
    if (!started.ok) throw new Error('did not start')
    const ready = readyOf(io)
    const token = ready.token as string
    const wrong = await RpcTestClient.connect(`ws://127.0.0.1:${ready.port}/rpc`, {
      Origin: allowedOrigin(ready.port as number),
    })
    void wrong.attach({ token: `${token}x` })
    await wrong.closed
    const client = await RpcTestClient.uds(ready.socket as string)
    await client.attach()
    const log = (await client.request('session.getLog', { lines: 1000 })).result as {
      lines: string[]
    }
    expect(log.lines.join('\n')).toContain('token mismatch')
    expect(log.lines.join('\n')).not.toContain(token)
    expect(io.err.join('')).not.toContain(token)
    expect(io.out.slice(1).join('')).toBe('')
    client.close()
  })
})

describe('plugin catalog flags override the environment (design 848 §4.5)', () => {
  it('writes --plugin-catalog / --plugin-scan-path into the environment children inherit', async () => {
    const io = fakeIo({ env: { ORBIT_PLUGIN_CATALOG: '/env/catalog.json' } })
    await start(
      ['--plugin-catalog', '/flag/catalog.json', '--plugin-scan-path', '/flag/plugins'],
      io,
    )
    expect(io.env.ORBIT_PLUGIN_CATALOG).toBe('/flag/catalog.json')
    expect(io.env.ORBIT_PLUGIN_SCAN_PATH).toBe('/flag/plugins')
  })
})
