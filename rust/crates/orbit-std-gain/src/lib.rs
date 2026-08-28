//! `Gain` — OrbitScore の標準プラグイン初号（spec SC.10.8）。
//!
//! ## 位置づけ
//!
//! 標準プラグインは **engine に DSP を抱えない**という確定原則に沿って、**普通の CLAP
//! プラグイン**として実装される。rack child から見れば**カタログのプラグインと同じ 1 stage**
//! であり、特別な処理経路を持たない。
//!
//! カタログのプラグインとの違いは 3 点だけ:
//!
//! 1. **アプリに同梱される**（child 実行ファイルの隣の `std-plugins/Gain.clap`）。
//!    OS のプラグインディレクトリには何も置かない。
//! 2. **UI を持たない**（`gui` 拡張を宣言しない）。
//! 3. **state ファイルを持たない**（`state` 拡張を宣言しない）。パラメータの真実は DSL 側にあり、
//!    crash respawn 後は daemon の `ChainConfig` が保持する最新値で復元される。
//!
//! ## 🔴 DSL との契約
//!
//! **CLAP param 名 = DSL の名前付き引数名**（SC.10.8 規範 5-6）。`Gain(db: -6)` と書いたときの
//! `db` が、そのまま CLAP param `db` へ写る。両端とも 1st-party なのでこの契約が成立する。
//! 破ると DSL から値が届かなくなるが、**型エラーにはならず無言で効かなくなる**ため、
//! [`tests::param_name_matches_the_dsl_argument`] が名前そのものを固定している。

use clack_extensions::audio_ports::{
    AudioPortFlags, AudioPortInfo, AudioPortInfoWriter, AudioPortType, PluginAudioPorts,
    PluginAudioPortsImpl,
};
use clack_extensions::params::{
    ParamDisplayWriter, ParamInfo, ParamInfoFlags, ParamInfoWriter, PluginAudioProcessorParams,
    PluginMainThreadParams, PluginParams,
};
use clack_plugin::events::event_types::ParamValueEvent;
use clack_plugin::events::io::{InputEvents, OutputEvents};
use clack_plugin::prelude::*;
use core::fmt::Write as _;
use std::ffi::CStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

// ──────────────────────────────────────────────────────────
// プラグインの同一性とパラメータ定義（DSL との契約面）
// ──────────────────────────────────────────────────────────

/// CLAP プラグイン ID。daemon / TS はこの ID ではなく**記号名**でこのプラグインを指すが
/// （`{kind:"standard", name:"Gain"}`）、bundle の Info.plist と揃える必要がある。
pub const PLUGIN_ID: &str = "com.signalcompose.orbit-std-gain";

/// DSL 表面の名前。`Gain(db: -6)` の `Gain`、および同梱ファイル名 `std-plugins/Gain.clap`。
pub const PLUGIN_NAME: &str = "Gain";

/// 🔴 `db` パラメータの CLAP 名。**DSL の名前付き引数名と一字一句一致していなければならない。**
pub const PARAM_DB_NAME: &[u8] = b"db";

/// `db` パラメータの CLAP id。
pub const PARAM_DB_ID: u32 = 0;

/// `db` の下限。この値以下は完全な無音として扱う（-96 dB ≒ 16bit の量子化下限）。
pub const DB_MIN: f64 = -96.0;

/// `db` の上限。ライブ中の事故を防ぐため +24 dB で頭打ちにする。
pub const DB_MAX: f64 = 24.0;

/// `db` の既定値。`Gain()` と引数なしで書いたときの値 = 素通し。
pub const DB_DEFAULT: f64 = 0.0;

/// dB 値を線形ゲイン係数へ変換する。
///
/// `DB_MIN` 以下は **完全な 0.0**（-96 dB の残響が残らないように）。範囲外は飽和させる。
pub fn db_to_linear(db: f64) -> f32 {
    if !db.is_finite() {
        return 1.0;
    }
    let clamped = clamp_db(db);
    if clamped <= DB_MIN {
        return 0.0;
    }
    10f64.powf(clamped / 20.0) as f32
}

/// dB 値を受理範囲へ丸める。NaN は既定値へ倒す（RT スレッドで判断を残さないため）。
pub fn clamp_db(db: f64) -> f64 {
    if db.is_nan() {
        return DB_DEFAULT;
    }
    db.clamp(DB_MIN, DB_MAX)
}

// ──────────────────────────────────────────────────────────
// プラグイン本体
// ──────────────────────────────────────────────────────────

pub struct StdGain;

impl Plugin for StdGain {
    type AudioProcessor<'a> = StdGainAudioProcessor;
    type Shared<'a> = StdGainShared;
    type MainThread<'a> = StdGainMainThread;

    fn declare_extensions(builder: &mut PluginExtensions<Self>, _shared: Option<&StdGainShared>) {
        // 🔴 `gui` も `state` も宣言しない — 標準プラグインは UI も state も持たない（SC.10.8）。
        builder
            .register::<PluginAudioPorts>()
            .register::<PluginParams>();
    }
}

impl DefaultPluginFactory for StdGain {
    fn get_descriptor() -> PluginDescriptor {
        use clack_plugin::plugin::features::*;
        PluginDescriptor::new(PLUGIN_ID, PLUGIN_NAME).with_features([AUDIO_EFFECT, UTILITY, STEREO])
    }

    fn new_shared(_host: HostSharedHandle<'_>) -> Result<Self::Shared<'_>, PluginError> {
        Ok(StdGainShared {
            db: Arc::new(AtomicU64::new(DB_DEFAULT.to_bits())),
        })
    }

    fn new_main_thread<'a>(
        _host: HostMainThreadHandle<'a>,
        shared: &'a Self::Shared<'a>,
    ) -> Result<Self::MainThread<'a>, PluginError> {
        Ok(StdGainMainThread {
            db: Arc::clone(&shared.db),
        })
    }
}

/// 全スレッドから読める現在の dB 値。f64 のビット表現を atomic に持つ
/// （RT スレッドがロックを取らずに読めるようにするため）。
pub struct StdGainShared {
    db: Arc<AtomicU64>,
}

impl PluginShared<'_> for StdGainShared {}

pub struct StdGainMainThread {
    db: Arc<AtomicU64>,
}

impl PluginMainThread<'_, StdGainShared> for StdGainMainThread {}

// ──────────────────────────────────────────────────────────
// audio ports — stereo in / stereo out
// ──────────────────────────────────────────────────────────

impl PluginAudioPortsImpl for StdGainMainThread {
    fn count(&mut self, _is_input: bool) -> u32 {
        1
    }

    fn get(&mut self, index: u32, is_input: bool, writer: &mut AudioPortInfoWriter) {
        if index != 0 {
            return;
        }
        // 入力ポートは id 1、出力ポートは id 2（clap-test-effect と同じ規約）
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

// ──────────────────────────────────────────────────────────
// params
// ──────────────────────────────────────────────────────────

/// パラメータ変更イベントを読んで共有 dB 値へ反映する。
///
/// audio thread と main thread の両方の `flush` から呼ばれるため、共通の関数にしてある
/// （どちらか一方にしか適用しないと、演奏中と停止中で挙動が食い違う）。
fn apply_param_events(db: &AtomicU64, events: &InputEvents) {
    for event in events {
        let Some(value_event) = event.as_event::<ParamValueEvent>() else {
            continue;
        };
        if value_event.param_id().map(ClapId::get) != Some(PARAM_DB_ID) {
            continue;
        }
        db.store(clamp_db(value_event.value()).to_bits(), Ordering::Relaxed);
    }
}

impl PluginMainThreadParams for StdGainMainThread {
    fn count(&mut self) -> u32 {
        1
    }

    fn get_info(&mut self, param_index: u32, info: &mut ParamInfoWriter) {
        if param_index != 0 {
            return;
        }
        info.set(&ParamInfo {
            id: ClapId::new(PARAM_DB_ID),
            flags: ParamInfoFlags::IS_AUTOMATABLE,
            cookie: Default::default(),
            name: PARAM_DB_NAME,
            module: b"",
            min_value: DB_MIN,
            max_value: DB_MAX,
            default_value: DB_DEFAULT,
        });
    }

    fn get_value(&mut self, param_id: ClapId) -> Option<f64> {
        (param_id.get() == PARAM_DB_ID).then(|| f64::from_bits(self.db.load(Ordering::Relaxed)))
    }

    fn value_to_text(
        &mut self,
        param_id: ClapId,
        value: f64,
        writer: &mut ParamDisplayWriter,
    ) -> core::fmt::Result {
        if param_id.get() != PARAM_DB_ID {
            return Err(core::fmt::Error);
        }
        write!(writer, "{:.2} dB", clamp_db(value))
    }

    fn text_to_value(&mut self, param_id: ClapId, text: &CStr) -> Option<f64> {
        if param_id.get() != PARAM_DB_ID {
            return None;
        }
        let text = text.to_str().ok()?;
        // "-6", "-6 dB", "-6dB" のいずれも受ける
        let trimmed = text
            .trim()
            .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace());
        trimmed.trim().parse::<f64>().ok().map(clamp_db)
    }

    fn flush(&mut self, input_parameter_changes: &InputEvents, _out: &mut OutputEvents) {
        apply_param_events(&self.db, input_parameter_changes);
    }
}

impl PluginAudioProcessorParams for StdGainAudioProcessor {
    fn flush(&mut self, input_parameter_changes: &InputEvents, _out: &mut OutputEvents) {
        apply_param_events(&self.db, input_parameter_changes);
    }
}

// ──────────────────────────────────────────────────────────
// audio processor
// ──────────────────────────────────────────────────────────

pub struct StdGainAudioProcessor {
    db: Arc<AtomicU64>,
}

impl<'a> PluginAudioProcessor<'a, StdGainShared, StdGainMainThread> for StdGainAudioProcessor {
    fn activate(
        _host: HostAudioProcessorHandle<'a>,
        _main_thread: &mut StdGainMainThread,
        shared: &'a StdGainShared,
        _audio_config: PluginAudioConfiguration,
    ) -> Result<Self, PluginError> {
        Ok(Self {
            db: Arc::clone(&shared.db),
        })
    }

    /// 入力に現在の gain を乗算して出力へ書く。RT-safe（確保・ロック・syscall なし）。
    ///
    /// パラメータ変更はブロック先頭でまとめて適用する。サンプル精度の自動化は v1 の範囲外
    /// （`Gain` はライブの手動操作用であり、#460 のオートメーションが入るまで必要にならない）。
    fn process(
        &mut self,
        _process: Process,
        mut audio: Audio,
        events: Events,
    ) -> Result<ProcessStatus, PluginError> {
        apply_param_events(&self.db, events.input);

        let gain = db_to_linear(f64::from_bits(self.db.load(Ordering::Relaxed)));

        let mut port_pair = audio
            .port_pair(0)
            .ok_or(PluginError::Message("Gain: audio port pair 0 が無い"))?;
        let channel_pairs = port_pair
            .channels()?
            .into_f32()
            .ok_or(PluginError::Message("Gain: f32 バッファが必要"))?;

        for channel_pair in channel_pairs {
            match channel_pair {
                ChannelPair::InputOnly(_) => {}
                ChannelPair::OutputOnly(buf) => buf.fill(0.0),
                ChannelPair::InputOutput(input, output) => {
                    for (i, o) in input.iter().zip(output) {
                        *o = i * gain;
                    }
                }
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

clack_export_entry!(SinglePluginEntry<StdGain>);

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 DSL との契約そのもの。`Gain(db: -6)` の引数名がこの定数と一致していないと、
    /// **型エラーにならないまま値が届かなくなる**（SC.10.8 規範 5-6）。
    /// ホスト側から列挙して確かめる版は `tests/contract.rs` にある。
    #[test]
    fn param_name_matches_the_dsl_argument() {
        assert_eq!(PARAM_DB_NAME, b"db");
    }

    #[test]
    fn zero_db_passes_the_signal_through_unchanged() {
        assert_eq!(db_to_linear(0.0), 1.0);
    }

    #[test]
    fn minus_six_db_halves_the_amplitude() {
        // -6.0206 dB がちょうど 1/2。-6 dB はその近傍。
        let g = db_to_linear(-6.0);
        assert!(
            (g - 0.5011872).abs() < 1e-6,
            "-6 dB should be ≈0.50119, got {g}"
        );
    }

    #[test]
    fn positive_db_amplifies() {
        let g = db_to_linear(6.0);
        assert!(
            (g - 1.9952624).abs() < 1e-6,
            "+6 dB should be ≈1.9953, got {g}"
        );
    }

    /// 下限は**完全な 0.0** にする。-96 dB 相当の微小な残響が残ると、
    /// 「無音にした」つもりの stage から音が漏れる。
    #[test]
    fn the_floor_is_exact_silence_not_merely_quiet() {
        assert_eq!(db_to_linear(DB_MIN), 0.0);
        assert_eq!(db_to_linear(DB_MIN - 10.0), 0.0);
    }

    #[test]
    fn out_of_range_values_saturate_instead_of_exploding() {
        assert_eq!(db_to_linear(1000.0), db_to_linear(DB_MAX));
        assert_eq!(clamp_db(1000.0), DB_MAX);
        assert_eq!(clamp_db(-1000.0), DB_MIN);
    }

    /// RT スレッドで NaN の判断を残さないため、非有限値は手前で潰す。
    #[test]
    fn non_finite_values_never_reach_the_multiply() {
        assert_eq!(clamp_db(f64::NAN), DB_DEFAULT);
        assert_eq!(db_to_linear(f64::NAN), 1.0);
        assert_eq!(db_to_linear(f64::INFINITY), 1.0);
        assert_eq!(db_to_linear(f64::NEG_INFINITY), 1.0);
    }

    #[test]
    fn db_is_monotonic_across_the_range() {
        let mut prev = db_to_linear(DB_MIN);
        for step in 1..=120 {
            let db = DB_MIN + step as f64;
            let g = db_to_linear(db);
            assert!(g >= prev, "gain decreased at {db} dB: {prev} -> {g}");
            prev = g;
        }
    }
}
