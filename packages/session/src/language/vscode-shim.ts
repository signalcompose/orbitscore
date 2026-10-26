/**
 * 凍結版の言語機能（補完・診断）を、層 2 で**書き換えずに**走らせるための最小の器（設計 848 §5.3.4・§5.5）。
 *
 * 写した `completion-context.ts` / `dsl-providers.ts` / `diagnostics-provider.ts` は `vscode` の値と型を
 * 使う。層 2 には `vscode` が無いので、写しの import だけを差し替えてここを読ませる（差し替えは
 * `tests/session/frozen-copies/*.patch` が固定する）。ここに在るのは写しが実際に触る名前だけで、
 * 振る舞いは「値を入れて持つ」だけ（描画も UI も無い）。
 *
 * 凍結版と同じ答えになることは `tests/session/language-parity.spec.ts` が、凍結版の本体を vitest の
 * `vscode` の mock で走らせた結果と突き合わせて確かめる。
 */
// PROVISIONAL(P-25): 凍結版の写しを vscode の形のまま走らせる足場。拡張版の退役で層 2 の形へ書き直す。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position
  readonly end: Position
  constructor(
    start: Position | number,
    startCharacter: Position | number,
    endLine?: number,
    endCharacter?: number,
  ) {
    if (start instanceof Position && startCharacter instanceof Position) {
      this.start = start
      this.end = startCharacter
    } else {
      this.start = new Position(start as number, startCharacter as number)
      this.end = new Position(endLine as number, endCharacter as number)
    }
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly fsPath: string,
    private readonly text: string,
  ) {}
  static file(fsPath: string): Uri {
    return new Uri('file', fsPath, pathToFileURL(fsPath).href)
  }
  static parse(value: string): Uri {
    if (value.startsWith('file:')) {
      try {
        return new Uri('file', fileURLToPath(value), value)
      } catch {
        // 読めない file: の uri はそのまま持つ
      }
    }
    return new Uri(value.split(':')[0] ?? '', value, value)
  }
  toString(): string {
    return this.text
  }
}

export class MarkdownString {
  constructor(readonly value: string = '') {}
}

export class SnippetString {
  constructor(readonly value: string = '') {}
}

/** VS Code の `CompletionItemKind` と同じ番号（層 2 は名前に直して返す）。 */
export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
  Interface = 7,
  Module = 8,
  Property = 9,
  Unit = 10,
  Value = 11,
  Enum = 12,
  Keyword = 13,
  Snippet = 14,
  Color = 15,
  File = 16,
  Reference = 17,
  Folder = 18,
  EnumMember = 19,
  Constant = 20,
  Struct = 21,
  Event = 22,
  Operator = 23,
  TypeParameter = 24,
}

export class CompletionItem {
  detail?: string
  documentation?: string | MarkdownString
  insertText?: string | SnippetString
  sortText?: string
  filterText?: string
  range?: Range
  constructor(
    readonly label: string,
    readonly kind?: CompletionItemKind,
  ) {}
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum DiagnosticTag {
  Unnecessary = 1,
  Deprecated = 2,
}

export class Diagnostic {
  code?: string | number
  source?: string
  tags?: DiagnosticTag[]
  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ) {}
}

export class Hover {
  constructor(readonly contents: MarkdownString) {}
}

export const CodeActionKind = { QuickFix: 'quickfix' } as const

export class WorkspaceEdit {
  readonly inserts: Array<{ uri: Uri; position: Position; text: string }> = []
  insert(uri: Uri, position: Position, text: string): void {
    this.inserts.push({ uri, position, text })
  }
}

export class CodeAction {
  diagnostics?: Diagnostic[]
  isPreferred?: boolean
  edit?: WorkspaceEdit
  constructor(
    readonly title: string,
    readonly kind?: string,
  ) {}
}

export interface TextLine {
  readonly text: string
  readonly range: Range
}

export interface TextDocument {
  readonly uri: Uri
  readonly languageId: string
  readonly lineCount: number
  getText(range?: Range): string
  lineAt(lineOrPosition: number | Position): TextLine
  getWordRangeAtPosition(position: Position): Range | undefined
}

export interface Disposable {
  dispose(): void
}

export interface ExtensionContext {
  readonly subscriptions: { push(...items: Disposable[]): unknown }
}

export interface CompletionItemProvider {
  provideCompletionItems(
    document: TextDocument,
    position: Position,
  ): CompletionItem[] | undefined | Promise<CompletionItem[] | undefined>
}

export interface CodeActionContext {
  readonly diagnostics: readonly Diagnostic[]
}

export interface CodeActionProvider {
  provideCodeActions(
    document: TextDocument,
    range: Range,
    context: CodeActionContext,
  ): CodeAction[] | undefined
}

export interface HoverProvider {
  provideHover(document: TextDocument, position: Position): Hover | undefined
}

export interface DiagnosticCollection {
  set(uri: Uri, diagnostics: Diagnostic[]): void
}

/** 写しの `registerCompletionProviders` が登録したもの（層 2 が呼ぶ）。 */
export interface RegisteredCompletionProvider {
  provider: CompletionItemProvider
  triggers: string[]
}

const completionProviders: RegisteredCompletionProvider[] = []

/** 登録を集める（`captureCompletionProviders` の中だけで使う）。 */
export function takeRegisteredCompletionProviders(): RegisteredCompletionProvider[] {
  return completionProviders.splice(0)
}

const noop: Disposable = { dispose: () => {} }

export const languages = {
  registerCompletionItemProvider(
    _selector: string,
    provider: CompletionItemProvider,
    ...triggers: string[]
  ): Disposable {
    completionProviders.push({ provider, triggers })
    return noop
  },
  // v1 のプロトコルに hover と quick fix のメソッドが無い（PR に記録）。登録は受けて捨てる。
  registerHoverProvider: (_selector: string, _provider: HoverProvider): Disposable => noop,
  registerCodeActionsProvider: (
    _selector: string,
    _provider: CodeActionProvider,
    _metadata?: unknown,
  ): Disposable => noop,
}

/** 写しが読むワークスペース（`import` のパスの補完・読み込み）。層 2 が `--workspace-root` を入れる。 */
export const workspaceRoot: { current: string | null } = { current: null }

function findOrbsFiles(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.orbs')) found.push(full)
    }
  }
  walk(root)
  return found.sort()
}

export const workspace = {
  fs: {
    readFile: async (uri: Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath),
  },
  findFiles: async (_glob: string): Promise<Uri[]> =>
    workspaceRoot.current ? findOrbsFiles(workspaceRoot.current).map((file) => Uri.file(file)) : [],
}

/** 写しが出す通知（カタログが無い時の案内）。層 2 には画面が無いので、層 2 のログへ回す。 */
export const messages: { log: (text: string) => void } = { log: () => {} }

export const window = {
  showInformationMessage: async (message: string): Promise<undefined> => {
    messages.log(message)
    return undefined
  },
}
