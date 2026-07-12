//! M2 instrument IPC substrate — format-neutral event/param の wire 型（§3）。
//!
//! `EventRecord`/`EventPayload` は共有メモリ上に直接置かれる `#[repr(C)]` POD。クラッシュした
//! child が output 側に不正な discriminant を残しうるため、Rust enum として直接 transmute しては
//! いけない（未検証の enum transmute として同じ未定義動作クラス）。`kind: u32` を検証してから
//! 対応する union フィールドだけを読む [`EventRecord::decode`] を必ず経由する。
//!
//! 設計正本: `docs/development/POST_2.0_GAMMA_M2_DESIGN.md` §3。

#![allow(unsafe_code)]

use std::mem::size_of;

/// per-voice / per-event 共通アドレス（wildcard = -1）。
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VoiceAddr {
    /// -1 = wildcard（voice 一意識別・per-voice mod のターゲット）。host 側実装規約: monotone
    /// 採番・再利用しないという規約は、host が実 note_id（`>= 0`）を発行し始めた時点から拘束力を
    /// 持つ条件付き invariant（§4.7）。M2 v1 の host は wildcard（-1）のみを発行するためこの規約を
    /// 自明に満たし、host 側 voice 簿記は `(port_index, channel, key)` 参照カウント方式（§4.7）を
    /// 用いる — monotone note_id には依存しない。output 方向の overflow policy（§4.2）も同様に
    /// monotone note_id 前提ではない。
    pub note_id: i32,
    /// -1 = wildcard（VST3 は busIndex に読み替え）。
    pub port_index: i16,
    /// -1 = wildcard（0..=15 = MIDI1 channel）。
    pub channel: i16,
    /// -1 = wildcard（0..=127 = MIDI1 key）。
    pub key: i16,
    pub _pad: i16,
}

impl VoiceAddr {
    /// 全フィールド wildcard（global 対象・アドレス不問のイベント用）。
    pub const WILDCARD: VoiceAddr = VoiceAddr {
        note_id: -1,
        port_index: -1,
        channel: -1,
        key: -1,
        _pad: 0,
    };
}

// ── kind タグの値（§3 表を transcribe）。EventRecord::kind に生値として置く。
// 未知値は decode() が None を返す（呼び出し側が event_decode_error_count を進める）。
pub const KIND_NOTE_ON: u32 = 0;
pub const KIND_NOTE_OFF: u32 = 1;
pub const KIND_NOTE_CHOKE: u32 = 2;
pub const KIND_NOTE_END: u32 = 3;
pub const KIND_POLY_PRESSURE: u32 = 4;
pub const KIND_NOTE_EXPRESSION: u32 = 5;
pub const KIND_PARAM_VALUE: u32 = 6;
pub const KIND_PARAM_MOD: u32 = 7;
pub const KIND_PARAM_GESTURE_BEGIN: u32 = 8;
pub const KIND_PARAM_GESTURE_END: u32 = 9;
pub const KIND_MIDI_RAW: u32 = 10;
pub const KIND_MIDI2: u32 = 11;
pub const KIND_LEGACY_MIDI_CC_OUT: u32 = 12;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NoteBody {
    pub addr: VoiceAddr,
    pub velocity: f64,
    pub tuning_cents: f32,
    pub length_frames: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct AddrBody {
    pub addr: VoiceAddr,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ExprBody {
    pub addr: VoiceAddr,
    pub value: f64,
    pub expression_id: u32,
    pub _pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ParamBody {
    pub addr: VoiceAddr,
    pub value: f64,
    /// child native format id の zero-extend（host は採番も解釈もしない opaque u64）。
    pub param_id: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GestureBody {
    pub param_id: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MidiBody {
    pub data: [u8; 3],
    pub _pad: u8,
    pub port_index: u16,
    pub _pad2: u16,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Midi2Body {
    pub words: [u32; 4],
    pub port_index: u16,
    pub _pad: u16,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CcOutBody {
    pub control_number: u8,
    pub channel: i8,
    pub value: i8,
    pub value2: i8,
    pub port_index: u16,
    pub _pad: u16,
}

/// ワイヤ payload。全フィールドが POD（全ビットパターン valid）なので、kind 検証後の union
/// 読みは健全（未検証の enum transmute はしない）。
#[repr(C)]
#[derive(Clone, Copy)]
pub union EventPayload {
    pub note: NoteBody,
    pub addr_only: AddrBody,
    pub expr: ExprBody,
    pub param: ParamBody,
    pub gesture: GestureBody,
    pub midi: MidiBody,
    pub midi2: Midi2Body,
    pub cc_out: CcOutBody,
    #[allow(dead_code)]
    raw: [u8; 32],
}

/// 共有メモリ上の1 event record（固定長 POD）。
///
/// ⚠ これを Rust enum として直接 transmute しない。必ず [`EventRecord::decode`] を通す。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct EventRecord {
    /// kind タグの生値。未知値は [`EventRecord::decode`] が `None` を返す。
    pub kind: u32,
    /// block 内オフセット（全 kind 共通ヘッダ）。
    pub sample_offset: u32,
    pub payload: EventPayload,
}

// レイアウトが shm 越しに親子で一致しないと通信が壊れる。§3「サイズ見積りの訂正」を封じる。
const _: () = assert!(size_of::<EventPayload>() == 32);
const _: () = assert!(size_of::<EventRecord>() == 40);

/// note-expression / poly-pressure の意味論 id（v1 スコープ: Custom/Text/Int-value variant 除く）。
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NeutralExpressionId {
    Volume = 0,
    Pan = 1,
    Tuning = 2,
    Vibrato = 3,
    Expression = 4,
    Brightness = 5,
    Pressure = 6,
}

impl NeutralExpressionId {
    /// 範囲外値は `None`（`decode()` が nested enum 検証として使う。§7 受け入れ基準2）。
    fn from_u32(v: u32) -> Option<Self> {
        match v {
            0 => Some(Self::Volume),
            1 => Some(Self::Pan),
            2 => Some(Self::Tuning),
            3 => Some(Self::Vibrato),
            4 => Some(Self::Expression),
            5 => Some(Self::Brightness),
            6 => Some(Self::Pressure),
            _ => None,
        }
    }
}

/// host/child のロジック層が使う ergonomic な enum（shm には直接置かない）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NeutralEvent {
    NoteOn {
        sample_offset: u32,
        addr: VoiceAddr,
        velocity: f64,
        tuning_cents: f32,
        length_frames: i32,
    },
    NoteOff {
        sample_offset: u32,
        addr: VoiceAddr,
        velocity: f64,
    },
    NoteChoke {
        sample_offset: u32,
        addr: VoiceAddr,
    },
    /// ⚠ child→host 方向。
    NoteEnd {
        sample_offset: u32,
        addr: VoiceAddr,
    },
    PolyPressure {
        sample_offset: u32,
        addr: VoiceAddr,
        pressure: f64,
    },
    NoteExpression {
        sample_offset: u32,
        addr: VoiceAddr,
        expression_id: NeutralExpressionId,
        value: f64,
    },
    ParamValue {
        sample_offset: u32,
        param_id: u64,
        addr: VoiceAddr,
        value: f64,
    },
    ParamMod {
        sample_offset: u32,
        param_id: u64,
        addr: VoiceAddr,
        amount: f64,
    },
    ParamGestureBegin {
        sample_offset: u32,
        param_id: u64,
    },
    ParamGestureEnd {
        sample_offset: u32,
        param_id: u64,
    },
    MidiRaw {
        sample_offset: u32,
        port_index: u16,
        data: [u8; 3],
    },
    /// owner 明示で必須（CLAP・AU が直接サポート）。
    Midi2 {
        sample_offset: u32,
        port_index: u16,
        words: [u32; 4],
    },
    /// ⚠ child→host 方向。
    LegacyMidiCcOut {
        sample_offset: u32,
        control_number: u8,
        channel: i8,
        value: i8,
        value2: i8,
    },
    // Sysex は原則C の帰結によりこのホット ring に含めない（§6 Q4）。
}

impl EventRecord {
    /// kind を検証して union の該当 body だけを読む。未知 kind は `None`
    /// （呼び出し側が `event_decode_error_count` を進める — `child_process_error_count` と同パターン）。
    ///
    /// 検証は `kind` タグだけでなく payload 内の nested enum フィールドにも及ぶ（例:
    /// `ExprBody.expression_id` → [`NeutralExpressionId`] への変換。範囲外の値は `kind` 不明と
    /// 同じ扱いで `None` を返す）。
    pub fn decode(&self) -> Option<NeutralEvent> {
        let sample_offset = self.sample_offset;
        match self.kind {
            KIND_NOTE_ON => {
                // SAFETY: kind == KIND_NOTE_ON の場合のみ payload.note が active variant。
                let b = unsafe { self.payload.note };
                Some(NeutralEvent::NoteOn {
                    sample_offset,
                    addr: b.addr,
                    velocity: b.velocity,
                    tuning_cents: b.tuning_cents,
                    length_frames: b.length_frames,
                })
            }
            KIND_NOTE_OFF => {
                let b = unsafe { self.payload.note };
                Some(NeutralEvent::NoteOff {
                    sample_offset,
                    addr: b.addr,
                    velocity: b.velocity,
                })
            }
            KIND_NOTE_CHOKE => {
                let b = unsafe { self.payload.addr_only };
                Some(NeutralEvent::NoteChoke {
                    sample_offset,
                    addr: b.addr,
                })
            }
            KIND_NOTE_END => {
                let b = unsafe { self.payload.addr_only };
                Some(NeutralEvent::NoteEnd {
                    sample_offset,
                    addr: b.addr,
                })
            }
            KIND_POLY_PRESSURE => {
                let b = unsafe { self.payload.expr };
                Some(NeutralEvent::PolyPressure {
                    sample_offset,
                    addr: b.addr,
                    pressure: b.value,
                })
            }
            KIND_NOTE_EXPRESSION => {
                let b = unsafe { self.payload.expr };
                let expression_id = NeutralExpressionId::from_u32(b.expression_id)?;
                Some(NeutralEvent::NoteExpression {
                    sample_offset,
                    addr: b.addr,
                    expression_id,
                    value: b.value,
                })
            }
            KIND_PARAM_VALUE => {
                let b = unsafe { self.payload.param };
                Some(NeutralEvent::ParamValue {
                    sample_offset,
                    param_id: b.param_id,
                    addr: b.addr,
                    value: b.value,
                })
            }
            KIND_PARAM_MOD => {
                let b = unsafe { self.payload.param };
                Some(NeutralEvent::ParamMod {
                    sample_offset,
                    param_id: b.param_id,
                    addr: b.addr,
                    amount: b.value,
                })
            }
            KIND_PARAM_GESTURE_BEGIN => {
                let b = unsafe { self.payload.gesture };
                Some(NeutralEvent::ParamGestureBegin {
                    sample_offset,
                    param_id: b.param_id,
                })
            }
            KIND_PARAM_GESTURE_END => {
                let b = unsafe { self.payload.gesture };
                Some(NeutralEvent::ParamGestureEnd {
                    sample_offset,
                    param_id: b.param_id,
                })
            }
            KIND_MIDI_RAW => {
                let b = unsafe { self.payload.midi };
                Some(NeutralEvent::MidiRaw {
                    sample_offset,
                    port_index: b.port_index,
                    data: b.data,
                })
            }
            KIND_MIDI2 => {
                let b = unsafe { self.payload.midi2 };
                Some(NeutralEvent::Midi2 {
                    sample_offset,
                    port_index: b.port_index,
                    words: b.words,
                })
            }
            KIND_LEGACY_MIDI_CC_OUT => {
                let b = unsafe { self.payload.cc_out };
                Some(NeutralEvent::LegacyMidiCcOut {
                    sample_offset,
                    control_number: b.control_number,
                    channel: b.channel,
                    value: b.value,
                    value2: b.value2,
                })
            }
            _ => None,
        }
    }

    /// 逆変換（host 側の DSL イベント生成 / child 側の応答生成で使用）。
    pub fn encode(ev: &NeutralEvent) -> EventRecord {
        match *ev {
            NeutralEvent::NoteOn {
                sample_offset,
                addr,
                velocity,
                tuning_cents,
                length_frames,
            } => EventRecord {
                kind: KIND_NOTE_ON,
                sample_offset,
                payload: EventPayload {
                    note: NoteBody {
                        addr,
                        velocity,
                        tuning_cents,
                        length_frames,
                    },
                },
            },
            NeutralEvent::NoteOff {
                sample_offset,
                addr,
                velocity,
            } => EventRecord {
                kind: KIND_NOTE_OFF,
                sample_offset,
                payload: EventPayload {
                    note: NoteBody {
                        addr,
                        velocity,
                        tuning_cents: 0.0,
                        length_frames: 0,
                    },
                },
            },
            NeutralEvent::NoteChoke {
                sample_offset,
                addr,
            } => EventRecord {
                kind: KIND_NOTE_CHOKE,
                sample_offset,
                payload: EventPayload {
                    addr_only: AddrBody { addr },
                },
            },
            NeutralEvent::NoteEnd {
                sample_offset,
                addr,
            } => EventRecord {
                kind: KIND_NOTE_END,
                sample_offset,
                payload: EventPayload {
                    addr_only: AddrBody { addr },
                },
            },
            NeutralEvent::PolyPressure {
                sample_offset,
                addr,
                pressure,
            } => EventRecord {
                kind: KIND_POLY_PRESSURE,
                sample_offset,
                payload: EventPayload {
                    expr: ExprBody {
                        addr,
                        value: pressure,
                        expression_id: 0,
                        _pad: 0,
                    },
                },
            },
            NeutralEvent::NoteExpression {
                sample_offset,
                addr,
                expression_id,
                value,
            } => EventRecord {
                kind: KIND_NOTE_EXPRESSION,
                sample_offset,
                payload: EventPayload {
                    expr: ExprBody {
                        addr,
                        value,
                        expression_id: expression_id as u32,
                        _pad: 0,
                    },
                },
            },
            NeutralEvent::ParamValue {
                sample_offset,
                param_id,
                addr,
                value,
            } => EventRecord {
                kind: KIND_PARAM_VALUE,
                sample_offset,
                payload: EventPayload {
                    param: ParamBody {
                        addr,
                        value,
                        param_id,
                    },
                },
            },
            NeutralEvent::ParamMod {
                sample_offset,
                param_id,
                addr,
                amount,
            } => EventRecord {
                kind: KIND_PARAM_MOD,
                sample_offset,
                payload: EventPayload {
                    param: ParamBody {
                        addr,
                        value: amount,
                        param_id,
                    },
                },
            },
            NeutralEvent::ParamGestureBegin {
                sample_offset,
                param_id,
            } => EventRecord {
                kind: KIND_PARAM_GESTURE_BEGIN,
                sample_offset,
                payload: EventPayload {
                    gesture: GestureBody { param_id },
                },
            },
            NeutralEvent::ParamGestureEnd {
                sample_offset,
                param_id,
            } => EventRecord {
                kind: KIND_PARAM_GESTURE_END,
                sample_offset,
                payload: EventPayload {
                    gesture: GestureBody { param_id },
                },
            },
            NeutralEvent::MidiRaw {
                sample_offset,
                port_index,
                data,
            } => EventRecord {
                kind: KIND_MIDI_RAW,
                sample_offset,
                payload: EventPayload {
                    midi: MidiBody {
                        data,
                        _pad: 0,
                        port_index,
                        _pad2: 0,
                    },
                },
            },
            NeutralEvent::Midi2 {
                sample_offset,
                port_index,
                words,
            } => EventRecord {
                kind: KIND_MIDI2,
                sample_offset,
                payload: EventPayload {
                    midi2: Midi2Body {
                        words,
                        port_index,
                        _pad: 0,
                    },
                },
            },
            NeutralEvent::LegacyMidiCcOut {
                sample_offset,
                control_number,
                channel,
                value,
                value2,
            } => EventRecord {
                kind: KIND_LEGACY_MIDI_CC_OUT,
                sample_offset,
                payload: EventPayload {
                    cc_out: CcOutBody {
                        control_number,
                        channel,
                        value,
                        value2,
                        port_index: 0,
                        _pad: 0,
                    },
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // shm 越しレイアウトの回帰検出(§3「サイズ見積りの訂正」・§7 受け入れ基準1)。
    #[test]
    fn payload_and_record_sizes_match_design() {
        assert_eq!(size_of::<EventPayload>(), 32);
        assert_eq!(size_of::<EventRecord>(), 40);
    }

    fn addr(note_id: i32, port_index: i16, channel: i16, key: i16) -> VoiceAddr {
        VoiceAddr {
            note_id,
            port_index,
            channel,
            key,
            _pad: 0,
        }
    }

    // 全13 variant の encode/decode round-trip(§7 受け入れ基準9)。未使用 variant の符号化バグが
    // Phase 3 の child 実装まで潜伏するのを防ぐ。
    #[test]
    fn all_variants_round_trip() {
        let cases = [
            NeutralEvent::NoteOn {
                sample_offset: 12,
                addr: addr(7, 0, 1, 60),
                velocity: 0.8,
                tuning_cents: 3.5,
                length_frames: 4800,
            },
            NeutralEvent::NoteOff {
                sample_offset: 13,
                addr: addr(7, 0, 1, 60),
                velocity: 0.2,
            },
            NeutralEvent::NoteChoke {
                sample_offset: 0,
                addr: addr(-1, 0, -1, -1),
            },
            NeutralEvent::NoteEnd {
                sample_offset: 5,
                addr: addr(7, 0, 1, 60),
            },
            NeutralEvent::PolyPressure {
                sample_offset: 1,
                addr: addr(7, 0, 1, 60),
                pressure: 0.44,
            },
            NeutralEvent::NoteExpression {
                sample_offset: 2,
                addr: addr(7, 0, 1, 60),
                expression_id: NeutralExpressionId::Vibrato,
                value: -0.3,
            },
            NeutralEvent::ParamValue {
                sample_offset: 9,
                param_id: 0xDEAD_BEEF_0001,
                addr: VoiceAddr::WILDCARD,
                value: 0.75,
            },
            NeutralEvent::ParamMod {
                sample_offset: 10,
                param_id: 42,
                addr: addr(7, 0, 1, 60),
                amount: -0.1,
            },
            NeutralEvent::ParamGestureBegin {
                sample_offset: 3,
                param_id: 99,
            },
            NeutralEvent::ParamGestureEnd {
                sample_offset: 4,
                param_id: 99,
            },
            NeutralEvent::MidiRaw {
                sample_offset: 6,
                port_index: 2,
                data: [0x90, 60, 100],
            },
            NeutralEvent::Midi2 {
                sample_offset: 7,
                port_index: 1,
                words: [0x4020_0000, 0x1234_5678, 0, 0],
            },
            NeutralEvent::LegacyMidiCcOut {
                sample_offset: 8,
                control_number: 7,
                channel: 3,
                value: 100,
                value2: 0,
            },
        ];

        for original in cases {
            let record = EventRecord::encode(&original);
            let decoded = record.decode().expect("既知 kind は必ず decode できる");
            assert_eq!(decoded, original, "round-trip で値が変わった: {original:?}");
        }
    }

    // 未知 kind は None + 呼び出し側可視化(event_decode_error_count)の前提。未検証 enum transmute を
    // 行わないこと自体を回帰させる(§7 受け入れ基準2 前半)。
    #[test]
    fn decode_rejects_unknown_kind() {
        let record = EventRecord {
            kind: 0xFFFF_FFFF,
            sample_offset: 0,
            payload: EventPayload { raw: [0u8; 32] },
        };
        assert!(record.decode().is_none());
    }

    // nested enum(expression_id)の範囲外値も同様に None(§7 受け入れ基準2 後半)。kind タグの
    // 検証だけでは防げない未検証変換を、payload 内部でも塞いでいることを確認する。
    #[test]
    fn decode_rejects_out_of_range_expression_id() {
        let record = EventRecord::encode(&NeutralEvent::NoteExpression {
            sample_offset: 0,
            addr: VoiceAddr::WILDCARD,
            expression_id: NeutralExpressionId::Pressure,
            value: 0.5,
        });
        // 有効値では decode できることを確認してから、expression_id を壊す。
        assert!(record.decode().is_some());

        let mut corrupted = record;
        corrupted.payload = EventPayload {
            expr: ExprBody {
                addr: VoiceAddr::WILDCARD,
                value: 0.5,
                expression_id: 99, // NeutralExpressionId の範囲外(0..=6)
                _pad: 0,
            },
        };
        assert!(corrupted.decode().is_none());
    }

    #[test]
    fn voice_addr_wildcard_is_all_minus_one() {
        let w = VoiceAddr::WILDCARD;
        assert_eq!(w.note_id, -1);
        assert_eq!(w.port_index, -1);
        assert_eq!(w.channel, -1);
        assert_eq!(w.key, -1);
    }
}
