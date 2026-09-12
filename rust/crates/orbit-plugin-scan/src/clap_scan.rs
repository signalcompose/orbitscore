//! CLAP バンドルの走査（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

/// CLAP バンドル 1 つを走査してカタログエントリを作る。
/// ロード失敗時は空 Vec + stderr warn（全体を止めない・PC 仕様の「probe 失敗は skip」）。
pub fn scan_clap_bundle(path: &Path) -> Vec<CatalogEntry> {
    let found = match orbit_clap_host::list_plugins_in_file(path) {
        Ok(found) => found,
        Err(error) => {
            eprintln!("[orbit-plugin-scan] WARN: CLAP バンドルの走査に失敗: {path:?}: {error}");
            return Vec::new();
        }
    };

    clap_entries_from_found(path, found)
}

pub(crate) fn clap_entries_from_found(
    path: &Path,
    found: Vec<orbit_clap_host::FoundPlugin>,
) -> Vec<CatalogEntry> {
    found
        .into_iter()
        .map(|entry| {
            let roles = roles_from_clap_features(&entry.plugin.features);
            CatalogEntry {
                name: entry.plugin.name.unwrap_or_else(|| entry.plugin.id.clone()),
                vendor: entry.plugin.vendor.unwrap_or_default(),
                format: Format::Clap,
                path: path.to_string_lossy().into_owned(),
                plugin_id: entry.plugin.id,
                roles,
            }
        })
        .collect()
}

/// CLAP feature タグから role (instrument/effect) を判定する。
/// 両方一致・どちらも不一致の場合は両方入れる（安全側・PC.1 の role フィルタで絞り込む前提）。
pub(crate) fn roles_from_clap_features(features: &[String]) -> Vec<String> {
    let has_instrument = features.iter().any(|f| f == "instrument");
    let has_effect = features
        .iter()
        .any(|f| f == "audio-effect" || f == "audio_effect");

    match (has_instrument, has_effect) {
        (true, false) => vec![ROLE_INSTRUMENT.to_owned()],
        (false, true) => vec![ROLE_EFFECT.to_owned()],
        _ => vec![ROLE_INSTRUMENT.to_owned(), ROLE_EFFECT.to_owned()],
    }
}
