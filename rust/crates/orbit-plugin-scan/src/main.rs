//! orbit-plugin-scan バイナリエントリポイント（#463 C1）。
//!
//! CLAP/VST3 プラグインをスキャンし `~/.orbitscore/plugin-catalog.json` を生成する。
//! daemon への `ScanPlugins` コマンド配線は C1b（別 PR）— このバイナリは単体で完結する。

use orbit_plugin_scan::{
    cache_path, now_iso8601, resolve_scan_dirs, scan_all, write_catalog, Catalog,
};
use serde::Serialize;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = env::args_os();
    let _program = args.next();
    if args.next().as_deref() == Some(std::ffi::OsStr::new("probe-artifact")) {
        return run_probe_artifact(args.collect());
    }

    // Preserve the pre-#549 behavior for normal startup (including ignoring unrelated argv):
    // catalog generation remains moduleinfo-only. Factory probing is reachable solely through the
    // explicit `probe-artifact` subcommand.
    run_catalog_scan()
}

fn run_catalog_scan() -> ExitCode {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactProbeSuccess {
    ok: bool,
    classes: Vec<ArtifactClass>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactClass {
    name: String,
    cid: String,
    category: String,
    sub_categories: String,
    vendor: String,
    version: String,
    sdk_version: String,
    descriptor_api: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactProbeFailure {
    ok: bool,
    error: ArtifactProbeError,
}

/// Machine-readable failure reasons for the one-artifact child protocol.
///
/// `kind` is the stable discriminator; `message` is diagnostic context only.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ArtifactProbeError {
    InvalidArguments {
        expected: &'static str,
    },
    #[cfg(not(target_os = "macos"))]
    UnsupportedPlatform,
    InvalidBundle {
        path: String,
    },
    BundleLoad {
        message: String,
    },
    MissingSymbol {
        symbol: &'static str,
    },
    NullFactory,
    InvalidClassCount {
        count: i32,
    },
    DescriptorRead {
        index: i32,
        factory3_result: Option<i32>,
        factory2_result: Option<i32>,
        factory1_result: i32,
    },
}

fn run_probe_artifact(args: Vec<OsString>) -> ExitCode {
    if args.len() != 1 {
        print_json_line(&ArtifactProbeFailure {
            ok: false,
            error: ArtifactProbeError::InvalidArguments {
                expected: "probe-artifact <plugin.vst3>",
            },
        });
        return ExitCode::FAILURE;
    }
    probe_artifact(Path::new(&args[0]))
}

#[cfg(target_os = "macos")]
fn probe_artifact(path: &Path) -> ExitCode {
    use orbit_vst3_host::FactoryProbeError;

    match orbit_vst3_host::probe_factory_descriptors(path) {
        Ok(classes) => {
            let classes = classes
                .into_iter()
                .map(|class| ArtifactClass {
                    name: class.name,
                    cid: class.cid,
                    category: class.category,
                    sub_categories: class.sub_categories,
                    vendor: class.vendor,
                    version: class.version,
                    sdk_version: class.sdk_version,
                    descriptor_api: class.descriptor_api.as_str().to_owned(),
                })
                .collect();
            print_json_line(&ArtifactProbeSuccess { ok: true, classes });
            ExitCode::SUCCESS
        }
        Err(error) => {
            let error = match error {
                FactoryProbeError::InvalidBundle(path) => ArtifactProbeError::InvalidBundle {
                    path: path.to_string_lossy().into_owned(),
                },
                FactoryProbeError::BundleLoad(message) => {
                    ArtifactProbeError::BundleLoad { message }
                }
                FactoryProbeError::MissingSymbol(symbol) => {
                    ArtifactProbeError::MissingSymbol { symbol }
                }
                FactoryProbeError::NullFactory => ArtifactProbeError::NullFactory,
                FactoryProbeError::InvalidClassCount(count) => {
                    ArtifactProbeError::InvalidClassCount { count }
                }
                FactoryProbeError::DescriptorRead {
                    index,
                    factory3_result,
                    factory2_result,
                    factory1_result,
                } => ArtifactProbeError::DescriptorRead {
                    index,
                    factory3_result,
                    factory2_result,
                    factory1_result,
                },
            };
            print_json_line(&ArtifactProbeFailure { ok: false, error });
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn probe_artifact(_path: &Path) -> ExitCode {
    print_json_line(&ArtifactProbeFailure {
        ok: false,
        error: ArtifactProbeError::UnsupportedPlatform,
    });
    ExitCode::FAILURE
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
