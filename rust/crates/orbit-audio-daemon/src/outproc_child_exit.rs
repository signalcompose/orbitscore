//! child の early-exit の「事実」と「理由」を対で持つ共有型。
//!
//! **effect と instrument で共有する**（規則を 2 箇所に持つと片方だけ直し忘れる —
//! `outproc_child_exe` / `outproc_respawn_guard` と同じ理由・#548 がその形のバグだった）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// child の「初回 attach 中に死んだ」という**事実**と、その**理由**を対にして持つ。
///
/// 🔴 **2 つを別々のフィールドに分けない**（#629 レビュー）。事実だけ立てて理由を書き忘れる、
/// 次の試行のために事実だけ倒して理由が残る、といったズレが**書ける形**になっているのが問題で、
/// 実際 `child_early_exit` は spawn のたびに倒されるのに理由は倒されないままだった。
/// 公開するのは「両方倒す」[`Self::arm_for_new_attempt`] と「理由つきで立てる」
/// [`Self::record`] だけにして、片方だけ動かす書き方を**表現できなくする**。
///
/// 理由が要る背景: 「死んだ」だけでは **SIGKILL（資源圧で殺された）と child 自身のエラー終了を
/// 区別できない**（#622 が「次回発火時に取るべきデータ」として挙げていた欠落）。watchdog は
/// 既に `tracing::warn!` へ status を出しているが、**呼び出し元へ返る `WrapError` には
/// 乗っていなかった**ため、失敗を受け取った側からは理由が見えなかった。
///
/// 🔴 **RT スレッドからは触らないこと。** 書き手は watchdog スレッド、読み手は control
/// スレッドのみで、どちらも非 RT である。`Mutex` を置けるのはそのためで、audio callback から
/// ロックしてはならない。RT が毎コールバック触る atomic 群と別のキャッシュラインへ置くため、
/// **フィールドは struct の末尾に置く**こと。
#[derive(Default)]
pub struct ChildEarlyExit {
    flagged: AtomicBool,
    reason: Mutex<Option<String>>,
}

impl ChildEarlyExit {
    /// spawn の直前に呼ぶ。**事実と理由の両方**を倒し、前の試行の残骸を持ち越さない。
    pub fn arm_for_new_attempt(&self) {
        *self.lock_reason() = None;
        self.flagged.store(false, Ordering::Release);
    }

    /// watchdog が early exit を検知した時に呼ぶ。**理由を先に書いてから事実を立てる**ので、
    /// 読み手が `fired()` を観測した時点で理由は必ず今回のものになっている。
    pub fn record(&self, status: impl std::fmt::Display) {
        *self.lock_reason() = Some(status.to_string());
        self.flagged.store(true, Ordering::Release);
    }

    pub fn fired(&self) -> bool {
        self.flagged.load(Ordering::Acquire)
    }

    /// [`Self::fired`] が true の時にだけ意味がある。
    pub fn reason(&self) -> Option<String> {
        self.lock_reason().clone()
    }

    /// ポイズニング時はログを残してから回復する（`lock_child_slot_recovering` と同じ流儀）。
    fn lock_reason(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.reason.lock().unwrap_or_else(|poisoned| {
            tracing::error!("child early-exit reason mutex poisoned; recovering");
            poisoned.into_inner()
        })
    }
}
