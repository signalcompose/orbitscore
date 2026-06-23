//! LinkAudio egress 用の lock-free ring producer(permissive↔GPL 境界の **producer 側**)。
//!
//! orbit-clap-spike(S1)で実証した `RingTapSink`/`PostMixSink` を本番へ port したもの。RT cpal
//! callback が per-channel post-mix をこの sink に push し、GPL consumer thread(orbit-link-audio
//! の `LinkChannelEgress`)が対になる `rtrb::Consumer<f32>` を drain して Link へ commit する。
//! rtrb は permissive なので producer/consumer どちらも本境界に置けるが、**Link を呼ぶのは consumer
//! 側(GPL crate)だけ**で、本 producer 側は GPL に一切触れない(license 境界 = ring)。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// RT audio callback から呼ばれる post-mix tap。実装は **alloc / lock / block してはならない**
/// (audio thread 契約)。format(channel 数・sample rate)は構築時に確定し commit には渡さない。
pub trait PostMixSink: Send {
    fn commit(&mut self, post_mix: &[f32]);
}

/// rtrb ring の producer 側 tap。`push_partial_slice` は wait-free・no-alloc。ring が満杯なら
/// あふれた分を **drop してカウント**する(blocking しない＝RT 安全)。drops は GPL consumer 側が
/// produced-frames(= drained + dropped)に算入し、drop が起きても beat の永久ずれを防ぐために使う。
pub struct RingTapSink {
    producer: rtrb::Producer<f32>,
    drops: Arc<AtomicU64>,
}

impl RingTapSink {
    /// `capacity` は数秒分の interleaved f32 サンプル数を見込む(`sample_rate * channels * 秒`)。
    /// 戻り: (sink〔RT callback 側〕, consumer〔GPL consumer thread 側〕, drops〔共有カウンタ〕)。
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

    /// これまでに drop した interleaved サンプル数(累積)。
    pub fn drops(&self) -> u64 {
        self.drops.load(Ordering::Relaxed)
    }
}

impl PostMixSink for RingTapSink {
    fn commit(&mut self, post_mix: &[f32]) {
        // push_partial_slice は wait-free / no-alloc(rtrb SPSC・T: Copy)。満杯時は書けた分だけ
        // 書き、あふれ(remainder)を drop としてカウントする。
        let (_written, remainder) = self.producer.push_partial_slice(post_mix);
        let drop_count = remainder.len();
        if drop_count > 0 {
            self.drops.fetch_add(drop_count as u64, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_tap_pushes_and_consumer_reads() {
        let (mut sink, mut cons, drops) = RingTapSink::new(8);
        sink.commit(&[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(drops.load(Ordering::Relaxed), 0);

        let chunk = cons.read_chunk(4).expect("4 available");
        let (a, b) = chunk.as_slices();
        let mut got: Vec<f32> = a.to_vec();
        got.extend_from_slice(b);
        chunk.commit_all();
        assert_eq!(got, vec![1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn ring_tap_counts_drops_when_full_without_blocking() {
        let (mut sink, _cons, drops) = RingTapSink::new(4);
        // capacity 超の push → あふれは drop されカウントされる(blocking しない)。
        sink.commit(&[0.0; 10]);
        assert!(
            drops.load(Ordering::Relaxed) > 0,
            "満杯 ring への push は drop をカウントするはず: drops={}",
            drops.load(Ordering::Relaxed)
        );
    }
}
