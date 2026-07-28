//! clap-test-synth — minimal CLAP instrument plugin for S1 RT-safety spike (Issue #293).
//!
//! ## Modes
//! - **good** (default, `CLAP_TEST_SYNTH_MISBEHAVE` unset or empty):
//!   `process()` is RT-safe — no allocations, no locks, no syscalls.
//! - **bad** (`CLAP_TEST_SYNTH_MISBEHAVE=1`):
//!   After the first note-on, every `process()` call:
//!   1. allocates 4 MB on the heap (`vec![0.0f32; 1_000_000]`)
//!   2. acquires a `Mutex` that a background thread holds for ~50 ms
//!   This intentionally provokes xruns so the host's RT-violation detector can fire.
//!
//! ## Audio
//! Sine-wave oscillator, monophonic (last-note priority). Output is stereo (L = R).
//!
//! ## CLAP ID
//! `com.signalcompose.clap-test-synth`

use std::f32::consts::TAU;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};

use clack_extensions::audio_ports::{
    AudioPortFlags, AudioPortInfo, AudioPortInfoWriter, AudioPortType, PluginAudioPorts,
    PluginAudioPortsImpl,
};
// clack_common は直接依存に無い。clack_plugin が `pub use clack_common::stream;` で
// 再エクスポートしているのでそちら経由で取る。
use clack_extensions::state::{PluginState, PluginStateImpl};
use clack_plugin::stream::{InputStream, OutputStream};
// `Read`/`Write` は std::io の trait 実装として提供される（clack_common::stream）。
use std::io::{Read as _, Write as _};
use clack_extensions::note_ports::{
    NoteDialect, NoteDialects, NotePortInfo, NotePortInfoWriter, PluginNotePorts,
    PluginNotePortsImpl,
};
use clack_plugin::events::event_types::NoteEndEvent;
use clack_plugin::events::spaces::CoreEventSpace;
use clack_plugin::prelude::*;

// ──────────────────────────────────────────────────────────
// Top-level plugin type
// ──────────────────────────────────────────────────────────


/// #557: **state = 半音単位のピッチオフセット**（VST3 oracle `orbit-vst3-synth-oracle` と同一意味論）。
///
/// 形式が違っても**利用者から見た挙動は同じ**でなければならない（Epic #546 の中核制約）。
/// したがって式・エンコード・観測方法まで VST3 側と揃える。
pub const STATE_MAGIC: u32 = 0x4F52_4331; // "ORC1"
/// state バイト列の長さ（magic u32 + offset i32・リトルエンディアン）。
pub const STATE_LEN: usize = 8;

/// ノート番号とピッチオフセットから発音周波数を求める（**仕様の式・単一の真実**）。
pub fn voice_frequency_hz(key: u8, semitone_offset: i32) -> f32 {
    440.0 * 2.0f32.powf((key as f32 + semitone_offset as f32 - 69.0) / 12.0)
}

/// state バイト列を組み立てる。
pub fn encode_state(semitone_offset: i32) -> [u8; STATE_LEN] {
    let mut out = [0u8; STATE_LEN];
    out[0..4].copy_from_slice(&STATE_MAGIC.to_le_bytes());
    out[4..8].copy_from_slice(&semitone_offset.to_le_bytes());
    out
}

/// state バイト列を解釈する。magic 不一致・長さ不足は `None`（**黙って 0 に倒さない**）。
pub fn decode_state(bytes: &[u8]) -> Option<i32> {
    if bytes.len() < STATE_LEN {
        return None;
    }
    let magic = u32::from_le_bytes(bytes[0..4].try_into().ok()?);
    if magic != STATE_MAGIC {
        return None;
    }
    Some(i32::from_le_bytes(bytes[4..8].try_into().ok()?))
}

pub struct TestSynth;

impl Plugin for TestSynth {
    type AudioProcessor<'a> = TestSynthAudioProcessor<'a>;
    type Shared<'a> = TestSynthShared;
    type MainThread<'a> = TestSynthMainThread;

    fn declare_extensions(
        builder: &mut PluginExtensions<Self>,
        _shared: Option<&TestSynthShared>,
    ) {
        builder
            .register::<PluginAudioPorts>()
            .register::<PluginNotePorts>()
            // #557: VST3 oracle と対称の state 意味論。
            .register::<PluginState>();
    }
}

impl DefaultPluginFactory for TestSynth {
    fn get_descriptor() -> PluginDescriptor {
        use clack_plugin::plugin::features::*;
        PluginDescriptor::new("com.signalcompose.clap-test-synth", "CLAP Test Synth")
            .with_features([SYNTHESIZER, STEREO, INSTRUMENT])
    }

    fn new_shared(_host: HostSharedHandle<'_>) -> Result<Self::Shared<'_>, PluginError> {
        // Inspect env-var once at instantiation time.
        let misbehave = std::env::var("CLAP_TEST_SYNTH_MISBEHAVE")
            .map(|v| v == "1")
            .unwrap_or(false);

        let shared = TestSynthShared {
            // #557: main thread（state 拡張）が書き、audio thread の note_on が読む。
            semitone_offset: Arc::new(AtomicI32::new(0)),
            misbehave,
            // armed = true once first note-on has been seen (only relevant in bad mode)
            armed: Arc::new(AtomicBool::new(false)),
            // The contention mutex — bad mode spawns a background thread that holds it ~50 ms.
            contention: Arc::new(Mutex::new(())),
        };

        if misbehave {
            // Spawn the background thread that cycles lock → sleep 50 ms → unlock.
            // This creates real Mutex contention for bad-mode process().
            let armed = Arc::clone(&shared.armed);
            let mutex = Arc::clone(&shared.contention);
            std::thread::Builder::new()
                .name("clap-test-synth-badmode-contender".to_owned())
                .spawn(move || {
                    loop {
                        // Only start contending after the first note-on has been seen.
                        if armed.load(Ordering::Acquire) {
                            let _guard = mutex.lock().unwrap();
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        } else {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                    }
                })
                .expect("spawn bad-mode contender thread");
        }

        Ok(shared)
    }

    fn new_main_thread<'a>(
        _host: HostMainThreadHandle<'a>,
        shared: &'a Self::Shared<'a>,
    ) -> Result<Self::MainThread<'a>, PluginError> {
        Ok(TestSynthMainThread {
            semitone_offset: Arc::clone(&shared.semitone_offset),
        })
    }
}

// ──────────────────────────────────────────────────────────
// Shared state (accessed from any thread)
// ──────────────────────────────────────────────────────────

pub struct TestSynthShared {
    /// #557: `PluginStateImpl` が往復させる観測可能な state（半音オフセット）。
    /// main thread が書き、audio thread の `note_on` が読む。
    semitone_offset: Arc<AtomicI32>,
    misbehave: bool,
    armed: Arc<AtomicBool>,
    contention: Arc<Mutex<()>>,
}

impl PluginShared<'_> for TestSynthShared {}

// ──────────────────────────────────────────────────────────
// Main-thread data
// ──────────────────────────────────────────────────────────

pub struct TestSynthMainThread {
    /// #557: `Shared` と同じ atomic を指す（main thread が書き audio thread が読む）。
    semitone_offset: Arc<AtomicI32>,
}

impl PluginMainThread<'_, TestSynthShared> for TestSynthMainThread {}

/// #557: CLAP の state 拡張。**VST3 oracle と同じ意味論**（半音オフセット・同じエンコード）。
///
/// 不正な payload は `Err` を返して**黙って 0 に倒さない** — 復元したつもりで別の音になると
/// ループ検証が意味を失う（VST3 側 `setState` と同じ規律）。
impl PluginStateImpl for TestSynthMainThread {
    fn save(&mut self, output: &mut OutputStream) -> Result<(), PluginError> {
        let bytes = encode_state(self.semitone_offset.load(Ordering::Relaxed));
        output.write_all(&bytes).map_err(|_| PluginError::Message(
            "clap-test-synth: failed to write state",
        ))
    }

    fn load(&mut self, input: &mut InputStream) -> Result<(), PluginError> {
        let mut buffer = Vec::new();
        input.read_to_end(&mut buffer).map_err(|_| PluginError::Message(
            "clap-test-synth: failed to read state",
        ))?;
        match decode_state(&buffer) {
            Some(offset) => {
                self.semitone_offset.store(offset, Ordering::Relaxed);
                Ok(())
            }
            None => Err(PluginError::Message(
                "clap-test-synth: state payload is not a valid ORC1 chunk",
            )),
        }
    }
}

// Audio-ports extension (main thread)
impl PluginAudioPortsImpl for TestSynthMainThread {
    fn count(&mut self, is_input: bool) -> u32 {
        // instrument: 0 audio inputs, 1 stereo audio output
        if is_input { 0 } else { 1 }
    }

    fn get(&mut self, index: u32, is_input: bool, writer: &mut AudioPortInfoWriter) {
        if !is_input && index == 0 {
            writer.set(&AudioPortInfo {
                id: ClapId::new(1),
                name: b"main",
                channel_count: 2,
                flags: AudioPortFlags::IS_MAIN,
                port_type: Some(AudioPortType::STEREO),
                in_place_pair: None,
            });
        }
    }
}

// Note-ports extension (main thread)
impl PluginNotePortsImpl for TestSynthMainThread {
    fn count(&mut self, is_input: bool) -> u32 {
        if is_input { 1 } else { 0 }
    }

    fn get(&mut self, index: u32, is_input: bool, writer: &mut NotePortInfoWriter) {
        if is_input && index == 0 {
            // Only CLAP dialect — process() only matches CoreEventSpace::NoteOn/NoteOff
            // (CLAP dialect). MIDI dialect events arrive as CoreEventSpace::Midi and would
            // fall through unhandled, causing silence. Advertising only CLAP avoids that.
            writer.set(&NotePortInfo {
                id: ClapId::new(1),
                name: b"main",
                preferred_dialect: Some(NoteDialect::Clap),
                supported_dialects: NoteDialects::CLAP,
            });
        }
    }
}

// ──────────────────────────────────────────────────────────
// Audio processor (audio thread)
// ──────────────────────────────────────────────────────────

/// Simple monophonic sine oscillator.
struct SineVoice {
    /// Phase accumulator in [0, TAU)
    phase: f32,
    /// Per-sample phase increment
    phase_inc: f32,
    /// true = note is active
    active: bool,
    /// MIDI key currently playing (0–127)
    key: u8,
}

impl SineVoice {
    fn new() -> Self {
        Self {
            phase: 0.0,
            phase_inc: 0.0,
            active: false,
            key: 69,
        }
    }

    fn note_on(&mut self, key: u8, sample_rate: f32, semitone_offset: i32) {
        self.key = key;
        let freq = voice_frequency_hz(key, semitone_offset);
        self.phase_inc = TAU * freq / sample_rate;
        self.phase = 0.0;
        self.active = true;
    }

    fn note_off(&mut self, key: u8) {
        if self.active && self.key == key {
            self.active = false;
        }
    }

    /// Fill the buffer with the next samples. Returns immediately if inactive.
    fn generate(&mut self, buf: &mut [f32]) {
        if !self.active {
            buf.fill(0.0);
            return;
        }
        for s in buf.iter_mut() {
            *s = self.phase.sin() * 0.25; // 0.25 amplitude to avoid clipping
            self.phase += self.phase_inc;
            if self.phase >= TAU {
                self.phase -= TAU;
            }
        }
    }
}

pub struct TestSynthAudioProcessor<'a> {
    voice: SineVoice,
    sample_rate: f32,
    shared: &'a TestSynthShared,
}

impl<'a> PluginAudioProcessor<'a, TestSynthShared, TestSynthMainThread>
    for TestSynthAudioProcessor<'a>
{
    fn activate(
        _host: HostAudioProcessorHandle<'a>,
        _main_thread: &mut TestSynthMainThread,
        shared: &'a TestSynthShared,
        audio_config: PluginAudioConfiguration,
    ) -> Result<Self, PluginError> {
        Ok(Self {
            voice: SineVoice::new(),
            sample_rate: audio_config.sample_rate as f32,
            shared,
        })
    }

    fn process(
        &mut self,
        _process: Process,
        mut audio: Audio,
        events: Events,
    ) -> Result<ProcessStatus, PluginError> {
        // ── bad mode: intentional RT violations ────────────────────────────
        if self.shared.misbehave && self.shared.armed.load(Ordering::Acquire) {
            // 1. Heap allocation (~4 MB) — forbidden on RT thread
            let _sink = vec![0.0f32; 1_000_000];
            // 2. Acquire mutex that background thread holds for ~50 ms — blocks RT thread
            let _guard = self.shared.contention.lock().unwrap();
        }
        // ── end bad mode ───────────────────────────────────────────────────

        // Get the stereo output port
        let mut output_port = audio
            .output_port(0)
            .ok_or(PluginError::Message("no output port"))?;

        let mut output_channels = output_port
            .channels()?
            .into_f32()
            .ok_or(PluginError::Message("expected f32 output"))?;

        let channel_count = output_channels.channel_count();
        if channel_count == 0 {
            return Ok(ProcessStatus::Sleep);
        }

        // Process events in batches, then generate audio for each batch
        // We work on a temporary buf of the right frame size, then copy to all channels.
        for event_batch in events.input.batch() {
            // Handle note events
            for event in event_batch.events() {
                if let Some(core_event) = event.as_core_event() {
                    match core_event {
                        CoreEventSpace::NoteOn(e) => {
                            if let clack_plugin::events::Match::Specific(key) = e.key() {
                                self.voice.note_on(
                                    key as u8,
                                    self.sample_rate,
                                    self.shared.semitone_offset.load(Ordering::Relaxed),
                                );
                                // arm the bad-mode violations after first note-on
                                if self.shared.misbehave {
                                    self.shared.armed.store(true, Ordering::Release);
                                }
                            }
                        }
                        CoreEventSpace::NoteOff(e) => {
                            if let clack_plugin::events::Match::Specific(key) = e.key() {
                                self.voice.note_off(key as u8);
                                // Report the voice lifetime end back to the host. Preserve the
                                // host-provided PCKN so its bookkeeping can match this NoteEnd to
                                // the corresponding NoteOn across the OOP transport.
                                //
                                // `try_push`'s `Result` is intentionally discarded: the concrete
                                // buffer wired in here (clack_host's `EventBuffer`) is Vec-backed,
                                // so `try_push` always returns `Ok`. This is a test-fixture crate
                                // (not the production child), so adding drop-counting machinery
                                // for an unreachable-today failure would be disproportionate --
                                // but if this ever gets rewired to a bounded buffer, this call
                                // must stop silently discarding the error.
                                let _ = events
                                    .output
                                    .try_push(NoteEndEvent::new(e.time(), e.pckn()));
                            }
                        }
                        _ => {}
                    }
                }
            }

            // Generate audio into channel 0
            let bounds = event_batch.sample_bounds();
            let buf0 = output_channels
                .channel_mut(0)
                .ok_or(PluginError::Message("no channel 0"))?;
            self.voice.generate(&mut buf0[bounds.clone()]);

            // Copy channel 0 into the rest (L=R for stereo)
            if channel_count > 1 {
                let (first, rest) = output_channels.split_at_mut(1);
                let src = first.channel(0).unwrap();
                for ch in rest {
                    ch[bounds.clone()].copy_from_slice(&src[bounds.clone()]);
                }
            }
        }

        if self.voice.active {
            Ok(ProcessStatus::Continue)
        } else {
            Ok(ProcessStatus::Sleep)
        }
    }

    fn stop_processing(&mut self) {
        self.voice.active = false;
    }
}

// ──────────────────────────────────────────────────────────
// Entry point — exports the `clap_entry` symbol
// ──────────────────────────────────────────────────────────

clack_export_entry!(SinglePluginEntry<TestSynth>);

#[cfg(test)]
mod tests {
    use super::*;

    /// state バイト列が往復すること（`clap_plugin_state` の save → load の中身）。
    /// **VST3 oracle の同名テストと同じ意味論**であることが、形式中立の前提になる。
    #[test]
    fn state_round_trips_through_encoding() {
        for offset in [-24, -1, 0, 1, 7, 24] {
            let bytes = encode_state(offset);
            assert_eq!(bytes.len(), STATE_LEN);
            assert_eq!(
                decode_state(&bytes),
                Some(offset),
                "encode → decode で {offset} が保存されない"
            );
        }
    }

    /// 🔴 不正な state を **黙って 0 に倒さない**（復元したつもりで別の音になるのを防ぐ）。
    #[test]
    fn state_rejects_foreign_and_short_payloads() {
        let mut wrong_magic = encode_state(7);
        wrong_magic[0] ^= 0xFF;
        assert_eq!(decode_state(&wrong_magic), None, "magic 不一致を受理した");

        let short = &encode_state(7)[..STATE_LEN - 1];
        assert_eq!(decode_state(short), None, "長さ不足を受理した");

        assert_eq!(decode_state(&[]), None, "空を受理した");
    }

    /// 🔴 **VST3 oracle と同じエンコードであること**を固定する。
    ///
    /// 両 oracle が同じ magic・同じ長さ・同じバイト並びを使うからこそ、
    /// 「VST3 と CLAP で同じ E2E が green」という受け入れ基準が意味を持つ。
    /// 片方だけエンコードを変えたら、この期待値が red になって気づける。
    #[test]
    fn state_encoding_matches_the_cross_format_contract() {
        assert_eq!(STATE_MAGIC, 0x4F52_4331, "magic は \"ORC1\"");
        assert_eq!(STATE_LEN, 8, "magic 4 バイト + i32 4 バイト");

        let bytes = encode_state(7);
        assert_eq!(
            &bytes[..4],
            &STATE_MAGIC.to_le_bytes(),
            "先頭 4 バイトが little-endian の magic でない"
        );
        assert_eq!(
            &bytes[4..8],
            &7i32.to_le_bytes(),
            "後半 4 バイトが little-endian の i32 オフセットでない"
        );
    }

    /// 期待値は**仕様の式**から導出する（実装が出した値と付き合わせない）。
    #[test]
    fn offset_shifts_pitch_by_semitones() {
        let base = voice_frequency_hz(69, 0);
        assert!(
            (base - 440.0).abs() < 1e-3,
            "A4 (key 69・offset 0) は 440Hz のはず: {base}"
        );

        let octave_up = voice_frequency_hz(69, 12);
        assert!(
            (octave_up / base - 2.0).abs() < 1e-4,
            "+12 半音で 2 倍にならない: {octave_up} / {base}"
        );

        // オフセットは key と等価に効く（key+n と offset+n が同じ音）。
        for (key, offset) in [(60u8, 7i32), (72, -5), (69, 3)] {
            let via_offset = voice_frequency_hz(key, offset);
            let via_key = voice_frequency_hz((key as i32 + offset) as u8, 0);
            assert!(
                (via_offset - via_key).abs() < 1e-3,
                "key={key} offset={offset}: オフセットが key と等価に効いていない"
            );
        }
    }

    /// 🔴 配線: `note_on` が **実際に** オフセットを使って phase_inc を決めること。
    /// 純関数（`voice_frequency_hz`）のテストだけでは、`note_on` がそれを無視していても green になる。
    #[test]
    fn note_on_applies_state_offset_to_phase_increment() {
        let sample_rate = 48_000.0f32;
        let mut plain = SineVoice::new();
        let mut shifted = SineVoice::new();

        plain.note_on(69, sample_rate, 0);
        shifted.note_on(69, sample_rate, 12);

        let expected_plain = TAU * voice_frequency_hz(69, 0) / sample_rate;
        let expected_shifted = TAU * voice_frequency_hz(69, 12) / sample_rate;
        assert!(
            (plain.phase_inc - expected_plain).abs() < 1e-6,
            "offset 0 の phase_inc が仕様式と一致しない"
        );
        assert!(
            (shifted.phase_inc - expected_shifted).abs() < 1e-6,
            "offset 12 の phase_inc が仕様式と一致しない"
        );
        assert!(
            (shifted.phase_inc / plain.phase_inc - 2.0).abs() < 1e-4,
            "offset がヴォイスに反映されていない（phase_inc が変わらない）"
        );
    }
}
