import crypto from 'node:crypto'
import childProcess from 'node:child_process'
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
 * `docs/core/` と `docs/specs-v2/` の `.md` / `.markdown` / `.mdx` は、下位ディレクトリも含めて
 * **すべて**下の 2 つの表のどちらかに分類する。表に無いファイルが増えたら red になるので、
 * 「DSL の仕様書を足したのに節を忘れた」は分類の時点で止まる
 * （`tests/interpreter/signal-chain-dispatch.spec.ts` の未分類 red と同じ形）。
 *
 * ## 🔴 このテストが捕まえないもの（過大評価しないこと）
 *
 * | 誤りの型 | 例 | 捕まるか |
 * |---|---|---|
 * | 節の欠落・4 か所の文面の食い違い・本文への Apache-2.0 の表記 | 節を 1 本消す / 1 か所だけ文面を直す | ✅ |
 * | 2 つのディレクトリの外に置いた仕様書 | `docs/design/` に DSL の文法を書いた | ❌ |
 * | **分類そのものの誤り・文面の法的な妥当性** | DSL の仕様書を `NOT_DSL_SPEC` に入れた | ❌（レビューと専門家の確認） |
 *
 * ## 機械が読む言語の定義（Apache-2.0）
 *
 * owner の「一旦推奨で」（2026-10-26）で、#1003 が推奨した 2 つ（TextMate 文法と
 * language-configuration）を Apache-2.0 にした。TextMate 文法の JSON はコメントを持てない。
 * `language-configuration.json` は VS Code が JSONC として読むが、2 つを同じ形に揃えるため、表記は
 * REUSE の慣習の「`<file>.license`」に置く。sidecar を npm / vsce / GitHub がライセンス指定として
 * 読むわけではなく、効力を持つのはルートの LICENSE の例外の節である。README の一覧もそれと揃える。
 * 新しい対応形式の言語定義を足したら、分類の表に足すまで red になる。
 */
const repoRoot = path.resolve(__dirname, '../..')

/** ignore 済みの生成物を除く、追跡済み・未追跡のリポジトリ内ファイル。 */
const repoFiles = childProcess
  .execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
  })
  .toString()
  .split('\0')
  .filter((rel) => rel !== '' && fs.existsSync(path.join(repoRoot, rel)))

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

/** 文書のどこに書かれていても Apache-2.0 の SPDX 表記として扱う。 */
const SPDX_APACHE_NOTICE = /SPDX-License-Identifier:\s*Apache-2\.0/i

/** SPDX 表記そのものを説明する散文。追加する場合はファイルごとの理由を必須にする。 */
const SPDX_APACHE_PROSE_EXCEPTIONS: Record<string, string> = {}

const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

/** Apache-2.0 だけで提供する、機械が読む言語の定義。値は中身。 */
const LANGUAGE_DEFINITIONS: Record<string, string> = {
  'packages/vscode-extension/syntaxes/orbitscore-audio.tmLanguage.json':
    'TextMate 文法（構文ハイライト）',
  'packages/vscode-extension/language-configuration.json': 'コメント記号・括弧の対応',
}

/** 各定義の隣の `<file>.license` の中身（REUSE の慣習）。 */
const SIDECAR = [
  'SPDX-FileCopyrightText: 2026 Signal compose Inc.',
  'SPDX-License-Identifier: Apache-2.0',
  '',
].join('\n')

/** apache.org の `LICENSE-2.0.txt`（2026-10-26 に取得）の sha256。全文を 1 文字でも変えたら red。 */
const APACHE_TEXT_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'

/** 言語の定義に当たるファイル名。ここに当たるのに表に無いものは red。 */
const LANGUAGE_DEFINITION_NAME =
  /(?:\.tmLanguage(?:\.(?:json|ya?ml))?|\.sublime-syntax|^language-configuration.*\.json)$/i

const MARKDOWN_NAME = /\.(?:md|markdown|mdx)$/i

/** ルートの LICENSE の「EXCEPTION: MACHINE-READABLE LANGUAGE DEFINITIONS」の節。 */
function licenseDefinitionSection(): string[] {
  const lines = read('LICENSE').split('\n')
  const start = lines.findIndex((l) =>
    l.startsWith('EXCEPTION: MACHINE-READABLE LANGUAGE DEFINITIONS'),
  )
  if (start === -1) {
    throw new Error('LICENSE に言語定義の例外の見出しがありません')
  }
  const body: string[] = []
  for (const l of lines.slice(start + 2)) {
    if (l.startsWith('====')) break
    body.push(l)
  }
  return body
}

/** 上の例外の節に列挙された言語定義。 */
const licenseDefinitionList = (): string[] =>
  licenseDefinitionSection()
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())

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
  const lines = read('README.md').split('\n')
  const start = lines.findIndex((l) => l === '## License')
  if (start === -1) throw new Error('README に `## License` の見出しがありません')
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start, next === -1 ? undefined : next)
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort()

describe('DSL implementation grant (#998)', () => {
  it('classifies every document under docs/core and docs/specs-v2', () => {
    const onDisk = sorted(
      repoFiles.filter(
        (rel) => SPEC_DIRS.some((dir) => rel.startsWith(`${dir}/`)) && MARKDOWN_NAME.test(rel),
      ),
    )
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
    const text = canonical.join('\n')
    expect(text).toContain('grants everyone permission')
    expect(text).toContain(
      'under the terms of the Apache License, Version 2.0, including the patent license in its Section 3',
    )
    expect(text).toContain('It is not a license to the text of the specification documents')
    expect(text).toContain('誰にでも許諾します')
    expect(text).toContain('Apache License 2.0 の条件（第 3 条の特許の許諾を含む）')
    expect(text).toContain('仕様書の本文の許諾ではありません')
    expect(text).not.toMatch(/not the Apache License/i)
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
      expect(
        outside.filter((l) => /apache/i.test(l)),
        `${rel} の本文（実装の許諾の節の外）に Apache の表記があります。本文はルートのライセンスのままです`,
      ).toEqual([])
    },
  )

  it('keeps every other document under the root license', () => {
    const docs = repoFiles.filter((rel) => /^(?:docs|sites)\//.test(rel) && MARKDOWN_NAME.test(rel))
    const withSpdx = docs.filter((rel) => SPDX_APACHE_NOTICE.test(read(rel)))
    expect(sorted(withSpdx)).toEqual(sorted(Object.keys(SPDX_APACHE_PROSE_EXCEPTIONS)))
    for (const [rel, reason] of Object.entries(SPDX_APACHE_PROSE_EXCEPTIONS)) {
      expect(reason.trim(), `${rel} の SPDX 表記を許す理由がありません`).not.toBe('')
    }
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
    expect(license).not.toMatch(/\b(?:docs|sites)\//i)
    const exception = licenseDefinitionSection().join('\n')
    expect(exception).toContain('licensed under the Apache License, Version 2.0 only')
    expect(exception).toContain('without the Commons Clause')
  })

  describe('machine-readable language definitions (Apache-2.0)', () => {
    it('classifies every grammar and language-configuration file in the repository', () => {
      const found = repoFiles.filter((rel) => LANGUAGE_DEFINITION_NAME.test(path.basename(rel)))
      expect(
        sorted(found),
        '言語の定義に当たるファイルが表と違います。Apache-2.0 にするなら LANGUAGE_DEFINITIONS に足し、\n' +
          '`<file>.license`・LICENSE の例外の節・README の一覧も同じ PR で直す',
      ).toEqual(sorted(Object.keys(LANGUAGE_DEFINITIONS)))
    })

    it.each(Object.keys(LANGUAGE_DEFINITIONS))('%s has its Apache-2.0 .license file', (rel) => {
      expect(
        fs.existsSync(path.join(repoRoot, `${rel}.license`)),
        `${rel}.license がありません`,
      ).toBe(true)
      expect(read(`${rel}.license`)).toBe(SIDECAR)
    })

    it('has no other .license file', () => {
      const sidecars = repoFiles.filter((rel) => rel.endsWith('.license'))
      expect(sorted(sidecars)).toEqual(
        sorted(Object.keys(LANGUAGE_DEFINITIONS).map((r) => `${r}.license`)),
      )
    })

    it('has no repository-wide REUSE mapping', () => {
      // REUSE.toml / dep5 が必要になった時は、単に許可せず、覆う範囲を検査するテストに置き換える。
      expect(repoFiles.filter((rel) => rel === 'REUSE.toml' || rel === '.reuse/dep5')).toEqual([])
    })

    it('lists the same files in the root LICENSE exception', () => {
      expect(sorted(licenseDefinitionList())).toEqual(sorted(Object.keys(LANGUAGE_DEFINITIONS)))
    })

    it('lists the same files in the README License section', () => {
      const listed = readmeLicenseSection().flatMap((l) => {
        const m = /^- \[`([^`]+)`\]\(([^)]+)\) \(.+\)$/.exec(l)
        if (!m) return []
        expect(m[2], `README のリンク先が表示と違います: ${l}`).toBe(m[1])
        return [m[1]]
      })
      expect(sorted(listed)).toEqual(sorted(Object.keys(LANGUAGE_DEFINITIONS)))
    })

    it('ships the unmodified Apache License 2.0 text', () => {
      const text = fs.readFileSync(path.join(repoRoot, 'LICENSES/Apache-2.0.txt'))
      expect(crypto.createHash('sha256').update(text).digest('hex')).toBe(APACHE_TEXT_SHA256)
    })

    it('tells contributors that these files are Apache-2.0', () => {
      expect(read('CONTRIBUTING.md')).toContain('Apache License 2.0 only')
    })
  })

  it.skipIf(!fs.existsSync(path.join(repoRoot, 'protocol')))(
    'names protocol/ in the root LICENSE once protocol/ exists',
    () => {
      // 設計 848 の裁定（§14 (9)）で `protocol/` は Apache-2.0 になる（計画 §7.1 の C-2 が
      // `protocol/LICENSE` を置く）。ディレクトリが現れた時点でルートの LICENSE が触れていなければ、
      // 「ルートの LICENSE が全体を覆う」と読める食い違いが生まれる。
      expect(
        fs.existsSync(path.join(repoRoot, 'protocol/LICENSE')),
        'protocol/LICENSE がありません',
      ).toBe(true)
      expect(read('protocol/LICENSE')).toContain('Apache License')
      expect(read('protocol/LICENSE')).toContain('Version 2.0')
      expect(read('LICENSE'), 'ルートの LICENSE に protocol/ の扱いを書いてください').toContain(
        'protocol/',
      )
    },
  )
})
