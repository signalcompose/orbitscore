/**
 * 中継 `orbitscore relay`（設計 848 §6・§6.2）。LLM クライアントが stdio で起動する MCP サーバで、
 * ツールを呼ばれるたびに UDS の `/rpc` で層 2 を呼ぶ。
 *
 *   node dist/cli.js relay [--runtime-dir <dir>]
 *
 * 中継の規則（§6.2・検査は `tests/session/relay-process.spec.ts`）:
 * - RL-1 上流の失敗で終了しない。終了は stdin の EOF と SIGINT / SIGTERM だけ
 * - RL-2 `initialize` / `tools/list` は上流なしで答える（ツールの一覧はビルドに埋めてある）。
 *   `server/discover` は SDK が即座に method-not-found を返す（この SDK は MCP 2026-07-28 を話さない）
 * - RL-3 RPC のたびにソケットへ繋ぐ。届かなければ短く待ち、それでも届かなければツールのエラーで
 *   「OrbitStudio が起動していない / 再起動中」
 * - RL-4 送った後に切れた呼び出しを再送しない。「実行されたか不明」と返す
 * - RL-5 MAJOR が違えば、ツールのエラーで「更新された。`/mcp` で再接続」
 * - RL-6 層 2 を起動しない / RL-7 stdout は MCP のフレームだけ・ログは stderr / RL-8 秘密を持たない
 */
import { buildServer } from '../mcp/build-server'
import {
  createRpcDocsSource,
  createRpcToolHandlers,
  type SessionCall,
} from '../mcp/rpc-tool-handlers'
import {
  connectSession,
  ProtocolMismatchError,
  RpcConnectionClosedError,
  type ConnectOptions,
  type SessionConnection,
} from '../rpc/client'
import { PROTOCOL_VERSION } from '../rpc/protocol'
import { resolveRuntimeDir, resolveSocketPath } from '../rpc/runtime-dir'

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js') as {
  StdioServerTransport: new (
    stdin?: NodeJS.ReadableStream,
    stdout?: NodeJS.WritableStream,
  ) => unknown
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/**
 * ソケットに届かない時に繋ぎ直すまでの待ち（RL-3）。合計がツール呼び出しの「短く待つ」の上限。
 */
// PROVISIONAL(P-08): 上限は置き値。束 S-mcp の検算（手元・アプリの再起動にかかる時間）で決める。
export const RELAY_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500]

export const NOT_RUNNING_MESSAGE =
  'OrbitStudio is not running (or is restarting) — start OrbitStudio (or `orbitscore session`), ' +
  'then call the tool again'

export function updatedMessage(serverVersion: string): string {
  return (
    `OrbitStudio was updated (session protocol ${serverVersion}, relay ${PROTOCOL_VERSION}) — ` +
    'reconnect orbitstudio with /mcp'
  )
}

export function unknownOutcomeMessage(method: string): string {
  return (
    `the connection to OrbitStudio closed before ${method} answered — it is unknown whether it ran; ` +
    'check get_log or get_engine_state before calling the tool again'
  )
}

export interface RelayCallOptions {
  client: ConnectOptions['client']
  retryDelaysMs?: readonly number[]
  connect?: typeof connectSession
  sleep?: (ms: number) => Promise<void>
}

/**
 * RPC 1 回 = 接続 1 本（RL-3）。繋ぎ直すのは**送る前**（接続か handshake の失敗）だけで、
 * 送った後に切れたら再送しない（RL-4）。
 */
export function createRelayCall(socketPath: string, options: RelayCallOptions): SessionCall {
  const connect = options.connect ?? connectSession
  const delays = options.retryDelaysMs ?? RELAY_RETRY_DELAYS_MS
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const open = async (): Promise<SessionConnection> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await connect(socketPath, { client: options.client })
      } catch (error) {
        if (error instanceof ProtocolMismatchError)
          throw new Error(updatedMessage(error.serverVersion))
        if (attempt >= delays.length) throw new Error(NOT_RUNNING_MESSAGE)
        await sleep(delays[attempt]!)
      }
    }
  }
  return (async <T>(method: string, params?: unknown): Promise<T> => {
    const connection = await open()
    try {
      return await connection.call<T>(method, params)
    } catch (error) {
      // 層 2 のエラー（`RpcCallError`）は層 2 の文言のまま投げる。
      if (error instanceof RpcConnectionClosedError) throw new Error(unknownOutcomeMessage(method))
      throw error
    } finally {
      connection.close()
    }
  }) as SessionCall
}

export interface RelayIo {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  env: NodeJS.ProcessEnv
  onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void
}

export function parseRelayArgs(
  argv: readonly string[],
): { ok: true; runtimeDir?: string } | { ok: false; message: string } {
  let runtimeDir: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--runtime-dir' && argv[i + 1] !== undefined) {
      runtimeDir = argv[i + 1]
      i += 1
    } else {
      return { ok: false, message: `unknown or incomplete argument: ${arg}` }
    }
  }
  return { ok: true, runtimeDir }
}

export interface RelayStart {
  socketPath: string
  /** 終了の理由（stdin の EOF・シグナル）が来た時に解決する。 */
  exited: Promise<number>
}

export async function startRelay(
  argv: readonly string[],
  io: RelayIo,
  version: string,
): Promise<{ ok: true; relay: RelayStart } | { ok: false; exitCode: number }> {
  const parsed = parseRelayArgs(argv)
  if (!parsed.ok) {
    io.stderr.write(`[relay] ${parsed.message}\nusage: cli.js relay [--runtime-dir <dir>]\n`)
    return { ok: false, exitCode: 2 }
  }
  const socket = resolveSocketPath(resolveRuntimeDir(parsed.runtimeDir, io.env))
  if (!socket.ok) {
    io.stderr.write(`[relay] ${socket.reason}\n`)
    return { ok: false, exitCode: 1 }
  }
  const call = createRelayCall(socket.socketPath, {
    client: { name: 'orbitstudio-relay', version },
  })
  const server = buildServer(version, createRpcToolHandlers(call), createRpcDocsSource(call))
  await server.connect(new StdioServerTransport(io.stdin, io.stdout))
  io.stderr.write(`[relay] serving MCP on stdio; session socket: ${socket.socketPath}\n`)

  let resolveExited!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  // RL-7: 止め方の窓（SIGINT → 100 ms → SIGTERM）の中で終わる。後始末を待たない。
  io.stdin.on('end', () => resolveExited(0))
  io.onSignal('SIGINT', () => resolveExited(0))
  io.onSignal('SIGTERM', () => resolveExited(0))
  return { ok: true, relay: { socketPath: socket.socketPath, exited } }
}
