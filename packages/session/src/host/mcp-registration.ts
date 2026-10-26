/**
 * `session.registerMcp`（設計 848 §6.3）: LLM クライアントに**中継のスタブ**を stdio で 1 回だけ登録する。
 * GUI のメニュー「Claude Code に登録」と MCP の `register_mcp_server` の両方から呼ばれる（D-4）。
 *
 * 🔴 **鍵もポートも書かない**。中継は決まった場所のソケットで層 2 を見つける（§6.2「発見」）ので、
 * アプリを立ち上げ直しても登録はそのまま。サーバ名は `orbitstudio`（凍結版の拡張が登録する
 * `orbitscore` の行を上書きしない — 退役までは両方が並ぶ）。
 *
 * 文言と手順は凍結版 `mcp-register-command.ts` の `performMcpRegistration` に合わせた
 * （`which claude` で先に探す・壊れた `.mcp.json` は上書きしない・「already exists」の案内）。
 */
import * as child_process from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { CommandResult } from './engine-host'

export const RELAY_SERVER_NAME = 'orbitstudio'

/**
 * 中継のスタブの置き場（`.app` の外の安定したパス・§6.3）。アプリが起動のたびに書き直す。
 * Linux は開発・テスト用（runtime-dir と同じくホームの下）。
 */
// PROVISIONAL(P-22): スタブのパス・形式・App Translocation の下での振る舞いは N0-c で決める。
export function relayStubRelativePath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? path.join('Library', 'Application Support', 'OrbitStudio', 'bin', 'orbitstudio-mcp')
    : path.join('.orbitstudio', 'bin', 'orbitstudio-mcp')
}

export interface RegisterMcpParams {
  scope: string
  port?: number
}

export interface RegisterMcpDeps {
  workspaceRoot: string | null
  platform?: NodeJS.Platform
  homeDir?: () => string
  /** `which claude` と `claude mcp add` を走らせる（テストで差し替える）。 */
  execFile?: typeof child_process.execFile
}

/**
 * `.mcp.json` の内容に `mcpServers.<name>` を入れる。他のキーとサーバは残す。壊れた内容は投げる
 * （上書きしない）。文言は凍結版 `mergeMcpJson`（`mcp-registration.ts`）と同じ。
 */
export function mergeMcpServerEntry(
  existingContent: string | null,
  name: string,
  entry: Record<string, unknown>,
): string {
  let config: Record<string, unknown> = {}
  if (existingContent !== null && existingContent.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(existingContent)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `.mcp.json contains invalid JSON (${reason}) — fix or remove the file, then retry`,
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        '.mcp.json must contain a JSON object at the top level — fix or remove the file, then retry',
      )
    }
    config = parsed as Record<string, unknown>
  }
  const servers = config.mcpServers
  if (
    servers !== undefined &&
    (typeof servers !== 'object' || servers === null || Array.isArray(servers))
  ) {
    throw new Error(
      '.mcp.json has a non-object "mcpServers" value — fix or remove the file, then retry',
    )
  }
  const mcpServers = (servers as Record<string, unknown> | undefined) ?? {}
  mcpServers[name] = entry
  config.mcpServers = mcpServers
  return JSON.stringify(config, null, 2) + '\n'
}

export async function registerMcp(
  params: RegisterMcpParams,
  deps: RegisterMcpDeps,
): Promise<CommandResult> {
  if (params.scope !== 'project' && params.scope !== 'user') {
    return {
      ok: false,
      error: `scope must be 'project' or 'user' (got ${JSON.stringify(params.scope)})`,
    }
  }
  const platform = deps.platform ?? process.platform
  const stubRelative = relayStubRelativePath(platform)
  // §6.1 の裁定による例外: `port` は受け取るが使わない。黙って捨てずに応答で伝える。
  const portNote =
    params.port === undefined
      ? ''
      : ` (port ${params.port} is not used: the relay finds the running session by its socket)`

  if (params.scope === 'project') {
    if (!deps.workspaceRoot) {
      return {
        ok: false,
        error: 'no workspace folder open — project scope writes .mcp.json into the workspace root',
      }
    }
    const mcpJsonPath = path.join(deps.workspaceRoot, '.mcp.json')
    // `${HOME}` は Claude Code が command の中で展開する（§6.3）ので、利用者の名前を書かずに済む。
    const command = `\${HOME}/${stubRelative.split(path.sep).join('/')}`
    let merged: string
    try {
      const existing = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, 'utf8') : null
      merged = mergeMcpServerEntry(existing, RELAY_SERVER_NAME, {
        type: 'stdio',
        command,
        args: [],
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    fs.writeFileSync(mcpJsonPath, merged)
    return {
      ok: true,
      message: `registered ${RELAY_SERVER_NAME} (stdio: ${command}) in ${mcpJsonPath}${portNote}`,
    }
  }

  const execFile = deps.execFile ?? child_process.execFile
  const stub = path.join((deps.homeDir ?? os.homedir)(), stubRelative)
  const claudePath = await new Promise<string | null>((resolve) => {
    execFile('which', ['claude'], (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null)
    })
  })
  if (!claudePath) {
    return {
      ok: false,
      error:
        'claude CLI not found on PATH — install the Claude Code CLI, or use Project scope (.mcp.json) instead',
    }
  }
  const cliArgs = [
    'mcp',
    'add',
    '--transport',
    'stdio',
    '--scope',
    'user',
    RELAY_SERVER_NAME,
    '--',
    stub,
  ]
  return new Promise<CommandResult>((resolve) => {
    execFile(
      claudePath,
      cliArgs,
      { cwd: deps.workspaceRoot ?? undefined, timeout: 30_000 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim()
        if (error) {
          if (/already exists/i.test(output)) {
            resolve({
              ok: false,
              error:
                `an MCP server named "${RELAY_SERVER_NAME}" is already registered — run ` +
                `\`claude mcp remove ${RELAY_SERVER_NAME}\` first, then retry. ` +
                `CLI output: ${output}`,
            })
            return
          }
          resolve({ ok: false, error: `claude mcp add failed: ${output || error.message}` })
          return
        }
        resolve({
          ok: true,
          message: `ran \`claude ${cliArgs.join(' ')}\` → ${output}${portNote}`,
        })
      },
    )
  })
}
