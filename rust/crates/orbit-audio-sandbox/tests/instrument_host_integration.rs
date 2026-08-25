//! Real-process production-path integration tests for the M2 instrument IPC substrate.

#![allow(unsafe_code)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering, Ordering::Acquire, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use orbit_audio_sandbox::{
    create_shared, open_shared, region_ptr, slot_index, warm_up_executable, NeutralEvent,
    PipelinedInstrumentHost, SandboxChildGuard, SharedRegion, TransportContext, VoiceAddr,
    VoiceKey, CHANNELS, EVENT_BACKING_CAPACITY, EVENT_SPILL_CAPACITY, MAX_EVENTS_PER_BLOCK,
};

static SHM_SEQ: AtomicU64 = AtomicU64::new(0);
const FRAMES: usize = 64;

fn child_exe() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_sandbox-instrument-child"));
    // 🔴 #520: `cargo build` 直後の child は「新規作成された実行ファイル」で、初回 spawn が
    // macOS のセキュリティ評価を伴い数秒〜24 秒止まりうる。以降の deadline（本ファイルの
    // 5s / 2s）はその裾を想定していないので、評価コストをここで先払いする。
    warm_up_executable(&path);
    path
}

fn shm_path() -> PathBuf {
    let id = SHM_SEQ.fetch_add(1, Relaxed);
    std::env::temp_dir().join(format!(
        "orbit-instrument-int-{}-{id}.shm",
        std::process::id()
    ))
}

fn spawn_child(path: &Path, burst: usize) -> Child {
    spawn_child_with_args(path, burst, None)
}

fn spawn_child_with_args(path: &Path, burst: usize, crash_after: Option<u64>) -> Child {
    let mut command = Command::new(child_exe());
    command.arg("--shm").arg(path);
    if burst != 0 {
        command
            .arg("--synthetic-output-burst")
            .arg(burst.to_string());
    }
    if let Some(count) = crash_after {
        command.arg("--crash-after").arg(count.to_string());
    }
    command.spawn().expect("spawn instrument child")
}

struct RespawnHarness {
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    watcher: Option<JoinHandle<()>>,
    respawn_count: Arc<AtomicU64>,
    ctl: *mut SharedRegion,
    path: PathBuf,
}

impl RespawnHarness {
    fn new(path: PathBuf, ctl: *mut SharedRegion, crash_after: u64) -> Self {
        let child = Arc::new(Mutex::new(Some(spawn_child_with_args(
            &path,
            0,
            Some(crash_after),
        ))));
        let stop = Arc::new(AtomicBool::new(false));
        let respawn_count = Arc::new(AtomicU64::new(0));
        let thread_child = Arc::clone(&child);
        let thread_stop = Arc::clone(&stop);
        let thread_count = Arc::clone(&respawn_count);
        let thread_path = path.clone();
        let watcher = thread::spawn(move || {
            while !thread_stop.load(Acquire) {
                let terminated = {
                    let mut child = thread_child.lock().expect("child mutex poisoned");
                    child
                        .as_mut()
                        .expect("watcher child missing")
                        .try_wait()
                        .expect("try_wait instrument child")
                };
                if terminated.is_some() {
                    let replacement = spawn_child_with_args(&thread_path, 0, None);
                    *thread_child.lock().expect("child mutex poisoned") = Some(replacement);
                    thread_count.fetch_add(1, Relaxed);
                }
                thread::sleep(Duration::from_millis(2));
            }
        });
        Self {
            stop,
            child,
            watcher: Some(watcher),
            respawn_count,
            ctl,
            path,
        }
    }

    fn wait_for_respawn(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.respawn_count.load(Acquire) == 0 {
            assert!(
                Instant::now() < deadline,
                "child was not respawned within 5s"
            );
            thread::yield_now();
        }
    }
}

impl Drop for RespawnHarness {
    fn drop(&mut self) {
        self.stop.store(true, Relaxed);
        if let Some(watcher) = self.watcher.take() {
            watcher.join().expect("respawn watcher panicked");
        }
        unsafe {
            (*self.ctl)
                .control
                .store(orbit_audio_sandbox::CONTROL_QUIT, Relaxed);
        }
        if let Some(mut child) = self.child.lock().expect("child mutex poisoned").take() {
            let deadline = Instant::now() + Duration::from_secs(2);
            while child
                .try_wait()
                .expect("try_wait replacement child")
                .is_none()
            {
                if Instant::now() >= deadline {
                    child.kill().expect("kill replacement child");
                    child.wait().expect("reap replacement child");
                    break;
                }
                thread::yield_now();
            }
        }
        std::fs::remove_file(&self.path).expect("remove shared memory file");
    }
}

fn wait_for_seq(region: *mut SharedRegion, seq: u64) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if unsafe { (*region).seq_done.load(Acquire) } >= seq {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "child が seq {seq} を5秒以内に処理しなかった"
        );
        std::hint::spin_loop();
    }
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

fn addr(note_id: i32, key: i16) -> VoiceAddr {
    VoiceAddr {
        note_id,
        port_index: 0,
        channel: 0,
        key,
        _pad: 0,
    }
}

fn note_on(addr: VoiceAddr, sample_offset: u32) -> NeutralEvent {
    NeutralEvent::NoteOn {
        sample_offset,
        addr,
        velocity: 1.0,
        tuning_cents: 0.0,
        length_frames: -1,
    }
}

fn note_off(addr: VoiceAddr, sample_offset: u32) -> NeutralEvent {
    NeutralEvent::NoteOff {
        sample_offset,
        addr,
        velocity: 0.0,
    }
}

fn output_note_ends(region: *mut SharedRegion, seq: u64) -> Vec<(i32, u32)> {
    let slot = slot_index(seq);
    assert_eq!(unsafe { (*region).seq_tag[slot].load(Acquire) }, seq);
    let count = (unsafe { (*region).output_event_count[slot].load(Relaxed) } as usize)
        .min(MAX_EVENTS_PER_BLOCK);
    (0..count)
        .map(
            |index| match unsafe { (*region).output_events[slot][index].decode() } {
                Some(NeutralEvent::NoteEnd {
                    sample_offset,
                    addr,
                }) => (addr.note_id, sample_offset),
                other => panic!("seq {seq} output[{index}] が NoteEnd でない: {other:?}"),
            },
        )
        .collect()
}

fn silent_block() -> Vec<f32> {
    vec![0.0; FRAMES * CHANNELS]
}

#[test]
fn events_and_transport_round_trip_through_real_child() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let child = spawn_child(&path, 0);
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    let mut host = PipelinedInstrumentHost::from_mmap(mmap_host);
    let voice = addr(17, 60);
    let key = VoiceKey {
        port_index: 0,
        channel: 0,
        key: 60,
    };

    let contexts = [transport(0.0, 0.0), transport(123.5, 19.25)];
    let mut audio = silent_block();
    assert!(
        host.process_block(&mut audio, &[note_on(voice, 11)], contexts[0])
            .submitted
    );
    assert_eq!(
        unsafe { (*ctl).transport_context[slot_index(1)] },
        contexts[0]
    );
    wait_for_seq(ctl, 1);
    assert_eq!(host.live_count(key), 1);

    assert!(
        host.process_block(&mut audio, &[note_off(voice, 37)], contexts[1])
            .submitted
    );
    assert_eq!(
        unsafe { (*ctl).transport_context[slot_index(2)] },
        contexts[1]
    );
    wait_for_seq(ctl, 2);
    assert_eq!(output_note_ends(ctl, 2), vec![(17, 0)]);

    assert!(
        host.process_block(&mut audio, &[], transport(98.0, 20.0))
            .submitted
    );
    assert_eq!(host.live_count(key), 0);
    assert_eq!(unsafe { (*ctl).event_decode_error_count.load(Relaxed) }, 0);
}

#[test]
fn input_spill_is_lossless_ordered_and_clamped() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let child = spawn_child(&path, 0);
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    let mut host = PipelinedInstrumentHost::from_mmap(mmap_host);
    let total = MAX_EVENTS_PER_BLOCK + 257;
    let events: Vec<_> = (0..total)
        .map(|i| note_off(addr(i as i32, 61), (i % FRAMES) as u32))
        .collect();
    let mut audio = silent_block();

    assert!(
        host.process_block(&mut audio, &events, transport(120.0, 0.0))
            .submitted
    );
    assert_eq!(
        unsafe { (*ctl).input_event_spilled_count.load(Relaxed) },
        257
    );
    wait_for_seq(ctl, 1);
    let mut received = output_note_ends(ctl, 1);

    assert!(
        host.process_block(&mut audio, &[], transport(120.0, 1.0))
            .submitted
    );
    let second_slot = slot_index(2);
    assert_eq!(
        unsafe { (*ctl).input_event_count[second_slot].load(Relaxed) },
        257
    );
    assert!((0..257).all(|i| unsafe { (*ctl).input_events[second_slot][i].sample_offset == 0 }));
    wait_for_seq(ctl, 2);
    received.extend(output_note_ends(ctl, 2));

    assert_eq!(received.len(), total);
    assert_eq!(
        received.iter().map(|&(id, _)| id).collect::<Vec<_>>(),
        (0..total as i32).collect::<Vec<_>>()
    );
    assert!(received.iter().all(|&(_, offset)| offset == 0));
    assert_eq!(unsafe { (*ctl).input_event_dropped_count.load(Relaxed) }, 0);
    assert_eq!(unsafe { (*ctl).event_decode_error_count.load(Relaxed) }, 0);
}

#[test]
fn synthetic_output_burst_spills_without_loss() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let burst = 700usize;
    let child = spawn_child(&path, burst);
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    let mut host = PipelinedInstrumentHost::from_mmap(mmap_host);
    let voice = addr(9, 62);
    let key = VoiceKey {
        port_index: 0,
        channel: 0,
        key: 62,
    };
    let total = MAX_EVENTS_PER_BLOCK + burst;
    let ons = vec![note_on(voice, 3); total];
    let mut audio = silent_block();

    assert!(
        host.process_block(&mut audio, &ons, transport(120.0, 0.0))
            .submitted
    );
    wait_for_seq(ctl, 1);
    assert!(
        host.process_block(&mut audio, &[], transport(120.0, 1.0))
            .submitted
    );
    wait_for_seq(ctl, 2);
    assert_eq!(host.live_count(key) as usize, total);

    let offs = vec![note_off(voice, 5); MAX_EVENTS_PER_BLOCK];
    assert!(
        host.process_block(&mut audio, &offs, transport(120.0, 2.0))
            .submitted
    );
    wait_for_seq(ctl, 3);
    assert_eq!(output_note_ends(ctl, 3).len(), MAX_EVENTS_PER_BLOCK);
    assert_eq!(
        unsafe { (*ctl).output_event_spilled_count.load(Relaxed) },
        burst as u64
    );

    assert!(
        host.process_block(&mut audio, &[], transport(120.0, 3.0))
            .submitted
    );
    wait_for_seq(ctl, 4);
    let tail = output_note_ends(ctl, 4);
    assert_eq!(tail.len(), burst);
    assert!(tail.iter().all(|&(_, offset)| offset == 0));
    assert!(
        host.process_block(&mut audio, &[], transport(120.0, 4.0))
            .submitted
    );
    assert_eq!(host.live_count(key), 0);
    assert_eq!(
        unsafe { (*ctl).output_event_dropped_count.load(Relaxed) },
        0
    );
}

#[test]
fn backlog_catch_up_consumes_every_sequence_exactly_once_in_order() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let mut host = PipelinedInstrumentHost::from_mmap(mmap_host);
    let mut audio = silent_block();
    let blocks = [
        vec![note_off(addr(101, 64), 7), note_off(addr(102, 64), 13)],
        vec![note_off(addr(201, 64), 19), note_off(addr(202, 64), 23)],
    ];

    assert!(
        host.process_block(&mut audio, &blocks[0], transport(100.0, 1.0))
            .submitted
    );
    assert!(
        host.process_block(&mut audio, &blocks[1], transport(101.0, 2.0))
            .submitted
    );
    assert!(
        !host
            .process_block(
                &mut audio,
                &[note_off(addr(301, 64), 29)],
                transport(102.0, 3.0),
            )
            .submitted
    );
    assert_eq!(host.stall, 1, "child 未起動で submit guard を確実に stall");
    for (seq, expected_offsets) in [(1, [7, 13]), (2, [19, 23])] {
        let slot = slot_index(seq);
        assert_eq!(unsafe { (*ctl).seq_tag[slot].load(Relaxed) }, 0);
        for (index, offset) in expected_offsets.into_iter().enumerate() {
            assert_eq!(
                unsafe { (*ctl).input_events[slot][index].sample_offset },
                offset
            );
        }
    }

    let child = spawn_child(&path, 0);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    wait_for_seq(ctl, 2);
    let first = output_note_ends(ctl, 1);
    let second = output_note_ends(ctl, 2);
    assert_eq!(first, vec![(101, 0), (102, 0)]);
    assert_eq!(second, vec![(201, 0), (202, 0)]);

    assert!(
        host.process_block(&mut audio, &[], transport(103.0, 4.0))
            .submitted
    );
    wait_for_seq(ctl, 3);
    assert_eq!(output_note_ends(ctl, 3), vec![(301, 0)]);
    assert_eq!(unsafe { (*ctl).child_processed.load(Relaxed) }, 3);
    assert_eq!(unsafe { (*ctl).event_decode_error_count.load(Relaxed) }, 0);

    // This test is the one that (non-deterministically, depending on real child process
    // timing) originally surfaced the `event_cursor` recycled-slot stall bug. Pinning an
    // exact expected count here would be flaky since it depends on real process timing, so
    // this only asserts a loose upper bound: given this test's specific structure (at most
    // one submit races ahead of the drain loop), the recovery arm can fire at most once. The
    // deterministic regression guard for this exact recovery path lives in
    // `instrument_host::tests::recycled_slot_resyncs_event_cursor_and_resets_voices`; this
    // integration test's role is to confirm the race is empirically reachable against a real
    // child process, not to pin its exact frequency.
    assert!(
        host.event_cursor_recycled <= 1,
        "event_cursor_recycled should never exceed 1 in this test's structure, got {}",
        host.event_cursor_recycled
    );
}

#[test]
fn backing_ring_exhaustion_injects_choke_through_real_child() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let child = spawn_child(&path, 0);
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    let mut host = PipelinedInstrumentHost::from_mmap(mmap_host);
    let events = vec![note_off(addr(41, 60), 0); EVENT_BACKING_CAPACITY + 1];
    let mut audio = silent_block();

    let outcome = host.process_block(&mut audio, &events, transport(120.0, 0.0));
    assert!(outcome.submitted);
    assert!(outcome.sticky_note_choke_injected);
    assert_eq!(unsafe { (*ctl).input_event_dropped_count.load(Relaxed) }, 1);
    assert_eq!(
        unsafe { (*ctl).input_events[slot_index(1)][0].decode() },
        Some(NeutralEvent::NoteChoke {
            sample_offset: 0,
            addr: VoiceAddr::WILDCARD,
        })
    );
    wait_for_seq(ctl, 1);
    assert!(
        host.process_block(&mut audio, &[], transport(120.0, 1.0))
            .submitted
    );
    wait_for_seq(ctl, 2);
    assert_eq!(unsafe { (*ctl).child_processed.load(Relaxed) }, 2);
    assert_eq!(unsafe { (*ctl).event_decode_error_count.load(Relaxed) }, 0);
}

#[test]
fn output_spill_exhaustion_resets_voice_counts_and_absorbs_delayed_note_ends() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let burst = EVENT_SPILL_CAPACITY + MAX_EVENTS_PER_BLOCK + 257;
    let child = spawn_child(&path, burst);
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    let mut host = PipelinedInstrumentHost::from_mmap(mmap_host);
    let voice = addr(51, 61);
    let key = VoiceKey {
        port_index: 0,
        channel: 0,
        key: 61,
    };
    let mut audio = silent_block();

    assert!(
        host.process_block(&mut audio, &[note_on(voice, 0)], transport(120.0, 0.0))
            .submitted
    );
    wait_for_seq(ctl, 1);
    assert_eq!(host.live_count(key), 1);
    assert!(
        host.process_block(&mut audio, &[note_off(voice, 0)], transport(120.0, 1.0))
            .submitted
    );
    wait_for_seq(ctl, 2);
    assert!(unsafe { (*ctl).output_event_dropped_count.load(Relaxed) } > 0);
    assert!(unsafe { (*ctl).output_note_end_dropped_count.load(Relaxed) } > 0);

    assert!(
        host.process_block(&mut audio, &[], transport(120.0, 2.0))
            .submitted
    );
    assert_eq!(host.live_count(key), 0, "drop counter triggers bulk reset");
    for block in 3..22 {
        wait_for_seq(ctl, block);
        assert!(
            host.process_block(&mut audio, &[], transport(120.0, block as f64))
                .submitted
        );
        assert_eq!(
            host.live_count(key),
            0,
            "delayed NoteEnd must saturate at zero"
        );
    }
}

#[test]
fn abnormal_child_respawn_is_an_implicit_all_voices_end() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let harness = RespawnHarness::new(path, ctl, 2);
    let mut host = PipelinedInstrumentHost::from_mmap(mmap_host);
    let voice = addr(61, 62);
    let key = VoiceKey {
        port_index: 0,
        channel: 0,
        key: 62,
    };
    let mut audio = silent_block();

    assert!(
        host.process_block(&mut audio, &[note_on(voice, 0)], transport(120.0, 0.0))
            .submitted
    );
    wait_for_seq(ctl, 1);
    assert_eq!(host.live_count(key), 1);
    assert!(
        host.process_block(&mut audio, &[], transport(120.0, 1.0))
            .submitted
    );
    wait_for_seq(ctl, 2);
    harness.wait_for_respawn();
    host.on_child_respawned();
    assert_eq!(host.live_count(key), 0);

    assert!(
        host.process_block(
            &mut audio,
            &[note_on(addr(62, 62), 0)],
            transport(120.0, 2.0)
        )
        .submitted
    );
    wait_for_seq(ctl, 3);
    assert_eq!(host.live_count(key), 1);
    assert_eq!(harness.respawn_count.load(Acquire), 1);
}

/// Run with `cargo test -p orbit-audio-sandbox --test instrument_host_integration gated_stress_32_frames_10k_burst_and_100k_events_per_second -- --ignored --nocapture`.
#[test]
#[ignore]
fn gated_stress_32_frames_10k_burst_and_100k_events_per_second() {
    const STRESS_FRAMES: usize = 32;
    const BURST: usize = 10_000;
    const SUSTAINED_BLOCKS: u64 = 2_000;
    const EVENTS_PER_BLOCK: usize = 67;

    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let child = spawn_child(&path, 0);
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    let mut host = PipelinedInstrumentHost::from_mmap(mmap_host);
    let key = VoiceKey {
        port_index: 0,
        channel: 0,
        key: 63,
    };
    let burst = vec![note_on(addr(70, 63), 0); BURST];
    let mut audio = vec![0.0; STRESS_FRAMES * CHANNELS];

    assert!(
        host.process_block(&mut audio, &burst, transport(120.0, 0.0))
            .submitted
    );
    let mut seq = 1;
    while host.live_count(key) < BURST as u16 {
        wait_for_seq(ctl, seq);
        seq += 1;
        assert!(
            host.process_block(&mut audio, &[], transport(120.0, seq as f64))
                .submitted
        );
        assert_eq!(unsafe { (*ctl).input_event_dropped_count.load(Relaxed) }, 0);
        assert_eq!(
            unsafe { (*ctl).output_event_dropped_count.load(Relaxed) },
            0
        );
    }
    assert_eq!(host.live_count(key), BURST as u16);

    for block in 0..SUSTAINED_BLOCKS {
        wait_for_seq(ctl, seq);
        let events: Vec<_> = (0..EVENTS_PER_BLOCK)
            .map(|index| {
                let voice = addr(
                    100_000 + (block * EVENTS_PER_BLOCK as u64 + (index / 2) as u64) as i32,
                    64,
                );
                if index % 2 == 0 {
                    note_on(voice, (index % STRESS_FRAMES) as u32)
                } else {
                    note_off(voice, (index % STRESS_FRAMES) as u32)
                }
            })
            .collect();
        seq += 1;
        assert!(
            host.process_block(&mut audio, &events, transport(120.0, seq as f64))
                .submitted
        );
        assert_eq!(unsafe { (*ctl).input_event_dropped_count.load(Relaxed) }, 0);
        assert_eq!(
            unsafe { (*ctl).output_event_dropped_count.load(Relaxed) },
            0
        );
    }
    wait_for_seq(ctl, seq);
}

// ---------------------------------------------------------------------------
// #555: コマンドメールボックス（UIH.2）を **実プロセス・実 shm 越しに**踏む。
//
// `orbit-vst3-host` 側の `state_round_trip_reproduces_the_same_pitch` は VST3 の
// getState/setState が音として往復するかを見る層で、IPC は一切通らない。本節が
// その対になる層 — フォーマット中立のプロトコル（cmd_seq を書く → child が
// service_command_mailbox で処理 → cmd_ack_seq/cmd_result/cmd_result_len/
// cmd_result_detail が読み戻る）そのものを検証する。
// ---------------------------------------------------------------------------

/// host 側から mailbox コマンドを1件発行する（`cmd_seq` の Release publish まで）。
fn issue_command(ctl: *mut SharedRegion, seq: u64, kind: u32, arg: &str) {
    unsafe {
        assert!(
            orbit_audio_sandbox::transport::write_cstr_field(&mut (*ctl).cmd_arg, arg),
            "cmd_arg に収まらない引数を渡した"
        );
        (*ctl).cmd_kind.store(kind, Relaxed);
        // 🔴 seq を最後に Release で publish する（child は Acquire で読む）。
        (*ctl).cmd_seq.store(seq, Ordering::Release);
    }
}

/// `cmd_ack_seq` が `seq` に達するまで待ち、`(result, len, detail)` を読み戻す。
fn await_ack(ctl: *mut SharedRegion, seq: u64) -> (u32, u64, String) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while unsafe { (*ctl).cmd_ack_seq.load(Acquire) } < seq {
        assert!(
            Instant::now() < deadline,
            "child が cmd_seq={seq} を ack しなかった（永久待ちの検出）"
        );
        std::hint::spin_loop();
    }
    unsafe {
        (
            (*ctl).cmd_result.load(Relaxed),
            (*ctl).cmd_result_len.load(Relaxed),
            orbit_audio_sandbox::transport::read_cstr_field(&(*ctl).cmd_result_detail)
                .expect("detail が NUL 終端 UTF-8 でない")
                .to_string(),
        )
    }
}

#[test]
fn save_state_command_round_trips_through_real_child_over_shared_memory() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let child = spawn_child(&path, 0);
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    let _host = PipelinedInstrumentHost::from_mmap(mmap_host);

    let sidecar = std::env::temp_dir().join(format!("orbit-cmd-state-{}.bin", std::process::id()));
    let _ = std::fs::remove_file(&sidecar);
    issue_command(
        ctl,
        1,
        orbit_audio_sandbox::CMD_SAVE_STATE,
        sidecar.to_str().expect("temp path is UTF-8"),
    );

    let (result, len, detail) = await_ack(ctl, 1);
    assert_eq!(
        result,
        orbit_audio_sandbox::CMD_RESULT_OK,
        "save state が失敗した: {detail}"
    );
    assert_eq!(detail, "", "成功時に detail が空でない");
    let written = std::fs::read(&sidecar).expect("サイドカーが書かれていない");
    assert_eq!(
        written, b"orbit-fixture-state",
        "サイドカーの中身が child の書いたペイロードと一致しない"
    );
    assert_eq!(
        len,
        written.len() as u64,
        "cmd_result_len が実際に書かれたバイト数と一致しない"
    );
    let _ = std::fs::remove_file(&sidecar);
}

#[test]
fn unknown_command_kind_is_acked_instead_of_being_silently_dropped() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let child = spawn_child(&path, 0);
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    let _host = PipelinedInstrumentHost::from_mmap(mmap_host);

    // 未知の kind を黙って捨てると host は ack を永久に待つ。await_ack の
    // タイムアウトがその退行を検出する。
    issue_command(ctl, 1, 0xDEAD_BEEF, "/tmp/never-written");

    let (result, len, detail) = await_ack(ctl, 1);
    assert_eq!(
        result,
        orbit_audio_sandbox::CMD_RESULT_UNKNOWN_KIND,
        "未知 kind が UNKNOWN_KIND 以外で ack された"
    );
    assert_eq!(len, 0, "失敗時に len が 0 でない");
    assert!(
        detail.contains("unknown cmd_kind"),
        "detail が理由を伝えていない: {detail:?}"
    );
    assert!(
        !std::path::Path::new("/tmp/never-written").exists(),
        "未知 kind なのに副作用が起きた"
    );
}

#[test]
fn bad_command_arg_is_reported_without_writing_a_sidecar() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let child = spawn_child(&path, 0);
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    let _host = PipelinedInstrumentHost::from_mmap(mmap_host);

    issue_command(ctl, 1, orbit_audio_sandbox::CMD_SAVE_STATE, "");

    let (result, len, _detail) = await_ack(ctl, 1);
    assert_eq!(
        result,
        orbit_audio_sandbox::CMD_RESULT_BAD_ARG,
        "空 cmd_arg が BAD_ARG 以外で ack された"
    );
    assert_eq!(len, 0, "失敗時に len が 0 でない");
}

#[test]
fn consecutive_commands_are_each_acked_in_order() {
    let path = shm_path();
    let mmap_host = create_shared(&path).expect("create_shared");
    let child = spawn_child(&path, 0);
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    let _guard = SandboxChildGuard::new(child, ctl, path);
    let _host = PipelinedInstrumentHost::from_mmap(mmap_host);

    // 1件目が ack を書いた後、mailbox が次のコマンドを受け付ける状態に戻ることを見る
    // （ack を「一度きり」にする退行 — cmd_ack_seq を上書きしない・cmd_seq 比較を
    // 誤る等 — をここで殺す）。
    let sidecar = std::env::temp_dir().join(format!("orbit-cmd-seq2-{}.bin", std::process::id()));
    let _ = std::fs::remove_file(&sidecar);

    issue_command(ctl, 1, 0xDEAD_BEEF, "/tmp/never-written-2");
    let (first, _, _) = await_ack(ctl, 1);
    assert_eq!(first, orbit_audio_sandbox::CMD_RESULT_UNKNOWN_KIND);

    issue_command(
        ctl,
        2,
        orbit_audio_sandbox::CMD_SAVE_STATE,
        sidecar.to_str().expect("temp path is UTF-8"),
    );
    let (second, len, detail) = await_ack(ctl, 2);
    assert_eq!(
        second,
        orbit_audio_sandbox::CMD_RESULT_OK,
        "2件目が処理されなかった: {detail}"
    );
    assert_eq!(len, b"orbit-fixture-state".len() as u64);
    assert_eq!(
        detail, "",
        "前コマンドの detail が残留している（detail をクリアしていない）"
    );
    let _ = std::fs::remove_file(&sidecar);
}
