//! Plugin discovery: .clap バンドルをファイルパスからロードする。
//!
//! orbit-clap-spike の discovery.rs から移植（prefix を [orbit-clap-host] に変更のみ）。
//! S1 は `--file-path` による直接ロードのみ（動的スキャンは対象外）。

// プラグインバンドルのロードには unsafe FFI が必要。
#![allow(unsafe_code)]

use clack_host::entry::PluginEntryError;
use clack_host::prelude::PluginEntry;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// 発見済みのロード可能なプラグイン。
pub struct FoundPlugin {
    /// プラグインディスクリプタ。
    pub plugin: PluginDescriptor,
    /// ロード済みエントリ（バンドル）。
    pub entry: PluginEntry,
    /// ソースパス（表示 / エラーメッセージ用）。
    #[allow(dead_code)]
    pub path: PathBuf,
}

/// 簡略化された（所有権付き）プラグインディスクリプタ。
#[derive(Debug)]
pub struct PluginDescriptor {
    pub id: String,
    pub name: Option<String>,
    pub version: Option<String>,
    /// プラグインベンダー名（#463 plugin catalog 用に追加）。
    pub vendor: Option<String>,
    /// CLAP feature タグ一覧（例: "instrument", "audio-effect"）。#463 plugin catalog の
    /// role 判定（instrument/effect）に使う。非 UTF-8 なタグは黙って skip する。
    pub features: Vec<String>,
}

impl PluginDescriptor {
    pub fn try_from(p: &clack_host::plugin::PluginDescriptor) -> Option<Self> {
        // スキップログを出すことで「プラグインが見つからない」と誤報しない。
        let Some(id_cstr) = p.id() else {
            tracing::warn!("[orbit-clap-host] id のないプラグインをスキップ");
            return None;
        };
        let id = match id_cstr.to_str() {
            Ok(s) => s.to_string(),
            Err(_) => {
                tracing::warn!(
                    "[orbit-clap-host] 非 UTF-8 id のプラグインをスキップ: {:?}",
                    id_cstr.to_bytes()
                );
                return None;
            }
        };
        let features = p
            .features()
            .filter_map(|f| f.to_str().ok().map(str::to_owned))
            .collect();
        Some(Self {
            id,
            name: p.name().map(|v| v.to_string_lossy().to_string()),
            version: p.version().map(|v| v.to_string_lossy().to_string()),
            vendor: p.vendor().map(|v| v.to_string_lossy().to_string()),
            features,
        })
    }
}

impl Display for PluginDescriptor {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match (&self.name, &self.version) {
            (None, None) => write!(f, "{}", self.id),
            (Some(n), None) => write!(f, "{n} ({})", self.id),
            (None, Some(v)) => write!(f, "{} v{v}", self.id),
            (Some(n), Some(v)) => write!(f, "{n} ({}) v{v}", self.id),
        }
    }
}

/// Discovery 中のエラー。
#[derive(Debug, Error)]
pub enum DiscoveryError {
    #[error("プラグインファイルのロードに失敗: {0}")]
    LoadError(PluginEntryError),
    #[error("ファイルにプラグインファクトリがない")]
    MissingPluginFactory,
}

impl From<PluginEntryError> for DiscoveryError {
    fn from(e: PluginEntryError) -> Self {
        Self::LoadError(e)
    }
}

/// .clap バンドルエントリをロードする（下記2つの lookup が共有する unsafe FFI）。
/// `PluginFactory` は `PluginEntry` を借用するため、エントリの方を返す（factory は caller
/// のスタックフレームで使う）。
fn open_bundle(path: &Path) -> Result<PluginEntry, DiscoveryError> {
    // clack-host が macOS の NSBundle / CFBundleExecutable 解決と、CLAP entry init に
    // 渡す元の .clap バンドルパスの保持を一括して行う。flat-file にも対応する。
    // SAFETY: ネイティブライブラリのロードは本質的に unsafe。
    Ok(unsafe { PluginEntry::load(path) }?)
}

/// `path` の .clap バンドルに含まれる全プラグインをロードする。
pub fn list_plugins_in_file(path: &Path) -> Result<Vec<FoundPlugin>, DiscoveryError> {
    let entry = open_bundle(path)?;
    let factory = entry
        .get_plugin_factory()
        .ok_or(DiscoveryError::MissingPluginFactory)?;

    Ok(factory
        .plugin_descriptors()
        .filter_map(PluginDescriptor::try_from)
        .map(|plugin| FoundPlugin {
            entry: entry.clone(),
            path: path.to_path_buf(),
            plugin,
        })
        .collect())
}

/// .clap バンドルから指定 ID のプラグインをロードする。
pub fn load_plugin_id_from_path(
    path: &Path,
    id: &str,
) -> Result<Option<FoundPlugin>, DiscoveryError> {
    let entry = open_bundle(path)?;
    let factory = entry
        .get_plugin_factory()
        .ok_or(DiscoveryError::MissingPluginFactory)?;

    Ok(factory
        .plugin_descriptors()
        .filter_map(PluginDescriptor::try_from)
        .find(|p| p.id == id)
        .map(|plugin| FoundPlugin {
            entry,
            path: path.to_path_buf(),
            plugin,
        }))
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "orbit-clap-discovery-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create temporary test directory");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn make_bundle(executable_name: &str) -> (TempDir, PathBuf) {
        let temp = TempDir::new();
        let bundle = temp.0.join("TestBundle.clap");
        let executable_dir = bundle.join("Contents/MacOS");
        fs::create_dir_all(&executable_dir).expect("create bundle executable directory");
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>{executable_name}</string>
</dict>
</plist>
"#
        );
        fs::write(bundle.join("Contents/Info.plist"), plist).expect("write bundle Info.plist");
        (temp, bundle)
    }

    /// ビルド済みの test CLAP dylib を探す。無ければ build 手順を示して loud fail する
    /// （サイレント skip は偽 green を招くため禁止 — PR #433 レビュー指摘）。
    fn built_test_plugin() -> PathBuf {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        [
            "rust-spike/clap-test-effect/target/release/libclap_test_effect.dylib",
            "rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib",
            "rust-spike/clap-test-synth/target/release/libclap_test_synth.dylib",
            "rust-spike/clap-test-synth/target/debug/libclap_test_synth.dylib",
        ]
        .into_iter()
        .map(|relative| repo.join(relative))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| {
            panic!(
                "test CLAP dylib が無い — 先に `cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml`\
                 （または clap-test-synth）を実行してください"
            )
        })
    }

    fn copy_test_plugin(destination: &Path) {
        let plugin = built_test_plugin();
        fs::copy(&plugin, destination).expect("copy test plugin");
    }

    fn assert_bundle_loads(executable_name: &str) {
        let (_temp, bundle) = make_bundle(executable_name);
        copy_test_plugin(&bundle.join("Contents/MacOS").join(executable_name));

        let plugins = list_plugins_in_file(&bundle).expect("load plugin from .clap bundle");
        assert!(!plugins.is_empty(), "bundle must expose a plugin");
    }

    #[test]
    #[ignore = "needs a built test CLAP dylib (rust-spike/clap-test-effect or clap-test-synth, local only)"]
    fn loads_stem_named_executable_from_bundle_directory() {
        assert_bundle_loads("TestBundle");
    }

    #[test]
    #[ignore = "needs a built test CLAP dylib (rust-spike/clap-test-effect or clap-test-synth, local only)"]
    fn loads_cf_bundle_executable_with_different_name() {
        assert_bundle_loads("DifferentExecutableName");
    }

    #[test]
    fn bundle_with_missing_executable_is_an_error() {
        let (_temp, bundle) = make_bundle("MissingExecutable");
        assert!(matches!(
            list_plugins_in_file(&bundle),
            Err(DiscoveryError::LoadError(_))
        ));
    }

    #[test]
    #[ignore = "needs a built test CLAP dylib (rust-spike/clap-test-effect or clap-test-synth, local only)"]
    fn loads_flat_file_clap() {
        let temp = TempDir::new();
        let flat_file = temp.0.join("FlatFile.clap");
        copy_test_plugin(&flat_file);

        let plugins = list_plugins_in_file(&flat_file).expect("load flat-file .clap plugin");
        assert!(!plugins.is_empty(), "flat-file must expose a plugin");
    }
}
