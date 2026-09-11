/**
 * 音声バックエンドのファクトリ（post-2.0 S2 / Issue #296・cutover #108）。
 *
 * cutover #108 で既定を **Rust**（`RustEnginePlayer` / orbit-audio-daemon）に切替。
 * 旧 SC バックエンドは #502 で削除済み — `RustEnginePlayer` が唯一のバックエンド。
 */

import { AudioEngineBackend } from './engine-backend'
import { RustEnginePlayer } from './rust-engine/rust-engine-player'

/**
 * 音声バックエンドを生成する。
 */
export function createAudioEngine(): AudioEngineBackend {
  return new RustEnginePlayer()
}
