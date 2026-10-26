/**
 * gated E2E のターゲット（設計 848 §10.2・計画 §7.1 の C-8）。ゲートの外で回る unit:
 * `vscode` が既定のまま変わらないこと・headless の起動の形・ハーネスのプロセスの見つけ方。
 *
 * 1 本だけ本物の headless（層 2 + 中継）を起こす（vite-node で src を起こす。CI は build の前に
 * `npm test` を回すので dist が無い）。engine は起動しない（Linux・音なし）。
 */
import { execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  headlessPgrepPattern,
  headlessSessionArgs,
  launchHeadless,
  prepareHarnessRuntimeDir,
  resolveGatedTarget,
  settingsToEngineStart,
  type HeadlessLaunch,
} from './helpers/gated-target'

const repoRoot = path.resolve(__dirname, '../..')
const VITE_NODE_CLI = [
  path.join(repoRoot, 'node_modules/.bin/vite-node'),
  '--config',
  'vitest.config.ts',
  'packages/session/src/cli.ts',
]

const roots: string[] = []
const launched: HeadlessLaunch[] = []

function harnessTmp(): string {
  const dir = fs.mkdtempSync('/tmp/orbe2e-t-')
  roots.push(dir)
  return dir
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null

afterEach(() => {
  for (const launch of launched.splice(0)) {
    for (const child of [launch.relay, launch.child]) if (alive(child)) child.kill('SIGKILL')
  }
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('ORBIT_GATED_TARGET (design 848 §10.2)', () => {
  it('defaults to vscode, so the frozen target is what runs without the variable', () => {
    expect(resolveGatedTarget({})).toBe('vscode')
    expect(resolveGatedTarget({ ORBIT_GATED_TARGET: ' ' })).toBe('vscode')
    expect(resolveGatedTarget({ ORBIT_GATED_TARGET: 'headless' })).toBe('headless')
    expect(resolveGatedTarget({ ORBIT_GATED_TARGET: 'native' })).toBe('native')
    expect(() => resolveGatedTarget({ ORBIT_GATED_TARGET: 'electron' })).toThrow(
      'ORBIT_GATED_TARGET must be one of vscode / headless / native (got "electron")',
    )
  })

  it('makes the runtime dir 0700 under the harness tmp and refuses one too long for a socket', () => {
    const tmp = harnessTmp()
    const dir = prepareHarnessRuntimeDir(tmp)
    expect(dir).toBe(path.join(tmp, 'r'))
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    const deep = path.join(tmp, 'x'.repeat(90))
    fs.mkdirSync(deep)
    expect(() => prepareHarnessRuntimeDir(deep)).toThrow(/too long for a unix socket/)
  })

  it('starts layer 2 without TCP, with the workspace only when one is opened', () => {
    const repo = path.resolve(__dirname, '../..')
    expect(
      headlessSessionArgs({ runtimeDir: '/tmp/orbe2e-a/r', workspaceRoot: '/tmp/orbe2e-a' }),
    ).toEqual([
      'session',
      '--runtime-dir',
      '/tmp/orbe2e-a/r',
      '--workspace-root',
      '/tmp/orbe2e-a',
      '--docs-dir',
      repo,
    ])
    expect(headlessSessionArgs({ runtimeDir: '/tmp/orbe2e-a/r' })).not.toContain('--workspace-root')
    expect(headlessSessionArgs({ runtimeDir: '/tmp/orbe2e-a/r' })).not.toContain('--port')
  })

  it.each([
    [{}, null],
    [{ 'orbitscore.audioDevice': '' }, null],
    [{ 'orbitscore.audioDevice': '__default__' }, { debug: false }],
    [
      { 'orbitscore.audioDevice': 'MacBook Pro Speakers', 'orbitscore.engineDebug': true },
      { audioDevice: 'MacBook Pro Speakers', debug: true },
    ],
  ])('maps the frozen auto-start settings %j to engine.start %j', (settings, expected) => {
    expect(settingsToEngineStart(settings)).toEqual(expected)
  })

  it('finds only harness-owned headless processes', () => {
    const pattern = new RegExp(headlessPgrepPattern('orbe2e-').replace('[^[:space:]]', '[^\\s]'))
    expect(
      pattern.test(
        'node /repo/packages/session/dist/cli.js session --runtime-dir /tmp/orbe2e-x1/r',
      ),
    ).toBe(true)
    expect(
      pattern.test('node /repo/packages/session/dist/cli.js relay --runtime-dir /tmp/orbe2e-x1/r'),
    ).toBe(true)
    // 利用者のアプリの session（既定の runtime-dir）と中継には当たらない。
    expect(pattern.test('node /Applications/OrbitStudio.app/x/cli.js session')).toBe(false)
    expect(
      pattern.test(
        'node /repo/packages/session/dist/cli.js session --runtime-dir /Users/me/Library/Application Support/OrbitStudio/run',
      ),
    ).toBe(false)
  })
})

describe('a real headless launch (design 848 §10.2)', () => {
  it('starts layer 2 and the relay, answers MCP through the relay, and is found by the sweep pattern', async () => {
    const tmp = harnessTmp()
    const launch = await launchHeadless({
      tmpRoot: tmp,
      openWorkspace: true,
      settings: {},
      env: { ...process.env },
      cli: VITE_NODE_CLI,
    })
    launched.push(launch)
    expect(JSON.parse((await launch.client.call('get_engine_state')).text)).toEqual({
      running: false,
      liveCoding: false,
    })
    const list = await launch.client.call('evaluate_orbitscore', { code: 'global.tempo(120)' })
    expect(list).toMatchObject({
      isError: true,
      text: 'error: engine is not running — start the engine first',
    })
    // --workspace-root が渡っている（project scope の登録は workspace の .mcp.json に書く。
    // user scope は本物の claude CLI を呼ぶので使わない）。
    expect((await launch.client.call('register_mcp_server', { scope: 'project' })).isError).toBe(
      false,
    )
    expect(fs.existsSync(path.join(tmp, '.mcp.json'))).toBe(true)
    const found = execFileSync('pgrep', ['-f', headlessPgrepPattern('orbe2e-')], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)
      .map(Number)
    expect(found).toEqual(expect.arrayContaining([launch.child.pid, launch.relay.pid]))
  }, 60_000)

  it('opens no workspace when the scenario asks for an empty window (IM.6 case 4)', async () => {
    const tmp = harnessTmp()
    const launch = await launchHeadless({
      tmpRoot: tmp,
      openWorkspace: false,
      settings: {},
      env: { ...process.env },
      cli: VITE_NODE_CLI,
    })
    launched.push(launch)
    expect(await launch.client.call('register_mcp_server', { scope: 'project' })).toMatchObject({
      isError: true,
      text: 'error: no workspace folder open — project scope writes .mcp.json into the workspace root',
    })
  }, 60_000)

  it('fails the launch with the reason when the configured engine cannot start', async () => {
    const tmp = harnessTmp()
    await expect(
      launchHeadless({
        tmpRoot: tmp,
        openWorkspace: false,
        settings: { 'orbitscore.audioDevice': '__default__' },
        env: { ...process.env, ORBIT_AUDIO_DAEMON_PATH: '/usr/bin/false' },
        cli: VITE_NODE_CLI,
      }),
    ).rejects.toThrow(/^engine\.start failed: engine failed to start/)
  }, 60_000)
})
