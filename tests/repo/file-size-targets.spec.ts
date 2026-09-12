import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { listMeasuredFiles, MEASURED_PATHSPECS } from './file-size-targets'

/** 真空防止（§4.1）は除外適用**前**の生の `git ls-files` 件数で判定する。テストも同じ数を見る。 */
function rawFileCount(repoRoot: string, pathspec: string): number {
  const output = execFileSync('git', ['ls-files', '-z', '--', pathspec], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return output.split('\0').filter((entry) => entry.length > 0).length
}

/**
 * `listMeasuredFiles` の列挙テスト（#888 子 0・設計 §9.2 の L-1 / L-2）。
 *
 * 🔴 **このテストが無かったことで、実際に穴が開いていた**（main のレビューで実証・
 * 2026-09-12）。真空防止のしきい値（Rust/TS とも 100 件）は、`git ls-files` の
 * pathspec が `:(glob)` magic を欠いて `src/` 直下のファイルを落とす事故を**検出
 * できない** — TS は非 glob でも 109 件（> 100）返るため、しきい値未満にならない。
 *
 * 実際、`extension.ts` / `mcp-server.ts` を baseline から外した状態（= 分割が
 * 終わった後の姿）で `:(glob)` を落として `npx vitest run … file-size-ratchet` を
 * 走らせると、**23 ファイルが列挙から消えたまま緑になる**ことを main が確認した。
 * つまりこの分割作業が成功した瞬間に、この穴が実害化する構造だった。
 *
 * 設計 §4.1 が指示するとおり、**件数のしきい値では塞げない穴を、既知の代表ファイルの
 * 名指し検査で塞ぐ**（L-1）。件数のしきい値そのものが機能することも別途検査する（L-2）。
 */
const repoRoot = path.resolve(__dirname, '../..')

describe('listMeasuredFiles', () => {
  describe('L-1: 実 repo での列挙', () => {
    const files = listMeasuredFiles(repoRoot)
    const paths = new Set(files.map((f) => f.path))
    const rustCount = files.filter((f) => f.lang === 'rust').length
    const tsCount = files.filter((f) => f.lang === 'ts').length

    it('真空防止: git ls-files（除外適用前）が Rust ≥ 100 件・TS ≥ 100 件を返す', () => {
      // listMeasuredFiles の真空防止は除外「前」の生の件数で判定する（設計 §4.1・
      // tests/examples/build.rs 等の正当な除外を誤検知しないため）。除外「後」の
      // 最終件数（Rust は現状 95 件で 100 を割る）は真空防止の対象ではない。
      const rustPathspec = MEASURED_PATHSPECS.find((p) => p.lang === 'rust')?.pathspec as string
      const tsPathspec = MEASURED_PATHSPECS.find((p) => p.lang === 'ts')?.pathspec as string
      expect(rawFileCount(repoRoot, rustPathspec)).toBeGreaterThanOrEqual(100)
      expect(rawFileCount(repoRoot, tsPathspec)).toBeGreaterThanOrEqual(100)
    })

    it('除外適用後も現実的な件数が残る（列挙そのものが空にならない）', () => {
      expect(rustCount).toBeGreaterThan(0)
      expect(tsCount).toBeGreaterThan(0)
    })

    it('🔴 src/ 直下のファイルを名指しで含む（":(glob)" 事故の代表・設計 §4.1）', () => {
      // `packages/*/src/**/*.ts` が ":(glob)" magic を欠くと、`**` の既定解釈により
      // `src/` 直下（中間ディレクトリを1つも挟まない）ファイルが列挙から落ちる。
      // 件数のしきい値（>= 100）はこの脱落を検出できない（非 glob でも 109 件残るため）。
      expect(paths.has('packages/vscode-extension/src/extension.ts')).toBe(true)
      expect(paths.has('packages/vscode-extension/src/mcp-server.ts')).toBe(true)
    })

    it('🔴 Rust の baseline 最大ファイルを名指しで含む', () => {
      expect(paths.has('rust/crates/orbit-audio-daemon/src/engine_wrap.rs')).toBe(true)
    })

    it('src/bin/ 配下のバイナリソースを含む（除外の積極的理由が無い・設計 §4.2）', () => {
      expect(paths.has('rust/crates/orbit-sandbox-spike/src/bin/sandbox-host.rs')).toBe(true)
    })

    it('workspace 外の orbit-link-audio を含む（我々が保守する Rust ソース・設計 §4.2）', () => {
      expect(paths.has('rust/crates/orbit-link-audio/src/lib.rs')).toBe(true)
    })

    it('Rust の tests/ examples/ benches/ build.rs を含まない（設計 §4.2）', () => {
      for (const f of files) {
        if (f.lang !== 'rust') continue
        expect(f.path).not.toMatch(/(^|\/)tests\//)
        expect(f.path).not.toMatch(/(^|\/)examples\//)
        expect(f.path).not.toMatch(/(^|\/)benches\//)
        expect(f.path).not.toMatch(/(^|\/)build\.rs$/)
      }
    })

    it('src/**/tests.rs（インライン test mod をファイルへ外出ししたもの）を含まない', () => {
      expect(paths.has('rust/crates/orbit-effect-rack-child/src/tests.rs')).toBe(false)
    })

    it('リポジトリ直下の tests/**（子0では対象外・設計 §4.3）を含まない', () => {
      for (const f of files) {
        expect(f.path.startsWith('tests/')).toBe(false)
      }
    })
  })

  describe('L-2: 真空防止（しきい値未満なら throw）', () => {
    it('列挙が閾値未満なら throw する（lang 単位の合計チェック）', () => {
      // 実在するが極少数しかマッチしない pathspec を注入し、真空防止の発火そのものを確かめる。
      // MEASURED_PATHSPECS 本体は変更しない（第2引数での注入は file-size-targets.ts が
      // テスト用に許している差し替え口）。この rust エントリの `minFiles` は実測値である
      // 1 に合わせてある（このテストの狙いは lang 合計チェックの発火であって、下の
      // 「エントリ単位」テストと発火する経路を分けるため）。
      expect(() =>
        listMeasuredFiles(repoRoot, [
          { pathspec: ':(glob)rust/crates/orbit-link-audio/src/lib.rs', lang: 'rust', minFiles: 1 },
          { pathspec: ':(glob)packages/*/src/**/*.ts', lang: 'ts', minFiles: 100 },
        ]),
      ).toThrow(/rust の列挙（除外適用前）が 1 件しかありません/)
    })

    it('列挙が閾値以上なら throw しない（既定の pathspec）', () => {
      expect(() => listMeasuredFiles(repoRoot, MEASURED_PATHSPECS)).not.toThrow()
    })

    it('🔴 F-3: エントリが1つでも空に近ければ throw する（他のエントリの件数で下駄を履けない）', () => {
      // fail-before（レビュー指摘の再現）: 修正前の listMeasuredFiles はエントリ単位の
      // minFiles を持たず、lang 単位の合計でしか判定しなかった。既存 TS pathspec の
      // 132 件が、":(glob)" を欠いて 0 件しか返さない新規エントリを支えてしまい、
      // 合計 132 ≥ 100 で緑になっていた（このテストが無かったことで実害化していた穴）。
      expect(() =>
        listMeasuredFiles(repoRoot, [
          ...MEASURED_PATHSPECS,
          // ":(glob)" を欠いた pathspec（`**` の既定解釈で `src/` 直下のファイルを含む
          // 何もマッチしない極端な例。実在するが低いしきい値を意図的に要求する）。
          { pathspec: 'packages/does-not-exist/src/**/*.ts', lang: 'ts', minFiles: 1 },
        ]),
      ).toThrow(
        /pathspec "packages\/does-not-exist\/src\/\*\*\/\*\.ts"（ts）の列挙（除外適用前）が 0 件しかありません/,
      )
    })

    it('F-3: エントリ単独が minFiles を満たせば throw しない（既定の pathspec は全エントリ通過）', () => {
      // MEASURED_PATHSPECS の各エントリは自身の minFiles を単独で満たす（真の既定動作）。
      expect(() => listMeasuredFiles(repoRoot, MEASURED_PATHSPECS)).not.toThrow()
    })
  })
})
