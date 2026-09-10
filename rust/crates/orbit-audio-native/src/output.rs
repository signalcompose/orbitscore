//! cpal を使った既定出力デバイスへのストリーム設定。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use thiserror::Error;

use orbit_audio_core::{equal_power_pan, Engine, FeedDest};

use crate::link_audio_ring::{PostMixSink, RingTapSink};
use crate::post_processor::{CallbackTimeStats, PostProcessor};

/// cpal ストリームから得られる稼働統計。
///
/// err_fn は audio スレッドから呼ばれるため atomic で更新する。
/// `buffer_underruns` は cpal の `StreamError` が underrun を個別に示さないため
/// 常に 0。将来 backend-specific な判別ができるようになれば増分経路を追加する。
///
/// `device_lost` は `cpal::StreamError::DeviceNotAvailable` を受け取った際に
/// true にセットされ、上位 (daemon session) が 1 Hz ticker で polling して
/// fatal DaemonError イベントを発火するためのフラグ。一度 true になったら
/// 現 stream は回復不能なので、set 後の再初期化は scope 外。
#[derive(Debug, Default)]
pub struct StreamStats {
    xruns: AtomicU64,
    buffer_underruns: AtomicU64,
    device_lost: AtomicBool,
    render_contentions: AtomicU64,
    /// コールバックが 1 回回るごとに +1 する生存カウンタ。
    callbacks: AtomicU64,
    /// 直近コールバックで受け取った 1 channel あたりの frame 数。
    last_frames: AtomicU32,
}

impl StreamStats {
    pub fn snapshot(&self) -> StreamStatsSnapshot {
        StreamStatsSnapshot {
            xruns: self.xruns.load(Ordering::Relaxed),
            buffer_underruns: self.buffer_underruns.load(Ordering::Relaxed),
            device_lost: self.device_lost.load(Ordering::Relaxed),
            render_contentions: self.render_contentions.load(Ordering::Relaxed),
            callbacks: self.callbacks.load(Ordering::Relaxed),
            last_frames: self.last_frames.load(Ordering::Relaxed),
        }
    }

    /// RT callback の入口で生存回数と実効 frame 数を記録する。
    /// 実装は Relaxed atomic 2 回だけで、確保・ロック・syscall を行わない。
    #[doc(hidden)]
    pub fn record_callback(&self, frames: u32) {
        self.callbacks.fetch_add(1, Ordering::Relaxed);
        self.last_frames.store(frames, Ordering::Relaxed);
    }

    /// xrun カウンタを 1 増やす。
    ///
    /// 通常は [`StreamStats::record_error`] 経由で自動的に呼ばれる。
    /// `#[doc(hidden)] pub` は integration test から xrun 発生を再現する
    /// ために半公開にしている（docs には露出しない）。
    #[doc(hidden)]
    pub fn record_xrun(&self) {
        self.xruns.fetch_add(1, Ordering::Relaxed);
    }

    /// device_lost フラグを立てる。
    ///
    /// 通常は [`StreamStats::record_error`] 経由で自動的に呼ばれる。
    /// `#[doc(hidden)] pub` は integration test から device_lost 発生を
    /// 再現するために半公開にしている（docs には露出しない）。
    #[doc(hidden)]
    pub fn record_device_lost(&self) {
        self.device_lost.store(true, Ordering::Relaxed);
    }

    /// cpal::StreamError を variant で振り分けて atomic を更新する。
    /// audio thread から呼ばれるので blocking I/O を避け atomic 操作のみ。
    /// make_err_fn と test helper の両方がこれを参照するため、
    /// dispatch ロジックの drift 防止に single-source として機能する。
    fn record_error(&self, err: &cpal::StreamError) {
        match err {
            cpal::StreamError::DeviceNotAvailable => self.record_device_lost(),
            cpal::StreamError::BackendSpecific { .. } => self.record_xrun(),
        }
    }

    fn record_render_contention(&self) {
        self.render_contentions.fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct StreamStatsSnapshot {
    pub xruns: u64,
    pub buffer_underruns: u64,
    pub device_lost: bool,
    pub render_contentions: u64,
    pub callbacks: u64,
    pub last_frames: u32,
}

#[derive(Error, Debug)]
pub enum OutputError {
    #[error("no default output device found")]
    NoDevice,
    #[error("no supported output config: {0}")]
    NoConfig(String),
    #[error("cpal build stream error: {0}")]
    BuildStream(String),
    #[error("cpal play stream error: {0}")]
    PlayStream(String),
    #[error("cpal pause stream error: {0}")]
    PauseStream(String),
    #[error("failed to read output device name: {0}")]
    DeviceName(String),
    #[error("capture writer error: {0}")]
    Capture(String),
    #[error("audio output device \"{device}\" produced no callback within {waited_ms} ms")]
    StreamDead {
        device: String,
        waited_ms: u64,
        phase: StreamLivenessPhase,
    },
    /// ライブ切替で要求デバイスが見つからない / 出力できない。
    ///
    /// 🔴 起動時は host 既定へ縮退するが、**ライブ切替は元のデバイスへ復帰する**
    /// （owner 裁定 2026-09-05・設計 §3）。演奏中にタイプミスして内蔵スピーカーへ
    /// 音が移るのを避けるため、切替経路では縮退せずこのエラーを返す。
    #[error("requested output device \"{requested}\" is not available ({reason}); keeping the current device")]
    DeviceUnavailable { requested: String, reason: String },
    #[error(
        "audio output device \"{device}\" uses {device_rate} Hz, but the running engine uses {engine_rate} Hz; restart the engine to change sample rate"
    )]
    SampleRateMismatch {
        device: String,
        device_rate: u32,
        engine_rate: u32,
    },
    #[error("{primary}; additionally failed to resume the old audio stream: {resume}")]
    SwitchRecoveryFailed {
        primary: Box<OutputError>,
        resume: Box<OutputError>,
    },
}

/// Identifies which half of the two-stage liveness gate rejected a stream.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum StreamLivenessPhase {
    Probe,
    RealStream,
}

/// 実ストリームをどの段で組み立てているか。`OutputFault` の効き先を段で分けるためだけに使う。
///
/// 🔴 これが無いと **`DeadRealStream` はプロセス全体に効く**ので、「起動は正常・切替で作った
/// 2 本目の実ストリームだけ死ぬ」が表現できない。その結果、`apply_device_switch` の
/// 「旧を pause 済み → 新の build/play/confirm が失敗 → 旧を `play()` で再開」という
/// **#661 の最後の安全網**に、どのテストからも到達できなかった（2026-09-05 のレビューで発覚）。
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum StreamBuildStage {
    /// daemon 起動時の 1 本目。
    Startup,
    /// ライブ切替で作る 2 本目以降。
    Switch,
}

/// Test-only liveness failure selected by the daemon's typed startup options.
#[derive(Debug, Clone, Copy, Default, Eq, PartialEq)]
pub enum OutputFault {
    #[default]
    None,
    DeadProbeRequested,
    DeadAllProbes,
    /// 実ストリームの callback を**常に**殺す。1 本目にも効くので daemon は起動できない（C-4）。
    DeadRealStream,
    /// 実ストリームの callback を**切替で作った 2 本目以降だけ**殺す。起動は正常に通る。
    DeadRealStreamOnSwitch,
}

impl OutputFault {
    /// この段の実ストリームで callback を抑止するか。
    fn suppresses_real_callback(self, stage: StreamBuildStage) -> bool {
        match self {
            OutputFault::DeadRealStream => true,
            OutputFault::DeadRealStreamOnSwitch => stage == StreamBuildStage::Switch,
            _ => false,
        }
    }
}

/// A requested output device and optional gated fault injection.
#[derive(Debug, Clone, Default, Eq, PartialEq)]
pub struct OutputDeviceRequest {
    pub name: Option<String>,
    pub fault: OutputFault,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct DeviceFallback {
    pub requested: String,
    pub reason: String,
}

struct ResolvedOutputDevice {
    device: Device,
    name: String,
    fallback: Option<DeviceFallback>,
}

fn resolved(
    device: Device,
    fallback: Option<DeviceFallback>,
) -> Result<ResolvedOutputDevice, OutputError> {
    let name = device
        .name()
        .map_err(|e| OutputError::DeviceName(e.to_string()))?;
    Ok(ResolvedOutputDevice {
        device,
        name,
        fallback,
    })
}

/// The sole callback-liveness deadline used by both the preflight probe and the real stream.
pub const FIRST_CALLBACK_DEADLINE: Duration = Duration::from_millis(3_000);
const FIRST_CALLBACK_POLL: Duration = Duration::from_millis(10);

/// A device may reach the rendering path only after its standalone preflight stream produced a
/// callback. All fields remain private so callers cannot bypass the gate when building a stream.
pub struct LiveOutputDevice {
    device: Device,
    name: String,
    config: StreamConfig,
    sample_format: SampleFormat,
    requested: Option<String>,
    fallback: Option<DeviceFallback>,
    fault: OutputFault,
}

impl LiveOutputDevice {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn sample_rate(&self) -> u32 {
        self.config.sample_rate.0
    }

    pub fn channels(&self) -> u16 {
        self.config.channels
    }

    pub fn requested(&self) -> Option<&str> {
        self.requested.as_deref()
    }

    pub fn fallback(&self) -> Option<&DeviceFallback> {
        self.fallback.as_ref()
    }
}

/// `ListAudioDevices`（#484 D1）の 1 デバイス分。cpal の output device 列挙結果を wire 用に
/// 平坦化する。`direction` は将来の入力デバイス列挙（v1 スコープ外）に備えた予約フィールド —
/// v1 は `"output"` 固定で埋める。
#[derive(Debug, Clone, PartialEq)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub is_default: bool,
    pub max_output_channels: u16,
    pub default_sample_rate: u32,
    pub direction: &'static str,
}

/// cpal の default host から output device を列挙する（#484 D1）。個々のデバイスの config 取得が
/// 失敗しても（macOS で一時的に無効化されたデバイス等）全体を失敗させず、そのデバイスだけ
/// skip する（列挙は observability 用途で best-effort でよい・enumerate 失敗が daemon 起動可否を
/// 左右してはいけない）。
pub fn list_output_devices() -> Result<Vec<AudioDeviceInfo>, OutputError> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());

    // 【#493 と同根のハング回避（レビュー Critical）】`host.output_devices()` は使わない —
    // その supports_output フィルタは per-device に AudioUnit + CreateIOProcID を生成し、
    // Aggregate デバイス等で CoreAudio 内ブロックする（resolve 経路でスタック実証済み）。
    // 代わりに probe なしの `devices()` で列挙し、出力可否と config は軽量な
    // default_output_config のみで判定（失敗 = 入力専用等として skip）。残余リスクは
    // 呼び出し側のプロセス timeout（拡張 5s / RPC は spawn_blocking）が受け止める。
    let devices = host
        .devices()
        .map_err(|e| OutputError::NoConfig(e.to_string()))?;

    let mut result = Vec::new();
    for device in devices {
        let Ok(name) = device.name() else {
            continue;
        };
        let Ok(config) = device.default_output_config() else {
            continue;
        };
        let is_default = default_name.as_deref() == Some(name.as_str());
        result.push(AudioDeviceInfo {
            name,
            is_default,
            max_output_channels: config.channels(),
            default_sample_rate: config.sample_rate().0,
            direction: "output",
        });
    }
    Ok(result)
}

/// 起動時の device 指定を解決する純関数（`--audio-device` honor・#484 D1）。名前**完全一致**の
/// device を `available` から探す。`requested` が `None`、または一致するデバイスが無ければ
/// `None`（= host 既定へ縮退）を返す。cpal I/O を持たないため unit test で決定的に検証できる。
pub fn resolve_requested_device_name(
    requested: Option<&str>,
    available: &[String],
) -> Option<String> {
    let requested = requested?;
    available.iter().find(|n| n.as_str() == requested).cloned()
}

/// 要求されたデバイスが使えない時にどうするか（owner 裁定 2026-09-05・設計
/// `docs/design/661-audio-device-liveness-design.md` §3）。
///
/// 🔴 **裸の bool にしない。** 「起動時は host 既定へ縮退／ライブ切替は元のデバイスへ復帰」は
/// 1 つの二値ポリシーで、位置引数の `true` / `false` は取り違えてもコンパイルが通る。
/// 実装が裁定文と食い違っていた F4 と同じクラスの回帰を、型で表現できなくする。
///
/// このポリシーは**縮退の理由を区別しない** — 「名前が見つからない」「出力デバイスではない」
/// 「probe が callback を出さない」のいずれも同じ扱いにする。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceFallbackPolicy {
    /// 起動経路。利用者を無音のまま放置しないので host 既定へ縮退して起動を成功させる。
    FallBackToHostDefault,
    /// ライブ切替経路。縮退せず `DeviceUnavailable` / `StreamDead` を返し、呼び出し側が
    /// **いま鳴っているデバイスをそのまま使い続ける**。
    RejectAndKeepCurrent,
}

impl DeviceFallbackPolicy {
    fn allows_fallback(self) -> bool {
        matches!(self, Self::FallBackToHostDefault)
    }
}

/// cpal I/O 込みの device 解決（#484 D1）。`resolve_requested_device_name`（pure）に実際の host
/// 列挙を組み合わせる。`requested` が `None` なら常に host 既定を使う（列挙コストを払わない・
/// 従来経路とビット同一）。
///
/// 🔴 **一致するデバイスが見つからない時の振る舞いは `policy` で決まる**（owner 裁定 2026-09-05・
/// 設計 §3。[`DeviceFallbackPolicy`] の doc を参照）:
///
/// - [`DeviceFallbackPolicy::FallBackToHostDefault`]（起動経路）— fallback metadata を付けて
///   host 既定へ縮退する（daemon 起動を失敗させない）
/// - [`DeviceFallbackPolicy::RejectAndKeepCurrent`]（ライブ切替経路）— 縮退せず
///   [`OutputError::DeviceUnavailable`] を返し、呼び出し側がいま鳴っているデバイスを保つ
fn resolve_output_device(
    host: &cpal::Host,
    requested: Option<&str>,
    policy: DeviceFallbackPolicy,
) -> Result<ResolvedOutputDevice, OutputError> {
    let Some(requested) = requested else {
        let device = host.default_output_device().ok_or(OutputError::NoDevice)?;
        return resolved(device, None);
    };

    // 【重要・確認 E2E での P0 再発防止】ここで `host.output_devices()` を使ってはいけない。
    // cpal の output フィルタは各デバイスの supported_output_configs を probe し、その実装が
    // macOS では AudioUnit + CreateIOProcID を生成する — Aggregate デバイス等で CoreAudio 内
    // ブロック（実測: 起動が ready line 前に無限ハング・スタックで確定）。起動クリティカル
    // パスでは probe なしの `devices()` 名前照合のみ行い、config 検証は選択後の通常の
    // stream 構築（そのデバイス 1 台に対してのみ）に任せる。
    let mut matched: Option<(Device, String)> = None;
    let mut available_names = Vec::new();
    if let Ok(devices) = host.devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                if name == requested {
                    matched = Some((device, name));
                    break;
                }
                available_names.push(name);
            }
        }
    }

    match matched {
        // `devices()` は入力専用デバイスも含む（probe 回避の代償）。マッチした 1 台だけ
        // default_output_config で出力可否を確認し、出力不可なら旧挙動どおり警告 + 既定へ
        // 縮退する（起動失敗にしない）。probe はユーザーが明示指定した 1 台に限定される。
        Some((device, name)) => {
            if device.default_output_config().is_ok() {
                Ok(ResolvedOutputDevice {
                    device,
                    name,
                    fallback: None,
                })
            } else {
                if !policy.allows_fallback() {
                    return Err(OutputError::DeviceUnavailable {
                        requested: requested.to_string(),
                        reason: "not an output device".to_string(),
                    });
                }
                let reason = format!(
                    "requested device \"{requested}\" is not an output device — falling back to system default output"
                );
                let device = host.default_output_device().ok_or(OutputError::NoDevice)?;
                resolved(
                    device,
                    Some(DeviceFallback {
                        requested: requested.to_string(),
                        reason,
                    }),
                )
            }
        }
        None => {
            if !policy.allows_fallback() {
                return Err(OutputError::DeviceUnavailable {
                    requested: requested.to_string(),
                    reason: format!("not found (available: {available_names:?})"),
                });
            }
            let reason = format!(
                "requested device \"{requested}\" not found (available: {available_names:?}) — falling back to system default output"
            );
            let device = host.default_output_device().ok_or(OutputError::NoDevice)?;
            resolved(
                device,
                Some(DeviceFallback {
                    requested: requested.to_string(),
                    reason,
                }),
            )
        }
    }
}

fn output_config(
    resolved: ResolvedOutputDevice,
    buffer_frames: Option<u32>,
    expected_sample_rate: Option<u32>,
    request: &OutputDeviceRequest,
) -> Result<LiveOutputDevice, OutputError> {
    let supported = resolved
        .device
        .default_output_config()
        .map_err(|e| OutputError::NoConfig(e.to_string()))?;
    let sample_format = supported.sample_format();
    let mut config = supported.config();
    if let Some(frames) = buffer_frames {
        config.buffer_size = cpal::BufferSize::Fixed(frames);
    }
    validate_expected_sample_rate(&resolved.name, config.sample_rate.0, expected_sample_rate)?;
    Ok(LiveOutputDevice {
        device: resolved.device,
        name: resolved.name,
        config,
        sample_format,
        requested: request.name.clone(),
        fallback: resolved.fallback,
        fault: request.fault,
    })
}

fn validate_expected_sample_rate(
    device: &str,
    device_rate: u32,
    expected_sample_rate: Option<u32>,
) -> Result<(), OutputError> {
    if let Some(engine_rate) = expected_sample_rate {
        if device_rate != engine_rate {
            return Err(OutputError::SampleRateMismatch {
                device: device.to_string(),
                device_rate,
                engine_rate,
            });
        }
    }
    Ok(())
}

fn confirm_callback_counter(
    callbacks: &AtomicU64,
    baseline: u64,
    deadline: Duration,
) -> Option<u64> {
    let started = Instant::now();
    loop {
        if callbacks.load(Ordering::Relaxed) > baseline {
            return Some(started.elapsed().as_millis() as u64);
        }
        if started.elapsed() >= deadline {
            return None;
        }
        std::thread::sleep(FIRST_CALLBACK_POLL.min(deadline.saturating_sub(started.elapsed())));
    }
}

fn probe_output_device(
    live: &LiveOutputDevice,
    suppress_callback: bool,
) -> Result<Option<u64>, OutputError> {
    // This counter is deliberately probe-local. Reusing StreamStats would inflate the ticker's
    // callback count before the real stream exists.
    let callbacks = Arc::new(AtomicU64::new(0));
    let callback_counter = callbacks.clone();
    let stream = live
        .device
        .build_output_stream_raw(
            &live.config,
            live.sample_format,
            move |data, _| {
                data.bytes_mut().fill(0);
                if !suppress_callback {
                    callback_counter.fetch_add(1, Ordering::Relaxed);
                }
            },
            |_| {},
            None,
        )
        .map_err(|e| OutputError::BuildStream(e.to_string()))?;
    if let Err(error) = stream.play() {
        let _ = stream.pause();
        drop(stream);
        return Err(OutputError::PlayStream(error.to_string()));
    }
    let result = confirm_callback_counter(&callbacks, 0, FIRST_CALLBACK_DEADLINE);
    // cpal 0.15.3 can retain named streams through a reference cycle. Explicit pause is therefore
    // required before every probe stream is dropped.
    let _ = stream.pause();
    drop(stream);
    Ok(result)
}

fn probe_candidate(
    live: LiveOutputDevice,
    requested_candidate: bool,
) -> Result<Option<LiveOutputDevice>, OutputError> {
    let suppress = live.fault == OutputFault::DeadAllProbes
        || (requested_candidate && live.fault == OutputFault::DeadProbeRequested);
    match probe_output_device(&live, suppress)? {
        Some(_) => Ok(Some(live)),
        None => Ok(None),
    }
}

/// Resolve and preflight the finite startup/switch candidate list before engine-owned state is
/// constructed or moved into a real callback.
pub fn select_live_output_device(
    request: OutputDeviceRequest,
    buffer_frames: Option<u32>,
    expected_sample_rate: Option<u32>,
    policy: DeviceFallbackPolicy,
) -> Result<LiveOutputDevice, OutputError> {
    let host = cpal::default_host();
    let first = output_config(
        resolve_output_device(&host, request.name.as_deref(), policy)?,
        buffer_frames,
        expected_sample_rate,
        &request,
    )?;
    let first_name = first.name.clone();
    if let Some(live) = probe_candidate(first, request.name.is_some())? {
        return Ok(live);
    }

    let Some(requested) = request.name.clone().filter(|_| policy.allows_fallback()) else {
        return Err(OutputError::StreamDead {
            device: first_name,
            waited_ms: FIRST_CALLBACK_DEADLINE.as_millis() as u64,
            phase: StreamLivenessPhase::Probe,
        });
    };

    let fallback_reason = format!(
        "requested device \"{requested}\" produced no callback within {} ms — falling back to system default output",
        FIRST_CALLBACK_DEADLINE.as_millis()
    );
    let mut fallback = output_config(
        resolve_output_device(&host, None, DeviceFallbackPolicy::FallBackToHostDefault)?,
        buffer_frames,
        expected_sample_rate,
        &request,
    )?;
    fallback.fallback = Some(DeviceFallback {
        requested,
        reason: fallback_reason,
    });
    let fallback_name = fallback.name.clone();
    probe_candidate(fallback, false)?.ok_or(OutputError::StreamDead {
        device: fallback_name,
        waited_ms: FIRST_CALLBACK_DEADLINE.as_millis() as u64,
        phase: StreamLivenessPhase::Probe,
    })
}

/// capture ring の秒数（`sample_rate * channels * 秒`）。off-thread writer が瞬間的な disk
/// 遅延を吸収できるよう generous に確保する。恒常的に writer が追いつかなければ drop が
/// カウントされ、検証側が invalid として loud に落とす（silent-failure ガード）。
const CAPTURE_RING_SECONDS: usize = 8;

/// 生きている間はストリームを保持する RAII ハンドル。
pub struct OutputStream {
    _stream: Stream,
    /// capture seam（#307 realtime）: `ORBIT_CAPTURE_WAV` 有効時のみ `Some`。**`_stream` より後に
    /// 宣言する**ことで drop 順を「stream 停止（callback 停止＝以後 commit なし）→ writer が ring の
    /// 残りを drain して WAV を finalize」に固定する（Rust は struct field を宣言順に drop する）。
    _capture: Option<crate::capture::CaptureWriter>,
    render_state: Arc<std::sync::Mutex<RenderState>>,
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub device_requested: Option<String>,
    pub device_fallback: Option<DeviceFallback>,
    pub first_callback_ms: u64,
    fault: OutputFault,
}

impl OutputStream {
    /// Callback-owned state shared with a replacement stream. This deliberately
    /// excludes capture: capture switches are rejected by the daemon.
    pub fn render_state(&self) -> Arc<std::sync::Mutex<RenderState>> {
        self.render_state.clone()
    }

    /// master line の gain 書き込みハンドル（`EngineWrap::set_global_gain` が保持する）。
    /// 起動シーケンス（非 RT）で 1 回だけ呼ぶ想定 — poison してもハンドルの clone 自体は
    /// 継続できるよう `into_inner` で復旧する（RT 側の実体は無事なので、ここが失敗しても
    /// gain 書き込みの意味は保たれる）。
    pub fn master_gain(&self) -> Arc<AtomicU32> {
        self.render_state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .master
            .gain_target_handle()
    }

    /// `SetBusLine("master", ...)` 用の control-only publication seam。
    pub fn master_line_program_installer(&self) -> LineProgramInstaller {
        self.render_state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .master
            .line_program_installer()
    }
    /// capture 有効時のみ、producer 側で drop した interleaved サンプル累積を返す。capture 無効は
    /// `None`。**`> 0` は「off-thread writer が追いつかず録音が破損した = 検証 invalid」を意味する**
    /// （検証ハーネス/オペレータが assert・監視する silent-failure ガード）。
    pub fn capture_drops(&self) -> Option<u64> {
        self._capture.as_ref().map(|w| w.dropped_samples())
    }

    pub fn pause(&self) -> Result<(), OutputError> {
        self._stream
            .pause()
            .map_err(|e| OutputError::PauseStream(e.to_string()))
    }

    pub fn play(&self) -> Result<(), OutputError> {
        self._stream
            .play()
            .map_err(|e| OutputError::PlayStream(e.to_string()))
    }

    pub fn fault(&self) -> OutputFault {
        self.fault
    }
}

impl Drop for OutputStream {
    fn drop(&mut self) {
        // cpal 0.15.3 retains named CoreAudio streams through a reference cycle. Dropping the
        // wrapper alone does not stop callbacks; pause must happen before field destruction.
        let _ = self._stream.pause();
    }
}

/// Master ライン（設計 `docs/design/611-output-line-design.md` §5.2）。全 stage の Master 宛て
/// 出口が加算される 2ch バッファ・master ラック（旧 `RenderState::post`）・production の master
/// gain 適用点をひとつにまとめる。
///
/// `SetBusLine("master", ...)` の publish 後は汎用 `LineProgram` を実行する。publish 前だけは
/// **固定の既定 program**（ラック → gain → Device{0,1} 配置）を直接実行し、従来出力との
/// bit-level 互換を保つ。
/// engine 内部のチャンネル幅。**デバイス幅とは無関係に常に 2**（設計 §5.5）。
///
/// events / feeds / stages / master.buffer はすべてこの幅で扱い、デバイス幅への変換は
/// `place_master_into_device` の 1 箇所だけで行う。デバイス幅（`StreamConfig.channels`）を
/// engine バッファの解釈に使うと、8ch デバイスで frame 数が 1/4 になって音が化ける
/// （#611 本文の実害がこれ）。
pub const ENGINE_CHANNELS: usize = 2;

/// RT で resize しないための事前確保（`MasterLine` / `InsertBusStage` が共有する規律）。
///
/// 🔴 **同じ本体を 2 箇所に置かない。** 「RT hot path で resize しない」という不変条件を守る
/// ロジックが分かれていると、確保サイズの計算式や初期値を変える時に片方だけ直る。
fn ensure_audio_buffer_len(buffer: &mut Vec<f32>, len: usize) {
    if buffer.len() < len {
        buffer.resize(len, 0.0);
    }
}

/// One block of the click-free gain ramp shared by the master line and generic line programs.
/// `ramp_frames` is prepared from the sample rate before the callback starts.
#[inline]
fn advance_ramped_gain(current: &mut f32, target: f32, frames: usize, ramp_frames: u32) -> f32 {
    let frac = (frames as f32 / ramp_frames as f32).min(1.0);
    *current += (target - *current) * frac;
    *current
}

pub struct MasterLine {
    /// 全 stage の Master 宛て出口が加算される 2ch バッファ（zero-fill は callback 冒頭・
    /// `render_engine_with_sources` に core の `hardware_out` として渡す）。事前確保のみ・RT では
    /// resize しない（`InsertBusStage::ensure_buffer_len` と同じ規律）。
    buffer: Vec<f32>,
    /// Bus-line `Device` outputs bypass the master rack/gain and accumulate here until master
    /// placement is complete. It is sized on the control thread and zero-filled per callback.
    direct_device_buffer: Vec<f32>,
    /// master ラック（今日の `post`）。CLAP effect/instrument（Issue #340）。engine render 後の
    /// **master.buffer（常に 2ch）**を in-place 変換する（デバイス幅とは無関係）。
    post: Option<Box<dyn PostProcessor>>,
    /// control（`SetGlobalGain`）が書き込む目標ゲイン（線形振幅・f32 bits）。RT は Relaxed load
    /// のみ（`InsertBusStage::send_gain_overrides` と同じ atomic gain パターン）。core の
    /// `Engine::set_global_gain` は production では呼ばない — 乗算経路をここ 1 本にする
    /// （§5.4「経路が 1 本になった」）。
    gain_target: Arc<AtomicU32>,
    /// RT が block ごとに `gain_target` へ寄せていく現在値（RT 専有・非 atomic）。
    gain_current: f32,
    /// 5ms 相当のフレーム数（**構築時に** sample_rate から算出。`advance_gain` の分母）。
    ramp_frames: u32,
    /// `SetBusLine("master", ...)` が publish する汎用 program。未 publish の間は固定互換経路を
    /// 実行し、既存譜面の bit-level 出力を保つ。
    ///
    /// 🔴 **ここに書いてある既定 program は RT では一度も実行されない。** `explicit_line` が
    /// `false` の間は `render_block_with_sources` が固定互換経路の側へ分岐し、`true` になるのは
    /// control が program を publish した後だからである（publish された時点で中身は control 側の
    /// 値に置き換わっている）。`engine_wrap.rs` の `default_master_line_program` が
    /// `output_channels` を見て `right` を出し分けるのに対しここが `Some(1)` 固定なのは、
    /// **この値が使われないため**であって不整合ではない。
    line: LineSlot,
    /// control が master program を **一度でも publish したか**（不可逆）。`line` の中身からは
    /// 導出できない（RT で既定値と深い比較をすることになり、かつ「既定と同じ program を明示的に
    /// publish した」場合を区別できない）。
    ///
    /// 名前は「明示的な line が入ったか」の意であり、`SetGlobalGain` の atomic 更新では変わらない。
    ///
    /// 🔴 **いつこの分岐を消せるか**: PR-O4 で TS の `global.gain()` が
    /// `SetBusLine("master", …)` を送る新表面へ切り替わり、その経路が実機で確かめられ、PR-O6 で
    /// 旧 `SetBusRouting` 系が撤去された後。そこで固定互換経路と本フラグを同時に削り、
    /// `execute_master_line` の 1 本にできる見込みである。
    explicit_line: Arc<AtomicBool>,
}

impl MasterLine {
    /// `ramp_frames` を sample_rate から**構築時に**算出する（RT では計算しない）。
    pub fn new(sample_rate: u32, post: Option<Box<dyn PostProcessor>>) -> Self {
        let ramp_frames = ((sample_rate as f64 * 0.005).round() as u32).max(1);
        Self {
            buffer: Vec::new(),
            direct_device_buffer: Vec::new(),
            post,
            gain_target: Arc::new(AtomicU32::new(1.0_f32.to_bits())),
            gain_current: 1.0,
            ramp_frames,
            line: LineSlot::new(LineProgram::settled(vec![
                LineOp::Rack,
                LineOp::Gain(1.0),
                LineOp::Output(LineOutput {
                    dest: OutputDest::Device {
                        left: 0,
                        right: Some(1),
                    },
                    thru: false,
                    gain: 1.0,
                }),
            ])),
            explicit_line: Arc::new(AtomicBool::new(false)),
        }
    }

    /// callback block は通常これより遥かに短い。RT hot path の resize を構造的に排除する
    /// （`InsertBusStage::ensure_buffer_len` と同じ意図）。
    fn ensure_buffer_len(&mut self, len: usize) {
        ensure_audio_buffer_len(&mut self.buffer, len);
        // Existing unit-level render seams use a 2ch hardware buffer of the same length.
        ensure_audio_buffer_len(&mut self.direct_device_buffer, len);
    }

    fn ensure_device_buffer_len(&mut self, len: usize) {
        ensure_audio_buffer_len(&mut self.direct_device_buffer, len);
    }

    /// control 側（`EngineWrap::set_global_gain`）が保持する書き込みハンドル。RT はここへは
    /// 触れない（Arc の clone は非 RT の起動シーケンスで 1 回だけ行う）。
    pub fn gain_target_handle(&self) -> Arc<AtomicU32> {
        self.gain_target.clone()
    }

    pub fn line_program_installer(&self) -> LineProgramInstaller {
        let control = self.line.line_control();
        let current = control.clone();
        let explicit = self.explicit_line.clone();
        LineProgramInstaller::new(
            move |program, bus_index, bus_count| {
                control.install_for_bus(program, bus_index, bus_count)?;
                explicit.store(true, Ordering::Release);
                Ok(())
            },
            move || current.current_gains(),
        )
    }

    /// 1 block 分ランプを進め、その block に適用する gain を返す（設計 §5.3 `ramp()`）。
    /// `current += (target - current) * min(1, frames / ramp_frames)`。RT: atomic load 1 回 +
    /// 算術のみ（alloc/lock/syscall なし）。
    #[inline]
    fn advance_gain(&mut self, frames: usize) -> f32 {
        let target = f32::from_bits(self.gain_target.load(Ordering::Relaxed));
        advance_ramped_gain(&mut self.gain_current, target, frames, self.ramp_frames)
    }
}

/// Mutable callback state which must survive a cpal stream rebuild (notably
/// out-of-process processor adapters). The callback uses one `try_lock`; a
/// concurrent control-plane rebuild produces a silent block instead of ever
/// blocking an audio thread.
pub struct RenderState {
    link: Option<LinkEgress>,
    insert_buses: Vec<InsertBusStage>,
    sources: Vec<SourceSlot>,
    transport: BlockTransport,
    master: MasterLine,
}

/// One callback's transport snapshot passed to block sources.
#[derive(Debug, Clone, Copy)]
pub struct BlockTransport {
    pub cursor_frames: u64,
    pub sample_rate: u32,
}

/// A callback-owned source which renders one or more interleaved output units.
pub trait BlockSource: Send {
    fn render(&mut self, frames: usize, transport: &BlockTransport) -> usize;
    fn output(&self, unit: usize) -> &[f32];
}

/// Destination of one source output unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SourceDest {
    #[default]
    Master,
    Bus(usize),
    Link(usize),
}

/// Atomic routing cell shared by the callback and the control plane.
#[derive(Clone)]
pub struct SourceDestCell(Arc<AtomicUsize>);

impl SourceDestCell {
    const MASTER: usize = 0;
    const BUS_BASE: usize = 1;
    const LINK_BASE: usize = Self::BUS_BASE + MAX_INSERT_BUS_STAGES;
    const END: usize = Self::LINK_BASE + MAX_LINK_CHANNELS;

    pub fn new(dest: SourceDest) -> Self {
        Self(Arc::new(AtomicUsize::new(Self::encode(dest))))
    }

    #[inline]
    pub fn load(&self) -> SourceDest {
        Self::decode(self.0.load(Ordering::Relaxed))
    }

    #[inline]
    pub fn store(&self, dest: SourceDest) {
        self.0.store(Self::encode(dest), Ordering::Relaxed);
    }

    fn encode(dest: SourceDest) -> usize {
        match dest {
            SourceDest::Master => Self::MASTER,
            SourceDest::Bus(index) if index < MAX_INSERT_BUS_STAGES => Self::BUS_BASE + index,
            SourceDest::Link(index) if index < MAX_LINK_CHANNELS => Self::LINK_BASE + index,
            SourceDest::Bus(_) | SourceDest::Link(_) => Self::MASTER,
        }
    }

    fn decode(value: usize) -> SourceDest {
        match value {
            Self::MASTER => SourceDest::Master,
            value if value < Self::LINK_BASE => SourceDest::Bus(value - Self::BUS_BASE),
            value if value < Self::END => SourceDest::Link(value - Self::LINK_BASE),
            _ => SourceDest::Master,
        }
    }
}

impl Default for SourceDestCell {
    fn default() -> Self {
        Self::new(SourceDest::Master)
    }
}

/// A preallocated source and the routing destination of each output unit.
pub struct SourceSlot {
    pub source: Box<dyn BlockSource>,
    pub dests: Vec<SourceDestCell>,
}

/// callback が同時に egress できる LinkAudio channel の上限（A4-2b-2b）。RT callback の per-block
/// stack `ArrayVec` 容量と一致させる。**cap は control 側（`register_channel`）で強制**するため
/// callback はこれを超える channel を受け取らない（callback で log しない＝RT 安全）。実用上の
/// channel 数を遥かに上回る値。
pub const MAX_LINK_CHANNELS: usize = 64;

/// callback が同時に render できる insert bus 数の上限。stage は stream 構築時に固定されるため、
/// callback では stack 上の `ArrayVec` だけで `render_multi` 引数を組み立てられる。
pub const MAX_INSERT_BUS_STAGES: usize = 64;

/// Maximum source slots owned by one callback.
pub const MAX_SOURCE_SLOTS: usize = 32;

/// Maximum independently routable output units exposed by one source.
pub const MAX_SOURCE_UNITS: usize = 16;

const MAX_SOURCE_FEEDS: usize = MAX_SOURCE_SLOTS * MAX_SOURCE_UNITS;

/// mixer graph（#459/#453 MX.1-MX.5）における stage の出力先。**stages 配列内の index** で指す
/// （配列順 = トポロジカル順という MX.4 の不変条件を、型ではなく構築時検証で担保する）。
/// `Master` は既定（従来の「hw へ加算」のみの経路とビット同一）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BusTarget {
    /// hardware sum へ加算する（従来の唯一の経路）。
    #[default]
    Master,
    /// 自分より **後ろ**（配列 index が大きい）の stage へ copy 加算する（sum への合流）。
    Bus(usize),
}

/// Decode the compatibility routing sentinel shared by the legacy RT shim and the daemon's
/// `SetBusRouting` publisher: `0` means no override, `1` means Master, and `n >= 2` means Bus(n-2).
pub fn decode_bus_routing_sentinel(encoded: usize) -> Option<BusTarget> {
    match encoded {
        0 => None,
        1 => Some(BusTarget::Master),
        n => Some(BusTarget::Bus(n - 2)),
    }
}

/// post-insert の signal を copy 加算する send（aux への並列タップ・MX.3）。post-fader 固定
/// （v1・pre/post 切替は将来拡張）。`target` は `sends` を持つ stage 自身より**後ろ**の index。
#[derive(Debug, Clone, Copy)]
pub struct BusSend {
    pub target: usize,
    pub gain: f32,
}

pub type LegacyLineInstaller =
    Arc<dyn Fn(BusTarget, Vec<BusSend>, usize, usize) -> Result<(), OutputError> + Send + Sync>;

#[derive(Clone)]
pub struct LineProgramInstaller {
    install: Arc<dyn Fn(LineProgram, usize, usize) -> Result<(), OutputError> + Send + Sync>,
    current_gains: Arc<dyn Fn() -> Vec<f32> + Send + Sync>,
}

impl LineProgramInstaller {
    pub fn new(
        install: impl Fn(LineProgram, usize, usize) -> Result<(), OutputError> + Send + Sync + 'static,
        current_gains: impl Fn() -> Vec<f32> + Send + Sync + 'static,
    ) -> Self {
        Self {
            install: Arc::new(install),
            current_gains: Arc::new(current_gains),
        }
    }

    pub fn install_for_bus(
        &self,
        program: LineProgram,
        bus_index: usize,
        bus_count: usize,
    ) -> Result<(), OutputError> {
        (self.install)(program, bus_index, bus_count)
    }

    pub fn current_gains(&self) -> Vec<f32> {
        (self.current_gains)()
    }
}

/// A resolved output destination for one line operation. Bus and channel names are converted to
/// stable indices on the control thread before a program is published.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputDest {
    Master,
    Bus(usize),
    Device { left: usize, right: Option<usize> },
    Render(usize),
    Link(usize),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineOutput {
    pub dest: OutputDest,
    pub thru: bool,
    pub gain: f32,
}

/// One operation in a bus line. Pan positions use the normalized -1..=1 wire range.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LineOp {
    Rack,
    Gain(f32),
    Pan(f32),
    Output(LineOutput),
}

/// Immutable line operations plus atomically observable callback-owned gain state.
pub struct LineProgram {
    pub ops: Box<[LineOp]>,
    pub current_gain: Box<[AtomicU32]>,
    #[cfg(test)]
    drop_thread_log: Option<Arc<std::sync::Mutex<Vec<std::thread::ThreadId>>>>,
}

/// The op sequence a legacy `SetBusRouting` maps onto: rack, the output target, then one
/// `thru` output per send.
///
/// 🔴 This is the single definition. `LineProgram::legacy` builds a program from it, and the
/// daemon keeps the same ops as its republish shadow. Duplicating the construction would let
/// the two drift — the shadow decides what a later `SetBusLine` seeds from, so a mismatch
/// would silently reintroduce the gain jump that seeding exists to prevent.
pub fn legacy_line_ops(output_target: BusTarget, sends: &[BusSend]) -> Vec<LineOp> {
    let mut ops = Vec::with_capacity(sends.len() + 2);
    ops.push(LineOp::Rack);
    ops.push(LineOp::Output(LineOutput {
        dest: match output_target {
            BusTarget::Master => OutputDest::Master,
            BusTarget::Bus(index) => OutputDest::Bus(index),
        },
        thru: !sends.is_empty(),
        gain: 1.0,
    }));
    for (index, send) in sends.iter().enumerate() {
        ops.push(LineOp::Output(LineOutput {
            dest: OutputDest::Bus(send.target),
            thru: index + 1 != sends.len(),
            gain: send.gain,
        }));
    }
    ops
}

impl LineProgram {
    /// Construct a generic program whose gain state starts at unity and ramps to each target.
    pub fn new(ops: Vec<LineOp>) -> Self {
        let seeds = vec![1.0; ops.len()];
        Self::with_seeds(ops, seeds)
    }

    /// Construct a generic program with control-selected effective values for click-free
    /// replacement. Shape validation remains at the publication boundary.
    pub fn with_seeds(ops: Vec<LineOp>, seeds: Vec<f32>) -> Self {
        Self {
            ops: ops.into_boxed_slice(),
            current_gain: seeds
                .into_iter()
                .map(|seed| AtomicU32::new(seed.to_bits()))
                .collect::<Vec<_>>()
                .into_boxed_slice(),
            #[cfg(test)]
            drop_thread_log: None,
        }
    }

    /// Construct a program already at every target. Static and legacy routing use this path because
    /// their pre-LineProgram behavior applied gains immediately, including the first callback.
    pub fn settled(ops: Vec<LineOp>) -> Self {
        let seeds = ops
            .iter()
            .map(|op| match op {
                LineOp::Gain(gain) | LineOp::Pan(gain) => *gain,
                LineOp::Output(output) => output.gain,
                LineOp::Rack => 1.0,
            })
            .collect();
        Self::with_seeds(ops, seeds)
    }

    fn legacy(output_target: BusTarget, sends: &[BusSend]) -> Self {
        Self::settled(legacy_line_ops(output_target, sends))
    }

    fn validate_shape(&self) -> Result<(), OutputError> {
        if self.ops.len() != self.current_gain.len() {
            return Err(OutputError::NoConfig(format!(
                "line program has {} ops but {} gain cells",
                self.ops.len(),
                self.current_gain.len()
            )));
        }
        Ok(())
    }

    #[cfg(test)]
    fn with_drop_thread_log(
        mut self,
        log: Arc<std::sync::Mutex<Vec<std::thread::ThreadId>>>,
    ) -> Self {
        self.drop_thread_log = Some(log);
        self
    }
}

#[cfg(test)]
impl Drop for LineProgram {
    fn drop(&mut self) {
        if let Some(log) = &self.drop_thread_log {
            log.lock()
                .expect("line-program drop-thread log")
                .push(std::thread::current().id());
        }
    }
}

/// A retired program and the RT generation after which it can be destroyed. The generation lives
/// in the retired object itself, matching the shape of the `ChainExchange` precedent. The safety
/// argument differs: `ChainExchange` has RT write `retired_at_generation` before handoff, which
/// establishes happens-before, while this exchange has control count completed RT generations.
/// Only the “generation travels in the retired object” shape is borrowed here.
struct RetiredLineProgram {
    program: Box<LineProgram>,
    retired_at_generation: u64,
}

struct LineExchange {
    live: AtomicPtr<LineProgram>,
    retired: Mutex<Vec<RetiredLineProgram>>,
    /// Completed RT generations. The audio thread is the sole writer; control only Acquire-loads.
    generation: AtomicU64,
}

impl LineExchange {
    fn new(program: LineProgram) -> Arc<Self> {
        Arc::new(Self {
            live: AtomicPtr::new(Box::into_raw(Box::new(program))),
            retired: Mutex::new(Vec::new()),
            generation: AtomicU64::new(0),
        })
    }

    fn install(
        &self,
        program: LineProgram,
        bus_index: usize,
        bus_count: usize,
    ) -> Result<(), OutputError> {
        validate_line_program(&program, bus_index, bus_count)?;
        let next = Box::into_raw(Box::new(program));
        let previous = self.live.swap(next, Ordering::AcqRel);
        debug_assert!(!previous.is_null());

        let completed = self.generation.load(Ordering::Acquire);
        // The swap above has already published `next`. If this panic-only mutex-poisoning path is
        // taken, install returns Err even though the new program is live and `previous` is leaked.
        // This ordering is documented rather than disguised as an atomic control-side rollback.
        let mut retired = self
            .retired
            .lock()
            .map_err(|_| OutputError::NoConfig("line retirement mutex poisoned".into()))?;
        retired.retain(|entry| completed < entry.retired_at_generation);
        if !previous.is_null() {
            // SAFETY: `previous` was produced by Box::into_raw and the swap removed it from the
            // live owner. RT may still hold a shared raw reference, so the box stays retained for
            // two completed generations: one for the possible in-flight read plus one spare. It is
            // never dereferenced by control.
            retired.push(RetiredLineProgram {
                program: unsafe { Box::from_raw(previous) },
                retired_at_generation: completed.saturating_add(2),
            });
        }
        Ok(())
    }
}

impl Drop for LineExchange {
    fn drop(&mut self) {
        let live = *self.live.get_mut();
        if !live.is_null() {
            // SAFETY: final `Arc<LineExchange>` destruction means no RT or control handle remains.
            drop(unsafe { Box::from_raw(live) });
        }
        if let Ok(retired) = self.retired.get_mut() {
            for entry in retired.drain(..) {
                drop(entry.program);
            }
        }
    }
}

/// Control-only installation handle. Effective values are atomic because re-publication must seed
/// a replacement from the currently audible state rather than restarting at unity.
#[derive(Clone)]
pub struct LineControl {
    exchange: Arc<LineExchange>,
}

impl LineControl {
    pub fn install_for_bus(
        &self,
        program: LineProgram,
        bus_index: usize,
        bus_count: usize,
    ) -> Result<(), OutputError> {
        self.exchange.install(program, bus_index, bus_count)
    }

    pub fn current_gains(&self) -> Vec<f32> {
        let program = self.exchange.live.load(Ordering::Acquire);
        assert!(!program.is_null(), "line program must always be installed");
        // SAFETY: control is the sole publication side. The caller serializes reading the live
        // values with replacement, so this pointer remains live for the duration of the loads.
        unsafe { &*program }
            .current_gain
            .iter()
            .map(|gain| f32::from_bits(gain.load(Ordering::Relaxed)))
            .collect()
    }
}

struct LegacyLineRouting {
    output: Arc<AtomicUsize>,
    sends: Vec<Arc<AtomicU32>>,
}

/// RT-side line reader. Production reads the published program with one Acquire load; reclamation,
/// allocation, locking, and destruction are confined to `LineControl`.
pub struct LineSlot {
    exchange: Arc<LineExchange>,
    ramp_frames: u32,
    legacy: Option<LegacyLineRouting>,
    #[cfg(test)]
    read_interlock: std::sync::Mutex<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>>,
}

impl LineSlot {
    pub fn new(program: LineProgram) -> Self {
        Self {
            exchange: LineExchange::new(program),
            // Direct unit-test construction uses the engine's normal 48 kHz default. Production
            // replaces this from the selected device rate before the callback starts.
            ramp_frames: 240,
            legacy: None,
            #[cfg(test)]
            read_interlock: std::sync::Mutex::new(None),
        }
    }

    pub fn line_control(&self) -> LineControl {
        LineControl {
            exchange: self.exchange.clone(),
        }
    }

    fn set_sample_rate(&mut self, sample_rate: u32) {
        self.ramp_frames = ((sample_rate as f64 * 0.005).round() as u32).max(1);
    }

    #[inline]
    fn load(&self) -> *mut LineProgram {
        let program = self.exchange.live.load(Ordering::Acquire);
        debug_assert!(!program.is_null());
        #[cfg(test)]
        self.wait_at_read_interlock();
        program
    }

    #[inline]
    fn finish_generation(&self) {
        self.exchange.generation.fetch_add(1, Ordering::Release);
    }

    fn replace_during_construction(&self, program: LineProgram) {
        // Construction-only builders have no stage index yet. Bus topology is validated once the
        // complete stage array exists, before a callback can start.
        let next = Box::into_raw(Box::new(program));
        let previous = self.exchange.live.swap(next, Ordering::AcqRel);
        if !previous.is_null() {
            let mut retired = self
                .exchange
                .retired
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            // No RT generation has begun during construction, but a control handle may already
            // have been cloned. Retaining until final drop avoids relying on that convention.
            retired.push(RetiredLineProgram {
                // SAFETY: the live swap transferred ownership to this retired entry.
                program: unsafe { Box::from_raw(previous) },
                retired_at_generation: u64::MAX,
            });
        }
    }

    fn ops_snapshot_during_construction(&self) -> Vec<LineOp> {
        let program = self.exchange.live.load(Ordering::Acquire);
        assert!(!program.is_null(), "line program must always be installed");
        // SAFETY: builder methods are construction-only and hold exclusive access to the stage.
        unsafe { (&*program).ops.to_vec() }
    }

    #[cfg(test)]
    fn interlock_next_read(
        &mut self,
        reached_after_load: Arc<std::sync::Barrier>,
        resume_read: Arc<std::sync::Barrier>,
    ) {
        *self.read_interlock.lock().expect("line read interlock") =
            Some((reached_after_load, resume_read));
    }

    #[cfg(test)]
    fn wait_at_read_interlock(&self) {
        let interlock = self
            .read_interlock
            .lock()
            .expect("line read interlock")
            .take();
        if let Some((reached_after_load, resume_read)) = interlock {
            reached_after_load.wait();
            resume_read.wait();
        }
    }

    #[cfg(test)]
    fn visit_program_for_test(&self, visit: impl FnOnce(&LineProgram)) {
        let program = self.load();
        // SAFETY: the RT generation guard retains a replaced program until two later completed
        // generations, and this method publishes completion only after `visit` returns.
        visit(unsafe { &*program });
        self.finish_generation();
    }
}

fn validate_line_program(
    program: &LineProgram,
    bus_index: usize,
    bus_count: usize,
) -> Result<(), OutputError> {
    program.validate_shape()?;
    for op in &program.ops {
        match op {
            // These arms are availability gates, not permanent format restrictions. Remove the
            // corresponding rejection when the follow-up PR wires that variant into RT execution;
            // until then accepting it would report success for a program the callback ignores.
            LineOp::Output(LineOutput {
                dest: OutputDest::Render(_),
                ..
            }) => {
                return Err(OutputError::NoConfig(
                    "line program Output destination Render is not wired into RT execution".into(),
                ));
            }
            LineOp::Output(LineOutput {
                dest: OutputDest::Link(_),
                ..
            }) => {
                return Err(OutputError::NoConfig(
                    "line program Output destination Link is not wired into RT execution".into(),
                ));
            }
            LineOp::Output(LineOutput {
                dest: OutputDest::Bus(target),
                ..
            }) if *target <= bus_index || *target >= bus_count => {
                return Err(OutputError::NoConfig(format!(
                    "insert bus index {bus_index} output Bus({target}) must be a later stage"
                )));
            }
            LineOp::Rack
            | LineOp::Gain(_)
            | LineOp::Pan(_)
            | LineOp::Output(LineOutput {
                dest: OutputDest::Master | OutputDest::Bus(_) | OutputDest::Device { .. },
                ..
            }) => {}
        }
    }
    Ok(())
}

#[inline]
fn effective_line_output_dest(
    first_output: &mut bool,
    legacy_target: Option<OutputDest>,
    program_target: OutputDest,
) -> OutputDest {
    if *first_output {
        *first_output = false;
        legacy_target.unwrap_or(program_target)
    } else {
        program_target
    }
}

/// named routing tag を受ける per-bus insert stage。sum/aux を含む mixer graph の1ノード
/// （#459/#453・MX.1-MX.5）。
///
/// `processor=None` は effect 未 attach の **登録済み bus** を表す。buffer を `render_multi` に渡して
/// event を必ず消費し、そのまま `output_target` へ足すので、未 attach bus の event が retain され
/// 続けない。
pub struct InsertBusStage {
    name: String,
    processor: Option<Box<dyn PostProcessor>>,
    buffer: Vec<f32>,
    /// **activation flag**（`LinkChannelActivate.ready` と同じパターン）: `false` の間この bus は
    /// render 対象から完全に外れる（zero-fill / gain-ramp / sum のコストゼロ）。daemon の既定
    /// bus プール（#434 S3）は宣言（LoadPlugin）まで inactive で、全 bus inactive なら
    /// `render_block` は bus 無し経路（ビット同一）に落ちる — `seq.effect()` を使わない
    /// セッションが pool のコストを払わないための機構。
    /// ⚠ inactive bus 名に tag された event は render_multi の対象外 = 消費されず retain される
    /// （LinkAudio の not-ready channel と同じ既存ハザード）。producer（TS）は「宣言 =
    /// activation → その後に tag 付き PlayAt」の順序を守ること（`seq.effect()` は await するので
    /// 構造的に成立）。
    active: Arc<AtomicBool>,
    /// Published line program. Routing, sends, and rack position are all interpreted from this one
    /// ordered program by the callback post-loop.
    line: LineSlot,
}

impl InsertBusStage {
    /// テストまたは構築側が既知の block 長で stage を作る。通常の stream 起動 seam は device config
    /// 確定後に必要な buffer を確保するため、ここには 0 を渡してよい。
    pub fn new(
        name: impl Into<String>,
        processor: Option<Box<dyn PostProcessor>>,
        buffer_len: usize,
    ) -> Self {
        // 手組み（テスト・明示構成）の stage は生成時から live。遅延 activation が要る
        // 呼び出し側（daemon の bus プール）は `with_activation` を使う。
        Self::with_activation(name, processor, buffer_len, Arc::new(AtomicBool::new(true)))
    }

    /// 共有 activation flag 付きで stage を作る（daemon が LoadPlugin 時に `true` へ release-store
    /// する用途。flag の所有は呼び出し側と共有）。
    pub fn with_activation(
        name: impl Into<String>,
        processor: Option<Box<dyn PostProcessor>>,
        buffer_len: usize,
        active: Arc<AtomicBool>,
    ) -> Self {
        Self {
            name: name.into(),
            processor,
            buffer: vec![0.0; buffer_len],
            active,
            line: LineSlot::new(LineProgram::legacy(BusTarget::Master, &[])),
        }
    }

    /// effect 未 attach の routing bus を登録する。
    pub fn unattached(name: impl Into<String>) -> Self {
        Self::new(name, None, 0)
    }

    /// この stage の出力先を指定する（既定 `Master`）。sum の member や sum→master 以外の合流に
    /// 使う（MX.1）。target index の妥当性（自分より後ろ）は構築 API 側で検証する。
    pub fn with_output_target(self, target: BusTarget) -> Self {
        let mut ops = self.line.ops_snapshot_during_construction();
        if let Some(LineOp::Output(output)) =
            ops.iter_mut().find(|op| matches!(op, LineOp::Output(_)))
        {
            output.dest = match target {
                BusTarget::Master => OutputDest::Master,
                BusTarget::Bus(index) => OutputDest::Bus(index),
            };
        }
        self.line
            .replace_during_construction(LineProgram::settled(ops));
        self
    }

    /// 複数の send（aux/return への post-fader copy・MX.3）を指定する（既定空）。
    pub fn with_sends(self, sends: Vec<BusSend>) -> Self {
        let mut ops = self.line.ops_snapshot_during_construction();
        let primary = ops
            .iter()
            .position(|op| matches!(op, LineOp::Output(_)))
            .expect("legacy line has a primary output");
        ops.truncate(primary + 1);
        if let LineOp::Output(output) = &mut ops[primary] {
            output.thru = !sends.is_empty();
        }
        for (index, send) in sends.iter().enumerate() {
            ops.push(LineOp::Output(LineOutput {
                dest: OutputDest::Bus(send.target),
                thru: index + 1 != sends.len(),
                gain: send.gain,
            }));
        }
        self.line
            .replace_during_construction(LineProgram::settled(ops));
        self
    }

    /// Replace the construction-time default with an explicit generic line program. Topology is
    /// validated once the complete stage array is available.
    pub fn with_line(self, program: LineProgram) -> Self {
        self.line.replace_during_construction(program);
        self
    }

    /// Obtain the control-only publication handle before moving the stage into callback state.
    pub fn line_control(&self) -> LineControl {
        self.line.line_control()
    }

    pub fn line_program_installer(&self) -> LineProgramInstaller {
        let control = self.line.line_control();
        let current = control.clone();
        LineProgramInstaller::new(
            move |program, bus_index, bus_count| {
                control.install_for_bus(program, bus_index, bus_count)
            },
            move || current.current_gains(),
        )
    }

    /// Compatibility bridge used by the daemon's old `SetBusRouting` command. The closure accepts
    /// the old routing shape but publishes a complete `LineProgram`; it exposes neither the live
    /// pointer nor callback-owned gain cells to control code.
    pub fn legacy_line_installer(&self) -> LegacyLineInstaller {
        let control = self.line.line_control();
        Arc::new(move |target, sends, bus_index, bus_count| {
            control.install_for_bus(LineProgram::legacy(target, &sends), bus_index, bus_count)
        })
    }

    /// M2（#459/#453）: 実行時ルーティング用の atomic ハンドルを装着する。`routing_override` は
    /// この stage の output target 切替用（呼び出し側が control 側にも同じ Arc の clone を保持し
    /// `SetBusRouting` で書き込む）。`send_gain_overrides` は「この stage より後ろの全 stage」分の
    /// gain スロットを、絶対 index の昇順（この stage の直後から順）で渡す（呼び出し側が
    /// stage 配列の組み立て時にサイズを決める）。
    pub fn with_routing_overrides(
        mut self,
        routing_override: Arc<AtomicUsize>,
        send_gain_overrides: Vec<Arc<AtomicU32>>,
    ) -> Self {
        if !send_gain_overrides.is_empty() {
            let mut ops = self.line.ops_snapshot_during_construction();
            for op in &mut ops {
                if let LineOp::Output(output) = op {
                    output.thru = true;
                }
            }
            self.line
                .replace_during_construction(LineProgram::settled(ops));
        }
        self.line.legacy = Some(LegacyLineRouting {
            output: routing_override,
            sends: send_gain_overrides,
        });
        self
    }

    fn ensure_buffer_len(&mut self, len: usize) {
        ensure_audio_buffer_len(&mut self.buffer, len);
    }
}

/// `insert_buses` の `output_target`/`sends` が MX.4 のトポロジカル不変条件（配列順で後方参照
/// のみ）を満たすか検証する。stage i の target/send が `<= i` を指すと、render 時に
/// `split_at_mut` で解決できない（前方参照 or 自己参照は sum のネスト・循環に相当し v1 で禁止・
/// MX.2）。構築 API の入口（`start_default_output_with_insert_buses*`）でのみ呼ぶ。
fn validate_bus_topology(stages: &[InsertBusStage]) -> Result<(), OutputError> {
    for (i, stage) in stages.iter().enumerate() {
        let program = stage.line.exchange.live.load(Ordering::Acquire);
        if program.is_null() {
            return Err(OutputError::NoConfig(format!(
                "insert bus '{}' has no line program",
                stage.name
            )));
        }
        // SAFETY: topology validation runs before stages enter callback state; the construction
        // API cannot replace this pointer concurrently.
        validate_line_program(unsafe { &*program }, i, stages.len()).map_err(|error| {
            OutputError::NoConfig(format!("insert bus '{}': {error}", stage.name))
        })?;
    }
    Ok(())
}

fn validate_source_slots(sources: &[SourceSlot]) -> Result<(), OutputError> {
    if sources.len() > MAX_SOURCE_SLOTS {
        return Err(OutputError::NoConfig(format!(
            "too many source slots: {} (max {MAX_SOURCE_SLOTS})",
            sources.len()
        )));
    }
    for (slot, source) in sources.iter().enumerate() {
        if source.dests.len() > MAX_SOURCE_UNITS {
            return Err(OutputError::NoConfig(format!(
                "source slot {slot} has too many output units: {} (max {MAX_SOURCE_UNITS})",
                source.dests.len()
            )));
        }
    }
    Ok(())
}

/// LinkAudio channel を RT callback に届けるための activation メッセージ（A4-2b-2）。
/// control thread が ring 生成・scratch 事前確保まで行い、本構造体を reg-ring 経由で callback へ
/// 渡す（callback は受け取って pool へ追加するだけ＝RT alloc を避ける）。`sink` は対になる
/// `rtrb::Consumer<f32>` を GPL consumer thread が drain する producer 側。
pub struct LinkChannelActivate {
    pub name: String,
    pub sink: RingTapSink,
    /// per-block scratch。control が `max_block_frames * channels` で事前確保する。
    pub scratch: Vec<f32>,
    /// **readiness flag**（A4-2b-2b）: GPL consumer thread が当該 channel の Link 登録 + egress 構築を
    /// 終えたら `true` にする。callback は `false` の間この channel を render_multi 対象から外し commit
    /// もしない。これにより「callback が push するが consumer が drain しない ring（partial-failure で
    /// 溢れて silent）」が **構造的に発生しない**。steady-state の共有者は RT callback（`le.channels`
    /// 内の本構造体）と consumer thread（`ActiveChannel`）の 2 つ。control は `register_channel` 構築後に
    /// 自分の clone を手放す。
    pub ready: Arc<AtomicBool>,
}

/// cpal callback が保持する LinkAudio egress の channel pool（A4-2b-2b・最大 [`MAX_LINK_CHANNELS`]）。
/// `reg_rx` から新 channel を受け取り `channels` に追加する。同名再登録は control 側の冪等 guard が
/// 抑止するため、`channels` への push は常に新規 channel（既存 entry を drop しない＝RT 安全）。
struct LinkEgress {
    reg_rx: rtrb::Consumer<LinkChannelActivate>,
    channels: Vec<LinkChannelActivate>,
}

/// channel が egress 対象か = **ready** かつ **scratch が block 以上**（A4-2b-2b）。`render_block` の
/// pass 1（render_multi 引数組み）と pass 2（sink commit）で同一判定を使い divergence を防ぐ。pure
/// なので CI で単体検証する（not-ready / scratch 不足 / active を pin）。
#[inline]
fn channel_egress_active(ready: bool, scratch_len: usize, block: usize) -> bool {
    ready && scratch_len >= block
}

/// 1 callback 分の処理（計測 + engine render + master-bus post-processor）。
#[inline]
fn render_shared_block(
    engine: &Engine,
    state: &Arc<std::sync::Mutex<RenderState>>,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
    stats: &StreamStats,
) {
    stats.record_callback((hw.len() / output_channels) as u32);
    match state.try_lock() {
        Ok(mut state) => {
            let RenderState {
                link,
                insert_buses,
                sources,
                transport,
                master,
            } = &mut *state;
            render_block_with_sources(
                engine,
                link,
                insert_buses,
                sources,
                transport,
                master,
                capture,
                cb_stats,
                output_channels,
                hw,
            )
        }
        Err(_) => {
            hw.fill(0.0);
            stats.record_render_contention();
        }
    }
}

///
/// 手順（設計 `611-output-line-design.md` §5.3）: (1) callback 開始時刻を取る（`cb_stats` 有り時
/// のみ）→ (2) engine（+ 各 insert bus / LinkAudio egress）を常に 2ch で render し `master.buffer`
/// へ集約 → (3) master ライン: `master.post` 有りなら `master.buffer`（2ch）を in-place 変換
/// （CLAP effect/instrument・Issue #340）、続けて gain を適用（production の乗算経路はここ 1 本・
/// §5.4）→ (4) `master.buffer` を device 幅の `hw` へ配置（`place_master_into_device`）→
/// (5) `capture` 有りなら **配置後の最終 `hw`** を WAV 用 ring へ読み取り専用 tap（#307）→
/// (6) callback 所要時間を記録。`master.post`/`capture`/`cb_stats` は各々独立の opt-in 分岐で、
/// `master.post` が None かつ gain が 1.0（既定）なら従来経路とビット同一（2ch デバイス）。
/// `capture` は `hw` を読むだけなので有効でも出力サンプルは不変（tap であって mutation ではない）。
#[inline]
#[cfg(test)]
#[allow(clippy::too_many_arguments)] // callback state is kept as independent opt-in seams.
fn render_block(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    insert_buses: &mut [InsertBusStage],
    master: &mut MasterLine,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
) {
    let mut sources = [];
    let mut transport = BlockTransport {
        cursor_frames: 0,
        sample_rate: 0,
    };
    render_block_with_sources(
        engine,
        link,
        insert_buses,
        &mut sources,
        &mut transport,
        master,
        capture,
        cb_stats,
        output_channels,
        hw,
    );
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn render_block_with_sources(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    insert_buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    master: &mut MasterLine,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
) {
    // Instant::now() は macOS では mach_absolute_time（lock/alloc なし）= RT 許容。A0 §6 に基づき
    // production RT 監視を callback-duration ベースにするための計測（cb_stats 有り時のみ）。
    let t0 = cb_stats.as_ref().map(|_| Instant::now());

    // engine（+ bus graph）は常に 2ch で完結する（設計 §5.5 row 1・3）。`master.buffer` が core の
    // 「hardware_out」を受ける — デバイス幅（`output_channels`／`hw`）とは無関係。buffer は起動時に
    // 事前確保済み（`start_output_inner`）なので RT では resize しない。
    let frames = hw.len() / output_channels;
    let bs = frames * 2;
    debug_assert!(
        master.buffer.len() >= bs,
        "master buffer too short: {} < {bs}",
        master.buffer.len()
    );
    debug_assert!(master.direct_device_buffer.len() >= hw.len());
    let direct_device_written = {
        let mut device = DeviceLineBuffer {
            samples: &mut master.direct_device_buffer[..hw.len()],
            channels: output_channels,
            wrote: false,
        };
        render_engine_with_sources_impl(
            engine,
            link,
            insert_buses,
            sources,
            transport,
            2,
            &mut master.buffer[..bs],
            Some(&mut device),
        );
        device.wrote
    };

    if master.explicit_line.load(Ordering::Acquire) {
        execute_master_line(master, frames, output_channels, hw);
    } else {
        // SetBusLine 未使用時は従来の固定 master 経路を保ち、既存出力を bit 単位で変えない。
        // この分岐の中身は PR-O3b の前と 1 命令も変えていない（変えると O0 golden が動く）。
        if let Some(p) = master.post.as_mut() {
            p.process(&mut master.buffer[..bs]);
        }
        let g = master.advance_gain(frames);
        // g == 1.0 は IEEE754 の乗算恒等元で bit 一致を崩さない（`x * 1.0 == x`）。分岐は
        // 「未使用 gain 経路に per-sample 乗算コストを払わない」ための最適化であり、O0 golden の
        // bit 一致は乗算そのものではなく `gain_current` が初期値 1.0 のまま変化しないことに由来する
        // （`SetGlobalGain` を一度も呼ばない譜面では target=current=1.0 が恒常的に成立する）。
        if g != 1.0 {
            for s in master.buffer[..bs].iter_mut() {
                *s *= g;
            }
        }
        // デバイス配置（設計 §5.3・row 6）: master.buffer（2ch）を hw（デバイス幅）の ch{0,1} へ置く。
        // 2ch デバイスなら memcpy 相当（O0-1/O0-2 の bit 一致はここで成立）。3ch 以上は ch2 以降が
        // 無音で残る — この分岐の Device 出口は master 固定 program の 1 本のみで、複数出口は
        // `execute_master_line`（上の分岐）と PR-O4 以降の DSL 表面が持つ。
        //
        // 🔴 ここで `hw` を全域 zero-fill しない。`place_master_into_device` が **hw の全要素を
        // 書き切る**ので、1ch / 2ch（＝今日検証されている構成すべて）では書いた直後に全部上書きされ、
        // RT コールバックで**毎ブロック二重に store する**ことになる（64 frames × 2ch なら
        // 約 96,000 store/秒の無駄）。余剰チャンネルの 0 埋めは配置関数の責務に閉じた。
        place_master_into_device(&master.buffer[..bs], frames, output_channels, hw);
    }
    if direct_device_written {
        add_scaled(hw, &master.direct_device_buffer[..hw.len()], 1.0);
    }

    // capture seam（#307 realtime）: post 適用後の最終 hw（= device に出る実信号）を WAV へ逃がす
    // 読み取り専用 tap。`RingTapSink::commit` は wait-free / no-alloc（満杯時はあふれを drop カウント）
    // ＝ RT 契約を満たす。off-thread writer が ring を drain する。post の後・計測の内側に置くことで
    // capture コストも callback-duration に含めて監視する。
    if let Some(sink) = capture.as_mut() {
        sink.commit(hw);
    }

    if let (Some(stats), Some(t0)) = (cb_stats, t0) {
        stats.record(t0.elapsed().as_nanos() as u64);
    }
}

#[inline]
fn execute_master_line(
    master: &mut MasterLine,
    frames: usize,
    output_channels: usize,
    hw: &mut [f32],
) {
    let bs = frames * ENGINE_CHANNELS;
    let program_ptr = master.line.load();
    // SAFETY: publication retains replaced programs for two completed RT generations. This
    // generation is completed only after the whole master program has executed.
    let program = unsafe { &*program_ptr };
    let mut device = DeviceLineBuffer {
        samples: hw,
        channels: output_channels,
        wrote: false,
    };
    for (op_index, op) in program.ops.iter().enumerate() {
        match *op {
            LineOp::Rack => {
                if let Some(processor) = master.post.as_mut() {
                    processor.process(&mut master.buffer[..bs]);
                }
            }
            LineOp::Gain(target) => {
                let gain = line_gain(program, op_index, target, frames, master.line.ramp_frames);
                if gain != 1.0 {
                    for sample in &mut master.buffer[..bs] {
                        *sample *= gain;
                    }
                }
            }
            LineOp::Output(output) => {
                let gain = line_gain(
                    program,
                    op_index,
                    output.gain,
                    frames,
                    master.line.ramp_frames,
                );
                if let OutputDest::Device { left, right } = output.dest {
                    add_to_device(&mut device, &master.buffer[..bs], frames, left, right, gain);
                } else {
                    // release ではこの debug_assert は no-op。到達不能を保証する唯一の境界は
                    // control 層の `set_bus_line` master 分岐であり、その検証が破れればこの出口は
                    // 無音のまま捨てられ、ログにも残らない。
                    debug_assert!(false, "master line destination was not validated");
                }
                if !output.thru {
                    break;
                }
            }
            LineOp::Pan(target) => {
                let pan = line_gain(program, op_index, target, frames, master.line.ramp_frames);
                apply_line_pan(&mut master.buffer[..bs], frames, pan);
            }
        }
    }
    if !device.wrote {
        device.samples.fill(0.0);
    }
    master.line.finish_generation();
}

/// `master.buffer`（常に 2ch）を device 幅の `hw` へ配置する（裁定 2「Device 宛ては master の
/// ラック・ゲインを通らない」＝この関数の**手前**でラック/gain が既に適用済み）。`hw` は直前に
/// zero-fill 済みでこの関数が唯一の書き手なので加算ではなく代入で足りる。RT: alloc/lock/syscall
/// なし。`device_channels == 0` は cpal が返さない前提（既存コードも同じ前提で `hw.len() /
/// output_channels` を除算している）。
#[inline]
/// master.buffer（常に 2ch）を hw（デバイス幅）へ置く。**hw の全要素を書き切る**
/// （呼び出し側は事前の zero-fill をしない — RT ホットパスで二重に store しないため）。
fn place_master_into_device(buf: &[f32], frames: usize, device_channels: usize, hw: &mut [f32]) {
    match device_channels {
        0 => {}
        // mono デバイス: L+R を 0.5 でマージ（相関信号でクリップしない・設計 §2.2 Q-611-5 と同じ法則）。
        1 => {
            for frame in 0..frames {
                hw[frame] = (buf[frame * 2] + buf[frame * 2 + 1]) * 0.5;
            }
        }
        // 2ch は幅が一致するので memcpy 相当（O0-1/O0-2 の bit 一致はここで成立）。
        2 => hw[..frames * 2].copy_from_slice(&buf[..frames * 2]),
        // 3ch 以上: ch0/1 に置き、**余剰チャンネルはここで 0 にする**（Device 出口は master の
        // 1 本だけなので、残りは無音が正しい）。
        _ => {
            for frame in 0..frames {
                let base = frame * device_channels;
                hw[base] = buf[frame * 2];
                hw[base + 1] = buf[frame * 2 + 1];
                for extra in &mut hw[base + 2..base + device_channels] {
                    *extra = 0.0;
                }
            }
        }
    }
}

#[inline]
#[cfg(test)]
fn render_engine_with_sources(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    output_channels: usize,
    hw: &mut [f32],
) {
    render_engine_with_sources_impl(
        engine,
        link,
        buses,
        sources,
        transport,
        output_channels,
        hw,
        None,
    );
}

#[allow(clippy::too_many_arguments)]
fn render_engine_with_sources_impl(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    output_channels: usize,
    hw: &mut [f32],
    device: Option<&mut DeviceLineBuffer<'_>>,
) {
    let frames = hw.len() / output_channels;

    if sources.is_empty() {
        if buses.iter().any(|bus| bus.active.load(Ordering::Relaxed)) {
            render_engine_with_insert_buses_and_source_outputs(
                engine,
                link,
                buses,
                &[],
                &[],
                output_channels,
                hw,
                device,
            );
        } else {
            render_engine(engine, link, output_channels, hw);
        }
    } else {
        let rendered_units = render_sources(sources, frames, transport);
        if buses.iter().any(|bus| bus.active.load(Ordering::Relaxed)) {
            render_engine_with_insert_buses_and_source_outputs(
                engine,
                link,
                buses,
                sources,
                &rendered_units,
                output_channels,
                hw,
                device,
            );
        } else {
            render_engine_with_source_outputs(
                engine,
                link,
                sources,
                &rendered_units,
                output_channels,
                hw,
            );
        }
    }

    transport.cursor_frames = transport.cursor_frames.saturating_add(frames as u64);
}

fn render_sources(
    sources: &mut [SourceSlot],
    frames: usize,
    transport: &BlockTransport,
) -> arrayvec::ArrayVec<usize, MAX_SOURCE_SLOTS> {
    use arrayvec::ArrayVec;

    debug_assert!(sources.len() <= MAX_SOURCE_SLOTS);
    let mut rendered_units = ArrayVec::new();
    for slot in sources.iter_mut().take(MAX_SOURCE_SLOTS) {
        let reported = slot.source.render(frames, transport);
        debug_assert!(reported <= MAX_SOURCE_UNITS);
        debug_assert!(reported <= slot.dests.len());
        rendered_units.push(reported.min(MAX_SOURCE_UNITS).min(slot.dests.len()));
    }
    rendered_units
}

fn collect_source_feeds<'a>(
    sources: &'a [SourceSlot],
    rendered_units: &[usize],
    bus_positions: &[Option<usize>],
    block_samples: usize,
) -> arrayvec::ArrayVec<(&'a [f32], FeedDest), MAX_SOURCE_FEEDS> {
    use arrayvec::ArrayVec;

    let mut feeds = ArrayVec::new();
    for (slot, &unit_count) in sources.iter().zip(rendered_units) {
        for unit in 0..unit_count {
            let Some(output) = slot.source.output(unit).get(..block_samples) else {
                debug_assert!(false, "source output shorter than the callback block");
                continue;
            };
            let dest = match slot.dests[unit].load() {
                SourceDest::Master => FeedDest::Hardware,
                SourceDest::Bus(index) => bus_positions
                    .get(index)
                    .copied()
                    .flatten()
                    .map_or(FeedDest::Hardware, FeedDest::Channel),
                // Link source routing is wired in PR-3. Until then it is a total hardware fallback.
                SourceDest::Link(_) => FeedDest::Hardware,
            };
            feeds.push((output, dest));
        }
    }
    feeds
}

#[inline]
#[cfg(test)]
fn render_engine_with_insert_buses(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    output_channels: usize,
    hw: &mut [f32],
) {
    render_engine_with_insert_buses_and_source_outputs(
        engine,
        link,
        buses,
        &[],
        &[],
        output_channels,
        hw,
        None,
    );
}

#[inline]
fn line_gain(
    program: &LineProgram,
    op_index: usize,
    target: f32,
    frames: usize,
    ramp_frames: u32,
) -> f32 {
    let current_gain = &program.current_gain[op_index];
    let mut current = f32::from_bits(current_gain.load(Ordering::Relaxed));
    let gain = advance_ramped_gain(&mut current, target, frames, ramp_frames);
    current_gain.store(current.to_bits(), Ordering::Relaxed);
    gain
}

#[inline]
/// Apply a bus-level pan to an interleaved stereo buffer.
///
/// 🔴 The `√2` is **not** an extra boost — it makes this stage unity at center.
///
/// The source side already applies `equal_power_pan` when it schedules an event
/// (`orbit_audio_core::scheduler`), so a centered event arrives here having been multiplied by
/// `(1/√2, 1/√2)`. Applying the raw equal-power law a second time would drop a further 3 dB, so
/// **writing `pan(0)` would make a score quieter than not writing it at all**. Scaling by `√2`
/// makes center `(1, 1)`, and hard-left `(√2, 0)` composes with the source-side center to `(1, 0)`
/// — the same as today's source-side hard left. The two stages compose to the original law for
/// every position.
///
/// Do not remove the factor as "double compensation": the compensation is what keeps this stage
/// transparent. The source side cannot drop its own center application without breaking bit
/// identity for existing scores (design `docs/design/611-o-surface-bundle-design.md` §4.1).
fn apply_line_pan(buf: &mut [f32], frames: usize, pan: f32) {
    let (left, right) = equal_power_pan(pan);
    let left = left * std::f32::consts::SQRT_2;
    let right = right * std::f32::consts::SQRT_2;
    for frame in 0..frames {
        let base = frame * ENGINE_CHANNELS;
        buf[base] *= left;
        buf[base + 1] *= right;
    }
}

#[inline]
fn add_scaled(dst: &mut [f32], src: &[f32], gain: f32) {
    if gain == 1.0 {
        for (dst, src) in dst.iter_mut().zip(src) {
            *dst += *src;
        }
    } else {
        for (dst, src) in dst.iter_mut().zip(src) {
            *dst += *src * gain;
        }
    }
}

struct DeviceLineBuffer<'a> {
    samples: &'a mut [f32],
    channels: usize,
    wrote: bool,
}

#[inline]
fn add_to_device(
    device: &mut DeviceLineBuffer<'_>,
    src: &[f32],
    frames: usize,
    left: usize,
    right: Option<usize>,
    gain: f32,
) {
    if !device.wrote {
        device.samples.fill(0.0);
    }
    debug_assert!(left < device.channels);
    debug_assert!(right.is_none_or(|channel| channel < device.channels));
    match right {
        Some(right) => {
            for frame in 0..frames {
                let device_base = frame * device.channels;
                let source_base = frame * ENGINE_CHANNELS;
                if gain == 1.0 {
                    device.samples[device_base + left] += src[source_base];
                    device.samples[device_base + right] += src[source_base + 1];
                } else {
                    device.samples[device_base + left] += src[source_base] * gain;
                    device.samples[device_base + right] += src[source_base + 1] * gain;
                }
            }
        }
        None => {
            for frame in 0..frames {
                let source_base = frame * ENGINE_CHANNELS;
                let merged = (src[source_base] + src[source_base + 1]) * 0.5;
                device.samples[frame * device.channels + left] +=
                    if gain == 1.0 { merged } else { merged * gain };
            }
        }
    }
    device.wrote = true;
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn render_engine_with_insert_buses_and_source_outputs(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    sources: &[SourceSlot],
    rendered_units: &[usize],
    output_channels: usize,
    hw: &mut [f32],
    mut device: Option<&mut DeviceLineBuffer<'_>>,
) {
    // LinkAudio と併用するときも 1 回の render_multi に集約し、transport/gain ramp を一度だけ進める。
    // bus 名と Link channel 名が重複した場合は bus を先に登録する（S1 は daemon Link 配線を変更しない）。
    use arrayvec::ArrayVec;
    const MAX_TARGETS: usize = MAX_INSERT_BUS_STAGES + MAX_LINK_CHANNELS;
    debug_assert!(buses.len() <= MAX_INSERT_BUS_STAGES);
    let bs = (hw.len() / output_channels) * output_channels;

    // active フラグを 1 回だけ atomic load して使い回す（RT: 同じ判定を何度も load しない）。
    let active_flags: ArrayVec<bool, MAX_INSERT_BUS_STAGES> = buses
        .iter()
        .map(|bus| bus.active.load(Ordering::Relaxed))
        .collect();

    // One Acquire pointer snapshot per line is shared by the marking pass and execution. A control
    // install during this callback therefore cannot make the two passes disagree about which
    // downstream buffers must be cleared. The generation is published only after both passes.
    let programs: ArrayVec<*mut LineProgram, MAX_INSERT_BUS_STAGES> =
        buses.iter().map(|bus| bus.line.load()).collect();

    // `with_routing_overrides` remains as a source-compatible construction shim for existing
    // native callers. Production `SetBusRouting` installs a complete program; only this legacy
    // shim snapshots the old atomic handles.
    let legacy_targets: ArrayVec<Option<OutputDest>, MAX_INSERT_BUS_STAGES> = buses
        .iter()
        .map(|bus| {
            bus.line.legacy.as_ref().and_then(|legacy| {
                decode_bus_routing_sentinel(legacy.output.load(Ordering::Relaxed)).map(|target| {
                    match target {
                        BusTarget::Master => OutputDest::Master,
                        BusTarget::Bus(index) => OutputDest::Bus(index),
                    }
                })
            })
        })
        .collect();
    let legacy_send_gains: ArrayVec<
        ArrayVec<f32, { MAX_INSERT_BUS_STAGES - 1 }>,
        MAX_INSERT_BUS_STAGES,
    > = buses
        .iter()
        .map(|bus| {
            bus.line
                .legacy
                .as_ref()
                .map(|legacy| {
                    legacy
                        .sends
                        .iter()
                        .map(|gain| f32::from_bits(gain.load(Ordering::Relaxed)))
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();

    // is_render_target（MX.4）: 「event tag を受けるか」（active）と「グラフの中継点として
    // 生きるか」（他の active stage の output_target/sends から参照されるか）を分離する。
    // 後者だけが true の stage（例: 未 declare の sum bus に active な member が output している）
    // も、buffer を zero-fill し post-loop で処理しないと合流先が前 block のゴミを持ち越す。
    let mut render_targets: ArrayVec<bool, MAX_INSERT_BUS_STAGES> =
        active_flags.iter().copied().collect();
    for (i, _bus) in buses.iter().enumerate() {
        if !active_flags[i] {
            continue;
        }
        // SAFETY: the line generation is not completed until after execution below. Control keeps
        // any replaced box retired for two later completed generations.
        let program = unsafe { &*programs[i] };
        let mut first_output = true;
        let mut reached_end = true;
        for op in &program.ops {
            if let LineOp::Output(output) = op {
                let dest =
                    effective_line_output_dest(&mut first_output, legacy_targets[i], output.dest);
                if let OutputDest::Bus(target) = dest {
                    render_targets[target] = true;
                }
                if !output.thru {
                    reached_end = false;
                    break;
                }
            }
        }
        if reached_end {
            for (offset, gain) in legacy_send_gains[i].iter().enumerate() {
                if *gain != 0.0 {
                    render_targets[i + 1 + offset] = true;
                }
            }
        }
    }

    let mut targets: ArrayVec<(&str, &mut [f32]), MAX_TARGETS> = ArrayVec::new();
    let mut bus_positions: ArrayVec<Option<usize>, MAX_INSERT_BUS_STAGES> =
        buses.iter().map(|_| None).collect();
    for (i, bus) in buses.iter_mut().enumerate() {
        if !active_flags[i] {
            // inactive stage は render_multi のタグ対象外（コストゼロ・event tag 契約は変えない・
            // InsertBusStage::active の doc 参照）。ただし render_target なら render_multi を
            // 通らないので、代わりにここで手動 zero-fill する（post-loop が読む前提を守る）。
            if render_targets[i] {
                bus.buffer[..bs].fill(0.0);
            }
            continue;
        }
        debug_assert!(
            bus.buffer.len() >= bs,
            "insert bus '{}' buffer too short",
            bus.name
        );
        let position = targets.len();
        targets
            .try_push((bus.name.as_str(), &mut bus.buffer[..bs]))
            .expect("bounded bus count");
        bus_positions[i] = Some(position);
    }

    if let Some(le) = link {
        while let Ok(act) = le.reg_rx.pop() {
            le.channels.push(act);
        }
        for ch in le.channels.iter_mut() {
            let active =
                channel_egress_active(ch.ready.load(Ordering::Relaxed), ch.scratch.len(), bs);
            if active
                && targets
                    .try_push((ch.name.as_str(), &mut ch.scratch[..bs]))
                    .is_err()
            {
                debug_assert!(false, "render target pool exceeded configured cap");
                break;
            }
        }
    }
    // core は `render_multi` を `render_multi_feeds(.., &[])` に委譲しており、その bit 一致は
    // `render_multi_feeds_empty_matches_render_multi_bit_for_bit` が固定している。sources が
    // 空なら `collect_source_feeds` は空を返すので、呼び出し側で場合分けし直す必要はない。
    let feeds = collect_source_feeds(sources, rendered_units, &bus_positions, bs);
    engine.render_multi_feeds(hw, &mut targets, &feeds);
    drop(targets);

    // post-loop: execute each captured line in topological stage order. Bus outputs retain the
    // existing split_at_mut(i + 1) discipline; every target was validated before publication.
    for i in 0..buses.len() {
        if !render_targets[i] {
            continue;
        }
        // SAFETY: paired with the Acquire load above and the generation completion below.
        let program = unsafe { &*programs[i] };
        let mut first_output = true;
        let mut reached_end = true;
        for (op_index, op) in program.ops.iter().enumerate() {
            match *op {
                LineOp::Rack => {
                    if active_flags[i] {
                        if let Some(processor) = buses[i].processor.as_mut() {
                            processor.process(&mut buses[i].buffer[..bs]);
                        }
                    }
                }
                LineOp::Gain(target) => {
                    let gain = line_gain(
                        program,
                        op_index,
                        target,
                        bs / output_channels,
                        buses[i].line.ramp_frames,
                    );
                    if gain != 1.0 {
                        for sample in &mut buses[i].buffer[..bs] {
                            *sample *= gain;
                        }
                    }
                }
                LineOp::Pan(target) => {
                    let frames = bs / output_channels;
                    let pan =
                        line_gain(program, op_index, target, frames, buses[i].line.ramp_frames);
                    apply_line_pan(&mut buses[i].buffer[..bs], frames, pan);
                }
                LineOp::Output(output) => {
                    let dest = effective_line_output_dest(
                        &mut first_output,
                        legacy_targets[i],
                        output.dest,
                    );
                    let gain = line_gain(
                        program,
                        op_index,
                        output.gain,
                        bs / output_channels,
                        buses[i].line.ramp_frames,
                    );
                    match dest {
                        OutputDest::Master => {
                            add_scaled(hw, &buses[i].buffer[..bs], gain);
                        }
                        OutputDest::Bus(target) => {
                            let (left, right) = buses.split_at_mut(i + 1);
                            add_scaled(
                                &mut right[target - i - 1].buffer[..bs],
                                &left[i].buffer[..bs],
                                gain,
                            );
                        }
                        OutputDest::Device { left, right } => {
                            if let Some(device) = device.as_deref_mut() {
                                add_to_device(
                                    device,
                                    &buses[i].buffer[..bs],
                                    bs / output_channels,
                                    left,
                                    right,
                                    gain,
                                );
                            } else {
                                // Unit-level engine seams have no outer master line; in that shape
                                // their `hw` argument is the physical destination itself.
                                let mut direct = DeviceLineBuffer {
                                    samples: hw,
                                    channels: output_channels,
                                    // `hw` already contains the core/master contribution in this
                                    // unit-level shape, so Device output accumulates without clear.
                                    wrote: true,
                                };
                                add_to_device(
                                    &mut direct,
                                    &buses[i].buffer[..bs],
                                    bs / output_channels,
                                    left,
                                    right,
                                    gain,
                                );
                            }
                        }
                        // Render and Link sinks arrive in their dedicated follow-up PRs. No
                        // program generated by this compatibility PR contains these destinations.
                        OutputDest::Render(_) | OutputDest::Link(_) => {}
                    }
                    if !output.thru {
                        reached_end = false;
                        break;
                    }
                }
            }
        }

        if reached_end {
            for (offset, gain) in legacy_send_gains[i].iter().copied().enumerate() {
                if gain != 0.0 {
                    let (left, right) = buses.split_at_mut(i + 1);
                    add_scaled(&mut right[offset].buffer[..bs], &left[i].buffer[..bs], gain);
                }
            }
        }
    }

    for bus in buses.iter() {
        bus.line.finish_generation();
    }

    if let Some(le) = link {
        for ch in le.channels.iter_mut() {
            if channel_egress_active(ch.ready.load(Ordering::Relaxed), ch.scratch.len(), bs) {
                ch.sink.commit(&ch.scratch[..bs]);
            }
        }
    }
}

/// engine（+ LinkAudio egress）の render 本体。`link` が無い（hardware-only）なら従来通り
/// `engine.render`（ビット同一）。`link` 有りなら reg-ring を drain して channel pool を更新し、
/// **ready な channel のみ**を `render_multi` で hardware と一緒に 1 パスで埋め、各 channel buffer
/// を ring へ push する（egress）。ready が 0 でも `render_multi(hw, &[])` を呼ぶ（`engine.render`
/// に落とすと channel-tagged event が hardware に bleed するため）。
#[inline]
fn render_engine(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    output_channels: usize,
    hw: &mut [f32],
) {
    use arrayvec::ArrayVec;

    let Some(le) = link else {
        // hardware-only。従来 render とビット同一。
        engine.render(hw);
        return;
    };

    // reg-ring を drain → 新 channel を pool へ追加（RT で alloc しない・scratch は control が事前確保）。
    // 同名は control の冪等 guard で来ないので既存 entry を drop しない（RT-safe）。cap は control が
    // 強制するので pool は MAX_LINK_CHANNELS を超えない。
    while let Ok(act) = le.reg_rx.pop() {
        le.channels.push(act);
    }

    let bs = (hw.len() / output_channels) * output_channels;

    // egress に乗せる条件（pass 1/2 で同一）: ready かつ scratch が block 以上。両 pass で同じ closure を
    // 使い **論理的な** divergence を防ぐ。ただし `ready` は consumer thread が concurrent に false→true
    // にするため、pass 1 の後に ready 化した channel は pass 2 のみに入りうる（その block は無音で commit・
    // 次 callback から正常）= benign。`bs` を capture するだけで `le.channels` は借用しない。
    let egress_active = |ch: &LinkChannelActivate| {
        channel_egress_active(ch.ready.load(Ordering::Relaxed), ch.scratch.len(), bs)
    };

    // pass 1: active な channel から render_multi 引数を per-callback stack ArrayVec で組む（heap alloc
    // なし）。借用は render_multi 呼び出しまでに閉じる。
    let mut chans: ArrayVec<(&str, &mut [f32]), MAX_LINK_CHANNELS> = ArrayVec::new();
    for ch in le.channels.iter_mut() {
        if !egress_active(ch) {
            // scratch は control が `MAX_BLOCK_FRAMES * channels`（device buffer より遥かに大）で事前
            // 確保する不変。ready なのに不足したら channel audio が出ないので dev で loud に検出
            // （not-ready は静かに skip・release は安全側で skip）。
            debug_assert!(
                !ch.ready.load(Ordering::Relaxed) || ch.scratch.len() >= bs,
                "link channel '{}' scratch ({}) < block ({bs})",
                ch.name,
                ch.scratch.len()
            );
            continue;
        }
        if chans
            .try_push((ch.name.as_str(), &mut ch.scratch[..bs]))
            .is_err()
        {
            // cap は control（`register_channel`）が `MAX_LINK_CHANNELS` で強制するので構造上到達不能。
            // ここに来たら control cap と callback ArrayVec 容量が drift した証拠 → dev で loud に
            // （release は安全側で残り channel を skip・RT で panic させない）。
            debug_assert!(
                false,
                "link channel pool exceeded ArrayVec cap {MAX_LINK_CHANNELS} (control cap drifted)"
            );
            break;
        }
    }
    engine.render_multi(hw, &mut chans);
    drop(chans); // ArrayVec の借用を閉じてから sink commit（scratch を再借用するため）。

    // pass 2: pass 1 と同一述語の active channel の buffer を ring へ push。
    for ch in le.channels.iter_mut() {
        if !egress_active(ch) {
            continue;
        }
        // 満杯なら RingTapSink が drop カウント（GPL consumer が produced-frames に算入し beat 維持）。
        ch.sink.commit(&ch.scratch[..bs]);
    }
}

#[inline]
fn render_engine_with_source_outputs(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    sources: &[SourceSlot],
    rendered_units: &[usize],
    output_channels: usize,
    hw: &mut [f32],
) {
    use arrayvec::ArrayVec;

    let bs = (hw.len() / output_channels) * output_channels;
    let Some(le) = link else {
        let mut channels: [(&str, &mut [f32]); 0] = [];
        let feeds = collect_source_feeds(sources, rendered_units, &[], bs);
        engine.render_multi_feeds(hw, &mut channels, &feeds);
        return;
    };

    while let Ok(act) = le.reg_rx.pop() {
        le.channels.push(act);
    }

    let egress_active = |ch: &LinkChannelActivate| {
        channel_egress_active(ch.ready.load(Ordering::Relaxed), ch.scratch.len(), bs)
    };
    let mut channels: ArrayVec<(&str, &mut [f32]), MAX_LINK_CHANNELS> = ArrayVec::new();
    for channel in le.channels.iter_mut() {
        if !egress_active(channel) {
            debug_assert!(
                !channel.ready.load(Ordering::Relaxed) || channel.scratch.len() >= bs,
                "link channel '{}' scratch ({}) < block ({bs})",
                channel.name,
                channel.scratch.len()
            );
            continue;
        }
        if channels
            .try_push((channel.name.as_str(), &mut channel.scratch[..bs]))
            .is_err()
        {
            debug_assert!(
                false,
                "link channel pool exceeded ArrayVec cap {MAX_LINK_CHANNELS} (control cap drifted)"
            );
            break;
        }
    }
    let feeds = collect_source_feeds(sources, rendered_units, &[], bs);
    engine.render_multi_feeds(hw, &mut channels, &feeds);
    drop(channels);

    for channel in le.channels.iter_mut() {
        if egress_active(channel) {
            channel.sink.commit(&channel.scratch[..bs]);
        }
    }
}

/// 出力起動の戻り値（Engine・stream guard・stats）。
type OutputStart = (Engine, OutputStream, Arc<StreamStats>);
/// LinkAudio egress 経路付き起動の戻り値（上記 + channel activation の producer）。
type LinkEgressStart = (
    Engine,
    OutputStream,
    Arc<StreamStats>,
    rtrb::Producer<LinkChannelActivate>,
);
/// CLAP master-bus post-processor 経路付き起動の戻り値（上記 + callback-duration 監視 stats）。
type ClapHostStart = (
    Engine,
    OutputStream,
    Arc<StreamStats>,
    Arc<CallbackTimeStats>,
);
/// `start_output_inner` の戻り値（共通部 + post 有り時のみ作る callback-duration stats）。
type OutputInnerStart = (
    Engine,
    OutputStream,
    Arc<StreamStats>,
    Option<Arc<CallbackTimeStats>>,
);

/// 既定の出力デバイスを使い、デバイス config に合う [`Engine`] とストリームを
/// 同時に初期化する（hardware-only）。呼び出し側は config ミスマッチを意識しなくてよい。
pub fn start_default_output(capture_path: Option<PathBuf>) -> Result<OutputStart, OutputError> {
    start_default_output_with_device(capture_path, OutputDeviceRequest::default())
}

/// [`start_default_output`] の device 指定版（#484 D1）。`device_name` が `Some` かつ一致する出力
/// device が見つかれば起動時にそれを honor する。`None`、または一致しない場合は host 既定へ
/// fallback metadata 付きで縮退する（`start_output_inner` 側の共通ロジック）。
pub fn start_default_output_with_device(
    capture_path: Option<PathBuf>,
    device_request: OutputDeviceRequest,
) -> Result<OutputStart, OutputError> {
    let (engine, stream, stats, _cb) = start_output_inner(
        None,
        Vec::new(),
        Vec::new(),
        None,
        false,
        None,
        capture_path,
        device_request,
    )?;
    Ok((engine, stream, stats))
}

/// LinkAudio egress 経路付きで出力を起動する（A4-2b-2・feature `link-audio` 経由でのみ daemon が
/// 使う）。戻り値の `Producer<LinkChannelActivate>` に control thread が channel を push すると、
/// RT callback が render_multi で channel buffer を埋めて ring へ送る。
pub fn start_default_output_with_link_egress(
    reg_capacity: usize,
    capture_path: Option<PathBuf>,
    device_request: OutputDeviceRequest,
) -> Result<LinkEgressStart, OutputError> {
    let (reg_tx, reg_rx) = rtrb::RingBuffer::new(reg_capacity);
    let link = LinkEgress {
        reg_rx,
        // cap は control が強制するので最大 MAX_LINK_CHANNELS。callback で push のみ・realloc を避ける。
        channels: Vec::with_capacity(MAX_LINK_CHANNELS),
    };
    let (engine, stream, stats, _cb) = start_output_inner(
        Some(link),
        Vec::new(),
        Vec::new(),
        None,
        false,
        None,
        capture_path,
        device_request,
    )?;
    Ok((engine, stream, stats, reg_tx))
}

/// CLAP master-bus post-processor 経路付きで出力を起動する（feature `clap-host` / `outproc-effect`
/// 経由でのみ daemon が使う・Issue #340 / #359）。`post` は `MasterLine.post` として保持され、
/// engine render 後の master.buffer（常に 2ch）を RT callback 内で in-place 変換する（CLAP
/// effect=serial insert / instrument=add-mix。実体は実装が所有）。
/// 戻り値の `CallbackTimeStats` は callback-duration ベースの RT 監視用（A0 §6: CoreAudio+cpal は xrun
/// 不発火 → duration が唯一の RT signal）。
///
/// `buffer_frames` が `Some(n)` なら cpal に `BufferSize::Fixed(n)` を要求する（device が 32/64f 等の
/// 小バッファをサポートする前提・非対応 device では build/play がエラー = gated test が loud に失敗。γ M1
/// PR-C の stale-rate harness が使う）。`None` は `BufferSize::Default`（既存経路とビット同一・clap-host）。
pub fn start_default_output_with_clap(
    post: Box<dyn PostProcessor>,
    buffer_frames: Option<u32>,
    capture_path: Option<PathBuf>,
    device_request: OutputDeviceRequest,
) -> Result<ClapHostStart, OutputError> {
    let (engine, stream, stats, cb) = start_output_inner(
        None,
        Vec::new(),
        Vec::new(),
        Some(post),
        true,
        buffer_frames,
        capture_path,
        device_request,
    )?;
    // post=Some の経路では inner が必ず CallbackTimeStats を作る。
    let cb = cb.expect("clap path always creates CallbackTimeStats");
    Ok((engine, stream, stats, cb))
}

/// Callback-owned block sources mixed through the core premaster feed path.
pub fn start_default_output_with_sources(
    sources: Vec<SourceSlot>,
    buffer_frames: Option<u32>,
    capture_path: Option<PathBuf>,
    device_request: OutputDeviceRequest,
) -> Result<ClapHostStart, OutputError> {
    let (engine, stream, stats, cb) = start_output_inner(
        None,
        Vec::new(),
        sources,
        None,
        true,
        buffer_frames,
        capture_path,
        device_request,
    )?;
    Ok((
        engine,
        stream,
        stats,
        cb.expect("source path always creates CallbackTimeStats"),
    ))
}

/// per-bus insert stage 付きで出力を起動する。stage の buffer は device config 確定後、callback が
/// 始まる前に 1 秒分を確保する。`processor=None` の stage は pass-through routing 登録として使える。
pub fn start_default_output_with_insert_buses(
    mut insert_buses: Vec<InsertBusStage>,
    capture_path: Option<PathBuf>,
    device_request: OutputDeviceRequest,
) -> Result<OutputStart, OutputError> {
    if insert_buses.len() > MAX_INSERT_BUS_STAGES {
        return Err(OutputError::NoConfig(format!(
            "too many insert bus stages: {} (max {MAX_INSERT_BUS_STAGES})",
            insert_buses.len()
        )));
    }
    validate_bus_topology(&insert_buses)?;
    let (engine, stream, stats, _cb) = start_output_inner(
        None,
        std::mem::take(&mut insert_buses),
        Vec::new(),
        None,
        false,
        None,
        capture_path,
        device_request,
    )?;
    Ok((engine, stream, stats))
}

/// per-bus insert と従来の master post-processor を同じ callback に載せる。
/// bus は master effect より前に処理されるため、instrument add-mix を含む既存 master
/// 経路の意味論を変えない。
pub fn start_default_output_with_insert_buses_and_post(
    insert_buses: Vec<InsertBusStage>,
    post: Box<dyn PostProcessor>,
    buffer_frames: Option<u32>,
    capture_path: Option<PathBuf>,
    device_request: OutputDeviceRequest,
) -> Result<
    (
        Engine,
        OutputStream,
        Arc<StreamStats>,
        Arc<CallbackTimeStats>,
    ),
    OutputError,
> {
    if insert_buses.len() > MAX_INSERT_BUS_STAGES {
        return Err(OutputError::NoConfig(format!(
            "too many insert bus stages: {} (max {MAX_INSERT_BUS_STAGES})",
            insert_buses.len()
        )));
    }
    validate_bus_topology(&insert_buses)?;
    let (engine, stream, stats, cb) = start_output_inner(
        None,
        insert_buses,
        Vec::new(),
        Some(post),
        true,
        buffer_frames,
        capture_path,
        device_request,
    )?;
    Ok((
        engine,
        stream,
        stats,
        cb.expect("post path always creates CallbackTimeStats"),
    ))
}

/// Per-bus inserts, block sources, and a master post-processor in one callback.
pub fn start_default_output_with_insert_buses_sources_and_post(
    insert_buses: Vec<InsertBusStage>,
    sources: Vec<SourceSlot>,
    post: Box<dyn PostProcessor>,
    buffer_frames: Option<u32>,
    capture_path: Option<PathBuf>,
    device_request: OutputDeviceRequest,
) -> Result<ClapHostStart, OutputError> {
    if insert_buses.len() > MAX_INSERT_BUS_STAGES {
        return Err(OutputError::NoConfig(format!(
            "too many insert bus stages: {} (max {MAX_INSERT_BUS_STAGES})",
            insert_buses.len()
        )));
    }
    validate_bus_topology(&insert_buses)?;
    let (engine, stream, stats, cb) = start_output_inner(
        None,
        insert_buses,
        sources,
        Some(post),
        true,
        buffer_frames,
        capture_path,
        device_request,
    )?;
    Ok((
        engine,
        stream,
        stats,
        cb.expect("source + post path always creates CallbackTimeStats"),
    ))
}

/// `start_default_output` / `_with_link_egress` / `_with_clap` の共通実装。
/// `link` を渡すと cpal callback に egress 経路を、`post` を渡すと master-bus post-processor を
/// 組み込む（両方 None なら hardware-only でビット同一）。`post` 有り時のみ callback-duration
/// 計測 stats を作って返す。`buffer_frames` が `Some` なら `BufferSize::Fixed` を要求する（小バッファ
/// 計測・通常 None で device 既定）。`device_name` が `Some` かつ一致する output device が
/// あればそれを使う（`--audio-device` honor・#484 D1）。`None`、または一致するデバイスが
/// 見つからなければ fallback metadata を付けて host 既定へ縮退する（起動を失敗させない）。
#[allow(clippy::too_many_arguments)]
fn start_output_inner(
    link: Option<LinkEgress>,
    mut insert_buses: Vec<InsertBusStage>,
    sources: Vec<SourceSlot>,
    post: Option<Box<dyn PostProcessor>>,
    callback_timing: bool,
    buffer_frames: Option<u32>,
    capture_path: Option<PathBuf>,
    device_request: OutputDeviceRequest,
) -> Result<OutputInnerStart, OutputError> {
    validate_source_slots(&sources)?;
    // The liveness gate runs before Engine creation and before insert buses/sources are moved into
    // RenderState. A dead named device can therefore fall back without recovering callback-owned
    // state from a cpal stream that may retain itself.
    let live = select_live_output_device(
        device_request,
        buffer_frames,
        None,
        DeviceFallbackPolicy::FallBackToHostDefault,
    )?;
    let sample_rate = live.sample_rate();
    let channels = live.channels();
    for bus in &mut insert_buses {
        bus.line.set_sample_rate(sample_rate);
        // callback block は通常これより遥かに短い。RT hot path の resize を構造的に排除する。
        // engine は常に 2ch で完結する（設計 §5.5 row 2）。8ch@2048 の feed 破棄（#611 本文の
        // 実害）は `bs = frames*2 <= 8192` で消える — デバイス channel 数に比例して膨らまない。
        bus.ensure_buffer_len(sample_rate as usize * 2);
    }

    // capture seam（#307 realtime・A = daemon-start config / whole-stream）: `capture_path` が
    // 与えられたときのみ master 出力（post 適用後の hw）を WAV へ録る tap を差し込む。env 読取りは
    // daemon 層（`engine_wrap::start`）が行い、解決済みパスをここへ渡す（`buffer_frames` /
    // `OutProcEffectConfig` と同じ層分け）。排他 feature 群（link / clap / outproc）と直交で、どの
    // 経路でも最終 hw をタップする。sink（producer）は callback へ、writer（consumer + off-thread
    // thread）は OutputStream が保持する。
    let (capture_sink, capture_writer) = match capture_path {
        Some(path) => {
            let ring_capacity = sample_rate as usize * channels as usize * CAPTURE_RING_SECONDS;
            let (sink, writer) =
                crate::capture::CaptureWriter::create(path, sample_rate, channels, ring_capacity)
                    .map_err(|e| OutputError::Capture(e.to_string()))?;
            (Some(sink), Some(writer))
        }
        None => (None, None),
    };

    let stats = Arc::new(StreamStats::default());
    // callback-duration 計測は post（CLAP）経路でのみ有効化する。hardware-only / link 経路は
    // 従来通り無計測（None → render_block は計測分岐を踏まずビット同一）。
    let cb_stats = callback_timing.then(CallbackTimeStats::new);
    // 設計 §5.5 row 1: events / feeds / stages はすべて 2ch。デバイス幅は Device 出口の配置
    // （`place_master_into_device`）でのみ現れる。
    let engine = Engine::new(sample_rate, 2);
    let mut master = MasterLine::new(sample_rate, post);
    master.line.set_sample_rate(sample_rate);
    // master.buffer も 2ch 前提で事前確保する（bus buffer と同じ規律・row 2）。
    master.ensure_buffer_len(sample_rate as usize * 2);
    master.ensure_device_buffer_len(sample_rate as usize * channels as usize);
    let render_state = Arc::new(std::sync::Mutex::new(RenderState {
        link,
        insert_buses,
        sources,
        transport: BlockTransport {
            cursor_frames: 0,
            sample_rate,
        },
        master,
    }));
    let stream = build_stream(
        &live,
        engine.clone(),
        stats.clone(),
        render_state.clone(),
        capture_sink,
        cb_stats.clone(),
        StreamBuildStage::Startup,
    )?;
    let mut output_stream = OutputStream {
        _stream: stream,
        _capture: capture_writer,
        render_state,
        device_name: live.name().to_string(),
        sample_rate,
        channels,
        device_requested: live.requested().map(str::to_string),
        device_fallback: live.fallback().cloned(),
        first_callback_ms: 0,
        fault: live.fault,
    };
    play_and_confirm(&mut output_stream, &stats)?;

    Ok((engine, output_stream, stats, cb_stats))
}

/// Rebuild only the cpal device/stream while preserving the engine, callback
/// state, and stream statistics. Capture is intentionally not attached here.
pub fn rebuild_output_stream(
    live: LiveOutputDevice,
    render_state: Arc<std::sync::Mutex<RenderState>>,
    engine: Engine,
    stats: Arc<StreamStats>,
    cb_stats: Option<Arc<CallbackTimeStats>>,
) -> Result<OutputStream, OutputError> {
    render_state
        .lock()
        .map_err(|_| OutputError::NoConfig("render state mutex poisoned".into()))?
        .master
        .ensure_device_buffer_len(live.sample_rate() as usize * live.channels() as usize);
    let stream = build_stream(
        &live,
        engine,
        stats.clone(),
        render_state.clone(),
        None,
        cb_stats,
        StreamBuildStage::Switch,
    )?;
    let mut output_stream = OutputStream {
        _stream: stream,
        _capture: None,
        render_state,
        device_name: live.name().to_string(),
        sample_rate: live.sample_rate(),
        channels: live.channels(),
        device_requested: live.requested().map(str::to_string),
        device_fallback: live.fallback().cloned(),
        first_callback_ms: 0,
        fault: live.fault,
    };
    play_and_confirm(&mut output_stream, &stats)?;
    Ok(output_stream)
}

fn play_and_confirm(
    output_stream: &mut OutputStream,
    stats: &StreamStats,
) -> Result<(), OutputError> {
    let baseline = stats.snapshot().callbacks;
    output_stream.play()?;
    output_stream.first_callback_ms =
        confirm_first_callback(stats, baseline).ok_or_else(|| OutputError::StreamDead {
            device: output_stream.device_name.clone(),
            waited_ms: FIRST_CALLBACK_DEADLINE.as_millis() as u64,
            phase: StreamLivenessPhase::RealStream,
        })?;
    Ok(())
}

fn confirm_first_callback(stats: &StreamStats, baseline: u64) -> Option<u64> {
    confirm_callback_counter(&stats.callbacks, baseline, FIRST_CALLBACK_DEADLINE)
}

#[allow(clippy::too_many_arguments)]
fn build_stream(
    live: &LiveOutputDevice,
    engine: Engine,
    stats: Arc<StreamStats>,
    render_state: Arc<std::sync::Mutex<RenderState>>,
    mut capture: Option<RingTapSink>,
    cb_stats: Option<Arc<CallbackTimeStats>>,
    stage: StreamBuildStage,
) -> Result<Stream, OutputError> {
    let device = &live.device;
    let config = &live.config;
    let sample_format = live.sample_format;
    let suppress_callback = live.fault.suppresses_real_callback(stage);
    let make_err_fn = |stats: Arc<StreamStats>| {
        // 上位 (daemon session) が StreamStats / DaemonError 経由で可視化する責務を持つ。
        move |err: cpal::StreamError| stats.record_error(&err)
    };

    /// scratch バッファを事前に 1 秒分確保してクロージャにムーブするヘルパー。
    /// cpal のコールバック buffer_size は通常数百フレームなので十分余裕がある。
    /// リアルタイムコールバック初回でのヒープ確保を回避する。
    fn scratch_with_capacity(config: &StreamConfig) -> Vec<f32> {
        vec![0.0; (config.sample_rate.0 as usize) * (config.channels as usize)]
    }

    let out_ch = config.channels as usize;
    let callback_stats = stats.clone();

    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| {
                    if suppress_callback {
                        data.fill(0.0);
                        return;
                    }
                    render_shared_block(
                        &engine,
                        &render_state,
                        &mut capture,
                        &cb_stats,
                        out_ch,
                        data,
                        &callback_stats,
                    )
                },
                make_err_fn(stats.clone()),
                None,
            )
            .map_err(|e| OutputError::BuildStream(e.to_string()))?,
        SampleFormat::I16 => {
            // バッファのゼロクリアは render_block 内の render で行うため省略。
            let mut scratch = scratch_with_capacity(config);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        if suppress_callback {
                            data.fill(0);
                            return;
                        }
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        render_shared_block(
                            &engine,
                            &render_state,
                            &mut capture,
                            &cb_stats,
                            out_ch,
                            buf,
                            &callback_stats,
                        );
                        for (i, s) in buf.iter().enumerate() {
                            data[i] = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        }
                    },
                    make_err_fn(stats.clone()),
                    None,
                )
                .map_err(|e| OutputError::BuildStream(e.to_string()))?
        }
        SampleFormat::I32 => {
            // 一部の Linux (ALSA) 環境で出力デフォルトになるため対応。
            let mut scratch = scratch_with_capacity(config);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i32], _| {
                        if suppress_callback {
                            data.fill(0);
                            return;
                        }
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        render_shared_block(
                            &engine,
                            &render_state,
                            &mut capture,
                            &cb_stats,
                            out_ch,
                            buf,
                            &callback_stats,
                        );
                        for (i, s) in buf.iter().enumerate() {
                            data[i] = (s.clamp(-1.0, 1.0) * i32::MAX as f32) as i32;
                        }
                    },
                    make_err_fn(stats.clone()),
                    None,
                )
                .map_err(|e| OutputError::BuildStream(e.to_string()))?
        }
        SampleFormat::U16 => {
            let mut scratch = scratch_with_capacity(config);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        if suppress_callback {
                            data.fill(u16::MAX / 2);
                            return;
                        }
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        render_shared_block(
                            &engine,
                            &render_state,
                            &mut capture,
                            &cb_stats,
                            out_ch,
                            buf,
                            &callback_stats,
                        );
                        for (i, s) in buf.iter().enumerate() {
                            let v = (s.clamp(-1.0, 1.0) * 0.5 + 0.5) * u16::MAX as f32;
                            data[i] = v as u16;
                        }
                    },
                    make_err_fn(stats.clone()),
                    None,
                )
                .map_err(|e| OutputError::BuildStream(e.to_string()))?
        }
        other => {
            return Err(OutputError::NoConfig(format!(
                "unsupported sample format: {other:?}"
            )))
        }
    };
    Ok(stream)
}

#[cfg(test)]
mod source_feed_tests {
    use super::*;

    #[test]
    fn source_dest_cell_roundtrips_every_destination_and_defaults_invalid_values() {
        let cell = SourceDestCell::new(SourceDest::Master);
        assert_eq!(cell.load(), SourceDest::Master);

        for dest in [
            SourceDest::Bus(0),
            SourceDest::Bus(MAX_INSERT_BUS_STAGES - 1),
            SourceDest::Link(0),
            SourceDest::Link(MAX_LINK_CHANNELS - 1),
        ] {
            cell.store(dest);
            assert_eq!(cell.load(), dest);
        }

        cell.store(SourceDest::Bus(MAX_INSERT_BUS_STAGES));
        assert_eq!(cell.load(), SourceDest::Master);
        cell.store(SourceDest::Link(MAX_LINK_CHANNELS));
        assert_eq!(cell.load(), SourceDest::Master);

        let invalid = SourceDestCell(Arc::new(AtomicUsize::new(usize::MAX)));
        assert_eq!(invalid.load(), SourceDest::Master);
    }

    /// source が **毎ブロック受け取る transport** を記録する fixture。`render_engine_with_sources` が
    /// `cursor_frames` を前進させることの検証に使う（この PR で `STUB_TRANSPORT` を実 transport へ
    /// 置き換えたが、前進を assert するテストが1本も無く、`saturating_add` を消しても全 suite が
    /// 通る状態だった — Fable 監査 A-1）。
    fn transport_recording_source(
        log: std::sync::Arc<std::sync::Mutex<Vec<u64>>>,
        units: usize,
    ) -> SourceSlot {
        struct Recorder {
            log: std::sync::Arc<std::sync::Mutex<Vec<u64>>>,
            units: usize,
            output: Vec<f32>,
        }

        impl BlockSource for Recorder {
            fn render(&mut self, _frames: usize, transport: &BlockTransport) -> usize {
                self.log.lock().unwrap().push(transport.cursor_frames);
                self.units
            }

            fn output(&self, unit: usize) -> &[f32] {
                // unit ごとに異なる値を返す（多 unit の取り違えを検出可能にする）。
                assert!(unit < self.units);
                &self.output
            }
        }

        SourceSlot {
            source: Box::new(Recorder {
                log,
                units,
                output: vec![0.25; 8],
            }),
            dests: (0..units.max(1))
                .map(|_| SourceDestCell::new(SourceDest::Master))
                .collect(),
        }
    }

    /// 🔴 `render_engine_with_sources` は毎ブロック `cursor_frames` を frames だけ前進させ、
    /// **その値を source へ渡す**。`transport.cursor_frames = ...saturating_add(frames)` を削ると
    /// 記録が `[0, 0, 0]` になり落ちる（Fable 監査 A-1: 変異が全 suite を生き残っていた）。
    #[test]
    fn source_transport_cursor_advances_by_the_block_length_every_callback() {
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut sources = [transport_recording_source(log.clone(), 1)];
        let engine = Engine::new(48_000, 2);
        let mut link = None;
        let mut buses: [InsertBusStage; 0] = [];
        let mut transport = BlockTransport {
            cursor_frames: 0,
            sample_rate: 48_000,
        };
        let mut hw = vec![0.0f32; 8]; // 2ch × 4 frames

        for _ in 0..3 {
            render_engine_with_sources(
                &engine,
                &mut link,
                &mut buses,
                &mut sources,
                &mut transport,
                2,
                &mut hw,
            );
        }

        // 各コールバックが「そのブロック開始時点の cursor」を受け取る。
        assert_eq!(*log.lock().unwrap(), vec![0, 4, 8]);
        assert_eq!(transport.cursor_frames, 12);
    }

    /// 🔴 多 unit 経路を実際に通す。`collect_source_feeds` の `0..unit_count` を `0..1` に縮めると
    /// feed が1本になり落ちる（Fable 監査 A-2: 多 unit の実行経路が未検証だった）。
    #[test]
    fn every_reported_unit_contributes_a_feed() {
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut sources = [transport_recording_source(log, 3)];
        let transport = BlockTransport {
            cursor_frames: 0,
            sample_rate: 48_000,
        };
        let rendered = render_sources(&mut sources, 4, &transport);
        assert_eq!(rendered.as_slice(), &[3]);

        let feeds = collect_source_feeds(&sources, &rendered, &[], 8);
        // 3 unit すべてが feed を出す（1本や0本ではない）。
        assert_eq!(feeds.len(), 3);
        for (buffer, dest) in &feeds {
            assert_eq!(*dest, FeedDest::Hardware);
            assert_eq!(buffer.len(), 8);
        }
    }

    fn fixed_source(output: Vec<f32>, dest: SourceDest) -> SourceSlot {
        struct FixedSource {
            output: Vec<f32>,
        }

        impl BlockSource for FixedSource {
            fn render(&mut self, _frames: usize, _transport: &BlockTransport) -> usize {
                1
            }

            fn output(&self, unit: usize) -> &[f32] {
                assert_eq!(unit, 0);
                &self.output
            }
        }

        SourceSlot {
            source: Box::new(FixedSource { output }),
            dests: vec![SourceDestCell::new(dest)],
        }
    }

    #[test]
    fn source_feed_path_matches_post_mix_reference_at_unity_gain_bit_for_bit() {
        let sample = orbit_audio_core::Sample::new(vec![0.25; 8], 48_000, 2);
        let reference = Engine::new(48_000, 2);
        reference.schedule(0.0, sample.clone()).expect("schedule");
        let actual_engine = Engine::new(48_000, 2);
        actual_engine.schedule(0.0, sample).expect("schedule");

        let source_output = vec![0.5, -0.25, 0.75, -0.5, 1.0, -0.75, 1.25, -1.0];
        let mut expected = vec![0.0; source_output.len()];
        reference.render(&mut expected);
        for (sample, source) in expected.iter_mut().zip(&source_output) {
            *sample += *source;
        }

        let mut sources = vec![fixed_source(source_output, SourceDest::Master)];
        let mut transport = BlockTransport {
            cursor_frames: 0,
            sample_rate: 48_000,
        };
        let mut actual = vec![0.0; expected.len()];
        let mut link = None;
        let mut buses = Vec::new();
        render_engine_with_sources(
            &actual_engine,
            &mut link,
            &mut buses,
            &mut sources,
            &mut transport,
            2,
            &mut actual,
        );

        assert_eq!(
            actual
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn unregistered_source_bus_falls_back_to_hardware_for_the_whole_block() {
        let source_output = vec![0.25, -0.5, 0.75, -1.0];
        let mut sources = vec![fixed_source(source_output.clone(), SourceDest::Bus(7))];
        let mut transport = BlockTransport {
            cursor_frames: 0,
            sample_rate: 48_000,
        };
        let engine = Engine::new(48_000, 2);
        let mut actual = vec![0.0; source_output.len()];
        render_engine_with_sources(
            &engine,
            &mut None,
            &mut [],
            &mut sources,
            &mut transport,
            2,
            &mut actual,
        );

        assert_eq!(
            actual
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            source_output
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn registered_source_bus_resolves_through_position_map_and_insert() {
        struct Half;

        impl PostProcessor for Half {
            fn process(&mut self, data: &mut [f32]) {
                for sample in data {
                    *sample *= 0.5;
                }
            }
        }

        let mut sources = vec![fixed_source(vec![1.0; 4], SourceDest::Bus(0))];
        let mut buses = vec![InsertBusStage::new("instrument", Some(Box::new(Half)), 4)];
        let mut transport = BlockTransport {
            cursor_frames: 0,
            sample_rate: 48_000,
        };
        let engine = Engine::new(48_000, 2);
        let mut actual = vec![0.0; 4];
        render_engine_with_sources(
            &engine,
            &mut None,
            &mut buses,
            &mut sources,
            &mut transport,
            2,
            &mut actual,
        );

        assert_eq!(
            actual
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            vec![0.5_f32.to_bits(); 4]
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpal::BackendSpecificError;

    #[test]
    fn resolve_requested_device_name_none_when_not_requested() {
        let available = vec!["Built-in Output".to_string(), "USB Audio".to_string()];
        assert_eq!(resolve_requested_device_name(None, &available), None);
    }

    #[test]
    fn resolve_requested_device_name_exact_match() {
        let available = vec!["Built-in Output".to_string(), "USB Audio".to_string()];
        assert_eq!(
            resolve_requested_device_name(Some("USB Audio"), &available),
            Some("USB Audio".to_string())
        );
    }

    #[test]
    fn resolve_requested_device_name_falls_back_when_absent() {
        let available = vec!["Built-in Output".to_string()];
        assert_eq!(
            resolve_requested_device_name(Some("Nonexistent Device"), &available),
            None
        );
    }

    #[test]
    fn resolve_requested_device_name_is_case_sensitive() {
        // 完全一致のみ honor する（大文字小文字の揺れは一致させない — device 名の安定性は
        // プラットフォーム依存で、緩い一致は誤ったデバイスを選びうるため・#484 D1）。
        let available = vec!["USB Audio".to_string()];
        assert_eq!(
            resolve_requested_device_name(Some("usb audio"), &available),
            None
        );
    }

    #[test]
    fn sample_rate_mismatch_reports_device_and_both_rates() {
        let error = validate_expected_sample_rate("USB Audio", 44_100, Some(48_000))
            .expect_err("a live switch must reject a different nominal rate");
        assert!(matches!(
            error,
            OutputError::SampleRateMismatch {
                ref device,
                device_rate: 44_100,
                engine_rate: 48_000,
            } if device == "USB Audio"
        ));
        validate_expected_sample_rate("USB Audio", 48_000, Some(48_000))
            .expect("equal rates are accepted");
        validate_expected_sample_rate("USB Audio", 44_100, None)
            .expect("startup accepts the selected device rate");
    }

    #[test]
    fn first_callback_confirmation_observes_baseline_and_deadline_boundaries() {
        let callbacks = AtomicU64::new(7);
        assert_eq!(
            confirm_callback_counter(&callbacks, 6, Duration::ZERO),
            Some(0),
            "an already-observed callback wins even at the deadline"
        );
        assert_eq!(
            confirm_callback_counter(&callbacks, 7, Duration::ZERO),
            None,
            "an unchanged counter is dead at the deadline"
        );
    }

    #[test]
    fn render_block_zero_buses_bit_identical() {
        let sample = orbit_audio_core::Sample::new(vec![0.25; 8], 48_000, 2);
        let reference = Engine::new(48_000, 2);
        reference.schedule(0.0, sample.clone()).expect("schedule");
        let with_buses = Engine::new(48_000, 2);
        with_buses.schedule(0.0, sample).expect("schedule");
        let mut expected = vec![0.0; 8];
        reference.render(&mut expected);
        let mut buses = Vec::new();
        let mut actual = vec![0.0; 8];
        let mut link = None;
        let mut master = MasterLine::new(48_000, None);
        master.ensure_buffer_len(8);
        let mut capture = None;
        let cb_stats = None;
        render_block(
            &with_buses,
            &mut link,
            &mut buses,
            &mut master,
            &mut capture,
            &cb_stats,
            2,
            &mut actual,
        );
        assert_eq!(actual, expected);
    }

    #[test]
    fn render_block_all_inactive_buses_bit_identical() {
        // 既定 bus プール（宣言前 = 全 stage inactive）は render_engine 経路に落ち、
        // bus 無しとビット同一・追加コストゼロであること（#461 efficiency review）。
        let sample = orbit_audio_core::Sample::new(vec![0.25; 8], 48_000, 2);
        let reference = Engine::new(48_000, 2);
        reference.schedule(0.0, sample.clone()).expect("schedule");
        let with_buses = Engine::new(48_000, 2);
        with_buses.schedule(0.0, sample).expect("schedule");
        let mut expected = vec![0.0; 8];
        reference.render(&mut expected);
        let mut buses = vec![
            InsertBusStage::with_activation("seq-bus-0", None, 8, Arc::new(AtomicBool::new(false))),
            InsertBusStage::with_activation("seq-bus-1", None, 8, Arc::new(AtomicBool::new(false))),
        ];
        let mut actual = vec![0.0; 8];
        let mut link = None;
        let mut master = MasterLine::new(48_000, None);
        master.ensure_buffer_len(8);
        let mut capture = None;
        let cb_stats = None;
        render_block(
            &with_buses,
            &mut link,
            &mut buses,
            &mut master,
            &mut capture,
            &cb_stats,
            2,
            &mut actual,
        );
        assert_eq!(actual, expected);
    }

    #[test]
    fn global_gain_scales_instrument_contribution() {
        struct InstrumentSource {
            output: Vec<f32>,
        }

        impl BlockSource for InstrumentSource {
            fn render(&mut self, _frames: usize, _transport: &BlockTransport) -> usize {
                1
            }

            fn output(&self, unit: usize) -> &[f32] {
                assert_eq!(unit, 0);
                &self.output
            }
        }

        let engine = Engine::new(48_000, 2);
        engine.set_global_gain(0.5, 0.0).expect("set gain");
        let mut hw = vec![0.0; 4];
        let mut link = None;
        let mut buses = Vec::new();
        let mut sources = vec![SourceSlot {
            source: Box::new(InstrumentSource {
                output: vec![1.0; 4],
            }),
            dests: vec![SourceDestCell::new(SourceDest::Master)],
        }];
        let mut transport = BlockTransport {
            cursor_frames: 0,
            sample_rate: 48_000,
        };
        let mut master = MasterLine::new(48_000, None);
        master.ensure_buffer_len(4);
        let mut capture = None;
        render_block_with_sources(
            &engine,
            &mut link,
            &mut buses,
            &mut sources,
            &mut transport,
            &mut master,
            &mut capture,
            &None,
            2,
            &mut hw,
        );

        assert_eq!(
            hw.iter().map(|sample| sample.to_bits()).collect::<Vec<_>>(),
            vec![0.5_f32.to_bits(); 4],
            "instrument contribution must pass through global gain: {hw:?}"
        );
    }

    #[test]
    fn activation_flip_mid_stream_takes_effect_without_reconstruction() {
        // 「宣言 = activation」契約の CI 検証（pr-review-team round 1・test-analyzer C8）:
        // 同じ Arc<AtomicBool> を flip するだけで、stage の再構築なしに render 対象へ
        // 入る/外れることを、除外時の bit-identical と適用時の 0.5×gain の両面で pin する。
        struct Half;
        impl PostProcessor for Half {
            fn process(&mut self, data: &mut [f32]) {
                for sample in data {
                    *sample *= 0.5;
                }
            }
        }
        let active = Arc::new(AtomicBool::new(false));
        let engine = Engine::new(48_000, 2);
        let tagged = orbit_audio_core::Sample::new(vec![2.0; 16], 48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("fx".into()),
                "tagged".into(),
                tagged,
            )
            .expect("schedule");
        let mut buses = vec![InsertBusStage::with_activation(
            "fx",
            Some(Box::new(Half)),
            4,
            active.clone(),
        )];
        // inactive の間、tagged event は render 対象外（消費されない）で hw は無音。
        let mut hw = vec![0.0; 4];
        let mut link = None;
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw);
        assert!(hw.iter().all(|&sample| sample == 0.0));

        // flip 後、同じ stage オブジェクトのまま effect が適用される。
        active.store(true, Ordering::Release);
        let mut hw = vec![0.0; 4];
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw);
        assert!(hw
            .iter()
            .all(|&sample| (sample - 0.5_f32.sqrt()).abs() < 1e-6));
    }

    #[test]
    fn render_block_one_bus_applies_effect_then_sums() {
        struct Half;
        impl PostProcessor for Half {
            fn process(&mut self, data: &mut [f32]) {
                for sample in data {
                    *sample *= 0.5;
                }
            }
        }
        let engine = Engine::new(48_000, 2);
        let tagged = orbit_audio_core::Sample::new(vec![2.0; 4], 48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("fx".into()),
                "tagged".into(),
                tagged,
            )
            .expect("schedule");
        let plain = orbit_audio_core::Sample::new(vec![3.0; 4], 48_000, 2);
        engine.schedule(0.0, plain).expect("schedule");
        let mut buses = vec![InsertBusStage::new("fx", Some(Box::new(Half)), 4)];
        let mut hw = vec![0.0; 4];
        let mut link = None;
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw);
        // center pan の equal-power gain は √0.5。tagged=2.0×√0.5×0.5、
        // untagged=3.0×√0.5 なので、両者の sum = 2√2 を値で pin する。
        assert!(hw
            .iter()
            .all(|&sample| (sample - 2.0_f32.sqrt() * 2.0).abs() < 1e-6));
    }

    #[test]
    fn tagged_event_with_unattached_bus_still_drops() {
        let engine = Engine::new(48_000, 2);
        let sample = orbit_audio_core::Sample::new(vec![1.0; 4], 48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("dry".into()),
                "tagged".into(),
                sample,
            )
            .expect("schedule");
        let mut buses = vec![InsertBusStage::new("dry", None, 4)];
        let mut hw = vec![0.0; 4];
        let mut link = None;
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw);
        assert!(hw
            .iter()
            .all(|&sample| (sample - 0.5_f32.sqrt()).abs() < 1e-6));
        assert_eq!(engine.active_count(), Some(0));
    }

    // #459/#453 M1: mixer graph (sum/aux) 拡張の必須テスト群。既存の per-seq insert のみの構成
    // （output_target=Master・sends 空）が上の既存テスト群でそのまま green であることをもって
    // 「既定構成の挙動不変」を担保する（明示的な回帰確認）。

    #[test]
    fn sum_bus_chains_member_output_before_master() {
        // stage0 "kick"（processor None・output_target=Bus(1) = drum sum へ）
        // stage1 "drum"（sum・0.5×gain processor・output_target 既定 Master）
        struct Half;
        impl PostProcessor for Half {
            fn process(&mut self, data: &mut [f32]) {
                for sample in data {
                    *sample *= 0.5;
                }
            }
        }
        let engine = Engine::new(48_000, 2);
        let tagged = orbit_audio_core::Sample::new(vec![2.0; 4], 48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("kick".into()),
                "tagged".into(),
                tagged,
            )
            .expect("schedule");
        let mut buses = vec![
            InsertBusStage::new("kick", None, 4).with_output_target(BusTarget::Bus(1)),
            InsertBusStage::new("drum", Some(Box::new(Half)), 4),
        ];
        let mut hw = vec![0.0; 4];
        let mut link = None;
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw);
        // kick の寄与（2.0 × equal-power pan √0.5）が drum の 0.5×gain を経て hw に現れる。
        assert!(hw
            .iter()
            .all(|&sample| (sample - 2.0_f32.sqrt() * 0.5).abs() < 1e-6));
    }

    #[test]
    fn send_copies_post_insert_signal_with_gain() {
        // stage0 "a"（0.5×insert processor・Master・send{target:1, gain:0.5}）
        // stage1 "aux"（processor None・Master）
        struct Half;
        impl PostProcessor for Half {
            fn process(&mut self, data: &mut [f32]) {
                for sample in data {
                    *sample *= 0.5;
                }
            }
        }
        let engine = Engine::new(48_000, 2);
        let tagged = orbit_audio_core::Sample::new(vec![2.0; 4], 48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("a".into()),
                "tagged".into(),
                tagged,
            )
            .expect("schedule");
        let mut buses = vec![
            InsertBusStage::new("a", Some(Box::new(Half)), 4).with_sends(vec![BusSend {
                target: 1,
                gain: 0.5,
            }]),
            InsertBusStage::unattached("aux"),
        ];
        buses[1].ensure_buffer_len(4);
        let mut hw = vec![0.0; 4];
        let mut link = None;
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw);
        // raw = 2.0 × equal-power pan √0.5（post-pan・pre-insert）。
        // dry = raw × 0.5（insert 後）が Master へ、wet = dry × 0.5（send gain・post-fader）が
        // aux 経由で Master へ。hw = dry + wet = raw × 0.75。
        let raw = 2.0_f32 * 0.5_f32.sqrt();
        assert!(hw.iter().all(|&sample| (sample - raw * 0.75).abs() < 1e-6));
    }

    fn render_tagged_line(program: LineProgram, frames: usize) -> Vec<f32> {
        let engine = Engine::new(48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("line".into()),
                "line-program".into(),
                // Keep source data beyond the rendered block so the resampler's final-frame
                // boundary does not become part of the line-gain assertion.
                orbit_audio_core::Sample::new(vec![2.0; (frames + 4) * 2], 48_000, 2),
            )
            .expect("schedule line input");
        let mut buses = vec![InsertBusStage::new("line", None, frames * 2).with_line(program)];
        let mut hw = vec![0.0; frames * 2];
        render_engine_with_insert_buses(&engine, &mut None, &mut buses, 2, &mut hw);
        hw
    }

    #[test]
    fn line_program_rejects_non_forward_bus_output_during_topology_validation() {
        let stages = vec![
            InsertBusStage::new("self", None, 4).with_line(LineProgram::new(vec![
                LineOp::Rack,
                LineOp::Output(LineOutput {
                    dest: OutputDest::Bus(0),
                    thru: false,
                    gain: 1.0,
                }),
            ])),
        ];

        let error = validate_bus_topology(&stages).expect_err("self output must be rejected");
        assert!(
            error.to_string().contains("must be a later stage"),
            "{error}"
        );
    }

    fn install_unwired_line_op(op: LineOp) -> OutputError {
        let slot = LineSlot::new(LineProgram::new(vec![LineOp::Rack]));
        slot.line_control()
            .install_for_bus(LineProgram::new(vec![op]), 0, 1)
            .expect_err("an op without an RT implementation must be rejected")
    }

    #[test]
    fn line_program_pan_is_normalized_and_executes_in_rt() {
        let baseline = render_tagged_line(
            LineProgram::settled(vec![LineOp::Output(LineOutput {
                dest: OutputDest::Master,
                thru: false,
                gain: 1.0,
            })]),
            2,
        );
        let centered = render_tagged_line(
            LineProgram::settled(vec![
                LineOp::Pan(0.0),
                LineOp::Output(LineOutput {
                    dest: OutputDest::Master,
                    thru: false,
                    gain: 1.0,
                }),
            ]),
            2,
        );
        assert!(
            centered
                .iter()
                .zip(&baseline)
                .all(|(actual, expected)| (*actual - *expected).abs() <= 1e-6),
            "center Pan must be unity after sqrt(2) normalization: {centered:?} vs {baseline:?}"
        );

        let hard_left = render_tagged_line(
            LineProgram::settled(vec![
                LineOp::Pan(-1.0),
                LineOp::Output(LineOutput {
                    dest: OutputDest::Master,
                    thru: false,
                    gain: 1.0,
                }),
            ]),
            2,
        );
        for frame in hard_left.chunks_exact(2) {
            assert!((frame[0] - 2.0).abs() <= 1e-6, "hard-left L={}", frame[0]);
            assert!(frame[1].abs() <= 1e-6, "hard-left R={}", frame[1]);
        }
        eprintln!(
            "pan normalization center={:?} baseline={:?}; hard-left first={:?}",
            &centered[..2],
            &baseline[..2],
            &hard_left[..2]
        );
    }

    #[test]
    fn line_program_pan_target_change_is_ramped_without_a_large_boundary_jump() {
        let frames = 48;
        let program = LineProgram::with_seeds(vec![LineOp::Pan(1.0)], vec![-1.0]);
        let pan = line_gain(&program, 0, 1.0, frames, 240);
        let centered = 0.5_f32.sqrt();
        let mut next_block = vec![centered; frames * 2];
        apply_line_pan(&mut next_block, frames, pan);

        let previous_frame = [1.0_f32, 0.0_f32];
        let boundary_delta = (next_block[0] - previous_frame[0])
            .abs()
            .max((next_block[1] - previous_frame[1]).abs());
        let in_block_delta = next_block
            .windows(4)
            .map(|window| {
                (window[2] - window[0])
                    .abs()
                    .max((window[3] - window[1]).abs())
            })
            .fold(0.0_f32, f32::max);
        eprintln!(
            "pan ramp seed=-1 target=1 first_pan={pan} boundary_delta={boundary_delta} in_block_max_delta={in_block_delta}"
        );
        assert!((pan - (-0.6)).abs() <= 1e-6);
        assert!(boundary_delta < 0.35, "pan must move by one ramp fraction");
        assert!(in_block_delta <= 1e-6, "one block uses one computed pan");
    }

    #[test]
    fn line_program_install_rejects_unwired_render_destination() {
        let error = install_unwired_line_op(LineOp::Output(LineOutput {
            dest: OutputDest::Render(0),
            thru: false,
            gain: 1.0,
        }));
        assert!(error.to_string().contains("Render is not wired"), "{error}");
    }

    #[test]
    fn line_program_install_rejects_unwired_link_destination() {
        let error = install_unwired_line_op(LineOp::Output(LineOutput {
            dest: OutputDest::Link(0),
            thru: false,
            gain: 1.0,
        }));
        assert!(error.to_string().contains("Link is not wired"), "{error}");
    }

    #[test]
    fn line_output_without_thru_stops_before_later_gain() {
        let hw = render_tagged_line(
            LineProgram::settled(vec![
                LineOp::Rack,
                LineOp::Output(LineOutput {
                    dest: OutputDest::Master,
                    thru: false,
                    gain: 1.0,
                }),
                LineOp::Gain(2.0),
                LineOp::Output(LineOutput {
                    dest: OutputDest::Master,
                    thru: false,
                    gain: 1.0,
                }),
            ]),
            2,
        );
        let raw = 2.0_f32 * 0.5_f32.sqrt();
        assert_eq!(
            hw.iter().map(|sample| sample.to_bits()).collect::<Vec<_>>(),
            vec![raw.to_bits(); 4]
        );
    }

    #[test]
    fn line_output_with_thru_continues_into_later_gain() {
        let hw = render_tagged_line(
            LineProgram::settled(vec![
                LineOp::Rack,
                LineOp::Output(LineOutput {
                    dest: OutputDest::Master,
                    thru: true,
                    gain: 1.0,
                }),
                LineOp::Gain(2.0),
                LineOp::Output(LineOutput {
                    dest: OutputDest::Master,
                    thru: false,
                    gain: 1.0,
                }),
            ]),
            2,
        );
        let expected = (2.0_f32 * 0.5_f32.sqrt()) * 3.0;
        assert_eq!(
            hw.iter().map(|sample| sample.to_bits()).collect::<Vec<_>>(),
            vec![expected.to_bits(); 4]
        );
    }

    fn render_marking_target_after_first_output(first_output_thru: bool) -> Vec<f32> {
        let engine = Engine::new(48_000, 2);
        let mut buses = vec![
            InsertBusStage::new("source", None, 4).with_line(LineProgram::settled(vec![
                LineOp::Output(LineOutput {
                    dest: OutputDest::Master,
                    thru: first_output_thru,
                    gain: 1.0,
                }),
                LineOp::Output(LineOutput {
                    dest: OutputDest::Bus(1),
                    thru: false,
                    gain: 1.0,
                }),
            ])),
            InsertBusStage::with_activation("later", None, 4, Arc::new(AtomicBool::new(false))),
        ];
        buses[1].buffer.fill(0.625);

        let mut hw = vec![0.0; 4];
        render_engine_with_insert_buses(&engine, &mut None, &mut buses, 2, &mut hw);
        buses.remove(1).buffer
    }

    #[test]
    fn marking_stops_before_bus_output_after_thru_false() {
        let later = render_marking_target_after_first_output(false);
        assert_eq!(
            later
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            vec![0.625_f32.to_bits(); 4],
            "an unreachable bus output must not mark or clear the later bus"
        );
    }

    #[test]
    fn marking_reaches_bus_output_after_thru_true() {
        let later = render_marking_target_after_first_output(true);
        assert_eq!(
            later
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            vec![0.0_f32.to_bits(); 4],
            "a reachable bus output must mark and clear the inactive later bus"
        );
    }

    #[test]
    fn line_gain_moves_toward_target_by_block_fraction() {
        let program = LineProgram::new(vec![
            LineOp::Rack,
            LineOp::Gain(0.0),
            LineOp::Output(LineOutput {
                dest: OutputDest::Master,
                thru: false,
                gain: 1.0,
            }),
        ]);
        let hw = render_tagged_line(program, 48);
        let raw = 2.0_f32 * 0.5_f32.sqrt();
        let expected = raw * 0.8;
        assert!(
            hw.iter().all(|sample| (*sample - expected).abs() < 1e-6),
            "first 48-frame block must use 1 + (0 - 1) * (48 / 240): {hw:?}"
        );
        assert!(hw.iter().all(|sample| *sample != 0.0));
    }

    #[test]
    fn line_republish_seed_starts_from_effective_gain_instead_of_unity() {
        let old_op = LineOp::Output(LineOutput {
            dest: OutputDest::Master,
            thru: false,
            gain: 0.1,
        });
        let slot = LineSlot::new(LineProgram::new(vec![LineOp::Rack]));
        let control = slot.line_control();
        control
            .install_for_bus(LineProgram::new(vec![old_op]), 0, 1)
            .expect("old output line installs");
        slot.visit_program_for_test(|program| {
            let settled = line_gain(program, 0, 0.1, 240, 240);
            assert!((settled - 0.1).abs() <= 1e-6);
        });
        let old_current = control.current_gains();
        assert!((old_current[0] - 0.1).abs() <= 1e-6);

        let new_op = LineOp::Output(LineOutput {
            dest: OutputDest::Master,
            thru: false,
            gain: 1.0,
        });
        control
            .install_for_bus(
                LineProgram::with_seeds(vec![new_op], vec![old_current[0]]),
                0,
                1,
            )
            .expect("seeded replacement installs");
        let mut seeded = 0.0;
        slot.visit_program_for_test(|program| {
            seeded = line_gain(program, 0, 1.0, 24, 240);
        });

        let unseeded_program = LineProgram::new(vec![new_op]);
        let unseeded = line_gain(&unseeded_program, 0, 1.0, 24, 240);
        eprintln!(
            "republish first block: seeded={seeded:.6} unseeded={unseeded:.6} old_current={:.6}",
            old_current[0]
        );
        assert!((seeded - 0.19).abs() <= 1e-6);
        assert!((unseeded - 1.0).abs() <= 1e-6);
    }

    fn render_legacy_static_line(use_program: bool) -> Vec<u32> {
        struct Half;
        impl PostProcessor for Half {
            fn process(&mut self, data: &mut [f32]) {
                for sample in data {
                    *sample *= 0.5;
                }
            }
        }

        let engine = Engine::new(48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("source".into()),
                "compat-static".into(),
                orbit_audio_core::Sample::new(
                    vec![0.25, -0.5, 0.75, -1.0, 1.25, -1.5, 1.75, -2.0],
                    48_000,
                    2,
                ),
            )
            .expect("schedule static compatibility input");

        let source = if use_program {
            InsertBusStage::new("source", None, 8).with_line(LineProgram::settled(vec![
                LineOp::Rack,
                LineOp::Output(LineOutput {
                    dest: OutputDest::Bus(1),
                    thru: true,
                    gain: 1.0,
                }),
                LineOp::Output(LineOutput {
                    dest: OutputDest::Bus(2),
                    thru: false,
                    gain: 0.375,
                }),
            ]))
        } else {
            InsertBusStage::new("source", None, 8)
                .with_output_target(BusTarget::Bus(1))
                .with_sends(vec![BusSend {
                    target: 2,
                    gain: 0.375,
                }])
        };
        let mut buses = vec![
            source,
            InsertBusStage::new("sum", Some(Box::new(Half)), 8),
            InsertBusStage::unattached("aux"),
        ];
        buses[2].ensure_buffer_len(8);
        let mut hw = vec![0.0; 8];
        render_engine_with_insert_buses(&engine, &mut None, &mut buses, 2, &mut hw);
        hw.into_iter().map(f32::to_bits).collect()
    }

    #[test]
    fn legacy_output_target_and_sends_match_line_program_bit_for_bit() {
        let legacy = render_legacy_static_line(false);
        let program = render_legacy_static_line(true);
        assert_eq!(program, legacy);
    }

    fn schedule_runtime_compat_input(engine: &Engine, id: &str) {
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("source".into()),
                id.into(),
                orbit_audio_core::Sample::new(
                    vec![0.125, -0.25, 0.5, -1.0, 1.5, -2.0, 2.5, -3.0],
                    48_000,
                    2,
                ),
            )
            .expect("schedule runtime compatibility input");
    }

    #[derive(Debug, PartialEq, Eq)]
    struct RuntimeRoutingBits {
        hw: Vec<u32>,
        buses: Vec<Vec<u32>>,
    }

    struct RuntimeRoutingHarness {
        legacy_engine: Engine,
        program_engine: Engine,
        legacy_buses: Vec<InsertBusStage>,
        program_buses: Vec<InsertBusStage>,
        legacy_output: Arc<AtomicUsize>,
        legacy_sends: Vec<Arc<AtomicU32>>,
        install_line: LegacyLineInstaller,
        effective_output: BusTarget,
        effective_send_gains: Vec<f32>,
    }

    impl RuntimeRoutingHarness {
        fn new() -> Self {
            struct Half;
            impl PostProcessor for Half {
                fn process(&mut self, data: &mut [f32]) {
                    for sample in data {
                        *sample *= 0.5;
                    }
                }
            }

            let legacy_output = Arc::new(AtomicUsize::new(0));
            let legacy_sends = (0..3)
                .map(|_| Arc::new(AtomicU32::new(0)))
                .collect::<Vec<_>>();
            let legacy_source = InsertBusStage::new("source", None, 8)
                .with_routing_overrides(legacy_output.clone(), legacy_sends.clone());
            let program_source = InsertBusStage::new("source", None, 8);
            let install_line = program_source.legacy_line_installer();

            Self {
                legacy_engine: Engine::new(48_000, 2),
                program_engine: Engine::new(48_000, 2),
                legacy_buses: vec![
                    legacy_source,
                    InsertBusStage::new("sum", Some(Box::new(Half)), 8),
                    InsertBusStage::new("aux-a", None, 8),
                    InsertBusStage::new("aux-b", None, 8),
                ],
                program_buses: vec![
                    program_source,
                    InsertBusStage::new("sum", Some(Box::new(Half)), 8),
                    InsertBusStage::new("aux-a", None, 8),
                    InsertBusStage::new("aux-b", None, 8),
                ],
                legacy_output,
                legacy_sends,
                install_line,
                effective_output: BusTarget::Master,
                effective_send_gains: vec![0.0; 3],
            }
        }

        fn set_bus_routing(&mut self, output: Option<BusTarget>, sends: &[BusSend]) {
            if let Some(target) = output {
                self.effective_output = target;
                let encoded = match target {
                    BusTarget::Master => 1,
                    BusTarget::Bus(index) => index + 2,
                };
                self.legacy_output.store(encoded, Ordering::Relaxed);
            }
            for send in sends {
                let offset = send.target - 1;
                self.effective_send_gains[offset] = send.gain;
                self.legacy_sends[offset].store(send.gain.to_bits(), Ordering::Relaxed);
            }
            let enabled_sends = self
                .effective_send_gains
                .iter()
                .copied()
                .enumerate()
                .filter(|(_, gain)| *gain != 0.0)
                .map(|(offset, gain)| BusSend {
                    target: offset + 1,
                    gain,
                })
                .collect();
            (self.install_line)(self.effective_output, enabled_sends, 0, 4)
                .expect("install complete runtime routing line");
        }

        fn render(mut self, case: &str) -> (RuntimeRoutingBits, RuntimeRoutingBits) {
            schedule_runtime_compat_input(&self.legacy_engine, &format!("legacy-{case}"));
            schedule_runtime_compat_input(&self.program_engine, &format!("program-{case}"));
            let mut legacy_hw = vec![0.0; 8];
            let mut program_hw = vec![0.0; 8];
            render_engine_with_insert_buses(
                &self.legacy_engine,
                &mut None,
                &mut self.legacy_buses,
                2,
                &mut legacy_hw,
            );
            render_engine_with_insert_buses(
                &self.program_engine,
                &mut None,
                &mut self.program_buses,
                2,
                &mut program_hw,
            );

            let snapshot = |hw: Vec<f32>, buses: Vec<InsertBusStage>| RuntimeRoutingBits {
                hw: hw.into_iter().map(f32::to_bits).collect(),
                buses: buses
                    .into_iter()
                    .map(|bus| bus.buffer.into_iter().map(f32::to_bits).collect())
                    .collect(),
            };
            (
                snapshot(legacy_hw, self.legacy_buses),
                snapshot(program_hw, self.program_buses),
            )
        }
    }

    fn assert_runtime_routing_topology_matches(
        harness: RuntimeRoutingHarness,
        case: &str,
    ) -> RuntimeRoutingBits {
        let (legacy, program) = harness.render(case);
        assert_eq!(program, legacy, "runtime routing mismatch for {case}");
        program
    }

    #[test]
    fn legacy_runtime_routing_topology_master_only_matches_all_buffers_bit_for_bit() {
        assert_runtime_routing_topology_matches(RuntimeRoutingHarness::new(), "master-only");
    }

    #[test]
    fn legacy_runtime_routing_topology_sum_only_matches_all_buffers_bit_for_bit() {
        let mut harness = RuntimeRoutingHarness::new();
        harness.set_bus_routing(Some(BusTarget::Bus(1)), &[]);
        assert_runtime_routing_topology_matches(harness, "sum-only");
    }

    #[test]
    fn legacy_runtime_routing_topology_output_only_update_retains_send_bit_for_bit() {
        let mut harness = RuntimeRoutingHarness::new();
        harness.set_bus_routing(
            Some(BusTarget::Bus(1)),
            &[BusSend {
                target: 2,
                gain: 0.375,
            }],
        );
        harness.set_bus_routing(Some(BusTarget::Master), &[]);
        let program = assert_runtime_routing_topology_matches(harness, "output-only-retains-send");
        assert!(
            program.buses[2]
                .iter()
                .any(|sample| *sample != 0.0_f32.to_bits()),
            "the send omitted by the second update must remain audible in its bus buffer"
        );
    }

    #[test]
    fn legacy_runtime_routing_topology_two_sends_match_all_buffers_bit_for_bit() {
        let mut harness = RuntimeRoutingHarness::new();
        harness.set_bus_routing(
            Some(BusTarget::Bus(1)),
            &[
                BusSend {
                    target: 2,
                    gain: 0.25,
                },
                BusSend {
                    target: 3,
                    gain: 0.625,
                },
            ],
        );
        let program = assert_runtime_routing_topology_matches(harness, "two-sends");
        assert_ne!(
            program.buses[2], program.buses[3],
            "different send gains must produce distinct destination buffers"
        );
    }

    #[test]
    fn legacy_runtime_routing_switch_matches_line_program_install_bit_for_bit() {
        struct Half;
        impl PostProcessor for Half {
            fn process(&mut self, data: &mut [f32]) {
                for sample in data {
                    *sample *= 0.5;
                }
            }
        }

        let legacy_engine = Engine::new(48_000, 2);
        let program_engine = Engine::new(48_000, 2);
        schedule_runtime_compat_input(&legacy_engine, "legacy-before");
        schedule_runtime_compat_input(&program_engine, "program-before");

        let routing = Arc::new(AtomicUsize::new(0));
        let send_to_sum = Arc::new(AtomicU32::new(0));
        let send_to_aux = Arc::new(AtomicU32::new(0));
        let legacy_source = InsertBusStage::new("source", None, 8)
            .with_routing_overrides(routing.clone(), vec![send_to_sum, send_to_aux.clone()]);
        let program_source = InsertBusStage::new("source", None, 8);
        let install_line = program_source.legacy_line_installer();
        let mut legacy_buses = vec![
            legacy_source,
            InsertBusStage::new("sum", Some(Box::new(Half)), 8),
            InsertBusStage::unattached("aux"),
        ];
        let mut program_buses = vec![
            program_source,
            InsertBusStage::new("sum", Some(Box::new(Half)), 8),
            InsertBusStage::unattached("aux"),
        ];
        legacy_buses[2].ensure_buffer_len(8);
        program_buses[2].ensure_buffer_len(8);

        let mut legacy_before = vec![0.0; 8];
        let mut program_before = vec![0.0; 8];
        render_engine_with_insert_buses(
            &legacy_engine,
            &mut None,
            &mut legacy_buses,
            2,
            &mut legacy_before,
        );
        render_engine_with_insert_buses(
            &program_engine,
            &mut None,
            &mut program_buses,
            2,
            &mut program_before,
        );
        assert_eq!(
            program_before
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            legacy_before
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );

        routing.store(3, Ordering::Relaxed);
        send_to_aux.store(0.375_f32.to_bits(), Ordering::Relaxed);
        install_line(
            BusTarget::Bus(1),
            vec![BusSend {
                target: 2,
                gain: 0.375,
            }],
            0,
            3,
        )
        .expect("install switched line");
        schedule_runtime_compat_input(&legacy_engine, "legacy-after");
        schedule_runtime_compat_input(&program_engine, "program-after");

        let mut legacy_after = vec![0.0; 8];
        let mut program_after = vec![0.0; 8];
        render_engine_with_insert_buses(
            &legacy_engine,
            &mut None,
            &mut legacy_buses,
            2,
            &mut legacy_after,
        );
        render_engine_with_insert_buses(
            &program_engine,
            &mut None,
            &mut program_buses,
            2,
            &mut program_after,
        );
        assert_eq!(
            program_after
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            legacy_after
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn retired_line_program_survives_an_in_flight_rt_read() {
        let dropped_on = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut slot = LineSlot::new(
            LineProgram::new(vec![LineOp::Rack]).with_drop_thread_log(dropped_on.clone()),
        );
        let control = slot.line_control();
        let reached_after_load = Arc::new(std::sync::Barrier::new(2));
        let resume_read = Arc::new(std::sync::Barrier::new(2));
        slot.interlock_next_read(reached_after_load.clone(), resume_read.clone());

        let rt = std::thread::spawn(move || {
            slot.visit_program_for_test(|program| assert_eq!(program.ops.len(), 1));
            slot.visit_program_for_test(|program| assert_eq!(program.ops.len(), 1));
            slot
        });
        reached_after_load.wait();
        control
            .install_for_bus(LineProgram::new(vec![LineOp::Rack]), 0, 1)
            .expect("install while RT holds old program");
        assert!(
            dropped_on.lock().unwrap().is_empty(),
            "the in-flight program must not be reclaimed"
        );
        resume_read.wait();
        let slot = rt.join().expect("RT reader");

        let control_thread = std::thread::current().id();
        control
            .install_for_bus(LineProgram::new(vec![LineOp::Rack]), 0, 1)
            .expect("collect after two completed RT generations");
        assert_eq!(*dropped_on.lock().unwrap(), vec![control_thread]);
        drop(slot);
    }

    // #459/#453 M2: 実行時ルーティング（`routing_override`/`send_gain_overrides`）が次の
    // callback から反映されることを固定する（`SetBusRouting` は control 側で atomic を書き換える
    // だけで render 側には触れない、という設計の生命線）。

    #[test]
    fn routing_override_retargets_output_from_master_to_bus_on_next_callback() {
        // stage0 "a"（static output_target=Master）に override で Bus(1) を書き込むと、次の
        // callback から「a → drum(0.5×gain) → Master」経路に切り替わる。
        struct Half;
        impl PostProcessor for Half {
            fn process(&mut self, data: &mut [f32]) {
                for sample in data {
                    *sample *= 0.5;
                }
            }
        }
        let engine = Engine::new(48_000, 2);
        let tagged = orbit_audio_core::Sample::new(vec![2.0; 4], 48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("a".into()),
                "tagged".into(),
                tagged,
            )
            .expect("schedule");

        let routing_override = Arc::new(AtomicUsize::new(0));
        let mut buses = vec![
            InsertBusStage::new("a", None, 4).with_routing_overrides(
                routing_override.clone(),
                vec![Arc::new(AtomicU32::new(0))],
            ),
            InsertBusStage::new("drum", Some(Box::new(Half)), 4),
        ];
        let mut hw = vec![0.0; 4];
        let mut link = None;

        // override 前: 既定 static Master へ直接加算される（drum の 0.5×gain を経ない）。
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw);
        let raw = 2.0_f32 * 0.5_f32.sqrt();
        assert!(hw.iter().all(|&sample| (sample - raw).abs() < 1e-6));

        // override 書き込み（= `SetBusRouting` が control 側から行う操作の模擬）。
        // encoding: n = target_index(1) + 2 = 3.
        routing_override.store(3, Ordering::Relaxed);

        // 次の block を再スケジュールして再度 render（同じ音を再現）。
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("a".into()),
                "tagged2".into(),
                orbit_audio_core::Sample::new(vec![2.0; 4], 48_000, 2),
            )
            .expect("schedule");
        let mut hw2 = vec![0.0; 4];
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw2);
        assert!(hw2.iter().all(|&sample| (sample - raw * 0.5).abs() < 1e-6));
    }

    #[test]
    fn send_gain_override_applies_from_the_correct_slot_on_next_callback() {
        // stage0 "a"（processor None）に override で aux(index 1) への send gain を書き込むと、
        // 次の callback から Master(dry) + aux(wet) の合成に切り替わる。
        let engine = Engine::new(48_000, 2);
        let tagged = orbit_audio_core::Sample::new(vec![2.0; 4], 48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("a".into()),
                "tagged".into(),
                tagged,
            )
            .expect("schedule");

        let send_slot = Arc::new(AtomicU32::new(0));
        let mut buses = vec![
            InsertBusStage::new("a", None, 4)
                .with_routing_overrides(Arc::new(AtomicUsize::new(0)), vec![send_slot.clone()]),
            InsertBusStage::unattached("aux"),
        ];
        buses[1].ensure_buffer_len(4);
        let mut hw = vec![0.0; 4];
        let mut link = None;

        // override 前: dry のみ Master へ。
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw);
        let raw = 2.0_f32 * 0.5_f32.sqrt();
        assert!(hw.iter().all(|&sample| (sample - raw).abs() < 1e-6));

        // send gain override 書き込み（`SetBusRouting` の模擬）。
        send_slot.store(0.5_f32.to_bits(), Ordering::Relaxed);

        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("a".into()),
                "tagged2".into(),
                orbit_audio_core::Sample::new(vec![2.0; 4], 48_000, 2),
            )
            .expect("schedule");
        let mut hw2 = vec![0.0; 4];
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw2);
        // dry(raw) + wet(raw × 0.5 send gain) = raw × 1.5.
        assert!(hw2.iter().all(|&sample| (sample - raw * 1.5).abs() < 1e-6));
    }

    #[test]
    fn invalid_forward_reference_rejected() {
        // target/send が自分以下の index を指す構成は構築 API で拒否する（sum のネスト・循環を
        // 構造的に排除する MX.4 の不変条件）。
        let self_ref =
            vec![InsertBusStage::new("a", None, 4).with_output_target(BusTarget::Bus(0))];
        assert!(validate_bus_topology(&self_ref).is_err());

        let backward_ref = vec![
            InsertBusStage::new("a", None, 4).with_output_target(BusTarget::Bus(0)),
            InsertBusStage::new("b", None, 4),
        ];
        assert!(validate_bus_topology(&backward_ref).is_err());

        let bad_send = vec![InsertBusStage::new("a", None, 4).with_sends(vec![BusSend {
            target: 0,
            gain: 0.5,
        }])];
        assert!(validate_bus_topology(&bad_send).is_err());

        let ok = vec![
            InsertBusStage::new("a", None, 4).with_output_target(BusTarget::Bus(1)),
            InsertBusStage::new("b", None, 4),
        ];
        assert!(validate_bus_topology(&ok).is_ok());
    }

    #[test]
    fn inactive_sum_target_still_receives_member_output() {
        // stage0 "kick"（active・processor None・output_target=Bus(1)）
        // stage1 "drum"（inactive = 未 declare・processor None・output_target 既定 Master）でも、
        // active な member から参照される is_render_target として buffer が生き、
        // hw まで合成が届くこと。
        let engine = Engine::new(48_000, 2);
        let tagged = orbit_audio_core::Sample::new(vec![1.0; 4], 48_000, 2);
        engine
            .schedule_with_play_id(
                0.0,
                1.0,
                0.0,
                0,
                0,
                1.0,
                Some("kick".into()),
                "tagged".into(),
                tagged,
            )
            .expect("schedule");
        let mut buses = vec![
            InsertBusStage::new("kick", None, 4).with_output_target(BusTarget::Bus(1)),
            InsertBusStage::with_activation("drum", None, 4, Arc::new(AtomicBool::new(false))),
        ];
        let mut hw = vec![0.0; 4];
        let mut link = None;
        render_engine_with_insert_buses(&engine, &mut link, &mut buses, 2, &mut hw);
        assert!(hw
            .iter()
            .all(|&sample| (sample - 0.5_f32.sqrt()).abs() < 1e-6));
    }

    #[test]
    fn stream_stats_starts_at_zero() {
        let stats = StreamStats::default();
        let snap = stats.snapshot();
        assert_eq!(snap.xruns, 0);
        assert_eq!(snap.buffer_underruns, 0);
        assert!(!snap.device_lost);
        assert_eq!(snap.callbacks, 0);
        assert_eq!(snap.last_frames, 0);
    }

    #[test]
    fn render_callback_records_count_and_last_frames_without_timing_stats() {
        let engine = Engine::new(48_000, 2);
        // #649 で `post` は `MasterLine` の中へ移った（master ラック → gain → device 配置を
        // 1 本の固定 program にするため）。本番は `start_output_inner` が起動時に確保するので、
        // ここでも同じように事前確保する（RT では resize しない規律）。
        let mut master = MasterLine::new(48_000, None);
        // 本番（`start_output_inner`）と同じく 1 秒ぶんを確保する。このテストは 8 と 12 の
        // 2 種類のブロックを流すので、大きい方に足りる必要がある。
        master.ensure_buffer_len(48_000 * ENGINE_CHANNELS);
        let state = Arc::new(std::sync::Mutex::new(RenderState {
            link: None,
            insert_buses: Vec::new(),
            sources: Vec::new(),
            transport: BlockTransport {
                cursor_frames: 0,
                sample_rate: 48_000,
            },
            master,
        }));
        let stats = StreamStats::default();
        let mut capture = None;
        let cb_stats = None;

        let mut first = vec![0.0; 8];
        render_shared_block(
            &engine,
            &state,
            &mut capture,
            &cb_stats,
            2,
            &mut first,
            &stats,
        );
        let first_snapshot = stats.snapshot();
        assert_eq!(first_snapshot.callbacks, 1);
        assert_eq!(first_snapshot.last_frames, 4);

        let mut second = vec![0.0; 12];
        render_shared_block(
            &engine,
            &state,
            &mut capture,
            &cb_stats,
            2,
            &mut second,
            &stats,
        );
        let second_snapshot = stats.snapshot();
        assert_eq!(second_snapshot.callbacks, 2);
        assert_eq!(second_snapshot.last_frames, 6);
    }

    #[test]
    fn record_xrun_increments_only_xruns() {
        let stats = StreamStats::default();
        stats.record_xrun();
        stats.record_xrun();
        stats.record_xrun();
        let snap = stats.snapshot();
        assert_eq!(snap.xruns, 3);
        assert_eq!(snap.buffer_underruns, 0);
        assert!(!snap.device_lost);
    }

    // gated probe(A4-2b-2): daemon-level 層B テストは実 cpal stream(start_default_output →
    // 実 output device)を要する(StubBackend は callback を起こさないため)。headless で開けるかを
    // 確認する。CI/sandbox に device が無い場合があるので #[ignore]・local で `--ignored` 実行。
    // 開けなければ daemon-level 層B は manual-dog-food のみ = owner へ stop&report。
    #[test]
    #[ignore = "needs a real audio output device; run with --ignored"]
    fn start_default_output_opens_headless() {
        match start_default_output(None) {
            Ok((_engine, _stream, _stats)) => { /* 開けた。drop で teardown。 */ }
            Err(e) => panic!("start_default_output が headless で開けなかった: {e}"),
        }
    }

    // daemon-level 層B の前提検証(advisor #1): stream が「開く」だけでなく callback が実際に
    // 「tick する」(render が回り transport が進む)かを確認する。callback が回れば now_sec が
    // 前進する(render は無音でも transport を進める)。前進しなければ headless で callback が
    // 起きない env = daemon-level 層B は **実 callback 駆動にできない** → owner へ manual-dog-food
    // で stop&report(合成 ring feed で偽装しない)。
    #[test]
    #[ignore = "needs a real audio output device that delivers callbacks; run with --ignored"]
    fn start_default_output_callback_ticks_headless() {
        let (engine, _stream, _stats) =
            start_default_output(None).expect("start_default_output should open");
        std::thread::sleep(std::time::Duration::from_millis(200));
        let now = engine.now_sec();
        assert!(
            matches!(now, Some(t) if t > 0.05),
            "callback が tick していない(now_sec={now:?})。headless で callback が起きない env = \
             daemon-level 層B は実 callback 駆動不可 → manual-dog-food 報告へ"
        );
    }

    #[test]
    fn snapshot_is_monotonic() {
        let stats = StreamStats::default();
        let s1 = stats.snapshot();
        stats.record_xrun();
        let s2 = stats.snapshot();
        assert!(s2.xruns > s1.xruns);
    }

    #[test]
    fn record_device_lost_sets_flag() {
        let stats = StreamStats::default();
        assert!(!stats.snapshot().device_lost);
        stats.record_device_lost();
        assert!(stats.snapshot().device_lost);
    }

    #[test]
    fn device_lost_and_xrun_are_independent() {
        let stats = StreamStats::default();
        stats.record_xrun();
        let after_xrun = stats.snapshot();
        assert_eq!(after_xrun.xruns, 1);
        assert!(!after_xrun.device_lost);

        stats.record_device_lost();
        let after_lost = stats.snapshot();
        assert_eq!(
            after_lost.xruns, 1,
            "record_device_lost must not touch xruns"
        );
        assert!(after_lost.device_lost);
    }

    #[test]
    fn record_error_dispatches_device_not_available_as_device_lost() {
        let stats = StreamStats::default();
        stats.record_error(&cpal::StreamError::DeviceNotAvailable);
        let snap = stats.snapshot();
        assert!(snap.device_lost);
        assert_eq!(snap.xruns, 0);
    }

    #[test]
    fn record_error_dispatches_backend_specific_as_xrun() {
        let stats = StreamStats::default();
        stats.record_error(&cpal::StreamError::BackendSpecific {
            err: BackendSpecificError {
                description: "transient underrun".to_string(),
            },
        });
        let snap = stats.snapshot();
        assert_eq!(snap.xruns, 1);
        assert!(!snap.device_lost);
    }

    /// hw を定数で埋める post-processor スタブ（engine render の無音を潰す）。
    /// **master ラックが「音を生成・変形する」場合**を模す。
    struct FillPost(f32);
    impl PostProcessor for FillPost {
        fn process(&mut self, data: &mut [f32]) {
            data.fill(self.0);
        }
    }

    /// 🔴 **これが #649 の残り半分を守る唯一のテスト**（2026-09-05・Fable 監査 I-1）。
    ///
    /// #649 の症状「`global.gain()` が instrument に効かない」は、instrument を mixer source へ
    /// 移した `374e8b2d`（2026-08-29・main）で既に消えている。**gated `E2E-1` は main の rust でも
    /// 緑になる**（実機で確認済み）ので、E2E-1 は本 PR の Rust 差分を何も守っていない。
    ///
    /// 残っていたのは**同じクラスの別の穴**: master ラック（`post`）が core の gain ramp の
    /// **後**に走っていたので、**ラックが生成・変形した音は `global.gain()` を逃れていた**。
    /// `MasterLine` は順序を `rack → gain` に固定してこれを塞ぐ（設計 §5.2）。
    ///
    /// このテストが赤になる変異: `render_block_with_sources` で `post.process` と
    /// `advance_gain` の乗算を入れ替える（= main の順序に戻す）。その時 hw は 0.75 になる。
    ///
    /// **`Gain` のような線形ラックでは順序を区別できない**（乗算は可換）ので、DSL 経由の E2E では
    /// この不変条件を測れない（`#611 O0-4` のテスト名が「a linear rack cannot show order」と
    /// 言っているのはこのこと）。だからここはユニットで押さえる。
    #[test]
    fn master_gain_applies_after_the_master_rack_generates_sound() {
        let engine = Engine::new(48_000, 2); // schedule 空 → render は無音（0.0）。
        let mut link: Option<LinkEgress> = None;
        let mut master = MasterLine::new(48_000, Some(Box::new(FillPost(0.75))));
        master.ensure_buffer_len(8);
        // ramp が 1 block で目標へ到達するよう、block を ramp_frames 以上にする（4 frames では
        // 一次遅れの途中になるため、ここでは `gain_current` を直接置いて狙いを 1 つに絞る）。
        master
            .gain_target_handle()
            .store(0.5_f32.to_bits(), Ordering::Relaxed);
        master.gain_current = 0.5;
        let mut capture: Option<RingTapSink> = None;
        let cb_stats: Option<Arc<CallbackTimeStats>> = None;

        let mut hw = vec![0.0f32; 8]; // 4 frames × 2ch。
        render_block(
            &engine,
            &mut link,
            &mut [],
            &mut master,
            &mut capture,
            &cb_stats,
            2,
            &mut hw,
        );

        // 0.75（ラックが生成）× 0.5（master gain）= 0.375。
        // 順序が逆なら 0.75 のまま（gain は無音に掛かるだけ）。
        assert!(
            hw.iter().all(|&s| (s - 0.375).abs() < 1e-6),
            "master gain must attenuate what the master rack produced: {hw:?}"
        );
    }

    #[test]
    fn set_bus_line_master_program_executes_in_the_published_order() {
        let engine = Engine::new(48_000, 2);
        let mut link: Option<LinkEgress> = None;
        let mut master = MasterLine::new(48_000, Some(Box::new(FillPost(0.75))));
        let frames = 512;
        master.ensure_buffer_len(frames * 2);
        master.ensure_device_buffer_len(frames * 2);
        master
            .line_program_installer()
            .install_for_bus(
                LineProgram::new(vec![
                    LineOp::Rack,
                    LineOp::Gain(0.5),
                    LineOp::Output(LineOutput {
                        dest: OutputDest::Device {
                            left: 0,
                            right: Some(1),
                        },
                        thru: false,
                        gain: 1.0,
                    }),
                ]),
                usize::MAX,
                0,
            )
            .expect("valid master program installs");
        let mut capture: Option<RingTapSink> = None;
        let cb_stats: Option<Arc<CallbackTimeStats>> = None;
        let mut hw = vec![0.0; frames * 2];

        render_block(
            &engine,
            &mut link,
            &mut [],
            &mut master,
            &mut capture,
            &cb_stats,
            2,
            &mut hw,
        );

        assert!(
            hw.iter().all(|sample| (*sample - 0.375).abs() < 1e-6),
            "rack -> gain -> device must execute in wire order"
        );
    }

    /// `advance_gain` は block が ramp より長ければ 1 回で目標へ到達し、短ければ寄っていく。
    #[test]
    fn advance_gain_saturates_at_the_target_for_blocks_longer_than_the_ramp() {
        let mut master = MasterLine::new(48_000, None);
        master
            .gain_target_handle()
            .store(0.25_f32.to_bits(), Ordering::Relaxed);
        // ramp_frames は 48_000 の 5 ms = 240。512 frame block は frac = 1.0 で即時到達。
        assert!((master.advance_gain(512) - 0.25).abs() < 1e-6);

        let mut slow = MasterLine::new(48_000, None);
        slow.gain_target_handle()
            .store(0.0_f32.to_bits(), Ordering::Relaxed);
        // 64 frame block は frac = 64/240 なので 1 回では到達しない（が単調に近づく）。
        let first = slow.advance_gain(64);
        assert!(first < 1.0 && first > 0.0, "{first}");
        let second = slow.advance_gain(64);
        assert!(
            second < first,
            "gain must keep approaching the target: {first} -> {second}"
        );
    }

    /// 3ch 以上のデバイスでは ch0/1 だけに置き、**ch2 以降には何も書かない**
    /// （呼び出し側が zero-fill 済み）。8ch@2048 は #611 本文の実害そのもの。
    #[test]
    fn place_master_into_device_fills_only_the_first_two_channels() {
        let buf = [0.1, 0.2, 0.3, 0.4]; // 2 frames × 2ch
                                        // 🔴 前の内容を残した状態で渡す。呼び出し側は zero-fill しないので、**余剰チャンネルを
                                        // 0 にするのはこの関数の責務**。0 埋め済みの hw を渡すと、その責務を検査できない。
        let mut hw = vec![9.9f32; 2 * 8]; // 2 frames × 8ch
        place_master_into_device(&buf, 2, 8, &mut hw);
        assert_eq!(&hw[0..2], &[0.1, 0.2]);
        assert!(hw[2..8].iter().all(|&s| s == 0.0), "{hw:?}");
        assert_eq!(&hw[8..10], &[0.3, 0.4]);
        assert!(hw[10..16].iter().all(|&s| s == 0.0), "{hw:?}");
    }

    /// mono デバイスは L+R を 0.5 でマージする（相関信号でクリップしない）。
    #[test]
    fn place_master_into_device_merges_to_mono_at_half_gain() {
        let buf = [1.0, 1.0, 1.0, -1.0]; // frame0: 相関 / frame1: 逆相
        let mut hw = vec![9.9f32; 2];
        place_master_into_device(&buf, 2, 1, &mut hw);
        assert!((hw[0] - 1.0).abs() < 1e-6, "{hw:?}");
        assert!(hw[1].abs() < 1e-6, "{hw:?}");
    }

    // #307 capture seam: render_block が capture へ渡すのは **post 適用後**の hw であることを
    // 実 device 抜きで pin する。post が hw を 0.75 に上書きするスタブを挿し、capture ring に
    // commit された値が 0.75（post 後）であって 0.0（engine render 直後の無音・post 前）でない
    // ことを確認する。順序が逆（capture が post より前）だと無音を録ってしまい、gated harness が
    // 落ちるまで気付けないので、ここで CI 常時カバーする。
    #[test]
    fn render_block_captures_post_processed_hw() {
        use crate::link_audio_ring::RingTapSink;

        let engine = Engine::new(48_000, 2); // schedule 空 → render は無音（0.0）。
        let mut link: Option<LinkEgress> = None;
        let mut master = MasterLine::new(48_000, Some(Box::new(FillPost(0.75))));
        master.ensure_buffer_len(8);
        let (sink, mut consumer, _drops) = RingTapSink::new(64);
        let mut capture: Option<RingTapSink> = Some(sink);
        let cb_stats: Option<Arc<CallbackTimeStats>> = None;

        let mut hw = vec![0.0f32; 8]; // 4 frames × 2ch。
        render_block(
            &engine,
            &mut link,
            &mut [],
            &mut master,
            &mut capture,
            &cb_stats,
            2,
            &mut hw,
        );

        // hw 自体も post 後（0.75）。
        assert!(hw.iter().all(|&s| s == 0.75), "hw must be post-processed");

        // capture ring に commit された値も post 後（0.75）であること。
        let avail = consumer.slots();
        assert_eq!(
            avail,
            hw.len(),
            "capture は 1 block 全サンプルを commit するはず"
        );
        let chunk = consumer.read_chunk(avail).expect("read committed");
        let (a, b) = chunk.as_slices();
        let captured: Vec<f32> = a.iter().chain(b.iter()).copied().collect();
        assert!(
            captured.iter().all(|&s| s == 0.75),
            "capture は post 適用後の hw を録るはず（0.0 なら post 前に tap している）: {captured:?}"
        );
    }

    // A4-2b-2b: egress 判定（ready かつ scratch 充足）の pure ロジックを CI で pin。render_block の
    // not-ready / scratch 不足の skip 分岐がこの判定に集約される（実 callback 経路は gated 層B）。
    #[test]
    fn channel_egress_active_requires_ready_and_sized_scratch() {
        // active: ready かつ scratch >= block。
        assert!(channel_egress_active(true, 512, 512));
        assert!(channel_egress_active(true, 1024, 512));
        // not-ready: consumer が Link 登録前 → egress しない（never-drained-ring 回避）。
        assert!(!channel_egress_active(false, 1024, 512));
        // scratch 不足: hardware bleed/無音を避けるため除外。
        assert!(!channel_egress_active(true, 256, 512));
        // not-ready かつ scratch 不足。
        assert!(!channel_egress_active(false, 0, 512));
    }

    // A4-2b-2b gating spike（advisor）: RT callback で N channel pool から render_multi 引数
    // `&mut [(&str, &mut [f32])]` を **heap alloc なし**（per-callback stack ArrayVec）で組めるか、
    // かつ call-body lifetime の `&mut` 借用を受けるかを確認する。これが通れば 2b-2b の N-channel
    // 配線が成立する（通らなければ別アプローチ）。
    #[test]
    fn arrayvec_n_channel_slice_builds_from_pool_without_heap() {
        use arrayvec::ArrayVec;
        const MAX_N: usize = 8;

        // pool を模す: (name, scratch) の Vec（実コードは LinkChannelActivate の Vec）。
        let mut pool: Vec<(String, Vec<f32>)> = vec![
            ("a".to_string(), vec![1.0; 4]),
            ("b".to_string(), vec![2.0; 4]),
        ];

        // render_multi 風の単一パス fn（core の render_multi が取る形）。
        fn fill_zero(chans: &mut [(&str, &mut [f32])]) {
            for (_, buf) in chans.iter_mut() {
                buf.fill(0.0);
            }
        }

        {
            // callback body: pool の各 entry から (name, &mut scratch) を stack ArrayVec へ。
            let mut chans: ArrayVec<(&str, &mut [f32]), MAX_N> = ArrayVec::new();
            for (name, scratch) in pool.iter_mut() {
                // overflow（pool > MAX_N）は実 render_block では debug_assert!(false) で panic（dev）/
                // 残り channel を silent skip（release）。RT callback では log しない（cap は control 強制）。
                if chans
                    .try_push((name.as_str(), scratch.as_mut_slice()))
                    .is_err()
                {
                    panic!("pool exceeds MAX_N");
                }
            }
            fill_zero(&mut chans);
            // chans はここで drop され pool への借用が解ける。
        }

        // 借用解除後に pool を読める = 単一パスで全 channel buffer を埋められた。
        assert!(pool.iter().all(|(_, s)| s.iter().all(|&x| x == 0.0)));
    }
}
