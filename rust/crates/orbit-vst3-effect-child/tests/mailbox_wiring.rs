#![cfg(target_os = "macos")]
#![allow(unsafe_code)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use orbit_audio_sandbox::{
    create_shared, region_ptr, CommandMailboxHost, SharedRegion, CONTROL_QUIT,
};
use orbit_vst3_gain_oracle::encode_state;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn unique_temp(label: &str) -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{label}-{}-{seq}", std::process::id()))
}

fn package_oracle() -> Option<PathBuf> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../orbit-vst3-gain-oracle/package-oracle.sh");
    let output = Command::new(script).output().ok()?;
    if !output.status.success() {
        eprintln!(
            "VST3 gain oracle packaging failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return None;
    }
    Some(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

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
        while self.child.try_wait().ok().flatten().is_none() {
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                break;
            }
            std::thread::yield_now();
        }
        let _ = std::fs::remove_file(&self.shm);
    }
}

fn wait_ready(region: *mut SharedRegion, child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while unsafe {
        (*region).child_status.load(Ordering::Acquire)
            != orbit_audio_sandbox::transport::CHILD_STATUS_READY
    } {
        if let Ok(Some(status)) = child.try_wait() {
            panic!("VST3 effect child exited before READY: {status}");
        }
        assert!(Instant::now() < deadline, "VST3 effect child READY timeout");
        std::thread::yield_now();
    }
}

fn spawn_child(shm: &Path, plugin: &Path, state: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_orbit-vst3-effect-child"))
        .args(["--shm"])
        .arg(shm)
        .args(["--plugin"])
        .arg(plugin)
        .args(["--sample-rate", "48000", "--state"])
        .arg(state)
        .spawn()
        .expect("spawn VST3 effect child")
}

#[test]
fn real_effect_child_restores_and_captures_state_through_the_host_mailbox() {
    let Some(plugin) = package_oracle() else {
        eprintln!("VST3 effect oracle unavailable; loud skip");
        return;
    };
    let expected = encode_state(0.25);
    let restore = unique_temp("orbit-vst3-effect-restore.state");
    std::fs::write(&restore, expected).expect("write restore state");
    let shm = unique_temp("orbit-vst3-effect-mailbox.shm");
    let mmap = create_shared(&shm).expect("create shared memory");
    let region = region_ptr(&mmap);
    let mut child = ChildGuard {
        child: spawn_child(&shm, &plugin, &restore),
        region,
        shm: shm.clone(),
    };
    wait_ready(region, &mut child.child);

    let sidecar = unique_temp("orbit-vst3-effect-captured.state");
    let response = CommandMailboxHost::new(shm)
        .issue_save_state(&sidecar)
        .expect("host mailbox save");
    let captured = std::fs::read(&sidecar).expect("read captured state");
    assert_eq!(response.bytes_written, expected.len() as u64);
    assert_eq!(captured, expected);

    let _ = std::fs::remove_file(sidecar);
    let _ = std::fs::remove_file(restore);
}
