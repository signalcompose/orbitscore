//! orbit-link-audio — Ableton LinkAudio egress の GPL 隔離 FFI ラッパ。
//!
//! 🔴 この crate は GPL(Ableton Link)を呼ぶ唯一の Rust 面。permissive な engine
//!    core(orbit-audio-core / -native / -wasm)からは決して依存させない。daemon が
//!    feature `link-audio`(default off)経由でのみ optional に取り込む。
//!
//! 設計境界(PR2b で配線): permissive↔GPL の物理境界は rtrb リング。RT render
//! (permissive)が per-channel post-mix を push し、この crate を保持する GPL
//! consumer thread が drain して [`LinkAudioOutput::commit_channel`] を呼ぶ。
//! その consumer thread が LinkAudio の "audio thread" として振る舞う。
//!
//! PR2a の射程: build + FFI safety + 隔離境界 + cargo-deny。実 audio egress の
//! 検証は PR2b(層A offline)/ tempo lead は PR3。

use std::ffi::{CString, NulError};
use std::os::raw::{c_char, c_int};
use std::sync::Arc;

mod egress;
pub use egress::LinkChannelEgress;

/// 層B 検証専用の channel receiver。feature `verification-receiver`（default off）でのみ公開。
/// production egress は sender-only なので出荷経路には出さない。
#[cfg(feature = "verification-receiver")]
pub mod verification;

#[repr(C)]
struct OrbitLinkRaw {
    _private: [u8; 0],
}

extern "C" {
    fn orbit_link_create(bpm: f64, peer_name: *const c_char) -> *mut OrbitLinkRaw;
    fn orbit_link_destroy(link: *mut OrbitLinkRaw);
    fn orbit_link_enable(link: *mut OrbitLinkRaw, enable: c_int);
    fn orbit_link_num_peers(link: *mut OrbitLinkRaw) -> usize;
    fn orbit_link_register_channel(
        link: *mut OrbitLinkRaw,
        name: *const c_char,
        max_num_samples: usize,
    ) -> i32;
    fn orbit_link_commit_channel(
        link: *mut OrbitLinkRaw,
        channel_id: i32,
        interleaved: *const f32,
        buf_len: usize,
        num_frames: usize,
        num_channels: usize,
        sample_rate: u32,
        beats_at_begin: f64,
        quantum: f64,
    ) -> c_int;
    fn orbit_link_set_tempo(link: *mut OrbitLinkRaw, bpm: f64);
    fn orbit_link_capture_beat(link: *mut OrbitLinkRaw, quantum: f64) -> f64;
    fn orbit_link_session_tempo(link: *mut OrbitLinkRaw) -> f64;
}

/// LinkAudio FFI のエラー。
#[derive(Debug, thiserror::Error)]
pub enum LinkAudioError {
    #[error("LinkAudio セッションの生成に失敗した")]
    CreateFailed,
    #[error("channel '{0}' の登録に失敗した")]
    RegisterFailed(String),
    #[error("文字列に内部 null が含まれる")]
    InvalidString(#[from] NulError),
    #[error("egress consumer thread の起動に失敗した: {0}")]
    ThreadSpawn(String),
}

/// commit_channel の結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitResult {
    /// commit 済(購読者あり)。
    Committed,
    /// 購読者(Live peer)なしで no-op。
    NoSubscriber,
    /// channel id が未登録(範囲外)または引数不正。
    ChannelNotFound,
    /// 購読者ありだが commit に失敗(Link が拒否 or egress 中に例外)。
    CommitFailed,
}

/// 1 つの Ableton Link セッションと、その上の名前付き出力 channel 群。
///
/// `Send + Sync`: PR3 以降 `Arc<LinkAudioOutput>` を control スレッド(tempo push)と
/// consumer=audio スレッド(egress)で共有する。Link の thread モデルに従い app-state
/// path と audio-state path を disjoint なスレッドから呼ぶ(下の `unsafe impl` 参照)。
pub struct LinkAudioOutput {
    raw: *mut OrbitLinkRaw,
}

// SAFETY (Send): 構築スレッドから GPL consumer thread へ move して使う。
// SAFETY (Sync): PR3 で `Arc<LinkAudioOutput>` を control スレッドと consumer=audio
// スレッドで共有する。アクセスは Ableton Link の thread モデルに従い disjoint:
//   - app-state path (`set_tempo` = captureAppSessionState・内部 mutex) は control
//     スレッド(spawn_blocking)から・[`LinkTempoControl`] 経由のみ。
//   - audio-state path (`commit_channel` / `capture_beat` / `session_tempo` =
//     captureAudioSessionState・単一 audio スレッド専用) は consumer スレッドから。
// 両 path は別スレッドから呼ばれ Link が内部で同期する。control 側は
// [`LinkTempoControl`] newtype で audio-state メソッドに型レベルで到達できない
// (`set_tempo` は `pub(crate)`・newtype のみが委譲呼び出しする)。
unsafe impl Send for LinkAudioOutput {}
unsafe impl Sync for LinkAudioOutput {}

impl LinkAudioOutput {
    /// 指定 BPM と peer 名で Link セッションを生成する。
    /// この時点ではネットワーク discovery は無効(`set_enabled` で有効化)。
    pub fn new(bpm: f64, peer_name: &str) -> Result<Self, LinkAudioError> {
        let peer = CString::new(peer_name)?;
        // SAFETY: peer は呼び出し中 valid な C 文字列。
        let raw = unsafe { orbit_link_create(bpm, peer.as_ptr()) };
        if raw.is_null() {
            return Err(LinkAudioError::CreateFailed);
        }
        Ok(Self { raw })
    }

    /// LinkAudio とネットワーク discovery を有効/無効化する。
    pub fn set_enabled(&self, enabled: bool) {
        // SAFETY: raw は valid(コンストラクタで non-null を保証)。
        unsafe { orbit_link_enable(self.raw, c_int::from(enabled)) };
    }

    /// 現在の Link peer 数。
    pub fn num_peers(&self) -> usize {
        // SAFETY: 同上。
        unsafe { orbit_link_num_peers(self.raw) }
    }

    /// 名前付き channel を登録し、channel id を返す。
    pub fn register_channel(
        &self,
        name: &str,
        max_num_samples: usize,
    ) -> Result<i32, LinkAudioError> {
        let cname = CString::new(name)?;
        // SAFETY: cname は呼び出し中 valid。
        let id = unsafe { orbit_link_register_channel(self.raw, cname.as_ptr(), max_num_samples) };
        if id < 0 {
            return Err(LinkAudioError::RegisterFailed(name.to_string()));
        }
        Ok(id)
    }

    /// interleaved f32 の 1 ブロックを channel に commit する。`beats_at_begin` は呼び出し側
    /// (GPL consumer thread)が cumulative-frames から決定論再構成した buffer-begin の beat 位置
    /// (ring latency 分の位相ずれを避けるため shim 内では "now" から計算しない・A4-2b-2)。
    #[allow(clippy::too_many_arguments)]
    pub fn commit_channel(
        &self,
        channel_id: i32,
        interleaved: &[f32],
        num_frames: usize,
        num_channels: usize,
        sample_rate: u32,
        beats_at_begin: f64,
        quantum: f64,
    ) -> CommitResult {
        debug_assert!(
            interleaved.len() >= num_frames.saturating_mul(num_channels),
            "commit_channel: interleaved.len()={} < num_frames*num_channels={}",
            interleaved.len(),
            num_frames.saturating_mul(num_channels)
        );
        // SAFETY: interleaved.as_ptr() は interleaved.len() 分 valid。buf_len として
        // len を渡し、shim は min(num_frames*num_channels, buf_len, 宛先容量)までしか
        // 読まないので overread しない。
        let rc = unsafe {
            orbit_link_commit_channel(
                self.raw,
                channel_id,
                interleaved.as_ptr(),
                interleaved.len(),
                num_frames,
                num_channels,
                sample_rate,
                beats_at_begin,
                quantum,
            )
        };
        match rc {
            1 => CommitResult::Committed,
            0 => CommitResult::NoSubscriber,
            -1 => CommitResult::ChannelNotFound,
            -2 => CommitResult::CommitFailed,
            other => {
                // ABI は本 crate 専有。未知の sentinel は契約違反 → debug で検出し、
                // release では安全側(ChannelNotFound)に倒す(RT consumer thread で panic させない)。
                debug_assert!(false, "orbit_link_commit_channel: unknown sentinel {other}");
                CommitResult::ChannelNotFound
            }
        }
    }

    /// Link テンポリーダーとして BPM を push する。内部で `captureAppSessionState`
    /// (非RT・block しうる)を呼ぶので audio スレッド以外から呼ぶこと。control 側は
    /// [`LinkTempoControl`] 経由でのみ到達する(`pub(crate)`)。
    pub(crate) fn set_tempo(&self, bpm: f64) {
        // SAFETY: raw は valid。
        unsafe { orbit_link_set_tempo(self.raw, bpm) };
    }

    /// egress 開始時の beat anchor を取得する(quantum 指定)。GPL consumer thread
    /// (= Link "audio thread")から 1 回だけ呼ぶ。以後は cumulative-frames から線形再構成する。
    pub fn capture_beat(&self, quantum: f64) -> f64 {
        // SAFETY: raw は valid。
        unsafe { orbit_link_capture_beat(self.raw, quantum) }
    }

    /// 現在の session tempo(BPM)。beat/frame 換算(beat_per_frame = (bpm/60)/sr)用。
    pub fn session_tempo(&self) -> f64 {
        // SAFETY: raw は valid。
        unsafe { orbit_link_session_tempo(self.raw) }
    }
}

impl Drop for LinkAudioOutput {
    fn drop(&mut self) {
        // SAFETY: raw は valid で、本 struct が唯一の所有者。`Arc<LinkAudioOutput>` で
        // 共有しても drop は最後の Arc が落ちた時に 1 回だけ走る(二重解放はしない)。
        // `orbit_link_destroy` は app-side cleanup(enable(false)+delete)で audio スレッド
        // 要件が無いため、最後の Arc が consumer 以外のスレッドで落ちても安全(PR3・advisor)。
        unsafe { orbit_link_destroy(self.raw) };
    }
}

/// Link tempo leader の control-side ハンドル(PR3・論点1 案A + newtype)。
///
/// `set_tempo` だけを公開し、audio-state メソッド(commit / capture_beat / session_tempo)を
/// 型レベルで隠蔽する。daemon の control スレッド(WS handler を spawn_blocking で隔離)が
/// 保持し、consumer=audio スレッドが持つ `Arc<LinkAudioOutput>` と同一 Link セッションを
/// 共有する。これにより control から audio-state path を誤って呼べない(thread role の
/// disjoint 性を型で担保する)。
pub struct LinkTempoControl {
    output: Arc<LinkAudioOutput>,
}

impl LinkTempoControl {
    /// consumer と同一 session を指す `Arc` から control ハンドルを作る。
    pub fn new(output: Arc<LinkAudioOutput>) -> Self {
        Self { output }
    }

    /// Link セッションに BPM を push し OrbitScore を tempo leader にする。
    /// `captureAppSessionState`(非RT・block しうる)を内部で呼ぶので、呼び出し側は
    /// audio スレッド以外(spawn_blocking 等)で実行すること。
    pub fn set_tempo(&self, bpm: f64) {
        self.output.set_tempo(bpm);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // FFI safety smoke test: 構築→channel 登録→silence commit(no-op)→tempo→teardown。
    // ネットワークは有効化しない(CI 決定論のため・discovery thread を起こさない)。
    // 実 egress 検証は PR2b(層A)/層B。
    #[test]
    fn ffi_smoke_construct_register_commit_silence() {
        let out = LinkAudioOutput::new(120.0, "orbit-test").expect("create");
        assert_eq!(out.num_peers(), 0);

        let id = out
            .register_channel("orbit-ch1", 4096)
            .expect("register ch1");
        assert_eq!(id, 0);
        let id2 = out
            .register_channel("orbit-ch2", 4096)
            .expect("register ch2");
        assert_eq!(id2, 1);

        // 購読者なしなので no-op を期待。symbol が呼べることの証明。
        // 引数 = (channel_id, interleaved, num_frames, num_channels, sample_rate, beats_at_begin, quantum)。
        let silence = vec![0.0f32; 256 * 2];
        let rc = out.commit_channel(id, &silence, 256, 2, 48_000, 0.0, 4.0);
        assert_eq!(rc, CommitResult::NoSubscriber);

        // 未登録の channel id。
        let rc_bad = out.commit_channel(99, &silence, 256, 2, 48_000, 0.0, 4.0);
        assert_eq!(rc_bad, CommitResult::ChannelNotFound);

        out.set_tempo(124.0);
        // drop で teardown。
    }

    #[test]
    fn register_rejects_interior_nul() {
        let out = LinkAudioOutput::new(120.0, "orbit-test").expect("create");
        let err = out.register_channel("bad\0name", 4096).unwrap_err();
        assert!(matches!(err, LinkAudioError::InvalidString(_)));
    }

    #[test]
    fn new_rejects_interior_nul_in_peer_name() {
        // LinkAudioOutput は Debug を持たないため unwrap_err ではなく matches! で判定。
        let result = LinkAudioOutput::new(120.0, "bad\0peer");
        assert!(matches!(result, Err(LinkAudioError::InvalidString(_))));
    }

    // ===== 層B: headless egress 受信検証(verification 専用 receiver shim 経由)=====

    // 層B(2b-2a Done 基準): 同一プロセスに A=sender egress / B=receiver の 2 LinkAudio インスタンス
    // を立て、`LinkChannelEgress` 経由の **実 commit** を B が headless 受信できることを検証する。
    // multicast loopback 依存(CI/sandbox では不安定・Ableton/link #50)なので #[ignore]。local で
    // `cargo test -p orbit-link-audio --features verification-receiver -- --ignored` 実行。discovery
    // 不成立(multicast off)なら assert で fail = その env では 層B 不可の signal(手動 fallback 報告へ)。
    // receiver は `verification` module(feature gate)に公開した単一ソースを使う(daemon の実 callback
    // 駆動 層B テストと共有・lib.rs に private 複製を置かない)。
    #[cfg(feature = "verification-receiver")]
    #[test]
    #[ignore = "layer-B: needs multicast loopback (local only); --features verification-receiver --ignored"]
    fn layer_b_egress_received_by_inprocess_receiver() {
        use crate::verification::VerificationReceiver;
        use std::sync::atomic::AtomicU64;
        use std::sync::Arc;
        use std::time::Duration;

        let sender = LinkAudioOutput::new(120.0, "orbit-A-egress").expect("sender");
        sender.set_enabled(true);
        let ch = sender.register_channel("loopB", 8192).expect("register");

        let recv_host = LinkAudioOutput::new(120.0, "orbit-B-recv").expect("recv host");
        recv_host.set_enabled(true);
        let recv = VerificationReceiver::new(&recv_host, "loopB");

        // discovery: receiver が channel を発見するまで(~3s)。
        let mut subscribed = false;
        for _ in 0..300 {
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

        // ring + egress on sender（egress は output を所有せず・pump_once に &sender を渡す）。
        let (mut prod, cons) = rtrb::RingBuffer::<f32>::new(48_000 * 2);
        let drops = Arc::new(AtomicU64::new(0));
        let mut egress = LinkChannelEgress::new(cons, drops, ch, 2, 48_000, 4.0, 256);

        // 既知サンプル(0.2)を feed + pump、receiver が受け取るまで(~2s)。
        let mut got = 0u64;
        for _ in 0..400 {
            let block = vec![0.2f32; 256 * 2];
            let _ = prod.push_partial_slice(&block);
            let _ = egress.pump_once(&sender, sender.session_tempo());
            got = recv.count();
            if got > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            got > 0,
            "層B: receiver が実 egress から buffer を受信しなかった"
        );
        // 0.2 → int16 ≈ 6553。非ゼロ = 実音が届いた(無音でない)。
        assert!(recv.last_sample() != 0, "層B: 受信サンプルが無音");
    }
}
