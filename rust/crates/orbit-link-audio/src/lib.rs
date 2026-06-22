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
        num_frames: usize,
        num_channels: usize,
        sample_rate: u32,
        quantum: f64,
    ) -> c_int;
    fn orbit_link_set_tempo(link: *mut OrbitLinkRaw, bpm: f64);
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
}

/// commit_channel の結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitResult {
    /// commit 済(購読者あり)。
    Committed,
    /// 購読者(Live peer)なしで no-op。
    NoSubscriber,
    /// channel id が未登録(範囲外)。
    ChannelNotFound,
}

/// 1 つの Ableton Link セッションと、その上の名前付き出力 channel 群。
///
/// `Send`: 構築スレッドから GPL consumer thread へ move して使う想定。`!Sync`
/// (内部の Link 状態は単一スレッドからのみ触る)。
pub struct LinkAudioOutput {
    raw: *mut OrbitLinkRaw,
}

// SAFETY: `raw` は単一の所有者(本 struct)を通じてのみアクセスされ、構築後に
// consumer thread へ move される。複数スレッドからの同時アクセスは行わない。
unsafe impl Send for LinkAudioOutput {}

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

    /// interleaved f32 の 1 ブロックを channel に commit する。
    pub fn commit_channel(
        &self,
        channel_id: i32,
        interleaved: &[f32],
        num_frames: usize,
        num_channels: usize,
        sample_rate: u32,
        quantum: f64,
    ) -> CommitResult {
        // SAFETY: interleaved.as_ptr() は len 分 valid。shim 側は num_frames *
        // num_channels と bh.maxNumSamples の小さい方までしか読まない。
        let rc = unsafe {
            orbit_link_commit_channel(
                self.raw,
                channel_id,
                interleaved.as_ptr(),
                num_frames,
                num_channels,
                sample_rate,
                quantum,
            )
        };
        match rc {
            1 => CommitResult::Committed,
            0 => CommitResult::NoSubscriber,
            _ => CommitResult::ChannelNotFound,
        }
    }

    /// Link テンポリーダーとして BPM を push する(PR3 で配線)。
    pub fn set_tempo(&self, bpm: f64) {
        // SAFETY: raw は valid。
        unsafe { orbit_link_set_tempo(self.raw, bpm) };
    }
}

impl Drop for LinkAudioOutput {
    fn drop(&mut self) {
        // SAFETY: raw は valid で、本 struct が唯一の所有者。二重解放はしない。
        unsafe { orbit_link_destroy(self.raw) };
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
        let silence = vec![0.0f32; 256 * 2];
        let rc = out.commit_channel(id, &silence, 256, 2, 48_000, 4.0);
        assert_eq!(rc, CommitResult::NoSubscriber);

        // 未登録の channel id。
        let rc_bad = out.commit_channel(99, &silence, 256, 2, 48_000, 4.0);
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
}
