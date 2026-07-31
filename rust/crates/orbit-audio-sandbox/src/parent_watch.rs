//! orphan child 対策(Issue #448): child プロセスの親死活監視。
//!
//! host(daemon)が `CONTROL_QUIT` を書かずに死ぬ経路(プロセス exit・SIGKILL・crash)では、
//! 4 つの child バイナリ(orbit-clap-effect-child / orbit-clap-instrument-child /
//! orbit-vst3-effect-child / orbit-vst3-instrument-child)は `seq_request` 待ちの spin loop に
//! 残り続け、CPU を専有し続ける(shm 側の CONTROL_QUIT に依存する既存の終了経路は host 側の
//! Drop 実行が前提のため、host が Drop を経ずに死ぬとこの経路が発火しない)。
//!
//! [`ParentWatch`] は起動時に `getppid()` を記録し、低頻度(既定 250ms)でこれを再取得する。
//! 親が死んで child が launchd/PID1 等に reparent されると `getppid()` の値が変わるので、
//! それを検知して spin loop から抜けるための helper。RT 影響を避けるため、チェックは
//! 「spin loop を回った回数」でなく「経過時間」で rate-limit する(system call 1 回 / 250ms 程度)。
//!
//! 4 crate(orbit-clap-effect-child 等)で同じロジックを重複させないための共有 helper。
//! transport とは独立した薄いモジュール(既存の「child main はミラー」方針と両立)。

#![allow(unsafe_code)]

use std::cell::Cell;
use std::time::{Duration, Instant};

/// [`ParentWatch::should_exit`] のデフォルト rate-limit 間隔。
pub const DEFAULT_CHECK_INTERVAL: Duration = Duration::from_millis(250);

/// child プロセスが起動時の親 PID を記録し、reparent(親死亡)を低頻度で検知する状態機械。
pub struct ParentWatch {
    original_ppid: libc::pid_t,
    check_interval: Duration,
    last_check: Cell<Instant>,
}

impl ParentWatch {
    /// 現在の `getppid()` を起動時の親 PID として記録する。既定の rate-limit 間隔
    /// ([`DEFAULT_CHECK_INTERVAL`])を使う。
    pub fn new() -> Self {
        Self::with_interval(DEFAULT_CHECK_INTERVAL)
    }

    /// rate-limit 間隔を明示指定するコンストラクタ(主にテスト用)。
    pub fn with_interval(check_interval: Duration) -> Self {
        // SAFETY: getppid(2) は引数を取らず常に成功する(POSIX)。
        let original_ppid = unsafe { libc::getppid() };
        Self {
            original_ppid,
            check_interval,
            last_check: Cell::new(Instant::now()),
        }
    }

    /// 常に「親は死んだ」と報告する watch を作る(**テスト支援専用**)。
    ///
    /// [`should_exit`](Self::should_exit) は起動時に記録した `getppid()` との差で判定するため、
    /// **プロセス内では本物の孤児化を演出できない**。ありえない pid を記録することで
    /// 「親が死んだ」分岐を到達可能にする。
    ///
    /// 🔴 用途は**配線の検証**である。`child_should_quit` が本物の [`ParentWatch`] を
    /// 参照していることを縛るテストが、これを使って合成箇所を通る
    /// (`orbit-child-runtime` の `child_should_quit_consults_the_injected_parent_watch`)。
    /// 純関数にクロージャを注入するテストでは、その合成は検証できない。
    pub fn orphaned_for_tests() -> Self {
        Self {
            // getppid(2) は POSIX 上ここには到達しない値を返さない。
            original_ppid: -1,
            check_interval: Duration::ZERO,
            last_check: Cell::new(Instant::now()),
        }
    }

    /// 親が死んで(= 現在の `getppid()` が起動時と異なる場合)true を返す。
    ///
    /// rate-limit: 前回チェックから `check_interval` 未満なら syscall を発行せず false を返す
    /// (spin loop 内で毎回呼んでも system call 頻度は interval に収まる)。
    pub fn should_exit(&self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.last_check.get()) < self.check_interval {
            return false;
        }
        self.last_check.set(now);
        // SAFETY: 同上。
        let current_ppid = unsafe { libc::getppid() };
        current_ppid != self.original_ppid
    }
}

impl Default for ParentWatch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn does_not_fire_while_ppid_unchanged() {
        let watch = ParentWatch::with_interval(Duration::from_millis(1));
        thread::sleep(Duration::from_millis(5));
        // このテストプロセスの親(テストランナー)は生きているので発火しないはず。
        assert!(!watch.should_exit());
    }

    #[test]
    fn rate_limits_syscall_checks() {
        let watch = ParentWatch::with_interval(Duration::from_secs(10));
        // 間隔未満の連続呼び出しは syscall を発行せず false を返し続ける
        // (ppid が変わっていたとしても検知しないのが rate-limit の定義)。
        for _ in 0..1000 {
            assert!(!watch.should_exit());
        }
    }

    #[test]
    fn fires_after_ppid_changes() {
        // 実プロセスの reparent を起こさずに、`original_ppid` を意図的に不一致な値へ
        // 差し替えることで「ppid が変わったら true を返す」分岐を検証する
        // (実プロセスの reparent 経路は orbit-audio-sandbox の統合テストで実証する)。
        let mut watch = ParentWatch::with_interval(Duration::from_millis(1));
        watch.original_ppid = -1; // 現実には取り得ない pid
        thread::sleep(Duration::from_millis(5));
        assert!(watch.should_exit());
    }
}
