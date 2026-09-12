/**
 * ファイルサイズラチェット（#888 子 0）が使う「コード行」の数え方。
 *
 * 純関数。fs も child_process も触らない。設計の根拠は
 * `docs/design/888-file-size-ratchet-design.md` §3 を参照。
 *
 * **コード行** = 空白・コメント以外の文字を1文字でも含む行。ただし複数行の
 * 文字列 / raw 文字列 / テンプレートリテラルの**内側の行**は、中身が `//` や
 * `*` で始まっていても数える（文字列はコード）。Rust の
 * `#[cfg(test)] mod name { ... }`（`#[cfg(all(test, ...))]` を含む）は
 * ブロックごと `excluded` として集計し、`code` には数えない。
 *
 * 🔴 **迷ったら数える**（§3.3）。走査が終端で異常状態（閉じていない文字列 /
 * ブロックコメント / テンプレートリテラル・閉じていない test mod）のまま
 * 終わったら例外を投げる。黙って少なく数える誤り（= ラチェットの穴）は許さない。
 *
 * TS の正規表現リテラルの判定は発見的（heuristic）である（§3.1 の既知の弱点）。
 * 誤判定の帰結は「文字列状態のまま終端に達する」= 上の例外で気づける形にしてあり、
 * 黙って通ることはない。
 */

export type Lang = 'rust' | 'ts'

export interface CodeLineCount {
  /** 除外されなかった「コード行」の数 */
  code: number
  /** `#[cfg(test)] mod` ブロック（Rust のみ）として除外された行の数 */
  excluded: number
}

type State =
  | { kind: 'normal' }
  | { kind: 'string'; quote: string }
  | { kind: 'raw'; hashes: number }
  | { kind: 'template' }
  | { kind: 'block' }

/**
 * テンプレートリテラルは `${...}` 置換の中に別のテンプレートリテラルを入れ子にできる
 * （例: `` `outer${`inner`}` ``）。1つの `state.kind === 'template'` では表現できないため、
 * 開いているテンプレートリテラルをスタックで持つ。
 *
 * - `substDepth === null`: そのテンプレートの**生テキスト部分**にいる
 *   （`state.kind === 'template'` と対応）
 * - `substDepth !== null`: そのテンプレートの `${...}` 置換の中にいる
 *   （`state.kind === 'normal'` として置換内のコードを通常どおり解釈しつつ、
 *   置換内の `{`/`}` のネスト深さをこのフィールドで数える。対応する `}` に
 *   達したら `null` に戻し生テキスト部分へ戻る）
 */
interface TemplateFrame {
  substDepth: number | null
  /** このテンプレートリテラル全体が開始した行（1-based）。エラーメッセージ用（§8.1）。 */
  startLine: number
}

const WHITESPACE = new Set([' ', '\t', '\r', '\f', '\v'])

function isWhitespace(ch: string): boolean {
  return WHITESPACE.has(ch)
}

// test 限定の cfg 属性行（§3.2 の 1）。`all(...)` は先頭要素が `test` の時だけ。
const CFG_TEST_EXACT = /^#\[cfg\(test\)\]$/
const CFG_TEST_ALL = /^#\[cfg\(all\(\s*test\s*,.*\)\)\]$/
// 介在を許す「別の属性行」（§3.2 の 2）。
const ATTRIBUTE_LINE = /^#!?\[.*\]$/
// `mod name {`（`pub` / `pub(crate)` 等を含む・同じ行に `{`。§3.2 の 3）。
const MOD_OPEN_LINE = /^(?:pub(?:\([\w:]+\))?\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{$/

function isTestCfgAttrLine(trimmed: string): boolean {
  return CFG_TEST_EXACT.test(trimmed) || CFG_TEST_ALL.test(trimmed)
}

/** TS の `/` が正規表現リテラルの開始とみなせる文脈か（§3.1）。 */
function isRegexLiteralContext(line: string, index: number): boolean {
  let j = index - 1
  while (j >= 0 && isWhitespace(line[j] as string)) j--
  if (j < 0) return true // 行頭
  const ch = line[j] as string
  if ('(,=:[!&|?{};+'.includes(ch)) return true
  const word = /([a-zA-Z_$][a-zA-Z0-9_$]*)$/.exec(line.slice(0, j + 1))
  return word !== null && (word[1] === 'return' || word[1] === 'typeof')
}

/** 正規表現リテラルの終端を探す。見つからなければ null（呼び出し側は除算として扱う）。 */
function matchRegexLiteral(line: string, start: number): string | null {
  let i = start + 1
  let inClass = false
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '[') {
      inClass = true
      i++
      continue
    }
    if (ch === ']') {
      inClass = false
      i++
      continue
    }
    if (ch === '/' && !inClass) {
      i++
      while (i < line.length && /[a-zA-Z]/.test(line[i] as string)) i++
      return line.slice(start, i)
    }
    i++
  }
  return null
}

/** Rust の raw / raw byte 文字列プレフィクス（`r"` / `r#"` / `br"` / `br#"`）。 */
function matchRawStringPrefix(
  line: string,
  index: number,
): { hashes: number; length: number } | null {
  const m = /^(?:br|r)(#*)"/.exec(line.slice(index))
  if (!m) return null
  return { hashes: (m[1] as string).length, length: m[0].length }
}

/** Rust の文字リテラル（`'x'` / `'\n'` / `'"'` / `'{'`）。マッチしなければライフタイム。 */
function matchCharLiteral(line: string, index: number): string | null {
  const m = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|['"\\nrt0])|[^'\\])'/.exec(
    line.slice(index),
  )
  return m ? m[0] : null
}

export function countCodeLines(source: string, lang: Lang): CodeLineCount {
  const lines = source.split('\n')

  let state: State = { kind: 'normal' }
  let braceDepth = 0
  const excludeStack: Array<{ braceDepth: number; startLine: number }> = []
  const templateStack: TemplateFrame[] = []
  // string / raw / block（`state.kind` で一意に特定できる・入れ子にならない）の開始行。
  // template は入れ子になるので `templateStack` の各フレームが自分の startLine を持つ。
  let blockingStateStartLine = 0
  let pendingAttrActive = false
  // 🔴 バッファに積まれる行は必ず `isTestCfgAttrLine` / `ATTRIBUTE_LINE` / `MOD_OPEN_LINE` の
  // どれかに一致した行で、いずれも `#[...]` や `mod x {` の**完全一致**を要求する。行コメントや
  // 末尾コメント付きの行は一致しないので、積まれた行は例外なくコード行である。よって行ごとの
  // `isCode` は持たず件数だけを数える（一致条件を緩める変更をしても、多く数える側へ倒れる）。
  let pendingCount = 0

  let code = 0
  let excluded = 0

  const commitPending = (asExcluded: boolean) => {
    if (asExcluded) excluded += pendingCount
    else code += pendingCount
    pendingCount = 0
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineText = lines[lineIndex] as string
    const stateAtLineStart = state.kind
    const excludeDepthAtLineStart = excludeStack.length
    let lineHasCode = false
    let i = 0

    while (i < lineText.length) {
      const ch = lineText[i] as string

      if (state.kind === 'block') {
        if (ch === '*' && lineText[i + 1] === '/') {
          state = { kind: 'normal' }
          i += 2
        } else {
          i++
        }
        continue
      }

      if (state.kind === 'string') {
        lineHasCode = true
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === state.quote) state = { kind: 'normal' }
        i++
        continue
      }

      if (state.kind === 'template') {
        lineHasCode = true
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === '`') {
          // このテンプレートリテラルが閉じた。外側（置換の中 / 真の top-level）どちらに
          // 戻る場合も、以降のコードは通常どおり解釈するので 'normal' へ戻る。
          templateStack.pop()
          state = { kind: 'normal' }
          i++
          continue
        }
        if (ch === '$' && lineText[i + 1] === '{') {
          // 置換の開始。生テキスト部分を離れ、`${...}` の中身を通常のコードとして
          // 解釈する（入れ子のテンプレートリテラル・文字列・コメントを許すため）。
          const top = templateStack[templateStack.length - 1] as TemplateFrame
          top.substDepth = 0
          state = { kind: 'normal' }
          i += 2
          continue
        }
        i++
        continue
      }

      // テンプレートリテラルの `${...}` 置換の中（`state.kind === 'normal'` のまま）。
      // 置換内の `{`/`}` のネスト深さを数え、対応する `}` で生テキスト部分へ戻る。
      if (state.kind === 'normal' && templateStack.length > 0) {
        const top = templateStack[templateStack.length - 1] as TemplateFrame
        if (top.substDepth !== null) {
          if (ch === '{') {
            lineHasCode = true
            top.substDepth++
            i++
            continue
          }
          if (ch === '}') {
            lineHasCode = true
            if (top.substDepth === 0) {
              top.substDepth = null
              state = { kind: 'template' }
            } else {
              top.substDepth--
            }
            i++
            continue
          }
        }
      }

      if (state.kind === 'raw') {
        lineHasCode = true
        if (ch === '"') {
          let h = 0
          while (lineText[i + 1 + h] === '#') h++
          if (h === state.hashes) {
            state = { kind: 'normal' }
            i += 1 + h
            continue
          }
        }
        i++
        continue
      }

      // state.kind === 'normal'
      if (ch === '/' && lineText[i + 1] === '/') {
        break // 行コメント。残りは捨てる。
      }
      if (ch === '/' && lineText[i + 1] === '*') {
        state = { kind: 'block' }
        blockingStateStartLine = lineIndex + 1
        i += 2
        continue
      }

      if (lang === 'rust') {
        if (ch === "'") {
          lineHasCode = true
          const literal = matchCharLiteral(lineText, i)
          i += literal ? literal.length : 1 // マッチしなければライフタイムとして1文字進める
          continue
        }
        if (ch === 'r' || ch === 'b') {
          const raw = matchRawStringPrefix(lineText, i)
          if (raw) {
            lineHasCode = true
            state = { kind: 'raw', hashes: raw.hashes }
            blockingStateStartLine = lineIndex + 1
            i += raw.length
            continue
          }
        }
        if (ch === '{') {
          lineHasCode = true
          braceDepth++
          i++
          continue
        }
        if (ch === '}') {
          lineHasCode = true
          braceDepth--
          i++
          if (
            excludeStack.length > 0 &&
            braceDepth <
              (excludeStack[excludeStack.length - 1] as { braceDepth: number }).braceDepth
          ) {
            excludeStack.pop()
          }
          continue
        }
      }

      if (ch === '"') {
        lineHasCode = true
        state = { kind: 'string', quote: '"' }
        blockingStateStartLine = lineIndex + 1
        i++
        continue
      }
      if (lang === 'ts') {
        if (ch === "'") {
          lineHasCode = true
          state = { kind: 'string', quote: "'" }
          blockingStateStartLine = lineIndex + 1
          i++
          continue
        }
        if (ch === '`') {
          lineHasCode = true
          templateStack.push({ substDepth: null, startLine: lineIndex + 1 })
          state = { kind: 'template' }
          i++
          continue
        }
        if (ch === '/') {
          if (isRegexLiteralContext(lineText, i)) {
            const literal = matchRegexLiteral(lineText, i)
            if (literal) {
              lineHasCode = true
              i += literal.length
              continue
            }
          }
          lineHasCode = true // 除算として扱う
          i++
          continue
        }
      }

      if (!isWhitespace(ch)) lineHasCode = true
      i++
    }

    const trimmed = lineText.trim()

    if (lang === 'rust' && stateAtLineStart === 'normal' && excludeDepthAtLineStart === 0) {
      if (pendingAttrActive) {
        if (MOD_OPEN_LINE.test(trimmed)) {
          pendingCount++
          commitPending(true) // 属性行 + mod 行をまとめて除外する
          excludeStack.push({ braceDepth, startLine: lineIndex + 1 })
          pendingAttrActive = false
          continue
        }
        if (ATTRIBUTE_LINE.test(trimmed)) {
          pendingCount++
          continue
        }
        // パターンが切れた。バッファは通常どおり数える（除外しない）。
        commitPending(false)
        pendingAttrActive = false
        // fallthrough: 現在行を通常どおり評価する。
      }
      if (isTestCfgAttrLine(trimmed)) {
        pendingAttrActive = true
        pendingCount++
        continue
      }
    }

    if (excludeDepthAtLineStart > 0) {
      excluded++
    } else if (lineHasCode) {
      code++
    }
  }

  // ファイル末尾で pending が残っていたら（mod に至らなかった属性行）通常どおり数える。
  if (pendingCount > 0) {
    commitPending(false)
  }

  if (state.kind !== 'normal') {
    // 'template' は入れ子になるので、開始行はスタックの最内側（現在アクティブなもの）から取る。
    // string / raw / block は入れ子にならないので `blockingStateStartLine` を使う。
    const startLine =
      state.kind === 'template'
        ? (templateStack[templateStack.length - 1] as TemplateFrame).startLine
        : blockingStateStartLine
    throw new Error(
      `countCodeLines: ${startLine} 行目から開始した state=${state.kind} が終端まで閉じられていません` +
        `（閉じていない文字列 / ブロックコメント / テンプレートリテラル）。全 ${lines.length} 行`,
    )
  }
  if (templateStack.length > 0) {
    // state.kind === 'normal' のまま終端に達したが、テンプレートリテラルの `${...}` 置換が
    // 閉じ切っていない（対応する `}` と、その外側のテンプレートを閉じる `` ` `` が無い）。
    const top = templateStack[templateStack.length - 1] as TemplateFrame
    throw new Error(
      `countCodeLines: ${top.startLine} 行目から開始したテンプレートリテラルの ` +
        `\${...} 置換（state=template）が終端まで閉じられていません` +
        `（depth=${templateStack.length}）。全 ${lines.length} 行`,
    )
  }
  if (excludeStack.length > 0) {
    const top = excludeStack[excludeStack.length - 1] as { braceDepth: number; startLine: number }
    throw new Error(
      `countCodeLines: ${top.startLine} 行目から開始した #[cfg(test)] mod の閉じ括弧が` +
        `見つからないまま終わりました（depth=${excludeStack.length}）。全 ${lines.length} 行`,
    )
  }

  return { code, excluded }
}
