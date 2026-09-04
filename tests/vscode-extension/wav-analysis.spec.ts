import { describe, it, expect } from 'vitest'

import {
  analyzeWavBuffer,
  estimateFundamentalHz,
} from '../../packages/vscode-extension/src/wav-analysis'

/**
 * Unit tests for the capture-seam WAV analyzer (#388 Agent Bridge) using
 * synthetic RIFF/WAVE float32 buffers — no real audio files needed.
 *
 * Analyzer constants to respect when synthesizing clicks (wav-analysis.ts):
 *   - 20ms RMS windows
 *   - minimum 200ms gap between reported onsets
 *   - threshold floor 0.01 (keep click amplitude comfortably above this)
 */

interface BuildWavOptions {
  sampleRate?: number
  channels?: number
  seconds: number
  /** Click onset times in seconds. */
  clicks?: number[]
  clickAmp?: number
  /** Optional full-duration sine tone used by fundamental-frequency tests. */
  toneHz?: number
  toneAmp?: number
  /** When false, writes 0 for both RIFF size and data size (unfinalized header, e.g. a killed writer). */
  finalizeHeader?: boolean
}

/** ~10ms burst at constant amplitude — comfortably above the 0.01 threshold floor. */
const CLICK_DURATION_SEC = 0.01

function buildFloat32Wav(opts: BuildWavOptions): Buffer {
  const sampleRate = opts.sampleRate ?? 48000
  const channels = opts.channels ?? 2
  const clickAmp = opts.clickAmp ?? 0.9
  const clicks = opts.clicks ?? []
  const finalizeHeader = opts.finalizeHeader ?? true

  const frames = Math.floor(sampleRate * opts.seconds)
  const bytesPerFrame = 4 * channels
  const dataSize = frames * bytesPerFrame

  // Precompute per-frame mono sample (silence, plus click bursts).
  const samples = new Float32Array(frames)
  if (opts.toneHz !== undefined) {
    const toneAmp = opts.toneAmp ?? 0.25
    for (let i = 0; i < frames; i++) {
      samples[i] = toneAmp * Math.sin((2 * Math.PI * opts.toneHz * i) / sampleRate)
    }
  }
  const clickFrames = Math.max(1, Math.floor(sampleRate * CLICK_DURATION_SEC))
  for (const t of clicks) {
    const start = Math.floor(t * sampleRate)
    for (let i = 0; i < clickFrames; i++) {
      const idx = start + i
      if (idx >= 0 && idx < frames) samples[idx] = clickAmp
    }
  }

  const fmtChunkSize = 16
  const headerSize = 12 + (8 + fmtChunkSize) + 8 // RIFF/WAVE + fmt chunk + data chunk header
  const buf = Buffer.alloc(headerSize + dataSize)

  let off = 0
  buf.write('RIFF', off, 'ascii')
  off += 4
  const riffSize = finalizeHeader ? 4 + (8 + fmtChunkSize) + (8 + dataSize) : 0
  buf.writeUInt32LE(riffSize, off)
  off += 4
  buf.write('WAVE', off, 'ascii')
  off += 4

  buf.write('fmt ', off, 'ascii')
  off += 4
  buf.writeUInt32LE(fmtChunkSize, off)
  off += 4
  buf.writeUInt16LE(3, off) // audioFormat: IEEE float
  off += 2
  buf.writeUInt16LE(channels, off)
  off += 2
  buf.writeUInt32LE(sampleRate, off)
  off += 4
  const byteRate = sampleRate * bytesPerFrame
  buf.writeUInt32LE(byteRate, off)
  off += 4
  buf.writeUInt16LE(bytesPerFrame, off) // block align
  off += 2
  buf.writeUInt16LE(32, off) // bits per sample
  off += 2

  buf.write('data', off, 'ascii')
  off += 4
  buf.writeUInt32LE(finalizeHeader ? dataSize : 0, off)
  off += 4

  const dataOff = off
  for (let i = 0; i < frames; i++) {
    const mono = samples[i]!
    for (let c = 0; c < channels; c++) {
      buf.writeFloatLE(mono, dataOff + (i * channels + c) * 4)
    }
  }

  return buf
}

/**
 * Same shape as `buildFloat32Wav`, but each channel gets its own gain applied to the
 * shared mono waveform — for testing that per-channel analysis can tell channels apart
 * (e.g. a hard-panned signal) where the mono mixdown cannot (#668 §10).
 */
function buildPannedFloat32Wav(
  opts: Omit<BuildWavOptions, 'channels'> & { channelGains: number[] },
): Buffer {
  const sampleRate = opts.sampleRate ?? 48000
  const channels = opts.channelGains.length
  const clickAmp = opts.clickAmp ?? 0.9
  const clicks = opts.clicks ?? []

  const frames = Math.floor(sampleRate * opts.seconds)
  const bytesPerFrame = 4 * channels
  const dataSize = frames * bytesPerFrame

  const samples = new Float32Array(frames)
  const clickFrames = Math.max(1, Math.floor(sampleRate * CLICK_DURATION_SEC))
  for (const t of clicks) {
    const start = Math.floor(t * sampleRate)
    for (let i = 0; i < clickFrames; i++) {
      const idx = start + i
      if (idx >= 0 && idx < frames) samples[idx] = clickAmp
    }
  }

  const fmtChunkSize = 16
  const headerSize = 12 + (8 + fmtChunkSize) + 8
  const buf = Buffer.alloc(headerSize + dataSize)

  let off = 0
  buf.write('RIFF', off, 'ascii')
  off += 4
  buf.writeUInt32LE(4 + (8 + fmtChunkSize) + (8 + dataSize), off)
  off += 4
  buf.write('WAVE', off, 'ascii')
  off += 4

  buf.write('fmt ', off, 'ascii')
  off += 4
  buf.writeUInt32LE(fmtChunkSize, off)
  off += 4
  buf.writeUInt16LE(3, off) // audioFormat: IEEE float
  off += 2
  buf.writeUInt16LE(channels, off)
  off += 2
  buf.writeUInt32LE(sampleRate, off)
  off += 4
  const byteRate = sampleRate * bytesPerFrame
  buf.writeUInt32LE(byteRate, off)
  off += 4
  buf.writeUInt16LE(bytesPerFrame, off)
  off += 2
  buf.writeUInt16LE(32, off)
  off += 2

  buf.write('data', off, 'ascii')
  off += 4
  buf.writeUInt32LE(dataSize, off)
  off += 4

  const dataOff = off
  for (let i = 0; i < frames; i++) {
    const mono = samples[i]!
    for (let c = 0; c < channels; c++) {
      buf.writeFloatLE(mono * opts.channelGains[c]!, dataOff + (i * channels + c) * 4)
    }
  }

  return buf
}

/** Minimal int16 PCM (format 1) header — used to verify the analyzer rejects non-float32 captures. */
function buildInt16Wav(opts: { sampleRate?: number; channels?: number; frames: number }): Buffer {
  const sampleRate = opts.sampleRate ?? 48000
  const channels = opts.channels ?? 1
  const bytesPerFrame = 2 * channels
  const dataSize = opts.frames * bytesPerFrame
  const fmtChunkSize = 16
  const headerSize = 12 + (8 + fmtChunkSize) + 8
  const buf = Buffer.alloc(headerSize + dataSize)

  let off = 0
  buf.write('RIFF', off, 'ascii')
  off += 4
  buf.writeUInt32LE(4 + (8 + fmtChunkSize) + (8 + dataSize), off)
  off += 4
  buf.write('WAVE', off, 'ascii')
  off += 4

  buf.write('fmt ', off, 'ascii')
  off += 4
  buf.writeUInt32LE(fmtChunkSize, off)
  off += 4
  buf.writeUInt16LE(1, off) // audioFormat: PCM
  off += 2
  buf.writeUInt16LE(channels, off)
  off += 2
  buf.writeUInt32LE(sampleRate, off)
  off += 4
  buf.writeUInt32LE(sampleRate * bytesPerFrame, off)
  off += 4
  buf.writeUInt16LE(bytesPerFrame, off)
  off += 2
  buf.writeUInt16LE(16, off) // bits per sample
  off += 2

  buf.write('data', off, 'ascii')
  off += 4
  buf.writeUInt32LE(dataSize, off)
  off += 4
  // Sample content is irrelevant — analyzeWavBuffer throws on the fmt chunk alone.

  return buf
}

describe('analyzeWavBuffer', () => {
  it('reports no sound for pure silence', () => {
    const buf = buildFloat32Wav({ seconds: 2 })
    const analysis = analyzeWavBuffer(buf)

    expect(analysis.soundDetected).toBe(false)
    expect(analysis.onsets).toEqual([])
    expect(analysis.peak).toBe(0)
  })

  it('detects 4 onsets ~0.5s apart for clicks at [0.5, 1.0, 1.5, 2.0]', () => {
    const clicks = [0.5, 1.0, 1.5, 2.0]
    const buf = buildFloat32Wav({ seconds: 2.5, clicks })
    const analysis = analyzeWavBuffer(buf)

    expect(analysis.soundDetected).toBe(true)
    expect(analysis.onsets).toHaveLength(4)
    expect(analysis.onsetGaps).toHaveLength(3)
    for (const gap of analysis.onsetGaps) {
      expect(gap).toBeGreaterThanOrEqual(0.45)
      expect(gap).toBeLessThanOrEqual(0.55)
    }
  })

  it('still parses an unfinalized header (data size 0, simulating a killed writer)', () => {
    const clicks = [0.5, 1.0, 1.5, 2.0]
    const finalized = buildFloat32Wav({ seconds: 2.5, clicks, finalizeHeader: true })
    const unfinalized = buildFloat32Wav({ seconds: 2.5, clicks, finalizeHeader: false })

    const finalizedAnalysis = analyzeWavBuffer(finalized)
    const unfinalizedAnalysis = analyzeWavBuffer(unfinalized)

    expect(unfinalizedAnalysis.soundDetected).toBe(true)
    expect(unfinalizedAnalysis.onsets).toEqual(finalizedAnalysis.onsets)
  })

  it('throws on a non-RIFF buffer', () => {
    const buf = Buffer.from('not a wav file at all, just plain text padding out to 16 bytes')
    expect(() => analyzeWavBuffer(buf)).toThrow(/RIFF/)
  })

  it('throws on an int16 (non-float32) WAV', () => {
    const buf = buildInt16Wav({ frames: 100 })
    expect(() => analyzeWavBuffer(buf)).toThrow(/float32/)
  })

  it('works for mono (channels: 1)', () => {
    const clicks = [0.5, 1.0, 1.5, 2.0]
    const buf = buildFloat32Wav({ seconds: 2.5, clicks, channels: 1 })
    const analysis = analyzeWavBuffer(buf)

    expect(analysis.format.channels).toBe(1)
    expect(analysis.soundDetected).toBe(true)
    expect(analysis.onsets).toHaveLength(4)
  })
})

describe('estimateFundamentalHz', () => {
  it.each([440, 261.63, 392])('estimates a synthetic %s Hz sine within 1%', (expectedHz) => {
    const buf = buildFloat32Wav({ seconds: 1, toneHz: expectedHz, toneAmp: 0.25 })
    const measuredHz = estimateFundamentalHz(buf, { fromSec: 0.1, toSec: 0.9 })

    expect(measuredHz).toBeDefined()
    expect(Math.abs(measuredHz! - expectedHz) / expectedHz).toBeLessThanOrEqual(0.01)
  })

  it('returns undefined for silence', () => {
    const buf = buildFloat32Wav({ seconds: 1 })
    expect(estimateFundamentalHz(buf, { fromSec: 0, toSec: 1 })).toBeUndefined()
  })
})

describe('analyzeWavBuffer — #478 fixes', () => {
  it('detects a single one-shot (1 onset, high peak) as sound — old >=3-onset rule false-negatived this', () => {
    const buf = buildFloat32Wav({ seconds: 2, clicks: [0.5], clickAmp: 0.7 })
    const analysis = analyzeWavBuffer(buf)
    expect(analysis.onsets.length).toBe(1)
    expect(analysis.soundDetected).toBe(true)
  })

  it('returns a per-window peak/RMS series when windowMs is passed', () => {
    const buf = buildFloat32Wav({ seconds: 1, clicks: [0.5], clickAmp: 0.7 })
    const analysis = analyzeWavBuffer(buf, { windowMs: 10 })
    expect(analysis.windows).toBeDefined()
    const w = analysis.windows!
    expect(w.length).toBeGreaterThan(90)
    // 0.1s 時点は無音・0.5s の click 窓では peak が立つ — 時間構造が系列から読める
    expect(w[10]!.peak).toBe(0)
    const loudest = w.reduce((a, b) => (b.peak > a.peak ? b : a))
    expect(loudest.peak).toBeGreaterThan(0.6)
    expect(Math.abs(loudest.startSec - 0.5)).toBeLessThan(0.02)
  })

  it('rejects a window_ms that would explode the series size (cap)', () => {
    const buf = buildFloat32Wav({ seconds: 10 })
    // 10s/48kHz で window 0.01ms 相当 → 下限 1ms clamp 後でも 10,000 窓は cap 内。
    // cap 超過を作るには長尺相当が要るため、下限 clamp の検証と cap メッセージの検証を分ける:
    expect(() => analyzeWavBuffer(buf, { windowMs: 0.001 })).not.toThrow() // clamp が効く
    const windows = analyzeWavBuffer(buf, { windowMs: 0.001 }).windows!
    expect(windows.length).toBeLessThanOrEqual(20_000)
  })

  it('omits the windows series when windowMs is not passed', () => {
    const buf = buildFloat32Wav({ seconds: 1 })
    expect(analyzeWavBuffer(buf).windows).toBeUndefined()
  })
})

describe('analyzeWavBuffer — perChannel (#668 §10)', () => {
  it('omits channelWindows/channelRms by default (mono behaviour is unchanged)', () => {
    const buf = buildFloat32Wav({ seconds: 1, clicks: [0.5] })
    const analysis = analyzeWavBuffer(buf)
    expect(analysis.channelWindows).toBeUndefined()
    expect(analysis.channelRms).toBeUndefined()
  })

  it('omits channelWindows/channelRms when only windowMs is passed (no perChannel)', () => {
    const buf = buildFloat32Wav({ seconds: 1, clicks: [0.5] })
    const analysis = analyzeWavBuffer(buf, { windowMs: 10 })
    expect(analysis.channelWindows).toBeUndefined()
    expect(analysis.channelRms).toBeUndefined()
  })

  it('separates a hard-panned signal that the mono mixdown cannot distinguish', () => {
    // Left at full gain, right silent — mono mixdown averages them into a single
    // (halved) series, which is exactly the #650/#611/#598 problem this PR fixes.
    const buf = buildPannedFloat32Wav({ seconds: 1, clicks: [0.3], channelGains: [1, 0] })
    const analysis = analyzeWavBuffer(buf, { perChannel: true })

    expect(analysis.channelRms).toHaveLength(2)
    const [leftRms, rightRms] = analysis.channelRms!
    expect(leftRms!).toBeGreaterThan(0)
    expect(rightRms!).toBe(0)
    // Mono mixdown is (left + right) / 2 = left / 2 here — same scaling for RMS.
    expect(analysis.rms).toBeCloseTo(leftRms! / 2, 6)

    expect(analysis.channelWindows).toHaveLength(2)
    const loudestLeft = analysis.channelWindows![0]!.reduce((a, b) => (b.peak > a.peak ? b : a))
    const loudestRight = analysis.channelWindows![1]!.reduce((a, b) => (b.peak > a.peak ? b : a))
    expect(loudestLeft.peak).toBeCloseTo(0.9, 5)
    expect(loudestRight.peak).toBe(0)
  })

  it('uses windowMs for channelWindows resolution when both options are passed', () => {
    const buf = buildPannedFloat32Wav({ seconds: 1, clicks: [0.5], channelGains: [1, 1] })
    const analysis = analyzeWavBuffer(buf, { windowMs: 10, perChannel: true })

    // 10ms windows over 1s ≈ 100 windows per channel (same resolution as `windows`).
    expect(analysis.windows).toHaveLength(analysis.channelWindows![0]!.length)
    expect(analysis.channelWindows![1]!.length).toBe(analysis.channelWindows![0]!.length)
  })
})
