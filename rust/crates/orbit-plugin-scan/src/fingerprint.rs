//! アーティファクトの指紋（mtime / size / 実行ファイル解決）（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

/// Build the artifact freshness key without reading executable contents.
pub fn artifact_fingerprint(path: &Path, format: Format) -> ArtifactFingerprint {
    let canonical_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let resolved = resolve_artifact_executable(&canonical_path);
    let executable_path = &resolved.path;
    let (executable_size, executable_modified_ns) = file_freshness(executable_path);
    let info_plist_path = if canonical_path.is_dir() {
        canonical_path.join("Contents/Info.plist")
    } else {
        PathBuf::new()
    };
    let (info_plist_size, info_plist_modified_ns) = file_freshness(&info_plist_path);
    let executable_relative_path = executable_path
        .strip_prefix(&canonical_path)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .to_string_lossy()
        .into_owned();

    ArtifactFingerprint {
        scanner_schema_version: SCANNER_SCHEMA_VERSION,
        format,
        canonical_bundle_path: canonical_path.to_string_lossy().into_owned(),
        executable_relative_path,
        executable_resolution: resolved.resolution,
        executable_size,
        executable_modified_ns,
        info_plist_size,
        info_plist_modified_ns,
    }
}

pub(crate) fn file_freshness(path: &Path) -> (Option<u64>, Option<String>) {
    let Ok(metadata) = fs::metadata(path) else {
        return (None, None);
    };
    let modified_ns = metadata.modified().ok().map(system_time_ns);
    (Some(metadata.len()), modified_ns)
}

pub(crate) fn system_time_ns(time: SystemTime) -> String {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos().to_string(),
        Err(error) => format!("-{}", error.duration().as_nanos()),
    }
}

pub(crate) struct ResolvedExecutable {
    pub(crate) path: PathBuf,
    pub(crate) resolution: ExecutableResolution,
}

pub(crate) fn resolve_artifact_executable(canonical_path: &Path) -> ResolvedExecutable {
    if canonical_path.is_file() {
        return ResolvedExecutable {
            path: canonical_path.to_path_buf(),
            resolution: ExecutableResolution::DirectFile,
        };
    }

    #[cfg(target_os = "macos")]
    if let Some(path) = macos_bundle_executable(canonical_path) {
        return ResolvedExecutable {
            path,
            resolution: ExecutableResolution::CoreFoundation,
        };
    }

    fallback_bundle_executable(canonical_path)
}
