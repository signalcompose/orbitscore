#![cfg(target_os = "macos")]

use std::env;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

const ABORT_CREATE_INSTANCE_ENV: &str = "ORBIT_VST3_FACTORY_ABORT_CREATE_INSTANCE";
const FACTORY_LEVEL_ENV: &str = "ORBIT_VST3_FACTORY_ORACLE_LEVEL";
const TRIPWIRE_CHILD_ENV: &str = "ORBIT_VST3_FACTORY_TRIPWIRE_CHILD";
const TRIPWIRE_BUNDLE_ENV: &str = "ORBIT_VST3_FACTORY_TRIPWIRE_BUNDLE";

fn scanner() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_orbit-plugin-scan"))
}

fn oracle_bundle() -> PathBuf {
    orbit_vst3_gain_oracle::package_bundle()
        .expect("factory descriptor oracle must build and package")
}

fn run_factory_probe(bundle: &Path, level: &str) -> Output {
    Command::new(scanner())
        .arg("probe-artifact")
        .arg(bundle)
        .env(FACTORY_LEVEL_ENV, level)
        .env(ABORT_CREATE_INSTANCE_ENV, "1")
        .output()
        .expect("spawn orbit-plugin-scan probe-artifact")
}

fn parse_single_json_line(output: &Output) -> Value {
    let stdout = String::from_utf8(output.stdout.clone()).expect("probe stdout is UTF-8");
    assert_eq!(
        stdout.lines().count(),
        1,
        "probe-artifact must emit exactly one stdout line; stdout={stdout:?}"
    );
    serde_json::from_str(stdout.trim()).expect("probe stdout is JSON")
}

/// This is the positive-control child. The parent below starts this exact integration-test
/// executable in a fresh process so the oracle's `abort()` cannot kill the test harness.
#[test]
fn create_instance_tripwire_child() {
    if env::var_os(TRIPWIRE_CHILD_ENV).is_none() {
        return;
    }
    let bundle = PathBuf::from(
        env::var_os(TRIPWIRE_BUNDLE_ENV).expect("tripwire parent supplies oracle bundle"),
    );
    let _ = orbit_vst3_host::probe_plugin(&bundle);
    panic!("deep probe returned even though oracle createInstance must abort");
}

#[test]
fn probe_artifact_never_reaches_create_instance_for_factory3_factory2_and_v1() {
    let bundle = oracle_bundle();
    for (level, expected_api) in [("3", "factory3"), ("2", "factory2"), ("1", "factory1")] {
        let output = run_factory_probe(&bundle, level);
        assert!(
            output.status.success(),
            "factory level {level} probe died or failed; status={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        let json = parse_single_json_line(&output);
        assert_eq!(json["ok"], true);
        let classes = json["classes"].as_array().expect("classes array");
        assert_eq!(classes.len(), 2);
        assert_eq!(classes[0]["category"], "Audio Module Class");
        assert_eq!(classes[0]["descriptorApi"], expected_api);
        assert_eq!(classes[0]["cid"], "6E33225254224A00AA69301AF318797D");
        if level == "3" {
            assert_eq!(classes[0]["name"], "Gain Ω (Factory3 oracle)");
            assert_eq!(classes[0]["vendor"], "OrbitScore Factory Oracle");
        } else if level == "2" {
            assert_eq!(classes[0]["subCategories"], "Fx|Dynamics");
            assert_eq!(classes[0]["version"], "5.4.9");
        } else {
            assert_eq!(classes[0]["vendor"], "");
            assert_eq!(classes[0]["subCategories"], "");
        }
    }
}

/// Positive control for the non-reachability proof: the same abort-mode oracle is sent through
/// the existing deep probe, which intentionally calls createInstance. SIGABRT proves both that
/// the env reaches the loaded oracle and that its tripwire is alive.
#[test]
fn create_instance_tripwire_positive_control_dies_by_sigabrt() {
    let bundle = oracle_bundle();
    let output = Command::new(env::current_exe().expect("current integration-test executable"))
        .arg("--exact")
        .arg("create_instance_tripwire_child")
        .arg("--nocapture")
        .env(TRIPWIRE_CHILD_ENV, "1")
        .env(TRIPWIRE_BUNDLE_ENV, &bundle)
        .env(FACTORY_LEVEL_ENV, "3")
        .env(ABORT_CREATE_INSTANCE_ENV, "1")
        .output()
        .expect("spawn createInstance tripwire child");

    assert_eq!(
        output.status.signal(),
        Some(6),
        "positive-control child must die by SIGABRT; status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn probe_artifact_failure_has_a_typed_reason() {
    let output = Command::new(scanner())
        .arg("probe-artifact")
        .arg("/definitely/missing/NotAPlugin.vst3")
        .output()
        .expect("spawn failing artifact probe");
    assert!(!output.status.success());
    let json = parse_single_json_line(&output);
    assert_eq!(json["ok"], false);
    assert_eq!(json["error"]["kind"], "bundleLoad");
    assert!(json["error"]["message"].is_string());
}

/// Optional local smoke test for a commercial/installed bundle. It is excluded from normal
/// `cargo test` because the artifact is machine-specific.
#[test]
#[ignore = "needs ORBIT_REAL_VST3 pointing to an installed VST3 bundle (local only)"]
fn real_vst3_factory_probe_gated() {
    let bundle = env::var_os("ORBIT_REAL_VST3").expect("set ORBIT_REAL_VST3");
    let output = Command::new(scanner())
        .arg("probe-artifact")
        .arg(bundle)
        .output()
        .expect("spawn real VST3 factory probe");
    assert!(
        output.status.success(),
        "status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(parse_single_json_line(&output)["ok"], true);
}

/// B1 acceptance gate: run Kontakt through the parent scanner (not just the primitive child) and
/// prove the v2 compatibility projection exposes it to instrument completion. Factory-v1
/// fallback is deliberately allowed to produce both roles.
#[test]
#[ignore = "needs ORBIT_KONTAKT_VST3 pointing to an installed Kontakt VST3 bundle (local only)"]
fn kontakt_parent_rescan_catalogs_an_instrument_role() {
    use std::os::unix::fs::symlink;

    let kontakt = PathBuf::from(env::var_os("ORBIT_KONTAKT_VST3").expect("set ORBIT_KONTAKT_VST3"));
    let temp = tempfile::tempdir().expect("temporary isolated scan root");
    let link = temp.path().join("Kontakt.vst3");
    symlink(&kontakt, &link).expect("symlink Kontakt into isolated scan root");

    let outcome = orbit_plugin_scan::scan_all_with_probes(&[temp.path().to_path_buf()], scanner());
    let kontakt_entries = outcome
        .entries
        .iter()
        .filter(|entry| entry.path == link.to_string_lossy())
        .collect::<Vec<_>>();
    assert!(
        !kontakt_entries.is_empty(),
        "explicit parent rescan must project Kontakt into catalog.plugins; summary={:?}",
        outcome.summary
    );
    assert!(
        kontakt_entries
            .iter()
            .any(|entry| entry.roles.iter().any(|role| role == "instrument")),
        "Kontakt roles must contain instrument (instrument-only is not required): {kontakt_entries:?}"
    );
}
