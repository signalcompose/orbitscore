/**
 * ファイルサイズラチェット（#888 子 0）の測定対象の列挙。
 *
 * `git ls-files` で列挙する（fs の glob + 除外リストは採らない）。
 * `vitest.config.ts` のコメントが示すとおり、既定を手で再現する除外リストは
 * 「穴が黙って開く」型の事故を起こす（`git ls-files` なら `node_modules` /
 * `dist` / `rust/target` / 未追跡ファイルを**列挙の定義として**除外できる）。
 *
 * 🔴 pathspec は必ず `:(glob)` magic 付きで書く。既定の pathspec は `**` を
 * 正しく扱わず、`packages/*\/src/**\/*.ts` は `src/` 直下のファイル
 * （`extension.ts` / `mcp-server.ts` 等）を落とす（設計 §4.1・本日実測）。
 */

import { execFileSync } from 'node:child_process'

import type { Lang } from './code-lines'

export interface MeasuredFile {
  /** repo root からの相対パス（'/' 区切り） */
  path: string
  lang: Lang
}

/**
 * 測定対象の pathspec（§4.2）。`tests/**` を第二の対象として足す時
 * （§4.3・owner 裁定待ち）は、ここに1行加えるだけでよい形にしてある。
 *
 * 🔴 `minFiles` はこのエントリ**単独**の真空防止（レビュー指摘 F-3）。lang 単位の
 * 合計（`MIN_FILES_PER_LANG`）は同じ lang の他のエントリの件数で下駄を履けてしまい、
 * 新しく足したエントリが `:(glob)` を忘れて 0 件しか返さなくても合計が閾値を超えて
 * 見逃す（実測: 132 + 0 = 132 ≥ 100 → 緑）。エントリを足す時は必ず `minFiles` も
 * 決める（既存の実測値より十分低い値。ファイル数の自然な増減で誤検知しない程度）。
 */
export const MEASURED_PATHSPECS: ReadonlyArray<{ pathspec: string; lang: Lang; minFiles: number }> =
  [
    { pathspec: ':(glob)rust/crates/**/*.rs', lang: 'rust', minFiles: 100 },
    { pathspec: ':(glob)packages/*/src/**/*.ts', lang: 'ts', minFiles: 100 },
  ]

/** さらに除外する Rust パス（§4.2）。 */
const RUST_EXCLUDE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)tests\//,
  /(^|\/)examples\//,
  /(^|\/)benches\//,
  /(^|\/)build\.rs$/,
  /(^|\/)src\/(?:[^/]+\/)*tests\.rs$/,
]

/** 真空防止（§4.1）。列挙が既知の下限を割ったら pathspec の欠陥を疑う。 */
const MIN_FILES_PER_LANG: Record<Lang, number> = { rust: 100, ts: 100 }

function gitLsFiles(repoRoot: string, pathspec: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--', pathspec], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return output.split('\0').filter((entry) => entry.length > 0)
}

function isExcludedRustPath(relPath: string): boolean {
  return RUST_EXCLUDE_PATTERNS.some((pattern) => pattern.test(relPath))
}

/**
 * @param pathspecs 既定は {@link MEASURED_PATHSPECS}。テスト（`file-size-targets.spec.ts` の
 *   L-2・fail-before 実証）が `:(glob)` を欠いた pathspec を注入して真空防止/名指し検査を
 *   確かめられるように、引数として差し替え可能にしてある。通常の呼び出しでは渡さない。
 */
export function listMeasuredFiles(
  repoRoot: string,
  pathspecs: ReadonlyArray<{ pathspec: string; lang: Lang; minFiles: number }> = MEASURED_PATHSPECS,
): MeasuredFile[] {
  const files: MeasuredFile[] = []
  // 真空防止（§4.1）は `git ls-files` の**生の**結果に対して行う。tests/examples 等の
  // 除外を適用した後の件数と比べると、正当な除外で件数が減っただけでも threshold を割り
  // 誤検知する。
  const rawCounts: Record<Lang, number> = { rust: 0, ts: 0 }

  for (const { pathspec, lang, minFiles } of pathspecs) {
    const entries = gitLsFiles(repoRoot, pathspec)

    // 🔴 エントリ単位の真空防止（レビュー指摘 F-3）。lang 単位の合計チェック（下）だけでは、
    // 同じ lang の**他の**エントリの件数がしきい値を支えてしまい、この pathspec 自体が
    // `:(glob)` を忘れて 0 件しか返さなくても見逃す（実測: 既存 132 件 + 新規 0 件 = 132 ≥
    // 100 → 緑）。このエントリ単独で `minFiles` を満たすことを先に確認する。
    if (entries.length < minFiles) {
      throw new Error(
        `listMeasuredFiles: pathspec "${pathspec}"（${lang}）の列挙（除外適用前）が` +
          ` ${entries.length} 件しかありません（このエントリの真空防止しきい値 ${minFiles} 件未満）。` +
          'pathspec が ":(glob)" を欠いて "**" を正しく扱っていない可能性があります（設計 §4.1）。',
      )
    }

    rawCounts[lang] += entries.length
    for (const entry of entries) {
      if (lang === 'rust' && isExcludedRustPath(entry)) continue
      files.push({ path: entry, lang })
    }
  }

  for (const lang of Object.keys(MIN_FILES_PER_LANG) as Lang[]) {
    const min = MIN_FILES_PER_LANG[lang]
    if (rawCounts[lang] < min) {
      throw new Error(
        `listMeasuredFiles: ${lang} の列挙（除外適用前）が ${rawCounts[lang]} 件しかありません` +
          `（真空防止のしきい値 ${min} 件未満・全 pathspec 合計）。pathspec が ":(glob)" を欠いて ` +
          '"**" を正しく扱っていない可能性があります（設計 §4.1）。',
      )
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}
