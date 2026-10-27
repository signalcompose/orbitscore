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
 * `docs/core/` と `docs/specs-v2/` の文書は、下位ディレクトリも含めて
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

/** index にあるリポジトリ内ファイル。手元の git 管理外ファイルで検査を赤くしない。
 * pre-commit は git add の後に走るため、新しい仕様書も index に入って検査される。 */
const repoFiles = childProcess
  .execFileSync('git', ['ls-files', '--cached', '--exclude-standard', '-z'], {
    cwd: repoRoot,
  })
  .toString()
  .split('\0')
  .filter((rel) => rel !== '' && fs.existsSync(path.join(repoRoot, rel)))

/** 分類の対象。ここに置かれた対象拡張子の文書は必ずどちらかの表に入る。 */
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
 * 節の 1 行目の全体。golden は 2 行目以降なので、1 行目は形で固定する（R3: 先頭だけの一致では
 * 「（案・未確定 / draft） ただし商用の実装には及ばない」のような後ろへの追記が 4 か所揃えて通った）。
 * 文面の確定で「（案・未確定 / draft）」を外した形も通す。
 */
const GRANT_FIRST_LINE =
  /^> \*\*実装の許諾 \/ Implementation grant\*\*(?:（案・未確定 \/ draft）)?$/

/** README の正本の許諾節（確定時に外れる先頭ラベルを除く）の sha256。 */
const GRANT_TEXT_SHA256 = 'f994d9eff0d2f450075d010235591089d8d79cb1e42f3af344169ebe57d9c00f'

/**
 * 文書の SPDX 表記。Apache-2.0 に限らず、どのライセンスでも docs / sites の文書には付けない
 * （R3: `CC0-1.0` や `MIT` の表記で本文を別のライセンスにできた。今は 1 件も無い）。
 */
const SPDX_NOTICE = /SPDX-License-Identifier\s*:/i

/** SPDX 表記そのものを説明する散文。追加する場合はファイルごとの理由を必須にする。 */
const SPDX_PROSE_EXCEPTIONS: Record<string, string> = {}

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

/** ルート LICENSE の例外節（見出し直後の区切りから、次の区切りまで）の sha256。 */
const LICENSE_EXCEPTION_SHA256 = '742793112409058804348b1e84366c11cb83d18acae07c6b74999853c1db481d'

/**
 * ルートの LICENSE 全体の sha256。Apache 以外の切り出し（「仕様書は CC0」の節の追加・
 * 「仕様書は自由に複製してよい」の 1 文）は、語やパスを見る検査では捕まらない（R3）。
 * LICENSE は owner の文面なので、どの変更も golden の更新を伴う意図的な変更にする。
 * 🔴 `protocol/` が現れた時はルートの LICENSE がそれに触れる必要がある（下のテスト）— その 1 行を
 * 足す PR がこの golden も更新する。
 */
const LICENSE_SHA256 = '209bc8c233b0841282a4df2c0feaff6e35611720c9da76c752bf4f7cddc6b916'

/** 言語の定義に当たるファイル名。ここに当たるのに表に無いものは red。 */
const LANGUAGE_DEFINITION_NAME =
  /(?:\.tmLanguage(?:\.(?:json|ya?ml))?|\.sublime-syntax|^language-configuration.*\.json)$/i

const MARKDOWN_NAME = /\.(?:md|markdown|mdx)$/i
const SPEC_DOCUMENT_NAME = /\.(?:md|markdown|mdx|html?|txt|rst|adoc)$/i

const ROOT_LICENSE_APACHE_LINES = [
  'This software is licensed under the Apache License, Version 2.0 (the "Base',
  'You may obtain a copy of the Apache License at:',
  'https://www.apache.org/licenses/LICENSE-2.0',
  'All rights granted under the Apache License 2.0 (use, copy, modify, distribute)',
  'granted by the Apache License 2.0. In the event of a conflict, these',
  'additional conditions take precedence over the Apache License 2.0. Because',
  'IMPLIED. See the Apache License 2.0 for the full disclaimer and limitation of',
]

const README_IMPLEMENTATION_LEAD =
  'The DSL specification documents stay under this license. Separately, the language they define may be implemented by anyone:'
const README_LICENSE_SUMMARY_APACHE_LINE = '- **Base**: Apache License 2.0'
const README_APACHE_LINES = [
  'The machine-readable definitions of the language — the files editors and other tools use to handle OrbitScore DSL — are licensed under the [Apache License 2.0](LICENSES/Apache-2.0.txt) only (see the exception at the top of [LICENSE](LICENSE)):',
  'The session protocol definitions for OrbitStudio (the native macOS app), which will be added under `protocol/`, will be licensed under the Apache License 2.0 and carry their own `LICENSE`.',
]

const CONTRIBUTING_APACHE_LINES = [
  "The exception is the machine-readable language definitions listed in the README's [License](README.md#license) section (each has a companion `.license` file with `SPDX-License-Identifier: Apache-2.0`): contributions to those files are licensed under the Apache License 2.0 only.",
  'Note: This license is Apache 2.0-based with Commons Clause and Fair Revenue Clause. It is not an OSI-approved open source license; it is source-available.',
]

const sha256 = (text: string | Buffer): string =>
  crypto.createHash('sha256').update(text).digest('hex')

/**
 * ライセンスを制御しうるファイル。名前は前方一致で見る（R3: `LICENSE-APACHE` / `COPYRIGHT` /
 * `PATENTS` / 単数の `license/` が通っていた）。前方一致なので、ライセンスではないのに名前が
 * 当たるファイルは NOT_LICENSE_CONTROL に理由と一緒に載せる。
 */
function isLicenseControlFile(rel: string): boolean {
  const basename = path.basename(rel)
  return (
    /^(?:LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|PATENTS|UNLICENSE)(?:[._-].*)?$/i.test(basename) ||
    /(?:^|\/)licen[cs]es?\//i.test(rel) ||
    /^REUSE\.toml$/i.test(basename) ||
    /(?:^|\/)\.reuse\//i.test(rel) ||
    /\.license$/i.test(rel)
  )
}

/** 名前はライセンスのファイルに当たるが、ライセンスを定めていないもの。値は理由。 */
const NOT_LICENSE_CONTROL: Record<string, string> = {
  '.claude/license.local.md': 'Claude Code への指示ファイル（ライセンスの文面ではない）',
  'rust/crates/orbit-child-runtime/src/notice.rs': 'Rust のソース（子プロセスの通知の実装）',
}

/** frontmatter にライセンスの鍵（license / licenses / spdx）があるか。値の形は問わない。 */
function hasLicenseFrontmatter(text: string): boolean {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return false
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  return end > 0 && lines.slice(1, end).some((line) => /^(?:license|licenses|spdx)\s*:/i.test(line))
}

/** ルートの LICENSE の「EXCEPTION: MACHINE-READABLE LANGUAGE DEFINITIONS」の節。 */
function licenseDefinitionBounds(): { end: number; lines: string[]; start: number } {
  const lines = read('LICENSE').split('\n')
  const headings = lines
    .map((line, i) => ({ i, line }))
    .filter(({ line }) => line.startsWith('EXCEPTION:'))
  if (headings.length !== 1) {
    throw new Error(
      `LICENSE の EXCEPTION: 見出しは 1 つでなければなりません（${headings.length} 個）`,
    )
  }
  const start = lines.findIndex(
    (l) => l === 'EXCEPTION: MACHINE-READABLE LANGUAGE DEFINITIONS (APACHE LICENSE 2.0 ONLY)',
  )
  if (start === -1) {
    throw new Error('LICENSE に言語定義の例外の見出しがありません')
  }
  if (!lines[start + 1]?.startsWith('====')) {
    throw new Error('LICENSE の言語定義の例外の見出し直後に区切りがありません')
  }
  const end = lines.findIndex((line, i) => i > start + 1 && line.startsWith('===='))
  if (end === -1) throw new Error('LICENSE の言語定義の例外の終端がありません')
  return { lines, start, end }
}

function licenseDefinitionSection(): string[] {
  const { end, lines, start } = licenseDefinitionBounds()
  return lines.slice(start + 2, end)
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
        (rel) => SPEC_DIRS.some((dir) => rel.startsWith(`${dir}/`)) && SPEC_DOCUMENT_NAME.test(rel),
      ),
    )
    const classified = sorted([...Object.keys(DSL_SPECS), ...Object.keys(NOT_DSL_SPEC)])
    for (const rel of Object.keys(DSL_SPECS)) {
      expect(NOT_DSL_SPEC[rel], `${rel} が両方の表にあります`).toBeUndefined()
    }
    expect(
      onDisk,
      '分類されていない文書（または消えた文書）があります。DSL の文法と意味の文書なら DSL_SPECS に、\n' +
        'そうでなければ NOT_DSL_SPEC に、理由と一緒に足してください（DSL_SPECS に足したら、\n' +
        'タイトルの直下に実装の許諾の節を置き、README の License 節の一覧にも足す）',
    ).toEqual(classified)
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
    expect(canonical[0], '実装の許諾の節の 1 行目に文を足さないでください').toMatch(
      GRANT_FIRST_LINE,
    )
    expect(
      sha256(canonical.slice(1).join('\n')),
      '実装の許諾の文面を確定・変更したら golden を更新してください（法務の確認の後）',
    ).toBe(GRANT_TEXT_SHA256)
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
    const withSpdx = docs.filter((rel) => {
      const text = read(rel)
      return SPDX_NOTICE.test(text) || hasLicenseFrontmatter(text)
    })
    expect(
      sorted(withSpdx),
      'docs / sites の文書にライセンスの表記（SPDX・frontmatter の license）があります。本文はルートのライセンスのままです',
    ).toEqual(sorted(Object.keys(SPDX_PROSE_EXCEPTIONS)))
    for (const [rel, reason] of Object.entries(SPDX_PROSE_EXCEPTIONS)) {
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
    expect(
      sha256(license),
      'ルートの LICENSE が変わりました。owner の文面の変更なら golden を意図的に更新してください',
    ).toBe(LICENSE_SHA256)
    const { end, lines, start } = licenseDefinitionBounds()
    const exceptionBlock = lines.slice(start + 1, end + 1).join('\n')
    expect(
      sha256(exceptionBlock),
      'LICENSE の言語定義の例外節を変更したら golden を意図的に更新してください',
    ).toBe(LICENSE_EXCEPTION_SHA256)
    const outsideApache = lines.filter((line, i) => /apache/i.test(line) && (i < start || i > end))
    expect(outsideApache, 'LICENSE の例外節の外に Apache の言及を追加しないでください').toEqual(
      ROOT_LICENSE_APACHE_LINES,
    )
    // URL の途中（`https://…/docs/…`）は除き、リポジトリのパスとしての docs/ と sites/ を見る。
    expect(license).not.toMatch(/(?<![\w.:/-])(?:docs|sites)\//i)
    for (const rel of Object.keys(DSL_SPECS)) {
      expect(license).not.toContain(path.basename(rel))
    }
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

    it('classifies every language-definition path declared by extension packages', () => {
      const declared = repoFiles
        .filter((rel) => /^packages\/[^/]+\/package\.json$/.test(rel))
        .flatMap((rel) => {
          const manifest = JSON.parse(read(rel)) as {
            contributes?: {
              grammars?: { path?: string }[]
              languages?: { configuration?: string }[]
            }
          }
          const paths = [
            ...(manifest.contributes?.grammars ?? []).map((entry) => entry.path),
            ...(manifest.contributes?.languages ?? []).map((entry) => entry.configuration),
          ].filter((value): value is string => typeof value === 'string')
          return paths.map((value) =>
            path.posix.normalize(path.posix.join(path.posix.dirname(rel), value)),
          )
        })
      for (const rel of declared) {
        expect(
          LANGUAGE_DEFINITIONS[rel],
          `${rel} は package.json が指す言語定義ですが LANGUAGE_DEFINITIONS にありません`,
        ).toBeDefined()
      }
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

    it('has exactly the approved license-control files', () => {
      const allowed = [
        'LICENSE',
        'LICENSES/Apache-2.0.txt',
        ...Object.keys(LANGUAGE_DEFINITIONS).map((rel) => `${rel}.license`),
      ]
      if (repoFiles.includes('protocol/LICENSE')) allowed.push('protocol/LICENSE')
      expect(
        sorted(
          repoFiles.filter((rel) => isLicenseControlFile(rel) && !(rel in NOT_LICENSE_CONTROL)),
        ),
      ).toEqual(sorted(allowed))
      for (const [rel, reason] of Object.entries(NOT_LICENSE_CONTROL)) {
        expect(
          repoFiles,
          `${rel} は無くなりました。NOT_LICENSE_CONTROL から消してください`,
        ).toContain(rel)
        expect(reason.trim()).not.toBe('')
      }
      for (const name of [
        'docs/specs-v2/LICENSE-APACHE',
        'docs/core/COPYRIGHT',
        'docs/license/x.txt',
        'PATENTS',
      ]) {
        expect(isLicenseControlFile(name), name).toBe(true)
      }
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
      expect(sha256(text)).toBe(APACHE_TEXT_SHA256)
    })

    it('tells contributors that these files are Apache-2.0', () => {
      expect(read('CONTRIBUTING.md')).toContain('Apache License 2.0 only')
    })
  })

  it('allows only the reviewed Apache references in the whole README, CONTRIBUTING and site configs', () => {
    // R3: License 節の外（冒頭のバッジ・Contributing 節）や CONTRIBUTING.md・サイトの設定の
    // 「Released under the Apache-2.0 License」は検査の外だった。
    const readme = read('README.md').split('\n')
    const grantAt = readme.findIndex((line) => line.startsWith(GRANT_ANCHOR))
    const grantLength = blockFrom(readme, grantAt).length
    expect(
      readme.filter(
        (line, i) => /apache/i.test(line) && (i < grantAt || i >= grantAt + grantLength),
      ),
    ).toEqual([README_LICENSE_SUMMARY_APACHE_LINE, ...README_APACHE_LINES])
    expect(
      read('CONTRIBUTING.md')
        .split('\n')
        .filter((line) => /apache/i.test(line)),
    ).toEqual(CONTRIBUTING_APACHE_LINES)
    const siteConfigs = repoFiles.filter((rel) => /^sites\/[^/]+\/\.vitepress\//.test(rel))
    expect(siteConfigs.length).toBeGreaterThan(0)
    expect(siteConfigs.filter((rel) => /apache/i.test(read(rel)))).toEqual([])
  })

  it('allows only the reviewed Apache references in the README License section', () => {
    const section = readmeLicenseSection()
    const heading = section.findIndex((line) => line === '### Implementing the OrbitScore DSL')
    expect(heading).toBeGreaterThan(-1)
    const grantAt = section.findIndex((line) => line.startsWith(GRANT_ANCHOR))
    const grant = blockFrom(section, grantAt)
    const outsideGrant = section.filter((_line, i) => i < grantAt || i >= grantAt + grant.length)
    expect(outsideGrant.filter((line) => /apache/i.test(line))).toEqual([
      README_LICENSE_SUMMARY_APACHE_LINE,
      ...README_APACHE_LINES,
    ])
    expect(
      section.slice(heading + 1).filter((line) => /may be implemented by/i.test(line)),
    ).toEqual([README_IMPLEMENTATION_LEAD])
  })

  it.skipIf(!repoFiles.some((rel) => rel.startsWith('protocol/')))(
    'names protocol/ in the root LICENSE once protocol/ exists',
    () => {
      // 設計 848 の裁定（§14 (9)）で `protocol/` は Apache-2.0 になる（計画 §7.1 の C-2 が
      // `protocol/LICENSE` を置く）。ディレクトリが現れた時点でルートの LICENSE が触れていなければ、
      // 「ルートの LICENSE が全体を覆う」と読める食い違いが生まれる。
      expect(
        fs.existsSync(path.join(repoRoot, 'protocol/LICENSE')),
        'protocol/LICENSE がありません',
      ).toBe(true)
      expect(sha256(fs.readFileSync(path.join(repoRoot, 'protocol/LICENSE')))).toBe(
        APACHE_TEXT_SHA256,
      )
      expect(read('LICENSE'), 'ルートの LICENSE に protocol/ の扱いを書いてください').toContain(
        'protocol/',
      )
    },
  )
})
