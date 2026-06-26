//! Plugin discovery: .clap バンドルをファイルパスからロードする。
//!
//! orbit-clap-spike の discovery.rs から移植（prefix を [orbit-clap-host] に変更のみ）。
//! S1 は `--file-path` による直接ロードのみ（動的スキャンは対象外）。

// プラグインバンドルのロードには unsafe FFI が必要。
#![allow(unsafe_code)]

use clack_host::entry::{LibraryEntry, PluginEntryError};
use clack_host::prelude::PluginEntry;
use std::ffi::CString;
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
        Some(Self {
            id,
            name: p.name().map(|v| v.to_string_lossy().to_string()),
            version: p.version().map(|v| v.to_string_lossy().to_string()),
        })
    }
}

impl Display for PluginDescriptor {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match (&self.name, &self.version) {
            (None, None) => write!(f, "{}", &self.id),
            (Some(n), None) => write!(f, "{n} ({})", &self.id),
            (None, Some(v)) => write!(f, "{} v{v}", &self.id),
            (Some(n), Some(v)) => write!(f, "{n} ({}) v{v}", &self.id),
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
    #[error("バンドルパスに null バイトが含まれる")]
    NullBundlePath,
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
    let bundle_path = CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| DiscoveryError::NullBundlePath)?;
    // SAFETY: ネイティブライブラリのロードは本質的に unsafe。
    let library = unsafe { LibraryEntry::load_from_path(path) }?;
    Ok(unsafe { PluginEntry::load_from(library, &bundle_path) }?)
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
