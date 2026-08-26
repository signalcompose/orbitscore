//! 子プロセス側 stderr の **level トークン規約**（#618 / #625）。
//!
//! # なぜこれが必要か
//!
//! child プロセスは daemon の stderr を継承し、tracing を持たない（依存を足していない）。
//! daemon の stderr は拡張側の router
//! （`packages/engine/src/audio/rust-engine/daemon-client.ts` の
//! `isDaemonNonErrorTracingLine`）へ流れ、**level を名乗らない行は fail-loud で `ERROR:` に
//! 倒れる**。これは本物の失敗を握り潰さないための正しい既定である。
//!
//! 問題は、**正常系で必ず出る通知**（「この引数はこのフェーズでは未使用」「controller への
//! 同期は best-effort で失敗したが音声側の state は適用済み」等）がその既定に巻き込まれることだ。
//! 巻き込まれると:
//!
//! - `get_log` の ERROR 件数を根拠にする診断が**偽陽性**になる
//! - **LLM の自己検証経路が壊れる**（本プロジェクトは LLM を第一級ユーザーとして設計している）
//! - 本物のエラーがノイズに埋もれる
//!
//! # なぜ「各所で手書き」ではだめか
//!
//! 🔴 **この規約はすでに 2 回、同じ障害を起こしている。**
//! #618 で instrument 側に手当てしたが effect 側は取り残され、#625 の実機 E2E で
//! 「VST3 effect をロードするたび / state を復元するたびに ERROR」が発覚した。
//! 手書きの前置は、**新しい child crate が増えるたびに 3 回目の再発を待っている**状態になる
//! （CLAP 側の child はまだこの規約を使っていない）。
//!
//! そこで**文字列の形そのものをここで組み立てる**。呼び出し側は level とタグを選ぶだけでよく、
//! `INFO` の後ろのスペースやタグの括弧を手で間違える余地が無い。
//!
//! # TS 側の受理条件（この関数が満たすべき契約）
//!
//! ```text
//! /^\s*(TRACE|DEBUG|INFO)\s+\[orbit-[a-z0-9-]+\]\s/
//! ```
//!
//! すなわち **(1) 非エラーの level トークン (2) 自分のコンポーネントのタグ** の 2 点。
//! `WARN` / `ERROR` は意図的にここに無い — それらは error 側へ倒れるのが正しいので、
//! 素の `eprintln!` を使う。

use std::fmt::Display;

/// 非エラーとして転送される level。`WARN`/`ERROR` は**意図的に無い**（error 側が正しいため）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeLevel {
    Trace,
    Debug,
    Info,
}

impl NoticeLevel {
    fn token(self) -> &'static str {
        match self {
            NoticeLevel::Trace => "TRACE",
            NoticeLevel::Debug => "DEBUG",
            NoticeLevel::Info => "INFO",
        }
    }
}

/// 正常系の通知 1 行を、TS 側 router が非エラーと判定できる形で組み立てる。
///
/// `tag` は `orbit-` で始まるコンポーネント名（例: `orbit-vst3-effect-child`・
/// `orbit-vst3-host`）。**host crate は child プロセスの中にリンクされて動く**ので、
/// タグが `-child` で終わらなくてよい（#625: 終端を要求していたため host の通知が
/// 救えなかった）。
pub fn child_notice(level: NoticeLevel, tag: &str, message: impl Display) -> String {
    format!("{} [{}] {}", level.token(), tag, message)
}

/// `child_notice(NoticeLevel::Info, ..)` の短縮。正常系の通知はほぼこれ。
pub fn child_info(tag: &str, message: impl Display) -> String {
    child_notice(NoticeLevel::Info, tag, message)
}

#[cfg(test)]
mod tests {
    use super::{child_info, child_notice, NoticeLevel};

    /// TS 側 router（`daemon-client.ts` の `isDaemonNonErrorTracingLine`）が要求する形。
    /// ここを緩めると、正常動作が ERROR として記録される障害が 3 回目の再発をする。
    fn accepted_by_router(line: &str) -> bool {
        let mut parts = line.splitn(3, ' ');
        let level = parts.next().unwrap_or_default();
        let tag = parts.next().unwrap_or_default();
        let rest = parts.next().unwrap_or_default();
        matches!(level, "TRACE" | "DEBUG" | "INFO")
            && tag.starts_with("[orbit-")
            && tag.ends_with(']')
            && !rest.is_empty()
    }

    #[test]
    fn child_notice_is_accepted_by_the_daemon_stderr_router() {
        for (level, token) in [
            (NoticeLevel::Trace, "TRACE"),
            (NoticeLevel::Debug, "DEBUG"),
            (NoticeLevel::Info, "INFO"),
        ] {
            let line = child_notice(level, "orbit-vst3-effect-child", "something benign");
            assert!(
                line.starts_with(token),
                "level token must come first: {line}"
            );
            assert!(
                accepted_by_router(&line),
                "router must classify this as non-error: {line}"
            );
        }
    }

    /// host crate は child プロセスの中で動くのでタグが `-child` で終わらない（#625）。
    #[test]
    fn host_tags_that_do_not_end_in_child_are_still_accepted() {
        let line = child_info("orbit-vst3-host", "setComponentState returned 0x3");
        assert!(
            accepted_by_router(&line),
            "host-tagged notices must be non-error too: {line}"
        );
    }

    #[test]
    fn message_body_is_preserved() {
        let line = child_info(
            "orbit-vst3-effect-child",
            format!("--plugin-id={} は未使用", "ABC"),
        );
        assert!(
            line.contains("--plugin-id=ABC"),
            "message must survive: {line}"
        );
    }
}
