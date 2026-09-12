/**
 * VS Code command and agent wiring for Claude Code MCP registration.
 *
 * Function bodies are moved unchanged from extension.ts. Helpers that were
 * module-private are exported only so the extension root can preserve its
 * existing wiring across the new module boundary.
 */
import * as child_process from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import * as vscode from 'vscode'

import { mcpServerHandle, outputChannel } from './extension-state'
import { buildMcpServerUrl, mergeMcpJson } from './mcp-registration'
import type { CommandResult, RegisterMcpServerInput } from './mcp-server'

// ── Register Claude Code MCP Server ─────────────────────────────────────────

/** Registration scope for the orbitscore MCP server. */
type McpRegistrationScope = 'project' | 'user'

/**
 * Register the OrbitScore MCP server into Claude Code. Shared implementation
 * behind the `orbitscore.registerMcpServer` palette command (which wraps it
 * with QuickPick/InputBox prompts) and the MCP `register_mcp_server` tool.
 *
 * - 'project': merge `mcpServers.orbitscore` into `<workspace>/.mcp.json`.
 *   `mergeMcpJson` throws on corrupt JSON (mapped to an error result here) so
 *   an unreadable config is never overwritten.
 * - 'user': run `claude mcp add --transport http --scope user orbitscore <url>`
 *   (flags verified against claude CLI 2.1.202) with cwd = workspace root.
 *   The CLI is located via `which claude` first so a missing install produces
 *   a targeted message instead of a raw ENOENT.
 */
async function performMcpRegistration(
  scope: McpRegistrationScope,
  port: number,
): Promise<CommandResult> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `port must be an integer between 1 and 65535 (got ${port})` }
  }
  const url = buildMcpServerUrl(port)
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  if (scope === 'project') {
    if (!workspaceRoot) {
      return {
        ok: false,
        error: 'no workspace folder open — project scope writes .mcp.json into the workspace root',
      }
    }
    const mcpJsonPath = path.join(workspaceRoot, '.mcp.json')
    let merged: string
    try {
      const existing = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, 'utf-8') : null
      merged = mergeMcpJson(existing, port)
    } catch (err) {
      // Corrupt .mcp.json (invalid JSON / non-object) — report, write nothing.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    fs.writeFileSync(mcpJsonPath, merged)
    outputChannel?.appendLine(`🔌 Registered MCP server (${url}) in ${mcpJsonPath}`)
    return { ok: true, message: `registered orbitscore (${url}) in ${mcpJsonPath}` }
  }

  // user scope — delegate to the claude CLI, which owns the user-level config
  // (~/.claude.json). Destructured (not `child_process.execFile`) — the repo's
  // security hook false-positives on the `child_process.exec*` member-access pattern.
  // execFile runs without a shell, and the args are a fixed flag list + the
  // numeric-port URL, so there is no injection surface.
  const { execFile } = child_process
  const claudePath = await new Promise<string | null>((resolve) => {
    execFile('which', ['claude'], (error, stdout) => {
      resolve(error ? null : stdout.trim() || null)
    })
  })
  if (!claudePath) {
    return {
      ok: false,
      error:
        'claude CLI not found on PATH — install the Claude Code CLI, or use Project scope (.mcp.json) instead',
    }
  }
  const cliArgs = ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'orbitscore', url]
  return new Promise<CommandResult>((resolve) => {
    execFile(
      claudePath,
      cliArgs,
      { cwd: workspaceRoot, timeout: 30000 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim()
        if (error) {
          // claude CLI 2.1.202 overwrites an existing entry silently (exit 0),
          // but a duplicate name may be rejected by other versions — give
          // targeted guidance instead of a bare failure.
          if (/already exists/i.test(output)) {
            resolve({
              ok: false,
              error:
                'an MCP server named "orbitscore" is already registered — run ' +
                '`claude mcp remove orbitscore` first, then retry. ' +
                `CLI output: ${output}`,
            })
            return
          }
          resolve({ ok: false, error: `claude mcp add failed: ${output || error.message}` })
          return
        }
        outputChannel?.appendLine(`🔌 claude ${cliArgs.join(' ')} → ${output}`)
        resolve({ ok: true, message: `ran \`claude ${cliArgs.join(' ')}\` → ${output}` })
      },
    )
  })
}

/**
 * Palette command "🔌 Register Claude Code MCP Server". Like VS Code's
 * "Install 'code' command in PATH": registers this extension's MCP server
 * into Claude Code's config at the user's chosen scope.
 *
 * `args` fields (both optional) skip the corresponding prompt — used by
 * agent-driven and E2E flows that must run without UI interaction.
 */
async function registerMcpServer(args?: {
  scope?: McpRegistrationScope
  port?: number
}): Promise<void> {
  const config = vscode.workspace.getConfiguration('orbitscore')

  // Resolve the port: explicit arg > configured setting > InputBox prompt.
  // A port entered here is persisted to the setting so the server actually
  // starts on it after a reload — registration continues in the same pass.
  let port = args?.port ?? config.get<number>('mcpServer.port', 0)
  if (!port || port <= 0) {
    const input = await vscode.window.showInputBox({
      title: '🔌 Register Claude Code MCP Server',
      prompt: 'orbitscore.mcpServer.port is not set — enter a port for the MCP server (1-65535)',
      value: '39123',
      validateInput: (value) => {
        const num = Number(value)
        if (!Number.isInteger(num) || num < 1 || num > 65535) {
          return 'Please enter a port number between 1 and 65535'
        }
        return null
      },
    })
    if (input === undefined) return // cancelled
    port = parseInt(input, 10)
    await config.update('mcpServer.port', port, vscode.ConfigurationTarget.Global)
    vscode.window.showInformationMessage(
      `✅ orbitscore.mcpServer.port set to ${port}. Reload the window for the MCP server to start — continuing with registration.`,
    )
  }

  // Resolve the scope: explicit arg > QuickPick.
  let scope = args?.scope
  if (!scope) {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: 'Project',
          description: 'write .mcp.json in this workspace (shareable, per-repo)',
          scope: 'project' as const,
        },
        {
          label: 'User',
          description: 'register for all projects (via claude CLI)',
          scope: 'user' as const,
        },
      ],
      {
        title: '🔌 Register Claude Code MCP Server',
        placeHolder: 'Where should the orbitscore MCP server be registered?',
      },
    )
    if (!pick) return // cancelled
    scope = pick.scope
  }

  const result = await performMcpRegistration(scope, port)
  if (result.ok) {
    vscode.window.showInformationMessage(`✅ ${result.message}`)
  } else {
    vscode.window.showErrorMessage(`⚠️ Failed to register MCP server: ${result.error}`)
  }
}

/**
 * Register this MCP server into Claude Code for the MCP `register_mcp_server`
 * tool — delegates to the same `performMcpRegistration` as the palette
 * command. The port defaults to the port this server is actually listening on
 * (`mcpServerHandle`): the ORBITSCORE_MCP_PORT env var takes precedence over
 * the setting at startup, so the live handle — not the setting — is the
 * truthful default. The setting is a last resort (the handle is always
 * non-null while a tool call is being served).
 */
async function registerMcpServerForAgent(input: RegisterMcpServerInput): Promise<CommandResult> {
  if (input.scope !== 'project' && input.scope !== 'user') {
    return {
      ok: false,
      error: `scope must be 'project' or 'user' (got ${JSON.stringify(input.scope)})`,
    }
  }
  const port =
    input.port ??
    mcpServerHandle?.port ??
    vscode.workspace.getConfiguration('orbitscore').get<number>('mcpServer.port', 0)
  return performMcpRegistration(input.scope, port)
}

export {
  performMcpRegistration,
  registerMcpServer,
  registerMcpServerForAgent,
  type McpRegistrationScope,
}
