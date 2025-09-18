import type { PitchSpec, SequenceConfig } from "./ir";

/**
 * MIDIノート番号とPitchBend値のペア
 */
export type MidiNote = {
  note: number;        // MIDIノート番号 (0-127)
  pitchBend: number;   // PitchBend値 (-8192 〜 +8191)
  channel: number;      // MIDIチャンネル (1-16)
};

/**
 * キーから半音オフセットへのマッピング
 */
const KEY_TO_SEMITONE: Record<string, number> = {
  "C": 0, "Db": 1, "D": 2, "Eb": 3, "E": 4, "F": 5,
  "Gb": 6, "G": 7, "Ab": 8, "A": 9, "Bb": 10, "B": 11
};

/**
 * 度数から半音への変換（キー基準）
 */
function degreeToSemitone(degree: number, key: string): number {
  if (degree === 0) {
    throw new Error("Rest (degree 0) cannot be converted to semitone");
  }
  
  const keyOffset = KEY_TO_SEMITONE[key] || 0;
  // 1..12 はキー基準の半音度数（1→+1半音, 12→+12半音）
  return keyOffset + degree;
}

/**
 * 乱数値を生成（randseedで再現性を保つ）
 */
function generateRandom(seed: number): number {
  // 簡易的な線形合同法
  const a = 1664525;
  const c = 1013904223;
  const m = Math.pow(2, 32);
  return ((a * seed + c) % m) / m;
}

/**
 * 数値に乱数サフィックス 'r' が含まれているかチェック
 */
function hasRandomSuffix(value: string): boolean {
  return value.endsWith('r');
}

/**
 * 乱数値を適用（0〜0.999の範囲）
 */
function applyRandom(value: number, randseed: number): number {
  const random = generateRandom(randseed);
  return value + (random * 0.999);
}

/**
 * PitchConverter: 度数→MIDIノート+PitchBend変換
 */
export class PitchConverter {
  private key: string;
  private octave: number;
  private octmul: number;
  private bendRange: number;
  private mpe: boolean;
  private randseed: number;
  private nextChannel: number;

  constructor(config: Required<SequenceConfig>) {
    this.key = config.key;
    this.octave = config.octave;
    this.octmul = config.octmul;
    this.bendRange = config.bendRange;
    this.mpe = config.mpe;
    this.randseed = config.randseed;
    this.nextChannel = config.channel;
  }

  /**
   * PitchSpecをMIDIノートに変換
   */
  convertPitch(pitch: PitchSpec, originalValue?: string): MidiNote {
    if (pitch.degree === 0) {
      throw new Error("Cannot convert rest (degree 0) to MIDI note");
    }

    let degree = pitch.degree;
    
    // 乱数サフィックスの処理
    if (originalValue && hasRandomSuffix(originalValue)) {
      const numericValue = parseFloat(originalValue.slice(0, -1));
      degree = applyRandom(numericValue, this.randseed);
    }

    // detune を除いた基準半音値（MIDIノート丸めの基準）
    const baseSemitones =
      60 +
      degreeToSemitone(degree, this.key) +
      ((this.octave * this.octmul) * 12) +
      ((pitch.octaveShift ?? 0) * 12);

    // detune を加味した最終半音値
    const finalSemitones = baseSemitones + (pitch.detune ?? 0);

    // MIDIノート番号とPitchBend値に変換
    const midiNote = Math.round(baseSemitones);
    const pitchBendValue = this.semitonesToPitchBend(finalSemitones - midiNote);

    // チャンネル割り当て
    const channel = this.assignChannel();

    return {
      note: Math.max(0, Math.min(127, midiNote)),
      pitchBend: pitchBendValue,
      channel
    };
  }

  /**
   * 半音差をPitchBend値に変換
   */
  private semitonesToPitchBend(semitones: number): number {
    // PitchBend値の範囲: -8192 〜 +8191 にクリップ
    const pitchBendRange = 8192;
    const normalized = semitones / this.bendRange;
    const value = Math.round(normalized * pitchBendRange);
    return Math.max(-8192, Math.min(8191, value));
  }

  /**
   * チャンネル割り当て（MPE対応）
   */
  private assignChannel(): number {
    if (this.mpe) {
      // MPEモード: チャンネル1-15を使用（16は予約）
      const channel = ((this.nextChannel - 1) % 15) + 1;
      this.nextChannel = channel + 1;
      return channel;
    } else {
      // 通常モード: 設定されたチャンネルを使用
      return this.nextChannel;
    }
  }

  /**
   * チャンネル割り当てをリセット
   */
  resetChannelAssignment(): void {
    this.nextChannel = 1;
  }
}