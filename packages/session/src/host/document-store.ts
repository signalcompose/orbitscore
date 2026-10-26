/**
 * エディタのクライアントが開いている document の写し（設計 848 §5.4・§5.5）。
 *
 * 層 2 は「今どの document が開いていて、選択がどこか」を**クライアントに聞かずに知っている**:
 * `editor.didOpen / didChange / didClose / didChangeSelection / didChangeActive` で写しを保ち、
 * `editor.getState` / `editor.getDocumentText` / 診断 / IM.6 の第 2 候補はこの写しを読む。
 *
 * 座標は LSP と同じ **0 始まり・UTF-16**（JS の文字列の添字がそのまま UTF-16 の単位）。行の区切りは
 * `\n` / `\r\n` / `\r`。範囲の外の位置は文書の端へ寄せる（LSP の慣習）。
 */
import { fileURLToPath } from 'node:url'

export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export interface TextChange {
  range?: Range
  text: string
}

export interface SyncedDocument {
  uri: string
  version: number
  text: string
  documentDirectory: string | null
  /** 選択（未通知なら文書の先頭の空の選択）。 */
  selection: Range
  /** キャレット（選択の動く側）。 */
  cursor: Position
  /** 最後に保存された時の版（`didOpen` の時点を保存済みとみなす・台帳 P-24）。 */
  savedVersion: number
}

/** 行の先頭の位置（UTF-16 の添字）。区切りは `\n` / `\r\n` / `\r`。 */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) i += 1
      starts.push(i + 1)
    } else if (code === 10 /* \n */) {
      starts.push(i + 1)
    }
  }
  return starts
}

/** 行の終わり（区切りの直前）の添字。 */
function lineEnd(text: string, starts: number[], line: number): number {
  const next = starts[line + 1]
  if (next === undefined) return text.length
  let end = next
  if (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1
  if (end > 0 && text.charCodeAt(end - 1) === 13) end -= 1
  return end
}

/** 位置 → 添字。行・文字が範囲の外なら端へ寄せる。 */
export function offsetAt(text: string, position: Position, starts = lineStarts(text)): number {
  if (position.line < 0) return 0
  if (position.line >= starts.length) return text.length
  const start = starts[position.line]!
  const end = lineEnd(text, starts, position.line)
  return Math.min(start + Math.max(0, position.character), end)
}

/** 添字 → 位置。 */
export function positionAt(text: string, offset: number, starts = lineStarts(text)): Position {
  const clamped = Math.max(0, Math.min(offset, text.length))
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (starts[middle]! <= clamped) low = middle
    else high = middle - 1
  }
  return { line: low, character: clamped - starts[low]! }
}

/** LSP の `TextDocumentContentChangeEvent` を順に当てる（範囲が無ければ全文の置き換え）。 */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let current = text
  for (const change of changes) {
    if (!change.range) {
      current = change.text
      continue
    }
    const starts = lineStarts(current)
    const from = offsetAt(current, change.range.start, starts)
    const to = Math.max(from, offsetAt(current, change.range.end, starts))
    current = current.slice(0, from) + change.text + current.slice(to)
  }
  return current
}

const EMPTY_RANGE: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

export class DocumentStore {
  private readonly documents = new Map<string, SyncedDocument>()
  private activeUri: string | null = null

  constructor(private readonly log: (level: 'warn', text: string) => void = () => {}) {}

  open(uri: string, version: number, text: string, documentDirectory: string | null): void {
    this.documents.set(uri, {
      uri,
      version,
      text,
      documentDirectory,
      selection: EMPTY_RANGE,
      cursor: EMPTY_RANGE.start,
      savedVersion: version,
    })
  }

  /** 版が進まない変更（古い・重複）は当てない。開いていない文書への変更も当てない。 */
  change(uri: string, version: number, changes: readonly TextChange[]): boolean {
    const document = this.documents.get(uri)
    if (!document) {
      this.log('warn', `[session] editor.didChange for a document that is not open: ${uri}`)
      return false
    }
    if (version <= document.version) {
      this.log(
        'warn',
        `[session] editor.didChange ignored: version ${version} is not newer than ${document.version} (${uri})`,
      )
      return false
    }
    document.text = applyChanges(document.text, changes)
    document.version = version
    return true
  }

  close(uri: string): void {
    this.documents.delete(uri)
    if (this.activeUri === uri) this.activeUri = null
  }

  select(uri: string, range: Range, cursor?: Position): void {
    const document = this.documents.get(uri)
    if (!document) return
    document.selection = range
    document.cursor = cursor ?? range.end
  }

  setActive(uri: string | null): void {
    this.activeUri = uri
  }

  /** 保存できたことを層 2 が知った時（`editor.saveFile` の成功）。`version` を省けば今の版。 */
  markSaved(uri: string, version?: number): void {
    const document = this.documents.get(uri)
    if (document) document.savedVersion = version ?? document.version
  }

  /** エディタのクライアントが離れた時（写しは全部消える・F-12 で再送される）。 */
  clear(): void {
    this.documents.clear()
    this.activeUri = null
  }

  get(uri: string): SyncedDocument | undefined {
    return this.documents.get(uri)
  }

  active(): SyncedDocument | null {
    return this.activeUri === null ? null : (this.documents.get(this.activeUri) ?? null)
  }

  get activeUriValue(): string | null {
    return this.activeUri
  }

  list(): Array<{ uri: string; version: number }> {
    return [...this.documents.values()].map(({ uri, version }) => ({ uri, version }))
  }

  all(): SyncedDocument[] {
    return [...this.documents.values()]
  }
}

/** `file:` の uri はファイルのパスに、それ以外はそのまま（凍結版の `uri.fsPath` に当たる）。 */
export function documentPath(uri: string): string {
  if (!uri.startsWith('file:')) return uri
  try {
    return fileURLToPath(uri)
  } catch {
    return uri
  }
}

/**
 * 言語の推定。`didOpen` は言語を運ばないので拡張子で決める（`.orbs` = `orbitscore`）。
 */
// PROVISIONAL(P-24): didOpen に languageId が無く、isDirty も didSave が無いので近似（設計に提案）。
export function inferLanguageId(uri: string): string {
  return /\.orbs$/i.test(uri.split(/[?#]/)[0] ?? '') ? 'orbitscore' : 'plaintext'
}

/** MCP `get_editor_state` の形（凍結版 `getEditorStateForAgent`: 位置は **1 始まり**）。 */
export function editorStateOf(document: SyncedDocument | null): {
  path: string | null
  languageId: string | null
  cursor: Position | null
  selection: Range | null
  lineCount: number | null
  isDirty: boolean | null
} {
  if (!document) {
    return {
      path: null,
      languageId: null,
      cursor: null,
      selection: null,
      lineCount: null,
      isDirty: null,
    }
  }
  const oneBased = (position: Position) => ({
    line: position.line + 1,
    character: position.character + 1,
  })
  return {
    path: documentPath(document.uri),
    languageId: inferLanguageId(document.uri),
    cursor: oneBased(document.cursor),
    selection: { start: oneBased(document.selection.start), end: oneBased(document.selection.end) },
    lineCount: lineStarts(document.text).length,
    isDirty: document.version !== document.savedVersion,
  }
}
