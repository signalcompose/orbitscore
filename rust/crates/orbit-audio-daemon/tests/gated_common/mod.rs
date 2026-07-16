//! gated（実機）テスト群の共有ヘルパー。feature 非依存の純 std のみを置く
//! （tokio/WebSocket を使う integration harness は `tests/common/mod.rs` が別に持つ）。

#![allow(dead_code)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

/// repo ルート相対パスを解決する（MANIFEST_DIR = rust/crates/orbit-audio-daemon）。
pub fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

/// 別 crate の child binary パスを解決する。`CARGO_BIN_EXE_*` は使えないため、
/// test 実行ファイル（`target/<profile>/deps/<name>-<hash>`）の祖先から sibling を導く（profile 非依存）。
pub fn child_exe(name: &str) -> PathBuf {
    let mut path = std::env::current_exe().expect("current_exe");
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.push(name);
    path
}

/// `timeout` まで 20ms 間隔で `condition` を poll し、成立したら true を返す。
pub fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    condition()
}
