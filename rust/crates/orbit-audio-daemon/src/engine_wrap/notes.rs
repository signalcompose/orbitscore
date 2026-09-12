//! `EngineWrap` のプラグインへのノート送出（CLAP / out-of-process instrument の両系統）（#888 子 1・第 3 束）。
//!
//! 🔴 **これは純粋な移動である。** `engine_wrap.rs` の `impl EngineWrap` から
//! そのまま移しただけで、**本文も可視性も 1 箇所も変えていない**。
//!
//! 親の子モジュールなので `EngineWrap` の private フィールドに到達できる（可視性の変更 0 件）。
//! 対応するインラインテストは `engine_wrap.rs` に残す（コード行に数えられないので目標に寄与しない）。

use super::*;

impl EngineWrap {
    /// ロード済み CLAP プラグインへ NoteOn を送る（event ring 経由・非ブロッキング・feature 専用）。
    #[cfg(feature = "clap-host")]
    pub fn plugin_note_on(
        &self,
        key: u8,
        channel: u8,
        velocity: f64,
        instance: Option<String>,
    ) -> Result<(), WrapError> {
        // in-process CLAP は単一インスタンスなので instance 指定は縮退する（#540 P1）。
        let _ = instance;
        self.push_plugin_event(orbit_clap_host::PluginEvent::NoteOn {
            key,
            channel,
            velocity,
        })
    }

    /// ロード済み CLAP プラグインへ NoteOff を送る（feature 専用）。
    #[cfg(feature = "clap-host")]
    pub fn plugin_note_off(
        &self,
        key: u8,
        channel: u8,
        velocity: f64,
        instance: Option<String>,
    ) -> Result<(), WrapError> {
        let _ = instance;
        self.push_plugin_event(orbit_clap_host::PluginEvent::NoteOff {
            key,
            channel,
            velocity,
        })
    }

    /// in-process CLAP は instance ごとの active-note 台帳を持たない。発音経路が台帳の対象外で
    /// あることは停止失敗ではないため、global.stop() から安全に呼べる空の成功を返す。
    #[cfg(all(feature = "clap-host", not(feature = "outproc-instrument")))]
    pub fn plugin_all_notes_off(&self) -> Result<PluginAllNotesOffSummary, WrapError> {
        Ok(PluginAllNotesOffSummary::default())
    }

    /// Out-of-process instrument NoteOn. Conversion to the format-neutral wire event happens on
    /// this control-side method; the audio thread only pops already-converted events.
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    pub fn plugin_note_on(
        &self,
        key: u8,
        channel: u8,
        velocity: f64,
        instance: Option<String>,
    ) -> Result<(), WrapError> {
        self.push_outproc_instrument_event(
            orbit_audio_sandbox::NeutralEvent::NoteOn {
                sample_offset: 0,
                addr: Self::outproc_instrument_voice_addr(channel, key),
                velocity,
                tuning_cents: 0.0,
                length_frames: 0,
            },
            instance.as_deref(),
        )
        .map_err(Self::public_plugin_note_error)?;
        let name = instance
            .as_deref()
            .unwrap_or(DEFAULT_INSTRUMENT_INSTANCE)
            .to_string();
        self.lock_active_notes()?.insert((name, channel, key));
        Ok(())
    }

    /// Out-of-process instrument NoteOff, converted on the control side.
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    pub fn plugin_note_off(
        &self,
        key: u8,
        channel: u8,
        velocity: f64,
        instance: Option<String>,
    ) -> Result<(), WrapError> {
        self.push_outproc_instrument_event(
            orbit_audio_sandbox::NeutralEvent::NoteOff {
                sample_offset: 0,
                addr: Self::outproc_instrument_voice_addr(channel, key),
                velocity,
            },
            instance.as_deref(),
        )
        .map_err(Self::public_plugin_note_error)?;
        let name = instance
            .as_deref()
            .unwrap_or(DEFAULT_INSTRUMENT_INSTANCE)
            .to_string();
        self.lock_active_notes()?.remove(&(name, channel, key));
        Ok(())
    }

    /// 追跡中の全 OOP instrument note を解放する。台帳は clone した snapshot から送出し、
    /// 成功または stale と判定できた entry だけを最後に除去する。ring push 前には台帳 lock を
    /// 必ず解放するため、control lock との入れ子も retry 中の他 note RPC の足止めも生じない。
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    pub fn plugin_all_notes_off(&self) -> Result<PluginAllNotesOffSummary, WrapError> {
        let notes = {
            let active = self.lock_active_notes()?;
            active.iter().cloned().collect::<Vec<_>>()
        };

        let mut summary = PluginAllNotesOffSummary::default();
        let mut released_notes = HashSet::new();
        let mut first_error = None;
        for (instance, channel, key) in notes {
            let event = orbit_audio_sandbox::NeutralEvent::NoteOff {
                sample_offset: 0,
                addr: Self::outproc_instrument_voice_addr(channel, key),
                velocity: 0.0,
            };
            match self.push_outproc_instrument_event(event, Some(&instance)) {
                Ok(()) => {
                    summary.released += 1;
                    released_notes.insert((instance, channel, key));
                }
                Err(
                    WrapError::OutProcInstrumentStale(_)
                    | WrapError::OutProcInstrumentUnavailable(_),
                ) => {
                    summary.stale += 1;
                    released_notes.insert((instance, channel, key));
                }
                Err(error) => {
                    summary.failed += 1;
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if !released_notes.is_empty() {
            self.lock_active_notes()?
                .retain(|note| !released_notes.contains(note));
        }
        if let Some(error) = first_error {
            tracing::error!(
                first_error = %error,
                released = summary.released,
                stale = summary.stale,
                failed = summary.failed,
                "plugin all-notes-off completed with delivery failures"
            );
        }
        Ok(summary)
    }

    /// GetStatus 診断と integration test seam が使う active-note 台帳の現在件数。
    #[cfg(feature = "outproc-instrument")]
    #[doc(hidden)]
    pub fn active_plugin_note_count(&self) -> Result<usize, WrapError> {
        self.lock_active_notes().map(|active| active.len())
    }

    /// integration test seam: 実 child を鳴らさず active-note 台帳へ 1 件注入する。
    #[cfg(feature = "outproc-instrument")]
    #[doc(hidden)]
    pub fn inject_active_plugin_note(
        &self,
        instance: &str,
        channel: u8,
        key: u8,
    ) -> Result<(), WrapError> {
        self.lock_active_notes()?
            .insert((instance.to_owned(), channel, key));
        Ok(())
    }

    /// Builds the `VoiceAddr` shared by `plugin_note_on`/`plugin_note_off` for the
    /// out-of-process instrument path (single-port, note-id-less MIDI addressing).
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    fn outproc_instrument_voice_addr(channel: u8, key: u8) -> orbit_audio_sandbox::VoiceAddr {
        orbit_audio_sandbox::VoiceAddr {
            note_id: -1,
            port_index: 0,
            channel: channel as i16,
            key: key as i16,
            _pad: 0,
        }
    }

    /// 通常の PluginNoteOn/Off wire 契約では unknown instance も従来どおり runtime error。
    /// PluginAllNotesOff だけが内部 variant を直接読み、stale 集計へ変換する。
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    fn public_plugin_note_error(error: WrapError) -> WrapError {
        match error {
            WrapError::OutProcInstrumentStale(message) => WrapError::OutProcInstrument(message),
            other => other,
        }
    }

    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    fn push_outproc_instrument_event(
        &self,
        event: orbit_audio_sandbox::NeutralEvent,
        instance: Option<&str>,
    ) -> Result<(), WrapError> {
        let name = instance.unwrap_or(DEFAULT_INSTRUMENT_INSTANCE);
        // OOP ring も in-process と同じ bounded retry に載せる。各試行で lock を取り直すため、
        // sleep 中は control lock を保持しない。
        push_with_bounded_retry(
            |item| {
                let mut guard = match self.outproc_instrument.lock() {
                    Ok(guard) => guard,
                    Err(_) => {
                        return PushAttemptOutcome::Fatal(WrapError::OutProcInstrument(
                            "outproc instrument mutex poisoned".into(),
                        ));
                    }
                };
                let control = match guard.as_mut() {
                    Some(control) => control,
                    None => {
                        return PushAttemptOutcome::Fatal(WrapError::OutProcInstrumentUnavailable(
                            "outproc instrument not initialized (test backend)".into(),
                        ));
                    }
                };
                // #540 P1: instance → slot の解決。未割当の instance への note は「未ロード」と同義
                // なので明示エラーにする（旧単数時代は ring へ積んで黙って捨てられていた）。
                let Some(&index) = control.instance_index.get(name) else {
                    return PushAttemptOutcome::Fatal(WrapError::OutProcInstrumentStale(format!(
                        "unknown instrument instance '{name}' (LoadPlugin has not assigned it a slot)"
                    )));
                };
                let slot = control
                    .slots
                    .get_mut(index)
                    .expect("instance_index always maps to a pre-allocated slot");
                match slot.event_tx.push(item) {
                    Ok(()) => PushAttemptOutcome::Sent,
                    Err(rtrb::PushError::Full(returned)) => PushAttemptOutcome::Full(returned),
                }
            },
            event,
            PLUGIN_EVENT_RETRY_MAX_ATTEMPTS,
            PLUGIN_EVENT_RETRY_INTERVAL,
            &self.plugin_event_ring_overflow_count,
            || {
                // 診断の同一性方針（#542 レビュー）: N 台化したエラーは instance を名指しする。
                WrapError::OutProcInstrument(format!(
                    "instrument note ring full after bounded retry (instance '{name}')"
                ))
            },
        )
    }

    #[cfg(feature = "clap-host")]
    fn push_plugin_event(&self, ev: orbit_clap_host::PluginEvent) -> Result<(), WrapError> {
        // #405: プラグイン未ロード時は event ring に投げても audio thread が黙って drain して
        // 捨てるだけ（fire-and-forget ring の設計上ロード状態の同期確認は本来 cross-thread
        // round-trip が要る）。少なくとも「一度もロードに成功していない」ことは control スレッド
        // 側でここまで同期的に判定できるので、その場合は明示的なエラーを返す（嘘の成功応答を防ぐ）。
        // 残存課題（Issue #410）: このガードは「LoadPlugin の応答が成功した」ことしか検知できない。
        // 応答成功後 audio thread が install ring から実際に pop してインストールするまでの狭い
        // window では `plugin_loaded == true` かつ install 未完了になりうる。その window で送った
        // note はガードを通過して `Ok(())` を返すが audio thread 側は無音のままドレインする（同種の
        // false-success が window 限定で残る・追跡は Issue #410）。cross-thread ack の追加は
        // #405/#407 では scope 外（owner 判断待ち）。
        if !self.plugin_loaded.load(Ordering::Relaxed) {
            return Err(WrapError::ClapNotLoaded(
                "no plugin loaded (send LoadPlugin first)".into(),
            ));
        }
        // event ring（1024 slot）が満杯でも、audio callback が毎 block 全量 drain するので
        // bounded retry で lossless 化する（#400）。真にタイムアウトした場合のみ error。
        // mutex は各試行ごとに取得・解放し、sleep 中は保持しない（load_plugin と同じ「lock は
        // send までで解放」規約・#402 レビュー指摘: sleep 中も保持すると他セッションの
        // LoadPlugin/PluginNoteOn 等を最大リトライ時間だけ足止めしてしまう）。
        push_with_bounded_retry(
            |item| {
                let mut guard = match self.clap.lock() {
                    Ok(guard) => guard,
                    Err(_) => {
                        return PushAttemptOutcome::Fatal(WrapError::Clap(
                            "clap mutex poisoned".into(),
                        ))
                    }
                };
                let ctl = match guard.as_mut() {
                    Some(ctl) => ctl,
                    None => {
                        return PushAttemptOutcome::Fatal(WrapError::ClapUnavailable(
                            "clap host not initialized (test backend)".into(),
                        ))
                    }
                };
                match ctl.event_tx.push(item) {
                    Ok(()) => PushAttemptOutcome::Sent,
                    Err(rtrb::PushError::Full(returned)) => PushAttemptOutcome::Full(returned),
                }
            },
            ev,
            PLUGIN_EVENT_RETRY_MAX_ATTEMPTS,
            PLUGIN_EVENT_RETRY_INTERVAL,
            &self.plugin_event_ring_overflow_count,
            || WrapError::Clap("plugin event ring full after bounded retry".into()),
        )
    }

    /// feature `clap-host` と `outproc-instrument` の両方が無効なビルド用の stub（#420 PR #422
    /// Part 2 で `cfg` を `outproc-instrument` にも拡張したが、このコメントは `clap-host` 単独無効
    /// としか書いておらず実際の条件と食い違っていた — comment-analyzer round 3 指摘）。
    #[cfg(not(any(feature = "clap-host", feature = "outproc-instrument")))]
    pub fn plugin_note_on(
        &self,
        _key: u8,
        _channel: u8,
        _velocity: f64,
        _instance: Option<String>,
    ) -> Result<(), WrapError> {
        Err(WrapError::ClapUnavailable(
            "engine built without 'clap-host' or 'outproc-instrument' feature".into(),
        ))
    }

    /// feature `clap-host` と `outproc-instrument` の両方が無効なビルド用の stub（上の
    /// `plugin_note_on` stub と同じ食い違い・同じ修正）。
    #[cfg(not(any(feature = "clap-host", feature = "outproc-instrument")))]
    pub fn plugin_note_off(
        &self,
        _key: u8,
        _channel: u8,
        _velocity: f64,
        _instance: Option<String>,
    ) -> Result<(), WrapError> {
        Err(WrapError::ClapUnavailable(
            "engine built without 'clap-host' or 'outproc-instrument' feature".into(),
        ))
    }

    /// plugin hosting feature が無い build には発音経路も台帳も無いため、空の成功を返す。
    #[cfg(not(any(feature = "clap-host", feature = "outproc-instrument")))]
    pub fn plugin_all_notes_off(&self) -> Result<PluginAllNotesOffSummary, WrapError> {
        Ok(PluginAllNotesOffSummary::default())
    }
}
