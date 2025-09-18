export type Fraction = { num: number; den: number }; // 分母は 2/3/5 素因数に限定
export type TimeUnit = "sec" | "unit" | "percent" | "tuplet";
export type DurationSpec =
  | { kind: "sec"; value: number } // 秒
  | { kind: "unit"; value: number } // U1=拍子の分母を1とする単位
  | { kind: "percent"; percent: number; bars: number } // n小節に対する%
  | { kind: "tuplet"; a: number; b: number; base: DurationSpec }; // a:b 連符（baseに掛ける）

export type PitchSpec = {
  degree: number; // 0..12 (0 は休符), 1..12 はキーから音高に
  detune?: number; // セント/半音単位の浮動 (半音=1)
  octaveShift?: number; // +1,-1 など
};

export type SequenceEvent =
  | { kind: "note"; pitches: PitchSpec[]; dur: DurationSpec }
  | { kind: "chord"; notes: { pitch: PitchSpec; dur: DurationSpec }[] }
  | { kind: "rest"; dur: DurationSpec };

export type MeterAlign = "shared" | "independent"; // 小節線共有 or 回り込み

export type SequenceConfig = {
  name: string;
  bus: string; // IAC Bus 名
  channel: number; // MIDI ch
  key?: string; // C, Db, D...
  tempo?: number; // BPM（優先）
  meter?: { n: number; d: number; align?: MeterAlign };
  octave?: number; // 基本オクターブ（例: 4.0）
  octmul?: number; // オクターブ係数（1.0 が標準）
  bendRange?: number; // ピッチベンド半音幅（デフォ 2）
  mpe?: boolean; // MPE 使用（同時音の微分を安全に）
  defaultDur?: DurationSpec;
  randseed?: number; // 乱数シード（rサフィックス用）
};

export type GlobalConfig = {
  key: string; // デフォルトキー
  tempo: number; // デフォルト BPM
  meter: { n: number; d: number; align: MeterAlign };
  randseed?: number;
};

export type SequenceIR = {
  config: Required<SequenceConfig>;
  events: SequenceEvent[];
};

export type IR = {
  global: Required<GlobalConfig>;
  sequences: SequenceIR[];
};
