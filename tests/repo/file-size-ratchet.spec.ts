import fs from 'node:fs'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { countCodeLines } from './code-lines'
import { listMeasuredFiles } from './file-size-targets'

/**
 * ファイルサイズのラチェット（#888 子 0）。
 *
 * 🔴 これは #888 本文の裁定を**仕組みに変える**テストである（CLAUDE.md
 * 「規律を足す時は、同時にそれを守らせる仕組みを足すこと」）。裁定:
 *
 * - 閾値 = **コード行 500**（空行・コメント専用行・Rust のインライン
 *   `#[cfg(test)] mod` を数えない。数え方は `code-lines.ts` §3 を参照）
 * - baseline は既存3本（`worklog-size.spec.ts` / `dsl-e2e-coverage.spec.ts` /
 *   `planning-issue-state.spec.ts`）と同じ形の**ラチェット**: 現寸で登録し、
 *   **増やす編集は red・減らす編集は緑**
 *
 * ## このテストの契約
 *
 * baseline に載っているファイルは baseline の値を超えられず、載っていない
 * ファイルは 500 行を超えられない。**baseline の数字を増やして通すことは
 * できない**（このテストが直接は止めないが、後述のレビュー規則で止める）。
 *
 * - 新しいファイルを 500 行超まで太らせる、または既存ファイルが baseline
 *   値を超えて太る → **red**（分割する。baseline に足す/上げるのは禁止）
 * - baseline にあるファイルを分割して閾値以下に収めたら、そのエントリは
 *   **消してよい**（消さなくても緑のまま）
 * - baseline のエントリが古くなった（消えた・実際より緩い）ら **red**
 *   （honesty 検査。既存3本と同じ: `dsl-e2e-coverage` の "keeps the baseline
 *   honest"・`planning-issue-state` の "every baseline entry still exists"）
 *
 * ## レビューで見ること（仕組みでは止まらない部分）
 *
 * 🔴 **baseline の数字をソースと一緒に増やす編集**（ファイルを+10行太らせて
 * JSON も+10にする）は、既存3本と同様この仕組みでは止まらない。
 * `tests/repo/file-size-baseline.json` の diff に `+` が付いた行は「値が
 * 増えた」か「エントリが増えた」のどちらかしかないので、レビュアーは
 * baseline の diff を見るだけでよい（`BUNDLE_BRANCH_WORKFLOW.md` §5.1）。
 *
 * ## 対象範囲（意図的な除外）
 *
 * `tests/**` は測定対象に**含めない**（設計 §4.3）。含めると、実機 gated
 * spec に E2E を1本足しただけで red になり、CLAUDE.md「DSL を足したら
 * E2E も足す」と正面から衝突する。`tests/` 側の肥大は別の受け皿
 * （#668 PR-E1 の `gated-sources.ts` 分割）に任せる。
 */
const repoRoot = path.resolve(__dirname, '../..')
const BASELINE_PATH = path.join(__dirname, 'file-size-baseline.json')

interface Baseline {
  threshold: number
  files: Record<string, number>
}

function loadBaseline(): Baseline {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline
}

/** 対象ファイルごとの現在のコード行数。1ファイルでも throw したらそのまま失敗させる。 */
function measureAll(): Map<string, number> {
  const measured = new Map<string, number>()
  for (const file of listMeasuredFiles(repoRoot)) {
    const source = fs.readFileSync(path.join(repoRoot, file.path), 'utf8')
    let count
    try {
      count = countCodeLines(source, file.lang)
    } catch (e) {
      // 🔴 try/catch で握らない（§3.3）。ファイル名を付けて再送出するだけ。
      throw new Error(`${file.path}: ${(e as Error).message}`)
    }
    measured.set(file.path, count.code)
  }
  return measured
}

/**
 * (A) ラチェット判定（設計 §5.2 の (a)(b)(c)）。純関数へ切り出す（レビュー指摘 F-4）— 実データの
 * `it` から**引き続き呼ぶ**ことで配線を保つ（CLAUDE.md「純関数へ抽出しただけでは配線が
 * 無防備」の罠を避ける）。加えて合成 baseline/measured を食わせる `describe` が
 * この関数だけを直接検査し、健全な状態では一度も踏まれない分岐（超過ファイルが実在する
 * ケース）を確実に踏む。
 */
function findViolations(baseline: Baseline, measured: ReadonlyMap<string, number>): string[] {
  const violations: string[] = []
  for (const [filePath, code] of measured) {
    const allowed = baseline.files[filePath] ?? baseline.threshold
    if (code > allowed) {
      violations.push(`  ${filePath}: ${code} / allowed ${allowed}`)
    }
  }
  return violations
}

/**
 * (B) honesty 判定（設計 §5.2 の (d)(e)(f) + キー辞書順・レビュー指摘 F-6）。
 * F-4 と同じ理由で純関数へ切り出す。
 */
function findHonestyProblems(baseline: Baseline, measured: ReadonlyMap<string, number>): string[] {
  const measuredPaths = new Set(measured.keys())
  const problems: string[] = []

  if (baseline.threshold !== 500) {
    problems.push(`threshold は 500 で固定です（#888 裁定1）。現在の値: ${baseline.threshold}`)
  }

  const keys = Object.keys(baseline.files)
  const sortedKeys = [...keys].sort()
  const firstOutOfOrder = keys.findIndex((key, i) => key !== sortedKeys[i])
  if (firstOutOfOrder !== -1) {
    problems.push(
      `baseline.files のキーが辞書順ではありません（"${keys[firstOutOfOrder]}" の位置に ` +
        `"${sortedKeys[firstOutOfOrder]}" が来るべきです）。diff を1ファイル1行にするため、` +
        'キーは repo root からの相対パスの辞書順で並べてください（設計 §5.1）。',
    )
  }

  for (const [filePath, baselineValue] of Object.entries(baseline.files)) {
    if (!measuredPaths.has(filePath)) {
      problems.push(
        `${filePath}: baseline にありますが、測定対象に存在しません` +
          '（消えた・改名した・測定対象外のパスに移った）。このエントリを消してください。',
      )
      continue
    }

    const actual = measured.get(filePath) as number

    if (baselineValue <= baseline.threshold) {
      problems.push(
        `${filePath}: baseline 値 ${baselineValue} が閾値 ${baseline.threshold} 以下です。` +
          'この行は意味を持たないので消してください。',
      )
      continue
    }

    if (baselineValue > actual) {
      problems.push(
        `${filePath}: baseline 値 ${baselineValue} が実際のコード行数 ${actual} より` +
          ` 大きいです（減ったのに baseline が古いまま）。次の値に下げてください:\n` +
          `    "${filePath}": ${actual},`,
      )
    }
  }

  return problems
}

describe('file size ratchet (#888 child 0)', () => {
  // 2 つの `it` は同じ入力（同じ git 状態のファイル群）を別の角度から検査するだけで、
  // どちらも副作用を持たない読み取りなので測定を共有してよい。`beforeAll` に置くのは
  // (a) 227 ファイルの走査を 2 回やらないため、(b) `measureAll()` が throw したとき
  // （閉じていない文字列を持つファイルがある等）collection ではなく **suite の失敗**として
  // ファイル名付きで出るため。同じ PR の `file-size-targets.spec.ts` も測定を共有している。
  //
  // 🔴 正確には vitest 3.2.6 の `beforeAll` が throw すると、その suite の `it` は
  // **skipped** になり **suite が fail** する（`@vitest/runner` の `markTasksAsSkipped` →
  // rethrow → `failTask`）。red・exit 1 は変わらないが「テストが失敗した」表示にはならない
  // ので、原因を追う時は suite のエラーを読むこと（2026-09-12 の設計監査 M-6）。
  let baseline: Baseline
  let measured: Map<string, number>
  beforeAll(() => {
    baseline = loadBaseline()
    measured = measureAll()
  })

  it('does not let a file grow past the threshold or past its baseline (ratchet)', () => {
    const violations = findViolations(baseline, measured)

    expect(
      violations,
      'ファイルが閾値、または baseline に登録された自分の値を超えました:\n' +
        violations.join('\n') +
        '\n\n分割してください。baseline に足す・値を上げる編集は禁止です（子0の裁定）。',
    ).toEqual([])
  })

  it('keeps the baseline honest (every entry is real, current, and above the threshold)', () => {
    const problems = findHonestyProblems(baseline, measured)

    expect(problems, 'baseline が現状と食い違っています:\n' + problems.join('\n')).toEqual([])
  })
})

/**
 * `findViolations` / `findHonestyProblems` の合成データ検査（レビュー指摘 F-4）。
 *
 * 実データに対する上の2つの `it` は、baseline の定義上「baseline == 現在値」が健全な
 * 状態なので、`code > allowed`（成長した）や `baselineValue <= threshold`（無意味な行）
 * のような分岐を**一度も踏まない**。実測: `baselineValue <= baseline.threshold` の
 * 判定を丸ごと削っても実データの2 `it` は緑のままだった。合成 baseline/measured を
 * 直接渡すことで、設計 §5.2 の (a)〜(g) を全件踏む。
 */
describe('findViolations / findHonestyProblems (synthetic — exercises branches real data never hits)', () => {
  const THRESHOLD = 500

  it('(a) baseline に無いファイルが閾値超なら violation', () => {
    const baseline: Baseline = { threshold: THRESHOLD, files: {} }
    const measured = new Map([['a.ts', 501]])
    expect(findViolations(baseline, measured)).toEqual(['  a.ts: 501 / allowed 500'])
  })

  it('(b) baseline にあるファイルが baseline 値を超えたら violation', () => {
    const baseline: Baseline = { threshold: THRESHOLD, files: { 'a.ts': 600 } }
    const measured = new Map([['a.ts', 601]])
    expect(findViolations(baseline, measured)).toEqual(['  a.ts: 601 / allowed 600'])
  })

  it('(c) baseline 値以下（または閾値以下）なら violation 無し', () => {
    const baseline: Baseline = { threshold: THRESHOLD, files: { 'a.ts': 600 } }
    const measured = new Map([
      ['a.ts', 600],
      ['b.ts', 500],
    ])
    expect(findViolations(baseline, measured)).toEqual([])
  })

  it('(d) baseline のファイルが measured に無ければ honesty problem', () => {
    const baseline: Baseline = { threshold: THRESHOLD, files: { 'gone.ts': 600 } }
    const measured = new Map<string, number>()
    const problems = findHonestyProblems(baseline, measured)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/gone\.ts: baseline にありますが、測定対象に存在しません/)
  })

  it('(e) baseline 値 > 実際の値なら honesty problem（メッセージに正しい値が入る）', () => {
    const baseline: Baseline = { threshold: THRESHOLD, files: { 'a.ts': 600 } }
    const measured = new Map([['a.ts', 550]])
    const problems = findHonestyProblems(baseline, measured)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('baseline 値 600 が実際のコード行数 550 より')
    expect(problems[0]).toContain('"a.ts": 550,')
  })

  it('(f) baseline 値 ≤ threshold なら honesty problem', () => {
    const baseline: Baseline = { threshold: THRESHOLD, files: { 'a.ts': 500 } }
    const measured = new Map([['a.ts', 500]])
    const problems = findHonestyProblems(baseline, measured)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/a\.ts: baseline 値 500 が閾値 500 以下です/)
  })

  it('(f) threshold !== 500 なら honesty problem', () => {
    const baseline: Baseline = { threshold: 600, files: {} }
    const problems = findHonestyProblems(baseline, new Map())
    expect(problems).toEqual(['threshold は 500 で固定です（#888 裁定1）。現在の値: 600'])
  })

  it('キーが辞書順でなければ honesty problem（レビュー指摘 F-6）', () => {
    const baseline: Baseline = {
      threshold: THRESHOLD,
      files: { 'z.ts': 600, 'a.ts': 600 }, // JSON.parse はキー出現順を保つので、この順に食い違う
    }
    const measured = new Map([
      ['z.ts', 600],
      ['a.ts', 600],
    ])
    const problems = findHonestyProblems(baseline, measured)
    expect(problems.some((p) => p.includes('辞書順ではありません'))).toBe(true)
  })

  it('キーが辞書順なら、それを理由にした honesty problem は出ない', () => {
    const baseline: Baseline = {
      threshold: THRESHOLD,
      files: { 'a.ts': 600, 'z.ts': 600 },
    }
    const measured = new Map([
      ['a.ts', 600],
      ['z.ts', 600],
    ])
    const problems = findHonestyProblems(baseline, measured)
    expect(problems.some((p) => p.includes('辞書順ではありません'))).toBe(false)
  })
})
