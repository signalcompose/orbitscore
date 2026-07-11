#[cfg(target_os = "macos")]
use std::env;
#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::process;

#[cfg(target_os = "macos")]
fn main() {
    let Some(path) = env::args().nth(1) else {
        eprintln!("usage: vst3_probe <plugin.vst3>");
        process::exit(2);
    };

    let result = orbit_vst3_host::probe_plugin(Path::new(&path));
    println!("{}", result.to_json_line());
    if !result.loaded || !result.processed {
        process::exit(1);
    }
}

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("vst3_probe is macOS-only (VST3/CoreFoundation)");
    std::process::ExitCode::FAILURE
}
