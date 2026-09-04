import * as fs from 'fs'

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

const invariantError = (
  id: 'A1' | 'U1' | 'U2' | 'U3',
  label: string,
  name: string,
  segment: CaptureSegment,
  analysis: WavAnalysis,
  soundStartSec: number | null,
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

  if (capturePath !== undefined) {
    const format = readCaptureFormat(capturePath)
    const fileDurationSec = captureClockSec(capturePath, format)
    const frameToleranceSec = 1 / format.sampleRate
    if (Math.abs(fileDurationSec - analysis.durationSec) > frameToleranceSec) {
      throw new Error(
        `${label}: capture analysis/file length mismatch ` +
          JSON.stringify({ fileDurationSec, durationSec: analysis.durationSec, capturePath }),
      )
    }
  }

  const selectedWindows = (name: string, guardSec: number) => {
    const segment = segments[name]
    if (segment === undefined) throw new Error(`${label}: capture segment '${name}' must exist`)
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
        label,
        name,
        segment,
        analysis,
        soundStartSec,
        selected.length,
        `expected ${expected}±${BUCKET_COUNT_TOLERANCE} buckets for guardSec=${guardSec}`,
      )
    }
    if (selected.length === 0) {
      throw invariantError(
        'U1',
        label,
        name,
        segment,
        analysis,
        soundStartSec,
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
        label,
        name,
        segment,
        analysis,
        soundStartSec,
        bucketCount,
        `segments must be finite, in capture time, monotonic, and non-overlapping` +
          (previous === undefined ? '' : `; previous=${previous[0]}`),
      )
    }
    if (index === 0 && (soundStartSec === null || segment.fromSec < soundStartSec)) {
      throw invariantError(
        'A1',
        label,
        name,
        segment,
        analysis,
        soundStartSec,
        bucketCount,
        'the first segment must not open before sound starts',
      )
    }
    const captureDurationSec = segment.toSec - segment.fromSec
    const wallDurationSec = (segment.toWall - segment.fromWall) / 1000
    if (Math.abs(captureDurationSec - wallDurationSec) > CLOCK_WALL_TOLERANCE_SEC) {
      throw invariantError(
        'U2',
        label,
        name,
        segment,
        analysis,
        soundStartSec,
        bucketCount,
        `capture/wall duration delta must be <= ${CLOCK_WALL_TOLERANCE_SEC}s; ` +
          `capture=${captureDurationSec}s wall=${wallDurationSec}s`,
      )
    }
    selectedWindows(name, DEFAULT_GUARD_SEC)
    previous = [name, segment]
  })

  const requireSegment = (name: string): CaptureSegment => {
    const segment = segments[name]
    if (segment === undefined) throw new Error(`${label}: capture segment '${name}' must exist`)
    return segment
  }

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
          label,
          name,
          segment,
          analysis,
          soundStartSec,
          selected.length,
          `channel ${channel} contains no buckets for guardSec=${guardSec}`,
        )
      }
      return quadraticMeanRms(selected)
    },
  }
}
