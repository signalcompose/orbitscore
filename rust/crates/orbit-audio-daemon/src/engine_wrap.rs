//! Engine + ロード済みサンプル / 再生管理の wrapper。
//!
//! `Arc<Mutex>` ベースで制御スレッドと audio callback を共有する。
//! audio callback 側は `try_lock` で競合時に無音 fallback する前提（lock-free 化は別 Issue）。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use orbit_audio_core::{resolve_slice_region, sanitize_rate, Engine, Sample};
use orbit_audio_native::{
    load_sample_resampled, LoaderError, OutputError, OutputStream, ResampleError, StreamStats,
    StreamStatsSnapshot,
};
use uuid::Uuid;

use crate::backend::AudioBackend;

#[derive(Debug, thiserror::Error)]
pub enum WrapError {
    #[error("audio output init failed: {0}")]
    Output(#[from] OutputError),
    #[error("loader error: {0}")]
    Loader(#[from] LoaderError),
    #[error("resample error: {0}")]
    Resample(#[from] ResampleError),
    #[error("sample not found: {0}")]
    SampleNotFound(String),
    #[error("scheduler error: {0}")]
    Scheduler(String),
    /// LinkAudio egress がこの daemon ビルド/インスタンスで利用できない（feature `link-audio` 無効、
    /// または test backend）。TS 層は feature-gap として warn-once で握り潰す（出力は hardware のみ）。
    #[error("link audio unavailable: {0}")]
    LinkAudioUnavailable(String),
    /// LinkAudio egress は利用可能だが registration が runtime で失敗した（channel 上限・consumer thread
    /// 不在・reg-ring 満杯・mutex poison 等）。TS 層は feature-gap と区別して rethrow する。
    #[error("link audio runtime error: {0}")]
    LinkAudio(String),
}

/// 共有可能なエンジン wrapper。
///
/// `cpal::Stream` は `!Send` のため、ここには持ち込まない。
/// [`start`] が返す [`StreamGuard`] を main 側で alive に保つ責務。
pub struct EngineWrap {
    engine: Engine,
    sample_rate: u32,
    channels: u16,
    samples: Mutex<HashMap<String, Sample>>,
    started_at: std::time::Instant,
    stream_stats: Arc<StreamStats>,
    /// Stop 経由で停止済みの play_id。PlayEnded 遅延タスクが自然発火を抑制するために参照する。
    /// PlayEnded 発火時に take（remove）されるため、通常ケースでは事後掃除不要。
    stopped_play_ids: Mutex<HashSet<String>>,
    /// LinkAudio egress drop の **test 注入用** カウンタ（本番は常に 0）。`link_egress_ring_drops`
    /// がこれを加算する。integration test は `StubBackend` を使い `LinkAudioControl` を持たない
    /// （= 実 drop 源が無い）ため、この counter が link-audio feature の有無に依らず 1 Hz ticker の
    /// LINK_EGRESS_DROP 発火を駆動する唯一の seam になる（[`Self::link_egress_drops_arc`]）。
    /// 本番の drop は `LinkAudioControl::total_ring_drops`（GPL `link-audio` 側）が供給するので、
    /// production read-path ではこの addend は常に 0。`stream_stats` の `record_xrun`（本番と同一
    /// atomic を書く統合 seam）とは異なり、これは本番経路から分離した並行カウンタである点に注意。
    link_egress_drops: Arc<AtomicU64>,
    /// LinkAudio egress の control-side ハンドル（feature `link-audio` 専用・A4-2b-2）。
    /// reg-ring push / mpsc send が内部可変性（`&mut LinkAudioControl`）を要する一方、`EngineWrap`
    /// は `Arc` 共有で `&self` しか持てない。`Mutex` で内包することで `register_link_audio_channel`
    /// を `&self` のまま提供する。本番 `start()` で `Some`、test backend 経路では `None`。
    #[cfg(feature = "link-audio")]
    link: Mutex<Option<crate::link_audio::LinkAudioControl>>,
}

/// `cpal::Stream` を保持する guard。drop されるとストリーム停止。`!Send`。
///
/// feature `link-audio` 時は LinkAudio consumer thread の teardown guard も保持する。
/// **field 順は load-bearing ではないが意図的**（advisor #2）: `_stream` を先に drop して cpal
/// callback（ring の push 元）を止めてから `_link`（consumer thread を signal+join）を drop する。
/// rtrb はどちらの順でも UB にならない（逆順なら callback が undrained ring に push して drop
/// カウントするだけ）が、teardown 時の無駄な drop を避けるためこの順にしてある。reorder 禁止。
pub struct StreamGuard {
    _stream: OutputStream,
    #[cfg(feature = "link-audio")]
    _link: Option<crate::link_audio::LinkAudioGuard>,
}

impl EngineWrap {
    /// Engine とストリーム guard を起動する（本番用、cpal 既定出力）。
    /// guard は caller（通常は main）が drop されるまで保持すること。
    ///
    /// 本番経路は `cpal::Stream` が `!Send` のため [`Self::start_with`] の
    /// `Box<dyn Any + Send>` guard 型に詰められない。そのため本番は専用パス。
    #[cfg(not(feature = "link-audio"))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let (engine, stream, stream_stats) = orbit_audio_native::start_default_output()?;
        let wrap = Self::build(engine, stream.sample_rate, stream.channels, stream_stats);
        Ok((wrap, StreamGuard { _stream: stream }))
    }

    /// feature `link-audio` 版: cpal 出力を LinkAudio egress 経路付きで起動し、GPL consumer thread を
    /// spawn する（A4-2b-2）。reg-ring producer は callback に組み込まれ、`register_link_audio_channel`
    /// 経由で channel を流す。返す `StreamGuard` が consumer thread の teardown guard を保持する。
    #[cfg(feature = "link-audio")]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let (engine, stream, stream_stats, reg_tx) =
            orbit_audio_native::start_default_output_with_link_egress(
                crate::link_audio::REG_RING_CAPACITY,
            )?;
        let (control, link_guard) = crate::link_audio::LinkAudioControl::spawn(
            reg_tx,
            stream.sample_rate,
            stream.channels as usize,
        )
        .map_err(|e| WrapError::LinkAudio(e.to_string()))?;
        let wrap = Self::build(engine, stream.sample_rate, stream.channels, stream_stats);
        *wrap
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))? = Some(control);
        Ok((
            wrap,
            StreamGuard {
                _stream: stream,
                _link: Some(link_guard),
            },
        ))
    }

    /// [`AudioBackend`] 経由で起動する（integration test 用）。
    ///
    /// guard は `Box<dyn Any + Send>` の不透明ハンドル。scope 終了まで
    /// drop せずに保持する必要がある。
    pub fn start_with<B: AudioBackend>(
        backend: B,
    ) -> Result<(Arc<Self>, Box<dyn std::any::Any + Send>), WrapError> {
        let started = backend.start()?;
        let wrap = Self::build(
            started.engine,
            started.sample_rate,
            started.channels,
            started.stats,
        );
        Ok((wrap, started.guard))
    }

    /// `start` / `start_with` 共通の Arc<Self> 構築部。新しいフィールドが
    /// 追加された際、両経路で初期化漏れが起きないよう一箇所に集約する。
    fn build(
        engine: Engine,
        sample_rate: u32,
        channels: u16,
        stream_stats: Arc<StreamStats>,
    ) -> Arc<Self> {
        Arc::new(Self {
            engine,
            sample_rate,
            channels,
            samples: Mutex::new(HashMap::new()),
            started_at: std::time::Instant::now(),
            stream_stats,
            stopped_play_ids: Mutex::new(HashSet::new()),
            link_egress_drops: Arc::new(AtomicU64::new(0)),
            // 本番 `start()`（feature 時）が spawn 後に Some を注入する。test backend 経路は None。
            #[cfg(feature = "link-audio")]
            link: Mutex::new(None),
        })
    }

    /// 名前付き LinkAudio channel を登録する（A4-2b-2・feature `link-audio` 専用）。
    /// `RingTapSink` を生成し sink を cpal callback へ・consumer side を GPL consumer thread へ配る。
    #[cfg(feature = "link-audio")]
    pub fn register_link_audio_channel(&self, name: &str) -> Result<(), WrapError> {
        // mutex poison は egress 利用可能だが runtime で壊れた状態 → runtime error。
        let mut guard = self
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))?;
        match guard.as_mut() {
            // registration の失敗（channel 上限・consumer 不在・reg-ring 満杯）は runtime error。
            Some(ctl) => ctl
                .register_channel(name)
                .map_err(|e| WrapError::LinkAudio(e.to_string())),
            // egress 経路が無い（test backend）= unavailable（feature-gap と同じ扱い）。
            None => Err(WrapError::LinkAudioUnavailable(
                "link audio not initialized (test backend has no egress path)".into(),
            )),
        }
    }

    /// feature `link-audio` 無効ビルド用の stub。daemon command handler を feature 非依存に保つ。
    #[cfg(not(feature = "link-audio"))]
    pub fn register_link_audio_channel(&self, _name: &str) -> Result<(), WrapError> {
        Err(WrapError::LinkAudioUnavailable(
            "engine built without 'link-audio' feature".into(),
        ))
    }

    /// Link セッションに tempo(BPM)を push し OrbitScore を tempo leader にする（PR3・#333）。
    /// `LinkAudioControl::set_tempo` は内部で `captureAppSessionState`（非RT・block しうる）を呼ぶので、
    /// daemon WS handler は **spawn_blocking** で audio スレッド以外に隔離すること（session.rs）。tempo は
    /// `LinkTempoControl`（`Arc<LinkAudioOutput>`）経由なので `&self` で足りる（register と違い `as_ref`）。
    #[cfg(feature = "link-audio")]
    pub fn set_link_tempo(&self, bpm: f64) -> Result<(), WrapError> {
        // mutex poison は egress 利用可能だが runtime で壊れた状態 → runtime error。
        let guard = self
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))?;
        match guard.as_ref() {
            Some(ctl) => {
                ctl.set_tempo(bpm);
                Ok(())
            }
            // egress 経路が無い（test backend）= unavailable（TS は warn-once で握り潰す）。
            None => Err(WrapError::LinkAudioUnavailable(
                "link audio not initialized (test backend has no egress path)".into(),
            )),
        }
    }

    /// feature `link-audio` 無効ビルド用の stub。TS は UNAVAILABLE を warn-once で握り潰す。
    #[cfg(not(feature = "link-audio"))]
    pub fn set_link_tempo(&self, _bpm: f64) -> Result<(), WrapError> {
        Err(WrapError::LinkAudioUnavailable(
            "engine built without 'link-audio' feature".into(),
        ))
    }

    /// 全 LinkAudio channel の ring overflow drop（interleaved サンプル数）の累積合計（A4-2b-2b）。
    /// daemon の 1 Hz ticker が polling して増加を WARNING event で surface する（非 RT observability）。
    /// link 未初期化（test backend）時は control 分が 0。test 注入分（本番 0）を必ず加える。
    #[cfg(feature = "link-audio")]
    pub fn link_egress_ring_drops(&self) -> u64 {
        // try_lock で ticker をブロックしない。**WouldBlock**（callback / register との一時競合）は
        // 次 tick に持ち越すだけ — counter は cumulative なので drop は失われず後続 tick が全累積を
        // 報告する。**Poisoned** は以降ずっと control 分を 0 に固定し LINK_EGRESS_DROP を session 中
        // 抑制してしまうため、他アクセサ（`loaded_sample_count` 等）と同様 `warn!` で post-mortem の
        // 根拠を残す（contention と poison を `.ok()` で同一視しない）。
        let control_drops = match self.link.try_lock() {
            Ok(g) => g.as_ref().map(|ctl| ctl.total_ring_drops()).unwrap_or(0),
            Err(std::sync::TryLockError::WouldBlock) => 0,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "link mutex poisoned; link_egress_ring_drops reporting 0 for control drops \
                     (LINK_EGRESS_DROP events suppressed until daemon restart)"
                );
                0
            }
        };
        control_drops + self.link_egress_drops.load(Ordering::Relaxed)
    }

    /// feature `link-audio` 無効ビルド用の stub。本番は常に 0（control が無い）。test 注入分のみ反映。
    #[cfg(not(feature = "link-audio"))]
    pub fn link_egress_ring_drops(&self) -> u64 {
        self.link_egress_drops.load(Ordering::Relaxed)
    }

    /// test harness 用: LinkAudio egress drop の注入カウンタを取得する。accessor の形（`Arc` clone を
    /// 返す）は `stream_stats_arc` と同じだが、下層 counter は本番経路から分離した注入専用（本番 0）。
    /// integration test から `fetch_add` して 1 Hz ticker の LINK_EGRESS_DROP 発火を駆動する。
    /// `#[doc(hidden)]` で公開 API としては扱わない。
    #[doc(hidden)]
    pub fn link_egress_drops_arc(&self) -> Arc<AtomicU64> {
        self.link_egress_drops.clone()
    }

    /// test harness 用: `StreamStats` への参照を取得し、外部から
    /// xrun / device_lost を駆動できるようにする。
    ///
    /// 外部 crate (`tests/`) から呼ぶ必要があるため `pub` だが、
    /// `#[doc(hidden)]` で rustdoc からは不可視にし公開 API としては扱わない。
    #[doc(hidden)]
    pub fn stream_stats_arc(&self) -> Arc<StreamStats> {
        self.stream_stats.clone()
    }

    pub fn uptime_sec(&self) -> f64 {
        self.started_at.elapsed().as_secs_f64()
    }

    /// 現在スケジュール中の（まだ完了していない）再生イベント数。
    /// audio callback がロックを握っている瞬間は取得できないので、その場合は 0 を返す。
    pub fn active_play_count(&self) -> usize {
        self.engine.active_count().unwrap_or(0)
    }

    pub fn output_sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// 現在の出力ストリーム時刻（scheduler transport 秒）。`play_at` の `time_sec` と同一座標系。
    /// ロック競合時は `None`（callback がロック保持中）。
    pub fn now_sec(&self) -> Option<f64> {
        self.engine.now_sec()
    }

    pub fn output_channels(&self) -> u16 {
        self.channels
    }

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

    /// マスターゲインを設定する。`ramp_sec` が 0 以下なら即時。
    pub fn set_global_gain(&self, value: f32, ramp_sec: f64) -> Result<(), WrapError> {
        self.engine
            .set_global_gain(value, ramp_sec)
            .map_err(|e| WrapError::Scheduler(e.to_string()))
    }

    /// audio stream の稼働統計スナップショット（StreamStats event 用）。
    pub fn stream_stats_snapshot(&self) -> StreamStatsSnapshot {
        self.stream_stats.snapshot()
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

pub struct LoadedSample {
    pub sample_id: String,
    pub frames: usize,
    pub channels: u16,
    pub sample_rate: u32,
}

pub struct PlayHandle {
    pub play_id: String,
    pub start_sec: f64,
    pub duration_sec: f64,
}

fn short_uuid() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}
