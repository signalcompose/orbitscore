//! Engine + ロード済みサンプル / 再生管理の wrapper。
//!
//! `Arc<Mutex>` ベースで制御スレッドと audio callback を共有する。
//! audio callback 側は `try_lock` で競合時に無音 fallback する前提（lock-free 化は別 Issue）。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
use std::sync::MutexGuard;
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
use std::sync::Weak;
use std::sync::{Arc, Mutex};
#[cfg(any(
    feature = "clap-host",
    feature = "outproc-effect",
    feature = "outproc-instrument"
))]
use std::time::Duration;

use orbit_audio_core::{resolve_slice_region, sanitize_rate, Engine, Sample};
#[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
use orbit_audio_native::PostProcessor;
use orbit_audio_native::{
    load_sample_resampled, LoaderError, OutputError, OutputStream, ResampleError, StreamStats,
    StreamStatsSnapshot,
};
use uuid::Uuid;

use crate::backend::AudioBackend;

#[derive(Debug, thiserror::Error)]
pub enum WrapError {
    #[error("audio output init failed: {0}")]
    Output(#[from] OutputError),
    #[error("loader error: {0}")]
    Loader(#[from] LoaderError),
    #[error("resample error: {0}")]
    Resample(#[from] ResampleError),
    #[error("sample not found: {0}")]
    SampleNotFound(String),
    #[error("scheduler error: {0}")]
    Scheduler(String),
    /// LinkAudio egress がこの daemon ビルド/インスタンスで利用できない（feature `link-audio` 無効、
    /// または test backend）。TS 層は feature-gap として warn-once で握り潰す（出力は hardware のみ）。
    #[error("link audio unavailable: {0}")]
    LinkAudioUnavailable(String),
    /// LinkAudio egress は利用可能だが registration が runtime で失敗した（channel 上限・consumer thread
    /// 不在・reg-ring 満杯・mutex poison 等）。TS 層は feature-gap と区別して rethrow する。
    #[error("link audio runtime error: {0}")]
    LinkAudio(String),
    /// CLAP plugin hosting がこの daemon ビルド/インスタンスで利用できない（feature `clap-host`
    /// 無効、または test backend）。TS 層は feature-gap として warn-once で握り潰す。
    #[error("clap host unavailable: {0}")]
    ClapUnavailable(String),
    /// CLAP plugin hosting は利用可能だが runtime で失敗した（load/activate 失敗・install ring 満杯・
    /// 専用スレッド不在・mutex poison 等）。TS 層は feature-gap と区別して rethrow する。
    #[error("clap host runtime error: {0}")]
    Clap(String),
    /// in-process CLAP host は単一 slot のため、先にロード済みの role と異なる再ロードを拒否する。
    #[error("clap cross-role load rejected: {0}")]
    ClapCrossRoleRejected(String),
    /// CLAP plugin hosting は利用可能だが、まだ一度も `load_plugin` に成功していない（#405）。
    /// feature-gap（`ClapUnavailable`）でも汎用 runtime エラー（`Clap`）でもなく、専用コードにすることで
    /// クライアントが「LoadPlugin をまだ呼んでいない／失敗した」ことを actionable に判定できるようにする
    /// （`push_plugin_event` の未ロードガードが返す）。
    #[error("clap plugin not loaded: {0}")]
    ClapNotLoaded(String),
    /// out-of-process effect がこの daemon ビルド/インスタンスで利用できない（feature `outproc-effect`
    /// 無効、または設定不足）。TS 層は feature-gap として warn-once で握り潰す（γ M1 PR-C）。
    #[error("out-of-process effect unavailable: {0}")]
    OutProcEffectUnavailable(String),
    /// out-of-process effect は利用可能だが runtime で失敗した（shm 作成失敗・child spawn 失敗・
    /// mutex poison 等）。TS 層は feature-gap と区別して rethrow する。
    #[error("out-of-process effect runtime error: {0}")]
    OutProcEffect(String),
    /// out-of-process instrument がこの daemon ビルド/インスタンスで利用できない。
    #[error("out-of-process instrument unavailable: {0}")]
    OutProcInstrumentUnavailable(String),
    /// out-of-process instrument の runtime failure。
    #[error("out-of-process instrument runtime error: {0}")]
    OutProcInstrument(String),
    /// child launch 後の attach が失敗したが、shm slot は復元済みで再試行可能。
    #[error("out-of-process attach failed: {0}")]
    OutProcAttachFailed(String),
    /// OOP slot が永久に closed（起動インフラの失敗）。
    #[error("out-of-process slot closed: {0}")]
    OutProcSlotClosed(String),
}

/// 共有可能なエンジン wrapper。
///
/// `cpal::Stream` は `!Send` のため、ここには持ち込まない。
/// [`start`] が返す [`StreamGuard`] を main 側で alive に保つ責務。
pub struct EngineWrap {
    engine: Engine,
    sample_rate: u32,
    channels: u16,
    samples: Mutex<HashMap<String, Sample>>,
    started_at: std::time::Instant,
    stream_stats: Arc<StreamStats>,
    /// Stop 経由で停止済みの play_id。PlayEnded 遅延タスクが自然発火を抑制するために参照する。
    /// PlayEnded 発火時に take（remove）されるため、通常ケースでは事後掃除不要。
    stopped_play_ids: Mutex<HashSet<String>>,
    /// LinkAudio egress drop の **test 注入用** カウンタ（本番は常に 0）。`link_egress_ring_drops`
    /// がこれを加算する。integration test は `StubBackend` を使い `LinkAudioControl` を持たない
    /// （= 実 drop 源が無い）ため、この counter が link-audio feature の有無に依らず 1 Hz ticker の
    /// LINK_EGRESS_DROP 発火を駆動する唯一の seam になる（[`Self::link_egress_drops_arc`]）。
    /// 本番の drop は `LinkAudioControl::total_ring_drops`（GPL `link-audio` 側）が供給するので、
    /// production read-path ではこの addend は常に 0。`stream_stats` の `record_xrun`（本番と同一
    /// atomic を書く統合 seam）とは異なり、これは本番経路から分離した並行カウンタである点に注意。
    link_egress_drops: Arc<AtomicU64>,
    /// CLAP plugin `process()` エラーの **test 注入用** カウンタ（本番は常に 0）。
    /// `clap_process_error_count` がこれを加算する。integration test は plugin をロードしない
    /// （= 実 error 源が無い）ため、この counter が clap-host feature の有無に依らず 1 Hz ticker の
    /// CLAP_PROCESS_ERROR 発火を駆動する唯一の seam になる（[`Self::clap_process_errors_arc`]）。
    /// 本番の error は clap mutex 内の `ClapProcessorStats::process_error_count` が供給するので、
    /// production read-path ではこの addend は常に 0（`link_egress_drops` と同設計）。
    clap_process_errors: Arc<AtomicU64>,
    /// `load_plugin` が成功したことがあるかどうか（#405）。`push_plugin_event` がこれを見て、
    /// 未ロード時は「fire-and-forget ring に投げてから黙って捨てられる」のでなく、明示的な
    /// error を即座に返すようにする。一度 true になったら false に戻ることはない（hot-unload
    /// 機構が存在しないため・厳密な非同期状態追跡はしない）。`clap`/`link`/`outproc` と同様
    /// feature `clap-host` 専用（読み書きとも clap-host 経路にしかない）。
    #[cfg(feature = "clap-host")]
    plugin_loaded: AtomicBool,
    /// OOP effect `frames_clamped` の **test 注入用** カウンタ（本番は常に 0）。`outproc_health` が
    /// これを加算する。integration test は child process を spawn しない（= 実 clamp 源が無い）ため、
    /// この counter が outproc-effect feature の有無に依らず 1 Hz ticker の
    /// OUTPROC_EFFECT_FRAMES_CLAMPED 発火を駆動する唯一の seam になる（[`Self::outproc_frames_clamped_arc`]）。
    /// `link_egress_drops` / `clap_process_errors` と同設計（#406 /simplify: 専用 seam が無いと
    /// この signal はどのテストからも exercise できなかった）。
    outproc_frames_clamped: Arc<AtomicU64>,
    /// OOP instrument `output_event_dropped_count`（M2 §4.2 output 方向の真の loss）の **test 注入用**
    /// カウンタ（本番は常に 0）。`outproc_instrument_health` が real stats（feature
    /// `outproc-instrument` 時のみ存在）にこれを加算する。integration test は instrument child
    /// process を spawn しない（= 実 drop 源が無い）ため、この counter が outproc-instrument feature
    /// の有無に依らず 1 Hz ticker の OUTPROC_INSTRUMENT_OUTPUT_DROPPED 発火を駆動する唯一の seam に
    /// なる（[`Self::outproc_instrument_output_dropped_arc`]）。`outproc_frames_clamped` と同設計
    /// （PR #422 round 2 review: 追加済みの counter が daemon health 経路に配線されていなかった）。
    outproc_instrument_output_dropped: Arc<AtomicU64>,
    /// OOP instrument `child_process_error_count`(child の CLAP `process()` 呼び出し失敗) の
    /// **test 注入用** カウンタ（本番は常に 0）。`outproc_instrument_health` が real stats
    /// （feature `outproc-instrument` 時のみ存在）にこれを加算する。integration test は instrument
    /// child process を spawn しない（= 実 error 源が無い）ため、この counter が
    /// outproc-instrument feature の有無に依らず 1 Hz ticker の OUTPROC_INSTRUMENT_ERROR 発火を
    /// 駆動する唯一の seam になる（[`Self::outproc_instrument_child_errors_arc`]）。
    /// `outproc_instrument_output_dropped` と同設計（PR #422 round 3: code-reviewer 指摘 — effect
    /// 側の `OUTPROC_EFFECT_ERROR`/`_RESPAWN`/`_INVALID` に相当する instrument 側 signal が
    /// daemon health 経路に配線されていなかった）。
    outproc_instrument_child_errors: Arc<AtomicU64>,
    /// OOP instrument `respawn_count`(child crash → watchdog respawn 回数) の **test 注入用**
    /// カウンタ（本番は常に 0）。`outproc_instrument_child_errors` と同設計。
    outproc_instrument_respawns: Arc<AtomicU64>,
    /// OOP instrument `measurement_invalid`(watchdog が respawn/try_wait を諦め、計測が恒久的に
    /// 無効になったフラグ) の **test 注入用** フラグ（本番は常に false）。数値カウンタではなく
    /// 恒久 bool のため `AtomicBool` を使うが、他の `outproc_instrument_*` 注入用フィールドと同じ
    /// 「本番経路から分離した cross-thread 注入 seam」設計（[`Self::outproc_instrument_measurement_invalid_arc`]）。
    outproc_instrument_measurement_invalid: Arc<AtomicBool>,
    /// `push_plugin_event` が bounded retry（[`push_with_bounded_retry`]）の末に諦めた回数（本番は
    /// 常に 0 に近い想定・health signal）。event ring は audio callback が毎 block 全量 drain する
    /// ため満杯は一時的であり、真の drop はこの回数だけ発生する（M2 doc の「溢れても失わない」方針を
    /// in-process ring に retrofit・issue #400）。`EngineWrap` は常に `Arc<EngineWrap>` として共有
    /// されるため、`link_egress_drops`/`clap_process_errors` と異なり test 注入用の `_arc()` getter
    /// が不要。本番の bounded retry 書き込みも test 注入用の
    /// [`plugin_event_ring_overflow_inject`](Self::plugin_event_ring_overflow_inject)（#402）も、
    /// producer 側を別スレッドへ outsource せず常に `&self` 経由で `EngineWrap` 自身が直接書くため、
    /// `Arc` clone による cross-thread 共有が不要で、プレーンな `AtomicU64` で足りる。
    plugin_event_ring_overflow_count: AtomicU64,
    /// LinkAudio egress の control-side ハンドル（feature `link-audio` 専用・A4-2b-2）。
    /// reg-ring push / mpsc send が内部可変性（`&mut LinkAudioControl`）を要する一方、`EngineWrap`
    /// は `Arc` 共有で `&self` しか持てない。`Mutex` で内包することで `register_link_audio_channel`
    /// を `&self` のまま提供する。本番 `start()` で `Some`、test backend 経路では `None`。
    #[cfg(feature = "link-audio")]
    link: Mutex<Option<crate::link_audio::LinkAudioControl>>,
    /// CLAP plugin hosting の control-side ハンドル（feature `clap-host` 専用・Issue #340）。
    /// 専用スレッドへの `cmd_tx`（LoadPlugin）/ audio thread への `event_tx`（note）/ 統計を保持する。
    /// rtrb `Producer` は `push` に `&mut self` が要り `!Sync`。`Sender`（Send+Sync）ともども 1 つの
    /// `Mutex` に内包し `&self` のまま提供する。本番 `start()` で `Some`、test backend 経路では `None`。
    #[cfg(feature = "clap-host")]
    clap: Mutex<Option<ClapControl>>,
    /// out-of-process effect の control-side ハンドル（feature `outproc-effect` 専用・γ M1 PR-C）。
    /// 観測 stats（fresh/stale/stall/respawn/child error）と callback-duration stats を保持する。
    /// 本番 `start()` で `Some`、test backend 経路では `None`（`clap` / `link` と同設計）。
    #[cfg(feature = "outproc-effect")]
    outproc: Mutex<Option<OutProcControl>>,
    /// out-of-process instrument の note-ring producer（control side）。
    #[cfg(feature = "outproc-instrument")]
    outproc_instrument: Mutex<Option<OutProcInstrumentControl>>,
}

/// out-of-process effect の control-side ハンドル一式（feature `outproc-effect` 専用）。
/// supervisor 本体（watchdog / child）は `StreamGuard::_child_guard` が保持する。ここは accessor が
/// 読む観測 stats だけを持つ（`ClapControl` と同様 read-path のハンドル）。
#[cfg(feature = "outproc-effect")]
struct OutProcControl {
    /// 観測 stats（fresh/stale/stall/frames_clamped/callback_count/respawn/child error）。
    /// adapter（audio thread）と watchdog（control thread）が書き、accessor / gated harness が読む。
    stats: Arc<crate::outproc_effect::OutProcEffectStats>,
    /// callback-duration 統計（A0 §6: CoreAudio+cpal は xrun 不発火 → RT 健全性は callback 実測時間で測る）。
    cb_stats: Arc<orbit_audio_native::CallbackTimeStats>,
    /// post-boot attach の状態。`StreamGuard` と共有し、supervisor は stream より後に drop する。
    child_slot: Weak<Mutex<ChildSlot>>,
    /// 起動時に固定した named insert bus の effect slots。master slot は `child_slot` のまま
    /// 保持し、bus 無し LoadPlugin の後方互換を保つ。
    bus_slots: HashMap<String, Weak<Mutex<ChildSlot>>>,
    /// bus 名 → その bus の `OutProcEffectStats`（`outproc_effect_bus_stats` gated 計測用）。
    /// `bus_slots` と同じキー集合で、child の生死に関わらず統計自体は生存し続けるため強参照。
    bus_stats: HashMap<String, Arc<crate::outproc_effect::OutProcEffectStats>>,
}

/// `ORBIT_EFFECT_BUSES` の値を解析する純関数。カンマ区切りの bus 名を trim・空要素除去した上で、
/// 重複や NUL 文字を含む名前を拒否する。env 直読みを避けることで unit テスト可能にする
/// （`PluginFormat::from_env_value` / `parse_buffer_frames` と同じ「値渡し純関数 + env 読みラッパー」
/// の慣習に合わせる）。
#[cfg(feature = "outproc-effect")]
fn parse_effect_buses(raw: &str) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    raw.split(',')
        .filter_map(|s| {
            let s = s.trim();
            (!s.is_empty()).then(|| s.to_owned())
        })
        .map(|bus| {
            if bus.contains('\0') || !seen.insert(bus.clone()) {
                Err(format!(
                    "ORBIT_EFFECT_BUSES contains duplicate or invalid bus '{bus}'"
                ))
            } else {
                Ok(bus)
            }
        })
        .collect()
}

#[cfg(feature = "outproc-effect")]
fn effect_buses_from_env() -> Result<Vec<String>, WrapError> {
    parse_effect_buses(&std::env::var("ORBIT_EFFECT_BUSES").unwrap_or_default())
        .map_err(WrapError::OutProcEffect)
}

#[cfg(all(test, feature = "outproc-effect"))]
mod effect_buses_from_env_tests {
    use super::parse_effect_buses;

    #[test]
    fn empty_string_yields_no_buses() {
        assert_eq!(parse_effect_buses(""), Ok(Vec::new()));
    }

    #[test]
    fn whitespace_only_yields_no_buses() {
        assert_eq!(parse_effect_buses("   "), Ok(Vec::new()));
    }

    #[test]
    fn parses_comma_separated_names_and_trims_whitespace() {
        assert_eq!(
            parse_effect_buses(" fx1 ,fx2"),
            Ok(vec!["fx1".to_owned(), "fx2".to_owned()])
        );
    }

    #[test]
    fn skips_empty_elements_between_commas() {
        assert_eq!(
            parse_effect_buses("fx1,,fx2,"),
            Ok(vec!["fx1".to_owned(), "fx2".to_owned()])
        );
    }

    #[test]
    fn rejects_duplicate_bus_names() {
        let error = parse_effect_buses("fx1,fx1").expect_err("duplicate must be rejected");
        assert!(error.contains("duplicate"), "unexpected message: {error}");
    }

    #[test]
    fn rejects_nul_byte_in_bus_name() {
        let error =
            parse_effect_buses("fx1,fx\x002").expect_err("NUL byte in name must be rejected");
        assert!(error.contains("invalid"), "unexpected message: {error}");
    }
}

#[cfg(feature = "outproc-instrument")]
struct OutProcInstrumentControl {
    /// Control threadで構築済みの NeutralEvent を audio thread へ渡す producer。
    event_tx: rtrb::Producer<orbit_audio_sandbox::NeutralEvent>,
    /// Audio adapter と watchdog が更新し、gated harness が読む観測 stats。
    stats: Arc<crate::outproc_instrument::OutProcInstrumentStats>,
    /// post-boot attach の状態。`StreamGuard` と共有し、supervisor は stream より後に drop する。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    child_slot: Weak<Mutex<ChildSlot<InstrumentRole>>>,
    #[cfg(not(all(feature = "outproc-effect", feature = "outproc-instrument")))]
    child_slot: Weak<Mutex<ChildSlot>>,
}

/// instrument の add-mix 後に effect の serial insert を適用する RT 専用の合成 processor。
#[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
struct CompositePostProcessor {
    instrument: crate::outproc_instrument::OutProcInstrumentPostProcessor,
    effect: crate::outproc_effect::OutProcEffectPostProcessor,
}

#[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
impl PostProcessor for CompositePostProcessor {
    fn process(&mut self, data: &mut [f32]) {
        self.instrument.process(data);
        self.effect.process(data);
    }
}

/// OOP role ごとの差分を child-slot state machine から分離する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) trait OutProcRole: Sized {
    /// `Send + Sync` は生産コード上も既に前提（watchdog スレッドが `Arc<Self::Stats>` を共有する）。
    /// ジェネリックなテストヘルパーが `Arc<Mutex<ChildSlot<R>>>` をスレッド間で受け渡す際、
    /// コンパイラにその前提を明示するために必要。
    type Stats: Send + Sync;
    type Supervisor: Send;
    const ROLE_NAME: &'static str;

    fn spawn_child(
        launch: &ChildLaunch<Self>,
        path: &std::path::Path,
        plugin_id: Option<&str>,
    ) -> std::io::Result<std::process::Child>;
    fn spawn_supervisor(
        child: std::process::Child,
        launch: &ChildLaunch<Self>,
        path: PathBuf,
        plugin_id: Option<String>,
    ) -> std::io::Result<Self::Supervisor>;
    fn detach_keep_shm(supervisor: Self::Supervisor);
    fn role_matches(child_flags: u32) -> bool;
    fn runtime_error(message: String) -> WrapError;
    fn set_initial_attach_pending(stats: &Self::Stats, value: bool);
    fn set_child_early_exit(stats: &Self::Stats, value: bool);
    fn child_early_exit(stats: &Self::Stats) -> bool;
    fn set_current_child_pid(stats: &Self::Stats, pid: u32);
    /// Attach path で plugin format に依存する child を選び直す。effect は env 設定のまま。
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
    fn spawn_child(
        launch: &ChildLaunch<Self>,
        path: &std::path::Path,
        plugin_id: Option<&str>,
    ) -> std::io::Result<std::process::Child> {
        crate::outproc_effect::spawn_effect_child(
            &launch.child_exe,
            &launch.shm_path,
            path,
            plugin_id,
            launch.sample_rate,
        )
    }
    fn spawn_supervisor(
        child: std::process::Child,
        launch: &ChildLaunch<Self>,
        path: PathBuf,
        plugin_id: Option<String>,
    ) -> std::io::Result<Self::Supervisor> {
        crate::outproc_effect::EffectChildSupervisor::spawn(
            child,
            launch.shm_path.clone(),
            launch.stats.clone(),
            launch.child_exe.clone(),
            path,
            plugin_id,
            launch.sample_rate,
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
    fn set_child_early_exit(stats: &Self::Stats, value: bool) {
        stats.child_early_exit.store(value, Ordering::Release);
    }
    fn child_early_exit(stats: &Self::Stats) -> bool {
        stats.child_early_exit.load(Ordering::Acquire)
    }
    fn set_current_child_pid(stats: &Self::Stats, pid: u32) {
        stats.current_child_pid.store(pid, Ordering::Relaxed);
    }
    fn select_child_exe(
        _launch: &mut ChildLaunch<Self>,
        _path: &std::path::Path,
    ) -> Result<(), String> {
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
    fn spawn_child(
        launch: &ChildLaunch<Self>,
        path: &std::path::Path,
        plugin_id: Option<&str>,
    ) -> std::io::Result<std::process::Child> {
        crate::outproc_instrument::spawn_instrument_child(
            &launch.child_exe,
            &launch.shm_path,
            path,
            plugin_id,
            launch.sample_rate,
        )
    }
    fn spawn_supervisor(
        child: std::process::Child,
        launch: &ChildLaunch<Self>,
        path: PathBuf,
        plugin_id: Option<String>,
    ) -> std::io::Result<Self::Supervisor> {
        crate::outproc_instrument::InstrumentChildSupervisor::spawn(
            child,
            launch.shm_path.clone(),
            launch.stats.clone(),
            launch.child_exe.clone(),
            path,
            plugin_id,
            launch.sample_rate,
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
    fn set_child_early_exit(stats: &Self::Stats, value: bool) {
        stats.child_early_exit.store(value, Ordering::Release);
    }
    fn child_early_exit(stats: &Self::Stats) -> bool {
        stats.child_early_exit.load(Ordering::Acquire)
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
        engaged: Arc<AtomicBool>,
        _supervisor: R::Supervisor,
    },
    Closed,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) struct ChildLaunch<R: OutProcRole = DefaultOutProcRole> {
    shm_path: PathBuf,
    child_exe: PathBuf,
    sample_rate: u32,
    stats: Arc<R::Stats>,
    engaged: Arc<AtomicBool>,
    cleanup_shm_on_drop: bool,
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
struct ShmCleanupGuard {
    path: PathBuf,
    armed: bool,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl ShmCleanupGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
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
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
const CHILD_READY_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
const CHILD_READY_POLL: Duration = Duration::from_millis(10);

/// CLAP host の control-side ハンドル一式（feature `clap-host` 専用）。
#[cfg(feature = "clap-host")]
struct ClapControl {
    /// 専用スレッドへ `LoadPlugin` を送る Sender。
    cmd_tx: std::sync::mpsc::Sender<crate::clap_host::ClapCommand>,
    /// 単一 CLAP slot に正常ロード済みの plugin role。成功応答後だけ更新する。
    loaded_role: Option<ClapPluginRole>,
    /// audio thread（cpal callback の `ClapPostProcessor`）へ note を渡す event ring producer。
    event_tx: rtrb::Producer<orbit_clap_host::PluginEvent>,
    /// CLAP processor 統計（post-mix peak / process error 等）。daemon が読む。
    stats: Arc<orbit_clap_host::ClapProcessorStats>,
    /// callback-duration 統計（A0 §6: CoreAudio+cpal は xrun 不発火 → RT 健全性は callback 実測時間で
    /// 測る）。daemon の RT 監視 / gated test の budget 検証が読む。
    cb_stats: Arc<orbit_audio_native::CallbackTimeStats>,
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
const CLAP_MAX_FRAMES: u32 = 8192;

/// event ring への bounded retry の再試行間隔。
#[cfg(feature = "clap-host")]
const PLUGIN_EVENT_RETRY_INTERVAL: Duration = Duration::from_millis(1);
/// 最大再試行回数（≈200ms 上限）。event ring の consumer（audio callback）は毎 block ごとに
/// ring を全量 drain するため、通常は最初の数回で空きが生まれる。この上限は大きめの buffer
/// 構成（cpal callback 周期が長いケース）でも安全にカバーする余裕を持たせた値であり、
/// 「ここまで待っても空かない」を真の overflow とみなす閾値。
#[cfg(feature = "clap-host")]
const PLUGIN_EVENT_RETRY_MAX_ATTEMPTS: u32 = 200;

/// 1回の push 試行の結果。`Fatal` はリトライしても解決しない状態（mutex poisoned / clap 未初期化）
/// を表し、bounded retry ループを即座に打ち切る。
#[cfg(feature = "clap-host")]
enum PushAttemptOutcome<T> {
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
#[cfg(feature = "clap-host")]
fn push_with_bounded_retry<T>(
    mut attempt: impl FnMut(T) -> PushAttemptOutcome<T>,
    mut item: T,
    max_attempts: u32,
    retry_interval: Duration,
    overflow_count: &AtomicU64,
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
    Err(WrapError::Clap(
        "plugin event ring full after bounded retry".into(),
    ))
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

/// `cpal::Stream` を保持する guard。drop されるとストリーム停止。`!Send`。
///
/// ## `link-audio` ビルド時（`_stream` → `_link`）
/// **この 2 フィールドの順は UB 安全だが意図的**（advisor #2）: `_stream` を先に drop して cpal
/// callback（ring の push 元）を止めてから `_link`（consumer thread を signal+join）を drop する。
/// rtrb はどちらの順でも UB にならない（逆順なら callback が undrained ring に push して drop
/// カウントするだけ）が、teardown 時の無駄な drop を避けるためこの順にしてある。reorder 禁止。
///
/// ## `clap-host` ビルド時（`_clap_teardown` → `_stream` → `_clap_thread`・carry-forward #1）
/// **この順は load-bearing**（UB 回避・上の link-audio とは性質が異なる）:
/// - `_clap_teardown` が先 = audio thread の callback で `stop_processing()` を済ませてから stream を
///   止める。逆順だと `StartedPluginAudioProcessor` が stream（callback）停止後に残り、wrong-thread
///   での暗黙 stop_processing/drop = CLAP 仕様違反（strict plugin で UB）。
/// - `_clap_thread` が後 = stream 停止後に専用スレッドを join し、instance の home thread で deactivate。
///
/// ## `outproc-effect` ビルド時（`_outproc_teardown` → `_stream` → `_child_guard`・γ M1 PR-C）
/// clap-host と同型の load-bearing 順:
/// - `_outproc_teardown` が先 = audio thread の adapter を quiesce（transport submit 停止）してから stream を止める。
/// - `_child_guard` が後 = stream 停止後に watchdog を止め child を QUIT/reap し shm を unlink する。
///
/// `outproc-instrument` も同じ teardown ordering を専用 guard/supervisor で維持する。
///
/// `clap-host` / `link-audio` は outproc family と引き続き `compile_error!` で排他である。一方
/// `outproc-effect` と `outproc-instrument` は both build で共存でき、その場合は両 child guard が
/// 同時に存在する。
pub struct StreamGuard {
    /// carry-forward #1（clap-host）: stream 停止 **前** に drop され、audio thread で `stop_processing`
    /// を済ませる（`ClapTeardownGuard::drop` が teardown_requested を立て teardown_done を待つ）。
    /// **field 順は load-bearing**: これは `_stream` より前に宣言する（Rust の field drop 順 = 宣言順）。
    #[cfg(feature = "clap-host")]
    _clap_teardown: crate::clap_host::ClapTeardownGuard,
    /// γ M1 PR-C（outproc-effect）: stream 停止 **前** に drop され、audio thread の adapter を quiesce
    /// させる（transport への submit を止めて dry 素通しに入る）。**field 順は load-bearing**: `_stream`
    /// より前に宣言する（clap-host とは feature 排他なので同時には存在しない）。
    #[cfg(feature = "outproc-effect")]
    _outproc_teardown: crate::outproc_effect::OutProcTeardownGuard,
    #[cfg(feature = "outproc-effect")]
    _outproc_bus_teardowns: Vec<crate::outproc_effect::OutProcTeardownGuard>,
    /// outproc-instrument: stream 前に audio-thread adapter を quiesce する。
    /// both build における `_outproc_teardown` との相対順序は load-bearing ではない
    /// （各 guard は自 role 専用の requested/done atomic のみを操作し共有状態がない。
    /// stream 停止後の child guard 2つと同じ独立性）。
    #[cfg(feature = "outproc-instrument")]
    _outproc_instrument_teardown: crate::outproc_instrument::OutProcInstrumentTeardownGuard,
    _stream: OutputStream,
    #[cfg(feature = "link-audio")]
    _link: Option<crate::link_audio::LinkAudioGuard>,
    /// clap-host: stream 停止 **後** に drop され、専用スレッドを停止 → `ClapHost::shutdown()` で
    /// instance を deactivate（instance の home thread）。**field 順は load-bearing**: `_stream` より
    /// 後に宣言する。
    #[cfg(feature = "clap-host")]
    _clap_thread: crate::clap_host::ClapThreadGuard,
    /// γ M1 PR-C（outproc-effect）: stream 停止 **後** に drop され、watchdog を止めて（respawn 停止）
    /// child へ QUIT → reap → shm unlink する。**field 順は load-bearing**: `_stream` より後に宣言する。
    #[cfg(feature = "outproc-effect")]
    _child_guard: Arc<Mutex<ChildSlot>>,
    #[cfg(feature = "outproc-effect")]
    _bus_child_guards: Vec<Arc<Mutex<ChildSlot>>>,
    /// both build では同種 guard 間の順序は load-bearing ではない（どちらも stream 停止後）。別々の
    /// child process / shm region を持ち supervisor 間に共有状態が無いため、独立に teardown できる。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    _instrument_child_guard: Arc<Mutex<ChildSlot<InstrumentRole>>>,
    #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
    _child_guard: Arc<Mutex<ChildSlot>>,
}

impl StreamGuard {
    /// capture seam（#307 realtime）: capture 有効時のみ producer-side drop 累積を返す（無効は `None`）。
    /// `Some(0)` は録音健全・`> 0` は録音破損（検証 invalid）。gated 検証ハーネスが teardown 前に
    /// assert する（`_stream: OutputStream` へ委譲）。全 feature variant が `_stream` を持つので共通。
    pub fn capture_drops(&self) -> Option<u64> {
        self._stream.capture_drops()
    }
}

/// 生の env 値（`Some(raw)`）を capture 出力先 [`PathBuf`] へ解決する純関数（`capture_path_from_env`
/// の testable コア）。未設定 / 空 / 空白のみは `None`（capture 無効）。trim した値から `PathBuf` を
/// 組む（`"  /tmp/x.wav  "` のような前後空白を含む env でも正しいパスになる）。
fn resolve_capture_path(raw: Option<String>) -> Option<PathBuf> {
    let raw = raw?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// capture seam（#307）: 環境変数 `ORBIT_CAPTURE_WAV` を解決して whole-stream WAV 録音の出力先を
/// 返す（未設定 / 空文字列なら `None` = capture 無効）。**env 読取りは daemon 層に集約**し、解決済み
/// パスを `orbit-audio-native` の `start_default_output*` へ typed で渡す（`OutProcEffectConfig` /
/// `buffer_frames` と同じ層分け＝native の公開 API に隠れた ambient env 依存を作らない）。
fn capture_path_from_env() -> Option<PathBuf> {
    match std::env::var("ORBIT_CAPTURE_WAV") {
        Ok(raw) => resolve_capture_path(Some(raw)),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            // 非 UTF-8 の値を握り潰すと「capture したつもりが無効」になるので operator に報告する。
            eprintln!("[capture] ORBIT_CAPTURE_WAV が非 UTF-8 のため無視した（capture 無効）");
            None
        }
    }
}

impl EngineWrap {
    /// Engine とストリーム guard を起動する（本番用、cpal 既定出力）。
    /// guard は caller（通常は main）が drop されるまで保持すること。
    ///
    /// 本番経路は `cpal::Stream` が `!Send` のため [`Self::start_with`] の
    /// `Box<dyn Any + Send>` guard 型に詰められない。そのため本番は専用パス。
    #[cfg(all(
        not(feature = "link-audio"),
        not(feature = "clap-host"),
        not(feature = "outproc-effect"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let (engine, stream, stream_stats) =
            orbit_audio_native::start_default_output(capture_path_from_env())?;
        let wrap = Self::build(engine, stream.sample_rate, stream.channels, stream_stats);
        Ok((wrap, StreamGuard { _stream: stream }))
    }

    /// feature `link-audio` 版: cpal 出力を LinkAudio egress 経路付きで起動し、GPL consumer thread を
    /// spawn する（A4-2b-2）。reg-ring producer は callback に組み込まれ、`register_link_audio_channel`
    /// 経由で channel を流す。返す `StreamGuard` が consumer thread の teardown guard を保持する。
    #[cfg(all(
        feature = "link-audio",
        not(feature = "clap-host"),
        not(feature = "outproc-effect"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let (engine, stream, stream_stats, reg_tx) =
            orbit_audio_native::start_default_output_with_link_egress(
                crate::link_audio::REG_RING_CAPACITY,
                capture_path_from_env(),
            )?;
        let (control, link_guard) = crate::link_audio::LinkAudioControl::spawn(
            reg_tx,
            stream.sample_rate,
            stream.channels as usize,
        )
        .map_err(|e| WrapError::LinkAudio(e.to_string()))?;
        let wrap = Self::build(engine, stream.sample_rate, stream.channels, stream_stats);
        *wrap
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))? = Some(control);
        Ok((
            wrap,
            StreamGuard {
                _stream: stream,
                _link: Some(link_guard),
            },
        ))
    }

    /// feature `clap-host` 版（Issue #340）: cpal 出力を CLAP master-bus post-processor 経路付きで
    /// 起動し、`orbit-clap-host` の `ClapHost`(!Send) を専用スレッドで動かす。`ClapPostProcessor`
    /// （`PostProcessor` 実装）を native callback に注入し、plugin の hot-install は install ring 経由で
    /// audio thread に渡す。返す `StreamGuard` が teardown guard（carry-forward #1）と専用スレッド
    /// guard を保持する（drop 順で stop_processing → stream 停止 → deactivate を強制）。
    #[cfg(all(
        feature = "clap-host",
        not(feature = "link-audio"),
        not(feature = "outproc-effect"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        // event ring 1024 / install ring 1（spike と同容量）。
        let (processor, parts) = orbit_clap_host::new_clap_host(1024, 1);
        let (engine, stream, stream_stats, cb_stats) =
            orbit_audio_native::start_default_output_with_clap(
                processor,
                None,
                capture_path_from_env(),
            )
            .map_err(WrapError::Output)?;
        // 専用スレッドを起動（!Send instance + pump をここで所有）。install ring producer を渡す。
        let (cmd_tx, thread_guard) = crate::clap_host::spawn_clap_thread(
            parts.callback_requested,
            parts.resize_count,
            parts.install_tx,
        );
        let wrap = Self::build(engine, stream.sample_rate, stream.channels, stream_stats);
        *wrap
            .clap
            .lock()
            .map_err(|_| WrapError::Clap("clap mutex poisoned".into()))? = Some(ClapControl {
            cmd_tx,
            loaded_role: None,
            event_tx: parts.event_producer,
            stats: parts.stats,
            cb_stats,
        });
        Ok((
            wrap,
            StreamGuard {
                _clap_teardown: crate::clap_host::ClapTeardownGuard::new(
                    parts.teardown_requested,
                    parts.teardown_done,
                ),
                _stream: stream,
                _clap_thread: thread_guard,
            },
        ))
    }

    /// feature `outproc-effect` 版（γ M1 PR-C・Issue #359）: cpal 出力を OOP effect master-bus
    /// post-processor 経路付きで起動する。production は環境変数から child 設定を組み、plugin は
    /// `LoadPlugin` で post-boot attach する。
    #[cfg(all(
        feature = "outproc-effect",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let cfg = crate::outproc_effect::OutProcEffectConfig::from_env()
            .map_err(WrapError::OutProcEffectUnavailable)?;
        Self::start_outproc_effect_post_boot(cfg)
    }

    /// 既存 gated harness 用の明示設定入口。従来どおり、返却前に設定済み plugin を attach する。
    #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
    pub fn start_outproc_effect(
        cfg: crate::outproc_effect::OutProcEffectConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let plugin = cfg
            .plugin
            .clone()
            .ok_or_else(|| WrapError::OutProcEffect("eager start requires a plugin path".into()))?;
        let plugin_id = cfg.plugin_id.clone();
        let (wrap, guard) = Self::start_outproc_effect_post_boot(cfg)?;
        wrap.load_outproc_plugin(plugin, plugin_id)?;
        Ok((wrap, guard))
    }

    /// production daemon の OOP effect 経路本体。
    /// shm → adapter → stream までを daemon boot 時に構築し、child supervisor は初回
    /// `LoadPlugin(role=effect)` まで遅延する。
    #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
    pub fn start_outproc_effect_post_boot(
        cfg: crate::outproc_effect::OutProcEffectConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        use crate::outproc_effect::{
            OutProcEffectPostProcessor, OutProcEffectStats, OutProcTeardownGuard,
        };
        use std::sync::atomic::AtomicBool;

        let bus_names = effect_buses_from_env()?;
        // Each registered bus owns a complete transport up front.  Attachment is the existing
        // lock-free `engaged` release-store, so the callback never allocates or locks.
        let mut bus_builds = Vec::with_capacity(bus_names.len());
        let mut insert_buses = Vec::with_capacity(bus_names.len());
        for name in &bus_names {
            let shm_path = crate::outproc_effect::unique_shm_path();
            let host = orbit_audio_sandbox::PipelinedEffectHost::from_mmap(
                orbit_audio_sandbox::create_shared(&shm_path).map_err(|e| {
                    WrapError::OutProcEffect(format!("create bus shm {shm_path:?}: {e}"))
                })?,
            );
            let engaged = Arc::new(AtomicBool::new(false));
            let stop = Arc::new(AtomicBool::new(false));
            let done = Arc::new(AtomicBool::new(false));
            let stats = OutProcEffectStats::new();
            insert_buses.push(orbit_audio_native::InsertBusStage::new(
                name.clone(),
                Some(Box::new(OutProcEffectPostProcessor::new(
                    host,
                    engaged.clone(),
                    stop.clone(),
                    done.clone(),
                    stats.clone(),
                ))),
                0,
            ));
            bus_builds.push((shm_path, engaged, stop, done, stats));
        }

        // 1. shm 作成 → host mmap（adapter が所有・audio thread）。
        let shm_path = crate::outproc_effect::unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&shm_path)
            .map_err(|e| WrapError::OutProcEffect(format!("create shm {shm_path:?}: {e}")))?;
        let mut shm_cleanup = ShmCleanupGuard::new(shm_path.clone());
        let host = orbit_audio_sandbox::PipelinedEffectHost::from_mmap(host_mmap);

        // 2. engaged ゲート + teardown flags + 観測 stats + adapter。
        let engaged = Arc::new(AtomicBool::new(false));
        let teardown_requested = Arc::new(AtomicBool::new(false));
        let teardown_done = Arc::new(AtomicBool::new(false));
        let stats = OutProcEffectStats::new();
        let processor = Box::new(OutProcEffectPostProcessor::new(
            host,
            engaged.clone(),
            teardown_requested.clone(),
            teardown_done.clone(),
            stats.clone(),
        ));

        // 3. cpal stream 起動（ここで device の sample_rate が確定する）。adapter を注入する。
        //    gated stale-rate harness は cfg.buffer_frames に 32/64 を渡し小バッファを要求する。
        let (engine, stream, stream_stats, cb_stats) =
            orbit_audio_native::start_default_output_with_insert_buses_and_post(
                insert_buses,
                processor,
                cfg.buffer_frames,
                capture_path_from_env(),
            )
            .map_err(WrapError::Output)?;
        let sample_rate = stream.sample_rate;

        // 4. child は初回 LoadPlugin まで作らない。engaged clone を slot に保持し、ready-ack 後に
        //    control thread から Release store できるようにする。
        let child_slot = Arc::new(Mutex::new(ChildSlot::Empty(ChildLaunch {
            shm_path,
            child_exe: cfg.child_exe.clone(),
            sample_rate,
            stats: stats.clone(),
            engaged,
            cleanup_shm_on_drop: true,
        })));
        // unlink 所有権を起動失敗用 guard から ChildLaunch へ移す。
        shm_cleanup.disarm();

        // 6. wrap 構築 + control 注入。
        let wrap = Self::build(engine, stream.sample_rate, stream.channels, stream_stats);
        *wrap
            .outproc
            .lock()
            .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))? =
            Some(OutProcControl {
                stats,
                cb_stats,
                child_slot: Arc::downgrade(&child_slot),
                bus_slots: HashMap::new(),
                bus_stats: HashMap::new(),
            });

        let mut bus_slots = HashMap::new();
        let mut bus_stats = HashMap::new();
        let mut bus_child_guards = Vec::with_capacity(bus_builds.len());
        let mut bus_teardowns = Vec::with_capacity(bus_builds.len());
        for (name, (shm_path, engaged, stop, done, stats)) in bus_names.into_iter().zip(bus_builds)
        {
            let slot = Arc::new(Mutex::new(ChildSlot::Empty(ChildLaunch {
                shm_path,
                child_exe: cfg.child_exe.clone(),
                sample_rate,
                stats: stats.clone(),
                engaged,
                cleanup_shm_on_drop: true,
            })));
            bus_slots.insert(name.clone(), Arc::downgrade(&slot));
            bus_stats.insert(name, stats);
            bus_child_guards.push(slot);
            bus_teardowns.push(OutProcTeardownGuard::new(stop, done));
        }
        {
            let mut guard = wrap
                .outproc
                .lock()
                .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
            let control = guard.as_mut().expect("outproc control installed");
            control.bus_slots = bus_slots;
            control.bus_stats = bus_stats;
        }

        // 7. StreamGuard（field 順 = teardown 順）。
        Ok((
            wrap,
            StreamGuard {
                _outproc_teardown: OutProcTeardownGuard::new(teardown_requested, teardown_done),
                _outproc_bus_teardowns: bus_teardowns,
                _stream: stream,
                _child_guard: child_slot,
                _bus_child_guards: bus_child_guards,
            },
        ))
    }

    /// feature `outproc-instrument` production entry point. Configuration is fixed at daemon
    /// startup; live note events continue to use the existing PluginNoteOn/PluginNoteOff methods.
    #[cfg(all(
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-effect")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let cfg = crate::outproc_instrument::OutProcInstrumentConfig::from_env()
            .map_err(WrapError::OutProcInstrumentUnavailable)?;
        Self::start_outproc_instrument_post_boot(cfg)
    }

    /// Existing gated-harness entry point. Preserves its pre-existing eager attach behavior.
    #[cfg(all(
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-effect")
    ))]
    pub fn start_outproc_instrument(
        cfg: crate::outproc_instrument::OutProcInstrumentConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let plugin = cfg.plugin.clone().ok_or_else(|| {
            WrapError::OutProcInstrument("eager start requires a plugin path".into())
        })?;
        let plugin_id = cfg.plugin_id.clone();
        let (wrap, guard) = Self::start_outproc_instrument_post_boot(cfg)?;
        wrap.load_outproc_plugin(plugin, plugin_id)?;
        Ok((wrap, guard))
    }

    /// Production daemon path: build transport and stream now, attach child on first LoadPlugin.
    #[cfg(all(
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-effect")
    ))]
    pub fn start_outproc_instrument_post_boot(
        cfg: crate::outproc_instrument::OutProcInstrumentConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        use crate::outproc_instrument::{
            OutProcInstrumentPostProcessor, OutProcInstrumentStats, OutProcInstrumentTeardownGuard,
            NOTE_RING_CAPACITY,
        };

        let shm_path = crate::outproc_instrument::unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&shm_path).map_err(|error| {
            WrapError::OutProcInstrument(format!("create shm {shm_path:?}: {error}"))
        })?;
        let mut shm_cleanup = ShmCleanupGuard::new(shm_path.clone());
        let host = orbit_audio_sandbox::PipelinedInstrumentHost::from_mmap(host_mmap);
        let (event_tx, event_rx) = rtrb::RingBuffer::new(NOTE_RING_CAPACITY);
        let engaged = Arc::new(AtomicBool::new(false));
        let teardown_requested = Arc::new(AtomicBool::new(false));
        let teardown_done = Arc::new(AtomicBool::new(false));
        let stats = OutProcInstrumentStats::new();
        let processor = Box::new(OutProcInstrumentPostProcessor::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged.clone(),
            teardown_requested.clone(),
            teardown_done.clone(),
            stats.clone(),
        ));

        let (engine, stream, stream_stats, _cb_stats) =
            orbit_audio_native::start_default_output_with_clap(
                processor,
                cfg.buffer_frames,
                capture_path_from_env(),
            )
            .map_err(WrapError::Output)?;
        let sample_rate = stream.sample_rate;

        let child_slot = Arc::new(Mutex::new(ChildSlot::Empty(ChildLaunch {
            shm_path,
            child_exe: cfg.child_exe,
            sample_rate,
            stats: stats.clone(),
            engaged,
            cleanup_shm_on_drop: true,
        })));
        // unlink 所有権を起動失敗用 guard から ChildLaunch へ移す。
        shm_cleanup.disarm();

        let wrap = Self::build(engine, stream.sample_rate, stream.channels, stream_stats);
        *wrap.outproc_instrument.lock().map_err(|_| {
            WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
        })? = Some(OutProcInstrumentControl {
            event_tx,
            stats,
            child_slot: Arc::downgrade(&child_slot),
        });

        Ok((
            wrap,
            StreamGuard {
                _outproc_instrument_teardown: OutProcInstrumentTeardownGuard::new(
                    teardown_requested,
                    teardown_done,
                ),
                _stream: stream,
                _child_guard: child_slot,
            },
        ))
    }

    /// both build の buffer size を解決する。両方指定され値が異なる場合は、RT 設定の暗黙優先を
    /// 作らず hard error にする。片方だけならその値、両方未指定なら `None` を使う。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn resolve_outproc_both_buffer_frames(
        effect: Option<u32>,
        instrument: Option<u32>,
    ) -> Result<Option<u32>, WrapError> {
        match (effect, instrument) {
            (Some(effect), Some(instrument)) if effect != instrument => Err(WrapError::OutProcEffect(format!(
                    "ORBIT_EFFECT_BUFFER_FRAMES ({effect}) and ORBIT_INSTRUMENT_BUFFER_FRAMES ({instrument}) must match"
                ))),
            (Some(value), _) | (_, Some(value)) => Ok(Some(value)),
            (None, None) => Ok(None),
        }
    }

    /// effect と instrument の transport を一つの callback に合成して起動する。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn start_outproc_both(
        effect_cfg: crate::outproc_effect::OutProcEffectConfig,
        instrument_cfg: crate::outproc_instrument::OutProcInstrumentConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        use crate::outproc_effect::{
            OutProcEffectPostProcessor, OutProcEffectStats, OutProcTeardownGuard,
        };
        use crate::outproc_instrument::{
            OutProcInstrumentPostProcessor, OutProcInstrumentStats, OutProcInstrumentTeardownGuard,
            NOTE_RING_CAPACITY,
        };
        let buffer_frames = Self::resolve_outproc_both_buffer_frames(
            effect_cfg.buffer_frames,
            instrument_cfg.buffer_frames,
        )?;

        let bus_names = effect_buses_from_env()?;
        // 同じ transport 構築を effect-only 経路（`start_outproc_effect_post_boot`）と共有する。
        // bus 0 個なら `insert_buses` は空 Vec になり、`start_default_output_with_insert_buses_and_post`
        // は従来の `start_default_output_with_clap` と等価に振る舞う。
        let mut bus_builds = Vec::with_capacity(bus_names.len());
        let mut insert_buses = Vec::with_capacity(bus_names.len());
        for name in &bus_names {
            let shm_path = crate::outproc_effect::unique_shm_path();
            let host = orbit_audio_sandbox::PipelinedEffectHost::from_mmap(
                orbit_audio_sandbox::create_shared(&shm_path).map_err(|e| {
                    WrapError::OutProcEffect(format!("create bus shm {shm_path:?}: {e}"))
                })?,
            );
            let engaged = Arc::new(AtomicBool::new(false));
            let stop = Arc::new(AtomicBool::new(false));
            let done = Arc::new(AtomicBool::new(false));
            let stats = OutProcEffectStats::new();
            insert_buses.push(orbit_audio_native::InsertBusStage::new(
                name.clone(),
                Some(Box::new(OutProcEffectPostProcessor::new(
                    host,
                    engaged.clone(),
                    stop.clone(),
                    done.clone(),
                    stats.clone(),
                ))),
                0,
            ));
            bus_builds.push((shm_path, engaged, stop, done, stats));
        }

        let effect_shm = crate::outproc_effect::unique_shm_path();
        let effect_host = orbit_audio_sandbox::PipelinedEffectHost::from_mmap(
            orbit_audio_sandbox::create_shared(&effect_shm)
                .map_err(|e| WrapError::OutProcEffect(format!("create shm {effect_shm:?}: {e}")))?,
        );
        let mut effect_shm_cleanup = ShmCleanupGuard::new(effect_shm.clone());
        let instrument_shm = crate::outproc_instrument::unique_shm_path();
        let instrument_host = orbit_audio_sandbox::PipelinedInstrumentHost::from_mmap(
            orbit_audio_sandbox::create_shared(&instrument_shm).map_err(|e| {
                WrapError::OutProcInstrument(format!("create shm {instrument_shm:?}: {e}"))
            })?,
        );
        let mut instrument_shm_cleanup = ShmCleanupGuard::new(instrument_shm.clone());
        let (event_tx, event_rx) = rtrb::RingBuffer::new(NOTE_RING_CAPACITY);
        let effect_engaged = Arc::new(AtomicBool::new(false));
        let instrument_engaged = Arc::new(AtomicBool::new(false));
        let effect_stop = Arc::new(AtomicBool::new(false));
        let effect_done = Arc::new(AtomicBool::new(false));
        let instrument_stop = Arc::new(AtomicBool::new(false));
        let instrument_done = Arc::new(AtomicBool::new(false));
        let effect_stats = OutProcEffectStats::new();
        let instrument_stats = OutProcInstrumentStats::new();
        let processor = Box::new(CompositePostProcessor {
            instrument: OutProcInstrumentPostProcessor::new(
                instrument_host,
                event_rx,
                NOTE_RING_CAPACITY,
                instrument_engaged.clone(),
                instrument_stop.clone(),
                instrument_done.clone(),
                instrument_stats.clone(),
            ),
            effect: OutProcEffectPostProcessor::new(
                effect_host,
                effect_engaged.clone(),
                effect_stop.clone(),
                effect_done.clone(),
                effect_stats.clone(),
            ),
        });
        let (engine, stream, stream_stats, effect_cb_stats) =
            orbit_audio_native::start_default_output_with_insert_buses_and_post(
                insert_buses,
                processor,
                buffer_frames,
                capture_path_from_env(),
            )
            .map_err(WrapError::Output)?;
        let effect_slot = Arc::new(Mutex::new(ChildSlot::Empty(ChildLaunch {
            shm_path: effect_shm,
            child_exe: effect_cfg.child_exe.clone(),
            sample_rate: stream.sample_rate,
            stats: effect_stats.clone(),
            engaged: effect_engaged,
            cleanup_shm_on_drop: true,
        })));
        // unlink 所有権を起動失敗用 guard から ChildLaunch へ移す。
        effect_shm_cleanup.disarm();
        let instrument_slot = Arc::new(Mutex::new(ChildSlot::<InstrumentRole>::Empty(
            ChildLaunch {
                shm_path: instrument_shm,
                child_exe: instrument_cfg.child_exe,
                sample_rate: stream.sample_rate,
                stats: instrument_stats.clone(),
                engaged: instrument_engaged,
                cleanup_shm_on_drop: true,
            },
        )));
        // unlink 所有権を起動失敗用 guard から ChildLaunch へ移す。
        instrument_shm_cleanup.disarm();
        let wrap = Self::build(engine, stream.sample_rate, stream.channels, stream_stats);
        *wrap
            .outproc
            .lock()
            .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))? =
            Some(OutProcControl {
                stats: effect_stats,
                cb_stats: effect_cb_stats,
                child_slot: Arc::downgrade(&effect_slot),
                bus_slots: HashMap::new(),
                bus_stats: HashMap::new(),
            });
        *wrap.outproc_instrument.lock().map_err(|_| {
            WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
        })? = Some(OutProcInstrumentControl {
            event_tx,
            stats: instrument_stats,
            child_slot: Arc::downgrade(&instrument_slot),
        });

        let mut bus_slots = HashMap::new();
        let mut bus_stats = HashMap::new();
        let mut bus_child_guards = Vec::with_capacity(bus_builds.len());
        let mut bus_teardowns = Vec::with_capacity(bus_builds.len());
        for (name, (shm_path, engaged, stop, done, stats)) in bus_names.into_iter().zip(bus_builds)
        {
            let slot = Arc::new(Mutex::new(ChildSlot::Empty(ChildLaunch {
                shm_path,
                child_exe: effect_cfg.child_exe.clone(),
                sample_rate: stream.sample_rate,
                stats: stats.clone(),
                engaged,
                cleanup_shm_on_drop: true,
            })));
            bus_slots.insert(name.clone(), Arc::downgrade(&slot));
            bus_stats.insert(name, stats);
            bus_child_guards.push(slot);
            bus_teardowns.push(OutProcTeardownGuard::new(stop, done));
        }
        {
            let mut guard = wrap
                .outproc
                .lock()
                .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
            let control = guard.as_mut().expect("outproc control installed");
            control.bus_slots = bus_slots;
            control.bus_stats = bus_stats;
        }

        Ok((
            wrap,
            StreamGuard {
                _outproc_teardown: OutProcTeardownGuard::new(effect_stop, effect_done),
                _outproc_bus_teardowns: bus_teardowns,
                _outproc_instrument_teardown: OutProcInstrumentTeardownGuard::new(
                    instrument_stop,
                    instrument_done,
                ),
                _stream: stream,
                _child_guard: effect_slot,
                _bus_child_guards: bus_child_guards,
                _instrument_child_guard: instrument_slot,
            },
        ))
    }

    #[cfg(all(
        feature = "outproc-effect",
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let effect = crate::outproc_effect::OutProcEffectConfig::from_env()
            .map_err(WrapError::OutProcEffectUnavailable)?;
        let instrument = crate::outproc_instrument::OutProcInstrumentConfig::from_env()
            .map_err(WrapError::OutProcInstrumentUnavailable)?;
        Self::start_outproc_both(effect, instrument)
    }

    /// [`AudioBackend`] 経由で起動する（integration test 用）。
    ///
    /// guard は `Box<dyn Any + Send>` の不透明ハンドル。scope 終了まで
    /// drop せずに保持する必要がある。
    pub fn start_with<B: AudioBackend>(
        backend: B,
    ) -> Result<(Arc<Self>, Box<dyn std::any::Any + Send>), WrapError> {
        let started = backend.start()?;
        let wrap = Self::build(
            started.engine,
            started.sample_rate,
            started.channels,
            started.stats,
        );
        Ok((wrap, started.guard))
    }

    /// `start` / `start_with` 共通の Arc<Self> 構築部。新しいフィールドが
    /// 追加された際、両経路で初期化漏れが起きないよう一箇所に集約する。
    fn build(
        engine: Engine,
        sample_rate: u32,
        channels: u16,
        stream_stats: Arc<StreamStats>,
    ) -> Arc<Self> {
        Arc::new(Self {
            engine,
            sample_rate,
            channels,
            samples: Mutex::new(HashMap::new()),
            started_at: std::time::Instant::now(),
            stream_stats,
            stopped_play_ids: Mutex::new(HashSet::new()),
            link_egress_drops: Arc::new(AtomicU64::new(0)),
            clap_process_errors: Arc::new(AtomicU64::new(0)),
            #[cfg(feature = "clap-host")]
            plugin_loaded: AtomicBool::new(false),
            outproc_frames_clamped: Arc::new(AtomicU64::new(0)),
            outproc_instrument_output_dropped: Arc::new(AtomicU64::new(0)),
            outproc_instrument_child_errors: Arc::new(AtomicU64::new(0)),
            outproc_instrument_respawns: Arc::new(AtomicU64::new(0)),
            outproc_instrument_measurement_invalid: Arc::new(AtomicBool::new(false)),
            plugin_event_ring_overflow_count: AtomicU64::new(0),
            // 本番 `start()`（feature 時）が spawn 後に Some を注入する。test backend 経路は None。
            #[cfg(feature = "link-audio")]
            link: Mutex::new(None),
            // clap-host: 本番 `start()` が spawn 後に Some を注入する。test backend 経路は None。
            #[cfg(feature = "clap-host")]
            clap: Mutex::new(None),
            // outproc-effect: 本番 `start()` / `start_outproc_effect` が spawn 後に Some を注入する。
            #[cfg(feature = "outproc-effect")]
            outproc: Mutex::new(None),
            // outproc-instrument: production start injects the NeutralEvent ring producer.
            #[cfg(feature = "outproc-instrument")]
            outproc_instrument: Mutex::new(None),
        })
    }

    /// 名前付き LinkAudio channel を登録する（A4-2b-2・feature `link-audio` 専用）。
    /// `RingTapSink` を生成し sink を cpal callback へ・consumer side を GPL consumer thread へ配る。
    #[cfg(feature = "link-audio")]
    pub fn register_link_audio_channel(&self, name: &str) -> Result<(), WrapError> {
        // mutex poison は egress 利用可能だが runtime で壊れた状態 → runtime error。
        let mut guard = self
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))?;
        match guard.as_mut() {
            // registration の失敗（channel 上限・consumer 不在・reg-ring 満杯）は runtime error。
            Some(ctl) => ctl
                .register_channel(name)
                .map_err(|e| WrapError::LinkAudio(e.to_string())),
            // egress 経路が無い（test backend）= unavailable（feature-gap と同じ扱い）。
            None => Err(WrapError::LinkAudioUnavailable(
                "link audio not initialized (test backend has no egress path)".into(),
            )),
        }
    }

    /// feature `link-audio` 無効ビルド用の stub。daemon command handler を feature 非依存に保つ。
    #[cfg(not(feature = "link-audio"))]
    pub fn register_link_audio_channel(&self, _name: &str) -> Result<(), WrapError> {
        Err(WrapError::LinkAudioUnavailable(
            "engine built without 'link-audio' feature".into(),
        ))
    }

    /// Link セッションに tempo(BPM)を push し OrbitScore を tempo leader にする（PR3・#333）。
    /// `LinkAudioControl::set_tempo` は内部で `captureAppSessionState`（非RT・block しうる）を呼ぶので、
    /// daemon WS handler は **spawn_blocking** で audio スレッド以外に隔離すること（session.rs）。
    /// `&self` で足りる: `set_link_tempo` は Rust 可視の可変状態を持たない（`LinkTempoControl` は `Arc`
    /// 共有で、tempo 反映は shim の interior mutability＝captureAppSessionState→commit）。
    /// `register_link_audio_channel` が `registered` HashMap を変更し `as_mut` を要するのと違い、ここは
    /// `guard.as_ref()` で足りる。
    #[cfg(feature = "link-audio")]
    pub fn set_link_tempo(&self, bpm: f64) -> Result<(), WrapError> {
        // mutex poison は egress 利用可能だが runtime で壊れた状態 → runtime error。
        let guard = self
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))?;
        match guard.as_ref() {
            // set_tempo は成功 true / 失敗 false。false（shim 内 Link 例外・実質起きない）は
            // false-positive success を返さず runtime error に昇格する（silent-failure 対策）。
            Some(ctl) => {
                if ctl.set_tempo(bpm) {
                    Ok(())
                } else {
                    Err(WrapError::LinkAudio(
                        "link set_tempo failed (Link rejected commit)".into(),
                    ))
                }
            }
            // egress 経路が無い（test backend）= unavailable（TS は warn-once で握り潰す）。
            None => Err(WrapError::LinkAudioUnavailable(
                "link audio not initialized (test backend has no egress path)".into(),
            )),
        }
    }

    /// feature `link-audio` 無効ビルド用の stub。TS は UNAVAILABLE を warn-once で握り潰す。
    #[cfg(not(feature = "link-audio"))]
    pub fn set_link_tempo(&self, _bpm: f64) -> Result<(), WrapError> {
        Err(WrapError::LinkAudioUnavailable(
            "engine built without 'link-audio' feature".into(),
        ))
    }

    /// OOP feature の初回 `LoadPlugin` で child + watchdog を attach する。
    ///
    /// blocking API: child の readiness を poll するため、session handler は `spawn_blocking` から
    /// 呼ぶこと。同一 path の再送は冪等、別 path への差し替えは v1 では拒否する。
    ///
    /// **契約（precondition）**: `StreamGuard`（`_child_guard` の唯一の強参照保持者）は in-flight
    /// の本呼び出しより必ず長生きすること。破ると: 成功パスで `Ok` を返した直後、本関数ローカルの
    /// `Arc` drop が最後の強参照となり、attach 直後の child が同期的に teardown（QUIT/reap/unlink）
    /// されうる（「成功応答=生きた plugin」が崩れる）。現行の全配線（main.rs のプロセス寿命
    /// `_stream_guard`・gated テストの関数スコープ `_guard`）はこれを満たす。
    ///
    /// **both ビルドでの意味論**: この legacy 単一 role API は **effect slot 専用**になる
    /// （instrument slot には触れない）。production 経路（session.rs の LoadPlugin dispatch）は
    /// both ビルドでは本メソッドを使わず、必ず role 別の `load_outproc_effect_plugin` /
    /// `load_outproc_instrument_plugin` を呼ぶこと。
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn load_outproc_plugin(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
    ) -> Result<LoadedPluginSummary, WrapError> {
        #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
        return self.load_outproc_effect_plugin(path, plugin_id, None);
        #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
        let child_slot = {
            let guard = self
                .outproc
                .lock()
                .map_err(|_| EffectRole::runtime_error("outproc mutex poisoned".into()))?;
            guard
                .as_ref()
                .ok_or_else(|| {
                    WrapError::OutProcEffectUnavailable(
                        "outproc effect not initialized (test backend has no outproc path)".into(),
                    )
                })?
                .child_slot
                .upgrade()
                .ok_or_else(|| {
                    EffectRole::runtime_error("outproc effect stream is closed".into())
                })?
        };
        #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
        let child_slot = {
            let guard = self.outproc_instrument.lock().map_err(|_| {
                InstrumentRole::runtime_error("outproc instrument mutex poisoned".into())
            })?;
            guard
                .as_ref()
                .ok_or_else(|| {
                    WrapError::OutProcInstrumentUnavailable(
                        "outproc instrument not initialized (test backend has no outproc path)"
                            .into(),
                    )
                })?
                .child_slot
                .upgrade()
                .ok_or_else(|| {
                    InstrumentRole::runtime_error("outproc instrument stream is closed".into())
                })?
        };
        #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
        return self.load_outproc_plugin_impl::<DefaultOutProcRole>(child_slot, path, plugin_id);
        #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
        return self.load_outproc_plugin_impl::<DefaultOutProcRole>(child_slot, path, plugin_id);
    }

    /// both build で effect slot へ attach する。
    #[cfg(feature = "outproc-effect")]
    pub fn load_outproc_effect_plugin(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
        bus: Option<String>,
    ) -> Result<LoadedPluginSummary, WrapError> {
        // slot の解決だけを lock 下で行い、attach 本体（child spawn + READY poll）前に guard を
        // 必ず落とす: `outproc` mutex を数百 ms 保持すると 1 Hz health ticker（try_lock）や
        // stats アクセサと競合する（従来コードも guard は slot 解決の式で即 drop していた）。
        let slot = {
            let control_guard = self
                .outproc
                .lock()
                .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
            let control = control_guard.as_ref().ok_or_else(|| {
                WrapError::OutProcEffectUnavailable(
                    "outproc effect not initialized (test backend has no outproc path)".into(),
                )
            })?;
            let weak_slot = match bus {
                Some(bus) => control.bus_slots.get(&bus).ok_or_else(|| {
                    WrapError::OutProcEffect(format!(
                        "unknown effect bus '{bus}' (configured by ORBIT_EFFECT_BUSES)"
                    ))
                })?,
                None => &control.child_slot,
            };
            weak_slot
                .upgrade()
                .ok_or_else(|| WrapError::OutProcEffect("outproc effect stream is closed".into()))?
        };
        self.load_outproc_plugin_impl::<DefaultOutProcRole>(slot, path, plugin_id)
    }

    /// both build で instrument slot へ attach する。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn load_outproc_instrument_plugin(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
    ) -> Result<LoadedPluginSummary, WrapError> {
        let slot = self
            .outproc_instrument
            .lock()
            .map_err(|_| WrapError::OutProcInstrument("outproc instrument mutex poisoned".into()))?
            .as_ref()
            .ok_or_else(|| {
                WrapError::OutProcInstrumentUnavailable(
                    "outproc instrument not initialized (test backend has no outproc path)".into(),
                )
            })?
            .child_slot
            .upgrade()
            .ok_or_else(|| {
                WrapError::OutProcInstrument("outproc instrument stream is closed".into())
            })?;
        self.load_outproc_plugin_impl::<InstrumentRole>(slot, path, plugin_id)
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn load_outproc_plugin_impl<R: OutProcRole>(
        &self,
        child_slot: Arc<Mutex<ChildSlot<R>>>,
        path: PathBuf,
        plugin_id: Option<String>,
    ) -> Result<LoadedPluginSummary, WrapError> {
        let _role_name = R::ROLE_NAME;
        let mut slot = lock_child_slot_recovering(&child_slot, "initial state check");

        match &*slot {
            ChildSlot::Active {
                path: active_path,
                plugin_id: active_plugin_id,
                engaged,
                ..
            } if active_path == &path && active_plugin_id == &plugin_id => {
                // READY を確認済みの Active だけがここへ来る。冪等再送でも gate を維持する。
                engaged.store(true, Ordering::Release);
                return Ok(outproc_plugin_summary(active_path, active_plugin_id));
            }
            ChildSlot::Active {
                path: active_path,
                plugin_id: active_plugin_id,
                ..
            } if active_path == &path => {
                // 同一 path だが plugin_id が異なる = bundle 内の別サブプラグインへの差し替え
                // 要求。path 差し替えと同様 v1 は拒否する（呼び出し側が指定した plugin_id を
                // 握り潰して古い plugin_id のまま黙って Ok を返さない）。
                return Err(R::runtime_error(format!(
                    "outproc plugin already loaded from {active_path:?} with plugin_id {active_plugin_id:?}; v1 does not support replacement with plugin_id {plugin_id:?}"
                )));
            }
            ChildSlot::Active {
                path: active_path, ..
            } => {
                return Err(R::runtime_error(format!(
                    "outproc plugin already loaded from {active_path:?}; v1 does not support replacement with {path:?}"
                )));
            }
            ChildSlot::Loading {
                path: loading_path, ..
            } => {
                return Err(R::runtime_error(format!(
                    "outproc plugin load already in progress for {loading_path:?}"
                )));
            }
            ChildSlot::Closed => {
                return Err(WrapError::OutProcSlotClosed(
                    "outproc child slot is closed after an unrecoverable attach failure".into(),
                ));
            }
            ChildSlot::Empty(_) => {}
        }

        let mut launch = match std::mem::replace(&mut *slot, ChildSlot::Closed) {
            ChildSlot::Empty(launch) => launch,
            _ => unreachable!("ChildSlot state was checked while holding the same mutex"),
        };
        if let Err(error) = R::select_child_exe(&mut launch, &path) {
            *slot = ChildSlot::Empty(launch);
            return Err(R::runtime_error(error));
        }
        *slot = ChildSlot::Loading { path: path.clone() };
        // Loading 書き込みを可視化した直後にロックを解放する。以降の shm open・spawn・
        // ready-ack poll（最大 CHILD_READY_TIMEOUT）はロック外で行う。他の LoadPlugin
        // 呼び出しは Loading を即座に観測して「in progress」で失敗できる（この関数だけが
        // Loading→Active/Closed/Empty へ遷移させるため、再取得後も Loading のままである
        // ことが保証される。teardown は child_slot の Arc を保持するだけで .lock() しない）。
        drop(slot);

        let ready_mmap = match orbit_audio_sandbox::open_shared(&launch.shm_path) {
            Ok(mmap) => mmap,
            Err(error) => {
                let mut slot = lock_child_slot_recovering(&child_slot, "open_shared failure");
                debug_assert_slot_loading(&slot);
                *slot = ChildSlot::Closed;
                return Err(R::runtime_error(format!(
                    "open child readiness mapping {:?}: {error}",
                    launch.shm_path
                )));
            }
        };
        let region = orbit_audio_sandbox::region_ptr(&ready_mmap);
        // SAFETY: region はこの scope で生存する ready_mmap を指す。初回を含む全 spawn の直前に
        // readiness を初期化し、前 incarnation の READY を誤認しない。
        unsafe { orbit_audio_sandbox::transport::reset_child_starting(region) };

        // spawn 前にセットしておくことで、即座に終了する child が通常の respawn 経路に紛れ込むのを防ぐ。
        R::set_initial_attach_pending(&launch.stats, true);
        R::set_child_early_exit(&launch.stats, false);
        let first_child = match R::spawn_child(&launch, &path, plugin_id.as_deref()) {
            Ok(child) => child,
            Err(error) => {
                let child_exe = launch.child_exe.clone();
                let mut slot = lock_child_slot_recovering(&child_slot, "child spawn failure");
                debug_assert_slot_loading(&slot);
                *slot = ChildSlot::Empty(launch);
                return Err(R::runtime_error(format!(
                    "spawn outproc child {:?}: {error}",
                    child_exe
                )));
            }
        };
        R::set_current_child_pid(&launch.stats, first_child.id());

        let supervisor =
            match R::spawn_supervisor(first_child, &launch, path.clone(), plugin_id.clone()) {
                Ok(supervisor) => supervisor,
                Err(error) => {
                    // spawn_outproc_supervisor はエラー時に自身の cleanup で shm を unlink して返るため、
                    // この slot は再利用不能。launch の fallback unlink は解除。
                    launch.cleanup_shm_on_drop = false;
                    let mut slot =
                        lock_child_slot_recovering(&child_slot, "supervisor spawn failure");
                    debug_assert_slot_loading(&slot);
                    *slot = ChildSlot::Closed;
                    return Err(R::runtime_error(format!("spawn outproc watchdog: {error}")));
                }
            };

        let deadline = std::time::Instant::now() + CHILD_READY_TIMEOUT;
        loop {
            // Acquire で READY を観測した後の flags load は child の publish 順と同期する。
            let status = unsafe { (*region).child_status.load(Ordering::Acquire) };
            if status == orbit_audio_sandbox::transport::CHILD_STATUS_READY {
                let flags = unsafe { (*region).child_flags.load(Ordering::Acquire) };
                if !R::role_matches(flags) {
                    return Err(retryable_attach_failure(
                        supervisor,
                        region,
                        &child_slot,
                        launch,
                        format!(
                            "loaded plugin role does not match daemon role (child_flags={flags:#x})"
                        ),
                    ));
                }
                R::set_initial_attach_pending(&launch.stats, false);
                break;
            }
            if R::child_early_exit(&launch.stats) {
                return Err(retryable_attach_failure(
                    supervisor,
                    region,
                    &child_slot,
                    launch,
                    "child exited before publishing READY".into(),
                ));
            }
            if std::time::Instant::now() >= deadline {
                return Err(retryable_attach_failure(
                    supervisor,
                    region,
                    &child_slot,
                    launch,
                    format!(
                        "timed out waiting {:?} for child READY",
                        CHILD_READY_TIMEOUT
                    ),
                ));
            }
            std::thread::sleep(CHILD_READY_POLL);
        }

        launch.engaged.store(true, Ordering::Release);
        let summary = outproc_plugin_summary(&path, &plugin_id);
        // Active supervisor が以後の unlink を所有する。local launch の fallback cleanup は解除する。
        launch.cleanup_shm_on_drop = false;
        let mut slot = lock_child_slot_recovering(&child_slot, "successful attach");
        debug_assert_slot_loading(&slot);
        *slot = ChildSlot::Active {
            path,
            plugin_id,
            engaged: launch.engaged.clone(),
            _supervisor: supervisor,
        };
        Ok(summary)
    }

    // ── CLAP plugin hosting（feature `clap-host` 専用・Issue #340）─────────────────────

    /// CLAP プラグインをロードして hot-install する（feature `clap-host` 専用）。
    /// 専用スレッドへ `LoadPlugin` を送り、discovery + instantiate + activate + start_processing +
    /// install ring push を実行させ、結果を待つ。**blocking**（`reply.recv()`）なので呼び出し側は
    /// `spawn_blocking` で tokio ワーカーを塞がないこと（discovery + dlopen + activate は重い）。
    #[cfg(feature = "clap-host")]
    pub fn load_plugin(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
        role: ClapPluginRole,
    ) -> Result<LoadedPluginSummary, WrapError> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        {
            // lock は send までで解放し、reply 待ちの blocking を mutex 外で行う。
            let mut guard = self
                .clap
                .lock()
                .map_err(|_| WrapError::Clap("clap mutex poisoned".into()))?;
            let ctl = guard.as_mut().ok_or_else(|| {
                WrapError::ClapUnavailable(
                    "clap host not initialized (test backend has no clap path)".into(),
                )
            })?;
            if let Some(loaded_role) = ctl.loaded_role {
                if loaded_role != role {
                    return Err(WrapError::ClapCrossRoleRejected(
                        "in-process clap-host has one plugin slot; unload before changing role"
                            .into(),
                    ));
                }
            }
            ctl.cmd_tx
                .send(crate::clap_host::ClapCommand::LoadPlugin {
                    path,
                    plugin_id,
                    sample_rate: self.sample_rate,
                    channels: self.channels as usize,
                    max_frames: CLAP_MAX_FRAMES,
                    reply: reply_tx,
                })
                .map_err(|_| WrapError::Clap("clap host thread is gone".into()))?;
        }
        match reply_rx.recv() {
            Ok(Ok(info)) => {
                // #405: 以後 push_plugin_event が「未ロード」を検知して事前に弾けるようにする。
                self.plugin_loaded.store(true, Ordering::Relaxed);
                if let Ok(mut guard) = self.clap.lock() {
                    if let Some(ctl) = guard.as_mut() {
                        ctl.loaded_role = Some(role);
                    }
                }
                Ok(LoadedPluginSummary {
                    plugin_id: info.plugin_id,
                    plugin_name: info.plugin_name,
                    note_port_index: info.note_port_index,
                })
            }
            Ok(Err(e)) => Err(WrapError::Clap(e)),
            Err(_) => Err(WrapError::Clap("clap host thread dropped reply".into())),
        }
    }

    /// feature `clap-host` 無効ビルド用の stub。TS は UNAVAILABLE を warn-once で握り潰す。
    #[cfg(not(feature = "clap-host"))]
    pub fn load_plugin(
        &self,
        _path: PathBuf,
        _plugin_id: Option<String>,
        _role: ClapPluginRole,
    ) -> Result<LoadedPluginSummary, WrapError> {
        Err(WrapError::ClapUnavailable(
            "engine built without 'clap-host' feature".into(),
        ))
    }

    /// ロード済み CLAP プラグインへ NoteOn を送る（event ring 経由・非ブロッキング・feature 専用）。
    #[cfg(feature = "clap-host")]
    pub fn plugin_note_on(&self, key: u8, channel: u8, velocity: f64) -> Result<(), WrapError> {
        self.push_plugin_event(orbit_clap_host::PluginEvent::NoteOn {
            key,
            channel,
            velocity,
        })
    }

    /// ロード済み CLAP プラグインへ NoteOff を送る（feature 専用）。
    #[cfg(feature = "clap-host")]
    pub fn plugin_note_off(&self, key: u8, channel: u8, velocity: f64) -> Result<(), WrapError> {
        self.push_plugin_event(orbit_clap_host::PluginEvent::NoteOff {
            key,
            channel,
            velocity,
        })
    }

    /// Out-of-process instrument NoteOn. Conversion to the format-neutral wire event happens on
    /// this control-side method; the audio thread only pops already-converted events.
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    pub fn plugin_note_on(&self, key: u8, channel: u8, velocity: f64) -> Result<(), WrapError> {
        self.push_outproc_instrument_event(orbit_audio_sandbox::NeutralEvent::NoteOn {
            sample_offset: 0,
            addr: Self::outproc_instrument_voice_addr(channel, key),
            velocity,
            tuning_cents: 0.0,
            length_frames: 0,
        })
    }

    /// Out-of-process instrument NoteOff, converted on the control side.
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    pub fn plugin_note_off(&self, key: u8, channel: u8, velocity: f64) -> Result<(), WrapError> {
        self.push_outproc_instrument_event(orbit_audio_sandbox::NeutralEvent::NoteOff {
            sample_offset: 0,
            addr: Self::outproc_instrument_voice_addr(channel, key),
            velocity,
        })
    }

    /// Builds the `VoiceAddr` shared by `plugin_note_on`/`plugin_note_off` for the
    /// out-of-process instrument path (single-port, note-id-less MIDI addressing).
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    fn outproc_instrument_voice_addr(channel: u8, key: u8) -> orbit_audio_sandbox::VoiceAddr {
        orbit_audio_sandbox::VoiceAddr {
            note_id: -1,
            port_index: 0,
            channel: channel as i16,
            key: key as i16,
            _pad: 0,
        }
    }

    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    fn push_outproc_instrument_event(
        &self,
        event: orbit_audio_sandbox::NeutralEvent,
    ) -> Result<(), WrapError> {
        let mut guard = self.outproc_instrument.lock().map_err(|_| {
            WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
        })?;
        let control = guard.as_mut().ok_or_else(|| {
            WrapError::OutProcInstrumentUnavailable(
                "outproc instrument not initialized (test backend)".into(),
            )
        })?;
        control.event_tx.push(event).map_err(|_| {
            self.plugin_event_ring_overflow_count
                .fetch_add(1, Ordering::Relaxed);
            WrapError::OutProcInstrument("instrument note ring full".into())
        })
    }

    #[cfg(feature = "clap-host")]
    fn push_plugin_event(&self, ev: orbit_clap_host::PluginEvent) -> Result<(), WrapError> {
        // #405: プラグイン未ロード時は event ring に投げても audio thread が黙って drain して
        // 捨てるだけ（fire-and-forget ring の設計上ロード状態の同期確認は本来 cross-thread
        // round-trip が要る）。少なくとも「一度もロードに成功していない」ことは control スレッド
        // 側でここまで同期的に判定できるので、その場合は明示的なエラーを返す（嘘の成功応答を防ぐ）。
        // 残存課題（Issue #410）: このガードは「LoadPlugin の応答が成功した」ことしか検知できない。
        // 応答成功後 audio thread が install ring から実際に pop してインストールするまでの狭い
        // window では `plugin_loaded == true` かつ install 未完了になりうる。その window で送った
        // note はガードを通過して `Ok(())` を返すが audio thread 側は無音のままドレインする（同種の
        // false-success が window 限定で残る・追跡は Issue #410）。cross-thread ack の追加は
        // #405/#407 では scope 外（owner 判断待ち）。
        if !self.plugin_loaded.load(Ordering::Relaxed) {
            return Err(WrapError::ClapNotLoaded(
                "no plugin loaded (send LoadPlugin first)".into(),
            ));
        }
        // event ring（1024 slot）が満杯でも、audio callback が毎 block 全量 drain するので
        // bounded retry で lossless 化する（#400）。真にタイムアウトした場合のみ error。
        // mutex は各試行ごとに取得・解放し、sleep 中は保持しない（load_plugin と同じ「lock は
        // send までで解放」規約・#402 レビュー指摘: sleep 中も保持すると他セッションの
        // LoadPlugin/PluginNoteOn 等を最大リトライ時間だけ足止めしてしまう）。
        push_with_bounded_retry(
            |item| {
                let mut guard = match self.clap.lock() {
                    Ok(guard) => guard,
                    Err(_) => {
                        return PushAttemptOutcome::Fatal(WrapError::Clap(
                            "clap mutex poisoned".into(),
                        ))
                    }
                };
                let ctl = match guard.as_mut() {
                    Some(ctl) => ctl,
                    None => {
                        return PushAttemptOutcome::Fatal(WrapError::ClapUnavailable(
                            "clap host not initialized (test backend)".into(),
                        ))
                    }
                };
                match ctl.event_tx.push(item) {
                    Ok(()) => PushAttemptOutcome::Sent,
                    Err(rtrb::PushError::Full(returned)) => PushAttemptOutcome::Full(returned),
                }
            },
            ev,
            PLUGIN_EVENT_RETRY_MAX_ATTEMPTS,
            PLUGIN_EVENT_RETRY_INTERVAL,
            &self.plugin_event_ring_overflow_count,
        )
    }

    /// feature `clap-host` と `outproc-instrument` の両方が無効なビルド用の stub（#420 PR #422
    /// Part 2 で `cfg` を `outproc-instrument` にも拡張したが、このコメントは `clap-host` 単独無効
    /// としか書いておらず実際の条件と食い違っていた — comment-analyzer round 3 指摘）。
    #[cfg(not(any(feature = "clap-host", feature = "outproc-instrument")))]
    pub fn plugin_note_on(&self, _key: u8, _channel: u8, _velocity: f64) -> Result<(), WrapError> {
        Err(WrapError::ClapUnavailable(
            "engine built without 'clap-host' or 'outproc-instrument' feature".into(),
        ))
    }

    /// feature `clap-host` と `outproc-instrument` の両方が無効なビルド用の stub（上の
    /// `plugin_note_on` stub と同じ食い違い・同じ修正）。
    #[cfg(not(any(feature = "clap-host", feature = "outproc-instrument")))]
    pub fn plugin_note_off(&self, _key: u8, _channel: u8, _velocity: f64) -> Result<(), WrapError> {
        Err(WrapError::ClapUnavailable(
            "engine built without 'clap-host' or 'outproc-instrument' feature".into(),
        ))
    }

    /// test harness 用: CLAP post-mix peak（plugin add-mix 後の絶対値ピーク）。発音検証に使う。
    /// `#[doc(hidden)]`。plugin 未ロード / clap 無効時は 0.0。
    #[cfg(feature = "clap-host")]
    #[doc(hidden)]
    pub fn clap_post_peak(&self) -> f32 {
        match self.clap.lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| f32::from_bits(c.stats.post_peak_bits.load(Ordering::Relaxed)))
                .unwrap_or(0.0),
            // poison を「plugin 未ロード」と同じ 0.0 で握り潰すと、gated テストが
            // 「発音しなかった」と誤診断する。warn で root cause を残す（silent-failure 対策）。
            Err(_) => {
                tracing::warn!("clap mutex poisoned; clap_post_peak returning 0.0");
                0.0
            }
        }
    }

    /// test harness / RT 監視用: callback-duration スナップショット（A0 §6・budget 検証）。
    /// `#[doc(hidden)]`。clap 無効時は None。poison 時も None だが warn で区別する。
    #[cfg(feature = "clap-host")]
    #[doc(hidden)]
    pub fn clap_callback_stats(&self) -> Option<orbit_audio_native::CallbackTimeSnapshot> {
        let guard = match self.clap.lock() {
            Ok(g) => g,
            Err(_) => {
                tracing::warn!("clap mutex poisoned; clap_callback_stats returning None");
                return None;
            }
        };
        guard.as_ref().map(|c| c.cb_stats.snapshot())
    }

    /// test harness 用: CLAP post-mix peak をリセットする。effect 検証の two-phase 計測で
    /// baseline（plugin 無し）と effect（plugin 有り）の位相を分けるために使う。`#[doc(hidden)]`。
    #[cfg(feature = "clap-host")]
    #[doc(hidden)]
    pub fn clap_reset_post_peak(&self) {
        match self.clap.lock() {
            Ok(g) => {
                if let Some(c) = g.as_ref() {
                    c.stats.reset_post_peak();
                }
            }
            // reset が黙って no-op だと、後続の two-phase 計測が baseline 汚染で誤判定する。
            Err(_) => tracing::warn!("clap mutex poisoned; clap_reset_post_peak skipped"),
        }
    }

    /// ロード済み plugin の `process()` エラー累積回数（#340）。daemon の 1 Hz ticker が polling して
    /// 増加を `CLAP_PROCESS_ERROR` WARNING で surface する（非 RT observability）。effect は dry 素通し /
    /// instrument は無音になるため、この counter だけが失敗の可視化手段になる。
    /// `try_lock` で ticker をブロックしない: **WouldBlock** は cumulative counter なので次 tick が
    /// 全累積を報告する。**Poisoned** は `link_egress_ring_drops` と同様 warn で post-mortem の根拠を
    /// 残し、以降の発火を抑制する（contention と poison を同一視しない）。
    #[cfg(feature = "clap-host")]
    pub fn clap_process_error_count(&self) -> u64 {
        let control_errors = match self.clap.try_lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| c.stats.process_error_count.load(Ordering::Relaxed))
                .unwrap_or(0),
            Err(std::sync::TryLockError::WouldBlock) => 0,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "clap mutex poisoned; clap_process_error_count reporting 0 for control errors \
                     (CLAP_PROCESS_ERROR suppressed until daemon restart)"
                );
                0
            }
        };
        control_errors + self.clap_process_errors.load(Ordering::Relaxed)
    }

    /// feature `clap-host` 無効ビルド用の stub。本番は常に 0（control が無い）。test 注入分のみ反映。
    #[cfg(not(feature = "clap-host"))]
    pub fn clap_process_error_count(&self) -> u64 {
        self.clap_process_errors.load(Ordering::Relaxed)
    }

    /// `push_plugin_event` の bounded retry が力尽きた回数（#400）。event ring は audio callback
    /// が毎 block 全量 drain するため、通常は 0 のまま推移する health signal。1 Hz ticker が polling
    /// して増加を `PLUGIN_EVENT_RING_OVERFLOW` WARNING で surface する。feature `clap-host` 無効
    /// ビルドでも安全に呼べる（`clap_process_error_count` と同様 unconditional フィールド）。
    pub fn plugin_event_ring_overflow_count(&self) -> u64 {
        self.plugin_event_ring_overflow_count
            .load(Ordering::Relaxed)
    }

    /// test harness 用: `plugin_event_ring_overflow_count` を直接加算する注入 seam（#402
    /// pr-test-analyzer 指摘: sibling counter `link_egress_drops_arc`/`clap_process_errors_arc` に
    /// ある「1 Hz ticker の dedup latch（増加時のみ発火・据え置きでは再発火しない）」の integration
    /// test パターンが、この counter にはまだ無かった）。他の2つと違い `Arc` を返さないのは、この
    /// counter が別スレッドへ producer 側を outsource しない（`EngineWrap` 自身が bounded retry の
    /// 末に直接書く）フィールドだから（struct 定義側の doc 参照）— `&self` 越しの直接 `fetch_add` で
    /// 足りる。`#[doc(hidden)]` で公開 API としては扱わない。
    #[doc(hidden)]
    pub fn plugin_event_ring_overflow_inject(&self, n: u64) {
        self.plugin_event_ring_overflow_count
            .fetch_add(n, Ordering::Relaxed);
    }

    /// test harness / gated 計測用: OOP effect の観測スナップショット（fresh/stale/stall/respawn/
    /// child error 等）。slot 数決定（stale 率）と child crash 生存（respawn）の検証に使う。`#[doc(hidden)]`。
    /// plugin 未起動 / outproc 無効 / poison 時は None（poison は warn で区別）。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_effect_stats(&self) -> Option<crate::outproc_effect::OutProcEffectSnapshot> {
        match self.outproc.lock() {
            Ok(g) => g.as_ref().map(|c| c.stats.snapshot()),
            Err(_) => {
                tracing::warn!("outproc mutex poisoned; outproc_effect_stats returning None");
                None
            }
        }
    }

    /// test harness / gated 計測用: 特定の named insert bus（`ORBIT_EFFECT_BUSES`）に attach された
    /// OOP effect の観測スナップショット。master bus の [`Self::outproc_effect_stats`] と異なり、
    /// 未知の bus 名 / bus 未起動時は `None`（poison も `None`・warn で区別）。`#[doc(hidden)]`。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_effect_bus_stats(
        &self,
        bus: &str,
    ) -> Option<crate::outproc_effect::OutProcEffectSnapshot> {
        match self.outproc.lock() {
            Ok(g) => g
                .as_ref()
                .and_then(|c| c.bus_stats.get(bus))
                .map(|stats| stats.snapshot()),
            Err(_) => {
                tracing::warn!("outproc mutex poisoned; outproc_effect_bus_stats returning None");
                None
            }
        }
    }

    /// test harness / RT 監視用: OOP effect の callback-duration スナップショット（A0 §6・budget 検証）。
    /// `#[doc(hidden)]`。outproc 無効時は None。poison 時も None だが warn で区別する。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_callback_stats(&self) -> Option<orbit_audio_native::CallbackTimeSnapshot> {
        match self.outproc.lock() {
            Ok(g) => g.as_ref().map(|c| c.cb_stats.snapshot()),
            Err(_) => {
                tracing::warn!("outproc mutex poisoned; outproc_callback_stats returning None");
                None
            }
        }
    }

    /// test harness 用: OOP effect の dry / post ピークをリセットする。kill-test / parity の two-phase
    /// 計測で位相を分けるのに使う（`clap_reset_post_peak` と同設計）。`#[doc(hidden)]`。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_reset_peaks(&self) {
        match self.outproc.lock() {
            Ok(g) => {
                if let Some(c) = g.as_ref() {
                    c.stats.reset_peaks();
                }
            }
            Err(_) => tracing::warn!("outproc mutex poisoned; outproc_reset_peaks skipped"),
        }
    }

    /// Gated instrument harness 用: OOP instrument の発音・child・respawn 観測値を返す。
    #[cfg(feature = "outproc-instrument")]
    #[doc(hidden)]
    pub fn outproc_instrument_stats(
        &self,
    ) -> Option<crate::outproc_instrument::OutProcInstrumentSnapshot> {
        match self.outproc_instrument.lock() {
            Ok(guard) => guard.as_ref().map(|control| control.stats.snapshot()),
            Err(_) => {
                tracing::warn!(
                    "outproc instrument mutex poisoned; outproc_instrument_stats returning None"
                );
                None
            }
        }
    }

    /// Gated kill-test の計測位相を分けるため、instrument の累積 post peak をリセットする。
    #[cfg(feature = "outproc-instrument")]
    #[doc(hidden)]
    pub fn outproc_instrument_reset_post_peak(&self) {
        match self.outproc_instrument.lock() {
            Ok(guard) => {
                if let Some(control) = guard.as_ref() {
                    control.stats.reset_post_peak();
                }
            }
            Err(_) => tracing::warn!(
                "outproc instrument mutex poisoned; outproc_instrument_reset_post_peak skipped"
            ),
        }
    }

    /// OOP effect の health signal を `(child_process_error_count, respawn_count, measurement_invalid,
    /// frames_clamped)` で返す（daemon の 1 Hz ticker が polling して WARNING/FATAL event で surface する
    /// 非 RT observability）。`clap_process_error_count` と同様 `try_lock` で ticker をブロックしない
    /// （**WouldBlock** は cumulative なので次 tick が全累積を報告・**Poisoned** は warn して 0 を返し
    /// post-mortem の根拠を残す）。plugin 未起動 / outproc 無効時は `(0, 0, false, <injected>)`。
    ///
    /// `frames_clamped` は #404 で `OutProcEffectStats` から追加した 4 つ目の signal（block が
    /// `MAX_FRAMES` を超えて clamp された累積回数）。当初は独立した `outproc_frames_clamped()`
    /// accessor だったが、同一 tick 内で同一 `self.outproc` mutex を 2 回 `try_lock` + `snapshot` する
    /// ことになり（(a) 無駄な二重ロック (b) 4 signal が同一スナップショットである保証が消える —
    /// 片方が `WouldBlock` で 0 を返す間にもう片方が非ゼロを観測しうる）、#406 /simplify レビューで
    /// この 1 accessor に統合した。
    #[cfg(feature = "outproc-effect")]
    pub fn outproc_health(&self) -> (u64, u64, bool, u64) {
        let injected = self.outproc_frames_clamped.load(Ordering::Relaxed);
        match self.outproc.try_lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| {
                    let s = c.stats.snapshot();
                    (
                        s.child_process_error_count,
                        s.respawn_count,
                        s.measurement_invalid,
                        s.frames_clamped + injected,
                    )
                })
                .unwrap_or((0, 0, false, injected)),
            Err(std::sync::TryLockError::WouldBlock) => (0, 0, false, injected),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "outproc mutex poisoned; outproc_health reporting zeros \
                     (OUTPROC_EFFECT events suppressed until daemon restart)"
                );
                (0, 0, false, injected)
            }
        }
    }

    /// feature `outproc-effect` 無効ビルド用の stub。本番は常に `(0, 0, false, ...)`（control が無い）。
    /// `frames_clamped` は test 注入分のみ反映（`link_egress_ring_drops` / `clap_process_error_count`
    /// の無効ビルド stub と同設計）。
    #[cfg(not(feature = "outproc-effect"))]
    pub fn outproc_health(&self) -> (u64, u64, bool, u64) {
        (
            0,
            0,
            false,
            self.outproc_frames_clamped.load(Ordering::Relaxed),
        )
    }

    /// OOP instrument の全 health signal を `(child_process_error_count, respawn_count,
    /// measurement_invalid, output_event_dropped_count, output_event_spilled_count,
    /// output_note_end_dropped_count, event_decode_error_count)` で返す（daemon の 1 Hz ticker が polling して WARNING event
    /// で surface する非 RT observability）。`outproc_health()`（effect 側）と同じ「1 tick = 1
    /// try_lock + 1 snapshot」設計 — child-process 系 3 signal と output-event overflow 系 3 signal を
    /// 1 accessor に統合し、同一 tick 内で `outproc_instrument` mutex を複数回 `try_lock` する
    /// 二重ロック（(a) 無駄なロック (b) 6 signal が同一スナップショットである保証の消失）を避ける。
    ///
    /// try_lock 方針は `outproc_health()` と同じ: **WouldBlock** は次 tick に持ち越すだけ
    /// （cumulative なので drop しない）、**Poisoned** は warn して real 分を 0/false に丸める
    /// （injected 分は失わない）。instrument 未起動 / outproc-instrument 無効時は injected 分のみ返す。
    #[cfg(feature = "outproc-instrument")]
    pub fn outproc_instrument_health(&self) -> (u64, u64, bool, u64, u64, u64, u64) {
        let injected_errors = self.outproc_instrument_child_errors.load(Ordering::Relaxed);
        let injected_respawns = self.outproc_instrument_respawns.load(Ordering::Relaxed);
        let injected_invalid = self
            .outproc_instrument_measurement_invalid
            .load(Ordering::Relaxed);
        let injected_dropped = self
            .outproc_instrument_output_dropped
            .load(Ordering::Relaxed);
        match self.outproc_instrument.try_lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| {
                    let s = c.stats.snapshot();
                    (
                        s.child_process_error_count + injected_errors,
                        s.respawn_count + injected_respawns,
                        s.measurement_invalid || injected_invalid,
                        s.output_event_dropped_count + injected_dropped,
                        s.output_event_spilled_count,
                        s.output_note_end_dropped_count,
                        s.event_decode_error_count,
                    )
                })
                .unwrap_or((
                    injected_errors,
                    injected_respawns,
                    injected_invalid,
                    injected_dropped,
                    0,
                    0,
                    0,
                )),
            Err(std::sync::TryLockError::WouldBlock) => (
                injected_errors,
                injected_respawns,
                injected_invalid,
                injected_dropped,
                0,
                0,
                0,
            ),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "outproc instrument mutex poisoned; outproc_instrument_health reporting \
                     zeros for real stats (OUTPROC_INSTRUMENT_ERROR/_RESPAWN/_INVALID/ \
                     _OUTPUT_DROPPED events suppressed until daemon restart)"
                );
                (
                    injected_errors,
                    injected_respawns,
                    injected_invalid,
                    injected_dropped,
                    0,
                    0,
                    0,
                )
            }
        }
    }

    /// feature `outproc-instrument` 無効ビルド用の stub。本番は常に injected 分のみ（control が無い）。
    #[cfg(not(feature = "outproc-instrument"))]
    pub fn outproc_instrument_health(&self) -> (u64, u64, bool, u64, u64, u64, u64) {
        (
            self.outproc_instrument_child_errors.load(Ordering::Relaxed),
            self.outproc_instrument_respawns.load(Ordering::Relaxed),
            self.outproc_instrument_measurement_invalid
                .load(Ordering::Relaxed),
            self.outproc_instrument_output_dropped
                .load(Ordering::Relaxed),
            0,
            0,
            0,
        )
    }

    /// 全 LinkAudio channel の ring overflow drop（interleaved サンプル数）の累積合計（A4-2b-2b）。
    /// daemon の 1 Hz ticker が polling して増加を WARNING event で surface する（非 RT observability）。
    /// link 未初期化（test backend）時は control 分が 0。test 注入分（本番 0）を必ず加える。
    #[cfg(feature = "link-audio")]
    pub fn link_egress_ring_drops(&self) -> u64 {
        // try_lock で ticker をブロックしない。**WouldBlock**（callback / register との一時競合）は
        // 次 tick に持ち越すだけ — counter は cumulative なので drop は失われず後続 tick が全累積を
        // 報告する。**Poisoned** は以降ずっと control 分を 0 に固定し LINK_EGRESS_DROP を session 中
        // 抑制してしまうため、他アクセサ（`loaded_sample_count` 等）と同様 `warn!` で post-mortem の
        // 根拠を残す（contention と poison を `.ok()` で同一視しない）。
        let control_drops = match self.link.try_lock() {
            Ok(g) => g.as_ref().map(|ctl| ctl.total_ring_drops()).unwrap_or(0),
            Err(std::sync::TryLockError::WouldBlock) => 0,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "link mutex poisoned; link_egress_ring_drops reporting 0 for control drops \
                     (LINK_EGRESS_DROP events suppressed until daemon restart)"
                );
                0
            }
        };
        control_drops + self.link_egress_drops.load(Ordering::Relaxed)
    }

    /// feature `link-audio` 無効ビルド用の stub。本番は常に 0（control が無い）。test 注入分のみ反映。
    #[cfg(not(feature = "link-audio"))]
    pub fn link_egress_ring_drops(&self) -> u64 {
        self.link_egress_drops.load(Ordering::Relaxed)
    }

    /// test harness 用: LinkAudio egress drop の注入カウンタを取得する。accessor の形（`Arc` clone を
    /// 返す）は `stream_stats_arc` と同じだが、下層 counter は本番経路から分離した注入専用（本番 0）。
    /// integration test から `fetch_add` して 1 Hz ticker の LINK_EGRESS_DROP 発火を駆動する。
    /// `#[doc(hidden)]` で公開 API としては扱わない。
    #[doc(hidden)]
    pub fn link_egress_drops_arc(&self) -> Arc<AtomicU64> {
        self.link_egress_drops.clone()
    }

    /// test harness 用: CLAP process error の注入カウンタを取得する。`link_egress_drops_arc` と同形で、
    /// 下層 counter は本番経路から分離した注入専用（本番 0）。integration test から `fetch_add` して
    /// 1 Hz ticker の CLAP_PROCESS_ERROR 発火を駆動する（plugin ロード不要）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn clap_process_errors_arc(&self) -> Arc<AtomicU64> {
        self.clap_process_errors.clone()
    }

    /// test harness 用: OOP effect `frames_clamped` の注入カウンタを取得する。`link_egress_drops_arc` /
    /// `clap_process_errors_arc` と同形で、下層 counter は本番経路から分離した注入専用（本番 0）。
    /// integration test から `fetch_add` して 1 Hz ticker の OUTPROC_EFFECT_FRAMES_CLAMPED 発火を
    /// 駆動する（child process 不要・#406）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_frames_clamped_arc(&self) -> Arc<AtomicU64> {
        self.outproc_frames_clamped.clone()
    }

    /// test harness 用: OOP instrument `output_event_dropped_count` の注入カウンタを取得する。
    /// `outproc_frames_clamped_arc` と同形で、下層 counter は本番経路から分離した注入専用（本番 0）。
    /// integration test から `fetch_add` して 1 Hz ticker の OUTPROC_INSTRUMENT_OUTPUT_DROPPED 発火を
    /// 駆動する（instrument child process 不要・PR #422 round 2）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_output_dropped_arc(&self) -> Arc<AtomicU64> {
        self.outproc_instrument_output_dropped.clone()
    }

    /// test harness 用: OOP instrument `child_process_error_count` の注入カウンタを取得する。
    /// `outproc_instrument_output_dropped_arc` と同形で、下層 counter は本番経路から分離した注入専用
    /// （本番 0）。integration test から `fetch_add` して 1 Hz ticker の OUTPROC_INSTRUMENT_ERROR 発火を
    /// 駆動する（instrument child process 不要・PR #422 round 3）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_child_errors_arc(&self) -> Arc<AtomicU64> {
        self.outproc_instrument_child_errors.clone()
    }

    /// test harness 用: OOP instrument `respawn_count` の注入カウンタを取得する。
    /// `outproc_instrument_child_errors_arc` と同形。integration test から `fetch_add` して 1 Hz
    /// ticker の OUTPROC_INSTRUMENT_RESPAWN 発火を駆動する（PR #422 round 3）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_respawns_arc(&self) -> Arc<AtomicU64> {
        self.outproc_instrument_respawns.clone()
    }

    /// test harness 用: OOP instrument `measurement_invalid` の注入フラグを取得する。数値カウンタ
    /// 系の `_arc()` getter と異なり `AtomicBool` を返すが、同じ「本番経路から分離した注入専用
    /// （本番 false）」設計。integration test から `store(true, ..)` して 1 Hz ticker の
    /// OUTPROC_INSTRUMENT_INVALID fire-once 発火を駆動する（PR #422 round 3）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_measurement_invalid_arc(&self) -> Arc<AtomicBool> {
        self.outproc_instrument_measurement_invalid.clone()
    }

    /// test harness 用: `StreamStats` への参照を取得し、外部から
    /// xrun / device_lost を駆動できるようにする。
    ///
    /// 外部 crate (`tests/`) から呼ぶ必要があるため `pub` だが、
    /// `#[doc(hidden)]` で rustdoc からは不可視にし公開 API としては扱わない。
    #[doc(hidden)]
    pub fn stream_stats_arc(&self) -> Arc<StreamStats> {
        self.stream_stats.clone()
    }

    pub fn uptime_sec(&self) -> f64 {
        self.started_at.elapsed().as_secs_f64()
    }

    /// 現在スケジュール中の（まだ完了していない）再生イベント数。
    /// audio callback がロックを握っている瞬間は取得できないので、その場合は 0 を返す。
    pub fn active_play_count(&self) -> usize {
        self.engine.active_count().unwrap_or(0)
    }

    pub fn output_sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// 現在の出力ストリーム時刻（scheduler transport 秒）。`play_at` の `time_sec` と同一座標系。
    /// ロック競合時は `None`（callback がロック保持中）。
    pub fn now_sec(&self) -> Option<f64> {
        self.engine.now_sec()
    }

    /// `Engine::lock_contention_count` の delegate（詳細はそちら参照）。daemon の 1 Hz ticker が
    /// polling する（#401）。
    pub fn engine_lock_contention_count(&self) -> u64 {
        self.engine.lock_contention_count()
    }

    /// `Engine::is_lock_poisoned` の delegate（詳細はそちら参照）。daemon の 1 Hz ticker が
    /// polling して fire-once の FATAL event を出す（#401）。
    pub fn engine_lock_poisoned(&self) -> bool {
        self.engine.is_lock_poisoned()
    }

    /// test harness 用: `Engine::contention_count_arc` の delegate。integration test から
    /// `fetch_add` して 1 Hz ticker の `ENGINE_LOCK_CONTENTION` WARNING 発火を駆動する
    /// （`link_egress_drops_arc` と同様の注入 seam・`#[doc(hidden)]`）。
    #[doc(hidden)]
    pub fn engine_lock_contention_arc(&self) -> Arc<AtomicU64> {
        self.engine.contention_count_arc()
    }

    /// test harness 用: `Engine::poisoned_arc` の delegate。integration test から `store(true, ..)`
    /// して 1 Hz ticker の `ENGINE_LOCK_POISONED` FATAL 発火を、実際に Mutex を panic-poison させずに
    /// 駆動する（`#[doc(hidden)]`）。
    #[doc(hidden)]
    pub fn engine_lock_poisoned_arc(&self) -> Arc<AtomicBool> {
        self.engine.poisoned_arc()
    }

    pub fn output_channels(&self) -> u16 {
        self.channels
    }

    /// ファイルをロードし sample_id を返す。
    pub fn load_sample(&self, path: PathBuf) -> Result<LoadedSample, WrapError> {
        let sample = load_sample_resampled(&path, self.sample_rate)?;
        let id = format!("s-{}", short_uuid());
        let info = LoadedSample {
            sample_id: id.clone(),
            frames: sample.frames(),
            channels: sample.channels,
            sample_rate: sample.sample_rate,
        };
        self.lock_samples()?.insert(id, sample);
        Ok(info)
    }

    pub fn unload_sample(&self, sample_id: &str) -> Result<(), WrapError> {
        if self.lock_samples()?.remove(sample_id).is_some() {
            Ok(())
        } else {
            Err(WrapError::SampleNotFound(sample_id.to_string()))
        }
    }

    /// sample を現在時刻 + offset でスケジュール。
    ///
    /// `time_sec` は daemon 起動からの経過秒（Engine transport 基準）。
    /// `pan` は [-1.0, 1.0]（0.0 = 中央、範囲外は core で clamp）。
    /// `offset_sec` / `duration_sec` は再生領域（`chop` の slice）。`duration_sec <= 0` で
    /// 「offset 以降すべて」。いずれもサンプル端で clamp。
    /// `rate` は varispeed（1.0 = 自然尺、>1 = 速く短く高ピッチ、<1 = 遅く長く低ピッチ。
    /// `<=0`/非有限は core で 1.0 に丸め）。
    /// `channel` は出力先 channel 名（LinkAudio outputChannel・#209）。`None` = 既定
    /// （unrouted / hardware sum）。同名 channel の event は per-channel render で加算合成される。
    /// 戻り値の `duration_sec` は **実際に再生される区間の出力尺**（slice 実尺 / rate）なので、
    /// 呼び出し側は PlayEnded を再生終端（varispeed 後の出力終端）に合わせて遅延送信できる。
    #[allow(clippy::too_many_arguments)]
    pub fn play_at(
        &self,
        sample_id: &str,
        time_sec: f64,
        gain: f32,
        pan: f32,
        offset_sec: f64,
        duration_sec: f64,
        rate: f64,
        channel: Option<String>,
    ) -> Result<PlayHandle, WrapError> {
        let sample = self
            .lock_samples()?
            .get(sample_id)
            .cloned()
            .ok_or_else(|| WrapError::SampleNotFound(sample_id.to_string()))?;
        let sr = sample.sample_rate as f64;
        let total_frames = sample.frames();
        // サンプル内オフセット / slice 長（フレーム）。0 = offset 以降すべて。
        // サンプル端 clamp は resolve_slice_region に集約する。
        let offset_frames = (offset_sec.max(0.0) * sr) as usize;
        let requested_len_frames = if duration_sec > 0.0 {
            (duration_sec * sr).round() as usize
        } else {
            0
        };
        // 再生領域を clamp。render が読む source 尺（effective_len_frames）は rate に依らず
        // 不変で、scheduler の render と同一式（resolve_slice_region）を共有する。
        let (slice_start_frame, effective_len_frames) =
            resolve_slice_region(total_frames, offset_frames, requested_len_frames);
        // PlayEnded 用の **出力**尺は varispeed で source 尺 / rate になる（render の出力尺と一致）。
        // core と同じ sanitize_rate で正規化し、出力尺の規約を一致させる。
        let out_duration_sec = effective_len_frames as f64 / sr / sanitize_rate(rate);
        let play_id = format!("p-{}", short_uuid());
        self.engine
            .schedule_with_play_id(
                time_sec,
                gain,
                pan,
                slice_start_frame,
                // clamp 済みの実尺を渡す。生の requested_len_frames を渡すと、render 尺と
                // PlayEnded 尺の一致が scheduler 内の再 clamp に依存してしまう（latent な desync）。
                effective_len_frames,
                rate,
                channel,
                play_id.clone(),
                sample,
            )
            .map_err(|e| WrapError::Scheduler(e.to_string()))?;
        Ok(PlayHandle {
            play_id,
            start_sec: time_sec,
            duration_sec: out_duration_sec,
        })
    }

    /// 全アクティブ再生を即時停止する hard-stop-all。停止件数を返す。
    /// daemon が保持する disposable な voice（in-flight one-shot / varispeed の長尺 slice）を
    /// respawn / stopAll で一括 drop する。PlayEnded 抑制集合は触らない（停止された voice の
    /// PlayEnded 遅延タスクはそのまま発火しうるが、consumer 側が play_id 不在で無害に無視する）。
    pub fn stop_all(&self) -> Result<usize, WrapError> {
        self.engine
            .stop_all()
            .map_err(|e| WrapError::Scheduler(e.to_string()))
    }

    /// `play_id` に一致するアクティブ再生を停止する。true = 停止、false = 見つからず。
    ///
    /// 停止成功時は `stopped_play_ids` にも記録し、PlayEnded 遅延タスクに
    /// 自然発火を抑制させる（take_play_ended_suppressed で消費される）。
    pub fn stop(&self, play_id: &str) -> Result<bool, WrapError> {
        let stopped = self
            .engine
            .stop(play_id)
            .map_err(|e| WrapError::Scheduler(e.to_string()))?;
        if stopped {
            self.stopped_play_ids
                .lock()
                .map_err(|_| WrapError::Scheduler("stopped_play_ids mutex poisoned".to_string()))?
                .insert(play_id.to_string());
        }
        Ok(stopped)
    }

    /// PlayEnded 送信直前に呼ぶ。Stop によって停止された `play_id` なら true を返し、
    /// 該当エントリを remove する。呼び出し側は true なら PlayEnded の送出をスキップする。
    pub fn take_play_ended_suppressed(&self, play_id: &str) -> bool {
        match self.stopped_play_ids.lock() {
            Ok(mut s) => s.remove(play_id),
            // poisoned は非致命的エラー扱い: 抑制されていない前提で PlayEnded を送出する。
            // poison 状態は通常発生せず、発生した場合は Stop 後に PlayEnded が漏れるため
            // post-mortem の根拠として warn! を残す。
            Err(_) => {
                tracing::warn!(
                    play_id = %play_id,
                    "stopped_play_ids mutex poisoned; PlayEnded suppression disabled for this id"
                );
                false
            }
        }
    }

    /// 読み取り専用カウンタ。poisoned 時は fallback として 0 を返す。
    ///
    /// poison 時は GetStatus などで「サンプル未ロード」に見える根因を示すため
    /// warn! を残す。
    pub fn loaded_sample_count(&self) -> usize {
        match self.samples.lock() {
            Ok(guard) => guard.len(),
            Err(_) => {
                tracing::warn!(
                    "samples mutex poisoned; loaded_sample_count returning 0 (GetStatus will misreport)"
                );
                0
            }
        }
    }

    /// transport 時刻（audio callback 駆動）を優先し、未起動時のみ wall-clock にフォールバック。
    pub fn transport_or_uptime_sec(&self) -> f64 {
        self.engine.now_sec().unwrap_or_else(|| self.uptime_sec())
    }

    /// `render_offline` / `render_offline_channel` の共通本体。`render_fn` で 1 block 分の
    /// 描画（全 channel / channel filter）を切り替える。`block_frames` 単位で回すことで、
    /// 実 callback と同様にイベントが block 境界をまたぐ経路も通す。
    ///
    /// `block_frames == 0` は panic（テストハーネス用途なので不正設定は早期に落とす）。
    fn render_offline_inner(
        &self,
        total_frames: usize,
        block_frames: usize,
        mut render_fn: impl FnMut(&mut [f32]),
    ) -> Vec<f32> {
        assert!(block_frames > 0, "render_offline: block_frames must be > 0");
        let channels = self.channels as usize;
        let mut data = Vec::with_capacity(total_frames * channels);
        let mut block = vec![0.0f32; block_frames * channels];
        let mut rendered = 0usize;
        while rendered < total_frames {
            let this_frames = block_frames.min(total_frames - rendered);
            let buf = &mut block[..this_frames * channels];
            render_fn(buf);
            data.extend_from_slice(buf);
            rendered += this_frames;
        }
        data
    }

    /// 検証ハーネス（#311 phase 2）用: スケジュール済みイベントを cpal を介さず
    /// オフラインで `total_frames` 分 render し、interleaved f32 PCM を返す。
    ///
    /// 本番経路（cpal callback）とは独立した test-only API。`Engine::render` は内部で
    /// `try_lock` するが、オフライン単スレッド駆動では競合がなく常に成功する。
    /// `play_at` 由来の sec→frame 変換 / `resolve_slice_region` を経た出力を捕捉できる
    /// （phase 1 の Scheduler 直接駆動が飛ばした層）。
    #[doc(hidden)]
    pub fn render_offline(&self, total_frames: usize, block_frames: usize) -> Vec<f32> {
        self.render_offline_inner(total_frames, block_frames, |buf| self.engine.render(buf))
    }

    /// `render_offline` の channel filter 版（LinkAudio per-channel 受信側の決定論検証・層A）。
    /// 指定 channel 名に属する event だけをオフラインで決定論レンダする。同名 channel は
    /// 加算合成される（sum-by-name）。1 つの wrap で複数 channel を続けて tap すると transport が
    /// 二重に進むため（[`orbit_audio_core::Scheduler::render_channel`] 参照）、検証は channel
    /// ごとに fresh な wrap を使うこと。
    #[doc(hidden)]
    pub fn render_offline_channel(
        &self,
        channel: &str,
        total_frames: usize,
        block_frames: usize,
    ) -> Vec<f32> {
        self.render_offline_inner(total_frames, block_frames, |buf| {
            self.engine.render_channel(buf, channel)
        })
    }

    /// マスターゲインを設定する。`ramp_sec` が 0 以下なら即時。
    pub fn set_global_gain(&self, value: f32, ramp_sec: f64) -> Result<(), WrapError> {
        self.engine
            .set_global_gain(value, ramp_sec)
            .map_err(|e| WrapError::Scheduler(e.to_string()))
    }

    /// audio stream の稼働統計スナップショット（StreamStats event 用）。
    pub fn stream_stats_snapshot(&self) -> StreamStatsSnapshot {
        self.stream_stats.snapshot()
    }

    /// `samples` Mutex を poisoned-safe に取得する。
    /// poisoned 時は `WrapError::Scheduler` に変換して呼び出し側に明示的に通知する。
    fn lock_samples(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, Sample>>, WrapError> {
        self.samples
            .lock()
            .map_err(|_| WrapError::Scheduler("samples mutex poisoned".to_string()))
    }
}

/// `load_outproc_plugin` の終端遷移直前の不変条件検査（release では noop）。
/// Loading 以外を観測したら、この関数以外に slot への書き手が現れたことを意味する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn debug_assert_slot_loading<R: OutProcRole>(slot: &ChildSlot<R>) {
    debug_assert!(
        matches!(slot, ChildSlot::Loading { .. }),
        "load_outproc_plugin: slot must still be Loading (only this function \
         transitions Loading -> Active/Closed/Empty)"
    );
}

/// child slot の poison は attach state machine の停止理由にせず、唯一の書き手である本関数が
/// 回復して本来の遷移を完遂する。放置すると Loading/Closed/Empty の中間状態が恒久化する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn lock_child_slot_recovering<'a, R: OutProcRole>(
    child_slot: &'a Mutex<ChildSlot<R>>,
    site: &'static str,
) -> MutexGuard<'a, ChildSlot<R>> {
    child_slot.lock().unwrap_or_else(|poisoned| {
        tracing::error!("child slot mutex poisoned during {site}; recovering");
        poisoned.into_inner()
    })
}

/// retryable な attach 失敗（role mismatch / early-exit / timeout）の共通終端処理。
/// supervisor を unlink 抜きで teardown し（unlink 所有権は launch に戻る）、teardown が
/// 書いた QUIT を RUN へ戻して、slot を retry 可能な `Empty(launch)` に復帰させる。
///
/// SAFETY 前提: `region` は呼び出し元 scope で生存する `ready_mmap` を指すこと
/// （`load_outproc_plugin` の ready-ack ループからのみ呼ばれる）。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn retryable_attach_failure<R: OutProcRole>(
    supervisor: R::Supervisor,
    region: *mut orbit_audio_sandbox::transport::SharedRegion,
    child_slot: &Mutex<ChildSlot<R>>,
    launch: ChildLaunch<R>,
    message: String,
) -> WrapError {
    tracing::warn!("outproc attach failed (retryable): {message}");
    R::detach_keep_shm(supervisor);
    // teardown が CONTROL_QUIT を書いたので、retry する child は RUN モードで起動する必要がある。
    unsafe { orbit_audio_sandbox::transport::reset_control_run(region) };
    let mut slot = lock_child_slot_recovering(child_slot, "retryable attach failure");
    debug_assert_slot_loading(&slot);
    *slot = ChildSlot::Empty(launch);
    WrapError::OutProcAttachFailed(message)
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn outproc_plugin_summary(
    path: &std::path::Path,
    plugin_id: &Option<String>,
) -> LoadedPluginSummary {
    LoadedPluginSummary {
        plugin_id: plugin_id
            .clone()
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        plugin_name: path
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned()),
        note_port_index: 0,
    }
}

#[cfg(all(test, any(feature = "outproc-effect", feature = "outproc-instrument")))]
mod shm_cleanup_guard_tests {
    use super::ShmCleanupGuard;
    use std::path::PathBuf;

    fn unique_path() -> PathBuf {
        std::env::temp_dir().join(format!("orbitscore-shm-cleanup-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn armed_drop_removes_file_and_disarmed_drop_keeps_it() {
        let armed = unique_path();
        std::fs::write(&armed, b"guard test").expect("create armed guard file");
        drop(ShmCleanupGuard::new(armed.clone()));
        assert!(!armed.exists(), "armed guard must remove shm file");

        let disarmed = unique_path();
        std::fs::write(&disarmed, b"guard test").expect("create disarmed guard file");
        let mut guard = ShmCleanupGuard::new(disarmed.clone());
        guard.disarm();
        drop(guard);
        assert!(
            disarmed.exists(),
            "disarmed guard must leave ChildLaunch-owned file"
        );
        std::fs::remove_file(disarmed).expect("remove retained test file");
    }
}

#[cfg(all(test, feature = "outproc-effect", feature = "outproc-instrument"))]
mod outproc_both_tests {
    use super::EngineWrap;

    #[test]
    fn both_buffer_frames_rejects_conflicting_values() {
        assert!(EngineWrap::resolve_outproc_both_buffer_frames(Some(32), Some(64)).is_err());
        assert_eq!(
            EngineWrap::resolve_outproc_both_buffer_frames(Some(32), None).unwrap(),
            Some(32)
        );
        assert_eq!(
            EngineWrap::resolve_outproc_both_buffer_frames(None, None).unwrap(),
            None
        );
    }
}

pub struct LoadedSample {
    pub sample_id: String,
    pub frames: usize,
    pub channels: u16,
    pub sample_rate: u32,
}

/// `load_plugin` の結果サマリ（feature 非依存型・session.rs を feature 非依存に保つ）。
/// feature 有効時は `orbit_clap_host::LoadedPluginInfo` から変換、無効時は stub が Err を返す。
pub struct LoadedPluginSummary {
    pub plugin_id: String,
    pub plugin_name: Option<String>,
    pub note_port_index: u16,
}

pub struct PlayHandle {
    pub play_id: String,
    pub start_sec: f64,
    pub duration_sec: f64,
}

fn short_uuid() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}

#[cfg(feature = "clap-host")]
#[cfg(test)]
mod plugin_load_gate_tests {
    use super::*;
    use orbit_audio_native::StreamStats;

    // `Self::build` は clap: Mutex::new(None)（test backend 相当）で構築するため、実 device・実
    // ClapControl 無しで plugin_loaded ガードだけを検証できる（#405）。
    fn unstarted_engine() -> Arc<EngineWrap> {
        let engine = orbit_audio_core::Engine::new(48_000, 2);
        EngineWrap::build(engine, 48_000, 2, Arc::new(StreamStats::default()))
    }

    /// plugin 未ロード時に `f` が **専用の** `WrapError::ClapNotLoaded` を返すことを検証する共通
    /// アサーション（note_on/note_off の2テストは setup・assertion が同一で呼び出しメソッドのみ
    /// 異なるため、ここに集約・/simplify レビュー #407）。
    ///
    /// `is_err()` だけの弱いアサーションだと、`push_plugin_event` 冒頭の `plugin_loaded` ガード
    /// （#405 の本体）を丸ごと削除しても、後段の `guard.as_mut().ok_or_else(...)` が
    /// `clap: Mutex::new(None)`（test backend）により `WrapError::ClapUnavailable` を返すため
    /// テストが通ってしまい、回帰保護にならない（PR #407 レビュー finding）。variant を pin する
    /// ことで、ガード削除時は `ClapUnavailable`（≠ `ClapNotLoaded`）が返り `matches!` が偽になって
    /// 確実に fail する（このテストの自己検証: ガードを一時的にコメントアウトして fail することを
    /// `cargo test --features clap-host plugin_load_gate_tests` で確認済み）。
    fn assert_rejected_before_load(f: impl FnOnce(&EngineWrap) -> Result<(), WrapError>) {
        let wrap = unstarted_engine();
        let result = f(&wrap);
        assert!(
            matches!(result, Err(WrapError::ClapNotLoaded(_))),
            "plugin 未ロード時は WrapError::ClapNotLoaded を返すべき（#405）。got: {result:?}"
        );
    }

    #[test]
    fn note_on_before_load_returns_explicit_error_not_success() {
        assert_rejected_before_load(|wrap| wrap.plugin_note_on(60, 0, 0.8));
    }

    #[test]
    fn note_off_before_load_returns_explicit_error_not_success() {
        assert_rejected_before_load(|wrap| wrap.plugin_note_off(60, 0, 0.0));
    }

    #[test]
    fn plugin_loaded_flag_defaults_false() {
        let wrap = unstarted_engine();
        assert!(!wrap.plugin_loaded.load(Ordering::Relaxed));
    }

    /// `wrap.clap` へ実 `ClapControl` を直接注入する共通セットアップ（PR #406 の private
    /// フィールド直接注入手法）。呼び出し側は event ring の consumer と LoadPlugin コマンドの
    /// receiver の両方を受け取り、不要な方は `_` で捨てる（`loaded_engine`/`loadable_engine`
    /// が共有・/simplify レビュー #412: 個別に組み立てると `ClapControl` のフィールド変更が
    /// 2箇所同時保守になる）。
    fn wire_clap_control(
        wrap: &Arc<EngineWrap>,
    ) -> (
        orbit_clap_host::PluginEventConsumer,
        std::sync::mpsc::Receiver<crate::clap_host::ClapCommand>,
    ) {
        let (event_tx, event_rx) = orbit_clap_host::make_event_ring(16);
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        let stats = orbit_clap_host::ClapProcessorStats::new();
        let cb_stats = orbit_audio_native::CallbackTimeStats::new();
        *wrap.clap.lock().expect("clap mutex") = Some(ClapControl {
            cmd_tx,
            loaded_role: None,
            event_tx,
            stats,
            cb_stats,
        });
        (event_rx, cmd_rx)
    }

    /// `unstarted_engine` に `wire_clap_control` で実 `ClapControl` を構築注入し、
    /// `plugin_loaded = true` かつ `clap = Some(...)` な wrap を返す。呼び出し側は
    /// 返る consumer で event ring への実配送を検証できる（positive-path・#405 finding 3）。
    /// `cmd_rx` は保持しない（LoadPlugin コマンドは実際には送らないため不要）。
    fn loaded_engine() -> (Arc<EngineWrap>, orbit_clap_host::PluginEventConsumer) {
        let wrap = unstarted_engine();
        let (event_rx, _cmd_rx) = wire_clap_control(&wrap);
        wrap.plugin_loaded.store(true, Ordering::Relaxed);
        (wrap, event_rx)
    }

    /// `unstarted_engine` に `wire_clap_control` で実 `ClapControl` を構築注入するが、
    /// `loaded_engine` と異なり `plugin_loaded` は事前に store しない。呼び出し側は
    /// `load_plugin()` を実際に呼び、その成功分岐が `plugin_loaded` を true にすることを
    /// `cmd_rx` 経由の LoadPlugin コマンド応答で検証できる（#411）。
    fn loadable_engine() -> (
        Arc<EngineWrap>,
        std::sync::mpsc::Receiver<crate::clap_host::ClapCommand>,
    ) {
        let wrap = unstarted_engine();
        let (_event_rx, cmd_rx) = wire_clap_control(&wrap);
        (wrap, cmd_rx)
    }

    #[test]
    fn load_plugin_success_sets_plugin_loaded_flag() {
        let (wrap, cmd_rx) = loadable_engine();
        let responder = std::thread::spawn(move || {
            // `recv_timeout` で fail-fast にする（`clap_host.rs` の専用スレッド pump loop と同じ
            // パターン）。現状 `load_plugin()` は必ず send 後に待つため無期限 `recv()` でも通るが、
            // 将来の regression（lock 順序ミス等で send 前に return する等）が入ると無期限ブロックし、
            // `rust-ci.yml` に `timeout-minutes` 未設定のため CI job が GitHub Actions のデフォルト
            // 上限（最大6時間）までハングしてから失敗する fail-slow リスクがある
            // （pr-test-analyzer / silent-failure-hunter 独立指摘・PR #412）。
            let cmd = cmd_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("load_plugin should send LoadPlugin within 5s");
            // `ClapCommand` は現状 `LoadPlugin` の1バリアントのみなので irrefutable pattern
            // で受けられる（/simplify レビュー #412: match 1本腕は不要なネスト）。
            let crate::clap_host::ClapCommand::LoadPlugin {
                path,
                plugin_id,
                sample_rate,
                channels,
                max_frames,
                reply,
            } = cmd;
            assert_eq!(path, PathBuf::from("dummy.clap"));
            assert_eq!(plugin_id, None);
            assert_eq!(sample_rate, 48_000);
            assert_eq!(channels, 2);
            assert_eq!(max_frames, CLAP_MAX_FRAMES);
            reply
                .send(Ok(orbit_clap_host::LoadedPluginInfo {
                    plugin_id: "com.example.dummy".to_string(),
                    plugin_name: Some("Dummy".to_string()),
                    note_port_index: 0,
                }))
                .expect("load_plugin should still be waiting for reply");
        });

        let result = wrap.load_plugin(PathBuf::from("dummy.clap"), None, ClapPluginRole::Effect);
        responder.join().expect("responder thread should not panic");

        // `LoadedPluginSummary` は Debug 未実装のため `assert!(result.is_ok(), "{result:?}")`
        // が使えない（sibling の `note_on_after_load_reaches_ring` は `Result<(), WrapError>` で
        // `()` が Debug のため同型の assert! が効くが、ここは Err 側だけ表示する）。
        if let Err(err) = result {
            panic!("load_plugin should succeed: {err:?}");
        }
        assert!(
            wrap.plugin_loaded.load(Ordering::Relaxed),
            "load_plugin success branch must set plugin_loaded"
        );
    }

    #[test]
    fn same_role_resend_reaches_existing_already_loaded_path() {
        let (wrap, cmd_rx) = loadable_engine();
        wrap.clap
            .lock()
            .expect("clap mutex")
            .as_mut()
            .expect("clap control")
            .loaded_role = Some(ClapPluginRole::Effect);
        let responder = std::thread::spawn(move || {
            let crate::clap_host::ClapCommand::LoadPlugin { reply, .. } = cmd_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("same-role resend should reach clap host");
            reply
                .send(Err("AlreadyLoaded".to_string()))
                .expect("caller should wait for reply");
        });

        let result = wrap.load_plugin(PathBuf::from("dummy.clap"), None, ClapPluginRole::Effect);
        responder.join().expect("responder thread should not panic");
        assert!(
            matches!(result, Err(WrapError::Clap(message)) if message == "AlreadyLoaded"),
            "same-role resend must preserve the clap host's AlreadyLoaded behavior"
        );
    }

    #[test]
    fn failed_first_load_leaves_role_unset_and_permits_a_different_role() {
        let (wrap, cmd_rx) = loadable_engine();
        let responder = std::thread::spawn(move || {
            for message in ["first load failed", "second load failed"] {
                let crate::clap_host::ClapCommand::LoadPlugin { reply, .. } = cmd_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("both loads should reach clap host while no role is loaded");
                reply
                    .send(Err(message.to_string()))
                    .expect("caller waits for reply");
            }
        });

        let first = wrap.load_plugin(PathBuf::from("first.clap"), None, ClapPluginRole::Effect);
        assert!(matches!(first, Err(WrapError::Clap(message)) if message == "first load failed"));
        assert_eq!(
            wrap.clap
                .lock()
                .expect("clap mutex")
                .as_ref()
                .expect("clap control")
                .loaded_role,
            None,
            "failed first load must not claim a role"
        );

        let second = wrap.load_plugin(
            PathBuf::from("second.clap"),
            None,
            ClapPluginRole::Instrument,
        );
        responder.join().expect("responder thread should not panic");
        assert!(
            matches!(second, Err(WrapError::Clap(message)) if message == "second load failed"),
            "different role after a failed first load must reach clap host, not cross-role reject"
        );
    }

    #[test]
    fn failed_same_role_reload_preserves_the_successfully_loaded_role() {
        let (wrap, cmd_rx) = loadable_engine();
        let responder = std::thread::spawn(move || {
            let crate::clap_host::ClapCommand::LoadPlugin { reply, .. } = cmd_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("first load should reach clap host");
            reply
                .send(Ok(orbit_clap_host::LoadedPluginInfo {
                    plugin_id: "com.example.dummy".to_string(),
                    plugin_name: Some("Dummy".to_string()),
                    note_port_index: 0,
                }))
                .expect("caller waits for first reply");
            let crate::clap_host::ClapCommand::LoadPlugin { reply, .. } = cmd_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("same-role reload should reach clap host");
            reply
                .send(Err("reload failed".to_string()))
                .expect("caller waits for reload reply");
        });

        let first = wrap.load_plugin(PathBuf::from("dummy.clap"), None, ClapPluginRole::Effect);
        assert!(first.is_ok(), "first load should succeed");
        let reload = wrap.load_plugin(PathBuf::from("dummy.clap"), None, ClapPluginRole::Effect);
        responder.join().expect("responder thread should not panic");
        assert!(matches!(reload, Err(WrapError::Clap(message)) if message == "reload failed"));
        assert_eq!(
            wrap.clap
                .lock()
                .expect("clap mutex")
                .as_ref()
                .expect("clap control")
                .loaded_role,
            Some(ClapPluginRole::Effect),
            "failed same-role reload must preserve the successful load's role"
        );
    }

    #[test]
    fn different_role_resend_is_rejected_before_clap_host_replacement() {
        let (wrap, cmd_rx) = loadable_engine();
        wrap.clap
            .lock()
            .expect("clap mutex")
            .as_mut()
            .expect("clap control")
            .loaded_role = Some(ClapPluginRole::Effect);

        let result = wrap.load_plugin(
            PathBuf::from("dummy.clap"),
            None,
            ClapPluginRole::Instrument,
        );
        assert!(
            matches!(result, Err(WrapError::ClapCrossRoleRejected(_))),
            "different role must be rejected before the single slot can be replaced"
        );
        assert!(
            matches!(
                cmd_rx.recv_timeout(Duration::from_millis(50)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ),
            "cross-role rejection must not send a replacement command to clap host"
        );
    }

    #[test]
    fn note_on_after_load_reaches_ring() {
        let (wrap, mut consumer) = loaded_engine();
        let result = wrap.plugin_note_on(60, 0, 0.8);
        assert!(result.is_ok(), "load 後は成功するはず: {result:?}");
        match consumer.pop() {
            Ok(orbit_clap_host::PluginEvent::NoteOn {
                key,
                channel,
                velocity,
            }) => {
                assert_eq!(key, 60);
                assert_eq!(channel, 0);
                assert_eq!(velocity, 0.8);
            }
            other => panic!("event ring に NoteOn が届いているべき。got: {other:?}"),
        }
    }

    #[test]
    fn note_off_after_load_reaches_ring() {
        let (wrap, mut consumer) = loaded_engine();
        let result = wrap.plugin_note_off(60, 0, 0.0);
        assert!(result.is_ok(), "load 後は成功するはず: {result:?}");
        match consumer.pop() {
            Ok(orbit_clap_host::PluginEvent::NoteOff {
                key,
                channel,
                velocity,
            }) => {
                assert_eq!(key, 60);
                assert_eq!(channel, 0);
                assert_eq!(velocity, 0.0);
            }
            other => panic!("event ring に NoteOff が届いているべき。got: {other:?}"),
        }
    }

    /// monotonic invariant（finding 4）: `plugin_loaded` への書き込みは**本番コード**中
    /// `load_plugin` 成功時の1箇所のみ（`grep -n "plugin_loaded.store" engine_wrap.rs` で確認可能。
    /// このテストモジュール内の `loaded_engine()` ヘルパーによる直接注入は別途1箇所ヒットするが、
    /// それは test-only の注入であり本番の書き込み経路ではない）。false に戻す経路は本番コードに
    /// 存在しない。runtime test で reset を再現する手段が無いため、ここでは複数回 push が成功し
    /// 続けフラグが true のままであることだけを軽量に確認する。
    #[test]
    fn plugin_loaded_flag_stays_true_across_multiple_events() {
        let (wrap, mut consumer) = loaded_engine();
        assert!(wrap.plugin_note_on(60, 0, 0.5).is_ok());
        assert!(
            wrap.plugin_loaded.load(Ordering::Relaxed),
            "1回目 push 後も true のまま"
        );
        assert!(wrap.plugin_note_off(60, 0, 0.0).is_ok());
        assert!(
            wrap.plugin_loaded.load(Ordering::Relaxed),
            "2回目 push 後も true のまま（reset 経路が無いことの確認）"
        );
        assert!(consumer.pop().is_ok());
        assert!(consumer.pop().is_ok());
    }
}

#[cfg(all(test, feature = "outproc-effect", not(feature = "outproc-instrument")))]
mod outproc_effect_eager_start_tests {
    use super::{EngineWrap, WrapError};
    use crate::outproc_effect::{OutProcEffectConfig, PluginFormat};
    use std::path::PathBuf;

    #[test]
    fn eager_effect_start_requires_a_plugin_path_before_device_access() {
        let result = EngineWrap::start_outproc_effect(OutProcEffectConfig {
            format: PluginFormat::Clap,
            child_exe: PathBuf::from("unused-child"),
            plugin: None,
            plugin_id: None,
            buffer_frames: None,
        });
        assert!(
            matches!(result, Err(WrapError::OutProcEffect(message)) if message == "eager start requires a plugin path")
        );
    }
}

#[cfg(all(test, feature = "outproc-instrument", not(feature = "outproc-effect")))]
mod outproc_instrument_eager_start_tests {
    use super::{EngineWrap, WrapError};
    use crate::outproc_instrument::OutProcInstrumentConfig;
    use std::path::PathBuf;

    #[test]
    fn eager_instrument_start_requires_a_plugin_path_before_device_access() {
        let result = EngineWrap::start_outproc_instrument(OutProcInstrumentConfig {
            child_exe: PathBuf::from("unused-child"),
            plugin: None,
            plugin_id: None,
            buffer_frames: None,
        });
        assert!(
            matches!(result, Err(WrapError::OutProcInstrument(message)) if message == "eager start requires a plugin path")
        );
    }
}

#[cfg(feature = "clap-host")]
#[cfg(test)]
mod plugin_event_ring_retry_tests {
    use super::{push_with_bounded_retry, Ordering, PushAttemptOutcome};
    use std::sync::atomic::AtomicU64;
    use std::time::Duration;

    /// test 用の1回試行クロージャ。本番の `push_plugin_event` と異なり mutex 越しではなく
    /// `rtrb::Producer` を直接 push するだけ（lock scope の検証は責務外・retry ロジックのみ検証）。
    fn attempt_push(producer: &mut rtrb::Producer<u32>, item: u32) -> PushAttemptOutcome<u32> {
        match producer.push(item) {
            Ok(()) => PushAttemptOutcome::Sent,
            Err(rtrb::PushError::Full(returned)) => PushAttemptOutcome::Full(returned),
        }
    }

    #[test]
    fn succeeds_immediately_when_space_available() {
        let (mut tx, _rx) = rtrb::RingBuffer::<u32>::new(4);
        let overflow = AtomicU64::new(0);
        let result = push_with_bounded_retry(
            |item| attempt_push(&mut tx, item),
            42,
            5,
            Duration::from_millis(1),
            &overflow,
        );
        assert!(result.is_ok());
        assert_eq!(overflow.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn retries_then_succeeds_once_consumer_drains() {
        let (mut tx, mut rx) = rtrb::RingBuffer::<u32>::new(1);
        tx.push(1).expect("fill capacity 1");
        let overflow = AtomicU64::new(0);

        // audio callback が数 ms 後に ring を drain する状況を模擬する。
        let drain_handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            let _ = rx.pop();
        });

        let result = push_with_bounded_retry(
            |item| attempt_push(&mut tx, item),
            2,
            50,
            Duration::from_millis(1),
            &overflow,
        );
        drain_handle.join().expect("drain thread should not panic");

        assert!(result.is_ok(), "should succeed once consumer drains space");
        assert_eq!(
            overflow.load(Ordering::Relaxed),
            0,
            "successful retry must not count as overflow"
        );
    }

    #[test]
    fn gives_up_and_counts_overflow_when_ring_stays_full() {
        let (mut tx, _rx) = rtrb::RingBuffer::<u32>::new(1);
        tx.push(1).expect("fill capacity 1");
        let overflow = AtomicU64::new(0);

        // _rx を drain せずに保持したまま(＝満杯が解消しない)、少ない retry 回数で確実に諦めさせる。
        let result = push_with_bounded_retry(
            |item| attempt_push(&mut tx, item),
            2,
            3,
            Duration::from_millis(1),
            &overflow,
        );

        assert!(result.is_err(), "should give up after max_attempts");
        assert_eq!(
            overflow.load(Ordering::Relaxed),
            1,
            "overflow counter must increment exactly once on give-up"
        );
    }

    #[test]
    fn fatal_outcome_short_circuits_without_retry_or_overflow_count() {
        let overflow = AtomicU64::new(0);
        let mut calls = 0u32;
        let result: Result<(), super::WrapError> = push_with_bounded_retry(
            |_item| {
                calls += 1;
                PushAttemptOutcome::Fatal(super::WrapError::Clap("clap mutex poisoned".into()))
            },
            42u32,
            5,
            Duration::from_millis(1),
            &overflow,
        );

        assert!(result.is_err(), "fatal outcome must propagate as an error");
        assert_eq!(calls, 1, "fatal outcome must not retry");
        assert_eq!(
            overflow.load(Ordering::Relaxed),
            0,
            "fatal outcome is not an overflow (retrying would not have helped)"
        );
    }
}

/// `push_plugin_event`（`plugin_note_on`/`plugin_note_off` の共通経路）を、test backend
/// （`clap: Mutex<Option<ClapControl>>` が `None`）越しに直接叩く（#402 pr-test-analyzer 指摘: 上の
/// `plugin_event_ring_retry_tests` は `push_with_bounded_retry` を bare `rtrb::Producer` クロージャで
/// 検証するのみで、本番の `push_plugin_event` クロージャ（mutex lock/poison 分岐・
/// `guard.as_mut() == None` → `ClapUnavailable` の Fatal 分岐）を一度も経由していなかった）。
///
/// `Sent` 分岐（実際に event ring へ push が成功する）と mutex-poisoned 分岐は、実 clap-host
/// 初期化済み `EngineWrap`（`EngineWrap::start()` が spawn する専用スレッド + 実 audio stream）が
/// 要るため practical でない。ここでは `start_with(StubBackend)` で到達可能な None/ClapUnavailable
/// 分岐にスコープする。`plugin_loaded` は #405 のガードが先に短絡してしまわないよう明示的に true を
/// セットしてから叩く（このモジュールの狙いは「ロード済みなのに clap ハンドルが無い」分岐であり
/// 「未ロード」分岐ではない・#407 との merge で `push_plugin_event` にガードが追加されたことへの
/// 追従）。
#[cfg(feature = "clap-host")]
#[cfg(test)]
mod push_plugin_event_tests {
    use super::{EngineWrap, WrapError};
    use crate::backend::StubBackend;

    #[test]
    fn plugin_note_on_returns_clap_unavailable_when_clap_not_initialized() {
        let (engine, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend starts");
        engine
            .plugin_loaded
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let before = engine.plugin_event_ring_overflow_count();

        let err = engine
            .plugin_note_on(60, 0, 0.8)
            .expect_err("test backend has no clap control (clap field is None)");

        assert!(
            matches!(err, WrapError::ClapUnavailable(_)),
            "expected ClapUnavailable (Fatal short-circuit), got {err:?}"
        );
        assert_eq!(
            engine.plugin_event_ring_overflow_count(),
            before,
            "Fatal short-circuit must not be counted as a bounded-retry overflow"
        );
    }

    #[test]
    fn plugin_note_off_returns_clap_unavailable_when_clap_not_initialized() {
        let (engine, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend starts");
        engine
            .plugin_loaded
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let before = engine.plugin_event_ring_overflow_count();

        let err = engine
            .plugin_note_off(60, 0, 0.0)
            .expect_err("test backend has no clap control (clap field is None)");

        assert!(
            matches!(err, WrapError::ClapUnavailable(_)),
            "expected ClapUnavailable (Fatal short-circuit), got {err:?}"
        );
        assert_eq!(
            engine.plugin_event_ring_overflow_count(),
            before,
            "Fatal short-circuit must not be counted as a bounded-retry overflow"
        );
    }
}

#[cfg(test)]
mod capture_path_tests {
    use super::resolve_capture_path;
    use std::path::PathBuf;

    #[test]
    fn none_when_unset() {
        assert_eq!(resolve_capture_path(None), None);
    }

    #[test]
    fn none_when_empty() {
        assert_eq!(resolve_capture_path(Some(String::new())), None);
    }

    #[test]
    fn none_when_whitespace_only() {
        assert_eq!(resolve_capture_path(Some("   ".to_string())), None);
    }

    #[test]
    fn resolves_plain_path() {
        assert_eq!(
            resolve_capture_path(Some("/tmp/out.wav".to_string())),
            Some(PathBuf::from("/tmp/out.wav"))
        );
    }

    #[test]
    fn trims_surrounding_whitespace() {
        // 前後の空白は落として実パスにする（untrimmed だと存在しないパス名になり capture が
        // silent に失敗する）。
        assert_eq!(
            resolve_capture_path(Some("  /tmp/out.wav  ".to_string())),
            Some(PathBuf::from("/tmp/out.wav"))
        );
    }
}

#[cfg(all(test, any(feature = "outproc-effect", feature = "outproc-instrument")))]
mod outproc_load_error_test_support {
    use super::{ChildLaunch, ChildSlot, EngineWrap, OutProcRole, WrapError};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    type InjectedSlot<R> = (Arc<EngineWrap>, Arc<Mutex<ChildSlot<R>>>);

    fn child_launch<R: OutProcRole>(
        shm_path: PathBuf,
        child_exe: PathBuf,
        stats: Arc<R::Stats>,
    ) -> ChildLaunch<R> {
        ChildLaunch {
            shm_path,
            child_exe,
            sample_rate: 48_000,
            stats,
            engaged: Arc::new(AtomicBool::new(false)),
            cleanup_shm_on_drop: true,
        }
    }

    pub(super) fn open_shared_failure_closes_slot<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        plugin_path: &str,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let stats = R::new_stats();
        let launch = child_launch::<R>(
            shm_path,
            PathBuf::from("unused-child-executable"),
            stats.clone(),
        );
        let (wrap, child_slot) = inject(ChildSlot::Empty(launch), stats);

        let error = wrap
            .load_outproc_plugin_impl::<R>(child_slot.clone(), PathBuf::from(plugin_path), None)
            .err()
            .expect("missing shared memory must fail before spawn");

        assert_error(error, "open child readiness mapping");
        assert!(
            matches!(
                *child_slot.lock().expect("lock child slot"),
                ChildSlot::Closed
            ),
            "open_shared failure must transition the slot to Closed"
        );
    }

    #[cfg(feature = "outproc-effect")]
    pub(super) fn poisoned_slot_open_shared_failure_recovers_to_closed<R: OutProcRole + 'static>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        plugin_path: &str,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let stats = R::new_stats();
        let (wrap, child_slot) = inject(
            ChildSlot::Empty(child_launch::<R>(
                shm_path,
                PathBuf::from("unused-child-executable"),
                stats.clone(),
            )),
            stats,
        );
        let poison_slot = child_slot.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poison_slot.lock().expect("lock slot for poison");
            panic!("intentional child slot poison");
        })
        .join();

        let error = match wrap.load_outproc_plugin_impl::<R>(
            child_slot.clone(),
            PathBuf::from(plugin_path),
            None,
        ) {
            Ok(_) => panic!("missing shm must take the Closed terminal transition after recovery"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            WrapError::OutProcEffect(_) | WrapError::OutProcInstrument(_)
        ));
        assert!(matches!(
            *child_slot.lock().unwrap_or_else(|p| p.into_inner()),
            ChildSlot::Closed
        ));
    }

    pub(super) fn spawn_failure_restores_empty_for_retry<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        plugin_path: &str,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let _mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create shared memory");
        let bad_child_exe = unique_path();
        let _ = std::fs::remove_file(&bad_child_exe);
        let stats = R::new_stats();
        let launch = child_launch::<R>(shm_path, bad_child_exe, stats.clone());
        let (wrap, child_slot) = inject(ChildSlot::Empty(launch), stats);

        for attempt in 1..=2 {
            let error = wrap
                .load_outproc_plugin_impl::<R>(child_slot.clone(), PathBuf::from(plugin_path), None)
                .err()
                .expect("nonexistent child executable must fail to spawn");
            assert_error(error, "spawn outproc child");
            assert!(
                matches!(
                    *child_slot.lock().expect("lock child slot"),
                    ChildSlot::Empty(_)
                ),
                "spawn failure attempt {attempt} must restore Empty so the same slot is retryable"
            );
        }
    }

    pub(super) fn closed_slot_is_rejected<R: OutProcRole>(
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        plugin_path: &str,
    ) {
        let (wrap, child_slot) = inject(ChildSlot::Closed, R::new_stats());

        let error = wrap
            .load_outproc_plugin_impl::<R>(child_slot.clone(), PathBuf::from(plugin_path), None)
            .err()
            .expect("Closed slot must reject attach");

        assert_error(error, "closed after an unrecoverable attach failure");
        assert!(matches!(
            *child_slot.lock().expect("lock child slot"),
            ChildSlot::Closed
        ));
    }

    pub(super) fn loading_slot_is_rejected<R: OutProcRole>(
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        loading_path: &str,
        second_path: &str,
    ) {
        let (wrap, child_slot) = inject(
            ChildSlot::Loading {
                path: PathBuf::from(loading_path),
            },
            R::new_stats(),
        );

        let error = wrap
            .load_outproc_plugin_impl::<R>(child_slot.clone(), PathBuf::from(second_path), None)
            .err()
            .expect("Loading slot must reject concurrent attach");

        assert_error(error, "already in progress");
        assert!(
            matches!(&*child_slot.lock().expect("lock child slot"), ChildSlot::Loading { path } if path == Path::new(loading_path))
        );
    }

    /// 実際に生存する（が無害な）child を起動して `ChildSlot::Active` を直接構築する。
    /// `EffectChildSupervisor`/`InstrumentChildSupervisor` は `spawn_effect_child` 経由の
    /// `Command` 起動を要求するので、実 CLAP/VST3 plugin なしで到達するには `R::spawn_supervisor`
    /// を直接呼び、`first_child` には（respawn を誘発しない）長寿命の `sleep` を渡す（outproc_effect.rs
    /// の `supervisor_*` テストと同じ手法）。supervisor が以後の shm unlink を所有するため、ローカルの
    /// `launch` の `cleanup_shm_on_drop` は production の `load_outproc_plugin` 成功パスと同様に外す。
    fn active_child_slot<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        plugin_path: &str,
        plugin_id: Option<String>,
    ) -> ChildSlot<R> {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let _mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create shared memory");

        let mut launch = child_launch::<R>(
            shm_path,
            PathBuf::from("unused-child-executable-for-respawn-only"),
            R::new_stats(),
        );
        let first_child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn stub child for Active fixture");

        let path = PathBuf::from(plugin_path);
        let supervisor = R::spawn_supervisor(first_child, &launch, path.clone(), plugin_id.clone())
            .expect("spawn supervisor for Active fixture");
        launch.cleanup_shm_on_drop = false;

        ChildSlot::Active {
            path,
            plugin_id,
            engaged: Arc::new(AtomicBool::new(true)),
            _supervisor: supervisor,
        }
    }

    /// Important finding 2a: `ChildSlot::Active` への同一 path・同一 plugin_id の再送は冪等に
    /// `Ok` を返し、slot を `Active` のまま維持すること。
    pub(super) fn active_slot_accepts_idempotent_reload<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        plugin_path: &str,
        plugin_id: Option<String>,
    ) {
        let slot = active_child_slot::<R>(unique_path, plugin_path, plugin_id.clone());
        let (wrap, child_slot) = inject(slot, R::new_stats());

        wrap.load_outproc_plugin_impl::<R>(
            child_slot.clone(),
            PathBuf::from(plugin_path),
            plugin_id,
        )
        .expect("idempotent re-load of the same path+plugin_id while Active must succeed");
        assert!(
            matches!(
                &*child_slot.lock().expect("lock child slot"),
                ChildSlot::Active { .. }
            ),
            "idempotent re-load must keep the slot Active"
        );
    }

    /// Critical finding: `ChildSlot::Active` への同一 path・**異なる** plugin_id は replacement
    /// 要求として拒否すること（呼び出し側が指定した plugin_id を握り潰して古い plugin_id のまま
    /// 黙って `Ok` を返してはならない）。
    pub(super) fn active_slot_rejects_plugin_id_change<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        plugin_path: &str,
        initial_plugin_id: Option<String>,
        changed_plugin_id: Option<String>,
    ) {
        let slot = active_child_slot::<R>(unique_path, plugin_path, initial_plugin_id.clone());
        let (wrap, child_slot) = inject(slot, R::new_stats());

        let error = wrap
            .load_outproc_plugin_impl::<R>(
                child_slot.clone(),
                PathBuf::from(plugin_path),
                changed_plugin_id,
            )
            .err()
            .expect("same path with a different plugin_id while Active must be rejected");
        assert_error(error, "does not support replacement");
        assert!(
            matches!(
                &*child_slot.lock().expect("lock child slot"),
                ChildSlot::Active { plugin_id, .. } if *plugin_id == initial_plugin_id
            ),
            "rejected plugin_id change must not disturb the previously-active plugin_id"
        );
    }

    /// Important finding 2b: `ChildSlot::Active` への **異なる** path は v1 では replacement
    /// 拒否のまま（既存の Loading 側テストと対になる Active 側の直接検証）。
    pub(super) fn active_slot_rejects_path_replacement<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        plugin_path: &str,
        other_path: &str,
    ) {
        let slot = active_child_slot::<R>(unique_path, plugin_path, None);
        let (wrap, child_slot) = inject(slot, R::new_stats());

        let error = wrap
            .load_outproc_plugin_impl::<R>(child_slot.clone(), PathBuf::from(other_path), None)
            .err()
            .expect("a different path while Active must be rejected");
        assert_error(error, "does not support replacement");
        assert!(matches!(
            &*child_slot.lock().expect("lock child slot"),
            ChildSlot::Active { path, .. } if path == Path::new(plugin_path)
        ));
    }

    /// テスト専用の「slow」child 実行可能ファイル。CLI 引数（`--shm`/`--plugin`/`--sample-rate`
    /// 等）をすべて無視してただ sleep するだけの POSIX shell script。`load_outproc_plugin` が
    /// 経由する `spawn_outproc_child` はこれらの引数を固定で付与するため、素の coreutils
    /// （`sleep`/`cat` 等）は未知オプションとして即 exit してしまい「lock 外で長時間ブロックする」
    /// 状態を再現できない（実際に `sleep` へこれらの引数を渡すと `illegal option` で即終了する）。
    /// このクレートの CI は ubuntu-latest のみを対象とする（Windows 非対応）ので unix 専用で問題ない。
    fn write_slow_child_script(unique_path: &impl Fn() -> PathBuf) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script_path = unique_path().with_extension("sh");
        std::fs::write(&script_path, "#!/bin/sh\nexec sleep 20\n")
            .expect("write slow child script");
        let mut perms = std::fs::metadata(&script_path)
            .expect("stat slow child script")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).expect("chmod slow child script");
        script_path
    }

    fn write_exit_child_script(unique_path: &impl Fn() -> PathBuf) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script_path = unique_path().with_extension("sh");
        std::fs::write(&script_path, "#!/bin/sh\nexit 1\n").expect("write exit child script");
        let mut perms = std::fs::metadata(&script_path)
            .expect("stat exit script")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).expect("chmod exit script");
        script_path
    }

    pub(super) fn early_exit_fast_fails_and_keeps_retry_shm<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        plugin_path: &str,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create shared memory");
        let child_exe = write_exit_child_script(&unique_path);
        let stats = R::new_stats();
        let (wrap, slot) = inject(
            ChildSlot::Empty(child_launch::<R>(
                shm_path.clone(),
                child_exe.clone(),
                stats,
            )),
            R::new_stats(),
        );
        let started = std::time::Instant::now();
        let error = match wrap.load_outproc_plugin_impl::<R>(
            slot.clone(),
            PathBuf::from(plugin_path),
            None,
        ) {
            Ok(_) => panic!("immediately exiting child must fail attach"),
            Err(error) => error,
        };
        assert!(
            matches!(error, WrapError::OutProcAttachFailed(ref msg) if msg.contains("exited before publishing READY"))
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "early exit waited too long"
        );
        assert!(matches!(*slot.lock().unwrap(), ChildSlot::Empty(_)));
        assert!(shm_path.exists(), "retry shm must remain linked");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        assert_eq!(
            unsafe { (*region).control.load(std::sync::atomic::Ordering::Acquire) },
            orbit_audio_sandbox::CONTROL_RUN
        );
        let _ = std::fs::remove_file(child_exe);
    }

    pub(super) fn role_mismatch_retries_same_slot<R: OutProcRole + 'static>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        plugin_path: &str,
        wrong_has_audio_input: bool,
        correct_has_audio_input: bool,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create shared memory");
        let child_exe = write_slow_child_script(&unique_path);
        let stats = R::new_stats();
        let (wrap, slot) = inject(
            ChildSlot::Empty(child_launch::<R>(
                shm_path.clone(),
                child_exe.clone(),
                stats.clone(),
            )),
            stats.clone(),
        );
        for (attempt, has_input) in [(1, wrong_has_audio_input), (2, correct_has_audio_input)] {
            R::current_child_pid_atomic(&stats).store(0, std::sync::atomic::Ordering::Relaxed);
            let wrap_call = wrap.clone();
            let slot_call = slot.clone();
            let path = PathBuf::from(plugin_path);
            let call = std::thread::spawn(move || {
                wrap_call.load_outproc_plugin_impl::<R>(slot_call, path, None)
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            // PID は reset_child_starting の後に publish されるため、この READY はそれによって消されない。
            while R::current_child_pid_atomic(&stats).load(std::sync::atomic::Ordering::Relaxed)
                == 0
            {
                assert!(
                    std::time::Instant::now() < deadline,
                    "attempt {attempt} never completed child spawn"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            let region = orbit_audio_sandbox::region_ptr(&mmap);
            unsafe { orbit_audio_sandbox::transport::publish_child_ready(region, has_input) };
            let result = call.join().expect("load thread panicked");
            if attempt == 1 {
                assert!(
                    matches!(result, Err(WrapError::OutProcAttachFailed(ref msg)) if msg.contains("role does not match"))
                );
                assert!(matches!(*slot.lock().unwrap(), ChildSlot::Empty(_)));
                assert!(shm_path.exists());
                assert_eq!(
                    unsafe { (*region).control.load(std::sync::atomic::Ordering::Acquire) },
                    orbit_audio_sandbox::CONTROL_RUN
                );
            } else {
                result.expect("second attach must reuse Empty slot and succeed");
                assert!(matches!(*slot.lock().unwrap(), ChildSlot::Active { .. }));
            }
        }
        let _ = std::fs::remove_file(child_exe);
    }

    /// Important finding 1: f36e99c の regression guard。`Loading` 中の 2 本目の `LoadPlugin` は、
    /// 1 本目が shm-open/spawn/ready-ack poll（lock 外・最大 `CHILD_READY_TIMEOUT`）で実際に
    /// ブロックしている **最中**でも、mutex 待ちでなく `ChildSlot::Loading` を即座に観測して
    /// fail-fast すること。この lock-scope fix が無いと 2 本目は `.lock()` 自体で最大 10 秒
    /// ブロックされ、意図された「Loading 中は即座に in progress で reject」が到達不能になる。
    pub(super) fn concurrent_load_call_observes_loading_without_blocking<
        R: OutProcRole + 'static,
    >(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        has_audio_input: bool,
        loading_path: &str,
        second_path: &str,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let _mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create shared memory");
        let child_exe = write_slow_child_script(&unique_path);

        let stats = R::new_stats();
        let launch = child_launch::<R>(shm_path.clone(), child_exe.clone(), stats.clone());
        let (wrap, child_slot) = inject(ChildSlot::Empty(launch), stats);

        let wrap_a = wrap.clone();
        let slot_a = child_slot.clone();
        let loading_path_owned = PathBuf::from(loading_path);
        let first_call = std::thread::spawn(move || {
            wrap_a.load_outproc_plugin_impl::<R>(slot_a, loading_path_owned, None)
        });

        // 1本目が Empty -> Loading へ遷移して lock を解放するまで待つ（shm open + spawn は同期的な
        // syscall なので通常数 ms で観測できる。2s は CI 負荷下でも十分な余裕）。
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if matches!(
                &*child_slot.lock().expect("poll child slot"),
                ChildSlot::Loading { .. }
            ) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "first LoadPlugin call never reached ChildSlot::Loading within 2s"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        // 1本目はまだ ready-ack poll 中（child script は READY を publish しない）。この状態で 2本目を
        // 発行し、mutex 待ちでなく即座に "already in progress" で失敗することを検証する。
        let start = std::time::Instant::now();
        let error = wrap
            .load_outproc_plugin_impl::<R>(child_slot.clone(), PathBuf::from(second_path), None)
            .err()
            .expect("concurrent call against a Loading slot must fail");
        let elapsed = start.elapsed();

        assert_error(error, "already in progress");
        assert!(
            elapsed < Duration::from_secs(1),
            "second LoadPlugin call took {elapsed:?} while the first was still parked in its \
             lock-free readiness poll -- it must fail fast on ChildSlot::Loading, not block on \
             the mutex for up to CHILD_READY_TIMEOUT (regression guard for f36e99c)"
        );

        // 後片付け: READY を publish して 1本目を Active まで完走させ、決定的に join する
        // （detach したまま放置すると child プロセス / watchdog スレッドがテストを跨いで残る）。
        let ready_mmap =
            orbit_audio_sandbox::open_shared(&shm_path).expect("open shm to publish READY");
        let region = orbit_audio_sandbox::region_ptr(&ready_mmap);
        // SAFETY: region は直前に開いた ready_mmap を指し、この scope の間生存する。
        unsafe { orbit_audio_sandbox::transport::publish_child_ready(region, has_audio_input) };
        first_call
            .join()
            .expect("first LoadPlugin call thread panicked")
            .expect("first LoadPlugin call must succeed once READY is published");
        let _ = std::fs::remove_file(&child_exe);
    }
}

/// `outproc_health()` の real body（`#[cfg(feature = "outproc-effect")]`）を直接叩く unit test。
///
/// `tests/protocol.rs` の統合テストは default feature build（`outproc-effect` 無効）で走るため、
/// stub（`(0, 0, false, injected)`）しか exercise できず、この real body の match arm は
/// どのテストからも一度も compile even されていなかった（#406 pr-test-analyzer 指摘）。
/// ここは同一 crate 内の `#[cfg(test)]` submodule なので `EngineWrap::outproc`（private field）
/// と `OutProcControl`（private struct）へ直接アクセスできる（親モジュールの private item は子
/// module から可視）。`OutProcEffectStats::new()` / `CallbackTimeStats::new()` はどちらも
/// child process 不要の cheap constructor（plain atomic のみ）なので、`StubBackend` で起動した
/// `EngineWrap` に対して real child を spawn せず `Some(OutProcControl)` を注入できる。
#[cfg(all(test, feature = "outproc-effect"))]
mod outproc_health_tests {
    use super::{ChildSlot, EffectRole, EngineWrap, OutProcControl, OutProcRole, WrapError};
    use crate::backend::StubBackend;
    use crate::outproc_effect::OutProcEffectStats;
    use orbit_audio_native::CallbackTimeStats;
    use std::collections::HashMap;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex, Weak};

    /// `StubBackend` で `EngineWrap` を起動し、real child なしで組み立てた `OutProcControl` を
    /// `self.outproc` に注入する。返す `Arc<OutProcEffectStats>` はテスト側から直接
    /// `store`/`load` して `Ok(Some(c))` real-value summing 経路を駆動するのに使う。
    fn wrap_with_outproc_stats() -> (Arc<EngineWrap>, Arc<OutProcEffectStats>) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let stats = OutProcEffectStats::new();
        *wrap.outproc.lock().expect("lock outproc for injection") = Some(OutProcControl {
            stats: stats.clone(),
            cb_stats: CallbackTimeStats::new(),
            child_slot: Weak::new(),
            bus_slots: HashMap::new(),
            bus_stats: HashMap::new(),
        });
        (wrap, stats)
    }

    fn wrap_with_child_slot(
        slot: ChildSlot<EffectRole>,
        stats: Arc<OutProcEffectStats>,
    ) -> (Arc<EngineWrap>, Arc<Mutex<ChildSlot<EffectRole>>>) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let child_slot = Arc::new(Mutex::new(slot));
        *wrap.outproc.lock().expect("lock outproc for injection") = Some(OutProcControl {
            stats,
            cb_stats: CallbackTimeStats::new(),
            child_slot: Arc::downgrade(&child_slot),
            bus_slots: HashMap::new(),
            bus_stats: HashMap::new(),
        });
        (wrap, child_slot)
    }

    #[test]
    fn load_outproc_effect_plugin_rejects_unknown_bus() {
        let (wrap, _child_slot) =
            wrap_with_child_slot(ChildSlot::Closed, OutProcEffectStats::new());
        let error = wrap
            .load_outproc_effect_plugin(
                std::path::PathBuf::from("unused.clap"),
                None,
                Some("nope".into()),
            )
            .err()
            .expect("unknown bus must be rejected before touching the master slot");
        assert_effect_runtime_error_contains(error, "unknown effect bus 'nope'");
    }

    #[test]
    fn load_outproc_effect_plugin_routes_known_bus_to_its_own_slot_not_master() {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        // master `child_slot` is dropped (Weak::new()), so if the bus lookup fell through to it
        // this call would fail with "stream is closed" instead of reaching the bus-specific slot.
        let bus_slot = Arc::new(Mutex::new(ChildSlot::<EffectRole>::Closed));
        let mut bus_slots = HashMap::new();
        bus_slots.insert("fx1".to_owned(), Arc::downgrade(&bus_slot));
        *wrap.outproc.lock().expect("lock outproc for injection") = Some(OutProcControl {
            stats: OutProcEffectStats::new(),
            cb_stats: CallbackTimeStats::new(),
            child_slot: Weak::new(),
            bus_slots,
            bus_stats: HashMap::new(),
        });
        let error = wrap
            .load_outproc_effect_plugin(
                std::path::PathBuf::from("unused.clap"),
                None,
                Some("fx1".into()),
            )
            .err()
            .expect("closed bus slot still rejects the load, but past the routing step");
        assert_effect_runtime_error_contains(error, "closed after an unrecoverable attach failure");
    }

    fn assert_effect_runtime_error_contains(error: WrapError, expected: &str) {
        assert!(
            matches!(&error,
                WrapError::OutProcEffect(message) | WrapError::OutProcSlotClosed(message)
                if message.contains(expected)),
            "expected OutProcEffect error containing {expected:?}, got {error:?}"
        );
    }

    #[test]
    fn effect_load_outproc_open_shared_failure_closes_slot() {
        super::outproc_load_error_test_support::open_shared_failure_closes_slot(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "unused-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_poisoned_slot_recovers_to_closed_on_open_shared_failure() {
        super::outproc_load_error_test_support::poisoned_slot_open_shared_failure_recovers_to_closed(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            "poisoned-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_spawn_failure_restores_empty_for_retry() {
        super::outproc_load_error_test_support::spawn_failure_restores_empty_for_retry(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "unused-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_early_exit_fast_fails_and_keeps_retry_shm() {
        super::outproc_load_error_test_support::early_exit_fast_fails_and_keeps_retry_shm(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            "exit-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_role_mismatch_retries_same_slot() {
        super::outproc_load_error_test_support::role_mismatch_retries_same_slot(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            "retry-effect.clap",
            false,
            true,
        );
    }

    #[test]
    fn effect_load_outproc_rejects_closed_slot() {
        super::outproc_load_error_test_support::closed_slot_is_rejected(
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "unused-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_rejects_loading_slot() {
        super::outproc_load_error_test_support::loading_slot_is_rejected(
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "already-loading-effect.clap",
            "second-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_concurrent_call_fails_fast_on_loading() {
        super::outproc_load_error_test_support::concurrent_load_call_observes_loading_without_blocking(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            true, // effect role: CHILD_FLAG_HAS_AUDIO_INPUT set
            "loading-effect.clap",
            "second-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_active_accepts_idempotent_reload() {
        super::outproc_load_error_test_support::active_slot_accepts_idempotent_reload(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            "active-effect.clap",
            Some("sub-a".to_string()),
        );
    }

    #[test]
    fn effect_load_outproc_active_rejects_plugin_id_change() {
        super::outproc_load_error_test_support::active_slot_rejects_plugin_id_change(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "active-effect.clap",
            Some("sub-a".to_string()),
            Some("sub-b".to_string()),
        );
    }

    #[test]
    fn effect_load_outproc_active_rejects_path_replacement() {
        super::outproc_load_error_test_support::active_slot_rejects_path_replacement(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "active-effect.clap",
            "other-effect.clap",
        );
    }

    #[test]
    fn effect_ready_ack_requires_audio_input_flag() {
        assert!(EffectRole::role_matches(
            orbit_audio_sandbox::transport::CHILD_FLAG_HAS_AUDIO_INPUT
        ));
        assert!(!EffectRole::role_matches(0));
    }

    #[test]
    fn ok_none_reports_only_injected_frames_clamped() {
        // outproc 未注入（build() 直後の初期値）= Ok(None) 分岐。
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        wrap.outproc_frames_clamped_arc()
            .fetch_add(7, Ordering::Relaxed);
        assert_eq!(wrap.outproc_health(), (0, 0, false, 7));
    }

    #[test]
    fn ok_some_sums_real_stats_with_injected_counter() {
        // Ok(Some(c)) 分岐: 実 OutProcEffectStats スナップショットと injected カウンタを両方
        // 合算して返すこと（finding 3: 実 stats の summing が一度も exercise されていなかった）。
        let (wrap, stats) = wrap_with_outproc_stats();
        stats.child_process_error_count.store(3, Ordering::Relaxed);
        stats.respawn_count.store(2, Ordering::Relaxed);
        stats.measurement_invalid.store(true, Ordering::Relaxed);
        stats.frames_clamped.store(5, Ordering::Relaxed);
        wrap.outproc_frames_clamped_arc()
            .fetch_add(9, Ordering::Relaxed);

        assert_eq!(wrap.outproc_health(), (3, 2, true, 14));
    }

    #[test]
    fn would_block_ignores_real_stats_and_reports_only_injected() {
        // WouldBlock 分岐: 別スレッドが outproc mutex を保持している間は real stats を読まず
        // injected カウンタのみ返すこと（cumulative なので次 tick で real 分も取り戻せる設計）。
        let (wrap, stats) = wrap_with_outproc_stats();
        stats.frames_clamped.store(100, Ordering::Relaxed);
        wrap.outproc_frames_clamped_arc()
            .fetch_add(1, Ordering::Relaxed);

        let wrap_clone = wrap.clone();
        let (holding_tx, holding_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _guard = wrap_clone
                .outproc
                .lock()
                .expect("lock outproc for contention setup");
            holding_tx.send(()).expect("signal lock held");
            release_rx.recv().expect("wait for release signal");
        });
        holding_rx.recv().expect("holder thread signaled lock held");

        assert_eq!(wrap.outproc_health(), (0, 0, false, 1));

        release_tx.send(()).expect("signal release");
        holder.join().expect("holder thread should not panic");
    }

    #[test]
    fn poisoned_still_reports_injected_frames_clamped_not_lost() {
        // Poisoned 分岐: real stats は 0 に丸めるが、injected の frames_clamped は黙って
        // 失わず返すこと（finding 2: silent-failure-hunter が指摘した「値が消えないこと」の
        // 直接検証。手法は PR #403 の genuine-poison パターン（別スレッドで panic → join）を流用）。
        let (wrap, stats) = wrap_with_outproc_stats();
        stats.frames_clamped.store(42, Ordering::Relaxed);
        wrap.outproc_frames_clamped_arc()
            .fetch_add(3, Ordering::Relaxed);

        let wrap_clone = wrap.clone();
        let panicked = std::thread::spawn(move || {
            let _guard = wrap_clone
                .outproc
                .lock()
                .expect("lock outproc for poison setup");
            panic!("intentional poison for outproc_health poisoned test");
        })
        .join()
        .is_err();
        assert!(
            panicked,
            "spawned thread should have panicked while holding the lock"
        );

        assert_eq!(wrap.outproc_health(), (0, 0, false, 3));
    }
}

/// `outproc_instrument_health()` の real body（`#[cfg(feature = "outproc-instrument")]`）を直接叩く
/// unit test。`outproc_health_tests` と同じ理由（`tests/protocol.rs` の統合テストは default feature
/// build で走るため real body の match arm がどのテストからも一度も compile even されない）で、この
/// `#[cfg(test)]` submodule から `EngineWrap::outproc_instrument`（private field）と
/// `OutProcInstrumentControl`（private struct）へ直接アクセスして注入する。
#[cfg(all(test, feature = "outproc-instrument"))]
mod outproc_instrument_health_tests {
    use super::{
        ChildLaunch, ChildSlot, EngineWrap, InstrumentRole, OutProcInstrumentControl, OutProcRole,
        WrapError,
    };
    use crate::backend::StubBackend;
    use crate::outproc_instrument::OutProcInstrumentStats;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, Weak};

    /// `StubBackend` で `EngineWrap` を起動し、real child なしで組み立てた `OutProcInstrumentControl`
    /// を `self.outproc_instrument` に注入する。event_tx の consumer 側は即 drop するが、この
    /// テストは health accessor だけを exercise するので note の push は行わない。
    fn wrap_with_instrument_stats() -> (Arc<EngineWrap>, Arc<OutProcInstrumentStats>) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let stats = OutProcInstrumentStats::new();
        let (event_tx, _event_rx) = rtrb::RingBuffer::new(4);
        *wrap
            .outproc_instrument
            .lock()
            .expect("lock instrument control for injection") = Some(OutProcInstrumentControl {
            event_tx,
            stats: stats.clone(),
            child_slot: Weak::new(),
        });
        (wrap, stats)
    }

    fn wrap_with_child_slot(
        slot: ChildSlot<InstrumentRole>,
        stats: Arc<OutProcInstrumentStats>,
    ) -> (Arc<EngineWrap>, Arc<Mutex<ChildSlot<InstrumentRole>>>) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let child_slot = Arc::new(Mutex::new(slot));
        let (event_tx, _event_rx) = rtrb::RingBuffer::new(4);
        *wrap
            .outproc_instrument
            .lock()
            .expect("lock instrument control for injection") = Some(OutProcInstrumentControl {
            event_tx,
            stats,
            child_slot: Arc::downgrade(&child_slot),
        });
        (wrap, child_slot)
    }

    fn assert_instrument_runtime_error_contains(error: WrapError, expected: &str) {
        assert!(
            matches!(&error,
                WrapError::OutProcInstrument(message) | WrapError::OutProcSlotClosed(message)
                if message.contains(expected)),
            "expected OutProcInstrument error containing {expected:?}, got {error:?}"
        );
    }

    #[test]
    fn instrument_load_outproc_open_shared_failure_closes_slot() {
        super::outproc_load_error_test_support::open_shared_failure_closes_slot(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "unused-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_spawn_failure_restores_empty_for_retry() {
        super::outproc_load_error_test_support::spawn_failure_restores_empty_for_retry(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "unused-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_early_exit_fast_fails_and_keeps_retry_shm() {
        super::outproc_load_error_test_support::early_exit_fast_fails_and_keeps_retry_shm(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            "exit-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_role_mismatch_retries_same_slot() {
        super::outproc_load_error_test_support::role_mismatch_retries_same_slot(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            "retry-instrument.clap",
            true,
            false,
        );
    }

    #[test]
    fn instrument_select_child_exe_swaps_default_child_by_extension() {
        let stats = InstrumentRole::new_stats();
        let mut launch = ChildLaunch::<InstrumentRole> {
            shm_path: PathBuf::from("/tmp/unused-select-child-exe.shm"),
            child_exe: PathBuf::from("/opt/orbitscore/orbit-clap-instrument-child"),
            sample_rate: 48_000,
            stats: stats.clone(),
            engaged: Arc::new(AtomicBool::new(false)),
            cleanup_shm_on_drop: false,
        };

        InstrumentRole::select_child_exe(&mut launch, Path::new("synth.vst3"))
            .expect("select_child_exe must not error on default child name");
        assert_eq!(
            launch.child_exe.file_name().and_then(|name| name.to_str()),
            Some("orbit-vst3-instrument-child")
        );

        // Symmetric: attaching a .clap plugin afterwards swaps back to the CLAP child.
        InstrumentRole::select_child_exe(&mut launch, Path::new("synth.clap"))
            .expect("select_child_exe must not error on default child name");
        assert_eq!(
            launch.child_exe.file_name().and_then(|name| name.to_str()),
            Some("orbit-clap-instrument-child")
        );

        // An explicitly-named (non-default) child exe is preserved untouched.
        let mut explicit_launch = ChildLaunch::<InstrumentRole> {
            shm_path: PathBuf::from("/tmp/unused-select-child-exe-explicit.shm"),
            child_exe: PathBuf::from("/opt/orbitscore/custom-instrument-child"),
            sample_rate: 48_000,
            stats,
            engaged: Arc::new(AtomicBool::new(false)),
            cleanup_shm_on_drop: false,
        };
        InstrumentRole::select_child_exe(&mut explicit_launch, Path::new("synth.vst3"))
            .expect("select_child_exe must not error on explicit child name");
        assert_eq!(
            explicit_launch
                .child_exe
                .file_name()
                .and_then(|name| name.to_str()),
            Some("custom-instrument-child")
        );
    }

    #[test]
    fn instrument_load_outproc_rejects_closed_slot() {
        super::outproc_load_error_test_support::closed_slot_is_rejected(
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "unused-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_rejects_loading_slot() {
        super::outproc_load_error_test_support::loading_slot_is_rejected(
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "already-loading-instrument.clap",
            "second-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_concurrent_call_fails_fast_on_loading() {
        super::outproc_load_error_test_support::concurrent_load_call_observes_loading_without_blocking(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            false, // instrument role: CHILD_FLAG_HAS_AUDIO_INPUT must stay clear
            "loading-instrument.clap",
            "second-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_active_accepts_idempotent_reload() {
        super::outproc_load_error_test_support::active_slot_accepts_idempotent_reload(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            "active-instrument.clap",
            Some("sub-a".to_string()),
        );
    }

    #[test]
    fn instrument_load_outproc_active_rejects_plugin_id_change() {
        super::outproc_load_error_test_support::active_slot_rejects_plugin_id_change(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "active-instrument.clap",
            Some("sub-a".to_string()),
            Some("sub-b".to_string()),
        );
    }

    #[test]
    fn instrument_load_outproc_active_rejects_path_replacement() {
        super::outproc_load_error_test_support::active_slot_rejects_path_replacement(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "active-instrument.clap",
            "other-instrument.clap",
        );
    }

    #[test]
    fn instrument_ready_ack_rejects_audio_input_flag() {
        assert!(InstrumentRole::role_matches(0));
        assert!(!InstrumentRole::role_matches(
            orbit_audio_sandbox::transport::CHILD_FLAG_HAS_AUDIO_INPUT
        ));
    }

    // `outproc_instrument_health()` mirrors `outproc_health_tests` (effect side) exactly --
    // Ok(None)/Ok(Some)/WouldBlock/Poisoned branches. It bundles all 6 instrument health signals
    // (child-process trio + output-event-overflow trio + event_decode_error_count) into one
    // accessor/one try_lock, so every test below uses distinct values to catch a field-to-field
    // mapping swap anywhere in the tuple.

    #[test]
    fn health_ok_none_reports_only_injected_values() {
        // instrument 未注入（build() 直後の初期値）= Ok(None) 分岐。
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        wrap.outproc_instrument_child_errors_arc()
            .fetch_add(4, Ordering::Relaxed);
        wrap.outproc_instrument_respawns_arc()
            .fetch_add(2, Ordering::Relaxed);
        wrap.outproc_instrument_measurement_invalid_arc()
            .store(true, Ordering::Relaxed);
        wrap.outproc_instrument_output_dropped_arc()
            .fetch_add(7, Ordering::Relaxed);
        assert_eq!(
            wrap.outproc_instrument_health(),
            (4, 2, true, 7, 0, 0, 0),
            "Ok(None): only injected counters/flag surface; real output-event fields are 0"
        );
    }

    #[test]
    fn health_ok_some_sums_real_stats_with_injected_counters() {
        // Ok(Some(c)) 分岐: 実 OutProcInstrumentStats スナップショットと injected カウンタを両方
        // 合算/OR して返すこと（6 値とも異なる数にして field-to-field mapping の swap を検知
        // できるようにする -- `outproc_health_tests::ok_some_sums_real_stats_with_injected_counter`
        // と同じ意図）。
        let (wrap, stats) = wrap_with_instrument_stats();
        stats.child_process_error_count.store(3, Ordering::Relaxed);
        stats.respawn_count.store(2, Ordering::Relaxed);
        stats.measurement_invalid.store(true, Ordering::Relaxed);
        stats
            .output_event_dropped_count
            .store(11, Ordering::Relaxed);
        stats
            .output_event_spilled_count
            .store(13, Ordering::Relaxed);
        stats
            .output_note_end_dropped_count
            .store(6, Ordering::Relaxed);
        stats.event_decode_error_count.store(8, Ordering::Relaxed);
        wrap.outproc_instrument_child_errors_arc()
            .fetch_add(9, Ordering::Relaxed);
        wrap.outproc_instrument_respawns_arc()
            .fetch_add(5, Ordering::Relaxed);
        wrap.outproc_instrument_output_dropped_arc()
            .fetch_add(1, Ordering::Relaxed);

        assert_eq!(
            wrap.outproc_instrument_health(),
            (12, 7, true, 12, 13, 6, 8)
        );
    }

    #[test]
    fn health_would_block_ignores_real_stats_and_reports_only_injected() {
        // WouldBlock 分岐: 別スレッドが outproc_instrument mutex を保持している間は real stats を
        // 読まず injected 分のみ返すこと（cumulative なので次 tick で real 分も取り戻せる設計）。
        let (wrap, stats) = wrap_with_instrument_stats();
        stats
            .child_process_error_count
            .store(100, Ordering::Relaxed);
        stats.measurement_invalid.store(true, Ordering::Relaxed);
        stats
            .output_event_dropped_count
            .store(200, Ordering::Relaxed);
        wrap.outproc_instrument_child_errors_arc()
            .fetch_add(1, Ordering::Relaxed);
        wrap.outproc_instrument_output_dropped_arc()
            .fetch_add(4, Ordering::Relaxed);

        let wrap_clone = wrap.clone();
        let (holding_tx, holding_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _guard = wrap_clone
                .outproc_instrument
                .lock()
                .expect("lock outproc_instrument for contention setup");
            holding_tx.send(()).expect("signal lock held");
            release_rx.recv().expect("wait for release signal");
        });
        holding_rx.recv().expect("holder thread signaled lock held");

        assert_eq!(wrap.outproc_instrument_health(), (1, 0, false, 4, 0, 0, 0));

        release_tx.send(()).expect("signal release");
        holder.join().expect("holder thread should not panic");
    }

    #[test]
    fn health_poisoned_still_reports_injected_values_not_lost() {
        // Poisoned 分岐: real stats は 0/false に丸めるが、injected 分は黙って失わず返すこと
        // (`outproc_health_tests::poisoned_still_reports_injected_frames_clamped_not_lost` と同じ
        // genuine-poison パターン: 別スレッドで panic → join)。
        let (wrap, stats) = wrap_with_instrument_stats();
        stats.child_process_error_count.store(42, Ordering::Relaxed);
        stats.measurement_invalid.store(true, Ordering::Relaxed);
        stats
            .output_event_dropped_count
            .store(99, Ordering::Relaxed);
        wrap.outproc_instrument_child_errors_arc()
            .fetch_add(3, Ordering::Relaxed);
        wrap.outproc_instrument_output_dropped_arc()
            .fetch_add(2, Ordering::Relaxed);

        let wrap_clone = wrap.clone();
        let panicked = std::thread::spawn(move || {
            let _guard = wrap_clone
                .outproc_instrument
                .lock()
                .expect("lock outproc_instrument for poison setup");
            panic!("intentional poison for outproc_instrument_health poisoned test");
        })
        .join()
        .is_err();
        assert!(
            panicked,
            "spawned thread should have panicked while holding the lock"
        );

        assert_eq!(wrap.outproc_instrument_health(), (3, 0, false, 2, 0, 0, 0));
    }
}

#[cfg(all(test, feature = "outproc-instrument"))]
mod outproc_instrument_note_tests {
    use super::{EngineWrap, OutProcInstrumentControl, WrapError};
    use crate::backend::StubBackend;
    use orbit_audio_sandbox::{NeutralEvent, VoiceAddr};

    fn wrap_with_note_consumer(
        capacity: usize,
    ) -> (std::sync::Arc<EngineWrap>, rtrb::Consumer<NeutralEvent>) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let (event_tx, event_rx) = rtrb::RingBuffer::new(capacity);
        let stats = crate::outproc_instrument::OutProcInstrumentStats::new();
        *wrap
            .outproc_instrument
            .lock()
            .expect("lock instrument control") = Some(OutProcInstrumentControl {
            event_tx,
            stats,
            child_slot: std::sync::Weak::new(),
        });
        (wrap, event_rx)
    }

    #[test]
    fn plugin_notes_are_converted_to_neutral_events_on_control_side() {
        let (wrap, mut event_rx) = wrap_with_note_consumer(4);
        wrap.plugin_note_on(60, 3, 0.75).expect("send note on");
        wrap.plugin_note_off(61, 4, 0.25).expect("send note off");

        let expected_addr = |channel, key| VoiceAddr {
            note_id: -1,
            port_index: 0,
            channel,
            key,
            _pad: 0,
        };
        assert_eq!(
            event_rx.pop(),
            Ok(NeutralEvent::NoteOn {
                sample_offset: 0,
                addr: expected_addr(3, 60),
                velocity: 0.75,
                tuning_cents: 0.0,
                length_frames: 0,
            })
        );
        assert_eq!(
            event_rx.pop(),
            Ok(NeutralEvent::NoteOff {
                sample_offset: 0,
                addr: expected_addr(4, 61),
                velocity: 0.25,
            })
        );
    }

    // pr-test-analyzer (item 6, PR #422 review): `push_outproc_instrument_event`'s ring-full error
    // path (increments `plugin_event_ring_overflow_count`, returns `WrapError::OutProcInstrument`)
    // had no coverage. A capacity-1 ring plus a consumer that never drains guarantees the ring
    // fills; loop until `plugin_note_on` errors rather than assuming rtrb's exact fill count.
    #[test]
    fn push_outproc_instrument_event_reports_ring_full_and_increments_overflow_counter() {
        let (wrap, _event_rx) = wrap_with_note_consumer(1);
        let before = wrap.plugin_event_ring_overflow_count();

        let mut result = Ok(());
        for _ in 0..8 {
            result = wrap.plugin_note_on(60, 0, 0.8);
            if result.is_err() {
                break;
            }
        }

        let err = result.expect_err("ring must eventually report full (never drained)");
        assert!(
            matches!(err, WrapError::OutProcInstrument(_)),
            "expected OutProcInstrument(ring full), got {err:?}"
        );
        assert_eq!(
            wrap.plugin_event_ring_overflow_count(),
            before + 1,
            "ring-full push must increment the overflow counter exactly once"
        );
    }

    // pr-test-analyzer (item 8, PR #422 review): `push_outproc_instrument_event`'s `None` branch
    // (outproc_instrument not initialized, e.g. test backend) had no direct test, unlike the
    // analogous and already-tested `clap-host` `ClapUnavailable` branch
    // (`push_plugin_event_tests`) in this same file.
    #[test]
    fn plugin_note_on_returns_unavailable_when_not_initialized() {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let err = wrap
            .plugin_note_on(60, 0, 0.8)
            .expect_err("outproc_instrument mutex holds None by default (no injection)");
        assert!(
            matches!(err, WrapError::OutProcInstrumentUnavailable(_)),
            "expected OutProcInstrumentUnavailable, got {err:?}"
        );
    }

    #[test]
    fn plugin_note_off_returns_unavailable_when_not_initialized() {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let err = wrap
            .plugin_note_off(60, 0, 0.0)
            .expect_err("outproc_instrument mutex holds None by default (no injection)");
        assert!(
            matches!(err, WrapError::OutProcInstrumentUnavailable(_)),
            "expected OutProcInstrumentUnavailable, got {err:?}"
        );
    }
}
