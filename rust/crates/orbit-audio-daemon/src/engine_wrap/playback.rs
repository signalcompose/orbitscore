//! `EngineWrap` のサンプル再生・トランスポート・オフライン render（#888 子 1・第 3 束）。
//!
//! 🔴 **これは純粋な移動である。** `engine_wrap.rs` の `impl EngineWrap` から
//! そのまま移しただけで、本文は 1 行も書き換えていない。
//!
//! 親の子モジュールなので `EngineWrap` の private フィールドに到達できる（可視性の変更 0 件）。
//! 対応するインラインテストは `engine_wrap.rs` に残す（コード行に数えられないので目標に寄与しない）。

use super::*;

impl EngineWrap {
    /// ファイルをロードし sample_id を返す。
    pub fn load_sample(&self, path: PathBuf) -> Result<LoadedSample, WrapError> {
        let sample = load_sample_resampled(&path, self.sample_rate)?;
        let id = format!("s-{}", short_uuid());
        let info = LoadedSample {
            sample_id: id.clone(),
            frames: sample.frames(),
            channels: sample.channels,
            sample_rate: sample.sample_rate,
        };
        self.lock_samples()?.insert(id, sample);
        Ok(info)
    }

    pub fn unload_sample(&self, sample_id: &str) -> Result<(), WrapError> {
        if self.lock_samples()?.remove(sample_id).is_some() {
            Ok(())
        } else {
            Err(WrapError::SampleNotFound(sample_id.to_string()))
        }
    }

    /// sample を現在時刻 + offset でスケジュール。
    ///
    /// `time_sec` は daemon 起動からの経過秒（Engine transport 基準）。
    /// `pan` は [-1.0, 1.0]（0.0 = 中央、範囲外は core で clamp）。
    /// `offset_sec` / `duration_sec` は再生領域（`chop` の slice）。`duration_sec <= 0` で
    /// 「offset 以降すべて」。いずれもサンプル端で clamp。
    /// `rate` は varispeed（1.0 = 自然尺、>1 = 速く短く高ピッチ、<1 = 遅く長く低ピッチ。
    /// `<=0`/非有限は core で 1.0 に丸め）。
    /// `channel` は出力先 channel 名（LinkAudio outputChannel・#209）。`None` = 既定
    /// （unrouted / hardware sum）。同名 channel の event は per-channel render で加算合成される。
    /// 戻り値の `duration_sec` は **実際に再生される区間の出力尺**（slice 実尺 / rate）なので、
    /// 呼び出し側は PlayEnded を再生終端（varispeed 後の出力終端）に合わせて遅延送信できる。
    #[allow(clippy::too_many_arguments)]
    pub fn play_at(
        &self,
        sample_id: &str,
        time_sec: f64,
        gain: f32,
        pan: f32,
        offset_sec: f64,
        duration_sec: f64,
        rate: f64,
        channel: Option<String>,
    ) -> Result<PlayHandle, WrapError> {
        let sample = self
            .lock_samples()?
            .get(sample_id)
            .cloned()
            .ok_or_else(|| WrapError::SampleNotFound(sample_id.to_string()))?;
        let sr = sample.sample_rate as f64;
        let total_frames = sample.frames();
        // サンプル内オフセット / slice 長（フレーム）。0 = offset 以降すべて。
        // サンプル端 clamp は resolve_slice_region に集約する。
        let offset_frames = (offset_sec.max(0.0) * sr) as usize;
        let requested_len_frames = if duration_sec > 0.0 {
            (duration_sec * sr).round() as usize
        } else {
            0
        };
        // 再生領域を clamp。render が読む source 尺（effective_len_frames）は rate に依らず
        // 不変で、scheduler の render と同一式（resolve_slice_region）を共有する。
        let (slice_start_frame, effective_len_frames) =
            resolve_slice_region(total_frames, offset_frames, requested_len_frames);
        // PlayEnded 用の **出力**尺は varispeed で source 尺 / rate になる（render の出力尺と一致）。
        // core と同じ sanitize_rate で正規化し、出力尺の規約を一致させる。
        let out_duration_sec = effective_len_frames as f64 / sr / sanitize_rate(rate);
        let play_id = format!("p-{}", short_uuid());
        self.engine
            .schedule_with_play_id(
                time_sec,
                gain,
                pan,
                slice_start_frame,
                // clamp 済みの実尺を渡す。生の requested_len_frames を渡すと、render 尺と
                // PlayEnded 尺の一致が scheduler 内の再 clamp に依存してしまう（latent な desync）。
                effective_len_frames,
                rate,
                channel,
                play_id.clone(),
                sample,
            )
            .map_err(|e| WrapError::Scheduler(e.to_string()))?;
        Ok(PlayHandle {
            play_id,
            start_sec: time_sec,
            duration_sec: out_duration_sec,
        })
    }

    /// 全アクティブ再生を即時停止する hard-stop-all。停止件数を返す。
    /// daemon が保持する disposable な voice（in-flight one-shot / varispeed の長尺 slice）を
    /// respawn / stopAll で一括 drop する。PlayEnded 抑制集合は触らない（停止された voice の
    /// PlayEnded 遅延タスクはそのまま発火しうるが、consumer 側が play_id 不在で無害に無視する）。
    pub fn stop_all(&self) -> Result<usize, WrapError> {
        self.engine
            .stop_all()
            .map_err(|e| WrapError::Scheduler(e.to_string()))
    }

    /// `play_id` に一致するアクティブ再生を停止する。true = 停止、false = 見つからず。
    ///
    /// 停止成功時は `stopped_play_ids` にも記録し、PlayEnded 遅延タスクに
    /// 自然発火を抑制させる（take_play_ended_suppressed で消費される）。
    pub fn stop(&self, play_id: &str) -> Result<bool, WrapError> {
        let stopped = self
            .engine
            .stop(play_id)
            .map_err(|e| WrapError::Scheduler(e.to_string()))?;
        if stopped {
            self.stopped_play_ids
                .lock()
                .map_err(|_| WrapError::Scheduler("stopped_play_ids mutex poisoned".to_string()))?
                .insert(play_id.to_string());
        }
        Ok(stopped)
    }

    /// PlayEnded 送信直前に呼ぶ。Stop によって停止された `play_id` なら true を返し、
    /// 該当エントリを remove する。呼び出し側は true なら PlayEnded の送出をスキップする。
    pub fn take_play_ended_suppressed(&self, play_id: &str) -> bool {
        match self.stopped_play_ids.lock() {
            Ok(mut s) => s.remove(play_id),
            // poisoned は非致命的エラー扱い: 抑制されていない前提で PlayEnded を送出する。
            // poison 状態は通常発生せず、発生した場合は Stop 後に PlayEnded が漏れるため
            // post-mortem の根拠として warn! を残す。
            Err(_) => {
                tracing::warn!(
                    play_id = %play_id,
                    "stopped_play_ids mutex poisoned; PlayEnded suppression disabled for this id"
                );
                false
            }
        }
    }

    /// 読み取り専用カウンタ。poisoned 時は fallback として 0 を返す。
    ///
    /// poison 時は GetStatus などで「サンプル未ロード」に見える根因を示すため
    /// warn! を残す。
    pub fn loaded_sample_count(&self) -> usize {
        match self.samples.lock() {
            Ok(guard) => guard.len(),
            Err(_) => {
                tracing::warn!(
                    "samples mutex poisoned; loaded_sample_count returning 0 (GetStatus will misreport)"
                );
                0
            }
        }
    }

    /// transport 時刻（audio callback 駆動）を優先し、未起動時のみ wall-clock にフォールバック。
    pub fn transport_or_uptime_sec(&self) -> f64 {
        self.engine.now_sec().unwrap_or_else(|| self.uptime_sec())
    }

    /// `render_offline` / `render_offline_channel` の共通本体。`render_fn` で 1 block 分の
    /// 描画（全 channel / channel filter）を切り替える。`block_frames` 単位で回すことで、
    /// 実 callback と同様にイベントが block 境界をまたぐ経路も通す。
    ///
    /// `block_frames == 0` は panic（テストハーネス用途なので不正設定は早期に落とす）。
    fn render_offline_inner(
        &self,
        total_frames: usize,
        block_frames: usize,
        mut render_fn: impl FnMut(&mut [f32]),
    ) -> Vec<f32> {
        assert!(block_frames > 0, "render_offline: block_frames must be > 0");
        let channels = self.channels as usize;
        let mut data = Vec::with_capacity(total_frames * channels);
        let mut block = vec![0.0f32; block_frames * channels];
        let mut rendered = 0usize;
        while rendered < total_frames {
            let this_frames = block_frames.min(total_frames - rendered);
            let buf = &mut block[..this_frames * channels];
            render_fn(buf);
            data.extend_from_slice(buf);
            rendered += this_frames;
        }
        data
    }

    /// 検証ハーネス（#311 phase 2）用: スケジュール済みイベントを cpal を介さず
    /// オフラインで `total_frames` 分 render し、interleaved f32 PCM を返す。
    ///
    /// 本番経路（cpal callback）とは独立した test-only API。`Engine::render` は内部で
    /// `try_lock` するが、オフライン単スレッド駆動では競合がなく常に成功する。
    /// `play_at` 由来の sec→frame 変換 / `resolve_slice_region` を経た出力を捕捉できる
    /// （phase 1 の Scheduler 直接駆動が飛ばした層）。
    #[doc(hidden)]
    pub fn render_offline(&self, total_frames: usize, block_frames: usize) -> Vec<f32> {
        self.render_offline_inner(total_frames, block_frames, |buf| self.engine.render(buf))
    }

    /// `render_offline` の channel filter 版（LinkAudio per-channel 受信側の決定論検証・層A）。
    /// 指定 channel 名に属する event だけをオフラインで決定論レンダする。同名 channel は
    /// 加算合成される（sum-by-name）。1 つの wrap で複数 channel を続けて tap すると transport が
    /// 二重に進むため（[`orbit_audio_core::Scheduler::render_channel`] 参照）、検証は channel
    /// ごとに fresh な wrap を使うこと。
    #[doc(hidden)]
    pub fn render_offline_channel(
        &self,
        channel: &str,
        total_frames: usize,
        block_frames: usize,
    ) -> Vec<f32> {
        self.render_offline_inner(total_frames, block_frames, |buf| {
            self.engine.render_channel(buf, channel)
        })
    }

    /// マスターゲインを設定する。PR-O3b では従来どおり atomic だけを更新し、RT 専有の
    /// `gain_current` を呼び出し間で連続させる。master line への写しは、TS の
    /// `global.gain()` を `SetBusLine("master", …)` へ切り替え、再 publish 時に実効値を引き継ぐ
    /// PR-O4 と同時に入れる。`orbit_audio_core::Engine::set_global_gain`（core の scheduler ramp）は
    /// production から呼ばない（`docs/design/611-output-line-design.md` §4.2/§5.1）。`ramp_sec` は
    /// wire 互換のため受け続けるが、native 側は構築時に確定した固定 ~5ms/block のランプを使う。
    pub fn set_global_gain(&self, value: f32, _ramp_sec: f64) -> Result<(), WrapError> {
        self.master_gain.store(value.to_bits(), Ordering::Relaxed);
        Ok(())
    }

    /// audio stream の稼働統計スナップショット（StreamStats event 用）。
    pub fn stream_stats_snapshot(&self) -> StreamStatsSnapshot {
        self.stream_stats.snapshot()
    }

    /// GetStatus 用の現在の実効 stream 構成。1 回の lock で3フィールドを整合したまま複製する。
    pub fn stream_config_snapshot(&self) -> StreamConfigSnapshot {
        match self.stream_config.lock() {
            Ok(snapshot) => snapshot.clone(),
            Err(poisoned) => {
                tracing::warn!(
                    "stream config mutex poisoned; reporting the last stored stream configuration"
                );
                poisoned.into_inner().clone()
            }
        }
    }

    /// 1 Hz ticker が直近区間の callback 前進有無を書き込む。
    pub(crate) fn set_callback_alive(&self, alive: bool) {
        self.callback_alive.store(alive, Ordering::Relaxed);
    }

    /// GetStatus は時間窓を作らず、1 Hz ticker が確定した値だけを読む。
    pub fn callback_alive(&self) -> bool {
        self.callback_alive.load(Ordering::Relaxed)
    }

    /// `samples` Mutex を poisoned-safe に取得する。
    /// poisoned 時は `WrapError::Scheduler` に変換して呼び出し側に明示的に通知する。
    fn lock_samples(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, Sample>>, WrapError> {
        self.samples
            .lock()
            .map_err(|_| WrapError::Scheduler("samples mutex poisoned".to_string()))
    }
}

// ── #888 子 1 のレビュー（altitude）を受けて `engine_wrap.rs` から移した。
// 生成元（`load_sample`）がこのモジュールなので、親に置く理由が無い。純粋な移動である。
// 🔴 `session.rs` が型名を書かずに（型推論で）使っているため `pub` のまま親から
// 再エクスポートする。名前での grep には掛からない消費者がいる。
pub struct LoadedSample {
    pub sample_id: String,
    pub frames: usize,
    pub channels: u16,
    pub sample_rate: u32,
}
