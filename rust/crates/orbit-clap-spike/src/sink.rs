//! PostMixSink trait and stub implementations (A0 §4.4).
//!
//! All implementations must be RT-safe: no alloc, no lock, no blocking syscall in `commit`.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

/// A receiver for the post-mix signal (A0 §4.4).
///
/// Called from the cpal audio thread — implementors MUST NOT allocate, lock, or block.
pub trait PostMixSink: Send {
    fn commit(&mut self, post_mix: &[f32]);
}

// ---- CountingSink -------------------------------------------------------

/// Minimal no-alloc sink: counts received frames and tracks peak amplitude.
/// Peak is stored as f32 bits in an AtomicU32 (non-negative only — we store abs()).
pub struct CountingSink {
    pub frames_received: Arc<AtomicU64>,
    pub peak_bits: Arc<AtomicU32>,
}

impl CountingSink {
    pub fn new() -> (Self, Arc<AtomicU64>, Arc<AtomicU32>) {
        let frames = Arc::new(AtomicU64::new(0));
        let peak = Arc::new(AtomicU32::new(0));
        (
            Self {
                frames_received: frames.clone(),
                peak_bits: peak.clone(),
            },
            frames,
            peak,
        )
    }
}

impl PostMixSink for CountingSink {
    fn commit(&mut self, post_mix: &[f32]) {
        self.frames_received
            .fetch_add(post_mix.len() as u64, Ordering::Relaxed);

        for &s in post_mix {
            let abs_bits = s.abs().to_bits();
            // fetch_max on f32 bits is only valid for non-negative IEEE754 floats,
            // which abs() guarantees.
            self.peak_bits.fetch_max(abs_bits, Ordering::Relaxed);
        }
    }
}

// ---- RingTapSink --------------------------------------------------------

/// Forwards post-mix to a preallocated rtrb ring (non-blocking push).
/// On full ring, samples are dropped and the drop counter is incremented.
pub struct RingTapSink {
    producer: rtrb::Producer<f32>,
    pub drops: Arc<AtomicU64>,
}

impl RingTapSink {
    /// `capacity` should be sized to hold several seconds worth of interleaved f32 samples.
    pub fn new(capacity: usize) -> (Self, rtrb::Consumer<f32>, Arc<AtomicU64>) {
        let (producer, consumer) = rtrb::RingBuffer::new(capacity);
        let drops = Arc::new(AtomicU64::new(0));
        (
            Self {
                producer,
                drops: drops.clone(),
            },
            consumer,
            drops,
        )
    }
}

impl PostMixSink for RingTapSink {
    fn commit(&mut self, post_mix: &[f32]) {
        // push_partial_slice is wait-free and no-alloc (rtrb SPSC, T: Copy).
        // It returns (written, remainder); we count remainder as drops.
        let (written, remainder) = self.producer.push_partial_slice(post_mix);
        let drop_count = remainder.len();

        let _ = written;
        if drop_count > 0 {
            self.drops.fetch_add(drop_count as u64, Ordering::Relaxed);
        }
    }
}
