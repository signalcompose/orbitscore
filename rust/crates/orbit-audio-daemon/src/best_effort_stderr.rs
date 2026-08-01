//! 🔴 #605 / #612: **診断チャネルの故障で daemon を殺さないための stderr 書き込み。**
//!
//! `println!` / `eprintln!` と `std::io::stderr` を直に `with_writer` へ渡す構成は、
//! **書き込みが失敗した時に panic する**（`eprintln!` は内部で `unwrap` 相当）。
//! stderr が壊れた状態（読み手の消えた pipe・閉じられた fd）でこれが起きると:
//!
//! 1. tracing の event が stderr へ書けず panic
//! 2. panic hook も `eprintln!` を使っていると**再 panic** し、
//!    `panic_with_hook` の再帰検知が `std::process::abort` を呼ぶ → **SIGABRT**
//!
//! 実際に 2026-08-01 の OrbitStudio 起動経路で 14 回再現した（04:03〜05:16 JST・
//! `~/Library/Logs/DiagnosticReports/orbit-audio-daemon-*.ips`）。
//!
//! ## なぜ書き込みエラーを握りつぶすか
//!
//! ここは「自分自身を診断するためのチャネル」であり、その故障が**診断対象のプロセスを殺す**のは
//! 因果が逆立ちしている。ログを 1 行失う代償より、daemon が生きて次の診断を出せることを優先する。
//! 音声処理やプロトコルの失敗を握りつぶしているわけではない（それらは従来どおり loud に落とす）。
//!
//! ## 🔴 なぜ crate 直下（lib）に置くか — #612 レビューの指摘
//!
//! 当初この helper は `main.rs`（binary crate）にあったため、**lib 側の
//! `engine_wrap.rs` から使えなかった**。その結果 `eprintln!` が保護の外に残り、
//! panic hook が `exit(1)` するようになった今、**「非 UTF-8 な env var を警告できなかった」
//! というだけで daemon 全体が終了する**経路になっていた。
//!
//! 保護は「tracing 経路だけ」ではなく「**tracing subscriber 稼働後に走りうる全 stderr 書き込み**」
//! に適用する。起動前（subscriber 初期化より前）の経路は対象外 — そこはまだ hook も無く、
//! 書けなければ素直に落ちるのが正しい。

use std::io::Write;

/// tracing subscriber に渡す writer。書き込み失敗を握りつぶし、呼び出し元（tracing）を
/// 巻き込まない。
pub struct BestEffortStderr;

impl Write for BestEffortStderr {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // `write_all` は Result を返すだけで panic しない。失敗しても
        // 「書けた」ことにして呼び出し元を巻き込まない。
        let _ = std::io::stderr().lock().write_all(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stderr().lock().flush();
        Ok(())
    }
}

/// `tracing_subscriber::fmt().with_writer(..)` に渡すための factory。
pub fn best_effort_stderr() -> BestEffortStderr {
    BestEffortStderr
}

/// stderr へ 1 行書く。**書けなくても panic しない。**
///
/// 🔴 [`BestEffortStderr`] の `Write` 経由にしないのは意図的: こちらは
/// **1 回のロックの下で「本文 + 改行 + flush」をアトミックに行う**。`MakeWriter` 契約上
/// `BestEffortStderr` は呼び出しごとにロックを取り直すので、そちらへ委譲すると
/// panic hook が出す 1 行の途中に他スレッドの tracing 出力が割り込む余地が生まれる
/// （#605 が問題にした「診断出力の破損」を別の形で再現しかねない）。
pub fn write_line_best_effort(line: &str) {
    let mut err = std::io::stderr().lock();
    let _ = err.write_all(line.as_bytes());
    let _ = err.write_all(b"\n");
    let _ = err.flush();
}
