//! clap-test-effect — 最小 CLAP effect plugin（γ-effects 検証用、Issue #340）。
//!
//! ## 動作
//! ステレオ audio 入力に固定 gain（[`EFFECT_GAIN`] = 0.5）を乗算して output に書く。
//! `process()` は RT-safe（アロケーション・ロック・syscall なし）。
//!
//! ## Audio ポート構成
//! - 入力: stereo 1 ポート（IS_MAIN、id 1）
//! - 出力: stereo 1 ポート（IS_MAIN、id 2）
//!
//! ## CLAP ID
//! `com.signalcompose.clap-test-effect`

use clack_extensions::audio_ports::{
    AudioPortFlags, AudioPortInfo, AudioPortInfoWriter, AudioPortType, PluginAudioPorts,
    PluginAudioPortsImpl,
};
use clack_extensions::state::{PluginState, PluginStateImpl};
use clack_plugin::prelude::*;
use clack_plugin::stream::{InputStream, OutputStream};
use std::io::{Read as _, Write as _};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

// ──────────────────────────────────────────────────────────
// 固定ゲイン定数
// ──────────────────────────────────────────────────────────

/// process() が入力サンプルに乗算する固定 gain 値。
///
/// host 側テストはこの値を期待値計算に使う:
/// `expected_out[i] = input[i] * EFFECT_GAIN`
pub const EFFECT_GAIN: f32 = 0.5;
pub const STATE_MAGIC: u32 = 0x4F52_4531; // "ORE1"
pub const STATE_LEN: usize = 12;

pub fn encode_state(gain: f64) -> [u8; STATE_LEN] {
    let mut bytes = [0u8; STATE_LEN];
    bytes[..4].copy_from_slice(&STATE_MAGIC.to_le_bytes());
    bytes[4..].copy_from_slice(&gain.to_bits().to_le_bytes());
    bytes
}

pub fn decode_state(bytes: &[u8]) -> Option<f64> {
    if bytes.len() != STATE_LEN {
        return None;
    }
    let magic = u32::from_le_bytes(bytes[..4].try_into().ok()?);
    if magic != STATE_MAGIC {
        return None;
    }
    let gain = f64::from_bits(u64::from_le_bytes(bytes[4..].try_into().ok()?));
    gain.is_finite().then_some(gain)
}

// ──────────────────────────────────────────────────────────
// Top-level plugin 型
// ──────────────────────────────────────────────────────────

pub struct TestEffect;

impl Plugin for TestEffect {
    type AudioProcessor<'a> = TestEffectAudioProcessor;
    type Shared<'a> = TestEffectShared;
    type MainThread<'a> = TestEffectMainThread;

    fn declare_extensions(
        builder: &mut PluginExtensions<Self>,
        _shared: Option<&TestEffectShared>,
    ) {
        builder
            .register::<PluginAudioPorts>()
            .register::<PluginState>();
    }
}

impl DefaultPluginFactory for TestEffect {
    fn get_descriptor() -> PluginDescriptor {
        use clack_plugin::plugin::features::*;
        PluginDescriptor::new("com.signalcompose.clap-test-effect", "CLAP Test Effect")
            .with_features([AUDIO_EFFECT, STEREO])
    }

    fn new_shared(_host: HostSharedHandle<'_>) -> Result<Self::Shared<'_>, PluginError> {
        Ok(TestEffectShared {
            gain: Arc::new(AtomicU64::new((EFFECT_GAIN as f64).to_bits())),
        })
    }

    fn new_main_thread<'a>(
        _host: HostMainThreadHandle<'a>,
        shared: &'a Self::Shared<'a>,
    ) -> Result<Self::MainThread<'a>, PluginError> {
        Ok(TestEffectMainThread {
            gain: Arc::clone(&shared.gain),
        })
    }
}

// ──────────────────────────────────────────────────────────
// Shared state（任意スレッドからアクセス）
// ──────────────────────────────────────────────────────────

pub struct TestEffectShared {
    gain: Arc<AtomicU64>,
}

impl PluginShared<'_> for TestEffectShared {}

// ──────────────────────────────────────────────────────────
// Main-thread データ
// ──────────────────────────────────────────────────────────

pub struct TestEffectMainThread {
    gain: Arc<AtomicU64>,
}

impl PluginMainThread<'_, TestEffectShared> for TestEffectMainThread {}

impl PluginStateImpl for TestEffectMainThread {
    fn save(&mut self, output: &mut OutputStream) -> Result<(), PluginError> {
        if std::env::var_os("CLAP_TEST_EFFECT_EMPTY_STATE").is_some() {
            return Ok(());
        }
        let bytes = encode_state(f64::from_bits(self.gain.load(Ordering::Relaxed)));
        output
            .write_all(&bytes)
            .map_err(|_| PluginError::Message("clap-test-effect: failed to write state"))
    }

    fn load(&mut self, input: &mut InputStream) -> Result<(), PluginError> {
        let mut bytes = Vec::new();
        input
            .read_to_end(&mut bytes)
            .map_err(|_| PluginError::Message("clap-test-effect: failed to read state"))?;
        let Some(gain) = decode_state(&bytes) else {
            return Err(PluginError::Message(
                "clap-test-effect: invalid ORE1 state payload",
            ));
        };
        self.gain.store(gain.to_bits(), Ordering::Relaxed);
        Ok(())
    }
}

// Audio-ports extension（main thread）
impl PluginAudioPortsImpl for TestEffectMainThread {
    fn count(&mut self, _is_input: bool) -> u32 {
        // effect: 入力 1 ポート・出力 1 ポート（どちらも同数）
        1
    }

    fn get(&mut self, index: u32, is_input: bool, writer: &mut AudioPortInfoWriter) {
        if index == 0 {
            // 入力ポートは id 1、出力ポートは id 2 で区別する
            let id = if is_input { 1 } else { 2 };
            writer.set(&AudioPortInfo {
                id: ClapId::new(id),
                name: b"main",
                channel_count: 2,
                flags: AudioPortFlags::IS_MAIN,
                port_type: Some(AudioPortType::STEREO),
                in_place_pair: None,
            });
        }
    }
}

// ──────────────────────────────────────────────────────────
// Audio processor（audio thread）
// ──────────────────────────────────────────────────────────

/// audio thread で動作する effect プロセッサ。
pub struct TestEffectAudioProcessor {
    gain: Arc<AtomicU64>,
}

impl<'a> PluginAudioProcessor<'a, TestEffectShared, TestEffectMainThread>
    for TestEffectAudioProcessor
{
    fn activate(
        _host: HostAudioProcessorHandle<'a>,
        _main_thread: &mut TestEffectMainThread,
        shared: &'a TestEffectShared,
        _audio_config: PluginAudioConfiguration,
    ) -> Result<Self, PluginError> {
        Ok(Self {
            gain: Arc::clone(&shared.gain),
        })
    }

    /// 入力サンプルに EFFECT_GAIN を乗算して出力に書く。
    ///
    /// `port_pair(0)` で入力と出力を同時に取得し、`ChannelPair` バリアントで
    /// separate（InputOutput）と in-place（InPlace）の両方を処理する。
    /// RT-safe: アロケーション・ロック・syscall なし。
    fn process(
        &mut self,
        _process: Process,
        mut audio: Audio,
        _events: Events,
    ) -> Result<ProcessStatus, PluginError> {
        // port_pair(0) で入力/出力を同時に借用し、ChannelPair 経由で変換
        let mut port_pair = audio
            .port_pair(0)
            .ok_or(PluginError::Message("入力/出力ポートが見つかりません"))?;

        let channel_pairs = port_pair
            .channels()?
            .into_f32()
            .ok_or(PluginError::Message("f32 バッファが必要です"))?;

        let gain = f64::from_bits(self.gain.load(Ordering::Relaxed)) as f32;
        for channel_pair in channel_pairs {
            match channel_pair {
                // 入力のみ（対応する出力なし）: 何もしない
                ChannelPair::InputOnly(_) => {}
                // 出力のみ（入力なし）: 無音を書く
                ChannelPair::OutputOnly(buf) => buf.fill(0.0),
                // 入力と出力が別バッファ: gain を乗算してコピー
                ChannelPair::InputOutput(input, output) => {
                    for (i, o) in input.iter().zip(output) {
                        *o = i * gain;
                    }
                }
                // in-place（host が同一バッファを再利用）: そのまま gain を乗算
                ChannelPair::InPlace(buf) => {
                    for sample in buf {
                        *sample *= gain;
                    }
                }
            }
        }

        Ok(ProcessStatus::Continue)
    }
}

// ──────────────────────────────────────────────────────────
// エントリポイント — `clap_entry` シンボルをエクスポート
// ──────────────────────────────────────────────────────────

clack_export_entry!(SinglePluginEntry<TestEffect>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effect_state_encoding_round_trips_and_rejects_corruption() {
        let bytes = encode_state(0.25);
        assert_eq!(decode_state(&bytes), Some(0.25));
        let mut wrong_magic = bytes;
        wrong_magic[0] ^= 0xFF;
        assert_eq!(decode_state(&wrong_magic), None);
        assert_eq!(decode_state(&bytes[..STATE_LEN - 1]), None);
        assert_eq!(decode_state(&encode_state(f64::INFINITY)), None);
    }

    #[test]
    fn effect_state_encoding_matches_cross_format_contract() {
        assert_eq!(STATE_MAGIC, 0x4F52_4531);
        assert_eq!(STATE_LEN, 12);
        assert_eq!(
            encode_state(0.25),
            [0x31, 0x45, 0x52, 0x4F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xD0, 0x3F,]
        );
    }
}
