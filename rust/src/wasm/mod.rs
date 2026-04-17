//! WASM module: wasm-bindgen + AudioWorklet のグルー（予約）。
//!
//! Issue #91 の PoC スコープには含まれない。Phase 2 以降で `core::Engine` を
//! AudioWorklet から呼べるようにするバインディングをここで提供する想定。

use wasm_bindgen::prelude::*;

/// 開発時のパニック可視化。wasm バイナリには影響しない。
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

// TODO: AudioWorkletNode から呼べる `process()` 相当のバインディング
// TODO: core::Engine を JS 側からスケジュールする薄い wrapper
