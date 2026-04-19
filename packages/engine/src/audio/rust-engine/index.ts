/**
 * Rust audio daemon client — Phase 1 scaffold.
 *
 * `DaemonClient` は orbit-audio-daemon (WebSocket protocol v0.1) との通信を担う。
 * `AudioEngine + Scheduler` を満たす adapter は Phase 2 で実装する。
 */

export { DaemonClient } from './daemon-client'
export type { DaemonClientOptions } from './daemon-client'
export {
  DaemonNotFoundError,
  DaemonProtocolError,
  DaemonQuitError,
  DaemonStartupError,
} from './errors'
export { PROTOCOL_VERSION, isEventFrame, isHandshakeFrame, isResponseFrame } from './protocol-types'
export type {
  CommandFrame,
  EventFrame,
  HandshakeFrame,
  ResponseFrame,
  StartupErrorLine,
  StartupReadyLine,
} from './protocol-types'
