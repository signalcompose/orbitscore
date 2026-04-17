//! orbit-audio-wasm
//!
//! Signal compose audio engine の WASM / AudioWorklet バックエンド（スタブ）。
//! Phase 3（Web 版着手時）に本実装する想定。platform-agnostic なコアは
//! [`orbit_audio_core`] を参照。

use wasm_bindgen::prelude::*;

/// 開発時のパニック可視化。wasm バイナリには影響しない。
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

// TODO: AudioWorkletNode から呼べる `process()` 相当のバインディング
// TODO: orbit_audio_core::Engine を JS 側からスケジュールする薄い wrapper
