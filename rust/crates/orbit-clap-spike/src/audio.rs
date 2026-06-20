//! Audio-thread integration: Engine + CLAP plugin + rtrb seam + PostMixSink (A0 §4.1).

use crate::buffers::HostAudioBuffers;
use crate::events::{PluginEventConsumer, drain_to_event_buffer};
use crate::host::OrbitClapHost;
use crate::sink::PostMixSink;

use clack_host::events::io::EventBuffer;
use clack_host::prelude::{OutputEvents, StartedPluginAudioProcessor};
use orbit_audio_core::Engine;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

// p99 histogram: HIST_BUCKETS x BUCKET_NS covering 0..(HIST_BUCKETS*BUCKET_NS).
// 1024 x 50 us = 0..51.2 ms — wide enough that good-mode sub-ms callbacks land in low
// buckets (real p99) AND misbehave-mode tens-of-ms blocks saturate the overflow bucket
// (clearly distinguishable). Each bucket is an AtomicU64 — lock-free, no RT alloc.
const HIST_BUCKETS: usize = 1024;
const BUCKET_NS: u64 = 50_000; // 50 us per bucket

/// Statistics from the audio thread, updated atomically.
///
/// All fields are updated from the cpal audio thread and read from the main thread
/// after `drop(stream)`. The `Arc` shared handle lets both sides see the same data.
pub struct AudioThreadStats {
    /// Number of cpal callbacks processed.
    pub callback_count: AtomicU64,
    /// Min callback duration (nanoseconds).
    pub min_ns: AtomicU64,
    /// Max callback duration (nanoseconds) — worst-case single callback.
    pub max_ns: AtomicU64,
    /// Sum of durations (nanoseconds), for mean.
    pub sum_ns: AtomicU64,
    /// Total samples received by the sink (interleaved, so frames x channels).
    pub sink_frames: AtomicU64,
    /// p99 histogram: HIST_BUCKETS x 1 us buckets.
    /// Bucket i covers [i us, (i+1) us). Bucket HIST_BUCKETS-1 = >=63 us overflow.
    pub hist_us: [AtomicU64; HIST_BUCKETS],
    /// Buffer resize events (should be 0 with BufferSize::Fixed, A0 §5).
    /// Incremented from ensure_buffer_size_matches via the shared Arc.
    pub buffer_resize_count: AtomicU64,
    /// Callback index at which the plugin was hot-installed via the install ring.
    /// u64::MAX = never installed via channel (static mode installs before the stream).
    /// S1b-2: proves the dynamic ownership handoff landed on the audio thread.
    pub installed_at_callback: AtomicU64,
}

impl AudioThreadStats {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            callback_count: AtomicU64::new(0),
            min_ns: AtomicU64::new(u64::MAX),
            max_ns: AtomicU64::new(0),
            sum_ns: AtomicU64::new(0),
            sink_frames: AtomicU64::new(0),
            hist_us: std::array::from_fn(|_| AtomicU64::new(0)),
            buffer_resize_count: AtomicU64::new(0),
            installed_at_callback: AtomicU64::new(u64::MAX),
        })
    }

    /// Compute the p99 nanosecond value from the histogram (read after stream stops).
    ///
    /// Returns the lower bound of the 99th-percentile bucket in nanoseconds,
    /// or None if no callbacks have been recorded.
    pub fn p99_ns(&self) -> Option<u64> {
        let total = self.callback_count.load(Ordering::Relaxed);
        if total == 0 {
            return None;
        }
        // Smallest bucket b where cumulative count >= ceil(99% x total).
        let target = (total * 99 + 99) / 100; // integer ceil
        let mut cumulative: u64 = 0;
        for (i, bucket) in self.hist_us.iter().enumerate() {
            cumulative += bucket.load(Ordering::Relaxed);
            if cumulative >= target {
                return Some(i as u64 * BUCKET_NS); // lower bound in ns
            }
        }
        // All callbacks fell in the overflow bucket.
        Some((HIST_BUCKETS - 1) as u64 * BUCKET_NS)
    }
}

/// A hot-install payload moved from the control thread to the audio thread (S1b-2).
///
/// All fields are `Send` and pre-allocated on the control thread, so installing
/// them in the callback is a plain move (no alloc / no lock). This is the dynamic
/// `LoadPlugin`-at-runtime ownership handoff A0 §8 flagged as the key unknown.
pub struct InstallMsg {
    pub plugin: StartedPluginAudioProcessor<OrbitClapHost>,
    pub buffers: HostAudioBuffers,
    pub note_port_index: u16,
}

/// Consumer side of the install ring (audio thread).
pub type InstallConsumer = rtrb::Consumer<InstallMsg>;

/// Audio-thread owner of all RT state (A0 §4.1).
///
/// Owned by the cpal closure (`move |data, _| proc.process(data)`).
/// Lives exclusively on the audio thread after stream construction.
///
/// `plugin`/`buffers` are `Option` so the stream can run engine-only until a plugin
/// is installed — either synchronously before the stream (static, S1) or via the
/// install ring while the stream runs (dynamic hot-install, S1b-2).
pub struct OrbitAudioProcessor {
    /// Existing sample-playback engine (unchanged, A0 §4.1 step a).
    engine: Engine,
    /// CLAP plugin audio processor (Mutex no soto, A0 §4.1). None until installed.
    plugin: Option<StartedPluginAudioProcessor<OrbitClapHost>>,
    /// Lock-free event ring consumer (A0 §4.2).
    event_consumer: PluginEventConsumer,
    /// Pre-allocated CLAP event buffer (cleared each callback, no RT alloc).
    event_scratch: EventBuffer,
    /// Pre-allocated plugin audio buffers (arrive with the plugin). None until installed.
    buffers: Option<HostAudioBuffers>,
    /// tap destination (A0 §4.4).
    sink: Box<dyn PostMixSink>,
    /// Steady sample counter (A0 §4.1 step f).
    steady_counter: u64,
    /// Note port index (set at install time).
    note_port_index: u16,
    /// Shared stats with the reporting thread (main thread reads after drop(stream)).
    stats: Arc<AudioThreadStats>,
    /// Hot-install ring (control -> audio). Popped once, when plugin is None.
    install_rx: InstallConsumer,
}

impl OrbitAudioProcessor {
    /// Construct an engine-only processor. The plugin is installed later, either
    /// synchronously via [`install`](Self::install) (static mode) or via `install_rx`
    /// while the stream runs (hot-install mode).
    pub fn new(
        engine: Engine,
        event_consumer: PluginEventConsumer,
        sink: Box<dyn PostMixSink>,
        stats: Arc<AudioThreadStats>,
        install_rx: InstallConsumer,
    ) -> Self {
        Self {
            engine,
            plugin: None,
            event_consumer,
            event_scratch: EventBuffer::with_capacity(256),
            buffers: None,
            sink,
            steady_counter: 0,
            note_port_index: 0,
            stats,
            install_rx,
        }
    }

    /// Install a plugin synchronously (control thread, before the stream is built).
    /// Used by static mode for S1 parity.
    pub fn install(&mut self, msg: InstallMsg) {
        self.plugin = Some(msg.plugin);
        self.buffers = Some(msg.buffers);
        self.note_port_index = msg.note_port_index;
    }

    /// Called from cpal callback with the output buffer (interleaved f32).
    ///
    /// Must not allocate or lock (except engine.render which uses try_lock -- existing contract).
    pub fn process(&mut self, data: &mut [f32]) {
        // Timing: Instant::now() is acceptable in a spike per A0 task instructions.
        // In production this should be replaced with a lock-free timer.
        let t0 = Instant::now();

        // Hot-install (S1b-2): if no plugin yet, try to receive one from the control
        // thread. pop() is wait-free; installing is a plain move (no alloc / no lock).
        if self.plugin.is_none() {
            if let Ok(msg) = self.install_rx.pop() {
                self.plugin = Some(msg.plugin);
                self.buffers = Some(msg.buffers);
                self.note_port_index = msg.note_port_index;
                let at = self.stats.callback_count.load(Ordering::Relaxed);
                self.stats.installed_at_callback.store(at, Ordering::Relaxed);
            }
        }

        // (a) Render existing sample engine into data.
        self.engine.render(data);

        // (b)-(d) Plugin path — only once a plugin is installed.
        if let (Some(plugin), Some(buffers)) = (self.plugin.as_mut(), self.buffers.as_mut()) {
            // Drain rtrb ring -> CLAP InputEvents (block-start offsets, A0 §4.2).
            drain_to_event_buffer(
                &mut self.event_consumer,
                &mut self.event_scratch,
                self.note_port_index,
            );
            let input_events = self.event_scratch.as_input();

            // Ensure plugin buffers match actual data size (zero-cost with BufferSize::Fixed).
            buffers.ensure_buffer_size_matches(data.len());
            let frame_count = buffers.cpal_buf_len_to_frame_count(data.len());
            let (ins, mut outs) = buffers.prepare_plugin_buffers(data.len());

            let _ = plugin.process(
                &ins,
                &mut outs,
                &input_events,
                &mut OutputEvents::void(),
                Some(self.steady_counter),
                None,
            );

            // (d) Add-mix plugin output into data (A0 §4.1 step d: engine + plugin summed).
            buffers.add_to_cpal_buffer(data);

            // (f) Advance steady counter.
            self.steady_counter += frame_count as u64;
        } else {
            // No plugin yet: drain-and-discard queued notes so the ring never stalls.
            while self.event_consumer.pop().is_ok() {}
        }

        // (e) tap post-mix (PostMixSink sees the fully-summed signal).
        self.sink.commit(data);

        // --- Metrics (no alloc, no lock) ---
        let elapsed_ns = t0.elapsed().as_nanos() as u64;
        self.stats.callback_count.fetch_add(1, Ordering::Relaxed);
        self.stats.min_ns.fetch_min(elapsed_ns, Ordering::Relaxed);
        self.stats.max_ns.fetch_max(elapsed_ns, Ordering::Relaxed);
        self.stats.sum_ns.fetch_add(elapsed_ns, Ordering::Relaxed);
        self.stats
            .sink_frames
            .fetch_add(data.len() as u64, Ordering::Relaxed);

        // Update p99 histogram: bucket = floor(elapsed_ns / BUCKET_NS), capped at overflow bucket.
        let bucket = ((elapsed_ns / BUCKET_NS) as usize).min(HIST_BUCKETS - 1);
        self.stats.hist_us[bucket].fetch_add(1, Ordering::Relaxed);
    }
}
