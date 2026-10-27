//! 親（engine）の死を daemon 自身が知る機構（#996・設計 848 §4.4 F-1）。
//!
//! engine が SIGKILL で落ちると、daemon は誰にも止められずに残る（#624 の二重 daemon・
//! 音声デバイスを掴んだままの孤児）。daemon には SIGTERM ハンドラも graceful shutdown も
//! 無い（#448・`main.rs` 冒頭）ので、残った daemon を止められるのは daemon 自身だけである。
//!
//! - **主 = stdin の EOF**（[`EXIT_ON_STDIN_EOF_ARG`]）: engine は stdin をパイプで渡し、自分が
//!   終わるまで閉じない。engine がどう死んでもカーネルが書き端を閉じるので、daemon は EOF を受ける
//! - **補助 = 親 PID**（[`PARENT_PID_ARG`]）: 書き端を別のプロセスが握ったまま（fd の継承）親だけが
//!   死ぬと EOF は来ない。その形を周期的な `getppid()` で拾う（child 側の
//!   `orbit_audio_sandbox::ParentWatch` と同じ判定）
//! `orbit_audio_sandbox::ParentWatch` は構築時の `getppid()` しか記録せず engine 指定の期待 PID（daemon 起動前に死んだ engine の検知）を扱えず、sandbox 自体も daemon では `outproc-*` feature の optional 依存なので使わない。
//!
//! 🔴 **どちらも engine が引数で明示した時だけ働く。** 古い engine は stdin を `'ignore'`
//! （= `/dev/null`）で渡し、引数も付けない。EOF を無条件に親の死とみなすと、古い engine と
//! 組み合わせた daemon は起動した瞬間に終了する。引数があっても stdin がパイプ（FIFO /
//! socket）でなければ EOF は見ない — 端末や `/dev/null` の EOF は親の死を意味しない
//! （設計 848 §4.4 の「stdin がパイプの時だけ」と同じ考え）。

use std::fs::File;
use std::io::{self, ErrorKind, Read};
use std::os::fd::{AsFd, BorrowedFd};
use std::os::unix::fs::FileTypeExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::outproc_shm_sweep::{probe_pid_liveness, PidLiveness};
use tracing::warn;

/// stdin の EOF を親の死とみなす。engine が stdin をパイプで渡した時だけ付ける。
pub const EXIT_ON_STDIN_EOF_ARG: &str = "--exit-on-stdin-eof";
/// 親（engine）の PID。`getppid()` がこの値から変わったら親の死とみなす。
pub const PARENT_PID_ARG: &str = "--parent-pid";
/// 親 PID を確かめる周期。child 側 `ParentWatch` の既定（250ms）に揃えた置き値（未実測）。
pub const PARENT_PID_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// argv から読んだ、engine が有効にした監視。既定（引数なし）はどちらも無効。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ParentWatchOptions {
    pub exit_on_stdin_eof: bool,
    pub parent_pid: Option<libc::pid_t>,
}

impl ParentWatchOptions {
    /// 未知の引数は無視する（`StartupOptions` と同じく、新しい engine の引数で古い daemon が
    /// 落ちない・逆も同じ）。`--parent-pid` の値が欠けている・数でない・1 以下なら PID の監視は
    /// しない — `kill(0 | -1, 0)` は自分のプロセスグループ / 全プロセスを指すので、そこへ落とさない。
    pub fn from_args<I: IntoIterator<Item = String>>(args: I) -> Self {
        let mut options = Self::default();
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            if arg == EXIT_ON_STDIN_EOF_ARG {
                options.exit_on_stdin_eof = true;
            } else if arg == PARENT_PID_ARG {
                let raw = iter.next();
                options.parent_pid = raw
                    .as_deref()
                    .and_then(|value| value.parse::<libc::pid_t>().ok())
                    .filter(|&pid| pid > 1);
                if options.parent_pid.is_none() {
                    warn!(
                        "{PARENT_PID_ARG} {raw:?} is not a usable pid; parent pid watch disabled"
                    );
                }
            }
        }
        options
    }
}

/// 親の死をどの機構で知ったか。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentGone {
    /// stdin の書き端がすべて閉じた。
    StdinEof,
    /// 起動時の親（`expected`）から別のプロセス（init / subreaper）へ付け替えられた。
    Reparented {
        expected: libc::pid_t,
        now: libc::pid_t,
    },
    /// 渡された PID が起動時から親でなかった時の判定: その PID がもう存在しない。
    PidMissing { expected: libc::pid_t },
}

impl std::fmt::Display for ParentGone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StdinEof => write!(f, "stdin reached EOF"),
            Self::Reparented { expected, now } => {
                write!(f, "reparented from pid {expected} to pid {now}")
            }
            Self::PidMissing { expected } => write!(f, "pid {expected} no longer exists"),
        }
    }
}

/// [`start`] が実際に有効にした監視（起動ログ用）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Armed {
    pub stdin_eof: bool,
    pub parent_pid: bool,
}

/// 監視スレッドを起動する。親の死を最初に検知した機構だけが `on_gone` を 1 回呼ぶ。
///
/// tokio の `stdin()` は使わない。中身は blocking pool 上の取り消せない `read` で、
/// runtime の終了をその `read` が返るまで止める（tokio の doc に明記）。専用の OS スレッドで読む。
pub fn start<F>(options: ParentWatchOptions, on_gone: F) -> Armed
where
    F: Fn(ParentGone) + Send + Sync + 'static,
{
    let fired = AtomicBool::new(false);
    let report = Arc::new(move |reason: ParentGone| {
        if !fired.swap(true, Ordering::SeqCst) {
            on_gone(reason);
        }
    });
    let mut armed = Armed::default();

    if options.exit_on_stdin_eof {
        match is_pipe_or_socket(io::stdin().as_fd()) {
            Ok(true) => {
                let report = report.clone();
                armed.stdin_eof = spawn_watcher("orbit-parent-stdin", move || {
                    match read_until_eof(io::stdin().lock()) {
                        Ok(()) => report(ParentGone::StdinEof),
                        // 読めない stdin の終わりは親の死と区別できない。止めずに監視だけやめる。
                        Err(e) => warn!("stdin read failed ({e}); stdin EOF watch stopped"),
                    }
                });
            }
            Ok(false) => warn!(
                "{EXIT_ON_STDIN_EOF_ARG}: stdin is not a pipe; its EOF is not treated as the parent's death"
            ),
            Err(e) => warn!("{EXIT_ON_STDIN_EOF_ARG}: cannot inspect stdin ({e}); watch disabled"),
        }
    }

    if let Some(expected) = options.parent_pid {
        // SAFETY: getppid(2) は引数を取らず常に成功する（POSIX）。
        let direct = unsafe { libc::getppid() } == expected;
        if !direct {
            warn!(
                "{PARENT_PID_ARG} {expected} is not this process's parent; \
                 falling back to checking that the pid still exists"
            );
        }
        let report = report.clone();
        armed.parent_pid = spawn_watcher("orbit-parent-pid", move || loop {
            if let Some(reason) = check_parent(expected, direct) {
                report(reason);
                return;
            }
            std::thread::sleep(PARENT_PID_POLL_INTERVAL);
        });
    }

    armed
}

fn spawn_watcher(name: &str, body: impl FnOnce() + Send + 'static) -> bool {
    match std::thread::Builder::new()
        .name(name.to_string())
        .spawn(body)
    {
        Ok(_) => true,
        Err(e) => {
            warn!("cannot spawn {name} thread ({e}); that parent watch is disabled");
            false
        }
    }
}

/// `reader` を EOF まで読み捨てる。engine は何も書かないが、書かれても捨てる
/// （読まないと書き手がパイプの容量で止まる）。
pub(crate) fn read_until_eof<R: Read>(mut reader: R) -> io::Result<()> {
    let mut buf = [0u8; 256];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(_) => continue,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
}

/// `fd` が FIFO（pipe）か socket か。Node の `stdio: 'pipe'` は Unix では socketpair なので、
/// FIFO だけを見ると engine の stdin を取りこぼす。
pub(crate) fn is_pipe_or_socket(fd: BorrowedFd<'_>) -> io::Result<bool> {
    let file_type = File::from(fd.try_clone_to_owned()?).metadata()?.file_type();
    Ok(file_type.is_fifo() || file_type.is_socket())
}

/// 親の死を 1 回判定する。`direct` = 起動時に `expected` が本当に親だったか。
pub(crate) fn check_parent(expected: libc::pid_t, direct: bool) -> Option<ParentGone> {
    if direct {
        // SAFETY: 同上。親が死ぬと init（launchd / PID 1）か subreaper へ付け替えられ、値が変わる。
        let now = unsafe { libc::getppid() };
        return (now != expected).then_some(ParentGone::Reparented { expected, now });
    }
    // 親でない PID は存在だけを見る（PID の再利用には弱いが、補助の機構の fallback なので許す）。
    // `Dead` は kill(pid, 0) の ESRCH だけ。EPERM などの `Unknown` は従来どおり生存扱い。
    let missing =
        u32::try_from(expected).is_ok_and(|pid| probe_pid_liveness(pid) == PidLiveness::Dead);
    missing.then_some(ParentGone::PidMissing { expected })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    fn parse(args: &[&str]) -> ParentWatchOptions {
        ParentWatchOptions::from_args(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn no_args_arm_nothing() {
        assert_eq!(parse(&[]), ParentWatchOptions::default());
        assert_eq!(
            parse(&["--audio-device", "USB Audio"]),
            ParentWatchOptions::default()
        );
    }

    #[test]
    fn both_flags_are_read_among_other_args() {
        let options = parse(&[
            "--audio-device",
            "USB Audio",
            EXIT_ON_STDIN_EOF_ARG,
            PARENT_PID_ARG,
            "4242",
        ]);
        assert!(options.exit_on_stdin_eof);
        assert_eq!(options.parent_pid, Some(4242));
    }

    #[test]
    fn unusable_parent_pid_disables_only_the_pid_watch() {
        for bad in [
            &[PARENT_PID_ARG][..],
            &[PARENT_PID_ARG, "abc"],
            &[PARENT_PID_ARG, "1"],
        ] {
            assert_eq!(parse(bad).parent_pid, None, "{bad:?}");
        }
        for bad in ["0", "-1"] {
            let options = parse(&[EXIT_ON_STDIN_EOF_ARG, PARENT_PID_ARG, bad]);
            assert_eq!(options.parent_pid, None, "{bad}");
            assert!(options.exit_on_stdin_eof);
        }
    }

    #[test]
    fn pipes_and_sockets_count_as_pipes_but_dev_null_and_files_do_not() {
        let (reader, _writer) = io::pipe().expect("pipe");
        assert!(is_pipe_or_socket(reader.as_fd()).unwrap());
        let (socket, _peer) = UnixStream::pair().expect("socketpair");
        assert!(is_pipe_or_socket(socket.as_fd()).unwrap());
        let dev_null = File::open("/dev/null").expect("/dev/null");
        assert!(!is_pipe_or_socket(dev_null.as_fd()).unwrap());
        let regular =
            File::open(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).expect("a file");
        assert!(!is_pipe_or_socket(regular.as_fd()).unwrap());
    }

    #[test]
    fn read_until_eof_drains_data_and_returns_when_every_writer_closes() {
        let (reader, mut writer) = io::pipe().expect("pipe");
        writer.write_all(b"ignored bytes").unwrap();
        drop(writer);
        read_until_eof(reader).expect("EOF after the writer closes");
    }

    #[test]
    fn direct_parent_is_alive_until_the_ppid_changes() {
        // SAFETY: getppid(2) は常に成功する。
        let ppid = unsafe { libc::getppid() };
        assert_eq!(check_parent(ppid, true), None);
        assert_eq!(
            check_parent(libc::pid_t::MAX, true),
            Some(ParentGone::Reparented {
                expected: libc::pid_t::MAX,
                now: ppid
            })
        );
    }

    #[test]
    fn non_parent_pid_is_gone_only_when_it_no_longer_exists() {
        let own = libc::pid_t::try_from(std::process::id()).unwrap();
        assert_eq!(check_parent(own, false), None);
        // pid_max（Linux 既定 4194304 / macOS 99999）を超える値は存在しえない。
        assert_eq!(
            check_parent(libc::pid_t::MAX, false),
            Some(ParentGone::PidMissing {
                expected: libc::pid_t::MAX
            })
        );
    }
}
