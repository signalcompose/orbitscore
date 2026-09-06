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
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'

import { readGatedSourceEntries } from './gated-sources'

// 🔴 走査先は `gated-sources.ts` が持つ（#668 §3.4・PR-E1）。ここで 1 ファイルを決め打ちすると、
// シナリオを別ファイルへ出した時に**検査が新ファイルを見ず、黙って弱くなる**。
const entries = readGatedSourceEntries()
const source = entries.map(({ source: text }) => text).join('\n')

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
const logBaselineArithmeticOffenders = (sourceEntries: readonly SourceEntry[]): string[] => {
  const found: string[] = []
  for (const { file, source: text } of sourceEntries) {
    // ⚠️ `ts.createSourceFile` は**エラー寛容**で、壊れた TS でも例外を投げずに部分的な AST を
    // 返す。したがって対象がパースできなくなると、この検査は**黙って無検出になる**
    // ＝ この suite が直そうとしている偽緑そのものになる。
    //
    // その穴を塞いでいるのは**この検査自身ではなく、同じ CI job が走らせる
    // `npm run typecheck:e2e`**（`.github/workflows/code-review.yml` の "Typecheck gated E2E"）。
    // パースできない gated ソースはそこで先に赤くなるので、ここへは到達しない。
    // 🔴 **その step を消すなら、ここに parse 健全性の検査を足すこと。**
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      const matcher = matcherCall(node)
      const comparedRoots = matcher
        ? [matcher.expectArgument, ...matcher.call.arguments]
        : ts.isBinaryExpression(node) && isRawComparison(node)
          ? [node]
          : []
      const identifiers = comparedRoots
        .flatMap(arithmeticBeforeIdentifiers)
        .filter((name) => !NON_LOG_BASELINE_ALLOWLIST.has(name))
      if (identifiers.length > 0) {
        found.push(formattedNodeLine(file, sourceFile, matcher?.call ?? node))
        return
      }
      node.forEachChild(visit)
    }
    visit(sourceFile)
  }
  return found
}

/** `ERROR` 件数の strict matcher を複数行でも拾う（#625 の既存規律）。 */
const bareErrorCountEqualityOffenders = (sourceEntries: readonly SourceEntry[]): string[] => {
  const found: string[] = []
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
  for (const { file, source: text } of sourceEntries) {
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      const matcher = matcherCall(node)
      if (
        matcher !== undefined &&
        ts.isPropertyAccessExpression(matcher.call.expression) &&
        ['toBe', 'toEqual'].includes(matcher.call.expression.name.text) &&
        [matcher.expectArgument, ...matcher.call.arguments].some(containsErrorCount)
      ) {
        found.push(formattedNodeLine(file, sourceFile, matcher.call))
        return
      }
      node.forEachChild(visit)
    }
    visit(sourceFile)
  }
  return found
}

describe('gated E2E assertion hygiene', () => {
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
    // 一方で `Before` を含まない別名への代入、helper 内へ隠した比較、算術のない strict equality
    // （`:1396` / `:1589` / `:1615` の形）は逃げる。後者は別 issue の対象で、ここでは触らない。
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

  it('still lets the stale guard see the sources the daemon is built from', () => {
    // 逆方向: #713 の修正が行きすぎて `src` まで除外したら、ガードは**古いバイナリを
    // 見逃す**ようになる。それは CLAUDE.md「実機テストは最新ビルドで走る」に反する。
    expect(
      /entry\.name === 'src'/.test(source),
      'The stale-binary guard must NOT skip src/: excluding it would let a stale daemon ' +
        'binary pass, which is exactly what the guard exists to prevent.',
    ).toBe(false)
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
})
