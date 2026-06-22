//! cpal を使った既定出力デバイスへのストリーム設定。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use thiserror::Error;

use orbit_audio_core::Engine;

use crate::link_audio_ring::{PostMixSink, RingTapSink};

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
}

impl StreamStats {
    pub fn snapshot(&self) -> StreamStatsSnapshot {
        StreamStatsSnapshot {
            xruns: self.xruns.load(Ordering::Relaxed),
            buffer_underruns: self.buffer_underruns.load(Ordering::Relaxed),
            device_lost: self.device_lost.load(Ordering::Relaxed),
        }
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
}

#[derive(Debug, Clone, Copy)]
pub struct StreamStatsSnapshot {
    pub xruns: u64,
    pub buffer_underruns: u64,
    pub device_lost: bool,
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
}

/// 生きている間はストリームを保持する RAII ハンドル。
pub struct OutputStream {
    _stream: Stream,
    pub sample_rate: u32,
    pub channels: u16,
}

/// LinkAudio channel を RT callback に届けるための activation メッセージ（A4-2b-2）。
/// control thread が ring 生成・scratch 事前確保まで行い、本構造体を reg-ring 経由で callback へ
/// 渡す（callback は受け取って格納するだけ＝RT alloc を避ける）。`sink` は対になる
/// `rtrb::Consumer<f32>` を GPL consumer thread が drain する producer 側。
pub struct LinkChannelActivate {
    pub name: String,
    pub sink: RingTapSink,
    /// per-block scratch。control が `max_block_frames * channels` で事前確保する。
    pub scratch: Vec<f32>,
}

/// cpal callback が保持する LinkAudio egress 状態（2b-2a は **単一 channel**）。
/// pool + N-channel + readiness race は 2b-2b。
struct LinkEgress {
    reg_rx: rtrb::Consumer<LinkChannelActivate>,
    channel: Option<LinkChannelActivate>,
}

/// 1 callback 分の render。`link` が無い（hardware-only）なら従来通り `engine.render`（ビット同一）。
/// `link` 有りなら reg-ring を drain して channel を activate し、`render_multi` で hardware と
/// channel buffer を 1 パスで埋め、channel buffer を ring へ push する（egress）。
#[inline]
fn render_block(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    output_channels: usize,
    hw: &mut [f32],
) {
    if let Some(le) = link {
        // reg-ring を drain（2b-2a は last-wins で単一 channel を activate）。RT で alloc しない
        // （scratch は control が事前確保済み）。
        // 🔴 RT-safety: `le.channel` が既に `Some(old)` だと `old`（String+Vec+Arc）の heap 解放が
        // RT スレッド上で起きる。これを防ぐのは `LinkAudioControl::register_channel` の冪等 guard
        // で、同名再登録時に `reg_tx.push` を抑止するため、ここでは `None → Some` の遷移しか起きない。
        // 2b-2b で reg-ring を pool 化し複数 push を許す際は、この drop が RT で発生しうるので要再設計。
        while let Ok(act) = le.reg_rx.pop() {
            le.channel = Some(act);
        }
        if let Some(ch) = &mut le.channel {
            let bs = (hw.len() / output_channels) * output_channels;
            // scratch は control が `MAX_BLOCK_FRAMES * channels`（device buffer より遥かに大）で
            // 事前確保する不変。これが破れると channel-tagged event が下の hardware fallback に
            // 漏れる（無音ではなく hardware へ bleed する）ので dev では loud に検出する。
            debug_assert!(
                ch.scratch.len() >= bs,
                "link channel scratch ({}) < block ({bs}); channel audio would bleed to hardware",
                ch.scratch.len()
            );
            if ch.scratch.len() >= bs {
                // 1-element stack array（heap alloc なし）。render_multi が hw と ch.scratch を
                // 1 パスで埋め transport を 1 回進める。借用は次行までに終わる。
                let mut chans = [(ch.name.as_str(), &mut ch.scratch[..bs])];
                engine.render_multi(hw, &mut chans);
                // channel buffer を ring へ push（満杯なら RingTapSink が drop カウント）。
                ch.sink.commit(&ch.scratch[..bs]);
                return;
            }
            // scratch 不足（想定外）→ release では安全側で hardware のみにフォールバック。
        }
    }
    engine.render(hw);
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

/// 既定の出力デバイスを使い、デバイス config に合う [`Engine`] とストリームを
/// 同時に初期化する（hardware-only）。呼び出し側は config ミスマッチを意識しなくてよい。
pub fn start_default_output() -> Result<OutputStart, OutputError> {
    start_output_inner(None)
}

/// LinkAudio egress 経路付きで出力を起動する（A4-2b-2・feature `link-audio` 経由でのみ daemon が
/// 使う）。戻り値の `Producer<LinkChannelActivate>` に control thread が channel を push すると、
/// RT callback が render_multi で channel buffer を埋めて ring へ送る。
pub fn start_default_output_with_link_egress(
    reg_capacity: usize,
) -> Result<LinkEgressStart, OutputError> {
    let (reg_tx, reg_rx) = rtrb::RingBuffer::new(reg_capacity);
    let link = LinkEgress {
        reg_rx,
        channel: None,
    };
    let (engine, stream, stats) = start_output_inner(Some(link))?;
    Ok((engine, stream, stats, reg_tx))
}

/// `start_default_output` / `start_default_output_with_link_egress` の共通実装。
/// `link` を渡すと cpal callback に egress 経路を組み込む（None なら hardware-only でビット同一）。
fn start_output_inner(link: Option<LinkEgress>) -> Result<OutputStart, OutputError> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or(OutputError::NoDevice)?;
    let supported = device
        .default_output_config()
        .map_err(|e| OutputError::NoConfig(e.to_string()))?;

    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.config();
    let sample_rate = config.sample_rate.0;
    let channels = config.channels;

    let stats = Arc::new(StreamStats::default());
    let engine = Engine::new(sample_rate, channels);
    let stream = build_stream(
        &device,
        &config,
        sample_format,
        engine.clone(),
        stats.clone(),
        link,
    )?;
    stream
        .play()
        .map_err(|e| OutputError::PlayStream(e.to_string()))?;

    Ok((
        engine,
        OutputStream {
            _stream: stream,
            sample_rate,
            channels,
        },
        stats,
    ))
}

fn build_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    engine: Engine,
    stats: Arc<StreamStats>,
    mut link: Option<LinkEgress>,
) -> Result<Stream, OutputError> {
    let make_err_fn = || {
        // 上位 (daemon session) が StreamStats / DaemonError 経由で可視化する責務を持つ。
        let stats = stats.clone();
        move |err: cpal::StreamError| stats.record_error(&err)
    };

    /// scratch バッファを事前に 1 秒分確保してクロージャにムーブするヘルパー。
    /// cpal のコールバック buffer_size は通常数百フレームなので十分余裕がある。
    /// リアルタイムコールバック初回でのヒープ確保を回避する。
    fn scratch_with_capacity(config: &StreamConfig) -> Vec<f32> {
        vec![0.0; (config.sample_rate.0 as usize) * (config.channels as usize)]
    }

    let out_ch = config.channels as usize;

    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| render_block(&engine, &mut link, out_ch, data),
                make_err_fn(),
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
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        render_block(&engine, &mut link, out_ch, buf);
                        for (i, s) in buf.iter().enumerate() {
                            data[i] = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        }
                    },
                    make_err_fn(),
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
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        render_block(&engine, &mut link, out_ch, buf);
                        for (i, s) in buf.iter().enumerate() {
                            data[i] = (s.clamp(-1.0, 1.0) * i32::MAX as f32) as i32;
                        }
                    },
                    make_err_fn(),
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
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        render_block(&engine, &mut link, out_ch, buf);
                        for (i, s) in buf.iter().enumerate() {
                            let v = (s.clamp(-1.0, 1.0) * 0.5 + 0.5) * u16::MAX as f32;
                            data[i] = v as u16;
                        }
                    },
                    make_err_fn(),
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
mod tests {
    use super::*;
    use cpal::BackendSpecificError;

    #[test]
    fn stream_stats_starts_at_zero() {
        let stats = StreamStats::default();
        let snap = stats.snapshot();
        assert_eq!(snap.xruns, 0);
        assert_eq!(snap.buffer_underruns, 0);
        assert!(!snap.device_lost);
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
        match start_default_output() {
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
            start_default_output().expect("start_default_output should open");
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
}
