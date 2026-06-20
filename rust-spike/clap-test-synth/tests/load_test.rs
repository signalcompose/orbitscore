//! Minimal load verification for clap-test-synth.
//!
//! Mirrors host/tests/loading.rs from the clack repo: `dlopen` the built dylib,
//! walk the PluginFactory, and assert the plugin ID matches what we declared.
//!
//! Run with:
//!   cargo test --test load_test

use clack_host::entry::PluginEntry;
use clack_host::factory::plugin::PluginFactory;

/// Expected CLAP plugin ID declared in src/lib.rs
const EXPECTED_ID: &[u8] = b"com.signalcompose.clap-test-synth";

#[test]
fn plugin_loads_and_exposes_id() {
    // The cdylib is built to target/debug/libclap_test_synth.dylib.
    // CARGO_MANIFEST_DIR is the crate root (rust-spike/clap-test-synth/).
    let dylib = format!(
        "{}/target/debug/{}clap_test_synth{}",
        env!("CARGO_MANIFEST_DIR"),
        std::env::consts::DLL_PREFIX,
        std::env::consts::DLL_SUFFIX,
    );

    // SAFETY: we built this dylib ourselves; no UB expected unless the plugin itself has bugs.
    let entry = unsafe { PluginEntry::load(&dylib) }
        .unwrap_or_else(|e| panic!("dlopen failed for {dylib}: {e}"));

    let factory = entry
        .get_factory::<PluginFactory>()
        .expect("no PluginFactory in entry");

    let count = factory.plugin_count();
    assert_eq!(count, 1, "expected exactly 1 plugin in factory, got {count}");

    let desc = factory
        .plugin_descriptor(0)
        .expect("plugin_descriptor(0) returned None");

    let id = desc.id().expect("plugin id is null").to_bytes();
    assert_eq!(
        id, EXPECTED_ID,
        "plugin ID mismatch: got {:?}, want {:?}",
        std::str::from_utf8(id),
        std::str::from_utf8(EXPECTED_ID),
    );

    println!("OK: loaded plugin '{}'", desc.name().unwrap_or_default().to_str().unwrap_or("?"));
}
