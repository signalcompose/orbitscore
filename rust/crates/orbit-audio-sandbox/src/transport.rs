//! 親(host=daemon)/子(child=effect process) が共有する shared-memory レイアウトと map ヘルパ。
//!
//! file-backed mmap(MAP_SHARED) を親子双方が map し、同一物理ページを共有する。同期は
//! [`SharedRegion`] 内の atomic(`seq_request` / `seq_done` / per-slot `seq_tag`)による SPSC
//! ハンドシェイク(各ステップは 1 行で記述):
//!
//! - **host PUBLISH**: 該当 slot の `n_frames[slot]` と `input[slot]` を書く → `seq_request` を Release で進めて publish(`n_frames` は Relaxed だが Release 前に書かれ child の Acquire で可視)。
//! - **child**: `seq_request` を Acquire で読む(前回より進んだら)→ n_frames/input が可視 → `output[slot]` を書く → `seq_tag[slot] = seq` を Release(その slot の出力 publish)→ `seq_done = seq` を Release(submit guard 用の最新処理 seq)で store。
//! - **host READ**: `seq_tag[slot(target)]` を Acquire で読み `== target` なら output が可視 → 出力にコピー。global monotone な `seq_done` でなく per-slot `seq_tag` で判定するのは、child が「latest 処理」で中間 seq を skip しても、その slot の tag が target に一致せず false-fresh を防げるから(seq_done では skip を検知できない)。
//! - **host SUBMIT guard**: `seq_done` を Acquire で読み slot 再利用可否(下記不変条件)を判定する。
//! - **child readiness**: child は `ClapEffectProcessor::load` / `ClapInstrumentProcessor::load`
//!   成功直後に `child_flags` → `child_status` の順で Release store する。host は初回 `LoadPlugin` 時に
//!   `load_outproc_plugin` の ready-ack ループでこれを poll する（PR-1b・#431 で実装済み）。
//!
//! **ping-pong バッファ**: `input` / `output` は各 [`SLOTS`] 個の slot を持ち、seq を [`slot_offset`]
//! で割り当てて交替する。slot を分けることで「host が seq s の slot を書く」のと「child が seq s-k の
//! slot を読む」が別領域になり、pipelined(host が spin せず数 block ずらして読む)でも torn read を
//! 起こさない。host / child の双方が同一の `slot_offset` で index する(モード非依存)。
//!
//! **N-slot-generic(γ M1)**: spike は slot 数 2 をハードコードしていた(`seq & 1` は 2 のべき乗専用)。
//! 本番では owner が slot 数(= pipeline 深さ = latency/stall のトレードオフ)を PR-C の実測で 2 or 3 に
//! 決める。cross-process な `repr(C)` 構造に slot 数が焼き付くと後で rewrite を強制するので、最初から
//! `% SLOTS` で汎用化し、[`SLOTS`] 1 つの変更で切り替わるようにする。
//!
//! **不変条件(slot 再利用の安全)**: host は新 seq s を submit する前に `seq_done >= s - SLOTS`
//! (s の slot の前 occupant = s-SLOTS の完了)を確認する。満たさなければ submit を見送る(stall)。
//! この下では各 slot へのアクセスは時間的に排他化され、生ポインタ経由の `&mut [f32]` 形成も健全
//! (不変条件が破れると live-but-slow child との間でデータ競合 = UB になる)。

// 共有メモリは生ポインタ経由でクロスプロセス参照するため unsafe FFI 同等。
#![allow(unsafe_code)]

#[cfg(test)]
use std::cell::Cell;
use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::fs::OpenOptions;
use std::io;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use memmap2::MmapMut;

use crate::events::EventRecord;

#[cfg(test)]
thread_local! {
    /// Per-thread counter keeps the mmap regression test deterministic under parallel cargo tests.
    static OPEN_SHARED_CALL_COUNT: Cell<usize> = const { Cell::new(0) };
}

// #888 子 3: 主題ごとに分割した子モジュール。transport.rs は共有の前文と再エクスポートだけを持つ。
mod event_ring;
mod layout;
mod mailbox;
mod shm;
mod ui_codec;
mod ui_pump;

#[allow(unused_imports)]
pub use event_ring::*;
#[allow(unused_imports)]
pub use layout::*;
#[allow(unused_imports)]
pub use mailbox::*;
#[allow(unused_imports)]
pub use shm::*;
#[allow(unused_imports)]
pub use ui_codec::*;
#[allow(unused_imports)]
pub use ui_pump::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    static MAILBOX_TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    #[derive(Clone)]
    struct WarningSubscriber {
        messages: Arc<Mutex<Vec<String>>>,
    }

    struct MessageVisitor<'a> {
        messages: &'a Arc<Mutex<Vec<String>>>,
    }

    impl tracing::field::Visit for MessageVisitor<'_> {
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
            if field.name() == "message" {
                self.messages
                    .lock()
                    .expect("warning messages lock")
                    .push(format!("{value:?}"));
            }
        }
    }

    impl tracing::Subscriber for WarningSubscriber {
        fn enabled(&self, _metadata: &tracing::Metadata<'_>) -> bool {
            true
        }

        fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }

        fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}

        fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}

        fn event(&self, event: &tracing::Event<'_>) {
            event.record(&mut MessageVisitor {
                messages: &self.messages,
            });
        }

        fn enter(&self, _span: &tracing::span::Id) {}

        fn exit(&self, _span: &tracing::span::Id) {}
    }

    /// [`EventPollOutcome::Advanced`] の期待値コンストラクタ（`handled` は 1 以上のこと）。
    fn advanced(handled: usize) -> EventPollOutcome {
        EventPollOutcome::Advanced {
            handled: NonZeroUsize::new(handled).expect("advanced() requires handled >= 1"),
        }
    }

    fn mailbox_test_path(label: &str) -> std::path::PathBuf {
        let seq = MAILBOX_TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "orbit-mailbox-{label}-{}-{seq}.shm",
            std::process::id()
        ))
    }

    fn wait_for_command(region: *mut SharedRegion) -> u64 {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
            if seq != 0 {
                return seq;
            }
            assert!(
                Instant::now() < deadline,
                "host did not publish a mailbox command"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn ack_next_success(
        shm: std::path::PathBuf,
        previous_seq: u64,
        bytes_written: u64,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mmap = open_shared(&shm).expect("child map");
            let region = region_ptr(&mmap);
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
                if seq > previous_seq {
                    unsafe {
                        (*region)
                            .cmd_result_len
                            .store(bytes_written, Ordering::Relaxed);
                        (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                        (*region).cmd_ack_seq.store(seq, Ordering::Release);
                    }
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "replacement command not published"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    }

    #[test]
    fn save_state_command_rejects_missing_and_empty_paths_before_capture() {
        for path in [None, Some("")] {
            let mut captures = 0;
            let outcome = save_state_command(path, || {
                captures += 1;
                Ok::<_, io::Error>(b"must not be captured".to_vec())
            });
            assert_eq!(outcome.result, CMD_RESULT_BAD_ARG);
            assert_eq!(outcome.len, 0);
            assert_eq!(captures, 0, "invalid arguments must not invoke capture");
        }
    }

    #[test]
    fn save_state_command_reports_sidecar_io_errors_with_the_reason() {
        let missing_parent = mailbox_test_path("missing-parent").join("state.bin");
        let outcome = save_state_command(missing_parent.to_str(), || {
            Ok::<_, io::Error>(b"captured state".to_vec())
        });

        assert_eq!(outcome.result, CMD_RESULT_IO_ERROR);
        assert_eq!(outcome.len, 0);
        assert!(
            outcome.detail.contains("write")
                && (outcome.detail.contains("No such file")
                    || outcome.detail.contains("not found")),
            "I/O failure detail must retain its reason: {:?}",
            outcome.detail
        );
    }

    #[test]
    fn save_state_command_reports_capture_errors_as_plugin_failures() {
        let sidecar = mailbox_test_path("capture-failure");
        let outcome = save_state_command(sidecar.to_str(), || {
            Err::<Vec<u8>, _>("oracle refused capture")
        });

        assert_eq!(outcome.result, CMD_RESULT_PLUGIN_ERROR);
        assert_eq!(outcome.len, 0);
        assert_eq!(outcome.detail, "oracle refused capture");
        assert!(
            !sidecar.exists(),
            "capture failure must not create a sidecar"
        );
    }

    #[test]
    fn save_state_command_success_len_matches_the_written_file() {
        let sidecar = mailbox_test_path("save-command-success");
        let payload = b"captured plugin state";
        let outcome = save_state_command(sidecar.to_str(), || Ok::<_, io::Error>(payload.to_vec()));

        assert_eq!(outcome.result, CMD_RESULT_OK);
        assert_eq!(outcome.len, payload.len() as u64);
        assert_eq!(
            std::fs::metadata(&sidecar).expect("sidecar metadata").len(),
            outcome.len
        );
        assert_eq!(std::fs::read(&sidecar).expect("sidecar contents"), payload);
        std::fs::remove_file(sidecar).expect("remove sidecar");
    }

    #[test]
    fn abandoned_sidecar_cleanup_has_a_dedicated_diagnostic() {
        let directory = mailbox_test_path("cleanup-directory");
        std::fs::create_dir(&directory).expect("create cleanup target directory");

        let error = remove_abandoned_sidecar(&directory)
            .expect_err("remove_file on a directory must fail as sidecar cleanup");
        assert!(matches!(
            &error,
            CommandMailboxError::SidecarCleanup { path, .. } if path == &directory
        ));
        assert!(
            error
                .to_string()
                .starts_with("abandoned sidecar cleanup failed:"),
            "cleanup failure must not claim that mmap failed: {error}"
        );
        assert!(!error.to_string().contains("mailbox mapping"));
        std::fs::remove_dir(directory).expect("remove cleanup target directory");
    }

    // クロスプロセスで共有する以上、レイアウトが壊れると親子で別物を読む。サイズ/整列の回帰を捕捉。
    #[test]
    fn region_size_and_align() {
        // mmap ファイルサイズは input/output 各 SLOTS 本ぶん(計 2*SLOTS ブロック)を下回らない。
        assert!(REGION_BYTES >= 2 * SLOTS * BUF_LEN * std::mem::size_of::<f32>());
        // event 転送窓(input/output 各 SLOTS 本ぶん)も下回らない(M2・Issue #416)。
        assert!(
            REGION_BYTES >= 2 * SLOTS * MAX_EVENTS_PER_BLOCK * std::mem::size_of::<EventRecord>()
        );
        // align(64) 指定どおり。mmap のページ整列で満たされる前提の値。
        assert_eq!(std::mem::align_of::<SharedRegion>(), 64);
        // BUF_LEN = フレーム × チャンネル。
        assert_eq!(BUF_LEN, MAX_FRAMES * CHANNELS);
    }

    // ping-pong index: seq を SLOTS で循環し、連続 seq は必ず別 slot を指す(N-slot-generic)。
    // 実装式の再記述ではなく、host/child が依拠する 2 つの不変条件(連続 seq は別 slot /
    // SLOTS 個ごとに同じ slot)を検証する。
    #[test]
    fn slot_offset_cycles_by_modulo() {
        // 連続する seq は別 slot(pipelined で s と s-1 が衝突しない前提)。
        for s in 0..(SLOTS as u64 * 3) {
            assert_ne!(slot_offset(s), slot_offset(s + 1));
        }
        // SLOTS 個ごとに同じ slot へ戻る(outstanding guard が seq-SLOTS を見る根拠)。
        for s in 0..(SLOTS as u64 * 3) {
            assert_eq!(slot_offset(s), slot_offset(s + SLOTS as u64));
        }
    }

    // carry-forward ①(PR-C): child_process_error_count は truncate 直後 0 で、生ポインタ経由で
    // read/write できる(child が fetch_add・host が load する health signal)。レイアウトに field が
    // 載っていることと zero-init を locking する。
    #[test]
    fn child_process_error_count_defaults_zero_and_is_writable() {
        use std::sync::atomic::Ordering::Relaxed;
        let p = std::env::temp_dir().join(format!("orbit-sbx-health-{}.shm", std::process::id()));
        let _ = std::fs::remove_file(&p);
        let mmap = create_shared(&p).expect("create");
        let region = region_ptr(&mmap);
        // SAFETY: create_shared が返した生存 mapping を指す。truncate 直後で 0 初期化。
        unsafe {
            assert_eq!((*region).child_process_error_count.load(Relaxed), 0);
            (*region).child_process_error_count.fetch_add(3, Relaxed);
            assert_eq!((*region).child_process_error_count.load(Relaxed), 3);
        }
        drop(mmap);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn child_readiness_defaults_to_starting_with_no_flags() {
        use std::sync::atomic::Ordering::Relaxed;
        let p = std::env::temp_dir().join(format!(
            "orbit-sbx-child-readiness-{}.shm",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        let mmap = create_shared(&p).expect("create");
        let region = region_ptr(&mmap);
        // SAFETY: create_shared が返した生存 mapping を指す。truncate 直後で 0 初期化。
        unsafe {
            assert_eq!((*region).child_status.load(Relaxed), CHILD_STATUS_STARTING);
            assert_eq!((*region).child_flags.load(Relaxed), 0);
        }
        drop(mmap);
        let _ = std::fs::remove_file(&p);
    }

    // publish_child_ready の直接検証（PR #439 review・pr-test-analyzer）: has_audio_input の
    // true/false 分岐で child_flags/child_status が期待どおり Release store されることを、
    // ヘルパを介さず本関数呼び出し1回ずつで確認する（既存テストは child_status/child_flags の
    // 初期値のみを検証しており、この関数自体を直接呼ぶテストが無かった）。
    #[test]
    fn publish_child_ready_stores_flags_and_status_for_both_branches() {
        use std::sync::atomic::Ordering::Relaxed;

        // has_audio_input = true: CHILD_FLAG_HAS_AUDIO_INPUT が立ち、status は READY。
        let p_true = std::env::temp_dir().join(format!(
            "orbit-sbx-publish-ready-true-{}.shm",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p_true);
        let mmap_true = create_shared(&p_true).expect("create");
        let region_true = region_ptr(&mmap_true);
        // SAFETY: create_shared が返した生存 mapping を指す。
        unsafe {
            publish_child_ready(region_true, true);
            assert_eq!(
                (*region_true).child_flags.load(Relaxed),
                CHILD_FLAG_HAS_AUDIO_INPUT
            );
            assert_eq!(
                (*region_true).child_status.load(Relaxed),
                CHILD_STATUS_READY
            );
        }
        drop(mmap_true);
        let _ = std::fs::remove_file(&p_true);

        // has_audio_input = false: flags は 0 のまま、status は READY。
        let p_false = std::env::temp_dir().join(format!(
            "orbit-sbx-publish-ready-false-{}.shm",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p_false);
        let mmap_false = create_shared(&p_false).expect("create");
        let region_false = region_ptr(&mmap_false);
        // SAFETY: create_shared が返した生存 mapping を指す。
        unsafe {
            publish_child_ready(region_false, false);
            assert_eq!((*region_false).child_flags.load(Relaxed), 0);
            assert_eq!(
                (*region_false).child_status.load(Relaxed),
                CHILD_STATUS_READY
            );
        }
        drop(mmap_false);
        let _ = std::fs::remove_file(&p_false);
    }

    #[test]
    fn reset_child_starting_clears_previous_incarnation_readiness() {
        let path =
            std::env::temp_dir().join(format!("orbit-sbx-reset-ready-{}.shm", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mmap = create_shared(&path).expect("create");
        let region = region_ptr(&mmap);

        // SAFETY: region は create_shared が返した生存 mapping を指す。
        unsafe {
            publish_child_ready(region, true);
            reset_child_starting(region);
            assert_eq!((*region).child_flags.load(Ordering::Relaxed), 0);
            assert_eq!(
                (*region).child_status.load(Ordering::Relaxed),
                CHILD_STATUS_STARTING
            );
        }

        drop(mmap);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn event_ring_host_processes_strictly_in_sequence_and_acks_only_completion() {
        let shm = mailbox_test_path("event-seq-order");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child
            .queue(EVT_UI_CLOSED, "close-started")
            .expect("queue UI_CLOSED");
        child
            .queue(EVT_UI_CLOSED_DONE, "close-complete")
            .expect("queue UI_CLOSED_DONE");
        assert_eq!(unsafe { child.service(region) }.expect("publish"), 2);

        let host = EventRingHost::new(shm.clone());
        let mut attempted = Vec::new();
        assert_eq!(
            host.poll(|event| {
                attempted.push((event.seq, event.kind));
                false
            })
            .expect("defer first event"),
            // 規律3: 「先頭で停止」は idle と型で区別され、何が未解決か（seq/kind）を運ぶ。
            EventPollOutcome::Blocked {
                handled: 0,
                seq: 1,
                kind: EVT_UI_CLOSED
            }
        );
        assert_eq!(attempted, vec![(1, EVT_UI_CLOSED)]);
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            0,
            "receipt alone must not ack an incomplete event"
        );

        let mut completed = Vec::new();
        assert_eq!(
            host.poll(|event| {
                completed.push((
                    event.seq,
                    event.kind,
                    event.arg().expect("valid event arg").to_string(),
                ));
                true
            })
            .expect("complete queued events"),
            advanced(2)
        );
        assert_eq!(
            completed,
            vec![
                (1, EVT_UI_CLOSED, "close-started".into()),
                (2, EVT_UI_CLOSED_DONE, "close-complete".into()),
            ]
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 2);
        assert_eq!(
            host.poll(|_| true).expect("drained ring"),
            EventPollOutcome::Idle,
            "no new events must be distinguishable from a blocked head"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn event_ring_two_inflight_events_use_distinct_unacked_slots() {
        let shm = mailbox_test_path("event-two-slots");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child
            .queue(EVT_UI_CLOSED, "first-slot")
            .expect("queue first");
        child
            .queue(EVT_UI_CLOSED_DONE, "second-slot")
            .expect("queue second");

        assert_eq!(
            unsafe { child.service(region) }.expect("publish both"),
            2,
            "EVT_SLOTS=2 must accept both close-cycle events before either ack"
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);
        // 期待 index は本番の evt_slot_index() から導出せずハードコードする（自己参照にすると
        // 式の変異((seq-1) % EVT_SLOTS 等)を検出できない）。EVT_SLOTS = 2 前提の値。
        assert_eq!(
            EVT_SLOTS, 2,
            "hardcoded slot indices below assume EVT_SLOTS = 2"
        );
        let first_index = 1usize; // seq 1 -> slot 1
        let second_index = 0usize; // seq 2 -> slot 0
        assert_ne!(
            first_index, second_index,
            "consecutive unacked events must occupy distinct slots"
        );
        unsafe {
            assert_eq!(
                read_cstr_field(&(*region).evt_arg[first_index]),
                Some("first-slot")
            );
            assert_eq!(
                read_cstr_field(&(*region).evt_arg[second_index]),
                Some("second-slot")
            );
        }

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    // Ordering 対（publish/read・ack/reuse・dirty）の退行はテストではなく型で防いでいる:
    // [`evt_sync`] が AtomicU64 を封じ、呼び出し箇所は Ordering を渡せない（渡す変異は
    // コンパイルできない）。値の同語反復を検査する旧 memory-model テストは撤去した。

    /// [`reset_child_starting`] 内の不変条件コメントが述べる「host は evt カーソルを
    /// 保持しない」を実行で守る。同一 [`EventRingHost`] instance を respawn（seq 0 リセット）
    /// またぎで使い、replacement child の seq 1 からのイベントが取りこぼしなく届くことを検証する。
    /// host にカーソルが生えるか、リセットが部分適用になると red になる。
    #[test]
    fn event_ring_host_survives_respawn_seq_reset_without_local_cursor() {
        let shm = mailbox_test_path("event-respawn-cursor");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let host = EventRingHost::new(shm.clone());

        // incarnation 1: publish → poll → ack を完走させ、host が「もしカーソルを持って
        // いたら」旧世代の水位で汚染された状態を作る。
        let mut old_child = EventRingChild::new();
        old_child
            .queue(EVT_UI_CLOSED, "old-start")
            .expect("queue old start");
        old_child
            .queue(EVT_UI_CLOSED_DONE, "old-done")
            .expect("queue old done");
        assert_eq!(
            unsafe { old_child.service(region) }.expect("old publish"),
            2
        );
        assert_eq!(
            host.poll(|_| true).expect("drain old incarnation"),
            advanced(2)
        );

        unsafe { reset_child_starting(region) };

        // incarnation 2: seq は 1 から再スタートする。
        let mut new_child = EventRingChild::new();
        new_child
            .queue(EVT_UI_CLOSED, "new-start")
            .expect("queue new start");
        new_child
            .queue(EVT_UI_CLOSED_DONE, "new-done")
            .expect("queue new done");
        assert_eq!(
            unsafe { new_child.service(region) }.expect("new publish"),
            2
        );

        let mut delivered = Vec::new();
        assert_eq!(
            host.poll(|event| {
                delivered.push((
                    event.seq,
                    event.kind,
                    event.arg().expect("valid arg").to_string(),
                ));
                true
            })
            .expect("poll replacement incarnation"),
            advanced(2),
            "same host instance must deliver exactly the replacement child's events"
        );
        assert_eq!(
            delivered,
            vec![
                (1, EVT_UI_CLOSED, "new-start".into()),
                (2, EVT_UI_CLOSED_DONE, "new-done".into()),
            ]
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn event_ring_child_retains_blocked_event_and_retries_after_ack() {
        let shm = mailbox_test_path("event-retry");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child
            .queue(EVT_UI_CLOSED, "cycle-1-start")
            .expect("queue first");
        child
            .queue(EVT_UI_CLOSED_DONE, "cycle-1-done")
            .expect("queue second");
        child
            .queue(EVT_UI_CLOSED, "cycle-2-start")
            .expect("queue blocked third");

        assert_eq!(unsafe { child.service(region) }.expect("first tick"), 2);
        assert_eq!(
            child.pending_len(),
            1,
            "blocked lossless event must remain queued"
        );
        unsafe { (*region).evt_ack_seq.publish(1) };
        assert_eq!(unsafe { child.service(region) }.expect("retry tick"), 1);
        assert_eq!(child.pending_len(), 0, "retry must drain the pending queue");
        assert_eq!(unsafe { (*region).evt_seq.read() }, 3);
        // 期待 index はハードコード（evt_slot_index() を呼ぶと自己参照になり変異を検出できない）。
        assert_eq!(
            EVT_SLOTS, 2,
            "hardcoded slot index below assumes EVT_SLOTS = 2"
        );
        let third_index = 1usize; // seq 3 -> slot 1
        assert_eq!(
            unsafe { read_cstr_field(&(*region).evt_arg[third_index]) },
            Some("cycle-2-start")
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// B（変異検出）: kind の値と seq の値が偶然一致するフィクスチャでは
    /// `evt_kind[index].store(event.kind, ..)` を `store(seq as u32, ..)` へ変異させても
    /// 全 green になる。意図的に kind ≠ seq の並び（DONE, CLOSED, DONE = 2, 1, 2）で積み、
    /// (seq, kind) の対応と shm 上の生値を明示 assert する。
    #[test]
    fn event_ring_kind_travels_in_its_slot_not_derived_from_seq() {
        let shm = mailbox_test_path("event-kind-vs-seq");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child
            .queue(EVT_UI_CLOSED_DONE, "seq1")
            .expect("queue seq 1");
        child.queue(EVT_UI_CLOSED, "seq2").expect("queue seq 2");
        child
            .queue(EVT_UI_CLOSED_DONE, "seq3")
            .expect("queue seq 3");
        assert_eq!(unsafe { child.service(region) }.expect("first publish"), 2);

        let host = EventRingHost::new(shm.clone());
        let mut delivered = Vec::new();
        let mut drain = |event: EventRingEvent| {
            delivered.push((event.seq, event.kind));
            true
        };
        assert_eq!(host.poll(&mut drain).expect("drain first two"), advanced(2));
        assert_eq!(unsafe { child.service(region) }.expect("publish third"), 1);
        assert_eq!(host.poll(&mut drain).expect("drain third"), advanced(1));
        assert_eq!(
            delivered,
            vec![
                (1, EVT_UI_CLOSED_DONE),
                (2, EVT_UI_CLOSED),
                (3, EVT_UI_CLOSED_DONE),
            ]
        );
        // shm 上の生値も確認する（index はハードコード・EVT_SLOTS = 2 前提）:
        // seq 3 -> slot 1 = DONE、seq 2 -> slot 0 = CLOSED。
        assert_eq!(EVT_SLOTS, 2, "hardcoded slot indices assume EVT_SLOTS = 2");
        unsafe {
            assert_eq!(
                (*region).evt_kind[1].load(Ordering::Relaxed),
                EVT_UI_CLOSED_DONE
            );
            assert_eq!((*region).evt_kind[0].load(Ordering::Relaxed), EVT_UI_CLOSED);
        }

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// A（規律1）: 取りこぼし不可イベントは arg のエンコード失敗（長すぎ・埋め込み NUL）で
    /// 消えない。arg はフォールバック文言へ差し替えられ、イベント自体は必ず届く。
    #[test]
    fn event_ring_queue_replaces_unencodable_arg_but_never_drops_the_event() {
        let shm = mailbox_test_path("event-arg-fallback");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        // NUL 終端の 1 バイト分も収まらない長さ（P3 のタイムアウト経路が載せる動的 detail を模す）。
        let oversized = "x".repeat(EVT_ARG_BYTES);
        child
            .queue(EVT_UI_CLOSED_DONE, &oversized)
            .expect("oversized arg must still enqueue the lossless event");
        child
            .queue(EVT_UI_CLOSED_DONE, "timeout\0detail")
            .expect("embedded NUL must still enqueue the lossless event");
        assert_eq!(child.pending_len(), 2, "no event may be dropped at queue()");
        assert_eq!(unsafe { child.service(region) }.expect("publish both"), 2);

        let host = EventRingHost::new(shm.clone());
        let mut args = Vec::new();
        assert_eq!(
            host.poll(|event| {
                args.push(
                    event
                        .arg()
                        .expect("fallback arg must be readable")
                        .to_string(),
                );
                true
            })
            .expect("poll fallback events"),
            advanced(2)
        );
        // 文言はハードコードで検証する（const 経由だと文言の破壊を検出できない）。
        // 元 arg のバイト長を必ず含む（host が原因に迫れる唯一の経路 — queue() の doc 参照）。
        // 256 = EVT_ARG_BYTES ぶんの "x"、14 = "timeout\0detail" のバイト長。
        assert_eq!(
            args,
            vec![
                "arg too long or embedded NUL (original len 256)".to_string(),
                "arg too long or embedded NUL (original len 14)".to_string(),
            ]
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// H: 未知 kind は呼び出し側のプログラミングエラーとして Err のまま（enqueue しない）。
    #[test]
    fn event_ring_queue_rejects_unknown_kind_without_enqueueing() {
        let mut child = EventRingChild::new();
        assert_eq!(
            child.queue(99, "detail"),
            Err(EventRingChildError::UnknownKind(99))
        );
        assert_eq!(
            child.pending_len(),
            0,
            "a programming error must not enqueue anything"
        );
    }

    #[test]
    fn event_ring_child_is_drained_requires_no_pending_and_equal_cursors() {
        let shm = mailbox_test_path("event-child-drained");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();

        assert!(
            unsafe { child.is_drained(region) },
            "the initial empty ring must be drained"
        );
        child
            .queue(EVT_UI_CLOSED, "pending")
            .expect("queue pending event");
        assert!(
            unsafe { !child.is_drained(region) },
            "pending_count != 0 must close the drain gate even when both cursors are zero"
        );

        assert_eq!(unsafe { child.service(region) }.expect("publish"), 1);
        assert_eq!(child.pending_len(), 0);
        assert!(
            unsafe { !child.is_drained(region) },
            "evt_ack_seq != evt_seq must close the drain gate even with no pending events"
        );

        unsafe { (*region).evt_ack_seq.publish(1) };
        assert!(
            unsafe { child.is_drained(region) },
            "zero pending events and equal cursors must drain the ring"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// H: seq 枯渇は loud に失敗し、イベントは pending に残る（silent drop しない）。
    #[test]
    fn event_ring_service_fails_loud_on_sequence_exhaustion_and_retains_event() {
        let shm = mailbox_test_path("event-seq-exhausted");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        unsafe { (*region).evt_seq.publish(u64::MAX) };
        let mut child = EventRingChild::new();
        child.queue(EVT_UI_CLOSED_DONE, "done").expect("queue");
        assert_eq!(
            unsafe { child.service(region) },
            Err(EventRingChildError::SequenceExhausted)
        );
        assert_eq!(
            child.pending_len(),
            1,
            "exhaustion must not silently drop the lossless event"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// H: `ack > published` の壊れた shm 状態は InvalidData で loud に失敗する。
    #[test]
    fn event_ring_poll_fails_loud_when_ack_exceeds_published() {
        let shm = mailbox_test_path("event-ack-overrun");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        unsafe { (*region).evt_ack_seq.publish(4) };

        let host = EventRingHost::new(shm.clone());
        let mut invoked = false;
        let error = host
            .poll(|_| {
                invoked = true;
                true
            })
            .expect_err("ack beyond published must fail loud");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(
            error.to_string().contains("exceeds published seq"),
            "got: {error}"
        );
        assert!(!invoked, "no handler may run on corrupted ring state");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// 排他ゲート: handler の中から同じ host の poll を呼ぶ再入は、deadlock ではなく
    /// 明示的な `Err` になり、外側の poll はそのまま完結できる。ゲートは外側 poll の
    /// 完了で解放され、後続の poll は成功する。
    #[test]
    fn event_ring_poll_reentry_from_handler_fails_loud_instead_of_deadlocking() {
        let shm = mailbox_test_path("event-poll-reentry");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child.queue(EVT_UI_CLOSED, "reentry").expect("queue");
        assert_eq!(unsafe { child.service(region) }.expect("publish"), 1);

        let host = EventRingHost::new(shm.clone());
        let mut inner_result = None;
        assert_eq!(
            host.poll(|_| {
                inner_result = Some(host.poll(|_| true));
                true
            })
            .expect("outer poll must complete"),
            advanced(1)
        );
        let inner = inner_result.expect("handler must have attempted the re-entrant poll");
        let error = inner.expect_err("re-entrant poll must fail loud, not succeed");
        assert!(
            error.to_string().contains("non-reentrant"),
            "error must name the contract: {error}"
        );
        // 再入の Err で内側イベントが処理されていない（ack は外側の 1 件ぶんだけ）。
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 1);
        // ゲートは外側 poll の完了で解放済み。
        assert_eq!(
            host.poll(|_| true).expect("subsequent poll must succeed"),
            EventPollOutcome::Idle
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// 排他ゲート: handler の panic でゲートが恒久 poison しない（`Mutex` 版には無かった
    /// 回復経路）。panic したイベントは未 ack のまま残り、次の poll が同じ seq から
    /// 再配送して完結できる。
    #[test]
    fn event_ring_poll_recovers_after_handler_panic_and_redelivers_unacked_event() {
        let shm = mailbox_test_path("event-poll-panic");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        child.queue(EVT_UI_CLOSED, "will-panic").expect("queue");
        assert_eq!(unsafe { child.service(region) }.expect("publish"), 1);

        let host = EventRingHost::new(shm.clone());
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            host.poll(|_| panic!("handler exploded"))
        }));
        assert!(
            panicked.is_err(),
            "handler panic must propagate to the caller"
        );
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            0,
            "a panicked handler must not ack its event"
        );

        let mut redelivered = Vec::new();
        assert_eq!(
            host.poll(|event| {
                redelivered.push((event.seq, event.kind));
                true
            })
            .expect("poll after a handler panic must succeed (no permanent poisoning)"),
            advanced(1)
        );
        assert_eq!(redelivered, vec![(1, EVT_UI_CLOSED)]);

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn dirty_epoch_increments_and_host_observes_monotone_watermark() {
        let shm = mailbox_test_path("dirty-epoch");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let host = EventRingHost::new(shm.clone());

        assert_eq!(host.observe_dirty_epoch().expect("initial observe"), None);
        assert_eq!(unsafe { increment_dirty_epoch(region) }, 1);
        assert_eq!(unsafe { increment_dirty_epoch(region) }, 2);
        assert_eq!(
            host.observe_dirty_epoch().expect("coalesced observe"),
            Some(2)
        );
        assert_eq!(host.observe_dirty_epoch().expect("unchanged observe"), None);
        assert_eq!(unsafe { increment_dirty_epoch(region) }, 3);
        assert_eq!(host.observe_dirty_epoch().expect("next observe"), Some(3));

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn reset_child_starting_clears_event_ring_but_preserves_dirty_epoch() {
        let shm = mailbox_test_path("event-reset");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let host = EventRingHost::new(shm.clone());
        for expected in 1..=5 {
            assert_eq!(unsafe { increment_dirty_epoch(region) }, expected);
        }
        assert_eq!(
            host.observe_dirty_epoch().expect("observe old child"),
            Some(5)
        );

        let mut child = EventRingChild::new();
        child
            .queue(EVT_UI_CLOSED, "old-incarnation")
            .expect("queue old event");
        assert_eq!(
            unsafe { child.service(region) }.expect("publish old event"),
            1
        );
        unsafe { reset_child_starting(region) };

        unsafe {
            assert_eq!((*region).evt_seq.read(), 0);
            assert_eq!((*region).evt_ack_seq.read(), 0);
            for index in 0..EVT_SLOTS {
                assert_eq!((*region).evt_kind[index].load(Ordering::Relaxed), EVT_NONE);
                assert_eq!(read_cstr_field(&(*region).evt_arg[index]), Some(""));
            }
            assert_eq!(
                (*region).dirty_epoch.read(),
                5,
                "respawn reset must not lower the dirty watermark"
            );
        }
        assert_eq!(unsafe { increment_dirty_epoch(region) }, 6);
        assert_eq!(
            host.observe_dirty_epoch()
                .expect("observe replacement child"),
            Some(6),
            "replacement child dirty must immediately exceed host-local last_seen"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_host_round_trips_one_exact_ack() {
        let shm = mailbox_test_path("round-trip");
        let mmap = create_shared(&shm).expect("create");
        let host = Arc::new(CommandMailboxHost::new(shm.clone()));
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let region = region_ptr(&child_mmap);
            let seq = wait_for_command(region);
            unsafe {
                assert_eq!((*region).cmd_kind.load(Ordering::Acquire), CMD_SAVE_STATE);
                assert_eq!(
                    read_cstr_field(&(*region).cmd_arg),
                    Some("/tmp/orbit-mailbox-state.bin")
                );
                (*region).cmd_result_len.store(321, Ordering::Relaxed);
                (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                (*region).cmd_ack_seq.store(seq, Ordering::Release);
            }
        });

        let response = host
            .issue_save_state(Path::new("/tmp/orbit-mailbox-state.bin"))
            .expect("mailbox success");
        assert_eq!(response.bytes_written, 321);
        child.join().expect("child join");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_host_issues_open_and_close_ui_with_success_detail() {
        let shm = mailbox_test_path("ui-commands");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let region = region_ptr(&child_mmap);
            let mut previous_seq = 0;
            for (expected_kind, expected_arg, detail) in [
                (CMD_OPEN_UI, "Oracle — lead[0]", ""),
                (CMD_CLOSE_UI, "", "already-closing"),
            ] {
                let deadline = Instant::now() + Duration::from_secs(1);
                let seq = loop {
                    let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
                    if seq > previous_seq {
                        break seq;
                    }
                    assert!(Instant::now() < deadline, "next UI command not published");
                    std::thread::sleep(Duration::from_millis(1));
                };
                unsafe {
                    assert_eq!((*region).cmd_kind.load(Ordering::Acquire), expected_kind);
                    assert_eq!(read_cstr_field(&(*region).cmd_arg), Some(expected_arg));
                    assert!(write_cstr_field(&mut (*region).cmd_result_detail, detail));
                    (*region).cmd_result_len.store(0, Ordering::Relaxed);
                    (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                    (*region).cmd_ack_seq.store(seq, Ordering::Release);
                }
                previous_seq = seq;
            }
        });

        let open = host.issue_open_ui("Oracle — lead[0]").expect("OPEN_UI ack");
        assert_eq!(open.bytes_written, 0);
        assert_eq!(open.detail, "");
        let close = host.issue_close_ui().expect("CLOSE_UI ack");
        assert_eq!(close.bytes_written, 0);
        assert_eq!(close.detail, "already-closing");

        child.join().expect("child join");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn apply_chain_has_a_dedicated_timeout_longer_than_single_state_save() {
        assert!(APPLY_CHAIN_MAILBOX_TIMEOUT > PLUGIN_STATE_MAILBOX_TIMEOUT);
    }

    #[test]
    fn command_mailbox_host_rejects_a_second_outstanding_command() {
        let shm = mailbox_test_path("single-outstanding");
        let mmap = create_shared(&shm).expect("create");
        let host = Arc::new(CommandMailboxHost::new(shm.clone()));
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let region = region_ptr(&child_mmap);
            let seq = wait_for_command(region);
            std::thread::sleep(Duration::from_millis(40));
            unsafe {
                (*region).cmd_result_len.store(1, Ordering::Relaxed);
                (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                (*region).cmd_ack_seq.store(seq, Ordering::Release);
            }
        });
        let first_host = host.clone();
        let first = std::thread::spawn(move || {
            first_host.issue_save_state(Path::new("/tmp/orbit-mailbox-first.bin"))
        });
        let region = region_ptr(&mmap);
        let seq = wait_for_command(region);
        let second = host
            .issue_save_state(Path::new("/tmp/orbit-mailbox-second.bin"))
            .expect_err("second command must not overwrite the first");
        assert!(matches!(second, CommandMailboxError::Busy { seq: busy } if busy == seq));
        assert_eq!(
            first
                .join()
                .expect("first issuer join")
                .expect("first command")
                .bytes_written,
            1
        );
        child.join().expect("child join");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_timeout_keeps_the_slot_poisoned_until_late_ack() {
        let shm = mailbox_test_path("timeout");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let timed_out_sidecar =
            std::env::temp_dir().join(format!("orbit-mailbox-timeout-{}.bin", std::process::id()));
        let _ = std::fs::remove_file(&timed_out_sidecar);

        let error = host
            .issue_save_state_with_timeout(&timed_out_sidecar, Duration::from_millis(15))
            .expect_err("unacknowledged command must time out");
        let timed_out_seq = match error {
            CommandMailboxError::Timeout { seq, elapsed } => {
                assert!(elapsed >= Duration::from_millis(15));
                seq
            }
            other => panic!("unexpected timeout error: {other}"),
        };
        std::fs::write(&timed_out_sidecar, b"late child output")
            .expect("simulate sidecar written after host timeout");
        assert!(matches!(
            host.issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-overwrite.bin"),
                Duration::from_millis(5)
            ),
            Err(CommandMailboxError::Poisoned { seq }) if seq == timed_out_seq
        ));

        let region = region_ptr(&mmap);
        unsafe {
            (*region).cmd_result_len.store(9, Ordering::Relaxed);
            (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
            (*region)
                .cmd_ack_seq
                .store(timed_out_seq, Ordering::Release);
        }
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let child_region = region_ptr(&child_mmap);
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                let seq = unsafe { (*child_region).cmd_seq.load(Ordering::Acquire) };
                if seq > timed_out_seq {
                    unsafe {
                        (*child_region).cmd_result_len.store(11, Ordering::Relaxed);
                        (*child_region)
                            .cmd_result
                            .store(CMD_RESULT_OK, Ordering::Relaxed);
                        (*child_region).cmd_ack_seq.store(seq, Ordering::Release);
                    }
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "replacement command not published"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let warning_messages = Arc::new(Mutex::new(Vec::new()));
        let response = tracing::subscriber::with_default(
            WarningSubscriber {
                messages: warning_messages.clone(),
            },
            || {
                host.issue_save_state_with_timeout(
                    Path::new("/tmp/orbit-mailbox-after-late-ack.bin"),
                    Duration::from_millis(250),
                )
            },
        )
        .expect("late exact ack releases the poisoned slot");
        assert_eq!(response.bytes_written, 11);
        assert!(
            warning_messages
                .lock()
                .expect("warning messages lock")
                .iter()
                .any(|message| message
                    .contains("discarding plugin state saved after mailbox timeout")),
            "late successful state cleanup must emit a warning"
        );
        assert!(
            !timed_out_sidecar.exists(),
            "late-ack sidecar must be removed before mailbox reuse"
        );
        child.join().expect("child join");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_late_failed_ack_does_not_emit_success_warning() {
        let shm = mailbox_test_path("late-failed-ack");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let sidecar = mailbox_test_path("late-failed-ack-sidecar");

        let timed_out_seq = match host
            .issue_save_state_with_timeout(&sidecar, Duration::from_millis(15))
            .expect_err("unacknowledged command must time out")
        {
            CommandMailboxError::Timeout { seq, .. } => seq,
            other => panic!("unexpected timeout error: {other}"),
        };
        let region = region_ptr(&mmap);
        unsafe {
            (*region)
                .cmd_result
                .store(CMD_RESULT_PLUGIN_ERROR, Ordering::Relaxed);
            (*region)
                .cmd_ack_seq
                .store(timed_out_seq, Ordering::Release);
        }

        let warning_messages = Arc::new(Mutex::new(Vec::new()));
        tracing::subscriber::with_default(
            WarningSubscriber {
                messages: warning_messages.clone(),
            },
            || host.reset_after_child_exit(),
        )
        .expect("failed late ack cleanup and reset");
        assert!(
            warning_messages
                .lock()
                .expect("warning messages lock")
                .iter()
                .all(|message| !message
                    .contains("discarding plugin state saved after mailbox timeout")),
            "a failed late ack must not be described as a successful discarded save"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_retry_cleanup_failure_releases_slot_and_stays_loud() {
        let shm = mailbox_test_path("retry-cleanup-failure");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let abandoned_sidecar = mailbox_test_path("retry-cleanup-directory");
        std::fs::create_dir(&abandoned_sidecar).expect("create cleanup target directory");

        let timed_out_seq = match host
            .issue_save_state_with_timeout(&abandoned_sidecar, Duration::from_millis(15))
            .expect_err("unacknowledged command must time out")
        {
            CommandMailboxError::Timeout { seq, .. } => seq,
            other => panic!("unexpected timeout error: {other}"),
        };
        let region = region_ptr(&mmap);
        unsafe {
            (*region)
                .cmd_result
                .store(CMD_RESULT_PLUGIN_ERROR, Ordering::Relaxed);
            (*region)
                .cmd_ack_seq
                .store(timed_out_seq, Ordering::Release);
        }

        let cleanup_error = host
            .issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-after-cleanup-error.bin"),
                Duration::from_millis(5),
            )
            .expect_err("directory sidecar cleanup must stay loud");
        assert!(matches!(
            cleanup_error,
            CommandMailboxError::SidecarCleanup { path, .. } if path == abandoned_sidecar
        ));

        let child = ack_next_success(shm.clone(), timed_out_seq, 17);
        let response = host
            .issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-after-released-slot.bin"),
                Duration::from_millis(250),
            )
            .expect("cleanup failure must not leave the mailbox slot occupied");
        assert_eq!(response.bytes_written, 17);
        child.join().expect("child join");

        std::fs::remove_dir(abandoned_sidecar).expect("remove cleanup target directory");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_reset_cleanup_failure_releases_slot_and_stays_loud() {
        let shm = mailbox_test_path("reset-cleanup-failure");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let abandoned_sidecar = mailbox_test_path("reset-cleanup-directory");
        std::fs::create_dir(&abandoned_sidecar).expect("create cleanup target directory");

        let timed_out_seq = match host
            .issue_save_state_with_timeout(&abandoned_sidecar, Duration::from_millis(15))
            .expect_err("unacknowledged command must time out")
        {
            CommandMailboxError::Timeout { seq, .. } => seq,
            other => panic!("unexpected timeout error: {other}"),
        };

        let cleanup_error = host
            .reset_after_child_exit()
            .expect_err("directory sidecar cleanup must stay loud");
        assert!(matches!(
            cleanup_error,
            CommandMailboxError::SidecarCleanup { path, .. } if path == abandoned_sidecar
        ));

        let child = ack_next_success(shm.clone(), timed_out_seq, 23);
        let response = host
            .issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-after-reset-cleanup-error.bin"),
                Duration::from_millis(250),
            )
            .expect("reset cleanup failure must not leave the mailbox slot occupied");
        assert_eq!(response.bytes_written, 23);
        child.join().expect("child join");

        std::fs::remove_dir(abandoned_sidecar).expect("remove cleanup target directory");
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_reset_fails_inflight_before_replacement_spawn() {
        let shm = mailbox_test_path("reset");
        let mmap = create_shared(&shm).expect("create");
        let host = Arc::new(CommandMailboxHost::new(shm.clone()));
        let abandoned_sidecar =
            std::env::temp_dir().join(format!("orbit-mailbox-reset-{}.bin", std::process::id()));
        let _ = std::fs::remove_file(&abandoned_sidecar);
        std::fs::write(&abandoned_sidecar, b"partial child output")
            .expect("create abandoned sidecar");
        let issuer_host = host.clone();
        let issuer_sidecar = abandoned_sidecar.clone();
        let issuer = std::thread::spawn(move || {
            issuer_host.issue_save_state_with_timeout(&issuer_sidecar, Duration::from_secs(1))
        });
        let region = region_ptr(&mmap);
        let seq = wait_for_command(region);
        host.reset_after_child_exit().expect("reset after death");
        let error = issuer
            .join()
            .expect("issuer join")
            .expect_err("in-flight command must fail on child death");
        assert!(matches!(
            error,
            CommandMailboxError::ChildExited {
                seq: failed_seq,
                ..
            } if failed_seq == seq
        ));
        unsafe {
            assert_eq!((*region).cmd_ack_seq.load(Ordering::Acquire), seq);
            assert_eq!(
                (*region).cmd_result.load(Ordering::Relaxed),
                CMD_RESULT_CHILD_EXITED
            );
            assert_eq!((*region).cmd_kind.load(Ordering::Relaxed), CMD_NONE);
            assert_eq!(
                (*region).child_status.load(Ordering::Acquire),
                CHILD_STATUS_STARTING
            );
        }
        assert!(
            !abandoned_sidecar.exists(),
            "child death/reset must remove its abandoned sidecar"
        );
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn command_mailbox_requires_an_exact_ack_and_valid_bounded_path() {
        let shm = mailbox_test_path("exact-ack");
        let mmap = create_shared(&shm).expect("create");
        let host = CommandMailboxHost::new(shm.clone());
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let region = region_ptr(&child_mmap);
            let seq = wait_for_command(region);
            unsafe { (*region).cmd_ack_seq.store(seq + 1, Ordering::Release) };
        });
        assert!(matches!(
            host.issue_save_state_with_timeout(
                Path::new("/tmp/orbit-mailbox-exact.bin"),
                Duration::from_millis(250)
            ),
            Err(CommandMailboxError::Protocol { seq, ack }) if ack == seq + 1
        ));
        child.join().expect("child join");

        let too_long = format!("/{}", "x".repeat(CMD_ARG_BYTES));
        assert!(matches!(
            CommandMailboxHost::new(shm.clone())
                .issue_save_state_with_timeout(Path::new(&too_long), Duration::from_millis(1)),
            Err(CommandMailboxError::InvalidArgument(_))
        ));
        assert!(matches!(
            CommandMailboxHost::new(shm.clone()).issue_save_state_with_timeout(
                Path::new("/tmp/before\0after"),
                Duration::from_millis(1)
            ),
            Err(CommandMailboxError::InvalidArgument(_))
        ));
        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    // ── #555: コマンドメールボックスの引数エンコード（UIH.2） ──

    #[test]
    fn cstr_field_round_trips_paths() {
        let mut field = [0u8; CMD_ARG_BYTES];
        let path = "/tmp/orbit-state-42.bin";
        assert!(write_cstr_field(&mut field, path), "書き込めるはず");
        assert_eq!(read_cstr_field(&field), Some(path));
    }

    /// 🔴 収まらない値は **切り詰めずに拒否** する。切り詰めると別のパスへ書いてしまう。
    #[test]
    fn cstr_field_refuses_to_truncate() {
        let mut field = [0u8; 8];
        assert!(
            !write_cstr_field(&mut field, "0123456789"),
            "収まらないのに書き込みを許した（切り詰めは別パスへの書き込みを招く）"
        );
        // NUL 終端ぎりぎり（7 バイト + NUL = 8）は通る。
        assert!(write_cstr_field(&mut field, "0123456"));
        assert_eq!(read_cstr_field(&field), Some("0123456"));
    }

    /// NUL 終端が無い / 非 UTF-8 は `None`（**黙って途中まで読まない**）。
    #[test]
    fn cstr_field_rejects_unterminated_and_invalid_utf8() {
        let unterminated = [b'a'; 8];
        assert_eq!(read_cstr_field(&unterminated), None, "NUL 無しを受理した");

        let mut invalid = [0u8; 8];
        invalid[0] = 0xFF;
        invalid[1] = 0;
        assert_eq!(read_cstr_field(&invalid), None, "非 UTF-8 を受理した");

        let empty_terminated = [0u8; 8];
        assert_eq!(read_cstr_field(&empty_terminated), Some(""));
    }

    #[test]
    fn cstr_field_refuses_a_value_with_an_embedded_nul() {
        // 埋め込み NUL を書けてしまうと read 側が最初の NUL で切るため、
        // 「切り詰めない」保証が黙って崩れる。拒否側に倒していることを押さえる。
        let mut field = [0u8; 32];
        assert!(
            !write_cstr_field(&mut field, "before\0after"),
            "埋め込み NUL を受理した"
        );
        assert_eq!(
            field, [0u8; 32],
            "拒否したのに書き込んでいる（部分書き込みは前回値を壊す）"
        );
    }

    #[test]
    fn reset_control_run_rearms_region_after_attach_teardown() {
        let path = std::env::temp_dir().join(format!(
            "orbit-sbx-reset-control-{}.shm",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mmap = create_shared(&path).expect("create");
        let region = region_ptr(&mmap);
        // SAFETY: region は上で作成した生存 mapping を指す。
        unsafe {
            (*region).control.store(CONTROL_QUIT, Ordering::Release);
            reset_control_run(region);
            assert_eq!((*region).control.load(Ordering::Acquire), CONTROL_RUN);
        }
        drop(mmap);
        let _ = std::fs::remove_file(path);
    }

    fn publish_ui_event(
        region: *mut SharedRegion,
        child: &mut EventRingChild,
        kind: u32,
        arg: &str,
    ) {
        child.queue(kind, arg).expect("queue UI event");
        assert_eq!(
            unsafe { child.service(region) }.expect("publish UI event"),
            1
        );
    }

    #[test]
    fn p1_two_windows_can_be_open_concurrently() {
        let pump = UiEventPump::new(mailbox_test_path("p1-two-windows"));
        pump.begin_open(Some(1)).expect("reserve window 1");
        pump.begin_open(Some(2)).expect("reserve window 2");
        pump.finish_open(Some(1), true).expect("open window 1");
        pump.finish_open(Some(2), true).expect("open window 2");

        let state = pump.state.lock().expect("pump state");
        assert_eq!(state.windows.len(), 2);
        assert_eq!(state.windows[&Some(1)].lifecycle, UiLifecycle::Open);
        assert_eq!(state.windows[&Some(2)].lifecycle, UiLifecycle::Open);
    }

    #[test]
    fn p2_reusing_a_live_window_token_is_loud_and_preserves_state() {
        let pump = UiEventPump::new(mailbox_test_path("p2-token-reuse"));
        pump.begin_open(Some(1)).expect("first reservation");

        let error = pump
            .begin_open(Some(1))
            .expect_err("live token reuse must fail");
        assert!(matches!(error, UiEventPumpError::Protocol(_)));
        let state = pump.state.lock().expect("pump state");
        assert_eq!(state.windows.len(), 1);
        assert_eq!(state.windows[&Some(1)].lifecycle, UiLifecycle::Opening);
    }

    #[test]
    fn p3_ack_requires_matching_generation_window_and_event_sequence() {
        let shm = mailbox_test_path("p3-ack-window");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED,
            &encode_ui_closed_arg(Some(2)),
        );
        let pump = UiEventPump::new(shm.clone());
        pump.poll_step(|_| true).expect("publish safepoint");

        assert!(matches!(
            pump.ack_safepoint(0, Some(1), 1),
            Err(UiEventPumpError::Protocol(_))
        ));
        assert_eq!(
            pump.state.lock().expect("pump state").pending_safepoint,
            Some(PendingSafepoint {
                window: Some(2),
                evt_seq: 1,
            })
        );
        pump.ack_safepoint(0, Some(2), 1)
            .expect("matching triplet advances");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 1);

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn p4_stale_generation_is_rejected_for_an_indexed_window() {
        let shm = mailbox_test_path("p4-generation");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mailbox = CommandMailboxHost::new(shm.clone());
        assert_eq!(
            pump.reset_after_child_exit(&mailbox)
                .expect("advance generation")
                .generation,
            1
        );
        let mut child = EventRingChild::new();
        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED,
            &encode_ui_closed_arg(Some(4)),
        );
        pump.poll_step(|_| true).expect("publish safepoint");

        assert!(matches!(
            pump.ack_safepoint(0, Some(4), 1),
            Err(UiEventPumpError::GenerationMismatch {
                expected: 1,
                actual: 0,
            })
        ));
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn p5_safepoint_notification_carries_the_decoded_window() {
        let shm = mailbox_test_path("p5-notification-window");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED,
            &encode_ui_closed_arg(Some(2)),
        );
        let pump = UiEventPump::new(shm.clone());
        let mut notifications = Vec::new();
        pump.poll_step(|notification| {
            notifications.push(notification);
            true
        })
        .expect("poll indexed close");
        assert_eq!(
            notifications,
            vec![UiPumpNotification::Safepoint {
                generation: 0,
                evt_seq: 1,
                window: Some(2),
            }]
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn p6_indexed_done_is_decoded_and_advances_the_ring() {
        let shm = mailbox_test_path("p6-indexed-done");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED_DONE,
            &encode_ui_closed_done_arg(Some(1), UiCloseCompletion::SafepointCompleted),
        );
        let pump = UiEventPump::new(shm.clone());
        let mut notifications = Vec::new();
        assert_eq!(
            pump.poll_step(|notification| {
                notifications.push(notification);
                true
            })
            .expect("poll indexed DONE"),
            advanced(1)
        );
        assert_eq!(
            notifications,
            vec![UiPumpNotification::CloseDone {
                completion: UiCloseCompletion::SafepointCompleted,
                window: Some(1),
            }]
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 1);

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn p7_non_indexed_close_arguments_preserve_the_legacy_protocol() {
        let shm = mailbox_test_path("p7-legacy-arguments");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");
        let pump = UiEventPump::new(shm.clone());
        let mut notifications = Vec::new();
        pump.poll_step(|notification| {
            notifications.push(notification);
            true
        })
        .expect("poll legacy close");
        pump.ack_safepoint(0, None, 1).expect("ack legacy close");
        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED_DONE,
            "safepoint-completed",
        );
        assert_eq!(
            pump.poll_step(|notification| {
                notifications.push(notification);
                true
            })
            .expect("poll legacy DONE"),
            advanced(1)
        );
        assert_eq!(
            notifications,
            vec![
                UiPumpNotification::Safepoint {
                    generation: 0,
                    evt_seq: 1,
                    window: None,
                },
                UiPumpNotification::CloseDone {
                    completion: UiCloseCompletion::SafepointCompleted,
                    window: None,
                },
            ]
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn p8_respawn_reset_reports_every_visible_window_in_key_order() {
        let shm = mailbox_test_path("p8-reset-windows");
        let mmap = create_shared(&shm).expect("create");
        let pump = UiEventPump::new(shm.clone());
        let mailbox = CommandMailboxHost::new(shm.clone());
        pump.begin_open(Some(2)).expect("reserve window 2");
        pump.finish_open(Some(2), true).expect("open window 2");
        pump.begin_open(Some(1)).expect("reserve window 1");
        pump.finish_open(Some(1), true).expect("open window 1");
        pump.state
            .lock()
            .expect("pump state")
            .windows
            .get_mut(&Some(2))
            .expect("window 2")
            .lifecycle = UiLifecycle::Closing;

        let reset = pump
            .reset_after_child_exit(&mailbox)
            .expect("reset pump and mailbox");
        assert_eq!(reset.closed_windows, vec![Some(1), Some(2)]);
        assert_eq!(reset.generation, 1);
        assert!(pump.state.lock().expect("pump state").windows.is_empty());

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn p9_abandoned_safepoints_are_retained_per_window() {
        let shm = mailbox_test_path("p9-per-window-abandon");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        for window in [1, 2] {
            publish_ui_event(
                region,
                &mut child,
                EVT_UI_CLOSED,
                &encode_ui_closed_arg(Some(window)),
            );
            publish_ui_event(
                region,
                &mut child,
                EVT_UI_CLOSED_DONE,
                &encode_ui_closed_done_arg(Some(window), UiCloseCompletion::TimedOutWithoutSave),
            );
            assert_eq!(
                pump.poll_step(|_| true).expect("abandon cycle"),
                advanced(2)
            );
        }

        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 4);
        pump.ack_safepoint(0, Some(1), 1)
            .expect("late ack for first window");
        pump.ack_safepoint(0, Some(2), 3)
            .expect("late ack for second window");
        assert!(pump.state.lock().expect("pump state").windows.is_empty());

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn p10_begin_open_rejection_preserves_the_lifecycle_anchor() {
        let pump = UiEventPump::new(mailbox_test_path("p10-message-anchor"));
        pump.begin_open(Some(10)).expect("reserve window");
        pump.finish_open(Some(10), true).expect("open window");
        let error = pump
            .begin_open(Some(10))
            .expect_err("duplicate open must fail")
            .to_string();
        assert!(
            error.contains("OPEN_UI requested while lifecycle is Open"),
            "stable TS anchor missing from {error:?}"
        );
    }

    #[test]
    fn p11_abandon_escape_requires_the_same_window() {
        let run = |label: &str, done_window: u64| {
            let shm = mailbox_test_path(label);
            let mmap = create_shared(&shm).expect("create");
            let region = region_ptr(&mmap);
            let pump = UiEventPump::new(shm.clone());
            let mut child = EventRingChild::new();
            publish_ui_event(
                region,
                &mut child,
                EVT_UI_CLOSED,
                &encode_ui_closed_arg(Some(1)),
            );
            publish_ui_event(
                region,
                &mut child,
                EVT_UI_CLOSED_DONE,
                &encode_ui_closed_done_arg(
                    Some(done_window),
                    UiCloseCompletion::TimedOutWithoutSave,
                ),
            );
            let outcome = pump.poll_step(|_| true).expect("poll escape candidate");
            let ack = unsafe { (*region).evt_ack_seq.read() };
            drop(mmap);
            let _ = std::fs::remove_file(shm);
            (outcome, ack)
        };

        assert!(matches!(
            run("p11-other-window", 2),
            (EventPollOutcome::Blocked { seq: 1, .. }, 0)
        ));
        assert_eq!(run("p11-same-window", 1), (advanced(2), 2));
    }

    #[test]
    fn p12_closed_abandoned_window_survives_until_its_late_ack() {
        let shm = mailbox_test_path("p12-late-ack-entry");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED,
            &encode_ui_closed_arg(Some(12)),
        );
        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED_DONE,
            &encode_ui_closed_done_arg(Some(12), UiCloseCompletion::TimedOutWithoutSave),
        );
        assert_eq!(
            pump.poll_step(|_| true).expect("abandon close"),
            advanced(2)
        );
        {
            let state = pump.state.lock().expect("pump state");
            let window = state.windows.get(&Some(12)).expect("retained window");
            assert_eq!(window.lifecycle, UiLifecycle::Closed);
            assert_eq!(window.abandoned_safepoint, Some(1));
        }
        pump.ack_safepoint(0, Some(12), 1)
            .expect("late ack remains routable");
        assert!(!pump
            .state
            .lock()
            .expect("pump state")
            .windows
            .contains_key(&Some(12)));

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn p13_safepoint_retry_is_counted_and_deduplicated_by_window_and_sequence() {
        let shm = mailbox_test_path("p13-dedupe");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED,
            &encode_ui_closed_arg(Some(13)),
        );
        let mut attempts = 0;
        for accepted in [false, true, true] {
            assert!(matches!(
                pump.poll_step(|notification| {
                    attempts += 1;
                    assert_eq!(
                        notification,
                        UiPumpNotification::Safepoint {
                            generation: 0,
                            evt_seq: 1,
                            window: Some(13),
                        }
                    );
                    accepted
                })
                .expect("retry safepoint"),
                EventPollOutcome::Blocked { seq: 1, .. }
            ));
        }
        assert_eq!(
            attempts, 2,
            "one failed delivery plus one accepted delivery"
        );
        assert_eq!(
            pump.state.lock().expect("pump state").pending_safepoint,
            Some(PendingSafepoint {
                window: Some(13),
                evt_seq: 1,
            })
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn p14_ui_event_argument_codec_round_trips_every_key_and_completion_shape() {
        let windows = [None, Some(0), Some(1), Some(u64::MAX)];
        let completions = [
            UiCloseCompletion::SafepointCompleted,
            UiCloseCompletion::TimedOutWithoutSave,
        ];
        for window in windows {
            assert_eq!(
                decode_ui_closed_arg(Some(&encode_ui_closed_arg(window))),
                Ok(window)
            );
            for completion in completions {
                assert_eq!(
                    decode_ui_closed_done_arg(Some(
                        &encode_ui_closed_done_arg(window, completion,)
                    )),
                    Ok((window, completion))
                );
            }
        }
    }

    /// #592: poll の固定 sink が停止している間、respawn reset は pump lock の外へ出られない。
    /// raw `reset_child_starting` へ差し替える変異では `reset_done` が release 前に届いて red になる。
    #[test]
    fn ui_event_pump_serializes_poll_sink_and_respawn_reset() {
        let shm = mailbox_test_path("ui-pump-reset-exclusion");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");

        let pump = Arc::new(UiEventPump::new(shm.clone()));
        let mailbox = Arc::new(CommandMailboxHost::new(shm.clone()));
        let (sink_entered_tx, sink_entered_rx) = std::sync::mpsc::channel();
        let (release_sink_tx, release_sink_rx) = std::sync::mpsc::channel();
        let poll_pump = pump.clone();
        let poller = std::thread::spawn(move || {
            poll_pump.poll_step(|notification| {
                assert!(matches!(notification, UiPumpNotification::Safepoint { .. }));
                sink_entered_tx.send(()).expect("announce sink entry");
                release_sink_rx.recv().expect("release sink");
                true
            })
        });
        sink_entered_rx.recv().expect("poll reached sink");

        let reset_pump = pump.clone();
        let reset_mailbox = mailbox.clone();
        let (reset_done_tx, reset_done_rx) = std::sync::mpsc::channel();
        let resetter = std::thread::spawn(move || {
            let result = reset_pump.reset_after_child_exit(&reset_mailbox);
            reset_done_tx.send(result).expect("report reset");
        });
        assert!(
            matches!(
                reset_done_rx.recv_timeout(Duration::from_millis(50)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ),
            "reset must remain blocked while poll_step owns the pump lock"
        );
        // 🔴 排他の実体はリングの不変性であって、reset の戻りが遅いことではない。
        // 完了タイミングだけを見ていると、「pump lock を取る前にリングを潰し、その後
        // lock で待つ」という #592 そのものの実装が素通りする（実際に変異で確認済み）。
        assert_eq!(
            unsafe { (*region).evt_seq.read() },
            1,
            "the event ring must not be reset while poll_step is in flight"
        );
        release_sink_tx.send(()).expect("release poll sink");
        assert!(matches!(
            poller.join().expect("poller join").expect("poll result"),
            EventPollOutcome::Blocked { seq: 1, .. }
        ));
        reset_done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("reset completes after poll release")
            .expect("reset result");
        resetter.join().expect("resetter join");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// 補助 stress: safe publish order（kind/arg → seq → ack）と reset を別スレッドで交互に走らせ、
    /// pump 排他下の poll がリセット途中の `ack > published` を一度も観測しないことを押さえる。
    #[test]
    fn ui_event_pump_poll_reset_stress_has_no_false_invalid_data() {
        const ITERATIONS: usize = 4_000;
        let shm = mailbox_test_path("ui-pump-reset-stress");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = Arc::new(UiEventPump::new(shm.clone()));
        let mailbox = Arc::new(CommandMailboxHost::new(shm.clone()));
        let stop = Arc::new(AtomicBool::new(false));
        let errors = Arc::new(Mutex::new(Vec::new()));

        let poll_pump = pump.clone();
        let poll_stop = stop.clone();
        let poll_errors = errors.clone();
        let poller = std::thread::spawn(move || {
            while !poll_stop.load(Ordering::Acquire) {
                if let Err(error) = poll_pump.poll_step(|_| true) {
                    poll_errors
                        .lock()
                        .expect("errors lock")
                        .push(error.to_string());
                }
                std::thread::yield_now();
            }
        });

        for _ in 0..ITERATIONS {
            // Setup order never creates ack > published. A raw reset mutation does: seq=0 is
            // visible before ack=0, which the concurrent poller catches often and records.
            unsafe {
                assert!(write_cstr_field(
                    &mut (*region).evt_arg[evt_slot_index(1)],
                    "safepoint-completed"
                ));
                (*region).evt_kind[evt_slot_index(1)].store(EVT_UI_CLOSED_DONE, Ordering::Relaxed);
                (*region).evt_seq.publish(1);
                (*region).evt_ack_seq.publish(1);
            }
            pump.reset_after_child_exit(&mailbox).expect("pump reset");
        }
        stop.store(true, Ordering::Release);
        poller.join().expect("poller join");
        let errors = errors.lock().expect("errors lock");
        // 特定の一文字列だけを禁じると、それ以外の破損シグネチャを**全部黙認**する。
        // 健全時の観測エラーは 0 件なので（実測）、締めても偽陽性は増えない。
        assert!(
            errors.is_empty(),
            "poll observed a partial reset or any other pump error: {errors:?}"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// Real shm scripted child: CLOSE_UI command ack is Phase A acceptance only. Completion is
    /// emitted solely after engine ack advances the safepoint and child publishes DONE.
    #[test]
    fn ui_event_pump_close_completion_originates_from_done_not_command_ack_or_closed() {
        let shm = mailbox_test_path("ui-pump-scripted-close");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mailbox = Arc::new(CommandMailboxHost::new(shm.clone()));
        let pump = UiEventPump::new(shm.clone());
        let child_shm = shm.clone();
        let child = std::thread::spawn(move || {
            let child_mmap = open_shared(&child_shm).expect("child map");
            let child_region = region_ptr(&child_mmap);
            let seq = wait_for_command(child_region);
            unsafe {
                assert_eq!(
                    (*child_region).cmd_kind.load(Ordering::Acquire),
                    CMD_CLOSE_UI
                );
                (*child_region)
                    .cmd_result
                    .store(CMD_RESULT_OK, Ordering::Relaxed);
                (*child_region).cmd_ack_seq.store(seq, Ordering::Release);
            }
            let mut events = EventRingChild::new();
            publish_ui_event(child_region, &mut events, EVT_UI_CLOSED, "");
            let deadline = Instant::now() + Duration::from_secs(1);
            while unsafe { (*child_region).evt_ack_seq.read() } < 1 {
                assert!(
                    Instant::now() < deadline,
                    "engine safepoint ack did not arrive"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            publish_ui_event(
                child_region,
                &mut events,
                EVT_UI_CLOSED_DONE,
                "safepoint-completed",
            );
        });

        let issuer_mailbox = mailbox.clone();
        let issuer = std::thread::spawn(move || issuer_mailbox.issue_close_ui());
        issuer
            .join()
            .expect("issuer join")
            .expect("Phase A command ack");

        let mut notifications = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(1);
        while notifications.is_empty() {
            pump.poll_step(|event| {
                notifications.push(event);
                true
            })
            .expect("poll CLOSED");
            assert!(Instant::now() < deadline, "UI_CLOSED was not published");
            std::thread::yield_now();
        }
        assert_eq!(
            notifications,
            vec![UiPumpNotification::Safepoint {
                generation: 0,
                evt_seq: 1,
                window: None,
            }],
            "command ack plus UI_CLOSED must not claim close completion"
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        pump.ack_safepoint(0, None, 1).expect("engine ack");
        let deadline = Instant::now() + Duration::from_secs(1);
        while notifications.len() < 2 {
            pump.poll_step(|event| {
                notifications.push(event);
                true
            })
            .expect("poll DONE");
            assert!(
                Instant::now() < deadline,
                "UI_CLOSED_DONE was not published"
            );
            std::thread::yield_now();
        }
        assert_eq!(
            notifications[1],
            UiPumpNotification::CloseDone {
                completion: UiCloseCompletion::SafepointCompleted,
                window: None,
            }
        );
        child.join().expect("child join");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn ui_event_pump_poll_step_maps_shared_region_once() {
        let shm = mailbox_test_path("ui-pump-single-map");
        let mmap = create_shared(&shm).expect("create");
        let pump = UiEventPump::new(shm.clone());
        OPEN_SHARED_CALL_COUNT.with(|count| count.set(0));

        assert_eq!(
            pump.poll_step(|_| true).expect("idle pump poll"),
            EventPollOutcome::Idle
        );
        assert_eq!(
            OPEN_SHARED_CALL_COUNT.with(Cell::get),
            1,
            "one poll_step must reuse its single shared-region mapping"
        );

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn ui_event_pump_does_not_ack_closed_before_engine_ack_and_notifies_once() {
        let shm = mailbox_test_path("ui-pump-engine-ack");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");
        let pump = UiEventPump::new(shm.clone());
        let mut notifications = Vec::new();
        for _ in 0..2 {
            assert!(matches!(
                pump.poll_step(|event| {
                    notifications.push(event);
                    true
                })
                .expect("blocked poll"),
                EventPollOutcome::Blocked { seq: 1, .. }
            ));
            assert_eq!(
                unsafe { (*region).evt_ack_seq.read() },
                0,
                "Blocked UI_CLOSED must remain unacked before AckUiSafepoint"
            );
        }
        assert_eq!(
            notifications.len(),
            1,
            "a blocked head is notified only once"
        );
        pump.ack_safepoint(0, None, 1).expect("matching engine ack");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 1);

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn ui_event_pump_rejects_stale_generation_even_when_evt_seq_repeats() {
        let shm = mailbox_test_path("ui-pump-generation");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mailbox = CommandMailboxHost::new(shm.clone());
        let reset = pump
            .reset_after_child_exit(&mailbox)
            .expect("advance generation");
        assert_eq!(reset.generation, 1);
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");
        pump.poll_step(|_| true).expect("notify generation 1");

        assert!(matches!(
            pump.ack_safepoint(0, None, 1),
            Err(UiEventPumpError::GenerationMismatch {
                expected: 1,
                actual: 0
            })
        ));
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            0,
            "stale generation must not ack replacement child's seq 1"
        );
        pump.ack_safepoint(1, None, 1)
            .expect("current generation ack");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn ui_event_pump_abandons_only_after_timeout_done_and_accepts_late_ack() {
        let shm = mailbox_test_path("ui-pump-abandon");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");
        let mut notifications = Vec::new();
        pump.poll_step(|event| {
            notifications.push(event);
            true
        })
        .expect("initial blocked poll");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED_DONE,
            "timeout-without-save",
        );
        assert_eq!(
            pump.poll_step(|event| {
                notifications.push(event);
                true
            })
            .expect("abandon and drain DONE"),
            advanced(2)
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 2);
        assert_eq!(
            notifications,
            vec![
                UiPumpNotification::Safepoint {
                    generation: 0,
                    evt_seq: 1,
                    window: None,
                },
                UiPumpNotification::CloseDone {
                    completion: UiCloseCompletion::TimedOutWithoutSave,
                    window: None,
                }
            ]
        );
        pump.ack_safepoint(0, None, 1)
            .expect("late completed save is accepted with warning");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// An absent editor makes safepoint delivery fail on every tick. Once the child publishes its
    /// timeout DONE, that delivery failure must no longer hide abandonment: the CLOSED head is
    /// released, DONE can drain, and the lifecycle permits another open.
    #[test]
    fn ui_event_pump_abandons_after_timeout_despite_undeliverable_safepoint() {
        let shm = mailbox_test_path("ui-pump-abandon-undeliverable");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");

        let mut failed_deliveries = 0;
        for _ in 0..3 {
            assert!(matches!(
                pump.poll_step(|_| {
                    failed_deliveries += 1;
                    false
                })
                .expect("blocked while editor is absent"),
                EventPollOutcome::Blocked { seq: 1, .. }
            ));
        }
        assert_eq!(
            failed_deliveries, 3,
            "the safepoint must be retried until the child gives up"
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED_DONE,
            "timeout-without-save",
        );
        assert!(matches!(
            pump.poll_step(|_| {
                failed_deliveries += 1;
                false
            })
            .expect("abandon CLOSED before attempting DONE delivery"),
            EventPollOutcome::Blocked { seq: 2, .. }
        ));
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            1,
            "timeout DONE must release an undeliverable CLOSED head"
        );
        assert_eq!(
            failed_deliveries, 4,
            "only DONE delivery, not the abandoned safepoint, remains attempted"
        );

        assert_eq!(
            pump.poll_step(|notification| {
                assert_eq!(
                    notification,
                    UiPumpNotification::CloseDone {
                        completion: UiCloseCompletion::TimedOutWithoutSave,
                        window: None,
                    }
                );
                true
            })
            .expect("drain timeout DONE after editor reconnects"),
            advanced(1)
        );
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 2);
        pump.begin_open(None)
            .expect("completed abandon must not permanently block a later UI open");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    /// abandon は `timeout-without-save` **だけ**が引き金であることを押さえる。
    ///
    /// child は ack が `UI_CLOSED` の seq に届いて初めて Phase B に入るので、Blocked の
    /// `UI_CLOSED` を飛び越えて `safepoint-completed` が来るのはハンドシェイク違反である。
    /// ここで abandon してしまうと、**engine が保存を確認していない safepoint を daemon が
    /// ack** し、音色を失ったままリングだけが正常に進む（UI は再オープンでき、失敗が
    /// どこにも現れない）。判別を落としたら red になることが、このテストの存在理由。
    #[test]
    fn ui_event_pump_does_not_abandon_on_a_non_timeout_done() {
        let shm = mailbox_test_path("ui-pump-abandon-negative");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");
        pump.poll_step(|_| true).expect("initial blocked poll");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        // ハンドシェイク違反: safepoint 未 ack のまま「保存できた」DONE が来る。
        publish_ui_event(
            region,
            &mut child,
            EVT_UI_CLOSED_DONE,
            "safepoint-completed",
        );
        let mut notifications = Vec::new();
        assert!(
            matches!(
                pump.poll_step(|event| {
                    notifications.push(event);
                    true
                })
                .expect("poll stays blocked"),
                EventPollOutcome::Blocked { seq: 1, .. }
            ),
            "non-timeout DONE must not release the blocked safepoint"
        );
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            0,
            "ack must not advance without an engine AckUiSafepoint"
        );
        assert!(
            notifications.is_empty(),
            "the safepoint was already announced; no further notification is due"
        );

        // engine が本来の ack を出せば、そこで初めて進む。
        pump.ack_safepoint(0, None, 1)
            .expect("engine ack advances the head");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 1);

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn ui_event_pump_final_drain_fails_blocked_safepoint_before_teardown() {
        let shm = mailbox_test_path("ui-pump-final-drain");
        let mmap = create_shared(&shm).expect("create");
        let region = region_ptr(&mmap);
        let pump = UiEventPump::new(shm.clone());
        let mut child = EventRingChild::new();
        publish_ui_event(region, &mut child, EVT_UI_CLOSED, "");

        let mut notifications = Vec::new();
        assert!(matches!(
            pump.poll_step(|event| {
                notifications.push(event);
                true
            })
            .expect("initial blocked poll"),
            EventPollOutcome::Blocked { seq: 1, .. }
        ));
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);

        assert_eq!(
            pump.final_drain(|event| {
                notifications.push(event);
                true
            })
            .expect("teardown drain"),
            advanced(1)
        );
        assert_eq!(
            unsafe { (*region).evt_ack_seq.read() },
            1,
            "teardown must not leave the blocked ring head behind"
        );
        assert_eq!(
            notifications,
            vec![UiPumpNotification::Safepoint {
                generation: 0,
                evt_seq: 1,
                window: None,
            }],
            "the already-notified safepoint must not be delivered twice during drain"
        );
        pump.begin_open(None)
            .expect("final drain returns lifecycle to Closed");
        pump.finish_open(None, false)
            .expect("release test reservation");

        drop(mmap);
        let _ = std::fs::remove_file(shm);
    }

    // 存在しないファイルは map せず Err(open は read-only open なので作成しない)。
    #[test]
    fn open_shared_rejects_missing_file() {
        let p = std::env::temp_dir().join(format!("orbit-sbx-missing-{}.shm", std::process::id()));
        let _ = std::fs::remove_file(&p);
        assert!(open_shared(&p).is_err(), "存在しないファイルは Err");
    }

    // REGION_BYTES 未満の stale/破損ファイルは生ポインタ deref 前に弾く(silently map しない)。
    #[test]
    fn open_shared_rejects_too_small_file() {
        use std::io::Write;
        let p = std::env::temp_dir().join(format!("orbit-sbx-small-{}.shm", std::process::id()));
        {
            let mut f = std::fs::File::create(&p).expect("create");
            f.write_all(&[0u8; 16]).expect("write"); // REGION_BYTES より遥かに小さい
        }
        let r = open_shared(&p);
        let _ = std::fs::remove_file(&p);
        let err = r.expect_err("REGION_BYTES 未満は弾く");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
