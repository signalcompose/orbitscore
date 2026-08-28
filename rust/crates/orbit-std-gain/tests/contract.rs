//! `Gain` が DSL と daemon に対して負う契約を、実際にプラグインを起こして検証する。
//!
//! ここで守るのは spec SC.10.8 の 2 点:
//!
//! 1. **UI も state も持たない** — `gui` / `state` 拡張を一切公開しない。これが崩れると
//!    「標準プラグインへの UI open / state save は明示エラー」という daemon 側の規約が
//!    根拠を失う。
//! 2. **CLAP param 名 = DSL の名前付き引数名** — `Gain(db: -6)` の `db` がそのまま
//!    CLAP param `db` へ写る。崩れても**型エラーにならず無言で効かなくなる**ため、
//!    ホスト側から実際に列挙して名前を確認する。
//!
//! プラグインは `load_from_clack` で **in-process** に起こす（dylib を dlopen しないので
//! ビルド順に依存せず、`#[ignore]` も要らない）。

use clack_extensions::audio_ports::PluginAudioPorts;
use clack_extensions::gui::PluginGui;
use clack_extensions::params::{ParamInfoBuffer, PluginParams};
use clack_extensions::state::PluginState;
use clack_host::events::event_types::ParamValueEvent;
use clack_host::prelude::*;
use clack_host::utils::Cookie;
use orbit_std_gain::*;

// ──────────────────────────────────────────────────────────
// 検証専用の最小ホスト
// ──────────────────────────────────────────────────────────

struct TestHost;

impl HostHandlers for TestHost {
    type Shared<'a> = TestHostShared;
    type MainThread<'a> = TestHostMainThread<'a>;
    type AudioProcessor<'a> = ();

    fn declare_extensions(_builder: &mut HostExtensions<Self>, _shared: &Self::Shared<'_>) {
        // ホスト側の拡張は宣言しない。ここで見たいのは**プラグインが何を公開するか**だけ。
    }
}

struct TestHostShared;

impl SharedHandler<'_> for TestHostShared {
    fn request_restart(&self) {}
    fn request_process(&self) {}
    fn request_callback(&self) {}
}

struct TestHostMainThread<'a> {
    _plugin: Option<InitializedPluginHandle<'a>>,
}

impl<'a> MainThreadHandler<'a> for TestHostMainThread<'a> {
    fn initialized(&mut self, instance: InitializedPluginHandle<'a>) {
        self._plugin = Some(instance);
    }
}

/// `Gain` を in-process で起こす。
fn instantiate() -> PluginInstance<TestHost> {
    let entry = PluginEntry::load_from_clack::<clack_plugin::entry::SinglePluginEntry<StdGain>>(
        c"orbit-std-gain-test",
    )
    .expect("entry の初期化に失敗");

    let plugin_id = std::ffi::CString::new(PLUGIN_ID).unwrap();
    PluginInstance::<TestHost>::new(
        |_| TestHostShared,
        |_| TestHostMainThread { _plugin: None },
        &entry,
        &plugin_id,
        &HostInfo::new("orbit-std-gain test", "Signal compose", "", "0.0.1").unwrap(),
    )
    .expect("プラグインの生成に失敗")
}

// ──────────────────────────────────────────────────────────
// SC.10.8 規範: UI も state も持たない
// ──────────────────────────────────────────────────────────

#[test]
fn declares_neither_ui_nor_state() {
    let mut instance = instantiate();
    let handle = instance.plugin_handle();

    assert!(
        handle.get_extension::<PluginGui>().is_none(),
        "標準プラグインは UI を持ってはいけない（SC.10.8）: gui 拡張が公開されている"
    );
    assert!(
        handle.get_extension::<PluginState>().is_none(),
        "標準プラグインは state ファイルを持ってはいけない（SC.10.8）: state 拡張が公開されている"
    );
}

#[test]
fn declares_the_extensions_a_rack_stage_needs() {
    let mut instance = instantiate();
    let handle = instance.plugin_handle();

    assert!(
        handle.get_extension::<PluginAudioPorts>().is_some(),
        "audio-ports が無いと rack child が stage として繋げない"
    );
    assert!(
        handle.get_extension::<PluginParams>().is_some(),
        "params が無いと DSL から db を渡せない"
    );
}

// ──────────────────────────────────────────────────────────
// SC.10.8 規範: CLAP param 名 = DSL 引数名
// ──────────────────────────────────────────────────────────

#[test]
fn the_only_param_is_named_exactly_as_the_dsl_argument() {
    let mut instance = instantiate();
    let params = instance
        .plugin_handle()
        .get_extension::<PluginParams>()
        .expect("params 拡張が無い");

    let count = params.count(&mut instance.plugin_handle());
    assert_eq!(count, 1, "Gain のパラメータは db 1 本だけであるべき");

    let mut buf = ParamInfoBuffer::new();
    let info = params
        .get_info(&mut instance.plugin_handle(), 0, &mut buf)
        .expect("param 0 の info が取れない");

    // 🔴 リテラルで固定する。`PARAM_DB_NAME` と比べるだけだと、定数を書き換えた瞬間に
    // **両辺が一緒に動いてテストが緑のまま通る**（変異検証で実際に素通りした）。
    assert_eq!(
        info.name, b"db",
        "🔴 CLAP param 名が DSL の引数名と食い違っている。\
         DSL で Gain(db: n) と書いても値が届かなくなる（SC.10.8 規範 5-6）"
    );
    // 定数と実際に公開される名前が一致していること（配線の検査）。
    assert_eq!(info.name, PARAM_DB_NAME, "定数と公開名がずれている");
    assert_eq!(info.min_value, DB_MIN, "db の下限が仕様と違う");
    assert_eq!(info.max_value, DB_MAX, "db の上限が仕様と違う");
    assert_eq!(
        info.default_value, DB_DEFAULT,
        "引数なしの Gain() は素通し（0 dB）であるべき"
    );
}

#[test]
fn the_plugin_identifies_itself_as_gain() {
    let mut instance = instantiate();
    // 同梱ファイル名 std-plugins/Gain.clap と DSL 表面 Gain(...) は
    // この名前に紐づく。変えると解決が壊れる。
    assert_eq!(PLUGIN_NAME, "Gain");
    assert!(instance
        .plugin_handle()
        .get_extension::<PluginParams>()
        .is_some());
}

#[test]
fn processes_real_audio_at_minus_six_and_zero_db() {
    const FRAMES: u32 = 4;
    let mut instance = instantiate();
    let processor = instance
        .activate(
            |_, _| (),
            PluginAudioConfiguration {
                sample_rate: 48_000.0,
                min_frames_count: FRAMES,
                max_frames_count: FRAMES,
            },
        )
        .expect("Gain の activate に失敗");
    let mut processor = processor
        .start_processing()
        .expect("Gain の start_processing に失敗");

    for (db, expected_gain) in [(-6.0, db_to_linear(-6.0)), (0.0, 1.0)] {
        let mut input_events = EventBuffer::with_capacity(1);
        let mut output_events = EventBuffer::new();
        input_events.push(&ParamValueEvent::new(
            0,
            ClapId::new(PARAM_DB_ID),
            Pckn::match_all(),
            db,
            Cookie::empty(),
        ));

        let mut input = [[1.0_f32, -0.5, 0.25, -0.125]; 2];
        let expected_input = input;
        let mut output = [[0.0_f32; FRAMES as usize]; 2];
        let mut input_ports = AudioPorts::with_capacity(2, 1);
        let mut output_ports = AudioPorts::with_capacity(2, 1);

        {
            let input_audio = input_ports.with_input_buffers([AudioPortBuffer {
                channels: AudioPortBufferType::f32_input_only(
                    input.iter_mut().map(InputChannel::variable),
                ),
                latency: 0,
            }]);
            let mut output_audio = output_ports.with_output_buffers([AudioPortBuffer {
                channels: AudioPortBufferType::f32_output_only(
                    output.iter_mut().map(|channel| channel.as_mut_slice()),
                ),
                latency: 0,
            }]);

            processor
                .process(
                    &input_audio,
                    &mut output_audio,
                    &input_events.as_input(),
                    &mut output_events.as_output(),
                    None,
                    None,
                )
                .expect("Gain の 1 block process に失敗");
        }

        for (input_channel, output_channel) in expected_input.iter().zip(output.iter()) {
            for (input_sample, output_sample) in input_channel.iter().zip(output_channel.iter()) {
                let expected = input_sample * expected_gain;
                assert!(
                    (output_sample - expected).abs() < 1e-6,
                    "db={db}: input={input_sample}, output={output_sample}, expected={expected}"
                );
            }
        }
        if db == -6.0 {
            assert!(
                (output[0][0] - 0.5).abs() < 0.002,
                "-6 dB should be approximately half amplitude: {}",
                output[0][0]
            );
        } else {
            assert_eq!(output, expected_input, "0 dB must be exact identity");
        }
    }

    instance.deactivate(processor.stop_processing());
}
