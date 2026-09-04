/**
 * DSL 網羅率のラチェット（#650・2026-08-29）。
 *
 * 🔴 これは**知識を仕組みに変える**ためのテストである。
 *
 * CLAUDE.md には「DSL の機能を追加したら必ず E2E テストを追加する」と書いてあるが、
 * **それを強制するものが無かった**。実際に測ると、`seq` の 32 語のうち **19 語が実機で
 * 一度も評価されていなかった**（`mute` / `pan` / `octave` / `vel` / `root` / `loop` を含む）。
 *
 * 同じ日に `global.gain()` が instrument にまったく効いていないことが判明した。全層の
 * コードは正しく見え、変異検証 35 件もユニット 2149 件も捕まえず、**ユーザーと同じ動線で
 * 音を測った E2E だけ**が捕まえた。`gain` で起きたことは、未カバーの 19 語のどれでも起きうる。
 *
 * ## このテストの契約
 *
 * **未カバーの語が増えたら落ちる。減る分には落ちない**（ラチェット）。つまり:
 *
 * - 新しい DSL 語を足して E2E を書かなければ **red**
 * - 既存の未カバー語に E2E を書いたら、baseline から**消してよい**（消さなくても緑のまま）
 * - baseline に**存在しない語を足すことはできない** — 増やす方向の編集は red になる
 *
 * ## 検出方法の限界（正直に）
 *
 * gated spec の**ソース文字列**を走査するだけなので、「`.mute(` と書かれている」ことしか
 * 見ない。**その E2E が意味のある検証をしているかは見ない。** 音に出る語は
 * キャプチャの数値で判定すること（CLAUDE.md の「キャプチャ E2E」節）。
 * それでも「一度も書かれていない」を「書かれている」より下に置く価値はある。
 */

import { describe, expect, it } from 'vitest'

import {
  GLOBAL_DSL_METHODS,
  SEQUENCE_DSL_METHODS,
} from '../../packages/engine/src/signal-chain/runtime'
import { DSL_SYNTAX_SURFACE, type DslSyntaxId } from '../../packages/engine/src/parser/dsl-surface'
import { KEYWORDS } from '../../packages/engine/src/parser/tokenizer'

import { DSL_COVERAGE_LEDGER } from './dsl-coverage-ledger'
import { gatedItTitles, readGatedSources } from './gated-sources'

/**
 * 実機 gated spec が「その語を呼ぶ DSL を評価している」か。
 *
 * `.<name>(` の出現を見る。E2E は DSL をテンプレート文字列で書くので、この形で拾える。
 */
function methodsExercisedByGatedE2E(): ReadonlySet<string> {
  // 🔴 走査先は `gated-sources.ts` が持つ（#668 §3.4・PR-E1）。ここで 1 ファイルを決め打ちすると、
  // シナリオを別ファイルへ出した時に**カバー済みの語が未カバー扱いになって red** になる。
  const source = readGatedSources()
  const found = new Set<string>()
  for (const match of source.matchAll(/\.([a-zA-Z][a-zA-Z0-9]*)\s*\(/g)) {
    const name = match[1]
    if (name !== undefined) found.add(name)
  }
  return found
}

/**
 * 🔴 実機 E2E がまだ触っていない `seq` の語（2026-08-29 実測）。
 *
 * **この配列は減らす方向にしか編集してはいけない。** 語を E2E で押さえたら、ここから
 * 消す。新しい語をここへ足すのは、**DSL を足して E2E を書かなかった**ということなので、
 * レビューで止める。
 */
const SEQUENCE_UNCOVERED_BASELINE: readonly string[] = [
  'cell',
  'comp',
  'defaultGain',
  'defaultPan',
  'density',
  'hold',
  'loop',
  'midi',
  'mute',
  'pan',
  'quantize',
  'root',
  'unmute',
  'vel',
  'vl',
  'voicelead',
]

/**
 * 同上・`global` 側（2026-08-29 実測・`linkAudio` は #645 PR-D0 の gated E2E で除去・2026-09-04）。
 *
 * `compressor` / `limiter` / `normalizer` は **master チェーンの語**で、#649（フェーダーが
 * 支配すべきものより手前にある）と同じ領域にある。`audioDevice` はデバイス切替で、
 * 実機でしか意味を持たない。
 */
const GLOBAL_UNCOVERED_BASELINE: readonly string[] = [
  'audioDevice',
  'compressor',
  'limiter',
  'loop',
  'midiLatency',
  'normalizer',
  'quantize',
]

/**
 * 実機 E2E の台帳がまだ触っていない構文表面（2026-09-03 実測）。
 *
 * **この配列も減らす方向にしか編集してはいけない。** 構文を E2E で押さえ、台帳に
 * シナリオを登録したらここから消す。新しい構文 id をここへ足してはいけない。
 */
const SYNTAX_UNCOVERED_BASELINE: readonly DslSyntaxId[] = [
  'var-init-global',
  'var-init-seq',
  'import',
  'file-import',
  'transport-run',
  'transport-loop',
  'transport-mute',
  'beat-by',
  'play-nested',
  'event-modifier',
  'tie',
  'underscore-method',
  'chain-multiline',
]

/**
 * tokenizer の予約語が、どの構文表面として受理されるか。
 * `force` は RUN / LOOP / MUTE の `.force` 修飾なので transport 3 構文が受け持つ。
 */
const KEYWORD_SYNTAX_IDS: Readonly<Record<string, readonly DslSyntaxId[]>> = {
  var: ['var-init-global', 'var-init-seq'],
  init: ['var-init-global', 'var-init-seq'],
  by: ['beat-by'],
  GLOBAL: ['var-init-global'],
  force: ['transport-run', 'transport-loop', 'transport-mute'],
  RUN: ['transport-run'],
  LOOP: ['transport-loop'],
  MUTE: ['transport-mute'],
  import: ['import'],
}

/** 2026-09-03 現在、台帳に smoke 行は無い。増やさず、減らす方向だけを許す。 */
const SMOKE_OBSERVATION_BASELINE = 0

describe('DSL coverage of the real-device E2E suite', () => {
  const exercised = methodsExercisedByGatedE2E()

  const uncovered = (vocabulary: ReadonlySet<string>): string[] =>
    [...vocabulary].filter((name) => !exercised.has(name)).sort()

  it('A-1 does not leave a new sequence method untested on real hardware', () => {
    const now = uncovered(SEQUENCE_DSL_METHODS)
    const baseline = new Set(SEQUENCE_UNCOVERED_BASELINE)
    const regressions = now.filter((name) => !baseline.has(name))
    expect(
      regressions,
      'A sequence DSL method was added (or its E2E removed) without real-device coverage. ' +
        'Add a gated E2E that evaluates it — for anything audible, assert on the captured RMS, ' +
        'not on the `ok` of evaluate_orbitscore. See CLAUDE.md「DSL 機能を足したら E2E も足す」.',
    ).toEqual([])
  })

  it('A-1 does not leave a new global method untested on real hardware', () => {
    const now = uncovered(GLOBAL_DSL_METHODS)
    const baseline = new Set(GLOBAL_UNCOVERED_BASELINE)
    expect(now.filter((name) => !baseline.has(name))).toEqual([])
  })

  it('A-2 does not leave a new syntax surface untested on real hardware', () => {
    const covered = new Set(DSL_COVERAGE_LEDGER.map(({ surface }) => surface))
    const baseline = new Set<string>(SYNTAX_UNCOVERED_BASELINE)
    const regressions = DSL_SYNTAX_SURFACE.filter(
      (syntaxId) => !covered.has(syntaxId) && !baseline.has(syntaxId),
    )
    expect(
      regressions,
      'A parser syntax surface was added without a ledger entry for a gated E2E scenario. ' +
        'Add a real-device scenario and ledger entry; do not grow SYNTAX_UNCOVERED_BASELINE.',
    ).toEqual([])
  })

  it('A-3 keeps every tokenizer keyword represented by the syntax surface', () => {
    // 🔴 空集合に対しては何を照合しても通る。`KEYWORDS` の import が壊れたら
    // **この検査ごと真空で緑になる**ので、まず中身があることを確かめる。
    expect(KEYWORDS.size, 'KEYWORDS is empty — A-3 would pass vacuously').toBeGreaterThan(0)
    const syntaxIds = new Set<string>(DSL_SYNTAX_SURFACE)
    const unmappedKeywords = [...KEYWORDS].filter(
      (keyword) => KEYWORD_SYNTAX_IDS[keyword] === undefined,
    )
    const missingSyntaxIds = [...KEYWORDS].flatMap((keyword) =>
      (KEYWORD_SYNTAX_IDS[keyword] ?? []).filter((syntaxId) => !syntaxIds.has(syntaxId)),
    )
    expect(
      { unmappedKeywords, missingSyntaxIds },
      'A tokenizer keyword was added without mapping it to a canonical DSL syntax surface.',
    ).toEqual({ unmappedKeywords: [], missingSyntaxIds: [] })
  })

  it('A-4 keeps every coverage-ledger scenario anchored to a gated it title', () => {
    const titles = gatedItTitles()
    const missingScenarios = DSL_COVERAGE_LEDGER.filter(
      ({ scenario }) => !titles.some((title) => title.includes(scenario)),
    ).map(({ surface, scenario }) => ({ surface, scenario }))
    expect(
      missingScenarios,
      'A coverage-ledger scenario does not partially match any gated `it(` title.',
    ).toEqual([])
  })

  it('A-5 does not increase smoke-only observations', () => {
    const smokeCount = DSL_COVERAGE_LEDGER.filter(
      ({ observation }) => observation === 'smoke',
    ).length
    expect(
      smokeCount,
      'A smoke-only ledger entry was added. Use a semantic observation, or reduce the baseline; ' +
        'never increase it.',
    ).toBeLessThanOrEqual(SMOKE_OBSERVATION_BASELINE)
  })

  it('A-10 keeps the syntax and smoke baselines honest', () => {
    // 🔴 設計 §3.3 は A-10 の置き場を「両方」としているが、§20 は A-10 を PR-E5
    // （`reference-coverage.spec.ts` のみ）に割り当てている。**構文 / smoke の
    // baseline はその分割の隙間に落ちる**ので、ここで塞ぐ（Fable 監査 2026-09-04）。
    const ledgerSurfaces = new Set(DSL_COVERAGE_LEDGER.map(({ surface }) => surface))
    const staleSyntax = SYNTAX_UNCOVERED_BASELINE.filter((id) => ledgerSurfaces.has(id))
    expect(
      staleSyntax,
      'A syntax surface is in the ledger but still listed as uncovered. Remove it from ' +
        'SYNTAX_UNCOVERED_BASELINE — a stale entry lets the next addition slip through.',
    ).toEqual([])

    const smokeCount = DSL_COVERAGE_LEDGER.filter(
      ({ observation }) => observation === 'smoke',
    ).length
    expect(
      SMOKE_OBSERVATION_BASELINE,
      'SMOKE_OBSERVATION_BASELINE is above the actual smoke count. Lower it — a slack ' +
        'baseline silently permits new smoke-only entries.',
    ).toBeLessThanOrEqual(smokeCount === 0 ? 0 : smokeCount)
  })

  it('keeps the baseline honest — no entry that is already covered', () => {
    // baseline に残ったまま実は covered、という状態を許すと、次に誰かが同名の語を
    // 追加した時にラチェットがすり抜ける。covered になったら消す。
    const stale = SEQUENCE_UNCOVERED_BASELINE.filter((name) => exercised.has(name))
    expect(
      stale,
      'These are covered by the gated E2E now — remove them from SEQUENCE_UNCOVERED_BASELINE ' +
        'so the ratchet keeps its grip.',
    ).toEqual([])
  })

  it('keeps the global baseline honest — no entry that is already covered', () => {
    const stale = GLOBAL_UNCOVERED_BASELINE.filter((name) => exercised.has(name))
    expect(stale, 'Covered now — remove from GLOBAL_UNCOVERED_BASELINE.').toEqual([])
  })

  it('reports the current coverage so the number is visible in CI', () => {
    const total = SEQUENCE_DSL_METHODS.size
    const covered = total - uncovered(SEQUENCE_DSL_METHODS).length
    // 落とすためではなく、数字を見えるところに置くためのアサーション。
    expect(covered).toBeGreaterThanOrEqual(total - SEQUENCE_UNCOVERED_BASELINE.length)
  })
})
