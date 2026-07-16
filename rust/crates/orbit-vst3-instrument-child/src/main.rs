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
    SharedRegion, VoiceAddr, BUF_LEN, CHANNELS, CONTROL_QUIT, MAX_EVENTS_PER_BLOCK, MAX_FRAMES,
};
#[cfg(target_os = "macos")]
use orbit_vst3_host::Vst3InstrumentProcessor;

#[cfg(target_os = "macos")]
struct Args {
    shm: PathBuf,
    plugin: PathBuf,
    plugin_id: Option<String>,
    sample_rate: u32,
}

#[cfg(target_os = "macos")]
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
                    .context("--sample-rate の parse")?
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

/// note-off を instrument へ送り、同 addr/sample_offset の synthetic NOTE_END を積む。
/// VST3 には CLAP の NOTE_END 相当の plugin→host イベントが無いため、child がここで合成して
/// host の (port,channel,key) voice 簿記を閉じる（NoteOff / NoteChoke 共通・choke は velocity 0）。
#[cfg(target_os = "macos")]
fn note_off_and_end(
    instrument: &mut Vst3InstrumentProcessor,
    output_events: &mut Vec<NeutralEvent>,
    addr: VoiceAddr,
    velocity: f32,
    sample_offset: u32,
) {
    let (channel, pitch) = vst3_channel_pitch(addr);
    instrument.push_note_off(channel, pitch, velocity, to_vst3_offset(sample_offset));
    output_events.push(NeutralEvent::NoteEnd {
        sample_offset,
        addr,
    });
}

#[cfg(target_os = "macos")]
fn main() -> Result<()> {
    let args = parse_args()?;
    let mmap = open_shared(&args.shm).with_context(|| format!("open_shared({:?})", args.shm))?;
    let region = region_ptr(&mmap);
    if let Some(plugin_id) = &args.plugin_id {
        eprintln!("[orbit-vst3-instrument-child] --plugin-id={plugin_id} は VST3 では未使用");
    }
    let (mut instrument, _) =
        Vst3InstrumentProcessor::load(&args.plugin, args.sample_rate as f64, MAX_FRAMES as i32)
            .with_context(|| format!("load VST3 instrument {:?}", args.plugin))?;
    unsafe {
        orbit_audio_sandbox::transport::publish_child_ready(region, false);
    }

    let mut scratch = vec![0.0; BUF_LEN];
    let mut event_scratch = Vec::with_capacity(MAX_EVENTS_PER_BLOCK);
    let mut output_events = Vec::with_capacity(MAX_EVENTS_PER_BLOCK);
    let mut output_spill = EventSpillFifo::new();
    let mut process_errors = 0;
    let mut last = 0;
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
            output_events.clear();
            for event in &event_scratch {
                match *event {
                    NeutralEvent::NoteOn {
                        sample_offset,
                        addr,
                        velocity,
                        ..
                    } => {
                        let (channel, pitch) = vst3_channel_pitch(addr);
                        instrument.push_note_on(
                            channel,
                            pitch,
                            velocity as f32,
                            to_vst3_offset(sample_offset),
                        );
                    }
                    // NoteOff / NoteChoke は同じ形: VST3 note-off を送り、VST3 に無い NOTE_END を
                    // 同ブロックで合成して host の voice 簿記を閉じる（choke は velocity 0 扱い）。
                    NeutralEvent::NoteOff {
                        sample_offset,
                        addr,
                        velocity,
                    } => note_off_and_end(
                        &mut instrument,
                        &mut output_events,
                        addr,
                        velocity as f32,
                        sample_offset,
                    ),
                    NeutralEvent::NoteChoke {
                        sample_offset,
                        addr,
                    } => note_off_and_end(
                        &mut instrument,
                        &mut output_events,
                        addr,
                        0.0,
                        sample_offset,
                    ),
                    _ => unsafe {
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
            "[orbit-vst3-instrument-child] plugin.process() failed for {process_errors} block(s)"
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
}
