//! cpal を使った既定出力デバイスへのストリーム設定。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod bus_topology;
mod device;
mod dsp;
mod line_program;
mod lines;
mod render;
mod render_full;
mod startup;
pub use bus_topology::LinkChannelActivate;
#[allow(unused_imports)]
use bus_topology::*;
#[allow(unused_imports)]
use device::*;
#[allow(unused_imports)]
use dsp::*;
pub use line_program::InsertBusStage;
#[allow(unused_imports)]
use line_program::*;
#[allow(unused_imports)]
use lines::*;
#[allow(unused_imports)]
use render::*;
#[allow(unused_imports)]
use render_full::*;
#[allow(unused_imports)]
use startup::*;
pub use startup::*;
// 🔴 クレート内外から名前で import されているので親から再エクスポートする。
pub use device::{select_live_output_device, OutputStream, ENGINE_CHANNELS};
pub use lines::{
    decode_bus_routing_sentinel, default_bus_line_ops, default_master_line_ops, legacy_line_ops,
    BlockSource, BlockTransport, BusSend, BusTarget, LegacyLineInstaller, LineOp, LineOutput,
    LineProgram, LineProgramInstaller, OutputDest, RenderState, SourceDest, SourceDestCell,
    SourceSlot, MAX_INSERT_BUS_STAGES, MAX_LINK_CHANNELS, MAX_SOURCE_SLOTS, MAX_SOURCE_UNITS,
};

// 🔴 クレート内外から名前で import されているので親から再エクスポートする。

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
