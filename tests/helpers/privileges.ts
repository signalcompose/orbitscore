import type { TestContext } from 'vitest'

/**
 * root は DAC を迂回して `chmod 0o000` のファイルを読めてしまうため、「読めないファイル」を
 * 前提にしたテストは root では**成立しない**（#684・設計 668 §13）。CI（GitHub Actions）は
 * 非 root なので、root で skip しても検出力は落ちない。
 *
 * `it.skipIf` ではなく `context.skip(条件, 理由)` にしているのは、skip の**理由が
 * レポーターに出る**ようにするため（#684 の受け入れ基準）。
 *
 * 🔴 呼び出し箇所は `tests/repo/privileges-skip-ratchet.spec.ts` がラチェットしている。
 * root で未検証のテストが黙って増えないように。
 */
const RUNNING_AS_ROOT: boolean = process.getuid?.() === 0
const SKIP_AS_ROOT_REASON = 'root bypasses DAC: chmod 0o000 stays readable (#684)'

export function skipWhenDacIsBypassed(context: Pick<TestContext, 'skip'>): void {
  context.skip(RUNNING_AS_ROOT, SKIP_AS_ROOT_REASON)
}
