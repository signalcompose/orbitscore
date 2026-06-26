//! イベント seam: 制御スレッド → audio thread via lock-free SPSC ring（A0 §4.2）。
//!
//! orbit-clap-spike の events.rs から verbatim 移植。

use clack_host::events::event_types::{NoteOffEvent, NoteOnEvent};
use clack_host::events::io::EventBuffer;
use clack_host::events::{Event, EventFlags, Match};
use clack_host::prelude::Pckn;

/// 制御 / ドライバスレッドが audio thread に push できるイベント。
#[derive(Debug, Clone, Copy)]
pub enum PluginEvent {
    NoteOn { key: u8, channel: u8, velocity: f64 },
    NoteOff { key: u8, channel: u8, velocity: f64 },
}

/// producer 側の型エイリアス（制御スレッド）。
pub type PluginEventProducer = rtrb::Producer<PluginEvent>;
/// consumer 側の型エイリアス（audio thread）。
pub type PluginEventConsumer = rtrb::Consumer<PluginEvent>;

/// プラグインイベント用の lock-free SPSC ring を生成する。
pub fn make_event_ring(capacity: usize) -> (PluginEventProducer, PluginEventConsumer) {
    rtrb::RingBuffer::new(capacity)
}

/// consumer ring を CLAP `EventBuffer` にドレインする。
///
/// A0 §4.2 明示的な simplification: 全イベントのサンプルオフセットは 0（ブロック先頭）。
/// sample-accurate オフセットは S1b+ に先送り。
///
/// `note_port_index`: プラグインの note 入力ポートインデックス（不明なら 0）。
pub fn drain_to_event_buffer(
    consumer: &mut PluginEventConsumer,
    buf: &mut EventBuffer,
    note_port_index: u16,
) {
    buf.clear();
    while let Ok(ev) = consumer.pop() {
        match ev {
            PluginEvent::NoteOn {
                key,
                channel,
                velocity,
            } => {
                buf.push(
                    &NoteOnEvent::new(
                        0, // sample offset: block-start（A0 §4.2 simplification）
                        Pckn::new(note_port_index, channel, key as u16, Match::All),
                        velocity,
                    )
                    .with_flags(EventFlags::IS_LIVE),
                );
            }
            PluginEvent::NoteOff {
                key,
                channel,
                velocity,
            } => {
                buf.push(
                    &NoteOffEvent::new(
                        0, // sample offset: block-start（A0 §4.2 simplification）
                        Pckn::new(note_port_index, channel, key as u16, Match::All),
                        velocity,
                    )
                    .with_flags(EventFlags::IS_LIVE),
                );
            }
        }
    }
}
