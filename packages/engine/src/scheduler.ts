import type { IR, DurationSpec, SequenceEvent, SequenceIR } from "./ir";
import type { MidiOut, MidiMessage } from "./midi";
import { PitchConverter } from "./pitch";

const LOOK_AHEAD_MS = 50;
const TICK_MS = 5;

/** 共有/独立メーターに対応する再生位置とループを管理し、NoteOn/Off を窓出し */
export class Scheduler {
  private currentSec = 0;
  private loop: LoopWindow | null = null;
  private pendingJumpBar: number | null = null;

  constructor(private out: MidiOut, private ir: IR) {}
  start() {
    // TODO:
    // - グローバル Playhead（Bar:Beat）を進める
    // - Loop 窓 (startBar,endBar,enabled) と Jump/Scene/Mute/Solo を小節頭で反映
    // - shared: 全シーケンスが同じ小節線を共有
    // - independent: 各シーケンスが自分の小節線で回り込み
  }
  stop() {}

  // ----- Transport state helpers (for tests/phase3 minimal) -----
  setCurrentTimeSec(sec: number) { this.currentSec = Math.max(0, sec); }
  getCurrentTimeSec(): number { return this.currentSec; }
  setLoop(window: LoopWindow | null) { this.loop = window; }
  requestJump(targetBar: number) { this.pendingJumpBar = Math.max(0, Math.floor(targetBar)); }

  /**
   * シンプルなトランスポート前進（実時間適用の最小モデル）。
   * - 小節頭で Jump を適用
   * - ループが有効な場合、endBar 到達時に startBar へ巻き戻し
   * - 時間だけを進める（MIDI出力はしない）
   */
  simulateTransportAdvance(durationSec: number) {
    const endTarget = this.currentSec + Math.max(0, durationSec);
    // 量子化に用いるベース: グローバル基準のダミーSequence（shared扱い）
    const baseSeq: SequenceIR = {
      config: {
        name: "__transport__",
        bus: "",
        channel: 1,
        key: this.ir.global.key,
        tempo: this.ir.global.tempo,
        meter: { n: this.ir.global.meter.n, d: this.ir.global.meter.d, align: 'shared' },
        octave: 0, octmul: 1, bendRange: 2, mpe: false,
        defaultDur: { kind: 'unit', value: 1 }, randseed: 0
      },
      events: []
    } as any;

    while (true) {
      const nextBoundary = quantizeToNextBar(this.currentSec + 1e-9, baseSeq, this.ir);
      if (nextBoundary > endTarget) {
        this.currentSec = endTarget;
        break;
      }

      // 到達: 小節頭
      this.currentSec = nextBoundary;

      // Jump優先（適用したら今回の進行は終了）
      if (this.pendingJumpBar !== null) {
        const targetSec = barIndexToSeconds(this.pendingJumpBar, baseSeq, this.ir);
        this.currentSec = targetSec;
        this.pendingJumpBar = null;
        return;
      }

      // Loop
      if (this.loop && this.loop.enabled) {
        const startSec = barIndexToSeconds(this.loop.startBar, baseSeq, this.ir);
        const endSec = barIndexToSeconds(this.loop.endBar, baseSeq, this.ir);
        if (this.currentSec >= endSec) {
          this.currentSec = startSec;
          // ループ適用後は今回の進行を終了
          return;
        }
      }
    }
  }

  /**
   * オフラインで全イベントをスケジュールし、timeMs付きのMIDIメッセージ列を返す
   * - ループやトランスポートは未対応（Phase3-min）
   */
  renderOffline(): MidiMessage[] {
    const messages: MidiMessage[] = [];

    for (const seq of this.ir.sequences) {
      const seqMsgs = this.renderSequence(seq);
      messages.push(...seqMsgs);
    }

    // 時間でソート
    messages.sort((a, b) => a.timeMs - b.timeMs);
    return messages;
  }

  private renderSequence(seq: SequenceIR): MidiMessage[] {
    const msgs: MidiMessage[] = [];
    const converter = new PitchConverter(seq.config);

    let tSec = 0;
    for (const ev of seq.events) {
      switch (ev.kind) {
        case "note": {
          const durSec = durationToSeconds(ev.dur, seq, this.ir);
          for (const pitch of ev.pitches) {
            const midi = converter.convertPitch(pitch);
            // PitchBend（必要なら）
            if (midi.pitchBend !== 0) {
              msgs.push(makePitchBend(tSec, midi.channel, midi.pitchBend));
            }
            // NoteOn/Off
            msgs.push(makeNoteOn(tSec, midi.channel, midi.note, 100));
            msgs.push(makeNoteOff(tSec + durSec, midi.channel, midi.note, 0));
          }
          tSec += durSec;
          break;
        }
        case "chord": {
          // グループ音価は内部最大
          let groupDurSec = 0;
          for (const n of ev.notes) {
            groupDurSec = Math.max(groupDurSec, durationToSeconds(n.dur, seq, this.ir));
          }
          for (const n of ev.notes) {
            const durSec = durationToSeconds(n.dur, seq, this.ir);
            const midi = converter.convertPitch(n.pitch);
            if (midi.pitchBend !== 0) {
              msgs.push(makePitchBend(tSec, midi.channel, midi.pitchBend));
            }
            msgs.push(makeNoteOn(tSec, midi.channel, midi.note, 100));
            msgs.push(makeNoteOff(tSec + durSec, midi.channel, midi.note, 0));
          }
          tSec += groupDurSec;
          break;
        }
        case "rest": {
          const durSec = durationToSeconds(ev.dur, seq, this.ir);
          tSec += durSec;
          break;
        }
      }
    }

    return msgs.map(m => ({ ...m, timeMs: Math.round(m.timeMs) }));
  }

  /**
   * [windowStartMs, windowEndMs) に入るメッセージを収集
   */
  collectWindow(windowStartMs: number, windowEndMs: number): MidiMessage[] {
    const all = this.renderOffline();
    const start = Math.max(0, Math.floor(windowStartMs));
    const end = Math.max(start, Math.floor(windowEndMs));
    return all.filter(m => m.timeMs >= start && m.timeMs < end);
  }
}

// ---------- utils ----------

export function durationToSeconds(d: DurationSpec, seq: SequenceIR, ir?: IR): number {
  const tempo = seq.config.tempo ??  thisTempoFallback(seq);
  const n = seq.config.meter?.n ?? 4;
  const dDen = seq.config.meter?.d ?? 4;
  const secPerQuarter = 60 / tempo; // BPMは四分音符を基準
  const secPerDenNote = (4 / dDen) * secPerQuarter; // 拍子分母=1 の基準

  switch (d.kind) {
    case "sec":
      return d.value;
    case "unit":
      return d.value * secPerDenNote;
    case "percent": {
      // shared: グローバルメーターのバー長を使用
      // independent: シーケンス自身のメーターでバー長を計算
      let barSeconds = n * secPerDenNote;
      const align = seq.config.meter?.align ?? ir?.global.meter.align;
      if (align === 'shared' && ir) {
        const gn = ir.global.meter.n;
        const gd = ir.global.meter.d;
        const secPerGlobalDen = (4 / gd) * secPerQuarter;
        barSeconds = gn * secPerGlobalDen;
      }
      return (d.percent / 100) * (d.bars * barSeconds);
    }
    case "tuplet": {
      const base = durationToSeconds(d.base, seq, ir);
      return base * (d.b / d.a);
    }
  }
}

/** シーケンス1小節の秒数（sharedならグローバルメーター） */
export function barDurationSeconds(seq: SequenceIR, ir?: IR): number {
  const tempo = seq.config.tempo ?? thisTempoFallback(seq);
  const secPerQuarter = 60 / tempo;
  const align = seq.config.meter?.align ?? ir?.global.meter.align ?? 'shared';
  const n = align === 'shared' && ir ? ir.global.meter.n : (seq.config.meter?.n ?? 4);
  const d = align === 'shared' && ir ? ir.global.meter.d : (seq.config.meter?.d ?? 4);
  const secPerDenNote = (4 / d) * secPerQuarter;
  return n * secPerDenNote;
}

/** 現在秒から、次の小節頭までを返す（Quantized Apply用） */
export function quantizeToNextBar(currentSec: number, seq: SequenceIR, ir?: IR): number {
  const barSec = barDurationSeconds(seq, ir);
  if (barSec <= 0) return currentSec;
  const bars = Math.ceil(currentSec / barSec);
  return bars * barSec;
}

/** n小節目の先頭の秒位置（0始まり想定: barIndex=0 -> 0sec） */
export function barIndexToSeconds(barIndex: number, seq: SequenceIR, ir?: IR): number {
  const barSec = barDurationSeconds(seq, ir);
  return Math.max(0, barIndex) * barSec;
}

export type LoopWindow = { enabled: boolean; startBar: number; endBar: number };

/** 次の小節頭でLoopを適用する際の適用時刻（秒）を返す */
export function computeLoopApplyTime(currentSec: number, seq: SequenceIR, ir?: IR): number {
  return quantizeToNextBar(currentSec, seq, ir);
}

/** 次の小節頭でJumpを適用する計画 */
export function planJump(
  currentSec: number,
  targetBar: number,
  seq: SequenceIR,
  ir?: IR
): { applyAtSec: number; jumpToSec: number } {
  const applyAtSec = quantizeToNextBar(currentSec, seq, ir);
  const jumpToSec = barIndexToSeconds(targetBar, seq, ir);
  return { applyAtSec, jumpToSec };
}

function thisTempoFallback(_seq: SequenceIR): number { return 120; }

function makeNoteOn(tSec: number, ch: number, note: number, vel: number): MidiMessage {
  const status = 0x90 | ((ch - 1) & 0x0f);
  return { timeMs: Math.round(tSec * 1000), status, data1: note & 0x7f, data2: vel & 0x7f };
}

function makeNoteOff(tSec: number, ch: number, note: number, vel: number): MidiMessage {
  const status = 0x80 | ((ch - 1) & 0x0f);
  return { timeMs: Math.round(tSec * 1000), status, data1: note & 0x7f, data2: vel & 0x7f };
}

function makePitchBend(tSec: number, ch: number, bend: number): MidiMessage {
  // bend: -8192..+8191 → 14bit 0..16383 with 8192 center
  const value14 = Math.max(0, Math.min(16383, bend + 8192));
  const lsb = value14 & 0x7f;
  const msb = (value14 >> 7) & 0x7f;
  const status = 0xE0 | ((ch - 1) & 0x0f);
  return { timeMs: Math.round(tSec * 1000), status, data1: lsb, data2: msb };
}
