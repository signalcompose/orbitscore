//! Headless CLAP host ハンドラ（A0 §4.3）。
//!
//! orbit-clap-spike の host.rs から移植。主な変更点（carry-forward #2）:
//! - `MainThreadMessage` enum と `mpsc::Sender` を削除。
//! - `OrbitHostShared` は `Arc<AtomicBool>` (callback_requested) を保持する。
//! - `request_callback` は `callback_requested.store(true, Release)` の atomic store になる
//!   （mpsc::Sender::send は alloc / block の可能性があり RT 違反）。
//! - pump 側（ClapHost::pump）が `callback_requested.swap(false, AcqRel)` で読む。

use clack_extensions::audio_ports::{AudioPortRescanFlags, HostAudioPortsImpl};
use clack_extensions::gui::{GuiSize, HostGui, HostGuiImpl};
use clack_extensions::log::{HostLog, HostLogImpl, LogSeverity};
use clack_extensions::note_ports::{HostNotePortsImpl, NoteDialects, NotePortRescanFlags};
use clack_extensions::params::{
    HostParams, HostParamsImplMainThread, HostParamsImplShared, ParamClearFlags, ParamRescanFlags,
};
use clack_host::prelude::*;
use orbit_child_ui::UiSize;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

const NO_CLOSED_CALLBACK: u8 = 0;
const CLOSED_NOT_DESTROYED: u8 = 1;
const CLOSED_DESTROYED: u8 = 2;
const NO_REQUESTED_SIZE: u64 = 0;

/// ホスト型タグ — Shared / MainThread / AudioProcessor を紐付ける。
pub struct OrbitClapHost;

impl HostHandlers for OrbitClapHost {
    type Shared<'a> = OrbitHostShared;
    type MainThread<'a> = OrbitHostMainThread<'a>;
    type AudioProcessor<'a> = ();

    fn declare_extensions(builder: &mut HostExtensions<Self>, shared: &Self::Shared<'_>) {
        builder.register::<HostLog>().register::<HostParams>();
        if shared.gui_callbacks.is_some() {
            builder.register::<HostGui>();
        }
        // audio-ports / note-ports はプラグイン側のエクステンションとして取得する
        // (ホスト提供エクステンションとしての登録は不要)。
    }
}

#[derive(Default)]
struct GuiCallbackState {
    closed: AtomicU8,
    requested_size: AtomicU64,
}

/// どのスレッドからもアクセス可能なデータ。
///
/// carry-forward #2: `mpsc::Sender` を `Arc<AtomicBool>` に置換。
/// audio thread から `request_callback` が呼ばれても alloc / block なし（RT 安全）。
pub struct OrbitHostShared {
    callback_requested: Arc<AtomicBool>,
    /// `Some` なのは out-of-process child 経路だけ。daemon の in-process 経路は
    /// `None` のままなので、CLAP GUI host extension を広告しない。
    gui_callbacks: Option<GuiCallbackState>,
}

impl OrbitHostShared {
    /// GUI を使わない in-process daemon 用。
    pub fn new(callback_requested: Arc<AtomicBool>) -> Self {
        Self {
            callback_requested,
            gui_callbacks: None,
        }
    }

    /// GUI を child の main thread で扱う standalone host 用。
    pub(crate) fn with_gui_callbacks(callback_requested: Arc<AtomicBool>) -> Self {
        Self {
            callback_requested,
            gui_callbacks: Some(GuiCallbackState::default()),
        }
    }

    pub(crate) fn take_closed(&self) -> Option<bool> {
        let state = self
            .gui_callbacks
            .as_ref()?
            .closed
            .swap(NO_CLOSED_CALLBACK, Ordering::AcqRel);
        match state {
            CLOSED_NOT_DESTROYED => Some(false),
            CLOSED_DESTROYED => Some(true),
            _ => None,
        }
    }

    pub(crate) fn take_requested_size(&self) -> Option<UiSize> {
        let packed = self
            .gui_callbacks
            .as_ref()?
            .requested_size
            .swap(NO_REQUESTED_SIZE, Ordering::AcqRel);
        if packed == NO_REQUESTED_SIZE {
            return None;
        }
        let size = GuiSize::unpack_from_u64(packed);
        Some(UiSize {
            width: size.width as i32,
            height: size.height as i32,
        })
    }
}

impl<'a> SharedHandler<'a> for OrbitHostShared {
    // `initializing` はトレイトデフォルト（no-op）を使用:
    // audio-ports / note-ports は設定時に直接クエリし、params は追跡しない。

    fn request_restart(&self) {
        // S1: restart 非対応
    }

    fn request_process(&self) {
        // CPAL は常時処理中; 何もしない
    }

    fn request_callback(&self) {
        // carry-forward #2: atomic store（RT 安全・alloc / block なし）。
        // pump 側が AcqRel swap で読み出してリセットする。
        self.callback_requested.store(true, Ordering::Release);
    }
}

/// main thread 専用データ。
pub struct OrbitHostMainThread<'a> {
    _shared: &'a OrbitHostShared,
    plugin: Option<InitializedPluginHandle<'a>>,
    /// audio-port rescan 非対応 warn の warn-once latch（#342-#2）。main thread 専用呼び出しなので
    /// `bool` で足りる（`AtomicBool` 不要）。`device_lost_reported` 慣習と同型。
    warned_rescan_unsupported: bool,
}

impl<'a> OrbitHostMainThread<'a> {
    pub fn new(shared: &'a OrbitHostShared) -> Self {
        Self {
            _shared: shared,
            plugin: None,
            warned_rescan_unsupported: false,
        }
    }
}

impl<'a> MainThreadHandler<'a> for OrbitHostMainThread<'a> {
    fn initialized(&mut self, instance: InitializedPluginHandle<'a>) {
        self.plugin = Some(instance);
    }
}

// ---- エクステンション実装 ----------------------------------------

impl HostLogImpl for OrbitHostShared {
    fn log(&self, severity: LogSeverity, message: &str) {
        if severity <= LogSeverity::Debug {
            return;
        }
        // daemon の structured log（tracing）へ流す。注意: tracing も RT 安全ではないが、
        // plugin が audio thread からログを呼ぶのは元々 misbehaving であり、eprintln と RT 上の
        // 性質は変わらない。整形ログに乗せて aggregator で拾えるようにする（observability・#340）。
        match severity {
            LogSeverity::Info => tracing::info!("[clap] {message}"),
            LogSeverity::Warning => tracing::warn!("[clap] {message}"),
            _ => tracing::error!("[clap:{severity}] {message}"),
        }
    }
}

impl HostAudioPortsImpl for OrbitHostMainThread<'_> {
    fn is_rescan_flag_supported(&self, _flag: AudioPortRescanFlags) -> bool {
        false
    }

    fn rescan(&mut self, flags: AudioPortRescanFlags) {
        // S1: is_rescan_flag_supported=false を広告済みだが plugin が rescan を要求した場合は no-op。
        // 構築時固定の is_effect（has_audio_input）/ポート構成が陳腐化しうるので可視化する（#342-#2。
        // 動的ポート対応そのものは #342 項目2 の将来作業）。同一 plugin の繰り返し要求でログを flood
        // させないため warn-once（2 回目以降は新情報ゼロ）。
        if !self.warned_rescan_unsupported {
            tracing::warn!(
                "[clap] plugin が audio-port rescan を要求したが S1 は動的ポート非対応のため no-op — \
                 構築時の is_effect/ポート構成が陳腐化している可能性 (flags={flags:?})"
            );
            self.warned_rescan_unsupported = true;
        } else {
            // 初回 warn 済み。再要求の flags は warn を flood させず debug で残す（後続要求が別 flag を
            // 立てても診断できるように・debug は既定で抑制される）。
            tracing::debug!("[clap] audio-port rescan 再要求 (flags={flags:?}) — no-op 継続");
        }
    }
}

impl HostNotePortsImpl for OrbitHostMainThread<'_> {
    fn supported_dialects(&self) -> NoteDialects {
        NoteDialects::CLAP
    }

    fn rescan(&mut self, _flags: NotePortRescanFlags) {
        // S1: 動的 note ポート変更非対応
    }
}

impl HostParamsImplMainThread for OrbitHostMainThread<'_> {
    fn rescan(&mut self, _flags: ParamRescanFlags) {}
    fn clear(&mut self, _param_id: ClapId, _flags: ParamClearFlags) {}
}

impl HostParamsImplShared for OrbitHostShared {
    fn request_flush(&self) {
        // 常時処理中; flush は不要
    }
}

impl HostGuiImpl for OrbitHostShared {
    fn resize_hints_changed(&self) {
        // P3b-1 は callback の保持まで。hints の再取得と NSWindow 操作は P3b-2。
    }

    fn request_resize(&self, new_size: GuiSize) -> Result<(), HostError> {
        if new_size.width == 0
            || new_size.height == 0
            || new_size.width > i32::MAX as u32
            || new_size.height > i32::MAX as u32
        {
            return Err(HostError::Message(
                "CLAP GUI requested an invalid parent size",
            ));
        }
        let callbacks = self
            .gui_callbacks
            .as_ref()
            .ok_or(HostError::Message("CLAP GUI callbacks are disabled"))?;
        callbacks
            .requested_size
            .store(new_size.pack_to_u64(), Ordering::Release);
        Ok(())
    }

    fn request_show(&self) -> Result<(), HostError> {
        Err(HostError::Message(
            "plugin-originated CLAP GUI show is unsupported",
        ))
    }

    fn request_hide(&self) -> Result<(), HostError> {
        Err(HostError::Message(
            "plugin-originated CLAP GUI hide is unsupported",
        ))
    }

    fn closed(&self, was_destroyed: bool) {
        if let Some(callbacks) = &self.gui_callbacks {
            callbacks.closed.store(
                if was_destroyed {
                    CLOSED_DESTROYED
                } else {
                    CLOSED_NOT_DESTROYED
                },
                Ordering::Release,
            );
        }
    }
}

// ---- headless pump の注記 ----------------------------------------
// pump は ClapHost::pump() として main thread で実行する — PluginInstance<OrbitClapHost>
// は !Send なのでそのスレッド以外に移動できない。carry-forward #2: callback_requested
// flag を AcqRel swap で読み出し、true なら call_on_main_thread_callback() を呼ぶ。

#[cfg(test)]
mod tests {
    use super::*;

    // #342-#2: audio-port rescan 非対応 warn の warn-once latch が、初回で立ち、再要求では
    // リセットされない（= 2 回目以降は warn を flood しない）ことを検証する。real plugin 不要 —
    // rescan は `&mut OrbitHostMainThread` のメソッドで `AudioPortRescanFlags` は trivially 構築できる。
    // regression 対象: 誰かが `if !self.warned_rescan_unsupported` ガードを外すと毎回 warn する。
    #[test]
    fn rescan_warn_latches_after_first_request() {
        let shared = OrbitHostShared::new(Arc::new(AtomicBool::new(false)));
        let mut mt = OrbitHostMainThread::new(&shared);
        assert!(!mt.warned_rescan_unsupported, "初期状態は未 warn");

        // UFCS で呼ぶ: OrbitHostMainThread は audio/note/params の 3 トレイトで rescan を実装するため
        // メソッド構文は曖昧（E0034）。
        HostAudioPortsImpl::rescan(&mut mt, AudioPortRescanFlags::CHANNEL_COUNT);
        assert!(mt.warned_rescan_unsupported, "初回 rescan で latch が立つ");

        // 別 flag で再要求しても latch は true のまま（warn flood せず panic もしない）。
        HostAudioPortsImpl::rescan(&mut mt, AudioPortRescanFlags::LIST);
        assert!(
            mt.warned_rescan_unsupported,
            "再要求でも latch は true のまま"
        );
    }

    #[test]
    fn gui_callbacks_are_marshaled_through_atomics_and_consumed_once() {
        let shared = OrbitHostShared::with_gui_callbacks(Arc::new(AtomicBool::new(false)));
        let requested = GuiSize {
            width: 640,
            height: 480,
        };

        HostGuiImpl::request_resize(&shared, requested).expect("accept resize callback");
        assert_eq!(
            shared.take_requested_size(),
            Some(UiSize {
                width: 640,
                height: 480
            })
        );
        assert_eq!(shared.take_requested_size(), None);

        HostGuiImpl::closed(&shared, false);
        assert_eq!(shared.take_closed(), Some(false));
        assert_eq!(shared.take_closed(), None);
        HostGuiImpl::closed(&shared, true);
        assert_eq!(shared.take_closed(), Some(true));
        assert_eq!(shared.take_closed(), None);
    }

    #[test]
    fn daemon_shared_state_keeps_gui_callbacks_disabled() {
        let shared = OrbitHostShared::new(Arc::new(AtomicBool::new(false)));

        assert!(shared.gui_callbacks.is_none());
        assert_eq!(shared.take_closed(), None);
        assert_eq!(shared.take_requested_size(), None);
        assert!(HostGuiImpl::request_resize(
            &shared,
            GuiSize {
                width: 640,
                height: 480
            }
        )
        .is_err());
    }
}
