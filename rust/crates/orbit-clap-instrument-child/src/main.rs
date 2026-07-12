//! γ M2 instrument child: event slot を in-order に消費して CLAP instrument を render する。

#![allow(unsafe_code)]

use std::path::PathBuf;
use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};

use anyhow::{bail, Context, Result};
use orbit_audio_sandbox::{
    open_shared, region_ptr, slot_index, slot_offset, EventRecord, NeutralEvent, BUF_LEN, CHANNELS,
    CONTROL_QUIT, MAX_EVENTS_PER_BLOCK, MAX_FRAMES,
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
    let mut scratch = vec![0.0f32; BUF_LEN];
    // Event window 分を事前確保し、hot loop での buffer 再確保を避ける。
    let mut event_buf = EventBuffer::with_capacity(MAX_EVENTS_PER_BLOCK);
    let mut event_scratch: Vec<NeutralEvent> = Vec::with_capacity(MAX_EVENTS_PER_BLOCK);
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
            if !instrument.process_block(&mut scratch[..sample_count], &event_buf) {
                process_errors += 1;
                unsafe {
                    (*region).child_process_error_count.fetch_add(1, Relaxed);
                }
            }
            unsafe {
                let out_base = std::ptr::addr_of_mut!((*region).output) as *mut f32;
                std::ptr::copy_nonoverlapping(scratch.as_ptr(), out_base.add(off), sample_count);
                (*region).seq_tag[idx].store(seq, Release);
                (*region).seq_done.store(seq, Release);
                (*region).child_processed.fetch_add(1, Relaxed);
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
    use orbit_audio_sandbox::VoiceAddr;

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
}
