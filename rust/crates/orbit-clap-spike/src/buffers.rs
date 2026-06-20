//! Plugin audio buffer management (A0 §4.1).
//!
//! Ported from clack cpal example `host/audio/buffers.rs`.
//! Key difference from example: `add_to_cpal_buffer` no longer overwrites --
//! it ADD-mixes into the destination (A0 §4.1 step d: plugin_out + data).
//! PostMixSink sees the fully-summed signal (engine + plugin).
//!
//! RT assumption: audio port channel count is stable for the host's lifetime (port
//! rescan is not supported — `host.rs` returns false). Under that assumption
//! `prepare_plugin_buffers` reuses pre-allocated buffers with no RT alloc.

use crate::audio::AudioThreadStats;
use crate::config::FullAudioConfig;
use clack_host::prelude::{
    AudioPortBuffer, AudioPortBufferType, AudioPorts, InputAudioBuffers, InputChannel,
    OutputAudioBuffers,
};

use std::sync::atomic::Ordering;
use std::sync::Arc;

/// All audio buffers for the host<->plugin boundary.
pub struct HostAudioBuffers {
    config: FullAudioConfig,

    input_ports: AudioPorts,
    output_ports: AudioPorts,

    /// Planar buffers for each input port (all channels concatenated).
    input_port_channels: Box<[Vec<f32>]>,
    /// Planar buffers for each output port (all channels concatenated).
    output_port_channels: Box<[Vec<f32>]>,

    /// Working scratch for mux/downmix before adding to destination.
    muxed: Vec<f32>,

    /// Current allocated frame count (may be enlarged if cpal exceeds max).
    actual_frame_count: usize,

    /// Shared stats; resize events are counted atomically here (no local field).
    stats: Arc<AudioThreadStats>,
}

impl HostAudioBuffers {
    pub fn from_config(config: FullAudioConfig, stats: Arc<AudioThreadStats>) -> Self {
        let frame_count = config.max_likely_buffer_size as usize;

        let input_port_channels: Box<[Vec<f32>]> = config
            .plugin_input_port_config
            .ports
            .iter()
            .map(|p| vec![0.0f32; frame_count * p.port_layout.channel_count() as usize])
            .collect();

        let output_port_channels: Box<[Vec<f32>]> = config
            .plugin_output_port_config
            .ports
            .iter()
            .map(|p| vec![0.0f32; frame_count * p.port_layout.channel_count() as usize])
            .collect();

        let total_in = config
            .plugin_input_port_config
            .ports
            .iter()
            .map(|p| p.port_layout.channel_count() as usize)
            .sum();
        let total_out = config
            .plugin_output_port_config
            .ports
            .iter()
            .map(|p| p.port_layout.channel_count() as usize)
            .sum();

        Self {
            input_ports: AudioPorts::with_capacity(total_in, config.plugin_input_port_config.ports.len()),
            output_ports: AudioPorts::with_capacity(total_out, config.plugin_output_port_config.ports.len()),
            input_port_channels,
            output_port_channels,
            muxed: vec![0.0f32; frame_count * config.output_channel_count],
            actual_frame_count: frame_count,
            stats,
            config,
        }
    }

    /// Ensure internal buffers are large enough for the given CPAL buffer length.
    ///
    /// With `BufferSize::Fixed` (A0 §5) this should never trigger. If it does,
    /// `stats.buffer_resize_count` is incremented so the parent can report it.
    pub fn ensure_buffer_size_matches(&mut self, cpal_buffer_len: usize) {
        let frames = self.cpal_buf_len_to_frame_count(cpal_buffer_len);
        if frames > self.actual_frame_count {
            // RT-safe only when buffer size is stable (BufferSize::Fixed, A0 §5): the
            // resize/eprintln below are themselves RT violations and fire ONLY if cpal
            // breaks the fixed-size contract. The atomic counter (RT-safe) always records
            // it; the eprintln is debug-only to keep the syscall out of release builds.
            self.stats.buffer_resize_count.fetch_add(1, Ordering::Relaxed);
            #[cfg(debug_assertions)]
            eprintln!(
                "[orbit-clap-spike] WARN: buffer resize ({} -> {} frames) -- indicates BufferSize::Fixed did not hold",
                self.actual_frame_count, frames,
            );
            self.actual_frame_count = frames;

            for (buf, port) in self
                .input_port_channels
                .iter_mut()
                .zip(&self.config.plugin_input_port_config.ports)
            {
                buf.resize(frames * port.port_layout.channel_count() as usize, 0.0);
            }
            for (buf, port) in self
                .output_port_channels
                .iter_mut()
                .zip(&self.config.plugin_output_port_config.ports)
            {
                buf.resize(frames * port.port_layout.channel_count() as usize, 0.0);
            }
            self.muxed
                .resize(frames * self.config.output_channel_count, 0.0);
        }
    }

    pub fn cpal_buf_len_to_frame_count(&self, len: usize) -> usize {
        len / self.config.output_channel_count
    }

    /// Prepare plugin input/output buffers and return references suitable for `process()`.
    pub fn prepare_plugin_buffers(
        &mut self,
        cpal_buf_len: usize,
    ) -> (InputAudioBuffers<'_>, OutputAudioBuffers<'_>) {
        let sample_count = self.cpal_buf_len_to_frame_count(cpal_buf_len);
        assert!(sample_count <= self.actual_frame_count);

        // Zero plugin buffers
        self.output_port_channels
            .iter_mut()
            .for_each(|b| b.fill(0.0));
        self.input_port_channels
            .iter_mut()
            .for_each(|b| b.fill(0.0));

        (
            self.input_ports
                .with_input_buffers(self.input_port_channels.iter_mut().map(|port_buf| {
                    AudioPortBuffer {
                        latency: 0,
                        channels: AudioPortBufferType::f32_input_only(
                            port_buf
                                .chunks_exact_mut(self.actual_frame_count)
                                .map(|buffer| InputChannel {
                                    buffer: &mut buffer[..sample_count],
                                    is_constant: true,
                                }),
                        ),
                    }
                })),
            self.output_ports
                .with_output_buffers(self.output_port_channels.iter_mut().map(|port_buf| {
                    AudioPortBuffer {
                        latency: 0,
                        channels: AudioPortBufferType::f32_output_only(
                            port_buf
                                .chunks_exact_mut(self.actual_frame_count)
                                .map(|buf| &mut buf[..sample_count]),
                        ),
                    }
                })),
        )
    }

    /// Add-mix (+=) the plugin main output port into `destination` (interleaved f32).
    ///
    /// A0 §4.1 step d: plugin_out added to data (not overwrite).
    /// `destination` already contains the engine render output; plugin is summed on top.
    pub fn add_to_cpal_buffer(&mut self, destination: &mut [f32]) {
        let main_output = &self.output_port_channels
            [self.config.plugin_output_port_config.main_port_index as usize];

        let frame_count = self.cpal_buf_len_to_frame_count(destination.len());
        let muxed = &mut self.muxed[..destination.len()];

        let plugin_ch = self
            .config
            .plugin_output_port_config
            .main_port()
            .port_layout
            .channel_count();

        let out_ch = self.config.output_channel_count;

        match (plugin_ch as usize, out_ch) {
            (1, 1) => {
                // mono -> mono
                muxed.copy_from_slice(&main_output[..frame_count]);
            }
            (1, 2) => {
                // mono -> stereo: duplicate
                for i in 0..frame_count {
                    muxed[i * 2] = main_output[i];
                    muxed[i * 2 + 1] = main_output[i];
                }
            }
            (n, 1) => {
                // multi -> mono: mix down
                for i in 0..frame_count {
                    let mut s = 0.0f32;
                    for ch in 0..n {
                        s += main_output[ch * self.actual_frame_count + i];
                    }
                    muxed[i] = s / n as f32;
                }
            }
            (_, 2) => {
                // stereo (or more) -> stereo: interleave first two channels
                for i in 0..frame_count {
                    muxed[i * 2] = main_output[i]; // ch0
                    muxed[i * 2 + 1] = if main_output.len() > self.actual_frame_count {
                        main_output[self.actual_frame_count + i] // ch1
                    } else {
                        main_output[i] // mono -> duplicate
                    };
                }
            }
            _ => {
                // Unreachable today (config.rs filters output to 1/2 ch). Defensive: zero
                // `muxed` so a future channel-count change cannot add-mix stale data.
                muxed.fill(0.0);
                #[cfg(debug_assertions)]
                eprintln!(
                    "[orbit-clap-spike] WARN: unhandled channel layout plugin_ch={plugin_ch} out_ch={out_ch}; plugin mix skipped"
                );
            }
        }

        // Add-mix (A0 §4.1): do NOT overwrite engine contribution already in `destination`.
        for (dst, &src) in destination.iter_mut().zip(muxed.iter()) {
            *dst += src;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AudioPortLayout, PluginAudioPortInfo, PluginAudioPortsConfig};

    fn stereo_config(frames: u32) -> FullAudioConfig {
        let out = PluginAudioPortsConfig {
            main_port_index: 0,
            ports: vec![PluginAudioPortInfo {
                _id: None,
                port_layout: AudioPortLayout::Stereo,
                name: "out".into(),
            }],
        };
        FullAudioConfig {
            plugin_output_port_config: out,
            plugin_input_port_config: PluginAudioPortsConfig {
                main_port_index: 0,
                ports: vec![],
            },
            output_channel_count: 2,
            min_buffer_size: frames,
            max_likely_buffer_size: frames,
            sample_rate: 48_000,
        }
    }

    #[test]
    fn add_to_cpal_buffer_sums_instead_of_overwriting() {
        // Core A0 §4.1 step (d) invariant: plugin output is ADDED to the engine's, not
        // overwritten. A future change that overwrites would silently drop the engine.
        let stats = AudioThreadStats::new();
        let mut buffers = HostAudioBuffers::from_config(stereo_config(4), stats);

        // Plugin output: planar [ch0 frames .. ch1 frames], all 0.5.
        for v in buffers.output_port_channels[0].iter_mut() {
            *v = 0.5;
        }

        // Engine already wrote 1.0 (2 frames interleaved stereo = 4 samples).
        let mut dest = vec![1.0f32; 4];
        buffers.add_to_cpal_buffer(&mut dest);

        for &s in &dest {
            assert!((s - 1.5).abs() < 1e-6, "expected add-mix 1.5, got {s}");
        }
    }
}
