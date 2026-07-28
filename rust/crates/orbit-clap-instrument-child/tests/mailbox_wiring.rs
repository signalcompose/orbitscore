//! CLAP 本番 child バイナリの**配線**を実プロセス越しに検証する（#557）。
//!
//! **VST3 側 `orbit-vst3-instrument-child/tests/mailbox_wiring.rs` と同じ構造・同じ判定**。
//! 受け入れ基準「VST3 と CLAP の両方で同じ E2E が green」を、この対称性で満たす。
//!
//! ## このテストが押さえる全長
//!
//! `--state` で既知のオフセットを**復元**して起動 → メールボックス経由で**吸い上げ** →
//! サイドカーの中身が復元した値と一致することを確認する。実 CLAP プラグイン
//! （`rust-spike/clap-test-synth` の oracle）を実ホストでロードした上で、
//! host↔child の shm を実際に往復させる。デバイス不要・無人で判定できる。
//!
//! ## oracle のビルドについて
//!
//! `clap-test-synth` は `rust-spike/` の独立ワークスペースにあり、この crate から
//! dev-dependency にできない。既存の CLAP gated テストと同じく**スクリプト経由でビルド**し、
//! 失敗したら loud skip する（VST3 側の `package_bundle()` と同じ扱い）。

#![cfg(target_os = "macos")]
#![allow(unsafe_code)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use orbit_audio_sandbox::transport::{read_cstr_field, write_cstr_field, CHILD_STATUS_READY};
use orbit_audio_sandbox::{
    create_shared, region_ptr, CommandMailboxError, CommandMailboxHost, SharedRegion,
    CMD_RESULT_OK, CONTROL_QUIT,
};

static SHM_SEQ: AtomicU64 = AtomicU64::new(0);

/// テストが復元させるオフセット。**既定値 0 とも、隣の半音とも違う値**を選ぶ。
/// 0 だと「`--state` を無視しても通る」テストになり、復元経路を検証できない。
const RESTORED_SEMITONES: i32 = 7;

/// `clap-test-synth` の state エンコード（oracle 側 `encode_state` と**同じ契約**）。
///
/// oracle は別ワークスペースなので関数を共有できない。バイト並びを**仕様として**ここに
/// 書き下すことで、片方だけエンコードを変えたらこのテストが red になる
/// （oracle 側にも `state_encoding_matches_the_cross_format_contract` が同じ契約を固定している）。
fn encode_state(semitone_offset: i32) -> [u8; 8] {
    const STATE_MAGIC: u32 = 0x4F52_4331; // "ORC1"
    let mut out = [0u8; 8];
    out[..4].copy_from_slice(&STATE_MAGIC.to_le_bytes());
    out[4..].copy_from_slice(&semitone_offset.to_le_bytes());
    out
}

fn decode_state(bytes: &[u8]) -> Option<i32> {
    const STATE_MAGIC: u32 = 0x4F52_4331;
    if bytes.len() < 8 {
        return None;
    }
    if u32::from_le_bytes(bytes[0..4].try_into().ok()?) != STATE_MAGIC {
        return None;
    }
    Some(i32::from_le_bytes(bytes[4..8].try_into().ok()?))
}

fn repo_root() -> PathBuf {
    // MANIFEST_DIR = rust/crates/orbit-clap-instrument-child
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

/// oracle の `.clap` バンドルをビルドして返す。失敗したら `None`（呼び出し側は loud skip）。
fn package_clap_oracle() -> Option<PathBuf> {
    static BUNDLE: OnceLock<Option<PathBuf>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| {
            let crate_dir = repo_root().join("rust-spike/clap-test-synth");
            let script = crate_dir.join("bundle-macos.sh");
            let output = Command::new(&script)
                .current_dir(&crate_dir)
                .output()
                .ok()?;
            if !output.status.success() {
                eprintln!(
                    "clap oracle packaging failed: status={} stderr={}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                );
                return None;
            }
            let bundle = crate_dir.join("target/debug/CLAPTestSynth.clap");
            if !bundle.exists() {
                eprintln!("clap oracle bundle not found at {bundle:?}");
                return None;
            }
            Some(bundle)
        })
        .clone()
}

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
                // CONTROL_QUIT で降りてこなければ強制終了する。孤児の spin loop は CPU を焼く。
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
            "child が READY にならなかった（CLAP プラグインのロードに失敗した可能性）"
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
            "CLAP child が cmd_seq={seq} を ack しなかった — メインループが \
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
    spawn_real_child_with_env(shm, plugin, state, &[])
}

fn spawn_real_child_with_env(
    shm: &Path,
    plugin: &Path,
    state: &Path,
    env: &[(&str, &str)],
) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_orbit-clap-instrument-child"));
    for (key, value) in env {
        command.env(key, value);
    }
    command
        .arg("--shm")
        .arg(shm)
        .arg("--plugin")
        .arg(plugin)
        .arg("--sample-rate")
        .arg("48000")
        .arg("--state")
        .arg(state)
        .spawn()
        .expect("spawn orbit-clap-instrument-child")
}

#[test]
fn real_clap_child_captures_the_hosted_plugin_state_through_the_command_mailbox() {
    let Some(bundle) = package_clap_oracle() else {
        eprintln!("CLAP synth oracle build failed; loud skip for this machine");
        return;
    };

    let restore_path = unique_temp("orbit-clap-wiring-restore.bin");
    std::fs::write(&restore_path, encode_state(RESTORED_SEMITONES))
        .expect("restore state を書けない");

    let shm = unique_temp("orbit-clap-wiring.shm");
    let mmap = create_shared(&shm).expect("create_shared");
    let region = region_ptr(&mmap);
    let mut guard = ChildGuard {
        child: spawn_real_child(&shm, &bundle, &restore_path),
        region,
        shm: shm.clone(),
    };

    wait_for_ready(region, &mut guard.child);

    let sidecar = unique_temp("orbit-clap-wiring-captured.bin");
    let _ = std::fs::remove_file(&sidecar);
    // 🔴 **host 側は production と同じ [`CommandMailboxHost`] で発行する**。手書きで
    // `cmd_kind`/`cmd_seq` を叩くと、single-outstanding・完全一致 ack・timeout といった
    // host 側の不変条件を**迂回したまま**「child は ack した」しか言えないテストになる。
    let response = CommandMailboxHost::new(shm.clone())
        .issue_save_state(&sidecar)
        .expect("CLAP child が state を保存しなかった");

    let captured = std::fs::read(&sidecar).expect("サイドカーが書かれていない");
    assert_eq!(
        response.bytes_written,
        captured.len() as u64,
        "cmd_result_len が実際に書かれたバイト数と一致しない"
    );
    // 🔴 配線の核心。実 CLAP プラグインの state が出てきていること、しかも起動時に
    // 復元した値と一致していることを確認する（= `--state` と `CMD_SAVE_STATE` の往復）。
    assert_eq!(
        decode_state(&captured),
        Some(RESTORED_SEMITONES),
        "吸い上げた state が復元した値と違う — capture_state が実プラグインを \
         見ていないか、--state の復元が効いていない (captured={captured:?})"
    );

    let _ = std::fs::remove_file(&sidecar);
    let _ = std::fs::remove_file(&restore_path);
}

#[test]
fn real_clap_child_reports_an_unknown_command_instead_of_hanging() {
    let Some(bundle) = package_clap_oracle() else {
        eprintln!("CLAP synth oracle build failed; loud skip for this machine");
        return;
    };

    let restore_path = unique_temp("orbit-clap-wiring-restore2.bin");
    std::fs::write(&restore_path, encode_state(0)).expect("restore state を書けない");

    let shm = unique_temp("orbit-clap-wiring2.shm");
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
        // ⚠️ ここだけ raw に書く。[`CommandMailboxHost`] は `CMD_SAVE_STATE` しか発行できず、
        // **このテストの目的は「型付き API では作れないコマンド」を child に投げること**だから。
        // 旧方式の残骸ではない。
        (*region).cmd_kind.store(0xDEAD_BEEF, Ordering::Relaxed);
        (*region).cmd_seq.store(1, Ordering::Release);
    }

    let (result, _len, detail) = await_ack(region, 1, &mut guard.child);
    assert_ne!(
        result, CMD_RESULT_OK,
        "CLAP child が未知コマンドを成功として ack した"
    );
    assert!(
        detail.contains("unknown cmd_kind"),
        "detail が理由を伝えていない: {detail:?}"
    );

    let _ = std::fs::remove_file(&restore_path);
}

/// 🔴 **空 state を「成功」として登記しない**ガードを実際に踏む（spec UIH.3）。
///
/// 通常の oracle は常に非空を返すため、このガードは**どのテストでも踏めなかった**
/// （VST3 側は無防備であることをコメントで自覚するに留まっている）。oracle に
/// 「何も書かずに成功を返す」モードを足して、host 側が `Err` に倒すことを実証する。
///
/// 規格上、state を持たないプラグインが 0 バイト + `true` を返すのは違反ではないので、
/// これは架空の状況ではなく実在しうる挙動。
#[test]
fn an_empty_state_from_the_plugin_is_reported_as_a_failure_not_logged_as_success() {
    let Some(bundle) = package_clap_oracle() else {
        eprintln!("CLAP synth oracle build failed; loud skip for this machine");
        return;
    };

    let restore_path = unique_temp("orbit-clap-empty-restore.bin");
    std::fs::write(&restore_path, encode_state(0)).expect("restore state を書けない");

    let shm = unique_temp("orbit-clap-empty.shm");
    let mmap = create_shared(&shm).expect("create_shared");
    let region = region_ptr(&mmap);
    let mut guard = ChildGuard {
        child: spawn_real_child_with_env(
            &shm,
            &bundle,
            &restore_path,
            &[("CLAP_TEST_SYNTH_EMPTY_STATE", "1")],
        ),
        region,
        shm: shm.clone(),
    };

    wait_for_ready(region, &mut guard.child);

    let sidecar = unique_temp("orbit-clap-empty-captured.bin");
    let _ = std::fs::remove_file(&sidecar);
    // production と同じ発行経路で失敗させる。**host 側がこの失敗をどう表面化するか**まで
    // 込みで検査したいので、raw に叩かない。
    let error = CommandMailboxHost::new(shm.clone())
        .issue_save_state(&sidecar)
        .expect_err("空 state を成功として ack した（音色を失ったことに気づけなくなる）");
    let CommandMailboxError::CommandFailed { result, detail, .. } = error else {
        panic!("空 state が CommandFailed 以外で返った: {error}");
    };
    assert_ne!(result, CMD_RESULT_OK, "失敗なのに result が OK");
    // 🔴 リテラルを書き写さない。実装と同じ定数を見ることで、**文言ではなく
    // 「この分岐が発火したか」**を検査する（文言を整理しただけで red になるのを防ぐ）。
    assert!(
        detail.contains(orbit_clap_host::EMPTY_STATE_FROM_PLUGIN),
        "detail が空 state を理由として伝えていない: {detail:?}"
    );
    assert!(
        !sidecar.exists(),
        "失敗したのにサイドカーを書いた（空ファイルが登記されうる）"
    );

    let _ = std::fs::remove_file(&restore_path);
}

/// 🔴 **壊れた state で復元に失敗したら、READY を publish せずに落ちる**こと。
///
/// 「復元に失敗したまま READY になって既定音色で鳴る」経路が無いことを実証する。
/// コードを読めば `?` で早期 return するのは分かるが、**それを裏付ける実行結果が
/// 両形式ともゼロ**だったので足す（silent-failure レビューの指摘）。
#[test]
fn a_corrupt_state_file_makes_the_child_exit_instead_of_going_ready_with_the_default_sound() {
    let Some(bundle) = package_clap_oracle() else {
        eprintln!("CLAP synth oracle build failed; loud skip for this machine");
        return;
    };

    // magic を壊す。長さは正しいので「短すぎて弾かれた」ではないことが分かる。
    let mut corrupt = encode_state(7);
    corrupt[0] ^= 0xFF;
    let restore_path = unique_temp("orbit-clap-corrupt-restore.bin");
    std::fs::write(&restore_path, corrupt).expect("restore state を書けない");

    let shm = unique_temp("orbit-clap-corrupt.shm");
    let mmap = create_shared(&shm).expect("create_shared");
    let region = region_ptr(&mmap);
    let mut guard = ChildGuard {
        child: spawn_real_child(&shm, &bundle, &restore_path),
        region,
        shm: shm.clone(),
    };

    // READY を待たずに終了を待つ。READY が立ってしまったら、それ自体が退行。
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Ok(Some(status)) = guard.child.try_wait() {
            break status;
        }
        assert_ne!(
            unsafe { (*region).child_status.load(Ordering::Acquire) },
            CHILD_STATUS_READY,
            "壊れた state なのに READY になった — 既定音色のまま鳴ってしまう"
        );
        assert!(
            Instant::now() < deadline,
            "child が終了も READY もしないまま固まった"
        );
        std::hint::spin_loop();
    };
    assert!(
        !status.success(),
        "復元に失敗したのに成功終了した: {status}"
    );

    let _ = std::fs::remove_file(&restore_path);
}
