/** VS Code provider and command wiring for the Audio Engine Settings view. */
import * as vscode from 'vscode'

import { logHandlerFailure } from './engine-handlers'
import {
  fetchAudioDevicesForView,
  resolveAudioDeviceSetting,
  sendSelectAudioDeviceMeta,
  startEngine,
  stopEngine,
} from './engine-process'
import {
  buildRootNodes,
  deviceNameFromNodeId,
  deviceSectionChildren,
  hasTranslatedSelectAudioDeviceError,
  liveSwitchFailureNeedsRestart,
  recoveryCommandFromNodeId,
  recoverySectionChildren,
  resolveDeviceClickAction,
  translateSelectAudioDeviceError,
  type DeviceFetchState,
  type EngineViewNode,
} from './engine-view'
import { engineViewProvider, isEngineRunning, outputChannel } from './extension-state'

/**
 * TreeDataProvider for the "Audio Engine Settings" view (#484 D3). Wraps the
 * vscode-free data shaping in `engine-view.ts`: `getChildren`/`getTreeItem`
 * translate `EngineViewNode`s to real `vscode.TreeItem`s and own the only
 * bit of state vscode needs — a per-expansion device-list cache, invalidated
 * on `refresh()` (called from `startEngine`/`stopEngine`/exit handler and the
 * device-select command) so a stale list never lingers across an engine
 * restart or device change. Devices are fetched lazily when the "Output
 * Device" node is expanded, not polled (per task spec — the daemon spawn for
 * enumeration is cheap but not free).
 */
class EngineViewProvider implements vscode.TreeDataProvider<EngineViewNode> {
  private readonly emitter = new vscode.EventEmitter<EngineViewNode | undefined>()
  readonly onDidChangeTreeData = this.emitter.event
  private deviceFetchState: DeviceFetchState | null = null

  refresh(): void {
    this.deviceFetchState = null
    this.emitter.fire(undefined)
  }

  getTreeItem(node: EngineViewNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.collapsible
        ? node.collapsibleState === 'collapsed'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    )
    item.id = node.id
    item.description = node.description
    switch (node.kind) {
      case 'engine-status':
        item.iconPath = new vscode.ThemeIcon(isEngineRunning() ? 'debug-stop' : 'play')
        item.command = { command: 'orbitscore.engineViewToggleEngine', title: 'Toggle Engine' }
        break
      case 'debug-toggle':
        item.iconPath = new vscode.ThemeIcon(node.selected ? 'check' : 'circle-large-outline')
        item.command = { command: 'orbitscore.engineViewToggleDebug', title: 'Toggle Debug Mode' }
        break
      case 'device-section':
        item.iconPath = new vscode.ThemeIcon('list-selection')
        break
      case 'recovery-section':
        item.iconPath = new vscode.ThemeIcon('tools')
        break
      case 'recovery-action': {
        const command = recoveryCommandFromNodeId(node.id)
        if (command) item.command = { command, title: node.label }
        break
      }
      case 'device':
        item.iconPath = new vscode.ThemeIcon(node.selected ? 'check' : 'circle-large-outline')
        item.command = {
          command: 'orbitscore.engineViewSelectDevice',
          title: 'Select Audio Device',
          arguments: [node],
        }
        break
      case 'device-error':
        item.iconPath = new vscode.ThemeIcon('warning')
        break
      default:
        break
    }
    return item
  }

  getChildren(node?: EngineViewNode): EngineViewNode[] | Thenable<EngineViewNode[]> {
    if (!node) {
      // viewsWelcome (Start/Debug/Stop buttons) covers the stopped state —
      // only populate the tree once the engine is actually running.
      return buildRootNodes(isEngineRunning()).map((node) =>
        node.kind === 'debug-toggle'
          ? {
              ...node,
              selected: vscode.workspace
                .getConfiguration('orbitscore')
                .get<boolean>('engineDebug', false),
              description: vscode.workspace
                .getConfiguration('orbitscore')
                .get<boolean>('engineDebug', false)
                ? 'On (restart engine to apply)'
                : 'Off',
            }
          : node,
      )
    }
    if (node.kind === 'device-section') {
      return this.getDeviceChildren()
    }
    if (node.kind === 'recovery-section') return recoverySectionChildren()
    return []
  }

  private async getDeviceChildren(): Promise<EngineViewNode[]> {
    if (!this.deviceFetchState) {
      try {
        const devices = await fetchAudioDevicesForView()
        this.deviceFetchState = { status: 'loaded', devices }
      } catch (err) {
        this.deviceFetchState = {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
    const selectedDevice = resolveAudioDeviceSetting(workspaceRoot)
    return deviceSectionChildren(this.deviceFetchState, selectedDevice)
  }
}

async function engineViewToggleEngine(): Promise<void> {
  if (isEngineRunning()) {
    stopEngine()
    return
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
  if (!resolveAudioDeviceSetting(workspaceRoot)) {
    vscode.window.showInformationMessage('Select an output device below first')
    return
  }
  await startEngine()
}

/**
 * Write `orbitscore.audioDevice` (Workspace scope when a workspace is open,
 * Global otherwise). Shared by the Engine view's device-click command and the
 * MCP `select_audio_device` tool's live-switch path (#501 review Important #6 —
 * the live bridge only affects the running process, so the setting must also
 * be written for the choice to survive an engine restart).
 */
async function writeAudioDeviceSetting(deviceName: string | undefined): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.[0]
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global
  try {
    await vscode.workspace.getConfiguration('orbitscore').update('audioDevice', deviceName, target)
    outputChannel?.appendLine(`🔊 orbitscore.audioDevice set to: ${deviceName ?? '(cleared)'}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ failed to update orbitscore.audioDevice: ${message}`)
    vscode.window.showErrorMessage(`Failed to save audio device setting: ${message}`)
  }
}

/**
 * "Select Audio Device" command wired to a device `TreeItem` click in the
 * Engine view (#484 D3). Writes `orbitscore.audioDevice` (Workspace scope
 * when a workspace is open, Global otherwise). For a running rust-engine
 * instance, D2.5's live `//#selectAudioDevice` bridge applies the change
 * immediately; otherwise (or on live-switch failure) this tells the user the
 * setting takes effect on the *next* engine start and offers an immediate
 * restart.
 */
async function engineViewSelectDevice(node: EngineViewNode): Promise<void> {
  const deviceName = deviceNameFromNodeId(node.id)
  if (!deviceName) return

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
  const selectedDevice = resolveAudioDeviceSetting(workspaceRoot)
  const action = resolveDeviceClickAction(deviceName, selectedDevice, isEngineRunning())
  if (action === 'deselect-stop') {
    await writeAudioDeviceSetting('')
    if (isEngineRunning()) stopEngine()
    engineViewProvider?.refresh()
    return
  }

  await writeAudioDeviceSetting(deviceName)
  engineViewProvider?.refresh()

  if (!isEngineRunning()) {
    await startEngine()
    return
  }

  // D2.5 (#484): try the live `//#selectAudioDevice` bridge before falling back to the
  // restart prompt.
  try {
    const result = await sendSelectAudioDeviceMeta(deviceName)
    if (result.ok) {
      engineViewProvider?.refresh()
      vscode.window.showInformationMessage(`🔊 switched to "${result.device ?? deviceName}"`)
      return
    }
    // #501 review Important #4: surface the specific failure rather than
    // silently falling through to the generic "applies on next start" prompt.
    outputChannel?.appendLine(`⚠️ live device switch failed: ${result.error}`)
    // 既知のコードは翻訳文だけで何が起きたか分かる。未知のエラーにだけ何の失敗かを前置する。
    const failureMessage = hasTranslatedSelectAudioDeviceError(result.error)
      ? translateSelectAudioDeviceError(result.error)
      : `🔊 live device switch failed: ${translateSelectAudioDeviceError(result.error)}`
    // 🔴 音が鳴り続けている失敗に「Restart Engine」を出さない（#661 F4・engine-view.ts の
    // `SELECT_AUDIO_DEVICE_ERRORS` 参照）。再起動すると起動経路のポリシーで host 既定へ移り、
    // 「演奏中のタイプミスで音が移らない」という裁定を UI が自分で壊す。
    if (!liveSwitchFailureNeedsRestart(result.error)) {
      void vscode.window.showWarningMessage(failureMessage)
      return
    }
    const choice = await vscode.window.showWarningMessage(failureMessage, 'Restart Engine')
    if (choice === 'Restart Engine') {
      stopEngine()
      setTimeout(
        () => void startEngine().catch((err) => logHandlerFailure('engineViewSelectDevice', err)),
        2200,
      )
    }
    return
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`⚠️ live device switch bridge error: ${message}`)
    const choice = await vscode.window.showWarningMessage(
      `🔊 live device switch bridge error: ${message}`,
      'Restart Engine',
    )
    if (choice === 'Restart Engine') {
      stopEngine()
      setTimeout(
        () => void startEngine().catch((err) => logHandlerFailure('engineViewSelectDevice', err)),
        2200,
      )
    }
    return
  }
}

async function engineViewToggleDebug(): Promise<void> {
  const config = vscode.workspace.getConfiguration('orbitscore')
  const next = !config.get<boolean>('engineDebug', false)
  const target = vscode.workspace.workspaceFolders?.[0]
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global
  try {
    await config.update('engineDebug', next, target)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ failed to update orbitscore.engineDebug: ${message}`)
    vscode.window.showErrorMessage(`Failed to save debug mode setting: ${message}`)
    return
  }
  engineViewProvider?.refresh()
  if (isEngineRunning()) {
    const choice = await vscode.window.showInformationMessage(
      'Restart engine to apply?',
      'Restart Engine',
    )
    if (choice === 'Restart Engine') {
      stopEngine()
      setTimeout(
        () => void startEngine().catch((err) => logHandlerFailure('engineViewToggleDebug', err)),
        2200,
      )
    }
  }
}

export {
  EngineViewProvider,
  engineViewSelectDevice,
  engineViewToggleDebug,
  engineViewToggleEngine,
  writeAudioDeviceSetting,
}
