//! Event seam: control → audio thread via lock-free SPSC ring (A0 §4.2).

use clack_host::events::event_types::{NoteOffEvent, NoteOnEvent};
use clack_host::events::io::EventBuffer;
use clack_host::events::{Event, EventFlags, Match};
use clack_host::prelude::Pckn;

/// Events that the control / driver thread can push into the audio thread.
#[derive(Debug, Clone, Copy)]
pub enum PluginEvent {
    NoteOn { key: u8, channel: u8, velocity: f64 },
    NoteOff { key: u8, channel: u8, velocity: f64 },
}

/// Type alias for the producer side (control thread).
pub type PluginEventProducer = rtrb::Producer<PluginEvent>;
/// Type alias for the consumer side (audio thread).
pub type PluginEventConsumer = rtrb::Consumer<PluginEvent>;

/// Creates a new lock-free SPSC ring for plugin events.
pub fn make_event_ring(capacity: usize) -> (PluginEventProducer, PluginEventConsumer) {
    rtrb::RingBuffer::new(capacity)
}

/// Drain the consumer ring into a CLAP `EventBuffer`.
///
/// A0 §4.2 explicit simplification: all events are placed at sample offset 0
/// (block-start). Sample-accurate offsets are deferred to S1b+.
///
/// `note_port_index`: the plugin's note input port index (0 if unknown).
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
                        0, // sample offset: block-start (A0 §4.2 simplification)
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
                        0, // sample offset: block-start (A0 §4.2 simplification)
                        Pckn::new(note_port_index, channel, key as u16, Match::All),
                        velocity,
                    )
                    .with_flags(EventFlags::IS_LIVE),
                );
            }
        }
    }
}
