/**
 * `orbitscore session` を**実際のプロセス**として起こして確かめる（設計 848 §12 F-1・F-12 の層 2 側）。
 *
 * build 前でも回るように vite-node で `packages/session/src/cli.ts` を起こす（`npm test` は build より
 * 前に走る）。daemon も音も無い — engine は起動しない。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpcTestClient } from './helpers/rpc-test-client'

const repoRoot = path.resolve(__dirname, '../..')
const VITE_NODE = path.join(repoRoot, 'node_modules/.bin/vite-node')
const CLI = path.join(repoRoot, 'packages/session/src/cli.ts')

interface SessionProcess {
  child: ChildProcess
  ready: Promise<Record<string, any>>
  stderr: () => string
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

const children: ChildProcess[] = []

function spawnSession(
  args: string[],
  stdin: 'pipe' | 'ignore' = 'pipe',
  env: NodeJS.ProcessEnv = process.env,
): SessionProcess {
  const child = spawn(VITE_NODE, ['--config', 'vitest.config.ts', CLI, 'session', ...args], {
    cwd: repoRoot,
    stdio: [stdin, 'pipe', 'pipe'],
    env,
  })
  children.push(child)
  let stderr = ''
  child.stderr!.on('data', (chunk) => (stderr += chunk))
  const lines = readline.createInterface({ input: child.stdout! })
  const ready = new Promise<Record<string, any>>((resolve, reject) => {
    lines.once('line', (line) => resolve(JSON.parse(line)))
    child.once('exit', () => reject(new Error(`session exited before ready: ${stderr}`)))
  })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  )
  return { child, ready, stderr: () => stderr, exit }
}

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
  ])

let tmp: string
let runtimeDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-proc-'))
  runtimeDir = path.join(tmp, 'r')
})

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('F-1 — the session process ends when its parent is gone (design 848 §4.4)', () => {
  it('closing the stdin pipe makes it shut down through the session.shutdown path', async () => {
    const session = spawnSession(['--runtime-dir', runtimeDir])
    const ready = await session.ready
    const client = await RpcTestClient.uds(ready.socket)
    await client.attach()
    session.child.stdin!.end()
    expect(await within(session.exit, 10_000)).toEqual({ code: 0, signal: null })
    expect(session.stderr()).toContain('[session] shutting down: stdin closed (parent gone)')
    expect(fs.existsSync(ready.socket)).toBe(false)
  }, 20_000)

  it('ends when the --parent-pid process dies, even with stdin held open', async () => {
    const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    children.push(parent)
    const session = spawnSession(['--runtime-dir', runtimeDir, '--parent-pid', String(parent.pid)])
    await session.ready
    parent.kill('SIGKILL')
    expect(await within(session.exit, 10_000)).toEqual({ code: 0, signal: null })
    expect(session.stderr()).toContain(`parent ${parent.pid} is gone`)
  }, 20_000)

  it('does not treat EOF as the parent dying when stdin is not a pipe; SIGTERM still shuts down', async () => {
    const session = spawnSession(['--runtime-dir', runtimeDir], 'ignore')
    await session.ready
    expect(await within(session.exit, 1_500)).toBe('timeout')
    session.child.kill('SIGTERM')
    expect(await within(session.exit, 10_000)).toEqual({ code: 0, signal: null })
  }, 20_000)
})

describe('F-12 (layer 2 side) — a session killed with SIGKILL can be started again in place', () => {
  it('restarts on the same runtime dir, port and token file, and clients re-attach', async () => {
    const tokenFile = path.join(tmp, 'token')
    fs.writeFileSync(tokenFile, 't'.repeat(43), { mode: 0o600 })
    const first = spawnSession([
      '--runtime-dir',
      runtimeDir,
      '--port',
      '0',
      '--token-file',
      tokenFile,
    ])
    const ready = await first.ready
    first.child.kill('SIGKILL')
    await first.exit
    // SIGKILL ではソケットのファイルが残る（取り残し）。次の起動が掃除する。
    expect(fs.lstatSync(ready.socket).isSocket()).toBe(true)

    const second = spawnSession([
      '--runtime-dir',
      runtimeDir,
      '--port',
      String(ready.port),
      '--token-file',
      tokenFile,
    ])
    const again = await second.ready
    expect(again).toEqual({ ...ready })
    const client = await RpcTestClient.uds(again.socket)
    expect((await client.attach()).result).toBeDefined()
    expect((await client.request('session.getState', {})).result).toMatchObject({
      engine: { running: false },
      workspaceRoot: null,
    })
    client.close()
    second.child.stdin!.end()
    expect(await within(second.exit, 10_000)).toEqual({ code: 0, signal: null })
  }, 30_000)
})

describe('the real InterpreterV2 is wired behind engine.start', () => {
  it('reports a daemon that dies before ready as a failed start, and keeps refusing to evaluate', async () => {
    // どの機械でも同じ結果にするため、daemon の代わりに即座に終わる実行ファイルを指す
    // （存在しないパスを指すと、daemon-client はモノレポのビルドへ落ちて本物を起こしうる）。
    const falseBinary = fs.existsSync('/usr/bin/false') ? '/usr/bin/false' : '/bin/false'
    const session = spawnSession(['--runtime-dir', runtimeDir], 'pipe', {
      ...process.env,
      ORBIT_AUDIO_DAEMON_PATH: falseBinary,
    })
    const ready = await session.ready
    const client = await RpcTestClient.uds(ready.socket)
    await client.attach()
    const started = await client.request('engine.start', {})
    expect(started.result).toMatchObject({
      ok: false,
      error: expect.stringContaining('engine failed to start'),
    })
    expect((await client.request('engine.getState', {})).result).toEqual({
      running: false,
      liveCoding: false,
    })
    expect(
      (
        await client.request('session.evaluate', {
          code: 'global.tempo(120)',
          documentDirectory: null,
          source: 'agent',
        })
      ).error,
    ).toMatchObject({ code: -32031 })
    client.close()
    session.child.stdin!.end()
    expect(await within(session.exit, 10_000)).toEqual({ code: 0, signal: null })
  }, 30_000)
})
