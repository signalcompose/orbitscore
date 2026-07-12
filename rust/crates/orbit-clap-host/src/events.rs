//! イベント seam: 制御スレッド → audio thread via lock-free SPSC ring（A0 §4.2）。

use clack_host::events::event_types::{
    Midi2Event, MidiEvent, NoteChokeEvent, NoteExpressionEvent, NoteExpressionType, NoteOffEvent,
    NoteOnEvent, ParamGestureBeginEvent, ParamGestureEndEvent, ParamModEvent, ParamValueEvent,
};
use clack_host::events::io::EventBuffer;
use clack_host::events::{Event, EventFlags, Match};
use clack_host::prelude::Pckn;
use clack_host::utils::{ClapId, Cookie};
use orbit_audio_sandbox::events::{NeutralEvent, NeutralExpressionId, VoiceAddr};

/// 制御 / ドライバスレッドが audio thread に push できるイベント。
#[derive(Debug, Clone, Copy)]
pub enum PluginEvent {
    NoteOn { key: u8, channel: u8, velocity: f64 },
    NoteOff { key: u8, channel: u8, velocity: f64 },
}

impl PluginEvent {
    /// Converts the legacy host event into the M2 format-neutral representation.
    pub fn to_neutral_event(self, sample_offset: u32, note_port_index: u16) -> NeutralEvent {
        let addr = |key, channel| VoiceAddr {
            note_id: -1,
            port_index: note_port_index as i16,
            channel: channel as i16,
            key: key as i16,
            _pad: 0,
        };
        match self {
            Self::NoteOn {
                key,
                channel,
                velocity,
            } => NeutralEvent::NoteOn {
                sample_offset,
                addr: addr(key, channel),
                velocity,
                tuning_cents: 0.0,
                length_frames: 0,
            },
            Self::NoteOff {
                key,
                channel,
                velocity,
            } => NeutralEvent::NoteOff {
                sample_offset,
                addr: addr(key, channel),
                velocity,
            },
        }
    }
}

/// producer 側の型エイリアス（制御スレッド）。
pub type PluginEventProducer = rtrb::Producer<PluginEvent>;
/// consumer 側の型エイリアス（audio thread）。
pub type PluginEventConsumer = rtrb::Consumer<PluginEvent>;

/// プラグインイベント用の lock-free SPSC ring を生成する。
pub fn make_event_ring(capacity: usize) -> (PluginEventProducer, PluginEventConsumer) {
    rtrb::RingBuffer::new(capacity)
}

fn voice_addr_to_pckn(addr: VoiceAddr) -> Pckn {
    Pckn::new(
        if addr.port_index == -1 {
            Match::All
        } else {
            Match::Specific(addr.port_index as u16)
        },
        if addr.channel == -1 {
            Match::All
        } else {
            Match::Specific(addr.channel as u16)
        },
        if addr.key == -1 {
            Match::All
        } else {
            Match::Specific(addr.key as u16)
        },
        if addr.note_id == -1 {
            Match::All
        } else {
            Match::Specific(addr.note_id as u32)
        },
    )
}

fn clap_param_id(param_id: u64) -> Option<ClapId> {
    u32::try_from(param_id).ok().and_then(ClapId::from_raw)
}

fn expression_type(id: NeutralExpressionId) -> NoteExpressionType {
    match id {
        NeutralExpressionId::Volume => NoteExpressionType::Volume,
        NeutralExpressionId::Pan => NoteExpressionType::Pan,
        NeutralExpressionId::Tuning => NoteExpressionType::Tuning,
        NeutralExpressionId::Vibrato => NoteExpressionType::Vibrato,
        NeutralExpressionId::Expression => NoteExpressionType::Expression,
        NeutralExpressionId::Brightness => NoteExpressionType::Brightness,
        NeutralExpressionId::Pressure => NoteExpressionType::Pressure,
    }
}

/// Translates one format-neutral host-input event into a live CLAP event.
///
/// `PolyPressure` is dropped in M2 v1 because CLAP has neither a dedicated poly-pressure event
/// nor a poly-pressure entry among its seven standardized note-expression types. Output-only
/// `NoteEnd` and `LegacyMidiCcOut` events are likewise rejected.
pub fn push_neutral_event(buf: &mut EventBuffer, ev: &NeutralEvent) -> bool {
    macro_rules! push_live {
        ($event:expr) => {{
            buf.push(&$event.with_flags(EventFlags::IS_LIVE));
            true
        }};
    }

    match *ev {
        NeutralEvent::NoteOn {
            sample_offset,
            addr,
            velocity,
            ..
        } => push_live!(NoteOnEvent::new(
            sample_offset,
            voice_addr_to_pckn(addr),
            velocity
        )),
        NeutralEvent::NoteOff {
            sample_offset,
            addr,
            velocity,
        } => push_live!(NoteOffEvent::new(
            sample_offset,
            voice_addr_to_pckn(addr),
            velocity
        )),
        NeutralEvent::NoteChoke {
            sample_offset,
            addr,
        } => push_live!(NoteChokeEvent::new(sample_offset, voice_addr_to_pckn(addr))),
        NeutralEvent::NoteExpression {
            sample_offset,
            addr,
            expression_id,
            value,
        } => push_live!(NoteExpressionEvent::new(
            sample_offset,
            voice_addr_to_pckn(addr),
            expression_type(expression_id),
            value
        )),
        NeutralEvent::ParamValue {
            sample_offset,
            param_id,
            addr,
            value,
        } => {
            let Some(id) = clap_param_id(param_id) else {
                return false;
            };
            push_live!(ParamValueEvent::new(
                sample_offset,
                id,
                voice_addr_to_pckn(addr),
                value,
                Cookie::empty()
            ))
        }
        NeutralEvent::ParamMod {
            sample_offset,
            param_id,
            addr,
            amount,
        } => {
            let Some(id) = clap_param_id(param_id) else {
                return false;
            };
            push_live!(ParamModEvent::new(
                sample_offset,
                id,
                voice_addr_to_pckn(addr),
                amount,
                Cookie::empty()
            ))
        }
        NeutralEvent::ParamGestureBegin {
            sample_offset,
            param_id,
        } => {
            let Some(id) = clap_param_id(param_id) else {
                return false;
            };
            push_live!(ParamGestureBeginEvent::new(sample_offset, id))
        }
        NeutralEvent::ParamGestureEnd {
            sample_offset,
            param_id,
        } => {
            let Some(id) = clap_param_id(param_id) else {
                return false;
            };
            push_live!(ParamGestureEndEvent::new(sample_offset, id))
        }
        NeutralEvent::MidiRaw {
            sample_offset,
            port_index,
            data,
        } => push_live!(MidiEvent::new(sample_offset, port_index, data)),
        NeutralEvent::Midi2 {
            sample_offset,
            port_index,
            words,
        } => push_live!(Midi2Event::new(sample_offset, port_index, words)),
        NeutralEvent::PolyPressure { .. }
        | NeutralEvent::NoteEnd { .. }
        | NeutralEvent::LegacyMidiCcOut { .. } => false,
    }
}

/// consumer ring を CLAP `EventBuffer` にドレインする。
///
/// A0 §4.2 明示的な simplification: 全イベントのサンプルオフセットは 0（ブロック先頭）。
/// `note_port_index`: プラグインの note 入力ポートインデックス（不明なら 0）。
pub fn drain_to_event_buffer(
    consumer: &mut PluginEventConsumer,
    buf: &mut EventBuffer,
    note_port_index: u16,
) {
    buf.clear();
    while let Ok(ev) = consumer.pop() {
        let neutral = ev.to_neutral_event(0, note_port_index);
        if !push_neutral_event(buf, &neutral) {
            debug_assert!(false, "PluginEvent::NoteOn/NoteOff は常に翻訳可能なはず");
            // debug_assert! is compiled out in release builds — this function has no
            // shm region to bump an error counter in, so an eprintln! is the only way
            // a release build gets any visibility into a dropped event.
            eprintln!(
                "[orbit-clap-host] WARN: drain_to_event_buffer で CLAP 変換に失敗（PluginEvent::NoteOn/NoteOff は常に翻訳可能なはず）"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clack_host::events::spaces::{CoreEventSpace, EventSpaceId};

    fn addr() -> VoiceAddr {
        VoiceAddr {
            note_id: 42,
            port_index: 3,
            channel: 4,
            key: 64,
            _pad: 0,
        }
    }

    fn core(buf: &EventBuffer, index: u32) -> CoreEventSpace<'_> {
        buf.get(index)
            .and_then(|event| event.as_core_event())
            .expect("expected a core event")
    }

    fn assert_common(event: &impl Event, time: u32) {
        assert_eq!(event.time(), time);
        assert_eq!(event.flags(), EventFlags::IS_LIVE);
    }

    #[test]
    fn drain_preserves_legacy_note_on_and_off_semantics() {
        let (mut producer, mut consumer) = make_event_ring(2);
        producer
            .push(PluginEvent::NoteOn {
                key: 60,
                channel: 7,
                velocity: 0.75,
            })
            .unwrap();
        producer
            .push(PluginEvent::NoteOff {
                key: 61,
                channel: 8,
                velocity: 0.25,
            })
            .unwrap();

        let mut buf = EventBuffer::new();
        drain_to_event_buffer(&mut consumer, &mut buf, 9);

        let CoreEventSpace::NoteOn(on) = core(&buf, 0) else {
            panic!("expected note on");
        };
        assert_eq!(on.pckn().port_index, Match::Specific(9));
        assert_eq!(on.pckn().channel, Match::Specific(7));
        assert_eq!(on.pckn().key, Match::Specific(60));
        assert_eq!(on.pckn().note_id, Match::All);
        assert_eq!(on.velocity(), 0.75);
        assert_common(on, 0);

        let CoreEventSpace::NoteOff(off) = core(&buf, 1) else {
            panic!("expected note off");
        };
        assert_eq!(off.pckn().port_index, Match::Specific(9));
        assert_eq!(off.pckn().channel, Match::Specific(8));
        assert_eq!(off.pckn().key, Match::Specific(61));
        assert_eq!(off.pckn().note_id, Match::All);
        assert_eq!(off.velocity(), 0.25);
        assert_common(off, 0);
    }

    #[test]
    fn pushes_all_supported_neutral_variants() {
        let events = [
            NeutralEvent::NoteOn {
                sample_offset: 1,
                addr: addr(),
                velocity: 0.1,
                tuning_cents: 12.0,
                length_frames: 20,
            },
            NeutralEvent::NoteOff {
                sample_offset: 2,
                addr: addr(),
                velocity: 0.2,
            },
            NeutralEvent::NoteChoke {
                sample_offset: 3,
                addr: addr(),
            },
            NeutralEvent::NoteExpression {
                sample_offset: 4,
                addr: addr(),
                expression_id: NeutralExpressionId::Pressure,
                value: 0.4,
            },
            NeutralEvent::ParamValue {
                sample_offset: 5,
                param_id: 10,
                addr: addr(),
                value: 0.5,
            },
            NeutralEvent::ParamMod {
                sample_offset: 6,
                param_id: 11,
                addr: addr(),
                amount: 0.6,
            },
            NeutralEvent::ParamGestureBegin {
                sample_offset: 7,
                param_id: 12,
            },
            NeutralEvent::ParamGestureEnd {
                sample_offset: 8,
                param_id: 13,
            },
            NeutralEvent::MidiRaw {
                sample_offset: 9,
                port_index: 14,
                data: [0x90, 60, 100],
            },
            NeutralEvent::Midi2 {
                sample_offset: 10,
                port_index: 15,
                words: [1, 2, 3, 4],
            },
        ];
        let mut buf = EventBuffer::new();
        for event in &events {
            assert!(push_neutral_event(&mut buf, event));
        }

        let CoreEventSpace::NoteOn(event) = core(&buf, 0) else {
            panic!()
        };
        assert_eq!(event.velocity(), 0.1);
        assert_eq!(event.pckn(), voice_addr_to_pckn(addr()));
        assert_common(event, 1);
        let CoreEventSpace::NoteOff(event) = core(&buf, 1) else {
            panic!()
        };
        assert_eq!(event.velocity(), 0.2);
        assert_common(event, 2);
        let CoreEventSpace::NoteChoke(event) = core(&buf, 2) else {
            panic!()
        };
        assert_eq!(event.pckn(), voice_addr_to_pckn(addr()));
        assert_common(event, 3);
        let CoreEventSpace::NoteExpression(event) = core(&buf, 3) else {
            panic!()
        };
        assert_eq!(event.expression_type(), Some(NoteExpressionType::Pressure));
        assert_eq!(event.value(), 0.4);
        assert_common(event, 4);
        let CoreEventSpace::ParamValue(event) = core(&buf, 4) else {
            panic!()
        };
        assert_eq!(event.param_id(), ClapId::from_raw(10));
        assert_eq!(event.value(), 0.5);
        assert_common(event, 5);
        let CoreEventSpace::ParamMod(event) = core(&buf, 5) else {
            panic!()
        };
        assert_eq!(event.param_id(), ClapId::from_raw(11));
        assert_eq!(event.amount(), 0.6);
        assert_common(event, 6);
        // clack f874e85 omits gesture IDs from CoreEventSpace::from_unknown, so use its checked
        // concrete-type downcast instead.
        let event: &ParamGestureBeginEvent = buf
            .get(6)
            .and_then(|event| event.as_event_for_space(EventSpaceId::core()))
            .expect("expected param gesture begin");
        assert_eq!(event.param_id(), ClapId::from_raw(12));
        assert_common(event, 7);
        let event: &ParamGestureEndEvent = buf
            .get(7)
            .and_then(|event| event.as_event_for_space(EventSpaceId::core()))
            .expect("expected param gesture end");
        assert_eq!(event.param_id(), ClapId::from_raw(13));
        assert_common(event, 8);
        let CoreEventSpace::Midi(event) = core(&buf, 8) else {
            panic!()
        };
        assert_eq!(event.port_index(), 14);
        assert_eq!(event.data(), [0x90, 60, 100]);
        assert_common(event, 9);
        let CoreEventSpace::Midi2(event) = core(&buf, 9) else {
            panic!()
        };
        assert_eq!(event.port_index(), 15);
        assert_eq!(event.data(), [1, 2, 3, 4]);
        assert_common(event, 10);
    }

    #[test]
    fn exhaustively_maps_note_expression_types() {
        let cases = [
            (NeutralExpressionId::Volume, NoteExpressionType::Volume),
            (NeutralExpressionId::Pan, NoteExpressionType::Pan),
            (NeutralExpressionId::Tuning, NoteExpressionType::Tuning),
            (NeutralExpressionId::Vibrato, NoteExpressionType::Vibrato),
            (
                NeutralExpressionId::Expression,
                NoteExpressionType::Expression,
            ),
            (
                NeutralExpressionId::Brightness,
                NoteExpressionType::Brightness,
            ),
            (NeutralExpressionId::Pressure, NoteExpressionType::Pressure),
        ];
        for (neutral, clap) in cases {
            assert_eq!(expression_type(neutral), clap);
        }
    }

    #[test]
    fn rejects_unsupported_or_output_only_variants_without_panicking() {
        let mut buf = EventBuffer::new();
        assert!(!push_neutral_event(
            &mut buf,
            &NeutralEvent::PolyPressure {
                sample_offset: 1,
                addr: addr(),
                pressure: 0.5,
            }
        ));
        assert!(!push_neutral_event(
            &mut buf,
            &NeutralEvent::NoteEnd {
                sample_offset: 2,
                addr: addr(),
            }
        ));
        assert!(!push_neutral_event(
            &mut buf,
            &NeutralEvent::LegacyMidiCcOut {
                sample_offset: 3,
                control_number: 1,
                channel: 2,
                value: 3,
                value2: 4,
            }
        ));
        assert_eq!(buf.len(), 0);
    }

    #[test]
    fn clap_param_id_checks_sentinel_and_width_boundaries() {
        assert_eq!(clap_param_id(123).map(ClapId::get), Some(123));
        assert_eq!(clap_param_id(u32::MAX as u64), None);
        assert_eq!(clap_param_id(u32::MAX as u64 + 1), None);
    }
}
