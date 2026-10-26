import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * user サイトの可用性表記の lint（`sites/user/scripts/check-availability.mjs`）の振る舞いを固定する。
 *
 * 設計: `docs/design/848-docs-structure-design.md` §3.4 / §5.4。規則 `AV-HOST-SCOPE` は
 * owner 裁定 (20) の条件「拡張版の読者が OrbitStudio の記述を自分の手順として読まない」を
 * 機械で守るもので、設計 848 §1.4 の暫定物の台帳 P-13 がこの規則の存在を求めている。
 *
 * lint は `npm run docs:check`（CI の user サイト可用性 lint を含む段）で実サイトに掛かるが、実サイトには
 * まだ OrbitStudio の記述も可用性の行も無い。**実サイトが緑なだけでは規則が効くことの証明に
 * ならない**ので、ここで一時ディレクトリに章を作り、`--root` で lint を走らせて red / 緑を確かめる。
 */
const repoRoot = path.resolve(__dirname, '../..')
const SCRIPT = path.join(repoRoot, 'sites/user/scripts/check-availability.mjs')
const USER_SITE = path.join(repoRoot, 'sites/user')
const ROOT_SKIP_DIRS = new Set(['node_modules', '.vitepress', 'public', 'scripts'])
const ROOT_SKIP_FILES = new Set(['STYLE_GUIDE.md', 'README.md'])

interface LintResult {
  status: number | null
  out: string
}

function lint(files: Record<string, string>, ...args: string[]): LintResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-availability-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    }
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function lintWithSetup(setup: (root: string) => void, ...args: string[]): LintResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-availability-'))
  try {
    setup(root)
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/** lint 実装の walk を呼ばず、テスト側でサイト直下だけの除外規則を適用して数える。 */
function countSiteChapters(dir = USER_SITE, root = USER_SITE): number {
  let count = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full)
    const atRoot = !rel.includes(path.sep)
    if (atRoot && entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (!(atRoot && ROOT_SKIP_DIRS.has(entry.name))) count += countSiteChapters(full, root)
    } else if (entry.name.endsWith('.md') && !(atRoot && ROOT_SKIP_FILES.has(entry.name))) {
      count++
    }
  }
  return count
}

/** frontmatter + `# タイトル` + 本文。`host` を null にすると `host:` を書かない。 */
function chapter(host: string | null, body: string, extraFrontmatter = ''): string {
  const hostLine = host === null ? '' : `host: ${host}\n`
  return `---\ntitle: t\ndescription: d\n${extraFrontmatter}${hostLine}---\n\n# T\n\n${body}\n`
}

function expectGreen(r: LintResult): void {
  expect(r.out).not.toContain('FAIL ')
  expect(r.status, r.out).toBe(0)
}

function findingKeys(out: string): string[] {
  return out
    .split('\n')
    .map((line) => /^(FAIL|WARN) (.+?:\d+) {2}\[([^\]]+)\]/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${match[1]} ${match[2]}  [${match[3]}]`)
}

function expectRed(r: LintResult, rule: string, where: string): void {
  expect(r.status, r.out).toBe(1)
  expect(findingKeys(r.out)).toContain(`FAIL ${where}  [${rule}]`)
}

describe('check-availability.mjs', () => {
  it('passes the real user site', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    const chapters = countSiteChapters()
    expect(chapters).toBe(42)
    expect(r.stdout).toContain(`${chapters} chapter(s) checked`)
    expect(r.stdout).toContain(
      '42 chapter(s) exempt from host-dependent rules via HOST_MISSING_BASELINE',
    )
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
  })

  it('fails when no target chapters are found', () => {
    const r = lint({})
    expectRed(r, 'AV-SYNTAX', '.:0')
    expect(r.out).toContain('対象の章が見つかりません。章の置き場が動いた可能性があります')
  })

  it('accepts every availability form documented in STYLE_GUIDE.md', () => {
    // STYLE_GUIDE の例と lint の文法がずれたら、ここが落ちる（文書と検査の二重管理を作らない）。
    const guide = fs.readFileSync(path.join(repoRoot, 'sites/user/STYLE_GUIDE.md'), 'utf8')
    const ja = guide.split('\n').filter((l) => l.startsWith('> **対応**: '))
    const en = guide.split('\n').filter((l) => l.startsWith('> **Availability**: '))
    expect(ja).toHaveLength(5)
    expect(en).toHaveLength(5)
    const sections = (lines: string[]) =>
      lines.map((l, i) => `## f${i}\n\n${l}\n\n本文`).join('\n\n')
    const r = lint({
      'a.md': chapter('both', sections(ja)),
      'en/a.md': chapter('both', sections(en)),
    })
    expectGreen(r)
    expect(r.out).toContain('[AV-UNRELEASED]') // 未リリースの 2 形 × 2 言語は警告
  })

  describe('AV-HOST', () => {
    it('requires host: in the frontmatter', () => {
      expectRed(lint({ 'a.md': chapter(null, 'x') }), 'AV-HOST', 'a.md:1')
    })

    it('rejects a value outside the four', () => {
      expectRed(lint({ 'a.md': chapter('vscode', 'x') }), 'AV-HOST', 'a.md:4')
    })

    it('rejects a duplicated host:', () => {
      expectRed(lint({ 'a.md': chapter('both', 'x', 'host: app\n') }), 'AV-HOST', 'a.md:5')
    })

    it('accepts all four values', () => {
      for (const host of ['both', 'app', 'ext', 'both+split'])
        expectGreen(lint({ 'a.md': chapter(host, 'x') }))
    })

    it.each([
      ['a YAML comment', 'host: both   # both | app | ext | both+split\n'],
      ['double quotes', 'host: "both"\n'],
      ['single quotes and a comment', "host: 'both' # shared chapter\n"],
    ])('accepts host: with %s', (_label, hostLine) => {
      const md = `---\ntitle: t\ndescription: d\n${hostLine}---\n\n# T\n\nx\n`
      expectGreen(lint({ 'a.md': md }))
    })

    it('accepts a split-section marker right after a heading in a both+split chapter', () => {
      const body =
        '## VS Code で開く\n<!-- host: ext -->\n\n手順\n\n## アプリで開く\n<!-- host: app -->\n\n手順'
      expectGreen(lint({ 'a.md': chapter('both+split', body) }))
    })

    it('rejects a split-section marker in a both chapter', () => {
      expectRed(
        lint({ 'a.md': chapter('both', '## VS Code で開く\n<!-- host: ext -->') }),
        'AV-HOST',
        'a.md:10',
      )
    })

    it('rejects a split-section marker that is not right after a heading', () => {
      expectRed(
        lint({ 'a.md': chapter('both+split', '## VS Code で開く\n\n<!-- host: ext -->') }),
        'AV-HOST',
        'a.md:11',
      )
    })

    it('rejects a misspelled split-section marker', () => {
      expectRed(
        lint({ 'a.md': chapter('both+split', '## VS Code で開く\n<!-- host: vscode -->') }),
        'AV-HOST',
        'a.md:10',
      )
    })

    it('rejects a split-section marker embedded in a heading', () => {
      expectRed(
        lint({ 'a.md': chapter('both+split', '## 手順 2 <!-- host: ext -->\n\n本文') }),
        'AV-HOST',
        'a.md:9',
      )
    })

    it('rejects a split-section marker embedded in frontmatter', () => {
      expectRed(
        lint({ 'a.md': chapter('both+split', '本文', 'note: "<!-- host: ext -->"\n') }),
        'AV-HOST',
        'a.md:4',
      )
    })

    it('rejects an exact split-section marker in frontmatter', () => {
      expectRed(
        lint({ 'a.md': chapter('both+split', '本文', '<!-- host: ext -->\n') }),
        'AV-HOST',
        'a.md:4',
      )
    })

    it('only excludes SKIP_DIRS and SKIP_FILES at the site root', () => {
      expectGreen(
        lint({
          'a.md': chapter('both', 'x'),
          'scripts/ignored.md': 'not a chapter',
          'README.md': 'not a chapter',
        }),
      )
      expectRed(
        lint({ 'a.md': chapter('both', 'x'), 'guide/scripts/a.md': 'not a chapter' }),
        'AV-HOST',
        'guide/scripts/a.md:1',
      )
      expectRed(
        lint({ 'a.md': chapter('both', 'x'), 'guide/README.md': 'not a chapter' }),
        'AV-HOST',
        'guide/README.md:1',
      )
    })

    it('rejects a symbolic-link directory', () => {
      const r = lintWithSetup((root) => {
        fs.writeFileSync(path.join(root, 'a.md'), chapter('both', 'x'))
        fs.mkdirSync(path.join(root, 'target'))
        fs.writeFileSync(path.join(root, 'target/b.md'), chapter('both', 'x'))
        fs.symlinkSync('target', path.join(root, 'linked'), 'dir')
      })
      expectRed(r, 'AV-HOST', 'linked:1')
    })

    it('rejects a symbolic-link Markdown file', () => {
      const r = lintWithSetup((root) => {
        fs.writeFileSync(path.join(root, 'a.md'), chapter('both', 'x'))
        fs.symlinkSync('a.md', path.join(root, 'linked.md'), 'file')
      })
      expectRed(r, 'AV-HOST', 'linked.md:1')
    })

    it('rejects a broken symbolic link without turning it into a usage error', () => {
      const r = lintWithSetup((root) => {
        fs.writeFileSync(path.join(root, 'a.md'), chapter('both', 'x'))
        fs.symlinkSync('missing.md', path.join(root, 'broken.md'), 'file')
      })
      expectRed(r, 'AV-HOST', 'broken.md:1')
      expect(r.out).not.toContain('Usage error:')
    })
  })

  describe('AV-SYNTAX', () => {
    const under = (line: string) => `## 機能\n\n${line}\n\n本文`
    it.each([
      ['a two-digit version', '> **対応**: OrbitScore 4.2 以降 / OrbitStudio 0.1.0 以降'],
      [
        'a misspelled line name',
        '> **対応**: Orbit Studio 0.2.0 以降（OrbitScore には入りません）',
      ],
      [
        'the lines in the other order',
        '> **対応**: OrbitStudio 0.1.0 以降 / OrbitScore 4.2.0 以降',
      ],
      ['a free-form sentence', '> **対応**: OrbitScore でだけ動きます'],
      ['a full-width colon', '> **対応**： OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      ['a missing blockquote marker', '**対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      [
        'a colon inside the bold text',
        '> **対応:** OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降',
      ],
      ['a missing colon', '> **対応** OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      ['an unbolded ja anchor', '> 対応: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      [
        'a malformed en anchor',
        '> **Availability:** OrbitScore 4.2.0 and later / OrbitStudio 0.1.0 and later',
      ],
    ])('rejects %s', (_label, line) => {
      expectRed(lint({ 'a.md': chapter('both', under(line)) }), 'AV-SYNTAX', 'a.md:11')
    })

    it.each([
      ['an arrow to a table', '入力 -> 対応表を見る'],
      ['an HTML-bold word', '<b>対応</b> の一覧'],
      ['Availability in an English sentence', 'See the table -> Availability matrix below.'],
      ['an inline Markdown-bold word', 'この **対応** は通常の本文です。'],
    ])('does not mistake %s for an availability anchor', (_label, line) => {
      expectGreen(lint({ 'a.md': chapter('both', line) }))
    })

    it('does not treat text before a valid form as a line-leading anchor', () => {
      const line = 'x> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'
      expectGreen(lint({ 'a.md': chapter('app', under(line)) }))
    })

    it.each([
      ['text after a valid form', '> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降x'],
    ])('rejects %s', (_label, line) => {
      expectRed(lint({ 'a.md': chapter('app', under(line)) }), 'AV-SYNTAX', 'a.md:11')
    })

    it.each([
      [
        'ja form 1: two-digit version',
        'a.md',
        '> **対応**: OrbitScore 4.2 以降 / OrbitStudio 0.1.0 以降',
      ],
      [
        'ja form 2: wrong parentheses',
        'a.md',
        '> **対応**: OrbitStudio 0.2.0 以降(OrbitScore には入りません)',
      ],
      [
        'ja form 3: missing suffix',
        'a.md',
        '> **対応**: OrbitScore 4.2.0（OrbitStudio では 0.1.0 から動作が変わります — 下記）',
      ],
      [
        'ja form 4: wrong dash',
        'a.md',
        '> **対応**: 未リリース（OrbitStudio）- main にマージ済み・次のリリースから',
      ],
      ['ja form 5: missing suffix', 'a.md', '> **対応**: 未リリース（OrbitScore 4.2.1）— 凍結版'],
      [
        'en form 1: two-digit version',
        'en/a.md',
        '> **Availability**: OrbitScore 4.2 and later / OrbitStudio 0.1.0 and later',
      ],
      [
        'en form 2: missing preposition',
        'en/a.md',
        '> **Availability**: OrbitStudio 0.2.0 and later (not OrbitScore)',
      ],
      [
        'en form 3: wrong dash',
        'en/a.md',
        '> **Availability**: OrbitScore 4.2.0 and later (behaves differently in OrbitStudio from 0.1.0 - see below)',
      ],
      [
        'en form 4: missing suffix',
        'en/a.md',
        '> **Availability**: Unreleased (OrbitStudio) — merged to main',
      ],
      [
        'en form 5: two-digit version',
        'en/a.md',
        '> **Availability**: Unreleased (OrbitScore 4.2) — bug fix for the frozen line',
      ],
    ])('rejects a broken fixed form: %s', (_label, rel, line) => {
      expectRed(lint({ [rel]: chapter('app', under(line)) }), 'AV-SYNTAX', `${rel}:11`)
    })

    it('rejects the ja anchor in an en chapter', () => {
      const line = '> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'
      expectRed(lint({ 'en/a.md': chapter('both', under(line)) }), 'AV-SYNTAX', 'en/a.md:11')
    })

    it('rejects a text line right after the availability line (it would join the blockquote)', () => {
      const body = '## 機能\n\n> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降\n本文'
      expectRed(lint({ 'a.md': chapter('both', body) }), 'AV-SYNTAX', 'a.md:12')
    })

    it('ignores availability-like lines inside a code block', () => {
      expectGreen(lint({ 'a.md': chapter('ext', '```markdown\n> **対応**: なんでも\n```') }))
    })

    it('rejects an unterminated code fence', () => {
      expectRed(
        lint({ 'a.md': chapter('ext', '```markdown\n> **対応**: ここはコード') }),
        'AV-SYNTAX',
        'a.md:9',
      )
    })
  })

  describe('AV-PLACE', () => {
    it('rejects an availability line that is not right under a heading', () => {
      const body = '## 機能\n\n本文\n\n> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降\n'
      expectRed(lint({ 'a.md': chapter('both', body) }), 'AV-PLACE', 'a.md:13')
    })

    it('rejects a second availability line under the same heading', () => {
      const line = '> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'
      expectRed(
        lint({ 'a.md': chapter('both', `## 機能\n\n${line}\n\n${line}\n`) }),
        'AV-PLACE',
        'a.md:13',
      )
    })

    it('accepts an availability line after a split-section marker', () => {
      const body =
        '## アプリで開く\n<!-- host: app -->\n\n> **対応**: OrbitStudio 0.2.0 以降（OrbitScore には入りません）\n\n手順'
      expectGreen(lint({ 'a.md': chapter('both+split', body) }))
    })
  })

  describe('AV-UNRELEASED', () => {
    const body =
      '## 機能\n\n> **対応**: 未リリース（OrbitStudio）— main にマージ済み・次のリリースから\n\n本文'

    it('only warns on main', () => {
      const r = lint({ 'a.md': chapter('both', body) })
      expectGreen(r)
      expect(r.out).toContain('WARN a.md:11  [AV-UNRELEASED]')
    })

    it('fails with --release', () => {
      expectRed(lint({ 'a.md': chapter('both', body) }, '--release'), 'AV-UNRELEASED', 'a.md:11')
    })

    it('checks all ten fixed forms and reports exactly four unreleased lines', () => {
      const ja = [
        '> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降',
        '> **対応**: OrbitStudio 0.2.0 以降（OrbitScore には入りません）',
        '> **対応**: OrbitScore 4.2.0 以降（OrbitStudio では 0.1.0 から動作が変わります — 下記）',
        '> **対応**: 未リリース（OrbitStudio）— main にマージ済み・次のリリースから',
        '> **対応**: 未リリース（OrbitScore 4.2.1）— 凍結版の bug fix',
      ]
      const en = [
        '> **Availability**: OrbitScore 4.2.0 and later / OrbitStudio 0.1.0 and later',
        '> **Availability**: OrbitStudio 0.2.0 and later (not in OrbitScore)',
        '> **Availability**: OrbitScore 4.2.0 and later (behaves differently in OrbitStudio from 0.1.0 — see below)',
        '> **Availability**: Unreleased (OrbitStudio) — merged to main, ships in the next release',
        '> **Availability**: Unreleased (OrbitScore 4.2.1) — bug fix for the frozen line',
      ]
      const sections = (lines: string[]) =>
        lines.map((line, i) => `## f${i}\n\n${line}\n\ntext`).join('\n\n')
      const files = {
        'a.md': chapter('both', sections(ja)),
        'en/a.md': chapter('both', sections(en)),
      }

      const normal = lint(files)
      expectGreen(normal)
      const warningKeys = findingKeys(normal.out).filter((key) => key.startsWith('WARN '))
      expect(warningKeys).toHaveLength(4)
      expect(warningKeys.every((key) => key.endsWith('[AV-UNRELEASED]'))).toBe(true)
      expect(warningKeys.filter((key) => key.startsWith('WARN a.md:'))).toHaveLength(2)
      expect(warningKeys.filter((key) => key.startsWith('WARN en/a.md:'))).toHaveLength(2)

      const preflight = lint(files, '--release')
      expect(preflight.status, preflight.out).toBe(1)
      const failureKeys = findingKeys(preflight.out).filter((key) => key.startsWith('FAIL '))
      expect(failureKeys).toHaveLength(4)
      expect(failureKeys.every((key) => key.endsWith('[AV-UNRELEASED]'))).toBe(true)
      expect(failureKeys.filter((key) => key.startsWith('FAIL a.md:'))).toHaveLength(2)
      expect(failureKeys.filter((key) => key.startsWith('FAIL en/a.md:'))).toHaveLength(2)
    })

    it('still checks a malformed availability anchor for unreleased content', () => {
      const malformed =
        '## 機能\n\n> **対応:** 未リリース（OrbitStudio）— main にマージ済み・次のリリースから\n\n本文'
      const r = lint({ 'a.md': chapter('app', malformed) })
      expectRed(r, 'AV-SYNTAX', 'a.md:11')
      expect(findingKeys(r.out)).toContain('WARN a.md:11  [AV-UNRELEASED]')
    })
  })

  describe('AV-I18N', () => {
    it('rejects a different host between ja and en', () => {
      expectRed(
        lint({ 'a.md': chapter('both', 'x'), 'en/a.md': chapter('ext', 'x') }),
        'AV-I18N',
        'en/a.md:1',
      )
    })

    it('rejects a different number of availability lines between ja and en', () => {
      const ja = '## 機能\n\n> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降\n\n本文'
      expectRed(
        lint({ 'a.md': chapter('both', ja), 'en/a.md': chapter('both', '## Feature\n\ntext') }),
        'AV-I18N',
        'en/a.md:1',
      )
    })

    it('counts malformed availability candidates for the ja/en comparison', () => {
      const ja = '## 機能\n\n> 対応: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降\n\n本文'
      const r = lint({ 'a.md': chapter('app', ja), 'en/a.md': chapter('app', 'text') })
      expectRed(r, 'AV-SYNTAX', 'a.md:11')
      expectRed(r, 'AV-I18N', 'en/a.md:1')
    })

    it('rejects a different number of split-section markers between ja and en', () => {
      const ja = '## 手順\n<!-- host: ext -->\n\n本文'
      expectRed(
        lint({ 'a.md': chapter('both+split', ja), 'en/a.md': chapter('both+split', 'text') }),
        'AV-I18N',
        'en/a.md:1',
      )
    })
  })

  describe('AV-HOST-SCOPE', () => {
    it.each([
      ['a body line', 'OrbitStudio では Catalog パネルから再スキャンします。', 'a.md:9'],
      ['an OrbitScore parallel line', '- **OrbitScore**: OrbitStudio と同じ手順です', 'a.md:9'],
      ['a lower-case identifier', '`ORBITSTUDIO_RUNTIME_DIR` を設定します', 'a.md:9'],
      ['a code block', '```text\n// OrbitStudio ではここが違う\n```', 'a.md:10'],
    ])('rejects OrbitStudio in %s of a both chapter', (_label, body, where) => {
      expectRed(lint({ 'a.md': chapter('both', body) }), 'AV-HOST-SCOPE', where)
    })

    it('rejects OrbitStudio in the frontmatter of a both chapter', () => {
      const md = '---\ntitle: t\ndescription: OrbitStudio の章\nhost: both\n---\n\n# T\n'
      expectRed(lint({ 'a.md': md }), 'AV-HOST-SCOPE', 'a.md:3')
    })

    it('rejects OrbitStudio in a both+split chapter too', () => {
      expectRed(
        lint({ 'a.md': chapter('both+split', 'OrbitStudio の手順') }),
        'AV-HOST-SCOPE',
        'a.md:9',
      )
    })

    it('rejects OrbitStudio in the en chapter as well', () => {
      expectRed(
        lint({ 'en/a.md': chapter('both', 'In OrbitStudio, open the Catalog panel.') }),
        'AV-HOST-SCOPE',
        'en/a.md:9',
      )
    })

    it('accepts a - **OrbitStudio**: parallel line (ja and en)', () => {
      const tip = (ext: string) =>
        `::: tip\n- **${ext}**: コマンドパレット\n- **OrbitStudio**: Catalog パネル\n:::`
      expectGreen(
        lint({
          'a.md': chapter('both', tip('OrbitScore')),
          'en/a.md': chapter('both', tip('OrbitScore')),
        }),
      )
    })

    it('accepts OrbitStudio inside a section (and its subsections) whose availability line names OrbitStudio', () => {
      const body = [
        '## 機能',
        '',
        '> **対応**: OrbitScore 4.2.0 以降（OrbitStudio では 0.1.0 から動作が変わります — 下記）',
        '',
        'OrbitStudio では既定値が違います。',
        '',
        '### OrbitStudio での違い',
        '',
        'OrbitStudio の既定は 512 です。',
      ].join('\n')
      expectGreen(lint({ 'a.md': chapter('both', body) }))
    })

    it('rejects OrbitStudio once the scoped section has ended', () => {
      const body = [
        '## 機能',
        '',
        '> **対応**: OrbitStudio 0.2.0 以降（OrbitScore には入りません）',
        '',
        'OrbitStudio だけの機能です。',
        '',
        '## 次の機能',
        '',
        'OrbitStudio でも同じです。',
      ].join('\n')
      expectRed(lint({ 'a.md': chapter('both', body) }), 'AV-HOST-SCOPE', 'a.md:17')
    })

    it('does not treat an availability line without OrbitStudio as scoping the section', () => {
      const body =
        '## 修正\n\n> **対応**: 未リリース（OrbitScore 4.2.1）— 凍結版の bug fix\n\nOrbitStudio には既に入っています。'
      expectRed(lint({ 'a.md': chapter('both', body) }), 'AV-HOST-SCOPE', 'a.md:13')
    })

    it('ignores the legacy extension-harness identifiers that still say orbitstudio', () => {
      // CLAUDE.md（2026-09-18）: 識別子は当面そのまま。拡張版のハーネスの名前で、ネイティブ版の情報ではない。
      const body =
        '`tests/e2e/orbitstudio-mcp-gated.spec.ts` の実測（`ORBIT_GATED_ORBITSTUDIO=1`）に記録しました。'
      expectGreen(lint({ 'a.md': chapter('both', body) }))
    })

    it('still rejects other orbitstudio identifiers on the same line', () => {
      const body = '`orbitstudio-mcp-gated.spec.ts` と `ORBITSTUDIO_RUNTIME_DIR`'
      expectRed(lint({ 'a.md': chapter('both', body) }), 'AV-HOST-SCOPE', 'a.md:9')
    })

    it('does not apply to app and ext chapters', () => {
      expectGreen(
        lint({
          'a.md': chapter('app', 'OrbitStudio の環境設定'),
          'b.md': chapter('ext', 'OrbitStudio ではない方の手順'),
        }),
      )
    })
  })

  describe('AV-TERM', () => {
    it.each([
      ['a.md', '::: tip\n- **拡張版**: コマンドパレット\n:::', 'a.md:10'],
      ['en/a.md', '::: tip\n- **Extension**: Command Palette\n:::', 'en/a.md:10'],
    ])('rejects the old label for the extension line (%s)', (rel, body, where) => {
      expectRed(lint({ [rel]: chapter('both', body) }), 'AV-TERM', where)
    })

    it('rejects calling the extension "OrbitStudio（凍結版）"', () => {
      expectRed(
        lint({ 'a.md': chapter('ext', 'OrbitStudio（凍結版・現 4.2.0）') }),
        'AV-TERM',
        'a.md:9',
      )
    })

    it('rejects the en wording too', () => {
      expectRed(
        lint({ 'en/a.md': chapter('ext', 'OrbitStudio (frozen line)') }),
        'AV-TERM',
        'en/a.md:9',
      )
    })
  })

  describe('command-line usage', () => {
    it('rejects an unknown argument with exit code 2', () => {
      const r = lint({ 'a.md': chapter('both', 'x') }, '--relese')
      expect(r.status, r.out).toBe(2)
      expect(r.out).toContain('Usage error: unknown argument: --relese')
      expect(r.out).toContain('Usage: check-availability.mjs [--release] [--root <dir>]')
    })

    it('rejects --root without a value with exit code 2', () => {
      const r = spawnSync(process.execPath, [SCRIPT, '--root'], { encoding: 'utf8' })
      const out = `${r.stdout}${r.stderr}`
      expect(r.status, out).toBe(2)
      expect(out).toContain('Usage error: `--root` requires a directory')
    })
  })
})
