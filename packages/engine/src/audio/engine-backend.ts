/**
 * Audio backend seam (post-2.0 S2 / Issue #296).
 *
 * `AudioEngineBackend` は interpreter / scheduler が音声バックエンドに要求する
 * 唯一の契約面。既存の `SuperColliderPlayer`（scsynth / OSC）と、新規の
 * `RustEnginePlayer`（orbit-audio-daemon / WebSocket）が**ともに**これを満たす。
 *
 * 設計（master plan §4-A S2・docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md）:
 *   - seam = バックエンドレベル。`Scheduler`（musical timing は TS 側）+ AudioEngine 面。
 *   - cutover #108: 既定は **Rust**（native daemon）。SC 経路は温存し `ORBITSCORE_ENGINE=sc`
 *     で opt-out。engine-level default のみ切替（VS Code UI 既定・.vsix は #366 post-cutover 仕上げ）。
 */

import type { Scheduler } from '../core/global/types'

import type { AudioDevice } from './supercollider/types'
import type { EffectChainApplyRequest, EffectChainApplyResult, PluginLoadResult } from './types'

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
  /** ランタイム中に出力デバイスを切り替える（Rust daemon 経路のみ・#484 D2/D2.5）。実際に適用されたデバイス名を返す。 */
  selectAudioDevice?(device: string): Promise<string>
  registerLinkAudioChannel?(channelName: string): Promise<void>
  setLinkTempo?(bpm: number): Promise<void>
  loadPlugin?(
    filePath: string,
    pluginId: string | undefined,
    role: 'effect' | 'instrument',
    bus?: string,
    instance?: string,
    statePath?: string,
  ): Promise<PluginLoadResult>
  applyEffectChain?(request: EffectChainApplyRequest): Promise<EffectChainApplyResult>
  /** マスターゲイン（線形 amplitude）を daemon の mixer へ。#643 PR-2。 */
  setGlobalGain?(amplitude: number, rampSec?: number): Promise<void>
  pluginNoteOn?(key: number, channel: number, velocity: number, instance?: string): Promise<void>
  pluginNoteOff?(key: number, channel: number, velocity?: number, instance?: string): Promise<void>
  isPluginActive?(role?: 'effect' | 'instrument', bus?: string, instance?: string): boolean
}

/** バックエンド選択 env。既定（未設定）は Rust daemon 経路。`sc` / `supercollider` で SC に opt-out。 */
export const ENGINE_ENV_VAR = 'ORBITSCORE_ENGINE'

export type EngineKind = 'supercollider' | 'rust'

/**
 * env 値をバックエンド種別へ正規化する。
 *
 * cutover #108: 既定を **Rust** に切替（native daemon が現行 `.orbs` DSL の audio 機能で
 * SC parity 到達を確認済み — offline oracle テスト + gated real-daemon timing の内訳は
 * WORK_LOG 6.181 参照）。SC 経路は温存し、`ORBITSCORE_ENGINE=sc`（または `supercollider`）
 * で明示 opt-out できる。未設定 / 未知値は既定の Rust。
 */
export function resolveEngineKind(raw: string | undefined): EngineKind {
  const v = raw?.trim().toLowerCase()
  return v === 'sc' || v === 'supercollider' ? 'supercollider' : 'rust'
}
