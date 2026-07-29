//! プラグインカタログスキャナのコアロジック（#463 C1）。
//!
//! CLAP/VST3 バンドルを走査して `CatalogEntry` のリストを作り、
//! `~/.orbitscore/plugin-catalog.json` に atomic write する。
//!
//! 正本: docs/core/INSTRUCTION_ORBITSCORE_DSL.md「Plugin Catalog」節 PC.1

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// スキャン対象フォーマット。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Clap,
    Vst3,
}

/// カタログの role タグ（PC.1）。
pub const ROLE_INSTRUMENT: &str = "instrument";
pub const ROLE_EFFECT: &str = "effect";

/// カタログ 1 エントリ（PC.1 JSON スキーマ）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub name: String,
    pub vendor: String,
    pub format: Format,
    pub path: String,
    pub plugin_id: String,
    pub roles: Vec<String>,
}

/// トップレベルのカタログドキュメント（PC.1）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub version: u32,
    pub scanned_at: String,
    pub plugins: Vec<CatalogEntry>,
    #[serde(default)]
    pub artifacts: Vec<CatalogArtifact>,
}

/// Increment when scanner semantics make a cached native descriptor result incompatible.
///
/// This is intentionally independent from catalog version 2: readers can keep consuming the
/// same document shape while a scanner change invalidates every positive and negative cache hit.
pub const SCANNER_SCHEMA_VERSION: u32 = 1;

/// Cheap freshness key for one artifact. It deliberately contains filesystem metadata only:
/// hashing executable contents would reread roughly 16.5 GiB on every explicit rescan on the
/// measured machine, defeating the cache this key enables.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFingerprint {
    pub scanner_schema_version: u32,
    pub format: Format,
    pub canonical_bundle_path: String,
    pub executable_relative_path: String,
    pub executable_size: Option<u64>,
    pub executable_modified_ns: Option<String>,
    pub info_plist_size: Option<u64>,
    pub info_plist_modified_ns: Option<String>,
}

/// catalog v2 の artifact inventory。`plugins` は従来 reader 向けの互換投影であり、
/// probe の状態や診断はこの別配列だけに保持する。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogArtifact {
    pub format: Format,
    pub path: String,
    /// B1 catalogs have no fingerprint. They deserialize as `None`, force one initial B2 probe,
    /// and are rewritten with `Some` so all later scans can use the cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<ArtifactFingerprint>,
    #[serde(flatten)]
    pub state: ArtifactState,
}

/// 静的成功 / probe 待ち / probe 成功 / 理由付き probe 失敗を明示する。
///
/// `moduleinfo.json` が無い artifact は `ProbePending` であり、失敗ではない。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ArtifactState {
    StaticSuccess {
        source: String,
        plugins: Vec<CatalogEntry>,
    },
    ProbePending {
        reason: String,
    },
    ProbeSucceeded {
        source: String,
        duration_ms: u64,
        descriptor_apis: Vec<String>,
        plugins: Vec<CatalogEntry>,
    },
    ProbeFailed {
        duration_ms: u64,
        failure: ProbeFailure,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeFailure {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_arch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slices: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurationSummary {
    pub p50: Option<u64>,
    pub p95: Option<u64>,
    pub max: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub success: usize,
    pub pending: usize,
    pub failure: usize,
    pub failure_reasons: BTreeMap<String, usize>,
    pub duration_ms: DurationSummary,
    pub timeouts: usize,
    pub crashes: usize,
    pub factory_versions: BTreeMap<String, usize>,
    pub cache_hits: usize,
    pub probe_attempts: usize,
}

/// スキャン対象ディレクトリのデフォルト（PC.1）。
/// `~` は `dirs_home` で解決する（HOME 環境変数が読めない場合はスキップ）。
fn default_scan_dirs(home: Option<&Path>) -> Vec<PathBuf> {
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
fn extra_scan_dirs_from_env(value: Option<&str>) -> Vec<PathBuf> {
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
    dirs.iter()
        .flat_map(|dir| list_bundle_candidates(dir))
        .collect()
}

/// Build the artifact freshness key without reading executable contents.
pub fn artifact_fingerprint(path: &Path, format: Format) -> ArtifactFingerprint {
    let canonical_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let executable_path = resolve_artifact_executable(&canonical_path);
    let (executable_size, executable_modified_ns) = file_freshness(&executable_path);
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
        executable_size,
        executable_modified_ns,
        info_plist_size,
        info_plist_modified_ns,
    }
}

fn file_freshness(path: &Path) -> (Option<u64>, Option<String>) {
    let Ok(metadata) = fs::metadata(path) else {
        return (None, None);
    };
    let modified_ns = metadata.modified().ok().map(system_time_ns);
    (Some(metadata.len()), modified_ns)
}

fn system_time_ns(time: SystemTime) -> String {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos().to_string(),
        Err(error) => format!("-{}", error.duration().as_nanos()),
    }
}

fn resolve_artifact_executable(canonical_path: &Path) -> PathBuf {
    if canonical_path.is_file() {
        return canonical_path.to_path_buf();
    }

    #[cfg(target_os = "macos")]
    if let Some(path) = macos_bundle_executable(canonical_path) {
        return path;
    }

    fallback_bundle_executable(canonical_path)
}

const MAX_FAT_ARCHES: usize = 64;
const MAX_MACHO_HEADER_BYTES: u64 = (8 + MAX_FAT_ARCHES * 32) as u64;

#[derive(Clone, Copy)]
enum ByteOrder {
    Big,
    Little,
}

fn read_u32(bytes: &[u8], order: ByteOrder) -> u32 {
    let bytes: [u8; 4] = bytes.try_into().expect("caller supplies four bytes");
    match order {
        ByteOrder::Big => u32::from_be_bytes(bytes),
        ByteOrder::Little => u32::from_le_bytes(bytes),
    }
}

/// Read only the Mach-O header and architecture table; plugin executables can be gigabytes.
fn read_macho_architectures(path: &Path) -> io::Result<Option<Vec<String>>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_MACHO_HEADER_BYTES)
        .read_to_end(&mut bytes)?;
    Ok(parse_macho_architectures(&bytes))
}

fn parse_macho_architectures(bytes: &[u8]) -> Option<Vec<String>> {
    let magic: [u8; 4] = bytes.get(..4)?.try_into().ok()?;
    let (order, fat_record_size) = match magic {
        // Thin 32/64-bit Mach-O headers. The CPU type follows the magic in both layouts.
        [0xfe, 0xed, 0xfa, 0xce] | [0xfe, 0xed, 0xfa, 0xcf] => (ByteOrder::Big, None),
        [0xce, 0xfa, 0xed, 0xfe] | [0xcf, 0xfa, 0xed, 0xfe] => (ByteOrder::Little, None),
        // FAT_MAGIC/FAT_CIGAM and FAT_MAGIC_64/FAT_CIGAM_64.
        [0xca, 0xfe, 0xba, 0xbe] => (ByteOrder::Big, Some(20)),
        [0xbe, 0xba, 0xfe, 0xca] => (ByteOrder::Little, Some(20)),
        [0xca, 0xfe, 0xba, 0xbf] => (ByteOrder::Big, Some(32)),
        [0xbf, 0xba, 0xfe, 0xca] => (ByteOrder::Little, Some(32)),
        _ => return None,
    };

    let second_word = bytes.get(4..8)?;
    let Some(record_size) = fat_record_size else {
        return Some(vec![macho_arch_name(read_u32(second_word, order))]);
    };
    let count = read_u32(second_word, order) as usize;
    if count == 0 || count > MAX_FAT_ARCHES || bytes.len() < 8 + count * record_size {
        return None;
    }

    let mut architectures = Vec::with_capacity(count);
    for record in bytes[8..].chunks_exact(record_size).take(count) {
        let architecture = macho_arch_name(read_u32(&record[..4], order));
        if !architectures.contains(&architecture) {
            architectures.push(architecture);
        }
    }
    Some(architectures)
}

fn macho_arch_name(cpu_type: u32) -> String {
    match cpu_type {
        7 => "x86".to_owned(),
        0x0100_0007 => "x86_64".to_owned(),
        12 => "arm".to_owned(),
        0x0100_000c => "arm64".to_owned(),
        0x0200_000c => "arm64_32".to_owned(),
        18 => "powerpc".to_owned(),
        0x0100_0012 => "powerpc64".to_owned(),
        _ => format!("unknown(0x{cpu_type:08x})"),
    }
}

fn host_macho_arch_name() -> Option<&'static str> {
    match std::env::consts::ARCH {
        "x86" => Some("x86"),
        "x86_64" => Some("x86_64"),
        "arm" => Some("arm"),
        "aarch64" => Some("arm64"),
        "powerpc" => Some("powerpc"),
        "powerpc64" => Some("powerpc64"),
        _ => None,
    }
}

fn fallback_bundle_executable(bundle_path: &Path) -> PathBuf {
    let executable_dir = bundle_path.join("Contents/MacOS");
    if let Some(name) = xml_bundle_executable_name(&bundle_path.join("Contents/Info.plist")) {
        return executable_dir.join(name);
    }

    let bundle_stem = bundle_path.file_stem().unwrap_or_default();
    let conventional = executable_dir.join(bundle_stem);
    if conventional.is_file() {
        return conventional;
    }

    let mut files = fs::read_dir(&executable_dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    files.sort();
    files.into_iter().next().unwrap_or(conventional)
}

/// XML plists are common and this keeps non-macOS tests/builds independent of CoreFoundation.
/// Binary plists on macOS are resolved by `CFBundleCopyExecutableURL` before this fallback.
fn xml_bundle_executable_name(info_plist: &Path) -> Option<String> {
    let text = fs::read_to_string(info_plist).ok()?;
    let key_offset = text.find("<key>CFBundleExecutable</key>")?;
    let remainder = &text[key_offset + "<key>CFBundleExecutable</key>".len()..];
    let value_start = remainder.find("<string>")? + "<string>".len();
    let value_end = remainder[value_start..].find("</string>")? + value_start;
    let value = remainder[value_start..value_end].trim();
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(target_os = "macos")]
fn macos_bundle_executable(bundle_path: &Path) -> Option<PathBuf> {
    use core_foundation_sys::base::{kCFAllocatorDefault, CFRelease, CFTypeRef};
    use core_foundation_sys::bundle::{CFBundleCopyExecutableURL, CFBundleCreate};
    use core_foundation_sys::string::{kCFStringEncodingUTF8, CFStringCreateWithCString};
    use core_foundation_sys::url::{
        kCFURLPOSIXPathStyle, CFURLCreateWithFileSystemPath, CFURLGetFileSystemRepresentation,
    };
    use std::ffi::CString;
    use std::os::unix::ffi::OsStringExt;

    struct OwnedCf(CFTypeRef);
    impl Drop for OwnedCf {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: every stored reference is returned at +1 by a CoreFoundation Create or
                // Copy function and is released exactly once by this guard.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    let path = CString::new(bundle_path.as_os_str().as_encoded_bytes()).ok()?;
    // SAFETY: all CoreFoundation pointers are checked before use and owned Create/Copy results
    // are held by `OwnedCf` until this function returns.
    unsafe {
        let cf_path =
            CFStringCreateWithCString(kCFAllocatorDefault, path.as_ptr(), kCFStringEncodingUTF8);
        if cf_path.is_null() {
            return None;
        }
        let _cf_path_guard = OwnedCf(cf_path.cast());
        let bundle_url =
            CFURLCreateWithFileSystemPath(kCFAllocatorDefault, cf_path, kCFURLPOSIXPathStyle, 1);
        if bundle_url.is_null() {
            return None;
        }
        let _bundle_url_guard = OwnedCf(bundle_url.cast());
        let bundle = CFBundleCreate(kCFAllocatorDefault, bundle_url);
        if bundle.is_null() {
            return None;
        }
        let _bundle_guard = OwnedCf(bundle.cast());
        let executable_url = CFBundleCopyExecutableURL(bundle);
        if executable_url.is_null() {
            return None;
        }
        let _executable_url_guard = OwnedCf(executable_url.cast());

        // macOS PATH_MAX is 1024; leave ample room without depending on a libc constant.
        let mut bytes = vec![0_u8; 16 * 1024];
        if CFURLGetFileSystemRepresentation(
            executable_url,
            1,
            bytes.as_mut_ptr(),
            bytes.len() as isize,
        ) == 0
        {
            return None;
        }
        let length = bytes.iter().position(|byte| *byte == 0)?;
        bytes.truncate(length);
        Some(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
    }
}

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

fn clap_entries_from_found(
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
fn roles_from_clap_features(features: &[String]) -> Vec<String> {
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
    fn into_probe_failure(self, exit_code: Option<i32>, signal: Option<i32>) -> ProbeFailure {
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

fn preflight_artifact_architecture(path: &Path) -> Result<(), ArtifactProbeError> {
    let Some(host_arch) = host_macho_arch_name() else {
        return Ok(());
    };
    preflight_artifact_architecture_for_host(path, host_arch)
}

fn preflight_artifact_architecture_for_host(
    path: &Path,
    host_arch: &str,
) -> Result<(), ArtifactProbeError> {
    let executable = resolve_artifact_executable(path);
    let Some(slices) = read_macho_architectures(&executable).ok().flatten() else {
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

fn probe_clap_artifact(path: &Path) -> Result<Vec<ArtifactClass>, ArtifactProbeError> {
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
fn probe_vst3_artifact(path: &Path) -> Result<Vec<ArtifactClass>, ArtifactProbeError> {
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
fn probe_vst3_artifact(_path: &Path) -> Result<Vec<ArtifactClass>, ArtifactProbeError> {
    Err(ArtifactProbeError::UnsupportedPlatform)
}

/// VST3 バンドル 1 つを走査してカタログエントリを作る。
///
/// **`Contents/Resources/moduleinfo.json` がある場合のみ**エントリ化する（load 不要）。
/// 無い場合は probe（実ロード）せずに pending にする — コンテンツ依存プラグイン（例: FIN-BOOST）が
/// ロード中にネイティブダイアログ（"Plugin content not found — navigate to .blob"）を出すことが
/// 実機確認され、無人スキャンで UI が出る/ブロックするのは受け入れ不可と判断されたため（owner
/// 実害報告・#463）。native probe は explicit rescan からのみ子プロセスで実行する。
pub fn scan_vst3_bundle(path: &Path) -> VstScanResult {
    let moduleinfo_path = path.join("Contents/Resources/moduleinfo.json");
    if !moduleinfo_path.is_file() {
        return VstScanResult::ProbePending {
            reason: "moduleinfoMissing".to_owned(),
        };
    }

    match fs::read_to_string(&moduleinfo_path) {
        Ok(text) => match parse_moduleinfo(&text, path) {
            Ok(entries) if !entries.is_empty() => VstScanResult::StaticSuccess(entries),
            Ok(_) => {
                eprintln!(
                    "[orbit-plugin-scan] WARN: moduleinfo.json に Audio Module Class が無いため probe 待ち: {moduleinfo_path:?}"
                );
                VstScanResult::ProbePending {
                    reason: "moduleinfoNoAudioClasses".to_owned(),
                }
            }
            Err(error) => {
                eprintln!(
                    "[orbit-plugin-scan] WARN: moduleinfo.json の parse に失敗したため probe 待ち: {moduleinfo_path:?}: {error}"
                );
                VstScanResult::ProbePending {
                    reason: "moduleinfoInvalid".to_owned(),
                }
            }
        },
        Err(error) => {
            eprintln!(
                "[orbit-plugin-scan] WARN: moduleinfo.json を読めないため probe 待ち: {moduleinfo_path:?}: {error}"
            );
            VstScanResult::ProbePending {
                reason: "moduleinfoUnreadable".to_owned(),
            }
        }
    }
}

/// [`scan_vst3_bundle`] の metadata-only 結果。
#[derive(Debug)]
pub enum VstScanResult {
    StaticSuccess(Vec<CatalogEntry>),
    ProbePending { reason: String },
}

/// Steinberg moduleinfo.json（trailing comma を含む非-strict JSON）を parse する。
/// `Category == "Audio Module Class"` のクラスのみカタログエントリ化する（Controller /
/// Compatibility クラスはロード可能な実体を持たないため除外）。
fn parse_moduleinfo(text: &str, bundle_path: &Path) -> Result<Vec<CatalogEntry>, String> {
    let sanitized = strip_trailing_commas(text);
    let doc: ModuleInfoDoc = serde_json::from_str(&sanitized).map_err(|error| error.to_string())?;

    let top_vendor = doc
        .factory_info
        .as_ref()
        .and_then(|f| f.vendor.clone())
        .unwrap_or_default();

    let entries = doc
        .classes
        .into_iter()
        .filter(|class| class.category.as_deref() == Some("Audio Module Class"))
        .filter_map(|class| {
            let cid = class.cid?;
            let name = class.name.unwrap_or_else(|| doc.name.clone());
            let vendor = class.vendor.unwrap_or_else(|| top_vendor.clone());
            let roles = roles_from_vst3_subcategories(&class.sub_categories);
            Some(CatalogEntry {
                name,
                vendor,
                format: Format::Vst3,
                path: bundle_path.to_string_lossy().into_owned(),
                plugin_id: cid,
                roles,
            })
        })
        .collect();
    Ok(entries)
}

/// VST3 moduleinfo.json の `Sub Categories` から role を判定する。
/// Instrument/Synth/Generator を instrument、それ以外（Fx 等）を effect とみなす。
/// どちらのヒントも無ければ安全側で両方入れる。
fn roles_from_vst3_subcategories(sub_categories: &[String]) -> Vec<String> {
    const INSTRUMENT_HINTS: [&str; 3] = ["Instrument", "Synth", "Generator"];
    let has_instrument = sub_categories
        .iter()
        .any(|s| INSTRUMENT_HINTS.contains(&s.as_str()));
    let has_other = sub_categories
        .iter()
        .any(|s| !INSTRUMENT_HINTS.contains(&s.as_str()));

    match (has_instrument, has_other) {
        (true, false) => vec![ROLE_INSTRUMENT.to_owned()],
        (false, true) => vec![ROLE_EFFECT.to_owned()],
        (true, true) => vec![ROLE_INSTRUMENT.to_owned(), ROLE_EFFECT.to_owned()],
        (false, false) => vec![ROLE_INSTRUMENT.to_owned(), ROLE_EFFECT.to_owned()],
    }
}

/// JSON 文字列中の trailing comma（`,` の直後に `}` または `]` が続くもの、空白/改行を挟んでもよい）
/// を取り除く。Steinberg の moduleinfo.json は仕様上 strict JSON ではなくこれを含むため必要。
/// 文字列リテラル内のカンマは変更しない。
fn strip_trailing_commas(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            output.push(ch);
            continue;
        }

        if ch == ',' {
            // 後続の空白/改行を先読みし、その次が `}` か `]` なら、このカンマを落とす。
            let mut lookahead = String::new();
            let mut temp_chars = chars.clone();
            let mut is_trailing = false;
            for next in temp_chars.by_ref() {
                if next.is_whitespace() {
                    lookahead.push(next);
                    continue;
                }
                is_trailing = next == '}' || next == ']';
                break;
            }
            if is_trailing {
                // カンマを出力せず、空白はそのまま消費して進める。
                for _ in 0..lookahead.chars().count() {
                    chars.next();
                }
                continue;
            }
        }

        output.push(ch);
    }

    output
}

#[derive(Debug, serde::Deserialize)]
struct ModuleInfoDoc {
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Factory Info", default)]
    factory_info: Option<FactoryInfo>,
    #[serde(rename = "Classes", default)]
    classes: Vec<ModuleClass>,
}

#[derive(Debug, serde::Deserialize)]
struct FactoryInfo {
    #[serde(rename = "Vendor", default)]
    vendor: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ModuleClass {
    #[serde(rename = "CID", default)]
    cid: Option<String>,
    #[serde(rename = "Category", default)]
    category: Option<String>,
    #[serde(rename = "Name", default)]
    name: Option<String>,
    #[serde(rename = "Vendor", default)]
    vendor: Option<String>,
    #[serde(rename = "Sub Categories", default)]
    sub_categories: Vec<String>,
}

/// dedup キー: (format, path, pluginId)。多バージョン/同名は「スキャン順で後勝ち」（PC.5）。
fn dedup_key(entry: &CatalogEntry) -> (u8, String, String) {
    let format_tag = match entry.format {
        Format::Clap => 0,
        Format::Vst3 => 1,
    };
    (format_tag, entry.path.clone(), entry.plugin_id.clone())
}

/// エントリ列を dedup する（後勝ち: 同キーの後続要素が前の要素を置き換える）。
pub fn dedup_entries(entries: Vec<CatalogEntry>) -> Vec<CatalogEntry> {
    let mut order: Vec<(u8, String, String)> = Vec::new();
    let mut map: std::collections::HashMap<(u8, String, String), CatalogEntry> =
        std::collections::HashMap::new();

    for entry in entries {
        let key = dedup_key(&entry);
        if !map.contains_key(&key) {
            order.push(key.clone());
        }
        map.insert(key, entry);
    }

    order
        .into_iter()
        .map(|key| map.remove(&key).expect("key was just inserted"))
        .collect()
}

const ARTIFACT_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_CONCURRENCY: usize = 4;

/// 全ディレクトリを走査した結果。`entries` は v1 reader 向け互換投影。
pub struct ScanOutcome {
    pub entries: Vec<CatalogEntry>,
    pub artifacts: Vec<CatalogArtifact>,
    pub skipped: Vec<String>,
    pub summary: ScanSummary,
}

/// 通常起動用。filesystem inventory と moduleinfo だけを読み、native code はロードしない。
pub fn scan_all(dirs: &[PathBuf]) -> ScanOutcome {
    scan_all_with_cache(dirs, None)
}

/// 通常起動用。fingerprint が一致する native probe の成功・失敗は既存 catalog から復元する。
pub fn scan_all_with_cache(dirs: &[PathBuf], previous: Option<&Catalog>) -> ScanOutcome {
    scan_candidates(
        collect_all_bundle_candidates(dirs),
        false,
        previous,
        &|_, _| unreachable!("metadata-only scan must never invoke the child probe"),
    )
}

/// ユーザーが明示した rescan 用。pending artifact を 1 artifact / 1 child で probe する。
pub fn scan_all_with_probes(dirs: &[PathBuf], scanner_executable: &Path) -> ScanOutcome {
    scan_all_with_probes_and_cache(dirs, scanner_executable, None)
}

/// ユーザーが明示した rescan 用。fingerprint が一致する positive/negative cache を再利用し、
/// 未知または更新済みの artifact だけを 1 artifact / 1 child で probe する。
pub fn scan_all_with_probes_and_cache(
    dirs: &[PathBuf],
    scanner_executable: &Path,
    previous: Option<&Catalog>,
) -> ScanOutcome {
    scan_candidates(
        collect_all_bundle_candidates(dirs),
        true,
        previous,
        &|path, format| run_child_probe(scanner_executable, path, format),
    )
}

fn refresh_cached_arch_failure(path: &Path, state: ArtifactState) -> ArtifactState {
    if !matches!(state, ArtifactState::ProbeFailed { .. }) {
        return state;
    }
    match preflight_artifact_architecture(path) {
        Err(error) => ArtifactState::ProbeFailed {
            duration_ms: 0,
            failure: error.into_probe_failure(None, None),
        },
        Ok(()) => state,
    }
}

fn scan_candidates<F>(
    candidates: Vec<(PathBuf, Format)>,
    explicit_probe: bool,
    previous: Option<&Catalog>,
    probe_runner: &F,
) -> ScanOutcome
where
    F: Fn(&Path, Format) -> ProbeExecution + Sync,
{
    let mut entries = Vec::new();
    let mut artifacts = Vec::new();
    let mut pending = Vec::new();
    let cached_by_fingerprint = previous
        .into_iter()
        .flat_map(|catalog| &catalog.artifacts)
        .filter_map(|artifact| {
            let fingerprint = artifact.fingerprint.as_ref()?;
            match &artifact.state {
                ArtifactState::ProbeSucceeded { .. } | ArtifactState::ProbeFailed { .. } => {
                    Some((fingerprint.clone(), artifact.state.clone()))
                }
                ArtifactState::StaticSuccess { .. } | ArtifactState::ProbePending { .. } => None,
            }
        })
        .collect::<HashMap<_, _>>();
    let mut cache_hits = 0;

    for (path, format) in candidates {
        let path_string = path.to_string_lossy().into_owned();
        let fingerprint = artifact_fingerprint(&path, format);
        match format {
            Format::Clap => {
                let index = artifacts.len();
                if let Some(state) = cached_by_fingerprint.get(&fingerprint).cloned() {
                    let state = refresh_cached_arch_failure(&path, state);
                    if let ArtifactState::ProbeSucceeded { plugins, .. } = &state {
                        entries.extend(plugins.iter().cloned());
                    }
                    cache_hits += 1;
                    artifacts.push(CatalogArtifact {
                        format,
                        path: path_string,
                        fingerprint: Some(fingerprint),
                        state,
                    });
                } else {
                    artifacts.push(CatalogArtifact {
                        format,
                        path: path_string,
                        fingerprint: Some(fingerprint),
                        state: ArtifactState::ProbePending {
                            reason: "nativeDescriptorNotProbed".to_owned(),
                        },
                    });
                    pending.push((index, path, format));
                }
            }
            Format::Vst3 => match scan_vst3_bundle(&path) {
                VstScanResult::StaticSuccess(found) => {
                    entries.extend(found.iter().cloned());
                    artifacts.push(CatalogArtifact {
                        format,
                        path: path_string,
                        fingerprint: Some(fingerprint),
                        state: ArtifactState::StaticSuccess {
                            source: "moduleinfo".to_owned(),
                            plugins: found,
                        },
                    });
                }
                VstScanResult::ProbePending { reason } => {
                    let index = artifacts.len();
                    if let Some(state) = cached_by_fingerprint.get(&fingerprint).cloned() {
                        let state = refresh_cached_arch_failure(&path, state);
                        if let ArtifactState::ProbeSucceeded { plugins, .. } = &state {
                            entries.extend(plugins.iter().cloned());
                        }
                        cache_hits += 1;
                        artifacts.push(CatalogArtifact {
                            format,
                            path: path_string,
                            fingerprint: Some(fingerprint),
                            state,
                        });
                    } else {
                        artifacts.push(CatalogArtifact {
                            format,
                            path: path_string,
                            fingerprint: Some(fingerprint),
                            state: ArtifactState::ProbePending { reason },
                        });
                        pending.push((index, path, format));
                    }
                }
            },
        }
    }

    let mut probe_attempts = 0;
    if explicit_probe {
        // Four workers implement the agreed temporary policy. Keeping each artifact in its own
        // process preserves crash attribution, while a small fixed pool keeps the 261 × 20s
        // worst-case below the extension's 30-minute parent timeout. Fingerprint cache hits have
        // already been removed from `pending`, including negative-cache quarantine entries.
        let next = std::sync::atomic::AtomicUsize::new(0);
        let collected = std::sync::Mutex::new(Vec::with_capacity(pending.len()));
        thread::scope(|scope| {
            let worker_count = PROBE_CONCURRENCY.min(pending.len());
            for _ in 0..worker_count {
                let next = &next;
                let collected = &collected;
                let pending = &pending;
                scope.spawn(move || loop {
                    let job = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some((artifact_index, path, format)) = pending.get(job) else {
                        break;
                    };
                    let result = probe_runner(path, *format);
                    collected
                        .lock()
                        .expect("probe result mutex poisoned")
                        .push((*artifact_index, result));
                });
            }
        });
        let results = collected.into_inner().expect("probe result mutex poisoned");
        probe_attempts = results.len();

        for (artifact_index, execution) in results {
            match execution.result {
                Ok(probe) => {
                    entries.extend(probe.plugins.iter().cloned());
                    artifacts[artifact_index].state = ArtifactState::ProbeSucceeded {
                        source: probe.source,
                        duration_ms: execution.duration_ms,
                        descriptor_apis: probe.descriptor_apis,
                        plugins: probe.plugins,
                    };
                }
                Err(failure) => {
                    artifacts[artifact_index].state = ArtifactState::ProbeFailed {
                        duration_ms: execution.duration_ms,
                        failure,
                    };
                }
            }
        }
    }

    let skipped = artifacts
        .iter()
        .filter_map(|artifact| match artifact.state {
            ArtifactState::ProbeFailed { .. } => Some(artifact.path.clone()),
            _ => None,
        })
        .collect();
    let summary = summarize_artifacts(&artifacts, cache_hits, probe_attempts);
    ScanOutcome {
        entries: dedup_entries(entries),
        artifacts,
        skipped,
        summary,
    }
}

#[derive(Debug)]
struct ProbeSuccess {
    source: String,
    plugins: Vec<CatalogEntry>,
    descriptor_apis: Vec<String>,
}

#[derive(Debug)]
struct ProbeExecution {
    duration_ms: u64,
    result: Result<ProbeSuccess, ProbeFailure>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildProbeOutput {
    ok: bool,
    #[serde(default)]
    classes: Vec<ArtifactClass>,
    error: Option<ArtifactProbeError>,
}

fn run_child_probe(scanner_executable: &Path, path: &Path, format: Format) -> ProbeExecution {
    let started = Instant::now();
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

    if capture.timed_out {
        return ProbeExecution {
            duration_ms: capture.duration_ms,
            result: Err(ProbeFailure {
                code: "timeout".to_owned(),
                message: format!(
                    "artifact probe exceeded {} seconds",
                    ARTIFACT_PROBE_TIMEOUT.as_secs()
                ),
                host_arch: None,
                slices: None,
                exit_code: capture.status.code(),
                signal: status_signal(&capture.status),
            }),
        };
    }

    let parsed = parse_child_probe_output(&capture.stdout);
    match parsed {
        Ok(output) if output.ok && capture.status.success() => {
            let descriptor_apis = output
                .classes
                .iter()
                .filter(|class| format == Format::Clap || class.category == "Audio Module Class")
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
                result: Err(
                    error.into_probe_failure(capture.status.code(), status_signal(&capture.status))
                ),
            }
        }
        Ok(_) => ProbeExecution {
            duration_ms: capture.duration_ms,
            result: Err(ProbeFailure {
                code: "protocolError".to_owned(),
                message: format!(
                    "child returned success JSON with failing status {}; stderr={}",
                    capture.status,
                    diagnostic_tail(&capture.stderr)
                ),
                host_arch: None,
                slices: None,
                exit_code: capture.status.code(),
                signal: status_signal(&capture.status),
            }),
        },
        Err(error) => {
            let signal = status_signal(&capture.status);
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
                    exit_code: capture.status.code(),
                    signal,
                }),
            }
        }
    }
}

fn parse_child_probe_output(stdout: &[u8]) -> Result<ChildProbeOutput, serde_json::Error> {
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

fn diagnostic_tail(bytes: &[u8]) -> String {
    const LIMIT: usize = 4096;
    let start = bytes.len().saturating_sub(LIMIT);
    String::from_utf8_lossy(&bytes[start..]).trim().to_owned()
}

fn classes_to_catalog_entries(
    path: &Path,
    format: Format,
    classes: Vec<ArtifactClass>,
) -> Vec<CatalogEntry> {
    classes
        .into_iter()
        .filter(|class| format == Format::Clap || class.category == "Audio Module Class")
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

struct ProcessCapture {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
    duration_ms: u64,
}

fn run_process_with_timeout(
    executable: &Path,
    args: &[std::ffi::OsString],
    timeout: Duration,
) -> io::Result<ProcessCapture> {
    let started = Instant::now();
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);

    let mut child = command.spawn()?;
    let pid = child.id();
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout_reader = thread::spawn(move || read_all(stdout));
    let stderr_reader = thread::spawn(move || read_all(stderr));
    let mut timed_out = false;

    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            let kill_result = kill_process_group(pid);
            let status = child.wait()?;
            if let Err(error) = kill_result {
                // A child may exit in the narrow try_wait→killpg race. It is already reaped here,
                // so ESRCH is harmless; other failures still surface after avoiding a leak.
                if error.raw_os_error() != Some(libc_esrch()) {
                    return Err(error);
                }
            }
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };

    Ok(ProcessCapture {
        status,
        stdout: stdout_reader.join().unwrap_or_else(|_| Ok(Vec::new()))?,
        stderr: stderr_reader.join().unwrap_or_else(|_| Ok(Vec::new()))?,
        timed_out,
        duration_ms: elapsed_millis(started),
    })
}

#[cfg(unix)]
const fn libc_esrch() -> i32 {
    libc::ESRCH
}

#[cfg(not(unix))]
const fn libc_esrch() -> i32 {
    3
}

fn read_all(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    // SAFETY: this callback runs after fork and before exec. setpgid is async-signal-safe, touches
    // no Rust-managed memory, and makes the probe child the leader of an isolated process group.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn kill_process_group(pid: u32) -> io::Result<()> {
    // SAFETY: pid came directly from the child we successfully spawned and made group leader.
    let result = unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-group termination requires Unix",
    ))
}

#[cfg(unix)]
fn status_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn status_signal(_status: &ExitStatus) -> Option<i32> {
    None
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn summarize_artifacts(
    artifacts: &[CatalogArtifact],
    cache_hits: usize,
    probe_attempts: usize,
) -> ScanSummary {
    let mut summary = ScanSummary {
        success: 0,
        pending: 0,
        failure: 0,
        failure_reasons: BTreeMap::new(),
        duration_ms: DurationSummary {
            p50: None,
            p95: None,
            max: None,
        },
        timeouts: 0,
        crashes: 0,
        factory_versions: BTreeMap::new(),
        cache_hits,
        probe_attempts,
    };
    let mut durations = Vec::new();
    for artifact in artifacts {
        match &artifact.state {
            ArtifactState::StaticSuccess { .. } => summary.success += 1,
            ArtifactState::ProbePending { .. } => summary.pending += 1,
            ArtifactState::ProbeSucceeded {
                duration_ms,
                descriptor_apis,
                ..
            } => {
                summary.success += 1;
                durations.push(*duration_ms);
                for api in descriptor_apis
                    .iter()
                    .filter(|api| api.starts_with("factory"))
                {
                    *summary.factory_versions.entry(api.clone()).or_default() += 1;
                }
            }
            ArtifactState::ProbeFailed {
                duration_ms,
                failure,
            } => {
                summary.failure += 1;
                durations.push(*duration_ms);
                *summary
                    .failure_reasons
                    .entry(failure.code.clone())
                    .or_default() += 1;
                if failure.code == "timeout" {
                    summary.timeouts += 1;
                }
                if failure.code == "crash" {
                    summary.crashes += 1;
                }
            }
        }
    }
    durations.sort_unstable();
    summary.duration_ms = DurationSummary {
        p50: percentile(&durations, 50),
        p95: percentile(&durations, 95),
        max: durations.last().copied(),
    };
    summary
}

fn percentile(sorted: &[u64], percentile: usize) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (percentile * sorted.len()).div_ceil(100);
    sorted.get(rank.saturating_sub(1)).copied()
}

/// `~/.orbitscore/plugin-catalog.json` のパスを返す。
pub fn cache_path(home: &Path) -> PathBuf {
    home.join(".orbitscore").join("plugin-catalog.json")
}

/// Read a prior catalog for positive/negative cache lookup.
///
/// A missing file is the normal cold-start case. Malformed or unreadable files are reported to
/// the caller so the scanner can warn and safely continue with a cold scan.
pub fn read_catalog(path: &Path) -> io::Result<Option<Catalog>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

/// カタログを JSON にシリアライズして `path` へ atomic write（tmp + rename）する。
pub fn write_catalog(catalog: &Catalog, path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(catalog)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, path)?;
    Ok(())
}

/// 現在時刻を ISO8601 (UTC, `YYYY-MM-DDTHH:MM:SSZ`) にフォーマットする。
/// chrono 等の外部 crate を workspace に追加しないため自前実装（うるう秒は考慮しない）。
pub fn now_iso8601() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format_unix_timestamp(duration.as_secs())
}

fn format_unix_timestamp(total_seconds: u64) -> String {
    let days = total_seconds / 86_400;
    let rem = total_seconds % 86_400;
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;

    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard Hinnant の `civil_from_days` アルゴリズム（proleptic Gregorian, days since epoch 1970-01-01）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn append_u32(bytes: &mut Vec<u8>, value: u32, order: ByteOrder) {
        match order {
            ByteOrder::Big => bytes.extend_from_slice(&value.to_be_bytes()),
            ByteOrder::Little => bytes.extend_from_slice(&value.to_le_bytes()),
        }
    }

    fn thin_macho(cpu_type: u32, order: ByteOrder, is_64_bit: bool) -> Vec<u8> {
        let mut bytes = match (order, is_64_bit) {
            (ByteOrder::Big, false) => vec![0xfe, 0xed, 0xfa, 0xce],
            (ByteOrder::Little, false) => vec![0xce, 0xfa, 0xed, 0xfe],
            (ByteOrder::Big, true) => vec![0xfe, 0xed, 0xfa, 0xcf],
            (ByteOrder::Little, true) => vec![0xcf, 0xfa, 0xed, 0xfe],
        };
        append_u32(&mut bytes, cpu_type, order);
        bytes
    }

    fn fat_macho(cpu_types: &[u32], order: ByteOrder, is_64_bit: bool) -> Vec<u8> {
        let mut bytes = match (order, is_64_bit) {
            (ByteOrder::Big, false) => vec![0xca, 0xfe, 0xba, 0xbe],
            (ByteOrder::Little, false) => vec![0xbe, 0xba, 0xfe, 0xca],
            (ByteOrder::Big, true) => vec![0xca, 0xfe, 0xba, 0xbf],
            (ByteOrder::Little, true) => vec![0xbf, 0xba, 0xfe, 0xca],
        };
        append_u32(&mut bytes, cpu_types.len() as u32, order);
        let record_size = if is_64_bit { 32 } else { 20 };
        for cpu_type in cpu_types {
            append_u32(&mut bytes, *cpu_type, order);
            bytes.resize(bytes.len() + record_size - 4, 0);
        }
        bytes
    }

    #[test]
    fn fat_headers_honor_endianness_and_32_or_64_bit_records() {
        let expected = Some(vec!["x86_64".to_owned(), "arm64".to_owned()]);
        for (order, is_64_bit) in [
            (ByteOrder::Big, false),
            (ByteOrder::Little, false),
            (ByteOrder::Big, true),
            (ByteOrder::Little, true),
        ] {
            let bytes = fat_macho(&[0x0100_0007, 0x0100_000c], order, is_64_bit);
            assert_eq!(
                parse_macho_architectures(&bytes),
                expected,
                "fat Mach-O header endian conversion is required for FAT_MAGIC/FAT_CIGAM and 64-bit variants"
            );
        }
    }

    #[test]
    fn thin_headers_report_their_single_slice() {
        assert_eq!(
            parse_macho_architectures(&thin_macho(0x0100_000c, ByteOrder::Little, true)),
            Some(vec!["arm64".to_owned()]),
            "thin arm64-only Mach-O must report its slice"
        );
        assert_eq!(
            parse_macho_architectures(&thin_macho(7, ByteOrder::Big, false)),
            Some(vec!["x86".to_owned()]),
            "thin and fat parsing must remain separate"
        );
    }

    #[test]
    fn universal_and_thin_arm64_executables_pass_arm64_preflight() {
        let temp = tempfile::tempdir().expect("tempdir");
        let universal = temp.path().join("Universal.clap");
        let arm64_only = temp.path().join("Arm64Only.clap");
        fs::write(
            &universal,
            fat_macho(&[0x0100_0007, 0x0100_000c], ByteOrder::Big, false),
        )
        .unwrap();
        fs::write(
            &arm64_only,
            thin_macho(0x0100_000c, ByteOrder::Little, true),
        )
        .unwrap();

        assert!(
            preflight_artifact_architecture_for_host(&universal, "arm64").is_ok(),
            "universal x86_64 + arm64 binary must not be rejected on arm64"
        );
        assert!(
            preflight_artifact_architecture_for_host(&arm64_only, "arm64").is_ok(),
            "thin arm64-only binary must not be rejected on arm64"
        );
    }

    #[test]
    fn three_x86_64_only_artifacts_are_classified_before_spawn() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = ["MODO BASS.clap", "Super 8.clap", "Philharmonik 2.clap"]
            .map(|name| temp.path().join(name));
        for path in &paths {
            fs::write(path, thin_macho(0x0100_0007, ByteOrder::Little, true)).unwrap();
        }

        let errors = paths
            .iter()
            .filter_map(|path| preflight_artifact_architecture_for_host(path, "arm64").err())
            .collect::<Vec<_>>();
        assert_eq!(
            errors.len(),
            3,
            "all three x86_64-only artifacts must be classified as unsupportedArch before child spawn"
        );
        for error in errors {
            match error {
                ArtifactProbeError::UnsupportedArch { host_arch, slices } => {
                    assert_eq!(host_arch, "arm64");
                    assert_eq!(slices, vec!["x86_64"]);
                }
                other => panic!("expected unsupportedArch, got {other:?}"),
            }
        }
    }

    #[test]
    fn parent_arch_preflight_returns_failure_payload_without_spawning() {
        let Some(host_arch) = host_macho_arch_name() else {
            return;
        };
        let (other_cpu_type, other_arch) = if host_arch == "arm64" {
            (0x0100_0007, "x86_64")
        } else {
            (0x0100_000c, "arm64")
        };
        let temp = tempfile::tempdir().expect("tempdir");
        let artifact = temp.path().join("WrongArch.clap");
        fs::write(
            &artifact,
            thin_macho(other_cpu_type, ByteOrder::Little, true),
        )
        .unwrap();

        let execution = run_child_probe(
            Path::new("/definitely/missing/orbit-plugin-scan"),
            &artifact,
            Format::Clap,
        );
        let failure = execution
            .result
            .expect_err("architecture mismatch must fail before spawning");
        assert_eq!(failure.code, "unsupportedArch");
        assert_eq!(failure.host_arch.as_deref(), Some(host_arch));
        assert_eq!(failure.slices, Some(vec![other_arch.to_owned()]));
        assert_eq!(failure.exit_code, None);
        assert_eq!(failure.signal, None);
    }

    #[test]
    fn unsupported_arch_error_serializes_host_and_slices() {
        let error = ArtifactProbeError::UnsupportedArch {
            host_arch: "arm64".to_owned(),
            slices: vec!["x86_64".to_owned()],
        };
        let child_json = serde_json::to_value(&error).unwrap();
        assert_eq!(child_json["kind"], "unsupportedArch");
        assert_eq!(child_json["hostArch"], "arm64");
        assert_eq!(child_json["slices"], serde_json::json!(["x86_64"]));

        let failure_json = serde_json::to_value(error.into_probe_failure(None, None)).unwrap();
        assert_eq!(failure_json["code"], "unsupportedArch");
        assert_eq!(failure_json["hostArch"], "arm64");
        assert_eq!(failure_json["slices"], serde_json::json!(["x86_64"]));
        assert!(failure_json.get("exitCode").is_none());
    }

    #[test]
    fn extra_scan_dirs_from_env_splits_on_colon() {
        let dirs = extra_scan_dirs_from_env(Some("/a/b:/c/d: :"));
        assert_eq!(dirs, vec![PathBuf::from("/a/b"), PathBuf::from("/c/d")]);
    }

    #[test]
    fn extra_scan_dirs_from_env_none_is_empty() {
        assert!(extra_scan_dirs_from_env(None).is_empty());
    }

    #[test]
    fn resolve_scan_dirs_dedupes_and_includes_defaults() {
        let home = PathBuf::from("/Users/tester");
        let dirs = resolve_scan_dirs(
            Some(&home),
            Some("/Library/Audio/Plug-Ins/VST3:/extra/path"),
        );
        assert!(dirs.contains(&home.join("Library/Audio/Plug-Ins/CLAP")));
        assert!(dirs.contains(&home.join("Library/Audio/Plug-Ins/VST3")));
        assert!(dirs.contains(&PathBuf::from("/Library/Audio/Plug-Ins/CLAP")));
        assert!(dirs.contains(&PathBuf::from("/extra/path")));
        // 重複除去: /Library/Audio/Plug-Ins/VST3 はデフォルトにも env にも入っているが 1 回のみ。
        let vst3_count = dirs
            .iter()
            .filter(|d| *d == &PathBuf::from("/Library/Audio/Plug-Ins/VST3"))
            .count();
        assert_eq!(vst3_count, 1);
    }

    #[test]
    fn list_bundle_candidates_is_non_recursive_and_filters_extensions() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();

        fs::create_dir(root.join("Foo.clap")).unwrap();
        fs::create_dir(root.join("Bar.vst3")).unwrap();
        fs::write(root.join("ignore.txt"), "").unwrap();
        // 非再帰: サブディレクトリ内の .clap は見つからない。
        let nested = root.join("Foo.clap").join("Nested.clap");
        fs::create_dir(&nested).unwrap();

        let mut found = list_bundle_candidates(root);
        found.sort_by(|a, b| a.0.cmp(&b.0));

        assert_eq!(found.len(), 2);
        assert_eq!(found[0].1, Format::Vst3);
        assert_eq!(found[1].1, Format::Clap);
    }

    #[test]
    fn list_bundle_candidates_on_missing_dir_is_empty() {
        let found = list_bundle_candidates(Path::new("/does/not/exist/orbit-plugin-scan-test"));
        assert!(found.is_empty());
    }

    #[test]
    fn catalog_entry_serializes_expected_json_shape() {
        let entry = CatalogEntry {
            name: "Test Synth".to_owned(),
            vendor: "Acme".to_owned(),
            format: Format::Clap,
            path: "/path/to/Test.clap".to_owned(),
            plugin_id: "com.acme.testsynth".to_owned(),
            roles: vec![ROLE_INSTRUMENT.to_owned()],
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["name"], "Test Synth");
        assert_eq!(json["vendor"], "Acme");
        assert_eq!(json["format"], "clap");
        assert_eq!(json["path"], "/path/to/Test.clap");
        assert_eq!(json["pluginId"], "com.acme.testsynth");
        assert_eq!(json["roles"][0], "instrument");
    }

    #[test]
    fn catalog_serializes_top_level_shape() {
        let catalog = Catalog {
            version: 2,
            scanned_at: "2026-07-17T00:00:00Z".to_owned(),
            plugins: vec![],
            artifacts: vec![],
        };
        let json = serde_json::to_value(&catalog).unwrap();
        assert_eq!(json["version"], 2);
        assert_eq!(json["scannedAt"], "2026-07-17T00:00:00Z");
        assert!(json["plugins"].as_array().unwrap().is_empty());
        assert!(json["artifacts"].as_array().unwrap().is_empty());
    }

    #[test]
    fn b1_catalog_without_fingerprints_deserializes_as_cold_cache() {
        let catalog: Catalog = serde_json::from_str(
            r#"{
  "version": 2,
  "scannedAt": "2026-07-29T00:00:00Z",
  "plugins": [],
  "artifacts": [{
    "format": "vst3",
    "path": "/p/Legacy.vst3",
    "status": "probeFailed",
    "durationMs": 12,
    "failure": { "code": "bundleLoad", "message": "legacy" }
  }]
}"#,
        )
        .expect("B1 catalog remains readable");
        assert_eq!(catalog.artifacts.len(), 1);
        assert!(catalog.artifacts[0].fingerprint.is_none());
    }

    #[test]
    fn dedup_entries_keeps_last_write_wins() {
        let make = |vendor: &str| CatalogEntry {
            name: "Same".to_owned(),
            vendor: vendor.to_owned(),
            format: Format::Vst3,
            path: "/p/Same.vst3".to_owned(),
            plugin_id: "CID123".to_owned(),
            roles: vec![ROLE_EFFECT.to_owned()],
        };
        let entries = vec![make("Old"), make("New")];
        let deduped = dedup_entries(entries);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].vendor, "New");
    }

    #[test]
    fn dedup_entries_preserves_distinct_keys() {
        let a = CatalogEntry {
            name: "A".to_owned(),
            vendor: String::new(),
            format: Format::Clap,
            path: "/p/A.clap".to_owned(),
            plugin_id: "id.a".to_owned(),
            roles: vec![],
        };
        let b = CatalogEntry {
            path: "/p/B.clap".to_owned(),
            plugin_id: "id.b".to_owned(),
            name: "B".to_owned(),
            ..a.clone()
        };
        let deduped = dedup_entries(vec![a, b]);
        assert_eq!(deduped.len(), 2);
    }

    #[test]
    fn roles_from_clap_features_instrument_only() {
        let features = vec!["instrument".to_owned(), "stereo".to_owned()];
        assert_eq!(roles_from_clap_features(&features), vec![ROLE_INSTRUMENT]);
    }

    #[test]
    fn roles_from_clap_features_effect_only() {
        let features = vec!["audio-effect".to_owned()];
        assert_eq!(roles_from_clap_features(&features), vec![ROLE_EFFECT]);
    }

    #[test]
    fn roles_from_clap_features_unknown_gets_both() {
        let features = vec!["stereo".to_owned()];
        let roles = roles_from_clap_features(&features);
        assert_eq!(roles, vec![ROLE_INSTRUMENT, ROLE_EFFECT]);
    }

    #[test]
    fn strip_trailing_commas_removes_before_close_brace_and_bracket() {
        let input = "{\"a\":1,\"b\":[1,2,],}";
        let stripped = strip_trailing_commas(input);
        let value: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(value["a"], 1);
        assert_eq!(value["b"][1], 2);
    }

    #[test]
    fn strip_trailing_commas_preserves_commas_inside_strings() {
        let input = r#"{"a":"has, a comma,"}"#;
        let stripped = strip_trailing_commas(input);
        let value: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(value["a"], "has, a comma,");
    }

    #[test]
    fn parse_moduleinfo_extracts_audio_module_class_only() {
        let text = r#"{
  "Name": "Scaler 3",
  "Factory Info": { "Vendor": "Scaler Music" },
  "Classes": [
    {
      "CID": "ABCDEF019182FAEB53634D7353636C33",
      "Category": "Audio Module Class",
      "Name": "Scaler 3",
      "Vendor": "Scaler Music",
      "Sub Categories": ["Instrument"],
    },
    {
      "CID": "ABCDEF011234ABCD53634D7353636C33",
      "Category": "Component Controller Class",
      "Name": "Scaler 3",
      "Vendor": "Scaler Music",
      "Sub Categories": ["Instrument"],
    },
  ],
}"#;
        let entries = parse_moduleinfo(text, Path::new("/p/Scaler.vst3")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].plugin_id, "ABCDEF019182FAEB53634D7353636C33");
        assert_eq!(entries[0].vendor, "Scaler Music");
        assert_eq!(entries[0].roles, vec![ROLE_INSTRUMENT.to_owned()]);
    }

    #[test]
    fn parse_moduleinfo_fx_subcategory_maps_to_effect() {
        let text = r#"{
  "Name": "Some Fx",
  "Classes": [
    { "CID": "AAAA", "Category": "Audio Module Class", "Sub Categories": ["Fx", "Reverb"] },
  ],
}"#;
        let entries = parse_moduleinfo(text, Path::new("/p/Fx.vst3")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].roles, vec![ROLE_EFFECT.to_owned()]);
    }

    #[test]
    fn scan_vst3_bundle_without_moduleinfo_is_pending_not_failed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bundle = temp.path().join("NoModuleInfo.vst3");
        fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
        // moduleinfo.json を意図的に置かない。

        match scan_vst3_bundle(&bundle) {
            VstScanResult::ProbePending { reason } => {
                assert_eq!(reason, "moduleinfoMissing");
            }
            VstScanResult::StaticSuccess(entries) => {
                panic!("moduleinfo-less artifact must be pending, not successful: {entries:?}")
            }
        }

        let outcome = scan_candidates(vec![(bundle, Format::Vst3)], false, None, &|_, _| {
            panic!("metadata-only scan invoked native probe")
        });
        assert_eq!(
            (
                outcome.summary.success,
                outcome.summary.pending,
                outcome.summary.failure
            ),
            (0, 1, 0),
            "moduleinfo-less artifact must count as probe pending, never as probe failure"
        );
        assert!(
            outcome.skipped.is_empty(),
            "probe-pending artifacts must not appear in the legacy skipped projection"
        );
    }

    #[test]
    fn scan_vst3_bundle_with_moduleinfo_returns_entries() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bundle = temp.path().join("HasModuleInfo.vst3");
        let resources = bundle.join("Contents/Resources");
        fs::create_dir_all(&resources).unwrap();
        fs::write(
            resources.join("moduleinfo.json"),
            r#"{
  "Name": "Test",
  "Classes": [
    { "CID": "AAAA", "Category": "Audio Module Class", "Sub Categories": ["Fx"] },
  ],
}"#,
        )
        .unwrap();

        match scan_vst3_bundle(&bundle) {
            VstScanResult::StaticSuccess(entries) => {
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].plugin_id, "AAAA");
            }
            VstScanResult::ProbePending { reason } => {
                panic!("expected StaticSuccess, got ProbePending({reason})")
            }
        }
    }

    #[test]
    fn explicit_flag_is_the_only_path_that_invokes_native_probe() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = AtomicUsize::new(0);
        let candidate = (PathBuf::from("/plugins/DescriptorOnly.clap"), Format::Clap);
        let runner = |path: &Path, format: Format| {
            calls.fetch_add(1, Ordering::SeqCst);
            ProbeExecution {
                duration_ms: 3,
                result: Ok(ProbeSuccess {
                    source: "clapDescriptor".to_owned(),
                    plugins: vec![CatalogEntry {
                        name: "Descriptor Only".to_owned(),
                        vendor: "Orbit".to_owned(),
                        format,
                        path: path.to_string_lossy().into_owned(),
                        plugin_id: "descriptor-only".to_owned(),
                        roles: vec![ROLE_EFFECT.to_owned()],
                    }],
                    descriptor_apis: vec!["clap".to_owned()],
                }),
            }
        };

        let unattended = scan_candidates(vec![candidate.clone()], false, None, &runner);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "metadata-only startup must not invoke a native child probe"
        );
        assert_eq!(unattended.summary.pending, 1);

        let explicit = scan_candidates(vec![candidate], true, None, &runner);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(explicit.entries.len(), 1);
        assert_eq!(explicit.summary.success, 1);
        assert_eq!(explicit.summary.pending, 0);
    }

    fn catalog_from_outcome(outcome: &ScanOutcome) -> Catalog {
        Catalog {
            version: 2,
            scanned_at: "2026-07-29T00:00:00Z".to_owned(),
            plugins: outcome.entries.clone(),
            artifacts: outcome.artifacts.clone(),
        }
    }

    #[test]
    fn matching_fingerprint_reuses_positive_cache_without_probing() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let temp = tempfile::tempdir().expect("tempdir");
        let clap = temp.path().join("Cached.clap");
        fs::write(&clap, b"descriptor-v1").unwrap();
        let calls = AtomicUsize::new(0);
        let runner = |path: &Path, format: Format| {
            calls.fetch_add(1, Ordering::SeqCst);
            ProbeExecution {
                duration_ms: 7,
                result: Ok(ProbeSuccess {
                    source: "clapDescriptor".to_owned(),
                    plugins: vec![CatalogEntry {
                        name: "Cached".to_owned(),
                        vendor: "Orbit".to_owned(),
                        format,
                        path: path.to_string_lossy().into_owned(),
                        plugin_id: "cached".to_owned(),
                        roles: vec![ROLE_EFFECT.to_owned()],
                    }],
                    descriptor_apis: vec!["clap".to_owned()],
                }),
            }
        };
        let candidates = vec![(clap, Format::Clap)];
        let cold = scan_candidates(candidates.clone(), true, None, &runner);
        let previous = catalog_from_outcome(&cold);
        let warm = scan_candidates(candidates, true, Some(&previous), &runner);

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "positive cache ignored: matching fingerprint was probed again"
        );
        assert_eq!(warm.summary.cache_hits, 1);
        assert_eq!(warm.summary.probe_attempts, 0);
        assert_eq!(warm.entries.len(), 1);
    }

    #[test]
    fn matching_fingerprint_quarantines_negative_cache_without_probing() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let temp = tempfile::tempdir().expect("tempdir");
        let clap = temp.path().join("Broken.clap");
        fs::write(&clap, b"broken-v1").unwrap();
        let calls = AtomicUsize::new(0);
        let runner = |_: &Path, _: Format| {
            calls.fetch_add(1, Ordering::SeqCst);
            ProbeExecution {
                duration_ms: 11,
                result: Err(ProbeFailure {
                    code: "bundleLoad".to_owned(),
                    message: "broken".to_owned(),
                    host_arch: None,
                    slices: None,
                    exit_code: Some(1),
                    signal: None,
                }),
            }
        };
        let candidates = vec![(clap, Format::Clap)];
        let cold = scan_candidates(candidates.clone(), true, None, &runner);
        let previous = catalog_from_outcome(&cold);
        let warm = scan_candidates(candidates, true, Some(&previous), &runner);

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "negative cache removed: quarantined fingerprint was probed again"
        );
        assert_eq!(warm.summary.cache_hits, 1);
        assert_eq!(warm.summary.probe_attempts, 0);
        assert_eq!(warm.summary.failure, 1);
        assert_eq!(warm.summary.failure_reasons["bundleLoad"], 1);
    }

    #[test]
    fn matching_fingerprint_reclassifies_cached_bundle_load_without_probing() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let Some(host_arch) = host_macho_arch_name() else {
            return;
        };
        let (other_cpu_type, other_arch) = if host_arch == "arm64" {
            (0x0100_0007, "x86_64")
        } else {
            (0x0100_000c, "arm64")
        };
        let temp = tempfile::tempdir().expect("tempdir");
        let clap = temp.path().join("PreviouslyMisclassified.clap");
        fs::write(&clap, thin_macho(other_cpu_type, ByteOrder::Little, true)).unwrap();
        let calls = AtomicUsize::new(0);
        let runner = |_: &Path, _: Format| {
            calls.fetch_add(1, Ordering::SeqCst);
            ProbeExecution {
                duration_ms: 14,
                result: Err(ProbeFailure {
                    code: "bundleLoad".to_owned(),
                    message: "legacy load failure".to_owned(),
                    host_arch: None,
                    slices: None,
                    exit_code: Some(1),
                    signal: None,
                }),
            }
        };
        let candidates = vec![(clap, Format::Clap)];
        let cold = scan_candidates(candidates.clone(), true, None, &runner);
        let previous = catalog_from_outcome(&cold);
        let warm = scan_candidates(candidates, true, Some(&previous), &runner);

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "cached architecture failure must be reclassified without spawning another child"
        );
        assert_eq!(warm.summary.cache_hits, 1);
        assert_eq!(warm.summary.probe_attempts, 0);
        assert_eq!(warm.summary.failure_reasons["unsupportedArch"], 1);
        let ArtifactState::ProbeFailed { failure, .. } = &warm.artifacts[0].state else {
            panic!("cached failure must remain quarantined")
        };
        assert_eq!(failure.host_arch.as_deref(), Some(host_arch));
        assert_eq!(failure.slices, Some(vec![other_arch.to_owned()]));
    }

    #[test]
    fn unsupported_arch_cache_recovers_after_executable_mtime_change() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let temp = tempfile::tempdir().expect("tempdir");
        let clap = temp.path().join("Updated.clap");
        fs::write(&clap, b"a").unwrap();
        let calls = AtomicUsize::new(0);
        let runner = |path: &Path, format: Format| {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            let result = if call == 0 {
                Err(ProbeFailure {
                    code: "unsupportedArch".to_owned(),
                    message: "host architecture arm64 is not present in Mach-O slices [x86_64]"
                        .to_owned(),
                    host_arch: Some("arm64".to_owned()),
                    slices: Some(vec!["x86_64".to_owned()]),
                    exit_code: None,
                    signal: None,
                })
            } else {
                Ok(ProbeSuccess {
                    source: "clapDescriptor".to_owned(),
                    plugins: vec![CatalogEntry {
                        name: "Updated".to_owned(),
                        vendor: "Orbit".to_owned(),
                        format,
                        path: path.to_string_lossy().into_owned(),
                        plugin_id: "updated".to_owned(),
                        roles: vec![ROLE_EFFECT.to_owned()],
                    }],
                    descriptor_apis: vec!["clap".to_owned()],
                })
            };
            ProbeExecution {
                duration_ms: 2,
                result,
            }
        };
        let candidates = vec![(clap.clone(), Format::Clap)];
        let cold = scan_candidates(candidates.clone(), true, None, &runner);
        let ArtifactState::ProbeFailed { failure, .. } = &cold.artifacts[0].state else {
            panic!("first probe must cache the architecture failure")
        };
        assert_eq!(failure.code, "unsupportedArch");
        assert_eq!(failure.host_arch.as_deref(), Some("arm64"));
        assert_eq!(failure.slices, Some(vec!["x86_64".to_owned()]));
        let previous = catalog_from_outcome(&cold);
        let old_fingerprint = artifact_fingerprint(&clap, Format::Clap);
        let old_modified = fs::metadata(&clap).unwrap().modified().unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        let new_fingerprint = loop {
            thread::sleep(Duration::from_millis(10));
            fs::write(&clap, b"b").unwrap();
            if fs::metadata(&clap).unwrap().modified().unwrap() != old_modified {
                break artifact_fingerprint(&clap, Format::Clap);
            }
            assert!(
                Instant::now() < deadline,
                "test filesystem did not expose an executable mtime change"
            );
        };
        assert_eq!(
            old_fingerprint.executable_size, new_fingerprint.executable_size,
            "test mutation must keep executable size constant"
        );

        let updated = scan_candidates(candidates, true, Some(&previous), &runner);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "fingerprint mtime missing: updated executable was not re-probed"
        );
        assert_eq!(updated.summary.cache_hits, 0);
        assert_eq!(updated.summary.probe_attempts, 1);
        assert_eq!(updated.summary.failure, 0);
        assert_eq!(updated.summary.success, 1);
    }

    #[test]
    fn fingerprint_uses_executable_and_info_plist_metadata_not_contents() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bundle = temp.path().join("DifferentName.vst3");
        let executable = bundle.join("Contents/MacOS/ActualExecutable");
        let info_plist = bundle.join("Contents/Info.plist");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"binary bytes are never hashed").unwrap();
        fs::write(
            &info_plist,
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.orbit.fingerprint</string>
<key>CFBundleExecutable</key><string>ActualExecutable</string>
<key>CFBundlePackageType</key><string>BNDL</string>
</dict></plist>"#,
        )
        .unwrap();

        let fingerprint = artifact_fingerprint(&bundle, Format::Vst3);
        assert_eq!(
            fingerprint.executable_relative_path,
            "Contents/MacOS/ActualExecutable"
        );
        assert_eq!(
            fingerprint.executable_size,
            Some(b"binary bytes are never hashed".len() as u64)
        );
        assert!(fingerprint.executable_modified_ns.is_some());
        assert_eq!(
            fingerprint.info_plist_size,
            Some(fs::metadata(info_plist).unwrap().len())
        );
        assert!(fingerprint.info_plist_modified_ns.is_some());
        assert_eq!(fingerprint.scanner_schema_version, SCANNER_SCHEMA_VERSION);

        let json = serde_json::to_value(fingerprint).unwrap();
        assert!(
            json.get("contentHash").is_none(),
            "fingerprint must never hash executable contents"
        );
        assert!(
            json.get("bundleModifiedNs").is_none(),
            "bundle directory mtime must not be a freshness key"
        );
    }

    #[test]
    fn explicit_probe_keeps_static_plugins_and_recovers_pending_clap() {
        let temp = tempfile::tempdir().expect("tempdir");
        let vst3 = temp.path().join("Static.vst3");
        fs::create_dir_all(vst3.join("Contents/Resources")).unwrap();
        fs::write(
            vst3.join("Contents/Resources/moduleinfo.json"),
            r#"{
  "Name": "Static Synth",
  "Classes": [
    { "CID": "STATIC", "Category": "Audio Module Class", "Sub Categories": ["Instrument"] }
  ]
}"#,
        )
        .unwrap();
        let clap = temp.path().join("Descriptor.clap");
        fs::write(&clap, "").unwrap();
        let candidates = vec![(vst3, Format::Vst3), (clap, Format::Clap)];
        let runner = |path: &Path, format: Format| ProbeExecution {
            duration_ms: 1,
            result: Ok(ProbeSuccess {
                source: "clapDescriptor".to_owned(),
                plugins: vec![CatalogEntry {
                    name: "Descriptor Effect".to_owned(),
                    vendor: "Orbit".to_owned(),
                    format,
                    path: path.to_string_lossy().into_owned(),
                    plugin_id: "descriptor-effect".to_owned(),
                    roles: vec![ROLE_EFFECT.to_owned()],
                }],
                descriptor_apis: vec!["clap".to_owned()],
            }),
        };

        let before = scan_candidates(candidates.clone(), false, None, &runner);
        let after = scan_candidates(candidates, true, None, &runner);
        assert_eq!(before.entries.len(), 1);
        assert_eq!(
            after.entries.len(),
            2,
            "explicit probing must not regress CLAP count"
        );
        for old in before.entries {
            assert!(
                after
                    .entries
                    .iter()
                    .any(|new| dedup_key(new) == dedup_key(&old)),
                "every legacy static plugin must remain in the catalog v2 compatibility projection"
            );
        }
    }

    #[test]
    fn summary_reports_factory_versions_reasons_and_duration_percentiles() {
        let artifact = |state| CatalogArtifact {
            format: Format::Vst3,
            path: "/p/Test.vst3".to_owned(),
            fingerprint: None,
            state,
        };
        let artifacts = vec![
            artifact(ArtifactState::StaticSuccess {
                source: "moduleinfo".to_owned(),
                plugins: vec![],
            }),
            artifact(ArtifactState::ProbeSucceeded {
                source: "factory".to_owned(),
                duration_ms: 10,
                descriptor_apis: vec!["factory3".to_owned(), "factory1".to_owned()],
                plugins: vec![],
            }),
            artifact(ArtifactState::ProbeFailed {
                duration_ms: 20,
                failure: ProbeFailure {
                    code: "timeout".to_owned(),
                    message: "slow".to_owned(),
                    host_arch: None,
                    slices: None,
                    exit_code: None,
                    signal: Some(libc::SIGKILL),
                },
            }),
            artifact(ArtifactState::ProbeFailed {
                duration_ms: 30,
                failure: ProbeFailure {
                    code: "crash".to_owned(),
                    message: "boom".to_owned(),
                    host_arch: None,
                    slices: None,
                    exit_code: None,
                    signal: Some(libc::SIGABRT),
                },
            }),
        ];
        let summary = summarize_artifacts(&artifacts, 0, 4);
        assert_eq!(
            (summary.success, summary.pending, summary.failure),
            (2, 0, 2)
        );
        assert_eq!(summary.failure_reasons["timeout"], 1);
        assert_eq!(summary.failure_reasons["crash"], 1);
        assert_eq!(summary.timeouts, 1);
        assert_eq!(summary.crashes, 1);
        assert_eq!(summary.factory_versions["factory3"], 1);
        assert_eq!(summary.factory_versions["factory1"], 1);
        assert_eq!(summary.cache_hits, 0);
        assert_eq!(summary.probe_attempts, 4);
        assert_eq!(
            summary.duration_ms,
            DurationSummary {
                p50: Some(20),
                p95: Some(30),
                max: Some(30)
            }
        );
    }

    #[test]
    fn child_protocol_ignores_third_party_stdout_before_its_json_line() {
        let stdout = br#"2026-07-29 plugin diagnostic
{"ok":true,"classes":[]}
"#;
        let parsed = parse_child_probe_output(stdout).expect("find trailing protocol JSON");
        assert!(parsed.ok);
        assert!(parsed.classes.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_the_entire_probe_process_group_including_grandchildren() {
        let temp = tempfile::tempdir().expect("tempdir");
        let pid_file = temp.path().join("grandchild.pid");

        let capture = run_process_with_timeout(
            Path::new("/bin/sh"),
            &[
                "-c".into(),
                "sleep 60 </dev/null >/dev/null 2>&1 & echo $! > \"$1\"; wait".into(),
                "group-kill-test".into(),
                pid_file.as_os_str().to_owned(),
            ],
            Duration::from_secs(2),
        )
        .expect("run timeout helper");
        assert!(capture.timed_out);
        let grandchild_pid: libc::pid_t = fs::read_to_string(&pid_file)
            .expect("grandchild pid file")
            .trim()
            .parse()
            .expect("numeric grandchild pid");

        let deadline = Instant::now() + Duration::from_secs(2);
        let still_alive = loop {
            // SAFETY: signal 0 performs existence/permission checking only.
            let result = unsafe { libc::kill(grandchild_pid, 0) };
            if result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                break false;
            }
            if Instant::now() >= deadline {
                break true;
            }
            thread::sleep(Duration::from_millis(20));
        };
        if still_alive {
            // Mutation-test hygiene: do not leak the deliberately surviving descendant.
            // SAFETY: the pid was emitted by the helper started by this test.
            unsafe {
                libc::kill(grandchild_pid, libc::SIGKILL);
            }
        }
        assert!(
            !still_alive,
            "timed out probe must SIGKILL the entire process group; descendant pid {grandchild_pid} remained alive"
        );
    }

    #[test]
    fn now_iso8601_matches_expected_format() {
        let ts = now_iso8601();
        assert_eq!(ts.len(), 20);
        assert!(ts.ends_with('Z'));
        assert_eq!(ts.as_bytes()[4], b'-');
        assert_eq!(ts.as_bytes()[10], b'T');
    }

    #[test]
    fn format_unix_timestamp_known_epoch() {
        // 2024-01-01T00:00:00Z = 1704067200
        assert_eq!(format_unix_timestamp(1_704_067_200), "2024-01-01T00:00:00Z");
        // Unix epoch itself.
        assert_eq!(format_unix_timestamp(0), "1970-01-01T00:00:00Z");
    }
}
