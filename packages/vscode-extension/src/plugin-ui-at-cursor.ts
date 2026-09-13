/** Resolve and open exactly the plugin instance named under the editor cursor (#939). */
import * as vscode from 'vscode'

import { pluginUiForAgent } from './agent-handlers'
import { outputChannel } from './extension-state'
import type { PluginUiAtCursorResult } from './mcp-types'
import {
  findCatalogSpecSites,
  isStateFileSpec,
  normalizePluginInstanceNameForGuard,
  type CatalogSpecSite,
} from './plugin-name-diagnostics'

export const OPEN_PLUGIN_UI_AT_CURSOR_COMMAND = 'orbitscore.openPluginUiAtCursor'

export type PluginUiCursorTarget =
  | {
      readonly kind: 'instrument'
      readonly receiver: string
      readonly expectedName: string
      readonly site: CatalogSpecSite
    }
  | {
      readonly kind: 'effect'
      readonly receiver: string
      readonly chainPath: readonly number[]
      readonly expectedName: string
      readonly site: CatalogSpecSite
    }

export type PluginUiCursorFailure =
  | 'not-on-plugin-name'
  | 'standard-plugin'
  | 'state-file'
  | 'selection-spans-outside'
  | 'unresolved-receiver'

export type PluginUiCursorResolution =
  | { readonly ok: true; readonly target: PluginUiCursorTarget }
  | { readonly ok: false; readonly reason: PluginUiCursorFailure; readonly message: string }

export interface CursorSelection {
  readonly active: { readonly line: number; readonly character: number }
  readonly anchor: { readonly line: number; readonly character: number }
}

const NOT_ON_PLUGIN_MESSAGE =
  'The cursor is not on a plugin name. Place it on a "name" inside effect([...]) or instrument(...).'

/** 0-based VS Code positions in, syntax path out. No engine or VS Code state is read here. */
export function resolvePluginUiTargetAtCursor(
  text: string,
  selection: CursorSelection,
): PluginUiCursorResolution {
  const sites = findCatalogSpecSites(text)
  const selected = !samePosition(selection.active, selection.anchor)
  const site = selected
    ? sites.find(
        (candidate) =>
          positionWithinSite(selection.active, candidate, true) &&
          positionWithinSite(selection.anchor, candidate, true),
      )
    : sites.find((candidate) => positionWithinSite(selection.active, candidate, false))

  if (selected && !site) {
    return {
      ok: false,
      reason: 'selection-spans-outside',
      message: 'Collapse the selection to a cursor on one plugin name.',
    }
  }
  if (!site) {
    if (isOnStandardPluginWord(text, selection.active)) {
      return {
        ok: false,
        reason: 'standard-plugin',
        message:
          'Standard plugins (Gain, ...) have no UI; their parameters live in the score (SC.10.8).',
      }
    }
    return { ok: false, reason: 'not-on-plugin-name', message: NOT_ON_PLUGIN_MESSAGE }
  }
  if (isStateFileSpec(site.spec)) {
    return {
      ok: false,
      reason: 'state-file',
      message: `"${site.spec}" is a saved state file, not a plugin. Place the cursor on the plugin name.`,
    }
  }
  if (!site.receiver) {
    return {
      ok: false,
      reason: 'unresolved-receiver',
      message:
        'Could not tell which sequence or bus this chain belongs to; keep receiver.effect([...]) on one line.',
    }
  }

  const expectedName = normalizePluginInstanceNameForGuard(site.spec)
  return site.role === 'instrument'
    ? { ok: true, target: { kind: 'instrument', receiver: site.receiver, expectedName, site } }
    : {
        ok: true,
        target: {
          kind: 'effect',
          receiver: site.receiver,
          chainPath: site.chainPath,
          expectedName,
          site,
        },
      }
}

/** The sole cursor-route conversion from syntax paths to UIH.5 compatibility indexes. */
export function pluginUiAddressFor(
  target: PluginUiCursorTarget,
):
  | { ok: true; receiver: string; index: number; expectedName: string }
  | { ok: false; message: string } {
  if (target.kind === 'instrument') {
    return { ok: true, receiver: target.receiver, index: 0, expectedName: target.expectedName }
  }
  if (target.chainPath.length !== 1) {
    return {
      ok: false,
      message:
        'layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only',
    }
  }
  return {
    ok: true,
    receiver: target.receiver,
    index: (target.chainPath[0] ?? 0) + 1,
    expectedName: target.expectedName,
  }
}

/** VS Code command body used by both the editor context menu and MCP. */
export async function openPluginUiAtCursor(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
  positionArg?: { readonly line: number; readonly character: number },
): Promise<PluginUiAtCursorResult> {
  if (!editor || editor.document.languageId !== 'orbitscore') {
    return reportFailure('Open an OrbitScore (.orbs) file and place the cursor on a plugin name.')
  }

  const selection = isPositionArg(positionArg)
    ? { active: positionArg, anchor: positionArg }
    : editor.selection
  const resolution = resolvePluginUiTargetAtCursor(editor.document.getText(), selection)
  if (!resolution.ok) return reportFailure(resolution.message)

  const address = pluginUiAddressFor(resolution.target)
  if (!address.ok) return reportFailure(address.message)

  const engineResult = await pluginUiForAgent(
    'open',
    address.receiver,
    address.index,
    address.expectedName,
  )
  if (!engineResult.ok) {
    return reportFailure(engineResult.error, engineResult.code, engineResult.details)
  }

  const returnedFields = isRecord(engineResult.result)
    ? engineResult.result
    : { result: engineResult.result }
  return {
    ...returnedFields,
    ok: true,
    receiver: address.receiver,
    index: address.index,
    chain_path: resolution.target.kind === 'instrument' ? [] : [...resolution.target.chainPath],
    normalizedName: address.expectedName,
    site: {
      line: resolution.target.site.line + 1,
      startCol: resolution.target.site.startCol + 1,
      endCol: resolution.target.site.endCol + 1,
    },
  }
}

/** MCP handler: deliberately cross the registered command boundary. */
export async function openPluginUiAtCursorForAgent(): Promise<PluginUiAtCursorResult> {
  const result = await vscode.commands.executeCommand<PluginUiAtCursorResult>(
    OPEN_PLUGIN_UI_AT_CURSOR_COMMAND,
  )
  return result
}

function reportFailure(message: string, code?: string, details?: unknown): PluginUiAtCursorResult {
  const visible = `OrbitScore: ${message}`
  void vscode.window.showErrorMessage(visible)
  outputChannel?.appendLine(`❌ ${visible}`)
  return {
    ok: false,
    error: message,
    ...(code ? { code } : {}),
    ...(details === undefined ? {} : { details }),
  }
}

function samePosition(a: CursorSelection['active'], b: CursorSelection['active']): boolean {
  return a.line === b.line && a.character === b.character
}

function positionWithinSite(
  position: CursorSelection['active'],
  site: CatalogSpecSite,
  allowEnd: boolean,
): boolean {
  return (
    position.line === site.line &&
    position.character >= site.startCol &&
    (allowEnd ? position.character <= site.endCol : position.character < site.endCol)
  )
}

function isPositionArg(
  value: unknown,
): value is { readonly line: number; readonly character: number } {
  return (
    isRecord(value) &&
    Number.isInteger(value.line) &&
    Number(value.line) >= 0 &&
    Number.isInteger(value.character) &&
    Number(value.character) >= 0
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Find an uppercase call word on the cursor's line without looking inside strings/comments. */
function isOnStandardPluginWord(text: string, position: CursorSelection['active']): boolean {
  const line = text.split('\n')[position.line]
  if (line === undefined) return false
  let i = 0
  while (i < line.length) {
    if (line[i] === '/' && line[i + 1] === '/') return false
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i]
      i += 1
      while (i < line.length && line[i] !== quote) i += line[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (/[A-Z]/.test(line[i] ?? '')) {
      const start = i
      i += 1
      while (/[A-Za-z0-9_$]/.test(line[i] ?? '')) i += 1
      const end = i
      while (/\s/.test(line[i] ?? '')) i += 1
      if (line[i] === '(' && position.character >= start && position.character < end) return true
      continue
    }
    i += 1
  }
  return false
}
