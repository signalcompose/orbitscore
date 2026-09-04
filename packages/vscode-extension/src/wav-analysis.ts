/**
 * Objective audio verification for captured WAVs (#388 Agent Bridge).
 *
 * Parses the daemon's capture format — RIFF/WAVE, IEEE float32
 * (`WAVE_FORMAT_IEEE_FLOAT`, see rust/crates/orbit-audio-native/src/capture.rs)
 * — and reports peak / RMS / onsets so an agent can verify that audio was
 * actually produced (and matches the score's timing) without listening.
 *
 * Pure module: no vscode dependency, unit-testable with synthetic buffers.
 * Tolerates an unfinalized header (data chunk size 0 — writer killed before
 * the finalize patch) by reading sample data to EOF.
 */

export interface WavFormat {
  /** 3 = IEEE float (the only format the capture seam writes). */
  audioFormat: number
  channels: number
  sampleRate: number
  bitsPerSample: number
}

/** One window of a single channel's peak/RMS series (#668 §10 — pan / channel separation). */
export interface ChannelWindow {
  readonly startSec: number
  readonly peak: number
  readonly rms: number
}

export interface WavAnalysis {
  format: WavFormat
  frames: number
  durationSec: number
  /** Max |sample| across the mono mixdown. */
  peak: number
  /** Overall RMS of the mono mixdown. */
  rms: number
  /** Onset times in seconds (RMS rising past threshold, ≥200ms apart). */
  onsets: number[]
  /** Gaps between consecutive onsets in seconds. */
  onsetGaps: number[]
  /**
   * true when the capture plausibly contains sound（≥1 onset かつ peak > 0.05）。
   * #478 修正: 旧判定は ≥3 onsets を要求し、one-shot 1 発（peak 0.7 等）を
   * false と誤報していた（品質チェック E2E で実測）。
   */
  soundDetected: boolean
  /**
   * 任意の時間窓 peak/RMS 系列（`windowMs` オプション指定時のみ・#478）。
   * MX.5 の「dry 先行 → 干渉定常」のような時間構造の検証を可能にする。
   */
  windows?: Array<{ startSec: number; peak: number; rms: number }>
  /**
   * チャンネル別の窓系列（`opts.perChannel` 指定時のみ・#668 §10）。index = チャンネル番号。
   * `analysis.windows` はチャンネル加算平均のモノラルのままで、こちらは各チャンネルを
   * 別々に保持する — pan / チャンネル分離 / bleed の判定はこちらでしか測れない。
   */
  channelWindows?: ReadonlyArray<ReadonlyArray<ChannelWindow>>
  /** チャンネル別の全体 RMS（同上）。index = チャンネル番号。 */
  channelRms?: readonly number[]
}

/** RMS window size in seconds (20ms — fine enough to separate 0.5s beats). */
const WINDOW_SEC = 0.02
/** Minimum gap between reported onsets. */
const MIN_ONSET_GAP_SEC = 0.2
/** Absolute floor for the onset threshold (below this is treated as noise). */
const ONSET_THRESHOLD_FLOOR = 0.01
/** Steady-window size used by the pure-sine fundamental estimator. */
const FUNDAMENTAL_WINDOW_SEC = 0.02
/** RMS below this is silence/noise, not a usable steady tone. */
const FUNDAMENTAL_AMPLITUDE_FLOOR = 0.01

interface ParsedFloat32Wav {
  format: WavFormat
  dataOff: number
  frames: number
  durationSec: number
}

function parseFloat32Wav(buf: Buffer): ParsedFloat32Wav {
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE file')
  }

  // Walk chunks for fmt + data.
  let off = 12
  let format: WavFormat | null = null
  let dataOff: number | null = null
  let dataSize = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      format = {
        audioFormat: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      }
    } else if (id === 'data') {
      dataOff = off + 8
      // Unfinalized header (size 0 or overrunning EOF) → read to EOF.
      dataSize = size > 0 && dataOff + size <= buf.length ? size : buf.length - dataOff
      break
    }
    off += 8 + size + (size % 2)
  }
  if (!format || dataOff === null) {
    throw new Error('missing fmt/data chunk')
  }
  if (format.audioFormat !== 3 || format.bitsPerSample !== 32) {
    throw new Error(
      `expected IEEE float32 capture (format 3, 32-bit), got format ${format.audioFormat}, ${format.bitsPerSample}-bit`,
    )
  }
  if (format.channels < 1 || format.sampleRate <= 0) {
    throw new Error(`implausible fmt chunk: ${JSON.stringify(format)}`)
  }

  const bytesPerFrame = 4 * format.channels
  const frames = Math.floor(dataSize / bytesPerFrame)
  const durationSec = frames / format.sampleRate
  return { format, dataOff, frames, durationSec }
}

export function analyzeWavBuffer(
  buf: Buffer,
  opts?: { windowMs?: number; perChannel?: boolean },
): WavAnalysis {
  const { format, dataOff, frames, durationSec } = parseFloat32Wav(buf)

  // Per-window RMS over the mono mixdown.
  const winFrames = Math.max(1, Math.floor(format.sampleRate * WINDOW_SEC))
  const windows: number[] = []
  let peak = 0
  let sumSq = 0
  for (let w = 0; w * winFrames < frames; w++) {
    const start = w * winFrames
    const end = Math.min(start + winFrames, frames)
    let s = 0
    for (let i = start; i < end; i++) {
      let mono = 0
      for (let c = 0; c < format.channels; c++) {
        mono += buf.readFloatLE(dataOff + (i * format.channels + c) * 4)
      }
      mono /= format.channels
      s += mono * mono
      const a = Math.abs(mono)
      if (a > peak) peak = a
    }
    sumSq += s
    windows.push(Math.sqrt(s / Math.max(1, end - start)))
  }
  const rms = Math.sqrt(sumSq / Math.max(1, frames))

  // Onsets: window RMS rises past threshold from below, with a minimum gap.
  const sorted = [...windows].sort((a, b) => a - b)
  const noiseFloor = sorted[Math.floor(sorted.length / 2)] ?? 0
  const threshold = Math.max(noiseFloor * 4, ONSET_THRESHOLD_FLOOR)
  const minGapWindows = Math.ceil(MIN_ONSET_GAP_SEC / WINDOW_SEC)
  const onsets: number[] = []
  let lastOnset = -minGapWindows
  for (let w = 1; w < windows.length; w++) {
    const rising = windows[w]! >= threshold && windows[w - 1]! < threshold
    if (rising && w - lastOnset >= minGapWindows) {
      onsets.push(w * WINDOW_SEC)
      lastOnset = w
    }
  }
  const onsetGaps = onsets.slice(1).map((t, i) => t - onsets[i]!)

  return {
    format,
    frames,
    durationSec,
    peak,
    rms,
    onsets,
    onsetGaps,
    soundDetected: onsets.length >= 1 && peak > 0.05,
    ...(opts?.windowMs && opts.windowMs > 0
      ? { windows: windowSeries(buf, dataOff, frames, format, opts.windowMs / 1000) }
      : {}),
    ...(opts?.perChannel
      ? channelSeries(
          buf,
          dataOff,
          frames,
          format,
          opts.windowMs && opts.windowMs > 0 ? opts.windowMs / 1000 : WINDOW_SEC,
        )
      : {}),
  }
}

/**
 * Estimate a pure tone's fundamental from upward zero crossings in the
 * longest steady region of the requested time range.
 *
 * Returns undefined when the range contains no above-threshold steady region
 * or fewer than two crossings; silence is never reported as 0/NaN Hz.
 */
export function estimateFundamentalHz(
  buf: Buffer,
  range: { fromSec: number; toSec: number },
): number | undefined {
  const { format, dataOff, frames } = parseFloat32Wav(buf)
  if (
    !Number.isFinite(range.fromSec) ||
    !Number.isFinite(range.toSec) ||
    range.toSec <= range.fromSec
  ) {
    return undefined
  }

  const firstFrame = Math.max(0, Math.floor(range.fromSec * format.sampleRate))
  const endFrame = Math.min(frames, Math.ceil(range.toSec * format.sampleRate))
  if (endFrame <= firstFrame) return undefined

  const monoSample = (frame: number): number => {
    let mono = 0
    for (let channel = 0; channel < format.channels; channel++) {
      mono += buf.readFloatLE(dataOff + (frame * format.channels + channel) * 4)
    }
    return mono / format.channels
  }

  // Find the longest consecutive run of above-threshold 20ms RMS windows.
  // The CLAP oracle is a constant-amplitude pure sine, so this excludes capture
  // lead-in/tail silence while leaving a stationary interval for zero crossings.
  const windowFrames = Math.max(1, Math.floor(format.sampleRate * FUNDAMENTAL_WINDOW_SEC))
  let runStart: number | undefined
  let bestStart: number | undefined
  let bestEnd: number | undefined
  for (let start = firstFrame; start < endFrame; start += windowFrames) {
    const end = Math.min(start + windowFrames, endFrame)
    let sumSq = 0
    for (let frame = start; frame < end; frame++) {
      const sample = monoSample(frame)
      sumSq += sample * sample
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start))
    if (rms >= FUNDAMENTAL_AMPLITUDE_FLOOR) {
      runStart ??= start
    } else if (runStart !== undefined) {
      if (bestStart === undefined || start - runStart > bestEnd! - bestStart) {
        bestStart = runStart
        bestEnd = start
      }
      runStart = undefined
    }
  }
  if (runStart !== undefined) {
    if (bestStart === undefined || endFrame - runStart > bestEnd! - bestStart) {
      bestStart = runStart
      bestEnd = endFrame
    }
  }
  if (bestStart === undefined || bestEnd === undefined) return undefined

  // Port of offline.rs measured_frequency_hz: frequency is the number of
  // complete periods between the first and last upward zero crossings.
  let crossings = 0
  let firstCrossing: number | undefined
  let lastCrossing = 0
  let previous = monoSample(bestStart)
  for (let frame = bestStart + 1; frame < bestEnd; frame++) {
    const current = monoSample(frame)
    if (previous <= 0 && current > 0) {
      firstCrossing ??= frame
      lastCrossing = frame
      crossings++
    }
    previous = current
  }
  if (firstCrossing === undefined || crossings < 2) return undefined

  const measured = (format.sampleRate * (crossings - 1)) / Math.max(1, lastCrossing - firstCrossing)
  return Number.isFinite(measured) && measured > 0 ? measured : undefined
}

/** windows 系列の上限（JSON ペイロード肥大の防御・レビュー指摘）。 */
const MAX_WINDOW_SERIES = 20_000
/** window_ms の下限（極小値で winFrames=1 に floor され窓数が爆発するのを防ぐ）。 */
const MIN_WINDOW_MS = 1

/**
 * チャンネル別の per-window peak/RMS 系列 + チャンネル別の全体 RMS（#668 §10）。
 * `windowSeries` と対をなすが、チャンネルごとに加算平均せず別々に保持する。
 */
function channelSeries(
  buf: Buffer,
  dataOff: number,
  frames: number,
  format: WavFormat,
  windowSec: number,
): { channelWindows: ChannelWindow[][]; channelRms: number[] } {
  const effectiveSec = Math.max(windowSec, MIN_WINDOW_MS / 1000)
  const winFrames = Math.max(1, Math.floor(format.sampleRate * effectiveSec))
  const windowCount = Math.ceil(frames / winFrames)
  if (windowCount > MAX_WINDOW_SERIES) {
    throw new Error(
      `window_ms too small for this capture: ${windowCount} windows would be produced ` +
        `(cap ${MAX_WINDOW_SERIES}). Use a larger window_ms.`,
    )
  }
  const channelWindows: ChannelWindow[][] = Array.from({ length: format.channels }, () => [])
  const totalSumSq = new Array<number>(format.channels).fill(0)
  for (let w = 0; w * winFrames < frames; w++) {
    const start = w * winFrames
    const end = Math.min(start + winFrames, frames)
    const startSec = start / format.sampleRate
    const winPeak = new Array<number>(format.channels).fill(0)
    const winSumSq = new Array<number>(format.channels).fill(0)
    for (let i = start; i < end; i++) {
      for (let c = 0; c < format.channels; c++) {
        const sample = buf.readFloatLE(dataOff + (i * format.channels + c) * 4)
        const a = Math.abs(sample)
        if (a > winPeak[c]!) winPeak[c] = a
        winSumSq[c] = winSumSq[c]! + sample * sample
      }
    }
    for (let c = 0; c < format.channels; c++) {
      totalSumSq[c] = totalSumSq[c]! + winSumSq[c]!
      channelWindows[c]!.push({
        startSec,
        peak: winPeak[c]!,
        rms: Math.sqrt(winSumSq[c]! / Math.max(1, end - start)),
      })
    }
  }
  const channelRms = totalSumSq.map((sumSq) => Math.sqrt(sumSq / Math.max(1, frames)))
  return { channelWindows, channelRms }
}

/** 指定解像度の per-window peak/RMS 系列（mono mixdown・#478）。 */
function windowSeries(
  buf: Buffer,
  dataOff: number,
  frames: number,
  format: WavFormat,
  windowSec: number,
): Array<{ startSec: number; peak: number; rms: number }> {
  const effectiveSec = Math.max(windowSec, MIN_WINDOW_MS / 1000)
  const winFrames = Math.max(1, Math.floor(format.sampleRate * effectiveSec))
  const windowCount = Math.ceil(frames / winFrames)
  if (windowCount > MAX_WINDOW_SERIES) {
    throw new Error(
      `window_ms too small for this capture: ${windowCount} windows would be produced ` +
        `(cap ${MAX_WINDOW_SERIES}). Use a larger window_ms.`,
    )
  }
  const out: Array<{ startSec: number; peak: number; rms: number }> = []
  for (let w = 0; w * winFrames < frames; w++) {
    const start = w * winFrames
    const end = Math.min(start + winFrames, frames)
    let peak = 0
    let sumSq = 0
    for (let i = start; i < end; i++) {
      let mono = 0
      for (let c = 0; c < format.channels; c++) {
        mono += buf.readFloatLE(dataOff + (i * format.channels + c) * 4)
      }
      mono /= format.channels
      const a = Math.abs(mono)
      if (a > peak) peak = a
      sumSq += mono * mono
    }
    out.push({
      startSec: start / format.sampleRate,
      peak,
      rms: Math.sqrt(sumSq / Math.max(1, end - start)),
    })
  }
  return out
}
