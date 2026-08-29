/**
 * Protocol v0.1 type definitions mirroring `rust/crates/orbit-audio-daemon/src/protocol.rs`.
 *
 * Single source of truth: `docs/research/ENGINE_DAEMON_PROTOCOL.md`.
 * 型のドリフト検出はレビューで担保する（機械的同期は今は行わない）。
 */

export const PROTOCOL_VERSION = '0.2' as const

export interface HandshakeFrame {
  type: 'handshake'
  protocol_version: string
  daemon_version: string
  capabilities: string[]
}

/** Protocol v0.2 で daemon が受け付ける method 名。 */
export type CommandMethod =
  | 'LoadSample'
  | 'LoadPlugin'
  | 'ApplyEffectChain'
  | 'ReplacePlugin'
  | 'UnloadPlugin'
  | 'GetPluginState'
  | 'RenderScore'
  | 'OpenPluginUI'
  | 'ClosePluginUI'
  | 'AckUiSafepoint'
  // ランタイムの mixer bus routing 変更（MX.4・#459/#453 M3）: seq_bus の output(sum)/
  // sends(aux) を非 RT で書き換える。daemon が feature `outproc-effect` 無効ビルドなら
  // OUTPROC_EFFECT_UNAVAILABLE を返す。
  | 'SetBusRouting'
  // premaster source の `(source, unit)` を named insert bus または master(null) へ向ける
  // 土台 routing（#643）。source は daemon が解釈しない opaque key。
  | 'SetSourceRouting'
  | 'PluginNoteOn'
  | 'PluginNoteOff'
  | 'UnloadSample'
  | 'PlayAt'
  | 'Stop'
  // 全アクティブ再生の即時停止（hard-stop-all）。respawn / stopAll で in-flight voice を断つ。
  | 'StopAll'
  | 'SetGlobalGain'
  // LinkAudio outputChannel を daemon に登録する（#209・A4-2b-2）。daemon が
  // feature `link-audio` 無効なら LINK_AUDIO_UNAVAILABLE、runtime 失敗なら LINK_AUDIO_RUNTIME を返す。
  | 'RegisterLinkAudioChannel'
  // OrbitScore の global.tempo を Link に push してテンポリーダーになる（#283・A4-PR3）。
  // daemon が feature `link-audio` 無効なら LINK_AUDIO_UNAVAILABLE、runtime 失敗なら LINK_AUDIO_RUNTIME を返す。
  | 'SetLinkTempo'
  | 'GetStatus'
  | 'Ping'
  // gated な fault 注入（recovery floor の kill-test 専用）。daemon 側で
  // ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1 のときだけ受理し、それ以外は MALFORMED_REQUEST。
  | 'InjectFault'
  // cpal output device 列挙（#484 D1）。起動時 device 選択（`--audio-device`）とは別経路 —
  // 一覧を返すのみで、選択は起動引数（ランタイム切替は D2 の `SelectAudioDevice`）。
  | 'ListAudioDevices'
  // ランタイムのオーディオデバイス切替（#484 D2）。daemon プロセスを再起動せず cpal
  // Device/Stream だけを差し替える。`{ device: string }`（空文字列 = システム既定）。
  // ORBIT_CAPTURE_WAV 有効時は AUDIO_DEVICE_SWITCH_UNAVAILABLE を返す（未対応・#484 D2 ブリーフ選択(a)）。
  | 'SelectAudioDevice'

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
  event:
    | 'PlayStarted'
    | 'PlayEnded'
    | 'StreamStats'
    | 'DaemonError'
    | 'PluginUiClosed'
    | 'PluginUiCloseDone'
    | 'PluginUiClosedByRespawn'
  data: Record<string, unknown>
}

/** startup 成功時に stdout に 1 行出る JSON。 */
export interface StartupReadyLine {
  ready: true
  port: number
  protocol_version: string
}

/** startup 失敗時に stdout の ready-line 位置に出力される JSON (失敗時は ready:false)。 */
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
