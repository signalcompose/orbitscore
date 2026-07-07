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
  /** true when the capture plausibly contains sound (≥3 onsets and peak > 0.05). */
  soundDetected: boolean
}

/** RMS window size in seconds (20ms — fine enough to separate 0.5s beats). */
const WINDOW_SEC = 0.02
/** Minimum gap between reported onsets. */
const MIN_ONSET_GAP_SEC = 0.2
/** Absolute floor for the onset threshold (below this is treated as noise). */
const ONSET_THRESHOLD_FLOOR = 0.01

export function analyzeWavBuffer(buf: Buffer): WavAnalysis {
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
    soundDetected: onsets.length >= 3 && peak > 0.05,
  }
}
