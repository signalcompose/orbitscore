import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 分割で作った子モジュールの module doc が、実際の可視性変更と一致していることを検査する
 * （#888・設計 `docs/design/888-file-size-ratchet-design.md` §14）。
 *
 * 🔴 **なぜ要るか**: `/code:pr-review-team` の comment-analyzer が、21 モジュールのうち
 * **7 件で doc の主張と実態が食い違って**いるのを発見した。最悪だったのは
 * `startup.rs` / `startup_instrument.rs` で、**可視性変更の説明がまるごと入れ替わって**いた
 * （`startup.rs` が名指しした 2 関数はどちらも `startup_instrument.rs` にあった）。
 * 2 段目の分割をしたとき、縮んだ側の doc を直さなかったためである。
 *
 * 🔴 このテストを書いている最中にも 1 件ずれた。「可視性変更は 1 箇所」と書いたファイルが
 * 実際は 0 件だった。**人が数えて doc に書く限りずれる**ので、機械に突き合わせさせる。
 *
 * 検査するのは 2 つだけ:
 *
 * 1. 「**可視性も 1 箇所も変えていない**」と書いたファイルは、本当に `pub(super)` が 0 であること
 *    （逆に 0 ならそう書いてあること）
 * 2. 「**N 行を除いて純粋な移動である**」という**件数の主張を書かない**こと（§14 で禁じた形）
 */

const REPO_ROOT = path.resolve(__dirname, '../..')

/** doc で「可視性は 1 箇所も変えていない」と宣言する定型句（§14）。 */
const CLAIMS_NO_VISIBILITY_CHANGE = '可視性も 1 箇所も変えていない'

/** §14 が禁じた「N 行を除いて純粋な移動である」の形。件数は doc が追随せず必ずずれる。 */
const BANNED_COUNT_CLAIM = /行を除いて純粋な移動/

/** 分割で生まれた子モジュール群（親ファイルと同名のディレクトリ配下）。 */
function listSplitChildModules(): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--', ':(glob)rust/crates/**/*.rs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  return output
    .split('\0')
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      // `src/<parent>/<child>.rs` で、隣に `src/<parent>.rs` が実在するものだけを対象にする。
      const dir = path.dirname(entry)
      if (path.basename(path.dirname(dir)) === 'crates') return false
      return fs.existsSync(path.join(REPO_ROOT, `${dir}.rs`))
    })
    .sort()
}

/** module doc（先頭の `//!` ブロック）だけを取り出す。 */
function moduleDoc(source: string): string {
  const lines = source.split('\n')
  const doc: string[] = []
  for (const line of lines) {
    if (line.startsWith('//!')) doc.push(line)
    else if (doc.length > 0 && line.trim() === '') continue
    else if (doc.length > 0) break
  }
  return doc.join('\n')
}

/** コード行（コメントを除く）での `pub(super)` の出現数。doc 本文の字面に釣られないこと。 */
function countVisibilityRaises(source: string): number {
  return (
    source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
      .split('pub(super)').length - 1
  )
}

describe('分割した子モジュールの doc と実際の可視性（設計 §14）', () => {
  const modules = listSplitChildModules()

  it('対象が空でない（列挙そのものが壊れていない）', () => {
    // 真空防止。pathspec や `<parent>.rs` の判定が壊れると全件緑になってしまう。
    expect(modules.length).toBeGreaterThanOrEqual(20)
  })

  it('🔴 「可視性も 1 箇所も変えていない」と書いたファイルは本当に 0 件である', () => {
    const problems: string[] = []
    for (const rel of modules) {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
      const claimsNone = moduleDoc(source).includes(CLAIMS_NO_VISIBILITY_CHANGE)
      const raises = countVisibilityRaises(source)
      if (claimsNone && raises > 0) {
        problems.push(
          `${rel}: doc は「${CLAIMS_NO_VISIBILITY_CHANGE}」と書いているが pub(super) が ${raises} 箇所ある`,
        )
      }
      if (!claimsNone && raises === 0) {
        problems.push(
          `${rel}: pub(super) が 0 箇所なので、doc に「${CLAIMS_NO_VISIBILITY_CHANGE}」と書けるはず` +
            '（書いておくと、後で可視性を上げた時にこのテストが気づく）',
        )
      }
    }
    expect(problems).toEqual([])
  })

  it('🔴 「N 行を除いて純粋な移動である」という件数の主張を書かない（設計 §14）', () => {
    const problems: string[] = []
    for (const rel of modules) {
      const doc = moduleDoc(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
      if (BANNED_COUNT_CLAIM.test(doc)) {
        problems.push(`${rel}: 件数の主張は doc が追随せず必ずずれる。何を変えたかを書くこと`)
      }
    }
    expect(problems).toEqual([])
  })
})
