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
//! 2. `OutputStream` = cpal callback 停止 → adapter（host + host の mmap）が drop され mmap が unmap。
//! 3. [`EffectChildSupervisor`]（stream 後）= **先に watchdog を止め**（respawn 停止）、その後 child へ
//!    QUIT を送って reap し、最後に shm を unlink する（watchdog 停止を QUIT/reap より先にやらないと、
//!    teardown 中の child を watchdog が respawn してしまう）。

// 共有メモリは生ポインタ経由でクロスプロセス参照するため unsafe FFI 同等。
#![allow(unsafe_code)]

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use orbit_audio_native::PostProcessor;
use orbit_audio_sandbox::{open_shared, region_ptr, PipelinedEffectHost, CONTROL_QUIT};

/// watchdog が child の生存を poll する周期（非 RT・control thread）。
const WATCHDOG_POLL: Duration = Duration::from_millis(20);
/// QUIT 後に child の終了を待つ上限（超えたら kill にフォールバック）。`SandboxChildGuard` と同値。
const REAP_TIMEOUT: Duration = Duration::from_secs(2);
/// teardown handshake 待ち上限（audio thread が `teardown_done` を立てるのを待つ）。device が callback を
/// 配送しない異常系の安全弁（`ClapTeardownGuard` と同値・設計 §4.5）。
const TEARDOWN_TIMEOUT: Duration = Duration::from_millis(500);

/// 同一プロセス内で複数の OOP effect を起動した時に shm ファイル名が衝突しないための連番。
static SHM_SEQ: AtomicU64 = AtomicU64::new(0);

/// OOP effect 用の一意な共有メモリファイルパスを返す（PID + 連番）。
pub fn unique_shm_path() -> PathBuf {
    let seq = SHM_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    std::env::temp_dir().join(format!("orbit-outproc-effect-{pid}-{seq}.shm"))
}

/// OOP effect の起動設定（child binary path + plugin）。`start_outproc_effect` と gated test が使う。
/// sample_rate は device 確定後に渡すので含めない。
pub struct OutProcEffectConfig {
    /// effect child binary（`orbit-clap-effect-child`）のパス。
    pub child_exe: PathBuf,
    /// host する .clap バンドルのパス（load-time param のみ・M1 は per-block automation なし）。
    pub plugin: PathBuf,
    /// CLAP plugin id（None なら単一プラグインの場合のみ OK）。
    pub plugin_id: Option<String>,
    /// cpal に要求する固定バッファフレーム数（gated stale-rate harness が 32/64 を渡す）。`None` は
    /// device 既定（`BufferSize::Default`）。production の env 経路は通常 `None`。
    pub buffer_frames: Option<u32>,
}

impl OutProcEffectConfig {
    /// 環境変数から設定を組む（production `start()` 用）:
    /// - `ORBIT_EFFECT_CHILD_BIN`: child binary path（省略時は daemon exe と同一ディレクトリの
    ///   `orbit-clap-effect-child`）。
    /// - `ORBIT_EFFECT_PLUGIN`: .clap path（**必須**）。
    /// - `ORBIT_EFFECT_PLUGIN_ID`: plugin id（任意）。
    pub fn from_env() -> Result<Self, String> {
        let child_exe = match std::env::var_os("ORBIT_EFFECT_CHILD_BIN") {
            Some(v) => PathBuf::from(v),
            None => default_child_exe()?,
        };
        let plugin = std::env::var_os("ORBIT_EFFECT_PLUGIN")
            .map(PathBuf::from)
            .ok_or_else(|| {
                "ORBIT_EFFECT_PLUGIN not set (out-of-process effect needs a .clap bundle path)"
                    .to_string()
            })?;
        let plugin_id = std::env::var("ORBIT_EFFECT_PLUGIN_ID").ok();
        // production は通常 device 既定。`ORBIT_EFFECT_BUFFER_FRAMES` で明示できる（無効値は無視 = None）。
        let buffer_frames = std::env::var("ORBIT_EFFECT_BUFFER_FRAMES")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|&n| n > 0);
        Ok(Self {
            child_exe,
            plugin,
            plugin_id,
            buffer_frames,
        })
    }
}

/// daemon 実行ファイルと同一ディレクトリの `orbit-clap-effect-child` を child binary 既定パスとする
/// （spike の sibling-of-exe を踏襲・設計 §4.5）。インストール時は daemon と child が並んで置かれる前提。
fn default_child_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current_exe has no parent directory".to_string())?;
    Ok(dir.join("orbit-clap-effect-child"))
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
    /// respawn が失敗した（child binary 不在等）= 計測無効。gated harness が verdict を捨てる。
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
    /// teardown 要求（daemon supervisor → audio thread）。立つと transport への submit を止め、`data` を
    /// dry のまま素通しする。control 側が child へ QUIT を送って reap・shm unlink する前に audio thread が
    /// transport を触らなくなる（in-process clap の handshake を踏襲・設計 §4.5）。
    teardown_requested: Arc<AtomicBool>,
    /// teardown 完了（audio thread → daemon supervisor）。`process` が quiesce に入ったら立てる。
    teardown_done: Arc<AtomicBool>,
    /// 観測 counter のミラー先（control thread が読む）。
    stats: Arc<OutProcEffectStats>,
}

impl OutProcEffectPostProcessor {
    /// `host` = mmap を所有する production 構築子（`PipelinedEffectHost::from_mmap`）で作った host、
    /// `teardown_requested` / `teardown_done` = supervisor と共有する協調フラグ、`stats` = 観測ミラー。
    pub fn new(
        host: PipelinedEffectHost,
        teardown_requested: Arc<AtomicBool>,
        teardown_done: Arc<AtomicBool>,
        stats: Arc<OutProcEffectStats>,
    ) -> Self {
        Self {
            host,
            teardown_requested,
            teardown_done,
            stats,
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
/// `ClapPostProcessor` の post-peak と同手法。空 slice は 0。
#[inline]
fn peak_bits(data: &[f32]) -> u32 {
    data.iter().map(|s| s.abs().to_bits()).max().unwrap_or(0)
}

/// `--shm`/`--plugin`/`--sample-rate`(/`--plugin-id`) を渡して effect child を 1 つ起動する。
/// `start_outproc_effect` の初回 spawn と watchdog の respawn が共有する。
///
/// パスは `OsStr` のまま渡す（lossy 変換しない）。`stderr` は **継承**して child の eprintln（plugin
/// process 失敗の集計報告等）を daemon stderr に出す（carry-forward ①③: child の可観測性）。
pub fn spawn_effect_child(
    child_exe: &Path,
    shm_path: &Path,
    plugin: &Path,
    plugin_id: Option<&str>,
    sample_rate: u32,
) -> io::Result<Child> {
    let mut cmd = Command::new(child_exe);
    cmd.arg("--shm")
        .arg(shm_path)
        .arg("--plugin")
        .arg(plugin)
        .arg("--sample-rate")
        .arg(sample_rate.to_string())
        .stderr(Stdio::inherit());
    if let Some(id) = plugin_id {
        cmd.arg("--plugin-id").arg(id);
    }
    cmd.spawn()
}

/// QUIT 済み（または crash した）child を bounded に reap する。timeout 超過で kill にフォールバック。
/// `SandboxChildGuard` の reap と同じ意味論（非 RT・spin でなく yield）。
fn reap(child: &mut Child) {
    let deadline = Instant::now() + REAP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::yield_now(),
            Ok(None) => {
                tracing::warn!(
                    "orbit-clap-effect-child が {REAP_TIMEOUT:?} 以内に終了せず kill にフォールバック"
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
        // watchdog 専用の control mapping（host は from_mmap で 1st mapping を消費するので 2nd を開く）。
        // この MmapMut は closure に move され watchdog thread 終了まで生存する（region ポインタの前提）。
        // 失敗時は first_child を orphan 化させず reap する（呼び出し側は first_child を spawn 済み）。
        let mut first_child = first_child;
        let ctl_mmap = match open_shared(&shm_path) {
            Ok(m) => m,
            Err(e) => {
                let _ = first_child.kill();
                let _ = first_child.wait();
                return Err(e);
            }
        };
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_thread = shutdown.clone();
        let base = Instant::now();
        // respawn 用に closure へ move する shm_path（struct 側は unlink 用に原本を保持する）。
        let shm_path_wd = shm_path.clone();

        let watchdog = std::thread::Builder::new()
            .name("orbit-outproc-effect-watchdog".into())
            .spawn(move || {
                // region は thread 内で導出（生ポインタを thread 境界で渡さない）。ctl_mmap が生かす。
                let region = region_ptr(&ctl_mmap);
                let mut child = first_child;
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
                        Ok(Some(status)) => {
                            // teardown と crash の race: shutdown を再確認してから respawn 判断
                            // （shutdown 中の終了は正常 teardown なので respawn しない・advisor）。
                            if shutdown_thread.load(Ordering::Acquire) {
                                break;
                            }
                            tracing::warn!(
                                "orbit-clap-effect-child が異常終了（{status}）→ respawn する"
                            );
                            match spawn_effect_child(
                                &child_exe,
                                &shm_path_wd,
                                &plugin,
                                plugin_id.as_deref(),
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
                                        "effect child respawn 失敗（計測無効・以降 dry/stale）: {e}"
                                    );
                                    stats.measurement_invalid.store(true, Ordering::Release);
                                    break;
                                }
                            }
                        }
                        Ok(None) => std::thread::sleep(WATCHDOG_POLL),
                        Err(e) => {
                            tracing::error!("effect child try_wait 失敗: {e}");
                            std::thread::sleep(WATCHDOG_POLL);
                        }
                    }
                }
                // teardown: shutdown 済み（respawn しない）。現 child へ QUIT を送り reap する。
                // SAFETY: region は生存 ctl_mmap を指す。QUIT は一回限りの flag（Release で publish）。
                unsafe {
                    (*region).control.store(CONTROL_QUIT, Ordering::Release);
                }
                reap(&mut child);
                // ここで ctl_mmap が drop（thread 終了）。shm unlink は supervisor drop が join 後に行う。
            })?;

        Ok(Self {
            shutdown,
            watchdog: Some(watchdog),
            shm_path,
        })
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
        if let Err(e) = std::fs::remove_file(&self.shm_path) {
            // 既に消えている等は無害（warn のみ・teardown は続行）。
            tracing::warn!("OOP effect shm 削除失敗 {:?}: {e}", self.shm_path);
        }
    }
}

/// teardown guard（`StreamGuard` の最初の field = `_outproc_teardown`）。stream 停止 **前** に drop され、
/// `requested` を立てて `done`（audio thread が adapter で立てる）を timeout 付きで待つ。in-process clap の
/// `ClapTeardownGuard` と同じ意味論（設計 §4.5）。
pub struct OutProcTeardownGuard {
    requested: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

impl OutProcTeardownGuard {
    pub fn new(requested: Arc<AtomicBool>, done: Arc<AtomicBool>) -> Self {
        Self { requested, done }
    }
}

impl Drop for OutProcTeardownGuard {
    fn drop(&mut self) {
        self.requested.store(true, Ordering::Release);
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

    // 通常経路: adapter は host.process_block に委譲し counter を stats へミラーする。child が未処理
    // （mmap zero-init）なので初回は prime silence（host が data を無音化）= 委譲が起きた証拠。
    #[test]
    fn delegates_to_host_first_block_primes_silence_and_mirrors_stats() {
        let (tr, td) = flags();
        let stats = OutProcEffectStats::new();
        let mut pp = OutProcEffectPostProcessor::new(temp_host(), tr, td.clone(), stats.clone());
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
        let mut pp =
            OutProcEffectPostProcessor::new(temp_host(), tr.clone(), td.clone(), stats.clone());
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
    fn teardown_guard_exits_immediately_when_done_preset() {
        let (tr, td) = flags();
        td.store(true, Ordering::Release);
        let t0 = Instant::now();
        drop(OutProcTeardownGuard::new(tr.clone(), td));
        assert!(
            tr.load(Ordering::Acquire),
            "teardown_requested を必ず立てる"
        );
        assert!(
            t0.elapsed() < Duration::from_millis(100),
            "done 事前 set 時は即抜け"
        );
    }

    // teardown guard 安全弁: done が永遠に立たなくても deadlock せず TEARDOWN_TIMEOUT 付近で抜ける。
    #[test]
    fn teardown_guard_times_out_without_deadlock() {
        let (tr, td) = flags();
        let t0 = Instant::now();
        drop(OutProcTeardownGuard::new(tr.clone(), td));
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
}
