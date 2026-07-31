//! #474 P3b-1: real-dylib CLAP GUI endpoint verification.
//!
//! Prebuild both test plugins:
//!   cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml --release
//!   cargo build --manifest-path rust-spike/clap-test-synth/Cargo.toml --release
//! Run:
//!   cd rust
//!   cargo test -p orbit-clap-host --test ui_endpoint_gated -- --ignored --nocapture

#![cfg(target_os = "macos")]

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use orbit_child_ui::{PluginUiEndpoint, UiSize};
use orbit_clap_host::{ClapEffectAudio, ClapEffectProcessor, ClapPluginMain};

const EFFECT_PLUGIN_ID: &str = "com.signalcompose.clap-test-effect";
const SYNTH_PLUGIN_ID: &str = "com.signalcompose.clap-test-synth";
const INITIAL_SIZE: UiSize = UiSize {
    width: 400,
    height: 300,
};

fn dummy_parent() -> *mut c_void {
    std::ptr::dangling_mut::<c_void>()
}

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

fn effect_dylib() -> PathBuf {
    repo_path("rust-spike/clap-test-effect/target/release/libclap_test_effect.dylib")
}

fn synth_dylib() -> PathBuf {
    repo_path("rust-spike/clap-test-synth/target/release/libclap_test_synth.dylib")
}

fn scenario_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct TraceFile {
    path: PathBuf,
}

impl TraceFile {
    fn new() -> Self {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "orbit-clap-gui-trace-{}-{id}.txt",
            std::process::id()
        ));
        std::fs::write(&path, []).expect("create empty CLAP GUI trace");
        std::env::set_var("ORBIT_CLAP_GUI_TRACE", &path);
        std::env::remove_var("ORBIT_CLAP_GUI_FLOATING_ONLY");
        Self { path }
    }

    fn clear(&self) {
        std::fs::write(&self.path, []).expect("clear CLAP GUI trace");
    }

    fn read(&self) -> Vec<String> {
        std::fs::read_to_string(&self.path)
            .expect("read CLAP GUI trace")
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

impl Drop for TraceFile {
    fn drop(&mut self) {
        std::env::remove_var("ORBIT_CLAP_GUI_TRACE");
        std::env::remove_var("ORBIT_CLAP_GUI_FLOATING_ONLY");
        let _ = std::fs::remove_file(&self.path);
    }
}

fn load_effect_endpoint() -> (ClapEffectAudio, ClapPluginMain) {
    let dylib = effect_dylib();
    assert!(
        dylib.exists(),
        "test-effect dylib is missing: {}",
        dylib.display()
    );
    ClapEffectProcessor::load(&dylib, Some(EFFECT_PLUGIN_ID), 48_000, 2, 512, None)
        .expect("load CLAP test effect")
        .0
        .split()
}

#[test]
#[ignore = "needs prebuilt release test-effect dylib (local only)"]
fn open_calls_the_complete_required_clap_sequence_without_set_scale() {
    let _scenario = scenario_lock();
    let trace = TraceFile::new();
    let (audio, mut main) = load_effect_endpoint();

    assert_eq!(main.begin_open(), Ok(INITIAL_SIZE));
    assert!(main.can_resize());
    main.attach(dummy_parent()).expect("attach CLAP test GUI");

    let calls = trace.read();
    assert_eq!(
        calls,
        [
            "is_api_supported",
            "create",
            "can_resize",
            "get_size",
            "set_parent",
            "show",
        ],
        "the complete CLAP open trace must retain its exact order"
    );
    assert!(
        !calls.iter().any(|call| call == "set_scale"),
        "cocoa must never receive set_scale"
    );

    main.release(false);
    drop(audio);
    drop(main);
}

#[test]
#[ignore = "needs prebuilt release test-effect dylib (local only)"]
fn close_distinguishes_host_owned_and_already_destroyed_gui() {
    let _scenario = scenario_lock();
    let trace = TraceFile::new();

    let (audio, mut main) = load_effect_endpoint();
    main.begin_open().expect("open CLAP test GUI");
    main.attach(dummy_parent()).expect("attach CLAP test GUI");
    trace.clear();
    main.release(false);
    assert_eq!(
        trace.read(),
        ["hide", "destroy"],
        "host-owned close must hide before destroy"
    );
    drop(audio);
    drop(main);

    trace.clear();
    let (audio, mut main) = load_effect_endpoint();
    main.begin_open().expect("open CLAP test GUI");
    main.attach(dummy_parent()).expect("attach CLAP test GUI");
    trace.clear();
    main.release(true);
    assert_eq!(
        trace.read(),
        ["destroy"],
        "already-destroyed close must acknowledge with destroy only"
    );
    drop(audio);
    drop(main);
}

#[test]
#[ignore = "needs prebuilt release test-effect dylib (local only)"]
fn floating_only_gui_fails_without_fallback() {
    let _scenario = scenario_lock();
    let trace = TraceFile::new();
    std::env::set_var("ORBIT_CLAP_GUI_FLOATING_ONLY", "1");
    let (audio, mut main) = load_effect_endpoint();

    let detail = main
        .begin_open()
        .expect_err("floating-only GUI must fail loudly");
    assert!(
        detail.contains("embedded cocoa")
            && detail.contains("unsupported")
            && detail.contains("floating fallback"),
        "failure detail must explain the forbidden fallback: {detail}"
    );
    assert_eq!(
        trace.read(),
        ["is_api_supported"],
        "embedded rejection must not retry with floating configuration"
    );

    drop(audio);
    drop(main);
}

#[test]
#[ignore = "needs prebuilt release test-synth dylib (local only)"]
fn plugin_without_gui_extension_fails_loudly_with_detail() {
    let _scenario = scenario_lock();
    let trace = TraceFile::new();
    let dylib = synth_dylib();
    assert!(
        dylib.exists(),
        "test-synth dylib is missing: {}",
        dylib.display()
    );
    let (audio, mut main) =
        ClapEffectProcessor::load(&dylib, Some(SYNTH_PLUGIN_ID), 48_000, 2, 512, None)
            .expect("load CLAP test synth")
            .0
            .split();

    let detail = main
        .begin_open()
        .expect_err("plugin without GUI extension must fail loudly");
    assert!(
        detail.contains("CLAP GUI extension") && detail.contains("no"),
        "failure detail must identify the absent GUI extension: {detail}"
    );
    assert_eq!(
        trace.read(),
        Vec::<String>::new(),
        "plugin without GUI extension must not make GUI calls"
    );

    drop(audio);
    drop(main);
}
