/** VS Code wiring for the user and development documentation panels. */
import * as fs from 'fs'
import * as path from 'path'

import * as vscode from 'vscode'

import { devDocsPanel, mcpServerHandle, outputChannel, setDevDocsPanel } from './extension-state'

/**
 * Canonical local URL of the dev learning site, or null (with the shared error
 * message shown) when the MCP server is not running. Single source for every
 * entry point (browser command, webview panel) — the site is served at the
 * VitePress base `/orbitscore/dev/` (mcp-server.ts DOCS_PUBLIC_BASE; `/docs`
 * is only a redirect kept for muscle memory).
 */
function resolveDevDocsUrl(): string | null {
  const port = mcpServerHandle?.port ?? 0
  if (!port) {
    void vscode.window.showErrorMessage(
      'OrbitScore development docs require the MCP server. Set orbitscore.mcpServer.port and enable the MCP server.',
    )
    return null
  }
  return `http://127.0.0.1:${port}/orbitscore/dev/`
}

/**
 * Canonical local URL of the END-USER learning site (sites/user — served at
 * `/orbitscore/` by the MCP server; the dev site lives under `/orbitscore/dev/`).
 */
function resolveUserDocsUrl(): string | null {
  const port = mcpServerHandle?.port ?? 0
  if (!port) {
    void vscode.window.showErrorMessage(
      'OrbitScore docs require the MCP server. Set orbitscore.mcpServer.port and enable the MCP server.',
    )
    return null
  }
  return `http://127.0.0.1:${port}/orbitscore/`
}

async function openUserDocs(): Promise<void> {
  const url = resolveUserDocsUrl()
  if (!url) return
  const opened = await vscode.env.openExternal(vscode.Uri.parse(url))
  if (!opened) {
    outputChannel?.appendLine(`❌ Failed to open the learning site at ${url}`)
  }
}

async function openDevDocs(): Promise<void> {
  const url = resolveDevDocsUrl()
  if (!url) return
  const opened = await vscode.env.openExternal(vscode.Uri.parse(url))
  if (!opened) {
    outputChannel?.appendLine(`❌ Failed to open development docs at ${url}`)
    void vscode.window.showErrorMessage('Could not open the development docs in your browser.')
  }
}

/**
 * Open the development docs inside an editor tab via an iframe-wrapped
 * webview panel, so the site can be read side-by-side with `.orbs` files
 * without leaving VS Code. Singleton: a second invocation reveals the
 * existing panel instead of creating a duplicate.
 */
function openDevDocsPanel(context: vscode.ExtensionContext): void {
  const url = resolveDevDocsUrl()
  if (!url) return

  if (devDocsPanel) {
    devDocsPanel.reveal(vscode.ViewColumn.Active)
    return
  }

  const panel = vscode.window.createWebviewPanel(
    'orbitscore.devDocsPanel',
    'OrbitScore Docs',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  )
  setDevDocsPanel(panel)
  panel.webview.html = buildDevDocsPanelHtml(url)
  panel.onDidDispose(
    () => {
      setDevDocsPanel(null)
    },
    null,
    context.subscriptions,
  )
}

function buildDevDocsPanelHtml(url: string): string {
  const escapedUrl = url.replace(/"/g, '&quot;')
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline';"
  />
  <style>
    html, body { height: 100%; margin: 0; padding: 0; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe src="${escapedUrl}" title="OrbitScore development docs"></iframe>
</body>
</html>`
}

async function openWalkthrough(): Promise<void> {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')) as {
    publisher: string
    name: string
  }
  const extensionId = `${pkg.publisher}.${pkg.name}`
  await vscode.commands.executeCommand(
    'workbench.action.openWalkthrough',
    `${extensionId}#orbitscore.learnOrbitScore`,
  )
}

export { openDevDocs, openDevDocsPanel, openUserDocs, openWalkthrough }
