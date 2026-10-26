/**
 * `orbitscore session` — 層 2 のプロセスの入口（設計 848 §4.4・§4.5・§4.7・§12 F-1 / F-12）。
 *
 * ```
 * node <bundle>/session/dist/cli.js session [--runtime-dir <dir>] [--port <N|0>] [--token-file <path>]
 *     [--docs-dir <dir>]… [--web-dir <dir>] [--workspace-root <dir>] [--parent-pid <pid>]
 *     [--host-bundle-id <id>] [--plugin-catalog <path>] [--plugin-scan-path <path>]
 * ```
 *
 * - stdout の 1 行目が ready 行 `{"ready":true,"socket","port","protocol_version","token"}`。
 *   🔴 `token` は秘密（TCP を開いた時だけ・それ以外は `port` と `token` が null）。ready 行の後に stdout へは
 *   何も書かない（host は 1 行目を消費して捨てる・§4.7「漏れる経路」）。起動の失敗は stderr に
 *   `{"ready":false,"error":{code,message}}`（秘密を含めない）
 * - **F-1**: stdin がパイプ（FIFO かソケット）の時だけ、EOF を「親が居なくなった」とみなして
 *   `session.shutdown` と同じ経路で畳む。`--parent-pid` の PID が消えても同じ経路で畳む
 * - `--workspace-root` が無ければ IM.6 の第 3 候補は無い（cwd を暗黙に使わない・§4.5.2）
 * - `--plugin-catalog` / `--plugin-scan-path` は「起動引数 → 環境変数 → 既定」（§4.5）
 */
import fs from 'node:fs'
import path from 'node:path'

import { shouldEnableSessionLog } from '@orbitscore/engine/dist/cli/session-log-gate'
import { InterpreterV2 } from '@orbitscore/engine/dist/interpreter/interpreter-v2'

import { EngineHost, type EngineInterpreter } from './host/engine-host'
import { SessionCore } from './host/session-core'
import { generateToken } from './rpc/http-guard'
import { PROTOCOL_VERSION } from './rpc/protocol'
import {
  claimSocketPath,
  prepareRuntimeDir,
  resolveRuntimeDir,
  resolveSocketPath,
} from './rpc/runtime-dir'
import { startRpcServer, type RpcServer } from './rpc/server'
import { serveApp } from './rpc/static-files'

export interface SessionArgs {
  runtimeDir?: string
  port?: number
  tokenFile?: string
  docsDirs: string[]
  webDir?: string
  workspaceRoot?: string
  parentPid?: number
  hostBundleId?: string
  pluginCatalog?: string
  pluginScanPath?: string
}

/**
 * `--parent-pid` の生存を確かめる周期（設計 §4.4「周期は N1 で決める・未実測」）。
 * PROVISIONAL(P-08): 置き値。実測したら出典（日付・commit）のコメントに置き換える。
 */
export const PARENT_PID_POLL_MS = 1_000

const VALUE_FLAGS = new Set([
  '--runtime-dir',
  '--port',
  '--token-file',
  '--docs-dir',
  '--web-dir',
  '--workspace-root',
  '--parent-pid',
  '--host-bundle-id',
  '--plugin-catalog',
  '--plugin-scan-path',
])

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

export function parseSessionArgs(argv: readonly string[]): Parsed<SessionArgs> {
  const args: SessionArgs = { docsDirs: [] }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (!VALUE_FLAGS.has(flag)) return { ok: false, message: `unknown argument: ${flag}` }
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, message: `${flag} needs a value` }
    }
    switch (flag) {
      case '--port': {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          return { ok: false, message: `--port must be an integer from 0 to 65535: ${value}` }
        }
        args.port = port
        break
      }
      case '--parent-pid': {
        const pid = Number(value)
        if (!Number.isInteger(pid) || pid <= 0) {
          return { ok: false, message: `--parent-pid must be a positive integer: ${value}` }
        }
        args.parentPid = pid
        break
      }
      case '--docs-dir':
        args.docsDirs.push(path.resolve(value)) // 複数可・先勝ち（計画 N-3）
        break
      case '--runtime-dir':
        args.runtimeDir = value
        break
      case '--token-file':
        args.tokenFile = path.resolve(value)
        break
      case '--web-dir':
        args.webDir = path.resolve(value)
        break
      case '--workspace-root':
        args.workspaceRoot = path.resolve(value)
        break
      case '--host-bundle-id':
        args.hostBundleId = value
        break
      case '--plugin-catalog':
        args.pluginCatalog = path.resolve(value)
        break
      case '--plugin-scan-path':
        args.pluginScanPath = value
        break
    }
  }
  return { ok: true, value: args }
}

/** `--token-file` を読む。所有者以外が読み書きできるなら使わない（§4.7）。 */
export function readTokenFile(file: string): Parsed<string> {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch (error) {
    return { ok: false, message: `cannot read the token file: ${(error as Error).message}` }
  }
  if ((stat.mode & 0o077) !== 0) {
    return {
      ok: false,
      message: `the token file must not be readable by others (mode ${(stat.mode & 0o777).toString(8)})`,
    }
  }
  const token = fs.readFileSync(file, 'utf8').trim()
  if (token.length < 32)
    return { ok: false, message: 'the token file holds fewer than 32 characters' }
  return { ok: true, value: token }
}

export interface SessionIo {
  stdout: { write(text: string): unknown }
  stderr: { write(text: string): unknown }
  stdin: NodeJS.ReadableStream & { destroy?(): void }
  /** stdin がパイプか（F-1）。端末や `/dev/null` の EOF は親の死を意味しない。 */
  stdinIsPipe: boolean
  env: NodeJS.ProcessEnv
  onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void
  /** その PID が生きているか（`process.kill(pid, 0)`）。 */
  isAlive(pid: number): boolean
  createInterpreter(): EngineInterpreter
  sessionVersion: string
}

export interface RunningSession {
  server: RpcServer
  core: SessionCore
  /** 畳み終わった時に終了コードで解決する。 */
  exited: Promise<number>
  shutdown(reason: string): Promise<number>
}

export type SessionStart = { ok: true; session: RunningSession } | { ok: false; exitCode: number }

function fail(io: SessionIo, code: string, message: string): SessionStart {
  io.stderr.write(`${JSON.stringify({ ready: false, error: { code, message } })}\n`)
  return { ok: false, exitCode: code === 'BAD_ARGUMENTS' ? 2 : 1 }
}

export function stdinIsPipe(fd = 0): boolean {
  try {
    const stat = fs.fstatSync(fd)
    return stat.isFIFO() || stat.isSocket()
  } catch {
    return false
  }
}

export function defaultSessionIo(sessionVersion: string): SessionIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    stdinIsPipe: stdinIsPipe(0),
    env: process.env,
    onSignal: (signal, handler) => process.on(signal, handler),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    createInterpreter: () => new InterpreterV2() as unknown as EngineInterpreter,
    sessionVersion,
  }
}

export async function startSession(argv: readonly string[], io: SessionIo): Promise<SessionStart> {
  const parsed = parseSessionArgs(argv)
  if (!parsed.ok) return fail(io, 'BAD_ARGUMENTS', parsed.message)
  const args = parsed.value

  // 凍結版が環境変数で渡していたもの（`plugin-catalog.ts` / `plugin-catalog-reader.ts` が呼び出しの
  // たびに読む）。起動引数があれば上書きし、daemon と plugin child にはそのまま継承させる。
  if (args.pluginCatalog) io.env.ORBIT_PLUGIN_CATALOG = args.pluginCatalog
  if (args.pluginScanPath) io.env.ORBIT_PLUGIN_SCAN_PATH = args.pluginScanPath

  const dir = prepareRuntimeDir(resolveRuntimeDir(args.runtimeDir, io.env))
  if (!dir.ok) return fail(io, 'RUNTIME_DIR_UNSAFE', dir.reason)
  const socket = resolveSocketPath(dir.dir)
  if (!socket.ok) return fail(io, 'SOCKET_PATH_TOO_LONG', socket.reason)
  if (socket.dir !== dir.dir) {
    const fallback = prepareRuntimeDir(socket.dir)
    if (!fallback.ok) return fail(io, 'RUNTIME_DIR_UNSAFE', fallback.reason)
  }
  const claimed = await claimSocketPath(socket.socketPath)
  if (!claimed.ok) return fail(io, 'SESSION_ALREADY_RUNNING', claimed.reason)

  let token: string | null = null
  if (args.port !== undefined) {
    if (args.tokenFile) {
      const read = readTokenFile(args.tokenFile)
      if (!read.ok) return fail(io, 'TOKEN_FILE_UNSAFE', read.message)
      token = read.value
    } else {
      token = generateToken()
    }
  }

  let server: RpcServer | null = null
  let requestShutdown: (reason: string) => void = () => {}
  const engine = new EngineHost({
    createInterpreter: io.createInterpreter,
    env: io.env,
    defaultHostBundleId: args.hostBundleId,
    sessionLogCwd: args.workspaceRoot ?? process.cwd(),
    sessionLogEnabled: shouldEnableSessionLog(io.env),
    log: (level, text) => core.sessionLog(level, text),
  })
  const core: SessionCore = new SessionCore({
    engine,
    workspaceRoot: args.workspaceRoot ?? null,
    broadcast: (method, params) => {
      server?.broadcast(method, params)
      // 人が headless を端末で動かした時に見えるように、debug でない行は stderr にも写す。
      if (method === 'log.line') {
        const line = params as { level: string; text: string }
        if (line.level !== 'debug') io.stderr.write(`[${line.level}] ${line.text}\n`)
      }
    },
    editorAttached: () => server?.editorClient() != null,
    onShutdownRequested: () => setImmediate(() => requestShutdown('session.shutdown')),
  })

  try {
    server = await startRpcServer({
      socketPath: socket.socketPath,
      tcp: args.port !== undefined && token ? { port: args.port, token } : undefined,
      sessionVersion: io.sessionVersion,
      handlers: core.handlers,
      log: (level, text) => core.sessionLog(level, text),
      tcpHttp: (request, response, port) => serveApp(args.webDir, request, response, port),
    })
  } catch (error) {
    core.dispose()
    return fail(io, 'LISTEN_FAILED', (error as Error).message)
  }

  io.stdout.write(
    `${JSON.stringify({
      ready: true,
      socket: socket.socketPath,
      port: server.tcpPort,
      protocol_version: PROTOCOL_VERSION,
      token,
    })}\n`,
  )

  let resolveExited!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  let shuttingDown: Promise<number> | null = null
  let parentTimer: NodeJS.Timeout | undefined
  const rpc = server

  const shutdown = (reason: string): Promise<number> => {
    if (shuttingDown) return shuttingDown
    shuttingDown = (async () => {
      core.sessionLog('info', `[session] shutting down: ${reason}`)
      if (parentTimer) clearInterval(parentTimer)
      let code = 0
      const stopped = await engine.stop()
      if (!stopped.ok) {
        io.stderr.write(`[session] ${stopped.error}\n`)
        code = 1
      }
      await rpc.close()
      core.dispose()
      io.stdin.destroy?.()
      resolveExited(code)
      return code
    })()
    return shuttingDown
  }
  requestShutdown = (reason) => void shutdown(reason)

  if (io.stdinIsPipe) {
    io.stdin.on('end', () => requestShutdown('stdin closed (parent gone)'))
    io.stdin.on('error', () => requestShutdown('stdin error (parent gone)'))
    io.stdin.resume()
  }
  if (args.parentPid !== undefined) {
    const pid = args.parentPid
    parentTimer = setInterval(() => {
      if (!io.isAlive(pid)) requestShutdown(`parent ${pid} is gone`)
    }, PARENT_PID_POLL_MS)
    parentTimer.unref?.()
  }
  io.onSignal('SIGINT', () => requestShutdown('SIGINT'))
  io.onSignal('SIGTERM', () => requestShutdown('SIGTERM'))

  return { ok: true, session: { server: rpc, core, exited, shutdown } }
}
