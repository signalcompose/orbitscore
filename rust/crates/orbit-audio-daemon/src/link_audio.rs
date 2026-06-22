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
//! A4-2b-2b で **N-channel** 化: callback は channel pool（`MAX_LINK_CHANNELS` 上限・control 強制）を
//! 持ち、consumer thread は 1 つの `LinkAudioOutput` 上の複数 `LinkChannelEgress` を回す。**readiness
//! flag**（per-channel `Arc<AtomicBool>`）で「consumer が Link 登録する前に callback が push する never-
//! drained ring」を構造的に排除する（consumer が登録完了で ready を立て、callback は ready の channel
//! のみ egress する）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use orbit_audio_native::{LinkChannelActivate, RingTapSink, MAX_LINK_CHANNELS};
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
/// reg-ring 容量（callback への activation メッセージ）。起動時に全 channel が callback の drain より
/// 先にまとめて登録されうるので [`MAX_LINK_CHANNELS`] 分を確保する（cap も同値で control が強制）。
/// EngineWrap が `start_default_output_with_link_egress` に渡すため pub（const 文脈で使える）。
pub const REG_RING_CAPACITY: usize = MAX_LINK_CHANNELS;

/// control→consumer thread の registration コマンド（mpsc payload）。consumer thread が受け取って
/// Link channel を登録し [`LinkChannelEgress`] を構築する。
struct RegisterCmd {
    name: String,
    consumer: rtrb::Consumer<f32>,
    drops: Arc<AtomicU64>,
    /// callback と共有する readiness flag。consumer が Link 登録 + egress 構築を終えたら `true` にし、
    /// callback がこの channel の egress を開始してよいことを伝える（never-drained-ring 回避）。
    ready: Arc<AtomicBool>,
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
    #[error("link channel limit reached (max {0})")]
    ChannelLimit(usize),
}

/// `register_channel` の判定結果（A4-2b-2b）。RT に触れない pure ロジックを分離して CI で検証する。
#[derive(Debug, PartialEq, Eq)]
enum RegistrationDecision {
    /// 同名が既に登録済み → 冪等 no-op（再 push すると callback で旧 activate が RT スレッド drop）。
    Idempotent,
    /// 登録数が cap に到達 → runtime error で surface（callback で log しないための control 側 gate）。
    AtCapacity,
    /// 新規 channel → 配線する。
    New,
}

/// 登録済み集合・登録名・cap から [`RegistrationDecision`] を返す pure 関数。
fn registration_decision<V>(
    registered: &HashMap<String, V>,
    name: &str,
    max: usize,
) -> RegistrationDecision {
    if registered.contains_key(name) {
        RegistrationDecision::Idempotent
    } else if registered.len() >= max {
        RegistrationDecision::AtCapacity
    } else {
        RegistrationDecision::New
    }
}

/// consumer thread が回す 1 channel の状態（egress driver + per-channel な commit 失敗 streak）。
/// streak を per-channel に持つことで、ある channel の成功が別 channel の失敗 streak を reset して
/// health warn を masking するのを防ぐ（N-channel・A4-2b-2b）。
struct ActiveChannel {
    /// channel 名（health warn を operator 向けに名前で出すため。数値 id より読みやすい）。
    name: String,
    egress: LinkChannelEgress,
    commit_fail_streak: u64,
}

/// GPL consumer thread の本体。`shutdown` が立つまでループし、registration を処理しつつ全 channel の
/// egress を pump する。**teardown は drop 順ではなく明示 signal+join**（A0 §13 教訓）: 戻ると
/// `channels` と `output` がこの thread 上で drop され `LinkAudioOutput::drop`→Link teardown が走る。
fn consumer_loop(
    output: LinkAudioOutput,
    cmd_rx: mpsc::Receiver<RegisterCmd>,
    shutdown: Arc<AtomicBool>,
) {
    // この thread が 1 つの LinkAudioOutput（Link session）を所有し、その上の複数 channel を
    // それぞれ [`ActiveChannel`] で回す（N-channel・A4-2b-2b）。**commit 失敗 streak は per-channel**
    // （channel-global にすると、ある channel の成功が別 channel の失敗 streak を reset して masking する）。
    let mut channels: Vec<ActiveChannel> = Vec::with_capacity(MAX_LINK_CHANNELS);
    while !shutdown.load(Ordering::Relaxed) {
        // 1. registration を drain → 各 channel を Link 登録して egress を構築し、**ready flag を立てて
        //    callback の egress 開始を許可**する。登録失敗なら ready は false のまま（callback は push
        //    しない＝never-drained-ring 回避）で error を surface する。
        while let Ok(cmd) = cmd_rx.try_recv() {
            let max_num_samples = BLOCK_FRAMES * cmd.num_channels;
            match output.register_channel(&cmd.name, max_num_samples) {
                Ok(id) => {
                    channels.push(ActiveChannel {
                        name: cmd.name,
                        egress: LinkChannelEgress::new(
                            cmd.consumer,
                            cmd.drops,
                            id,
                            cmd.num_channels,
                            cmd.sample_rate,
                            QUANTUM,
                            BLOCK_FRAMES,
                        ),
                        commit_fail_streak: 0,
                    });
                    // ★ ここで初めて callback がこの channel を render_multi / commit 対象にする。
                    cmd.ready.store(true, Ordering::Relaxed);
                }
                Err(e) => {
                    // 登録失敗（稀）。ready は false のまま → callback は push しないので doomed ring に
                    // ならない。silent でなく error で surface（この channel の egress は出ない）。
                    tracing::error!(
                        "LinkAudio channel '{}' register failed: {e} — egress will be silent",
                        cmd.name
                    );
                }
            }
        }

        // 2. 全 channel を pump（共有 output を & で渡す）。1 つでも commit したら sleep しない。
        let mut pumped = false;
        for ch in channels.iter_mut() {
            while let Some(rc) = ch.egress.pump_once(&output) {
                pumped = true;
                match rc {
                    // NoSubscriber は Live 未参加の通常状態（silent）。回復で streak をリセット。
                    CommitResult::Committed | CommitResult::NoSubscriber => {
                        ch.commit_fail_streak = 0
                    }
                    // 購読者ありで commit 失敗 / channel 消失。音が Link に届かない health signal。
                    // streak は **per-channel**（他 channel の成功で masking されない）。
                    CommitResult::CommitFailed | CommitResult::ChannelNotFound => {
                        ch.commit_fail_streak += 1;
                        if ch.commit_fail_streak == 1 || ch.commit_fail_streak.is_multiple_of(1000)
                        {
                            tracing::warn!(
                                "LinkAudio commit failing on channel '{}' ({rc:?}, streak={}): \
                                 audio not reaching Link peer",
                                ch.name,
                                ch.commit_fail_streak
                            );
                        }
                    }
                }
            }
        }
        if !pumped {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    // ループ脱出 → channels + output がこの thread 上で drop → Link teardown。
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
    /// 登録済み channel（名前 → drop counter）。最大 [`MAX_LINK_CHANNELS`]・再登録の冪等化に使う。
    /// TS 層は `output()` 宣言時と dispatch で同名を複数回登録する設計なので、再 push を防がないと
    /// callback 側で古い `LinkChannelActivate`（ring producer）が **RT スレッド上で drop** され、
    /// かつ新 ring を誰も drain せず egress が無音化する。同名は no-op、新規は cap までで受理する。
    /// 値は当該 channel の RingTapSink が producer-side で drop した interleaved サンプル数（累積）の
    /// counter clone（producer=callback / consumer thread が別 clone を持つ・同一 Arc）。冪等判定と
    /// observability（[`Self::total_ring_drops`]）を 1 map に集約し channel↔counter の対応を保つ。
    registered: HashMap<String, Arc<AtomicU64>>,
}

impl LinkAudioControl {
    /// LinkAudio session を生成・enable し、GPL consumer thread を起動する。
    /// `reg_tx` は native `start_default_output_with_link_egress` が返す reg-ring producer。
    /// 返り値の [`LinkAudioGuard`] は `StreamGuard` に載せ、teardown まで保持する。
    ///
    /// consumer thread は callback が push を始める前に spawn される。channel は readiness flag が
    /// 立つまで callback が egress しないので、push の前後関係に依存せず安全（A4-2b-2b）。
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
            .spawn(move || consumer_loop(output, cmd_rx, shutdown_thread))
            .map_err(|e| LinkAudioError::ThreadSpawn(e.to_string()))?;

        Ok((
            Self {
                reg_tx,
                cmd_tx,
                sample_rate,
                num_channels,
                registered: HashMap::new(),
            },
            LinkAudioGuard {
                shutdown,
                handle: Some(handle),
            },
        ))
    }

    /// 全 channel の ring overflow drop（interleaved サンプル数）の合計。daemon の 1 Hz ticker が
    /// polling して増加を WARNING event として surface する（A4-2b-2b・LinkEgressStats）。
    pub fn total_ring_drops(&self) -> u64 {
        self.registered
            .values()
            .map(|d| d.load(Ordering::Relaxed))
            .sum()
    }

    /// 名前付き channel を登録する。`RingTapSink` と readiness flag を生成し、**sink+ready を callback
    /// へ / consumer side+ready を consumer thread へ**配る（A4-2b-2b・N-channel）。
    ///
    /// 冪等 guard（必須）: TS 層は `output()` 宣言時と dispatch で同名を複数回登録する設計なので、同名は
    /// no-op で返す（再 push すると callback 側で旧 activate が RT スレッド drop される）。新規 channel は
    /// cap（[`MAX_LINK_CHANNELS`]）まで受理する（**cap は control 側で error として surface**＝RT callback
    /// で log しない）。順序: consumer thread へ先に送り（Link 登録 + ready set）、その後 callback へ sink
    /// を渡す。readiness flag により、callback push と consumer 登録の前後関係に関わらず never-drained
    /// ring が起きない（ready 前は callback が push しない）。
    pub fn register_channel(&mut self, name: &str) -> Result<(), LinkRegisterError> {
        // 冪等（同名 no-op）+ cap（control 側強制）の判定。RT に触れない pure ロジックで CI 検証する。
        match registration_decision(&self.registered, name, MAX_LINK_CHANNELS) {
            RegistrationDecision::Idempotent => return Ok(()),
            RegistrationDecision::AtCapacity => {
                return Err(LinkRegisterError::ChannelLimit(MAX_LINK_CHANNELS))
            }
            RegistrationDecision::New => {}
        }

        let ring_capacity = self.sample_rate as usize * self.num_channels * RING_SECONDS;
        let (sink, consumer, drops) = RingTapSink::new(ring_capacity);
        // observability 用に drop counter の clone を control 側に残す（producer/consumer とは別 clone・
        // 配線成功後にのみ push する）。
        let drops_for_stats = drops.clone();
        // callback と consumer が共有する readiness flag（consumer が Link 登録後に true にする）。
        let ready = Arc::new(AtomicBool::new(false));
        // consumer thread と callback の両方が所有する name を 1 回だけ確保する。
        let name = name.to_string();

        // 1) consumer thread へ（Link channel 登録 + egress 構築 + ready set）。
        self.cmd_tx
            .send(RegisterCmd {
                name: name.clone(),
                consumer,
                drops,
                ready: ready.clone(),
                num_channels: self.num_channels,
                sample_rate: self.sample_rate,
            })
            .map_err(|_| LinkRegisterError::ConsumerGone)?;

        // 2) callback へ（sink + 事前確保 scratch + ready）。ready が立つまで callback は egress しない。
        let scratch = vec![0.0f32; MAX_BLOCK_FRAMES * self.num_channels];
        self.reg_tx
            .push(LinkChannelActivate {
                name: name.clone(),
                sink,
                scratch,
                ready,
            })
            .map_err(|_| LinkRegisterError::RegRingFull)?;

        // 両経路への配線が成功 → 登録済みとして記録（同名再登録は冪等 no-op）。value に drop counter
        // を保持して channel↔counter を 1 map で対応づける（observability・将来の per-channel breakdown）。
        self.registered.insert(name, drops_for_stats);
        Ok(())
    }
}

// register_channel の判定（冪等 / cap）の pure ロジック。device/multicast 不要なので gated でない
// （`cargo test -p orbit-audio-daemon --features link-audio` で実行）。
#[cfg(test)]
mod unit_tests {
    use super::{registration_decision, RegistrationDecision, MAX_LINK_CHANNELS};
    use std::collections::HashMap;

    // registered は `HashMap<name, drop counter>`。本テストは判定ロジックのみ見るので value は `()`。
    fn reg_with(names: &[&str]) -> HashMap<String, ()> {
        names.iter().map(|n| (n.to_string(), ())).collect()
    }

    #[test]
    fn registration_decision_idempotent_on_same_name() {
        let reg = reg_with(&["drums"]);
        assert_eq!(
            registration_decision(&reg, "drums", MAX_LINK_CHANNELS),
            RegistrationDecision::Idempotent
        );
    }

    #[test]
    fn registration_decision_new_for_unseen_name_under_cap() {
        let reg = reg_with(&[]);
        assert_eq!(
            registration_decision(&reg, "drums", MAX_LINK_CHANNELS),
            RegistrationDecision::New
        );
    }

    #[test]
    fn registration_decision_at_capacity_rejects_new_name() {
        // cap ちょうどの登録済み集合 → 新規名は AtCapacity。
        let reg: HashMap<String, ()> = (0..MAX_LINK_CHANNELS)
            .map(|i| (format!("ch{i}"), ()))
            .collect();
        assert_eq!(reg.len(), MAX_LINK_CHANNELS);
        assert_eq!(
            registration_decision(&reg, "overflow", MAX_LINK_CHANNELS),
            RegistrationDecision::AtCapacity
        );
        // ただし cap 到達後でも **既存名は冪等**（cap で弾かない）。
        assert_eq!(
            registration_decision(&reg, "ch0", MAX_LINK_CHANNELS),
            RegistrationDecision::Idempotent
        );
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

    /// 層B multi-channel（A4-2b-2b Done 基準）: **2 channel を同時登録**し、それぞれに tag した再生を
    /// **独立した 2 receiver** が両方受信することを検証する。N-channel pool（callback ArrayVec）+
    /// readiness flag + 共有 LinkAudioOutput 上の複数 egress + per-channel routing を end-to-end で通す。
    #[test]
    #[ignore = "layer-B multi: needs real output device + multicast loopback (local only)"]
    fn layer_b_multi_channel_egress_received() {
        let (engine, _guard) = EngineWrap::start().expect("start engine with link egress");
        engine
            .register_link_audio_channel("loopX")
            .expect("register loopX");
        engine
            .register_link_audio_channel("loopY")
            .expect("register loopY");

        let recv_host = LinkAudioOutput::new(120.0, "orbit-recv-multi").expect("recv host");
        recv_host.set_enabled(true);
        let recv_x = VerificationReceiver::new(&recv_host, "loopX");
        let recv_y = VerificationReceiver::new(&recv_host, "loopY");

        // 両 channel の discovery + subscribe(~5s)。
        let (mut sub_x, mut sub_y) = (false, false);
        for _ in 0..500 {
            sub_x = sub_x || recv_x.try_subscribe();
            sub_y = sub_y || recv_y.try_subscribe();
            if sub_x && sub_y {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            sub_x && sub_y,
            "層B multi: 両 receiver が channel を発見できなかった(sub_x={sub_x} sub_y={sub_y})"
        );

        // kick.wav を loopX / loopY 両方に tag して再生（同一 sample・別 channel へ独立 routing）。
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
                Some("loopX".into()),
            )
            .expect("play_at loopX");
        engine
            .play_at(
                &sid,
                start_at,
                1.0,
                0.0,
                0.0,
                0.0,
                1.0,
                Some("loopY".into()),
            )
            .expect("play_at loopY");

        // 両 channel の実 callback 駆動 egress を両 receiver が受信するまで(~3s)。
        let (mut gx, mut gy) = (0u64, 0u64);
        for _ in 0..600 {
            gx = recv_x.count();
            gy = recv_y.count();
            if gx > 0 && gy > 0 && recv_x.last_sample() != 0 && recv_y.last_sample() != 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            gx > 0 && recv_x.last_sample() != 0,
            "層B multi: loopX receiver が egress を受信しなかった(count={gx})"
        );
        assert!(
            gy > 0 && recv_y.last_sample() != 0,
            "層B multi: loopY receiver が egress を受信しなかった(count={gy})"
        );
    }
}
