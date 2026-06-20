/**
 * Rust audio daemon client + backend adapter。
 *
 * `DaemonClient` は orbit-audio-daemon (WebSocket protocol v0.1) との通信を担う。
 * `RustEnginePlayer` はそれを `AudioEngineBackend`（Scheduler + AudioEngine 面）へ
 * ラップした音声バックエンド adapter（S2 / Issue #296）。`ORBITSCORE_ENGINE=rust` で
 * `createAudioEngine()` 経由で選択される。
 */

export { DaemonClient } from './daemon-client'
export type { DaemonClientOptions } from './daemon-client'
export { RustEnginePlayer } from './rust-engine-player'
export type { RustEnginePlayerOptions, DispatchInfo } from './rust-engine-player'
export {
  DaemonConnectionError,
  DaemonNotFoundError,
  DaemonProtocolError,
  DaemonQuitError,
  DaemonStartupError,
} from './errors'
export { PROTOCOL_VERSION, isEventFrame, isHandshakeFrame, isResponseFrame } from './protocol-types'
export type {
  CommandFrame,
  CommandMethod,
  EventFrame,
  HandshakeFrame,
  ResponseFrame,
  StartupErrorLine,
  StartupReadyLine,
} from './protocol-types'
