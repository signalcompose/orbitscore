/**
 * Protocol v0.1 type definitions mirroring `rust/crates/orbit-audio-daemon/src/protocol.rs`.
 *
 * Single source of truth: `docs/research/ENGINE_DAEMON_PROTOCOL.md`.
 * 型のドリフト検出はレビューで担保する（機械的同期は今は行わない）。
 */

export const PROTOCOL_VERSION = '0.1' as const

export interface HandshakeFrame {
  type: 'handshake'
  protocol_version: string
  daemon_version: string
  capabilities: string[]
}

/** Protocol v0.1 で daemon が受け付ける method 名。 */
export type CommandMethod =
  | 'LoadSample'
  | 'UnloadSample'
  | 'PlayAt'
  | 'Stop'
  | 'SetGlobalGain'
  | 'GetStatus'
  | 'Ping'

export interface CommandFrame {
  id: string
  method: CommandMethod
  params: Record<string, unknown>
}

export interface OkResponse {
  id: string
  result: Record<string, unknown>
}

export interface ErrorResponse {
  id: string
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type ResponseFrame = OkResponse | ErrorResponse

export interface EventFrame {
  type: 'event'
  event: 'PlayStarted' | 'PlayEnded' | 'StreamStats' | 'DaemonError'
  data: Record<string, unknown>
}

/** startup 成功時に stdout に 1 行出る JSON。 */
export interface StartupReadyLine {
  ready: true
  port: number
  protocol_version: string
}

/** startup 失敗時に stderr に 1 行出る JSON。 */
export interface StartupErrorLine {
  ready: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export function isResponseFrame(v: unknown): v is ResponseFrame {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  // `type` 付きフレーム (handshake / event) は除外する。将来 `id` を持つ
  // typed フレームが追加されても誤 routing しないよう、discriminant の
  // 不在を積極的に確認する。
  return 'id' in o && !('type' in o)
}

export function isEventFrame(v: unknown): v is EventFrame {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'event'
}

export function isHandshakeFrame(v: unknown): v is HandshakeFrame {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'handshake'
}
