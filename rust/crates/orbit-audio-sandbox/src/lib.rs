//! orbit-audio-sandbox — γ M1: out-of-process effects の本番 transport。
//!
//! γ Step0/latency spike(#349/#351)が実証した pipelined(候補B)sandbox を本番化する crate。
//! spike(`orbit-sandbox-spike`)から **transport だけ**を昇格し、計測 scaffolding は持ち込まない。
//!
//! 構成:
//! - [`transport`]: 親子で共有する [`SharedRegion`](file-backed mmap MAP_SHARED + SPSC ping-pong)と
//!   map ヘルパ。N-slot-generic([`SLOTS`] 1 つで pipeline 深さを切り替え)。**memmap2 のみ依存**。
//! - [`host`]: [`PipelinedEffectHost`] = RT callback ごとに 1 block を境界越しに処理する候補B 状態機械
//!   (submit → 前ブロック read・stale は repeat-previous)。`&mut [f32]` と `*mut SharedRegion` で完結し
//!   native/cpal/clack に非依存。`impl PostProcessor` の adapter は daemon 側に薄く置く。
//! - [`offline`]: cpal 非依存の同期ドライバ + A/B parity primitive(CI 実行可・audio 正しさ検証)。
//! - [`child`]: child プロセスの teardown RAII ガード(QUIT → reap → shm 削除)。offline/test/PR-C 共用。
//!
//! 設計の正本: `docs/development/POST_2.0_GAMMA_M1_DESIGN.md`。

pub mod child;
pub mod host;
pub mod offline;
pub mod transport;

pub use child::SandboxChildGuard;
pub use host::PipelinedEffectHost;
pub use offline::{max_abs_diff, render_in_process_gain, render_through_child_sync};
pub use transport::{
    create_shared, open_shared, region_ptr, slot_offset, SharedRegion, BUF_LEN, CHANNELS,
    CONTROL_QUIT, CONTROL_RUN, MAX_FRAMES, REGION_BYTES, SLOTS,
};
