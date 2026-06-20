/**
 * Rust audio backend adapter (post-2.0 S2 / Issue #296).
 *
 * `DaemonClient`（orbit-audio-daemon / WebSocket）を `AudioEngineBackend` 契約へ
 * ラップし、`SuperColliderPlayer` の sibling として interpreter に差し込めるようにする。
 * SC 経路は無改変のまま、`ORBITSCORE_ENGINE=rust` で opt-in する parity proof。
 *
 * 設計（docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md §13 / master plan §4-A）:
 *
 *  - **musical timing は TS 側に残す**（Epic #105 原則）。本クラスは EventScheduler の
 *    1ms poll モデルを mirror した *lean* scheduler を持ち、発火時に daemon へ
 *    `loadSample`+`playAt` する。SC の EventScheduler は LinkAudio/bufnum/`/s_new` 結合が
 *    重いので再利用せず、独立実装にして SC 経路への波及を断つ。
 *
 *  - **timing モデル = poll-and-fire-now + 定数 lookahead**。SC は fire-now（poll 検出で
 *    即 `/s_new`）。daemon は自前 transport clock（boot で 0 開始）上の `PlayAt{time_sec}`
 *    で schedule-ahead。poll 発火時に `playAt(daemonNowSec + lookahead)` を送ることで
 *    **相対 timing（quantize/polymeter）を保存**しつつ daemon render cursor を確実に
 *    上回らせ onset clip を避ける（絶対 latency は定数シフト＝音楽的に無影響）。lookahead は
 *    実機計測で確定する（A0 受け入れ基準）。
 *
 *  - **TS↔daemon クロックマッピング**: daemon の transport now_sec は `StreamStats`(1Hz) で
 *    露出（`engine.now_sec()`）。これで anchor を毎秒補正し audio/wall drift を吸収する。
 *    boot 直後は `GetStatus.uptime_sec`(≈transport) で暫定 anchor を置き、初回 StreamStats で
 *    精緻化する。
 *
 *  - **feature gap は boundary で明示**（見かけの parity を作らない・A0 方針）:
 *    pan≠0 → 1回 warn して中央定位で発音（pan drop）/ slice → 1回 warn して skip /
 *    outputChannel(LinkAudio) → 1回 warn して hardware 発音（SC の plugin-missing fallback と同形）。
 *    いずれも §6 確定の後続フェーズ（pan=小タスク・rate/slice=A3・LinkAudio=A4）。
 *    内部 `ScheduledPlay` は pan を保持（param-complete）し、後の pan 追加を配線だけにする。
 */

import type { AudioEngineBackend } from '../engine-backend'
import type { AudioDevice } from '../supercollider/types'

import { DaemonClient } from './daemon-client'

/** boundary で拒否する feature gap の種別。 */
type GapKind = 'pan' | 'slice' | 'outputChannel'

/** lean scheduler が保持する 1 発音イベント。SC `ScheduledPlay` の daemon 版。 */
interface ScheduledPlay {
  /** 再生開始時刻（`startTime` からの相対 ms）。 */
  time: number
  filepath: string
  /** dB ゲイン（`scheduleEvent` の gainDb）。発火時に linear amplitude へ変換。 */
  gainDb: number
  /** DSL pan（-100..100）。S2 では未適用だが param-complete のため保持。 */
  pan: number
  sequenceName: string
}

/** daemon transport clock と TS wall clock の対応点。 */
interface ClockAnchor {
  /** この anchor を取得した時点の `Date.now()`（ms）。 */
  tsMs: number
  /** 同時点の daemon transport now_sec（秒）。 */
  daemonSec: number
}

/** 1 発音 dispatch の観測情報（telemetry / timing 計測フック）。 */
export interface DispatchInfo {
  filepath: string
  sampleId: string
  /** scheduler の相対時刻（`startTime` からの ms）。 */
  scheduledTimeMs: number
  /** playAt 送信時点の `Date.now()`。 */
  wallMs: number
  /** その時点の daemon transport now_sec 推定値（anchor ベース）。 */
  daemonNowSec: number
  /** daemon へ渡した発音時刻（= daemonNowSec + lookahead）。 */
  timeSec: number
  /** linear amplitude。 */
  gain: number
  /** daemon が返した play_id。 */
  playId: string
}

export interface RustEnginePlayerOptions {
  /** daemon バイナリの明示パス（未指定時は env → 既定パス探索）。 */
  daemonPath?: string
  /**
   * poll 発火から daemon 発音までの先読み秒数。daemon render cursor を上回らせ
   * onset clip を避ける定数。相対 timing は保存される。既定 50ms。
   */
  lookaheadSec?: number
  /**
   * テスト用: spawn を skip して既存 ws URL に接続する抜け道（DaemonClient へ委譲）。
   * @internal
   */
  wsUrlOverride?: string
  /** 各 dispatch の観測コールバック（telemetry / timing 計測）。 */
  onDispatch?: (info: DispatchInfo) => void
}

const DEFAULT_LOOKAHEAD_SEC = 0.05
const POLL_INTERVAL_MS = 1
/** SC EventScheduler と同じく、過大 drift のイベントは古い残骸として skip する閾値。 */
const MAX_DRIFT_MS = 1000

/** dB → linear amplitude（SC `convertGainToAmplitude` と同一規則）。 */
function convertGainToAmplitude(gainDb: number | undefined): number {
  if (gainDb === undefined) return 1.0
  if (gainDb === -Infinity) return 0.0
  return Math.pow(10, gainDb / 20)
}

export class RustEnginePlayer implements AudioEngineBackend {
  private readonly daemon: DaemonClient
  private readonly daemonPath?: string
  private readonly wsUrlOverride?: string
  private readonly lookaheadSec: number
  private readonly onDispatch?: (info: DispatchInfo) => void

  // --- lean scheduler state（SC EventScheduler の mirror） ---
  private scheduledPlays: ScheduledPlay[] = []
  private readonly sequenceEvents = new Map<string, ScheduledPlay[]>()
  private intervalId: ReturnType<typeof setInterval> | null = null
  isRunning = false
  startTime = 0

  // --- sample / clock 状態 ---
  /** filepath → daemon sample_id（ロード済みキャッシュ）。 */
  private readonly sampleIds = new Map<string, string>()
  /** filepath → 秒（getAudioDuration 用、loadSample の frames/sampleRate から算出）。 */
  private readonly durations = new Map<string, number>()
  /** 同一 filepath の並行ロードを直列化する single-flight。 */
  private readonly inflightLoads = new Map<string, Promise<string>>()
  private clockAnchor: ClockAnchor = { tsMs: 0, daemonSec: 0 }

  /** feature gap の 1 回限り warning。stopAll で再 arm する。 */
  private warned: Record<GapKind, boolean> = { pan: false, slice: false, outputChannel: false }

  constructor(options: RustEnginePlayerOptions = {}) {
    this.daemon = new DaemonClient()
    this.daemonPath = options.daemonPath
    this.wsUrlOverride = options.wsUrlOverride
    this.lookaheadSec = options.lookaheadSec ?? DEFAULT_LOOKAHEAD_SEC
    this.onDispatch = options.onDispatch
  }

  // --- AudioEngine surface ---

  /**
   * daemon を起動し WebSocket 接続を確立する。`outputDevice` は S2 では未対応
   * （daemon は既定デバイスを選択）。確立後、transport clock の anchor を置き、
   * StreamStats で継続補正する subscription を張る。
   */
  async boot(outputDevice?: string): Promise<void> {
    if (outputDevice) {
      console.warn(
        `⚠️  [rust-engine] outputDevice="${outputDevice}" is not yet honored — the daemon uses the system default output (S2 scope).`,
      )
    }

    // StreamStats(1Hz) の transport now_sec で anchor を継続補正（audio/wall drift 吸収）。
    this.daemon.on('stream-stats', (data: unknown) => {
      const nowSec = Number((data as { now_sec?: unknown }).now_sec)
      if (Number.isFinite(nowSec)) {
        this.clockAnchor = { tsMs: Date.now(), daemonSec: nowSec }
      }
    })

    await this.daemon.start({ daemonPath: this.daemonPath, wsUrlOverride: this.wsUrlOverride })

    // 暫定 anchor: uptime_sec ≈ transport now_sec（共に stream 開始から実時間で進む）。
    // 初回 StreamStats（≤約1s）で精緻化される。
    try {
      const status = await this.daemon.getStatus()
      const uptime = Number(status.uptime_sec)
      this.clockAnchor = { tsMs: Date.now(), daemonSec: Number.isFinite(uptime) ? uptime : 0 }
    } catch {
      this.clockAnchor = { tsMs: Date.now(), daemonSec: 0 }
    }
  }

  async quit(): Promise<void> {
    this.stopAll()
    await this.daemon.quit()
  }

  getCurrentOutputDevice(): AudioDevice | undefined {
    return undefined
  }

  getAvailableDevices(): AudioDevice[] {
    return []
  }

  setAvailableDevices(_devices: AudioDevice[]): void {
    // S2 では daemon 側のデバイス列挙 API が無いため no-op。
  }

  /**
   * LinkAudio チャンネル登録（#209）は A4（Rust LinkAudio 隔離モジュール）の担当。
   * S2 では未対応を 1 回 warn する（throw せず boot/再生は継続）。
   */
  async registerLinkAudioChannel(channelName: string): Promise<void> {
    this.warnOnce(
      'outputChannel',
      `⚠️  [rust-engine] LinkAudio channel "${channelName}" is not supported on the rust engine yet (A4). Sequences with outputChannel play on the hardware bus.`,
    )
  }

  async setLinkTempo(_bpm: number): Promise<void> {
    // Link テンポリード（#283）は LinkAudio 同様 A4 era。S2 では no-op。
  }

  // --- Scheduler surface ---

  scheduleEvent(
    filepath: string,
    time: number,
    gainDb = 0,
    pan = 0,
    sequenceName = '',
    outputChannel?: string,
  ): void {
    if (outputChannel) {
      this.warnOnce(
        'outputChannel',
        `⚠️  [rust-engine] outputChannel="${outputChannel}" (LinkAudio) is not supported yet (A4) — playing on the hardware bus.`,
      )
    }
    if (pan !== 0) {
      this.warnOnce(
        'pan',
        `⚠️  [rust-engine] pan is not supported yet — events play centered. (Deferred follow-up; daemon PlayAt has no pan.)`,
      )
    }
    this.enqueue({ time, filepath, gainDb, pan, sequenceName })
  }

  /**
   * slice/chop（rate/startPos/duration）は A3（time-stretch）/ #239 の担当。daemon の
   * PlayAt は全体再生のみなので、誤った全体再生で見かけの parity を作らないよう
   * 1 回 warn して skip する。
   */
  scheduleSliceEvent(
    _filepath: string,
    _time: number,
    _sliceIndex: number,
    _totalSlices: number,
    _eventDurationMs: number | undefined,
    _gainDb = 0,
    _pan = 0,
    _sequenceName = '',
    _outputChannel?: string,
  ): void {
    this.warnOnce(
      'slice',
      `⚠️  [rust-engine] slice/chop playback is not supported yet (A3 time-stretch / #239) — these events are skipped on the rust engine.`,
    )
  }

  start(): void {
    if (this.isRunning) return
    this.isRunning = true
    this.startTime = Date.now()
    this.scheduledPlays.sort((a, b) => a.time - b.time)

    this.intervalId = setInterval(() => {
      const now = Date.now() - this.startTime
      while (this.scheduledPlays.length > 0 && this.scheduledPlays[0].time <= now) {
        const play = this.scheduledPlays.shift()!
        // clear 済みシーケンスのイベントは skip（poll-level チェック）。
        if (play.sequenceName && !this.sequenceEvents.has(play.sequenceName)) {
          continue
        }
        this.executePlayback(play).catch((err) => {
          console.error(`❌ [rust-engine] playback error for ${play.sequenceName}:`, err)
        })
      }
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.isRunning = false
  }

  stopAll(): void {
    this.stop()
    this.scheduledPlays = []
    this.sequenceEvents.clear()
    this.warned = { pan: false, slice: false, outputChannel: false }
    // 注: 既に daemon へ送信済み（発音中）の voice は自然減衰で終わる。即時 hard-stop は
    // play_id 追跡 or daemon 側 StopAll コマンドが要る後続課題（短サンプル前提で proof は許容）。
  }

  clearSequenceEvents(sequenceName: string): void {
    this.scheduledPlays = this.scheduledPlays.filter((p) => p.sequenceName !== sequenceName)
    // Map から消すことで、まだ queue に残るイベントも poll/exec 時に skip される。
    this.sequenceEvents.delete(sequenceName)
  }

  reinitializeSequenceTracking(sequenceName: string): void {
    this.sequenceEvents.set(sequenceName, [])
  }

  /** pre-load（optional Scheduler 面）。daemon へ事前ロードして first-hit latency を抑える。 */
  async loadBuffer(filepath: string): Promise<{ sampleId: string }> {
    const sampleId = await this.ensureLoaded(filepath)
    return { sampleId }
  }

  /** getAudioDuration は SC では slice 経路のみが使う。daemon 版はキャッシュ値（未ロードは 0）。 */
  getAudioDuration(filepath: string): number {
    return this.durations.get(filepath) ?? 0
  }

  // --- internals ---

  private enqueue(play: ScheduledPlay): void {
    this.scheduledPlays.push(play)
    this.scheduledPlays.sort((a, b) => a.time - b.time)
    if (play.sequenceName) {
      if (!this.sequenceEvents.has(play.sequenceName)) {
        this.sequenceEvents.set(play.sequenceName, [])
      }
      this.sequenceEvents.get(play.sequenceName)!.push(play)
    }
  }

  private async executePlayback(play: ScheduledPlay): Promise<void> {
    if (play.sequenceName) {
      // async 待ち中に clear された場合の二重チェック（SC executePlayback と同形）。
      if (!this.sequenceEvents.has(play.sequenceName)) return
      const drift = Date.now() - this.startTime - play.time
      if (drift > MAX_DRIFT_MS) return
    }

    const amplitude = convertGainToAmplitude(play.gainDb)
    if (amplitude <= 0) return // 無音はスキップ（音響的に同一）。

    const sampleId = await this.ensureLoaded(play.filepath)
    const daemonNowSec = this.daemonNowSec()
    const timeSec = daemonNowSec + this.lookaheadSec
    const { playId } = await this.daemon.playAt(sampleId, timeSec, amplitude)
    this.onDispatch?.({
      filepath: play.filepath,
      sampleId,
      scheduledTimeMs: play.time,
      wallMs: Date.now(),
      daemonNowSec,
      timeSec,
      gain: amplitude,
      playId,
    })
  }

  /** filepath を daemon にロードし sample_id を返す（キャッシュ + single-flight）。 */
  private ensureLoaded(filepath: string): Promise<string> {
    const cached = this.sampleIds.get(filepath)
    if (cached) return Promise.resolve(cached)

    const inflight = this.inflightLoads.get(filepath)
    if (inflight) return inflight

    const load = this.daemon
      .loadSample(filepath)
      .then((res) => {
        this.sampleIds.set(filepath, res.sampleId)
        if (res.sampleRate > 0) {
          this.durations.set(filepath, res.frames / res.sampleRate)
        }
        return res.sampleId
      })
      .finally(() => {
        this.inflightLoads.delete(filepath)
      })

    this.inflightLoads.set(filepath, load)
    return load
  }

  /** TS wall clock から daemon transport now_sec を推定する（anchor + 経過時間）。 */
  private daemonNowSec(): number {
    return this.clockAnchor.daemonSec + (Date.now() - this.clockAnchor.tsMs) / 1000
  }

  private warnOnce(kind: GapKind, message: string): void {
    if (this.warned[kind]) return
    this.warned[kind] = true
    console.warn(message)
  }
}
