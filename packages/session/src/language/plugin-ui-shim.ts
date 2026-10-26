/**
 * 写した `plugin-ui-at-cursor.ts` が凍結版の `agent-handlers.ts` から読む `pluginUiForAgent`
 * （vscode-shim と同じ足場）。
 *
 * 凍結版は engine の子プロセスへメタ行を書いて答えを待った。層 2 は engine を in-process で持つので、
 * 呼ぶ側（`SessionCore`）が `plugin.openUi` のハンドラを `withPluginUiOpener` で差し込む。写しは
 * `pluginUiForAgent` を最初の `await` より前に同期的に呼ぶので、差し込みと呼び出しの間に別の呼び出しは
 * 挟まらない（`tests/session/editor-reverse.spec.ts` が 2 つのセッションを並べて確かめる）。
 */
// PROVISIONAL(P-25): vscode-shim と一緒に、拡張版の退役で層 2 の形へ書き直す。
import type { PluginUiResult } from '../mcp/mcp-types'

export type PluginUiOpener = (
  receiver: string,
  index: number,
  expectedName?: string,
) => Promise<PluginUiResult>

let opener: PluginUiOpener | null = null

/** `run` の間だけ `pluginUiForAgent('open', …)` を `open` へ回す。 */
export function withPluginUiOpener<T>(open: PluginUiOpener, run: () => T): T {
  const previous = opener
  opener = open
  try {
    return run()
  } finally {
    opener = previous
  }
}

/** 凍結版と同じ形。写しが呼ぶのは `open` だけ。 */
export function pluginUiForAgent(
  action: 'open' | 'close',
  receiver: string,
  index: number,
  expectedName?: string,
): Promise<PluginUiResult> {
  const open = opener
  if (action !== 'open' || !open) {
    return Promise.resolve({
      ok: false,
      error: `plugin UI ${action} is not wired in layer 2 outside withPluginUiOpener`,
    })
  }
  return open(receiver, index, expectedName)
}
