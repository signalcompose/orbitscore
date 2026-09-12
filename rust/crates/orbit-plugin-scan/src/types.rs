//! カタログのデータ型（`Format` / `CatalogEntry` / `Catalog` / アーティファクト状態）（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

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
/// A bump is required when executable resolution/fingerprinting changes, and also when cached
/// descriptor data would project differently: `roles_from_clap_features`,
/// `roles_from_vst3_subcategories`, `is_catalog_class`, or the classes-to-entries conversion.
/// Cached states contain the already-mapped `CatalogEntry` values and `descriptorApis`, so those
/// semantic changes are otherwise invisible to a warm rescan.
pub const SCANNER_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutableResolution {
    DirectFile,
    CoreFoundation,
    InfoPlistXml,
    #[default]
    Convention,
    DirectoryScan,
}

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
    /// Schema-v1 fingerprints lack this field; their schema version still forces a cache miss.
    #[serde(default)]
    pub executable_resolution: ExecutableResolution,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFailure {
    pub path: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_arch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slices: Option<Vec<String>>,
}
