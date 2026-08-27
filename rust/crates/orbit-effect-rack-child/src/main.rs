#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    orbit_effect_rack_child::macos::run()
}

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("orbit-effect-rack-child is macOS-only (VST3/CoreFoundation and AppKit)");
    std::process::ExitCode::FAILURE
}
