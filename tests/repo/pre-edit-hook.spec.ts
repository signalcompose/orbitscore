import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

/**
 * `.claude/hooks/pre-edit-check.sh` の判定を固定する（#913）。
 *
 * 🔴 **なぜ要るか**: このフックは「main では Edit / Write を deny」する。判定は元々
 * **ブランチ名だけ**で、編集先のパスを見ていなかったので、**リポジトリの外**にある
 * memory（`~/.claude/projects/<project>/memory/`）や scratchpad まで巻き込んでいた。
 * その結果 **memory を 1 ファイル書くためだけに差分 0 のブランチを作って消す**という
 * 運用が発生した（2026-09-13 実測・owner 指摘）。
 *
 * 🔴 **緩めた方向だけでなく、締めたままの方向も検査する。** 「repo 外は通す」だけを
 * 確かめると、**誤って repo 内も通すようになった時に気づけない**。このフックの価値は
 * deny する側にあるので、両方向を固定する。
 *
 * 🔴 **本物の HEAD に依存させない。** 最初の版は「今 main にいるなら検査する」形で書いたが、
 * それでは **feature ブランチと CI で主要な検査が全部 skip され、空で緑になる**
 * （memory `a-test-that-exists-may-never-run`）。代わりに**使い捨ての git repo を 2 つ作り、
 * 一方の HEAD を `main`、他方を `1-feature` にして `CLAUDE_PROJECT_DIR` で指す。**
 * これでどのブランチから走らせても同じ判定を検査できる。
 */

const REPO_ROOT = path.resolve(__dirname, '../..')
const HOOK = path.join(REPO_ROOT, '.claude/hooks/pre-edit-check.sh')

type Decision = 'allow' | 'deny' | 'other'

/** HEAD が `branch` の使い捨て repo を作る（`rev-parse HEAD` には 1 コミット要る）。 */
function makeRepo(branch: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-hook-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git('init', '-b', branch)
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  fs.writeFileSync(path.join(dir, 'seed'), '')
  git('add', 'seed')
  git('commit', '-m', 'seed')
  // macOS の /var -> /private/var を解いておく（フックは文字列前置で比較する）
  return fs.realpathSync(dir)
}

const MAIN_REPO = makeRepo('main')
const FEATURE_REPO = makeRepo('1-feature')

afterAll(() => {
  for (const dir of [MAIN_REPO, FEATURE_REPO]) fs.rmSync(dir, { recursive: true, force: true })
})

function decide(projectDir: string, filePath: string | undefined): Decision {
  const payload = JSON.stringify(
    filePath === undefined ? { tool_input: {} } : { tool_input: { file_path: filePath } },
  )
  const out = execFileSync('bash', [HOOK], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    input: payload,
    encoding: 'utf8',
  })
  if (out.includes('"permissionDecision":"deny"')) return 'deny'
  if (out.trim() === '') return 'allow'
  return 'other'
}

describe('pre-edit-check.sh の判定（#913）', () => {
  it('前提: 使い捨て repo の HEAD が意図どおりである（真空防止）', () => {
    // ここが壊れると以下の検査が「main ではない repo」を相手にして全件 allow になる。
    const head = (dir: string): string =>
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
      }).trim()
    expect(head(MAIN_REPO)).toBe('main')
    expect(head(FEATURE_REPO)).toBe('1-feature')
  })

  it('🔴 main でも、リポジトリ外の絶対パスは allow', () => {
    for (const outside of [
      '/Users/someone/.claude/projects/p/memory/a.md',
      '/Users/someone/.claude/projects/p/memory/MEMORY.md',
      '/private/tmp/claude-501/x/scratchpad/t.mjs',
      '/Users/someone/.cvi/config',
    ]) {
      expect(decide(MAIN_REPO, outside), `repo 外は allow: ${outside}`).toBe('allow')
    }
  })

  it('🔴 main では repo 配下が deny される（このフックの本来の仕事）', () => {
    for (const inside of [
      `${MAIN_REPO}/packages/engine/src/core/global.ts`,
      `${MAIN_REPO}/docs/development/WORK_LOG.md`,
      `${MAIN_REPO}/.claude/hooks/pre-edit-check.sh`,
      'packages/engine/src/core/global.ts', // 相対パスは repo 相対なので repo 内
    ]) {
      expect(decide(MAIN_REPO, inside), `repo 内は deny: ${inside}`).toBe('deny')
    }
  })

  it('🔴 判定できない入力は deny に倒れる（allow に倒すと黙って効かなくなる）', () => {
    // 🔴 **prefix 一致から外れて `..` で repo 内へ戻るパス**でなければ検査にならない。
    // 最初の版は `${MAIN_REPO}/../evil.ts` を使っていたが、それは `"$PROJECT_DIR"/*` の
    // グロブに `../evil.ts` が一致するので **`*..*` ガードが無くても deny になる** =
    // 何も検査していなかった（変異を当てて緑のまま通り、判明した・2026-09-13）。
    //
    // 下の形は prefix に一致しない（`-decoy` が挟まる）ので、`*..*` ガードが無いと
    // **allow に倒れる**。しかし実際には repo 内へ着地する。
    const sibling = `${MAIN_REPO}-decoy/../${path.basename(MAIN_REPO)}/secret.ts`
    expect(decide(MAIN_REPO, sibling), 'prefix を外れて .. で戻るパスは deny').toBe('deny')

    // `file_path` が無い時は `[ -n "$TARGET_FILE" ]` で早期 exit せず deny へ落ちる。
    expect(decide(MAIN_REPO, undefined), 'file_path 無しは deny').toBe('deny')
  })

  it('plan file の既存ホワイトリストは main でも残っている', () => {
    // Plan mode の Phase 4 は protected branch でも plan を書く必要がある。
    expect(decide(MAIN_REPO, `${MAIN_REPO}/.claude/plans/p.md`)).toBe('allow')
  })

  it('feature ブランチでは repo 配下も allow', () => {
    expect(decide(FEATURE_REPO, `${FEATURE_REPO}/packages/engine/src/core/global.ts`)).toBe('allow')
  })
})
