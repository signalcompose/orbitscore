import * as fs from 'fs'
import * as path from 'path'

import {
  analyzeWavBuffer,
  type WavAnalysis,
} from '../../../packages/vscode-extension/src/wav-analysis'

const CAPTURE_HEADER_BYTES = 44
const BYTES_PER_SAMPLE = 4
export const ANALYSIS_BUCKET_MS = 20
const ANALYSIS_BUCKET_SEC = ANALYSIS_BUCKET_MS / 1000
const DEFAULT_GUARD_SEC = 0.15
const AUDIBLE_FLOOR_RMS = 0.01
const CLOCK_WALL_TOLERANCE_SEC = 0.12
const BUCKET_COUNT_TOLERANCE = 2
const BUCKET_WIDTH_TOLERANCE_SEC = 1e-9

export interface CaptureSegment {
  fromSec: number
  toSec: number
  fromWall: number
  toWall: number
  /** 直前の区間へ意図的に食い込む境界プローブ（#643 E2E-3）。既定は false。 */
  overlapsPrevious?: boolean
}

export interface CaptureWindows {
  readonly analysis: WavAnalysis
  readonly capturePath: string
  rms(segment: string, guardSec?: number): number
  windows(
    segment: string,
    guardSec?: number,
  ): ReadonlyArray<{ startSec: number; peak: number; rms: number }>
  onsets(segment: string): readonly number[]
  channelRms(segment: string, channel: number, guardSec?: number): number
}

export interface CaptureFormat {
  readonly sampleRate: number
  readonly channels: number
}

/**
 * capture を書き出す直前の準備 — **ディレクトリを作り、前回の残骸を消す**。
 *
 * 🔴 ディレクトリが無いと daemon の capture writer（`File::create`）が失敗し、
 * **エンジンの起動そのものが落ちる**:
 *   `DEVICE_CONFIG_ERROR "audio output init failed: capture writer error: No such file or directory"`
 * テスト側にはこれが「daemon-backed REPL ready after 30000ms」という**無関係に見える
 * タイムアウト**として現れる。2026-09-05 に `ORBIT_KEEP_CAPTURES` へ未作成のディレクトリを
 * 渡して実機 gated 1 回分（約 8 分）を失った。
 *
 * 🔴 `captureWavPath` 側では作らない。あちらは純粋なパス解決で、ユニットテストが
 * リテラルパスを渡すので、副作用を持たせると実ディレクトリを作ってしまう。
 */
export function prepareCapturePath(capturePath: string): void {
  fs.mkdirSync(path.dirname(capturePath), { recursive: true })
  fs.rmSync(capturePath, { force: true })
}

/**
 * 解析が「header が申告する長さ」ではなく **実バイト全体** を見るようにする。
 *
 * capture writer が header を patch する間隔は固定 96,000 interleaved samples
 * （48 kHz stereo なら約 1 秒、mono なら約 2 秒）。区間はバイト長で刻んでいるため、
 * 申告サイズを物理バイトへ揃えないと **末尾の区間が解析範囲の外に落ちる**
 * （#739 実機で 6 件が誤検知した）。
 *
 * 🔴 これは単なる異常終了時の保険ではない。通常の client 停止も SIGTERM だが daemon には
 * signal handler が無く、`CaptureWriter::Drop` → `finalize` は走らない。そのため capture を
 * 区間解析する全経路でこの零化が必要になる（#448 の graceful-shutdown は別 issue）。
 */
export function readCaptureForAnalysis(capturePath: string): Buffer {
  const capture = fs.readFileSync(capturePath)
  if (capture.toString('ascii', 36, 40) !== 'data') {
    throw new Error(`${capturePath}: expected fixed 44-byte capture WAV data chunk at byte 36`)
  }
  capture.writeUInt32LE(0, 40)
  return capture
}

/** Read and validate the daemon capture seam's fixed 44-byte float32 WAV header. */
export function readCaptureFormat(capturePath: string): CaptureFormat {
  const header = Buffer.alloc(CAPTURE_HEADER_BYTES)
  const fd = fs.openSync(capturePath, 'r')
  try {
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0)
    if (bytesRead !== CAPTURE_HEADER_BYTES) {
      throw new Error(`${capturePath}: expected a 44-byte capture header, read ${bytesRead}`)
    }
  } finally {
    fs.closeSync(fd)
  }
  const audioFormat = header.readUInt16LE(20)
  const channels = header.readUInt16LE(22)
  const sampleRate = header.readUInt32LE(24)
  const bitsPerSample = header.readUInt16LE(34)
  if (
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE' ||
    header.toString('ascii', 12, 16) !== 'fmt ' ||
    header.toString('ascii', 36, 40) !== 'data' ||
    audioFormat !== 3 ||
    bitsPerSample !== 32 ||
    channels < 1 ||
    sampleRate < 1
  ) {
    throw new Error(
      `${capturePath}: expected fixed 44-byte IEEE float32 capture WAV, got ` +
        JSON.stringify({ audioFormat, bitsPerSample, channels, sampleRate }),
    )
  }
  return { sampleRate, channels }
}

/** Current capture time, using bytes already visible in the capture file as the clock. */
export function captureClockSec(capturePath: string, format: CaptureFormat): number {
  const size = fs.statSync(capturePath).size
  if (size < CAPTURE_HEADER_BYTES) {
    throw new Error(`${capturePath}: capture is shorter than its 44-byte header (size=${size})`)
  }
  return (size - CAPTURE_HEADER_BYTES) / (format.channels * BYTES_PER_SAMPLE) / format.sampleRate
}

/**
 * capture のバイト長を秒として読む時計。**format は 1 回だけ読んで使い回す。**
 *
 * 同じ 4 行のクロージャが 5 箇所に写されていた（`runScore` と gated spec の 4 シナリオ）。
 * 待ち方（初回の区間で遅延して待つ / シナリオ上の特定の時点で待つ）は場所ごとに本当に違うので
 * そこは畳まないが、**この時計だけは完全に同一**なのでここに置く。
 *
 * 副作用として `runScore` の `captureFormat!`（非 null アサーション 2 箇所）が消える。
 */
export function createCaptureClock(capturePath: string): () => number {
  let format: CaptureFormat | undefined
  return (): number => {
    format ??= readCaptureFormat(capturePath)
    return captureClockSec(capturePath, format)
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until an absolute-RMS bucket proves that the capture has started producing sound. */
export async function waitForSound(
  capturePath: string,
  opts: { floor: number; intervalMs: number; timeoutMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs
  let durationSec = 0
  let peak = 0
  let maxWindowRms = 0
  let size = -1
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      size = fs.statSync(capturePath).size
      if (size >= CAPTURE_HEADER_BYTES) {
        const analysis = analyzeWavBuffer(readCaptureForAnalysis(capturePath), { windowMs: 20 })
        durationSec = analysis.durationSec
        peak = analysis.peak
        maxWindowRms = (analysis.windows ?? []).reduce(
          (maximum, window) => (window.rms > maximum ? window.rms : maximum),
          0,
        )
        if ((analysis.windows ?? []).some((window) => window.rms >= opts.floor)) return
      }
    } catch (error) {
      lastError = error
      // The writer may not have created or completed the fixed header yet. Retry until timeout.
    }
    await delay(opts.intervalMs)
  }
  throw new Error(
    `${opts.label}: timed out waiting for capture sound ` +
      JSON.stringify({
        durationSec,
        peak,
        maxWindowRms,
        'stat.size': size,
        capturePath,
        lastError: lastError === undefined ? undefined : String(lastError),
      }),
  )
}

/**
 * キャプチャの**末尾**が可聴になるまで待つ（譜面の途中で鳴らし直すシナリオ用）。
 *
 * 🔴 `waitForSound` はファイル全体を見るので、**一度でも鳴った後は即座に返る**。
 * `stop()` → `LOOP()` のように途中で鳴らし直す譜面では、次の小節境界まで鳴らないのに
 * 窓が開いてしまい、区間の半分以上が無音になる。2026-09-05 に実機で計測した #643 E2E-2:
 *
 * ```
 * 5.78 – 7.08s  silent (1.30s)   ← dry.stop() → LOOP(wet) の量子化待ち
 * 7.08 – 8.02s  SOUND  0.0899    ← wet（比 0.501 = -6 dB ちょうど。実装は正しい）
 * ```
 *
 * 窓は 6.2s から開いていたので 85 窓中 46 窓しか可聴でなかった。**固定 settle では追えない**
 * （小節境界までの残り時間は評価のタイミング次第で 0〜1 小節ぶん変わる）。
 *
 * 手順は 2 段階:
 *
 * 1. **末尾が静かになるまで待つ**（前の LOOP が実際に止まったことの確認）。
 *    `quietTimeoutMs` 以内に静かにならなければ**そのまま次へ進む** — 切れ目なく次の音が
 *    続く譜面では静寂が来ないのが正しいので、ここで失敗させない
 * 2. **末尾が可聴になるまで待つ**
 *
 * `quietSec` は LOOP の小節境界にできる短い切れ目（実測 80 ms）より十分長く取ること。
 * 短いと段階 1 がその切れ目で成立してしまい、鳴り直しを待たずに返る。
 */
export async function waitForSoundRestart(
  capturePath: string,
  opts: {
    floor: number
    /** 「静か」と判定する末尾の長さ。LOOP の小節境界の切れ目（実測 80 ms）より長く。 */
    quietSec: number
    intervalMs: number
    /** 段階 1 の上限。超えたら静寂を待たずに段階 2 へ進む（失敗にしない）。 */
    quietTimeoutMs: number
    /** 段階 2 の上限。超えたら失敗。 */
    timeoutMs: number
    label: string
  },
): Promise<{ quietObserved: boolean }> {
  const tailWindows = (tailSec: number): Array<{ startSec: number; rms: number }> => {
    if (fs.statSync(capturePath).size < CAPTURE_HEADER_BYTES) return []
    const analysis = analyzeWavBuffer(readCaptureForAnalysis(capturePath), { windowMs: 20 })
    const windows = analysis.windows ?? []
    const from = analysis.durationSec - tailSec
    return windows.filter((window) => window.startSec >= from)
  }

  let quietObserved = false
  const quietDeadline = Date.now() + opts.quietTimeoutMs
  while (Date.now() <= quietDeadline) {
    try {
      const tail = tailWindows(opts.quietSec)
      if (tail.length > 0 && tail.every((window) => window.rms < opts.floor)) {
        quietObserved = true
        break
      }
    } catch {
      // writer がヘッダを書き終える前など。次の周回で読み直す。
    }
    await delay(opts.intervalMs)
  }

  const deadline = Date.now() + opts.timeoutMs
  let lastTailMax = 0
  while (Date.now() <= deadline) {
    try {
      const tail = tailWindows(0.1)
      lastTailMax = tail.reduce((maximum, window) => Math.max(maximum, window.rms), 0)
      if (lastTailMax >= opts.floor) return { quietObserved }
    } catch {
      // 同上
    }
    await delay(opts.intervalMs)
  }
  throw new Error(
    `${opts.label}: timed out waiting for the capture to sound again ` +
      JSON.stringify({ quietObserved, lastTailMax, floor: opts.floor, capturePath }),
  )
}

/**
 * `waitForSoundRestart` を既定値つきで束ねたクロージャを作る。
 *
 * 🔴 呼び出し側（`run-score.ts` と gated spec）が同じ 5 つの定数を verbatim で持っていたので
 * 集約した。可変なのはラベルだけ。`quietSec` を調整する時に 2 箇所を同期させ続けなくてよい。
 */
export function makeAwaitSoundRestart(
  capturePath: string,
  labelPrefix: string,
): (label?: string) => Promise<void> {
  return async (label?: string): Promise<void> => {
    await waitForSoundRestart(capturePath, {
      floor: 0.01,
      // LOOP の小節境界にできる切れ目は実測 80 ms。それより十分長く取る。
      quietSec: 0.3,
      intervalMs: 100,
      quietTimeoutMs: 4_000,
      timeoutMs: 20_000,
      label: `${labelPrefix}${label === undefined ? '' : ` (${label})`}`,
    })
  }
}

/** Quadratic mean of RMS buckets; preserves signal energy across bucket boundaries. */
export function quadraticMeanRms(windows: ReadonlyArray<{ readonly rms: number }>): number {
  if (windows.length === 0) throw new Error('quadraticMeanRms requires at least one window')
  return Math.sqrt(
    windows.reduce((sum, window) => sum + window.rms * window.rms, 0) / windows.length,
  )
}

export interface SteadyRmsRequirements {
  readonly expectedOnsets: number
  readonly guardSec: number
  readonly hitPeriodSec: number
  readonly audibleFloorRms: number
}

/**
 * Nominal analysis-bucket index for a time value from either float family (#746 C-1).
 *
 * `analysis.onsets` (`wav-analysis.ts`'s `w * WINDOW_SEC`) and `analysis.windows[].startSec`
 * (`wav-analysis.ts`'s `start / format.sampleRate`) are two independent floating-point
 * derivations of the same nominal `index * 20ms` value. Their rounding errors differ by a
 * handful of ULPs, which is invisible on its own but flips `>=`/`<` boundary comparisons
 * depending on capture phase. Rounding each time back to its bucket index before comparing
 * removes the float family entirely from the comparison.
 */
function toBucketIndex(sec: number): number {
  return Math.round(sec / ANALYSIS_BUCKET_SEC)
}

interface MeasuredRange {
  readonly measureFromIdx: number
  readonly measureToIdx: number
  readonly measuredOnsets: readonly number[]
  readonly measuredWindows: ReadonlyArray<{ readonly startSec: number; readonly rms: number }>
}

/**
 * Resolve the snapped measurement window as integer bucket indices, shared by `steadyRms`
 * and `measuredBucketCountForSteadyRms` (test-only diagnostic, #746 C-2) so both operate on
 * the exact same selection logic instead of a re-implementation that could silently diverge.
 */
function resolveMeasuredRange(
  result: Pick<CaptureWindows, 'windows' | 'onsets'>,
  name: string,
  requirements: SteadyRmsRequirements,
): MeasuredRange {
  const hitPeriodBuckets = Math.round(requirements.hitPeriodSec / ANALYSIS_BUCKET_SEC)
  if (
    !Number.isFinite(requirements.hitPeriodSec) ||
    Math.abs(requirements.hitPeriodSec - hitPeriodBuckets * ANALYSIS_BUCKET_SEC) >
      BUCKET_WIDTH_TOLERANCE_SEC
  ) {
    throw new Error(
      `${name}: hitPeriodSec must be an integer multiple of ${ANALYSIS_BUCKET_SEC}s, ` +
        `got ${requirements.hitPeriodSec}s`,
    )
  }
  const search = result.windows(name, requirements.guardSec)
  const searchFromIdx = toBucketIndex(search[0]!.startSec)
  const searchToIdx = toBucketIndex(search[search.length - 1]!.startSec) + 1
  const firstOnset = result.onsets(name).find((onset) => toBucketIndex(onset) - 1 >= searchFromIdx)
  if (firstOnset === undefined) {
    throw new Error(`${name}: guarded search must contain an onset to snap the measurement window`)
  }
  const measureFromIdx = toBucketIndex(firstOnset) - 1
  const widthBuckets = requirements.expectedOnsets * hitPeriodBuckets
  const measureToIdx = measureFromIdx + widthBuckets
  if (measureFromIdx < searchFromIdx || measureToIdx > searchToIdx) {
    throw new Error(
      `${name}: guarded search is too short for ${requirements.expectedOnsets} hits; ` +
        `search bucket=[${searchFromIdx}, ${searchToIdx}) measure bucket=[${measureFromIdx}, ${measureToIdx})`,
    )
  }
  const measuredOnsets = result.onsets(name).filter((onset) => {
    const idx = toBucketIndex(onset)
    return idx >= measureFromIdx && idx < measureToIdx
  })
  const measuredWindows = search.filter((window) => {
    const idx = toBucketIndex(window.startSec)
    return idx >= measureFromIdx && idx < measureToIdx
  })
  return { measureFromIdx, measureToIdx, measuredOnsets, measuredWindows }
}

/** Snap a periodic capture to a whole number of hits, then return its RMS. */
export function steadyRms(
  result: Pick<CaptureWindows, 'windows' | 'onsets'>,
  name: string,
  requirements: SteadyRmsRequirements,
): number {
  // #746 D-1: expectedOnsets < 2 leaves `gaps` empty, so `sortedGaps[...]` below is undefined
  // and `Math.abs(undefined - x)` silently evaluates to NaN (always < the threshold). Refuse
  // the contract violation instead of letting periodicity checking quietly no-op.
  if (requirements.expectedOnsets < 2) {
    throw new Error(
      `${name}: steadyRms requires expectedOnsets >= 2 to measure periodicity, ` +
        `got ${requirements.expectedOnsets}`,
    )
  }
  const { measuredOnsets, measuredWindows } = resolveMeasuredRange(result, name, requirements)
  if (measuredOnsets.length !== requirements.expectedOnsets) {
    throw new Error(
      `${name}: snapped range must contain exactly ${requirements.expectedOnsets} onsets; ` +
        `got ${measuredOnsets.length}`,
    )
  }
  const gaps = measuredOnsets.slice(1).map((onset, index) => onset - measuredOnsets[index]!)
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)]!
  if (Math.abs(medianGap - requirements.hitPeriodSec) / requirements.hitPeriodSec > 0.1) {
    throw new Error(
      `${name}: median onset gap ${medianGap}s must match ${requirements.hitPeriodSec}s`,
    )
  }
  const value = quadraticMeanRms(measuredWindows)
  if (value <= requirements.audibleFloorRms) {
    throw new Error(`${name} must be audible; rms=${value}`)
  }
  return value
}

/**
 * Test-only diagnostic (#746 C-2): the bucket count `steadyRms` would measure, without the
 * RMS/onset/gap assertions. Lets a phase sweep assert the count is phase-independent instead
 * of only checking that `steadyRms` does not throw (which let the 199/200/201 drift through).
 */
export function measuredBucketCountForSteadyRms(
  result: Pick<CaptureWindows, 'windows' | 'onsets'>,
  name: string,
  requirements: SteadyRmsRequirements,
): number {
  return resolveMeasuredRange(result, name, requirements).measuredWindows.length
}

/** Map capture-clock segments to analysis buckets and enforce A1/U1/U2/U3. */
export function captureWindowsFrom(
  analysis: WavAnalysis,
  segments: Readonly<Record<string, CaptureSegment>>,
  label: string,
  capturePath?: string,
): CaptureWindows {
  const analysisWindows = analysis.windows ?? []
  // 0/1 bucket では幅を実測できないため検証を飛ばす。区間側の U1 は引き続き適用する。
  if (analysisWindows.length >= 2) {
    const actualBucketSec = analysisWindows[1]!.startSec - analysisWindows[0]!.startSec
    if (Math.abs(actualBucketSec - ANALYSIS_BUCKET_SEC) > BUCKET_WIDTH_TOLERANCE_SEC) {
      throw new Error(
        `${label}: analysis bucket width must be ${ANALYSIS_BUCKET_SEC}s, got ${actualBucketSec}s`,
      )
    }
  }
  const soundStartSec =
    analysisWindows.find((window) => window.rms >= AUDIBLE_FLOOR_RMS)?.startSec ?? null
  const entries = Object.entries(segments)

  /**
   * 不変条件の違反を、原因を追える形の Error にする。
   *
   * `label` / `analysis` / `soundStartSec` は全呼び出しで同じなのでここで閉じ込める
   * （モジュール関数にすると 6 箇所すべてが同じ 3 引数を書き写すことになる）。
   */
  const invariantError = (
    id: 'A1' | 'U1' | 'U2' | 'U3',
    name: string,
    segment: CaptureSegment,
    bucketCount: number,
    detail: string,
  ): Error =>
    new Error(
      `${label} ${id}: ${detail} ` +
        JSON.stringify({
          invariant: id,
          name,
          fromSec: segment.fromSec,
          toSec: segment.toSec,
          durationSec: analysis.durationSec,
          soundStartSec,
          bucketCount,
        }),
    )

  const requireSegment = (name: string): CaptureSegment => {
    const segment = segments[name]
    if (segment === undefined) throw new Error(`${label}: capture segment '${name}' must exist`)
    return segment
  }

  const selectAndValidateWindows = <T extends { readonly startSec: number; readonly rms: number }>(
    windows: readonly T[],
    name: string,
    guardSec: number,
    source = 'analysis',
  ): readonly T[] => {
    const segment = requireSegment(name)
    const fromSec = segment.fromSec + guardSec
    const toSec = segment.toSec - guardSec
    const selected = windows.filter(
      (window) => window.startSec >= fromSec && window.startSec < toSec,
    )
    const expected = Math.round(
      (segment.toSec - segment.fromSec - 2 * guardSec) / ANALYSIS_BUCKET_SEC,
    )
    if (Math.abs(selected.length - expected) > BUCKET_COUNT_TOLERANCE) {
      throw invariantError(
        'U1',
        name,
        segment,
        selected.length,
        `${source} expected ${expected}±${BUCKET_COUNT_TOLERANCE} buckets for guardSec=${guardSec}`,
      )
    }
    if (selected.length === 0) {
      throw invariantError(
        'U1',
        name,
        segment,
        selected.length,
        `${source} contains no buckets for guardSec=${guardSec}`,
      )
    }
    return selected
  }

  const selectedWindows = (name: string, guardSec: number) =>
    selectAndValidateWindows(analysisWindows, name, guardSec)

  let previous: [string, CaptureSegment] | undefined
  entries.forEach(([name, segment], index) => {
    const bucketCount = analysisWindows.filter(
      (window) => window.startSec >= segment.fromSec && window.startSec < segment.toSec,
    ).length
    if (
      !Number.isFinite(segment.fromSec) ||
      !Number.isFinite(segment.toSec) ||
      segment.fromSec < 0 ||
      segment.toSec <= segment.fromSec ||
      segment.toSec > analysis.durationSec ||
      // #643 E2E-3's boundary probe intentionally looks back 250 ms. Every overlap must
      // opt in explicitly; regular capture segments remain strictly non-overlapping.
      (previous !== undefined &&
        segment.overlapsPrevious !== true &&
        segment.fromSec < previous[1].toSec)
    ) {
      throw invariantError(
        'U3',
        name,
        segment,
        bucketCount,
        `segments must be finite, in capture time, monotonic, and non-overlapping` +
          (previous === undefined ? '' : `; previous=${previous[0]}`),
      )
    }
    if (index === 0 && (soundStartSec === null || segment.fromSec < soundStartSec)) {
      throw invariantError(
        'A1',
        name,
        segment,
        bucketCount,
        'the first segment must not open before sound starts',
      )
    }
    const captureDurationSec = segment.toSec - segment.fromSec
    const wallDurationSec = (segment.toWall - segment.fromWall) / 1000
    if (Math.abs(captureDurationSec - wallDurationSec) > CLOCK_WALL_TOLERANCE_SEC) {
      throw invariantError(
        'U2',
        name,
        segment,
        bucketCount,
        `capture/wall duration delta must be <= ${CLOCK_WALL_TOLERANCE_SEC}s; ` +
          `capture=${captureDurationSec}s wall=${wallDurationSec}s`,
      )
    }
    // 構築時は最も広い guard=0 だけを検証する。狭める guard は各呼び出し時に U1 で検証する。
    selectedWindows(name, 0)
    previous = [name, segment]
  })

  return {
    analysis,
    capturePath: capturePath ?? label,
    windows: (name, guardSec = DEFAULT_GUARD_SEC) => selectedWindows(name, guardSec),
    rms: (name, guardSec = DEFAULT_GUARD_SEC) => quadraticMeanRms(selectedWindows(name, guardSec)),
    onsets: (name) => {
      const segment = requireSegment(name)
      return analysis.onsets.filter((onset) => onset >= segment.fromSec && onset < segment.toSec)
    },
    channelRms: (name, channel, guardSec = DEFAULT_GUARD_SEC) => {
      const perChannel = analysis.channelWindows?.[channel]
      if (perChannel === undefined) {
        throw new Error(
          `${label}: channelWindows must exist for channel ${channel} ` +
            `(analysis.format.channels=${analysis.format.channels})`,
        )
      }
      const selected = selectAndValidateWindows(perChannel, name, guardSec, `channel ${channel}`)
      return quadraticMeanRms(selected)
    },
  }
}
