//! cpal の出力デバイス解決（#888 子 2・output.rs）。
//!
//! 🔴 **これは純粋な移動である。** `output.rs` からそのまま移した。
//! 本文は 1 行も書き換えていない。

#[allow(unused_imports)]
use super::*;

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
pub(super) fn resolve_output_device(
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

pub(super) fn output_config(
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

pub(super) fn validate_expected_sample_rate(
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

pub(super) fn confirm_callback_counter(
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

pub(super) fn probe_output_device(
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

pub(super) fn probe_candidate(
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
pub(super) const CAPTURE_RING_SECONDS: usize = 8;

/// 生きている間はストリームを保持する RAII ハンドル。
pub struct OutputStream {
    pub(super) _stream: Stream,
    /// capture seam（#307 realtime）: `ORBIT_CAPTURE_WAV` 有効時のみ `Some`。**`_stream` より後に
    /// 宣言する**ことで drop 順を「stream 停止（callback 停止＝以後 commit なし）→ writer が ring の
    /// 残りを drain して WAV を finalize」に固定する（Rust は struct field を宣言順に drop する）。
    pub(super) _capture: Option<crate::capture::CaptureWriter>,
    pub(super) render_state: Arc<std::sync::Mutex<RenderState>>,
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub device_requested: Option<String>,
    pub device_fallback: Option<DeviceFallback>,
    pub first_callback_ms: u64,
    pub(super) fault: OutputFault,
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
pub(super) fn ensure_audio_buffer_len(buffer: &mut Vec<f32>, len: usize) {
    if buffer.len() < len {
        buffer.resize(len, 0.0);
    }
}

/// One block's worth of a parameter ramp. `at(frame)` is the value for that frame.
///
/// 🔴 The block endpoint (`at(frames)`) is bit-identical to the former one-scalar-per-block
/// implementation. Only values within the block have changed.
#[derive(Clone, Copy)]
pub(super) struct LineRamp {
    pub(super) start: f32,
    /// Increment per frame. Zero when settled.
    pub(super) step: f32,
    /// Use `end` from this frame onward.
    pub(super) hold_after: usize,
    pub(super) end: f32,
}

impl LineRamp {
    #[inline]
    pub(super) fn settled(value: f32) -> Self {
        Self {
            start: value,
            step: 0.0,
            hold_after: 0,
            end: value,
        }
    }

    #[inline]
    pub(super) fn is_settled(self) -> bool {
        self.step == 0.0
    }

    #[inline]
    pub(super) fn at(self, frame: usize) -> f32 {
        if frame >= self.hold_after {
            self.end
        } else {
            self.start + self.step * frame as f32
        }
    }
}

/// Advance the shared master/generic-line state once and describe the values within that block.
/// `ramp_frames` is prepared from the sample rate before the callback starts.
#[inline]
pub(super) fn advance_line_ramp(
    current: &mut f32,
    target: f32,
    frames: usize,
    ramp_frames: u32,
) -> LineRamp {
    if *current == target {
        return LineRamp::settled(target);
    }

    let start = *current;
    let frac = (frames as f32 / ramp_frames as f32).min(1.0);
    // Keep this expression identical to the former block-scalar implementation. `LineRamp::at`
    // returns this stored value at the block endpoint instead of recomputing it via `step`.
    *current += (target - *current) * frac;
    LineRamp {
        start,
        step: (target - start) / ramp_frames as f32,
        hold_after: frames.min(ramp_frames as usize),
        end: *current,
    }
}
