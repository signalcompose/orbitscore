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

/**
 * **式**をまたいで正規表現を照合し、一致した箇所を `file:line` で返す。
 *
 * 🔴 なぜ行単位ではだめか: この suite の `expect()` は matcher と引数が別の行に来ることが多い。
 * 行ごとに照合すると、同じ違反でも 1 行に収まったものだけを捕まえ、複数行に散らしたものを
 * 見逃す — 検査が「書き方」に依存してしまう。
 *
 * コメント行（`//` / JSDoc の `*`）は連結の前に落とす。アンチパターンを**説明した注釈**を
 * 検査自身が拾うと、正しく直したのに赤くなる（規律を説明できなくなる）。
 *
 * 連結は改行を空白に置き換えるだけなので、`\s*` を含む正規表現がそのまま跨いで一致する。
 * 行番号は連結後のオフセットから引き直す。
 */
const offendingLines = (pattern: RegExp): string[] => {
  const isComment = (line: string): boolean => {
    const trimmed = line.trim()
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
  }
  const found: string[] = []
  for (const { file, source: text } of entries) {
    // 連結後のオフセット → 元の行番号 を引けるよう、残した行の開始位置を控える。
    const kept: Array<{ n: number; line: string; at: number }> = []
    let joined = ''
    text.split('\n').forEach((line, i) => {
      if (isComment(line)) return
      kept.push({ n: i + 1, line, at: joined.length })
      joined += `${line}\n`
    })
    const scan = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    )
    for (let m = scan.exec(joined); m !== null; m = scan.exec(joined)) {
      const index = m.index
      // 一致開始位置を含む行（`at <= index` の最後の要素）。
      let hit = kept[0]
      for (const candidate of kept) {
        if (candidate.at > index) break
        hit = candidate
      }
      if (hit !== undefined) found.push(`${file}:${hit.n}: ${hit.line.trim()}`)
    }
  }
  return found
}

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

  it('never maps capture segments by subtracting wall time from final duration', () => {
    const offenders = linesMatching((line) => /durationSec\s*-\s*\(stopWall/.test(line))
    expect(
      offenders,
      'Capture segments must use the capture-file byte clock; final-duration wall-clock ' +
        'reverse mapping can silently point at the start of the file (#739).',
    ).toEqual([])
  })

  it('does not use the engine log as the only oracle for audible behaviour', () => {
    // 音に出る機能は**キャプチャの数値**で判定する。ここでは「capture を使う spec に
    // rms/peak のアサーションが実在するか」だけを確かめる（個々のテストの強さは見ない）。
    // 🔴 `runScore(..., { capture: true })` も capture 経路（#668 §17 F-1）。
    // これを入れ忘れると、新しいシナリオが**何も測らなくても検査が通る**。
    const usesCapture = /captureInstrumentScenario|capture_wav|capturePath|capture:\s*true/.test(
      source,
    )
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

  it('never claims a log-derived count increased by comparing to a baseline', () => {
    // 🔴 #761: `get_log` は固定 500 行窓。「baseline + N になった」という主張は、古い行が
    // 窓から流れ出るだけで崩れる（**偽赤**）。2026-09-05 に #618 E1-E6 が
    // `expected 6 to be greater than or equal to 7` で落ちたのがこれ。
    //
    // 上の 1 本目（bare ERROR count equality）は `GreaterThan` を含む行を**除外**するので
    // `toBeGreaterThanOrEqual(errorsBefore + 1)` を捕まえられない。ここがその補完になる。
    //
    // 🔴 変数名を `errorsBefore` 系に限定しない。`attachFailedBefore + 1` を取り逃がしたのが
    // まさにその穴だった（#760 の作業中に発見）。
    //
    // 正しい形は `newLogLines` / `newErrorLines` で「**どの行が**増えたか」を見ること。多重集合の
    // 差分は窓のずれに影響されず、「想定した 1 件以外は増えていない」という強い主張もできる。
    //
    // ⚠️ コメント行は除外する。**このアンチパターンを説明した注釈自身**を検査が拾ってしまい、
    // 「正しく直したのに赤くなる」＝ 規律を説明できなくなる（実際に本 PR で発火した）。
    // コメントアウトされたコードは実行されないので、除外して困ることもない。
    //
    // 🔴 **1 行ずつ照合してはいけない**（`/simplify` の altitude 指摘）。この suite の主流の
    // `expect()` は複数行に跨る:
    //
    //     expect(x, msg).toBeGreaterThanOrEqual(
    //       errorsBefore + 1,
    //     )
    //
    // matcher と引数が別の行に来るので、行単位の照合では**素通りする**。撤去した違反が
    // たまたま 1 行だっただけで、検査が目的より狭かった。コメント行を落としてから
    // **残りを連結して**照合し、一致位置から元の行番号へ引き直す。
    const offenders = offendingLines(
      /\.(toBe|toEqual|toBeGreaterThanOrEqual|toBeLessThanOrEqual)\(\s*\w*[Bb]efore\s*[+-]\s*\d/g,
    )
    expect(
      offenders,
      'Log counts come from a fixed 500-line window, so "baseline + N" claims break when old ' +
        'lines scroll out. Say WHICH lines appeared with newLogLines()/newErrorLines() (#761).',
    ).toEqual([])
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
