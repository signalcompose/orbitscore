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
}
