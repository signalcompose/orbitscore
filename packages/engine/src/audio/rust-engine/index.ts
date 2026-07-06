/**
 * Rust audio daemon client + backend adapter。
 *
 * `DaemonClient` は orbit-audio-daemon (WebSocket protocol v0.1) との通信を担う。
 * `RustEnginePlayer` はそれを `AudioEngineBackend`（Scheduler + AudioEngine 面）へ
 * ラップした音声バックエンド adapter（S2 / Issue #296）。cutover #108 以降は
 * `createAudioEngine()` が既定で選ぶ（`ORBITSCORE_ENGINE=sc` で SC に opt-out）。
 */

export { DaemonClient } from './daemon-client'
export type { DaemonClientOptions } from './daemon-client'
export { RustEnginePlayer } from './rust-engine-player'
export type { RustEnginePlayerOptions, DispatchInfo } from './rust-engine-player'
export {
  DaemonConnectionError,
  DaemonNotExecutableError,
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
