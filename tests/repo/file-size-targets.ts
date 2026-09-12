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
 */
export const MEASURED_PATHSPECS: ReadonlyArray<{ pathspec: string; lang: Lang }> = [
  { pathspec: ':(glob)rust/crates/**/*.rs', lang: 'rust' },
  { pathspec: ':(glob)packages/*/src/**/*.ts', lang: 'ts' },
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
  pathspecs: ReadonlyArray<{ pathspec: string; lang: Lang }> = MEASURED_PATHSPECS,
): MeasuredFile[] {
  const files: MeasuredFile[] = []
  // 真空防止（§4.1）は `git ls-files` の**生の**結果に対して行う。tests/examples 等の
  // 除外を適用した後の件数と比べると、正当な除外で件数が減っただけでも threshold を割り
  // 誤検知する。
  const rawCounts: Record<Lang, number> = { rust: 0, ts: 0 }

  for (const { pathspec, lang } of pathspecs) {
    const entries = gitLsFiles(repoRoot, pathspec)
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
          `（真空防止のしきい値 ${min} 件未満）。pathspec が ":(glob)" を欠いて ` +
          '"**" を正しく扱っていない可能性があります（設計 §4.1）。',
      )
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}
