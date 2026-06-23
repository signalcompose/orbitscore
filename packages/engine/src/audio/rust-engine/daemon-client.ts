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
const DEFAULT_KILL_TIMEOUT_MS = 500

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
  /**
   * quit() による意図的 close を crash と区別するフラグ。close ハンドラはこれが true の
   * 間 `daemon-died` を emit しない（supervisor が意図的 quit を死と誤認し respawn するのを防ぐ）。
   */
  private intentionalClose = false
  /** 並列 start() を直列化し、daemon を二重に spawn しないためのシングルフライト。 */
  private startPromise: Promise<void> | null = null

  isRunning(): boolean {
    return this.running
  }

  /**
   * 子プロセス（daemon）の PID。recovery floor の kill-test が hard-death（SIGKILL）を
   * 注入するための read-only seam。production code は使用しない。
   * @internal
   */
  get childPid(): number | undefined {
    return this.child?.pid
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
    // 新しい起動サイクルでは crash 検出を再 arm する（前回 quit の意図的 close を引きずらない）。
    this.intentionalClose = false
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
          reject(new DaemonConnectionError(`handshake timeout after ${handshakeTimeoutMs}ms`))
        }, handshakeTimeoutMs)
        this.handshakeResolver = (err) => {
          clearTimeout(to)
          this.handshakeResolver = null
          if (err) reject(err)
          else resolve()
        }
      })
      // connectWebSocket の await 中に ws が close すると、close ハンドラが handshakePromise を
      // reject しうる。その時点では誰も await しておらず unhandled rejection になる（recovery の
      // 再接続が dead endpoint を踏むと顕在化）。制御は下の await が担うので、ここで no-op catch を
      // 付けて「観測済み」にし、unhandled 警告だけを抑止する（reject は await が再観測して throw）。
      handshakePromise.catch(() => {})

      await this.connectWebSocket(wsUrl, connectTimeoutMs)
      await handshakePromise
      this.running = true
    } catch (err) {
      // cleanup 自体が throw しても original startup error を優先するため握り潰す。
      try {
        await this.cleanupAfterStartFailure()
      } catch (cleanupErr) {
        console.warn('DaemonClient cleanup after startup failure failed:', cleanupErr)
      }
      throw err
    }
  }

  /** doStart の中断時に this.child / this.ws を確実に回収する。 */
  private async cleanupAfterStartFailure(): Promise<void> {
    this.handshakeResolver = null
    if (this.ws) {
      try {
        this.ws.close()
      } catch (e) {
        // startup phase では listener 未登録の可能性が高いので console に出す。
        console.warn('DaemonClient ws.close() threw during startup cleanup:', e)
      }
      this.ws = null
    }
    if (this.child) {
      await this.killChildGracefully(this.child)
      this.child = null
    }
    for (const [, pend] of this.pending) {
      pend.reject(new Error('daemon startup failed'))
    }
    this.pending.clear()
  }

  /**
   * child に SIGTERM を送り、DEFAULT_KILL_TIMEOUT_MS 以内に exit しなければ
   * SIGKILL にエスカレーションする。exit listener は必ず detach する。
   */
  private async killChildGracefully(child: ChildProcess): Promise<void> {
    if (child.killed) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(to)
        resolve()
      }
      const to = setTimeout(() => {
        child.off('exit', onExit)
        try {
          child.kill('SIGKILL')
        } catch (e) {
          // kill 自体が throw (process table 未解放等) したら診断を残す。
          console.warn('DaemonClient SIGKILL failed:', e)
        }
        console.warn(
          `DaemonClient child did not exit within ${DEFAULT_KILL_TIMEOUT_MS}ms of SIGTERM; escalated to SIGKILL`,
        )
        resolve()
      }, DEFAULT_KILL_TIMEOUT_MS)
      child.once('exit', onExit)
    })
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

  async playAt(
    sampleId: string,
    timeSec: number,
    gain: number,
    pan = 0,
    offsetSec = 0,
    durationSec = 0,
    rate = 1,
    channel?: string,
  ): Promise<{ playId: string }> {
    const result = await this.request('PlayAt', {
      sample_id: sampleId,
      time_sec: timeSec,
      gain,
      // pan は [-1.0, 1.0]（daemon 仕様）。範囲外は daemon 側で clamp。
      pan,
      // offset_sec / duration_sec は再生領域（chop の slice）。0/0 で全体再生。
      offset_sec: offsetSec,
      duration_sec: durationSec,
      // rate は varispeed（1.0 = 自然尺）。<=0/非有限は daemon 側で 1.0 に丸め。
      rate,
      // channel は LinkAudio ルーティング先（非空の時のみ送る。空/未指定は hardware）。
      ...(channel ? { channel } : {}),
    })
    return { playId: String(result.play_id) }
  }

  async stop(playId: string): Promise<boolean> {
    const result = await this.request('Stop', { play_id: playId })
    return result.status === 'stopped'
  }

  /** daemon の全アクティブ再生を即時停止する（hard-stop-all）。停止件数を返す。 */
  async stopAll(): Promise<number> {
    const result = await this.request('StopAll', {})
    return Number(result.stopped ?? 0)
  }

  async setGlobalGain(value: number, rampSec = 0): Promise<void> {
    await this.request('SetGlobalGain', { value, ramp_sec: rampSec })
  }

  /**
   * LinkAudio outputChannel を daemon に登録する（#209・A4-2b-2）。登録後、その channel に
   * tag された `playAt` の出力が LinkAudio egress 経由で送出される。daemon が feature
   * `link-audio` 無効ビルドなら LINK_AUDIO_ERROR で reject される。
   */
  async registerLinkAudioChannel(channel: string): Promise<void> {
    await this.request('RegisterLinkAudioChannel', { channel })
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return this.request('GetStatus', {})
  }

  /**
   * gated な fault 注入（recovery floor の kill-test 専用 / @internal）。daemon を
   * ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1 で起動した場合のみ受理される。daemon を
   * panic→exit(1)（panic hook 経路）で殺す。daemon は応答前に死ぬので request は close で
   * reject される想定 → connection 系のエラーは握り潰す（それ以外は呼び出し側へ throw）。
   */
  async injectFault(): Promise<void> {
    try {
      await this.request('InjectFault', {})
    } catch (err) {
      // daemon が応答前に死ぬ = 期待動作。接続喪失系は飲み込み、想定外のエラーだけ surface する。
      if (err instanceof DaemonConnectionError || err instanceof DaemonQuitError) return
      throw err
    }
  }

  async quit(): Promise<void> {
    if (!this.running) return
    // crash と区別するため、ws を閉じる前に意図的 close を宣言する（daemon-died 抑制）。
    this.intentionalClose = true
    this.running = false
    try {
      this.ws?.close()
    } catch (e) {
      // ws.close() は原則 throw しないが、ws ライブラリ内部の assertion 等で例外が出ても quit は
      // 継続する。完全に silent にすると cleanup 失敗が隠れるため console.warn で可視化する
      // （onError と同じ方針。以前は 'ws-close-error' を emit していたが consumer が無く実質
      // silent だった）。
      console.warn('DaemonClient quit: ws.close() threw unexpectedly:', e)
    }
    this.ws = null
    if (this.child) {
      await this.killChildGracefully(this.child)
      this.child = null
    }
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
      // ws が CLOSING の narrow window（close 発行済・close event 未着火で running はまだ true）でも
      // DaemonConnectionError を投げ、onPlaybackError / injectFault の silent-drop フィルタに揃える
      // （plain Error だと死へ向かう正常遷移で misleading な error ログが 1 回出る。bot Finding 1）。
      throw new DaemonConnectionError(`daemon client not connected (method=${method})`)
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
    // daemon を kill -9 / segfault すると、socket は 'close' の前に 'error'（ECONNRESET 等）を
    // emit しうる。listener が無いと Node の EventEmitter が unhandled 'error' を throw して TS
    // プロセスごと巻き込む。recovery floor の要は「daemon の死で app を落とさない」ことなので、
    // 永続 error listener で吸収する（実際の cleanup / respawn 駆動は 'close' ハンドラが行う）。
    //
    // ただし **connect 中は下の `onConnectError`（once）が error を担う**ので、`onError` は
    // open 後にだけ attach する。connect 前から両方を付けると、connect 失敗時に onError の warn と
    // connect reject が **二重ログ**になる（bot Finding 2）。open で onConnectError を detach し
    // onError に引き継ぐことで、connect 失敗は単一経路（reject）に、post-connect の死は onError に
    // 集約される。
    const onError = (err: Error): void => {
      // 詳細（ECONNRESET 等）を console.warn で必ず可視化する — 'close' ハンドラの daemon-died
      // 通知だけでは socket レベルの死因が消えるため。実際の cleanup / respawn 駆動は 'close' が行う。
      console.warn(
        'DaemonClient websocket error (close handling / respawn follows if it died):',
        err,
      )
    }
    ws.on('close', () => {
      // running を倒す前に「起動成功後だったか」を捕まえる（死の判定に使う）。
      const wasRunning = this.running
      this.running = false
      // close 後に listener を放置すると ws オブジェクトの GC が阻害されるので明示 detach。
      ws.off('message', onMessage)
      ws.off('error', onError)
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
      // 起動成功後（wasRunning）の予期せぬ close = daemon の死（panic→exit / segfault / kill）。
      // 意図的 quit（intentionalClose）でなければ supervisor へ通知し respawn を駆動させる。
      // clean exit（panic hook→exit1）も hard segfault/SIGKILL も、ここに収束する。
      if (wasRunning && !this.intentionalClose) {
        this.emit('daemon-died')
      }
    })
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`ws connect timeout: ${url}`)), timeoutMs)
      // connect 中の error 担当（once）。open 成功時に detach し、以後は永続 onError に引き継ぐ。
      const onConnectError = (err: Error): void => {
        clearTimeout(to)
        reject(err)
      }
      ws.once('open', () => {
        clearTimeout(to)
        // connect 成功 → connect 用 error listener を外し、永続 onError に引き継ぐ
        // （二重ログ防止・unhandled 'error' 防止の両立）。
        ws.off('error', onConnectError)
        ws.on('error', onError)
        resolve()
      })
      ws.once('error', onConnectError)
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
