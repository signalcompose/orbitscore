//! `ClapInstrumentProcessor` — 単一スレッドで完結する instrument CLAP プロセッサ。
//!
//! ## drop 順による teardown の正当性（carry-forward #1 の sidestep）
//!
//! CLAP では `stop_processing` は audio thread、`deactivate` は home(main) thread が要件。clack
//! （pinned rev `f874e858`）の実機構: `plugin`（`StartedPluginAudioProcessor`）と `_instance`
//! （`PluginInstance`）は**同一の `Arc<PluginInstanceInner>` を共有**し、実 teardown
//! （stop_processing → deactivate → destroy をまとめて）は **最後の Arc が落ちた時に
//! `PluginInstanceInner::Drop` が実行する**（`host/src/plugin/instance.rs:232`）。`StartedPluginAudioProcessor`
//! 自体は Drop を持たず（Arc refcount を減らすだけ）、teardown は呼ばないことに注意。
//!
//! ここで `PluginInstance::Drop`（`host/src/plugin.rs:399`）は **自分が唯一の Arc 所有者のときだけ**
//! inner を drop し、そうでなければ「audio processor handle が生存中に teardown を別スレッドへ移さない」
//! ため**意図的に leak する**。したがってフィールド宣言順で `plugin` を `_instance` より**前**に置くことが
//! load-bearing: `plugin` の Arc が先に落ちて `_instance` が唯一所有者になり、`_instance` drop で teardown が
//! 実際に走る。**逆順にすると** `_instance` drop 時に refcount>1 で leak し、`plugin` drop でも teardown が
//! 走らず**永久 leak（teardown はどのスレッドでも一切走らない）**になる（smoke/parity では順序が逆でも
//! 緑なので、この宣言順を守る唯一のガードが本コメント）。本型は home == audio == 唯一スレッドなので teardown
//! は単一スレッドで完結し、daemon の split-thread（`ClapTeardownGuard` で跨ぐ）wrong-thread 問題を sidestep する。
//!
//! ⚠️ clack を bump する際は上記2つの Drop site（`plugin.rs:399` の sole-owner guard /
//! `plugin/instance.rs:232` の teardown）の契約を再確認すること（この宣言順の正当性は library 内部実装に依存する）。

use clack_host::events::io::EventBuffer;
use clack_host::events::UnknownEvent;
use clack_host::prelude::{PluginInstance, StartedPluginAudioProcessor};
use orbit_audio_sandbox::NeutralEvent;
use std::path::Path;

use crate::buffers::HostAudioBuffers;
use crate::controller::{
    instantiate_activate, ClapHostError, HostCallbackConfig, LoadedPluginInfo,
};
use crate::host::OrbitClapHost;
use crate::processor::process_block_core;
use crate::ClapPluginMain;

/// Child processes host a plugin UI, so they must advertise `HostGui`.
///
/// 🔴 **P3b-2 completion condition.** See the identical note on
/// `crate::effect::child_host_callback_config`: the unit test pins this function's body,
/// but nothing pins the call site to it, and `in_process` / `child` share a return type
/// so the swap compiles. P3b-2's plugin-initiated-close test runs through the real `load`
/// path and binds the call site.
fn child_host_callback_config() -> HostCallbackConfig {
    HostCallbackConfig::child()
}

/// 単一スレッドで load / process / drop する instrument CLAP プロセッサ。
///
/// `!Send`（[`PluginInstance`] を含む）。生成したスレッド上でのみ使うこと。
pub struct ClapInstrumentProcessor {
    /// 起動済み audio processor（`Arc<PluginInstanceInner>` を保持）。`_instance` より**前**に宣言して
    /// 先に drop = `_instance` を唯一の Arc 所有者にし、実 teardown を `_instance` drop に確定させる
    /// （詳細は module doc）。
    plugin: StartedPluginAudioProcessor<OrbitClapHost>,
    /// 事前確保済みオーディオバッファ。
    buffers: HostAudioBuffers,
    /// steady sample counter（A0 §4.1 step f）。
    steady: u64,
    /// プラグインインスタンス（同じ `Arc<PluginInstanceInner>` を保持）。`plugin` の後に drop され、
    /// 唯一所有者として `PluginInstanceInner::Drop`（stop_processing→deactivate→destroy）を単一スレッドで走らせる。
    _instance: PluginInstance<OrbitClapHost>,
}

impl ClapInstrumentProcessor {
    /// 現在の plugin state をバイト列で取り出す（#557・契約は [`crate::state::capture_state`]）。
    pub fn capture_state(&mut self) -> Result<Vec<u8>, ClapHostError> {
        crate::state::capture_state(&mut self._instance)
    }

    /// 保存済み state を適用する（#557・契約は [`crate::state::apply_state_bytes`]）。
    pub fn apply_state_bytes(&mut self, bytes: &[u8]) -> Result<(), ClapHostError> {
        crate::state::apply_state_bytes(&mut self._instance, bytes)
    }

    /// Converts a plugin output event into the M2 child-to-host event representation.
    pub fn neutral_output_event(event: &UnknownEvent) -> Option<NeutralEvent> {
        crate::events::neutral_event_from_clap_output(event)
    }

    /// .clap バンドルをロードして activate / start_processing 済みの instrument プロセッサを返す。
    ///
    /// 呼び出したスレッドが home thread になる（以降の `process_block` / drop も同一スレッドで行うこと）。
    ///
    /// # Arguments
    /// * `path` — .clap バンドルのパス。
    /// * `id` — plugin id（None なら単一プラグインの場合のみ OK）。
    /// * `sample_rate` — サンプリングレート（Hz）。
    /// * `channels` — 出力チャンネル数（通常 2）。
    /// * `max_frames` — 最大フレーム数（共有メモリの 1 slot 容量に合わせる）。
    /// * `state` — 保存済み state。渡すと **返る前に適用済み**になる。
    ///
    /// # state を別呼び出しにしない理由
    ///
    /// 呼び出し側は load 後に `publish_child_ready` を行う。復元を別呼び出しにすると
    /// 「READY を先に publish してしまい、復元前の既定音色で 1 ブロック鳴る」順序ミスが
    /// **書けてしまう**。実際、順序を入れ替えても配線テストが green のまま通ることが
    /// 変異検証で判明した（テストで守れない不変条件だった）。load に畳んで
    /// **正しい呼び方を1箇所に強制する**。VST3 側 `Vst3InstrumentProcessor::load` も同じ形。
    ///
    /// ⚠️ 型で**表現不能**にしたわけではない — `apply_state_bytes` は `pub` のままなので、
    /// `load(.., None)` してから後で呼ぶコードは今でも書ける。ただしその逆行は
    /// 破損 state のテスト（`a_corrupt_state_file_...`）が拾う（レビューで実証済み）。
    pub fn load(
        path: &Path,
        id: Option<&str>,
        sample_rate: u32,
        channels: usize,
        max_frames: u32,
        state: Option<&[u8]>,
    ) -> Result<(Self, LoadedPluginInfo), ClapHostError> {
        // standalone なので daemon の監視フィールドではなく fresh な Arc を渡す
        // （callback は pump しない・resize は監視しない）。
        let loaded = instantiate_activate(
            path,
            id,
            sample_rate,
            channels,
            max_frames,
            child_host_callback_config(),
        )?;

        let mut processor = Self {
            plugin: loaded.plugin,
            buffers: loaded.buffers,
            steady: 0,
            _instance: loaded.instance,
        };
        // 🔴 返る前に適用する。呼び出し側が READY を publish する時点で音色が確定している
        // ことを、**呼び出し順ではなくこの関数の契約として**保証する。
        if let Some(bytes) = state {
            processor.apply_state_bytes(bytes)?;
        }
        Ok((processor, loaded.info))
    }

    /// Whether the loaded plugin exposes an audio input port.
    pub fn has_audio_input(&self) -> bool {
        self.buffers.has_audio_input()
    }

    /// host → plugin の CLAP event を渡し、instrument の出力を `data` に加算する。
    ///
    /// `events` は呼び出し側が [`crate::push_neutral_event`] で構築した CLAP event buffer。
    /// instrument は audio input を持たないため、[`process_block_core`] は plugin の出力を `data` に
    /// add-mix し、上書きはしない。呼び出し側は本メソッドを呼ぶ前に `data` を初期化する責任があり、
    /// instrument の出力だけを得る場合は通常 zero-fill しておくこと。
    ///
    /// 戻り値は `plugin.process()` が成功したか。失敗時は `data` を変更しない（[`process_block_core`] 準拠）。
    /// `#[must_use]`: 握り潰すと plugin の毎ブロック失敗が child / parity 側で不可視になる。
    ///
    #[must_use]
    pub fn process_block(
        &mut self,
        data: &mut [f32],
        events: &EventBuffer,
        output_events: &mut EventBuffer,
    ) -> bool {
        process_block_core(
            &mut self.plugin,
            &mut self.buffers,
            &mut self.steady,
            &events.as_input(),
            Some(output_events),
            data,
        )
    }

    /// main / audio の 2 スレッド運用（UIH.1）へ分割する（#474 P1）。
    ///
    /// 意味論・teardown の順序契約は [`crate::ClapEffectProcessor::split`] と同一
    /// （audio 側の [`ClapInstrumentAudio::drop`] → main が join →
    /// [`ClapPluginMain`] drop = 唯一所有者として home スレッドで実 teardown）。
    /// 逆順の帰結も同じく **永久 leak（teardown はどのスレッドでも一切走らない）**。
    pub fn split(self) -> (ClapInstrumentAudio, ClapPluginMain) {
        let Self {
            plugin,
            buffers,
            steady,
            _instance,
        } = self;
        (
            ClapInstrumentAudio {
                plugin: Some(plugin),
                buffers,
                steady,
            },
            ClapPluginMain {
                instance: _instance,
                plugin_gui: None,
                gui_attached: false,
                gui_can_resize: false,
            },
        )
    }
}

/// [`ClapInstrumentProcessor::split`] の audio スレッド側（`Send`・詳細は
/// [`crate::ClapEffectAudio`] と同じ根拠）。
pub struct ClapInstrumentAudio {
    plugin: Option<StartedPluginAudioProcessor<OrbitClapHost>>,
    buffers: HostAudioBuffers,
    steady: u64,
}

impl ClapInstrumentAudio {
    /// [`ClapInstrumentProcessor::process_block`] と同一の音響処理（audio スレッド側）。
    #[must_use]
    pub fn process_block(
        &mut self,
        data: &mut [f32],
        events: &EventBuffer,
        output_events: &mut EventBuffer,
    ) -> bool {
        process_block_core(
            self.plugin
                .as_mut()
                .expect("CLAP instrument audio remains started until teardown"),
            &mut self.buffers,
            &mut self.steady,
            &events.as_input(),
            Some(output_events),
            data,
        )
    }
}

impl Drop for ClapInstrumentAudio {
    fn drop(&mut self) {
        // Keep CLAP stop_processing on the audio thread during unwinding too.
        if let Some(plugin) = self.plugin.take() {
            let _ = plugin.stop_processing();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clack_extensions::gui::HostGuiImpl;
    use std::path::PathBuf;

    use crate::host::OrbitHostShared;

    /// audio 側が `Send` であることのコンパイル時証明（根拠は
    /// `effect.rs::tests::audio_half_is_send` と同一）。
    #[test]
    fn audio_half_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<ClapInstrumentAudio>();
    }

    #[test]
    fn child_path_advertises_gui_callbacks() {
        assert!(child_host_callback_config().gui_callbacks_enabled());
    }

    #[test]
    #[ignore = "needs prebuilt release clap-test-synth dylib"]
    fn real_load_path_delivers_plugin_initiated_close_to_main_half() {
        let dylib = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
            .join("rust-spike/clap-test-synth/target/release/libclap_test_synth.dylib");
        assert!(dylib.exists(), "missing {}", dylib.display());
        let (processor, _) = ClapInstrumentProcessor::load(
            &dylib,
            Some("com.signalcompose.clap-test-synth"),
            48_000,
            2,
            512,
            None,
        )
        .expect("load test instrument through child callback configuration");
        let (audio, main) = processor.split();

        main.instance
            .access_shared_handler(|shared: &OrbitHostShared| HostGuiImpl::closed(shared, false));

        assert_eq!(main.take_closed(), Some(false));
        drop(audio);
        drop(main);
    }
}
