/**
 * セッションプロトコル v1 のサーバ（設計 848 §4.4「リスナー」・§4.7・§5.2）。
 *
 * - **UDS 1 本 + TCP 1 本（任意）**。同じ HTTP の実装で両方を listen し、`/rpc` のハンドラは 1 つ。
 *   認証の規則だけをリスナーで分ける: UDS はファイルの権限（runtime-dir 0700・ソケット 0600）、
 *   TCP は Host + Origin（欠落も拒否）+ `session.attach` のトークン
 * - TCP に `/mcp` は無い（v1・`POST /mcp` → 404）。MCP は中継が話す（§6）
 * - 接続直後にサーバが `session.hello` を送る。最初のリクエストは `session.attach` でなければならず、
 *   それより前に来たメソッドは close 1008（握手の順序はリスナーに依らない）
 * - 1 テキストフレーム = 1 メッセージ（JSON-RPC 2.0・バッチは使わない）
 * - 拒否のログは理由だけを書く（トークンや Origin の値を出さない・§4.7「漏れる経路」）
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer, type RawData } from 'ws'

import { checkTcpUpgrade, checkUdsUpgrade, tokensMatch, type UpgradeVerdict } from './http-guard'
import {
  assertParams,
  editorParamsProblem,
  editorResultProblem,
  majorOf,
  METHODS,
  notificationProblem,
  PROTOCOL_VERSION,
  resultProblem,
  RpcError,
} from './protocol'

export type Listener = 'uds' | 'tcp'
export type ClientCapability = 'editor' | 'observer'

/** close コード 1008（policy violation・RFC 6455 §7.4.1）。 */
export const CLOSE_POLICY_VIOLATION = 1008

export interface AttachedClient {
  readonly clientId: string
  readonly listener: Listener
  readonly capabilities: ReadonlySet<ClientCapability>
  readonly name: string
}

export type RequestHandler = (params: any, client: AttachedClient) => unknown | Promise<unknown>
export type NotificationHandler = (params: any, client: AttachedClient) => void

export interface RpcServerOptions {
  /** 既に `claimSocketPath` で確保したソケットのパス。 */
  socketPath: string
  /** TCP の `/rpc`（WebView 専用）。`port` 0 = ephemeral。無ければ TCP を開かない。 */
  tcp?: { port: number; token: string }
  sessionVersion: string
  capabilities?: string[]
  handlers: Readonly<Record<string, RequestHandler>>
  notificationHandlers?: Readonly<Record<string, NotificationHandler>>
  /**
   * TCP のリスナーの HTTP（upgrade でないもの）。`/app/` の配信など（§7.3）。応答したら true。
   * 無ければ・false を返せば 404。UDS は常に 404（`/rpc` だけ）。
   */
  tcpHttp?(request: http.IncomingMessage, response: http.ServerResponse, port: number): boolean
  /** 層 2 自身の行（拒否の理由など）。値を含めない。 */
  log(level: 'error' | 'warn' | 'info', text: string): void
  onAttach?(client: AttachedClient): void
  onDetach?(client: AttachedClient): void
  /** 逆方向のリクエストの期限の既定（テストで縮める）。 */
  editorRequestTimeoutMs?: number
}

export interface RpcServer {
  readonly socketPath: string
  /** TCP を開いた時の実際の port（`--port 0` の結果）。開いていなければ null。 */
  readonly tcpPort: number | null
  clients(): AttachedClient[]
  editorClient(): AttachedClient | null
  /** 接続している全クライアントへ通知を送る（params はスキーマで検査する）。 */
  broadcast(method: string, params: unknown): void
  /**
   * エディタのクライアントへ逆方向のリクエストを送り、答えを待つ（設計 §5.4）。エディタが付いて
   * いなければ `NO_EDITOR_ATTACHED`、期限までに答えなければ `EDITOR_TIMEOUT`、答える前に切れれば
   * `NO_EDITOR_ATTACHED`。答えは `x-editor-request` の result で検査する。
   */
  requestEditor(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
  close(): Promise<void>
}

interface PendingEditorRequest {
  method: string
  resolve(result: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface Connection {
  ws: WebSocket
  listener: Listener
  client: AttachedClient | null
  /** このクライアントへ送った逆方向のリクエスト（id → 待ち）。 */
  pending: Map<string, PendingEditorRequest>
}

/**
 * 逆方向のリクエストの期限（凍結版の相関ブリッジの timeout と同じ役目・§5.4）。
 */
// PROVISIONAL(P-08): 期限は置き値。A-document でエディタの実際の応答時間を測って決める。
export const EDITOR_REQUEST_TIMEOUT_MS = 10_000

function frame(message: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', ...message })
}

function errorFrame(id: unknown, error: RpcError): string {
  return frame({
    id: id ?? null,
    error: {
      code: error.code,
      message: error.message,
      data: { code: error.errorName, ...(error.detail ? { detail: error.detail } : {}) },
    },
  })
}

function rejectUpgrade(socket: Duplex, verdict: Exclude<UpgradeVerdict, { ok: true }>): void {
  const reason = verdict.status === 403 ? 'Forbidden' : 'Not Found'
  socket.write(
    `HTTP/1.1 ${verdict.status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  socket.destroy()
}

function listen(server: http.Server, target: string | number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const done = (): void => {
      server.off('error', reject)
      resolve()
    }
    if (typeof target === 'string') server.listen(target, done)
    else server.listen(target, '127.0.0.1', done)
  })
}

export async function startRpcServer(options: RpcServerOptions): Promise<RpcServer> {
  const wss = new WebSocketServer({ noServer: true })
  const connections = new Set<Connection>()
  let tcpPort: number | null = null

  const attachedClients = (): AttachedClient[] =>
    [...connections].flatMap((connection) => (connection.client ? [connection.client] : []))

  const editorClient = (): AttachedClient | null =>
    attachedClients().find((client) => client.capabilities.has('editor')) ?? null

  const send = (connection: Connection, text: string): void => {
    if (connection.ws.readyState === WebSocket.OPEN) connection.ws.send(text)
  }

  const closeWith = (connection: Connection, reason: string): void => {
    options.log('warn', `closed a /rpc connection (${connection.listener}): ${reason}`)
    connection.ws.close(CLOSE_POLICY_VIOLATION, reason)
  }

  /** `session.attach`。同期に処理し、次のメッセージが来る前に状態を切り替える。 */
  const attach = (connection: Connection, id: unknown, params: unknown): void => {
    if (connection.client) {
      send(connection, errorFrame(id, new RpcError('INVALID_REQUEST', 'already attached')))
      return
    }
    // トークンの検査は params の形より先に行う（TCP で鍵の無い者に形の誤りを教えない）。
    const token = (params as { token?: unknown } | null)?.token
    if (connection.listener === 'tcp') {
      if (token === undefined) return closeWith(connection, 'token missing')
      if (!tokensMatch(options.tcp!.token, token)) return closeWith(connection, 'token mismatch')
    }
    try {
      assertParams('session.attach', params)
    } catch (error) {
      send(connection, errorFrame(id, error as RpcError))
      return
    }
    const input = params as {
      protocol_version: string
      client: { name: string; version: string }
      capabilities: ClientCapability[]
    }
    if (majorOf(input.protocol_version) !== majorOf(PROTOCOL_VERSION)) {
      send(
        connection,
        errorFrame(
          id,
          new RpcError(
            'PROTOCOL_VERSION_MISMATCH',
            `protocol version mismatch: session speaks ${PROTOCOL_VERSION}, client sent ${input.protocol_version}`,
          ),
        ),
      )
      closeWith(connection, 'protocol version mismatch')
      return
    }
    const capabilities = new Set(input.capabilities)
    if (capabilities.has('editor') && editorClient()) {
      send(
        connection,
        errorFrame(
          id,
          new RpcError('EDITOR_ALREADY_ATTACHED', 'another editor client is already attached'),
        ),
      )
      return
    }
    const client: AttachedClient = {
      clientId: crypto.randomBytes(9).toString('base64url'),
      listener: connection.listener,
      capabilities,
      name: input.client.name,
    }
    connection.client = client
    send(connection, frame({ id, result: { clientId: client.clientId } }))
    options.onAttach?.(client)
  }

  const dispatch = async (
    connection: Connection,
    message: Record<string, unknown>,
  ): Promise<void> => {
    const { id, method, params } = message
    const isRequest = id !== undefined
    if (typeof method !== 'string') {
      // クライアントからの応答（逆方向リクエストへの答え）。
      if (isRequest && ('result' in message || 'error' in message)) {
        settleEditorRequest(connection, message)
        return
      }
      send(connection, errorFrame(id, new RpcError('INVALID_REQUEST', 'missing method')))
      return
    }
    if (method === 'session.attach') {
      if (!isRequest) return closeWith(connection, 'session.attach must be a request')
      attach(connection, id, params)
      return
    }
    const client = connection.client
    if (!client) return closeWith(connection, `${method} before session.attach`)
    const spec = METHODS[method]
    if (!spec || spec.direction !== 'client-to-server') {
      if (isRequest) {
        send(
          connection,
          errorFrame(id, new RpcError('METHOD_NOT_FOUND', `unknown method ${method}`)),
        )
      }
      return
    }
    try {
      assertParams(method, params)
      if (spec.kind === 'notification') {
        const handle = options.notificationHandlers?.[method]
        if (!handle)
          throw new RpcError('METHOD_NOT_FOUND', `${method} has no handler in this server`)
        handle(params ?? {}, client)
        return
      }
      const handle = options.handlers[method]
      if (!handle) {
        // `SessionCore` はスキーマの C→S のメソッドをすべて実装する（`session-core-methods.spec.ts`）。
        // ここに来るのは、ハンドラの一部だけで立てたサーバ（テスト）か配線の欠陥。
        throw new RpcError(
          'METHOD_NOT_FOUND',
          `${method} has no handler in this server`,
          'declared in the v1 schema, but this server was started without a handler for it',
        )
      }
      const result = await handle(params ?? {}, client)
      const problem = resultProblem(method, result)
      if (problem) {
        options.log('error', `[session] ${method} produced a result outside the schema: ${problem}`)
        throw new RpcError('INTERNAL_ERROR', `${method} produced an invalid result`)
      }
      if (isRequest) send(connection, frame({ id, result }))
    } catch (error) {
      if (!isRequest) {
        if (error instanceof RpcError && error.errorName === 'METHOD_NOT_FOUND') return
        options.log('warn', `[session] notification ${method} failed: ${String(error)}`)
        return
      }
      const rpcError =
        error instanceof RpcError
          ? error
          : new RpcError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
      send(connection, errorFrame(id, rpcError))
    }
  }

  const onMessage = (connection: Connection, data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      send(
        connection,
        errorFrame(null, new RpcError('INVALID_REQUEST', 'binary frames are not used')),
      )
      return
    }
    let message: unknown
    try {
      message = JSON.parse(data.toString())
    } catch {
      send(connection, errorFrame(null, new RpcError('PARSE_ERROR', 'invalid JSON')))
      return
    }
    if (
      typeof message !== 'object' ||
      message === null ||
      Array.isArray(message) ||
      (message as { jsonrpc?: unknown }).jsonrpc !== '2.0'
    ) {
      send(
        connection,
        errorFrame(null, new RpcError('INVALID_REQUEST', 'not a JSON-RPC 2.0 message')),
      )
      return
    }
    void dispatch(connection, message as Record<string, unknown>)
  }

  const settleEditorRequest = (connection: Connection, message: Record<string, unknown>): void => {
    const id = String(message.id)
    const waiting = connection.pending.get(id)
    if (!waiting) return
    connection.pending.delete(id)
    clearTimeout(waiting.timer)
    if ('error' in message) {
      const error = message.error as { message?: unknown } | undefined
      waiting.reject(
        new RpcError(
          'INTERNAL_ERROR',
          `the editor failed ${waiting.method}: ${String(error?.message ?? 'unknown error')}`,
        ),
      )
      return
    }
    const problem = editorResultProblem(waiting.method, message.result)
    if (problem) {
      options.log(
        'error',
        `[session] the editor answered ${waiting.method} outside the schema: ${problem}`,
      )
      waiting.reject(
        new RpcError(
          'INTERNAL_ERROR',
          `the editor answered ${waiting.method} with an invalid result`,
        ),
      )
      return
    }
    waiting.resolve(message.result)
  }

  let editorRequestId = 0
  const requestEditor = (
    method: string,
    params: unknown,
    timeoutMs = options.editorRequestTimeoutMs ?? EDITOR_REQUEST_TIMEOUT_MS,
  ) => {
    const problem = editorParamsProblem(method, params)
    if (problem) {
      return Promise.reject(
        new Error(`refusing to send ${method} to the editor outside the schema: ${problem}`),
      )
    }
    const connection = [...connections].find((candidate) =>
      candidate.client?.capabilities.has('editor'),
    )
    if (!connection) {
      return Promise.reject(
        new RpcError(
          'NO_EDITOR_ATTACHED',
          'no editor is attached to this session — open a document window in OrbitStudio',
        ),
      )
    }
    const id = `layer2-${(editorRequestId += 1)}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id)
        reject(
          new RpcError(
            'EDITOR_TIMEOUT',
            `the editor did not answer ${method} within ${timeoutMs} ms`,
          ),
        )
      }, timeoutMs)
      connection.pending.set(id, { method, resolve, reject, timer })
      send(connection, frame({ id, method, params }))
    })
  }

  const onConnection = (ws: WebSocket, listener: Listener): void => {
    const connection: Connection = { ws, listener, client: null, pending: new Map() }
    connections.add(connection)
    ws.on('message', (data, isBinary) => onMessage(connection, data, isBinary))
    ws.on('close', () => {
      connections.delete(connection)
      for (const [, waiting] of connection.pending) {
        clearTimeout(waiting.timer)
        waiting.reject(
          new RpcError(
            'NO_EDITOR_ATTACHED',
            `the editor disconnected before answering ${waiting.method}`,
          ),
        )
      }
      connection.pending.clear()
      if (connection.client) options.onDetach?.(connection.client)
    })
    ws.on('error', (error) => options.log('warn', `[session] /rpc socket error: ${error.message}`))
    send(
      connection,
      frame({
        method: 'session.hello',
        params: {
          protocol_version: PROTOCOL_VERSION,
          session_version: options.sessionVersion,
          capabilities: options.capabilities ?? [],
        },
      }),
    )
  }

  const upgradeWith =
    (listener: Listener, check: (request: http.IncomingMessage) => UpgradeVerdict) =>
    (request: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
      const verdict = check(request)
      if (!verdict.ok) {
        options.log('warn', `rejected a /rpc upgrade (${listener}): ${verdict.reason}`)
        rejectUpgrade(socket, verdict)
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws, listener))
    }

  const notFound = (_request: http.IncomingMessage, response: http.ServerResponse): void => {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('not found\n')
  }

  const uds = http.createServer(notFound)
  uds.on(
    'upgrade',
    upgradeWith('uds', (request) => checkUdsUpgrade(request.url)),
  )
  await listen(uds, options.socketPath)
  fs.chmodSync(options.socketPath, 0o600)

  let tcp: http.Server | null = null
  if (options.tcp) {
    tcp = http.createServer((request, response) => {
      if (options.tcpHttp?.(request, response, tcpPort ?? 0)) return
      notFound(request, response)
    })
    tcp.on(
      'upgrade',
      upgradeWith('tcp', (request) =>
        checkTcpUpgrade({
          url: request.url,
          host: request.headers.host,
          origin: request.headers.origin,
          port: tcpPort ?? 0,
        }),
      ),
    )
    try {
      await listen(tcp, options.tcp.port)
    } catch (error) {
      await new Promise<void>((resolve) => uds.close(() => resolve()))
      fs.rmSync(options.socketPath, { force: true })
      throw error
    }
    tcpPort = (tcp.address() as AddressInfo).port
  }

  return {
    socketPath: options.socketPath,
    tcpPort,
    clients: attachedClients,
    editorClient,
    broadcast(method: string, params: unknown): void {
      const problem = notificationProblem(method, params)
      if (problem) throw new Error(`refusing to broadcast ${method} outside the schema: ${problem}`)
      const text = frame({ method, params })
      for (const connection of connections) if (connection.client) send(connection, text)
    },
    requestEditor,
    async close(): Promise<void> {
      for (const connection of connections) connection.ws.close(1001, 'session shutting down')
      const closing = [uds, ...(tcp ? [tcp] : [])].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections()
          }),
      )
      wss.close()
      await Promise.all(closing)
      fs.rmSync(options.socketPath, { force: true })
    },
  }
}
