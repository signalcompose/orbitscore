//! OOP role の抽象と child-slot の共通機構（#888 子 1・第 11 束）。
//!
//! `OutProcRole` トレイトとその 2 実装、`ChildSlot` /
//! `ChildLaunch`、`ShmCleanupGuard`、quiesce/drain のタイムアウト定数、リトライ付き push、
//! および in-process CLAP の role 型（`ClapControl` / `ClapPluginRole`）をそのまま移した。
//! 🔴 **本文は 1 行も書き換えていない。** 変えたのは可視性だけで、同一モジュール内では
//! 修飾子が要らなかった項目に `pub(super)` を付けた（分割の必然・設計 §5 の **E3′**）。
//!
//! 🔴 **ストリーム/デバイスのライフサイクルはここに無い**（`StreamGuard` /
//! `StreamConfigSnapshot` / `DeviceSwitchRequest` / capture パス解決）。第 1 版では
//! ここに同居していたが、`role.rs` という名前が説明しているのは OOP role だけなので、
//! レビュー（altitude）を受けて主題どおり `device_link.rs` へ移した。
//!
//! 可視性は**定義側の cfg と一致させる**こと（第 9・10 束で 2 度間違えた）。

#[allow(unused_imports)]
use super::*;

/// OOP role ごとの差分を child-slot state machine から分離する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) trait OutProcRole: Sized {
    /// `Send + Sync` は生産コード上も既に前提（watchdog スレッドが `Arc<Self::Stats>` を共有する）。
    /// ジェネリックなテストヘルパーが `Arc<Mutex<ChildSlot<R>>>` をスレッド間で受け渡す際、
    /// コンパイラにその前提を明示するために必要。
    type Stats: Send + Sync;
    type Supervisor: Send;
    const ROLE_NAME: &'static str;

    /// この role の child が **UI を index 付きで複数枚持てる**か（#633）。
    ///
    /// rack（effect）は 1 child に複数 stage を載せるので `index_binding` を持つ。instrument は
    /// いま 1 child 1 UI なので持たない。**呼び出し側で `ROLE_NAME` を文字列比較しない** —
    /// 綴りを間違えても型エラーにならず、instrument 側が静かに壊れる。マルチティンバー
    /// （#647）で instrument も複数枚になる時は、この const を 1 箇所 true にすれば済む。
    const SUPPORTS_INDEXED_UI: bool;

    /// `state` は保存済みプラグイン state ファイル。#562 以降は effect / instrument の
    /// 両 role が READY publish 前に適用する。
    fn spawn_child(
        launch: &ChildLaunch<Self>,
        path: &std::path::Path,
        plugin_id: Option<&str>,
        state: Option<&std::path::Path>,
    ) -> std::io::Result<std::process::Child>;
    fn spawn_supervisor(
        child: std::process::Child,
        launch: &ChildLaunch<Self>,
        path: PathBuf,
        plugin_id: Option<String>,
        latest_state: Arc<Mutex<Option<PathBuf>>>,
        mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
        ui: PluginUiWiring,
    ) -> std::io::Result<Self::Supervisor>;
    fn detach_keep_shm(supervisor: Self::Supervisor);
    fn role_matches(child_flags: u32) -> bool;
    fn runtime_error(message: String) -> WrapError;
    fn set_initial_attach_pending(stats: &Self::Stats, value: bool);
    /// 初回 attach 中の child exit の**事実と理由の対**。片方だけ動かせないよう1つの型に
    /// まとめてある（#629 レビュー）— 詳細は [`crate::outproc_child_exit::ChildEarlyExit`]。
    fn child_early_exit(stats: &Self::Stats) -> &crate::outproc_child_exit::ChildEarlyExit;
    fn set_current_child_pid(stats: &Self::Stats, pid: u32);
    /// Attach する plugin のパスから、その format に対応する child を選び直す。
    ///
    /// **#552 以降、effect と instrument の両 role が per-plugin 解決を行う**（利用者に
    /// プラグイン形式を見せないため・CAP.6-1）。デフォルト名以外の child exe は明示指定と
    /// 見なして保持する。詳細は各 role の `child_exe_for_attach` doc を参照。
    fn select_child_exe(
        launch: &mut ChildLaunch<Self>,
        path: &std::path::Path,
    ) -> Result<(), String>;
    /// テスト専用: role ジェネリックなテストヘルパーが `Self::Stats` を構築するためのコンストラクタ。
    /// production コードはこれを呼ばない（`load_outproc_plugin_impl` 等は呼び出し側から渡された
    /// `ChildLaunch::stats` を使う）。
    #[cfg(test)]
    fn new_stats() -> Arc<Self::Stats>;
    /// テスト専用: `current_child_pid` の生 atomic への参照。`role_mismatch_retries_same_slot` が
    /// spawn 完了の同期に使う（両 role の `Stats` に同名 `pub` field があるが、`Self::Stats` への
    /// ジェネリックコードからは field アクセスできないため trait 経由にする）。
    #[cfg(test)]
    fn current_child_pid_atomic(stats: &Self::Stats) -> &std::sync::atomic::AtomicU32;
}

#[cfg(feature = "outproc-effect")]
pub(crate) struct EffectRole;
#[cfg(feature = "outproc-instrument")]
pub(crate) struct InstrumentRole;
/// single-role ビルドの既定 role（both ビルドでは legacy API 用に effect を指す）。
/// 委譲 impl を複製せず type alias で本体 impl を継承する。
#[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
pub(crate) type DefaultOutProcRole = EffectRole;
#[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
pub(crate) type DefaultOutProcRole = InstrumentRole;
#[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) type DefaultOutProcRole = EffectRole;

#[cfg(feature = "outproc-effect")]
impl OutProcRole for EffectRole {
    type Stats = crate::outproc_effect::OutProcEffectStats;
    type Supervisor = crate::outproc_effect::EffectChildSupervisor;
    const ROLE_NAME: &'static str = "effect";
    /// rack は 1 child に複数 stage を載せるので、UI も index ごとに開ける。
    const SUPPORTS_INDEXED_UI: bool = true;
    fn spawn_child(
        launch: &ChildLaunch<Self>,
        path: &std::path::Path,
        plugin_id: Option<&str>,
        state: Option<&std::path::Path>,
    ) -> std::io::Result<std::process::Child> {
        let chain = vec![crate::outproc_effect::ChainStageConfig::Catalog {
            path: path.to_path_buf(),
            plugin_id: plugin_id.map(str::to_owned),
            latest_state: state.map(PathBuf::from),
            enabled: true,
        }];
        let manifest = crate::outproc_effect::write_chain_manifest(&launch.shm_path, &chain)?;
        crate::outproc_effect::spawn_effect_child(
            &launch.child_exe,
            &launch.shm_path,
            &manifest,
            launch.sample_rate,
        )
    }
    fn spawn_supervisor(
        child: std::process::Child,
        launch: &ChildLaunch<Self>,
        path: PathBuf,
        plugin_id: Option<String>,
        latest_state: Arc<Mutex<Option<PathBuf>>>,
        mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
        ui: PluginUiWiring,
    ) -> std::io::Result<Self::Supervisor> {
        crate::outproc_effect::EffectChildSupervisor::spawn_with_mailbox(
            child,
            launch.shm_path.clone(),
            launch.stats.clone(),
            launch.child_exe.clone(),
            path,
            plugin_id,
            launch.sample_rate,
            latest_state,
            mailbox,
            ui,
        )
    }
    fn detach_keep_shm(supervisor: Self::Supervisor) {
        supervisor.detach_keep_shm();
    }
    fn role_matches(flags: u32) -> bool {
        flags & orbit_audio_sandbox::transport::CHILD_FLAG_HAS_AUDIO_INPUT != 0
    }
    fn runtime_error(message: String) -> WrapError {
        WrapError::OutProcEffect(message)
    }
    fn set_initial_attach_pending(stats: &Self::Stats, value: bool) {
        stats.initial_attach_pending.store(value, Ordering::Release);
    }
    fn child_early_exit(stats: &Self::Stats) -> &crate::outproc_child_exit::ChildEarlyExit {
        &stats.child_early_exit
    }
    fn set_current_child_pid(stats: &Self::Stats, pid: u32) {
        stats.current_child_pid.store(pid, Ordering::Relaxed);
    }
    fn select_child_exe(
        launch: &mut ChildLaunch<Self>,
        path: &std::path::Path,
    ) -> Result<(), String> {
        // #552: 拡張子ベースの読み替え（.vst3 → VST3 child・それ以外 → CLAP child）。
        // 明示指定された child exe（デフォルト名以外）は保持される。instrument 側と同一の規則で、
        // 詳細は `outproc_effect::child_exe_for_attach` の doc を参照。
        launch.child_exe = crate::outproc_effect::child_exe_for_attach(&launch.child_exe, path);
        tracing::debug!(
            ?path,
            child_exe = ?launch.child_exe,
            "effect child selected for attach"
        );
        Ok(())
    }
    #[cfg(test)]
    fn new_stats() -> Arc<Self::Stats> {
        crate::outproc_effect::OutProcEffectStats::new()
    }
    #[cfg(test)]
    fn current_child_pid_atomic(stats: &Self::Stats) -> &std::sync::atomic::AtomicU32 {
        &stats.current_child_pid
    }
}

#[cfg(feature = "outproc-instrument")]
impl OutProcRole for InstrumentRole {
    type Stats = crate::outproc_instrument::OutProcInstrumentStats;
    type Supervisor = crate::outproc_instrument::InstrumentChildSupervisor;
    const ROLE_NAME: &'static str = "instrument";
    /// instrument はいま 1 child 1 UI。マルチティンバー（#647）で複数枚になったら true へ。
    const SUPPORTS_INDEXED_UI: bool = false;
    fn spawn_child(
        launch: &ChildLaunch<Self>,
        path: &std::path::Path,
        plugin_id: Option<&str>,
        state: Option<&std::path::Path>,
    ) -> std::io::Result<std::process::Child> {
        crate::outproc_instrument::spawn_instrument_child(
            &launch.child_exe,
            &launch.shm_path,
            path,
            plugin_id,
            launch.sample_rate,
            state,
        )
    }
    fn spawn_supervisor(
        child: std::process::Child,
        launch: &ChildLaunch<Self>,
        path: PathBuf,
        plugin_id: Option<String>,
        latest_state: Arc<Mutex<Option<PathBuf>>>,
        mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
        ui: PluginUiWiring,
    ) -> std::io::Result<Self::Supervisor> {
        crate::outproc_instrument::InstrumentChildSupervisor::spawn_with_mailbox(
            child,
            launch.shm_path.clone(),
            launch.stats.clone(),
            launch.child_exe.clone(),
            path,
            plugin_id,
            launch.sample_rate,
            latest_state,
            mailbox,
            ui,
        )
    }
    fn detach_keep_shm(supervisor: Self::Supervisor) {
        supervisor.detach_keep_shm();
    }
    fn role_matches(flags: u32) -> bool {
        flags & orbit_audio_sandbox::transport::CHILD_FLAG_HAS_AUDIO_INPUT == 0
    }
    fn runtime_error(message: String) -> WrapError {
        WrapError::OutProcInstrument(message)
    }
    fn set_initial_attach_pending(stats: &Self::Stats, value: bool) {
        stats.initial_attach_pending.store(value, Ordering::Release);
    }
    fn child_early_exit(stats: &Self::Stats) -> &crate::outproc_child_exit::ChildEarlyExit {
        &stats.child_early_exit
    }
    fn set_current_child_pid(stats: &Self::Stats, pid: u32) {
        stats.current_child_pid.store(pid, Ordering::Relaxed);
    }
    fn select_child_exe(
        launch: &mut ChildLaunch<Self>,
        path: &std::path::Path,
    ) -> Result<(), String> {
        // 拡張子ベースの読み替え（.vst3 → VST3 child・それ以外 → CLAP child）。明示指定された
        // child exe（デフォルト名以外）は保持される。詳細は `child_exe_for_attach` の doc 参照。
        launch.child_exe = crate::outproc_instrument::child_exe_for_attach(&launch.child_exe, path);
        tracing::debug!(
            ?path,
            child_exe = ?launch.child_exe,
            "instrument child selected for attach"
        );
        Ok(())
    }
    #[cfg(test)]
    fn new_stats() -> Arc<Self::Stats> {
        crate::outproc_instrument::OutProcInstrumentStats::new()
    }
    #[cfg(test)]
    fn current_child_pid_atomic(stats: &Self::Stats) -> &std::sync::atomic::AtomicU32 {
        &stats.current_child_pid
    }
}

/// OOP child の post-boot attach 状態。v1 は一つの daemon role につき一つの plugin path 固定。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) enum ChildSlot<R: OutProcRole = DefaultOutProcRole> {
    Empty(ChildLaunch<R>),
    Loading {
        path: PathBuf,
    },
    Active {
        path: PathBuf,
        plugin_id: Option<String>,
        /// 保存済み state ファイル（#540 P2）。ロード identity の一部 — 同 path/plugin_id でも
        /// state が異なる再宣言は v1 では差し替え扱いで拒否する。
        state: Option<PathBuf>,
        /// supervisor が次の respawn で復元する最新 state。保存成功時に `state`（ロード
        /// identity）は変えず、この共有値だけを原子的に差し替える。
        latest_state: Arc<Mutex<Option<PathBuf>>>,
        engaged: Arc<AtomicBool>,
        mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
        ui_pump: Arc<orbit_audio_sandbox::UiEventPump>,
        ui_target: Arc<Mutex<PluginUiRouteRegistry>>,
        ui_index_binding: Option<Arc<Mutex<PluginUiIndexBinding>>>,
        _supervisor: R::Supervisor,
    },
    Closed,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) struct ChildLaunch<R: OutProcRole = DefaultOutProcRole> {
    pub(super) shm_path: PathBuf,
    pub(super) child_exe: PathBuf,
    pub(super) sample_rate: u32,
    pub(super) stats: Arc<R::Stats>,
    pub(super) engaged: Arc<AtomicBool>,
    pub(super) cleanup_shm_on_drop: bool,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl<R: OutProcRole> Drop for ChildLaunch<R> {
    fn drop(&mut self) {
        // cleanup_shm_on_drop=true は retryable attach failure 後を含め、この launch が unlink の
        // 唯一の所有者であることを意味する。よって NotFound を含む
        // あらゆる失敗が異常であり、無条件で warn する。
        if self.cleanup_shm_on_drop {
            if let Err(error) = std::fs::remove_file(&self.shm_path) {
                tracing::warn!(
                    "ChildLaunch drop: shm 削除失敗 {:?}: {error}",
                    self.shm_path
                );
            }
        }
    }
}

/// stream 起動前に失敗した場合だけ shm を回収する暫定所有者。
/// `ChildLaunch` 構築後はそちらが unlink 所有者になるため、必ず disarm する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) struct ShmCleanupGuard {
    pub(super) path: PathBuf,
    pub(super) armed: bool,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl ShmCleanupGuard {
    pub(super) fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    pub(super) fn disarm(&mut self) {
        self.armed = false;
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl Drop for ShmCleanupGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Err(error) = std::fs::remove_file(&self.path) {
                tracing::warn!(
                    "ShmCleanupGuard drop: shm 削除失敗 {:?}: {error}",
                    self.path
                );
            }
        }
    }
}

/// child plugin load は通常 dlopen を含む。十分な上限を設け、応答を永久に保留しない。
///
/// **60s の根拠**（実測・2026-08-01・#605）。従来の 10s はサンプラー系で足りなかった:
///
/// | 内訳 | 実測 |
/// |---|---|
/// | Kontakt 8 の load（state 無し・release） | 3.1s |
/// | 同（1.33MB の component state 復元込み） | 4.3s |
/// | 初回 dylib 検証（Gatekeeper・plugin ごとに一度きり） | 最大 20s |
///
/// 計測は `orbit-vst3-host/tests/kontakt_state_gated.rs`。定常状態には 5s で足りるが、
/// **初回起動・コールドキャッシュ・大規模ライブラリ**が重なる最悪ケースを許容する。
/// この上限は「遅いプラグインを待つ」ためのもので、**ハングの検出には使わない**
/// （ハングは child 側の `ParentWatch` と watchdog が別途拾う）。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) const CHILD_READY_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) const CHILD_READY_POLL: Duration = Duration::from_millis(10);
/// effect in-place 差し替え時に RT transport 離脱 ack を待つ上限と poll 間隔。
#[cfg(feature = "outproc-effect")]
pub(super) const EFFECT_QUIESCE_TIMEOUT: Duration = Duration::from_millis(500);
#[cfg(feature = "outproc-effect")]
pub(super) const EFFECT_QUIESCE_POLL: Duration = Duration::from_millis(2);
/// #618: tenant 差し替え時の note ring drain-and-discard ack 待ち上限。
/// timeout は再利用禁止へ degrade し、残渣入り slot を別 tenant へ渡さない。
#[cfg(feature = "outproc-instrument")]
pub(super) const INSTRUMENT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
#[cfg(feature = "outproc-instrument")]
pub(super) const INSTRUMENT_DRAIN_POLL: Duration = Duration::from_millis(2);

/// effect replacement が共有 quiesce flags を片付ける。stream 停止 latch が立っていれば
/// guard 所有の request を消さず、clear 直後に latch が立つ競合も再検査で復元する。
#[cfg(feature = "outproc-effect")]
pub(super) fn clear_quiesce_unless_shutdown(entry: &EffectSlotEntry) {
    clear_quiesce_unless_shutdown_with(entry, || {});
}

#[cfg(feature = "outproc-effect")]
/// Clears the quiesce handshake **unless** the stream owner has latched shutdown.
///
/// 🔴 `SeqCst` on the shutdown load and the `quiesce_requested` clear is load-bearing, not
/// decoration (#625 audit B-1). This function and `OutProcTeardownGuard::latch_then_request`
/// form a store-buffering (Dekker) pair: each side stores its own flag and then loads the
/// other's. Under `Release`/`Acquire` alone, the re-check below is permitted to read a stale
/// `shutdown == false` even though the guard already stored `true` — coherence only forbids
/// reading a value *older* than one already read, and this thread read `false` a moment ago.
/// x86-TSO realises exactly this via the store buffer. The consequence is the failure the
/// latch exists to prevent: this thread clears the guard's `quiesce_requested`, never restores
/// it, the audio thread therefore never acks, and the stream owner stops without a real
/// quiesce. A single total order over these two accesses removes the interleaving.
///
/// The `SeqCst` stores are confined to these two control-thread code paths. The audio thread
/// reads the same `quiesce_requested` atomic with `Acquire` on every callback, but performs no
/// `SeqCst` operation; the `shutdown` atomic itself remains control-thread-only.
///
/// **This is not covered by a test.** Logical interleaving (the `after_clear` hook) cannot
/// reproduce a memory-ordering relaxation; only a model checker such as `loom` could.
pub(super) fn clear_quiesce_unless_shutdown_with(
    entry: &EffectSlotEntry,
    after_clear: impl FnOnce(),
) {
    if !entry.shutdown.load(Ordering::SeqCst) {
        entry.quiesce_requested.store(false, Ordering::SeqCst);
        entry.quiesce_done.store(false, Ordering::Release);
        after_clear();
        if entry.shutdown.load(Ordering::SeqCst) {
            entry.quiesce_requested.store(true, Ordering::Release);
        }
    }
}

/// CLAP host の control-side ハンドル一式（feature `clap-host` 専用）。
#[cfg(feature = "clap-host")]
pub(super) struct ClapControl {
    /// 専用スレッドへ `LoadPlugin` を送る Sender。
    pub(super) cmd_tx: std::sync::mpsc::Sender<crate::clap_host::ClapCommand>,
    /// 単一 CLAP slot に正常ロード済みの plugin role。成功応答後だけ更新する。
    pub(super) loaded_role: Option<ClapPluginRole>,
    /// audio thread（cpal callback の `ClapPostProcessor`）へ note を渡す event ring producer。
    pub(super) event_tx: rtrb::Producer<orbit_clap_host::PluginEvent>,
    /// CLAP processor 統計（post-mix peak / process error 等）。daemon が読む。
    pub(super) stats: Arc<orbit_clap_host::ClapProcessorStats>,
    /// callback-duration 統計（A0 §6: CoreAudio+cpal は xrun 不発火 → RT 健全性は callback 実測時間で
    /// 測る）。daemon の RT 監視 / gated test の budget 検証が読む。
    pub(super) cb_stats: Arc<orbit_audio_native::CallbackTimeStats>,
}

/// in-process CLAP host の単一 slot に紐付く plugin role。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClapPluginRole {
    Effect,
    Instrument,
}

/// CLAP plugin の activate に渡す最大フレーム数。daemon の cpal stream は可変 buffer（`None`）なので
/// device の実 buffer がこれを超えたら `HostAudioBuffers::ensure_buffer_size_matches` が resize する
/// （resize_count に計上）。典型的な device buffer（256〜2048）を十分上回る値を選び resize を実質
/// ゼロに保つ。
#[cfg(feature = "clap-host")]
pub(super) const CLAP_MAX_FRAMES: u32 = 8192;

/// event ring への bounded retry の再試行間隔。
#[cfg(any(feature = "clap-host", feature = "outproc-instrument"))]
pub(super) const PLUGIN_EVENT_RETRY_INTERVAL: Duration = Duration::from_millis(1);
/// 最大再試行回数（≈200ms 上限）。event ring の consumer（audio callback）は毎 block ごとに
/// ring を全量 drain するため、通常は最初の数回で空きが生まれる。この上限は大きめの buffer
/// 構成（cpal callback 周期が長いケース）でも安全にカバーする余裕を持たせた値であり、
/// 「ここまで待っても空かない」を真の overflow とみなす閾値。
#[cfg(any(feature = "clap-host", feature = "outproc-instrument"))]
pub(super) const PLUGIN_EVENT_RETRY_MAX_ATTEMPTS: u32 = 200;

/// 1回の push 試行の結果。`Fatal` はリトライしても解決しない状態（mutex poisoned / control 不在）
/// を表し、bounded retry ループを即座に打ち切る。
#[cfg(any(feature = "clap-host", feature = "outproc-instrument"))]
pub(super) enum PushAttemptOutcome<T> {
    Sent,
    Full(T),
    Fatal(WrapError),
}

/// `attempt` を bounded retry で呼び出す。producer は audio callback（RT スレッド）ではなく制御
/// スレッド（WS handler 等）からのみ呼ばれる前提 — consumer 側が毎 callback で ring を全量 drain
/// するので、最大 1 callback 周期待てば空きが保証される。この性質を利用し、満杯を「データ喪失」
/// でなく「一時的なリトライ待ち」として扱う（M2 doc `docs/development/POST_2.0_GAMMA_M2_DESIGN.md`
/// §4.4 の「溢れても失わない」方針を in-process ring に retrofit したもの・issue #400）。
///
/// **`attempt` は1回の試行につき1回だけ呼ばれ、mutex 等の lock 取得はその中で行い、`sleep` の
/// 前に解放されていること**（呼び出し側の責務）。retry の待機中に共有 lock を握り続けると、
/// 他の control-thread 操作（別セッションの LoadPlugin/PluginNoteOn 等）を最大
/// `max_attempts × retry_interval` だけ足止めしてしまう（`load_plugin` の「lock は send までで
/// 解放」規約と同じ理由・#402 レビュー指摘）。
///
/// 真に `max_attempts` 尽きた場合のみ `overflow_count` を進めてエラーを返す。
#[cfg(any(feature = "clap-host", feature = "outproc-instrument"))]
pub(super) fn push_with_bounded_retry<T>(
    mut attempt: impl FnMut(T) -> PushAttemptOutcome<T>,
    mut item: T,
    max_attempts: u32,
    retry_interval: Duration,
    overflow_count: &AtomicU64,
    exhausted_error: impl FnOnce() -> WrapError,
) -> Result<(), WrapError> {
    let attempts = max_attempts.max(1);
    for i in 0..attempts {
        match attempt(item) {
            PushAttemptOutcome::Sent => return Ok(()),
            PushAttemptOutcome::Fatal(e) => return Err(e),
            PushAttemptOutcome::Full(returned) => {
                item = returned;
                if i + 1 < attempts {
                    std::thread::sleep(retry_interval);
                }
            }
        }
    }
    overflow_count.fetch_add(1, Ordering::Relaxed);
    Err(exhausted_error())
}

// link-audio と clap-host の併用は現状未対応（1 つの cpal callback で LinkAudio per-channel egress と
// CLAP master-bus post-processor の render 順序を統合する設計が defer・Issue #340）。両方有効なビルドは
// 早期に弾く（`start()` の cfg 分岐も両者排他なので、これが無いと start() 未定義でわかりにくく落ちる）。
#[cfg(all(feature = "link-audio", feature = "clap-host"))]
compile_error!(
    "features `link-audio` and `clap-host` are mutually exclusive for now \
     (combined cpal-callback render ordering is deferred — Issue #340)"
);

// γ M1 PR-C: out-of-process effect も master-bus post-processor 経路（cpal callback への単一注入）
// なので、in-process CLAP（clap-host）/ LinkAudio egress（link-audio）とは併用不可。3-way 排他を
// compile-time に固定する（start() の cfg 分岐も 3 者排他前提なので、これが無いと未定義 start() で
// わかりにくく落ちる）。
#[cfg(all(feature = "outproc-effect", feature = "clap-host"))]
compile_error!(
    "features `outproc-effect` and `clap-host` are mutually exclusive \
     (both own the single master-bus post-processor seam)"
);
#[cfg(all(feature = "outproc-effect", feature = "link-audio"))]
compile_error!(
    "features `outproc-effect` and `link-audio` are mutually exclusive \
     (both integrate the single cpal callback)"
);
#[cfg(all(feature = "outproc-instrument", feature = "clap-host"))]
compile_error!(
    "features `outproc-instrument` and `clap-host` are mutually exclusive \
     (both own the single master-bus post-processor seam)"
);
#[cfg(all(feature = "outproc-instrument", feature = "link-audio"))]
compile_error!(
    "features `outproc-instrument` and `link-audio` are mutually exclusive \
     (both integrate the single cpal callback)"
);
