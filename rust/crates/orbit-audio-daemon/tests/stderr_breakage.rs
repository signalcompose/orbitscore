//! #605: **診断チャネル（stderr）の故障で daemon を死なせない**ことの回帰テスト。
//!
//! ## 何が起きていたか
//!
//! daemon は `tracing_subscriber` の writer に `std::io::stderr` を直に渡し、panic hook でも
//! `eprintln!` を使っていた。どちらも**書き込み失敗で panic する**。stderr が壊れた状態
//! （= 読み手の消えた pipe）では:
//!
//! 1. tracing の event が書けず panic（`failed printing to stderr`）
//! 2. panic hook 自身も `eprintln!` を呼ぶので**再 panic**
//! 3. `panic_with_hook` の再帰検知が `std::process::abort()` → **SIGABRT**
//!
//! 2026-08-01 に OrbitStudio 起動経路で 11 回再現し、daemon が起動直後に落ちて
//! plugin の attach が「READY を出さないまま timeout」に見えていた。
//!
//! ## このテストが本物である理由
//!
//! `Stdio::piped()` で受けた `ChildStderr` を **drop** すると read 端が閉じ、以後 daemon の
//! stderr 書き込みは EPIPE になる。fd を `close` するだけでは**後続の `open` が fd 2 を
//! 再利用して書き込みが成功してしまい再現しない**（実際に空振りした）。read 端を閉じた
//! pipe が本来の条件である。
//!
//! ## 変異検証（2026-08-01・main が実施）
//!
//! | 変異 | 結果 | daemon の終了状態 |
//! |---|---|---|
//! | A: tracing writer だけ `std::io::stderr` に戻す | **red** | exit=1（hook 修正により abort を免れる） |
//! | B: panic hook だけ `eprintln!` に戻す | 🔴 **green（生存）** | — |
//! | C: 両方戻す（修正前の状態） | **red** | **signal 6 = SIGABRT** |
//!
//! 変異 C が**本番のクラッシュ署名（SIGABRT）をそのまま再現**する。
//!
//! 🔴 **変異 B は生き残る。** writer が直っていると tracing が panic しないため、
//! panic hook に**到達しない**。つまり panic hook 側の修正（`eprintln!` →
//! [`write_line_best_effort`]）は**このテストでは検証できていない**。独立に検証するには
//! 「stderr が壊れた状態で daemon を任意に panic させる」トリガが要るが、production コードに
//! panic 注入口を足す方が害が大きいと判断して**入れていない**。
//!
//! hook 側の修正の価値は変異 A の終了状態に間接的に表れている（`SIGABRT` ではなく `exit=1`
//! になり、client が fatal を wire format で受け取れる）。この非対称を承知の上で残している。

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

/// stderr が壊れた後に daemon が生きていることを確かめるまでの猶予。
/// abort は書き込みの瞬間に起きるので、長く待つ必要はない。
const SURVIVAL_WINDOW: Duration = Duration::from_secs(3);

struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// daemon を起動し ready line から port を取り出す。**stderr の読み端は返さず捨てる**
/// ——それがこのテストの仕掛けそのもの。
///
/// audio device の無い環境では起動自体が失敗しうるので、その場合は loud skip として
/// `None` を返す（CI を赤くしない）。
fn spawn_daemon_with_broken_stderr() -> Option<(Daemon, u16)> {
    let bin = env!("CARGO_BIN_EXE_orbit-audio-daemon");
    let mut child = match Command::new(bin)
        // 書き込み量を増やして「壊れた stderr へ書く」機会を確実に作る。
        .env("RUST_LOG", "trace")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!("skipping: failed to spawn daemon: {error}");
            return None;
        }
    };

    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) | Err(_) => {
            eprintln!("skipping: daemon exited before the ready line (audio device 無し等)");
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        Ok(_) => {}
    }

    let Some(port) = parse_port(&line) else {
        eprintln!("skipping: ready line に port が無い: {line}");
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };

    // 🔴 ここが仕掛け: read 端を閉じる。以後 daemon の stderr 書き込みは EPIPE。
    drop(stderr);

    Some((Daemon(child), port))
}

fn parse_port(ready_line: &str) -> Option<u16> {
    let after = ready_line.split("\"port\":").nth(1)?;
    let digits: String = after
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// 壊れた stderr へ**書かせる**。crash の triggered frame は `session::run` からの
/// `Event::dispatch` だったので、接続を作って session のログ経路を通す。
fn provoke_logging(port: u16) {
    for _ in 0..5 {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            // WebSocket handshake としては不正で構わない。daemon 側が
            // 「接続を受けて捌いて落とす」経路を通り、そこでログが出ることが目的。
            let _ = stream.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
            let _ = stream.flush();
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn daemon_survives_a_broken_stderr() {
    let Some((mut daemon, port)) = spawn_daemon_with_broken_stderr() else {
        return;
    };

    provoke_logging(port);
    thread::sleep(SURVIVAL_WINDOW);

    match daemon.0.try_wait() {
        Ok(None) => { /* 生存 = 期待どおり */ }
        Ok(Some(status)) => panic!(
            "🔴 stderr を壊しただけで daemon が終了した (status: {status:?})。\
             診断チャネルの書き込み失敗がプロセスを殺している。\
             signal 6 (SIGABRT) なら panic hook の再 panic 経路（#605）。\
             `main.rs` の `BestEffortStderr` / `write_line_best_effort` を確認すること"
        ),
        Err(error) => panic!("try_wait failed: {error}"),
    }

    // 生きているだけでなく**まだ仕事ができる**ことまで見る。abort は免れたが
    // 内部状態が壊れて accept を止めている、という状態を通さないため。
    assert!(
        TcpStream::connect(("127.0.0.1", port)).is_ok(),
        "daemon はプロセスとしては生きているが、stderr 破壊後に接続を受け付けなくなった"
    );
}
