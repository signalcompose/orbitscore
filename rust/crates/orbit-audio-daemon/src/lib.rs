//! orbit-audio-daemon library crate.
//!
//! integration test と binary main のみがユーザー。通常利用では
//! [`crate::main`] 経由で bin として動かす前提。
//!
//! test 側は `tests/protocol.rs` から [`backend::StubBackend`] を
//! 経由して `EngineWrap` を audio device なしで起動する。

pub mod backend;
/// in-process CLAP plugin hosting の daemon 配線。feature `clap-host`（default off）でのみ
/// コンパイルされ、`orbit-clap-host` の `ClapHost`(!Send) を専用スレッドで所有する（Issue #340）。
#[cfg(feature = "clap-host")]
pub mod clap_host;
pub mod engine_wrap;
/// 🔴 GPL 境界: LinkAudio egress の control-side 配線。feature `link-audio`（default off）でのみ
/// コンパイルされ、GPL crate `orbit-link-audio` を保持する consumer thread を起動する。
#[cfg(feature = "link-audio")]
pub mod link_audio;
/// γ M1 PR-C: out-of-process effect の daemon 配線。feature `outproc-effect`（default off・clack-free）
/// でのみコンパイルされ、別プロセスの実 CLAP effect child へ共有メモリ transport 越しに audio を流す。
#[cfg(feature = "outproc-effect")]
pub mod outproc_effect;
pub mod protocol;
pub mod server;
pub mod session;
