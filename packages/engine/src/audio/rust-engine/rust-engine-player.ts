/**
 * Rust audio backend adapter (post-2.0 S2 / Issue #296).
 *
 * `DaemonClient`（orbit-audio-daemon / WebSocket）を `AudioEngineBackend` 契約へ
 * ラップし、`SuperColliderPlayer` の sibling として interpreter に差し込めるようにする。
 * cutover #108 で `createAudioEngine()` の既定バックエンド。SC 経路は温存し
 * `ORBITSCORE_ENGINE=sc` で opt-out できる（SC parity 到達済み）。
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
import type {
  EffectChainApplyRequest,
  EffectChainApplyResult,
  EffectChainStageConfig,
  PluginLoadResult,
  PluginReplaceResult,
  PluginUnloadResult,
  PluginStateSaveTarget,
  PluginUiCloseCompletion,
  PluginUiTarget,
} from '../types'

import { DaemonClient } from './daemon-client'
import { wireObject } from './wire-validation'
import type { AudioDeviceListEntry } from './daemon-client'
import { DaemonConnectionError, DaemonProtocolError, DaemonQuitError } from './errors'

/**
 * boundary で明示する未対応 feature gap の種別（A4 era）。
 * - `outputChannel`(LinkAudio) / `masterEffect`: 未対応 feature gap。
 * - `linkTempo`: Link テンポリード（#283・A4-PR3）。daemon が feature 無効ビルドなら warn-once。
 * - `pluginNoteDrop`: daemon 未接続時に plugin note-on/off が silent drop される gap（#427 レビュー C1）。
 * - `pluginInactive`: respawn 後の instrument 復元失敗（`pluginActive===false`）で note が
 *   silent drop される gap（#427 レビュー C2）。
 * pan / slice 領域 / slice varispeed（rate≠1.0）は実装済みのため gap ではない。
 */
type GapKind = 'outputChannel' | 'masterEffect' | 'linkTempo' | 'pluginNoteDrop' | 'pluginInactive'

function eventNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return Number(value)
}

function pluginUiTargetFromEvent(data: Record<string, unknown>): PluginUiTarget {
  const target = wireObject(data.target, 'target')
  const index = eventNonNegativeInteger(target.index, 'target.index')
  if (target.role === 'effect') {
    if (target.bus !== undefined && typeof target.bus !== 'string') {
      throw new Error('target.bus must be a string when present')
    }
    return {
      role: 'effect',
      ...(target.bus === undefined ? {} : { bus: target.bus }),
      index: index + 1,
    }
  }
  if (target.role === 'instrument' && typeof target.instance === 'string') {
    return { role: 'instrument', instance: target.instance, index }
  }
  throw new Error("target must identify an 'effect' or 'instrument' plugin")
}

function pluginStateTarget(target: PluginUiTarget): PluginStateSaveTarget {
  return target.role === 'effect'
    ? {
        role: 'effect',
        ...(target.bus === undefined ? {} : { bus: target.bus }),
        chainPath: [target.index - 1],
      }
    : { role: 'instrument', instance: target.instance, chainPath: [0] }
}

function pluginUiTargetMatches(left: PluginUiTarget, right: PluginUiTarget): boolean {
  if (left.role !== right.role || left.index !== right.index) return false
  if (left.role === 'effect' && right.role === 'effect') return left.bus === right.bus
  return (
    left.role === 'instrument' && right.role === 'instrument' && left.instance === right.instance
  )
}

/** `closePluginUi` の DONE 待ち 1 件。UI_CLOSED_DONE / respawn 中断 / timeout のどれかで settle する。 */
interface PendingPluginUiClose {
  target: PluginUiTarget
  resolve: (completion: PluginUiCloseCompletion) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
  /** LinkAudio ルーティング先チャンネル名。非空の時のみ daemon の PlayAt へ転送する。 */
  outputChannel?: string
  /**
   * per-sequence insert bus 名（`seq.effect()`・PH.2b・#434 S3）。非空の時のみ daemon の
   * PlayAt へ転送する。`outputChannel` と同時に立つことはない（LinkAudio と plugin
   * hosting は v1 で排他）。
   */
  insertBus?: string
  /**
   * #390 live playhead: 由来する play() 引数のドット結合インデックス（"2"、ネストは
   * 後段で "1.0"）。dispatch 成功時に `[STEP]` marker を stdout へ出すためだけの
   * observational フィールド。timing / 音響には一切影響しない。
   */
  argPath?: string
  /**
   * #390: 休符 (0) スロットの marker-only イベント。daemon への dispatch は行わず、
   * 発火タイミングで `[STEP]` だけを出す（filepath は空文字）。
   */
  markerOnly?: boolean
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

/**
 * anchor 回帰窓のサンプル数上限（StreamStats は 1Hz なので ≈30 秒窓）。
 *
 * StreamStats の now_sec は `cursor_frames / sample_rate` で、cursor はデバイス
 * コールバックごとに一括前進する — 非同期に読む 1Hz ticker が得る値は
 * ブロック長（512f@48kHz ≈ 10.67ms）だけ下方向に量子化されており、tick ごとの
 * ブロック位相ずれが 2 小節周期 ±5.3ms の可聴ヨレとして発音時刻に転写されていた
 * （#389 機構 B）。単一 last-wins anchor をやめ、直近サンプル列への最小二乗
 * フィットで推定すると、量子化ノイズは平均化で ~0.6ms 級に落ち、wall↔device の
 * 実効レート差（ppm 級）も傾きとして吸収される。フィット直線は真値より
 * ~半ブロック下に座るが、それは「一定オフセット」であり grid の安定性には
 * 影響しない（定位相のレイテンシは lookahead 50ms の内側で無害）。
 */
const ANCHOR_WINDOW = 30

/** anchor 窓の最小二乗フィット。`daemonSec ≈ intercept + slope · (tsMs − t0Ms)/1000`。 */
interface AnchorFit {
  t0Ms: number
  slope: number
  intercept: number
}

/**
 * anchor サンプル列の最小二乗フィットを計算する（#389 機構 B）。
 * サンプルが 2 点未満、分散ゼロ、または傾きが正気でない（wall↔device の
 * レート差は ppm 級のはずで、[0.95, 1.05] を外れる値は窓の汚染 — デバイス
 * 切替や stream 停止跨ぎ — を示す）場合は null（呼び出し側が単一 anchor に
 * フォールバック）。StreamStats 到着時（1Hz）にのみ呼ぶこと — dispatch の
 * ホットパスで毎回再計算する仕事ではない（窓はその間変わらない）。
 * export はテストのため（#389 機構 B の数値ロジックを直接検証する）。
 */
export function fitAnchorSamples(samples: readonly ClockAnchor[]): AnchorFit | null {
  const n = samples.length
  if (n < 2) return null
  const t0Ms = samples[0].tsMs
  let sumX = 0
  let sumY = 0
  for (const s of samples) {
    sumX += (s.tsMs - t0Ms) / 1000
    sumY += s.daemonSec
  }
  const meanX = sumX / n
  const meanY = sumY / n
  let sxx = 0
  let sxy = 0
  for (const s of samples) {
    const dx = (s.tsMs - t0Ms) / 1000 - meanX
    sxx += dx * dx
    sxy += dx * (s.daemonSec - meanY)
  }
  if (sxx <= 0) return null
  const slope = sxy / sxx
  if (slope <= 0.95 || slope >= 1.05) return null
  return { t0Ms, slope, intercept: meanY - slope * meanX }
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
  /** WebSocket を使わず protocol/event 境界を検証するための注入 seam。@internal */
  daemonClient?: DaemonClient
  /**
   * 各 dispatch の観測コールバック（任意・副作用なしの telemetry seam）。A0 の実機
   * timing 計測 spec が lead/drift を読むのに使う。`createAudioEngine()` の production
   * 経路では渡さない（hook 無しが既定）。production で常用するなら factory へ昇格する。
   */
  onDispatch?: (info: DispatchInfo) => void
}

const DEFAULT_LOOKAHEAD_SEC = 0.05
const PLUGIN_UI_OPEN_TIMEOUT_MS = 30_000
const PLUGIN_UI_CLOSE_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 1
/** SC EventScheduler と同じく、過大 drift のイベントは古い残骸として skip する閾値。 */
const MAX_DRIFT_MS = 1000
/** daemon が死んだとき respawn を試みる最大回数。枯渇したら recovery を断念し poll を止める。 */
const MAX_RESPAWN_ATTEMPTS = 5
/** respawn 試行間の固定バックオフ（crash loop 緩和 + port 解放待ち）。 */
const RESPAWN_BACKOFF_MS = 150

/**
 * feature gap warning の抑止キー集合（フィールド初期化子で arm・stopAll で再 arm）。
 * キーは `kind` または `kind:discriminator`。#542 レビュー: `pluginInactive` は instance ごとに
 * 独立して警告する必要がある（単一 boolean だと最初の1台の警告以降、別 instrument の
 * note ドロップが session 終端まで無警告になる）ため、Record<GapKind, boolean> から
 * 判別子付き Set へ変更した。
 */
const freshWarned = (): Set<string> => new Set()

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
  /**
   * daemon crash 後に replay する宣言 intent。key = `${role}:${bus ?? ''}` — master
   * effect/instrument はそれぞれ単一 slot（各 manager が上流で保証）、per-sequence
   * insert（`seq.effect()`・#434 S3）は bus ごとに 1 エントリなので Map で保持する。
   */
  private readonly loadedPlugins = new Map<
    string,
    {
      filePath: string
      pluginId?: string
      role: 'effect' | 'instrument'
      bus?: string
      instance?: string
      statePath?: string
    }
  >()
  /** Last committed effect rack per daemon bus; the empty string is the master receiver. */
  private readonly loadedEffectRacks = new Map<
    string,
    { bus: string | undefined; chain: EffectChainStageConfig[] }
  >()
  /**
   * Whether `loadedPlugin` is actually loaded in the daemon right now (silent-failure
   * guard). Set true on a successful `loadPlugin()`/reload, false when a post-respawn
   * reload fails — surfaced via `isPluginActive()` so `PluginEffectManager`'s idempotent
   * cache-hit path can detect a stale "success" and re-issue the load instead of
   * silently returning as if the plugin were still active.
   */
  /**
   * declaration key（`${role}:${bus ?? ''}`）ごとの active 状態。respawn 後の reload が
   * 一部だけ失敗した場合に、失敗した宣言だけを self-heal 対象にする（#461 review:
   * 単一 boolean だと健全な宣言まで再ロードされる）。
   */
  private readonly pluginActiveByKey = new Map<string, boolean>()
  /**
   * seq bus ごとの「最後に意図した routing」（MX.4 M3）。daemon respawn 後に
   * `reapplyBusRoutingAfterRespawn` が全 entry を再発行する（新 daemon の routing atomics は
   * 既定値に戻るため、replay しないと sum/aux routing が silent に素通しへ戻る）。
   */
  private readonly busRoutings = new Map<
    string,
    { output: string | undefined; sends: { bus: string; gain: number }[] }
  >()
  private clockAnchor: ClockAnchor = { tsMs: 0, daemonSec: 0 }
  /**
   * 直近の StreamStats anchor サンプル列（#389 機構 B・ANCHOR_WINDOW 参照）。
   * daemonNowSec() が 2 点以上あれば最小二乗フィットで推定する。respawn 時は
   * establishSession が空にする（新旧 daemon の transport を混ぜない）。
   */
  private anchorSamples: ClockAnchor[] = []
  /**
   * anchorSamples の最小二乗フィットのキャッシュ。窓が変わるのは onStreamStats
   * （1Hz）だけなので、そこで一度だけ再計算する — daemonNowSec()（dispatch
   * ホットパス・毎発音）は O(1) 読み出しで済む。null = 窓が薄い/汚染 →
   * 単一 anchor フォールバック。
   */
  private anchorFit: AnchorFit | null = null

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

  /** UI event は daemon の evt_seq 順を保ったまま、保存・ack まで直列に完結させる。 */
  private pluginUiEventTail: Promise<void> = Promise.resolve()
  private pluginUiSafepointSaver: ((target: PluginUiTarget) => Promise<void>) | undefined
  private readonly pendingPluginUiCloses = new Set<PendingPluginUiClose>()

  /** feature gap の 1 回限り warning。stopAll で再 arm する。 */
  private warned: Set<string> = freshWarned()

  constructor(options: RustEnginePlayerOptions = {}) {
    this.daemon = options.daemonClient ?? new DaemonClient()
    this.daemonPath = options.daemonPath
    this.wsUrlOverride = options.wsUrlOverride
    this.lookaheadSec = options.lookaheadSec ?? DEFAULT_LOOKAHEAD_SEC
    this.onDispatch = options.onDispatch
    // daemon の予期せぬ死を supervise する（recovery floor / #300）。意図的 quit は DaemonClient が
    // intentionalClose で抑制するので、このリスナは crash（panic→exit / segfault / kill）のみ発火する。
    this.daemon.on('daemon-died', this.onDaemonDied)
    this.daemon.on('plugin-ui-closed', this.onPluginUiClosed)
    this.daemon.on('plugin-ui-close-done', this.onPluginUiCloseDone)
    this.daemon.on('plugin-ui-closed-by-respawn', this.onPluginUiClosedByRespawn)
  }

  // --- AudioEngine surface ---

  /** StreamStats(1Hz) の transport now_sec で anchor を前進補正する handler（audio/wall drift 吸収）。 */
  private readonly onStreamStats = (data: unknown): void => {
    const nowSec = Number((data as { now_sec?: unknown }).now_sec)
    if (Number.isFinite(nowSec)) {
      const sample = { tsMs: Date.now(), daemonSec: nowSec }
      this.clockAnchor = sample
      // #389 機構 B: 回帰窓に積み、フィットをここで一度だけ再計算してキャッシュ
      // する（daemonNowSec は毎発音呼ばれるが、窓は 1Hz でしか変わらない）。
      this.anchorSamples.push(sample)
      if (this.anchorSamples.length > ANCHOR_WINDOW) {
        this.anchorSamples.shift()
      }
      const previousFit = this.anchorFit
      this.anchorFit = fitAnchorSamples(this.anchorSamples)
      // フォールバックの可視化: fit が棄却されると daemonNowSec は #389 修正前の
      // 単一 anchor 推定（量子化ヨレあり）に静かに落ちる。演奏中にヨレが戻った
      // とき、ログに手掛かりが無いと原因追跡が不可能になるので遷移端で必ず出す。
      if (previousFit && !this.anchorFit) {
        console.warn(
          '⚠️  [rust-engine] clock-anchor regression degraded — falling back to single-anchor estimate (window contaminated?); timing jitter may increase until it recovers',
        )
      } else if (!previousFit && this.anchorFit && this.anchorSamples.length > 2) {
        // length > 2 guard: boot/respawn 直後に 2 サンプル目で fit が初めて立つ
        // 通常経路では出さない（劣化からの復帰のみ知らせる）。
        console.log('✅ [rust-engine] clock-anchor regression recovered')
      }
    } else {
      // 不正な now_sec で anchor を凍結させると drift しうるので、無言にせず通知する。
      console.warn(
        '⚠️  [rust-engine] StreamStats missing a valid now_sec — clock anchor not updated:',
        data,
      )
    }
  }

  /**
   * daemon の非 fatal な WARNING（STREAM_XRUN / LINK_EGRESS_DROP 等）を operator に surface する。
   * daemon は 1 Hz ticker でこれらを `DaemonError` event として送るが、購読者が無いと void に消える。
   * fatal（DEVICE_LOST）は `daemon-died` 経路が別途扱う想定だが、ここでも message として残す。
   */
  private readonly onDaemonError = (data: unknown): void => {
    const { severity, code, message } = data as {
      severity?: string
      code?: string
      message?: string
    }
    const text = `[rust-engine] daemon-error [${severity ?? 'unknown'}] ${
      code ?? 'UNKNOWN'
    }: ${message ?? JSON.stringify(data)}`
    // fatal（DEVICE_LOST 等）は severity を保って console.error に出す（daemon-died 経路も別途
    // 扱うが、ticker 経由のこのレコードが warn に埋もれて見落とされないようにする）。
    if (severity === 'fatal') {
      console.error(`❌  ${text}`)
    } else {
      console.warn(`⚠️  ${text}`)
    }
  }

  /**
   * daemon を起動し WebSocket 接続を確立する。`outputDevice` は起動時 `--audio-device` として
   * daemon へ渡り、cpal device 名の**完全一致**で honor される（#484 D1）。一致しない場合は
   * daemon 側が stderr に警告して host 既定へ縮退する（起動は失敗しない）。ランタイム中の切替
   * （stream 再構築）は D2 scope・未実装。**一度だけ呼ぶ前提**（InterpreterV2 は isBooted で guard）。
   *
   * 順序が load-bearing: getStatus で初期 anchor を確定**してから** StreamStats を subscribe する。
   * 逆順だと、getStatus の await 中に届いた StreamStats（精緻な transport now_sec）を、後続の
   * getStatus(uptime_sec) が後退上書きしうる。先に初期 anchor を置けば StreamStats は常に前進補正。
   */
  async boot(outputDevice?: string): Promise<void> {
    await this.daemon.start({
      daemonPath: this.daemonPath,
      wsUrlOverride: this.wsUrlOverride,
      audioDevice: outputDevice,
    })
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
    // 回帰窓を破棄（#389 機構 B）: respawn 後の新 daemon の transport は 0 付近から
    // 再出発するので、旧 daemon のサンプルを混ぜるとフィットが壊れる。初期 anchor
    // （uptime_sec）は精度が別物なので窓には入れず、StreamStats のみを積む。
    this.anchorSamples = []
    this.anchorFit = null
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
    // daemon の WARNING（xrun / LinkAudio egress drop 等）を operator に届ける（無いと void に消える）。
    this.daemon.off('daemon-error', this.onDaemonError)
    this.daemon.on('daemon-error', this.onDaemonError)
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

  private enqueuePluginUiEvent(work: () => Promise<void> | void): void {
    this.pluginUiEventTail = this.pluginUiEventTail.then(work).catch((error) => {
      console.error(
        `[plugin-ui] event handling failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  private readonly onPluginUiClosed = (raw: unknown): void => {
    this.enqueuePluginUiEvent(async () => {
      const data = wireObject(raw, 'PluginUiClosed data')
      const target = pluginUiTargetFromEvent(data)
      const generation = eventNonNegativeInteger(data.generation, 'generation')
      const evtSeq = eventNonNegativeInteger(data.evt_seq, 'evt_seq')
      if (!this.pluginUiSafepointSaver) {
        throw new Error(
          `cannot save ${JSON.stringify(target)}: no project-state safepoint saver is registered`,
        )
      }
      try {
        await this.pluginUiSafepointSaver(target)
      } catch (error) {
        console.error(
          `[plugin-ui] safepoint save failed for ${JSON.stringify(target)}; ` +
            `AckUiSafepoint was not sent: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
      await this.daemon.ackUiSafepoint(pluginStateTarget(target), target.index, generation, evtSeq)
    })
  }

  private readonly onPluginUiCloseDone = (raw: unknown): void => {
    this.enqueuePluginUiEvent(() => {
      const data = wireObject(raw, 'PluginUiCloseDone data')
      const target = pluginUiTargetFromEvent(data)
      const completion = data.completion
      if (completion === 'timeout-without-save') {
        console.error(
          `[plugin-ui] ${JSON.stringify(target)} closed after timing out without saving state`,
        )
      } else if (completion !== 'safepoint-completed') {
        throw new Error(`unknown PluginUiCloseDone completion: ${String(completion)}`)
      }
      this.settlePendingPluginUiCloses(target, (pending) => pending.resolve(completion))
    })
  }

  /** respawn による UI クローズを Global の session 簿記へ伝えるリスナ（#619 R2）。 */
  private pluginUiClosedByRespawnListener?: (target: PluginUiTarget) => void

  setPluginUiClosedByRespawnListener(listener: (target: PluginUiTarget) => void): void {
    this.pluginUiClosedByRespawnListener = listener
  }

  private readonly onPluginUiClosedByRespawn = (raw: unknown): void => {
    this.enqueuePluginUiEvent(() => {
      const data = wireObject(raw, 'PluginUiClosedByRespawn data')
      const target = pluginUiTargetFromEvent(data)
      console.error(
        `[plugin-ui] ${JSON.stringify(target)} was closed by daemon respawn and was not reopened`,
      )
      // Global 側のセッション簿記を実態に揃える（残すと DSL ui() の冪等判定が
      // 「もう開いている」と誤認し、open が永久に no-op になる — #619 R2 Critical）。
      this.pluginUiClosedByRespawnListener?.(target)
      this.settlePendingPluginUiCloses(target, (pending) =>
        pending.reject(new Error('plugin UI was closed by daemon respawn before UI_CLOSED_DONE')),
      )
    })
  }

  /** target に一致する DONE 待ちを全て外し、timer を止めてから settle する（M7: DONE / respawn 共通）。 */
  private settlePendingPluginUiCloses(
    target: PluginUiTarget,
    settle: (pending: PendingPluginUiClose) => void,
  ): void {
    for (const pending of [...this.pendingPluginUiCloses]) {
      if (!pluginUiTargetMatches(pending.target, target)) continue
      this.pendingPluginUiCloses.delete(pending)
      clearTimeout(pending.timer)
      settle(pending)
    }
  }

  private async settlePluginUiEvents(): Promise<void> {
    for (;;) {
      const pending = this.pluginUiEventTail
      await pending
      if (pending === this.pluginUiEventTail) return
    }
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
          await this.reloadPluginsAfterRespawn()
          await this.reloadEffectRacksAfterRespawn()
          await this.reapplyBusRoutingAfterRespawn()
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
    this.daemon.off('daemon-error', this.onDaemonError)
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
    // CONTROL_QUIT の前に、既に受け取った UI close の保存・ack を完結させる。
    await this.settlePluginUiEvents()
    this.daemon.off('plugin-ui-closed', this.onPluginUiClosed)
    this.daemon.off('plugin-ui-close-done', this.onPluginUiCloseDone)
    this.daemon.off('plugin-ui-closed-by-respawn', this.onPluginUiClosedByRespawn)
    await this.daemon.quit()
  }

  setPluginUiSafepointSaver(saver: (target: PluginUiTarget) => Promise<void>): void {
    this.pluginUiSafepointSaver = saver
  }

  async openPluginUi(
    target: PluginStateSaveTarget,
    index: number,
    windowTitle: string,
    timeoutMs = PLUGIN_UI_OPEN_TIMEOUT_MS,
  ): Promise<void> {
    await withTimeout(
      this.daemon.openPluginUi(target, index, windowTitle),
      timeoutMs,
      `timed out waiting for plugin UI to open (${timeoutMs}ms)`,
    )
  }

  async closePluginUi(
    target: PluginStateSaveTarget,
    index: number,
    timeoutMs = PLUGIN_UI_CLOSE_TIMEOUT_MS,
  ): Promise<PluginUiCloseCompletion> {
    const routedTarget: PluginUiTarget = { ...target, index } as PluginUiTarget
    let pendingEntry: PendingPluginUiClose | undefined
    const done = new Promise<PluginUiCloseCompletion>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingEntry) this.pendingPluginUiCloses.delete(pendingEntry)
        reject(new Error(`timed out waiting for UI_CLOSED_DONE (${timeoutMs}ms)`))
      }, timeoutMs)
      pendingEntry = { target: routedTarget, resolve, reject, timer }
      this.pendingPluginUiCloses.add(pendingEntry)
    })
    try {
      // Register the DONE waiter before issuing CLOSE_UI: the event pump and
      // command response use independent tasks, so DONE may race the ack.
      const accepted = this.daemon.acceptClosePluginUi(target, index)
      await Promise.race([accepted, done.then(() => undefined)])
    } catch (error) {
      if (pendingEntry) {
        this.pendingPluginUiCloses.delete(pendingEntry)
        clearTimeout(pendingEntry.timer)
      }
      throw error
    }
    // The daemon response above is Phase A acceptance only. This await is the
    // sole close-completion condition exposed to callers.
    return done
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
   * cpal output device 一覧を daemon から取得する（#484 D1）。`AudioEngineBackend` の同期
   * `getAvailableDevices()`/`setAvailableDevices()` は SC 経路向けの既存 shape で rust 経路には
   * まだ配線されていない（S2 の既知ギャップ）— このメソッドはそれとは別に、daemon の非同期
   * `ListAudioDevices` RPC への直接の passthrough を提供する。
   */
  async listAudioDevices(): Promise<AudioDeviceListEntry[]> {
    return this.daemon.listAudioDevices()
  }

  /**
   * daemon プロセスを再起動せずに出力デバイスを切り替える（#484 D2）。`daemon.selectAudioDevice`
   * への薄い passthrough。切替中の短い無音ギャップは仕様として許容される。
   *
   * @returns 実際に適用されたデバイス名。
   */
  async selectAudioDevice(device: string): Promise<string> {
    return this.daemon.selectAudioDevice(device)
  }

  /**
   * LinkAudio チャンネル登録（#209・A4-2b-2）。daemon に登録を要求し、成功すればその channel に
   * tag された再生が LinkAudio egress 経由で送出される。daemon が feature `link-audio` 無効
   * ビルド（既定の permissive daemon）の場合は LINK_AUDIO_UNAVAILABLE で reject されるので、**throw せず**
   * 1 回 warn して継続する（channel は tag され続けるが出力は hardware のみ）。`scheduleEvent` /
   * `scheduleSliceEvent` と同じ `'outputChannel'` GapKind を共有し first-wins で 1 回だけ出す。
   */
  async registerLinkAudioChannel(channelName: string): Promise<void> {
    try {
      await this.daemon.registerLinkAudioChannel(channelName)
    } catch (err) {
      // 想定する gap は「egress がこの daemon で利用不可」= LINK_AUDIO_UNAVAILABLE のみ
      // （feature `link-audio` 無効ビルド / test backend）。これは scheduleEvent と同じ warn-once gap
      // として握り潰す（出力は hardware のみで継続）。それ以外（runtime 失敗の LINK_AUDIO_RUNTIME・
      // daemon 死亡・transport エラー等）は本物の失敗なので、feature-gap と誤ラベルせず rethrow する。
      if (err instanceof DaemonProtocolError && err.code === 'LINK_AUDIO_UNAVAILABLE') {
        this.warnOnce(
          'outputChannel',
          `⚠️  [rust-engine] LinkAudio channel "${channelName}": egress unavailable in this daemon (built without the link-audio feature) — channel is tagged but output is hardware only.`,
        )
        return
      }
      throw err
    }
  }

  async setLinkTempo(bpm: number): Promise<void> {
    try {
      await this.daemon.setLinkTempo(bpm)
    } catch (err) {
      if (err instanceof DaemonProtocolError && err.code === 'LINK_AUDIO_UNAVAILABLE') {
        this.warnOnce(
          'linkTempo',
          `⚠️  [rust-engine] setLinkTempo(${bpm}): Link テンポリードは daemon がビルドされていないため無効（feature link-audio 未ビルド）— tempo push はスキップされます。`,
        )
        return
      }
      throw err
    }
  }

  /**
   * Runtime mixer bus routing change (MX.4, #459/#453 M3). Unlike LinkAudio channel
   * registration, there is no hardware-bus fallback for a missing sum/aux target — the
   * daemon-side error (e.g. `UNSUPPORTED` on a non-`outproc-effect` build, or a kind/order
   * violation) is a real failure and propagates unchanged to the caller (`Sequence`'s
   * `output()`/`send()`, which log it via `console.warn` — see that file).
   */
  async setBusRouting(
    seqBus: string,
    output: string | undefined,
    sends: { bus: string; gain: number }[],
  ): Promise<void> {
    // Intent-first cache: transport failures (daemon mid-respawn, socket drop) keep the
    // intended routing so `reapplyBusRoutingAfterRespawn` restores it on the next daemon.
    // A definitive daemon-side rejection means the daemon state did NOT change, so the
    // cache reverts — otherwise every later respawn would replay a known-bad request.
    const prev = this.busRoutings.get(seqBus)
    this.busRoutings.set(seqBus, { output, sends })
    try {
      await this.daemon.setBusRouting(seqBus, output, sends)
    } catch (err) {
      if (err instanceof DaemonProtocolError) {
        if (prev) this.busRoutings.set(seqBus, prev)
        else this.busRoutings.delete(seqBus)
      }
      throw err
    }
  }

  /**
   * Re-issues the last intended `SetBusRouting` per seq bus after a daemon respawn — the
   * new daemon process starts with all `routing_override`/send atomics at their defaults,
   * so without this replay every sum/aux routing silently reverts to plain per-sequence
   * output (audio quietly goes to the wrong place). Mirrors `reloadPluginsAfterRespawn`:
   * per-entry independent failure handling, and a failure must not fail the respawn itself.
   */
  private async reapplyBusRoutingAfterRespawn(): Promise<void> {
    for (const [seqBus, { output, sends }] of this.busRoutings.entries()) {
      try {
        await this.daemon.setBusRouting(seqBus, output, sends)
      } catch (err) {
        // Cache entry intentionally remains: a later daemon respawn retries restoration.
        console.error(
          `❌ [rust-engine] failed to restore bus routing after daemon respawn (bus=${seqBus})`,
          err,
        )
      }
    }
  }

  /**
   * Loads a plugin into the daemon's master effect insert. Converts daemon-side
   * `DaemonProtocolError`s into operator-actionable messages (CLAP_UNAVAILABLE →
   * build hint, other codes → generic wrap); non-protocol errors pass through
   * unchanged.
   */
  /**
   * 宣言 cache / active flag のキー。effect は bus、instrument は instance が第2成分
   * （#540 P1 — instrument slot pool の宛先が bus ではなく instance のため）。
   */
  private static pluginKey(role: 'effect' | 'instrument', bus?: string, instance?: string): string {
    return role === 'instrument' ? `instrument:${instance ?? ''}` : `effect:${bus ?? ''}`
  }

  private static warningKey(kind: GapKind, discriminator?: string): string {
    return discriminator === undefined ? kind : `${kind}:${discriminator}`
  }

  /** Mark one declaration inactive and re-arm its once-per-inactivation note-drop warning. */
  private markPluginInactive(key: string, role: 'effect' | 'instrument', instance?: string): void {
    this.pluginActiveByKey.set(key, false)
    if (role === 'instrument') {
      this.warned.delete(RustEnginePlayer.warningKey('pluginInactive', instance ?? 'default'))
    }
  }

  /** Forget a declaration and its active flag entirely; distinct from marking it inactive. */
  private forgetPluginLedger(key: string): void {
    this.loadedPlugins.delete(key)
    this.pluginActiveByKey.delete(key)
  }

  async loadPlugin(
    filePath: string,
    pluginId: string | undefined,
    role: 'effect' | 'instrument',
    bus?: string,
    instance?: string,
    statePath?: string,
  ): Promise<PluginLoadResult> {
    const key = RustEnginePlayer.pluginKey(role, bus, instance)
    try {
      const result = await this.daemon.loadPlugin(
        filePath,
        pluginId,
        role,
        bus,
        instance,
        statePath,
      )
      this.loadedPlugins.set(key, { filePath, pluginId, role, bus, instance, statePath })
      this.pluginActiveByKey.set(key, true)
      return result
    } catch (err) {
      // 失敗時は必ず false（呼び出し元の false-on-entry 保証に依存しない）
      this.markPluginInactive(key, role, instance)
      if (err instanceof DaemonProtocolError) {
        if (err.code === 'CLAP_UNAVAILABLE') {
          throw new Error(
            `Plugin hosting is unavailable in this daemon build; a --features clap-host build is required: ${err.message}`,
          )
        }
        throw new Error(`Failed to load plugin: ${err.message}`)
      }
      throw err
    }
  }

  async replacePlugin(
    filePath: string,
    pluginId: string | undefined,
    role: 'effect' | 'instrument',
    bus?: string,
    instance?: string,
    statePath?: string,
  ): Promise<PluginReplaceResult> {
    const key = RustEnginePlayer.pluginKey(role, bus, instance)
    try {
      const result = await this.daemon.replacePlugin(
        filePath,
        pluginId,
        role,
        bus,
        instance,
        statePath,
      )
      this.loadedPlugins.set(key, { filePath, pluginId, role, bus, instance, statePath })
      this.pluginActiveByKey.set(key, true)
      return result
    } catch (err) {
      // Effect replacement may fail after teardown, even when the daemon returns
      // a protocol error. Forget both ledgers for every effect error so respawn
      // cannot replay the old tenant. Instrument keeps its established behavior:
      // definitive protocol rejection retains the old tenant, while an ambiguous
      // transport failure forgets it.
      if (role === 'effect') {
        this.forgetPluginLedger(key)
      } else if (!(err instanceof DaemonProtocolError)) {
        this.loadedPlugins.delete(key)
        this.markPluginInactive(key, role, instance)
      }
      throw err
    }
  }

  async unloadPlugin(role: 'effect', bus?: string): Promise<PluginUnloadResult> {
    const key = RustEnginePlayer.pluginKey(role, bus)
    try {
      return await this.daemon.unloadPlugin(role, bus)
    } finally {
      // The daemon may have completed teardown before the response was lost.
      // Forget both ledgers on every outcome so respawn cannot replay the removed tenant.
      this.forgetPluginLedger(key)
    }
  }

  async applyEffectChain(request: EffectChainApplyRequest): Promise<EffectChainApplyResult> {
    const key = request.bus ?? ''
    const previous = this.loadedEffectRacks.get(key)?.chain ?? []
    const next = request.chain.map((operation): EffectChainStageConfig => {
      if (operation.op === 'load') {
        if (operation.kind === 'catalog') {
          return {
            kind: 'catalog',
            path: operation.path,
            ...(operation.plugin_id === undefined ? {} : { plugin_id: operation.plugin_id }),
            ...(operation.state === undefined ? {} : { state: operation.state }),
            enabled: operation.enabled,
          }
        }
        return {
          kind: 'standard',
          name: operation.name,
          params: { ...operation.params },
          enabled: operation.enabled,
        }
      }
      const kept = previous[operation.prev_index]
      if (!kept) {
        throw new Error(
          `Effect rack ledger has no previous stage at index ${operation.prev_index}; rebuild is required.`,
        )
      }
      return kept.kind === 'catalog'
        ? { ...kept, enabled: operation.enabled }
        : {
            ...kept,
            params: { ...(operation.params ?? kept.params) },
            enabled: operation.enabled,
          }
    })
    try {
      const result = await this.daemon.applyEffectChain(request)
      this.loadedEffectRacks.set(key, { bus: request.bus, chain: next })
      this.forgetPluginLedger(RustEnginePlayer.pluginKey('effect', request.bus))
      return result
    } catch (error) {
      if (!(error instanceof DaemonProtocolError)) this.loadedEffectRacks.delete(key)
      throw error
    }
  }

  async savePluginState(
    target: import('../types').PluginStateSaveTarget,
    absolutePath: string,
  ): Promise<import('../types').PluginStateSaveResult> {
    const saved = await this.daemon.savePluginState(target, absolutePath)
    const key = RustEnginePlayer.pluginKey(
      target.role,
      target.role === 'effect' ? target.bus : undefined,
      target.role === 'instrument' ? target.instance : undefined,
    )
    const cached = this.loadedPlugins.get(key)
    if (cached && saved.bytesWritten > 0) cached.statePath = saved.path
    if (target.role === 'effect' && saved.bytesWritten > 0) {
      const rackKey = target.bus ?? ''
      const rack = this.loadedEffectRacks.get(rackKey)
      const index = target.chainPath?.[0] ?? 0
      const stage = rack?.chain[index]
      if (rack && stage?.kind === 'catalog') {
        rack.chain[index] = { ...stage, state: saved.path }
      }
    }
    return saved
  }

  pluginNoteOn(key: number, channel: number, velocity: number, instance?: string): Promise<void> {
    if (!this.daemon.isRunning()) {
      this.warnOnce(
        'pluginNoteDrop',
        '⚠️  [rust-engine] plugin note-on/off dropped: daemon is not connected (notes will be silently dropped until reconnect)',
      )
      return Promise.resolve()
    }
    if (
      this.pluginActiveByKey.get(RustEnginePlayer.pluginKey('instrument', undefined, instance)) !==
      true
    ) {
      this.warnOnce(
        'pluginInactive',
        `⚠️  [rust-engine] plugin note-on/off dropped for instrument '${instance ?? 'default'}': not restored after a daemon respawn, or its last replacement ended with an uncertain transport result — re-run seq.instrument(...) to restore it`,
        instance ?? 'default',
      )
      return Promise.resolve()
    }
    // Ordering contract: do not insert an await before this call. Daemon requests are
    // processed sequentially, so synchronous WebSocket send order is musical note order.
    return this.daemon.pluginNoteOn(key, channel, velocity, instance)
  }

  pluginNoteOff(key: number, channel: number, velocity?: number, instance?: string): Promise<void> {
    if (!this.daemon.isRunning()) {
      this.warnOnce(
        'pluginNoteDrop',
        '⚠️  [rust-engine] plugin note-on/off dropped: daemon is not connected (notes will be silently dropped until reconnect)',
      )
      return Promise.resolve()
    }
    if (
      this.pluginActiveByKey.get(RustEnginePlayer.pluginKey('instrument', undefined, instance)) !==
      true
    ) {
      this.warnOnce(
        'pluginInactive',
        `⚠️  [rust-engine] plugin note-on/off dropped for instrument '${instance ?? 'default'}': not restored after a daemon respawn, or its last replacement ended with an uncertain transport result — re-run seq.instrument(...) to restore it`,
        instance ?? 'default',
      )
      return Promise.resolve()
    }
    // Keep the synchronous send ordering contract documented above: no await here.
    return this.daemon.pluginNoteOff(key, channel, velocity, instance)
  }

  /**
   * Re-issues the last successful plugin declaration after a daemon respawn (the
   * new daemon process starts with no plugins loaded). Broad catch is intentional:
   * a reload failure is this plugin's own concern, not the respawn's — it must not
   * make `respawnLoop` treat an otherwise-successful respawn as failed. Cache entry
   * intentionally remains on failure so a later respawn retries restoration, and
   * `pluginActive` flips false so `PluginEffectManager` can detect the stale cache
   * (see `pluginActive` field doc) and self-heal on the next `effect()` call.
   */
  private async reloadPluginsAfterRespawn(): Promise<void> {
    if (this.loadedPlugins.size === 0) return
    // Reissue every declaration (master effect/instrument + all seq.effect() buses).
    // One entry's failure must not skip the others — each is independent daemon state.
    for (const [
      key,
      { filePath, pluginId, role, bus, instance, statePath },
    ] of this.loadedPlugins.entries()) {
      try {
        await this.daemon.loadPlugin(filePath, pluginId, role, bus, instance, statePath)
        this.pluginActiveByKey.set(key, true)
      } catch (err) {
        // Cache entry intentionally remains: a later daemon respawn retries restoration.
        // per-key の false 化により、self-heal は失敗した宣言だけを再ロードする（#461 review）。
        this.markPluginInactive(key, role, instance)
        console.error(
          `❌ [rust-engine] failed to reload plugin after daemon respawn: ${filePath}` +
            (bus ? ` (bus=${bus})` : ''),
          err,
        )
      }
    }
  }

  private async reloadEffectRacksAfterRespawn(): Promise<void> {
    for (const { bus, chain } of this.loadedEffectRacks.values()) {
      try {
        await this.daemon.applyEffectChain({
          ...(bus === undefined ? {} : { bus }),
          mode: 'rebuild',
          chain: chain.map((stage) => ({ op: 'load' as const, ...stage })),
          saveDropped: [],
        })
      } catch (error) {
        console.error(
          `❌ [rust-engine] failed to restore effect rack after daemon respawn${
            bus === undefined ? ' (master)' : ` (bus=${bus})`
          }`,
          error,
        )
      }
    }
  }

  /** Whether `loadedPlugin` is actually active in the daemon right now (see field doc). */
  isPluginActive(role?: 'effect' | 'instrument', bus?: string, instance?: string): boolean {
    // 引数なし = 全宣言が active か（後方互換・boolean AND）。role/bus/instance 指定 = 該当宣言のみ。
    if (role !== undefined) {
      return this.pluginActiveByKey.get(RustEnginePlayer.pluginKey(role, bus, instance)) !== false
    }
    for (const active of this.pluginActiveByKey.values()) {
      if (!active) return false
    }
    return this.pluginActiveByKey.size > 0
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
    argPath?: string,
    insertBus?: string,
  ): void {
    // outputChannel の feature-gap signal は `registerLinkAudioChannel`（`sequence.output()` 経由）が
    // authoritative に出す（A4-2b-2b で egress 配線済み）。scheduleEvent は channel を tag するだけで、
    // 「egress is not wired」の旧 warn は stale なので出さない（egress 有効な daemon では誤誘導になる）。
    // pan は daemon PlayAt で実装済み（#304・equal-power = SC Pan2 一致）。発火時に
    // executePlayback が DSL の -100..100 を daemon の [-1,1] へ変換して送る。
    this.enqueue({ time, filepath, gainDb, pan, sequenceName, outputChannel, argPath, insertBus })
  }

  /**
   * chop の slice を領域再生（offset/duration の切り出し + varispeed rate）でスケジュールする
   * （#304 領域・#319 varispeed）。
   *
   * slice 領域（offset/長さ）はサンプル尺に依存するが、daemon の load は lazy（初回発火時）
   * のため、領域と rate は `executePlayback`（`resolveSliceRegion`）で load 完了後に計算する。
   * ここでは slice 仕様（index/total/eventDurationMs）だけ保持する。
   *
   * rate≠1.0（slice 尺をイベントスロット尺へ詰める）は `rate = sliceDuration / eventSlotDuration`
   * で varispeed 発音（SC `PlayBuf.ar(rate:)` 一致・ピッチも動く）。per-slice gain は各 slice の
   * gainDb がそのまま効く。pitch-preserving な time-stretch（fixpitch/time）は別物で #213 へ defer。
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
    argPath?: string,
    insertBus?: string,
  ): void {
    // outputChannel の feature-gap signal は `registerLinkAudioChannel` が authoritative（上記
    // scheduleEvent と同様・egress 配線済みなので stale な「not wired」warn は出さない）。
    this.enqueue({
      time,
      filepath,
      gainDb,
      pan,
      sequenceName,
      slice: { index: sliceIndex, total: totalSlices, eventDurationMs },
      outputChannel,
      argPath,
      insertBus,
    })
  }

  /**
   * #390 live playhead: 休符 (0) スロットの marker-only イベント（Scheduler optional 面）。
   * 音は出さず、発火タイミングで `[STEP]` だけ stdout へ出す。gainDb は同スロットの
   * 音イベントと同じ mute/master 合成値 — mute 中のシーケンスは音と同様に marker も
   * skip される（executePlayback の amplitude ガードを共有）。
   */
  scheduleStepMarker(time: number, sequenceName: string, argPath: string, gainDb: number): void {
    this.enqueue({ time, filepath: '', gainDb, pan: 0, sequenceName, argPath, markerOnly: true })
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
      void this.daemon.stopAll().catch((err) => {
        // 接続喪失（DaemonConnectionError / DaemonQuitError）は想定内 — 死んだ / 終了中の
        // daemon に stop は不要なので静かに drop。それ以外（例: scheduler mutex poisoned 由来の
        // DaemonProtocolError）は daemon の実不具合を示すので握り潰さず可視化する
        // （onPlaybackError と同じ判別方針）。
        if (err instanceof DaemonConnectionError || err instanceof DaemonQuitError) return
        console.warn('⚠️  [rust-engine] stopAll() failed unexpectedly:', err)
      })
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

  /**
   * #390 live playhead: machine-readable step marker for the editor extension.
   * The epoch ms is the event's GRID time (startTime + play.time — the same
   * base the drift check uses), NOT "now": dispatch runs lookahead-early, so
   * the extension delays the decoration until this timestamp. Actual audio
   * lands ~lookaheadSec (50ms) after the grid time — a uniform constant shift
   * across all sequences, so the playhead stays mutually consistent. Rounded
   * because play.time can be fractional (bar subdivision) and the marker
   * grammar keeps integers.
   */
  private emitStepMarker(play: ScheduledPlay): void {
    if (play.sequenceName && play.argPath !== undefined) {
      console.log(
        `[STEP] ${play.sequenceName} ${play.argPath} ${Math.round(this.startTime + play.time)}`,
      )
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

    // #390: 休符 (0) スロットの marker-only イベント。daemon dispatch は行わず
    // marker だけ出して終わる（上の amplitude ガードを通過している = mute されて
    // いないシーケンスのみ。音イベントとの一貫性）。filepath は空なので
    // ensureLoaded より前に抜けること。
    if (play.markerOnly) {
      this.emitStepMarker(play)
      return
    }

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
      play.outputChannel,
      play.insertBus,
    )
    // #390 live playhead: emitted only after a successful dispatch (emission-only
    // — no timing / semantics change).
    this.emitStepMarker(play)
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

  /**
   * TS wall clock から daemon transport now_sec を推定する（dispatch ホットパス）。
   *
   * onStreamStats がキャッシュした最小二乗フィット（#389 機構 B — 単一 anchor では
   * StreamStats のブロック量子化 ±10.7ms がそのまま発音時刻に転写されていた。詳細は
   * ANCHOR_WINDOW / fitAnchorSamples のコメント）を O(1) で評価する。フィットが無い間
   * （boot 直後 / respawn 直後 / 窓の汚染）は従来の「最新 anchor + 経過時間」に落ちる。
   */
  private daemonNowSec(): number {
    const fit = this.anchorFit
    if (fit) {
      return fit.intercept + fit.slope * ((Date.now() - fit.t0Ms) / 1000)
    }
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

  private warnOnce(kind: GapKind, message: string, discriminator?: string): void {
    const key = RustEnginePlayer.warningKey(kind, discriminator)
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn(message)
  }
}
