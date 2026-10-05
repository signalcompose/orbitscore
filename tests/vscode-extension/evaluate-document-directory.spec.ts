/**
 * #966: `evaluate_orbitscore` の基準ディレクトリ（core spec IM.6）。
 *
 * 以前は常に最初のワークスペースフォルダを送っていたので、`.orbs` がサブフォルダに
 * あると import / audio() / plugin state の相対パスが `run_selection` とずれた。
 *
 * 前半は決め方（純関数）、後半は `evaluateForAgent` がその結果を実際に engine へ
 * 送る `//#documentDirectory` 行と結果に使っていること（配線）を見る。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { evaluateForAgent } from '../../packages/vscode-extension/src/agent-handlers'
import { EvalMarkBridge } from '../../packages/vscode-extension/src/eval-mark-bridge'
import { resolveEvaluateDocumentDirectory } from '../../packages/vscode-extension/src/evaluate-document-directory'
import {
  __setEngineProcessForTest,
  __setLiveCodingModeForTest,
} from '../../packages/vscode-extension/src/extension-state'
import * as vscodeMock from '../mocks/vscode'

const WORKSPACE = '/ws'
const orbsEditor = (fsPath: string) => ({ languageId: 'orbitscore', scheme: 'file', fsPath })
const existing =
  (...files: string[]) =>
  (p: string) =>
    files.includes(p)

describe('resolveEvaluateDocumentDirectory (#966 / IM.6)', () => {
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
    const result = resolveEvaluateDocumentDirectory({
      documentPath: 'piece.orbs',
      isFile: () => true,
    })
    expect(result.ok).toBe(false)
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
})

describe('evaluateForAgent の配線 (#966)', () => {
  let tmpRoot: string
  let written: string[]

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orb966-'))
    written = []
    const proc = {
      killed: false,
      stdin: {
        writable: true,
        write: (line: string, cb?: (error?: Error | null) => void) => {
          written.push(line)
          cb?.(null)
          return true
        },
      },
    }
    __setEngineProcessForTest(proc as never)
    __setLiveCodingModeForTest(true)
    // engine の評価結果は待たない（このテストが見るのは送った行と返した基準だけ）。
    vi.spyOn(EvalMarkBridge.prototype, 'send').mockResolvedValue({
      requestId: 'r',
      ok: true,
      diagnostics: [],
    })
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }]
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vscodeMock.window.activeTextEditor = undefined
    vscodeMock.workspace.workspaceFolders = undefined
    __setEngineProcessForTest(null)
    __setLiveCodingModeForTest(false)
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  const sentDirectory = (): string | undefined => {
    const code = written.find((line) => line.includes('//#documentDirectory'))
    return code?.match(/^\/\/#documentDirectory (.+)$/m)?.[1]
  }

  it('アクティブな .orbs がサブフォルダにあれば、そのディレクトリを送って返す（#966 の再現）', async () => {
    const piece = path.join(tmpRoot, 'piece', 'piece.orbs')
    vscodeMock.window.activeTextEditor = {
      document: { languageId: 'orbitscore', uri: { scheme: 'file', fsPath: piece } },
    }

    const result = await evaluateForAgent('global.tempo(120)')

    expect(sentDirectory()).toBe(path.dirname(piece))
    expect(result).toEqual({ ok: true, documentDirectory: path.dirname(piece) })
  })

  it('document_path は前面のエディタより優先される', async () => {
    const other = path.join(tmpRoot, 'other', 'other.orbs')
    fs.mkdirSync(path.dirname(other), { recursive: true })
    fs.writeFileSync(other, '')
    vscodeMock.window.activeTextEditor = {
      document: {
        languageId: 'orbitscore',
        uri: { scheme: 'file', fsPath: path.join(tmpRoot, 'piece', 'piece.orbs') },
      },
    }

    const result = await evaluateForAgent('global.tempo(120)', { documentPath: 'other/other.orbs' })

    expect(sentDirectory()).toBe(path.dirname(other))
    expect(result).toEqual({ ok: true, documentDirectory: path.dirname(other) })
  })

  it('存在しない document_path なら engine へ何も送らない', async () => {
    const result = await evaluateForAgent('global.tempo(120)', { documentPath: 'missing.orbs' })

    expect(result.ok).toBe(false)
    expect(written).toEqual([])
  })
})
