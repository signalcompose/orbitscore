/**
 * 層 2 の RPC クライアント（UDS・設計 848 §4.7・§5.2）。中継（§6）とテストが使う。
 *
 * 接続の手順: サーバが最初に送る `session.hello` を待ち、`protocol_version` の MAJOR が同じなら
 * `session.attach`。MAJOR が違えば attach せずに失敗する（中継はそれを RL-5 の文言にする）。
 *
 * 失敗は 3 種類に分ける（中継が RL-3 / RL-4 / RL-5 の文言を選ぶため）:
 * - `RpcCallError` — 層 2 が JSON-RPC のエラーで答えた（`errorName` は `x-errors` のキー）
 * - `RpcConnectionClosedError` — 要求を送った後、答えの前に接続が切れた（実行されたかは不明）
 * - それ以外（`connect` の reject）— ソケットに届かない（`ENOENT` / `ECONNREFUSED`）か MAJOR 違い
 */
import { WebSocket } from 'ws'

import { majorOf, PROTOCOL_VERSION } from './protocol'

export class RpcCallError extends Error {
  constructor(
    readonly code: number,
    /** `x-errors` のキー（`data.code`）。読めなければ undefined。 */
    readonly errorName: string | undefined,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
  }
}

/** 要求を送った後に接続が切れた。層 2 がそれを実行したかどうかは分からない（RL-4）。 */
export class RpcConnectionClosedError extends Error {
  constructor(readonly method: string) {
    super(`connection to the session closed before ${method} answered`)
  }
}

/** `session.hello` の MAJOR がこのクライアントと違う（RL-5）。 */
export class ProtocolMismatchError extends Error {
  constructor(readonly serverVersion: string) {
    super(
      `session protocol ${serverVersion} is incompatible with this client (${PROTOCOL_VERSION})`,
    )
  }
}

export interface SessionHello {
  protocol_version: string
  session_version: string
  capabilities: string[]
}

export interface ConnectOptions {
  client: { name: string; version: string }
  capabilities?: Array<'editor' | 'observer'>
  /** `session.hello` を待つ上限（既定 5 秒）。 */
  helloTimeoutMs?: number
  onNotification?(method: string, params: unknown): void
}

export interface SessionConnection {
  readonly hello: SessionHello
  readonly clientId: string
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  close(): void
  readonly closed: Promise<void>
}

const HELLO_TIMEOUT_MS = 5_000

export function connectSession(
  socketPath: string,
  options: ConnectOptions,
): Promise<SessionConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix:${socketPath}:/rpc`)
    const pending = new Map<
      number,
      { method: string; resolve(value: unknown): void; reject(error: Error): void }
    >()
    let nextId = 1
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(helloTimer)
      ws.terminate()
      reject(error)
    }
    const helloTimer = setTimeout(
      () => fail(new Error('the session did not send session.hello')),
      options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    )
    const closed = new Promise<void>((resolveClosed) => {
      ws.on('close', () => {
        clearTimeout(helloTimer)
        for (const [, call] of pending) call.reject(new RpcConnectionClosedError(call.method))
        pending.clear()
        fail(new Error('the session closed the connection during the handshake'))
        resolveClosed()
      })
    })

    const call = <T>(method: string, params: unknown = {}): Promise<T> =>
      new Promise<T>((resolveCall, rejectCall) => {
        if (ws.readyState !== WebSocket.OPEN) {
          rejectCall(new RpcConnectionClosedError(method))
          return
        }
        const id = nextId++
        pending.set(id, {
          method,
          resolve: resolveCall as (value: unknown) => void,
          reject: rejectCall,
        })
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })

    const attach = async (hello: SessionHello) => {
      if (majorOf(hello.protocol_version) !== majorOf(PROTOCOL_VERSION)) {
        fail(new ProtocolMismatchError(hello.protocol_version))
        return
      }
      try {
        const attached = await call<{ clientId: string }>('session.attach', {
          protocol_version: PROTOCOL_VERSION,
          client: options.client,
          capabilities: options.capabilities ?? [],
        })
        if (settled) return
        settled = true
        resolve({
          hello,
          clientId: attached.clientId,
          call,
          close: () => ws.close(),
          closed,
        })
      } catch (error) {
        fail(error as Error)
      }
    }

    ws.on('error', (error) => fail(error))
    ws.on('message', (data) => {
      let message: {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
        error?: { code: number; message: string; data?: { code?: string; detail?: string } }
      }
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }
      if (message.method === 'session.hello') {
        clearTimeout(helloTimer)
        void attach(message.params as SessionHello)
        return
      }
      if (message.method) {
        options.onNotification?.(message.method, message.params)
        return
      }
      const waiting = message.id === undefined ? undefined : pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id!)
      if (message.error) {
        const { code, message: text, data: info } = message.error
        waiting.reject(new RpcCallError(code, info?.code, text, info?.detail))
      } else {
        waiting.resolve(message.result)
      }
    })
  })
}
