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
