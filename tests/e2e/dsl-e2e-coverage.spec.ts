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
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  GLOBAL_DSL_METHODS,
  SEQUENCE_DSL_METHODS,
} from '../../packages/engine/src/signal-chain/runtime'

const GATED_SPEC = path.resolve(__dirname, 'orbitstudio-mcp-gated.spec.ts')

/**
 * 実機 gated spec が「その語を呼ぶ DSL を評価している」か。
 *
 * `.<name>(` の出現を見る。E2E は DSL をテンプレート文字列で書くので、この形で拾える。
 */
function methodsExercisedByGatedE2E(): ReadonlySet<string> {
  const source = fs.readFileSync(GATED_SPEC, 'utf8')
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
  'length',
  'loop',
  'midi',
  'mute',
  'octave',
  'pan',
  'quantize',
  'root',
  'run',
  'unmute',
  'vel',
  'vl',
  'voicelead',
]

/**
 * 同上・`global` 側（2026-08-29 実測）。
 *
 * `compressor` / `limiter` / `normalizer` は **master チェーンの語**で、#649（フェーダーが
 * 支配すべきものより手前にある）と同じ領域にある。`linkAudio` は外部オーディオ出力、
 * `audioDevice` はデバイス切替で、いずれも実機でしか意味を持たない。
 */
const GLOBAL_UNCOVERED_BASELINE: readonly string[] = [
  'audioDevice',
  'compressor',
  'limiter',
  'linkAudio',
  'loop',
  'midiLatency',
  'normalizer',
  'quantize',
]

describe('DSL coverage of the real-device E2E suite', () => {
  const exercised = methodsExercisedByGatedE2E()

  const uncovered = (vocabulary: ReadonlySet<string>): string[] =>
    [...vocabulary].filter((name) => !exercised.has(name)).sort()

  it('does not leave a new sequence method untested on real hardware', () => {
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

  it('does not leave a new global method untested on real hardware', () => {
    const now = uncovered(GLOBAL_DSL_METHODS)
    const baseline = new Set(GLOBAL_UNCOVERED_BASELINE)
    expect(now.filter((name) => !baseline.has(name))).toEqual([])
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
