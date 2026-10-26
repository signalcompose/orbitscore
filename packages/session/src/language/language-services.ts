/**
 * 層 2 の言語サービス（設計 848 §5.3.4・§5.5）: 補完（`editor.complete`）と診断（`editor.diagnostics` の
 * push と `editor.getDiagnostics`）。
 *
 * 計算は凍結版のコードそのもの（`dsl-providers.ts` の 3 つの補完 provider と `diagnostics-provider.ts` の
 * `updateDiagnostics`）を `vscode-shim` の上で走らせる。ここは同期済みの写しを VS Code の文書の形に
 * 見せ、結果をプロトコルの形へ直すだけ。**`get_diagnostics` と Monaco のマーカーは同じ計算を見る**。
 */
import {
  inferLanguageId,
  lineStarts,
  offsetAt,
  type Position as SyncedPosition,
  type SyncedDocument,
} from '../host/document-store'

import { updateDiagnostics } from './diagnostics-provider'
import { registerCompletionProviders } from './dsl-providers'
import * as vscode from './vscode-shim'

export interface CompletionItemResult {
  label: string
  kind?: string
  detail?: string
  documentation?: string
  insertText?: string
  sortText?: string
}

export interface DiagnosticEntry {
  line: number
  character: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  code?: string | number
}

/** VS Code の既定の単語（`getWordRangeAtPosition` の既定の正規表現）。 */
const DEFAULT_WORD = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g

/** 同期済みの写しを、写したコードが読む `TextDocument` の形に見せる。 */
export function shimDocument(document: SyncedDocument): vscode.TextDocument {
  const text = document.text
  const lines = text.split(/\r\n|\r|\n/)
  const lineAt = (lineOrPosition: number | vscode.Position): vscode.TextLine => {
    const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line
    const lineText = lines[line]
    if (lineText === undefined) throw new Error(`Illegal value for \`line\`: ${line}`)
    return { text: lineText, range: new vscode.Range(line, 0, line, lineText.length) }
  }
  return {
    uri: vscode.Uri.parse(document.uri),
    languageId: inferLanguageId(document.uri),
    lineCount: lines.length,
    getText(range?: vscode.Range): string {
      if (!range) return text
      const starts = lineStarts(text)
      return text.slice(offsetAt(text, range.start, starts), offsetAt(text, range.end, starts))
    },
    lineAt,
    getWordRangeAtPosition(position: vscode.Position): vscode.Range | undefined {
      const lineText = lines[position.line] ?? ''
      for (const match of lineText.matchAll(DEFAULT_WORD)) {
        const start = match.index ?? 0
        const end = start + match[0].length
        if (position.character >= start && position.character <= end) {
          return new vscode.Range(position.line, start, position.line, end)
        }
      }
      return undefined
    },
  }
}

/** 凍結版 `getDiagnosticsForAgent` と同じ写し方（位置は 1 始まり・重さは名前）。 */
function toEntry(diagnostic: vscode.Diagnostic): DiagnosticEntry {
  const severity =
    diagnostic.severity === vscode.DiagnosticSeverity.Error
      ? 'error'
      : diagnostic.severity === vscode.DiagnosticSeverity.Warning
        ? 'warning'
        : diagnostic.severity === vscode.DiagnosticSeverity.Information
          ? 'info'
          : 'hint'
  return {
    line: diagnostic.range.start.line + 1,
    character: diagnostic.range.start.character + 1,
    severity,
    message: diagnostic.message,
    ...(typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number'
      ? { code: diagnostic.code }
      : {}),
  }
}

function toCompletionItem(item: vscode.CompletionItem): CompletionItemResult {
  const text = (value: string | { value: string } | undefined) =>
    value === undefined ? undefined : typeof value === 'string' ? value : value.value
  const kind = item.kind === undefined ? undefined : vscode.CompletionItemKind[item.kind]
  return {
    label: item.label,
    ...(kind ? { kind: kind.toLowerCase() } : {}),
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
    ...(item.documentation !== undefined ? { documentation: text(item.documentation) } : {}),
    ...(item.insertText !== undefined ? { insertText: text(item.insertText) } : {}),
    ...(item.sortText !== undefined ? { sortText: item.sortText } : {}),
  }
}

export interface LanguageServicesDeps {
  log(level: 'info' | 'warn', text: string): void
  workspaceRoot: string | null
}

export class LanguageServices {
  private readonly providers: vscode.RegisteredCompletionProvider[]

  constructor(deps: LanguageServicesDeps) {
    vscode.messages.log = (text) => deps.log('info', `[session] ${text}`)
    vscode.workspaceRoot.current = deps.workspaceRoot
    vscode.takeRegisteredCompletionProviders()
    registerCompletionProviders({ subscriptions: { push: () => 0 } })
    this.providers = vscode.takeRegisteredCompletionProviders()
  }

  /**
   * 3 つの provider を登録の順に呼んで結果を並べる（VS Code で補完を明示的に呼んだ時と同じ）。
   * 位置は LSP と同じ 0 始まり。
   */
  async complete(
    document: SyncedDocument,
    position: SyncedPosition,
  ): Promise<CompletionItemResult[]> {
    const shim = shimDocument(document)
    const at = new vscode.Position(position.line, position.character)
    const items: CompletionItemResult[] = []
    for (const { provider } of this.providers) {
      const provided = await provider.provideCompletionItems(shim, at)
      for (const item of provided ?? []) items.push(toCompletionItem(item))
    }
    return items
  }

  /** 凍結版 `updateDiagnostics` が出す診断そのもの（範囲の終わり・tags を含む）。 */
  async rawDiagnostics(document: SyncedDocument): Promise<vscode.Diagnostic[]> {
    let captured: vscode.Diagnostic[] = []
    await updateDiagnostics(shimDocument(document), {
      set: (_uri, diagnostics) => {
        captured = diagnostics
      },
    })
    return captured
  }

  async diagnose(document: SyncedDocument): Promise<DiagnosticEntry[]> {
    return (await this.rawDiagnostics(document)).map(toEntry)
  }
}
