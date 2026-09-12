//! `orbit_audio_daemon::engine_wrap` の**公開面**を固定する（#888・分割で黙って狭まるのを防ぐ）。
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

use orbit_audio_daemon::engine_wrap::parse_output_fault;
use orbit_audio_daemon::engine_wrap::AppliedEffectChainSummary;
#[cfg(feature = "outproc-effect")]
use orbit_audio_daemon::engine_wrap::BusKind;
#[cfg(feature = "outproc-effect")]
use orbit_audio_daemon::engine_wrap::BusLineDest;
#[cfg(feature = "outproc-effect")]
use orbit_audio_daemon::engine_wrap::BusLineOp;
use orbit_audio_daemon::engine_wrap::ClapPluginRole;
use orbit_audio_daemon::engine_wrap::DeviceSwitchRequest;
use orbit_audio_daemon::engine_wrap::DroppedEffectStageSummary;
use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::engine_wrap::LoadedPluginSummary;
use orbit_audio_daemon::engine_wrap::LoadedSample;
use orbit_audio_daemon::engine_wrap::PlayHandle;
use orbit_audio_daemon::engine_wrap::PluginAllNotesOffSummary;
use orbit_audio_daemon::engine_wrap::PluginStateTarget;
use orbit_audio_daemon::engine_wrap::PluginUiCompletion;
use orbit_audio_daemon::engine_wrap::PluginUiEvent;
use orbit_audio_daemon::engine_wrap::PluginUiTarget;
use orbit_audio_daemon::engine_wrap::ReplacedPluginSummary;
use orbit_audio_daemon::engine_wrap::SavedPluginStateSummary;
#[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
use orbit_audio_daemon::engine_wrap::SourceRoutingTarget;
use orbit_audio_daemon::engine_wrap::StartupOptions;
use orbit_audio_daemon::engine_wrap::StreamConfigSnapshot;
use orbit_audio_daemon::engine_wrap::StreamGuard;
use orbit_audio_daemon::engine_wrap::UnloadedPluginStatus;
use orbit_audio_daemon::engine_wrap::WrapError;
#[cfg(feature = "outproc-effect")]
use orbit_audio_daemon::engine_wrap::DEFAULT_AUX_BUS_POOL_PREFIX;
#[cfg(feature = "outproc-effect")]
use orbit_audio_daemon::engine_wrap::DEFAULT_EFFECT_BUS_POOL_PREFIX;
#[cfg(feature = "outproc-effect")]
use orbit_audio_daemon::engine_wrap::DEFAULT_SUM_BUS_POOL_PREFIX;
