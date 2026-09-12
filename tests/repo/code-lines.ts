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
  const excludeStack: number[] = []
  let pendingAttrActive = false
  let pendingBuffer: Array<{ isCode: boolean }> = []

  let code = 0
  let excluded = 0

  const commitPending = (asExcluded: boolean) => {
    for (const entry of pendingBuffer) {
      if (asExcluded) excluded++
      else if (entry.isCode) code++
    }
    pendingBuffer = []
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
        if (ch === '`') state = { kind: 'normal' }
        i++
        continue
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
            braceDepth < (excludeStack[excludeStack.length - 1] as number)
          ) {
            excludeStack.pop()
          }
          continue
        }
      }

      if (ch === '"') {
        lineHasCode = true
        state = { kind: 'string', quote: '"' }
        i++
        continue
      }
      if (lang === 'ts') {
        if (ch === "'") {
          lineHasCode = true
          state = { kind: 'string', quote: "'" }
          i++
          continue
        }
        if (ch === '`') {
          lineHasCode = true
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
          pendingBuffer.push({ isCode: lineHasCode })
          commitPending(true) // 属性行 + mod 行をまとめて除外する
          excludeStack.push(braceDepth)
          pendingAttrActive = false
          continue
        }
        if (ATTRIBUTE_LINE.test(trimmed)) {
          pendingBuffer.push({ isCode: lineHasCode })
          continue
        }
        // パターンが切れた。バッファは通常どおり数える（除外しない）。
        commitPending(false)
        pendingAttrActive = false
        // fallthrough: 現在行を通常どおり評価する。
      }
      if (isTestCfgAttrLine(trimmed)) {
        pendingAttrActive = true
        pendingBuffer.push({ isCode: lineHasCode })
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
  if (pendingBuffer.length > 0) {
    commitPending(false)
  }

  if (state.kind !== 'normal') {
    throw new Error(
      `countCodeLines: 終端で state=${state.kind} のまま終わりました` +
        `（閉じていない文字列 / ブロックコメント / テンプレートリテラル）。全 ${lines.length} 行`,
    )
  }
  if (excludeStack.length > 0) {
    throw new Error(
      `countCodeLines: 終端で #[cfg(test)] mod の閉じ括弧が見つからないまま終わりました` +
        `（depth=${excludeStack.length}）。全 ${lines.length} 行`,
    )
  }

  return { code, excluded }
}
