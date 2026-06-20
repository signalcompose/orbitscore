/**
 * 音声バックエンドのファクトリ（post-2.0 S2 / Issue #296）。
 *
 * `ORBITSCORE_ENGINE=rust` のときのみ `RustEnginePlayer`（orbit-audio-daemon）を返し、
 * それ以外（未設定含む）は既定の `SuperColliderPlayer` を返す。.vsix の出荷既定は
 * SuperCollider のまま（master plan §6 feature-freeze）。
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
  if (kind === 'rust') {
    console.log('🦀 [engine] using rust orbit-audio-daemon backend (ORBITSCORE_ENGINE=rust)')
    return new RustEnginePlayer()
  }
  return new SuperColliderPlayer()
}
