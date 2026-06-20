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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use clack_extensions::audio_ports::{
    AudioPortFlags, AudioPortInfo, AudioPortInfoWriter, AudioPortType, PluginAudioPorts,
    PluginAudioPortsImpl,
};
use clack_extensions::note_ports::{
    NoteDialect, NoteDialects, NotePortInfo, NotePortInfoWriter, PluginNotePorts,
    PluginNotePortsImpl,
};
use clack_plugin::events::spaces::CoreEventSpace;
use clack_plugin::prelude::*;

// ──────────────────────────────────────────────────────────
// Top-level plugin type
// ──────────────────────────────────────────────────────────

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
            .register::<PluginNotePorts>();
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
        _shared: &'a Self::Shared<'a>,
    ) -> Result<Self::MainThread<'a>, PluginError> {
        Ok(TestSynthMainThread)
    }
}

// ──────────────────────────────────────────────────────────
// Shared state (accessed from any thread)
// ──────────────────────────────────────────────────────────

pub struct TestSynthShared {
    misbehave: bool,
    armed: Arc<AtomicBool>,
    contention: Arc<Mutex<()>>,
}

impl PluginShared<'_> for TestSynthShared {}

// ──────────────────────────────────────────────────────────
// Main-thread data
// ──────────────────────────────────────────────────────────

pub struct TestSynthMainThread;

impl PluginMainThread<'_, TestSynthShared> for TestSynthMainThread {}

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

    fn note_on(&mut self, key: u8, sample_rate: f32) {
        self.key = key;
        let freq = 440.0 * 2.0f32.powf((key as f32 - 69.0) / 12.0);
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
                                self.voice.note_on(key as u8, self.sample_rate);
                                // arm the bad-mode violations after first note-on
                                if self.shared.misbehave {
                                    self.shared.armed.store(true, Ordering::Release);
                                }
                            }
                        }
                        CoreEventSpace::NoteOff(e) => {
                            if let clack_plugin::events::Match::Specific(key) = e.key() {
                                self.voice.note_off(key as u8);
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
