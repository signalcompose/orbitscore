//! host→child event 転送窓の背後に置く固定容量 ring。
//!
//! producer は非 RT の制御スレッド、consumer は RT audio スレッドであり、所有権は呼び出し側が
//! 両者のアクセスを直列化する。overflow policy は ring に空きがある限り lossless に次ブロックへ
//! 持ち越し、ring 自体が尽きた場合だけ drop-newest とする。drop した `NoteOff` / `NoteEnd` は
//! sticky flag で保護し、呼び出し側が次ブロックに note-choke/all-notes-off を側路注入できる。
//! 可視化は [`EventBackingRing::push`] の `false` を契機に、呼び出し側が
//! `SharedRegion::input_event_dropped_count` を増分する。

use crate::events::{EventRecord, NeutralEvent, VoiceAddr};

/// backing ring / spill FIFO に共通する固定 slot 数。
pub const EVENT_BACKING_CAPACITY: usize = 65_536;

/// host 側の固定容量 event backing ring。
pub struct EventBackingRing {
    slots: Vec<EventRecord>,
    head: usize,
    len: usize,
    note_flush_pending: bool,
}

impl EventBackingRing {
    /// 起動時に全 slot を確保する。非 RT 初期化専用。
    pub fn new() -> Self {
        let empty = EventRecord::encode(&NeutralEvent::NoteChoke {
            sample_offset: 0,
            addr: VoiceAddr::WILDCARD,
        });
        Self {
            slots: vec![empty; EVENT_BACKING_CAPACITY],
            head: 0,
            len: 0,
            note_flush_pending: false,
        }
    }

    /// event を末尾へ追加する。満杯なら drop-newest として `false` を返す。
    ///
    /// `NoteOff` / `NoteEnd` の drop 時は note flush の sticky flag も立てる。追加処理は
    /// alloc/lock/syscall を行わない。
    pub fn push(&mut self, ev: EventRecord) -> bool {
        if self.len == EVENT_BACKING_CAPACITY {
            if matches!(
                ev.decode(),
                Some(NeutralEvent::NoteOff { .. } | NeutralEvent::NoteEnd { .. })
            ) {
                self.note_flush_pending = true;
            }
            return false;
        }

        let tail = (self.head + self.len) % EVENT_BACKING_CAPACITY;
        self.slots[tail] = ev;
        self.len += 1;
        true
    }

    /// ring 先頭から `dst.len()` 個まで転記し、転記件数を返す。
    ///
    /// RT-safe: construction 後の固定領域だけを読み書きし、alloc/lock/syscall を行わない。
    /// 窓に載らない要素は ring に残るため、次ブロックへ lossless に持ち越される。
    pub fn drain_into(&mut self, dst: &mut [EventRecord]) -> usize {
        let count = self.len.min(dst.len());
        for out in &mut dst[..count] {
            *out = self.slots[self.head];
            self.head = (self.head + 1) % EVENT_BACKING_CAPACITY;
        }
        self.len -= count;
        count
    }

    /// note flush 要求を取得して sticky flag をクリアする。
    pub fn take_note_flush_pending(&mut self) -> bool {
        std::mem::take(&mut self.note_flush_pending)
    }

    /// 現在保持している event 数。
    pub fn len(&self) -> usize {
        self.len
    }

    /// ring が空か。
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl Default for EventBackingRing {
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

    fn note_off_record(sample_offset: u32) -> EventRecord {
        EventRecord::encode(&NeutralEvent::NoteOff {
            sample_offset,
            addr: VoiceAddr::WILDCARD,
            velocity: 0.0,
        })
    }

    #[test]
    fn spillover_is_lossless_and_deterministic() {
        let mut ring = EventBackingRing::new();
        let total = MAX_EVENTS_PER_BLOCK + 17;
        for i in 0..total {
            assert!(ring.push(midi_record(i as u32)));
        }

        let mut first = vec![midi_record(0); MAX_EVENTS_PER_BLOCK];
        assert_eq!(ring.drain_into(&mut first), MAX_EVENTS_PER_BLOCK);
        assert_eq!(ring.len(), 17);
        for (i, ev) in first.iter().enumerate() {
            assert_eq!(ev.sample_offset, i as u32);
        }

        let mut second = vec![midi_record(0); MAX_EVENTS_PER_BLOCK];
        assert_eq!(ring.drain_into(&mut second), 17);
        assert!(ring.is_empty());
        for (i, ev) in second[..17].iter().enumerate() {
            assert_eq!(ev.sample_offset, (MAX_EVENTS_PER_BLOCK + i) as u32);
        }
    }

    #[test]
    fn exhaustion_drops_newest_and_sets_note_flush_sticky_flag() {
        let mut ring = EventBackingRing::new();
        for i in 0..EVENT_BACKING_CAPACITY {
            assert!(ring.push(midi_record(i as u32)));
        }
        assert!(!ring.push(midi_record(99)));
        assert!(!ring.take_note_flush_pending());
        assert!(!ring.push(note_off_record(100)));
        assert!(ring.take_note_flush_pending());
        assert!(!ring.take_note_flush_pending());

        let mut first = [midi_record(0); 1];
        assert_eq!(ring.drain_into(&mut first), 1);
        assert_eq!(first[0].sample_offset, 0);
    }
}
