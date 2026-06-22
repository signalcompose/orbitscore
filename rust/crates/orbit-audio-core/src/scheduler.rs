//! Scheduler: 指定時刻にサンプルを発音するイベントリストを管理する。

use super::Sample;

/// 単一のスケジュール済みサンプルイベント。
#[derive(Debug, Clone)]
pub struct ScheduledSample {
    /// 発音開始時刻（出力ストリーム時間軸、秒）
    pub start_sec: f64,
    /// ゲイン係数（線形、1.0 = unity）
    pub gain: f32,
    /// パン定位（[-1.0, 1.0]、0.0 = 中央）。SC の `Pan2` と同じ等パワー則で適用する。
    pub pan: f32,
    /// 再生開始フレーム（サンプル内オフセット）。0 = 先頭。`chop` の slice 開始位置。
    pub slice_start_frame: usize,
    /// 再生フレーム数（slice 長）。0 = `slice_start_frame` 以降すべて。`chop` の slice 長。
    pub slice_len_frames: usize,
    /// 再生レート（varispeed）。1.0 = 自然尺、>1 = 速く（短く・高ピッチ）、<1 = 遅く（長く・
    /// 低ピッチ）。source を `rate` 倍の歩幅で分数走査し線形補間する（SC `PlayBuf.ar(rate:)`
    /// 一致）。chop slice をイベントスロット尺へ詰める際に `rate = sliceNatural/slot` を渡す。
    pub rate: f64,
    /// サンプル本体
    pub sample: Sample,
    /// Stop 命令での個別停止用識別子。`None` なら停止不可（fire-and-forget）。
    pub play_id: Option<String>,
}

impl ScheduledSample {
    pub fn new(start_sec: f64, sample: Sample) -> Self {
        Self {
            start_sec,
            gain: 1.0,
            pan: 0.0,
            slice_start_frame: 0,
            slice_len_frames: 0,
            rate: 1.0,
            sample,
            play_id: None,
        }
    }

    pub fn with_gain(mut self, gain: f32) -> Self {
        self.gain = gain;
        self
    }

    /// 再生レート（varispeed）を設定する。`<= 0` は無効なので 1.0 に丸める（無音化や逆再生を
    /// 誤って起こさない）。逆再生は別 modifier（`reverse()`・#213 系）の領分。
    pub fn with_rate(mut self, rate: f64) -> Self {
        self.rate = if rate.is_finite() && rate > 0.0 { rate } else { 1.0 };
        self
    }

    /// パン定位を設定する（[-1.0, 1.0]、範囲外は render 時に clamp）。
    pub fn with_pan(mut self, pan: f32) -> Self {
        self.pan = pan;
        self
    }

    /// 再生領域（slice）を設定する。`start_frame` はサンプル内オフセット、
    /// `len_frames` は再生フレーム数（0 = `start_frame` 以降すべて）。`chop` 用。
    /// スケジュール時にサンプル端で clamp される。
    pub fn with_region(mut self, start_frame: usize, len_frames: usize) -> Self {
        self.slice_start_frame = start_frame;
        self.slice_len_frames = len_frames;
        self
    }

    pub fn with_play_id(mut self, play_id: String) -> Self {
        self.play_id = Some(play_id);
        self
    }
}

/// 等パワー（equal-power）パン則。SC の `Pan2` と同じく pan=0（中央）で各チャンネル
/// 1/√2 (≈0.707, -3dB)、pan=-1 で左 unity・右 0、pan=+1 で逆。`pan` は範囲外を clamp。
/// 戻り値は (左ゲイン, 右ゲイン)。ステレオ出力以外では呼び出し側で適用しない。
fn equal_power_pan(pan: f32) -> (f32, f32) {
    let pan01 = (pan.clamp(-1.0, 1.0) + 1.0) * 0.5; // [-1,1] -> [0,1]
    let angle = pan01 * std::f32::consts::FRAC_PI_2;
    (angle.cos(), angle.sin())
}

/// 再生領域（slice）をサンプル端で clamp し `(clamped_start, effective_len)` を返す。
/// `offset_frames` をサンプル長で、`requested_len_frames`（0 = offset 以降すべて）を
/// 残りフレーム数で clamp する。`Scheduler::schedule`（render 尺）と daemon の
/// `play_at`（PlayEnded 尺）が同一値になるよう、両者がこの単一式を共有する。
pub fn resolve_slice_region(
    total_frames: usize,
    offset_frames: usize,
    requested_len_frames: usize,
) -> (usize, usize) {
    let start = offset_frames.min(total_frames);
    let len = if requested_len_frames == 0 {
        total_frames - start
    } else {
        requested_len_frames.min(total_frames - start)
    };
    (start, len)
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
    /// 等パワー則で precompute した左右ゲイン。pan は再生中不変なので schedule 時に
    /// 一度だけ求め、RT render では trig 無しで読むだけにする。ステレオ以外は (1.0, 1.0)。
    pan_l: f32,
    pan_r: f32,
    /// 再生領域の開始フレーム（サンプル内オフセット）。`chop` の slice 開始。
    slice_start: usize,
    /// 再生領域の長さ（フレーム数）。サンプル端で clamp 済み。
    slice_len: usize,
    /// 末尾フェードアウトの **出力フレーム数**（クリック防止・SC `orbitPlayBuf` 一致）。
    /// varispeed では出力尺 = slice_len/rate なので、source ではなく出力時間で数える。
    fade_frames: usize,
    /// 再生レート（varispeed）。出力 1 フレームごとに `read_pos` を `rate` 進める。
    rate: f64,
    /// サンプル本体
    sample: Sample,
    /// 再生領域内で次に読む **分数**フレーム位置（0.0..slice_len の相対位置）。varispeed の
    /// 分数走査のため f64。線形補間の基準点になる。
    read_pos: f64,
    /// 個別停止用識別子
    play_id: Option<String>,
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

        // 再生領域（slice）をサンプル端で clamp。len==0 は「offset 以降すべて」。
        // daemon の PlayEnded 尺計算と同一式を共有する（resolve_slice_region）。
        let (slice_start, slice_len) = resolve_slice_region(
            event.sample.frames(),
            event.slice_start_frame,
            event.slice_len_frames,
        );

        // varispeed レート（<=0/非有限は 1.0 に丸め済み・with_rate 保証だが直接 schedule
        // 経路でも安全側に倒す）。
        let rate = if event.rate.is_finite() && event.rate > 0.0 {
            event.rate
        } else {
            1.0
        };

        // 末尾フェードアウト（線形 release）。SC `orbitPlayBuf` の
        // `fadeOut = min(0.008, actualDuration * 0.04)` に一致させクリックを防ぐ。
        // varispeed では出力尺 = slice_len / (sample_rate * rate)。fade は **出力**フレーム
        // 数で数える（render では出力残フレームで判定する）。
        let out_dur_sec = slice_len as f64 / (self.output_sample_rate as f64 * rate);
        let fade_sec = (out_dur_sec * 0.04).min(0.008);
        let fade_frames = (fade_sec * self.output_sample_rate as f64).round() as usize;

        // 等パワーパンの左右ゲインを schedule 時（cold path）に precompute。pan は再生中
        // 不変なので RT render から trig（sin/cos）と output_channels 分岐を追い出す。
        // ステレオ出力でのみ定位し、それ以外（モノ/サラウンド）は素のゲインに戻す。
        let (pan_l, pan_r) = if self.output_channels == 2 {
            equal_power_pan(event.pan)
        } else {
            (1.0, 1.0)
        };

        self.events.push(ActiveSample {
            start_frame,
            gain: event.gain,
            pan_l,
            pan_r,
            slice_start,
            slice_len,
            fade_frames,
            rate,
            sample: event.sample,
            read_pos: 0.0,
            play_id: event.play_id,
        });
    }

    /// `play_id` に一致するアクティブ再生を削除する。true = 削除した, false = 見つからず。
    pub fn stop(&mut self, play_id: &str) -> bool {
        let before = self.events.len();
        self.events
            .retain(|a| a.play_id.as_deref() != Some(play_id));
        self.events.len() < before
    }

    /// 全イベント（発音中 + 開始待機中）を即時削除する hard-stop-all。削除件数を返す。
    /// varispeed の長尺 voice が respawn / stopAll を跨いで鳴り続けるのを断つ
    /// （TS 側はスケジュールの権威を保持し、必要なら再 dispatch する）。
    pub fn stop_all(&mut self) -> usize {
        let n = self.events.len();
        self.events.clear();
        n
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
                active.read_pos = active.slice_len as f64;
                continue;
            }
            if active.read_pos >= active.slice_len as f64 {
                continue; // 再生済み（slice 領域を読み終えた）
            }

            // 出力バッファ内での書き込み開始位置（フレーム単位）
            let dst_offset_frames = if active.start_frame > buf_start {
                (active.start_frame - buf_start) as usize
            } else {
                0
            };

            let writable_frames = frames_to_render.saturating_sub(dst_offset_frames);

            // 左右ゲインは schedule 時に precompute 済み（RT から trig と output_channels
            // 分岐を排除）。ステレオ以外では (1.0, 1.0)。SC の Pan2 に一致。
            let (pan_l, pan_r) = (active.pan_l, active.pan_r);

            let slice_len = active.slice_len;
            let rate = active.rate;
            // 補間の上端 clamp（slice 末尾フレーム）。floor+1 が slice をはみ出さないようにする。
            let last_src = slice_len.saturating_sub(1);

            // 出力フレームを 1 つずつ生成し、source を rate 倍の歩幅で分数走査する（varispeed）。
            // rate=1.0 のときは read_pos が整数列を辿り frac=0 で補間が元サンプルに一致するため、
            // 既存 rate=1.0 経路とビット同一になる（厳密な一般化）。出力尺 = slice_len/rate。
            for i in 0..writable_frames {
                let pos = active.read_pos; // slice 相対の分数読み位置
                if pos >= slice_len as f64 {
                    break; // source 読み切り（残り出力枠は無音にせず発音終了）
                }
                // 線形補間: floor と floor+1 を frac で混合。上端は slice 末尾で clamp。
                let i0 = pos.floor();
                let frac = (pos - i0) as f32;
                let s0 = i0 as usize; // slice 相対の整数フレーム
                let s1 = (s0 + 1).min(last_src);
                let src_frame0 = active.slice_start + s0; // サンプル内の絶対フレーム
                let src_frame1 = active.slice_start + s1;
                let dst_frame = dst_offset_frames + i;

                // 末尾フェードアウト（線形 release・SC `linen` の fadeOut 部）。**出力時間**で
                // 数える: 残り出力フレーム数が fade_frames 以下で 1.0→0.0 へ線形減衰。
                // rate=1.0 では remaining = slice_len-pos となり従来条件と一致する。
                let out_frames_remaining = ((slice_len as f64 - pos) / rate).ceil() as usize;
                let env = if active.fade_frames > 0 && out_frames_remaining <= active.fade_frames {
                    out_frames_remaining as f32 / active.fade_frames as f32
                } else {
                    1.0
                };
                let amp = active.gain * env;
                for ch in 0..output_channels {
                    let src_ch = ch.min(src_channels - 1);
                    let s0_idx = src_frame0 * src_channels + src_ch;
                    let s1_idx = src_frame1 * src_channels + src_ch;
                    // 線形補間した source 値（rate=1.0 では frac=0 で data[s0_idx] と一致）。
                    let sample_val = active.sample.data[s0_idx] * (1.0 - frac)
                        + active.sample.data[s1_idx] * frac;
                    let dst_idx = dst_frame * output_channels + ch;
                    let pan_mul = if ch == 0 { pan_l } else { pan_r };
                    out[dst_idx] += sample_val * amp * pan_mul;
                }
                active.read_pos += rate;
            }
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
        // 再生完了したもの（= slice 領域を読み終えたもの）をドロップ。
        // まだ開始時刻に到達していないイベントは read_pos == 0.0 のため自然に保持される。
        self.events.retain(|a| a.read_pos < a.slice_len as f64);
    }

    /// 現在の出力ストリーム時刻（秒）
    pub fn now_sec(&self) -> f64 {
        self.cursor_frames as f64 / self.output_sample_rate as f64
    }

    pub fn output_sample_rate(&self) -> u32 {
        self.output_sample_rate
    }

    /// 現在保持中のイベント数（開始時刻待機中 + 再生中の両方を含む、完了済は除く）。
    pub fn active_count(&self) -> usize {
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
        assert_eq!(s.active_count(), 1);
    }

    #[test]
    fn played_event_is_dropped() {
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100)));

        // サンプル全体を十分に超える長さを render
        let mut buf = vec![0.0f32; 1000];
        s.render(&mut buf);

        assert_eq!(s.active_count(), 0);
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
        assert_eq!(s.active_count(), 0);
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

        // 0.1 のサンプルが 0.5x global gain でスケールし、さらに pan=0（中央）の等パワー則で
        // 1/√2 ≈ 0.707 が掛かる → 0.1 * 0.5 * 0.7071 ≈ 0.03536。ランプ無しなので一定。
        let peak = buf.iter().cloned().fold(0.0f32, f32::max);
        let expected = 0.1 * 0.5 * std::f32::consts::FRAC_1_SQRT_2;
        assert!((peak - expected).abs() < 1e-5, "peak={peak}");
    }

    #[test]
    fn pan_center_applies_equal_power_minus_3db() {
        // pan=0（既定）→ 各チャンネル 0.1 * 1/√2 ≈ 0.0707（SC Pan2 中央 = -3dB）
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100)));
        let mut buf = vec![0.0f32; 200];
        s.render(&mut buf);
        let expected = 0.1 * std::f32::consts::FRAC_1_SQRT_2;
        assert!((buf[0] - expected).abs() < 1e-5, "L={}", buf[0]);
        assert!((buf[1] - expected).abs() < 1e-5, "R={}", buf[1]);
    }

    #[test]
    fn pan_hard_left_silences_right_channel() {
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100)).with_pan(-1.0));
        let mut buf = vec![0.0f32; 200];
        s.render(&mut buf);
        assert!((buf[0] - 0.1).abs() < 1e-5, "L={}", buf[0]); // 左 unity
        assert!(buf[1].abs() < 1e-6, "R={}", buf[1]); // 右 無音
    }

    #[test]
    fn pan_hard_right_silences_left_channel() {
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100)).with_pan(1.0));
        let mut buf = vec![0.0f32; 200];
        s.render(&mut buf);
        assert!(buf[0].abs() < 1e-6, "L={}", buf[0]); // 左 無音
        assert!((buf[1] - 0.1).abs() < 1e-5, "R={}", buf[1]); // 右 unity
    }

    #[test]
    fn pan_clamps_out_of_range_to_hard_left() {
        // pan < -1 は -1 に clamp → hard left（reject せず UX 優先・protocol 仕様）
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100)).with_pan(-2.0));
        let mut buf = vec![0.0f32; 200];
        s.render(&mut buf);
        assert!((buf[0] - 0.1).abs() < 1e-5, "L={}", buf[0]);
        assert!(buf[1].abs() < 1e-6, "R={}", buf[1]);
    }

    /// フレーム値 = フレーム番号のモノラルサンプル（slice 領域の同定に使う）。
    fn mk_sample_mono_ramp(frames: usize) -> Sample {
        Sample::new((0..frames).map(|i| i as f32).collect(), 48_000, 1)
    }

    #[test]
    fn slice_region_plays_only_the_requested_window() {
        // frame 値 = frame 番号のモノラル素材を region [50, 4] で再生。
        // hard-left（pan=-1）で L = 素材値そのまま、R = 0 になり領域を同定できる。
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(
            ScheduledSample::new(0.0, mk_sample_mono_ramp(200))
                .with_pan(-1.0)
                .with_region(50, 4),
        );
        let mut buf = vec![0.0f32; 20]; // 10 frames
        s.render(&mut buf);
        // L 出力は素材の frame 50,51,52,53、その後は無音。
        assert!((buf[0] - 50.0).abs() < 1e-4, "f0 L={}", buf[0]);
        assert!((buf[2] - 51.0).abs() < 1e-4, "f1 L={}", buf[2]);
        assert!((buf[4] - 52.0).abs() < 1e-4, "f2 L={}", buf[4]);
        assert!((buf[6] - 53.0).abs() < 1e-4, "f3 L={}", buf[6]);
        assert!(buf[8].abs() < 1e-6, "f4 L (region 後)={}", buf[8]);
        assert!(buf[1].abs() < 1e-6, "f0 R (hard-left)={}", buf[1]);
        // 4 フレームの slice を読み終えてイベントは掃除される。
        assert_eq!(s.active_count(), 0);
    }

    #[test]
    fn slice_region_clamps_to_sample_end() {
        // region [195, 100] は素材端（200）で len=5 に clamp され panic しない。
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(
            ScheduledSample::new(0.0, mk_sample_mono_ramp(200))
                .with_pan(-1.0)
                .with_region(195, 100),
        );
        let mut buf = vec![0.0f32; 40]; // 20 frames
        s.render(&mut buf);
        assert!((buf[0] - 195.0).abs() < 1e-4, "f0 L={}", buf[0]);
        assert!((buf[8] - 199.0).abs() < 1e-4, "f4 L={}", buf[8]); // 末尾フレーム
        assert!(buf[10].abs() < 1e-6, "f5 L (clamp 後)={}", buf[10]);
        assert_eq!(s.active_count(), 0);
    }

    #[test]
    fn slice_tail_is_faded_out() {
        // len=100 の slice は fade_frames=4（min(8ms, dur*4%)）。末尾 4 フレームが線形減衰。
        // 定数 1.0 の素材を hard-left で流し、L 出力の末尾が body より小さいことを確認。
        let mut s = Scheduler::new(48_000, 2);
        let sample = Sample::new(vec![1.0f32; 100], 48_000, 1);
        s.schedule(ScheduledSample::new(0.0, sample).with_pan(-1.0).with_region(0, 100));
        let mut buf = vec![0.0f32; 200]; // 100 frames
        s.render(&mut buf);
        // body（fade 開始 96 より前）は 1.0。
        assert!((buf[0] - 1.0).abs() < 1e-5, "f0 L={}", buf[0]);
        assert!((buf[2 * 95] - 1.0).abs() < 1e-5, "f95 L={}", buf[2 * 95]);
        // 末尾フェード: frame97 ≈ 0.75, frame99 ≈ 0.25（線形 1→0）。
        assert!((buf[2 * 97] - 0.75).abs() < 1e-4, "f97 L={}", buf[2 * 97]);
        assert!((buf[2 * 99] - 0.25).abs() < 1e-4, "f99 L={}", buf[2 * 99]);
    }

    #[test]
    fn resolve_slice_region_clamps_offset_and_len() {
        // scheduler の render 尺と daemon の PlayEnded 尺が共有する単一式。境界を直接 pin する。
        // offset == total → start=total, len=0（`total - start` の usize underflow を防ぐ）
        assert_eq!(resolve_slice_region(100, 100, 0), (100, 0));
        assert_eq!(resolve_slice_region(100, 100, 50), (100, 0));
        // offset > total → total で clamp
        assert_eq!(resolve_slice_region(100, 150, 10), (100, 0));
        // offset=0, len=0 → 全体
        assert_eq!(resolve_slice_region(100, 0, 0), (0, 100));
        // offset>0, len=0 → offset 以降すべて
        assert_eq!(resolve_slice_region(100, 30, 0), (30, 70));
        // requested > remaining → remaining で clamp
        assert_eq!(resolve_slice_region(100, 30, 1000), (30, 70));
    }

    #[test]
    fn slice_region_stereo_source_reads_correct_channel_frames() {
        // ステレオ素材で frame i の L=i, R=i+0.5。region [4,3] で frame 4,5,6 を読む。
        // 中央パン（各 ch 1/√2 倍）で、L が L サンプル・R が R サンプルを読む
        // （channel stride = src_frame*channels + ch が正しい）ことを確認する。
        let frames = 20usize;
        let data: Vec<f32> = (0..frames).flat_map(|i| [i as f32, i as f32 + 0.5]).collect();
        let sample = Sample::new(data, 48_000, 2);
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(
            ScheduledSample::new(0.0, sample)
                .with_pan(0.0)
                .with_region(4, 3),
        );
        let mut buf = vec![0.0f32; 40]; // 20 frames stereo
        s.render(&mut buf);
        let k = std::f32::consts::FRAC_1_SQRT_2;
        // 出力 frame 0 = 素材 frame 4: L=4.0, R=4.5（ch を取り違えていれば落ちる）
        assert!((buf[0] - 4.0 * k).abs() < 1e-4, "f4 L={}", buf[0]);
        assert!((buf[1] - 4.5 * k).abs() < 1e-4, "f4 R={}", buf[1]);
        // 出力 frame 1 = 素材 frame 5: L=5.0
        assert!((buf[2] - 5.0 * k).abs() < 1e-4, "f5 L={}", buf[2]);
        // 出力 frame 3 は region（3 フレーム）外 → 無音
        assert!(buf[6].abs() < 1e-5, "f7 L (region 後)={}", buf[6]);
        assert_eq!(s.active_count(), 0);
    }

    #[test]
    fn varispeed_rate_one_is_sample_exact() {
        // rate=1.0 を明示しても frac=0 の補間で元サンプルにビット一致する（厳密な一般化）。
        // ramp[i]=i を hard-left（L=源値）で流し、L 出力 = 0,1,2,...,9 を確認。
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(
            ScheduledSample::new(0.0, mk_sample_mono_ramp(10))
                .with_pan(-1.0)
                .with_region(0, 10)
                .with_rate(1.0),
        );
        let mut buf = vec![0.0f32; 40]; // 20 frames
        s.render(&mut buf);
        for i in 0..10 {
            assert!((buf[2 * i] - i as f32).abs() < 1e-4, "f{i} L={}", buf[2 * i]);
        }
        assert_eq!(s.active_count(), 0);
    }

    #[test]
    fn varispeed_double_rate_halves_output_and_steps_by_two() {
        // rate=2.0: source を 2 フレーム歩幅で読む → 出力尺が半分、L 出力 = 0,2,4,6
        // （= source[0,2,4,6]）。pitch が 1 オクターブ上がる varispeed の直接検証。
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(
            ScheduledSample::new(0.0, mk_sample_mono_ramp(8))
                .with_pan(-1.0)
                .with_region(0, 8)
                .with_rate(2.0),
        );
        let mut buf = vec![0.0f32; 40]; // 20 frames
        s.render(&mut buf);
        assert!((buf[0] - 0.0).abs() < 1e-4, "f0 L={}", buf[0]);
        assert!((buf[2] - 2.0).abs() < 1e-4, "f1 L={}", buf[2]);
        assert!((buf[4] - 4.0).abs() < 1e-4, "f2 L={}", buf[4]);
        assert!((buf[6] - 6.0).abs() < 1e-4, "f3 L={}", buf[6]);
        // 出力 4 フレーム（ceil(8/2)）で source 読み切り → f4 以降は無音。
        assert!(buf[8].abs() < 1e-6, "f4 L (読み切り後)={}", buf[8]);
        assert_eq!(s.active_count(), 0);
    }

    #[test]
    fn varispeed_half_rate_doubles_output_with_interpolation() {
        // rate=0.5: source を 0.5 フレーム歩幅で読む → 出力尺が倍、L 出力 = 0,0.5,1,1.5,...
        // （線形補間値）。pitch が 1 オクターブ下がる varispeed の直接検証。
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(
            ScheduledSample::new(0.0, mk_sample_mono_ramp(4))
                .with_pan(-1.0)
                .with_region(0, 4)
                .with_rate(0.5),
        );
        let mut buf = vec![0.0f32; 40]; // 20 frames
        s.render(&mut buf);
        assert!((buf[0] - 0.0).abs() < 1e-4, "f0 L={}", buf[0]);
        assert!((buf[2] - 0.5).abs() < 1e-4, "f1 L={}", buf[2]); // 補間
        assert!((buf[4] - 1.0).abs() < 1e-4, "f2 L={}", buf[4]);
        assert!((buf[6] - 1.5).abs() < 1e-4, "f3 L={}", buf[6]); // 補間
        assert!((buf[8] - 2.0).abs() < 1e-4, "f4 L={}", buf[8]);
        // 出力 8 フレーム（4/0.5）で読み切り → f8 以降は無音。
        assert!(buf[16].abs() < 1e-6, "f8 L (読み切り後)={}", buf[16]);
        assert_eq!(s.active_count(), 0);
    }

    #[test]
    fn varispeed_invalid_rate_falls_back_to_one() {
        // rate<=0 / 非有限は with_rate が 1.0 に丸める（無音化や逆走を誤って起こさない）。
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(
            ScheduledSample::new(0.0, mk_sample_mono_ramp(6))
                .with_pan(-1.0)
                .with_region(0, 6)
                .with_rate(0.0),
        );
        let mut buf = vec![0.0f32; 40];
        s.render(&mut buf);
        // rate=1.0 として 0,1,2,3,4,5 が出る。
        assert!((buf[0] - 0.0).abs() < 1e-4, "f0 L={}", buf[0]);
        assert!((buf[2] - 1.0).abs() < 1e-4, "f1 L={}", buf[2]);
        assert_eq!(s.active_count(), 0);
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
    fn stop_removes_matching_play_id() {
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(
            ScheduledSample::new(1.0, mk_sample_stereo(100))
                .with_play_id("p-a".to_string()),
        );
        s.schedule(
            ScheduledSample::new(2.0, mk_sample_stereo(100))
                .with_play_id("p-b".to_string()),
        );
        assert_eq!(s.active_count(), 2);
        assert!(s.stop("p-a"));
        assert_eq!(s.active_count(), 1);
        assert!(!s.stop("p-a"));
        assert!(s.stop("p-b"));
        assert_eq!(s.active_count(), 0);
    }

    #[test]
    fn stop_ignores_unknown_id() {
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100)));
        assert!(!s.stop("does-not-exist"));
        assert_eq!(s.active_count(), 1);
    }

    #[test]
    fn stop_all_clears_every_event() {
        // play_id 有無に依らず、発音中も開始待機中も全消去する（hard-stop-all）。
        let mut s = Scheduler::new(48_000, 2);
        s.schedule(ScheduledSample::new(0.0, mk_sample_stereo(100))); // play_id 無し
        s.schedule(
            ScheduledSample::new(5.0, mk_sample_stereo(100)).with_play_id("p-a".to_string()),
        );
        assert_eq!(s.active_count(), 2);
        assert_eq!(s.stop_all(), 2);
        assert_eq!(s.active_count(), 0);
        // 空に対しては 0 を返す（冪等）。
        assert_eq!(s.stop_all(), 0);
    }

    #[test]
    fn set_global_gain_clamps_negative_to_zero() {
        let mut s = Scheduler::new(48_000, 2);
        s.set_global_gain(-0.5, 0);
        assert_eq!(s.global_gain(), 0.0);
    }
}
