//! CLAP host controller: daemon の専用スレッドが所有する制御オブジェクト。
//!
//! `ClapHost` は `PluginInstance<OrbitClapHost>` を保持するため `!Send`。
//! daemon は専用スレッド（"CLAP main thread"）上でこれを管理する。
//!
//! spike の main.rs（select_plugin / build_install_msg / query_note_port_index / pump_until）
//! を library API として移植。

use crate::buffers::HostAudioBuffers;
use crate::config::{get_config_from_ports, FullAudioConfig};
use crate::discovery::{
    list_plugins_in_file, load_plugin_id_from_path, DiscoveryError, FoundPlugin,
};
use crate::host::{OrbitClapHost, OrbitHostMainThread, OrbitHostShared};
use crate::processor::InstallMsg;

use clack_extensions::note_ports::{NoteDialects, NotePortInfoBuffer, PluginNotePorts};
use clack_host::prelude::{HostInfo, PluginAudioConfiguration, PluginInstance};

use std::ffi::CString;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use thiserror::Error;

/// plugin load / host 操作のエラー型。
#[derive(Debug, Error)]
pub enum ClapHostError {
    #[error("plugin discovery エラー: {0}")]
    Discovery(#[from] DiscoveryError),
    #[error("plugin id '{0}' が見つからない")]
    PluginIdNotFound(String),
    #[error("ファイルにプラグインが見つからない")]
    NoPlugins,
    #[error("プラグインが複数存在する; plugin id を指定すること")]
    MultiplePlugins,
    #[error("plugin id が null バイトを含む")]
    NullPluginId,
    #[error("plugin のインスタンス生成に失敗: {0}")]
    Instantiate(String),
    #[error("plugin の activate に失敗: {0}")]
    Activate(String),
    #[error("start_processing に失敗: {0}")]
    StartProcessing(String),
}

/// load_plugin が返す plugin メタデータ（daemon が logging / UI に使う）。
pub struct LoadedPluginInfo {
    /// CLAP plugin id。
    pub plugin_id: String,
    /// プラグイン名（あれば）。
    pub plugin_name: Option<String>,
    /// note 入力ポートインデックス（InstallMsg にも含まれる・確認用）。
    pub note_port_index: u16,
}

/// daemon の専用スレッドが所有する CLAP host controller。
///
/// `PluginInstance<OrbitClapHost>` は `!Send` なので、`ClapHost` 自体も `!Send`。
/// daemon は 1 スレッドをこのオブジェクト専用に割り当てる。
pub struct ClapHost {
    /// audio thread の `request_callback` が store し、pump() が読む lock-free フラグ。
    callback_requested: Arc<AtomicBool>,
    /// HostAudioBuffers に渡すリサイズカウンタ（制御スレッドでも読める）。
    resize_count: Arc<AtomicU64>,
    /// plugin インスタンス（load_plugin 後に Some になる）。
    instance: Option<PluginInstance<OrbitClapHost>>,
}

impl ClapHost {
    /// 新規作成。`callback_requested` と `resize_count` は `new_clap_host` が生成した
    /// `ClapHostParts` のフィールドを clone して渡す。
    pub fn new(callback_requested: Arc<AtomicBool>, resize_count: Arc<AtomicU64>) -> Self {
        Self {
            callback_requested,
            resize_count,
            instance: None,
        }
    }

    /// .clap バンドルからプラグインをロードして `InstallMsg` を返す。
    ///
    /// activate + start_processing を実行する（CLAP 仕様: main thread 上で行う）。
    /// 返された `InstallMsg` を install ring に push すると audio thread が受け取る。
    ///
    /// # Arguments
    /// * `path` — .clap バンドルのパス。
    /// * `id` — plugin id（None なら単一プラグインの場合のみ OK）。
    /// * `sample_rate` — サンプリングレート（Hz）。
    /// * `channels` — 出力チャンネル数（通常 2）。
    /// * `max_frames` — 最大フレーム数（cpal の BufferSize::Fixed に合わせる）。
    pub fn load_plugin(
        &mut self,
        path: &Path,
        id: Option<&str>,
        sample_rate: u32,
        channels: usize,
        max_frames: u32,
    ) -> Result<(InstallMsg, LoadedPluginInfo), ClapHostError> {
        // プラグインを発見する。
        let found: FoundPlugin = match id {
            None => {
                let mut plugins = list_plugins_in_file(path)?;
                if plugins.is_empty() {
                    return Err(ClapHostError::NoPlugins);
                }
                if plugins.len() > 1 {
                    return Err(ClapHostError::MultiplePlugins);
                }
                plugins.remove(0)
            }
            Some(id) => load_plugin_id_from_path(path, id)?
                .ok_or_else(|| ClapHostError::PluginIdNotFound(id.to_string()))?,
        };

        let plugin_id_str = found.plugin.id.clone();
        let plugin_name = found.plugin.name.clone();

        let plugin_id =
            CString::new(found.plugin.id.as_str()).map_err(|_| ClapHostError::NullPluginId)?;

        let host_info = HostInfo::new(
            "OrbitScore daemon CLAP host",
            "Signal compose",
            "https://github.com/signalcompose/orbitscore",
            env!("CARGO_PKG_VERSION"),
        )
        .expect("HostInfo 文字列は有効なはず");

        // PluginInstance を生成する（main thread 要件: ここで実行）。
        // carry-forward #2: callback_requested Arc を closure にキャプチャして clone で共有。
        let cb = self.callback_requested.clone();
        let mut instance = PluginInstance::<OrbitClapHost>::new(
            move |_| OrbitHostShared::new(cb.clone()),
            |shared| OrbitHostMainThread::new(shared),
            &found.entry,
            &plugin_id,
            &host_info,
        )
        .map_err(|e| ClapHostError::Instantiate(e.to_string()))?;

        // note ポートインデックスを取得する（activate 前に実行）。
        let note_port_index = query_note_port_index(&mut instance);

        // ポート設定を取得して FullAudioConfig を組み立てる（cpal 依存なし・daemon が値を提供）。
        let plugin_input_port_config = get_config_from_ports(&mut instance.plugin_handle(), true);
        let plugin_output_port_config = get_config_from_ports(&mut instance.plugin_handle(), false);

        let audio_config = FullAudioConfig {
            plugin_output_port_config,
            plugin_input_port_config,
            output_channel_count: channels,
            min_buffer_size: 1,
            max_likely_buffer_size: max_frames,
            sample_rate,
        };

        let clap_config = PluginAudioConfiguration {
            sample_rate: sample_rate as f64,
            min_frames_count: audio_config.min_buffer_size,
            max_frames_count: max_frames,
        };

        // activate + start_processing（CLAP 仕様: main thread 上で実行）。
        let plugin = instance
            .activate(|_, _| (), clap_config)
            .map_err(|e| ClapHostError::Activate(e.to_string()))?
            .start_processing()
            .map_err(|e| ClapHostError::StartProcessing(e.to_string()))?;

        // HostAudioBuffers を事前確保する（audio thread での alloc を避けるため）。
        let buffers = HostAudioBuffers::from_config(audio_config, self.resize_count.clone());

        self.instance = Some(instance);

        let msg = InstallMsg {
            plugin,
            buffers,
            note_port_index,
        };
        let info = LoadedPluginInfo {
            plugin_id: plugin_id_str,
            plugin_name,
            note_port_index,
        };

        Ok((msg, info))
    }

    /// CLAP main-thread callback を pump する。
    ///
    /// daemon の専用スレッドから定期的に呼ぶ。plugin が `request_callback` を呼んだ場合、
    /// `callback_requested` フラグが立つのでここで処理する。
    pub fn pump(&mut self) {
        if let Some(instance) = &mut self.instance {
            // AcqRel swap: Release store（request_callback）の前に起きたすべての書き込みを
            // ここで acquire する。
            if self.callback_requested.swap(false, Ordering::AcqRel) {
                instance.call_on_main_thread_callback();
            }
        }
    }

    /// プラグインをシャットダウンする（teardown）。
    ///
    /// carry-forward #1: stop_processing は audio thread で行う必要がある。
    /// daemon は stream drop（audio processor drop）後にこの関数を呼ぶこと。
    /// TODO（carry-forward #1）: 明示的な stop_processing API を将来追加する。
    pub fn shutdown(&mut self) {
        // instance drop 時に CLAP の deactivate が実行される。
        // 前提: audio processor（StartedPluginAudioProcessor）は既に drop 済み（stream drop 後）。
        self.instance = None;
    }

    /// plugin がインストール済みかどうかを確認する。
    pub fn is_loaded(&self) -> bool {
        self.instance.is_some()
    }
}

/// note 入力ポートインデックスを取得する（CLAP / MIDI dialect を優先）。
/// plugin が NotePortsExtension を持たない場合は 0 を返す。
fn query_note_port_index(instance: &mut PluginInstance<OrbitClapHost>) -> u16 {
    let mut handle = instance.plugin_handle();
    let Some(note_ports) = handle.get_extension::<PluginNotePorts>() else {
        tracing::warn!("[orbit-clap-host] NotePortsExtension なし; port 0 を使用");
        return 0;
    };

    let mut buf = NotePortInfoBuffer::new();
    let count = note_ports.count(&mut handle, true);

    for i in 0..count.min(u16::MAX as u32) {
        let Some(info) = note_ports.get(&mut handle, i, true, &mut buf) else {
            continue;
        };
        if info
            .supported_dialects
            .intersects(NoteDialects::CLAP | NoteDialects::MIDI)
        {
            return i as u16;
        }
    }

    0
}
