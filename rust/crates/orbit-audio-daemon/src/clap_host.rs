//! daemon 側 CLAP host 配線（feature `clap-host` 専用・Issue #340）。
//!
//! `orbit_clap_host::ClapHost`（`!Send`・`PluginInstance` を持つ）を **専用 OS スレッド**で所有し、
//! LoadPlugin コマンド処理 + CLAP main-thread callback pump を回す。Send な
//! `StartedPluginAudioProcessor` は install ring 経由で cpal callback（audio thread）へ渡る。
//!
//! なぜ専用スレッドか: tokio の `block_on` main thread は accept loop の `.await` に拘束され、
//! `!Send` instance を相乗りで pump できない。spike は main() で `recv_timeout` pump したが、daemon
//! では専用スレッドに移す（A0 thread-model・goal §3(a)）。
//!
//! teardown（carry-forward #1）: stream を止める **前に** audio thread で `stop_processing` を済ませ、
//! その後 instance を deactivate する。`EngineWrap::StreamGuard` の field 順
//! `[ClapTeardownGuard, OutputStream, ClapThreadGuard]` がこの順序を drop 順で強制する:
//! 1. `ClapTeardownGuard`（stream 前）= `teardown_requested` を立て `teardown_done` を待つ →
//!    audio thread の callback が `stop_processing()` を呼び plugin を停止・drop（CLAP 仕様 = audio
//!    thread。暗黙 Drop は別スレッドで走り strict plugin で UB）。
//! 2. `OutputStream` = cpal callback 停止（plugin は既に None なので wrong-thread stop は起きない）。
//! 3. `ClapThreadGuard`（stream 後）= 専用スレッドを停止 → `ClapHost::shutdown()` で instance を
//!    drop（deactivate を instance の home thread = 専用スレッドで実行）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use orbit_clap_host::{ClapHost, InstallMsg, LoadedPluginInfo};

/// CLAP main-thread callback の pump 周期（専用スレッドの recv_timeout 周期）。
const PUMP_INTERVAL: Duration = Duration::from_millis(5);
/// teardown 待ち上限。audio thread が `stop_processing` を済ませて `teardown_done` を立てるのを待つ。
/// 上限超過時は warn して stream 停止に進む（device が callback を配送しない異常系の安全弁）。
const TEARDOWN_TIMEOUT: Duration = Duration::from_millis(500);

/// 専用スレッドへの制御コマンド。
pub enum ClapCommand {
    /// .clap を load + activate + start_processing し、install ring に push する。
    LoadPlugin {
        path: PathBuf,
        plugin_id: Option<String>,
        sample_rate: u32,
        channels: usize,
        max_frames: u32,
        /// 同期応答チャネル（WS handler が spawn_blocking で待つ）。
        reply: mpsc::Sender<Result<LoadedPluginInfo, String>>,
    },
}

/// CLAP host 専用スレッドを起動する。
///
/// `callback_requested` / `resize_count` / `install_tx` は `orbit_clap_host::new_clap_host` が返す
/// `ClapHostParts` から取り出して渡す。戻り値:
/// - `cmd_tx`: `EngineWrap` が `LoadPlugin` を送る Sender（`!Sync` なので EngineWrap 側で Mutex 包み）。
/// - `ClapThreadGuard`: shutdown + join 用 guard（`StreamGuard` の最後の field に載せる）。
pub fn spawn_clap_thread(
    callback_requested: Arc<AtomicBool>,
    resize_count: Arc<AtomicU64>,
    mut install_tx: rtrb::Producer<InstallMsg>,
) -> (mpsc::Sender<ClapCommand>, ClapThreadGuard) {
    let (cmd_tx, cmd_rx) = mpsc::channel::<ClapCommand>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_thread = shutdown.clone();

    let handle = std::thread::Builder::new()
        .name("orbit-clap-host".into())
        .spawn(move || {
            let mut host = ClapHost::new(callback_requested, resize_count);
            loop {
                if shutdown_thread.load(Ordering::Relaxed) {
                    break;
                }
                match cmd_rx.recv_timeout(PUMP_INTERVAL) {
                    Ok(ClapCommand::LoadPlugin {
                        path,
                        plugin_id,
                        sample_rate,
                        channels,
                        max_frames,
                        reply,
                    }) => {
                        let res = host.load_plugin(
                            &path,
                            plugin_id.as_deref(),
                            sample_rate,
                            channels,
                            max_frames,
                        );
                        let reply_msg = match res {
                            Ok((msg, info)) => {
                                // install ring へ push（audio thread が pop して hot-install）。
                                if install_tx.push(msg).is_err() {
                                    Err("install ring full".to_string())
                                } else {
                                    Ok(info)
                                }
                            }
                            Err(e) => Err(e.to_string()),
                        };
                        // 応答先が消えていても teardown を止めない（reply drop は無視）。
                        let _ = reply.send(reply_msg);
                    }
                    // timeout = pump tick。plugin が request_callback を立てていれば処理する。
                    Err(mpsc::RecvTimeoutError::Timeout) => host.pump(),
                    // 全 Sender drop = daemon shutdown 経路。
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            // teardown: ここに来た時点で stream は既に停止し（ClapThreadGuard は StreamGuard の最後の
            // field）、plugin は audio thread で stop_processing 済み。instance を drop して deactivate
            // を instance の home thread（= この専用スレッド）で実行する。
            host.shutdown();
        })
        .expect("spawn orbit-clap-host thread");

    (
        cmd_tx,
        ClapThreadGuard {
            shutdown,
            handle: Some(handle),
        },
    )
}

/// 専用スレッドを停止して join する guard。`StreamGuard` の **最後** の field に置き、stream 停止
/// **後** に drop されて instance の deactivate（専用スレッド）を stream 停止後に走らせる。
pub struct ClapThreadGuard {
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Drop for ClapThreadGuard {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            if h.join().is_err() {
                tracing::error!("orbit-clap-host thread panicked during shutdown");
            }
        }
    }
}

/// teardown guard（carry-forward #1）。`StreamGuard` の **最初** の field に置き、stream 停止 **前**
/// に audio thread で `stop_processing` を済ませる。`requested` を立て、`done`（audio thread が
/// callback で立てる）を timeout 付きで待つ。
pub struct ClapTeardownGuard {
    requested: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

impl ClapTeardownGuard {
    pub fn new(requested: Arc<AtomicBool>, done: Arc<AtomicBool>) -> Self {
        Self { requested, done }
    }
}

impl Drop for ClapTeardownGuard {
    fn drop(&mut self) {
        self.requested.store(true, Ordering::Release);
        let deadline = Instant::now() + TEARDOWN_TIMEOUT;
        while !self.done.load(Ordering::Acquire) {
            if Instant::now() >= deadline {
                tracing::warn!(
                    "CLAP teardown: stop_processing ack timed out ({}ms); proceeding to stop stream",
                    TEARDOWN_TIMEOUT.as_millis()
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}
