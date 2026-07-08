use std::process::Command;

#[test]
fn child_without_shm_exits_nonzero() {
    let child_exe = env!("CARGO_BIN_EXE_orbit-vst3-effect-child");
    let status = Command::new(child_exe)
        .args(["--plugin", "/nonexistent/x.vst3"])
        .status()
        .expect("child binary を起動");
    assert!(!status.success(), "--shm 欠落時は非ゼロ終了すべき");
}

#[test]
fn child_without_plugin_exits_nonzero() {
    let child_exe = env!("CARGO_BIN_EXE_orbit-vst3-effect-child");
    let status = Command::new(child_exe)
        .args(["--shm", "/nonexistent/orbit-shm"])
        .status()
        .expect("child binary を起動");
    assert!(!status.success(), "--plugin 欠落時は非ゼロ終了すべき");
}

#[test]
fn child_unknown_arg_exits_nonzero() {
    let child_exe = env!("CARGO_BIN_EXE_orbit-vst3-effect-child");
    let status = Command::new(child_exe)
        .args(["--bogus"])
        .status()
        .expect("child binary を起動");
    assert!(!status.success(), "未知の引数は非ゼロ終了すべき");
}

#[test]
fn child_flag_without_value_exits_nonzero() {
    let child_exe = env!("CARGO_BIN_EXE_orbit-vst3-effect-child");
    let status = Command::new(child_exe)
        .args(["--shm"])
        .status()
        .expect("child binary を起動");
    assert!(!status.success(), "値の無いフラグは非ゼロ終了すべき");
}
