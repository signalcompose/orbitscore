import * as fs from 'fs'
import * as path from 'path'

import {
  analyzeWavBuffer,
  type WavAnalysis,
} from '../../../packages/vscode-extension/src/wav-analysis'

const CAPTURE_HEADER_BYTES = 44
const BYTES_PER_SAMPLE = 4
const ANALYSIS_BUCKET_SEC = 0.02
const DEFAULT_GUARD_SEC = 0.15
const AUDIBLE_FLOOR_RMS = 0.01
const CLOCK_WALL_TOLERANCE_SEC = 0.12
const BUCKET_COUNT_TOLERANCE = 2

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
 * capture writer は約 1 秒ごとにしか header を patch しない（capture.rs の sync_header）ので、
 * 申告サイズは実バイト数より最大 1 秒ぶん遅れる。区間はバイト長で刻んでいるため、
 * ここを揃えないと **末尾の区間が解析範囲の外に落ちる**（#739 実機で 6 件が誤検知した）。
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
  while (Date.now() <= deadline) {
    try {
      size = fs.statSync(capturePath).size
      if (size >= CAPTURE_HEADER_BYTES) {
        const analysis = analyzeWavBuffer(fs.readFileSync(capturePath), { windowMs: 20 })
        durationSec = analysis.durationSec
        peak = analysis.peak
        maxWindowRms = (analysis.windows ?? []).reduce(
          (maximum, window) => (window.rms > maximum ? window.rms : maximum),
          0,
        )
        if ((analysis.windows ?? []).some((window) => window.rms >= opts.floor)) return
      }
    } catch {
      // The writer may not have created or completed the fixed header yet. Retry until timeout.
    }
    await delay(opts.intervalMs)
  }
  throw new Error(
    `${opts.label}: timed out waiting for capture sound ` +
      JSON.stringify({ durationSec, peak, maxWindowRms, 'stat.size': size, capturePath }),
  )
}

/** Quadratic mean of RMS buckets; preserves signal energy across bucket boundaries. */
export function quadraticMeanRms(windows: ReadonlyArray<{ readonly rms: number }>): number {
  if (windows.length === 0) throw new Error('quadraticMeanRms requires at least one window')
  return Math.sqrt(
    windows.reduce((sum, window) => sum + window.rms * window.rms, 0) / windows.length,
  )
}

/** Map capture-clock segments to analysis buckets and enforce A1/U1/U2/U3. */
export function captureWindowsFrom(
  analysis: WavAnalysis,
  segments: Readonly<Record<string, CaptureSegment>>,
  label: string,
  capturePath?: string,
): CaptureWindows {
  const analysisWindows = analysis.windows ?? []
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

  const selectedWindows = (name: string, guardSec: number) => {
    const segment = requireSegment(name)
    const fromSec = segment.fromSec + guardSec
    const toSec = segment.toSec - guardSec
    const selected = analysisWindows.filter(
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
        `expected ${expected}±${BUCKET_COUNT_TOLERANCE} buckets for guardSec=${guardSec}`,
      )
    }
    if (selected.length === 0) {
      throw invariantError(
        'U1',
        name,
        segment,
        selected.length,
        `segment contains no buckets for guardSec=${guardSec}`,
      )
    }
    return selected
  }

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
    selectedWindows(name, DEFAULT_GUARD_SEC)
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
      const segment = requireSegment(name)
      const fromSec = segment.fromSec + guardSec
      const toSec = segment.toSec - guardSec
      const selected = perChannel.filter(
        (window) => window.startSec >= fromSec && window.startSec < toSec,
      )
      if (selected.length === 0) {
        throw invariantError(
          'U1',
          name,
          segment,
          selected.length,
          `channel ${channel} contains no buckets for guardSec=${guardSec}`,
        )
      }
      return quadraticMeanRms(selected)
    },
  }
}
