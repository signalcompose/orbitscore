/**
 * 層 2 の audio・plugin・docs のメソッド（設計 848 §5.3.2・§5.3.3・§5.3.5）を、偽の interpreter と
 * 本物の RPC サーバで確かめる。戻りはサーバがスキーマで検証するので、形の誤りは INTERNAL_ERROR で落ちる。
 *
 * 期待値の文言は凍結版の MCP ハンドラ（`packages/vscode-extension/src/agent-handlers.ts` /
 * `plugin-commands.ts`）から写した — v1 の間は MCP ツールの戻りが関門に入る（§6.1・台帳 P-03）。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveDocsSites, type DocsSites } from '../../packages/session/src/host/docs-sites'
import { EngineHost, type EngineInterpreter } from '../../packages/session/src/host/engine-host'
import { SessionCore } from '../../packages/session/src/host/session-core'
import { DEV_DOCS_UNAVAILABLE_MESSAGE } from '../../packages/session/src/mcp/mcp-docs'
import { clearPluginCatalogCache } from '../../packages/session/src/plugin-catalog-reader'
import { DOCS_CSP, serveDocs } from '../../packages/session/src/rpc/docs-http'
import {
  claimSocketPath,
  prepareRuntimeDir,
  resolveSocketPath,
} from '../../packages/session/src/rpc/runtime-dir'
import { startRpcServer, type RpcServer } from '../../packages/session/src/rpc/server'

import { RpcTestClient } from './helpers/rpc-test-client'

interface FakeEngine {
  interpreter: EngineInterpreter
  calls: string[]
}

function codedError(message: string, code?: string, details?: unknown): Error {
  return Object.assign(new Error(message), code ? { code } : {}, details ? { details } : {})
}

function fakeInterpreter(
  options: { selectFails?: string; noSelect?: boolean; pluginFails?: Error } = {},
): FakeEngine {
  const calls: string[] = []
  const interpreter = {
    boot: async (device?: string) => {
      calls.push(`boot ${device ?? '(default)'}`)
    },
    execute: async () => {},
    getGlobals: () => [{ stop: () => {}, saveAllPluginStates: async () => ({}) }],
    savePluginState: async (sequence: string, index: number) => {
      calls.push(`savePluginState ${sequence} ${index}`)
      if (options.pluginFails) throw options.pluginFails
      return { sequence, index, file: `/ws/.orbitscore/state/${sequence}-${index}.bin` }
    },
    openPluginUi: async (receiver: string, index: number, expectedName?: string) => {
      calls.push(`openPluginUi ${receiver} ${index} ${expectedName ?? '-'}`)
      if (options.pluginFails) throw options.pluginFails
      return { opened: true }
    },
    closePluginUi: async (receiver: string, index: number) => {
      calls.push(`closePluginUi ${receiver} ${index}`)
      if (options.pluginFails) throw options.pluginFails
      return { closed: true }
    },
    audioEngine: {
      quit: async () => {
        calls.push('quit')
      },
      getDaemonStatus: async () => ({ output: {}, callback: {} }),
      ...(options.noSelect
        ? {}
        : {
            selectAudioDevice: async (device: string) => {
              calls.push(`selectAudioDevice ${device}`)
              if (options.selectFails) throw new Error(options.selectFails)
              return `${device} (resolved)`
            },
          }),
    },
  } as unknown as EngineInterpreter
  return { interpreter, calls }
}

let tmp: string
let server: RpcServer | null
let core: SessionCore | null
let savedEnv: Record<string, string | undefined>

async function startSession(engine: FakeEngine, docs?: DocsSites) {
  const dir = path.join(tmp, 'run')
  prepareRuntimeDir(dir)
  const socket = resolveSocketPath(dir)
  if (!socket.ok) throw new Error(socket.reason)
  await claimSocketPath(socket.socketPath)
  const host = new EngineHost({
    createInterpreter: () => engine.interpreter,
    env: {},
    sessionLogCwd: '/ws',
    sessionLogEnabled: false,
    log: (level, text) => core?.sessionLog(level, text),
  })
  let rpc: RpcServer | null = null
  core = new SessionCore({
    engine: host,
    workspaceRoot: '/ws',
    broadcast: (method, params) => rpc?.broadcast(method, params),
    editorAttached: () => false,
    captureConsole: false,
    docs,
  })
  rpc = await startRpcServer({
    socketPath: socket.socketPath,
    sessionVersion: 'test',
    handlers: core.handlers,
    log: (level, text) => core!.sessionLog(level, text),
  })
  server = rpc
  const client = await RpcTestClient.uds(socket.socketPath)
  await client.attach()
  return { host, client }
}

/** IEEE float32 / mono / 1000 Hz の WAV（前半が無音・後半が振幅 0.5 の矩形）。 */
function writeFloatWav(file: string): void {
  const frames = 1000
  const data = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i += 1) data.writeFloatLE(i < 500 ? 0 : 0.5, i * 4)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(3, 20) // IEEE float
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(1000, 24)
  header.writeUInt32LE(4000, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(32, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-l2-'))
  server = null
  core = null
  savedEnv = {
    ORBIT_PLUGIN_CATALOG: process.env.ORBIT_PLUGIN_CATALOG,
    ORBIT_PLUGIN_SCAN_PATH: process.env.ORBIT_PLUGIN_SCAN_PATH,
  }
  clearPluginCatalogCache()
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearPluginCatalogCache()
  core?.dispose()
  await server?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('audio.* (design 848 §5.3.2)', () => {
  it('audio.listDevices reports the Rust engine gap with the frozen wording', async () => {
    const { client } = await startSession(fakeInterpreter())
    expect((await client.request('audio.listDevices')).result).toEqual({
      ok: false,
      error:
        'audio device selection is not supported with the Rust engine; the system default output device is used',
    })
    client.close()
  })

  it('audio.analyze reads a float32 capture and reports the analysis; a bad path is ok:false', async () => {
    const wav = path.join(tmp, 'capture.wav')
    writeFloatWav(wav)
    const { client } = await startSession(fakeInterpreter())
    const ok = (await client.request('audio.analyze', { wavPath: wav, windowMs: 100 })).result as {
      ok: true
      analysis: { frames: number; peak: number; windows: unknown[] }
    }
    expect(ok.ok).toBe(true)
    expect(ok.analysis.frames).toBe(1000)
    expect(ok.analysis.peak).toBeCloseTo(0.5)
    expect(ok.analysis.windows).toHaveLength(10)

    const missing = (await client.request('audio.analyze', { wavPath: path.join(tmp, 'none.wav') }))
      .result as { ok: false; error: string }
    expect(missing).toEqual({ ok: false, error: expect.stringContaining('ENOENT') })
    client.close()
  })

  it('audio.selectDevice on a stopped engine selects and starts it (frozen "start" branch)', async () => {
    const engine = fakeInterpreter()
    const { host, client } = await startSession(engine)
    expect((await client.request('audio.selectDevice', { device: 'Speakers' })).result).toEqual({
      ok: true,
      message: 'audio device selected: Speakers; engine started',
    })
    expect(engine.calls).toEqual(['boot Speakers'])
    expect(host.audioDevice).toBe('Speakers')
    expect(client.notifications.map((n) => n.method)).toContain('engine.state')
    client.close()
  })

  it('audio.selectDevice on a running engine switches live and remembers the resolved name', async () => {
    const engine = fakeInterpreter()
    const { host, client } = await startSession(engine)
    await client.request('engine.start', {})
    expect((await client.request('audio.selectDevice', { device: 'Headphones' })).result).toEqual({
      ok: true,
      message: 'audio device switched to: Headphones (resolved)',
    })
    expect(engine.calls).toEqual(['boot (default)', 'selectAudioDevice Headphones'])
    expect(host.audioDevice).toBe('Headphones (resolved)')
    client.close()
  })

  it('audio.selectDevice on the selected device deselects and stops (frozen "deselect-stop")', async () => {
    const engine = fakeInterpreter()
    const { host, client } = await startSession(engine)
    await client.request('engine.start', { audioDevice: 'Speakers' })
    expect((await client.request('audio.selectDevice', { device: 'Speakers' })).result).toEqual({
      ok: true,
      message: 'audio device deselected and engine stopped',
    })
    expect(engine.calls).toEqual(['boot Speakers', 'quit'])
    expect(host.running).toBe(false)
    expect(host.audioDevice).toBe('')
    client.close()
  })

  it('audio.selectDevice translates a known daemon failure and logs the frozen error line', async () => {
    const engine = fakeInterpreter({
      selectFails: 'AUDIO_DEVICE_SWITCH_UNAVAILABLE: capture active',
    })
    const { host, client } = await startSession(engine)
    await client.request('engine.start', {})
    const result = (await client.request('audio.selectDevice', { device: 'USB' })).result as {
      ok: false
      error: string
    }
    // 凍結版 `translateSelectAudioDeviceError` の訳（engine-view.ts の表）。
    expect(result).toEqual({
      ok: false,
      error: '録音中は切替できません — エンジンを再起動してください',
    })
    expect(host.audioDevice).toBe('')
    const log = (await client.request('session.getLog', { lines: 5 })).result as { lines: string[] }
    expect(log.lines.join('\n')).toContain(
      '❌ live device switch to "USB" failed: AUDIO_DEVICE_SWITCH_UNAVAILABLE: capture active',
    )
    client.close()
  })

  it('audio.selectDevice reports a backend without live switching', async () => {
    const { client } = await startSession(fakeInterpreter({ noSelect: true }))
    await client.request('engine.start', {})
    expect((await client.request('audio.selectDevice', { device: 'USB' })).result).toEqual({
      ok: false,
      error: 'selectAudioDevice is not supported by the current audio engine backend',
    })
    client.close()
  })
})

describe('plugin.* (design 848 §5.3.3)', () => {
  it('refuses saveState / openUi / closeUi before the engine starts', async () => {
    const engine = fakeInterpreter()
    const { client } = await startSession(engine)
    const notRunning = { ok: false, error: 'engine is not running — start the engine first' }
    expect(
      (await client.request('plugin.saveState', { receiver: 'drums', index: 0 })).result,
    ).toEqual(notRunning)
    expect((await client.request('plugin.openUi', { receiver: 'drums', index: 0 })).result).toEqual(
      notRunning,
    )
    expect(
      (await client.request('plugin.closeUi', { receiver: 'drums', index: 0 })).result,
    ).toEqual(notRunning)
    expect(engine.calls).toEqual([])
    client.close()
  })

  it('refuses plugin.saveState while the transport is playing', async () => {
    const engine = fakeInterpreter()
    const { client } = await startSession(engine)
    await client.request('engine.start', {})
    core!.onEngineLine('stdout', '✅ Global running')
    expect(
      (await client.request('plugin.saveState', { receiver: 'drums', index: 1 })).result,
    ).toEqual({
      ok: false,
      error: 'plugin state cannot be saved while the transport is running; stop first',
    })
    expect(engine.calls).toEqual(['boot (default)'])
    client.close()
  })

  it('calls the interpreter with the receiver / index / expectedName and wraps the result', async () => {
    const engine = fakeInterpreter()
    const { client } = await startSession(engine)
    await client.request('engine.start', {})
    expect(
      (await client.request('plugin.saveState', { receiver: 'drums', index: 1 })).result,
    ).toEqual({
      ok: true,
      saved: { sequence: 'drums', index: 1, file: '/ws/.orbitscore/state/drums-1.bin' },
    })
    expect(
      (
        await client.request('plugin.openUi', {
          receiver: 'global',
          index: 2,
          expectedName: 'Gain',
        })
      ).result,
    ).toEqual({ ok: true, result: { opened: true } })
    expect(
      (await client.request('plugin.closeUi', { receiver: 'global', index: 2 })).result,
    ).toEqual({ ok: true, result: { closed: true } })
    expect(engine.calls).toEqual([
      'boot (default)',
      'savePluginState drums 1',
      'openPluginUi global 2 Gain',
      'closePluginUi global 2',
    ])
    client.close()
  })

  it('passes the error code and details through (frozen DetailedErrorResult)', async () => {
    const failure = codedError('no plugin at index 4', 'PLUGIN_NOT_FOUND', { chainLength: 2 })
    const { client } = await startSession(fakeInterpreter({ pluginFails: failure }))
    await client.request('engine.start', {})
    const expected = {
      ok: false,
      error: 'no plugin at index 4',
      code: 'PLUGIN_NOT_FOUND',
      details: { chainLength: 2 },
    }
    expect(
      (await client.request('plugin.saveState', { receiver: 'drums', index: 4 })).result,
    ).toEqual(expected)
    expect((await client.request('plugin.openUi', { receiver: 'drums', index: 4 })).result).toEqual(
      expected,
    )
    expect(
      (await client.request('plugin.closeUi', { receiver: 'drums', index: 4 })).result,
    ).toEqual(expected)
    client.close()
  })

  it('plugin.list reads the catalog named by ORBIT_PLUGIN_CATALOG; a missing catalog says rescan', async () => {
    const catalog = path.join(tmp, 'plugin-catalog.json')
    process.env.ORBIT_PLUGIN_CATALOG = catalog
    const { client } = await startSession(fakeInterpreter())
    expect((await client.request('plugin.list')).result).toEqual({
      ok: false,
      error: 'plugin catalog not found — run "OrbitScore: Rescan Plugin Catalog" first',
    })
    const entry = {
      name: 'Gain',
      vendor: 'signal compose',
      format: 'clap',
      path: '/Library/Audio/Plug-Ins/CLAP/Gain.clap',
      pluginId: 'com.signalcompose.gain',
      roles: ['effect'],
    }
    fs.writeFileSync(
      catalog,
      JSON.stringify({ version: 2, scannedAt: '2026-10-26T00:00:00Z', plugins: [entry] }),
    )
    expect((await client.request('plugin.list')).result).toEqual({ ok: true, plugins: [entry] })
    client.close()
  })

  it('plugin.rescan runs the scanner named by ORBIT_PLUGIN_SCAN_PATH and drops cachePath', async () => {
    const summary = {
      success: 1,
      pending: 0,
      failure: 1,
      failureReasons: { load: 1 },
      durationMs: { p50: 3, p95: 3, max: 3 },
      timeouts: 0,
      crashes: 0,
      factoryVersions: {},
      cacheHits: 0,
      probeAttempts: 2,
    }
    const outcome = {
      count: 1,
      artifactCount: 2,
      cachePath: '/tmp/cache.json',
      skipped: ['/x.vst3'],
      failures: [{ path: '/y.clap', code: 'load', message: 'dlopen failed' }],
      summary,
    }
    const scanner = path.join(tmp, 'fake-scan.sh')
    fs.writeFileSync(scanner, `#!/bin/sh\necho '${JSON.stringify(outcome)}'\n`, { mode: 0o755 })
    process.env.ORBIT_PLUGIN_SCAN_PATH = scanner
    const { client } = await startSession(fakeInterpreter())
    expect((await client.request('plugin.rescan')).result).toEqual({
      ok: true,
      count: 1,
      artifactCount: 2,
      skipped: ['/x.vst3'],
      failures: [{ path: '/y.clap', code: 'load', message: 'dlopen failed' }],
      summary,
    })

    fs.writeFileSync(scanner, '#!/bin/sh\necho "scanner exploded" >&2\nexit 3\n', { mode: 0o755 })
    expect((await client.request('plugin.rescan')).result).toEqual({
      ok: false,
      error: 'scanner exploded',
    })
    client.close()
  })
})

/** モノレポの形（`sites/user` + dist）と、`.app` の同梱の形（`user` + `user-site`）を作る。 */
function makeDocsTrees(): { monorepo: string; bundle: string } {
  const monorepo = path.join(tmp, 'repo')
  for (const site of ['user', 'dev']) {
    const root = path.join(monorepo, 'sites', site)
    fs.mkdirSync(path.join(root, 'guide'), { recursive: true })
    fs.mkdirSync(path.join(root, '.vitepress', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'guide', 'start.md'), `# ${site} start\n\nplay the kick\n`)
    const base = site === 'dev' ? '/orbitscore/dev' : '/orbitscore'
    fs.writeFileSync(
      path.join(root, '.vitepress', 'dist', 'index.html'),
      `<link href="${base}/assets/app.css">${site} home`,
    )
  }
  const bundle = path.join(tmp, 'Resources', 'docs')
  fs.mkdirSync(path.join(bundle, 'user'), { recursive: true })
  fs.mkdirSync(path.join(bundle, 'user-site'), { recursive: true })
  fs.writeFileSync(path.join(bundle, 'user', 'index.md'), '# bundled user docs\n')
  fs.writeFileSync(
    path.join(bundle, 'user-site', 'index.html'),
    '<link href="/orbitscore/assets/app.css">bundled home',
  )
  return { monorepo, bundle }
}

describe('docs.* (design 848 §5.3.5)', () => {
  it('resolves both layouts; the first --docs-dir that has a site wins', () => {
    const { monorepo, bundle } = makeDocsTrees()
    const appFirst = resolveDocsSites([bundle, monorepo])
    expect(appFirst.user).toEqual({
      sourceRoot: path.join(bundle, 'user'),
      distRoot: path.join(bundle, 'user-site'),
    })
    // `.app` には dev が無いので、後ろのモノレポの dev が使われる。
    expect(appFirst.dev?.sourceRoot).toBe(path.join(monorepo, 'sites', 'dev'))
    expect(resolveDocsSites([monorepo, bundle]).user?.sourceRoot).toBe(
      path.join(monorepo, 'sites', 'user'),
    )
    expect(resolveDocsSites([bundle])).toEqual({
      user: { sourceRoot: path.join(bundle, 'user'), distRoot: path.join(bundle, 'user-site') },
      dev: null,
    })
    expect(resolveDocsSites([])).toEqual({ user: null, dev: null })
  })

  it('docs.get / docs.search read the Markdown source of the requested site', async () => {
    const { monorepo } = makeDocsTrees()
    const { client } = await startSession(fakeInterpreter(), resolveDocsSites([monorepo]))
    expect(
      (await client.request('docs.get', { site: 'dev', path: 'guide/start.md' })).result,
    ).toEqual({ text: '# dev start\n\nplay the kick\n' })
    expect((await client.request('docs.search', { site: 'user', query: 'KICK' })).result).toEqual({
      matches: [{ path: 'guide/start.md', line: 3, excerpt: 'play the kick' }],
    })
    client.close()
  })

  it('docs.search follows the frozen parseSearchLimit (default 10, truncate, negative → 0)', async () => {
    const { monorepo } = makeDocsTrees()
    const many = Array.from({ length: 15 }, (_, i) => `kick ${i}`).join('\n')
    fs.writeFileSync(path.join(monorepo, 'sites', 'user', 'many.md'), many)
    const { client } = await startSession(fakeInterpreter(), resolveDocsSites([monorepo]))
    const count = async (limit?: number) =>
      (
        (
          await client.request('docs.search', {
            site: 'user',
            query: 'kick',
            ...(limit === undefined ? {} : { limit }),
          })
        ).result as { matches: unknown[] }
      ).matches.length
    expect(await count()).toBe(10)
    expect(await count(2.9)).toBe(2)
    expect(await count(-3)).toBe(0)
    client.close()
  })

  it('a missing page is DOC_NOT_FOUND with the frozen per-site wording', async () => {
    const { monorepo } = makeDocsTrees()
    const { client } = await startSession(fakeInterpreter(), resolveDocsSites([monorepo]))
    expect(
      (await client.request('docs.get', { site: 'dev', path: 'nope.md' })).error,
    ).toMatchObject({ code: -32020, message: 'development document not found' })
    expect(
      (await client.request('docs.get', { site: 'user', path: '../escape.md' })).error,
    ).toMatchObject({ code: -32020, message: 'user document not found' })
    client.close()
  })

  it('without a dev site every dev call is DOCS_UNAVAILABLE with the frozen message', async () => {
    const { bundle } = makeDocsTrees()
    const { client } = await startSession(fakeInterpreter(), resolveDocsSites([bundle]))
    for (const [method, params] of [
      ['docs.get', { site: 'dev', path: 'guide/start.md' }],
      ['docs.search', { site: 'dev', query: 'kick' }],
    ] as const) {
      expect((await client.request(method, params)).error).toMatchObject({
        code: -32021,
        message: DEV_DOCS_UNAVAILABLE_MESSAGE,
      })
    }
    expect((await client.request('docs.get', { site: 'user', path: 'index.md' })).result).toEqual({
      text: '# bundled user docs\n',
    })
    client.close()
  })
})

describe('docs over the TCP listener (design 848 §5.3 HTTP rows L5)', () => {
  async function docsServer(docs: DocsSites) {
    const logged: string[] = []
    let port = 0
    const httpServer = http.createServer((request, response) => {
      if (!serveDocs(docs, request, response, port, (_level, text) => logged.push(text))) {
        response.writeHead(404)
        response.end('fallthrough')
      }
    })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    port = (httpServer.address() as { port: number }).port
    const get = (pathname: string, init: { host?: string; method?: string } = {}) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const request = http.request(
            {
              host: '127.0.0.1',
              port,
              path: pathname,
              method: init.method ?? 'GET',
              headers: { host: init.host ?? `127.0.0.1:${port}` },
            },
            (response) => {
              let body = ''
              response.setEncoding('utf8')
              response.on('data', (chunk) => (body += chunk))
              response.on('end', () =>
                resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
              )
            },
          )
          request.on('error', reject)
          request.end()
        },
      )
    return { get, logged, close: () => new Promise((resolve) => httpServer.close(resolve)) }
  }

  it('serves the user and dev dists (longest prefix first) with the docs CSP', async () => {
    const { monorepo } = makeDocsTrees()
    const server = await docsServer(resolveDocsSites([monorepo]))
    const user = await server.get('/orbitscore/')
    expect(user.status).toBe(200)
    expect(user.body).toContain('user home')
    expect(user.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(user.headers['content-security-policy']).toBe(DOCS_CSP)
    expect((await server.get('/orbitscore/dev/')).body).toContain('dev home')
    expect((await server.get('/orbitscore/nope.html')).status).toBe(404)
    expect((await server.get('/app/')).body).toBe('fallthrough')
    await server.close()
  })

  it('redirects /docs to the dev base and answers 405 / 403 like the frozen handler', async () => {
    const { monorepo } = makeDocsTrees()
    const server = await docsServer(resolveDocsSites([monorepo]))
    const alias = await server.get('/docs')
    expect(alias.status).toBe(302)
    expect(alias.headers.location).toBe('/orbitscore/dev/')
    const post = await server.get('/orbitscore/', { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET')
    const rebound = await server.get('/orbitscore/', { host: 'evil.example:80' })
    expect(rebound.status).toBe(403)
    expect(JSON.parse(rebound.body)).toEqual({ error: 'forbidden: invalid Host header' })
    await server.close()
  })

  it('answers 503 with the unavailable message when the dev site is absent (the .app case)', async () => {
    const { bundle } = makeDocsTrees()
    const server = await docsServer(resolveDocsSites([bundle]))
    const dev = await server.get('/orbitscore/dev/')
    expect(dev.status).toBe(503)
    expect(dev.body).toBe(DEV_DOCS_UNAVAILABLE_MESSAGE)
    expect((await server.get('/orbitscore/')).body).toContain('bundled home')
    await server.close()
  })

  it('answers 503 with the build hint for an unbuilt or stale dist', async () => {
    const { monorepo } = makeDocsTrees()
    fs.rmSync(path.join(monorepo, 'sites', 'dev', '.vitepress', 'dist'), { recursive: true })
    fs.writeFileSync(
      path.join(monorepo, 'sites', 'user', '.vitepress', 'dist', 'index.html'),
      '<link href="/old-base/assets/app.css">',
    )
    const server = await docsServer(resolveDocsSites([monorepo]))
    const unbuilt = await server.get('/orbitscore/dev/')
    expect(unbuilt.status).toBe(503)
    expect(unbuilt.body).toBe(
      'Development docs are not built. Run npm run docs:build -w @orbitscore/dev-site',
    )
    const stale = await server.get('/orbitscore/')
    expect(stale.status).toBe(503)
    expect(stale.body).toBe(
      'Docs build is stale (built with a different base path). User docs are not built. Run npm run docs:build -w @orbitscore/user-site',
    )
    await server.close()
  })
})
