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
 * 🔴 3 つ目は #887（TS 分割）で実際に起きた欠陥である。`diagnostics-provider.ts` と
 * `dsl-providers.ts` に、**`extension.ts` を説明する docblock がそのまま複製されて**いた
 * （死んだ `// import * as os from 'os'` 行まで一緒に付いてきていた）。
 * ファイル固有の正しい doc が既に書かれていたので、**人は 2 つ目の doc を読み飛ばす**。
 * 上の 2 つは「doc の主張が実態と合っているか」を見るが、**doc がそもそも別のファイルの
 * 話をしている**場合は捕まらなかった。
 *
 * 検査するのは 3 つ:
 *
 * 1. 「**可視性も 1 箇所も変えていない**」と書いたファイルは、本当に `pub(super)` が 0 であること。
 *    🔴 逆向き（0 件なら必ずそう書け）は**採らない**。`pub(crate)` は分割前から付いていることが
 *    あり、修飾子の絶対数からは「分割で変えたか」が決まらないためである（試して外した）。
 * 2. 「**N 行を除いて純粋な移動である**」という**件数の主張を書かない**こと（§14 で禁じた形）
 * 3. **同一の module doc が 2 ファイルに存在しないこと**（コピペの検出）。Rust / TS 両方を対象にする
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

/**
 * コード行（コメントを除く）での `pub(super)` の出現数。
 *
 * 🔴 **数えるのは `pub(super)` だけ。** `pub(crate)` は分割前から付いていることがあり
 * （例: `playback.rs` の `set_callback_alive`）、**絶対的な修飾子の数は「分割で変えたか」を
 * 表さない**。`pub(super)` は「親の子モジュールになったから要る」修飾子なので、
 * 分割の産物である度合いがはるかに高い。
 *
 * 🔴 コメント行を除くのは、**この検査が検査対象の doc の字面に釣られない**ようにするため
 * （最初の版は doc 中の `pub(super)` という文字列まで数えていた）。
 */
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

  it('🔴 「可視性も 1 箇所も変えていない」と書いた doc が嘘でないこと', () => {
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

/**
 * 測定対象のソース全件（Rust / TS）。#887 の欠陥は TS 側で起きたので、
 * 3 つ目の検査は {@link listSplitChildModules} より広い範囲を見る。
 */
function listAllMeasuredSources(): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--', ':(glob)rust/crates/**/*.rs', ':(glob)packages/*/src/**/*.ts'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  return output
    .split('\0')
    .filter((entry) => entry.length > 0)
    .sort()
}

/**
 * ファイル内の**すべての** doc ブロックを、比較用に正規化して返す。
 *
 * 🔴 **先頭のブロックだけを見てはいけない。** #887 の欠陥はまさにそれで捕まらなかった:
 * `diagnostics-provider.ts` の先頭には正しいファイル固有の doc があり、複製された
 * `extension.ts` の doc は**2 つ目**に居た。先頭だけを見る版を書いて変異を当てたところ
 * **緑のまま通り**、この検査が何も見ていないことが分かった（2026-09-12・実測）。
 *
 * 装飾（`*` / `//!` / `///`）と空白を落として内容行だけを残す。
 * **内容行が 3 行未満のブロックは対象外** — 短い定型句が偶然一致するのは欠陥ではない。
 */
function docBlocks(source: string, lang: 'rust' | 'ts'): string[] {
  const blocks: string[] = []
  const push = (lines: string[]) => {
    const meaningful = lines.filter((line) => line !== '')
    if (meaningful.length >= 3) blocks.push(meaningful.join('\n'))
  }

  if (lang === 'rust') {
    let current: string[] = []
    for (const line of source.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//!') || trimmed.startsWith('///')) {
        current.push(trimmed.replace(/^\/\/[!/]\s?/, '').trim())
      } else if (current.length > 0) {
        push(current)
        current = []
      }
    }
    if (current.length > 0) push(current)
  } else {
    const blockPattern = /\/\*\*([\s\S]*?)\*\//g
    let match: RegExpExecArray | null
    while ((match = blockPattern.exec(source)) !== null) {
      push(
        (match[1] as string).split('\n').map((line) =>
          line
            .trim()
            .replace(/^\*\s?/, '')
            .trim(),
        ),
      )
    }
  }

  return blocks
}

/**
 * 同一 doc を持つことが**正当**なファイル組。
 *
 * どちらも effect / instrument の並行実装で、同じ構造の同じフィールドに同じ説明が付いている。
 * 🔴 **これはラチェットである。増やす編集はレビューで止める。** 解消したら**この表から消す**
 * （残したままにすると、次のコピペを 1 件見逃す余地になる）。
 */
const KNOWN_SHARED_DOCS: ReadonlyArray<readonly [string, string]> = [
  [
    'rust/crates/orbit-audio-daemon/src/outproc_effect.rs',
    'rust/crates/orbit-audio-daemon/src/outproc_instrument.rs',
  ],
  ['rust/crates/orbit-clap-host/src/effect.rs', 'rust/crates/orbit-clap-host/src/instrument.rs'],
]

describe('doc ブロックがコピペされていないこと（#887 で実際に起きた欠陥）', () => {
  const sources = listAllMeasuredSources()

  it('対象が空でない（列挙そのものが壊れていない）', () => {
    // 真空防止。pathspec の `:(glob)` が外れると件数が落ちる（#888 §13.10 で実測）。
    expect(sources.length).toBeGreaterThanOrEqual(200)
  })

  it('🔴 同一の doc ブロックを持つファイル組が baseline と一致する', () => {
    const byDoc = new Map<string, Set<string>>()
    for (const rel of sources) {
      const lang = rel.endsWith('.rs') ? 'rust' : 'ts'
      for (const doc of new Set(
        docBlocks(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'), lang),
      )) {
        const bucket = byDoc.get(doc)
        if (bucket === undefined) byDoc.set(doc, new Set([rel]))
        else bucket.add(rel)
      }
    }

    const actual = [
      ...new Set(
        [...byDoc.values()]
          .filter((files) => files.size > 1)
          .map((files) => [...files].sort().join(' + ')),
      ),
    ].sort()

    const expected = KNOWN_SHARED_DOCS.map((pair) => [...pair].sort().join(' + ')).sort()

    // 🔴 厳密等価にする。`actual ⊆ expected` にすると、解消した組を表から消さずに済んでしまう。
    expect(actual).toEqual(expected)
  })
})
