//! `EngineWrap` のオーディオデバイス切替と Link テンポ（#888 子 1・第 6 束）。
//!
//! ストリーム/デバイスのライフサイクル型（`StreamGuard` / `StreamConfigSnapshot` /
//! `DeviceSwitchRequest`）と capture パス解決も**このモジュールの主題**なので、
//! レビュー（altitude）を受けて `role.rs` から移してある（ファイル後半）。
//!
//! 🔴 **2 行を除いて純粋な移動である。** `engine_wrap.rs` の `impl EngineWrap` から
//! そのまま移した。変更したのは `record_stream_config` と `record_device_switch_result` の
//! 可視性（`fn` → `pub(super) fn`）だけで、どちらも `engine_wrap.rs` に残る側
//! （`finish_start` とインラインテスト）から呼ばれている。
//! **親は子の private メソッドを呼べない**（設計 §5 の **E3′**）。
//!
//! 親の子モジュールなので `EngineWrap` の private フィールドに到達できる。

use super::*;

impl EngineWrap {
    /// device switch（#484 D2）: 各 `start*()` variant 共通の後処理。`buffer_frames`/`cb_stats` を
    /// `self` に保存する（`apply_device_switch` が switch 時に同じ値を再利用し、バッファサイズ設定・
    /// callback-duration 計測の連続性を保つ）。`StreamGuard` 自体の所有権はこれまでどおり呼び出し側
    /// （`main.rs` の audio owner thread ローカル変数）が持つ — ここでは触らない。
    pub(super) fn record_stream_config(
        &self,
        stream_config: StreamConfigSnapshot,
        buffer_frames: Option<u32>,
        cb_stats: Option<Arc<orbit_audio_native::CallbackTimeStats>>,
    ) {
        match self.stream_config.lock() {
            Ok(mut slot) => *slot = stream_config,
            Err(poisoned) => {
                tracing::warn!(
                    "stream config mutex poisoned; replacing the stored stream configuration"
                );
                *poisoned.into_inner() = stream_config;
            }
        }
        if let Ok(mut slot) = self.output_buffer_frames.lock() {
            *slot = buffer_frames;
        }
        if let Ok(mut slot) = self.output_cb_stats.lock() {
            *slot = cb_stats;
        }
    }

    /// Record both arms of a live device-switch attempt through one path. A failed attempt keeps
    /// the effective stream fields intact and only attaches its reason for `GetStatus`.
    pub(super) fn record_device_switch_result(
        &self,
        requested_device: Option<&str>,
        result: &Result<(String, StreamConfigSnapshot), WrapError>,
        buffer_frames: Option<u32>,
        cb_stats: Option<Arc<orbit_audio_native::CallbackTimeStats>>,
    ) {
        let requested_device = requested_device.unwrap_or("<system default output>");
        match result {
            Ok((selected_device, stream_config)) => {
                tracing::info!(
                    "audio output device switch to {:?} succeeded: using {:?}",
                    requested_device,
                    selected_device
                );
                self.record_stream_config(stream_config.clone(), buffer_frames, cb_stats);
            }
            Err(error) => {
                // 🔴 切替では何も init していないので、`WrapError::Output` の Display が付ける
                // 「audio output init failed: 」は嘘になる（この文字列は ERROR ログ・
                // `last_switch_failure`・MCP の返り値・エディタの警告すべてに載る）。
                // 内側の `OutputError` の Display を使う。
                let reason = match error {
                    WrapError::Output(output) => output.to_string(),
                    other => other.to_string(),
                };
                tracing::error!(
                    "audio output device switch to {:?} failed: {}",
                    requested_device,
                    reason
                );
                match self.stream_config.lock() {
                    Ok(mut snapshot) => snapshot.last_switch_failure = Some(reason),
                    Err(poisoned) => {
                        tracing::warn!(
                            "stream config mutex poisoned; recording the device switch failure"
                        );
                        poisoned.into_inner().last_switch_failure = Some(reason);
                    }
                }
            }
        }
    }

    fn reject_device_switch(
        &self,
        requested_device: Option<&str>,
        error: WrapError,
    ) -> Result<String, WrapError> {
        let result: Result<(String, StreamConfigSnapshot), WrapError> = Err(error);
        self.record_device_switch_result(requested_device, &result, None, None);
        result.map(|(selected_name, _)| selected_name)
    }

    #[cfg(test)]
    pub(crate) fn record_device_switch_failure_for_test(
        &self,
        requested_device: &str,
        reason: &str,
    ) {
        let result = Err(WrapError::AudioDeviceSwitchUnavailable(reason.to_string()));
        self.record_device_switch_result(Some(requested_device), &result, None, None);
    }

    /// device switch（#484 D2）: `main.rs` の audio owner thread が `EngineWrap::start()` 直後に
    /// 一度だけ呼ぶ。以後、[`Self::select_audio_device`] からの要求はこのチャンネル経由で
    /// owner thread（`tx` の受け手側 `rx` を loop で回すコード）に届く。
    pub fn install_device_switch_channel(&self, tx: std::sync::mpsc::Sender<DeviceSwitchRequest>) {
        if let Ok(mut slot) = self.device_switch_tx.lock() {
            *slot = Some(tx);
        }
    }

    /// device switch（#484 D2）: 制御スレッド（RPC handler・`spawn_blocking` 経由）から呼ぶ公開 API。
    /// 実際の cpal I/O は行わず、audio owner thread へ要求を送って応答を待つだけ（`cpal::Stream` は
    /// `!Send` のため `EngineWrap` 自身は一切触れない）。
    ///
    /// - `device`: `None`/空文字列 = システム既定へ縮退（`resolve_output_device` と同じ規約）。
    /// - capture（`ORBIT_CAPTURE_WAV`）が有効な場合は明示的に拒否する（継続不可・#484 D2 ブリーフの
    ///   選択(a)）: capture writer は switch 前の stream 専用に生成されており、新 stream に持ち越すと
    ///   ring producer が古い stream の drop と一緒に失われるため、無音で録音が壊れるより先に fail する。
    /// - **ブロッキング呼び出し**: 呼び出し側は `spawn_blocking`（session.rs の他の cpal I/O ハンドラと
    ///   同じ隔離）から呼ぶこと。RT callback 内からは絶対に呼ばない。
    pub fn select_audio_device(&self, device: Option<String>) -> Result<String, WrapError> {
        let requested = device.clone();
        // 🔴 owner thread に**届く前**の失敗はすべて `dispatch_device_switch` が `Err` で返し、
        // 記録はここ 1 箇所で行う。以前は失敗経路ごとに `reject_device_switch` を書いていて、
        // 5 つ目の経路を足す人が記録を落としても型で気づけなかった。
        let reply_rx = match self.dispatch_device_switch(device) {
            Ok(reply_rx) => reply_rx,
            Err(error) => return self.reject_device_switch(requested.as_deref(), error),
        };
        match reply_rx.recv() {
            // owner thread の `apply_device_switch` が成否とも記録済み。**二重に記録しない。**
            Ok(result) => result,
            Err(_) => self.reject_device_switch(
                requested.as_deref(),
                WrapError::AudioDeviceSwitchUnavailable(
                    "audio owner thread dropped the reply channel".into(),
                ),
            ),
        }
    }

    /// 切替要求を audio owner thread へ渡すところまで。
    ///
    /// ここが返す `Err` は **まだ `record_device_switch_result` を通っていない**（要求が owner
    /// thread に届いていないので、記録は呼び出し側の責任）。逆に、返した receiver から届く
    /// `Result` は owner thread 側で記録済みである。
    fn dispatch_device_switch(
        &self,
        device: Option<String>,
    ) -> Result<std::sync::mpsc::Receiver<Result<String, WrapError>>, WrapError> {
        if capture_path_from_env().is_some() {
            return Err(WrapError::AudioDeviceSwitchUnavailable(
                "ORBIT_CAPTURE_WAV is active; runtime device switch is unsupported while \
                 capture is recording (restart the daemon to change device with capture on)"
                    .into(),
            ));
        }
        let tx = self
            .device_switch_tx
            .lock()
            .map_err(|_| {
                WrapError::AudioDeviceSwitchUnavailable("device switch channel poisoned".into())
            })?
            .clone()
            .ok_or_else(|| {
                WrapError::AudioDeviceSwitchUnavailable(
                    "no audio owner thread registered (test backend or daemon shutting down)"
                        .into(),
                )
            })?;
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        tx.send(DeviceSwitchRequest {
            device,
            reply: reply_tx,
        })
        .map_err(|_| {
            WrapError::AudioDeviceSwitchUnavailable("audio owner thread has exited".into())
        })?;
        Ok(reply_rx)
    }

    /// device switch（#484 D2）: 実際の cpal I/O。**audio owner thread 上でのみ呼ぶこと**
    /// （`cpal::Stream` の `!Send` 制約を型システムではなく運用で守る seam — `&mut StreamGuard` を
    /// 要求することで、呼び出し側が `StreamGuard` を所有するその thread からしか呼べないよう
    /// 誘導する）。`Engine`（scheduler 状態）・OOP effect/instrument child・plugin routing は
    /// 一切触らない（`orbit_audio_native::RenderState` を新 stream に丸ごと引き継ぐ）。
    pub fn apply_device_switch(
        &self,
        guard: &mut StreamGuard,
        device: Option<String>,
    ) -> Result<String, WrapError> {
        let render_state = guard.stream.render_state();
        let buffer_frames = self.output_buffer_frames.lock().ok().and_then(|g| *g);
        let cb_stats = self.output_cb_stats.lock().ok().and_then(|g| g.clone());
        let current = self.stream_config_snapshot();

        let switch_result = (|| {
            // Probe is a standalone zero-fill stream with a private callback counter, so the old
            // render stream stays live for the full (up to 3 s) preflight. Only a probe success is
            // allowed to pause the old stream before build -> play -> callback confirmation.
            let live = probe_then_pause_old(
                || {
                    orbit_audio_native::select_live_output_device(
                        OutputDeviceRequest {
                            name: device.clone(),
                            fault: current.output_fault,
                        },
                        buffer_frames,
                        Some(current.sample_rate),
                        // ライブ切替は縮退しない（owner 裁定 2026-09-05・設計 §3）。
                        orbit_audio_native::DeviceFallbackPolicy::RejectAndKeepCurrent,
                    )
                },
                || guard.stream.pause(),
            )?;
            let rebuilt = orbit_audio_native::rebuild_output_stream(
                live,
                render_state,
                self.engine.clone(),
                self.stream_stats.clone(),
                cb_stats.clone(),
            );
            let new_stream = match rebuilt {
                Ok(stream) => stream,
                Err(primary) => {
                    // A failed replacement is paused before its OutputStream is dropped. Resume
                    // the untouched old stream, retaining both causes if that recovery also fails.
                    let error = match guard.stream.play() {
                        Ok(()) => primary,
                        Err(resume) => OutputError::SwitchRecoveryFailed {
                            primary: Box::new(primary),
                            resume: Box::new(resume),
                        },
                    };
                    return Err(WrapError::Output(error));
                }
            };
            let stream_config = StreamConfigSnapshot::from_output_stream(&new_stream);
            let selected_name = stream_config.device_name.clone();
            // Assignment drops the already-paused old OutputStream; its Drop pauses once more as
            // the final invariant that no discarded cpal stream remains live.
            guard.stream = new_stream;
            Ok((selected_name, stream_config))
        })();

        // Success and failure deliberately converge here so neither observability arm can drift.
        self.record_device_switch_result(
            device.as_deref(),
            &switch_result,
            buffer_frames,
            cb_stats,
        );
        switch_result.map(|(selected_name, _)| selected_name)
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
    /// daemon WS handler は **spawn_blocking** で audio スレッド以外に隔離すること（session.rs）。
    /// `&self` で足りる: `set_link_tempo` は Rust 可視の可変状態を持たない（`LinkTempoControl` は `Arc`
    /// 共有で、tempo 反映は shim の interior mutability＝captureAppSessionState→commit）。
    /// `register_link_audio_channel` が `registered` HashMap を変更し `as_mut` を要するのと違い、ここは
    /// `guard.as_ref()` で足りる。
    #[cfg(feature = "link-audio")]
    pub fn set_link_tempo(&self, bpm: f64) -> Result<(), WrapError> {
        // mutex poison は egress 利用可能だが runtime で壊れた状態 → runtime error。
        let guard = self
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))?;
        match guard.as_ref() {
            // set_tempo は成功 true / 失敗 false。false（shim 内 Link 例外・実質起きない）は
            // false-positive success を返さず runtime error に昇格する（silent-failure 対策）。
            Some(ctl) => {
                if ctl.set_tempo(bpm) {
                    Ok(())
                } else {
                    Err(WrapError::LinkAudio(
                        "link set_tempo failed (Link rejected commit)".into(),
                    ))
                }
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
}

// ── 以下は #888 子 1 のレビュー（altitude）を受けて `role.rs` から移した。
// ストリーム/デバイスのライフサイクルと capture パス解決は「OOP role」ではなく
// このモジュールの主題である。🔴 純粋な移動で、本文は 1 行も書き換えていない。

/// `cpal::Stream` を保持する guard。drop されるとストリーム停止。`!Send`。
///
/// ## `link-audio` ビルド時（`_stream` → `_link`）
/// **この 2 フィールドの順は UB 安全だが意図的**（advisor #2）: `_stream` を先に drop して cpal
/// callback（ring の push 元）を止めてから `_link`（consumer thread を signal+join）を drop する。
/// rtrb はどちらの順でも UB にならない（逆順なら callback が undrained ring に push して drop
/// カウントするだけ）が、teardown 時の無駄な drop を避けるためこの順にしてある。reorder 禁止。
///
/// ## `clap-host` ビルド時（`_clap_teardown` → `_stream` → `_clap_thread`・carry-forward #1）
/// **この順は load-bearing**（UB 回避・上の link-audio とは性質が異なる）:
/// - `_clap_teardown` が先 = audio thread の callback で `stop_processing()` を済ませてから stream を
///   止める。逆順だと `StartedPluginAudioProcessor` が stream（callback）停止後に残り、wrong-thread
///   での暗黙 stop_processing/drop = CLAP 仕様違反（strict plugin で UB）。
/// - `_clap_thread` が後 = stream 停止後に専用スレッドを join し、instance の home thread で deactivate。
///
/// ## `outproc-effect` ビルド時（`_outproc_teardown` → `_stream` → `_child_guard`・γ M1 PR-C）
/// clap-host と同型の load-bearing 順:
/// - `_outproc_teardown` が先 = audio thread の adapter を quiesce（transport submit 停止）してから stream を止める。
/// - `_child_guard` が後 = stream 停止後に watchdog を止め child を QUIT/reap し shm を unlink する。
///
/// `outproc-instrument` も同じ teardown ordering を専用 guard/supervisor で維持する。
///
/// `clap-host` / `link-audio` は outproc family と引き続き `compile_error!` で排他である。一方
/// `outproc-effect` と `outproc-instrument` は both build で共存でき、その場合は両 child guard が
/// 同時に存在する。
pub struct StreamGuard {
    /// carry-forward #1（clap-host）: stream 停止 **前** に drop され、audio thread で `stop_processing`
    /// を済ませる（`ClapTeardownGuard::drop` が teardown_requested を立て teardown_done を待つ）。
    /// **field 順は load-bearing**: これは `_stream` より前に宣言する（Rust の field drop 順 = 宣言順）。
    #[cfg(feature = "clap-host")]
    pub(super) _clap_teardown: crate::clap_host::ClapTeardownGuard,
    /// γ M1 PR-C（outproc-effect）: stream 停止 **前** に drop され、audio thread の adapter を quiesce
    /// させる（transport への submit を止めて dry 素通しに入る）。**field 順は load-bearing**: `_stream`
    /// より前に宣言する（clap-host とは feature 排他なので同時には存在しない）。
    #[cfg(feature = "outproc-effect")]
    pub(super) _outproc_teardown: crate::outproc_effect::OutProcTeardownGuard,
    #[cfg(feature = "outproc-effect")]
    pub(super) _outproc_bus_teardowns: Vec<crate::outproc_effect::OutProcTeardownGuard>,
    /// outproc-instrument: stream 前に audio-thread adapter を quiesce する（#540 P1 で
    /// slot pool 化に伴い Vec。guard 間に共有状態は無く順序は load-bearing ではない）。
    /// both build における `_outproc_teardown` との相対順序も load-bearing ではない
    /// （各 guard は自 role 専用の requested/done atomic のみを操作し共有状態がない。
    /// stream 停止後の child guard 2つと同じ独立性）。
    #[cfg(feature = "outproc-instrument")]
    pub(super) _outproc_instrument_teardowns:
        Vec<crate::outproc_instrument::OutProcInstrumentTeardownGuard>,
    /// device switch（#484 D2）: `cpal::Stream`（`OutputStream` 内部）は `!Send` のため、`EngineWrap`
    /// （`Arc` 共有・tokio task を跨ぐため `Send + Sync` 必須）には一切保持させない。`StreamGuard` は
    /// 従来どおり単一の "audio owner thread"（`main.rs` が spawn する専用 OS thread）だけがローカル
    /// 変数として所有し続け、switch は `mpsc` 経由でその thread 上に処理を委譲する
    /// （[`EngineWrap::apply_device_switch`]）。**field 順は変わらず load-bearing**（従来の `_stream`
    /// と同じ位置）。
    pub(super) stream: OutputStream,
    #[cfg(feature = "link-audio")]
    pub(super) _link: Option<crate::link_audio::LinkAudioGuard>,
    /// clap-host: stream 停止 **後** に drop され、専用スレッドを停止 → `ClapHost::shutdown()` で
    /// instance を deactivate（instance の home thread）。**field 順は load-bearing**: `_stream` より
    /// 後に宣言する。
    #[cfg(feature = "clap-host")]
    pub(super) _clap_thread: crate::clap_host::ClapThreadGuard,
    /// γ M1 PR-C（outproc-effect）: stream 停止 **後** に drop され、watchdog を止めて（respawn 停止）
    /// child へ QUIT → reap → shm unlink する。**field 順は load-bearing**: `_stream` より後に宣言する。
    #[cfg(feature = "outproc-effect")]
    pub(super) _child_guard: Arc<Mutex<ChildSlot>>,
    #[cfg(feature = "outproc-effect")]
    pub(super) _bus_child_guards: Vec<Arc<Mutex<ChildSlot>>>,
    /// both build では同種 guard 間の順序は load-bearing ではない（どちらも stream 停止後）。別々の
    /// child process / shm region を持ち supervisor 間に共有状態が無いため、独立に teardown できる。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub(super) _instrument_child_guards: Vec<Arc<Mutex<ChildSlot<InstrumentRole>>>>,
    #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
    pub(super) _child_guards: Vec<Arc<Mutex<ChildSlot>>>,
}

/// 現在の出力 stream から得た実効構成と、直近の device switch 失敗理由。
/// 実効構成は switch 成功時だけ差し替え、失敗時は旧構成を保ったまま理由だけを更新する。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamConfigSnapshot {
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub device_requested: Option<String>,
    pub device_fell_back: bool,
    pub fallback_reason: Option<String>,
    pub first_callback_ms: u64,
    pub last_switch_failure: Option<String>,
    pub(super) output_fault: OutputFault,
}

impl StreamConfigSnapshot {
    pub(super) fn from_output_stream(stream: &OutputStream) -> Self {
        Self {
            device_name: stream.device_name.clone(),
            sample_rate: stream.sample_rate,
            channels: stream.channels,
            device_requested: stream.device_requested.clone(),
            device_fell_back: stream.device_fallback.is_some(),
            fallback_reason: stream
                .device_fallback
                .as_ref()
                .map(|fallback| fallback.reason.clone()),
            first_callback_ms: stream.first_callback_ms,
            last_switch_failure: None,
            output_fault: stream.fault(),
        }
    }
}

impl StreamGuard {
    /// capture seam（#307 realtime）: capture 有効時のみ producer-side drop 累積を返す（無効は `None`）。
    /// `Some(0)` は録音健全・`> 0` は録音破損（検証 invalid）。gated 検証ハーネスが teardown 前に
    /// assert する（`stream: OutputStream` へ委譲）。全 feature variant が `stream` を持つので共通。
    pub fn capture_drops(&self) -> Option<u64> {
        self.stream.capture_drops()
    }
}

/// device switch（#484 D2）: `EngineWrap::select_audio_device`（任意スレッド・`Send`）から
/// audio owner thread（`StreamGuard` を所有する専用 OS thread）へ送る要求。`reply` は
/// `std::sync::mpsc::Sender` なので、要求元は対応する `Receiver::recv()` で同期的に結果を待てる。
pub struct DeviceSwitchRequest {
    pub device: Option<String>,
    pub reply: std::sync::mpsc::Sender<Result<String, WrapError>>,
}

/// 生の env 値（`Some(raw)`）を capture 出力先 [`PathBuf`] へ解決する純関数（`capture_path_from_env`
/// の testable コア）。未設定 / 空 / 空白のみは `None`（capture 無効）。trim した値から `PathBuf` を
/// 組む（`"  /tmp/x.wav  "` のような前後空白を含む env でも正しいパスになる）。
pub(super) fn resolve_capture_path(raw: Option<String>) -> Option<PathBuf> {
    let raw = raw?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// capture seam（#307）: 環境変数 `ORBIT_CAPTURE_WAV` を解決して whole-stream WAV 録音の出力先を
/// 返す（未設定 / 空文字列なら `None` = capture 無効）。**env 読取りは daemon 層に集約**し、解決済み
/// パスを `orbit-audio-native` の `start_default_output*` へ typed で渡す（`OutProcEffectConfig` /
/// `buffer_frames` と同じ層分け＝native の公開 API に隠れた ambient env 依存を作らない）。
pub(super) fn capture_path_from_env() -> Option<PathBuf> {
    match std::env::var("ORBIT_CAPTURE_WAV") {
        Ok(raw) => resolve_capture_path(Some(raw)),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            // 非 UTF-8 の値を握り潰すと「capture したつもりが無効」になるので operator に報告する。
            // 🔴 #612: `eprintln!` は書き込み失敗で panic する。panic hook が `exit(1)` する
            // ようになった今、**この警告が書けないだけで daemon 全体が終了する**。
            crate::best_effort_stderr::write_line_best_effort(
                "[capture] ORBIT_CAPTURE_WAV が非 UTF-8 のため無視した（capture 無効）",
            );
            None
        }
    }
}
pub(super) fn probe_then_pause_old<T>(
    probe: impl FnOnce() -> Result<T, OutputError>,
    pause_old: impl FnOnce() -> Result<(), OutputError>,
) -> Result<T, OutputError> {
    let live = probe()?;
    pause_old()?;
    Ok(live)
}
