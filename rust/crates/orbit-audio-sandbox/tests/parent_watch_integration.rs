//! #448 実証テスト: 実プロセス階層で `ParentWatch` の reparent 検知を確認する。
//!
//! `orbit-clap-effect-child` 等の実 child バイナリを直接使うと CLAP plugin の用意が要るため、
//! `parent-watch-probe`（テスト専用ヘルパー・[`ParentWatch`] を実 child と同じロジックで使う）で
//! 3 プロセス階層を作る:
//!   test process
//!     └─ P = `parent-watch-probe spawn-and-wait <marker>`（「daemon」役。SIGKILL で殺す）
//!          └─ C = `parent-watch-probe watch-parent <marker>`（「child」役。P の死活を監視）
//!
//! P を SIGKILL すると、C の `getppid()` が変わり（launchd/PID1 へ reparent）、
//! `ParentWatch::should_exit()` が true を返して C が自発的に exit する。これは daemon が
//! `CONTROL_QUIT` を書かずに死ぬ経路（プロセス exit・SIGKILL・crash）で child が spin-loop に
//! 取り残されないことの直接的な証拠になる。
//!
//! device 非依存(shm も使わない)なので `#[ignore]` なしで CI 実行可能。

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

fn probe_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_parent-watch-probe"))
}

#[test]
fn orphaned_child_exits_after_parent_is_killed() {
    let marker = std::env::temp_dir().join(format!(
        "orbit-parent-watch-probe-{}.marker",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker);

    let mut parent = Command::new(probe_exe())
        .arg("spawn-and-wait")
        .arg(&marker)
        .spawn()
        .expect("spawn parent probe");

    // C(watch-parent)が起動して marker に STARTED を書くまで待つ。
    let started_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(content) = std::fs::read_to_string(&marker) {
            if content.starts_with("STARTED") {
                break;
            }
        }
        assert!(
            Instant::now() < started_deadline,
            "watch-parent child が時間内に起動しなかった"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    // P を SIGKILL する（daemon が CONTROL_QUIT を書かずに死ぬ経路の再現）。
    // std::process::Child::kill() は SIGKILL を送る(unix)。
    parent.kill().expect("kill parent probe");
    let _ = parent.wait();

    // C が reparent を検知して EXITED を書くまで待つ(P kill 後、数秒以内が期待値)。
    let exited_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(content) = std::fs::read_to_string(&marker) {
            if content == "EXITED" {
                break;
            }
            assert_ne!(
                content, "TIMED_OUT",
                "watch-parent child が ParentWatch の内部 timeout(10s)で exit した \
                 (reparent を検知できなかった)"
            );
        }
        assert!(
            Instant::now() < exited_deadline,
            "watch-parent child が親死亡を検知して exit するまでの時間内に終了しなかった"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    let _ = std::fs::remove_file(&marker);
}
