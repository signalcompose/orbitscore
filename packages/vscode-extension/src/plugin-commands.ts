/**
 * VS Code command and agent wiring for plugin catalog operations.
 *
 * Function bodies are moved unchanged from extension.ts. Helpers that were
 * module-private are exported only so the extension root can preserve its
 * existing wiring across the new module boundary.
 */
import * as path from 'path'

import * as vscode from 'vscode'

import {
  buildPluginPickItems,
  detectRackArgContext,
  RACK_SCAN_MAX_LINES,
  type PluginVerb,
} from './plugin-catalog-completion'
import { loadPluginCatalog, runPluginScan } from './plugin-catalog-reader'
import { outputChannel, setPluginCatalogHintShown } from './extension-state'
import type { ListPluginsResult, RescanPluginsResult } from './mcp-server'

/**
 * "OrbitScore: Browse Plugins" command (#638) — palette entry that lists the
 * catalog and writes the chosen name at the cursor.
 *
 * Completion covers "I remember part of the name"; this covers "what do I even
 * have". With 274 effects and 74 instruments installed, the second question is
 * the common one and had no entry point at all.
 *
 * When the cursor already sits inside an `effect(` / `instrument(` string the
 * verb comes from there and the typed fragment is replaced, so picking from the
 * list and completing produce the same edit. Outside that context the command
 * asks which kind to browse and inserts a quoted name.
 */
async function browsePlugins(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showInformationMessage('OrbitScore: open an .orbs file to insert a plugin name.')
    return
  }

  const catalog = loadPluginCatalog()
  if (!catalog) {
    vscode.window.showWarningMessage(
      'OrbitScore: no plugin catalog found. Run "OrbitScore: Rescan Plugin Catalog" first.',
    )
    return
  }

  const position = editor.selection.active
  const firstRow = Math.max(0, position.line - RACK_SCAN_MAX_LINES)
  const lines: string[] = []
  for (let row = firstRow; row <= position.line; row += 1) {
    lines.push(editor.document.lineAt(row).text)
  }
  const context = detectRackArgContext(lines, position.line - firstRow, position.character)

  let verb: PluginVerb
  if (context) {
    verb = context.verb
  } else {
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'effect', description: 'insert seq.effect("...")' },
        { label: 'instrument', description: 'insert seq.instrument("...")' },
      ],
      { title: 'OrbitScore: browse which kind of plugin?' },
    )
    if (!picked) return
    verb = picked.label as PluginVerb
  }

  const items = buildPluginPickItems(catalog.plugins, verb)
  if (items.length === 0) {
    vscode.window.showWarningMessage(
      `OrbitScore: the plugin catalog has no ${verb} plugins. Run "OrbitScore: Rescan Plugin Catalog".`,
    )
    return
  }

  const choice = await vscode.window.showQuickPick(items, {
    title: `OrbitScore: ${verb} plugins (${items.length})`,
    matchOnDescription: true,
    placeHolder: 'Type to filter by name or vendor',
  })
  if (!choice) return

  await editor.edit((edit) => {
    if (context) {
      // Replace what has been typed inside the quotes, exactly as completion would.
      edit.replace(
        new vscode.Range(new vscode.Position(position.line, context.quoteStartChar), position),
        choice.insertText,
      )
    } else {
      edit.insert(position, `"${choice.insertText}"`)
    }
  })
}

/**
 * "OrbitScore: Rescan Plugin Catalog" command (#463 C1b) — palette + editor
 * right-click menu. Spawns `orbit-plugin-scan` directly (not via the daemon:
 * the scanner is an independent crash-isolated binary — see
 * docs/core/INSTRUCTION_ORBITSCORE_DSL.md §PC.1) and invalidates the
 * in-memory catalog cache on success so completion picks up the fresh scan.
 */
async function rescanPlugins(): Promise<void> {
  outputChannel?.appendLine('🔎 Rescanning plugin catalog...')
  const result = await runPluginScan()
  if (result.ok) {
    setPluginCatalogHintShown(false)
    const summary = result.summary
    const duration = `p50=${summary.durationMs.p50 ?? '-'}ms p95=${summary.durationMs.p95 ?? '-'}ms max=${summary.durationMs.max ?? '-'}ms`
    outputChannel?.appendLine(
      `✅ Plugin catalog rescanned: ${result.count} plugins; artifacts success=${summary.success} pending=${summary.pending} failure=${summary.failure}; ${duration}; timeout=${summary.timeouts} crash=${summary.crashes}`,
    )
    outputChannel?.appendLine(
      `   failure reasons=${JSON.stringify(summary.failureReasons)} factory versions=${JSON.stringify(summary.factoryVersions)}`,
    )
    for (const failure of result.failures) {
      outputChannel?.appendLine(
        `   failed ${path.basename(failure.path)}: ${failure.code}: ${failure.message}`,
      )
    }
    vscode.window.showInformationMessage(
      `OrbitScore: rescanned ${result.count} plugins (${summary.pending} pending, ${summary.failure} failed)`,
    )
  } else {
    outputChannel?.appendLine(`❌ Plugin catalog rescan failed: ${result.error}`)
    vscode.window.showErrorMessage(`OrbitScore: plugin catalog rescan failed: ${result.error}`)
  }
}

/** Read the plugin catalog for the MCP `list_plugins` tool (#463 PC.4). */
function listPluginsForAgent(): ListPluginsResult {
  const catalog = loadPluginCatalog()
  if (!catalog) {
    return {
      ok: false,
      error: 'plugin catalog not found — run "OrbitScore: Rescan Plugin Catalog" first',
    }
  }
  return {
    ok: true,
    plugins: catalog.plugins.map((entry) => ({ ...entry, roles: [...entry.roles] })),
  }
}

/** Run the scanner for the MCP `rescan_plugins` tool (#463 PC.4/C1b). Shares `runPluginScan` with the command variant above. */
async function rescanPluginsForAgent(): Promise<RescanPluginsResult> {
  const result = await runPluginScan()
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  setPluginCatalogHintShown(false)
  return {
    ok: true,
    count: result.count,
    artifactCount: result.artifactCount,
    skipped: [...result.skipped],
    failures: result.failures.map((failure) => ({
      ...failure,
      slices: failure.slices ? [...failure.slices] : undefined,
    })),
    summary: result.summary,
  }
}

export { browsePlugins, listPluginsForAgent, rescanPlugins, rescanPluginsForAgent }
