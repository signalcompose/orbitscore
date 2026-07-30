//! `ClapEffectProcessor` — 単一スレッドで完結する effect-only CLAP プロセッサ。
//!
//! daemon の [`ClapPostProcessor`](crate::ClapPostProcessor) は main thread（activate/deactivate）と
//! audio thread（process/start/stop）を分離するが、γ out-of-process child は **1 スレッド**で全 CLAP
//! 呼び出しを直列実行する（spike の cpal 構成と異なり、子プロセスは自プロセス内で同期 1-block ループを
//! 回す）。本型はその single-thread モデルを表現し、load → process_block → drop を同一スレッドで行う。
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
//! 走らず**未 deactivate のままリーク**する（クラッシュでなく silent leak = smoke/parity では順序が逆でも
//! 緑なので、この宣言順を守る唯一のガードが本コメント）。本型は home == audio == 唯一スレッドなので teardown
//! は単一スレッドで完結し、daemon の split-thread（`ClapTeardownGuard` で跨ぐ）wrong-thread 問題を sidestep する。
//!
//! ⚠️ clack を bump する際は上記2つの Drop site（`plugin.rs:399` の sole-owner guard /
//! `plugin/instance.rs:232` の teardown）の契約を再確認すること（この宣言順の正当性は library 内部実装に依存する）。
//!
//! 用途: γ M1 PR-B の OOP effect child（`orbit-clap-effect-child`）と、その offline A/B parity の
//! in-process 参照（side A）。共有カーネルは [`process_block_core`](crate::processor::process_block_core)。
//!
//! ## 既知のギャップ（real plugin 向け・M1 スコープ外）
//!
//! - `call_on_main_thread_callback` を pump しない（dummy な `callback_requested` を渡す）。test-effect の
//!   ような load-time param のみの effect には不要だが、main-thread callback を要求する 3rd-party plugin
//!   は M1（load-time param のみ）スコープ外。
//! - effect のみ対応（`process_block` は note event を送らない）。note event を伴う instrument 経路
//!   （発音）は対象外。ただし `process_block_core` の add-mix 分岐自体（`has_audio_input()=false` の
//!   plugin で発火）は audio-input を持たない synth を load して検証済み（γ M1 PR-C・gated test
//!   `effect_processor_smoke_gated.rs::instrument_branch_add_mixes_dry_signal`）。

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

use clack_host::events::io::InputEvents;
use clack_host::prelude::{PluginInstance, StartedPluginAudioProcessor};

use crate::buffers::HostAudioBuffers;
use crate::controller::{instantiate_activate, ClapHostError, LoadedPluginInfo};
use crate::host::OrbitClapHost;
use crate::processor::process_block_core;
use crate::ClapPluginMain;

/// 単一スレッドで load / process / drop する effect-only CLAP プロセッサ。
///
/// `!Send`（[`PluginInstance`] を含む）。生成したスレッド上でのみ使うこと。
pub struct ClapEffectProcessor {
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

impl ClapEffectProcessor {
    /// .clap バンドルをロードして activate / start_processing 済みの effect プロセッサを返す。
    ///
    /// 呼び出したスレッドが home thread になる（以降の `process_block` / drop も同一スレッドで行うこと）。
    ///
    /// # Arguments
    /// * `path` — .clap バンドルのパス。
    /// * `id` — plugin id（None なら単一プラグインの場合のみ OK）。
    /// * `sample_rate` — サンプリングレート（Hz）。
    /// * `channels` — 出力チャンネル数（通常 2）。
    /// * `max_frames` — 最大フレーム数（共有メモリの 1 slot 容量に合わせる）。
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
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU64::new(0)),
        )?;

        let mut processor = Self {
            plugin: loaded.plugin,
            buffers: loaded.buffers,
            steady: 0,
            _instance: loaded.instance,
        };
        if let Some(bytes) = state {
            processor.apply_state_bytes(bytes)?;
        }
        Ok((processor, loaded.info))
    }

    /// ホストしているプラグインの state を吸い上げる（契約は [`crate::state::capture_state`]）。
    pub fn capture_state(&mut self) -> Result<Vec<u8>, ClapHostError> {
        crate::state::capture_state(&mut self._instance)
    }

    /// 保存済み state を適用する（契約は [`crate::state::apply_state_bytes`]）。
    pub fn apply_state_bytes(&mut self, bytes: &[u8]) -> Result<(), ClapHostError> {
        crate::state::apply_state_bytes(&mut self._instance, bytes)
    }

    /// Whether the loaded plugin exposes an audio input port.
    pub fn has_audio_input(&self) -> bool {
        self.buffers.has_audio_input()
    }

    /// interleaved stereo f32 ブロックを in-place で effect 処理する。
    ///
    /// 戻り値は `plugin.process()` が成功したか。失敗時は `data` を素通しする（[`process_block_core`] 準拠）。
    /// effect は note event を要さないので空の [`InputEvents`] を渡す。
    /// `#[must_use]`: 握り潰すと plugin の毎ブロック失敗が child / parity 側で不可視になる。
    #[must_use]
    pub fn process_block(&mut self, data: &mut [f32]) -> bool {
        process_block_core(
            &mut self.plugin,
            &mut self.buffers,
            &mut self.steady,
            &InputEvents::empty(),
            None,
            data,
        )
    }

    /// main / audio の 2 スレッド運用（UIH.1）へ分割する（#474 P1）。
    ///
    /// 呼び出したスレッド（= `load` を行った home スレッド）が main 側になる。
    /// audio 側（[`ClapEffectAudio`]・`Send`）は専用 audio スレッドへ move し、
    /// main 側（[`ClapPluginMain`]・`!Send`）は home スレッドに残って state 操作を担う。
    ///
    /// ## 分割後の teardown 契約（🔴 順序が正しさの条件）
    ///
    /// 1. audio スレッド終了時の [`ClapEffectAudio::drop`] が `stop_processing` を呼ぶ
    ///    （CLAP 契約: `stop_processing` は audio スレッド）
    /// 2. main スレッドが audio スレッドを **join してから** [`ClapPluginMain`] を drop する。
    ///    このとき `PluginInstance` が `Arc<PluginInstanceInner>` の唯一の所有者になり、
    ///    実 teardown（deactivate → destroy）が home スレッドで走る（CLAP 契約に適合）
    ///
    /// 逆順（audio 側が生きたまま main 側を drop）にすると `PluginInstance::Drop` は
    /// 意図的に leak し、その後 audio 側の drop が唯一所有者として teardown を
    /// **audio スレッドで**走らせる（deactivate の wrong-thread 違反）。daemon の
    /// in-process 経路（`ClapPostProcessor` の carry-forward #1）と同じ協調規律であり、
    /// out-of-process child では `orbit-child-runtime` の「join してから main 側を drop」
    /// という関数構造がこの順序を強制する。
    pub fn split(self) -> (ClapEffectAudio, ClapPluginMain) {
        let Self {
            plugin,
            buffers,
            steady,
            _instance,
        } = self;
        (
            ClapEffectAudio {
                plugin: Some(plugin),
                buffers,
                steady,
            },
            ClapPluginMain {
                instance: _instance,
            },
        )
    }
}

/// [`ClapEffectProcessor::split`] の audio スレッド側。
///
/// `Send`（`StartedPluginAudioProcessor` は clack が audio スレッドへの引き渡しを想定して
/// `Send` を提供する — daemon の `InstallMsg` が同じ根拠で cross-thread 送信している）。
/// audio スレッドに move した後は、そのスレッドだけが触ること。
pub struct ClapEffectAudio {
    plugin: Option<StartedPluginAudioProcessor<OrbitClapHost>>,
    buffers: HostAudioBuffers,
    steady: u64,
}

impl ClapEffectAudio {
    /// [`ClapEffectProcessor::process_block`] と同一の音響処理（audio スレッド側）。
    #[must_use]
    pub fn process_block(&mut self, data: &mut [f32]) -> bool {
        process_block_core(
            self.plugin
                .as_mut()
                .expect("CLAP effect audio remains started until teardown"),
            &mut self.buffers,
            &mut self.steady,
            &InputEvents::empty(),
            None,
            data,
        )
    }
}

impl Drop for ClapEffectAudio {
    fn drop(&mut self) {
        // Drop runs on the dedicated audio thread in both the normal and
        // unwinding paths, so a panic cannot move stop_processing to main.
        if let Some(plugin) = self.plugin.take() {
            let _ = plugin.stop_processing();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// audio 側が `Send`（専用 audio スレッドへ move できる）ことのコンパイル時証明。
    /// clack の `StartedPluginAudioProcessor` / `AudioPorts` の `unsafe impl Send` に依拠する
    /// ため、clack bump でこれが外れたらここがコンパイルエラーで検出する。
    #[test]
    fn audio_half_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<ClapEffectAudio>();
    }
}
