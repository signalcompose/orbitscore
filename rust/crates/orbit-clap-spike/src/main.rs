//! S1 (Issue #293) CLAP hosting spike -- headless RT-integration harness.
//!
//! Design spec: docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md
//!
//! Usage:
//!   orbit-clap-spike --file-path <plugin.clap> [--plugin-id <id>]
//!                    [--measure-secs <N>] [--bpm <bpm>]
//!
//! Runs `--measure-secs` seconds of continuous NoteOn/NoteOff at `--bpm`,
//! then prints machine-readable stats and exits.

// Discovery and host loading require unsafe FFI.
#![allow(unsafe_code)]

mod audio;
mod buffers;
mod config;
mod discovery;
mod events;
mod host;
mod sink;

use crate::audio::{AudioThreadStats, InstallMsg, OrbitAudioProcessor};
use crate::buffers::HostAudioBuffers;
use crate::config::FullAudioConfig;
use crate::discovery::{FoundPlugin, list_plugins_in_file, load_plugin_id_from_path};
use crate::events::{PluginEvent, make_event_ring};
use crate::host::{MainThreadMessage, OrbitClapHost, OrbitHostMainThread, OrbitHostShared};
use crate::sink::{CountingSink, PostMixSink, RingTapSink};

use clack_extensions::note_ports::{NotePortInfoBuffer, PluginNotePorts};
use clack_host::prelude::*;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use orbit_audio_core::Engine;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

// ---- CLI ----------------------------------------------------------------

struct Cli {
    file_path: PathBuf,
    plugin_id: Option<String>,
    measure_secs: u64,
    bpm: f64,
    /// Force a fixed cpal buffer size (frames). Overrides negotiated default (1024).
    /// S1b-1: low-latency strict test (e.g. 128 / 256).
    buffer_frames: Option<u32>,
    /// S1b-2 dynamic hot-install: start the stream engine-only, then install the
    /// plugin into the RUNNING stream after this many seconds. 0 = static (S1 parity).
    hot_install_after_secs: u64,
}

fn parse_args() -> anyhow::Result<Cli> {
    let mut args = std::env::args().skip(1);
    let mut file_path: Option<PathBuf> = None;
    let mut plugin_id: Option<String> = None;
    let mut measure_secs: u64 = 10;
    let mut bpm: f64 = 120.0;
    let mut buffer_frames: Option<u32> = None;
    let mut hot_install_after_secs: u64 = 0;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--buffer-frames" => {
                buffer_frames = Some(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--buffer-frames requires a value"))?
                        .parse()?,
                );
            }
            "--hot-install-after-secs" => {
                hot_install_after_secs = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--hot-install-after-secs requires a value"))?
                    .parse()?;
            }
            "--file-path" | "-f" => {
                file_path = Some(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--file-path requires a value"))?
                        .into(),
                );
            }
            "--plugin-id" | "-p" => {
                plugin_id = Some(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--plugin-id requires a value"))?,
                );
            }
            "--measure-secs" => {
                measure_secs = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--measure-secs requires a value"))?
                    .parse()?;
            }
            "--bpm" => {
                bpm = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--bpm requires a value"))?
                    .parse()?;
            }
            other => anyhow::bail!("Unknown argument: {other}. Use --file-path <path.clap>"),
        }
    }

    Ok(Cli {
        file_path: file_path
            .ok_or_else(|| anyhow::anyhow!("--file-path is required"))?,
        plugin_id,
        measure_secs,
        bpm,
        buffer_frames,
        hot_install_after_secs,
    })
}

// ---- Entry point --------------------------------------------------------

fn main() -> anyhow::Result<()> {
    let cli = parse_args()?;
    run(&cli)
}

fn run(cli: &Cli) -> anyhow::Result<()> {
    // Usability guard: installing at/after the measurement ends means the driver finishes
    // sending notes before the plugin exists, so it would receive none (misleading 0 output).
    if cli.hot_install_after_secs > 0 && cli.hot_install_after_secs >= cli.measure_secs {
        eprintln!(
            "[orbit-clap-spike] WARN: --hot-install-after-secs ({}) >= --measure-secs ({}); plugin will receive no notes",
            cli.hot_install_after_secs, cli.measure_secs
        );
    }

    // --- Discover plugin --------------------------------------------------
    let found = select_plugin(&cli.file_path, cli.plugin_id.as_deref())?;
    println!(
        "Loading plugin: {} from {}",
        found.plugin,
        cli.file_path.display()
    );

    // --- Instantiate (main thread) ----------------------------------------
    let (sender, receiver) = mpsc::channel::<MainThreadMessage>();

    let plugin_id =
        std::ffi::CString::new(found.plugin.id.as_str())
            .map_err(|_| anyhow::anyhow!("plugin id contains null byte"))?;

    let host_info = HostInfo::new(
        "OrbitScore CLAP spike",
        "Signal compose",
        "https://github.com/signalcompose/orbitscore",
        env!("CARGO_PKG_VERSION"),
    )
    .expect("host info");

    let mut instance = PluginInstance::<OrbitClapHost>::new(
        |_| OrbitHostShared::new(sender.clone()),
        |shared| OrbitHostMainThread::new(shared),
        &found.entry,
        &plugin_id,
        &host_info,
    )
    .map_err(|e| anyhow::anyhow!("plugin instantiation failed: {e}"))?;

    // --- Query note port index (before activate) --------------------------
    let note_port_index = query_note_port_index(&mut instance);
    println!("Note port index: {note_port_index}");

    // --- CPAL device and config negotiation --------------------------------
    let cpal_host_api = cpal::default_host();
    let device = cpal_host_api
        .default_output_device()
        .ok_or_else(|| anyhow::anyhow!("no default output device"))?;

    let mut audio_config = FullAudioConfig::find_best_from(&device, &mut instance)?;
    // S1b-1: force a fixed buffer size for low-latency strict testing.
    // Setting min == max pins both the cpal Fixed() request and the CLAP activate window.
    if let Some(frames) = cli.buffer_frames {
        audio_config.min_buffer_size = frames;
        audio_config.max_likely_buffer_size = frames;
    }
    println!("Audio config: {audio_config}");

    let sample_rate = audio_config.sample_rate;
    let output_channel_count = audio_config.output_channel_count;
    let cpal_config = audio_config.as_cpal_stream_config();
    let clap_config = audio_config.as_clack_plugin_config();
    // Hold config + clap config until the (one-time) plugin install. Static mode
    // installs before the stream; hot-install hands these over while running.
    let mut pending_config = Some((audio_config, clap_config));

    // --- Sinks -----------------------------------------------------------
    let (counting_sink, counting_frames, counting_peak) = CountingSink::new();
    let ring_cap = (sample_rate as usize) * output_channel_count * 5; // 5 seconds
    let (ring_sink, _ring_consumer, ring_drops) = RingTapSink::new(ring_cap);
    let sink: Box<dyn PostMixSink> = Box::new(DualSink {
        a: counting_sink,
        b: ring_sink,
    });

    // --- Event ring -------------------------------------------------------
    let (event_producer, event_consumer) = make_event_ring(1024);

    // --- Install ring (control -> audio thread, S1b-2) -------------------
    let (mut install_tx, install_rx) = rtrb::RingBuffer::<InstallMsg>::new(1);

    // --- Build Engine (existing orbit-audio sample path) -----------------
    let engine = Engine::new(sample_rate, output_channel_count as u16);

    // --- Stats ------------------------------------------------------------
    let xrun_counter = Arc::new(AtomicU64::new(0));
    let stats = AudioThreadStats::new();

    // --- Audio processor (engine-only; plugin installed below) -----------
    let mut processor = OrbitAudioProcessor::new(
        engine,
        event_consumer,
        sink,
        stats.clone(),
        install_rx,
    );

    let hot_secs = cli.hot_install_after_secs;
    if hot_secs == 0 {
        // STATIC (S1 parity): activate + install synchronously before the stream.
        let (ac, cc) = pending_config.take().expect("config pending");
        let msg = build_install_msg(&mut instance, ac, cc, note_port_index, stats.clone())?;
        processor.install(msg);
        println!("Plugin installed (static, before stream).");
    } else {
        println!("Hot-install mode: stream starts engine-only; plugin installed at +{hot_secs}s.");
    }

    // --- Build cpal stream (F32 -- A0 deviation: F32-only) ----------------
    let xrun_ctr = xrun_counter.clone();
    let stream = device
        .build_output_stream(
            &cpal_config,
            move |data: &mut [f32], _info| processor.process(data),
            move |err| {
                eprintln!("[cpal err] {err}");
                xrun_ctr.fetch_add(1, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| anyhow::anyhow!("build_output_stream failed: {e}"))?;

    stream
        .play()
        .map_err(|e| anyhow::anyhow!("stream play failed: {e}"))?;

    // --- Driver thread: push NoteOn/NoteOff at --bpm ----------------------
    // PluginInstance is !Send, so it cannot be moved to a worker thread.
    // Driver runs in a background thread (sends events only via the rtrb ring).
    let measure_duration = Duration::from_secs(cli.measure_secs);
    let bpm = cli.bpm;
    let driver_thread = std::thread::spawn(move || {
        let quarter_note = Duration::from_secs_f64(60.0 / bpm);
        let note_on_dur = quarter_note / 2;
        let deadline = Instant::now() + measure_duration;
        let mut event_prod = event_producer;
        let mut beats: u32 = 0;

        loop {
            if Instant::now() >= deadline {
                break;
            }
            let beat_start = Instant::now();

            // push drop is safe here: the event rate (a few notes/sec) is far below the
            // 1024-slot ring capacity, so the ring never fills under the driver pattern.
            let _ = event_prod.push(PluginEvent::NoteOn {
                key: 60,
                channel: 0,
                velocity: 0.8,
            });

            let off_at = beat_start + note_on_dur;
            std::thread::sleep(off_at.saturating_duration_since(Instant::now()));

            let _ = event_prod.push(PluginEvent::NoteOff {
                key: 60,
                channel: 0,
                velocity: 0.0,
            });

            beats += 1;

            let next_beat = beat_start + quarter_note;
            let rem = next_beat.saturating_duration_since(Instant::now());
            if !rem.is_zero() {
                std::thread::sleep(rem);
            }
        }

        beats
    });

    // --- Main-thread pump (CLAP requirement: callbacks on main thread) ----
    // PluginInstance<OrbitClapHost> is !Send, so we pump here on main thread.
    let pump_deadline = Instant::now() + measure_duration + Duration::from_millis(200);
    if hot_secs > 0 {
        // Phase 1: engine-only for hot_secs (notes are discarded until install).
        pump_until(
            &mut instance,
            &receiver,
            Instant::now() + Duration::from_secs(hot_secs),
        );
        // Hot-install (S1b-2): activate + build buffers on the main thread, then hand
        // the started processor to the audio thread via the wait-free install ring.
        let (ac, cc) = pending_config.take().expect("config pending");
        let msg = build_install_msg(&mut instance, ac, cc, note_port_index, stats.clone())?;
        match install_tx.push(msg) {
            Ok(()) => println!("[hot-install] plugin handed to audio thread at +{hot_secs}s"),
            Err(_) => anyhow::bail!("install ring full — hot-install failed"),
        }
    }
    // Static: the full duration. Hot: phase 2 (remaining time with the plugin live).
    pump_until(&mut instance, &receiver, pump_deadline);

    // Wait for driver. A driver panic invalidates the measurement, so fail loudly rather
    // than silently reporting a normal-looking run with beats=0.
    let beats = match driver_thread.join() {
        Ok(b) => b,
        Err(_) => anyhow::bail!("driver thread panicked — measurement invalid"),
    };
    println!("Driver sent {beats} beats. Stopping stream...");

    // --- Stop stream (drop before deactivating instance) ------------------
    drop(stream); // stops cpal; audio processor (inside closure) is dropped here

    // Drop the sender to ensure receiver eventually disconnects
    drop(sender);

    // Drain remaining main-thread messages
    for msg in receiver.try_iter() {
        let MainThreadMessage::RunOnMainThread = msg;
        instance.call_on_main_thread_callback();
    }

    // instance dropped here -- plugin deactivated

    // --- Print stats -------------------------------------------------------
    let callbacks = stats.callback_count.load(Ordering::Relaxed);
    let xruns = xrun_counter.load(Ordering::Relaxed);
    let sink_frames = counting_frames.load(Ordering::Relaxed);
    let ring_drop_count = ring_drops.load(Ordering::Relaxed);
    let min_ns = stats.min_ns.load(Ordering::Relaxed);
    let max_ns = stats.max_ns.load(Ordering::Relaxed);
    let sum_ns = stats.sum_ns.load(Ordering::Relaxed);
    let resize_count = stats.buffer_resize_count.load(Ordering::Relaxed);
    let installed_at = stats.installed_at_callback.load(Ordering::Relaxed);
    let process_errors = stats.process_error_count.load(Ordering::Relaxed);
    // post-mix peak amplitude (abs). > 0 proves the plugin actually produced sound
    // (callbacks running != audible output).
    let post_mix_peak = f32::from_bits(counting_peak.load(Ordering::Relaxed));

    let mean_ns = if callbacks > 0 { sum_ns / callbacks } else { 0 };
    let p99_ns = stats.p99_ns().unwrap_or(0);

    // Approximate block budget from actual sink frames.
    let avg_frames_per_cb = if callbacks > 0 {
        sink_frames / callbacks / output_channel_count as u64
    } else {
        0
    };
    let block_budget_ns = avg_frames_per_cb * 1_000_000_000 / sample_rate as u64;

    println!();
    println!("=== orbit-clap-spike measurement results ===");
    println!("total_callbacks:      {callbacks}");
    println!("xruns:                {xruns}");
    println!("callback_min_ns:      {min_ns}");
    println!("callback_mean_ns:     {mean_ns}");
    println!("callback_p99_ns:      {p99_ns}");
    println!("callback_max_ns:      {max_ns}");
    println!("block_budget_ns:      ~{block_budget_ns}");
    println!("post_mix_peak:        {post_mix_peak:.5}");
    println!("sink_frames:          {sink_frames}");
    println!("ring_tap_drops:       {ring_drop_count}");
    println!("buffer_resize_count:  {resize_count}");
    println!("plugin_process_errors:{process_errors}");
    let install_str = if installed_at == u64::MAX {
        "(static / before stream)".to_string()
    } else {
        format!("callback #{installed_at}")
    };
    println!("plugin_installed_at:  {install_str}");
    println!("driver_beats_sent:    {beats}");
    println!("=============================================");

    Ok(())
}

// ---- Helpers ------------------------------------------------------------

fn select_plugin(path: &Path, id: Option<&str>) -> anyhow::Result<FoundPlugin> {
    match id {
        None => {
            let plugins = list_plugins_in_file(path)
                .map_err(|e| anyhow::anyhow!("Discovery error: {e}"))?;
            if plugins.is_empty() {
                anyhow::bail!("No plugins found in {}", path.display());
            }
            if plugins.len() > 1 {
                eprintln!("Multiple plugins in file:");
                for p in &plugins {
                    eprintln!("  {}", p.plugin);
                }
                eprintln!("Use --plugin-id to select one.");
                anyhow::bail!("Multiple plugins; specify --plugin-id");
            }
            Ok(plugins.into_iter().next().unwrap())
        }
        Some(id) => {
            let found = load_plugin_id_from_path(path, id)
                .map_err(|e| anyhow::anyhow!("Discovery error: {e}"))?;
            found.ok_or_else(|| anyhow::anyhow!("No plugin with id '{id}' in {}", path.display()))
        }
    }
}

/// Activate the plugin and assemble an [`InstallMsg`] (control thread).
///
/// `activate` + `start_processing` run on the main thread (CLAP requirement); the
/// resulting `StartedPluginAudioProcessor` is `Send` and can be handed to the audio
/// thread. Buffers are pre-allocated here so installing in the callback never allocs.
fn build_install_msg(
    instance: &mut PluginInstance<OrbitClapHost>,
    audio_config: FullAudioConfig,
    clap_config: PluginAudioConfiguration,
    note_port_index: u16,
    stats: std::sync::Arc<AudioThreadStats>,
) -> anyhow::Result<InstallMsg> {
    let plugin = instance
        .activate(|_, _| (), clap_config)
        .map_err(|e| anyhow::anyhow!("activate failed: {e}"))?
        .start_processing()
        .map_err(|e| anyhow::anyhow!("start_processing failed: {e}"))?;
    let buffers = HostAudioBuffers::from_config(audio_config, stats);
    Ok(InstallMsg {
        plugin,
        buffers,
        note_port_index,
    })
}

/// Pump main-thread CLAP callbacks until `deadline`.
fn pump_until(
    instance: &mut PluginInstance<OrbitClapHost>,
    receiver: &mpsc::Receiver<MainThreadMessage>,
    deadline: Instant,
) {
    loop {
        let timeout = deadline.saturating_duration_since(Instant::now());
        if timeout.is_zero() {
            break;
        }
        match receiver.recv_timeout(timeout.min(Duration::from_millis(10))) {
            Ok(MainThreadMessage::RunOnMainThread) => instance.call_on_main_thread_callback(),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() >= deadline {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // All senders dropped. Expected only at teardown; if it happens mid-run the
                // plugin stops getting main-thread callbacks, so surface it.
                eprintln!("[orbit-clap-spike] main-thread pump: sender disconnected");
                break;
            }
        }
    }
}

/// Query main note port index; fallback to 0 if plugin lacks the extension.
///
/// Searches all note input ports for CLAP or MIDI dialect support and returns
/// the index of the first matching port.
fn query_note_port_index(instance: &mut PluginInstance<OrbitClapHost>) -> u16 {
    let mut handle = instance.plugin_handle();
    let Some(note_ports) = handle.get_extension::<PluginNotePorts>() else {
        eprintln!("Plugin has no NotePortsExtension; using port 0");
        return 0;
    };

    let mut buf = NotePortInfoBuffer::new();
    let count = note_ports.count(&mut handle, true);

    for i in 0..count.min(u16::MAX as u32) {
        let Some(info) = note_ports.get(&mut handle, i, true, &mut buf) else {
            continue;
        };

        use clack_extensions::note_ports::NoteDialects;
        if info
            .supported_dialects
            .intersects(NoteDialects::CLAP | NoteDialects::MIDI)
        {
            return i as u16;
        }
    }

    0
}

// ---- DualSink -----------------------------------------------------------

/// Runs two PostMixSink implementations in sequence (for RT-safety proof).
/// Both CountingSink and RingTapSink are no-alloc / no-lock -- this struct is too.
///
/// Both inner types are Send (Arc atomics + rtrb::Producer<f32>), so DualSink
/// is auto-Send via the `PostMixSink: Send` supertrait -- no unsafe impl needed.
struct DualSink {
    a: CountingSink,
    b: RingTapSink,
}

impl PostMixSink for DualSink {
    fn commit(&mut self, post_mix: &[f32]) {
        self.a.commit(post_mix);
        self.b.commit(post_mix);
    }
}
