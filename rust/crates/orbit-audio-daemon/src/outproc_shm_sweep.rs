#![allow(unsafe_code)]

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

pub const OUTPROC_SHM_PREFIX: &str = "orbit-outproc-";
/// TOCTOU の保険。起動から 2 秒未満で死亡した daemon のファイルは次回へ先送りする。
pub const MIN_ORPHAN_AGE: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PidLiveness {
    Alive,
    Dead,
    Unknown,
}

pub fn probe_pid_liveness(pid: u32) -> PidLiveness {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return PidLiveness::Unknown;
    };
    if pid < 1 {
        return PidLiveness::Unknown;
    }

    // SAFETY: signal 0 does not deliver a signal; it only asks the kernel to validate the PID.
    if unsafe { libc::kill(pid, 0) } == 0 {
        PidLiveness::Alive
    } else if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        PidLiveness::Dead
    } else {
        PidLiveness::Unknown
    }
}

pub fn parse_outproc_shm_name(name: &OsStr) -> Option<u32> {
    let rest = name.to_str()?.strip_prefix(OUTPROC_SHM_PREFIX)?;
    let (role, rest) = rest.split_once('-')?;
    if role.is_empty() || !role.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return None;
    }
    let (pid, rest) = rest.split_once('-')?;
    let pid = pid.parse::<u32>().ok().filter(|pid| *pid >= 1)?;
    let (seq, _) = rest.split_once(".shm")?;
    seq.parse::<u32>().ok()?;
    Some(pid)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepSummary {
    pub scanned: usize,
    pub removed: usize,
    pub kept_alive: usize,
    pub kept_unknown: usize,
    pub kept_young: usize,
    pub failed: usize,
    pub dir_error: Option<String>,
}

pub fn sweep_dir(
    dir: &Path,
    self_pid: u32,
    now: SystemTime,
    min_age: Duration,
    liveness: &dyn Fn(u32) -> PidLiveness,
) -> SweepSummary {
    let mut summary = SweepSummary::default();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            summary.failed = 1;
            summary.dir_error = Some(error.to_string());
            return summary;
        }
    };
    let mut liveness_by_pid = HashMap::new();

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                summary.failed += 1;
                continue;
            }
        };
        let is_file = match entry.file_type() {
            Ok(file_type) => file_type.is_file(),
            Err(_) => {
                summary.failed += 1;
                continue;
            }
        };
        if !is_file {
            continue;
        }
        let Some(pid) = parse_outproc_shm_name(&entry.file_name()) else {
            continue;
        };
        summary.scanned += 1;

        let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(_) => {
                summary.failed += 1;
                continue;
            }
        };
        let old_enough = now.duration_since(modified).is_ok_and(|age| age >= min_age);
        if !old_enough {
            summary.kept_young += 1;
            continue;
        }

        let disposition = if pid == self_pid {
            PidLiveness::Dead
        } else {
            *liveness_by_pid.entry(pid).or_insert_with(|| liveness(pid))
        };
        match disposition {
            PidLiveness::Dead => match fs::remove_file(entry.path()) {
                Ok(()) => summary.removed += 1,
                Err(_) => summary.failed += 1,
            },
            PidLiveness::Alive => summary.kept_alive += 1,
            PidLiveness::Unknown => summary.kept_unknown += 1,
        }
    }

    summary
}

pub fn sweep_orphaned_outproc_shm() -> SweepSummary {
    let started = Instant::now();
    let dir = std::env::temp_dir();
    let summary = sweep_dir(
        &dir,
        std::process::id(),
        SystemTime::now(),
        MIN_ORPHAN_AGE,
        &probe_pid_liveness,
    );
    if let Some(error) = &summary.dir_error {
        tracing::warn!(
            "[outproc-shm-sweep] could not read dir={}: {}",
            dir.display(),
            error
        );
    }
    tracing::info!(
        "[outproc-shm-sweep] dir={} scanned={} removed={} kept_alive={} kept_unknown={} kept_young={} failed={} elapsed_ms={}",
        dir.display(),
        summary.scanned,
        summary.removed,
        summary.kept_alive,
        summary.kept_unknown,
        summary.kept_young,
        summary.failed,
        started.elapsed().as_millis()
    );
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::UNIX_EPOCH;

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TestDir(std::path::PathBuf);

    impl TestDir {
        fn new() -> Self {
            let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "orbit-outproc-sweep-test-{}-{seq}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create dedicated sweep test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn file(&self, name: &str, modified: SystemTime) {
            File::create(self.0.join(name))
                .expect("create sweep fixture")
                .set_modified(modified)
                .expect("set sweep fixture mtime");
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_only_valid_outproc_shm_names() {
        for (name, expected) in [
            ("orbit-outproc-effect-123-4.shm", Some(123)),
            ("orbit-outproc-effect-123-4.shm.chain.json", Some(123)),
            ("orbit-outproc-effect-123-4.shm.apply.json", Some(123)),
            ("orbit-outproc-effect-123-4.shm.respawn-args", Some(123)),
            ("orbit-outproc-instrument-1-0.shm", Some(1)),
            ("orbit-outproc-effect-x-4.shm", None),
            ("orbit-outproc-effect-0-4.shm", None),
            ("orbit-outproc-effect-123.shm", None),
            ("orbit-outproc-effect-123-4.tmp", None),
            ("orbit-catalog-abc", None),
            ("orbit-outproc-", None),
        ] {
            assert_eq!(parse_outproc_shm_name(OsStr::new(name)), expected, "{name}");
        }
    }

    #[test]
    fn generated_names_round_trip_to_the_current_pid() {
        #[cfg(feature = "outproc-effect")]
        assert_eq!(
            parse_outproc_shm_name(
                crate::outproc_effect::unique_shm_path()
                    .file_name()
                    .unwrap()
            ),
            Some(std::process::id())
        );
        #[cfg(feature = "outproc-instrument")]
        assert_eq!(
            parse_outproc_shm_name(
                crate::outproc_instrument::unique_shm_path()
                    .file_name()
                    .unwrap()
            ),
            Some(std::process::id())
        );
    }

    #[test]
    fn sweeps_only_old_dead_and_self_pid_files() {
        const DEAD_PID: u32 = 100_001;
        const ALIVE_PID: u32 = 100_002;
        const UNKNOWN_PID: u32 = 100_003;
        const SELF_PID: u32 = 100_004;
        let dir = TestDir::new();
        let now = UNIX_EPOCH + Duration::from_secs(1_000_000);
        let old = now - Duration::from_secs(10);

        let removed = [
            format!("orbit-outproc-effect-{DEAD_PID}-0.shm"),
            format!("orbit-outproc-effect-{DEAD_PID}-1.shm.chain.json"),
            format!("orbit-outproc-effect-{DEAD_PID}-2.shm.apply.json"),
            format!("orbit-outproc-instrument-{SELF_PID}-0.shm"),
            format!("orbit-outproc-effect-{DEAD_PID}-4.shm.respawn-args"),
        ];
        let kept = [
            format!("orbit-outproc-effect-{DEAD_PID}-3.shm.chain.json"),
            format!("orbit-outproc-effect-{ALIVE_PID}-0.shm"),
            format!("orbit-outproc-effect-{UNKNOWN_PID}-0.shm"),
        ];
        for name in &removed {
            dir.file(name, old);
        }
        dir.file(&kept[0], now);
        dir.file(&kept[1], old);
        dir.file(&kept[2], old);
        dir.file("orbit-catalog-x", old);
        fs::create_dir(dir.path().join("orbit-outproc-effect-A-9.shm"))
            .expect("create non-file fixture");

        let summary = sweep_dir(
            dir.path(),
            SELF_PID,
            now,
            MIN_ORPHAN_AGE,
            &|pid| match pid {
                DEAD_PID => PidLiveness::Dead,
                ALIVE_PID => PidLiveness::Alive,
                UNKNOWN_PID => PidLiveness::Unknown,
                SELF_PID => PidLiveness::Alive,
                _ => panic!("unexpected PID {pid}"),
            },
        );

        assert_eq!(
            summary,
            SweepSummary {
                scanned: 8,
                removed: 5,
                kept_alive: 1,
                kept_unknown: 1,
                kept_young: 1,
                failed: 0,
                dir_error: None,
            }
        );
        for name in removed {
            assert!(
                !dir.path().join(name).exists(),
                "old orphan must be removed"
            );
        }
        for name in kept {
            assert!(dir.path().join(name).exists(), "protected file must remain");
        }
        assert!(dir.path().join("orbit-catalog-x").exists());
        assert!(dir.path().join("orbit-outproc-effect-A-9.shm").is_dir());
    }

    #[test]
    fn read_dir_failure_is_reported_without_panicking() {
        let dir = TestDir::new();
        let missing = dir.path().join("missing");
        let summary = sweep_dir(
            &missing,
            std::process::id(),
            SystemTime::now(),
            MIN_ORPHAN_AGE,
            &probe_pid_liveness,
        );
        assert_eq!(summary.removed, 0);
        assert_eq!(summary.failed, 1);
        assert!(summary.dir_error.is_some());
    }

    #[test]
    fn real_current_process_is_alive() {
        assert_eq!(probe_pid_liveness(std::process::id()), PidLiveness::Alive);
    }

    #[test]
    fn real_reaped_child_is_dead() {
        let mut child = Command::new("true").spawn().expect("spawn true child");
        let pid = child.id();
        child.wait().expect("reap true child");
        assert_eq!(probe_pid_liveness(pid), PidLiveness::Dead);
    }
}
