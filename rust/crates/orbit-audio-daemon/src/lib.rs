//! orbit-audio-daemon library crate.
//!
//! integration test と binary main のみがユーザー。通常利用では
//! [`crate::main`] 経由で bin として動かす前提。
//!
//! test 側は `tests/protocol.rs` から [`backend::StubBackend`] を
//! 経由して `EngineWrap` を audio device なしで起動する。

pub mod backend;
pub mod engine_wrap;
pub mod protocol;
pub mod server;
pub mod session;
