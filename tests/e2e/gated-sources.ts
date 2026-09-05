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
 * - `helpers/` 配下 — **`.spec.ts` 以外の全ファイル**（capture 区間写像だけでなく
 *   `run-score.ts` / `mcp-client.ts` / `engine-log.ts` / `gated-session.ts` /
 *   `rack-child-pid.ts` … gated E2E が実際に使う実装のすべて）を衛生検査へ含める。
 *   狭めているのではなく、意図して広い — helper を1本足したのに衛生検査だけ黙って
 *   対象外になる事故を防ぐため、既定を「除外リストでなく `.spec.ts` だけを除く」にしている。
 *   `.spec.ts` を除くのは、旧写像との等価性を示すテストが旧式（reverse-map 等）を
 *   意図的に引用するため。この広さゆえに、将来ここへ足す helper 名が DSL 語と衝突すると
 *   `dsl-e2e-coverage.spec.ts` の A-1 ラチェットを黙って無効化しうる点に注意する。
 */
const GATED_SOURCE_GLOBS: readonly {
  readonly dir: string
  readonly match: (name: string) => boolean
}[] = [
  { dir: E2E_DIR, match: (name) => name === 'orbitstudio-mcp-gated.spec.ts' },
  { dir: path.join(E2E_DIR, 'gated'), match: (name) => name.endsWith('.ts') },
  {
    dir: path.join(E2E_DIR, 'helpers'),
    match: (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
  },
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
  return readGatedSourceEntries()
    .map(({ file, source }) => `// ===== ${file} =====\n${source}`)
    .join('\n')
}

/**
 * 読み込み結果のメモ化。
 *
 * 🔴 **同じ 220KB のソースを 1 テストファイルの中で 3 回読んでいた**（実測 2026-09-04）。
 * `gatedItTitles()` は内部で全ソースを読み直すので、呼ぶたびに再読み込み + 4500 行に対する
 * `matchAll` の再実行が起きる。`gated-assertion-hygiene.spec.ts` は既にモジュール先頭で
 * 1 回だけ読んで保持しており、そちらが正しい形だった。
 *
 * ⚠️ **前提**: `GATED_SOURCE_FILES` は実行中に変わらない（モジュール読み込み時に確定する）。
 * キャッシュはプロセス内なので、ファイルを足して**別プロセスで**回す分には効かない。
 */
let cachedEntries: readonly { readonly file: string; readonly source: string }[] | undefined

/** 各ソースを「相対パス + 中身」で返す。行番号つきで報告したい検査はこちらを使う。 */
export function readGatedSourceEntries(): readonly {
  readonly file: string
  readonly source: string
}[] {
  if (cachedEntries !== undefined) return cachedEntries
  if (GATED_SOURCE_FILES.length === 0) {
    throw new Error(
      'gated E2E のソースが 1 本も見つからない。' +
        'ラチェットと衛生検査が黙って無意味になるので、GATED_SOURCE_GLOBS を確認すること。',
    )
  }
  cachedEntries = GATED_SOURCE_FILES.map((file) => ({
    file: path.relative(E2E_DIR, file),
    source: fs.readFileSync(file, 'utf8'),
  }))
  return cachedEntries
}

/**
 * gated E2E の `it(...)` の題名。
 *
 * 🔴 **カリー化された呼び出しに対応すること。** この suite は
 * `it.skipIf(!appAvailable)('title', ...)` の形で書かれており（`orbitstudio-mcp-gated.spec.ts:627`
 * ほか 20 箇所）、題名は**2 つ目の呼び出しの第 1 引数**にある。
 * `it(` の直後に文字列が来る前提の正規表現では **1 件も拾えない**。
 *
 * 実害（2026-09-03 実測）: 拾えないと #668-A の検査 A-4（台帳のシナリオが実在するか）が
 * **空振りで緑になり、正当な台帳エントリを足した瞬間に誤って red になる**。
 *
 * @throws 題名が 1 件も見つからない場合（照合が黙って無意味になるのを防ぐ）
 */
export function gatedItTitles(): readonly string[] {
  const titles: string[] = []
  // `it` / `it.only` / `it.skip` の直呼びと、`it.skipIf(<cond>)(` のカリー形の両方を拾う。
  for (const match of readGatedSources().matchAll(
    /\bit(?:\.\w+)?(?:\([^)]*\))?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g,
  )) {
    titles.push(match[2])
  }
  if (titles.length === 0) {
    throw new Error(
      'gated E2E の it( 題名が 1 件も見つからない。' +
        '照合（#668-A の A-4）が黙って無意味になるので、呼び出しの書き方を確認すること。',
    )
  }
  return titles
}
