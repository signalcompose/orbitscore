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
/// 🔴 **RT スレッドからは触らないこと。** 触るのは以下の 2 スレッドだけで、どちらも非 RT:
///
/// - **watchdog スレッド**: [`Self::record`]（書き）
/// - **control スレッド**: [`Self::arm_for_new_attempt`]（**書き**）と
///   [`Self::fired`] / [`Self::reason`]（読み）
///
/// **control 側も書き手である**点に注意（#629 レビュー — 当初「読み手のみ」と書いていたが
/// 事実と違った）。両者が並行しないのは、次の試行の `arm_for_new_attempt` が必ず
/// supervisor の Drop による watchdog の `join()` の**後**に呼ばれるからで、この
/// happens-before は呼び出し側の構造が担保している。
///
/// `Mutex` を置けるのは非 RT だからで、audio callback からロックしてはならない。
///
/// 🔴 **キャッシュラインの分離は「宣言順」では得られない**（#629 レビューが実測で反証）。
/// この crate の stats struct は `repr(Rust)` なので、rustc はフィールドを自由に並べ替える —
/// 実際 `offset_of!` で測ると本型は struct の**先頭**（offset 0）に置かれ、RT が毎コールバック
/// 触る atomic と同じ 64 バイトに同居していた。分離を本当に要求するなら `#[repr(C)]` か
/// 明示的な `align` が要る。現状そこまでしないのは、`record` / `arm_for_new_attempt` が
/// **attach 試行ごとに高々 1 回**の非ホットパスで、継続的な false sharing にならないため。
#[derive(Default)]
pub struct ChildEarlyExit {
    flagged: AtomicBool,
    reason: Mutex<Option<String>>,
}

impl ChildEarlyExit {
    /// spawn の直前に呼ぶ。**事実と理由の両方**を倒し、前の試行の残骸を持ち越さない。
    pub fn arm_for_new_attempt(&self) {
        *self.lock_reason("arm_for_new_attempt") = None;
        self.flagged.store(false, Ordering::Release);
    }

    /// watchdog が early exit を検知した時に呼ぶ。**理由を先に書いてから事実を立てる**ので、
    /// 読み手が `fired()` を観測した時点で理由は必ず今回のものになっている。
    pub fn record(&self, status: impl std::fmt::Display) {
        *self.lock_reason("record") = Some(status.to_string());
        self.flagged.store(true, Ordering::Release);
    }

    pub fn fired(&self) -> bool {
        self.flagged.load(Ordering::Acquire)
    }

    /// [`Self::fired`] が true の時にだけ意味がある。
    pub fn reason(&self) -> Option<String> {
        self.lock_reason("reason").clone()
    }

    /// ポイズニング時はログを残してから回復する（`lock_child_slot_recovering` と同じ流儀）。
    ///
    /// `site` を取るのも兄弟に揃えるため（#629 レビュー）。ポイズニングは**それ自体が別の
    /// 重大なバグの兆候**なので、その稀な瞬間にこそ「どの操作中だったか」が要る。
    fn lock_reason(&self, site: &'static str) -> std::sync::MutexGuard<'_, Option<String>> {
        self.reason.lock().unwrap_or_else(|poisoned| {
            tracing::error!("child early-exit reason mutex poisoned during {site}; recovering");
            poisoned.into_inner()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::ChildEarlyExit;

    #[test]
    fn default_is_neither_fired_nor_reasoned() {
        let exit = ChildEarlyExit::default();
        assert!(!exit.fired());
        assert_eq!(exit.reason(), None);
    }

    #[test]
    fn record_publishes_both_the_fact_and_the_reason() {
        let exit = ChildEarlyExit::default();
        exit.record("exit status: 1");
        assert!(exit.fired());
        assert_eq!(exit.reason().as_deref(), Some("exit status: 1"));
    }

    /// 🔴 この型が存在する理由そのものを固定する（#629 レビュー Critical）。
    ///
    /// 元の欠陥は「事実は spawn のたびに倒されるのに、**理由は倒されない**」ことだった。
    /// 型に畳んだだけでは、`arm_for_new_attempt` の**実装**が両方倒すことは守られない —
    /// 実際、既存の attach テストは試行を 1 回しか行わないので、理由を倒さない実装へ
    /// 退行させても全件 green のまま通ってしまう。ここが唯一その退行を殺す。
    #[test]
    fn arming_a_new_attempt_drops_the_previous_reason() {
        let exit = ChildEarlyExit::default();
        exit.record("exit status: 1");

        exit.arm_for_new_attempt();

        assert!(
            !exit.fired(),
            "the fact must be cleared for the new attempt"
        );
        assert_eq!(
            exit.reason(),
            None,
            "the previous attempt's reason must not survive into the next one — a stale reason \
             would be attached to a different failure (#622 / #629)"
        );

        exit.record("signal: 9 (SIGKILL)");
        assert_eq!(
            exit.reason().as_deref(),
            Some("signal: 9 (SIGKILL)"),
            "the new attempt reports its own reason"
        );
    }
}
