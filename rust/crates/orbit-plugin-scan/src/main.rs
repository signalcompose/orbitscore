//! orbit-plugin-scan バイナリエントリポイント（#463 C1）。
//!
//! CLAP/VST3 プラグインをスキャンし `~/.orbitscore/plugin-catalog.json` を生成する。
//! daemon への `ScanPlugins` コマンド配線は C1b（別 PR）— このバイナリは単体で完結する。

use orbit_plugin_scan::{
    cache_path, now_iso8601, probe_artifact, read_catalog, resolve_scan_dirs, scan_all_with_cache,
    scan_all_with_probes_and_cache, write_catalog, ArtifactClass, ArtifactProbeError, Catalog,
    ScanFailure, ScanSummary,
};
use serde::Serialize;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = env::args_os();
    let _program = args.next();
    let first = args.next();
    if first.as_deref() == Some(std::ffi::OsStr::new("probe-artifact")) {
        return run_probe_artifact(args.collect());
    }

    // Native loading is opt-in. Unrelated/legacy argv remains ignored so unattended startup
    // cannot accidentally regress #463.
    let explicit_probe = first.as_deref() == Some(std::ffi::OsStr::new("--probe-artifacts"))
        || args.any(|arg| arg == std::ffi::OsStr::new("--probe-artifacts"));
    run_catalog_scan(explicit_probe)
}

fn run_catalog_scan(explicit_probe: bool) -> ExitCode {
    let home = env::var_os("HOME").map(PathBuf::from);
    let orbit_plugin_path = env::var("ORBIT_PLUGIN_PATH").ok();

    let Some(home) = home else {
        eprintln!("[orbit-plugin-scan] ERROR: HOME 環境変数が読めません");
        return ExitCode::FAILURE;
    };

    let dirs = resolve_scan_dirs(Some(&home), orbit_plugin_path.as_deref());
    let path = cache_path(&home);
    let previous = match read_catalog(&path) {
        Ok(catalog) => catalog,
        Err(error) => {
            eprintln!(
                "[orbit-plugin-scan] WARN: 既存カタログを cache として読めません: {path:?}: {error}"
            );
            None
        }
    };
    let outcome = if explicit_probe {
        let scanner = match env::current_exe() {
            Ok(path) => path,
            Err(error) => {
                eprintln!("[orbit-plugin-scan] ERROR: scanner path を解決できません: {error}");
                return ExitCode::FAILURE;
            }
        };
        scan_all_with_probes_and_cache(&dirs, &scanner, previous.as_ref())
    } else {
        scan_all_with_cache(&dirs, previous.as_ref())
    };
    let catalog = Catalog {
        version: 2,
        scanned_at: now_iso8601(),
        plugins: outcome.entries,
        artifacts: outcome.artifacts,
    };

    if let Err(error) = write_catalog(&catalog, &path) {
        eprintln!("[orbit-plugin-scan] ERROR: カタログの書き込みに失敗: {path:?}: {error}");
        return ExitCode::FAILURE;
    }

    print_json_line(&CatalogScanOutput {
        count: catalog.plugins.len(),
        artifact_count: catalog.artifacts.len(),
        cache_path: path.to_string_lossy().into_owned(),
        skipped: outcome.skipped,
        failures: outcome.failures,
        summary: outcome.summary,
    });

    ExitCode::SUCCESS
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogScanOutput {
    count: usize,
    artifact_count: usize,
    cache_path: String,
    skipped: Vec<String>,
    failures: Vec<ScanFailure>,
    summary: ScanSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactProbeSuccess {
    ok: bool,
    classes: Vec<ArtifactClass>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactProbeFailure {
    ok: bool,
    error: ArtifactProbeError,
}

fn run_probe_artifact(args: Vec<OsString>) -> ExitCode {
    if args.len() != 1 {
        print_json_line(&ArtifactProbeFailure {
            ok: false,
            error: ArtifactProbeError::InvalidArguments {
                expected: "probe-artifact <plugin.vst3|plugin.clap>".to_owned(),
            },
        });
        return ExitCode::FAILURE;
    }
    match probe_artifact(Path::new(&args[0])) {
        Ok(classes) => {
            print_json_line(&ArtifactProbeSuccess { ok: true, classes });
            ExitCode::SUCCESS
        }
        Err(error) => {
            print_json_line(&ArtifactProbeFailure { ok: false, error });
            ExitCode::FAILURE
        }
    }
}

fn print_json_line(value: &impl Serialize) {
    // Keep stdout to exactly one JSON line so supervisors can parse it without log filtering.
    println!(
        "{}",
        serde_json::to_string(value).expect("scanner output is serializable")
    );
}
