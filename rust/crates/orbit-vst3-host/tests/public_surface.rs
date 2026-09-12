//! `orbit_vst3_host` の**公開面**を固定する（#888・分割で黙って狭まるのを防ぐ）。
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

//! 🔴 **crate ごと `#![cfg(target_os = "macos")]` なので、このテストも同じゲートを持つ。**
//! 付け忘れると Linux CI（`rust-ci.yml` は全ジョブ ubuntu）で lib が空になり、
//! 全 import が E0432 で落ちる。**手元は macOS なので気づけない** — 実際に CI で 15 件落とした。
#![cfg(target_os = "macos")]
#![allow(unused_imports)]

use orbit_vst3_host::probe_factory_descriptors;
use orbit_vst3_host::probe_plugin;
use orbit_vst3_host::FactoryClassDescriptor;
use orbit_vst3_host::FactoryDescriptorApi;
use orbit_vst3_host::FactoryProbeError;
use orbit_vst3_host::LoadedVst3Info;
use orbit_vst3_host::ProbeResult;
use orbit_vst3_host::ProcessReport;
use orbit_vst3_host::Vst3EffectAudio;
use orbit_vst3_host::Vst3EffectProcessor;
use orbit_vst3_host::Vst3HostError;
use orbit_vst3_host::Vst3InstrumentAudio;
use orbit_vst3_host::Vst3InstrumentProcessor;
use orbit_vst3_host::Vst3PluginMain;
use orbit_vst3_host::Vst3ProcessMode;
