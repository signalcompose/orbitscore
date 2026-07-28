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
pub mod event_backing_ring;
pub mod event_spill_fifo;
pub mod events;
pub mod host;
mod instrument_host;
pub mod offline;
pub mod parent_watch;
pub mod transport;

pub use child::SandboxChildGuard;
pub use event_backing_ring::{EventBackingRing, EVENT_BACKING_CAPACITY};
pub use event_spill_fifo::{EventSpillFifo, EVENT_SPILL_CAPACITY};
pub use events::{
    EventPayload, EventRecord, NeutralEvent, NeutralExpressionId, VoiceAddr,
    KIND_LEGACY_MIDI_CC_OUT, KIND_MIDI2, KIND_MIDI_RAW, KIND_NOTE_CHOKE, KIND_NOTE_END,
    KIND_NOTE_EXPRESSION, KIND_NOTE_OFF, KIND_NOTE_ON, KIND_PARAM_GESTURE_BEGIN,
    KIND_PARAM_GESTURE_END, KIND_PARAM_MOD, KIND_PARAM_VALUE, KIND_POLY_PRESSURE,
};
pub use host::PipelinedEffectHost;
pub use instrument_host::{
    InstrumentBlockOutcome, PipelinedInstrumentHost, VoiceKey, VoiceTable, MAX_TRACKED_PORTS,
};
pub use offline::{
    max_abs_diff, render_in_process_gain, render_through_child_sync,
    render_through_child_sync_with_options, ChildStats, RenderOptions,
};
pub use parent_watch::{ParentWatch, DEFAULT_CHECK_INTERVAL};
pub use transport::{
    create_shared, open_shared, region_ptr, save_state_command, service_command_mailbox,
    slot_index, slot_offset, write_sidecar, CommandMailboxError, CommandMailboxHost,
    CommandMailboxResponse, CommandOutcome, SharedRegion, TransportContext, BUF_LEN, CHANNELS,
    CMD_ARG_BYTES, CMD_NONE, CMD_RESULT_BAD_ARG, CMD_RESULT_CHILD_EXITED, CMD_RESULT_IO_ERROR,
    CMD_RESULT_OK, CMD_RESULT_PLUGIN_ERROR, CMD_RESULT_UNKNOWN_KIND, CMD_SAVE_STATE, CONTROL_QUIT,
    CONTROL_RUN, MAX_EVENTS_PER_BLOCK, MAX_FRAMES, PLUGIN_STATE_MAILBOX_TIMEOUT, REGION_BYTES,
    SLOTS,
};
