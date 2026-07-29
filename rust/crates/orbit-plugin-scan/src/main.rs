//! orbit-plugin-scan バイナリエントリポイント（#463 C1）。
//!
//! CLAP/VST3 プラグインをスキャンし `~/.orbitscore/plugin-catalog.json` を生成する。
//! daemon への `ScanPlugins` コマンド配線は C1b（別 PR）— このバイナリは単体で完結する。

use orbit_plugin_scan::{
    cache_path, now_iso8601, probe_artifact, resolve_scan_dirs, scan_all, scan_all_with_probes,
    write_catalog, ArtifactClass, ArtifactProbeError, Catalog,
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
    let outcome = if explicit_probe {
        let scanner = match env::current_exe() {
            Ok(path) => path,
            Err(error) => {
                eprintln!("[orbit-plugin-scan] ERROR: scanner path を解決できません: {error}");
                return ExitCode::FAILURE;
            }
        };
        scan_all_with_probes(&dirs, &scanner)
    } else {
        scan_all(&dirs)
    };
    let catalog = Catalog {
        version: 2,
        scanned_at: now_iso8601(),
        plugins: outcome.entries,
        artifacts: outcome.artifacts,
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
    let summary_json =
        serde_json::to_string(&outcome.summary).expect("scan summary is serializable");
    println!("{{\"count\":{count},\"cachePath\":\"{cache_path_json}\",\"skipped\":[{skipped_json}],\"summary\":{summary_json}}}");

    ExitCode::SUCCESS
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
    // Serialization of these owned primitive-only protocol structs cannot fail. Keep stdout to
    // exactly one JSON line so the PR-B1 supervisor can parse it without log filtering.
    println!(
        "{}",
        serde_json::to_string(value).expect("artifact probe protocol is serializable")
    );
}

fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
