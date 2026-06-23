//! LinkAudio egress の control-side 配線（A4-2b-2 / feature `link-audio` 専用）。
//!
//! 🔴 GPL 境界: この module は feature `link-audio`（default off）でのみコンパイルされ、GPL
//! crate [`orbit_link_audio`] を保持する **GPL consumer thread** を起動する。permissive な
//! engine core（orbit-audio-core / -native）はこの module に依存しない。
//!
//! 3 スレッド lock-free アーキ（A4-2b-2 design・clap-spike 実証）:
//! - **cpal RT callback**（permissive・native `output.rs`）= `render_multi` で hardware + channel
//!   buffer を 1 パスで埋め、channel buffer を `RingTapSink`(rtrb producer)へ push。
//! - **GPL consumer thread**（本 module の [`consumer_loop`]）= rtrb consumer を drain し
//!   [`orbit_link_audio::LinkChannelEgress::pump_once`] で Link へ commit（= Link "audio thread"）。
//! - **control**（daemon tokio task から呼ぶ・[`LinkAudioControl::register_channel`]）= registration
//!   を 2 経路へ配る（sink を reg-ring 経由で callback へ / consumer side を mpsc 経由で consumer
//!   thread へ）。`LinkAudioControl` 自体は std mpsc + rtrb のみで tokio に依存しない。
//!
//! 2b-2a は **単一 channel** の実証に絞る（pool + N channel + readiness race は 2b-2b）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use orbit_audio_native::{LinkChannelActivate, RingTapSink};
use orbit_link_audio::{CommitResult, LinkAudioError, LinkAudioOutput, LinkChannelEgress};

/// ring 容量（秒）。callback の push と consumer の drain を decouple する緩衝。
const RING_SECONDS: usize = 2;
/// consumer が 1 回に commit する frame 数（Link への commit granularity）。
const BLOCK_FRAMES: usize = 256;
/// LinkAudio の quantum（拍/小節境界の単位・4 = 4 拍）。
const QUANTUM: f64 = 4.0;
/// callback の per-block scratch を確保する frame 上限。device buffer は通常 512〜2048 frame だが
/// 余裕を持たせる（RT 外の control thread で alloc・大きめでも害はない）。callback は実 block が
/// scratch を超えたら安全側で hardware のみに落とす。
const MAX_BLOCK_FRAMES: usize = 8192;
/// reg-ring 容量（callback への activation メッセージ）。2b-2a は単一 channel なので小で足りる。
/// EngineWrap が `start_default_output_with_link_egress` に渡すため pub（const 文脈で使える）。
pub const REG_RING_CAPACITY: usize = 8;

/// control→consumer thread の registration コマンド（mpsc payload）。consumer thread が受け取って
/// Link channel を登録し [`LinkChannelEgress`] を構築する。
struct RegisterCmd {
    name: String,
    consumer: rtrb::Consumer<f32>,
    drops: Arc<std::sync::atomic::AtomicU64>,
    num_channels: usize,
    sample_rate: u32,
}

/// registration の失敗理由。
#[derive(Debug, thiserror::Error)]
pub enum LinkRegisterError {
    #[error("link consumer thread is gone")]
    ConsumerGone,
    #[error("reg-ring is full (callback not draining activations)")]
    RegRingFull,
}

/// consumer thread の状態機械。2b-2a は単一 channel なので最初の登録で `Waiting`→`Active` へ遷移し、
/// 以後の登録は無視する（pool 化は 2b-2b）。
enum ConsumerState {
    /// channel 未登録。`LinkAudioOutput`（Link session）を保持して登録を待つ。
    Waiting(LinkAudioOutput),
    /// channel 登録済。`LinkChannelEgress` が `LinkAudioOutput` を所有し ring を drain する。
    Active(LinkChannelEgress),
}

/// GPL consumer thread の本体。`shutdown` が立つまでループし、registration を処理しつつ active な
/// egress を pump する。**teardown は drop 順ではなく明示 signal+join**（A0 §13 教訓）: 戻ると
/// `state` がこの thread 上で drop され `LinkAudioOutput::drop`→Link teardown が走る。
fn consumer_loop(
    mut state: ConsumerState,
    cmd_rx: mpsc::Receiver<RegisterCmd>,
    shutdown: Arc<AtomicBool>,
) {
    // commit 失敗（ChannelNotFound/CommitFailed）の連続回数。LinkAudio egress は hardware path の
    // StreamStats のような observability surface を持たない（full な surface は follow-up）ので、
    // 最低限「音が Link peer に届いていない」を operator が log で気付けるよう throttle して warn する。
    let mut commit_fail_streak: u64 = 0;
    while !shutdown.load(Ordering::Relaxed) {
        // 1. registration を drain（2b-2a は最初の 1 件で Active 化、以降は無視）。control 側の
        //    冪等 guard で同名再登録は届かないが、defense として Active 中の追加 cmd も無害に捌く。
        while let Ok(cmd) = cmd_rx.try_recv() {
            state = match state {
                ConsumerState::Waiting(output) => {
                    // ring 1 block 分が安全に収まる max_num_samples で Link channel を登録。
                    let max_num_samples = BLOCK_FRAMES * cmd.num_channels;
                    match output.register_channel(&cmd.name, max_num_samples) {
                        Ok(id) => ConsumerState::Active(LinkChannelEgress::new(
                            output,
                            cmd.consumer,
                            cmd.drops,
                            id,
                            cmd.num_channels,
                            cmd.sample_rate,
                            QUANTUM,
                            BLOCK_FRAMES,
                        )),
                        Err(e) => {
                            // 登録失敗（稀）。2b-2a は単一 channel ＝ これが唯一の登録機会なので
                            // 以後 pump は走らず egress は dead になる。silent でなく error で surface。
                            tracing::error!(
                                "LinkAudio channel '{}' register failed: {e} — egress will be silent",
                                cmd.name
                            );
                            ConsumerState::Waiting(output)
                        }
                    }
                }
                // 既に Active（2b-2a は単一 channel）。追加登録は drop（pool 化は 2b-2b）。
                active @ ConsumerState::Active(_) => {
                    tracing::warn!(
                        "LinkAudio channel '{}' ignored: 2b-2a supports a single channel",
                        cmd.name
                    );
                    active
                }
            };
        }

        // 2. active なら溜まっている分を全て pump、無ければ短く sleep（busy-wait を避ける）。
        match &mut state {
            ConsumerState::Active(egress) => {
                let mut pumped = false;
                while let Some(rc) = egress.pump_once() {
                    pumped = true;
                    match rc {
                        // NoSubscriber は Live 未参加の通常状態（silent）。回復で streak をリセット。
                        CommitResult::Committed | CommitResult::NoSubscriber => {
                            commit_fail_streak = 0
                        }
                        // 購読者ありで commit 失敗 / channel 消失。音が Link に届かない health signal。
                        CommitResult::CommitFailed | CommitResult::ChannelNotFound => {
                            commit_fail_streak += 1;
                            if commit_fail_streak == 1 || commit_fail_streak.is_multiple_of(1000) {
                                tracing::warn!(
                                    "LinkAudio commit failing ({rc:?}, streak={commit_fail_streak}): \
                                     audio not reaching Link peer"
                                );
                            }
                        }
                    }
                }
                if !pumped {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            ConsumerState::Waiting(_) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    // ループ脱出 → state(と内部の LinkAudioOutput)がこの thread 上で drop。
}

/// GPL consumer thread を明示 teardown する RAII guard。**drop で shutdown フラグを立てて join**。
/// これが teardown の load-bearing な機構で、drop 順には依存しない（A0 §13）。`StreamGuard` に保持
/// され、cpal stream（push 元）停止後に drop される field 順にしてある。
pub struct LinkAudioGuard {
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Drop for LinkAudioGuard {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            // join 失敗（consumer thread の panic）はログのみ。teardown を止めない。
            if h.join().is_err() {
                tracing::error!("LinkAudio consumer thread panicked during shutdown");
            }
        }
    }
}

/// LinkAudio egress の control-side ハンドル。`EngineWrap` が feature 裏で保持し、
/// `register_channel` で channel を 2 経路（callback / consumer thread）へ配線する。
pub struct LinkAudioControl {
    /// callback へ channel activation を渡す reg-ring producer。
    reg_tx: rtrb::Producer<LinkChannelActivate>,
    /// consumer thread へ registration を渡す mpsc sender。
    cmd_tx: mpsc::Sender<RegisterCmd>,
    sample_rate: u32,
    num_channels: usize,
    /// 既に登録済みの channel 名（2b-2a は単一 channel）。再登録の冪等化に使う。TS 層は
    /// `output()` 宣言時と dispatch で同名を複数回登録する設計なので、再 push を防がないと
    /// callback 側で古い `LinkChannelActivate`（ring producer）が **RT スレッド上で drop** され、
    /// かつ新 ring を誰も drain せず egress が無音化する。pool 化（複数 channel）は 2b-2b。
    registered_channel: Option<String>,
}

impl LinkAudioControl {
    /// LinkAudio session を生成・enable し、GPL consumer thread を起動する。
    /// `reg_tx` は native `start_default_output_with_link_egress` が返す reg-ring producer。
    /// 返り値の [`LinkAudioGuard`] は `StreamGuard` に載せ、teardown まで保持する。
    ///
    /// consumer thread は callback が push を始める前に spawn される（spawn → 以後に
    /// `register_channel` で callback へ sink を渡す）ため、ready 順は callback push に先行する。
    pub fn spawn(
        reg_tx: rtrb::Producer<LinkChannelActivate>,
        sample_rate: u32,
        num_channels: usize,
    ) -> Result<(Self, LinkAudioGuard), LinkAudioError> {
        let output = LinkAudioOutput::new(120.0, "orbit-engine")?;
        // discovery を有効化（Live/peer が channel を購読できるように）。enable は単なる FFI で
        // "audio thread" 制約の対象外なので control thread で呼んでよい（capture_beat のみ
        // consumer thread = audio thread から呼ぶ・egress.rs 参照）。
        output.set_enabled(true);

        let (cmd_tx, cmd_rx) = mpsc::channel::<RegisterCmd>();
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_thread = shutdown.clone();
        // spawn 失敗（OS リソース枯渇・稀）は boot を panic させず Result で propagate する。
        let handle = std::thread::Builder::new()
            .name("orbit-link-egress".into())
            .spawn(move || consumer_loop(ConsumerState::Waiting(output), cmd_rx, shutdown_thread))
            .map_err(|e| LinkAudioError::ThreadSpawn(e.to_string()))?;

        Ok((
            Self {
                reg_tx,
                cmd_tx,
                sample_rate,
                num_channels,
                registered_channel: None,
            },
            LinkAudioGuard {
                shutdown,
                handle: Some(handle),
            },
        ))
    }

    /// 名前付き channel を登録する。`RingTapSink` を生成し、**sink を callback へ / consumer side を
    /// consumer thread へ**配る。
    ///
    /// 順序（advisor #3）: consumer thread への登録を先に送り（Link channel 登録 + egress 構築 +
    /// pump 開始）、その後 callback へ sink を渡す。これにより consumer が（多くの場合）先に ready に
    /// なる。callback が consumer 登録より先に push しても ring が緩衝するだけ（drop は produced-frame
    /// 算入で beat に反映）。**部分失敗**（cmd 送信は成功・reg-ring push が満杯で失敗）は 2b-2a の
    /// 単一 channel scope では許容しエラーで surface する（pool 化と再試行は 2b-2b）。
    pub fn register_channel(&mut self, name: &str) -> Result<(), LinkRegisterError> {
        // 冪等 guard（必須）: TS 層は `output()` 宣言時と dispatch で同名を複数回登録する設計。
        // 再 push を許すと callback 側で旧 `LinkChannelActivate`（ring producer）が **RT スレッド上で
        // drop** され、かつ新 ring を誰も drain せず egress が無音化する。同名は no-op で返す。
        if let Some(existing) = &self.registered_channel {
            if existing != name {
                // 2b-2a は単一 channel。別名 channel は未対応 → log して no-op（pool 化は 2b-2b）。
                tracing::warn!(
                    "LinkAudio channel '{name}' ignored: '{existing}' already registered \
                     (2b-2a supports a single channel)"
                );
            }
            return Ok(());
        }

        let ring_capacity = self.sample_rate as usize * self.num_channels * RING_SECONDS;
        let (sink, consumer, drops) = RingTapSink::new(ring_capacity);
        // consumer thread と callback の両方が所有する name を 1 回だけ確保する。
        let name = name.to_string();

        // 1) consumer thread へ（Link channel 登録 + egress 構築）。
        self.cmd_tx
            .send(RegisterCmd {
                name: name.clone(),
                consumer,
                drops,
                num_channels: self.num_channels,
                sample_rate: self.sample_rate,
            })
            .map_err(|_| LinkRegisterError::ConsumerGone)?;

        // 2) callback へ（sink + 事前確保 scratch）。
        let scratch = vec![0.0f32; MAX_BLOCK_FRAMES * self.num_channels];
        self.reg_tx
            .push(LinkChannelActivate {
                name: name.clone(),
                sink,
                scratch,
            })
            .map_err(|_| LinkRegisterError::RegRingFull)?;

        // 両経路への配線が成功 → 登録済みとして記録（以後の同名再登録は冪等 no-op）。
        self.registered_channel = Some(name);
        Ok(())
    }
}

// 層B(2b-2a Done 基準・実 callback 駆動)。実 output device + multicast loopback を要するため
// feature `link-audio-verification`(default off) + `#[ignore]`。local 実行:
//   cargo test -p orbit-audio-daemon --features link-audio-verification -- --ignored
#[cfg(all(test, feature = "link-audio-verification"))]
mod layer_b_tests {
    use crate::engine_wrap::EngineWrap;
    use orbit_link_audio::verification::VerificationReceiver;
    use orbit_link_audio::LinkAudioOutput;
    use std::path::PathBuf;
    use std::time::Duration;

    fn repo_path(rel: &str) -> PathBuf {
        PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
    }

    /// **実 cpal callback 駆動**の egress を、別 LinkAudio インスタンス(receiver)が headless 受信
    /// することを検証する。合成 ring feed(orbit-link-audio の層B が既証明)ではなく、本 sub-PR の
    /// 新規コード — `render_block`/`render_multi`(callback) + EngineWrap consumer 配線 — を end-to-end
    /// で通す唯一の経路:
    ///   EngineWrap::start()[実 cpal + GPL consumer thread] → register_link_audio_channel
    ///   → receiver 購読 → kick.wav を channel=loopD に tag して play_at
    ///   → **実 callback が render_multi で channel buffer を埋め RingTapSink へ push**
    ///   → consumer が drain して Link commit → receiver が受信。
    /// callback が headless で tick することは native の probe で実機確認済(stream が開くだけでなく
    /// render が回る)。device/multicast 不成立なら assert fail = その env では層B 不可の signal。
    #[test]
    #[ignore = "layer-B end-to-end: needs real output device + multicast loopback (local only)"]
    fn layer_b_real_callback_egress_received() {
        let (engine, _guard) = EngineWrap::start().expect("start engine with link egress");
        // 同名を 2 回登録（TS の eager + dispatch を模す）。冪等 guard が無いと 2 回目で callback の
        // 旧 activate が RT スレッド drop され ring 不整合で無音化する。2 回呼んでも egress が生きて
        // いることを下流の受信で確認する（C1 回帰）。
        engine
            .register_link_audio_channel("loopD")
            .expect("register channel (1st)");
        engine
            .register_link_audio_channel("loopD")
            .expect("register channel (2nd, idempotent)");

        // receiver: 独立した LinkAudio インスタンス。
        let recv_host = LinkAudioOutput::new(120.0, "orbit-recv").expect("recv host");
        recv_host.set_enabled(true);
        let recv = VerificationReceiver::new(&recv_host, "loopD");

        // discovery + subscribe(~5s)。
        let mut subscribed = false;
        for _ in 0..500 {
            if recv.try_subscribe() {
                subscribed = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            subscribed,
            "層B: receiver が channel を発見できなかった(この env では multicast loopback 不可)"
        );

        // kick.wav をロードして channel=loopD に tag して再生(少し先にスケジュール)。
        let sid = engine
            .load_sample(repo_path("test-assets/audio/kick.wav"))
            .expect("load kick.wav")
            .sample_id;
        let start_at = engine.now_sec().unwrap_or(0.0) + 0.2;
        engine
            .play_at(
                &sid,
                start_at,
                1.0,
                0.0,
                0.0,
                0.0,
                1.0,
                Some("loopD".into()),
            )
            .expect("play_at on channel");

        // 実 callback が render → ring → consumer → Link commit → receiver。最大 ~3s。
        let mut got = 0u64;
        for _ in 0..600 {
            got = recv.count();
            if got > 0 && recv.last_sample() != 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            got > 0,
            "層B: receiver が実 callback 駆動 egress を受信しなかった"
        );
        assert!(
            recv.last_sample() != 0,
            "層B: 受信サンプルが無音(channel routing が効いていない可能性)"
        );
    }
}
