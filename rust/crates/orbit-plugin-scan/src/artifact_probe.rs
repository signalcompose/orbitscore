//! 1 アーティファクトの probe（子プロセス側で走る判定本体）（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

/// `probe-artifact` の stdout protocol で返す descriptor。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactClass {
    pub name: String,
    pub cid: String,
    pub category: String,
    pub sub_categories: String,
    pub vendor: String,
    pub version: String,
    pub sdk_version: String,
    pub descriptor_api: String,
}

/// Machine-readable failure reasons for the one-artifact child protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ArtifactProbeError {
    InvalidArguments {
        expected: String,
    },
    UnsupportedPlatform,
    UnsupportedFormat {
        extension: String,
    },
    InvalidBundle {
        path: String,
    },
    BundleLoad {
        message: String,
    },
    UnsupportedArch {
        host_arch: String,
        slices: Vec<String>,
    },
    MissingSymbol {
        symbol: String,
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

impl ArtifactProbeError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidArguments { .. } => "invalidArguments",
            Self::UnsupportedPlatform => "unsupportedPlatform",
            Self::UnsupportedFormat { .. } => "unsupportedFormat",
            Self::InvalidBundle { .. } => "invalidBundle",
            Self::BundleLoad { .. } => "bundleLoad",
            Self::UnsupportedArch { .. } => "unsupportedArch",
            Self::MissingSymbol { .. } => "missingSymbol",
            Self::NullFactory => "nullFactory",
            Self::InvalidClassCount { .. } => "invalidClassCount",
            Self::DescriptorRead { .. } => "descriptorRead",
        }
    }
}

impl std::fmt::Display for ArtifactProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidArguments { expected } => write!(formatter, "expected {expected}"),
            Self::UnsupportedPlatform => write!(formatter, "VST3 probing is unsupported here"),
            Self::UnsupportedFormat { extension } => {
                write!(formatter, "unsupported artifact extension: {extension}")
            }
            Self::InvalidBundle { path } => write!(formatter, "invalid bundle: {path}"),
            Self::BundleLoad { message } => write!(formatter, "{message}"),
            Self::UnsupportedArch { host_arch, slices } => {
                write!(
                    formatter,
                    "host architecture {host_arch} is not present in Mach-O slices [{}]",
                    slices.join(", ")
                )
            }
            Self::MissingSymbol { symbol } => write!(formatter, "missing symbol: {symbol}"),
            Self::NullFactory => write!(formatter, "GetPluginFactory returned null"),
            Self::InvalidClassCount { count } => write!(formatter, "invalid class count: {count}"),
            Self::DescriptorRead { index, .. } => {
                write!(
                    formatter,
                    "failed to read class descriptor at index {index}"
                )
            }
        }
    }
}

impl ArtifactProbeError {
    pub(crate) fn into_probe_failure(
        self,
        exit_code: Option<i32>,
        signal: Option<i32>,
    ) -> ProbeFailure {
        let (host_arch, slices) = match &self {
            Self::UnsupportedArch { host_arch, slices } => {
                (Some(host_arch.clone()), Some(slices.clone()))
            }
            _ => (None, None),
        };
        ProbeFailure {
            code: self.code().to_owned(),
            message: self.to_string(),
            host_arch,
            slices,
            exit_code,
            signal,
        }
    }
}

pub(crate) fn preflight_artifact_architecture(path: &Path) -> Result<(), ArtifactProbeError> {
    let Some(host_arch) = host_macho_arch_name() else {
        return Ok(());
    };
    preflight_artifact_architecture_for_host(path, host_arch)
}

pub(crate) fn preflight_artifact_architecture_for_host(
    path: &Path,
    host_arch: &str,
) -> Result<(), ArtifactProbeError> {
    let executable = resolve_artifact_executable(path);
    let slices = match read_macho_architectures(&executable.path) {
        Ok(slices) => slices,
        Err(error) => {
            eprintln!(
                "[orbit-plugin-scan] WARN: Mach-O architecture を読めません: {:?}: {error}",
                executable.path
            );
            None
        }
    };
    let Some(slices) = slices else {
        return Ok(());
    };
    if slices.iter().any(|slice| slice == host_arch) {
        return Ok(());
    }
    Err(ArtifactProbeError::UnsupportedArch {
        host_arch: host_arch.to_owned(),
        slices,
    })
}

/// Child process 内でだけ呼ばれる native descriptor probe。
pub fn probe_artifact(path: &Path) -> Result<Vec<ArtifactClass>, ArtifactProbeError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    // `run_child_probe` preflights before spawning, but keep this child-side check because the
    // `probe-artifact` CLI can also be invoked directly.
    match extension.as_str() {
        "clap" => {
            preflight_artifact_architecture(path)?;
            probe_clap_artifact(path)
        }
        "vst3" => {
            preflight_artifact_architecture(path)?;
            probe_vst3_artifact(path)
        }
        _ => Err(ArtifactProbeError::UnsupportedFormat { extension }),
    }
}

pub(crate) fn probe_clap_artifact(path: &Path) -> Result<Vec<ArtifactClass>, ArtifactProbeError> {
    let found = orbit_clap_host::list_plugins_in_file(path).map_err(|error| {
        ArtifactProbeError::BundleLoad {
            message: error.to_string(),
        }
    })?;
    Ok(found
        .into_iter()
        .map(|entry| ArtifactClass {
            name: entry.plugin.name.unwrap_or_else(|| entry.plugin.id.clone()),
            cid: entry.plugin.id,
            category: "clap.plugin".to_owned(),
            sub_categories: entry.plugin.features.join("|"),
            vendor: entry.plugin.vendor.unwrap_or_default(),
            version: entry.plugin.version.unwrap_or_default(),
            sdk_version: String::new(),
            descriptor_api: "clap".to_owned(),
        })
        .collect())
}

#[cfg(target_os = "macos")]
pub(crate) fn probe_vst3_artifact(path: &Path) -> Result<Vec<ArtifactClass>, ArtifactProbeError> {
    use orbit_vst3_host::FactoryProbeError;

    orbit_vst3_host::probe_factory_descriptors(path)
        .map(|classes| {
            classes
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
                .collect()
        })
        .map_err(|error| match error {
            FactoryProbeError::InvalidBundle(path) => ArtifactProbeError::InvalidBundle {
                path: path.to_string_lossy().into_owned(),
            },
            FactoryProbeError::BundleLoad(message) => ArtifactProbeError::BundleLoad { message },
            FactoryProbeError::MissingSymbol(symbol) => ArtifactProbeError::MissingSymbol {
                symbol: symbol.to_owned(),
            },
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
        })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn probe_vst3_artifact(_path: &Path) -> Result<Vec<ArtifactClass>, ArtifactProbeError> {
    Err(ArtifactProbeError::UnsupportedPlatform)
}
