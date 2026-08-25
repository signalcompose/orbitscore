//! sandbox child プロセスの teardown RAII ガード。
//!
//! host(daemon / offline driver / test)が起動した child を、drop / panic / 早期 return のいずれでも
//! 確実に後始末する: `control` に [`CONTROL_QUIT`] を store(graceful)→ 一定時間 reap を待つ →
//! ダメなら `kill` → shm ファイル削除。teardown シーケンスを 1 箇所に集約し、offline driver・
//! 統合テスト・PR-C の supervision が **同じ手順**を共有する(将来 drain/flush を足すならここに足す)。
//!
//! `region`(制御用 `*mut SharedRegion`)と shm `path` は、RT 保持側の mmap とは別 mapping でよい
//! (例: `PipelinedEffectHost::from_mmap` が host mmap を消費する場合、test/daemon は制御専用の
//! 第 2 mapping を開いて本ガードに渡す)。本ガードはその制御 mapping を生かす責務は負わない —
//! 呼び出し側が本ガードより後まで mapping を生かすこと(生ポインタの有効性の前提)。

#![allow(unsafe_code)]

use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::Ordering::Release;
use std::time::{Duration, Instant};

use crate::transport::{SharedRegion, CONTROL_QUIT};

/// graceful QUIT 後に child の終了を待つ上限(超えたら kill にフォールバック)。
const REAP_TIMEOUT: Duration = Duration::from_secs(2);

/// child プロセスの後始末ガード(drop で QUIT → reap → shm 削除)。
pub struct SandboxChildGuard {
    child: Child,
    region: *mut SharedRegion,
    path: PathBuf,
}

impl SandboxChildGuard {
    /// `child` = 起動済み child、`region` = 制御用 SharedRegion ポインタ(本ガードより後まで
    /// 生きる mapping を指すこと)、`path` = drop 時に削除する shm ファイル。
    pub fn new(child: Child, region: *mut SharedRegion, path: PathBuf) -> Self {
        Self {
            child,
            region,
            path,
        }
    }
}

impl Drop for SandboxChildGuard {
    fn drop(&mut self) {
        // child に正常終了を要求 → 一定時間待って、ダメなら kill。
        // SAFETY: region は呼び出し側が本ガードより後まで生かす mapping を指す(構築時の契約)。
        unsafe {
            (*self.region).control.store(CONTROL_QUIT, Release);
        }
        // TODO(PR-C): respawn 判断のため child の ExitStatus を捕捉して supervisor へ渡す
        // (本ガードは teardown 専用で終了 status を破棄する)。親プロセス死亡時の孤児化対策
        // (PR_SET_PDEATHSIG 等)も supervisor 層で扱う。
        let deadline = Instant::now() + REAP_TIMEOUT;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                // 非 RT の teardown 待ち。spin より yield で CPU を譲る(offline.rs の wait と一貫)。
                Ok(None) if Instant::now() < deadline => std::thread::yield_now(),
                Ok(None) => {
                    eprintln!(
                        "orbit-audio-sandbox: child が {REAP_TIMEOUT:?} 以内に終了せず kill にフォールバック"
                    );
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
                // try_wait 自体の失敗(ECHILD 等)は timeout と区別して実エラーを出す。
                Err(e) => {
                    eprintln!("orbit-audio-sandbox: try_wait 失敗(kill にフォールバック): {e}");
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        if let Err(e) = std::fs::remove_file(&self.path) {
            eprintln!(
                "orbit-audio-sandbox: shm ファイル削除失敗 {:?}: {e}",
                self.path
            );
        }
    }
}

/// 実行ファイルを 1 回だけ空 spawn して、OS の初回評価コストを先払いする。
///
/// 🔴 なぜ必要か（2026-08-25 実測・#520）
///
/// macOS は**新規に作成された実行ファイル**の spawn 時にセキュリティ評価
/// （Gatekeeper / XProtect / syspolicyd）を行う。実測値:
///
/// | spawn 対象                       | p50    | max   |
/// |----------------------------------|--------|-------|
/// | 既存のシステムバイナリ(/bin/echo)  | 1.0ms  | 3ms   |
/// | 毎回新規作成した実行ファイル        | 93.8ms | 178ms |
///
/// さらに評価済みの実行ファイルでも稀に数秒〜24 秒停止する（実測: 675ms / 3.8s / 9.0s / 24.6s）。
/// `cargo build` 直後の child バイナリはまさに「新規作成された実行ファイル」なので、
/// 最初の spawn を含むブロックが数秒の deadline を超えて **crash でないのに TimedOut で
/// false-fail** する。実際に `oracle_parity` がこれで落ちた。
///
/// 待つのは `'spawn' 相当`（プロセス起動の成功）までで十分なので、起動を確認したら即 kill する。
/// **exit を待ってはいけない**（対象にはハングし続ける child も含まれる）。
///
/// TS 側の同等物は `tests/helpers/spawn-fixture.ts`。
pub fn warm_up_executable(path: &std::path::Path) {
    use std::sync::OnceLock;
    // 同一プロセス内で同じ実行ファイルを何度も warm up しない。
    static WARMED: OnceLock<std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>>> =
        OnceLock::new();
    let warmed = WARMED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    {
        let mut guard = warmed.lock().expect("warm-up set poisoned");
        if !guard.insert(path.to_path_buf()) {
            return;
        }
    }
    // 引数なしで起動する。異常終了・即時終了のいずれでも評価は完了しているので結果は見ない。
    if let Ok(mut child) = std::process::Command::new(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}
