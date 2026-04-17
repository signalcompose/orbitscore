//! Scheduler: 指定時刻にサンプルを発音するイベントリストを管理する。

use super::Sample;

/// 単一のスケジュール済みサンプルイベント。
#[derive(Debug, Clone)]
pub struct ScheduledSample {
    /// 発音開始時刻（出力ストリーム時間軸、秒）
    pub start_sec: f64,
    /// ゲイン係数（線形、1.0 = unity）
    pub gain: f32,
    /// サンプル本体
    pub sample: Sample,
}

impl ScheduledSample {
    pub fn new(start_sec: f64, sample: Sample) -> Self {
        Self {
            start_sec,
            gain: 1.0,
            sample,
        }
    }

    pub fn with_gain(mut self, gain: f32) -> Self {
        self.gain = gain;
        self
    }
}

/// スケジュール済みサンプル群を混合するミキサー。
///
/// オーディオコールバック内で使うことを想定し、allocation 無しで
/// フレーム単位のサンプルを取り出せるよう設計している。
pub struct Scheduler {
    output_sample_rate: u32,
    output_channels: u16,
    events: Vec<ActiveSample>,
    /// 出力ストリーム上の現在位置（サンプルフレーム単位）
    cursor_frames: u64,
    /// 現在のマスターゲイン（線形、フレーム単位でランプ更新）
    global_gain: f32,
    /// ランプ終了時点の目標ゲイン
    target_gain: f32,
    /// 残りランプフレーム数。0 でランプ終了し global_gain = target_gain。
    ramp_frames_remaining: u64,
    /// ランプ中の定数ステップ（set_global_gain で計算）。線形ランプを保証する。
    ramp_step: f32,
    // TODO (Phase 2): events を start_frame で BinaryHeap にして、
    // render ごとの線形スキャンを削減する
}

struct ActiveSample {
    /// このサンプルの開始フレーム（出力時間軸）
    start_frame: u64,
    /// ゲイン
    gain: f32,
    /// サンプル本体
    sample: Sample,
    /// このサンプル内で次に読むフレーム位置
    read_pos: usize,
}

impl Scheduler {
    pub fn new(output_sample_rate: u32, output_channels: u16) -> Self {
        Self {
            output_sample_rate,
            output_channels,
            events: Vec::new(),
            cursor_frames: 0,
            global_gain: 1.0,
            target_gain: 1.0,
            ramp_frames_remaining: 0,
            ramp_step: 0.0,
        }
    }

    /// マスターゲインを設定する。`ramp_frames == 0` なら即時、それ以外は定数ステップで
    /// 線形に `value` へ到達する。負の値は 0.0 にクランプする。
    pub fn set_global_gain(&mut self, value: f32, ramp_frames: u64) {
        let value = value.max(0.0);
        if ramp_frames == 0 {
            self.global_gain = value;
            self.target_gain = value;
            self.ramp_frames_remaining = 0;
            self.ramp_step = 0.0;
        } else {
            self.target_gain = value;
            self.ramp_frames_remaining = ramp_frames;
            self.ramp_step = (value - self.global_gain) / ramp_frames as f32;
        }
    }

    #[cfg(test)]
    pub(crate) fn global_gain(&self) -> f32 {
        self.global_gain
    }

    /// サンプルを予約する。時刻は秒。
    pub fn schedule(&mut self, event: ScheduledSample) {
        let start_frame = (event.start_sec * self.output_sample_rate as f64).max(0.0) as u64;
        self.events.push(ActiveSample {
            start_frame,
            gain: event.gain,
            sample: event.sample,
            read_pos: 0,
        });
    }

    /// 出力バッファにアクティブなサンプル群を加算する。
    ///
    /// `out` は interleaved（`output_channels` フレーム単位）であることを想定。
    pub fn render(&mut self, out: &mut [f32]) {
        for s in out.iter_mut() {
            *s = 0.0;
        }

        let frames_to_render = out.len() / self.output_channels as usize;
        let output_channels = self.output_channels as usize;

        for active in self.events.iter_mut() {
            // このバッファ区間にこのサンプルが重なるか？
            let buf_start = self.cursor_frames;
            let buf_end = self.cursor_frames + frames_to_render as u64;
            if active.start_frame >= buf_end {
                continue; // まだ開始時刻ではない
            }

            let src_channels = active.sample.channels as usize;
            if src_channels == 0 {
                // 0ch の不正なサンプルはスキップ（`src_channels - 1` のアンダーフロー回避）
                active.read_pos = active.sample.frames();
                continue;
            }
            let total_src_frames = active.sample.frames();
            if active.read_pos >= total_src_frames {
                continue; // 再生済み
            }

            // 出力バッファ内での書き込み開始位置（フレーム単位）
            let dst_offset_frames = if active.start_frame > buf_start {
                (active.start_frame - buf_start) as usize
            } else {
                0
            };

            let remaining_src_frames = total_src_frames - active.read_pos;
            let writable_frames = frames_to_render.saturating_sub(dst_offset_frames);
            let frames_to_copy = writable_frames.min(remaining_src_frames);

            for i in 0..frames_to_copy {
                let src_frame = active.read_pos + i;
                let dst_frame = dst_offset_frames + i;
                for ch in 0..output_channels {
                    let src_ch = ch.min(src_channels - 1);
                    let src_idx = src_frame * src_channels + src_ch;
                    let dst_idx = dst_frame * output_channels + ch;
                    out[dst_idx] += active.sample.data[src_idx] * active.gain;
                }
            }
            active.read_pos += frames_to_copy;
        }

        // 混合後の出力バッファにフレーム単位のマスターゲインを適用する。
        // ランプ中はフレームごとに線形補間で global_gain を更新する。
        // 単調パスで追加 allocation なし。
        for frame in 0..frames_to_render {
            if self.ramp_frames_remaining > 0 {
                self.global_gain += self.ramp_step;
                self.ramp_frames_remaining -= 1;
                if self.ramp_frames_remaining == 0 {
                    // 浮動小数点誤差対策でターゲットにスナップ
                    self.global_gain = self.target_gain;
                    self.ramp_step = 0.0;
                }
            }
            let base = frame * output_channels;
            for ch in 0..output_channels {
                out[base + ch] *= self.global_gain;
            }
        }

        self.cursor_frames += frames_to_render as u64;
        // 再生完了したもの（= すべてのフレームを読み終えたもの）をドロップ。
        // まだ開始時刻に到達していないイベントは read_pos == 0 のため自然に保持される。
        self.events.retain(|a| a.read_pos < a.sample.frames());
    }

    /// 現在の出力ストリーム時刻（秒）
    pub fn now_sec(&self) -> f64 {
        self.cursor_frames as f64 / self.output_sample_rate as f64
    }

    pub fn output_sample_rate(&self) -> u32 {
        self.output_sample_rate
    }

    /// テスト用: 保持しているイベント数
    #[cfg(test)]
    pub(crate) fn events_len(&self) -> usize {
        self.events.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_sample_stereo(frames: usize) -> Sample {
        Sample::new(vec![0.1f32; frames * 2], 48_000, 2)
    }

    #[test]
    fn unplayed_event_is_retained_across_render() {
        // 1 秒後に再生するサンプルをスケジュールし、2ms だけ render
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(1.0, mk_sample_stereo(4_800)));

        let mut buf = vec![0.0f32; 200]; // 100 frames
        s.render(&mut buf);

        // まだ開始時刻に到達していないので保持されているはず（retain 回帰テスト）
        assert_eq!(s.events_len(), 1);
    }

    #[test]
    fn played_event_is_dropped() {
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100)));

        // サンプル全体を十分に超える長さを render
        let mut buf = vec![0.0f32; 1000];
        s.render(&mut buf);

        assert_eq!(s.events_len(), 0);
    }

    #[test]
    fn zero_channel_sample_is_skipped_without_panic() {
        let mut s = Scheduler::new(48_000, 2);
        // 不正な 0ch サンプル（src_channels - 1 アンダーフロー回避の確認）
        s.schedule(ScheduledSample::new(
            0.0,
            Sample::new(vec![0.0; 10], 48_000, 0),
        ));

        let mut buf = vec![0.0f32; 200];
        s.render(&mut buf); // panic せず完了すること
                            // 次回 render でイベントが掃除される
        s.render(&mut buf);
        assert_eq!(s.events_len(), 0);
    }

    #[test]
    fn render_mixes_scheduled_audio_into_output() {
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100)));

        let mut buf = vec![0.0f32; 200];
        s.render(&mut buf);

        // 先頭から非ゼロの音が書き込まれているはず
        assert!(buf.iter().any(|&x| x != 0.0));
    }

    #[test]
    fn set_global_gain_immediate_scales_output() {
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100)));
        s.set_global_gain(0.5, 0);

        let mut buf = vec![0.0f32; 200];
        s.render(&mut buf);

        // 元々 0.1 のサンプルが 0.5x でスケール → ~0.05。ランプ無しなので一定。
        let peak = buf.iter().cloned().fold(0.0f32, f32::max);
        assert!((peak - 0.05).abs() < 1e-5, "peak={peak}");
    }

    #[test]
    fn set_global_gain_ramps_linearly_to_target() {
        let mut s = Scheduler::new(48_000, 2);
        // 直流 1.0 のモノラルサンプルを想定して 1ch 出力にすると計算が容易。
        // ここでは 2ch stereo で mk_sample_stereo(.1) を流し、ランプ後の最後の
        // フレームが target_gain (0.0) で減衰していることだけ検証する。
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100)));
        s.set_global_gain(0.0, 100); // 100 フレームで 1.0 → 0.0 へランプ

        let mut buf = vec![0.0f32; 200]; // 100 frames
        s.render(&mut buf);

        // 最終フレームはランプ完了し target_gain = 0.0 になっているはず
        let last_l = buf[198];
        let last_r = buf[199];
        assert!(last_l.abs() < 1e-6 && last_r.abs() < 1e-6);
        assert_eq!(s.global_gain(), 0.0);
    }

    #[test]
    fn set_global_gain_ramp_is_linear_at_midpoint() {
        // ランプ 100 フレームで 1.0 → 0.0 の場合、50 フレーム目の直後のゲインは
        // 約 0.5 であること（線形ランプの検証）。後半 50 フレームで 0 に達する。
        let mut s = Scheduler::new(48_000, 2);
        // 定数 0.5 の mono→stereo サンプル 200 フレーム
        let sample = Sample::new(vec![0.5f32; 200 * 2], 48_000, 2);
        s.schedule(ScheduledSample::new(0.0, sample));
        s.set_global_gain(0.0, 100);

        // 最初の 50 フレームを render
        let mut buf = vec![0.0f32; 100]; // 50 frames
        s.render(&mut buf);
        // 50 frames 経過後の global_gain は 0.5 付近
        assert!((s.global_gain() - 0.5).abs() < 0.02, "{}", s.global_gain());
    }

    #[test]
    fn set_global_gain_clamps_negative_to_zero() {
        let mut s = Scheduler::new(48_000, 2);
        s.set_global_gain(-0.5, 0);
        assert_eq!(s.global_gain(), 0.0);
    }
}
