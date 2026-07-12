//! M2 instrument host: event/transport submit and instrument output bookkeeping.

#![allow(unsafe_code)]

use std::cmp::Ordering;
use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};

use memmap2::MmapMut;

use crate::event_backing_ring::EventBackingRing;
use crate::events::{EventRecord, NeutralEvent, VoiceAddr};
use crate::transport::{
    region_ptr, slot_index, slot_offset, SharedRegion, TransportContext, BUF_LEN, CHANNELS,
    MAX_EVENTS_PER_BLOCK, MAX_FRAMES, SLOTS,
};

/// A practical upper bound for instrument note ports in M2 v1.
///
/// Sixteen ports gives every MIDI channel 128 keys on each of substantially more ports than the
/// current single-port CLAP path, while keeping the fixed, lock-free table at 64 KiB.
pub const MAX_TRACKED_PORTS: usize = 16;
const MIDI_CHANNELS: usize = 16;
const MIDI_KEYS: usize = 128;

/// Host-side voice identity available on the M2 v1 neutral wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct VoiceKey {
    pub port_index: i16,
    pub channel: i16,
    pub key: i16,
}

/// Fixed-capacity, allocation-free observational voice reference counts.
pub struct VoiceTable {
    counts: [[[u16; MIDI_KEYS]; MIDI_CHANNELS]; MAX_TRACKED_PORTS],
}

impl VoiceTable {
    fn new() -> Self {
        Self {
            counts: [[[0; MIDI_KEYS]; MIDI_CHANNELS]; MAX_TRACKED_PORTS],
        }
    }

    fn indices(key: VoiceKey) -> Option<(usize, usize, usize)> {
        let port = usize::try_from(key.port_index).ok()?;
        let channel = usize::try_from(key.channel).ok()?;
        let note = usize::try_from(key.key).ok()?;
        (port < MAX_TRACKED_PORTS && channel < MIDI_CHANNELS && note < MIDI_KEYS)
            .then_some((port, channel, note))
    }

    fn increment(&mut self, key: VoiceKey) {
        if let Some((port, channel, note)) = Self::indices(key) {
            self.counts[port][channel][note] = self.counts[port][channel][note].saturating_add(1);
        }
    }

    fn for_matching(&mut self, addr: VoiceAddr, mut f: impl FnMut(&mut u16)) {
        for port in 0..MAX_TRACKED_PORTS {
            if addr.port_index != -1 && usize::try_from(addr.port_index).ok() != Some(port) {
                continue;
            }
            for channel in 0..MIDI_CHANNELS {
                if addr.channel != -1 && usize::try_from(addr.channel).ok() != Some(channel) {
                    continue;
                }
                for note in 0..MIDI_KEYS {
                    if addr.key == -1 || usize::try_from(addr.key).ok() == Some(note) {
                        f(&mut self.counts[port][channel][note]);
                    }
                }
            }
        }
    }

    fn note_end(&mut self, addr: VoiceAddr) {
        if addr.port_index == -1 || addr.channel == -1 || addr.key == -1 {
            self.for_matching(addr, |count| *count = 0);
        } else if let Some((port, channel, note)) = Self::indices(VoiceKey {
            port_index: addr.port_index,
            channel: addr.channel,
            key: addr.key,
        }) {
            self.counts[port][channel][note] = self.counts[port][channel][note].saturating_sub(1);
        }
    }

    fn choke(&mut self, addr: VoiceAddr) {
        if addr.port_index == -1 || addr.channel == -1 || addr.key == -1 {
            self.for_matching(addr, |count| *count = 0);
        } else if let Some((port, channel, note)) = Self::indices(VoiceKey {
            port_index: addr.port_index,
            channel: addr.channel,
            key: addr.key,
        }) {
            self.counts[port][channel][note] = 0;
        }
    }

    fn reset_all(&mut self) {
        self.counts = [[[0; MIDI_KEYS]; MIDI_CHANNELS]; MAX_TRACKED_PORTS];
    }

    fn live_count(&self, key: VoiceKey) -> u16 {
        Self::indices(key)
            .map(|(port, channel, note)| self.counts[port][channel][note])
            .unwrap_or(0)
    }
}

/// Per-callback observability for the M2 instrument host.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InstrumentBlockOutcome {
    pub submitted: bool,
    pub sticky_note_choke_injected: bool,
}

/// Pipelined production instrument host. Audio output is read one block behind submission.
pub struct PipelinedInstrumentHost {
    region: *mut SharedRegion,
    _owner: Option<MmapMut>,
    event_ring: EventBackingRing,
    voices: VoiceTable,
    last_output_note_end_dropped: u64,
    last_good: Vec<f32>,
    submitted: u64,
    /// Next completed instrument-event sequence is drained independently from audio freshness.
    ///
    /// Instrument children must consume every sequence in order (design document §4.6), so they
    /// publish `seq_tag` for every slot without skipping -- unlike the M1 effect child, whose
    /// latest-jump policy permits skipped sequences. It might seem like this in-order guarantee,
    /// combined with the submit guard (`slot(s)` isn't reused for `s + SLOTS` until
    /// `seq_done >= s`), is enough to guarantee `event_cursor` always observes `seq_tag == next`
    /// before its physical slot gets recycled for a later sequence. **It does not**: the submit
    /// guard only bounds `submitted - seq_done` (the child's completion cursor), not
    /// `submitted - event_cursor` (this host's own drain progress). A host that falls behind on
    /// draining by more than `SLOTS` sequences -- while the child races ahead and legitimately
    /// recycles the slot -- can observe `seq_tag[slot] > next`. The physical slot can genuinely be
    /// recycled before this host drains it. The actual safety net is the `Ordering::Greater` arm
    /// in `process_block`'s drain loop, which detects exactly this recycled-slot race and resyncs
    /// `event_cursor` forward past the unrecoverable gap; it is live recovery logic, not a guard
    /// against an unreachable case.
    ///
    /// A finer-grained version of the same race can occur entirely within a single
    /// `Ordering::Equal` iteration: the initial `seq_tag[slot] == next` check only confirms
    /// freshness at read-start, not across the several unsynchronized reads of
    /// `output_event_count`/`output_events` that follow it. The `Ordering::Equal` arm re-loads
    /// `seq_tag` after applying those reads and falls back to the same recovery if it no longer
    /// matches `next`.
    event_cursor: u64,
    primed: bool,
    pub fresh: u64,
    pub stale: u64,
    pub stall: u64,
    pub frames_clamped: u64,
    /// Count of times the drain loop observed a physical slot already recycled past the
    /// sequence it was trying to read (`seq_tag[slot] > next`): a lag-induced, unrecoverable
    /// bookkeeping gap distinct from `output_note_end_dropped_count`, which is a child-side
    /// spill-FIFO exhaustion. See the `Ordering::Greater` arm in `process_block`'s drain loop.
    pub event_cursor_recycled: u64,
}

// SAFETY: as for PipelinedEffectHost, one audio thread exclusively owns this state and shared
// memory synchronization is performed through SharedRegion atomics. MmapMut is Send.
unsafe impl Send for PipelinedInstrumentHost {}

impl PipelinedInstrumentHost {
    pub fn from_mmap(mmap: MmapMut) -> Self {
        let region = region_ptr(&mmap);
        Self::with_region(region, Some(mmap))
    }

    /// # Safety
    /// `region` must remain a valid, correctly aligned SharedRegion for the host's lifetime.
    pub unsafe fn from_raw(region: *mut SharedRegion) -> Self {
        Self::with_region(region, None)
    }

    fn with_region(region: *mut SharedRegion, owner: Option<MmapMut>) -> Self {
        let last_output_note_end_dropped =
            unsafe { (*region).output_note_end_dropped_count.load(Relaxed) };
        Self {
            region,
            _owner: owner,
            event_ring: EventBackingRing::new(),
            voices: VoiceTable::new(),
            last_output_note_end_dropped,
            last_good: vec![0.0; BUF_LEN],
            submitted: 0,
            event_cursor: 0,
            primed: false,
            fresh: 0,
            stale: 0,
            stall: 0,
            frames_clamped: 0,
            event_cursor_recycled: 0,
        }
    }

    pub fn live_count(&self, key: VoiceKey) -> u16 {
        self.voices.live_count(key)
    }

    pub fn on_child_respawned(&mut self) {
        self.voices.reset_all();
    }

    /// Shared recovery for a physical event slot found recycled out from under the drain loop
    /// (`Ordering::Greater` at loop entry, or the `Ordering::Equal` arm's post-read
    /// revalidation). An unknown number of NoteEnd/NoteChoke events in the gap are
    /// unrecoverable, so reset all voice counts rather than risk under-counting or leaking, then
    /// resync `event_cursor` forward past the gap to `submitted`.
    fn recover_from_recycled_slot(&mut self) {
        self.event_cursor_recycled += 1;
        self.voices.reset_all();
        self.event_cursor = self.submitted;
    }

    pub fn process_block(
        &mut self,
        out: &mut [f32],
        events: &[NeutralEvent],
        transport: TransportContext,
    ) -> InstrumentBlockOutcome {
        let raw = out.len();
        if raw > BUF_LEN {
            self.frames_clamped += 1;
        }
        let n_frames = (raw.min(BUF_LEN) / CHANNELS) as u32;
        let count = n_frames as usize * CHANNELS;
        let region = self.region;

        let backlog_before = self.event_ring.len();
        for event in events {
            if !self.event_ring.push(EventRecord::encode(event)) {
                unsafe {
                    (*region).input_event_dropped_count.fetch_add(1, Relaxed);
                }
            }
        }

        let new_seq = self.submitted + 1;
        let slot_free = new_seq <= SLOTS as u64
            || unsafe { (*region).seq_done.load(Acquire) } >= new_seq - SLOTS as u64;
        let mut outcome = InstrumentBlockOutcome::default();
        // (slot, note_on_scan_start, written): deferred until after the drain loop below, so
        // that a NoteOn submitted THIS call is bookkept after -- not before -- the drain loop's
        // own voice bookkeeping: both `reset_all()` recovery sites (the `Ordering::Greater` arm
        // and the `output_note_end_dropped_count` check) and the `Ordering::Equal` arm's
        // `note_end`/`choke` handling for older, already-completed sequences. Applying the
        // increment first would let bookkeeping meant only for older sequences affect a voice
        // this same call just submitted (e.g. a stale `note_end` for a note that no longer
        // exists silently swallowing the increment via `saturating_sub` instead of leaving the
        // freshly submitted note live). See the `voices.increment` deferred-application site
        // below the drain loop for the corresponding read.
        let mut pending_note_on_scan: Option<(usize, usize, usize)> = None;
        if slot_free {
            let slot = slot_index(new_seq);
            let inject = self.event_ring.take_note_flush_pending();
            let mut written = usize::from(inject);
            unsafe {
                let window = std::slice::from_raw_parts_mut(
                    std::ptr::addr_of_mut!((*region).input_events[slot]) as *mut EventRecord,
                    MAX_EVENTS_PER_BLOCK,
                );
                if inject {
                    window[0] = EventRecord::encode(&NeutralEvent::NoteChoke {
                        sample_offset: 0,
                        addr: VoiceAddr::WILDCARD,
                    });
                }
                let drain_start = written;
                let drained = self.event_ring.drain_into(&mut window[drain_start..]);
                for record in &mut window[drain_start..drain_start + backlog_before.min(drained)] {
                    record.sample_offset = 0;
                }
                written += drained;
                let spilled = self.event_ring.len();
                if spilled != 0 {
                    (*region)
                        .input_event_spilled_count
                        .fetch_add(spilled as u64, Relaxed);
                }
                (*region).input_event_count[slot].store(written as u32, Relaxed);
                std::ptr::addr_of_mut!((*region).transport_context[slot]).write(transport);
                (*region).n_frames[slot].store(n_frames, Relaxed);
                (*region).seq_request.store(new_seq, Release);
            }
            pending_note_on_scan = Some((slot, usize::from(inject), written));
            self.submitted = new_seq;
            outcome.submitted = true;
            outcome.sticky_note_choke_injected = inject;
        } else {
            self.stall += 1;
        }

        let target = self.submitted.saturating_sub(1);
        let ready =
            target >= 1 && unsafe { (*region).seq_tag[slot_index(target)].load(Acquire) } == target;
        if ready {
            let slot = slot_index(target);
            let target_count = (unsafe { (*region).n_frames[slot].load(Relaxed) } as usize)
                .min(MAX_FRAMES)
                * CHANNELS;
            let copy = target_count.min(count);
            unsafe {
                let src =
                    (std::ptr::addr_of!((*region).output) as *const f32).add(slot_offset(target));
                std::ptr::copy_nonoverlapping(src, out.as_mut_ptr(), copy);
            }
            if copy < count {
                out[copy..count].fill(0.0);
            }
            self.last_good[..count].copy_from_slice(&out[..count]);
            self.primed = true;
            self.fresh += 1;
        } else if self.primed {
            out[..count].copy_from_slice(&self.last_good[..count]);
            self.stale += 1;
        } else {
            out[..count].fill(0.0);
        }

        while self.event_cursor < self.submitted {
            let next = self.event_cursor + 1;
            let slot = slot_index(next);
            let seq_tag = unsafe { (*region).seq_tag[slot].load(Acquire) };
            match seq_tag.cmp(&next) {
                Ordering::Less => break,
                Ordering::Greater => {
                    // `seq_tag[slot] > next` means the child has already recycled this slot
                    // for a later sequence before the host's own `event_cursor` caught up to
                    // `next`. The submit guard only bounds `submitted - seq_done` (the
                    // child's completion cursor) by SLOTS — it says nothing about
                    // `submitted - event_cursor` (the host's own drain progress), so this is
                    // reachable under legitimate bursty draining: e.g. several blocks get
                    // submitted before the child starts (or before the host next calls
                    // `process_block`), then the child catches up in a burst and recycles a
                    // slot the host hadn't drained yet. This is not limited to a broken or
                    // uncooperative child. `backlog_catch_up_consumes_every_sequence_exactly_
                    // once_in_order` (orbit-audio-sandbox/tests/instrument_host_integration.rs)
                    // observes this race non-deterministically against a real child (it does not
                    // assert on `event_cursor`, so it doesn't check this arm's recovery). See
                    // `recycled_slot_resyncs_event_cursor_and_resets_voices` in this module's
                    // `tests` for a deterministic repro of this arm and its recovery.
                    //
                    // The output events for `next` (and every sequence between `next` and
                    // `submitted`) are gone — this physical slot's tag only grows from here, so
                    // it will never again equal `next`, and simply breaking would leave
                    // `event_cursor` stuck forever. This mirrors the `output_note_end_dropped_count`
                    // recovery below: an unknown number of NoteEnd/NoteChoke events in the gap are
                    // unrecoverable, so reset all counts rather than risk under-counting or
                    // leaking, then resync `event_cursor` forward past the gap.
                    self.recover_from_recycled_slot();
                    break;
                }
                Ordering::Equal => {
                    unsafe {
                        let event_count = ((*region).output_event_count[slot].load(Relaxed)
                            as usize)
                            .min(MAX_EVENTS_PER_BLOCK);
                        let output_events = std::slice::from_raw_parts(
                            std::ptr::addr_of!((*region).output_events[slot]) as *const EventRecord,
                            event_count,
                        );
                        for record in output_events {
                            match record.decode() {
                                Some(NeutralEvent::NoteEnd { addr, .. }) => {
                                    self.voices.note_end(addr)
                                }
                                Some(NeutralEvent::NoteChoke { addr, .. }) => {
                                    self.voices.choke(addr)
                                }
                                Some(_) => {}
                                None => {
                                    (*region).event_decode_error_count.fetch_add(1, Relaxed);
                                }
                            }
                        }
                    }
                    // Seqlock-style read-then-revalidate. The `seq_tag[slot] == next` check at
                    // the top of this loop iteration only confirms the slot held `next`'s data
                    // *before* the reads above started -- it does not protect the multi-step
                    // read of `output_event_count`/`output_events` that followed, which is
                    // itself unsynchronized. `event_cursor` can lag `submitted` by up to `SLOTS`
                    // (see the field doc above and the `Ordering::Greater` arm), so nothing rules
                    // out the child recycling this same physical slot again inside that narrow
                    // window. Re-load `seq_tag` now: if it no longer reads `next`, the child
                    // *finished* recycling this slot for a later sequence during the read, so the
                    // events decoded above may be torn or belong to a later sequence entirely --
                    // this is the same race as the `Ordering::Greater` arm above, just caught one
                    // iteration later instead of at the next loop entry, so discard any
                    // bookkeeping the read may have applied via the same `reset_all()` recovery
                    // and resync past the gap.
                    //
                    // If it still reads `next`, this only means no *completed* recycle was
                    // observed -- it does not prove the read was torn-free. The wire has no
                    // in-progress marker, so a recycle that started mid-read (overwriting
                    // `output_events`/`output_event_count`) but had not yet reached its own
                    // `seq_tag` store by this point is invisible to this check. That residual gap
                    // is accepted for the same reason the rest of this bookkeeping is
                    // observational-only, never audio-path: `decode()` already validates record
                    // structure, so a torn read either decodes to a valid-looking but wrong event
                    // or fails decode and increments `event_decode_error_count`. This re-check is
                    // a strict narrowing of the race window versus not re-checking at all, not a
                    // full closure of it.
                    if unsafe { (*region).seq_tag[slot].load(Acquire) } == next {
                        self.event_cursor = next;
                    } else {
                        self.recover_from_recycled_slot();
                    }
                }
            }
        }

        let dropped = unsafe { (*region).output_note_end_dropped_count.load(Relaxed) };
        if dropped > self.last_output_note_end_dropped {
            self.voices.reset_all();
        }
        self.last_output_note_end_dropped = dropped;

        // Apply this call's NoteOn increments now, after every `reset_all()` above AND the
        // drain loop's `Ordering::Equal` note_end/choke handling have already run, so
        // bookkeeping meant only for older, already-completed sequences cannot affect a voice
        // this same call just submitted. The events are read back from the shm window written
        // earlier in this call (untouched since nothing else in this function writes
        // `input_events`).
        if let Some((slot, scan_start, written)) = pending_note_on_scan {
            unsafe {
                let window = std::slice::from_raw_parts(
                    std::ptr::addr_of!((*region).input_events[slot]) as *const EventRecord,
                    MAX_EVENTS_PER_BLOCK,
                );
                for record in &window[scan_start..written] {
                    if let Some(NeutralEvent::NoteOn { addr, .. }) = record.decode() {
                        self.voices.increment(VoiceKey {
                            port_index: addr.port_index,
                            channel: addr.channel,
                            key: addr.key,
                        });
                    }
                }
            }
        }

        if count < raw {
            out[count..].fill(0.0);
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_backing_ring::EVENT_BACKING_CAPACITY;
    use crate::transport::REGION_BYTES;

    fn alloc_region() -> *mut SharedRegion {
        assert_eq!(std::mem::size_of::<SharedRegion>(), REGION_BYTES);
        let ptr = unsafe {
            std::alloc::alloc_zeroed(std::alloc::Layout::new::<SharedRegion>()) as *mut SharedRegion
        };
        assert!(!ptr.is_null());
        ptr
    }

    fn transport(tempo_bpm: f64, position: f64) -> TransportContext {
        TransportContext {
            tempo_bpm,
            time_sig_numerator: 7,
            time_sig_denominator: 8,
            is_playing: 1,
            is_looping: 0,
            song_position_beats: position,
        }
    }

    fn addr(port_index: i16, channel: i16, key: i16) -> VoiceAddr {
        VoiceAddr {
            note_id: -1,
            port_index,
            channel,
            key,
            _pad: 0,
        }
    }

    fn midi(offset: u32) -> NeutralEvent {
        NeutralEvent::MidiRaw {
            sample_offset: offset,
            port_index: 0,
            data: [0x90, 60, 100],
        }
    }

    fn note_on(key: i16) -> NeutralEvent {
        NeutralEvent::NoteOn {
            sample_offset: 0,
            addr: addr(0, 1, key),
            velocity: 1.0,
            tuning_cents: 0.0,
            length_frames: -1,
        }
    }

    fn mark_fresh(region: *mut SharedRegion, seq: u64, output_events: &[NeutralEvent]) {
        unsafe {
            let slot = slot_index(seq);
            for (index, event) in output_events.iter().enumerate() {
                (*region).output_events[slot][index] = EventRecord::encode(event);
            }
            (*region).output_event_count[slot].store(output_events.len() as u32, Relaxed);
            (*region).seq_tag[slot].store(seq, Release);
            (*region).seq_done.store(seq, Release);
        }
    }

    #[test]
    fn submit_drains_window_and_preserves_transport_including_zero_tempo() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedInstrumentHost::from_raw(region) };
        let mut out = vec![1.0; 64 * CHANNELS];
        let t1 = transport(123.0, 4.0);
        host.process_block(&mut out, &[midi(3), midi(7)], t1);
        unsafe {
            let slot = slot_index(1);
            assert_eq!((*region).input_event_count[slot].load(Relaxed), 2);
            assert_eq!((*region).input_events[slot][0].decode(), Some(midi(3)));
            assert_eq!((*region).input_events[slot][1].decode(), Some(midi(7)));
            assert_eq!((*region).n_frames[slot].load(Relaxed), 64);
            assert_eq!((*region).transport_context[slot], t1);
        }

        let t2 = transport(0.0, 11.5);
        host.process_block(&mut out, &[midi(9)], t2);
        unsafe {
            let slot = slot_index(2);
            assert_eq!((*region).input_event_count[slot].load(Relaxed), 1);
            assert_eq!((*region).input_events[slot][0].decode(), Some(midi(9)));
            assert_eq!((*region).transport_context[slot], t2);
        }
    }

    #[test]
    fn ring_exhaustion_injects_wildcard_choke_at_window_front() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedInstrumentHost::from_raw(region) };
        let mut out = vec![0.0; CHANNELS];
        let mut events = vec![midi(1); EVENT_BACKING_CAPACITY];
        events.push(NeutralEvent::NoteOff {
            sample_offset: 99,
            addr: addr(0, 0, 60),
            velocity: 0.0,
        });
        let outcome = host.process_block(&mut out, &events, transport(120.0, 0.0));
        assert!(outcome.sticky_note_choke_injected);
        unsafe {
            assert_eq!(
                (*region).input_events[slot_index(1)][0].decode(),
                Some(NeutralEvent::NoteChoke {
                    sample_offset: 0,
                    addr: VoiceAddr::WILDCARD
                })
            );
            assert_eq!((*region).input_event_dropped_count.load(Relaxed), 1);
        }
    }

    #[test]
    fn stall_does_not_pop_event_ring() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedInstrumentHost::from_raw(region) };
        let mut out = vec![0.0; CHANNELS];
        for _ in 0..SLOTS {
            host.process_block(&mut out, &[], transport(120.0, 0.0));
        }
        let stalled = host.process_block(&mut out, &[midi(77)], transport(120.0, 0.0));
        assert!(!stalled.submitted);
        assert_eq!(host.stall, 1);
        unsafe {
            (*region).seq_done.store(1, Release);
        }
        let resumed = host.process_block(&mut out, &[], transport(120.0, 0.0));
        assert!(resumed.submitted);
        unsafe {
            let slot = slot_index(SLOTS as u64 + 1);
            assert_eq!((*region).input_event_count[slot].load(Relaxed), 1);
            assert_eq!((*region).input_events[slot][0].decode(), Some(midi(0)));
        }
    }

    #[test]
    fn voice_counts_increment_decrement_and_wildcard_choke() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedInstrumentHost::from_raw(region) };
        let mut out = vec![0.0; CHANNELS];
        let key60 = VoiceKey {
            port_index: 0,
            channel: 1,
            key: 60,
        };
        let key61 = VoiceKey { key: 61, ..key60 };
        host.process_block(
            &mut out,
            &[note_on(60), note_on(60), note_on(61)],
            transport(120.0, 0.0),
        );
        assert_eq!(host.live_count(key60), 2);
        assert_eq!(host.live_count(key61), 1);
        mark_fresh(
            region,
            1,
            &[NeutralEvent::NoteEnd {
                sample_offset: 0,
                addr: addr(0, 1, 60),
            }],
        );
        host.process_block(&mut out, &[], transport(120.0, 0.0));
        assert_eq!(host.live_count(key60), 1);
        assert_eq!(host.live_count(key61), 1);
        mark_fresh(
            region,
            2,
            &[NeutralEvent::NoteChoke {
                sample_offset: 0,
                addr: VoiceAddr::WILDCARD,
            }],
        );
        host.process_block(&mut out, &[], transport(120.0, 0.0));
        assert_eq!(host.live_count(key60), 0);
        assert_eq!(host.live_count(key61), 0);
    }

    #[test]
    fn specific_choke_clears_only_matching_voice() {
        let mut voices = VoiceTable::new();
        let key60 = VoiceKey {
            port_index: 0,
            channel: 1,
            key: 60,
        };
        let key61 = VoiceKey { key: 61, ..key60 };
        voices.increment(key60);
        voices.increment(key61);

        voices.choke(addr(0, 1, 60));

        assert_eq!(voices.live_count(key60), 0);
        assert_eq!(voices.live_count(key61), 1);
    }

    #[test]
    fn delayed_note_end_is_drained_after_its_audio_target_has_moved_on() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedInstrumentHost::from_raw(region) };
        let mut out = vec![0.0; CHANNELS];
        let key = VoiceKey {
            port_index: 0,
            channel: 1,
            key: 60,
        };

        host.process_block(&mut out, &[note_on(60)], transport(120.0, 0.0));
        assert_eq!(host.live_count(key), 1);

        // Unlike `stall_does_not_pop_event_ring`, submission remains possible while seq 1's
        // target is stale: model a progressed completion guard before its per-slot tag is visible.
        unsafe {
            (*region).seq_done.store(1, Release);
        }
        assert!(
            host.process_block(&mut out, &[], transport(120.0, 0.0))
                .submitted
        );
        assert!(
            host.process_block(&mut out, &[], transport(120.0, 0.0))
                .submitted
        );

        mark_fresh(
            region,
            1,
            &[NeutralEvent::NoteEnd {
                sample_offset: 0,
                addr: addr(0, 1, 60),
            }],
        );
        host.process_block(&mut out, &[], transport(120.0, 0.0));

        assert_eq!(host.live_count(key), 0);
    }

    #[test]
    fn recycled_slot_resyncs_event_cursor_and_resets_voices() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedInstrumentHost::from_raw(region) };
        let mut out = vec![0.0; CHANNELS];
        let key = VoiceKey {
            port_index: 0,
            channel: 1,
            key: 60,
        };

        // Seq 1: increment a voice count so we can observe `reset_all()` firing. The child
        // never writes `seq_tag`, so the drain loop hits `Ordering::Less` and `event_cursor`
        // stays at 0 (mirrors `stall_does_not_pop_event_ring`'s setup).
        host.process_block(&mut out, &[note_on(60)], transport(120.0, 0.0));
        assert_eq!(host.live_count(key), 1);
        assert_eq!(host.event_cursor_recycled, 0);

        // A real child can never publish a `seq_tag` value beyond what the host has
        // authorized via `seq_request` (always `<= submitted`), so poking `seq_tag` straight
        // to `next + SLOTS` while `submitted` is still 1 would be an impossible precondition.
        // Instead, legitimately advance `submitted` to `next + SLOTS` first through real
        // `process_block` submissions, using direct `seq_done` pokes to satisfy the submit
        // guard along the way -- the same technique `delayed_note_end_is_drained_after_its_
        // audio_target_has_moved_on` and `stall_does_not_pop_event_ring` use.
        let next = 1u64;
        let recycled_seq = next + SLOTS as u64;

        // Seq 2 submits freely (new_seq == 2 <= SLOTS).
        assert!(
            host.process_block(&mut out, &[], transport(120.0, 0.0))
                .submitted
        );
        assert_eq!(host.submitted, 2);

        // Seq 3 (== recycled_seq) needs `seq_done >= 3 - SLOTS == 1`; poke it directly to
        // simulate real child completion, matching the pattern already used elsewhere in
        // this file.
        unsafe {
            (*region).seq_done.store(1, Release);
        }
        assert!(
            host.process_block(&mut out, &[], transport(120.0, 0.0))
                .submitted
        );
        assert_eq!(host.submitted, recycled_seq);

        // Seq 4 needs `seq_done >= 4 - SLOTS == 2`; poke it directly for the same reason.
        unsafe {
            (*region).seq_done.store(2, Release);
        }

        // Now that `submitted` has legitimately reached `recycled_seq`, simulate the child
        // having published `seq_tag` for that (fully authorized) sequence into slot
        // `slot_index(next)` -- the same physical slot as `next`, since `slot_index` wraps
        // `% SLOTS`. This models the child having recycled slot 1's physical storage before
        // the host's own `event_cursor` caught up to `next == 1`, which is the race
        // `backlog_catch_up_consumes_every_sequence_exactly_once_in_order` demonstrates
        // non-deterministically against a real child; here we force it directly for a
        // deterministic repro, but from a state a real child could actually reach.
        unsafe {
            (*region).seq_tag[slot_index(next)].store(recycled_seq, Release);
        }

        let outcome = host.process_block(&mut out, &[], transport(120.0, 0.0));
        assert!(outcome.submitted);
        assert_eq!(host.submitted, recycled_seq + 1);

        // `event_cursor` must resync forward past the unrecoverable gap (to `submitted`)
        // rather than stay stuck at its old value of 0.
        assert_eq!(host.event_cursor, host.submitted);
        assert_eq!(host.event_cursor_recycled, 1);
        assert_eq!(host.live_count(key), 0);
    }

    #[test]
    fn dropped_note_end_and_respawn_reset_all_counts() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedInstrumentHost::from_raw(region) };
        let mut out = vec![0.0; CHANNELS];
        let key = VoiceKey {
            port_index: 0,
            channel: 1,
            key: 60,
        };
        host.process_block(&mut out, &[note_on(60)], transport(120.0, 0.0));
        unsafe {
            (*region)
                .output_note_end_dropped_count
                .fetch_add(1, Relaxed);
        }
        host.process_block(&mut out, &[], transport(120.0, 0.0));
        assert_eq!(host.live_count(key), 0);
        unsafe {
            (*region).seq_done.store(1, Release);
        }
        host.process_block(&mut out, &[note_on(60)], transport(120.0, 0.0));
        assert_eq!(host.live_count(key), 1);
        host.on_child_respawned();
        assert_eq!(host.live_count(key), 0);
    }

    #[test]
    fn corrupted_output_record_increments_event_decode_error_count() {
        let region = alloc_region();
        let mut host = unsafe { PipelinedInstrumentHost::from_raw(region) };
        let mut out = vec![0.0; CHANNELS];

        host.process_block(&mut out, &[], transport(120.0, 0.0));

        let mut corrupted = EventRecord::encode(&NeutralEvent::NoteEnd {
            sample_offset: 0,
            addr: addr(0, 1, 60),
        });
        corrupted.kind = u32::MAX;
        unsafe {
            let slot = slot_index(1);
            (*region).output_events[slot][0] = corrupted;
            (*region).output_event_count[slot].store(1, Relaxed);
            (*region).seq_tag[slot].store(1, Release);
            (*region).seq_done.store(1, Release);
        }

        let before = unsafe { (*region).event_decode_error_count.load(Relaxed) };
        // The drain loop only visits slot 1's output events once `event_cursor` catches up to a
        // seq whose `seq_tag` is published, so a second block is required (mirrors
        // `delayed_note_end_is_drained_after_its_audio_target_has_moved_on`).
        host.process_block(&mut out, &[], transport(120.0, 0.0));
        let after = unsafe { (*region).event_decode_error_count.load(Relaxed) };
        assert_eq!(after - before, 1);
    }
}
