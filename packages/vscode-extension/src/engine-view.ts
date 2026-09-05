/**
 * Pure data-shaping helpers for the "Audio Engine Settings" TreeView (#484 D3).
 *
 * Kept vscode-free (like `playhead.ts`) so the tree-content logic can be unit
 * tested without mocking the `vscode` module. `extension.ts` maps
 * `EngineViewNode`s to `vscode.TreeItem` and owns all vscode-specific state
 * (process handles, `onDidChangeTreeData`, async device fetch).
 */

/** One device entry, wire-compatible with `AudioDeviceListEntry`
 * (`packages/engine/src/audio/rust-engine/daemon-client.ts`) and the
 * `--list-audio-devices` CLI JSON (`rust/crates/orbit-audio-daemon/src/main.rs`). */
export interface EngineViewDevice {
  name: string
  isDefault: boolean
  maxOutputChannels: number
  defaultSampleRate: number
  direction: 'output' | 'input'
}

export type EngineViewNodeKind =
  | 'engine-status'
  | 'debug-toggle'
  | 'device-section'
  | 'recovery-section'
  | 'recovery-action'
  | 'device'
  | 'device-loading'
  | 'device-error'
  | 'device-empty'

export interface EngineViewNode {
  kind: EngineViewNodeKind
  /** Stable id — used by `extension.ts` to route command args (e.g. which device was clicked). */
  id: string
  label: string
  description?: string
  /** Only meaningful for `kind: 'device'` — true if this is the currently-configured device. */
  selected?: boolean
  /** Whether the node should render as an expandable tree item. */
  collapsible: boolean
  /** Initial expansion for collapsible nodes. */
  collapsibleState?: 'expanded' | 'collapsed'
}

/** Root-level nodes shown at all times once the engine view has a live TreeDataProvider. */
export function buildRootNodes(engineRunning: boolean): EngineViewNode[] {
  return [
    buildEngineStatusNode(engineRunning),
    buildDebugToggleNode(false),
    buildDeviceSectionNode(),
    buildRecoverySectionNode(),
  ]
}

export function buildEngineStatusNode(engineRunning: boolean): EngineViewNode {
  return {
    kind: 'engine-status',
    id: 'engine-status',
    label: engineRunning ? 'Engine: Running' : 'Engine: Off',
    description: engineRunning ? 'Click to stop' : 'Click to start',
    collapsible: false,
  }
}

export function buildDebugToggleNode(enabled: boolean): EngineViewNode {
  return {
    kind: 'debug-toggle',
    id: 'debug-toggle',
    label: 'Debug mode',
    description: enabled ? 'On (restart engine to apply)' : 'Off',
    selected: enabled,
    collapsible: false,
  }
}

export function buildDeviceSectionNode(): EngineViewNode {
  return {
    kind: 'device-section',
    id: 'device-section',
    label: 'Output Device',
    collapsible: true,
  }
}

export function buildRecoverySectionNode(): EngineViewNode {
  return {
    kind: 'recovery-section',
    id: 'recovery-section',
    label: 'Recovery',
    collapsible: true,
    collapsibleState: 'collapsed',
  }
}

/** Visible emergency actions, kept pure so their presentation is unit-tested. */
export function recoverySectionChildren(): EngineViewNode[] {
  return [
    {
      kind: 'recovery-action',
      id: 'recovery-action:orbitscore.restartEngine',
      label: 'Restart Engine',
      description: 'Force-restart a stuck engine',
      collapsible: false,
    },
    {
      kind: 'recovery-action',
      id: 'recovery-action:orbitscore.reloadWindow',
      label: 'Reload Window',
      description: 'Restart the extension',
      collapsible: false,
    },
  ]
}

export function recoveryCommandFromNodeId(nodeId: string): string | null {
  if (!nodeId.startsWith('recovery-action:')) return null
  return nodeId.slice('recovery-action:'.length)
}

/** Fetch state for the device list, populated by `extension.ts` when the
 * "Output Device" node is expanded (lazy — no polling, per #484 D3 task spec). */
export type DeviceFetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; devices: EngineViewDevice[] }

/**
 * Children of the "Output Device" node. `selectedDevice` is the resolved
 * `orbitscore.audioDevice` setting value (empty string = system default —
 * see `resolveAudioDeviceSetting` in extension.ts for the VS Code
 * setting / `.orbitscore.json` precedence).
 */
export function deviceSectionChildren(
  state: DeviceFetchState,
  selectedDevice: string,
): EngineViewNode[] {
  if (state.status === 'loading') {
    return [
      {
        kind: 'device-loading',
        id: 'device-loading',
        label: 'Loading devices…',
        collapsible: false,
      },
    ]
  }
  if (state.status === 'error') {
    return [
      {
        kind: 'device-error',
        id: 'device-error',
        label: `⚠️ ${state.message}`,
        collapsible: false,
      },
    ]
  }
  if (state.devices.length === 0) {
    return [
      {
        kind: 'device-empty',
        id: 'device-empty',
        label: 'No audio devices found',
        collapsible: false,
      },
    ]
  }
  return [
    {
      kind: 'device',
      id: 'device:__default__',
      label: `${selectedDevice === '__default__' ? '● ' : ''}System Default`,
      description: 'Use the operating system default output',
      selected: selectedDevice === '__default__',
      collapsible: false,
    },
    ...state.devices.map((device) => buildDeviceNode(device, selectedDevice)),
  ]
}

/**
 * A device is "selected" if its name matches the configured device exactly,
 * or — when nothing is configured (`selectedDevice === ''`, meaning "system
 * default") — if it is the host's default output device.
 */
export function buildDeviceNode(device: EngineViewDevice, selectedDevice: string): EngineViewNode {
  const selected = device.name === selectedDevice
  const labelSuffix = device.isDefault ? ' (system default)' : ''
  return {
    kind: 'device',
    id: `device:${device.name}`,
    label: `${selected ? '● ' : ''}${device.name}${labelSuffix}`,
    description: `${device.maxOutputChannels}ch · ${device.defaultSampleRate}Hz`,
    selected,
    collapsible: false,
  }
}

/** Extract the device name from a `device:<name>` node id — the inverse of `buildDeviceNode`'s id. */
export function deviceNameFromNodeId(nodeId: string): string | null {
  if (!nodeId.startsWith('device:')) return null
  return nodeId.slice('device:'.length)
}

export type DeviceClickAction = 'start' | 'live-switch' | 'deselect-stop' | 'none'

/** The selection-is-power state machine used by both the TreeView and MCP. */
export function resolveDeviceClickAction(
  clickedDevice: string,
  selectedDevice: string,
  engineRunning: boolean,
): DeviceClickAction {
  if (clickedDevice === selectedDevice) return 'deselect-stop'
  if (!engineRunning) return 'start'
  return 'live-switch'
}

/** Result payload embedded in the engine's `{"selectAudioDevice":{...}}` stdout line (#484 D2.5). */
export interface SelectAudioDeviceBridgeResult {
  ok: boolean
  device?: string
  error?: string
}

/**
 * Parse a raw engine stdout line for the `//#selectAudioDevice` bridge's JSON result
 * (emitted by `repl-mode.ts`'s `executeSelectAudioDeviceMeta`). Returns `undefined` for
 * any other line — the vast majority of stdout traffic — including parse failures.
 */
export function parseSelectAudioDeviceResultLine(
  rawLine: string,
): SelectAudioDeviceBridgeResult | undefined {
  const trimmed = rawLine.trim()
  if (!trimmed.startsWith('{') || !trimmed.includes('selectAudioDevice')) return undefined
  let parsed: { selectAudioDevice?: SelectAudioDeviceBridgeResult }
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  return parsed.selectAudioDevice
}

/** Sentinel embedded in the daemon's error string when a live device switch is
 * refused because `ORBIT_CAPTURE_WAV` recording is active (#484 D2 brief choice
 * (a)). Shared between `translateSelectAudioDeviceError` and `extension.ts`'s
 * restart-prompt branch so the two checks can't drift out of sync. */
export const AUDIO_DEVICE_SWITCH_UNAVAILABLE = 'AUDIO_DEVICE_SWITCH_UNAVAILABLE'
export const AUDIO_DEVICE_STREAM_DEAD = 'AUDIO_DEVICE_STREAM_DEAD'
export const AUDIO_DEVICE_RATE_MISMATCH = 'AUDIO_DEVICE_RATE_MISMATCH'
export const AUDIO_DEVICE_UNAVAILABLE = 'AUDIO_DEVICE_UNAVAILABLE'
export const AUDIO_DEVICE_SWITCH_RECOVERY_FAILED = 'AUDIO_DEVICE_SWITCH_RECOVERY_FAILED'

interface SelectAudioDeviceErrorKind {
  readonly code: string
  /** エンジンを再起動しないと直らないか。 */
  readonly needsRestart: boolean
  readonly message: (error: string) => string
}

/**
 * ライブ切替の失敗コードの**唯一の表**。文言・再起動の要否・「既知かどうか」の 3 つは
 * すべてここから引く（分岐を 3 箇所に書くと、コードを足した時に片方だけ更新される）。
 *
 * 🔴 `needsRestart` を分ける軸は「**いま鳴っている音を止めずに直せるか**」
 * （owner 裁定 2026-09-05・設計 `docs/design/661-audio-device-liveness-design.md` §3）。
 * 音が鳴り続けている失敗に「Restart Engine」を出すと、F4 が守ろうとした
 * 「演奏中のタイプミスで音が止まらない」を **UI が自分で壊す**（再起動すると起動経路の
 * ポリシーで host 既定へ移る）。
 *
 * 順序が意味を持つ: 先に一致したものが採用される。`SWITCH_RECOVERY_FAILED` は
 * 「切替も復帰も失敗した」= 音が**止まっている**ので、他より先に判定する。
 */
const SELECT_AUDIO_DEVICE_ERRORS: readonly SelectAudioDeviceErrorKind[] = [
  {
    code: AUDIO_DEVICE_SWITCH_RECOVERY_FAILED,
    needsRestart: true,
    message: (error) =>
      `切替に失敗し、元の出力も再開できませんでした — エンジンを再起動してください (${error})`,
  },
  {
    code: AUDIO_DEVICE_SWITCH_UNAVAILABLE,
    needsRestart: true,
    message: () => '録音中は切替できません — エンジンを再起動してください',
  },
  {
    code: AUDIO_DEVICE_UNAVAILABLE,
    needsRestart: false,
    message: (error) => `指定したデバイスが見つかりません — 元の出力を継続します (${error})`,
  },
  {
    code: AUDIO_DEVICE_STREAM_DEAD,
    needsRestart: false,
    message: (error) =>
      `デバイスから音声コールバックが届きません — 元の出力を継続します (${error})`,
  },
  {
    code: AUDIO_DEVICE_RATE_MISMATCH,
    needsRestart: true,
    message: (error) =>
      `サンプルレートが異なるため切替できません — エンジンを再起動してください (${error})`,
  },
]

function matchSelectAudioDeviceError(
  error: string | undefined,
): SelectAudioDeviceErrorKind | undefined {
  if (!error) return undefined
  return SELECT_AUDIO_DEVICE_ERRORS.find((kind) => error.includes(kind.code))
}

/**
 * User-facing translation for the daemon's live device-switch errors. Unknown errors pass
 * through unchanged so real failures aren't masked.
 */
export function translateSelectAudioDeviceError(error: string | undefined): string {
  const kind = matchSelectAudioDeviceError(error)
  if (kind && error) return kind.message(error)
  return error ?? 'live audio device switch failed'
}

/**
 * 「Restart Engine」を提示してよい失敗か。**未知のエラーは true**（何が起きたか分からないので
 * 従来どおり再起動を選べるようにする）。
 */
export function liveSwitchFailureNeedsRestart(error: string | undefined): boolean {
  return matchSelectAudioDeviceError(error)?.needsRestart ?? true
}

/**
 * 翻訳済みの文言を持つ既知のコードか。未知のエラーは文言だけでは何の失敗か分からないので、
 * 呼び出し側が「live device switch failed:」を前置する判断に使う。
 */
export function hasTranslatedSelectAudioDeviceError(error: string | undefined): boolean {
  return matchSelectAudioDeviceError(error) !== undefined
}
