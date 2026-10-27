/**
 * テストから正本のスキーマ（`protocol/session/v1/session.schema.json`）を読むための小さな口。
 */
import fs from 'node:fs'
import path from 'node:path'

export const SCHEMA_PATH = path.resolve(__dirname, '../../protocol/session/v1/session.schema.json')

export interface MethodSpec {
  direction: 'client-to-server' | 'server-to-client'
  kind: 'request' | 'notification'
  description?: string
  params?: { $ref: string }
  result?: { $ref: string }
  'x-editor-request'?: 'same' | { params: { $ref: string }; result: { $ref: string } }
  'x-surfaces': string[]
  'x-mcp-tools'?: string[]
}

export interface SessionSchema {
  'x-protocol-version': string
  'x-surface-vocabulary': Record<string, string>
  'x-errors': Record<string, number>
  'x-methods': Record<string, MethodSpec>
  $defs: Record<string, unknown>
}

export function loadSessionSchema(): SessionSchema {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as SessionSchema
}

/**
 * 凍結版の MCP ツール 28 本（設計 848 §6 の表・`tools/list` の登録順）。凍結版の `tools/list` と
 * 実際に突き合わせるのは `tests/protocol/mcp-tools-v1.spec.ts`（束 S-mcp）。
 */
export const FROZEN_MCP_TOOLS = [
  'evaluate_orbitscore',
  'start_engine',
  'stop_engine',
  'get_engine_state',
  'list_audio_devices',
  'select_audio_device',
  'configure_flash',
  'open_file',
  'set_selection',
  'run_selection',
  'edit_replace',
  'get_editor_state',
  'save_file',
  'get_document_text',
  'get_diagnostics',
  'get_log',
  'save_plugin_state',
  'open_plugin_ui',
  'close_plugin_ui',
  'open_plugin_ui_at_cursor',
  'analyze_audio',
  'list_plugins',
  'rescan_plugins',
  'get_dev_doc',
  'search_dev_docs',
  'get_user_doc',
  'search_user_docs',
  'register_mcp_server',
] as const
