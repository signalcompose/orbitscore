//! プラグイン UI イベントの引数エンコード/デコード（#888 子 3・orbit-audio-sandbox）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(super)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use super::*;

/// `UI_CLOSED_DONE` が伝える close の終端理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiCloseCompletion {
    SafepointCompleted,
    TimedOutWithoutSave,
}

/// Stable identity for one plugin UI window.
///
/// `None` は非 indexed の child プロトコル（**instrument のみ**）。effect は #628 以降
/// `ui_handles` が無条件に `rack_target = true` を返すので、チェーンが 1 枚でも常に
/// `Some(token)` になる。「single-plugin effect child は `None`」という経路は**存在しない**
/// （2026-08-29 のレビューで、この doc がそう書いていたのを訂正）。
pub type UiWindowKey = Option<u64>;

impl UiCloseCompletion {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SafepointCompleted => "safepoint-completed",
            Self::TimedOutWithoutSave => "timeout-without-save",
        }
    }
}

/// [`UiEventPump::poll_step`] が daemon の非ブロッキング sink へ渡す固定通知。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiPumpNotification {
    Safepoint {
        generation: u64,
        evt_seq: u64,
        window: UiWindowKey,
    },
    CloseDone {
        completion: UiCloseCompletion,
        window: UiWindowKey,
    },
}

/// Encode the fixed `UI_CLOSED` event argument grammar shared with child runtimes.
pub fn encode_ui_closed_arg(window: UiWindowKey) -> String {
    match window {
        None => String::new(),
        Some(window) => format!(r#"{{"window":{window}}}"#),
    }
}

/// Encode the fixed `UI_CLOSED_DONE` event argument grammar shared with child runtimes.
pub fn encode_ui_closed_done_arg(window: UiWindowKey, completion: UiCloseCompletion) -> String {
    match window {
        None => completion.as_str().to_owned(),
        Some(window) => format!(
            r#"{{"window":{window},"completion":"{}"}}"#,
            completion.as_str()
        ),
    }
}

pub(super) fn decode_decimal_u64(value: &str) -> Result<u64, String> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| format!("invalid UI window token {value:?}"))?;
    if parsed.to_string() != value {
        return Err(format!("non-canonical UI window token {value:?}"));
    }
    Ok(parsed)
}

/// Decode only the fixed grammar emitted by [`encode_ui_closed_arg`].
pub fn decode_ui_closed_arg(arg: Option<&str>) -> Result<UiWindowKey, String> {
    match arg {
        None | Some("") => Ok(None),
        Some(arg) => {
            let value = arg
                .strip_prefix(r#"{"window":"#)
                .and_then(|value| value.strip_suffix('}'))
                .ok_or_else(|| format!("invalid UI_CLOSED argument {arg:?}"))?;
            decode_decimal_u64(value).map(Some)
        }
    }
}

/// Decode only the fixed grammar emitted by [`encode_ui_closed_done_arg`].
pub fn decode_ui_closed_done_arg(
    arg: Option<&str>,
) -> Result<(UiWindowKey, UiCloseCompletion), String> {
    let arg = arg.ok_or_else(|| "missing UI_CLOSED_DONE argument".to_owned())?;
    let legacy = match arg {
        "safepoint-completed" => Some(UiCloseCompletion::SafepointCompleted),
        "timeout-without-save" => Some(UiCloseCompletion::TimedOutWithoutSave),
        _ => None,
    };
    if let Some(completion) = legacy {
        return Ok((None, completion));
    }

    let body = arg
        .strip_prefix(r#"{"window":"#)
        .ok_or_else(|| format!("invalid UI_CLOSED_DONE argument {arg:?}"))?;
    let (window, completion) = body
        .split_once(r#","completion":""#)
        .ok_or_else(|| format!("invalid UI_CLOSED_DONE argument {arg:?}"))?;
    let completion = completion
        .strip_suffix(r#""}"#)
        .ok_or_else(|| format!("invalid UI_CLOSED_DONE argument {arg:?}"))?;
    let completion = match completion {
        "safepoint-completed" => UiCloseCompletion::SafepointCompleted,
        "timeout-without-save" => UiCloseCompletion::TimedOutWithoutSave,
        _ => return Err(format!("invalid UI close completion {completion:?}")),
    };
    Ok((Some(decode_decimal_u64(window)?), completion))
}
