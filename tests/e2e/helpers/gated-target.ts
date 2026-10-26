/**
 * gated E2E のターゲット（設計 848 §10.2）。差は**起動と MCP の取り方だけ**で、シナリオは変えない。
 *
 * | `ORBIT_GATED_TARGET` | 起動するもの | MCP |
 * |---|---|---|
 * | `vscode`（既定） | stock VS Code + 凍結版の拡張 | HTTP の `/mcp`（`ORBITSCORE_MCP_PORT`） |
 * | `headless` | `node packages/session/dist/cli.js session --runtime-dir <短いパス> [--workspace-root]` | 中継 `cli.js relay` を stdio で |
 * | `native` | `OrbitStudio.app`（束 N2 で足す） | 中継を stdio で |
 *
 * 分離は runtime-dir で行う: ハーネスは `<tmpRoot>/r` を 0700 で作り、層 2 と中継の両方に同じ値を
 * 渡す。**利用者が動かしているアプリのソケット（既定の runtime-dir）には触れない**。
 */
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'

import { connectSession } from '../../../packages/session/src/rpc/client'

import { StdioMcpClient } from './mcp-client'

export type GatedTarget = 'vscode' | 'headless' | 'native'

const TARGETS: readonly GatedTarget[] = ['vscode', 'headless', 'native']

export function resolveGatedTarget(env: NodeJS.ProcessEnv): GatedTarget {
  const raw = env.ORBIT_GATED_TARGET?.trim()
  if (!raw) return 'vscode'
  if ((TARGETS as readonly string[]).includes(raw)) return raw as GatedTarget
  throw new Error(
    `ORBIT_GATED_TARGET must be one of ${TARGETS.join(' / ')} (got ${JSON.stringify(raw)})`,
  )
}

const repoRoot = path.resolve(__dirname, '../../..')
export const SESSION_CLI_DIST = path.join(repoRoot, 'packages/session/dist/cli.js')

/** headless の runtime-dir（`<tmpRoot>/r`）。macOS のソケット上限は 103 バイト（`sun_path[104]`）。 */
export const HARNESS_RUNTIME_SUBDIR = 'r'
const SOCKET_PATH_MAX = 103

/**
 * runtime-dir を 0700 で作り、ソケットのパスが上限に収まることを確かめる。`/tmp` は macOS では
 * `/private/tmp` へのシンボリックリンクなので、**実体のパス**で測る（設計 §10.2）。
 */
export function prepareHarnessRuntimeDir(tmpRoot: string): string {
  const dir = path.join(tmpRoot, HARNESS_RUNTIME_SUBDIR)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const socketPath = path.join(fs.realpathSync(dir), 'session.sock')
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX) {
    throw new Error(
      `the harness runtime dir is too long for a unix socket (${Buffer.byteLength(socketPath)} > ` +
        `${SOCKET_PATH_MAX}): ${socketPath}. Shorten the per-test tmp prefix.`,
    )
  }
  return dir
}

/** `session` の起動引数（TCP は開かない・§10.2）。docs はモノレポのチェックアウトから読む。 */
export function headlessSessionArgs(options: {
  runtimeDir: string
  workspaceRoot?: string
}): string[] {
  return [
    'session',
    '--runtime-dir',
    options.runtimeDir,
    ...(options.workspaceRoot ? ['--workspace-root', options.workspaceRoot] : []),
    '--docs-dir',
    repoRoot,
  ]
}

/**
 * 凍結版の拡張の設定から、アプリが起動時に層 2 へ渡す `engine.start` を作る（設計 §7.1:
 * 「値は session の起動引数か RPC で渡す」）。凍結版は `orbitscore.audioDevice` が保存されていると
 * 起動時に engine を自動で起こす（`autoStartConfiguredRustEngine`）。`__default__` は「システムの
 * 既定」のセンチネル。設定が無ければ起動しない（null）。
 */
export function settingsToEngineStart(
  settings: Record<string, unknown>,
): { audioDevice?: string; debug: boolean } | null {
  const device = settings['orbitscore.audioDevice']
  if (typeof device !== 'string' || device === '') return null
  return {
    ...(device === '__default__' ? {} : { audioDevice: device }),
    debug: settings['orbitscore.engineDebug'] === true,
  }
}

export interface HeadlessLaunch {
  /** 層 2（`session`）のプロセス。 */
  child: ChildProcess
  relay: ChildProcess
  client: StdioMcpClient
}

function waitForReady(child: ChildProcess, timeoutMs: number): Promise<Record<string, unknown>> {
  let stderr = ''
  child.stderr?.on('data', (chunk) => (stderr += chunk))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`session did not print its ready line within ${timeoutMs}ms: ${stderr}`)),
      timeoutMs,
    )
    readline.createInterface({ input: child.stdout! }).once('line', (line) => {
      clearTimeout(timer)
      const ready = JSON.parse(line) as Record<string, unknown>
      if (ready.ready !== true) reject(new Error(`session failed to start: ${line}`))
      else resolve(ready)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`session exited (${code}) before ready: ${stderr}`))
    })
  })
}

/**
 * headless を起こす: 層 2 → （設定があれば `engine.start`）→ 中継 → MCP の `initialize`。
 *
 * `engine.start` はアプリ（層 3）の役目なので、アプリと同じく RPC で直接頼む（中継の MCP ツール
 * `start_engine` には `audioDevice` が無い）。シナリオが通る経路（MCP）はその後で開く。
 */
export async function launchHeadless(options: {
  tmpRoot: string
  openWorkspace: boolean
  settings: Record<string, unknown>
  env: NodeJS.ProcessEnv
  readyTimeoutMs?: number
  /** `cli.js` を起こすコマンド（既定は build 済みの `node packages/session/dist/cli.js`）。 */
  cli?: readonly string[]
}): Promise<HeadlessLaunch> {
  const [command, ...cliArgs] = options.cli ?? [process.execPath, SESSION_CLI_DIST]
  const runtimeDir = prepareHarnessRuntimeDir(options.tmpRoot)
  const env = { ...options.env, ORBITSTUDIO_RUNTIME_DIR: runtimeDir }
  const child = spawn(
    command!,
    [
      ...cliArgs,
      ...headlessSessionArgs({
        runtimeDir,
        workspaceRoot: options.openWorkspace ? options.tmpRoot : undefined,
      }),
    ],
    { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let relay: ChildProcess | undefined
  try {
    const ready = await waitForReady(child, options.readyTimeoutMs ?? 60_000)
    const start = settingsToEngineStart(options.settings)
    if (start) {
      const app = await connectSession(String(ready.socket), {
        client: { name: 'orbitstudio-gated-e2e-app', version: '0.0.1' },
      })
      try {
        const started = (await app.call('engine.start', start)) as { ok: boolean; error?: string }
        if (!started.ok) throw new Error(`engine.start failed: ${started.error}`)
      } finally {
        app.close()
      }
    }
    relay = spawn(command!, [...cliArgs, 'relay', '--runtime-dir', runtimeDir], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = new StdioMcpClient(relay)
    await client.connect()
    return { child, relay, client }
  } catch (error) {
    relay?.kill('SIGKILL')
    child.kill('SIGTERM')
    throw error
  }
}

/**
 * headless のハーネスのプロセスを見つける `pgrep -f` の拡張正規表現。`--runtime-dir` の値が
 * ハーネスの tmp（`HARNESS_TMP_PREFIX`）の下にあるものだけ — 利用者のアプリや session には当たらない。
 */
export function headlessPgrepPattern(harnessTmpPrefix: string): string {
  return `packages/session/(dist/cli\\.js|src/cli\\.ts) (session|relay) --runtime-dir [^[:space:]]*/${harnessTmpPrefix}`
}
