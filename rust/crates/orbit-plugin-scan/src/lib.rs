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

// #888 子 3: 主題ごとに分割した兄弟モジュール。lib.rs は宣言と再エクスポートだけを持つ。
mod artifact_probe;
mod catalog_io;
mod child_probe;
mod clap_scan;
mod dirs;
mod fingerprint;
mod macho;
mod process;
mod scan_run;
mod summary;
mod types;
mod vst3_scan;

#[allow(unused_imports)]
pub use artifact_probe::*;
#[allow(unused_imports)]
pub use catalog_io::*;
#[allow(unused_imports)]
pub use child_probe::*;
#[allow(unused_imports)]
pub use clap_scan::*;
#[allow(unused_imports)]
pub use dirs::*;
#[allow(unused_imports)]
pub use fingerprint::*;
#[allow(unused_imports)]
pub use macho::*;
#[allow(unused_imports)]
pub use process::*;
#[allow(unused_imports)]
pub use scan_run::*;
#[allow(unused_imports)]
pub use summary::*;
#[allow(unused_imports)]
pub use types::*;
#[allow(unused_imports)]
pub use vst3_scan::*;

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
    fn inconclusive_failures_are_retried_only_by_explicit_rescan() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let temp = tempfile::tempdir().expect("tempdir");
        let clap = temp.path().join("Transient.clap");
        fs::write(&clap, b"not a Mach-O").unwrap();
        let calls = AtomicUsize::new(0);
        let runner = |path: &Path, format: Format| {
            let result = if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(ProbeFailure {
                    code: "protocolError".to_owned(),
                    message: "temporary malformed child output".to_owned(),
                    host_arch: None,
                    slices: None,
                    exit_code: Some(0),
                    signal: None,
                })
            } else {
                Ok(ProbeSuccess {
                    source: "clapDescriptor".to_owned(),
                    plugins: vec![CatalogEntry {
                        name: "Recovered".to_owned(),
                        vendor: "Orbit".to_owned(),
                        format,
                        path: path.to_string_lossy().into_owned(),
                        plugin_id: "recovered".to_owned(),
                        roles: vec![ROLE_EFFECT.to_owned()],
                    }],
                    descriptor_apis: vec!["clap".to_owned()],
                })
            };
            ProbeExecution {
                duration_ms: 1,
                result,
            }
        };
        let candidates = vec![(clap, Format::Clap)];
        let cold = scan_candidates(candidates.clone(), true, None, &runner);
        let previous = catalog_from_outcome(&cold);
        let unattended = scan_candidates(candidates.clone(), false, Some(&previous), &|_, _| {
            panic!("metadata-only scan invoked explicit child probe")
        });
        assert_eq!(
            unattended.summary.failure, 0,
            "flagless CLAP scan uses its legacy in-process descriptor path"
        );
        let recovered = scan_candidates(candidates, true, Some(&previous), &runner);

        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "temporary failure was quarantined instead of retried by explicit rescan"
        );
        assert_eq!(recovered.summary.failure, 0);
        assert_eq!(recovered.summary.success, 1);
        assert_eq!(recovered.entries[0].name, "Recovered");

        for code in [
            "timeout",
            "killTimeout",
            "crash",
            "spawnError",
            "protocolError",
        ] {
            assert!(
                is_inconclusive_failure(code),
                "{code} did not complete artifact inspection and must not be quarantined"
            );
        }
        for code in [
            "bundleLoad",
            "unsupportedArch",
            "missingSymbol",
            "nullFactory",
            "invalidClassCount",
            "descriptorRead",
            "invalidBundle",
            "unsupportedFormat",
        ] {
            assert!(
                !is_inconclusive_failure(code),
                "{code} is an artifact conclusion and must remain fingerprint-cached"
            );
        }
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
        assert_eq!(unattended.summary.success, 1);
        assert_eq!(unattended.summary.pending, 0);

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
    fn unattended_scan_restores_previous_probe_result_without_native_loading() {
        let temp = tempfile::tempdir().expect("tempdir");
        let vst3 = temp.path().join("NoModuleInfo.vst3");
        fs::create_dir_all(vst3.join("Contents/Resources")).unwrap();
        let candidates = vec![(vst3, Format::Vst3)];
        let probed = scan_candidates(candidates.clone(), true, None, &|path, format| {
            ProbeExecution {
                duration_ms: 1,
                result: Ok(ProbeSuccess {
                    source: "factory".to_owned(),
                    plugins: vec![CatalogEntry {
                        name: "Cached VST3".to_owned(),
                        vendor: "Orbit".to_owned(),
                        format,
                        path: path.to_string_lossy().into_owned(),
                        plugin_id: "cached-vst3".to_owned(),
                        roles: vec![ROLE_INSTRUMENT.to_owned()],
                    }],
                    descriptor_apis: vec!["factory3".to_owned()],
                }),
            }
        });
        let previous = catalog_from_outcome(&probed);
        let unattended = scan_candidates(candidates, false, Some(&previous), &|_, _| {
            panic!("unattended scan must restore cache without a native child")
        });

        assert_eq!(unattended.summary.cache_hits, 1);
        assert_eq!(unattended.summary.probe_attempts, 0);
        assert_eq!(unattended.summary.success, 1);
        assert_eq!(unattended.entries[0].name, "Cached VST3");
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
    fn matching_unsupported_arch_cache_is_revalidated_and_can_recover() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let Some(host_arch) = host_macho_arch_name() else {
            return;
        };
        let host_cpu_type = match host_arch {
            "x86_64" => 0x0100_0007,
            "arm64" => 0x0100_000c,
            _ => return,
        };
        let temp = tempfile::tempdir().expect("tempdir");
        let clap = temp.path().join("ResolverRecovered.clap");
        fs::write(&clap, thin_macho(host_cpu_type, ByteOrder::Little, true)).unwrap();
        let fingerprint = artifact_fingerprint(&clap, Format::Clap);
        let previous = Catalog {
            version: 2,
            scanned_at: "2026-07-29T00:00:00Z".to_owned(),
            plugins: vec![],
            artifacts: vec![CatalogArtifact {
                format: Format::Clap,
                path: clap.to_string_lossy().into_owned(),
                fingerprint: Some(fingerprint),
                state: ArtifactState::ProbeFailed {
                    duration_ms: 0,
                    failure: ProbeFailure {
                        code: "unsupportedArch".to_owned(),
                        message: "stale executable resolution".to_owned(),
                        host_arch: Some(host_arch.to_owned()),
                        slices: Some(vec!["stale".to_owned()]),
                        exit_code: None,
                        signal: None,
                    },
                },
            }],
        };
        let calls = AtomicUsize::new(0);
        let outcome = scan_candidates(
            vec![(clap, Format::Clap)],
            true,
            Some(&previous),
            &|path, format| {
                calls.fetch_add(1, Ordering::SeqCst);
                ProbeExecution {
                    duration_ms: 1,
                    result: Ok(ProbeSuccess {
                        source: "clapDescriptor".to_owned(),
                        plugins: vec![CatalogEntry {
                            name: "Resolver Recovered".to_owned(),
                            vendor: "Orbit".to_owned(),
                            format,
                            path: path.to_string_lossy().into_owned(),
                            plugin_id: "resolver-recovered".to_owned(),
                            roles: vec![ROLE_EFFECT.to_owned()],
                        }],
                        descriptor_apis: vec!["clap".to_owned()],
                    }),
                }
            },
        );

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "cached unsupportedArch was not revalidated after executable resolution recovered"
        );
        assert_eq!(outcome.summary.cache_hits, 0);
        assert_eq!(outcome.summary.probe_attempts, 1);
        assert_eq!(outcome.summary.failure, 0);
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
        assert!(
            matches!(
                fingerprint.executable_resolution,
                ExecutableResolution::CoreFoundation | ExecutableResolution::InfoPlistXml
            ),
            "fingerprint must record the executable resolution path"
        );

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
    fn run_child_probe_classifies_real_crash_and_protocol_error_processes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let artifact = temp.path().join("Fixture.clap");
        fs::write(&artifact, b"not a Mach-O").unwrap();
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");

        let crashed = run_child_probe(&fixtures.join("crash.sh"), &artifact, Format::Clap);
        let crash = crashed.result.expect_err("SIGABRT fixture must fail");

        let malformed =
            run_child_probe(&fixtures.join("protocol-error.sh"), &artifact, Format::Clap);
        let protocol = malformed
            .result
            .expect_err("garbage stdout fixture must fail");
        assert_eq!(
            (crash.code.as_str(), protocol.code.as_str()),
            ("crash", "protocolError"),
            "real child exit signal and invalid stdout must retain distinct classifications"
        );
        assert_eq!(crash.signal, Some(libc::SIGABRT));
        assert_eq!(protocol.exit_code, Some(0));
        assert_eq!(protocol.signal, None);
    }

    #[cfg(unix)]
    #[test]
    fn kill_wait_bound_returns_kill_timeout_instead_of_blocking_the_worker() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::{mpsc, Arc};

        let killed_pid = Arc::new(AtomicU32::new(0));
        let killed_pid_for_worker = Arc::clone(&killed_pid);
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let result = run_process_with_timeout_and_killer(
                Path::new("/bin/sh"),
                &["-c".into(), "sleep 60".into()],
                Duration::from_millis(30),
                Duration::from_millis(100),
                |pid| {
                    killed_pid_for_worker.store(pid, Ordering::SeqCst);
                    Ok(())
                },
            );
            let _ = sender.send(result);
        });

        let received = receiver.recv_timeout(Duration::from_millis(500));
        let pid = killed_pid.load(Ordering::SeqCst);
        if pid != 0 {
            let _ = kill_process_group(pid);
        }
        let capture = received.unwrap_or_else(|_| {
            panic!(
                "scan worker remained blocked after killpg; child.wait() needs a finite post-kill bound"
            )
        });
        let capture = capture.expect("bounded process runner");
        assert!(capture.kill_timed_out);
        assert_eq!(
            timeout_failure(&capture, Duration::from_millis(30))
                .expect("kill timeout failure")
                .code,
            "killTimeout"
        );
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
    fn read_catalog_handles_missing_malformed_and_valid_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("plugin-catalog.json");
        assert!(
            read_catalog(&path)
                .expect("missing catalog is normal")
                .is_none(),
            "missing catalog must produce a cold scan"
        );

        fs::write(&path, "{ definitely not json").unwrap();
        let malformed = read_catalog(&path).expect_err("malformed catalog must be diagnosed");
        assert_eq!(malformed.kind(), io::ErrorKind::InvalidData);
        assert!(
            !malformed.to_string().is_empty(),
            "JSON parser detail must remain observable: {malformed}"
        );

        fs::write(
            &path,
            r#"{"version":2,"scannedAt":"2026-07-29T00:00:00Z","plugins":[],"artifacts":[]}"#,
        )
        .unwrap();
        let catalog = read_catalog(&path)
            .expect("valid catalog read")
            .expect("valid catalog exists");
        assert_eq!(catalog.version, 2);
        assert_eq!(catalog.scanned_at, "2026-07-29T00:00:00Z");
        assert!(catalog.plugins.is_empty());
        assert!(catalog.artifacts.is_empty());
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
