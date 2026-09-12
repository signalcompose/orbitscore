//! 子プロセスのタイムアウト付き実行とプロセスグループの後始末（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

pub(crate) struct ProcessCapture {
    pub(crate) status: Option<ExitStatus>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) timed_out: bool,
    pub(crate) kill_timed_out: bool,
    pub(crate) duration_ms: u64,
}

pub(crate) fn run_process_with_timeout(
    executable: &Path,
    args: &[std::ffi::OsString],
    timeout: Duration,
) -> io::Result<ProcessCapture> {
    run_process_with_timeout_and_killer(
        executable,
        args,
        timeout,
        PROCESS_KILL_WAIT_TIMEOUT,
        kill_process_group,
    )
}

pub(crate) fn run_process_with_timeout_and_killer<F>(
    executable: &Path,
    args: &[std::ffi::OsString],
    timeout: Duration,
    kill_wait_timeout: Duration,
    kill_group: F,
) -> io::Result<ProcessCapture>
where
    F: Fn(u32) -> io::Result<()>,
{
    let started = Instant::now();
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);

    let mut child = command.spawn()?;
    let pid = child.id();
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout_reader = thread::spawn(move || read_all(stdout));
    let stderr_reader = thread::spawn(move || read_all(stderr));
    let mut timed_out = false;
    let mut kill_timed_out = false;

    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            let kill_result = kill_group(pid);
            let kill_started = Instant::now();
            let status = loop {
                if let Some(status) = child.try_wait()? {
                    break Some(status);
                }
                if kill_started.elapsed() >= kill_wait_timeout {
                    kill_timed_out = true;
                    break None;
                }
                thread::sleep(Duration::from_millis(10));
            };
            if let Err(error) = kill_result {
                // ESRCH is harmless in the narrow try_wait→killpg race: the process or group no
                // longer exists. Do not claim a specific reaping mechanism here.
                if error.raw_os_error() != Some(libc_esrch()) {
                    return Err(error);
                }
            }
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };

    let (stdout, stderr) = if kill_timed_out {
        // The child may still own these pipes. Joining their readers would recreate the same
        // unbounded wait we just escaped; detach the readers and let them finish if the process
        // eventually leaves its uninterruptible state.
        (Vec::new(), Vec::new())
    } else {
        (
            stdout_reader.join().unwrap_or_else(|_| Ok(Vec::new()))?,
            stderr_reader.join().unwrap_or_else(|_| Ok(Vec::new()))?,
        )
    };

    Ok(ProcessCapture {
        status,
        stdout,
        stderr,
        timed_out,
        kill_timed_out,
        duration_ms: elapsed_millis(started),
    })
}

pub(crate) fn timeout_failure(capture: &ProcessCapture, timeout: Duration) -> Option<ProbeFailure> {
    if capture.kill_timed_out {
        return Some(ProbeFailure {
            code: "killTimeout".to_owned(),
            message: format!(
                "artifact probe did not exit within {} seconds after process-group SIGKILL",
                PROCESS_KILL_WAIT_TIMEOUT.as_secs()
            ),
            host_arch: None,
            slices: None,
            exit_code: None,
            signal: None,
        });
    }
    if !capture.timed_out {
        return None;
    }
    let (exit_code, signal) = capture
        .status
        .as_ref()
        .map(|status| (status.code(), status_signal(status)))
        .unwrap_or((None, None));
    Some(ProbeFailure {
        code: "timeout".to_owned(),
        message: format!("artifact probe exceeded {} seconds", timeout.as_secs()),
        host_arch: None,
        slices: None,
        exit_code,
        signal,
    })
}

#[cfg(unix)]
pub(crate) const fn libc_esrch() -> i32 {
    libc::ESRCH
}

#[cfg(not(unix))]
pub(crate) const fn libc_esrch() -> i32 {
    3
}

pub(crate) fn read_all(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(unix)]
pub(crate) fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    // SAFETY: this callback runs after fork and before exec. setpgid is async-signal-safe, touches
    // no Rust-managed memory, and makes the probe child the leader of an isolated process group.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}

#[cfg(not(unix))]
pub(crate) fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
pub(crate) fn kill_process_group(pid: u32) -> io::Result<()> {
    // SAFETY: pid came directly from the child we successfully spawned and made group leader.
    let result = unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
pub(crate) fn kill_process_group(_pid: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-group termination requires Unix",
    ))
}

#[cfg(unix)]
pub(crate) fn status_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
pub(crate) fn status_signal(_status: &ExitStatus) -> Option<i32> {
    None
}

pub(crate) fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}
