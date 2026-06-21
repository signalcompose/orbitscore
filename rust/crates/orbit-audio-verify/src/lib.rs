//! orbit-audio-verify
//!
//! オーディオ出力（レンダリング済み PCM）を、DSL/エンジンが静的に意図した
//! 期待値と機械的に突き合わせる検証ハーネス。「耳で確認」を「PCM 上の算術で
//! 確認」に置き換え、pan / chop 領域 / per-slice gain / onset / 末尾 fade を
//! 客観 pass/fail のエビデンスにする。研究的背景は #308
//! (`docs/research/AUDIO_OUTPUT_VERIFICATION.md`)、実装トラックは #307。
//!
//! # 2 つの構成要素
//!
//! - [`capture`]: 本番と同じ core レンダラ ([`orbit_audio_core::Scheduler`]) を
//!   固定タイムラインでオフライン駆動し、ミックス済み interleaved f32 を
//!   決定論バッファに収集する（= DUT / Device Under Test）。ハードウェア非依存・
//!   実時間非依存。block 分割で render するため、実 cpal callback と同様に
//!   イベントが block 境界をまたぐ経路 (`dst_offset_frames`) も通る。
//! - [`analysis`]: 収集した PCM から客観量（RMS / peak / 領域エネルギー / L-R 比
//!   からの pan 逆算 / dB 差）を抽出する純粋関数群（= Scoreboard / Checker）。
//!
//! # GRM 独立性（差分検証の成立条件）
//!
//! Golden Reference Model（期待値）と DUT（レンダラ）は **コードを共有しない**。
//! 共有すると同じバグが両側に乗り、差分が出ず検証が空洞化する。具体的には
//! [`analysis`] は core の `equal_power_pan` / `resolve_slice_region` を
//! **import しない**。pan は L/R RMS から `atan2` で独立に逆算し（レンダラは
//! `cos`/`sin`）、領域境界やゲイン差の期待値はテストフィクスチャ側に直書きする。
//! `Scheduler` / `ScheduledSample` / `Sample` を **DUT の駆動**に使うのは可、
//! それらの render 補助関数を **期待値計算**に使うのは不可。
//!
//! # 許容値（tolerance）と校正
//!
//! 本ハーネスが検証する core レンダラは **完全に線形** である:
//! ミックス = 単純加算 / pan = 等パワー則の左右ゲイン（schedule 時 precompute）/
//! gain = 線形スカラ / 末尾 fade = 線形ランプ。非線形合成を含まないため、MPEG audio
//! conformance 由来の非線形校正は不要で、下記の固定許容で十分な余裕がある。
//! 値は #308 のブループリント（CI gate 案）および既存 resampler test の ±0.5 dB
//! 前例に揃える。
//!
//! - [`analysis::PAN_TOLERANCE`] = 0.05（pan 単位）
//! - [`analysis::GAIN_DB_TOLERANCE`] = 0.5 dBFS
//! - [`analysis::SILENCE_FLOOR_DB`] = −90 dBFS（領域外の無音判定）。本レンダラでは
//!   領域外は厳密に 0.0 だが、将来の非線形要素・実機経路に備えた文書化された floor。

pub mod analysis;
pub mod capture;
pub mod onset;

pub use analysis::{
    channel_peak, channel_rms, db_difference, linear_to_db, pan_from_lr_rms, region_peak,
    region_rms, GAIN_DB_TOLERANCE, PAN_TOLERANCE, SILENCE_FLOOR_DB,
};
pub use capture::{capture, CapturedAudio};
pub use onset::{detect_onset_matched, detect_onset_threshold, fade_slope_is_linear};
