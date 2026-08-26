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

import type {
  PluginLoadResult,
  PluginReplaceResult,
  PluginStateSaveResult,
  PluginStateSaveTarget,
} from '../types'

import {
  DaemonConnectionError,
  DaemonNotFoundError,
  DaemonProtocolError,
  DaemonQuitError,
  DaemonStartupError,
} from './errors'
import { validateRenderScore, type RenderScore } from './render-score'
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
   * 起動時に daemon へ渡す `--audio-device <name>` の名前（#484 D1）。cpal の device 名と
   * **完全一致**で honor される。一致しなければ daemon が stderr に警告して host 既定へ縮退する
   * （起動は失敗しない）。ランタイム中の切替（stream 再構築）は D2 scope・未実装。
   */
  audioDevice?: string
  /**
   * テスト用: spawn を skip して既存 ws URL に接続する抜け道。
   * production code からは使用しない。
   * @internal
   */
  wsUrlOverride?: string
}

/** `ListAudioDevices` の 1 要素（#484 D1）。daemon 側 `orbit_audio_native::AudioDeviceInfo` の wire 形。 */
export interface AudioDeviceListEntry {
  name: string
  isDefault: boolean
  maxOutputChannels: number
  defaultSampleRate: number
  direction: 'output' | 'input'
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

export interface DaemonBinaryResolution {
  path: string
  source: 'explicit' | 'env' | 'monorepo-release' | 'monorepo-debug' | 'extension-bundle'
}

/**
 * scsynth-resolver の isExecutableFile と同一規則（executable regular file）。
 * 候補の viability 判定に使う — 存在するだけで exec bit の無いファイル
 * （.vsix 展開でパーミッションが落ちた bundle 等）を pre-check 段階で弾き、
 * 「緑チェック → spawn EACCES で後追い失敗」を防ぐ。
 */
function isExecutableFile(p: string): boolean {
  try {
    const stat = fs.statSync(p)
    if (!stat.isFile()) return false
    return (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** daemon の tracing 出力が付ける ANSI 色コード（level 判定の前に剥がす）。 */
// eslint-disable-next-line no-control-regex -- ESC (\x1b) はまさに剥がしたい対象の制御文字
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g

/**
 * 起動後に転送する daemon stderr 行のうち、エラーとして扱うべきでないものを判定する
 * （tracing の `TRACE`/`DEBUG`/`INFO` 行）。
 *
 * 🔴 #605 の転送は全行を `console.error` に流していたため、daemon の INFO tracing
 * （例: `INFO orbit_audio_daemon: listening on 127.0.0.1:...`）まで拡張側で
 * `ERROR:` として記録され、get_log の ERROR 前後比較を数える側（gated E2E・LLM の
 * 自己検証）が実際に壊れた。level token を読み取れない行（panic・生 print）は
 * fail-loud に error 側へ倒す。
 */
export function isDaemonNonErrorTracingLine(line: string): boolean {
  const plain = line.replace(ANSI_ESCAPE_RE, '')
  // tracing 既定形式の「ISO timestamp + level token」だけを non-error と認める。
  // 判定を緩めて本文中の "INFO" を拾うと本物のエラーが log から消える側に倒れるので、
  // 迷ったら error 側（従来挙動）へ。
  if (/^\s*\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO)\s/.test(plain)) return true
  // child プロセスは daemon の stderr を継承し、tracing を持たない(依存を足していない)。
  // level トークンを自分で名乗った行だけを非エラーとして認める。名乗らない行・
  // ERROR/WARN を名乗る行は従来どおり error 側へ倒す(例: "plugin.process() failed")。
  return /^\s*(TRACE|DEBUG|INFO)\s+\[orbit-[a-z0-9-]+-child\]\s/.test(plain)
}

/**
 * daemon stderr の chunk を**完全な行**へ組み直し、level で振り分けて emit する。
 *
 * 🔴 chunk 境界は行境界と一致しない。素朴に `split('\n')` すると行の後半が独立した
 * 「行」になり、level トークンを持たないので **成功行の続きが ERROR として記録される**
 * （#618 の E2E をカタログ経路へ寄せた際、行数が増えて境界がずれ実際に発生した）。
 * 改行が来るまで持ち越すことでこれを防ぐ。呼び出し側でクロージャに埋めると
 * テストできないので、純関数として切り出してある。
 */
export function createDaemonStderrLineRouter(
  onNonError: (line: string) => void,
  onError: (line: string) => void,
): (chunk: string) => void {
  let partial = ''
  return (chunk: string): void => {
    partial += chunk
    const lines = partial.split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      if (isDaemonNonErrorTracingLine(line)) onNonError(line)
      else onError(line)
    }
  }
}

/**
 * Resolve the `orbit-audio-daemon` binary path via the candidate order used at
 * spawn time: explicit override → `ORBIT_AUDIO_DAEMON_PATH` env → monorepo
 * release build → monorepo debug build → .vsix-bundled binary (Issue #306).
 * Exported (C2) so UI code can pre-check daemon availability the same way
 * `resolveScsynthForUI` pre-checks scsynth, without duplicating the candidate
 * list. `DaemonClient.resolveDaemonBinary` delegates to this — candidate
 * order/content is unchanged, only the per-candidate `source` label is new.
 *
 * 各候補は「executable regular file」であることを要求する（scsynth 側の
 * resolveScsynthPath と同じ検査水準）。非 viable な候補は次候補へ落ちる —
 * これは従来の existsSync が「不在なら次へ」としていた意味論の自然な拡張。
 */
export function resolveDaemonBinaryPath(explicitPath?: string): DaemonBinaryResolution {
  const searched: string[] = []
  const candidates: DaemonBinaryResolution[] = []
  if (explicitPath) candidates.push({ path: explicitPath, source: 'explicit' })
  const envPath = process.env.ORBIT_AUDIO_DAEMON_PATH
  if (envPath) candidates.push({ path: envPath, source: 'env' })
  // monorepo root (this file は packages/engine/src/audio/rust-engine/) から 4 階層
  const monorepoRoot = path.resolve(__dirname, '../../../../../')
  candidates.push({
    path: path.join(monorepoRoot, 'rust/target/release/orbit-audio-daemon'),
    source: 'monorepo-release',
  })
  candidates.push({
    path: path.join(monorepoRoot, 'rust/target/debug/orbit-audio-daemon'),
    source: 'monorepo-debug',
  })
  // .vsix に同梱された daemon（Issue #306）。インストール済み拡張には
  // `rust/target` が存在しない（monorepoRoot 探索は 4 候補とも失敗する）ため、
  // 最後の候補として compiled JS 自身からの相対パスで探す。この compiled
  // daemon-client.js は常に `<extension>/engine/dist/audio/rust-engine/` に
  // 配置される（build:copy-engine / build:engine が packages/engine/dist を
  // まるごと `<extension>/engine/dist/` へコピーするため）ので、3 階層上が
  // `<extension>/engine/` になる。bin/<platform>/ の platform 名は Node の
  // `${process.platform}-${process.arch}` 慣習（例: darwin-arm64）。
  // 現状 darwin-arm64 のみバンドルされる（scripts/copy-daemon-bin.sh 参照）。
  const platform = `${process.platform}-${process.arch}`
  candidates.push({
    path: path.join(__dirname, '../../../bin', platform, 'orbit-audio-daemon'),
    source: 'extension-bundle',
  })

  for (const c of candidates) {
    searched.push(c.path)
    if (isExecutableFile(c.path)) return c
  }
  throw new DaemonNotFoundError(searched)
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
        options.wsUrlOverride ??
        (await this.spawnDaemon(options.daemonPath, startupTimeoutMs, options.audioDevice))

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
    // 自然終了済みの child に SIGTERM を送っても 'exit' は二度と発火しないので、
    // deadline 満了まで待たされた上で「SIGKILL へ昇格した」と偽の診断を出す（#520）。
    // child.killed は「signal を送ったか」しか表さず終了の有無を含まないため、
    // 終了判定は exitCode / signalCode で行う（どちらか非 null なら終了済み）。
    // 同じ「killed は終了を意味しない」誤りは extension.ts の stopEngine でも
    // 一度踏んでいる（#532 で SIGKILL 昇格側だけ修正済み）。
    if (child.exitCode !== null || child.signalCode !== null) return
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
    bus?: string,
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
      // bus は per-sequence insert routing（seq.effect()・PH.2b・#434 S3）。channel と
      // 同時送出はしない想定（呼び出し側が排他を担保。daemon 側も同時指定を拒否する）。
      ...(bus ? { bus } : {}),
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
   * `link-audio` 無効ビルドなら LINK_AUDIO_UNAVAILABLE、runtime 失敗なら LINK_AUDIO_RUNTIME で reject。
   */
  async registerLinkAudioChannel(channel: string): Promise<void> {
    await this.request('RegisterLinkAudioChannel', { channel })
  }

  /**
   * OrbitScore の global.tempo を Link に push してテンポリーダーになる（#283・A4-PR3）。
   * daemon が feature `link-audio` 無効ビルドなら LINK_AUDIO_UNAVAILABLE、runtime 失敗なら LINK_AUDIO_RUNTIME で reject。
   */
  async setLinkTempo(bpm: number): Promise<void> {
    await this.request('SetLinkTempo', { bpm })
  }

  /**
   * Loads a `.clap` plugin into the daemon. Rejects with `DaemonProtocolError` —
   * notably `CLAP_UNAVAILABLE` when the daemon was built without `--features
   * clap-host` — which `RustEnginePlayer.loadPlugin()` converts into an
   * operator-actionable message. The role is forwarded for effect/instrument
   * restoration compatibility even while older daemons ignore it.
   */
  async loadPlugin(
    filePath: string,
    pluginId: string | undefined,
    role: 'effect' | 'instrument',
    bus?: string,
    instance?: string,
    statePath?: string,
  ): Promise<PluginLoadResult> {
    const result = await this.request('LoadPlugin', {
      path: filePath,
      ...(pluginId === undefined ? {} : { plugin_id: pluginId }),
      role,
      // bus は per-sequence insert（'effect' role 専用・#434 S3）。省略時は master slot
      // （既存の global.effect() / seq.instrument() と後方互換）。
      ...(bus ? { bus } : {}),
      // instance は instrument slot pool の宛先（'instrument' role 専用・#540 P1）。
      // 省略時は daemon 側で互換の "default"（slot 0）に解決される。
      ...(instance ? { instance } : {}),
      // state_path は保存済みプラグイン state（effect / instrument 共通・#562）。
      // child spawn 時に適用され、respawn でも再適用される。
      ...(statePath ? { state_path: statePath } : {}),
    })
    return {
      pluginId: String(result.plugin_id),
      pluginName: String(result.plugin_name),
      notePortIndex: Number(result.note_port_index),
    }
  }

  /** Atomically replaces (or ensure-loads) one effect bus or instrument instance. */
  async replacePlugin(
    filePath: string,
    pluginId: string | undefined,
    role: 'effect' | 'instrument',
    bus?: string,
    instance?: string,
    statePath?: string,
  ): Promise<PluginReplaceResult> {
    const result = await this.request('ReplacePlugin', {
      path: filePath,
      ...(pluginId === undefined ? {} : { plugin_id: pluginId }),
      role,
      ...(bus ? { bus } : {}),
      ...(instance ? { instance } : {}),
      ...(statePath ? { state_path: statePath } : {}),
    })
    return {
      pluginId: String(result.plugin_id),
      pluginName: String(result.plugin_name),
      notePortIndex: Number(result.note_port_index),
      quarantinedSlot: Boolean(result.quarantined_slot),
    }
  }

  async savePluginState(
    target: PluginStateSaveTarget,
    absolutePath: string,
  ): Promise<PluginStateSaveResult> {
    const result = await this.request('GetPluginState', {
      path: absolutePath,
      role: target.role,
      ...(target.role === 'effect' && target.bus ? { bus: target.bus } : {}),
      ...(target.role === 'instrument' ? { instance: target.instance } : {}),
    })
    const bytesWritten = result.bytes_written
    if (typeof bytesWritten !== 'number' || !Number.isFinite(bytesWritten)) {
      throw new Error(
        `GetPluginState returned an invalid bytes_written value: ${String(bytesWritten)}.`,
      )
    }
    return {
      path: String(result.path),
      bytesWritten,
    }
  }

  /** P1 accepts and validates the complete manifest; the daemon returns NOT_IMPLEMENTED until P2. */
  async renderScore(score: RenderScore): Promise<Record<string, unknown>> {
    validateRenderScore(score)
    return this.request('RenderScore', { ...score })
  }

  /** OPEN_UI の daemon 応答は view attach 完了後にだけ返る。 */
  async openPluginUi(
    target: PluginStateSaveTarget,
    index: number,
    windowTitle: string,
  ): Promise<void> {
    await this.request('OpenPluginUI', {
      target,
      index,
      windowTitle,
    })
  }

  /** この Promise は Phase A の受理 ack。close 完了は player が DONE event で判定する。 */
  async acceptClosePluginUi(target: PluginStateSaveTarget, index: number): Promise<void> {
    await this.request('ClosePluginUI', { target, index })
  }

  async ackUiSafepoint(
    target: PluginStateSaveTarget,
    index: number,
    generation: number,
    evtSeq: number,
  ): Promise<void> {
    await this.request('AckUiSafepoint', {
      target,
      index,
      generation,
      evt_seq: evtSeq,
    })
  }

  /**
   * Runtime mixer bus routing change (MX.4, #459/#453 M3): (re)sets `seqBus`'s output
   * target (sum) and/or send gains (aux). `output: undefined` means "leave untouched" —
   * translated to omitting the field so the daemon's `parse_set_bus_routing_params`
   * treats it as `None` and does not touch the existing override.
   */
  async setBusRouting(
    seqBus: string,
    output: string | undefined,
    sends: { bus: string; gain: number }[],
  ): Promise<void> {
    await this.request('SetBusRouting', {
      seq_bus: seqBus,
      ...(output === undefined ? {} : { output }),
      sends,
    })
  }

  pluginNoteOn(key: number, channel: number, velocity: number, instance?: string): Promise<void> {
    return this.request('PluginNoteOn', {
      key,
      channel,
      velocity,
      ...(instance ? { instance } : {}),
    }) as unknown as Promise<void>
  }

  pluginNoteOff(key: number, channel: number, velocity?: number, instance?: string): Promise<void> {
    return this.request('PluginNoteOff', {
      key,
      channel,
      ...(velocity === undefined ? {} : { velocity }),
      ...(instance ? { instance } : {}),
    }) as unknown as Promise<void>
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return this.request('GetStatus', {})
  }

  /**
   * cpal output device 一覧を daemon から取得する（#484 D1）。ランタイム切替は
   * {@link DaemonClient.selectAudioDevice}（#484 D2）で行う。
   */
  async listAudioDevices(): Promise<AudioDeviceListEntry[]> {
    const result = await this.request('ListAudioDevices', {})
    const devices = result.devices
    return Array.isArray(devices) ? (devices as AudioDeviceListEntry[]) : []
  }

  /**
   * daemon プロセスを再起動せずに出力デバイスを切り替える（#484 D2）。`device` は
   * `listAudioDevices()` が返す `name`、または空文字列（システム既定へ縮退）。切替中の短い
   * 無音ギャップは許容される仕様（daemon 側で render state ごと新 stream へ引き継ぐ）。
   *
   * `ORBIT_CAPTURE_WAV` で daemon が録音中の場合は daemon 側が明示的に拒否する
   * （`AUDIO_DEVICE_SWITCH_UNAVAILABLE`）— 継続不可のため、この場合は daemon 再起動が必要。
   *
   * @returns 実際に適用されたデバイス名（`"system default"` を含みうる）。
   */
  async selectAudioDevice(device: string): Promise<string> {
    const result = await this.request('SelectAudioDevice', { device })
    return typeof result.device === 'string' ? result.device : device
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
      case 'PluginUiClosed':
        return 'plugin-ui-closed'
      case 'PluginUiCloseDone':
        return 'plugin-ui-close-done'
      case 'PluginUiClosedByRespawn':
        return 'plugin-ui-closed-by-respawn'
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

  private async spawnDaemon(
    explicitPath: string | undefined,
    timeoutMs: number,
    audioDevice: string | undefined,
  ): Promise<string> {
    const binary = this.resolveDaemonBinary(explicitPath)
    // `--audio-device <name>` は daemon 起動時のみ honor される（#484 D1・ランタイム切替は D2）。
    // 名前が不一致でも daemon は起動を落とさず stderr に警告して host 既定へ縮退する。
    const args = audioDevice ? ['--audio-device', audioDevice] : []
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    const stderrChunks: string[] = []
    // startup 診断用の stderr 収集。ready-line が settle したら**蓄積だけ**止める
    // （daemon の長期稼働中に無限に溜めないため）。
    //
    // 🔴 #605: 以前はここで購読自体を切っていた。その結果、起動後に daemon が出す
    // 診断（plugin load 失敗・child の異常終了・respawn）が**どこにも届かず**、
    // engine が組み立てた1行（例: `[OUTPROC_ATTACH_FAILED] ...`）しか残らなかった。
    // exit code も child 名も plugin パスも失われ、原因追跡が構造的に不可能だった
    // （Kontakt の load 失敗の切り分けに2時間以上を要した実例がある）。
    // 蓄積を止めることと転送を止めることは別である。**転送は継続する。**
    let collecting = true
    const routeStderrLine = createDaemonStderrLineRouter(
      (line) => console.log(`[daemon] ${line}`),
      (line) => console.error(`[daemon] ${line}`),
    )
    const onStderrData = (chunk: Buffer): void => {
      const text = chunk.toString()
      if (collecting) {
        stderrChunks.push(text)
        return
      }
      // 起動後は蓄積せず、行単位で engine のログへ転送する。INFO/DEBUG/TRACE の
      // tracing 行まで stderr に流すと拡張側で `ERROR:` として記録されるため
      // （isDaemonNonErrorTracingLine の docstring 参照）、level で振り分ける。
      //
      // 🔴 部分行をバッファする: chunk 境界は行境界と一致しない。素朴に split すると
      // 行の後半が独立した「行」になり、level トークンを持たないので **成功行の続きが
      // ERROR として記録される**（#618 の E2E をカタログ経路へ寄せた際、行数が増えて
      // 境界がずれたことで実際に発生した）。改行が来るまで持ち越す。
      routeStderrLine(text)
    }
    child.stderr?.on('data', onStderrData)
    const detachStderr = (): void => {
      collecting = false
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

      // spawn 失敗のうち EACCES / EAGAIN / EMFILE / ENFILE / ENOENT の 5 種のみが
      // (Node v22 internal/child_process.js 実装確認済み・C4) nextTick 経由で
      // 'error' event として通知される。.vsix 配布の bundled daemon binary で
      // 顕在化しうる (実行権限欠落・Gatekeeper quarantine 等)。それ以外
      // (ENOEXEC = アーキ不一致等) は spawn() が同期 throw し、async
      // spawnDaemon の暗黙ラップ経由で doStart() 外側の try/catch が拾う
      // (DaemonStartupError に変換されない生の ErrnoException のまま伝播する)。
      // unhandled 'error' は EventEmitter が throw し engine プロセスごと
      // 巻き込むため、上記 5 種向けに必ず listener を張る。spawn 'error' は
      // 常に非同期 (次 tick 以降) に発火するため、spawn() と同一同期区間で
      // 走るこの executor 内での登録で取りこぼしはない。settle 後の 'error'
      // (quit() の child.kill() 失敗等) も silent に握り潰さないよう永続
      // リスナーで log する (ws 'error' 規約に揃える)。
      child.on('error', (err) => {
        if (settled) {
          console.warn('DaemonClient: child process error after startup settled:', err)
          return
        }
        finish(() =>
          reject(
            new DaemonStartupError(
              `daemon spawn failed: ${err.message}`,
              stderrChunks.join(''),
              null,
            ),
          ),
        )
      })
    })

    return `ws://127.0.0.1:${port}`
  }

  private resolveDaemonBinary(explicitPath: string | undefined): string {
    return resolveDaemonBinaryPath(explicitPath).path
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
