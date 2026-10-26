//! 実 daemon バイナリで、親（engine）の死を daemon 自身が知ることを確かめる（#996）。
//!
//! - engine の新しい起動の形（stdin = パイプ + `--exit-on-stdin-eof --parent-pid <pid>`）では、
//!   書き端が閉じる / 親が死ぬと daemon が自分で終わる
//! - 🔴 古い engine の起動の形（stdin = `/dev/null`・引数なし）では終わらない
//!
//! Linux に音声デバイスが無くても daemon が起動するよう、ALSA の既定 PCM を null に向けた
//! `.asoundrc` を置いた一時 HOME で起動する（CI の ubuntu で走らせるため）。macOS は実デバイスを
//! 使う（`smoke.rs` と同じ）。それでも起動できない環境では skip する。

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const DAEMON: &str = env!("CARGO_BIN_EXE_orbit-audio-daemon");
const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// 親の死を検知してから終わるまでの上限。PID の監視周期（250ms）に十分な余裕を持たせる。
const EXIT_TIMEOUT: Duration = Duration::from_secs(5);
/// 「終わらない」ことを確かめる観察時間。PID の監視周期の数倍。
const STAYS_ALIVE_FOR: Duration = Duration::from_millis(1500);

/// daemon の stdin の渡し方。
enum Stdin {
    /// 新しい engine（`stdio[0] = 'pipe'`）。書き端はテストが持つ。
    Pipe,
    /// 古い engine（`stdio[0] = 'ignore'` = `/dev/null`）。
    DevNull,
}

struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr: mpsc::Receiver<String>,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Daemon {
    /// daemon を起動し、ready 行を待つ。音声デバイスが無く起動できない環境では `None`（skip）。
    fn spawn(stdin: Stdin, args: &[&str]) -> Option<Self> {
        let mut command = Command::new(DAEMON);
        command
            .args(args)
            .stdin(match stdin {
                Stdin::Pipe => Stdio::piped(),
                Stdin::DevNull => Stdio::null(),
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        with_null_audio_on_linux(&mut command);
        let mut child = command.spawn().expect("spawn daemon");
        let stdin = child.stdin.take();
        let stderr = drain_stderr(child.stderr.take().expect("stderr"));
        let stdout = child.stdout.take().expect("stdout");
        let mut daemon = Self {
            child,
            stdin,
            stderr,
        };
        match read_ready_line(stdout) {
            Some(line) if line.contains(r#""ready":true"#) => Some(daemon),
            line => skip_only_on_startup_error(&daemon.stderr_text(), line),
        }
    }

    fn exited_within(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.child.try_wait().expect("try_wait").is_some() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn stderr_text(&mut self) -> String {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.stderr.recv_timeout(EXIT_TIMEOUT).unwrap_or_default()
    }
}

fn with_null_audio_on_linux(command: &mut Command) {
    if cfg!(target_os = "linux") {
        let home = std::env::temp_dir().join(format!("orbit-parent-watch-{}", std::process::id()));
        std::fs::create_dir_all(&home).expect("temp HOME");
        std::fs::write(home.join(".asoundrc"), "pcm.!default { type null }\n").expect(".asoundrc");
        command.env("HOME", home);
    }
}

fn drain_stderr(mut stderr: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        let _ = tx.send(text);
    });
    rx
}

/// ready にならなかった daemon を skip してよいのは、daemon 自身が起動失敗（`"ready":false`・
/// 音声デバイスが無い等）を報告した時だけ。何も言わずに終わった daemon は失敗として扱う —
/// 「親の死でない EOF を親の死とみなして起動前に終わる」退行は、まさにその形で現れる。
fn skip_only_on_startup_error<T>(stderr: &str, stdout_line: Option<String>) -> Option<T> {
    assert!(
        stderr.contains(r#""ready":false"#),
        "daemon ended before ready without a startup error (stdout {stdout_line:?}): {stderr}"
    );
    eprintln!("skipping: the daemon cannot start here: {stderr}");
    None
}

/// stdout の最初の JSON 行（ready 行。起動失敗は stderr に出る）を待つ。読み終えた stdout は
/// daemon が書き続けても詰まらないよう、別スレッドで読み捨てる。
fn read_ready_line(stdout: impl Read + Send + 'static) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines();
        for line in lines.by_ref().map_while(Result::ok) {
            if line.starts_with('{') {
                let _ = tx.send(line);
                break;
            }
        }
        lines.for_each(drop);
    });
    rx.recv_timeout(READY_TIMEOUT).ok()
}

/// pid のプロセスがまだ動いているか。孤児の daemon は init / subreaper に引き取られ、刈り取られる
/// までゾンビとして残りうる（`kill(pid, 0)` はゾンビにも成功する）ので、状態まで見る。
fn is_running(pid: u32) -> bool {
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("ps");
    let stat = String::from_utf8_lossy(&output.stdout);
    let stat = stat.trim();
    !stat.is_empty() && !stat.starts_with('Z')
}

fn wait_until_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !is_running(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

fn own_pid() -> String {
    std::process::id().to_string()
}

/// 新しい engine の形: stdin の書き端が閉じたら（= engine の死）daemon は自分で終わる。
#[test]
fn exits_when_stdin_reaches_eof_with_the_flag() {
    let pid = own_pid();
    let Some(mut daemon) =
        Daemon::spawn(Stdin::Pipe, &["--exit-on-stdin-eof", "--parent-pid", &pid])
    else {
        return;
    };
    drop(daemon.stdin.take());
    assert!(
        daemon.exited_within(EXIT_TIMEOUT),
        "daemon must exit after its stdin closes"
    );
    let stderr = daemon.stderr_text();
    assert!(
        stderr.contains("parent process is gone (stdin reached EOF)"),
        "stderr: {stderr}"
    );
}

/// 🔴 opt-in: 引数が無ければ、stdin がパイプで EOF になっても終わらない。
#[test]
fn keeps_running_on_stdin_eof_without_the_flag() {
    let Some(mut daemon) = Daemon::spawn(Stdin::Pipe, &[]) else {
        return;
    };
    drop(daemon.stdin.take());
    assert!(
        !daemon.exited_within(STAYS_ALIVE_FOR),
        "stdin EOF must not stop a daemon whose engine did not ask for it: {}",
        daemon.stderr_text()
    );
}

/// 🔴 古い engine の起動の形（stdin = /dev/null・引数なし）では終わらない。
#[test]
fn old_engine_spawn_shape_keeps_running() {
    let Some(mut daemon) = Daemon::spawn(Stdin::DevNull, &[]) else {
        return;
    };
    assert!(
        !daemon.exited_within(STAYS_ALIVE_FOR),
        "the old engine's spawn shape must keep the daemon running: {}",
        daemon.stderr_text()
    );
}

/// 引数があっても stdin がパイプでなければ（/dev/null・端末）EOF を親の死とみなさない。
#[test]
fn flag_with_dev_null_stdin_keeps_running() {
    let pid = own_pid();
    let Some(mut daemon) = Daemon::spawn(
        Stdin::DevNull,
        &["--exit-on-stdin-eof", "--parent-pid", &pid],
    ) else {
        return;
    };
    assert!(
        !daemon.exited_within(STAYS_ALIVE_FOR),
        "/dev/null's EOF is not the parent's death: {}",
        daemon.stderr_text()
    );
}

/// 補助の機構: stdin の書き端を別のプロセス（ここではテスト）が握ったまま親だけが SIGKILL で
/// 死んでも、`--parent-pid` で daemon は自分で終わる。
#[test]
fn exits_when_the_parent_is_killed_even_if_stdin_stays_open() {
    // 親 = sh。daemon の stdin は sh から受け継いだパイプ（書き端はテストが持つので EOF は来ない）。
    // 非対話の sh は `&` の子の stdin を /dev/null にするので、`<&3` で明示的に渡す。
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(r#"exec 3<&0; "$0" --exit-on-stdin-eof --parent-pid $$ <&3 & echo "daemon_pid=$!"; wait"#)
        .arg(DAEMON)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    with_null_audio_on_linux(&mut command);
    let mut parent = command.spawn().expect("spawn sh");
    let _stdin_writer = parent.stdin.take();
    let stderr = drain_stderr(parent.stderr.take().expect("stderr"));

    let (tx, rx) = mpsc::channel();
    let stdout = parent.stdout.take().expect("stdout");
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    let mut daemon_pid: Option<u32> = None;
    let mut ready = false;
    let deadline = Instant::now() + READY_TIMEOUT;
    while !(ready && daemon_pid.is_some()) && Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) if line.starts_with("daemon_pid=") => {
                daemon_pid = line["daemon_pid=".len()..].parse().ok()
            }
            Ok(line) if line.contains(r#""ready":true"#) => ready = true,
            _ => {}
        }
    }
    let Some(daemon_pid) = daemon_pid else {
        let _ = parent.kill();
        let _ = parent.wait();
        panic!("sh did not report the daemon pid");
    };
    if !ready {
        let _ = parent.kill();
        let _ = parent.wait();
        let _ = Command::new("kill")
            .args(["-9", &daemon_pid.to_string()])
            .status();
        let stderr = stderr.recv_timeout(EXIT_TIMEOUT).unwrap_or_default();
        return skip_only_on_startup_error(&stderr, None).unwrap_or(());
    }

    parent.kill().expect("SIGKILL sh");
    parent.wait().expect("reap sh");
    let gone = wait_until_gone(daemon_pid, EXIT_TIMEOUT);
    if !gone {
        let _ = Command::new("kill")
            .args(["-9", &daemon_pid.to_string()])
            .status();
    }
    assert!(
        gone,
        "daemon {daemon_pid} must exit after its parent is SIGKILLed"
    );
}
