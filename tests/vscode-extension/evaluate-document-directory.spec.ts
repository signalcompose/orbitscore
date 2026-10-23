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

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import {
  evaluateForAgent,
  isExistingFileForEvaluation,
} from '../../packages/vscode-extension/src/agent-handlers'
import { writeCodeToEngine } from '../../packages/vscode-extension/src/engine-process'
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

  it('1. 改行を含む document_path はエラー（メタ行が割れる）', () => {
    const file = '/ws/odd\nname/piece.orbs'
    expect(
      resolveEvaluateDocumentDirectory({ documentPath: file, isFile: existing(file) }),
    ).toEqual({ ok: false, error: 'document_path must not contain a line break' })
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

  it('2. 改行を含むアクティブエディタのパスはエラー', () => {
    expect(
      resolveEvaluateDocumentDirectory({
        activeEditor: orbsEditor('/ws/odd\nname/piece.orbs'),
        workspaceRoot: WORKSPACE,
        isFile: existing(),
      }),
    ).toEqual({
      ok: false,
      error: 'active OrbitScore editor path must not contain a line break',
    })
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

  it.each([
    ['OrbitScore 以外', { languageId: 'markdown', scheme: 'file', fsPath: '/ws/odd\nname/x.md' }],
    [
      'file scheme 以外',
      { languageId: 'orbitscore', scheme: 'untitled', fsPath: '/ws/odd\nname/x.orbs' },
    ],
  ])('3. 改行を含む%sのアクティブエディタは拒まず、次の候補へ進む', (_label, activeEditor) => {
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

  it('3. 改行を含む workspace root はエラー', () => {
    expect(
      resolveEvaluateDocumentDirectory({ workspaceRoot: '/ws/odd\nname', isFile: existing() }),
    ).toEqual({
      ok: false,
      error: 'workspace folder path must not contain a line break',
    })
  })

  it('1. document_path が決めた後は、改行を含む workspace root を検査しない', () => {
    const file = '/outside/piece.orbs'
    expect(
      resolveEvaluateDocumentDirectory({
        documentPath: file,
        workspaceRoot: '/ws/odd\nname',
        isFile: existing(file),
      }),
    ).toEqual({ ok: true, documentDirectory: '/outside' })
  })

  it('2. 有効なアクティブエディタが決めた後は、改行を含む workspace root を検査しない', () => {
    expect(
      resolveEvaluateDocumentDirectory({
        activeEditor: orbsEditor('/outside/piece.orbs'),
        workspaceRoot: '/ws/odd\nname',
        isFile: existing(),
      }),
    ).toEqual({ ok: true, documentDirectory: '/outside' })
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

  it('改行を含むアクティブエディタの基準はエラーにして何も送らない', async () => {
    vscodeMock.window.activeTextEditor = {
      document: {
        languageId: 'orbitscore',
        uri: { scheme: 'file', fsPath: path.join(tmpRoot, 'odd\nname', 'piece.orbs') },
      },
    }

    const result = await evaluateForAgent('global.tempo(120)')

    expect(written).toEqual([])
    expect(result).toEqual({
      ok: false,
      error: 'active OrbitScore editor path must not contain a line break',
    })
  })

  it('改行を含む workspace root はエラーにして何も送らない', async () => {
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: `${tmpRoot}\nodd` } }]

    const result = await evaluateForAgent('global.tempo(120)')

    expect(written).toEqual([])
    expect(result).toEqual({
      ok: false,
      error: 'workspace folder path must not contain a line break',
    })
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

  it('document_path の stat が予期しない errno で失敗したら検査エラーを返す', async () => {
    const loopA = path.join(tmpRoot, 'a')
    const loopB = path.join(tmpRoot, 'b')
    fs.symlinkSync('b', loopA)
    fs.symlinkSync('a', loopB)

    const result = await evaluateForAgent('global.tempo(120)', {
      documentPath: path.join(loopA, 'piece.orbs'),
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected document_path inspection to fail')
    expect(result.error).toContain('could not inspect')
    expect(result.error).toContain('ELOOP')
    expect(written).toEqual([])
  })

  it('基準が無いときは空のメタ行で前回の基準を消してから評価する', async () => {
    vscodeMock.workspace.workspaceFolders = undefined

    const result = await evaluateForAgent('import { kick } from "./drums.orbs"')

    expect(written).toEqual([
      '//#evalBegin\n//#documentDirectory\nimport { kick } from "./drums.orbs"\n//#evalEnd\n',
    ])
    expect(result).toEqual({ ok: true, documentDirectory: null })
  })

  // A line break would split the meta line, so the directory itself is never sent. It is
  // sent as "no base" (an empty meta line), not omitted: omitting it would let the REPL keep
  // the previous evaluation's base (#966 / IM.6 rule 4).
  it('a directory with a line break is sent as "no base", never as the directory itself', () => {
    writeCodeToEngine('global.tempo(120)', '/ws/odd\nname')

    expect(written).toEqual(['//#evalBegin\n//#documentDirectory\nglobal.tempo(120)\n//#evalEnd\n'])
  })

  // /code-review: `"` in the directory used to end the injected DSL string early.
  it('a directory name with a double quote round-trips through the injected DSL', async () => {
    const piece = path.join(tmpRoot, 'my "set"', 'piece.orbs')
    fs.mkdirSync(path.dirname(piece), { recursive: true })
    fs.writeFileSync(piece, '')

    await evaluateForAgent('var global = init GLOBAL', { documentPath: piece })

    const sent = written.find((line) => line.includes('setDocumentDirectory')) ?? ''
    expect(sentDirectory()).toBe(path.dirname(piece))
    const injected = parseAudioDSL(sent).statements.find(
      (statement) => (statement as { method?: string }).method === 'setDocumentDirectory',
    ) as { args: unknown[] } | undefined
    expect(injected?.args).toEqual([path.dirname(piece)])
  })
})
