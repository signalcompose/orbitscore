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
}

/** Root-level nodes shown at all times once the engine view has a live TreeDataProvider. */
export function buildRootNodes(engineRunning: boolean): EngineViewNode[] {
  return [
    buildEngineStatusNode(engineRunning),
    buildDebugToggleNode(false),
    buildDeviceSectionNode(),
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

/**
 * User-facing translation for the daemon's `AUDIO_DEVICE_SWITCH_UNAVAILABLE` error
 * (raised while `ORBIT_CAPTURE_WAV` recording is active — the daemon refuses to tear
 * down the stream mid-capture, #484 D2 brief choice (a)). Other errors pass through
 * unchanged so real failures aren't masked.
 */
export function translateSelectAudioDeviceError(error: string | undefined): string {
  if (error && error.includes(AUDIO_DEVICE_SWITCH_UNAVAILABLE)) {
    return '録音中は切替できません — エンジンを再起動してください'
  }
  return error ?? 'live audio device switch failed'
}
