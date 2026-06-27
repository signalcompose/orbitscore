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
//! - effect のみ対応（`process_block` は note event を送らない）。instrument 経路は対象外。

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

use clack_host::events::io::InputEvents;
use clack_host::prelude::{PluginInstance, StartedPluginAudioProcessor};

use crate::buffers::HostAudioBuffers;
use crate::controller::{instantiate_activate, ClapHostError, LoadedPluginInfo};
use crate::host::OrbitClapHost;
use crate::processor::process_block_core;

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

        let processor = Self {
            plugin: loaded.plugin,
            buffers: loaded.buffers,
            steady: 0,
            _instance: loaded.instance,
        };
        Ok((processor, loaded.info))
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
            data,
        )
    }
}
