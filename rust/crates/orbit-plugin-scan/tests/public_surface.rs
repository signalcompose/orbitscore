//! `orbit_plugin_scan` の**公開面**を固定する（#888・分割で黙って狭まるのを防ぐ）。
//!
//! 🔴 **なぜ要るか**: `pub fn` を private な子モジュールへ移し `pub(crate) use child::*;` で
//! 再エクスポートすると、**crate 内はコンパイルが通るのに crate 外からは見えなくなる**。
//! `cargo clippy -p <crate>` は下流を見ないので捕まらず、下流にまだ消費者が居なければ
//! **誰も気づかない**。#888 の分割で実際に 2 度起きた:
//!
//! - `orbit_vst3_host::probe_factory_descriptors`（`orbit-plugin-scan` が使っていたので dead_code で露見）
//! - `orbit_audio_daemon::engine_wrap` の 9 項目（消費者が居らず**全ゲート緑のまま通過**。Fable 監査が発見）
//!
//! 🔴 **`pub` 宣言の数を分割前後で diff しても、この欠陥は捕まらない。** 宣言は `pub` のままで、
//! 到達経路だけが失われるからである。**統合テストは crate の外側**なので、ここで `use` できる
//! ことが到達可能性そのものの証明になる。
//!
//! 🔴 **cfg から `test` 項を落としてある。** 統合テストは `--test` 付きでコンパイルされるので
//! この crate では `cfg(test)` が真になるが、**参照先の lib は `--test` 無しでコンパイルされる**
//! ので偽である。定義側の `#[cfg(any(test, X))]` をそのまま写すと、lib に無い項目を
//! import しようとして E0432 になる（実際に踏んだ）。
//!
//! 項目を意図的に非公開へ変えるときは、この一覧からも消すこと（消さずに通ることはない）。

#![allow(unused_imports)]

use orbit_plugin_scan::artifact_fingerprint;
use orbit_plugin_scan::cache_path;
use orbit_plugin_scan::collect_all_bundle_candidates;
use orbit_plugin_scan::dedup_entries;
use orbit_plugin_scan::list_bundle_candidates;
use orbit_plugin_scan::now_iso8601;
use orbit_plugin_scan::probe_artifact;
use orbit_plugin_scan::read_catalog;
use orbit_plugin_scan::resolve_scan_dirs;
use orbit_plugin_scan::scan_all_with_cache;
use orbit_plugin_scan::scan_all_with_probes;
use orbit_plugin_scan::scan_all_with_probes_and_cache;
use orbit_plugin_scan::scan_clap_bundle;
use orbit_plugin_scan::scan_vst3_bundle;
use orbit_plugin_scan::write_catalog;
use orbit_plugin_scan::ArtifactClass;
use orbit_plugin_scan::ArtifactFingerprint;
use orbit_plugin_scan::ArtifactProbeError;
use orbit_plugin_scan::ArtifactState;
use orbit_plugin_scan::Catalog;
use orbit_plugin_scan::CatalogArtifact;
use orbit_plugin_scan::CatalogEntry;
use orbit_plugin_scan::DurationSummary;
use orbit_plugin_scan::ExecutableResolution;
use orbit_plugin_scan::Format;
use orbit_plugin_scan::ProbeFailure;
use orbit_plugin_scan::ScanFailure;
use orbit_plugin_scan::ScanOutcome;
use orbit_plugin_scan::ScanSummary;
use orbit_plugin_scan::VstScanResult;
use orbit_plugin_scan::ROLE_EFFECT;
use orbit_plugin_scan::ROLE_INSTRUMENT;
use orbit_plugin_scan::SCANNER_SCHEMA_VERSION;
