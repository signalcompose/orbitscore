//! probe 子プロセスの起動と stdout protocol の解釈（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

#[derive(Debug)]
pub(crate) struct ProbeSuccess {
    pub(crate) source: String,
    pub(crate) plugins: Vec<CatalogEntry>,
    pub(crate) descriptor_apis: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct ProbeExecution {
    pub(crate) duration_ms: u64,
    pub(crate) result: Result<ProbeSuccess, ProbeFailure>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChildProbeOutput {
    pub(crate) ok: bool,
    #[serde(default)]
    pub(crate) classes: Vec<ArtifactClass>,
    pub(crate) error: Option<ArtifactProbeError>,
}

pub(crate) fn run_child_probe(
    scanner_executable: &Path,
    path: &Path,
    format: Format,
) -> ProbeExecution {
    let started = Instant::now();
    // Reject unsupported binaries without spawning; `probe_artifact` repeats this check as a
    // safety net for direct `probe-artifact` CLI invocations.
    if let Err(error) = preflight_artifact_architecture(path) {
        return ProbeExecution {
            duration_ms: elapsed_millis(started),
            result: Err(error.into_probe_failure(None, None)),
        };
    }
    let capture = match run_process_with_timeout(
        scanner_executable,
        &["probe-artifact".into(), path.as_os_str().to_owned()],
        ARTIFACT_PROBE_TIMEOUT,
    ) {
        Ok(capture) => capture,
        Err(error) => {
            return ProbeExecution {
                duration_ms: elapsed_millis(started),
                result: Err(ProbeFailure {
                    code: "spawnError".to_owned(),
                    message: error.to_string(),
                    host_arch: None,
                    slices: None,
                    exit_code: None,
                    signal: None,
                }),
            };
        }
    };

    if let Some(failure) = timeout_failure(&capture, ARTIFACT_PROBE_TIMEOUT) {
        return ProbeExecution {
            duration_ms: capture.duration_ms,
            result: Err(failure),
        };
    }

    let status = capture
        .status
        .expect("a completed process capture always has an exit status");
    let parsed = parse_child_probe_output(&capture.stdout);
    match parsed {
        Ok(output) if output.ok && status.success() => {
            let descriptor_apis = output
                .classes
                .iter()
                .filter(|class| is_catalog_class(format, class))
                .map(|class| class.descriptor_api.clone())
                .collect();
            let plugins = classes_to_catalog_entries(path, format, output.classes);
            ProbeExecution {
                duration_ms: capture.duration_ms,
                result: Ok(ProbeSuccess {
                    source: match format {
                        Format::Clap => "clapDescriptor",
                        Format::Vst3 => "factory",
                    }
                    .to_owned(),
                    plugins,
                    descriptor_apis,
                }),
            }
        }
        Ok(output) if !output.ok => {
            let error = output.error.unwrap_or(ArtifactProbeError::BundleLoad {
                message: "child returned ok=false without an error".to_owned(),
            });
            ProbeExecution {
                duration_ms: capture.duration_ms,
                result: Err(error.into_probe_failure(status.code(), status_signal(&status))),
            }
        }
        Ok(_) => ProbeExecution {
            duration_ms: capture.duration_ms,
            result: Err(ProbeFailure {
                code: "protocolError".to_owned(),
                message: format!(
                    "child returned success JSON with failing status {}; stderr={}",
                    status,
                    diagnostic_tail(&capture.stderr)
                ),
                host_arch: None,
                slices: None,
                exit_code: status.code(),
                signal: status_signal(&status),
            }),
        },
        Err(error) => {
            let signal = status_signal(&status);
            ProbeExecution {
                duration_ms: capture.duration_ms,
                result: Err(ProbeFailure {
                    code: if signal.is_some() {
                        "crash".to_owned()
                    } else {
                        "protocolError".to_owned()
                    },
                    message: format!(
                        "child produced invalid JSON ({error}); stderr={}",
                        diagnostic_tail(&capture.stderr)
                    ),
                    host_arch: None,
                    slices: None,
                    exit_code: status.code(),
                    signal,
                }),
            }
        }
    }
}

pub(crate) fn parse_child_probe_output(
    stdout: &[u8],
) -> Result<ChildProbeOutput, serde_json::Error> {
    // Some third-party modules write diagnostics directly to inherited stdout during bundleEntry.
    // The helper still emits exactly one protocol object of its own; scan from the end so those
    // foreign lines cannot turn a successful descriptor probe into a protocol failure.
    let mut last_error = None;
    for line in stdout.split(|byte| *byte == b'\n').rev() {
        let line = line
            .iter()
            .copied()
            .skip_while(|byte| byte.is_ascii_whitespace())
            .collect::<Vec<_>>();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_slice::<ChildProbeOutput>(&line) {
            Ok(output) => return Ok(output),
            Err(error) => last_error = Some(error),
        }
    }
    match last_error {
        Some(error) => Err(error),
        None => serde_json::from_slice::<ChildProbeOutput>(stdout),
    }
}

pub(crate) fn diagnostic_tail(bytes: &[u8]) -> String {
    const LIMIT: usize = 4096;
    let start = bytes.len().saturating_sub(LIMIT);
    String::from_utf8_lossy(&bytes[start..]).trim().to_owned()
}

pub(crate) fn is_catalog_class(format: Format, class: &ArtifactClass) -> bool {
    format == Format::Clap || class.category == "Audio Module Class"
}

pub(crate) fn classes_to_catalog_entries(
    path: &Path,
    format: Format,
    classes: Vec<ArtifactClass>,
) -> Vec<CatalogEntry> {
    classes
        .into_iter()
        .filter(|class| is_catalog_class(format, class))
        .map(|class| {
            let categories = class
                .sub_categories
                .split('|')
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let roles = match format {
                Format::Clap => roles_from_clap_features(&categories),
                Format::Vst3 => roles_from_vst3_subcategories(&categories),
            };
            CatalogEntry {
                name: class.name,
                vendor: class.vendor,
                format,
                path: path.to_string_lossy().into_owned(),
                plugin_id: class.cid,
                roles,
            }
        })
        .collect()
}
