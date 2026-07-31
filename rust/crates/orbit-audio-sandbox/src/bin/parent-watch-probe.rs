//! parent-watch-probe — テスト専用の小さなヘルパー。実プロセス階層で
//! [`orbit_audio_sandbox::ParentWatch`] の reparent 検知を実証する
//! (tests/parent_watch_integration.rs から spawn される)。
//!
//! サブコマンド:
//!   spawn-and-wait <marker_path>   自分の子として `watch-parent <marker_path>` を spawn し、
//!                                  そのまま SIGKILL で殺されるまで sleep する（=「親(daemon)役」）。
//!   watch-parent <marker_path>     [`ParentWatch`] で自分の親（上記プロセス）の死活を監視し、
//!                                  検知したら marker ファイルへ "EXITED" と書いて exit する
//!                                  （=「child 役」。実 child バイナリと同じ検知ロジックを使う）。

use std::env;
use std::fs;
use std::process::Command;
use std::time::{Duration, Instant};

use orbit_audio_sandbox::ParentWatch;

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("spawn-and-wait") => {
            let marker = args.next().expect("marker_path required");
            let self_exe = env::current_exe().expect("current_exe");
            // 意図的に wait() しない: この probe は SIGKILL で強制終了させる想定(#448 の再現)。
            // wait() すると SIGKILL 後にこのプロセス自体が残った子を reap する機会がなくなり
            // テストの意図(reparent 検知)と無関係な zombie-processes lint が出るが、テスト側で
            // 検証対象(C の exit)を確認した後は OS が孤児プロセスを reap する。
            #[allow(clippy::zombie_processes)]
            let _child = Command::new(self_exe)
                .arg("watch-parent")
                .arg(&marker)
                .spawn()
                .expect("spawn watch-parent child");
            // 親(このプロセス)は SIGKILL されるまで sleep するだけ。
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        Some("watch-parent") => {
            let marker = args.next().expect("marker_path required");
            fs::write(&marker, format!("STARTED:{}", std::process::id())).expect("write marker");
            let watch = ParentWatch::with_interval(Duration::from_millis(20));
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if watch.should_exit() {
                    fs::write(&marker, "EXITED").expect("write marker");
                    return;
                }
                if Instant::now() > deadline {
                    fs::write(&marker, "TIMED_OUT").expect("write marker");
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        other => panic!("unknown subcommand: {other:?}"),
    }
}
