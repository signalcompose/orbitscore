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
    pub(crate) output_sample_rate: u32,
    pub(crate) output_channels: u16,
    events: Vec<ActiveSample>,
    /// 出力ストリーム上の現在位置（サンプルフレーム単位）
    cursor_frames: u64,
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
        }
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

        self.cursor_frames += frames_to_render as u64;
        // 再生完了したもの（= すべてのフレームを読み終えたもの）をドロップ。
        // まだ開始時刻に到達していないイベントは read_pos == 0 のため自然に保持される。
        self.events.retain(|a| a.read_pos < a.sample.frames());
    }

    /// 現在の出力ストリーム時刻（秒）
    pub fn now_sec(&self) -> f64 {
        self.cursor_frames as f64 / self.output_sample_rate as f64
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
}
