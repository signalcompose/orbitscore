/**
 * テスト用の JSON-RPC over WebSocket クライアント（UDS は `ws+unix:`・TCP は `ws://`）。
 */
import { WebSocket } from 'ws'

export interface RpcResponse {
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: { code: string; detail?: string } }
}

/** 層 2 からの逆方向のリクエストへの答え方。`undefined` を返せば答えない（期限切れの検査）。 */
export type EditorAnswer = (
  method: string,
  params: any,
) => { result: unknown } | { error: { code: number; message: string } } | undefined

export class RpcTestClient {
  readonly notifications: Array<{ method: string; params: any }> = []
  /** 層 2 から届いた逆方向のリクエスト（届いた順）。 */
  readonly editorRequests: Array<{ id: string; method: string; params: any }> = []
  /** 逆方向のリクエストに答える関数（無ければ答えない）。 */
  answer: EditorAnswer | null = null
  readonly closed: Promise<{ code: number; reason: string }>
  private nextId = 1
  private readonly pending = new Map<number, (response: RpcResponse) => void>()
  private helloResolve!: (params: any) => void
  readonly hello: Promise<any> = new Promise((resolve) => {
    this.helloResolve = resolve
  })

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.method === 'session.hello') this.helloResolve(message.params)
      if (message.method && message.id !== undefined) {
        this.editorRequests.push({ id: message.id, method: message.method, params: message.params })
        const reply = this.answer?.(message.method, message.params)
        if (reply) this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }))
      } else if (message.method)
        this.notifications.push({ method: message.method, params: message.params })
      else this.pending.get(message.id)?.(message)
    })
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<RpcTestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers })
      const client = new RpcTestClient(ws)
      ws.once('open', () => resolve(client))
      ws.once('unexpected-response', (_request, response) =>
        reject(
          Object.assign(new Error(`upgrade rejected: ${response.statusCode}`), {
            status: response.statusCode,
          }),
        ),
      )
      ws.once('error', reject)
    })
  }

  static uds(socketPath: string): Promise<RpcTestClient> {
    return RpcTestClient.connect(`ws+unix:${socketPath}:/rpc`)
  }

  request(method: string, params: unknown = {}): Promise<RpcResponse> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  notify(method: string, params: unknown = {}): void {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  attach(extra: Record<string, unknown> = {}): Promise<RpcResponse> {
    return this.request('session.attach', {
      protocol_version: '1.0',
      client: { name: 'test', version: '0' },
      capabilities: ['observer'],
      ...extra,
    })
  }

  close(): void {
    this.ws.close()
  }
}
