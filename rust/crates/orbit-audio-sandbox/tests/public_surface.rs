//! `orbit_audio_sandbox::transport` の**公開面**を固定する（#888・分割で黙って狭まるのを防ぐ）。
//!
//! 🔴 **なぜ要るか**: `pub fn` を private な子モジュールへ移し `pub(crate) use child::*;` で
//! 再エクスポートすると、**crate 内はコンパイルが通るのに crate 外からは見えなくなる**。
//! `cargo clippy -p <crate>` は下流を見ないので捕まらず、下流にまだ消費者が居なければ
//! **誰も気づかない**。#888 の分割で実際に 2 度起きた:
//!
//! - `orbit_vst3_host::probe_factory_descriptors`（`orbit-plugin-scan` が使っていたので dead_code で露見）
//! - `orbit_audio_daemon::engine_wrap` の 9 項目（消費者が居らず**全ゲート緑のまま通過**。Fable 監査が発見）
//!
//! 🔴 **`pub` 宣言の数を分割前後で diff しても、この欠陥は捕まらない。** 宣言は `pub` のままで、
//! 到達経路だけが失われるからである。**統合テストは crate の外側**なので、ここで `use` できる
//! ことが到達可能性そのものの証明になる。
//!
//! 🔴 **cfg から `test` 項を落としてある。** 統合テストは `--test` 付きでコンパイルされるので
//! この crate では `cfg(test)` が真になるが、**参照先の lib は `--test` 無しでコンパイルされる**
//! ので偽である。定義側の `#[cfg(any(test, X))]` をそのまま写すと、lib に無い項目を
//! import しようとして E0432 になる（実際に踏んだ）。
//!
//! 項目を意図的に非公開へ変えるときは、この一覧からも消すこと（消さずに通ることはない）。

#![allow(unused_imports)]

use orbit_audio_sandbox::transport::create_shared;
use orbit_audio_sandbox::transport::decode_ui_closed_arg;
use orbit_audio_sandbox::transport::decode_ui_closed_done_arg;
use orbit_audio_sandbox::transport::encode_ui_closed_arg;
use orbit_audio_sandbox::transport::encode_ui_closed_done_arg;
use orbit_audio_sandbox::transport::evt_slot_index;
use orbit_audio_sandbox::transport::open_shared;
use orbit_audio_sandbox::transport::read_cstr_field;
use orbit_audio_sandbox::transport::region_ptr;
use orbit_audio_sandbox::transport::save_state_command;
use orbit_audio_sandbox::transport::slot_index;
use orbit_audio_sandbox::transport::slot_offset;
use orbit_audio_sandbox::transport::write_cstr_field;
use orbit_audio_sandbox::transport::write_sidecar;
use orbit_audio_sandbox::transport::CommandMailboxError;
use orbit_audio_sandbox::transport::CommandMailboxHost;
use orbit_audio_sandbox::transport::CommandMailboxResponse;
use orbit_audio_sandbox::transport::CommandOutcome;
use orbit_audio_sandbox::transport::EventPollOutcome;
use orbit_audio_sandbox::transport::EventRingChild;
use orbit_audio_sandbox::transport::EventRingChildError;
use orbit_audio_sandbox::transport::EventRingEvent;
use orbit_audio_sandbox::transport::SharedRegion;
use orbit_audio_sandbox::transport::TransportContext;
use orbit_audio_sandbox::transport::UiCloseCompletion;
use orbit_audio_sandbox::transport::UiEventPump;
use orbit_audio_sandbox::transport::UiEventPumpError;
use orbit_audio_sandbox::transport::UiPumpNotification;
use orbit_audio_sandbox::transport::UiPumpResetOutcome;
use orbit_audio_sandbox::transport::UiWindowKey;
use orbit_audio_sandbox::transport::APPLY_CHAIN_MAILBOX_TIMEOUT;
use orbit_audio_sandbox::transport::BUF_LEN;
use orbit_audio_sandbox::transport::CHANNELS;
use orbit_audio_sandbox::transport::CHILD_FLAG_HAS_AUDIO_INPUT;
use orbit_audio_sandbox::transport::CHILD_STATUS_LOAD_FAILED;
use orbit_audio_sandbox::transport::CHILD_STATUS_READY;
use orbit_audio_sandbox::transport::CHILD_STATUS_STARTING;
use orbit_audio_sandbox::transport::CMD_APPLY_CHAIN;
use orbit_audio_sandbox::transport::CMD_ARG_BYTES;
use orbit_audio_sandbox::transport::CMD_CLOSE_UI;
use orbit_audio_sandbox::transport::CMD_CLOSE_UI_AT;
use orbit_audio_sandbox::transport::CMD_DETAIL_BYTES;
use orbit_audio_sandbox::transport::CMD_NONE;
use orbit_audio_sandbox::transport::CMD_OPEN_UI;
use orbit_audio_sandbox::transport::CMD_OPEN_UI_AT;
use orbit_audio_sandbox::transport::CMD_RESULT_BAD_ARG;
use orbit_audio_sandbox::transport::CMD_RESULT_CHILD_EXITED;
use orbit_audio_sandbox::transport::CMD_RESULT_IO_ERROR;
use orbit_audio_sandbox::transport::CMD_RESULT_OK;
use orbit_audio_sandbox::transport::CMD_RESULT_PLUGIN_ERROR;
use orbit_audio_sandbox::transport::CMD_RESULT_UNKNOWN_KIND;
use orbit_audio_sandbox::transport::CMD_SAVE_STATE;
use orbit_audio_sandbox::transport::CMD_SAVE_STATE_AT;
use orbit_audio_sandbox::transport::CONTROL_QUIT;
use orbit_audio_sandbox::transport::CONTROL_RUN;
use orbit_audio_sandbox::transport::EVT_ARG_BYTES;
use orbit_audio_sandbox::transport::EVT_ARG_FALLBACK;
use orbit_audio_sandbox::transport::EVT_NONE;
use orbit_audio_sandbox::transport::EVT_SLOTS;
use orbit_audio_sandbox::transport::EVT_UI_CLOSED;
use orbit_audio_sandbox::transport::EVT_UI_CLOSED_DONE;
use orbit_audio_sandbox::transport::MAX_EVENTS_PER_BLOCK;
use orbit_audio_sandbox::transport::MAX_FRAMES;
use orbit_audio_sandbox::transport::OPEN_UI_MAILBOX_TIMEOUT;
use orbit_audio_sandbox::transport::PLUGIN_STATE_MAILBOX_TIMEOUT;
use orbit_audio_sandbox::transport::REGION_BYTES;
use orbit_audio_sandbox::transport::SLOTS;
