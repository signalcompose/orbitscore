/**
 * 写した `dsl-providers.ts` が凍結版の `extension-state.ts` から読む 3 つの名前（vscode-shim と同じ足場）。
 *
 * 層 2 には出力チャネルが無いので、写しが書く行は `vscode-shim` の `messages.log`（層 2 のログ）へ回す。
 */
// PROVISIONAL(P-25): vscode-shim と一緒に、拡張版の退役で層 2 の形へ書き直す。
import { messages } from './vscode-shim'

export const outputChannel: { appendLine(line: string): void } | null = {
  appendLine: (line: string) => messages.log(line),
}

export let pluginCatalogHintShown = false

export function setPluginCatalogHintShown(value: boolean): void {
  pluginCatalogHintShown = value
}
