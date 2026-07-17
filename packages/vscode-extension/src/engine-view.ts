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
  return [buildEngineStatusNode(engineRunning), buildDeviceSectionNode()]
}

export function buildEngineStatusNode(engineRunning: boolean): EngineViewNode {
  return {
    kind: 'engine-status',
    id: 'engine-status',
    label: engineRunning ? 'Engine: Running' : 'Engine: Stopped',
    description: engineRunning ? 'Click to stop' : 'Click to start',
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
  return state.devices.map((device) => buildDeviceNode(device, selectedDevice))
}

/**
 * A device is "selected" if its name matches the configured device exactly,
 * or — when nothing is configured (`selectedDevice === ''`, meaning "system
 * default") — if it is the host's default output device.
 */
export function buildDeviceNode(device: EngineViewDevice, selectedDevice: string): EngineViewNode {
  const selected = selectedDevice === '' ? device.isDefault : device.name === selectedDevice
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
