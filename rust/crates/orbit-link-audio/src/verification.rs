//! verification 専用の channel receiver（層B headless テスト用）。feature `verification-receiver`。
//!
//! 🔴 production egress は **sender-only**（spec §8.1）。本 module は出荷経路に出さない検証専用で、
//! 同一プロセスに 2 つの LinkAudio（sender egress / receiver）を立て、実 commit が受信されることを
//! headless で確認する層B テストを、本 crate と daemon crate の双方から駆動できるよう公開する。
//! shim 側の receiver シンボル（`orbit_link_recv_*`）は feature 非依存で常にリンクされる（C++ は
//! 出荷ビルドにも receiver が含まれる）。本 Rust ラッパだけを feature で gate する。

use std::ffi::CString;
use std::marker::PhantomData;
use std::os::raw::{c_char, c_int};

use crate::{LinkAudioOutput, OrbitLinkRaw};

#[repr(C)]
struct OrbitRecvRaw {
    _private: [u8; 0],
}

extern "C" {
    fn orbit_link_recv_create(
        host: *mut OrbitLinkRaw,
        channel_name: *const c_char,
    ) -> *mut OrbitRecvRaw;
    fn orbit_link_recv_try_subscribe(recv: *mut OrbitRecvRaw) -> c_int;
    fn orbit_link_recv_count(recv: *mut OrbitRecvRaw) -> u64;
    fn orbit_link_recv_last_sample(recv: *mut OrbitRecvRaw) -> c_int;
    fn orbit_link_recv_destroy(recv: *mut OrbitRecvRaw);
}

/// 別 LinkAudio インスタンス（host）上に channel receiver を張る検証専用 RAII wrapper。
///
/// C++ の `OrbitRecv` は host の raw ポインタを非所有で保持し `try_subscribe` 等で deref するため、
/// **host が receiver より長生きする必要がある**。`PhantomData<&'a LinkAudioOutput>` で host の borrow
/// を型に持たせ、host を receiver より先に drop すると **コンパイルエラー**になるよう強制する。
pub struct VerificationReceiver<'a> {
    raw: *mut OrbitRecvRaw,
    /// host の生存を receiver の lifetime に縛る（use-after-free をコンパイル時に排除）。
    _host: PhantomData<&'a LinkAudioOutput>,
}

impl<'a> VerificationReceiver<'a> {
    /// `host` 上に `channel` 名の receiver を作る。`host` は receiver 側の独立した LinkAudio。
    /// 返り値の lifetime `'a` が `host` の borrow に縛られるので、host を先に drop できない。
    pub fn new(host: &'a LinkAudioOutput, channel: &str) -> Self {
        let c = CString::new(channel).expect("channel name has interior nul");
        // SAFETY: host.raw は valid（LinkAudioOutput のコンストラクタで non-null 保証）、c は
        // 呼び出し中 valid な C 文字列。C++ OrbitRecv が保持する host ポインタの生存は `'a`
        // （PhantomData）でコンパイラが強制するので use-after-free しない。
        let raw = unsafe { orbit_link_recv_create(host.raw, c.as_ptr()) };
        assert!(!raw.is_null(), "orbit_link_recv_create returned null");
        Self {
            raw,
            _host: PhantomData,
        }
    }

    /// host が channel を発見していれば購読を試みる。購読確立で true。
    pub fn try_subscribe(&self) -> bool {
        // SAFETY: raw は valid（コンストラクタで non-null を assert）。
        unsafe { orbit_link_recv_try_subscribe(self.raw) == 1 }
    }

    /// これまでに受信した buffer コールバック数。
    pub fn count(&self) -> u64 {
        // SAFETY: 同上。
        unsafe { orbit_link_recv_count(self.raw) }
    }

    /// 直近に受信したサンプル値（int16）。無音なら 0。
    pub fn last_sample(&self) -> i32 {
        // SAFETY: 同上。
        unsafe { orbit_link_recv_last_sample(self.raw) }
    }
}

impl Drop for VerificationReceiver<'_> {
    fn drop(&mut self) {
        // SAFETY: raw は valid で本 struct が唯一の所有者。二重解放しない。
        unsafe { orbit_link_recv_destroy(self.raw) };
    }
}
