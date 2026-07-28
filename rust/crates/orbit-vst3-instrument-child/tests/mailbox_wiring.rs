//! 本番 child バイナリの**配線**を実プロセス越しに検証する（#555）。
//!
//! ## なぜ別のテストが要るのか
//!
//! `orbit-audio-sandbox` の統合テストは `sandbox-instrument-child`（fixture）を spawn し、
//! メールボックス**プロトコル**（ack / result / detail の規律）を検証する。fixture の
//! handler は固定ペイロードを書くだけで `capture_state()` を呼ばない。
//!
//! したがって「本番 child のメインループが `service_command_mailbox` を呼んでいるか」と
//! 「その handler が実プラグインの state を吸い上げているか」は、**あちらでは一切守られない**。
//! 実測でも、本番 child の呼び出しを `if false { ... }` で包む変異が全テスト green のまま
//! 通過した。純関数とプロトコルを別々にテストしても、**両者を繋ぐ配線は無防備なまま残る**。
//!
//! ## このテストが押さえる全長
//!
//! `--state` で既知のオフセットを**復元**して起動 → メールボックス経由で**吸い上げ** →
//! サイドカーの中身が復元した値と一致することを確認する。実プラグイン（synth oracle）を
//! 実 VST3 ホストでロードした上で、host↔child の shm を実際に往復させる。
//! デバイス不要・無人で判定できる。

#![cfg(target_os = "macos")]
#![allow(unsafe_code)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use orbit_audio_sandbox::transport::{read_cstr_field, write_cstr_field, CHILD_STATUS_READY};
use orbit_audio_sandbox::{
    create_shared, region_ptr, SharedRegion, CMD_RESULT_OK, CMD_SAVE_STATE, CONTROL_QUIT,
};

static SHM_SEQ: AtomicU64 = AtomicU64::new(0);

/// テストが復元させるオフセット。**既定値 0 とも、隣の半音とも違う値**を選ぶ。
/// 0 だと「`--state` を無視しても通る」テストになり、復元経路を検証できない。
const RESTORED_SEMITONES: i32 = 7;

fn unique_temp(prefix: &str) -> PathBuf {
    let id = SHM_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{prefix}-{}-{id}", std::process::id()))
}

/// child が exit するまで面倒を見る（テストが panic しても孤児を残さない）。
struct ChildGuard {
    child: Child,
    region: *mut SharedRegion,
    shm: PathBuf,
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        unsafe {
            (*self.region)
                .control
                .store(CONTROL_QUIT, Ordering::Release)
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => std::hint::spin_loop(),
                // CONTROL_QUIT で降りてこなければ強制終了する。孤児の spin loop を
                // 残すと CPU を焼き続ける（過去に 50 本の孤児で load が跳ねた）。
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        let _ = std::fs::remove_file(&self.shm);
    }
}

fn wait_for_ready(region: *mut SharedRegion, child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while unsafe { (*region).child_status.load(Ordering::Acquire) } != CHILD_STATUS_READY {
        if let Ok(Some(status)) = child.try_wait() {
            panic!("child が READY 前に終了した: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "child が READY にならなかった（VST3 プラグインのロードに失敗した可能性）"
        );
        std::hint::spin_loop();
    }
}

fn await_ack(region: *mut SharedRegion, seq: u64, child: &mut Child) -> (u32, u64, String) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while unsafe { (*region).cmd_ack_seq.load(Ordering::Acquire) } < seq {
        if let Ok(Some(status)) = child.try_wait() {
            panic!("child が ack 前に終了した: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "本番 child が cmd_seq={seq} を ack しなかった — メインループが \
             service_command_mailbox を呼んでいない可能性がある"
        );
        std::hint::spin_loop();
    }
    unsafe {
        (
            (*region).cmd_result.load(Ordering::Relaxed),
            (*region).cmd_result_len.load(Ordering::Relaxed),
            read_cstr_field(&(*region).cmd_result_detail)
                .expect("detail が NUL 終端 UTF-8 でない")
                .to_string(),
        )
    }
}

fn spawn_real_child(shm: &Path, plugin: &Path, state: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_orbit-vst3-instrument-child"))
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
fn real_child_captures_the_hosted_plugin_state_through_the_command_mailbox() {
    let Some(bundle) = orbit_vst3_synth_oracle::package_bundle() else {
        eprintln!("VST3 synth oracle build failed; loud skip for this machine");
        return;
    };

    // 復元用 state を用意する。この値がそのまま「吸い上げで戻ってくるべき値」になる。
    let restore_path = unique_temp("orbit-wiring-restore.bin");
    std::fs::write(
        &restore_path,
        orbit_vst3_synth_oracle::encode_state(RESTORED_SEMITONES),
    )
    .expect("restore state を書けない");

    let shm = unique_temp("orbit-wiring.shm");
    let mmap = create_shared(&shm).expect("create_shared");
    let region = region_ptr(&mmap);
    let mut guard = ChildGuard {
        child: spawn_real_child(&shm, &bundle, &restore_path),
        region,
        shm: shm.clone(),
    };

    wait_for_ready(region, &mut guard.child);

    let sidecar = unique_temp("orbit-wiring-captured.bin");
    let _ = std::fs::remove_file(&sidecar);
    unsafe {
        assert!(
            write_cstr_field(
                &mut (*region).cmd_arg,
                sidecar.to_str().expect("temp path is UTF-8")
            ),
            "cmd_arg に収まらないパス"
        );
        (*region).cmd_kind.store(CMD_SAVE_STATE, Ordering::Relaxed);
        // seq を最後に Release で publish する（child は Acquire で読む）。
        (*region).cmd_seq.store(1, Ordering::Release);
    }

    let (result, len, detail) = await_ack(region, 1, &mut guard.child);
    assert_eq!(
        result, CMD_RESULT_OK,
        "本番 child が保存に失敗した: {detail}"
    );

    let captured = std::fs::read(&sidecar).expect("サイドカーが書かれていない");
    assert_eq!(
        len,
        captured.len() as u64,
        "cmd_result_len が実際に書かれたバイト数と一致しない"
    );
    // 🔴 ここが配線の核心。fixture の固定ペイロードではなく、**実プラグインの state** が
    // 出てきていること、しかも起動時に復元した値と一致していることを確認する。
    assert_eq!(
        orbit_vst3_synth_oracle::decode_state(&captured),
        Some(RESTORED_SEMITONES),
        "吸い上げた state が復元した値と違う — capture_state が実プラグインを \
         見ていないか、--state の復元が効いていない (captured={captured:?})"
    );

    let _ = std::fs::remove_file(&sidecar);
    let _ = std::fs::remove_file(&restore_path);
}

#[test]
fn real_child_reports_an_unknown_command_instead_of_hanging() {
    let Some(bundle) = orbit_vst3_synth_oracle::package_bundle() else {
        eprintln!("VST3 synth oracle build failed; loud skip for this machine");
        return;
    };

    let restore_path = unique_temp("orbit-wiring-restore2.bin");
    std::fs::write(&restore_path, orbit_vst3_synth_oracle::encode_state(0))
        .expect("restore state を書けない");

    let shm = unique_temp("orbit-wiring2.shm");
    let mmap = create_shared(&shm).expect("create_shared");
    let region = region_ptr(&mmap);
    let mut guard = ChildGuard {
        child: spawn_real_child(&shm, &bundle, &restore_path),
        region,
        shm: shm.clone(),
    };

    wait_for_ready(region, &mut guard.child);

    unsafe {
        assert!(write_cstr_field(
            &mut (*region).cmd_arg,
            "/tmp/never-written"
        ));
        (*region).cmd_kind.store(0xDEAD_BEEF, Ordering::Relaxed);
        (*region).cmd_seq.store(1, Ordering::Release);
    }

    let (result, _len, detail) = await_ack(region, 1, &mut guard.child);
    assert_ne!(
        result, CMD_RESULT_OK,
        "本番 child が未知コマンドを成功として ack した"
    );
    assert!(
        detail.contains("unknown cmd_kind"),
        "detail が理由を伝えていない: {detail:?}"
    );

    let _ = std::fs::remove_file(&restore_path);
}
