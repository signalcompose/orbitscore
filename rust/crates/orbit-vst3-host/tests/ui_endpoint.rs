#![cfg(target_os = "macos")]

use std::ffi::c_void;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

use orbit_child_ui::{PluginUiEndpoint, UiSize};
use orbit_vst3_host::{Vst3EffectProcessor, Vst3UiEndpoint};
use orbit_vst3_synth_oracle::{
    create_ui_test_controller, lock_ui_scenario, reset_ui_trace, set_resize_during_attach, ui_trace,
};

const INITIAL_SIZE: UiSize = UiSize {
    width: 400,
    height: 300,
};
const ATTACH_RESIZE: UiSize = UiSize {
    width: 640,
    height: 480,
};

fn dummy_parent() -> *mut c_void {
    std::ptr::dangling_mut::<c_void>()
}

fn endpoint(resize_during_attach: bool) -> Vst3UiEndpoint {
    reset_ui_trace();
    set_resize_during_attach(resize_during_attach);
    Vst3UiEndpoint::from_controller(create_ui_test_controller())
}

#[test]
fn synth_oracle_open_calls_the_required_vst3_sequence() {
    let _scenario = lock_ui_scenario();
    let mut endpoint = endpoint(false);

    assert_eq!(endpoint.begin_open(), Ok(INITIAL_SIZE));
    assert!(endpoint.can_resize());
    endpoint.attach(dummy_parent()).expect("attach oracle view");

    let trace = ui_trace();
    assert_eq!(
        trace,
        [
            "createView",
            "isPlatformTypeSupported",
            "setFrame",
            "canResize",
            "getSize",
            "attached",
        ],
        "the complete VST3 open trace must retain its exact order"
    );
    let normative_calls = trace
        .iter()
        .filter(|call| call.as_str() != "canResize")
        .map(String::as_str)
        .collect::<Vec<_>>();
    assert_eq!(
        normative_calls,
        [
            "createView",
            "isPlatformTypeSupported",
            "setFrame",
            "getSize",
            "attached",
        ],
        "UIH.4's normative sequence must be exact"
    );

    endpoint.release(false);
}

#[test]
fn resize_requested_inside_attached_is_recorded_and_answered_with_on_size() {
    let _scenario = lock_ui_scenario();
    let mut endpoint = endpoint(true);

    assert_eq!(endpoint.begin_open(), Ok(INITIAL_SIZE));
    endpoint
        .attach(dummy_parent())
        .expect("attach-time resize must be answered");

    assert_eq!(endpoint.requested_size(), Some(ATTACH_RESIZE));
    assert_eq!(
        ui_trace(),
        [
            "createView",
            "isPlatformTypeSupported",
            "setFrame",
            "canResize",
            "getSize",
            "attached",
            "resizeView",
            "onSize",
        ],
        "resizeView must synchronously reach onSize in the attached callstack"
    );

    endpoint.release(false);
}

#[test]
fn close_calls_removed_once_before_releasing_the_view() {
    let _scenario = lock_ui_scenario();
    let mut endpoint = endpoint(false);
    endpoint.begin_open().expect("open oracle view");
    endpoint.attach(dummy_parent()).expect("attach oracle view");
    reset_ui_trace();

    endpoint.release(false);

    assert_eq!(
        ui_trace(),
        ["removed", "viewDropped"],
        "removed must occur exactly once before the editor COM object is released"
    );
}

#[test]
fn host_resize_calls_the_open_view_on_size() {
    let _scenario = lock_ui_scenario();
    let mut endpoint = endpoint(false);
    endpoint.begin_open().expect("open oracle view");
    endpoint.attach(dummy_parent()).expect("attach oracle view");
    reset_ui_trace();

    endpoint
        .apply_host_resize(UiSize {
            width: 512,
            height: 384,
        })
        .expect("host resize");

    assert_eq!(ui_trace(), ["onSize"]);
    endpoint.release(false);
}

#[test]
fn gain_oracle_without_an_editor_fails_loudly_with_detail() {
    let bundle = gain_oracle_bundle();
    let (processor, _) = Vst3EffectProcessor::load(&bundle, 48_000.0, 512, None)
        .unwrap_or_else(|error| panic!("failed to load gain oracle {}: {error}", bundle.display()));
    let (audio, mut main) = processor.split();

    let detail = main
        .begin_open()
        .expect_err("a null createView result must not fall back or succeed");
    assert!(
        detail.contains("createView") && detail.contains("returned null"),
        "failure detail must identify the null editor view: {detail}"
    );

    // Preserve the production split teardown contract: audio stops before main terminates.
    drop(audio);
    drop(main);
}

fn gain_oracle_bundle() -> PathBuf {
    static BUNDLE: OnceLock<PathBuf> = OnceLock::new();
    BUNDLE
        .get_or_init(|| {
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("host crate has a parent")
                .join("orbit-vst3-gain-oracle")
                .join("package-oracle.sh");
            let output = Command::new(&script)
                .output()
                .unwrap_or_else(|error| panic!("failed to run {}: {error}", script.display()));
            assert!(
                output.status.success(),
                "gain oracle packaging failed: status={} stderr={}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            );
            PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
        })
        .clone()
}
