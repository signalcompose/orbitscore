import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * DSL の仕様書の Apache-2.0 表記を**仕組みで**守る（#998）。
 *
 * owner 裁定（2026-10-26）: **DSL の仕様書（文法と意味の文書）だけ**を Apache-2.0 にする。
 * 実装（`packages/engine` 等）はルートの Signal compose Source-Available License のまま。
 *
 * 表記は 3 か所に現れる — 文書の冒頭の SPDX・ルートの `LICENSE` の例外の節・README の
 * License 節。どれか 1 つだけ直すと**ライセンスの記述が食い違う**（ルートの LICENSE は
 * 「この文書は Apache-2.0 だけ」と言い、文書には表記が無い、など）。CLAUDE.md の
 * 「規律を足す時は、同時にそれを守らせる仕組みを足すこと」に従い、3 か所の一致をここで検査する。
 *
 * ## 新しい仕様書を足した時に漏れないように
 *
 * `docs/core/` と `docs/specs-v2/` の `.md` は**すべて**下の 2 つの表のどちらかに分類する。
 * 表に無いファイルが増えたら red になるので、「DSL の仕様書を足したのに表記を忘れた」は
 * 分類の時点で止まる（`tests/interpreter/signal-chain-dispatch.spec.ts` の未分類 red と同じ形）。
 *
 * ## 🔴 このテストが捕まえないもの（過大評価しないこと）
 *
 * | 誤りの型 | 例 | 捕まるか |
 * |---|---|---|
 * | 表記の欠落・3 か所の食い違い | SPDX を 1 本消す / LICENSE の一覧から 1 行消す | ✅ |
 * | 2 つのディレクトリの外に置いた仕様書 | `docs/design/` に DSL の文法を書いた | ❌ |
 * | **分類そのものの誤り** | DSL の仕様書を `ROOT_LICENSE_ONLY` に入れた | ❌（理由の欄をレビューで読む） |
 */
const repoRoot = path.resolve(__dirname, '../..')

/** 分類の対象。ここに置かれた `.md` は必ずどちらかの表に入る。 */
const SPEC_DIRS = ['docs/core', 'docs/specs-v2'] as const

/** Apache-2.0 だけで提供する文書（DSL の文法と意味）。値は分類の理由。 */
const APACHE_2_0: Record<string, string> = {
  'docs/core/INSTRUCTION_ORBITSCORE_DSL.md': 'DSL の単一の正本（文法と意味）',
  'docs/specs-v2/PITCH_DSL_SPEC_v1.1.md': 'ピッチ DSL の仕様',
  'docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md': 'シグナルチェーン DSL の仕様',
}

/** ルートのライセンスのままの文書。値は「DSL の仕様書ではない」理由。 */
const ROOT_LICENSE_ONLY: Record<string, string> = {
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

const SPDX_HEADER = [
  '<!-- SPDX-FileCopyrightText: 2026 Signal compose Inc. -->',
  '<!-- SPDX-License-Identifier: Apache-2.0 -->',
] as const

const SPDX_APACHE = 'SPDX-License-Identifier: Apache-2.0'

/**
 * 文書に**付いた**表記（行頭の HTML コメント）。散文やコードの中で表記を話題にするだけの行
 * （WORK_LOG・README の「`SPDX-License-Identifier: Apache-2.0` を冒頭に置く」など）は数えない。
 */
const SPDX_APACHE_NOTICE = /^<!--\s*SPDX-License-Identifier:\s*Apache-2\.0\s*-->\s*$/m

/** apache.org の `LICENSE-2.0.txt`（2026-10-26 に取得）の sha256。全文を 1 文字でも変えたら red。 */
const APACHE_TEXT_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'

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

/** ルートの LICENSE の例外の節（見出しの次の `====` から、次の `====` の見出しまで）の一覧。 */
function licenseExceptionList(): string[] {
  const lines = read('LICENSE').split('\n')
  const start = lines.findIndex((l) => l.startsWith('EXCEPTION: DSL SPECIFICATION DOCUMENTS'))
  expect(
    start,
    'LICENSE に「EXCEPTION: DSL SPECIFICATION DOCUMENTS」の節がありません',
  ).toBeGreaterThan(0)
  const body: string[] = []
  for (const l of lines.slice(start + 2)) {
    if (l.startsWith('====')) break
    body.push(l)
  }
  return body.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
}

/** README の `## License` 節にある `` - [`path`](path) `` の一覧。 */
function readmeApacheList(): string[] {
  const body = read('README.md')
  const section = body.slice(body.indexOf('\n## License'))
  const end = section.indexOf('\n## ', 1)
  const license = end === -1 ? section : section.slice(0, end)
  return [...license.matchAll(/^- \[`([^`]+)`\]\(([^)]+)\)$/gm)].map((m) => {
    expect(m[2], `README のリンク先が表示と違います: ${m[0]}`).toBe(m[1])
    return m[1]
  })
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort()

describe('DSL specification documents are Apache-2.0 (#998)', () => {
  it('classifies every document under docs/core and docs/specs-v2', () => {
    const onDisk = sorted(SPEC_DIRS.flatMap(listMarkdown))
    const classified = sorted([...Object.keys(APACHE_2_0), ...Object.keys(ROOT_LICENSE_ONLY)])
    expect(
      onDisk,
      '分類されていない文書（または消えた文書）があります。DSL の文法と意味の文書なら APACHE_2_0 に、\n' +
        'そうでなければ ROOT_LICENSE_ONLY に、理由と一緒に足してください（APACHE_2_0 に足したら\n' +
        '文書の冒頭の SPDX・LICENSE の例外の節・README の License 節も同じ PR で直す）',
    ).toEqual(classified)
    for (const rel of Object.keys(APACHE_2_0)) {
      expect(ROOT_LICENSE_ONLY[rel], `${rel} が両方の表にあります`).toBeUndefined()
    }
  })

  it.each(Object.keys(APACHE_2_0))('%s starts with the Apache-2.0 SPDX notice', (rel) => {
    const head = read(rel).split('\n').slice(0, SPDX_HEADER.length)
    expect(head, `${rel} の冒頭に SPDX の 2 行がありません`).toEqual([...SPDX_HEADER])
  })

  it('does not put the Apache-2.0 SPDX notice on any other document', () => {
    const marked = ['docs', 'sites']
      .flatMap((d) => walkMarkdown(d))
      .filter((rel) => SPDX_APACHE_NOTICE.test(read(rel)))
    expect(
      sorted(marked),
      'APACHE_2_0 に無い文書に Apache-2.0 の SPDX があります（LICENSE の例外の節と食い違う）',
    ).toEqual(sorted(Object.keys(APACHE_2_0)))
  })

  it('lists the same documents in the root LICENSE exception', () => {
    expect(sorted(licenseExceptionList())).toEqual(sorted(Object.keys(APACHE_2_0)))
  })

  it('lists the same documents in the README License section', () => {
    expect(sorted(readmeApacheList())).toEqual(sorted(Object.keys(APACHE_2_0)))
  })

  it('tells contributors that the specification documents are Apache-2.0', () => {
    const contributing = read('CONTRIBUTING.md')
    expect(contributing).toContain(SPDX_APACHE)
    expect(contributing).toContain('Apache License 2.0 only')
  })

  it('ships the unmodified Apache License 2.0 text', () => {
    const text = fs.readFileSync(path.join(repoRoot, 'LICENSES/Apache-2.0.txt'))
    expect(crypto.createHash('sha256').update(text).digest('hex')).toBe(APACHE_TEXT_SHA256)
  })

  it('names protocol/ in the root LICENSE once protocol/ exists', () => {
    // 設計 848 の裁定（項目 7）で `protocol/` も Apache-2.0 になる（計画 §7.1 の C-2 が
    // `protocol/LICENSE` を置く）。ディレクトリが現れた時点でルートの LICENSE が触れていなければ、
    // 「ルートの LICENSE は全体を覆うと読める」食い違いが生まれる。
    if (!fs.existsSync(path.join(repoRoot, 'protocol'))) return
    expect(
      fs.existsSync(path.join(repoRoot, 'protocol/LICENSE')),
      'protocol/LICENSE がありません',
    ).toBe(true)
    expect(read('LICENSE'), 'ルートの LICENSE の例外の節に protocol/ を足してください').toContain(
      'protocol/',
    )
  })
})
