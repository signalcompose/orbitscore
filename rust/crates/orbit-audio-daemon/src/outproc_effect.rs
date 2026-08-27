//! γ M1 PR-C: out-of-process effect の daemon 配線（feature `outproc-effect` 専用・clack-free）。
//!
//! 検証済み pipelined（候補B）sandbox host（`orbit-audio-sandbox`）を本番 daemon の master-bus
//! post-processor 経路（`orbit_audio_native::PostProcessor` seam）に統合する。effect は **別プロセス**
//! （`orbit-clap-effect-child`）で実 CLAP plugin を host し、本 crate は共有メモリ transport
//! （memmap2 のみ・clack 非依存）越しに 1-block ずらして audio を流す（serial insert）。
//!
//! ## なぜ daemon 側か（設計 §4.1/§4.6）
//! [`OutProcEffectPostProcessor`] は `orbit_audio_native::PostProcessor` を実装する。sandbox crate は
//! native/cpal/clack 非依存を保つ設計なので、`PostProcessor` を impl する adapter は daemon（native が
//! ある所）に置く。adapter は `PipelinedEffectHost`（clack-free）を薄く包むだけで、clack は spawn
//! された child プロセスだけにリンクされる（daemon の依存グラフは clack-free）。
//!
//! ## teardown 順（load-bearing・設計 §4.5 / advisor）
//! `EngineWrap::StreamGuard` の field 順 `[_outproc_teardown, _stream, _child_guard]` が drop 順で
//! 以下を強制する:
//! 1. [`OutProcTeardownGuard`]（stream 前）= `teardown_requested` を立て `teardown_done` を待つ →
//!    audio thread の adapter が transport（shm）への submit を止めて dry 素通しに入る。
//! 2. `OutputStream` = cpal callback 停止 → adapter を所有する callback closure が drop され host mmap も
//!    unmap される（unmap タイミングは cpal backend 依存。ただし「audio thread が shm を触らない」安全性
//!    自体は step 1 の teardown handshake が既に保証しており、unmap タイミングには依存しない）。
//! 3. [`EffectChildSupervisor`]（stream 後）= **先に watchdog を止め**（drop で `shutdown` を立て respawn を
//!    停止）、その後 **watchdog 自身が** child へ QUIT を送って reap する（`EffectChildSupervisor::drop` は
//!    `shutdown` 設定 + join のみ・QUIT は watchdog の終了経路が行う）。最後に supervisor が join 後に shm を
//!    unlink する。watchdog 停止を QUIT/reap より先にやらないと、teardown 中の child を watchdog が respawn してしまう。

// 共有メモリは生ポインタ経由でクロスプロセス参照するため unsafe FFI 同等。
#![allow(unsafe_code)]

use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use orbit_audio_native::PostProcessor;
use orbit_audio_sandbox::{
    open_shared, region_ptr, CommandMailboxHost, PipelinedEffectHost, UiEventPump, CONTROL_QUIT,
};

use crate::engine_wrap::PluginUiWiring;
use crate::outproc_respawn_guard::{
    advance_fast_respawn_streak, drain_ui_pump, poll_ui_pump_once, service_ui_pump_on_respawn,
};

fn enabled_by_default() -> bool {
    true
}

/// Control/watchdog-owned authoritative effect-rack configuration. The audio thread never reads
/// this value; it only observes the rack child through shared memory.
pub type ChainConfig = Vec<ChainStageConfig>;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ChainStageConfig {
    Catalog {
        path: PathBuf,
        #[serde(default)]
        plugin_id: Option<String>,
        #[serde(default, rename = "state")]
        latest_state: Option<PathBuf>,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
    Standard {
        name: String,
        #[serde(default)]
        params: BTreeMap<String, f64>,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum EffectChainStageSpec {
    Catalog {
        path: PathBuf,
        #[serde(default)]
        plugin_id: Option<String>,
        #[serde(default)]
        state: Option<PathBuf>,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
    Standard {
        name: String,
        #[serde(default)]
        params: BTreeMap<String, f64>,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
    Layer {
        branches: serde_json::Value,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum EffectChainPlanStage {
    Keep {
        prev_index: usize,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(default)]
        params: BTreeMap<String, f64>,
    },
    Load {
        #[serde(flatten)]
        stage: EffectChainStageSpec,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SaveDroppedStage {
    pub prev_index: usize,
    pub path: PathBuf,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EffectChainPlan {
    pub chain: Vec<EffectChainPlanStage>,
    #[serde(default)]
    pub save_dropped: Vec<SaveDroppedStage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyEffectChainMode {
    Diff,
    Rebuild,
}

#[derive(serde::Serialize)]
struct ChainManifest<'a> {
    version: u32,
    stages: &'a ChainConfig,
}

#[derive(serde::Serialize)]
struct ApplyPlanManifest<'a> {
    version: u32,
    stages: &'a [EffectChainPlanStage],
    save_dropped: &'a [SaveDroppedStage],
}

pub(crate) fn chain_manifest_path(shm_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.chain.json", shm_path.display()))
}

pub(crate) fn apply_plan_path(shm_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.apply.json", shm_path.display()))
}

pub(crate) fn write_chain_manifest(shm_path: &Path, chain: &ChainConfig) -> io::Result<PathBuf> {
    let path = chain_manifest_path(shm_path);
    let bytes = serde_json::to_vec(&ChainManifest {
        version: 1,
        stages: chain,
    })
    .map_err(io::Error::other)?;
    std::fs::write(&path, bytes)?;
    Ok(path)
}

pub(crate) fn write_apply_plan(shm_path: &Path, plan: &EffectChainPlan) -> io::Result<PathBuf> {
    let path = apply_plan_path(shm_path);
    let bytes = serde_json::to_vec(&ApplyPlanManifest {
        version: 1,
        stages: &plan.chain,
        save_dropped: &plan.save_dropped,
    })
    .map_err(io::Error::other)?;
    std::fs::write(&path, bytes)?;
    Ok(path)
}

pub(crate) fn desired_chain(
    previous: &ChainConfig,
    plan: &EffectChainPlan,
) -> Result<ChainConfig, String> {
    for dropped in &plan.save_dropped {
        match previous.get(dropped.prev_index) {
            Some(ChainStageConfig::Catalog { .. }) => {}
            Some(ChainStageConfig::Standard { .. }) => {
                return Err(
                    "standard plugins have no UI/state; parameters live in the DSL (SC.10.8)"
                        .into(),
                )
            }
            None => {
                return Err(format!(
                    "save_dropped prev_index {} is outside the previous chain",
                    dropped.prev_index
                ))
            }
        }
    }

    let mut kept = HashSet::new();
    let mut next = Vec::with_capacity(plan.chain.len());
    for (new_index, operation) in plan.chain.iter().enumerate() {
        let stage = match operation {
            EffectChainPlanStage::Keep {
                prev_index,
                enabled,
                params,
            } => {
                if !kept.insert(*prev_index) {
                    return Err(format!(
                        "effect chain apply failed at index {new_index}: prev_index {prev_index} is kept more than once; the previous chain is kept"
                    ));
                }
                match previous.get(*prev_index) {
                    Some(ChainStageConfig::Catalog {
                        path,
                        plugin_id,
                        latest_state,
                        ..
                    }) => {
                        if !params.is_empty() {
                            return Err(format!(
                                "effect chain apply failed at index {new_index}: keep params are valid only for standard stages; the previous chain is kept"
                            ));
                        }
                        ChainStageConfig::Catalog {
                            path: path.clone(),
                            plugin_id: plugin_id.clone(),
                            latest_state: latest_state.clone(),
                            enabled: *enabled,
                        }
                    }
                    Some(ChainStageConfig::Standard {
                        name,
                        params: old_params,
                        ..
                    }) => {
                        let mut merged = old_params.clone();
                        merged.extend(params.clone());
                        ChainStageConfig::Standard {
                            name: name.clone(),
                            params: merged,
                            enabled: *enabled,
                        }
                    }
                    None => {
                        return Err(format!(
                            "effect chain apply failed at index {new_index}: prev_index {prev_index} is outside the previous chain; the previous chain is kept"
                        ))
                    }
                }
            }
            EffectChainPlanStage::Load { stage } => match stage {
                EffectChainStageSpec::Catalog {
                    path,
                    plugin_id,
                    state,
                    enabled,
                } => ChainStageConfig::Catalog {
                    path: path.clone(),
                    plugin_id: plugin_id.clone(),
                    latest_state: state.clone(),
                    enabled: *enabled,
                },
                EffectChainStageSpec::Standard {
                    name,
                    params,
                    enabled,
                } => ChainStageConfig::Standard {
                    name: name.clone(),
                    params: params.clone(),
                    enabled: *enabled,
                },
                EffectChainStageSpec::Layer { .. } => {
                    return Err(format!(
                        "effect chain apply failed at index {new_index}: layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only; the previous chain is kept"
                    ))
                }
            },
        };
        next.push(stage);
    }
    Ok(next)
}

/// watchdog が child の生存を poll する周期（非 RT・control thread）。
const WATCHDOG_POLL: Duration = Duration::from_millis(20);
/// QUIT 後に child の終了を待つ上限（超えたら kill にフォールバック）。`SandboxChildGuard` と同値。
const REAP_TIMEOUT: Duration = Duration::from_secs(2);
/// teardown handshake 待ち上限（audio thread が `teardown_done` を立てるのを待つ）。device が callback を
/// 配送しない異常系の安全弁（`ClapTeardownGuard` と同値・設計 §4.5）。
const TEARDOWN_TIMEOUT: Duration = Duration::from_millis(500);
/// `try_wait` が連続失敗した場合に supervise 不能とみなして escalate する閾値。`WATCHDOG_POLL`(20ms) と
/// 合わせ ~1s 連続失敗で計測無効化 + 終了し、log flood を防ぐ（child handle が壊れた異常系の安全弁）。
const TRY_WAIT_ERROR_LIMIT: u32 = 50;
/// 「速い失敗」とみなす生存時間の閾値（#573）。child がこの時間未満で終了したら「起動直後に死んだ」と
/// みなし連続 fast-fail カウンタを進める。以上生きていれば単発クラッシュとみなしカウンタをリセットし
/// 従来どおり復帰する。`CHILD_READY_TIMEOUT`（`engine_wrap.rs`・60s・attach の READY 待ち上限）より十分
/// 短く、`WATCHDOG_POLL`（20ms）よりずっと長い値にする: plugin の実際の初期化コスト（数百ms〜数秒）を
/// fast-fail に含めたくない一方、attach 後に一瞬で死ぬパターンは確実に拾いたい。
const FAST_RESPAWN_THRESHOLD: Duration = Duration::from_secs(2);
/// 連続 fast-fail の上限（#573）。到達したら respawn をやめて watchdog を終了する（tight loop で
/// child を無限に spawn し続けない安全弁）。`TRY_WAIT_ERROR_LIMIT`（50）と異なり閾値を低くしているのは、
/// こちらは spawn 自体は成功し続ける異常系（無限に respawn する実害が毎回すぐ出る）だから: 5 回連続で
/// `FAST_RESPAWN_THRESHOLD` 未満の生存が続くのは統計的な偶然ではなく構造的な即死とみなせる
/// （単発クラッシュはこの回数に達する前にカウンタがリセットされる）。
const MAX_CONSECUTIVE_FAST_RESPAWNS: u32 = 5;

/// 同一プロセス内で複数の OOP effect を起動した時に shm ファイル名が衝突しないための連番。
static SHM_SEQ: AtomicU64 = AtomicU64::new(0);

/// OOP effect 用の一意な共有メモリファイルパスを返す（PID + 連番）。
pub fn unique_shm_path() -> PathBuf {
    let seq = SHM_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    std::env::temp_dir().join(format!("orbit-outproc-effect-{pid}-{seq}.shm"))
}

/// OOP effect child が host する plugin format。transport/watchdog/respawn は format 非依存。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginFormat {
    Clap,
    Vst3,
}

impl PluginFormat {
    fn from_env_value(value: Option<String>) -> Result<Self, String> {
        match value.as_deref().unwrap_or("clap") {
            "clap" => Ok(Self::Clap),
            "vst3" => Ok(Self::Vst3),
            other => Err(format!(
                "ORBIT_EFFECT_FORMAT='{other}' is invalid (expected 'clap' or 'vst3')"
            )),
        }
    }

    fn default_child_name(self) -> &'static str {
        match self {
            Self::Clap => "orbit-clap-effect-child",
            Self::Vst3 => "orbit-vst3-effect-child",
        }
    }
}

/// attach する plugin の拡張子から effect child binary を選ぶ（純関数・unit テスト対象）。
///
/// **#552**: 従来 effect の format は `ORBIT_EFFECT_FORMAT` による **process-global** だったため、
/// 1つのチェーンに CLAP と VST3 のエフェクトを混在させられなかった。プラグイン形式は
/// 利用者に見えてはならない実装の詳細であり（`PLUGIN_CAPABILITY_ABSTRACTION_v1.md` CAP.6-1
/// 「上位は能力 ID だけを知り、形式分岐を持たない」）、instrument 側と同じ per-plugin 解決へ揃える。
///
/// - `current_child_exe` の file name がフォーマット別デフォルト名でない場合は
///   **明示指定と見なして触らない**（`ORBIT_EFFECT_CHILD_BIN` override と gated テストの
///   config 直指定を保護する）。
/// - デフォルト名の場合は**同じディレクトリ**でフォーマットに応じた binary に読み替える。
///   `current_exe` からの再導出はしない（テストハーネスでは `current_exe` が
///   `target/debug/deps/` 配下になり sibling 解決が壊れるため）。
/// - 冪等かつ対称: retryable な attach 失敗で `ChildLaunch` が再利用されても毎回この読み替えが
///   走るので、`.vst3` → `.clap` の attach し直しで元の child に戻る。
pub(crate) fn child_exe_for_attach(current_child_exe: &Path, plugin_path: &Path) -> PathBuf {
    // 規則そのものは instrument と共有する（`outproc_child_exe`）。ここが持つのは
    // 「effect の binary 名の対」だけ。デフォルト名は `default_child_name()` から導出する
    // （手打ちリテラルだとリネーム時に判定が false へ倒れ、切替が無音で無効化される）。
    crate::outproc_child_exe::child_exe_for_attach(
        current_child_exe,
        plugin_path,
        PluginFormat::Clap.default_child_name(),
        PluginFormat::Vst3.default_child_name(),
    )
}

/// OOP effect の起動設定。plugin は post-boot attach では不要で、eager start と gated test のみ使う。
/// sample_rate は device 確定後に渡すので含めない。
pub struct OutProcEffectConfig {
    /// plugin format（既定 env は `clap`）。
    pub format: PluginFormat,
    /// effect child binary（format に応じた child）のパス。
    pub child_exe: PathBuf,
    /// eager start で host する plugin bundle のパス。post-boot attach は `LoadPlugin` で受け取る。
    pub plugin: Option<PathBuf>,
    /// plugin id（CLAP は id、VST3 Phase 1 は CLI symmetry のため渡すだけ）。
    pub plugin_id: Option<String>,
    /// cpal に要求する固定バッファフレーム数（gated stale-rate harness が 32/64 を渡す）。`None` は
    /// device 既定（`BufferSize::Default`）。production の env 経路は通常 `None`。
    pub buffer_frames: Option<u32>,
}

impl OutProcEffectConfig {
    /// 環境変数から設定を組む（production `start()` 用）:
    /// - `ORBIT_EFFECT_FORMAT`: `clap` | `vst3`（省略時 `clap`）。**初期値のみ**。
    /// - `ORBIT_EFFECT_CHILD_BIN`: child binary path（省略時は daemon exe と同一ディレクトリの
    ///   format 対応 child）。
    ///
    /// **🔴 #552: `ORBIT_EFFECT_FORMAT` は post-boot attach の child 選択を決めない。**
    /// `LoadPlugin` はあらゆる経路で `select_child_exe` を通り、child exe がデフォルト名なら
    /// **plugin パスの拡張子**で上書きされる（[`child_exe_for_attach`]）。したがってここで
    /// 決まる `child_exe` は「最初の attach までの初期値」であり、実運用では即座に
    /// 置き換わる。プラグイン形式を利用者に見せないための設計（CAP.6-1）。
    ///
    /// 既知の非対称（許容）: 無効値（例 `ORBIT_EFFECT_FORMAT=nonsense`）は起動時エラーで
    /// daemon を落とすが、有効値は実際の child 選択に影響しない。
    ///
    /// **存置の理由**: repo 内に本 env の利用者は無い（`ORBIT_EFFECT_FORMAT` の参照は本
    /// ファイルとドキュメントのみ。gated テストは `OutProcEffectConfig` を直接組み立てており
    /// env を経由しない）。それでも消していないのは、既に外部から渡している運用があった場合に
    /// **無効値の loud な起動失敗**という既存挙動を黙って変えないため。削除するなら
    /// 「env を読まなくなった」ことが分かる形で別 PR にする。
    /// - `ORBIT_EFFECT_PLUGIN`: plugin bundle path（任意。post-boot attach は `LoadPlugin` で渡す）。
    /// - `ORBIT_EFFECT_PLUGIN_ID`: plugin id（任意）。
    pub fn from_env() -> Result<Self, String> {
        let format = PluginFormat::from_env_value(std::env::var("ORBIT_EFFECT_FORMAT").ok())?;
        let child_exe = match std::env::var_os("ORBIT_EFFECT_CHILD_BIN") {
            Some(v) => PathBuf::from(v),
            None => default_rack_child_exe()?,
        };
        let plugin = std::env::var_os("ORBIT_EFFECT_PLUGIN").map(PathBuf::from);
        let plugin_id = std::env::var("ORBIT_EFFECT_PLUGIN_ID").ok();
        // production は通常 device 既定。`ORBIT_EFFECT_BUFFER_FRAMES` で明示できる。**設定済みなのに無効**
        // （非正・parse 不能）な場合は黙って無視せず warn を出す（silent fallback 回避）。未設定は device 既定。
        let buffer_frames = match std::env::var("ORBIT_EFFECT_BUFFER_FRAMES") {
            Ok(s) => match s.parse::<u32>() {
                Ok(n) if n > 0 => Some(n),
                _ => {
                    tracing::warn!(
                        "ORBIT_EFFECT_BUFFER_FRAMES='{s}' は無効（正の整数が必要）— device 既定を使う"
                    );
                    None
                }
            },
            Err(_) => None, // 未設定 = device 既定
        };
        Ok(Self {
            format,
            child_exe,
            plugin,
            plugin_id,
            buffer_frames,
        })
    }
}

/// daemon 実行ファイルと同一ディレクトリの format 対応 child を既定パスとする
/// （spike の sibling-of-exe を踏襲・設計 §4.5）。インストール時は daemon と child が並んで置かれる前提。
fn default_rack_child_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current_exe has no parent directory".to_string())?;
    Ok(dir.join("orbit-effect-rack-child"))
}

/// OOP effect の観測 signal（全 atomic・lock-free）。
///
/// 2 つの writer を持つ:
/// - **audio thread**（[`OutProcEffectPostProcessor`]）= `fresh` / `stale` / `stall` / `frames_clamped`
///   / `callback_count`。`PipelinedEffectHost` の plain counter を毎 callback ミラーする（host は
///   audio thread が排他所有するため、control thread はこの atomic 経由でしか読めない）。
/// - **control thread**（watchdog）= `respawn_count` / `last_respawn_ns` / `measurement_invalid` /
///   `child_process_error_count`（後者は shm の child→host signal を poll でミラー）。
///
/// reader は daemon の accessor / gated harness（slot 数決定の `stale` / RT 健全性）。
#[derive(Default)]
pub struct OutProcEffectStats {
    /// 初回 attach の READY 待ち中。watchdog はこの間の child exit を respawn せず fast-fail へ渡す。
    pub initial_attach_pending: AtomicBool,
    /// child から fresh な出力を読めた callback 数。
    pub fresh: AtomicU64,
    /// child が間に合わず repeat-previous した callback 数（slot 数決定の主指標の一つ）。
    pub stale: AtomicU64,
    /// slot 再利用待ちで submit を見送った callback 数（slot 数決定の主指標）。
    pub stall: AtomicU64,
    /// data.len() が BUF_LEN を超え clamp した callback 数（通常 0）。
    pub frames_clamped: AtomicU64,
    /// adapter が process した callback 数。
    pub callback_count: AtomicU64,
    /// watchdog が child の異常終了を検知して respawn した回数。
    pub respawn_count: AtomicU64,
    /// 直近 respawn のタイムスタンプ（supervisor 起動からの経過 ns・0 = 未 respawn）。
    pub last_respawn_ns: AtomicU64,
    /// watchdog が supervise を諦めた（respawn 失敗 / try_wait 連続失敗 / #573: 起動直後に死に続ける
    /// child の respawn を連続上限で打ち切った）= 計測無効。gated harness が verdict を捨てる。
    pub measurement_invalid: AtomicBool,
    /// shm の `child_process_error_count`（child の per-block 処理失敗累積）を watchdog がミラーした値。
    pub child_process_error_count: AtomicU64,
    /// dry（effect 適用前）の abs ピーク振幅の f32 bits（adapter が毎 callback `fetch_max`）。非負 f32 の
    /// bits は u32 として単調なので fetch_max が正しく機能する（`ClapProcessorStats` と同手法）。
    pub dry_peak_bits: AtomicU32,
    /// post（effect 適用後）の abs ピーク振幅の f32 bits（adapter が毎 callback `fetch_max`）。gated
    /// parity が `post/dry ≈ 0.5`（test-effect の固定 gain）を検証する。
    pub post_peak_bits: AtomicU32,
    /// 現在稼働中の child の PID（start / respawn 時に store）。gated kill-test がこの PID を kill して
    /// daemon の生存 + respawn 復帰を検証する。0 = 未起動。
    pub current_child_pid: AtomicU32,
    /// 初回 attach 中の child exit（**事実と理由の対**）。詳細は
    /// [`crate::outproc_child_exit::ChildEarlyExit`]。
    ///
    /// 🔴 **struct の末尾に置くこと。** 中身に `Mutex` を含むので、RT が毎コールバック触る
    /// atomic 群（`fresh` / `callback_count` 等）と同じキャッシュラインに乗せない。
    pub child_early_exit: crate::outproc_child_exit::ChildEarlyExit,
}

impl OutProcEffectStats {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// dry / post ピークを 0 にリセットする。`fetch_max` で累積するため、kill-test の「kill 前の effected
    /// peak」が「kill 後の復帰 peak」に混ざらないよう位相を分けるのに使う（`ClapProcessorStats::reset_post_peak`
    /// と同じ two-phase 計測の seam）。
    pub fn reset_peaks(&self) {
        self.dry_peak_bits.store(0, Ordering::Relaxed);
        self.post_peak_bits.store(0, Ordering::Relaxed);
    }

    /// 非 RT 側（accessor / gated harness）が読むスナップショット。
    pub fn snapshot(&self) -> OutProcEffectSnapshot {
        OutProcEffectSnapshot {
            fresh: self.fresh.load(Ordering::Relaxed),
            stale: self.stale.load(Ordering::Relaxed),
            stall: self.stall.load(Ordering::Relaxed),
            frames_clamped: self.frames_clamped.load(Ordering::Relaxed),
            callback_count: self.callback_count.load(Ordering::Relaxed),
            respawn_count: self.respawn_count.load(Ordering::Relaxed),
            last_respawn_ns: self.last_respawn_ns.load(Ordering::Relaxed),
            measurement_invalid: self.measurement_invalid.load(Ordering::Relaxed),
            child_process_error_count: self.child_process_error_count.load(Ordering::Relaxed),
            dry_peak: f32::from_bits(self.dry_peak_bits.load(Ordering::Relaxed)),
            post_peak: f32::from_bits(self.post_peak_bits.load(Ordering::Relaxed)),
            current_child_pid: self.current_child_pid.load(Ordering::Relaxed),
        }
    }
}

/// [`OutProcEffectStats`] の読み取り専用スナップショット。
#[derive(Debug, Clone, Copy)]
pub struct OutProcEffectSnapshot {
    pub fresh: u64,
    pub stale: u64,
    pub stall: u64,
    pub frames_clamped: u64,
    pub callback_count: u64,
    pub respawn_count: u64,
    pub last_respawn_ns: u64,
    pub measurement_invalid: bool,
    pub child_process_error_count: u64,
    pub dry_peak: f32,
    pub post_peak: f32,
    pub current_child_pid: u32,
}

/// `PipelinedEffectHost`（候補B 状態機械・clack-free）を `impl PostProcessor` で包む OOP effect adapter。
///
/// cpal closure が所有し audio thread 上で排他的に動く（`ClapPostProcessor` と並列の clack-free 実装）。
/// `process` は RT callback ごとに 1 block を child へ submit し前 block の出力を読む（候補B・+1 block
/// 遅延・child が間に合わなければ repeat-previous）。RT 安全性は `PipelinedEffectHost::process_block`
/// が担保する（alloc/lock/syscall なし）。host の観測 counter を毎 callback `stats` へミラーする
/// （atomic store のみ・RT 安全）。
pub struct OutProcEffectPostProcessor {
    host: PipelinedEffectHost,
    /// PR-431: child が未 attach（post-boot attach 待ち）の間は音を素通しする安全弁。
    /// **本 PR では常に true で構築される**（既存起動経路は eager attach のまま無変更）。
    /// PR-1b で post-boot attach 実装時に false スタートさせる想定（詳細は Issue #431 参照）。
    engaged: Arc<AtomicBool>,
    /// teardown 要求（daemon supervisor → audio thread）。立つと transport への submit を止め、`data` を
    /// dry のまま素通しする。control 側が child へ QUIT を送って reap・shm unlink する前に audio thread が
    /// transport を触らなくなる（in-process clap の handshake を踏襲・設計 §4.5）。
    teardown_requested: Arc<AtomicBool>,
    /// teardown 完了（audio thread → daemon supervisor）。`process` が quiesce に入ったら立てる。
    teardown_done: Arc<AtomicBool>,
    /// 観測 counter のミラー先（control thread が読む）。
    stats: Arc<OutProcEffectStats>,
}

/// OOP effect RT adapter の配線部材。atomic handle はすべて名前付き field で受け取り、
/// `engaged` / quiesce request / quiesce ack の位置引数取り違えを表現不能にする。
pub struct OutProcEffectPostProcessorParts {
    pub host: PipelinedEffectHost,
    pub engaged: Arc<AtomicBool>,
    pub teardown_requested: Arc<AtomicBool>,
    pub teardown_done: Arc<AtomicBool>,
    pub stats: Arc<OutProcEffectStats>,
}

impl OutProcEffectPostProcessor {
    pub fn new(parts: OutProcEffectPostProcessorParts) -> Self {
        Self {
            host: parts.host,
            engaged: parts.engaged,
            teardown_requested: parts.teardown_requested,
            teardown_done: parts.teardown_done,
            stats: parts.stats,
        }
    }
}

impl PostProcessor for OutProcEffectPostProcessor {
    /// `data` は engine が render 済みの interleaved f32（hardware sum）。OOP effect で in-place 変換する。
    ///
    /// teardown 要求が来たら transport を触らず `data` を dry のまま素通しし、`teardown_done` を立てる
    /// （冪等）。それ以外は `PipelinedEffectHost::process_block` に委譲し、host の観測 counter を
    /// `stats` へミラーする。
    fn process(&mut self, data: &mut [f32]) {
        if self.teardown_requested.load(Ordering::Acquire) {
            // quiesce: 以降 transport（shm）を触らない。data は engine の dry 出力のまま流れる。
            self.teardown_done.store(true, Ordering::Release);
            return;
        }
        if !self.engaged.load(Ordering::Acquire) {
            return;
        }
        // dry（effect 適用前）の abs ピークを記録（gated parity の baseline）。
        self.stats
            .dry_peak_bits
            .fetch_max(peak_bits(data), Ordering::Relaxed);

        self.host.process_block(data);

        // post（effect 適用後）の abs ピークを記録（gated parity: post/dry ≈ test-effect gain）。
        self.stats
            .post_peak_bits
            .fetch_max(peak_bits(data), Ordering::Relaxed);
        // host の plain counter を control thread が読めるよう atomic ミラー（RT 安全: store のみ）。
        self.stats.fresh.store(self.host.fresh, Ordering::Relaxed);
        self.stats.stale.store(self.host.stale, Ordering::Relaxed);
        self.stats.stall.store(self.host.stall, Ordering::Relaxed);
        self.stats
            .frames_clamped
            .store(self.host.frames_clamped, Ordering::Relaxed);
        self.stats.callback_count.fetch_add(1, Ordering::Relaxed);
    }
}

/// interleaved f32 の abs ピークを f32 bits で返す（非負 f32 bits は u32 として単調 = `fetch_max` 可）。
/// `ClapPostProcessor` の post-peak と同趣旨だが、`abs()`（f32 往復）でなく符号ビットを直接マスクする
/// （`s.to_bits() & 0x7FFF_FFFF`・非負化として等価で vectorize しやすい）。空 slice は 0。
#[inline]
fn peak_bits(data: &[f32]) -> u32 {
    data.iter()
        .map(|s| s.to_bits() & 0x7FFF_FFFF)
        .max()
        .unwrap_or(0)
}

/// `--shm`/`--chain`/`--sample-rate` を渡して rack effect child を 1 つ起動する。
/// `start_outproc_effect` の初回 spawn と watchdog の respawn が共有する。
///
/// パスは `OsStr` のまま渡す（lossy 変換しない）。`stderr` は **継承**して child の eprintln（plugin
/// process 失敗の集計報告等）を daemon stderr に出す（carry-forward ①③: child の可観測性）。
pub fn spawn_effect_child(
    child_exe: &Path,
    shm_path: &Path,
    chain_manifest: &Path,
    sample_rate: u32,
) -> io::Result<Child> {
    let mut cmd = Command::new(child_exe);
    cmd.arg("--shm")
        .arg(shm_path)
        .arg("--chain")
        .arg(chain_manifest)
        .arg("--sample-rate")
        .arg(sample_rate.to_string())
        .stderr(Stdio::inherit());
    cmd.spawn()
}

/// QUIT 済み（または crash した）child を bounded に reap する。timeout 超過で kill にフォールバック。
/// `SandboxChildGuard` の reap と同じ意味論（非 RT・spin でなく yield）。
fn reap(child: &mut Child, child_name: &str) {
    let deadline = Instant::now() + REAP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::yield_now(),
            Ok(None) => {
                tracing::warn!(
                    "{child_name} が {REAP_TIMEOUT:?} 以内に終了せず kill にフォールバック"
                );
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            Err(e) => {
                tracing::error!("effect child try_wait 失敗（kill にフォールバック）: {e}");
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}

/// child spawn / watchdog / respawn を所有する supervisor（`StreamGuard` の最後の field = `_child_guard`）。
///
/// watchdog thread が `Child` を所有して `try_wait` で生存を poll し、異常終了を検知したら同一 shm を指す
/// 新 child を spawn する（child は「latest 処理」なので respawn 後は最新 `seq_request` から再開する）。
/// teardown 時は **先に** watchdog を止めてから（drop で `shutdown` を立てる）、watchdog 自身が child へ
/// QUIT を送って reap する（watchdog が respawn 中の child を teardown と競合させない）。
pub struct EffectChildSupervisor {
    shutdown: Arc<AtomicBool>,
    watchdog: Option<JoinHandle<()>>,
    shm_path: PathBuf,
    unlink_shm: bool,
}

impl EffectChildSupervisor {
    /// `first_child` = `start_outproc_effect` が同期 spawn 済みの初回 child（spawn 失敗を呼び出し側に
    /// 返すため supervisor 外で起動する）。watchdog はこれを引き継ぎ、以降の crash で respawn する。
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        first_child: Child,
        shm_path: PathBuf,
        stats: Arc<OutProcEffectStats>,
        child_exe: PathBuf,
        plugin: PathBuf,
        plugin_id: Option<String>,
        sample_rate: u32,
    ) -> io::Result<Self> {
        let mailbox = Arc::new(CommandMailboxHost::new(shm_path.clone()));
        let ui_pump = Arc::new(UiEventPump::new(shm_path.clone()));
        let ui_target = Arc::new(Mutex::new(None));
        let (ui_events, _) = tokio::sync::broadcast::channel(16);
        let chain = Arc::new(Mutex::new(vec![ChainStageConfig::Catalog {
            path: plugin,
            plugin_id,
            latest_state: None,
            enabled: true,
        }]));
        Self::spawn_chain_with_mailbox(
            first_child,
            shm_path,
            stats,
            child_exe,
            sample_rate,
            chain,
            mailbox,
            PluginUiWiring {
                pump: ui_pump,
                target: ui_target,
                events: ui_events,
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn spawn_with_mailbox(
        first_child: Child,
        shm_path: PathBuf,
        stats: Arc<OutProcEffectStats>,
        child_exe: PathBuf,
        plugin: PathBuf,
        plugin_id: Option<String>,
        sample_rate: u32,
        latest_state: Arc<Mutex<Option<PathBuf>>>,
        mailbox: Arc<CommandMailboxHost>,
        ui: PluginUiWiring,
    ) -> io::Result<Self> {
        let state = latest_state
            .lock()
            .map_err(|_| io::Error::other("effect latest-state mutex poisoned"))?
            .clone();
        Self::spawn_chain_with_mailbox(
            first_child,
            shm_path,
            stats,
            child_exe,
            sample_rate,
            Arc::new(Mutex::new(vec![ChainStageConfig::Catalog {
                path: plugin,
                plugin_id,
                latest_state: state,
                enabled: true,
            }])),
            mailbox,
            ui,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn spawn_chain_with_mailbox(
        mut first_child: Child,
        shm_path: PathBuf,
        stats: Arc<OutProcEffectStats>,
        child_exe: PathBuf,
        sample_rate: u32,
        chain: Arc<Mutex<ChainConfig>>,
        mailbox: Arc<CommandMailboxHost>,
        ui: PluginUiWiring,
    ) -> io::Result<Self> {
        let PluginUiWiring {
            pump: ui_pump,
            target: ui_target,
            events: ui_events,
        } = ui;
        // watchdog 専用の control mapping（host は from_mmap で 1st mapping を消費するので 2nd を開く）。
        // この MmapMut は closure に move され watchdog thread 終了まで生存する（region ポインタの前提）。
        // open_shared 失敗時は first_child を orphan 化させず reap し、作成済み shm を unlink する。
        let ctl_mmap = match open_shared(&shm_path) {
            Ok(m) => m,
            Err(e) => {
                let _ = first_child.kill();
                let _ = first_child.wait();
                let _ = std::fs::remove_file(&shm_path);
                return Err(e);
            }
        };
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_thread = shutdown.clone();
        let base = Instant::now();
        // respawn 用に closure へ move する shm_path（struct 側は unlink 用に原本を保持する）。
        let shm_path_wd = shm_path.clone();
        // #552: VST3 / CLAP どちらの child かをログに出すため実際の名前を持ち込む
        // （決め打ちだと VST3 child のクラッシュが CLAP child の障害に見える）。
        let child_name_wd = crate::outproc_child_exe::exe_label(&child_exe, "orbit-effect-child");
        // first_child は **closure に直接 move しない**: thread spawn が失敗すると closure ごと drop され
        // first_child が orphan 化して shm を spin し続ける（`Child::drop` は kill しない）。thread spawn
        // 成功を確認してから channel で渡し、spawn 失敗時は first_child を本 scope に残して reap できるようにする。
        let (child_tx, child_rx) = std::sync::mpsc::channel::<Child>();

        let watchdog = match std::thread::Builder::new()
            .name("orbit-outproc-effect-watchdog".into())
            .spawn(move || {
                // region は thread 内で導出（生ポインタを thread 境界で渡さない）。ctl_mmap が生かす。
                let region = region_ptr(&ctl_mmap);
                // first_child を channel で受け取る（送信側が無い = spawn 直後の異常時のみ → 即終了）。
                let mut child = match child_rx.recv() {
                    Ok(c) => c,
                    Err(_) => return,
                };
                // try_wait の連続失敗回数（Ok で reset）。閾値超過で supervise 不能とみなし escalate する。
                let mut try_wait_errors: u32 = 0;
                // #573: 連続 fast-fail（`FAST_RESPAWN_THRESHOLD` 未満で死んだ respawn）の回数。
                // `FAST_RESPAWN_THRESHOLD` 以上生きた respawn（正常な単発クラッシュからの復帰）でリセット。
                let mut consecutive_fast_fails: u32 = 0;
                loop {
                    if shutdown_thread.load(Ordering::Acquire) {
                        break;
                    }
                    // child→host health（shm）を control thread が読めるようミラー。
                    // SAFETY: region は move 済み ctl_mmap（生存）を指す。Relaxed で十分（観測用）。
                    let errs =
                        unsafe { (*region).child_process_error_count.load(Ordering::Relaxed) };
                    stats
                        .child_process_error_count
                        .store(errs, Ordering::Relaxed);

                    match child.try_wait() {
                        // teardown と crash の race: shutdown 中の終了は正常 teardown なので respawn しない
                        // （guard で先に弾く・advisor）。
                        //
                        // 弱順序 HW（ARM 等）の注記（@claude bot review）: supervisor の `shutdown` store(Release)
                        // が、ループ先頭(line ~411)の load と本 guard の load の **両方**にまだ伝播していない瞬間に
                        // child crash を検知すると、下の `Ok(Some(status))` 側へ進んで **1 回だけ spurious respawn**
                        // しうる。だがその直後の次 iteration 先頭の load が `shutdown=true` を観測して break し、
                        // 終了経路が QUIT/reap で当該 spurious child も確実に始末するため **次 iteration で安全に
                        // 収束**する（orphan にならない）。x86-64 では事実上発生しない。意図的に許容するトレードオフ。
                        Ok(Some(_)) if shutdown_thread.load(Ordering::Acquire) => break,
                        Ok(Some(status)) => {
                            try_wait_errors = 0;
                            let active_stage_index =
                                unsafe { (*region).active_stage_index.load(Ordering::Relaxed) };
                            // READY の publish は host が initial_attach_pending をクリアする処理と競合する:
                            // child は READY を publish した直後にその窓で crash しうる。これを attach 初期の
                            // 早期 exit として扱うと本 watchdog が停止してしまう一方、host は READY を観測して
                            // 死んだ Active slot を install しうる。pre-READY の exit のみ fast-fail とし、
                            // post-READY の exit は通常の respawn 経路を使わなければならない。
                            if stats.initial_attach_pending.load(Ordering::Acquire)
                                && unsafe {
                                    (*region).child_status.load(Ordering::Acquire)
                                        != orbit_audio_sandbox::transport::CHILD_STATUS_READY
                                }
                            {
                                tracing::warn!(
                                    "{child_name_wd} exited during initial attach ({status}, active stage {active_stage_index})"
                                );
                                stats.child_early_exit.record(status);
                                break;
                            }
                            // #573: 起動直後に死に続ける child を tight loop で respawn し続けない。
                            // `last_respawn_ns`（初期値 0 = supervisor 起動時刻 `base`）からの経過時間で
                            // 直前 spawn の生存時間を測る。
                            let elapsed_since_spawn = base.elapsed().saturating_sub(
                                Duration::from_nanos(stats.last_respawn_ns.load(Ordering::Relaxed)),
                            );
                            consecutive_fast_fails = advance_fast_respawn_streak(
                                consecutive_fast_fails,
                                elapsed_since_spawn,
                                FAST_RESPAWN_THRESHOLD,
                            );
                            if consecutive_fast_fails >= MAX_CONSECUTIVE_FAST_RESPAWNS {
                                tracing::error!(
                                    "{child_name_wd} が {consecutive_fast_fails} 回連続で \
                                     {FAST_RESPAWN_THRESHOLD:?} 未満の生存時間で終了（直近の終了 \
                                     ステータス: {status}）→ respawn loop を打ち切る（計測無効）"
                                );
                                stats.measurement_invalid.store(true, Ordering::Release);
                                break;
                            }
                            tracing::warn!(
                                "{child_name_wd} が異常終了（{status}, active stage {active_stage_index}）→ respawn する"
                            );
                            // `try_wait=Some` で旧 child の死亡を確認済み。in-flight command を
                            // failure ack で完了し、readiness/mailbox を reset してから replacement を
                            // spawn する（生きた child への reset は禁止・UIH.2）。
                            if !service_ui_pump_on_respawn(
                                "effect",
                                &ui_pump,
                                &mailbox,
                                &ui_target,
                                &ui_events,
                            ) {
                                stats.measurement_invalid.store(true, Ordering::Release);
                                break;
                            }
                            let desired_chain = match chain.lock() {
                                Ok(chain) => chain.clone(),
                                Err(_) => {
                                    tracing::error!(
                                        "effect chain config mutex poisoned; measurement invalid"
                                    );
                                    stats.measurement_invalid.store(true, Ordering::Release);
                                    break;
                                }
                            };
                            let manifest = match write_chain_manifest(&shm_path_wd, &desired_chain) {
                                Ok(path) => path,
                                Err(error) => {
                                    tracing::error!(
                                        "effect child respawn manifest write failed (measurement invalid): {error}"
                                    );
                                    stats.measurement_invalid.store(true, Ordering::Release);
                                    break;
                                }
                            };
                            match spawn_effect_child(
                                &child_exe,
                                &shm_path_wd,
                                &manifest,
                                sample_rate,
                            ) {
                                Ok(c) => {
                                    // PID を先に publish（kill-test が新 child を kill できるよう）。
                                    stats.current_child_pid.store(c.id(), Ordering::Relaxed);
                                    child = c;
                                    stats.respawn_count.fetch_add(1, Ordering::Relaxed);
                                    stats
                                        .last_respawn_ns
                                        .store(base.elapsed().as_nanos() as u64, Ordering::Relaxed);
                                }
                                Err(e) => {
                                    tracing::error!(
                                        "effect child respawn 失敗（計測無効・以降 stale = 直前 good block の \
                                         repeat-previous が出続ける）: {e}"
                                    );
                                    stats.measurement_invalid.store(true, Ordering::Release);
                                    break;
                                }
                            }
                        }
                        Ok(None) => {
                            try_wait_errors = 0;
                            poll_ui_pump_once("effect", &ui_pump, &ui_target, &ui_events);
                            std::thread::sleep(WATCHDOG_POLL);
                        }
                        Err(e) => {
                            // try_wait が連続失敗 = child handle が壊れて supervise 不能。log を flood せず
                            // 閾値で escalate（計測無効 + 終了）。次の child crash を検知できないため打ち切る。
                            try_wait_errors += 1;
                            if try_wait_errors >= TRY_WAIT_ERROR_LIMIT {
                                tracing::error!(
                                    "effect child try_wait が {try_wait_errors} 回連続失敗（計測無効・supervise 終了）: {e}"
                                );
                                stats.measurement_invalid.store(true, Ordering::Release);
                                break;
                            }
                            std::thread::sleep(WATCHDOG_POLL);
                        }
                    }
                }
                drain_ui_pump("effect", &ui_pump, &ui_target, &ui_events);
                // teardown: shutdown 済み（respawn しない）。現 child へ QUIT を送り reap する。
                // SAFETY: region は生存 ctl_mmap を指す。QUIT は一回限りの flag（Release で publish）。
                unsafe {
                    (*region).control.store(CONTROL_QUIT, Ordering::Release);
                }
                reap(&mut child, &child_name_wd);
                // ここで ctl_mmap が drop（thread 終了）。shm unlink は supervisor drop が join 後に行う。
            }) {
            Ok(handle) => handle,
            Err(e) => {
                // thread spawn 失敗: closure（ctl_mmap 等）は未実行で drop 済み。first_child は本 scope に
                // 残るので orphan 化させず reap し、shm を unlink する。
                let _ = first_child.kill();
                let _ = first_child.wait();
                let _ = std::fs::remove_file(&shm_path);
                return Err(e);
            }
        };

        // thread spawn 成功 → first_child を watchdog へ渡す（recv 側が待っている）。送信失敗は watchdog が
        // recv 前に消えた場合のみで実質到達不能（thread の最初の動作が recv・その前に消えるのは region_ptr が
        // panic する等＝起きない）。万一起きたら orphan を reap・shm を unlink し、**supervise 不能を false-Ok
        // にせず Err で伝える**（dead watchdog を抱えた Self を返さない）。
        if let Err(std::sync::mpsc::SendError(mut orphan)) = child_tx.send(first_child) {
            let _ = orphan.kill();
            let _ = orphan.wait();
            let _ = std::fs::remove_file(&shm_path);
            return Err(io::Error::other(
                "outproc effect watchdog thread exited before receiving the first child",
            ));
        }

        Ok(Self {
            shutdown,
            watchdog: Some(watchdog),
            shm_path,
            unlink_shm: true,
        })
    }

    /// shm の unlink 所有権を `ChildLaunch` に残したまま supervisor を teardown する（retry 用）。
    /// 本体は `unlink_shm` を倒すだけで、stop/reap は値渡しで consume した self の即時 Drop が行う。
    pub fn detach_keep_shm(mut self) {
        self.unlink_shm = false;
    }
}

impl Drop for EffectChildSupervisor {
    fn drop(&mut self) {
        // 1. watchdog を止める（respawn 停止）。QUIT/reap より **先**（advisor）: 立てないと teardown 中の
        //    child を watchdog が respawn してしまう。
        self.shutdown.store(true, Ordering::Release);
        // 2. watchdog を join。watchdog が QUIT 送出 + reap を済ませて終了し、ctl_mmap を drop する。
        if let Some(h) = self.watchdog.take() {
            if h.join().is_err() {
                tracing::error!("orbit-outproc-effect-watchdog thread panicked during shutdown");
            }
        }
        // 3. shm unlink（この時点で host mmap は stream drop で、ctl mmap は watchdog 終了で消えており
        //    どのプロセスもこの shm を map していない）。
        if self.unlink_shm {
            if let Err(e) = std::fs::remove_file(&self.shm_path) {
                // 既に消えている等は無害（warn のみ・teardown は続行）。
                tracing::warn!("OOP effect shm 削除失敗 {:?}: {e}", self.shm_path);
            }
        }
        for sidecar in [
            chain_manifest_path(&self.shm_path),
            apply_plan_path(&self.shm_path),
        ] {
            if let Err(error) = std::fs::remove_file(&sidecar) {
                if error.kind() != io::ErrorKind::NotFound {
                    tracing::warn!(?sidecar, %error, "OOP effect rack manifest cleanup failed");
                }
            }
        }
    }
}

/// teardown guard（`StreamGuard` の最初の field = `_outproc_teardown`）。stream 停止 **前** に drop され、
/// `requested` を立てて `done`（audio thread が adapter で立てる）を timeout 付きで待つ。in-process clap の
/// `ClapTeardownGuard` と同じ意味論（設計 §4.5）。
pub struct OutProcTeardownGuard {
    requested: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    shutdown: Arc<AtomicBool>,
}

/// Stream teardown handshake の3端点。名前付き field により request / ack / shutdown latch の
/// 取り違えをコンストラクタ呼び出しで表現不能にする。
pub struct OutProcTeardownParts {
    pub requested: Arc<AtomicBool>,
    pub done: Arc<AtomicBool>,
    pub shutdown: Arc<AtomicBool>,
}

impl OutProcTeardownGuard {
    pub fn new(parts: OutProcTeardownParts) -> Self {
        Self {
            requested: parts.requested,
            done: parts.done,
            shutdown: parts.shutdown,
        }
    }
}

impl OutProcTeardownGuard {
    /// Latches `shutdown`, then publishes the quiesce request.
    ///
    /// **The order is load-bearing and is the whole reason the latch exists** (#625): if
    /// `requested` were published first, a concurrent effect replacement could enter
    /// `clear_quiesce_unless_shutdown`, observe `shutdown == false`, clear `requested`, and
    /// re-check `shutdown` while it is still false — so it would not restore the request.
    /// The stream owner would then wait for a `done` nobody will ever set, and stop the
    /// stream without a real quiesce ack.
    ///
    /// `between` runs after the latch **and after the stale-`done` cleanup**, immediately
    /// before the request is published, so a test can observe the intermediate state and pin
    /// **both** orders (a comment alone does not enforce them): the latch must already be
    /// visible, the request must not be, and `done` must already be cleared.
    fn latch_then_request(&self, between: impl FnOnce()) {
        // 🔴 `SeqCst` on both stores is load-bearing (#625 audit B-1). This is one half of a
        // store-buffering (Dekker) pair with `clear_quiesce_unless_shutdown`, which stores
        // `quiesce_requested = false` and then loads `shutdown`. Under `Release`/`Acquire`
        // alone that load may read a stale `false` even after the store below, so the
        // replacement would clear this request and never restore it — the stream owner would
        // then wait for an ack nobody sets. A single total order over the four accesses
        // (two here, two there) removes that interleaving. Both sides must agree; relaxing
        // either one re-opens the window. The `SeqCst` stores occur only in these two
        // control-thread code paths; the audio thread reads `requested` with `Acquire` on every
        // callback but performs no `SeqCst` operation. `shutdown` itself is control-thread-only.
        self.shutdown.store(true, Ordering::SeqCst);
        // 🔴 `done` を掃除してから要求を publish する（#625 最終監査 A-1）。
        //
        // 差し替え側の clear（`clear_quiesce_unless_shutdown`）は requested → done の順で
        // false を書くが、その瞬間に RT が「requested=true を load 済み・done=true を store
        // 直前」だと、control の done=false の**後**に RT の done=true が着地する。以後
        // requested=false なので RT は done に触らず、**`requested=false / done=true` が
        // 恒久残留**する。
        //
        // ここで done を掃除しないと、その stale な true を次の poll が**即座に偽 ack として
        // 掴み**、RT が実際に quiesce していないままストリーム停止へ進む。差し替え側の
        // teardown は開始時に同じ掃除をしている（`teardown_outproc_effect_slot`）— **借りた
        // 機構の不変条件を、こちら側だけ継承し損ねていた**。
        //
        // この残留状態は #625 が「共有フラグの clear と再武装」を導入して初めて成立する
        // （それ以前は誰も requested/done を clear しなかった）。
        self.done.store(false, Ordering::Release);
        between();
        self.requested.store(true, Ordering::SeqCst);
    }
}

impl Drop for OutProcTeardownGuard {
    fn drop(&mut self) {
        self.latch_then_request(|| {});
        let deadline = Instant::now() + TEARDOWN_TIMEOUT;
        while !self.done.load(Ordering::Acquire) {
            if Instant::now() >= deadline {
                tracing::warn!(
                    "OOP effect teardown: audio thread quiesce ack timed out ({}ms); proceeding to stop stream",
                    TEARDOWN_TIMEOUT.as_millis()
                );
                break;
            }
            // 非 RT（stream drop 経路）。poll-sleep は ClapTeardownGuard と同じ意図（#342-#3 verdict 参照）。
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static EFFECT_PLUGIN_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn from_env_allows_plugin_to_be_unset_for_post_boot_attach() {
        let _guard = EFFECT_PLUGIN_ENV_LOCK.lock().expect("effect env mutex");
        let previous = std::env::var_os("ORBIT_EFFECT_PLUGIN");
        std::env::remove_var("ORBIT_EFFECT_PLUGIN");

        let config = OutProcEffectConfig::from_env().expect("plugin path is optional at boot");

        if let Some(value) = previous {
            std::env::set_var("ORBIT_EFFECT_PLUGIN", value);
        }
        assert_eq!(config.plugin, None);
    }

    /// 実 mmap（zero-init・unlink 後もマッピングは有効）を所有する production 構築子経由の host を作る。
    /// unsafe を使わず（`from_mmap`）テスト用に zeroed SharedRegion を得る。
    fn temp_host() -> PipelinedEffectHost {
        let p = unique_shm_path();
        let _ = std::fs::remove_file(&p);
        let mmap = orbit_audio_sandbox::create_shared(&p).expect("create_shared");
        // unlink しても mapping は生存する（Unix）。テスト終了時の掃除を兼ねる。
        let _ = std::fs::remove_file(&p);
        PipelinedEffectHost::from_mmap(mmap)
    }

    fn flags() -> (Arc<AtomicBool>, Arc<AtomicBool>) {
        (
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        )
    }

    fn engaged(value: bool) -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(value))
    }

    // 通常経路: adapter は host.process_block に委譲し counter を stats へミラーする。child が未処理
    // （mmap zero-init）なので初回は prime silence（host が data を無音化）= 委譲が起きた証拠。
    #[test]
    fn delegates_to_host_first_block_primes_silence_and_mirrors_stats() {
        let (tr, td) = flags();
        let stats = OutProcEffectStats::new();
        let mut pp = OutProcEffectPostProcessor::new(OutProcEffectPostProcessorParts {
            host: temp_host(),
            engaged: engaged(true),
            teardown_requested: tr,
            teardown_done: td.clone(),
            stats: stats.clone(),
        });
        let mut data = vec![0.7f32; 64 * 2];
        pp.process(&mut data);
        assert!(
            data.iter().all(|&x| x == 0.0),
            "初回は host が prime silence（adapter が host.process_block へ委譲した証拠）"
        );
        assert!(
            !td.load(Ordering::Acquire),
            "teardown 未要求なので done は立たない"
        );
        let s = stats.snapshot();
        assert_eq!(s.callback_count, 1, "callback_count をミラー");
        assert_eq!(s.fresh, 0, "初回は fresh 0（prime）");
    }

    // teardown handshake: teardown_requested が立つと transport を触らず data を dry 素通しし、
    // teardown_done を立てる。host.process_block は呼ばれない（data が無音化されず callback も数えない）。
    #[test]
    fn teardown_passes_dry_and_acks() {
        let (tr, td) = flags();
        let stats = OutProcEffectStats::new();
        let mut pp = OutProcEffectPostProcessor::new(OutProcEffectPostProcessorParts {
            host: temp_host(),
            engaged: engaged(true),
            teardown_requested: tr.clone(),
            teardown_done: td.clone(),
            stats: stats.clone(),
        });
        tr.store(true, Ordering::Release);

        let mut data = vec![0.7f32; 64 * 2];
        pp.process(&mut data);
        assert!(
            data.iter().all(|&x| (x - 0.7).abs() < 1e-9),
            "teardown 中は data を dry のまま素通し（host へ委譲せず無音化しない）"
        );
        assert!(
            td.load(Ordering::Acquire),
            "teardown_done を立てて quiesce 完了を通知"
        );
        assert_eq!(
            stats.snapshot().callback_count,
            0,
            "teardown 中は callback を数えない"
        );

        // 冪等: 再度呼んでも dry 素通し + done のまま。
        let mut data2 = vec![-0.3f32; 32 * 2];
        pp.process(&mut data2);
        assert!(
            data2.iter().all(|&x| (x + 0.3).abs() < 1e-9),
            "冪等に dry 素通し"
        );
        assert!(td.load(Ordering::Acquire));
    }

    #[test]
    fn disengaged_passes_dry_without_updating_stats() {
        let (tr, td) = flags();
        let stats = OutProcEffectStats::new();
        let mut pp = OutProcEffectPostProcessor::new(OutProcEffectPostProcessorParts {
            host: temp_host(),
            engaged: engaged(false),
            teardown_requested: tr,
            teardown_done: td,
            stats: stats.clone(),
        });

        let mut data = vec![0.7f32; 64 * 2];
        pp.process(&mut data);

        assert!(data.iter().all(|&sample| sample == 0.7));
        assert_eq!(stats.snapshot().callback_count, 0);
    }

    // OutProcEffectStats のスナップショットは全フィールドを反映する（observability の回帰ガード）。
    #[test]
    fn stats_snapshot_reflects_all_fields() {
        let stats = OutProcEffectStats::new();
        stats.fresh.store(10, Ordering::Relaxed);
        stats.stale.store(2, Ordering::Relaxed);
        stats.stall.store(1, Ordering::Relaxed);
        stats.respawn_count.store(3, Ordering::Relaxed);
        stats.measurement_invalid.store(true, Ordering::Relaxed);
        stats.child_process_error_count.store(7, Ordering::Relaxed);
        let s = stats.snapshot();
        assert_eq!(s.fresh, 10);
        assert_eq!(s.stale, 2);
        assert_eq!(s.stall, 1);
        assert_eq!(s.respawn_count, 3);
        assert!(s.measurement_invalid);
        assert_eq!(s.child_process_error_count, 7);
    }

    // teardown guard: done が事前 set なら即抜け（happy path で deadlock しない）+ requested を必ず立てる。
    #[test]
    fn teardown_guard_exits_promptly_when_the_rt_acks() {
        // 🔴 #625 最終監査 A-1 でこのテストの主張を変えた。
        //
        // 旧版は「`done` を**事前に立てて**おけば guard が即抜けする」ことを固定していたが、
        // それはまさに**偽 ack** の挙動である。guard drop 時点で `requested` は false なので、
        // その時点の `done=true` は定義上 stale（直前の差し替えの clear と RT の store が
        // 交錯して残った残骸）でしかない。それを ack として受け入れると、**RT が実際に
        // quiesce していないままストリーム停止へ進む**。
        //
        // 守るべき本当の契約は「**RT が実際に ack すれば速やかに抜ける**」こと。ここでは
        // RT 役のスレッドが `requested` を観測してから `done` を立てる、という実際の順序で
        // それを実証する。
        let (tr, td) = flags();
        let shutdown = Arc::new(AtomicBool::new(false));
        let rt_requested = tr.clone();
        let rt_done = td.clone();
        let rt = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if rt_requested.load(Ordering::Acquire) {
                    rt_done.store(true, Ordering::Release);
                    return;
                }
                std::thread::yield_now();
            }
        });
        let t0 = Instant::now();
        drop(OutProcTeardownGuard::new(OutProcTeardownParts {
            requested: tr.clone(),
            done: td,
            shutdown: shutdown.clone(),
        }));
        let elapsed = t0.elapsed();
        rt.join().expect("rt thread");
        assert!(
            tr.load(Ordering::Acquire),
            "teardown_requested を必ず立てる"
        );
        assert!(
            shutdown.load(Ordering::Acquire),
            "stream shutdown latch を必ず立てる"
        );
        assert!(
            elapsed < TEARDOWN_TIMEOUT,
            "RT が ack したら timeout を待たずに抜ける（elapsed={elapsed:?}）"
        );
    }

    /// #625 最終監査 A-1: guard は要求を publish する前に **stale な `done` を掃除**しなければ
    /// ならない。掃除しないと、直前の差し替えが残した `requested=false / done=true` を次の
    /// poll が偽 ack として掴み、RT が quiesce していないままストリーム停止へ進む。
    #[test]
    fn teardown_guard_clears_a_stale_done_before_requesting_quiesce() {
        let (requested, done) = flags();
        let shutdown = Arc::new(AtomicBool::new(false));
        // 直前の差し替えが残した残留状態を再現する。
        done.store(true, Ordering::Release);
        let guard = OutProcTeardownGuard::new(OutProcTeardownParts {
            requested: requested.clone(),
            done: done.clone(),
            shutdown,
        });
        // 🔴 掃除の**順序**まで固定する（main の変異検証 M7・2026-08-27）。掃除を要求の
        // publish より **後**へ動かしても、`latch_then_request` の戻り値だけを見るテストは
        // 通ってしまった。その順序では RT が返した**本物の ack を control が消す**ため、
        // 実際には quiesce できているのに timeout として差し替えが失敗する。
        // フックは要求 publish の直前で走るので、ここで見えている `done` が契約そのもの。
        let mut done_at_publish = true;
        guard.latch_then_request(|| {
            done_at_publish = done.load(Ordering::Acquire);
        });
        assert!(
            !done_at_publish,
            "a stale done must already be cleared at the moment the quiesce request is published"
        );
        assert!(
            requested.load(Ordering::Acquire),
            "the quiesce request is still published after the cleanup"
        );
        // guard was driven manually; skip its Drop wait (done was never acked).
        std::mem::forget(guard);
    }

    /// #625: the latch must be published **before** the quiesce request.
    ///
    /// A concurrent effect replacement reads `shutdown` to decide whether it may clear
    /// `requested`. If the guard published `requested` first, the replacement would observe
    /// `shutdown == false`, clear the request, re-check `shutdown` while it is still false,
    /// and therefore not restore it — leaving the stream owner waiting for a `done` nobody
    /// sets. The ordering was documented in a comment; this test is what actually enforces it.
    #[test]
    fn teardown_guard_latches_shutdown_before_requesting_quiesce() {
        let (requested, done) = flags();
        let shutdown = Arc::new(AtomicBool::new(false));
        let guard = OutProcTeardownGuard::new(OutProcTeardownParts {
            requested: requested.clone(),
            done,
            shutdown: shutdown.clone(),
        });
        let mut observed_shutdown = false;
        let mut observed_requested = true;
        guard.latch_then_request(|| {
            observed_shutdown = shutdown.load(Ordering::Acquire);
            observed_requested = requested.load(Ordering::Acquire);
        });
        assert!(
            observed_shutdown,
            "shutdown latch must already be visible when the quiesce request is published"
        );
        assert!(
            !observed_requested,
            "the quiesce request must not be published before the shutdown latch"
        );
        assert!(
            requested.load(Ordering::Acquire),
            "request is published after the latch"
        );
        // The guard was driven manually; skip its Drop wait (done was never acked).
        std::mem::forget(guard);
    }

    // teardown guard 安全弁: done が永遠に立たなくても deadlock せず TEARDOWN_TIMEOUT 付近で抜ける。
    #[test]
    fn teardown_guard_times_out_without_deadlock() {
        let (tr, td) = flags();
        let shutdown = Arc::new(AtomicBool::new(false));
        let t0 = Instant::now();
        drop(OutProcTeardownGuard::new(OutProcTeardownParts {
            requested: tr.clone(),
            done: td,
            shutdown,
        }));
        let elapsed = t0.elapsed();
        assert!(
            tr.load(Ordering::Acquire),
            "teardown_requested を必ず立てる"
        );
        assert!(
            elapsed >= Duration::from_millis(400),
            "deadline まで待つ（実測 {}ms）",
            elapsed.as_millis()
        );
        assert!(
            elapsed < Duration::from_millis(1500),
            "deadlock せず timeout で抜ける（実測 {}ms）",
            elapsed.as_millis()
        );
    }

    /// `cond` が真になるまで（または timeout まで）20ms 間隔で poll する（supervisor の非同期挙動待ち）。
    fn poll_until(timeout_secs: u64, mut cond: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        cond()
    }

    /// supervisor の 2nd `open_shared` 用に共有メモリ **ファイル**を作成して path を返す。mapping は即 drop
    /// するがファイルはディスクに残る（unmap と unlink は別操作）ので supervisor が open できる。後始末は
    /// 呼び出し側が `remove_file` する。
    fn make_shm() -> PathBuf {
        let p = unique_shm_path();
        let _ = std::fs::remove_file(&p);
        // create_shared でファイル作成 + REGION_BYTES に truncate。返る mapping は即 drop（ファイルは残る）。
        let _ = orbit_audio_sandbox::create_shared(&p).expect("create_shared");
        p
    }

    /// コミット済み fixture はテスト中に write-open しないため、exec 対象 inode に
    /// ETXTBSY の前提となる書き込み fd が存在しない。
    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    fn respawn_argument_recorder() -> PathBuf {
        fixture("record-respawn-args.sh")
    }

    fn respawn_args_path(shm: &Path) -> PathBuf {
        let mut path = shm.as_os_str().to_os_string();
        path.push(".respawn-args");
        path.into()
    }

    fn invocation_count_path(shm: &Path) -> PathBuf {
        let mut path = shm.as_os_str().to_os_string();
        path.push(".invocation-count");
        path.into()
    }

    // Critical 1（test-coverage review）: respawn が恒久失敗すると watchdog は measurement_invalid を立てて
    // 終了する（graceful degradation の保証）。短命 stub child + 不正 child_exe で respawn を必ず失敗させ、
    // device 無しで CI 検証する（gated kill-test は respawn 成功側しか踏まない）。
    #[test]
    fn supervisor_marks_measurement_invalid_when_respawn_fails() {
        let shm = make_shm();
        let stats = OutProcEffectStats::new();
        // すぐ exit する stub（watchdog が respawn を試みる契機）。
        let first = Command::new("sleep")
            .arg("0.2")
            .spawn()
            .expect("spawn stub child");
        // 存在しない child_exe → respawn は必ず失敗する。
        let bad_exe = std::env::temp_dir().join("orbit-nonexistent-effect-child-xyz");
        let sup = EffectChildSupervisor::spawn(
            first,
            shm.clone(),
            stats.clone(),
            bad_exe,
            PathBuf::from("/nonexistent.clap"),
            None,
            48_000,
        )
        .expect("supervisor spawn");

        let invalid = poll_until(5, || stats.measurement_invalid.load(Ordering::Acquire));
        assert!(invalid, "respawn 恒久失敗で measurement_invalid が立つ");
        drop(sup); // join がハングしないこと（watchdog は break 済み）。
        let _ = std::fs::remove_file(&shm);
    }

    // Important 2（test-coverage review）: 異常終了した child を watchdog が respawn し respawn_count を進める
    // （成功側の状態機械 = PID publish / count / last_respawn_ns）。CI で device 無し検証。
    //
    // #573: respawn 先は元々 bare `sleep`（transport 引数 `--shm`/`--plugin`/`--sample-rate` を
    // 数値と誤解して即 exit → fast respawn loop）だった。fast-fail 対策導入前は無害な副作用
    // だったが、導入後はこの respawn 先自体が「起動直後に死に続ける child」に該当し
    // `MAX_CONSECUTIVE_FAST_RESPAWNS` 回で watchdog が諦めてしまう（`measurement_invalid` が
    // 立ち、本テストの assertion と矛盾する）。respawn 成功の状態機械だけを検証したいので、
    // 引数を無視して生き続ける stub script に差し替える。
    #[test]
    fn supervisor_respawns_child_on_unexpected_exit() {
        let shm = make_shm();
        let stats = OutProcEffectStats::new();
        // #441 の regression: host がまだこのフラグをクリアしていない間も READY は見えうる。
        // watchdog は initial-attach fast-fail 分岐ではなく respawn を行わなければならない。
        stats.initial_attach_pending.store(true, Ordering::Release);
        let mmap = open_shared(&shm).expect("open shm to publish READY");
        let region = region_ptr(&mmap);
        // SAFETY: mmap はこのテストの生存する shared region を所有する。
        unsafe { orbit_audio_sandbox::transport::publish_child_ready(region, true) };
        let first = Command::new("sleep")
            .arg("0.2")
            .spawn()
            .expect("spawn stub child");
        // 引数（--shm/--plugin/--sample-rate）を無視して生き続ける respawn 先（spawn は成功 =
        // respawn_count++、かつ #573 の fast-fail 検知に引っかからない）。
        let respawn_target = fixture("slow-child.sh");
        let sup = EffectChildSupervisor::spawn(
            first,
            shm.clone(),
            stats.clone(),
            respawn_target.clone(),
            PathBuf::from("/ignored.clap"),
            None,
            48_000,
        )
        .expect("supervisor spawn");

        let respawned = poll_until(5, || stats.respawn_count.load(Ordering::Relaxed) >= 1);
        assert!(respawned, "child の異常終了で respawn_count が進む");
        assert!(
            !stats.measurement_invalid.load(Ordering::Acquire),
            "respawn が成功している間は計測有効"
        );
        drop(sup);
        let _ = std::fs::remove_file(&shm);
    }

    // #573: この respawn 先の script は元々 `sleep 0.2` で自分から終了していた。すると
    // watchdog がそれを異常終了として検知して**さらに respawn**してしまい、「どの respawn の
    // 記録を掴むか」がタイミング依存になっていた（fast-fail 対策の導入で連続 fast-fail の上限に
    // 達し respawn 自体が止まってしまう可能性もある）。長寿命（記録後は寝続ける）にすることで
    // respawn が「初回 child の強制 kill による1回」だけに確定し、決定論的なテストになる。
    #[test]
    fn supervisor_respawn_passes_the_state_saved_after_initial_spawn() {
        let fixture_dir = std::env::temp_dir().join(format!(
            "orbit-effect-respawn-state-{}-{}",
            std::process::id(),
            SHM_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&fixture_dir).expect("create respawn fixture directory");
        let child_script = respawn_argument_recorder();

        let shm = make_shm();
        let args_path = respawn_args_path(&shm);
        let stats = OutProcEffectStats::new();
        let first = crate::outproc_stub_child::stub_child_command()
            .spawn()
            .expect("spawn initial stub child");
        let first_pid = first.id();
        let chain = Arc::new(Mutex::new(vec![ChainStageConfig::Catalog {
            path: PathBuf::from("/ignored-effect.clap"),
            plugin_id: None,
            latest_state: None,
            enabled: true,
        }]));
        let mailbox = Arc::new(CommandMailboxHost::new(shm.clone()));
        let ui_pump = Arc::new(UiEventPump::new(shm.clone()));
        let ui_target = Arc::new(Mutex::new(None));
        let (ui_events, _) = tokio::sync::broadcast::channel(16);
        let sup = EffectChildSupervisor::spawn_chain_with_mailbox(
            first,
            shm.clone(),
            stats.clone(),
            child_script,
            48_000,
            chain.clone(),
            mailbox.clone(),
            PluginUiWiring {
                pump: ui_pump,
                target: ui_target,
                events: ui_events,
            },
        )
        .expect("supervisor spawn");

        let saved_state = fixture_dir.join("saved-after-spawn.state");
        std::fs::write(&saved_state, b"saved state").expect("write saved state");
        match chain.lock().expect("lock chain").get_mut(0) {
            Some(ChainStageConfig::Catalog { latest_state, .. }) => {
                *latest_state = Some(saved_state.clone());
            }
            _ => unreachable!("fixture chain has one catalog stage"),
        }

        assert!(
            Command::new("kill")
                .args(["-9", &first_pid.to_string()])
                .status()
                .expect("kill initial child")
                .success(),
            "initial child must be forcibly terminated"
        );
        assert!(
            poll_until(5, || args_path.exists()
                && stats.respawn_count.load(Ordering::Relaxed) >= 1),
            "watchdog did not respawn through the argument recorder"
        );
        let args: Vec<String> = std::fs::read_to_string(&args_path)
            .expect("read respawn arguments")
            .lines()
            .map(str::to_owned)
            .collect();
        let chain_index = args
            .iter()
            .position(|argument| argument == "--chain")
            .expect("respawn must receive --chain");
        let manifest_path = args.get(chain_index + 1).expect("--chain manifest path");
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(manifest_path).expect("read respawn chain manifest"),
        )
        .expect("parse respawn chain manifest");
        assert_eq!(
            manifest["stages"][0]["state"].as_str(),
            saved_state.to_str()
        );

        drop(sup);
        std::fs::remove_dir_all(fixture_dir).expect("remove respawn fixture directory");
        let _ = std::fs::remove_file(args_path);
        let _ = std::fs::remove_file(shm);
    }

    // #573: 起動直後に死に続ける child を watchdog が tight loop で respawn し続けない。respawn 先を
    // 即死する `true` にして、`MAX_CONSECUTIVE_FAST_RESPAWNS` 回連続の速い失敗で respawn をやめる
    // （measurement_invalid を立てて break する）ことを検証する。
    //
    // 変異検証: 上限判定（`consecutive_fast_fails >= MAX_CONSECUTIVE_FAST_RESPAWNS` の break）を
    // 外すと `true` が即死し続けるので respawn_count は無限に増え続け、「頭打ちで安定する」
    // assertion が red になる（実測は本 PR の報告を参照）。
    #[test]
    fn supervisor_stops_respawning_after_consecutive_fast_failures() {
        let shm = make_shm();
        let stats = OutProcEffectStats::new();
        let first = Command::new("true")
            .spawn()
            .expect("spawn immediately-exiting stub");
        let sup = EffectChildSupervisor::spawn(
            first,
            shm.clone(),
            stats.clone(),
            PathBuf::from("true"),
            PathBuf::from("/ignored.clap"),
            None,
            48_000,
        )
        .expect("supervisor spawn");

        let gave_up = poll_until(5, || stats.measurement_invalid.load(Ordering::Acquire));
        assert!(
            gave_up,
            "consecutive fast failures must trip measurement_invalid"
        );

        let stopped_at = stats.respawn_count.load(Ordering::Relaxed);
        assert_eq!(
            stopped_at,
            (MAX_CONSECUTIVE_FAST_RESPAWNS - 1) as u64,
            "respawn must stop exactly MAX_CONSECUTIVE_FAST_RESPAWNS-1 respawns after the \
             fast-failing streak begins (the Nth death that reaches the limit does not spawn \
             a replacement)"
        );
        // 打ち切り後も respawn_count が増え続けていないこと（本当に止まった証拠。tight loop の
        // 再発を検出する）。
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(
            stats.respawn_count.load(Ordering::Relaxed),
            stopped_at,
            "respawn_count must not keep climbing after the watchdog gave up"
        );

        drop(sup);
        let _ = std::fs::remove_file(&shm);
    }

    // #573: 単発クラッシュ（`FAST_RESPAWN_THRESHOLD` 以上生きてから死ぬ）は連続 fast-fail カウンタを
    // リセットする——壊れた child だと誤判定されず従来どおり復帰し続けられる。3 回目の起動だけ
    // 2.2s 生きてから死ぬ script を使い、reset の前後に fast fail を積んで検証する（2 fast fails →
    // 1 survivor(reset) → 4 fast fails = 7 respawn 後に 2 度目のストリークで上限に達する）。
    //
    // 変異検証: リセット（`advance_fast_respawn_streak` の `else 0`）を「常に加算する」よう変異させると、
    // 3 回目の survivor 死も加算されてしまい、合算が本来より早く上限へ達する。respawn_count は 7 では
    // なく 4 で頭打ちになり、`final_respawn_count == 7` assertion が red になる（実測は本 PR の報告を
    // 参照）。
    #[test]
    fn supervisor_resets_fast_fail_streak_after_a_survivor() {
        let shm = make_shm();
        let count_path = invocation_count_path(&shm);
        let script = fixture("variable-lifetime-child.sh");
        let slow_at = PathBuf::from("3");
        let stats = OutProcEffectStats::new();
        let chain = vec![ChainStageConfig::Catalog {
            path: slow_at.clone(),
            plugin_id: None,
            latest_state: None,
            enabled: true,
        }];
        let manifest = write_chain_manifest(&shm, &chain).expect("write chain manifest");
        let first = spawn_effect_child(&script, &shm, &manifest, 48_000)
            .expect("spawn variable-lifetime stub (invocation 1)");
        let sup = EffectChildSupervisor::spawn(
            first,
            shm.clone(),
            stats.clone(),
            script.clone(),
            slow_at,
            None,
            48_000,
        )
        .expect("supervisor spawn");

        let gave_up = poll_until(10, || stats.measurement_invalid.load(Ordering::Acquire));
        assert!(
            gave_up,
            "the second fast-fail streak (after the reset) must eventually trip the breaker too"
        );
        assert_eq!(
            stats.respawn_count.load(Ordering::Relaxed),
            7,
            "2 fast fails + 1 survivor (reset) + 4 fast fails must respawn exactly 7 times before \
             giving up (without the reset, the streak would trip the breaker after only 4 respawns)"
        );

        drop(sup);
        let _ = std::fs::remove_file(count_path);
        let _ = std::fs::remove_file(&shm);
    }

    // Critical 2（test-coverage / code review）: open_shared 失敗時に first_child を orphan 化させず reap する。
    // shm ファイルを消してから spawn を呼び open_shared を失敗させ、Err 返却 + child が reap される
    // （kill -0 が ESRCH）ことを検証する。
    #[test]
    fn supervisor_spawn_reaps_first_child_on_open_shared_failure() {
        let shm = unique_shm_path();
        let _ = std::fs::remove_file(&shm); // ファイル不在 → open_shared が失敗する
        let stats = OutProcEffectStats::new();
        let first = crate::outproc_stub_child::stub_child_command()
            .spawn()
            .expect("spawn stub child");
        let pid = first.id();
        let r = EffectChildSupervisor::spawn(
            first,
            shm.clone(),
            stats,
            PathBuf::from("/nonexistent"),
            PathBuf::from("/nonexistent.clap"),
            None,
            48_000,
        );
        assert!(r.is_err(), "open_shared 失敗で Err を返す");
        // first_child が reap された（orphan でない）= kill -0 が失敗（ESRCH）する。
        let reaped = poll_until(3, || {
            !Command::new("kill")
                .arg("-0")
                .arg(pid.to_string())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        });
        assert!(
            reaped,
            "open_shared 失敗時に first_child が reap される（orphan 化しない）"
        );
    }

    // Important 3（test-coverage review）: teardown handshake を **真の並行**下で検証する。background thread が
    // process() をループ（audio thread を模す）する一方で OutProcTeardownGuard を drop し、Acquire/Release の
    // handshake が伝播して `teardown_done` が立つことを確認する（Acquire/Release ペアの回帰ガード）。
    //
    // 検証する性質は「並行下で handshake が伝播する（td==true）」+「guard が deadlock しない（drop が返る =
    // guard は 500ms timeout を持つので必ず返る）」。**timing の tight bound は意図的に置かない**: 厳密な
    // 経過時間は CI runner の負荷（2-vCPU で本ループが core を専有 + 並列テスト）に依存し flake 源になる。
    // ループには `yield_now` を入れて guard スレッドを starve させない（td 伝播を実機に近づける）。
    #[test]
    fn teardown_handshake_acked_under_concurrent_process() {
        let (tr, td) = flags();
        let shutdown = Arc::new(AtomicBool::new(false));
        let stats = OutProcEffectStats::new();
        let mut pp = OutProcEffectPostProcessor::new(OutProcEffectPostProcessorParts {
            host: temp_host(),
            engaged: engaged(true),
            teardown_requested: tr.clone(),
            teardown_done: td.clone(),
            stats,
        });
        let stop = Arc::new(AtomicBool::new(false));
        let stop_t = stop.clone();
        let handle = std::thread::spawn(move || {
            let mut data = vec![0.5f32; 64 * 2];
            while !stop_t.load(Ordering::Relaxed) {
                pp.process(&mut data);
                // tight spin で core を専有して guard スレッドを starve させない（CI 安定化）。
                std::thread::yield_now();
            }
        });
        // 少し回してから guard を drop（requested 立て → done を待つ・guard は 500ms timeout 付きで必ず返る）。
        std::thread::sleep(Duration::from_millis(50));
        drop(OutProcTeardownGuard::new(OutProcTeardownParts {
            requested: tr.clone(),
            done: td.clone(),
            shutdown,
        }));
        // drop が返った時点で deadlock していない。並行 process() が handshake を ack して done を立てている。
        assert!(
            td.load(Ordering::Acquire),
            "concurrent process() が teardown_done を ack する（Acquire/Release 伝播）"
        );
        stop.store(true, Ordering::Relaxed);
        handle.join().expect("process loop thread joins");
    }

    // #552: effect の format は attach する plugin ごとに決まる（process-global ではない）。
    // 利用者にプラグイン形式は見えてはならず、CLAP と VST3 のエフェクトは同一チェーンに
    // 混在できなければならない（CAP.6-1「上位は形式分岐を持たない」）。
    #[test]
    fn effect_plugin_format_selects_child_name_from_extension() {
        // 内部の format 判定ではなく**公開の入口**を通す（実際に attach で使われる経路）。
        let current = Path::new("/opt/orbit/bin/orbit-clap-effect-child");
        let child_for = |plugin: &str| {
            child_exe_for_attach(current, Path::new(plugin))
                .file_name()
                .and_then(|name| name.to_str())
                .expect("child name")
                .to_owned()
        };
        assert_eq!(child_for("reverb.clap"), "orbit-clap-effect-child");
        assert_eq!(child_for("Tape Echo.VST3"), "orbit-vst3-effect-child");
        // 未知拡張子は CLAP へフォールバック（raw .dylib の CLAP を attach する gated テストがある）。
        assert_eq!(
            child_for("libclap_test_effect.dylib"),
            "orbit-clap-effect-child"
        );
    }

    #[test]
    fn effect_child_exe_for_attach_swaps_within_same_directory() {
        let clap_child = PathBuf::from("/opt/orbit/bin/orbit-clap-effect-child");
        assert_eq!(
            child_exe_for_attach(&clap_child, Path::new("/plugins/Tape Echo.vst3")),
            PathBuf::from("/opt/orbit/bin/orbit-vst3-effect-child"),
        );
        // 対称・冪等: VST3 child から .clap を attach し直すと CLAP child へ戻る。
        let vst3_child = PathBuf::from("/opt/orbit/bin/orbit-vst3-effect-child");
        assert_eq!(
            child_exe_for_attach(&vst3_child, Path::new("/plugins/Surge.clap")),
            PathBuf::from("/opt/orbit/bin/orbit-clap-effect-child"),
        );
    }

    #[test]
    fn effect_child_exe_for_attach_preserves_explicit_override() {
        // ORBIT_EFFECT_CHILD_BIN / gated テストの直指定を壊さない（デフォルト名以外は触らない）。
        let explicit = PathBuf::from("/custom/my-effect-host");
        assert_eq!(
            child_exe_for_attach(&explicit, Path::new("/plugins/Tape Echo.vst3")),
            explicit,
        );
    }

    // C2（pr-review-team）: format 選択の純関数は device/child プロセス不要で CI 常時実行できるのに
    // gated テストからしか経由されていなかった。env value 解決 + child binary 名の対応表を直接固定する。
    #[test]
    fn plugin_format_from_env_value_defaults_to_clap() {
        assert_eq!(PluginFormat::from_env_value(None), Ok(PluginFormat::Clap));
    }

    #[test]
    fn plugin_format_from_env_value_accepts_known_values() {
        assert_eq!(
            PluginFormat::from_env_value(Some("vst3".to_owned())),
            Ok(PluginFormat::Vst3)
        );
        assert_eq!(
            PluginFormat::from_env_value(Some("clap".to_owned())),
            Ok(PluginFormat::Clap)
        );
    }

    #[test]
    fn plugin_format_from_env_value_rejects_unknown_values() {
        assert!(PluginFormat::from_env_value(Some("au".to_owned())).is_err());
    }

    #[test]
    fn plugin_format_default_child_name_matches_format() {
        assert_eq!(
            PluginFormat::Clap.default_child_name(),
            "orbit-clap-effect-child"
        );
        assert_eq!(
            PluginFormat::Vst3.default_child_name(),
            "orbit-vst3-effect-child"
        );
    }
}
