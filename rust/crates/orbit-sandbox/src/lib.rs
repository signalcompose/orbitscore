//! orbit-sandbox — γ out-of-process sandbox 本番 transport layer (Issue #354)
//!
//! spike chain (#348 Step0 / #350 latency fork) の verdict に基づく本番実装:
//! - **候補 B (pipelined)** 採用: host は spin しない → ~2.7–3ms の同期 tail を構造的に排除。
//! - **SLOTS = 3**: 32f での stall (9–13 件 @2-slot) を排除するため 3-outstanding に変更。
//! - **repeat-previous stale policy**: spike の silence を廃止。child が missed deadline でも
//!   直前 block の出力を繰り返し、click を回避する。
//!
//! ## モジュール構成
//! - [`shared`]: 親子で共有する mmap 領域 ([`SharedRegion`]) と helper
//! - [`host`]: 親プロセス側 transport ([`SandboxHostTransport`])
//! - [`child`]: 子プロセス側 transport ([`SandboxChildTransport`])
//!
//! ## daemon 統合（決定点3 — 未着手）
//! PostProcessor trait との接続は orbit-audio-daemon 側で実施する予定。
//! 本 crate は orbit-audio-native に依存しない純粋な transport layer として設計されている。

#![allow(unsafe_code)]

pub mod child;
pub mod host;
pub mod shared;

pub use child::SandboxChildTransport;
pub use host::{BlockStatus, OutputKind, SandboxHostTransport, SubmitKind};
pub use shared::{create_shared, open_shared, region_ptr, SharedRegion, CHANNELS, MAX_FRAMES, REGION_BYTES, SLOTS};
