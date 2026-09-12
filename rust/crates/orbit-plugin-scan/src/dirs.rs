//! スキャン対象ディレクトリの解決とバンドル候補の列挙（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

/// スキャン対象ディレクトリのデフォルト（PC.1）。
/// `~` は `dirs_home` で解決する（HOME 環境変数が読めない場合はスキップ）。
pub(crate) fn default_scan_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        dirs.push(home.join("Library/Audio/Plug-Ins/CLAP"));
        dirs.push(home.join("Library/Audio/Plug-Ins/VST3"));
    }
    dirs.push(PathBuf::from("/Library/Audio/Plug-Ins/CLAP"));
    dirs.push(PathBuf::from("/Library/Audio/Plug-Ins/VST3"));
    dirs
}

/// `ORBIT_PLUGIN_PATH`（`:` 区切り）を追加のスキャンディレクトリとして解釈する。
pub(crate) fn extra_scan_dirs_from_env(value: Option<&str>) -> Vec<PathBuf> {
    match value {
        None => Vec::new(),
        Some(raw) => raw
            .split(':')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect(),
    }
}

/// スキャンする全ディレクトリ（デフォルト + `ORBIT_PLUGIN_PATH`、重複除去）を返す。
pub fn resolve_scan_dirs(home: Option<&Path>, orbit_plugin_path: Option<&str>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut dirs = Vec::new();
    for dir in default_scan_dirs(home)
        .into_iter()
        .chain(extra_scan_dirs_from_env(orbit_plugin_path))
    {
        if seen.insert(dir.clone()) {
            dirs.push(dir);
        }
    }
    dirs
}

/// 1 ディレクトリ直下（非再帰）を走査し、`.clap` / `.vst3` バンドル候補を列挙する。
/// ディレクトリが存在しない・読めない場合は空 Vec を返す（stderr warn のみ）。
pub fn list_bundle_candidates(dir: &Path) -> Vec<(PathBuf, Format)> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            // 存在しないデフォルトパスは珍しくない（プラグイン未インストール環境）ので debug 相当。
            tracing::debug!("[orbit-plugin-scan] ディレクトリを読めません: {dir:?}: {error}");
            return Vec::new();
        }
    };

    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(extension) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        match extension.to_ascii_lowercase().as_str() {
            "clap" => found.push((path, Format::Clap)),
            "vst3" => found.push((path, Format::Vst3)),
            _ => {}
        }
    }
    found
}

/// 全スキャンディレクトリからバンドル候補を集める（非再帰・重複除去済みディレクトリのみ対象）。
pub fn collect_all_bundle_candidates(dirs: &[PathBuf]) -> Vec<(PathBuf, Format)> {
    let mut candidates = dirs
        .iter()
        .flat_map(|dir| list_bundle_candidates(dir))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    candidates
}
