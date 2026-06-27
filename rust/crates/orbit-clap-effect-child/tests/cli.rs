//! 非 gated CI テスト: child binary の引数バリデーション。
//!
//! 実 CLAP の load 経路（dylib 必須）や audio device は不要 — parse_args の失敗で CLAP に到達する前に
//! 終了するため、CI（`cargo test`）でそのまま実行できる。実 CLAP の処理 parity は gated な
//! `effect_parity_gated.rs` がカバーする。本テストは「引数不正を silent に成功扱いしない」ことの保証。

use std::process::Command;

/// `--shm` 欠落時は parse_args が Err を返し、プロセスが非ゼロ終了する。
/// （`--plugin` は与えるので、失敗するのは `--shm` 必須チェックであることが明確。）
#[test]
fn child_without_shm_exits_nonzero() {
    let child_exe = env!("CARGO_BIN_EXE_orbit-clap-effect-child");
    let status = Command::new(child_exe)
        .args(["--plugin", "/nonexistent/x.clap"])
        .status()
        .expect("child binary を起動");
    assert!(
        !status.success(),
        "--shm 欠落時は非ゼロ終了すべき（実際: {status:?}）"
    );
}

/// `--plugin` 欠落時も必須チェックで非ゼロ終了する（`--shm` は与えるので失敗は `--plugin` 起因と明確）。
#[test]
fn child_without_plugin_exits_nonzero() {
    let child_exe = env!("CARGO_BIN_EXE_orbit-clap-effect-child");
    let status = Command::new(child_exe)
        .args(["--shm", "/nonexistent/orbit-shm"])
        .status()
        .expect("child binary を起動");
    assert!(
        !status.success(),
        "--plugin 欠落時は非ゼロ終了すべき（実際: {status:?}）"
    );
}

/// 未知の引数は bail で弾かれ非ゼロ終了する（typo を silent に無視しない）。
#[test]
fn child_unknown_arg_exits_nonzero() {
    let child_exe = env!("CARGO_BIN_EXE_orbit-clap-effect-child");
    let status = Command::new(child_exe)
        .args(["--bogus"])
        .status()
        .expect("child binary を起動");
    assert!(
        !status.success(),
        "未知の引数は非ゼロ終了すべき（実際: {status:?}）"
    );
}

/// フラグに値が続かない場合も `context` で非ゼロ終了する（値欠落を silent に無視しない）。
#[test]
fn child_flag_without_value_exits_nonzero() {
    let child_exe = env!("CARGO_BIN_EXE_orbit-clap-effect-child");
    let status = Command::new(child_exe)
        .args(["--shm"])
        .status()
        .expect("child binary を起動");
    assert!(
        !status.success(),
        "値の無いフラグは非ゼロ終了すべき（実際: {status:?}）"
    );
}
