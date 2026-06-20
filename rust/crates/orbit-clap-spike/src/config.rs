//! Audio configuration negotiation (A0 §5).
//!
//! Ported from clack cpal example `host/audio/config.rs`, stripped of GUI/MIDI dependencies.
//! Deviation from example: F32-only output (CoreAudio native format).

use crate::host::OrbitClapHost;
use clack_extensions::audio_ports::{
    AudioPortFlags, AudioPortInfoBuffer, AudioPortType, PluginAudioPorts,
};
use clack_host::prelude::{ClapId, PluginAudioConfiguration, PluginInstance, PluginMainThreadHandle};
use cpal::traits::DeviceTrait;
use cpal::{BufferSize, Device, SampleRate, StreamConfig, SupportedBufferSize};
use std::fmt::{Display, Formatter};

/// Full audio configuration encompassing both CPAL and CLAP-plugin parameters.
pub struct FullAudioConfig {
    pub plugin_output_port_config: PluginAudioPortsConfig,
    pub plugin_input_port_config: PluginAudioPortsConfig,
    pub output_channel_count: usize,
    pub min_buffer_size: u32,
    /// Max buffer size passed to `activate`. Also passed to cpal as `BufferSize::Fixed`.
    /// A0 §5: these must match.
    pub max_likely_buffer_size: u32,
    pub sample_rate: u32,
}

impl FullAudioConfig {
    pub fn find_best_from(
        device: &Device,
        instance: &mut PluginInstance<OrbitClapHost>,
    ) -> anyhow::Result<Self> {
        // Query plugin ports
        let input_ports = get_config_from_ports(&mut instance.plugin_handle(), true);
        let output_ports = get_config_from_ports(&mut instance.plugin_handle(), false);

        // Pick a supported F32 config from cpal
        let mut configs: Vec<_> = device
            .supported_output_configs()
            .map_err(|e| anyhow::anyhow!("cpal supported configs: {e}"))?
            .filter(|c| {
                // Only F32 and only mono or stereo
                c.sample_format() == cpal::SampleFormat::F32
                    && c.channels() >= 1
                    && c.channels() <= 2
                    && c.max_sample_rate().0 >= 44_100
            })
            .collect();

        if configs.is_empty() {
            anyhow::bail!("No F32 output config available — A0 spike requires F32 (CoreAudio should always provide it)");
        }

        // Prefer stereo; then sort by sample rate preference
        configs.sort_by(|a, b| b.channels().cmp(&a.channels()));
        let chosen = configs.into_iter().next().unwrap();

        let (min_buf, max_buf) = match chosen.buffer_size() {
            SupportedBufferSize::Range { min, max } => (*min, 1024u32.clamp(*min, *max)),
            SupportedBufferSize::Unknown => (1, 1024),
        };

        Ok(FullAudioConfig {
            output_channel_count: chosen.channels() as usize,
            min_buffer_size: min_buf.max(1),
            max_likely_buffer_size: max_buf,
            sample_rate: 44_100u32.clamp(
                chosen.min_sample_rate().0,
                chosen.max_sample_rate().0,
            ),
            plugin_output_port_config: output_ports,
            plugin_input_port_config: input_ports,
        })
    }

    /// CPAL stream config (BufferSize::Fixed, A0 §5).
    pub fn as_cpal_stream_config(&self) -> StreamConfig {
        StreamConfig {
            channels: self.output_channel_count as u16,
            buffer_size: BufferSize::Fixed(self.max_likely_buffer_size),
            sample_rate: SampleRate(self.sample_rate),
        }
    }

    /// CLAP plugin activation config (A0 §5 — min/max must match cpal Fixed).
    pub fn as_clack_plugin_config(&self) -> PluginAudioConfiguration {
        PluginAudioConfiguration {
            sample_rate: self.sample_rate as f64,
            min_frames_count: self.min_buffer_size,
            max_frames_count: self.max_likely_buffer_size,
        }
    }
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

/// Port layout for a plugin's audio port.
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

/// Information about one plugin port.
#[derive(Clone, Debug)]
pub struct PluginAudioPortInfo {
    pub _id: Option<ClapId>,
    pub port_layout: AudioPortLayout,
    #[allow(dead_code)]
    pub name: String,
}

/// Configuration of all ports (input or output) of a plugin.
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

    #[allow(dead_code)]
    pub fn total_channel_count(&self) -> usize {
        self.ports
            .iter()
            .map(|p| p.port_layout.channel_count() as usize)
            .sum()
    }
}

/// Query a plugin's audio ports via the AudioPorts extension.
pub fn get_config_from_ports(handle: &mut PluginMainThreadHandle, is_input: bool) -> PluginAudioPortsConfig {
    let Some(ports) = handle.get_extension::<PluginAudioPorts>() else {
        return PluginAudioPortsConfig::default_stereo();
    };

    let mut buf = AudioPortInfoBuffer::new();
    let mut main_port_index = None;
    let mut discovered = vec![];

    for i in 0..ports.count(handle, is_input) {
        let Some(info) = ports.get(handle, i, is_input, &mut buf) else {
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

        if info.flags.contains(AudioPortFlags::IS_MAIN) {
            if main_port_index.replace(i).is_some() {
                eprintln!("Warning: plugin defines multiple main ports");
            }
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
            eprintln!("Warning: plugin reports no output ports; using default stereo");
            PluginAudioPortsConfig::default_stereo()
        };
    }

    let idx = main_port_index.unwrap_or(0);
    PluginAudioPortsConfig {
        main_port_index: idx,
        ports: discovered,
    }
}
