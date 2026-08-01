//! orbit-audio-daemon library crate.
//!
//! integration test と binary main のみがユーザー。通常利用では
//! [`crate::main`] 経由で bin として動かす前提。
//!
//! test 側は `tests/protocol.rs` から [`backend::StubBackend`] を
//! 経由して `EngineWrap` を audio device なしで起動する。

pub mod backend;
/// 🔴 #605/#612: 診断チャネル（stderr）の故障で daemon を殺さない書き込み。
pub mod best_effort_stderr;
/// in-process CLAP plugin hosting の daemon 配線。feature `clap-host`（default off）でのみ
/// コンパイルされ、`orbit-clap-host` の `ClapHost`(!Send) を専用スレッドで所有する（Issue #340）。
#[cfg(feature = "clap-host")]
pub mod clap_host;
pub mod engine_wrap;
/// 🔴 GPL 境界: LinkAudio egress の control-side 配線。feature `link-audio`（default off）でのみ
/// コンパイルされ、GPL crate `orbit-link-audio` を保持する consumer thread を起動する。
#[cfg(feature = "link-audio")]
pub mod link_audio;
/// attach する plugin の拡張子から child binary を選ぶ規則。**effect と instrument で共有する**
/// （規則を2箇所に持つと、片方だけ直し忘れる — #548 がまさにその形のバグだった）。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) mod outproc_child_exe;
/// γ M1 PR-C: out-of-process effect の daemon 配線。feature `outproc-effect`（default off・clack-free）
/// でのみコンパイルされ、別プロセスの実 CLAP effect child へ共有メモリ transport 越しに audio を流す。
#[cfg(feature = "outproc-effect")]
pub mod outproc_effect;
/// Out-of-process CLAP instrument production integration（Issue #420・default off・clack-free）。
#[cfg(feature = "outproc-instrument")]
pub mod outproc_instrument;
/// watchdog の「起動直後に死に続ける child を tight loop で respawn し続ける」検知ロジック（#573）。
/// **effect と instrument で共有する**（規則を2箇所に持つと片方だけ直し忘れる — #548 と同種のリスク）。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) mod outproc_respawn_guard;
pub mod protocol;
pub mod server;
pub mod session;
