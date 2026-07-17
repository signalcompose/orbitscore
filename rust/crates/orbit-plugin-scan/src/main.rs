//! orbit-plugin-scan バイナリエントリポイント（#463 C1）。
//!
//! CLAP/VST3 プラグインをスキャンし `~/.orbitscore/plugin-catalog.json` を生成する。
//! daemon への `ScanPlugins` コマンド配線は C1b（別 PR）— このバイナリは単体で完結する。

use orbit_plugin_scan::{
    cache_path, now_iso8601, resolve_scan_dirs, scan_all, write_catalog, Catalog,
};
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let home = env::var_os("HOME").map(PathBuf::from);
    let orbit_plugin_path = env::var("ORBIT_PLUGIN_PATH").ok();

    let Some(home) = home else {
        eprintln!("[orbit-plugin-scan] ERROR: HOME 環境変数が読めません");
        return ExitCode::FAILURE;
    };

    let dirs = resolve_scan_dirs(Some(&home), orbit_plugin_path.as_deref());
    let outcome = scan_all(&dirs);
    let catalog = Catalog {
        version: 1,
        scanned_at: now_iso8601(),
        plugins: outcome.entries,
    };

    let path = cache_path(&home);
    if let Err(error) = write_catalog(&catalog, &path) {
        eprintln!("[orbit-plugin-scan] ERROR: カタログの書き込みに失敗: {path:?}: {error}");
        return ExitCode::FAILURE;
    }

    let count = catalog.plugins.len();
    let cache_path_json = json_escape(&path.to_string_lossy());
    let skipped_json = outcome
        .skipped
        .iter()
        .map(|path| format!("\"{}\"", json_escape(path)))
        .collect::<Vec<_>>()
        .join(",");
    println!(
        "{{\"count\":{count},\"cachePath\":\"{cache_path_json}\",\"skipped\":[{skipped_json}]}}"
    );

    ExitCode::SUCCESS
}

fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
