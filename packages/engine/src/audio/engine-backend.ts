/**
 * Audio backend seam (post-2.0 S2 / Issue #296).
 *
 * `AudioEngineBackend` は interpreter / scheduler が音声バックエンドに要求する
 * 唯一の契約面。既存の `SuperColliderPlayer`（scsynth / OSC）と、新規の
 * `RustEnginePlayer`（orbit-audio-daemon / WebSocket）が**ともに**これを満たす。
 *
 * 設計（master plan §4-A S2・docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md）:
 *   - seam = バックエンドレベル。`Scheduler`（musical timing は TS 側）+ AudioEngine 面。
 *   - 既存 SC 経路は無改変。Rust は `ORBITSCORE_ENGINE=rust` で opt-in（既定は SC）。
 *   - .vsix は 2.0.0 feature-freeze のため、出荷既定は SuperCollider のまま。
 */

import type { Scheduler } from '../core/global/types'

import type { AudioDevice } from './supercollider/types'

/**
 * interpreter（`InterpreterState.audioEngine`）/ Global が依存する音声バックエンド契約。
 *
 * `Scheduler`（再生イベントのスケジュール・TS 側 musical timing）に加え、boot/quit
 * とデバイス・LinkAudio 面を持つ。`boot` は SC の `boot(outputDevice?)` 呼び出しに
 * 合わせて optional な device 引数を受ける（`AudioEngine.boot()` より広い）。
 */
export interface AudioEngineBackend extends Scheduler {
  boot(outputDevice?: string): Promise<void>
  quit(): Promise<void>
  getCurrentOutputDevice?(): AudioDevice | undefined
  getAvailableDevices?(): AudioDevice[]
  setAvailableDevices?(devices: AudioDevice[]): void
  registerLinkAudioChannel?(channelName: string): Promise<void>
  setLinkTempo?(bpm: number): Promise<void>
}

/** バックエンド選択 env。`rust` で daemon 経路、それ以外（未設定含む）で SC。 */
export const ENGINE_ENV_VAR = 'ORBITSCORE_ENGINE'

export type EngineKind = 'supercollider' | 'rust'

/** env 値をバックエンド種別へ正規化する（未知 / 未設定は既定の SuperCollider）。 */
export function resolveEngineKind(raw: string | undefined): EngineKind {
  return raw?.trim().toLowerCase() === 'rust' ? 'rust' : 'supercollider'
}
