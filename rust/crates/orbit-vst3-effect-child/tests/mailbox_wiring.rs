#![cfg(target_os = "macos")]
#![allow(unsafe_code)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use orbit_audio_sandbox::transport::{read_cstr_field, write_cstr_field, CHILD_STATUS_READY};
use orbit_audio_sandbox::{
    create_shared, region_ptr, CommandMailboxError, CommandMailboxHost, SharedRegion,
    CMD_RESULT_OK, CONTROL_QUIT,
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
    while unsafe { (*region).child_status.load(Ordering::Acquire) != CHILD_STATUS_READY } {
        if let Ok(Some(status)) = child.try_wait() {
            panic!("VST3 effect child exited before READY: {status}");
        }
        assert!(Instant::now() < deadline, "VST3 effect child READY timeout");
        std::thread::yield_now();
    }
}

fn spawn_child(shm: &Path, plugin: &Path, state: &Path) -> Child {
    spawn_child_with_env(shm, plugin, state, &[])
}

fn spawn_child_with_env(shm: &Path, plugin: &Path, state: &Path, env: &[(&str, &str)]) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_orbit-vst3-effect-child"));
    for (key, value) in env {
        command.env(key, value);
    }
    command
        .args(["--shm"])
        .arg(shm)
        .args(["--plugin"])
        .arg(plugin)
        .args(["--sample-rate", "48000", "--state"])
        .arg(state)
        .spawn()
        .expect("spawn VST3 effect child")
}

fn await_ack(region: *mut SharedRegion, seq: u64, child: &mut Child) -> (u32, String) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while unsafe { (*region).cmd_ack_seq.load(Ordering::Acquire) } < seq {
        if let Ok(Some(status)) = child.try_wait() {
            panic!("VST3 effect child exited before ack: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "VST3 effect child did not ack cmd_seq={seq}"
        );
        std::thread::yield_now();
    }
    unsafe {
        (
            (*region).cmd_result.load(Ordering::Relaxed),
            read_cstr_field(&(*region).cmd_result_detail)
                .expect("command detail must be NUL-terminated UTF-8")
                .to_owned(),
        )
    }
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

#[test]
fn real_effect_child_reports_an_unknown_command_instead_of_hanging() {
    let Some(plugin) = package_oracle() else {
        eprintln!("VST3 gain oracle unavailable; loud skip");
        return;
    };
    let restore = unique_temp("orbit-vst3-effect-unknown-restore.state");
    std::fs::write(&restore, encode_state(0.25)).expect("write restore state");
    let shm = unique_temp("orbit-vst3-effect-unknown.shm");
    let mmap = create_shared(&shm).expect("create shared memory");
    let region = region_ptr(&mmap);
    let mut child = ChildGuard {
        child: spawn_child(&shm, &plugin, &restore),
        region,
        shm: shm.clone(),
    };
    wait_ready(region, &mut child.child);

    let never_written = unique_temp("orbit-vst3-effect-unknown-output.state");
    unsafe {
        assert!(write_cstr_field(
            &mut (*region).cmd_arg,
            never_written.to_str().expect("UTF-8 test path"),
        ));
        (*region).cmd_kind.store(0xDEAD_BEEF, Ordering::Relaxed);
        (*region).cmd_seq.store(1, Ordering::Release);
    }
    let (result, detail) = await_ack(region, 1, &mut child.child);
    assert_ne!(result, CMD_RESULT_OK);
    assert!(detail.contains("unknown cmd_kind"), "{detail:?}");
    assert!(!never_written.exists());

    let _ = std::fs::remove_file(restore);
}

#[test]
fn an_empty_state_from_the_plugin_is_reported_as_a_failure_not_logged_as_success() {
    let Some(plugin) = package_oracle() else {
        eprintln!("VST3 gain oracle unavailable; loud skip");
        return;
    };
    let restore = unique_temp("orbit-vst3-effect-empty-restore.state");
    std::fs::write(&restore, encode_state(0.25)).expect("write restore state");
    let shm = unique_temp("orbit-vst3-effect-empty.shm");
    let mmap = create_shared(&shm).expect("create shared memory");
    let region = region_ptr(&mmap);
    let mut child = ChildGuard {
        child: spawn_child_with_env(
            &shm,
            &plugin,
            &restore,
            &[("ORBIT_VST3_GAIN_EMPTY_STATE", "1")],
        ),
        region,
        shm: shm.clone(),
    };
    wait_ready(region, &mut child.child);

    let sidecar = unique_temp("orbit-vst3-effect-empty-captured.state");
    let error = CommandMailboxHost::new(shm)
        .issue_save_state(&sidecar)
        .expect_err("empty VST3 effect state must not be acknowledged as success");
    let CommandMailboxError::CommandFailed { result, detail, .. } = error else {
        panic!("empty VST3 effect state returned a non-command failure: {error}");
    };
    assert_ne!(result, CMD_RESULT_OK);
    assert!(
        detail.contains("empty chunk"),
        "detail must identify empty VST3 state: {detail:?}"
    );
    assert!(!sidecar.exists());

    let _ = std::fs::remove_file(restore);
}

#[test]
fn a_corrupt_state_file_makes_the_child_exit_instead_of_going_ready_with_the_default_sound() {
    let Some(plugin) = package_oracle() else {
        eprintln!("VST3 gain oracle unavailable; loud skip");
        return;
    };
    let mut corrupt = encode_state(0.25);
    corrupt[0] ^= 0xFF;
    let restore = unique_temp("orbit-vst3-effect-corrupt-restore.state");
    std::fs::write(&restore, corrupt).expect("write corrupt restore state");
    let shm = unique_temp("orbit-vst3-effect-corrupt.shm");
    let mmap = create_shared(&shm).expect("create shared memory");
    let region = region_ptr(&mmap);
    let mut child = ChildGuard {
        child: spawn_child(&shm, &plugin, &restore),
        region,
        shm: shm.clone(),
    };

    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Ok(Some(status)) = child.child.try_wait() {
            break status;
        }
        assert_ne!(
            unsafe { (*region).child_status.load(Ordering::Acquire) },
            CHILD_STATUS_READY,
            "corrupt VST3 effect state must not publish READY with the default sound"
        );
        assert!(
            Instant::now() < deadline,
            "VST3 effect child neither exited nor became READY"
        );
        std::thread::yield_now();
    };
    assert!(
        !status.success(),
        "corrupt VST3 effect restore exited successfully"
    );

    let _ = std::fs::remove_file(restore);
}
