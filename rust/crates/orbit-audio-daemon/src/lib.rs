//! orbit-audio-daemon library crate.
//!
//! integration test と binary main のみがユーザー。通常利用では
//! [`crate::main`] 経由で bin として動かす前提。
//!
//! test 側は `tests/protocol.rs` から [`backend::StubBackend`] を
//! 経由して `EngineWrap` を audio device なしで起動する。

pub mod backend;
pub mod engine_wrap;
/// 🔴 GPL 境界: LinkAudio egress の control-side 配線。feature `link-audio`（default off）でのみ
/// コンパイルされ、GPL crate `orbit-link-audio` を保持する consumer thread を起動する。
#[cfg(feature = "link-audio")]
pub mod link_audio;
pub mod protocol;
pub mod server;
pub mod session;
