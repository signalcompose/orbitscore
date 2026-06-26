//! Headless CLAP host ハンドラ（A0 §4.3）。
//!
//! orbit-clap-spike の host.rs から移植。主な変更点（carry-forward #2）:
//! - `MainThreadMessage` enum と `mpsc::Sender` を削除。
//! - `OrbitHostShared` は `Arc<AtomicBool>` (callback_requested) を保持する。
//! - `request_callback` は `callback_requested.store(true, Release)` の atomic store になる
//!   （mpsc::Sender::send は alloc / block の可能性があり RT 違反）。
//! - pump 側（ClapHost::pump）が `callback_requested.swap(false, AcqRel)` で読む。

use clack_extensions::audio_ports::{AudioPortRescanFlags, HostAudioPortsImpl};
use clack_extensions::log::{HostLog, HostLogImpl, LogSeverity};
use clack_extensions::note_ports::{HostNotePortsImpl, NoteDialects, NotePortRescanFlags};
use clack_extensions::params::{
    HostParams, HostParamsImplMainThread, HostParamsImplShared, ParamClearFlags, ParamRescanFlags,
};
use clack_host::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// ホスト型タグ — Shared / MainThread / AudioProcessor を紐付ける。
pub struct OrbitClapHost;

impl HostHandlers for OrbitClapHost {
    type Shared<'a> = OrbitHostShared;
    type MainThread<'a> = OrbitHostMainThread<'a>;
    type AudioProcessor<'a> = ();

    fn declare_extensions(builder: &mut HostExtensions<Self>, _shared: &Self::Shared<'_>) {
        builder.register::<HostLog>().register::<HostParams>();
        // audio-ports / note-ports はプラグイン側のエクステンションとして取得する
        // (ホスト提供エクステンションとしての登録は不要)。
    }
}

/// どのスレッドからもアクセス可能なデータ。
///
/// carry-forward #2: `mpsc::Sender` を `Arc<AtomicBool>` に置換。
/// audio thread から `request_callback` が呼ばれても alloc / block なし（RT 安全）。
pub struct OrbitHostShared {
    callback_requested: Arc<AtomicBool>,
}

impl OrbitHostShared {
    pub fn new(callback_requested: Arc<AtomicBool>) -> Self {
        Self { callback_requested }
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
}

impl<'a> OrbitHostMainThread<'a> {
    pub fn new(shared: &'a OrbitHostShared) -> Self {
        Self {
            _shared: shared,
            plugin: None,
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

    fn rescan(&mut self, _flags: AudioPortRescanFlags) {
        // S1: 動的ポート変更非対応
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

// ---- headless pump の注記 ----------------------------------------
// pump は ClapHost::pump() として main thread で実行する — PluginInstance<OrbitClapHost>
// は !Send なのでそのスレッド以外に移動できない。carry-forward #2: callback_requested
// flag を AcqRel swap で読み出し、true なら call_on_main_thread_callback() を呼ぶ。
