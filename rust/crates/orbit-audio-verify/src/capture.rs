//! Capture: core レンダラを固定タイムラインでオフライン駆動し、ミックス済み
//! interleaved f32 PCM を決定論バッファに収集する（= DUT 駆動）。
//!
//! 本番の cpal callback と違い実時間に依存せず、`block_frames` 単位で
//! [`Scheduler::render`] を反復するだけなので、同じ入力からは常に同じ PCM が
//! 得られる。block 分割は実 callback の粒度を模し、イベントが block 境界を
//! またぐ経路（`Scheduler` 内の `dst_offset_frames`）も通す。

use orbit_audio_core::Scheduler;

/// オフライン捕捉した interleaved f32 PCM と、その解釈に必要な format メタ。
///
/// `data` は `channels` フレーム単位の interleaved（2ch なら L, R, L, R, ...）。
/// 長さは `frames() * channels`。
#[derive(Debug, Clone)]
pub struct CapturedAudio {
    /// interleaved PCM 本体。
    pub data: Vec<f32>,
    /// チャンネル数（モノラル=1, ステレオ=2）。
    pub channels: u16,
    /// サンプリングレート（Hz）。`frame` ↔ 秒の換算に使う。
    pub sample_rate: u32,
}

impl CapturedAudio {
    /// 生の interleaved PCM から構築する。`capture` を経ずに、外部でロード/生成した
    /// バッファを解析プリミティブに載せたいときにも使える（assertion lib は capture 由来
    /// に限らず任意の PCM に適用できる）。
    pub fn new(data: Vec<f32>, channels: u16, sample_rate: u32) -> Self {
        Self {
            data,
            channels,
            sample_rate,
        }
    }

    /// フレーム数（channels を剥がした時間軸の長さ）。
    pub fn frames(&self) -> usize {
        self.data.len() / self.channels.max(1) as usize
    }

    /// `(frame, ch)` のサンプル値。範囲外は 0.0（無音）として扱う。
    pub fn at(&self, frame: usize, ch: usize) -> f32 {
        let chs = self.channels.max(1) as usize;
        if ch >= chs {
            return 0.0;
        }
        self.data.get(frame * chs + ch).copied().unwrap_or(0.0)
    }

    /// 秒 → フレーム位置（切り捨て）。フィクスチャの時刻指定から窓を作る用途。
    pub fn frame_at_sec(&self, sec: f64) -> usize {
        (sec * self.sample_rate as f64) as usize
    }
}

/// `scheduler` を `total_frames` 分、`block_frames` 単位で render して PCM を収集する。
///
/// `channels` は呼び出し側が `Scheduler` 構築時の値を渡す（core に getter を足さず
/// 無改変を保つため）。`sample_rate` は `Scheduler` から読み取る。
///
/// # Panics
/// `channels == 0` または `block_frames == 0` のとき panic する（テストハーネス用途
/// なので不正設定は早期に落とす）。
pub fn capture(
    scheduler: &mut Scheduler,
    channels: u16,
    total_frames: usize,
    block_frames: usize,
) -> CapturedAudio {
    assert!(channels > 0, "capture: channels must be > 0");
    assert!(block_frames > 0, "capture: block_frames must be > 0");

    let chs = channels as usize;
    let sample_rate = scheduler.output_sample_rate();
    let mut data = Vec::with_capacity(total_frames * chs);
    let mut block = vec![0.0f32; block_frames * chs];

    let mut rendered = 0usize;
    while rendered < total_frames {
        let this_frames = block_frames.min(total_frames - rendered);
        let buf = &mut block[..this_frames * chs];
        // block の使い回し（前回値の残り）は出力に影響しない。
        // orbit_audio_core::Scheduler::render が先頭でゼロクリアしてから加算する前提
        // （scheduler.rs 参照）。render が加算方式に変わったらこの前提を見直すこと。
        scheduler.render(buf);
        data.extend_from_slice(buf);
        rendered += this_frames;
    }

    CapturedAudio {
        data,
        channels,
        sample_rate,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orbit_audio_core::{Sample, ScheduledSample};

    /// 定数 1.0 の mono サンプルを stereo 出力に流し、block 分割しても全フレームが
    /// 収集され、length が total_frames * channels になることを確認する。
    #[test]
    fn capture_collects_full_timeline_across_blocks() {
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, Sample::new(vec![1.0f32; 1000], 48_000, 1)));

        // total=1000 を 512 ブロックで割る（端数 488 が出る → block 端の処理を通す）。
        let cap = capture(&mut s, 2, 1000, 512);
        assert_eq!(cap.channels, 2);
        assert_eq!(cap.sample_rate, 48_000);
        assert_eq!(cap.frames(), 1000);
        assert_eq!(cap.data.len(), 2000);
        // 中央パン（等パワー -3dB）で各 ch ≈ 0.707。先頭フレームが非ゼロ。
        assert!(cap.at(0, 0).abs() > 0.5);
        assert!(cap.at(0, 1).abs() > 0.5);
    }

    /// 開始時刻が block 境界をまたぐイベントでも、正しいフレームから音が始まる。
    #[test]
    fn event_starting_off_block_boundary_is_captured() {
        let mut s = Scheduler::new(48_000, 2);
        // 600 フレーム目開始（block=512 をまたぐ）。hard-left で L のみ非ゼロ。
        s.schedule(
            ScheduledSample::new(600.0 / 48_000.0, Sample::new(vec![1.0f32; 200], 48_000, 1))
                .with_pan(-1.0),
        );
        let cap = capture(&mut s, 2, 1200, 512);
        // 599 フレーム目までは無音、600 から非ゼロ。
        assert!(cap.at(599, 0).abs() < 1e-6, "before onset must be silent");
        assert!(cap.at(600, 0).abs() > 0.5, "onset frame must be non-zero");
    }

    /// 秒 → フレーム換算（公開 API）。
    #[test]
    fn frame_at_sec_converts_seconds_to_frames() {
        let cap = CapturedAudio::new(vec![0.0; 4], 2, 48_000);
        assert_eq!(cap.frame_at_sec(1.0), 48_000);
        assert_eq!(cap.frame_at_sec(0.0), 0);
        assert_eq!(cap.frame_at_sec(0.5), 24_000);
    }

    /// 不正設定（channels=0）は早期 panic（文書化済み契約）。
    #[test]
    #[should_panic(expected = "channels must be > 0")]
    fn capture_panics_on_zero_channels() {
        let mut s = Scheduler::new(48_000, 2);
        capture(&mut s, 0, 10, 5);
    }

    /// 不正設定（block_frames=0）は早期 panic（文書化済み契約）。
    #[test]
    #[should_panic(expected = "block_frames must be > 0")]
    fn capture_panics_on_zero_block_frames() {
        let mut s = Scheduler::new(48_000, 2);
        capture(&mut s, 2, 10, 0);
    }
}
