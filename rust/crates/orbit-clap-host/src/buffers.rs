//! プラグインオーディオバッファ管理（A0 §4.1）。
//!
//! orbit-clap-spike の buffers.rs から移植。主な変更点:
//! - `Arc<AudioThreadStats>` → `Arc<AtomicU64>` (resize_count のみ) に差し替え。
//!   callback duration 統計は orbit-audio-native の CallbackTimeStats が担う（seam 分離）。
//! - add_to_cpal_buffer は overwrite ではなく add-mix (+=)（A0 §4.1 step d）。
//!
//! RT assumption: audio ポートのチャンネル数はホストのライフタイム中に変化しない
//! (port rescan 非対応)。その前提のもと `prepare_plugin_buffers` はバッファを再利用し
//! RT alloc なし。

use crate::config::FullAudioConfig;
use clack_host::prelude::{
    AudioPortBuffer, AudioPortBufferType, AudioPorts, InputAudioBuffers, InputChannel,
    OutputAudioBuffers,
};

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// ホスト ↔ プラグイン境界の全オーディオバッファ。
pub struct HostAudioBuffers {
    config: FullAudioConfig,

    input_ports: AudioPorts,
    output_ports: AudioPorts,

    /// 各入力ポートのプラナーバッファ（全チャンネル連結）。
    input_port_channels: Box<[Vec<f32>]>,
    /// 各出力ポートのプラナーバッファ（全チャンネル連結）。
    output_port_channels: Box<[Vec<f32>]>,

    /// add-mix 前の mux / downmix 作業バッファ。
    muxed: Vec<f32>,

    /// 現在のフレーム数（cpal が max を超えた場合のみ拡張）。
    actual_frame_count: usize,

    /// プラグインが audio 入力ポートを持つか（= effect 型・serial insert）。`false` なら
    /// instrument 型（add-mix）。`ClapPostProcessor` がこの値で effect / instrument 経路を分岐する
    /// （PR2・Issue #340）。
    has_audio_input: bool,

    /// バッファリサイズ回数（BufferSize::Fixed なら 0 のはず）。atomic で RT 安全に記録。
    resize_count: Arc<AtomicU64>,
}

impl HostAudioBuffers {
    /// `config` と `resize_count` から初期化する。
    /// `resize_count` は制御スレッドでも読めるよう Arc で共有する。
    pub fn from_config(config: FullAudioConfig, resize_count: Arc<AtomicU64>) -> Self {
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

        let total_in = config.plugin_input_port_config.total_channel_count();
        let total_out = config.plugin_output_port_config.total_channel_count();

        // audio 入力ポートが 1 つでもあれば effect 型（serial insert）。皆無なら instrument 型。
        let has_audio_input = total_in > 0;

        Self {
            input_ports: AudioPorts::with_capacity(
                total_in,
                config.plugin_input_port_config.ports.len(),
            ),
            output_ports: AudioPorts::with_capacity(
                total_out,
                config.plugin_output_port_config.ports.len(),
            ),
            input_port_channels,
            output_port_channels,
            muxed: vec![0.0f32; frame_count * config.output_channel_count],
            actual_frame_count: frame_count,
            has_audio_input,
            resize_count,
            config,
        }
    }

    /// プラグインが audio 入力を持つ（= effect / serial insert）か。`ClapPostProcessor` が
    /// この値で「入力に engine 出力を流す（effect）」か「入力を無音にする（instrument）」かを分岐する。
    pub fn has_audio_input(&self) -> bool {
        self.has_audio_input
    }

    /// 内部バッファが cpal バッファ長を収容できるか確認し、必要なら拡張する。
    ///
    /// `BufferSize::Fixed`（A0 §5）なら通常は発火しない。発火した場合は `resize_count` を
    /// increment して呼び出し元が検出できるようにする。
    pub fn ensure_buffer_size_matches(&mut self, cpal_buffer_len: usize) {
        let frames = self.cpal_buf_len_to_frame_count(cpal_buffer_len);
        if frames > self.actual_frame_count {
            // RT-safe なのは BufferSize::Fixed が守られている場合のみ。resize / eprintln は
            // 本来 RT 違反だが、Fixed 契約が破られた場合にのみ到達する（atomic counter は常に RT 安全）。
            self.resize_count.fetch_add(1, Ordering::Relaxed);
            #[cfg(debug_assertions)]
            eprintln!(
                "[orbit-clap-host] WARN: バッファリサイズ ({} -> {} frames) — BufferSize::Fixed が守られなかった",
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

    /// 全入力チャンネルをゼロにする（instrument モード: serial input なし）。
    ///
    /// `prepare_plugin_buffers` の前に呼ぶこと。instrument 型は入力を無音にして process する。
    pub fn set_input_silent(&mut self) {
        self.input_port_channels
            .iter_mut()
            .for_each(|b| b.fill(0.0));
    }

    /// engine の interleaved 出力 `source` を **メイン入力ポート**（planar）へ de-interleave コピーする
    /// （effect モード: serial insert の入力配線・A0 §4.1）。
    ///
    /// メイン以外の入力ポートはゼロにする。`prepare_plugin_buffers` の前に呼ぶこと。
    /// `output_channel_count`（engine 側）とメイン入力ポートのチャンネル数が異なる場合は
    /// `add_to_cpal_buffer` と対称な mux/downmix で対応付ける。
    pub fn set_input_from_interleaved(&mut self, source: &[f32]) {
        // 入力ポート無し（instrument 経路ではここに来ない想定だが防御的に）。
        if self.config.plugin_input_port_config.ports.is_empty() {
            return;
        }

        let frame_count = self.cpal_buf_len_to_frame_count(source.len());
        let afc = self.actual_frame_count;
        let out_ch = self.config.output_channel_count;
        let main_idx = self.config.plugin_input_port_config.main_port_index as usize;
        let in_ch = self
            .config
            .plugin_input_port_config
            .main_port()
            .port_layout
            .channel_count() as usize;

        // メイン以外の入力ポート（sidechain 等・稀）に無音を入れる。メインポートは下の match が
        // active 領域 [..frame_count] を全 ch 上書きするので事前ゼロ不要。tail [frame_count..afc] は
        // `prepare_plugin_buffers` が [..sample_count] で切るため plugin に渡らず、ゼロも不要
        // （RT スレッドの無駄な memset を避ける）。
        for (i, b) in self.input_port_channels.iter_mut().enumerate() {
            if i != main_idx {
                b.fill(0.0);
            }
        }

        let buf = &mut self.input_port_channels[main_idx];

        match (out_ch, in_ch) {
            (1, n) => {
                // mono source → 全入力チャンネルへ複製。
                for i in 0..frame_count {
                    let s = source[i];
                    for ch in 0..n {
                        buf[ch * afc + i] = s;
                    }
                }
            }
            (oc, 1) => {
                // multi source → mono 入力: ミックスダウン。
                for i in 0..frame_count {
                    let mut s = 0.0f32;
                    for c in 0..oc {
                        s += source[i * oc + c];
                    }
                    buf[i] = s / oc as f32;
                }
            }
            (oc, n) => {
                // multi → multi: ch を対応付け（余剰入力 ch は最後の source ch を複製）。
                for i in 0..frame_count {
                    for ch in 0..n {
                        let src_c = ch.min(oc - 1);
                        buf[ch * afc + i] = source[i * oc + src_c];
                    }
                }
            }
        }
    }

    /// プラグイン入出力バッファを準備して `process()` 用の参照を返す。
    ///
    /// 出力バッファのみゼロクリアする。入力は呼び出し側が `set_input_silent`（instrument）または
    /// `set_input_from_interleaved`（effect）で事前に充填する契約。`is_constant` は
    /// instrument（無音入力）のとき true、effect（実入力）のとき false。
    pub fn prepare_plugin_buffers(
        &mut self,
        cpal_buf_len: usize,
    ) -> (InputAudioBuffers<'_>, OutputAudioBuffers<'_>) {
        let sample_count = self.cpal_buf_len_to_frame_count(cpal_buf_len);
        assert!(sample_count <= self.actual_frame_count);

        // 出力バッファの active 領域のみゼロクリア（入力は caller が充填済み）。plugin が
        // [..sample_count] を書き、`fill_muxed_from_main_output` が [..frame_count(=sample_count)] を
        // 読むので、tail [sample_count..afc] は下流で読まれずゼロ不要（RT スレッドの無駄な memset を避ける）。
        let afc = self.actual_frame_count;
        for b in self.output_port_channels.iter_mut() {
            for chunk in b.chunks_exact_mut(afc) {
                chunk[..sample_count].fill(0.0);
            }
        }

        let input_is_constant = !self.has_audio_input;

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
                                    is_constant: input_is_constant,
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

    /// プラグインのメイン出力ポート（planar）を interleaved `muxed[..dest_len]` に mux/downmix する。
    ///
    /// `add_to_cpal_buffer`（instrument: add-mix）と `replace_cpal_buffer`（effect: overwrite）の
    /// 共通前処理。出力チャンネルレイアウトの対応付けはここに集約する。
    fn fill_muxed_from_main_output(&mut self, dest_len: usize) {
        let main_output = &self.output_port_channels
            [self.config.plugin_output_port_config.main_port_index as usize];

        let frame_count = self.cpal_buf_len_to_frame_count(dest_len);
        let muxed = &mut self.muxed[..dest_len];

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
                // mono -> stereo: 複製
                for i in 0..frame_count {
                    muxed[i * 2] = main_output[i];
                    muxed[i * 2 + 1] = main_output[i];
                }
            }
            (n, 1) => {
                // multi -> mono: ミックスダウン
                for i in 0..frame_count {
                    let mut s = 0.0f32;
                    for ch in 0..n {
                        s += main_output[ch * self.actual_frame_count + i];
                    }
                    muxed[i] = s / n as f32;
                }
            }
            (_, 2) => {
                // plugin_ch >= 2（mono→stereo は上の (1, 2) で処理済み）→ ch1 は常に存在。
                // 最初の 2 チャンネルを interleave。
                for i in 0..frame_count {
                    muxed[i * 2] = main_output[i]; // ch0
                    muxed[i * 2 + 1] = main_output[self.actual_frame_count + i];
                    // ch1
                }
            }
            _ => {
                // 今日は到達しない（config.rs は出力を 1/2ch にフィルタ）。
                // 防御的: muxed をゼロにして古いデータを混ぜない。
                muxed.fill(0.0);
                #[cfg(debug_assertions)]
                eprintln!(
                    "[orbit-clap-host] WARN: 未対応チャンネルレイアウト plugin_ch={plugin_ch} out_ch={out_ch}; plugin mix スキップ"
                );
            }
        }
    }

    /// プラグインのメイン出力ポートを `destination`（interleaved f32）に add-mix (+=) する。
    ///
    /// A0 §4.1 step d: plugin_out は data に加算（上書きではない）。instrument 型（parallel）用。
    /// `destination` には engine render 済みのデータが入っており、plugin 出力をその上に加算する。
    pub fn add_to_cpal_buffer(&mut self, destination: &mut [f32]) {
        self.fill_muxed_from_main_output(destination.len());
        // add-mix（A0 §4.1）: engine 出力を上書きしない。
        for (dst, &src) in destination.iter_mut().zip(self.muxed.iter()) {
            *dst += src;
        }
    }

    /// プラグインのメイン出力ポートで `destination`（interleaved f32）を **上書き** する。
    ///
    /// effect 型（serial insert）用: 入力は engine 出力（`set_input_from_interleaved` 経由）で、
    /// 出力がそれを置き換える。add-mix すると素の engine 出力が二重に残るため `=` で上書きする。
    pub fn replace_cpal_buffer(&mut self, destination: &mut [f32]) {
        self.fill_muxed_from_main_output(destination.len());
        for (dst, &src) in destination.iter_mut().zip(self.muxed.iter()) {
            *dst = src;
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

    /// stereo 入力 + stereo 出力（effect 型・serial insert）の config。
    fn effect_config(frames: u32) -> FullAudioConfig {
        let stereo = || PluginAudioPortsConfig {
            main_port_index: 0,
            ports: vec![PluginAudioPortInfo {
                _id: None,
                port_layout: AudioPortLayout::Stereo,
                name: "main".into(),
            }],
        };
        FullAudioConfig {
            plugin_output_port_config: stereo(),
            plugin_input_port_config: stereo(),
            output_channel_count: 2,
            min_buffer_size: frames,
            max_likely_buffer_size: frames,
            sample_rate: 48_000,
        }
    }

    #[test]
    fn add_to_cpal_buffer_sums_instead_of_overwriting() {
        // A0 §4.1 step (d) の不変条件: plugin 出力は engine 出力に加算（上書きしない）。
        // 上書きに変更されると engine 出力がサイレントに消える。
        let resize_count = Arc::new(AtomicU64::new(0));
        let mut buffers = HostAudioBuffers::from_config(stereo_config(4), resize_count);

        // Plugin 出力: planar [ch0 frames .. ch1 frames]、全て 0.5。
        for v in buffers.output_port_channels[0].iter_mut() {
            *v = 0.5;
        }

        // Engine が既に 1.0 を書き込んだ（2 frames interleaved stereo = 4 samples）。
        let mut dest = vec![1.0f32; 4];
        buffers.add_to_cpal_buffer(&mut dest);

        for &s in &dest {
            assert!((s - 1.5).abs() < 1e-6, "expected add-mix 1.5, got {s}");
        }
    }

    #[test]
    fn has_audio_input_distinguishes_effect_from_instrument() {
        let rc = Arc::new(AtomicU64::new(0));
        // 入力ポートなし = instrument。
        assert!(!HostAudioBuffers::from_config(stereo_config(4), rc.clone()).has_audio_input());
        // 入力ポートあり = effect。
        assert!(HostAudioBuffers::from_config(effect_config(4), rc).has_audio_input());
    }

    #[test]
    fn set_input_from_interleaved_de_interleaves_into_planar_main_port() {
        // effect 入力配線（PR2）: interleaved engine 出力を planar plugin 入力へ分配する。
        let rc = Arc::new(AtomicU64::new(0));
        let mut buffers = HostAudioBuffers::from_config(effect_config(4), rc);

        // engine 出力: 2 frames interleaved stereo = [L0,R0, L1,R1]。
        let source = [0.1f32, 0.2, 0.3, 0.4];
        buffers.set_input_from_interleaved(&source);

        // planar main 入力: [ch0(afc) .. ch1(afc)]。afc = max_likely_buffer_size = 4。
        let afc = buffers.actual_frame_count;
        let input = &buffers.input_port_channels[0];
        // ch0 (L): source[0], source[2]。
        assert!((input[0] - 0.1).abs() < 1e-6);
        assert!((input[1] - 0.3).abs() < 1e-6);
        // ch1 (R): source[1], source[3]。
        assert!((input[afc] - 0.2).abs() < 1e-6);
        assert!((input[afc + 1] - 0.4).abs() < 1e-6);
        // 未充填フレーム（frame 2,3）はゼロ。
        assert_eq!(input[2], 0.0);
        assert_eq!(input[afc + 2], 0.0);
    }

    #[test]
    fn replace_cpal_buffer_overwrites_instead_of_summing() {
        // effect 出力配線（PR2・serial insert）: plugin 出力で data を上書きする。
        // add-mix と違い、素の engine 出力は残らない。
        let rc = Arc::new(AtomicU64::new(0));
        let mut buffers = HostAudioBuffers::from_config(effect_config(4), rc);

        // plugin 出力: planar 全て 0.5。
        for v in buffers.output_port_channels[0].iter_mut() {
            *v = 0.5;
        }
        // engine が 1.0 を書いた data。replace なら 0.5 で上書きされる（1.5 にならない）。
        let mut dest = vec![1.0f32; 4];
        buffers.replace_cpal_buffer(&mut dest);

        for &s in &dest {
            assert!((s - 0.5).abs() < 1e-6, "expected overwrite 0.5, got {s}");
        }
    }
}
