import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * DSL の「実装の許諾」の節を**仕組みで**守る（#998）。
 *
 * owner の裁定（2026-10-26・#998 冒頭の「改訂」）: 仕様書の**本文**はルートのライセンスのまま
 * （© Signal compose）。**DSL そのもの（文法と意味）**は、仕様書の冒頭と README の「実装の許諾」の節で
 * 「この文法と意味に沿った実装を、誰でも Apache-2.0 の条件（特許の許諾を含む）で作ってよい。
 * 文書の本文の許諾ではない」とする。文面は案で、確定は専門家か license@signalcompose.com の確認の後。
 *
 * 節は 4 か所（仕様書 3 本 + README）に同じ文面で現れる。1 か所だけ直すと許諾の範囲が食い違うので、
 * CLAUDE.md の「規律を足す時は、同時にそれを守らせる仕組みを足すこと」に従い、ここで一致を検査する。
 *
 * ## 新しい仕様書を足した時に漏れないように
 *
 * `docs/core/` と `docs/specs-v2/` の `.md` は**すべて**下の 2 つの表のどちらかに分類する。
 * 表に無いファイルが増えたら red になるので、「DSL の仕様書を足したのに節を忘れた」は分類の時点で
 * 止まる（`tests/interpreter/signal-chain-dispatch.spec.ts` の未分類 red と同じ形）。
 *
 * ## 🔴 このテストが捕まえないもの（過大評価しないこと）
 *
 * | 誤りの型 | 例 | 捕まるか |
 * |---|---|---|
 * | 節の欠落・4 か所の文面の食い違い・本文への Apache-2.0 の表記 | 節を 1 本消す / 1 か所だけ文面を直す | ✅ |
 * | 2 つのディレクトリの外に置いた仕様書 | `docs/design/` に DSL の文法を書いた | ❌ |
 * | **分類そのものの誤り・文面の法的な妥当性** | DSL の仕様書を `NOT_DSL_SPEC` に入れた | ❌（レビューと専門家の確認） |
 */
const repoRoot = path.resolve(__dirname, '../..')

/** 分類の対象。ここに置かれた `.md` は必ずどちらかの表に入る。 */
const SPEC_DIRS = ['docs/core', 'docs/specs-v2'] as const

/** DSL の文法と意味を定める仕様書（実装の許諾の節を持つ）。値は分類の理由。 */
const DSL_SPECS: Record<string, string> = {
  'docs/core/INSTRUCTION_ORBITSCORE_DSL.md': 'DSL の単一の正本（文法と意味）',
  'docs/specs-v2/PITCH_DSL_SPEC_v1.1.md': 'ピッチ DSL の仕様',
  'docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md': 'シグナルチェーン DSL の仕様',
}

/** DSL の仕様書ではない文書。値は理由。 */
const NOT_DSL_SPEC: Record<string, string> = {
  'docs/core/CONTEXT7_GUIDE.md': '外部ライブラリの文書の引き方（開発の手引き）',
  'docs/core/DESIGN_PRINCIPLES.md': '設計原則（開発の手引き）',
  'docs/core/INDEX.md': '文書の目次',
  'docs/core/PROJECT_RULES.md': '開発ワークフローの規則',
  'docs/specs-v2/DESIGN_DISCUSSION_RECORD.md': '設計の経緯と決定ログ（設計記録）',
  'docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.md': '実装の作業指示書',
  'docs/specs-v2/MULTICHANNEL_RENDERING_DESIGN_598.md': '実装の設計（#598）',
  'docs/specs-v2/PLUGIN_CAPABILITY_ABSTRACTION_v1.md': 'プラグインの能力の抽象（ホストの設計）',
  'docs/specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md': 'プラグイン UI のホスティング（ホストの仕様）',
  'docs/specs-v2/PLUGIN_UI_IMPLEMENTATION_DESIGN_474.md': '実装の設計（#474）',
  'docs/specs-v2/PROJECT_FILE_SPEC_v1.md':
    '`project.yaml` の形式の仕様で、DSL の文法と意味ではない',
  'docs/specs-v2/SESSION_LOG_SPEC_v1.md': '記録（.orbslog）の形式の仕様',
  'docs/specs-v2/WCTM_SYSTEM_SPEC_v1.md': 'コンサートシステムの仕様',
}

/** 節の 1 行目の先頭（文面の確定で「（案・未確定 / draft）」が外れても変わらない部分）。 */
const GRANT_ANCHOR = '> **実装の許諾 / Implementation grant**'

/**
 * 文書に**付いた** Apache-2.0 の SPDX 表記（行頭の HTML コメント）。WORK_LOG のように表記を話題に
 * するだけの散文は数えない。仕様書の方は、節の外の `Apache` を一切許さない（下のテスト）。
 */
const SPDX_APACHE_NOTICE = /^<!--\s*SPDX-License-Identifier:\s*Apache-2\.0\s*-->\s*$/m

const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

const listMarkdown = (dir: string): string[] =>
  fs
    .readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => `${dir}/${e.name}`)

const walkMarkdown = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.vitepress'].includes(e.name)) continue
      walkMarkdown(rel, out)
    } else if (e.name.endsWith('.md')) {
      out.push(rel)
    }
  }
  return out
}

/** `start` 行から続く引用（`>` で始まる行）を節として切り出す。 */
function blockFrom(lines: string[], start: number): string[] {
  const block: string[] = []
  for (let i = start; i < lines.length && lines[i].startsWith('>'); i++) block.push(lines[i])
  return block
}

/** 仕様書の最初の H1 の直下（空行を飛ばした最初の行）にある節。無ければ null。 */
function grantUnderTitle(rel: string): { block: string[]; start: number } | null {
  const lines = read(rel).split('\n')
  const h1 = lines.findIndex((l) => l.startsWith('# '))
  if (h1 === -1) return null
  let i = h1 + 1
  while (i < lines.length && lines[i].trim() === '') i++
  if (!lines[i]?.startsWith(GRANT_ANCHOR)) return null
  return { block: blockFrom(lines, i), start: i }
}

/** README の `## License` 節。 */
function readmeLicenseSection(): string[] {
  const body = read('README.md')
  const section = body.slice(body.indexOf('\n## License'))
  const end = section.indexOf('\n## ', 1)
  return (end === -1 ? section : section.slice(0, end)).split('\n')
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort()

describe('DSL implementation grant (#998)', () => {
  it('classifies every document under docs/core and docs/specs-v2', () => {
    const onDisk = sorted(SPEC_DIRS.flatMap(listMarkdown))
    const classified = sorted([...Object.keys(DSL_SPECS), ...Object.keys(NOT_DSL_SPEC)])
    expect(
      onDisk,
      '分類されていない文書（または消えた文書）があります。DSL の文法と意味の文書なら DSL_SPECS に、\n' +
        'そうでなければ NOT_DSL_SPEC に、理由と一緒に足してください（DSL_SPECS に足したら、\n' +
        'タイトルの直下に実装の許諾の節を置き、README の License 節の一覧にも足す）',
    ).toEqual(classified)
    for (const rel of Object.keys(DSL_SPECS)) {
      expect(NOT_DSL_SPEC[rel], `${rel} が両方の表にあります`).toBeUndefined()
    }
  })

  it.each(Object.keys(DSL_SPECS))(
    '%s has the implementation grant right under its title',
    (rel) => {
      expect(
        grantUnderTitle(rel),
        `${rel} の最初の見出し（# …）の直下に「${GRANT_ANCHOR}」で始まる節がありません`,
      ).not.toBeNull()
    },
  )

  it('uses the same grant text in every specification document and in the README', () => {
    const readme = readmeLicenseSection()
    const at = readme.findIndex((l) => l.startsWith(GRANT_ANCHOR))
    expect(at, 'README の License 節に実装の許諾の節がありません').toBeGreaterThan(-1)
    const canonical = blockFrom(readme, at)
    expect(canonical.join('\n')).toContain('Apache License, Version 2.0')
    for (const rel of Object.keys(DSL_SPECS)) {
      expect(grantUnderTitle(rel)?.block, `${rel} の節の文面が README と違います`).toEqual(
        canonical,
      )
    }
  })

  it.each(Object.keys(DSL_SPECS))(
    '%s does not put its own text under Apache-2.0 (Apache appears only in the grant)',
    (rel) => {
      const lines = read(rel).split('\n')
      const grant = grantUnderTitle(rel)
      const outside = lines.filter(
        (_l, i) => !grant || i < grant.start || i >= grant.start + grant.block.length,
      )
      expect(outside.join('\n')).not.toMatch(SPDX_APACHE_NOTICE)
      expect(
        outside.filter((l) => /apache/i.test(l)),
        `${rel} の本文（実装の許諾の節の外）に Apache の表記があります。本文はルートのライセンスのままです`,
      ).toEqual([])
    },
  )

  it('keeps every other document under the root license', () => {
    const docs = ['docs', 'sites'].flatMap((d) => walkMarkdown(d))
    expect(docs.filter((rel) => SPDX_APACHE_NOTICE.test(read(rel)))).toEqual([])
    const withGrant = docs.filter((rel) =>
      read(rel)
        .split('\n')
        .some((l) => l.startsWith(GRANT_ANCHOR)),
    )
    expect(
      sorted(withGrant),
      'DSL_SPECS に無い文書に実装の許諾の節があります（README の一覧と食い違う）',
    ).toEqual(sorted(Object.keys(DSL_SPECS)))
  })

  it('lists the same specification documents in the README License section', () => {
    const listed = readmeLicenseSection().flatMap((l) => {
      const m = /^- \[`([^`]+)`\]\(([^)]+)\)$/.exec(l)
      if (!m) return []
      expect(m[2], `README のリンク先が表示と違います: ${l}`).toBe(m[1])
      return [m[1]]
    })
    expect(sorted(listed)).toEqual(sorted(Object.keys(DSL_SPECS)))
  })

  it('does not carve the specification documents out of the root LICENSE', () => {
    const license = read('LICENSE')
    for (const rel of Object.keys(DSL_SPECS)) expect(license).not.toContain(rel)
  })

  it('names protocol/ in the root LICENSE once protocol/ exists', () => {
    // 設計 848 の裁定（§14 (9)）で `protocol/` は Apache-2.0 になる（計画 §7.1 の C-2 が
    // `protocol/LICENSE` を置く）。ディレクトリが現れた時点でルートの LICENSE が触れていなければ、
    // 「ルートの LICENSE が全体を覆う」と読める食い違いが生まれる。
    if (!fs.existsSync(path.join(repoRoot, 'protocol'))) return
    expect(
      fs.existsSync(path.join(repoRoot, 'protocol/LICENSE')),
      'protocol/LICENSE がありません',
    ).toBe(true)
    expect(read('LICENSE'), 'ルートの LICENSE に protocol/ の扱いを書いてください').toContain(
      'protocol/',
    )
  })
})
