/**
 * Process-wide mutable state owned by the VS Code extension.
 *
 * Consumers read the exported bindings directly and update them through the
 * production setters below. Do not mock this module with
 * `vi.mock('./extension-state')`: spreading the actual module into a mock
 * copies each exported `let` at that instant and breaks its live binding.
 * Test-only setters remain separate because their deliberately loose types
 * are not production state-update contracts.
 */
import * as child_process from 'child_process'

import type * as vscode from 'vscode'

import { DeviceSwitchBridge } from './device-switch-bridge'
import { EngineStateBridge } from './engine-state-bridge'
import { EvalMarkBridge } from './eval-mark-bridge'
import type { EngineViewProvider } from './engine-view-provider'
import { OUTPUT_LOG_RING_MAX } from './log-ring'
import type { McpServerHandle } from './mcp-server'
import { PluginStateBridge } from './plugin-state-bridge'
import { PluginUiBridge } from './plugin-ui-bridge'

// Engine process management
export let engineProcess: child_process.ChildProcess | null = null
export let outputChannel: vscode.OutputChannel | null = null
export let statusBarItem: vscode.StatusBarItem | null = null
export let bundleStatusItem: vscode.StatusBarItem | null = null
export let devDocsPanel: vscode.WebviewPanel | null = null
export let isLiveCodingMode: boolean = false
// Tracks whether `var global = init GLOBAL` has been evaluated in the current engine session.
// Used to decide if `global.setDocumentDirectory(...)` can be prepended safely.
export let globalInitialized: boolean = false
export let transportPlaying: boolean = false
// Optional MCP control server (Agent Bridge). Non-null only while running.
export let mcpServerHandle: McpServerHandle | null = null
// Stateful FIFO/timeout/drain logic for the `//#selectAudioDevice` live bridge
// (#484 D2.5, extracted to device-switch-bridge.ts in PR #501 review so it's
// testable without mocking vscode). One instance for the extension's lifetime —
// drained on every engine exit/stop so a resolver from a dead engine can never
// FIFO-match a future engine's response.
export const selectAudioDeviceBridge = new DeviceSwitchBridge()
export const pluginStateBridge = new PluginStateBridge()
export const pluginUiBridge = new PluginUiBridge()
/** #614: `evaluate_orbitscore` に評価結果を返すための相関ブリッジ。 */
export const evalMarkBridge = new EvalMarkBridge()
export const engineStateBridge = new EngineStateBridge()
// Audio Engine Settings TreeView (#484 D3). Non-null once activated.
export let engineViewProvider: EngineViewProvider | null = null
// Changes whenever a spawn is created or a user explicitly stops the engine.
// Auto-start's delayed health check uses it to avoid warning about a later action.
export let engineGeneration = 0
// #463 C3: show the "no plugin catalog yet, run rescan" hint at most once per
// activation (loadPluginCatalog() is cheap but the info popup shouldn't nag on
// every keystroke while typing an effect()/instrument() argument).
export let pluginCatalogHintShown = false

// let isDebugMode: boolean = false // Debug mode flag

// Ring buffer of output-channel lines for the MCP get_log tool (#388). There is
// no other central log sink to tap, so activate() monkey-patches
// outputChannel.appendLine/append to also push here.
export const outputLogRing: string[] = []

export function pushLogRing(line: string): void {
  outputLogRing.push(line)
  if (outputLogRing.length > OUTPUT_LOG_RING_MAX) {
    outputLogRing.shift()
  }
}

export function isEngineRunning(): boolean {
  return engineProcess !== null && !engineProcess.killed
}

export function setEngineProcess(process: child_process.ChildProcess | null): void {
  engineProcess = process
}

export function setOutputChannel(channel: vscode.OutputChannel | null): void {
  outputChannel = channel
}

export function setStatusBarItem(item: vscode.StatusBarItem | null): void {
  statusBarItem = item
}

export function setBundleStatusItem(item: vscode.StatusBarItem | null): void {
  bundleStatusItem = item
}

export function setDevDocsPanel(panel: vscode.WebviewPanel | null): void {
  devDocsPanel = panel
}

export function setLiveCodingMode(value: boolean): void {
  isLiveCodingMode = value
}

export function setGlobalInitialized(value: boolean): void {
  globalInitialized = value
}

export function setTransportPlaying(value: boolean): void {
  transportPlaying = value
}

export function setMcpServerHandle(handle: McpServerHandle | null): void {
  mcpServerHandle = handle
}

export function setEngineViewProvider(provider: EngineViewProvider | null): void {
  engineViewProvider = provider
}

export function bumpEngineGeneration(): void {
  engineGeneration += 1
}

export function setPluginCatalogHintShown(value: boolean): void {
  pluginCatalogHintShown = value
}

export function __setEngineProcessForTest(process: child_process.ChildProcess | null): void {
  engineProcess = process
}
export function __getEngineProcessForTest(): child_process.ChildProcess | null {
  return engineProcess
}
export function __setStatusBarItemForTest(
  item: Pick<vscode.StatusBarItem, 'text' | 'tooltip'> | null,
): void {
  statusBarItem = item as unknown as vscode.StatusBarItem | null
}
export function __setOutputChannelForTest(
  channel: Pick<vscode.OutputChannel, 'appendLine' | 'append'> | null,
): void {
  outputChannel = channel as unknown as vscode.OutputChannel | null
}
export function __setEngineViewProviderForTest(
  provider: Pick<EngineViewProvider, 'refresh'> | null,
): void {
  engineViewProvider = provider as unknown as EngineViewProvider | null
}
/** Exposes the real singleton bridge so a spec can prove drainDeviceBridge
 * wiring by observing a pending `send()` actually resolve, rather than just
 * asserting the handler doesn't throw. */
export function __getDeviceSwitchBridgeForTest(): DeviceSwitchBridge {
  return selectAudioDeviceBridge
}
/** Same rationale as the device bridge seam above, for the plugin UI bridge
 * (#601 review I5): proves the three drainAll call sites and the stdout
 * handleLine dispatch by observing a pending `send()` resolve. */
export function __getPluginUiBridgeForTest(): PluginUiBridge {
  return pluginUiBridge
}
export function __setLiveCodingModeForTest(value: boolean): void {
  isLiveCodingMode = value
}
