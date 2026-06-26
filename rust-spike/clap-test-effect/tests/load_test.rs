//! clap-test-effect の最小ロード検証。
//!
//! clack リポジトリの host/tests/loading.rs に倣い、ビルド済み dylib を `dlopen` して
//! PluginFactory を走査し、プラグイン ID が宣言通りであることを assert する。
//!
//! 実行方法:
//!   cargo test --test load_test

use clack_host::entry::PluginEntry;
use clack_host::factory::plugin::PluginFactory;

/// src/lib.rs で宣言した CLAP plugin ID
const EXPECTED_ID: &[u8] = b"com.signalcompose.clap-test-effect";

#[test]
fn plugin_loads_and_exposes_id() {
    // cdylib は target/debug/libclap_test_effect.dylib にビルドされる。
    // CARGO_MANIFEST_DIR は crate ルート（rust-spike/clap-test-effect/）。
    let dylib = format!(
        "{}/target/debug/{}clap_test_effect{}",
        env!("CARGO_MANIFEST_DIR"),
        std::env::consts::DLL_PREFIX,
        std::env::consts::DLL_SUFFIX,
    );

    // SAFETY: 自分でビルドした dylib のため、plugin 自体にバグがなければ UB なし。
    let entry = unsafe { PluginEntry::load(&dylib) }
        .unwrap_or_else(|e| panic!("dlopen failed for {dylib}: {e}"));

    let factory = entry
        .get_factory::<PluginFactory>()
        .expect("エントリに PluginFactory がありません");

    let count = factory.plugin_count();
    assert_eq!(count, 1, "factory 内のプラグイン数が不正: got {count}, want 1");

    let desc = factory
        .plugin_descriptor(0)
        .expect("plugin_descriptor(0) が None を返しました");

    let id = desc.id().expect("plugin id が null です").to_bytes();
    assert_eq!(
        id, EXPECTED_ID,
        "plugin ID 不一致: got {:?}, want {:?}",
        std::str::from_utf8(id),
        std::str::from_utf8(EXPECTED_ID),
    );

    println!(
        "OK: loaded plugin '{}'",
        desc.name().unwrap_or_default().to_str().unwrap_or("?")
    );
}
