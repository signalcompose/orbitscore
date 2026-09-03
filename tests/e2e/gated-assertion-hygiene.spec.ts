/**
 * gated E2E のアサーション衛生（2026-08-29）。
 *
 * 🔴 これも**知識を仕組みに変える**ためのテストである。
 *
 * CLAUDE.md は「`evaluate_orbitscore` の `ok` に assert しても何も証明しない」と繰り返し
 * 書いている（`ok` は「受理して書き込んだ」を返すだけで、**エンジン側のエラーは
 * `get_log` にしか出ない**）。それでも #528 で同じ罠を踏んだ。文章は読まれない時がある。
 *
 * ここでは gated spec 自身のソースを検査して、**弱いアサーションの型を機械的に**探す。
 * 完全ではないが、「書いた本人が気づかなかった」を CI が拾える位置に置く価値はある。
 */
import { describe, expect, it } from 'vitest'

import { readGatedSourceEntries } from './gated-sources'

// 🔴 走査先は `gated-sources.ts` が持つ（#668 §3.4・PR-E1）。ここで 1 ファイルを決め打ちすると、
// シナリオを別ファイルへ出した時に**検査が新ファイルを見ず、黙って弱くなる**。
const entries = readGatedSourceEntries()
const source = entries.map(({ source: text }) => text).join('\n')
const lines = entries.flatMap(({ file, source: text }) =>
  text.split('\n').map((line, i) => ({ file, line, n: i + 1 })),
)

/** ファイル名つき・行番号つきで、条件に合う行を集める。 */
const linesMatching = (predicate: (line: string) => boolean): string[] =>
  lines
    .filter(({ line }) => predicate(line))
    .map(({ file, line, n }) => `${file}:${n}: ${line.trim()}`)

describe('gated E2E assertion hygiene', () => {
  it('never asserts on a bare ERROR count equality', () => {
    // `get_log` は固定 500 行窓なので、ERROR 件数の**厳密等価**は窓の外へ流れた瞬間に
    // 嘘になる（#625）。`<=` / `toBeLessThanOrEqual` を使うこと。
    const offenders = linesMatching(
      (line) =>
        /errorsBefore|errorCount|countErrors/.test(line) &&
        /toBe\(|toEqual\(/.test(line) &&
        !/LessThanOrEqual|GreaterThan/.test(line),
    )
    expect(
      offenders,
      'ERROR counts come from a fixed 500-line window; compare with toBeLessThanOrEqual, ' +
        'not strict equality (see CLAUDE.md #625).',
    ).toEqual([])
  })

  it('does not use the engine log as the only oracle for audible behaviour', () => {
    // 音に出る機能は**キャプチャの数値**で判定する。ここでは「capture を使う spec に
    // rms/peak のアサーションが実在するか」だけを確かめる（個々のテストの強さは見ない）。
    const usesCapture = /captureInstrumentScenario|capture_wav|capturePath/.test(source)
    if (!usesCapture) return
    expect(
      /\brms\(|\bpeak\(|\.rms\b/.test(source),
      'This suite captures audio but never asserts on RMS or peak. ' +
        'A capture that nothing measures is not evidence (see CLAUDE.md「キャプチャ E2E」).',
    ).toBe(true)
  })

  it('keeps the stale-artifact guard wired to the real resolver', () => {
    // 🔴 このガードは 2026-08-29 に**パスを2回間違えている**。決め打ちに戻ったら赤にする。
    expect(
      /resolveDaemonBinaryPath\(\)/.test(source),
      'The stale-binary guard must ask resolveDaemonBinaryPath() which binary will actually ' +
        'be spawned. Hardcoding a path reintroduces the very failure the guard exists to stop.',
    ).toBe(true)
  })

  it('keeps the stale guard off cargo targets it can never rebuild', () => {
    // 🔴 #713: ガードが `rust/**/tests/*.rs` まで mtime 比較の対象にしていたため、
    // **解消不能な赤**になり実機 gated が全部落ちた。統合テストは別 cargo ターゲットで
    // daemon バイナリに入らないので、cargo は正しく何もビルドせず（`Finished in 0.21s`）、
    // バイナリの mtime は永久に更新されない。mtime は `git checkout` で動くので、
    // ブランチを行き来しただけで発火する。
    //
    // ⚠️ この検査は「除外していること」だけを見る。**`src/` の除外は別の話**で、
    // そちらを除外したらガードの目的自体が失われる（下の逆方向の検査）。
    expect(
      /entry\.name === 'tests' \|\| entry\.name === 'benches' \|\| entry\.name === 'examples'/.test(
        source,
      ),
      'The stale-binary guard must skip tests/benches/examples: they are separate cargo ' +
        'targets that never enter the daemon binary, so cargo will not rebuild for them and ' +
        'the guard can never be satisfied (#713).',
    ).toBe(true)
  })

  it('still lets the stale guard see the sources the daemon is built from', () => {
    // 逆方向: #713 の修正が行きすぎて `src` まで除外したら、ガードは**古いバイナリを
    // 見逃す**ようになる。それは CLAUDE.md「実機テストは最新ビルドで走る」に反する。
    expect(
      /entry\.name === 'src'/.test(source),
      'The stale-binary guard must NOT skip src/: excluding it would let a stale daemon ' +
        'binary pass, which is exactly what the guard exists to prevent.',
    ).toBe(false)
  })
})
