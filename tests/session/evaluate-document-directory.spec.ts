/**
 * 層 2 の写しの IM.6（#966・設計 848 §5.3.1）。凍結版 `tests/vscode-extension/evaluate-document-directory.spec.ts`
 * の純関数の節を移した。
 *
 * 🔴 改行のケース（凍結版の 4 件 + 「改行を含む workspace root を検査しない」2 件）は**移さない**:
 * 改行の制約は「基準が 1 行のメタ行で運ばれる」ことから来ていて、層 2 は基準を `session.evaluate` の
 * 引数で運ぶ（§6.1 の裁定による例外）。代わりに「改行を含む実在のパスが解決される」を置く。
 */
import { describe, expect, it } from 'vitest'

import { resolveEvaluateDocumentDirectory } from '../../packages/session/src/mcp/evaluate-document-directory'
import { isExistingFileForEvaluation } from '../../packages/session/src/mcp/rpc-tool-handlers'

const WORKSPACE = '/ws'
const orbsEditor = (fsPath: string) => ({ languageId: 'orbitscore', scheme: 'file', fsPath })
const existing =
  (...files: string[]) =>
  (p: string) =>
    files.includes(p)

describe('resolveEvaluateDocumentDirectory in layer 2 (#966 / IM.6)', () => {
  it('1. document_path があればそのディレクトリ（前面のエディタより優先）', () => {
    expect(
      resolveEvaluateDocumentDirectory({
        documentPath: '/ws/b/b.orbs',
        activeEditor: orbsEditor('/ws/a/a.orbs'),
        workspaceRoot: WORKSPACE,
        isFile: existing('/ws/b/b.orbs'),
      }),
    ).toEqual({ ok: true, documentDirectory: '/ws/b' })
  })

  it('1. 相対の document_path は最初のワークスペースフォルダから解決する', () => {
    expect(
      resolveEvaluateDocumentDirectory({
        documentPath: 'piece/piece.orbs',
        workspaceRoot: WORKSPACE,
        isFile: existing('/ws/piece/piece.orbs'),
      }),
    ).toEqual({ ok: true, documentDirectory: '/ws/piece' })
  })

  it('1. 存在しない document_path は黙って dirname を取らずエラー', () => {
    const result = resolveEvaluateDocumentDirectory({
      documentPath: '/ws/typo/piece.orbs',
      activeEditor: orbsEditor('/ws/a/a.orbs'),
      workspaceRoot: WORKSPACE,
      isFile: existing(),
    })
    expect(result).toEqual({
      ok: false,
      error: 'document_path "/ws/typo/piece.orbs" is not an existing file',
    })
  })

  it('1. ワークスペースが無いときの相対 document_path はエラー', () => {
    expect(
      resolveEvaluateDocumentDirectory({ documentPath: 'piece.orbs', isFile: () => true }),
    ).toEqual({
      ok: false,
      error:
        'document_path "piece.orbs" is relative but no workspace folder is open — pass an absolute path',
    })
  })

  it('1. 空の document_path はエラー（省略とは区別する）', () => {
    const result = resolveEvaluateDocumentDirectory({
      documentPath: '  ',
      workspaceRoot: WORKSPACE,
      isFile: () => true,
    })
    expect(result).toEqual({ ok: false, error: 'document_path must not be empty' })
  })

  it('2. 無ければアクティブな OrbitScore エディタのディレクトリ', () => {
    expect(
      resolveEvaluateDocumentDirectory({
        activeEditor: orbsEditor('/ws/piece/piece.orbs'),
        workspaceRoot: WORKSPACE,
        isFile: existing(),
      }),
    ).toEqual({ ok: true, documentDirectory: '/ws/piece' })
  })

  it.each([
    [
      'OrbitScore 以外のエディタ',
      { languageId: 'markdown', scheme: 'file', fsPath: '/ws/doc/x.md' },
    ],
    ['未保存のエディタ', { languageId: 'orbitscore', scheme: 'untitled', fsPath: 'Untitled-1' }],
  ])('3. %s は基準にせず、最初のワークスペースフォルダへ', (_label, activeEditor) => {
    expect(
      resolveEvaluateDocumentDirectory({
        activeEditor,
        workspaceRoot: WORKSPACE,
        isFile: existing(),
      }),
    ).toEqual({ ok: true, documentDirectory: WORKSPACE })
  })

  it('4. どれも無ければ基準なし（null）', () => {
    expect(resolveEvaluateDocumentDirectory({ isFile: existing() })).toEqual({
      ok: true,
      documentDirectory: null,
    })
  })

  it('4. 空文字の workspace root は基準なし（null）', () => {
    expect(resolveEvaluateDocumentDirectory({ workspaceRoot: '', isFile: existing() })).toEqual({
      ok: true,
      documentDirectory: null,
    })
  })

  // §5.3.1 / §6.1 の裁定による例外: 凍結版はどの段でも改行を拒んだ。層 2 は通常どおり解決する。
  it.each([
    [
      'document_path',
      { documentPath: '/ws/odd\nname/piece.orbs', isFile: existing('/ws/odd\nname/piece.orbs') },
      '/ws/odd\nname',
    ],
    [
      'アクティブな OrbitScore エディタ',
      { activeEditor: orbsEditor('/ws/odd\r\nname/piece.orbs'), isFile: existing() },
      '/ws/odd\r\nname',
    ],
    ['workspace root', { workspaceRoot: '/ws/odd\nname', isFile: existing() }, '/ws/odd\nname'],
  ] as const)('改行を含む実在のパス（%s）を拒まずに解決する', (_label, input, expected) => {
    expect(resolveEvaluateDocumentDirectory(input)).toEqual({
      ok: true,
      documentDirectory: expected,
    })
  })

  it('document_path の検査が失敗したときは errno を含むエラーを返す', () => {
    const result = resolveEvaluateDocumentDirectory({
      documentPath: '/ws/secret.orbs',
      isFile: (file) =>
        isExistingFileForEvaluation(file, () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }),
    })
    expect(result).toEqual({
      ok: false,
      error:
        'could not inspect document_path "/ws/secret.orbs": EACCES while checking "/ws/secret.orbs": permission denied',
    })
  })

  it.each(['ENOENT', 'ENOTDIR'])('%s は「存在するファイルではない」として扱う', (code) => {
    expect(
      isExistingFileForEvaluation('/ws/missing.orbs', () => {
        throw Object.assign(new Error(code), { code })
      }),
    ).toBe(false)
  })
})
