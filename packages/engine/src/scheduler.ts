import type { IR, DurationSpec, SequenceIR } from './ir'
import type { MidiOut, MidiMessage } from './midi'
import { PitchConverter } from './pitch'

const LOOK_AHEAD_MS = 50
const TICK_MS = 5

/** 共有/独立メーターに対応する再生位置とループを管理し、NoteOn/Off を窓出し */
export class Scheduler {
  private currentSec = 0
  private loop: LoopWindow | null = null
  private pendingJumpBar: number | null = null
  private tickTimer: NodeJS.Timeout | null = null
  private wallStartMs: number | null = null
  private scheduledUntilMs = 0 // 0-based timeline
  private mutedSequences = new Set<string>()
  private soloSequences = new Set<string>()
  private sentSet = new Set<string>()

  constructor(
    private out: MidiOut,
    private ir: IR,
  ) {}
  start() {
    // 実時間窓出しの最小実装（テストでは直接 scheduleThrough を呼ぶ）
    this.wallStartMs = Date.now()
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = setInterval(() => {
      const nowMs = Date.now()
      const elapsedMs = this.wallStartMs ? nowMs - this.wallStartMs : 0
      const targetMs = elapsedMs + LOOK_AHEAD_MS
      this.scheduleThrough(targetMs)
    }, TICK_MS)
  }
  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  // ----- Transport state helpers (for tests/phase3 minimal) -----
  setCurrentTimeSec(sec: number) {
    this.currentSec = Math.max(0, sec)
  }
  getCurrentTimeSec(): number {
    return this.currentSec
  }
  setLoop(window: LoopWindow | null) {
    this.loop = window
  }
  requestJump(targetBar: number) {
    this.pendingJumpBar = Math.max(0, Math.floor(targetBar))
  }
  setMute(sequenceName: string, muted: boolean) {
    if (muted) this.mutedSequences.add(sequenceName)
    else this.mutedSequences.delete(sequenceName)
  }
  setSolo(sequenceNames: string[] | null) {
    this.soloSequences.clear()
    if (sequenceNames && sequenceNames.length)
      sequenceNames.forEach((n) => this.soloSequences.add(n))
  }

  /**
   * 再スケジュール開始位置を変更（ジャンプ等の後始末）
   * clearSent=true にすると重複防止セットもリセット
   */
  resetSchedule(fromMs = 0, clearSent = false) {
    this.scheduledUntilMs = Math.max(0, fromMs)
    if (clearSent) this.sentSet.clear()
  }

  /**
   * シンプルなトランスポート前進（実時間適用の最小モデル）。
   * - 小節頭で Jump を適用
   * - ループが有効な場合、endBar 到達時に startBar へ巻き戻し
   * - 時間だけを進める（MIDI出力はしない）
   */
  simulateTransportAdvance(durationSec: number) {
    const endTarget = this.currentSec + Math.max(0, durationSec)
    // 量子化に用いるベース: グローバル基準のダミーSequence（shared扱い）
    const baseSeq: SequenceIR = {
      config: {
        name: '__transport__',
        bus: '',
        channel: 1,
        key: this.ir.global.key,
        tempo: this.ir.global.tempo,
        meter: {
          n: this.ir.global.meter.n,
          d: this.ir.global.meter.d,
          align: 'shared',
        },
        octave: 0,
        octmul: 1,
        bendRange: 2,
        mpe: false,
        defaultDur: { kind: 'unit', value: 1 },
        randseed: 0,
      },
      events: [],
    } as any

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const nextBoundary = quantizeToNextBar(this.currentSec + 1e-9, baseSeq, this.ir)
      if (nextBoundary > endTarget) {
        this.currentSec = endTarget
        break
      }

      // 到達: 小節頭
      this.currentSec = nextBoundary

      // Jump優先（適用したら今回の進行は終了）
      if (this.pendingJumpBar !== null) {
        const targetSec = barIndexToSeconds(this.pendingJumpBar, baseSeq, this.ir)
        this.currentSec = targetSec
        this.pendingJumpBar = null
        return
      }

      // Loop
      if (this.loop && this.loop.enabled) {
        const startSec = barIndexToSeconds(this.loop.startBar, baseSeq, this.ir)
        const endSec = barIndexToSeconds(this.loop.endBar, baseSeq, this.ir)
        if (this.currentSec >= endSec) {
          this.currentSec = startSec
          // ループ適用後は今回の進行を終了
          return
        }
      }
    }
  }

  /**
   * オフラインで全イベントをスケジュールし、timeMs付きのMIDIメッセージ列を返す
   * - ループやトランスポートは未対応（Phase3-min）
   */
  renderOffline(): MidiMessage[] {
    const messages: MidiMessage[] = []

    for (const seq of this.ir.sequences) {
      const seqMsgs = this.renderSequence(seq)
      messages.push(...seqMsgs)
    }

    // 時間でソート
    messages.sort((a, b) => a.timeMs - b.timeMs)
    return messages
  }

  private renderSequence(seq: SequenceIR): MidiMessage[] {
    const msgs: MidiMessage[] = []
    const converter = new PitchConverter(seq.config)

    let tSec = 0
    for (const ev of seq.events) {
      switch (ev.kind) {
        case 'note': {
          const durSec = durationToSeconds(ev.dur, seq, this.ir)
          for (const pitch of ev.pitches) {
            const midi = converter.convertPitch(pitch)
            // PitchBend（必要なら）
            if (midi.pitchBend !== 0) {
              msgs.push(makePitchBend(tSec, midi.channel, midi.pitchBend))
            }
            // NoteOn/Off
            msgs.push(makeNoteOn(tSec, midi.channel, midi.note, 100))
            msgs.push(makeNoteOff(tSec + durSec, midi.channel, midi.note, 0))
          }
          tSec += durSec
          break
        }
        case 'chord': {
          // グループ音価は内部最大
          let groupDurSec = 0
          for (const n of ev.notes) {
            groupDurSec = Math.max(groupDurSec, durationToSeconds(n.dur, seq, this.ir))
          }
          for (const n of ev.notes) {
            const durSec = durationToSeconds(n.dur, seq, this.ir)
            const midi = converter.convertPitch(n.pitch)
            if (midi.pitchBend !== 0) {
              msgs.push(makePitchBend(tSec, midi.channel, midi.pitchBend))
            }
            msgs.push(makeNoteOn(tSec, midi.channel, midi.note, 100))
            msgs.push(makeNoteOff(tSec + durSec, midi.channel, midi.note, 0))
          }
          tSec += groupDurSec
          break
        }
        case 'rest': {
          const durSec = durationToSeconds(ev.dur, seq, this.ir)
          tSec += durSec
          break
        }
      }
    }

    return msgs.map((m) => ({ ...m, timeMs: Math.round(m.timeMs) }))
  }

  /**
   * [windowStartMs, windowEndMs) に入るメッセージを収集
   */
  collectWindow(windowStartMs: number, windowEndMs: number): MidiMessage[] {
    const all = this.renderOffline()
    const start = Math.max(0, Math.floor(windowStartMs))
    const end = Math.max(start, Math.floor(windowEndMs))
    // Solo/Mute チャンネルフィルタ
    let allowedChannels: Set<number> | null = null
    if (this.soloSequences.size > 0) {
      allowedChannels = new Set<number>()
      for (const seq of this.ir.sequences) {
        if (this.soloSequences.has(seq.config.name)) allowedChannels.add(seq.config.channel)
      }
    } else if (this.mutedSequences.size > 0) {
      allowedChannels = new Set<number>()
      for (const seq of this.ir.sequences) {
        if (!this.mutedSequences.has(seq.config.name)) allowedChannels.add(seq.config.channel)
      }
    }

    return all.filter((m) => {
      if (m.timeMs < start || m.timeMs >= end) return false
      if (allowedChannels) {
        const ch = (m.status & 0x0f) + 1 // 1-16
        return allowedChannels.has(ch)
      }
      return true
    })
  }

  /**
   * 内部の scheduledUntilMs から endMs までのイベントを送り出す（即時送信）
   */
  scheduleThrough(endMs: number) {
    const start = this.scheduledUntilMs
    const end = Math.max(endMs, start)
    const windowMsgs = this.collectWindow(start, end)
    for (const m of windowMsgs) {
      const key = `${m.timeMs}-${m.status}-${m.data1}-${m.data2}`
      if (this.sentSet.has(key)) continue
      this.out.send(m)
      this.sentSet.add(key)
    }
    this.scheduledUntilMs = end
  }
}

// ---------- utils ----------

export function durationToSeconds(d: DurationSpec, seq: SequenceIR, ir?: IR): number {
  const tempo = seq.config.tempo ?? thisTempoFallback()
  const n = seq.config.meter?.n ?? 4
  const dDen = seq.config.meter?.d ?? 4
  const secPerQuarter = 60 / tempo // BPMは四分音符を基準
  const secPerDenNote = (4 / dDen) * secPerQuarter // 拍子分母=1 の基準

  switch (d.kind) {
    case 'sec':
      return d.value
    case 'unit':
      return d.value * secPerDenNote
    case 'percent': {
      // shared: グローバルメーターのバー長を使用
      // independent: シーケンス自身のメーターでバー長を計算
      let barSeconds = n * secPerDenNote
      const align = seq.config.meter?.align ?? ir?.global.meter.align
      if (align === 'shared' && ir) {
        const gn = ir.global.meter.n
        const gd = ir.global.meter.d
        const secPerGlobalDen = (4 / gd) * secPerQuarter
        barSeconds = gn * secPerGlobalDen
      }
      return (d.percent / 100) * (d.bars * barSeconds)
    }
    case 'tuplet': {
      const base = durationToSeconds(d.base, seq, ir)
      return base * (d.b / d.a)
    }
  }
}

/** シーケンス1小節の秒数（sharedならグローバルメーター） */
export function barDurationSeconds(seq: SequenceIR, ir?: IR): number {
  const tempo = seq.config.tempo ?? thisTempoFallback()
  const secPerQuarter = 60 / tempo
  const align = seq.config.meter?.align ?? ir?.global.meter.align ?? 'shared'
  const n = align === 'shared' && ir ? ir.global.meter.n : (seq.config.meter?.n ?? 4)
  const d = align === 'shared' && ir ? ir.global.meter.d : (seq.config.meter?.d ?? 4)
  const secPerDenNote = (4 / d) * secPerQuarter
  return n * secPerDenNote
}

/** 現在秒から、次の小節頭までを返す（Quantized Apply用） */
export function quantizeToNextBar(currentSec: number, seq: SequenceIR, ir?: IR): number {
  const barSec = barDurationSeconds(seq, ir)
  if (barSec <= 0) return currentSec
  const bars = Math.ceil(currentSec / barSec)
  return bars * barSec
}

/** n小節目の先頭の秒位置（0始まり想定: barIndex=0 -> 0sec） */
export function barIndexToSeconds(barIndex: number, seq: SequenceIR, ir?: IR): number {
  const barSec = barDurationSeconds(seq, ir)
  return Math.max(0, barIndex) * barSec
}

export type LoopWindow = { enabled: boolean; startBar: number; endBar: number }

/** 次の小節頭でLoopを適用する際の適用時刻（秒）を返す */
export function computeLoopApplyTime(currentSec: number, seq: SequenceIR, ir?: IR): number {
  return quantizeToNextBar(currentSec, seq, ir)
}

/** 次の小節頭でJumpを適用する計画 */
export function planJump(
  currentSec: number,
  targetBar: number,
  seq: SequenceIR,
  ir?: IR,
): { applyAtSec: number; jumpToSec: number } {
  const applyAtSec = quantizeToNextBar(currentSec, seq, ir)
  const jumpToSec = barIndexToSeconds(targetBar, seq, ir)
  return { applyAtSec, jumpToSec }
}

function thisTempoFallback(): number {
  return 120
}

function makeNoteOn(tSec: number, ch: number, note: number, vel: number): MidiMessage {
  const status = 0x90 | ((ch - 1) & 0x0f)
  return {
    timeMs: Math.round(tSec * 1000),
    status,
    data1: note & 0x7f,
    data2: vel & 0x7f,
  }
}

function makeNoteOff(tSec: number, ch: number, note: number, vel: number): MidiMessage {
  const status = 0x80 | ((ch - 1) & 0x0f)
  return {
    timeMs: Math.round(tSec * 1000),
    status,
    data1: note & 0x7f,
    data2: vel & 0x7f,
  }
}

function makePitchBend(tSec: number, ch: number, bend: number): MidiMessage {
  // bend: -8192..+8191 → 14bit 0..16383 with 8192 center
  const value14 = Math.max(0, Math.min(16383, bend + 8192))
  const lsb = value14 & 0x7f
  const msb = (value14 >> 7) & 0x7f
  const status = 0xe0 | ((ch - 1) & 0x0f)
  return { timeMs: Math.round(tSec * 1000), status, data1: lsb, data2: msb }
}
