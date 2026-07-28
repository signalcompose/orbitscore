//! Synthetic instrument child for production-path M2 IPC integration tests.
//!
//! It consumes every sequence in order, writes silence, and returns one block-zero `NoteEnd` for
//! each `NoteOff`. `--synthetic-output-burst` is an explicitly test-only diagnostic path that adds
//! output events to exercise the otherwise unreachable output spill FIFO.

#![allow(unsafe_code)]

use std::path::PathBuf;
use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};

use anyhow::{bail, Context, Result};
use orbit_audio_sandbox::{
    open_shared, region_ptr, save_state_command, service_command_mailbox, slot_index, slot_offset,
    EventRecord, EventSpillFifo, NeutralEvent, CHANNELS, CMD_SAVE_STATE, CONTROL_QUIT,
    MAX_EVENTS_PER_BLOCK, MAX_FRAMES,
};

/// この fixture が `CMD_SAVE_STATE` で書き出す固定ペイロード。実 plugin の state の代役で、
/// テストは「host が指定したパスへ、この中身が、この長さで届いたか」を検査する。
const FIXTURE_STATE: &[u8] = b"orbit-fixture-state";

struct Args {
    shm: PathBuf,
    synthetic_output_burst: usize,
    crash_after: Option<u64>,
}

fn parse_args() -> Result<Args> {
    let mut shm = None;
    let mut synthetic_output_burst = 0;
    let mut crash_after = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--shm" => shm = Some(PathBuf::from(it.next().context("--shm に値が必要")?)),
            "--synthetic-output-burst" => {
                synthetic_output_burst = it
                    .next()
                    .context("--synthetic-output-burst に値が必要")?
                    .parse()
                    .context("--synthetic-output-burst の parse")?;
            }
            "--crash-after" => {
                crash_after = Some(
                    it.next()
                        .context("--crash-after に値が必要")?
                        .parse()
                        .context("--crash-after の parse")?,
                );
            }
            other => bail!("未知の引数: {other}"),
        }
    }
    Ok(Args {
        shm: shm.context("--shm は必須")?,
        synthetic_output_burst,
        crash_after,
    })
}

fn push_output(
    spill: &mut EventSpillFifo,
    window: &mut [EventRecord],
    written: &mut usize,
    record: EventRecord,
) -> bool {
    if *written < window.len() {
        window[*written] = record;
        *written += 1;
        true
    } else {
        spill.push(record)
    }
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let mmap = open_shared(&args.shm).with_context(|| format!("open_shared({:?})", args.shm))?;
    let region = region_ptr(&mmap);
    let mut spill = EventSpillFifo::new();
    let mut burst_pending = args.synthetic_output_burst;
    let mut last = 0u64;
    let mut processed = 0u64;

    loop {
        if unsafe { (*region).control.load(Relaxed) } == CONTROL_QUIT {
            break;
        }
        // #555: フォーマット中立の mailbox プロトコルを実プロセス越しに踏ませる。
        // handler は VST3 の代わりに固定ペイロードを書くだけで、検証対象は
        // `service_command_mailbox` の ack / result / detail 規律そのもの。
        unsafe {
            service_command_mailbox(region, |kind, arg| match kind {
                CMD_SAVE_STATE => Some(save_state_command(arg, || {
                    Ok::<_, std::io::Error>(FIXTURE_STATE.to_vec())
                })),
                _ => None,
            });
        }

        let cur = unsafe { (*region).seq_request.load(Acquire) };
        if cur <= last {
            std::hint::spin_loop();
            continue;
        }

        for seq in last.saturating_add(1)..=cur {
            let slot = slot_index(seq);
            let n_frames =
                unsafe { ((*region).n_frames[slot].load(Relaxed) as usize).min(MAX_FRAMES) };
            let input_count = unsafe {
                (*region).input_event_count[slot]
                    .load(Relaxed)
                    .min(MAX_EVENTS_PER_BLOCK as u32) as usize
            };
            unsafe {
                let out_base = std::ptr::addr_of_mut!((*region).output) as *mut f32;
                std::ptr::write_bytes(out_base.add(slot_offset(seq)), 0, n_frames * CHANNELS);
                let window = std::slice::from_raw_parts_mut(
                    std::ptr::addr_of_mut!((*region).output_events[slot]) as *mut EventRecord,
                    MAX_EVENTS_PER_BLOCK,
                );
                let mut written = spill.drain_into_window(window);

                for index in 0..input_count {
                    match (*region).input_events[slot][index].decode() {
                        Some(NeutralEvent::NoteOff { addr, .. }) => {
                            let record = EventRecord::encode(&NeutralEvent::NoteEnd {
                                sample_offset: 0,
                                addr,
                            });
                            let extra = std::mem::take(&mut burst_pending);
                            for _ in 0..=extra {
                                if !push_output(&mut spill, window, &mut written, record) {
                                    (*region).output_event_dropped_count.fetch_add(1, Relaxed);
                                    if spill.take_note_end_dropped() {
                                        (*region)
                                            .output_note_end_dropped_count
                                            .fetch_add(1, Relaxed);
                                    }
                                }
                            }
                        }
                        Some(_) => {}
                        None => {
                            (*region).event_decode_error_count.fetch_add(1, Relaxed);
                        }
                    }
                }
                let remaining = spill.len();
                if remaining != 0 {
                    (*region)
                        .output_event_spilled_count
                        .fetch_add(remaining as u64, Relaxed);
                }
                (*region).output_event_count[slot].store(written as u32, Relaxed);
                (*region).child_processed.fetch_add(1, Relaxed);
                (*region).seq_tag[slot].store(seq, Release);
                (*region).seq_done.store(seq, Release);
            }
            processed += 1;
            if args.crash_after == Some(processed) {
                std::process::exit(1);
            }
        }
        last = cur.max(last);
    }
    Ok(())
}
