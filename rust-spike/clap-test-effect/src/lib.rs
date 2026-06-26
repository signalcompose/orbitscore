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
use clack_plugin::prelude::*;

// ──────────────────────────────────────────────────────────
// 固定ゲイン定数
// ──────────────────────────────────────────────────────────

/// process() が入力サンプルに乗算する固定 gain 値。
///
/// host 側テストはこの値を期待値計算に使う:
/// `expected_out[i] = input[i] * EFFECT_GAIN`
pub const EFFECT_GAIN: f32 = 0.5;

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
        // effect は audio ports のみ登録。note ports は不要
        builder.register::<PluginAudioPorts>();
    }
}

impl DefaultPluginFactory for TestEffect {
    fn get_descriptor() -> PluginDescriptor {
        use clack_plugin::plugin::features::*;
        PluginDescriptor::new("com.signalcompose.clap-test-effect", "CLAP Test Effect")
            .with_features([AUDIO_EFFECT, STEREO])
    }

    fn new_shared(_host: HostSharedHandle<'_>) -> Result<Self::Shared<'_>, PluginError> {
        Ok(TestEffectShared)
    }

    fn new_main_thread<'a>(
        _host: HostMainThreadHandle<'a>,
        _shared: &'a Self::Shared<'a>,
    ) -> Result<Self::MainThread<'a>, PluginError> {
        Ok(TestEffectMainThread)
    }
}

// ──────────────────────────────────────────────────────────
// Shared state（任意スレッドからアクセス）
// ──────────────────────────────────────────────────────────

/// effect plugin の共有状態。定数 gain を使うため内部状態なし。
pub struct TestEffectShared;

impl PluginShared<'_> for TestEffectShared {}

// ──────────────────────────────────────────────────────────
// Main-thread データ
// ──────────────────────────────────────────────────────────

pub struct TestEffectMainThread;

impl PluginMainThread<'_, TestEffectShared> for TestEffectMainThread {}

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
/// 定数 gain のみ適用するため内部状態なし。
pub struct TestEffectAudioProcessor;

impl<'a> PluginAudioProcessor<'a, TestEffectShared, TestEffectMainThread>
    for TestEffectAudioProcessor
{
    fn activate(
        _host: HostAudioProcessorHandle<'a>,
        _main_thread: &mut TestEffectMainThread,
        _shared: &'a TestEffectShared,
        _audio_config: PluginAudioConfiguration,
    ) -> Result<Self, PluginError> {
        Ok(Self)
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

        for channel_pair in channel_pairs {
            match channel_pair {
                // 入力のみ（対応する出力なし）: 何もしない
                ChannelPair::InputOnly(_) => {}
                // 出力のみ（入力なし）: 無音を書く
                ChannelPair::OutputOnly(buf) => buf.fill(0.0),
                // 入力と出力が別バッファ: gain を乗算してコピー
                ChannelPair::InputOutput(input, output) => {
                    for (i, o) in input.iter().zip(output) {
                        *o = i * EFFECT_GAIN;
                    }
                }
                // in-place（host が同一バッファを再利用）: そのまま gain を乗算
                ChannelPair::InPlace(buf) => {
                    for sample in buf {
                        *sample *= EFFECT_GAIN;
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
