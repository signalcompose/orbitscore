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
  const raw = env[ENGINE_ENV_VAR]
  if (resolveEngineKind(raw) === 'supercollider') {
    console.log(`🎛️ [engine] using SuperCollider backend (opt-out via ORBITSCORE_ENGINE=${raw})`)
    return new SuperColliderPlayer()
  }
  // 既定は Rust。ただし raw が「未設定/空」でも 'rust' でもない未認識値のときは、
  // SC のつもりの typo（例: ORBITSCORE_ENGINE=scc）が黙って Rust 起動に落ちるのを
  // warn で observable にする（未設定と誤入力を区別する）。
  const normalized = raw?.trim().toLowerCase() ?? ''
  if (normalized !== '' && normalized !== 'rust') {
    console.warn(
      `⚠️  [engine] ORBITSCORE_ENGINE=${JSON.stringify(raw)} は未認識 — ` +
        `'rust' / 'sc' / 'supercollider' を想定。既定の Rust にフォールバック`,
    )
  }
  const source = normalized === '' ? 'default since cutover #108' : `ORBITSCORE_ENGINE=${raw}`
  console.log(`🦀 [engine] using rust orbit-audio-daemon backend (${source})`)
  return new RustEnginePlayer()
}
