//! GPL consumer-side egress driver: 1 つの LinkAudio channel への送出。
//!
//! native の RT callback(permissive)が per-channel post-mix を rtrb ring へ push し、本 driver
//! を保持する GPL consumer thread が drain して [`LinkAudioOutput::commit_channel`] に渡す。
//! この thread が Link の "audio thread" として振る舞う(`captureAudioSessionState` の制約)。
//!
//! 🔴 beat anchoring の正しさ(A4-2b-2 / advisor): commit に渡す `beats_at_begin` は egress 開始時に
//! 1 回 capture した anchor から **produced-frames** で線形再構成する。**produced = drained + dropped**
//! とすることで、producer-side の ring drop が起きても後続 block の beat が producer の真の位置を追い、
//! 永久 beat desync(drained-only だと drop 分だけ恒久的に遅れる)を防ぐ。drop は「音の gap」になるだけ。
//! per-block の "now"(clock().micros())は使わない(ring latency 分の位相ずれを避ける)。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::{CommitResult, LinkAudioOutput};

/// produced frame 数 = drain した frame + producer-side で drop された frame。
/// drop(`dropped_samples` = interleaved サンプル単位)を frame に直して算入する。
#[inline]
fn produced_frames(drained_frames: u64, dropped_samples: u64, num_channels: usize) -> u64 {
    drained_frames + dropped_samples / (num_channels as u64).max(1)
}

/// buffer-begin の beat を線形再構成する。per-block の "now" を使わず anchor + produced-frames で
/// 決定論的に求める(ring latency 非依存)。
#[inline]
fn reconstruct_beat(anchor_beat: f64, beat_per_frame: f64, produced_frames: u64) -> f64 {
    anchor_beat + produced_frames as f64 * beat_per_frame
}

/// 1 つの channel への egress driver。GPL consumer thread が所有する(`Send`)。
pub struct LinkChannelEgress {
    output: LinkAudioOutput,
    consumer: rtrb::Consumer<f32>,
    /// native の RingTapSink が producer-side で drop した **interleaved サンプル数**(累積)。
    drops: Arc<AtomicU64>,
    channel_id: i32,
    num_channels: usize,
    sample_rate: u32,
    quantum: f64,
    /// 1 commit あたりの frame 数。
    block_frames: usize,
    /// pre-alloc した block バッファ(block_frames * num_channels)。RT 外だが alloc を毎回避ける。
    scratch: Vec<f32>,
    // --- beat anchor(最初の pump で 1 回 capture)---
    anchored: bool,
    anchor_beat: f64,
    beat_per_frame: f64,
    /// この consumer が drain した frame 数(累積)。
    drained_frames: u64,
}

impl LinkChannelEgress {
    /// `output` は登録済み channel を持つ LinkAudio。`consumer`/`drops` は native の RingTapSink と
    /// 対になる ring の受信側。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        output: LinkAudioOutput,
        consumer: rtrb::Consumer<f32>,
        drops: Arc<AtomicU64>,
        channel_id: i32,
        num_channels: usize,
        sample_rate: u32,
        quantum: f64,
        block_frames: usize,
    ) -> Self {
        Self {
            output,
            consumer,
            drops,
            channel_id,
            num_channels,
            sample_rate,
            quantum,
            block_frames,
            scratch: vec![0.0; block_frames * num_channels],
            anchored: false,
            anchor_beat: 0.0,
            beat_per_frame: 0.0,
            drained_frames: 0,
        }
    }

    pub fn channel_id(&self) -> i32 {
        self.channel_id
    }

    /// ring に 1 block 分溜まっていれば drain して commit する。commit したら `Some(result)`、
    /// データ不足なら `None`。consumer thread はこれをループで呼ぶ(None の間は短い sleep)。
    pub fn pump_once(&mut self) -> Option<CommitResult> {
        let block_samples = self.block_frames * self.num_channels;
        if self.consumer.slots() < block_samples {
            return None;
        }

        // egress 開始時に anchor(beat + tempo)を 1 回だけ capture。以後は frame から再構成する。
        if !self.anchored {
            self.anchor_beat = self.output.capture_beat(self.quantum);
            let tempo = self.output.session_tempo();
            let bpm = if tempo > 0.0 { tempo } else { 120.0 };
            self.beat_per_frame = (bpm / 60.0) / self.sample_rate as f64;
            self.anchored = true;
        }

        // この block の先頭時点の produced-frames から beat を決定論再構成(drop 算入)。
        let dropped = self.drops.load(Ordering::Relaxed);
        let produced = produced_frames(self.drained_frames, dropped, self.num_channels);
        let beats_at_begin = reconstruct_beat(self.anchor_beat, self.beat_per_frame, produced);

        // ring から 1 block 分を scratch へコピー(chunk は self.consumer のみ借用・scratch は別 field)。
        {
            let chunk = self.consumer.read_chunk(block_samples).ok()?;
            let (a, b) = chunk.as_slices();
            self.scratch[..a.len()].copy_from_slice(a);
            self.scratch[a.len()..a.len() + b.len()].copy_from_slice(b);
            chunk.commit_all();
        }

        let rc = self.output.commit_channel(
            self.channel_id,
            &self.scratch[..block_samples],
            self.block_frames,
            self.num_channels,
            self.sample_rate,
            beats_at_begin,
            self.quantum,
        );
        self.drained_frames += self.block_frames as u64;
        Some(rc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produced_frames_no_drop_equals_drained() {
        assert_eq!(produced_frames(1000, 0, 2), 1000);
    }

    #[test]
    fn produced_frames_accounts_dropped() {
        // 512 interleaved samples dropped @ 2ch = 256 dropped frames。
        assert_eq!(produced_frames(1000, 512, 2), 1256);
        // mono。
        assert_eq!(produced_frames(1000, 100, 1), 1100);
    }

    #[test]
    fn reconstruct_beat_is_linear_and_monotonic() {
        // anchor=4.0, bpf=0.001 → produced=1000 で +1.0 = 5.0。
        assert!((reconstruct_beat(4.0, 0.001, 1000) - 5.0).abs() < 1e-9);
        // produced=0 で anchor そのもの。
        assert!((reconstruct_beat(4.0, 0.001, 0) - 4.0).abs() < 1e-9);
        // 単調増加。
        assert!(reconstruct_beat(0.0, 0.001, 2000) > reconstruct_beat(0.0, 0.001, 1000));
    }

    #[test]
    fn drop_does_not_cause_permanent_beat_desync() {
        // advisor の catch: drained-only だと drop 分だけ恒久的にずれる。produced(drained+dropped)
        // を使えば、drop 後も beat は producer の真の位置を追う。
        let bpf = 0.001;
        let anchor = 0.0;
        let nch = 2;
        // block1: drained=512(256f), drop=0 → produced=256 → beat=0.256。
        let b1 = reconstruct_beat(anchor, bpf, produced_frames(256, 0, nch));
        // この後 producer が 512 sample(256f)drop。block2: drained=512(256f), drop=512 →
        // produced=256+256=512 → beat=0.512。drained-only だと 0.256 のままで desync する。
        let b2 = reconstruct_beat(anchor, bpf, produced_frames(256, 512, nch));
        assert!((b1 - 0.256).abs() < 1e-9, "b1={b1}");
        assert!(
            (b2 - 0.512).abs() < 1e-9,
            "b2={b2} (drop が beat に算入されていない=desync)"
        );
        // drop 分だけ beat が前進している(gap を埋めるのでなく真の位置を追う)。
        assert!((b2 - b1 - 0.256).abs() < 1e-9);
    }
}
