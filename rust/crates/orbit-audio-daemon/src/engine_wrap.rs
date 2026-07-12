//! Engine + ロード済みサンプル / 再生管理の wrapper。
//!
//! `Arc<Mutex>` ベースで制御スレッドと audio callback を共有する。
//! audio callback 側は `try_lock` で競合時に無音 fallback する前提（lock-free 化は別 Issue）。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(feature = "clap-host")]
use std::time::Duration;

use orbit_audio_core::{resolve_slice_region, sanitize_rate, Engine, Sample};
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
}

/// CLAP host の control-side ハンドル一式（feature `clap-host` 専用）。
#[cfg(feature = "clap-host")]
struct ClapControl {
    /// 専用スレッドへ `LoadPlugin` を送る Sender。
    cmd_tx: std::sync::mpsc::Sender<crate::clap_host::ClapCommand>,
    /// audio thread（cpal callback の `ClapPostProcessor`）へ note を渡す event ring producer。
    event_tx: rtrb::Producer<orbit_clap_host::PluginEvent>,
    /// CLAP processor 統計（post-mix peak / process error 等）。daemon が読む。
    stats: Arc<orbit_clap_host::ClapProcessorStats>,
    /// callback-duration 統計（A0 §6: CoreAudio+cpal は xrun 不発火 → RT 健全性は callback 実測時間で
    /// 測る）。daemon の RT 監視 / gated test の budget 検証が読む。
    cb_stats: Arc<orbit_audio_native::CallbackTimeStats>,
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
/// なお `link-audio` / `clap-host` / `outproc-effect` は 3 者すべて併用不可（`compile_error!`）なので
/// 複数ブロックが同時に存在することはない。
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
    _child_guard: crate::outproc_effect::EffectChildSupervisor,
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
        not(feature = "outproc-effect")
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
    #[cfg(all(feature = "link-audio", not(feature = "clap-host")))]
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
    #[cfg(all(feature = "clap-host", not(feature = "link-audio")))]
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
    /// post-processor 経路付きで起動する。production は環境変数（`ORBIT_EFFECT_PLUGIN` 等）から設定を
    /// 組む。設定不足は `OutProcEffectUnavailable`（feature-gap と同じ握り潰し対象）。
    #[cfg(all(
        feature = "outproc-effect",
        not(feature = "clap-host"),
        not(feature = "link-audio")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let cfg = crate::outproc_effect::OutProcEffectConfig::from_env()
            .map_err(WrapError::OutProcEffectUnavailable)?;
        Self::start_outproc_effect(cfg)
    }

    /// OOP effect 経路の本体（`start()`（env 由来）と gated harness（明示 path）が共有する）。
    /// shm 作成 → host mmap → adapter → cpal stream（sample_rate 確定）→ 初回 child spawn → watchdog
    /// supervisor の順で組み、`StreamGuard` の field 順で teardown を強制する（drop 順は本ファイル冒頭の
    /// `StreamGuard` doc 参照）。初回 child spawn 失敗は shm を掃除して `OutProcEffect` を返す。
    #[cfg(feature = "outproc-effect")]
    pub fn start_outproc_effect(
        cfg: crate::outproc_effect::OutProcEffectConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        use crate::outproc_effect::{
            spawn_effect_child, EffectChildSupervisor, OutProcEffectPostProcessor,
            OutProcEffectStats, OutProcTeardownGuard,
        };
        use std::sync::atomic::AtomicBool;

        // 1. shm 作成 → host mmap（adapter が所有・audio thread）。
        let shm_path = crate::outproc_effect::unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&shm_path)
            .map_err(|e| WrapError::OutProcEffect(format!("create shm {shm_path:?}: {e}")))?;
        let host = orbit_audio_sandbox::PipelinedEffectHost::from_mmap(host_mmap);

        // 2. teardown flags + 観測 stats + adapter。
        let teardown_requested = Arc::new(AtomicBool::new(false));
        let teardown_done = Arc::new(AtomicBool::new(false));
        let stats = OutProcEffectStats::new();
        let processor = Box::new(OutProcEffectPostProcessor::new(
            host,
            teardown_requested.clone(),
            teardown_done.clone(),
            stats.clone(),
        ));

        // 3. cpal stream 起動（ここで device の sample_rate が確定する）。adapter を注入する。
        //    gated stale-rate harness は cfg.buffer_frames に 32/64 を渡し小バッファを要求する。
        let (engine, stream, stream_stats, cb_stats) =
            orbit_audio_native::start_default_output_with_clap(
                processor,
                cfg.buffer_frames,
                capture_path_from_env(),
            )
            .map_err(WrapError::Output)?;
        let sample_rate = stream.sample_rate;

        // 4. 初回 child を同期 spawn（spawn 失敗を呼び出し側に返すため supervisor 外で起動）。
        //    失敗時は作成済み shm を掃除する（stream はこの関数の早期 return で drop される）。
        let first_child = match spawn_effect_child(
            &cfg.child_exe,
            &shm_path,
            &cfg.plugin,
            cfg.plugin_id.as_deref(),
            sample_rate,
        ) {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&shm_path);
                return Err(WrapError::OutProcEffect(format!(
                    "spawn effect child {:?}: {e}",
                    cfg.child_exe
                )));
            }
        };
        // current_child_pid を watchdog 起動前に publish（startup race 回避・advisor）: test が
        // watchdog の初回 store を待たずに PID を読めるようにする。
        stats
            .current_child_pid
            .store(first_child.id(), Ordering::Relaxed);

        // 5. supervisor（watchdog spawn・2nd control mapping を内部で open）。
        let supervisor = EffectChildSupervisor::spawn(
            first_child,
            shm_path,
            stats.clone(),
            cfg.child_exe,
            cfg.plugin,
            cfg.plugin_id,
            sample_rate,
        )
        .map_err(|e| WrapError::OutProcEffect(format!("spawn watchdog: {e}")))?;

        // 6. wrap 構築 + control 注入。
        let wrap = Self::build(engine, stream.sample_rate, stream.channels, stream_stats);
        *wrap
            .outproc
            .lock()
            .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))? =
            Some(OutProcControl { stats, cb_stats });

        // 7. StreamGuard（field 順 = teardown 順）。
        Ok((
            wrap,
            StreamGuard {
                _outproc_teardown: OutProcTeardownGuard::new(teardown_requested, teardown_done),
                _stream: stream,
                _child_guard: supervisor,
            },
        ))
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
    ) -> Result<LoadedPluginSummary, WrapError> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        {
            // lock は send までで解放し、reply 待ちの blocking を mutex 外で行う。
            let guard = self
                .clap
                .lock()
                .map_err(|_| WrapError::Clap("clap mutex poisoned".into()))?;
            let ctl = guard.as_ref().ok_or_else(|| {
                WrapError::ClapUnavailable(
                    "clap host not initialized (test backend has no clap path)".into(),
                )
            })?;
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

    /// feature `clap-host` 無効ビルド用の stub。
    #[cfg(not(feature = "clap-host"))]
    pub fn plugin_note_on(&self, _key: u8, _channel: u8, _velocity: f64) -> Result<(), WrapError> {
        Err(WrapError::ClapUnavailable(
            "engine built without 'clap-host' feature".into(),
        ))
    }

    /// feature `clap-host` 無効ビルド用の stub。
    #[cfg(not(feature = "clap-host"))]
    pub fn plugin_note_off(&self, _key: u8, _channel: u8, _velocity: f64) -> Result<(), WrapError> {
        Err(WrapError::ClapUnavailable(
            "engine built without 'clap-host' feature".into(),
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

        let result = wrap.load_plugin(PathBuf::from("dummy.clap"), None);
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
    use super::{EngineWrap, OutProcControl};
    use crate::backend::StubBackend;
    use crate::outproc_effect::OutProcEffectStats;
    use orbit_audio_native::CallbackTimeStats;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

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
        });
        (wrap, stats)
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
