/**
 * 音声バックエンドのファクトリ（post-2.0 S2 / Issue #296・cutover #108）。
 *
 * cutover #108 で既定を **Rust**（`RustEnginePlayer` / orbit-audio-daemon）に切替。
 * `ORBITSCORE_ENGINE=sc`（または `supercollider`）で既存 `SuperColliderPlayer` に opt-out
 * できる。未設定 / 未知値は既定の Rust。
 */

import { AudioEngineBackend, ENGINE_ENV_VAR, resolveEngineKind } from './engine-backend'
import { RustEnginePlayer } from './rust-engine/rust-engine-player'
import { SuperColliderPlayer } from './supercollider-player'

/**
 * env に基づき音声バックエンドを生成する。`env` 引数はテスト用 override（既定は
 * `process.env`）。
 */
export function createAudioEngine(env: NodeJS.ProcessEnv = process.env): AudioEngineBackend {
  const kind = resolveEngineKind(env[ENGINE_ENV_VAR])
  if (kind === 'supercollider') {
    console.log('🎛️ [engine] using SuperCollider backend (opt-out via ORBITSCORE_ENGINE=sc)')
    return new SuperColliderPlayer()
  }
  console.log('🦀 [engine] using rust orbit-audio-daemon backend (default since cutover #108)')
  return new RustEnginePlayer()
}
