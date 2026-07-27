//! Out-of-process VST3 instrument child using the M2 shared-memory event transport.

#![allow(unsafe_code)]

#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};

#[cfg(target_os = "macos")]
use anyhow::{bail, Context, Result};
#[cfg(target_os = "macos")]
use orbit_audio_sandbox::{
    open_shared, region_ptr, slot_index, slot_offset, EventRecord, EventSpillFifo, NeutralEvent,
    ParentWatch, SharedRegion, VoiceAddr, BUF_LEN, CHANNELS, CONTROL_QUIT, MAX_EVENTS_PER_BLOCK,
    MAX_FRAMES,
};
#[cfg(target_os = "macos")]
use orbit_vst3_host::Vst3InstrumentProcessor;

#[cfg(target_os = "macos")]
struct Args {
    shm: PathBuf,
    plugin: PathBuf,
    plugin_id: Option<String>,
    sample_rate: u32,
    /// #540 P2: 保存済み state ファイル（`.vstpreset` container または raw component chunk）。
    /// load 後・READY publish 前に適用する。
    state: Option<PathBuf>,
}

#[cfg(target_os = "macos")]
fn parse_args() -> Result<Args> {
    let mut shm = None;
    let mut plugin = None;
    let mut plugin_id = None;
    let mut sample_rate = 48_000;
    let mut state = None;
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
                    .context("--sample-rate の parse")?
            }
            "--state" => state = Some(PathBuf::from(it.next().context("--state に値が必要")?)),
            other => bail!("未知の引数: {other}"),
        }
    }
    Ok(Args {
        shm: shm.context("--shm は必須")?,
        plugin: plugin.context("--plugin は必須")?,
        plugin_id,
        sample_rate,
        state,
    })
}

#[cfg(target_os = "macos")]
fn in_order_seqs(last: u64, cur: u64) -> impl Iterator<Item = u64> {
    last.saturating_add(1)..=cur
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct OutputWriteOutcome {
    written: usize,
    spilled: u64,
    dropped: u64,
    note_end_dropped: u64,
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
unsafe fn publish_completed_slot(
    region: *mut SharedRegion,
    seq: u64,
    write_slot: impl FnOnce(*mut SharedRegion),
) {
    write_slot(region);
    let idx = slot_index(seq);
    unsafe {
        (*region).seq_tag[idx].store(seq, Release);
        (*region).seq_done.store(seq, Release);
    }
}

/// VST3 accepts concrete MIDI1 values only. Wildcards and out-of-range values are rounded to
/// zero, matching the conservative fallback used by the VST3 voice-address translation.
#[cfg(target_os = "macos")]
fn vst3_channel_pitch(addr: VoiceAddr) -> (i16, i16) {
    let channel = if (0..=15).contains(&addr.channel) {
        addr.channel
    } else {
        0
    };
    let pitch = if (0..=127).contains(&addr.key) {
        addr.key
    } else {
        0
    };
    (channel, pitch)
}

#[cfg(target_os = "macos")]
fn to_vst3_offset(offset: u32) -> i32 {
    offset.min(i32::MAX as u32) as i32
}

/// Pure classification of an incoming `NeutralEvent` into the action `main()`'s dispatch loop
/// should apply. Extracted so the event-routing logic (channel/pitch wildcard rounding, VST3
/// NOTE_END synthesis for NoteOff/NoteChoke) is unit-testable without a loaded VST3 instrument.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq)]
enum EventAction {
    NoteOn {
        channel: i16,
        pitch: i16,
        velocity: f32,
        offset: i32,
    },
    /// NoteOff / NoteChoke both resolve here: push a VST3 note-off, plus a synthetic `NoteEnd`
    /// (VST3 has no plugin→host NOTE_END equivalent) so the host can close its voice bookkeeping.
    NoteOffAndEnd {
        channel: i16,
        pitch: i16,
        velocity: f32,
        offset: i32,
        end: NeutralEvent,
    },
    /// Unsupported variant: caller must bump `event_decode_error_count`.
    Unsupported,
}

#[cfg(target_os = "macos")]
fn classify_event(event: &NeutralEvent) -> EventAction {
    match *event {
        NeutralEvent::NoteOn {
            sample_offset,
            addr,
            velocity,
            ..
        } => {
            let (channel, pitch) = vst3_channel_pitch(addr);
            EventAction::NoteOn {
                channel,
                pitch,
                velocity: velocity as f32,
                offset: to_vst3_offset(sample_offset),
            }
        }
        NeutralEvent::NoteOff {
            sample_offset,
            addr,
            velocity,
        } => {
            let (channel, pitch) = vst3_channel_pitch(addr);
            EventAction::NoteOffAndEnd {
                channel,
                pitch,
                velocity: velocity as f32,
                offset: to_vst3_offset(sample_offset),
                end: NeutralEvent::NoteEnd {
                    sample_offset,
                    addr,
                },
            }
        }
        NeutralEvent::NoteChoke {
            sample_offset,
            addr,
        } => {
            let (channel, pitch) = vst3_channel_pitch(addr);
            EventAction::NoteOffAndEnd {
                channel,
                pitch,
                velocity: 0.0,
                offset: to_vst3_offset(sample_offset),
                end: NeutralEvent::NoteEnd {
                    sample_offset,
                    addr,
                },
            }
        }
        _ => EventAction::Unsupported,
    }
}

#[cfg(target_os = "macos")]
fn main() -> Result<()> {
    let args = parse_args()?;
    let mmap = open_shared(&args.shm).with_context(|| format!("open_shared({:?})", args.shm))?;
    let region = region_ptr(&mmap);
    if let Some(plugin_id) = &args.plugin_id {
        eprintln!("[orbit-vst3-instrument-child] --plugin-id={plugin_id} は VST3 では未使用");
    }
    // #540 P2: 保存済み state は load に渡し、**setActive 前**に適用される（VST3 正準の
    // 復元フロー・#542 レビュー F7）。失敗はハードエラー — 音色が復元できていないのに
    // default 音のまま READY を出すと「保存した音で鳴る」契約が黙って破れる
    // （attach 失敗として daemon 側に表面化させる）。
    let state_bytes = match &args.state {
        Some(state_path) => Some(
            std::fs::read(state_path).with_context(|| format!("read state file {state_path:?}"))?,
        ),
        None => None,
    };
    let (mut instrument, _) = Vst3InstrumentProcessor::load(
        &args.plugin,
        args.sample_rate as f64,
        MAX_FRAMES as i32,
        state_bytes.as_deref(),
    )
    .with_context(|| {
        format!(
            "load VST3 instrument {:?} (state: {:?})",
            args.plugin, args.state
        )
    })?;
    if let (Some(state_path), Some(bytes)) = (&args.state, &state_bytes) {
        eprintln!(
            "[orbit-vst3-instrument-child] state restored from {state_path:?} ({} bytes)",
            bytes.len()
        );
    }
    unsafe {
        orbit_audio_sandbox::transport::publish_child_ready(region, false);
    }

    let mut scratch = vec![0.0; BUF_LEN];
    let mut event_scratch = Vec::with_capacity(MAX_EVENTS_PER_BLOCK);
    let mut output_events = Vec::with_capacity(MAX_EVENTS_PER_BLOCK);
    let mut output_spill = EventSpillFifo::new();
    let mut process_errors = 0;
    let mut last = 0;
    // orphan 対策(#448): host(daemon)が CONTROL_QUIT を書かずに死ぬ経路(プロセス exit・
    // SIGKILL・crash)でも spin loop を抜けられるよう、親死活を低頻度で監視する。
    let mut parent_watch = ParentWatch::new();
    loop {
        if unsafe { (*region).control.load(Relaxed) } == CONTROL_QUIT {
            break;
        }
        if parent_watch.should_exit() {
            eprintln!("[orbit-vst3-instrument-child] 親プロセス死亡を検知、終了する");
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
            output_events.clear();
            for event in &event_scratch {
                match classify_event(event) {
                    EventAction::NoteOn {
                        channel,
                        pitch,
                        velocity,
                        offset,
                    } => {
                        instrument.push_note_on(channel, pitch, velocity, offset);
                    }
                    EventAction::NoteOffAndEnd {
                        channel,
                        pitch,
                        velocity,
                        offset,
                        end,
                    } => {
                        instrument.push_note_off(channel, pitch, velocity, offset);
                        output_events.push(end);
                    }
                    EventAction::Unsupported => unsafe {
                        (*region).event_decode_error_count.fetch_add(1, Relaxed);
                    },
                }
            }
            scratch[..sample_count].fill(0.0);
            if !instrument.process_block(&mut scratch[..sample_count]) {
                process_errors += 1;
                unsafe {
                    (*region).child_process_error_count.fetch_add(1, Relaxed);
                }
            }
            unsafe {
                publish_completed_slot(region, seq, |region| {
                    let out_base = std::ptr::addr_of_mut!((*region).output) as *mut f32;
                    std::ptr::copy_nonoverlapping(
                        scratch.as_ptr(),
                        out_base.add(off),
                        sample_count,
                    );
                    let window = std::slice::from_raw_parts_mut(
                        std::ptr::addr_of_mut!((*region).output_events[idx]) as *mut EventRecord,
                        MAX_EVENTS_PER_BLOCK,
                    );
                    let outcome =
                        write_output_events(window, &mut output_spill, output_events.drain(..));
                    apply_output_write_outcome(region, idx, outcome);
                    (*region).child_processed.fetch_add(1, Relaxed);
                });
            }
        }
        last = cur.max(last);
    }
    if process_errors != 0 {
        eprintln!(
            "[orbit-vst3-instrument-child] plugin.process() failed for {process_errors} block(s); \
             last tresult={}",
            instrument.last_process_error()
        );
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("orbit-vst3-instrument-child is macOS-only (VST3/CoreFoundation)");
    std::process::ExitCode::FAILURE
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use orbit_audio_sandbox::{VoiceAddr, EVENT_SPILL_CAPACITY};

    fn note_end() -> NeutralEvent {
        NeutralEvent::NoteEnd {
            sample_offset: 0,
            addr: VoiceAddr::WILDCARD,
        }
    }

    #[test]
    fn write_output_events_spills_and_tracks_note_end_drop() {
        let mut window = vec![EventRecord::encode(&note_end()); MAX_EVENTS_PER_BLOCK];
        let mut spill = EventSpillFifo::new();
        let fillers = (0..(MAX_EVENTS_PER_BLOCK + EVENT_SPILL_CAPACITY)).map(|_| note_end());
        let outcome = write_output_events(
            &mut window,
            &mut spill,
            fillers.chain(std::iter::once(note_end())),
        );
        assert_eq!(outcome.written, MAX_EVENTS_PER_BLOCK);
        assert_eq!(outcome.spilled, EVENT_SPILL_CAPACITY as u64);
        assert_eq!(outcome.dropped, 1);
        assert_eq!(outcome.note_end_dropped, 1);
    }

    #[test]
    fn wildcard_address_rounds_to_zero() {
        assert_eq!(vst3_channel_pitch(VoiceAddr::WILDCARD), (0, 0));
    }

    #[test]
    fn in_order_sequence_boundaries() {
        assert_eq!(in_order_seqs(7, 7).collect::<Vec<_>>(), Vec::<u64>::new());
        assert_eq!(in_order_seqs(7, 9).collect::<Vec<_>>(), vec![8, 9]);
    }

    fn concrete_addr(channel: i16, key: i16) -> VoiceAddr {
        VoiceAddr {
            note_id: -1,
            port_index: -1,
            channel,
            key,
            _pad: 0,
        }
    }

    #[test]
    fn classify_note_on_maps_channel_pitch_velocity_offset() {
        let event = NeutralEvent::NoteOn {
            sample_offset: 42,
            addr: concrete_addr(3, 60),
            velocity: 0.5,
            tuning_cents: 0.0,
            length_frames: -1,
        };
        assert_eq!(
            classify_event(&event),
            EventAction::NoteOn {
                channel: 3,
                pitch: 60,
                velocity: 0.5,
                offset: 42,
            }
        );
    }

    #[test]
    fn classify_note_on_rounds_wildcard_to_zero() {
        let event = NeutralEvent::NoteOn {
            sample_offset: 0,
            addr: VoiceAddr::WILDCARD,
            velocity: 1.0,
            tuning_cents: 0.0,
            length_frames: -1,
        };
        assert_eq!(
            classify_event(&event),
            EventAction::NoteOn {
                channel: 0,
                pitch: 0,
                velocity: 1.0,
                offset: 0,
            }
        );
    }

    #[test]
    fn classify_note_off_and_choke_yield_matching_note_end() {
        let addr = concrete_addr(5, 69);
        let off_event = NeutralEvent::NoteOff {
            sample_offset: 10,
            addr,
            velocity: 0.7,
        };
        let choke_event = NeutralEvent::NoteChoke {
            sample_offset: 10,
            addr,
        };

        let expected_end = NeutralEvent::NoteEnd {
            sample_offset: 10,
            addr,
        };

        assert_eq!(
            classify_event(&off_event),
            EventAction::NoteOffAndEnd {
                channel: 5,
                pitch: 69,
                velocity: 0.7,
                offset: 10,
                end: expected_end,
            }
        );
        assert_eq!(
            classify_event(&choke_event),
            EventAction::NoteOffAndEnd {
                channel: 5,
                pitch: 69,
                velocity: 0.0,
                offset: 10,
                end: expected_end,
            }
        );
    }

    #[test]
    fn classify_unsupported_variant_yields_unsupported() {
        assert_eq!(classify_event(&note_end()), EventAction::Unsupported);
        let poly_pressure = NeutralEvent::PolyPressure {
            sample_offset: 0,
            addr: VoiceAddr::WILDCARD,
            pressure: 0.0,
        };
        assert_eq!(classify_event(&poly_pressure), EventAction::Unsupported);
    }
}
