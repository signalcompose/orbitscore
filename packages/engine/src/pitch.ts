import type { PitchSpec, SequenceConfig } from "./ir";

// MIDIノートとPitchBendの結果
export type MidiNote = {
  note: number;        // MIDIノート番号 (0-127)
  pitchBend: number;   // PitchBend値 (-8192 to 8191)
  channel: number;     // MIDIチャンネル (1-16)
};

// キーから半音オフセットへの変換
const KEY_TO_SEMITONE: Record<string, number> = {
  "C": 0, "Db": 1, "D": 2, "Eb": 3, "E": 4, "F": 5,
  "Gb": 6, "G": 7, "Ab": 8, "A": 9, "Bb": 10, "B": 11
};

/**
 * 度数をMIDIノート+PitchBendに変換
 * @param pitchSpec 音高仕様
 * @param config シーケンス設定
 * @param channel MIDIチャンネル（MPE使用時は自動割り当て）
 * @returns MIDIノート情報
 */
export function convertDegreeToMidi(
  pitchSpec: PitchSpec,
  config: Required<SequenceConfig>,
  channel: number = 1
): MidiNote {
  // 1. 度数→半音変換
  const semitones = convertDegreeToSemitones(pitchSpec.degree, config.key || "C");
  
  // 2. オクターブ・係数・detune合成
  const finalSemitones = applyOctaveAndDetune(
    semitones,
    pitchSpec,
    config.octave || 4.0,
    config.octmul || 1.0
  );
  
  // 3. MIDIノート+PitchBend変換
  return convertSemitonesToMidi(finalSemitones, config.bendRange || 2, channel);
}

/**
 * 度数を半音に変換
 * @param degree 度数 (0=休符, 1-12=キー基準半音度数)
 * @param key キー (C, Db, D, ...)
 * @returns 半音数
 */
function convertDegreeToSemitones(degree: number, key: string): number {
  if (degree === 0) {
    return 0; // 休符
  }
  
  const keyOffset = KEY_TO_SEMITONE[key] || 0;
  // 度数1 = キーのルート音
  // 度数2 = キーのルート音 + 1半音
  // 度数3 = キーのルート音 + 2半音
  return keyOffset + (degree - 1);
}

/**
 * オクターブ・係数・detuneを適用
 * @param semitones 基本半音数
 * @param pitchSpec 音高仕様
 * @param octave 基本オクターブ
 * @param octmul オクターブ係数
 * @returns 最終半音数
 */
function applyOctaveAndDetune(
  semitones: number,
  pitchSpec: PitchSpec,
  octave: number,
  octmul: number
): number {
  let finalSemitones = semitones;
  
  // オクターブ係数適用（最初に適用）
  finalSemitones *= octmul;
  
  // オクターブシフト適用
  if (pitchSpec.octaveShift !== undefined) {
    finalSemitones += pitchSpec.octaveShift * 12;
  }
  
  // 基本オクターブ適用
  const octaveOffset = (octave + 1) * 12;
  finalSemitones += octaveOffset;
  
  // detune適用
  if (pitchSpec.detune !== undefined) {
    finalSemitones += pitchSpec.detune;
  }
  
  return finalSemitones;
}

/**
 * 半音数をMIDIノート+PitchBendに変換
 * @param semitones 半音数
 * @param bendRange PitchBend範囲（半音）
 * @param channel MIDIチャンネル
 * @returns MIDIノート情報
 */
function convertSemitonesToMidi(
  semitones: number,
  bendRange: number,
  channel: number
): MidiNote {
  // MIDIノート範囲にクランプ
  const clampedSemitones = Math.max(0, Math.min(127, semitones));
  
  // 近傍MIDIノート計算
  const midiNote = Math.round(clampedSemitones);
  
  // PitchBend値計算
  const pitchBendSemitones = semitones - midiNote;
  const pitchBendRange = bendRange * 2; // ±bendRange
  const pitchBendValue = Math.round((pitchBendSemitones / pitchBendRange) * 8191);
  
  // PitchBend値を範囲内にクランプ
  const clampedPitchBend = Math.max(-8192, Math.min(8191, pitchBendValue));
  
  return {
    note: midiNote,
    pitchBend: clampedPitchBend,
    channel
  };
}

/**
 * MPE対応のチャンネル割り当て
 * @param pitchSpecs 音高仕様配列
 * @param config シーケンス設定
 * @param baseChannel ベースチャンネル
 * @returns MIDIノート情報配列
 */
export function convertChordToMidi(
  pitchSpecs: PitchSpec[],
  config: Required<SequenceConfig>,
  baseChannel: number = 1
): MidiNote[] {
  if (!config.mpe) {
    // MPE無効: 全音を同じチャンネルで送信
    return pitchSpecs.map(pitchSpec => 
      convertDegreeToMidi(pitchSpec, config, baseChannel)
    );
  }
  
  // MPE有効: 各音を異なるチャンネルで送信
  return pitchSpecs.map((pitchSpec, index) => {
    const channel = baseChannel + (index % 15); // チャンネル1-15を使用
    return convertDegreeToMidi(pitchSpec, config, channel);
  });
}