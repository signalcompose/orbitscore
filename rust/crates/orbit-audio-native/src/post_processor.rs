//! Master-bus post-processor seam（CLAP effect/instrument hosting 境界）。
//!
//! native は permissive な mixing core を保ち、CLAP/clack には依存しない。daemon が
//! `orbit-clap-host`(permissive) の [`PostProcessor`] 実装を生成し、stream 構築時に
//! callback へ注入する（既存 `PostMixSink`/`AudioBackend` inversion を踏襲。clack は
//! permissive なので license 強制ではなくアーキ清潔性の判断・Issue #340 §アーキ決定）。
//!
//! callback-duration 計測（[`CallbackTimeStats`]）もここに置く。A0 §6 の重要知見:
//! **macOS CoreAudio + cpal は callback が長時間ブロックしても `StreamError`(xrun) を
//! 発火しない** → `StreamStats.xruns` 単独は RT 違反検知に使えない（false-negative）。
//! production の RT 監視は callback 実測時間（mean/max/p99）ベースにする。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// engine render 後の hardware バッファ（interleaved f32）を **in-place で変換**する
/// master-bus post-processor。RT cpal callback から呼ばれる: **alloc / lock / block 禁止**
/// （audio thread 契約）。
///
/// [`crate::PostMixSink`]（post-mix を読むだけの tap）と異なり、buffer を変更する
/// （`&mut [f32]`）。CLAP effect（audio→audio・serial insert）/ instrument（add-mix）の
/// どちらも実装側（`orbit-clap-host`）の責務で、native はこの seam を呼ぶだけ。
pub trait PostProcessor: Send {
    /// `data` は engine が既に render 済みの interleaved f32（hardware sum）。実装はこれを
    /// in-place で変換する。チャンネル数 / sample rate は構築時に確定し、毎 callback では渡さない。
    fn process(&mut self, data: &mut [f32]);
}

// callback-duration histogram: HIST_BUCKETS x BUCKET_NS で 0..(HIST_BUCKETS*BUCKET_NS) を覆う。
// 1024 x 50us = 0..51.2ms — good-mode の sub-ms callback は低バケットに（実 p99）、misbehave の
// 数十 ms ブロックは overflow バケットに飽和する（区別可能）。各バケットは AtomicU64（lock-free・
// RT alloc なし）。spike `orbit-clap-spike::audio::AudioThreadStats` の histogram 設計を踏襲。
const HIST_BUCKETS: usize = 1024;
const BUCKET_NS: u64 = 50_000; // 50us / bucket

/// cpal callback の所要時間統計（atomic 更新・RT 安全）。
///
/// 全フィールドは audio thread から更新し、reporting thread（daemon の 1 Hz ticker）が
/// `snapshot()` で読む。`Arc` 共有で両者が同一データを見る。
pub struct CallbackTimeStats {
    /// 処理した callback 数。
    callback_count: AtomicU64,
    /// callback 所要時間の最小（ns）。
    min_ns: AtomicU64,
    /// callback 所要時間の最大（ns）= 最悪 callback。
    max_ns: AtomicU64,
    /// 所要時間の総和（ns）= mean 用。
    sum_ns: AtomicU64,
    /// p99 histogram: HIST_BUCKETS x BUCKET_NS(50us) バケット、0..51.2ms を覆う。
    /// バケット i = [i*50us, (i+1)*50us)。バケット HIST_BUCKETS-1 = >=51.15ms overflow。
    hist: [AtomicU64; HIST_BUCKETS],
}

impl CallbackTimeStats {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            callback_count: AtomicU64::new(0),
            min_ns: AtomicU64::new(u64::MAX),
            max_ns: AtomicU64::new(0),
            sum_ns: AtomicU64::new(0),
            hist: std::array::from_fn(|_| AtomicU64::new(0)),
        })
    }

    /// 1 callback 分の所要時間を記録する（RT 安全: atomic のみ・alloc/lock なし）。
    pub fn record(&self, elapsed_ns: u64) {
        self.callback_count.fetch_add(1, Ordering::Relaxed);
        self.min_ns.fetch_min(elapsed_ns, Ordering::Relaxed);
        self.max_ns.fetch_max(elapsed_ns, Ordering::Relaxed);
        self.sum_ns.fetch_add(elapsed_ns, Ordering::Relaxed);
        let bucket = ((elapsed_ns / BUCKET_NS) as usize).min(HIST_BUCKETS - 1);
        self.hist[bucket].fetch_add(1, Ordering::Relaxed);
    }

    /// histogram から p99（ns）を算出する（stream 停止後に reporting thread が読む）。
    /// 99 パーセンタイルが入るバケットの下限を ns で返す。callback 0 件なら None。
    pub fn p99_ns(&self) -> Option<u64> {
        let total = self.callback_count.load(Ordering::Relaxed);
        if total == 0 {
            return None;
        }
        let target = (total * 99).div_ceil(100); // 整数 ceil
        let mut cumulative: u64 = 0;
        for (i, bucket) in self.hist.iter().enumerate() {
            cumulative += bucket.load(Ordering::Relaxed);
            if cumulative >= target {
                return Some(i as u64 * BUCKET_NS);
            }
        }
        Some((HIST_BUCKETS - 1) as u64 * BUCKET_NS)
    }

    /// 非 RT 側（daemon ticker / test）が読むスナップショット。
    pub fn snapshot(&self) -> CallbackTimeSnapshot {
        let count = self.callback_count.load(Ordering::Relaxed);
        let min = self.min_ns.load(Ordering::Relaxed);
        CallbackTimeSnapshot {
            callback_count: count,
            min_ns: if count == 0 { 0 } else { min },
            max_ns: self.max_ns.load(Ordering::Relaxed),
            mean_ns: self
                .sum_ns
                .load(Ordering::Relaxed)
                .checked_div(count)
                .unwrap_or(0),
            p99_ns: self.p99_ns().unwrap_or(0),
        }
    }
}

/// [`CallbackTimeStats`] の読み取り専用スナップショット。
#[derive(Debug, Clone, Copy)]
pub struct CallbackTimeSnapshot {
    pub callback_count: u64,
    pub min_ns: u64,
    pub max_ns: u64,
    pub mean_ns: u64,
    pub p99_ns: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p99_none_when_no_callbacks() {
        let s = CallbackTimeStats::new();
        assert_eq!(s.p99_ns(), None);
        let snap = s.snapshot();
        assert_eq!(snap.callback_count, 0);
        assert_eq!(snap.min_ns, 0);
        assert_eq!(snap.mean_ns, 0);
    }

    #[test]
    fn record_updates_min_max_mean() {
        let s = CallbackTimeStats::new();
        s.record(100_000); // 100us
        s.record(300_000); // 300us
        let snap = s.snapshot();
        assert_eq!(snap.callback_count, 2);
        assert_eq!(snap.min_ns, 100_000);
        assert_eq!(snap.max_ns, 300_000);
        assert_eq!(snap.mean_ns, 200_000);
    }

    #[test]
    fn p99_crosses_into_tail_bucket() {
        // 99 callbacks at bucket 2, 1 slow callback at bucket 10.
        // ceil(99% of 100) = 99 → 累積が 99 に達するのは bucket 2 → p99 = bucket 2 下限。
        let s = CallbackTimeStats::new();
        for _ in 0..99 {
            s.record(2 * BUCKET_NS + 1_000); // bucket 2
        }
        s.record(10 * BUCKET_NS + 1_000); // bucket 10
        assert_eq!(s.p99_ns(), Some(2 * BUCKET_NS));
    }

    #[test]
    fn p99_saturates_to_overflow_bucket() {
        let s = CallbackTimeStats::new();
        // 全て overflow バケットに入る巨大値。
        s.record(60_000_000); // 60ms > 51.2ms
        assert_eq!(s.p99_ns(), Some((HIST_BUCKETS - 1) as u64 * BUCKET_NS));
    }
}
