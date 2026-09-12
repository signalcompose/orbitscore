//! `EngineWrap` のプラグイン UI の開閉と state 保存（#888 子 1・第 5 束）。
//!
//! 🔴 **これは純粋な移動である。** `outproc_instrument.rs` から UI 系を切り出した。
//! 1 ファイルにまとめると **759 コード行**で #888 の閾値 500 を超えるため
//! （設計 §13.9 の制約 1）。
//!
//! 親の子モジュールなので `EngineWrap` の private フィールドに到達できる。

use super::*;

impl EngineWrap {
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn plugin_ui_handles_for_target(
        &self,
        target: &PluginStateTarget,
        chain_index: usize,
    ) -> Result<(PluginUiHandles, bool), WrapError> {
        self.resolve_outproc_slot(target, OutProcSlotErrorKind::Ui)?
            .ui_handles(chain_index)
    }

    /// Ack correlation is entirely `(generation, window, evt_seq)`. Unlike open/close, a late ack
    /// must still reach the child slot after the stage that originated it has been dropped.
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn plugin_ui_handles_for_ack(
        &self,
        target: &PluginStateTarget,
    ) -> Result<(PluginUiHandles, bool), WrapError> {
        self.resolve_outproc_slot(target, OutProcSlotErrorKind::Ui)?
            .ui_handles_without_stage_validation()
    }

    /// OPEN_UI は view attach 完了 ack を待つ。window title は mailbox `cmd_arg` で child へ渡す。
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn open_outproc_plugin_ui(
        &self,
        target: PluginStateTarget,
        index: u64,
        window_title: String,
        window: Option<u64>,
    ) -> Result<(), WrapError> {
        if window_title.trim().is_empty() {
            return Err(WrapError::PluginUiProtocol(
                "windowTitle must be a non-empty string".into(),
            ));
        }
        let ((mailbox, pump, route, index_binding), rack_target) =
            self.plugin_ui_handles_for_target(&target, index as usize)?;
        if !mailbox.child_is_ready().map_err(plugin_ui_mailbox_error)? {
            return Err(WrapError::PluginUiUnavailable(
                "the selected child is starting or respawning".into(),
            ));
        }
        let key = if rack_target {
            Some(window.ok_or_else(|| {
                WrapError::PluginUiProtocol("rack plugin UI requires a window token".into())
            })?)
        } else {
            None
        };
        let binding_index = u32::try_from(index).map_err(|_| {
            WrapError::PluginUiTarget(format!("plugin UI chain index {index} exceeds u32"))
        })?;
        if let (Some(window), Some(index_binding)) = (key, index_binding.as_ref()) {
            let mut binding = index_binding.lock().map_err(|_| {
                WrapError::PluginUiProtocol("plugin UI index binding poisoned".into())
            })?;
            if let Some(existing) = binding.get(&binding_index) {
                return Err(WrapError::PluginUiProtocol(format!(
                    "OPEN_UI requested while lifecycle is Open (chain index {index} is bound to window {existing})"
                )));
            }
            // Reserve before the blocking child command so concurrent MCP opens cannot both pass
            // the loud duplicate-open gate. Failure paths below roll this reservation back.
            binding.insert(binding_index, window);
        }
        if let Err(error) = pump.begin_open(key) {
            remove_plugin_ui_binding(&index_binding, binding_index, key);
            return Err(plugin_ui_pump_error(error));
        }
        let rendered_target = PluginUiTarget::from_state_target(&target, index, key);
        match route.lock() {
            Ok(mut route) => {
                if route.insert(key, rendered_target.clone()).is_some() {
                    pump.finish_open(key, false).map_err(plugin_ui_pump_error)?;
                    remove_plugin_ui_binding(&index_binding, binding_index, key);
                    return Err(WrapError::PluginUiProtocol(format!(
                        "OPEN_UI requested while lifecycle is Open (window {key:?} already has a route)"
                    )));
                }
            }
            Err(_) => {
                pump.finish_open(key, false).map_err(plugin_ui_pump_error)?;
                remove_plugin_ui_binding(&index_binding, binding_index, key);
                return Err(WrapError::PluginUiProtocol(
                    "plugin UI target coordinator poisoned".into(),
                ));
            }
        }
        let result = if rack_target {
            let argument = serde_json::to_string(&serde_json::json!({
                "index": index,
                "title": window_title,
                "window": key.expect("rack window token was required above"),
            }))
            .map_err(|error| WrapError::PluginUiProtocol(error.to_string()))?;
            mailbox.issue_open_ui_at(&argument)
        } else {
            mailbox.issue_open_ui(&window_title)
        }
        .map(|_| ())
        .map_err(plugin_ui_mailbox_error);
        let finish = pump
            .finish_open(key, result.is_ok())
            .map_err(plugin_ui_pump_error);
        if result.is_err() || finish.is_err() {
            if let Ok(mut route) = route.lock() {
                if route.get(&key) == Some(&rendered_target) {
                    route.remove(&key);
                }
            }
            remove_plugin_ui_binding(&index_binding, binding_index, key);
        }
        finish?;
        result
    }

    /// CLOSE_UI response is Phase A acceptance only. Completion is broadcast exclusively from
    /// the pump's `UI_CLOSED_DONE` observation.
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn close_outproc_plugin_ui(
        &self,
        target: PluginStateTarget,
        index: u64,
        window: Option<u64>,
    ) -> Result<(), WrapError> {
        let ((mailbox, _pump, route, index_binding), rack_target) =
            self.plugin_ui_handles_for_target(&target, index as usize)?;
        let key = if rack_target {
            Some(window.ok_or_else(|| {
                WrapError::PluginUiProtocol("rack plugin UI requires a window token".into())
            })?)
        } else {
            None
        };
        if rack_target {
            let binding_index = u32::try_from(index).map_err(|_| {
                WrapError::PluginUiTarget(format!("plugin UI chain index {index} exceeds u32"))
            })?;
            let binding = index_binding
                .as_ref()
                .ok_or_else(|| {
                    WrapError::PluginUiProtocol("rack plugin UI index binding is missing".into())
                })?
                .lock()
                .map_err(|_| {
                    WrapError::PluginUiProtocol("plugin UI index binding poisoned".into())
                })?;
            if binding.get(&binding_index).copied() != key {
                return Err(WrapError::PluginUiTarget(format!(
                    "requested UI window {key:?} does not match chain index {index} binding {:?}",
                    binding.get(&binding_index)
                )));
            }
        }
        let current = route
            .lock()
            .map_err(|_| {
                WrapError::PluginUiProtocol("plugin UI target coordinator poisoned".into())
            })?
            .get(&key)
            .cloned();
        if !current
            .as_ref()
            .is_some_and(|current| current.matches_state_target(&target))
        {
            return Err(WrapError::PluginUiTarget(format!(
                "requested UI target {target:?} window {key:?} is not the currently open target {current:?}"
            )));
        }
        if rack_target {
            let argument = serde_json::to_string(&serde_json::json!({
                "index": index,
                "window": key.expect("rack window token was required above"),
            }))
            .map_err(|error| WrapError::PluginUiProtocol(error.to_string()))?;
            mailbox.issue_close_ui_at(&argument)
        } else {
            mailbox.issue_close_ui()
        }
        .map(|_| ())
        .map_err(plugin_ui_mailbox_error)
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn ack_outproc_ui_safepoint(
        &self,
        target: PluginStateTarget,
        _index: u64,
        window: Option<u64>,
        generation: u64,
        evt_seq: u64,
    ) -> Result<(), WrapError> {
        let ((_mailbox, pump, route, _index_binding), rack_target) =
            self.plugin_ui_handles_for_ack(&target)?;
        let key = if rack_target {
            Some(window.ok_or_else(|| {
                WrapError::PluginUiProtocol("rack plugin UI requires a window token".into())
            })?)
        } else {
            None
        };
        let current = route
            .lock()
            .map_err(|_| {
                WrapError::PluginUiProtocol("plugin UI target coordinator poisoned".into())
            })?
            .get(&key)
            .cloned();
        // timeout-without-save の DONE 後は route が消えるが、spec が許す遅着保存 ack は同じ
        // target の slot/pump へ届ける。別の UI が既に open なら誤配送として拒否する。
        let matches_route = current
            .as_ref()
            .is_none_or(|current| current.matches_state_target(&target));
        if !matches_route {
            return Err(WrapError::PluginUiTarget(format!(
                "AckUiSafepoint target does not match current UI target {current:?}"
            )));
        }
        pump.ack_safepoint(generation, key, evt_seq)
            .map_err(plugin_ui_pump_error)
    }

    /// out-of-process childへstate保存を1回だけ発行し、同一directoryの一時ファイルを
    /// 検証後に最終パスへatomic renameする。P1 完了後は演奏中も許可される。
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn save_outproc_plugin_state(
        &self,
        target: PluginStateTarget,
        chain_index: usize,
        final_path: PathBuf,
    ) -> Result<SavedPluginStateSummary, WrapError> {
        if !final_path.is_absolute() {
            return Err(WrapError::PluginStateIo(format!(
                "state path must be absolute: {final_path:?}"
            )));
        }

        let handles = self
            .resolve_outproc_slot(&target, OutProcSlotErrorKind::State)?
            .state_handles(chain_index)?;
        let mailbox = handles.mailbox();

        if !mailbox
            .child_is_ready()
            .map_err(plugin_state_mailbox_error)?
        {
            return Err(WrapError::PluginStateNotReady(
                "the selected child is starting or respawning".into(),
            ));
        }

        let parent = final_path.parent().ok_or_else(|| {
            WrapError::PluginStateIo(format!("state path has no parent: {final_path:?}"))
        })?;
        std::fs::create_dir_all(parent).map_err(|error| {
            WrapError::PluginStateIo(format!("create state directory {parent:?}: {error}"))
        })?;
        let file_name = final_path.file_name().ok_or_else(|| {
            WrapError::PluginStateIo(format!("state path has no file name: {final_path:?}"))
        })?;
        let temp_path = parent.join(format!(
            ".{}.orbit-state-{}.tmp",
            file_name.to_string_lossy(),
            Uuid::new_v4().simple()
        ));

        let response = match handles.issue_save(&temp_path) {
            Ok(response) => response,
            Err(error) => {
                if !matches!(
                    &error,
                    orbit_audio_sandbox::CommandMailboxError::Timeout { .. }
                ) {
                    let _ = std::fs::remove_file(&temp_path);
                } else {
                    tracing::warn!(
                        ?temp_path,
                        "state mailbox timed out; retaining unique sidecar until child ack/reset"
                    );
                }
                return Err(plugin_state_mailbox_error(error));
            }
        };
        if response.bytes_written == 0 {
            let _ = std::fs::remove_file(&temp_path);
            return Err(WrapError::PluginStateUnsupported(
                "plugin returned an empty state".into(),
            ));
        }
        let actual_len = match std::fs::metadata(&temp_path) {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                let _ = std::fs::remove_file(&temp_path);
                return Err(WrapError::PluginStateIo(format!(
                    "stat state sidecar {temp_path:?} after child ack: {error}"
                )));
            }
        };
        if actual_len != response.bytes_written {
            let _ = std::fs::remove_file(&temp_path);
            return Err(WrapError::PluginStateProtocol(format!(
                "child ack reported {} bytes but sidecar has {actual_len} bytes",
                response.bytes_written
            )));
        }
        std::fs::rename(&temp_path, &final_path).map_err(|error| {
            let _ = std::fs::remove_file(&temp_path);
            WrapError::PluginStateIo(format!(
                "atomically replace state file {final_path:?}: {error}"
            ))
        })?;
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                WrapError::PluginStateIo(format!(
                    "sync state directory {parent:?} after rename: {error}"
                ))
            })?;
        handles.record_latest_state(final_path.clone())?;

        Ok(SavedPluginStateSummary {
            path: final_path,
            bytes_written: response.bytes_written,
        })
    }
}
