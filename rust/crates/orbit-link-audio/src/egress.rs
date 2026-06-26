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
//!
//! 🔴 tempo-change re-anchor(PR3 / advisor): `beats_at_begin` は **共有 Link セッションの時間軸**に
//! 乗るので、session tempo が変わると beat/frame 換算(`beat_per_frame`)が古くなり drift する。Link は
//! last-setter-wins で **自分の tempo push も他ピア(Ableton 等)の変更も** session tempo に現れるため、
//! consumer_loop が round ごとに `session_tempo()` を 1 回読み(session-global な値を per-channel に N 回
//! 読まない・efficiency)、各 channel の `pump_once` がそれを `last_bpm` と比較して変化を検出したら segment
//! を切り替える(poll-based: 自分の push 時のみ re-anchor する explicit を包含し、control→consumer の同期
//! 配線も要らない)。
//! 切り替えでは **`capture_beat()` を再呼びしない**(再 sample すると ring latency 位相誤差を再導入する)。
//! 代わりに segment baseline(`seg_anchor_beat` / `seg_anchor_produced` / `beat_per_frame`)を「今の
//! 再構成 beat」へ連続 carry し、slope(`beat_per_frame`)だけを新 tempo に更新する(piecewise-linear)。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::{CommitResult, LinkAudioOutput};

/// tempo 変化検出の閾値(BPM)。Link の tempo は set 間で安定なので小さな epsilon で十分。
/// 浮動小数の往復誤差で毎 block re-anchor しないための下限。
const TEMPO_EPSILON_BPM: f64 = 1e-6;

/// produced frame 数 = drain した frame + producer-side で drop された frame。
/// drop(`dropped_samples` = interleaved サンプル単位)を frame に直して算入する。
#[inline]
fn produced_frames(drained_frames: u64, dropped_samples: u64, num_channels: usize) -> u64 {
    drained_frames + dropped_samples / (num_channels as u64).max(1)
}

/// segment baseline から buffer-begin の beat を線形再構成する。per-block の "now" を使わず
/// `seg_anchor_beat + (produced - seg_anchor_produced) * beat_per_frame` で決定論的に求める
/// (ring latency 非依存)。tempo 変更時は segment を更新して境界で beat 連続・slope だけ変える。
#[inline]
fn reconstruct_beat(
    seg_anchor_beat: f64,
    seg_anchor_produced: u64,
    beat_per_frame: f64,
    produced: u64,
) -> f64 {
    seg_anchor_beat + produced.saturating_sub(seg_anchor_produced) as f64 * beat_per_frame
}

/// anchored 後の re-anchor 判定(pure)。`session_tempo` が `last_bpm` から有意(> [`TEMPO_EPSILON_BPM`])に
/// 変化していれば、新 segment の起点 beat(= 今の再構成 beat・連続 carry)を `Some` で返す。変化なし /
/// `session_tempo <= 0`(capture 例外 or 初期化前)は `None`。`capture_beat()` を呼ばず output 非依存なので、
/// pump_once の trigger logic を device 不要で unit-test できる(PT-1)。
#[inline]
fn reanchor_beat_on_change(
    seg_anchor_beat: f64,
    seg_anchor_produced: u64,
    beat_per_frame: f64,
    last_bpm: f64,
    session_tempo: f64,
    produced: u64,
) -> Option<f64> {
    if session_tempo > 0.0 && (session_tempo - last_bpm).abs() > TEMPO_EPSILON_BPM {
        Some(reconstruct_beat(
            seg_anchor_beat,
            seg_anchor_produced,
            beat_per_frame,
            produced,
        ))
    } else {
        None
    }
}

/// 1 つの channel への egress driver。**`LinkAudioOutput` は所有しない**（A4-2b-2b）: consumer
/// thread が 1 つの `LinkAudioOutput`（Link session）を持ち、その上の複数 channel をそれぞれ本 driver
/// で回す。`pump_once` に共有 output を `&` で渡す（commit / anchor capture はその output 経由。tempo
/// snapshot は consumer_loop が round ごとに 1 回 `output.session_tempo()` で取得し引数で渡す）。
/// **beat anchor は per-channel**（各 channel が自分の first-pump-with-data で capture・session
/// 単位に hoist しない）。GPL consumer thread が所有する(`Send`)。
pub struct LinkChannelEgress {
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
    // --- beat anchor(segment baseline・poll-based re-anchor・PR3)---
    // 初回 pump で 1 回だけ `capture_beat()`。以降の tempo 変更(自分の push / 他ピア・last-setter-wins)は
    // `session_tempo()` の poll で検出し、`capture_beat()` を再呼びせず segment を連続 carry する。
    anchored: bool,
    /// 現 segment の起点 beat。
    seg_anchor_beat: f64,
    /// 現 segment 起点での produced-frames。`beat = seg_anchor_beat + (produced -
    /// seg_anchor_produced) * beat_per_frame`。
    seg_anchor_produced: u64,
    beat_per_frame: f64,
    /// 直近に観測した有効 session BPM(変化検出用)。
    last_bpm: f64,
    /// この consumer が drain した frame 数(累積)。
    drained_frames: u64,
}

impl LinkChannelEgress {
    /// `channel_id` は共有 `LinkAudioOutput` 上で登録済みの channel id。`consumer`/`drops` は native の
    /// RingTapSink と対になる ring の受信側。output は `pump_once` に渡す（所有しない）。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        consumer: rtrb::Consumer<f32>,
        drops: Arc<AtomicU64>,
        channel_id: i32,
        num_channels: usize,
        sample_rate: u32,
        quantum: f64,
        block_frames: usize,
    ) -> Self {
        Self {
            consumer,
            drops,
            channel_id,
            num_channels,
            sample_rate,
            quantum,
            block_frames,
            scratch: vec![0.0; block_frames * num_channels],
            anchored: false,
            seg_anchor_beat: 0.0,
            seg_anchor_produced: 0,
            beat_per_frame: 0.0,
            last_bpm: 0.0,
            drained_frames: 0,
        }
    }

    /// 指定 BPM から beat/frame 換算(beat_per_frame = (bpm/60)/sr)を求める。
    #[inline]
    fn beat_per_frame_for(&self, bpm: f64) -> f64 {
        (bpm / 60.0) / self.sample_rate as f64
    }

    /// segment baseline(起点 beat / 起点 produced / slope / last_bpm)を一括設定する。初回 anchor と
    /// tempo 変更時の re-anchor で共有し、「segment とは何か」を 1 箇所に集約する(simplification)。
    #[inline]
    fn start_segment(&mut self, anchor_beat: f64, produced: u64, bpm: f64) {
        self.seg_anchor_beat = anchor_beat;
        self.seg_anchor_produced = produced;
        self.beat_per_frame = self.beat_per_frame_for(bpm);
        self.last_bpm = bpm;
    }

    /// ring に 1 block 分溜まっていれば drain して `output` の当該 channel へ commit する。commit したら
    /// `Some(result)`、データ不足なら `None`。consumer thread が共有 `output` を `&` で渡してループで
    /// 呼ぶ(None の間は短い sleep)。`session_tempo` は consumer_loop が round ごとに 1 回読んだ snapshot
    /// (session-global なので per-channel に読み直さない・efficiency)。<=0 は capture 例外(shim が 0.0 を
    /// 返す)または Link セッション初期化前の過渡状態で、初回 anchor の fallback には使うが re-anchor の
    /// 比較基準にはしない(過渡的な 0 で誤検出しない)。
    pub fn pump_once(
        &mut self,
        output: &LinkAudioOutput,
        session_tempo: f64,
    ) -> Option<CommitResult> {
        let block_samples = self.block_frames * self.num_channels;
        if self.consumer.slots() < block_samples {
            return None;
        }

        // この block 先頭時点の produced-frames(drop 算入)。anchor / re-anchor / commit すべてで同一値を
        // 使う(between-call の drop 増加で beat がずれないように 1 回だけ load する)。
        let dropped = self.drops.load(Ordering::Relaxed);
        let produced = produced_frames(self.drained_frames, dropped, self.num_channels);

        if !self.anchored {
            // egress 開始時に anchor(beat)を 1 回だけ capture。以後 `capture_beat()` は二度と呼ばない
            // (ring latency 位相誤差の再導入を避ける・advisor)。session_tempo<=0 は fallback 120。
            let bpm = if session_tempo > 0.0 {
                session_tempo
            } else {
                120.0
            };
            self.start_segment(output.capture_beat(self.quantum), produced, bpm);
            self.anchored = true;
        } else if let Some(new_anchor) = reanchor_beat_on_change(
            self.seg_anchor_beat,
            self.seg_anchor_produced,
            self.beat_per_frame,
            self.last_bpm,
            session_tempo,
            produced,
        ) {
            // tempo 変更を検出 → segment を切り替える。新 segment の起点 beat は「今の再構成 beat」(連続)・
            // 起点 produced は今の produced・slope を新 tempo に。`capture_beat()` は呼ばない(連続 carry)。
            self.start_segment(new_anchor, produced, session_tempo);
        }

        let beats_at_begin = reconstruct_beat(
            self.seg_anchor_beat,
            self.seg_anchor_produced,
            self.beat_per_frame,
            produced,
        );

        // ring から 1 block 分を scratch へコピー(chunk は self.consumer のみ借用・scratch は別 field)。
        {
            let chunk = self.consumer.read_chunk(block_samples).ok()?;
            let (a, b) = chunk.as_slices();
            self.scratch[..a.len()].copy_from_slice(a);
            self.scratch[a.len()..a.len() + b.len()].copy_from_slice(b);
            chunk.commit_all();
        }

        let rc = output.commit_channel(
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
        // seg_anchor_beat=4.0, seg_anchor_produced=0, bpf=0.001 → produced=1000 で +1.0 = 5.0。
        assert!((reconstruct_beat(4.0, 0, 0.001, 1000) - 5.0).abs() < 1e-9);
        // produced=seg_anchor_produced で anchor そのもの。
        assert!((reconstruct_beat(4.0, 0, 0.001, 0) - 4.0).abs() < 1e-9);
        // 単調増加。
        assert!(reconstruct_beat(0.0, 0, 0.001, 2000) > reconstruct_beat(0.0, 0, 0.001, 1000));
    }

    #[test]
    fn drop_does_not_cause_permanent_beat_desync() {
        // advisor の catch: drained-only だと drop 分だけ恒久的にずれる。produced(drained+dropped)
        // を使えば、drop 後も beat は producer の真の位置を追う。
        let bpf = 0.001;
        let anchor = 0.0;
        let nch = 2;
        // block1: drained=512(256f), drop=0 → produced=256 → beat=0.256。
        let b1 = reconstruct_beat(anchor, 0, bpf, produced_frames(256, 0, nch));
        // この後 producer が 512 sample(256f)drop。block2: drained=512(256f), drop=512 →
        // produced=256+256=512 → beat=0.512。drained-only だと 0.256 のままで desync する。
        let b2 = reconstruct_beat(anchor, 0, bpf, produced_frames(256, 512, nch));
        assert!((b1 - 0.256).abs() < 1e-9, "b1={b1}");
        assert!(
            (b2 - 0.512).abs() < 1e-9,
            "b2={b2} (drop が beat に算入されていない=desync)"
        );
        // drop 分だけ beat が前進している(gap を埋めるのでなく真の位置を追う)。
        assert!((b2 - b1 - 0.256).abs() < 1e-9);
    }

    #[test]
    fn reanchor_is_beat_continuous_and_changes_slope() {
        // advisor の load-bearing detail: tempo 変更時の re-anchor は境界で beat 連続・slope だけ変える
        // (capture_beat() を再呼びしない連続 carry)。
        // segment1: anchor_beat=0, anchor_produced=0, bpf=0.001。produced=1000 → beat=1.0。
        let bpf1 = 0.001;
        let (seg1_beat, seg1_prod) = (0.0_f64, 0_u64);
        let at_change = reconstruct_beat(seg1_beat, seg1_prod, bpf1, 1000);
        assert!((at_change - 1.0).abs() < 1e-9);

        // tempo 2x → bpf2 = 0.002。re-anchor: seg2_beat = at_change(連続), seg2_prod=1000。
        let bpf2 = 0.002;
        let (seg2_beat, seg2_prod) = (at_change, 1000_u64);

        // 境界(produced=1000)で連続: 新 segment でも同じ beat。
        let at_boundary_new = reconstruct_beat(seg2_beat, seg2_prod, bpf2, 1000);
        assert!(
            (at_boundary_new - at_change).abs() < 1e-9,
            "境界で beat が不連続: {at_boundary_new} != {at_change}"
        );

        // 境界後 produced=1500 → beat = 1.0 + 500*0.002 = 2.0(新 slope)。
        let after = reconstruct_beat(seg2_beat, seg2_prod, bpf2, 1500);
        assert!((after - 2.0).abs() < 1e-9, "after={after}");

        // 旧 slope のままなら 1.0 + 500*0.001 = 1.5 だったはず → slope が変わっている。
        let old_slope_would_be = reconstruct_beat(seg1_beat, seg1_prod, bpf1, 1500);
        assert!((old_slope_would_be - 1.5).abs() < 1e-9);
        assert!(
            after > old_slope_would_be,
            "tempo 増で slope が増えていない: after={after} old={old_slope_would_be}"
        );
    }

    #[test]
    fn reanchor_slowdown_reduces_slope_but_keeps_continuity() {
        // 減速側(tempo 半分)。境界連続 + slope 減少を確認。
        let bpf1 = 0.002;
        let (seg1_beat, seg1_prod) = (0.0_f64, 0_u64);
        let at_change = reconstruct_beat(seg1_beat, seg1_prod, bpf1, 1000); // 2.0
        let bpf2 = 0.001;
        let (seg2_beat, seg2_prod) = (at_change, 1000_u64);
        // 連続。
        assert!((reconstruct_beat(seg2_beat, seg2_prod, bpf2, 1000) - at_change).abs() < 1e-9);
        // 境界後 produced=2000 → 2.0 + 1000*0.001 = 3.0(旧 slope なら 2.0+1000*0.002=4.0)。
        let after = reconstruct_beat(seg2_beat, seg2_prod, bpf2, 2000);
        assert!((after - 3.0).abs() < 1e-9, "after={after}");
    }

    #[test]
    fn reanchor_decision_sequence_anchor_steady_change_drop() {
        // pump_once の re-anchor trigger logic(else-if 分岐)を pure helper 経由で device 不要に検証(PT-1)。
        // anchored 済み(seg=0, produced=0, last_bpm=120)を起点に steady → 変更 → 微小変化 → capture 例外。
        let sr = 48_000u32;
        let bpf120 = (120.0 / 60.0) / sr as f64;

        // steady（同 tempo）→ re-anchor しない。
        assert_eq!(
            reanchor_beat_on_change(0.0, 0, bpf120, 120.0, 120.0, 4800),
            None
        );
        // tempo 変更(120→140) → Some(今の再構成 beat = 連続点)。
        let at_change = reconstruct_beat(0.0, 0, bpf120, 4800);
        assert_eq!(
            reanchor_beat_on_change(0.0, 0, bpf120, 120.0, 140.0, 4800),
            Some(at_change)
        );
        // epsilon 未満の揺れ → None（浮動小数ノイズで誤検出しない）。
        assert_eq!(
            reanchor_beat_on_change(0.0, 0, bpf120, 120.0, 120.0 + 1e-9, 4800),
            None
        );
        // session_tempo<=0（capture 例外 or 初期化前）→ None（誤検出しない）。
        assert_eq!(
            reanchor_beat_on_change(0.0, 0, bpf120, 120.0, 0.0, 4800),
            None
        );
        assert_eq!(
            reanchor_beat_on_change(0.0, 0, bpf120, 120.0, -1.0, 4800),
            None
        );
    }
}
