/**
 * gated E2E の実体を構成する全ファイル（#668 設計 §3.4・PR-E1）。
 *
 * 🔴 **なぜ 1 箇所に集めるか。** ラチェット（`dsl-e2e-coverage.spec.ts`）と衛生検査
 * （`gated-assertion-hygiene.spec.ts`）は gated spec の**ソースを読んで**判定する。
 * 両者がそれぞれ `orbitstudio-mcp-gated.spec.ts` を決め打ちしていたため、シナリオを
 * 別ファイルへ出した瞬間に
 *
 * - **(a)** カバー済みの語が未カバー扱いになってラチェットが red、
 * - **(b)** 衛生検査が新ファイルを見ず、**黙って弱くなる**
 *
 * が同時に起きる。(b) は red にならないぶん危険で、検査が効いていないことに
 * 気づけない（#668 設計 §11 F-9）。分割（PR-E2 以降）の**前に**この層を置く。
 *
 * 分割したら `GATED_SOURCE_GLOBS` に足すだけで両検査が追随する。
 */
import fs from 'node:fs'
import path from 'node:path'

const E2E_DIR = __dirname

/**
 * gated E2E のソースを構成するパターン。
 *
 * - `orbitstudio-mcp-gated.spec.ts` — vitest が発見する唯一の入口（起動を 1 回に保つ）
 * - `gated/` 配下 — シナリオ本体の置き場（PR-E2 以降。**`.spec.ts` にしない**ので
 *   vitest は発見せず、起動は 1 回のまま）
 */
const GATED_SOURCE_GLOBS: readonly {
  readonly dir: string
  readonly match: (name: string) => boolean
}[] = [
  { dir: E2E_DIR, match: (name) => name === 'orbitstudio-mcp-gated.spec.ts' },
  { dir: path.join(E2E_DIR, 'gated'), match: (name) => name.endsWith('.ts') },
]

/** ディレクトリ配下の `.ts` を再帰で集める。ディレクトリが無ければ空。 */
function collect(dir: string, match: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collect(full, match))
    else if (entry.isFile() && match(entry.name)) out.push(full)
  }
  return out
}

/**
 * gated E2E の実体を構成する全ファイル（絶対パス・安定した順序）。
 *
 * 🔴 **空にならないことを呼び出し側で確かめること。** 入口 spec の改名やディレクトリ移動で
 * 空になると、両検査が「何も見つからなかった」を「違反ゼロ」と読んで**全件 green のまま
 * 無意味になる**。`readGatedSources()` はその場合に throw する。
 */
export const GATED_SOURCE_FILES: readonly string[] = GATED_SOURCE_GLOBS.flatMap(({ dir, match }) =>
  collect(dir, match),
).sort()

/**
 * 全ソースを連結して返す（検査はどのファイルの何行目かを問わないので単純連結でよい）。
 *
 * ファイル境界には由来が分かるマーカーを挟む。衛生検査は行番号つきで違反を報告するため、
 * 連結後の行番号だけでは追えなくなるのを防ぐ。
 *
 * @throws ソースが 1 本も見つからない場合（検査が黙って無意味になるのを防ぐ）
 */
export function readGatedSources(): string {
  if (GATED_SOURCE_FILES.length === 0) {
    throw new Error(
      'gated E2E のソースが 1 本も見つからない。' +
        'ラチェットと衛生検査が黙って無意味になるので、GATED_SOURCE_GLOBS を確認すること。',
    )
  }
  return GATED_SOURCE_FILES.map(
    (file) => `// ===== ${path.relative(E2E_DIR, file)} =====\n${fs.readFileSync(file, 'utf8')}`,
  ).join('\n')
}

/** 各ソースを「相対パス + 中身」で返す。行番号つきで報告したい検査はこちらを使う。 */
export function readGatedSourceEntries(): readonly {
  readonly file: string
  readonly source: string
}[] {
  if (GATED_SOURCE_FILES.length === 0) {
    throw new Error(
      'gated E2E のソースが 1 本も見つからない。' +
        'ラチェットと衛生検査が黙って無意味になるので、GATED_SOURCE_GLOBS を確認すること。',
    )
  }
  return GATED_SOURCE_FILES.map((file) => ({
    file: path.relative(E2E_DIR, file),
    source: fs.readFileSync(file, 'utf8'),
  }))
}

/** gated E2E の `it(...)` の題名。 */
export function gatedItTitles(): readonly string[] {
  const titles: string[] = []
  for (const match of readGatedSources().matchAll(
    /\bit(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g,
  )) {
    titles.push(match[2])
  }
  return titles
}
