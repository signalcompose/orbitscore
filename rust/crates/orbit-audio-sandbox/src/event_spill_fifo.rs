//! child→host event 転送窓から溢れた event の固定容量 FIFO。
//!
//! producer と consumer は同一の RT render スレッドである。overflow policy は FIFO に空きが
//! ある限り lossless な全順序で次ブロックへ持ち越し、FIFO 自体が尽きた場合だけ drop-newest と
//! する。drop した `NoteEnd` は sticky flag で保護する。可視化は [`EventSpillFifo::push`] の
//! `false` と [`EventSpillFifo::take_note_end_dropped`] を契機に、呼び出し側が
//! `SharedRegion::output_event_dropped_count` / `output_note_end_dropped_count` を増分する。

use crate::events::{EventRecord, NeutralEvent, VoiceAddr};

/// child 側 spill FIFO の固定 slot 数。
pub const EVENT_SPILL_CAPACITY: usize = 65_536;

/// child 側の固定容量 event spill FIFO。
pub struct EventSpillFifo {
    slots: Vec<EventRecord>,
    head: usize,
    len: usize,
    note_end_dropped: bool,
}

impl EventSpillFifo {
    /// 起動時に全 slot を確保する。非 RT 初期化専用。
    pub fn new() -> Self {
        let empty = EventRecord::encode(&NeutralEvent::NoteChoke {
            sample_offset: 0,
            addr: VoiceAddr::WILDCARD,
        });
        Self {
            slots: vec![empty; EVENT_SPILL_CAPACITY],
            head: 0,
            len: 0,
            note_end_dropped: false,
        }
    }

    /// 窓に載らなかった plugin out-event を FIFO 末尾へ追加する。
    ///
    /// 満杯なら drop-newest として `false` を返し、`NoteEnd` なら sticky flag も立てる。
    /// construction 後は alloc/lock/syscall を行わない。
    pub fn push(&mut self, ev: EventRecord) -> bool {
        if self.len == EVENT_SPILL_CAPACITY {
            if matches!(ev.decode(), Some(NeutralEvent::NoteEnd { .. })) {
                self.note_end_dropped = true;
            }
            return false;
        }

        let tail = (self.head + self.len) % EVENT_SPILL_CAPACITY;
        self.slots[tail] = ev;
        self.len += 1;
        true
    }

    /// 前ブロックから spill した event を FIFO 先頭から転送窓へ詰める。
    ///
    /// RT-safe: 固定領域だけを読み書きし、alloc/lock/syscall を行わない。配送先は後続ブロック
    /// なので、転記した event の `sample_offset` はすべてブロック先頭 `0` にクランプする。
    /// 戻り値以降へ当ブロックの plugin out-event を直接追記し、載らない残りだけを [`Self::push`]
    /// すれば、spill → current → 新規 spill の全順序が保たれる。
    pub fn drain_into_window(&mut self, window: &mut [EventRecord]) -> usize {
        let count = self.len.min(window.len());
        for out in &mut window[..count] {
            *out = self.slots[self.head];
            out.sample_offset = 0;
            self.head = (self.head + 1) % EVENT_SPILL_CAPACITY;
        }
        self.len -= count;
        count
    }

    /// `NoteEnd` drop の有無を取得して sticky flag をクリアする。
    pub fn take_note_end_dropped(&mut self) -> bool {
        std::mem::take(&mut self.note_end_dropped)
    }

    /// 現在保持している spill event 数。
    pub fn len(&self) -> usize {
        self.len
    }

    /// FIFO が空か。
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl Default for EventSpillFifo {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::MAX_EVENTS_PER_BLOCK;

    fn midi_record(sample_offset: u32) -> EventRecord {
        EventRecord::encode(&NeutralEvent::MidiRaw {
            sample_offset,
            port_index: 0,
            data: [0x90, 60, 100],
        })
    }

    fn note_end_record(sample_offset: u32) -> EventRecord {
        EventRecord::encode(&NeutralEvent::NoteEnd {
            sample_offset,
            addr: VoiceAddr::WILDCARD,
        })
    }

    fn ordered_record(note_id: i32, sample_offset: u32) -> EventRecord {
        EventRecord::encode(&NeutralEvent::NoteChoke {
            sample_offset,
            addr: VoiceAddr {
                note_id,
                ..VoiceAddr::WILDCARD
            },
        })
    }

    fn note_id(ev: &EventRecord) -> i32 {
        match ev.decode() {
            Some(NeutralEvent::NoteChoke { addr, .. }) => addr.note_id,
            _ => panic!("NoteChoke でない event"),
        }
    }

    #[test]
    fn spillover_preserves_order_and_clamps_delivery_offset() {
        let mut fifo = EventSpillFifo::new();
        let total = MAX_EVENTS_PER_BLOCK + 23;
        for i in 0..total {
            assert!(fifo.push(ordered_record(i as i32, (i + 1) as u32)));
        }

        let mut first = vec![ordered_record(-1, 99); MAX_EVENTS_PER_BLOCK];
        assert_eq!(fifo.drain_into_window(&mut first), MAX_EVENTS_PER_BLOCK);
        assert!(first.iter().all(|ev| ev.sample_offset == 0));
        for (i, ev) in first.iter().enumerate() {
            assert_eq!(note_id(ev), i as i32);
        }
        assert_eq!(fifo.len(), 23);

        let mut second = vec![ordered_record(-1, 99); MAX_EVENTS_PER_BLOCK];
        assert_eq!(fifo.drain_into_window(&mut second), 23);
        assert!(second[..23].iter().all(|ev| ev.sample_offset == 0));
        assert!(fifo.is_empty());
        for (i, ev) in second[..23].iter().enumerate() {
            assert_eq!(note_id(ev), (MAX_EVENTS_PER_BLOCK + i) as i32);
        }
    }

    #[test]
    fn per_block_sequence_keeps_spill_before_current_events() {
        let mut fifo = EventSpillFifo::new();
        assert!(fifo.push(midi_record(10)));
        assert!(fifo.push(midi_record(11)));
        let mut window = [midi_record(99); 4];
        let used = fifo.drain_into_window(&mut window);
        window[used] = midi_record(20);
        window[used + 1] = midi_record(21);
        assert_eq!(used, 2);
        assert_eq!(window[0].sample_offset, 0);
        assert_eq!(window[1].sample_offset, 0);
        assert_eq!(window[2].sample_offset, 20);
        assert_eq!(window[3].sample_offset, 21);
    }

    #[test]
    fn exhaustion_drops_newest_and_reports_note_end() {
        let mut fifo = EventSpillFifo::new();
        for i in 0..EVENT_SPILL_CAPACITY {
            assert!(fifo.push(midi_record(i as u32)));
        }
        assert!(!fifo.push(midi_record(1)));
        assert!(!fifo.take_note_end_dropped());
        assert!(!fifo.push(note_end_record(2)));
        assert!(fifo.take_note_end_dropped());
        assert!(!fifo.take_note_end_dropped());
    }
}
