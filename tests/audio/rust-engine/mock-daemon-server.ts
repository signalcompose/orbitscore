/**
 * テスト用の mock WebSocket daemon server。
 *
 * 実 daemon バイナリを spawn せずに `DaemonClient` の protocol 挙動を検証する。
 * handshake を送り、subset の method に対して hardcoded な応答を返す。
 */

import { AddressInfo } from 'net'

import { WebSocket, WebSocketServer } from 'ws'

import { PROTOCOL_VERSION } from '../../../packages/engine/src/audio/rust-engine/protocol-types'

type CommandRecord = {
  id: string
  method: string
  params: Record<string, unknown>
}

/** ハンドラは値 or Promise を返せる（async handler で遅延応答を模擬できる）。 */
type MockHandler = (
  params: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>

export interface MockDaemonHandlers {
  LoadSample?: MockHandler
  PlayAt?: MockHandler
  Stop?: MockHandler
  SetGlobalGain?: MockHandler
  GetStatus?: MockHandler
}

export class MockDaemonServer {
  private wss: WebSocketServer | null = null
  readonly received: CommandRecord[] = []
  private sockets = new Set<WebSocket>()

  async start(handlers: MockDaemonHandlers = {}, skipHandshake = false): Promise<string> {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => this.wss!.once('listening', () => resolve()))
    const addr = this.wss.address() as AddressInfo
    const url = `ws://127.0.0.1:${addr.port}`

    this.wss.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))

      if (!skipHandshake) {
        socket.send(
          JSON.stringify({
            type: 'handshake',
            protocol_version: PROTOCOL_VERSION,
            daemon_version: 'mock-0.0.0',
            capabilities: ['playback'],
          }),
        )
      }

      socket.on('message', async (raw) => {
        let parsed: CommandRecord
        try {
          parsed = JSON.parse(raw.toString()) as CommandRecord
        } catch {
          return
        }
        this.received.push(parsed)
        const handler = handlers[parsed.method as keyof MockDaemonHandlers]
        if (!handler) {
          // mock 固有の error code。本物 daemon の MALFORMED_REQUEST とは意味が違い、
          // 「テストがハンドラを登録し忘れた」ことを示す。
          socket.send(
            JSON.stringify({
              id: parsed.id,
              error: {
                code: 'UNKNOWN_METHOD',
                message: `mock: no handler registered for method ${parsed.method}`,
              },
            }),
          )
          return
        }
        try {
          const result = await handler(parsed.params)
          socket.send(JSON.stringify({ id: parsed.id, result }))
        } catch (e) {
          const err = e as Error & { code?: string }
          socket.send(
            JSON.stringify({
              id: parsed.id,
              error: {
                code: err.code ?? 'INTERNAL_ERROR',
                message: err.message,
              },
            }),
          )
        }
      })
    })

    return url
  }

  /**
   * 接続中の socket だけを閉じ、server は listen させたままにする（recovery floor の
   * respawn テスト用）。実 daemon のプロセス死 → client 側 ws close を模擬しつつ、
   * 同一 URL への再接続を可能にする。`stop()` は server ごと閉じるので再接続不可。
   */
  dropConnections(): void {
    for (const s of this.sockets) {
      try {
        s.close()
      } catch {
        /* swallow */
      }
    }
    this.sockets.clear()
  }

  /** テストから任意の event を流すための helper。 */
  broadcastEvent(event: string, data: Record<string, unknown>): void {
    const payload = JSON.stringify({ type: 'event', event, data })
    for (const s of this.sockets) {
      if (s.readyState === WebSocket.OPEN) s.send(payload)
    }
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) {
      try {
        s.close()
      } catch {
        /* swallow */
      }
    }
    this.sockets.clear()
    if (!this.wss) return
    await new Promise<void>((resolve) => this.wss!.close(() => resolve()))
    this.wss = null
  }
}
