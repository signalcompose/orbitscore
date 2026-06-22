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
 *  - **slice（chop 領域再生）は #304 で実装済み**（offset/duration の領域読み）。
 *    rate≠1.0（slice 尺をイベントスロット尺へ詰める varispeed）は #319 で実装済み（daemon
 *    PlayAt の rate・SC `PlayBuf.ar(rate:)` 一致＝ピッチも動く）。pitch-preserving な
 *    time-stretch（fixpitch/time）は別物で #213 へ defer。
 *
 *  - **残る feature gap は boundary で明示**（見かけの parity を作らない・A0 方針）:
 *    outputChannel(LinkAudio) → 1回 warn して hardware 発音（SC の plugin-missing fallback と同形）/
 *    master effects（compressor/limiter/normalizer）→ 1回 warn して no-op。いずれも A4 era。
 */

import { gainDbToAmplitude } from '../audio-gain-utils'
import type { AudioEngineBackend } from '../engine-backend'
import type { AudioDevice } from '../supercollider/types'

import { DaemonClient } from './daemon-client'
import { DaemonConnectionError, DaemonQuitError } from './errors'

/**
 * boundary で明示する未対応 feature gap の種別（A4 era）。
 * - `outputChannel`(LinkAudio) / `masterEffect`: 未対応 feature gap。
 * pan / slice 領域 / slice varispeed（rate≠1.0）は実装済みのため gap ではない。
 */
type GapKind = 'outputChannel' | 'masterEffect'

/** chop slice 情報。`scheduleSliceEvent` 由来。発火時に領域（offset/duration）へ解決する。 */
export interface SliceSpec {
  /** slice 番号（1 始まり）。 */
  index: number
  /** 分割数（`chop(n)` の n）。 */
  total: number
  /**
   * イベントスロット尺（ms）。varispeed レート算出に使う
   * （`rate = sliceDuration / eventSlotDuration`）。未指定 / 0 以下なら rate=1.0（自然尺）。
   */
  eventDurationMs?: number
}

/** lean scheduler が保持する 1 発音イベント。SC `ScheduledPlay` の daemon 版。 */
export interface ScheduledPlay {
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

/**
 * daemon `PlayAt` の音響パラメータ（発音時刻を除く）。`toDaemonParams` の戻り値。
 *
 * 発火時刻（`timeSec`）は実時間 anchor 依存で非決定論なのでここには含めない。
 * 検証ハーネス（#311）はこの決定論パラメータ列を schedule として取り出す。
 */
export interface DaemonPlayParams {
  /** linear amplitude（`gainDb` から変換）。 */
  gain: number
  /** daemon pan [-1,1]（DSL の -100..100 から変換）。 */
  pan: number
  /** slice 領域開始（秒）。0 = 先頭。 */
  offsetSec: number
  /** slice 領域長（秒）。0 = `offsetSec` 以降すべて。 */
  durationSec: number
  /**
   * varispeed レート（1.0 = 自然尺）。chop slice 尺をイベントスロット尺へ詰める際に
   * `rate = sliceDuration / eventSlotDuration` を送る（SC `calculatePlaybackRate` 一致）。
   * >1 = 速く短く高ピッチ、<1 = 遅く長く低ピッチ（pitch も動く varispeed）。
   */
  rate: number
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
/** daemon が死んだとき respawn を試みる最大回数。枯渇したら recovery を断念し poll を止める。 */
const MAX_RESPAWN_ATTEMPTS = 5
/** respawn 試行間の固定バックオフ（crash loop 緩和 + port 解放待ち）。 */
const RESPAWN_BACKOFF_MS = 150

/** feature gap warning の初期状態（フィールド初期化子で arm・stopAll で再 arm に使う）。 */
const freshWarned = (): Record<GapKind, boolean> => ({
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

  // --- supervisor 状態（recovery floor / #300） ---
  /**
   * respawn 進行中は executePlayback の dispatch を止める。stale な clockAnchor のまま新 daemon
   * （transport=0）へ「数秒先」を送って desync するのを防ぐ、recovery の唯一 load-bearing な不変式。
   * 死検出で true、再 anchor（establishSession）完了後に false。
   */
  private respawning = false
  /** quit() 済みフラグ。respawn ループと onDaemonDied がこれを見て中断する。 */
  private disposed = false
  /** respawn の single-flight ガード（death/close/reject が同時多発しても二重 spawn させない）。 */
  private respawnPromise: Promise<void> | null = null

  /** feature gap の 1 回限り warning。stopAll で再 arm する。 */
  private warned: Record<GapKind, boolean> = freshWarned()

  constructor(options: RustEnginePlayerOptions = {}) {
    this.daemon = new DaemonClient()
    this.daemonPath = options.daemonPath
    this.wsUrlOverride = options.wsUrlOverride
    this.lookaheadSec = options.lookaheadSec ?? DEFAULT_LOOKAHEAD_SEC
    this.onDispatch = options.onDispatch
    // daemon の予期せぬ死を supervise する（recovery floor / #300）。意図的 quit は DaemonClient が
    // intentionalClose で抑制するので、このリスナは crash（panic→exit / segfault / kill）のみ発火する。
    this.daemon.on('daemon-died', this.onDaemonDied)
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
    await this.establishSession()
  }

  /**
   * 接続確立後の session 確立: transport anchor の初期化 + StreamStats 購読。boot と respawn が共有。
   *
   * 順序が load-bearing: getStatus で初期 anchor を確定**してから** StreamStats を subscribe する
   * （逆順だと getStatus の await 中に届いた精緻な now_sec を、後続の uptime_sec が後退上書きしうる）。
   * off→on で二重購読も防ぐ（respawn は同一 DaemonClient を再利用するため必須）。
   */
  private async establishSession(): Promise<void> {
    // 暫定 anchor: uptime_sec ≈ transport now_sec（共に stream 開始から実時間で進む）。respawn 後は
    // 新 daemon の uptime（≈0）へ再 anchor され、死んだ daemon の古い transport との desync を断つ。
    try {
      const status = await this.daemon.getStatus()
      const uptime = Number(status.uptime_sec)
      this.clockAnchor = { tsMs: Date.now(), daemonSec: Number.isFinite(uptime) ? uptime : 0 }
    } catch (err) {
      // anchor=0 は初回 StreamStats（≤約1s）で自己修復するが、その間 onset clip しうるので
      // 無言にせず通知する（空 catch を避ける）。
      console.warn(
        '⚠️  [rust-engine] getStatus() failed — clock anchor defaults to 0 (self-heals on first StreamStats):',
        err,
      )
      this.clockAnchor = { tsMs: Date.now(), daemonSec: 0 }
    }

    // 初期 anchor 確定後に subscribe。off→on で二重購読（再 boot / respawn）を防ぐ。
    this.daemon.off('stream-stats', this.onStreamStats)
    this.daemon.on('stream-stats', this.onStreamStats)
  }

  /**
   * daemon の予期せぬ死（panic→exit / segfault / SIGKILL）を DaemonClient の 'daemon-died' から
   * 受ける（recovery floor / #300）。session 状態の権威は生存側 TS にある（active loops は loop
   * timer + poll ループ + scheduledPlays が TS 保持）ので、daemon を respawn して接続を再確立すれば
   * loops は構造的に復帰する。daemon が持つのは disposable な状態（loaded samples / in-flight
   * voices / transport clock）だけで、それぞれ lazy 再ロード / drop / 再 anchor で回復する。
   */
  private readonly onDaemonDied = (): void => {
    if (this.disposed) return // quit() 進行中 — respawn しない
    // 再 anchor 完了まで dispatch を止める（respawning の宣言コメント参照・唯一 load-bearing）。
    this.respawning = true
    console.warn('⚠️  [rust-engine] daemon died unexpectedly — respawning…')
    // respawnLoop は try/finally で自己完結するが、想定外の throw（将来の改変等）が
    // unhandled rejection になって TS プロセスを巻き込まないよう安全網を張る。
    void this.ensureRespawn().catch((err) => {
      console.error('❌ [rust-engine] unexpected error escaped respawn loop:', err)
      this.respawning = false
    })
  }

  /** respawn を single-flight 化する（同時多発する death/close/reject で二重 spawn しないため）。 */
  private ensureRespawn(): Promise<void> {
    if (this.respawnPromise) return this.respawnPromise
    this.respawnPromise = this.respawnLoop().finally(() => {
      this.respawnPromise = null
    })
    return this.respawnPromise
  }

  /**
   * daemon を再起動し session を再確立する。再 anchor（establishSession）が完了するまで
   * `respawning` を倒さない（executePlayback の guard が dispatch を止め続ける）= 順序が load-bearing。
   * 上限到達時は TS プロセスを落とさず（recovery floor の最終保証）poll ループだけ止めて断念する。
   */
  private async respawnLoop(): Promise<void> {
    try {
      for (let attempt = 1; attempt <= MAX_RESPAWN_ATTEMPTS; attempt++) {
        if (this.disposed) return
        // crash loop 緩和 + port 解放待ち（disposed は delay 後に再チェックする）。
        await new Promise<void>((resolve) => setTimeout(resolve, RESPAWN_BACKOFF_MS))
        if (this.disposed) return
        try {
          await this.daemon.start({
            daemonPath: this.daemonPath,
            wsUrlOverride: this.wsUrlOverride,
          })
          // quit() が割り込んだら、立てたばかりの daemon は quit() の daemon.quit() が回収する。
          if (this.disposed) return
          await this.establishSession()
          if (this.disposed) return
          // establishSession 中に新 daemon が即死すると、getStatus は DaemonConnectionError を
          // anchor=0 で吸収して正常 return しうる。ここで生存を確認せず成功宣言すると、再死の
          // daemon-died は single-flight で本ループに吸収されたまま respawnPromise が解決し、二度と
          // respawn されず dispatch が永久に drop される（recovery floor が黙って死ぬ最悪ケース）。
          // benign な getStatus 失敗（daemon 生存・anchor は StreamStats で自己修復）は isRunning が
          // true なので success へ進む。実際の再死のときだけ retry に回す（沈黙させず可視化する）。
          if (!this.daemon.isRunning()) {
            console.warn(
              `⚠️  [rust-engine] daemon re-died during session re-establishment ` +
                `(attempt ${attempt}/${MAX_RESPAWN_ATTEMPTS}) — retrying…`,
            )
            continue
          }
          // 新 daemon は空。古い sample_id は無効 → 破棄し ensureLoaded に lazy 再ロードさせる
          // （durations は file 由来で不変なので保持し slice 領域解決に使う）。inflightLoads の旧
          // エントリは ws close の reject で各自の .finally が既に delete 済み。
          this.sampleIds.clear()
          console.warn(
            `✅ [rust-engine] daemon respawned and session re-established (attempt ${attempt}/${MAX_RESPAWN_ATTEMPTS}).`,
          )
          return
        } catch (err) {
          console.warn(
            `⚠️  [rust-engine] respawn attempt ${attempt}/${MAX_RESPAWN_ATTEMPTS} failed:`,
            err,
          )
        }
      }
      // 上限到達 — recovery 断念。TS プロセスは落とさず poll ループだけ止める。
      console.error(
        `❌ [rust-engine] daemon respawn failed after ${MAX_RESPAWN_ATTEMPTS} attempts — ` +
          `stopping playback (the TS process stays alive).`,
      )
      this.stop()
    } finally {
      // すべての退出経路（成功 = 再 anchor 後 / disposed / 上限到達）で dispatch ガードを解除する
      // 単一の正準リセット。成功時は establishSession 完了後の return が finally を通るので、再 anchor
      // 前に dispatch が再開される事はない（順序は load-bearing・guard 解除はここだけ）。
      this.respawning = false
    }
  }

  async quit(): Promise<void> {
    this.disposed = true
    this.stopAll()
    this.daemon.off('daemon-died', this.onDaemonDied)
    this.daemon.off('stream-stats', this.onStreamStats)
    // respawn 進行中なら収束を待ってから daemon を落とす（立てたばかりの daemon も回収する）。
    // disposed=true なので respawnLoop は次のチェックポイントで抜ける。
    if (this.respawnPromise) {
      try {
        await this.respawnPromise
      } catch (err) {
        // respawnLoop は disposed=true で早期 return するので通常は throw しない。想定外の
        // 失敗でも quit は続行するが、silent に握り潰さず記録する。
        console.warn('[rust-engine] quit: respawn settled with an unexpected error:', err)
      }
    }
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
    // daemon 側の in-flight voice（varispeed の rate<1.0 で長尺化した slice 含む）も即時
    // hard-stop する（#319）。stopAll は同期契約なので fire-and-forget。失敗（接続喪失）は
    // supervisor 任せで静かに drop する。teardown(quit)/respawn 中は対象が無い/置換されるので
    // skip する（quit は daemon.quit() が、respawn は新 daemon が空であることが各々始末する）。
    if (!this.disposed && !this.respawning && this.daemon.isRunning()) {
      // 接続喪失（DaemonConnectionError 等）は想定内 — 死んだ daemon に stop は不要。
      void this.daemon.stopAll().catch(() => {})
    }
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
    // daemon 復旧中（respawn）/ 切断中は dispatch を drop する。stale clockAnchor のまま新 daemon
    // （transport=0）へ「数秒先」を送って desync するのを防ぎ、in-flight one-shot を再発火させない
    // （可聴ギャップは許容）。このガードは「ガード時点で復旧中と判っている」ケースを順序保証で止める。
    // ガード通過後に await（ensureLoaded/playAt）で yield 中に死ぬ TOCTOU は onPlaybackError の
    // silent-drop（DaemonConnectionError / respawning / !isRunning）が拾う＝二段構え。
    if (this.respawning || !this.daemon.isRunning()) return
    if (play.sequenceName) {
      // poll 検出から executePlayback 実行までの microtask gap で clear された場合の skip。
      if (!this.liveSequences.has(play.sequenceName)) return
      const drift = Date.now() - this.startTime - play.time
      if (drift > MAX_DRIFT_MS) return
    }

    const amplitude = gainDbToAmplitude(play.gainDb)
    if (amplitude <= 0) return // 無音はロード前にスキップ（音響的に同一）。

    const sampleId = await this.ensureLoaded(play.filepath)
    // ロード（async round-trip）中に clear された場合の再チェック（mute/stop への応答性）。
    if (play.sequenceName && !this.liveSequences.has(play.sequenceName)) return
    // 音響パラメータ（amplitude/pan/slice 領域）は本番発火と検証ハーネス（#311）で共有する
    // 変換に集約する。slice 領域は ensureLoaded 後の尺（this.durations）を使う（lazy load）。
    const { gain, pan, offsetSec, durationSec, rate } = this.toDaemonParams(play)
    // daemonNowSec と wallMs は送信「前」に同一瞬間で採取する（onDispatch の lead/drift 計測が
    // coherent になるよう。playAt の await 後だと round-trip 分ずれる）。
    const wallMs = Date.now()
    const daemonNowSec = this.daemonNowSec()
    const timeSec = daemonNowSec + this.lookaheadSec
    const { playId } = await this.daemon.playAt(
      sampleId,
      timeSec,
      gain,
      pan,
      offsetSec,
      durationSec,
      rate,
    )
    this.onDispatch?.({
      filepath: play.filepath,
      sampleId,
      scheduledTimeMs: play.time,
      wallMs,
      daemonNowSec,
      timeSec,
      gain,
      playId,
    })
  }

  /**
   * poll-loop の executePlayback 失敗ハンドラ。daemon 切断（WebSocket close）は **supervisor の
   * respawn が処理する** ので、ここでは poll ループを止めず当該 dispatch を静かに drop する
   * （recovery floor / #300）。死んだ瞬間の in-flight playAt/loadSample は close で reject されて
   * ここへ流れ込むが、respawn 中の guard と合わせて flood も止む。停止後の teardown race は
   * `isRunning` ガードで抑制。それ以外（単発の不正サンプル等）は当該 note だけ error ログを出す。
   */
  private onPlaybackError(play: ScheduledPlay, err: unknown): void {
    if (!this.isRunning) return // 既に stop/stopAll/quit 済み — teardown race を抑制
    // 接続喪失（死の瞬間の in-flight 失敗 / respawn 中）は supervisor 任せ → 静かに drop。
    // DaemonQuitError は quit() 中の in-flight reject（stopAll が isRunning を倒すので普通は上の
    // guard が拾うが、ordering 変更に強くするため明示的にも drop する。injectFault と対称）。
    if (
      err instanceof DaemonConnectionError ||
      err instanceof DaemonQuitError ||
      this.respawning ||
      !this.daemon.isRunning()
    ) {
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
        // 尺計算には sample_rate と frames の両方が有限・正である必要がある。どちらかが
        // 不正だと chop の領域が計算できず slice が無言で全体再生に degrade する
        // （#304 で durations が slice 再生に load-bearing 化した）。ソースで warn する。
        if (
          res.sampleRate > 0 &&
          Number.isFinite(res.sampleRate) &&
          Number.isFinite(res.frames) &&
          res.frames >= 0
        ) {
          this.durations.set(filepath, res.frames / res.sampleRate)
        } else {
          console.warn(
            `⚠️  [rust-engine] LoadSample for "${filepath}" returned invalid metadata ` +
              `(sample_rate=${res.sampleRate}, frames=${res.frames}) — ` +
              `chop slice 領域を計算できず、slice は全体再生に degrade します。`,
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
   * chop の slice 領域（offset/長さ・秒）と varispeed レートを load 済みサンプル尺から計算する。
   *
   * 全体再生（slice なし）は `{0, 0, 1}`（= daemon は全体再生・自然尺）。slice の場合は
   * `sliceDuration = totalDuration / total`、`offset = (index-1) * sliceDuration` を返す。
   * 尺が未取得（lazy load で frames/SR が 0）の場合は全体再生にフォールバックする。
   *
   * varispeed: slice 自然尺をイベントスロット尺へ詰める `rate = sliceDuration / eventSlotDuration`
   * を返す（SC `calculatePlaybackRate` 一致・>1 で速く高ピッチ、<1 で遅く低ピッチ）。
   * `eventDurationMs` 未指定 / 0 以下なら自然尺（rate=1.0）。
   */
  private resolveSliceRegion(play: ScheduledPlay): {
    offsetSec: number
    durationSec: number
    rate: number
  } {
    const spec = play.slice
    if (!spec) return { offsetSec: 0, durationSec: 0, rate: 1 }
    const totalDuration = this.durations.get(play.filepath) ?? 0
    // NaN <= 0 は JS では false。尺が NaN/非有限でも確実に全体再生フォールバックへ落とす。
    if (!Number.isFinite(totalDuration) || totalDuration <= 0 || spec.total <= 0) {
      // 尺不明 → 全体再生フォールバック（rate=1.0・誤った領域で無音を作らない）。
      return { offsetSec: 0, durationSec: 0, rate: 1 }
    }
    const sliceDuration = totalDuration / spec.total
    const offsetSec = (spec.index - 1) * sliceDuration
    // varispeed レート（SC calculatePlaybackRate と同形）。eventDurationMs 不在 / 0 以下は自然尺。
    const rate =
      spec.eventDurationMs && spec.eventDurationMs > 0
        ? (sliceDuration * 1000) / spec.eventDurationMs
        : 1
    return { offsetSec, durationSec: sliceDuration, rate }
  }

  /**
   * `ScheduledPlay` を daemon `PlayAt` の音響パラメータ（amplitude / pan / slice 領域）へ
   * 変換する。**本番発火（executePlayback）と検証ハーネス（schedule 抽出 #311）が同一の
   * 変換を共有**し、片方だけが変わって検証が test double を見て緑になる drift を防ぐ。
   *
   * slice 領域は load 済み尺（`this.durations`）に依存する。本番は `ensureLoaded` が尺を
   * 設定済み、検証は `seedDuration` で seed しておくこと。発音時刻は実時間 anchor 依存で
   * 非決定論なので含めない（呼び出し側が付与する）。
   * @internal 本番 dispatch（executePlayback）と検証ハーネス（#311）が共有する変換。
   *   `@internal` = 外部公開 API ではない、の意（テスト専用ではない）。
   */
  toDaemonParams(play: ScheduledPlay): DaemonPlayParams {
    // DSL pan（-100..100）を daemon の [-1,1] へ変換。範囲外は daemon 側で clamp。
    return {
      gain: gainDbToAmplitude(play.gainDb),
      pan: play.pan / 100,
      ...this.resolveSliceRegion(play),
    }
  }

  /**
   * 検証ハーネス（#311）用: slice 領域解決に使うサンプル尺（秒）を seed する。本番は
   * `ensureLoaded` が daemon の LoadSample メタから設定するが、検証は daemon を立てずに
   * `toDaemonParams` を呼ぶため、既知の fixture 尺をここで与える。
   * @internal
   */
  seedDuration(filepath: string, seconds: number): void {
    this.durations.set(filepath, seconds)
  }

  /**
   * 現在の daemon 子プロセスの PID（recovery floor の kill-test が hard-death = SIGKILL を
   * 外から注入するための read-only seam）。@internal — production code は使用しない。
   */
  get daemonPid(): number | undefined {
    return this.daemon.childPid
  }

  /**
   * gated な fault を daemon に注入する（kill-test 専用 / @internal）。clean-exit（panic hook）
   * 経路を試すのに使う。daemon は ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1 のときだけ受理する。
   */
  async injectDaemonFault(): Promise<void> {
    return this.daemon.injectFault()
  }

  /**
   * 現在 live な daemon の状態スナップショット（kill-test の daemon-side 状態クエリ用 / @internal）。
   * respawn 後に uptime_sec（≈transport）/ loaded_samples / active_plays を読み、再 anchor と
   * セッション再確立を daemon 側から検証する（#300 の orphaned play_id / active loops 復帰の接地）。
   */
  async getDaemonStatus(): Promise<Record<string, unknown>> {
    return this.daemon.getStatus()
  }

  private warnOnce(kind: GapKind, message: string): void {
    if (this.warned[kind]) return
    this.warned[kind] = true
    console.warn(message)
  }
}
