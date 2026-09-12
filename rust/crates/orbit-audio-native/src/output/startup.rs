//! 出力ストリームの起動（#888 子 2・output.rs）。
//!
//! 🔴 **これは純粋な移動である。** `start_default_output*` 系と `rebuild_output_stream` を
//! そのまま移した。feature の組み合わせごとに入口が分かれているのは移動の対象であって
//! 統合の対象ではない（4.0.1 は**振る舞い不変**）。

#[allow(unused_imports)]
use super::*;

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
    let mut master = MasterLine::new(sample_rate, channels, post);
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
        let cell = SourceDestCell::default();
        assert_eq!(cell.load(), SourceDest::None);

        for dest in [
            SourceDest::None,
            SourceDest::Master,
            SourceDest::Bus(0),
            SourceDest::Bus(MAX_INSERT_BUS_STAGES - 1),
            SourceDest::Link(0),
            SourceDest::Link(MAX_LINK_CHANNELS - 1),
        ] {
            cell.store(dest);
            assert_eq!(cell.load(), dest);
        }

        cell.store(SourceDest::Bus(MAX_INSERT_BUS_STAGES));
        assert_eq!(cell.load(), SourceDest::None);
        cell.store(SourceDest::Link(MAX_LINK_CHANNELS));
        assert_eq!(cell.load(), SourceDest::None);

        let invalid = SourceDestCell(Arc::new(AtomicUsize::new(usize::MAX)));
        assert_eq!(invalid.load(), SourceDest::None);
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

    #[test]
    fn none_source_is_rendered_but_does_not_publish_a_feed() {
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut sources = [transport_recording_source(log.clone(), 1)];
        sources[0].dests[0].store(SourceDest::None);
        let transport = BlockTransport {
            cursor_frames: 0,
            sample_rate: 48_000,
        };

        let rendered = render_sources(&mut sources, 4, &transport);
        let feeds = collect_source_feeds(&sources, &rendered, &[], 8);

        assert_eq!(
            *log.lock().unwrap(),
            vec![0],
            "silent sources still advance"
        );
        assert!(feeds.is_empty());
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
    fn unregistered_source_bus_is_silent_for_the_whole_block() {
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

        assert!(actual.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn unwired_link_source_is_silent_for_the_whole_block() {
        let source_output = vec![0.25, -0.5, 0.75, -1.0];
        let mut sources = vec![fixed_source(source_output.clone(), SourceDest::Link(0))];
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

        assert!(actual.iter().all(|sample| *sample == 0.0));
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
        let mut buses = vec![InsertBusStage::new("instrument", Some(Box::new(Half)), 4)
            .with_line(LineProgram::legacy(BusTarget::Master, &[]))];
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

    fn with_explicit_master(stage: InsertBusStage) -> InsertBusStage {
        stage.with_line(LineProgram::legacy(BusTarget::Master, &[]))
    }

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
        let mut master = MasterLine::new(48_000, 2, None);
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
        let mut master = MasterLine::new(48_000, 2, None);
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
        let mut master = MasterLine::new(48_000, 2, None);
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
        let mut buses = vec![with_explicit_master(InsertBusStage::with_activation(
            "fx",
            Some(Box::new(Half)),
            4,
            active.clone(),
        ))];
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
        let mut buses = vec![with_explicit_master(InsertBusStage::new(
            "fx",
            Some(Box::new(Half)),
            4,
        ))];
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
    fn tagged_event_with_unattached_bus_is_consumed_without_reaching_hardware() {
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
        assert!(hw.iter().all(|&sample| sample == 0.0));
        assert_eq!(engine.active_count(), Some(0));
    }

    // #459/#453 M1: mixer graph (sum/aux) 拡張の必須テスト群。既存の per-seq insert のみの構成
    // （明示 output_target=Master・sends 空）は #883 後もテスト fixture に明記し、
    // mixer graph 自体の挙動を既定ラインの無音化から分離して回帰確認する。

    #[test]
    fn sum_bus_chains_member_output_before_master() {
        // stage0 "kick"（processor None・output_target=Bus(1) = drum sum へ）
        // stage1 "drum"（sum・0.5×gain processor・output_target 明示 Master）
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
            with_explicit_master(InsertBusStage::new("kick", None, 4))
                .with_output_target(BusTarget::Bus(1)),
            with_explicit_master(InsertBusStage::new("drum", Some(Box::new(Half)), 4)),
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
            with_explicit_master(InsertBusStage::new("a", Some(Box::new(Half)), 4)).with_sends(
                vec![BusSend {
                    target: 1,
                    gain: 0.5,
                }],
            ),
            with_explicit_master(InsertBusStage::unattached("aux")),
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
    fn line_ramp_endpoint_is_bit_identical_to_the_former_block_formula() {
        fn former_endpoint(start: f32, target: f32, frames: usize, ramp_frames: u32) -> f32 {
            let mut current = start;
            let frac = (frames as f32 / ramp_frames as f32).min(1.0);
            current += (target - current) * frac;
            current
        }

        for frames in [64, 512] {
            let start = 0.013_f32;
            let target = 0.987_f32;
            let expected = former_endpoint(start, target, frames, 240);
            let mut current = start;
            let ramp = advance_line_ramp(&mut current, target, frames, 240);
            assert_eq!(ramp.at(frames), expected, "frames={frames}");
            assert_eq!(current, expected, "stored endpoint for frames={frames}");
        }
    }

    #[test]
    fn line_ramp_interpolates_monotonically_within_a_short_block() {
        let start = 0.01_f32;
        let target = 1.0_f32;
        let mut current = start;
        let ramp = advance_line_ramp(&mut current, target, 64, 240);

        assert_eq!(ramp.at(0), start);
        assert!(ramp.at(32) > start && ramp.at(32) < ramp.end);
        assert!(ramp.at(63) > ramp.at(32) && ramp.at(63) < ramp.end);
    }

    #[test]
    fn line_ramp_holds_the_endpoint_after_the_ramp_duration() {
        let mut current = 0.01_f32;
        let ramp = advance_line_ramp(&mut current, 1.0, 512, 240);

        assert_eq!(ramp.at(240), ramp.end);
        assert_eq!(ramp.at(340), ramp.end);
    }

    #[test]
    fn settled_line_ramp_keeps_the_target_for_every_frame() {
        let target = 0.375_f32;
        let mut current = target;
        let ramp = advance_line_ramp(&mut current, target, 64, 240);

        assert!(ramp.is_settled());
        assert_eq!(ramp.at(0), target);
        assert_eq!(ramp.at(32), target);
        assert_eq!(ramp.at(10_000), target);
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
        // 🔴 **ビット一致**で見る（`/code:pr-review-team` の test-analyzer・2026-09-11）。
        // 旧版は許容差 `1e-6` で、`apply_line_pan` の中央早期リターンを消しても
        // `sqrt(2) * cos(pi/4) = 0.99999994` の **6e-8** のずれが埋もれて**そのまま通った**。
        // 「center は unity」という設計 §4.1 の主張は近似ではないので、近似で検査しない。
        assert_eq!(
            centered, baseline,
            "center Pan must be bit-identical to a line with no Pan (design §4.1: center is unity)"
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
        // `as_chunks::<2>()` rather than `chunks_exact(2)`: clippy 1.98 rejects the latter for a
        // constant size (`chunks_exact_to_as_chunks`), and CI tracks stable while this machine
        // may be a release behind.
        for frame in hard_left.as_chunks::<2>().0 {
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
        let ramp = line_ramp(&program, 0, 1.0, frames, 240);
        let centered = 0.5_f32.sqrt();
        let mut next_block = vec![centered; frames * 2];
        apply_line_pan(&mut next_block, frames, ramp);

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
            "pan ramp seed=-1 target=1 end_pan={} boundary_delta={boundary_delta} in_block_max_delta={in_block_delta}",
            ramp.end
        );
        assert!((ramp.end - (-0.6)).abs() <= 1e-6);
        assert!(
            boundary_delta <= 1e-6,
            "the first frame must retain the previous pan"
        );
        assert!(
            in_block_delta > 0.0 && in_block_delta < 0.02,
            "pan coefficients must move gradually within the block"
        );
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
    fn line_gain_moves_toward_target_within_the_block() {
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
        assert!(
            (hw[0] - raw).abs() < 1e-6,
            "the first frame must use the starting gain: {hw:?}"
        );
        assert!(hw[48] < hw[0], "gain must change within the block: {hw:?}");
        assert!(
            hw[94] < hw[48],
            "later frames must be closer to the target: {hw:?}"
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
            let settled = line_ramp(program, 0, 0.1, 240, 240);
            assert!((settled.end - 0.1).abs() <= 1e-6);
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
            seeded = line_ramp(program, 0, 1.0, 24, 240).end;
        });

        let unseeded_program = LineProgram::new(vec![new_op]);
        let unseeded = line_ramp(&unseeded_program, 0, 1.0, 24, 240).end;
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
            with_explicit_master(InsertBusStage::new("source", None, 8))
                .with_output_target(BusTarget::Bus(1))
                .with_sends(vec![BusSend {
                    target: 2,
                    gain: 0.375,
                }])
        };
        let mut buses = vec![
            source,
            with_explicit_master(InsertBusStage::new("sum", Some(Box::new(Half)), 8)),
            with_explicit_master(InsertBusStage::unattached("aux")),
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
            let legacy_source = with_explicit_master(InsertBusStage::new("source", None, 8))
                .with_routing_overrides(legacy_output.clone(), legacy_sends.clone());
            let program_source = with_explicit_master(InsertBusStage::new("source", None, 8));
            let install_line = program_source.legacy_line_installer();

            Self {
                legacy_engine: Engine::new(48_000, 2),
                program_engine: Engine::new(48_000, 2),
                legacy_buses: vec![
                    legacy_source,
                    with_explicit_master(InsertBusStage::new("sum", Some(Box::new(Half)), 8)),
                    with_explicit_master(InsertBusStage::new("aux-a", None, 8)),
                    with_explicit_master(InsertBusStage::new("aux-b", None, 8)),
                ],
                program_buses: vec![
                    program_source,
                    with_explicit_master(InsertBusStage::new("sum", Some(Box::new(Half)), 8)),
                    with_explicit_master(InsertBusStage::new("aux-a", None, 8)),
                    with_explicit_master(InsertBusStage::new("aux-b", None, 8)),
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
            with_explicit_master(InsertBusStage::new("a", None, 4)).with_routing_overrides(
                routing_override.clone(),
                vec![Arc::new(AtomicU32::new(0))],
            ),
            with_explicit_master(InsertBusStage::new("drum", Some(Box::new(Half)), 4)),
        ];
        let mut hw = vec![0.0; 4];
        let mut link = None;

        // override 前: 明示 static Master へ直接加算される（drum の 0.5×gain を経ない）。
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
            with_explicit_master(InsertBusStage::new("a", None, 4))
                .with_routing_overrides(Arc::new(AtomicUsize::new(0)), vec![send_slot.clone()]),
            with_explicit_master(InsertBusStage::unattached("aux")),
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
        let self_ref = vec![with_explicit_master(InsertBusStage::new("a", None, 4))
            .with_output_target(BusTarget::Bus(0))];
        assert!(validate_bus_topology(&self_ref).is_err());

        let backward_ref = vec![
            with_explicit_master(InsertBusStage::new("a", None, 4))
                .with_output_target(BusTarget::Bus(0)),
            InsertBusStage::new("b", None, 4),
        ];
        assert!(validate_bus_topology(&backward_ref).is_err());

        let bad_send = vec![
            with_explicit_master(InsertBusStage::new("a", None, 4)).with_sends(vec![BusSend {
                target: 0,
                gain: 0.5,
            }]),
        ];
        assert!(validate_bus_topology(&bad_send).is_err());

        let ok = vec![
            with_explicit_master(InsertBusStage::new("a", None, 4))
                .with_output_target(BusTarget::Bus(1)),
            InsertBusStage::new("b", None, 4),
        ];
        assert!(validate_bus_topology(&ok).is_ok());
    }

    #[test]
    fn inactive_sum_target_still_receives_member_output() {
        // stage0 "kick"（active・processor None・output_target=Bus(1)）
        // stage1 "drum"（inactive = 未 declare・processor None・output_target 明示 Master）でも、
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
            with_explicit_master(InsertBusStage::new("kick", None, 4))
                .with_output_target(BusTarget::Bus(1)),
            with_explicit_master(InsertBusStage::with_activation(
                "drum",
                None,
                4,
                Arc::new(AtomicBool::new(false)),
            )),
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
        let mut master = MasterLine::new(48_000, 2, None);
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
        let mut master = MasterLine::new(48_000, 2, Some(Box::new(FillPost(0.75))));
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
        let mut master = MasterLine::new(48_000, 2, Some(Box::new(FillPost(0.75))));
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

        assert_eq!(hw[0], 0.75, "the ramp must start after the rack output");
        assert!(
            (hw[240 * 2] - 0.375).abs() < 1e-6
                && hw[240 * 2..]
                    .iter()
                    .all(|sample| (*sample - 0.375).abs() < 1e-6),
            "rack -> ramped gain -> device must execute in wire order: {hw:?}"
        );
    }

    /// #611 束 A 監査（Fable Important #1）: `execute_master_line` は `LineOp::Pan` の match
    /// アームを master（本テスト・`output.rs` 約 1883-1886）と bus post-loop（約 2351-2370）の
    /// 2 箇所に持つ別々のコードパスで、既存の `line_program_pan_is_normalized_and_executes_in_rt`
    /// は `render_tagged_line` 経由で bus 経路しか通っていなかった。master 側の Pan アームを
    /// `LineOp::Pan(_) => {}` に戻しても、この既存テストだけでは検出できない穴を、master line を
    /// 実際に走らせて数値で塞ぐ。
    #[test]
    fn master_line_pan_op_positions_the_master_buffer() {
        let frames = 2;
        let mut master = MasterLine::new(48_000, 2, None);
        master.ensure_buffer_len(frames * ENGINE_CHANNELS);
        for sample in &mut master.buffer[..frames * ENGINE_CHANNELS] {
            *sample = 1.0;
        }
        master
            .line_program_installer()
            .install_for_bus(
                LineProgram::settled(vec![
                    LineOp::Pan(-1.0),
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
            .expect("valid master pan program installs");

        let mut hw = vec![0.0f32; frames * 2];
        execute_master_line(&mut master, frames, 2, &mut hw);

        // apply_line_pan(pan=-1.0) の実測ゲインは (√2, 0)。buffer をすべて 1.0 に揃えているので
        // hw の値はそのままこのゲインになる（`LineOp::Pan(_) => {}` に戻すと hw は 1.0 のまま
        // なので、この差で退行を検出できる）。
        let hard_left = std::f32::consts::SQRT_2;
        for frame in hw.as_chunks::<2>().0 {
            assert!(
                (frame[0] - hard_left).abs() <= 1e-6,
                "hard-left L={}",
                frame[0]
            );
            assert!(frame[1].abs() <= 1e-6, "hard-left R={}", frame[1]);
        }
    }

    /// 🔴 **shadow と実体が同じ 1 関数から出ていること**を固定する
    /// （`/code:pr-review-team` silent-failure-hunter の Critical・2026-09-11）。
    ///
    /// 以前は `MasterLine::new` が `right: Some(1)` を固定し、daemon の shadow は
    /// `(channels > 1).then_some(1)` を返していた。**2ch では偶然一致するので開発機では
    /// 顕在化せず**、1ch デバイスでだけ seed の Output 照合が外れて 0.0 から鳴り直していた。
    /// チャンネル数ごとに、構築した `MasterLine` の live program が
    /// `default_master_line_ops` と一致することを見る。
    #[test]
    fn master_line_starts_from_the_shared_default_ops_for_any_channel_count() {
        for channels in [1u16, 2, 4] {
            let master = MasterLine::new(48_000, channels, None);
            let live = unsafe { &*master.line.exchange.live.load(Ordering::Acquire) };
            assert_eq!(
                live.ops.as_ref(),
                default_master_line_ops(channels).as_slice(),
                "master line must start from default_master_line_ops({channels}) — the daemon \
                 shadow seeds from exactly this"
            );
        }
        // 1ch では right を持たない（`add_to_device` の境界検査は debug_assert だけなので、
        // `Some(1)` のままだと実 1ch デバイスで RT が範囲外アクセスする）。
        let mono = default_master_line_ops(1);
        assert!(matches!(
            mono.last(),
            Some(LineOp::Output(LineOutput {
                dest: OutputDest::Device { right: None, .. },
                ..
            }))
        ));
    }

    /// `advance_gain` は block が ramp より長ければ 1 回で目標へ到達し、短ければ寄っていく。
    #[test]
    fn advance_gain_saturates_at_the_target_for_blocks_longer_than_the_ramp() {
        let mut master = MasterLine::new(48_000, 2, None);
        master
            .gain_target_handle()
            .store(0.25_f32.to_bits(), Ordering::Relaxed);
        // ramp_frames は 48_000 の 5 ms = 240。512 frame block は frac = 1.0 で即時到達。
        assert!((master.advance_gain(512).end - 0.25).abs() < 1e-6);

        let mut slow = MasterLine::new(48_000, 2, None);
        slow.gain_target_handle()
            .store(0.0_f32.to_bits(), Ordering::Relaxed);
        // 64 frame block は frac = 64/240 なので 1 回では到達しない（が単調に近づく）。
        let first = slow.advance_gain(64).end;
        assert!(first < 1.0 && first > 0.0, "{first}");
        let second = slow.advance_gain(64).end;
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
        let mut master = MasterLine::new(48_000, 2, Some(Box::new(FillPost(0.75))));
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
