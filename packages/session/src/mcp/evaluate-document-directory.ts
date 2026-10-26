/**
 * MCP `evaluate_orbitscore` の基準ディレクトリの決め方（#966・core spec IM.6）。
 *
 * import・`audio()`・plugin state ファイルの相対パスは、評価ごとに拡張が送る
 * `//#documentDirectory` を基準に解決される。以前は常に最初のワークスペースフォルダを
 * 送っていたため、`.orbs` がサブフォルダにあると `run_selection` では通るコードが
 * `evaluate_orbitscore` では解決に失敗した。
 *
 * 順序（IM.6）: 引数 `document_path` → アクティブな OrbitScore エディタ → 最初の
 * ワークスペースフォルダ → 基準なし。`document_path` を先に置くのは、人が前面の
 * タブで演奏している間もエージェントが別ファイル基準で評価できるようにするため
 * （前面のタブはエージェントから指定できない状態で、`open_file` で変えると人の画面を奪う）。
 *
 * vscode に依存しない純関数にしてある（ファイルの存在確認だけ注入する）。
 *
 * 層 2 の写し（設計 848 §5.3.1・§6.1 の裁定による例外）: 改行の制約を写さない。凍結版は基準を
 * 1 行の `//#documentDirectory` メタ行で運んだので改行を拒んだが、層 2 は `session.evaluate` の
 * 引数で運ぶので理由が無い。`isOrbitscoreDocument` は凍結版 `diagnostics-analysis.ts` の 1 行。
 */
import * as path from 'path'

function isOrbitscoreDocument(document: { languageId: string }): boolean {
  return document.languageId === 'orbitscore'
}

export interface ActiveEditorDocument {
  languageId: string
  /** `uri.scheme`。未保存（untitled）のエディタはファイルを持たないので基準にしない。 */
  scheme: string
  fsPath: string
}

export interface EvaluateDocumentDirectoryInput {
  documentPath?: string
  activeEditor?: ActiveEditorDocument
  workspaceRoot?: string
  isFile: (absolutePath: string) => boolean
}

export type EvaluateDocumentDirectoryResult =
  | { ok: true; documentDirectory: string | null }
  | { ok: false; error: string }

export function resolveEvaluateDocumentDirectory(
  input: EvaluateDocumentDirectoryInput,
): EvaluateDocumentDirectoryResult {
  const { documentPath, activeEditor, workspaceRoot } = input

  if (documentPath !== undefined) {
    if (documentPath.trim() === '') {
      return { ok: false, error: 'document_path must not be empty' }
    }
    let absolute = documentPath
    if (!path.isAbsolute(documentPath)) {
      if (!workspaceRoot) {
        return {
          ok: false,
          error: `document_path "${documentPath}" is relative but no workspace folder is open — pass an absolute path`,
        }
      }
      absolute = path.resolve(workspaceRoot, documentPath)
    }
    // 🔴 黙って dirname を取らない。打ち間違いのパスで評価すると、基準だけがずれて
    // 原因の遠い `[SAMPLE_NOT_FOUND]` 等として現れる（#966 の症状そのもの）。
    let isFile: boolean
    try {
      isFile = input.isFile(absolute)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `could not inspect document_path "${absolute}": ${detail}` }
    }
    if (!isFile) {
      return { ok: false, error: `document_path "${absolute}" is not an existing file` }
    }
    return { ok: true, documentDirectory: path.dirname(absolute) }
  }

  if (activeEditor && isOrbitscoreDocument(activeEditor) && activeEditor.scheme === 'file') {
    return { ok: true, documentDirectory: path.dirname(activeEditor.fsPath) }
  }

  return { ok: true, documentDirectory: workspaceRoot || null }
}
