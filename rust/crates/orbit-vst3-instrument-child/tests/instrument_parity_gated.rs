//! 同一 VST3 synth oracle の in-process / OOP event render が bit-exact に一致することを検証。
//!
//! 実 bundle を要するため `#[ignore]`。事前ビルド:
//!   crates/orbit-vst3-synth-oracle/package-oracle.sh
//! 実行:
//!   cargo test -p orbit-vst3-instrument-child --test instrument_parity_gated -- --ignored --nocapture

#![cfg(target_os = "macos")]

use std::path::Path;

use orbit_audio_sandbox::offline::render_instrument_through_child_sync_with_options;
use orbit_audio_sandbox::{
    max_abs_diff, NeutralEvent, RenderOptions, VoiceAddr, CHANNELS, MAX_FRAMES,
};
use orbit_vst3_host::Vst3InstrumentProcessor;

const SAMPLE_RATE: f64 = 48_000.0;

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
    bundle: &Path,
    block_frames: usize,
    events_by_block: &[Vec<NeutralEvent>],
) -> Vec<f32> {
    let (mut instrument, info) =
        Vst3InstrumentProcessor::load(bundle, SAMPLE_RATE, MAX_FRAMES as i32, None)
            .expect("load VST3 synth oracle (side A)");
    assert!(!info.is_effect, "oracle must be detected as an instrument");

    let mut out = Vec::with_capacity(events_by_block.len() * block_frames * CHANNELS);
    for events in events_by_block {
        for event in events {
            // This is the in-process equivalent of the OOP child's NeutralEvent translation:
            // sample_offset maps unchanged to the VST3 i32 offset, addr.channel to channel,
            // addr.key to pitch, and the same f64 velocity is narrowed to f32 on both sides.
            match *event {
                NeutralEvent::NoteOn {
                    sample_offset,
                    addr,
                    velocity,
                    ..
                } => instrument.push_note_on(
                    addr.channel,
                    addr.key,
                    velocity as f32,
                    i32::try_from(sample_offset).expect("sample offset fits VST3 i32"),
                ),
                NeutralEvent::NoteOff {
                    sample_offset,
                    addr,
                    velocity,
                } => instrument.push_note_off(
                    addr.channel,
                    addr.key,
                    velocity as f32,
                    i32::try_from(sample_offset).expect("sample offset fits VST3 i32"),
                ),
                other => panic!("unsupported parity event: {other:?}"),
            }
        }
        let mut block = vec![0.0; block_frames * CHANNELS];
        assert!(instrument.process_block(&mut block));
        out.extend_from_slice(&block);
    }
    out
}

#[test]
#[ignore = "needs a freshly packaged VST3 synth oracle bundle (local only)"]
fn real_vst3_instrument_oop_event_parity() {
    let Some(bundle) = orbit_vst3_synth_oracle::package_bundle() else {
        panic!(
            "VST3 synth oracle bundle が用意できない — 先に \
             `crates/orbit-vst3-synth-oracle/package-oracle.sh` を実行し、\
             `package_bundle()` が stderr に出力した失敗の詳細も確認"
        );
    };
    let bundle_str = bundle.to_str().expect("bundle path is UTF-8");
    let child_exe = Path::new(env!("CARGO_BIN_EXE_orbit-vst3-instrument-child"));
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

    let side_a = render_in_process(&bundle, block_frames, &events_by_block);
    let (side_b, stats) = render_instrument_through_child_sync_with_options(
        child_exe,
        &["--plugin", bundle_str, "--sample-rate", "48000"],
        block_frames,
        &events_by_block,
        RenderOptions::default(),
    )
    .expect("render through OOP VST3 instrument child");

    assert_eq!(stats.processed, events_by_block.len() as u64);
    assert_eq!(stats.process_errors, 0);
    assert!(side_a.iter().any(|&sample| sample != 0.0));
    assert!(side_b.iter().any(|&sample| sample != 0.0));
    assert_eq!(max_abs_diff(&side_a, &side_b), 0.0);
}
