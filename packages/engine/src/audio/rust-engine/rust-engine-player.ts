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
 *    露出（Rust: `engine.transport_or_uptime_sec()` — transport 未開始時は uptime_sec に
 *    フォールバック）。これで anchor を毎秒補正し audio/wall drift を吸収する。boot 直後は
 *    `GetStatus.uptime_sec`(≈transport) で暫定 anchor を置き、初回 StreamStats で精緻化する。
 *
 *  - **pan は #304 で実装済み**（daemon PlayAt の pan・equal-power = SC `Pan2` 一致）。
 *    発火時に DSL の -100..100 を daemon の [-1,1] へ変換して送る。
 *
 *  - **slice（chop 領域再生）は #304 で実装済み**（offset/duration の領域読み・rate=1.0）。
 *    rate≠1.0（slice 尺をスロット尺へ詰める time-stretch）のみ 1回 warn し、slice 自体は
 *    自然尺（rate=1.0）で発音する（skip しない）。time-stretch は #213/#239 へ defer。
 *
 *  - **残る feature gap は boundary で明示**（見かけの parity を作らない・A0 方針）:
 *    outputChannel(LinkAudio) → 1回 warn して hardware 発音（SC の plugin-missing fallback と同形）/
 *    master effects（compressor/limiter/normalizer）→ 1回 warn して no-op。いずれも A4 era。
 */

import { gainDbToAmplitude } from '../audio-gain-utils'
import type { AudioEngineBackend } from '../engine-backend'
import type { AudioDevice } from '../supercollider/types'

import { DaemonClient } from './daemon-client'
import { DaemonConnectionError } from './errors'

/**
 * boundary で明示する制約の種別。
 * - `slice`: chop 領域再生は実装済み。rate≠1.0（time-stretch）未対応の warn 用で、slice 自体は
 *   rate=1.0 で発音する（拒否しない）。
 * - `outputChannel`(LinkAudio) / `masterEffect`: 未対応 feature gap（A4 era）。
 * pan は #304 で実装済みのため gap ではない。
 */
type GapKind = 'slice' | 'outputChannel' | 'masterEffect'

/** chop slice 情報。`scheduleSliceEvent` 由来。発火時に領域（offset/duration）へ解決する。 */
interface SliceSpec {
  /** slice 番号（1 始まり）。 */
  index: number
  /** 分割数（`chop(n)` の n）。 */
  total: number
  /** イベントスロット尺（ms）。rate≠1.0 判定に使う（time-stretch 未対応の warn 用）。 */
  eventDurationMs?: number
}

/** lean scheduler が保持する 1 発音イベント。SC `ScheduledPlay` の daemon 版。 */
interface ScheduledPlay {
  /** 再生開始時刻（`startTime` からの相対 ms）。 */
  time: number
  filepath: string
  /** dB ゲイン（`scheduleEvent` の gainDb）。発火時に linear amplitude へ変換。 */
  gainDb: number
  /** DSL pan（-100..100）。発火時に daemon の [-1,1] へ変換。 */
  pan: number
  sequenceName: string
  /** chop slice 情報。未指定なら全体再生。発火時に load 済み尺から領域を計算する。 */
  slice?: SliceSpec
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
  /** playAt 送信「前」の `Date.now()`（daemonNowSec と同一瞬間に採取）。 */
  wallMs: number
  /** 同一瞬間の daemon transport now_sec 推定値（anchor ベース）。 */
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
  /**
   * 各 dispatch の観測コールバック（任意・副作用なしの telemetry seam）。A0 の実機
   * timing 計測 spec が lead/drift を読むのに使う。`createAudioEngine()` の production
   * 経路では渡さない（hook 無しが既定）。production で常用するなら factory へ昇格する。
   */
  onDispatch?: (info: DispatchInfo) => void
}

const DEFAULT_LOOKAHEAD_SEC = 0.05
const POLL_INTERVAL_MS = 1
/** SC EventScheduler と同じく、過大 drift のイベントは古い残骸として skip する閾値。 */
const MAX_DRIFT_MS = 1000
/** chop slice の rate が 1.0 からこの幅を超えて外れたら time-stretch 未対応として 1 回 warn する。 */
const SLICE_RATE_TOLERANCE = 0.01

/** feature gap warning の初期状態（フィールド初期化子で arm・stopAll で再 arm に使う）。 */
const freshWarned = (): Record<GapKind, boolean> => ({
  slice: false,
  outputChannel: false,
  masterEffect: false,
})

export class RustEnginePlayer implements AudioEngineBackend {
  private readonly daemon: DaemonClient
  private readonly daemonPath?: string
  private readonly wsUrlOverride?: string
  private readonly lookaheadSec: number
  private readonly onDispatch?: (info: DispatchInfo) => void

  // --- lean scheduler state（SC EventScheduler の mirror） ---
  private scheduledPlays: ScheduledPlay[] = []
  /** 生きているシーケンス名の集合。clear/mute されると消え、queue 残存イベントが skip される。 */
  private readonly liveSequences = new Set<string>()
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
  private warned: Record<GapKind, boolean> = freshWarned()

  constructor(options: RustEnginePlayerOptions = {}) {
    this.daemon = new DaemonClient()
    this.daemonPath = options.daemonPath
    this.wsUrlOverride = options.wsUrlOverride
    this.lookaheadSec = options.lookaheadSec ?? DEFAULT_LOOKAHEAD_SEC
    this.onDispatch = options.onDispatch
  }

  // --- AudioEngine surface ---

  /** StreamStats(1Hz) の transport now_sec で anchor を前進補正する handler（audio/wall drift 吸収）。 */
  private readonly onStreamStats = (data: unknown): void => {
    const nowSec = Number((data as { now_sec?: unknown }).now_sec)
    if (Number.isFinite(nowSec)) {
      this.clockAnchor = { tsMs: Date.now(), daemonSec: nowSec }
    } else {
      // 不正な now_sec で anchor を凍結させると drift しうるので、無言にせず通知する。
      console.warn(
        '⚠️  [rust-engine] StreamStats missing a valid now_sec — clock anchor not updated:',
        data,
      )
    }
  }

  /**
   * daemon を起動し WebSocket 接続を確立する。`outputDevice` は S2 では未対応
   * （daemon は既定デバイスを選択）。**一度だけ呼ぶ前提**（InterpreterV2 は isBooted で guard）。
   *
   * 順序が load-bearing: getStatus で初期 anchor を確定**してから** StreamStats を subscribe する。
   * 逆順だと、getStatus の await 中に届いた StreamStats（精緻な transport now_sec）を、後続の
   * getStatus(uptime_sec) が後退上書きしうる。先に初期 anchor を置けば StreamStats は常に前進補正。
   */
  async boot(outputDevice?: string): Promise<void> {
    if (outputDevice) {
      console.warn(
        `⚠️  [rust-engine] outputDevice="${outputDevice}" is not yet honored — the daemon uses the system default output (S2 scope).`,
      )
    }

    await this.daemon.start({ daemonPath: this.daemonPath, wsUrlOverride: this.wsUrlOverride })

    // 暫定 anchor: uptime_sec ≈ transport now_sec（共に stream 開始から実時間で進む）。
    try {
      const status = await this.daemon.getStatus()
      const uptime = Number(status.uptime_sec)
      this.clockAnchor = { tsMs: Date.now(), daemonSec: Number.isFinite(uptime) ? uptime : 0 }
    } catch (err) {
      // anchor=0 は初回 StreamStats（≤約1s）で自己修復するが、その間 onset clip しうるので
      // 無言にせず通知する（空 catch を避ける）。
      console.warn(
        '⚠️  [rust-engine] getStatus() failed during boot — clock anchor defaults to 0 (self-heals on first StreamStats):',
        err,
      )
      this.clockAnchor = { tsMs: Date.now(), daemonSec: 0 }
    }

    // 初期 anchor 確定後に subscribe。off→on で二重 boot 時の listener 累積も防ぐ。
    this.daemon.off('stream-stats', this.onStreamStats)
    this.daemon.on('stream-stats', this.onStreamStats)
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

  /**
   * マスターエフェクト（compressor/limiter/normalizer）は daemon 未対応（A4 era）。
   * 他の feature gap と同じく、見かけの parity を作らないよう 1 回 warn して no-op にする
   * （無言 drop だと `global.compressor()` 等が効いていないことに operator が気付けない）。
   */
  async addEffect(_target: string, effectType: string, _params: unknown): Promise<void> {
    this.warnOnce(
      'masterEffect',
      `⚠️  [rust-engine] master effect "${effectType}" is not supported yet (A4 era) — it is a no-op on the rust engine.`,
    )
  }

  async removeEffect(_target: string, _effectType: string): Promise<void> {
    this.warnOnce(
      'masterEffect',
      `⚠️  [rust-engine] master effects are not supported yet (A4 era) — removeEffect is a no-op on the rust engine.`,
    )
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
    // pan は daemon PlayAt で実装済み（#304・equal-power = SC Pan2 一致）。発火時に
    // executePlayback が DSL の -100..100 を daemon の [-1,1] へ変換して送る。
    this.enqueue({ time, filepath, gainDb, pan, sequenceName })
  }

  /**
   * chop の slice を領域再生（startPos/duration の切り出し・rate=1.0）でスケジュールする（#304）。
   *
   * slice 領域（offset/長さ）はサンプル尺に依存するが、daemon の load は lazy（初回発火時）
   * のため、領域は `executePlayback` で load 完了後に計算する。ここでは slice 仕様だけ保持する。
   *
   * rate≠1.0（slice 尺をイベントスロット尺へ詰める varispeed = time-stretch）は本増分の対象外。
   * 発火時に rate≠1.0 を検出したら 1 回 warn し、slice は自然尺（rate=1.0）で鳴らす
   * （time-stretch 増分 #213/#239 へ defer）。per-slice gain は各 slice の gainDb がそのまま効く。
   */
  scheduleSliceEvent(
    filepath: string,
    time: number,
    sliceIndex: number,
    totalSlices: number,
    eventDurationMs: number | undefined,
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
    this.enqueue({
      time,
      filepath,
      gainDb,
      pan,
      sequenceName,
      slice: { index: sliceIndex, total: totalSlices, eventDurationMs },
    })
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
        if (play.sequenceName && !this.liveSequences.has(play.sequenceName)) {
          continue
        }
        this.executePlayback(play).catch((err) => this.onPlaybackError(play, err))
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
    this.liveSequences.clear()
    this.warned = freshWarned()
    // 注: 既に daemon へ送信済み（発音中）の voice は自然減衰で終わる。即時 hard-stop は
    // play_id 追跡 or daemon 側 StopAll コマンドが要る後続課題（短サンプル前提で proof は許容）。
  }

  clearSequenceEvents(sequenceName: string): void {
    this.scheduledPlays = this.scheduledPlays.filter((p) => p.sequenceName !== sequenceName)
    // 集合から消すことで、まだ queue に残るイベントも poll/exec 時に skip される。
    this.liveSequences.delete(sequenceName)
  }

  reinitializeSequenceTracking(sequenceName: string): void {
    this.liveSequences.add(sequenceName)
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
      this.liveSequences.add(play.sequenceName)
    }
  }

  private async executePlayback(play: ScheduledPlay): Promise<void> {
    if (play.sequenceName) {
      // poll 検出から executePlayback 実行までの microtask gap で clear された場合の skip。
      if (!this.liveSequences.has(play.sequenceName)) return
      const drift = Date.now() - this.startTime - play.time
      if (drift > MAX_DRIFT_MS) return
    }

    const amplitude = gainDbToAmplitude(play.gainDb)
    if (amplitude <= 0) return // 無音はスキップ（音響的に同一）。

    const sampleId = await this.ensureLoaded(play.filepath)
    // ロード（async round-trip）中に clear された場合の再チェック（mute/stop への応答性）。
    if (play.sequenceName && !this.liveSequences.has(play.sequenceName)) return
    // chop の slice 領域は load 済み尺から計算する（lazy load のためここで解決）。
    const { offsetSec, durationSec } = this.resolveSliceRegion(play)
    // daemonNowSec と wallMs は送信「前」に同一瞬間で採取する（onDispatch の lead/drift 計測が
    // coherent になるよう。playAt の await 後だと round-trip 分ずれる）。
    const wallMs = Date.now()
    const daemonNowSec = this.daemonNowSec()
    const timeSec = daemonNowSec + this.lookaheadSec
    // DSL pan（-100..100）を daemon の [-1,1] へ変換。範囲外は daemon 側で clamp。
    const pan = play.pan / 100
    const { playId } = await this.daemon.playAt(
      sampleId,
      timeSec,
      amplitude,
      pan,
      offsetSec,
      durationSec,
    )
    this.onDispatch?.({
      filepath: play.filepath,
      sampleId,
      scheduledTimeMs: play.time,
      wallMs,
      daemonNowSec,
      timeSec,
      gain: amplitude,
      playId,
    })
  }

  /**
   * poll-loop の executePlayback 失敗ハンドラ。daemon 切断（WebSocket close）は fatal
   * として scheduler を停止し**一度だけ**通知する（さもないと queue 全 note が個別に
   * console.error を吐き flood する）。停止後の in-flight 失敗や teardown race は `isRunning`
   * ガードで抑制する。それ以外（単発の不正サンプル等）は当該 note だけ error ログ。
   */
  private onPlaybackError(play: ScheduledPlay, err: unknown): void {
    if (!this.isRunning) return // 既に stop/stopAll/quit 済み — teardown race を抑制
    if (err instanceof DaemonConnectionError || !this.daemon.isRunning()) {
      console.error('❌ [rust-engine] daemon connection lost — stopping playback:', err)
      this.stop()
      return
    }
    console.error(
      `❌ [rust-engine] playback error for ${play.sequenceName} (${play.filepath}):`,
      err,
    )
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
        if (res.sampleRate > 0 && Number.isFinite(res.sampleRate)) {
          this.durations.set(filepath, res.frames / res.sampleRate)
        } else {
          // 尺が取れないと chop の領域が計算できず、slice が無言で全体再生に degrade する
          // （#304 で durations が slice 再生に load-bearing 化した）。ソースで warn する。
          console.warn(
            `⚠️  [rust-engine] LoadSample for "${filepath}" returned invalid sample_rate=` +
              `${res.sampleRate} — chop slice 領域を計算できず、slice は全体再生に degrade します。`,
          )
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

  /**
   * chop の slice 領域（offset/長さ・秒）を load 済みサンプル尺から計算する。
   *
   * 全体再生（slice なし）は `{0, 0}`（= daemon は全体再生）。slice の場合は
   * `sliceDuration = totalDuration / total`、`offset = (index-1) * sliceDuration` を返す。
   * 尺が未取得（lazy load で frames/SR が 0）の場合は全体再生にフォールバックする。
   *
   * rate≠1.0（slice 尺をイベントスロット尺に詰める time-stretch）は本増分の対象外なので、
   * 検出したら 1 回 warn する（slice 自体は自然尺 rate=1.0 で鳴る）。
   */
  private resolveSliceRegion(play: ScheduledPlay): { offsetSec: number; durationSec: number } {
    const spec = play.slice
    if (!spec) return { offsetSec: 0, durationSec: 0 }
    const totalDuration = this.durations.get(play.filepath) ?? 0
    if (totalDuration <= 0 || spec.total <= 0) {
      // 尺不明 → 全体再生フォールバック（誤った領域で無音を作らない）。
      return { offsetSec: 0, durationSec: 0 }
    }
    const sliceDuration = totalDuration / spec.total
    const offsetSec = (spec.index - 1) * sliceDuration
    // time-stretch（rate≠1.0）は未対応。slice 尺がスロット尺と一致しない場合のみ warn。
    if (spec.eventDurationMs && spec.eventDurationMs > 0) {
      const rate = (sliceDuration * 1000) / spec.eventDurationMs
      if (Math.abs(rate - 1) > SLICE_RATE_TOLERANCE) {
        this.warnOnce(
          'slice',
          `⚠️  [rust-engine] chop slice rate=${rate.toFixed(3)} (slice length ≠ event slot) — ` +
            `time-stretch is not supported yet; the slice plays at natural length (rate=1.0). ` +
            `Deferred to the time-stretch increment (#213/#239).`,
        )
      }
    }
    return { offsetSec, durationSec: sliceDuration }
  }

  private warnOnce(kind: GapKind, message: string): void {
    if (this.warned[kind]) return
    this.warned[kind] = true
    console.warn(message)
  }
}
