//! オーディオ設定ネゴシエーション（A0 §5）。
//!
//! orbit-clap-spike の config.rs から移植。cpal 依存を除去:
//! - `find_best_from(device, instance)` → 削除（daemon が直接 FullAudioConfig を組み立てる）
//! - `as_cpal_stream_config()` → 削除（cpal は native crate の責務）
//! - `as_clack_plugin_config()` → 削除（controller.rs が inline で組み立てる）
//!
//! 残りはスパイクから verbatim。

use clack_extensions::audio_ports::{
    AudioPortFlags, AudioPortInfoBuffer, AudioPortType, PluginAudioPorts,
};
use clack_host::prelude::{ClapId, PluginMainThreadHandle};
use std::fmt::{Display, Formatter};

/// CLAP plugin 設定を包含する完全なオーディオ設定。
///
/// daemon は sample_rate / channels / max_frames から直接この構造体を組み立てる
/// （cpal デバイスネゴシエーションは native 側の責務）。
pub struct FullAudioConfig {
    pub plugin_output_port_config: PluginAudioPortsConfig,
    pub plugin_input_port_config: PluginAudioPortsConfig,
    pub output_channel_count: usize,
    pub min_buffer_size: u32,
    /// activate に渡す最大バッファサイズ（A0 §5）。
    pub max_likely_buffer_size: u32,
    pub sample_rate: u32,
}

impl Display for FullAudioConfig {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}ch F32 @ {}Hz buf={}..{}",
            self.output_channel_count,
            self.sample_rate,
            self.min_buffer_size,
            self.max_likely_buffer_size
        )
    }
}

/// プラグインのオーディオポートレイアウト。
#[derive(Eq, PartialEq, Copy, Clone, Debug)]
pub enum AudioPortLayout {
    Mono,
    Stereo,
    Unsupported { channel_count: u16 },
}

impl AudioPortLayout {
    pub fn channel_count(&self) -> u16 {
        match self {
            AudioPortLayout::Mono => 1,
            AudioPortLayout::Stereo => 2,
            AudioPortLayout::Unsupported { channel_count } => *channel_count,
        }
    }
}

impl Display for AudioPortLayout {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            AudioPortLayout::Mono => f.write_str("mono"),
            AudioPortLayout::Stereo => f.write_str("stereo"),
            AudioPortLayout::Unsupported { channel_count } => write!(f, "{channel_count}ch"),
        }
    }
}

/// 1ポート分の情報。
#[derive(Clone, Debug)]
pub struct PluginAudioPortInfo {
    pub _id: Option<ClapId>,
    pub port_layout: AudioPortLayout,
    #[allow(dead_code)]
    pub name: String,
}

/// プラグインの全ポート（入力または出力）の設定。
#[derive(Clone, Debug)]
pub struct PluginAudioPortsConfig {
    pub ports: Vec<PluginAudioPortInfo>,
    pub main_port_index: u32,
}

impl PluginAudioPortsConfig {
    fn empty() -> Self {
        Self {
            main_port_index: 0,
            ports: vec![],
        }
    }

    fn default_stereo() -> Self {
        Self {
            main_port_index: 0,
            ports: vec![PluginAudioPortInfo {
                _id: None,
                port_layout: AudioPortLayout::Stereo,
                name: "Default".into(),
            }],
        }
    }

    pub fn main_port(&self) -> &PluginAudioPortInfo {
        &self.ports[self.main_port_index as usize]
    }

    pub fn total_channel_count(&self) -> usize {
        self.ports
            .iter()
            .map(|p| p.port_layout.channel_count() as usize)
            .sum()
    }
}

/// AudioPorts エクステンション経由でプラグインのポート設定を取得する。
pub fn get_config_from_ports(
    handle: &mut PluginMainThreadHandle,
    is_input: bool,
) -> PluginAudioPortsConfig {
    let Some(ports) = handle.get_extension::<PluginAudioPorts>() else {
        // 入力 fallback（empty）は has_audio_input=false を導き、effect でも instrument 経路
        // （add-mix）に回す。effect plugin がこれに当たると素通し（dry）になるため warn で surface する。
        tracing::warn!(
            is_input,
            "[orbit-clap-host] plugin に AudioPorts エクステンションなし; {} を仮定（input fallback は \
             effect→instrument 誤ルートになりうる）",
            if is_input {
                "入力なし"
            } else {
                "デフォルトステレオ出力"
            }
        );
        // シンセは入力ポートなし → empty。出力はデフォルトステレオ。
        return if is_input {
            PluginAudioPortsConfig::empty()
        } else {
            PluginAudioPortsConfig::default_stereo()
        };
    };

    let mut buf = AudioPortInfoBuffer::new();
    let mut main_port_index = None;
    let mut discovered = vec![];

    for i in 0..ports.count(handle, is_input) {
        let Some(info) = ports.get(handle, i, is_input, &mut buf) else {
            tracing::warn!(
                "[orbit-clap-host] index {i} のポート情報が取得できなかったためスキップ"
            );
            continue;
        };

        let port_type = info
            .port_type
            .or_else(|| AudioPortType::from_channel_count(info.channel_count));

        let layout = match port_type {
            Some(l) if l == AudioPortType::MONO => AudioPortLayout::Mono,
            Some(l) if l == AudioPortType::STEREO => AudioPortLayout::Stereo,
            _ => AudioPortLayout::Unsupported {
                channel_count: info.channel_count as u16,
            },
        };

        if info.flags.contains(AudioPortFlags::IS_MAIN) && main_port_index.replace(i).is_some() {
            tracing::warn!("[orbit-clap-host] プラグインが複数の main ポートを定義している");
        }

        discovered.push(PluginAudioPortInfo {
            _id: Some(info.id),
            port_layout: layout,
            name: String::from_utf8_lossy(info.name).into_owned(),
        });
    }

    if discovered.is_empty() {
        return if is_input {
            PluginAudioPortsConfig::empty()
        } else {
            tracing::warn!(
                "[orbit-clap-host] プラグインが出力ポートを報告しない; デフォルトステレオを使用"
            );
            PluginAudioPortsConfig::default_stereo()
        };
    }

    let idx = main_port_index.unwrap_or(0);
    PluginAudioPortsConfig {
        main_port_index: idx,
        ports: discovered,
    }
}
