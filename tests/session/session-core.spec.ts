/**
 * 層 2 の芯（`SessionCore` + `EngineHost`）を、偽の interpreter と本物の RPC サーバで確かめる。
 *
 * daemon も音も無い（Linux で完結）。音が出ることの確認は束 S-rpc の検算（手元・macOS）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  captureConsole,
  parseStepLine,
  transportChange,
} from '../../packages/session/src/host/console-capture'
import { EngineHost, type EngineInterpreter } from '../../packages/session/src/host/engine-host'
import { SessionCore } from '../../packages/session/src/host/session-core'
import {
  claimSocketPath,
  prepareRuntimeDir,
  resolveSocketPath,
} from '../../packages/session/src/rpc/runtime-dir'
import { startRpcServer, type RpcServer } from '../../packages/session/src/rpc/server'

import { fakeExecuteStatements } from './helpers/fake-execute-statements'
import { RpcTestClient } from './helpers/rpc-test-client'

interface FakeEngine {
  interpreter: EngineInterpreter
  executed: string[]
  calls: string[]
  release(): void
}

function fakeInterpreter(
  options: { slowOn?: string; failBoot?: boolean; status?: unknown } = {},
): FakeEngine {
  const executed: string[] = []
  const calls: string[] = []
  let release: () => void = () => {}
  const global = {
    stop: (opts: unknown) => calls.push(`global.stop ${JSON.stringify(opts)}`),
    saveAllPluginStates: async () => {
      calls.push('saveAllPluginStates')
      return { saved: 0, failures: 0 }
    },
  }
  const interpreter = {
    boot: async (device?: string) => {
      calls.push(`boot ${device ?? '(default)'}`)
      if (options.failBoot) throw new Error('daemon exited before ready')
    },
    executeStatements: fakeExecuteStatements(async (source) => {
      if (options.slowOn && source.includes(options.slowOn)) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      executed.push(source)
    }),
    getGlobals: () => [global],
    audioEngine: {
      quit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        calls.push('quit')
      },
      getDaemonStatus: async () =>
        options.status ?? { output: { device: 'x' }, callback: { n: 1 } },
    },
    enableSessionLog: () => calls.push('enableSessionLog'),
  } as unknown as EngineInterpreter
  return { interpreter, executed, calls, release: () => release() }
}

let tmp: string
let server: RpcServer | null
let core: SessionCore | null
let env: NodeJS.ProcessEnv

async function startSession(engine: FakeEngine, workspaceRoot: string | null = '/ws') {
  const dir = path.join(tmp, 'run')
  prepareRuntimeDir(dir)
  const socket = resolveSocketPath(dir)
  if (!socket.ok) throw new Error(socket.reason)
  await claimSocketPath(socket.socketPath)
  const host = new EngineHost({
    createInterpreter: () => engine.interpreter,
    env,
    defaultHostBundleId: 'com.signalcompose.orbitstudio',
    sessionLogCwd: '/ws',
    sessionLogEnabled: false,
    log: (level, text) => core?.sessionLog(level, text),
  })
  let rpc: RpcServer | null = null
  core = new SessionCore({
    engine: host,
    workspaceRoot,
    broadcast: (method, params) => rpc?.broadcast(method, params),
    editorAttached: () => rpc?.editorClient() !== null && rpc?.editorClient() !== undefined,
    requestEditor: (method, params) => rpc!.requestEditor(method, params),
    captureConsole: false,
  })
  rpc = await startRpcServer({
    socketPath: socket.socketPath,
    sessionVersion: 'test',
    handlers: core.handlers,
    log: (level, text) => core!.sessionLog(level, text),
  })
  server = rpc
  return { host, socketPath: socket.socketPath }
}

async function attached(socketPath: string): Promise<RpcTestClient> {
  const client = await RpcTestClient.uds(socketPath)
  await client.attach()
  return client
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-core-'))
  server = null
  core = null
  env = {}
})

afterEach(async () => {
  core?.dispose()
  await server?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('session.evaluate over the socket (design 848 §5.3.1)', () => {
  it('refuses to evaluate before engine.start with ENGINE_NOT_RUNNING (no implicit boot)', async () => {
    const engine = fakeInterpreter()
    const { socketPath } = await startSession(engine)
    const client = await attached(socketPath)
    const response = await client.request('session.evaluate', {
      code: 'global.tempo(120)',
      documentDirectory: null,
      source: 'agent',
    })
    expect(response.error).toMatchObject({
      code: -32031,
      message: 'engine is not running — start the engine first',
    })
    expect(engine.calls).toEqual([])
    client.close()
  })

  it('evaluates after engine.start and answers ok / evalId / diagnostics / documentDirectory', async () => {
    const engine = fakeInterpreter()
    const { socketPath } = await startSession(engine)
    const client = await attached(socketPath)
    expect((await client.request('engine.start', {})).result).toEqual({
      ok: true,
      message: 'engine started',
    })
    const ok = await client.request('session.evaluate', {
      code: 'global.tempo(120)\nglobal.start()',
      documentDirectory: '/ws/piece',
      source: 'human',
      target: { uri: 'file:///ws/piece/a.orbs' },
    })
    expect(ok.result).toEqual({
      ok: true,
      evalId: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      diagnostics: [],
      documentDirectory: '/ws/piece',
    })
    expect(engine.executed).toEqual(['global.tempo(120)', 'global.start()'])
    expect(core!.targetOf((ok.result as { evalId: string }).evalId)).toEqual({
      uri: 'file:///ws/piece/a.orbs',
    })
    const bad = await client.request('session.evaluate', {
      code: 'global.play(([1, 5, 9]@v+10, 0))',
      documentDirectory: null,
      source: 'agent',
    })
    expect(bad.result).toMatchObject({
      ok: false,
      diagnostics: [
        { kind: 'parse', message: expect.stringContaining('Expected RPAREN but got AT') },
      ],
      documentDirectory: null,
    })
    client.close()
  })

  it('serves every client from one FIFO (a later client waits for an earlier slow one)', async () => {
    const engine = fakeInterpreter({ slowOn: 'global.start' })
    const { socketPath } = await startSession(engine)
    const human = await attached(socketPath)
    const agent = await attached(socketPath)
    await human.request('engine.start', {})
    const first = human.request('session.evaluate', {
      code: 'global.start()',
      documentDirectory: null,
      source: 'human',
    })
    await settle()
    const second = agent.request('session.evaluate', {
      code: 'kick.play(1)',
      documentDirectory: null,
      source: 'agent',
    })
    await settle()
    expect(engine.executed).toEqual([])
    engine.release()
    await Promise.all([first, second])
    expect(engine.executed).toEqual(['global.start()', 'kick.play(1)'])
    human.close()
    agent.close()
  })

  it('rejects a target with a range but no version (INVALID_PARAMS)', async () => {
    const { socketPath } = await startSession(fakeInterpreter())
    const client = await attached(socketPath)
    const response = await client.request('session.evaluate', {
      code: 'x',
      documentDirectory: null,
      source: 'human',
      target: {
        uri: 'file:///a.orbs',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    })
    expect(response.error).toMatchObject({ code: -32602 })
    client.close()
  })
})

describe('engine output → log.line / transport.step / transport.state (P-07)', () => {
  it('turns [STEP] into transport.step (source null) and keeps it out of the normal ring', async () => {
    const { socketPath } = await startSession(fakeInterpreter())
    const client = await attached(socketPath)
    core!.onEngineLine('stdout', '[STEP] kick 0.1 1700000000123')
    await settle()
    expect(client.notifications.filter((n) => n.method === 'transport.step')).toEqual([
      {
        method: 'transport.step',
        params: { seq: 'kick', argPath: '0.1', atEpochMs: 1700000000123, source: null },
      },
    ])
    expect((await client.request('session.getLog', {})).result).toEqual({ lines: [] })
    client.close()
  })

  it('keeps [STEP] in the ring when the engine was started with debug (the gated playhead test reads it)', async () => {
    const { socketPath } = await startSession(fakeInterpreter())
    const client = await attached(socketPath)
    await client.request('engine.start', { debug: true })
    core!.onEngineLine('stdout', '[STEP] kick 0 1700000000000')
    expect((await client.request('session.getLog', {})).result).toEqual({
      lines: ['[STEP] kick 0 1700000000000'],
    })
    client.close()
  })

  it('broadcasts transport.state only on a change', async () => {
    const { socketPath } = await startSession(fakeInterpreter())
    const client = await attached(socketPath)
    core!.onEngineLine('stdout', '✅ Global running')
    core!.onEngineLine('stdout', '✅ Global running')
    core!.onEngineLine('stdout', '✅ Global stopped')
    await settle()
    expect(
      client.notifications.filter((n) => n.method === 'transport.state').map((n) => n.params),
    ).toEqual([{ playing: true }, { playing: false }])
    expect((await client.request('session.getState', {})).result).toMatchObject({
      transport: { playing: false },
      workspaceRoot: '/ws',
      documents: [],
      editorAttached: false,
    })
    client.close()
  })

  it('attributes engine lines printed during an evaluation to its evalId and client', async () => {
    const engine = fakeInterpreter()
    const original = engine.interpreter.executeStatements
    ;(engine.interpreter as { executeStatements: unknown }).executeStatements = async (
      request: never,
      opts: never,
      hooks: never,
    ) => {
      core!.onEngineLine('stdout', '🎚️ kick: play=[1,0] (next cycle)')
      return (original as (a: never, b: never, c: never) => Promise<unknown>)(request, opts, hooks)
    }
    const { socketPath } = await startSession(engine)
    const client = await attached(socketPath)
    await client.request('engine.start', {})
    const result = (
      await client.request('session.evaluate', {
        code: 'kick.play(1, 0)',
        documentDirectory: null,
        source: 'agent',
      })
    ).result as { evalId: string }
    const attachedId = server!.clients()[0]!.clientId
    await settle()
    const line = client.notifications.find(
      (n) => n.method === 'log.line' && n.params.kind === 'engine',
    )
    expect(line?.params).toMatchObject({
      level: 'info',
      text: '🎚️ kick: play=[1,0] (next cycle)',
      evalId: result.evalId,
      clientId: attachedId,
    })
    client.close()
  })

  it('reports a parse error as log.line kind=diagnostic and keeps the frozen ring string', async () => {
    const { socketPath } = await startSession(fakeInterpreter())
    const client = await attached(socketPath)
    await client.request('engine.start', {})
    await client.request('session.evaluate', {
      code: 'global.play(([1, 5, 9]@v+10, 0))',
      documentDirectory: null,
      source: 'human',
    })
    await settle()
    expect(client.notifications.find((n) => n.method === 'log.line')?.params).toMatchObject({
      level: 'error',
      kind: 'diagnostic',
      text: '[ERROR] Expected RPAREN but got AT at line 1, column 23',
    })
    expect((await client.request('session.getLog', {})).result).toEqual({
      lines: ['ERROR: [ERROR] Expected RPAREN but got AT at line 1, column 23'],
    })
    client.close()
  })
})

describe('EngineHost (design 848 §4.5 · §5.3.2)', () => {
  it('maps the start params onto the environment the daemon inherits, and boots with the device', async () => {
    const engine = fakeInterpreter()
    const host = new EngineHost({
      createInterpreter: () => engine.interpreter,
      env,
      defaultHostBundleId: 'com.signalcompose.orbitstudio',
      sessionLogCwd: '/ws',
      sessionLogEnabled: true,
      log: () => {},
    })
    expect(await host.start({ captureWav: '/tmp/c.wav', debug: true, audioDevice: 'Out' })).toEqual(
      {
        ok: true,
        message: 'engine started (capturing to /tmp/c.wav)',
      },
    )
    expect(env).toEqual({
      ORBIT_CAPTURE_WAV: '/tmp/c.wav',
      ORBITSCORE_DEBUG: '1',
      ORBIT_HOST_BUNDLE_ID: 'com.signalcompose.orbitstudio',
    })
    expect(engine.calls).toEqual(['enableSessionLog', 'boot Out'])
    await host.stop()
    await host.start({ hostBundleId: 'com.example.other' })
    expect(env).toEqual({ ORBIT_HOST_BUNDLE_ID: 'com.example.other' })
  })

  it('does not drop spawn-only options on a running engine (#528)', async () => {
    const host = new EngineHost({
      createInterpreter: () => fakeInterpreter().interpreter,
      env,
      sessionLogCwd: '/ws',
      sessionLogEnabled: false,
      log: () => {},
    })
    await host.start({})
    const rejected = await host.start({ captureWav: '/tmp/c.wav' })
    expect(rejected.ok).toBe(false)
    expect(!rejected.ok && rejected.error).toContain('stop_engine')
    expect(await host.start({})).toEqual({ ok: true, message: 'engine already running' })
  })

  it('reports a boot failure without keeping a half-started engine', async () => {
    const engine = fakeInterpreter({ failBoot: true })
    const host = new EngineHost({
      createInterpreter: () => engine.interpreter,
      env,
      sessionLogCwd: '/ws',
      sessionLogEnabled: false,
      log: () => {},
    })
    expect(await host.start({})).toEqual({
      ok: false,
      error: 'engine failed to start: daemon exited before ready',
    })
    expect(host.running).toBe(false)
    expect(engine.calls).toContain('quit')
  })

  it('stops in the frozen shutdown order and answers only after the daemon is quit', async () => {
    const engine = fakeInterpreter()
    const host = new EngineHost({
      createInterpreter: () => engine.interpreter,
      env,
      sessionLogCwd: '/ws',
      sessionLogEnabled: false,
      log: () => {},
    })
    await host.start({})
    engine.calls.length = 0
    expect(await host.stop()).toEqual({ ok: true, message: 'engine stopped' })
    expect(engine.calls).toEqual([
      'global.stop {"autoSnapshot":false}',
      'saveAllPluginStates',
      'quit',
    ])
    expect(await host.stop()).toEqual({ ok: true, message: 'engine already stopped' })
  })

  it('reads the daemon status within a budget and reports a slow daemon as statusError', async () => {
    const engine = fakeInterpreter()
    const host = new EngineHost({
      createInterpreter: () => engine.interpreter,
      env,
      sessionLogCwd: '/ws',
      sessionLogEnabled: false,
      log: () => {},
    })
    expect(await host.getState()).toEqual({ running: false, liveCoding: false })
    await host.start({})
    expect(await host.getState()).toEqual({
      running: true,
      liveCoding: true,
      output: { device: 'x' },
      callback: { n: 1 },
    })
    ;(engine.interpreter.audioEngine as { getDaemonStatus: unknown }).getDaemonStatus = () =>
      new Promise(() => {})
    expect(await host.getState(30)).toEqual({
      running: true,
      liveCoding: true,
      statusError: 'timed out after 30ms waiting for the daemon status',
    })
  })
})

describe('console capture (P-07)', () => {
  it('splits formatted output into non-empty lines per stream and restores the console', () => {
    const lines: string[] = []
    const target = { log: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }
    const release = captureConsole((stream, text) => lines.push(`${stream}:${text}`), {
      target: target as unknown as Console,
    })
    ;(target as unknown as Console).log('a %s', 'b', '\n\nc')
    ;(target as unknown as Console).warn('w')
    ;(target as unknown as Console).error({ x: 1 })
    release()
    expect(lines).toEqual(['stdout:a b ', 'stdout:c', 'stderr:w', 'stderr:{ x: 1 }'])
    expect(typeof target.log).toBe('function')
  })

  it('parses the engine [STEP] grammar and the transport words', () => {
    expect(parseStepLine('[STEP] kick 0.1 1700000000000')).toEqual({
      seq: 'kick',
      argPath: '0.1',
      atEpochMs: 1700000000000,
    })
    expect(parseStepLine('[STEP] broken')).toBeNull()
    expect(transportChange('▶ Global')).toBe('playing')
    expect(transportChange('⏹ Global')).toBe('ready')
    expect(transportChange('🎚️ kick')).toBeNull()
  })
})
