//! γ M2 instrument child: event slot を in-order に消費して CLAP instrument を render する。

#![allow(unsafe_code)]

use std::path::PathBuf;
use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};

use anyhow::{bail, Context, Result};
use orbit_audio_sandbox::transport::{CHILD_FLAG_HAS_AUDIO_INPUT, CHILD_STATUS_READY};
use orbit_audio_sandbox::{
    open_shared, region_ptr, slot_index, slot_offset, EventRecord, EventSpillFifo, NeutralEvent,
    SharedRegion, BUF_LEN, CHANNELS, CONTROL_QUIT, MAX_EVENTS_PER_BLOCK, MAX_FRAMES,
};
use orbit_clap_host::{push_neutral_event, ClapInstrumentProcessor, EventBuffer};

struct Args {
    shm: PathBuf,
    plugin: PathBuf,
    plugin_id: Option<String>,
    sample_rate: u32,
}

fn parse_args() -> Result<Args> {
    let mut shm = None;
    let mut plugin = None;
    let mut plugin_id = None;
    let mut sample_rate = 48_000;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--shm" => shm = Some(PathBuf::from(it.next().context("--shm に値が必要")?)),
            "--plugin" => plugin = Some(PathBuf::from(it.next().context("--plugin に値が必要")?)),
            "--plugin-id" => plugin_id = Some(it.next().context("--plugin-id に値が必要")?),
            "--sample-rate" => {
                sample_rate = it
                    .next()
                    .context("--sample-rate に値が必要")?
                    .parse()
                    .context("--sample-rate の parse")?;
            }
            other => bail!("未知の引数: {other}"),
        }
    }
    Ok(Args {
        shm: shm.context("--shm は必須")?,
        plugin: plugin.context("--plugin は必須")?,
        plugin_id,
        sample_rate,
    })
}

fn in_order_seqs(last: u64, cur: u64) -> impl Iterator<Item = u64> {
    last.saturating_add(1)..=cur
}

fn decode_slot_events(records: &[EventRecord], count: u32, sink: &mut Vec<NeutralEvent>) -> u32 {
    sink.clear();
    let count = (count as usize)
        .min(MAX_EVENTS_PER_BLOCK)
        .min(records.len());
    let mut failures = 0;
    for record in &records[..count] {
        if let Some(event) = record.decode() {
            sink.push(event);
        } else {
            failures += 1;
        }
    }
    failures
}

/// Outcome of [`write_output_events`]: how many records landed in `window`, plus the health
/// counter deltas the caller adds to `SharedRegion` after the closure returns.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct OutputWriteOutcome {
    written: usize,
    spilled: u64,
    dropped: u64,
    note_end_dropped: u64,
}

/// Drains previously spilled events into `window`, then appends this block's freshly produced
/// output `events` (already translated to the M2 neutral wire): overflow beyond `window`'s
/// capacity spills into `output_spill`, and only drops (counted in the returned outcome) once
/// both `window` and `output_spill` are exhausted.
///
/// Pure and CLAP-independent (operates on `NeutralEvent`/`EventRecord` only), so it is directly
/// unit-testable without a live plugin -- extracted from `main()`'s per-slot `write_slot` closure
/// for exactly that reason (see `tests::output_window_and_spill_overflow_drops_and_tracks_note_end`).
fn write_output_events(
    window: &mut [EventRecord],
    output_spill: &mut EventSpillFifo,
    events: impl Iterator<Item = NeutralEvent>,
) -> OutputWriteOutcome {
    let mut outcome = OutputWriteOutcome {
        written: output_spill.drain_into_window(window),
        ..Default::default()
    };
    for event in events {
        let record = EventRecord::encode(&event);
        if outcome.written < window.len() {
            window[outcome.written] = record;
            outcome.written += 1;
        } else if output_spill.push(record) {
            outcome.spilled += 1;
        } else {
            outcome.dropped += 1;
            if output_spill.take_note_end_dropped() {
                outcome.note_end_dropped += 1;
            }
        }
    }
    outcome
}

/// Mirrors an [`OutputWriteOutcome`] into `region`'s per-slot output-event health counters
/// (`output_event_spilled_count` / `output_event_dropped_count` / `output_note_end_dropped_count`)
/// and the slot's `output_event_count`.
///
/// Extracted from `main()`'s per-slot `write_slot` closure so the outcome-to-counter mapping is
/// directly unit-testable without a live plugin or child process: a copy-paste field swap at this
/// call site (e.g. `dropped` accidentally added into `output_event_spilled_count`) would otherwise
/// pass every CI-runnable test, since the only prior coverage exercised `write_output_events`'s
/// returned struct in isolation, never the region counters it gets mirrored into (pr-test-analyzer,
/// PR #422 round 2 item 2). Caller must ensure `region` is valid and `idx` is in range.
unsafe fn apply_output_write_outcome(
    region: *mut SharedRegion,
    idx: usize,
    outcome: OutputWriteOutcome,
) {
    unsafe {
        if outcome.spilled != 0 {
            (*region)
                .output_event_spilled_count
                .fetch_add(outcome.spilled, Relaxed);
        }
        if outcome.dropped != 0 {
            (*region)
                .output_event_dropped_count
                .fetch_add(outcome.dropped, Relaxed);
        }
        if outcome.note_end_dropped != 0 {
            (*region)
                .output_note_end_dropped_count
                .fetch_add(outcome.note_end_dropped, Relaxed);
        }
        (*region).output_event_count[idx].store(outcome.written as u32, Relaxed);
    }
}

/// Writes one completed slot, then publishes its sequence with Release ordering.
///
/// `write_slot` must write audio, `output_events`, and `output_event_count`. Their writes must stay
/// before both sequence stores: the host uses `seq_tag`'s Acquire load as the publication edge for
/// all slot payload and then revalidates the tag after reading it.
unsafe fn publish_completed_slot(
    region: *mut SharedRegion,
    seq: u64,
    write_slot: impl FnOnce(*mut SharedRegion),
    after_sequence_publish: impl FnOnce(),
) {
    write_slot(region);
    let idx = slot_index(seq);
    unsafe {
        (*region).seq_tag[idx].store(seq, Release);
        (*region).seq_done.store(seq, Release);
    }
    after_sequence_publish();
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let mmap = open_shared(&args.shm).with_context(|| format!("open_shared({:?})", args.shm))?;
    let region = region_ptr(&mmap);
    let (mut instrument, _info) = ClapInstrumentProcessor::load(
        &args.plugin,
        args.plugin_id.as_deref(),
        args.sample_rate,
        CHANNELS,
        MAX_FRAMES as u32,
    )
    .with_context(|| format!("load CLAP instrument {:?}", args.plugin))?;
    let flags = if instrument.has_audio_input() {
        CHILD_FLAG_HAS_AUDIO_INPUT
    } else {
        0
    };
    // SAFETY: region は host が REGION_BYTES に truncate 済みの共有ファイルを指す。flags を先に
    // publish し、status の Release store を readiness の公開点にする。
    unsafe {
        (*region).child_flags.store(flags, Release);
        (*region).child_status.store(CHILD_STATUS_READY, Release);
    }
    let mut scratch = vec![0.0f32; BUF_LEN];
    // Event window 分を事前確保し、hot loop での buffer 再確保を避ける。
    let mut event_buf = EventBuffer::with_capacity(MAX_EVENTS_PER_BLOCK);
    let mut output_event_buf = EventBuffer::with_capacity(MAX_EVENTS_PER_BLOCK);
    let mut event_scratch: Vec<NeutralEvent> = Vec::with_capacity(MAX_EVENTS_PER_BLOCK);
    let mut output_spill = EventSpillFifo::new();
    let mut process_errors = 0u64;
    // After a supervisor respawn this always restarts from 0, so the child re-processes every
    // historical seq up to the current `seq_request` (no resume-point handshake exists yet).
    // Tracked in #418.
    let mut last = 0u64;

    loop {
        if unsafe { (*region).control.load(Relaxed) } == CONTROL_QUIT {
            break;
        }
        let cur = unsafe { (*region).seq_request.load(Acquire) };
        if cur <= last {
            std::hint::spin_loop();
            continue;
        }
        for seq in in_order_seqs(last, cur) {
            let idx = slot_index(seq);
            let off = slot_offset(seq);
            let n_frames =
                unsafe { ((*region).n_frames[idx].load(Relaxed) as usize).min(MAX_FRAMES) };
            let sample_count = n_frames * CHANNELS;
            let event_count = unsafe {
                (*region).input_event_count[idx]
                    .load(Relaxed)
                    .min(MAX_EVENTS_PER_BLOCK as u32)
            };
            let decode_errors = unsafe {
                decode_slot_events(
                    &(*region).input_events[idx],
                    event_count,
                    &mut event_scratch,
                )
            };
            if decode_errors != 0 {
                unsafe {
                    (*region)
                        .event_decode_error_count
                        .fetch_add(decode_errors as u64, Relaxed);
                }
            }
            event_buf.clear();
            for event in &event_scratch {
                // `false` means this NeutralEvent has no CLAP translation (e.g. PolyPressure,
                // an intentional v1 drop — see orbit-clap-host/src/events.rs). Currently
                // unreachable: the host only ever emits NoteOn/NoteOff/NoteChoke, which always
                // translate. Reuse event_decode_error_count rather than add a new counter, per
                // docs/development/POST_2.0_GAMMA_M2_DESIGN.md §4 ("child can't honor this
                // event" visibility).
                if !push_neutral_event(&mut event_buf, event) {
                    unsafe {
                        (*region).event_decode_error_count.fetch_add(1, Relaxed);
                    }
                }
            }
            scratch[..sample_count].fill(0.0);
            if !instrument.process_block(
                &mut scratch[..sample_count],
                &event_buf,
                &mut output_event_buf,
            ) {
                process_errors += 1;
                unsafe {
                    (*region).child_process_error_count.fetch_add(1, Relaxed);
                }
            }
            unsafe {
                publish_completed_slot(
                    region,
                    seq,
                    |region| {
                        let out_base = std::ptr::addr_of_mut!((*region).output) as *mut f32;
                        std::ptr::copy_nonoverlapping(
                            scratch.as_ptr(),
                            out_base.add(off),
                            sample_count,
                        );
                        let window = std::slice::from_raw_parts_mut(
                            std::ptr::addr_of_mut!((*region).output_events[idx])
                                as *mut EventRecord,
                            MAX_EVENTS_PER_BLOCK,
                        );
                        let translated = (&output_event_buf)
                            .into_iter()
                            .filter_map(ClapInstrumentProcessor::neutral_output_event);
                        let outcome = write_output_events(window, &mut output_spill, translated);
                        apply_output_write_outcome(region, idx, outcome);
                        (*region).child_processed.fetch_add(1, Relaxed);
                    },
                    || {},
                );
            }
        }
        last = cur.max(last);
    }
    if process_errors != 0 {
        eprintln!(
            "[orbit-clap-instrument-child] plugin.process() が {process_errors} ブロックで失敗"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use orbit_audio_sandbox::{
        PipelinedInstrumentHost, TransportContext, VoiceAddr, VoiceKey, EVENT_SPILL_CAPACITY,
    };

    fn note_on(key: i16) -> NeutralEvent {
        NeutralEvent::NoteOn {
            sample_offset: 0,
            addr: VoiceAddr {
                note_id: -1,
                port_index: 0,
                channel: 0,
                key,
                _pad: 0,
            },
            velocity: 1.0,
            tuning_cents: 0.0,
            length_frames: 0,
        }
    }

    #[test]
    fn write_output_events_fills_window_before_spilling() {
        let mut window = vec![EventRecord::encode(&note_on(0)); 4];
        let mut spill = EventSpillFifo::new();
        let events = (0..4u32).map(|i| NeutralEvent::NoteChoke {
            sample_offset: i,
            addr: VoiceAddr::WILDCARD,
        });

        let outcome = write_output_events(&mut window, &mut spill, events);

        assert_eq!(
            outcome,
            OutputWriteOutcome {
                written: 4,
                ..Default::default()
            }
        );
        assert!(spill.is_empty());
        for (i, record) in window.iter().enumerate() {
            assert_eq!(
                record.decode(),
                Some(NeutralEvent::NoteChoke {
                    sample_offset: i as u32,
                    addr: VoiceAddr::WILDCARD,
                })
            );
        }
    }

    #[test]
    fn write_output_events_overflow_spills_into_fifo() {
        let mut window = vec![EventRecord::encode(&note_on(0)); 2];
        let mut spill = EventSpillFifo::new();
        let events = (0..5u32).map(|i| NeutralEvent::NoteChoke {
            sample_offset: i,
            addr: VoiceAddr::WILDCARD,
        });

        let outcome = write_output_events(&mut window, &mut spill, events);

        assert_eq!(
            outcome,
            OutputWriteOutcome {
                written: 2,
                spilled: 3,
                ..Default::default()
            }
        );
        assert_eq!(spill.len(), 3);
    }

    /// Drives the actual window-full -> spill-FIFO-full -> drop path in one call, verifying both
    /// the generic drop counter and the NoteEnd-specific drop tracking
    /// (`EventSpillFifo::take_note_end_dropped`) that the host's voice-bookkeeping recovery
    /// depends on (see `output_note_end_dropped_count` in `orbit-audio-sandbox/src/instrument_host.rs`).
    #[test]
    fn window_and_spill_overflow_drops_and_tracks_note_end() {
        let mut window = vec![EventRecord::encode(&note_on(0)); MAX_EVENTS_PER_BLOCK];
        let mut spill = EventSpillFifo::new();

        let fillers = (0..(MAX_EVENTS_PER_BLOCK + EVENT_SPILL_CAPACITY) as u32).map(|i| {
            NeutralEvent::NoteChoke {
                sample_offset: i,
                addr: VoiceAddr::WILDCARD,
            }
        });
        let overflow_note_end = std::iter::once(NeutralEvent::NoteEnd {
            sample_offset: 0,
            addr: VoiceAddr::WILDCARD,
        });

        let outcome =
            write_output_events(&mut window, &mut spill, fillers.chain(overflow_note_end));

        assert_eq!(outcome.written, MAX_EVENTS_PER_BLOCK);
        assert_eq!(outcome.spilled, EVENT_SPILL_CAPACITY as u64);
        assert_eq!(
            outcome.dropped, 1,
            "the final NoteEnd must be dropped, not silently lost"
        );
        assert_eq!(
            outcome.note_end_dropped, 1,
            "a dropped NoteEnd must be tracked separately (host reset_all() trigger)"
        );
    }

    /// CI-runnable regression guard for `apply_output_write_outcome` (main()'s
    /// `write_output_events` outcome -> `SharedRegion` counter mirror, extracted for exactly this
    /// reason -- pr-test-analyzer, PR #422 round 2 item 2). Uses three *distinct* values for
    /// spilled/dropped/note_end_dropped so a copy-paste field swap (e.g. `dropped` accidentally
    /// added into `output_event_spilled_count`) is caught by field identity, not just "some
    /// counter went up". No live plugin or child process needed -- same `alloc_zeroed` raw-region
    /// pattern as `recycled_child_slot_publishes_note_end_before_sequence_tag` below.
    #[test]
    fn apply_output_write_outcome_maps_each_field_to_its_own_region_counter() {
        let layout = std::alloc::Layout::new::<SharedRegion>();
        let region = unsafe { std::alloc::alloc_zeroed(layout) as *mut SharedRegion };
        assert!(!region.is_null());

        let idx = slot_index(1);
        let outcome = OutputWriteOutcome {
            written: 3,
            spilled: 11,
            dropped: 5,
            note_end_dropped: 2,
        };

        unsafe {
            apply_output_write_outcome(region, idx, outcome);
        }

        unsafe {
            assert_eq!(
                (*region).output_event_spilled_count.load(Relaxed),
                11,
                "spilled must land in output_event_spilled_count, not another counter"
            );
            assert_eq!(
                (*region).output_event_dropped_count.load(Relaxed),
                5,
                "dropped must land in output_event_dropped_count, not another counter"
            );
            assert_eq!(
                (*region).output_note_end_dropped_count.load(Relaxed),
                2,
                "note_end_dropped must land in output_note_end_dropped_count, not another counter"
            );
            assert_eq!(
                (*region).output_event_count[idx].load(Relaxed),
                3,
                "written must land in output_event_count for the slot"
            );
            std::alloc::dealloc(region.cast(), layout);
        }
    }

    #[test]
    fn in_order_sequence_boundaries() {
        assert_eq!(in_order_seqs(7, 7).collect::<Vec<_>>(), vec![]);
        assert_eq!(in_order_seqs(7, 8).collect::<Vec<_>>(), vec![8]);
        assert_eq!(in_order_seqs(7, 11).collect::<Vec<_>>(), vec![8, 9, 10, 11]);
    }

    #[test]
    fn decode_clamps_and_skips_invalid_records() {
        let valid = EventRecord::encode(&note_on(60));
        let mut invalid = valid;
        invalid.kind = u32::MAX;
        let mut records = vec![valid, invalid];
        records.resize(MAX_EVENTS_PER_BLOCK + 1, valid);
        let mut decoded = Vec::new();
        let failures = decode_slot_events(&records, u32::MAX, &mut decoded);
        assert_eq!(decoded.len(), MAX_EVENTS_PER_BLOCK - 1);
        assert_eq!(failures, 1);
        assert_eq!(decoded[0], note_on(60));
    }

    #[test]
    fn recycled_child_slot_publishes_note_end_before_sequence_tag() {
        let layout = std::alloc::Layout::new::<SharedRegion>();
        let region = unsafe { std::alloc::alloc_zeroed(layout) as *mut SharedRegion };
        assert!(!region.is_null());
        let mut host = unsafe { PipelinedInstrumentHost::from_raw(region) };
        let mut audio = vec![0.0; CHANNELS];
        let transport = TransportContext {
            tempo_bpm: 120.0,
            time_sig_numerator: 4,
            time_sig_denominator: 4,
            is_playing: 1,
            is_looping: 0,
            song_position_beats: 0.0,
        };
        let key = VoiceKey {
            port_index: 0,
            channel: 0,
            key: 60,
        };

        assert!(
            host.process_block(&mut audio, &[note_on(60)], transport)
                .submitted
        );
        assert_eq!(host.live_count(key), 1);

        unsafe {
            publish_completed_slot(
                region,
                1,
                |region| {
                    (*region).output_event_count[slot_index(1)].store(0, Relaxed);
                },
                || {},
            );
        }
        assert!(host.process_block(&mut audio, &[], transport).submitted);

        unsafe {
            publish_completed_slot(
                region,
                2,
                |region| {
                    (*region).output_event_count[slot_index(2)].store(0, Relaxed);
                },
                || {},
            );
        }
        assert!(host.process_block(&mut audio, &[], transport).submitted);

        // seq 3 recycles seq 1's physical slot. Drain exactly after publication so moving the
        // Release stores ahead of `write_slot` makes the host consume the stale zero count and
        // permanently miss this NoteEnd.
        unsafe {
            publish_completed_slot(
                region,
                3,
                |region| {
                    let slot = slot_index(3);
                    (*region).output_events[slot][0] =
                        EventRecord::encode(&NeutralEvent::NoteEnd {
                            sample_offset: 0,
                            addr: VoiceAddr {
                                note_id: -1,
                                port_index: 0,
                                channel: 0,
                                key: 60,
                                _pad: 0,
                            },
                        });
                    (*region).output_event_count[slot].store(1, Relaxed);
                },
                || {
                    assert!(host.process_block(&mut audio, &[], transport).submitted);
                },
            );
        }

        assert_eq!(host.live_count(key), 0);
        drop(host);
        unsafe {
            std::alloc::dealloc(region.cast(), layout);
        }
    }
}
