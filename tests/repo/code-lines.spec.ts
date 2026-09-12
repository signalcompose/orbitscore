import { describe, expect, it } from 'vitest'

import { countCodeLines } from './code-lines'

/**
 * `countCodeLines` の機能テスト（#888 子 0）。
 *
 * すべて文字列フィクスチャで検証する（実ファイルは読まない）。実ファイルに対する
 * 検証は `file-size-ratchet.spec.ts` の側で行う。表は
 * `docs/design/888-file-size-ratchet-design.md` §9.1 の F-1〜F-19 に対応する。
 */
describe('countCodeLines', () => {
  it('F-1: 空行・空白行のみは code 0', () => {
    expect(countCodeLines('\n   \n\t\n', 'rust')).toEqual({ code: 0, excluded: 0 })
  })

  it('F-2: // /// //! だけの行は code 0', () => {
    const src = ['// 通常コメント', '/// doc コメント', '//! モジュールコメント'].join('\n')
    expect(countCodeLines(src, 'rust').code).toBe(0)
  })

  it('F-3: 行末コメント付きの行は code 1', () => {
    expect(countCodeLines('let x = 1; // 注', 'rust').code).toBe(1)
  })

  it('F-4: 3行のブロックコメントは code 0', () => {
    const src = ['/*', ' * 注釈', ' */'].join('\n')
    expect(countCodeLines(src, 'rust').code).toBe(0)
  })

  it('F-5: コードの後ろにブロックコメントがある行は code 1', () => {
    expect(countCodeLines('let s = "a"; /* 注 */', 'rust').code).toBe(1)
  })

  it('F-6: 複数行 raw 文字列は中身が { で始まっても3行とも code', () => {
    const src = ['let s = r#"{', '"x": 1', '}"#;'].join('\n')
    expect(countCodeLines(src, 'rust').code).toBe(3)
  })

  it('F-7: 行末 \\ で継続する通常文字列は2行とも code', () => {
    const src = ['let s = "a\\', 'b";'].join('\n')
    expect(countCodeLines(src, 'rust').code).toBe(2)
  })

  it('F-8: #[cfg(test)] mod は除外され、前後の prod 行は code', () => {
    const src = [
      'fn prod_before() {}',
      '#[cfg(test)]',
      'mod tests {',
      '  fn t() {}',
      '}',
      'fn prod_after() {}',
    ].join('\n')
    expect(countCodeLines(src, 'rust')).toEqual({ code: 2, excluded: 4 })
  })

  it('F-9: #[cfg(all(test, feature = "x"))] mod も除外される', () => {
    const src = [
      'fn prod() {}',
      '#[cfg(all(test, feature = "x"))]',
      'mod tests {',
      '  fn t() {}',
      '}',
    ].join('\n')
    expect(countCodeLines(src, 'rust')).toEqual({ code: 1, excluded: 4 })
  })

  it('F-10: #[cfg(any(test, feature = "x"))] mod は除外されない（prod でも展開されうる）', () => {
    const src = ['#[cfg(any(test, feature = "x"))]', 'mod tests {', '  fn t() {}', '}'].join('\n')
    // 全行 code（除外なし）
    expect(countCodeLines(src, 'rust')).toEqual({ code: 4, excluded: 0 })
  })

  it('F-11: 介在する別の属性行があっても除外される', () => {
    const src = ['#[cfg(test)]', '#[allow(dead_code)]', 'mod tests {', '  fn t() {}', '}'].join(
      '\n',
    )
    expect(countCodeLines(src, 'rust')).toEqual({ code: 0, excluded: 5 })
  })

  it('F-12: mod 以外（fn）に付いた #[cfg(test)] は除外されない', () => {
    const src = ['#[cfg(test)]', 'fn helper() {}'].join('\n')
    expect(countCodeLines(src, 'rust')).toEqual({ code: 2, excluded: 0 })
  })

  it('F-13: 文字リテラルとライフタイムを含む行は code 1・状態が壊れない', () => {
    const src = "let pairs = [('{', '\"'), ('a', 'a')]; let x: &'a str = s;"
    expect(countCodeLines(src, 'rust').code).toBe(1)
  })

  it('F-14: test mod の中に \'}\' と "}" があっても除外の depth が正しく 0 に戻る', () => {
    const src = [
      '#[cfg(test)]',
      'mod tests {',
      '  fn t() { let c = \'}\'; let s = "}"; }',
      '}',
      'fn prod() {}',
    ].join('\n')
    expect(countCodeLines(src, 'rust')).toEqual({ code: 1, excluded: 4 })
  })

  it('F-15: 複数行テンプレートリテラルは内側が // で始まっても3行とも code', () => {
    const src = ['const s = `', '// x', '`'].join('\n')
    expect(countCodeLines(src, 'ts').code).toBe(3)
  })

  it('F-16: クォートを含む正規表現リテラルは throw しない', () => {
    // dsl-completion-context.ts / gated-sources.ts で実在する形（設計 §2）
    expect(() => countCodeLines(`const re = /(['"\`])/g`, 'ts')).not.toThrow()
    expect(countCodeLines(`const re = /(['"\`])/g`, 'ts').code).toBe(1)
  })

  it('F-17: 除算の連続 + 行末コメントは code 1', () => {
    expect(countCodeLines('const y = a / b / c // 注', 'ts').code).toBe(1)
  })

  it('F-18a: 閉じない文字列は例外を投げる', () => {
    expect(() => countCodeLines('let s = "unterminated', 'rust')).toThrow(/state=string/)
  })

  it('F-18b: 閉じないブロックコメントは例外を投げる', () => {
    expect(() => countCodeLines('/* unterminated', 'ts')).toThrow(/state=block/)
  })

  it('F-18c: 閉じない test mod は例外を投げる', () => {
    const src = ['#[cfg(test)]', 'mod tests {', '  fn t() {}'].join('\n')
    expect(() => countCodeLines(src, 'rust')).toThrow(/mod の閉じ括弧/)
  })

  it('F-5: 閉じない文字列の例外メッセージに開始行番号が入る（設計 §8.1）', () => {
    const src = ['fn a() {}', 'fn b() {}', 'let s = "unterminated', 'fn c() {}'].join('\n')
    // 文字列は3行目（1-based）から始まる。15,000行のファイルで探す手掛かりが
    // 「全 N 行」だけでは足りない（レビュー指摘 F-5）。
    expect(() => countCodeLines(src, 'rust')).toThrow(/3 行目から開始した state=string/)
  })

  it('F-5: 閉じないブロックコメントの例外メッセージに開始行番号が入る', () => {
    const src = ['fn a() {}', '/* unterminated', 'still going'].join('\n')
    expect(() => countCodeLines(src, 'ts')).toThrow(/2 行目から開始した state=block/)
  })

  it('F-5: 閉じない test mod の例外メッセージに開始行番号が入る', () => {
    const src = ['fn prod() {}', '#[cfg(test)]', 'mod tests {', '  fn t() {}'].join('\n')
    // mod tests { は3行目（1-based）。
    expect(() => countCodeLines(src, 'rust')).toThrow(/3 行目から開始した #\[cfg\(test\)\] mod/)
  })

  it('F-5: 閉じないテンプレートリテラルの例外メッセージに開始行番号が入る', () => {
    const src = ['const a = 1', 'const s = `unterminated', 'still going'].join('\n')
    expect(() => countCodeLines(src, 'ts')).toThrow(/2 行目から開始した state=template/)
  })

  it('F-5: 閉じないテンプレート置換（${...}）の例外メッセージに開始行番号が入る', () => {
    const src = ['const a = 1', 'const s = `outer${notClosed', 'still going'].join('\n')
    // テンプレートリテラル自体は2行目に開始する。置換が閉じないまま終端に達する。
    expect(() => countCodeLines(src, 'ts')).toThrow(/2 行目から開始したテンプレートリテラル/)
  })

  it('F-20: 入れ子のテンプレートリテラル（`${...}` 置換の中の別テンプレート）は全行 code', () => {
    // レビュー指摘 F-2: 旧実装は置換の中の `` ` `` を「外側テンプレートの終端」と
    // 誤認識し、以降を 'normal' として扱ってしまう（`//` から始まる文字列内の行が
    // 行コメントとして黙って除外される = 少なく数える）。
    const src = ['const s = `outer', '${`inner', '// この行は文字列の中身', '`}', 'more`'].join(
      '\n',
    )
    expect(countCodeLines(src, 'ts').code).toBe(5)
  })

  it('F-20b: 入れ子をもう一段深くしても正しく閉じる', () => {
    const src = ['const s = `a', '${`b', '${`c', '// 最内層の中身', '`}', 'd`}', 'e`'].join('\n')
    expect(countCodeLines(src, 'ts').code).toBe(7)
  })

  it('F-20c: 入れ子テンプレートの閉じ backtick が足りない（奇数）と throw する', () => {
    const src = ['const s = `outer', '${`inner`', 'more'].join('\n')
    // 外側テンプレートを閉じる backtick が無いまま終端に達する。
    expect(() => countCodeLines(src, 'ts')).toThrow(/state=template/)
  })

  it('F-19: Windows 改行 (\\r\\n) は \\n と同じ結果', () => {
    const lf = 'let a = 1;\nlet b = 2;\n'
    const crlf = 'let a = 1;\r\nlet b = 2;\r\n'
    expect(countCodeLines(crlf, 'rust')).toEqual(countCodeLines(lf, 'rust'))
  })
})
