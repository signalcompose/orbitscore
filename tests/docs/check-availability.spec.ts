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

    it.each([
      ['an upper-case Host', '<!-- Host: ext -->'],
      ['a missing colon', '<!-- host ext -->'],
      ['an equals sign', '<!-- host=ext -->'],
    ])('rejects a split-section marker with %s', (_label, marker) => {
      expectRed(
        lint({ 'a.md': chapter('both+split', `## VS Code で開く\n${marker}\n\n手順`) }),
        'AV-HOST',
        'a.md:10',
      )
    })

    it('rejects a near-miss split-section marker in a both chapter too', () => {
      expectRed(
        lint({ 'a.md': chapter('both', '## アプリで開く\n<!-- Host: app -->\n\n手順') }),
        'AV-HOST',
        'a.md:10',
      )
    })

    it('skips dot entries only at the site root', () => {
      expectGreen(lint({ 'a.md': chapter('both', 'x'), '.hidden/x.md': 'not a chapter' }))
      expectRed(
        lint({ 'a.md': chapter('both', 'x'), 'guide/.draft.md': 'not a chapter' }),
        'AV-HOST',
        'guide/.draft.md:1',
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

    // R2: 行頭だけに絞った修正で、R1 では赤だったこれらの形が黙って通っていた。
    it.each([
      [
        'text before the bold anchor',
        'x> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降',
      ],
      ['a list item', '- **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      ['a numbered list item', '1. **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      ['a nested blockquote', '>> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      [
        'a spaced nested blockquote',
        '> > **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降',
      ],
      ['a four-space indent', '    **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      ['a two-space indent', '  > **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      ['the anchor in mid-line', '本文 **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      ['a single-star emphasis', '> *対応*: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降'],
      [
        'an unreleased form in a list item',
        '- **対応**: 未リリース（OrbitStudio）— main にマージ済み・次のリリースから',
      ],
    ])('rejects a near miss: %s', (_label, line) => {
      expectRed(lint({ 'a.md': chapter('app', under(line)) }), 'AV-SYNTAX', 'a.md:11')
    })

    it.each([
      [
        'a lower-case label',
        '> **availability**: OrbitScore 4.2.0 and later / OrbitStudio 0.1.0 and later',
      ],
      [
        'a list item',
        '- **Availability**: OrbitScore 4.2.0 and later / OrbitStudio 0.1.0 and later',
      ],
    ])('rejects an en near miss: %s', (_label, line) => {
      expectRed(lint({ 'en/a.md': chapter('app', under(line)) }), 'AV-SYNTAX', 'en/a.md:11')
    })

    it.each([
      ['a line that starts with a word', '対応表を以下に示します。'],
      ['a line that starts with Availability', 'Availability of plugins varies.'],
      ['a bold word that runs into the sentence', '**対応**していないプラグインもあります。'],
      ['a blockquote that starts with a word', '> 対応表は次のとおりです。'],
    ])('does not mistake prose for an availability anchor: %s', (_label, line) => {
      expectGreen(lint({ 'a.md': chapter('app', line) }))
    })

    it.each([
      [
        'text between the anchor and the form',
        'a.md',
        '> **対応**: x OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降',
      ],
      [
        'two spaces after the colon',
        'a.md',
        '> **対応**:  OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降',
      ],
      [
        'text between the en anchor and the form',
        'en/a.md',
        '> **Availability**: x OrbitScore 4.2.0 and later / OrbitStudio 0.1.0 and later',
      ],
    ])('rejects %s', (_label, rel, line) => {
      expectRed(lint({ [rel]: chapter('app', under(line)) }), 'AV-SYNTAX', `${rel}:11`)
    })

    it('names trailing whitespace after an availability line', () => {
      const line = '> **対応**: OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降  '
      const r = lint({ 'a.md': chapter('app', under(line)) })
      expectRed(r, 'AV-SYNTAX', 'a.md:11')
      expect(r.out).toContain('trailing whitespace after the availability line')
      expect(r.out).not.toContain('not one of the five fixed forms')
    })

    it('rejects an availability-like key in the frontmatter', () => {
      const r = lint({ 'a.md': chapter('app', 'x', 'availability: OrbitStudio 0.2.0\n') })
      expectRed(r, 'AV-SYNTAX', 'a.md:4')
    })

    it('still checks the blank line and the place for an anchor in the other language', () => {
      const body =
        '本文\n\n> **Availability**: OrbitScore 4.2.0 and later / OrbitStudio 0.1.0 and later\n本文'
      const r = lint({ 'a.md': chapter('app', body) })
      expectRed(r, 'AV-SYNTAX', 'a.md:11')
      expectRed(r, 'AV-SYNTAX', 'a.md:12')
      expectRed(r, 'AV-PLACE', 'a.md:11')
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

    // 各形のすべての枠を 1 つずつ崩す（版を 2 桁に・語を 1 つ消す）。どれも AV-SYNTAX になる。
    it.each([
      [
        'ja',
        'a.md',
        '> **対応**: ',
        [
          'OrbitScore 4.2.0 以降 / OrbitStudio 0.1.0 以降',
          'OrbitStudio 0.2.0 以降（OrbitScore には入りません）',
          'OrbitScore 4.2.0 以降（OrbitStudio では 0.1.0 から動作が変わります — 下記）',
          '未リリース（OrbitStudio）— main にマージ済み・次のリリースから',
          '未リリース（OrbitScore 4.2.1）— 凍結版の bug fix',
        ],
      ],
      [
        'en',
        'en/a.md',
        '> **Availability**: ',
        [
          'OrbitScore 4.2.0 and later / OrbitStudio 0.1.0 and later',
          'OrbitStudio 0.2.0 and later (not in OrbitScore)',
          'OrbitScore 4.2.0 and later (behaves differently in OrbitStudio from 0.1.0 — see below)',
          'Unreleased (OrbitStudio) — merged to main, ships in the next release',
          'Unreleased (OrbitScore 4.2.1) — bug fix for the frozen line',
        ],
      ],
    ] as const)('rejects every one-slot break of the %s forms', (_lang, rel, anchor, forms) => {
      const variants: string[] = []
      for (const form of forms) {
        const versions = [...form.matchAll(/\d+\.\d+\.\d+/g)]
        for (const v of versions) {
          const at = v.index ?? 0
          variants.push(form.slice(0, at) + '1.2' + form.slice(at + v[0].length))
        }
        const tokens = form.split(' ')
        tokens.forEach((_t, i) => variants.push(tokens.filter((_u, j) => j !== i).join(' ')))
      }
      const body = variants.map((rest, k) => `## f${k}\n\n${anchor}${rest}\n\ntext`).join('\n\n')
      const r = lint({ [rel]: chapter('app', body) })
      expect(r.status, r.out).toBe(1)
      const keys = findingKeys(r.out)
      variants.forEach((rest, k) =>
        expect(keys, `${anchor}${rest}`).toContain(`FAIL ${rel}:${11 + 6 * k}  [AV-SYNTAX]`),
      )
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

    it.each([
      ['a tilde fence holding a backtick line', '~~~\n> **対応**: x\n```\n> **対応**: y\n~~~'],
      ['a four-backtick fence holding a three-backtick line', '````\n```\n> **対応**: x\n````'],
    ])('keeps the code block open until its own closer: %s', (_label, body) => {
      expectGreen(lint({ 'a.md': chapter('ext', body) }))
    })

    it('does not close a code block with a fence that carries text', () => {
      expectRed(
        lint({ 'a.md': chapter('ext', '```\n> **対応**: x\n``` not a closer') }),
        'AV-SYNTAX',
        'a.md:9',
      )
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

    it('finds an unreleased marker in prose (the docs no longer carry a grep for it)', () => {
      const files = { 'a.md': chapter('app', 'この機能は未リリース（OrbitStudio）です。') }
      const normal = lint(files)
      expectGreen(normal)
      expect(findingKeys(normal.out)).toContain('WARN a.md:9  [AV-UNRELEASED]')
      expectRed(lint(files, '--release'), 'AV-UNRELEASED', 'a.md:9')
    })

    it('finds an unreleased marker in the frontmatter and in the other language', () => {
      const files = {
        'en/a.md': chapter(
          'app',
          'Unreleased (OrbitStudio) and 未リリース（OrbitStudio）',
          'description: Unreleased (OrbitStudio)\n',
        ),
      }
      const r = lint(files, '--release')
      expectRed(r, 'AV-UNRELEASED', 'en/a.md:4')
      expectRed(r, 'AV-UNRELEASED', 'en/a.md:10')
    })

    it('does not look inside code blocks for unreleased markers', () => {
      expectGreen(
        lint({ 'a.md': chapter('app', '```text\n未リリース（OrbitStudio）\n```') }, '--release'),
      )
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

    it('counts near-miss split-section markers for the ja/en comparison', () => {
      const ja = '## 手順\n<!-- Host: ext -->\n\n本文'
      const r = lint({
        'a.md': chapter('both+split', ja),
        'en/a.md': chapter('both+split', 'text'),
      })
      expectRed(r, 'AV-HOST', 'a.md:10')
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

    it.each([
      [
        'a duplicated --release',
        ['--release', '--release'],
        '`--release` was specified more than once',
      ],
      [
        'a duplicated --root',
        ['--root', '/tmp', '--root', '/tmp'],
        '`--root` was specified more than once',
      ],
      ['--root followed by a flag', ['--root', '--release'], '`--root` requires a directory'],
    ])('rejects %s with exit code 2', (_label, args, message) => {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
      const out = `${r.stdout}${r.stderr}`
      expect(r.status, out).toBe(2)
      expect(out).toContain(`Usage error: ${message}`)
    })

    it('rejects a --root that does not exist or is not a directory with exit code 2', () => {
      const missing = spawnSync(
        process.execPath,
        [SCRIPT, '--root', path.join(os.tmpdir(), 'orb-availability-missing-dir')],
        { encoding: 'utf8' },
      )
      expect(missing.status, missing.stderr).toBe(2)
      expect(missing.stderr).toContain('Usage error: cannot read --root')
      const r = lintWithSetup((root) =>
        fs.writeFileSync(path.join(root, 'a.md'), chapter('both', 'x')),
      )
      expect(r.status, r.out).toBe(0)
      const fileRoot = spawnSync(process.execPath, [SCRIPT, '--root', SCRIPT], { encoding: 'utf8' })
      expect(fileRoot.status, fileRoot.stderr).toBe(2)
      expect(fileRoot.stderr).toContain('not a directory')
    })

    it.skipIf(process.getuid?.() === 0)(
      'reports an unreadable chapter as a lint error and still checks the others',
      () => {
        const r = lintWithSetup((root) => {
          fs.writeFileSync(path.join(root, 'a.md'), chapter('both', 'x'))
          fs.writeFileSync(path.join(root, 'b.md'), chapter('vscode', 'x'))
          fs.chmodSync(path.join(root, 'a.md'), 0o000)
        })
        expectRed(r, 'AV-SYNTAX', 'a.md:1')
        expect(r.out).toContain('cannot read the chapter: EACCES')
        expectRed(r, 'AV-HOST', 'b.md:4')
        expect(r.out).not.toContain('Usage error')
      },
    )

    it('names a byte-order mark instead of reporting a missing host:', () => {
      const r = lint({ 'a.md': `\uFEFF${chapter('both', 'x')}` })
      expectRed(r, 'AV-SYNTAX', 'a.md:1')
      expect(r.out).toContain('byte-order mark')
      expect(r.out).not.toContain('frontmatter has no')
    })

    it('names CRLF line endings instead of reporting a missing host:', () => {
      const r = lint({ 'a.md': chapter('both', 'x').replace(/\n/g, '\r\n') })
      expectRed(r, 'AV-SYNTAX', 'a.md:1')
      expect(r.out).toContain('CRLF')
      expect(r.out).not.toContain('frontmatter has no')
    })

    it('rejects --root without a value with exit code 2', () => {
      const r = spawnSync(process.execPath, [SCRIPT, '--root'], { encoding: 'utf8' })
      const out = `${r.stdout}${r.stderr}`
      expect(r.status, out).toBe(2)
      expect(out).toContain('Usage error: `--root` requires a directory')
    })
  })
})
