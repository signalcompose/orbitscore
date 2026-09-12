/**
 * gated E2E のアサーション衛生（2026-08-29）。
 *
 * 🔴 これも**知識を仕組みに変える**ためのテストである。
 *
 * CLAUDE.md は「`evaluate_orbitscore` の `ok` に assert しても何も証明しない」と繰り返し
 * 書いている（`ok` は「受理して書き込んだ」を返すだけで、**エンジン側のエラーは
 * `get_log` にしか出ない**）。それでも #528 で同じ罠を踏んだ。文章は読まれない時がある。
 *
 * ここでは gated spec 自身のソースを検査して、**弱いアサーションの型を機械的に**探す。
 * 完全ではないが、「書いた本人が気づかなかった」を CI が拾える位置に置く価値はある。
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'

import { readGatedSourceEntries } from './gated-sources'

// 🔴 走査先は `gated-sources.ts` が持つ（#668 §3.4・PR-E1）。ここで 1 ファイルを決め打ちすると、
// シナリオを別ファイルへ出した時に**検査が新ファイルを見ず、黙って弱くなる**。
const entries = readGatedSourceEntries()
const source = entries.map(({ source: text }) => text).join('\n')
const repoRoot = path.resolve(__dirname, '../..')

type SourceEntry = (typeof entries)[number]

/**
 * **式**をまたいで正規表現を照合し、一致した箇所を `file:line` で返す。
 *
 * 🔴 なぜ行単位ではだめか: この suite の `expect()` は matcher と引数が別の行に来ることが多い。
 * 行ごとに照合すると、同じ違反でも 1 行に収まったものだけを捕まえ、複数行に散らしたものを
 * 見逃す — 検査が「書き方」に依存してしまう。
 *
 * コメント行（`//` / JSDoc の `*`）は連結の前に落とす。アンチパターンを**説明した注釈**を
 * 検査自身が拾うと、正しく直したのに赤くなる（規律を説明できなくなる）。
 *
 * 連結後も改行は空白文字なので、`\s*` を含む正規表現がそのまま跨いで一致する。
 * 行番号は連結後のオフセットから引き直す。
 */
const offendingLines = (sourceEntries: readonly SourceEntry[], pattern: RegExp): string[] => {
  const isComment = (line: string): boolean => {
    const trimmed = line.trim()
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
  }
  const found: string[] = []
  for (const { file, source: text } of sourceEntries) {
    // 連結後のオフセット → 元の行番号 を引けるよう、残した行の開始位置を控える。
    const kept: Array<{ n: number; line: string; at: number }> = []
    let joined = ''
    text.split('\n').forEach((line, i) => {
      if (isComment(line)) return
      kept.push({ n: i + 1, line, at: joined.length })
      joined += `${line}\n`
    })
    const scan = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    )
    for (let m = scan.exec(joined); m !== null; m = scan.exec(joined)) {
      const index = m.index
      // 一致開始位置を含む行（`at <= index` の最後の要素）。
      let hit = kept[0]
      for (const candidate of kept) {
        if (candidate.at > index) break
        hit = candidate
      }
      if (hit !== undefined) found.push(`${file}:${hit.n}: ${hit.line.trim()}`)
    }
  }
  return found
}

const MATCHER_NAMES = new Set([
  'toBe',
  'toEqual',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
])

/**
 * 算術比較ラチェットから外してよいことを、代入元まで読んで確認した識別子。
 *
 * 🔴 名前に `Before` があるだけで黙って対象外にしない。由来が変わった時にレビューで見えるよう、
 * 「何を数える baseline か」を 1 件ずつここへ固定する。
 */
const NON_LOG_BASELINE_ALLOWLIST = new Set([
  'stateFilesBeforeDropB', // `stateFileCount(statesDirectory)` が実ディレクトリの state ファイルを数える。
  'daemonPidsBeforeStart', // `orbitAudioDaemonPids()` が OS のプロセス一覧を読み、get_log を使わない。
])

const isBeforeIdentifier = (node: ts.Node): node is ts.Identifier =>
  ts.isIdentifier(node) && /[Bb]efore/.test(node.text)

const arithmeticBeforeIdentifiers = (root: ts.Node): readonly string[] => {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
        node.operatorToken.kind === ts.SyntaxKind.MinusToken)
    ) {
      const collect = (candidate: ts.Node): void => {
        if (isBeforeIdentifier(candidate)) names.add(candidate.text)
        candidate.forEachChild(collect)
      }
      collect(node)
    }
    node.forEachChild(visit)
  }
  visit(root)
  return [...names]
}

const isRawComparison = (node: ts.BinaryExpression): boolean =>
  [
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ].includes(node.operatorToken.kind)

const matcherCall = (
  node: ts.Node,
): { readonly call: ts.CallExpression; readonly expectArgument: ts.Expression } | undefined => {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression))
    return undefined
  if (!MATCHER_NAMES.has(node.expression.name.text)) return undefined
  const expectCall = node.expression.expression
  if (
    !ts.isCallExpression(expectCall) ||
    !ts.isIdentifier(expectCall.expression) ||
    expectCall.expression.text !== 'expect' ||
    expectCall.arguments[0] === undefined
  ) {
    return undefined
  }
  return { call: node, expectArgument: expectCall.arguments[0] }
}

const formattedNodeLine = (file: string, sourceFile: ts.SourceFile, node: ts.Node): string => {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${file}:${line + 1}: ${sourceFile.text.split('\n')[line]!.trim()}`
}

/**
 * `Before` を**含む**識別子が `+` / `-` に参加し、その式を matcher または生の比較演算子で
 * 比較している箇所を AST で拾う。`expect(after - before).toBe(1)` も expect 側を調べる。
 */
/**
 * 3 本の検出器が共有する走査の骨格（#785 で 3 本目ができたときに抽出した）。
 *
 * `makeOffenderAt` は**ファイルごとに 1 回**呼ばれるので、事前に集めておきたい情報
 * （provenance 検出器の log-text / log-count 識別子など）はそのクロージャの中で作れる。
 * 返した述語が違反ノードを返したら位置を `file:line: 内容` の形で記録し、**その枝は掘らない**
 * （入れ子の同型違反を二重報告しないため）。
 *
 * ⚠️ `ts.createSourceFile` は**エラー寛容**で、壊れた TS でも例外を投げずに部分的な AST を
 * 返す。したがって対象がパースできなくなると、これらの検査は**黙って無検出になる**
 * ＝ この suite が直そうとしている偽緑そのものになる。
 *
 * その穴を塞いでいるのは**この検査自身ではなく、同じ CI job が走らせる
 * `npm run typecheck:e2e`**（`.github/workflows/code-review.yml` の "Typecheck gated E2E"）。
 * パースできない gated ソースはそこで先に赤くなるので、ここへは到達しない。
 * 🔴 **その step を消すなら、ここに parse 健全性の検査を足すこと。**
 */
const scanGatedSources = (
  sourceEntries: readonly SourceEntry[],
  makeOffenderAt: (sourceFile: ts.SourceFile) => (node: ts.Node) => ts.Node | undefined,
): string[] => {
  const found: string[] = []
  for (const { file, source: text } of sourceEntries) {
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const offenderAt = makeOffenderAt(sourceFile)
    const visit = (node: ts.Node): void => {
      const offender = offenderAt(node)
      if (offender !== undefined) {
        found.push(formattedNodeLine(file, sourceFile, offender))
        return
      }
      node.forEachChild(visit)
    }
    visit(sourceFile)
  }
  return found
}

const logBaselineArithmeticOffenders = (sourceEntries: readonly SourceEntry[]): string[] =>
  scanGatedSources(sourceEntries, () => (node) => {
    const matcher = matcherCall(node)
    const comparedRoots = matcher
      ? [matcher.expectArgument, ...matcher.call.arguments]
      : ts.isBinaryExpression(node) && isRawComparison(node)
        ? [node]
        : []
    const identifiers = comparedRoots
      .flatMap(arithmeticBeforeIdentifiers)
      .filter((name) => !NON_LOG_BASELINE_ALLOWLIST.has(name))
    return identifiers.length > 0 ? (matcher?.call ?? node) : undefined
  })

/** `ERROR` 件数の strict matcher を複数行でも拾う（#625 の既存規律）。 */
const bareErrorCountEqualityOffenders = (sourceEntries: readonly SourceEntry[]): string[] => {
  const containsErrorCount = (root: ts.Node): boolean => {
    let contains = false
    const visit = (node: ts.Node): void => {
      if (
        (ts.isIdentifier(node) && /(?:errorsBefore|errorCount|catalogErrors)/i.test(node.text)) ||
        (ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'countErrors')
      ) {
        contains = true
        return
      }
      node.forEachChild(visit)
    }
    visit(root)
    return contains
  }
  return scanGatedSources(sourceEntries, () => (node) => {
    const matcher = matcherCall(node)
    return matcher !== undefined &&
      ts.isPropertyAccessExpression(matcher.call.expression) &&
      ['toBe', 'toEqual'].includes(matcher.call.expression.name.text) &&
      [matcher.expectArgument, ...matcher.call.arguments].some(containsErrorCount)
      ? matcher.call
      : undefined
  })
}

/**
 * `get_log` の戻り値に由来する文字列に対する `.match(...).length` を、**名前ではなく値の
 * 出どころ（provenance）**で追跡し、それを strict equality（`toBe` / `toEqual`）で比較して
 * いないかを AST で辿る（#785）。
 *
 * 🔴 なぜ名前で条件付けないか: すぐ上の `bareErrorCountEqualityOffenders` は識別子名
 * （`/(?:errorsBefore|errorCount|catalogErrors)/i`）に依存しているため、
 * `stoppedBeforeRejectedSave` / `attachFailuresBefore*` のような別名は素通りする。
 * **名前は書き手が自由に付けられるので、名前で条件付ける限り必ず漏れる。**
 *
 * 追跡する2種類の識別子（いずれも `.text` プロパティの読み出し元まで遡る）:
 * - **log-text 識別子**: `get_log` 呼び出しの `.text` に直接束縛された文字列
 *   （`const x = (await client.call('get_log', {...})).text` の直接形、または
 *   `const { text } = await client.call('get_log', {...})` の分割代入。エイリアス
 *   （`{ text: log }`）も拾う）。
 * - **log-count 識別子**: log-text 識別子（またはインラインの `get_log(...).text`）に対する
 *   `.match(pattern).length`（`?? []` フォールバックの有無を問わない）に束縛された数値。
 *
 * matcher（`toBe` / `toEqual`）の被検査値・引数のどちらかが、上記いずれかの識別子
 * （またはそれと同型のインライン式）であれば違反として報告する。
 */
const unwrapParens = (expr: ts.Expression): ts.Expression => {
  let e = expr
  while (ts.isParenthesizedExpression(e)) e = e.expression
  return e
}

/** `<obj>.call('get_log', ...)`（`await` / 非 null アサーション `!` の有無を問わない）。 */
const isGetLogCall = (expr: ts.Expression): boolean => {
  let e = unwrapParens(expr)
  if (ts.isAwaitExpression(e)) e = unwrapParens(e.expression)
  if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false
  if (e.expression.name.text !== 'call') return false
  const firstArg = e.arguments[0]
  return firstArg !== undefined && ts.isStringLiteralLike(firstArg) && firstArg.text === 'get_log'
}

/** `(await <obj>.call('get_log', ...)).text` のインライン形。 */
const isInlineLogText = (expr: ts.Expression): boolean => {
  const e = unwrapParens(expr)
  return ts.isPropertyAccessExpression(e) && e.name.text === 'text' && isGetLogCall(e.expression)
}

/** `<expr>.match(pattern)` の `<expr>`（`match` 呼び出しでなければ `undefined`）。 */
const matchCallBase = (node: ts.Expression): ts.Expression | undefined => {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return undefined
  }
  if (node.expression.name.text !== 'match') return undefined
  return node.expression.expression
}

/**
 * `(<expr>.match(pattern) ?? []).length` / `<expr>.match(pattern).length` の `<expr>`。
 * `.length` プロパティアクセスでなければ `undefined`。
 */
const matchLengthBase = (node: ts.Node): ts.Expression | undefined => {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'length') return undefined
  let inner = unwrapParens(node.expression)
  if (
    ts.isBinaryExpression(inner) &&
    inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    inner = unwrapParens(inner.left)
  }
  return matchCallBase(inner)
}

/** `<expr>` が識別子 `paramName` そのものを指しているか（括弧を剥いだ上で比較）。 */
const isIdentifierRef = (expr: ts.Expression, paramName: string): boolean => {
  const e = unwrapParens(expr)
  return ts.isIdentifier(e) && e.text === paramName
}

/**
 * `<expr>` が `paramName` に対する「件数」の式か: `paramName.match(...).length`
 * （`?? []` の有無を問わない）か、`knownHelpers` に含まれる名前の呼び出しで第 1 引数が
 * `paramName` である形（#789 policy 1・ローカルラッパー解決の判定単位）。
 */
const isCountExprOfParam = (
  expr: ts.Expression,
  paramName: string,
  knownHelpers: ReadonlySet<string>,
): boolean => {
  const matchBase = matchLengthBase(unwrapParens(expr))
  if (matchBase !== undefined && isIdentifierRef(matchBase, paramName)) return true
  const e = unwrapParens(expr)
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return false
  if (!knownHelpers.has(e.expression.text)) return false
  const first = e.arguments[0]
  return first !== undefined && isIdentifierRef(first, paramName)
}

/**
 * ブロック本体**自身**の `return` 文の式を集める（ネストした関数の中へは潜らない —
 * 潜ると内側の別関数の return を、外側のラッパーの本体と取り違える）。
 */
const ownReturnExpressions = (block: ts.Block): ts.Expression[] => {
  const exprs: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      exprs.push(node.expression)
      return
    }
    node.forEachChild(visit)
  }
  block.forEachChild(visit)
  return exprs
}

type LocalWrapperCandidate = {
  readonly name: string
  readonly paramName: string
  readonly bodyExprs: readonly ts.Expression[]
}

/**
 * ファイル内の関数宣言、および arrow / function 式を代入した const を、count-helper
 * ラッパー候補として集める（本体の判定は呼び出し側の `resolveLogCountHelperNames` が行う）。
 */
const collectLocalWrapperCandidates = (sourceFile: ts.SourceFile): LocalWrapperCandidate[] => {
  const candidates: LocalWrapperCandidate[] = []
  const addCandidate = (
    name: string,
    fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  ): void => {
    const firstParam = fn.parameters[0]
    if (firstParam === undefined || !ts.isIdentifier(firstParam.name)) return
    if (fn.body === undefined) return
    const bodyExprs = ts.isBlock(fn.body) ? ownReturnExpressions(fn.body) : [fn.body]
    candidates.push({ name, paramName: firstParam.name.text, bodyExprs })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      addCandidate(node.name.text, node)
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      addCandidate(node.name.text, node.initializer)
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return candidates
}

/**
 * `logCountHelpers`（「log 由来の文字列を受けて件数を返す関数」の名前集合）を解決する
 * （#789 policy 1）。
 *
 * これまでは「値の形」の列挙だった: 名前 → `Before` の算術 → `.match().length` → import した
 * helper。**ローカルラッパーは次の「形」**であり、1 つずつ足す限り必ず次が漏れる
 * （`countAttachFailures` が `countLogMarker` を包んだことで、3 本のラチェットすべてから
 * 構造的に見えなくなっていた実例 — `orbitstudio-mcp-gated.spec.ts:2563`）。
 *
 * したがって「形の列挙」をやめ、**関数宣言・arrow 定数のうち、本体（式本体・`return` 文の
 * どちらでも）が第 1 引数に対する count 式であるもの**を一般に解決する。
 *
 * 🔴 ラッパーがラッパーを包む場合に届くよう、集合が増えなくなるまで反復する。
 */
const resolveLogCountHelperNames = (sourceFile: ts.SourceFile): Set<string> => {
  const helpers = new Set<string>()
  const collectImportedCountHelpers = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes('engine-log')
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text
          if (imported === 'countErrors' || imported === 'countLogMarker') {
            helpers.add(element.name.text)
          }
        }
      }
    }
    node.forEachChild(collectImportedCountHelpers)
  }
  collectImportedCountHelpers(sourceFile)

  // 🔴 除外リストは作らない。引っかかった箇所は直す。
  const candidates = collectLocalWrapperCandidates(sourceFile)
  let changed = true
  while (changed) {
    changed = false
    for (const candidate of candidates) {
      if (helpers.has(candidate.name)) continue
      const isWrapper = candidate.bodyExprs.some((expr) =>
        isCountExprOfParam(expr, candidate.paramName, helpers),
      )
      if (isWrapper) {
        helpers.add(candidate.name)
        changed = true
      }
    }
  }
  return helpers
}

/**
 * `resolveLogCountHelperNames` を gated コーパス全体へ適用した和集合（#789 policy 4 の
 * 生存確認テスト専用）。
 */
const resolvedLogCountHelperNamesAcrossCorpus = (
  sourceEntries: readonly SourceEntry[],
): Set<string> => {
  const all = new Set<string>()
  for (const { file, source: text } of sourceEntries) {
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    for (const name of resolveLogCountHelperNames(sourceFile)) all.add(name)
  }
  return all
}

const logProvenanceStrictEqualityOffenders = (sourceEntries: readonly SourceEntry[]): string[] =>
  scanGatedSources(sourceEntries, (sourceFile) => {
    // Pass 1: `get_log` の `.text` に直接束縛された識別子（直接形・分割代入の両方）。
    const logTextIdentifiers = new Set<string>()
    const collectLogText = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        if (ts.isIdentifier(node.name) && isInlineLogText(node.initializer)) {
          logTextIdentifiers.add(node.name.text)
        } else if (ts.isObjectBindingPattern(node.name) && isGetLogCall(node.initializer)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue
            const sourceProp = element.propertyName
              ? ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : undefined
              : element.name.text
            if (sourceProp === 'text') logTextIdentifiers.add(element.name.text)
          }
        }
      }
      node.forEachChild(collectLogText)
    }
    collectLogText(sourceFile)

    // 🔴 `helpers/engine-log` から import した `countErrors` / `countLogMarker`（別名も追う）
    // に加えて、**ローカルの薄いラッパー**（`countAttachFailures = (log) => countLogMarker(log,
    // pattern)` のような形）も解決する。名前や import 経路の列挙は書き手が自由に増やせる
    // 「形」なので、1 つずつ足す限り必ず次が漏れる（#789 policy 1）。
    const logCountHelpers = resolveLogCountHelperNames(sourceFile)

    const isLogDerivedText = (expr: ts.Expression): boolean => {
      if (isInlineLogText(expr)) return true
      const e = unwrapParens(expr)
      return ts.isIdentifier(e) && logTextIdentifiers.has(e.text)
    }

    /** `countErrors(<log 由来>)` / `countLogMarker(<log 由来>, ...)` の形か。 */
    const isLogCountHelperCall = (expr: ts.Expression): boolean => {
      const e = unwrapParens(expr)
      if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return false
      if (!logCountHelpers.has(e.expression.text)) return false
      const first = e.arguments[0]
      return first !== undefined && isLogDerivedText(first)
    }

    /** log 由来の値を「件数」に変える式か（`.match(...).length` か helper 呼び出し）。 */
    const isLogDerivedCount = (expr: ts.Expression): boolean => {
      const base = matchLengthBase(unwrapParens(expr))
      if (base !== undefined && isLogDerivedText(base)) return true
      return isLogCountHelperCall(expr)
    }

    // Pass 2: 上の「件数」に束縛された識別子。2 パスに分けているのは、宣言の並び順
    // （テキスト識別子 → カウント識別子）に依存せず、ファイル内のどこにあっても拾うため。
    const logCountIdentifiers = new Set<string>()
    const collectLogCount = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        isLogDerivedCount(node.initializer)
      ) {
        logCountIdentifiers.add(node.name.text)
      }
      node.forEachChild(collectLogCount)
    }
    collectLogCount(sourceFile)

    const isOffendingArg = (argNode: ts.Expression): boolean => {
      const e = unwrapParens(argNode)
      if (ts.isIdentifier(e) && logCountIdentifiers.has(e.text)) return true
      return isLogDerivedCount(e)
    }

    return (node) => {
      const matcher = matcherCall(node)
      return matcher !== undefined &&
        ts.isPropertyAccessExpression(matcher.call.expression) &&
        ['toBe', 'toEqual'].includes(matcher.call.expression.name.text) &&
        [matcher.expectArgument, ...matcher.call.arguments].some(isOffendingArg)
        ? matcher.call
        : undefined
    }
  })

describe('gated E2E assertion hygiene', () => {
  // 🔴 `LOOP()` は**追加ではなく置換**である（`process-statement.ts` の `calculateLoopDiff()` が
  // 新 group から外れた sequence を算出し `stopSequences(toStop)` する）。したがって
  // `LOOP(a)` の次に `LOOP(b)` を書くと **a が止まる**。
  //
  // 差分法のオラクル（可聴な基準シーケンス + 意図的に無音な対象）を使う譜面でこれをやると、
  // **基準まで止まって全体が無音**になり、「無音である」という判定が偶然通ってしまう。
  // #883 束 S の新 fixture 3 本が揃ってこれを踏んだ（PR #885・実機 gated で 4 件 red）。
  //
  // 🔴 **個別のファイル名や LOOP 行の中身を固定しない。** 守りたいのは「置換である」という
  // 一般的性質なので、**ファイルごとの `LOOP(` 出現数が高々 1** であることだけを見る。
  // これなら fixture が増えてもこのテストを編集せずに追随する。
  it('never splits a gated fixture across more than one replacement-style LOOP call', () => {
    const fixtureDir = path.join(repoRoot, 'tests/fixtures/mcp-e2e')
    const offenders = fs
      .readdirSync(fixtureDir)
      .filter((entry) => entry.endsWith('.orbs'))
      .map((entry) => {
        const loops = fs
          .readFileSync(path.join(fixtureDir, entry), 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('LOOP('))
        return { entry, loops }
      })
      .filter(({ loops }) => loops.length > 1)

    expect(
      offenders.map(({ entry, loops }) => `${entry}: ${loops.join(' / ')}`),
      'LOOP() replaces the loop group — a second call stops what the first started. ' +
        'Name every sequence in one LOOP(...) instead.',
    ).toEqual([])
  })

  it('never asserts on a bare ERROR count equality', () => {
    // `get_log` は固定 500 行窓なので、ERROR 件数の**厳密等価**は窓の外へ流れた瞬間に
    // 嘘になる（#625）。`<=` / `toBeLessThanOrEqual` を使うこと。
    const offenders = bareErrorCountEqualityOffenders(entries)
    expect(
      offenders,
      'ERROR counts come from a fixed 500-line window; compare with toBeLessThanOrEqual, ' +
        'not strict equality (see CLAUDE.md #625).',
    ).toEqual([])
  })

  it('never maps capture segments by subtracting wall time from final duration', () => {
    const offenders = offendingLines(entries, /durationSec\s*-\s*\(stopWall/)
    expect(
      offenders,
      'Capture segments must use the capture-file byte clock; final-duration wall-clock ' +
        'reverse mapping can silently point at the start of the file (#739).',
    ).toEqual([])
  })

  it('does not use the engine log as the only oracle for audible behaviour', () => {
    // 音に出る機能は**キャプチャの数値**で判定する。ここでは「capture を使う spec に
    // rms/peak のアサーションが実在するか」だけを確かめる（個々のテストの強さは見ない）。
    // 🔴 `runScore(..., { capture: true })` も capture 経路（#668 §17 F-1）。
    // これを入れ忘れると、新しいシナリオが**何も測らなくても検査が通る**。
    const usesCapture = /captureInstrumentScenario|capture_wav|capturePath|capture:\s*true/.test(
      source,
    )
    if (!usesCapture) return
    expect(
      /\brms\(|\bpeak\(|\.rms\b/.test(source),
      'This suite captures audio but never asserts on RMS or peak. ' +
        'A capture that nothing measures is not evidence (see CLAUDE.md「キャプチャ E2E」).',
    ).toBe(true)
  })

  it('keeps the stale-artifact guard wired to the real resolver', () => {
    // 🔴 このガードは 2026-08-29 に**パスを2回間違えている**。決め打ちに戻ったら赤にする。
    expect(
      /resolveDaemonBinaryPath\(\)/.test(source),
      'The stale-binary guard must ask resolveDaemonBinaryPath() which binary will actually ' +
        'be spawned. Hardcoding a path reintroduces the very failure the guard exists to stop.',
    ).toBe(true)
  })

  it('keeps the stale guard off cargo targets it can never rebuild', () => {
    // 🔴 #713: ガードが `rust/**/tests/*.rs` まで mtime 比較の対象にしていたため、
    // **解消不能な赤**になり実機 gated が全部落ちた。統合テストは別 cargo ターゲットで
    // daemon バイナリに入らないので、cargo は正しく何もビルドせず（`Finished in 0.21s`）、
    // バイナリの mtime は永久に更新されない。mtime は `git checkout` で動くので、
    // ブランチを行き来しただけで発火する。
    //
    // ⚠️ この検査は「除外していること」だけを見る。**`src/` の除外は別の話**で、
    // そちらを除外したらガードの目的自体が失われる（下の逆方向の検査）。
    expect(
      /entry\.name === 'tests' \|\| entry\.name === 'benches' \|\| entry\.name === 'examples'/.test(
        source,
      ),
      'The stale-binary guard must skip tests/benches/examples: they are separate cargo ' +
        'targets that never enter the daemon binary, so cargo will not rebuild for them and ' +
        'the guard can never be satisfied (#713).',
    ).toBe(true)
  })

  it('never claims a log-derived count increased by comparing to a baseline', () => {
    // 🔴 #761: `get_log` は固定 500 行窓。「baseline + N になった」という主張は、古い行が
    // 窓から流れ出るだけで崩れる（**偽赤**）。2026-09-05 に #618 E1-E6 が
    // `expected 6 to be greater than or equal to 7` で落ちたのがこれ。
    //
    // 上の 1 本目（bare ERROR count equality）は `GreaterThan` を含む行を**除外**するので
    // `toBeGreaterThanOrEqual(errorsBefore + 1)` を捕まえられない。ここがその補完になる。
    //
    // 🔴 実際の守備範囲は「名前のどこかに `Before` を含む識別子が `+` / `-` に参加し、
    // その式が matcher または生の比較演算子で比較される箇所」。Before が名前の途中にある形、
    // `return count >= errorsBefore + 1`、`expect(count - failuresBefore).toBe(1)` も拾う。
    // 一方で `Before` を含まない別名への代入・helper 内へ隠した比較・**算術のない strict
    // equality**（旧 `:1378` / `:1397` / `:1590` / `:1616` の形）は逃げる — こちらは名前でなく
    // **値の出どころ**（`get_log` の戻り値 → `.match(...).length`）を AST で辿る
    // `logProvenanceStrictEqualityOffenders`（下の別テスト・#785）が拾う。
    //
    // 正しい形は `newLogLines` / `newErrorLines` で「**どの行が**増えたか」を見ること。多重集合の
    // 差分は窓のずれに影響されず、「想定した 1 件以外は増えていない」という強い主張もできる。
    //
    // 🔴 **1 行ずつ照合してはいけない**。この suite の主流の `expect()` は複数行に跨る:
    //
    //     expect(x, msg).toBeGreaterThanOrEqual(
    //       errorsBefore + 1,
    //     )
    //
    // matcher と引数が別の行に来るので、行単位の照合では**素通りする**。AST はコメントを
    // 構文ノードとして訪問せず、改行にも依存しない。違反ノードの開始位置から元の行番号を返す。
    const offenders = logBaselineArithmeticOffenders(entries)
    expect(
      offenders,
      'Log counts come from a fixed 500-line window, so "baseline + N" claims break when old ' +
        'lines scroll out. Say WHICH lines appeared with newLogLines()/newErrorLines() (#761).',
    ).toEqual([])
  })

  it('never asserts a log-derived match count via strict equality, regardless of identifier name', () => {
    // 🔴 #785: 上の1本目（bare ERROR count equality）は識別子名
    // （`/(?:errorsBefore|errorCount|catalogErrors)/i`）に依存するため、
    // `stoppedBeforeRejectedSave` / `attachFailuresBefore*` のような別名は素通りしていた
    // （実際に `tests/e2e/orbitstudio-mcp-gated.spec.ts` の4箇所がこれで両ラチェットを
    // 逃れていた: `:1378` `.toBe(0)`、`:1397` `.toBe(stoppedBeforeRejectedSave)`、
    // `:1590` `.toBe(attachFailuresBeforeRoleMismatch)`、`:1616`
    // `.toBe(attachFailuresBeforeSecondSeq)` — いずれも #785 で `newLogLines` の行差分へ
    // 移行済み）。
    //
    // ここは名前を見ない。`get_log` の戻り値に由来する文字列（`.text` への直接束縛・
    // 分割代入・インラインのいずれも）を追跡し、その文字列に対する `.match(...).length`
    // （`?? []` の有無を問わない）が、変数を経由していても・インラインでも、
    // `toBe`/`toEqual` の被検査値または引数に現れたら違反とする。
    //
    // 🔴 除外リストは無い。引っかかった箇所は直す（本 issue の趣旨がそれ）。
    const offenders = logProvenanceStrictEqualityOffenders(entries)
    expect(
      offenders,
      'A count derived from get_log() via .match(...).length must not be compared with ' +
        'strict equality (toBe/toEqual), no matter what the identifier is named: the fixed ' +
        '500-line window makes both toBe(0) (false green) and toBe(before) (false red) lie. ' +
        'Say WHICH lines appeared with newLogLines()/newErrorLines() instead (#785).',
    ).toEqual([])
  })

  it('still lets the stale guard see the sources the daemon is built from', () => {
    // 逆方向: #713 の修正が行きすぎて `src` まで除外したら、ガードは**古いバイナリを
    // 見逃す**ようになる。それは CLAUDE.md「実機テストは最新ビルドで走る」に反する。
    expect(
      /entry\.name === 'src'/.test(source),
      'The stale-binary guard must NOT skip src/: excluding it would let a stale daemon ' +
        'binary pass, which is exactly what the guard exists to prevent.',
    ).toBe(false)
  })

  it('keeps resolving at least one log-count helper from the real gated corpus (#789 policy 4)', () => {
    // 🔴 `resolveLogCountHelperNames` の import 判定は
    // `moduleSpecifier.text.includes('engine-log')` という**ファイル名の文字列一致**に頼っている。
    // `helpers/engine-log.ts` が rename / 移動されると、この検査は例外を投げず**黙って**空振り
    // し、provenance ラチェット全体が構造的に無力化される — `gated-sources.ts` が空リストで
    // throw するのと同じ発想で、ここに生存確認を置く。
    const resolved = resolvedLogCountHelperNamesAcrossCorpus(entries)
    expect(
      [...resolved].sort(),
      'No log-count helper name resolved from the real gated corpus. This almost certainly ' +
        "means the import-matching heuristic (moduleSpecifier.text.includes('engine-log')) " +
        'silently broke (file rename, refactor, or the helper module was replaced with a ' +
        'typed wrapper) and the provenance detector (#785/#789) is now blind.',
    ).not.toEqual([])
  })
})

describe('gated E2E assertion hygiene scanner fixtures', () => {
  it('finds a violation split across lines', () => {
    const fixture = [
      {
        file: 'split.ts',
        source: ['expect(current).toBeGreaterThanOrEqual(', '  errorsBefore + 1,', ')'].join('\n'),
      },
    ]

    expect(offendingLines(fixture, /\.toBeGreaterThanOrEqual\(\s*errorsBefore\s*\+\s*1/)).toEqual([
      'split.ts:1: expect(current).toBeGreaterThanOrEqual(',
    ])
  })

  it('does not flag a commented-out violation', () => {
    const fixture = [
      {
        file: 'comment.ts',
        source: [
          '// expect(current).toBe(errorsBefore + 1)',
          '/*',
          ' * expect(current).toBe(errorsBefore + 1)',
          ' */',
        ].join('\n'),
      },
    ]

    expect(offendingLines(fixture, /\.toBe\(\s*errorsBefore\s*\+\s*1/)).toEqual([])
  })

  it('returns an empty list for clean input', () => {
    const fixture = [
      { file: 'clean.ts', source: 'expect(newErrorLines(before, after)).toEqual([])' },
    ]

    expect(offendingLines(fixture, /\.toBe\(\s*errorsBefore\s*\+\s*1/)).toEqual([])
  })

  it('reports the original line number and finds every match without requiring g', () => {
    const fixture = [
      {
        file: 'lines.ts',
        source: [
          'const harmless = true',
          'expect(first).toBe(errorsBefore + 1)',
          '',
          'expect(second).toBe(errorsBefore + 1)',
        ].join('\n'),
      },
    ]

    expect(offendingLines(fixture, /\.toBe\(\s*errorsBefore\s*\+\s*1/)).toEqual([
      'lines.ts:2: expect(first).toBe(errorsBefore + 1)',
      'lines.ts:4: expect(second).toBe(errorsBefore + 1)',
    ])
  })

  it('finds middle- Before names, raw comparisons, and subtract-first comparisons', () => {
    const fixture = [
      {
        file: 'structural.ts',
        source: [
          'expect(current).toBe(spawnsBeforeFull.length + 1)',
          'return countErrors(log) >= errorsBeforeExpectedFailure + 1',
          'expect(countLogMarker(log, marker) - switchFailuresBefore).toBe(1)',
        ].join('\n'),
      },
    ]

    expect(logBaselineArithmeticOffenders(fixture)).toEqual([
      'structural.ts:1: expect(current).toBe(spawnsBeforeFull.length + 1)',
      'structural.ts:2: return countErrors(log) >= errorsBeforeExpectedFailure + 1',
      'structural.ts:3: expect(countLogMarker(log, marker) - switchFailuresBefore).toBe(1)',
    ])
  })

  it('finds a split strict equality between windowed ERROR counts', () => {
    const fixture = [
      {
        file: 'strict-error.ts',
        source: [
          "expect(catalogErrorsAfter, 'no new errors').toBe(",
          '  catalogErrorsBefore,',
          ')',
        ].join('\n'),
      },
    ]

    expect(bareErrorCountEqualityOffenders(fixture)).toEqual([
      "strict-error.ts:1: expect(catalogErrorsAfter, 'no new errors').toBe(",
    ])
  })

  it('keeps verified non-log baselines explicit in the allow-list', () => {
    const fixture = [
      {
        file: 'allow-listed.ts',
        source: 'expect(stateFileCount(dir)).toBe(stateFilesBeforeDropB + 1)',
      },
    ]

    expect(logBaselineArithmeticOffenders(fixture)).toEqual([])
  })

  // ── #785: provenance-based scanner (name-independent) ──

  it('flags a match-length count stored in a variable and compared bare (mirrors #785 :1616)', () => {
    const fixture = [
      {
        file: 'variable-indirection.ts',
        source: [
          "const beforeLog = (await client.call('get_log', { lines: 500 })).text",
          'const before = (beforeLog.match(/FAIL/g) ?? []).length',
          "const afterLog = (await client.call('get_log', { lines: 500 })).text",
          'const after = (afterLog.match(/FAIL/g) ?? []).length',
          'expect(after).toBe(before)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([
      'variable-indirection.ts:5: expect(after).toBe(before)',
    ])
  })

  it('flags an inline get_log().text.match().length count used as a bare matcher argument (mirrors #785 :1590)', () => {
    const fixture = [
      {
        file: 'inline-get-log.ts',
        source: [
          'const before = (',
          "  (await client.call('get_log', { lines: 500 })).text.match(/FAIL/g) ?? []",
          ').length',
          'const observedFailures = countTotalFailuresFromSomewhereElse()',
          'expect(observedFailures).toBe(before)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([
      'inline-get-log.ts:5: expect(observedFailures).toBe(before)',
    ])
  })

  it('flags an inline match-length expectArgument compared to a literal via toBe(0) (mirrors #785 :1378)', () => {
    const fixture = [
      {
        file: 'literal-zero.ts',
        source: [
          "const afterAttachLog = (await client.call('get_log', { lines: 500 })).text",
          'expect(',
          '  (afterAttachLog.match(/\\[FAILED\\]/g) ?? []).length,',
          ').toBe(0)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual(['literal-zero.ts:2: expect('])
  })

  it('follows a countErrors() helper call, even when the import is aliased (#789 altitude)', () => {
    // 🔴 1 本目（`bareErrorCountEqualityOffenders`）は `countErrors` を**リテラルな名前**で
    // 特別扱いしているだけなので、`import { countErrors as ce }` のような別名にすると
    // どちらの検出器からも消える — 2 本目を作った目的（名前依存の脆さの解消）が
    // 1 本目の特例として残っていた。import の局所名を解決してその穴を塞ぐ。
    const fixture = [
      {
        file: 'aliased-helper.ts',
        source: [
          "import { countErrors as ce } from './helpers/engine-log'",
          "const beforeLog = (await client.call('get_log', { lines: 500 })).text",
          'const before = ce(beforeLog)',
          "const afterLog = (await client.call('get_log', { lines: 500 })).text",
          'expect(ce(afterLog)).toBe(before)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([
      'aliased-helper.ts:5: expect(ce(afterLog)).toBe(before)',
    ])
  })

  it('does not flag a count helper applied to something that is not log-derived', () => {
    // 陰性: 同じ helper でも、引数が `get_log` 由来でなければ窓の問題は起きない。
    const fixture = [
      {
        file: 'not-log-derived.ts',
        source: [
          "import { countErrors } from './helpers/engine-log'",
          'const captured = readSomeFileSync(path)',
          'expect(countErrors(captured)).toBe(0)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([])
  })

  // ── #789 policy 1: local wrapper resolution (`resolveLogCountHelperNames`) ──

  it('follows a local wrapper around a count helper (mirrors #789 :2563 countAttachFailures)', () => {
    // 陽性: `helpers/engine-log` を直接使わず、ローカルの薄いラッパー
    // （`countAttachFailures = (log) => countLogMarker(log, pattern)`）越しに件数を取る形。
    // 旧検出器はこの形を**構造的に見なかった**（`orbitstudio-mcp-gated.spec.ts:2563` に
    // 実在した実例。#789 の束レビュー指摘 A）。
    const fixture = [
      {
        file: 'local-wrapper.ts',
        source: [
          "import { countLogMarker } from './helpers/engine-log'",
          'const countAttachFailures = (log: string): number =>',
          '  countLogMarker(log, /\\[OUTPROC_ATTACH_FAILED\\]/g)',
          "const beforeLog = (await client.call('get_log', { lines: 500 })).text",
          'const before = countAttachFailures(beforeLog)',
          "const afterLog = (await client.call('get_log', { lines: 500 })).text",
          'expect(countAttachFailures(afterLog)).toBe(before)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([
      'local-wrapper.ts:7: expect(countAttachFailures(afterLog)).toBe(before)',
    ])
  })

  it('follows a wrapper that wraps another local wrapper (fixed-point resolution)', () => {
    // ラッパーがラッパーを包む形。1 パスでは `countAttachFailuresAgain` は解決できない
    // （`countAttachFailures` が先に helpers 集合に入っていないと判定できない）ので、
    // 集合が増えなくなるまでの反復（fixed point）が効いていることを確かめる。
    const fixture = [
      {
        file: 'nested-wrapper.ts',
        source: [
          "import { countLogMarker } from './helpers/engine-log'",
          'function countAttachFailures(log: string): number {',
          '  return countLogMarker(log, /\\[OUTPROC_ATTACH_FAILED\\]/g)',
          '}',
          'const countAttachFailuresAgain = (log: string): number => countAttachFailures(log)',
          "const beforeLog = (await client.call('get_log', { lines: 500 })).text",
          'const before = countAttachFailuresAgain(beforeLog)',
          "const afterLog = (await client.call('get_log', { lines: 500 })).text",
          'expect(countAttachFailuresAgain(afterLog)).toBe(before)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([
      'nested-wrapper.ts:9: expect(countAttachFailuresAgain(afterLog)).toBe(before)',
    ])
  })

  it('does not flag a local wrapper applied to something that is not log-derived', () => {
    // 陰性: ラッパー経由でも、引数が `get_log` 由来でなければ窓の問題は起きない
    // （ラッパーの解決は定義の形だけを見るので、呼び出し側の由来チェックが別途効くこと
    // を確かめる）。
    const fixture = [
      {
        file: 'wrapper-not-log-derived.ts',
        source: [
          "import { countLogMarker } from './helpers/engine-log'",
          'const countAttachFailures = (log: string): number =>',
          '  countLogMarker(log, /\\[OUTPROC_ATTACH_FAILED\\]/g)',
          'const captured = readSomeFileSync(path)',
          'expect(countAttachFailures(captured)).toBe(0)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([])
  })

  it('flags the same double-variable shape via toEqual, not just toBe', () => {
    const fixture = [
      {
        file: 'via-toequal.ts',
        source: [
          "const beforeLog = (await client.call('get_log', { lines: 500 })).text",
          'const countBefore = (beforeLog.match(/FAIL/g) ?? []).length',
          "const afterLog = (await client.call('get_log', { lines: 500 })).text",
          'const countAfter = (afterLog.match(/FAIL/g) ?? []).length',
          'expect(countAfter).toEqual(countBefore)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([
      'via-toequal.ts:5: expect(countAfter).toEqual(countBefore)',
    ])
  })

  it('does not flag toBeLessThanOrEqual / toBeGreaterThanOrEqual on a log-derived count', () => {
    const fixture = [
      {
        file: 'lenient.ts',
        source: [
          "const log = (await client.call('get_log', { lines: 500 })).text",
          'const errors = (log.match(/ERROR:/g) ?? []).length',
          'expect(errors).toBeLessThanOrEqual(errorsBefore)',
          'expect(errors).toBeGreaterThanOrEqual(0)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([])
  })

  it('does not flag a raw `>` wait predicate (not an assertion)', () => {
    const fixture = [
      {
        file: 'wait-predicate.ts',
        source: [
          "const before = (await client.call('get_log', { lines: 500 })).text",
          'const stopsBefore = (before.match(/STOP/g) ?? []).length',
          'await waitUntil(async () => {',
          "  const log = (await client.call('get_log', { lines: 500 })).text",
          '  return (log.match(/STOP/g) ?? []).length > stopsBefore',
          '})',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([])
  })

  it('does not flag a match-length count on a string that is not get_log-derived', () => {
    const fixture = [
      {
        file: 'unrelated-string.ts',
        source: [
          'const notes = readFile(path)',
          'const count = (notes.match(/TODO/g) ?? []).length',
          'expect(count).toBe(0)',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([])
  })

  it('does not flag the fixed newLogLines() form', () => {
    const fixture = [
      {
        file: 'fixed.ts',
        source: [
          "const before = (await client.call('get_log', { lines: 500 })).text",
          "const after = (await client.call('get_log', { lines: 500 })).text",
          "const newFailedLines = newLogLines(before, after).filter((line) => line.includes('FAILED'))",
          'expect(newFailedLines).toEqual([])',
        ].join('\n'),
      },
    ]

    expect(logProvenanceStrictEqualityOffenders(fixture)).toEqual([])
  })
})
