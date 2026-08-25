/**
 * Minimal runtime stand-in for the `vscode` module (#527 review Critical #3).
 *
 * `vscode` only exists inside a real extension host — this repo depends on
 * `@types/vscode` for compile-time types only, so `extension.ts` and
 * `completion-context.ts` (the two source files that do
 * `import * as vscode from 'vscode'`) have never been importable from a unit
 * test; the import fails to resolve outside the extension host. Aliased in
 * for vitest via `packages/engine/vitest.config.ts`.
 *
 * Deliberately partial: only wide enough to let those two modules import
 * cleanly and to let tests/vscode-extension/extension-wiring.spec.ts drive
 * extension.ts's exported setup*Handler wiring functions directly (none of
 * which touch `vscode.*` themselves — they close over already-injected
 * fakes). Extend this file — rather than reaching for a heavier vscode-mock
 * package — only as new tests actually exercise more of the surface (e.g. if
 * a future spec drives `activate()` itself).
 */

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = []
  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener)
    return { dispose: () => {} }
  }
  fire(value: T): void {
    for (const listener of this.listeners) listener(value)
  }
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class ThemeIcon {
  constructor(public id: string) {}
}

export class TreeItem {
  label: string
  id?: string
  description?: string
  tooltip?: string
  command?: unknown
  iconPath?: unknown
  collapsibleState?: unknown

  constructor(label: string, collapsibleState?: unknown) {
    this.label = label
    this.collapsibleState = collapsibleState
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const

export const StatusBarAlignment = { Left: 1, Right: 2 } as const

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const

export class Uri {
  private constructor(public readonly value: string) {}
  toString(): string {
    return this.value
  }
  static parse(value: string): Uri {
    return new Uri(value)
  }
  static file(value: string): Uri {
    return new Uri(value)
  }
}

export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
}

export class CompletionItem {
  documentation?: unknown
  insertText?: unknown
  constructor(
    public label: string,
    public kind?: unknown,
  ) {}
}

export const CompletionItemKind = { Method: 1, Value: 11, File: 16 } as const

export class MarkdownString {
  constructor(public value?: string) {}
}

export class SnippetString {
  constructor(public value?: string) {}
}

function fakeDisposable(): { dispose(): void } {
  return { dispose: () => {} }
}

export const window = {
  createOutputChannel: () => ({
    appendLine: () => {},
    append: () => {},
    show: () => {},
    dispose: () => {},
  }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: undefined as unknown,
    backgroundColor: undefined as unknown,
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  createTextEditorDecorationType: () => ({ dispose: () => {} }),
  createWebviewPanel: () => ({
    webview: { html: '' },
    reveal: () => {},
    onDidDispose: () => fakeDisposable(),
    dispose: () => {},
  }),
  registerTreeDataProvider: () => fakeDisposable(),
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  visibleTextEditors: [] as unknown[],
  activeTextEditor: undefined as unknown,
}

export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue?: T) => defaultValue,
    update: async () => undefined,
    // `resolveAudioDeviceSetting` (extension.ts) calls `.inspect()` to
    // distinguish an explicit workspace/global value from "unset" — no spec
    // exercised that path until start-engine-for-agent.spec.ts (#533) drove
    // `startEngine()` for real. Always "unset" here: every key falls
    // through to `.get()`'s default value / the `.orbitscore.json` fallback.
    inspect: <T>(_key: string) =>
      ({
        key: _key,
        defaultValue: undefined,
        globalValue: undefined,
        workspaceValue: undefined,
      }) as {
        key: string
        defaultValue?: T
        globalValue?: T
        workspaceValue?: T
      },
  }),
  workspaceFolders: undefined as unknown,
  textDocuments: [] as unknown[],
  onDidChangeConfiguration: () => fakeDisposable(),
  onDidOpenTextDocument: () => fakeDisposable(),
  onDidChangeTextDocument: () => fakeDisposable(),
  onDidCloseTextDocument: () => fakeDisposable(),
}

export const registeredCommandHandlers = new Map<string, (...args: unknown[]) => unknown>()

export function resetRegisteredCommandHandlers(): void {
  registeredCommandHandlers.clear()
}

export const commands = {
  registerCommand: (command: string, handler: (...args: unknown[]) => unknown) => {
    registeredCommandHandlers.set(command, handler)
    return fakeDisposable()
  },
  executeCommand: async () => undefined,
}

/**
 * 登録された補完プロバイダ（#495）。
 *
 * プロバイダ本体（`provideCompletionItems`）は vscode API を直接叩く層なので、
 * **文脈検出のユニットテストでは通らない**。#614 で「配線はユニットテストの視野の外」を
 * 踏んだばかりなので、ここで登録を捕まえて**実際に呼べる**ようにする。
 */
export const registeredCompletionProviders: Array<{
  selector: unknown
  provider: { provideCompletionItems: (...args: never[]) => unknown }
  triggers: string[]
}> = []

export function resetRegisteredCompletionProviders(): void {
  registeredCompletionProviders.length = 0
}

export const languages = {
  registerCompletionItemProvider: (
    selector: unknown,
    provider: { provideCompletionItems: (...args: never[]) => unknown },
    ...triggers: string[]
  ) => {
    registeredCompletionProviders.push({ selector, provider, triggers })
    return fakeDisposable()
  },
  registerHoverProvider: () => fakeDisposable(),
  createDiagnosticCollection: () => ({
    set: () => {},
    delete: () => {},
    dispose: () => {},
  }),
}

export const env = {
  openExternal: async () => true,
}
