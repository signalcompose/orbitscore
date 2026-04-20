/**
 * Rust orbit-audio-daemon との WebSocket クライアント。
 *
 * 1. daemon バイナリを子プロセスで spawn
 * 2. stdout の ready line から port を取得
 * 3. `ws://127.0.0.1:<port>` に接続し handshake 受信を確認
 * 4. JSON-RPC 風の request/response を id で多重化
 * 5. event frames を EventEmitter に dispatch
 *
 * Phase 1 の scope。実 daemon との integration test は scope 外で、
 * `tests/audio/rust-engine/mock-daemon-server.ts` の mock WebSocket server で
 * protocol 仕様との一致を検証する。
 */

import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createInterface } from 'readline'
import * as fs from 'fs'
import * as path from 'path'

import { v4 as uuidv4 } from 'uuid'
import WebSocket from 'ws'

import {
  DaemonConnectionError,
  DaemonNotFoundError,
  DaemonProtocolError,
  DaemonQuitError,
  DaemonStartupError,
} from './errors'
import {
  CommandFrame,
  CommandMethod,
  isEventFrame,
  isHandshakeFrame,
  isResponseFrame,
  PROTOCOL_VERSION,
  ResponseFrame,
  StartupErrorLine,
  StartupReadyLine,
} from './protocol-types'

export interface DaemonClientOptions {
  /** 明示的な daemon バイナリパス。未指定時は環境変数 → 既定パスの順で探索。 */
  daemonPath?: string
  /** daemon stdout に ready line が出るまでの timeout。 */
  startupTimeoutMs?: number
  /** WebSocket 接続 timeout。 */
  connectTimeoutMs?: number
  /** handshake フレーム受信 timeout。 */
  handshakeTimeoutMs?: number
  /**
   * テスト用: spawn を skip して既存 ws URL に接続する抜け道。
   * production code からは使用しない。
   * @internal
   */
  wsUrlOverride?: string
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: unknown) => void
  method: string
}

export class DaemonClient extends EventEmitter {
  private child: ChildProcess | null = null
  private ws: WebSocket | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private running = false
  /** 並列 start() を直列化し、daemon を二重に spawn しないためのシングルフライト。 */
  private startPromise: Promise<void> | null = null

  isRunning(): boolean {
    return this.running
  }

  async start(options: DaemonClientOptions = {}): Promise<void> {
    if (this.running) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart(options).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async doStart(options: DaemonClientOptions): Promise<void> {
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS

    // spawn/connect/handshake のいずれかが throw した場合、this.child / this.ws が
    // dangling になるのを防ぐため try/catch で包み、失敗時は明示的に cleanup する。
    // quit() は this.running===false なら no-op なので手動回収が必要。
    try {
      const wsUrl =
        options.wsUrlOverride ?? (await this.spawnDaemon(options.daemonPath, startupTimeoutMs))

      // handshake の検出ハンドラを connectWebSocket より先に用意。
      // open 後すぐ message が届くケースでも handshakeResolver が
      // セット済みの状態で handleFrame を通るようにする。
      const handshakePromise = new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => {
          this.handshakeResolver = null
          reject(new Error(`handshake timeout after ${handshakeTimeoutMs}ms`))
        }, handshakeTimeoutMs)
        this.handshakeResolver = (err) => {
          clearTimeout(to)
          this.handshakeResolver = null
          if (err) reject(err)
          else resolve()
        }
      })

      await this.connectWebSocket(wsUrl, connectTimeoutMs)
      await handshakePromise
      this.running = true
    } catch (err) {
      await this.cleanupAfterStartFailure()
      throw err
    }
  }

  /** doStart の中断時に this.child / this.ws を確実に回収する。 */
  private async cleanupAfterStartFailure(): Promise<void> {
    this.handshakeResolver = null
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // close で throw しても startup エラーを優先したいので握り潰す。
      }
      this.ws = null
    }
    if (this.child && !this.child.killed) {
      const child = this.child
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const to = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 500)
        child.once('exit', () => {
          clearTimeout(to)
          resolve()
        })
      })
    }
    this.child = null
    // pending は spawn/handshake 段階では存在しないが念のため reject しておく。
    for (const [, pend] of this.pending) {
      pend.reject(new Error('daemon startup failed'))
    }
    this.pending.clear()
  }

  async loadSample(
    filePath: string,
  ): Promise<{ sampleId: string; frames: number; channels: number; sampleRate: number }> {
    const result = await this.request('LoadSample', { path: filePath })
    return {
      sampleId: String(result.sample_id),
      frames: Number(result.frames),
      channels: Number(result.channels),
      sampleRate: Number(result.sample_rate),
    }
  }

  async playAt(sampleId: string, timeSec: number, gain: number): Promise<{ playId: string }> {
    const result = await this.request('PlayAt', {
      sample_id: sampleId,
      time_sec: timeSec,
      gain,
    })
    return { playId: String(result.play_id) }
  }

  async stop(playId: string): Promise<boolean> {
    const result = await this.request('Stop', { play_id: playId })
    return result.status === 'stopped'
  }

  async setGlobalGain(value: number, rampSec = 0): Promise<void> {
    await this.request('SetGlobalGain', { value, ramp_sec: rampSec })
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return this.request('GetStatus', {})
  }

  async quit(): Promise<void> {
    if (!this.running) return
    this.running = false
    try {
      this.ws?.close()
    } catch (e) {
      // ws.close() は原則 throw しないが、ws ライブラリ内部の assertion 等で
      // 例外が出ても quit は継続する。完全に silent にすると cleanup 失敗が
      // 隠れるため 'ws-close-error' event に通知する。
      this.emit('ws-close-error', e)
    }
    this.ws = null
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const to = setTimeout(() => {
          this.child?.kill('SIGKILL')
          resolve()
        }, 500)
        this.child?.once('exit', () => {
          clearTimeout(to)
          resolve()
        })
      })
    }
    this.child = null
    for (const [, pend] of this.pending) {
      pend.reject(new DaemonQuitError())
    }
    this.pending.clear()
  }

  // --- internals ---

  private async request(
    method: CommandMethod,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`daemon client not connected (method=${method})`)
    }
    const id = uuidv4()
    const cmd: CommandFrame = { id, method, params }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws!.send(JSON.stringify(cmd), (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  private handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.emit('parse-error', raw)
      return
    }
    if (isResponseFrame(parsed)) {
      this.dispatchResponse(parsed)
      return
    }
    if (isEventFrame(parsed)) {
      const evName = this.frameEventName(parsed.event)
      this.emit(evName, parsed.data)
      return
    }
    // handshake 以外の unknown frame は dev ビルドの補助として出すのみ
    this.emit('unknown-frame', parsed)
  }

  private frameEventName(event: string): string {
    switch (event) {
      case 'PlayStarted':
        return 'play-started'
      case 'PlayEnded':
        return 'play-ended'
      case 'StreamStats':
        return 'stream-stats'
      case 'DaemonError':
        return 'daemon-error'
      default:
        return 'unknown-event'
    }
  }

  private dispatchResponse(frame: ResponseFrame): void {
    const pend = this.pending.get(frame.id)
    if (!pend) {
      this.emit('orphan-response', frame)
      return
    }
    this.pending.delete(frame.id)
    if ('error' in frame) {
      pend.reject(
        new DaemonProtocolError(frame.error.code, frame.error.message, frame.error.details),
      )
    } else {
      pend.resolve(frame.result)
    }
  }

  private async spawnDaemon(explicitPath: string | undefined, timeoutMs: number): Promise<string> {
    const binary = this.resolveDaemonBinary(explicitPath)
    const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    const stderrChunks: string[] = []
    // startup 診断用の stderr 収集。ready-line が settle したら detach して
    // daemon の長期稼働中に stderr を無限に蓄積しないようにする。
    const onStderrData = (chunk: Buffer): void => {
      stderrChunks.push(chunk.toString())
    }
    child.stderr?.on('data', onStderrData)
    const detachStderr = (): void => {
      child.stderr?.off('data', onStderrData)
    }

    const reader = createInterface({ input: child.stdout! })
    const port = await new Promise<number>((resolve, reject) => {
      // ready-line 受信 / timeout / exit のいずれか最初に発火した結果だけを
      // 採用する。settled flag で二重解決を防ぐ (startup crash で line と exit
      // が両方届くケースに備える)。
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(to)
        reader.close()
        detachStderr()
        fn()
      }
      const to = setTimeout(() => {
        finish(() =>
          reject(
            new DaemonStartupError(
              `daemon ready line timeout after ${timeoutMs}ms`,
              stderrChunks.join(''),
              child.exitCode,
            ),
          ),
        )
      }, timeoutMs)

      // 現行 daemon は stdout の先頭行に ready JSON のみを書き、log は stderr に
      // 分離している (docs/research/ENGINE_DAEMON_PROTOCOL.md)。しかし将来の daemon
      // 実装で log banner 等が stdout に混入しても壊れないよう、JSON parse できる
      // 行が出るまで読み続ける防御的実装にする。
      const skippedLines: string[] = []
      reader.on('line', (line) => {
        if (settled) return
        let parsed: StartupReadyLine | StartupErrorLine
        try {
          parsed = JSON.parse(line) as StartupReadyLine | StartupErrorLine
        } catch {
          // JSON として読めない行は log とみなしてスキップし次の行を待つ。
          skippedLines.push(line)
          return
        }
        finish(() => {
          if (!parsed.ready) {
            reject(
              new DaemonStartupError(
                `daemon startup error: ${parsed.error.code}: ${parsed.error.message}`,
                stderrChunks.join(''),
                null,
              ),
            )
            return
          }
          if (parsed.protocol_version !== PROTOCOL_VERSION) {
            reject(
              new DaemonStartupError(
                `protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${parsed.protocol_version}`,
                stderrChunks.join(''),
                null,
              ),
            )
            return
          }
          if (skippedLines.length > 0) {
            // 予期せぬ stdout 出力は event で通知して debug に残す。
            this.emit('unexpected-stdout', skippedLines)
          }
          resolve(parsed.port)
        })
      })

      child.once('exit', (code) => {
        finish(() =>
          reject(
            new DaemonStartupError(
              `daemon exited before ready (code=${code})`,
              stderrChunks.join(''),
              code,
            ),
          ),
        )
      })
    })

    return `ws://127.0.0.1:${port}`
  }

  private resolveDaemonBinary(explicitPath: string | undefined): string {
    const searched: string[] = []
    const candidates: string[] = []
    if (explicitPath) candidates.push(explicitPath)
    const envPath = process.env.ORBIT_AUDIO_DAEMON_PATH
    if (envPath) candidates.push(envPath)
    // monorepo root (this file は packages/engine/src/audio/rust-engine/) から 4 階層
    const monorepoRoot = path.resolve(__dirname, '../../../../../')
    candidates.push(path.join(monorepoRoot, 'rust/target/release/orbit-audio-daemon'))
    candidates.push(path.join(monorepoRoot, 'rust/target/debug/orbit-audio-daemon'))

    for (const c of candidates) {
      searched.push(c)
      if (fs.existsSync(c)) return c
    }
    throw new DaemonNotFoundError(searched)
  }

  /** handshake 受信待ちの間、最初のメッセージだけ受け取るための state。 */
  private handshakeResolver: ((err: Error | null) => void) | null = null

  private async connectWebSocket(url: string, timeoutMs: number): Promise<void> {
    const ws = new WebSocket(url)
    this.ws = ws
    // message handler を connect 前に取り付ける。
    // (ws が message を emit するのは open 後なので競合はないが、
    // handshake frame が open 直後に届くケースに備えて
    // 最初のメッセージで handshakeResolver を呼ぶ二段構え。)
    const onMessage = (data: WebSocket.RawData) => this.handleFrame(data.toString())
    ws.on('message', onMessage)
    ws.on('close', () => {
      this.running = false
      // close 後に listener を放置すると ws オブジェクトの GC が阻害されるので明示 detach。
      ws.off('message', onMessage)
      // handshake 途中で close した場合、handshakePromise が永続 hang するのを防ぐ。
      if (this.handshakeResolver) {
        this.handshakeResolver(new DaemonConnectionError('websocket closed during handshake'))
      }
      // 閉じた socket への参照を残さない (stale reference 回避)。
      if (this.ws === ws) this.ws = null
      for (const [, pend] of this.pending) {
        pend.reject(new DaemonConnectionError('websocket closed'))
      }
      this.pending.clear()
    })
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`ws connect timeout: ${url}`)), timeoutMs)
      ws.once('open', () => {
        clearTimeout(to)
        resolve()
      })
      ws.once('error', (err) => {
        clearTimeout(to)
        reject(err)
      })
    })
  }

  /**
   * 生フレームの受信ハンドラ。handshake 完了前は handshakeResolver へ、
   * 完了後は handleMessage (request/response / event) へ振り分ける。
   */
  private handleFrame(raw: string): void {
    if (this.handshakeResolver) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        this.handshakeResolver(new Error('handshake: non-JSON first frame'))
        return
      }
      if (!isHandshakeFrame(parsed)) {
        this.handshakeResolver(new Error(`handshake: unexpected first frame: ${raw}`))
        return
      }
      if (parsed.protocol_version !== PROTOCOL_VERSION) {
        this.handshakeResolver(
          new Error(
            `handshake protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${parsed.protocol_version}`,
          ),
        )
        return
      }
      this.handshakeResolver(null)
      return
    }
    this.handleMessage(raw)
  }
}
