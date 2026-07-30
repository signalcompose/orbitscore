use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use orbit_audio_sandbox::transport::CHILD_STATUS_READY;
use orbit_audio_sandbox::{SharedRegion, CONTROL_QUIT};

static SHM_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn unique_temp(prefix: &str) -> PathBuf {
    let id = SHM_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{prefix}-{}-{id}", std::process::id()))
}

/// child が exit するまで面倒を見る（テストが panic しても孤児を残さない）。
pub struct ChildGuard {
    pub child: Child,
    pub region: *mut SharedRegion,
    pub shm: PathBuf,
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

pub fn wait_for_ready(region: *mut SharedRegion, child: &mut Child) {
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
