/**
 * File import processing (IM.1-IM.6, #456).
 *
 * import = 名前一致のグラフ合成（IM.2）: import 先の宣言群を共有名前空間へ評価するだけで、
 * 隔離スコープは作らない。identity は既存の名前キー reconciliation（process-initialization）
 * に乗る。評価順序（規範）: import はソース記載順・深さ優先（依存が先）・import 元自身の
 * 宣言が常に最後。
 */

import * as fs from 'fs'
import * as path from 'path'

import { AudioIR, FileImportStatement } from '../parser/types'
import { parseAudioDSL } from '../parser/audio-parser'

import { InterpreterState } from './types'
import { processGlobalInit, processSequenceInit } from './process-initialization'
import { processStatement } from './process-statement'

/** 1 回の top-level 評価内でだけ生きる import コンテキスト（IM.2: 評価ごとの module cache）。 */
export interface ImportContext {
  /** 解決済み絶対パス（realpath）→ そのファイルの top-level 宣言名（契約検査用）。 */
  cache: Map<string, Set<string>>
  /** 評価中ファイルの realpath チェーン（循環 import 検出・IM.2）。 */
  stack: string[]
}

/** entry ファイル（あれば）を循環検出チェーンに積んだ新規コンテキストを作る。 */
export function createImportContext(entryFile?: string | null): ImportContext {
  const stack: string[] = []
  if (entryFile) {
    try {
      stack.push(fs.realpathSync(path.resolve(entryFile)))
    } catch (err) {
      // ENOENT（entry が未保存バッファ等で実在しない）だけは自己 import 検出を諦めて続行
      // してよい（REPL・IM.6）。それ以外（EACCES/ELOOP 等）は黙って検出を落とすと IM.2 の
      // 保証が silent に劣化するため明示エラーにする。
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new Error(
          `import: cannot resolve entry file ${entryFile} ` +
            `(${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}): ${(err as Error)?.message} (IM.6).`,
        )
      }
    }
  }
  return { cache: new Map(), stack }
}

/**
 * module ファイルの top-level 宣言名を IR から静的に列挙する（IM.1 契約検査の根拠）。
 * 評価前後の状態差分ではなく IR を見るので、「別ファイル由来で既に存在する同名」を
 * 誤って宣言済み扱いしない。
 */
export function declaredNames(ir: AudioIR): Set<string> {
  const names = new Set<string>()
  if (ir.globalInit) names.add(ir.globalInit.variableName)
  for (const init of ir.sequenceInits) names.add(init.variableName)
  for (const st of ir.statements) {
    if (
      st.type === 'pattern_binding' ||
      st.type === 'chord_binding' ||
      st.type === 'mode_binding'
    ) {
      names.add(st.variableName)
    }
  }
  return names
}

/** import 群をソース記載順に処理する（IM.2 評価順序）。`baseDir` = import 元のディレクトリ。 */
export async function processFileImports(
  imports: FileImportStatement[],
  baseDir: string,
  state: InterpreterState,
  ctx: ImportContext,
): Promise<void> {
  for (const imp of imports) {
    await processOneImport(imp, baseDir, state, ctx)
  }
}

async function processOneImport(
  imp: FileImportStatement,
  baseDir: string,
  state: InterpreterState,
  ctx: ImportContext,
): Promise<void> {
  const resolvedRaw = path.resolve(baseDir, imp.path)
  let realPath: string
  try {
    // IM.2: ダイヤモンド同一性の基準は symlink 解決後の realpath。
    realPath = fs.realpathSync(resolvedRaw)
  } catch (err) {
    // ENOENT 以外（EACCES/ELOOP/ENOTDIR 等）を「file not found」に丸めると、権限や
    // symlink 循環の問題をパス typo と誤診させる — errno を出し分ける。
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      throw new Error(`import "${imp.path}": file not found at ${resolvedRaw} (IM.4).`)
    }
    throw new Error(
      `import "${imp.path}": could not resolve ${resolvedRaw} (${code ?? 'unknown'}): ` +
        `${(err as Error)?.message} (IM.4).`,
    )
  }
  if (ctx.stack.includes(realPath)) {
    throw new Error(
      `import "${imp.path}": circular import detected (${[...ctx.stack, realPath].join(' → ')}) (IM.2).`,
    )
  }

  let names = ctx.cache.get(realPath)
  if (!names) {
    let sourceText: string
    try {
      sourceText = fs.readFileSync(realPath, 'utf8')
    } catch (err) {
      // realpath 成功後の read 失敗（EACCES・TOCTOU 削除等）。生の Node エラーを漏らさず
      // どの import 文が原因かを付ける（本ファイルのエラー規約に合わせる）。
      throw new Error(
        `import "${imp.path}": could not read ${realPath} ` +
          `(${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}): ${(err as Error)?.message} (IM.4).`,
      )
    }
    let ir: AudioIR
    try {
      ir = parseAudioDSL(sourceText)
    } catch (err) {
      // import 先の構文エラーは「どのファイルか」を必ず付ける（深い import 連鎖で
      // ユーザーが手動二分探索する羽目にならないように）。
      throw new Error(
        `import "${imp.path}": parse error in ${realPath}: ${(err as Error)?.message ?? err} (IM.1).`,
      )
    }
    names = declaredNames(ir)
    ctx.stack.push(realPath)
    try {
      await executeModuleIR(ir, realPath, state, ctx)
    } finally {
      ctx.stack.pop()
    }
    ctx.cache.set(realPath, names)
  }

  // IM.1: 名前列挙は契約検査（隔離ではない）。import 先に宣言が無ければエラー。
  for (const n of imp.names) {
    if (!names.has(n)) {
      throw new Error(
        `import { ${n} } from "${imp.path}": "${n}" is not declared in that file (IM.1).`,
      )
    }
  }
}

/**
 * module の IR を import コンテキストで評価する。entry の execute() と同じ
 * globalInit → sequenceInits → statements 順だが、(a) 自身の import を先に処理し
 * （深さ優先）、(b) transport はエラー（IM.3: import 先は宣言専用）、(c) 評価中の
 * documentDirectory は module 自身のディレクトリ（IM.4: audio() 等はファイル基準）。
 */
async function executeModuleIR(
  ir: AudioIR,
  modulePath: string,
  state: InterpreterState,
  ctx: ImportContext,
): Promise<void> {
  const moduleDir = path.dirname(modulePath)
  if (ir.fileImports?.length) {
    await processFileImports(ir.fileImports, moduleDir, state, ctx)
  }
  if (ir.globalInit) {
    await processGlobalInit(ir.globalInit, state)
  }
  // audio() は呼び出し時に resolveAudioSpec で即時解決するため、module 評価中だけ
  // 基準ディレクトリを差し替えれば IM.4 が成立する（entry の documentDirectory は
  // execute() が import 処理の後に設定し直す）。
  state.currentGlobal?.setDocumentDirectory(moduleDir)
  for (const seqInit of ir.sequenceInits) {
    await processSequenceInit(seqInit, state)
  }
  for (const st of ir.statements) {
    if (st.type === 'transport') {
      throw new Error(
        `${st.command.toUpperCase()} is not allowed in an imported file (IM.3): ${modulePath}`,
      )
    }
    await processStatement(st, state)
  }
}
