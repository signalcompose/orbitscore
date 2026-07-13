//! γ M2 Stage 5: 同一 test synth の in-process / OOP event render が bit-exact に一致することを検証。
//!
//! 実 dylib を要するため `#[ignore]`。事前ビルド:
//!   cargo build --manifest-path rust-spike/clap-test-synth/Cargo.toml
//! 実行:
//!   cargo test -p orbit-clap-instrument-child --test instrument_parity_gated -- --ignored --nocapture

use std::path::{Path, PathBuf};

use orbit_audio_sandbox::offline::render_instrument_through_child_sync_with_options;
use orbit_audio_sandbox::{
    max_abs_diff, NeutralEvent, RenderOptions, VoiceAddr, CHANNELS, MAX_FRAMES,
};
use orbit_clap_host::{push_neutral_event, ClapInstrumentProcessor, EventBuffer};

const PLUGIN_ID: &str = "com.signalcompose.clap-test-synth";
const SAMPLE_RATE: u32 = 48_000;

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

fn voice(key: i16) -> VoiceAddr {
    VoiceAddr {
        note_id: -1,
        port_index: 0,
        channel: 0,
        key,
        _pad: 0,
    }
}

fn render_in_process(
    dylib: &Path,
    block_frames: usize,
    events_by_block: &[Vec<NeutralEvent>],
) -> Vec<f32> {
    let (mut instrument, _info) = ClapInstrumentProcessor::load(
        dylib,
        Some(PLUGIN_ID),
        SAMPLE_RATE,
        CHANNELS,
        MAX_FRAMES as u32,
    )
    .expect("load test synth (side A)");
    let mut out = Vec::with_capacity(events_by_block.len() * block_frames * CHANNELS);
    let mut event_buf: EventBuffer = Default::default();
    let mut output_event_buf: EventBuffer = Default::default();
    for events in events_by_block {
        event_buf.clear();
        for event in events {
            assert!(push_neutral_event(&mut event_buf, event));
        }
        let mut block = vec![0.0; block_frames * CHANNELS];
        assert!(instrument.process_block(&mut block, &event_buf, &mut output_event_buf));
        out.extend_from_slice(&block);
    }
    out
}

#[test]
#[ignore = "γ M2 Stage 5: needs a built clap-test-synth dylib (local only)"]
fn real_clap_instrument_oop_event_parity() {
    let dylib = repo_path("rust-spike/clap-test-synth/target/debug/libclap_test_synth.dylib");
    assert!(
        dylib.exists(),
        "test synth dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-synth/Cargo.toml` を実行",
        dylib.display()
    );
    let dylib_str = dylib.to_str().expect("dylib path is UTF-8");
    let child_exe = Path::new(env!("CARGO_BIN_EXE_orbit-clap-instrument-child"));
    let block_frames = 128;
    let key = 60;
    let events_by_block = vec![
        vec![NeutralEvent::NoteOn {
            sample_offset: 0,
            addr: voice(key),
            velocity: 1.0,
            tuning_cents: 0.0,
            length_frames: 0,
        }],
        vec![],
        vec![NeutralEvent::NoteOff {
            sample_offset: 0,
            addr: voice(key),
            velocity: 0.0,
        }],
        vec![],
    ];

    let side_a = render_in_process(&dylib, block_frames, &events_by_block);
    let (side_b, stats) = render_instrument_through_child_sync_with_options(
        child_exe,
        &[
            "--plugin",
            dylib_str,
            "--plugin-id",
            PLUGIN_ID,
            "--sample-rate",
            "48000",
        ],
        block_frames,
        &events_by_block,
        RenderOptions::default(),
    )
    .expect("render through OOP instrument child");

    assert_eq!(stats.processed, events_by_block.len() as u64);
    assert_eq!(stats.process_errors, 0);
    assert!(side_a.iter().any(|&sample| sample != 0.0));
    assert!(side_b.iter().any(|&sample| sample != 0.0));
    assert_eq!(max_abs_diff(&side_a, &side_b), 0.0);
}

/// `NeutralEvent::PolyPressure` has no CLAP translation (see `orbit-clap-host/src/events.rs`'s
/// `push_neutral_event`, which returns `false` for it). This exercises the OOP child's
/// `push_neutral_event(..) == false` branch (`orbit-clap-instrument-child/src/main.rs`), which
/// bumps `event_decode_error_count` rather than silently discarding the event. In practice this
/// branch is currently unreachable via the real host (`PipelinedInstrumentHost` only ever emits
/// NoteOn/NoteOff/NoteChoke), so this test injects the event directly through the offline driver.
#[test]
#[ignore = "γ M2 Stage 5: needs a built clap-test-synth dylib (local only)"]
fn real_clap_instrument_untranslatable_event_increments_error_count() {
    let dylib = repo_path("rust-spike/clap-test-synth/target/debug/libclap_test_synth.dylib");
    assert!(
        dylib.exists(),
        "test synth dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-synth/Cargo.toml` を実行",
        dylib.display()
    );
    let dylib_str = dylib.to_str().expect("dylib path is UTF-8");
    let child_exe = Path::new(env!("CARGO_BIN_EXE_orbit-clap-instrument-child"));
    let block_frames = 128;
    let events_by_block = vec![vec![NeutralEvent::PolyPressure {
        sample_offset: 0,
        addr: voice(60),
        pressure: 0.5,
    }]];

    let (_out, stats) = render_instrument_through_child_sync_with_options(
        child_exe,
        &[
            "--plugin",
            dylib_str,
            "--plugin-id",
            PLUGIN_ID,
            "--sample-rate",
            "48000",
        ],
        block_frames,
        &events_by_block,
        RenderOptions::default(),
    )
    .expect("render through OOP instrument child");

    assert_eq!(stats.processed, 1);
    assert_eq!(stats.process_errors, 0);
    assert_eq!(stats.event_decode_error_count, 1);
}
