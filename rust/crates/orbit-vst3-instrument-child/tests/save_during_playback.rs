//! #474 P1 の受け入れ検証: **演奏中の SAVE_STATE が audio を止めずに成功する**。
//!
//! ## 何を守るテストか
//!
//! P1 以前の child は audio 処理とコマンド処理を単一スレッドで直列に回していたため、
//! UIH.3 は「host は演奏停止中にのみ SAVE_STATE を発行すること（MUST）」という暫定制約を
//! 置いていた。P1（`orbit-child-runtime` による main runloop / audio 専用スレッド分離）で
//! この制約は外れる — 本テストはその解禁を**実行で**証明する:
//!
//! 1. 実 child（NSApplication runloop + audio 専用スレッド）を spawn する
//! 2. host 側スレッドが audio block を連続 submit し続ける（= 演奏中の代役）
//! 3. **getState に 500ms かかる**プラグイン（oracle の
//!    `ORBIT_VST3_SYNTH_STATE_DELAY_MS` seam・遅い実プラグインの代役）へ SAVE_STATE を発行する
//! 4. 保存が成功し、**保存中も audio slot（`seq_done`）が前進し続けた**ことを assert する
//!
//! 旧実行モデル（単一スレッド直列）へ退行すると、getState の 500ms の間 audio slot が
//! 完全に停止するため `seq_done` の前進量がパイプライン深さ（SLOTS）程度に落ちて red になる。
//! 同型の退行（audio スレッドが mailbox の完了を待つ等）も同じ assert が殺す。
//!
//! ## デバイス不要
//!
//! 実機スピーカーは使わない（`PipelinedInstrumentHost` の shm 往復だけで判定できる）。
//! 実機での dropout 検証（capture WAV drops==0）は別途 gated E2E が担う。

#![cfg(target_os = "macos")]
#![allow(unsafe_code)]

mod common;

use std::path::Path;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{unique_temp, wait_for_ready, ChildGuard};
use orbit_audio_sandbox::{
    create_shared, region_ptr, CommandMailboxHost, PipelinedInstrumentHost, SharedRegion,
    TransportContext, CHANNELS,
};

/// 復元させる半音オフセット。既定値 0 と違う値にして「保存が現在 state を見ている」ことを
/// 内容で判定できるようにする（mailbox_wiring と同じ規律）。
const RESTORED_SEMITONES: i32 = 7;

/// oracle の getState に仕込む遅延。演奏（block submit）がこの間も前進し続けることを測る窓。
const STATE_DELAY_MS: u64 = 500;

/// 保存中に `seq_done` が最低限前進しているべきブロック数。
///
/// 旧実行モデル（単一スレッド直列）では getState の 500ms の間 slot 処理が完全停止するため、
/// 前進量はパイプライン深さ（`SLOTS` = 一桁）+ コマンド拾い上げ前の数ブロックに留まる。
/// 新モデルでは free-running submit で数千ブロック前進する。64 はその間の安全余裕。
const MIN_BLOCKS_DURING_SAVE: u64 = 64;

/// panic（assert 失敗）による unwind でも補助スレッドを join してから先へ進めるガード。
///
/// 補助スレッドは shm（`mmap`）への生ポインタを触るため、join せずに `mmap` の drop
/// （unmap）へ到達すると use-after-unmap の SIGSEGV になり、**assert メッセージの読めない
/// 失敗**に化ける。`mmap` より後に宣言し、unwind 時に先に drop（= join）させること。
struct JoinOnDrop<T> {
    stop: Option<Arc<AtomicBool>>,
    handle: Option<std::thread::JoinHandle<T>>,
}

impl<T> JoinOnDrop<T> {
    fn new(stop: Arc<AtomicBool>, handle: std::thread::JoinHandle<T>) -> Self {
        Self {
            stop: Some(stop),
            handle: Some(handle),
        }
    }

    /// 停止フラグを持たない（自然に終わる）スレッド用。
    fn without_stop(handle: std::thread::JoinHandle<T>) -> Self {
        Self {
            stop: None,
            handle: Some(handle),
        }
    }

    /// 成功経路用の明示 join（停止フラグを立ててから待つ）。
    fn join(&mut self) -> T {
        if let Some(stop) = &self.stop {
            stop.store(true, Ordering::Relaxed);
        }
        self.handle
            .take()
            .expect("join was already taken")
            .join()
            .expect("auxiliary thread panicked")
    }
}

impl<T> Drop for JoinOnDrop<T> {
    fn drop(&mut self) {
        if let Some(stop) = &self.stop {
            stop.store(true, Ordering::Relaxed);
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn spawn_slow_state_child(shm: &Path, plugin: &Path, state: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_orbit-vst3-instrument-child"))
        .env(
            "ORBIT_VST3_SYNTH_STATE_DELAY_MS",
            STATE_DELAY_MS.to_string(),
        )
        .arg("--shm")
        .arg(shm)
        .arg("--plugin")
        .arg(plugin)
        .arg("--sample-rate")
        .arg("48000")
        .arg("--state")
        .arg(state)
        .spawn()
        .expect("spawn orbit-vst3-instrument-child")
}

#[test]
#[ignore = "gated child-process timing test; run explicitly on a macOS development machine"]
fn save_state_succeeds_while_audio_blocks_keep_flowing() {
    let bundle = orbit_vst3_synth_oracle::package_bundle()
        .expect("VST3 synth oracle build/package failed (gated prerequisite)");

    let restore_path = unique_temp("orbit-save-during-playback-restore.bin");
    std::fs::write(
        &restore_path,
        orbit_vst3_synth_oracle::encode_state(RESTORED_SEMITONES),
    )
    .expect("restore state を書けない");

    let shm = unique_temp("orbit-save-during-playback.shm");
    let mmap = create_shared(&shm).expect("create_shared");
    let region = region_ptr(&mmap);
    let mut guard = ChildGuard {
        child: spawn_slow_state_child(&shm, &bundle, &restore_path),
        region,
        shm: shm.clone(),
    };
    wait_for_ready(region, &mut guard.child);

    // ── 演奏の代役: 停止フラグが立つまで audio block を連続 submit するスレッド。
    // `PipelinedInstrumentHost` は !Send なので submitter スレッド内で from_raw する
    // （region は mmap の生存期間内・submitter は本関数内で join するため有効）。
    //
    // 🔴 [`JoinOnDrop`] で包む: assert が panic する経路でも submitter を join してから
    // unwind を続けないと、`mmap` の unmap 後に region を触って **SIGSEGV でテストが死ぬ**
    // （assert メッセージが読めない失敗になる。変異 M4 の初回実行で実際に起きた）。
    let stop = Arc::new(AtomicBool::new(false));
    let mut submitter = JoinOnDrop::new(stop.clone(), {
        let stop = stop.clone();
        let region_addr = region as usize;
        std::thread::spawn(move || {
            let region = region_addr as *mut SharedRegion;
            let mut host = unsafe { PipelinedInstrumentHost::from_raw(region) };
            let mut audio = vec![0.0f32; 128 * CHANNELS];
            let transport = TransportContext {
                tempo_bpm: 120.0,
                time_sig_numerator: 4,
                time_sig_denominator: 4,
                is_playing: 1,
                is_looping: 0,
                song_position_beats: 0.0,
            };
            let mut submitted_blocks: u64 = 0;
            while !stop.load(Ordering::Relaxed) {
                if host.process_block(&mut audio, &[], transport).submitted {
                    submitted_blocks += 1;
                }
                std::hint::spin_loop();
            }
            submitted_blocks
        })
    });

    // submit が実際に流れ始めたのを確認してから保存を発行する（保存窓の測定を汚さない）。
    let warmup_deadline = Instant::now() + Duration::from_secs(10);
    while unsafe { (*region).seq_done.load(Ordering::Acquire) } < MIN_BLOCKS_DURING_SAVE {
        assert!(
            Instant::now() < warmup_deadline,
            "child が audio block を処理し始めない（audio スレッドが起動していない可能性）"
        );
        std::hint::spin_loop();
    }

    // ── 保存窓の測定は**窓の中間**で行う。
    //
    // ⚠️ 「発行前 → ack 後」の差分で測ってはならない: 退行モデル（audio が保存中に凍結）でも
    // ack 直後に audio スレッドが一瞬で追い上げるため、ack 後スナップショットとの差分は
    // 閾値を超えてしまう（変異 M1 が最初この穴で生き残った）。getState の遅延窓
    // [+100ms, +400ms] ⊂ [pickup, pickup+500ms] の内部で 2 点サンプルし、その間の前進を測る。
    let mut sampler = JoinOnDrop::without_stop({
        let region_addr = region as usize;
        std::thread::spawn(move || {
            let region = region_addr as *mut SharedRegion;
            std::thread::sleep(Duration::from_millis(100));
            let mid_early = unsafe { (*region).seq_done.load(Ordering::Acquire) };
            std::thread::sleep(Duration::from_millis(300));
            let mid_late = unsafe { (*region).seq_done.load(Ordering::Acquire) };
            (mid_early, mid_late)
        })
    });
    let issued_at = Instant::now();
    let sidecar = unique_temp("orbit-save-during-playback-captured.bin");
    // ⚠️ ここで即 expect しない: 補助スレッドを join し終える前に panic すると、
    // unwind が `mmap` の unmap まで進んで補助スレッドが SIGSEGV する。
    let save_result = CommandMailboxHost::new(shm.clone()).issue_save_state(&sidecar);
    let elapsed = issued_at.elapsed();
    let (mid_early, mid_late) = sampler.join();
    let submitted_blocks = submitter.join();
    let response =
        save_result.expect("演奏中の SAVE_STATE が失敗した（UIH.3 の解禁が成立していない）");

    // (1) 遅延 seam が実際に効いていたこと。これが無いと env 名の変更等で seam が黙って
    // 外れ、「保存中」窓が事実上消えてテストが無意味なまま green になる。
    assert!(
        elapsed >= Duration::from_millis(STATE_DELAY_MS - 100),
        "SAVE_STATE の往復が {elapsed:?} — getState の遅延 seam \
         (ORBIT_VST3_SYNTH_STATE_DELAY_MS) が効いていない"
    );

    // (2) 核心: 保存（500ms の getState を含む）の**さなか**に audio slot が前進し続けたこと。
    // 単一スレッド直列モデル（や audio が mailbox 完了を待つ退行）では getState 中
    // seq_done が凍結し、窓中間の前進量が 0 近傍に落ちる。
    let progressed = mid_late - mid_early;
    assert!(
        progressed >= MIN_BLOCKS_DURING_SAVE,
        "保存窓の中間 300ms での audio 前進が {progressed} ブロック（< {MIN_BLOCKS_DURING_SAVE}）— \
         SAVE_STATE が audio スレッドを止めている（演奏中保存の解禁が退行）"
    );

    // (3) 保存内容が現在 state（復元済みオフセット）であること。
    let captured = std::fs::read(&sidecar).expect("サイドカーが書かれていない");
    assert_eq!(response.bytes_written, captured.len() as u64);
    assert_eq!(
        orbit_vst3_synth_oracle::decode_state(&captured),
        Some(RESTORED_SEMITONES),
        "吸い上げた state が復元値と違う (captured={captured:?})"
    );

    // (4) sanity: submitter が実際に相当量を流していたこと。
    assert!(
        submitted_blocks > MIN_BLOCKS_DURING_SAVE,
        "submitter が {submitted_blocks} ブロックしか submit していない"
    );

    let _ = std::fs::remove_file(&sidecar);
    let _ = std::fs::remove_file(&restore_path);
}
